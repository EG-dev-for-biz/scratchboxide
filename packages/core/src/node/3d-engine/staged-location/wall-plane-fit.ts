/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Plane-first walls (user direction, 2026-10-22): a building's walls are planes far more often than anything else, so each
 * wall of a rebuilt building starts as one plumb plane on its Google vector footprint edge, its offset (and, only when the
 * scan clearly asks for it, a small yaw) measured robustly from the scan; the scan's own bumpiness and faceting is noise
 * about that plane, never geometry. Relief is added only where the scan departs from the plane consistently over a real
 * area (a recess, a bay, a colonnade): a connected region of the smoothed residual deeper than RELIEF.minDepthM, at least
 * minAreaM2 and minSideM on each side, filling its box and of one depth. Everything else is snapped to the plane.
 *
 * Per wall, the scan is read as an outermost-surface depth map in the wall's own frame (s along the edge, t = height, h
 * along the outward normal): the scan's near-vertical surface sampled every SAMPLE_SPACING_M, the outermost h per cell.
 * The plane is the robust mode of h (the area the most cells agree on within inlierM), refined by least squares on its
 * inliers; the record keeps its coverage, inlier share, RMS, plumb tilt (measured, not applied: walls stay plumb), the top
 * the scan measures, and the residual map.
 *
 * A wall the scan hardly sees keeps its vector edge (`unseen`); one seen but with no clean plane (a lumpy field, a tree the
 * strip left) is placed at the median depth of what the scan shows (`estimated`, a labelled guess); one with a clean plane
 * is `measured`. Nothing here names a kind of building or facade: walls are edges and numbers.
 */

import type { Vec2 } from '../../../common/spatial/staged-location-contracts';

export const WALL_PLANE_FIT_VERSION = 'wall-plane-fit/1';

export const WALL_FIT_PARAMS = {
    /** Depth-map cell, metres (s and t). */
    cellM: 0.5,
    /** How far behind / in front of the vector edge the scan's facade is looked for, metres. */
    reachBackM: 4.0,
    reachFrontM: 4.0,
    /** Cells this close to the wall's ends, its foot and its top are not used for the plane (corners, kerbs, parapets). */
    endSkipM: 0.5,
    bottomSkipM: 1.0,
    topSkipM: 0.5,
    /** Below this share of the wall's cells seen, the vector edge stands. */
    minCoverage: 0.2,
    /** A cell agrees with the plane within this, metres. */
    inlierM: 0.2,
    /** Below this share of the seen cells agreeing, the plane is not clean: the wall is placed at the median depth (estimated). */
    minInlierShare: 0.3,
    /** A yaw off the vector edge is taken only when it explains this many times more cells, and within maxYawDeg. */
    yawGain: 1.2,
    maxYawDeg: 5,
    /** A sample counts only when its surface faces along the wall's normal at least this much (|cos|, sign-free). */
    minFacing: 0.5,
    /** A wall shorter than this keeps its vector edge (a jog in the plan, too short to measure). */
    minLengthM: 2.0,
    /** A wall lower than this keeps its vector edge (a thin tier's edge: too little facade to measure). */
    minHeightM: 2.5
};

/**
 * A setback along one footprint edge: the scan's facade standing off the wall's plane by one depth over most of the wall's
 * height for a run of its length (the edge is one straight line in the vector data, the building steps). The edge is then
 * split there and each run fitted as its own plane, joined by a return wall.
 */
export const STEP_PARAMS = {
    /** A run at least this long, standing off the plane by at least minStepM, its columns within stepToleranceM of one depth. */
    minRunM: 3,
    minStepM: 0.6,
    stepToleranceM: 0.5,
    /** Share of a column's seen height that must stand off (a full-height step, not a partial recess). */
    minColumnShare: 0.6,
    /** A column counts when the scan sees at least this share of its fitting rows. */
    minColumnSeen: 0.35
};

export const RELIEF_PARAMS = {
    /** Depth below which a departure from the plane is facade texture, not geometry (window reveals, the scan's lumps). */
    minDepthM: 0.5,
    /** The region's area and its shorter side: a real recess or bay, not a lump. */
    minAreaM2: 4,
    minSideM: 1.5,
    /** Share of the region's box it fills (a box, not a scatter). */
    minFill: 0.6,
    /** Its depth is one depth: the median absolute deviation at most this share of the depth (and at least minSpreadM). */
    maxSpreadShare: 0.35,
    minSpreadM: 0.2,
    /** A region spanning more than this share of the wall is the plane's own doing, never relief. */
    maxWallShare: 0.6,
    /** Relief is never deeper than this, metres. */
    maxDepthM: 6
};

// ------------------------------------------------------------------------------------------------
// the scan as samples
// ------------------------------------------------------------------------------------------------

/** Spacing of the samples taken on each scan triangle, metres. */
export const SAMPLE_SPACING_M = 0.35;
/** Surfaces steeper than this (|normal y| below it) are walls; flatter ones are roofs and ground. */
export const MAX_WALL_NORMAL_Y = 0.75;

/** The scan's near-vertical surface as points (with their surface's plan normal, sign-free), hashed on the plan. */
export interface WallSampleIndex {
    x: Float32Array; y: Float32Array; z: Float32Array;
    /** The sample's triangle normal in the plan, unit, times 127 (its sign arbitrary: photogrammetry winding is mixed). */
    nx: Int8Array; nz: Int8Array;
    cellM: number;
    cells: Map<number, number[]>;
    count: number;
}

const hashCell = (i: number, k: number) => (i + 32768) * 65536 + (k + 32768);

/**
 * Samples the scan's near-vertical triangles at about `spacing` metres (a low-discrepancy set over each triangle, 1.5 per
 * spacing squared of its area, at least one) and hashes them on a plan grid. `keep` limits it to the plan region of interest.
 */
export function wallSampleIndex(positions: ArrayLike<number>, indices: ArrayLike<number>, opts: { spacing?: number; cellM?: number; keep?: (x: number, z: number) => boolean } = {}): WallSampleIndex {
    const spacing = opts.spacing ?? SAMPLE_SPACING_M, cellM = opts.cellM ?? 4;
    const xs: number[] = [], ys: number[] = [], zs: number[] = [], nxs: number[] = [], nzs: number[] = [];
    const T = Math.floor(indices.length / 3);
    const G = 1.32471795724474602596, a1 = 1 / G, a2 = 1 / (G * G);   // the R2 sequence
    for (let t = 0; t < T; t++) {
        const ia = indices[t * 3] * 3, ib = indices[t * 3 + 1] * 3, ic = indices[t * 3 + 2] * 3;
        const ax = positions[ia], ay = positions[ia + 1], az = positions[ia + 2];
        const bx = positions[ib], by = positions[ib + 1], bz = positions[ib + 2];
        const cx = positions[ic], cy = positions[ic + 1], cz = positions[ic + 2];
        if (opts.keep && !opts.keep((ax + bx + cx) / 3, (az + bz + cz) / 3)) continue;
        const ux = bx - ax, uy = by - ay, uz = bz - az, vx = cx - ax, vy = cy - ay, vz = cz - az;
        const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
        const nl = Math.hypot(nx, ny, nz);
        if (nl < 1e-9 || Math.abs(ny / nl) > MAX_WALL_NORMAL_Y) continue;
        const ph = Math.hypot(nx, nz);
        const qx = Math.round((nx / ph) * 127), qz = Math.round((nz / ph) * 127);
        const area = nl / 2;
        const count = Math.max(1, Math.min(20000, Math.ceil((1.5 * area) / (spacing * spacing))));
        for (let k = 0; k < count; k++) {
            let u = (0.5 + a1 * (k + 1)) % 1, v = (0.5 + a2 * (k + 1)) % 1;
            if (u + v > 1) { u = 1 - u; v = 1 - v; }
            xs.push(ax + ux * u + vx * v); ys.push(ay + uy * u + vy * v); zs.push(az + uz * u + vz * v); nxs.push(qx); nzs.push(qz);
        }
    }
    const cells = new Map<number, number[]>();
    for (let p = 0; p < xs.length; p++) {
        const key = hashCell(Math.floor(xs[p] / cellM), Math.floor(zs[p] / cellM));
        const list = cells.get(key);
        if (list) list.push(p); else cells.set(key, [p]);
    }
    return { x: Float32Array.from(xs), y: Float32Array.from(ys), z: Float32Array.from(zs), nx: Int8Array.from(nxs), nz: Int8Array.from(nzs), cellM, cells, count: xs.length };
}

