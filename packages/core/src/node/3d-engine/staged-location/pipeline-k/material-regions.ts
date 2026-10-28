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
 *  2. Openings, where metal and glass may go, decided per wall face, not per piece (a face's pieces drawn alike):
 *     - the rebuilt facades (metric photos of one plane each) are grouped into wall faces: facing the same way within
 *       faceCos, their planes within faceBandM. A pier rhythm is the column lightness against a running mean repeating at
 *       a bay pitch (NCC), the piers lighter than the bays (contrast), over at least minBays pitches; its weight rises
 *       smoothly from nccLo to minNcc and from contrastLo to minContrast (a soft gate: the bays' metal scaled by it, not cut
 *       at a threshold). Each facade reads it twice: from its own photo, and from its height band on its face (the
 *       coplanar facades overlapping its height by half that show a rhythm of their own, their photos' columns normalised
 *       and laid out along the wall: piers run up a wall, a crown or a ground floor has its own), and takes the surer. The openings are the columns
 *       darker than their local mean, less a facade's rows that are wall most of the way across (photo-inferred);
 *     - the scan pieces are walls too: their vertical triangles clustered by plane the same way (scanWalls), each wall's
 *       columns read from its own texels laid out along it, joined to the faces and height bands of the rebuilt facades
 *       beside it and deciding the same way (its own rhythm, or its band's); a smaller scan piece on a face takes the
 *       decision of the face's facade nearest it; elsewhere on a scan piece, only the photometric relief's recessed
 *       cells (_RELIEF_HEIGHT below recessM, photo-inferred) are openings;
 *     - a rebuilt facade's punched windows: the lattice's window cells (facade-lattice.ts: each row's repeated cells darker
 *       than its wall, in the straightened photo; written in the facade node's extras with the cell lines in the photo's
 *       UVs) are openings at full weight too, where a wall shows windows but no pier rhythm (a masonry base);
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
 * Labels: base colour photo-inferred (the photo, never relit or lifted: it is the evidence of how the building looks);
 * roughness, metalness and normal
 * generated (library sets); glass photo-inferred at the reading's tile-only confidence. Nothing is drawn where no photo is.
 */

import { readAccessor, type ParsedGlb } from '../glb-bytes';
import { SRGB8_TO_LINEAR } from '../../../../common/spatial/photogrammetric-delight';
import { linearRgbToLab } from '../../../../common/spatial/texture-library-index';
import type { RgbaImage8 } from '../tile-texture-transfer';
import { GLASS_ROUGHNESS, MIN_REGION_M2, latticeGlassAgreement } from '../facade-materials';
import { MATERIAL_PARAMS_CHANNELS } from '../staged-glb-writer';

export const MATERIAL_REGIONS_VERSION = 'material-regions/14';

export const MATERIAL_REGIONS_PARAMS = {
    /** Appearance classes, texels sampled per facade photo, k-means iterations, sampling seed. */
    classes: 4, samplesPerPhoto: 40000, iterations: 40, seed: 7,
    /** The pier rhythm a face's photos show: its weight is 0 below nccLo or contrastLo, 1 from minNcc and minContrast. */
    nccLo: 0.35, minNcc: 0.6, contrastLo: 15, minContrast: 30, minBays: 2, pitchM: [2.5, 9] as [number, number], meanWindowM: 12,
    /** Rebuilt facades and scan pieces are one wall face when they face the same way within this cosine and their planes lie within this (m). */
    faceCos: 0.95, faceBandM: 2.0,
    /** A scan wall (scan triangles of one plane) reads its own rhythm from at least this area (m2); smaller pieces only take a face's. */
    minScanWallM2: 25,
    /** A row is wall when this share of it is wall texels. */
    wallRowShare: 0.6,
    /** A scan triangle is an opening when its mean _RELIEF_HEIGHT is below this (m). */
    recessM: -0.1,
    /** Glass candidates in line within this (m), as the facade material reading's tile-only test. */
    glassLineM: 0.3,
    /** A texel counts as metal in the report from this metalness (the bays are drawn part-metal). */
    metalCountAt: 0.2
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
    /** The set's metalness is drawn multiplied by this (a bare metal drawn part metal); 1 when absent. */
    metalnessScale?: number;
    /** Why realSizeM is an estimate, when the set's publisher gives none (labelled generated). */
    realSizeEstimate?: string;
}

export interface MaterialRegionsReport {
    version: string;
    classes: Array<Pick<RegionClass, 'index' | 'meanLab' | 'share' | 'wall'> & { set: string; distance: number; metalnessScale?: number; sizeEstimate?: string }>;
    /** The wall faces, each one rhythm decision for its rebuilt facades and the scan pieces on it. */
    faces: Array<{ facades: string[]; lengthM: number; rhythmNcc: number; pitchM: number; pierContrast: number; weight: number }>;
    facades: { total: number; withOpenings: number; perFacade: Array<{ mesh: string; face: number; /** The lattice's window cells drawn as openings (punched windows). */ windowCells: number; /** The window fit's windows drawn as the facade's openings (window-fit.ts), in place of its bays and window cells. */ fittedWindows: number; /** Whose rhythm decided its bays: its own photo, or its height band on its face. */ rhythmFrom: string; texelM: number; rhythmNcc: number; pitchM: number; pierContrast: number; weight: number; openings: string; openingShare: number; glassRegions: number; glassRejected: number }> };
    /** Scan pieces: the share of their texels that are openings, from a face's bays or from the relief's recesses. */
    scanPieces: { total: number; openingShare: number; fromFaces: number; fromRelief: number; walls: number; wallsWithBays: number; wallAreaWithBaysM2: number };
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

/** A rhythm reading: NCC at the best bay pitch, the piers' contrast, the soft gate's weight, and the bay columns when a pitch was found (drawn only where weight > 0). */
export interface Rhythm { ncc: number; pitchM: number; contrast: number; weight: number; bays?: Uint8Array }

const smoothstep = (lo: number, hi: number, v: number) => { const t = Math.min(1, Math.max(0, (v - lo) / (hi - lo))); return t * t * (3 - 2 * t); };

/** The soft gate: 0 below nccLo or contrastLo, 1 from minNcc and minContrast; 0 without a pitch or minBays pitches of profile. */
function gateWeight(ncc: number, contrast: number, lag: number, W: number, P: MaterialRegionsParams): number {
    return lag > 0 && W >= P.minBays * lag ? smoothstep(P.nccLo, P.minNcc, ncc) * smoothstep(P.contrastLo, P.minContrast, contrast) : 0;
}

/** A column profile less its running mean, over its standard deviation (NaN kept where nothing was seen): photos of one wall made comparable. */
function normalisedColumns(col: Float64Array, stepM: number, P: MaterialRegionsParams): Float64Array {
    const W = col.length, filled = Float64Array.from(col);
    let all = 0, n = 0;
    for (let x = 0; x < W; x++) if (Number.isFinite(col[x])) { all += col[x]; n++; }
    for (let x = 0; x < W; x++) if (!Number.isFinite(col[x])) filled[x] = n ? all / n : 0;
    const local = runningMean(filled, Math.max(3, Math.floor(P.meanWindowM / stepM)));
    let m = 0, s = 0;
    for (let x = 0; x < W; x++) if (Number.isFinite(col[x])) m += (col[x] - local[x]) / n;
    for (let x = 0; x < W; x++) if (Number.isFinite(col[x])) s += (col[x] - local[x] - m) ** 2 / n;
    const sd = Math.sqrt(s) + 1e-6, out = new Float64Array(W);
    for (let x = 0; x < W; x++) out[x] = Number.isFinite(col[x]) ? (col[x] - local[x] - m) / sd : NaN;
    return out;
}

/** The pier rhythm of a column lightness profile at stepM a column (NaN where nothing was seen; see the file comment). */
export function profileRhythm(colIn: ArrayLike<number>, stepM: number, P: MaterialRegionsParams = MATERIAL_REGIONS_PARAMS): Rhythm {
    const W = colIn.length, col = Float64Array.from(colIn);
    let all = 0, n = 0;
    for (let x = 0; x < W; x++) if (Number.isFinite(col[x])) { all += col[x]; n++; }
    const fill = n ? all / n : 0;
    for (let x = 0; x < W; x++) if (!Number.isFinite(col[x])) col[x] = fill;
    const local = runningMean(col, Math.max(3, Math.floor(P.meanWindowM / stepM)));
    const pr = new Float64Array(W);
    let m = 0, s = 0;
    for (let x = 0; x < W; x++) { pr[x] = col[x] - local[x]; m += pr[x] / W; }
    for (let x = 0; x < W; x++) s += (pr[x] - m) ** 2 / W;
    const sd = Math.sqrt(s) + 1e-6;
    for (let x = 0; x < W; x++) pr[x] = (pr[x] - m) / sd;
    let ncc = 0, lag = 0;
    for (let k = Math.max(2, Math.floor(P.pitchM[0] / stepM)); k <= Math.min(Math.floor(W / 2), Math.floor(P.pitchM[1] / stepM)); k++) {
        let c = 0;
        for (let x = 0; x + k < W; x++) c += pr[x] * pr[x + k];
        c /= W - k;
        if (c > ncc) { ncc = c; lag = k; }
    }
    const light: number[] = [], dark: number[] = [];
    for (let x = 0; x < W; x++) { if (pr[x] > 0.5) light.push(col[x]); else if (pr[x] < -0.5) dark.push(col[x]); }
    const contrast = light.length && dark.length ? median(light) - median(dark) : 0;
    const weight = gateWeight(ncc, contrast, lag, W, P);
    const out: Rhythm = { ncc, pitchM: lag * stepM, contrast, weight };
    // the columns darker than their surroundings at whatever weight (a band may lend them its own); none without a pitch
    if (!(lag > 0)) return out;
    const smooth = runningMean(pr, 3), bays = new Uint8Array(W);
    for (let x = 0; x < W; x++) bays[x] = smooth[x] < 0 ? 1 : 0;
    return { ...out, bays };
}

/** One photo's column lightness (mean of its seen texels per column, NaN where none). */
function photoColumns(img: RgbaImage8): Float64Array {
    const { width: W, height: H, rgba } = img;
    const col = new Float64Array(W), cnt = new Float64Array(W);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const p = (y * W + x) * 4;
        if (!rgba[p + 3]) continue;
        col[x] += (rgba[p] + rgba[p + 1] + rgba[p + 2]) / 3; cnt[x]++;
    }
    for (let x = 0; x < W; x++) col[x] = cnt[x] ? col[x] / cnt[x] : NaN;
    return col;
}

/** The pier rhythm of one facade's photo on its own (see the file comment) and, when weight > 0, the bay columns. */
export function pierRhythm(img: RgbaImage8, texelM: number, P: MaterialRegionsParams = MATERIAL_REGIONS_PARAMS): Rhythm {
    return profileRhythm(photoColumns(img), texelM, P);
}

/** A rebuilt facade's frame: its plane (normal, offset), the horizontal along the wall, and its photo's column x -> s map. */
interface FacadeFrame { material: number; mesh: string; cols: Float64Array; texelM: number; n: number[]; offset: number; axis: number[]; a: number; b: number; sMin: number; sMax: number; yMin: number; yMax: number; area: number }

const dot3 = (a: ArrayLike<number>, b: ArrayLike<number>) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
/** The horizontal along a wall facing n (up x n), undefined for a surface facing mostly up or down. */
const alongWall = (n: number[]) => { const x = n[2], z = -n[0], l = Math.hypot(x, z); return Math.abs(n[1]) < 0.7 && l > 0 ? [x / l, 0, z / l] : undefined; };

function facadeFrame(g: ParsedGlb, json: any, material: number, mesh: string, img: RgbaImage8, texelM: number): FacadeFrame | undefined {
    // the cells' normal: the area-weighted normal of the triangles facing within 25 deg of the commonest
    const tris: Array<{ c: number[]; n: number[]; a: number; p: number[]; u: number[] }> = [];
    forEachTriangleOf(g, json, material, (p, uv) => {
        const ux = p[3] - p[0], uy = p[4] - p[1], uz = p[5] - p[2], vx = p[6] - p[0], vy = p[7] - p[1], vz = p[8] - p[2];
        const n = [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx], l = Math.hypot(n[0], n[1], n[2]);
        if (!(l > 0)) return;
        tris.push({ c: [(p[0] + p[3] + p[6]) / 3, (p[1] + p[4] + p[7]) / 3, (p[2] + p[5] + p[8]) / 3], n: n.map(v => v / l), a: l / 2, p: Array.from(p), u: [uv[0], uv[2], uv[4]] });
    });
    if (!tris.length) return undefined;
    const bins = new Map<string, { n: number[]; a: number }>();
    for (const t of tris) { const k = t.n.map(v => Math.round(v * 3)).join(','); const b = bins.get(k) ?? { n: [0, 0, 0], a: 0 }; b.n = b.n.map((v, i) => v + t.n[i] * t.a); b.a += t.a; bins.set(k, b); }
    const top = [...bins.values()].sort((x, y) => y.a - x.a)[0], tl = Math.hypot(top.n[0], top.n[1], top.n[2]);
    const n = top.n.map(v => v / tl), axis = alongWall(n);
    if (!axis) return undefined;
    let off = 0, area = 0, sx = 0, ss = 0, sxx = 0, sxs = 0, cnt = 0, sMin = Infinity, sMax = -Infinity, yMin = Infinity, yMax = -Infinity;
    for (const t of tris) {
        if (dot3(t.n, n) > 0.9) { off += dot3(t.c, n) * t.a; area += t.a; }
        for (let k = 0; k < 3; k++) {
            const pk = [t.p[k * 3], t.p[k * 3 + 1], t.p[k * 3 + 2]], sv = dot3(pk, axis), xv = t.u[k] * img.width;
            sx += xv; ss += sv; sxx += xv * xv; sxs += xv * sv; cnt++;
            sMin = Math.min(sMin, sv); sMax = Math.max(sMax, sv); yMin = Math.min(yMin, pk[1]); yMax = Math.max(yMax, pk[1]);
        }
    }
    const den = cnt * sxx - sx * sx;
    if (!(area > 0) || !(Math.abs(den) > 1e-9)) return undefined;
    // the photo's planar UVs: s = a x + b (least squares over the facade's corners)
    const a = (cnt * sxs - sx * ss) / den, b = (ss - a * sx) / cnt;
    return { material, mesh, cols: photoColumns(img), texelM, n, offset: off / area, axis, a, b, sMin, sMax, yMin, yMax, area };
}

/**
 * The scan pieces' walls: their vertical triangles clustered by plane (facing the same way within faceCos, within faceBandM
 * of the plane), each wall at least minScanWallM2, a frame like a rebuilt facade's whose columns are read from the texels
 * laid out along the wall (x the column at texelM along it, from sMin). `cluster` gives each triangle's wall (in
 * forEachTriangleOf order per material, -1 for none). A wall's frame key is -1 - its index.
 */
function scanWalls(g: ParsedGlb, json: any, materials: number[], images: Map<number, RgbaImage8>, P: MaterialRegionsParams): { frames: FacadeFrame[]; cluster: Map<number, Int32Array> } {
    const walls: Array<{ nSum: number[]; offSum: number; area: number; n: number[]; offset: number }> = [];
    const cluster = new Map<number, Int32Array>(), texel = new Map<number, number>();
    for (const mi of materials) {
        const img = images.get(photoOf(json, mi)!.image);
        if (!img) continue;
        texel.set(mi, texelMetres(g, json, mi, img));
        const ids: number[] = [];
        forEachTriangleOf(g, json, mi, p => {
            const ux = p[3] - p[0], uy = p[4] - p[1], uz = p[5] - p[2], vx = p[6] - p[0], vy = p[7] - p[1], vz = p[8] - p[2];
            const nn = [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx], l = Math.hypot(nn[0], nn[1], nn[2]);
            if (!(l > 0) || Math.abs(nn[1] / l) >= 0.7) { ids.push(-1); return; }
            const n = nn.map(v => v / l), c = [(p[0] + p[3] + p[6]) / 3, (p[1] + p[4] + p[7]) / 3, (p[2] + p[5] + p[8]) / 3], a = l / 2;
            let id = walls.findIndex(w => dot3(w.n, n) >= P.faceCos && Math.abs(dot3(c, w.n) - w.offset) <= P.faceBandM);
            if (id < 0) { id = walls.length; walls.push({ nSum: [0, 0, 0], offSum: 0, area: 0, n, offset: dot3(c, n) }); }
            const w = walls[id];
            w.nSum = w.nSum.map((v, i) => v + n[i] * a); w.area += a;
            const nl = Math.hypot(w.nSum[0], w.nSum[1], w.nSum[2]); w.n = w.nSum.map(v => v / nl);
            w.offSum += dot3(c, n) * a; w.offset = w.offSum / w.area;
            ids.push(id);
        });
        cluster.set(mi, Int32Array.from(ids));
    }
    // each wall's extent, and its column profile from its texels along the wall
    const ext = walls.map(w => ({ axis: alongWall(w.n), sMin: Infinity, sMax: -Infinity, yMin: Infinity, yMax: -Infinity, step: Infinity }));
    for (const mi of materials) {
        const ids = cluster.get(mi);
        if (!ids) continue;
        let t = 0;
        forEachTriangleOf(g, json, mi, p => {
            const id = ids[t++];
            if (id < 0 || walls[id].area < P.minScanWallM2 || !ext[id].axis) return;
            const e = ext[id], axis = e.axis!;
            for (let k = 0; k < 3; k++) { const sv = dot3([p[k * 3], p[k * 3 + 1], p[k * 3 + 2]], axis); e.sMin = Math.min(e.sMin, sv); e.sMax = Math.max(e.sMax, sv); e.yMin = Math.min(e.yMin, p[k * 3 + 1]); e.yMax = Math.max(e.yMax, p[k * 3 + 1]); }
            e.step = Math.min(e.step, Math.max(0.05, texel.get(mi) ?? Infinity));
        });
    }
    const sums = ext.map(e => (Number.isFinite(e.step) ? { sum: new Float64Array(Math.ceil((e.sMax - e.sMin) / e.step) + 1), cnt: new Float64Array(Math.ceil((e.sMax - e.sMin) / e.step) + 1) } : undefined));
    for (const mi of materials) {
        const ids = cluster.get(mi), img = images.get(photoOf(json, mi)!.image);
        if (!ids || !img) continue;
        const { width: W, height: H, rgba } = img;
        let t = 0;
        forEachTriangleOf(g, json, mi, (p, uv) => {
            const id = ids[t++], acc = id >= 0 ? sums[id] : undefined;
            if (!acc || walls[id].area < P.minScanWallM2 || !ext[id].axis) return;
            const e = ext[id], axis = e.axis!;
            const sa = dot3([p[0], p[1], p[2]], axis), sb = dot3([p[3], p[4], p[5]], axis), sc = dot3([p[6], p[7], p[8]], axis);
            forTexelsOf(uv, W, H, (k, wa, wb, wc) => {
                if (!rgba[k * 4 + 3]) return;
                const bin = Math.floor((wa * sa + wb * sb + wc * sc - e.sMin) / e.step);
                if (bin >= 0 && bin < acc.sum.length) { acc.sum[bin] += (rgba[k * 4] + rgba[k * 4 + 1] + rgba[k * 4 + 2]) / 3; acc.cnt[bin]++; }
            });
        });
    }
    const frames: FacadeFrame[] = [];
    walls.forEach((w, id) => {
        const e = ext[id], acc = sums[id];
        if (!acc || w.area < P.minScanWallM2 || !e.axis) return;
        frames.push({
            material: -1 - id, mesh: `scan_wall_${id}`, cols: Float64Array.from(acc.sum, (v, i) => (acc.cnt[i] ? v / acc.cnt[i] : NaN)), texelM: e.step,
            n: w.n, offset: w.offset, axis: e.axis, a: e.step, b: e.sMin, sMin: e.sMin, sMax: e.sMax, yMin: e.yMin, yMax: e.yMax, area: w.area
        });
    });
    return { frames, cluster };
}

/** Visits a triangle's texels (UVs 0..1 on a W x H image) with each texel's barycentric weights. */
function forTexelsOf(uv: ArrayLike<number>, W: number, H: number, visit: (k: number, wa: number, wb: number, wc: number) => void): void {
    const ax = uv[0] * W, ay = uv[1] * H, bx = uv[2] * W, by = uv[3] * H, cx = uv[4] * W, cy = uv[5] * H;
    const den = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy);
    if (Math.abs(den) < 1e-12) return;
    const x0 = Math.max(0, Math.floor(Math.min(ax, bx, cx))), x1 = Math.min(W - 1, Math.ceil(Math.max(ax, bx, cx)));
    const y0 = Math.max(0, Math.floor(Math.min(ay, by, cy))), y1 = Math.min(H - 1, Math.ceil(Math.max(ay, by, cy)));
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
        const px = x + 0.5, py = y + 0.5;
        const wa = ((by - cy) * (px - cx) + (cx - bx) * (py - cy)) / den, wb = ((cy - ay) * (px - cx) + (ax - cx) * (py - cy)) / den, wc = 1 - wa - wb;
        if (wa >= 0 && wb >= 0 && wc >= 0) visit(y * W + x, wa, wb, wc);
    }
}

