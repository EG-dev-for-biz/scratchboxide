/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Photo tier A of the texture pass (rung 0 above the multi-view projection): real Street View pixels rectified onto the
 * fitted planar faces.
 *
 * Geometry is set up here; the image work runs in OpenCV (packages/core/src/python/photo_tier/face_rectify.py, the project
 * .venv, one subprocess per layer run, charts in parallel threads):
 *
 *   - planar fitted charts (atlas maps with a plane chart) are grouped into facades by the heading of their normals; a facade
 *     picks the registered views that look at it;
 *   - each chart gets its own frontal camera on its own plane at twice the atlas density, the tile mesh's depth in it (culled to
 *     a +-3 m slab around the plane; relief: where the tile leaves the plane by more than 0.3 m the photo is not warped onto
 *     the plane), the texel region and the tile photo under it;
 *   - every view is placed by its registered pose: the joint registration (pano-joint-registration.ts) holds each wide view's
 *     face outline against the tile with its other terms, so the projection and this tier read the photos through one pose set;
 *   - the worker fuses (co-registration to a reference warp, cross-view agreement, Lab normalisation, per-pixel median per pano
 *     then over panos) and checks single-pano pixels for occluders (sky and vegetation colour, the tile's low-frequency colour);
 *     this module reads the result into the chart's texels (bilinear, inside the fused mask), de-lights them with the shared
 *     de-light (photogrammetric-delight.ts) and matches each chart's exposure to the ladder below it (relative gains).
 *
 * Every written texel is a real photo pixel moved by a homography: provenance 'street-view-rectified', label
 * 'photo-inferred', with the pano ids and capture dates; rung 0 where at least two panos agree, rung 1 where one pano
 * covers it. mergePhotoTier puts rung 0 over anything below and rung 1 only where the projection has nothing (what would
 * fall to the tile). Texels this tier leaves (non-planar relief, no view, cylinders, the scan's islands) stay for the rungs
 * below, each with a degradation that carries the measured reason.
 *
 * The geometry (depths, regions, tile) and the worker's warps are cached per layer (createPhotoTierCache) for the
 * leave-one-pano-out re-runs.
 *
 * The held-out score (the offline experiment's score.py) is computed by the worker on the same frames: one pano per facade
 * is left out of a second fusion; the tile render, the previous ladder (rungs below, as passed in) and photo tier A are
 * compared with it on the same pixels (geometry-edge chamfer, held-out gradient NCC and chamfer, invented-edge share,
 * sharpness, palette CIEDE2000). Only that second fusion is scored; the texels written use every pano.
 */

import { execFile } from 'child_process';
import { resolveRepoPython } from '../../process/repo-python';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { Vec3 } from '../../../common/spatial/staged-location-contracts';
import type { SurfaceChart } from '../../../common/spatial/staged-location-contracts';
import { delightLinearPlane, linearToSrgb255, PHOTOGRAMMETRIC_DELIGHT, SRGB8_TO_LINEAR, TEXTURE_LIFT_CAP } from '../../../common/spatial/photogrammetric-delight';
import {
    packConfidenceTexel, unpackConfidenceTexel,
    type BakedTexturePlanes, type PhotoTierFitScores, type PhotoTierLayerRecord, type ProjectionView, type TexelProvenance, type TexturePassDegradation, type UvAtlas
} from '../../../common/spatial/texture-pass-contracts';
import type { RenderMesh3D } from '../../spatial/HeadlessMeshSilhouetteRenderer';
import { projectToFrame, renderFrameDepth, type FrameCamera } from '../../spatial/StreetViewPoseRegistrar';
import { solveRelativeGains, type TexelSampleIndex, type ViewSamples } from './texel-exposure';
import { mergeBakedPlanes, type TileTextureSurface } from './tile-texture-transfer';

export const PHOTO_TIER_SOURCE = 'street-view-rectified';
/** Tile surface farther than this from a fitted plane is relief the plane does not carry (face_rectify.py RELIEF_TOL_M). */
export const PHOTO_TIER_RELIEF_TOLERANCE_M = 0.3;
/** Wall-like charts (|normal.y| below this) are rectified; floors, soffits and roofs are left to the rungs below. */
const WALL_MAX_NORMAL_Y = 0.5;
/** Charts whose normals' headings are within this join one facade. */
const FACADE_HEADING_TOLERANCE_DEG = 20;
const CHART_MAX_SIDE = 2400;
const SLAB_M = 3;
const CAMERA_DISTANCE_M = 30;
const MIN_CHART_TEXELS = 60;
export const PHOTO_TIER_TIMEOUT_MS = 240_000;
/** Cap of a chart's exposure gain to the ladder below (natural log, per channel). */
const MAX_TIER_LOG_GAIN = 0.4;
/** Weight of a ladder texel from the tile (rung 2 and below) against one from the projection in the exposure match. */
const TILE_GAIN_WEIGHT = 0.3;

export interface PhotoTierInput {
    atlas: Pick<UvAtlas, 'layerKey' | 'width' | 'height' | 'maps' | 'texels'>;
    surfaces: Array<{ id: string; chart: SurfaceChart }>;
    views: ProjectionView[];
    /** The full tile mesh: the relief check. */
    context: RenderMesh3D;
    /** The ladder's planes below this tier: the exposure match, and the held-out score. */
    previous?: BakedTexturePlanes;
    tile?: Pick<TileTextureSurface, 'sample'>;
    tileMaxDistanceM?: number;
    densityTexelsPerMeter: number;
    /** The layer's cache (createPhotoTierCache): the geometry set up once and the worker's warps, across runs of the same layer. */
    cache?: PhotoTierCache;
    /** Score against a held-out pano (default true). */
    heldOut?: boolean;
    pythonExecutable?: string;
    timeoutMs?: number;
    signal?: AbortSignal;
    onProgress?: (message: string) => void;
}

export interface PhotoTierResult {
    planes: BakedTexturePlanes;
    record: PhotoTierLayerRecord;
    degradations: TexturePassDegradation[];
    /** The worker's own report (placements per view, per chart counts); for diagnostics. */
    worker?: PhotoTierWorkerResult;
}

interface WorkerViewInfo { placement: string | null; reason?: string }
interface WorkerFacade {
    id: string; skipped?: string; reference?: string; heldOutPano?: string | null; seconds?: number;
    panos: Record<string, { views: number }>;
    views: Record<string, WorkerViewInfo>;
}
interface WorkerOccluder { singlePx: number; rejectedPx: number; sky: number; vegetation: number; tile: number; tileOffsetLab?: number[] }
interface WorkerChart {
    facade: string; regionPx: number; planeOffsetM?: number; nonPlanarPx: number; nonPlanarNoSurfacePx: number; nonPlanarP90M: number | null; nonPlanarMaxM: number | null;
    views: number; viewKeys?: string[]; panoIds?: string[]; dates?: string[]; coveredPx?: number; multiViewPx?: number; outW?: number; outH?: number; heldOutPx?: number; seconds?: number;
    /** Per placed view on this chart: co-registration inliers, gradient NCC to the reference warp (fused above 0.25). */
    viewInfo?: Record<string, { coreg?: number[]; gradNccToRef?: number | null; agreement?: string }>;
    occluder?: WorkerOccluder;
}
export interface PhotoTierWorkerResult {
    facades: WorkerFacade[];
    charts: Record<string, WorkerChart>;
    heldOut: { panoIds: string[]; methods: Record<string, PhotoTierFitScores> } | null;
    seconds: number;
    threads?: number;
}

// ------------------------------------------------------------------------------------------------ small vector maths
const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const mul = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const unit = (a: Vec3): Vec3 => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
const headingOf = (n: Vec3) => ((Math.atan2(n[0], -n[2]) * 180) / Math.PI + 360) % 360;
const angleDiff = (a: number, b: number) => { const d = Math.abs(a - b) % 360; return d > 180 ? 360 - d : d; };

/** A plane's in-plane basis: up = world up projected onto the plane, right = up x normal (FrameCamera: right x up = -fwd). */
function planeBasis(n: Vec3): { right: Vec3; up: Vec3 } {
    let up = sub([0, 1, 0], mul(n, n[1]));
    if (Math.hypot(...up) < 1e-3) up = sub([0, 0, -1], mul(n, -n[2]));
    up = unit(up);
    return { right: unit(cross(up, n)), up };
}

/** A frontal camera on a plane: pixel (x, y) sees the plane point centre + ((x + 0.5 - W/2) right - (y + 0.5 - H/2) up) * mpp. */
export interface PlaneFrame { cam: FrameCamera; W: number; H: number; mpp: number; centre: Vec3; normal: Vec3; right: Vec3; up: Vec3 }

export function frontalFrame(centre: Vec3, normal: Vec3, mpp: number, W: number, H: number): PlaneFrame {
    const n = unit(normal);
    const { right, up } = planeBasis(n);
    const eye = add(centre, mul(n, CAMERA_DISTANCE_M));
    const f = CAMERA_DISTANCE_M / mpp;
    return { cam: { eye, right, up, fwd: mul(n, -1), fx: f, fy: f, cx: W / 2, cy: H / 2, width: W, height: H }, W, H, mpp, centre, normal: n, right, up };
}

/** The frame scaled by 1/k (same plane window, k times coarser pixels). */
function coarser(fr: PlaneFrame, k: number): PlaneFrame {
    return frontalFrame(fr.centre, fr.normal, fr.mpp * k, Math.floor(fr.W / k), Math.floor(fr.H / k));
}

/** The plane point at the centre of frame pixel (x, y). */
function framePoint(fr: PlaneFrame, x: number, y: number): Vec3 {
    const a = (x + 0.5 - fr.W / 2) * fr.mpp, b = -(y + 0.5 - fr.H / 2) * fr.mpp;
    return add(fr.centre, add(mul(fr.right, a), mul(fr.up, b)));
}

/** Triangles of `mesh` inside the slab |signed distance to the plane| <= slab (any vertex) and the plane window (+ margin). */
export function cullToSlab(mesh: RenderMesh3D, fr: PlaneFrame, slabM: number, marginM: number): RenderMesh3D {
    const V = mesh.vertices, I = mesh.indices;
    const halfW = (fr.W * fr.mpp) / 2 + marginM, halfH = (fr.H * fr.mpp) / 2 + marginM;
    const keep: number[] = [];
    const inFront = (v: number) => (V[v * 3] - fr.centre[0]) * fr.normal[0] + (V[v * 3 + 1] - fr.centre[1]) * fr.normal[1] + (V[v * 3 + 2] - fr.centre[2]) * fr.normal[2];
    for (let t = 0; t < I.length; t += 3) {
        let near = false, minA = Infinity, maxA = -Infinity, minB = Infinity, maxB = -Infinity, allFront = true;
        for (let k = 0; k < 3; k++) {
            const v = I[t + k];
            const s = inFront(v);
            if (s <= slabM) allFront = false;
            if (Math.abs(s) <= slabM) near = true;
            const dx = V[v * 3] - fr.centre[0], dy = V[v * 3 + 1] - fr.centre[1], dz = V[v * 3 + 2] - fr.centre[2];
            const a = dx * fr.right[0] + dy * fr.right[1] + dz * fr.right[2], b = dx * fr.up[0] + dy * fr.up[1] + dz * fr.up[2];
            minA = Math.min(minA, a); maxA = Math.max(maxA, a); minB = Math.min(minB, b); maxB = Math.max(maxB, b);
        }
        if (allFront || !near) continue;
        if (maxA < -halfW || minA > halfW || maxB < -halfH || minB > halfH) continue;
        keep.push(I[t], I[t + 1], I[t + 2]);
    }
    return { vertices: V, indices: Uint32Array.from(keep) };
}

// ------------------------------------------------------------------------------------------------ charts and facades
interface ChartUnit {
    id: string; mapIndex: number; normal: Vec3; heading: number; texels: number[];
    /** Least-squares affine from plane coordinates (a, b) on the chart frame basis to atlas pixel centres. */
    toAtlas?: number[];
    frame?: PlaneFrame;
}

function chartUnits(atlas: PhotoTierInput['atlas'], surfaces: PhotoTierInput['surfaces']): { units: ChartUnit[]; skipped: { cylinder: number; floor: number; small: number; texels: number } } {
    const byId = new Map(surfaces.map(s => [s.id, s.chart]));
    const per = new Map<number, number[]>();
    const { covered, gutter, mapIndex } = atlas.texels;
    for (let i = 0; i < atlas.width * atlas.height; i++) {
        if (!covered[i] || gutter[i]) continue;
        const m = mapIndex[i];
        if (m === 65535) continue;
        let a = per.get(m); if (!a) per.set(m, a = []); a.push(i);
    }
    const units: ChartUnit[] = [];
    const skipped = { cylinder: 0, floor: 0, small: 0, texels: 0 };
    for (const [m, texels] of per) {
        const map = atlas.maps[m];
        const chart = map?.chartId ? byId.get(map.chartId) : undefined;
        if (!chart) continue; // a scan island: nothing analytic to rectify onto
        if (!('plane' in chart)) { skipped.cylinder++; skipped.texels += texels.length; continue; }
        const n = unit(chart.plane.normal);
        if (Math.abs(n[1]) >= WALL_MAX_NORMAL_Y) { skipped.floor++; skipped.texels += texels.length; continue; }
        if (texels.length < MIN_CHART_TEXELS) { skipped.small++; skipped.texels += texels.length; continue; }
        units.push({ id: `c${m}`, mapIndex: m, normal: n, heading: headingOf(n), texels });
    }
    return { units, skipped };
}

function groupFacades(units: ChartUnit[]): ChartUnit[][] {
    const sorted = [...units].sort((a, b) => b.texels.length - a.texels.length);
    const groups: Array<{ heading: number; units: ChartUnit[] }> = [];
    for (const u of sorted) {
        const g = groups.find(q => angleDiff(q.heading, u.heading) <= FACADE_HEADING_TOLERANCE_DEG);
        if (g) g.units.push(u); else groups.push({ heading: u.heading, units: [u] });
    }
    return groups.map(g => g.units);
}

function texelPos(atlas: PhotoTierInput['atlas'], i: number): Vec3 {
    const P = atlas.texels.position; return [P[i * 3], P[i * 3 + 1], P[i * 3 + 2]];
}

/** Window of a set of points on a plane basis: centre (on the plane through `origin`) and half extents. */
function windowOf(points: Vec3[], origin: Vec3, normal: Vec3): { centre: Vec3; halfA: number; halfB: number } {
    const { right, up } = planeBasis(normal);
    let a0 = Infinity, a1 = -Infinity, b0 = Infinity, b1 = -Infinity;
    for (const p of points) {
        const d = sub(p, origin); const a = dot(d, right), b = dot(d, up);
        a0 = Math.min(a0, a); a1 = Math.max(a1, a); b0 = Math.min(b0, b); b1 = Math.max(b1, b);
    }
    const centre = add(origin, add(mul(right, (a0 + a1) / 2), mul(up, (b0 + b1) / 2)));
    return { centre, halfA: (a1 - a0) / 2, halfB: (b1 - b0) / 2 };
}

function fitAffine(rows: Array<[number, number, number, number]>): number[] | undefined {
    // atlas x = p0 a + p1 b + p2, atlas y = p3 a + p4 b + p5 (normal equations, 3x3)
    const A = [[0, 0, 0], [0, 0, 0], [0, 0, 0]], bx = [0, 0, 0], by = [0, 0, 0];
    for (const [a, b, x, y] of rows) {
        const r = [a, b, 1];
        for (let i = 0; i < 3; i++) { for (let j = 0; j < 3; j++) A[i][j] += r[i] * r[j]; bx[i] += r[i] * x; by[i] += r[i] * y; }
    }
    const solve = (M: number[][], v: number[]): number[] | undefined => {
        const m = M.map((row, i) => [...row, v[i]]);
        for (let c = 0; c < 3; c++) {
            let p = c; for (let r = c + 1; r < 3; r++) if (Math.abs(m[r][c]) > Math.abs(m[p][c])) p = r;
            if (Math.abs(m[p][c]) < 1e-12) return undefined;
            [m[c], m[p]] = [m[p], m[c]];
            for (let r = 0; r < 3; r++) if (r !== c) { const f = m[r][c] / m[c][c]; for (let k = c; k < 4; k++) m[r][k] -= f * m[c][k]; }
        }
        return [m[0][3] / m[0][0], m[1][3] / m[1][1], m[2][3] / m[2][2]];
    };
    const px = solve(A, bx), py = solve(A, by);
    return px && py ? [...px, ...py] : undefined;
}

// ------------------------------------------------------------------------------------------------ python
function findUp(start: string, rel: string): string | undefined {
    let cur = start;
    for (let i = 0; i < 10; i++) {
        const p = path.join(cur, rel);
        if (fs.existsSync(p)) return p;
        const up = path.dirname(cur); if (up === cur) break; cur = up;
    }
    return undefined;
}

export function photoTierWorkerScript(): string | undefined {
    const here = typeof __dirname !== 'undefined' ? __dirname : process.cwd();
    const direct = path.resolve(here, '../../../python/photo_tier/face_rectify.py');
    if (fs.existsSync(direct)) return direct;
    return findUp(here, 'packages/core/src/python/photo_tier/face_rectify.py') ?? findUp(process.cwd(), 'packages/core/src/python/photo_tier/face_rectify.py');
}

/** The geometry of a layer's tier, set up once: the charts' frames, depths, regions and tile photos on disk, and the facades. */
interface TierGeometry {
    dir: string;
    layerKey: string;
    facades: Array<{ id: string; centre: Vec3; right: Vec3; up: Vec3; normal: Vec3; halfA: number; halfB: number; charts: Array<Record<string, unknown>> }>;
    units1: Map<string, { unit: ChartUnit; fr1: PlaneFrame }>;
    groups: number;
    heldOutFiles: boolean;
    ms: number;
}
/** One layer's cache across its runs (the main one and its leave-one-pano-out re-runs); `dispose` removes it. */
export interface PhotoTierCache { dir: string; dispose: () => void; geometry?: TierGeometry }
export function createPhotoTierCache(): PhotoTierCache {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb_photo_tier_cache_'));
    return { dir, dispose: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

export function photoTierPython(): string {
    return resolveRepoPython({ modules: ['numpy', 'cv2'], purpose: 'The photo tier face rectification (face_rectify.py)' });
}

function runWorker(python: string, script: string, dir: string, timeoutMs: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
        execFile(python, [script, dir], {
            timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, ...(signal ? { signal } : {}),
            env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: process.env.HOME ?? os.tmpdir(), TMPDIR: os.tmpdir(), PYTHONUNBUFFERED: '1', OMP_NUM_THREADS: '2' }
        }, (err, _stdout, stderr) => {
            if (err) {
                const tail = String(stderr ?? '').trim().split('\n').slice(-3).join(' | ');
                reject(new Error(`${(err as NodeJS.ErrnoException).code === 'ETIMEDOUT' || (err as { killed?: boolean }).killed ? `timed out after ${Math.round(timeoutMs / 1000)} s` : err.message}${tail ? `: ${tail}` : ''}`));
            } else resolve();
        });
    });
}

const camJson = (c: FrameCamera) => ({ eye: c.eye, right: c.right, up: c.up, fwd: c.fwd, fx: c.fx, fy: c.fy, cx: c.cx, cy: c.cy });

function writeF32(file: string, a: Float32Array): void { fs.writeFileSync(file, Buffer.from(a.buffer, a.byteOffset, a.byteLength)); }

// ------------------------------------------------------------------------------------------------ the tier
function emptyPlanes(atlas: PhotoTierInput['atlas']): BakedTexturePlanes {
    const n = atlas.width * atlas.height;
    return { layerKey: atlas.layerKey, width: atlas.width, height: atlas.height, albedo: new Uint8Array(n * 4), confidence: { width: atlas.width, height: atlas.height, data: new Uint8Array(n * 4) }, provenance: [], degradations: [] };
}

/** The charts' frames, depths, regions and tile photos (and, for the held-out score, the ladder below) written once per layer. */
function prepareGeometry(input: PhotoTierInput, units: ChartUnit[], dir: string, heldOutFiles: boolean): TierGeometry {
    const t0 = Date.now();
    const { atlas } = input;
    const facadeGroups = groupFacades(units);
    const units1 = new Map<string, { unit: ChartUnit; fr1: PlaneFrame }>();
    const facades: TierGeometry['facades'] = [];
    facadeGroups.forEach((group, gi) => {
        // the facade plane: texel-weighted mean normal through the texel centroid (for choosing the views that see it)
        let n: Vec3 = [0, 0, 0]; let c: Vec3 = [0, 0, 0]; let w = 0;
        for (const u of group) { n = add(n, mul(u.normal, u.texels.length)); for (const t of u.texels) c = add(c, texelPos(atlas, t)); w += u.texels.length; }
        n = unit(n); c = mul(c, 1 / w);
        const pts: Vec3[] = [];
        for (const u of group) for (const t of u.texels) pts.push(texelPos(atlas, t));
        const win = windowOf(pts, c, n);
        const { right, up } = planeBasis(n);
        const charts: Array<Record<string, unknown>> = [];
        for (const u of group) {
            const origin = texelPos(atlas, u.texels[0]);
            const upts = u.texels.map(t => texelPos(atlas, t));
            const uw = windowOf(upts, origin, u.normal);
            let mpp2 = 1 / (2 * input.densityTexelsPerMeter);
            const ha = uw.halfA + 4 * mpp2, hb = uw.halfB + 4 * mpp2;
            mpp2 = Math.max(mpp2, (2 * Math.max(ha, hb)) / CHART_MAX_SIDE);
            const W2 = 2 * Math.ceil(ha / mpp2), H2 = 2 * Math.ceil(hb / mpp2);
            const fr2 = frontalFrame(uw.centre, u.normal, mpp2, W2, H2);
            const fr1 = coarser(fr2, 2);
            u.frame = fr2;
            // atlas lookup: plane coordinates on the chart frame basis -> atlas pixel centre
            const rows: Array<[number, number, number, number]> = [];
            for (const t of u.texels) { const d = sub(texelPos(atlas, t), uw.centre); rows.push([dot(d, fr2.right), dot(d, fr2.up), (t % atlas.width) + 0.5, Math.floor(t / atlas.width) + 0.5]); }
            u.toAtlas = fitAffine(rows);
            if (!u.toAtlas) continue;
            const texelAt = (p: Vec3): number => {
                const d = sub(p, uw.centre); const a = dot(d, fr2.right), b = dot(d, fr2.up); const A = u.toAtlas!;
                const x = Math.floor(A[0] * a + A[1] * b + A[2]), y = Math.floor(A[3] * a + A[4] * b + A[5]);
                if (x < 0 || y < 0 || x >= atlas.width || y >= atlas.height) return -1;
                const i = y * atlas.width + x;
                return atlas.texels.mapIndex[i] === u.mapIndex && atlas.texels.covered[i] && !atlas.texels.gutter[i] ? i : -1;
            };
            const region = new Uint8Array(W2 * H2);
            for (let y = 0; y < H2; y++) for (let x = 0; x < W2; x++) if (texelAt(framePoint(fr2, x, y)) >= 0) region[y * W2 + x] = 1;
            const meshC = cullToSlab(input.context, fr2, SLAB_M, 1);
            writeF32(path.join(dir, `${u.id}_depth.f32`), renderFrameDepth(meshC, fr2.cam));
            fs.writeFileSync(path.join(dir, `${u.id}_region.u8`), region);
            const job: Record<string, unknown> = {
                id: u.id, region: path.join(dir, `${u.id}_region.u8`),
                frame: { cam: camJson(fr2.cam), W: W2, H: H2, mpp: mpp2, depth: path.join(dir, `${u.id}_depth.f32`), plane: { point: uw.centre, normal: u.normal } }
            };
            // the tile photo under the chart (the occluder check of single-pano pixels) and, for the held-out score, the ladder below
            const W1 = fr1.W, H1 = fr1.H;
            if (input.tile) {
                const tile = new Uint8Array(W1 * H1 * 4), maxD = input.tileMaxDistanceM ?? 0.25;
                for (let y = 0; y < H1; y++) for (let x = 0; x < W1; x++) {
                    const s = input.tile.sample(framePoint(fr1, x, y), u.normal, maxD); const o = (y * W1 + x) * 4;
                    if (s) { tile[o] = Math.max(0, Math.min(255, Math.round(s.rgb[0]))); tile[o + 1] = Math.max(0, Math.min(255, Math.round(s.rgb[1]))); tile[o + 2] = Math.max(0, Math.min(255, Math.round(s.rgb[2]))); tile[o + 3] = 255; }
                }
                fs.writeFileSync(path.join(dir, `${u.id}_tile.rgba`), tile);
                job.tile = path.join(dir, `${u.id}_tile.rgba`);
            }
            if (heldOutFiles && input.previous) {
                const prev = new Uint8Array(W1 * H1 * 4);
                for (let y = 0; y < H1; y++) for (let x = 0; x < W1; x++) {
                    const t = texelAt(framePoint(fr1, x, y)); const o = (y * W1 + x) * 4;
                    if (t >= 0 && input.previous.albedo[t * 4 + 3]) { prev.set(input.previous.albedo.subarray(t * 4, t * 4 + 3), o); prev[o + 3] = 255; }
                }
                fs.writeFileSync(path.join(dir, `${u.id}_prev.rgba`), prev);
                job.previous = path.join(dir, `${u.id}_prev.rgba`);
            }
            units1.set(u.id, { unit: u, fr1 });
            charts.push(job);
        }
        facades.push({ id: `f${gi}`, centre: win.centre, right, up, normal: n, halfA: win.halfA * 1.15 + 1, halfB: win.halfB * 1.15 + 1, charts });
    });
    return { dir, layerKey: atlas.layerKey, facades, units1, groups: facadeGroups.length, heldOutFiles, ms: Date.now() - t0 };
}

/** The views (indices into `views`) that look at a facade: in front of it and with its window in the frustum. */
function facadeViews(f: TierGeometry['facades'][number], views: ProjectionView[]): number[] {
    const out: number[] = [];
    views.forEach((v, vi) => {
        const toC = sub(f.centre, v.camera.eye);
        if (dot(unit(toC), f.normal) > -0.15) return; // behind or edge-on
        if (dot(toC, v.camera.fwd) <= 1) return;
        const corners = [f.centre, add(add(f.centre, mul(f.right, f.halfA)), mul(f.up, f.halfB)), add(sub(f.centre, mul(f.right, f.halfA)), mul(f.up, f.halfB)),
            sub(add(f.centre, mul(f.right, f.halfA)), mul(f.up, f.halfB)), sub(sub(f.centre, mul(f.right, f.halfA)), mul(f.up, f.halfB))];
        const W = v.camera.width, H = v.camera.height;
        const sees = corners.some(p => { const d = sub(p, v.camera.eye); const z = dot(d, v.camera.fwd); if (z <= 0.5) return false; const x = v.camera.cx + v.camera.fx * dot(d, v.camera.right) / z, y = v.camera.cy - v.camera.fy * dot(d, v.camera.up) / z; return x > -0.25 * W && x < 1.25 * W && y > -0.25 * H && y < 1.25 * H; });
        if (sees) out.push(vi);
    });
    return out;
}

/**
 * De-lights the tier's texels with the shared de-light (the projection's: shadow lift capped by local contrast, highlight
 * compression) and matches each chart's exposure to the ladder below it: the relative log-gain solve of the projection
 * (texel-exposure.ts solveRelativeGains) over the texels both have, the ladder as one view and each chart as another, the
 * ladder's tile texels weighted less than its projection texels; the gain is relative to the ladder, capped.
 */
function delightAndMatch(rgbLin: Float32Array, has: Uint8Array, chartOf: Int32Array, charts: number, atlas: PhotoTierInput['atlas'], below: BakedTexturePlanes | undefined, texelM: number):
    { delight: NonNullable<PhotoTierLayerRecord['delight']>; exposure?: NonNullable<PhotoTierLayerRecord['exposure']> } {
    const W = atlas.width, H = atlas.height, n = W * H;
    const rep = delightLinearPlane(rgbLin, has, W, H, PHOTOGRAMMETRIC_DELIGHT.defaults, { radiusTexels: TEXTURE_LIFT_CAP.radiusM / Math.max(1e-3, texelM), contrastGain: TEXTURE_LIFT_CAP.contrastGain });
    const delight = { texels: rep.texels, meanLiftKept: Math.round(rep.meanLiftKept * 1000) / 1000, liftHalvedTexels: rep.liftHalvedTexels };
    if (!below || !charts) return { delight };
    // views: 0 = the ladder below, 1 + c = chart c; samples on texels both cover
    const lists: number[][] = Array.from({ length: charts + 1 }, () => []);
    const weightOf: number[] = [];
    const overlap: number[] = [];
    for (let t = 0; t < n; t++) {
        if (!has[t] || chartOf[t] < 0 || !below.albedo[t * 4 + 3]) continue;
        const b = unpackConfidenceTexel(below.confidence, t);
        overlap.push(t); weightOf.push(b.covered && b.rung <= 1 ? 1 : TILE_GAIN_WEIGHT);
    }
    if (overlap.length < 50) return { delight };
    const views: ViewSamples[] = [];
    const sampleOf = Array.from({ length: charts + 1 }, () => new Map<number, number>());
    for (const t of overlap) { lists[0].push(t); lists[1 + chartOf[t]].push(t); }
    for (let k = 0; k <= charts; k++) {
        const texel = Int32Array.from(lists[k]), rgb = new Float32Array(texel.length * 3);
        texel.forEach((t, i) => {
            sampleOf[k].set(t, i);
            if (k === 0) for (let c = 0; c < 3; c++) rgb[i * 3 + c] = SRGB8_TO_LINEAR[below.albedo[t * 4 + c]];
            else for (let c = 0; c < 3; c++) rgb[i * 3 + c] = rgbLin[t * 3 + c];
        });
        views.push({ texel, rgb });
    }
    const start = new Int32Array(n + 1), view: number[] = [], sample: number[] = [], weight: number[] = [];
    let oi = 0;
    for (let t = 0; t < n; t++) {
        start[t] = view.length;
        if (oi < overlap.length && overlap[oi] === t) {
            const w = weightOf[oi++];
            view.push(0, 1 + chartOf[t]); sample.push(sampleOf[0].get(t)!, sampleOf[1 + chartOf[t]].get(t)!); weight.push(w / 2, w / 2);
        }
    }
    start[n] = view.length;
    const index: TexelSampleIndex = { start, view: Int32Array.from(view), sample: Int32Array.from(sample), weight: Float64Array.from(weight) };
    const g = solveRelativeGains(views, index, n);
    const gain: number[][] = [];
    let sumAbs = 0, maxAbs = 0, matched = 0;
    for (let c = 0; c < charts; c++) {
        if (!lists[1 + c].length) { gain.push([1, 1, 1]); continue; }
        const lg = [0, 1, 2].map(ch => Math.max(-MAX_TIER_LOG_GAIN, Math.min(MAX_TIER_LOG_GAIN, g.logGain[(1 + c) * 3 + ch] - g.logGain[ch])));
        matched++; for (const v of lg) { sumAbs += Math.abs(v) / 3; maxAbs = Math.max(maxAbs, Math.abs(v)); }
        gain.push(lg.map(Math.exp));
    }
    for (let t = 0; t < n; t++) if (has[t] && chartOf[t] >= 0) { const gc = gain[chartOf[t]]; for (let c = 0; c < 3; c++) rgbLin[t * 3 + c] *= gc[c]; }
    return { delight, exposure: { charts: matched, meanAbsLogGain: matched ? Math.round((sumAbs / matched) * 1000) / 1000 : 0, maxAbsLogGain: Math.round(maxAbs * 1000) / 1000 } };
}

/**
 * Puts the tier's texels into the ladder below: a texel at least two panos agree on (rung 0) replaces whatever is there; a
 * single-pano texel (rung 1) is written only where the ladder has no Street View projection texel (what would fall to the
 * tile, or nothing), never over the projection's single- or multi-view texels.
 */
export function mergePhotoTier(below: BakedTexturePlanes, tier: BakedTexturePlanes): { planes: BakedTexturePlanes; rung0Texels: number; rung1Texels: number; rung1KeptBelowTexels: number } {
    const n = tier.width * tier.height;
    const over: BakedTexturePlanes = { ...tier, albedo: Uint8Array.from(tier.albedo), confidence: { ...tier.confidence, data: Uint8Array.from(tier.confidence.data) } };
    let r0 = 0, r1 = 0, kept = 0;
    for (let i = 0; i < n; i++) {
        if (!over.albedo[i * 4 + 3]) continue;
        const o = unpackConfidenceTexel(over.confidence, i);
        if (o.rung === 0) { r0++; continue; }
        const b = unpackConfidenceTexel(below.confidence, i);
        if (below.albedo[i * 4 + 3] && b.covered && b.rung <= 1) { over.albedo[i * 4 + 3] = 0; over.confidence.data.fill(0, i * 4, i * 4 + 4); kept++; continue; }
        r1++;
    }
    // each entry's coverage shrinks by the share of its texels that stayed below
    const before = new Array<number>(tier.provenance.length).fill(0), after = new Array<number>(tier.provenance.length).fill(0);
    for (let i = 0; i < n; i++) {
        if (tier.albedo[i * 4 + 3]) before[tier.confidence.data[i * 4]]++;
        if (over.albedo[i * 4 + 3]) after[over.confidence.data[i * 4]]++;
    }
    over.provenance = tier.provenance.map((p, k) => ({ ...p, coverage: before[k] ? p.coverage * (after[k] / before[k]) : 0 }));
    return { planes: mergeBakedPlanes(below, over), rung0Texels: r0, rung1Texels: r1, rung1KeptBelowTexels: kept };
}

/** Runs photo tier A for one layer. Never throws for a data problem: an unusable source is a degradation and empty planes. */
export async function rectifyPhotoTier(input: PhotoTierInput): Promise<PhotoTierResult> {
    const t0 = Date.now();
    const { atlas } = input;
    const layerKey = atlas.layerKey;
    const planes = emptyPlanes(atlas);
    const degradations: TexturePassDegradation[] = [];
    let totalTexels = 0;
    for (let i = 0; i < atlas.width * atlas.height; i++) if (atlas.texels.covered[i] && !atlas.texels.gutter[i]) totalTexels++;
    const record: PhotoTierLayerRecord = { texelShare: 0, multiViewShare: 0, facades: 0, charts: 0, panos: 0, ms: 0 };
    const finish = (worker?: PhotoTierWorkerResult): PhotoTierResult => ({ planes, record: { ...record, ms: Date.now() - t0 }, degradations, ...(worker ? { worker } : {}) });
    const skip = (reasonCode: string, reason: string) => { degradations.push({ stage: 'photo-tier', reasonCode, layerKey, reason }); return finish(); };

    const { units, skipped } = chartUnits(atlas, input.surfaces);
    if (skipped.texels) {
        degradations.push({ stage: 'photo-tier', reasonCode: 'photo_tier_not_a_wall_plane', layerKey, texelShare: skipped.texels / Math.max(1, totalTexels),
            reason: `${skipped.cylinder} cylindrical, ${skipped.floor} floor/soffit/roof and ${skipped.small} very small fitted charts are not rectified by the photo tier (it warps photos onto wall planes only); the rungs below colour them.` });
    }
    if (!units.length) return skip('photo_tier_no_planar_face', 'The layer has no fitted planar wall face, so the rectified Street View tier does not apply; the rungs below colour it.');
    if (!input.views.length) return skip('photo_tier_no_views', 'No registered Street View view is available for the rectified photo tier.');
    if (!input.context.indices.length) return skip('photo_tier_no_tile_mesh', 'The tile mesh is not available, so the photo tier cannot check the faces against the scan.');
    const script = photoTierWorkerScript();
    if (!script) return skip('photo_tier_worker_missing', 'The photo tier worker (packages/core/src/python/photo_tier/face_rectify.py) is not on disk.');
    const python = input.pythonExecutable ?? photoTierPython();

    const heldOut = input.heldOut !== false;
    // the geometry: once per layer when a cache is given (the leave-one-pano-out re-runs reuse it)
    let geomOwned: string | undefined;
    let geo = input.cache?.geometry;
    let setupMs = 0;
    if (!geo || geo.layerKey !== layerKey || (heldOut && !geo.heldOutFiles && input.previous)) {
        const gdir = input.cache ? fs.mkdtempSync(path.join(input.cache.dir, 'geom_')) : (geomOwned = fs.mkdtempSync(path.join(os.tmpdir(), 'sb_photo_tier_geom_')));
        geo = prepareGeometry(input, units, gdir, heldOut);
        setupMs = geo.ms;
        if (input.cache) input.cache.geometry = geo;
    }
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb_photo_tier_'));
    try {
        const progress = (m: string) => input.onProgress?.(m);
        const viewUsed = new Set<number>();
        const jobFacades = geo.facades.map(f => {
            const vs = facadeViews(f, input.views);
            vs.forEach(v => viewUsed.add(v));
            return { id: f.id, views: vs.map(v => `v${v}`), charts: heldOut ? f.charts : f.charts.map(c => { const { previous: _p, ...rest } = c; return rest; }) };
        });
        const jobViews = [...viewUsed].sort((a, b) => a - b).map(vi => {
            const v = input.views[vi];
            fs.writeFileSync(path.join(dir, `v${vi}.rgba`), v.image.rgba);
            return { key: `v${vi}`, panoId: v.panoId, date: v.captureDate ?? null, file: `v${vi}.rgba`, width: v.image.width, height: v.image.height, cam: camJson(v.camera as FrameCamera) };
        });
        if (!jobViews.length) return skip('photo_tier_no_views', 'No registered Street View view looks at a fitted wall face of this layer.');
        fs.writeFileSync(path.join(dir, 'job.json'), JSON.stringify({ facades: jobFacades, views: jobViews, heldOut, ...(input.cache ? { cacheDir: path.join(input.cache.dir, 'worker') } : {}), ...(process.env.SCRATCHBOX_PHOTO_TIER_KEEP ? { debug: true } : {}) }));
        progress(`rectifying ${jobViews.length} Street View views onto ${geo.units1.size} fitted faces (${geo.groups} facades) at their registered poses`);
        const tW = Date.now();
        try {
            await runWorker(python, script, dir, input.timeoutMs ?? PHOTO_TIER_TIMEOUT_MS, input.signal);
        } catch (err) {
            if (input.signal?.aborted) throw err;
            return skip('photo_tier_failed', `The rectified photo tier failed (${(err as Error).message}); the projection and the rungs below colour the layer.`);
        }
        const workerMs = Date.now() - tW;
        const worker = JSON.parse(fs.readFileSync(path.join(dir, 'result.json'), 'utf8')) as PhotoTierWorkerResult;

        for (const f of worker.facades) if (f.skipped) degradations.push({ stage: 'photo-tier', reasonCode: 'photo_tier_facade_no_views', layerKey, reason: `Facade ${f.id}: ${f.skipped}; its faces are left to the projection and the rungs below.` });
        // views placed but not fused: they disagree with the reference warp (a wrong match, another appearance, a different era)
        const disagree = new Map<string, number[]>();
        for (const ch of Object.values(worker.charts)) for (const [k, v] of Object.entries(ch.viewInfo ?? {})) {
            if (typeof v.gradNccToRef !== 'number' || v.gradNccToRef > 0.25) continue;
            const pid = jobViews.find(j => j.key === k)?.panoId ?? k;
            let a = disagree.get(pid); if (!a) disagree.set(pid, a = []); a.push(v.gradNccToRef);
        }
        for (const [pid, nccs] of disagree) {
            degradations.push({ stage: 'photo-tier', reasonCode: 'photo_tier_view_disagrees', layerKey,
                reason: `Pano ${pid.slice(0, 6)}: ${nccs.length} placed view-on-face warp${nccs.length === 1 ? '' : 's'} disagree with the reference photo (gradient NCC ${Math.min(...nccs).toFixed(2)}-${Math.max(...nccs).toFixed(2)}, below 0.25), so ${nccs.length === 1 ? 'it is' : 'they are'} not fused.` });
        }

        // texels: read, then de-light and match the exposure, then write
        const n = atlas.width * atlas.height;
        const rgbLin = new Float32Array(n * 3), has = new Uint8Array(n), rungOf = new Uint8Array(n), chartOf = new Int32Array(n).fill(-1), facadeOf: string[] = [];
        const chartIds: string[] = [];
        let nonPlanarTexels = 0, npMax = 0;
        const np90: number[] = [];
        const panosUsed = new Set<string>();
        const occ = { singlePx: 0, rejectedPx: 0, sky: 0, vegetation: 0, tile: 0 };
        const chartPanos = new Map<string, { panoIds: string[]; dates: string[]; views: number; facade: string }>();
        for (const [id, { unit: u, fr1 }] of geo.units1) {
            const ch = worker.charts[id];
            if (!ch) continue;
            if (ch.nonPlanarPx > 0 && ch.regionPx > 0) {
                nonPlanarTexels += (ch.nonPlanarPx / ch.regionPx) * u.texels.length;
                if (ch.nonPlanarP90M !== null) np90.push(ch.nonPlanarP90M);
                if (ch.nonPlanarMaxM !== null) npMax = Math.max(npMax, ch.nonPlanarMaxM);
            }
            if (ch.occluder) for (const k of Object.keys(occ) as Array<keyof typeof occ>) occ[k] += ch.occluder[k] ?? 0;
            if (!ch.views || !ch.outW || !ch.outH) continue;
            const W1 = ch.outW, H1 = ch.outH;
            if (W1 !== fr1.W || H1 !== fr1.H) throw new Error(`photo tier: chart ${id} came back ${W1}x${H1}, expected ${fr1.W}x${fr1.H}`);
            const rgb = fs.readFileSync(path.join(dir, `${id}_fused.rgb`)), mask = fs.readFileSync(path.join(dir, `${id}_mask.u8`));
            const ci = chartIds.length; chartIds.push(id);
            chartPanos.set(id, { panoIds: ch.panoIds ?? [], dates: ch.dates ?? [], views: ch.views, facade: ch.facade });
            // the worker rectified on the tile's surface, `planeOffsetM` along the normal from the fitted face: a texel reads the
            // photo where its normal meets that surface
            const off = ch.planeOffsetM ?? 0;
            for (const t of u.texels) {
                const q = projectToFrame(fr1.cam, add(texelPos(atlas, t), mul(u.normal, off)));
                if (!q) continue;
                const x = q[0] - 0.5, y = q[1] - 0.5;
                const x0 = Math.floor(x), y0 = Math.floor(y), tx = x - x0, ty = y - y0;
                if (x0 < 0 || y0 < 0 || x0 + 1 >= W1 || y0 + 1 >= H1) continue;
                const i00 = y0 * W1 + x0, i10 = i00 + 1, i01 = i00 + W1, i11 = i01 + 1;
                const m = Math.min(mask[i00], mask[i10], mask[i01], mask[i11]);
                if (!m) continue;
                for (let k = 0; k < 3; k++) rgbLin[t * 3 + k] = SRGB8_TO_LINEAR[Math.round(rgb[i00 * 3 + k] * (1 - tx) * (1 - ty) + rgb[i10 * 3 + k] * tx * (1 - ty) + rgb[i01 * 3 + k] * (1 - tx) * ty + rgb[i11 * 3 + k] * tx * ty)];
                has[t] = 1; rungOf[t] = m >= 2 ? 0 : 1; chartOf[t] = ci; facadeOf[ci] = ch.facade;
            }
            for (const p of ch.panoIds ?? []) panosUsed.add(p);
        }
        const tD = Date.now();
        const dm = delightAndMatch(rgbLin, has, chartOf, chartIds.length, atlas, input.previous, 1 / Math.max(1e-6, input.densityTexelsPerMeter));
        record.delight = dm.delight;
        if (dm.exposure) record.exposure = dm.exposure;
        const delightMs = Date.now() - tD;
        type Entry = { facade: string; rung: number; panoIds: Set<string>; dates: Set<string>; views: number };
        const entries: Entry[] = [];
        const entryIndex = (facade: string, rung: number) => {
            let k = entries.findIndex(e => e.facade === facade && e.rung === rung);
            if (k < 0) { entries.push({ facade, rung, panoIds: new Set(), dates: new Set(), views: 0 }); k = entries.length - 1; }
            return k;
        };
        let written = 0, multi = 0;
        for (let t = 0; t < n; t++) {
            if (!has[t]) continue;
            const rung = rungOf[t], cid = chartIds[chartOf[t]], cp = chartPanos.get(cid)!;
            const e = entryIndex(cp.facade, rung);
            const en = entries[e];
            for (const p of cp.panoIds) en.panoIds.add(p);
            for (const d of cp.dates) en.dates.add(d);
            en.views = Math.max(en.views, cp.views);
            planes.albedo.set([Math.round(linearToSrgb255(rgbLin[t * 3])), Math.round(linearToSrgb255(rgbLin[t * 3 + 1])), Math.round(linearToSrgb255(rgbLin[t * 3 + 2])), 255], t * 4);
            packConfidenceTexel(planes.confidence, t, e, rung === 0 ? 0.9 : 0.6, rung);
            written++; if (rung === 0) multi++;
        }
        const facadeRep = new Map(worker.facades.map(f => [f.id, f]));
        planes.provenance = entries.map((e): TexelProvenance => {
            const f = facadeRep.get(e.facade);
            return {
                source: PHOTO_TIER_SOURCE, label: 'photo-inferred',
                method: `rectified Street View (facade ${e.facade}): views at their registered poses (joint registration with the face outline), per-face plane homography into a frontal camera, SIFT co-registration to reference pano ${f?.reference?.slice(0, 6) ?? '?'}; Lab-normalised per-pixel median of up to ${e.views} views per pano then over panos${e.rung === 0 ? ', at least two panos agreeing' : ', one pano (no cross-check): passed the sky, vegetation and tile-colour occluder check'}; de-lit, exposure matched to the ladder below`,
                panoIds: [...e.panoIds].sort(), captureDates: [...e.dates].sort(), coverage: 0
            };
        });
        const totalCovered = Math.max(1, totalTexels);
        const counts = new Array<number>(entries.length).fill(0);
        for (let i = 0; i < n; i++) if (planes.albedo[i * 4 + 3]) counts[planes.confidence.data[i * 4]]++;
        planes.provenance.forEach((p, k) => { p.coverage = counts[k] / totalCovered; });

        if (nonPlanarTexels >= 1) {
            np90.sort((a, b) => a - b);
            degradations.push({ stage: 'photo-tier', reasonCode: 'photo_tier_non_planar', layerKey, texelShare: Math.min(1, nonPlanarTexels / totalCovered), fromRung: 0, toRung: 0,
                reason: `non-planar region: photo tier needs better geometry. ${Math.round(nonPlanarTexels)} texels of the fitted faces lie where the tile surface leaves the face by more than ${PHOTO_TIER_RELIEF_TOLERANCE_M} m (median of the per-face 90th percentiles ${np90.length ? np90[Math.floor(np90.length / 2)].toFixed(2) : '?'} m, up to ${npMax.toFixed(2)} m, or no tile surface at all); the photos are not warped onto that geometry, the rungs below colour it.` });
            record.nonPlanar = { texelShare: Math.min(1, nonPlanarTexels / totalCovered), p90DeviationM: np90.length ? np90[Math.floor(np90.length / 2)] : 0, maxDeviationM: npMax };
        }
        if (occ.rejectedPx) {
            degradations.push({ stage: 'photo-tier', reasonCode: 'photo_tier_occluder_rejected', layerKey,
                reason: `Of ${occ.singlePx} rectified pixels only one pano covers, ${occ.rejectedPx} (with a ${Math.round(0.15 * 100)} cm margin) were not written because they do not look like the face: ${occ.sky} sky-coloured, ${occ.vegetation} vegetation-coloured, ${occ.tile} off the tile's low-frequency colour; the projection and the rungs below colour them.` });
        }
        record.occluderCheck = occ;
        record.texelShare = written / totalCovered;
        record.multiViewShare = multi / totalCovered;
        record.facades = worker.facades.filter(f => !f.skipped).length;
        record.charts = Object.values(worker.charts).filter(c => c.views > 0).length;
        record.panos = panosUsed.size;
        record.timingsMs = { setup: setupMs, worker: workerMs, workerCharts: Math.round(worker.seconds * 1000), delight: delightMs, threads: worker.threads ?? 1 };
        if (worker.heldOut) record.heldOut = { panoIds: worker.heldOut.panoIds, mppM: 1 / input.densityTexelsPerMeter, methods: worker.heldOut.methods };
        else if (heldOut) degradations.push({ stage: 'photo-tier', reasonCode: 'photo_tier_no_held_out_score', layerKey, reason: 'No facade had a second pano to hold out, so the photo tier has no held-out score on this layer.' });
        return finish(worker);
    } finally {
        // SCRATCHBOX_PHOTO_TIER_KEEP=<dir>: keep the worker's inputs and outputs there (diagnostics)
        const keep = process.env.SCRATCHBOX_PHOTO_TIER_KEEP;
        if (keep) { const to = path.join(keep, `${layerKey}_${Date.now()}`); fs.mkdirSync(keep, { recursive: true }); fs.cpSync(dir, to, { recursive: true }); fs.cpSync(geo.dir, path.join(to, 'geom'), { recursive: true }); }
        fs.rmSync(dir, { recursive: true, force: true });
        if (geomOwned) fs.rmSync(geomOwned, { recursive: true, force: true });
    }
}