function query(ix: WallSampleIndex, x0: number, z0: number, x1: number, z1: number, out: number[]): void {
    out.length = 0;
    const i0 = Math.floor(x0 / ix.cellM), i1 = Math.floor(x1 / ix.cellM), k0 = Math.floor(z0 / ix.cellM), k1 = Math.floor(z1 / ix.cellM);
    for (let k = k0; k <= k1; k++) for (let i = i0; i <= i1; i++) {
        const l = ix.cells.get(hashCell(i, k));
        if (l) for (const p of l) out.push(p);
    }
}

// ------------------------------------------------------------------------------------------------
// one wall
// ------------------------------------------------------------------------------------------------

export interface WallInput {
    /** The vector edge, from a to b, in the tile frame (x east, z south). */
    a: Vec2; b: Vec2;
    /** Unit outward normal in the plan. */
    outward: Vec2;
    baseY: number; topY: number;
}

export interface WallRelief {
    /** Along the edge from its start (s) and height (t, world y), metres. */
    s0: number; s1: number; t0: number; t1: number;
    /** Along the outward normal from the wall's plane: negative a recess, positive a projection. */
    depthM: number;
    areaM2: number; fill: number; spreadM: number;
}

/** measured: a clean plane; estimated: the median of a lumpy scan; unseen: the vector edge as given; step: the return joining two measured runs of one edge. */
export type WallFitStatus = 'measured' | 'estimated' | 'unseen' | 'step';

export interface WallPlaneFit {
    status: WallFitStatus;
    /** Why, in words (unseen / estimated walls). */
    reason?: string;
    lengthM: number;
    /** The plane: h = offsetM + tan(yaw) (s - L/2) along the outward normal from the vector edge. */
    offsetM: number; yawDeg: number;
    /** The plane's lean the scan measures (degrees, positive leaning out at the top); not applied, walls stay plumb. */
    plumbDeg: number;
    /** The wall's top the scan measures there (median over the wall's columns), NaN when unseen. */
    topYMeasured: number;
    /** Share of the wall's cells the scan sees; share of those within inlierM of the plane. */
    coverage: number; inlierShare: number;
    /** Residual of the seen cells to the plane: within 1 m (the facade's own roughness), and of all seen cells against the plane with its relief. */
    rmsM: number; rmsWithReliefM: number; p90M: number;
    seenCells: number;
    relief: WallRelief[];
    /** The residual map (outermost scan depth minus the plane; NaN unseen), ns x nt cells of cellM from (s 0, t baseY), row-major in t. */
    residual?: { cellM: number; ns: number; nt: number; t0: number; r: Float32Array };
}

/** Deterministic pseudo-random sequence (the fit is reproducible run to run). */
function lcg(seed: number): () => number {
    let s = seed >>> 0;
    return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
}

const medianOf = (v: number[]): number => { if (!v.length) return NaN; const s = [...v].sort((p, q) => p - q); return s[s.length >> 1]; };

export function fitWallPlane(wall: WallInput, ix: WallSampleIndex, P = WALL_FIT_PARAMS, R = RELIEF_PARAMS, opts: { keepResidual?: boolean } = {}): WallPlaneFit {
    const dx = wall.b[0] - wall.a[0], dz = wall.b[1] - wall.a[1];
    const L = Math.hypot(dx, dz);
    const empty = (reason: string, extra: Partial<WallPlaneFit> = {}): WallPlaneFit => ({
        status: 'unseen', reason, lengthM: L, offsetM: 0, yawDeg: 0, plumbDeg: 0, topYMeasured: NaN, coverage: 0, inlierShare: 0,
        rmsM: NaN, rmsWithReliefM: NaN, p90M: NaN, seenCells: 0, relief: [], ...extra
    });
    const H = wall.topY - wall.baseY;
    if (L < P.minLengthM) return empty(`the wall is ${L.toFixed(1)} m long (under ${P.minLengthM} m): too short to measure`);
    if (H < P.minHeightM) return empty(`the wall is ${H.toFixed(1)} m tall (under ${P.minHeightM} m): too little facade to measure`);
    const d: Vec2 = [dx / L, dz / L], n = wall.outward;
    const cell = P.cellM;
    const ns = Math.max(1, Math.ceil(L / cell)), nt = Math.max(1, Math.ceil(H / cell));
    const depth = new Float32Array(ns * nt).fill(NaN);
    const reach = Math.max(P.reachBackM, P.reachFrontM) + 0.5;
    const xs = [wall.a[0], wall.b[0]], zs = [wall.a[1], wall.b[1]];
    const cand: number[] = [];
    query(ix, Math.min(...xs) - reach, Math.min(...zs) - reach, Math.max(...xs) + reach, Math.max(...zs) + reach, cand);
    const near: number[] = [];
    for (const p of cand) {
        const rx = ix.x[p] - wall.a[0], rz = ix.z[p] - wall.a[1];
        const s = rx * d[0] + rz * d[1];
        if (s < 0 || s >= L) continue;
        const h = rx * n[0] + rz * n[1];
        if (h < -P.reachBackM || h > P.reachFrontM) continue;
        // a surface facing along the wall (a return, a reveal, the neighbour's side wall) says nothing of its depth
        if (Math.abs(ix.nx[p] * n[0] + ix.nz[p] * n[1]) < 127 * P.minFacing) continue;
        const y = ix.y[p];
        if (y < wall.baseY || y > wall.topY + 3) continue;
        near.push(p);
        if (y >= wall.topY) continue;
        const ci = Math.min(ns - 1, Math.floor(s / cell)), cj = Math.min(nt - 1, Math.floor((y - wall.baseY) / cell));
        const k = cj * ns + ci;
        if (!(depth[k] >= h)) depth[k] = h;   // the outermost surface (NaN compares false)
    }
    // the cells the plane is measured on
    const fitCell = (ci: number, cj: number) => {
        const s = (ci + 0.5) * cell, t = wall.baseY + (cj + 0.5) * cell;
        return s >= P.endSkipM && s <= L - P.endSkipM && t >= wall.baseY + Math.min(P.bottomSkipM, H / 3) && t <= wall.topY - Math.min(P.topSkipM, H / 3);
    };
    const S: number[] = [], T: number[] = [], Hs: number[] = [];
    let total = 0;
    for (let cj = 0; cj < nt; cj++) for (let ci = 0; ci < ns; ci++) {
        if (!fitCell(ci, cj)) continue;
        total++;
        const h = depth[cj * ns + ci];
        if (Number.isFinite(h)) { S.push((ci + 0.5) * cell - L / 2); T.push(wall.baseY + (cj + 0.5) * cell); Hs.push(h); }
    }
    const coverage = total ? Hs.length / total : 0;
    if (coverage < P.minCoverage || Hs.length < 8) return empty(`the scan sees ${Math.round(coverage * 100)}% of the wall (at least ${Math.round(P.minCoverage * 100)}% needed): the vector edge stands`, { coverage: r3(coverage), seenCells: Hs.length });
    // the mode of h with no yaw: the window of +-inlierM the most cells fall in
    const sortedH = [...Hs].sort((p, q) => p - q);
    let best0 = 0, bestLo = 0;
    for (let i = 0, j = 0; i < sortedH.length; i++) {
        while (sortedH[j] < sortedH[i] - 2 * P.inlierM) j++;
        if (i - j + 1 > best0) { best0 = i - j + 1; bestLo = j; }
    }
    let off = 0;
    for (let i = bestLo; i < bestLo + best0; i++) off += sortedH[i];
    off /= best0;
    let yaw = 0;
    // a yaw: two-cell hypotheses (RANSAC), kept only when it explains clearly more cells than the edge's own direction
    const rnd = lcg(Math.round((wall.a[0] * 73.1 + wall.a[1] * 19.7 + L * 7.3) * 1000));
    const maxK = Math.tan((P.maxYawDeg * Math.PI) / 180);
    const countIn = (o: number, k: number) => { let c = 0; for (let i = 0; i < Hs.length; i++) if (Math.abs(Hs[i] - o - k * S[i]) <= P.inlierM) c++; return c; };
    let bestYawCount = countIn(off, 0), bestO = off, bestK = 0;
    const base0 = bestYawCount;
    if (L >= 6) for (let it = 0; it < 300; it++) {
        const i = Math.floor(rnd() * Hs.length), j = Math.floor(rnd() * Hs.length);
        if (Math.abs(S[i] - S[j]) < L / 4) continue;
        const k = (Hs[j] - Hs[i]) / (S[j] - S[i]);
        if (Math.abs(k) > maxK) continue;
        const o = Hs[i] - k * S[i];
        const c = countIn(o, k);
        if (c > bestYawCount) { bestYawCount = c; bestO = o; bestK = k; }
    }
    if (bestYawCount >= P.yawGain * base0 && Math.abs(bestK) * L / 2 > 0.1) { off = bestO; yaw = bestK; }
    // least squares on the inliers (two rounds)
    for (let round = 0; round < 2; round++) {
        let sw = 0, sh = 0, ss = 0, ssh = 0, sss = 0;
        for (let i = 0; i < Hs.length; i++) {
            if (Math.abs(Hs[i] - off - yaw * S[i]) > P.inlierM * 1.5) continue;
            sw++; sh += Hs[i]; ss += S[i]; ssh += S[i] * Hs[i]; sss += S[i] * S[i];
        }
        if (sw < 3) break;
        if (yaw !== 0) {
            const den = sw * sss - ss * ss;
            if (Math.abs(den) > 1e-9) { const k = (sw * ssh - ss * sh) / den; if (Math.abs(k) <= maxK) { yaw = k; off = (sh - k * ss) / sw; continue; } }
        }
        off = (sh - yaw * ss) / sw;
    }
    let inliers = countIn(off, yaw);
    let inlierShare = inliers / Hs.length;
    let status: WallFitStatus = 'measured';
    let reason: string | undefined;
    if (inlierShare < P.minInlierShare) {
        // seen, but no clean plane: the median depth of what the scan shows, as plumb as the edge (an honest estimate)
        status = 'estimated';
        off = medianOf(Hs); yaw = 0;
        inliers = countIn(off, 0); inlierShare = inliers / Hs.length;
        reason = `no clean plane in the scan (${Math.round((bestYawCount / Hs.length) * 100)}% of the seen wall within ${P.inlierM} m of the best one): placed at the median depth the scan shows`;
    }
    const lim = Math.min(P.reachBackM, P.reachFrontM);
    if (Math.abs(off) > lim) { status = 'estimated'; reason = `the plane lies ${off.toFixed(1)} m off the edge (past ${lim} m): clamped`; off = Math.sign(off) * lim; }
    // plumb: the inliers' lean over height (reported only)
    let st = 0, stt = 0, sr = 0, str = 0, sn = 0;
    for (let i = 0; i < Hs.length; i++) {
        const r = Hs[i] - off - yaw * S[i];
        if (Math.abs(r) > P.inlierM * 1.5) continue;
        sn++; st += T[i]; stt += T[i] * T[i]; sr += r; str += T[i] * r;
    }
    const lean = sn > 3 && sn * stt - st * st > 1e-9 ? (sn * str - st * sr) / (sn * stt - st * st) : 0;
    // the residual map and the facade's roughness about the plane
    const plane = (s: number) => off + yaw * (s - L / 2);
    const r = new Float32Array(ns * nt).fill(NaN);
    for (let cj = 0; cj < nt; cj++) for (let ci = 0; ci < ns; ci++) {
        const h = depth[cj * ns + ci];
        if (Number.isFinite(h)) r[cj * ns + ci] = h - plane((ci + 0.5) * cell);
    }
    const relief = status === 'measured' ? findRelief(r, ns, nt, cell, wall.baseY, L, H, R) : [];
    const within1: number[] = [], all: number[] = [];
    for (let cj = 0; cj < nt; cj++) for (let ci = 0; ci < ns; ci++) {
        if (!fitCell(ci, cj)) continue;
        const v = r[cj * ns + ci];
        if (!Number.isFinite(v)) continue;
        if (Math.abs(v) <= 1) within1.push(v * v);
        const s = (ci + 0.5) * cell, t = wall.baseY + (cj + 0.5) * cell;
        const rel = relief.find(q => s >= q.s0 && s <= q.s1 && t >= q.t0 && t <= q.t1);
        all.push(Math.abs(v - (rel ? rel.depthM : 0)));
    }
    const rms = within1.length ? Math.sqrt(within1.reduce((p, q) => p + q, 0) / within1.length) : NaN;
    const rmsAll = all.length ? Math.sqrt(all.reduce((p, q) => p + q * q, 0) / all.length) : NaN;
    const p90 = all.length ? [...all].sort((p, q) => p - q)[Math.floor(0.9 * (all.length - 1))] : NaN;
    // the top the scan measures: per column, the highest wall sample on the plane
    const colTop = new Float32Array(ns).fill(NaN);
    for (const p of near) {
        const rx = ix.x[p] - wall.a[0], rz = ix.z[p] - wall.a[1];
        const s = rx * d[0] + rz * d[1], h = rx * n[0] + rz * n[1];
        if (Math.abs(h - plane(s)) > 0.6) continue;
        const ci = Math.min(ns - 1, Math.floor(s / cell));
        if (!(colTop[ci] >= ix.y[p])) colTop[ci] = ix.y[p];
    }
    const tops = Array.from(colTop).filter(Number.isFinite);
    return {
        status, ...(reason ? { reason } : {}), lengthM: r3(L), offsetM: r3(off), yawDeg: r3((Math.atan(yaw) * 180) / Math.PI), plumbDeg: r3((Math.atan(lean) * 180) / Math.PI),
        topYMeasured: tops.length >= 3 ? r3(medianOf(tops)) : NaN, coverage: r3(coverage), inlierShare: r3(inlierShare),
        rmsM: r3(rms), rmsWithReliefM: r3(rmsAll), p90M: r3(p90), seenCells: Hs.length, relief,
        ...(opts.keepResidual ? { residual: { cellM: cell, ns, nt, t0: wall.baseY, r } } : {})
    };
}

