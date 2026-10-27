/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Pipeline K's material regions: the harmonised photos of one textured building kept as its colour, with a roughness,
 * metalness and normal under them, so the building answers the scene's light instead of showing the light it was
 * photographed in (the photos were drawn unlit before this stage).
 *
 *  1. Appearance classes: k-means in CIELAB on texels sampled from the rebuilt facades' photos, one set of classes for the
 *     whole building. The lightest class is the wall; the darker ones may only appear in openings.
 *  2. Openings, where metal and glass may go:
 *     - a rebuilt facade (a metric photo of one plane) has openings only when its photo shows a pier rhythm: the column
 *       lightness against a running mean repeats at a bay pitch with an NCC of at least minNcc, the piers are at least
 *       minContrast lighter than the bays, and the facade spans at least minBays pitches. The openings are then the
 *       columns darker than their local mean, less the rows that are wall most of the way across (photo-inferred);
 *     - a scan piece (atlas UVs, no frame) has openings only on the photometric relief's recessed cells (_RELIEF_HEIGHT
 *       below recessM: tile_refine's dark-cell lattice, confirmed where it repeats; its depth is photo-inferred, not
 *       measured);
 *     - elsewhere every texel is wall, whatever its colour (weathered or shaded stone falls in the darker classes).
 *  3. A library set per class (resolved by the caller: the texture library ranked by the class colour), its roughness,
 *     metalness and normal drawn at the set's real size over each rebuilt facade (box-filtered to the facade's texel, so
 *     a tile never aliases), and its mean finish on scan pieces.
 *  4. Glass: within a facade's openings, the connected regions of the darker classes other than the bay's own (its most
 *     common opening class), accepted by the facade material reading's tile-only test (latticeGlassAgreement: at least
 *     two like regions in a row or column, darker than the wall). Accepted glass is written as the reading writes it:
 *     base colour the region's 10th-percentile texel, roughness of float glass, dielectric, the photo kept as fallback,
 *     and the parameters texture (R glass weight, B metalness) the viewer reads for the scene's reflection.
 *
 * Labels: base colour photo-inferred (the photo); roughness, metalness and normal generated (library sets); glass
 * photo-inferred at the reading's tile-only confidence. Nothing is drawn where no photo is.
 */

import { readAccessor, type ParsedGlb } from '../glb-bytes';
import { SRGB8_TO_LINEAR } from '../../../../common/spatial/photogrammetric-delight';
import { linearRgbToLab } from '../../../../common/spatial/texture-library-index';
import type { RgbaImage8 } from '../tile-texture-transfer';
import { GLASS_ROUGHNESS, MIN_REGION_M2, latticeGlassAgreement } from '../facade-materials';
import { MATERIAL_PARAMS_CHANNELS } from '../staged-glb-writer';

export const MATERIAL_REGIONS_VERSION = 'material-regions/1';

export const MATERIAL_REGIONS_PARAMS = {
    /** Appearance classes, texels sampled per facade photo, k-means iterations, sampling seed. */
    classes: 4, samplesPerPhoto: 40000, iterations: 40, seed: 7,
    /** The pier rhythm a facade's photo must show before it has openings. */
    minNcc: 0.6, minContrast: 30, minBays: 2, pitchM: [2.5, 9] as [number, number], meanWindowM: 12,
    /** A row is wall when this share of it is wall texels. */
    wallRowShare: 0.6,
    /** A scan triangle is an opening when its mean _RELIEF_HEIGHT is below this (m). */
    recessM: -0.1,
    /** Glass candidates in line within this (m), as the facade material reading's tile-only test. */
    glassLineM: 0.3
};
export type MaterialRegionsParams = typeof MATERIAL_REGIONS_PARAMS;

/** A rebuilt facade's mesh, by the name facade-lattice.ts gives it: its photo is a metric orthophoto of one plane. */
const REBUILT_FACADE = /^facade_lattice_\d+$/;

export interface RegionClass {
    index: number;
    /** Mean colour, CIELAB and linear sRGB, and spread (CIELAB standard deviation). */
    meanLab: [number, number, number]; meanLinear: [number, number, number]; spreadLab: [number, number, number];
    /** Share of the sampled facade texels. */
    share: number;
    /** The lightest class: the wall, allowed everywhere. */
    wall: boolean;
}

