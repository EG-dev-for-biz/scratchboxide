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
    UniversalTileDecompositionService,
    UtdraService,
    UldraService,
    NativeCppCompilerService
} from '../src/node';

describe('Universal Tile Decomposition & Rectification Algorithm (UTDRA / ULDRA) Codebase API', () => {
    const service = new UniversalTileDecompositionService();

    it('1. should verify native C++20 UTDRA headers and types are accessible', () => {
        const compiler = new NativeCppCompilerService();
        const sdkInclude = compiler.getSdkIncludePath();
        expect(fs.existsSync(sdkInclude)).toBe(true);

        const utdraHeader = path.join(sdkInclude, 'scratchbox_utdra.hpp');
        expect(fs.existsSync(utdraHeader)).toBe(true);

        const content = fs.readFileSync(utdraHeader, 'utf8');
        expect(content).toContain('namespace utdra');
        expect(content).toContain('enum class GeographicDomain');
        expect(content).toContain('struct GeographicDomainProbe');
        expect(content).toContain('class SutherlandHodgmanSlicer');
        expect(content).toContain('class MultiLevelVoidCarver');
        expect(content).toContain('class NaturalTerrainProcessor');
        expect(content).toContain('class UniversalTilePipeline');
    });

    it('2. should compile and ensure native runner binary exists', async () => {
        const binPath = await service.ensureBinary();
        expect(fs.existsSync(binPath)).toBe(true);
    });

    it('3. should probe and classify macro-domains across Urban, Suburban, Mountain and Forest', async () => {
        // A. Urban High-Rise Benchmark
        const urbanResult = await service.decomposeTile({
            benchmark: 'urban',
            mode: 'probe'
        });
        expect(urbanResult.success).toBe(true);
        expect(urbanResult.telemetry.dominantDomain).toBe('UrbanHighRiseCore');
        expect(urbanResult.telemetry.confidence).toBeGreaterThan(0.9);
        expect(urbanResult.telemetry.totalReliefDeltaY).toBeGreaterThanOrEqual(180);
        expect(urbanResult.telemetry.verticalityScore).toBeGreaterThanOrEqual(0.7);

        // B. Suburban Residential Benchmark
        const suburbanResult = await service.decomposeTile({
            benchmark: 'suburban',
            mode: 'probe'
        });
        expect(suburbanResult.success).toBe(true);
        expect(suburbanResult.telemetry.dominantDomain).toBe('SuburbanResidential');
        expect(suburbanResult.telemetry.confidence).toBeGreaterThan(0.85);
        expect(suburbanResult.telemetry.pitchedRoofRatio).toBeGreaterThan(0.2);

        // C. Mountain Alpine Benchmark
        const mountainResult = await service.decomposeTile({
            benchmark: 'mountain',
            mode: 'probe'
        });
        expect(mountainResult.success).toBe(true);
        expect(mountainResult.telemetry.dominantDomain).toBe('MountainAlpineCanyon');
        expect(mountainResult.telemetry.confidence).toBeGreaterThan(0.85);
        expect(mountainResult.telemetry.totalReliefDeltaY).toBeGreaterThan(150);

        // D. Forest Woodland Canopy Benchmark
        const forestResult = await service.decomposeTile({
            benchmark: 'forest',
            mode: 'probe'
        });
        expect(forestResult.success).toBe(true);
        expect(forestResult.telemetry.dominantDomain).toBe('ForestWoodlandCanopy');
        expect(forestResult.telemetry.confidence).toBeGreaterThan(0.85);
        expect(forestResult.telemetry.vegetationIndexNdvi).toBeGreaterThan(0.3);
    }, 45000);

    it('4. should execute non-destructive Sutherland-Hodgman elevation slicer', async () => {
        const result = await service.decomposeTile({
            benchmark: 'urban',
            mode: 'slicer',
            sliceElevationCutoff: 50.0
        });

        expect(result.success).toBe(true);
        expect(result.telemetry.outputTriangles).toBeGreaterThan(0);
        expect(result.glbBuffer).toBeDefined();

        // Verify valid binary glTF 2.0 output with 'glTF' magic header
        const magic = result.glbBuffer!.toString('utf8', 0, 4);
        expect(magic).toBe('glTF');

        if (fs.existsSync(result.outputGlbPath)) {
            fs.unlinkSync(result.outputGlbPath);
        }
    }, 45000);

    it('5. should carve false underpass curtain walls beneath bridges and viaducts', async () => {
        const result = await service.decomposeTile({
            benchmark: 'bridge',
            mode: 'bridge',
            minVoidHeightMeters: 3.5
        });

        expect(result.success).toBe(true);
        expect(result.telemetry.inputTriangles).toBe(2);
        // The vertical curtain wall triangle was excised, leaving only the horizontal bridge deck
        expect(result.telemetry.outputTriangles).toBe(1);
        expect(result.glbBuffer).toBeDefined();

        if (fs.existsSync(result.outputGlbPath)) {
            fs.unlinkSync(result.outputGlbPath);
        }
    }, 45000);

    it('6. should run end-to-end full universal decomposition pipeline with GLB emission', async () => {
        const result = await service.decomposeTile({
            benchmark: 'urban',
            mode: 'full'
        });

        expect(result.success).toBe(true);
        expect(result.telemetry.dominantDomain).toBe('UrbanHighRiseCore');
        expect(result.telemetry.outputTriangles).toBeGreaterThan(0);
        expect(result.telemetry.processingTimeMs).toBeGreaterThan(0);
        expect(result.telemetry.processingTimeMs).toBeLessThan(1000); // Sub-second C++20 execution

        expect(result.glbBuffer).toBeDefined();
        expect(result.glbBuffer!.length).toBeGreaterThan(5000);
        const magic = result.glbBuffer!.toString('utf8', 0, 4);
        expect(magic).toBe('glTF');

        if (fs.existsSync(result.outputGlbPath)) {
            fs.unlinkSync(result.outputGlbPath);
        }
    }, 45000);

    it('7. should verify UtdraService and UldraService aliases work identically', async () => {
        const utdraInstance = new UtdraService();
        const uldraInstance = new UldraService();

        expect(utdraInstance).toBeInstanceOf(UniversalTileDecompositionService);
        expect(uldraInstance).toBeInstanceOf(UniversalTileDecompositionService);

        const uldraResult = await uldraInstance.decomposeTile({
            benchmark: 'suburban',
            mode: 'probe'
        });
        expect(uldraResult.telemetry.dominantDomain).toBe('SuburbanResidential');

        if (fs.existsSync(uldraResult.outputGlbPath)) {
            fs.unlinkSync(uldraResult.outputGlbPath);
        }
    }, 45000);
});