const r3 = (v: number) => (Number.isFinite(v) ? Math.round(v * 1000) / 1000 : v);

/**
 * The relief a wall's residual map holds: the map smoothed (3 x 3 median over seen cells, so a lump narrower than the window
 * goes), cells departing at least minDepthM split by sign, 4-connected regions; a region is relief only when it is large
 * (area, both sides), fills its box, and is of one depth. Its box and median depth (of the unsmoothed residual) are kept.
 */
export function findRelief(r: Float32Array, ns: number, nt: number, cell: number, t0: number, L: number, H: number, R = RELIEF_PARAMS): WallRelief[] {
    const sm = new Float32Array(ns * nt).fill(NaN);
    const win: number[] = [];
    for (let cj = 0; cj < nt; cj++) for (let ci = 0; ci < ns; ci++) {
        if (!Number.isFinite(r[cj * ns + ci])) continue;
        win.length = 0;
        for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
            const i = ci + di, j = cj + dj;
            if (i < 0 || j < 0 || i >= ns || j >= nt) continue;
            const v = r[j * ns + i];
            if (Number.isFinite(v)) win.push(v);
        }
        if (win.length >= 5) sm[cj * ns + ci] = medianOf(win);
    }
    const sign = new Int8Array(ns * nt);
    for (let k = 0; k < ns * nt; k++) if (Math.abs(sm[k]) >= R.minDepthM) sign[k] = sm[k] > 0 ? 1 : -1;
    const seen = new Uint8Array(ns * nt);
    const out: WallRelief[] = [];
    for (let k0 = 0; k0 < ns * nt; k0++) {
        if (!sign[k0] || seen[k0]) continue;
        const sg = sign[k0];
        const stack = [k0], members: number[] = [];
        seen[k0] = 1;
        while (stack.length) {
            const k = stack.pop()!;
            members.push(k);
            const ci = k % ns, cj = (k / ns) | 0;
            for (const [i, j] of [[ci - 1, cj], [ci + 1, cj], [ci, cj - 1], [ci, cj + 1]]) {
                if (i < 0 || j < 0 || i >= ns || j >= nt) continue;
                const q = j * ns + i;
                if (seen[q] || sign[q] !== sg) continue;
                seen[q] = 1;
                stack.push(q);
            }
        }
        const area = members.length * cell * cell;
        if (area < R.minAreaM2) continue;
        let i0 = ns, i1 = -1, j0 = nt, j1 = -1;
        for (const k of members) { const ci = k % ns, cj = (k / ns) | 0; i0 = Math.min(i0, ci); i1 = Math.max(i1, ci); j0 = Math.min(j0, cj); j1 = Math.max(j1, cj); }
        const w = (i1 - i0 + 1) * cell, h = (j1 - j0 + 1) * cell;
        if (w < R.minSideM || h < R.minSideM) continue;
        // the box's seen cells: the region must fill them
        let boxSeen = 0;
        for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) if (Number.isFinite(r[j * ns + i])) boxSeen++;
        const fill = members.length / Math.max(1, boxSeen);
        if (fill < R.minFill) continue;
        if (w * h > R.maxWallShare * L * H) continue;
        const raw = members.map(k => r[k]).filter(Number.isFinite);
        const depth = medianOf(raw);
        if (Math.abs(depth) < R.minDepthM) continue;
        const spread = medianOf(raw.map(v => Math.abs(v - depth)));
        if (spread > Math.max(R.minSpreadM, R.maxSpreadShare * Math.abs(depth))) continue;
        out.push({
            s0: r3(i0 * cell), s1: r3(Math.min(L, (i1 + 1) * cell)), t0: r3(t0 + j0 * cell), t1: r3(Math.min(t0 + H, t0 + (j1 + 1) * cell)),
            depthM: r3(Math.sign(depth) * Math.min(R.maxDepthM, Math.abs(depth))), areaM2: r3(area), fill: r3(fill), spreadM: r3(spread)
        });
    }
    return out;
}

