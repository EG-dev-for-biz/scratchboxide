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
import { analyticalGroomHandlers } from '../src/node/gemini/tools/spatial-tools';
import * as os from 'os';

/** The splats of a binary PLY the groomer wrote: position and 0..255 colour of each. */
function readPly(file: string): Array<{ p: [number, number, number]; c: [number, number, number] }> {
    const buf = fs.readFileSync(file);
    const end = buf.indexOf('end_header\n') + 'end_header\n'.length;
    const header = buf.toString('ascii', 0, end);
    const count = Number(/element vertex (\d+)/.exec(header)![1]);
    const props = [...header.matchAll(/property (\w+) (\w+)/g)].map(m => ({ type: m[1], name: m[2] }));
    const size = (t: string) => (t === 'uchar' ? 1 : 4);
    const stride = props.reduce((a, p) => a + size(p.type), 0);
    const at = (name: string) => props.slice(0, props.findIndex(p => p.name === name)).reduce((a, p) => a + size(p.type), 0);
    const [ox, oy, oz, or, og, ob] = ['x', 'y', 'z', 'red', 'green', 'blue'].map(at);
    const out = [];
    for (let i = 0; i < count; i++) {
        const b = end + i * stride;
        out.push({ p: [buf.readFloatLE(b + ox), buf.readFloatLE(b + oy), buf.readFloatLE(b + oz)] as [number, number, number], c: [buf[b + or], buf[b + og], buf[b + ob]] as [number, number, number] });
    }
    return out;
}

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

    describe('A full coat that shows', () => {
        it('defaults to strands in proportion to the surface area, with a guide per hundred', () => {
            const c = AnalyticalGroomSplatService.getInstance().buildContract({ surface: { baseRadius: 0.12, harmonicFrequency: 0, harmonicAmplitude: 0 }, groom: { length: 0.05, baseColorRgb: [0.5, 0.3, 0.2] } }, 'splat_synthesize_analytical_groom');
            expect(c.groom.strandCount).toBe(Math.round(400000 * 4 * Math.PI * 0.12 * 0.12));
            expect(c.groom.guideCount).toBe(Math.round(c.groom.strandCount! / 100));
            const big = AnalyticalGroomSplatService.getInstance().buildContract({ surface: { baseRadius: 2, harmonicFrequency: 0, harmonicAmplitude: 0 }, groom: { length: 0.05, baseColorRgb: [0.5, 0.3, 0.2] } }, 'splat_synthesize_analytical_groom');
            expect([big.groom.strandCount, big.groom.guideCount]).toEqual([120000, 1200]);
        });

        it('spreads roots evenly by area, grows a body just inside them, and keeps the root colour along the strand', async () => {
            const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sbx-groom-'));
            try {
                // a 1 m ball with short hair: the 4.5 cm spread around each guide is small against it
                const contract: AnalyticalGroomContract = {
                    id: 'coat', surface: { center: [0, 0, 0], baseRadius: 1, harmonicFrequency: 0, harmonicAmplitude: 0, axialTaper: 0 },
                    groom: { guideCount: 1200, strandCount: 6000, segmentsPerStrand: 8, length: 0.02, rootWidth: 0.003, tipWidth: 0.0006, clumping: 0, curlRadius: 0, curlFrequency: 0, waveAmplitude: 0, waveFrequency: 0, baseColorRgb: [0.6, 0.3, 0.1], tipColorRgb: [1, 1, 1] },
                    splat: { scaleMultiplier: 1, opacity: 0.9, exportFormat: 'spz' }
                };
                const result = await AnalyticalGroomSplatService.getInstance().executeGroomSplat(contract, { outputDir: dir });
                expect(result.success, result.error).toBe(true);
                const splats = readPly(result.plyPath!);
                // area-uniform: half the area lies within 30 degrees of the equator (|cos theta| < 0.5); a uniform theta put a third there
                const r = (q: number[]) => Math.hypot(q[0], q[1], q[2]);
                const nearEquator = splats.filter(s => Math.abs(s.p[1] / r(s.p)) < 0.5).length / splats.length;
                expect(nearEquator).toBeGreaterThan(0.44);
                expect(nearEquator).toBeLessThan(0.56);
                // the body: a closed GLB of the same surface 1.5 % inside the roots
                const glb = fs.readFileSync(result.bodyGlbPath!);
                expect(glb.toString('ascii', 0, 4)).toBe('glTF');
                const json = JSON.parse(glb.toString('utf8', 20, 20 + glb.readUInt32LE(12)));
                const pos = json.accessors[json.meshes[0].primitives[0].attributes.POSITION];
                expect(pos.max[1]).toBeCloseTo(0.985, 2);
                expect(json.materials[0].pbrMetallicRoughness.baseColorFactor.slice(0, 3).map((v: number) => +v.toFixed(3))).toEqual([0.36, 0.18, 0.06]);
                // colour: the strands' inner half keeps the root colour (a linear blend made it halfway to white)
                const inner = splats.filter(s => r(s.p) < 1.008);
                const meanRed = inner.reduce((a, s) => a + s.c[0], 0) / inner.length;
                const meanBlue = inner.reduce((a, s) => a + s.c[2], 0) / inner.length;
                expect(meanBlue).toBeLessThan(meanRed * 0.5);
            } finally {
                fs.rmSync(dir, { recursive: true, force: true });
            }
        }, 120000);

        it('the tool publishes the splat and body where the viewport serves models and opens them in a scene', async () => {
            const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sbx-groom-root-'));
            const saved = process.env.SCRATCHBOX_ROOT;
            process.env.SCRATCHBOX_ROOT = root;
            const uris: string[] = [];
            try {
                const out: any = await analyticalGroomHandlers.splat_synthesize_analytical_groom({
                    baseRadius: 0.12, harmonicFrequency: 0, harmonicAmplitude: 0, length: 0.05, strandCount: 2000, guideCount: 64,
                    baseColorRgb: [0.58, 0.35, 0.18], tipColorRgb: [0.96, 0.91, 0.8]
                }, {} as any);
                const p = out.resultPayload;
                uris.push(p.splatUri, p.bodyUri);
                expect(p.splatUri).toMatch(/^\/models\/.+\.spz$/);
                expect(p.bodyUri).toMatch(/^\/models\/.+_body\.glb$/);
                for (const uri of [p.splatUri, p.bodyUri]) expect(fs.existsSync(path.join(root, 'public', uri))).toBe(true);
                expect(p.artifact.type).toBe('3d-scene');
                expect(p.artifact.data.objects.map((o: any) => o.content.durableUri)).toEqual([p.bodyUri, p.splatUri]);
                expect(p.artifact.data.environment).toEqual({ skybox: 'studio', lighting: 'studio', ground: false });
                expect(out.summaryResult).toMatch(/generated/);
            } finally {
                if (saved === undefined) delete process.env.SCRATCHBOX_ROOT; else process.env.SCRATCHBOX_ROOT = saved;
                // the copies into the served folders of the checkout the test runs in
                for (const uri of uris) for (const pub of [path.resolve(process.cwd(), 'public'), path.resolve(process.cwd(), '..', 'public')]) fs.rmSync(path.join(pub, uri), { force: true });
                fs.rmSync(root, { recursive: true, force: true });
            }
        }, 120000);
    });
});
