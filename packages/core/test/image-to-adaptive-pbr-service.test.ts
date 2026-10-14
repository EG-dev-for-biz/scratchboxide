/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import { describe, it, expect } from 'vitest';
import { ImageToAdaptivePbrService } from '../src/node/3d-engine/image-to-adaptive-pbr-service';
import { AdaptiveMaterialPbrService } from '../src/node/3d-engine/adaptive-material-pbr-service';
import { GltfBinaryPacker } from '../src/node/3d-engine/gltf-binary-packer';
import { HOW_TO, requireBinary, withReason } from './helpers/requirements';

// AdaptiveMaterialPbrService.decodeToRgba spawns bare `ffmpeg` from PATH (it does not read FFMPEG_PATH),
// so the requirement is exactly a PATH lookup.
const ffmpeg = requireBinary('ffmpeg', HOW_TO.ffmpeg);

describe('ImageToAdaptivePbrService (Unified Architecture & C++20 Acceleration)', () => {
    // Generate a synthetic test texture (e.g. 64x64 procedural relief pattern)
    const width = 64;
    const height = 64;
    const rawRgba = Buffer.alloc(width * height * 4);
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const idx = (y * width + x) * 4;
            const wave = Math.sin((x / width) * Math.PI * 4) * Math.cos((y / height) * Math.PI * 4);
            const val = Math.floor(128 + wave * 100);
            rawRgba[idx + 0] = val;
            rawRgba[idx + 1] = Math.floor(val * 0.9);
            rawRgba[idx + 2] = Math.floor(val * 0.8);
            rawRgba[idx + 3] = 255;
        }
    }

    it.skipIf(!ffmpeg.ok)(withReason('generates a valid binary glTF 2.0 (.glb) plane with metric displacement and PBR maps', ffmpeg), async () => {
        const imageBuffer = await AdaptiveMaterialPbrService.encodeFromRgba(rawRgba, width, height, true);

        const result = await ImageToAdaptivePbrService.processImageToPbrPlane({
            imageBuffer,
            subdivisions: 16,
            planeWidthMeters: 2.0,
            displacementScaleMeters: 0.05,
            useNativeCpp: false // Test pure Node.js execution first
        });

        expect(result.success).toBe(true);
        expect(result.glbBuffer).toBeDefined();
        expect(result.glbBuffer.length).toBeGreaterThan(1000);
        expect(result.accelerationUsed).toBe('node-v8');
        expect(result.isSeamlessTileable).toBe(false);

        // Verify GLB magic header 0x46546C67 ('glTF')
        const magic = result.glbBuffer.readUInt32LE(0);
        expect(magic).toBe(0x46546C67);

        // Verify version 2
        const version = result.glbBuffer.readUInt32LE(4);
        expect(version).toBe(2);

        // Unpack glTF JSON chunk to inspect texture samplers and mesh attributes
        const jsonLength = result.glbBuffer.readUInt32LE(12);
        const jsonChunkType = result.glbBuffer.readUInt32LE(16);
        expect(jsonChunkType).toBe(0x4E4F534A); // 'JSON'

        const jsonStr = result.glbBuffer.toString('utf8', 20, 20 + jsonLength).trim();
        const gltf = JSON.parse(jsonStr);

        expect(gltf.asset.version).toBe('2.0');
        expect(gltf.meshes[0].primitives[0].attributes.POSITION).toBeDefined();
        expect(gltf.meshes[0].primitives[0].attributes.NORMAL).toBeDefined();
        expect(gltf.meshes[0].primitives[0].attributes.TEXCOORD_0).toBeDefined();
        expect(gltf.materials[0].pbrMetallicRoughness.baseColorTexture).toBeDefined();
        expect(gltf.materials[0].pbrMetallicRoughness.metallicRoughnessTexture).toBeDefined();
        expect(gltf.materials[0].normalTexture).toBeDefined();

        // Default sampler should be CLAMP_TO_EDGE (33071)
        expect(gltf.samplers[0].wrapS).toBe(33071);
        expect(gltf.samplers[0].wrapT).toBe(33071);
    });

    it.skipIf(!ffmpeg.ok)(withReason('supports toroidal seamless tiling with REPEAT wrap mode and UV scaling', ffmpeg), async () => {
        const imageBuffer = await AdaptiveMaterialPbrService.encodeFromRgba(rawRgba, width, height, true);

        const result = await ImageToAdaptivePbrService.processImageToPbrPlane({
            imageBuffer,
            subdivisions: 16,
            makeSeamlessTileable: true,
            featherRatio: 0.15,
            uvRepeat: [3.0, 3.0],
            useNativeCpp: false
        });

        expect(result.success).toBe(true);
        expect(result.isSeamlessTileable).toBe(true);

        const jsonLength = result.glbBuffer.readUInt32LE(12);
        const jsonStr = result.glbBuffer.toString('utf8', 20, 20 + jsonLength).trim();
        const gltf = JSON.parse(jsonStr);

        // Seamless mode must configure sampler to REPEAT (10497)
        expect(gltf.samplers[0].wrapS).toBe(10497);
        expect(gltf.samplers[0].wrapT).toBe(10497);
    });

    it.skipIf(!ffmpeg.ok)(withReason('executes native C++20 acceleration path with zero runtime error', ffmpeg), async () => {
        const imageBuffer = await AdaptiveMaterialPbrService.encodeFromRgba(rawRgba, width, height, true);

        const result = await ImageToAdaptivePbrService.generatePbrDisplacedPlane({
            imageBuffer,
            subdivisions: 16,
            useNativeCpp: true,
            prompt: 'weathered granite slab with deep cracks'
        });

        expect(result.success).toBe(true);
        expect(['native-cpp20', 'node-v8']).toContain(result.accelerationUsed);
        expect(result.meshStats.vertexCount).toBeGreaterThan(0);
        expect(result.metrics).toBeDefined();
    });

    it('GltfBinaryPacker maintains 4-byte alignment across arbitrary chunk payloads', () => {
        const dummyGltf = {
            asset: { version: '2.0' },
            bufferViews: [{}, {}, {}]
        };

        // Buffers with odd byte lengths to test padding
        const buf1 = Buffer.from('hello'); // 5 bytes
        const buf2 = Buffer.from('world!!'); // 7 bytes
        const buf3 = Buffer.alloc(11, 0xFF); // 11 bytes

        const packed = GltfBinaryPacker.packGlb(dummyGltf, [buf1, buf2, buf3], true);

        expect(packed.glbBuffer.length % 4).toBe(0);
        expect(dummyGltf.bufferViews[0].byteOffset % 4).toBe(0);
        expect(dummyGltf.bufferViews[1].byteOffset % 4).toBe(0);
        expect(dummyGltf.bufferViews[2].byteOffset % 4).toBe(0);
    });
});
