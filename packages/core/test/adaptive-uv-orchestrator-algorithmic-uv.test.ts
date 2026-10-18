/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * AdaptiveUvOrchestrator.applyAdaptivePbr on its 'elevation_stratified_conformal' branch, which runs
 * AlgorithmicUvEngine.processGlb: a tall facade with a real JPEG baseColor comes back with the de-lit albedo and
 * attached normal + ORM maps, and a texture processGlb cannot decode (or no texture at all) rejects the request
 * instead of returning the input GLB. A contact sheet of the maps is written to test-results/screenshots/.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { AdaptiveUvOrchestrator, AdaptivePbrImageProcessingError } from '../src/node/3d-engine/adaptive-uv-orchestrator';
import { AlgorithmicUvEngine } from '../src/node/spatial/AlgorithmicUvEngine';
import { decodeImageToRgba, encodeRgbaToJpeg } from '../src/node/image-codec-ffmpeg';
import { decodePng, encodePng } from '../src/node/texture-processing';
import { REPO_ROOT } from './helpers/requirements';

const SCREENSHOT_DIR = path.join(REPO_ROOT, 'test-results', 'screenshots');

/** Deterministic masonry: courses of blocks with mortar joints, a cast shadow band and grain. */
function masonryTexture(w: number, h: number): Buffer {
    const rgba = Buffer.alloc(w * h * 4);
    let seed = 24681357;
    const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            const course = Math.floor(y / 16);
            const joint = y % 16 < 2 || (x + (course % 2) * 12) % 24 < 2;
            const shadow = y > h * 0.6 ? 0.5 : 1.0;
            const grain = (rnd() - 0.5) * 24;
            const base = joint ? 70 : 180;
            const i = (y * w + x) * 4;
            rgba[i] = Math.max(0, Math.min(255, Math.round((base + 10) * shadow + grain)));
            rgba[i + 1] = Math.max(0, Math.min(255, Math.round(base * shadow + grain)));
            rgba[i + 2] = Math.max(0, Math.min(255, Math.round((base - 12) * shadow + grain)));
            rgba[i + 3] = 255;
        }
    }
    return rgba;
}

/**
 * A 10 m wide x 60 m tall facade quad, tall enough that probeTopology routes it to
 * 'elevation_stratified_conformal'. With an image, its material samples it as baseColor (KHR_materials_unlit, as
 * Google tiles ship); without one, the material is untextured.
 */
function buildFacadeGlb(image?: { bytes: Buffer; mimeType: string }): Buffer {
    const positions = new Float32Array([0, 0, 0, 10, 0, 0, 10, 60, 0, 0, 60, 0]);
    const uvs = new Float32Array([0, 1, 1, 1, 1, 0, 0, 0]);
    const indices = new Uint16Array([0, 1, 2, 0, 2, 3]);
    const parts: Buffer[] = [];
    const bufferViews: any[] = [];
    let length = 0;
    const push = (data: Buffer, extra: object = {}) => {
        const pad = (4 - (length % 4)) % 4;
        if (pad) { parts.push(Buffer.alloc(pad)); length += pad; }
        bufferViews.push({ buffer: 0, byteOffset: length, byteLength: data.length, ...extra });
        parts.push(data);
        length += data.length;
        return bufferViews.length - 1;
    };
    push(Buffer.from(positions.buffer), { target: 34962 });
    push(Buffer.from(uvs.buffer), { target: 34962 });
    push(Buffer.from(indices.buffer), { target: 34963 });
    const imageView = image ? push(image.bytes) : undefined;
    const bin = Buffer.concat(parts, length);

    const json: any = {
        asset: { version: '2.0' },
        scene: 0,
        scenes: [{ nodes: [0] }],
        nodes: [{ mesh: 0 }],
        meshes: [{ primitives: [{ attributes: { POSITION: 0, TEXCOORD_0: 1 }, indices: 2, material: 0 }] }],
        accessors: [
            { bufferView: 0, componentType: 5126, count: 4, type: 'VEC3', min: [0, 0, 0], max: [10, 60, 0] },
            { bufferView: 1, componentType: 5126, count: 4, type: 'VEC2' },
            { bufferView: 2, componentType: 5123, count: 6, type: 'SCALAR' }
        ],
        bufferViews,
        buffers: [{ byteLength: bin.length }],
        materials: [{ pbrMetallicRoughness: { metallicFactor: 0, roughnessFactor: 0.9 } }]
    };
    if (image) {
        json.samplers = [{ magFilter: 9729, minFilter: 9987, wrapS: 33071, wrapT: 33071 }];
        json.images = [{ bufferView: imageView, mimeType: image.mimeType }];
        json.textures = [{ sampler: 0, source: 0 }];
        json.materials[0].pbrMetallicRoughness.baseColorTexture = { index: 0 };
        json.materials[0].extensions = { KHR_materials_unlit: {} };
        json.extensionsUsed = ['KHR_materials_unlit'];
    }
    return AlgorithmicUvEngine.serializeGlb(json, bin);
}