// ------------------------------------------------------------------------------------------------
// a loop's walls onto their planes
// ------------------------------------------------------------------------------------------------

/** The fitted line of an edge: a point on it and its direction (plan). */
export interface FittedLine { p: Vec2; d: Vec2 }

export function fittedLine(a: Vec2, b: Vec2, outward: Vec2, fit: Pick<WallPlaneFit, 'offsetM' | 'yawDeg' | 'status'>): FittedLine {
    const L = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
    const d: Vec2 = [(b[0] - a[0]) / L, (b[1] - a[1]) / L];
    if (fit.status === 'unseen') return { p: a, d };
    const k = Math.tan((fit.yawDeg * Math.PI) / 180);
    const mid: Vec2 = [(a[0] + b[0]) / 2 + outward[0] * fit.offsetM, (a[1] + b[1]) / 2 + outward[1] * fit.offsetM];
    const dd: Vec2 = [d[0] + outward[0] * k, d[1] + outward[1] * k];
    const l = Math.hypot(dd[0], dd[1]);
    return { p: mid, d: [dd[0] / l, dd[1] / l] };
}

/** Where two consecutive fitted lines meet, near the original corner `ref` (nearly parallel neighbours, or a corner flung far off, meet halfway). */
export function lineCorner(l0: FittedLine, l1: FittedLine, ref: Vec2): Vec2 {
    const onLine = (l: FittedLine): Vec2 => { const t = (ref[0] - l.p[0]) * l.d[0] + (ref[1] - l.p[1]) * l.d[1]; return [l.p[0] + l.d[0] * t, l.p[1] + l.d[1] * t]; };
    const half = (): Vec2 => { const p = onLine(l0), q = onLine(l1); return [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2]; };
    const den = l0.d[0] * l1.d[1] - l0.d[1] * l1.d[0];
    if (Math.abs(den) < 0.17) return half();
    const u = ((l1.p[0] - l0.p[0]) * l1.d[1] - (l1.p[1] - l0.p[1]) * l1.d[0]) / den;
    const c: Vec2 = [l0.p[0] + u * l0.d[0], l0.p[1] + u * l0.d[1]];
    return Math.hypot(c[0] - ref[0], c[1] - ref[1]) > 8 ? half() : c;
}

/** The point of line `l` nearest `ref`. */
export function onFittedLine(l: FittedLine, ref: Vec2): Vec2 {
    const t = (ref[0] - l.p[0]) * l.d[0] + (ref[1] - l.p[1]) * l.d[1];
    return [l.p[0] + l.d[0] * t, l.p[1] + l.d[1] * t];
}

/** Consecutive fitted lines re-intersected at the loop's corners. */
export function intersectLoop(lines: FittedLine[], original: Vec2[]): Vec2[] {
    const N = lines.length;
    return original.map((ref, i) => lineCorner(lines[(i + N - 1) % N], lines[i], ref));
}

/** Each edge's unit outward normal for a part's loops (the first outer, the rest holes): the side the part is not on. */
export function outwardNormals(loop: Vec2[], inside: (x: number, z: number) => boolean): Vec2[] {
    const N = loop.length;
    const out: Vec2[] = [];
    for (let e = 0; e < N; e++) {
        const a = loop[e], b = loop[(e + 1) % N];
        const l = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
        let nrm: Vec2 = [(b[1] - a[1]) / l, -(b[0] - a[0]) / l];
        const m: Vec2 = [(a[0] + b[0]) / 2 + nrm[0] * 0.05, (a[1] + b[1]) / 2 + nrm[1] * 0.05];
        if (inside(m[0], m[1])) nrm = [-nrm[0], -nrm[1]];
        out.push(nrm);
    }
    return out;
}

/**
 * The setbacks along a measured wall (STEP_PARAMS): per column, the median of its residual over the fitting rows (a column
 * the scan sees too little of is unknown), smoothed over five columns; runs of columns standing off the plane by about one
 * depth, long enough, over most of their height. Returns the runs along s (metres from the edge's start) with their depth.
 */
export function findSteps(fit: Pick<WallPlaneFit, 'residual' | 'status' | 'lengthM'>, baseY: number, topY: number, P = WALL_FIT_PARAMS, S = STEP_PARAMS): Array<{ s0: number; s1: number; depthM: number }> {
    const m = fit.residual;
    if (!m || fit.status !== 'measured' || fit.lengthM < 2 * S.minRunM) return [];
    const H = topY - baseY;
    const j0 = Math.max(0, Math.floor(Math.min(P.bottomSkipM, H / 3) / m.cellM)), j1 = Math.min(m.nt - 1, Math.ceil((H - Math.min(P.topSkipM, H / 3)) / m.cellM) - 1);
    const rows = Math.max(1, j1 - j0 + 1);
    const col = new Float32Array(m.ns).fill(NaN), share = new Float32Array(m.ns).fill(0);
    for (let i = 0; i < m.ns; i++) {
        const v: number[] = [];
        for (let j = j0; j <= j1; j++) { const r = m.r[j * m.ns + i]; if (Number.isFinite(r)) v.push(r); }
        if (v.length < S.minColumnSeen * rows) continue;
        const med = medianOf(v);
        col[i] = med;
        share[i] = v.filter(r => Math.abs(r - med) <= S.stepToleranceM).length / v.length;
    }
    const sm = new Float32Array(m.ns).fill(NaN);
    for (let i = 0; i < m.ns; i++) {
        const v: number[] = [];
        for (let k = Math.max(0, i - 2); k <= Math.min(m.ns - 1, i + 2); k++) if (Number.isFinite(col[k])) v.push(col[k]);
        if (Number.isFinite(col[i]) && v.length >= 3) sm[i] = medianOf(v);
    }
    const out: Array<{ s0: number; s1: number; depthM: number }> = [];
    let i = 0;
    while (i < m.ns) {
        if (!(Math.abs(sm[i]) >= S.minStepM) || share[i] < S.minColumnShare) { i++; continue; }
        // grow the run while the columns stay about one depth (an unseen column inside the run is allowed, one at a time)
        const vals = [sm[i]];
        let k = i + 1, gap = 0;
        while (k < m.ns) {
            const v = sm[k];
            if (!Number.isFinite(v)) { if (++gap > 2) break; k++; continue; }
            const med = medianOf(vals);
            if (Math.abs(v - med) > S.stepToleranceM || share[k] < S.minColumnShare || Math.sign(v) !== Math.sign(med)) break;
            vals.push(v); gap = 0; k++;
        }
        const s0 = i * m.cellM, s1 = Math.min(fit.lengthM, (k - gap) * m.cellM);
        if (s1 - s0 >= S.minRunM) out.push({ s0: r3(s0), s1: r3(s1), depthM: r3(medianOf(vals)) });
        i = Math.max(k, i + 1);
    }
    return out;
}

// ------------------------------------------------------------------------------------------------
// a building's footprint registered to the scan
// ------------------------------------------------------------------------------------------------

export interface FootprintRegistration {
    applied: boolean;
    reason?: string;
    /** The shift (plan, metres) and the rotation about `centre` (degrees, counter-clockwise seen from above with x east, z south: positive turns x toward z). */
    shift: Vec2; rotationDeg: number; centre: Vec2;
    /** Walls used, and the RMS of their offsets before and after the registration (length- and inlier-weighted). */
    walls: number; offsetRmsBeforeM: number; offsetRmsAfterM: number;
    /** The scan cells within 0.2 m of the walls' planes, fitted from the footprint as given and as registered. */
    inliersBefore?: number; inliersAfter?: number;
    transform: (q: Vec2) => Vec2;
}

