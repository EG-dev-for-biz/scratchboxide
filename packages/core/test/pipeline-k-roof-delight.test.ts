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
 * de-light lifts no shadow on a roof (a dark roof is a dark material: its colour is kept); a twin's default de-light still
 * lifts a wall's, and pipeline K's lifts none there either (PIPELINE_K_SHADOW_LIFT): a storefront's glazing stays dark and
 * the stone above keeps its colour and contrast.
 */

import { describe, expect, it } from 'vitest';
import { assembleGlb, parseGlbBytes } from '../src/node/3d-engine/staged-location/glb-bytes';
import { encodePng } from '../src/node/3d-engine/staged-location/png-encode';
import { surfaceClassMasks, TEXEL_ROOF, TEXEL_WALL } from '../src/node/3d-engine/staged-location/pipeline-k/texture-harmonize';
import { PIPELINE_K_SHADOW_LIFT, tileRefineTwin } from '../src/node/3d-engine/staged-location/tile-refine-twin';
import { decodeImageInMemory, type RgbaImage8 } from '../src/node/3d-engine/staged-location/tile-texture-transfer';

const N = 32;
/** A flat maroon photo, the colour of the ESB's podium roofs (sRGB 92, 40, 38). */
function maroon(): RgbaImage8 {
    const rgba = new Uint8Array(N * N * 4);
    for (let k = 0; k < N * N; k++) rgba.set([92, 40, 38, 255], k * 4);
    return { width: N, height: N, rgba };
}

/**
 * A storefront in stone (sRGB): warm limestone in a two-texel weave (the stone's grain) over the top two thirds, the lowest
 * third dark glazing split by a lighter mullion every eighth column. Rows run from the photo's top (v = 0, the quad's base).
 */
function storefront(): RgbaImage8 {
    const rgba = new Uint8Array(N * N * 4);
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
        const glazing = y < N / 3, grain = (x + y) % 2 ? 12 : -12;
        rgba.set(glazing ? (x % 8 === 0 ? [70, 70, 72, 255] : [28, 30, 34, 255]) : [150 + grain, 132 + grain, 104 + grain, 255], (y * N + x) * 4);
    }
    return { width: N, height: N, rgba };
}

