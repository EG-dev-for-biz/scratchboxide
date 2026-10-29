/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Pipeline K's texture harmonisation: the photos of one textured building (Google's leaf-tile photos and K's straightened
 * facade orthos, all de-lit by the same curve) brought to one colour, so no patch stands out because its photo was
 * exposed or processed differently from its neighbour's.
 *
 *  1. Samples: every textured triangle sampled about every sampleM, each sample with its 3D position, normal, photo and
 *     colour (linear RGB, in logs).
 *  2. Colour match: the samples grouped by the side they face (sideBins compass bins of the horizontal normal; up and
 *     down apart) and by height band (bandM above the ground). Each group's reference is the area-weighted median of its
 *     photos' mean colours; each photo gets one gain per channel toward the references of the groups it covers (least
 *     squares, bounded by maxGainLog). A photo alone in its groups keeps its colour.
 *  3. Seam levelling (Lempitsky and Ivanov 2007, "Seamless mosaicing of image-based texture maps"): each photo gets a
 *     smooth low-resolution offset field over its UV square. Where two photos cover the same patch of surface (a seamM
 *     cell of space, facing the same way), their mean colours there must agree after their fields: a patch is a
 *     low-frequency difference, so patch means are compared, never single texels (whose window-or-pier detail no gain can
 *     match). A smoothness term joins neighbouring field nodes, and a weak pull holds them near zero. Solved per channel by
 *     conjugate gradients. Matching in space, not by shared vertices, reaches the seams between a rebuilt facade and the
 *     scan around it, which share no vertex.
 *
 * Verified: the result is kept only when the seams' mean patch difference (the same patches, measured again after) falls;
 * the report gives both. Only gains and smooth offsets are applied: no texel is moved or drawn.
 *
 * Roofs, seen from above (surfaceClassMasks): a point of an up-facing triangle is roof when nothing of the building stands
 * over it (a top-down height map, heightCellM cells, checked per texel and per sample); one under other surfaces is hidden (the remesh keeps
 * such shells: on the ESB most up-facing area is hidden) and is left out of the colour statistics. A photo gets one gain
 * for its roof texels and one for the rest, each from its own groups: one photo-wide gain, set mostly by the walls it
 * covers, laid a rectangle of different tone over a flat roof. The masks also tell the twin's de-light which texels are
 * roof (tile-refine-twin.ts: no shadow lift there, since a roof photographed from the air is lit, and a dark roof is a
 * dark material).
 */

import { readAccessor, type ParsedGlb } from '../glb-bytes';
import { SRGB8_TO_LINEAR, linearToSrgb255 } from '../../../../common/spatial/photogrammetric-delight';
import type { RgbaImage8 } from '../tile-texture-transfer';
import { Rows, solveLeastSquares } from './ortho-rectify';

export const TEXTURE_HARMONIZE_VERSION = 'texture-harmonize/4';

export const TEXTURE_HARMONIZE_PARAMS = {
    /** Sample spacing over the triangles (m), and at most this many samples a triangle. */
    sampleM: 0.6, maxSamplesPerTriangle: 64,
    /** Groups: compass bins of a wall's facing, height bands (m); a normal steeper than this |y| is up or down. */
    sideBins: 8, bandM: 15, flatNy: 0.7,
    /** A photo's gain is bounded (natural log, per channel), and scaled by this before the seams are levelled. */
    maxGainLog: Math.log(1.8), gainScale: 0.5,
    /** Seams: the patch of surface two photos are compared over (a cell of space, m), within one of seamFacingBins facings. */
    seamM: 1.5, seamFacingBins: 12,
    /** The offset field: a node about every fieldPx texels, at most maxField a side; smoothness and pull-to-zero weights. */
    fieldPx: 64, maxField: 24, wSmooth: 0.15, wAnchor: 0.01,
    /** Offsets are bounded (natural log). */
    maxOffsetLog: Math.log(1.6),
    /** Roofs: the top-down height map's cell (m), and how far below its top an up-facing surface may sit and still be roof (m). */
    heightCellM: 0.5, roofToleranceM: 0.75
};
export type TextureHarmonizeParams = typeof TEXTURE_HARMONIZE_PARAMS;

