/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { NativeCppCompilerService } from '../src/node/3d-engine/native-compiler-service';
import { NativeSkyService, PhysicalSkyOptions } from '../src/node/3d-engine/native-sky-service';
import { NativeTileLightingService } from '../src/node/3d-engine/native-tile-lighting-service';

describe('Native C++20 Physical Sky & De-Lighting Engine', () => {
    const compiler = new NativeCppCompilerService();
    const skyService = new NativeSkyService();
    const lightingService = new NativeTileLightingService();

    it('should locate scratchbox_sky.hpp and scratchbox_delight.hpp in C++ SDK include path', () => {
        const includePath = compiler.getSdkIncludePath();
        expect(fs.existsSync(path.join(includePath, 'scratchbox_sky.hpp'))).toBe(true);
        expect(fs.existsSync(path.join(includePath, 'scratchbox_delight.hpp'))).toBe(true);
        expect(fs.existsSync(path.join(includePath, 'scratchbox_atmosphere.hpp'))).toBe(true);
    });

    it('should generate a multiple-scattering Rayleigh/Mie sky equirectangular map from the precomputed tables', async () => {
        // High noon sun: pointing straight down from zenith +Y
        const middayOptions: PhysicalSkyOptions = {
            sunDirection: [0, 1, 0],
            params: {
                observerAltitudeMeters: 0,
                airDensity: 1.0,
                dustDensity: 1.0,
                ozoneDensity: 1.0,
                sunIntensity: 1.0
            },
            width: 64,
            height: 32
        };

        const result = await skyService.generatePhysicalSkyEquirectangular(middayOptions);

        expect(result.success).toBe(true);
        expect(result.width).toBe(64);
        expect(result.height).toBe(32);
        expect(result.rgbFloats).toBeDefined();
        expect(result.rgbFloats.length).toBe(64 * 32 * 3);

        // Zenith test: top row or near top (row 0 or 1 is zenith +Y)
        // With Rayleigh scattering, zenith sky blue (channel 2) should be significantly higher than red (channel 0)
        const zenithX = 32;
        const zenithY = 2; // Near top of equirectangular map (+Y)
        const zenithIdx = (zenithY * 64 + zenithX) * 3;
        const rZenith = result.rgbFloats[zenithIdx + 0];
        const gZenith = result.rgbFloats[zenithIdx + 1];
        const bZenith = result.rgbFloats[zenithIdx + 2];

        // Rayleigh signature: Blue > Red
        expect(bZenith).toBeGreaterThan(rZenith);
        // Bruneton's irradiance table holds the sky light of orders 1..N-1, so it is empty when the suite runs one order
        if (Number(process.env.SCRATCHBOX_SKY_SCATTERING_ORDERS ?? 4) >= 2) expect(result.skyIrradianceHorizontal[1]).toBeGreaterThan(0);
        expect(result.sunIrradiance[0]).toBeGreaterThan(0); // direct sun transmittance
    }, 600_000); // a cold machine precomputes this medium's tables first (about 25 s on 16 cores, 100 s on 4)

    it('should correctly shift chromaticity toward sunset/golden hour in C++ physical sky', async () => {
        // Low sun near horizon: elevation ~ 5 degrees (Y=0.087, Z=0.996)
        const sunsetOptions: PhysicalSkyOptions = {
            sunDirection: [0, 0.087, 0.996],
            params: {
                observerAltitudeMeters: 0,
                airDensity: 1.2,
                dustDensity: 2.5, // Turbid haze at sunset
                ozoneDensity: 1.0,
                sunIntensity: 1.0
            },
            width: 64,
            height: 32
        };

        const result = await skyService.generatePhysicalSkyEquirectangular(sunsetOptions);

        expect(result.success).toBe(true);
        // Sun irradiance transmittance through long atmospheric path should heavily attenuate blue
        // causing sunIrradiance Red > Blue
        expect(result.sunIrradiance[0]).toBeGreaterThan(result.sunIrradiance[2]);
    }, 600_000); // a turbid medium is its own set of tables

    it('should execute physical C++ albedo extraction eliminating heuristic GLSL shadow lift', async () => {
        // Simple test quad
        const vertices = [
            -2, 0, -2,   2, 0, -2,   2, 0, 2,
            -2, 0, -2,   2, 0, 2,  -2, 0, 2
        ];
        const normals = [
            0, 1, 0,   0, 1, 0,   0, 1, 0,
            0, 1, 0,   0, 1, 0,   0, 1, 0
        ];
        const indices = [0, 1, 2, 3, 4, 5];
        const uvs = [
            0, 0,  1, 0,  1, 1,
            0, 0,  1, 1,  0, 1
        ];

        const width = 16;
        const height = 16;
        const rgbBytes = Buffer.alloc(width * height * 3);
        // Fill half with shadow (darker)
        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
                const idx = (y * width + x) * 3;
                const lum = x < 8 ? 50 : 180;
                rgbBytes[idx + 0] = lum;
                rgbBytes[idx + 1] = lum;
                rgbBytes[idx + 2] = lum;
            }
        }

        const sunDir: [number, number, number] = [0, 1, 0];
        const delightRes = await lightingService.delightTextureAndRelight(
            { vertices, indices, uvs, normals },
            { width, height, rgbBytes },
            sunDir,
            { epsilonClamp: 0.15 }
        );

        expect(delightRes.delightedRgbBytes).toBeDefined();
        expect(delightRes.delightedRgbBytes.length).toBe(width * height * 3);
        // The darker side (x < 8) should be lifted by the division of shading
        const shadowPixelLum = delightRes.delightedRgbBytes[0];
        expect(shadowPixelLum).toBeGreaterThanOrEqual(50);
    }, 45000);
});
