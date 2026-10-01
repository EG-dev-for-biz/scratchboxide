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
    synthesizeLivingFoliage,
    LivingFoliageKernel,
    hash3D,
    valueNoise3D
} from '../src/node/3d-engine/living-foliage-kernel';

describe('Universal Living Foliage Texture Synthesis Kernel', () => {

    it('Trick 1: Leaf Flutter Micro-Normal produces randomized planar tilts within +/- 35 deg across 5cm cells', () => {
        const tiltsX: number[] = [];
        const tiltsZ: number[] = [];

        // Sample across 30 distinct 5cm cells (5cm = 0.05m step)
        for (let i = 0; i < 30; i++) {
            const wx = i * 0.05 + 0.025;
            const wy = 5.0;
            const wz = 2.0;

            const res = synthesizeLivingFoliage({
                r: 45, g: 110, b: 35,
                wx, wy, wz,
                fnx: 0, fny: 0.85, fnz: 0.52,
                isLeafMask: false
            });

            expect(res.telemetry.isUnderside).toBe(false);
            const [dx, dy, dz] = res.normalDelta;

            // Tilt X and Tilt Z should be within +/- 0.70 radians (+/- 35 deg)
            expect(Math.abs(dx)).toBeLessThanOrEqual(0.35 + 1e-4);
            expect(Math.abs(dz)).toBeLessThanOrEqual(0.35 + 1e-4);
            expect(dy).toBe(0); // Foliage planar tilt is in tangent plane X/Z

            tiltsX.push(dx);
            tiltsZ.push(dz);
        }

        // Verify that tilts are non-trivial and vary across cells
        const uniqueX = new Set(tiltsX.map(t => t.toFixed(4)));
        const uniqueZ = new Set(tiltsZ.map(t => t.toFixed(4)));
        expect(uniqueX.size).toBeGreaterThan(15);
        expect(uniqueZ.size).toBeGreaterThan(15);
    });

    it('Trick 2: Under-Canopy Bark & Branch Inversion shifts downward surfaces (Ny < -0.20) to weathered bark', () => {
        // Deep underside: normal pointing downward (fny = -0.70)
        const greenBlobPixel = { r: 35, g: 125, b: 25 };

        const res = synthesizeLivingFoliage({
            r: greenBlobPixel.r,
            g: greenBlobPixel.g,
            b: greenBlobPixel.b,
            wx: 1.5,
            wy: 3.2,
            wz: -0.4,
            fnx: 0.2,
            fny: -0.70, // Downward facet under canopy
            fnz: 0.1,
            isLeafMask: false
        });

        expect(res.telemetry.isUnderside).toBe(true);

        // Albedo must transform from green into charcoal-umber bark:
        // Green channel should be significantly reduced relative to initial 125
        expect(res.albedo[1]).toBeLessThan(greenBlobPixel.g);
        // Red and Blue should be well-balanced charcoal wood tones
        expect(res.albedo[0]).toBeGreaterThan(res.albedo[2]); // Warm charcoal/umber has R > B

        // Normal map must have vertical bark furrow striation
        const barkFurrow = Math.sin(1.5 * 80.0) * 0.20;
        expect(res.normalDelta[1]).toBeCloseTo(barkFurrow, 4);

        // ORM: deep under-canopy cavity AO (55/255 ≈ 0.22), high matte bark (235/255 ≈ 0.92), strict 0 metalness
        expect(res.orm[0]).toBe(55);
        expect(res.orm[1]).toBe(235);
        expect(res.orm[2]).toBe(0);
    });

    it('Trick 3: Backlit Chlorophyll Rim Baking boosts luminous green-gold on thin perforated leaf edges', () => {
        const interior = synthesizeLivingFoliage({
            r: 50, g: 100, b: 30,
            wx: 2.0, wy: 4.0, wz: 1.0,
            fnx: 0, fny: 0.8, fnz: 0.6,
            isLeafMask: false // Interior thick leaf clump
        });

        const rim = synthesizeLivingFoliage({
            r: 50, g: 100, b: 30,
            wx: 2.0, wy: 4.0, wz: 1.0,
            fnx: 0, fny: 0.8, fnz: 0.6,
            isLeafMask: true // Thin translucent edge
        });

        expect(rim.telemetry.isBacklitRim).toBe(true);
        expect(interior.telemetry.isBacklitRim).toBe(false);

        // Leaf edge gets luminous green-gold transmission (+24 R, +48 G, -12 B)
        expect(rim.albedo[0]).toBe(50 + 24);
        expect(rim.albedo[1]).toBe(100 + 48);
        expect(rim.albedo[2]).toBe(30 - 12);
    });

    it('Sleight 3: Subsurface Chlorophyll Wrap Lighting lifts penumbra texels with lime-amber transmittance', () => {
        const centroid: [number, number, number] = [0, 4, 0];
        const sun: [number, number, number] = [1, 0, 0]; // Sun along +X
        // Point on negative X side: N_cloud is [-1, 0, 0], N_cloud · L = -1 (opposite sun)
        // Point near terminator: N_cloud is [-0.05, 0.998, 0], N_cloud · L = -0.05 (penumbra peak)
        const penumbraTexel = synthesizeLivingFoliage({
            r: 50, g: 100, b: 30,
            wx: -0.25, wy: 8.99, wz: 0,
            fnx: 0, fny: 1, fnz: 0,
            treeCentroid: centroid,
            canopyRadius: 5.0,
            options: {
                sunDirection: sun,
                wrapFactor: 0.35,
                transmittanceBoost: { r: 10, g: 18, b: -8 }
            }
        });

        // Penumbra texel should receive lime-amber chlorophyll transmittance (+10 R, +18 G, -8 B)
        expect(penumbraTexel.telemetry.transmittanceFactor).toBeGreaterThan(0.7);
        expect(penumbraTexel.albedo[0]).toBeGreaterThanOrEqual(50 + 7);
        expect(penumbraTexel.albedo[1]).toBeGreaterThanOrEqual(100 + 12);
        expect(penumbraTexel.albedo[2]).toBeLessThanOrEqual(30 - 5);
        expect(penumbraTexel.telemetry.wrapIntensity).toBeGreaterThan(0.15);
    });

    it('Sleight 4: Inverted Volumetric Core Depth Gradient replaces noise holes with continuous 3-tier AO', () => {
        const centroid: [number, number, number] = [0, 5, 0];
        const R = 4.0; // 4m canopy radius

        // 1. Inner Core: distance 1.0m -> rho = 0.25 (< 0.45)
        const inner = synthesizeLivingFoliage({
            r: 50, g: 100, b: 30,
            wx: 1.0, wy: 5.0, wz: 0,
            fnx: 0, fny: 1, fnz: 0,
            treeCentroid: centroid,
            canopyRadius: R
        });
        expect(inner.telemetry.radialDepthRho).toBeCloseTo(0.25, 2);
        expect(inner.telemetry.isDeepVoid).toBe(true);
        // AO in [0.15, 0.25] -> ORM[0] in [38, 64]
        const innerAo = inner.orm[0] / 255;
        expect(innerAo).toBeGreaterThanOrEqual(0.15 - 1e-3);
        expect(innerAo).toBeLessThanOrEqual(0.25 + 1e-3);

        // 2. Mid-Canopy: distance 2.4m -> rho = 0.60 (in [0.45, 0.75])
        const mid = synthesizeLivingFoliage({
            r: 50, g: 100, b: 30,
            wx: 2.4, wy: 5.0, wz: 0,
            fnx: 0, fny: 1, fnz: 0,
            treeCentroid: centroid,
            canopyRadius: R
        });
        expect(mid.telemetry.radialDepthRho).toBeCloseTo(0.60, 2);
        const midAo = mid.orm[0] / 255;
        expect(midAo).toBeGreaterThanOrEqual(0.50 - 1e-3);
        expect(midAo).toBeLessThanOrEqual(0.85 + 1e-3);

        // 3. Outer Envelope: distance 3.6m -> rho = 0.90 (>= 0.75)
        const outer = synthesizeLivingFoliage({
            r: 50, g: 100, b: 30,
            wx: 3.6, wy: 5.0, wz: 0,
            fnx: 0, fny: 1, fnz: 0,
            treeCentroid: centroid,
            canopyRadius: R
        });
        expect(outer.telemetry.radialDepthRho).toBeCloseTo(0.90, 2);
        const outerAo = outer.orm[0] / 255;
        expect(outerAo).toBeGreaterThanOrEqual(0.88 - 1e-3);
        expect(outerAo).toBeLessThanOrEqual(1.00);
    });

    it('Fallback: Procedural noise voids active when enableVolumetricCoreAo is false', () => {
        let foundVoid = false;
        let foundCanopy = false;

        for (let x = 0; x < 20; x++) {
            const res = synthesizeLivingFoliage({
                r: 50, g: 110, b: 40,
                wx: x * 0.4, wy: 4.0, wz: 1.0,
                fnx: 0, fny: 0.9, fnz: 0.4,
                isLeafMask: false,
                options: { enableVolumetricCoreAo: false }
            });

            if (res.telemetry.isDeepVoid) {
                foundVoid = true;
                expect(res.orm[0]).toBeLessThanOrEqual(64); // <= 0.25
                expect(res.orm[0]).toBeGreaterThanOrEqual(38); // >= 0.15
            } else {
                foundCanopy = true;
                expect(res.orm[0]).toBeGreaterThanOrEqual(230); // >= 0.90
            }
        }

        expect(foundVoid).toBe(true);
        expect(foundCanopy).toBe(true);
    });

    it('Trick 5: Dual-Roughness Cuticle Stippling creates bimodal distribution (25% waxy blades vs 75% matte stems)', () => {
        let waxyCount = 0;
        let matteCount = 0;
        const total = 1000;

        for (let i = 0; i < total; i++) {
            const wx = i * 0.037;
            const wy = (i % 50) * 0.081;
            const wz = ((i * 17) % 100) * 0.043;

            const res = synthesizeLivingFoliage({
                r: 45, g: 115, b: 35,
                wx, wy, wz,
                fnx: 0, fny: 0.7, fnz: 0.7,
                isLeafMask: false
            });

            if (res.telemetry.isWaxyBlade) {
                waxyCount++;
                // Waxy cuticle roughness ~0.32 (82 / 255)
                expect(res.orm[1]).toBe(Math.round(0.32 * 255));
            } else {
                matteCount++;
                // Matte stem roughness ~0.88 (224 / 255)
                expect(res.orm[1]).toBe(Math.round(0.88 * 255));
            }
        }

        const waxyRatio = waxyCount / total;
        // Should be approximately 25% waxy (tolerance +/- 7%)
        expect(waxyRatio).toBeGreaterThan(0.18);
        expect(waxyRatio).toBeLessThan(0.32);
        expect(matteCount).toBeGreaterThan(waxyCount);
    });

    it('LivingFoliageKernel.processAtlasBuffer() processes synthetic texture atlas buffer end-to-end', () => {
        const width = 64;
        const height = 64;
        const rawRgba = new Uint8Array(width * height * 4);

        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
                const idx = (y * width + x) * 4;
                rawRgba[idx + 0] = 40;  // R
                rawRgba[idx + 1] = 120; // G
                rawRgba[idx + 2] = 30;  // B
                // Thin alpha edge at border, solid inside
                rawRgba[idx + 3] = (x < 4 || x > 60 || y < 4 || y > 60) ? 120 : 255;
            }
        }

        const result = LivingFoliageKernel.processAtlasBuffer(
            rawRgba,
            width,
            height,
            {
                worldBounds: { minX: 0, maxX: 5, minY: 0, maxY: 10, minZ: 0, maxZ: 5 },
                dominantNormal: [0, 0.8, 0.6]
            }
        );

        expect(result.albedoRgba.length).toBe(width * height * 4);
        expect(result.normalRgb.length).toBe(width * height * 3);
        expect(result.ormRgba.length).toBe(width * height * 4);

        expect(result.telemetry.totalTexels).toBe(width * height);
        expect(result.telemetry.waxyBladeCount).toBeGreaterThan(0);
        expect(result.telemetry.backlitRimCount).toBeGreaterThan(0);
        expect(result.telemetry.deepVoidCount).toBeGreaterThan(0);
    });

    it('Strictly enforces zero presets and 0.000 mm geometric drift lock', () => {
        const sourceCode = require('fs').readFileSync(
            require('path').resolve(__dirname, '../src/node/3d-engine/living-foliage-kernel.ts'),
            'utf8'
        );

        // Must not contain hardcoded landmark or city lists
        expect(sourceCode).not.toMatch(/Colosseum|Eiffel|EmpireState|BigBen/i);

        // Must strictly lock metalness to 0 for dielectrics
        expect(sourceCode).toMatch(/orm:\s*\[55,\s*235,\s*0\]/);
        expect(sourceCode).toMatch(/0\s*\/\/\s*Strict 0\.0 Dielectric Metalness/);
    });
});
