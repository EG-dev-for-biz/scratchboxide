/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import {
    UniversalPbrBakingKernel,
    applyUniversalSleightOfHand,
    applyToksvigRoughnessCoupling
} from '../src/node/3d-engine/universal-pbr-baking-kernel';

describe('Universal Photogrammetric PBR Baking Kernels (Zero-Preset)', () => {

    // -------------------------------------------------------------------------
    // 1. Kernel 1: High-Pass Albedo Shadow Softener
    // -------------------------------------------------------------------------
    it('Kernel 1: lifts deep baked aerial shadows softly while preserving bright albedos', () => {
        // Deep shadow texel: L = 0.15 (dark underhang / arch interior)
        const shadowTexel = applyUniversalSleightOfHand({
            r: 50, g: 50, b: 60,
            lum: 0.15,
            laplacian: 0.0,
            wx: 10.0, wy: 15.0, wz: 10.0,
            fnx: 0.0, fny: 0.0, fnz: 1.0,
            localMinY: 0.0,
            baseRoughness: 0.82
        });

        // Unshadowed bright surface: L = 0.65 (direct sunlight)
        const sunlitTexel = applyUniversalSleightOfHand({
            r: 210, g: 195, b: 170,
            lum: 0.65,
            laplacian: 0.0,
            wx: 10.0, wy: 15.0, wz: 10.0,
            fnx: 0.0, fny: 0.0, fnz: 1.0,
            localMinY: 0.0,
            baseRoughness: 0.82
        });

        // Shadowed texel should be lifted
        expect(shadowTexel.telemetry.isShadow).toBe(true);
        expect(shadowTexel.albedo[0]).toBeGreaterThan(50);
        expect(shadowTexel.albedo[1]).toBeGreaterThan(50);
        // Subtle Rayleigh blue attenuation: Blue should receive less boost than Red
        const redBoostRatio = shadowTexel.albedo[0] / 50;
        const blueBoostRatio = shadowTexel.albedo[2] / 60;
        expect(redBoostRatio).toBeGreaterThan(blueBoostRatio);

        // Sunlit texel should remain untouched by shadow lift
        expect(sunlitTexel.telemetry.isShadow).toBe(false);
        expect(sunlitTexel.albedo[0]).toBe(210);
        expect(sunlitTexel.albedo[1]).toBe(195);
        expect(sunlitTexel.albedo[2]).toBe(170);
    });

    // -------------------------------------------------------------------------
    // 2. Kernel 2: Slope-Aware Normal Healer
    // -------------------------------------------------------------------------
    it('Kernel 2: injects 3D metric relief into vertical facades to heal aerial sensor stretch', () => {
        // Vertical wall: fny = 0.0 -> slopeStress = 1.0 - |0.0| = 1.0
        const verticalTexel = applyUniversalSleightOfHand({
            r: 140, g: 130, b: 120,
            lum: 0.50,
            laplacian: 0.0,
            wx: 5.2, wy: 12.4, wz: 8.7,
            fnx: 1.0, fny: 0.0, fnz: 0.0,
            localMinY: 0.0
        });

        // Horizontal roof: fny = 1.0 -> slopeStress = 1.0 - |1.0| = 0.0
        const horizontalTexel = applyUniversalSleightOfHand({
            r: 140, g: 130, b: 120,
            lum: 0.50,
            laplacian: 0.0,
            wx: 5.2, wy: 12.4, wz: 8.7,
            fnx: 0.0, fny: 1.0, fnz: 0.0,
            localMinY: 0.0
        });

        expect(verticalTexel.telemetry.isVertical).toBe(true);
        expect(horizontalTexel.telemetry.isVertical).toBe(false);

        // Vertical relief has metric striation modulation
        expect(Math.abs(verticalTexel.heightRelief)).toBeGreaterThan(0.0001);
        // Horizontal relief with lum=0.50 should have 0 displacement: (0.5 - 0.5) * 0.04 = 0.0
        expect(horizontalTexel.heightRelief).toBeCloseTo(0.0, 5);
    });

    // -------------------------------------------------------------------------
    // 3. Kernel 3: Peak/Valley Cavity Inversion
    // -------------------------------------------------------------------------
    it('Kernel 3: inverts peak and valley roughness, dropping AO in crevices and burnishing crests', () => {
        // Concave crevice / mortar joint: positive Laplacian (center darker than surroundings)
        const creviceTexel = applyUniversalSleightOfHand({
            r: 120, g: 110, b: 100,
            lum: 0.40,
            laplacian: 0.12,
            wx: 2.0, wy: 10.0, wz: 2.0,
            fnx: 0.0, fny: 0.0, fnz: 1.0,
            localMinY: 0.0,
            baseRoughness: 0.75
        });

        // Convex peak / molding crest: negative Laplacian (center brighter than surroundings)
        const crestTexel = applyUniversalSleightOfHand({
            r: 180, g: 170, b: 160,
            lum: 0.55,
            laplacian: -0.12,
            wx: 2.0, wy: 10.0, wz: 2.0,
            fnx: 0.0, fny: 0.0, fnz: 1.0,
            localMinY: 0.0,
            baseRoughness: 0.75
        });

        expect(creviceTexel.telemetry.isCavity).toBe(true);
        expect(crestTexel.telemetry.isPeak).toBe(true);

        // Crevice must drop AO (Red channel in ORM)
        expect(creviceTexel.orm[0]).toBeLessThan(200);
        // Crevice roughness (Green channel in ORM) must elevate to simulate matte dust
        expect(creviceTexel.orm[1]).toBeGreaterThan(Math.round(0.75 * 255));

        // Crest AO must remain high (unoccluded)
        expect(crestTexel.orm[0]).toBe(255);
        // Crest roughness must decrease due to wind-scour contact polish
        expect(crestTexel.orm[1]).toBeLessThan(Math.round(0.75 * 255));
    });

    // -------------------------------------------------------------------------
    // 4. Kernel 4: Toksvig Anti-Shimmering Micro-Normal Coupling
    // -------------------------------------------------------------------------
    it('Kernel 4: couples micro-normal variance into roughness to eliminate specular sparkling', () => {
        const baseRoughness = 0.55;

        // Smooth planar surface: ||meanNormal|| = 1.0 -> sigma2 = 0.0
        const flatRoughness = applyToksvigRoughnessCoupling(baseRoughness, 0.0, 0.50);
        expect(flatRoughness).toBeCloseTo(baseRoughness, 4);

        // High-frequency porous surface: ||meanNormal|| = 0.75 -> sigma2 = 0.25
        const highVarianceRoughness = applyToksvigRoughnessCoupling(baseRoughness, 0.25, 0.50);
        // sqrt(0.55^2 + 0.50 * 0.25) = sqrt(0.3025 + 0.125) = sqrt(0.4275) ~= 0.6538
        expect(highVarianceRoughness).toBeGreaterThan(baseRoughness);
        expect(highVarianceRoughness).toBeCloseTo(Math.sqrt(0.55 * 0.55 + 0.50 * 0.25), 3);
    });

    // -------------------------------------------------------------------------
    // 5. Kernel 5: Metric Ground-Contact Anchor Bleed & Strict Dielectric Metalness
    // -------------------------------------------------------------------------
    it('Kernel 5: grounds vertical facades into the pavement and locks metalness strictly to 0.000', () => {
        // Ground-level vertical wall: wy = 0.5m above localMinY = 0.0m (distToGround = 0.5m < 2.0m)
        const nearGroundTexel = applyUniversalSleightOfHand({
            r: 160, g: 150, b: 140,
            lum: 0.50,
            laplacian: 0.0,
            wx: 0.0, wy: 0.5, wz: 0.0,
            fnx: 1.0, fny: 0.0, fnz: 0.0,
            localMinY: 0.0,
            baseRoughness: 0.70
        });

        // High vertical wall: wy = 12.0m above localMinY = 0.0m
        const highWallTexel = applyUniversalSleightOfHand({
            r: 160, g: 150, b: 140,
            lum: 0.50,
            laplacian: 0.0,
            wx: 0.0, wy: 12.0, wz: 0.0,
            fnx: 1.0, fny: 0.0, fnz: 0.0,
            localMinY: 0.0,
            baseRoughness: 0.70
        });

        expect(nearGroundTexel.telemetry.isGroundContact).toBe(true);
        expect(highWallTexel.telemetry.isGroundContact).toBe(false);

        // Near ground AO drops sharply to simulate tight ground contact shadow
        expect(nearGroundTexel.orm[0]).toBeLessThan(highWallTexel.orm[0]);
        // Near ground roughness is locked to matte pavement dirt (>= 0.92)
        expect(nearGroundTexel.orm[1]).toBeGreaterThanOrEqual(Math.round(0.92 * 255));
        // Near ground albedo receives subtle dark grime tint
        expect(nearGroundTexel.albedo[0]).toBeLessThan(highWallTexel.albedo[0]);

        // STRICT DIELECTRIC INVARIANT: Metalness in ORM Blue channel must be strictly 0
        expect(nearGroundTexel.orm[2]).toBe(0);
        expect(highWallTexel.orm[2]).toBe(0);
    });

    // -------------------------------------------------------------------------
    // 6. Zero-Preset Architectural Invariant Check
    // -------------------------------------------------------------------------
    it('strictly complies with Adaptive Domain Architecture: zero landmark or domain classifiers', () => {
        const sourceCode = fs.readFileSync(
            path.resolve(__dirname, '../src/node/3d-engine/universal-pbr-baking-kernel.ts'),
            'utf8'
        );

        // Must not contain hardcoded landmark or closed domain taxonomy switches
        expect(sourceCode).not.toMatch(/if\s*\([^)]*isColosseum/i);
        expect(sourceCode).not.toMatch(/if\s*\([^)]*isEmpireState/i);
        expect(sourceCode).not.toMatch(/if\s*\([^)]*isEiffel/i);
        expect(sourceCode).not.toMatch(/if\s*\([^)]*isBridge/i);
        expect(sourceCode).not.toMatch(/enum\s+LandmarkType/i);
        expect(sourceCode).not.toMatch(/enum\s+BuildingCategory/i);
    });

    // -------------------------------------------------------------------------
    // 7. Full GLB Pipeline Test: Washington Square Arch NYC
    // -------------------------------------------------------------------------
    it('processes arbitrary aerial 3D tile (Washington Square Arch NYC) end-to-end with 0.000 mm drift lock', async () => {
        const rawTilePath = path.resolve(__dirname, '../../../public/models/washington_square_arch_nyc_raw.glb');
        const outputGlbPath = path.resolve(__dirname, '../../../public/models/washington_square_arch_nyc_universal_pbr.glb');

        if (!fs.existsSync(rawTilePath)) {
            console.warn('Washington Square Arch raw tile not present, skipping full GLB end-to-end test.');
            return;
        }

        const result = await UniversalPbrBakingKernel.processGlb(rawTilePath, outputGlbPath, {
            baseRoughness: 0.82,
            reliefMultiplier: 1.0,
            toksvigKappa: 0.50
        });

        expect(result.success).toBe(true);
        expect(result.geometricDriftMm).toBe(0.000);
        expect(result.telemetry.totalTexelsProcessed).toBeGreaterThan(0);
        expect(fs.existsSync(outputGlbPath)).toBe(true);

        const outBuf = fs.readFileSync(outputGlbPath);
        // Verify GLB magic header
        expect(outBuf.readUInt32LE(0)).toBe(0x46546C67);

        // Parse JSON chunk to verify materials have no unlit and have standard PBR channels
        const jsonLen = outBuf.readUInt32LE(12);
        const jsonStr = outBuf.toString('utf8', 20, 20 + jsonLen);
        const gltf = JSON.parse(jsonStr);

        // Zero unlit materials
        if (gltf.extensionsUsed) {
            expect(gltf.extensionsUsed).not.toContain('KHR_materials_unlit');
        }

        for (const mat of gltf.materials) {
            expect(mat.normalTexture).toBeDefined();
            expect(mat.occlusionTexture).toBeDefined();
            expect(mat.pbrMetallicRoughness?.metallicRoughnessTexture).toBeDefined();
            // Dielectric parameters
            expect(mat.pbrMetallicRoughness?.roughnessFactor).toBe(1.0);
            expect(mat.pbrMetallicRoughness?.metallicFactor).toBe(1.0);
        }
    });
});
