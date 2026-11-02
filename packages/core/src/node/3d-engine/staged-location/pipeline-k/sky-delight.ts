/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Pipeline K's sky-visibility de-light: the share of a wall's brightness its photo owes to how much sky it sees, taken out.
 *
 * Google's leaf-tile photos carry no capture-time sun (measured on the Empire State Building, 2026-10-28: with sky
 * visibility controlled, no sun direction makes the points it would shadow darker than the points it would light by more
 * than 1.2 to 1, where a clear-day sun gives 5 to 8 to 1; the tiles are blended from many captures). What is left baked
 * in is the fill: a wall deep in a street canyon sees little sky and reads darker than the same stone in the open.
 *
 *  1. Sky visibility V (cosine-weighted, rays over the hemisphere against the whole scan, open below the horizon only to
 *     the ground) at area-weighted sample points on the walls; each surface's more open side counts (the remesh's
 *     winding is not consistent). Points that see no sky (enclosed shells inside the scan) are left out of the fit.
 *  2. The darkening is fitted from the photos themselves: each photo's log luminance less its own mean, against V, by
 *     least squares: log L = b V + c. It is applied only when it is real: b positive on both halves of the photos (split
 *     by index), and the half fitted on one removing at least minHeldOut of the other's variance.
 *  3. V at each wall vertex (inverse-distance mean of the samples within splatM), interpolated over each triangle in its
 *     photo's UV, and each wall texel divided by exp(b (V - Vref)), Vref the samples' mean V, so the building's mean tone
 *     stays. Roof texels (seen from above) and texels no wall triangle covers keep their colour.
 *
 * Only a smooth gain is applied: no texel is moved or drawn. The result stays photo-inferred, the photo still the colour.
 *
 * Off by default (SCRATCHBOX_K_SKY_DELIGHT=1 on). Measured on the Empire State Building's K twin (2026-10-28, 203 photos):
 * slope 0.30 (halves 0.24 and 0.36), 2.1% of held-out wall variance, gains 0.95 to 1.27; the seams between photos got
 * further apart (mean patch difference 0.160 -> 0.181 before harmonising, 0.132 -> 0.138 after). The isolated scan has no
 * neighbours, so it cannot see the street canyon that darkens the ESB's lowest 60 m (2.3 times darker than at 60-120 m).
 */

import { readAccessor, type ParsedGlb } from '../glb-bytes';
import { SRGB8_TO_LINEAR, linearToSrgb255 } from '../../../../common/spatial/photogrammetric-delight';
import type { RgbaImage8 } from '../tile-texture-transfer';
import { forEachTexturedTriangle, TEXEL_ROOF } from './texture-harmonize';

export const SKY_DELIGHT_VERSION = 'sky-delight/1';

export const SKY_DELIGHT_PARAMS = {
    /** Wall sample points (area-weighted), and hemisphere rays at each. */
    samples: 8000, rays: 48,
    /** A ray that travels this far unblocked sees sky (m); the ray grid's cell (m). */
    maxRayM: 300, cellM: 2,
    /** A wall: |normal y| under this. */
    wallNy: 0.5,
    /** Samples that see less sky than this are enclosed shells, left out of the fit. */
    minV: 0.05,
    /** The darkening's slope is bounded (natural log per unit V); the held-out variance it must remove to be applied. */
    maxB: 1.5, minHeldOut: 0.01,
    /** Samples within this of a vertex give its V (m). */
    splatM: 3
};
export type SkyDelightParams = typeof SKY_DELIGHT_PARAMS;

export interface SkyDelightReport {
    applied: boolean;
    why: string;
    /** Whether the neighbours were among the occluders. */
    withContext: boolean;
    /** The fitted slope (natural log of luminance per unit sky visibility), and each half's. */
    b: number; bHalves: [number, number];
    /** Share of a half's wall-luminance variance the other half's fit removes (mean of both ways). */
    heldOutVarianceRemoved: number;
    samples: number; fitted: number; vRef: number;
    /** Wall texels given a gain, and the gain's range. */
    texels: number; gainMin: number; gainMax: number;
}