export interface TextureHarmonizeReport {
    images: number; samples: number; groups: number;
    /** Up-facing area seen from above (roof) and under other surfaces (hidden, left out), m². */
    roofs: { roofM2: number; hiddenM2: number; roofGains: number };
    gains: { meanAbsLog: number; maxAbsLog: number };
    seams: { pairs: number; before: number; afterMatch: number; after: number };
    kept: boolean; why: string; ms: number;
    /** Where the time went, by phase (ms). */
    phasesMs?: Record<string, number>;
}

interface Sample { x: number; y: number; z: number; nx: number; ny: number; nz: number; img: number; u: number; v: number; w: number; c: [number, number, number]; roof: boolean }

const LOG_EPS = 1e-3;

/** A texel's surface in surfaceClassMasks: none of the mesh's triangles uses it, a wall (or any surface not roof), a roof. */
export const TEXEL_NONE = 0, TEXEL_WALL = 1, TEXEL_ROOF = 2;

/** Each textured triangle of a GLB: its world corners, UVs and photo. */
function forEachTexturedTriangle(g: ParsedGlb, json: any, fn: (img: number, p: Float64Array, uv: Float64Array) => void): void {
    const p = new Float64Array(9), q = new Float64Array(6);
    for (const mesh of json.meshes ?? []) for (const prim of mesh.primitives ?? []) {
        if ((prim.mode ?? 4) !== 4 || prim.attributes?.POSITION === undefined || prim.material === undefined) continue;
        const tex = json.materials?.[prim.material]?.pbrMetallicRoughness?.baseColorTexture;
        const source = tex ? json.textures?.[tex.index]?.source : undefined;
        const uvAcc = tex ? prim.attributes[`TEXCOORD_${tex.texCoord ?? 0}`] : undefined;
        if (source === undefined || uvAcc === undefined) continue;
        const pos = readAccessor(g, prim.attributes.POSITION).data, uv = readAccessor(g, uvAcc).data;
        const idx = prim.indices !== undefined ? readAccessor(g, prim.indices).data : undefined;
        const n = idx ? idx.length : pos.length / 3;
        for (let t = 0; t + 2 < n; t += 3) {
            for (let k = 0; k < 3; k++) {
                const i = idx ? idx[t + k] : t + k;
                p[k * 3] = pos[i * 3]; p[k * 3 + 1] = pos[i * 3 + 1]; p[k * 3 + 2] = pos[i * 3 + 2]; q[k * 2] = uv[i * 2]; q[k * 2 + 1] = uv[i * 2 + 1];
            }
            fn(source, p, q);
        }
    }
}