export const REGISTRATION_PARAMS = {
    /** A rotation is taken only up to this, and only when the walls' lever arms constrain it. */
    maxRotationDeg: 3,
    /** Huber scale for the walls' offsets, metres (a wall the scan puts on a different facade counts less). */
    huberM: 0.3,
    /** The registration must explain the offsets this much better (RMS) to be applied, and at least minWalls walls. */
    minGain: 0.8,
    minWalls: 3,
    /** ... and the walls refitted from the registered footprint must agree with this many times the scan cells. */
    minInlierGain: 1.1
};

/**
 * The footprint as a whole moved onto the scan: the 2D shift (and a small rotation) that best explains the measured walls'
 * offsets, o_i ~ n_i . (T + theta perp(m_i - c)), by Huber-weighted least squares. Applied only when both shift directions are
 * constrained (the smaller eigenvalue at least a fifth of the larger), within the wall-fit reach, and it explains the offsets
 * clearly better than leaving the footprint where it is.
 */
export function registerFootprint(walls: Array<{ a: Vec2; b: Vec2; outward: Vec2; offsetM: number; weight: number }>, P = WALL_FIT_PARAMS, Rg = REGISTRATION_PARAMS): FootprintRegistration {
    const id = (q: Vec2): Vec2 => q;
    const ws = walls.filter(w => w.weight > 0 && Number.isFinite(w.offsetM));
    const tot = ws.reduce((t, w) => t + w.weight, 0);
    const c: Vec2 = tot ? [ws.reduce((t, w) => t + w.weight * (w.a[0] + w.b[0]) / 2, 0) / tot, ws.reduce((t, w) => t + w.weight * (w.a[1] + w.b[1]) / 2, 0) / tot] : [0, 0];
    const rms0 = tot ? Math.sqrt(ws.reduce((t, w) => t + w.weight * w.offsetM * w.offsetM, 0) / tot) : NaN;
    const none = (reason: string): FootprintRegistration => ({ applied: false, reason, shift: [0, 0], rotationDeg: 0, centre: c, walls: ws.length, offsetRmsBeforeM: r3(rms0), offsetRmsAfterM: r3(rms0), transform: id });
    if (ws.length < Rg.minWalls) return none(`${ws.length} measured walls (at least ${Rg.minWalls} needed)`);
    // rows: [n.x, n.z, n . perp(m - c)] with perp(v) = (-v.z, v.x)
    const rows = ws.map(w => {
        const m: Vec2 = [(w.a[0] + w.b[0]) / 2 - c[0], (w.a[1] + w.b[1]) / 2 - c[1]];
        return { x: [w.outward[0], w.outward[1], w.outward[0] * -m[1] + w.outward[1] * m[0]], o: w.offsetM, w: w.weight };
    });
    const solve = (cols: number, rw: number[]): number[] | undefined => {
        const A = Array.from({ length: cols }, () => new Array(cols).fill(0)), bb = new Array(cols).fill(0);
        rows.forEach((r, i) => { for (let j = 0; j < cols; j++) { bb[j] += rw[i] * r.x[j] * r.o; for (let k = 0; k < cols; k++) A[j][k] += rw[i] * r.x[j] * r.x[k]; } });
        // the shift block's conditioning
        const tr = A[0][0] + A[1][1], det2 = A[0][0] * A[1][1] - A[0][1] * A[1][0], disc = Math.sqrt(Math.max(0, (tr * tr) / 4 - det2));
        if (!(tr > 0) || tr / 2 - disc < 0.2 * (tr / 2 + disc)) return undefined;
        // Gaussian elimination
        const M = A.map((row, j) => [...row, bb[j]]);
        for (let j = 0; j < cols; j++) {
            let piv = j;
            for (let k = j + 1; k < cols; k++) if (Math.abs(M[k][j]) > Math.abs(M[piv][j])) piv = k;
            if (Math.abs(M[piv][j]) < 1e-9) return undefined;
            [M[j], M[piv]] = [M[piv], M[j]];
            for (let k = 0; k < cols; k++) if (k !== j) { const f = M[k][j] / M[j][j]; for (let l = j; l <= cols; l++) M[k][l] -= f * M[j][l]; }
        }
        return M.map((row, j) => row[cols] / row[j]);
    };
    const fit = (cols: number): number[] | undefined => {
        let rw = rows.map(r => r.w), x: number[] | undefined;
        for (let it = 0; it < 4; it++) {
            x = solve(cols, rw);
            if (!x) return undefined;
            rw = rows.map(r => { const e = Math.abs(r.o - r.x.slice(0, cols).reduce((t, v, j) => t + v * x![j], 0)); return r.w * (e <= Rg.huberM ? 1 : Rg.huberM / e); });
        }
        return x;
    };
    let x = fit(3);
    if (!x || Math.abs((Math.atan(x[2]) * 180) / Math.PI) > Rg.maxRotationDeg) x = fit(2);
    if (!x) return none('the measured walls do not constrain both directions of a shift');
    const th = x.length > 2 ? x[2] : 0;
    const rms1 = Math.sqrt(rows.reduce((t, r) => { const e = r.o - (r.x[0] * x![0] + r.x[1] * x![1] + r.x[2] * th); return t + r.w * e * e; }, 0) / tot);
    const shiftM = Math.hypot(x[0], x[1]);
    const reach = Math.min(P.reachBackM, P.reachFrontM);
    if (shiftM > reach) return none(`the shift the walls ask for (${shiftM.toFixed(1)} m) is past the wall-fit reach (${reach} m)`);
    if (!(rms1 <= Rg.minGain * rms0)) return { ...none(`the registration explains the walls' offsets no better (RMS ${r3(rms0)} -> ${r3(rms1)} m)`), offsetRmsAfterM: r3(rms1) };
    const cs = Math.cos(th), sn = Math.sin(th);
    // o = n . (T + th perp(m - c)): the footprint point q goes to c + R(th) (q - c) + T, R(th) turning x toward z for th > 0
    const transform = (q: Vec2): Vec2 => { const dx = q[0] - c[0], dz = q[1] - c[1]; return [c[0] + cs * dx - sn * dz + x![0], c[1] + sn * dx + cs * dz + x![1]]; };
    return { applied: true, shift: [r3(x[0]), r3(x[1])], rotationDeg: r3((th * 180) / Math.PI), centre: [r3(c[0]), r3(c[1])], walls: ws.length, offsetRmsBeforeM: r3(rms0), offsetRmsAfterM: r3(rms1), transform };
}

// ------------------------------------------------------------------------------------------------
// a building's massing, plane first
// ------------------------------------------------------------------------------------------------

/** One wall of a plane-first massing: its native face key, the fit, and where it stands after snapping. */
export interface PlaneFirstWall {
    /** The native wall face key (scratchbox_staged_massing.hpp addWalls: w:<part>:<loop>:<edge>; split pieces add :<k>). */
    key: string;
    part: string; loop: number; edge: number;
    fit: Omit<WallPlaneFit, 'residual'>;
    /** The wall's edge after snapping (plan), its outward normal, and its height range. */
    a: Vec2; b: Vec2; outward: Vec2; baseY: number; topY: number;
    /** The relief items handed to the native tool for this wall (opening / facesweep ids), and each one's index in fit.relief. */
    reliefIds: string[];
    reliefIndex: number[];
}

export interface PlaneFirstMassing<P> {
    parts: P[];
    walls: PlaneFirstWall[];
    openings: Array<{ id: string; face: string; s0: number; s1: number; t0: number; t1: number; depth: number; scanned: boolean; confidence: number; provenance: string }>;
    faceSweeps: Array<{ id: string; confidence: number; provenance: string; face: string; axis: 0 | 1; profile: Array<[number, number]>; placements: Array<[number, number, number]> }>;
    summary: PlaneFirstSummary;
    /** The footprint's registration to the scan, applied before the walls were fitted (registerFootprint). */
    registration: Omit<FootprintRegistration, 'transform'>;
}

export interface PlaneFirstSummary {
    walls: number; measured: number; estimated: number; unseen: number;
    /** Wall length by status, metres. */
    lengthM: Record<WallFitStatus, number>;
    /** Returns joining the runs of a stepped edge. */
    steps: number;
    recesses: number; projections: number;
    /** Over the measured walls, length-weighted: |offset| moved, the facade's roughness about its plane (RMS within 1 m), coverage. */
    offsetMedianM: number; rmsMedianM: number; coverageMean: number;
}

/** The provenance tokens the relief items carry through the native tool. */
export const PLANE_RELIEF_TOKEN = 'plane-relief-measured';

const tokKey = (s: string) => s.replace(/\s+/g, '_') || '_';