/** One class's library set, resolved by the caller: maps prepared small (the engine's prepare_material_maps). */
export interface RegionSet {
    name: string;
    /** Real size of one tile, metres (x, y). */
    realSizeM: [number, number];
    /** OpenGL tangent-space normal and packed occlusion/roughness/metalness, RGBA8. */
    normal: RgbaImage8; orm: RgbaImage8;
    /** How near the set lies to the class (the library search's distance). */
    distance: number;
}

export interface MaterialRegionsReport {
    version: string;
    classes: Array<Pick<RegionClass, 'index' | 'meanLab' | 'share' | 'wall'> & { set: string; distance: number }>;
    facades: { total: number; withOpenings: number; perFacade: Array<{ mesh: string; texelM: number; rhythmNcc: number; pitchM: number; pierContrast: number; openings: string; openingShare: number; glassRegions: number; glassRejected: number }> };
    scanPieces: { total: number; recessShare: number };
    texels: { total: number; metal: number; glass: number };
    ms: number;
}

/** A material's maps, planned before the photos are encoded (glass edits the albedo in place). */
interface PlannedMaterial {
    material: number;
    orm: RgbaImage8; normal?: RgbaImage8; params: RgbaImage8; photoFallback?: RgbaImage8;
    rebuilt: boolean; glass: boolean;
}

export interface MaterialRegionsPlan { materials: PlannedMaterial[]; sets: RegionSet[]; report: MaterialRegionsReport }

// ---- colour ----
const LAB_CACHE = new Map<number, [number, number, number]>();
function labOf(r: number, g: number, b: number): [number, number, number] {
    // 5 bits a channel is finer than the classes need and keeps the cache small
    const key = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
    let v = LAB_CACHE.get(key);
    if (!v) { v = linearRgbToLab([SRGB8_TO_LINEAR[r], SRGB8_TO_LINEAR[g], SRGB8_TO_LINEAR[b]]); LAB_CACHE.set(key, v); }
    return v;
}
const lumaOf = (rgba: Uint8Array, p: number) => 0.2126 * SRGB8_TO_LINEAR[rgba[p]] + 0.7152 * SRGB8_TO_LINEAR[rgba[p + 1]] + 0.0722 * SRGB8_TO_LINEAR[rgba[p + 2]];

/** The image a material's colour texture shows, and the UV set it uses. */
function photoOf(json: any, material: number | undefined): { image: number; texCoord: number } | undefined {
    if (material === undefined) return undefined;
    const t = json.materials?.[material]?.pbrMetallicRoughness?.baseColorTexture;
    const image = t ? json.textures?.[t.index]?.source : undefined;
    return image === undefined ? undefined : { image, texCoord: t.texCoord ?? 0 };
}

/** Each textured triangle of a material: its world corners, UVs and, when present, its corners' _RELIEF_HEIGHT. */
function forEachTriangleOf(g: ParsedGlb, json: any, material: number, fn: (p: Float64Array, uv: Float64Array, relief: number | undefined) => void): void {
    const p = new Float64Array(9), q = new Float64Array(6);
    for (const mesh of json.meshes ?? []) for (const prim of mesh.primitives ?? []) {
        if ((prim.mode ?? 4) !== 4 || prim.material !== material || prim.attributes?.POSITION === undefined) continue;
        const photo = photoOf(json, material);
        const uvAcc = photo ? prim.attributes[`TEXCOORD_${photo.texCoord}`] : undefined;
        if (uvAcc === undefined) continue;
        const pos = readAccessor(g, prim.attributes.POSITION).data, uv = readAccessor(g, uvAcc).data;
        const rh = prim.attributes._RELIEF_HEIGHT !== undefined ? readAccessor(g, prim.attributes._RELIEF_HEIGHT).data : undefined;
        const idx = prim.indices !== undefined ? readAccessor(g, prim.indices).data : undefined;
        const n = idx ? idx.length : pos.length / 3;
        for (let t = 0; t + 2 < n; t += 3) {
            let relief = 0;
            for (let k = 0; k < 3; k++) {
                const i = idx ? idx[t + k] : t + k;
                p[k * 3] = pos[i * 3]; p[k * 3 + 1] = pos[i * 3 + 1]; p[k * 3 + 2] = pos[i * 3 + 2]; q[k * 2] = uv[i * 2]; q[k * 2 + 1] = uv[i * 2 + 1];
                if (rh) relief += rh[i] / 3;
            }
            fn(p, q, rh ? relief : undefined);
        }
    }
}

