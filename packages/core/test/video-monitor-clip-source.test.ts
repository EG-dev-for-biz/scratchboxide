/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The program monitor read a video clip's media only from `sourcePath`, so the "VFX Matchmove & Neural Video NLE" demo,
 * whose clips carry their media in `url`, showed a drawn gradient instead of its three videos (2026-11-02 tour).
 */

import { describe, expect, it } from 'vitest';
import { clipVideoSource } from '../src/browser/generative-canvas/primitives/video/VideoPreviewMonitor';
import { PRELOADED_SHOWCASE_DEMOS } from '../src/browser/generative-canvas/demos/preloadedDemos';
import type { TimelineElement, VideoTimelineData } from '../src/browser/generative-canvas/services/video/videoTypes';

const clip = (over: Partial<TimelineElement>): TimelineElement => ({ id: 'c', name: 'c', type: 'video', startTime: 0, duration: 1, trimStart: 0, trimEnd: 1, ...over });

describe('a video clip\'s media in the program monitor', () => {
    it('is found for every video clip of the VFX NLE demo', () => {
        const demo = PRELOADED_SHOWCASE_DEMOS.find(d => d.id === 'demo-vfx-timeline');
        const data = demo!.artifact.data as VideoTimelineData;
        const sources = data.tracks.flatMap(t => t.elements).filter(e => e.type === 'video').map(e => clipVideoSource(e, data));
        expect(sources).toEqual([
            '/videos/google_tiles_textured_blockout_camera.mp4',
            '/videos/google_tiles_omni_restyled.mp4',
            '/videos/google_tiles_textured_vs_omni_comparison.mp4'
        ]);
    });

    it('comes from the clip\'s url, its media-pool asset, a project path or a plate\'s source video, in that order', () => {
        const data = { mediaAssets: [{ id: 'm1', name: 'pool.mp4', type: 'video' as const, url: '/videos/pool.mp4' }] };
        expect(clipVideoSource(clip({ url: '/videos/own.mp4', mediaId: 'm1', sourcePath: 'videos/p.mp4' }), data)).toBe('/videos/own.mp4');
        expect(clipVideoSource(clip({ mediaId: 'm1', sourcePath: 'videos/p.mp4' }), data)).toBe('/videos/pool.mp4');
        expect(clipVideoSource(clip({ sourcePath: 'videos/plaza_hotel_blockout_camera.mp4' }), data)).toBe('videos/plaza_hotel_blockout_camera.mp4');
        expect(clipVideoSource(clip({ isVfxPlate: true, vfxPlate: { sourceVideoUri: 'videos/plate.mp4' } }), data)).toBe('videos/plate.mp4');
        expect(clipVideoSource(clip({ mediaId: 'gone' }), data)).toBeUndefined();
    });
});
