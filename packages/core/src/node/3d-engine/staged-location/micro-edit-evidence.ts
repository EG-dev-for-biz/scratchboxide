/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * What the micro-edit loop (micro-edits.ts) measures, and nothing else: the scan's points, the units standing on a roof
 * whose sections are round, the tile photo seen straight down around one, and a held-out top-down photo to score an edit
 * against. Everything is measured from continuous numbers (heights, radii, contrasts, spectra); nothing names what a unit
 * is.
 *
 *  - Scan points: each triangle sampled on a barycentric lattice at a fixed spacing (deterministic), with its area share
 *    and its normal.
 *  - Round units: a 0.2 m height map of the points over the footprint; the support under each cell is a low percentile of
 *    its neighbourhood; raised cells grouped into components; each component's side points fitted with a circle (algebraic
 *    fit, then Gauss-Newton). A unit is kept when its sides are round (radial RMS over the radius), seen all round (angular
 *    sectors) and the component fills its circle.
 *  - Photo measures (the tile photo straight down, polar about the unit's axis): the radius where the mean luminance steps
 *    across a ring, the strongest angular period on a ring (count and phase, with its significance over the spectrum's
 *    median), the strongest radial period.
 *  - Held-out score: a model is drawn top-down with each of its parts in the median tile-photo colour of the pixels it
 *    shows (so its structure, not the tile photo, is what is drawn), shaded lightly by its normals, and compared with a
 *    photo the proposals never read (luminance SSIM and the correlation of gradient magnitudes inside the unit's disc).
 */

import * as crypto from 'crypto';
import type { DecodedImage } from '../../../common/spatial/texture-pass-contracts';
import { maskedSsim } from './photo-match-eval';
import { maskedNcc } from './texture-fit-metric';
import { renderTopDownPhoto } from './top-down-photo';
import type { TileTriangles } from './tile-texture-transfer';

// =============================================================================
// Scan points
// =============================================================================

export interface ScanPoints {
    /** xyz per point (tile frame). */
    p: Float32Array;
    /** Unit normal per point (the triangle's; sign as wound). */
    n: Float32Array;
    /** Surface area each point stands for (m2). */
    a: Float32Array;
    count: number;
}

/**
 * Samples every triangle (positions: 9 floats each) whose centroid passes `keep` on a barycentric lattice whose step is
 * about `spacingM`: deterministic, so the same scan gives the same points.
 */
export function sampleScanPoints(positions: Float32Array, spacingM: number, keep?: (x: number, y: number, z: number) => boolean): ScanPoints {
    const p: number[] = [], n: number[] = [], a: number[] = [];
    for (let t = 0; t < positions.length / 9; t++) {
        const o = t * 9;
        const A = [positions[o], positions[o + 1], positions[o + 2]], B = [positions[o + 3], positions[o + 4], positions[o + 5]], C = [positions[o + 6], positions[o + 7], positions[o + 8]];
        const cx = (A[0] + B[0] + C[0]) / 3, cy = (A[1] + B[1] + C[1]) / 3, cz = (A[2] + B[2] + C[2]) / 3;
        if (keep && !keep(cx, cy, cz)) continue;
        const u = [B[0] - A[0], B[1] - A[1], B[2] - A[2]], v = [C[0] - A[0], C[1] - A[1], C[2] - A[2]];
        const nx = u[1] * v[2] - u[2] * v[1], ny = u[2] * v[0] - u[0] * v[2], nz = u[0] * v[1] - u[1] * v[0];
        const nl = Math.hypot(nx, ny, nz);
        if (nl < 1e-12) continue;
        const area = nl / 2;
        const edge = Math.max(Math.hypot(u[0], u[1], u[2]), Math.hypot(v[0], v[1], v[2]), Math.hypot(B[0] - C[0], B[1] - C[1], B[2] - C[2]));
        const k = Math.max(1, Math.min(64, Math.ceil(edge / spacingM)));
        const pts: Array<[number, number]> = [];
        for (let i = 0; i < k; i++) for (let j = 0; i + j < k; j++) pts.push([(i + 1 / 3) / k, (j + 1 / 3) / k]);
        for (const [s, r] of pts) {
            p.push(A[0] + s * u[0] + r * v[0], A[1] + s * u[1] + r * v[1], A[2] + s * u[2] + r * v[2]);
            n.push(nx / nl, ny / nl, nz / nl);
            a.push(area / pts.length);
        }
    }
    return { p: new Float32Array(p), n: new Float32Array(n), a: new Float32Array(a), count: a.length };
}

/** The points within `radiusM` (in plan) of (cx, cz) and above `minY`. */
export function pointsNear(pts: ScanPoints, cx: number, cz: number, radiusM: number, minY = -Infinity): ScanPoints {
    const idx: number[] = [];
    for (let i = 0; i < pts.count; i++) if (pts.p[i * 3 + 1] >= minY && Math.hypot(pts.p[i * 3] - cx, pts.p[i * 3 + 2] - cz) <= radiusM) idx.push(i);
    const p = new Float32Array(idx.length * 3), n = new Float32Array(idx.length * 3), a = new Float32Array(idx.length);
    idx.forEach((i, k) => { for (let c = 0; c < 3; c++) { p[k * 3 + c] = pts.p[i * 3 + c]; n[k * 3 + c] = pts.n[i * 3 + c]; } a[k] = pts.a[i]; });
    return { p, n, a, count: idx.length };
}

/** A digest of points rounded to `quantumM`, order-free: the same scan surface gives the same digest. */
export function pointsDigest(pts: ScanPoints, quantumM = 0.05): string {
    const keys: string[] = [];
    for (let i = 0; i < pts.count; i++) keys.push(`${Math.round(pts.p[i * 3] / quantumM)},${Math.round(pts.p[i * 3 + 1] / quantumM)},${Math.round(pts.p[i * 3 + 2] / quantumM)}`);
    keys.sort();
    const unique = keys.filter((k, i) => i === 0 || k !== keys[i - 1]);
    return crypto.createHash('sha256').update(unique.join(';')).digest('hex').slice(0, 16);
}

// =============================================================================
// Height map and round units
// =============================================================================

export interface HeightMap {
    x0: number; z0: number; cellM: number; nx: number; nz: number;
    /** Highest point per cell (-Infinity where none). */
    top: Float32Array;
    /** The support under each cell: a low percentile of the tops within `supportWindowM`. */
    support: Float32Array;
}

export const ROUND_UNIT_PARAMS = {
    cellM: 0.2,
    supportWindowM: 6,
    supportPercentile: 0.2,
    /** A cell stands up when its top is this far above its support (m). */
    minRiseM: 0.35,
    minAreaM2: 0.6,
    maxAreaM2: 40,
    /** Side points: |normal y| below this, between these shares of the unit's height. */
    sideNormalY: 0.5,
    sideBand: [0.15, 0.85] as [number, number],
    /** Round: radial RMS of the side points over the radius at most this (a square's corners give about 0.1). */
    maxRmsRel: 0.05,
    /** Seen all round: share of 16 angular sectors holding side points. */
    minSectorShare: 0.7,
    /** The component's cells fill its circle's area within this ratio range. */
    fillRange: [0.6, 1.4] as [number, number],
    /** The unit's top is this percentile of its points' heights. */
    topPercentile: 0.95
};

export function buildHeightMap(pts: ScanPoints, bounds: { x0: number; z0: number; x1: number; z1: number }, P = ROUND_UNIT_PARAMS): HeightMap {
    const cellM = P.cellM;
    const nx = Math.max(1, Math.ceil((bounds.x1 - bounds.x0) / cellM)), nz = Math.max(1, Math.ceil((bounds.z1 - bounds.z0) / cellM));
    const top = new Float32Array(nx * nz).fill(-Infinity);
    for (let i = 0; i < pts.count; i++) {
        const ix = Math.floor((pts.p[i * 3] - bounds.x0) / cellM), iz = Math.floor((pts.p[i * 3 + 2] - bounds.z0) / cellM);
        if (ix < 0 || iz < 0 || ix >= nx || iz >= nz) continue;
        const k = iz * nx + ix;
        if (pts.p[i * 3 + 1] > top[k]) top[k] = pts.p[i * 3 + 1];
    }
    // the support: a low percentile of the tops in the window, on a coarse grid (one per window / 4) for speed
    const support = new Float32Array(nx * nz).fill(-Infinity);
    const w = Math.max(1, Math.round(P.supportWindowM / 2 / cellM)), step = Math.max(1, Math.round(w / 2));
    const coarse = new Map<number, number>();
    const coarseAt = (cx: number, cz: number): number => {
        const key = cz * 100003 + cx;
        const hit = coarse.get(key);
        if (hit !== undefined) return hit;
        const vals: number[] = [];
        for (let z = Math.max(0, cz * step - w); z <= Math.min(nz - 1, cz * step + w); z++) for (let x = Math.max(0, cx * step - w); x <= Math.min(nx - 1, cx * step + w); x++) {
            const t = top[z * nx + x];
            if (t > -Infinity) vals.push(t);
        }
        vals.sort((p, q) => p - q);
        const v = vals.length ? vals[Math.floor(P.supportPercentile * (vals.length - 1))] : -Infinity;
        coarse.set(key, v);
        return v;
    };
    for (let z = 0; z < nz; z++) for (let x = 0; x < nx; x++) {
        if (top[z * nx + x] === -Infinity) continue;
        // bilinear over the four coarse nodes around the cell
        const fx = x / step, fz = z / step, ix = Math.floor(fx), iz = Math.floor(fz), tx = fx - ix, tz = fz - iz;
        let s = 0, ws = 0;
        for (const [dx, dz, wt] of [[0, 0, (1 - tx) * (1 - tz)], [1, 0, tx * (1 - tz)], [0, 1, (1 - tx) * tz], [1, 1, tx * tz]] as Array<[number, number, number]>) {
            const v = coarseAt(ix + dx, iz + dz);
            if (v > -Infinity && wt > 0) { s += v * wt; ws += wt; }
        }
        support[z * nx + x] = ws > 0 ? s / ws : top[z * nx + x];
    }
    return { x0: bounds.x0, z0: bounds.z0, cellM, nx, nz, top, support };
}

/** The highest scan point within `reachM` (plan) of (x, z), from the height map; -Infinity where the scan has none. */
export function topNear(h: HeightMap, x: number, z: number, reachM: number): number {
    const r = Math.ceil(reachM / h.cellM), ix = Math.floor((x - h.x0) / h.cellM), iz = Math.floor((z - h.z0) / h.cellM);
    let best = -Infinity;
    for (let dz = -r; dz <= r; dz++) for (let dx = -r; dx <= r; dx++) {
        const xx = ix + dx, zz = iz + dz;
        if (xx < 0 || zz < 0 || xx >= h.nx || zz >= h.nz) continue;
        best = Math.max(best, h.top[zz * h.nx + xx]);
    }
    return best;
}

/** Least-squares circle through (x, z) points: the algebraic fit, refined by Gauss-Newton on the geometric distance. */
export function fitCircle(xs: ArrayLike<number>, zs: ArrayLike<number>): { cx: number; cz: number; r: number; rms: number } | undefined {
    const n = xs.length;
    if (n < 5) return undefined;
    let mx = 0, mz = 0;
    for (let i = 0; i < n; i++) { mx += xs[i]; mz += zs[i]; }
    mx /= n; mz /= n;
    // Kasa: x2 + z2 + D x + E z + F = 0 in centred coordinates
    let Suu = 0, Suv = 0, Svv = 0, Suuu = 0, Svvv = 0, Suvv = 0, Svuu = 0;
    for (let i = 0; i < n; i++) {
        const u = xs[i] - mx, v = zs[i] - mz;
        Suu += u * u; Suv += u * v; Svv += v * v; Suuu += u * u * u; Svvv += v * v * v; Suvv += u * v * v; Svuu += v * u * u;
    }
    const det = Suu * Svv - Suv * Suv;
    if (Math.abs(det) < 1e-12) return undefined;
    const b1 = 0.5 * (Suuu + Suvv), b2 = 0.5 * (Svvv + Svuu);
    let uc = (b1 * Svv - b2 * Suv) / det, vc = (Suu * b2 - Suv * b1) / det;
    let r = Math.sqrt(uc * uc + vc * vc + (Suu + Svv) / n);
    for (let it = 0; it < 20; it++) {
        // Gauss-Newton on d_i = |p_i - c| - r
        let J00 = 0, J01 = 0, J02 = 0, J11 = 0, J12 = 0, J22 = 0, g0 = 0, g1 = 0, g2 = 0;
        for (let i = 0; i < n; i++) {
            const du = xs[i] - mx - uc, dv = zs[i] - mz - vc, d = Math.hypot(du, dv) || 1e-9;
            const res = d - r, j0 = -du / d, j1 = -dv / d, j2 = -1;
            J00 += j0 * j0; J01 += j0 * j1; J02 += j0 * j2; J11 += j1 * j1; J12 += j1 * j2; J22 += j2 * j2;
            g0 += j0 * res; g1 += j1 * res; g2 += j2 * res;
        }
        const step = solve3([[J00, J01, J02], [J01, J11, J12], [J02, J12, J22]], [-g0, -g1, -g2]);
        if (!step) break;
        uc += step[0]; vc += step[1]; r += step[2];
        if (Math.hypot(step[0], step[1], step[2]) < 1e-7) break;
    }
    let ss = 0;
    for (let i = 0; i < n; i++) { const d = Math.hypot(xs[i] - mx - uc, zs[i] - mz - vc) - r; ss += d * d; }
    return { cx: mx + uc, cz: mz + vc, r: Math.abs(r), rms: Math.sqrt(ss / n) };
}

function solve3(A: number[][], b: number[]): number[] | undefined {
    const m = A.map((row, i) => [...row, b[i]]);
    for (let c = 0; c < 3; c++) {
        let piv = c;
        for (let r = c + 1; r < 3; r++) if (Math.abs(m[r][c]) > Math.abs(m[piv][c])) piv = r;
        if (Math.abs(m[piv][c]) < 1e-12) return undefined;
        [m[c], m[piv]] = [m[piv], m[c]];
        for (let r = 0; r < 3; r++) if (r !== c) { const f = m[r][c] / m[c][c]; for (let k = c; k < 4; k++) m[r][k] -= f * m[c][k]; }
    }
    return [m[0][3] / m[0][0], m[1][3] / m[1][1], m[2][3] / m[2][2]];
}

export interface RoundUnit {
    cx: number; cz: number; r: number;
    /** The support it stands on and its top (m, tile frame). */
    baseY: number; topY: number;
    /** Radial RMS of its side points (m) and over the radius. */
    rmsM: number; rmsRel: number;
    sectorShare: number; fill: number;
    sidePoints: number;
}

/** Units standing on the support inside `inside(x, z)` whose sides the scan measures as round (see ROUND_UNIT_PARAMS). */
export function findRoundUnits(pts: ScanPoints, h: HeightMap, inside: (x: number, z: number) => boolean, P = ROUND_UNIT_PARAMS): { units: RoundUnit[]; components: number; rejected: Record<string, number> } {
    const { nx, nz, cellM } = h;
    const raised = new Uint8Array(nx * nz);
    for (let z = 0; z < nz; z++) for (let x = 0; x < nx; x++) {
        const k = z * nx + x;
        if (h.top[k] > -Infinity && h.top[k] - h.support[k] >= P.minRiseM && inside(h.x0 + (x + 0.5) * cellM, h.z0 + (z + 0.5) * cellM)) raised[k] = 1;
    }
    const label = new Int32Array(nx * nz).fill(-1);
    const comps: number[][] = [];
    for (let k = 0; k < nx * nz; k++) {
        if (!raised[k] || label[k] >= 0) continue;
        const cells: number[] = [k];
        label[k] = comps.length;
        for (let q = 0; q < cells.length; q++) {
            const c = cells[q], x = c % nx, z = (c - x) / nx;
            for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
                const xx = x + dx, zz = z + dz;
                if (xx < 0 || zz < 0 || xx >= nx || zz >= nz) continue;
                const nk = zz * nx + xx;
                if (raised[nk] && label[nk] < 0) { label[nk] = comps.length; cells.push(nk); }
            }
        }
        comps.push(cells);
    }
    const rejected: Record<string, number> = {};
    const reject = (why: string) => { rejected[why] = (rejected[why] ?? 0) + 1; };
    const units: RoundUnit[] = [];
    // points per component (a point belongs to the component of its cell or of a 4-neighbour: side points sit at the edge)
    const byComp = new Map<number, number[]>();
    for (let i = 0; i < pts.count; i++) {
        const ix = Math.floor((pts.p[i * 3] - h.x0) / cellM), iz = Math.floor((pts.p[i * 3 + 2] - h.z0) / cellM);
        let c = -1;
        for (const [dx, dz] of [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]]) {
            const xx = ix + dx, zz = iz + dz;
            if (xx < 0 || zz < 0 || xx >= nx || zz >= nz) continue;
            if (label[zz * nx + xx] >= 0) { c = label[zz * nx + xx]; break; }
        }
        if (c < 0) continue;
        let list = byComp.get(c);
        if (!list) byComp.set(c, list = []);
        list.push(i);
    }
    comps.forEach((cells, ci) => {
        const area = cells.length * cellM * cellM;
        if (area < P.minAreaM2) return reject('smaller than the least area');
        if (area > P.maxAreaM2) return reject('larger than the largest area');
        const ids = byComp.get(ci) ?? [];
        const support = median(cells.map(c => h.support[c]));
        const heights = ids.map(i => pts.p[i * 3 + 1]).filter(y => y > support).sort((p, q) => p - q);
        if (heights.length < 10) return reject('too few points');
        const topY = heights[Math.floor(P.topPercentile * (heights.length - 1))];
        const H = topY - support;
        if (H < P.minRiseM) return reject('too low');
        const xs: number[] = [], zs: number[] = [];
        for (const i of ids) {
            const y = pts.p[i * 3 + 1];
            if (Math.abs(pts.n[i * 3 + 1]) >= P.sideNormalY) continue;
            if (y < support + P.sideBand[0] * H || y > support + P.sideBand[1] * H) continue;
            xs.push(pts.p[i * 3]); zs.push(pts.p[i * 3 + 2]);
        }
        const c = fitCircle(xs, zs);
        if (!c) return reject('no side points to fit');
        const rmsRel = c.rms / Math.max(1e-6, c.r);
        const sectors = new Set<number>();
        for (let i = 0; i < xs.length; i++) sectors.add(Math.floor(((Math.atan2(zs[i] - c.cz, xs[i] - c.cx) + Math.PI) / (2 * Math.PI)) * 16) % 16);
        const sectorShare = sectors.size / 16;
        const fill = area / (Math.PI * c.r * c.r);
        if (rmsRel > P.maxRmsRel) return reject('sides not round');
        if (sectorShare < P.minSectorShare) return reject('sides not seen all round');
        if (fill < P.fillRange[0] || fill > P.fillRange[1]) return reject('does not fill its circle');
        if (!inside(c.cx, c.cz)) return reject('axis outside the footprint');
        units.push({ cx: c.cx, cz: c.cz, r: c.r, baseY: support, topY, rmsM: c.rms, rmsRel, sectorShare, fill, sidePoints: xs.length });
    });
    units.sort((a, b) => (a.cx - b.cx) || (a.cz - b.cz));
    return { units, components: comps.length, rejected };
}