/** Visits the texels of a triangle given in pixel coordinates. */
function rasterTriangle(ax: number, ay: number, bx: number, by: number, cx: number, cy: number, W: number, H: number, visit: (k: number) => void): void {
    const den = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy);
    if (Math.abs(den) < 1e-12) return;
    const x0 = Math.max(0, Math.floor(Math.min(ax, bx, cx))), x1 = Math.min(W - 1, Math.ceil(Math.max(ax, bx, cx)));
    const y0 = Math.max(0, Math.floor(Math.min(ay, by, cy))), y1 = Math.min(H - 1, Math.ceil(Math.max(ay, by, cy)));
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
        const px = x + 0.5, py = y + 0.5;
        const a = ((by - cy) * (px - cx) + (cx - bx) * (py - cy)) / den, b = ((cy - ay) * (px - cx) + (ax - cx) * (py - cy)) / den;
        if (a >= 0 && b >= 0 && a + b <= 1) visit(y * W + x);
    }
}

/** Metres per texel of a rebuilt facade's photo, from its triangles' world area against their area in texels. */
function texelMetres(g: ParsedGlb, json: any, material: number, img: RgbaImage8): number {
    let world = 0, texels = 0;
    forEachTriangleOf(g, json, material, (p, uv) => {
        const ux = p[3] - p[0], uy = p[4] - p[1], uz = p[5] - p[2], vx = p[6] - p[0], vy = p[7] - p[1], vz = p[8] - p[2];
        world += 0.5 * Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx);
        texels += 0.5 * Math.abs((uv[2] - uv[0]) * img.width * (uv[5] - uv[1]) * img.height - (uv[4] - uv[0]) * img.width * (uv[3] - uv[1]) * img.height);
    });
    return texels > 0 ? Math.sqrt(world / texels) : 0;
}

/** A running mean with mirrored ends (as scipy's uniform_filter1d). */
function runningMean(v: ArrayLike<number>, size: number): Float64Array {
    const n = v.length, h = Math.floor(size / 2), out = new Float64Array(n);
    const at = (i: number) => v[i < 0 ? Math.min(n - 1, -i - 1) : i >= n ? Math.max(0, 2 * n - i - 1) : i];
    for (let i = 0; i < n; i++) { let s = 0; for (let k = -h; k < size - h; k++) s += at(i + k); out[i] = s / size; }
    return out;
}
function median(v: number[]): number { const s = [...v].sort((a, b) => a - b); return s.length ? s[s.length >> 1] : 0; }

/** The pier rhythm of a facade's photo (see the file comment) and, when confirmed, the bay columns. */
export function pierRhythm(img: RgbaImage8, texelM: number, P: MaterialRegionsParams = MATERIAL_REGIONS_PARAMS): { ncc: number; pitchM: number; contrast: number; bays?: Uint8Array } {
    const { width: W, height: H, rgba } = img;
    const col = new Float64Array(W), cnt = new Float64Array(W);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const p = (y * W + x) * 4;
        if (!rgba[p + 3]) continue;
        col[x] += (rgba[p] + rgba[p + 1] + rgba[p + 2]) / 3; cnt[x]++;
    }
    let all = 0, n = 0;
    for (let x = 0; x < W; x++) if (cnt[x]) { col[x] /= cnt[x]; all += col[x]; n++; }
    const fill = n ? all / n : 0;
    for (let x = 0; x < W; x++) if (!cnt[x]) col[x] = fill;
    const local = runningMean(col, Math.max(3, Math.floor(P.meanWindowM / texelM)));
    const pr = new Float64Array(W);
    let m = 0, s = 0;
    for (let x = 0; x < W; x++) { pr[x] = col[x] - local[x]; m += pr[x] / W; }
    for (let x = 0; x < W; x++) s += (pr[x] - m) ** 2 / W;
    const sd = Math.sqrt(s) + 1e-6;
    for (let x = 0; x < W; x++) pr[x] = (pr[x] - m) / sd;
    let ncc = 0, lag = 0;
    for (let k = Math.max(2, Math.floor(P.pitchM[0] / texelM)); k <= Math.min(Math.floor(W / 2), Math.floor(P.pitchM[1] / texelM)); k++) {
        let c = 0;
        for (let x = 0; x + k < W; x++) c += pr[x] * pr[x + k];
        c /= W - k;
        if (c > ncc) { ncc = c; lag = k; }
    }
    const light: number[] = [], dark: number[] = [];
    for (let x = 0; x < W; x++) { if (pr[x] > 0.5) light.push(col[x]); else if (pr[x] < -0.5) dark.push(col[x]); }
    const contrast = light.length && dark.length ? median(light) - median(dark) : 0;
    const out = { ncc, pitchM: lag * texelM, contrast };
    if (!(ncc >= P.minNcc && contrast >= P.minContrast && lag > 0 && W >= P.minBays * lag)) return out;
    const smooth = runningMean(pr, 3), bays = new Uint8Array(W);
    for (let x = 0; x < W; x++) bays[x] = smooth[x] < 0 ? 1 : 0;
    return { ...out, bays };
}