function textureBytes(glb: { json: any; bin: Buffer }, textureIndex: number): { bytes: Buffer; mimeType: string } {
    const image = glb.json.images[glb.json.textures[textureIndex].source];
    const bv = glb.json.bufferViews[image.bufferView];
    return { bytes: glb.bin.subarray(bv.byteOffset || 0, (bv.byteOffset || 0) + bv.byteLength), mimeType: image.mimeType };
}

function accessorBytes(glb: { json: any; bin: Buffer }, accessorIndex: number): Buffer {
    const bv = glb.json.bufferViews[glb.json.accessors[accessorIndex].bufferView];
    return glb.bin.subarray(bv.byteOffset || 0, (bv.byteOffset || 0) + bv.byteLength);
}

describe('AdaptiveUvOrchestrator elevation_stratified_conformal (AlgorithmicUvEngine.processGlb)', () => {
    it('routes a textured facade to processGlb and returns its de-lit albedo with attached normal + ORM maps', async () => {
        const W = 96, H = 64;
        const sourceRgba = masonryTexture(W, H);
        const jpeg = await encodeRgbaToJpeg(sourceRgba, W, H, { quality: 90 });
        const inputGlb = buildFacadeGlb({ bytes: jpeg, mimeType: 'image/jpeg' });
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'adaptive-uv-esc-'));
        try {
            const outputPath = path.join(dir, 'facade_pbr.glb');
            const result = await AdaptiveUvOrchestrator.applyAdaptivePbr({ inputGlbBuffer: inputGlb, strategy: 'auto', outputPath });

            expect(result.topology.rules.tallSlender).toBe(true);
            expect(result.appliedStrategy).toBe('elevation_stratified_conformal');

            // processGlb's own report is surfaced, measured from the real JPEG.
            const uv = result.algorithmicUv!;
            expect(uv.success).toBe(true);
            expect(uv.imagesFailed).toBe(0);
            expect(uv.images).toHaveLength(1);
            expect(uv.images[0]).toMatchObject({
                imageIndex: 0, status: 'processed', sourceMimeType: 'image/jpeg', width: W, height: H, texels: W * H,
                albedoRewritten: true, normalMapGenerated: true, metallicRoughnessGenerated: true, occlusionGenerated: true
            });
            expect(uv.attachments).toEqual({ normalTextures: 1, metallicRoughnessTextures: 1, occlusionTextures: 1, unlitRemoved: 1 });

            // The returned GLB is what was written, and nothing else (no temp in/out files) is left beside it.
            expect(fs.readdirSync(dir)).toEqual(['facade_pbr.glb']);
            expect(result.outputFiles.glb).toBe(outputPath);
            const written = fs.readFileSync(outputPath);
            expect(written.equals(result.glbBuffer!)).toBe(true);
            expect(written.equals(inputGlb)).toBe(false);

            const input = AlgorithmicUvEngine.parseGlb(inputGlb);
            const output = AlgorithmicUvEngine.parseGlb(written);
            const mat = output.json.materials[0];
            expect(mat.extensions?.KHR_materials_unlit).toBeUndefined();
            expect(mat.normalTexture?.index).toBeDefined();
            expect(mat.pbrMetallicRoughness.metallicRoughnessTexture?.index).toBeDefined();
            expect(mat.occlusionTexture?.index).toBeDefined();

            // De-lit albedo: same size, different pixels.
            const baseColor = textureBytes(output, mat.pbrMetallicRoughness.baseColorTexture.index);
            expect(baseColor.bytes.equals(jpeg)).toBe(false);
            const inputDecoded = await decodeImageToRgba(jpeg);
            const albedo = await decodeImageToRgba(baseColor.bytes);
            expect([albedo.width, albedo.height]).toEqual([W, H]);
            let diff = 0;
            for (let i = 0; i < W * H * 4; i++) if (i % 4 !== 3) diff += Math.abs(albedo.rgba[i] - inputDecoded.rgba[i]);
            expect(diff / (W * H * 3)).toBeGreaterThan(3);

            // Normal map at the source size with tilted tangent-space normals from the mortar joints.
            const normal = textureBytes(output, mat.normalTexture.index);
            expect(normal.mimeType).toBe('image/png');
            const normalImg = decodePng(normal.bytes);
            expect([normalImg.width, normalImg.height]).toEqual([W, H]);
            let tilted = 0;
            for (let i = 0; i < W * H; i++) {
                const nx = normalImg.rgba[i * 4] / 127.5 - 1, ny = normalImg.rgba[i * 4 + 1] / 127.5 - 1;
                if (Math.abs(nx) > 0.05 || Math.abs(ny) > 0.05) tilted++;
            }
            expect(tilted / (W * H)).toBeGreaterThan(0.2);

            // One ORM PNG backs metallicRoughness and occlusion; roughness (G) varies across the image.
            expect(mat.pbrMetallicRoughness.metallicRoughnessTexture.index).toBe(mat.occlusionTexture.index);
            const ormImg = decodePng(textureBytes(output, mat.occlusionTexture.index).bytes);
            expect([ormImg.width, ormImg.height]).toEqual([W, H]);
            const roughness = new Set<number>();
            for (let i = 0; i < W * H; i++) roughness.add(ormImg.rgba[i * 4 + 1]);
            expect(roughness.size).toBeGreaterThan(10);

            // Geometry is untouched.
            for (const accessor of [0, 1, 2]) expect(accessorBytes(output, accessor).equals(accessorBytes(input, accessor))).toBe(true);

            fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
            const sheet = Buffer.alloc(4 * W * H * 4);
            [inputDecoded.rgba, albedo.rgba, normalImg.rgba, ormImg.rgba].forEach((img, k) => {
                for (let y = 0; y < H; y++) img.copy(sheet, (y * 4 * W + k * W) * 4, y * W * 4, (y + 1) * W * 4);
            });
            fs.writeFileSync(path.join(SCREENSHOT_DIR, 'adaptive_uv_orchestrator_elevation_stratified_maps.png'), encodePng(4 * W, H, sheet));
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it('rejects with the per-image failure when processGlb cannot decode the baseColor, and writes nothing', async () => {
        const corrupt = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(200, 0x5a)]);
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'adaptive-uv-esc-bad-'));
        try {
            const outputPath = path.join(dir, 'facade_pbr.glb');
            const err = await AdaptiveUvOrchestrator.applyAdaptivePbr({
                inputGlbBuffer: buildFacadeGlb({ bytes: corrupt, mimeType: 'image/jpeg' }),
                strategy: 'elevation_stratified_conformal',
                outputPath
            }).then(() => null, (e: unknown) => e);

            expect(err).toBeInstanceOf(AdaptivePbrImageProcessingError);
            const failure = err as AdaptivePbrImageProcessingError;
            expect(failure.message).toMatch(/elevation_stratified_conformal failed on 1 of 1 baseColor textures \(image 0: .+\)/);
            expect(failure.images).toHaveLength(1);
            expect(failure.images[0]).toMatchObject({ imageIndex: 0, status: 'failed' });
            expect(failure.images[0].error).toBeTruthy();
            expect(fs.readdirSync(dir)).toEqual([]);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it('rejects an untextured facade instead of returning the input GLB as processed', async () => {
        await expect(AdaptiveUvOrchestrator.applyAdaptivePbr({
            inputGlbBuffer: buildFacadeGlb(),
            strategy: 'auto'
        })).rejects.toThrow(/elevation_stratified_conformal decomposes embedded baseColor images, and no material in this GLB samples one/);
    });
});
