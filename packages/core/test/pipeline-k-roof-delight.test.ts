/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Pipeline K's roofs, seen from above (pipeline-k/texture-harmonize.ts surfaceClassMasks, tile-refine-twin.ts): a roof is an
 * up-facing surface with nothing over it; an up-facing surface under another is hidden and counts as wall. The twin's
 * de-light lifts no shadow on a roof (a dark roof is a dark material: its colour is kept) and still lifts a wall's.
 */

import { describe, expect, it } from 'vitest';
import { assembleGlb, parseGlbBytes } from '../src/node/3d-engine/staged-location/glb-bytes';
import { encodePng } from '../src/node/3d-engine/staged-location/png-encode';
import { surfaceClassMasks, TEXEL_ROOF, TEXEL_WALL } from '../src/node/3d-engine/staged-location/pipeline-k/texture-harmonize';
import { tileRefineTwin } from '../src/node/3d-engine/staged-location/tile-refine-twin';
import { decodeImageInMemory, type RgbaImage8 } from '../src/node/3d-engine/staged-location/tile-texture-transfer';

const N = 32;
/** A flat maroon photo, the colour of the ESB's podium roofs (sRGB 92, 40, 38). */
function maroon(): RgbaImage8 {
    const rgba = new Uint8Array(N * N * 4);
    for (let k = 0; k < N * N; k++) rgba.set([92, 40, 38, 255], k * 4);
    return { width: N, height: N, rgba };
}

/** Quads (four corners each, wound so the normal faces the way named), each UV-mapped to its own embedded PNG. */
function scene(quads: number[][]): Uint8Array {
    const uv = new Float32Array([0, 0, 0, 1, 1, 1, 1, 0]);
    const idx = new Uint32Array([0, 1, 2, 0, 2, 3]);
    const png = encodePng(N, N, maroon().rgba, 4);
    const chunks: Uint8Array[] = [];
    const views: any[] = [];
    let length = 0;
    const push = (b: Uint8Array) => { views.push({ buffer: 0, byteOffset: length, byteLength: b.length }); chunks.push(b); length += b.length; const pad = (4 - (length % 4)) % 4; if (pad) { chunks.push(new Uint8Array(pad)); length += pad; } return views.length - 1; };
    const accessors: any[] = [];
    const meshes = quads.map((corners, k) => {
        const pos = push(new Uint8Array(new Float32Array(corners).buffer)), tex = push(new Uint8Array(uv.buffer)), ind = push(new Uint8Array(idx.buffer));
        accessors.push({ bufferView: pos, componentType: 5126, count: 4, type: 'VEC3' }, { bufferView: tex, componentType: 5126, count: 4, type: 'VEC2' }, { bufferView: ind, componentType: 5125, count: 6, type: 'SCALAR' });
        return { primitives: [{ attributes: { POSITION: 3 * k, TEXCOORD_0: 3 * k + 1 }, indices: 3 * k + 2, material: k, mode: 4 }] };
    });
    const images = quads.map(() => ({ bufferView: push(new Uint8Array(png)), mimeType: 'image/png' }));
    const bin = new Uint8Array(length);
    let o = 0;
    for (const c of chunks) { bin.set(c, o); o += c.length; }
    const json = {
        asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: quads.map((_, k) => k) }], nodes: quads.map((_, k) => ({ mesh: k })), meshes,
        materials: quads.map((_, k) => ({ pbrMetallicRoughness: { baseColorTexture: { index: k } } })),
        textures: quads.map((_, k) => ({ source: k })), images, accessors, bufferViews: views, buffers: [{ byteLength: bin.length }]
    };
    return assembleGlb(json as never, bin);
}

/** A 10 m square facing up at height y; a 10 m square wall facing +z at z = 0, from y0 to y0 + 10. */
const roofAt = (y: number) => [0, y, 0, 0, y, 10, 10, y, 10, 10, y, 0];
const wallAt = (y0: number) => [0, y0, 0, 10, y0, 0, 10, y0 + 10, 0, 0, y0 + 10, 0];

const meanRgb = (im: RgbaImage8) => {
    const s = [0, 0, 0];
    for (let k = 0; k < im.width * im.height; k++) for (let c = 0; c < 3; c++) s[c] += im.rgba[k * 4 + c];
    return s.map(v => v / (im.width * im.height));
};

/** The photo each primitive of a twin's GLB now shows, decoded. */
function shownPhotos(glb: Uint8Array): RgbaImage8[] {
    const g = parseGlbBytes(glb);
    const json: any = g.json;
    return json.meshes.map((m: any) => {
        const src = json.textures[json.materials[m.primitives[0].material].pbrMetallicRoughness.baseColorTexture.index].source;
        const view = json.bufferViews[json.images[src].bufferView];
        return decodeImageInMemory(g.bin.subarray(view.byteOffset ?? 0, (view.byteOffset ?? 0) + view.byteLength));
    });
}

describe('pipeline K roofs seen from above', () => {
    it('tells a roof from an up-facing surface hidden under it, and from a wall', () => {
        const g = parseGlbBytes(scene([roofAt(10), roofAt(3), wallAt(10)]));
        const sizes = new Map([0, 1, 2].map(k => [k, { width: N, height: N }]));
        const masks = surfaceClassMasks(g, g.json, sizes);
        const share = (k: number, cls: number) => masks.get(k)!.filter(v => v === cls).length / (N * N);
        expect(share(0, TEXEL_ROOF)).toBeGreaterThan(0.95);
        expect(share(1, TEXEL_ROOF)).toBe(0);
        expect(share(1, TEXEL_WALL)).toBeGreaterThan(0.95);
        expect(share(2, TEXEL_WALL)).toBeGreaterThan(0.95);
    });

    it("keeps a dark roof's colour through the de-light, and still lifts a wall", async () => {
        const glb = scene([roofAt(20), wallAt(0)]);
        const twin = await tileRefineTwin(glb, 'l2', { harmonize: { groundY: 0 } });
        const [roof, wall] = shownPhotos(twin.glb).map(meanRgb);
        const src = meanRgb(maroon());
        // the roof is as photographed (within a JPEG/PNG rounding step); the wall was lifted toward grey
        for (let c = 0; c < 3; c++) expect(Math.abs(roof[c] - src[c])).toBeLessThan(2);
        expect(wall[1]).toBeGreaterThan(src[1] + 20);
        expect((wall[0] - wall[2]) / wall[0]).toBeLessThan((src[0] - src[2]) / src[0]);
        expect(twin.provenance[0].method).toMatch(/roofs seen from above \(\d+ texels\) highlights only, no shadow lift/);
    });
});