function median(v: number[]): number {
    const s = v.filter(Number.isFinite).sort((p, q) => p - q);
    return s.length ? s[s.length >> 1] : NaN;
}

// =============================================================================
// The photo straight down
// =============================================================================

/** An image straight down over (x0, z0) at texelM per pixel (+x right, +z down), sRGB RGBA. */
export interface TopDownCrop { rgba: Uint8Array; width: number; height: number; x0: number; z0: number; texelM: number }

/** The tile photo straight down around (cx, cz), `halfM` each way, exact in scale at `referenceY`. */
export function tileCropAround(tris: TileTriangles, cx: number, cz: number, halfM: number, texelM: number, referenceY: number): TopDownCrop {
    const photo = renderTopDownPhoto(tris, { x0: cx - halfM, z0: cz - halfM, widthM: 2 * halfM, heightM: 2 * halfM }, { texelM, maxPx: 2048, referenceY });
    return { rgba: photo.rgba, width: photo.width, height: photo.height, x0: cx - halfM, z0: cz - halfM, texelM: photo.texelM };
}

const lum = (r: number, g: number, b: number) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

/** Bilinear luminance (0..255) at a plan point; NaN outside. */
export function luminanceAt(crop: TopDownCrop, x: number, z: number): number {
    const fx = (x - crop.x0) / crop.texelM - 0.5, fz = (z - crop.z0) / crop.texelM - 0.5;
    const ix = Math.floor(fx), iz = Math.floor(fz);
    if (ix < 0 || iz < 0 || ix + 1 >= crop.width || iz + 1 >= crop.height) return NaN;
    const tx = fx - ix, tz = fz - iz;
    const L = (xx: number, zz: number) => { const k = (zz * crop.width + xx) * 4; return lum(crop.rgba[k], crop.rgba[k + 1], crop.rgba[k + 2]); };
    return (L(ix, iz) * (1 - tx) + L(ix + 1, iz) * tx) * (1 - tz) + (L(ix, iz + 1) * (1 - tx) + L(ix + 1, iz + 1) * tx) * tz;
}

