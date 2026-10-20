/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The image evidence the facade material reading (facade-materials.ts) votes with, gathered on the main thread before the
 * layers are textured: open-vocabulary masks of a described surface (by default "the glass window panes") from two
 * independent sources.
 *
 *  - Street View: every registered projection view is cut into a grid of crops (the segmenter outlines at most a handful of
 *    instances per image, so a facade of forty windows is read a few at a time) and each crop is segmented by
 *    ObjectSegmenterService (vfx_segment_subject: the vision model places the prompts, MediaPipe MagicTouch cuts the mask).
 *  - The photo-textured tile: its texture is already mapped onto the mesh, so no pose is needed. Each fitted planar face is
 *    rendered frontally from the tile (tile.sample at a fixed metric step, upright) and that raster is segmented the same way.
 *    It covers faces no Street View pano sees (the backs, the roof) and cross-checks the faces both see.
 *
 * Mask values: 255 = the described surface, 0 = read and not it, 128 = not read (a crop whose call failed): a failed call is
 * never a vote. A crop the model answers "not found" for is a real "not it". Nothing is invented here: the reading decides
 * per region what these votes support (facade-materials.ts).
 *
 * The images the segmenter reads are written to a temp directory for the duration of the call (the tool takes a path) and
 * removed after it.
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { FittedSurface, Vec3 } from '../../../common/spatial/staged-location-contracts';
import type { DecodedImage, ProjectionView } from '../../../common/spatial/texture-pass-contracts';
import { linearToSrgb255 } from '../../../common/spatial/photogrammetric-delight';
import { encodePng } from './png-encode';
import { decodeImageInMemory, type TileTextureSurface } from './tile-texture-transfer';

/** The reading is opt-in until it passes on real data: SCRATCHBOX_FACADE_MATERIALS=1 turns it on for a server. */
export const facadeMaterialsEnabled = (): boolean => process.env.SCRATCHBOX_FACADE_MATERIALS === '1';
/** The described surface the masks outline (an open description; nothing branches on its words). */
export const FACADE_GLASS_TARGET = 'the glass window panes';
/** Mask values. */
export const MASK_YES = 255;
export const MASK_NO = 0;
export const MASK_UNREAD = 128;
/** Frontal tile rasters: metres per pixel (the tile's texel is ~0.15 m, so about two pixels per texel) and their largest side. */
export const TILE_RASTER_MPP = 0.08;
export const TILE_RASTER_MAX_SIDE = 1600;
/** Street View crops: the grid (cells per side) and tile-raster cells at most this many metres on a side. */
export const VIEW_CROP_GRID = 3;
export const TILE_CROP_METRES = 12;
/** Python workers the segmenter may use at once while the evidence is gathered. */
export const SEGMENT_PYTHON_WORKERS = 4;

/** One registered view's mask, at the view's camera resolution. */
export interface ViewMaterialMask { viewIndex: number; panoId: string; width: number; height: number; mask: Uint8Array; crops: number; cropsFailed: number }

/**
 * One fitted planar face rendered frontally from the tile and its mask. Pixel (c, r) is the face point
 * origin + (a0 + (c + 0.5) * mpp) * h + (b1 - (r + 0.5) * mpp) * w, with h horizontal along the face and w up it.
 */
export interface SurfaceMaterialMask {
    surfaceId: string;
    origin: Vec3; h: Vec3; w: Vec3; normal: Vec3;
    a0: number; b1: number; mppM: number;
    width: number; height: number;
    mask: Uint8Array;
    /** Linear luminance of the tile raster (NaN where the tile has no surface), for the measured checks. */
    luminance: Float32Array;
    crops: number; cropsFailed: number;
}

export interface MaterialEvidence {
    target: string;
    views: ViewMaterialMask[];
    surfaces: SurfaceMaterialMask[];
    /** Why a source gave nothing (no tile, no views, every call failed), one sentence each. */
    unavailable: string[];
    models: string[];
    calls: number;
    failedCalls: number;
    ms: number;
}

/** What a segmentation call needs: one image (PNG bytes) and the description; returns a mask the image's size (0/255) or null when not found. */
export type SegmentImage = (png: Buffer, width: number, height: number, target: string, signal?: AbortSignal) => Promise<{ mask: Uint8Array | null; model?: string }>;