/** Deterministic sampling (a 32-bit LCG). */
function sampler(seed: number): () => number { let s = seed >>> 0; return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296); }

/** The rebuilt facades' materials of a GLB (see REBUILT_FACADE) and every other photo-textured material. */
function photoMaterials(json: any): { rebuilt: Map<number, string>; other: Set<number> } {
    const rebuilt = new Map<number, string>(), other = new Set<number>();
    for (const mesh of json.meshes ?? []) for (const prim of mesh.primitives ?? []) {
        if (prim.material === undefined || !photoOf(json, prim.material)) continue;
        if (REBUILT_FACADE.test(mesh.name ?? '')) rebuilt.set(prim.material, mesh.name); else other.add(prim.material);
    }
    for (const mi of rebuilt.keys()) other.delete(mi);
    return { rebuilt, other };
}

/**
 * The building's appearance classes, from its rebuilt facades' photos (image index -> photo); undefined when it has no
 * rebuilt facade (nothing gives the classes a metric photo to come from).
 */
export function readRegionClasses(json: any, images: Map<number, RgbaImage8>, P: MaterialRegionsParams = MATERIAL_REGIONS_PARAMS): RegionClass[] | undefined {
    const { rebuilt } = photoMaterials(json);
    const rnd = sampler(P.seed), X: number[] = [];
    for (const mi of rebuilt.keys()) {
        const img = images.get(photoOf(json, mi)!.image);
        if (!img) continue;
        const N = img.width * img.height, take = Math.min(N, P.samplesPerPhoto);
        for (let s = 0; s < take; s++) {
            const p = Math.floor(rnd() * N) * 4;
            if (!img.rgba[p + 3]) continue;
            X.push(...labOf(img.rgba[p], img.rgba[p + 1], img.rgba[p + 2]));
        }
    }
    const n = X.length / 3, K = P.classes;
    if (n < K * 10) return undefined;
    // seeds spread over lightness, so the classes come out ordered and the result does not depend on a draw
    const order = Array.from({ length: n }, (_, i) => i).sort((a, b) => X[a * 3] - X[b * 3]);
    let C = Array.from({ length: K }, (_, k) => { const i = order[Math.floor(((k + 0.5) / K) * n)]; return [X[i * 3], X[i * 3 + 1], X[i * 3 + 2]]; });
    const lab = new Int32Array(n);
    for (let it = 0; it < P.iterations; it++) {
        const sum = Array.from({ length: K }, () => [0, 0, 0, 0]);
        for (let i = 0; i < n; i++) {
            let best = 0, bd = Infinity;
            for (let k = 0; k < K; k++) { const d = (X[i * 3] - C[k][0]) ** 2 + (X[i * 3 + 1] - C[k][1]) ** 2 + (X[i * 3 + 2] - C[k][2]) ** 2; if (d < bd) { bd = d; best = k; } }
            lab[i] = best; sum[best][0] += X[i * 3]; sum[best][1] += X[i * 3 + 1]; sum[best][2] += X[i * 3 + 2]; sum[best][3]++;
        }
        C = C.map((c, k) => sum[k][3] ? [sum[k][0] / sum[k][3], sum[k][1] / sum[k][3], sum[k][2] / sum[k][3]] : c);
    }
    const idx = C.map((_, k) => k).sort((a, b) => C[a][0] - C[b][0]);
    return idx.map((k, rank) => {
        let cnt = 0;
        const sd = [0, 0, 0];
        for (let i = 0; i < n; i++) if (lab[i] === k) { cnt++; for (let c = 0; c < 3; c++) sd[c] += (X[i * 3 + c] - C[k][c]) ** 2; }
        const [L, a, b] = C[k];
        // back to linear sRGB for the library query (CIELAB D65 inverted)
        const fy = (L + 16) / 116, fx = fy + a / 500, fz = fy - b / 200;
        const inv = (t: number) => (t ** 3 > 0.008856 ? t ** 3 : (t - 16 / 116) / 7.787);
        const Xw = inv(fx) * 0.95047, Yw = inv(fy), Zw = inv(fz) * 1.08883;
        const lin: [number, number, number] = [3.2406 * Xw - 1.5372 * Yw - 0.4986 * Zw, -0.9689 * Xw + 1.8758 * Yw + 0.0415 * Zw, 0.0557 * Xw - 0.204 * Yw + 1.057 * Zw].map(v => Math.max(0, Math.min(1, v))) as [number, number, number];
        const r2 = (v: number) => Math.round(v * 100) / 100;
        return {
            index: rank, meanLab: [r2(L), r2(a), r2(b)], meanLinear: lin.map(r2) as [number, number, number],
            spreadLab: sd.map(v => r2(Math.sqrt(v / Math.max(1, cnt)))) as [number, number, number],
            share: Math.round((cnt / n) * 1000) / 1000, wall: rank === K - 1
        };
    });
}