/** A 64-bit average hash of the crop inside the disc of `radiusM` about (cx, cz) (8 x 8 cells), hex: the photo's key. */
export function cropKey(crop: TopDownCrop, cx: number, cz: number, radiusM: number): string {
    const cells: number[] = [];
    for (let j = 0; j < 8; j++) for (let i = 0; i < 8; i++) {
        let s = 0, n = 0;
        for (let v = 0; v < 4; v++) for (let u = 0; u < 4; u++) {
            const x = cx - radiusM + ((i * 4 + u + 0.5) / 32) * 2 * radiusM, z = cz - radiusM + ((j * 4 + v + 0.5) / 32) * 2 * radiusM;
            const L = luminanceAt(crop, x, z);
            if (Number.isFinite(L)) { s += L; n++; }
        }
        cells.push(n ? s / n : 0);
    }
    const mean = cells.reduce((a, b) => a + b, 0) / cells.length;
    let bits = 0n;
    for (const c of cells) bits = (bits << 1n) | (c > mean ? 1n : 0n);
    return bits.toString(16).padStart(16, '0');
}

/** Hamming distance between two crop keys (0..64). */
export function cropKeyDistance(a: string, b: string): number {
    let x = BigInt(`0x${a}`) ^ BigInt(`0x${b}`), n = 0;
    while (x) { n += Number(x & 1n); x >>= 1n; }
    return n;
}

