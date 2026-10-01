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
    BotanicalVegetationService,
    NativeCppCompilerService
} from '../src/node';

describe('Unified Botanical & Vegetation Pipeline Codebase API (Stages 11-15)', () => {
    const service = new BotanicalVegetationService();

    it('1. should verify native C++20 botanical pipeline headers are accessible', () => {
        const compiler = new NativeCppCompilerService();
        const sdkInclude = compiler.getSdkIncludePath();
        expect(fs.existsSync(sdkInclude)).toBe(true);

        const headerPath = path.join(sdkInclude, 'scratchbox_botanical_pipeline.hpp');
        expect(fs.existsSync(headerPath)).toBe(true);

        const headerContent = fs.readFileSync(headerPath, 'utf8');
        expect(headerContent).toContain('namespace nature');
        expect(headerContent).toContain('class BotanicalSynthesisPipeline');
        expect(headerContent).toContain('struct BotanicalPipelineOptions');
        expect(headerContent).toContain('struct BotanicalPipelineTelemetry');
        expect(headerContent).toContain('struct BotanicalPipelineResult');
        expect(headerContent).toContain('enum class BotanicalPipelineMode');

        const natureHeader = path.join(sdkInclude, 'scratchbox_nature.hpp');
        const natureContent = fs.readFileSync(natureHeader, 'utf8');
        expect(natureContent).toContain('class SpaceColonizationTreeGenerator');
        expect(natureContent).toContain('class DetailedLeafGenerator');
        expect(natureContent).toContain('class TwigClusterGenerator');
        expect(natureContent).toContain('class IvyGrowthGenerator');
    });

    it('2. should synthesize conformal tree with lobed leaves & Da Vinci caliper telemetry', async () => {
        const binPath = await service.ensureBinary();
        expect(fs.existsSync(binPath)).toBe(true);

        const result = await service.synthesizeVegetation({
            mode: 'tree',
            leafMorphology: 'lobed',
            leafSize: 0.30,
            leafDensityScale: 1.0
        });

        expect(result.success).toBe(true);
        expect(result.telemetry.totalHeightMeters).toBeGreaterThan(4.0);
        expect(result.telemetry.baseCaliperCm).toBeGreaterThan(10.0);
        expect(result.telemetry.leavesPerTip).toBeGreaterThan(5);
        expect(result.telemetry.outputTriangles).toBeGreaterThan(10000);
        expect(result.telemetry.processingTimeMs).toBeGreaterThan(0);
        expect(result.telemetry.processingTimeMs).toBeLessThan(3000);

        // Verify valid binary glTF 2.0 output with 'glTF' magic header
        expect(result.glbBuffer).toBeDefined();
        expect(result.glbBuffer!.length).toBeGreaterThan(10000);
        const magic = result.glbBuffer!.toString('utf8', 0, 4);
        expect(magic).toBe('glTF');

        expect(result.glbBase64).toBeDefined();

        if (fs.existsSync(result.outputGlbPath)) {
            fs.unlinkSync(result.outputGlbPath);
        }
    }, 45000);

    it('3. should synthesize multi-stem shrub with serrated birch foliage', async () => {
        const result = await service.synthesizeVegetation({
            mode: 'shrub',
            leafMorphology: 'serrated',
            leafSize: 0.25,
            leafDensityScale: 0.8
        });

        expect(result.success).toBe(true);
        expect(result.telemetry.vegetationType).toContain('Shrub');
        expect(result.telemetry.outputTriangles).toBeGreaterThan(10000);
        expect(result.glbBuffer).toBeDefined();

        if (fs.existsSync(result.outputGlbPath)) {
            fs.unlinkSync(result.outputGlbPath);
        }
    }, 45000);

    it('4. should synthesize full rectified streetscape with tree collar and clinging ivy', async () => {
        const result = await service.synthesizeStreetscape(undefined, {
            leafMorphology: 'ovate',
            leafSize: 0.28,
            enableIvy: true
        });

        expect(result.success).toBe(true);
        expect(result.telemetry.mode).toBe('streetscape');
        expect(result.telemetry.outputVertices).toBeGreaterThan(50000);
        expect(result.telemetry.outputTriangles).toBeGreaterThan(50000);
        expect(result.glbBuffer).toBeDefined();
        expect(result.glbBuffer!.length).toBeGreaterThan(100000);

        if (fs.existsSync(result.outputGlbPath)) {
            fs.unlinkSync(result.outputGlbPath);
        }
    }, 60000);
});
