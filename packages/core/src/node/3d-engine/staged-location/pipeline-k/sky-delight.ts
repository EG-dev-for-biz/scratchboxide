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
 *     the ground; cast natively on a BVH, sky-visibility-service.ts) at area-weighted sample points on the walls; each
 *     surface's more open side counts (the remesh's winding is not consistent). Points that see no sky (enclosed shells
 *     inside the scan) are left out of the fit.
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
 * Those figures predate sky-delight/2, which fixed the gain's sign (sky-delight/1 multiplied the darkening in instead of
 * dividing it out) and casts on the native BVH: they need measuring again.
 */

import { readAccessor, type ParsedGlb } from '../glb-bytes';
import { SRGB8_TO_LINEAR, linearToSrgb255 } from '../../../../common/spatial/photogrammetric-delight';
import type { RgbaImage8 } from '../tile-texture-transfer';
import { runSkyVisibility } from '../../sky-visibility-service';
import { forEachTexturedTriangle, TEXEL_ROOF } from './texture-harmonize';

export const SKY_DELIGHT_VERSION = 'sky-delight/2';

export const SKY_DELIGHT_PARAMS = {
    /** Wall sample points (area-weighted), and hemisphere rays at each. */
    samples: 8000, rays: 48,
    /** A ray that travels this far unblocked sees sky (m). */
    maxRayM: 300,
    /** Rays start this far off the wall, and ignore hits nearer than this along them (m). */
    rayOffsetM: 0.05,
    /** Rays pointing lower than this (direction y) are not counted. */
    minRayDy: -0.02,
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

type Context = { vertices: ArrayLike<number>; indices: ArrayLike<number> };

/** The occluders as one indexed mesh: every triangle of the GLB, and the context's (the neighbours, in the same frame). */
export function occluderMesh(g: ParsedGlb, json: any, context?: Context): { positions: Float32Array; indices: Uint32Array } {
    const parts: Array<{ pos: ArrayLike<number>; idx?: ArrayLike<number> }> = [];
    if (context) parts.push({ pos: context.vertices, idx: context.indices });
    for (const mesh of json.meshes ?? []) for (const prim of mesh.primitives ?? []) {
        if ((prim.mode ?? 4) !== 4 || prim.attributes?.POSITION === undefined) continue;
        parts.push({ pos: readAccessor(g, prim.attributes.POSITION).data, idx: prim.indices !== undefined ? readAccessor(g, prim.indices).data : undefined });
    }
    let nv = 0, ni = 0;
    for (const p of parts) { nv += Math.floor(p.pos.length / 3); ni += Math.floor((p.idx ? p.idx.length : p.pos.length / 3) / 3) * 3; }
    const positions = new Float32Array(nv * 3), indices = new Uint32Array(ni);
    let v0 = 0, at = 0;
    for (const p of parts) {
        const count = Math.floor(p.pos.length / 3);
        for (let k = 0; k < count * 3; k++) positions[v0 * 3 + k] = p.pos[k];
        const n = Math.floor((p.idx ? p.idx.length : count) / 3) * 3;
        for (let k = 0; k < n; k++) indices[at++] = v0 + (p.idx ? p.idx[k] : k);
        v0 += count;
    }
    return { positions, indices };
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
export async function skyDelight(g: ParsedGlb, json: any, images: Map<number, RgbaImage8>, masks?: Map<number, Uint8Array>, context?: Context, P: SkyDelightParams = SKY_DELIGHT_PARAMS): Promise<SkyDelightReport> {
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
    // area-weighted samples at wall centroids (deterministic), their sky visibility cast together below
    let seed = 7;
    const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    const samples: WallSample[] = [];
    const sides: number[] = [];
    for (const w of walls) {
        if (rnd() >= Math.min(1, P.samples * w.area / wallArea)) continue;
        const img = images.get(w.img)!;
        const u = (w.uv[0] + w.uv[2] + w.uv[4]) / 3, v = (w.uv[1] + w.uv[3] + w.uv[5]) / 3;
        const x = Math.min(img.width - 1, Math.max(0, Math.floor((((u % 1) + 1) % 1) * img.width))), y = Math.min(img.height - 1, Math.max(0, Math.floor((((v % 1) + 1) % 1) * img.height)));
        const o = (y * img.width + x) * 4;
        const L = 0.2126 * SRGB8_TO_LINEAR[img.rgba[o]] + 0.7152 * SRGB8_TO_LINEAR[img.rgba[o + 1]] + 0.0722 * SRGB8_TO_LINEAR[img.rgba[o + 2]];
        if (!(L > 0.002)) continue;
        const c = [(w.p[0] + w.p[3] + w.p[6]) / 3, (w.p[1] + w.p[4] + w.p[7]) / 3, (w.p[2] + w.p[5] + w.p[8]) / 3];
        sides.push(c[0], c[1], c[2], w.n[0], w.n[1], w.n[2], c[0], c[1], c[2], -w.n[0], -w.n[1], -w.n[2]);
        samples.push({ img: w.img, c, V: 0, logL: Math.log(L) });
    }
    if (samples.length) {
        const { positions, indices } = occluderMesh(g, json, context);
        const { visibility } = await runSkyVisibility({ positions, indices, samples: Float32Array.from(sides), rays: P.rays, maxRayM: P.maxRayM, originOffsetM: P.rayOffsetM, minHitM: P.rayOffsetM, minDirY: P.minRayDy });
        samples.forEach((s, i) => { s.V = Math.max(visibility[2 * i], visibility[2 * i + 1]); });
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
        const gv = [0, 1, 2].map(k => Math.exp(b * (Math.max(P.minV, vAt(w.p[k * 3], w.p[k * 3 + 1], w.p[k * 3 + 2])) - vRef)));
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