/**
 * Every wall of every part fitted to the scan (fitWallPlane), the part's loops moved onto the fitted planes (corners
 * re-intersected), and each wall's relief as native items: a recess as an opening of its measured depth, a projection as a
 * face sweep (a box of its depth). Parts are any objects with id, loops, baseY and topY (pipeline E's MassingPart).
 */
export function planeFirstMassing<P extends { id: string; loops: Vec2[][]; baseY: number; topY: number }>(parts: P[], ix: WallSampleIndex, inside: (part: P, x: number, z: number) => boolean, opts: { idPrefix?: string; P?: typeof WALL_FIT_PARAMS; R?: typeof RELIEF_PARAMS; S?: typeof STEP_PARAMS; /** Register the footprint to the scan before fitting the walls (default true). */ register?: boolean } = {}): PlaneFirstMassing<P> {
    const walls: PlaneFirstWall[] = [];
    const openings: PlaneFirstMassing<P>['openings'] = [];
    const faceSweeps: PlaneFirstMassing<P>['faceSweeps'] = [];
    const out: P[] = [];
    let n = 0;
    type Piece = { fit: WallPlaneFit; a: Vec2; b: Vec2; outward: Vec2; line: FittedLine };
    // each edge of each part: one plane, or, where the scan steps along it, one plane per run
    const fitAll = (ps: P[]): Piece[][][][] => ps.map(part => part.loops.map(loop => {
        const nrm = outwardNormals(loop, (x, z) => inside(part, x, z));
        return loop.map((a, e): Piece[] => {
            const b = loop[(e + 1) % loop.length];
            const fit = fitWallPlane({ a, b, outward: nrm[e], baseY: part.baseY, topY: part.topY }, ix, opts.P, opts.R, { keepResidual: true });
            const steps = findSteps(fit, part.baseY, part.topY, opts.P, opts.S);
            const whole = (f: WallPlaneFit, pa: Vec2, pb: Vec2): Piece => ({ fit: f, a: pa, b: pb, outward: nrm[e], line: fittedLine(pa, pb, nrm[e], f) });
            if (!steps.length) return [whole(fit, a, b)];
            const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
            const at = (s: number): Vec2 => [a[0] + ((b[0] - a[0]) * s) / L, a[1] + ((b[1] - a[1]) * s) / L];
            // the cuts: each run's ends (a piece shorter than a metre joins its neighbour)
            const cuts = [0];
            for (const v of steps.flatMap(st => [st.s0, st.s1]).sort((p, q) => p - q)) if (v - cuts[cuts.length - 1] >= 1 && L - v >= 1) cuts.push(v);
            cuts.push(L);
            const pieces: Piece[] = [];
            for (let k = 0; k + 1 < cuts.length; k++) {
                if (cuts[k + 1] - cuts[k] < 0.5) continue;
                const pa = at(cuts[k]), pb = at(cuts[k + 1]);
                pieces.push(whole(fitWallPlane({ a: pa, b: pb, outward: nrm[e], baseY: part.baseY, topY: part.topY }, ix, opts.P, opts.R), pa, pb));
            }
            // neighbouring pieces at about one depth are one plane after all
            const merged: Piece[] = [];
            for (const p of pieces) {
                const q = merged[merged.length - 1];
                if (q && Math.abs(q.fit.offsetM - p.fit.offsetM) < 0.25 && q.fit.status === p.fit.status) {
                    merged[merged.length - 1] = whole(fitWallPlane({ a: q.a, b: p.b, outward: nrm[e], baseY: part.baseY, topY: part.topY }, ix, opts.P, opts.R), q.a, p.b);
                } else merged.push(p);
            }
            return merged;
        });
    }));
    // the footprint registered to the scan first (registerFootprint): the vector data and the tiles can stand a metre apart,
    // the same for every wall of a building; each wall's own plane is then measured from the registered edge
    let all = fitAll(parts);
    const registration = registerFootprint(all.flat(3).filter(pc => pc.fit.status === 'measured').map(pc => ({ a: pc.a, b: pc.b, outward: pc.outward, offsetM: pc.fit.offsetM, weight: pc.fit.lengthM * pc.fit.inlierShare })), opts.P);
    if (registration.applied && opts.register !== false) {
        // kept only when the walls fitted from the registered footprint agree with the scan clearly better (the scan cells
        // within 0.2 m of their planes), never on the offsets' least squares alone
        const agree = (pcs: Piece[][][][]) => pcs.flat(3).reduce((t, pc) => t + pc.fit.seenCells * pc.fit.inlierShare, 0);
        const xf = registration.transform;
        const moved = parts.map(part => ({ ...part, loops: part.loops.map(l => l.map(xf)) }));
        const refit = fitAll(moved);
        const before = agree(all), after = agree(refit);
        registration.inliersBefore = Math.round(before); registration.inliersAfter = Math.round(after);
        if (after >= REGISTRATION_PARAMS.minInlierGain * before) { parts = moved; all = refit; }
        else { registration.applied = false; registration.reason = `the walls fitted from the registered footprint agree with the scan no better (${Math.round(before)} -> ${Math.round(after)} cells within 0.2 m of their planes)`; }
    }
    // the building's own shift: where the walls the scan measures agree the whole footprint stands off the scan (the vector
    // data and the tiles registered a little apart), the least-squares translation of their planes, when it constrains both
    // directions; a wall the scan does not see moves with it rather than staying where the vector data put it
    const minL0 = (opts.P ?? WALL_FIT_PARAMS).minLengthM;
    let A = 0, B = 0, C = 0, D = 0, E = 0;
    for (const loops of all) for (const edges of loops) for (const pcs of edges) for (const pc of pcs) {
        if (pc.fit.status !== 'measured') continue;
        const w = pc.fit.lengthM * pc.fit.inlierShare, n = pc.outward, o = pc.fit.offsetM;
        A += w * n[0] * n[0]; B += w * n[0] * n[1]; C += w * n[1] * n[1]; D += w * n[0] * o; E += w * n[1] * o;
    }
    const det = A * C - B * B, tr = A + C, disc = Math.sqrt(Math.max(0, (tr * tr) / 4 - det));
    const shiftOk = tr > 0 && tr / 2 - disc >= 0.2 * (tr / 2 + disc);
    const T: Vec2 = shiftOk ? [(C * D - B * E) / det, (A * E - B * D) / det] : [0, 0];
    const shiftM = Math.hypot(T[0], T[1]);
    if (shiftOk && shiftM > 0.05 && shiftM <= Math.min((opts.P ?? WALL_FIT_PARAMS).reachBackM, (opts.P ?? WALL_FIT_PARAMS).reachFrontM)) {
        for (const loops of all) for (const edges of loops) for (let e = 0; e < edges.length; e++) {
            const pcs = edges[e];
            if (pcs.length !== 1 || pcs[0].fit.status !== 'unseen' || pcs[0].fit.lengthM < minL0) continue;
            const pc = pcs[0];
            edges[e] = [{ ...pc, fit: { ...pc.fit, reason: `${pc.fit.reason ?? ''}; moved ${r3(shiftM)} m with the building's measured walls` }, line: { p: [pc.line.p[0] + T[0], pc.line.p[1] + T[1]], d: pc.line.d } }];
        }
    }
    for (const [pi, part] of parts.entries()) {
        const loops: Vec2[][] = [];
        const pending: Array<{ li: number; e: number; piece?: Piece; step?: { from: Piece; to: Piece } }> = [];
        for (const [li, loop] of part.loops.entries()) {
            const edges = all[pi][li];
            const N = loop.length;
            // a jog too short to measure moves with its neighbours (the mean of how far they moved at its two corners), so a
            // small notch in the vector plan stays that notch instead of becoming a spike where the neighbours moved
            const minL = (opts.P ?? WALL_FIT_PARAMS).minLengthM;
            const moved = edges.map(pcs => pcs.length === 1 && pcs[0].fit.status === 'unseen' && pcs[0].fit.lengthM < minL);
            for (let e = 0; e < N; e++) {
                if (!moved[e]) continue;
                const prev = edges[(e + N - 1) % N], next = edges[(e + 1) % N];
                const shift = (l: FittedLine, c: Vec2): Vec2 => { const q = onFittedLine(l, c); return [q[0] - c[0], q[1] - c[1]]; };
                const ds: Vec2[] = [];
                if (!moved[(e + N - 1) % N]) ds.push(shift(prev[prev.length - 1].line, loop[e]));
                if (!moved[(e + 1) % N]) ds.push(shift(next[0].line, loop[(e + 1) % N]));
                if (!ds.length) continue;
                const d: Vec2 = [ds.reduce((t, v) => t + v[0], 0) / ds.length, ds.reduce((t, v) => t + v[1], 0) / ds.length];
                const pc = edges[e][0];
                edges[e] = [{ ...pc, fit: { ...pc.fit, reason: `${pc.fit.reason ?? ''}; moved ${r3(Math.hypot(d[0], d[1]))} m with its neighbouring walls` }, line: { p: [pc.line.p[0] + d[0], pc.line.p[1] + d[1]], d: pc.line.d } }];
            }
            const verts: Vec2[] = [];
            for (let e = 0; e < N; e++) {
                const prev = edges[(e + N - 1) % N], cur = edges[e];
                pending.push({ li, e: verts.length, piece: cur[0] });
                verts.push(lineCorner(prev[prev.length - 1].line, cur[0].line, loop[e]));
                for (let k = 1; k < cur.length; k++) {
                    // a step: the return wall from one run's plane to the next, at the run's end along the edge
                    pending.push({ li, e: verts.length, step: { from: cur[k - 1], to: cur[k] } });
                    verts.push(onFittedLine(cur[k - 1].line, cur[k].a));
                    pending.push({ li, e: verts.length, piece: cur[k] });
                    verts.push(onFittedLine(cur[k].line, cur[k].a));
                }
            }
            loops.push(verts);
        }
        out.push({ ...part, loops });
        for (const w of pending) {
            const loop = loops[w.li];
            const a2 = loop[w.e], b2 = loop[(w.e + 1) % loop.length];
            const L2 = Math.hypot(b2[0] - a2[0], b2[1] - a2[1]);
            const key = `w:${tokKey(part.id)}:${w.li}:${w.e}`;
            if (w.step) {
                const depth = r3(w.step.to.fit.offsetM - w.step.from.fit.offsetM);
                const out2: Vec2 = L2 > 1e-6 ? (() => { const d: Vec2 = [(b2[0] - a2[0]) / L2, (b2[1] - a2[1]) / L2]; const c: Vec2 = [d[1], -d[0]]; const m: Vec2 = [(a2[0] + b2[0]) / 2 + c[0] * 0.05, (a2[1] + b2[1]) / 2 + c[1] * 0.05]; return inside(part, m[0], m[1]) ? [-c[0], -c[1]] as Vec2 : c; })() : w.step.to.outward;
                walls.push({
                    key, part: part.id, loop: w.li, edge: w.e, a: a2, b: b2, outward: out2, baseY: part.baseY, topY: part.topY, reliefIds: [], reliefIndex: [],
                    fit: { status: 'step', reason: `the return joining two runs of one footprint edge the scan measures ${depth} m apart`, lengthM: r3(L2), offsetM: 0, yawDeg: 0, plumbDeg: 0, topYMeasured: NaN, coverage: 0, inlierShare: 0, rmsM: NaN, rmsWithReliefM: NaN, p90M: NaN, seenCells: 0, relief: [] }
                });
                continue;
            }
            const piece = w.piece!;
            const reliefIds: string[] = [], reliefIndex: number[] = [];
            if (L2 > 0.5) {
                const d2: Vec2 = [(b2[0] - a2[0]) / L2, (b2[1] - a2[1]) / L2];
                // the native face frame: axisS = up x n = (n.z, 0, -n.x); s from the edge's start
                const sign = Math.sign(d2[0] * piece.outward[1] - d2[1] * piece.outward[0]) || 1;
                const d0: Vec2 = [(piece.b[0] - piece.a[0]), (piece.b[1] - piece.a[1])];
                const L0 = Math.hypot(d0[0], d0[1]) || 1;
                const along = (s: number): number => {
                    // the point s along the original edge, projected onto the snapped edge
                    const x = piece.a[0] + (d0[0] / L0) * s, z = piece.a[1] + (d0[1] / L0) * s;
                    return (x - a2[0]) * d2[0] + (z - a2[1]) * d2[1];
                };
                for (const [qi, q] of piece.fit.relief.entries()) {
                    let s0 = along(q.s0), s1 = along(q.s1);
                    if (s0 > s1) [s0, s1] = [s1, s0];
                    s0 = Math.max(0.06, s0); s1 = Math.min(L2 - 0.06, s1);
                    const t0 = Math.max(part.baseY + 0.03, q.t0), t1 = Math.min(part.topY - 0.06, q.t1);
                    if (s1 - s0 < 0.5 || t1 - t0 < 0.5) continue;
                    const f0 = sign > 0 ? s0 : -s1, f1 = sign > 0 ? s1 : -s0;
                    const id = `${opts.idPrefix ?? 'pf'}${n++}`;
                    reliefIds.push(id); reliefIndex.push(qi);
                    const conf = Math.max(0.3, Math.min(0.95, q.fill * piece.fit.coverage + 0.2));
                    if (q.depthM < 0) openings.push({ id, face: key, s0: f0, s1: f1, t0, t1, depth: -q.depthM, scanned: false, confidence: r3(conf), provenance: PLANE_RELIEF_TOKEN });
                    else faceSweeps.push({ id, confidence: r3(conf), provenance: PLANE_RELIEF_TOKEN, face: key, axis: 0, profile: [[q.depthM, t0], [q.depthM, t1]], placements: [[f0, f1, 0]] });
                }
            }
            const { residual: _r, ...fit } = piece.fit;
            walls.push({ key, part: part.id, loop: w.li, edge: w.e, fit, a: a2, b: b2, outward: piece.outward, baseY: part.baseY, topY: part.topY, reliefIds, reliefIndex });
        }
    }
    const { transform: _xf, ...reg } = registration;
    return { parts: out, walls, openings, faceSweeps, registration: { ...reg, applied: reg.applied && opts.register !== false }, summary: planeFirstSummary(walls, openings.length, faceSweeps.length) };
}

