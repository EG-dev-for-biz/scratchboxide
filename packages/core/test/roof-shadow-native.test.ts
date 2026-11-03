/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The roof cast-shadow kernels in C++ (scratchbox_roof_shadow.hpp, pipeline-k/native/roof-shadow-native.ts) against
 * roof-shadow.ts on a synthetic roof: a 60 x 60 m deck at 100 m with a parapet and a tower to 160 m, a taller neighbour
 * at +x casting a shadow over half the deck, and context blocks around; the deck's photo painted with a true sun's
 * shadow (az 0, el 40).
 *
 *   1. shadowMapNative is shadowMap, pixel for pixel (an oblique sun, a sun along the walls, the map from above);
 *   2. shadowedBitsNative is shadowedAt over every roof cell;
 *   3. sunSearchNative is roofShadowLift's step 3 (scored suns, medians, coarse bits, candidates), and its best deck sun
 *      is the one roofShadowLift reports;
 *   4. the native search and lift reproduce roofShadowLift's lifted photo byte for byte;
 *   5. liftRoofShadowsNative is step 7 on a pass with a terrace across photos as well as a photo's own sun;
 *   6. roofShadowLift itself, with SCRATCHBOX_K_NATIVE=roof-shadow, gives the same photos and report as without.
 * All comparisons are exact. The references below that roof-shadow.ts does not export (occludersOf, roofCells,
 * planesOf, planeScore, shadowFraction, the step 3 and step 7 loops) are verbatim copies of roof-shadow/9.
 * Last, the TypeScript and native search and lift are timed on a roof of a few hundred thousand occluders.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { writeGlb, encodePng, type Chunk } from './helpers/synthetic-scan-glb';
import { parseGlbBytes } from '../src/node/3d-engine/staged-location/glb-bytes';
import { ROOF_SHADOW_PARAMS, roofShadowLift, shadowMap, shadowedAt, type Occluders, type RoofShadowParams, type ShadowMap } from '../src/node/3d-engine/staged-location/pipeline-k/roof-shadow';
import { collect, type Soup } from '../src/node/3d-engine/staged-location/pipeline-k/view-relight';
import { SRGB8_TO_LINEAR, linearToSrgb255 } from '../src/common/spatial/photogrammetric-delight';
import { TEXEL_NONE } from '../src/node/3d-engine/staged-location/pipeline-k/texture-harmonize';
import type { RgbaImage8 } from '../src/node/3d-engine/staged-location/tile-texture-transfer';
import {
    ensureRoofShadowNativeBinary, liftRoofShadowsNative, shadowMapNative, shadowedBitsNative, sunSearchNative,
    type RoofCells, type RoofShadowLiftPass, type RoofShadowScored
} from '../src/node/3d-engine/staged-location/pipeline-k/native/roof-shadow-native';

type V3 = [number, number, number];
const P0 = ROOF_SHADOW_PARAMS;

// ---- the synthetic roof ----

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

interface Scene { g: ReturnType<typeof parseGlbBytes>; photos: Map<number, RgbaImage8>; surfaces: Map<number, Uint8Array>; context: { vertices: Float32Array; indices: Uint32Array }; twinTriangles: number; contextTriangles: number }