/** Mean luminance per radius (0..rMaxM in steps of drM), over `thetaBins` directions; NaN where the photo has none. */
export function radialProfile(crop: TopDownCrop, cx: number, cz: number, rMaxM: number, drM: number, thetaBins = 180): Float64Array {
    const n = Math.max(2, Math.floor(rMaxM / drM) + 1);
    const out = new Float64Array(n);
    for (let i = 0; i < n; i++) {
        const r = i * drM;
        let s = 0, c = 0;
        const bins = i === 0 ? 1 : thetaBins;
        for (let b = 0; b < bins; b++) {
            const th = (2 * Math.PI * (b + 0.5)) / bins;
            const L = luminanceAt(crop, cx + r * Math.cos(th), cz + r * Math.sin(th));
            if (Number.isFinite(L)) { s += L; c++; }
        }
        out[i] = c ? s / c : NaN;
    }
    return out;
}

export interface RingStep { radiusM: number; step: number; snr: number }

/**
 * The radius in [loM, hiM] where the radial mean luminance steps most (inside to outside, either sign), with the step and
 * its ratio to the profile's own point-to-point noise.
 */
export function strongestRingStep(crop: TopDownCrop, cx: number, cz: number, loM: number, hiM: number): RingStep | undefined {
    const dr = crop.texelM;
    const prof = radialProfile(crop, cx, cz, hiM + 3 * dr, dr);
    const d = 2;
    let best: RingStep | undefined;
    const diffs: number[] = [];
    for (let i = 1; i < prof.length; i++) if (Number.isFinite(prof[i]) && Number.isFinite(prof[i - 1])) diffs.push(Math.abs(prof[i] - prof[i - 1]));
    diffs.sort((p, q) => p - q);
    const noise = Math.max(0.5, diffs.length ? diffs[diffs.length >> 1] * 1.4826 : 1);
    for (let i = d; i + d < prof.length; i++) {
        const r = i * dr;
        if (r < loM || r > hiM) continue;
        const inner = prof[i - d], outer = prof[i + d];
        if (!Number.isFinite(inner) || !Number.isFinite(outer)) continue;
        const step = outer - inner;
        if (!best || Math.abs(step) > Math.abs(best.step)) best = { radiusM: r, step, snr: Math.abs(step) / noise };
    }
    return best;
}

