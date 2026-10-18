/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Street View survey planning for projective texturing of a photogrammetric scan (plan E2-E4).
 *
 *   E2  Pano discovery: street points are sampled on the scan's open-ground mask (DSM close to the
 *       local terrain) every `sampleSpacingMeters` within `radiusMeters` of the anchor, plus points
 *       on sightlines perpendicular to each hero facade. Each point is resolved with the (free)
 *       Street View metadata API; panos are de-duplicated and only Google captures are kept. Pano
 *       lat/lng are placed in the scan frame with LocalTangentPlane; the eye sits `cameraHeight`
 *       above the local street (median of up-facing triangles within 4 m).
 *   E3  Coverage-driven frame selection: per pano a depth cube map decides which hero samples are
 *       visible; candidate frames (heading toward each visible target region, pitch 0-60, fov in
 *       {30, 45, 60, 90}) are scored by the quality-weighted area they newly cover (cos^2 times the
 *       resolution gain over the tile texture) and picked greedily (lazy greedy), at most
 *       `maxFramesPerPano` per pano and `maxFrames` in total.
 *   E4  Fetch: Street View Static frames are cached by pano/heading/pitch/fov; a persistent ledger
 *       hard-caps billed image requests. Request URLs carry the API key and are never logged.
 *
 * Every parameter (ground, hero footprint, facade orientations, texel sizes) is measured from the
 * scan at runtime; nothing is specific to one building. Frame: x = East, y = Up, z = South.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { RenderMesh3D } from './HeadlessMeshSilhouetteRenderer';
import { LocalTangentPlane } from '../../common/coordinate/LocalTangentPlane';
import { fetchStreetViewPanoMetadata } from './StreetViewPanoramaProjectionService';
import { StreetViewRestyleService } from './StreetViewRestyleService';
import { frameCamera, renderFrameDepth, streetViewForward, ZERO_CORRECTION, readGlbScene, sceneToRenderMesh, readJpegSize, type FrameCamera } from './StreetViewPoseRegistrar';
import { mapLimit } from '../../common/map-limit';

const DEG = Math.PI / 180;

// ============================================================================================
// Anchor / frame
// ============================================================================================

export interface GeodeticOrigin {
    lat: number;
    lng: number;
    /** Height of the scan-frame origin (the tile extractor's ellipsoid height). */
    heightMeters: number;
}

/** Parses "lat,lng[,h]". */
export function parseAnchor(text: string): GeodeticOrigin {
    const parts = text.split(',').map(s => Number(s.trim()));
    if (parts.length < 2 || parts.some(v => !Number.isFinite(v))) throw new Error(`Invalid anchor "${text}" (expected lat,lng[,height])`);
    return { lat: parts[0], lng: parts[1], heightMeters: parts[2] ?? 0 };
}

/** Scan-frame (x = E, z = -N) position of a lat/lng at the origin height. */
export function geodeticToScan(origin: GeodeticOrigin, lat: number, lng: number): { x: number; z: number } {
    const ltp = new LocalTangentPlane({ lat: origin.lat, lng: origin.lng, alt: origin.heightMeters });
    const p = ltp.toLocal({ lat, lng, alt: origin.heightMeters });
    return { x: p[0], z: p[2] };
}

export function scanToGeodetic(origin: GeodeticOrigin, x: number, y: number, z: number): { lat: number; lng: number; alt: number } {
    const ltp = new LocalTangentPlane({ lat: origin.lat, lng: origin.lng, alt: origin.heightMeters });
    const g = ltp.toLatLng([x, y, z]);
    return { lat: g.lat, lng: g.lng, alt: g.alt ?? 0 };
}

// ============================================================================================
// Scan loading: positions, indices and per-triangle tile texel size (from UVs + image sizes)
// ============================================================================================

export interface ScanMesh {
    /** Renderable mesh (world space, node transforms applied). */
    mesh: RenderMesh3D;
    triCount: number;
    /** Unit face normal (arbitrary sign: photogrammetry winding is mixed). */
    triNormal: Float32Array;
    triArea: Float32Array;
    triCentroid: Float32Array;
    /** Metres per source-texture texel on the triangle (NaN when unknown). */
    triTexelMeters: Float32Array;
    bounds: { min: [number, number, number]; max: [number, number, number] };
}

/** Reads a binary glTF into a world-space triangle mesh with per-triangle tile texel sizes. */
export function loadScanMesh(glbPath: string): ScanMesh {
    const prims = readGlbScene(glbPath);
    const mesh = sceneToRenderMesh(prims);
    const V = mesh.vertices as Float32Array, I = mesh.indices as Uint32Array;
    const nt = I.length / 3;
    const triTexelMeters = new Float32Array(nt).fill(NaN);
    let t0 = 0;
    for (const p of prims) {
        const n = p.indices.length / 3;
        if (p.uvs && p.imageSize) {
            const { width: W, height: H } = p.imageSize;
            for (let t = 0; t < n; t++) {
                const a = p.indices[t * 3], b = p.indices[t * 3 + 1], c = p.indices[t * 3 + 2];
                const P = p.positions;
                const ux = P[b * 3] - P[a * 3], uy = P[b * 3 + 1] - P[a * 3 + 1], uz = P[b * 3 + 2] - P[a * 3 + 2];
                const vx = P[c * 3] - P[a * 3], vy = P[c * 3 + 1] - P[a * 3 + 1], vz = P[c * 3 + 2] - P[a * 3 + 2];
                const area3 = 0.5 * Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx);
                const du1 = (p.uvs[b * 2] - p.uvs[a * 2]) * W, dv1 = (p.uvs[b * 2 + 1] - p.uvs[a * 2 + 1]) * H;
                const du2 = (p.uvs[c * 2] - p.uvs[a * 2]) * W, dv2 = (p.uvs[c * 2 + 1] - p.uvs[a * 2 + 1]) * H;
                const areaTex = 0.5 * Math.abs(du1 * dv2 - dv1 * du2);
                if (areaTex > 1e-6 && area3 > 1e-8) triTexelMeters[t0 + t] = Math.sqrt(area3 / areaTex);
            }
        }
        t0 += n;
    }
    const triNormal = new Float32Array(nt * 3), triArea = new Float32Array(nt), triCentroid = new Float32Array(nt * 3);
    const min: [number, number, number] = [Infinity, Infinity, Infinity], max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < V.length; i += 3) for (let k = 0; k < 3; k++) { min[k] = Math.min(min[k], V[i + k]); max[k] = Math.max(max[k], V[i + k]); }
    for (let t = 0; t < nt; t++) {
        const a = I[t * 3] * 3, b = I[t * 3 + 1] * 3, c = I[t * 3 + 2] * 3;
        const ux = V[b] - V[a], uy = V[b + 1] - V[a + 1], uz = V[b + 2] - V[a + 2];
        const vx = V[c] - V[a], vy = V[c + 1] - V[a + 1], vz = V[c + 2] - V[a + 2];
        const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
        const l = Math.hypot(nx, ny, nz);
        triArea[t] = 0.5 * l;
        if (l > 1e-12) { triNormal[t * 3] = nx / l; triNormal[t * 3 + 1] = ny / l; triNormal[t * 3 + 2] = nz / l; }
        triCentroid[t * 3] = (V[a] + V[b] + V[c]) / 3; triCentroid[t * 3 + 1] = (V[a + 1] + V[b + 1] + V[c + 1]) / 3; triCentroid[t * 3 + 2] = (V[a + 2] + V[b + 2] + V[c + 2]) / 3;
    }
    return { mesh, triCount: nt, triNormal, triArea, triCentroid, triTexelMeters, bounds: { min, max } };
}

// ============================================================================================
// Ground model: DSM, robust DTM, open-ground mask
// ============================================================================================

export interface GroundModel {
    cellMeters: number;
    x0: number; z0: number; nx: number; nz: number;
    /** Highest surface per cell (NaN = no data). */
    top: Float32Array;
    /** Local terrain per cell. */
    ground: Float32Array;
    /** 1 where the cell is open ground (top within `openToleranceMeters` of the terrain, above or below). */
    open: Uint8Array;
    /** How the terrain was measured: the walkable street surface, or (no walkable surface found) a low percentile. */
    terrainMethod: 'walkable-surface' | 'low-percentile';
    /** Cells of the walkable surface the terrain was measured on (1), or undefined for the low-percentile terrain. */
    walkable?: Uint8Array;
    /** Cells whose surface was masked as tree canopy (1), when a canopy mask was applied. */
    canopy?: Uint8Array;
    cellIndex(x: number, z: number): number;
    groundAt(x: number, z: number): number;
    topAt(x: number, z: number): number;
}

export interface GroundModelOptions {
    cellMeters?: number;          // default 1
    /** Terrain block size: the terrain is a smooth surface through block values. Default 8 m. */
    blockMeters?: number;
    /** Half-window (metres) of the low-percentile terrain (used only when no walkable surface is found). Default 32. */
    terrainRadiusMeters?: number;
    openToleranceMeters?: number; // default 1.5
    /** Cells to leave out of the terrain measurement (tree canopy, from tile_vegetation's classifier). */
    exclude?: (x: number, z: number) => boolean;
}

/**
 * The walkable surface. Cells whose surfaces join with steps of at most WALKABLE_RISE_PER_M x cell (min
 * WALKABLE_STEP_MIN_M) form surfaces; a surface most of whose rim steps down is a top (a roof, a crown, a car), the
 * rest are open surfaces. The street is the open surface the most structure rises from (rim contacts where a cell at
 * least WALKABLE_FOOT_RISE_M higher stands on a surface that is not itself open, less the rim where it steps down onto
 * another open surface): every building fronts a street, while water and sunken gardens meet mostly the street's own
 * retaining walls, and a plinth or quay above the street steps down onto it. Other open surfaces join the street when they lie
 * within WALKABLE_JOIN_TOLERANCE_M of the terrain through it (street fragments cut apart by canopy, courtyards at grade).
 */