/** Each texel's class, with a 3 x 3 majority so single-texel speckle never flips a finish. */
function classify(img: RgbaImage8, classes: RegionClass[], only?: Uint8Array): Uint8Array {
    const { width: W, height: H, rgba } = img, K = classes.length;
    const raw = new Uint8Array(W * H);
    for (let k = 0; k < W * H; k++) {
        if (only && !only[k]) { raw[k] = K - 1; continue; }
        const [L, a, b] = labOf(rgba[k * 4], rgba[k * 4 + 1], rgba[k * 4 + 2]);
        let best = 0, bd = Infinity;
        for (let c = 0; c < K; c++) { const m = classes[c].meanLab, d = (L - m[0]) ** 2 + (a - m[1]) ** 2 + (b - m[2]) ** 2; if (d < bd) { bd = d; best = c; } }
        raw[k] = best;
    }
    const out = new Uint8Array(W * H), votes = new Uint16Array(K);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        votes.fill(0);
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
            const yy = y + dy, xx = x + dx;
            if (yy >= 0 && yy < H && xx >= 0 && xx < W) votes[raw[yy * W + xx]]++;
        }
        let best = raw[y * W + x];
        for (let c = 0; c < K; c++) if (votes[c] > votes[best]) best = c;
        out[y * W + x] = best;
    }
    return out;
}

/** A library map box-filtered to a tile of tw x th texels (each texel the mean of the source texels it covers). */
function shrinkTile(src: RgbaImage8, tw: number, th: number, normal: boolean): Float32Array {
    const out = new Float32Array(tw * th * 3);
    for (let ty = 0; ty < th; ty++) for (let tx = 0; tx < tw; tx++) {
        const x0 = Math.floor((tx * src.width) / tw), x1 = Math.max(x0 + 1, Math.floor(((tx + 1) * src.width) / tw));
        const y0 = Math.floor((ty * src.height) / th), y1 = Math.max(y0 + 1, Math.floor(((ty + 1) * src.height) / th));
        const s = [0, 0, 0];
        for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) for (let c = 0; c < 3; c++) s[c] += src.rgba[(y * src.width + x) * 4 + c] / 255;
        const n = (x1 - x0) * (y1 - y0);
        let v = s.map(c => c / n);
        if (normal) { const d = v.map(c => c * 2 - 1), l = Math.hypot(d[0], d[1], d[2]) || 1; v = d.map(c => (c / l) * 0.5 + 0.5); }
        out.set(v, (ty * tw + tx) * 3);
    }
    return out;
}

function meanOf(src: RgbaImage8): [number, number, number] {
    const s = [0, 0, 0], n = src.width * src.height;
    for (let k = 0; k < n; k++) for (let c = 0; c < 3; c++) s[c] += src.rgba[k * 4 + c] / 255;
    return s.map(v => v / n) as [number, number, number];
}

const blank = (W: number, H: number): RgbaImage8 => ({ width: W, height: H, rgba: new Uint8Array(W * H * 4) });

/**
 * Plans the maps of every photo-textured material (see the file comment), editing accepted glass texels of `images`
 * in place (their photo kept as the fallback). `sets[k]` is class k's set.
 */
