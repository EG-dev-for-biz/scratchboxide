/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import { describe, it, expect, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execSync } from 'child_process';
import {
    SbVeggieService,
    SmplTreeService,
    NativeCppCompilerService
} from '../src/node';
import { MissingInputError } from '../src/common/errors/pipeline-errors';
import { requireAll, requireAsset, requireAssets, withReason } from './helpers/requirements';

/**
 * A scan GLB for fitting: a lat-long ellipsoid canopy (centre `canopy`, radii `radii`) over a cylindrical trunk, with
 * vertex colours (green canopy, brown trunk) unless `colours` is false. Test data written here, not a canned asset.
 */
function writeScanGlb(file: string, canopy: [number, number, number], radii: [number, number, number], colours = true): void {
    const pos: number[] = [], col: number[] = [], idx: number[] = [];
    const grid = (rows: number, cols: number, at: (r: number, c: number) => [number, number, number], rgb: [number, number, number]) => {
        const base = pos.length / 3;
        for (let r = 0; r <= rows; r++) for (let c = 0; c <= cols; c++) { pos.push(...at(r, c)); col.push(...rgb, 1); }
        for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
            const a = base + r * (cols + 1) + c, b = a + 1, d = a + cols + 1, e = d + 1;
            idx.push(a, d, b, b, d, e);
        }
    };
    grid(24, 32, (r, c) => {
        const th = (r / 24) * Math.PI, ph = (c / 32) * 2 * Math.PI, wob = 0.2 * Math.sin(3 * ph) * Math.cos(4 * th);
        return [canopy[0] + (radii[0] + wob) * Math.sin(th) * Math.cos(ph), canopy[1] + (radii[1] + wob) * Math.cos(th), canopy[2] + (radii[2] + wob) * Math.sin(th) * Math.sin(ph)];
    }, [0.22, 0.4, 0.18]);
    const trunkTop = canopy[1] - radii[1] * 0.6;
    grid(8, 12, (r, c) => { const a = (c / 12) * 2 * Math.PI, y = (r / 8) * trunkTop; return [canopy[0] + 0.4 * Math.cos(a), y, canopy[2] + 0.4 * Math.sin(a)]; }, [0.28, 0.2, 0.14]);
    const P = Buffer.from(new Float32Array(pos).buffer), C = Buffer.from(new Float32Array(col).buffer), I = Buffer.from(new Uint32Array(idx).buffer);
    const lo = [0, 1, 2].map(k => Math.min(...pos.filter((_, i) => i % 3 === k))), hi = [0, 1, 2].map(k => Math.max(...pos.filter((_, i) => i % 3 === k)));
    const views = [{ buffer: 0, byteOffset: 0, byteLength: P.length }, { buffer: 0, byteOffset: P.length, byteLength: I.length }];
    const accessors: any[] = [
        { bufferView: 0, componentType: 5126, count: pos.length / 3, type: 'VEC3', min: lo, max: hi },
        { bufferView: 1, componentType: 5125, count: idx.length, type: 'SCALAR' }
    ];
    const attributes: any = { POSITION: 0 };
    let bin = Buffer.concat([P, I]);
    if (colours) {
        views.push({ buffer: 0, byteOffset: bin.length, byteLength: C.length });
        accessors.push({ bufferView: 2, componentType: 5126, count: col.length / 4, type: 'VEC4' });
        attributes.COLOR_0 = 2;
        bin = Buffer.concat([bin, C]);
    }
    const json = { asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0 }], meshes: [{ primitives: [{ attributes, indices: 1 }] }], accessors, bufferViews: views, buffers: [{ byteLength: bin.length }] };
    let j = Buffer.from(JSON.stringify(json));
    j = Buffer.concat([j, Buffer.alloc((4 - (j.length % 4)) % 4, 0x20)]);
    const head = Buffer.alloc(12);
    head.writeUInt32LE(0x46546c67, 0); head.writeUInt32LE(2, 4); head.writeUInt32LE(12 + 8 + j.length + 8 + bin.length, 8);
    const jh = Buffer.alloc(8); jh.writeUInt32LE(j.length, 0); jh.writeUInt32LE(0x4e4f534a, 4);
    const bh = Buffer.alloc(8); bh.writeUInt32LE(bin.length, 0); bh.writeUInt32LE(0x004e4942, 4);
    fs.writeFileSync(file, Buffer.concat([head, jh, j, bh, bin]));
}