export const WALKABLE_RISE_PER_M = 0.5;
export const WALKABLE_STEP_MIN_M = 0.3;
export const WALKABLE_FOOT_RISE_M = 3.0;
export const WALKABLE_TOP_RIM_FRACTION = 0.5;
export const WALKABLE_MIN_AREA_M2 = 16;
export const WALKABLE_JOIN_TOLERANCE_M = 1.0;
/** How many of the strongest open surfaces are tried as the street's level. */
export const WALKABLE_LEVEL_CANDIDATES = 8;

function percentile(values: number[], q: number): number {
    if (!values.length) return NaN;
    const a = values.slice().sort((x, y) => x - y);
    return a[Math.min(a.length - 1, Math.max(0, Math.floor(q * (a.length - 1))))];
}

/** The walkable street surface (1 per cell), or undefined when no open surface has structure rising from it. */
export function walkableSurface(top: Float32Array, nx: number, nz: number, cell: number, usable: Uint8Array): Uint8Array | undefined {
    const N = nx * nz;
    const step = Math.max(WALKABLE_STEP_MIN_M, WALKABLE_RISE_PER_M * cell);
    const label = new Int32Array(N).fill(-1);
    const area: number[] = [];
    const stack: number[] = [];
    for (let s = 0; s < N; s++) {
        if (label[s] >= 0 || !usable[s]) continue;
        const id = area.length;
        area.push(0);
        label[s] = id; stack.push(s);
        while (stack.length) {
            const c = stack.pop()!;
            area[id]++;
            const i = c % nx, k = (c / nx) | 0;
            for (let q = 0; q < 4; q++) {
                const ii = i + (q === 0 ? 1 : q === 1 ? -1 : 0), kk = k + (q === 2 ? 1 : q === 3 ? -1 : 0);
                if (ii < 0 || kk < 0 || ii >= nx || kk >= nz) continue;
                const n = kk * nx + ii;
                if (label[n] >= 0 || !usable[n] || Math.abs(top[n] - top[c]) > step) continue;
                label[n] = id; stack.push(n);
            }
        }
    }
    const R = area.length;
    if (!R) return undefined;
    // rim contacts: up (the neighbour is higher) and down
    const up = new Float64Array(R), down = new Float64Array(R);
    const eachContact = (fn: (lo: number, hi: number) => void) => {
        for (let k = 0; k < nz; k++) for (let i = 0; i < nx; i++) {
            const c = k * nx + i;
            if (label[c] < 0) continue;
            if (i + 1 < nx) { const n = c + 1; if (label[n] >= 0 && label[n] !== label[c]) top[n] > top[c] ? fn(c, n) : fn(n, c); }
            if (k + 1 < nz) { const n = c + nx; if (label[n] >= 0 && label[n] !== label[c]) top[n] > top[c] ? fn(c, n) : fn(n, c); }
        }
    };
    eachContact((lo, hi) => { up[label[lo]]++; down[label[hi]]++; });
    const minCells = Math.max(1, Math.round(WALKABLE_MIN_AREA_M2 / (cell * cell)));
    const isOpen = (r: number) => area[r] >= minCells && down[r] <= WALKABLE_TOP_RIM_FRACTION * (up[r] + down[r]);
    // structure feet: a cell standing WALKABLE_FOOT_RISE_M or more above an open surface, on a surface that is not open
    // less the rim where it steps down onto another open surface (a plinth, a terrace or a quay above the street: what stands
    // on it stands above the street too)
    const feet = new Float64Array(R);
    eachContact((lo, hi) => {
        if (!isOpen(label[lo])) return;
        if (!isOpen(label[hi])) { if (top[hi] - top[lo] >= WALKABLE_FOOT_RISE_M) feet[label[lo]]++; } else feet[label[hi]]--;
    });
    // the street is one level: each of the strongest open surfaces is grown by the open surfaces at its level (fragments cut
    // apart by canopy or traffic, courtyards at grade), and the level the most structure rises from wins
    const candidates = [...Array(R).keys()].filter(r => isOpen(r) && feet[r] > 0).sort((p, q) => feet[q] - feet[p]).slice(0, WALKABLE_LEVEL_CANDIDATES);
    if (!candidates.length) return undefined;
    let best: { walk: Uint8Array; score: number } | undefined;
    for (const seed of candidates) {
        const walk = new Uint8Array(N);
        for (let c = 0; c < N; c++) if (label[c] === seed) walk[c] = 1;
        const terrain = terrainThrough(top, nx, nz, cell, walk, 8);
        const dev: number[][] = Array.from({ length: R }, () => []);
        for (let c = 0; c < N; c++) { const r = label[c]; if (r >= 0 && r !== seed && isOpen(r)) dev[r].push(top[c] - terrain[c]); }
        let score = feet[seed];
        const joins = new Uint8Array(R);
        for (let r = 0; r < R; r++) if (dev[r].length && Math.abs(percentile(dev[r], 0.5)) <= WALKABLE_JOIN_TOLERANCE_M) { joins[r] = 1; score += Math.max(0, feet[r]); }
        if (best && score <= best.score) continue;
        for (let c = 0; c < N; c++) if (label[c] >= 0 && joins[label[c]]) walk[c] = 1;
        best = { walk, score };
    }
    return best!.walk;
}

/**
 * A smooth terrain through the walkable cells: per block the lower quartile of the walkable surface, blocks without any
 * filled from their neighbours (nearest first, then relaxed so the fill is smooth), bilinear to cells.
 */
function terrainThrough(top: Float32Array, nx: number, nz: number, cell: number, walk: Uint8Array, blockMeters: number): Float32Array {
    const bs = Math.max(1, Math.round(blockMeters / cell));
    const bnx = Math.ceil(nx / bs), bnz = Math.ceil(nz / bs);
    const B = new Float32Array(bnx * bnz).fill(NaN);
    const measured = new Uint8Array(bnx * bnz);
    for (let bk = 0; bk < bnz; bk++) for (let bi = 0; bi < bnx; bi++) {
        const vals: number[] = [];
        for (let k = bk * bs; k < Math.min(nz, (bk + 1) * bs); k++) for (let i = bi * bs; i < Math.min(nx, (bi + 1) * bs); i++) {
            const c = k * nx + i;
            if (walk[c]) vals.push(top[c]);
        }
        if (vals.length >= Math.max(2, Math.round(bs * bs * 0.05))) { B[bk * bnx + bi] = percentile(vals, 0.25); measured[bk * bnx + bi] = 1; }
    }
    // fill outward from the measured blocks: each pass gives an empty block the mean of its filled 8-neighbours
    for (let changed = true; changed;) {
        changed = false;
        const next = Float32Array.from(B);
        for (let bk = 0; bk < bnz; bk++) for (let bi = 0; bi < bnx; bi++) {
            const b = bk * bnx + bi;
            if (B[b] === B[b]) continue;
            let s = 0, w = 0;
            for (let dk = -1; dk <= 1; dk++) for (let di = -1; di <= 1; di++) {
                const ii = bi + di, kk = bk + dk;
                if (ii < 0 || kk < 0 || ii >= bnx || kk >= bnz) continue;
                const v = B[kk * bnx + ii];
                if (v === v) { s += v; w++; }
            }
            if (w) { next[b] = s / w; changed = true; }
        }
        B.set(next);
    }
    // relax the filled blocks (Laplace, measured blocks fixed) so a large footprint gets a smooth surface, not rings
    for (let it = 0; it < 64; it++) {
        const next = Float32Array.from(B);
        for (let bk = 0; bk < bnz; bk++) for (let bi = 0; bi < bnx; bi++) {
            const b = bk * bnx + bi;
            if (measured[b] || B[b] !== B[b]) continue;
            let s = 0, w = 0;
            for (const [di, dk] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
                const ii = bi + di, kk = bk + dk;
                if (ii < 0 || kk < 0 || ii >= bnx || kk >= bnz) continue;
                const v = B[kk * bnx + ii];
                if (v === v) { s += v; w++; }
            }
            if (w) next[b] = s / w;
        }
        B.set(next);
    }
    return blocksToCells(B, bnx, bnz, bs, nx, nz);
}

function blocksToCells(blocks: Float32Array, bnx: number, bnz: number, bs: number, nx: number, nz: number): Float32Array {
    const ground = new Float32Array(nx * nz);
    const bg = (i: number, k: number) => {
        i = Math.min(bnx - 1, Math.max(0, i)); k = Math.min(bnz - 1, Math.max(0, k));
        return blocks[k * bnx + i];
    };
    for (let k = 0; k < nz; k++) for (let i = 0; i < nx; i++) {
        const fx = (i + 0.5) / bs - 0.5, fz = (k + 0.5) / bs - 0.5;
        const i0 = Math.floor(fx), k0 = Math.floor(fz), tx = fx - i0, tz = fz - k0;
        const vals = [[bg(i0, k0), (1 - tx) * (1 - tz)], [bg(i0 + 1, k0), tx * (1 - tz)], [bg(i0, k0 + 1), (1 - tx) * tz], [bg(i0 + 1, k0 + 1), tx * tz]];
        let s = 0, w = 0;
        for (const [v, ww] of vals) if (v === v) { s += v * ww; w += ww; }
        ground[k * nx + i] = w > 0 ? s / w : NaN;
    }
    return ground;
}

/** The surface model (highest surface per cell) of a scan on a `cell` grid; `include` limits it to some triangles. */
export function surfaceModel(scan: ScanMesh, cell: number, include?: (triangle: number) => boolean): { x0: number; z0: number; nx: number; nz: number; top: Float32Array } {
    const x0 = Math.floor(scan.bounds.min[0]), z0 = Math.floor(scan.bounds.min[2]);
    const nx = Math.ceil((scan.bounds.max[0] - x0) / cell) + 1, nz = Math.ceil((scan.bounds.max[2] - z0) / cell) + 1;
    const top = new Float32Array(nx * nz).fill(NaN);
    const V = scan.mesh.vertices, I = scan.mesh.indices;
    const splat = (x: number, y: number, z: number) => {
        const i = Math.floor((x - x0) / cell), k = Math.floor((z - z0) / cell);
        if (i < 0 || k < 0 || i >= nx || k >= nz) return;
        const c = k * nx + i;
        if (!(top[c] >= y)) top[c] = y;
    };
    for (let t = 0; t < scan.triCount; t++) {
        if (include && !include(t)) continue;
        const a = I[t * 3] * 3, b = I[t * 3 + 1] * 3, c = I[t * 3 + 2] * 3;
        const ext = Math.max(Math.hypot(V[b] - V[a], V[b + 2] - V[a + 2]), Math.hypot(V[c] - V[a], V[c + 2] - V[a + 2]), Math.hypot(V[c] - V[b], V[c + 2] - V[b + 2]));
        const n = Math.max(1, Math.ceil(ext / (cell * 0.6)));
        for (let i = 0; i <= n; i++) for (let j = 0; j <= n - i; j++) {
            const u = i / n, v = j / n, w = 1 - u - v;
            splat(V[a] * w + V[b] * u + V[c] * v, V[a + 1] * w + V[b + 1] * u + V[c + 1] * v, V[a + 2] * w + V[b + 2] * u + V[c + 2] * v);
        }
    }
    return { x0, z0, nx, nz, top };
}