/** The top-down height map of every triangle of the GLB (the highest surface over each heightCellM cell). */
function topHeightMap(g: ParsedGlb, json: any, P: TextureHarmonizeParams): (x: number, z: number) => number {
    let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
    // sized up front (a district's corners outgrow a plain array)
    const prims: Array<{ pos: ArrayLike<number>; idx?: ArrayLike<number>; n: number }> = [];
    for (const mesh of json.meshes ?? []) for (const prim of mesh.primitives ?? []) {
        if ((prim.mode ?? 4) !== 4 || prim.attributes?.POSITION === undefined) continue;
        const pos = readAccessor(g, prim.attributes.POSITION).data;
        const idx = prim.indices !== undefined ? readAccessor(g, prim.indices).data : undefined;
        prims.push({ pos, ...(idx ? { idx } : {}), n: Math.floor((idx ? idx.length : pos.length / 3) / 3) * 3 });
    }
    const tris = new Float32Array(prims.reduce((a, q) => a + q.n * 3, 0));
    let o = 0;
    for (const { pos, idx, n } of prims) for (let t = 0; t < n; t++) {
        const i = idx ? idx[t] : t;
        tris[o++] = pos[i * 3]; tris[o++] = pos[i * 3 + 1]; tris[o++] = pos[i * 3 + 2];
        x0 = Math.min(x0, pos[i * 3]); x1 = Math.max(x1, pos[i * 3]); z0 = Math.min(z0, pos[i * 3 + 2]); z1 = Math.max(z1, pos[i * 3 + 2]);
    }
    if (!tris.length) return () => -Infinity;
    const c = P.heightCellM, W = Math.max(1, Math.ceil((x1 - x0) / c) + 1), H = Math.max(1, Math.ceil((z1 - z0) / c) + 1);
    const top = new Float32Array(W * H).fill(-Infinity);
    for (let t = 0; t + 8 < tris.length; t += 9) {
        // a triangle's height at each cell centre it covers seen from above (a wall covers none: its top is the roof's edge, not over the roof)
        const ax = (tris[t] - x0) / c, az = (tris[t + 2] - z0) / c, bx = (tris[t + 3] - x0) / c, bz = (tris[t + 5] - z0) / c, cx = (tris[t + 6] - x0) / c, cz = (tris[t + 8] - z0) / c;
        const den = (bz - cz) * (ax - cx) + (cx - bx) * (az - cz);
        if (Math.abs(den) < 1e-9) continue;
        const ix0 = Math.max(0, Math.floor(Math.min(ax, bx, cx))), ix1 = Math.min(W - 1, Math.ceil(Math.max(ax, bx, cx)));
        const iz0 = Math.max(0, Math.floor(Math.min(az, bz, cz))), iz1 = Math.min(H - 1, Math.ceil(Math.max(az, bz, cz)));
        for (let iz = iz0; iz <= iz1; iz++) for (let ix = ix0; ix <= ix1; ix++) {
            const px = ix + 0.5, pz = iz + 0.5;
            const a = ((bz - cz) * (px - cx) + (cx - bx) * (pz - cz)) / den, b = ((cz - az) * (px - cx) + (ax - cx) * (pz - cz)) / den;
            if (a < 0 || b < 0 || a + b > 1) continue;
            const y = a * tris[t + 1] + b * tris[t + 4] + (1 - a - b) * tris[t + 7];
            if (y > top[iz * W + ix]) top[iz * W + ix] = y;
        }
    }
    return (x: number, z: number) => {
        const ix = Math.floor((x - x0) / c), iz = Math.floor((z - z0) / c);
        return ix < 0 || iz < 0 || ix >= W || iz >= H ? -Infinity : top[iz * W + ix];
    };
}

/** A triangle's unit normal and area, and whether it faces up (y of the normal past flatNy). */
function triangleFacing(p: Float64Array, P: TextureHarmonizeParams): { up: boolean; area: number; n: [number, number, number] } | undefined {
    const ux = p[3] - p[0], uy = p[4] - p[1], uz = p[5] - p[2], vx = p[6] - p[0], vy = p[7] - p[1], vz = p[8] - p[2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const area2 = Math.hypot(nx, ny, nz);
    if (!(area2 > 1e-9)) return undefined;
    nx /= area2; ny /= area2; nz /= area2;
    return { up: ny > P.flatNy, area: area2 / 2, n: [nx, ny, nz] };
}

/** A point of an up-facing surface is roof when no surface stands over it (checked per point: a parapet's top shares a cell with the roof beside it). */
const seenFromAbove = (x: number, y: number, z: number, top: (x: number, z: number) => number, P: TextureHarmonizeParams) => y >= top(x, z) - P.roofToleranceM;

/**
 * Which texels of each photo (image index -> its size) are roof and which are wall (TEXEL_*), from the triangles that use
 * them, grown by two texels so a bilinear lookup at a triangle's edge reads its own surface. Hidden up-facing surfaces
 * count as wall (nothing shows them).
 */
export function surfaceClassMasks(g: ParsedGlb, json: any, sizes: Map<number, { width: number; height: number }>, P: TextureHarmonizeParams = TEXTURE_HARMONIZE_PARAMS): Map<number, Uint8Array> {
    const top = topHeightMap(g, json, P);
    const masks = new Map<number, Uint8Array>();
    for (const [img, s] of sizes) masks.set(img, new Uint8Array(s.width * s.height));
    forEachTexturedTriangle(g, json, (img, p, uv) => {
        const m = masks.get(img), s = sizes.get(img);
        if (!m || !s) return;
        const surf = triangleFacing(p, P);
        if (!surf) return;
        const ax = uv[0] * s.width, ay = uv[1] * s.height, bx = uv[2] * s.width, by = uv[3] * s.height, cx = uv[4] * s.width, cy = uv[5] * s.height;
        const den = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy);
        const x0 = Math.max(0, Math.floor(Math.min(ax, bx, cx))), x1 = Math.min(s.width - 1, Math.ceil(Math.max(ax, bx, cx)));
        const y0 = Math.max(0, Math.floor(Math.min(ay, by, cy))), y1 = Math.min(s.height - 1, Math.ceil(Math.max(ay, by, cy)));
        if (Math.abs(den) < 1e-12) { if (x0 <= x1 && y0 <= y1) m[y0 * s.width + x0] ||= TEXEL_WALL; return; }
        for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
            const px = x + 0.5, py = y + 0.5;
            const a = ((by - cy) * (px - cx) + (cx - bx) * (py - cy)) / den, b = ((cy - ay) * (px - cx) + (ax - cx) * (py - cy)) / den;
            if (a < 0 || b < 0 || a + b > 1) continue;
            const c = 1 - a - b;
            const cls = surf.up && seenFromAbove(a * p[0] + b * p[3] + c * p[6], a * p[1] + b * p[4] + c * p[7], a * p[2] + b * p[5] + c * p[8], top, P) ? TEXEL_ROOF : TEXEL_WALL;
            // a texel two surfaces share stays roof only if both are
            const k = y * s.width + x;
            m[k] = m[k] === TEXEL_NONE ? cls : Math.min(m[k], cls);
        }
    });
    for (const [img, m] of masks) {
        const { width: W, height: H } = sizes.get(img)!;
        for (let pass = 0; pass < 2; pass++) {
            const src = m.slice();
            for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
                const k = y * W + x;
                if (src[k] !== TEXEL_NONE) continue;
                let best = TEXEL_NONE;
                if (x > 0 && src[k - 1]) best = Math.max(best, src[k - 1]);
                if (x + 1 < W && src[k + 1]) best = Math.max(best, src[k + 1]);
                if (y > 0 && src[k - W]) best = Math.max(best, src[k - W]);
                if (y + 1 < H && src[k + W]) best = Math.max(best, src[k + W]);
                m[k] = best;
            }
        }
    }
    return masks;
}

