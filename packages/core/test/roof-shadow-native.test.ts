/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The roof-shadow lift's native kernels (scratchbox_twin_texels.hpp, pipeline-k/native/twin-texels-native.ts) against
 * the TypeScript ones they replace (roof-shadow.ts, SCRATCHBOX_K_NATIVE=0). Every comparison is exact. Two synthetic
 * twins:
 * - the deck: a 40 m deck with a tower, a setback beside it and a finely meshed neighbour in the context; five photos
 *   (one a patch too small to fit a sun of its own, wholly in the tower's shadow) darkened under one sun. It reaches
 *   a fitted deck, lifted terraces and a terrace across photos;
 * - the roof: a 60 x 60 m deck at 100 m with a parapet and a tower to 160 m, a taller neighbour casting over half the
 *   deck and context blocks on a ring, the deck painted with a true sun's shadow (az 0, el 40).
 *
 * 1. The kernels: the same roof cells; the same cell shadows and deck sums under an oblique sun, a sun off the search
 *    grid, one along the walls, one from straight above; and the same lift with a photo's own sun on a terrace with
 *    no lit level known (the uncapped lift) and terraces across photos under several suns.
 * 2. roofShadowLift on each twin: the same report field for field and the same photos, native on every core and on
 *    3 threads.
 * 3. One timing line, TypeScript against native, on the roof at a few hundred thousand occluders (vitest
 *    --silent=false shows it).
 */

import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { encodePng, writeGlb, type Chunk } from './helpers/synthetic-scan-glb';
import { assembleGlb, parseGlbBytes } from '../src/node/3d-engine/staged-location/glb-bytes';
import { occludersOf, planesOf, ROOF_SHADOW_PARAMS, roofShadowKernels, roofShadowLift, shadowMap, shadowedAt, type LiftPlan, type RoofShadowReport } from '../src/node/3d-engine/staged-location/pipeline-k/roof-shadow';
import { surfaceClassMasks } from '../src/node/3d-engine/staged-location/pipeline-k/texture-harmonize';
import { collect } from '../src/node/3d-engine/staged-location/pipeline-k/view-relight';
import { ensureNativeTwinBinary } from '../src/node/3d-engine/staged-location/pipeline-k/native/twin-texels-native';
import { linearToSrgb255 } from '../src/common/spatial/photogrammetric-delight';
import type { RgbaImage8 } from '../src/node/3d-engine/staged-location/tile-texture-transfer';

type V3 = [number, number, number];
const P0 = ROOF_SHADOW_PARAMS;
interface Twin { g: ReturnType<typeof parseGlbBytes>; context: { vertices: Float32Array; indices: Uint32Array }; photos: Map<number, RgbaImage8>; surfaces: Map<number, Uint8Array> }

// ---- the deck ----

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

/** The deck twin: its photos shadowed under az 60, el 40 by the twin and the neighbour, and their surface classes. */
function deckTwin(): Twin {
    const tpm = 8, sun = { az: 60, el: 40 }, dark = [2.4, 2.3, 2.0];
    const rects = [
        { x0: 0, x1: 20, z0: 0, z1: 40, y: 20 },    // 0: the deck's west half
        { x0: 15, x1: 25, z0: 15, z1: 25, y: 60 },  // 1: the tower's top
        { x0: 20, x1: 40, z0: 0, z1: 40, y: 20 },   // 2: the deck's east half
        { x0: -15, x1: 0, z0: 0, z1: 40, y: 10 },   // 3: the setback
        { x0: 9, x1: 13, z0: 2, z1: 6, y: 20 }      // 4: a patch of the deck in the tower's shadow
    ];
    const tops: Prim[] = rects.map((_, k) => ({ pos: [], uv: [], idx: [], image: k }));
    // an up-facing quad UV-mapped into its photo's rectangle
    const quad = (img: number, x0: number, x1: number, z0: number, z1: number) => {
        const r = rects[img], p = tops[img], b = p.pos.length / 3, u = (x: number) => (x - r.x0) / (r.x1 - r.x0), v = (z: number) => (z - r.z0) / (r.z1 - r.z0);
        p.pos.push(x0, r.y, z0, x1, r.y, z0, x1, r.y, z1, x0, r.y, z1);
        p.uv!.push(u(x0), v(z0), u(x1), v(z0), u(x1), v(z1), u(x0), v(z1));
        p.idx.push(b, b + 2, b + 1, b, b + 3, b + 2);
    };
    // the deck in 1 m quads, each on the photo its middle falls in
    for (let x = 0; x < 40; x++) for (let z = 0; z < 40; z++) {
        const mx = x + 0.5, mz = z + 0.5;
        quad(mx > 9 && mx < 13 && mz > 2 && mz < 6 ? 4 : mx < 20 ? 0 : 2, x, x + 1, z, z + 1);
    }
    for (let x = -15; x < 0; x++) for (let z = 0; z < 40; z++) quad(3, x, x + 1, z, z + 1);
    quad(1, 15, 25, 15, 25);
    const g = glb([...tops, sides(0, 40, 0, 40, 0, 20), sides(15, 25, 15, 25, 20, 60), sides(-15, 0, 0, 40, 0, 10)], rects.length);
    // the neighbour across the street, east of the deck, as finely meshed as a scan (the maps' cost is in their triangles)
    const box = sides(50, 60, -10, 50, 0, 45, 0.5);
    const context = { vertices: Float32Array.from(box.pos), indices: Uint32Array.from(box.idx) };
    const soup = collect(g, g.json);
    const m = shadowMap({ P: Float32Array.from([...soup.P, ...box.idx.flatMap(i => box.pos.slice(i * 3, i * 3 + 3))]), n: soup.n + box.idx.length / 3 }, sun.az, sun.el, 0.05);
    const photos = new Map<number, RgbaImage8>();
    rects.forEach((r, k) => {
        const W = Math.round((r.x1 - r.x0) * tpm), H = Math.round((r.z1 - r.z0) * tpm), rgba = new Uint8Array(W * H * 4);
        for (let ty = 0; ty < H; ty++) for (let tx = 0; tx < W; tx++) {
            const x = r.x0 + ((tx + 0.5) / W) * (r.x1 - r.x0), z = r.z0 + ((ty + 0.5) / H) * (r.z1 - r.z0);
            const lin = albedo(x, z, k), shaded = shadowedAt(m, x, r.y, z, 0.05), o = (ty * W + tx) * 4;
            for (let c = 0; c < 3; c++) rgba[o + c] = Math.round(linearToSrgb255(shaded ? lin[c] / dark[c] : lin[c]));
            rgba[o + 3] = 255;
        }
        photos.set(k, { width: W, height: H, rgba });
    });
    return { g, context, photos, surfaces: surfaceClassMasks(g, g.json, photos) };
}

// ---- the roof ----

/** A planar grid from o along u and v; uv (0,0) at o, (1,1) at o + u + v. */
function grid(o: V3, u: V3, v: V3, nu: number, nv: number, image?: number): Chunk {
    const positions: number[] = [], indices: number[] = [], uvs: number[] = [];
    for (let j = 0; j <= nv; j++) for (let i = 0; i <= nu; i++) {
        for (let c = 0; c < 3; c++) positions.push(o[c] + (u[c] * i) / nu + (v[c] * j) / nv);
        uvs.push(i / nu, j / nv);
    }
    for (let j = 0; j < nv; j++) for (let i = 0; i < nu; i++) { const a = j * (nu + 1) + i, b = a + 1, c = a + nu + 1, d = c + 1; indices.push(a, d, b, a, c, d); }
    return image === undefined ? { positions, indices } : { positions, indices, uvs, image };
}

/** A box's four walls and, unless roofImage is null, its roof (textured by that photo when a number). */
function box(x0: number, x1: number, z0: number, z1: number, y0: number, y1: number, step: number, roofImage?: number | null): Chunk[] {
    const n = (l: number) => Math.max(1, Math.round(l / step));
    const out = [
        grid([x0, y0, z0], [x1 - x0, 0, 0], [0, y1 - y0, 0], n(x1 - x0), n(y1 - y0)),
        grid([x1, y0, z1], [x0 - x1, 0, 0], [0, y1 - y0, 0], n(x1 - x0), n(y1 - y0)),
        grid([x0, y0, z1], [0, 0, z0 - z1], [0, y1 - y0, 0], n(z1 - z0), n(y1 - y0)),
        grid([x1, y0, z0], [0, 0, z1 - z0], [0, y1 - y0, 0], n(z1 - z0), n(y1 - y0))
    ];
    if (roofImage !== null) out.push(grid([x0, y1, z0], [x1 - x0, 0, 0], [0, 0, z1 - z0], n(x1 - x0), n(z1 - z0), roofImage));
    return out;
}

/** The roof twin. `step`: the twin's tessellation (m); `ctxStep`: the context's; `texel`: the photos' texel (m); `blocks`: context blocks on a ring. */
function roofTwin(step: number, ctxStep: number, texel: number, blocks: number): Twin {
    const twin: Chunk[] = [
        ...box(-30, 30, -30, 30, 0, 100, step * 4, null),
        grid([-30, 100, -30], [60, 0, 0], [0, 0, 60], Math.round(60 / step), Math.round(60 / step), 0),
        ...box(-29.7, 29.7, -29.7, 29.7, 100, 101.2, step, null),
        grid([-30, 101.2, -30], [60, 0, 0], [0, 0, 0.3], Math.round(60 / step), 1), grid([-30, 101.2, 29.7], [60, 0, 0], [0, 0, 0.3], Math.round(60 / step), 1),
        ...box(-20, 0, -10, 10, 100, 160, step * 2, 1)
    ];
    const ctx: Chunk[] = [...box(40, 80, -30, 30, 0, 130, ctxStep)];
    for (let b = 0; b < blocks; b++) {
        const a = (b / blocks) * 2 * Math.PI, r = 120 + 40 * (b % 3), cx = r * Math.cos(a), cz = r * Math.sin(a);
        ctx.push(...box(cx - 15, cx + 15, cz - 15, cz + 15, 0, 40 + 15 * (b % 5), ctxStep));
    }
    const vertices: number[] = [], indices: number[] = [];
    for (const c of ctx) { const base = vertices.length / 3; for (const v of c.positions) vertices.push(v); for (const i of c.indices) indices.push(base + i); }
    const all: number[] = [];
    for (const c of twin) for (const i of c.indices) all.push(c.positions[i * 3], c.positions[i * 3 + 1], c.positions[i * 3 + 2]);
    for (const i of indices) all.push(vertices[i * 3], vertices[i * 3 + 1], vertices[i * 3 + 2]);
    const truth = shadowMap({ P: Float32Array.from(all), n: all.length / 9 }, 0, 40, 0.1);
    const photos = new Map<number, RgbaImage8>(), surfaces = new Map<number, Uint8Array>();
    const paint = (im: number, x0: number, z0: number, sx: number, sz: number, y: number) => {
        const W = Math.round(sx / texel), H = Math.round(sz / texel), rgba = new Uint8Array(W * H * 4);
        for (let ty = 0; ty < H; ty++) for (let tx = 0; tx < W; tx++) {
            const x = x0 + ((tx + 0.5) / W) * sx, z = z0 + ((ty + 0.5) / H) * sz, i = ty * W + tx;
            // two materials in 7 m stripes, a deterministic grain, and the true sun's shadow (bluer than the lit deck)
            const grain = 0.9 + (0.2 * (((tx * 73856093) ^ (ty * 19349663)) >>> 0)) / 4294967296;
            const base = (Math.floor(x / 7) & 1 ? [0.42, 0.4, 0.37] : [0.35, 0.35, 0.36]).map(v => v * grain);
            const gain = shadowedAt(truth, x, y, z, 0.3) ? [1 / 2.5, 1 / 2.3, 1 / 1.9] : [1, 1, 1];
            for (let k = 0; k < 3; k++) rgba[i * 4 + k] = Math.round(linearToSrgb255(base[k] * gain[k]));
            rgba[i * 4 + 3] = 255;
        }
        photos.set(im, { width: W, height: H, rgba });
        surfaces.set(im, new Uint8Array(W * H).fill(2));
    };
    paint(0, -30, -30, 60, 60, 100);
    paint(1, -20, -10, 20, 20, 160);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'roof-shadow-native-test-'));
    try {
        const file = path.join(dir, 'twin.glb'), png = encodePng(1, 1, new Uint8Array([128, 128, 128]));
        writeGlb(file, twin, [png, png]);
        return { g: parseGlbBytes(new Uint8Array(fs.readFileSync(file))), context: { vertices: Float32Array.from(vertices), indices: Uint32Array.from(indices) }, photos, surfaces };
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

// ---- comparisons ----

const copyPhotos = (m: Map<number, RgbaImage8>) => new Map([...m].map(([k, v]) => [k, { width: v.width, height: v.height, rgba: v.rgba.slice() }]));
const withoutMs = (r: RoofShadowReport) => ({ ...r, ms: 0 });
const sameBytes = (a: ArrayBufferView, b: ArrayBufferView) => Buffer.from(a.buffer, a.byteOffset, a.byteLength).equals(Buffer.from(b.buffer, b.byteOffset, b.byteLength));

/** Texels two runs changed (against the input), and how many of them the two disagree on. */
function changedTexels(input: Map<number, RgbaImage8>, a: Map<number, RgbaImage8>, b: Map<number, RgbaImage8>): { a: number; differ: number } {
    let changed = 0, differ = 0;
    for (const [k, im] of input) {
        const ra = a.get(k)!.rgba, rb = b.get(k)!.rgba;
        for (let i = 0; i < im.rgba.length; i += 4) {
            let ca = false, d = false;
            for (let c = 0; c < 4; c++) { if (ra[i + c] !== im.rgba[i + c]) ca = true; if (ra[i + c] !== rb[i + c]) d = true; }
            if (ca) changed++;
            if (d) differ++;
        }
    }
    return { a: changed, differ };
}

/** roofShadowLift with SCRATCHBOX_K_NATIVE=0 (the TypeScript) or unset (native), on copies of the photos. */
async function lift(t: Twin, native: boolean, threads?: number): Promise<{ report: RoofShadowReport; photos: Map<number, RgbaImage8>; ms: number }> {
    if (native) delete process.env.SCRATCHBOX_K_NATIVE; else process.env.SCRATCHBOX_K_NATIVE = '0';
    const photos = copyPhotos(t.photos), t0 = performance.now();
    const report = await roofShadowLift(t.g, t.g.json, photos, t.surfaces, { context: t.context, ...(threads ? { threads } : {}) });
    return { report, photos, ms: performance.now() - t0 };
}

describe('roof-shadow lift: native kernels against the TypeScript', () => {
    let deck: Twin, roof: Twin;
    beforeAll(async () => {
        await ensureNativeTwinBinary();
        deck = deckTwin();
        roof = roofTwin(0.5, 3, 0.1, 8);
    }, 300_000);
    afterEach(() => { delete process.env.SCRATCHBOX_K_NATIVE; });

    it('the kernels: the same roof cells, cell shadows and deck sums under suns of every kind', async () => {
        const soup = collect(roof.g, roof.g.json), occ = occludersOf(soup, roof.context, P0);
        const ts = await roofShadowKernels(soup, occ, roof.photos, roof.surfaces, P0, false), nat = await roofShadowKernels(soup, occ, roof.photos, roof.surfaces, P0, true);
        try {
            const a = await ts.cells(), b = await nat.cells();
            expect(a.n).toBeGreaterThan(30_000);
            expect(b.n).toBe(a.n);
            for (const k of ['img', 'p', 'c'] as const) expect(sameBytes(b[k], a[k])).toBe(true);
            const planes = planesOf(a, P0);
            expect(planes.map(p => p.y)).toEqual([100, 160]);
            // oblique, off the search grid, along the walls, from straight above, from behind the neighbour
            const suns = [{ az: 0, el: 40 }, { az: 37.5, el: 23 }, { az: 90, el: 60 }, { az: 0, el: 89.9 }, { az: 200, el: 25 }];
            const score = suns.map((_, s) => (s % 2 ? [1] : [0, 1]));
            const sa = await ts.shadows(suns, planes, score), sb = await nat.shadows(suns, planes, score);
            suns.forEach((_, s) => {
                expect(sameBytes(sb.bits[s], sa.bits[s])).toBe(true);
                expect(sb.sums[s].map(x => [...x])).toEqual(sa.sums[s].map(x => [...x]));
            });
            // the oblique sun splits the deck
            const shaded = sa.bits[0].reduce((n, v) => n + v, 0);
            expect(shaded).toBeGreaterThan(a.n / 10);
            expect(shaded).toBeLessThan(a.n * 0.9);
        } finally {
            ts.close(); nat.close();
        }
    }, 120_000);

    it('the lift kernel: a photo\'s own sun with no lit level known, and terraces across photos under several suns', async () => {
        const soup = collect(roof.g, roof.g.json), occ = occludersOf(soup, roof.context, P0);
        const gridKey = (i: number, c: { p: Float32Array }) => `${Math.round(c.p[i * 3 + 1] / P0.terraceBinM)}:${Math.floor(c.p[i * 3] / P0.componentGridM)}:${Math.floor(c.p[i * 3 + 2] / P0.componentGridM)}`;
        const plans = (c: { n: number; img: Int32Array; p: Float32Array }): LiftPlan[] => {
            const keysOf = (im: number, side: (x: number) => boolean, comp: number, into: Map<string, number>) => {
                for (let i = 0; i < c.n; i++) if (c.img[i] === im && side(c.p[i * 3])) into.set(gridKey(i, c), comp);
                return into;
            };
            return [
                // photo 0's own sun on its terrace with no lit level known (the uncapped lift); photo 1 through a terrace across photos
                { suns: [{ az: 0, el: 40 }, { az: 200, el: 25 }], photoSun: new Map([[0, { sun: 0, ratio: [2.4, 2.2, 1.9] }]]), terraceLit: new Map<string, number | undefined>([['0:100', undefined]]), comps: [{ sun: 1, ratio: [1.8, 1.7, 1.5], lit: -1.2 }], compOfKey: keysOf(1, () => true, 0, new Map()) },
                // photo 0 with no sun of its own, its deck split between two terraces across photos under two suns; photo 1 with its own sun
                { suns: [{ az: 0, el: 40 }, { az: 180, el: 30 }, { az: 90, el: 50 }], photoSun: new Map([[1, { sun: 2, ratio: [1.5, 1.5, 1.5] }]]), terraceLit: new Map<string, number | undefined>([['1:160', -2]]), comps: [{ sun: 0, ratio: [2.4, 2.2, 1.9], lit: -1.1 }, { sun: 1, ratio: [2, 2, 2], lit: -1.4 }], compOfKey: keysOf(0, x => x < 0, 1, keysOf(0, x => x >= 0, 0, new Map())) }
            ];
        };
        const ts = await roofShadowKernels(soup, occ, roof.photos, roof.surfaces, P0, false), nat = await roofShadowKernels(soup, occ, roof.photos, roof.surfaces, P0, true, 3);
        try {
            const cells = await ts.cells();
            await nat.cells();
            for (const plan of plans(cells)) {
                const a = await ts.lift(plan), b = await nat.lift(plan);
                expect([...a.lifted.values()].reduce((s, n) => s + n, 0)).toBeGreaterThan(10_000);
                expect([...b.lifted].sort()).toEqual([...a.lifted].sort());
                expect([...b.changed.keys()].sort()).toEqual([...a.changed.keys()].sort());
                for (const [im, rgba] of a.changed) expect(sameBytes(b.changed.get(im)!, rgba)).toBe(true);
            }
        } finally {
            ts.close(); nat.close();
        }
    }, 120_000);

    it('roofShadowLift on the deck: the same report and photos, on every core and on 3 threads', async () => {
        const a = await lift(deck, false), b = await lift(deck, true), c = await lift(deck, true, 3);
        // every path: a deck fitted, terraces lifted, the patch lifted as part of a terrace across photos
        expect(a.report.applied).toBe(true);
        expect(a.report.fitted).toBeGreaterThanOrEqual(1);
        expect(a.report.contextTriangles).toBe(50_400);
        expect(a.report.terraces.lifted).toBeGreaterThanOrEqual(2);
        expect(a.report.terraces.componentsLifted).toBeGreaterThanOrEqual(1);
        expect(a.report.texelsLifted).toBeGreaterThan(1000);
        expect(withoutMs(b.report)).toEqual(withoutMs(a.report));
        expect(withoutMs(c.report)).toEqual(withoutMs(a.report));
        const d = changedTexels(deck.photos, a.photos, b.photos);
        expect(d.a).toBeGreaterThan(1000);
        expect(d.differ).toBe(0);
        expect(changedTexels(deck.photos, b.photos, c.photos).differ).toBe(0);
    }, 120_000);

    it('roofShadowLift on the roof: the same report and photos', async () => {
        const a = await lift(roof, false), b = await lift(roof, true);
        expect(a.report.texelsLifted).toBeGreaterThan(10_000);
        expect(withoutMs(b.report)).toEqual(withoutMs(a.report));
        expect(changedTexels(roof.photos, a.photos, b.photos).differ).toBe(0);
    }, 120_000);

    it('times the TypeScript and native lift on the roof at a few hundred thousand occluders', async () => {
        const big = roofTwin(0.25, 1.6, 0.1, 16);
        const a = await lift(big, false), b = await lift(big, true);
        expect(withoutMs(b.report)).toEqual(withoutMs(a.report));
        const d = changedTexels(big.photos, a.photos, b.photos);
        expect(d.differ).toBe(0);
        const soup = collect(big.g, big.g.json), occ = occludersOf(soup, big.context, P0);
        expect(occ.n).toBeGreaterThan(250_000);
        console.log(`[timing] roof-shadow lift, ${occ.n} occluders (twin ${soup.n}), ${a.report.cells} roof cells, ${a.report.planes} decks, ${a.report.candidates} suns: TypeScript ${a.ms.toFixed(0)} ms, native ${b.ms.toFixed(0)} ms (${(a.ms / b.ms).toFixed(1)}x); ${d.a} texels lifted, ${d.differ} differ`);
    }, 600_000);
});
