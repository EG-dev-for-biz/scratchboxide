/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Pipeline K-D's harmonise on a district, made fast without changing what it computes: the building lookup settled per
 * square of plan (district-buildings.ts planCells) gives the point-by-point lookup's answer everywhere (shared walls,
 * overlapping parts, a many-sided tower, a near neighbour, points on edges and on the squares' own edges), and the
 * harmonise (one lookup per sample, numeric keys) reproduces the report and photos the per-sample string-keyed code made
 * (GOLDEN: that code's output on this district, recorded before the change).
 */

import { createHash } from 'crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { assembleGlb, parseGlbBytes } from '../src/node/3d-engine/staged-location/glb-bytes';
import { districtBuildingIndex, districtFootprints, type DistrictFootprint } from '../src/node/3d-engine/staged-location/pipeline-k/district-buildings';
import { signedFootprintDistance } from '../src/node/3d-engine/staged-location/pipeline-k/base-cleanup';
import { harmonizeTextures } from '../src/node/3d-engine/staged-location/pipeline-k/texture-harmonize';
import type { RgbaImage8 } from '../src/node/3d-engine/staged-location/tile-texture-transfer';

type V2 = [number, number];
const rect = (x0: number, z0: number, x1: number, z1: number): V2[] => [[x0, z0], [x1, z0], [x1, z1], [x0, z1]];
const ngon = (cx: number, cz: number, r: number, n: number): V2[] => Array.from({ length: n }, (_, k) => [cx + r * Math.cos((2 * Math.PI * k) / n), cz + r * Math.sin((2 * Math.PI * k) / n)] as V2);

/** Six buildings: two sharing a party wall, an L of two overlapping parts, a 48-sided tower, a slab 0.8 m from a neighbour, a block of many short edges. */
function district(): Array<{ id: string; parts: Array<{ loops: V2[][] }>; height: number }> {
    const jag: V2[] = [];
    for (let k = 0; k <= 30; k++) jag.push([80 + k, 40 + (k % 2) * 0.7]);
    for (let k = 30; k >= 0; k--) jag.push([80 + k, 62 - (k % 3) * 0.5]);
    return [
        { id: 'a', parts: [{ loops: [rect(0, 0, 20, 20)] }], height: 30 },
        { id: 'b', parts: [{ loops: [rect(20, 0, 40, 20)] }], height: 18 },
        { id: 'c', parts: [{ loops: [rect(0, 40, 30, 52)] }, { loops: [rect(18, 40, 30, 70)] }], height: 24 },
        { id: 'd', parts: [{ loops: [ngon(60, 30, 9, 48)] }], height: 60 },
        { id: 'e', parts: [{ loops: [rect(40.8, 0, 47, 18)] }], height: 12 },
        { id: 'f', parts: [{ loops: [jag] }], height: 15 }
    ];
}

/** A textured GLB of the district: every part's walls (4 m strips, 6 m storeys) and roof, and a street ground, over ten photos. */
function districtGlb(): { g: ReturnType<typeof parseGlbBytes>; photos: number } {
    const photos = 10;
    const tris: number[][] = Array.from({ length: photos }, () => []), uvs: number[][] = Array.from({ length: photos }, () => []);
    let seed = 7;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
    const tri = (img: number, p: number[][], t: number[][]) => { for (const q of p) tris[img].push(...q); for (const q of t) uvs[img].push(...q); };
    const quad = (img: number, a: number[], b: number[], c: number[], d: number[], ua: number[], ub: number[], uc: number[], ud: number[]) => { tri(img, [a, b, c], [ua, ub, uc]); tri(img, [a, c, d], [ua, uc, ud]); };
    district().forEach((b, bi) => {
        for (const part of b.parts) for (const loop of part.loops) {
            let s = 0;
            for (let i = 0; i < loop.length; i++) {
                const p = loop[i], q = loop[(i + 1) % loop.length], len = Math.hypot(q[0] - p[0], q[1] - p[1]), n = Math.max(1, Math.ceil(len / 4));
                for (let k = 0; k < n; k++) for (let y = 0; y < b.height; y += 6) {
                    const t0 = k / n, t1 = (k + 1) / n, y1 = Math.min(b.height, y + 6), img = (bi * 3 + Math.floor(rnd() * 4)) % 8;
                    const at = (t: number, yy: number) => [p[0] + (q[0] - p[0]) * t, yy, p[1] + (q[1] - p[1]) * t];
                    const uv = (t: number, yy: number) => [((s + len * t) / 60) % 1, yy / 70];
                    quad(img, at(t0, y), at(t1, y), at(t1, y1), at(t0, y1), uv(t0, y), uv(t1, y), uv(t1, y1), uv(t0, y1));
                }
                s += len;
            }
            // the roof: a fan from the loop's first corner (the loops here are star-shaped about it or convex)
            const img = (bi * 5 + 2) % 8, c0 = loop[0];
            for (let i = 1; i + 1 < loop.length; i++) {
                const v = [c0, loop[i + 1], loop[i]].map(([x, z]) => [x, b.height, z]);
                tri(img, v, v.map(([x, , z]) => [(x / 90) % 1, (z / 90) % 1]));
            }
        }
    });
    // the street: 10 m tiles over the whole district, on photos 8 and 9
    for (let x = -10; x < 120; x += 10) for (let z = -10; z < 80; z += 10) {
        const img = 8 + ((x + z) / 10 & 1), v = [[x, 0, z], [x, 0, z + 10], [x + 10, 0, z + 10], [x + 10, 0, z]], t = v.map(([px, , pz]) => [(px + 10) / 130, (pz + 10) / 90]);
        quad(img, v[0], v[1], v[2], v[3], t[0], t[1], t[2], t[3]);
    }
    const bytes: number[] = [], views: any[] = [], accessors: any[] = [];
    const push = (arr: Float32Array | Uint32Array, type: string, ct: number, count: number) => {
        const b = new Uint8Array(arr.buffer);
        views.push({ buffer: 0, byteOffset: bytes.length, byteLength: b.length });
        for (const x of b) bytes.push(x);
        accessors.push({ bufferView: views.length - 1, componentType: ct, count, type });
        return accessors.length - 1;
    };
    const meshes = tris.map((t, k) => {
        const n = t.length / 3;
        const pos = push(new Float32Array(t), 'VEC3', 5126, n), uv = push(new Float32Array(uvs[k]), 'VEC2', 5126, n), idx = push(Uint32Array.from({ length: n }, (_, i) => i), 'SCALAR', 5125, n);
        return { primitives: [{ attributes: { POSITION: pos, TEXCOORD_0: uv }, indices: idx, material: k, mode: 4 }] };
    });
    const json = {
        asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: meshes.map((_, k) => k) }], nodes: meshes.map((_, k) => ({ mesh: k })), meshes,
        materials: meshes.map((_, k) => ({ pbrMetallicRoughness: { baseColorTexture: { index: k } } })),
        textures: meshes.map((_, k) => ({ source: k })), images: meshes.map((_, k) => ({ uri: `${k}.png` })),
        accessors, bufferViews: views, buffers: [{ byteLength: bytes.length }]
    };
    return { g: parseGlbBytes(assembleGlb(json as never, Uint8Array.from(bytes))), photos };
}