export function planeFirstSummary(walls: PlaneFirstWall[], recesses: number, projections: number): PlaneFirstSummary {
    const lengthM: Record<WallFitStatus, number> = { measured: 0, estimated: 0, unseen: 0, step: 0 };
    for (const w of walls) lengthM[w.fit.status] += w.fit.lengthM;
    const m = walls.filter(w => w.fit.status === 'measured');
    const wmed = (v: Array<[number, number]>) => { const s = v.filter(([x]) => Number.isFinite(x)).sort((p, q) => p[0] - q[0]); const tot = s.reduce((a, [, w]) => a + w, 0); let acc = 0; for (const [x, w] of s) { acc += w; if (acc >= tot / 2) return r3(x); } return NaN; };
    const len = m.reduce((a, w) => a + w.fit.lengthM, 0);
    return {
        walls: walls.length, measured: m.length, estimated: walls.filter(w => w.fit.status === 'estimated').length, unseen: walls.filter(w => w.fit.status === 'unseen').length,
        lengthM: { measured: r3(lengthM.measured), estimated: r3(lengthM.estimated), unseen: r3(lengthM.unseen), step: r3(lengthM.step) }, steps: walls.filter(w => w.fit.status === 'step').length, recesses, projections,
        offsetMedianM: wmed(m.map(w => [Math.abs(w.fit.offsetM), w.fit.lengthM])), rmsMedianM: wmed(m.map(w => [w.fit.rmsM, w.fit.lengthM])),
        coverageMean: len ? r3(m.reduce((a, w) => a + w.fit.coverage * w.fit.lengthM, 0) / len) : NaN
    };
}

// ------------------------------------------------------------------------------------------------
// the scan's lumps on a fitted wall are noise: the residual there goes
// ------------------------------------------------------------------------------------------------

/** How far in front of / behind a fitted wall the scan's residual counts as the wall's own noise, metres (relief widens it). */
export const WALL_BAND_M = 2.5;
/** A residual cluster goes when at least this share of its area lies in fitted walls' bands. */
export const WALL_BAND_SHARE = 0.7;

export interface ResidualNodeLike { kind: string; positions: Float32Array; indices: Uint32Array }

/**
 * Residual clusters (triangles joined by shared vertex positions, across nodes) that lie mostly within a seen wall's band
 * are the scan's lumps on a wall the plane now stands for: they are taken out, the wall's plane and its relief are the
 * geometry there. A cluster mostly off the walls (a canopy reaching out, plant on the roof) stays whole. Returns the nodes
 * with those triangles removed and the count and area removed.
 */