export interface Period { count: number; phase: number; significance: number; duty: number }

/**
 * The strongest angular period of the luminance over the annulus [r0M, r1M] about (cx, cz), for counts in [kMin, kMax]:
 * its count, its phase (the angle of a maximum), its power over the median power of the other counts, and the share of
 * the circle brighter than the mean.
 */
export function angularPeriod(crop: TopDownCrop, cx: number, cz: number, r0M: number, r1M: number, kMin = 2, kMax = 16, bins = 360): Period | undefined {
    const prof = new Float64Array(bins);
    const rings = Math.max(1, Math.round((r1M - r0M) / crop.texelM));
    for (let b = 0; b < bins; b++) {
        const th = (2 * Math.PI * (b + 0.5)) / bins;
        let s = 0, c = 0;
        for (let k = 0; k <= rings; k++) {
            const r = r0M + ((r1M - r0M) * k) / rings;
            const L = luminanceAt(crop, cx + r * Math.cos(th), cz + r * Math.sin(th));
            if (Number.isFinite(L)) { s += L; c++; }
        }
        prof[b] = c ? s / c : NaN;
    }
    if (prof.some(v => !Number.isFinite(v))) return undefined;
    const mean = prof.reduce((a, b) => a + b, 0) / bins;
    const power: Array<{ k: number; p: number; phase: number }> = [];
    for (let k = kMin; k <= kMax; k++) {
        let re = 0, im = 0;
        for (let b = 0; b < bins; b++) { const th = (2 * Math.PI * (b + 0.5)) / bins; re += (prof[b] - mean) * Math.cos(k * th); im += (prof[b] - mean) * Math.sin(k * th); }
        power.push({ k, p: re * re + im * im, phase: Math.atan2(im, re) / k });
    }
    power.sort((a, b) => b.p - a.p);
    const rest = power.slice(1).map(x => x.p).sort((a, b) => a - b);
    const med = Math.max(1e-9, rest.length ? rest[rest.length >> 1] : 1e-9);
    const duty = prof.filter(v => v > mean).length / bins;
    return { count: power[0].k, phase: power[0].phase, significance: power[0].p / med, duty };
}

