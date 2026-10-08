/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { FalTrellisService } from '../src/node/spatial/FalTrellisService';
import { MultiAngleTurnaroundService } from '../src/node/spatial/MultiAngleTurnaroundService';
import { GltfBinaryPacker } from '../src/node/3d-engine/gltf-binary-packer';

describe('FalTrellisService & MultiAngle Integration Test Suite', () => {
    const testDir = path.resolve(__dirname, 'tmp_fal_trellis_test');

    beforeEach(() => {
        fs.mkdirSync(testDir, { recursive: true });
    });

    afterEach(() => {
        if (fs.existsSync(testDir)) {
            fs.rmSync(testDir, { recursive: true, force: true });
        }
    });

    it('1. Initializes FalTrellisService with mock and configuration state', () => {
        const serviceMock = new FalTrellisService({ mockExecution: true });
        expect(serviceMock).toBeDefined();

        const serviceLive = new FalTrellisService({ falKey: 'test_fal_key_123', mockExecution: false });
        expect(serviceLive.isConfigured()).toBe(true);
    });

    it('2. Fails cleanly when no images or URLs are supplied', async () => {
        const service = new FalTrellisService({ mockExecution: true });
        const result = await service.generate3DFromImages({});
        expect(result.success).toBe(false);
        expect(result.error).toContain('No images provided');
    });

    it('3. Successfully generates mock 3D GLB mesh when mockExecution is enabled', async () => {
        const service = new FalTrellisService({ mockExecution: true });
        const destGlb = path.join(testDir, 'test_output.glb');

        const result = await service.generate3DFromImages({
            imageUrls: ['https://example.com/front.png', 'https://example.com/side.png'],
            destinationGlbPath: destGlb
        });

        expect(result.success).toBe(true);
        expect(result.modelGlbUrl).toBeDefined();
        expect(fs.existsSync(destGlb)).toBe(true);
        expect(fs.statSync(destGlb).size).toBeGreaterThan(0);
    });

    it('4. Correctly parses glTF 2.0 binary statistics from valid GLB buffer', () => {
        const service = new FalTrellisService({ mockExecution: true });
        const destGlb = path.join(testDir, 'triangle.glb');

        const gltfDoc = {
            asset: { version: '2.0', generator: 'TestGlbGenerator' },
            scenes: [{ nodes: [0] }],
            scene: 0,
            nodes: [{ mesh: 0, name: 'SingleTriangle' }],
            meshes: [{
                name: 'Mesh',
                primitives: [{
                    attributes: { POSITION: 0 },
                    indices: 1
                }]
            }],
            accessors: [
                { bufferView: 0, byteOffset: 0, componentType: 5126, count: 3, type: 'VEC3' },
                { bufferView: 1, byteOffset: 0, componentType: 5123, count: 3, type: 'SCALAR' }
            ],
            bufferViews: [
                { buffer: 0, byteOffset: 0, byteLength: 36, target: 34962 },
                { buffer: 0, byteOffset: 0, byteLength: 6, target: 34963 }
            ]
        };

        const posBuf = Buffer.alloc(36);
        const idxBuf = Buffer.alloc(6);
        const packResult = GltfBinaryPacker.writeGlb(destGlb, gltfDoc, [posBuf, idxBuf]);

        const stats = service.parseGlbStats(packResult.glbBuffer);
        expect(stats.magic).toBe('glTF');
        expect(stats.totalVertices).toBe(3);
        expect(stats.totalTriangles).toBe(1);
        expect(stats.generator).toBe('TestGlbGenerator');
        expect(stats.meshesCount).toBe(1);
    });

    it('5. Integrates end-to-end with MultiAngleTurnaroundService downstreamTarget="trellis-fal"', async () => {
        const turnaround = new MultiAngleTurnaroundService();
        const outputDir = path.join(testDir, 'turnaround_fal_test');

        const result = await turnaround.execute({
            subject: 'Cyberpunk hovercraft chassis with heavy dual thrusters',
            rigPreset: 'dcc-ortho-4',
            outputDir,
            mockExecution: true,
            downstreamTarget: 'trellis-fal',
            metricDimensions: {
                lengthMeters: 4.8,
                widthMeters: 2.1,
                heightMeters: 1.4
            }
        });

        expect(result.success).toBe(true);
        expect(result.downstreamGlb).toBeDefined();
        expect(result.downstreamGlb?.path).toBeDefined();
        expect(fs.existsSync(result.downstreamGlb!.path)).toBe(true);
        expect(result.downstreamGlb?.boundingBoxMeters).toEqual([4.8, 1.4, 2.1]);
    });
});
