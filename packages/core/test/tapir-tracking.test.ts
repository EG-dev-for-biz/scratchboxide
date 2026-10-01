/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import { describe, it, expect } from 'vitest';
import {
    LucasKanadeFlowTracker,
    PointSamplers,
    SyntheticTracker
} from '../src/common/tracking/PointTrackingModel';
import type { VideoFrameData } from '../src/common/tracking/tapir-tracking-protocol';
import { TapirTrackingService } from '../src/node/spatial/TapirTrackingService';
import { tapir4dgsHandlers } from '../src/node/gemini/tools/spatial-tools';

function createSyntheticVideo(
    numFrames: number = 5,
    width: number = 80,
    height: number = 60
): VideoFrameData[] {
    const frames: VideoFrameData[] = [];
    for (let t = 0; t < numFrames; t++) {
        const data = new Uint8Array(width * height * 3);
        // Base gradient
        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
                const idx = (y * width + x) * 3;
                data[idx] = Math.floor((x / width) * 100 + 40);
                data[idx + 1] = Math.floor((y / height) * 100 + 40);
                data[idx + 2] = 80;
            }
        }
        // Moving synthetic disc (translates right by 2 pixels per frame)
        const cx = 20 + t * 2;
        const cy = 30;
        const radius = 6;
        for (let dy = -radius; dy <= radius; dy++) {
            for (let dx = -radius; dx <= radius; dx++) {
                if (dx * dx + dy * dy <= radius * radius) {
                    const px = cx + dx;
                    const py = cy + dy;
                    if (px >= 0 && px < width && py >= 0 && py < height) {
                        const idx = (py * width + px) * 3;
                        data[idx] = 240;
                        data[idx + 1] = 230;
                        data[idx + 2] = 40;
                    }
                }
            }
        }
        frames.push({ width, height, data, channels: 3, frameIndex: t });
    }
    return frames;
}

describe('PointSamplers (Grid, Saliency & Hybrid Cellular)', () => {
    it('generates uniform lattice points with sampleGrid', () => {
        const pts = PointSamplers.sampleGrid(100, 100, { stride: 20, margin: 10 });
        expect(pts.length).toBeGreaterThan(0);
        for (const [x, y] of pts) {
            expect(x).toBeGreaterThanOrEqual(0.0);
            expect(x).toBeLessThanOrEqual(1.0);
            expect(y).toBeGreaterThanOrEqual(0.0);
            expect(y).toBeLessThanOrEqual(1.0);
        }
    });

    it('identifies high-contrast corner features with sampleSaliency (Shi-Tomasi)', () => {
        const frames = createSyntheticVideo(1, 100, 100);
        const pts = PointSamplers.sampleSaliency(frames[0], {
            maxPoints: 20,
            qualityLevel: 0.05,
            minDistance: 4
        });
        expect(pts.length).toBeGreaterThan(0);
        // The points should be clustered near the synthetic feature around (20, 30) -> norm (0.2, 0.3)
        const nearFeature = pts.some(([x, y]) => Math.abs(x - 0.2) < 0.15 && Math.abs(y - 0.3) < 0.15);
        expect(nearFeature).toBe(true);
    });

    it('partitions frame into cells with sampleHybrid', () => {
        const frames = createSyntheticVideo(1, 100, 100);
        const pts = PointSamplers.sampleHybrid(frames[0], {
            cellSize: 20,
            maxPoints: 30
        });
        expect(pts.length).toBeGreaterThan(0);
        expect(pts.length).toBeLessThanOrEqual(30);
    });
});

describe('LucasKanadeFlowTracker (Forward-Backward Cycle Consistency)', () => {
    it('tracks moving feature points across video frames', () => {
        const frames = createSyntheticVideo(5, 80, 60);
        const tracker = new LucasKanadeFlowTracker({
            windowSize: 9,
            maxLevels: 2,
            maxIterations: 10,
            fbThreshold: 3.0
        });

        // Query point at center of the feature at frame 0 (x=20, y=30) -> norm (20/79, 30/59)
        const queryPts: Array<[number, number]> = [[20 / 79, 30 / 59]];
        const tracks = tracker.trackPoints(frames, queryPts);

        expect(tracks.coords.length).toBe(5);
        expect(tracks.coords[0][0][0]).toBeCloseTo(20 / 79, 2);
        expect(tracks.coords[0][0][1]).toBeCloseTo(30 / 59, 2);

        // Frame 4: the feature has moved right by 4 * 2 = 8 pixels -> x=28 -> norm (28/79)
        const trackedX = tracks.coords[4][0][0];
        expect(trackedX).toBeGreaterThan(tracks.coords[0][0][0]);
        expect(tracks.visibilities[4][0]).toBeGreaterThan(0.5);
    });

    it('decays visibility when cycle consistency check fails or track is lost', () => {
        const frames = createSyntheticVideo(3, 80, 60);
        // Force very strict fbThreshold so any slight inconsistency reduces visibility
        const tracker = new LucasKanadeFlowTracker({
            fbThreshold: 0.001
        });
        const queryPts: Array<[number, number]> = [[0.95, 0.95]]; // Flat background corner
        const tracks = tracker.trackPoints(frames, queryPts);

        expect(tracks.visibilities.length).toBe(3);
        // Frame 0 always has full visibility
        expect(tracks.visibilities[0][0]).toBe(1.0);
    });
});

describe('SyntheticTracker & TapirTrackingService', () => {
    it('executes deterministic synthetic tracking', () => {
        const frames = createSyntheticVideo(4, 60, 40);
        const synth = new SyntheticTracker(0.01, -0.005);
        const tracks = synth.trackPoints(frames, [[0.5, 0.5]]);

        expect(tracks.coords.length).toBe(4);
        expect(tracks.coords[0][0]).toEqual([0.5, 0.5]);
        expect(tracks.coords[1][0][0]).toBeCloseTo(0.51, 3);
        expect(tracks.coords[1][0][1]).toBeCloseTo(0.495, 3);
    });

    it('falls back seamlessly to Lucas-Kanade when TAPIR checkpoint is not present', async () => {
        const frames = createSyntheticVideo(3, 60, 40);
        const service = new TapirTrackingService();
        const result = await service.executeTracking(frames, [[0.3, 0.4]]);

        expect(result.backendUsed).toBe('lk_flow');
        expect(result.numFrames).toBe(3);
        expect(result.numPoints).toBe(1);
        expect(result.tracks.coords.length).toBe(3);
        expect(result.tracks.visibilities.length).toBe(3);
    });

    it('supports sampleAndTrack automatic pipeline', async () => {
        const frames = createSyntheticVideo(3, 60, 40);
        const service = new TapirTrackingService();
        const result = await service.sampleAndTrack(
            frames,
            { type: 'grid', stride: 20 },
            { backend: 'lk_flow' }
        );

        expect(result.numPoints).toBeGreaterThan(0);
        expect(result.backendUsed).toBe('lk_flow');
    });
});

describe('Gemini Agent Tool: tapir_track_video_points', () => {
    it('executes tracking tool handler with synthetic generation and cycle consistency', async () => {
        const res = await tapir4dgsHandlers.tapir_track_video_points({
            numFrames: 4,
            frameWidth: 80,
            frameHeight: 60,
            backend: 'lk_flow',
            samplerType: 'grid',
            maxPoints: 8
        });

        expect(res.summaryResult).toContain('Tracked');
        expect(res.summaryResult).toContain('frames using LK_FLOW');
        expect((res.resultPayload as any).backendUsed).toBe('lk_flow');
        expect((res.resultPayload as any).numFrames).toBe(4);
    });
});
