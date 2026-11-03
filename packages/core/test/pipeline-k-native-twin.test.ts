/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Pipeline K's per-texel twin steps natively (pipeline-k/native-twin.ts, scratchbox_twin_texels.hpp) against the
 * TypeScript they replace (SCRATCHBOX_K_NATIVE_TWIN=0), on small synthetic twins:
 * - the roof-shadow lift: a 40 m deck with a tower, a setback beside it, a neighbour in the context, five photos (one a
 *   patch too small to fit a sun of its own, wholly in the tower's shadow) darkened under one sun. The reports are the
 *   same field for field, every texel within 1/255 of the TypeScript's, and the same texels lifted;
 * - harmonising: two walls and two roofs, each its own photo at its own exposure. The same report, every texel within
 *   1/255, the same texels changed.
 * The native results are the same on 3 threads as on every core (and for harmonising, one photo a batch). Each test
 * prints one timing line, TypeScript against native with the binary already built (vitest --silent=false shows it).
 */

import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { assembleGlb, parseGlbBytes } from '../src/node/3d-engine/staged-location/glb-bytes';
import { roofShadowLift, shadowMap, shadowedAt, type RoofShadowReport } from '../src/node/3d-engine/staged-location/pipeline-k/roof-shadow';
import { harmonizeTextures, surfaceClassMasks, type TextureHarmonizeReport } from '../src/node/3d-engine/staged-location/pipeline-k/texture-harmonize';
import { collect } from '../src/node/3d-engine/staged-location/pipeline-k/view-relight';
import { ensureNativeTwinBinary, srgb8Thresholds } from '../src/node/3d-engine/staged-location/pipeline-k/native-twin';
import { SRGB8_TO_LINEAR, linearToSrgb255 } from '../src/common/spatial/photogrammetric-delight';
import type { RgbaImage8 } from '../src/node/3d-engine/staged-location/tile-texture-transfer';

interface Prim { pos: number[]; uv?: number[]; idx: number[]; image?: number }

/** A GLB of the primitives (a textured one draws on its image through a material of its own image). */
function glb(prims: Prim[], images: number): ReturnType<typeof parseGlbBytes> {
    const bytes: number[] = [], views: any[] = [], accessors: any[] = [];
    const add = (arr: Float32Array | Uint32Array, type: string, ct: number, count: number) => {
        const b = new Uint8Array(arr.buffer);
        views.push({ buffer: 0, byteOffset: bytes.length, byteLength: b.length });
        for (const v of b) bytes.push(v);
        accessors.push({ bufferView: views.length - 1, componentType: ct, count, type });
        return accessors.length - 1;
    };
    const meshes = prims.map(p => {
        const POSITION = add(new Float32Array(p.pos), 'VEC3', 5126, p.pos.length / 3);
        const TEXCOORD_0 = p.uv ? add(new Float32Array(p.uv), 'VEC2', 5126, p.uv.length / 2) : undefined;
        const indices = add(new Uint32Array(p.idx), 'SCALAR', 5125, p.idx.length);
        return { primitives: [{ attributes: { POSITION, ...(TEXCOORD_0 !== undefined ? { TEXCOORD_0 } : {}) }, indices, mode: 4, ...(p.image !== undefined ? { material: p.image } : {}) }] };
    });
    const ids = Array.from({ length: images }, (_, k) => k);
    const json = {
        asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: meshes.map((_, k) => k) }], nodes: meshes.map((_, k) => ({ mesh: k })), meshes,
        materials: ids.map(k => ({ pbrMetallicRoughness: { baseColorTexture: { index: k } } })), textures: ids.map(k => ({ source: k })), images: ids.map(k => ({ uri: `${k}.png` })),
        accessors, bufferViews: views, buffers: [{ byteLength: bytes.length }]
    };
    return parseGlbBytes(assembleGlb(json as never, Uint8Array.from(bytes)));
}

/** An up-facing quad over [x0, x1] x [z0, z1] at height y, UV-mapped into the rectangle `r` of its photo. */
function topQuad(x0: number, x1: number, z0: number, z1: number, y: number, r: { x0: number; x1: number; z0: number; z1: number }): { pos: number[]; uv: number[] } {
    const u = (x: number) => (x - r.x0) / (r.x1 - r.x0), v = (z: number) => (z - r.z0) / (r.z1 - r.z0);
    return { pos: [x0, y, z0, x1, y, z0, x1, y, z1, x0, y, z1], uv: [u(x0), v(z0), u(x1), v(z0), u(x1), v(z1), u(x0), v(z1)] };
}
const UP = [0, 2, 1, 0, 3, 2];

