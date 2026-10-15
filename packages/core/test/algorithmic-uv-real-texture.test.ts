/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * AlgorithmicUvEngine.processGlb on real encoded textures: every baseColor image is decoded at its real size,
 * the de-lit albedo replaces the source image, normal and ORM maps computed from the pixels are attached to the
 * material, geometry bytes are untouched, and an undecodable image fails the run instead of being reported as
 * processed. A contact sheet of the input and output maps is written to test-results/screenshots/.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { AlgorithmicUvEngine } from '../src/node/spatial/AlgorithmicUvEngine';
import { algorithmicUvHandlers } from '../src/node/gemini/tools/algorithmic-uv-tools';
import { decodeImageToRgba, encodeRgbaToJpeg, readImageDimensions } from '../src/node/image-codec-ffmpeg';
import { decodePng, encodePng } from '../src/node/texture-processing';
import { REPO_ROOT } from './helpers/requirements';

const SCREENSHOT_DIR = path.join(REPO_ROOT, 'test-results', 'screenshots');

/** Deterministic stone-like texture: courses of blocks with mortar joints, a cast shadow band and grain. */
function stoneTexture(w: number, h: number): Buffer {
    const rgba = Buffer.alloc(w * h * 4);
    let seed = 987654321;
    const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            const course = Math.floor(y / 16);
            const joint = y % 16 < 2 || (x + (course % 2) * 12) % 24 < 2;
            const shadow = x > w * 0.55 ? 0.45 : 1.0;
            const grain = (rnd() - 0.5) * 24;
            const base = joint ? 70 : 185;
            const i = (y * w + x) * 4;
            rgba[i] = Math.max(0, Math.min(255, Math.round((base + 8) * shadow + grain)));
            rgba[i + 1] = Math.max(0, Math.min(255, Math.round(base * shadow + grain)));
            rgba[i + 2] = Math.max(0, Math.min(255, Math.round((base - 14) * shadow + grain)));
            rgba[i + 3] = 255;
        }
    }
    return rgba;
}

/** Luminance ramp: brighter toward the top of the image (row 0) or toward the right edge. */
function rampTexture(w: number, h: number, towards: 'top' | 'right'): Buffer {
    const rgba = Buffer.alloc(w * h * 4);
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            const t = towards === 'top' ? 1 - y / (h - 1) : x / (w - 1);
            const v = Math.round(40 + 180 * t);
            rgba.set([v, v, v, 255], (y * w + x) * 4);
        }
    }
    return rgba;
}

interface QuadMaterial { image: Buffer; mimeType: string; unlit?: boolean }

/** One mesh with a 2 m x 1 m quad primitive per material; each material samples its own embedded image. */
function buildGlb(materials: QuadMaterial[]): Buffer {
    const positions = new Float32Array([0, 0, 0, 2, 0, 0, 2, 1, 0, 0, 1, 0]);
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
    const imageViews = materials.map(m => push(m.image));
    const bin = Buffer.concat(parts, length);

    const json: any = {
        asset: { version: '2.0' },
        scene: 0,
        scenes: [{ nodes: [0] }],
        nodes: [{ mesh: 0 }],
        meshes: [{ primitives: materials.map((_, i) => ({ attributes: { POSITION: 0, TEXCOORD_0: 1 }, indices: 2, material: i })) }],
        accessors: [
            { bufferView: 0, componentType: 5126, count: 4, type: 'VEC3', min: [0, 0, 0], max: [2, 1, 0] },
            { bufferView: 1, componentType: 5126, count: 4, type: 'VEC2' },
            { bufferView: 2, componentType: 5123, count: 6, type: 'SCALAR' }
        ],
        bufferViews,
        buffers: [{ byteLength: bin.length }],
        samplers: [{ magFilter: 9729, minFilter: 9987, wrapS: 33071, wrapT: 33071 }],
        images: materials.map((m, i) => ({ bufferView: imageViews[i], mimeType: m.mimeType })),
        textures: materials.map((_, i) => ({ sampler: 0, source: i })),
        materials: materials.map(m => ({
            pbrMetallicRoughness: { baseColorTexture: { index: 0 }, metallicFactor: 0, roughnessFactor: 0.9 },
            ...(m.unlit ? { extensions: { KHR_materials_unlit: {} } } : {})
        }))
    };
    json.materials.forEach((m: any, i: number) => { m.pbrMetallicRoughness.baseColorTexture.index = i; });
    if (materials.some(m => m.unlit)) json.extensionsUsed = ['KHR_materials_unlit'];
    return AlgorithmicUvEngine.serializeGlb(json, bin);
}

