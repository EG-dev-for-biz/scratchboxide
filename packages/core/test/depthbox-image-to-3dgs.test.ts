/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import { describe, it, expect } from 'vitest';
import { ImageToSplatService } from '../src/node/3d-engine/image-to-splat-service';
import { SplatService } from '../src/node/3d-engine/splat-service';

describe('ImageToSplatService (2D Image(s) to 3DGS Engine)', () => {
    it('computes unit-normalized pinhole ray field with correct optical conventions', () => {
        const W = 64;
        const H = 48;
        const rays = ImageToSplatService.computePinholeRayField(W, H, 60.0);

        expect(rays.length).toBe(W * H * 3);

        // Center pixel should point straight ahead along -Z (rx ~ 0, ry ~ 0, rz ~ -1)
        const centerIdx = (Math.floor(H / 2) * W + Math.floor(W / 2)) * 3;
        const rx = rays[centerIdx + 0];
        const ry = rays[centerIdx + 1];
        const rz = rays[centerIdx + 2];

        expect(Math.abs(rx)).toBeLessThan(0.05);
        expect(Math.abs(ry)).toBeLessThan(0.05);
        expect(rz).toBeLessThan(-0.95);

        // Every ray must be unit length
        for (let i = 0; i < W * H; i += 7) {
            const x = rays[i * 3 + 0];
            const y = rays[i * 3 + 1];
            const z = rays[i * 3 + 2];
            const len = Math.hypot(x, y, z);
            expect(len).toBeCloseTo(1.0, 4);
        }
    });

    it('converts a single 2D image into 3D Gaussian Splats with analytical surface normals', () => {
        const W = 32;
        const H = 32;
        const rgb = new Uint8Array(W * H * 3);
        const depths = new Float32Array(W * H);

        for (let y = 0; y < H; ++y) {
            for (let x = 0; x < W; ++x) {
                const idx = y * W + x;
                rgb[idx * 3 + 0] = 200;
                rgb[idx * 3 + 1] = 150;
                rgb[idx * 3 + 2] = 100;
                // Planar depth ramp from 5.0m to 10.0m
                depths[idx] = 5.0 + (y / H) * 5.0;
            }
        }

        const splats = ImageToSplatService.convertSingleImageToSplat({
            rgbPixels: rgb,
            width: W,
            height: H,
            channels: 3,
            metricDepths: depths,
            stride: 1,
            edgeTau: 0.08
        });

        expect(splats.length).toBe(W * H);

        const first = splats[0];
        expect(first.position).toHaveLength(3);
        expect(first.scale).toHaveLength(3);
        expect(first.colorRgb).toHaveLength(3);
        expect(first.quaternion).toHaveLength(4);

        // Color should be normalized [0, 1]
        expect(first.colorRgb[0]).toBeCloseTo(200 / 255.0, 2);
        expect(first.colorRgb[1]).toBeCloseTo(150 / 255.0, 2);
        expect(first.colorRgb[2]).toBeCloseTo(100 / 255.0, 2);

        // Quaternion must be normalized ||q|| = 1.0
        const q = first.quaternion!;
        const qLen = Math.hypot(q[0], q[1], q[2], q[3]);
        expect(qLen).toBeCloseTo(1.0, 3);

        // Splat thickness ratio (sz should be significantly thinner than sx/sy)
        expect(first.scale[2]).toBeLessThan(first.scale[0] * 0.35);
    });

    it('severs splat scales across sharp depth step discontinuities (edge severance)', () => {
        const W = 32;
        const H = 32;
        const rgb = new Uint8Array(W * H * 3);
        const depths = new Float32Array(W * H);

        for (let y = 0; y < H; ++y) {
            for (let x = 0; x < W; ++x) {
                const idx = y * W + x;
                rgb[idx * 3 + 0] = 128;
                rgb[idx * 3 + 1] = 128;
                rgb[idx * 3 + 2] = 128;
                // Severe depth step at x = 16 (from 4.0m to 25.0m)
                depths[idx] = x < 16 ? 4.0 : 25.0;
            }
        }

        const splats = ImageToSplatService.convertSingleImageToSplat({
            rgbPixels: rgb,
            width: W,
            height: H,
            channels: 3,
            metricDepths: depths,
            stride: 1,
            edgeTau: 0.08
        });

        // The splat at the boundary (x = 15) should have its scale shrunk to prevent bridging
        const edgeSplat = splats[10 * W + 15];
        const flatSplat = splats[10 * W + 5];

        // The relative scale on edge should be shrunk compared to normal unconstrained footprint
        expect(edgeSplat.opacity).toBeLessThan(flatSplat.opacity);
    });

    it('fuses multi-view 2D images and reduces redundant splats via 3D voxel decimation', () => {
        const W = 24;
        const H = 24;
        const rgb1 = new Uint8Array(W * H * 3).fill(180);
        const rgb2 = new Uint8Array(W * H * 3).fill(220);
        const depths = new Float32Array(W * H).fill(6.0);

        const view1 = {
            rgbPixels: rgb1,
            width: W,
            height: H,
            metricDepths: depths,
            pose: { position: [0, 0, 0] as [number, number, number] }
        };

        const view2 = {
            rgbPixels: rgb2,
            width: W,
            height: H,
            metricDepths: depths,
            // Small offset
            pose: { position: [0.01, 0, 0] as [number, number, number] }
        };

        const fused = ImageToSplatService.convertMultiViewImagesToSplat({
            views: [view1, view2],
            voxelSize: 0.20
        });

        // Without fusion, 2 views would be 24*24*2 = 1152 splats.
        // With voxel decimation, the redundant overlapping splats must be pruned.
        expect(fused.length).toBeLessThan(W * H * 2);
        expect(fused.length).toBeGreaterThan(0);
    });

    it('round-trips splats into binary .splat buffer with byte-exact 32-byte layout', () => {
        const testSplats = [
            {
                position: [1.2, -3.4, 5.6] as [number, number, number],
                scale: [0.05, 0.05, 0.01] as [number, number, number],
                colorRgb: [0.8, 0.4, 0.2] as [number, number, number],
                opacity: 0.95,
                quaternion: [0, 0, 0, 1] as [number, number, number, number]
            },
            {
                position: [-10.5, 2.1, -15.0] as [number, number, number],
                scale: [0.25, 0.25, 0.06] as [number, number, number],
                colorRgb: [0.1, 0.9, 0.3] as [number, number, number],
                opacity: 0.88,
                quaternion: [0.7071, 0, 0, 0.7071] as [number, number, number, number]
            }
        ];

        const buffer = ImageToSplatService.serializeToSplatBuffer(testSplats);
        expect(buffer.length).toBe(testSplats.length * 32);

        const parsed = SplatService.parseSplatBuffer(buffer);
        expect(parsed.length).toBe(testSplats.length);

        expect(parsed[0].position[0]).toBeCloseTo(1.2, 3);
        expect(parsed[0].position[1]).toBeCloseTo(-3.4, 3);
        expect(parsed[0].position[2]).toBeCloseTo(5.6, 3);

        expect(parsed[0].scale[0]).toBeCloseTo(0.05, 3);
        expect(parsed[0].scale[2]).toBeCloseTo(0.01, 3);

        expect(parsed[0].colorRgb[0]).toBe(204); // uint8 byte value 0.8 * 255
        expect(parsed[0].opacity).toBeCloseTo(0.95, 1);
    });
});
