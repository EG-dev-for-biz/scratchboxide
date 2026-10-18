/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import { describe, it, expect, vi } from 'vitest';
import {
    VisualFeatureMatcherService,
    type DepthBuffer3D
} from '../src/node/spatial/VisualFeatureMatcherService';

describe('VisualFeatureMatcherService', () => {
    // Generate a synthetic image with distinct corner features
    function createSyntheticFeatureImage(width: number, height: number): Uint8Array {
        const img = new Uint8Array(width * height);
        // Dark background
        img.fill(20);

        // Draw bright geometric rectangles/corners
        const rects = [
            { x: 30, y: 30, w: 25, h: 25 },
            { x: 90, y: 40, w: 30, h: 20 },
            { x: 50, y: 100, w: 40, h: 35 },
            { x: 120, y: 110, w: 25, h: 25 }
        ];

        let val = 120;
        for (const r of rects) {
            val += 30;
            for (let y = r.y; y < r.y + r.h; y++) {
                for (let x = r.x; x < r.x + r.w; x++) {
                    if (y >= 0 && y < height && x >= 0 && x < width) {
                        img[y * width + x] = Math.min(255, val + (x - r.x) * 2 + (y - r.y) * 3);
                    }
                }
            }
        }

        return img;
    }

    it('extracts salient 2D Harris keypoints and 128-D descriptors', () => {
        const width = 180;
        const height = 180;
        const img = createSyntheticFeatureImage(width, height);

        const keypoints = VisualFeatureMatcherService.extractKeypoints(img, width, height, {
            maxKeypoints: 50,
            qualityThreshold: 0.05
        });

        expect(keypoints.length).toBeGreaterThan(8);
        expect(keypoints[0].descriptor.length).toBe(128);

        // Check L2 normalization of descriptor
        let sumSq = 0;
        for (let i = 0; i < 128; i++) {
            sumSq += keypoints[0].descriptor[i] * keypoints[0].descriptor[i];
        }
        expect(Math.sqrt(sumSq)).toBeCloseTo(1.0, 1);
    });

    it('matches corresponding keypoints between two images under translation', () => {
        const width = 200;
        const height = 200;
        const img1 = createSyntheticFeatureImage(width, height);

        // Extract keypoints from original
        const k1 = VisualFeatureMatcherService.extractKeypoints(img1, width, height, {
            maxKeypoints: 60,
            qualityThreshold: 0.05
        });

        // Match against itself
        const selfMatches = VisualFeatureMatcherService.matchKeypoints(k1, k1, {
            loweRatio: 0.85,
            crossCheck: false
        });

        expect(selfMatches.length).toBeGreaterThan(0);
        for (const m of selfMatches) {
            expect(m.distance).toBeLessThan(1e-4);
            expect(m.confidence).toBeGreaterThan(0.99);
        }
    });

    it('lifts 2D matches to metric 3D world coordinates using a depth buffer', () => {
        const width = 640;
        const height = 480;
        const depthMap = new Float32Array(width * height);
        depthMap.fill(50.0); // 50 meters depth everywhere

        const depthBuffer: DepthBuffer3D = {
            width,
            height,
            depthMap,
            // Camera at world origin looking down +Z
            cameraMatrixWorld: [
                [1, 0, 0, 100],  // world X offset +100
                [0, 1, 0, 200],  // world Y offset +200
                [0, 0, 1, 300],  // world Z offset +300
                [0, 0, 0, 1]
            ],
            intrinsics: {
                fx: 500,
                fy: 500,
                cx: 320,
                cy: 240,
                width,
                height
            }
        };

        const matches = [
            {
                index1: 0,
                index2: 0,
                point1: [320, 240] as [number, number],
                point2: [320, 240] as [number, number], // optical center
                distance: 0.05,
                confidence: 0.95
            },
            {
                index1: 1,
                index2: 1,
                point1: [420, 240] as [number, number],
                point2: [420, 240] as [number, number], // +100px X offset
                distance: 0.08,
                confidence: 0.92
            }
        ];

        const matches3D = VisualFeatureMatcherService.lift2DMatchesTo3D(matches, depthBuffer);

        expect(matches3D.length).toBe(2);

        // Center ray: x_cam = 0, y_cam = 0, z_cam = 50
        // In world: [100 + 0, 200 + 0, 300 + 50] = [100, 200, 350]
        expect(matches3D[0].point3D[0]).toBeCloseTo(100, 1);
        expect(matches3D[0].point3D[1]).toBeCloseTo(200, 1);
        expect(matches3D[0].point3D[2]).toBeCloseTo(350, 1);
        expect(matches3D[0].depthMeters).toBe(50.0);

        // Offset ray: u = 420 (delta = +100px)
        // x_cam = (100 / 500) * 50 = 10m
        // In world: [100 + 10, 200, 350] = [110, 200, 350]
        expect(matches3D[1].point3D[0]).toBeCloseTo(110, 1);
    });

    it('cross-checked matching compares each descriptor pair once and matches the two-pass result', () => {
        let seed = 3;
        const rnd = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32);
        const desc = () => { const d = new Float32Array(128); let n = 0; for (let k = 0; k < 128; k++) { d[k] = rnd(); n += d[k] * d[k]; } n = Math.sqrt(n); for (let k = 0; k < 128; k++) d[k] /= n; return d; };
        const kp = (d: Float32Array, i: number) => ({ x: i, y: i * 2, response: 1, scale: 1, angleRad: 0, descriptor: d });
        const k1 = Array.from({ length: 300 }, (_, i) => kp(desc(), i));
        // k2: noisy copies of the first 200 plus 150 unrelated descriptors
        const k2 = [...k1.slice(0, 200).map((k, i) => { const d = Float32Array.from(k.descriptor, v => v + (rnd() - 0.5) * 0.02); return kp(d, i + 1000); }), ...Array.from({ length: 150 }, (_, i) => kp(desc(), i + 5000))];
        // The two-pass reference (forward, then a fresh reverse pass), as matching was computed before.
        const dist = (a: Float32Array, b: Float32Array) => { let s2 = 0; for (let k = 0; k < a.length; k++) { const d = a[k] - b[k]; s2 += d * d; } return Math.sqrt(s2); };
        const nearest = (q: Float32Array, set: typeof k1) => { let b = Infinity, s2 = Infinity, bi = -1; set.forEach((k, j) => { const d = dist(q, k.descriptor); if (d < b) { s2 = b; b = d; bi = j; } else if (d < s2) s2 = d; }); return { b, s2, bi }; };
        const expected: Array<[number, number]> = [];
        k1.forEach((k, i) => {
            const f = nearest(k.descriptor, k2);
            if (!(f.bi >= 0 && f.b / (f.s2 + 1e-7) <= 0.75 && f.b <= 0.65)) return;
            const r = nearest(k2[f.bi].descriptor, k1);
            if (r.bi >= 0 && r.b / (r.s2 + 1e-7) <= 0.75 && r.bi === i) expected.push([i, f.bi]);
        });
        const spy = vi.spyOn(VisualFeatureMatcherService as any, 'euclideanDistance');
        const matches = VisualFeatureMatcherService.matchKeypoints(k1, k2, { crossCheck: true });
        const calls = spy.mock.calls.length;
        spy.mockRestore();
        expect(calls).toBe(k1.length * k2.length);
        expect(matches.length).toBe(expected.length);
        expect(expected.length).toBeGreaterThan(150);
        expect(matches.map(m => [m.index1, m.index2])).toEqual(expected);
    });
});