function imageBytes(glb: { json: any; bin: Buffer }, textureIndex: number): { bytes: Buffer; mimeType: string } {
    const image = glb.json.images[glb.json.textures[textureIndex].source];
    const bv = glb.json.bufferViews[image.bufferView];
    return { bytes: glb.bin.subarray(bv.byteOffset || 0, (bv.byteOffset || 0) + bv.byteLength), mimeType: image.mimeType };
}

function viewBytes(glb: { json: any; bin: Buffer }, accessorIndex: number): Buffer {
    const bv = glb.json.bufferViews[glb.json.accessors[accessorIndex].bufferView];
    return glb.bin.subarray(bv.byteOffset || 0, (bv.byteOffset || 0) + bv.byteLength);
}

/** Places equally sized RGBA images side by side. */
function contactSheet(images: Buffer[], w: number, h: number): Buffer {
    const out = Buffer.alloc(images.length * w * h * 4);
    images.forEach((img, k) => {
        for (let y = 0; y < h; y++) img.copy(out, (y * images.length * w + k * w) * 4, y * w * 4, (y + 1) * w * 4);
    });
    return encodePng(images.length * w, h, out);
}

const meanAbsDiff = (a: Buffer, b: Buffer): number => {
    let s = 0, n = 0;
    for (let i = 0; i < a.length; i++) if (i % 4 !== 3) { s += Math.abs(a[i] - b[i]); n++; }
    return s / n;
};