/** `step`: the twin's tessellation (m); `ctxStep`: the context's; `texel`: the photos' texel (m); `blocks`: context blocks on a ring. */
function buildScene(step: number, ctxStep: number, texel: number, blocks: number): Scene {
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
        const g = parseGlbBytes(new Uint8Array(fs.readFileSync(file)));
        return { g, photos, surfaces, context: { vertices: Float32Array.from(vertices), indices: Uint32Array.from(indices) }, twinTriangles: twin.reduce((s, c) => s + c.indices.length / 3, 0), contextTriangles: indices.length / 3 };
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

// ---- verbatim copies of roof-shadow.ts's unexported steps (roof-shadow/9) ----

function occludersOf(soup: Soup, context: { vertices: ArrayLike<number>; indices: ArrayLike<number> } | undefined, P: RoofShadowParams): Occluders {
    if (!context) return { P: soup.P, n: soup.n };
    let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
    for (let i = 0; i < soup.P.length; i += 3) { x0 = Math.min(x0, soup.P[i]); x1 = Math.max(x1, soup.P[i]); z0 = Math.min(z0, soup.P[i + 2]); z1 = Math.max(z1, soup.P[i + 2]); }
    const g = P.footprintGrowM, W = Math.ceil(x1 - x0 + 2 * g) + 1, H = Math.ceil(z1 - z0 + 2 * g) + 1, X0 = x0 - g, Z0 = z0 - g;
    const core = new Uint8Array(W * H);
    for (let t = 0; t < soup.n; t++) {
        const a = t * 9, xs = [soup.P[a] - X0, soup.P[a + 3] - X0, soup.P[a + 6] - X0], zs = [soup.P[a + 2] - Z0, soup.P[a + 5] - Z0, soup.P[a + 8] - Z0];
        for (let k = 0; k < 3; k++) core[Math.min(H - 1, Math.floor(zs[k])) * W + Math.min(W - 1, Math.floor(xs[k]))] = 1;
        const det = (xs[1] - xs[0]) * (zs[2] - zs[0]) - (xs[2] - xs[0]) * (zs[1] - zs[0]);
        if (Math.abs(det) < 1e-9) continue;
        for (let z = Math.max(0, Math.floor(Math.min(...zs))); z <= Math.min(H - 1, Math.floor(Math.max(...zs))); z++)
            for (let x = Math.max(0, Math.floor(Math.min(...xs))); x <= Math.min(W - 1, Math.floor(Math.max(...xs))); x++) {
                const px = x + 0.5, pz = z + 0.5;
                const b1 = ((px - xs[0]) * (zs[2] - zs[0]) - (xs[2] - xs[0]) * (pz - zs[0])) / det, b2 = ((xs[1] - xs[0]) * (pz - zs[0]) - (px - xs[0]) * (zs[1] - zs[0])) / det;
                if (b1 >= 0 && b2 >= 0 && b1 + b2 <= 1) core[z * W + x] = 1;
            }
    }
    const plan = new Uint8Array(W * H), r = Math.ceil(g);
    for (let z = 0; z < H; z++) for (let x = 0; x < W; x++) {
        if (!core[z * W + x]) continue;
        for (let dz = -r; dz <= r; dz++) for (let dx = -r; dx <= r; dx++) { const zz = z + dz, xx = x + dx; if (zz >= 0 && xx >= 0 && zz < H && xx < W) plan[zz * W + xx] = 1; }
    }
    const cx = (x0 + x1) / 2, cz = (z0 + z1) / 2, out: number[] = [];
    const V = context.vertices, I = context.indices;
    for (let t = 0; t + 2 < I.length; t += 3) {
        const a = I[t] * 3, b = I[t + 1] * 3, c = I[t + 2] * 3;
        const mx = (V[a] + V[b] + V[c]) / 3, mz = (V[a + 2] + V[b + 2] + V[c + 2]) / 3;
        if (Math.hypot(mx - cx, mz - cz) > P.contextRadiusM) continue;
        const px = Math.floor(mx - X0), pz = Math.floor(mz - Z0);
        if (px >= 0 && pz >= 0 && px < W && pz < H && plan[pz * W + px]) continue;
        out.push(V[a], V[a + 1], V[a + 2], V[b], V[b + 1], V[b + 2], V[c], V[c + 1], V[c + 2]);
    }
    const all = new Float32Array(soup.P.length + out.length);
    all.set(soup.P); all.set(out, soup.P.length);
    return { P: all, n: soup.n + out.length / 9 };
}

function shadowFraction(m: ShadowMap, x: number, y: number, z: number, biasM: number): number {
    const fx = (x * m.r[0] + y * m.r[1] + z * m.r[2] - m.X0) / m.mpp - 0.5, fy = (m.Y1 - (x * m.u[0] + y * m.u[1] + z * m.u[2])) / m.mpp - 0.5;
    const x0 = Math.floor(fx), y0 = Math.floor(fy), ax = fx - x0, ay = fy - y0, t = x * m.s[0] + y * m.s[1] + z * m.s[2] + biasM + m.slope;
    let f = 0;
    for (const [dx, dy, w] of [[0, 0, (1 - ax) * (1 - ay)], [1, 0, ax * (1 - ay)], [0, 1, (1 - ax) * ay], [1, 1, ax * ay]] as const) {
        const px = x0 + dx, py = y0 + dy;
        if (px < 0 || py < 0 || px >= m.W || py >= m.H) continue;
        if (m.top[py * m.W + px] > t) f += w;
    }
    return f;
}

function roofCells(soup: Soup, photos: Map<number, RgbaImage8>, surfaces: Map<number, Uint8Array>, above: ShadowMap, P: RoofShadowParams): RoofCells {
    const G = P.cellTexels;
    const img: number[] = [], p: number[] = [], c: number[] = [];
    const taken = new Map<number, Set<number>>();
    for (let t = 0; t < soup.n; t++) {
        const im = soup.img[t];
        if (im < 0 || Math.abs(soup.N[t * 3 + 1]) < P.flatNy) continue;
        const photo = photos.get(im), mask = surfaces.get(im);
        if (!photo || !mask) continue;
        const W = photo.width, H = photo.height, gw = Math.ceil(W / G);
        let seen = taken.get(im);
        if (!seen) taken.set(im, (seen = new Set()));
        const a = t * 9, q = t * 6;
        const ax = (soup.UV[q] * W) / G, ay = (soup.UV[q + 1] * H) / G, bx = (soup.UV[q + 2] * W) / G, by = (soup.UV[q + 3] * H) / G, cx = (soup.UV[q + 4] * W) / G, cy = (soup.UV[q + 5] * H) / G;
        const det = (bx - ax) * (cy - ay) - (cx - ax) * (by - ay);
        if (Math.abs(det) < 1e-12) continue;
        const x0 = Math.max(0, Math.floor(Math.min(ax, bx, cx))), x1 = Math.min(gw - 1, Math.ceil(Math.max(ax, bx, cx)));
        const y0 = Math.max(0, Math.floor(Math.min(ay, by, cy))), y1 = Math.min(Math.ceil(H / G) - 1, Math.ceil(Math.max(ay, by, cy)));
        for (let gy = y0; gy <= y1; gy++) for (let gx = x0; gx <= x1; gx++) {
            const px = gx + 0.5, py = gy + 0.5;
            const b1 = ((px - ax) * (cy - ay) - (cx - ax) * (py - ay)) / det, b2 = ((bx - ax) * (py - ay) - (px - ax) * (by - ay)) / det, b0 = 1 - b1 - b2;
            if (b0 < 0 || b1 < 0 || b2 < 0) continue;
            const key = gy * gw + gx;
            if (seen.has(key)) continue;
            const tx = Math.min(W - 1, Math.floor(px * G)), ty = Math.min(H - 1, Math.floor(py * G)), i = ty * W + tx;
            if (mask[i] === TEXEL_NONE) continue;
            const x = b0 * soup.P[a] + b1 * soup.P[a + 3] + b2 * soup.P[a + 6], y = b0 * soup.P[a + 1] + b1 * soup.P[a + 4] + b2 * soup.P[a + 7], z = b0 * soup.P[a + 2] + b1 * soup.P[a + 5] + b2 * soup.P[a + 8];
            if (shadowedAt(above, x, y, z, P.biasM)) continue;
            seen.add(key);
            img.push(im); p.push(x, y, z);
            for (let k = 0; k < 3; k++) c.push(Math.log(1e-4 + SRGB8_TO_LINEAR[photo.rgba[i * 4 + k]]));
        }
    }
    return { n: img.length, img: Int32Array.from(img), p: Float32Array.from(p), c: Float32Array.from(c) };
}

function planesOf(cells: RoofCells, P: RoofShadowParams): Array<{ y: number; idx: Int32Array }> {
    const bins = new Map<number, number>();
    for (let i = 0; i < cells.n; i++) { const b = Math.round(cells.p[i * 3 + 1] / P.planeBinM); bins.set(b, (bins.get(b) ?? 0) + 1); }
    const peaks: number[] = [];
    for (const [b, n] of bins) {
        const around = (bins.get(b - 1) ?? 0) + n + (bins.get(b + 1) ?? 0);
        if (around >= P.minPlaneCells && n >= (bins.get(b - 1) ?? 0) && n > (bins.get(b + 1) ?? 0)) peaks.push(b * P.planeBinM);
    }
    peaks.sort((a, b) => a - b);
    const members = peaks.map(() => [] as number[]);
    for (let i = 0; i < cells.n; i++) {
        const y = cells.p[i * 3 + 1];
        let best = -1, bd = P.planeTolM;
        peaks.forEach((py, k) => { const d = Math.abs(y - py); if (d <= bd) { bd = d; best = k; } });
        if (best >= 0) members[best].push(i);
    }
    return peaks.map((y, k) => ({ y, idx: Int32Array.from(members[k]) })).filter(pl => pl.idx.length >= P.minPlaneCells);
}

const lum = (c: Float32Array, i: number) => 0.2126 * c[i * 3] + 0.7152 * c[i * 3 + 1] + 0.0722 * c[i * 3 + 2];

function planeScore(cells: RoofCells, idx: Int32Array, m: ShadowMap, P: RoofShadowParams): { share: number; ratio: number; rgb: [number, number, number]; halves: [number, number] } {
    const sum = [[0, 0, 0, 0], [0, 0, 0, 0]], n = [0, 0], hs = [[0, 0], [0, 0]], hn = [[0, 0], [0, 0]];
    for (const i of idx) {
        const sh = shadowedAt(m, cells.p[i * 3], cells.p[i * 3 + 1], cells.p[i * 3 + 2], P.biasM) ? 1 : 0;
        n[sh]++;
        for (let k = 0; k < 3; k++) sum[sh][k] += cells.c[i * 3 + k];
        const L = lum(cells.c, i);
        sum[sh][3] += L;
        const half = (Math.floor(cells.p[i * 3] / P.halfBlockM) + Math.floor(cells.p[i * 3 + 2] / P.halfBlockM)) & 1;
        hs[half][sh] += L; hn[half][sh]++;
    }
    const share = n[1] / Math.max(1, n[0] + n[1]);
    if (!n[0] || !n[1]) return { share, ratio: 0, rgb: [1, 1, 1], halves: [0, 0] };
    const step = (k: number) => Math.exp(sum[0][k] / n[0] - sum[1][k] / n[1]);
    const half = (h: number) => (hn[h][0] && hn[h][1] ? Math.exp(hs[h][0] / hn[h][0] - hs[h][1] / hn[h][1]) : 0);
    return { share, ratio: step(3), rgb: [step(0), step(1), step(2)], halves: [half(0), half(1)] };
}

/** roofShadowLift's step 3 (the coarse suns, the medians, each plane's best refined). */
function referenceSunSearch(occ: Occluders, cells: RoofCells, planes: Array<{ y: number; idx: Int32Array }>, P: RoofShadowParams) {
    type Cand = { az: number; el: number };
    const scored: RoofShadowScored[][] = planes.map(() => []);
    const valid = (s: RoofShadowScored) => s.share >= P.minShare && s.share <= P.maxShare && s.ratio > 0;
    const coarseBits: Array<{ cand: Cand; bits: Uint8Array }> = [];
    let candidates = 0;
    const evaluate = (cand: Cand, which: number[], keep = false) => {
        const m = shadowMap(occ, cand.az, cand.el, P.coarseMapM);
        candidates++;
        for (const k of which) scored[k].push({ ...cand, ...planeScore(cells, planes[k].idx, m, P) });
        if (keep) {
            const bits = new Uint8Array(cells.n);
            for (let i = 0; i < cells.n; i++) bits[i] = shadowedAt(m, cells.p[i * 3], cells.p[i * 3 + 1], cells.p[i * 3 + 2], P.biasM) ? 1 : 0;
            coarseBits.push({ cand, bits });
        }
    };
    const all = planes.map((_, k) => k);
    const coarse: Cand[] = [];
    for (const el of P.coarseElDeg) for (let az = 0; az < 360; az += P.coarseAzDeg) coarse.push({ az, el });
    for (const cand of coarse) evaluate(cand, all, true);
    const medians = scored.map(list => { const r = list.filter(valid).map(s => s.ratio).sort((a, b) => a - b); return r.length ? r[Math.floor(r.length / 2)] : 0; });
    for (let k = 0; k < planes.length; k++) {
        const v = scored[k].filter(valid);
        if (!v.length) continue;
        const best = v.reduce((a, b) => (b.ratio > a.ratio ? b : a));
        for (let da = -P.refineSteps; da <= P.refineSteps; da++) for (let de = -P.refineSteps; de <= P.refineSteps; de++) {
            const el = best.el + de * P.refineDeg;
            if ((da || de) && el >= 5 && el <= 85) evaluate({ az: (best.az + da * P.refineDeg + 360) % 360, el }, [k]);
        }
    }
    return { scored, medians, coarseBits, candidates };
}

/** roofShadowLift's step 7 over a resolved pass (the loop as written there, its maps read through the pass). */
function referenceLift(pass: RoofShadowLiftPass, P: RoofShadowParams) {
    const { soup, occ, photos, surfaces } = pass;
    const above = shadowMap(soup, 0, 89.9, P.aboveMapM);
    const gridKey = (x: number, y: number, z: number) => `${Math.round(y / P.terraceBinM)}:${Math.floor(x / P.componentGridM)}:${Math.floor(z / P.componentGridM)}`;
    const changed = new Map<number, Uint8Array>(), planeLifted = new Map<number, number>();
    let texelsLifted = 0;
    pass.suns.forEach((sunScored, sunIdx) => {
        const m = shadowMap(occ, sunScored.az, sunScored.el, P.fineMapM);
        for (let t = 0; t < soup.n; t++) {
            const im = soup.img[t];
            if (im < 0 || Math.abs(soup.N[t * 3 + 1]) < P.flatNy) continue;
            const sun = pass.photoSun.get(im);
            if (sun ? sun.sun !== sunIdx : !pass.hasComp) continue;
            const photo = photos.get(im), mask = surfaces.get(im);
            if (!photo || !mask) continue;
            const a = t * 9, q = t * 6, W = photo.width, H = photo.height;
            const ax = soup.UV[q] * W, ay = soup.UV[q + 1] * H, bx = soup.UV[q + 2] * W, by = soup.UV[q + 3] * H, cx = soup.UV[q + 4] * W, cy = soup.UV[q + 5] * H;
            const det = (bx - ax) * (cy - ay) - (cx - ax) * (by - ay);
            if (Math.abs(det) < 1e-12) continue;
            let out = changed.get(im);
            const x0 = Math.max(0, Math.floor(Math.min(ax, bx, cx))), x1 = Math.min(W - 1, Math.ceil(Math.max(ax, bx, cx)));
            const y0 = Math.max(0, Math.floor(Math.min(ay, by, cy))), y1 = Math.min(H - 1, Math.ceil(Math.max(ay, by, cy)));
            for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
                const i = y * W + x;
                if (mask[i] === TEXEL_NONE) continue;
                const px = x + 0.5, py = y + 0.5;
                const b1 = ((px - ax) * (cy - ay) - (cx - ax) * (py - ay)) / det, b2 = ((bx - ax) * (py - ay) - (px - ax) * (by - ay)) / det, b0 = 1 - b1 - b2;
                if (b0 < 0 || b1 < 0 || b2 < 0) continue;
                const wx = b0 * soup.P[a] + b1 * soup.P[a + 3] + b2 * soup.P[a + 6], wy = b0 * soup.P[a + 1] + b1 * soup.P[a + 4] + b2 * soup.P[a + 7], wz = b0 * soup.P[a + 2] + b1 * soup.P[a + 5] + b2 * soup.P[a + 8];
                let ratio: number[], lit: number | undefined;
                if (sun) {
                    const key = `${im}:${Math.round(wy / P.terraceBinM)}`;
                    if (!pass.liftTerrace.has(key)) continue;
                    ratio = sun.ratio; lit = pass.liftTerrace.get(key);
                } else {
                    const ci = pass.compCells.get(gridKey(wx, wy, wz)), cs = ci === undefined ? undefined : pass.comps[ci];
                    if (!cs || cs.sun !== sunIdx) continue;
                    ratio = cs.ratio; lit = cs.lit;
                }
                if (shadowedAt(above, wx, wy, wz, P.biasM)) continue;
                let f = shadowFraction(m, wx, wy, wz, P.biasM);
                if (f <= 0) continue;
                if (lit !== undefined) {
                    const L = 0.2126 * Math.log(1e-4 + SRGB8_TO_LINEAR[photo.rgba[i * 4]]) + 0.7152 * Math.log(1e-4 + SRGB8_TO_LINEAR[photo.rgba[i * 4 + 1]]) + 0.0722 * Math.log(1e-4 + SRGB8_TO_LINEAR[photo.rgba[i * 4 + 2]]);
                    const full = f * Math.log(0.2126 * ratio[0] + 0.7152 * ratio[1] + 0.0722 * ratio[2]);
                    if (full > 0) f *= Math.max(0, Math.min(1, (lit - L) / full));
                    if (f <= 0.01) continue;
                }
                if (!out) changed.set(im, (out = Uint8Array.from(photo.rgba)));
                texelsLifted++;
                if (sun && sun.k >= 0) planeLifted.set(sun.k, (planeLifted.get(sun.k) ?? 0) + 1);
                for (let k2 = 0; k2 < 3; k2++) out[i * 4 + k2] = Math.round(linearToSrgb255(SRGB8_TO_LINEAR[photo.rgba[i * 4 + k2]] * Math.pow(ratio[k2], f)));
            }
        }
    });
    return { changed, texelsLifted, planeLifted };
}

