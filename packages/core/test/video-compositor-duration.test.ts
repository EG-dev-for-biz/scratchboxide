/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The headless compositor's length is the timeline's own duration or, when the timeline states none, the end of its
 * last clip that renders. A timeline with neither is refused with MissingInputError; no length (the old 10 s) is
 * assumed. When ffmpeg is installed, a real render is probed to confirm the output runs exactly the measured length.
 */

import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs-extra';
import * as os from 'os';
import * as path from 'path';
import { HeadlessVideoCompositorService, measureCompositeDuration } from '../src/node/video/HeadlessVideoCompositorService';
import { MissingInputError } from '../src/common/errors/pipeline-errors';
import type { VideoTimelineData, TimelineTrack } from '../src/browser/generative-canvas/services/video/videoTypes';
import { HOW_TO, findBinary, requireBinary, withReason } from './helpers/requirements';

const ffmpeg = requireBinary('ffmpeg', HOW_TO.ffmpeg);
const ffprobe = requireBinary('ffprobe', HOW_TO.ffmpeg);

function clip(id: string, startTime: number, duration: number, extra: Record<string, unknown> = {}) {
    return { id, name: id, type: 'video', startTime, duration, trimStart: 0, trimEnd: duration, color: 'blue', ...extra };
}

function timeline(duration: number | undefined, tracks: Array<Partial<TimelineTrack> & { elements: any[] }>): VideoTimelineData {
    return {
        title: 'duration test',
        fps: 24,
        duration,
        currentTime: 0,
        zoom: 40,
        aspectRatio: '16:9',
        mediaAssets: [],
        tracks: tracks.map((t, i) => ({ id: `t${i}`, name: `t${i}`, type: 'video', visible: true, ...t }))
    } as unknown as VideoTimelineData;
}

describe('HeadlessVideoCompositorService measures the composite length', () => {
    const service = new HeadlessVideoCompositorService();

    it('uses the duration the timeline states', () => {
        const tl = timeline(4, [{ elements: [clip('a', 0, 9)] }]);
        expect(measureCompositeDuration(tl)).toBe(4);
        const { inputs, durationSec } = service.buildFilterGraph(tl, { width: 320, height: 180 });
        expect(durationSec).toBe(4);
        expect(inputs[0].path).toBe('color=c=black:s=320x180:r=24:d=4');
    });

    it('measures a timeline with no duration (0 or missing) from the end of its last rendered clip, never 10 s', () => {
        for (const stated of [0, undefined, Number.NaN, -3]) {
            const tl = timeline(stated, [
                { elements: [clip('bg', 0, 2.5), clip('late', 3, 1.25)] },
                { type: 'overlay', elements: [clip('title', 0.5, 2)] }
            ]);
            expect(measureCompositeDuration(tl), String(stated)).toBe(4.25);
            const { inputs, durationSec } = service.buildFilterGraph(tl, { width: 320, height: 180 });
            expect(durationSec).toBe(4.25);
            expect(inputs[0].path).toBe('color=c=black:s=320x180:r=24:d=4.25');
        }
    });

    it('counts only clips that render: a hidden video track and a muted audio track do not lengthen the composite', () => {
        const tl = timeline(0, [
            { elements: [clip('bg', 0, 2)] },
            { visible: false, elements: [clip('hidden', 0, 30)] },
            { type: 'audio', muted: true, elements: [{ id: 'music', name: 'music', type: 'audio', startTime: 0, duration: 60, url: '/m.wav' }] },
            { type: 'audio', elements: [{ id: 'vo', name: 'vo', type: 'audio', startTime: 1, duration: 2, url: '/vo.wav' }] }
        ]);
        expect(measureCompositeDuration(tl)).toBe(3);
    });

    it('refuses a timeline with no duration and no clip to measure, before building any graph or running ffmpeg', async () => {
        const empty = timeline(0, [{ elements: [] }, { visible: false, elements: [clip('hidden', 0, 5)] }]);
        expect(() => measureCompositeDuration(empty)).toThrow(MissingInputError);
        expect(() => service.buildFilterGraph(empty)).toThrow(/video composite needs timeline\.duration/);
        expect(() => service.buildFFmpegArgs({ timeline: empty, outputPath: '/tmp/never.mp4' })).toThrow(MissingInputError);
        await expect(service.execute({ timeline: empty, outputPath: '/tmp/never.mp4', dryRun: true })).rejects.toBeInstanceOf(MissingInputError);
        const noLengths = timeline(undefined, [{ elements: [clip('a', 0, 0), { id: 'b', name: 'b', type: 'video', startTime: 1 }] }]);
        expect(() => measureCompositeDuration(noLengths)).toThrow(MissingInputError);
    });

    it('passes the measured length to ffmpeg (-t) and reports it', async () => {
        const tl = timeline(0, [{ elements: [clip('bg', 0.5, 1.5)] }]);
        const { args } = service.buildFFmpegArgs({ timeline: tl, outputPath: '/tmp/out.mp4', resolution: { width: 320, height: 180 } });
        expect(args[args.indexOf('-t') + 1]).toBe('2');
        const planned = await service.execute({ timeline: tl, outputPath: '/tmp/out.mp4', resolution: { width: 320, height: 180 }, dryRun: true });
        expect(planned.durationSec).toBe(2);
        expect(planned.ffmpegCommand).toContain('-t 2');
    });

    it.skipIf(!ffmpeg.ok || !ffprobe.ok)(withReason('renders a timeline with no stated duration at its measured length', ffmpeg.ok ? ffprobe : ffmpeg), async () => {
        const work = fs.mkdtempSync(path.join(os.tmpdir(), 'sbx-composite-duration-'));
        try {
            const outputPath = path.join(work, 'measured.mp4');
            const tl = timeline(0, [{ elements: [clip('bg', 0, 1), clip('next', 1, 0.5, { color: 'amber' })] }]);
            const result = await service.execute({ timeline: tl, outputPath, resolution: { width: 160, height: 90 }, preset: 'ultrafast' });
            expect(result.error).toBeUndefined();
            expect(result.success).toBe(true);
            expect(result.durationSec).toBe(1.5);
            const probed = Number(execFileSync(findBinary('ffprobe')!, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', outputPath]).toString().trim());
            expect(probed).toBeGreaterThan(1.4);
            expect(probed).toBeLessThan(1.6);
        } finally {
            await fs.remove(work);
        }
    }, 60_000);
});
