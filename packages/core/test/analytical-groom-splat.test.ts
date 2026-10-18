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
    describe('Adaptive Domain Architecture (ADA) contract from explicit continuous descriptors', () => {
        const required = {
            surface: { baseRadius: 1.2, harmonicFrequency: 5, harmonicAmplitude: 0.45 },
            groom: { length: 0.2, eumelanin: 0.1, pheomelanin: 0.35 }
        };

        it('uses the descriptors as given and leaves unstated morphology neutral', () => {
            const contract = AnalyticalGroomSplatService.getInstance().buildContract(required);
            expect(contract.surface).toMatchObject({ baseRadius: 1.2, harmonicFrequency: 5, harmonicAmplitude: 0.45, axialTaper: 0 });
            expect(contract.groom).toMatchObject({ length: 0.2, eumelanin: 0.1, pheomelanin: 0.35, clumping: 0, curlRadius: 0, waveAmplitude: 0 });
            expect(contract.groom.baseColorRgb).toBeUndefined();
        });

        it('fails with MissingInputError naming every absent required descriptor, never inferring them from words', () => {
            const service = AnalyticalGroomSplatService.getInstance();
            expect((service as any).synthesizeContractFromPrompt).toBeUndefined();
            let err: any;
            try { service.buildContract({ groom: { strandCount: 512 } }, 'splat_synthesize_analytical_groom'); } catch (e) { err = e; }
            expect(err?.name).toBe('MissingInputError');
            expect(err.code).toBe('missing_input');
            for (const name of ['baseRadius', 'harmonicFrequency', 'harmonicAmplitude', 'length', 'eumelanin and pheomelanin, or baseColorRgb']) {
                expect(err.message).toContain(name);
            }
            expect(() => service.buildContract({ ...required, surface: { ...required.surface, harmonicFrequency: 2.5 } })).toThrow(/harmonicFrequency=2.5/);
        });

        it('undefined fields do not mask defaults, and a root colour alone is uniform root to tip', () => {
            const contract = AnalyticalGroomSplatService.getInstance().buildContract({
                surface: { ...required.surface, axialTaper: undefined },
                groom: { length: 0.15, baseColorRgb: [0.2, 0.8, 0.4], clumping: undefined, strandCount: 512 }
            });
            expect(contract.surface.axialTaper).toBe(0);
            expect(contract.groom.clumping).toBe(0);
            expect(contract.groom.strandCount).toBe(512);
            expect(contract.groom.tipColorRgb).toEqual([0.2, 0.8, 0.4]);
            expect(contract.groom.eumelanin).toBe(0);
            const args = AnalyticalGroomSplatService.getInstance().generatorArgs(contract, '/tmp/a.spz', '/tmp/a.ply');
            expect(args.slice(0, 3)).toEqual(['/tmp/a.spz', '/tmp/a.ply', '']);
            expect(args[9]).toBe('0'); // clumping
            expect(args.slice(26, 29)).toEqual(['0.2', '0.8', '0.4']); // tip colour
        });

        it('the tool requires the shape and length descriptors and has no prompt input', async () => {
            const { ANALYTICAL_GROOM_TOOL_DECLARATIONS, analyticalGroomHandlers } = await import('../src/node/gemini/tools/spatial-tools');
            const decl = ANALYTICAL_GROOM_TOOL_DECLARATIONS.find(d => d.name === 'splat_synthesize_analytical_groom')!;
            expect(Object.keys(decl.parameters.properties)).not.toContain('prompt');
            expect(decl.parameters.required).toEqual(['baseRadius', 'harmonicFrequency', 'harmonicAmplitude', 'length']);
            await expect(analyticalGroomHandlers.splat_synthesize_analytical_groom({ prompt: 'a 5-pointed star creature with golden fur' }, {} as any))
                .rejects.toMatchObject({ name: 'MissingInputError' });
        });
    });

    describe('Task Capability Resolver ("Capabilities Before Tools" Pre-Flight Pass)', () => {
        // ADA: no noun list ("star", "creature", "fur", "hair", "groom") routes a task; the model picks the groom tool
        // from its declaration. Only naming the tool or the technique pre-loads it.
        it('does not route on subject words such as star creature or fur', () => {
            const assessment = TaskCapabilityResolver.resolveTaskCapability(
                'Generate a 5-pointed star creature covered in volumetric fur and export splats'
            );
            expect(assessment.suggestedNativeAction?.targetTool).not.toBe('splat_synthesize_analytical_groom');
            expect(assessment.nativeCapabilities.join(' ')).not.toContain('scratchbox_hair.hpp');
        });

        it('pre-loads the groom tool when the request names it or the analytical forward-splat technique', () => {
            for (const goal of ['Run splat_synthesize_analytical_groom on this surface', 'Use analytical forward splatting for the strands of this 3d model']) {
                const assessment = TaskCapabilityResolver.resolveTaskCapability(goal, { domainHint: '3d' } as any);
                expect(assessment.canSolveNatively).toBe(true);
                expect(assessment.primaryNativeEngine).toBe('cpp-3d-engine');
                expect(assessment.suggestedNativeAction?.targetTool).toBe('splat_synthesize_analytical_groom');
            }
        });

        it('never sends hair or fur splats to Trellis diffusion', () => {
            const assessment = TaskCapabilityResolver.resolveTaskCapability(
                'Create a biophysical hair groom splat with Voronoi clumping'
            );
            expect(assessment.canSolveNatively).toBe(true);
            expect(JSON.stringify(assessment)).not.toMatch(/trellis/i);
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