/** Bilinear linear-RGB colour of an image at a UV (wrapped, glTF origin at the top left). */
function sampleLinear(img: RgbaImage8, u: number, v: number): [number, number, number] {
    const W = img.width, H = img.height;
    const fx = ((u % 1) + 1) % 1 * W - 0.5, fy = ((v % 1) + 1) % 1 * H - 0.5;
    const x0 = Math.floor(fx), y0 = Math.floor(fy), a = fx - x0, b = fy - y0;
    const at = (x: number, y: number, c: number) => SRGB8_TO_LINEAR[img.rgba[(((y + H) % H) * W + ((x + W) % W)) * 4 + c]];
    const out: [number, number, number] = [0, 0, 0];
    for (let c = 0; c < 3; c++) out[c] = (1 - a) * (1 - b) * at(x0, y0, c) + a * (1 - b) * at(x0 + 1, y0, c) + (1 - a) * b * at(x0, y0 + 1, c) + a * b * at(x0 + 1, y0 + 1, c);
    return out;
}

/**
 * The textured triangles of a GLB sampled over their area: position, normal, photo (image index), UV, colour and whether
 * it is roof. Hidden up-facing surfaces are not sampled; their area (and the roofs') goes to `areas`.
 */
function samplesOf(g: ParsedGlb, json: any, images: Map<number, RgbaImage8>, P: TextureHarmonizeParams, areas: { roofM2: number; hiddenM2: number }): Sample[] {
    const out: Sample[] = [];
    const top = topHeightMap(g, json, P);
    // a triangle smaller than one sample's patch adds its area to a carry, and takes one sample (at its middle, weighted by
    // the carried area) once the carry reaches a patch: the samples follow the surface's area, not its triangle count (a
    // district's scan, a million and more small triangles, made several million samples that its memory could not hold)
    const patch = P.sampleM * P.sampleM;
    const carried = new Map<number, number>();
    forEachTexturedTriangle(g, json, (source, p, uv) => {
        const img = images.get(source);
        if (!img) return;
        const surf = triangleFacing(p, P);
        if (!surf) return;
        const [nx, ny, nz] = surf.n;
        if (surf.area < patch) {
            // per photo: one photo's small triangles never lend their area to another's sample
            const carry = (carried.get(source) ?? 0) + surf.area;
            if (carry < patch) { carried.set(source, carry); return; }
            carried.set(source, 0);
            const x = (p[0] + p[3] + p[6]) / 3, y = (p[1] + p[4] + p[7]) / 3, z = (p[2] + p[5] + p[8]) / 3, w = carry;
            const roof = surf.up && seenFromAbove(x, y, z, top, P);
            if (surf.up) { if (roof) areas.roofM2 += w; else { areas.hiddenM2 += w; return; } }
            const su = (uv[0] + uv[2] + uv[4]) / 3, sv = (uv[1] + uv[3] + uv[5]) / 3, lin = sampleLinear(img, su, sv);
            out.push({ x, y, z, nx, ny, nz, img: source, u: su, v: sv, w, c: [Math.log(lin[0] + LOG_EPS), Math.log(lin[1] + LOG_EPS), Math.log(lin[2] + LOG_EPS)], roof });
            return;
        }
        const ux = p[3] - p[0], uy = p[4] - p[1], uz = p[5] - p[2], vx = p[6] - p[0], vy = p[7] - p[1], vz = p[8] - p[2];
        const steps = Math.max(1, Math.min(Math.floor(Math.sqrt(2 * P.maxSamplesPerTriangle)) - 1, Math.ceil(Math.max(Math.hypot(ux, uy, uz), Math.hypot(vx, vy, vz)) / P.sampleM)));
        const count = ((steps + 1) * (steps + 2)) / 2, w = surf.area / count;
        for (let i = 0; i <= steps; i++) for (let j = 0; i + j <= steps; j++) {
            // the sample points sit off the corners (a corner is shared with the next triangle's photo)
            const a = (i + 1 / 3) / (steps + 1), b = (j + 1 / 3) / (steps + 1);
            if (a + b > 1) continue;
            const x = p[0] + ux * a + vx * b, y = p[1] + uy * a + vy * b, z = p[2] + uz * a + vz * b;
            const roof = surf.up && seenFromAbove(x, y, z, top, P);
            if (surf.up) { if (roof) areas.roofM2 += w; else { areas.hiddenM2 += w; continue; } }
            const su = uv[0] + (uv[2] - uv[0]) * a + (uv[4] - uv[0]) * b;
            const sv = uv[1] + (uv[3] - uv[1]) * a + (uv[5] - uv[1]) * b;
            const lin = sampleLinear(img, su, sv);
            out.push({
                x, y, z, nx, ny, nz,
                img: source, u: su, v: sv, w, c: [Math.log(lin[0] + LOG_EPS), Math.log(lin[1] + LOG_EPS), Math.log(lin[2] + LOG_EPS)], roof
            });
        }
    });
    return out;
}