export function planMaterialRegions(g: ParsedGlb, json: any, images: Map<number, RgbaImage8>, classes: RegionClass[], sets: RegionSet[], P: MaterialRegionsParams = MATERIAL_REGIONS_PARAMS): MaterialRegionsPlan {
    const t0 = Date.now();
    const K = classes.length, WALL = K - 1;
    const { rebuilt, other } = photoMaterials(json);
    const planned: PlannedMaterial[] = [];
    const report: MaterialRegionsReport = {
        version: MATERIAL_REGIONS_VERSION,
        classes: classes.map((c, k) => ({ index: c.index, meanLab: c.meanLab, share: c.share, wall: c.wall, set: sets[k].name, distance: Math.round(sets[k].distance * 100) / 100 })),
        facades: { total: rebuilt.size, withOpenings: 0, perFacade: [] }, scanPieces: { total: other.size, recessShare: 0 }, texels: { total: 0, metal: 0, glass: 0 }, ms: 0
    };
    const setMeans = sets.map(s => meanOf(s.orm));
    const done = new Set<number>();
    const write = (orm: RgbaImage8, params: RgbaImage8, k: number, r: number, m: number, glassWeight: number) => {
        orm.rgba[k * 4] = 255; orm.rgba[k * 4 + 1] = Math.round(r * 255); orm.rgba[k * 4 + 2] = Math.round(m * 255); orm.rgba[k * 4 + 3] = 255;
        params.rgba[k * 4] = glassWeight; params.rgba[k * 4 + 2] = Math.round(m * 255); params.rgba[k * 4 + 3] = 255;
        report.texels.total++;
        if (glassWeight) report.texels.glass++; else if (m >= 0.5) report.texels.metal++;
    };

    // ---- rebuilt facades ----
    for (const [mi, mesh] of rebuilt) {
        const photo = photoOf(json, mi)!, img = images.get(photo.image);
        if (!img || done.has(photo.image)) continue;
        done.add(photo.image);
        const { width: W, height: H } = img, N = W * H;
        const texelM = texelMetres(g, json, mi, img);
        if (!(texelM > 0)) continue;
        const cls = classify(img, classes);
        const rhythm = pierRhythm(img, texelM, P);
        const opening = new Uint8Array(N);
        if (rhythm.bays) {
            for (let y = 0; y < H; y++) {
                let wall = 0;
                for (let x = 0; x < W; x++) if (cls[y * W + x] === WALL) wall++;
                if (wall / W > P.wallRowShare) continue;
                for (let x = 0; x < W; x++) if (rhythm.bays[x]) opening[y * W + x] = 1;
            }
        }
        // the finish of each texel: wall outside the openings, its class inside
        const finish = new Uint8Array(N);
        const inBays = new Uint32Array(K);
        for (let k = 0; k < N; k++) { finish[k] = opening[k] ? cls[k] : WALL; if (opening[k] && cls[k] !== WALL) inBays[cls[k]]++; }
        let bayClass = -1;
        for (let c = 0; c < WALL; c++) if (inBays[c] && (bayClass < 0 || inBays[c] > inBays[bayClass])) bayClass = c;

        // ---- glass: the other darker classes' regions in the openings, by the reading's tile-only test ----
        const region = new Int32Array(N).fill(-1);
        const regions: Array<{ texels: number[]; c: [number, number]; n: number }> = [];
        const minTexels = MIN_REGION_M2 / (texelM * texelM);
        for (let s = 0; s < N; s++) {
            if (region[s] >= 0 || !opening[s] || cls[s] === WALL || cls[s] === bayClass) continue;
            const list: number[] = [], stack = [s];
            region[s] = regions.length;
            while (stack.length) {
                const k = stack.pop()!; list.push(k);
                const x = k % W, y = (k - x) / W;
                for (const [nx, ny] of [[x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1]]) {
                    if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
                    const j = ny * W + nx;
                    if (region[j] >= 0 || !opening[j] || cls[j] === WALL || cls[j] === bayClass) continue;
                    region[j] = regions.length; stack.push(j);
                }
            }
            let cx = 0, cy = 0;
            for (const k of list) { cx += k % W; cy += Math.floor(k / W); }
            regions.push({ texels: list, c: [cx / list.length, cy / list.length], n: list.length });
        }
        const big = regions.filter(r => r.n >= minTexels);
        let wallSum = 0, wallSq = 0, wallN = 0;
        for (let k = 0; k < N; k++) if (cls[k] === WALL && img.rgba[k * 4 + 3]) { const v = lumaOf(img.rgba, k * 4); wallSum += v; wallSq += v * v; wallN++; }
        const wallMean = wallN ? wallSum / wallN : 0, wallCv = wallN && wallMean > 0 ? Math.sqrt(Math.max(0, wallSq / wallN - wallMean * wallMean)) / wallMean : 0;
        const glassWeight = new Uint8Array(N);
        let accepted = 0, rejected = 0;
        const fallback = { ...img, rgba: img.rgba.slice() };
        for (const r of big) {
            let sum = 0, sq = 0;
            const lum = r.texels.map(k => { const v = lumaOf(img.rgba, k * 4); sum += v; sq += v * v; return v; });
            const mean = sum / r.n, cv = mean > 0 ? Math.sqrt(Math.max(0, sq / r.n - mean * mean)) / mean : 0;
            const agree = latticeGlassAgreement({ centre: r.c, texels: r.n, others: big.filter(o => o !== r), tolPx: P.glassLineM / texelM, mean, cv, wallMean, wallCv });
            if (!agree.accepted) { rejected++; continue; }
            accepted++;
            // drawn as glass: the region's measured interior (its 10th-percentile texel) as base colour, the reading's confidence
            const interior = r.texels[lum.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0])[Math.floor(0.1 * r.n)][1]];
            const w = Math.max(1, Math.round(255 * 0.5 * (agree.uniform ? 1 : 0.8)));
            for (const k of r.texels) {
                glassWeight[k] = w;
                for (let c = 0; c < 3; c++) img.rgba[k * 4 + c] = fallback.rgba[interior * 4 + c];
            }
        }

        // ---- maps: the sets tiled at their real size, box-filtered to this facade's texel ----
        const orm = blank(W, H), nrm = blank(W, H), params = blank(W, H);
        const tiles = sets.map(s => {
            const tw = Math.max(2, Math.round(s.realSizeM[0] / texelM)), th = Math.max(2, Math.round(s.realSizeM[1] / texelM));
            return { tw, th, n: shrinkTile(s.normal, tw, th, true), o: shrinkTile(s.orm, tw, th, false) };
        });
        for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
            const k = y * W + x;
            if (glassWeight[k]) {
                write(orm, params, k, GLASS_ROUGHNESS, 0, glassWeight[k]);
                nrm.rgba.set([128, 128, 255, 255], k * 4);
                continue;
            }
            const t = tiles[finish[k]], j = ((y % t.th) * t.tw + (x % t.tw)) * 3;
            write(orm, params, k, t.o[j + 1], t.o[j + 2], 0);
            nrm.rgba.set([Math.round(t.n[j] * 255), Math.round(t.n[j + 1] * 255), Math.round(t.n[j + 2] * 255), 255], k * 4);
        }
        let openN = 0;
        for (let k = 0; k < N; k++) openN += opening[k];
        if (rhythm.bays) report.facades.withOpenings++;
        const r2 = (v: number) => Math.round(v * 100) / 100;
        report.facades.perFacade.push({
            mesh, texelM: Math.round(texelM * 1e4) / 1e4, rhythmNcc: r2(rhythm.ncc), pitchM: r2(rhythm.pitchM), pierContrast: Math.round(rhythm.contrast * 10) / 10,
            openings: rhythm.bays ? "bays between the photo's piers" : 'none: no confirmed pier rhythm', openingShare: Math.round((openN / N) * 1000) / 1000, glassRegions: accepted, glassRejected: rejected
        });
        planned.push({ material: mi, orm, normal: nrm, params, ...(accepted ? { photoFallback: fallback } : {}), rebuilt: true, glass: accepted > 0 });
    }

    // ---- scan pieces: wall finish, the class's finish only on the relief's recessed cells ----
    let recess = 0, scanTexels = 0;
    for (const mi of other) {
        const photo = photoOf(json, mi)!, img = images.get(photo.image);
        if (!img || done.has(photo.image)) continue;
        done.add(photo.image);
        const { width: W, height: H } = img, N = W * H;
        const opening = new Uint8Array(N);
        forEachTriangleOf(g, json, mi, (_p, uv, relief) => {
            if (relief === undefined || !(relief < P.recessM)) return;
            rasterTriangle(uv[0] * W, uv[1] * H, uv[2] * W, uv[3] * H, uv[4] * W, uv[5] * H, W, H, k => { opening[k] = 1; });
        });
        const cls = classify(img, classes, opening);
        const orm = blank(W, H), params = blank(W, H);
        for (let k = 0; k < N; k++) {
            const c = opening[k] ? cls[k] : WALL;
            write(orm, params, k, setMeans[c][1], setMeans[c][2], 0);
            recess += opening[k];
        }
        scanTexels += N;
        planned.push({ material: mi, orm, params, rebuilt: false, glass: false });
    }
    report.scanPieces.recessShare = scanTexels ? Math.round((recess / scanTexels) * 1e4) / 1e4 : 0;
    report.ms = Date.now() - t0;
    return { materials: planned, sets, report };
}

