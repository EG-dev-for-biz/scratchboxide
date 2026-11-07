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
import * as os from 'os';
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
        // the benchmark is four stacked boxes that cut through each other (open where they meet): the field remesh
        // follows that surface, so its quad share is lower than on a clean shell (see the torus case below)
        expect(result.metrics.pureQuadPercent).toBeGreaterThanOrEqual(75.0);
        expect(result.metrics.meanCornerOrthogonalityDeg).toBeGreaterThan(80.0);
        expect(result.metrics.meanCornerOrthogonalityDeg).toBeLessThan(100.0);
        expect(result.metrics.processingTimeMs).toBeGreaterThan(0);
        expect(result.metrics.processingTimeMs).toBeLessThan(120000);

        // Verify valid binary glTF 2.0 output with 'glTF' magic header
        expect(result.glbBuffer).toBeDefined();
        expect(result.glbBuffer!.length).toBeGreaterThan(1000);
        const magic = result.glbBuffer!.toString('utf8', 0, 4);
        expect(magic).toBe('glTF');

        expect(result.glbBase64).toBeDefined();
        expect(result.glbBase64!.length).toBeGreaterThan(1000);
    }, 180000);

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
        expect(reRemeshed.metrics.pureQuadRatio).toBeGreaterThanOrEqual(0.75);
        expect(reRemeshed.glbBuffer).toBeDefined();

        // Cleanup temporary test files
        if (fs.existsSync(initialResult.outputGlbPath)) {
            fs.unlinkSync(initialResult.outputGlbPath);
        }
        if (fs.existsSync(reRemeshed.outputGlbPath)) {
            fs.unlinkSync(reRemeshed.outputGlbPath);
        }
    }, 180000);

    it('4. remeshes a torus into quads with few irregular vertices (integer offsets closed by the flow)', async () => {
        const nu = 160, nv = 64, R = 1, r = 0.35;
        const positions: number[] = [], indices: number[] = [];
        for (let i = 0; i < nu; i++) for (let j = 0; j < nv; j++) {
            const u = (i / nu) * Math.PI * 2, v = (j / nv) * Math.PI * 2;
            positions.push((R + r * Math.cos(v)) * Math.cos(u), r * Math.sin(v), (R + r * Math.cos(v)) * Math.sin(u));
        }
        for (let i = 0; i < nu; i++) for (let j = 0; j < nv; j++) {
            const a = i * nv + j, b = ((i + 1) % nu) * nv + j, c = ((i + 1) % nu) * nv + ((j + 1) % nv), d = i * nv + ((j + 1) % nv);
            indices.push(a, c, b, a, d, c);
        }
        const pos = Buffer.from(new Float32Array(positions).buffer), idx = Buffer.from(new Uint32Array(indices).buffer);
        const json = JSON.stringify({
            asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0 }],
            meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1 }] }], buffers: [{ byteLength: pos.length + idx.length }],
            bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: pos.length }, { buffer: 0, byteOffset: pos.length, byteLength: idx.length }],
            accessors: [{ bufferView: 0, componentType: 5126, count: positions.length / 3, type: 'VEC3', min: [-1.35, -0.35, -1.35], max: [1.35, 0.35, 1.35] },
                { bufferView: 1, componentType: 5125, count: indices.length, type: 'SCALAR' }]
        });
        let text = json; while (text.length % 4) text += ' ';
        const jb = Buffer.from(text), bin = Buffer.concat([pos, idx]);
        const h = Buffer.alloc(12); h.writeUInt32LE(0x46546c67, 0); h.writeUInt32LE(2, 4); h.writeUInt32LE(28 + jb.length + bin.length, 8);
        const c0 = Buffer.alloc(8); c0.writeUInt32LE(jb.length, 0); c0.writeUInt32LE(0x4e4f534a, 4);
        const c1 = Buffer.alloc(8); c1.writeUInt32LE(bin.length, 0); c1.writeUInt32LE(0x004e4942, 4);
        const file = path.join(os.tmpdir(), `sb_torus_${Date.now()}.glb`);
        fs.writeFileSync(file, Buffer.concat([h, c0, jb, c1, bin]));
        const res = await service.remeshGlbFile(file, { targetQuadCount: 1500, alignToManhattanAxes: false, includeWireframe: false });
        expect(res.success).toBe(true);
        expect(res.metrics.outputQuads).toBeGreaterThan(1000);
        expect(res.metrics.pureQuadPercent).toBeGreaterThanOrEqual(95.0);
        // a torus needs no irregular vertex; the earlier grid extractor left 288 here, the flow-closed field about 50
        expect(res.metrics.singularitiesCount).toBeLessThan(0.08 * res.metrics.outputQuads);
        expect(res.metrics.meanSurfaceDeviationMm).toBeLessThan(30);
        fs.unlinkSync(file);
        if (fs.existsSync(res.outputGlbPath)) fs.unlinkSync(res.outputGlbPath);
    }, 180000);
});
