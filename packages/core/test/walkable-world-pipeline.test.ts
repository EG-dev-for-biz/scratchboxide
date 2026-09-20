/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { describe, it, expect } from 'vitest';
import * as path from 'path';
import * as fs from 'fs-extra';
import { PanoramaDepthService } from '../src/node/spatial/PanoramaDepthService';
import { OffsetViewSynthesisService } from '../src/node/spatial/OffsetViewSynthesisService';
import { SplatService } from '../src/node/3d-engine/splat-service';

describe('Competitive 3DGS Walkable World Pipeline Integration Tests', () => {
    const testDir = path.resolve(process.cwd(), 'build/test_pipeline_output');

    it('1. should run end-to-end walkable world synthesis on synthetic panorama', async () => {
        // Setup synthetic panorama png
        const inputImg = path.resolve(process.cwd(), 'public/images/pantheon_atrium_360_4k.png');
        expect(await fs.pathExists(inputImg)).toBe(true);

        const depthService = new PanoramaDepthService();
        const offsetService = new OffsetViewSynthesisService();

        // Step 1: Geometry Extraction (Mock mode produces high-fidelity circular room model)
        console.log('[Test] Generating fallback depth map...');
        const depthRes = await depthService.generatePanoramaDepth(inputImg, {
            sceneType: 'outdoor',
            eyeHeight: 1.70,
            mock: true,
            outDir: testDir
        });

        expect(depthRes.success).toBe(true);
        expect(await fs.pathExists(depthRes.depthPath)).toBe(true);
        expect(await fs.pathExists(depthRes.previewPath)).toBe(true);
        expect(depthRes.width).toBe(4096);
        expect(depthRes.height).toBe(2048);

        // Step 2: Multi-perspective disocclusion offset view synthesis (Mock mode bypasses real Vertex AI billing)
        console.log('[Test] Running offset view synthesis disocclusion fill...');
        const synthesisRes = await offsetService.synthesizeOffsetViews(inputImg, depthRes.depthPath, {
            radius: 1.25,
            numPoses: 2, // run on 2 poses for faster TDD tests
            eyeHeight: 1.70,
            voxelSize: 0.05,
            skipOffsets: false,
            mockExecution: true,
            outDir: testDir,
            sceneType: 'outdoor'
        });

        expect(synthesisRes.success).toBe(true);
        expect(await fs.pathExists(synthesisRes.fusedSplatPath)).toBe(true);
        expect(await fs.pathExists(synthesisRes.fusedSpzPath)).toBe(true);

        // Verify that disocclusion fill successfully compiled fused splats
        expect(synthesisRes.numFusedSplats).toBeGreaterThan(1000);
        
        // Ensure our newly generated SPZ files are successfully decompressed using our updated planar NGSP parser
        const spzBuf = await fs.readFile(synthesisRes.fusedSpzPath);
        const parsedGaussians = SplatService.parseSpzBuffer(spzBuf);
        expect(parsedGaussians.length).toBe(synthesisRes.numFusedSplats);

        // Cross-decode: a file written by the C++ NGSP encoder must decode in TS to metric-scale positions.
        // (Guards against header layout drift between scratchbox_spz.hpp and splat-service.ts.)
        const originalSpzPath = synthesisRes.originalSplatPath.replace(/\.splat$/, '.spz');
        expect(await fs.pathExists(originalSpzPath)).toBe(true);
        const cppSpz = SplatService.parseSpzBuffer(await fs.readFile(originalSpzPath));
        expect(cppSpz.length).toBe(synthesisRes.numOriginalSplats);
        let maxAbs = 0;
        for (const g of cppSpz) {
            for (const c of g.position) maxAbs = Math.max(maxAbs, Math.abs(c));
        }
        expect(maxAbs).toBeGreaterThan(1.0);
        expect(maxAbs).toBeLessThan(200.0);

        // Sidecar contract: viewers place the camera at the capture height recorded here
        expect(await fs.pathExists(synthesisRes.metaPath)).toBe(true);
        const meta = await fs.readJson(synthesisRes.metaPath);
        expect(meta.eyeHeight).toBeCloseTo(1.70, 2);
        expect(meta.walkRadius).toBeCloseTo(1.25, 2);
        expect(meta.numSplats).toBe(synthesisRes.numFusedSplats);
        expect(depthRes.eyeHeightInferred).toBe(false); // mock geometry is built at a fixed height
        
        // Clean up test intermediates
        if (await fs.pathExists(testDir)) {
            await fs.remove(testDir);
        }
    }, 120000); // Allow 2 minutes for end-to-end C++ compilation and execution
});
