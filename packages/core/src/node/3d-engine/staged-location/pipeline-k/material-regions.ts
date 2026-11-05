/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/


/**
 * Pipeline K's material regions: the harmonised photos of one textured building kept as its colour, with the occlusion,
 * roughness, metalness and normal of a detected material under every texel, so the building answers the scene's light
 * instead of showing the light it was photographed in (the photos were drawn unlit before this stage). One material path
 * for every surface (user decision, 2026-11-05): no glass layer, no metal gate, no plain finish.
 *
 *  1. Appearance classes: k-means in CIELAB on texels sampled from the rebuilt facades' photos, one set of classes for the
 *     whole building (every texel sampled: windows, spandrels and walls alike). The lightest class is labelled the wall.
 *  2. A library set per class (resolved by the caller, material-sets.ts: ranked by the class's colour and the finish the
 *     vision model read, then picked by its look among the nearest).
 *  3. Each texel's class: its nearest class in CIELAB, then the majority over a square of regionSmoothM about it (so a
 *     material reads as a region, never as texel speckle), whatever the window fit or the lattice found there.
 *  4. Maps: on each rebuilt facade, each texel's class's set tiled at the set's real size, box-filtered to the facade's
 *     texel (so a tile never aliases): occlusion, roughness and metalness (ORM) and the normal, as the set has them; on
 *     scan pieces, whose atlases carry no metric frame for a tile, each texel's class's set's mean ORM.
 *
 * Labels: base colour photo-inferred (the photo, never relit or lifted: it is the evidence of how the building looks); each
 * texel's material photo-inferred (its class); occlusion, roughness, metalness and normal generated (library sets).
 * Nothing is drawn where no photo is.
 */

import { readAccessor, type ParsedGlb } from '../glb-bytes';
import { SRGB8_TO_LINEAR } from '../../../../common/spatial/photogrammetric-delight';
import { linearRgbToLab } from '../../../../common/spatial/texture-library-index';
import type { RgbaImage8 } from '../tile-texture-transfer';
import { bandResponses, TEXTURE_BANDS_M, type TextureEnergy } from './material-harvest';

export const MATERIAL_REGIONS_VERSION = 'material-regions/32';

export const MATERIAL_REGIONS_PARAMS = {
    /** Appearance classes, texels sampled per facade photo, k-means iterations, sampling seed. */
    classes: 4, samplesPerPhoto: 40000, iterations: 40, seed: 7,
    /**
     * A texel takes the class most of the square within this of it holds (m; at least one texel): a material is a region of
     * the surface, under a mullion's width, so shading speckle and a photo seam never flip one texel's finish.
     */
    regionSmoothM: 0.15,
    /** The square's largest half-side, texels (on a scan atlas of coarse texels the square stays a few texels). */
    regionSmoothMaxTexels: 32
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
    /** The lightest class (a label only: every class is drawn with its own set wherever its texels are). */
    wall: boolean;
    /** The tile-only harvest (material-harvest.ts): the class's texture energy on the facade photos, and on how many facades it holds at least 5%. Photo-inferred. */
    texture?: TextureEnergy; facades?: number;
}

/** One class's library set, resolved by the caller: maps prepared small (the engine's prepare_material_maps). */
export interface RegionSet {
    name: string;
    /** Real size of one tile, metres (x, y). */
    realSizeM: [number, number];
    /** OpenGL tangent-space normal and packed occlusion/roughness/metalness, RGBA8, drawn as they are. */
    normal: RgbaImage8; orm: RgbaImage8;
    /** How near the set lies to the class (the library search's distance). */
    distance: number;
    /** The tile-only harvest's pick (material-harvest.ts): the class's and the set's texture energy at the class's texel, the distances it was chosen by, and what of it is generated. */
    harvest?: { colourDistance: number; textureDistance: number; classEnergy: number[]; setEnergy: number[]; texelM: number; candidates: number; grain: string };
    /** The pick by appearance (material-choice.ts): the candidates shown, whether the look or the ranking chose, what the chooser saw and why the ranking's nearest was kept; `reused`: the pick kept for an earlier class shown the same candidates, its colour and how far this class's lies from it (CHOICE_REUSE), not asked again. */
    choice?: { candidates: string[]; by: 'appearance' | 'ranking'; seen?: string; conf?: number; reused?: { meanLab: [number, number, number]; colourUnits: number }; why?: string };
    /** The class's finish read by the vision model (material-finish.ts), or why there is none, and what the ranking ranked toward. Photo-inferred. */
    finish?: { read?: { roughness: number; metalness: number; conf: number; seen?: string }; why?: string; roughness: number; metallic: number; /** The finish the set's maps were drawn at (material-finish.ts finishMaps), when the reading was confident. */ drawn?: { roughness: number; metallic: number; relief: number }; label: 'photo-inferred' };
}