// ---- helpers ----

interface Prepared { scene: Scene; soup: Soup; occ: Occluders; above: ShadowMap; cells: RoofCells; planes: Array<{ y: number; idx: Int32Array }> }
function prepare(scene: Scene): Prepared {
    const soup = collect(scene.g, scene.g.json);
    const above = shadowMap(soup, 0, 89.9, P0.aboveMapM);
    const occ = occludersOf(soup, scene.context, P0);
    const cells = roofCells(soup, scene.photos, scene.surfaces, above, P0);
    return { scene, soup, occ, above, cells, planes: planesOf(cells, P0) };
}

/** Bit-exact equality of two float arrays (NaN and -Infinity included), reporting the first difference. */
function firstFloatDifference(a: Float32Array, b: Float32Array): number {
    if (a.length !== b.length) return -2;
    const ua = new Uint32Array(a.buffer, a.byteOffset, a.length), ub = new Uint32Array(b.buffer, b.byteOffset, b.length);
    for (let i = 0; i < ua.length; i++) if (ua[i] !== ub[i]) return i;
    return -1;
}

const clonePhotos = (photos: Map<number, RgbaImage8>) => new Map([...photos].map(([k, v]) => [k, { width: v.width, height: v.height, rgba: Uint8Array.from(v.rgba) }]));

