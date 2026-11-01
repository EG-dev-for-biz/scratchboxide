/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Pipeline K's texture harmonisation (pipeline-k/texture-harmonize.ts): one wall made of two quads side by side, each with
 * its own photo of the same striped stone, one photo exposed 60% brighter. After harmonising, the two photos agree where
 * they meet (the patch difference falls), the stripes (the detail) are kept, and a single-photo surface is left alone.
 */

import { describe, expect, it } from 'vitest';
import { assembleGlb, parseGlbBytes } from '../src/node/3d-engine/staged-location/glb-bytes';
import { harmonizeTextures, TEXTURE_HARMONIZE_PARAMS } from '../src/node/3d-engine/staged-location/pipeline-k/texture-harmonize';
import type { RgbaImage8 } from '../src/node/3d-engine/staged-location/tile-texture-transfer';

const N = 64;
function stripes(gain: number): RgbaImage8 {
    const rgba = new Uint8Array(N * N * 4);
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
        const v = Math.min(255, Math.round((x % 8 < 4 ? 150 : 90) * gain));
        rgba.set([v, Math.round(v * 0.95), Math.round(v * 0.9), 255], (y * N + x) * 4);
    }
    return { width: N, height: N, rgba };
}

/** Two 10 m x 10 m quads in the plane z = 0 facing +z, side by side (x 0..10 and 10..20), each UV-mapped to its own image. */
function wall(): ReturnType<typeof parseGlbBytes> {
    const quad = (x0: number) => new Float32Array([x0, 0, 0, x0 + 10, 0, 0, x0 + 10, 10, 0, x0, 10, 0]);
    const uv = new Float32Array([0, 1, 1, 1, 1, 0, 0, 0]);
    const idx = new Uint32Array([0, 1, 2, 0, 2, 3]);
    const parts = [quad(0), uv, idx, quad(10), uv, idx];
    const bytes: number[] = [];
    const views: any[] = [];
    for (const p of parts) { const b = new Uint8Array(p.buffer); views.push({ buffer: 0, byteOffset: bytes.length, byteLength: b.length }); bytes.push(...b); }
    const acc = (bv: number, count: number, type: string, ct: number) => ({ bufferView: bv, componentType: ct, count, type });
    const json = {
        asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0, 1] }], nodes: [{ mesh: 0 }, { mesh: 1 }],
        meshes: [0, 1].map(k => ({ primitives: [{ attributes: { POSITION: 3 * k, TEXCOORD_0: 3 * k + 1 }, indices: 3 * k + 2, material: k, mode: 4 }] })),
        materials: [0, 1].map(k => ({ pbrMetallicRoughness: { baseColorTexture: { index: k } } })),
        textures: [{ source: 0 }, { source: 1 }], images: [{ uri: 'a.png' }, { uri: 'b.png' }],
        accessors: [acc(0, 4, 'VEC3', 5126), acc(1, 4, 'VEC2', 5126), acc(2, 6, 'SCALAR', 5125), acc(3, 4, 'VEC3', 5126), acc(4, 4, 'VEC2', 5126), acc(5, 6, 'SCALAR', 5125)],
        bufferViews: views, buffers: [{ byteLength: bytes.length }]
    };
    return parseGlbBytes(assembleGlb(json as never, Uint8Array.from(bytes)));
}

const meanLuma = (im: RgbaImage8, x0: number, x1: number) => { let s = 0, n = 0; for (let y = 0; y < N; y++) for (let x = x0; x < x1; x++) { s += im.rgba[(y * N + x) * 4 + 1]; n++; } return s / n; };

