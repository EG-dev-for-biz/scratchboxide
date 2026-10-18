/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import { describe, it, expect } from 'vitest';
import { spawnSync } from 'child_process';
import {
    NativeMaterialPbrService,
    NativePbrSynthesisError,
    PbrUnknownArchetypeError,
    PBR_50_ARCHETYPE_CATALOG
} from '../src/node/3d-engine/native-material-pbr-service';
import { AdaptivePbrMaterialSpecError } from '../src/node/3d-engine/adaptive-pbr-errors';

/** The kernel is compiled with clang++ (or $CXX); without a compiler the native tests cannot run and say so. */
const HAS_CXX = spawnSync(process.env.CXX || 'clang++', ['--version'], { encoding: 'utf8' }).status === 0;
import type { ContinuousMaterialDescriptor } from '../src/common/adaptive-material-types';

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

        it('an unknown archetype is a typed error listing every valid key, never a default material', async () => {
            const err: any = (() => { try { service.resolveArchetype('unobtainium_foam'); } catch (e) { return e; } })();
            expect(err).toBeInstanceOf(PbrUnknownArchetypeError);
            expect(err).toBeInstanceOf(AdaptivePbrMaterialSpecError);
            expect(err.validArchetypes).toHaveLength(50);
            expect(err.message).toContain('indiana_limestone');
            expect(err.message).toContain('mossy_rock');
            expect(err.message).toMatch(/continuous descriptor/);
            // a fragment of several keys names them instead of picking one
            expect(() => service.resolveArchetype('glass')).toThrow(/part of \d+ keys: .*low_iron_glass/);
            expect(() => service.resolveArchetype(999)).toThrow(PbrUnknownArchetypeError);
            await expect(service.synthesizePbrTextureSet({ archetype: 'cor_ten_steel', width: 8, height: 8 })).rejects.toBeInstanceOf(PbrUnknownArchetypeError);
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

            // Measured, not a constant: the kernel's own process time is part of the total
            expect(res.synthesizer).toBe('native-cpp20');
            expect(res.timings.kernelMs).toBeGreaterThan(0);
            expect(res.executionTimeMs).toBeGreaterThanOrEqual(res.timings.kernelMs + res.timings.compileMs);
            expect(res.executionTimeMs).not.toBe(15);
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

    describe('the native kernel is the only synthesizer', () => {
        it.skipIf(!HAS_CXX)('runs under NODE_ENV=test too, and every descriptor field it is given changes the maps', async () => {
            expect(process.env.NODE_ENV).toBe('test');
            const base: ContinuousMaterialDescriptor = { albedoLinear: [0.6, 0.5, 0.4], conduction: 0, roughnessBaseline: 0.6, cellularWeight: 0, fissureDepth: 0.1, graininess: 0 };
            const a = await service.synthesizeContinuousManifoldPbr(base, { width: 64, height: 64, seed: 7 });
            expect(a.synthesizer).toBe('native-cpp20');
            const differs = (x: Buffer, y: Buffer) => !x.equals(y);
            for (const [field, value] of [['cellularWeight', 1], ['fissureDepth', 0.9], ['graininess', 1]] as const) {
                const b = await service.synthesizeContinuousManifoldPbr({ ...base, [field]: value }, { width: 64, height: 64, seed: 7 });
                expect(differs(a.heightRgb, b.heightRgb) || differs(a.albedoRgb, b.albedoRgb), `${field} has no effect on the maps`).toBe(true);
            }
            // same input, same seed: same maps
            const again = await service.synthesizeContinuousManifoldPbr(base, { width: 64, height: 64, seed: 7 });
            expect(again.albedoRgb.equals(a.albedoRgb)).toBe(true);
        }, 120000);

        it('a compile failure is a typed error carrying the compiler output; nothing is synthesized in its place', async () => {
            const failing = new NativeMaterialPbrService({ compileSource: async () => ({ success: false, compilerOutput: 'error: no member named foo', diagnostics: [] }) } as any);
            const err: any = await failing.synthesizeContinuousManifoldPbr({ albedoLinear: [0.5, 0.5, 0.5], conduction: 0, roughnessBaseline: 0.5 }, { width: 16, height: 16 }).catch(e => e);
            expect(err).toBeInstanceOf(NativePbrSynthesisError);
            expect(err.stage).toBe('compile');
            expect(err.message).toContain('no member named foo');
            const missing = new NativeMaterialPbrService({ compileSource: async () => { throw new Error('spawn clang++ ENOENT'); } } as any);
            await expect(missing.synthesizePbrTextureSet({ archetype: 'carrara_marble', width: 16, height: 16 })).rejects.toThrow(/could not be compiled.*ENOENT/);
        });

        it('a kernel that fails at run time is a typed error too', async () => {
            const broken = new NativeMaterialPbrService({ compileSource: async () => ({ success: true, binaryPath: '/usr/bin/false', compilerOutput: '', diagnostics: [] }) } as any);
            const err: any = await broken.synthesizeContinuousManifoldPbr({ albedoLinear: [0.5, 0.5, 0.5], conduction: 0, roughnessBaseline: 0.5 }, { width: 16, height: 16 }).catch(e => e);
            expect(err).toBeInstanceOf(NativePbrSynthesisError);
            expect(err.stage).toBe('run');
        });
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

    describe('Adaptive Domain Architecture (ADA) Continuous Manifold & Differential Fields', () => {
        it('should pass The Alien Planet Test: synthesize novel alien material without closed enums', async () => {
            // Novel material: Bioluminescent Xenolithic Basalt with Vitrified Methane Inclusions
            // Has no preset, no archetype ID, no closed taxonomy variant (ADA Pillar 1)
            const alienMaterial: ContinuousMaterialDescriptor = {
                albedoLinear: [0.08, 0.42, 0.36],
                secondaryAlbedo: [0.12, 0.88, 0.72],
                secondaryWeight: 0.38,
                conduction: 0.22,
                roughnessBaseline: 0.38,
                microPorosity: 0.65,
                normalStrength: 2.8,
                fissureScale: 12.0,
                fissureDepth: 0.45,
                fbmOctaves: 5.0,
                fbmGain: 0.55,
                cellularWeight: 0.50,
                graininess: 0.25,
                anisotropyStrength: 0.70,
                anisotropyAngleRad: 0.785, // 45 degrees
                aoStrength: 1.4
            };

            const startTime = performance.now();
            const res = await service.synthesizeContinuousManifoldPbr(alienMaterial, {
                width: 64,
                height: 64,
                seed: 999
            });
            const duration = performance.now() - startTime;

            expect(res.width).toBe(64);
            expect(res.height).toBe(64);
            expect(res.descriptor).toBe(alienMaterial);

            const expectedBytes = 64 * 64 * 3;
            expect(res.albedoRgb.length).toBe(expectedBytes);
            expect(res.normalRgb.length).toBe(expectedBytes);
            expect(res.roughnessRgb.length).toBe(expectedBytes);
            expect(res.metallicRgb.length).toBe(expectedBytes);
            expect(res.aoRgb.length).toBe(expectedBytes);
            expect(res.ormRgb.length).toBe(expectedBytes);
            expect(res.heightRgb.length).toBe(expectedBytes);

            // Verify normal map Z channel validity
            let dominantBlueCount = 0;
            const totalPixels = 64 * 64;
            for (let i = 0; i < totalPixels; i++) {
                if (res.normalRgb[i * 3 + 2] >= 120) dominantBlueCount++;
            }
            expect(dominantBlueCount / totalPixels).toBeGreaterThan(0.95);

            // Verify conduction reflected in metallic map
            let avgMetallic = 0;
            for (let i = 0; i < totalPixels; i++) {
                avgMetallic += res.metallicRgb[i * 3 + 0];
            }
            avgMetallic /= totalPixels;
            // 0.22 * 255 ~= 56
            expect(avgMetallic).toBeGreaterThan(30);
            expect(avgMetallic).toBeLessThan(90);
        }, 60000);

        it('should linearly interpolate two continuous descriptors (Continuous vs Discrete ADA Stress Test)', async () => {
            const marbleDesc = service.getAnchorDescriptor(4); // Carrara Marble (dielectric, smooth)
            const titaniumDesc = service.getAnchorDescriptor(20); // Titanium (metallic conductor, anisotropic)

            expect(marbleDesc.conduction).toBeLessThan(0.1);
            expect(titaniumDesc.conduction).toBeGreaterThan(0.9);

            // Lerp halfway (t = 0.5)
            const blended = service.lerpDescriptors(marbleDesc, titaniumDesc, 0.5);

            expect(blended.conduction).toBeCloseTo((marbleDesc.conduction + titaniumDesc.conduction) / 2, 2);
            expect(blended.roughnessBaseline).toBeCloseTo((marbleDesc.roughnessBaseline + titaniumDesc.roughnessBaseline) / 2, 2);
            expect(blended.anisotropyStrength).toBeCloseTo((marbleDesc.anisotropyStrength! + titaniumDesc.anisotropyStrength!) / 2, 2);

            // Synthesize blended material via synthesizePbrTextureSet with descriptor
            const res = await service.synthesizePbrTextureSet({
                descriptor: blended,
                width: 64,
                height: 64,
                seed: 123
            });

            expect(res.width).toBe(64);
            expect(res.albedoRgb.length).toBe(64 * 64 * 3);
            expect(res.ormRgba.length).toBe(64 * 64 * 4);
        }, 60000);

        it('should compute continuous spatial wavelength and spectral periodicity', async () => {
            const w = 64;
            const h = 64;
            const testImg = Buffer.alloc(w * h * 3);
            // 8px horizontal period: sin(2 * pi * x / 8)
            for (let y = 0; y < h; y++) {
                for (let x = 0; x < w; x++) {
                    const idx = (y * w + x) * 3;
                    const v = Math.round(128 + 100 * Math.sin((2 * Math.PI * x) / 8.0));
                    testImg[idx + 0] = v;
                    testImg[idx + 1] = v;
                    testImg[idx + 2] = v;
                }
            }

            const prof = await service.analyzeTexturePeriodicity({
                textureBytes: testImg,
                width: w,
                height: h,
                channels: 3,
                targetResolutionMeters: 2.0
            });

            expect(prof.dominantPeriodPxX).toBeGreaterThanOrEqual(6);
            expect(prof.dominantPeriodPxX).toBeLessThanOrEqual(10);
            expect(prof.spatialWavelengthMetersX).toBeDefined();
            expect(prof.spatialWavelengthMetersX).toBeGreaterThan(0.1);
            expect(prof.spatialWavelengthMetersX).toBeLessThan(0.5);
            expect(prof.spectralPeriodicityConfidence).toBeDefined();
            expect(prof.spectralPeriodicityConfidence).toBeGreaterThan(0.3);
        }, 60000);

        it('should evaluate continuous differential geometry fields on arbitrary 3D mesh', async () => {
            const vertices = new Float32Array([
                // Plinth (quad on XZ at ground Y=0..2)
                0, 0, 0,  1, 0, 0,  1, 2, 0,  0, 2, 0,
                // Shaft (quad on XZ at Y=2..10)
                0, 2, 0,  1, 2, 0,  1, 10, 0, 0, 10, 0,
                // Upper Deck (horizontal quad at Y=10)
                0, 10, 0, 1, 10, 0, 1, 10, 1, 0, 10, 1
            ]);
            const normals = new Float32Array([
                0, 0, 1,  0, 0, 1,  0, 0, 1,  0, 0, 1,
                0, 0, 1,  0, 0, 1,  0, 0, 1,  0, 0, 1,
                0, 1, 0,  0, 1, 0,  0, 1, 0,  0, 1, 0
            ]);
            const indices = new Uint32Array([
                0, 1, 2,  0, 2, 3,
                4, 5, 6,  4, 6, 7,
                8, 9, 10, 8, 10, 11
            ]);

            const partition = await service.classifyMeshSemanticZones({
                vertices,
                indices,
                normals,
                groundDatumY: 0.0,
                plinthThresholdMeters: 3.8
            });

            expect(partition.zenithCos).toBeDefined();
            expect(partition.zenithCos).toHaveLength(6);
            expect(partition.relativeElevation).toBeDefined();
            expect(partition.relativeElevation).toHaveLength(6);
            expect(partition.verticality).toBeDefined();
            expect(partition.verticality).toHaveLength(6);

            // Vertical walls: zenithCos ~= 0, verticality ~= 1
            expect(partition.zenithCos![0]).toBeCloseTo(0.0, 1);
            expect(partition.verticality![0]).toBeCloseTo(1.0, 1);

            // Horizontal deck: zenithCos ~= 1, verticality ~= 0
            expect(partition.zenithCos![4]).toBeCloseTo(1.0, 1);
            expect(partition.verticality![4]).toBeCloseTo(0.0, 1);

            // Relative elevation: plinth should be lower than deck
            expect(partition.relativeElevation![0]).toBeLessThan(partition.relativeElevation![4]);
        }, 60000);
    });
});