/** The segmenter tool (ObjectSegmenterService) as a SegmentImage: the image is written to a temp dir for the call. */
export function segmenterTool(): SegmentImage {
    const { ObjectSegmenterService } = require('../../video/ObjectSegmenterService') as typeof import('../../video/ObjectSegmenterService');
    const { getPythonWorkerPool } = require('../../process/persistent-python-worker') as typeof import('../../process/persistent-python-worker');
    const { repoPath, resolveRepoPython } = require('../../process/repo-python') as typeof import('../../process/repo-python');
    // the segmenter's Python worker pool (shared with vfx_segment_subject) may run SEGMENT_PYTHON_WORKERS masks at once
    // here: a facade is read in many crops, and one worker made the masks the stage's critical path
    getPythonWorkerPool({ pythonBinary: resolveRepoPython({ modules: ['numpy', 'cv2', 'mediapipe'], purpose: 'The object segmenter (scripts/segment_object.py)' }), scriptPath: repoPath('scripts', 'segment_object.py'), label: 'the object segmenter', maxWorkers: SEGMENT_PYTHON_WORKERS });
    const svc = new ObjectSegmenterService();
    return async (png, width, height, target, signal) => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-facade-mask-'));
        try {
            const img = path.join(dir, 'in.png');
            fs.writeFileSync(img, png);
            try {
                const r = await svc.segment({ imagePath: img, outputDir: path.join(dir, 'out'), target, refine: false, ...(signal ? { signal } : {}) });
                const dec = decodeImageInMemory(fs.readFileSync(r.maskPaths[0]));
                if (dec.width !== width || dec.height !== height) throw new Error(`the mask is ${dec.width}x${dec.height}, the image ${width}x${height}`);
                const m = new Uint8Array(width * height);
                for (let i = 0; i < m.length; i++) m[i] = dec.rgba[i * 4] >= 128 ? MASK_YES : MASK_NO;
                return { mask: m, ...(r.prompts.visionModel?.model ? { model: r.prompts.visionModel.model } : {}) };
            } catch (err) {
                // the model found none in this image: a real "not it" (any other failure is the caller's to count as unread)
                if ((err as { code?: string })?.code === 'segment_target_not_found') return { mask: null };
                throw err;
            }
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    };
}