/** The strongest radial period (m) of the luminance between r0M and r1M about (cx, cz), with its significance. */
export function radialPeriod(crop: TopDownCrop, cx: number, cz: number, r0M: number, r1M: number, minPitchM: number, maxPitchM: number): { pitchM: number; significance: number } | undefined {
    const dr = crop.texelM / 2;
    const prof = radialProfile(crop, cx, cz, r1M, dr);
    const i0 = Math.ceil(r0M / dr);
    const xs = Array.from(prof.slice(i0)).filter(Number.isFinite);
    if (xs.length < 8) return undefined;
    // detrend (a line), then the power per pitch on a fine grid
    const n = xs.length, mx = (n - 1) / 2;
    const my = xs.reduce((a, b) => a + b, 0) / n;
    let sxy = 0, sxx = 0;
    xs.forEach((y, i) => { sxy += (i - mx) * (y - my); sxx += (i - mx) * (i - mx); });
    const slope = sxx ? sxy / sxx : 0;
    const res = xs.map((y, i) => y - my - slope * (i - mx));
    const out: Array<{ pitch: number; p: number }> = [];
    for (let pitch = Math.max(minPitchM, 2 * dr); pitch <= maxPitchM; pitch += dr / 4) {
        let re = 0, im = 0;
        res.forEach((y, i) => { const a = (2 * Math.PI * i * dr) / pitch; re += y * Math.cos(a); im += y * Math.sin(a); });
        out.push({ pitch, p: re * re + im * im });
    }
    if (!out.length) return undefined;
    out.sort((a, b) => b.p - a.p);
    const rest = out.slice(1).map(x => x.p).sort((a, b) => a - b);
    return { pitchM: out[0].pitch, significance: out[0].p / Math.max(1e-9, rest[rest.length >> 1] ?? 1e-9) };
}

// =============================================================================
// Held-out score: a model drawn by its structure, against a photo the proposals never read
// =============================================================================

/** A mesh part of the model: its surface and its id. */
export interface ModelPart { id: string; positions: Float32Array; normals: Float32Array; indices: Uint32Array }

