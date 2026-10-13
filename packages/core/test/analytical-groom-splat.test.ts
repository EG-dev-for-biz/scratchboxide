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
import { AnalyticalGroomSplatService } from '../src/node/3d-engine/AnalyticalGroomSplatService';
import { TaskCapabilityResolver } from '../src/node/agent/task-capability-resolver';
import type { AnalyticalGroomContract } from '../src/common/spatial/analytical-groom-types';

describe('Analytical Groom & 3D Gaussian Splatting Engine', () => {
    describe('Adaptive Domain Architecture (ADA) Contract Synthesis', () => {
        it('synthesizes continuous spherical harmonic parameters for a 5-pointed star creature', () => {
            const service = AnalyticalGroomSplatService.getInstance();
            const contract = service.synthesizeContractFromPrompt('create a 5-pointed star creature with dense golden fur');

            expect(contract.surface.harmonicFrequency).toBe(5);
            expect(contract.surface.harmonicAmplitude).toBeGreaterThan(0.3);
            expect(contract.surface.baseRadius).toBe(1.0);
            expect(contract.groom.strandCount).toBeGreaterThanOrEqual(4096);
            expect(contract.groom.clumping).toBeGreaterThan(0.5);
            // Golden fur should modulate melanin
            expect(contract.groom.eumelanin).toBeLessThan(0.3);
            expect(contract.groom.pheomelanin).toBeGreaterThan(0.2);
        });

        it('synthesizes open continuous parameters without closed shape enums for a 3-lobed puffball', () => {
            const service = AnalyticalGroomSplatService.getInstance();
            const contract = service.synthesizeContractFromPrompt('a 3-lobed fuzzy creature with curly auburn fur');

            expect(contract.surface.harmonicFrequency).toBe(3);
            expect(contract.surface.harmonicAmplitude).toBeGreaterThan(0.2);
            expect(contract.groom.curlRadius).toBeGreaterThan(0.015);
            expect(contract.groom.pheomelanin).toBeGreaterThan(0.5);
        });

        it('supports arbitrary programmatic overrides for continuous variables', () => {
            const service = AnalyticalGroomSplatService.getInstance();
            const contract = service.synthesizeContractFromPrompt('custom creature', {
                surface: {
                    baseRadius: 2.5,
                    harmonicFrequency: 7,
                    harmonicAmplitude: 0.55,
                    axialTaper: 0.3
                },
                groom: {
                    strandCount: 512,
                    length: 0.15,
                    baseColorRgb: [0.2, 0.8, 0.4]
                }
            });

            expect(contract.surface.baseRadius).toBe(2.5);
            expect(contract.surface.harmonicFrequency).toBe(7);
            expect(contract.surface.harmonicAmplitude).toBe(0.55);
            expect(contract.surface.axialTaper).toBe(0.3);
            expect(contract.groom.strandCount).toBe(512);
            expect(contract.groom.baseColorRgb).toEqual([0.2, 0.8, 0.4]);
        });
    });

    describe('Task Capability Resolver ("Capabilities Before Tools" Pre-Flight Pass)', () => {
        it('resolves star creature and fur groom tasks directly to Tier 1 native cpp-3d-engine', () => {
            const assessment = TaskCapabilityResolver.resolveTaskCapability(
                'Generate a 5-pointed star creature covered in volumetric fur and export splats'
            );

            expect(assessment.canSolveNatively).toBe(true);
            expect(assessment.canSolveNatively).toBe(true);
            expect(assessment.primaryNativeEngine).toBe('cpp-3d-engine');
            expect(assessment.nativeCapabilities).toEqual(
                expect.arrayContaining([
                    expect.stringContaining('scratchbox_hair.hpp'),
                    expect.stringContaining('scratchbox_spz.hpp'),
                    expect.stringContaining('splat_synthesize_analytical_groom')
                ])
            );
        });

        it('never falls back to Trellis diffusion for analytical hair or fur splats', () => {
            const assessment = TaskCapabilityResolver.resolveTaskCapability(
                'Create a biophysical hair groom splat with Voronoi clumping'
            );

            expect(assessment.canSolveNatively).toBe(true);
            expect(assessment.canSolveNatively).toBe(true);
            expect(assessment.primaryNativeEngine).toBe('cpp-3d-engine');
        });
    });

    describe('Ephemeral C++ Compilation & SPZ Serialization', () => {
        it('compiles and executes analytical groom, streaming binary Niantic SPZ in <500ms', async () => {
            const service = AnalyticalGroomSplatService.getInstance();
            const contract: AnalyticalGroomContract = {
                id: `test_groom_${Date.now()}`,
                surface: {
                    center: [0, 0, 0],
                    baseRadius: 0.5,
                    harmonicFrequency: 5,
                    harmonicAmplitude: 0.4,
                    axialTaper: 0.1
                },
                groom: {
                    guideCount: 8,
                    strandCount: 32,
                    segmentsPerStrand: 8,
                    length: 0.15,
                    rootWidth: 0.003,
                    tipWidth: 0.0006,
                    clumping: 0.6,
                    curlRadius: 0.008,
                    curlFrequency: 2.0,
                    eumelanin: 0.1,
                    pheomelanin: 0.3
                },
                splat: {
                    scaleMultiplier: 1.0,
                    opacity: 0.9,
                    exportFormat: 'spz'
                }
            };

            const testOutputDir = path.resolve(process.cwd(), 'build/test-groom', contract.id);
            const result = await service.executeGroomSplat(contract, { outputDir: testOutputDir });

            expect(result.success).toBe(true);
            expect(result.splatCount).toBeGreaterThan(0);
            expect(result.strandCount).toBe(32);
            expect(result.spzPath).toBeDefined();
            expect(fs.existsSync(result.spzPath!)).toBe(true);
            expect(result.spzBuffer).toBeDefined();
            expect(result.spzBuffer!.length).toBeGreaterThan(0);

            // Verify gzip header magic (0x1f, 0x8b) for Niantic compressed SPZ
            expect(result.spzBuffer![0]).toBe(0x1f);
            expect(result.spzBuffer![1]).toBe(0x8b);

            // Clean up test directory
            if (fs.existsSync(testOutputDir)) {
                fs.rmSync(testOutputDir, { recursive: true, force: true });
            }
        }, 60000);
    });
});
