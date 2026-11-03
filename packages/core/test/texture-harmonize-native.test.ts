/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Harmonising's native apply (scratchbox_twin_texels.hpp, pipeline-k/native/twin-texels-native.ts) against the
 * TypeScript it replaces (texture-harmonize.ts, SCRATCHBOX_K_NATIVE=0). Every comparison is exact: the report field for
 * field (but its times) and every texel.
 * - The 8-bit sRGB encoder's thresholds give the code JavaScript rounds to.
 * - Two walls and two roofs, each its own photo at its own exposure: also on 3 threads with one photo a batch.
 * - A box building whose walls are photographed in two overlapping bands (a seam where they overlap), a roof and a hidden
 *   floor inside, every photo exposed differently: in three photos and in eight, with given masks, and a single photo
 *   left alone.
 * - The box at a realistic size (about 500k triangles over eight 2048 x 2048 photos), with one timing line, TypeScript
 *   against native (vitest --silent=false shows it).
 */

import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { assembleGlb, parseGlbBytes, type ParsedGlb } from '../src/node/3d-engine/staged-location/glb-bytes';
import { harmonizeTextures, surfaceClassMasks, TEXEL_ROOF, TEXTURE_HARMONIZE_PARAMS, type TextureHarmonizeReport } from '../src/node/3d-engine/staged-location/pipeline-k/texture-harmonize';
import { ensureNativeTwinBinary, srgb8Thresholds } from '../src/node/3d-engine/staged-location/pipeline-k/native/twin-texels-native';
import { SRGB8_TO_LINEAR, linearToSrgb255 } from '../src/common/spatial/photogrammetric-delight';
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

/** Two walls (z = 0, facing +z) and two roofs behind them (y = 10), each its own photo (N x N) at its own exposure. */
function wallsAndRoofs(N: number): { g: ParsedGlb; images: Map<number, RgbaImage8> } {
    const gains = [1, 1.6, 0.8, 1.3];
    const roof = (x0: number, x1: number) => ({ pos: [x0, 10, -10, x1, 10, -10, x1, 10, 0, x0, 10, 0], uv: [0, 0, 1, 0, 1, 1, 0, 1], idx: [0, 2, 1, 0, 3, 2] });
    const prims = [
        { pos: [0, 0, 0, 10, 0, 0, 10, 10, 0, 0, 10, 0], uv: [0, 1, 1, 1, 1, 0, 0, 0], idx: [0, 1, 2, 0, 2, 3] },
        { pos: [10, 0, 0, 20, 0, 0, 20, 10, 0, 10, 10, 0], uv: [0, 1, 1, 1, 1, 0, 0, 0], idx: [0, 1, 2, 0, 2, 3] },
        roof(0, 10), roof(10, 20)
    ];
    const bytes: number[] = [], views: any[] = [], accessors: any[] = [];
    const add = (arr: Float32Array | Uint32Array, type: string, ct: number, count: number) => {
        const b = new Uint8Array(arr.buffer);
        views.push({ buffer: 0, byteOffset: bytes.length, byteLength: b.length });
        for (const v of b) bytes.push(v);
        accessors.push({ bufferView: views.length - 1, componentType: ct, count, type });
        return accessors.length - 1;
    };
    const meshes = prims.map((p, k) => ({ primitives: [{ attributes: { POSITION: add(new Float32Array(p.pos), 'VEC3', 5126, 4), TEXCOORD_0: add(new Float32Array(p.uv), 'VEC2', 5126, 4) }, indices: add(new Uint32Array(p.idx), 'SCALAR', 5125, 6), material: k, mode: 4 }] }));
    const json = {
        asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0, 1, 2, 3] }], nodes: meshes.map((_, k) => ({ mesh: k })), meshes,
        materials: meshes.map((_, k) => ({ pbrMetallicRoughness: { baseColorTexture: { index: k } } })), textures: meshes.map((_, k) => ({ source: k })), images: meshes.map((_, k) => ({ uri: `${k}.png` })),
        accessors, bufferViews: views, buffers: [{ byteLength: bytes.length }]
    };
    const g = parseGlbBytes(assembleGlb(json as never, Uint8Array.from(bytes)));
    const images = new Map<number, RgbaImage8>();
    gains.forEach((gain, k) => {
        const rgba = new Uint8Array(N * N * 4);
        for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
            const grain = ((Math.sin(x * 12.9898 + y * 78.233 + k * 3.1) * 43758.5453) % 1 + 1) % 1;
            const v = (0.16 + 0.07 * Math.sin((x / N) * 13) * Math.cos((y / N) * 7) + 0.05 * grain) * gain, o = (y * N + x) * 4;
            for (const [c, tint] of [1, 0.93, 0.82].entries()) rgba[o + c] = Math.round(linearToSrgb255(v * tint));
            rgba[o + 3] = 255;
        }
        images.set(k, { width: N, height: N, rgba });
    });
    return { g, images };
}