/** A closed box's four sides (untextured), in quads of about `stepM` (one quad a side when absent). */
function sides(x0: number, x1: number, z0: number, z1: number, y0: number, y1: number, stepM?: number): Prim {
    const c = [[x0, z0], [x1, z0], [x1, z1], [x0, z1]], pos: number[] = [], idx: number[] = [];
    for (let k = 0; k < 4; k++) {
        const [ax, az] = c[k], [bx, bz] = c[(k + 1) % 4];
        const nu = stepM ? Math.ceil(Math.hypot(bx - ax, bz - az) / stepM) : 1, nv = stepM ? Math.ceil((y1 - y0) / stepM) : 1;
        for (let i = 0; i < nu; i++) for (let j = 0; j < nv; j++) {
            const xa = ax + ((bx - ax) * i) / nu, za = az + ((bz - az) * i) / nu, xb = ax + ((bx - ax) * (i + 1)) / nu, zb = az + ((bz - az) * (i + 1)) / nu;
            const ya = y0 + ((y1 - y0) * j) / nv, yb = y0 + ((y1 - y0) * (j + 1)) / nv, b = pos.length / 3;
            pos.push(xa, ya, za, xb, ya, zb, xb, yb, zb, xa, yb, za);
            idx.push(b, b + 1, b + 2, b, b + 2, b + 3);
        }
    }
    return { pos, idx };
}

/** A deterministic surface colour (linear) at a plan point: stripes and a little grain. */
function albedo(x: number, z: number, img: number): [number, number, number] {
    const grain = ((Math.sin(x * 12.9898 + z * 78.233 + img * 3.1) * 43758.5453) % 1 + 1) % 1;
    const v = 0.16 + 0.07 * Math.sin(x * 1.3) * Math.cos(z * 0.7) + 0.05 * grain;
    return [v, v * 0.93, v * 0.82];
}

const encode = (lin: number) => Math.round(linearToSrgb255(lin));
const copyPhotos = (m: Map<number, RgbaImage8>) => new Map([...m].map(([k, v]) => [k, { width: v.width, height: v.height, rgba: v.rgba.slice() }]));

/** Per photo, the largest channel difference between two runs, and how many texels each changed and the two disagree on. */
function compare(input: Map<number, RgbaImage8>, a: Map<number, RgbaImage8>, b: Map<number, RgbaImage8>): { maxDiff: number; changedA: number; changedB: number; maskMismatch: number; differing: number } {
    let maxDiff = 0, changedA = 0, changedB = 0, maskMismatch = 0, differing = 0;
    for (const [k, im] of input) {
        const ra = a.get(k)!.rgba, rb = b.get(k)!.rgba;
        for (let i = 0; i < im.rgba.length; i += 4) {
            let ca = false, cb = false, d = false;
            for (let c = 0; c < 4; c++) {
                if (ra[i + c] !== im.rgba[i + c]) ca = true;
                if (rb[i + c] !== im.rgba[i + c]) cb = true;
                if (ra[i + c] !== rb[i + c]) d = true;
                maxDiff = Math.max(maxDiff, Math.abs(ra[i + c] - rb[i + c]));
            }
            if (ca) changedA++;
            if (cb) changedB++;
            if (ca !== cb) maskMismatch++;
            if (d) differing++;
        }
    }
    return { maxDiff, changedA, changedB, maskMismatch, differing };
}

const SUN = { az: 60, el: 40 };
const DARK = [2.4, 2.3, 2.0];