/** Quads (four corners each, wound so the normal faces the way named), each UV-mapped to its own embedded PNG of `photo`. */
function scene(quads: number[][], photo: RgbaImage8 = maroon()): Uint8Array {
    const uv = new Float32Array([0, 0, 0, 1, 1, 1, 1, 0]);
    const idx = new Uint32Array([0, 1, 2, 0, 2, 3]);
    const png = encodePng(N, N, photo.rgba, 4);
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

    it('pipeline K lifts no shadow on a wall either: a dark wall keeps its colour', async () => {
        const glb = scene([roofAt(20), wallAt(0)]);
        const twin = await tileRefineTwin(glb, 'l2', { harmonize: { groundY: 0 }, shadowLift: PIPELINE_K_SHADOW_LIFT });
        const [roof, wall] = shownPhotos(twin.glb).map(meanRgb);
        const src = meanRgb(maroon());
        for (let c = 0; c < 3; c++) { expect(Math.abs(roof[c] - src[c])).toBeLessThan(2); expect(Math.abs(wall[c] - src[c])).toBeLessThan(2); }
        expect(twin.provenance[0].method).toMatch(/highlights compressed \(highlightCompress 0\.45\), no shadow lift/);
    });

    it("keeps a storefront's dark glazing and the stone's colour and contrast in pipeline K, where the default lift greys them", async () => {
        const glb = scene([wallAt(0)], storefront());
        const src = storefront();
        const [k] = shownPhotos((await tileRefineTwin(glb, 'l2', { harmonize: { groundY: 0 }, shadowLift: PIPELINE_K_SHADOW_LIFT })).glb);
        const [lifted] = shownPhotos((await tileRefineTwin(glb, 'l2', { harmonize: { groundY: 0 } })).glb);
        // per region of the photo: mean luma, its spread, and the stone's warmth (R - B)
        const region = (im: RgbaImage8, glazing: boolean) => {
            const L: number[] = [];
            let warm = 0;
            for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
                if ((y < N / 3) !== glazing || (glazing && x % 8 === 0)) continue;
                const o = (y * N + x) * 4;
                L.push(0.2126 * im.rgba[o] + 0.7152 * im.rgba[o + 1] + 0.0722 * im.rgba[o + 2]);
                warm += im.rgba[o] - im.rgba[o + 2];
            }
            const mean = L.reduce((a, b) => a + b, 0) / L.length;
            return { mean, sd: Math.sqrt(L.reduce((a, b) => a + (b - mean) ** 2, 0) / L.length), warm: warm / L.length };
        };
        const [g0, gk, gl] = [src, k, lifted].map(im => region(im, true));
        const [s0, sk, sl] = [src, k, lifted].map(im => region(im, false));
        // the glazing stays as dark as photographed (harmonising one photo against itself moves it by a few levels at most)
        expect(Math.abs(gk.mean - g0.mean)).toBeLessThan(4);
        // the stone keeps its grain and its warmth
        expect(sk.sd).toBeGreaterThan(0.9 * s0.sd);
        expect(sk.warm).toBeGreaterThan(0.9 * s0.warm);
        // the default lift is what greyed them: the glazing lifted toward the stone, the stone's grain and warmth flattened
        expect(gl.mean).toBeGreaterThan(g0.mean + 30);
        expect(sl.mean - gl.mean).toBeLessThan(0.75 * (s0.mean - g0.mean));
        expect(sl.warm).toBeLessThan(0.9 * s0.warm);
    });

    it('a district (K-D) lifts its upward surfaces gently when asked, and leaves them as photographed when not', async () => {
        const glb = scene([roofAt(20), wallAt(0)]);
        const src = meanRgb(maroon());
        const [roof0, wall0] = shownPhotos((await tileRefineTwin(glb, 'l2', { harmonize: { groundY: 0 } })).glb).map(meanRgb);
        const [roof3, wall3] = shownPhotos((await tileRefineTwin(glb, 'l2', { harmonize: { groundY: 0 }, upwardShadowLift: 0.3 })).glb).map(meanRgb);
        const [roof6] = shownPhotos((await tileRefineTwin(glb, 'l2', { harmonize: { groundY: 0 }, upwardShadowLift: 0.6 })).glb).map(meanRgb);
        // off: the roof as photographed; on: lifted, more at 0.6 than 0.3
        for (let c = 0; c < 3; c++) expect(Math.abs(roof0[c] - src[c])).toBeLessThan(2);
        expect(roof3[1]).toBeGreaterThan(src[1] + 5);
        expect(roof6[1]).toBeGreaterThan(roof3[1] + 5);
        // the wall's lift is the same either way
        for (let c = 0; c < 3; c++) expect(Math.abs(wall3[c] - wall0[c])).toBeLessThan(2);
    });

    it('gives a texel an upward surface and a wall share to the upward one when asked (sharedTexel: up)', () => {
        // a roof and a wall drawing the same photo: every texel is shared
        const g = parseGlbBytes(scene([roofAt(10), wallAt(10)]));
        const json: any = g.json;
        json.materials[1].pbrMetallicRoughness.baseColorTexture.index = 0;
        const sizes = new Map([[0, { width: N, height: N }]]);
        const share = (m: Uint8Array, cls: number) => m.filter(v => v === cls).length / (N * N);
        expect(share(surfaceClassMasks(g, json, sizes).get(0)!, TEXEL_WALL)).toBeGreaterThan(0.95);
        expect(share(surfaceClassMasks(g, json, sizes, undefined, { sharedTexel: 'up' }).get(0)!, TEXEL_ROOF)).toBeGreaterThan(0.95);
    });
});