/** The low-percentile terrain (10th percentile per block, 15th of the blocks within the radius): no walkable surface found. */
function lowPercentileTerrain(top: Float32Array, nx: number, nz: number, cell: number, usable: Uint8Array, block: number, radius: number): Float32Array {
    const bs = Math.max(1, Math.round(block / cell));
    const bnx = Math.ceil(nx / bs), bnz = Math.ceil(nz / bs);
    const blockLow = new Float32Array(bnx * bnz).fill(NaN);
    for (let bk = 0; bk < bnz; bk++) for (let bi = 0; bi < bnx; bi++) {
        const vals: number[] = [];
        for (let k = bk * bs; k < Math.min(nz, (bk + 1) * bs); k++) for (let i = bi * bs; i < Math.min(nx, (bi + 1) * bs); i++) {
            const c = k * nx + i;
            if (usable[c]) vals.push(top[c]);
        }
        if (vals.length >= bs) blockLow[bk * bnx + bi] = percentile(vals, 0.1);
    }
    const br = Math.max(1, Math.round(radius / block));
    const blockGround = new Float32Array(bnx * bnz).fill(NaN);
    for (let bk = 0; bk < bnz; bk++) for (let bi = 0; bi < bnx; bi++) {
        const vals: number[] = [];
        for (let k = Math.max(0, bk - br); k <= Math.min(bnz - 1, bk + br); k++) for (let i = Math.max(0, bi - br); i <= Math.min(bnx - 1, bi + br); i++) {
            if ((k - bk) ** 2 + (i - bi) ** 2 > br * br) continue;
            const v = blockLow[k * bnx + i]; if (v === v) vals.push(v);
        }
        blockGround[bk * bnx + bi] = percentile(vals, 0.15);
    }
    return blocksToCells(blockGround, bnx, bnz, bs, nx, nz);
}

/**
 * Surface model and terrain. The terrain is measured on the walkable street surface (walkableSurface): water, sunken
 * gardens and roofs never define it. Only when no walkable surface with structure rising from it exists (a scan of a
 * single roof, open country) does it fall back to a low percentile of the surface model.
 */
export function buildGroundModel(scan: ScanMesh, opts: GroundModelOptions = {}): GroundModel {
    const cell = opts.cellMeters ?? 1, block = opts.blockMeters ?? 8, radius = opts.terrainRadiusMeters ?? 32, openTol = opts.openToleranceMeters ?? 1.5;
    const { x0, z0, nx, nz, top } = surfaceModel(scan, cell);
    const usable = new Uint8Array(nx * nz);
    for (let k = 0; k < nz; k++) for (let i = 0; i < nx; i++) {
        const c = k * nx + i;
        usable[c] = top[c] === top[c] && !(opts.exclude && opts.exclude(x0 + (i + 0.5) * cell, z0 + (k + 0.5) * cell)) ? 1 : 0;
    }
    const walkable = walkableSurface(top, nx, nz, cell, usable);
    const ground = walkable ? terrainThrough(top, nx, nz, cell, walkable, block) : lowPercentileTerrain(top, nx, nz, cell, usable, block, radius);
    const open = new Uint8Array(nx * nz);
    for (let c = 0; c < nx * nz; c++) open[c] = top[c] === top[c] && ground[c] === ground[c] && Math.abs(top[c] - ground[c]) <= openTol ? 1 : 0;
    const cellIndex = (x: number, z: number) => {
        const i = Math.floor((x - x0) / cell), k = Math.floor((z - z0) / cell);
        return i < 0 || k < 0 || i >= nx || k >= nz ? -1 : k * nx + i;
    };
    return {
        cellMeters: cell, x0, z0, nx, nz, top, ground, open, cellIndex,
        terrainMethod: walkable ? 'walkable-surface' : 'low-percentile', ...(walkable ? { walkable } : {}),
        groundAt: (x, z) => { const c = cellIndex(x, z); return c < 0 ? NaN : ground[c]; },
        topAt: (x, z) => { const c = cellIndex(x, z); return c < 0 ? NaN : top[c]; }
    };
}

/** Street height under (x, z): median y of up-facing triangles whose centroid is within `radius`; DTM fallback. */
export function localStreetHeight(scan: ScanMesh, ground: GroundModel, x: number, z: number, radius = 4): number {
    const ys: number[] = [];
    for (let t = 0; t < scan.triCount; t++) {
        const cx = scan.triCentroid[t * 3], cz = scan.triCentroid[t * 3 + 2];
        if (Math.abs(cx - x) > radius || Math.abs(cz - z) > radius) continue;
        if ((cx - x) ** 2 + (cz - z) ** 2 > radius * radius) continue;
        if (Math.abs(scan.triNormal[t * 3 + 1]) < 0.9) continue;
        const y = scan.triCentroid[t * 3 + 1];
        const g = ground.groundAt(cx, cz);
        if (g === g && Math.abs(y - g) > 3) continue; // canopies, car roofs, awnings
        ys.push(y);
    }
    if (ys.length) return percentile(ys, 0.5);
    return ground.groundAt(x, z);
}

// ============================================================================================
// Hero footprint and target samples
// ============================================================================================

export interface HeroModel {
    /** Cell mask of the footprint (on the ground model grid), dilated by `dilateMeters`. */
    footprint: Uint8Array;
    centroid: { x: number; z: number };
    /** Median terrain height around the footprint. */
    groundY: number;
    /** Dominant facade orientation (deg, mod 90) of near-vertical hero faces. */
    gridYawDeg: number;
    /** Outward facade headings (deg clockwise from north) of the four sides. */
    sideHeadingsDeg: number[];
    areaM2: number;
    heightMeters: number;
}

export interface HeroOptions {
    anchor?: { x: number; z: number };
    /** Cells this far above the terrain belong to tall structure. Default 20 m. */
    minHeightAboveGroundMeters?: number;
    dilateMeters?: number; // default 2
}

/** The DSM component above `minHeightAboveGround` connected to the anchor (searched within 30 m of it). */
export function findHeroFootprint(scan: ScanMesh, ground: GroundModel, opts: HeroOptions = {}): HeroModel {
    const a = opts.anchor ?? { x: 0, z: 0 };
    const minH = opts.minHeightAboveGroundMeters ?? 20, dil = opts.dilateMeters ?? 2;
    const { nx, nz, top, cellMeters: cell } = ground;
    const tall = new Uint8Array(nx * nz);
    for (let c = 0; c < nx * nz; c++) tall[c] = top[c] === top[c] && ground.ground[c] === ground.ground[c] && top[c] - ground.ground[c] >= minH ? 1 : 0;
    let seed = ground.cellIndex(a.x, a.z);
    if (seed < 0 || !tall[seed]) {
        let best = -1, bestD = Infinity;
        const r = Math.ceil(30 / cell);
        const ai = Math.floor((a.x - ground.x0) / cell), ak = Math.floor((a.z - ground.z0) / cell);
        for (let k = ak - r; k <= ak + r; k++) for (let i = ai - r; i <= ai + r; i++) {
            if (i < 0 || k < 0 || i >= nx || k >= nz || !tall[k * nx + i]) continue;
            const d = (i - ai) ** 2 + (k - ak) ** 2;
            if (d < bestD) { bestD = d; best = k * nx + i; }
        }
        if (best < 0) throw new Error('findHeroFootprint: no tall structure near the anchor');
        seed = best;
    }
    const comp = new Uint8Array(nx * nz);
    const stack = [seed]; comp[seed] = 1;
    while (stack.length) {
        const c = stack.pop()!;
        const i = c % nx, k = (c / nx) | 0;
        for (let dk = -1; dk <= 1; dk++) for (let di = -1; di <= 1; di++) {
            const ii = i + di, kk = k + dk;
            if (ii < 0 || kk < 0 || ii >= nx || kk >= nz) continue;
            const n = kk * nx + ii;
            if (tall[n] && !comp[n]) { comp[n] = 1; stack.push(n); }
        }
    }
    const r = Math.ceil(dil / cell);
    const footprint = new Uint8Array(nx * nz);
    let sx = 0, sz = 0, cnt = 0, hmax = -Infinity;
    for (let c = 0; c < nx * nz; c++) {
        if (!comp[c]) continue;
        const i = c % nx, k = (c / nx) | 0;
        sx += ground.x0 + (i + 0.5) * cell; sz += ground.z0 + (k + 0.5) * cell; cnt++;
        hmax = Math.max(hmax, top[c] - ground.ground[c]);
        for (let dk = -r; dk <= r; dk++) for (let di = -r; di <= r; di++) {
            const ii = i + di, kk = k + dk;
            if (ii >= 0 && kk >= 0 && ii < nx && kk < nz && di * di + dk * dk <= r * r) footprint[kk * nx + ii] = 1;
        }
    }
    // Terrain under the footprint ring
    const ring: number[] = [];
    for (let c = 0; c < nx * nz; c++) if (footprint[c] && !comp[c] && ground.ground[c] === ground.ground[c]) ring.push(ground.ground[c]);
    const groundY = percentile(ring.length ? ring : [ground.ground[seed]], 0.5);
    // Dominant facade orientation: area-weighted histogram of normal azimuth mod 90 over near-vertical hero faces
    const hist = new Float64Array(180);
    for (let t = 0; t < scan.triCount; t++) {
        const ny = scan.triNormal[t * 3 + 1];
        if (Math.abs(ny) > 0.15 || scan.triArea[t] < 0.5) continue;
        const ci = ground.cellIndex(scan.triCentroid[t * 3], scan.triCentroid[t * 3 + 2]);
        if (ci < 0 || !footprint[ci]) continue;
        let az = Math.atan2(scan.triNormal[t * 3], -scan.triNormal[t * 3 + 2]) / DEG;
        az = ((az % 90) + 90) % 90;
        hist[Math.min(179, Math.floor(az * 2))] += scan.triArea[t];
    }
    let bestBin = 0, bestVal = -1;
    for (let b = 0; b < 180; b++) {
        let s = 0;
        for (let d = -2; d <= 2; d++) s += hist[(b + d + 180) % 180];
        if (s > bestVal) { bestVal = s; bestBin = b; }
    }
    // Circular mean (period 90) within +-2 deg of the peak
    let cs = 0, sn = 0;
    for (let d = -4; d <= 4; d++) {
        const b = (bestBin + d + 180) % 180;
        const ang = ((b + 0.5) / 2) * 4 * DEG;
        cs += Math.cos(ang) * hist[b]; sn += Math.sin(ang) * hist[b];
    }
    const gridYawDeg = ((Math.atan2(sn, cs) / DEG / 4) + 90) % 90;
    const centroid = { x: sx / cnt, z: sz / cnt };
    return {
        footprint, centroid, groundY, gridYawDeg,
        sideHeadingsDeg: facadeSideHeadings(scan, ground, footprint, centroid, gridYawDeg),
        areaM2: cnt * cell * cell, heightMeters: hmax
    };
}

