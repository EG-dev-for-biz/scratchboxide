/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { describe, it, expect } from 'vitest';
import { DepthBoxInferenceService } from '../src/node/3d-engine/depthbox-inference-service';

describe('DepthBoxInferenceService', () => {
    it('initializes with default and custom configurations', () => {
        const service = new DepthBoxInferenceService({
            fovDegrees: 70.0,
            minDepth: 0.5,
            maxDepth: 100.0
        });
        expect(service).toBeDefined();
    });

    it('computes unit-normalized pinhole ray field correctly', () => {
        const service = new DepthBoxInferenceService({ fovDegrees: 60.0 });
        const width = 100;
        const height = 100;

        const rayMap = service.computePinholeRayField(width, height);
        expect(rayMap.length).toBe(width * height * 3);

        // Center ray should point straight forward along +Z (rx ~ 0, ry ~ 0, rz ~ 1)
        const cx = 50;
        const cy = 50;
        const cIdx = (cy * width + cx) * 3;
        expect(rayMap[cIdx]).toBeCloseTo(0.0, 1);
        expect(rayMap[cIdx + 1]).toBeCloseTo(0.0, 1);
        expect(rayMap[cIdx + 2]).toBeGreaterThan(0.9);

        // Every sampled ray must have Euclidean norm == 1.0
        for (let y = 0; y < height; y += 10) {
            for (let x = 0; x < width; x += 10) {
                const idx = (y * width + x) * 3;
                const rx = rayMap[idx];
                const ry = rayMap[idx + 1];
                const rz = rayMap[idx + 2];
                const len = Math.sqrt(rx * rx + ry * ry + rz * rz);
                expect(len).toBeCloseTo(1.0, 4);
            }
        }
    });

    it('unprojects points accurately using P = d * r formula', () => {
        const service = new DepthBoxInferenceService();
        const width = 10;
        const height = 10;

        const depths = new Float32Array(width * height);
        depths.fill(12.5); // Constant 12.5m depth

        const rays = new Float32Array(width * height * 3);
        for (let i = 0; i < width * height; ++i) {
            rays[3 * i] = 0.0;
            rays[3 * i + 1] = 0.0;
            rays[3 * i + 2] = 1.0; // Point along +Z
        }

        const points = service.unprojectToPoints(depths, rays, width, height);
        expect(points.length).toBe(100);

        for (const pt of points) {
            expect(pt.x).toBeCloseTo(0.0, 5);
            expect(pt.y).toBeCloseTo(0.0, 5);
            expect(pt.z).toBeCloseTo(12.5, 5);
            expect(pt.depth).toBe(12.5);
        }
    });

    it('supports stride downsampling for large point clouds', () => {
        const service = new DepthBoxInferenceService();
        const width = 20;
        const height = 20;

        const depths = new Float32Array(width * height).fill(5.0);
        const rays = service.computePinholeRayField(width, height);

        const fullPoints = service.unprojectToPoints(depths, rays, width, height, undefined, 1);
        const downsampled = service.unprojectToPoints(depths, rays, width, height, undefined, 2);

        expect(fullPoints.length).toBe(400);
        expect(downsampled.length).toBe(100);
    });

    it('predicts depth-ray fields and synthesizes consistent 3D point cloud', async () => {
        const service = new DepthBoxInferenceService({ minDepth: 0.2, maxDepth: 100.0 });
        const width = 32;
        const height = 32;

        // RGBA test buffer
        const image = new Uint8Array(width * height * 4);
        for (let i = 0; i < image.length; i += 4) {
            image[i] = 200;     // R
            image[i + 1] = 150; // G
            image[i + 2] = 100; // B
            image[i + 3] = 255; // A
        }

        const result = await service.predictDepthAndRays(image, width, height, { stride: 2 });

        expect(result.width).toBe(width);
        expect(result.height).toBe(height);
        expect(result.metricDepths.length).toBe(width * height);
        expect(result.rayMap.length).toBe(width * height * 3);
        expect(result.pointCloud.length).toBe(16 * 16);

        expect(result.minDepth).toBeGreaterThanOrEqual(0.2);
        expect(result.maxDepth).toBeLessThanOrEqual(100.0);
        expect(result.averageDepth).toBeGreaterThan(0.0);

        // Verify colors are retained on points
        const firstPt = result.pointCloud[0];
        expect(firstPt.color).toEqual([200, 150, 100, 255]);
    });
});