/** A rebuilt facade's fitted windows (window-fit.ts), u0 v0 u1 v1 per window, as facade-lattice.ts wrote them (sbFacadeLattice.windows). */
function fittedWindows(json: any, meshName: string): number[] | undefined {
    const mi = (json.meshes ?? []).findIndex((m: any) => m.name === meshName);
    const uv = (json.nodes ?? []).find((n: any) => n.mesh === mi && n.extras?.sbFacadeLattice?.windows)?.extras.sbFacadeLattice.windows.uv;
    return Array.isArray(uv) && uv.length % 4 === 0 ? uv : undefined;
}

/** A rebuilt facade's window cells, as facade-lattice.ts wrote them in its node's extras (sbFacadeLattice.windowCells). */
function latticeWindows(json: any, meshName: string): { u: number[]; v: number[]; cells: number[] } | undefined {
    const mi = (json.meshes ?? []).findIndex((m: any) => m.name === meshName);
    const node = (json.nodes ?? []).find((n: any) => n.mesh === mi && n.extras?.sbFacadeLattice?.windowCells);
    const wc = node?.extras.sbFacadeLattice.windowCells;
    return wc && Array.isArray(wc.u) && Array.isArray(wc.v) && Array.isArray(wc.cells) && wc.u.length > 1 && wc.v.length > 1 ? wc : undefined;
}

