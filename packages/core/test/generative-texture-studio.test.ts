/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import { test } from 'vitest';
import * as assert from 'assert';
import * as fs from 'fs-extra';
import * as os from 'os';
import * as path from 'path';
import {
    encodePng,
    decodePng,
    makeToroidalSeamless,
    decomposeRgbaToPbr,
    generateProceduralTextureBuffer
} from '../src/node/texture-processing';
import { GoogleMediaGenerationService } from '../src/node/google-media-generation-service';
import { MediaAssetStore } from '../src/node/media-asset-store';

test('Generative Texture Studio - Toroidal seamlessness and PBR channel extraction', async () => {
    console.log('🧪 Testing procedural texture generation and seamless toroidal wrapping...');

    // 1. Generate a 64x64 test texture
    const width = 64;
    const height = 64;
    const rawRgba = generateProceduralTextureBuffer(width, height, 'granite');
    assert.strictEqual(rawRgba.length, width * height * 4, 'RGBA buffer must match width * height * 4');

    // 2. Test PNG roundtrip encoding/decoding
    const pngBuffer = encodePng(width, height, rawRgba);
    assert.ok(pngBuffer.length > 8, 'PNG buffer must contain PNG signature and chunks');
    assert.strictEqual(pngBuffer.readUInt32BE(0), 0x89504e47, 'Valid PNG header');

    const decoded = decodePng(pngBuffer);
    assert.strictEqual(decoded.width, width, 'Decoded width must match');
    assert.strictEqual(decoded.height, height, 'Decoded height must match');
    assert.strictEqual(decoded.data.length, rawRgba.length, 'Decoded buffer length must match');

    // 3. Make toroidal seamless
    const seamlessRgba = makeToroidalSeamless(rawRgba, width, height, 0.15);
    assert.strictEqual(seamlessRgba.length, rawRgba.length);

    // Verify left and right edges match within seamless tolerance
    for (let y = 0; y < height; ++y) {
        const leftIdx = y * width * 4;
        const rightIdx = (y * width + (width - 1)) * 4;
        const diffR = Math.abs(seamlessRgba[leftIdx] - seamlessRgba[rightIdx]);
        assert.ok(diffR <= 10, `Edge seam diff at y=${y} must be continuous (got ${diffR})`);
    }

    // 4. Decompose RGBA into 5 PBR channels
    const pbr = decomposeRgbaToPbr(seamlessRgba, width, height, {
        isMetallic: false,
        bumpStrength: 1.5,
        roughnessRange: [0.3, 0.85]
    });

    assert.ok(pbr.albedoPng.length > 0, 'Albedo PNG generated');
    assert.ok(pbr.normalPng.length > 0, 'Normal map PNG generated');
    assert.ok(pbr.roughnessPng.length > 0, 'Roughness map PNG generated');
    assert.ok(pbr.metallicPng.length > 0, 'Metallic map PNG generated');
    assert.ok(pbr.aoPng.length > 0, 'AO map PNG generated');

    // Verify normal map has proper vector tangent space (Z coordinate / Blue channel > 128)
    const decodedNormals = decodePng(pbr.normalPng);
    let avgBlue = 0;
    for (let i = 2; i < decodedNormals.data.length; i += 4) {
        avgBlue += decodedNormals.data[i];
    }
    avgBlue /= (width * height);
    assert.ok(avgBlue > 180, `Tangent-space normal blue channel must point primarily along surface normal (got ${avgBlue})`);
});

test('GoogleMediaGenerationService.generateTextureMatrix - 4-up candidate generation and asset caching', async () => {
    console.log('🧪 Testing GoogleMediaGenerationService 4-up texture matrix generation...');
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'scratchbox-texture-matrix-'));

    let callCount = 0;
    const fakeClient: any = {
        models: {
            generateContent: async () => {
                callCount++;
                const mode = callCount % 2 === 0 ? 'granite' : 'marble';
                const buf = generateProceduralTextureBuffer(32, 32, mode);
                buf[0] = (callCount * 37) % 255;
                buf[1] = (callCount * 63) % 255;
                return {
                    candidates: [{
                        content: {
                            parts: [{
                                inlineData: {
                                    mimeType: 'image/png',
                                    data: encodePng(32, 32, buf).toString('base64')
                                }
                            }]
                        }
                    }]
                };
            }
        }
    };

    const mediaStore = new MediaAssetStore();
    const service = new GoogleMediaGenerationService(
        mediaStore,
        async () => fakeClient
    );

    const result = await service.generateTextureMatrix({
        basePrompt: 'Weathered volcanic basalt with quartz veins',
        workspaceRoot,
        isMetallic: false,
        bumpStrength: 1.8
    });

    assert.strictEqual(result.candidates.length, 4, 'Must return exactly 4 candidates in variation matrix');
    assert.strictEqual(result.selectedCandidateId, result.candidates[0].id, 'Default selection must be first candidate');

    for (const c of result.candidates) {
        assert.ok(c.id, 'Candidate must have an ID');
        assert.ok(c.styleModifier, 'Candidate must have a style modifier');
        assert.ok(c.textures.albedo, 'Candidate must have albedo URL');
        assert.ok(c.textures.normal, 'Candidate must have normal URL');
        assert.ok(c.textures.roughness, 'Candidate must have roughness URL');
        assert.ok(c.textures.metallic, 'Candidate must have metallic URL');
        assert.ok(c.textures.ao, 'Candidate must have AO URL');
        assert.strictEqual(c.textures.isTileable, true, 'Candidate must be tileable');
    }

    // Verify assets were actually written to disk in media asset store with SHA-256 deduplication
    const storedFiles = await fs.readdir(path.join(workspaceRoot, '.scratchbox', 'media'));
    assert.ok(storedFiles.length >= 8, `Must write distinct PBR map files to disk (with SHA-256 deduplication for constant channels), got ${storedFiles.length}`);

    await fs.remove(workspaceRoot);
});