const copyImages = (m: Map<number, RgbaImage8>) => new Map([...m].map(([k, im]) => [k, { width: im.width, height: im.height, rgba: im.rgba.slice() }] as [number, RgbaImage8]));
const withoutTimes = (r: TextureHarmonizeReport) => ({ ...r, ms: 0, phasesMs: undefined });

/** Texels a run changed (against the input), and texels two runs disagree on. */
function changedTexels(input: Map<number, RgbaImage8>, a: Map<number, RgbaImage8>, b: Map<number, RgbaImage8>): { a: number; differ: number } {
    expect([...a.keys()]).toEqual([...b.keys()]);
    let changed = 0, differ = 0;
    for (const [k, im] of input) {
        const ra = a.get(k)!.rgba, rb = b.get(k)!.rgba;
        expect([a.get(k)!.width, a.get(k)!.height, rb.length]).toEqual([im.width, im.height, im.rgba.length]);
        for (let i = 0; i < im.rgba.length; i += 4) {
            let ca = false, d = false;
            for (let c = 0; c < 4; c++) { if (ra[i + c] !== im.rgba[i + c]) ca = true; if (ra[i + c] !== rb[i + c]) d = true; }
            if (ca) changed++;
            if (d) differ++;
        }
    }
    return { a: changed, differ };
}

/** harmonizeTextures with SCRATCHBOX_K_NATIVE=0 (the TypeScript) or unset (native), on copies of the photos. */
function harmonize(g: ParsedGlb, images: Map<number, RgbaImage8>, native: boolean, masks?: Map<number, Uint8Array>, opts: { threads?: number; nativeBatchBytes?: number } = {}) {
    if (native) delete process.env.SCRATCHBOX_K_NATIVE; else process.env.SCRATCHBOX_K_NATIVE = '0';
    const photos = copyImages(images), t = performance.now();
    const report = harmonizeTextures(g, g.json, photos, 0, TEXTURE_HARMONIZE_PARAMS, masks, opts);
    return { report, photos, ms: performance.now() - t };
}

