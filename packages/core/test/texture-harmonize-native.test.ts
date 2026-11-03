/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Pipeline K's native texture harmonisation (pipeline-k/native/texture-harmonize-native.ts over
 * scratchbox_texture_harmonize.hpp) against the TypeScript it translates (pipeline-k/texture-harmonize.ts), on a box
 * building whose walls are photographed in two overlapping bands (a seam where they overlap), a roof and a hidden floor
 * inside, every photo exposed differently. The class masks and the harmonised photos must equal the TypeScript's byte for
 * byte, and the report field for field (its figures are rounded to four places on both sides; the libm exp/log/pow/atan2
 * may differ from V8's in the last bit, which could only move a rounded figure at an exact tie, so the figures are
 * compared after the same rounding). Also timed at a realistic size (about 500k triangles over eight 2048 x 2048 photos).
 */

import { describe, expect, it } from 'vitest';
import { assembleGlb, parseGlbBytes, type ParsedGlb } from '../src/node/3d-engine/staged-location/glb-bytes';
import { harmonizeTextures, surfaceClassMasks, TEXEL_ROOF, TEXEL_WALL, TEXTURE_HARMONIZE_PARAMS, type TextureHarmonizeReport } from '../src/node/3d-engine/staged-location/pipeline-k/texture-harmonize';
import { ensureTextureHarmonizeNativeBinary, harmonizeTexturesNative, harmonizeTexturesNativeDetailed, surfaceClassMasksNative } from '../src/node/3d-engine/staged-location/pipeline-k/native/texture-harmonize-native';
import type { RgbaImage8 } from '../src/node/3d-engine/staged-location/tile-texture-transfer';

type V3 = [number, number, number];
interface Piece { o: V3; e1: V3; e2: V3; out: V3; ns: number; nt: number; photo: number; uv: [number, number, number, number] }

const hash = (x: number, y: number, z: number) => { const s = Math.sin(x * 12.9898 + y * 78.233 + z * 37.719) * 43758.5453; return s - Math.floor(s); };

/**
 * A W x D x H box: each wall in a lower (0..0.6H) and an upper (0.45H..H) band, a roof and a hidden floor at H/2, both in
 * quadrants. `perWallPhotos`: each wall band its own photo, the roof and floor quadrants in the upper and lower photos (8
 * photos); else three photos: all lower bands, all upper bands, roof and floor. Each photo is painted from the world
 * point its texels map to (stone, windows, roof), times its own exposure.
 */
