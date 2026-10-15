/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * vfx_composite_timeline and vfx_composite_patch report a render that FFmpeg did not make (FFmpeg missing, or it
 * exited non-zero) as failed with FFmpeg's error, never "Successfully rendered" a file that does not exist. The patch
 * tool fails when it cannot measure the background plate's length instead of assuming 10 s.
 */

import { describe, it, expect, afterAll, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { HeadlessVideoCompositorService } from '../src/node/video/HeadlessVideoCompositorService';
import { HeadlessVideoEditorService } from '../src/node/video/HeadlessVideoEditorService';
import { createDefaultToolRegistry } from '../src/node/gemini/tool-registry';

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sbx-composite-fail-'));
afterAll(() => fs.rmSync(DIR, { recursive: true, force: true }));
afterEach(() => vi.restoreAllMocks());

const timeline = (clip: string) => ({
    title: 'cut', fps: 24, duration: 3, currentTime: 0, zoom: 50, aspectRatio: '16:9', mediaAssets: [],
    tracks: [{ id: 't1', name: 'V1', type: 'video', visible: true, locked: false, muted: false,
        elements: [{ id: 'el_1', name: 'clip', type: 'video', startTime: 0, duration: 3, trimStart: 0, trimEnd: 3, url: clip }] }]
});

const patchArgs = (outputPath: string, extra: Record<string, unknown> = {}) => ({
    backgroundVideo: path.join(DIR, 'missing_plate.mp4'),
    patchMedia: path.join(DIR, 'missing_patch.mp4'),
    outputPath,
    bbox: { x: 10, y: 20, width: 200, height: 100 },
    ...extra
});

describe('the compositor tools fail when FFmpeg does not render', () => {
    it('vfx_composite_timeline: a render FFmpeg could not make (missing FFmpeg or a missing clip) is failed, with no file (the review\'s probe)', async () => {
        // Real run: on a machine without ffmpeg the spawn fails; with ffmpeg it exits non-zero on the missing clip.
        const outputPath = path.join(DIR, 'composite_out.mp4');
        const res = await createDefaultToolRegistry().dispatch('vfx_composite_timeline', { outputPath, timeline: timeline(path.join(DIR, 'missing_clip.mp4')) }, {} as any);
        expect(res.exec.status).toBe('failed');
        expect(res.exec.summaryResult).not.toMatch(/Successfully/);
        expect(res.exec.summaryResult).toMatch(/FFmpeg/);
        expect((res.resultPayload as any).success).toBe(false);
        expect(fs.existsSync(outputPath)).toBe(false);
    });

    it('vfx_composite_timeline: a non-zero FFmpeg exit is reported with its error', async () => {
        vi.spyOn(HeadlessVideoCompositorService.prototype, 'execute').mockResolvedValue({
            success: false, outputPath: '/x/out.mp4', error: 'FFmpeg process exited with code 1: Invalid filtergraph'
        } as any);
        const res = await createDefaultToolRegistry().dispatch('vfx_composite_timeline', { outputPath: path.join(DIR, 'exit1.mp4'), timeline: timeline('/x/clip.mp4') }, {} as any);
        expect(res.exec.status).toBe('failed');
        expect(res.exec.summaryResult).toContain('exited with code 1: Invalid filtergraph');
    });

    it('vfx_composite_timeline: a render FFmpeg did make is reported as rendered', async () => {
        const outputPath = path.join(DIR, 'ok.mp4');
        vi.spyOn(HeadlessVideoCompositorService.prototype, 'execute').mockResolvedValue({ success: true, outputPath, outputSizeBytes: 1234, durationSec: 3 } as any);
        const res = await createDefaultToolRegistry().dispatch('vfx_composite_timeline', { outputPath, timeline: timeline('/x/clip.mp4') }, {} as any);
        expect(res.exec.status).toBe('completed');
        expect(res.exec.summaryResult).toContain(`Rendered timeline composite to ${outputPath}`);
    });

    it('vfx_composite_patch: a render FFmpeg could not make is failed, with no file (the review\'s probe)', async () => {
        const outputPath = path.join(DIR, 'patch_out.mp4');
        const res = await createDefaultToolRegistry().dispatch('vfx_composite_patch', patchArgs(outputPath, { duration: 4 }), {} as any);
        expect(res.exec.status).toBe('failed');
        expect(res.exec.summaryResult).not.toMatch(/Successfully/);
        expect(res.exec.summaryResult).toMatch(/FFmpeg/);
        expect(fs.existsSync(outputPath)).toBe(false);
    });

    it('vfx_composite_patch: a background plate whose length cannot be measured fails the call instead of becoming 10 s', async () => {
        const execute = vi.spyOn(HeadlessVideoCompositorService.prototype, 'execute');
        vi.spyOn(HeadlessVideoEditorService.prototype, 'probeMedia').mockRejectedValueOnce(new Error('spawn ffprobe ENOENT'));
        const res = await createDefaultToolRegistry().dispatch('vfx_composite_patch', patchArgs(path.join(DIR, 'p1.mp4')), {} as any);
        expect(res.exec.status).toBe('failed');
        expect(res.exec.summaryResult).toContain('spawn ffprobe ENOENT');

        vi.spyOn(HeadlessVideoEditorService.prototype, 'probeMedia').mockResolvedValueOnce({ durationSec: 0, width: 1920, height: 1080 } as any);
        const res2 = await createDefaultToolRegistry().dispatch('vfx_composite_patch', patchArgs(path.join(DIR, 'p2.mp4')), {} as any);
        expect(res2.exec.status).toBe('failed');
        expect(res2.exec.summaryResult).toMatch(/length/);
        expect(execute).not.toHaveBeenCalled();
    });

    it('vfx_composite_patch: the measured plate length is used and a made render is reported as composited', async () => {
        const outputPath = path.join(DIR, 'patched.mp4');
        vi.spyOn(HeadlessVideoEditorService.prototype, 'probeMedia').mockResolvedValue({ durationSec: 7.5, width: 1920, height: 1080 } as any);
        const execute = vi.spyOn(HeadlessVideoCompositorService.prototype, 'execute').mockResolvedValue({ success: true, outputPath, outputSizeBytes: 99, durationSec: 7.5 } as any);
        const res = await createDefaultToolRegistry().dispatch('vfx_composite_patch', patchArgs(outputPath), {} as any);
        expect(res.exec.status).toBe('completed');
        expect(res.exec.summaryResult).toContain(`Composited the generative patch into ${outputPath}`);
        expect((execute.mock.calls[0][0] as any).timeline.duration).toBe(7.5);
    });
});
