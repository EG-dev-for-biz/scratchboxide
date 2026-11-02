/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Pipeline K's view-space relight: the twin's photos evened out by an image model that sees the building, not its UV charts.
 *
 * texture-lighting.ts sends atlas charts to the model one by one; a chart is a fragment with no context, so the model cannot
 * tell a shadow from a dark material, and each chart comes back exposed on its own (on the Washington Square Arch 29 of 57
 * passed the detail lock and the layer never passed its gate). Here the model is shown the building:
 *
 *  1. Views: the twin rendered unlit (each texel its photo's colour, no shading of ours) in orthographic directions
 *     (`azimuths` level ones, `obliqueAzimuths` looking down `obliqueDownDeg`, and one from above), each direction cut into
 *     square tiles of `tileM` metres at `tilePx` pixels with `overlap`. A tile showing too little of the building is not sent.
 *     The render is the mesh itself, so its mask, depth and normals are exact (no misregistered sky band).
 *  2. Each tile through texture-lighting.ts's lightingCorrectImage (Nano Banana Lite by default, the `plain-detailed` prompt,
 *     the detail lock). The model's pixels are never used: its answer gives a smooth gain field, computed again per facing
 *     (`gainField` masked to the pixels of each compass facing, up and down), so the blur never mixes two walls at a corner.
 *  3. Exposure between tiles: the model exposes each tile its own way, so each tile gets one log offset per channel, solved
 *     on `offsetSamples` area-weighted surface points seen by several tiles (alternating least squares, a weak pull to zero,
 *     the tiles' mean offset held at zero). The spread of the tiles' estimates at those points is reported before and after.
 *  4. Back to the texels: on a grid every `sampleStride` texels of each photo, every triangle's samples (their 3D point by
 *     barycentrics in UV) are projected into every tile that faces them (`facingMinCos`) and sees them (a depth grid with
 *     `depthTolM`); the tiles' offset log gains are averaged, weighted by facing, the tile's lock confidence and a feather
 *     at the tile's border. Cells no tile saw take their neighbours' gain. The building's mean log gain per channel is
 *     taken out (the mean tone stays; harmonising follows), and the gain is bounded by `maxGainLog`.
 *  5. Applied only when enough tiles passed the lock, enough of the surface was seen and the tiles agree after their
 *     offsets; the photos are multiplied by the gain in linear light, bilinear from the grid. Otherwise nothing changes, and
 *     the report says why.
 *
 * Only a smooth gain is applied: no texel is moved or drawn. The colour stays the photo's (photo-inferred); the gain is the
 * model's estimate. Off by default (SCRATCHBOX_K_VIEW_RELIGHT=1 on). Measured on the Empire State Building's K twin
 * (2026-10-29, runs 60b4a8be on / 2e5525cf off, same remesh; docs/processes/pipeline_k_view_relight_esb.md): Nano Banana
 * Lite, 204 of 204 views through the lock, tiles' spread 1.153x -> 1.048x after their offsets, 145 s; but its gain is a
 * height trend (the crown brighter, the lower setbacks darker: the lowest 60 m against 60-120 m 0.74 -> 0.73), and the
 * seams between photos got further apart (0.1517 -> 0.1558 before harmonising, 0.1263 -> 0.1279 after). With the anchor
 * (view-relight/2, run 1130be00) the trend is gone and the canyon moves the right way (final twin 0.714 -> 0.726), but the
 * seams still part (0.1263 -> 0.1279 after harmonising); the full Nano Banana (run 1eb26be0) is worse on both (0.683, 0.1300).
 * The seam gate reverts all three on this building. SCRATCHBOX_TEXTURE_LIGHTING_DUMP=<dir> writes each
 * tile's original, answer and corrected image (texture-lighting.ts).
 */

import { readAccessor, type ParsedGlb } from '../glb-bytes';
import { SRGB8_TO_LINEAR, linearToSrgb255 } from '../../../../common/spatial/photogrammetric-delight';
import type { RgbaImage8 } from '../tile-texture-transfer';
import { resizeRgba, type EnhanceModelClient } from '../texture-enhance';
import { fieldAt, gainField, lightingCorrectImage, mapConcurrent, LIGHTING_MAX_SIDE, type LightingImageRecord, type LightingLockResult } from '../texture-lighting';
import { TEXEL_NONE } from './texture-harmonize';
import { blur1 } from '../../../spatial/StreetViewStage3Metrics';

export const VIEW_RELIGHT_VERSION = 'view-relight/2';

export const VIEW_RELIGHT_PARAMS = {
    /** A tile's side (m) and pixels (square, at most LIGHTING_MAX_SIDE), and the share of a tile its neighbour overlaps. */
    tileM: 80, tilePx: 1024, overlap: 0.25,
    /** Level directions, oblique directions (between the level ones) and their downward angle, and one from above. */
    azimuths: 8, obliqueAzimuths: 4, obliqueDownDeg: 40, nadir: true,
    /** A tile is sent when at least this share of it is the building's photo. */
    minCoverage: 0.08,
    /** A surface seen more edge-on than this (|cos| to the view) takes nothing from the view. */
    facingMinCos: 0.25,
    /** A facing's own field is computed when it holds this share of the tile's photo pixels (and minBinPx); a normal steeper than |y| flatNy is up or down. */
    minBinShare: 0.02, minBinPx: 2000, flatNy: 0.7,
    /** The depth grid's cells a side, and how far behind its front surface a point may sit and still be seen (m). */
    depthGrid: 256, depthTolM: 1.5,
    /** The anchor: each facing's field loses its component at this scale and above (m; 0 keeps it), so the model moves only the
     *  blotches it sees within a frame and never a building-scale trend (it exposes a tile by its framing). */
    anchorM: 25,
    /** The seam measure (texture-harmonize.ts's): surface samples, the patch cell (m) and facings; the relight is kept only
     *  when the photos' mean patch difference falls (gate: false measures without reverting). */
    seamSamples: 400000, seamM: 1.5, seamFacingBins: 12, gate: true,
    /** The share of a tile's side its weight feathers over at the border. */
    featherShare: 0.1,
    /** The tile offset solve: points, iterations, the pull to zero (as a share of a tile's mean observation weight). */
    offsetSamples: 60000, offsetIters: 30, offsetPrior: 0.1,
    /** The gain grid: one cell every this many texels; empty cells filled from neighbours for at most fillIters passes. */
    sampleStride: 4, fillIters: 48,
    /** The gain's bound (natural log, per channel). */
    maxGainLog: Math.log(3),
    /** Gates: share of the tiles sent that passed the lock, share of the surface samples seen, tiles' spread after offsets (log luminance). */
    minAcceptedShare: 0.5, minSeenShare: 0.5, maxSpreadLog: Math.log(1.3),
    /** Model calls in flight, and directions rendered at once. */
    concurrency: 16, directionsAtOnce: 2,
    /** Pixels no photo covers, sent to the model (a light overcast grey). */
    background: [198, 203, 209] as [number, number, number]
};
export type ViewRelightParams = typeof VIEW_RELIGHT_PARAMS;