/** Per pixel of `grid`: the index of the part whose surface is highest there (-1 none), and that surface's normal y. */
export function rasterPartsTopDown(parts: ModelPart[], grid: { x0: number; z0: number; texelM: number; width: number; height: number }): { part: Int32Array; normalY: Float32Array; height: Float32Array } {
    const W = grid.width, H = grid.height;
    const part = new Int32Array(W * H).fill(-1), normalY = new Float32Array(W * H), height = new Float32Array(W * H).fill(-Infinity);
    parts.forEach((m, pi) => {
        for (let t = 0; t + 2 < m.indices.length; t += 3) {
            const ia = m.indices[t] * 3, ib = m.indices[t + 1] * 3, ic = m.indices[t + 2] * 3;
            const ax = (m.positions[ia] - grid.x0) / grid.texelM, az = (m.positions[ia + 2] - grid.z0) / grid.texelM, ay = m.positions[ia + 1];
            const bx = (m.positions[ib] - grid.x0) / grid.texelM, bz = (m.positions[ib + 2] - grid.z0) / grid.texelM, by = m.positions[ib + 1];
            const cx = (m.positions[ic] - grid.x0) / grid.texelM, cz = (m.positions[ic + 2] - grid.z0) / grid.texelM, cy = m.positions[ic + 1];
            const den = (bz - cz) * (ax - cx) + (cx - bx) * (az - cz);
            if (Math.abs(den) < 1e-12) continue;
            // the face's normal y (the vertices' mean, unit)
            const nx = m.normals[ia] + m.normals[ib] + m.normals[ic], ny = m.normals[ia + 1] + m.normals[ib + 1] + m.normals[ic + 1], nz = m.normals[ia + 2] + m.normals[ib + 2] + m.normals[ic + 2];
            const fny = ny / Math.max(1e-9, Math.hypot(nx, ny, nz));
            const x0 = Math.max(0, Math.floor(Math.min(ax, bx, cx))), x1 = Math.min(W - 1, Math.ceil(Math.max(ax, bx, cx)));
            const z0 = Math.max(0, Math.floor(Math.min(az, bz, cz))), z1 = Math.min(H - 1, Math.ceil(Math.max(az, bz, cz)));
            for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) {
                const px = x + 0.5, pz = z + 0.5;
                const w0 = ((bz - cz) * (px - cx) + (cx - bx) * (pz - cz)) / den, w1 = ((cz - az) * (px - cx) + (ax - cx) * (pz - cz)) / den, w2 = 1 - w0 - w1;
                if (w0 < -1e-9 || w1 < -1e-9 || w2 < -1e-9) continue;
                const y = w0 * ay + w1 * by + w2 * cy, k = z * W + x;
                if (y > height[k]) { height[k] = y; part[k] = pi; normalY[k] = fny; }
            }
        }
    });
    return { part, normalY, height };
}

/**
 * The model drawn top-down over `context` (a crop of the same grid): each part in the median colour of the context
 * pixels it shows, times (0.8 + 0.2 |normal y|), so a wall or a slope seen from above reads darker; context elsewhere.
 * Returns the image and how many pixels each part shows.
 */
export function drawModelTopDown(parts: ModelPart[], context: TopDownCrop): { image: DecodedImage; shown: number[] } {
    const W = context.width, H = context.height;
    const r = rasterPartsTopDown(parts, { x0: context.x0, z0: context.z0, texelM: context.texelM, width: W, height: H });
    const samples: number[][][] = parts.map(() => [[], [], []]);
    for (let k = 0; k < W * H; k++) if (r.part[k] >= 0) for (let c = 0; c < 3; c++) samples[r.part[k]][c].push(context.rgba[k * 4 + c]);
    const colour = samples.map(s => s.map(ch => { const v = ch.slice().sort((p, q) => p - q); return v.length ? v[v.length >> 1] : 128; }));
    const rgba = new Uint8Array(context.rgba);
    for (let k = 0; k < W * H; k++) {
        const p = r.part[k];
        if (p < 0) continue;
        const shade = 0.8 + 0.2 * Math.abs(r.normalY[k]);
        for (let c = 0; c < 3; c++) rgba[k * 4 + c] = Math.max(0, Math.min(255, Math.round(colour[p][c] * shade)));
        rgba[k * 4 + 3] = 255;
    }
    return { image: { width: W, height: H, rgba }, shown: samples.map(s => s[0].length) };
}

function luminanceImage(img: DecodedImage): Float32Array {
    const out = new Float32Array(img.width * img.height);
    for (let k = 0; k < out.length; k++) out[k] = lum(img.rgba[k * 4], img.rgba[k * 4 + 1], img.rgba[k * 4 + 2]);
    return out;
}

function gradientMagnitude(L: Float32Array, w: number, h: number): Float32Array {
    const g = new Float32Array(w * h);
    for (let y = 1; y + 1 < h; y++) for (let x = 1; x + 1 < w; x++) {
        const k = y * w + x;
        const gx = L[k + 1] - L[k - 1], gy = L[k + w] - L[k - w];
        g[k] = Math.hypot(gx, gy);
    }
    return g;
}

export interface HeldOutScore { ssim: number | null; gradientNcc: number | null; pixels: number }