/** Diagnostic (dev only): with SCRATCHBOX_FACADE_MATERIALS_DEBUG_DIR set, each read image is written there with its mask over it. */
function debugOverlay(name: string, img: DecodedImage, mask: Uint8Array): void {
    const dir = process.env.SCRATCHBOX_FACADE_MATERIALS_DEBUG_DIR;
    if (!dir) return;
    const rgb = new Uint8Array(img.width * img.height * 3);
    for (let i = 0; i < img.width * img.height; i++) {
        const m = mask[i], a = m === MASK_YES ? 0.55 : 0;
        const tint = m === MASK_UNREAD ? [40, 40, 40] : [255, 0, 200];
        for (let c = 0; c < 3; c++) rgb[i * 3 + c] = Math.round(img.rgba[i * 4 + c] * (m === MASK_UNREAD ? 0.5 : 1 - a) + (m === MASK_UNREAD ? 0 : tint[c] * a));
    }
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${name}.png`), encodePng(img.width, img.height, rgb, 3));
}

/** Runs `fn` over `items` with at most `n` at once. */
async function pool<T>(items: T[], n: number, fn: (x: T) => Promise<void>): Promise<void> {
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (next < items.length) await fn(items[next++]); }));
}

interface Crop { x0: number; y0: number; x1: number; y1: number }

function grid(width: number, height: number, cols: number, rows: number): Crop[] {
    const out: Crop[] = [];
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
        out.push({ x0: Math.round((c * width) / cols), x1: Math.round(((c + 1) * width) / cols), y0: Math.round((r * height) / rows), y1: Math.round(((r + 1) * height) / rows) });
    }
    return out;
}

function cropRgb(img: DecodedImage, c: Crop): { png: Buffer; w: number; h: number; empty: boolean } {
    const w = c.x1 - c.x0, h = c.y1 - c.y0;
    const rgb = new Uint8Array(w * h * 3);
    let filled = 0;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const s = ((c.y0 + y) * img.width + c.x0 + x) * 4, d = (y * w + x) * 3;
        rgb[d] = img.rgba[s]; rgb[d + 1] = img.rgba[s + 1]; rgb[d + 2] = img.rgba[s + 2];
        if (img.rgba[s + 3]) filled++;
    }
    return { png: encodePng(w, h, rgb, 3), w, h, empty: filled < 0.2 * w * h };
}

/** A cache of answers by image content (the same crop is read once per process, whichever layer asks). */
const answers = new Map<string, Promise<{ mask: Uint8Array | null; model?: string }>>();

async function segmentCrops(img: DecodedImage, crops: Crop[], target: string, segment: SegmentImage, out: Uint8Array, stats: { calls: number; failed: number; models: Set<string>; errors: string[] }, signal?: AbortSignal): Promise<{ failed: number }> {
    out.fill(MASK_UNREAD);
    let failed = 0;
    await pool(crops, 6, async c => {
        const { png, w, h, empty } = cropRgb(img, c);
        if (empty) return; // nothing to read (outside the tile's surface): stays unread
        const key = crypto.createHash('sha256').update(png).update(target).digest('hex');
        let p = answers.get(key);
        if (!p) { p = segment(png, w, h, target, signal); answers.set(key, p); p.catch(() => answers.delete(key)); stats.calls++; }
        try {
            const a = await p;
            if (a.model) stats.models.add(a.model);
            for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) out[(c.y0 + y) * img.width + c.x0 + x] = a.mask ? a.mask[y * w + x] : MASK_NO;
        } catch (err) {
            if (signal?.aborted) throw err;
            failed++; stats.failed++;
            if (stats.errors.length < 3) stats.errors.push((err as Error)?.message ?? String(err));
        }
    });
    return { failed };
}

const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const norm = (a: Vec3): Vec3 => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

/** The frontal frame of a planar face: h horizontal along it (or its chart u when it lies flat), w up it. */
export function faceFrame(normal: Vec3, chartU: Vec3): { h: Vec3; w: Vec3 } {
    const n = norm(normal);
    let h = Math.abs(n[1]) < 0.7 ? cross([0, 1, 0], n) : chartU;
    h = norm([h[0] - n[0] * dot(h, n), h[1] - n[1] * dot(h, n), h[2] - n[2] * dot(h, n)]);
    return { h, w: cross(n, h) };
}

/**
 * Renders one fitted planar face frontally from the tile (see SurfaceMaterialMask); alpha 0 where the tile has no surface
 * within `maxDistanceM` of the face. Returns undefined for a cylinder chart or a face too small to read.
 */
export async function tileFaceRaster(surface: Pick<FittedSurface, 'id' | 'chart'>, tile: Pick<TileTextureSurface, 'sample'>, opts: { mppM?: number; maxSide?: number; maxDistanceM?: number } = {}):
    Promise<{ frame: Omit<SurfaceMaterialMask, 'mask' | 'crops' | 'cropsFailed'>; image: DecodedImage } | undefined> {
    if (!('plane' in surface.chart)) return undefined;
    const p = surface.chart.plane;
    const n = norm(p.normal);
    const { h, w } = faceFrame(n, p.u);
    const pts = p.extentUv.map(([u, v]) => [p.origin[0] + p.u[0] * u + p.v[0] * v, p.origin[1] + p.u[1] * u + p.v[1] * v, p.origin[2] + p.u[2] * u + p.v[2] * v] as Vec3);
    if (pts.length < 3) return undefined;
    const as = pts.map(q => dot([q[0] - p.origin[0], q[1] - p.origin[1], q[2] - p.origin[2]], h));
    const bs = pts.map(q => dot([q[0] - p.origin[0], q[1] - p.origin[1], q[2] - p.origin[2]], w));
    const a0 = Math.min(...as), a1 = Math.max(...as), b0 = Math.min(...bs), b1 = Math.max(...bs);
    let mpp = opts.mppM ?? TILE_RASTER_MPP;
    const maxSide = opts.maxSide ?? TILE_RASTER_MAX_SIDE;
    mpp = Math.max(mpp, (a1 - a0) / maxSide, (b1 - b0) / maxSide);
    const W = Math.ceil((a1 - a0) / mpp), H = Math.ceil((b1 - b0) / mpp);
    if (W < 24 || H < 24) return undefined;
    const rgba = new Uint8Array(W * H * 4);
    const lum = new Float32Array(W * H).fill(NaN);
    const maxD = opts.maxDistanceM ?? 0.5;
    // the tile lookups run on the main thread: it is handed back every ~30 ms so the stage's other work keeps going
    let slice = Date.now();
    for (let r = 0; r < H; r++) for (let c = 0; c < W; c++) {
        if (c === 0 && Date.now() - slice > 30) { await new Promise(res => setImmediate(res)); slice = Date.now(); }
        const a = a0 + (c + 0.5) * mpp, b = b1 - (r + 0.5) * mpp;
        const P: Vec3 = [p.origin[0] + h[0] * a + w[0] * b, p.origin[1] + h[1] * a + w[1] * b, p.origin[2] + h[2] * a + w[2] * b];
        const s = tile.sample(P, n, maxD);
        if (!s) continue;
        const i = r * W + c;
        // the photo as it looks (before de-lighting) is what the segmenter should see; the de-lit colour when that is all there is
        const lin = s.litLinear ?? (s.rgb.map(x => Math.pow(Math.max(0, x) / 255, 2.2)) as Vec3);
        rgba[i * 4] = Math.round(linearToSrgb255(lin[0])); rgba[i * 4 + 1] = Math.round(linearToSrgb255(lin[1])); rgba[i * 4 + 2] = Math.round(linearToSrgb255(lin[2])); rgba[i * 4 + 3] = 255;
        lum[i] = 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
    }
    return { frame: { surfaceId: surface.id, origin: p.origin, h, w, normal: n, a0, b1, mppM: mpp, width: W, height: H, luminance: lum }, image: { width: W, height: H, rgba } };
}

/**
 * Planar faces measured on the scan, for a layer with no fitted faces (the tile is read on these instead): triangles grouped
 * by facing (5 degree bins) and plane offset (0.4 m bins), each group's plane the area-weighted mean, its extent the
 * member triangles' bounds in the face frame. Groups under `minAreaM2` are left out, and the ground (flat within 2.5 m of
 * the scan's lowest point); at most `max`, largest first.
 */
export function scanFacePlanes(mesh: { vertices: ArrayLike<number>; indices: ArrayLike<number> }, opts: { minAreaM2?: number; max?: number } = {}): Array<Pick<FittedSurface, 'id' | 'chart'>> {
    const V = mesh.vertices, I = mesh.indices;
    const minA = opts.minAreaM2 ?? 15, max = opts.max ?? 24;
    const groups = new Map<string, { area: number; n: Vec3; d: number; tris: number[] }>();
    // the ground the scan stands on is not a face to read (roofs are): flat groups within 2.5 m of the lowest point are left out
    let minY = Infinity;
    for (let i = 1; i < V.length; i += 3) if (V[i] < minY) minY = V[i];
    for (let t = 0; t + 2 < I.length; t += 3) {
        const a = I[t] * 3, b = I[t + 1] * 3, c = I[t + 2] * 3;
        const e1: Vec3 = [V[b] - V[a], V[b + 1] - V[a + 1], V[b + 2] - V[a + 2]], e2: Vec3 = [V[c] - V[a], V[c + 1] - V[a + 1], V[c + 2] - V[a + 2]];
        const cr = cross(e1, e2), len = Math.hypot(cr[0], cr[1], cr[2]);
        if (!(len > 1e-9)) continue;
        const n: Vec3 = [cr[0] / len, cr[1] / len, cr[2] / len], area = len / 2;
        const cen: Vec3 = [(V[a] + V[b] + V[c]) / 3, (V[a + 1] + V[b + 1] + V[c + 1]) / 3, (V[a + 2] + V[b + 2] + V[c + 2]) / 3];
        let key: string;
        if (n[1] > 0.9) { if (cen[1] < minY + 2.5) continue; key = `up:${Math.round(cen[1] / 0.4)}`; }
        else if (Math.abs(n[1]) < 0.3) key = `w:${Math.round(((Math.atan2(n[0], n[2]) * 180) / Math.PI) / 5)}:${Math.round(dot(n, cen) / 0.4)}`;
        else continue;
        const g = groups.get(key) ?? { area: 0, n: [0, 0, 0] as Vec3, d: 0, tris: [] };
        g.area += area; g.n = [g.n[0] + n[0] * area, g.n[1] + n[1] * area, g.n[2] + n[2] * area]; g.d += dot(n, cen) * area; g.tris.push(t);
        groups.set(key, g);
    }
    const out: Array<Pick<FittedSurface, 'id' | 'chart'>> = [];
    for (const g of [...groups.values()].filter(x => x.area >= minA).sort((x, y) => y.area - x.area).slice(0, max)) {
        const n = norm(g.n), d = g.d / g.area;
        const origin: Vec3 = [n[0] * d, n[1] * d, n[2] * d];
        const { h, w } = faceFrame(n, Math.abs(n[1]) < 0.7 ? [1, 0, 0] : [1, 0, 0]);
        let a0 = Infinity, a1 = -Infinity, b0 = Infinity, b1 = -Infinity;
        for (const t of g.tris) for (let k = 0; k < 3; k++) {
            const v = I[t + k] * 3, q: Vec3 = [V[v] - origin[0], V[v + 1] - origin[1], V[v + 2] - origin[2]];
            const a = dot(q, h), b = dot(q, w);
            a0 = Math.min(a0, a); a1 = Math.max(a1, a); b0 = Math.min(b0, b); b1 = Math.max(b1, b);
        }
        out.push({ id: `scan-p${out.length}`, chart: { plane: { origin, u: h, v: w, normal: n, extentUv: [[a0, b0], [a1, b0], [a1, b1], [a0, b1]] } } });
    }
    return out;
}

export interface GatherEvidenceInput {
    views: ProjectionView[];
    surfaces: Array<Pick<FittedSurface, 'id' | 'chart'>>;
    tile?: Pick<TileTextureSurface, 'sample'>;
    segment: SegmentImage;
    target?: string;
    signal?: AbortSignal;
    onProgress?: (m: string) => void;
}

/** Gathers both sources' masks (see the file comment). Never throws for a failed call: the crop stays unread. */
export async function gatherMaterialEvidence(input: GatherEvidenceInput): Promise<MaterialEvidence> {
    const t0 = Date.now();
    const target = input.target ?? FACADE_GLASS_TARGET;
    const stats = { calls: 0, failed: 0, models: new Set<string>(), errors: [] as string[] };
    const unavailable: string[] = [];
    const views: ViewMaterialMask[] = [];
    const surfaces: SurfaceMaterialMask[] = [];
    const jobs: Array<() => Promise<void>> = [];
    input.views.forEach((v, viewIndex) => {
        if (!(v.poseQuality > 0)) return;
        jobs.push(async () => {
            const img = v.image;
            const mask = new Uint8Array(img.width * img.height);
            const crops = grid(img.width, img.height, VIEW_CROP_GRID, VIEW_CROP_GRID);
            const { failed } = await segmentCrops(img, crops, target, input.segment, mask, stats, input.signal);
            views.push({ viewIndex, panoId: v.panoId, width: img.width, height: img.height, mask, crops: crops.length, cropsFailed: failed });
            debugOverlay(`view_${String(viewIndex).padStart(3, '0')}_${v.panoId.slice(0, 8)}`, img, mask);
        });
    });
    if (!input.views.length) unavailable.push('no registered Street View view to segment');
    if (input.tile) {
        const tile = input.tile;
        for (const s of input.surfaces) {
            jobs.push(async () => {
                const r = await tileFaceRaster(s, tile);
                if (!r) return;
                const mask = new Uint8Array(r.image.width * r.image.height);
                const cols = Math.max(1, Math.round((r.image.width * r.frame.mppM) / TILE_CROP_METRES)), rows = Math.max(1, Math.round((r.image.height * r.frame.mppM) / TILE_CROP_METRES));
                const crops = grid(r.image.width, r.image.height, cols, rows);
                const { failed } = await segmentCrops(r.image, crops, target, input.segment, mask, stats, input.signal);
                // where the tile has no surface the raster was not read
                for (let i = 0; i < mask.length; i++) if (!r.image.rgba[i * 4 + 3]) mask[i] = MASK_UNREAD;
                surfaces.push({ ...r.frame, mask, crops: crops.length, cropsFailed: failed });
                debugOverlay(`tile_${s.id}`, r.image, mask);
            });
        }
    } else unavailable.push('no photo-textured tile to read the faces from');
    input.onProgress?.(`reading ${target} in ${views.length + jobs.length} images (Street View views and tile faces)`);
    await pool(jobs, 4, async j => j());
    views.sort((a, b) => a.viewIndex - b.viewIndex);
    surfaces.sort((a, b) => (a.surfaceId < b.surfaceId ? -1 : 1));
    if (stats.calls && stats.failed === stats.calls) unavailable.push(`every segmentation call failed (${stats.errors[0] ?? 'no message'})`);
    return { target, views, surfaces, unavailable, models: [...stats.models], calls: stats.calls, failedCalls: stats.failed, ms: Date.now() - t0 };
}