export interface ViewRelightReport {
    applied: boolean;
    why: string;
    directions: number;
    tiles: { planned: number; empty: number; sent: number; accepted: number; rejected: number; failed: number };
    models: string[];
    /** Surface samples (the gain grid's cells on triangles) and the share some tile saw. */
    samples: number; seenShare: number;
    /** Median spread (weighted std of log luminance) of the tiles' estimates at points two directions see, before and after the offsets. */
    spreadBefore: number | null; spreadAfter: number | null;
    /** The applied gain's 5th and 95th percentile (luminance, linear). */
    gainP5: number; gainP95: number;
    /** Wall luminance of the lowest 60 m against 60-120 m above the ground, before and after (the street canyon's darkening). */
    canyonRatioBefore: number | null; canyonRatioAfter: number | null;
    /** The anchor scale used (m; 0: none), and the photos' mean seam patch difference (log colour) before and after. */
    anchorM: number; seams: { pairs: number; before: number; after: number } | null;
    ms: number;
    records: LightingImageRecord[];
}

/** Every triangle of the GLB: corners, UVs, its photo (-1 untextured) and unit normal. */
export interface Soup { P: Float32Array; UV: Float32Array; img: Int32Array; N: Float32Array; n: number }

export function collect(g: ParsedGlb, json: any): Soup {
    const P: number[] = [], UV: number[] = [], img: number[] = [];
    for (const mesh of json.meshes ?? []) for (const prim of mesh.primitives ?? []) {
        if ((prim.mode ?? 4) !== 4 || prim.attributes?.POSITION === undefined) continue;
        const tex = prim.material !== undefined ? json.materials?.[prim.material]?.pbrMetallicRoughness?.baseColorTexture : undefined;
        const source: number | undefined = tex ? json.textures?.[tex.index]?.source : undefined;
        const uvAcc = tex ? prim.attributes[`TEXCOORD_${tex.texCoord ?? 0}`] : undefined;
        const pos = readAccessor(g, prim.attributes.POSITION).data;
        const uv = source !== undefined && uvAcc !== undefined ? readAccessor(g, uvAcc).data : undefined;
        const idx = prim.indices !== undefined ? readAccessor(g, prim.indices).data : undefined;
        const n = idx ? idx.length : pos.length / 3;
        for (let t = 0; t + 2 < n; t += 3) {
            for (let k = 0; k < 3; k++) {
                const i = idx ? idx[t + k] : t + k;
                P.push(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]);
                UV.push(uv ? uv[i * 2] : 0, uv ? uv[i * 2 + 1] : 0);
            }
            img.push(uv ? source! : -1);
        }
    }
    const nt = img.length, N = new Float32Array(nt * 3);
    for (let t = 0; t < nt; t++) {
        const a = t * 9;
        const e1x = P[a + 3] - P[a], e1y = P[a + 4] - P[a + 1], e1z = P[a + 5] - P[a + 2], e2x = P[a + 6] - P[a], e2y = P[a + 7] - P[a + 1], e2z = P[a + 8] - P[a + 2];
        const nx = e1y * e2z - e1z * e2y, ny = e1z * e2x - e1x * e2z, nz = e1x * e2y - e1y * e2x, l = Math.hypot(nx, ny, nz);
        if (l > 0) { N[t * 3] = nx / l; N[t * 3 + 1] = ny / l; N[t * 3 + 2] = nz / l; }
    }
    return { P: Float32Array.from(P), UV: Float32Array.from(UV), img: Int32Array.from(img), N, n: nt };
}

/** An orthographic direction: right, up and forward (the way it looks), unit. */
interface Dir { r: number[]; u: number[]; d: number[] }

const cross = (a: number[], b: number[]) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const unit = (a: number[]) => { const l = Math.hypot(a[0], a[1], a[2]); return [a[0] / l, a[1] / l, a[2] / l]; };

function directions(P: ViewRelightParams): Dir[] {
    const out: Dir[] = [];
    const make = (d: number[], upHint: number[]): Dir => {
        const dot = upHint[0] * d[0] + upHint[1] * d[1] + upHint[2] * d[2];
        const u = unit([upHint[0] - dot * d[0], upHint[1] - dot * d[1], upHint[2] - dot * d[2]]);
        return { r: unit(cross(d, u)), u, d };
    };
    for (let k = 0; k < P.azimuths; k++) {
        const a = (2 * Math.PI * k) / P.azimuths;
        out.push(make([Math.cos(a), 0, Math.sin(a)], [0, 1, 0]));
    }
    const e = (P.obliqueDownDeg * Math.PI) / 180;
    for (let k = 0; k < P.obliqueAzimuths; k++) {
        const a = (2 * Math.PI * (k + 0.5)) / P.obliqueAzimuths;
        out.push(make([Math.cos(a) * Math.cos(e), -Math.sin(e), Math.sin(a) * Math.cos(e)], [0, 1, 0]));
    }
    if (P.nadir) out.push(make([0, -1, 0], [0, 0, -1]));
    return out;
}

/** A surface's facing class: 8 compass bins of its horizontal normal, 8 up, 9 down (the normal turned toward the viewer first). */
function binOf(nx: number, ny: number, nz: number, d: number[], flatNy: number): number {
    if (nx * d[0] + ny * d[1] + nz * d[2] > 0) { nx = -nx; ny = -ny; nz = -nz; }
    if (ny > flatNy) return 8;
    if (ny < -flatNy) return 9;
    return ((Math.round(Math.atan2(nz, nx) / (Math.PI / 4)) % 8) + 8) % 8;
}
const NO_BIN = 255;

/** One direction rendered unlit at mpp metres a pixel: colour, depth (m along d), facing bin (NO_BIN: not a photo, or edge-on). */
interface DirRender { W: number; H: number; X0: number; Y1: number; rgba: Uint8Array; depth: Float32Array; bin: Uint8Array }