/** The roof-shadow twin: its GLB, the context, its photos (shadowed under SUN) and their surface classes. */
function roofTwin() {
    const tpm = 8;
    // the photos' rectangles in plan, their height, and texels a metre
    const rects = [
        { x0: 0, x1: 20, z0: 0, z1: 40, y: 20 },    // 0: the deck's west half
        { x0: 15, x1: 25, z0: 15, z1: 25, y: 60 },  // 1: the tower's top
        { x0: 20, x1: 40, z0: 0, z1: 40, y: 20 },   // 2: the deck's east half
        { x0: -15, x1: 0, z0: 0, z1: 40, y: 10 },   // 3: the setback
        { x0: 9, x1: 13, z0: 2, z1: 6, y: 20 }      // 4: a patch of the deck in the tower's shadow
    ];
    const prims: Prim[] = [];
    const tops: Prim[] = rects.map((_, k) => ({ pos: [], uv: [], idx: [], image: k }));
    const quad = (img: number, x0: number, x1: number, z0: number, z1: number) => {
        const q = topQuad(x0, x1, z0, z1, rects[img].y, rects[img]), p = tops[img], b = p.pos.length / 3;
        p.pos.push(...q.pos); p.uv!.push(...q.uv); p.idx.push(...UP.map(i => i + b));
    };
    // the deck in 1 m quads, each on the photo its middle falls in
    for (let x = 0; x < 40; x++) for (let z = 0; z < 40; z++) {
        const mx = x + 0.5, mz = z + 0.5;
        quad(mx > 9 && mx < 13 && mz > 2 && mz < 6 ? 4 : mx < 20 ? 0 : 2, x, x + 1, z, z + 1);
    }
    for (let x = -15; x < 0; x++) for (let z = 0; z < 40; z++) quad(3, x, x + 1, z, z + 1);
    quad(1, 15, 25, 15, 25);
    prims.push(...tops, sides(0, 40, 0, 40, 0, 20), sides(15, 25, 15, 25, 20, 60), sides(-15, 0, 0, 40, 0, 10));
    const g = glb(prims, rects.length);
    // the neighbour across the street, east of the deck, as finely meshed as a scan (the maps' cost is in their triangles)
    const box = sides(50, 60, -10, 50, 0, 45, 0.5);
    const context = { vertices: Float32Array.from(box.pos), indices: Uint32Array.from(box.idx) };
    // the photos: the surface colour, darkened where the twin or the neighbour shades it from SUN
    const soup = collect(g, g.json);
    const occ = { P: Float32Array.from([...soup.P, ...box.idx.map(i => box.pos.slice(i * 3, i * 3 + 3)).flat()]), n: soup.n + box.idx.length / 3 };
    const m = shadowMap(occ, SUN.az, SUN.el, 0.05);
    const photos = new Map<number, RgbaImage8>();
    rects.forEach((r, k) => {
        const W = Math.round((r.x1 - r.x0) * tpm), H = Math.round((r.z1 - r.z0) * tpm), rgba = new Uint8Array(W * H * 4);
        for (let ty = 0; ty < H; ty++) for (let tx = 0; tx < W; tx++) {
            const x = r.x0 + ((tx + 0.5) / W) * (r.x1 - r.x0), z = r.z0 + ((ty + 0.5) / H) * (r.z1 - r.z0);
            const lin = albedo(x, z, k), dark = shadowedAt(m, x, r.y, z, 0.05);
            const o = (ty * W + tx) * 4;
            for (let c = 0; c < 3; c++) rgba[o + c] = encode(dark ? lin[c] / DARK[c] : lin[c]);
            rgba[o + 3] = 255;
        }
        photos.set(k, { width: W, height: H, rgba });
    });
    const surfaces = surfaceClassMasks(g, g.json, photos);
    return { g, context, photos, surfaces };
}

/** Two walls (z = 0, facing +z) and two roofs behind them (y = 10), each its own photo at its own exposure. */
function harmonizeTwin(N: number) {
    const gains = [1, 1.6, 0.8, 1.3];
    const prims: Prim[] = [
        { pos: [0, 0, 0, 10, 0, 0, 10, 10, 0, 0, 10, 0], uv: [0, 1, 1, 1, 1, 0, 0, 0], idx: [0, 1, 2, 0, 2, 3], image: 0 },
        { pos: [10, 0, 0, 20, 0, 0, 20, 10, 0, 10, 10, 0], uv: [0, 1, 1, 1, 1, 0, 0, 0], idx: [0, 1, 2, 0, 2, 3], image: 1 },
        { ...topQuad(0, 10, -10, 0, 10, { x0: 0, x1: 10, z0: -10, z1: 0 }), idx: UP, image: 2 },
        { ...topQuad(10, 20, -10, 0, 10, { x0: 10, x1: 20, z0: -10, z1: 0 }), idx: UP, image: 3 }
    ];
    const g = glb(prims, 4);
    const photos = new Map<number, RgbaImage8>();
    gains.forEach((gain, k) => {
        const rgba = new Uint8Array(N * N * 4);
        for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
            const lin = albedo((x / N) * 10, (y / N) * 10, k), o = (y * N + x) * 4;
            for (let c = 0; c < 3; c++) rgba[o + c] = encode(lin[c] * gain);
            rgba[o + 3] = 255;
        }
        photos.set(k, { width: N, height: N, rgba });
    });
    return { g, photos, masks: surfaceClassMasks(g, g.json, photos) };
}

const withoutTimes = <T extends { ms: number; phasesMs?: unknown }>(r: T) => { const { ms: _ms, phasesMs: _p, ...rest } = r; return rest; };

