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
    FieldAlignedQuadRemeshService,
    NativeCppCompilerService
} from '../src/node';

describe('Instant Meshes Field-Aligned Quad Remeshing Codebase API', () => {
    const service = new FieldAlignedQuadRemeshService();

    it('1. should verify native C++20 field remesh headers are accessible', () => {
        const compiler = new NativeCppCompilerService();
        const sdkInclude = compiler.getSdkIncludePath();
        expect(fs.existsSync(sdkInclude)).toBe(true);

        const headerPath = path.join(sdkInclude, 'scratchbox_field_remesh.hpp');
        expect(fs.existsSync(headerPath)).toBe(true);

        const headerContent = fs.readFileSync(headerPath, 'utf8');
        expect(headerContent).toContain('namespace remesh');
        expect(headerContent).toContain('class FieldAlignedQuadRemesher');
        expect(headerContent).toContain('class FourRoSyFieldSolver');
        expect(headerContent).toContain('class PositionFieldOptimizer');
        expect(headerContent).toContain('class CreaseDetector');
        expect(headerContent).toContain('class QuadExtractor');
        expect(headerContent).toContain('class SurfaceProjector');
    });

    it('2. should verify native C++ CLI remesher compiles and executes with telemetry', async () => {
        const binPath = await service.ensureBinary();
        expect(fs.existsSync(binPath)).toBe(true);

        const result = await service.remeshMesh({
            targetQuadCount: 1500,
            creaseAngleDegrees: 35.0,
            alignToManhattanAxes: true,
            dominantYawDegrees: 0.0,
            includeWireframe: true
        });

        expect(result.success).toBe(true);
        expect(result.metrics.outputQuads).toBeGreaterThan(300);
        expect(result.metrics.pureQuadPercent).toBeGreaterThanOrEqual(95.0);
        expect(result.metrics.meanCornerOrthogonalityDeg).toBeGreaterThan(80.0);
        expect(result.metrics.meanCornerOrthogonalityDeg).toBeLessThan(100.0);
        expect(result.metrics.processingTimeMs).toBeGreaterThan(0);
        expect(result.metrics.processingTimeMs).toBeLessThan(2000);

        // Verify valid binary glTF 2.0 output with 'glTF' magic header
        expect(result.glbBuffer).toBeDefined();
        expect(result.glbBuffer!.length).toBeGreaterThan(1000);
        const magic = result.glbBuffer!.toString('utf8', 0, 4);
        expect(magic).toBe('glTF');

        expect(result.glbBase64).toBeDefined();
        expect(result.glbBase64!.length).toBeGreaterThan(1000);
    }, 45000);

    it('3. should remesh an existing GLB file on disk via remeshGlbFile API', async () => {
        // Use the output generated in test 2 as input to test file reading and remeshing
        const initialResult = await service.remeshMesh({
            targetQuadCount: 600,
            includeWireframe: false
        });

        expect(fs.existsSync(initialResult.outputGlbPath)).toBe(true);

        const reRemeshed = await service.remeshGlbFile(initialResult.outputGlbPath, {
            targetQuadCount: 800,
            alignToManhattanAxes: true,
            includeWireframe: true
        });

        expect(reRemeshed.success).toBe(true);
        expect(reRemeshed.metrics.inputTriangles).toBeGreaterThan(0);
        expect(reRemeshed.metrics.outputQuads).toBeGreaterThan(100);
        expect(reRemeshed.metrics.pureQuadRatio).toBeGreaterThanOrEqual(0.90);
        expect(reRemeshed.glbBuffer).toBeDefined();

        // Cleanup temporary test files
        if (fs.existsSync(initialResult.outputGlbPath)) {
            fs.unlinkSync(initialResult.outputGlbPath);
        }
        if (fs.existsSync(reRemeshed.outputGlbPath)) {
            fs.unlinkSync(reRemeshed.outputGlbPath);
        }
    }, 45000);
});