/** One facade's bay decision: its rhythm (its own, or its height band's on its face, whichever is surer) and its bay columns along the wall. */
interface BayDecision { from: 'own' | 'band'; rhythm: Rhythm; bayAt: (s: number) => boolean }

/** A wall face: its rebuilt facades' frames (one plane) and each frame's bay decision. */
interface WallFace { frames: FacadeFrame[]; n: number[]; offset: number; axis: number[]; sMin: number; sMax: number; yMin: number; yMax: number; decisions: Map<number, BayDecision> }

/** Two height ranges overlap by at least half the shorter. */
const sameBand = (a: FacadeFrame, b: FacadeFrame) => Math.min(a.yMax, b.yMax) - Math.max(a.yMin, b.yMin) >= 0.5 * Math.min(a.yMax - a.yMin, b.yMax - b.yMin);

function wallFaces(frames: FacadeFrame[], P: MaterialRegionsParams): WallFace[] {
    const groups: FacadeFrame[][] = [];
    for (const f of [...frames].sort((x, y) => y.area - x.area)) {
        const g = groups.find(q => dot3(q[0].n, f.n) >= P.faceCos && Math.abs(f.offset - q[0].offset) <= P.faceBandM);
        if (g) g.push(f); else groups.push([f]);
    }
    const own = new Map<FacadeFrame, { rhythm: Rhythm; norm: Float64Array }>();
    for (const f of frames) own.set(f, { rhythm: profileRhythm(f.cols, f.texelM, P), norm: normalisedColumns(f.cols, f.texelM, P) });
    return groups.map(fr => {
        const lead = fr[0], decisions = new Map<number, BayDecision>();
        for (const f of fr) {
            // its height band on this face: the coplanar facades its height range overlaps (piers run up a wall, not across its
            // bands). Only those with a rhythm of their own vote: one without (a weathered or unstraightened scan wall) only borrows
            const band = fr.filter(o => (o === f || sameBand(f, o)) && own.get(o)!.rhythm.weight > 0);
            if (!band.length) { const mine = own.get(f)!.rhythm; decisions.set(f.material, { from: 'own', rhythm: mine, bayAt: () => false }); continue; }
            const stepM = Math.min(...band.map(o => o.texelM)), s0 = Math.min(...band.map(o => o.sMin)), s1 = Math.max(...band.map(o => o.sMax));
            const nBins = Math.max(1, Math.ceil((s1 - s0) / stepM) + 1), sum = new Float64Array(nBins), cnt = new Float64Array(nBins);
            for (const o of band) {
                const norm = own.get(o)!.norm;
                for (let x = 0; x < norm.length; x++) {
                    if (!Number.isFinite(norm[x])) continue;
                    const bin = Math.floor((o.a * (x + 0.5) + o.b - s0) / stepM);
                    if (bin >= 0 && bin < nBins) { sum[bin] += norm[x]; cnt[bin]++; }
                }
            }
            const shared = profileRhythm(Array.from(sum, (v, i) => (cnt[i] ? v / cnt[i] : NaN)), stepM, P);
            // the band's contrast: its photos' own, by area (the shared profile is normalised, so it has no lightness units)
            const area = band.reduce((t, o) => t + o.area, 0), contrast = band.reduce((t, o) => t + own.get(o)!.rhythm.contrast * o.area, 0) / area;
            const bandWeight = gateWeight(shared.ncc, contrast, Math.round(shared.pitchM / stepM), nBins, P);
            const mine = own.get(f)!.rhythm;
            if (mine.weight >= bandWeight) {
                const bays = mine.bays, w = f.cols.length;
                decisions.set(f.material, { from: 'own', rhythm: mine, bayAt: sv => { const x = Math.floor((sv - f.b) / f.a); return !!bays && x >= 0 && x < w && bays[x] === 1; } });
            } else {
                const bays = shared.bays;
                decisions.set(f.material, { from: 'band', rhythm: { ...shared, contrast, weight: bandWeight }, bayAt: sv => { const bin = Math.floor((sv - s0) / stepM); return !!bays && bin >= 0 && bin < nBins && bays[bin] === 1; } });
            }
        }
        return { frames: fr, n: lead.n, offset: lead.offset, axis: lead.axis, sMin: Math.min(...fr.map(f => f.sMin)), sMax: Math.max(...fr.map(f => f.sMax)), yMin: Math.min(...fr.map(f => f.yMin)), yMax: Math.max(...fr.map(f => f.yMax)), decisions };
    });
}