/**
 * Outward facade headings of the hero, found in the scan (no assumed side count): an area-weighted histogram of
 * the outward normal heading of near-vertical hero faces (1 deg bins, +-4 deg smoothing); every peak with at least
 * 15 % of the highest, at least 30 deg from a stronger one and holding at least 8 % of the facade area within
 * +-10 deg, becomes a side (heading refined by a circular mean within +-8 deg). A rectangular tower yields its 4
 * faces, a triangular one 3, an octagonal one 8. When fewer than 3 sides stand out or they hold less than 60 % of
 * the facade area (round or irregular plans), 8 sectors of 45 deg starting at the dominant orientation are used.
 */
export function facadeSideHeadings(scan: ScanMesh, ground: GroundModel, footprint: Uint8Array, centroid: { x: number; z: number }, gridYawDeg: number): number[] {
    const hist = new Float64Array(360);
    for (let t = 0; t < scan.triCount; t++) {
        let nx = scan.triNormal[t * 3], nz = scan.triNormal[t * 3 + 2];
        if (Math.abs(scan.triNormal[t * 3 + 1]) > 0.15 || scan.triArea[t] < 0.5) continue;
        const cx = scan.triCentroid[t * 3], cz = scan.triCentroid[t * 3 + 2];
        const ci = ground.cellIndex(cx, cz);
        if (ci < 0 || !footprint[ci]) continue;
        if (nx * (cx - centroid.x) + nz * (cz - centroid.z) < 0) { nx = -nx; nz = -nz; }
        const hd = ((Math.atan2(nx, -nz) / DEG) + 360) % 360;
        hist[Math.floor(hd) % 360] += scan.triArea[t];
    }
    const sm = new Float64Array(360);
    for (let b = 0; b < 360; b++) for (let d = -4; d <= 4; d++) sm[b] += hist[(b + d + 360) % 360];
    const max = Math.max(...sm);
    const cand: number[] = [];
    for (let b = 0; b < 360; b++) if (max > 0 && sm[b] >= 0.15 * max && sm[b] >= sm[(b + 359) % 360] && sm[b] > sm[(b + 1) % 360]) cand.push(b);
    cand.sort((a, b) => sm[b] - sm[a]);
    const peaks: number[] = [];
    const circ = (a: number, b: number) => { const d = Math.abs(a - b) % 360; return d > 180 ? 360 - d : d; };
    const total = hist.reduce((a, b) => a + b, 0);
    const share = (b: number) => { let a = 0; for (let d = -10; d <= 10; d++) a += hist[(b + d + 360) % 360]; return total > 0 ? a / total : 0; };
    // a side is a real concentration of facade area (>= 8 % within +-10 deg; a round plan spreads ~5.6 % there)
    for (const b of cand) if (share(b) >= 0.08 && peaks.every(p => circ(p, b) >= 30)) peaks.push(b);
    const covered = peaks.reduce((a, b) => a + share(b), 0);
    if (peaks.length < 3 || covered < 0.6) return Array.from({ length: 8 }, (_, k) => (gridYawDeg + 45 * k) % 360);
    return peaks.map(b => {
        let c = 0, s = 0;
        for (let d = -8; d <= 8; d++) { const k = (b + d + 360) % 360, a = (k + 0.5) * DEG; c += Math.cos(a) * hist[k]; s += Math.sin(a) * hist[k]; }
        return ((Math.atan2(s, c) / DEG) + 360) % 360;
    }).sort((a, b) => a - b);
}

export interface TargetSamples {
    count: number;
    pos: Float32Array;
    /** Outward unit normal (away from the hero axis for walls, up for roofs). */
    normal: Float32Array;
    area: Float32Array;
    texel: Float32Array;
    heightAboveGround: Float32Array;
    /** Facade side index into HeroModel.sideHeadingsDeg (0 .. facadeSides - 1), or facadeSides for roofs / terraces. */
    side: Uint8Array;
    /** Number of facade sides (HeroModel.sideHeadingsDeg.length); side === facadeSides marks roofs / terraces. */
    facadeSides: number;
    band: Uint8Array;
    triangle: Uint32Array;
}

/** Height bands (metres above the hero ground) used for coverage reporting. */
export const HEIGHT_BANDS: Array<[number, number]> = [[0, 30], [30, 60], [60, 90], [90, 120], [120, 200], [200, Infinity]];

export function bandIndex(h: number): number {
    for (let b = 0; b < HEIGHT_BANDS.length; b++) if (h < HEIGHT_BANDS[b][1]) return b;
    return HEIGHT_BANDS.length - 1;
}

/** Area-weighted stratified samples (about one per `areaPerSampleM2`) on hero triangles above the street. */
export function buildTargetSamples(scan: ScanMesh, ground: GroundModel, hero: HeroModel, areaPerSampleM2 = 2): TargetSamples {
    const pos: number[] = [], nrm: number[] = [], area: number[] = [], texel: number[] = [], hag: number[] = [], side: number[] = [], band: number[] = [], tri: number[] = [];
    const V = scan.mesh.vertices, I = scan.mesh.indices;
    const finiteTexels = Array.from(scan.triTexelMeters).filter(v => v === v);
    const medianTexel = finiteTexels.length ? percentile(finiteTexels, 0.5) : 0.5;
    for (let t = 0; t < scan.triCount; t++) {
        const A = scan.triArea[t];
        if (A < 1e-4) continue;
        const cx = scan.triCentroid[t * 3], cy = scan.triCentroid[t * 3 + 1], cz = scan.triCentroid[t * 3 + 2];
        const ci = ground.cellIndex(cx, cz);
        if (ci < 0 || !hero.footprint[ci] || cy < hero.groundY + 1) continue;
        let nx = scan.triNormal[t * 3], ny = scan.triNormal[t * 3 + 1], nz = scan.triNormal[t * 3 + 2];
        let s: number;
        if (Math.abs(ny) < 0.3) {
            if (nx * (cx - hero.centroid.x) + nz * (cz - hero.centroid.z) < 0) { nx = -nx; ny = -ny; nz = -nz; }
            const hd = ((Math.atan2(nx, -nz) / DEG) + 360) % 360;
            s = 0; let bd = 1e9;
            hero.sideHeadingsDeg.forEach((h, k) => { let d = Math.abs(hd - h) % 360; if (d > 180) d = 360 - d; if (d < bd) { bd = d; s = k; } });
        } else {
            if (ny < 0) { nx = -nx; ny = -ny; nz = -nz; }
            s = hero.sideHeadingsDeg.length;
        }
        const n = Math.max(1, Math.round(A / areaPerSampleM2));
        const a = I[t * 3] * 3, b = I[t * 3 + 1] * 3, c = I[t * 3 + 2] * 3;
        const tx = scan.triTexelMeters[t] === scan.triTexelMeters[t] ? scan.triTexelMeters[t] : medianTexel;
        for (let k = 0; k < n; k++) {
            // low-discrepancy barycentric points (R2 sequence folded into the triangle)
            let u = (0.5 + k * 0.7548776662466927) % 1, v = (0.5 + k * 0.5698402909980532) % 1;
            if (u + v > 1) { u = 1 - u; v = 1 - v; }
            const w = 1 - u - v;
            const px = V[a] * w + V[b] * u + V[c] * v, py = V[a + 1] * w + V[b + 1] * u + V[c + 1] * v, pz = V[a + 2] * w + V[b + 2] * u + V[c + 2] * v;
            pos.push(px, py, pz); nrm.push(nx, ny, nz); area.push(A / n); texel.push(tx);
            const h = py - hero.groundY;
            hag.push(h); side.push(s); band.push(bandIndex(h)); tri.push(t);
        }
    }
    return {
        count: area.length, pos: Float32Array.from(pos), normal: Float32Array.from(nrm), area: Float32Array.from(area), texel: Float32Array.from(texel),
        heightAboveGround: Float32Array.from(hag), side: Uint8Array.from(side), band: Uint8Array.from(band), triangle: Uint32Array.from(tri),
        facadeSides: hero.sideHeadingsDeg.length
    };
}

// ============================================================================================
// E2: pano discovery
// ============================================================================================

export interface PanoRecord {
    panoId: string;
    lat: number;
    lng: number;
    date?: string;
    copyright?: string;
    /** Scan-frame position of the pano (x = E, z = -N). */
    x: number;
    z: number;
    streetY: number;
    /** Nominal eye (street + camera height). */
    eye: [number, number, number];
    distanceToHeroMeters: number;
}

