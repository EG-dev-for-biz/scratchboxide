/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The material map of a whole textured building: every surface (walls, roofs, terraces, crown, mast; whatever the
 * texture covers) cut into small patches and grown into continuous materials, the light told apart from the material.
 *
 *  1. Patches. The surface is sampled every spacingM (a barycentric grid on each triangle); each sample's colour is the
 *     texture's mean over a small window there (linear RGB; pipeline K's twin is already de-lit and harmonised), its
 *     normal the triangle's. Triangles a stage filled without a photo carry no colour.
 *  2. The light. Lighting left in the texture changes a material's brightness and, in shadow, shifts its chroma toward
 *     the sky's blue; a material change shifts the chroma itself. Colours are read as log-chromaticity (u = log r/g,
 *     v = log b/g) and log-luminance l; the building's own shadow shift (du/dl, dv/dl) is measured on neighbouring
 *     patches whose brightness differs strongly while their chroma barely does, and removed before chroma is compared.
 *     Surfaces facing up see more sky than walls: the chroma step across roof-wall corners of near one chroma is
 *     measured too (the orientation's light) and removed from the surfaces facing up.
 *  3. Continuity. Neighbouring patches (within neighbourM, on surfaces facing within neighbourCos of each other, or
 *     across a corner) are joined by a graph segmentation whose edge cost is the shadow-compensated chroma step plus the
 *     part of the luminance step the light does not explain: a small step every patch (a smooth gradient of light), a
 *     larger one across a change of orientation (a corner between a lit face and a shaded one), and a shadow-like step
 *     where the chroma matches tightly. Each region grows while its edges stay within its own internal variation plus a
 *     margin that shrinks as it grows; regions under minRegionM2 join their closest neighbour.
 *  4. Materials, in two stages. First the shadows: regions whose shadow-compensated chroma matches within
 *     matShadowChroma join, a cast shadow's brightness step (up to matShadowFree, log) free. Then exposure and
 *     orientation, by mean shift over the groups (chroma as captured, each group read as it looks lit: its best-lit
 *     member's luminance), a flat window of matChroma in chroma and matLumWindow in luminance: groups settling on one mode
 *     are one material, so a material spreads no further than its window, whatever the order. A material under
 *     minMaterialShare of the surface joins its nearest. Colour alone cannot tell dark glass from shaded stone of the
 *     same neutral hue: with the structure's openings given (structure-intent.ts), samples inside them and on the wall
 *     never share a region or a material, each role clustered on its own.
 * Every material says how much surface it covers, its colour (sRGB of its median linear colour), its share facing up
 * (roofs, terraces), and the regions it was grown from.
 */

import type { TileTriangles } from './tile-texture-transfer';

export const BUILDING_MATERIAL_MAP_PARAMS = {
    spacingM: 0.4, neighbourM: 0.6, neighbourCos: 0.7, maxNeighbours: 8,
    /** A sample belongs to an opening when it lies within openingPlaneM of a facade's plane, faces within openingCos of it, and falls inside one of its openings. */
    openingPlaneM: 1.0, openingCos: 0.7,
    /** A patch's colour: the texture's mean over a window of this many texels around the sample (each way). */
    windowTexels: 1,
    /** Shadow shift: measured on neighbour pairs whose luminance differs by shadowMinDl (log) or more and chroma by under shadowMaxDc. */
    shadowMinDl: 0.35, shadowMaxDc: 0.08,
    /** The orientation's light: roof-wall corner pairs within orientMaxDc chroma, at least orientMinPairs of them. */
    orientMaxDc: 0.12, orientMinPairs: 50,
    /** Edge cost: the compensated chroma step over chromaUnit, plus the luminance step past its allowance over lumUnit. */
    chromaUnit: 0.04, lumUnit: 0.15,
    /** Luminance steps the light explains: every patch stepAllow (a gradient), across a corner cornerAllow, a shadow-like step (chroma within shadowChroma) shadowAllow (all log). */
    stepAllow: 0.12, cornerAllow: 1.0, shadowAllow: 0.9, shadowChroma: 0.03,
    /** Segmentation margin (cost x patches): larger merges more. */
    k: 8,
    minRegionM2: 2,
    /** Materials (see the module comment, step 4): the mean shift's window (matChroma chroma, matLumWindow log luminance), the shadow stage's chroma (matShadowChroma) and free step (matShadowFree, log); a material under minMaterialShare of the surface joins its nearest. */
    matChroma: 0.06, matLumWindow: 0.6, matShadowFree: 1.1, matShadowChroma: 0.03, minMaterialShare: 0.01
};
export type BuildingMaterialMapParams = typeof BUILDING_MATERIAL_MAP_PARAMS;
export const BUILDING_MATERIAL_MAP_VERSION = 'building-material-map/1';

/** The structure's openings, per facade: its frame (the straightened photo's) and its openings' rectangles in that photo's pixels (structure-intent.ts windows). */
export interface OpeningFacade { frame: { centroid: number[]; normal: number[]; axisS: number[]; axisT: number[]; orthoSMin: number; orthoTMax: number; pixel: number; width: number; height: number }; rects: number[][] }

export interface BuildingMaterial { id: number; /** 'opening' (inside the structure's openings) or 'surface'. */ role: 'opening' | 'surface'; areaM2: number; share: number; srgb: [number, number, number]; linear: [number, number, number]; chroma: [number, number]; logL: number; upShare: number; regions: number; samples: number }
export interface BuildingMaterialMap {
    version: string; params: BuildingMaterialMapParams;
    /** Samples: position (3 per), normal (3 per), linear colour (3 per; NaN where no photo), triangle and texture uv (2 per). */
    p: Float32Array; n: Float32Array; rgb: Float32Array; tri: Int32Array; uv: Float32Array;
    /** Per sample: its region, its material id (0: no photo) and whether it lies in one of the structure's openings. */
    region: Int32Array; material: Int32Array; opening: Uint8Array;
    materials: BuildingMaterial[];
    shadowSlope: [number, number];
    /** The chroma step from a wall to a surface facing up, measured on their shared corners and removed from the surfaces facing up. */
    orientationShift: [number, number];
    stats: { samples: number; photoSamples: number; edges: number; regions: number; ms: number };
}

const EPS = 1e-3;
const lin2srgb = (c: number) => Math.round(255 * Math.min(1, Math.max(0, c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055)));

/** The radical inverse of i in base b (a Halton sequence). */
const halton = (i: number, b: number) => { let f = 1, r = 0; while (i > 0) { f /= b; r += f * (i % b); i = Math.floor(i / b); } return r; };

/** The surface sampled every spacingM, each sample's colour the texture's mean around it. */
export function sampleBuildingSurface(t: TileTriangles, P: BuildingMaterialMapParams = BUILDING_MATERIAL_MAP_PARAMS): Pick<BuildingMaterialMap, 'p' | 'n' | 'rgb' | 'tri' | 'uv'> {
    const nTri = t.positions.length / 9, P3: number[] = [], N3: number[] = [], C3: number[] = [], T1: number[] = [], U2: number[] = [];
    const rgb = [0, 0, 0];
    const sample = (ti: number, u: number, v: number) => {
        const k = t.texture[ti];
        if (k < 0) { rgb[0] = t.flatLinear[3 * ti]; rgb[1] = t.flatLinear[3 * ti + 1]; rgb[2] = t.flatLinear[3 * ti + 2]; return; }
        const tex = t.textures[k], W = tex.width, H = tex.height, cx = Math.floor((((u % 1) + 1) % 1) * W), cy = Math.floor((((v % 1) + 1) % 1) * H), R = P.windowTexels;
        let r = 0, g = 0, b = 0, n = 0;
        for (let dy = -R; dy <= R; dy++) for (let dx = -R; dx <= R; dx++) { const x = Math.min(W - 1, Math.max(0, cx + dx)), y = Math.min(H - 1, Math.max(0, cy + dy)), o = (y * W + x) * 3; r += tex.linear[o]; g += tex.linear[o + 1]; b += tex.linear[o + 2]; n++; }
        rgb[0] = r / n; rgb[1] = g / n; rgb[2] = b / n;
    };
    // one sample per spacingM^2 / 2 of surface: a triangle smaller than that gets one only as its area accrues it
    const quota = (P.spacingM * P.spacingM) / 2;
    let carry = 0;
    for (let ti = 0; ti < nTri; ti++) {
        const o = 9 * ti, a = [t.positions[o], t.positions[o + 1], t.positions[o + 2]], b = [t.positions[o + 3], t.positions[o + 4], t.positions[o + 5]], c = [t.positions[o + 6], t.positions[o + 7], t.positions[o + 8]];
        const L = Math.max(Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]), Math.hypot(c[0] - b[0], c[1] - b[1], c[2] - b[2]), Math.hypot(a[0] - c[0], a[1] - c[1], a[2] - c[2]));
        if (!(L > 0)) continue;
        const e1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], e2 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
        const area = Math.hypot(e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]) / 2;
        // as many samples as its area holds (the fraction carried to the next triangle), spread by a low-discrepancy sequence
        carry += area / quota;
        const count = Math.floor(carry);
        if (!count) continue;
        carry -= count;
        const fill = !!t.fill?.[ti];
        for (let s = 0; s < count; s++) {
            const h2 = halton(s + 1, 2), h3 = halton(s + 1, 3), sq = Math.sqrt(h2);
            const w0 = 1 - sq, w1 = sq * (1 - h3), w2 = sq * h3;
            for (let k = 0; k < 3; k++) P3.push(w0 * a[k] + w1 * b[k] + w2 * c[k]);
            N3.push(t.normals[3 * ti], t.normals[3 * ti + 1], t.normals[3 * ti + 2]);
            const q = 6 * ti, u = w0 * t.uvs[q] + w1 * t.uvs[q + 2] + w2 * t.uvs[q + 4], v = w0 * t.uvs[q + 1] + w1 * t.uvs[q + 3] + w2 * t.uvs[q + 5];
            U2.push(u, v); T1.push(ti);
            if (fill) C3.push(NaN, NaN, NaN); else { sample(ti, u, v); C3.push(rgb[0], rgb[1], rgb[2]); }
        }
    }
    return { p: Float32Array.from(P3), n: Float32Array.from(N3), rgb: Float32Array.from(C3), tri: Int32Array.from(T1), uv: Float32Array.from(U2) };
}