/** Photo k: 64 x 64 of stone courses and noise, each exposed and tinted its own way. */
function photo(k: number): RgbaImage8 {
    const N = 64, rgba = new Uint8Array(N * N * 4);
    let seed = 1000 + k;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
    const gain = 0.7 + 0.08 * k, tint = [1, 0.9 + 0.02 * (k % 4), 0.85 + 0.03 * (k % 3)];
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
        const base = (y % 6 < 1 ? 70 : 140) + 40 * rnd() + 25 * Math.sin(x / 9 + k);
        for (let c = 0; c < 3; c++) rgba[(y * N + x) * 4 + c] = Math.max(0, Math.min(255, Math.round(base * gain * tint[c])));
        rgba[(y * N + x) * 4 + 3] = 255;
    }
    return { width: N, height: N, rgba };
}

/** The lookup as it was: every candidate's whole outline measured for every point (the 1.5 m margin, 20 m grid). */
function pointByPoint(fps: DistrictFootprint[], marginM = 1.5, cellM = 20): (x: number, z: number) => number {
    const grid = new Map<string, number[]>(), box = new Float64Array(fps.length * 4);
    fps.forEach((b, k) => {
        const pts = b.loops.flat(), xs = pts.map(p => p[0]), zs = pts.map(p => p[1]);
        box.set([Math.min(...xs) - marginM, Math.min(...zs) - marginM, Math.max(...xs) + marginM, Math.max(...zs) + marginM], k * 4);
        for (let i = Math.floor(box[k * 4] / cellM); i <= Math.floor(box[k * 4 + 2] / cellM); i++) for (let j = Math.floor(box[k * 4 + 1] / cellM); j <= Math.floor(box[k * 4 + 3] / cellM); j++) {
            const c = grid.get(`${i},${j}`); if (c) c.push(k); else grid.set(`${i},${j}`, [k]);
        }
    });
    return (x, z) => {
        let best = -1, bestD = marginM;
        for (const k of grid.get(`${Math.floor(x / cellM)},${Math.floor(z / cellM)}`) ?? []) {
            if (x < box[k * 4] || z < box[k * 4 + 1] || x > box[k * 4 + 2] || z > box[k * 4 + 3]) continue;
            const d = signedFootprintDistance(x, z, fps[k].loops);
            if (d <= bestD) { bestD = d; best = k; }
        }
        return best;
    };
}