// Real Google 3D Tile tree-blob capture (gitignored); the tests about it are skipped without it.
const REAL_BLOB = 'public/models/botanical_tests/real_tile_extracted_tree_blob.glb';
const realBlob = requireAsset(REAL_BLOB);
const REAL_FITTED_MODELS = [
    'public/models/smpl_real_data_fitted_summer.glb',
    'public/models/smpl_real_data_fitted_autumn.glb',
    'public/models/smpl_real_data_winter_manifold.glb',
    'public/models/smpl_real_data_side_by_side.glb',
    'public/models/smpl_real_data_ghost_overlay.glb'
];
const realBlobAndFits = requireAll(realBlob, requireAssets(REAL_FITTED_MODELS));

describe('SB-Veggie Parametric Botanical Synthesis & Inversion Engine (C++20 & Node.js)', () => {
    const service = new SbVeggieService();

    it('1. should verify native C++20 SB-Veggie canonical headers and legacy forwarders are accessible', () => {
        const compiler = new NativeCppCompilerService();
        const sdkInclude = compiler.getSdkIncludePath();
        expect(fs.existsSync(sdkInclude)).toBe(true);

        // Canonical SB-Veggie header
        const veggieHeaderPath = path.join(sdkInclude, 'scratchbox_sb_veggie.hpp');
        expect(fs.existsSync(veggieHeaderPath)).toBe(true);
        const veggieContent = fs.readFileSync(veggieHeaderPath, 'utf8');
        expect(veggieContent).toContain('namespace sb_veggie');
        expect(veggieContent).toContain('class SbVeggieModelBuilder');
        expect(veggieContent).toContain('class SbVeggieEvaluator');
        expect(veggieContent).toContain('struct SbVeggieTemplate');
        expect(veggieContent).toContain('struct SbVeggieParams');
        expect(veggieContent).toContain('enum class SbVeggieArchetype');

        // Canonical SB-Veggie Optimizer header
        const veggieOptHeaderPath = path.join(sdkInclude, 'scratchbox_sb_veggie_optimizer.hpp');
        expect(fs.existsSync(veggieOptHeaderPath)).toBe(true);
        const veggieOptContent = fs.readFileSync(veggieOptHeaderPath, 'utf8');
        expect(veggieOptContent).toContain('class SbVeggieOptimizer');
        expect(veggieOptContent).toContain('struct SbVeggieOptimizerOptions');
        expect(veggieOptContent).toContain('struct SbVeggieOptimizerResult');
        expect(veggieOptContent).toContain('evaluateChamferDistance');

        // Legacy forwarder headers
        const treeHeaderPath = path.join(sdkInclude, 'scratchbox_smpl_tree.hpp');
        expect(fs.existsSync(treeHeaderPath)).toBe(true);
        const treeContent = fs.readFileSync(treeHeaderPath, 'utf8');
        expect(treeContent).toContain('scratchbox_sb_veggie.hpp');

        const optHeaderPath = path.join(sdkInclude, 'scratchbox_smpl_optimizer.hpp');
        expect(fs.existsSync(optHeaderPath)).toBe(true);
        const optContent = fs.readFileSync(optHeaderPath, 'utf8');
        expect(optContent).toContain('scratchbox_sb_veggie_optimizer.hpp');
    });

    it('2. should compile native runner binary cleanly', async () => {
        const binPath = await service.ensureBinary();
        expect(fs.existsSync(binPath)).toBe(true);
    }, 300000); // clang -O3 over the engine headers; longer when another suite compiles at the same time

    it('3. should synthesize neutral canonical Decurrent Oak tree with valid glTF 2.0 binary', async () => {
        const result = await service.synthesizeTree({
            archetype: 'decurrent',
            phenology: {
                season: 1.0,
                generateLeaves: true
            }
        });

        expect(result.success).toBe(true);
        expect(result.glbBuffer).toBeDefined();
        expect(result.glbBuffer!.length).toBeGreaterThan(10000);

        // Verify standard glTF 2.0 magic number ('glTF')
        const magic = result.glbBuffer!.toString('utf8', 0, 4);
        expect(magic).toBe('glTF');

        expect(result.telemetry.outputVertices).toBeGreaterThan(500);
        expect(result.telemetry.outputTriangles).toBeGreaterThan(600);
        expect(result.telemetry.evalTimeMs).toBeGreaterThan(0);
        expect(result.telemetry.evalTimeMs).toBeLessThan(500); // Sub-0.5s for 360k-vert volumetric foliage generation

        if (fs.existsSync(result.outputGlbPath)) {
            fs.unlinkSync(result.outputGlbPath);
        }
    }, 30000);

    it('4. should morph tree shape via morphological parameters (beta)', async () => {
        // High DBH and high crown spread
        const resultMorphed = await service.synthesizeTree({
            archetype: 'decurrent',
            shape: {
                dbhCaliper: 1.5,
                crownSpread: 1.8,
                treeHeight: 0.8
            },
            phenology: {
                season: 1.0,
                generateLeaves: true
            }
        });

        expect(resultMorphed.success).toBe(true);
        expect(resultMorphed.glbBuffer).toBeDefined();
        expect(resultMorphed.telemetry.outputVertices).toBeGreaterThan(500);

        if (fs.existsSync(resultMorphed.outputGlbPath)) {
            fs.unlinkSync(resultMorphed.outputGlbPath);
        }
    }, 30000);

    it('5. should support seasonal winter defoliation (bare branches)', async () => {
        const resultWinter = await service.synthesizeTree({
            archetype: 'decurrent',
            phenology: {
                season: 0.0,
                generateLeaves: false
            }
        });

        expect(resultWinter.success).toBe(true);
        expect(resultWinter.glbBuffer).toBeDefined();

        // Without leaf cards, vertex count is strictly the watertight trunk/branches template (2568 verts, 4064 tris across 112 joints)
        expect(resultWinter.telemetry.outputVertices).toBe(2568);
        expect(resultWinter.telemetry.outputTriangles).toBe(4064);

        if (fs.existsSync(resultWinter.outputGlbPath)) {
            fs.unlinkSync(resultWinter.outputGlbPath);
        }
    }, 30000);

    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-veggie-fit-'));
    afterAll(() => fs.rmSync(scratch, { recursive: true, force: true }));

    it('6. fits the template to the vertex-coloured vegetation of a given scan', async () => {
        const scan = path.join(scratch, 'scan.glb');
        writeScanGlb(scan, [1.5, 6.5, -2], [3.6, 2.8, 3.4]);
        const out = path.join(scratch, 'fitted.glb');
        const resultFit = await service.fitScanToTree({ inputScanPath: scan, maxIterations: 12, outputGlbPath: out });

        expect(resultFit.success).toBe(true);
        expect(resultFit.stdout).toContain('Harvested vegetation anchor from scan: (1.5');
        const inv = resultFit.telemetry.inversion!;
        expect(inv.iterationsRun).toBeLessThanOrEqual(12);   // the requested iteration cap is honoured
        expect(inv.finalChamferMeters).toBeLessThan(inv.initialChamferMeters);
        expect(inv.fittedBeta.length).toBe(16);
        const buf = fs.readFileSync(out);
        expect(buf.toString('latin1', 0, 4)).toBe('glTF');
        expect(buf.readUInt32LE(8)).toBe(buf.length);
    }, 120000);

    it('6b. fails, and writes nothing, for a scan without vertex-coloured vegetation, a missing scan or no scan', async () => {
        const plain = path.join(scratch, 'plain.glb');
        writeScanGlb(plain, [0, 6.5, 0], [3.6, 2.8, 3.4], false);
        const out = path.join(scratch, 'never.glb');
        const colourless = await service.fitScanToTree({ inputScanPath: plain, outputGlbPath: out });
        expect(colourless.success).toBe(false);
        expect(colourless.stderr).toContain('has no vertex-coloured vegetation');
        expect(fs.existsSync(out)).toBe(false);

        const missing = await service.fitScanToTree({ inputScanPath: path.join(scratch, 'nope.glb'), outputGlbPath: out });
        expect(missing.success).toBe(false);
        expect(missing.stderr).toContain('scan not found');
        expect(fs.existsSync(out)).toBe(false);

        await expect(service.fitScanToTree({} as any)).rejects.toBeInstanceOf(MissingInputError);
    }, 120000);

    it.skipIf(!realBlobAndFits.ok)(withReason('7. should verify real Google 3D Tile tree blob inversion & canonical model generation', realBlobAndFits), async () => {
        const realBlobPath = path.resolve(process.cwd(), 'public/models/botanical_tests/real_tile_extracted_tree_blob.glb');
        expect(fs.existsSync(realBlobPath)).toBe(true);

        const realBlobStat = fs.statSync(realBlobPath);
        expect(realBlobStat.size).toBeGreaterThan(5000);

        // Verify all 5 real-scan fitted models were generated and have valid glTF headers
        const generatedModels = REAL_FITTED_MODELS;

        for (const relPath of generatedModels) {
            const absPath = path.resolve(process.cwd(), relPath);
            expect(fs.existsSync(absPath)).toBe(true);
            const stat = fs.statSync(absPath);
            expect(stat.size).toBeGreaterThan(50000);

            // Check glTF binary magic (0x46546C67 -> "glTF")
            const fd = fs.openSync(absPath, 'r');
            const magicBuf = Buffer.alloc(4);
            fs.readSync(fd, magicBuf, 0, 4, 0);
            fs.closeSync(fd);
            expect(magicBuf.toString('ascii')).toBe('glTF');
        }
    });

    it.skipIf(!realBlob.ok)(withReason('8. should solve 24-DOF Asymmetric Bough IK and reflect lopsided real-world canopy profile', realBlob), () => {
        const binPath = path.resolve(process.cwd(), 'build/run_sb_veggie');
        const realBlobPath = path.resolve(process.cwd(), 'public/models/botanical_tests/real_tile_extracted_tree_blob.glb');
        const testGlbPath = path.resolve(process.cwd(), 'build/test_asymmetric_ik.glb');

        const cmd = `"${binPath}" --fit-scan "${realBlobPath}" --output "${testGlbPath}"`;
        const stdout = execSync(cmd, { encoding: 'utf-8', timeout: 30000 });

        expect(stdout).toContain('Asymmetric Bough IK Scaffold Solution (8 Scaffolds):');
        expect(stdout).toContain('Scaffold 0:');
        expect(stdout).toContain('Scaffold 7:');
        expect(stdout).toContain('Error Reduction:');

        // Verify the lopsided profile: at least one bough extends (> 1.1x) and at least one bough contracts (< 0.9x)
        const reachMatches = [...stdout.matchAll(/Reach=([0-9.]+)x/g)].map(m => parseFloat(m[1]));
        expect(reachMatches.length).toBe(8);

        const hasExtension = reachMatches.some(r => r > 1.10);
        const hasContraction = reachMatches.some(r => r < 0.90);
        expect(hasExtension).toBe(true);
        expect(hasContraction).toBe(true);

        expect(fs.existsSync(testGlbPath)).toBe(true);
        const stat = fs.statSync(testGlbPath);
        expect(stat.size).toBeGreaterThan(100000);
        if (fs.existsSync(testGlbPath)) {
            fs.unlinkSync(testGlbPath);
        }
    });

    it.skipIf(!realBlob.ok)(withReason('9. should sample 3D Spatial Color Field from raw scan and ground botanical vertex colors', realBlob), () => {
        const binPath = path.resolve(process.cwd(), 'build/run_sb_veggie');
        const realBlobPath = path.resolve(process.cwd(), 'public/models/botanical_tests/real_tile_extracted_tree_blob.glb');
        const testColorGlb = path.resolve(process.cwd(), 'build/test_color_field_test.glb');

        const cmd = `"${binPath}" --fit-scan "${realBlobPath}" --color-influence 0.50 --output "${testColorGlb}"`;
        const stdout = execSync(cmd, { encoding: 'utf-8', timeout: 30000 });

        expect(stdout).toContain('Built 3D Spatial Color Field from scan');
        expect(stdout).toContain('weight=0.5');
        expect(fs.existsSync(testColorGlb)).toBe(true);
        expect(fs.statSync(testColorGlb).size).toBeGreaterThan(1000000);
        if (fs.existsSync(testColorGlb)) {
            fs.unlinkSync(testColorGlb);
        }
    });

    it('10. should verify SbVeggieService and backward-compatible SmplTreeService equivalence', () => {
        const veggie = new SbVeggieService();
        expect(veggie).toBeInstanceOf(SbVeggieService);
        expect(veggie).toBeInstanceOf(SmplTreeService);

        const smpl = new SmplTreeService();
        expect(smpl).toBeInstanceOf(SbVeggieService);
        expect(smpl).toBeInstanceOf(SmplTreeService);
    });
});

