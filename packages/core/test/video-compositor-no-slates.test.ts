/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The headless compositor renders media files, never a stand-in for them. A clip on a visible picture track with no
 * media file, or whose media is a blob: or data: URL (those exist only in the browser), is refused with
 * MissingInputError naming the clip; so is a generative patch without a patch file. The old compositor rendered each
 * of these as a full-frame slate in the clip's UI colour (a grey box for a patch), counted it towards the composite's
 * length and reported the render as made.
 */

import { describe, it, expect } from 'vitest';
import { HeadlessVideoCompositorService, measureCompositeDuration } from '../src/node/video/HeadlessVideoCompositorService';
import { MissingInputError } from '../src/common/errors/pipeline-errors';
import { createDefaultToolRegistry } from '../src/node/gemini/tool-registry';
import type { VideoTimelineData } from '../src/browser/generative-canvas/services/video/videoTypes';

function timeline(elements: any[], extra: Partial<VideoTimelineData> = {}): VideoTimelineData {
    return {
        title: 'slates', fps: 24, currentTime: 0, zoom: 40, aspectRatio: '16:9', mediaAssets: [],
        tracks: [{ id: 'v1', name: 'V1', type: 'video', visible: true, elements }],
        ...extra
    } as unknown as VideoTimelineData;
}

const el = (id: string, extra: Record<string, unknown> = {}) =>
    ({ id, name: `${id} clip`, type: 'video', startTime: 0, duration: 3, trimStart: 0, trimEnd: 3, ...extra });

describe('the headless compositor refuses clips it has no media for, instead of rendering colour slates', () => {
    const service = new HeadlessVideoCompositorService();

    it('refuses a blob: clip and a text element, naming the clip, and counts neither towards the length (the review probe)', async () => {
        const tl = timeline([
            el('plate', { url: 'blob:http://localhost/abc', color: 'emerald' }),
            el('title', { type: 'text', textContent: 'Hello', color: 'purple', startTime: 3 })
        ]);
        expect(() => measureCompositeDuration(tl)).toThrow(MissingInputError);
        expect(() => service.buildFilterGraph(tl)).toThrow(MissingInputError);
        expect(() => service.buildFilterGraph(tl)).toThrow(/clip "plate clip" \(plate\).*blob:/);
        await expect(service.execute({ timeline: tl, outputPath: '/tmp/never.mp4', dryRun: true })).rejects.toBeInstanceOf(MissingInputError);
    });

    it('refuses a text element, a data: URL and a clip with no media at all, each by name', () => {
        expect(() => service.buildFilterGraph(timeline([el('words', { type: 'text', textContent: 'Hi' })], { duration: 3 })))
            .toThrow(/clip "words clip" \(words\).*text element/);
        expect(() => service.buildFilterGraph(timeline([el('inline', { url: 'data:video/mp4;base64,AAAA' })], { duration: 3 })))
            .toThrow(/clip "inline clip" \(inline\).*data:/);
        expect(() => service.buildFilterGraph(timeline([el('bare', { color: 'amber' })], { duration: 3 })))
            .toThrow(/clip "bare clip" \(bare\).*no media file/);
    });

    it('refuses a generative patch with no patch file, or one that only exists in the browser', () => {
        const patch = (patchUrl?: string) => timeline([el('shot', {
            url: '/plates/shot.mp4',
            generativePatch: { enabled: true, targetBox: { x: 10, y: 10, width: 64, height: 32 }, ...(patchUrl ? { patchUrl } : {}) }
        })], { duration: 3 });
        expect(() => service.buildFilterGraph(patch())).toThrow(/generative patch of clip "shot clip" \(shot\)/);
        expect(() => service.buildFilterGraph(patch('blob:http://localhost/patch'))).toThrow(MissingInputError);
        const ok = service.buildFilterGraph(patch('/plates/patch.mp4'));
        expect(ok.inputs.map(i => i.path)).toEqual(['color=c=black:s=1920x1080:r=24:d=3', '/plates/shot.mp4', '/plates/patch.mp4']);
    });

    it('renders clips whose media is a file or a customInputs path, with no input but the black base canvas generated', () => {
        const tl = timeline([el('a', { url: '/plates/a.mp4', color: 'blue' }), el('b', { color: 'amber', startTime: 3 })]);
        const { inputs, durationSec } = service.buildFilterGraph(tl, { width: 320, height: 180 }, { b: '/plates/b.mp4' });
        expect(durationSec).toBe(6);
        expect(inputs.filter(i => i.isVirtual).map(i => i.path)).toEqual(['color=c=black:s=320x180:r=24:d=6']);
        expect(inputs.map(i => i.path)).toEqual(['color=c=black:s=320x180:r=24:d=6', '/plates/a.mp4', '/plates/b.mp4']);
        // A hidden track is not rendered, so its clips need no media.
        const hidden = timeline([el('a', { url: '/plates/a.mp4' })], { duration: 3 });
        hidden.tracks.push({ id: 'v2', name: 'V2', type: 'overlay', visible: false, elements: [el('ghost', { type: 'text' })] } as any);
        expect(() => service.buildFilterGraph(hidden)).not.toThrow();
    });

    it('vfx_composite_timeline fails naming the clip instead of reporting a rendered composite', async () => {
        const res = await createDefaultToolRegistry().dispatch('vfx_composite_timeline', {
            outputPath: '/tmp/never_rendered.mp4',
            dryRun: true,
            timeline: timeline([el('plate', { color: 'emerald' })], { duration: 3 })
        }, {} as any);
        expect(res.exec.status).toBe('failed');
        expect(res.exec.summaryResult).toMatch(/clip "plate clip" \(plate\)/);
        expect(res.exec.summaryResult).not.toMatch(/Rendered|Planned/);
    });
});