function boxBuilding(o: { W: number; D: number; H: number; cell: number; tex: number; perWallPhotos: boolean }): { g: ParsedGlb; images: Map<number, RgbaImage8> } {
    const { W, D, H, cell, tex } = o;
    const pieces: Piece[] = [];
    const walls: Array<{ o: V3; e1: V3; out: V3 }> = [
        { o: [0, 0, 0], e1: [W, 0, 0], out: [0, 0, -1] }, { o: [W, 0, 0], e1: [0, 0, D], out: [1, 0, 0] },
        { o: [W, 0, D], e1: [-W, 0, 0], out: [0, 0, 1] }, { o: [0, 0, D], e1: [0, 0, -D], out: [-1, 0, 0] }
    ];
    walls.forEach((w, k) => {
        const len = Math.hypot(...w.e1);
        for (const [lev, [y0, y1]] of [[0, 0.6 * H], [0.45 * H, H]].entries()) {
            const photo = o.perWallPhotos ? 2 * k + lev : lev;
            const uv: Piece['uv'] = o.perWallPhotos ? [0, 0, 1, 0.85] : [k / 4, 0, (k + 1) / 4, 0.85];
            pieces.push({ o: [w.o[0], y0, w.o[2]], e1: w.e1, e2: [0, y1 - y0, 0], out: w.out, ns: Math.ceil(len / cell), nt: Math.ceil((y1 - y0) / cell), photo, uv });
        }
    });
    for (const [q, [qx, qz]] of [[0, 0], [1, 0], [0, 1], [1, 1]].entries()) {
        const roofPhoto = o.perWallPhotos ? 2 * q + 1 : 2, slabPhoto = o.perWallPhotos ? 2 * q : 2;
        const uvR: Piece['uv'] = o.perWallPhotos ? [0, 0.86, 1, 1] : [q / 4, 0.86, (q + 1) / 4, 0.92];
        const uvS: Piece['uv'] = o.perWallPhotos ? [0, 0.86, 1, 1] : [q / 4, 0.93, (q + 1) / 4, 1];
        const sx = W / 2, sz = D / 2;
        pieces.push({ o: [qx * sx, H, qz * sz], e1: [sx, 0, 0], e2: [0, 0, sz], out: [0, 1, 0], ns: Math.ceil(sx / cell), nt: Math.ceil(sz / cell), photo: roofPhoto, uv: uvR });
        pieces.push({ o: [qx * sx + 0.5, H / 2, qz * sz + 0.5], e1: [sx - 1, 0, 0], e2: [0, 0, sz - 1], out: [0, 1, 0], ns: Math.ceil(sx / cell), nt: Math.ceil(sz / cell), photo: slabPhoto, uv: uvS });
    }
    const nPhotos = o.perWallPhotos ? 8 : 3;
    const exposure = Array.from({ length: nPhotos }, (_, i) => 0.7 + 0.8 * hash(i, 1, 2));
    const prims = Array.from({ length: nPhotos }, () => ({ pos: [] as number[], uv: [] as number[], idx: [] as number[] }));
    for (const p of pieces) {
        const pr = prims[p.photo], base = pr.pos.length / 3;
        const n = [p.e1[1] * p.e2[2] - p.e1[2] * p.e2[1], p.e1[2] * p.e2[0] - p.e1[0] * p.e2[2], p.e1[0] * p.e2[1] - p.e1[1] * p.e2[0]];
        const flip = n[0] * p.out[0] + n[1] * p.out[1] + n[2] * p.out[2] < 0;
        for (let j = 0; j <= p.nt; j++) for (let i = 0; i <= p.ns; i++) {
            const s = i / p.ns, t = j / p.nt;
            pr.pos.push(p.o[0] + s * p.e1[0] + t * p.e2[0], p.o[1] + s * p.e1[1] + t * p.e2[1], p.o[2] + s * p.e1[2] + t * p.e2[2]);
            pr.uv.push(p.uv[0] + s * (p.uv[2] - p.uv[0]), p.uv[1] + t * (p.uv[3] - p.uv[1]));
        }
        for (let j = 0; j < p.nt; j++) for (let i = 0; i < p.ns; i++) {
            const a = base + j * (p.ns + 1) + i, b = a + 1, c = a + p.ns + 1, d = c + 1;
            if (flip) pr.idx.push(a, c, b, b, c, d); else pr.idx.push(a, b, c, b, d, c);
        }
    }
    const chunks: Uint8Array[] = [], views: any[] = [], accessors: any[] = [];
    let off = 0;
    const add = (arr: Float32Array | Uint32Array, count: number, type: string, ct: number) => {
        const b = new Uint8Array(arr.buffer); views.push({ buffer: 0, byteOffset: off, byteLength: b.length }); chunks.push(b); off += b.length;
        accessors.push({ bufferView: views.length - 1, componentType: ct, count, type });
        return accessors.length - 1;
    };
    const meshes = prims.map((pr, k) => {
        const P = add(Float32Array.from(pr.pos), pr.pos.length / 3, 'VEC3', 5126), T = add(Float32Array.from(pr.uv), pr.uv.length / 2, 'VEC2', 5126), I = add(Uint32Array.from(pr.idx), pr.idx.length, 'SCALAR', 5125);
        return { primitives: [{ attributes: { POSITION: P, TEXCOORD_0: T }, indices: I, material: k, mode: 4 }] };
    });
    const bin = new Uint8Array(off);
    let at = 0;
    for (const c of chunks) { bin.set(c, at); at += c.length; }
    const json = {
        asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: meshes.map((_, k) => k) }], nodes: meshes.map((_, k) => ({ mesh: k })), meshes,
        materials: meshes.map((_, k) => ({ pbrMetallicRoughness: { baseColorTexture: { index: k } } })),
        textures: meshes.map((_, k) => ({ source: k })), images: meshes.map((_, k) => ({ uri: `${k}.png` })), accessors, bufferViews: views, buffers: [{ byteLength: off }]
    };
    const g = parseGlbBytes(assembleGlb(json, bin));
    const images = new Map<number, RgbaImage8>();
    for (let ph = 0; ph < nPhotos; ph++) images.set(ph, { width: tex, height: tex, rgba: new Uint8Array(tex * tex * 4) });
    for (const p of pieces) {
        const im = images.get(p.photo)!, e = exposure[p.photo];
        const x0 = Math.floor(p.uv[0] * tex), x1 = Math.ceil(p.uv[2] * tex), y0 = Math.floor(p.uv[1] * tex), y1 = Math.ceil(p.uv[3] * tex);
        for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
            const s = ((x + 0.5) / tex - p.uv[0]) / (p.uv[2] - p.uv[0]), t = ((y + 0.5) / tex - p.uv[1]) / (p.uv[3] - p.uv[1]);
            const wx = p.o[0] + s * p.e1[0] + t * p.e2[0], wy = p.o[1] + s * p.e1[1] + t * p.e2[1], wz = p.o[2] + s * p.e1[2] + t * p.e2[2];
            const along = wx + wz, win = (along / 2.5) % 1 > 0.25 && (along / 2.5) % 1 < 0.7 && (wy / 3.5) % 1 > 0.3 && (wy / 3.5) % 1 < 0.8 && p.out[1] === 0;
            const nz = 0.85 + 0.3 * hash(Math.floor(wx * 4), Math.floor(wy * 4), Math.floor(wz * 4));
            const base = win ? [60, 75, 95] : p.out[1] ? [120, 118, 112] : [185, 165, 135];
            const k = (y * tex + x) * 4;
            for (let c = 0; c < 3; c++) im.rgba[k + c] = Math.min(255, Math.round(base[c] * nz * e));
            im.rgba[k + 3] = 255;
        }
    }
    return { g, images };
}