export interface DiscoveryOptions {
    origin: GeodeticOrigin;
    apiKey: string;
    radiusMeters?: number;         // default 450
    sampleSpacingMeters?: number;  // default 12
    metadataRadiusMeters?: number; // default 10
    cameraHeightMeters?: number;   // default 2.5
    /** Stay this far inside the scan's horizontal bounds (geometry beyond the tile is unknown). Default 15. */
    tileMarginMeters?: number;
    concurrency?: number;          // default 8
    /** Keep only captures within this many years of the newest Google capture found. Default 2. */
    maxCaptureAgeYears?: number;
    /** Spatial thinning: of panos closer than this, keep the newest (then the one nearer the hero). Default 6 m. */
    thinMeters?: number;
    /** JSON cache of metadata responses (free calls, cached anyway). */
    cachePath?: string;
    fetchImpl?: typeof fetch;
    log?: (msg: string) => void;
}

function redact(text: string, secret: string): string {
    return secret ? text.split(secret).join('<redacted>') : text;
}

/** Street sample points on open ground (lattice + perpendicular sightlines from each hero side). */
export function streetSamplePoints(scan: ScanMesh, ground: GroundModel, hero: HeroModel, opts: { radiusMeters: number; sampleSpacingMeters: number; tileMarginMeters: number; anchor?: { x: number; z: number } }): Array<{ x: number; z: number }> {
    const a = opts.anchor ?? { x: 0, z: 0 };
    const pts: Array<{ x: number; z: number }> = [];
    const seen = new Set<string>();
    const minX = scan.bounds.min[0] + opts.tileMarginMeters, maxX = scan.bounds.max[0] - opts.tileMarginMeters;
    const minZ = scan.bounds.min[2] + opts.tileMarginMeters, maxZ = scan.bounds.max[2] - opts.tileMarginMeters;
    const add = (x: number, z: number, snap: number) => {
        if (x < minX || x > maxX || z < minZ || z > maxZ || Math.hypot(x - a.x, z - a.z) > opts.radiusMeters) return;
        // snap to the nearest open-ground cell within `snap` metres
        let best: { x: number; z: number } | null = null, bd = Infinity;
        const r = Math.ceil(snap / ground.cellMeters);
        const ci = Math.floor((x - ground.x0) / ground.cellMeters), ck = Math.floor((z - ground.z0) / ground.cellMeters);
        for (let k = ck - r; k <= ck + r; k++) for (let i = ci - r; i <= ci + r; i++) {
            if (i < 0 || k < 0 || i >= ground.nx || k >= ground.nz) continue;
            const c = k * ground.nx + i;
            if (!ground.open[c] || hero.footprint[c]) continue;
            const cx = ground.x0 + (i + 0.5) * ground.cellMeters, cz = ground.z0 + (k + 0.5) * ground.cellMeters;
            const d = (cx - x) ** 2 + (cz - z) ** 2;
            if (d < bd) { bd = d; best = { x: cx, z: cz }; }
        }
        if (!best) return;
        const key = `${Math.round(best.x / 3)},${Math.round(best.z / 3)}`;
        if (seen.has(key)) return;
        seen.add(key); pts.push(best);
    };
    const s = opts.sampleSpacingMeters;
    for (let z = a.z - opts.radiusMeters; z <= a.z + opts.radiusMeters; z += s) {
        for (let x = a.x - opts.radiusMeters; x <= a.x + opts.radiusMeters; x += s) add(x, z, s / 2);
    }
    // Sightlines perpendicular to each hero side, from the footprint edge outward
    for (const h of hero.sideHeadingsDeg) {
        const dx = Math.sin(h * DEG), dz = -Math.cos(h * DEG);
        // footprint extent along this direction from the centroid
        let edge = 0;
        for (let d = 0; d < 300; d += ground.cellMeters) {
            const c = ground.cellIndex(hero.centroid.x + dx * d, hero.centroid.z + dz * d);
            if (c >= 0 && hero.footprint[c]) edge = d;
        }
        for (const lateral of [-30, 0, 30]) {
            const lx = -dz * lateral, lz = dx * lateral;
            for (let d = edge + 8; d <= opts.radiusMeters; d += s / 2) add(hero.centroid.x + dx * d + lx, hero.centroid.z + dz * d + lz, 4);
        }
    }
    return pts;
}

export async function discoverPanos(scan: ScanMesh, ground: GroundModel, hero: HeroModel, opts: DiscoveryOptions): Promise<{ panos: PanoRecord[]; samplePoints: number; metadataCalls: number; cachedCalls: number; rejectedCopyright: number; rejectedOld: number }> {
    const radius = opts.radiusMeters ?? 450, spacing = opts.sampleSpacingMeters ?? 12, metaR = opts.metadataRadiusMeters ?? 10;
    const camH = opts.cameraHeightMeters ?? 2.5;
    const points = streetSamplePoints(scan, ground, hero, { radiusMeters: radius, sampleSpacingMeters: spacing, tileMarginMeters: opts.tileMarginMeters ?? 15 });
    const cache: Record<string, any> = opts.cachePath && fs.existsSync(opts.cachePath) ? JSON.parse(fs.readFileSync(opts.cachePath, 'utf8')) : {};
    let calls = 0, cached = 0;
    const results = await mapLimit(points, opts.concurrency ?? 8, async (p) => {
        const g = scanToGeodetic(opts.origin, p.x, 0, p.z);
        const key = `${g.lat.toFixed(6)},${g.lng.toFixed(6)},${metaR}`;
        if (cache[key]) { cached++; return cache[key]; }
        calls++;
        let rec: any;
        try {
            const m = await fetchStreetViewPanoMetadata({ lat: g.lat, lng: g.lng, radiusMeters: metaR, apiKey: opts.apiKey, fetchImpl: opts.fetchImpl });
            rec = { status: 'OK', panoId: m.panoId, lat: m.lat, lng: m.lng, date: m.date, copyright: m.copyright };
        } catch (e: any) {
            const msg = redact(String(e?.message ?? e), opts.apiKey);
            if (/ZERO_RESULTS|NOT_FOUND|No Street View/i.test(msg)) rec = { status: 'ZERO_RESULTS' };
            else throw new Error(`Street View metadata failed: ${msg}`);
        }
        cache[key] = rec;
        return rec;
    });
    if (opts.cachePath) { fs.mkdirSync(path.dirname(opts.cachePath), { recursive: true }); fs.writeFileSync(opts.cachePath, JSON.stringify(cache)); }
    const byId = new Map<string, PanoRecord>();
    let rejectedCopyright = 0, rejectedOld = 0;
    const months = (d?: string) => { const m = /^(\d{4})-(\d{2})/.exec(d ?? ''); return m ? Number(m[1]) * 12 + Number(m[2]) - 1 : -Infinity; };
    const newest = Math.max(...results.filter(r => r && r.status === 'OK' && r.copyright === '© Google').map(r => months(r.date)));
    const minMonths = newest - 12 * (opts.maxCaptureAgeYears ?? 2);
    for (const r of results) {
        if (!r || r.status !== 'OK' || byId.has(r.panoId)) continue;
        if (r.copyright !== '© Google') { rejectedCopyright++; continue; }
        if (months(r.date) < minMonths) { rejectedOld++; continue; }
        const q = geodeticToScan(opts.origin, r.lat, r.lng);
        if (q.x < scan.bounds.min[0] + 5 || q.x > scan.bounds.max[0] - 5 || q.z < scan.bounds.min[2] + 5 || q.z > scan.bounds.max[2] - 5) continue;
        const streetY = localStreetHeight(scan, ground, q.x, q.z);
        if (!(streetY === streetY)) continue;
        byId.set(r.panoId, {
            panoId: r.panoId, lat: r.lat, lng: r.lng, date: r.date, copyright: r.copyright, x: q.x, z: q.z, streetY,
            eye: [q.x, streetY + camH, q.z], distanceToHeroMeters: Math.hypot(q.x - hero.centroid.x, q.z - hero.centroid.z)
        });
    }
    // Spatial thinning: newest first, then nearest the hero
    const thin = opts.thinMeters ?? 6;
    const sorted = [...byId.values()].sort((a, b) => (months(b.date) - months(a.date)) || (a.distanceToHeroMeters - b.distanceToHeroMeters));
    const kept: PanoRecord[] = [];
    for (const p of sorted) if (!kept.some(q => Math.hypot(q.x - p.x, q.z - p.z) < thin)) kept.push(p);
    opts.log?.(`discovery: ${points.length} street points, ${calls} metadata calls (${cached} cached), ${byId.size} recent Google panos ` +
        `(${rejectedCopyright} non-Google, ${rejectedOld} older than ${opts.maxCaptureAgeYears ?? 2} y rejected), ${kept.length} after ${thin} m thinning`);
    return { panos: kept, samplePoints: points.length, metadataCalls: calls, cachedCalls: cached, rejectedCopyright, rejectedOld };
}

// ============================================================================================
// E3: visibility and greedy, coverage-driven frame selection
// ============================================================================================

export interface PanoVisibility {
    panoId: string;
    eye: [number, number, number];
    /** indices into TargetSamples */
    idx: Uint32Array;
    /** unit direction eye -> sample */
    dir: Float32Array;
    dist: Float32Array;
    cosInc: Float32Array;
}