export function dropWallBandResidual<N extends ResidualNodeLike>(nodes: N[], walls: PlaneFirstWall[], opts: { bandM?: number; share?: number; subset?: (n: N, keep: number[]) => N } = {}): { nodes: N[]; removedTriangles: number; removedAreaM2: number; keptTriangles: number } {
    const band = opts.bandM ?? WALL_BAND_M, share = opts.share ?? WALL_BAND_SHARE;
    const seen = walls.filter(w => w.fit.status !== 'unseen');
    // walls hashed on a 4 m plan grid by their band's box
    const G = 4, grid = new Map<number, number[]>();
    const bandOf = seen.map(w => {
        const back = Math.max(band, ...w.fit.relief.filter(q => q.depthM < 0).map(q => -q.depthM + 0.5));
        const front = Math.max(band, ...w.fit.relief.filter(q => q.depthM > 0).map(q => q.depthM + 0.5));
        return { back, front };
    });
    seen.forEach((w, i) => {
        const r = Math.max(bandOf[i].back, bandOf[i].front);
        const x0 = Math.min(w.a[0], w.b[0]) - r, x1 = Math.max(w.a[0], w.b[0]) + r, z0 = Math.min(w.a[1], w.b[1]) - r, z1 = Math.max(w.a[1], w.b[1]) + r;
        for (let k = Math.floor(z0 / G); k <= Math.floor(z1 / G); k++) for (let j = Math.floor(x0 / G); j <= Math.floor(x1 / G); j++) {
            const key = hashCell(j, k);
            const l = grid.get(key);
            if (l) l.push(i); else grid.set(key, [i]);
        }
    });
    const inBand = (x: number, y: number, z: number): boolean => {
        for (const i of grid.get(hashCell(Math.floor(x / G), Math.floor(z / G))) ?? []) {
            const w = seen[i];
            if (y < w.baseY - 0.5 || y > w.topY + 0.5) continue;
            const dx = w.b[0] - w.a[0], dz = w.b[1] - w.a[1], L = Math.hypot(dx, dz) || 1;
            const s = ((x - w.a[0]) * dx + (z - w.a[1]) * dz) / L;
            if (s < -0.5 || s > L + 0.5) continue;
            const h = (x - w.a[0]) * w.outward[0] + (z - w.a[1]) * w.outward[1];
            if (h >= -bandOf[i].back && h <= bandOf[i].front) return true;
        }
        return false;
    };
    const res = dropResidualClusters(nodes, cl => {
        let ab = 0;
        for (const t of cl.tris) if (inBand(t.c[0], t.c[1], t.c[2])) ab += t.area;
        return cl.areaM2 > 0 && ab >= share * cl.areaM2 ? 'wall' : undefined;
    }, opts.subset);
    return { nodes: res.nodes, removedTriangles: res.removedTriangles, removedAreaM2: res.removedAreaM2, keptTriangles: res.keptTriangles };
}

/** One residual cluster: its triangles' centroids and areas, and all its vertex positions (x, y, z flattened). */
export interface ResidualCluster { areaM2: number; tris: Array<{ c: [number, number, number]; area: number }>; points: number[] }

/**
 * The residual triangles (nodes of kind 'residual'), welded across nodes at 1 mm into clusters; each cluster for which
 * `decide` names a reason is removed. Returns the nodes without those triangles and what was removed, by reason.
 */
export function dropResidualClusters<N extends ResidualNodeLike>(nodes: N[], decide: (cl: ResidualCluster) => string | undefined, subsetFn?: (n: N, keep: number[]) => N): { nodes: N[]; removedTriangles: number; removedAreaM2: number; keptTriangles: number; byReason: Record<string, { clusters: number; triangles: number; areaM2: number }> } {
    type Tri = { node: number; t: number; area: number; c: [number, number, number] };
    const tris: Tri[] = [];
    const byVert = new Map<string, number[]>();
    const vkey = (P: Float32Array, o: number) => `${Math.round(P[o] * 1000)},${Math.round(P[o + 1] * 1000)},${Math.round(P[o + 2] * 1000)}`;
    nodes.forEach((nd, ni) => {
        if (nd.kind !== 'residual') return;
        const P = nd.positions, I = nd.indices;
        for (let t = 0; t < I.length / 3; t++) {
            const v = [I[t * 3] * 3, I[t * 3 + 1] * 3, I[t * 3 + 2] * 3];
            const ux = P[v[1]] - P[v[0]], uy = P[v[1] + 1] - P[v[0] + 1], uz = P[v[1] + 2] - P[v[0] + 2];
            const wx = P[v[2]] - P[v[0]], wy = P[v[2] + 1] - P[v[0] + 1], wz = P[v[2] + 2] - P[v[0] + 2];
            const area = 0.5 * Math.hypot(uy * wz - uz * wy, uz * wx - ux * wz, ux * wy - uy * wx);
            const id = tris.length;
            tris.push({ node: ni, t, area, c: [(P[v[0]] + P[v[1]] + P[v[2]]) / 3, (P[v[0] + 1] + P[v[1] + 1] + P[v[2] + 1]) / 3, (P[v[0] + 2] + P[v[1] + 2] + P[v[2] + 2]) / 3] });
            for (const o of v) { const k = vkey(P, o); const l = byVert.get(k); if (l) l.push(id); else byVert.set(k, [id]); }
        }
    });
    const comp = new Int32Array(tris.length).fill(-1);
    const drop = new Uint8Array(tris.length);
    const byReason: Record<string, { clusters: number; triangles: number; areaM2: number }> = {};
    for (let s0 = 0; s0 < tris.length; s0++) {
        if (comp[s0] >= 0) continue;
        const stack = [s0], members: number[] = [];
        comp[s0] = s0;
        while (stack.length) {
            const i = stack.pop()!;
            members.push(i);
            const nd = nodes[tris[i].node];
            for (let k = 0; k < 3; k++) for (const j of byVert.get(vkey(nd.positions, nd.indices[tris[i].t * 3 + k] * 3)) ?? []) if (comp[j] < 0) { comp[j] = s0; stack.push(j); }
        }
        const points: number[] = [];
        let areaM2 = 0;
        for (const i of members) {
            areaM2 += tris[i].area;
            const nd = nodes[tris[i].node];
            for (let k = 0; k < 3; k++) { const o = nd.indices[tris[i].t * 3 + k] * 3; points.push(nd.positions[o], nd.positions[o + 1], nd.positions[o + 2]); }
        }
        const why = decide({ areaM2, tris: members.map(i => ({ c: tris[i].c, area: tris[i].area })), points });
        if (!why) continue;
        for (const i of members) drop[i] = 1;
        const r = (byReason[why] ??= { clusters: 0, triangles: 0, areaM2: 0 });
        r.clusters++; r.triangles += members.length; r.areaM2 = r3(r.areaM2 + areaM2);
    }
    let removedTriangles = 0, removedAreaM2 = 0, keptTriangles = 0;
    const keepBy = new Map<number, number[]>();
    tris.forEach((tr, i) => {
        if (drop[i]) { removedTriangles++; removedAreaM2 += tr.area; return; }
        keptTriangles++;
        const l = keepBy.get(tr.node);
        if (l) l.push(tr.t); else keepBy.set(tr.node, [tr.t]);
    });
    const subset = subsetFn ?? ((nd: N, keep: number[]) => subsetNode(nd, keep));
    const outNodes = nodes.flatMap((nd, ni) => {
        if (nd.kind !== 'residual') return [nd];
        const keep = keepBy.get(ni) ?? [];
        if (keep.length === nd.indices.length / 3) return [nd];
        return keep.length ? [subset(nd, keep)] : [];
    });
    return { nodes: outNodes, removedTriangles, removedAreaM2: r3(removedAreaM2), keptTriangles, byReason };
}

/** A node keeping only triangles `keep` (its per-vertex arrays compacted: any Float32Array / Int32Array of n * width). */
export function subsetNode<N extends ResidualNodeLike>(nd: N, keep: number[]): N {
    const remap = new Map<number, number>(), idx: number[] = [];
    for (const t of keep) for (let k = 0; k < 3; k++) { const v = nd.indices[t * 3 + k]; if (!remap.has(v)) remap.set(v, remap.size); idx.push(remap.get(v)!); }
    const order = [...remap.keys()];
    const nv = nd.positions.length / 3;
    const out = { ...nd } as unknown as Record<string, unknown>;
    for (const [k, val] of Object.entries(out)) {
        if (k === 'indices' || !(val instanceof Float32Array || val instanceof Int32Array)) continue;
        if (val.length % nv !== 0) continue;
        const w = val.length / nv;
        const r = new (val.constructor as { new (n: number): Float32Array | Int32Array })(order.length * w);
        order.forEach((v, i) => r.set(val.subarray(v * w, v * w + w), i * w));
        out[k] = r;
    }
    out.indices = Uint32Array.from(idx);
    return out as N;
}
