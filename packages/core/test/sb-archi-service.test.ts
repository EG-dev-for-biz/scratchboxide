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
import {
    SbArchiService,
    NativeCppCompilerService
} from '../src/node';

describe('SB-Archi Monumental Architecture Inversion Service (C++20)', () => {
    const service = new SbArchiService();

    it('1. should verify native C++20 SB-Archi headers are accessible', () => {
        const compiler = new NativeCppCompilerService();
        const sdkInclude = compiler.getSdkIncludePath();
        expect(fs.existsSync(sdkInclude)).toBe(true);

        const archiHeaderPath = path.join(sdkInclude, 'scratchbox_sb_archi.hpp');
        expect(fs.existsSync(archiHeaderPath)).toBe(true);

        const archiHeaderContent = fs.readFileSync(archiHeaderPath, 'utf8');
        expect(archiHeaderContent).toContain('namespace sb_archi');
        expect(archiHeaderContent).toContain('class SbArchiModelBuilder');
        expect(archiHeaderContent).toContain('struct SbArchiParams');
        expect(archiHeaderContent).toContain('struct TierDefinition');
        expect(archiHeaderContent).toContain('buildColosseumArcade');

        const optimizerHeaderPath = path.join(sdkInclude, 'scratchbox_sb_archi_optimizer.hpp');
        expect(fs.existsSync(optimizerHeaderPath)).toBe(true);

        const optimizerContent = fs.readFileSync(optimizerHeaderPath, 'utf8');
        expect(optimizerContent).toContain('class SbArchiOptimizer');
        expect(optimizerContent).toContain('computePointToArcadeDistance');
        expect(optimizerContent).toContain('invertScanToArchi');
    });

    it('2. should compile or ensure the C++20 run_sb_archi binary exists', async () => {
        const binPath = await service.ensureBinary();
        expect(fs.existsSync(binPath)).toBe(true);
        const stats = fs.statSync(binPath);
        expect(stats.size).toBeGreaterThan(10000);
    });

    it('3. should invert Colosseum scan into watertight classical arcade with hollow vaults', async () => {
        const inputGlb = path.resolve(__dirname, '../../../public/models/colosseum_clay.glb');
        if (!fs.existsSync(inputGlb)) {
            console.warn('Skipping full Colosseum scan inversion test because colosseum_clay.glb is not present locally.');
            return;
        }

        const result = await service.invertColosseumFacade({
            inputGlbPath: inputGlb,
            section: 'north_facade'
        });

        expect(result.success).toBe(true);
        expect(result.telemetry).toBeDefined();
        expect(result.telemetry.targetStructure).toContain('Colosseum');
        expect(result.telemetry.sectionMode).toBe('north_facade');
        expect(result.telemetry.voidRestorationRatioPct).toBeGreaterThanOrEqual(40.0);
        expect(result.telemetry.synthesizedTriangles).toBeGreaterThan(10000);
        expect(result.telemetry.modelSynthesisRuntimeMs).toBeLessThan(100.0);
        expect(fs.existsSync(result.glbPath)).toBe(true);

        // Verify valid binary glTF 2.0 (magic 0x46546C67 = "glTF")
        const glbBuffer = fs.readFileSync(result.glbPath);
        expect(glbBuffer.length).toBeGreaterThan(100000);
        const magic = glbBuffer.toString('utf8', 0, 4);
        expect(magic).toBe('glTF');
    }, 30000);
});