const weightedMedian = (v: number[], w: number[]): number => {
    const idx = v.map((_, i) => i).sort((a, b) => v[a] - v[b]);
    const total = w.reduce((a, b) => a + b, 0);
    let acc = 0;
    for (const i of idx) { acc += w[i]; if (acc >= total / 2) return v[i]; }
    return v[idx[idx.length - 1]];
};

/** The offset field of one photo: nodes over its UV square. */
interface Field { nx: number; ny: number; base: number }

/** Bilinear weights of a UV in a photo's field: node indices (global) and weights. */
function fieldWeights(f: Field, u: number, v: number): [number[], number[]] {
    const fx = (((u % 1) + 1) % 1) * (f.nx - 1), fy = (((v % 1) + 1) % 1) * (f.ny - 1);
    const i = Math.min(f.nx - 2, Math.floor(fx)), j = Math.min(f.ny - 2, Math.floor(fy)), a = fx - i, b = fy - j;
    const at = (ii: number, jj: number) => f.base + jj * f.nx + ii;
    return [[at(i, j), at(i + 1, j), at(i, j + 1), at(i + 1, j + 1)], [(1 - a) * (1 - b), a * (1 - b), (1 - a) * b, a * b]];
}

/**
 * Harmonises the photos in `images` (image index -> de-lit photo) of the textured GLB `g` (its JSON `json`) in place:
 * colour matched per side and height band, seams levelled. `groundY` is the ground the bands are measured from;
 * `masks` are the photos' surfaceClassMasks (computed here when not given). A district (pipeline K-D) passes `buildingOf`,
 * the building a point stands in (by plan x, z; -1 for none): the groups and the seam patches are then per building as well, so a
 * photo is only compared with the others on the same building's surfaces, and two buildings of different stone keep their
 * own colours, even where they meet flush.
 */
