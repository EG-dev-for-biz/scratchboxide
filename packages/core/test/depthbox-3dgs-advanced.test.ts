/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import { describe, it, expect } from 'vitest';
import { SplatService, SplatPoint } from '../src/node/3d-engine/splat-service';

describe('DepthBox 3DGS Advanced: Multi-View Fusion, Voxel Decimation & Densification', () => {
    it('decimates overlapping Gaussian splats into an optimal spatial voxel lattice', () => {
        // Create 4 overlapping splats in the same voxel (voxelSize = 0.1)
        const splats: SplatPoint[] = [
            {
                position: [1.01, 2.01, -3.01],
                scale: [0.08, 0.08, 0.02],
                colorRgb: [1.0, 0.0, 0.0],
                opacity: 0.95,
                quaternion: [0, 0, 0, 1]
            },
            {
                position: [1.02, 2.02, -3.02],
                scale: [0.08, 0.08, 0.02],
                colorRgb: [0.0, 1.0, 0.0],
                opacity: 0.95,
                quaternion: [0, 0, 0, 1]
            },
            // One splat in a different voxel
            {
                position: [5.0, 5.0, -10.0],
                scale: [0.1, 0.1, 0.02],
                colorRgb: [0.0, 0.0, 1.0],
                opacity: 0.9,
                quaternion: [0, 0, 0, 1]
            }
        ];

        const decimated = SplatService.decimateSplatsVoxelGrid(splats, 0.1);
        expect(decimated.length).toBe(2);

        // First voxel merged the two overlapping splats
        const merged = decimated.find(s => Math.abs(s.position[0] - 1.015) < 0.05);
        expect(merged).toBeDefined();
        // Color should be blended between red [1,0,0] and green [0,1,0] -> ~[0.5, 0.5, 0]
        expect(merged!.colorRgb[0]).toBeGreaterThan(0.4);
        expect(merged!.colorRgb[1]).toBeGreaterThan(0.4);
        expect(merged!.scale[0]).toBeGreaterThanOrEqual(0.05);
    });

    it('densifies oversized splats by splitting along the primary tangent axis', () => {
        const largeSplat: SplatPoint = {
            position: [0, 0, -5],
            scale: [0.4, 0.4, 0.02], // maxDim = 0.4 > maxScale 0.15
            colorRgb: [0.8, 0.7, 0.6],
            opacity: 0.98,
            quaternion: [0, 0, 0, 1]
        };

        const densified = SplatService.densifySplats([largeSplat], 0.15);
        expect(densified.length).toBe(2);
        // Both child splats should have reduced scale
        expect(densified[0].scale[0]).toBeCloseTo(0.4 * 0.65, 3);
        expect(densified[1].scale[0]).toBeCloseTo(0.4 * 0.65, 3);
        // Positions should be symmetrically offset
        expect(densified[0].position[0]).not.toEqual(densified[1].position[0]);
    });

    it('fuses multi-view observations and serializes to valid standard 32-byte .splat binary', () => {
        const view1: SplatPoint[] = [
            {
                position: [0, 1, -10],
                scale: [0.1, 0.1, 0.02],
                colorRgb: [1, 1, 1],
                opacity: 1,
                quaternion: [0, 0, 0, 1]
            }
        ];

        const view2: SplatPoint[] = [
            {
                position: [0.02, 1.02, -9.99], // Overlapping within same voxel cell
                scale: [0.1, 0.1, 0.02],
                colorRgb: [0.8, 0.8, 0.8],
                opacity: 1,
                quaternion: [0, 0, 0, 1]
            },
            {
                position: [3, 1, -10], // Disoccluded new geometry
                scale: [0.1, 0.1, 0.02],
                colorRgb: [0.2, 0.4, 0.9],
                opacity: 1,
                quaternion: [0, 0, 0, 1]
            }
        ];

        const fused = SplatService.fuseMultiViewSplats([view1, view2], {
            voxelSize: 0.1,
            densifyMaxScale: 0.2
        });

        expect(fused.length).toBe(2);

        // Serialize to .splat binary
        const splatBuffer = SplatService.serializeSplatBuffer(fused);
        expect(splatBuffer.byteLength).toBe(2 * 32);

        // Roundtrip parse
        const roundtrip = SplatService.parseSplatBuffer(splatBuffer);
        expect(roundtrip.length).toBe(2);
        expect(roundtrip[0].position[2]).toBeCloseTo(-10.0, 1);
    });
});