/** The facade of a face nearest a point on it (by height, then along the wall): whose bay decision a scan piece there takes. */
function frameAt(face: WallFace, sv: number, y: number): FacadeFrame {
    const d = (f: FacadeFrame) => Math.max(0, f.yMin - y, y - f.yMax) * 10 + Math.max(0, f.sMin - sv, sv - f.sMax);
    return face.frames.reduce((best, f) => (d(f) < d(best) ? f : best), face.frames[0]);
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
        classes: classes.map((c, k) => ({ index: c.index, meanLab: c.meanLab, share: c.share, wall: c.wall, set: sets[k].name, distance: Math.round(sets[k].distance * 100) / 100, ...(sets[k].metalnessScale !== undefined ? { metalnessScale: Math.round(sets[k].metalnessScale! * 1000) / 1000 } : {}), ...(sets[k].realSizeEstimate ? { sizeEstimate: sets[k].realSizeEstimate } : {}) })),
        faces: [], facades: { total: rebuilt.size, withOpenings: 0, perFacade: [] }, scanPieces: { total: other.size, openingShare: 0, fromFaces: 0, fromRelief: 0, walls: 0, wallsWithBays: 0, wallAreaWithBaysM2: 0 }, texels: { total: 0, metal: 0, glass: 0 }, ms: 0
    };
    const setMeans = sets.map(s => meanOf(s.orm));
    const metalScale = sets.map(s => s.metalnessScale ?? 1);
    const done = new Set<number>();
    const write = (orm: RgbaImage8, params: RgbaImage8, k: number, r: number, m: number, glassWeight: number) => {
        orm.rgba[k * 4] = 255; orm.rgba[k * 4 + 1] = Math.round(r * 255); orm.rgba[k * 4 + 2] = Math.round(m * 255); orm.rgba[k * 4 + 3] = 255;
        params.rgba[k * 4] = glassWeight; params.rgba[k * 4 + 2] = Math.round(m * 255); params.rgba[k * 4 + 3] = 255;
        report.texels.total++;
        if (glassWeight) report.texels.glass++; else if (m >= P.metalCountAt) report.texels.metal++;
    };

    // ---- wall faces: the rebuilt facades grouped by plane, one rhythm each ----
    const frames: FacadeFrame[] = [];
    for (const [mi, mesh] of rebuilt) {
        const photo = photoOf(json, mi)!, img = images.get(photo.image);
        if (!img || frames.some(f => photoOf(json, f.material)?.image === photo.image)) continue;
        const texelM = texelMetres(g, json, mi, img);
        const fr = texelM > 0 ? facadeFrame(g, json, mi, mesh, img, texelM) : undefined;
        if (fr) frames.push(fr);
    }
    const scan = scanWalls(g, json, [...other], images, P);
    const faces = wallFaces([...frames, ...scan.frames], P);
    const faceOf = new Map<number, number>();
    faces.forEach((f, i) => { for (const fr of f.frames) faceOf.set(fr.material, i); });
    report.scanPieces.walls = scan.frames.length;
    for (const fr of scan.frames) {
        const d = faces[faceOf.get(fr.material)!].decisions.get(fr.material)!;
        if (d.rhythm.weight > 0) { report.scanPieces.wallsWithBays++; report.scanPieces.wallAreaWithBaysM2 += Math.round(fr.area); }
    }
    const r2 = (v: number) => Math.round(v * 100) / 100;
    report.faces = faces.map(f => {
        // the face's surest decision
        const best = [...f.decisions.values()].reduce((x, y) => (y.rhythm.weight > x.rhythm.weight ? y : x));
        return { facades: f.frames.map(fr => fr.mesh), lengthM: Math.round(f.sMax - f.sMin), rhythmNcc: r2(best.rhythm.ncc), pitchM: r2(best.rhythm.pitchM), pierContrast: Math.round(best.rhythm.contrast * 10) / 10, weight: r2(best.rhythm.weight) };
    });

    // ---- rebuilt facades ----
    for (const [mi, mesh] of rebuilt) {
        const photo = photoOf(json, mi)!, img = images.get(photo.image);
        if (!img || done.has(photo.image)) continue;
        done.add(photo.image);
        const { width: W, height: H } = img, N = W * H;
        const fi = faceOf.get(mi), face = fi !== undefined ? faces[fi] : undefined, frame = face?.frames.find(f => f.material === mi);
        const texelM = frame?.texelM ?? texelMetres(g, json, mi, img);
        if (!(texelM > 0)) continue;
        const cls = classify(img, classes);
        // the face's rhythm, its bay columns where this photo lies along the wall
        const decision = face?.decisions.get(mi);
        const rhythm: Rhythm = decision ? decision.rhythm : { ncc: 0, pitchM: 0, contrast: 0, weight: 0 };
        const bayCol = new Uint8Array(W);
        if (decision && frame) for (let x = 0; x < W; x++) bayCol[x] = decision.bayAt(frame.a * (x + 0.5) + frame.b) ? 1 : 0;
        // the window fit's windows, where the facade has them: they are its openings, bays and punched windows alike
        const fitted = fittedWindows(json, mesh);
        const w = fitted ? 0 : rhythm.weight;
        // per texel: an opening's weight (its bay column's rhythm weight, or 1 in a fitted window or a lattice window cell), 0 for wall
        const opening = new Uint8Array(N), openWeight = new Float32Array(N);
        let windowTexels = 0;
        if (fitted) for (let i = 0; i < fitted.length; i += 4) {
            const x0 = Math.max(0, Math.round(fitted[i] * W)), x1 = Math.min(W, Math.round(fitted[i + 2] * W));
            const y0 = Math.max(0, Math.round(fitted[i + 1] * H)), y1 = Math.min(H, Math.round(fitted[i + 3] * H));
            for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { const k = y * W + x; if (!opening[k]) windowTexels++; opening[k] = 1; openWeight[k] = 1; }
        }
        if (w > 0) {
            for (let y = 0; y < H; y++) {
                let wall = 0;
                for (let x = 0; x < W; x++) if (cls[y * W + x] === WALL) wall++;
                if (wall / W > P.wallRowShare) continue;
                for (let x = 0; x < W; x++) if (bayCol[x]) { opening[y * W + x] = 1; openWeight[y * W + x] = w; }
            }
        }
        // the punched windows the lattice found in the straightened photo (its window cells, in the photo's UVs)
        const windows = fitted ? undefined : latticeWindows(json, mesh);
        if (windows) {
            const ns = windows.u.length - 1;
            for (const c of windows.cells) {
                const a = c % ns, b = Math.floor(c / ns);
                if (b + 1 >= windows.v.length) continue;
                const x0 = Math.max(0, Math.round(Math.min(windows.u[a], windows.u[a + 1]) * W)), x1 = Math.min(W, Math.round(Math.max(windows.u[a], windows.u[a + 1]) * W));
                const y0 = Math.max(0, Math.round(Math.min(windows.v[b], windows.v[b + 1]) * H)), y1 = Math.min(H, Math.round(Math.max(windows.v[b], windows.v[b + 1]) * H));
                for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { const k = y * W + x; if (!opening[k]) windowTexels++; opening[k] = 1; openWeight[k] = 1; }
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
            write(orm, params, k, t.o[j + 1], Math.min(1, t.o[j + 2] * metalScale[finish[k]]) * (opening[k] ? openWeight[k] : 1), 0);
            nrm.rgba.set([Math.round(t.n[j] * 255), Math.round(t.n[j + 1] * 255), Math.round(t.n[j + 2] * 255), 255], k * 4);
        }
        let openN = 0;
        for (let k = 0; k < N; k++) openN += opening[k];
        if (w > 0 || windowTexels) report.facades.withOpenings++;
        report.facades.perFacade.push({
            mesh, face: fi ?? -1, rhythmFrom: decision?.from ?? 'none', texelM: Math.round(texelM * 1e4) / 1e4, rhythmNcc: r2(rhythm.ncc), pitchM: r2(rhythm.pitchM), pierContrast: Math.round(rhythm.contrast * 10) / 10, weight: r2(w),
            windowCells: windows?.cells.length ?? 0, fittedWindows: fitted ? fitted.length / 4 : 0,
            openings: fitted ? `${fitted.length / 4} windows from the window fit` : [w > 0 ? `bays between the piers of its wall face (weight ${r2(w)})` : '', windows?.cells.length ? `${windows.cells.length} punched windows from the lattice` : ''].filter(Boolean).join('; ') || 'none: no confirmed pier rhythm on its wall face and no window cells', openingShare: Math.round((openN / N) * 1000) / 1000, glassRegions: accepted, glassRejected: rejected
        });
        planned.push({ material: mi, orm, normal: nrm, params, ...(accepted ? { photoFallback: fallback } : {}), rebuilt: true, glass: accepted > 0 });
    }

    // ---- scan pieces: wall finish, a face's bays where the piece lies on that face, else the relief's recessed cells ----
    let fromFaces = 0, fromRelief = 0, scanTexels = 0;
    for (const mi of other) {
        const photo = photoOf(json, mi)!, img = images.get(photo.image);
        if (!img || done.has(photo.image)) continue;
        done.add(photo.image);
        const { width: W, height: H } = img, N = W * H;
        // per texel: the opening's weight (the face's, or 1 on a relief recess), 0 for wall
        const opening = new Float32Array(N), byFace = new Uint8Array(N);
        const ids = scan.cluster.get(mi);
        let tri = 0;
        forEachTriangleOf(g, json, mi, (p, uv, relief) => {
            const wall = ids ? ids[tri++] : -1;
            if (relief !== undefined && relief < P.recessM) {
                rasterTriangle(uv[0] * W, uv[1] * H, uv[2] * W, uv[3] * H, uv[4] * W, uv[5] * H, W, H, k => { opening[k] = 1; byFace[k] = 0; });
                return;
            }
            const ux = p[3] - p[0], uy = p[4] - p[1], uz = p[5] - p[2], vx = p[6] - p[0], vy = p[7] - p[1], vz = p[8] - p[2];
            const nn = [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx], nl = Math.hypot(nn[0], nn[1], nn[2]);
            if (!(nl > 0)) return;
            const n = nn.map(v => v / nl), c = [(p[0] + p[3] + p[6]) / 3, (p[1] + p[4] + p[7]) / 3, (p[2] + p[5] + p[8]) / 3];
            // a triangle of a scan wall: that wall's own decision (its rhythm, or its height band's on its face)
            const own = wall >= 0 ? faceOf.get(-1 - wall) : undefined;
            if (own !== undefined) {
                const decision = faces[own].decisions.get(-1 - wall)!, frame = faces[own].frames.find(f => f.material === -1 - wall)!;
                if (!(decision.rhythm.weight > 0)) return;
                const sa = dot3([p[0], p[1], p[2]], frame.axis), sb = dot3([p[3], p[4], p[5]], frame.axis), sc = dot3([p[6], p[7], p[8]], frame.axis);
                forTexelsOf(uv, W, H, (k, wa, wb, wc) => {
                    if (opening[k] === 1 && !byFace[k]) return;
                    if (decision.bayAt(wa * sa + wb * sb + wc * sc)) { opening[k] = decision.rhythm.weight; byFace[k] = 1; }
                });
                return;
            }
            const face = faces.find(f => dot3(n, f.n) >= P.faceCos && Math.abs(dot3(c, f.n) - f.offset) <= P.faceBandM &&
                dot3(c, f.axis) >= f.sMin && dot3(c, f.axis) <= f.sMax && c[1] >= f.yMin - P.faceBandM && c[1] <= f.yMax + P.faceBandM);
            if (!face) return;
            // the decision of the face's facade at this height and place along the wall
            const decision = face.decisions.get(frameAt(face, dot3(c, face.axis), c[1]).material)!;
            if (!(decision.rhythm.weight > 0)) return;
            // each texel's place along the wall, from its barycentric position in the triangle
            const sa = dot3([p[0], p[1], p[2]], face.axis), sb = dot3([p[3], p[4], p[5]], face.axis), sc = dot3([p[6], p[7], p[8]], face.axis);
            const ax = uv[0] * W, ay = uv[1] * H, bx = uv[2] * W, by = uv[3] * H, cx = uv[4] * W, cy = uv[5] * H;
            const den = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy);
            if (Math.abs(den) < 1e-12) return;
            const x0 = Math.max(0, Math.floor(Math.min(ax, bx, cx))), x1 = Math.min(W - 1, Math.ceil(Math.max(ax, bx, cx)));
            const y0 = Math.max(0, Math.floor(Math.min(ay, by, cy))), y1 = Math.min(H - 1, Math.ceil(Math.max(ay, by, cy)));
            for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
                const px = x + 0.5, py = y + 0.5;
                const wa = ((by - cy) * (px - cx) + (cx - bx) * (py - cy)) / den, wb = ((cy - ay) * (px - cx) + (ax - cx) * (py - cy)) / den, wc = 1 - wa - wb;
                if (wa < 0 || wb < 0 || wc < 0) continue;
                const k = y * W + x;
                if (opening[k] === 1 && !byFace[k]) continue;
                if (decision.bayAt(wa * sa + wb * sb + wc * sc)) { opening[k] = decision.rhythm.weight; byFace[k] = 1; }
            }
        });
        const mask = new Uint8Array(N);
        for (let k = 0; k < N; k++) mask[k] = opening[k] > 0 ? 1 : 0;
        const cls = classify(img, classes, mask);
        const orm = blank(W, H), params = blank(W, H);
        for (let k = 0; k < N; k++) {
            const c = mask[k] ? cls[k] : WALL;
            write(orm, params, k, setMeans[c][1], Math.min(1, setMeans[c][2] * metalScale[c]) * (mask[k] ? opening[k] : 1), 0);
            if (mask[k]) { if (byFace[k]) fromFaces++; else fromRelief++; }
        }
        scanTexels += N;
        planned.push({ material: mi, orm, params, rebuilt: false, glass: false });
    }
    const share = (v: number) => (scanTexels ? Math.round((v / scanTexels) * 1e4) / 1e4 : 0);
    report.scanPieces.openingShare = share(fromFaces + fromRelief); report.scanPieces.fromFaces = share(fromFaces); report.scanPieces.fromRelief = share(fromRelief);
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
                roughnessMetalness: { label: 'generated', source: `texture library sets per appearance class (${plan.sets.map(s => s.metalnessScale !== undefined ? `${s.name}, metalness x ${Math.round(s.metalnessScale * 100) / 100}` : s.name).join('; ')}); metal only in ${pm.rebuilt ? "the bays between the piers of its wall face, scaled by the face's rhythm weight" : "its wall face's bays where it lies on one, else the photometric relief's recessed cells (photo-inferred)"}` },
                ...(pm.normal ? { normal: { label: 'generated', source: 'the same sets tiled at their real size' } } : {}),
                ...(plan.sets.some(s => s.realSizeEstimate) ? { tileSize: { label: 'generated', source: plan.sets.filter(s => s.realSizeEstimate).map(s => `${s.name}: ${s.realSizeEstimate}`).join('; ') } } : {}),
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
        `${r.faces.length} wall faces, ${r.faces.filter(f => f.weight > 0).length} with a pier rhythm (${r.facades.withOpenings} of ${r.facades.total} rebuilt facades got openings: bays, the metal scaled by their face's weight, ${r.facades.perFacade.reduce((a, f) => a + f.windowCells, 0)} punched windows from the lattice, and ${r.facades.perFacade.filter(f => f.fittedWindows).length} facades opened at their ${r.facades.perFacade.reduce((a, f) => a + f.fittedWindows, 0)} fitted windows instead); ` +
        `scan pieces: ${r.scanPieces.wallsWithBays} of ${r.scanPieces.walls} scan walls with bays (${r.scanPieces.wallAreaWithBaysM2} m²), ${Math.round(r.scanPieces.fromFaces * 1000) / 10}% of their texels in bays, ${Math.round(r.scanPieces.fromRelief * 1000) / 10}% on the relief's recessed cells; ` +
        `${pct(r.texels.metal)} of texels metal (metalness at least ${MATERIAL_REGIONS_PARAMS.metalCountAt}), ${pct(r.texels.glass)} glass (${r.facades.perFacade.reduce((a, f) => a + f.glassRegions, 0)} regions accepted by the lattice test, ${r.facades.perFacade.reduce((a, f) => a + f.glassRejected, 0)} rejected); ` +
        `roughness, metalness and normal generated from the library, colour the photo (${r.ms} ms)`;
}