/** Hero samples visible from a pano eye (depth cube: four horizontal faces and zenith, fov 90). */
export function computePanoVisibility(scan: ScanMesh, targets: TargetSamples, eye: [number, number, number], panoId: string, resolution = 256, maxDistanceMeters = 700): PanoVisibility {
    // Cube faces (four horizontal + zenith); only faces that receive a target sample are rendered
    const faces: Array<{ cam: FrameCamera; depth: Float32Array | null }> = [];
    for (const [h, p] of [[0, 0], [90, 0], [180, 0], [270, 0], [0, 89.9]] as Array<[number, number]>) {
        faces.push({ cam: frameCamera(eye, h, p, 90, resolution, resolution, ZERO_CORRECTION, h), depth: null });
    }
    const pickFace = (ux: number, uy: number, uz: number) => {
        let face = faces[0], best = -Infinity;
        for (const f of faces) { const z = ux * f.cam.fwd[0] + uy * f.cam.fwd[1] + uz * f.cam.fwd[2]; if (z > best) { best = z; face = f; } }
        return face;
    };
    for (let s = 0; s < targets.count; s++) {
        const dx = targets.pos[s * 3] - eye[0], dy = targets.pos[s * 3 + 1] - eye[1], dz = targets.pos[s * 3 + 2] - eye[2];
        const f = pickFace(dx, dy, dz);
        if (!f.depth) f.depth = renderFrameDepth(scan.mesh, f.cam);
    }
    const idx: number[] = [], dir: number[] = [], dist: number[] = [], cosInc: number[] = [];
    for (let s = 0; s < targets.count; s++) {
        const dx = targets.pos[s * 3] - eye[0], dy = targets.pos[s * 3 + 1] - eye[1], dz = targets.pos[s * 3 + 2] - eye[2];
        const d = Math.hypot(dx, dy, dz);
        if (d < 1 || d > maxDistanceMeters) continue;
        const ux = dx / d, uy = dy / d, uz = dz / d;
        const c = Math.abs(ux * targets.normal[s * 3] + uy * targets.normal[s * 3 + 1] + uz * targets.normal[s * 3 + 2]);
        if (c < 0.05) continue;
        const face = pickFace(ux, uy, uz);
        const cam = face.cam;
        const fdepth = face.depth!;
        const z = dx * cam.fwd[0] + dy * cam.fwd[1] + dz * cam.fwd[2];
        if (z <= 0.5) continue;
        const u = cam.cx + cam.fx * (dx * cam.right[0] + dy * cam.right[1] + dz * cam.right[2]) / z;
        const v = cam.cy - cam.fy * (dx * cam.up[0] + dy * cam.up[1] + dz * cam.up[2]) / z;
        const iu = Math.floor(u), iv = Math.floor(v);
        if (iu < 0 || iv < 0 || iu >= resolution || iv >= resolution) continue;
        const tol = Math.max(0.5, 0.02 * z);
        let ok = false;
        for (const [ou, ov] of [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]]) {
            const qu = iu + ou, qv = iv + ov;
            if (qu < 0 || qv < 0 || qu >= resolution || qv >= resolution) continue;
            if (z <= fdepth[qv * resolution + qu] + tol) { ok = true; break; }
        }
        if (!ok) continue;
        idx.push(s); dir.push(ux, uy, uz); dist.push(d); cosInc.push(c);
    }
    return { panoId, eye, idx: Uint32Array.from(idx), dir: Float32Array.from(dir), dist: Float32Array.from(dist), cosInc: Float32Array.from(cosInc) };
}

/**
 * computePanoVisibility with an on-disk cache. `scanKey` must identify the scan and target samples
 * (e.g. GLB size + mtime + sample count); entries are keyed by pano id, eye and resolution.
 */
export function computePanoVisibilityCached(scan: ScanMesh, targets: TargetSamples, eye: [number, number, number], panoId: string, cacheDir: string, scanKey: string, resolution = 256): PanoVisibility {
    const key = `${panoId}_${scanKey}_${eye.map(v => v.toFixed(2)).join('_')}_${resolution}`.replace(/[^A-Za-z0-9_.-]/g, '_');
    const file = path.join(cacheDir, `${key}.vis`);
    if (fs.existsSync(file)) {
        const b = fs.readFileSync(file);
        const n = b.readUInt32LE(0);
        const ab = b.buffer.slice(b.byteOffset + 4, b.byteOffset + 4 + n * 24);
        return {
            panoId, eye,
            idx: new Uint32Array(ab.slice(0, n * 4)), dir: new Float32Array(ab.slice(n * 4, n * 16)),
            dist: new Float32Array(ab.slice(n * 16, n * 20)), cosInc: new Float32Array(ab.slice(n * 20, n * 24))
        };
    }
    const v = computePanoVisibility(scan, targets, eye, panoId, resolution);
    const n = v.idx.length;
    const out = Buffer.alloc(4 + n * 24);
    out.writeUInt32LE(n, 0);
    Buffer.from(v.idx.buffer, v.idx.byteOffset, n * 4).copy(out, 4);
    Buffer.from(v.dir.buffer, v.dir.byteOffset, n * 12).copy(out, 4 + n * 4);
    Buffer.from(v.dist.buffer, v.dist.byteOffset, n * 4).copy(out, 4 + n * 16);
    Buffer.from(v.cosInc.buffer, v.cosInc.byteOffset, n * 4).copy(out, 4 + n * 20);
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(file, out);
    return v;
}

export interface FrameCoverageCriteria {
    /** Minimum |cos| between the surface normal and the view ray. Default 0.3. */
    minCosIncidence: number;
    /** Street View pixel footprint must be at most this fraction of the tile texel. Default 0.5. */
    maxFootprintToTexel: number;
    /** Resolution gain (texel / footprint) at which utility saturates. Default 4. */
    saturationGain: number;
    /** Bottom rows lost to the watermark. Default 24. */
    watermarkBottomPx: number;
}

export const DEFAULT_COVERAGE_CRITERIA: FrameCoverageCriteria = { minCosIncidence: 0.3, maxFootprintToTexel: 0.5, saturationGain: 4, watermarkBottomPx: 24 };

export interface CandidateFrame {
    panoId: string;
    headingDeg: number;
    pitchDeg: number;
    fovDeg: number;
    width: number;
    height: number;
}

/**
 * Utility in [0, 1] of each visible sample in a candidate frame:
 * cos^2 * min(texel / footprint, saturation) / saturation, 0 if not covered.
 */
export function frameUtilities(vis: PanoVisibility, targets: TargetSamples, frame: CandidateFrame, crit: FrameCoverageCriteria = DEFAULT_COVERAGE_CRITERIA): Float32Array {
    const cam = frameCamera(vis.eye, frame.headingDeg, frame.pitchDeg, frame.fovDeg, frame.width, frame.height, ZERO_CORRECTION, frame.headingDeg);
    return cameraUtilities(vis, targets, cam, undefined, crit);
}

/** As frameUtilities for an explicit (e.g. registered) camera; `valid` masks pixels (watermark, occluders). */
export function cameraUtilities(vis: PanoVisibility, targets: TargetSamples, cam: FrameCamera, valid?: Uint8Array, crit: FrameCoverageCriteria = DEFAULT_COVERAGE_CRITERIA): Float32Array {
    const out = new Float32Array(vis.idx.length);
    const frame = { width: cam.width, height: cam.height };
    const vmax = frame.height - crit.watermarkBottomPx;
    for (let k = 0; k < vis.idx.length; k++) {
        const c = vis.cosInc[k];
        if (c < crit.minCosIncidence) continue;
        const ux = vis.dir[k * 3], uy = vis.dir[k * 3 + 1], uz = vis.dir[k * 3 + 2];
        const zf = ux * cam.fwd[0] + uy * cam.fwd[1] + uz * cam.fwd[2];
        if (zf <= 0.05) continue;
        const u = cam.cx + cam.fx * (ux * cam.right[0] + uy * cam.right[1] + uz * cam.right[2]) / zf;
        const v = cam.cy - cam.fy * (ux * cam.up[0] + uy * cam.up[1] + uz * cam.up[2]) / zf;
        if (u < 2 || v < 2 || u >= frame.width - 2 || v >= vmax - 2) continue;
        if (valid && !valid[(v | 0) * frame.width + (u | 0)]) continue;
        const footprint = vis.dist[k] * zf * zf / cam.fx / c; // pixel angle ~ cos^2(off-axis) / fx
        const texel = targets.texel[vis.idx[k]];
        const gain = texel / footprint;
        if (gain < 1 / crit.maxFootprintToTexel) continue;
        out[k] = c * c * Math.min(gain, crit.saturationGain) / crit.saturationGain;
    }
    return out;
}

export interface PlannedFrame extends CandidateFrame {
    key: string;
    eye: [number, number, number];
    /** Quality-weighted area newly covered when picked (m^2). */
    gainM2: number;
    /** Area (m^2) of samples this frame covers at all. */
    coveredM2: number;
    order: number;
}

export interface PlanOptions {
    maxFrames: number;
    maxFramesPerPano?: number;     // default 3
    fovsDeg?: number[];             // default [30, 45, 60, 90]
    pitchRangeDeg?: [number, number]; // default [0, 60]
    width?: number;                 // default 640
    height?: number;                // default 640
    criteria?: Partial<FrameCoverageCriteria>;
    /** Stop when the best remaining gain falls below this (m^2). Default 5. */
    minGainM2?: number;
    /** Frames already owned (e.g. cached): their coverage is credited first and they cost nothing. */
    ownedFrames?: CandidateFrame[];
    /**
     * The first frame of every pano must have at least this fov: a wide frame carries the silhouettes
     * and building edges the per-pano registration needs; narrower frames of the same pano share its
     * correction. Default 60.
     */
    registrationMinFovDeg?: number;
}

export function frameKey(f: CandidateFrame): string {
    return `${f.panoId}_h${f.headingDeg.toFixed(2)}_p${f.pitchDeg.toFixed(2)}_f${Math.round(f.fovDeg)}`;
}