export interface MaterialRegionsReport {
    version: string;
    classes: Array<Pick<RegionClass, 'index' | 'meanLab' | 'share' | 'wall' | 'texture' | 'facades'> & { set: string; distance: number; harvest?: RegionSet['harvest']; choice?: RegionSet['choice']; finish?: RegionSet['finish'] }>;
    /** The rebuilt facades: each one's texel and the share of its texels each class (by index) holds. */
    facades: { total: number; perFacade: Array<{ mesh: string; texelM: number; classShares: number[] }> };
    scanPieces: { total: number };
    /** Every planned texel, and how many each class holds (by index). */
    texels: { total: number; perClass: number[] };
    ms: number;
}

/** A material's maps, planned before the photos are encoded. */
interface PlannedMaterial {
    material: number;
    orm: RgbaImage8; normal?: RgbaImage8;
    rebuilt: boolean;
}

export interface MaterialRegionsPlan { materials: PlannedMaterial[]; sets: RegionSet[]; report: MaterialRegionsReport }


// ---- colour ----
const LAB_CACHE = new Map<number, [number, number, number]>();
function labOf(r: number, g: number, b: number): [number, number, number] {
    // 5 bits a channel is finer than the classes need and keeps the cache small; the value is the bucket's own centre, so it
    // never depends on which texel filled the cache first (and is the same on every worker thread)
    const key = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
    let v = LAB_CACHE.get(key);
    if (!v) { v = linearRgbToLab([SRGB8_TO_LINEAR[(r & ~7) | 4], SRGB8_TO_LINEAR[(g & ~7) | 4], SRGB8_TO_LINEAR[(b & ~7) | 4]]); LAB_CACHE.set(key, v); }
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
/** Each textured triangle of a material: its world corners and UVs. */
function forEachTriangleOf(g: ParsedGlb, json: any, material: number, fn: (p: Float64Array, uv: Float64Array) => void): void {
    const p = new Float64Array(9), q = new Float64Array(6);
    for (const mesh of json.meshes ?? []) for (const prim of mesh.primitives ?? []) {
        if ((prim.mode ?? 4) !== 4 || prim.material !== material || prim.attributes?.POSITION === undefined) continue;
        const photo = photoOf(json, material);
        const uvAcc = photo ? prim.attributes[`TEXCOORD_${photo.texCoord}`] : undefined;
        if (uvAcc === undefined) continue;
        const pos = readAccessor(g, prim.attributes.POSITION).data, uv = readAccessor(g, uvAcc).data;
        const idx = prim.indices !== undefined ? readAccessor(g, prim.indices).data : undefined;
        const n = idx ? idx.length : pos.length / 3;
        for (let t = 0; t + 2 < n; t += 3) {
            for (let k = 0; k < 3; k++) {
                const i = idx ? idx[t + k] : t + k;
                p[k * 3] = pos[i * 3]; p[k * 3 + 1] = pos[i * 3 + 1]; p[k * 3 + 2] = pos[i * 3 + 2]; q[k * 2] = uv[i * 2]; q[k * 2 + 1] = uv[i * 2 + 1];
            }
            fn(p, q);
        }
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
export function readRegionClasses(json: any, images: Map<number, RgbaImage8>, P: MaterialRegionsParams = MATERIAL_REGIONS_PARAMS, harvest?: { g: ParsedGlb }): RegionClass[] | undefined {
    const { rebuilt } = photoMaterials(json);
    const rnd = sampler(P.seed), X: number[] = [];
    for (const mi of rebuilt.keys()) {
        const img = images.get(photoOf(json, mi)!.image);
        if (!img) continue;
        const N = img.width * img.height, take = Math.min(N, P.samplesPerPhoto);
        for (let s = 0; s < take; s++) {
            const q = Math.floor(rnd() * N), p = q * 4;
            if (!img.rgba[p + 3]) continue;
            X.push(...labOf(img.rgba[p], img.rgba[p + 1], img.rgba[p + 2]));
        }
    }
    // the harvest weighs lightness at half: one material lit two ways, or split by a photo seam, stays one class
    const wL = harvest ? 0.5 : 1;
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
            for (let k = 0; k < K; k++) { const d = (wL * (X[i * 3] - C[k][0])) ** 2 + (X[i * 3 + 1] - C[k][1]) ** 2 + (X[i * 3 + 2] - C[k][2]) ** 2; if (d < bd) { bd = d; best = k; } }
            lab[i] = best; sum[best][0] += X[i * 3]; sum[best][1] += X[i * 3 + 1]; sum[best][2] += X[i * 3 + 2]; sum[best][3]++;
        }
        C = C.map((c, k) => sum[k][3] ? [sum[k][0] / sum[k][3], sum[k][1] / sum[k][3], sum[k][2] / sum[k][3]] : c);
    }
    const idx = C.map((_, k) => k).sort((a, b) => C[a][0] - C[b][0]);
    const classes: RegionClass[] = idx.map((k, rank) => {
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
    if (harvest) harvestTextures(harvest.g, json, images, rebuilt, classes, wL);
    return classes;
}

/**
 * The tile-only harvest's texture per class (material-harvest.ts): on each rebuilt facade's photo, at its own texel, the band
 * responses of its texels, summed per class (each texel's nearest class, lightness
 * weighed as the classes were); and on how many facades each class holds at least 5% of the wall.
 */
function harvestTextures(g: ParsedGlb, json: any, images: Map<number, RgbaImage8>, rebuilt: Map<number, string>, classes: RegionClass[], wL: number): void {
    const K = classes.length, B = TEXTURE_BANDS_M.length;
    const sq = Array.from({ length: K }, () => new Float64Array(B)), lum = Array.from({ length: K }, () => new Float64Array(B)), cnt = Array.from({ length: K }, () => new Float64Array(B));
    const texelSum = new Float64Array(K), texelN = new Float64Array(K), facades = new Int32Array(K);
    for (const [mi] of rebuilt) {
        const img = images.get(photoOf(json, mi)!.image);
        if (!img) continue;
        const texelM = texelMetres(g, json, mi, img);
        if (!(texelM > 0)) continue;
        const N = img.width * img.height, valid = new Uint8Array(N), L = new Float32Array(N), cls = new Int8Array(N).fill(-1);
        const share = new Float64Array(K);
        for (let i = 0; i < N; i++) {
            const p = i * 4;
            if (!img.rgba[p + 3]) continue;
            valid[i] = 1;
            L[i] = lumaOf(img.rgba, p);
            const lab = labOf(img.rgba[p], img.rgba[p + 1], img.rgba[p + 2]);
            let best = 0, bd = Infinity;
            for (let k = 0; k < K; k++) { const c = classes[k].meanLab, d = (wL * (lab[0] - c[0])) ** 2 + (lab[1] - c[1]) ** 2 + (lab[2] - c[2]) ** 2; if (d < bd) { bd = d; best = k; } }
            cls[i] = best; share[best]++;
        }
        const total = share.reduce((a, b) => a + b, 0);
        if (!total) continue;
        for (let k = 0; k < K; k++) if (share[k] / total >= 0.05) facades[k]++;
        const r = bandResponses(L, img.width, img.height, texelM, valid);
        for (let i = 0; i < N; i++) {
            const k = cls[i];
            if (k < 0) continue;
            texelSum[k] += texelM; texelN[k]++;
            for (let b = 0; b < B; b++) if (Number.isFinite(r[b][i])) { sq[k][b] += r[b][i] * r[b][i]; lum[k][b] += L[i]; cnt[k][b]++; }
        }
    }
    classes.forEach((c, k) => {
        if (!texelN[k]) return;
        c.texture = { texelM: Math.round((texelSum[k] / texelN[k]) * 1e4) / 1e4, energy: Array.from({ length: B }, (_, b) => { if (!cnt[k][b]) return NaN; const m = lum[k][b] / cnt[k][b]; return m > 0 ? Math.round((sq[k][b] / cnt[k][b] / (m * m)) * 1e6) / 1e6 : NaN; }) };
        c.facades = facades[k];
    });
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
 * Each texel's class (see the file comment): its nearest class in CIELAB (an empty texel none), then the class most of the
 * (2r+1)-square about it holds, the texel's own on a tie, else the lowest index; a square of empty texels takes the last
 * (the lightest). Counted one class at a time with running sums, so memory stays a few bytes a texel.
 */
export function regionClassMap(img: RgbaImage8, classes: RegionClass[], r: number): Uint8Array {
    const { width: W, height: H, rgba } = img, K = classes.length, N = W * H, NONE = 255;
    const raw = new Uint8Array(N);
    for (let k = 0; k < N; k++) {
        if (!rgba[k * 4 + 3]) { raw[k] = NONE; continue; }
        const [L, a, b] = labOf(rgba[k * 4], rgba[k * 4 + 1], rgba[k * 4 + 2]);
        let best = 0, bd = Infinity;
        for (let c = 0; c < K; c++) { const m = classes[c].meanLab, d = (L - m[0]) ** 2 + (a - m[1]) ** 2 + (b - m[2]) ** 2; if (d < bd) { bd = d; best = c; } }
        raw[k] = best;
    }
    const best = new Uint8Array(N).fill(K - 1), bestN = new Uint16Array(N), rawN = new Uint16Array(N), row = new Uint16Array(N), cnt = new Uint16Array(N);
    for (let c = 0; c < K; c++) {
        // running counts of class c along each row, then down each column, over the square's half-side r
        for (let y = 0; y < H; y++) {
            let run = 0;
            const o = y * W;
            for (let x = 0; x < Math.min(W, r); x++) if (raw[o + x] === c) run++;
            for (let x = 0; x < W; x++) {
                if (x + r < W && raw[o + x + r] === c) run++;
                row[o + x] = run;
                if (x - r >= 0 && raw[o + x - r] === c) run--;
            }
        }
        for (let x = 0; x < W; x++) {
            let run = 0;
            for (let y = 0; y < Math.min(H, r); y++) run += row[y * W + x];
            for (let y = 0; y < H; y++) {
                if (y + r < H) run += row[(y + r) * W + x];
                cnt[y * W + x] = run;
                if (y - r >= 0) run -= row[(y - r) * W + x];
            }
        }
        for (let k = 0; k < N; k++) {
            if (cnt[k] > bestN[k]) { bestN[k] = cnt[k]; best[k] = c; }
            if (raw[k] === c) rawN[k] = cnt[k];
        }
    }
    for (let k = 0; k < N; k++) if (raw[k] !== NONE && rawN[k] === bestN[k]) best[k] = raw[k];
    return best;
}

/** The square's half-side in texels for a texel of `texelM` metres (see MATERIAL_REGIONS_PARAMS.regionSmoothM). */
export const regionRadius = (texelM: number, P: MaterialRegionsParams = MATERIAL_REGIONS_PARAMS) =>
    texelM > 0 ? Math.max(1, Math.min(P.regionSmoothMaxTexels, Math.round(P.regionSmoothM / texelM))) : 1;

/** One material's share of the plan: a rebuilt facade's photo, or a scan piece's (each photo planned once, the first material using it). */
export interface MaterialPlanJob { kind: 'rebuilt' | 'scan'; material: number; mesh?: string }

/** A job's planned maps and its part of the report, merged in job order (mergeMaterialPlan) so the plan is the same however the jobs ran. */
export interface MaterialPlanPiece {
    planned?: PlannedMaterial;
    facade?: MaterialRegionsReport['facades']['perFacade'][number];
    /** The job's texels each class holds (by index). */
    classTexels: number[];
}

/** What every job reads: the GLB, its photos, the classes and their sets, and each set's mean ORM. */
export interface MaterialPlanContext {
    g: ParsedGlb; json: any; images: Map<number, RgbaImage8>; classes: RegionClass[]; sets: RegionSet[]; P: MaterialRegionsParams;
    setMeans: Array<[number, number, number]>;
}

export function materialPlanContext(g: ParsedGlb, json: any, images: Map<number, RgbaImage8>, classes: RegionClass[], sets: RegionSet[], P: MaterialRegionsParams = MATERIAL_REGIONS_PARAMS): MaterialPlanContext {
    return { g, json, images, classes, sets, P, setMeans: sets.map(st => meanOf(st.orm)) };
}

/** The plan's jobs, in the order the plan is merged: the rebuilt facades' photos, then the scan pieces' (each photo once). */
export function materialPlanJobs(json: any, images: Map<number, RgbaImage8>): MaterialPlanJob[] {
    const { rebuilt, other } = photoMaterials(json);
    const done = new Set<number>(), jobs: MaterialPlanJob[] = [];
    for (const [mi, mesh] of rebuilt) { const image = photoOf(json, mi)!.image; if (!images.get(image) || done.has(image)) continue; done.add(image); jobs.push({ kind: 'rebuilt', material: mi, mesh }); }
    for (const mi of other) { const image = photoOf(json, mi)!.image; if (!images.get(image) || done.has(image)) continue; done.add(image); jobs.push({ kind: 'scan', material: mi }); }
    return jobs;
}

/** Plans one job's maps (see the file comment): independent of every other job, so jobs can run on separate threads. */
export function planMaterialJob(job: MaterialPlanJob, ctx: MaterialPlanContext): MaterialPlanPiece {
    const { g, json, images, classes, sets, P } = ctx;
    const K = classes.length;
    const piece: MaterialPlanPiece = { classTexels: new Array<number>(K).fill(0) };
    const mi = job.material, img = images.get(photoOf(json, mi)!.image)!;
    const { width: W, height: H } = img, N = W * H;
    const texelM = texelMetres(g, json, mi, img);
    if (job.kind === 'rebuilt' && !(texelM > 0)) return piece;
    const cls = regionClassMap(img, classes, regionRadius(texelM, P));
    for (let k = 0; k < N; k++) piece.classTexels[cls[k]]++;
    const orm = blank(W, H);
    if (job.kind === 'rebuilt') {
        // each class's set tiled at its real size, box-filtered to this facade's texel (built for the classes present)
        const tiles = sets.map((s, c) => {
            if (!piece.classTexels[c]) return undefined;
            const tw = Math.max(2, Math.round(s.realSizeM[0] / texelM)), th = Math.max(2, Math.round(s.realSizeM[1] / texelM));
            return { tw, th, n: shrinkTile(s.normal, tw, th, true), o: shrinkTile(s.orm, tw, th, false) };
        });
        const nrm = blank(W, H);
        for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
            const k = y * W + x, t = tiles[cls[k]]!, j = ((y % t.th) * t.tw + (x % t.tw)) * 3;
            orm.rgba.set([Math.round(t.o[j] * 255), Math.round(t.o[j + 1] * 255), Math.round(t.o[j + 2] * 255), 255], k * 4);
            nrm.rgba.set([Math.round(t.n[j] * 255), Math.round(t.n[j + 1] * 255), Math.round(t.n[j + 2] * 255), 255], k * 4);
        }
        const r3 = (v: number) => Math.round(v * 1000) / 1000;
        piece.facade = { mesh: job.mesh!, texelM: Math.round(texelM * 1e4) / 1e4, classShares: piece.classTexels.map(n => r3(n / N)) };
        piece.planned = { material: mi, orm, normal: nrm, rebuilt: true };
        return piece;
    }
    // scan pieces: each texel's class's set's mean ORM
    for (let k = 0; k < N; k++) {
        const m = ctx.setMeans[cls[k]];
        orm.rgba.set([Math.round(m[0] * 255), Math.round(m[1] * 255), Math.round(m[2] * 255), 255], k * 4);
    }
    piece.planned = { material: mi, orm, rebuilt: false };
    return piece;
}

/** The plan from its jobs' pieces, in job order. */
export function mergeMaterialPlan(json: any, classes: RegionClass[], sets: RegionSet[], pieces: MaterialPlanPiece[], ms: number): MaterialRegionsPlan {
    const { rebuilt, other } = photoMaterials(json);
    const report: MaterialRegionsReport = {
        version: MATERIAL_REGIONS_VERSION,
        classes: classes.map((c, k) => ({ index: c.index, meanLab: c.meanLab, share: c.share, wall: c.wall, set: sets[k].name, distance: Math.round(sets[k].distance * 100) / 100, ...(sets[k].harvest ? { harvest: sets[k].harvest } : {}), ...(sets[k].choice ? { choice: sets[k].choice } : {}), ...(sets[k].finish ? { finish: sets[k].finish } : {}), ...(c.texture ? { texture: c.texture, facades: c.facades } : {}) })),
        facades: { total: rebuilt.size, perFacade: [] }, scanPieces: { total: other.size }, texels: { total: 0, perClass: classes.map(() => 0) }, ms
    };
    const planned: PlannedMaterial[] = [];
    for (const p of pieces) {
        if (p.planned) planned.push(p.planned);
        if (p.facade) report.facades.perFacade.push(p.facade);
        p.classTexels.forEach((n, c) => { report.texels.perClass[c] += n; report.texels.total += n; });
    }
    return { materials: planned, sets, report };
}

/**
 * Plans the maps of every photo-textured material (see the file comment). `sets[k]` is class k's set. One thread; the
 * pipeline runs the same jobs across worker threads (material-regions-pool.ts) with the same result.
 */
export function planMaterialRegions(g: ParsedGlb, json: any, images: Map<number, RgbaImage8>, classes: RegionClass[], sets: RegionSet[], P: MaterialRegionsParams = MATERIAL_REGIONS_PARAMS): MaterialRegionsPlan {
    const t0 = Date.now();
    const ctx = materialPlanContext(g, json, images, classes, sets, P);
    const pieces = materialPlanJobs(json, images).map(j => planMaterialJob(j, ctx));
    return mergeMaterialPlan(json, classes, sets, pieces, Date.now() - t0);
}

/**
 * Writes a plan's maps into the GLB's materials: lit (KHR_materials_unlit removed), the metallic-roughness texture (its
 * red the occlusion, also the occlusion texture), the normal on rebuilt facades, and the extras: sbMaterial (the viewer's
 * reflection probe, every texel by its own roughness and metalness) and the maps' provenance. `addTexture` stores an image
 * and returns its texture index.
 */
export function writeMaterialRegions(json: any, plan: MaterialRegionsPlan, addTexture: (img: RgbaImage8, mimeType: 'image/png' | 'image/jpeg', name: string) => number, provenanceIndices: number[]): void {
    const sets = plan.sets.map(s => (s.harvest ? `${s.name}, chosen by colour and texture at the tile's texel (tile-only harvest), its finer grain ${s.harvest.grain}` : s.name)).join('; ');
    for (const pm of plan.materials) {
        const m = json.materials[pm.material];
        if (m.extensions) { delete m.extensions.KHR_materials_unlit; if (!Object.keys(m.extensions).length) delete m.extensions; }
        const name = m.name ?? `material_${pm.material}`;
        const pbr = m.pbrMetallicRoughness = m.pbrMetallicRoughness ?? {};
        pbr.metallicFactor = 1; pbr.roughnessFactor = 1;
        const orm = addTexture(pm.orm, 'image/jpeg', `${name}_orm`);
        pbr.metallicRoughnessTexture = { index: orm };
        m.occlusionTexture = { index: orm };
        if (pm.normal) m.normalTexture = { index: addTexture(pm.normal, 'image/jpeg', `${name}_normal`) };
        m.extras = {
            ...(m.extras ?? {}),
            sbMaterial: { schema: 'scratchbox.staged-material/1', provenanceIndices },
            sbMaterialRegions: {
                version: MATERIAL_REGIONS_VERSION,
                baseColor: { label: 'photo-inferred', source: "pipeline K's harmonised photo" },
                material: { label: 'photo-inferred', source: `each texel's appearance class (CIELAB, the majority within ${MATERIAL_REGIONS_PARAMS.regionSmoothM} m)` },
                maps: { label: 'generated', source: `the texture library set of each texel's class (${sets}): ${pm.rebuilt ? 'occlusion, roughness, metalness and normal tiled at the set\'s real size' : "the set's mean occlusion, roughness and metalness"}` }
            }
        };
    }
    if (!json.materials.some((m: any) => m.extensions?.KHR_materials_unlit) && Array.isArray(json.extensionsUsed)) {
        json.extensionsUsed = json.extensionsUsed.filter((e: string) => e !== 'KHR_materials_unlit');
        if (!json.extensionsUsed.length) delete json.extensionsUsed;
    }
}

/**
 * The appearance classes as a picture, for a vision model to name them (material-naming.ts) and to choose their library
 * sets by their look (material-choice.ts): one row a class, up to
 * `perClass` patches of the harmonised rebuilt facade photos where that class covers most of the patch (each texel given
 * to its nearest class, as the classes were read), scaled up `zoom` times, on white. The rows follow `classes`' order.
 */
export function classSwatchSheet(json: any, images: Map<number, RgbaImage8>, classes: RegionClass[], opts: { patch?: number; perClass?: number; zoom?: number; seed?: number; /** The parsed GLB: the patches' real size measured (`spanM`). */ g?: ParsedGlb } = {}): { width: number; height: number; rgba: Uint8Array; /** The median real size of a patch, metres (with `g`). */ spanM?: number } | undefined {
    const patch = opts.patch ?? 24, per = opts.perClass ?? 6, zoom = opts.zoom ?? 4, gap = 8;
    const { rebuilt } = photoMaterials(json);
    const texel = new Map<RgbaImage8, number>();
    const photos = [...rebuilt.keys()].map(mi => { const img = images.get(photoOf(json, mi)!.image); if (img && opts.g && !texel.has(img)) texel.set(img, texelMetres(opts.g, json, mi, img)); return img; }).filter((x): x is RgbaImage8 => !!x && x.width > patch && x.height > patch);
    if (!photos.length || !classes.length) return undefined;
    const nearest = (r: number, g: number, b: number) => { const L = labOf(r, g, b); let best = 0, bd = Infinity; classes.forEach((c, k) => { const d = (L[0] - c.meanLab[0]) ** 2 + (L[1] - c.meanLab[1]) ** 2 + (L[2] - c.meanLab[2]) ** 2; if (d < bd) { bd = d; best = k; } }); return best; };
    const found: Array<Array<{ img: RgbaImage8; x: number; y: number }>> = classes.map(() => []);
    const rnd = sampler(opts.seed ?? 11);
    for (let tries = 0; tries < 4000 && found.some(f => f.length < per); tries++) {
        const img = photos[tries % photos.length], x = Math.floor(rnd() * (img.width - patch)), y = Math.floor(rnd() * (img.height - patch));
        const count = new Array<number>(classes.length).fill(0);
        let covered = 0;
        for (let yy = y; yy < y + patch; yy += 2) for (let xx = x; xx < x + patch; xx += 2) { const q = (yy * img.width + xx) * 4; if (!img.rgba[q + 3]) continue; covered++; count[nearest(img.rgba[q], img.rgba[q + 1], img.rgba[q + 2])]++; }
        if (covered < 0.9 * (patch / 2) ** 2) continue;
        const k = count.indexOf(Math.max(...count));
        if (count[k] >= 0.7 * covered && found[k].length < per) found[k].push({ img, x, y });
    }
    const cell = patch * zoom, W = per * (cell + gap) + gap, H = classes.length * (cell + gap) + gap, out = new Uint8Array(W * H * 4).fill(255);
    found.forEach((row, r) => row.forEach((p, c) => {
        for (let y = 0; y < cell; y++) for (let x = 0; x < cell; x++) {
            const sq = ((p.y + Math.floor(y / zoom)) * p.img.width + p.x + Math.floor(x / zoom)) * 4, dq = ((gap + r * (cell + gap) + y) * W + gap + c * (cell + gap) + x) * 4;
            out[dq] = p.img.rgba[sq]; out[dq + 1] = p.img.rgba[sq + 1]; out[dq + 2] = p.img.rgba[sq + 2]; out[dq + 3] = 255;
        }
    }));
    const spans = found.flat().map(p => patch * (texel.get(p.img) ?? 0)).filter(v => v > 0).sort((a, b) => a - b);
    return { width: W, height: H, rgba: out, ...(spans.length ? { spanM: spans[spans.length >> 1] } : {}) };
}

/** One line for the build's notes. */
export function describeMaterialRegions(r: MaterialRegionsReport): string {
    const pct = (a: number) => (r.texels.total ? `${Math.round((100 * a) / r.texels.total)}%` : '0%');
    return `material regions: ${r.classes.length} appearance classes (${r.classes.map((c, k) => `${c.wall ? 'lightest' : 'L ' + Math.round(c.meanLab[0])} -> ${c.set}, ${pct(r.texels.perClass[k] ?? 0)} of texels`).join('; ')}); ` +
        `every texel its class's set: ${r.facades.total} rebuilt facades tiled at the sets' real size, ${r.scanPieces.total} scan pieces the sets' mean finish; ` +
        `occlusion, roughness, metalness and normal generated from the library, colour the photo (${r.ms} ms)`;
}