/** The model image against the held-out photo (same grid) inside the disc of `radiusM` about (cx, cz). */
export function heldOutScore(model: DecodedImage, heldOut: TopDownCrop, cx: number, cz: number, radiusM: number): HeldOutScore {
    const W = heldOut.width, H = heldOut.height;
    const mask = new Uint8Array(W * H);
    let pixels = 0;
    for (let z = 0; z < H; z++) for (let x = 0; x < W; x++) {
        if (Math.hypot(heldOut.x0 + (x + 0.5) * heldOut.texelM - cx, heldOut.z0 + (z + 0.5) * heldOut.texelM - cz) <= radiusM) { mask[z * W + x] = 1; pixels++; }
    }
    const La = luminanceImage(model), Lb = luminanceImage({ width: W, height: H, rgba: heldOut.rgba });
    const ssim = maskedSsim(La, Lb, W, H, mask);
    const gradientNcc = maskedNcc(gradientMagnitude(La, W, H), gradientMagnitude(Lb, W, H), mask, 50);
    return { ssim: ssim === null ? null : round(ssim, 5), gradientNcc: gradientNcc === null ? null : round(gradientNcc, 5), pixels };
}

/** A north-up image whose pixel (0, 0) has its corner at plan (x0, z0), `pixelM` per pixel (the held-out photo). */
export interface PlanImage { image: DecodedImage; x0: number; z0: number; pixelM: number }

/** `source` resampled (bilinear) onto `grid`, shifted by (dx, dz) in plan; alpha 0 where it has no pixel. */
export function resamplePlanImage(source: PlanImage, grid: { x0: number; z0: number; texelM: number; width: number; height: number }, dx = 0, dz = 0): TopDownCrop {
    const W = grid.width, H = grid.height, rgba = new Uint8Array(W * H * 4);
    const im = source.image;
    for (let z = 0; z < H; z++) for (let x = 0; x < W; x++) {
        const px = grid.x0 + (x + 0.5) * grid.texelM + dx, pz = grid.z0 + (z + 0.5) * grid.texelM + dz;
        const fx = (px - source.x0) / source.pixelM - 0.5, fz = (pz - source.z0) / source.pixelM - 0.5;
        const ix = Math.floor(fx), iz = Math.floor(fz), tx = fx - ix, tz = fz - iz;
        const k = (z * W + x) * 4;
        if (ix < 0 || iz < 0 || ix + 1 >= im.width || iz + 1 >= im.height) continue;
        for (let c = 0; c < 3; c++) {
            const v = (im.rgba[(iz * im.width + ix) * 4 + c] * (1 - tx) + im.rgba[(iz * im.width + ix + 1) * 4 + c] * tx) * (1 - tz) + (im.rgba[((iz + 1) * im.width + ix) * 4 + c] * (1 - tx) + im.rgba[((iz + 1) * im.width + ix + 1) * 4 + c] * tx) * tz;
            rgba[k + c] = Math.round(v);
        }
        rgba[k + 3] = 255;
    }
    return { rgba, width: W, height: H, x0: grid.x0, z0: grid.z0, texelM: grid.texelM };
}

/**
 * The plan shift (m) that registers `source` on the tile photo `tile` (best normalised correlation of luminance over
 * shifts up to `searchM`, coarse then fine, in steps of the tile's texel). Run it on a coarse, wide tile crop: the
 * shift then applies to every finer crop of the same place.
 */
export function registerPlanImage(source: PlanImage, tile: TopDownCrop, searchM = 2): { shiftM: [number, number]; ncc: number } {
    const Lt = luminanceImage(tile);
    const steps = Math.max(1, Math.round(searchM / tile.texelM)), stride = Math.max(1, Math.round(steps / 6));
    let best = { i: 0, j: 0, ncc: -Infinity };
    const tryShift = (i: number, j: number) => {
        const c = resamplePlanImage(source, tile, i * tile.texelM, j * tile.texelM);
        const mask = new Uint8Array(tile.width * tile.height);
        for (let k = 0; k < mask.length; k++) mask[k] = c.rgba[k * 4 + 3] ? 1 : 0;
        const v = maskedNcc(Lt, luminanceImage(c), mask, 200);
        if (v !== null && v > best.ncc) best = { i, j, ncc: v };
    };
    for (let j = -steps; j <= steps; j += stride) for (let i = -steps; i <= steps; i += stride) tryShift(i, j);
    const ci = best.i, cj = best.j;
    if (stride > 1) for (let j = cj - stride + 1; j < cj + stride; j++) for (let i = ci - stride + 1; i < ci + stride; i++) if (Math.abs(i) <= steps && Math.abs(j) <= steps && (i !== ci || j !== cj)) tryShift(i, j);
    return { shiftM: [round(best.i * tile.texelM, 3), round(best.j * tile.texelM, 3)], ncc: round(best.ncc, 4) };
}

const round = (v: number, d: number) => Math.round(v * 10 ** d) / 10 ** d;