const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex').slice(0, 16);

/** The per-sample string-keyed harmonise's output on districtGlb (report without its times, and each photo's hash). */
const GOLDEN = {
    report:
        "{\"images\":10,\"samples\":154369,\"groups\":77,\"roofs\":{\"roofM2\":11923,\"hiddenM2\":2389,\"roofGains\":3},\"gains\":{\"meanAbsLog\":0.1114,\"maxAbsLog\":0.2939},\"seams\":{\"pairs\":2266,\"before\":0.5007,\"afterMatch\":0.387,\"after\":0.3071},\"kept\":true,\"why\":\"10 photos matched to 77 side and height-band references, roofs apart (11923 m² of roof seen from above, 2389 m² of hidden up-facing surface left out; 3 roof gains) (mean gain 12%), 2266 shared surface patches levelled: mean patch difference 0.5007 -> 0.387 (matched) -> 0.3071 (levelled), in log colour\"}",
    photos:
        "[[0,\"b0536ee52b7c6ebf\"],[1,\"524a5e28fc1693aa\"],[2,\"bd8a242fb999ee29\"],[3,\"6440edfeea21f6e9\"],[4,\"8df2adc23578dcae\"],[5,\"9e7addf84aaa04fb\"],[6,\"6e383dfc26516092\"],[7,\"eb68eee7025e608b\"],[8,\"59b5fee9601b1595\"],[9,\"b52592ba71d456de\"]]"
};

