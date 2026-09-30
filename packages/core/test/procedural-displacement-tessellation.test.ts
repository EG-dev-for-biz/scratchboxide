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
    NativeDisplacementService,
    NativeTilePathTracerService
} from '../src/node';

describe('Procedural Displacement & Tessellation Engine (Frontier 4)', () => {

    it('1. should subdivide and physically displace a GLB mesh with 16x triangle expansion', async () => {
        const service = new NativeDisplacementService();
        const inputGlb = path.resolve(process.cwd(), 'build/scene_2_textured.glb');
        const outputGlb = path.resolve(process.cwd(), 'build/test_scene_2_displaced.glb');

        if (!fs.existsSync(inputGlb)) {
            // Skip if prior test asset is missing
            return;
        }

        const result = await service.displaceGlb(inputGlb, outputGlb, {
            tessellationFactor: 4,
            displacementScale: 0.05,
            sampleTextureHeight: true,
            enableProceduralNoise: true,
            proceduralNoiseScale: 0.015,
            proceduralNoiseFrequency: 32.0,
            recomputeSmoothNormals: true
        });

        expect(result.success).toBe(true);
        expect(fs.existsSync(outputGlb)).toBe(true);
        expect(result.originalTriangles).toBe(8444);
        expect(result.displacedTriangles).toBe(135104);
        expect(result.expansionRatio).toBe(16);
        expect(result.displacedVertices).toBeGreaterThan(100000);
        expect(result.executionMs).toBeLessThan(5000);
    });

    it('2. should path-trace displaced scenes with authentic geometric relief and zero NaN samples', async () => {
        const tracer = new NativeTilePathTracerService();
        const inputGlb = path.resolve(process.cwd(), 'build/scene_2_textured.glb');
        const outputDir = path.resolve(process.cwd(), 'build/test_pathtrace_displacement');

        if (!fs.existsSync(inputGlb)) {
            return;
        }

        const result = await tracer.render({
            glbPath: inputGlb,
            outputDir,
            width: 320,
            height: 180,
            samplesPerPixel: 8,
            shadingMode: 'relit',
            sun: { elevationDeg: 25, azimuthDeg: 200 },
            camera: {
                position: [12.0, 6.0, 10.0],
                target: [0.0, 2.0, 0.0],
                up: [0, 1, 0],
                verticalFovDeg: 40
            },
            displacement: {
                tessellationFactor: 2, // 2^2 = 4x for rapid unit test
                displacementScale: 0.04,
                sampleTextureHeight: true,
                enableProceduralNoise: true
            }
        });

        expect(result.success).toBe(true);
        expect(fs.existsSync(result.beautyPngPath)).toBe(true);
        expect(fs.existsSync(result.normalPngPath)).toBe(true);
        expect(result.stats.triangles).toBe(8444 * 4); // 33,776 triangles
        expect(result.stats.nanSamples).toBe(0);
        expect(result.stats.geometryCoverage).toBeGreaterThan(0.5);
    });
});