/** The occluders as a flat position array: every triangle of the GLB, and the context's (the neighbours, in the same frame). */
function allTriangles(g: ParsedGlb, json: any, context?: { vertices: ArrayLike<number>; indices: ArrayLike<number> }): Float64Array {
    const out: number[] = [];
    if (context) for (let t = 0; t + 2 < context.indices.length; t += 3) for (let k = 0; k < 3; k++) { const i = context.indices[t + k]; out.push(context.vertices[i * 3], context.vertices[i * 3 + 1], context.vertices[i * 3 + 2]); }
    for (const mesh of json.meshes ?? []) for (const prim of mesh.primitives ?? []) {
        if ((prim.mode ?? 4) !== 4 || prim.attributes?.POSITION === undefined) continue;
        const pos = readAccessor(g, prim.attributes.POSITION).data;
        const idx = prim.indices !== undefined ? readAccessor(g, prim.indices).data : undefined;
        const n = idx ? idx.length : pos.length / 3;
        for (let t = 0; t + 2 < n; t += 3) for (let k = 0; k < 3; k++) { const i = idx ? idx[t + k] : t + k; out.push(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]); }
    }
    return Float64Array.from(out);
}

/** A uniform grid over triangles, marched for any hit along a ray. */
function rayGrid(T: Float64Array, cellM: number) {
    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < T.length; i += 3) for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], T[i + k]); hi[k] = Math.max(hi[k], T[i + k]); }
    const N = [0, 1, 2].map(k => Math.max(1, Math.ceil((hi[k] - lo[k]) / cellM) + 1));
    const key = (x: number, y: number, z: number) => (x * N[1] + y) * N[2] + z;
    const cells = new Map<number, number[]>();
    for (let t = 0; t < T.length / 9; t++) {
        const b0 = [0, 1, 2].map(k => Math.floor((Math.min(T[t * 9 + k], T[t * 9 + 3 + k], T[t * 9 + 6 + k]) - lo[k]) / cellM));
        const b1 = [0, 1, 2].map(k => Math.floor((Math.max(T[t * 9 + k], T[t * 9 + 3 + k], T[t * 9 + 6 + k]) - lo[k]) / cellM));
        for (let x = b0[0]; x <= b1[0]; x++) for (let y = b0[1]; y <= b1[1]; y++) for (let z = b0[2]; z <= b1[2]; z++) {
            const c = key(x, y, z), l = cells.get(c);
            if (l) l.push(t); else cells.set(c, [t]);
        }
    }
    const stamp = new Uint32Array(T.length / 9);
    let ray = 0;
    /** Whether the ray from o along unit d hits a triangle within maxT (half-cell steps, Moller-Trumbore). */
    return (ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, maxT: number): boolean => {
        ray++;
        for (let s = 0; s < maxT; s += cellM * 0.5) {
            const cx = Math.floor((ox + dx * s - lo[0]) / cellM), cy = Math.floor((oy + dy * s - lo[1]) / cellM), cz = Math.floor((oz + dz * s - lo[2]) / cellM);
            if (cx < 0 || cy < 0 || cz < 0 || cx >= N[0] || cy >= N[1] || cz >= N[2]) return false;
            const l = cells.get(key(cx, cy, cz));
            if (!l) continue;
            for (const t of l) {
                if (stamp[t] === ray) continue;
                stamp[t] = ray;
                const a = t * 9;
                const e1x = T[a + 3] - T[a], e1y = T[a + 4] - T[a + 1], e1z = T[a + 5] - T[a + 2], e2x = T[a + 6] - T[a], e2y = T[a + 7] - T[a + 1], e2z = T[a + 8] - T[a + 2];
                const px = dy * e2z - dz * e2y, py = dz * e2x - dx * e2z, pz = dx * e2y - dy * e2x;
                const det = e1x * px + e1y * py + e1z * pz;
                if (Math.abs(det) < 1e-12) continue;
                const inv = 1 / det, tx = ox - T[a], ty = oy - T[a + 1], tz = oz - T[a + 2];
                const u = (tx * px + ty * py + tz * pz) * inv;
                if (u < 0 || u > 1) continue;
                const qx = ty * e1z - tz * e1y, qy = tz * e1x - tx * e1z, qz = tx * e1y - ty * e1x;
                const v = (dx * qx + dy * qy + dz * qz) * inv;
                if (v < 0 || u + v > 1) continue;
                if ((e2x * qx + e2y * qy + e2z * qz) * inv > 0.05) return true;
            }
        }
        return false;
    };
}