describe('pipeline K per-texel twin steps, native against TypeScript', () => {
    beforeAll(async () => { await ensureNativeTwinBinary(); }, 300_000);
    afterEach(() => { delete process.env.SCRATCHBOX_K_NATIVE_TWIN; });

    it('reads the 8-bit sRGB code from its thresholds as JavaScript rounds it', () => {
        const t = srgb8Thresholds();
        const code = (x: number) => { let k = 0; while (k < 255 && t[k] <= x) k++; return k; };
        for (let k = 0; k < 255; k++) {
            expect(Math.round(linearToSrgb255(t[k]))).toBe(k + 1);
            expect(Math.round(linearToSrgb255(t[k] - Number.EPSILON * t[k]))).toBeLessThanOrEqual(k);
        }
        for (let v = 0; v < 256; v++) expect(code(SRGB8_TO_LINEAR[v])).toBe(v);
    });

    it('lifts the roof shadow as the TypeScript does, texel for texel', async () => {
        const { g, context, photos, surfaces } = roofTwin();
        const ts = copyPhotos(photos), nat = copyPhotos(photos);
        process.env.SCRATCHBOX_K_NATIVE_TWIN = '0';
        let t = performance.now();
        const a: RoofShadowReport = await roofShadowLift(g, g.json, ts, surfaces, { context });
        const tsMs = performance.now() - t;
        delete process.env.SCRATCHBOX_K_NATIVE_TWIN;
        t = performance.now();
        const b: RoofShadowReport = await roofShadowLift(g, g.json, nat, surfaces, { context });
        const nativeMs = performance.now() - t;

        // the fixture reaches every path: a deck fitted, terraces lifted, the patch lifted as part of a terrace across photos
        expect(a.applied).toBe(true);
        expect(a.fitted).toBeGreaterThanOrEqual(1);
        expect(a.contextTriangles).toBe(50_400);
        expect(a.terraces.lifted).toBeGreaterThanOrEqual(2);
        expect(a.terraces.componentsLifted).toBeGreaterThanOrEqual(1);
        expect(a.texelsLifted).toBeGreaterThan(1000);
        expect(withoutTimes(b)).toEqual(withoutTimes(a));

        const d = compare(photos, ts, nat);
        expect(d.changedA).toBeGreaterThan(1000);
        expect(d.maxDiff).toBeLessThanOrEqual(1);
        expect(d.maskMismatch).toBe(0);
        // the same on 3 threads as on every core
        const few = copyPhotos(photos);
        expect(withoutTimes(await roofShadowLift(g, g.json, few, surfaces, { context, threads: 3 }))).toEqual(withoutTimes(b));
        expect(compare(photos, nat, few).differing).toBe(0);
        const texels = [...photos.values()].reduce((s, p) => s + p.width * p.height, 0);
        console.log(`[timing] roof-shadow lift, ${texels} texels, ${a.cells} roof cells, ${a.candidates} suns: TypeScript ${tsMs.toFixed(0)} ms, native ${nativeMs.toFixed(0)} ms (${(tsMs / nativeMs).toFixed(1)}x); ${d.changedA} texels lifted, ${d.differing} differ (max ${d.maxDiff}/255)`);
    }, 120_000);

    it('harmonises as the TypeScript does, texel for texel', () => {
        const N = 1024;
        const { g, photos, masks } = harmonizeTwin(N);
        const ts = copyPhotos(photos), nat = copyPhotos(photos);
        process.env.SCRATCHBOX_K_NATIVE_TWIN = '0';
        let t = performance.now();
        const a: TextureHarmonizeReport = harmonizeTextures(g, g.json, ts, 0, undefined, masks);
        const tsMs = performance.now() - t, tsApply = a.phasesMs?.apply ?? 0;
        delete process.env.SCRATCHBOX_K_NATIVE_TWIN;
        t = performance.now();
        const b: TextureHarmonizeReport = harmonizeTextures(g, g.json, nat, 0, undefined, masks);
        const nativeMs = performance.now() - t;

        expect(a.kept).toBe(true);
        expect(a.roofs.roofGains).toBeGreaterThanOrEqual(2);
        expect(withoutTimes(b)).toEqual(withoutTimes(a));
        const d = compare(photos, ts, nat);
        expect(d.changedA).toBeGreaterThan(N * N);
        expect(d.maxDiff).toBeLessThanOrEqual(1);
        expect(d.maskMismatch).toBe(0);
        // the same on 3 threads, one photo a batch
        const few = copyPhotos(photos);
        expect(withoutTimes(harmonizeTextures(g, g.json, few, 0, undefined, masks, { threads: 3, nativeBatchBytes: 1 }))).toEqual(withoutTimes(b));
        expect(compare(photos, nat, few).differing).toBe(0);
        console.log(`[timing] harmonise, ${4 * N * N} texels: TypeScript ${tsMs.toFixed(0)} ms (apply ${tsApply} ms), native ${nativeMs.toFixed(0)} ms (apply ${b.phasesMs?.apply ?? 0} ms; ${(tsApply / Math.max(1, b.phasesMs?.apply ?? 0)).toFixed(1)}x); ${d.changedA} texels changed, ${d.differing} differ (max ${d.maxDiff}/255)`);
    }, 120_000);
});
