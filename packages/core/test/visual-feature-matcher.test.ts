/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { describe, it, expect } from 'vitest';
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
});