export function harmonizeTextures(g: ParsedGlb, json: any, images: Map<number, RgbaImage8>, groundY: number, P: TextureHarmonizeParams = TEXTURE_HARMONIZE_PARAMS, masks?: Map<number, Uint8Array>, opts: { buildingOf?: (x: number, z: number) => number; /** Each phase as it ends, with its time (ms). */ onPhase?: (phase: string, ms: number) => void } = {}): TextureHarmonizeReport {
    const t0 = Date.now();
    const phasesMs: Record<string, number> = {};
    let tp = t0;
    const phase = (name: string) => { const t = Date.now(); phasesMs[name] = t - tp; tp = t; opts.onPhase?.(name, phasesMs[name]); };
    const areas = { roofM2: 0, hiddenM2: 0 };
    const samples = samplesOf(g, json, images, P, areas);
    phase('samples');
    const report: TextureHarmonizeReport = { images: images.size, samples: samples.length, groups: 0, roofs: { roofM2: Math.round(areas.roofM2), hiddenM2: Math.round(areas.hiddenM2), roofGains: 0 }, gains: { meanAbsLog: 0, maxAbsLog: 0 }, seams: { pairs: 0, before: 0, afterMatch: 0, after: 0 }, kept: false, why: '', ms: 0 };
    if (samples.length < 100 || images.size < 2) { report.why = 'fewer than two photos or too few samples: nothing to harmonise'; report.ms = Date.now() - t0; return report; }
    // 2. groups and their references
    const groupOf = (s: Sample) => {
        const band = Math.floor((s.y - groundY) / P.bandM), b = opts.buildingOf ? `b${opts.buildingOf(s.x, s.z)}:` : '';
        if (s.ny > P.flatNy) return `${b}up:${band}`;
        if (s.ny < -P.flatNy) return `${b}down:${band}`;
        const az = Math.atan2(s.nx, s.nz), bin = ((Math.round((az / (2 * Math.PI)) * P.sideBins) % P.sideBins) + P.sideBins) % P.sideBins;
        return `${b}side${bin}:${band}`;
    };
    // a photo's roof and the rest of it are matched apart: one gain each (key gainKey; the photo is key >> 1)
    const gainKey = (s: Sample) => s.img * 2 + (s.roof ? 1 : 0);
    const stats = new Map<string, Map<number, { w: number; c: [number, number, number] }>>();
    for (const s of samples) {
        const k = groupOf(s);
        let m = stats.get(k); if (!m) stats.set(k, (m = new Map()));
        let e = m.get(gainKey(s)); if (!e) m.set(gainKey(s), (e = { w: 0, c: [0, 0, 0] }));
        e.w += s.w; for (let c = 0; c < 3; c++) e.c[c] += s.w * s.c[c];
    }
    report.groups = stats.size;
    const gainNum = new Map<number, [number, number, number]>(), gainDen = new Map<number, number>();
    for (const m of stats.values()) {
        if (m.size < 2) continue;
        const list = [...m.entries()].map(([img, e]) => ({ img, w: e.w, c: e.c.map(v => v / e.w) as [number, number, number] }));
        const ref = [0, 1, 2].map(c => weightedMedian(list.map(x => x.c[c]), list.map(x => x.w)));
        for (const x of list) {
            const num = gainNum.get(x.img) ?? [0, 0, 0];
            for (let c = 0; c < 3; c++) num[c] += x.w * (ref[c] - x.c[c]);
            gainNum.set(x.img, num); gainDen.set(x.img, (gainDen.get(x.img) ?? 0) + x.w);
        }
    }
    const gain = new Map<number, [number, number, number]>();
    let sumAbs = 0, maxAbs = 0;
    for (const [img, num] of gainNum) {
        const d = gainDen.get(img)!, gg = num.map(v => P.gainScale * Math.max(-P.maxGainLog, Math.min(P.maxGainLog, v / d))) as [number, number, number];
        gain.set(img, gg);
        if (img & 1) report.roofs.roofGains++;
        for (const v of gg) { sumAbs += Math.abs(v); maxAbs = Math.max(maxAbs, Math.abs(v)); }
    }
    report.gains = { meanAbsLog: gain.size ? +(sumAbs / (3 * gain.size)).toFixed(4) : 0, maxAbsLog: +maxAbs.toFixed(4) };
    phase('gains');
    // 3. seam patches: per cell of space and facing, the mean colour and UV of each photo there; a patch two photos share is a seam
    const facingBin = (s: Sample) => (s.ny > P.flatNy ? 'u' : s.ny < -P.flatNy ? 'd' : String(((Math.round((Math.atan2(s.nx, s.nz) / (2 * Math.PI)) * P.seamFacingBins) % P.seamFacingBins) + P.seamFacingBins) % P.seamFacingBins));
    const patches = new Map<string, Map<number, { w: number; c: [number, number, number]; u: number; v: number }>>();
    for (const s of samples) {
        // a district: two buildings meeting flush are never levelled into each other
        const k = `${opts.buildingOf ? `b${opts.buildingOf(s.x, s.z)}:` : ''}${Math.floor(s.x / P.seamM)},${Math.floor(s.y / P.seamM)},${Math.floor(s.z / P.seamM)},${facingBin(s)}`;
        let m = patches.get(k); if (!m) patches.set(k, (m = new Map()));
        let e = m.get(gainKey(s)); if (!e) m.set(gainKey(s), (e = { w: 0, c: [0, 0, 0], u: 0, v: 0 }));
        e.w += s.w; e.u += s.w * s.u; e.v += s.w * s.v; for (let c = 0; c < 3; c++) e.c[c] += s.w * s.c[c];
    }
    // the pairs: each photo in a shared patch against the patch's largest photo (a star, not every pair); `img` is the gain key
    const pairs: Array<{ a: { img: number; u: number; v: number; c: [number, number, number] }; b: { img: number; u: number; v: number; c: [number, number, number] }; w: number }> = [];
    for (const m of patches.values()) {
        if (m.size < 2) continue;
        const list = [...m.entries()].map(([img, e]) => ({ img, w: e.w, u: e.u / e.w, v: e.v / e.w, c: e.c.map(x => x / e.w) as [number, number, number] })).sort((x, y) => y.w - x.w);
        for (let k = 1; k < list.length; k++) pairs.push({ a: list[0], b: list[k], w: Math.min(list[0].w, list[k].w) });
    }
    report.seams.pairs = pairs.length;
    phase('patches');
    const g0 = (img: number, c: number) => gain.get(img)?.[c] ?? 0;
    const seamDiff = (off?: Float64Array[], fields?: Map<number, Field>, useGain = true) => {
        let s = 0, wt = 0;
        for (const { a, b, w } of pairs) {
            for (let c = 0; c < 3; c++) {
                let va = a.c[c] + (useGain ? g0(a.img, c) : 0), vb = b.c[c] + (useGain ? g0(b.img, c) : 0);
                if (off && fields) {
                    const [ka, wa] = fieldWeights(fields.get(a.img >> 1)!, a.u, a.v), [kb, wb] = fieldWeights(fields.get(b.img >> 1)!, b.u, b.v);
                    for (let q = 0; q < 4; q++) { va += wa[q] * off[c][ka[q]]; vb += wb[q] * off[c][kb[q]]; }
                }
                s += w * Math.abs(va - vb); wt += w;
            }
        }
        return wt > 0 ? s / wt : 0;
    };
    report.seams.before = +seamDiff(undefined, undefined, false).toFixed(4);
    report.seams.afterMatch = +seamDiff().toFixed(4);
    // the fields: one per photo, solved per channel
    const fields = new Map<number, Field>();
    let nodes = 0;
    for (const [img, im] of images) {
        const nx = Math.max(2, Math.min(P.maxField, Math.ceil(im.width / P.fieldPx) + 1)), ny = Math.max(2, Math.min(P.maxField, Math.ceil(im.height / P.fieldPx) + 1));
        fields.set(img, { nx, ny, base: nodes });
        nodes += nx * ny;
    }
    phase('seamsBefore');
    const off: Float64Array[] = [];
    for (let c = 0; c < 3; c++) {
        const rows = new Rows();
        for (const { a, b, w } of pairs) {
            const [ka, wa] = fieldWeights(fields.get(a.img >> 1)!, a.u, a.v), [kb, wb] = fieldWeights(fields.get(b.img >> 1)!, b.u, b.v);
            // off_a(uv_a) - off_b(uv_b) = (b + gain_b) - (a + gain_a), weighted by the smaller photo's area in the patch (m2)
            rows.add([...ka, ...kb], [...wa, ...wb.map(x => -x)], (b.c[c] + g0(b.img, c)) - (a.c[c] + g0(a.img, c)), Math.min(4, w));
        }
        for (const f of fields.values()) for (let jy = 0; jy < f.ny; jy++) for (let ix = 0; ix < f.nx; ix++) {
            const k = f.base + jy * f.nx + ix;
            rows.add([k], [1], 0, P.wAnchor);
            if (ix + 1 < f.nx) rows.add([k, k + 1], [1, -1], 0, P.wSmooth);
            if (jy + 1 < f.ny) rows.add([k, k + f.nx], [1, -1], 0, P.wSmooth);
        }
        const sol = solveLeastSquares(rows, nodes, new Float64Array(nodes), 400, 1e-6);
        for (let k = 0; k < nodes; k++) sol.u[k] = Math.max(-P.maxOffsetLog, Math.min(P.maxOffsetLog, sol.u[k]));
        off.push(sol.u);
    }
    phase('solve');
    report.seams.after = +seamDiff(off, fields).toFixed(4);
    report.phasesMs = phasesMs;
    if (!(report.seams.after < report.seams.before)) { report.why = `the seams did not get closer (${report.seams.before} -> ${report.seams.after} in log colour)`; report.ms = Date.now() - t0; return report; }
    // apply: per texel, the photo's gain (its roof's on a roof texel) and its field's offset, in linear light
    const classOf = masks ?? surfaceClassMasks(g, json, images, P);
    for (const [img, im] of images) {
        const f = fields.get(img)!, wallGain = gain.get(img * 2) ?? [0, 0, 0], roofGain = gain.get(img * 2 + 1) ?? [0, 0, 0], out = new Uint8Array(im.rgba);
        const mask = classOf.get(img);
        // the field's bilinear cell and weight per column and per row (fieldWeights, worked out once per line, not per texel)
        const W = im.width, H = im.height, ci = new Int32Array(W), ca = new Float64Array(W), rj = new Int32Array(H), rb = new Float64Array(H);
        for (let x = 0; x < W; x++) { const fx = ((x + 0.5) / W) * (f.nx - 1); ci[x] = Math.min(f.nx - 2, Math.floor(fx)); ca[x] = fx - ci[x]; }
        for (let y = 0; y < H; y++) { const fy = ((y + 0.5) / H) * (f.ny - 1); rj[y] = Math.min(f.ny - 2, Math.floor(fy)); rb[y] = fy - rj[y]; }
        for (let y = 0; y < H; y++) {
            const b = rb[y], row = f.base + rj[y] * f.nx;
            for (let x = 0; x < W; x++) {
                const a = ca[x], k00 = row + ci[x], k10 = k00 + 1, k01 = k00 + f.nx, k11 = k01 + 1;
                const w00 = (1 - a) * (1 - b), w10 = a * (1 - b), w01 = (1 - a) * b, w11 = a * b;
                const p = (y * W + x) * 4;
                const gg = mask?.[y * W + x] === TEXEL_ROOF ? roofGain : wallGain;
                for (let c = 0; c < 3; c++) {
                    const oc = off[c];
                    const o = gg[c] + w00 * oc[k00] + w10 * oc[k10] + w01 * oc[k01] + w11 * oc[k11];
                    out[p + c] = Math.round(linearToSrgb255(SRGB8_TO_LINEAR[im.rgba[p + c]] * Math.exp(o)));
                }
            }
        }
        images.set(img, { width: im.width, height: im.height, rgba: out });
    }
    phase('apply');
    report.kept = true;
    report.why = `${images.size} photos matched to ${report.groups} side and height-band references, roofs apart (${report.roofs.roofM2} m² of roof seen from above, ${report.roofs.hiddenM2} m² of hidden up-facing surface left out; ${report.roofs.roofGains} roof gains) (mean gain ${Math.round((Math.exp(report.gains.meanAbsLog) - 1) * 100)}%), ${pairs.length} shared surface patches levelled: mean patch difference ${report.seams.before} -> ${report.seams.afterMatch} (matched) -> ${report.seams.after} (levelled), in log colour`;
    report.ms = Date.now() - t0;
    return report;
}