/** The whole building's material map (see the module comment). */
/** Which samples lie in the structure's openings (see OpeningFacade). */
export function openingSamples(p: Float32Array, nrm: Float32Array, facades: OpeningFacade[], P: BuildingMaterialMapParams = BUILDING_MATERIAL_MAP_PARAMS): Uint8Array {
    const n = p.length / 3, out = new Uint8Array(n);
    for (const f of facades) {
        if (!f.rects.length) continue;
        const F = f.frame, cell = 32, gw = Math.ceil(F.width / cell) + 1, grid = new Map<number, number[][]>();
        for (const r of f.rects) for (let gy = Math.floor(r[1] / cell); gy <= Math.floor(r[3] / cell); gy++) for (let gx = Math.floor(r[0] / cell); gx <= Math.floor(r[2] / cell); gx++) { const k = gy * gw + gx; (grid.get(k) ?? grid.set(k, []).get(k)!).push(r); }
        for (let i = 0; i < n; i++) {
            if (out[i]) continue;
            const x = p[3 * i] - F.centroid[0], y = p[3 * i + 1] - F.centroid[1], z = p[3 * i + 2] - F.centroid[2];
            const d = x * F.normal[0] + y * F.normal[1] + z * F.normal[2];
            if (Math.abs(d) > P.openingPlaneM) continue;
            if (nrm[3 * i] * F.normal[0] + nrm[3 * i + 1] * F.normal[1] + nrm[3 * i + 2] * F.normal[2] < P.openingCos) continue;
            const px = (x * F.axisS[0] + y * F.axisS[1] + z * F.axisS[2] - F.orthoSMin) / F.pixel, py = (F.orthoTMax - (x * F.axisT[0] + y * F.axisT[1] + z * F.axisT[2])) / F.pixel;
            if (px < 0 || py < 0 || px >= F.width || py >= F.height) continue;
            for (const r of grid.get(Math.floor(py / cell) * gw + Math.floor(px / cell)) ?? []) if (px >= r[0] && px <= r[2] && py >= r[1] && py <= r[3]) { out[i] = 1; break; }
        }
    }
    return out;
}