function renderDirection(s: Soup, photos: Map<number, RgbaImage8>, dir: Dir, mpp: number, P: ViewRelightParams): DirRender {
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (let i = 0; i < s.P.length; i += 3) {
        const x = s.P[i] * dir.r[0] + s.P[i + 1] * dir.r[1] + s.P[i + 2] * dir.r[2], y = s.P[i] * dir.u[0] + s.P[i + 1] * dir.u[1] + s.P[i + 2] * dir.u[2];
        if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
    const W = Math.max(1, Math.ceil((x1 - x0) / mpp) + 2), H = Math.max(1, Math.ceil((y1 - y0) / mpp) + 2);
    const X0 = x0 - mpp, Y1 = y1 + mpp;
    const rgba = new Uint8Array(W * H * 4), depth = new Float32Array(W * H).fill(Infinity), bin = new Uint8Array(W * H).fill(NO_BIN);
    for (let i = 0; i < W * H; i++) { rgba[i * 4] = P.background[0]; rgba[i * 4 + 1] = P.background[1]; rgba[i * 4 + 2] = P.background[2]; rgba[i * 4 + 3] = 255; }
    const sx = new Float64Array(3), sy = new Float64Array(3), sz = new Float64Array(3);
    for (let t = 0; t < s.n; t++) {
        const a = t * 9;
        for (let k = 0; k < 3; k++) {
            const px = s.P[a + k * 3], py = s.P[a + k * 3 + 1], pz = s.P[a + k * 3 + 2];
            sx[k] = (px * dir.r[0] + py * dir.r[1] + pz * dir.r[2] - X0) / mpp;
            sy[k] = (Y1 - (px * dir.u[0] + py * dir.u[1] + pz * dir.u[2])) / mpp;
            sz[k] = px * dir.d[0] + py * dir.d[1] + pz * dir.d[2];
        }
        const area = (sx[1] - sx[0]) * (sy[2] - sy[0]) - (sx[2] - sx[0]) * (sy[1] - sy[0]);
        if (Math.abs(area) < 1e-12) continue;
        const bx0 = Math.max(0, Math.floor(Math.min(sx[0], sx[1], sx[2]))), bx1 = Math.min(W - 1, Math.ceil(Math.max(sx[0], sx[1], sx[2])));
        const by0 = Math.max(0, Math.floor(Math.min(sy[0], sy[1], sy[2]))), by1 = Math.min(H - 1, Math.ceil(Math.max(sy[0], sy[1], sy[2])));
        const im = s.img[t], photo = im >= 0 ? photos.get(im) : undefined;
        const nx = s.N[t * 3], ny = s.N[t * 3 + 1], nz = s.N[t * 3 + 2];
        const cos = Math.abs(nx * dir.d[0] + ny * dir.d[1] + nz * dir.d[2]);
        const b = photo && cos >= P.facingMinCos ? binOf(nx, ny, nz, dir.d, P.flatNy) : NO_BIN;
        const ua = s.UV[t * 6], va = s.UV[t * 6 + 1], ub = s.UV[t * 6 + 2], vb = s.UV[t * 6 + 3], uc = s.UV[t * 6 + 4], vc = s.UV[t * 6 + 5];
        const inv = 1 / area;
        for (let y = by0; y <= by1; y++) for (let x = bx0; x <= bx1; x++) {
            const cx = x + 0.5, cy = y + 0.5;
            const w0 = ((sx[1] - cx) * (sy[2] - cy) - (sx[2] - cx) * (sy[1] - cy)) * inv;
            const w1 = ((sx[2] - cx) * (sy[0] - cy) - (sx[0] - cx) * (sy[2] - cy)) * inv;
            const w2 = 1 - w0 - w1;
            if (w0 < 0 || w1 < 0 || w2 < 0) continue;
            const z = w0 * sz[0] + w1 * sz[1] + w2 * sz[2], i = y * W + x;
            if (z >= depth[i]) continue;
            depth[i] = z;
            bin[i] = b;
            if (photo) {
                const u = w0 * ua + w1 * ub + w2 * uc, v = w0 * va + w1 * vb + w2 * vc;
                const tx = Math.min(photo.width - 1, Math.max(0, Math.floor((u - Math.floor(u)) * photo.width)));
                const ty = Math.min(photo.height - 1, Math.max(0, Math.floor((v - Math.floor(v)) * photo.height)));
                const o = (ty * photo.width + tx) * 4;
                rgba[i * 4] = photo.rgba[o]; rgba[i * 4 + 1] = photo.rgba[o + 1]; rgba[i * 4 + 2] = photo.rgba[o + 2];
            } else { rgba[i * 4] = 140; rgba[i * 4 + 1] = 142; rgba[i * 4 + 2] = 146; }
        }
    }
    return { W, H, X0, Y1, rgba, depth, bin };
}

/** Tile origins along an axis of length L (pixels), tiles of T with the given step; a short axis gets one centred tile. */
function origins(L: number, T: number, step: number): number[] {
    if (L <= T) return [Math.floor((L - T) / 2)];
    const out: number[] = [];
    for (let o = 0; ; o += step) { if (o + T >= L) { out.push(L - T); break; } out.push(o); }
    return out;
}

/** A tile the model relit: where it sits in its direction's image, its facing fields, depth grid and confidence. */
interface Tile { dir: number; ox: number; oy: number; fields: Map<number, NonNullable<LightingLockResult['field']>>; depthMin: Float32Array; confidence: number }

/** Per direction: its frame, the tile origins on each axis and the tile index at each (-1: not sent or not accepted). */
interface DirTiles { X0: number; Y1: number; xs: number[]; ys: number[]; at: Int32Array }

function luminance(r: number, g: number, b: number): number { return 0.2126 * r + 0.7152 * g + 0.0722 * b; }

/** A seeded uniform generator (mulberry32). */
function rng(seed: number): () => number {
    let a = seed >>> 0;
    return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

const median = (a: number[]): number | null => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };

/**
 * The anchor: a facing's gain field (edited in place) loses its component at sigmaCells and above, in log, weighted by how much
 * of each cell the facing covers (`mask`, the tile's T x T pixels), so a cell the facing does not reach does not pull it.
 */
function anchorField(f: NonNullable<LightingLockResult['field']>, mask: Uint8Array, T: number, sigmaCells: number): void {
    const { gw, gh, gain } = f, w = new Float32Array(gw * gh), cnt = new Float32Array(gw * gh);
    for (let y = 0; y < T; y++) {
        const gy = Math.min(gh - 1, Math.floor((y * gh) / T));
        for (let x = 0; x < T; x++) { const g = gy * gw + Math.min(gw - 1, Math.floor((x * gw) / T)); cnt[g]++; w[g] += mask[y * T + x]; }
    }
    for (let g = 0; g < gw * gh; g++) w[g] = cnt[g] ? w[g] / cnt[g] : 0;
    const wB = blur1(w, gw, gh, sigmaCells), chan = new Float32Array(gw * gh);
    for (let c = 0; c < 3; c++) {
        for (let g = 0; g < gw * gh; g++) chan[g] = Math.log(gain[g * 3 + c]) * w[g];
        const low = blur1(chan, gw, gh, sigmaCells);
        for (let g = 0; g < gw * gh; g++) gain[g * 3 + c] = Math.exp(Math.log(gain[g * 3 + c]) - (wB[g] > 1e-4 ? low[g] / wB[g] : 0));
    }
}

/** Surface samples (photo, UV) grouped by photo within the seam patches (a seamM cell of space and a facing) two or more photos share; a pair is two groups. */
interface SeamProbe { groups: number[][]; pairs: Array<[number, number]>; img: Int32Array; u: Float32Array; v: Float32Array }

/** Area-weighted samples of the photographed surface, grouped by patch; each photo in a shared patch against the patch's largest. */
function seamSamples(s: Soup, photos: Map<number, RgbaImage8>, P: ViewRelightParams): SeamProbe {
    const area = new Float64Array(s.n);
    let sum = 0;
    for (let t = 0; t < s.n; t++) {
        if (s.img[t] >= 0 && photos.has(s.img[t])) {
            const a = t * 9;
            const e1x = s.P[a + 3] - s.P[a], e1y = s.P[a + 4] - s.P[a + 1], e1z = s.P[a + 5] - s.P[a + 2], e2x = s.P[a + 6] - s.P[a], e2y = s.P[a + 7] - s.P[a + 1], e2z = s.P[a + 8] - s.P[a + 2];
            sum += 0.5 * Math.hypot(e1y * e2z - e1z * e2y, e1z * e2x - e1x * e2z, e1x * e2y - e1y * e2x);
        }
        area[t] = sum;
    }
    const n = sum > 0 ? P.seamSamples : 0, rand = rng(0x5ea3);
    const img = new Int32Array(n), u = new Float32Array(n), v = new Float32Array(n), key: string[] = new Array(n);
    for (let k = 0; k < n; k++) {
        const target = rand() * sum;
        let lo = 0, hi = s.n - 1;
        while (lo < hi) { const mid = (lo + hi) >> 1; if (area[mid] < target) lo = mid + 1; else hi = mid; }
        const t = lo, a = t * 9;
        let b1 = rand(), b2 = rand();
        if (b1 + b2 > 1) { b1 = 1 - b1; b2 = 1 - b2; }
        const b0 = 1 - b1 - b2;
        const x = b0 * s.P[a] + b1 * s.P[a + 3] + b2 * s.P[a + 6], y = b0 * s.P[a + 1] + b1 * s.P[a + 4] + b2 * s.P[a + 7], z = b0 * s.P[a + 2] + b1 * s.P[a + 5] + b2 * s.P[a + 8];
        const nx = s.N[t * 3], ny = s.N[t * 3 + 1], nz = s.N[t * 3 + 2];
        const facing = ny > P.flatNy ? 'u' : ny < -P.flatNy ? 'd' : String(((Math.round((Math.atan2(nx, nz) / (2 * Math.PI)) * P.seamFacingBins) % P.seamFacingBins) + P.seamFacingBins) % P.seamFacingBins);
        key[k] = `${Math.floor(x / P.seamM)},${Math.floor(y / P.seamM)},${Math.floor(z / P.seamM)},${facing}`;
        img[k] = s.img[t];
        u[k] = b0 * s.UV[t * 6] + b1 * s.UV[t * 6 + 2] + b2 * s.UV[t * 6 + 4];
        v[k] = b0 * s.UV[t * 6 + 1] + b1 * s.UV[t * 6 + 3] + b2 * s.UV[t * 6 + 5];
    }
    // patch -> photo -> its samples
    const patches = new Map<string, Map<number, number[]>>();
    for (let k = 0; k < n; k++) {
        let m = patches.get(key[k]); if (!m) patches.set(key[k], (m = new Map()));
        let l = m.get(img[k]); if (!l) m.set(img[k], (l = []));
        l.push(k);
    }
    const groups: number[][] = [], pairs: Array<[number, number]> = [];
    for (const m of patches.values()) {
        if (m.size < 2) continue;
        const list = [...m.values()].sort((x, y) => y.length - x.length);
        const g0 = groups.push(list[0]) - 1;
        for (let k = 1; k < list.length; k++) pairs.push([g0, groups.push(list[k]) - 1]);
    }
    return { groups, pairs, img, u, v };
}

/** The photos' mean patch difference over the probe's pairs (mean |log colour| difference of the two groups, weighted by the smaller). */
function seamDifference(probe: SeamProbe, photos: Map<number, RgbaImage8>): { pairs: number; diff: number } {
    const mean = probe.groups.map(g => {
        const c = [0, 0, 0];
        for (const k of g) {
            const p = photos.get(probe.img[k])!;
            const uu = probe.u[k] - Math.floor(probe.u[k]), vv = probe.v[k] - Math.floor(probe.v[k]);
            const o = (Math.min(p.height - 1, Math.floor(vv * p.height)) * p.width + Math.min(p.width - 1, Math.floor(uu * p.width))) * 4;
            for (let q = 0; q < 3; q++) c[q] += Math.log(1e-3 + SRGB8_TO_LINEAR[p.rgba[o + q]]);
        }
        return c.map(x => x / g.length);
    });
    let s = 0, wt = 0;
    for (const [a, b] of probe.pairs) {
        const w = Math.min(probe.groups[a].length, probe.groups[b].length);
        for (let q = 0; q < 3; q++) { s += w * Math.abs(mean[a][q] - mean[b][q]); wt += w; }
    }
    return { pairs: probe.pairs.length, diff: wt > 0 ? s / wt : 0 };
}

/** The parameters the environment sets for a build (SCRATCHBOX_K_VIEW_RELIGHT_ANCHOR_M, SCRATCHBOX_K_VIEW_RELIGHT_GATE=0), and their cache key part. */
export function viewRelightEnvParams(): { params: Partial<ViewRelightParams>; key: string } {
    const params: Partial<ViewRelightParams> = {};
    const anchor = Number(process.env.SCRATCHBOX_K_VIEW_RELIGHT_ANCHOR_M);
    if (process.env.SCRATCHBOX_K_VIEW_RELIGHT_ANCHOR_M?.trim() && Number.isFinite(anchor) && anchor >= 0) params.anchorM = anchor;
    if (process.env.SCRATCHBOX_K_VIEW_RELIGHT_GATE?.trim() === '0') params.gate = false;
    return { params, key: `anchor:${params.anchorM ?? VIEW_RELIGHT_PARAMS.anchorM};gate:${params.gate ?? true}` };
}

/**
 * Relights the twin's photos (`photos`, edited in place) from rendered views of the building. `surfaces` (texture-harmonize.ts
 * surfaceClassMasks) keeps texels no triangle uses as they are; `groundY` is the ground the canyon measure counts height from.
 */
export async function viewRelight(g: ParsedGlb, json: any, photos: Map<number, RgbaImage8>, input: {
    client: EnhanceModelClient; models: string[]; groundY: number; surfaces?: Map<number, Uint8Array>; signal?: AbortSignal; progress?: (message: string) => void; params?: Partial<ViewRelightParams>;
}): Promise<ViewRelightReport> {
    const P = { ...VIEW_RELIGHT_PARAMS, ...(input.params ?? {}) };
    const t0 = Date.now();
    const T = Math.min(P.tilePx, LIGHTING_MAX_SIDE), mpp = P.tileM / T, step = Math.max(1, Math.round(T * (1 - P.overlap)));
    const s = collect(g, json);
    const dirs = directions(P);
    const report: ViewRelightReport = {
        applied: false, why: '', directions: dirs.length, tiles: { planned: 0, empty: 0, sent: 0, accepted: 0, rejected: 0, failed: 0 }, models: [],
        samples: 0, seenShare: 0, spreadBefore: null, spreadAfter: null, gainP5: 1, gainP95: 1, canyonRatioBefore: null, canyonRatioAfter: null, anchorM: P.anchorM, seams: null, ms: 0, records: []
    };
    const done = (why: string) => { report.why = why; report.ms = Date.now() - t0; return report; };
    if (!s.n) return done('the twin has no triangles');

    // 1-2: render each direction, cut its tiles, relight them
    const tiles: Tile[] = [];
    const dirTiles: DirTiles[] = new Array(dirs.length);
    const models = new Set<string>();
    let back = 0;
    await mapConcurrent(dirs.map((d, k) => ({ d, k })), P.directionsAtOnce, async ({ d, k }) => {
        await new Promise(r => setImmediate(r));
        const R = renderDirection(s, photos, d, mpp, P);
        const xs = origins(R.W, T, step), ys = origins(R.H, T, step);
        const at = new Int32Array(xs.length * ys.length).fill(-1);
        dirTiles[k] = { X0: R.X0, Y1: R.Y1, xs, ys, at };
        const jobs: Array<{ ix: number; iy: number; image: RgbaImage8; bin: Uint8Array; depthMin: Float32Array }> = [];
        const D = P.depthGrid, cell = T / D;
        for (let iy = 0; iy < ys.length; iy++) for (let ix = 0; ix < xs.length; ix++) {
            report.tiles.planned++;
            const ox = xs[ix], oy = ys[iy];
            const rgba = new Uint8Array(T * T * 4), bin = new Uint8Array(T * T).fill(NO_BIN), depthMin = new Float32Array(D * D).fill(Infinity);
            let photoPx = 0;
            for (let y = 0; y < T; y++) for (let x = 0; x < T; x++) {
                const gx = ox + x, gy = oy + y, o = (y * T + x) * 4;
                if (gx < 0 || gy < 0 || gx >= R.W || gy >= R.H) { rgba[o] = P.background[0]; rgba[o + 1] = P.background[1]; rgba[o + 2] = P.background[2]; rgba[o + 3] = 255; continue; }
                const i = gy * R.W + gx;
                rgba[o] = R.rgba[i * 4]; rgba[o + 1] = R.rgba[i * 4 + 1]; rgba[o + 2] = R.rgba[i * 4 + 2]; rgba[o + 3] = 255;
                bin[y * T + x] = R.bin[i];
                if (R.bin[i] !== NO_BIN) photoPx++;
                const c = Math.min(D - 1, Math.floor(y / cell)) * D + Math.min(D - 1, Math.floor(x / cell));
                if (R.depth[i] < depthMin[c]) depthMin[c] = R.depth[i];
            }
            if (photoPx < P.minCoverage * T * T) { report.tiles.empty++; continue; }
            jobs.push({ ix, iy, image: { width: T, height: T, rgba }, bin, depthMin });
        }
        await mapConcurrent(jobs, Math.max(1, Math.round(P.concurrency / P.directionsAtOnce)), async job => {
            const mask = new Uint8Array(T * T);
            for (let i = 0; i < T * T; i++) mask[i] = job.bin[i] !== NO_BIN ? 1 : 0;
            report.tiles.sent++;
            const r = await lightingCorrectImage({ label: `relight d${k} x${job.ix} y${job.iy}`, image: job.image, mask, client: input.client, models: input.models, ...(input.signal ? { signal: input.signal } : {}) });
            report.records.push(r.record);
            if (r.record.modelUsed) models.add(r.record.modelUsed);
            back++;
            if (back % 8 === 0) input.progress?.(`view relight: ${back} views back (${report.tiles.accepted} relit)`);
            if (r.record.decision === 'model_failed') { report.tiles.failed++; return; }
            if (!r.field || !r.answer) { report.tiles.rejected++; return; }
            report.tiles.accepted++;
            const answer = r.answer.width === T && r.answer.height === T ? r.answer : resizeRgba(r.answer, T, T);
            const counts = new Map<number, number>();
            for (let i = 0; i < T * T; i++) if (job.bin[i] !== NO_BIN) counts.set(job.bin[i], (counts.get(job.bin[i]) ?? 0) + 1);
            const fields = new Map<number, NonNullable<LightingLockResult['field']>>();
            const total = [...counts.values()].reduce((a, b) => a + b, 0);
            for (const [b, c] of counts) {
                if (c < P.minBinPx || c < P.minBinShare * total) continue;
                const m = new Uint8Array(T * T);
                for (let i = 0; i < T * T; i++) m[i] = job.bin[i] === b ? 1 : 0;
                const f = gainField(job.image, answer, m).field;
                if (P.anchorM > 0) anchorField(f, m, T, P.anchorM / (mpp * (T / f.gw)));
                fields.set(b, f);
            }
            dirTiles[k].at[job.iy * xs.length + job.ix] = tiles.length;
            tiles.push({ dir: k, ox: xs[job.ix], oy: ys[job.iy], fields, depthMin: job.depthMin, confidence: Math.max(0.05, r.record.confidence ?? 0.5) });
        }, input.signal);
    }, input.signal);
    report.models = [...models];
    if (!report.tiles.sent) return done('no view showed enough of the building to send');
    if (report.tiles.accepted < P.minAcceptedShare * report.tiles.sent) {
        return done(`only ${report.tiles.accepted} of ${report.tiles.sent} views passed the detail lock (at least ${Math.round(100 * P.minAcceptedShare)} percent needed): the photos keep their lighting`);
    }

    // the tiles that see a point (x, y, z) of normal n: tile index, log gain (3) and weight, into obs
    const D = P.depthGrid, cell = T / D, feather = P.featherShare * T;
    const g3 = new Float64Array(3);
    const observe = (x: number, y: number, z: number, nx: number, ny: number, nz: number, obs: number[]): void => {
        for (let k = 0; k < dirs.length; k++) {
            const dt = dirTiles[k], dir = dirs[k];
            if (!dt) continue;
            const cos = Math.abs(nx * dir.d[0] + ny * dir.d[1] + nz * dir.d[2]);
            if (cos < P.facingMinCos) continue;
            const px = (x * dir.r[0] + y * dir.r[1] + z * dir.r[2] - dt.X0) / mpp, py = (dt.Y1 - (x * dir.u[0] + y * dir.u[1] + z * dir.u[2])) / mpp;
            const depth = x * dir.d[0] + y * dir.d[1] + z * dir.d[2];
            let b = -1;
            for (let iy = 0; iy < dt.ys.length; iy++) {
                const ly = py - dt.ys[iy];
                if (ly < 0 || ly >= T) continue;
                for (let ix = 0; ix < dt.xs.length; ix++) {
                    const lx = px - dt.xs[ix];
                    if (lx < 0 || lx >= T) continue;
                    const ti = dt.at[iy * dt.xs.length + ix];
                    if (ti < 0) continue;
                    const tile = tiles[ti];
                    if (depth > tile.depthMin[Math.min(D - 1, Math.floor(ly / cell)) * D + Math.min(D - 1, Math.floor(lx / cell))] + P.depthTolM) continue;
                    if (b < 0) b = binOf(nx, ny, nz, dir.d, P.flatNy);
                    const f = tile.fields.get(b);
                    if (!f) continue;
                    fieldAt(f, T, T, lx, ly, g3);
                    const edge = Math.min(lx, ly, T - lx, T - ly);
                    const w = cos * tile.confidence * Math.max(0.02, Math.min(1, edge / feather));
                    obs.push(ti, Math.log(g3[0]), Math.log(g3[1]), Math.log(g3[2]), w);
                }
            }
        }
    };

    // 3: one log offset per tile and channel, on area-weighted points
    input.progress?.(`view relight: ${report.tiles.accepted} of ${report.tiles.sent} views relit; solving their exposures`);
    const area = new Float64Array(s.n);
    let areaSum = 0;
    for (let t = 0; t < s.n; t++) {
        if (s.img[t] < 0) continue;
        const a = t * 9;
        const e1x = s.P[a + 3] - s.P[a], e1y = s.P[a + 4] - s.P[a + 1], e1z = s.P[a + 5] - s.P[a + 2], e2x = s.P[a + 6] - s.P[a], e2y = s.P[a + 7] - s.P[a + 1], e2z = s.P[a + 8] - s.P[a + 2];
        areaSum += 0.5 * Math.hypot(e1y * e2z - e1z * e2y, e1z * e2x - e1x * e2z, e1x * e2y - e1y * e2x);
        area[t] = areaSum;
    }
    const rand = rng(0x5eed);
    const pts: Array<{ obs: number[]; dirs: number }> = [];
    for (let k = 0; k < P.offsetSamples && areaSum > 0; k++) {
        const target = rand() * areaSum;
        let lo = 0, hi = s.n - 1;
        while (lo < hi) { const mid = (lo + hi) >> 1; if (area[mid] < target) lo = mid + 1; else hi = mid; }
        const t = lo, a = t * 9;
        let b1 = rand(), b2 = rand();
        if (b1 + b2 > 1) { b1 = 1 - b1; b2 = 1 - b2; }
        const b0 = 1 - b1 - b2;
        const obs: number[] = [];
        observe(b0 * s.P[a] + b1 * s.P[a + 3] + b2 * s.P[a + 6], b0 * s.P[a + 1] + b1 * s.P[a + 4] + b2 * s.P[a + 7], b0 * s.P[a + 2] + b1 * s.P[a + 5] + b2 * s.P[a + 8], s.N[t * 3], s.N[t * 3 + 1], s.N[t * 3 + 2], obs);
        if (obs.length < 10) continue;
        const ds = new Set<number>();
        for (let o = 0; o < obs.length; o += 5) ds.add(tiles[obs[o]].dir);
        pts.push({ obs, dirs: ds.size });
    }
    const off = new Float64Array(tiles.length * 3);
    const spread = (): number | null => {
        const out: number[] = [];
        for (const p of pts) {
            if (p.dirs < 2) continue;
            let sw = 0, m = 0, m2 = 0;
            for (let o = 0; o < p.obs.length; o += 5) {
                const ti = p.obs[o], w = p.obs[o + 4];
                const l = (p.obs[o + 1] + off[ti * 3]) * 0.2126 + (p.obs[o + 2] + off[ti * 3 + 1]) * 0.7152 + (p.obs[o + 3] + off[ti * 3 + 2]) * 0.0722;
                sw += w; m += w * l; m2 += w * l * l;
            }
            out.push(Math.sqrt(Math.max(0, m2 / sw - (m / sw) ** 2)));
        }
        return median(out);
    };
    report.spreadBefore = spread();
    if (pts.length) {
        const meanW = new Float64Array(tiles.length), nW = new Float64Array(tiles.length);
        for (const p of pts) for (let o = 0; o < p.obs.length; o += 5) { meanW[p.obs[o]] += p.obs[o + 4]; nW[p.obs[o]]++; }
        for (let ti = 0; ti < tiles.length; ti++) meanW[ti] = nW[ti] ? meanW[ti] / nW[ti] : 0;
        const xp = new Float64Array(pts.length * 3);
        for (let it = 0; it < P.offsetIters; it++) {
            pts.forEach((p, i) => {
                let sw = 0; const acc = [0, 0, 0];
                for (let o = 0; o < p.obs.length; o += 5) { const ti = p.obs[o], w = p.obs[o + 4]; sw += w; for (let c = 0; c < 3; c++) acc[c] += w * (p.obs[o + 1 + c] + off[ti * 3 + c]); }
                for (let c = 0; c < 3; c++) xp[i * 3 + c] = acc[c] / sw;
            });
            const num = new Float64Array(tiles.length * 3), den = new Float64Array(tiles.length);
            pts.forEach((p, i) => {
                if (p.obs.length < 10) return;
                for (let o = 0; o < p.obs.length; o += 5) { const ti = p.obs[o], w = p.obs[o + 4]; den[ti] += w; for (let c = 0; c < 3; c++) num[ti * 3 + c] += w * (xp[i * 3 + c] - p.obs[o + 1 + c]); }
            });
            const mean = [0, 0, 0];
            let n = 0;
            for (let ti = 0; ti < tiles.length; ti++) {
                const prior = P.offsetPrior * meanW[ti] * Math.max(1, nW[ti]);
                for (let c = 0; c < 3; c++) off[ti * 3 + c] = den[ti] + prior > 0 ? num[ti * 3 + c] / (den[ti] + prior) : 0;
                if (den[ti] > 0) { n++; for (let c = 0; c < 3; c++) mean[c] += off[ti * 3 + c]; }
            }
            if (n) for (let ti = 0; ti < tiles.length; ti++) for (let c = 0; c < 3; c++) off[ti * 3 + c] -= mean[c] / n;
        }
    }
    report.spreadAfter = spread();

    // 4: the gain grid of every photo, from the triangles' samples
    input.progress?.('view relight: carrying the views\' gains back to the photos');
    const S = P.sampleStride;
    interface Grid { gw: number; gh: number; acc: Float32Array; w: Float32Array }
    const grids = new Map<number, Grid>();
    const gridOf = (im: number): Grid | undefined => {
        let gr = grids.get(im);
        if (gr) return gr;
        const photo = photos.get(im);
        if (!photo) return undefined;
        const gw = Math.max(1, Math.ceil(photo.width / S)), gh = Math.max(1, Math.ceil(photo.height / S));
        gr = { gw, gh, acc: new Float32Array(gw * gh * 3), w: new Float32Array(gw * gh) };
        grids.set(im, gr);
        return gr;
    };
    let samples = 0, seen = 0;
    const obs: number[] = [];
    const canyon = { lo: [0, 0], mid: [0, 0], loAfter: 0, midAfter: 0 };
    const writeSample = (gr: Grid, photo: RgbaImage8, cx: number, cy: number, t: number, b0: number, b1: number, b2: number) => {
        const a = t * 9;
        const x = b0 * s.P[a] + b1 * s.P[a + 3] + b2 * s.P[a + 6], y = b0 * s.P[a + 1] + b1 * s.P[a + 4] + b2 * s.P[a + 7], z = b0 * s.P[a + 2] + b1 * s.P[a + 5] + b2 * s.P[a + 8];
        obs.length = 0;
        observe(x, y, z, s.N[t * 3], s.N[t * 3 + 1], s.N[t * 3 + 2], obs);
        samples++;
        if (!obs.length) return;
        seen++;
        let sw = 0; const acc = [0, 0, 0];
        for (let o = 0; o < obs.length; o += 5) { const ti = obs[o], w = obs[o + 4]; sw += w; for (let c = 0; c < 3; c++) acc[c] += w * (obs[o + 1 + c] + off[ti * 3 + c]); }
        const gi = cy * gr.gw + cx;
        for (let c = 0; c < 3; c++) gr.acc[gi * 3 + c] += acc[c] / sw;
        gr.w[gi] += 1;
        // the street canyon, on the walls: the photo's luminance by height band (before the mean is taken out; ratios are unaffected)
        if (Math.abs(s.N[t * 3 + 1]) < 0.5) {
            const h = y - input.groundY;
            const tx = Math.min(photo.width - 1, cx * S + (S >> 1)), ty = Math.min(photo.height - 1, cy * S + (S >> 1)), o = (ty * photo.width + tx) * 4;
            const L = luminance(SRGB8_TO_LINEAR[photo.rgba[o]], SRGB8_TO_LINEAR[photo.rgba[o + 1]], SRGB8_TO_LINEAR[photo.rgba[o + 2]]);
            const gL = Math.exp(luminance(acc[0] / sw, acc[1] / sw, acc[2] / sw));
            if (h >= 0 && h < 60) { canyon.lo[0] += L; canyon.lo[1]++; canyon.loAfter += L * gL; } else if (h >= 60 && h < 120) { canyon.mid[0] += L; canyon.mid[1]++; canyon.midAfter += L * gL; }
        }
    };
    for (let t = 0; t < s.n; t++) {
        const im = s.img[t];
        if (im < 0) continue;
        const gr = gridOf(im), photo = photos.get(im);
        if (!gr || !photo) continue;
        if ((t & 0x3fff) === 0) await new Promise(r => setImmediate(r));
        let ua = s.UV[t * 6], va = s.UV[t * 6 + 1], ub = s.UV[t * 6 + 2], vb = s.UV[t * 6 + 3], uc = s.UV[t * 6 + 4], vc = s.UV[t * 6 + 5];
        const fu = Math.floor(Math.min(ua, ub, uc)), fv = Math.floor(Math.min(va, vb, vc));
        ua -= fu; ub -= fu; uc -= fu; va -= fv; vb -= fv; vc -= fv;
        // texel coordinates, in grid cells
        const ax = (ua * photo.width) / S, ay = (va * photo.height) / S, bx = (ub * photo.width) / S, by = (vb * photo.height) / S, cxx = (uc * photo.width) / S, cyy = (vc * photo.height) / S;
        const det = (bx - ax) * (cyy - ay) - (cxx - ax) * (by - ay);
        let wrote = false;
        if (Math.abs(det) > 1e-12) {
            const x0 = Math.max(0, Math.floor(Math.min(ax, bx, cxx))), x1 = Math.min(gr.gw - 1, Math.ceil(Math.max(ax, bx, cxx)));
            const y0 = Math.max(0, Math.floor(Math.min(ay, by, cyy))), y1 = Math.min(gr.gh - 1, Math.ceil(Math.max(ay, by, cyy)));
            for (let cy = y0; cy <= y1; cy++) for (let cx = x0; cx <= x1; cx++) {
                const px = cx + 0.5, py = cy + 0.5;
                const b1 = ((px - ax) * (cyy - ay) - (cxx - ax) * (py - ay)) / det, b2 = ((bx - ax) * (py - ay) - (px - ax) * (by - ay)) / det, b0 = 1 - b1 - b2;
                if (b0 < 0 || b1 < 0 || b2 < 0) continue;
                writeSample(gr, photo, cx, cy, t, b0, b1, b2);
                wrote = true;
            }
        }
        if (!wrote) {
            const cx = Math.min(gr.gw - 1, Math.max(0, Math.floor((ax + bx + cxx) / 3))), cy = Math.min(gr.gh - 1, Math.max(0, Math.floor((ay + by + cyy) / 3)));
            writeSample(gr, photo, cx, cy, t, 1 / 3, 1 / 3, 1 / 3);
        }
    }
    report.samples = samples;
    report.seenShare = samples ? seen / samples : 0;
    if (canyon.lo[1] && canyon.mid[1]) {
        report.canyonRatioBefore = (canyon.lo[0] / canyon.lo[1]) / (canyon.mid[0] / canyon.mid[1]);
        report.canyonRatioAfter = (canyon.loAfter / canyon.lo[1]) / (canyon.midAfter / canyon.mid[1]);
    }

    // the means per cell, the building's mean log gain per channel, the spread of the gain
    const mean = [0, 0, 0];
    let nCells = 0;
    const lums: number[] = [];
    for (const gr of grids.values()) for (let i = 0; i < gr.gw * gr.gh; i++) {
        if (!gr.w[i]) continue;
        for (let c = 0; c < 3; c++) { gr.acc[i * 3 + c] /= gr.w[i]; mean[c] += gr.acc[i * 3 + c] * gr.w[i]; }
        nCells += gr.w[i];
        gr.w[i] = 1;
    }
    if (nCells) for (let c = 0; c < 3; c++) mean[c] /= nCells;
    for (const gr of grids.values()) for (let i = 0; i < gr.gw * gr.gh; i++) {
        if (!gr.w[i]) continue;
        for (let c = 0; c < 3; c++) gr.acc[i * 3 + c] = Math.max(-P.maxGainLog, Math.min(P.maxGainLog, gr.acc[i * 3 + c] - mean[c]));
        lums.push(luminance(gr.acc[i * 3], gr.acc[i * 3 + 1], gr.acc[i * 3 + 2]));
    }
    lums.sort((a, b) => a - b);
    if (lums.length) { report.gainP5 = Math.exp(lums[Math.floor(0.05 * (lums.length - 1))]); report.gainP95 = Math.exp(lums[Math.floor(0.95 * (lums.length - 1))]); }
    if (report.seenShare < P.minSeenShare) return done(`the views saw only ${Math.round(100 * report.seenShare)} percent of the photographed surface (at least ${Math.round(100 * P.minSeenShare)} needed): the photos keep their lighting`);
    if (report.spreadAfter !== null && report.spreadAfter > P.maxSpreadLog) {
        return done(`the views disagree on the lighting where they overlap (median spread ${Math.exp(report.spreadAfter).toFixed(2)}x after their exposures were matched, limit ${Math.exp(P.maxSpreadLog).toFixed(2)}x): the photos keep their lighting`);
    }

    // 5: fill each grid's empty cells from their neighbours, then apply in linear light
    input.progress?.('view relight: applying the gain to the photos');
    const seamProbe = seamSamples(s, photos, P);
    const original = new Map(photos);
    const seamsBefore = seamDifference(seamProbe, photos);
    for (const [im, gr] of grids) {
        const { gw, gh } = gr;
        let todo = 0;
        for (let i = 0; i < gw * gh; i++) if (!gr.w[i]) todo++;
        for (let it = 0; it < P.fillIters && todo; it++) {
            const next: Array<[number, number, number, number]> = [];
            for (let y = 0; y < gh; y++) for (let x = 0; x < gw; x++) {
                const i = y * gw + x;
                if (gr.w[i]) continue;
                let n = 0; const a = [0, 0, 0];
                for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
                    const xx = x + dx, yy = y + dy;
                    if (xx < 0 || yy < 0 || xx >= gw || yy >= gh) continue;
                    const j = yy * gw + xx;
                    if (!gr.w[j]) continue;
                    n++; for (let c = 0; c < 3; c++) a[c] += gr.acc[j * 3 + c];
                }
                if (n) next.push([i, a[0] / n, a[1] / n, a[2] / n]);
            }
            for (const [i, r, gg, b] of next) { gr.acc[i * 3] = r; gr.acc[i * 3 + 1] = gg; gr.acc[i * 3 + 2] = b; gr.w[i] = 1; todo--; }
            if (!next.length) break;
        }
        const photo = photos.get(im)!, mask = input.surfaces?.get(im);
        const W = photo.width, H = photo.height, out = Uint8Array.from(photo.rgba);
        const at = (cx: number, cy: number, c: number) => gr.acc[(Math.min(gh - 1, Math.max(0, cy)) * gw + Math.min(gw - 1, Math.max(0, cx))) * 3 + c];
        for (let y = 0; y < H; y++) {
            const fy = (y + 0.5) / S - 0.5, y0 = Math.floor(fy), ay = fy - y0;
            for (let x = 0; x < W; x++) {
                const i = y * W + x;
                if (mask && mask[i] === TEXEL_NONE) continue;
                const fx = (x + 0.5) / S - 0.5, x0 = Math.floor(fx), ax = fx - x0;
                for (let c = 0; c < 3; c++) {
                    const l = (at(x0, y0, c) * (1 - ax) + at(x0 + 1, y0, c) * ax) * (1 - ay) + (at(x0, y0 + 1, c) * (1 - ax) + at(x0 + 1, y0 + 1, c) * ax) * ay;
                    out[i * 4 + c] = Math.round(linearToSrgb255(SRGB8_TO_LINEAR[photo.rgba[i * 4 + c]] * Math.exp(l)));
                }
            }
        }
        photos.set(im, { width: W, height: H, rgba: out });
        await new Promise(r => setImmediate(r));
    }
    const seamsAfter = seamDifference(seamProbe, photos);
    report.seams = { pairs: seamsBefore.pairs, before: +seamsBefore.diff.toFixed(4), after: +seamsAfter.diff.toFixed(4) };
    const closer = seamsAfter.diff < seamsBefore.diff;
    if (P.gate && !closer) {
        for (const [im, img] of original) photos.set(im, img);
        return done(`the seams between photos did not get closer (${report.seams.before} -> ${report.seams.after} in log colour): the photos keep their lighting`);
    }
    report.applied = true;
    const pct = (x: number) => `${Math.round(100 * x)}%`;
    return done(`${report.tiles.accepted} of ${report.tiles.sent} views relit by ${report.models.join(', ') || 'the image model'} (${dirs.length} directions); `
        + `${pct(report.seenShare)} of the surface seen; tiles' spread ${report.spreadBefore !== null ? Math.exp(report.spreadBefore).toFixed(3) : 'n/a'}x -> ${report.spreadAfter !== null ? Math.exp(report.spreadAfter).toFixed(3) : 'n/a'}x after exposure matching; `
        + `gain ${report.gainP5.toFixed(2)}..${report.gainP95.toFixed(2)} (p5..p95)${report.canyonRatioBefore !== null ? `; lowest 60 m against 60-120 m ${report.canyonRatioBefore.toFixed(2)} -> ${report.canyonRatioAfter!.toFixed(2)}` : ''}; `
        + `seams ${report.seams.before} -> ${report.seams.after}${closer ? '' : ' (further apart; kept because the gate is off)'}${P.anchorM > 0 ? `; anchored at ${P.anchorM} m` : ''}`);
}