/**
 * Writes a plan's maps into the GLB's materials: lit (KHR_materials_unlit removed), the metallic-roughness texture, the
 * normal on rebuilt facades, and the facade material reading's extras (parameters texture; photo fallback where glass
 * was drawn). `addTexture` stores an image and returns its texture index.
 */
export function writeMaterialRegions(json: any, plan: MaterialRegionsPlan, addTexture: (img: RgbaImage8, mimeType: 'image/png' | 'image/jpeg', name: string) => number, provenanceIndices: number[]): void {
    for (const pm of plan.materials) {
        const m = json.materials[pm.material];
        if (m.extensions) { delete m.extensions.KHR_materials_unlit; if (!Object.keys(m.extensions).length) delete m.extensions; }
        const name = m.name ?? `material_${pm.material}`;
        const pbr = m.pbrMetallicRoughness = m.pbrMetallicRoughness ?? {};
        pbr.metallicFactor = 1; pbr.roughnessFactor = 1;
        pbr.metallicRoughnessTexture = { index: addTexture(pm.orm, 'image/jpeg', `${name}_orm`) };
        if (pm.normal) m.normalTexture = { index: addTexture(pm.normal, 'image/jpeg', `${name}_normal`) };
        m.extras = {
            ...(m.extras ?? {}),
            sbMaterial: {
                schema: 'scratchbox.staged-material/1', paramsTexture: addTexture(pm.params, 'image/png', `${name}_material`), paramsChannels: MATERIAL_PARAMS_CHANNELS,
                ...(pm.photoFallback ? { photoFallbackTexture: addTexture(pm.photoFallback, 'image/jpeg', `${name}_photo`) } : {}),
                provenanceIndices
            },
            sbMaterialRegions: {
                version: MATERIAL_REGIONS_VERSION,
                baseColor: { label: 'photo-inferred', source: "pipeline K's harmonised photo" + (pm.glass ? '; glass regions drawn with their measured interior' : '') },
                roughnessMetalness: { label: 'generated', source: `texture library sets per appearance class (${plan.sets.map(s => s.name).join(', ')}); metal only in ${pm.rebuilt ? "the bays between the photo's piers" : "the photometric relief's recessed cells (photo-inferred)"}` },
                ...(pm.normal ? { normal: { label: 'generated', source: 'the same sets tiled at their real size' } } : {}),
                ...(pm.glass ? { glass: { label: 'photo-inferred', source: "the facade material reading's tile-only test (a regular lattice of regions darker than the wall)" } } : {})
            }
        };
    }
    if (!json.materials.some((m: any) => m.extensions?.KHR_materials_unlit) && Array.isArray(json.extensionsUsed)) {
        json.extensionsUsed = json.extensionsUsed.filter((e: string) => e !== 'KHR_materials_unlit');
        if (!json.extensionsUsed.length) delete json.extensionsUsed;
    }
}

/** One line for the build's notes. */
export function describeMaterialRegions(r: MaterialRegionsReport): string {
    const pct = (a: number) => r.texels.total ? `${Math.round((100 * a) / r.texels.total)}%` : '0%';
    return `material regions: ${r.classes.length} appearance classes (${r.classes.map(c => `${c.wall ? 'wall' : 'L ' + Math.round(c.meanLab[0])} -> ${c.set}`).join(', ')}); ` +
        `${r.facades.withOpenings} of ${r.facades.total} rebuilt facades show a pier rhythm and got openings, the rest wall finish only; ` +
        `scan pieces: openings only on the photometric relief's recessed cells (${Math.round(r.scanPieces.recessShare * 1000) / 10}% of their texels); ` +
        `${pct(r.texels.metal)} of texels metal, ${pct(r.texels.glass)} glass (${r.facades.perFacade.reduce((a, f) => a + f.glassRegions, 0)} regions accepted by the lattice test, ${r.facades.perFacade.reduce((a, f) => a + f.glassRejected, 0)} rejected); ` +
        `roughness, metalness and normal generated from the library, colour the photo (${r.ms} ms)`;
}