/** Candidate frames for one pano: headings toward each visible target region, several pitches and fovs. */
export function candidateFrames(vis: PanoVisibility, targets: TargetSamples, opts: PlanOptions): CandidateFrame[] {
    const fovs = opts.fovsDeg ?? [30, 45, 60, 90];
    const [pmin, pmax] = opts.pitchRangeDeg ?? [0, 60];
    const W = opts.width ?? 640, H = opts.height ?? 640;
    // region centroids (side x band) of the visible samples, area-weighted, as directions
    const regions = new Map<number, { x: number; y: number; z: number; w: number }>();
    for (let k = 0; k < vis.idx.length; k++) {
        const s = vis.idx[k];
        if (targets.side[s] > targets.facadeSides) continue;
        const key = targets.side[s] * 16 + targets.band[s];
        const a = targets.area[s];
        const r = regions.get(key) ?? { x: 0, y: 0, z: 0, w: 0 };
        r.x += vis.dir[k * 3] * a; r.y += vis.dir[k * 3 + 1] * a; r.z += vis.dir[k * 3 + 2] * a; r.w += a;
        regions.set(key, r);
    }
    const out: CandidateFrame[] = [];
    const seen = new Set<string>();
    for (const r of regions.values()) {
        if (r.w < 20) continue;
        const l = Math.hypot(r.x, r.y, r.z) || 1;
        const heading = ((Math.atan2(r.x / l, -r.z / l) / DEG) + 360) % 360;
        const elev = Math.asin(Math.max(-1, Math.min(1, r.y / l))) / DEG;
        for (const fov of fovs) {
            const vf = fov; // square frames
            const pitches = new Set<number>();
            for (const off of [-vf / 3, 0, vf / 3]) pitches.add(Math.min(pmax, Math.max(pmin, Math.round((elev + off) / 5) * 5)));
            for (const hoff of [-fov / 3, 0, fov / 3]) {
                const h = ((Math.round((heading + hoff) * 2) / 2) % 360 + 360) % 360;
                for (const p of pitches) {
                    const c = { panoId: vis.panoId, headingDeg: h, pitchDeg: p, fovDeg: fov, width: W, height: H };
                    const k = frameKey(c);
                    if (!seen.has(k)) { seen.add(k); out.push(c); }
                }
            }
        }
    }
    return out;
}

/** Lazy-greedy selection of frames maximising newly covered quality-weighted area. */
export function planFrames(visibilities: PanoVisibility[], targets: TargetSamples, opts: PlanOptions): { frames: PlannedFrame[]; candidates: number; best: Float32Array } {
    const crit = { ...DEFAULT_COVERAGE_CRITERIA, ...(opts.criteria ?? {}) };
    const maxPerPano = opts.maxFramesPerPano ?? 3, minGain = opts.minGainM2 ?? 5;
    const best = new Float32Array(targets.count);
    const visById = new Map(visibilities.map(v => [v.panoId, v]));
    // Sparse utilities: only the samples a candidate actually covers (sample index into targets, utility)
    type Cand = { frame: CandidateFrame; sIdx: Uint32Array; util: Float32Array; vis: PanoVisibility; bound: number; owned: boolean };
    const sparse = (vis: PanoVisibility, f: CandidateFrame) => {
        const u = frameUtilities(vis, targets, f, crit);
        let n = 0;
        for (let k = 0; k < u.length; k++) if (u[k] > 0) n++;
        const sIdx = new Uint32Array(n), util = new Float32Array(n);
        for (let k = 0, j = 0; k < u.length; k++) if (u[k] > 0) { sIdx[j] = vis.idx[k]; util[j++] = u[k]; }
        return { sIdx, util };
    };
    const cands: Cand[] = [];
    const ownedKeys = new Set((opts.ownedFrames ?? []).map(frameKey));
    for (const vis of visibilities) {
        for (const f of candidateFrames(vis, targets, opts)) {
            const sp = sparse(vis, f);
            if (sp.util.length) cands.push({ frame: f, ...sp, vis, bound: Infinity, owned: false });
        }
    }
    for (const f of opts.ownedFrames ?? []) {
        const vis = visById.get(f.panoId);
        if (vis && !cands.some(c => frameKey(c.frame) === frameKey(f))) cands.push({ frame: f, ...sparse(vis, f), vis, bound: Infinity, owned: true });
    }
    for (const c of cands) c.owned = ownedKeys.has(frameKey(c.frame));
    const gainOf = (c: Cand) => {
        let g = 0;
        for (let k = 0; k < c.util.length; k++) { const s = c.sIdx[k]; const d = c.util[k] - best[s]; if (d > 0) g += d * targets.area[s]; }
        return g;
    };
    const coveredOf = (c: Cand) => { let a = 0; for (let k = 0; k < c.util.length; k++) a += targets.area[c.sIdx[k]]; return a; };
    const take = (c: Cand) => { for (let k = 0; k < c.util.length; k++) { const s = c.sIdx[k]; if (c.util[k] > best[s]) best[s] = c.util[k]; } };
    const perPano = new Map<string, number>();
    const frames: PlannedFrame[] = [];
    // Owned frames first (free)
    for (const c of cands.filter(c => c.owned)) {
        const g = gainOf(c); take(c);
        perPano.set(c.frame.panoId, (perPano.get(c.frame.panoId) ?? 0) + 1);
        frames.push({ ...c.frame, key: frameKey(c.frame), eye: c.vis.eye, gainM2: g, coveredM2: coveredOf(c), order: frames.length });
    }
    const pool = cands.filter(c => !c.owned);
    while (frames.length < opts.maxFrames) {
        let pick: Cand | null = null, pickGain = 0;
        pool.sort((a, b) => b.bound - a.bound);
        const minRegFov = opts.registrationMinFovDeg ?? 60;
        for (const c of pool) {
            const have = perPano.get(c.frame.panoId) ?? 0;
            if (have >= maxPerPano) { c.bound = -1; continue; }
            if (have === 0 && c.frame.fovDeg < minRegFov) continue; // not eligible until the pano has a wide frame
            if (c.bound <= pickGain) break;
            c.bound = gainOf(c);
            if (c.bound > pickGain) { pickGain = c.bound; pick = c; }
        }
        if (!pick || pickGain < minGain) break;
        take(pick);
        perPano.set(pick.frame.panoId, (perPano.get(pick.frame.panoId) ?? 0) + 1);
        frames.push({ ...pick.frame, key: frameKey(pick.frame), eye: pick.vis.eye, gainM2: pickGain, coveredM2: coveredOf(pick), order: frames.length });
        pool.splice(pool.indexOf(pick), 1);
    }
    return { frames, candidates: cands.length, best };
}

// ============================================================================================
// Coverage report per facade side and height band
// ============================================================================================

export interface CoverageCell {
    side: string;
    band: string;
    areaM2: number;
    /** Area visible from at least one discovered pano (street-visible). */
    streetVisibleM2: number;
    coveredM2: number;
    coveredFractionOfVisible: number;
}

/** Coverage of target samples by per-sample utilities (> 0 means covered). */
export function coverageReport(targets: TargetSamples, hero: HeroModel, utility: ArrayLike<number>, streetVisible?: Uint8Array): CoverageCell[] {
    const sides = hero.sideHeadingsDeg.map(h => `facade facing ${h.toFixed(0)}deg`).concat(['roof/terrace']);
    const cells = new Map<string, CoverageCell>();
    for (let s = 0; s < targets.count; s++) {
        if (targets.side[s] > targets.facadeSides) continue;
        const side = sides[targets.side[s]];
        const [b0, b1] = HEIGHT_BANDS[targets.band[s]];
        const band = `${b0}-${b1 === Infinity ? 'top' : b1} m`;
        const key = `${side}|${band}`;
        const c = cells.get(key) ?? { side, band, areaM2: 0, streetVisibleM2: 0, coveredM2: 0, coveredFractionOfVisible: 0 };
        const a = targets.area[s];
        c.areaM2 += a;
        if (!streetVisible || streetVisible[s]) c.streetVisibleM2 += a;
        if (utility[s] > 0) c.coveredM2 += a;
        cells.set(key, c);
    }
    const out = [...cells.values()];
    for (const c of out) c.coveredFractionOfVisible = c.streetVisibleM2 > 0 ? c.coveredM2 / c.streetVisibleM2 : 0;
    return out.sort((a, b) => a.side.localeCompare(b.side) || parseFloat(a.band) - parseFloat(b.band));
}

// ============================================================================================
// E4: fetch with cache and a billing ledger
// ============================================================================================

export interface CachedFrame extends CandidateFrame {
    key: string;
    imagePath: string;
    metaPath: string;
    date?: string;
    copyright?: string;
    fromCache: boolean;
}

export interface FetchOptions {
    apiKey: string;
    cacheDir: string;
    /**
     * Cap on billed Static API image requests recorded in the ledger, across every run that shares the
     * ledger. Clamped to [0, STREETVIEW_BILLING_HARD_CAP]; a missing or non-finite value means the hard cap.
     */
    maxBilledRequests?: number;
    /**
     * Billing ledger file, for tests with an injected `fetchImpl` only. Real requests always count in the one global
     * ledger (defaultStreetViewLedgerPath()); passing another path without `fetchImpl` throws.
     */
    ledgerPath?: string;
    fetchImpl?: typeof fetch;
    log?: (msg: string) => void;
}

/** Absolute ceiling of billed Street View Static image requests in the global ledger (all runs, all sites). */
export const STREETVIEW_BILLING_HARD_CAP = 80;

export interface StreetViewLedger { billedImageRequests: number; keys: string[] }

/**
 * Repository root: the nearest ancestor of this module (or of the working directory) holding package.json and
 * packages/core. Null outside a checkout.
 */
export function findRepoRoot(): string | null {
    const starts: string[] = [];
    try { if (typeof __dirname === 'string') starts.push(__dirname); } catch { /* ESM without __dirname */ }
    starts.push(process.cwd());
    for (const s of starts) {
        let d = path.resolve(s);
        for (let i = 0; i < 12; i++) {
            if (fs.existsSync(path.join(d, 'package.json')) && fs.existsSync(path.join(d, 'packages', 'core'))) return d;
            const up = path.dirname(d);
            if (up === d) break;
            d = up;
        }
    }
    return null;
}

/**
 * The one billing ledger shared by every run, whatever the cache / output directory:
 * <repo>/.scratchbox/streetview_cache/billing_ledger.json (gitignored), or ~/.scratchbox/streetview_cache/billing_ledger.json
 * outside a repository checkout. Deliberately not configurable (no environment override).
 */
export function defaultStreetViewLedgerPath(): string {
    const root = findRepoRoot();
    return root ? path.join(root, '.scratchbox', 'streetview_cache', 'billing_ledger.json') : path.join(os.homedir(), '.scratchbox', 'streetview_cache', 'billing_ledger.json');
}