describe('pipeline K-D harmonise: fast on a district, the same answers', () => {
    let native: string | undefined;
    beforeAll(() => { native = process.env.SCRATCHBOX_K_NATIVE; process.env.SCRATCHBOX_K_NATIVE = '0'; });
    afterAll(() => { if (native === undefined) delete process.env.SCRATCHBOX_K_NATIVE; else process.env.SCRATCHBOX_K_NATIVE = native; });

    it('settles the building per square of plan with the point-by-point answer everywhere', () => {
        const fps: DistrictFootprint[] = districtFootprints(district());
        const fast = districtBuildingIndex(fps), measured = districtBuildingIndex(fps, undefined, { exact: true }), exact = pointByPoint(fps);
        const pts: V2[] = [];
        // a dense grid off the squares' lattice, and one on it (every 0.25 m, the finest square's edges)
        for (let x = -5; x < 115; x += 0.0731) for (let z = -5; z < 75; z += 0.0731) pts.push([x, z]);
        for (let x = -5; x <= 115; x += 0.25) for (let z = -5; z <= 75; z += 0.25) pts.push([x, z]);
        // on every edge and corner, and a hair either side of each edge's middle
        for (const f of fps) for (const loop of f.loops) for (let i = 0; i < loop.length; i++) {
            const p = loop[i], q = loop[(i + 1) % loop.length], mx = (p[0] + q[0]) / 2, mz = (p[1] + q[1]) / 2, l = Math.hypot(q[0] - p[0], q[1] - p[1]);
            pts.push(p, [mx, mz]);
            for (const off of [1e-9, 1e-4, 1.5 - 1e-9, 1.5, 1.5 + 1e-9]) for (const sgn of [-1, 1]) pts.push([mx + (sgn * off * (q[1] - p[1])) / l, mz - (sgn * off * (q[0] - p[0])) / l]);
        }
        let seed = 3;
        const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
        for (let k = 0; k < 200000; k++) pts.push([-5 + 120 * rnd(), -5 + 80 * rnd()]);
        const a = Int32Array.from(pts, ([x, z]) => fast(x, z)), m = Int32Array.from(pts, ([x, z]) => measured(x, z)), b = Int32Array.from(pts, ([x, z]) => exact(x, z));
        let differ = 0, differMeasured = 0;
        for (let i = 0; i < a.length; i++) { if (a[i] !== b[i]) differ++; if (m[i] !== b[i]) differMeasured++; }
        expect(differ).toBe(0);
        expect(differMeasured).toBe(0);
        // every building, and the street, is found
        expect(new Set(a)).toEqual(new Set([-1, 0, 1, 2, 3, 4, 5]));
    });

    it('harmonises the district to the same report and photos as the per-sample string-keyed code', () => {
        const { g, photos } = districtGlb();
        const images = new Map<number, RgbaImage8>(Array.from({ length: photos }, (_, k) => [k, photo(k)]));
        const r = harmonizeTextures(g, g.json, images, 0, undefined, undefined, { buildingOf: districtBuildingIndex(districtFootprints(district())) });
        const { ms: _ms, phasesMs: _phases, ...report } = r;
        expect(r.kept).toBe(true);
        expect(r.seams.pairs).toBeGreaterThan(100);
        expect(JSON.stringify(report)).toBe(GOLDEN.report);
        expect(JSON.stringify([...images].map(([k, im]) => [k, sha(im.rgba)]))).toBe(GOLDEN.photos);
    });

    it('measures far fewer points: a large district\'s lookups, once per sample, against twice point by point', () => {
        // 64 buildings of 160-sided outlines on a 30 m pitch (neighbours up to touching: their margins overlap), 400,000 sample points over them (most on walls and roofs)
        const fps: DistrictFootprint[] = [];
        for (let i = 0; i < 8; i++) for (let j = 0; j < 8; j++) fps.push({ id: `${i},${j}`, loops: [ngon(30 * i, 30 * j, 13 + (i + j) % 3, 160)] });
        let seed = 11;
        const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
        const xs = new Float64Array(400000), zs = new Float64Array(400000);
        for (let k = 0; k < xs.length; k++) {
            const b = fps[Math.floor(rnd() * fps.length)].loops[0], c = b[Math.floor(rnd() * b.length)], t = rnd();
            // half on the walls (a plan point on the outline, stacked storeys share it), half anywhere near
            if (k % 2) { xs[k] = c[0]; zs[k] = c[1]; } else { xs[k] = c[0] + (t - 0.5) * 40; zs[k] = c[1] + (rnd() - 0.5) * 40; }
            if (k % 4 === 1) { xs[k] = xs[k - 1]; zs[k] = zs[k - 1]; }
        }
        const exact = pointByPoint(fps), fast = districtBuildingIndex(fps);
        let t = performance.now();
        const before = new Int32Array(xs.length);
        for (let pass = 0; pass < 2; pass++) for (let k = 0; k < xs.length; k++) before[k] = exact(xs[k], zs[k]);
        const exactMs = performance.now() - t;
        t = performance.now();
        const after = new Int32Array(xs.length);
        for (let k = 0; k < xs.length; k++) after[k] = fast(xs[k], zs[k]);
        const fastMs = performance.now() - t;
        expect(after).toEqual(before);
        console.log(`[harmonize parity] 400,000 district lookups: ${exactMs.toFixed(0)} ms point by point (twice, as gains and patches did), ${fastMs.toFixed(0)} ms per square of plan (once)`);
        expect(fastMs).toBeLessThan(exactMs / 4);
    });
});
