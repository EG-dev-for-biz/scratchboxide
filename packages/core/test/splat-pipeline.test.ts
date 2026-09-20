/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as THREE from 'three';
import {
    SplatService,
    NativeCppCompilerService
} from '../src/node';
import { NativeSpatialBridge } from '../src/common/spatial/NativeSpatialBridge';
import { BakedGaussian } from '../src/common/geospatial-4d-protocol';
import { InHouseSplatViewer } from '../src/browser/generative-canvas/primitives/Scene3DPrimitive';

describe('3D Gaussian Splatting Pipeline (Native C++20, SPZ/Splat Codecs & Three.js Viewport)', () => {
    const service = new SplatService();
    const testDir = path.resolve(process.cwd(), 'build/test_splat_data');

    beforeAll(() => {
        if (!fs.existsSync(testDir)) {
            fs.mkdirSync(testDir, { recursive: true });
        }
    });

    afterAll(() => {
        if (fs.existsSync(testDir)) {
            fs.rmSync(testDir, { recursive: true, force: true });
        }
    });

    it('1. should verify native C++20 Splat SDK headers are accessible', () => {
        const compiler = new NativeCppCompilerService();
        const sdkInclude = compiler.getSdkIncludePath();
        expect(fs.existsSync(sdkInclude)).toBe(true);

        const headerPath = path.join(sdkInclude, 'scratchbox_spz.hpp');
        expect(fs.existsSync(headerPath)).toBe(true);

        const content = fs.readFileSync(headerPath, 'utf8');
        expect(content).toContain('namespace spz');
        expect(content).toContain('struct GaussianSplat');
        expect(content).toContain('class GzipCodec');
        expect(content).toContain('class SplatCodec');
        expect(content).toContain('class SpzCodec');
        expect(content).toContain('class SplatMeshBuilder');
        expect(content).toContain('buildSurfelMesh');
        expect(content).toContain('voxelize');
        expect(content).toContain('exportToGlb');
    });

    it('2. should verify master SDK header exposes sb::spz namespace alias', () => {
        const compiler = new NativeCppCompilerService();
        const masterHeader = path.join(compiler.getSdkIncludePath(), 'scratchbox_engine.hpp');
        const content = fs.readFileSync(masterHeader, 'utf8');
        expect(content).toContain('#include "scratchbox_spz.hpp"');
        expect(content).toContain('namespace spz = scratchbox::spz;');
    });

    it('3. should verify native CLI binary compiles and executes synthetic splat generation', async () => {
        const binPath = await service.ensureBinary();
        expect(fs.existsSync(binPath)).toBe(true);

        const outGlb = path.join(testDir, 'synthetic_splats.glb');
        const outSpz = path.join(testDir, 'synthetic_splats.spz');
        const outSplat = path.join(testDir, 'synthetic_splats.splat');

        const result = await service.runPipeline({
            syntheticCount: 500,
            outputGlbPath: outGlb,
            outputSpzPath: outSpz,
            outputSplatPath: outSplat
        });

        expect(result.success).toBe(true);
        expect(result.splatCount).toBe(500);

        // Verify output files exist and have non-zero size
        expect(fs.existsSync(outGlb)).toBe(true);
        expect(fs.existsSync(outSpz)).toBe(true);
        expect(fs.existsSync(outSplat)).toBe(true);

        expect(result.glbBytes).toBeGreaterThan(1000);
        expect(result.spzBytes).toBeGreaterThan(500);
        expect(result.splatBytes).toBe(500 * 32); // 32 bytes per splat

        // Verify SPZ compression efficiency: SPZ should be smaller than raw .splat
        expect(result.spzBytes!).toBeLessThan(result.splatBytes!);

        // Verify glTF 2.0 binary header
        const glbBuffer = fs.readFileSync(outGlb);
        const magic = glbBuffer.toString('utf8', 0, 4);
        expect(magic).toBe('glTF');
        const version = glbBuffer.readUInt32LE(4);
        expect(version).toBe(2);

        // Verify bounding box and centroid
        expect(result.bounds).toBeDefined();
        expect(result.centroid).toBeDefined();
    });

    it('4. should verify spatial voxelization downsamples point density', async () => {
        const outVoxelGlb = path.join(testDir, 'voxelized_splats.glb');
        const result = await service.runPipeline({
            syntheticCount: 800,
            outputGlbPath: outVoxelGlb,
            voxelizeLeafSize: 0.15
        });

        expect(result.success).toBe(true);
        // Voxelization should reduce number of splats from 800
        expect(result.splatCount).toBeLessThan(800);
        expect(result.splatCount).toBeGreaterThan(10);
        expect(fs.existsSync(outVoxelGlb)).toBe(true);
    });

    it('5. should round-trip parse and serialize .splat and .spz buffers in TypeScript', () => {
        const sampleGaussians: BakedGaussian[] = [
            {
                position: [1.25, -2.5, 3.75],
                scale: [0.05, 0.08, 0.02],
                quaternion: [0, 0, 0, 1],
                colorRgb: [255, 128, 64],
                opacity: 0.85
            },
            {
                position: [-0.5, 1.0, -1.5],
                scale: [0.1, 0.1, 0.1],
                quaternion: [0, 0.7071, 0, 0.7071],
                colorRgb: [32, 200, 255],
                opacity: 0.95
            }
        ];

        // 1. Splat Buffer Round-Trip
        const splatBuffer = SplatService.serializeSplatBuffer(sampleGaussians);
        expect(splatBuffer.byteLength).toBe(2 * 32);

        const parsedSplats = SplatService.parseSplatBuffer(splatBuffer);
        expect(parsedSplats.length).toBe(2);
        expect(parsedSplats[0].position[0]).toBeCloseTo(1.25, 2);
        expect(parsedSplats[0].position[1]).toBeCloseTo(-2.5, 2);
        expect(parsedSplats[0].position[2]).toBeCloseTo(3.75, 2);
        expect(parsedSplats[0].colorRgb[0]).toBe(255);
        expect(parsedSplats[0].colorRgb[1]).toBe(128);
        expect(parsedSplats[0].colorRgb[2]).toBe(64);
        expect(parsedSplats[0].opacity).toBeCloseTo(0.85, 1);

        // Also test NativeSpatialBridge.parseSplatBuffer
        const bridgeSplats = NativeSpatialBridge.parseSplatBuffer(splatBuffer);
        expect(bridgeSplats.length).toBe(2);
        expect(bridgeSplats[1].position[0]).toBeCloseTo(-0.5, 2);

        // 2. SPZ Buffer Round-Trip
        const spzBuffer = SplatService.serializeSpzBuffer(sampleGaussians);
        expect(spzBuffer.byteLength).toBeGreaterThan(16);

        const parsedSpz = SplatService.parseSpzBuffer(spzBuffer);
        expect(parsedSpz.length).toBe(2);
        expect(parsedSpz[0].position[0]).toBeCloseTo(1.25, 1);
        expect(parsedSpz[0].position[1]).toBeCloseTo(-2.5, 1);
        expect(parsedSpz[0].position[2]).toBeCloseTo(3.75, 1);
        expect(parsedSpz[0].colorRgb[0]).toBe(255);
        expect(parsedSpz[0].opacity).toBeCloseTo(0.85, 1);
    });

    it('6. should initialize InHouseSplatViewer with instanced quad geometry and update depth sort', () => {
        const viewer = new InHouseSplatViewer();
        expect(viewer.group).toBeDefined();

        const gaussians: BakedGaussian[] = [
            {
                position: [0, 0, 5],
                scale: [0.1, 0.1, 0.1],
                colorRgb: [255, 0, 0],
                opacity: 0.9
            },
            {
                position: [0, 0, 10],
                scale: [0.2, 0.2, 0.2],
                colorRgb: [0, 255, 0],
                opacity: 0.8
            },
            {
                position: [0, 0, 2],
                scale: [0.15, 0.15, 0.15],
                colorRgb: [0, 0, 255],
                opacity: 1.0
            }
        ];

        viewer.loadSplatObservation(gaussians);
        expect(viewer.group.children.length).toBe(1);

        const mesh = viewer.group.children[0] as THREE.Mesh;
        expect(mesh.isMesh).toBe(true);
        expect(mesh.geometry).toBeDefined();
        expect((mesh.geometry as any).instanceCount).toBe(3);

        // Test depth sorting on camera change
        const camera = new THREE.PerspectiveCamera(60, 1.0, 0.1, 100);
        camera.position.set(0, 0, 0);
        camera.lookAt(0, 0, 1);

        viewer.updateCamera(camera);

        // Move camera significantly to trigger re-sorting
        camera.position.set(0, 0, 15);
        camera.updateMatrixWorld();
        viewer.updateCamera(camera);

        viewer.dispose();
        expect(viewer.group.children.length).toBe(0);
    });
});