describe('harmonising: the native apply against the TypeScript', () => {
    beforeAll(async () => { await ensureNativeTwinBinary(); }, 300_000);
    afterEach(() => { delete process.env.SCRATCHBOX_K_NATIVE; });

    it('reads the 8-bit sRGB code from its thresholds as JavaScript rounds it', () => {
        const t = srgb8Thresholds();
        const code = (x: number) => { let k = 0; while (k < 255 && t[k] <= x) k++; return k; };
        for (let k = 0; k < 255; k++) {
            expect(Math.round(linearToSrgb255(t[k]))).toBe(k + 1);
            expect(Math.round(linearToSrgb255(t[k] - Number.EPSILON * t[k]))).toBeLessThanOrEqual(k);
        }
        for (let v = 0; v < 256; v++) expect(code(SRGB8_TO_LINEAR[v])).toBe(v);
    });

    it('two walls and two roofs: the same report and photos, also on 3 threads with one photo a batch', () => {
        const { g, images } = wallsAndRoofs(512);
        const masks = surfaceClassMasks(g, g.json, images);
        const a = harmonize(g, images, false, masks), b = harmonize(g, images, true, masks), c = harmonize(g, images, true, masks, { threads: 3, nativeBatchBytes: 1 });
        expect(a.report.kept).toBe(true);
        expect(a.report.roofs.roofGains).toBeGreaterThanOrEqual(2);
        expect(withoutTimes(b.report)).toEqual(withoutTimes(a.report));
        expect(withoutTimes(c.report)).toEqual(withoutTimes(a.report));
        const d = changedTexels(images, a.photos, b.photos);
        expect(d.a).toBeGreaterThan(512 * 512);
        expect(d.differ).toBe(0);
        expect(changedTexels(images, b.photos, c.photos).differ).toBe(0);
    });

    for (const [name, opts] of [
        ['three photos', { W: 20, D: 16, H: 30, cell: 1, tex: 256, perWallPhotos: false }],
        ['eight photos', { W: 24, D: 24, H: 60, cell: 0.7, tex: 384, perWallPhotos: true }]
    ] as const) {
        it(`the box in ${name}: the same report and photos`, () => {
            const { g, images } = boxBuilding(opts);
            const a = harmonize(g, images, false), b = harmonize(g, images, true);
            expect(a.report.kept).toBe(true);
            expect(a.report.seams.pairs).toBeGreaterThan(10);
            if (opts.perWallPhotos) expect(a.report.roofs.roofGains).toBeGreaterThan(0);
            expect(withoutTimes(b.report)).toEqual(withoutTimes(a.report));
            const d = changedTexels(images, a.photos, b.photos);
            expect(d.a).toBeGreaterThan(1000);
            expect(d.differ).toBe(0);
        });
    }

    it('uses given masks as the TypeScript does, and leaves a single photo alone', () => {
        const { g, images } = boxBuilding({ W: 20, D: 16, H: 30, cell: 1, tex: 256, perWallPhotos: false });
        // given masks: every texel of photo 2 roof, the others' as computed
        const masks = surfaceClassMasks(g, g.json, images);
        masks.get(2)!.fill(TEXEL_ROOF);
        const a = harmonize(g, images, false, masks), b = harmonize(g, images, true, masks);
        expect(withoutTimes(b.report)).toEqual(withoutTimes(a.report));
        expect(changedTexels(images, a.photos, b.photos).differ).toBe(0);
        // one photo: nothing to harmonise, the photo object kept
        delete process.env.SCRATCHBOX_K_NATIVE;
        const one = new Map([[0, images.get(0)!]]);
        const r = harmonizeTextures(g, g.json, one, 0);
        expect(r.kept).toBe(false);
        expect(one.get(0)).toBe(images.get(0));
    });

    it('the box at a realistic size: the same report and photos, and the two timed', () => {
        const { g, images } = boxBuilding({ W: 40, D: 40, H: 120, cell: 0.32, tex: 2048, perWallPhotos: true });
        let triangles = 0;
        for (const acc of g.json.accessors) if (acc.type === 'SCALAR') triangles += acc.count / 3;
        expect(triangles).toBeGreaterThan(450_000);
        const a = harmonize(g, images, false), b = harmonize(g, images, true);
        expect(withoutTimes(b.report)).toEqual(withoutTimes(a.report));
        const d = changedTexels(images, a.photos, b.photos);
        expect(d.differ).toBe(0);
        const phases = (r: TextureHarmonizeReport) => Object.entries(r.phasesMs ?? {}).map(([k, v]) => `${k} ${v}`).join(', ');
        console.log(`[timing] harmonise, ${triangles} triangles, ${images.size} photos of 2048 x 2048, ${a.report.samples} samples, ${a.report.seams.pairs} seam pairs: TypeScript ${a.ms.toFixed(0)} ms (${phases(a.report)}), native ${b.ms.toFixed(0)} ms (${phases(b.report)}); apply ${((a.report.phasesMs?.apply ?? 0) / Math.max(1, b.report.phasesMs?.apply ?? 0)).toFixed(1)}x, whole ${(a.ms / b.ms).toFixed(1)}x; ${d.a} texels changed, ${d.differ} differ`);
    }, 300_000);
});
