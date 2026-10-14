/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import { describe, it, expect } from 'vitest';
import * as fs from 'fs-extra';
import * as os from 'os';
import * as path from 'path';
import {
    TextureCompressionService,
    type TextureCompressionOptions,
    type TextureMapType
} from '../src/node/texture-compression-service';
import { encodePng } from '../src/node/texture-processing';
import { findBinary, HOW_TO, requireAll, requireAssets, withReason, type Requirement } from './helpers/requirements';

/** The service spawns getCwebpPath() (SCRATCHBOX_CWEBP_PATH, Homebrew/usr paths, else `cwebp` on PATH). */
const cwebp: Requirement = findBinary(TextureCompressionService.getCwebpPath()) !== null
    ? { ok: true, reason: '' }
    : { ok: false, reason: `\`cwebp\` not found (set SCRATCHBOX_CWEBP_PATH or ${HOW_TO.cwebp})` };

const foliageAsset = requireAssets(['public/models/colosseum_foliage_texture_hero_1k_albedo.png'], 'scripts/apply_colosseum_1k_pbr_suite.cjs');
const stoneMapsAsset = requireAssets(['public/models/colosseum_stone_texture_39_1k_normal.jpg', 'public/models/colosseum_stone_texture_39_1k_orm.jpg'], 'scripts/apply_colosseum_1k_pbr_suite.cjs');
const colosseumGlbAsset = requireAssets(['public/models/colosseum_rome_1k_pbr.glb'], 'scripts/apply_colosseum_1k_pbr_suite.cjs');