export function buildingMaterialMap(t: TileTriangles, P: BuildingMaterialMapParams = BUILDING_MATERIAL_MAP_PARAMS, opts: { /** The structure's openings: samples in them and on the wall never share a region or a material (dark glass and shaded stone can be one colour; the structure tells them apart). */ openings?: OpeningFacade[] } = {}): BuildingMaterialMap {
    const t0 = Date.now();
    const S = sampleBuildingSurface(t, P), n = S.p.length / 3;
    const opening = opts.openings?.length ? openingSamples(S.p, S.n, opts.openings, P) : new Uint8Array(n);
    // colour features: log chromaticity and log luminance
    const U = new Float32Array(n), V = new Float32Array(n), Lg = new Float32Array(n), has = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
        const r = S.rgb[3 * i], g = S.rgb[3 * i + 1], b = S.rgb[3 * i + 2];
        if (!Number.isFinite(r)) continue;
        has[i] = 1; U[i] = Math.log((r + EPS) / (g + EPS)); V[i] = Math.log((b + EPS) / (g + EPS)); Lg[i] = Math.log(0.2126 * r + 0.7152 * g + 0.0722 * b + EPS);
    }
    // neighbours: a spatial hash at neighbourM
    const cell = P.neighbourM, key = (x: number, y: number, z: number) => `${Math.floor(x / cell)},${Math.floor(y / cell)},${Math.floor(z / cell)}`;
    const grid = new Map<string, number[]>();
    for (let i = 0; i < n; i++) { const k = key(S.p[3 * i], S.p[3 * i + 1], S.p[3 * i + 2]); (grid.get(k) ?? grid.set(k, []).get(k)!).push(i); }
    // each sample's maxNeighbours nearest within neighbourM (pairs kept once)
    const EA: number[] = [], EB: number[] = [], CO: number[] = [];
    const r2 = P.neighbourM * P.neighbourM;
    const near: Array<[number, number]> = [];
    for (let i = 0; i < n; i++) {
        if (!has[i]) continue;
        const x = S.p[3 * i], y = S.p[3 * i + 1], z = S.p[3 * i + 2], cx = Math.floor(x / cell), cy = Math.floor(y / cell), cz = Math.floor(z / cell);
        near.length = 0;
        for (let dz = -1; dz <= 1; dz++) for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) for (const j of grid.get(`${cx + dx},${cy + dy},${cz + dz}`) ?? []) {
            if (j === i || !has[j]) continue;
            const d2 = (S.p[3 * j] - x) ** 2 + (S.p[3 * j + 1] - y) ** 2 + (S.p[3 * j + 2] - z) ** 2;
            if (d2 <= r2) near.push([d2, j]);
        }
        near.sort((p, q) => p[0] - q[0]);
        for (let k = 0; k < Math.min(P.maxNeighbours, near.length); k++) {
            const j = near[k][1]; if (j < i && near.length > 0) { /* kept once: from the lower index only when it also lists us is not checked; duplicates are harmless to the segmentation */ }
            const cos = S.n[3 * i] * S.n[3 * j] + S.n[3 * i + 1] * S.n[3 * j + 1] + S.n[3 * i + 2] * S.n[3 * j + 2];
            if (cos < -0.2) continue; // the two sides of a thin slab are not neighbours
            if (opening[i] !== opening[j]) continue; // an opening and the wall are never one region
            EA.push(i); EB.push(j); CO.push(cos < P.neighbourCos ? 1 : 0);
        }
    }
    const ea = Int32Array.from(EA), eb = Int32Array.from(EB), corner = Uint8Array.from(CO);
    EA.length = 0; EB.length = 0; CO.length = 0;
    const m = ea.length;
    // the light by orientation: a surface facing up sees more sky (bluer) than a wall; measured on corners where a roof meets a wall of near the same chroma (the median step across them), and removed from the surfaces facing up
    const cu: number[] = [], cv: number[] = [];
    for (let e = 0; e < m; e++) {
        if (!corner[e]) continue;
        const a = ea[e], b = eb[e], upA = S.n[3 * a + 1] > 0.7, upB = S.n[3 * b + 1] > 0.7;
        if (upA === upB || Math.abs(S.n[3 * (upA ? b : a) + 1]) > 0.3) continue;
        const [r, w] = upA ? [a, b] : [b, a];
        const d0 = Math.hypot(U[r] - U[w], V[r] - V[w]);
        // identical colour on both sides is one patch of texture drawn across the corner (a cap), not two surfaces under their own light
        if (d0 > P.orientMaxDc || (d0 < 1e-6 && Math.abs(Lg[r] - Lg[w]) < 1e-6)) continue;
        cu.push(U[r] - U[w]); cv.push(V[r] - V[w]);
    }
    const medA = (a: number[]) => { const q = [...a].sort((x, y) => x - y); return q.length ? q[Math.floor(q.length / 2)] : 0; };
    const ou = cu.length >= P.orientMinPairs ? medA(cu) : 0, ov = cv.length >= P.orientMinPairs ? medA(cv) : 0;
    if (ou || ov) for (let i = 0; i < n; i++) if (has[i] && S.n[3 * i + 1] > 0.7) { U[i] -= ou; V[i] -= ov; }
    // the building's own shadow shift: on pairs of one surface whose brightness differs strongly and whose chroma barely does
    let su = 0, sv = 0, sl = 0;
    for (let e = 0; e < m; e++) {
        if (corner[e]) continue;
        const a = ea[e], b = eb[e], dl = Lg[a] - Lg[b];
        if (Math.abs(dl) < P.shadowMinDl || Math.hypot(U[a] - U[b], V[a] - V[b]) > P.shadowMaxDc) continue;
        const s = Math.sign(dl); su += s * (U[a] - U[b]); sv += s * (V[a] - V[b]); sl += Math.abs(dl);
    }
    const ku = sl > 0 ? su / sl : 0, kv = sl > 0 ? sv / sl : 0;
    // edge costs
    const w = new Float32Array(m);
    for (let e = 0; e < m; e++) {
        const a = ea[e], b = eb[e], dl = Lg[a] - Lg[b];
        const du = U[a] - U[b] - ku * dl, dv = V[a] - V[b] - kv * dl, dc = Math.hypot(du, dv);
        const allow = corner[e] ? P.cornerAllow : dc <= P.shadowChroma ? P.shadowAllow : P.stepAllow;
        w[e] = dc / P.chromaUnit + Math.max(0, Math.abs(dl) - allow) / P.lumUnit;
    }
    // graph segmentation: edges cheapest first; two regions join when the edge is within both regions' internal variation plus k / size
    const order = Uint32Array.from({ length: m }, (_, e) => e).sort((x, y) => w[x] - w[y]);
    const parent = new Int32Array(n), size = new Int32Array(n).fill(1), inner = new Float32Array(n);
    for (let i = 0; i < n; i++) parent[i] = i;
    const root = (i: number): number => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
    for (const e of order) {
        const a = root(ea[e]), b = root(eb[e]);
        if (a === b) continue;
        if (w[e] <= Math.min(inner[a] + P.k / size[a], inner[b] + P.k / size[b])) {
            const [big, small] = size[a] >= size[b] ? [a, b] : [b, a];
            parent[small] = big; size[big] += size[small]; inner[big] = Math.max(inner[big], inner[small], w[e]);
        }
    }
    // small regions join their closest neighbour (the cheapest edge out)
    const sampleArea = (P.spacingM * P.spacingM) / 2, minSamples = Math.ceil(P.minRegionM2 / sampleArea);
    for (let pass = 0; pass < 3; pass++) for (const e of order) {
        const a = root(ea[e]), b = root(eb[e]);
        if (a === b || (size[a] >= minSamples && size[b] >= minSamples)) continue;
        const [big, small] = size[a] >= size[b] ? [a, b] : [b, a];
        parent[small] = big; size[big] += size[small];
    }
    // regions: median features (chroma compensated to the region's own luminance median, so regions compare as if lit alike)
    const regionOf = new Int32Array(n).fill(-1), rid = new Map<number, number>();
    const feats: Array<{ u: number[]; v: number[]; l: number[]; up: number; count: number; rgb: [number, number, number]; opening: number }> = [];
    for (let i = 0; i < n; i++) {
        if (!has[i]) continue;
        const r = root(i);
        let k = rid.get(r); if (k === undefined) { k = feats.length; rid.set(r, k); feats.push({ u: [], v: [], l: [], up: 0, count: 0, rgb: [0, 0, 0], opening: opening[i] }); }
        regionOf[i] = k; const f = feats[k];
        f.u.push(U[i]); f.v.push(V[i]); f.l.push(Lg[i]); f.count++; if (S.n[3 * i + 1] > 0.7) f.up++;
        f.rgb[0] += S.rgb[3 * i]; f.rgb[1] += S.rgb[3 * i + 1]; f.rgb[2] += S.rgb[3 * i + 2];
    }
    const med = (a: number[]) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
    const lRef = med(Array.from(Lg).filter((_, i) => has[i]));
    // each region's chroma twice: as captured, and with the shadow shift removed to a common luminance (a brightness difference is light either way: exposure or orientation leave the chroma, a shadow shifts it toward the sky)
    const R = feats.map(f => { const l = med(f.l), u = med(f.u), v = med(f.v); return { u, v, uc: u - ku * (l - lRef), vc: v - kv * (l - lRef), l, w: f.count, up: f.up, rgb: f.rgb, count: f.count, opening: f.opening }; });
    // materials: regions clustered, closest pairs first (chroma, luminance weighted lightly), area-weighted
    /** lLo, lHi: the range of its members' luminance (a group of one material lit many ways accepts anything inside the range it already holds; the step that counts is the gap between two ranges). */
    type M = { u: number; v: number; uc: number; vc: number; l: number; lLo: number; lHi: number; w: number; members: number[]; opening: number };
    const allRegions: M[] = R.map((r, k) => ({ u: r.u, v: r.v, uc: r.uc, vc: r.vc, l: r.l, lLo: r.l, lHi: r.l, w: r.w, members: [k], opening: r.opening }));
    // each role (the structure's openings, the rest) clustered on its own: an opening and the wall are never one material
    const clusterRole = (seed: M[]): M[] => {
    let mats: M[] = seed;
    const absorb = (a: M, b: M) => { const W = a.w + b.w; a.u = (a.u * a.w + b.u * b.w) / W; a.v = (a.v * a.w + b.v * b.w) / W; a.uc = (a.uc * a.w + b.uc * b.w) / W; a.vc = (a.vc * a.w + b.vc * b.w) / W; a.l = (a.l * a.w + b.l * b.w) / W; a.lLo = Math.min(a.lLo, b.lLo); a.lHi = Math.max(a.lHi, b.lHi); a.w = W; a.members.push(...b.members); };
    // a leader pass by size, then closest pairs, under one distance
    const cluster = (items: M[], dist: (a: M, b: M) => number): M[] => {
        const leaders: M[] = [];
        for (const r of [...items].sort((x, y) => y.w - x.w)) {
            let best: M | undefined, bd = Infinity;
            for (const L of leaders) { const d = dist(L, r); if (d < bd) { bd = d; best = L; } }
            if (!best || bd > 1) { leaders.push({ ...r, members: [...r.members] }); continue; }
            absorb(best, r);
        }
        for (;;) {
            let bi = -1, bj = -1, bd = 1;
            for (let i = 0; i < leaders.length; i++) for (let j = i + 1; j < leaders.length; j++) { const d = dist(leaders[i], leaders[j]); if (d < bd) { bd = d; bi = i; bj = j; } }
            if (bi < 0) break;
            absorb(leaders[bi], leaders[bj]); leaders.splice(bj, 1);
        }
        return leaders;
    };
    // first the shadows: regions whose shadow-compensated chroma matches, a cast shadow's brightness step free (matShadowFree)
    mats = cluster(mats, (a, b) => (Math.abs(a.l - b.l) > P.matShadowFree ? Infinity : Math.hypot(a.uc - b.uc, a.vc - b.vc) / P.matShadowChroma));
    // then exposure and orientation, without chaining: mean shift over the groups (chroma as captured, log luminance), a flat
    // window of matChroma in chroma and matLumWindow in luminance; groups settling on one mode are one material, so a
    // material spreads no further than its window whatever the order
    // each group is read as it looks lit (its best-lit member's luminance): its own shadows, joined above, do not drag it down
    const hc = P.matChroma, hl = P.matLumWindow, lit = (g: M) => g.lHi;
    const cellKey = (u: number, v: number, l: number) => `${Math.floor(u / hc)},${Math.floor(v / hc)},${Math.floor(l / hl)}`;
    const fgrid = new Map<string, number[]>();
    mats.forEach((g, i) => { const k = cellKey(g.u, g.v, lit(g)); (fgrid.get(k) ?? fgrid.set(k, []).get(k)!).push(i); });
    const modes = mats.map(g => {
        let u = g.u, v = g.v, l = lit(g);
        for (let it = 0; it < 30; it++) {
            let su = 0, sv = 0, sl = 0, sw = 0;
            const cu = Math.floor(u / hc), cv = Math.floor(v / hc), cl = Math.floor(l / hl);
            for (let du = -1; du <= 1; du++) for (let dv = -1; dv <= 1; dv++) for (let dl = -1; dl <= 1; dl++) for (const j of fgrid.get(`${cu + du},${cv + dv},${cl + dl}`) ?? []) {
                const o = mats[j], ol = lit(o); if (Math.hypot(o.u - u, o.v - v) > hc || Math.abs(ol - l) > hl) continue;
                su += o.u * o.w; sv += o.v * o.w; sl += ol * o.w; sw += o.w;
            }
            if (!sw) break;
            const nu = su / sw, nv = sv / sw, nl = sl / sw, moved = Math.hypot(nu - u, nv - v) / hc + Math.abs(nl - l) / hl;
            u = nu; v = nv; l = nl;
            if (moved < 1e-3) break;
        }
        return { u, v, l };
    });
    // modes within half a window are one
    const groupsB: M[] = [], modeOf: Array<{ u: number; v: number; l: number }> = [];
    mats.forEach((g, i) => {
        const md = modes[i];
        let k = modeOf.findIndex(o => Math.hypot(o.u - md.u, o.v - md.v) <= hc / 2 && Math.abs(o.l - md.l) <= hl / 2);
        if (k < 0) { k = modeOf.length; modeOf.push(md); groupsB.push({ ...g, members: [...g.members] }); } else absorb(groupsB[k], g);
    });
    mats = groupsB;
    const distB = (a: M, b: M) => Math.hypot(a.u - b.u, a.v - b.v) / hc + Math.abs(a.lHi - b.lHi) / hl;
    const total = mats.reduce((s, a) => s + a.w, 0);
    for (let i = mats.length - 1; i >= 0; i--) if (mats.length > 1 && mats[i].w < P.minMaterialShare * total) {
        const a = mats[i]; mats.splice(i, 1);
        let best = mats[0], bd = Infinity; for (const o of mats) { const d = distB(o, a); if (d < bd) { bd = d; best = o; } }
        absorb(best, a);
    }
    return mats;
    };
    const mats: M[] = [...clusterRole(allRegions.filter(r => !r.opening)), ...clusterRole(allRegions.filter(r => r.opening))];
    mats.sort((a, b) => b.w - a.w);
    const total = mats.reduce((sum, x) => sum + x.w, 0);
    const matOfRegion = new Int32Array(R.length);
    mats.forEach((mm, k) => { for (const r of mm.members) matOfRegion[r] = k + 1; });
    const material = new Int32Array(n);
    for (let i = 0; i < n; i++) if (regionOf[i] >= 0) material[i] = matOfRegion[regionOf[i]];
    const materials: BuildingMaterial[] = mats.map((mm, k) => {
        const rgb: [number, number, number] = [0, 0, 0]; let up = 0, cnt = 0;
        for (const r of mm.members) { rgb[0] += R[r].rgb[0]; rgb[1] += R[r].rgb[1]; rgb[2] += R[r].rgb[2]; up += R[r].up; cnt += R[r].count; }
        const lin: [number, number, number] = [rgb[0] / cnt, rgb[1] / cnt, rgb[2] / cnt];
        return { id: k + 1, role: mm.opening ? 'opening' : 'surface', areaM2: Math.round(cnt * sampleArea), share: Math.round((mm.w / total) * 1000) / 1000, srgb: lin.map(lin2srgb) as [number, number, number], linear: lin.map(v => Math.round(v * 1e4) / 1e4) as [number, number, number], chroma: [Math.round(mm.u * 1000) / 1000, Math.round(mm.v * 1000) / 1000], logL: Math.round(mm.l * 100) / 100, upShare: Math.round((up / cnt) * 100) / 100, regions: mm.members.length, samples: cnt };
    });
    return { version: BUILDING_MATERIAL_MAP_VERSION, params: P, ...S, region: regionOf, material, opening, materials, shadowSlope: [Math.round(ku * 1000) / 1000, Math.round(kv * 1000) / 1000], orientationShift: [Math.round(ou * 1000) / 1000, Math.round(ov * 1000) / 1000], stats: { samples: n, photoSamples: [...has].filter(Boolean).length, edges: m, regions: R.length, ms: Date.now() - t0 } };
}