describe('roof shadow native kernels equal roof-shadow.ts', () => {
    let small: Prepared;

    beforeAll(async () => {
        // the first build is paid here, outside every timing
        await ensureRoofShadowNativeBinary();
        small = prepare(buildScene(0.5, 3, 0.1, 8));
    }, 600_000);

    it('builds a scene the fit accepts', () => {
        expect(small.cells.n).toBeGreaterThan(30_000);
        expect(small.planes.map(p => p.y)).toEqual([100, 160]);
        expect(small.occ.n).toBeGreaterThan(small.soup.n);
    });

    it('shadowMapNative is shadowMap, pixel for pixel', async () => {
        const cases: Array<[Occluders, number, number, number]> = [[small.occ, 0, 40, 0.4], [small.occ, 37.5, 23, 0.15], [small.occ, 90, 60, 0.4], [small.soup, 0, 89.9, 0.25]];
        for (const [occ, az, el, mpp] of cases) {
            const ts = shadowMap(occ, az, el, mpp), nat = await shadowMapNative(occ, az, el, mpp);
            expect({ W: nat.W, H: nat.H, X0: nat.X0, Y1: nat.Y1, slope: nat.slope, s: nat.s, r: nat.r, u: nat.u }).toEqual({ W: ts.W, H: ts.H, X0: ts.X0, Y1: ts.Y1, slope: ts.slope, s: ts.s, r: ts.r, u: ts.u });
            expect(firstFloatDifference(nat.top, ts.top)).toBe(-1);
            expect(ts.top.some(v => v > -Infinity)).toBe(true);
        }
    });

    it('shadowedBitsNative is shadowedAt over every roof cell', async () => {
        const suns = [{ az: 0, el: 40 }, { az: 135, el: 20 }, { az: 300, el: 70 }];
        const nat = await shadowedBitsNative(small.occ, suns, P0.coarseMapM, small.cells.p, P0.biasM);
        suns.forEach((s, k) => {
            const m = shadowMap(small.occ, s.az, s.el, P0.coarseMapM), ts = new Uint8Array(small.cells.n);
            for (let i = 0; i < small.cells.n; i++) ts[i] = shadowedAt(m, small.cells.p[i * 3], small.cells.p[i * 3 + 1], small.cells.p[i * 3 + 2], P0.biasM) ? 1 : 0;
            expect(Buffer.from(nat[k]).equals(Buffer.from(ts))).toBe(true);
        });
        expect(nat[0].reduce((a, b) => a + b, 0)).toBeGreaterThan(1000);
    });

    it('sunSearchNative is step 3, and its best deck sun is the one roofShadowLift reports', async () => {
        const ts = referenceSunSearch(small.occ, small.cells, small.planes, P0);
        const nat = await sunSearchNative(small.occ, small.cells, small.planes, P0);
        expect(nat.candidates).toBe(ts.candidates);
        expect(nat.medians).toEqual(ts.medians);
        expect(nat.scored).toEqual(ts.scored);
        expect(nat.coarseBits.length).toBe(ts.coarseBits.length);
        nat.coarseBits.forEach((b, c) => { expect(b.cand).toEqual(ts.coarseBits[c].cand); expect(Buffer.from(b.bits).equals(Buffer.from(ts.coarseBits[c].bits))).toBe(true); });
        // against the real roofShadowLift's records
        const report = await roofShadowLift(small.scene.g, small.scene.g.json, clonePhotos(small.scene.photos), small.scene.surfaces, { context: small.scene.context });
        expect(report.candidates).toBe(nat.candidates);
        const valid = (s: RoofShadowScored) => s.share >= P0.minShare && s.share <= P0.maxShare && s.ratio > 0;
        const deck = report.records[0], best = nat.scored[0].filter(valid).reduce((a, b) => (b.ratio > a.ratio ? b : a));
        expect(deck.accepted).toBe(true);
        expect({ az: deck.sunAzDeg, el: deck.sunElDeg, ratio: deck.ratio, share: deck.shadowShare, median: deck.medianRatio }).toEqual({ az: best.az, el: best.el, ratio: +best.ratio.toFixed(3), share: +best.share.toFixed(3), median: +nat.medians[0].toFixed(3) });
        expect([best.az, best.el]).toEqual([0, 40]);
    });

    it('the native search and lift reproduce roofShadowLift\'s lifted photo byte for byte', async () => {
        const photos = clonePhotos(small.scene.photos);
        const report = await roofShadowLift(small.scene.g, small.scene.g.json, photos, small.scene.surfaces, { context: small.scene.context });
        expect(report.records.map(r => r.accepted)).toEqual([true, false]);
        expect(report.terraces.photos).toBe(1);
        expect(report.terraces.lifted).toBe(1);
        expect(report.terraces.componentsLifted).toBe(0);
        // the native path: the deck's sun from the search; photo 0 takes it (as roofShadowLift's step 5 does here); its
        // one terrace at 100 m lifted with its lit level (step 5's), measured on the coarse map through shadowedBitsNative
        const nat = await sunSearchNative(small.occ, small.cells, small.planes, P0);
        const valid = (s: RoofShadowScored) => s.share >= P0.minShare && s.share <= P0.maxShare && s.ratio > 0;
        const best = nat.scored[0].filter(valid).reduce((a, b) => (b.ratio > a.ratio ? b : a));
        const [bits] = await shadowedBitsNative(small.occ, [best], P0.coarseMapM, small.cells.p, P0.biasM);
        let nl = 0, ll = 0;
        for (let i = 0; i < small.cells.n; i++) if (small.cells.img[i] === 0 && Math.round(small.cells.p[i * 3 + 1] / P0.terraceBinM) === 100 && !bits[i]) { nl++; ll += lum(small.cells.c, i); }
        const pass: RoofShadowLiftPass = {
            soup: small.soup, occ: small.occ, photos: small.scene.photos, surfaces: small.scene.surfaces, suns: [{ az: best.az, el: best.el }],
            photoSun: new Map([[0, { sun: 0, ratio: best.rgb.map(x => Math.min(P0.maxRatio, Math.max(1, x))), k: 0 }]]),
            liftTerrace: new Map([['0:100', ll / nl]]), comps: [], compCells: new Map(), hasComp: false
        };
        const lifted = await liftRoofShadowsNative(pass, P0);
        expect(lifted.texelsLifted).toBe(report.texelsLifted);
        expect(lifted.planeLifted.get(0)).toBe(report.records[0].texelsLifted);
        expect([...lifted.changed.keys()]).toEqual([0]);
        expect(Buffer.from(lifted.changed.get(0)!).equals(Buffer.from(photos.get(0)!.rgba))).toBe(true);
        expect(Buffer.from(photos.get(0)!.rgba).equals(Buffer.from(small.scene.photos.get(0)!.rgba))).toBe(false);
    });

    it('liftRoofShadowsNative is step 7 with terraces across photos and an unknown lit level', async () => {
        const gridKey = (x: number, y: number, z: number) => `${Math.round(y / P0.terraceBinM)}:${Math.floor(x / P0.componentGridM)}:${Math.floor(z / P0.componentGridM)}`;
        const cellsOf = (im: number, side: (x: number) => boolean, comp: number, into: Map<string, number>) => {
            for (let i = 0; i < small.cells.n; i++) if (small.cells.img[i] === im && side(small.cells.p[i * 3])) into.set(gridKey(small.cells.p[i * 3], small.cells.p[i * 3 + 1], small.cells.p[i * 3 + 2]), comp);
            return into;
        };
        const base = { soup: small.soup, occ: small.occ, photos: small.scene.photos, surfaces: small.scene.surfaces };
        const passes: RoofShadowLiftPass[] = [
            // photo 0's own sun on its terrace with no lit level known (the uncapped lift); photo 1 through a terrace across photos
            {
                ...base, suns: [{ az: 0, el: 40 }, { az: 200, el: 25 }],
                photoSun: new Map([[0, { sun: 0, ratio: [2.4, 2.2, 1.9], k: 0 }]]),
                liftTerrace: new Map<string, number | undefined>([['0:100', undefined]]),
                comps: [{ sun: 1, ratio: [1.8, 1.7, 1.5], lit: -1.2 }], compCells: cellsOf(1, () => true, 0, new Map()), hasComp: true
            },
            // photo 0 with no sun of its own, its deck split between two terraces across photos under two suns (the
            // neighbour's shadow on the +x half, the tower's on the other); photo 1 with its own sun and deck -1
            {
                ...base, suns: [{ az: 0, el: 40 }, { az: 180, el: 30 }, { az: 90, el: 50 }],
                photoSun: new Map([[1, { sun: 2, ratio: [1.5, 1.5, 1.5], k: -1 }]]),
                liftTerrace: new Map<string, number | undefined>([['1:160', -2]]),
                comps: [{ sun: 0, ratio: [2.4, 2.2, 1.9], lit: -1.1 }, { sun: 1, ratio: [2, 2, 2], lit: -1.4 }],
                compCells: cellsOf(0, x => x < 0, 1, cellsOf(0, x => x >= 0, 0, new Map())), hasComp: true
            }
        ];
        for (const pass of passes) {
            const ts = referenceLift(pass, P0), nat = await liftRoofShadowsNative(pass, P0);
            expect(ts.texelsLifted).toBeGreaterThan(10_000);
            expect(nat.texelsLifted).toBe(ts.texelsLifted);
            expect([...nat.planeLifted]).toEqual([...ts.planeLifted]);
            expect([...nat.changed.keys()].sort()).toEqual([...ts.changed.keys()].sort());
            for (const [im, rgba] of ts.changed) expect(Buffer.from(nat.changed.get(im)!).equals(Buffer.from(rgba))).toBe(true);
        }
    });

    it('roofShadowLift gives the same photos and report with SCRATCHBOX_K_NATIVE=roof-shadow', async () => {
        const saved = process.env.SCRATCHBOX_K_NATIVE;
        const runOnce = async (native: boolean) => {
            if (native) process.env.SCRATCHBOX_K_NATIVE = 'roof-shadow'; else delete process.env.SCRATCHBOX_K_NATIVE;
            const photos = clonePhotos(small.scene.photos), t = performance.now();
            const report = await roofShadowLift(small.scene.g, small.scene.g.json, photos, small.scene.surfaces, { context: small.scene.context });
            return { photos, report, ms: performance.now() - t };
        };
        try {
            const ts = await runOnce(false), nat = await runOnce(true);
            expect(ts.report.texelsLifted).toBeGreaterThan(10_000);
            expect([...nat.photos.keys()]).toEqual([...ts.photos.keys()]);
            for (const [im, ph] of ts.photos) expect(Buffer.from(nat.photos.get(im)!.rgba).equals(Buffer.from(ph.rgba))).toBe(true);
            expect({ ...nat.report, ms: 0 }).toEqual({ ...ts.report, ms: 0 });
            process.stderr.write(`roofShadowLift on the fixture (${small.occ.n} occluders, ${small.cells.n} roof cells): TS ${ts.ms.toFixed(0)} ms, SCRATCHBOX_K_NATIVE=roof-shadow ${nat.ms.toFixed(0)} ms\n`);
        } finally {
            if (saved === undefined) delete process.env.SCRATCHBOX_K_NATIVE; else process.env.SCRATCHBOX_K_NATIVE = saved;
        }
    });

    it('times the TypeScript and native search and lift on a roof of a few hundred thousand occluders', async () => {
        const big = prepare(buildScene(0.25, 1.6, 0.1, 16));
        const t0 = performance.now();
        const ts = referenceSunSearch(big.occ, big.cells, big.planes, P0);
        const t1 = performance.now();
        const nat = await sunSearchNative(big.occ, big.cells, big.planes, P0);
        const t2 = performance.now();
        expect(nat.scored).toEqual(ts.scored);
        const valid = (s: RoofShadowScored) => s.share >= P0.minShare && s.share <= P0.maxShare && s.ratio > 0;
        const best = ts.scored[0].filter(valid).reduce((a, b) => (b.ratio > a.ratio ? b : a));
        const pass: RoofShadowLiftPass = {
            soup: big.soup, occ: big.occ, photos: big.scene.photos, surfaces: big.scene.surfaces, suns: [{ az: best.az, el: best.el }],
            photoSun: new Map([[0, { sun: 0, ratio: best.rgb.map(x => Math.min(P0.maxRatio, Math.max(1, x))), k: 0 }]]),
            liftTerrace: new Map([['0:100', -1.5]]), comps: [], compCells: new Map(), hasComp: false
        };
        const t3 = performance.now();
        const tsLift = referenceLift(pass, P0);
        const t4 = performance.now();
        const natLift = await liftRoofShadowsNative(pass, P0);
        const t5 = performance.now();
        expect(natLift.texelsLifted).toBe(tsLift.texelsLifted);
        expect(Buffer.from(natLift.changed.get(0)!).equals(Buffer.from(tsLift.changed.get(0)!))).toBe(true);
        const line = `roof shadow, ${big.occ.n} occluders (twin ${big.soup.n}), ${big.cells.n} roof cells, ${big.planes.length} decks, ${ts.candidates} suns: `
            + `search TS ${(t1 - t0).toFixed(0)} ms, native ${(t2 - t1).toFixed(0)} ms (${((t1 - t0) / (t2 - t1)).toFixed(1)}x); `
            + `lift (${tsLift.texelsLifted} texels) TS ${(t4 - t3).toFixed(0)} ms, native ${(t5 - t4).toFixed(0)} ms (${((t4 - t3) / (t5 - t4)).toFixed(1)}x)`;
        process.stderr.write(`${line}\n`);
        expect(big.occ.n).toBeGreaterThan(250_000);
    }, 600_000);
});
