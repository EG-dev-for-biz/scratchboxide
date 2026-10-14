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
import { execSync } from 'child_process';
import {
    SbVeggieService,
    SmplTreeService,
    NativeCppCompilerService
} from '../src/node';
import { requireAll, requireAsset, requireAssets, withReason } from './helpers/requirements';

// Real Google 3D Tile tree-blob capture (gitignored). run_sb_veggie silently substitutes a synthetic noisy blob when
// --fit-scan points at a missing file (scripts/run_sb_veggie.cpp), so tests about the real scan must not run without it.
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
    }, 45000);

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

    it('6. should run SMPLify-Tree inversion to fit noisy scan blob in real-time', async () => {
        const resultFit = await service.fitScanToTree({
            archetype: 'decurrent',
            benchmarkFit: true,
            maxIterations: 20
        });

        expect(resultFit.success).toBe(true);
        expect(resultFit.telemetry.inversion).toBeDefined();

        const inv = resultFit.telemetry.inversion!;
        expect(inv.initialChamferMeters).toBeGreaterThan(0.8);
        expect(inv.finalChamferMeters).toBeLessThan(inv.initialChamferMeters);
        expect(inv.errorReductionPercent).toBeGreaterThan(10.0);
        expect(inv.solverRuntimeMs).toBeGreaterThan(0);
        expect(inv.solverRuntimeMs).toBeLessThan(5000); // Sub-5s budget under loaded test runner
        expect(inv.fittedBeta.length).toBe(16);

        if (fs.existsSync(resultFit.outputGlbPath)) {
            fs.unlinkSync(resultFit.outputGlbPath);
        }
    }, 30000);

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