describe('AlgorithmicUvEngine.processGlb on real JPEG / PNG textures', () => {
    it('decodes the JPEG at its real size, rewrites the albedo and attaches normal + ORM maps computed from its pixels', async () => {
        const W = 96, H = 64;
        const sourceRgba = stoneTexture(W, H);
        const jpeg = await encodeRgbaToJpeg(sourceRgba, W, H, { quality: 90 });
        expect(readImageDimensions(jpeg)).toEqual({ width: W, height: H });
        const inputGlb = buildGlb([{ image: jpeg, mimeType: 'image/jpeg', unlit: true }]);
        const input = AlgorithmicUvEngine.parseGlb(inputGlb);

        const result = await AlgorithmicUvEngine.processGlb({
            inputGlbBuffer: inputGlb,
            pbrDecomposition: { enableAlbedoDeLighting: true }
        });

        // Real decoded size, not a fixed 512 x 512.
        expect(result.success).toBe(true);
        expect(result.texelsProcessed).toBe(W * H);
        expect(result.images).toHaveLength(1);
        expect(result.images[0]).toMatchObject({ imageIndex: 0, status: 'processed', width: W, height: H, texels: W * H, albedoRewritten: true });
        expect(result.attachments).toEqual({ normalTextures: 1, metallicRoughnessTextures: 1, occlusionTextures: 1, unlitRemoved: 1 });
        expect(result as any).not.toHaveProperty('stoneTexelsCount');
        expect(result as any).not.toHaveProperty('atlasFillRate');

        const output = AlgorithmicUvEngine.parseGlb(result.outputGlbBuffer!);
        expect(result.outputGlbBuffer!.equals(inputGlb)).toBe(false);

        // New textures exist in the GLB JSON and are wired into the material.
        expect(output.json.images).toHaveLength(3); // rewritten baseColor, normal, ORM (backs metallicRoughness and occlusion)
        const mat = output.json.materials[0];
        expect(mat.extensions?.KHR_materials_unlit).toBeUndefined();
        expect(output.json.extensionsUsed ?? []).not.toContain('KHR_materials_unlit');
        expect(mat.normalTexture?.index).toBeDefined();
        expect(mat.pbrMetallicRoughness.metallicRoughnessTexture?.index).toBeDefined();
        expect(mat.occlusionTexture?.index).toBeDefined();
        expect(mat.pbrMetallicRoughness.roughnessFactor).toBe(1);
        expect(mat.pbrMetallicRoughness.metallicFactor).toBe(1);
        for (const slot of [mat.normalTexture, mat.pbrMetallicRoughness.metallicRoughnessTexture, mat.occlusionTexture]) {
            expect(output.json.textures[slot.index].sampler).toBe(0);
        }

        // The rewritten albedo differs from the input, byte-wise and pixel-wise.
        const baseColor = imageBytes(output, mat.pbrMetallicRoughness.baseColorTexture.index);
        expect(baseColor.mimeType).toBe('image/jpeg');
        expect(baseColor.bytes.equals(jpeg)).toBe(false);
        const inputDecoded = await decodeImageToRgba(jpeg);
        const albedoDecoded = await decodeImageToRgba(baseColor.bytes);
        expect(albedoDecoded.width).toBe(W);
        expect(albedoDecoded.height).toBe(H);
        expect(meanAbsDiff(inputDecoded.rgba, albedoDecoded.rgba)).toBeGreaterThan(5);

        // Normal map: PNG at the source size, unit-ish tangent-space vectors with real variation.
        const normal = imageBytes(output, mat.normalTexture.index);
        expect(normal.mimeType).toBe('image/png');
        const normalImg = decodePng(normal.bytes);
        expect([normalImg.width, normalImg.height]).toEqual([W, H]);
        let tilted = 0;
        for (let i = 0; i < W * H; i++) {
            const nx = normalImg.rgba[i * 4] / 127.5 - 1, ny = normalImg.rgba[i * 4 + 1] / 127.5 - 1, nz = normalImg.rgba[i * 4 + 2] / 127.5 - 1;
            expect(nz).toBeGreaterThan(0);
            expect(Math.abs(Math.hypot(nx, ny, nz) - 1)).toBeLessThan(0.02);
            if (Math.abs(nx) > 0.05 || Math.abs(ny) > 0.05) tilted++;
        }
        expect(tilted / (W * H)).toBeGreaterThan(0.2);

        // ORM: one PNG backs both slots; R = AO, G = roughness, B = metalness (0 for the default stone contract).
        expect(mat.pbrMetallicRoughness.metallicRoughnessTexture.index).toBe(mat.occlusionTexture.index);
        const orm = imageBytes(output, mat.occlusionTexture.index);
        const ormImg = decodePng(orm.bytes);
        expect([ormImg.width, ormImg.height]).toEqual([W, H]);
        const roughValues = new Set<number>();
        let aoBelowOne = 0;
        for (let i = 0; i < W * H; i++) {
            if (ormImg.rgba[i * 4] < 255) aoBelowOne++;
            roughValues.add(ormImg.rgba[i * 4 + 1]);
            expect(ormImg.rgba[i * 4 + 2]).toBe(0);
        }
        expect(aoBelowOne).toBeGreaterThan(0);
        expect(roughValues.size).toBeGreaterThan(10);

        // Geometry bytes are untouched and the rebuilt binary chunk is well-formed.
        for (const accessor of [0, 1, 2]) expect(viewBytes(output, accessor).equals(viewBytes(input, accessor))).toBe(true);
        // glTF: the BIN chunk may exceed buffers[0].byteLength only by its 0-3 bytes of padding.
        expect(output.bin.length - output.json.buffers[0].byteLength).toBeGreaterThanOrEqual(0);
        expect(output.bin.length - output.json.buffers[0].byteLength).toBeLessThan(4);
        for (const bv of output.json.bufferViews) {
            expect(bv.byteOffset % 4).toBe(0);
            expect(bv.byteOffset + bv.byteLength).toBeLessThanOrEqual(output.json.buffers[0].byteLength);
        }

        fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
        fs.writeFileSync(path.join(SCREENSHOT_DIR, 'algorithmic_uv_real_texture_jpeg_maps.png'),
            contactSheet([inputDecoded.rgba, albedoDecoded.rgba, normalImg.rgba, ormImg.rgba], W, H));
    });

    it('sums the real sizes of several images and writes glTF (+Y up) normals', async () => {
        // A PNG ramp brightening toward the top and a JPEG ramp brightening toward the right, different sizes.
        const topRamp = encodePng(40, 24, rampTexture(40, 24, 'top'));
        const rightRampRgba = rampTexture(56, 32, 'right');
        const rightRamp = await encodeRgbaToJpeg(rightRampRgba, 56, 32, { quality: 95 });
        const result = await AlgorithmicUvEngine.processGlb({
            inputGlbBuffer: buildGlb([
                { image: topRamp, mimeType: 'image/png' },
                { image: rightRamp, mimeType: 'image/jpeg' }
            ]),
            pbrDecomposition: { generateRoughnessMaps: false, generateAoMaps: false }
        });

        expect(result.success).toBe(true);
        expect(result.texelsProcessed).toBe(40 * 24 + 56 * 32);
        expect(result.images.map(r => [r.width, r.height])).toEqual([[40, 24], [56, 32]]);
        expect(result.attachments).toMatchObject({ normalTextures: 2, metallicRoughnessTextures: 0, occlusionTextures: 0 });

        const output = AlgorithmicUvEngine.parseGlb(result.outputGlbBuffer!);
        // No de-lighting was requested, so the source images are carried over byte for byte.
        expect(imageBytes(output, 0).bytes.equals(topRamp)).toBe(true);
        expect(imageBytes(output, 1).bytes.equals(rightRamp)).toBe(true);

        const meanChannel = (textureIndex: number, channel: number, w: number, h: number) => {
            const img = decodePng(imageBytes(output, output.json.materials[textureIndex].normalTexture.index).bytes);
            let s = 0, n = 0;
            for (let y = 4; y < h - 4; y++) for (let x = 4; x < w - 4; x++) { s += img.rgba[(y * w + x) * 4 + channel]; n++; }
            return s / n;
        };
        // Height rising toward the top faces the surface toward the bottom: -Y in glTF tangent space.
        expect(meanChannel(0, 1, 40, 24)).toBeLessThan(120);
        // Height rising toward the right faces the surface toward the left: -X.
        expect(meanChannel(1, 0, 56, 32)).toBeLessThan(120);
    });

    it('reports an undecodable image as a failure and attaches nothing for it', async () => {
        const corrupt = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(200, 0x5a)]);
        const result = await AlgorithmicUvEngine.processGlb({
            inputGlbBuffer: buildGlb([{ image: corrupt, mimeType: 'image/jpeg', unlit: true }])
        });

        expect(result.success).toBe(false);
        expect(result.imagesFailed).toBe(1);
        expect(result.imagesProcessed).toBe(0);
        expect(result.texelsProcessed).toBe(0);
        expect(result.images[0].status).toBe('failed');
        expect(result.images[0].error).toBeTruthy();
        expect(result.attachments).toEqual({ normalTextures: 0, metallicRoughnessTextures: 0, occlusionTextures: 0, unlitRemoved: 0 });
        const mat = AlgorithmicUvEngine.parseGlb(result.outputGlbBuffer!).json.materials[0];
        expect(mat.normalTexture).toBeUndefined();
        expect(mat.extensions?.KHR_materials_unlit).toBeDefined();
    });

    it('algorithmic_uv_unwrap_rewrap reports measured numbers and fails on an undecodable texture', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'algo-uv-real-'));
        try {
            const W = 96, H = 64;
            const goodPath = path.join(dir, 'good.glb');
            fs.writeFileSync(goodPath, buildGlb([{ image: await encodeRgbaToJpeg(stoneTexture(W, H), W, H), mimeType: 'image/jpeg', unlit: true }]));
            const good = await algorithmicUvHandlers.algorithmic_uv_unwrap_rewrap(
                { inputGlbPath: goodPath, outputGlbPath: path.join(dir, 'good_out.glb'), enableAlbedoDeLighting: true }, {} as any);
            expect(good.status).toBe('completed');
            expect(good.summaryResult).toContain(`${(W * H).toLocaleString()} texels`);
            expect(good.summaryResult).toContain('Attached 1 normal, 1 metallicRoughness and 1 occlusion textures');
            expect(good.summaryResult).not.toMatch(/stone|road|marking|foliage/i);
            expect((good.resultPayload as any).outputGlbBuffer).toBeUndefined();
            expect(fs.existsSync(path.join(dir, 'good_out.glb'))).toBe(true);

            const badPath = path.join(dir, 'bad.glb');
            fs.writeFileSync(badPath, buildGlb([{ image: Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(64, 1)]), mimeType: 'image/jpeg' }]));
            const bad = await algorithmicUvHandlers.algorithmic_uv_unwrap_rewrap({ inputGlbPath: badPath }, {} as any);
            expect(bad.status).toBe('failed');
            expect(bad.summaryResult).toMatch(/^Algorithmic UV engine FAILED on 1 of 1 baseColor textures \(image 0: /);
            expect((bad.resultPayload as any).success).toBe(false);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
});
