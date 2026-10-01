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
import { AdaptiveMaterialPbrService } from '../src/node/3d-engine/adaptive-material-pbr-service';

describe('AdaptiveMaterialPbrService (Zero-Preset Architecture)', () => {

    it('guarantees zero-preset compliance: no static material enum classifiers exist in the codebase', () => {
        const serviceSource = fs.readFileSync(
            path.resolve(__dirname, '../src/node/3d-engine/adaptive-material-pbr-service.ts'),
            'utf8'
        );

        // Verify zero hardcoded landmark or material enum branches
        expect(serviceSource).not.toMatch(/if\s*\([^)]*isLimestone/);
        expect(serviceSource).not.toMatch(/if\s*\([^)]*isSpire/);
        expect(serviceSource).not.toMatch(/if\s*\([^)]*isWindow/);
        expect(serviceSource).not.toMatch(/if\s*\([^)]*isBitumen/);
        expect(serviceSource).not.toMatch(/enum\s+MaterialCategory/);
        expect(serviceSource).not.toMatch(/enum\s+MaterialType/);
    });

    it('continuously adapts roughness to spatial frequency micro-porosity', () => {
        const width = 64;
        const height = 64;
        const total = width * height;

        // 1. Create a smooth specular signal (e.g. polished glass or buffed lacquer)
        const smoothRgba = new Uint8Array(total * 4);
        for (let i = 0; i < total; i++) {
            smoothRgba[i * 4 + 0] = 180;
            smoothRgba[i * 4 + 1] = 180;
            smoothRgba[i * 4 + 2] = 180;
            smoothRgba[i * 4 + 3] = 255;
        }

        // 2. Create a high-frequency porous signal (e.g. coarse sandstone, cast concrete)
        const roughRgba = new Uint8Array(total * 4);
        for (let i = 0; i < total; i++) {
            const noise = ((i % 2 === 0 ? 50 : -50) + (Math.floor(i / width) % 2 === 0 ? 30 : -30));
            const val = Math.max(0, Math.min(255, 140 + noise));
            roughRgba[i * 4 + 0] = val;
            roughRgba[i * 4 + 1] = val;
            roughRgba[i * 4 + 2] = val;
            roughRgba[i * 4 + 3] = 255;
        }

        const smoothFields = AdaptiveMaterialPbrService.estimateContinuousBiophysicalFields(smoothRgba, width, height);
        const roughFields = AdaptiveMaterialPbrService.estimateContinuousBiophysicalFields(roughRgba, width, height);

        // Average roughness
        let avgSmoothRough = 0;
        let avgCoarseRough = 0;
        for (let i = 0; i < total; i++) {
            avgSmoothRough += smoothFields.roughness[i] / 255.0;
            avgCoarseRough += roughFields.roughness[i] / 255.0;
        }
        avgSmoothRough /= total;
        avgCoarseRough /= total;

        // Smooth surface must yield significantly lower roughness than porous surface
        expect(avgSmoothRough).toBeLessThan(0.25);
        expect(avgCoarseRough).toBeGreaterThan(0.60);
    });

    it('continuously detects metallic conduction from specular reflectance and low chroma saturation', () => {
        const width = 32;
        const height = 32;
        const total = width * height;

        // Metallic signal: High linear luminance, low saturation (e.g. polished stainless steel or aluminum)
        const metalRgba = new Uint8Array(total * 4);
        for (let i = 0; i < total; i++) {
            metalRgba[i * 4 + 0] = 210;
            metalRgba[i * 4 + 1] = 212;
            metalRgba[i * 4 + 2] = 215;
            metalRgba[i * 4 + 3] = 255;
        }

        // Dielectric colored signal: Medium luminance, high saturation (e.g. terracotta or red brick)
        const dielectricRgba = new Uint8Array(total * 4);
        for (let i = 0; i < total; i++) {
            dielectricRgba[i * 4 + 0] = 180;
            dielectricRgba[i * 4 + 1] = 60;
            dielectricRgba[i * 4 + 2] = 40;
            dielectricRgba[i * 4 + 3] = 255;
        }

        const metalFields = AdaptiveMaterialPbrService.estimateContinuousBiophysicalFields(metalRgba, width, height);
        const dielectricFields = AdaptiveMaterialPbrService.estimateContinuousBiophysicalFields(dielectricRgba, width, height);

        let avgMetal = 0;
        let avgDielectric = 0;
        for (let i = 0; i < total; i++) {
            avgMetal += metalFields.metallic[i] / 255.0;
            avgDielectric += dielectricFields.metallic[i] / 255.0;
        }
        avgMetal /= total;
        avgDielectric /= total;

        expect(avgMetal).toBeGreaterThan(0.50);
        expect(avgDielectric).toBeLessThan(0.05);
    });

    it('computes unit-normalized tangent-space normals via bandwidth-adaptive Scharr', () => {
        const width = 32;
        const height = 32;
        const total = width * height;

        const rgba = new Uint8Array(total * 4);
        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
                const idx = y * width + x;
                const v = Math.round(128 + 60 * Math.sin((x / width) * Math.PI * 4.0));
                rgba[idx * 4 + 0] = v;
                rgba[idx * 4 + 1] = v;
                rgba[idx * 4 + 2] = v;
                rgba[idx * 4 + 3] = 255;
            }
        }

        const fields = AdaptiveMaterialPbrService.estimateContinuousBiophysicalFields(rgba, width, height, {
            reliefMultiplier: 1.2
        });

        // Verify normal map length is 1.0 (unit vector)
        for (let i = 0; i < total; i++) {
            const nx = (fields.normalRgb[i * 3 + 0] / 255.0) * 2.0 - 1.0;
            const ny = (fields.normalRgb[i * 3 + 1] / 255.0) * 2.0 - 1.0;
            const nz = (fields.normalRgb[i * 3 + 2] / 255.0) * 2.0 - 1.0;
            const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
            expect(len).toBeCloseTo(1.0, 1);
            expect(nz).toBeGreaterThan(0.0); // Must face forward along +Z in tangent space
        }
    });

    it('computes horizon ambient occlusion (HBAO) that darkens crevices without blowing out open planes', () => {
        const width = 32;
        const height = 32;
        const total = width * height;

        // Signal with a deep central step crack
        const creviceRgba = new Uint8Array(total * 4);
        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
                const idx = y * width + x;
                const isCrack = (x >= 14 && x <= 17);
                const val = isCrack ? 40 : 180;
                creviceRgba[idx * 4 + 0] = val;
                creviceRgba[idx * 4 + 1] = val;
                creviceRgba[idx * 4 + 2] = val;
                creviceRgba[idx * 4 + 3] = 255;
            }
        }

        const fields = AdaptiveMaterialPbrService.estimateContinuousBiophysicalFields(creviceRgba, width, height);

        // Center crevice AO should be darker than flat edge
        const centerCrackAo = fields.ambientOcclusion[16 * width + 15] / 255.0;
        const flatEdgeAo = fields.ambientOcclusion[16 * width + 2] / 255.0;

        expect(centerCrackAo).toBeLessThan(flatEdgeAo);
        expect(flatEdgeAo).toBeGreaterThan(0.85);
    });

});
