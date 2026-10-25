/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * texture-holes.ts: pipeline I's kept model can come back with real black holes in its own generated texture (surfaces
 * its four input views never saw -- measured 7.8% of a live Haughwout Building run's texture, seen on the built facade
 * as hard black tears). This fills them through image-hole-infill.ts's generic hole detector and detail-locked inpaint,
 * with black as the hole colour. The image model is a local function here (nothing bills).
 */

import { describe, expect, it } from 'vitest';
import { assembleGlb, parseGlbBytes } from '../src/node/3d-engine/staged-location/glb-bytes';
import { decodeImageToRgbaSync } from '../src/node/image-codec-ffmpeg';
import { encodePng } from '../src/node/texture-processing';
import { decodeImageInMemory } from '../src/node/3d-engine/staged-location/tile-texture-transfer';
import type { EnhanceModelClient } from '../src/node/3d-engine/staged-location/texture-enhance';
import { infillModelTextureHoles } from '../src/node/3d-engine/staged-location/pipeline-i/texture-holes';

const isMagenta = (p: Uint8Array, o: number) => p[o] > 200 && p[o + 2] > 200 && p[o + 1] < 90;

/** Answers with the sent image, each magenta pixel replaced by the nearest real pixel to its left in the same row. */
const rowFill: EnhanceModelClient = async req => {
    const img = decodeImageInMemory(req.image.bytes);
    const p = Uint8Array.from(img.rgba);
    for (let y = 0; y < img.height; y++) {
        let last: number[] | undefined;
        for (let x = 0; x < img.width; x++) {
            const o = (y * img.width + x) * 4;
            if (isMagenta(p, o)) { if (last) p.set(last, o); }
            else last = [p[o], p[o + 1], p[o + 2]];
        }
    }
    return { bytes: new Uint8Array(encodePng(img.width, img.height, Buffer.from(p))), mimeType: 'image/png', modelUsed: 'local-row-fill', requestedModels: ['local-row-fill'], skippedModels: [], modelNote: 'local' };
};

/** Answers with the sent image unchanged: the holes stay magenta. */
const lazy: EnhanceModelClient = async req => ({ bytes: req.image.bytes, mimeType: 'image/png', modelUsed: 'local-lazy', requestedModels: ['local-lazy'], skippedModels: [], modelNote: 'local' });

/** A one-quad, one-material GLB: a 64x64 base-colour texture, grey apart from an optional 24x24 black square at (20, 20). */
function quadGlb(hole: boolean): Buffer {
    const positions = new Float32Array([0, 0, 0, 10, 0, 0, 10, 10, 0, 0, 10, 0]);
    const uvs = new Float32Array([0, 1, 1, 1, 1, 0, 0, 0]);
    const indices = new Uint16Array([0, 1, 2, 0, 2, 3]);
    const tex = Buffer.alloc(64 * 64 * 4);
    for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) {
        const o = (y * 64 + x) * 4;
        const black = hole && x >= 20 && x < 44 && y >= 20 && y < 44;
        tex.set(black ? [0, 0, 0, 255] : [150, 120, 90, 255], o);
    }
    const png = encodePng(64, 64, tex);
    const pad = (b: Buffer) => Buffer.concat([b, Buffer.alloc((4 - (b.length % 4)) % 4)]);
    const parts = [Buffer.from(positions.buffer), Buffer.from(uvs.buffer), pad(Buffer.from(indices.buffer)), pad(png)];
    const offs = parts.reduce<number[]>((a, p, i) => [...a, i ? a[i - 1] + parts[i - 1].length : 0], []);
    const json = {
        asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0 }],
        meshes: [{ primitives: [{ attributes: { POSITION: 0, TEXCOORD_0: 1 }, indices: 2, material: 0 }] }],
        materials: [{ pbrMetallicRoughness: { baseColorTexture: { index: 0 } } }], textures: [{ source: 0 }], images: [{ bufferView: 3, mimeType: 'image/png' }],
        buffers: [{ byteLength: parts.reduce((a, p) => a + p.length, 0) }],
        bufferViews: [{ buffer: 0, byteOffset: offs[0], byteLength: 48 }, { buffer: 0, byteOffset: offs[1], byteLength: 32 }, { buffer: 0, byteOffset: offs[2], byteLength: 12 }, { buffer: 0, byteOffset: offs[3], byteLength: png.length }],
        accessors: [
            { bufferView: 0, componentType: 5126, count: 4, type: 'VEC3', min: [0, 0, 0], max: [10, 10, 0] },
            { bufferView: 1, componentType: 5126, count: 4, type: 'VEC2' },
            { bufferView: 2, componentType: 5123, count: 6, type: 'SCALAR' }
        ]
    };
    return assembleGlb(json, Buffer.concat(parts));
}

