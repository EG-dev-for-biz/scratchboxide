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
import * as os from 'os';
import { FalTrellisService } from '../src/node/spatial/FalTrellisService';
import { MultiAngleTurnaroundService } from '../src/node/spatial/MultiAngleTurnaroundService';
import { GltfBinaryPacker } from '../src/node/3d-engine/gltf-binary-packer';
import { MissingInputError } from '../src/common/errors/pipeline-errors';
import { encodePng } from '../src/node/texture-processing';

describe('FalTrellisService & MultiAngle Integration Test Suite', () => {
    // Per-test temp dir outside the repo (was packages/core/test/tmp_fal_trellis_test).
    let testDir = '';

    beforeEach(() => {
        testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sbx-fal-trellis-'));
    });

    afterEach(() => {
        if (fs.existsSync(testDir)) {
            fs.rmSync(testDir, { recursive: true, force: true });
        }
    });

    it('1. Reports whether a Fal key is configured', () => {
        const serviceLive = new FalTrellisService({ falKey: 'test_fal_key_123' });
        expect(serviceLive.isConfigured()).toBe(true);
    });

    it('2. Throws MissingInputError when no images or URLs are supplied, or an image path does not exist', async () => {
        const service = new FalTrellisService({ falKey: 'test_fal_key_123' });
        await expect(service.generate3DFromImages({})).rejects.toBeInstanceOf(MissingInputError);
        await expect(service.generate3DFromImages({ imagePaths: [path.join(testDir, 'missing.png')] }))
            .rejects.toThrow('missing.png does not exist');
    });

    it('3. Without a FAL_KEY it throws a MissingInputError and writes no GLB (no stand-in mesh)', async () => {
        const savedKey = process.env.FAL_KEY;
        const savedCwd = process.cwd();
        delete process.env.FAL_KEY;
        process.chdir(testDir); // no .env with a FAL_KEY here
        try {
            const service = new FalTrellisService();
            expect(service.isConfigured()).toBe(false);
            const destGlb = path.join(testDir, 'test_output.glb');
            const failed = await service.generate3DFromImages({
                imageUrls: ['https://example.com/front.png', 'https://example.com/side.png'],
                destinationGlbPath: destGlb
            }).catch((e: Error) => e);
            expect(failed).toBeInstanceOf(MissingInputError);
            expect((failed as MissingInputError).arg).toBe('FAL_KEY');
            expect(fs.existsSync(destGlb)).toBe(false);
            await expect(service.uploadToFalStorage(Buffer.from('png'))).rejects.toBeInstanceOf(MissingInputError);
        } finally {
            process.chdir(savedCwd);
            if (savedKey !== undefined) process.env.FAL_KEY = savedKey;
        }
    });

    it('4. Correctly parses glTF 2.0 binary statistics from valid GLB buffer', () => {
        const service = new FalTrellisService({ falKey: 'test_fal_key_123' });
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

    /** A fake image client (no network) that answers every view with a small PNG. */
    const imageClient = {
        models: {
            generateContent: async () => ({
                candidates: [{ content: { parts: [{ inlineData: { data: encodePng(8, 8, Buffer.alloc(8 * 8 * 4, 128)).toString('base64'), mimeType: 'image/png' } }] } }]
            })
        }
    };

    it('5. Integrates end-to-end with MultiAngleTurnaroundService downstreamTarget="trellis-fal": the GLB is reported with its measured extent', async () => {
        const outputDir = path.join(testDir, 'turnaround_fal_test');
        const sent: string[][] = [];
        // A fake Trellis that writes a real one-triangle GLB with POSITION bounds 4.8 x 1.4 x 2.1.
        const trellis = {
            async generate3DFromImages(input: any) {
                sent.push(input.imagePaths);
                const positions = Buffer.alloc(36);
                [0, 0, 0, 4.8, 0, 0, 0, 1.4, 2.1].forEach((v, i) => positions.writeFloatLE(v, i * 4));
                const packed = GltfBinaryPacker.writeGlb(input.destinationGlbPath, {
                    asset: { version: '2.0' },
                    scenes: [{ nodes: [0] }], scene: 0, nodes: [{ mesh: 0 }],
                    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1 }] }],
                    accessors: [
                        { bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [0, 0, 0], max: [4.8, 1.4, 2.1] },
                        { bufferView: 1, componentType: 5123, count: 3, type: 'SCALAR' }
                    ],
                    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 36 }, { buffer: 0, byteOffset: 36, byteLength: 6 }]
                }, [positions, Buffer.from([0, 0, 1, 0, 2, 0])]);
                return { success: true, localGlbPath: input.destinationGlbPath, stats: new FalTrellisService({ falKey: 'k' }).parseGlbStats(packed.glbBuffer) };
            }
        };
        const turnaround = new MultiAngleTurnaroundService({ createClient: async () => imageClient, trellis });

        const result = await turnaround.execute({
            subject: 'Cyberpunk hovercraft chassis with heavy dual thrusters',
            rigPreset: 'dcc-ortho-4',
            outputDir,
            downstreamTarget: 'trellis-fal',
            metricDimensions: {
                lengthMeters: 4.8,
                widthMeters: 2.1,
                heightMeters: 1.4
            }
        });

        expect(result.success).toBe(true);
        expect(sent).toHaveLength(1);
        expect(sent[0]).toEqual(result.views.map(v => v.imagePath));
        expect(result.downstreamGlb).toBeDefined();
        expect(fs.existsSync(result.downstreamGlb!.path)).toBe(true);
        expect(result.downstreamGlb!.vertexCount).toBe(3);
        expect(result.downstreamGlb!.measuredExtent!.map(v => Number(v.toFixed(3)))).toEqual([4.8, 1.4, 2.1]);
        expect(result.downstreamGlb!.requestedDimensionsMeters).toEqual({ lengthMeters: 4.8, widthMeters: 2.1, heightMeters: 1.4 });
    });

    it('6. A Trellis reconstruction that is asked for but cannot run fails the turnaround (no GLB-less success)', async () => {
        const savedKey = process.env.FAL_KEY;
        const savedCwd = process.cwd();
        delete process.env.FAL_KEY;
        process.chdir(testDir);
        try {
            const turnaround = new MultiAngleTurnaroundService({ createClient: async () => imageClient });
            await expect(turnaround.execute({ subject: 'hovercraft', outputDir: path.join(testDir, 'nokey'), downstreamTarget: 'trellis-fal' }))
                .rejects.toBeInstanceOf(MissingInputError);
        } finally {
            process.chdir(savedCwd);
            if (savedKey !== undefined) process.env.FAL_KEY = savedKey;
        }
    });
});