describe('Texture Compression Engine (WebP & EXT_texture_webp)', () => {
    const colosseumFoliageAlbedo = path.resolve(__dirname, '../../../public/models/colosseum_foliage_texture_hero_1k_albedo.png');
    const colosseumStoneNormal = path.resolve(__dirname, '../../../public/models/colosseum_stone_texture_39_1k_normal.jpg');
    const colosseumStoneOrm = path.resolve(__dirname, '../../../public/models/colosseum_stone_texture_39_1k_orm.jpg');

    it.skipIf(!cwebp.ok)(withReason('should locate cwebp executable on the system', cwebp), () => {
        const cwebpPath = TextureCompressionService.getCwebpPath();
        expect(cwebpPath).toBeDefined();
        expect(fs.existsSync(cwebpPath)).toBe(true);
    });

    it('should correctly infer PBR texture map types from naming conventions', () => {
        expect(TextureCompressionService.inferMapType('colosseum_foliage_texture_hero_1k_albedo.png')).toBe('foliage');
        expect(TextureCompressionService.inferMapType('stone_facade_normal.png')).toBe('normal');
        expect(TextureCompressionService.inferMapType('building_orm_packed.jpg')).toBe('orm');
        expect(TextureCompressionService.inferMapType('marble_roughness.png')).toBe('roughness');
        expect(TextureCompressionService.inferMapType('metal_metallic.png')).toBe('metallic');
        expect(TextureCompressionService.inferMapType('ground_ao.png')).toBe('ao');
        expect(TextureCompressionService.inferMapType('facade_diffuse.png')).toBe('albedo');
    });

    it.skipIf(!cwebp.ok)(withReason('should compress a synthetic RGBA texture with alpha transparency to WebP', cwebp), async () => {
        // Create 128x128 synthetic image with transparent gradient
        const width = 128;
        const height = 128;
        const rgba = Buffer.alloc(width * height * 4);
        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
                const idx = (y * width + x) * 4;
                rgba[idx] = Math.round((x / width) * 255);       // R
                rgba[idx + 1] = Math.round((y / height) * 255);  // G
                rgba[idx + 2] = 180;                             // B
                rgba[idx + 3] = x > 64 ? 255 : 0;                // Alpha cutout
            }
        }

        const pngBuffer = encodePng(width, height, rgba);
        expect(pngBuffer.length).toBeGreaterThan(0);

        const compResult = await TextureCompressionService.compressBuffer(pngBuffer, {
            mapType: 'foliage',
            quality: 88,
            alphaQuality: 100
        });

        expect(compResult.mimeType).toBe('image/webp');
        expect(compResult.compressedSizeBytes).toBeLessThan(pngBuffer.length);
        expect(compResult.spaceSavingsPercent).toBeGreaterThan(0);

        // Verify WebP magic header: 'RIFF' .... 'WEBP'
        const riffMagic = compResult.buffer.toString('ascii', 0, 4);
        const webpMagic = compResult.buffer.toString('ascii', 8, 12);
        expect(riffMagic).toBe('RIFF');
        expect(webpMagic).toBe('WEBP');
    });

    const foliageReq = requireAll(cwebp, foliageAsset);
    it.skipIf(!foliageReq.ok)(withReason('should compress hero foliage albedo texture with alpha, cutting size by > 80%', foliageReq), async () => {
        const inputBuf = await fs.readFile(colosseumFoliageAlbedo);
        const result = await TextureCompressionService.compressBuffer(inputBuf, {
            mapType: 'foliage',
            quality: 88,
            alphaQuality: 100
        });

        expect(result.mimeType).toBe('image/webp');
        expect(result.originalSizeBytes).toBe(inputBuf.length);
        // Colosseum foliage PNG is ~2.0 MB -> should be < 400 KB in WebP
        expect(result.compressedSizeBytes).toBeLessThan(450 * 1024);
        expect(result.spaceSavingsPercent).toBeGreaterThan(80.0);
    });

    const stoneMapsReq = requireAll(cwebp, stoneMapsAsset);
    it.skipIf(!stoneMapsReq.ok)(withReason('should compress normal and ORM maps with high vector precision', stoneMapsReq), async () => {
        const normalBuf = await fs.readFile(colosseumStoneNormal);
        const normalResult = await TextureCompressionService.compressBuffer(normalBuf, {
            mapType: 'normal',
            quality: 95,
            sharpYuv: true
        });
        expect(normalResult.mimeType).toBe('image/webp');
        expect(normalResult.compressedSizeBytes).toBeLessThan(normalBuf.length);

        const ormBuf = await fs.readFile(colosseumStoneOrm);
        const ormResult = await TextureCompressionService.compressBuffer(ormBuf, {
            mapType: 'orm',
            lossless: true
        });
        expect(ormResult.mimeType).toBe('image/webp');
        expect(ormResult.isLossless).toBe(true);
    });

    it.skipIf(!cwebp.ok)(withReason('should re-encode textures inside a GLB and inject EXT_texture_webp', cwebp), async () => {
        // Construct a minimal valid binary glTF 2.0 (.glb) with 1 embedded PNG texture
        const width = 64;
        const height = 64;
        const rgba = Buffer.alloc(width * height * 4, 200);
        const testPng = encodePng(width, height, rgba);

        const gltf = {
            asset: { version: '2.0', generator: 'Scratchbox Test' },
            scenes: [{ nodes: [0] }],
            scene: 0,
            nodes: [{ mesh: 0 }],
            meshes: [{
                primitives: [{
                    attributes: { POSITION: 0 },
                    indices: 1,
                    material: 0
                }]
            }],
            materials: [{
                pbrMetallicRoughness: {
                    baseColorTexture: { index: 0 }
                }
            }],
            textures: [{ sampler: 0, source: 0 }],
            samplers: [{ magFilter: 9729, minFilter: 9987 }],
            images: [{ bufferView: 2, mimeType: 'image/png' }],
            accessors: [
                { bufferView: 0, byteOffset: 0, componentType: 5126, count: 3, type: 'VEC3' },
                { bufferView: 1, byteOffset: 0, componentType: 5125, count: 3, type: 'SCALAR' }
            ],
            bufferViews: [
                { buffer: 0, byteOffset: 0, byteLength: 36 },     // 3 positions * 12 bytes
                { buffer: 0, byteOffset: 36, byteLength: 12 },    // 3 indices * 4 bytes
                { buffer: 0, byteOffset: 48, byteLength: testPng.length } // image
            ],
            buffers: [{ byteLength: 48 + testPng.length }]
        };

        const geomBuffer = Buffer.alloc(48); // dummy vertex & index data
        const binBuffer = Buffer.concat([geomBuffer, testPng]);

        const jsonStr = JSON.stringify(gltf);
        const jsonBuf = Buffer.from(jsonStr, 'utf8');
        const jsonPad = (4 - (jsonBuf.length % 4)) % 4;
        const finalJsonBuf = jsonPad > 0 ? Buffer.concat([jsonBuf, Buffer.alloc(jsonPad, 0x20)]) : jsonBuf;

        const totalLen = 12 + 8 + finalJsonBuf.length + 8 + binBuffer.length;
        const testGlb = Buffer.alloc(totalLen);

        testGlb.writeUInt32LE(0x46546C67, 0); // 'glTF'
        testGlb.writeUInt32LE(2, 4);
        testGlb.writeUInt32LE(totalLen, 8);

        testGlb.writeUInt32LE(finalJsonBuf.length, 12);
        testGlb.writeUInt32LE(0x4E4F534A, 16);
        finalJsonBuf.copy(testGlb, 20);

        const binPos = 20 + finalJsonBuf.length;
        testGlb.writeUInt32LE(binBuffer.length, binPos);
        testGlb.writeUInt32LE(0x004E4942, binPos + 4);
        binBuffer.copy(testGlb, binPos + 8);

        // Run TextureCompressionService.compressGlbTextures
        const { glb: compressedGlb, stats } = await TextureCompressionService.compressGlbTextures(testGlb);

        expect(compressedGlb).toBeDefined();
        expect(stats.totalTexturesProcessed).toBe(1);
        expect(stats.compressedTextureCount).toBe(1);

        // Verify GLB container validity
        const outMagic = compressedGlb.readUInt32LE(0);
        expect(outMagic).toBe(0x46546C67);

        // Verify JSON contents
        const outJsonLen = compressedGlb.readUInt32LE(12);
        const outJson = JSON.parse(compressedGlb.toString('utf8', 20, 20 + outJsonLen));

        expect(outJson.extensionsUsed).toContain('EXT_texture_webp');
        expect(outJson.images[0].mimeType).toBe('image/webp');
        expect(outJson.textures[0].extensions.EXT_texture_webp.source).toBe(0);
    });

    const colosseumGlbReq = requireAll(cwebp, colosseumGlbAsset);
    it.skipIf(!colosseumGlbReq.ok)(withReason('should recompress real Colosseum 1K PBR GLB and achieve massive space reduction', colosseumGlbReq), async () => {
        const colosseumGlbPath = path.resolve(__dirname, '../../../public/models/colosseum_rome_1k_pbr.glb');

        const inputBuf = await fs.readFile(colosseumGlbPath);
        const { glb: compressedGlb, stats } = await TextureCompressionService.compressGlbTextures(inputBuf, {
            concurrency: 12,
            albedoQuality: 88,
            normalQuality: 95
        });

        expect(compressedGlb).toBeDefined();
        expect(stats.totalTexturesProcessed).toBe(237);
        expect(stats.compressedTextureCount).toBe(237);

        // If the file was already WebP compressed, total size will be < 85 MB
        // If starting from uncompressed 174 MB, savings will be > 40%
        if (stats.originalGlbBytes > 120 * 1024 * 1024) {
            expect(stats.spaceSavingsPercent).toBeGreaterThan(40.0);
        } else {
            expect(stats.compressedGlbBytes).toBeLessThan(85 * 1024 * 1024);
        }

        // Verify container header
        expect(compressedGlb.readUInt32LE(0)).toBe(0x46546C67);

        // Verify glTF JSON structure
        const jsonLen = compressedGlb.readUInt32LE(12);
        const gltf = JSON.parse(compressedGlb.toString('utf8', 20, 20 + jsonLen));
        expect(gltf.extensionsUsed).toContain('EXT_texture_webp');
        expect(gltf.images.every((img: any) => img.mimeType === 'image/webp')).toBe(true);

        console.log(`\nColosseum 1K PBR GLB WebP Compression Stats:`);
        console.log(`Original Size: ${(stats.originalGlbBytes / 1024 / 1024).toFixed(2)} MB`);
        console.log(`Compressed Size: ${(stats.compressedGlbBytes / 1024 / 1024).toFixed(2)} MB`);
        console.log(`Space Saved: ${(stats.savedBytes / 1024 / 1024).toFixed(2)} MB (${stats.spaceSavingsPercent.toFixed(1)}%)`);

        // Write the optimized GLB to a temp dir: a test must never overwrite the source asset in public/models.
        const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sbx-texture-compression-'));
        try {
            const outPath = path.join(outDir, 'colosseum_rome_1k_pbr.webp.glb');
            await fs.outputFile(outPath, compressedGlb);
            expect(fs.statSync(outPath).size).toBe(compressedGlb.length);
        } finally {
            fs.rmSync(outDir, { recursive: true, force: true });
        }
    }, 60000);
});