/** A GLB with geometry but no material/texture at all. */
function untexturedGlb(): Buffer {
    const positions = new Float32Array([0, 0, 0, 10, 0, 0, 10, 10, 0]);
    const indices = new Uint16Array([0, 1, 2]);
    const pad = (b: Buffer) => Buffer.concat([b, Buffer.alloc((4 - (b.length % 4)) % 4)]);
    const parts = [Buffer.from(positions.buffer), pad(Buffer.from(indices.buffer))];
    const offs = parts.reduce<number[]>((a, p, i) => [...a, i ? a[i - 1] + parts[i - 1].length : 0], []);
    const json = {
        asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0 }],
        meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1 }] }],
        buffers: [{ byteLength: parts.reduce((a, p) => a + p.length, 0) }],
        bufferViews: [{ buffer: 0, byteOffset: offs[0], byteLength: 36 }, { buffer: 0, byteOffset: offs[1], byteLength: 6 }],
        accessors: [
            { bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [0, 0, 0], max: [10, 10, 0] },
            { bufferView: 1, componentType: 5123, count: 3, type: 'SCALAR' }
        ]
    };
    return assembleGlb(json, Buffer.concat(parts));
}

function readTexture(glb: Buffer) {
    const { json, bin } = parseGlbBytes(glb);
    const bv = json.bufferViews[json.images[0].bufferView];
    return decodeImageToRgbaSync(Buffer.from(bin.buffer, bin.byteOffset + (bv.byteOffset ?? 0), bv.byteLength));
}

describe('pipeline I texture holes', () => {
    it('fills a black hole in the model\'s baseColorTexture, leaving the rest of the image untouched', async () => {
        const glb = quadGlb(true);
        const { glb: out, result } = await infillModelTextureHoles(glb, { client: rowFill, models: ['local-row-fill'] });
        expect(result.images).toBe(1);
        expect(result.decision).toBe('accepted');
        // image-hole-infill.ts grows the found 24x24 hole by HOLE_GROW_PX on each side before it is sent
        expect(result.holePixels).toBe(28 * 28);
        expect(result.filledPixels).toBe(result.holePixels);
        expect(result.modelUsed).toBe('local-row-fill');
        const img = readTexture(out);
        // the hole's centre no longer reads black
        const o = (32 * 64 + 32) * 4;
        expect(img.rgba[o]).toBeGreaterThan(50);
        // a pixel well outside the (grown) hole is untouched
        const q = (5 * 64 + 5) * 4;
        expect(Array.from(img.rgba.subarray(q, q + 3))).toEqual([150, 120, 90]);
    });

    it('leaves the texture as it was, with the reason, when the model keeps the holes', async () => {
        const glb = quadGlb(true);
        const { glb: out, result } = await infillModelTextureHoles(glb, { client: lazy, models: ['local-lazy'] });
        expect(result.decision).toBe('rejected');
        expect(result.reason).toMatch(/magenta/);
        expect(result.filledPixels).toBe(0);
        expect(out).toBe(glb);
    });

    it('comes back byte-identical when the texture has no black holes', async () => {
        const glb = quadGlb(false);
        const { glb: out, result } = await infillModelTextureHoles(glb, { client: rowFill, models: ['local-row-fill'] });
        expect(result.decision).toBe('no_holes');
        expect(result.holePixels).toBe(0);
        expect(out).toBe(glb);
    });

    it('says there is nothing to do when the GLB has no baseColorTexture at all', async () => {
        const glb = untexturedGlb();
        const { glb: out, result } = await infillModelTextureHoles(glb, { client: rowFill, models: ['local-row-fill'] });
        expect(result.decision).toBe('no_images');
        expect(result.images).toBe(0);
        expect(out).toBe(glb);
    });
});
