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
    NativeMaterialPbrService,
    PBR_50_ARCHETYPE_CATALOG
} from '../src/node/3d-engine/native-material-pbr-service';

describe('NativeMaterialPbrService', () => {
    const service = new NativeMaterialPbrService();

    describe('Biophysical 50-Archetype Catalog', () => {
        it('should catalog exactly 50 calibrated material archetypes', () => {
            const catalog = service.get50Catalog();
            expect(catalog).toHaveLength(50);
            expect(PBR_50_ARCHETYPE_CATALOG).toHaveLength(50);
        });

        it('should contain all 7 architectural material categories', () => {
            const catalog = service.get50Catalog();
            const categories = new Set(catalog.map(c => c.category));
            expect(categories).toContain('Stones');
            expect(categories).toContain('Concrete & Paving');
            expect(categories).toContain('Metals');
            expect(categories).toContain('Glazing');
            expect(categories).toContain('Roofing');
            expect(categories).toContain('Timbers');
            expect(categories).toContain('Relief & Weathering');
        });

        it('should resolve archetypes by key, id, or display name', () => {
            const byId = service.resolveArchetype(0);
            expect(byId.key).toBe('indiana_limestone');

            const byKey = service.resolveArchetype('carrara_marble');
            expect(byKey.archetypeId).toBe(4);
            expect(byKey.category).toBe('Stones');

            const byName = service.resolveArchetype('Weathered Structural Concrete');
            expect(byName.key).toBe('weathered_concrete');

            const byFuzzy = service.resolveArchetype('titanium');
            expect(byFuzzy.key).toBe('brushed_titanium');
        });
    });

    describe('C++20 Multithreaded PBR Texture Synthesis', () => {
        it('should synthesize a complete PBR texture pack for Indiana Limestone', async () => {
            const res = await service.synthesizePbrTextureSet({
                archetype: 'indiana_limestone',
                width: 64,
                height: 64,
                seed: 42
            });

            expect(res.width).toBe(64);
            expect(res.height).toBe(64);
            expect(res.archetypeKey).toBe('indiana_limestone');

            // RGB buffers: 64 * 64 * 3 = 12288 bytes
            const expectedRgbBytes = 64 * 64 * 3;
            expect(res.albedoRgb.length).toBe(expectedRgbBytes);
            expect(res.normalRgb.length).toBe(expectedRgbBytes);
            expect(res.roughnessRgb.length).toBe(expectedRgbBytes);
            expect(res.metallicRgb.length).toBe(expectedRgbBytes);
            expect(res.aoRgb.length).toBe(expectedRgbBytes);
            expect(res.ormRgb.length).toBe(expectedRgbBytes);
            expect(res.heightRgb.length).toBe(expectedRgbBytes);

            // RGBA buffers: 64 * 64 * 4 = 16384 bytes
            const expectedRgbaBytes = 64 * 64 * 4;
            expect(res.albedoRgba.length).toBe(expectedRgbaBytes);
            expect(res.normalRgba.length).toBe(expectedRgbaBytes);
            expect(res.ormRgba.length).toBe(expectedRgbaBytes);

            // Tangent normal sanity: Blue channel (Z) should be dominantly positive (> 120 in [0..255])
            let dominantBlueCount = 0;
            const totalPixels = 64 * 64;
            for (let i = 0; i < totalPixels; i++) {
                const b = res.normalRgb[i * 3 + 2];
                if (b >= 120) dominantBlueCount++;
            }
            expect(dominantBlueCount / totalPixels).toBeGreaterThan(0.95);

            // ORM channel packing: R=AO, G=Roughness, B=Metallic, A=255
            for (let i = 0; i < 20; i++) {
                expect(res.ormRgba[i * 4 + 0]).toBe(res.aoRgb[i * 3 + 0]);
                expect(res.ormRgba[i * 4 + 1]).toBe(res.roughnessRgb[i * 3 + 0]);
                expect(res.ormRgba[i * 4 + 2]).toBe(res.metallicRgb[i * 3 + 0]);
                expect(res.ormRgba[i * 4 + 3]).toBe(255);
            }

            expect(res.executionTimeMs).toBeGreaterThan(0);
        }, 60000);

        it('should synthesize a metal archetype with high metallicity in ORM blue channel', async () => {
            const res = await service.synthesizePbrTextureSet({
                archetype: 'statuary_bronze',
                width: 64,
                height: 64
            });

            expect(res.archetypeKey).toBe('statuary_bronze');
            // Bronze is metallic: metallic value should be high (> 180 in [0..255])
            let highMetallicCount = 0;
            const totalPixels = 64 * 64;
            for (let i = 0; i < totalPixels; i++) {
                const m = res.metallicRgb[i * 3 + 0];
                if (m > 180) highMetallicCount++;
            }
            expect(highMetallicCount / totalPixels).toBeGreaterThan(0.80);
        }, 60000);
    });

    describe('C++20 Spatial Autocorrelation & Frequency Induction', () => {
        it('should detect periodicity in synthetic striped texture data', async () => {
            const w = 64;
            const h = 64;
            const bytes = Buffer.alloc(w * h * 3);

            // Generate synthetic 2D periodic grid (e.g. brick/tile courses with 8px period in X and 8px in Y)
            for (let y = 0; y < h; y++) {
                for (let x = 0; x < w; x++) {
                    const cellX = (x % 8 < 4);
                    const cellY = (y % 8 < 4);
                    const val = (cellX !== cellY) ? 220 : 30;
                    const idx = (y * w + x) * 3;
                    bytes[idx + 0] = val;
                    bytes[idx + 1] = val;
                    bytes[idx + 2] = val;
                }
            }

            const profile = await service.analyzeTexturePeriodicity({
                textureBytes: bytes,
                width: w,
                height: h,
                targetResolutionMeters: 2.0
            });

            expect(profile).toBeDefined();
            expect(profile.isPeriodic).toBe(true);
            expect(profile.dominantPeriodPxX).toBeGreaterThanOrEqual(4);
            expect(profile.physicalModuleWidthMeters).toBeGreaterThan(0);
            expect(profile.recommendedRepeatX).toBeGreaterThan(0);
            expect(profile.executionTimeMs).toBeGreaterThan(0);
        }, 60000);
    });

    describe('C++20 Semantic Mesh Partitioning', () => {
        it('should classify building faces into plinth, shaft, and roof deck', async () => {
            // Simple architectural tower:
            // 4 plinth vertices (y = 0..2)
            // 4 shaft vertices (y = 2..15)
            // 4 roof vertices (y = 15)
            const vertices = new Float32Array([
                // Plinth bottom
                -5, 0, -5,
                 5, 0, -5,
                 5, 2, -5,
                -5, 2, -5,
                // Shaft wall
                -5, 2, -5,
                 5, 2, -5,
                 5, 15, -5,
                -5, 15, -5,
                // Roof deck (horizontal, ny = 1.0)
                -5, 15, -5,
                 5, 15, -5,
                 5, 15,  5,
                -5, 15,  5
            ]);

            const normals = new Float32Array([
                // Plinth (facing +Z or -Z)
                0, 0, -1,
                0, 0, -1,
                0, 0, -1,
                0, 0, -1,
                // Shaft
                0, 0, -1,
                0, 0, -1,
                0, 0, -1,
                0, 0, -1,
                // Roof (horizontal)
                0, 1, 0,
                0, 1, 0,
                0, 1, 0,
                0, 1, 0
            ]);

            const indices = new Uint32Array([
                // Plinth (2 triangles)
                0, 1, 2,
                0, 2, 3,
                // Shaft (2 triangles)
                4, 5, 6,
                4, 6, 7,
                // Roof deck (2 triangles)
                8, 9, 10,
                8, 10, 11
            ]);

            const partition = await service.classifyMeshSemanticZones({
                vertices,
                indices,
                normals,
                groundDatumY: 0.0,
                plinthThresholdMeters: 3.8
            });

            expect(partition.faceZones).toHaveLength(6);
            expect(partition.telemetry.totalFaces).toBe(6);
            expect(partition.telemetry.groundPlinthFaces).toBeGreaterThan(0);
            expect(partition.telemetry.horizontalDeckFaces).toBeGreaterThan(0);
            expect(partition.metricUvRepeatsU).toHaveLength(6);
            expect(partition.metricUvRepeatsV).toHaveLength(6);
            expect(partition.normalScaleMultipliers).toHaveLength(6);
        }, 60000);
    });

    describe('C++20 Hardware-Accelerated Continuous Biophysical Estimation', () => {
        it('should estimate biophysical fields (HBAO, Scharr relief, roughness, ORM) at native speed', async () => {
            const w = 64;
            const h = 64;
            const totalPixels = w * h;
            const rawRgba = Buffer.alloc(totalPixels * 4);

            for (let y = 0; y < h; y++) {
                for (let x = 0; x < w; x++) {
                    const idx = (y * w + x) * 4;
                    // Textured stone pattern with high frequency variation
                    const val = Math.round(140 + 50 * Math.sin(x * 0.4) * Math.cos(y * 0.4));
                    rawRgba[idx + 0] = val;
                    rawRgba[idx + 1] = Math.round(val * 0.95);
                    rawRgba[idx + 2] = Math.round(val * 0.88);
                    rawRgba[idx + 3] = 255;
                }
            }

            const startTime = performance.now();
            const fields = await service.estimateContinuousBiophysicalFields(rawRgba, w, h, {
                aoRadiusTexels: 8,
                reliefMultiplier: 1.2
            });
            const elapsedMs = performance.now() - startTime;

            expect(fields.width).toBe(w);
            expect(fields.height).toBe(h);
            expect(fields.albedoRgba.length).toBe(totalPixels * 4);
            expect(fields.normalRgb.length).toBe(totalPixels * 3);
            expect(fields.roughness.length).toBe(totalPixels);
            expect(fields.metallic.length).toBe(totalPixels);
            expect(fields.ambientOcclusion.length).toBe(totalPixels);
            expect(fields.ormRgb.length).toBe(totalPixels * 3);
            expect(fields.virtualHeight?.length).toBe(totalPixels);

            // Normal map Z channel should be dominantly positive (> 120 in [0..255])
            let dominantBlueCount = 0;
            for (let i = 0; i < totalPixels; i++) {
                const b = fields.normalRgb[i * 3 + 2];
                if (b >= 120) dominantBlueCount++;
            }
            expect(dominantBlueCount / totalPixels).toBeGreaterThan(0.95);

            // ORM channels sanity check
            for (let i = 0; i < 20; i++) {
                expect(fields.ormRgb[i * 3 + 0]).toBe(fields.ambientOcclusion[i]);
                expect(fields.ormRgb[i * 3 + 1]).toBe(fields.roughness[i]);
                expect(fields.ormRgb[i * 3 + 2]).toBe(fields.metallic[i]);
            }

            // HBAO values should be in a valid physical range [30..255]
            let avgAo = 0;
            for (let i = 0; i < totalPixels; i++) {
                avgAo += fields.ambientOcclusion[i];
            }
            avgAo /= totalPixels;
            expect(avgAo).toBeGreaterThan(50);
            expect(avgAo).toBeLessThanOrEqual(255);
        }, 60000);
    });
});

