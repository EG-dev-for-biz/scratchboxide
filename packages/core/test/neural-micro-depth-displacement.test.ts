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
    NeuralMicroDepthDisplacementService
} from '../src/node/spatial/NeuralMicroDepthDisplacementService';

describe('NeuralMicroDepthDisplacementService: Hybrid Micro-Depth Displacement', () => {
    it('smooths depth fields using separable running box filter with NaN/boundary handling', () => {
        const W = 10, H = 10;
        const depth = new Float32Array(W * H);
        depth.fill(10.0);
        // Add a sharp impulse bump at (5, 5)
        depth[5 * W + 5] = 20.0;

        const smoothed = NeuralMicroDepthDisplacementService.smoothField(depth, W, H, 2);
        expect(smoothed[5 * W + 5]).toBeLessThan(20.0);
        expect(smoothed[5 * W + 5]).toBeGreaterThan(10.0);
        // Distant corners should remain essentially untouched
        expect(Math.abs(smoothed[0] - 10.0)).toBeLessThan(0.01);
    });

    it('aligns neural depth to metric mesh depth via affine regression and computes micro-relief Δz', () => {
        const W = 32, H = 32;
        const N = W * H;
        const meshDepth = new Float32Array(N);
        const neuralDepth = new Float32Array(N);

        // Perspective camera viewing facade with depth ranging 20m to 30m,
        // and high-frequency architectural fluting columns
        for (let y = 0; y < H; ++y) {
            for (let x = 0; x < W; ++x) {
                const idx = y * W + x;
                meshDepth[idx] = 20.0 + (y / H) * 10.0; // Melted mesh has macro slope but no columns
                // Neural model sees true high-frequency columns (sine fluting of +-0.4m)
                // in uncalibrated disparity/depth units: z_neural = 0.5 * z_metric - 2.0
                const metricCol = meshDepth[idx] + 0.4 * Math.sin(x * 0.8);
                neuralDepth[idx] = 0.5 * metricCol - 2.0;
            }
        }

        const res = NeuralMicroDepthDisplacementService.alignAndDisplace(
            meshDepth,
            neuralDepth,
            W,
            H,
            { maxDeltaZ: 2.0, smoothRadius: 8, weight: 1.0 }
        );

        expect(res.affineScale).toBeGreaterThan(1.7);
        expect(res.affineScale).toBeLessThan(2.3);
        expect(res.affineShift).toBeGreaterThan(2.0);
        expect(res.microDisplacedCount).toBeGreaterThan(N * 0.7);
        expect(res.maxObservedDeltaZ).toBeGreaterThan(0.35);
        expect(res.maxObservedDeltaZ).toBeLessThanOrEqual(2.0);

        // Displaced depth should reflect the column flutes
        const midY = 16;
        const center = res.effectiveDepth[midY * W + 16];
        const flank = res.effectiveDepth[midY * W + 14];
        expect(center).not.toEqual(flank);
    });

    it('extracts photometric micro-relief and carves hollow archway cavities', () => {
        const W = 32, H = 32;
        const N = W * H;
        const meshDepth = new Float32Array(N);
        meshDepth.fill(20.0);

        const rgb = new Uint8Array(N * 3);
        // Default warm stone albedo
        for (let i = 0; i < N; ++i) {
            rgb[i * 3] = 180;
            rgb[i * 3 + 1] = 170;
            rgb[i * 3 + 2] = 150;
        }

        // Carve an archway corridor in the center (dark portal interior: rgb ~ 20, 20, 20)
        for (let y = 10; y < 25; ++y) {
            for (let x = 12; x < 20; ++x) {
                const i = y * W + x;
                rgb[i * 3] = 15;
                rgb[i * 3 + 1] = 15;
                rgb[i * 3 + 2] = 15;
            }
        }

        const res = NeuralMicroDepthDisplacementService.extractPhotometricMicroRelief(
            meshDepth,
            rgb,
            3,
            W,
            H,
            { cavityDepth: 3.5, cavityLum: 0.18, maxDeltaZ: 3.5 }
        );

        expect(res.microDisplacedCount).toBeGreaterThan(50);
        // Archway interior depth should be pulled inward (depth > 20.0)
        const archDepth = res.effectiveDepth[18 * W + 16];
        expect(archDepth).toBeGreaterThan(22.0);
    });
});