/** Cosine-weighted sky visibility at a point on the side of unit normal n (rays below the horizon not counted). */
function skyVisibility(hit: ReturnType<typeof rayGrid>, c: number[], n: number[], P: SkyDelightParams): number {
    const a = Math.abs(n[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
    let ux = n[1] * a[2] - n[2] * a[1], uy = n[2] * a[0] - n[0] * a[2], uz = n[0] * a[1] - n[1] * a[0];
    const ul = Math.hypot(ux, uy, uz); ux /= ul; uy /= ul; uz /= ul;
    const wx = n[1] * uz - n[2] * uy, wy = n[2] * ux - n[0] * uz, wz = n[0] * uy - n[1] * ux;
    const ox = c[0] + n[0] * 0.05, oy = c[1] + n[1] * 0.05, oz = c[2] + n[2] * 0.05;
    let open = 0, counted = 0;
    for (let k = 0; k < P.rays; k++) {
        const r = (k + 0.5) / P.rays, ph = k * 2.39996323, sr = Math.sqrt(r), z = Math.sqrt(1 - r);
        const dx = ux * sr * Math.cos(ph) + wx * sr * Math.sin(ph) + n[0] * z, dy = uy * sr * Math.cos(ph) + wy * sr * Math.sin(ph) + n[1] * z, dz = uz * sr * Math.cos(ph) + wz * sr * Math.sin(ph) + n[2] * z;
        if (dy < -0.02) continue;
        counted++;
        if (!hit(ox, oy, oz, dx, dy, dz, P.maxRayM)) open++;
    }
    return counted ? open / counted : 0;
}

interface WallSample { img: number; c: number[]; V: number; logL: number; }

/** Slope of r against V (least squares), and the means it passes through. */
function fitSlope(fit: Array<{ r: number; V: number }>): { b: number; mv: number; mr: number } {
    let mv = 0, mr = 0;
    for (const s of fit) { mv += s.V; mr += s.r; }
    mv /= fit.length; mr /= fit.length;
    let num = 0, den = 0;
    for (const s of fit) { num += (s.V - mv) * (s.r - mr); den += (s.V - mv) ** 2; }
    return { b: den > 0 ? num / den : 0, mv, mr };
}

/**
 * Takes the sky-visibility darkening out of the wall texels of `images` (image index -> the de-lit photo, changed in
 * place), measured on the GLB's own triangles and the `context`'s (the tile extraction with its neighbours: the street canyon
 * they make is most of the sky a low wall loses). `masks` (surfaceClassMasks) tells roof texels apart; they keep their colour.
 */
export function skyDelight(g: ParsedGlb, json: any, images: Map<number, RgbaImage8>, masks?: Map<number, Uint8Array>, context?: { vertices: ArrayLike<number>; indices: ArrayLike<number> }, P: SkyDelightParams = SKY_DELIGHT_PARAMS): SkyDelightReport {
    const none = (why: string, extra: Partial<SkyDelightReport> = {}): SkyDelightReport => ({ applied: false, why, withContext: !!context, b: 0, bHalves: [0, 0], heldOutVarianceRemoved: 0, samples: 0, fitted: 0, vRef: 0, texels: 0, gainMin: 1, gainMax: 1, ...extra });
    // the wall triangles with a photo, and their total area
    const walls: Array<{ img: number; p: Float64Array; uv: Float64Array; n: number[]; area: number }> = [];
    let wallArea = 0;
    forEachTexturedTriangle(g, json, (img, p, uv) => {
        if (!images.has(img)) return;
        const e1 = [p[3] - p[0], p[4] - p[1], p[5] - p[2]], e2 = [p[6] - p[0], p[7] - p[1], p[8] - p[2]];
        const cr = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]], l = Math.hypot(cr[0], cr[1], cr[2]);
        if (!(l > 0) || Math.abs(cr[1] / l) >= P.wallNy) return;
        walls.push({ img, p: p.slice(), uv: uv.slice(), n: cr.map(v => v / l), area: l / 2 });
        wallArea += l / 2;
    });
    if (!walls.length) return none('no textured walls');
    const hit = rayGrid(allTriangles(g, json, context), P.cellM);
    // area-weighted samples at wall centroids (deterministic)
    let seed = 7;
    const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    const samples: WallSample[] = [];
    for (const w of walls) {
        if (rnd() >= Math.min(1, P.samples * w.area / wallArea)) continue;
        const img = images.get(w.img)!;
        const u = (w.uv[0] + w.uv[2] + w.uv[4]) / 3, v = (w.uv[1] + w.uv[3] + w.uv[5]) / 3;
        const x = Math.min(img.width - 1, Math.max(0, Math.floor((((u % 1) + 1) % 1) * img.width))), y = Math.min(img.height - 1, Math.max(0, Math.floor((((v % 1) + 1) % 1) * img.height)));
        const o = (y * img.width + x) * 4;
        const L = 0.2126 * SRGB8_TO_LINEAR[img.rgba[o]] + 0.7152 * SRGB8_TO_LINEAR[img.rgba[o + 1]] + 0.0722 * SRGB8_TO_LINEAR[img.rgba[o + 2]];
        if (!(L > 0.002)) continue;
        const c = [(w.p[0] + w.p[3] + w.p[6]) / 3, (w.p[1] + w.p[4] + w.p[7]) / 3, (w.p[2] + w.p[5] + w.p[8]) / 3];
        const V = Math.max(skyVisibility(hit, c, w.n, P), skyVisibility(hit, c, w.n.map(k => -k), P));
        samples.push({ img: w.img, c, V, logL: Math.log(L) });
    }
    const open = samples.filter(s => s.V >= P.minV);
    // each photo's own mean taken out (its exposure), over the samples that are fitted
    const byImg = new Map<number, { sum: number; n: number }>();
    for (const s of open) { const m = byImg.get(s.img) ?? { sum: 0, n: 0 }; m.sum += s.logL; m.n++; byImg.set(s.img, m); }
    const rows = open.filter(s => byImg.get(s.img)!.n >= 2).map(s => ({ img: s.img, V: s.V, r: s.logL - byImg.get(s.img)!.sum / byImg.get(s.img)!.n }));
    const base = { samples: samples.length, fitted: rows.length };
    if (rows.length < 100) return none(`too few open wall samples to fit (${rows.length})`, base);
    const halves = [rows.filter(r => r.img % 2 === 0), rows.filter(r => r.img % 2 === 1)];
    if (halves.some(h => h.length < 50)) return none('too few samples in one half of the photos to check the fit', base);
    const fits = halves.map(fitSlope);
    const heldOut = [0, 1].map(k => {
        const f = fits[k], test = halves[1 - k];
        let v0 = 0, v1 = 0, mr = 0;
        for (const s of test) mr += s.r;
        mr /= test.length;
        for (const s of test) { v0 += (s.r - mr) ** 2; v1 += (s.r - mr - f.b * (s.V - f.mv)) ** 2; }
        return v0 > 0 ? 1 - v1 / v0 : 0;
    });
    const heldOutVarianceRemoved = (heldOut[0] + heldOut[1]) / 2;
    const all = fitSlope(rows);
    const b = Math.min(P.maxB, all.b), vRef = all.mv;
    const stats = { ...base, b, bHalves: [fits[0].b, fits[1].b] as [number, number], heldOutVarianceRemoved, vRef };
    if (!(fits[0].b > 0 && fits[1].b > 0)) return none(`the darkening is not seen in both halves of the photos (slopes ${fits[0].b.toFixed(3)}, ${fits[1].b.toFixed(3)})`, stats);
    if (heldOutVarianceRemoved < P.minHeldOut) return none(`the darkening explains too little of the held-out photos (${(100 * heldOutVarianceRemoved).toFixed(1)}%)`, stats);

    // V at each wall vertex from the samples around it
    const hash = new Map<string, WallSample[]>();
    const cellOf = (x: number, y: number, z: number) => `${Math.floor(x / P.splatM)},${Math.floor(y / P.splatM)},${Math.floor(z / P.splatM)}`;
    for (const s of samples) { const k = cellOf(s.c[0], s.c[1], s.c[2]); const l = hash.get(k); if (l) l.push(s); else hash.set(k, [s]); }
    const vAt = (x: number, y: number, z: number): number => {
        let sw = 0, sv = 0;
        const cx = Math.floor(x / P.splatM), cy = Math.floor(y / P.splatM), cz = Math.floor(z / P.splatM);
        for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) for (let k = -1; k <= 1; k++) for (const s of hash.get(`${cx + i},${cy + j},${cz + k}`) ?? []) {
            const d = Math.hypot(s.c[0] - x, s.c[1] - y, s.c[2] - z);
            if (d > P.splatM) continue;
            const w = 1 / (d + 0.25);
            sw += w; sv += w * s.V;
        }
        return sw > 0 ? sv / sw : vRef;
    };
    // each wall triangle rasterised in its photo's UV: the gain at every texel it covers
    const gains = new Map<number, Float32Array>();
    for (const w of walls) {
        const img = images.get(w.img)!, W = img.width, H = img.height;
        let gm = gains.get(w.img);
        if (!gm) { gm = new Float32Array(W * H); gains.set(w.img, gm); }
        const gv = [0, 1, 2].map(k => Math.exp(-b * (Math.max(P.minV, vAt(w.p[k * 3], w.p[k * 3 + 1], w.p[k * 3 + 2])) - vRef)));
        const ax = w.uv[0] * W, ay = w.uv[1] * H, bx = w.uv[2] * W, by = w.uv[3] * H, cx = w.uv[4] * W, cy = w.uv[5] * H;
        const den = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy);
        if (Math.abs(den) < 1e-12) continue;
        const x0 = Math.max(0, Math.floor(Math.min(ax, bx, cx))), x1 = Math.min(W - 1, Math.ceil(Math.max(ax, bx, cx)));
        const y0 = Math.max(0, Math.floor(Math.min(ay, by, cy))), y1 = Math.min(H - 1, Math.ceil(Math.max(ay, by, cy)));
        for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
            const px = x + 0.5, py = y + 0.5;
            const a = ((by - cy) * (px - cx) + (cx - bx) * (py - cy)) / den, bb = ((cy - ay) * (px - cx) + (ax - cx) * (py - cy)) / den;
            if (a < 0 || bb < 0 || a + bb > 1) continue;
            gm[y * W + x] = a * gv[0] + bb * gv[1] + (1 - a - bb) * gv[2];
        }
    }
    let texels = 0, gainMin = Infinity, gainMax = -Infinity;
    for (const [ii, gm] of gains) {
        const img = images.get(ii)!, mask = masks?.get(ii);
        for (let k = 0; k < gm.length; k++) {
            const gk = gm[k];
            if (!(gk > 0) || mask?.[k] === TEXEL_ROOF) continue;
            const o = k * 4;
            for (let c = 0; c < 3; c++) img.rgba[o + c] = Math.round(Math.min(255, linearToSrgb255(SRGB8_TO_LINEAR[img.rgba[o + c]] / gk)));
            texels++; gainMin = Math.min(gainMin, gk); gainMax = Math.max(gainMax, gk);
        }
    }
    return { applied: true, withContext: !!context, why: `walls lifted where they see less sky and toned down where they see more (slope ${b.toFixed(3)}, ${(100 * heldOutVarianceRemoved).toFixed(1)}% of held-out variance)`, ...stats, texels, gainMin: texels ? gainMin : 1, gainMax: texels ? gainMax : 1 };
}