describe('pipeline K texture harmonisation', () => {
    it('brings two photos of one wall to one colour where they meet, keeping their detail', () => {
        const g = wall();
        const images = new Map<number, RgbaImage8>([[0, stripes(1)], [1, stripes(1.6)]]);
        const before = meanLuma(images.get(1)!, 0, 8) / meanLuma(images.get(0)!, N - 8, N);
        const r = harmonizeTextures(g, g.json, images, 0);
        expect(r.kept).toBe(true);
        expect(r.seams.pairs).toBeGreaterThan(0);
        expect(r.seams.after).toBeLessThan(0.5 * r.seams.before);
        // at the seam (photo 0's right edge against photo 1's left edge) the brightness ratio is much closer to 1
        const after = meanLuma(images.get(1)!, 0, 8) / meanLuma(images.get(0)!, N - 8, N);
        expect(Math.abs(Math.log(after))).toBeLessThan(0.4 * Math.abs(Math.log(before)));
        // the stripes are kept: light and dark columns of each photo still differ clearly
        for (const k of [0, 1]) { const im = images.get(k)!; expect(im.rgba[(10 * N + 1) * 4 + 1] - im.rgba[(10 * N + 5) * 4 + 1]).toBeGreaterThan(25); }
    });

    it('keeps two buildings apart in a district: neither colour is matched to the other, even where they meet flush', () => {
        const g = wall();
        const images = new Map<number, RgbaImage8>([[0, stripes(1)], [1, stripes(1.6)]]);
        const before = meanLuma(images.get(1)!, 0, N);
        // the left quad (x 0..10) one building, the right (x 10..20) another
        const r = harmonizeTextures(g, g.json, images, 0, undefined, undefined, { buildingOf: x => (x < 10 ? 0 : 1) });
        expect(r.seams.pairs).toBe(0);
        expect(r.gains.maxAbsLog).toBe(0);
        expect(Math.abs(meanLuma(images.get(1)!, 0, N) - before)).toBeLessThan(2);
        // the same two photos on one building are matched
        const g2 = wall(), im2 = new Map<number, RgbaImage8>([[0, stripes(1)], [1, stripes(1.6)]]);
        const r2 = harmonizeTextures(g2, g2.json, im2, 0, undefined, undefined, { buildingOf: () => 0 });
        expect(r2.seams.pairs).toBeGreaterThan(0);
        expect(r2.kept).toBe(true);
    });

    it("does not tint the stone after the dark windows' colour noise (the log floor)", () => {
        // two photos of one wall, the same exposure and the same stone; only the near-black windows differ, by a green-poor
        // cast of a few sRGB levels (the noise a photo's shadows carry)
        const wallPhoto = (window: [number, number, number]): RgbaImage8 => {
            const rgba = new Uint8Array(N * N * 4);
            for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) rgba.set([...(x % 8 < 4 ? [150, 140, 125] : window), 255], (y * N + x) * 4);
            return { width: N, height: N, rgba };
        };
        const stoneGreenShare = (im: RgbaImage8) => { let g = 0, s = 0; for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) if (x % 8 < 4) { const o = (y * N + x) * 4; g += im.rgba[o + 1]; s += im.rgba[o] + im.rgba[o + 1] + im.rgba[o + 2]; } return g / s; };
        const run = (logFloor?: number) => {
            const g = wall(), images = new Map<number, RgbaImage8>([[0, wallPhoto([12, 12, 12])], [1, wallPhoto([12, 6, 14])]]);
            expect(harmonizeTextures(g, g.json, images, 0, logFloor === undefined ? undefined : { ...TEXTURE_HARMONIZE_PARAMS, logFloor }).kept).toBe(true);
            // the larger shift of the stone's green share, either photo (the pair is levelled toward each other)
            return Math.max(...[0, 1].map(k => Math.abs(stoneGreenShare(images.get(k)!) / stoneGreenShare(wallPhoto([0, 0, 0])) - 1)));
        };
        // the default floor: the stone keeps its hue; a floor at the 8-bit black level lets the windows' noise tint it
        expect(run()).toBeLessThan(0.01);
        expect(run(1e-3)).toBeGreaterThan(0.025);
    });

    it('leaves a single photo as it was', () => {
        const g = wall();
        const one = stripes(1);
        const images = new Map<number, RgbaImage8>([[0, one]]);
        const r = harmonizeTextures(g, g.json, images, 0);
        expect(r.kept).toBe(false);
        expect(images.get(0)).toBe(one);
    });
});