const copyImages = (m: Map<number, RgbaImage8>) => new Map([...m].map(([k, im]) => [k, { width: im.width, height: im.height, rgba: im.rgba.slice() }] as [number, RgbaImage8]));
const withoutMs = (r: TextureHarmonizeReport) => ({ ...r, ms: 0 });
/** Bytes that differ between two photo sets (same keys and sizes asserted). */
function differingBytes(a: Map<number, RgbaImage8>, b: Map<number, RgbaImage8>): number {
    expect([...a.keys()]).toEqual([...b.keys()]);
    let n = 0;
    for (const [k, im] of a) {
        const o = b.get(k)!;
        expect([o.width, o.height]).toEqual([im.width, im.height]);
        for (let i = 0; i < im.rgba.length; i++) if (im.rgba[i] !== o.rgba[i]) n++;
    }
    return n;
}

describe('pipeline K texture harmonisation, native', () => {
    it('builds its driver', async () => {
        expect(await ensureTextureHarmonizeNativeBinary()).toMatch(/bin$/);
    });

    for (const [name, opts] of [
        ['three photos', { W: 20, D: 16, H: 30, cell: 1, tex: 256, perWallPhotos: false }],
        ['eight photos', { W: 24, D: 24, H: 60, cell: 0.7, tex: 384, perWallPhotos: true }]
    ] as const) {
        it(`computes the TypeScript's class masks (${name})`, async () => {
            const { g, images } = boxBuilding(opts);
            const ts = surfaceClassMasks(g, g.json, images);
            const nat = await surfaceClassMasksNative(g, g.json, images);
            expect([...nat.keys()]).toEqual([...ts.keys()]);
            let roof = 0, wall = 0;
            for (const [k, m] of ts) {
                expect(Buffer.compare(Buffer.from(nat.get(k)!), Buffer.from(m))).toBe(0);
                for (const v of m) { if (v === TEXEL_ROOF) roof++; else if (v === TEXEL_WALL) wall++; }
            }
            // the fixture exercises both classes (the hidden floor is wall, the roof roof)
            expect(roof).toBeGreaterThan(100);
            expect(wall).toBeGreaterThan(1000);
        });

        it(`harmonises the photos as the TypeScript does (${name})`, async () => {
            const { g, images } = boxBuilding(opts);
            const a = copyImages(images), b = copyImages(images);
            const ts = harmonizeTextures(g, g.json, a, 0);
            const nat = await harmonizeTexturesNative(g, g.json, b, 0);
            expect(ts.kept).toBe(true);
            expect(ts.seams.pairs).toBeGreaterThan(10);
            if (opts.perWallPhotos) expect(ts.roofs.roofGains).toBeGreaterThan(0);
            expect(withoutMs(nat)).toEqual(withoutMs(ts));
            expect(differingBytes(a, b)).toBe(0);
            // and the photos did change
            expect(differingBytes(a, images)).toBeGreaterThan(1000);
        });
    }

    it('uses given masks as the TypeScript does, and leaves a single photo alone', async () => {
        const { g, images } = boxBuilding({ W: 20, D: 16, H: 30, cell: 1, tex: 256, perWallPhotos: false });
        // given masks: every texel of photo 2 roof, the others' as computed
        const masks = surfaceClassMasks(g, g.json, images);
        masks.get(2)!.fill(TEXEL_ROOF);
        const a = copyImages(images), b = copyImages(images);
        const ts = harmonizeTextures(g, g.json, a, 0, TEXTURE_HARMONIZE_PARAMS, masks);
        const nat = await harmonizeTexturesNative(g, g.json, b, 0, TEXTURE_HARMONIZE_PARAMS, masks);
        expect(withoutMs(nat)).toEqual(withoutMs(ts));
        expect(differingBytes(a, b)).toBe(0);
        // one photo: nothing to harmonise, the photo object kept
        const one = new Map([[0, images.get(0)!]]);
        const r = await harmonizeTexturesNative(g, g.json, one, 0);
        expect(withoutMs(r)).toEqual(withoutMs(harmonizeTextures(g, g.json, new Map([[0, images.get(0)!]]), 0)));
        expect(r.kept).toBe(false);
        expect(one.get(0)).toBe(images.get(0));
    });

    it('matches the TypeScript at a realistic size and reports both timings', async () => {
        await ensureTextureHarmonizeNativeBinary();
        const { g, images } = boxBuilding({ W: 40, D: 40, H: 120, cell: 0.32, tex: 2048, perWallPhotos: true });
        let triangles = 0;
        for (const a of g.json.accessors) if (a.type === 'SCALAR') triangles += a.count / 3;
        expect(triangles).toBeGreaterThan(450_000);
        const a = copyImages(images), b = copyImages(images);
        let t = Date.now();
        const ts = harmonizeTextures(g, g.json, a, 0);
        const tsMs = Date.now() - t;
        t = Date.now();
        const { report: nat, stats } = await harmonizeTexturesNativeDetailed(g, g.json, b, 0);
        const natMs = Date.now() - t;
        expect(withoutMs(nat)).toEqual(withoutMs(ts));
        expect(differingBytes(a, b)).toBe(0);
        t = Date.now();
        const tsMasks = surfaceClassMasks(g, g.json, images);
        const tsMaskMs = Date.now() - t;
        t = Date.now();
        const natMasks = await surfaceClassMasksNative(g, g.json, images);
        const natMaskMs = Date.now() - t;
        for (const [k, m] of tsMasks) expect(Buffer.compare(Buffer.from(natMasks.get(k)!), Buffer.from(m))).toBe(0);
        console.log(`texture harmonise, ${triangles} triangles, ${images.size} photos of 2048 x 2048, ${ts.samples} samples, ${ts.seams.pairs} seam pairs:\n`
            + `  harmonizeTextures   TS ${tsMs} ms, native ${natMs} ms (${(tsMs / natMs).toFixed(1)}x)\n`
            + `  native stages (ms): ${JSON.stringify(stats.ms)}, CG iterations ${stats.cgIterations.join('/')}\n`
            + `  surfaceClassMasks   TS ${tsMaskMs} ms, native ${natMaskMs} ms (${(tsMaskMs / natMaskMs).toFixed(1)}x)`);
    });
});