/** Earlier global ledger locations; their keys are folded into the global ledger once. */
export function legacyGlobalLedgerPaths(): string[] {
    const root = findRepoRoot();
    const out = [path.join(os.homedir(), '.scratchbox', 'streetview_billing_ledger.json')];
    if (root) out.push(path.join(root, '.scratchbox', 'streetview_billing_ledger.json'));
    return out;
}

/** Effective billing cap: finite values are floored and clamped to [0, hard cap]; anything else is the hard cap. */
export function effectiveBillingCap(requested: number | undefined): number {
    if (typeof requested !== 'number' || !Number.isFinite(requested)) return STREETVIEW_BILLING_HARD_CAP;
    return Math.max(0, Math.min(STREETVIEW_BILLING_HARD_CAP, Math.floor(requested)));
}

function parseLedger(p: string): StreetViewLedger {
    if (!fs.existsSync(p)) return { billedImageRequests: 0, keys: [] };
    const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
    const keys = Array.isArray(raw.keys) ? raw.keys.map(String) : [];
    const billed = Number(raw.billedImageRequests);
    return { billedImageRequests: Number.isFinite(billed) ? Math.max(billed, keys.length) : keys.length, keys };
}

/** Atomic write (temp file + rename) so a crash never leaves a truncated ledger. */
function writeLedger(p: string, l: StreetViewLedger): void {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const tmp = `${p}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(l, null, 1));
    fs.renameSync(tmp, p);
}

const sleepSync = (ms: number) => { try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch { const t = Date.now(); while (Date.now() - t < ms) { /* spin */ } } };

/**
 * Runs `fn` holding an exclusive lock on the ledger (`<ledger>.lock`, created with O_EXCL), so concurrent runs cannot
 * both spend the last request. A lock older than 10 minutes is considered stale and removed. Throws after 60 s.
 */
export function withLedgerLock<T>(ledgerPath: string, fn: () => T): T {
    const lock = `${ledgerPath}.lock`;
    fs.mkdirSync(path.dirname(ledgerPath), { recursive: true });
    const t0 = Date.now();
    for (;;) {
        try {
            const fd = fs.openSync(lock, 'wx');
            fs.writeSync(fd, String(process.pid));
            fs.closeSync(fd);
            break;
        } catch (e: any) {
            if (e?.code !== 'EEXIST') throw e;
            try { if (Date.now() - fs.statSync(lock).mtimeMs > 600_000) { fs.rmSync(lock, { force: true }); continue; } } catch { continue; }
            if (Date.now() - t0 > 60_000) throw new Error(`billing ledger is locked (${lock}); another run is fetching`);
            sleepSync(50);
        }
    }
    try { return fn(); } finally { fs.rmSync(lock, { force: true }); }
}

/**
 * Reads a ledger. `ledgerOrCacheDir` is a ledger file (.json) or, for older callers, a cache directory holding
 * a legacy fetch_ledger.json.
 */
export function readLedger(ledgerOrCacheDir: string): StreetViewLedger {
    const p = ledgerOrCacheDir.endsWith('.json') ? ledgerOrCacheDir : path.join(ledgerOrCacheDir, 'fetch_ledger.json');
    return parseLedger(p);
}

/** Folds the keys of `sources` (ledger files) into the ledger at `ledgerPath`; each key counts once. Idempotent. */
function foldLedgers(ledgerPath: string, sources: string[]): StreetViewLedger {
    return withLedgerLock(ledgerPath, () => {
        const ledger = parseLedger(ledgerPath);
        const have = new Set(ledger.keys);
        let changed = false;
        for (const src of sources) {
            if (path.resolve(src) === path.resolve(ledgerPath) || !fs.existsSync(src)) continue;
            const raw = JSON.parse(fs.readFileSync(src, 'utf8'));
            if (raw.mergedInto && path.resolve(raw.mergedInto) === path.resolve(ledgerPath)) continue;
            const legacy = parseLedger(src);
            let added = 0;
            for (const k of legacy.keys) if (!have.has(k)) { have.add(k); ledger.keys.push(k); added++; }
            // a legacy count above its key list (requests that failed before a key was stored) is carried over once
            const unkeyed = Math.max(0, legacy.billedImageRequests - legacy.keys.length);
            ledger.billedImageRequests += added + unkeyed;
            fs.writeFileSync(src, JSON.stringify({ ...legacy, billedImageRequests: legacy.keys.length, mergedInto: path.resolve(ledgerPath) }, null, 1));
            changed = true;
        }
        if (changed || !fs.existsSync(ledgerPath)) writeLedger(ledgerPath, ledger);
        return ledger;
    });
}

/**
 * Folds a legacy per-cache-directory ledger (<cacheDir>/fetch_ledger.json) into the ledger at `ledgerPath`:
 * keys not yet recorded there are added and counted once. Idempotent. Returns the merged ledger.
 */
export function mergeLegacyLedger(ledgerPath: string, cacheDir: string): StreetViewLedger {
    return foldLedgers(ledgerPath, [path.join(cacheDir, 'fetch_ledger.json')]);
}

/** The global ledger with every legacy ledger (earlier global locations, `cacheDir`'s fetch_ledger.json) folded in. */
export function openGlobalLedger(cacheDir?: string): { ledgerPath: string; ledger: StreetViewLedger } {
    const ledgerPath = defaultStreetViewLedgerPath();
    const sources = [...legacyGlobalLedgerPaths(), ...(cacheDir ? [path.join(cacheDir, 'fetch_ledger.json')] : [])];
    return { ledgerPath, ledger: foldLedgers(ledgerPath, sources) };
}

/**
 * Fetches (or loads from cache) every frame; never exceeds the billing cap of the shared ledger. The ledger is
 * re-read under a lock before every billable request and the request is counted before it is sent (a request that
 * fails after sending may still be billed).
 */
export async function fetchFrames(frames: CandidateFrame[], panos: Map<string, PanoRecord>, opts: FetchOptions): Promise<{ frames: CachedFrame[]; billed: number; skippedForCap: number; ledgerPath: string; cap: number }> {
    fs.mkdirSync(opts.cacheDir, { recursive: true });
    const cap = effectiveBillingCap(opts.maxBilledRequests);
    let ledgerPath: string;
    if (opts.ledgerPath && !opts.fetchImpl && path.resolve(opts.ledgerPath) !== path.resolve(defaultStreetViewLedgerPath())) {
        throw new Error('fetchFrames: a custom ledgerPath is only allowed with an injected fetchImpl; real requests always count in the global ledger');
    }
    if (opts.ledgerPath) { ledgerPath = path.resolve(opts.ledgerPath); mergeLegacyLedger(ledgerPath, opts.cacheDir); }
    else ledgerPath = openGlobalLedger(opts.cacheDir).ledgerPath;
    const out: CachedFrame[] = [];
    let billed = 0, skipped = 0;
    for (const f of frames) {
        const key = frameKey(f);
        const imagePath = path.join(opts.cacheDir, `${key}.jpg`), metaPath = path.join(opts.cacheDir, `${key}.json`);
        if (fs.existsSync(imagePath) && fs.existsSync(metaPath)) {
            const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
            // The cache key has no size: a cached frame of another size must not be returned for this request
            const size = readJpegSize(fs.readFileSync(imagePath));
            if (!size || size.width !== f.width || size.height !== f.height || (meta.width !== undefined && (meta.width !== f.width || meta.height !== f.height))) {
                throw new Error(`fetchFrames: cached ${key}.jpg is ${size ? `${size.width}x${size.height}` : 'not a JPEG'}, requested ${f.width}x${f.height}; use another cache directory`);
            }
            out.push({ ...f, key, imagePath, metaPath, date: meta.date, copyright: meta.copyright, fromCache: true });
            continue;
        }
        const pano = panos.get(f.panoId);
        if (!pano) throw new Error(`fetchFrames: unknown pano ${f.panoId}`);
        // Reserve the request in the ledger (re-read under the lock: other runs may have spent the budget)
        const reserved = withLedgerLock(ledgerPath, () => {
            const l = parseLedger(ledgerPath);
            if (l.billedImageRequests >= cap) return false;
            l.billedImageRequests++; l.keys.push(key);
            writeLedger(ledgerPath, l);
            return true;
        });
        if (!reserved) { skipped++; continue; }
        billed++;
        let shot;
        try {
            shot = await StreetViewRestyleService.fetchStreetViewImage({
                lat: pano.lat, lng: pano.lng, panoId: f.panoId, heading: Number(f.headingDeg.toFixed(2)), pitch: Number(f.pitchDeg.toFixed(2)),
                fov: Math.round(f.fovDeg), width: f.width, height: f.height, apiKey: opts.apiKey, fetchImpl: opts.fetchImpl
            });
        } catch (e: any) {
            throw new Error(`Street View image fetch failed for ${key}: ${redact(String(e?.message ?? e), opts.apiKey)}`);
        }
        const size = readJpegSize(shot.image);
        if (!size || size.width !== f.width || size.height !== f.height) throw new Error(`Street View image for ${key} is not a ${f.width}x${f.height} JPEG`);
        if (shot.panoId !== f.panoId) throw new Error(`Street View returned pano ${shot.panoId} for requested ${f.panoId}`);
        fs.writeFileSync(imagePath, shot.image);
        const meta = { key, panoId: f.panoId, headingDeg: f.headingDeg, pitchDeg: f.pitchDeg, fovDeg: f.fovDeg, width: f.width, height: f.height, date: shot.date, location: shot.location, copyright: shot.copyright, fetchedAt: new Date().toISOString() };
        fs.writeFileSync(metaPath, JSON.stringify(meta, null, 1));
        out.push({ ...f, key, imagePath, metaPath, date: shot.date, copyright: shot.copyright, fromCache: false });
        opts.log?.(`fetched ${key} (${shot.image.length} bytes, ${shot.date ?? 'undated'})`);
    }
    return { frames: out, billed, skippedForCap: skipped, ledgerPath, cap };
}

/** Horizontal forward vector of a heading (helper for reports). */
export function headingVector(headingDeg: number): { x: number; z: number } {
    const f = streetViewForward(headingDeg, 0);
    return { x: f[0], z: f[2] };
}
