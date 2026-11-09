/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Street View registration from multi-view depth: the panoramas of one drive are given a joint depth and pose estimate
 * (Depth Anything 3, `Da3RigDepthService`), that estimate is put on the panoramas' stated positions, and the scan is
 * slid onto it. The move that lays the scan on the drive's own depth is the drive's registration error.
 *
 * The logic follows the streetview-to-3d / panoramic-da3 projects (MIT), rewritten here (user decision, 2026-11-08):
 *   1. rigConsensus: per panorama, the median of its views' estimated camera centres and the mean of their rotations
 *      turned back to the panorama's frame; a view further than `distThresh` (estimate units) or `angleThreshDeg` from
 *      that consensus is dropped and the consensus recomputed from the rest.
 *   2. rigPoints: the kept views' depth back-projected from the consensus pose, less each view's least confident
 *      `confPercentile` and anything under `confFloor`.
 *   3. placeRig: one similarity putting each panorama's estimated camera on its stated position, its scale from the
 *      cameras' horizontal spread (Umeyama in 2-D, in the estimate's own camera plane: the estimate has no known up),
 *      its rotation maximising trace(R^T M) where M adds to the camera pairs each panorama's world <- estimate turn,
 *      weighted so a `sigmaDeg` turn costs a `sigmaM` shift.
 *   4. shiftSearch: the scan's surface near the panoramas slid onto the placed points, coarse to fine (a 7 x 7 x 7
 *      grid at each of `stepsM`), keeping the move that puts the most scan samples within `nearM` of a point.
 *   5. sightAgreement: the median range difference, per small direction bin round each panorama, between the nearest
 *      scan surface and the nearest estimated point, where they are within `sameM`: how far apart the two surfaces sit
 *      along the panoramas' lines of sight.
 *
 * The scan stays the authority on shape and scale; this only moves the cameras. Nothing here names a place or what
 * stands in a view; every threshold is an option.
 *
 * Frames: world is the scan's (x east, y up, z south). Cameras are OpenCV (x right, y down, z forward); a rotation
 * here is world -> camera with rows (right, down, forward).
 */

export type V3 = [number, number, number];
export type M3 = [V3, V3, V3];

const DEG = Math.PI / 180;

// ============================================================================================
// Inputs and results
// ============================================================================================

/** One view of a panorama as the depth model returned it. */
export interface RigDepthView {
    panoId: string;
    /** Yaw of this view from the panorama's reference direction, degrees, turning right. */
    yawDeg: number;
    /** Estimate-frame world -> camera, row-major 3 x 4 [R | t]. */
    w2c: number[];
    /** Intrinsics at the depth map's resolution. */
    fx: number; fy: number; cx: number; cy: number;
    width: number; height: number;
    /** Depth along the camera z axis, estimate units, row-major width x height. */
    depth: Float32Array;
    /** The model's confidence per pixel (same layout). */
    conf: Float32Array;
}

/** A panorama's stated pose (from its metadata). */
export interface StatedPano {
    panoId: string;
    /** Stated camera position in the scan frame. */
    eye: V3;
    /** Absolute compass heading of the panorama's reference direction (its yaw-0 view), degrees. */
    referenceHeadingDeg: number;
    /** Pitch of the reference direction, degrees (0 for level views). */
    referencePitchDeg?: number;
}

export interface RigConsensus {
    panoId: string;
    /** Estimate-frame camera centre. */
    centre: V3;
    /** Estimate-frame world -> panorama camera (the yaw-0 view). */
    rotation: M3;
    kept: number;
    total: number;
    /** Mean distance of the kept views' centres from the consensus (estimate units). */
    meanDeviation: number;
    /** Indices (into the views array) of the kept views. */
    keptViews: number[];
}

export interface RigPlacement {
    /** Scan metres per estimate unit. */
    scale: number;
    /** World <- estimate rotation. */
    rotation: M3;
    translation: V3;
    /** How far each placed camera lands from its stated position, metres. */
    cameraOffsetM: Record<string, number>;
    /** The largest angle between a placed panorama's turn and its stated heading, degrees. */
    worstTurnDeg: number;
}

export interface ShiftSearchResult {
    /** The move (metres, scan frame) laying the scan on the placed points. The cameras' correction is its negative. */
    move: V3;
    hitsBefore: number;
    hitsAfter: number;
    samples: number;
}

export interface CorrectedPano {
    panoId: string;
    stated: V3;
    eye: V3;
    /** World -> panorama camera (yaw-0 view) after placement. */
    rotation: M3;
    movedM: number;
    headingDeg: number;
    pitchDeg: number;
    rollDeg: number;
    keptViews: number;
    totalViews: number;
}

export interface RigRegistrationOptions {
    distThresh?: number;
    angleThreshDeg?: number;
    confPercentile?: number;
    confFloor?: number;
    /** Back-project every `pixelStride`-th pixel in each direction. */
    pixelStride?: number;
    sigmaM?: number;
    sigmaDeg?: number;
    /** Scan samples within this of a stated camera take part in the shift search. */
    fitReachM?: number;
    fitSamples?: number;
    nearM?: number;
    stepsM?: number[];
    stepsEachWay?: number;
    sightReachM?: number;
    sightBinDeg?: number;
    sameM?: number;
    /** A panorama takes part only when at least this share of its views agree with its consensus (step 1). */
    minKeepRate?: number;
}

export const RIG_REGISTRATION_DEFAULTS: Required<RigRegistrationOptions> = {
    distThresh: 0.2,
    angleThreshDeg: 1,
    confPercentile: 25,
    confFloor: 1.05,
    pixelStride: 1,
    sigmaM: 0.5,
    sigmaDeg: 2,
    fitReachM: 15,
    fitSamples: 40_000,
    nearM: 0.3,
    stepsM: [1.0, 0.3, 0.1],
    stepsEachWay: 3,
    sightReachM: 25,
    sightBinDeg: 2,
    sameM: 1.5,
    minKeepRate: 0.6
};

/** The registration declined to move the cameras, with the reason; the stated poses stand. */
export class RigRegistrationRefused extends Error {
    constructor(public readonly code: 'views_disagree' | (string & {}), message: string, public readonly consensus: RigConsensus[]) {
        super(message);
        this.name = 'RigRegistrationRefused';
    }
}

export interface RigRegistrationResult {
    consensus: RigConsensus[];
    placement: RigPlacement;
    /** Their count search (the coarse stage). */
    shift: ShiftSearchResult;
    /** Ours: the move finished by nearest-point iterations from the count search's (the move the corrected poses use). */
    refined: { move: V3; inliers: number; meanResidualM: number };
    /**
     * Median metres between the scan's surface and the estimate's along the panoramas' sight: before any move, after
     * the count search's move, and after the refined move.
     */
    sightApartM: { before: number; afterCountSearch: number; after: number; binsBefore: number; binsAfter: number };
    pointCount: number;
    corrected: CorrectedPano[];
}

// ============================================================================================
// Small linear algebra
// ============================================================================================

const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scale3 = (a: V3, s: number): V3 => [a[0] * s, a[1] * s, a[2] * s];
const len = (a: V3) => Math.hypot(a[0], a[1], a[2]);
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

export function matMul(a: M3, b: M3): M3 {
    const r = [[0, 0, 0], [0, 0, 0], [0, 0, 0]] as M3;
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) r[i][j] = a[i][0] * b[0][j] + a[i][1] * b[1][j] + a[i][2] * b[2][j];
    return r;
}
export const transpose = (a: M3): M3 => [[a[0][0], a[1][0], a[2][0]], [a[0][1], a[1][1], a[2][1]], [a[0][2], a[1][2], a[2][2]]];
export const matVec = (a: M3, v: V3): V3 => [dot(a[0], v), dot(a[1], v), dot(a[2], v)];

/** Angle of a rotation matrix, degrees. */
export function rotationAngleDeg(r: M3): number {
    const c = (r[0][0] + r[1][1] + r[2][2] - 1) / 2;
    return Math.acos(Math.max(-1, Math.min(1, c))) / DEG;
}

/** Eigen-decomposition of a symmetric n x n matrix (cyclic Jacobi): eigenvalues descending, column eigenvectors. */
export function symmetricEigen(m: number[][]): { values: number[]; vectors: number[][] } {
    const n = m.length;
    const a = m.map(r => r.slice());
    const v: number[][] = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => (i === j ? 1 : 0)));
    for (let sweep = 0; sweep < 100; sweep++) {
        let off = 0;
        for (let p = 0; p < n; p++) for (let q = p + 1; q < n; q++) off += a[p][q] * a[p][q];
        if (off < 1e-26) break;
        for (let p = 0; p < n; p++) for (let q = p + 1; q < n; q++) {
            if (Math.abs(a[p][q]) < 1e-300) continue;
            const theta = (a[q][q] - a[p][p]) / (2 * a[p][q]);
            const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
            const c = 1 / Math.sqrt(t * t + 1), s = t * c;
            for (let k = 0; k < n; k++) {
                const akp = a[k][p], akq = a[k][q];
                a[k][p] = c * akp - s * akq; a[k][q] = s * akp + c * akq;
            }
            for (let k = 0; k < n; k++) {
                const apk = a[p][k], aqk = a[q][k];
                a[p][k] = c * apk - s * aqk; a[q][k] = s * apk + c * aqk;
            }
            for (let k = 0; k < n; k++) {
                const vkp = v[k][p], vkq = v[k][q];
                v[k][p] = c * vkp - s * vkq; v[k][q] = s * vkp + c * vkq;
            }
        }
    }
    const idx = Array.from({ length: n }, (_, i) => i).sort((i, j) => a[j][j] - a[i][i]);
    return { values: idx.map(i => a[i][i]), vectors: idx.map(i => v.map(row => row[i])) };
}

/** Quaternion (w, x, y, z) of a rotation matrix (Shepperd). */
export function matToQuat(r: M3): [number, number, number, number] {
    const tr = r[0][0] + r[1][1] + r[2][2];
    let w: number, x: number, y: number, z: number;
    if (tr > 0) {
        const s = Math.sqrt(tr + 1) * 2;
        w = 0.25 * s; x = (r[2][1] - r[1][2]) / s; y = (r[0][2] - r[2][0]) / s; z = (r[1][0] - r[0][1]) / s;
    } else if (r[0][0] > r[1][1] && r[0][0] > r[2][2]) {
        const s = Math.sqrt(1 + r[0][0] - r[1][1] - r[2][2]) * 2;
        w = (r[2][1] - r[1][2]) / s; x = 0.25 * s; y = (r[0][1] + r[1][0]) / s; z = (r[0][2] + r[2][0]) / s;
    } else if (r[1][1] > r[2][2]) {
        const s = Math.sqrt(1 + r[1][1] - r[0][0] - r[2][2]) * 2;
        w = (r[0][2] - r[2][0]) / s; x = (r[0][1] + r[1][0]) / s; y = 0.25 * s; z = (r[1][2] + r[2][1]) / s;
    } else {
        const s = Math.sqrt(1 + r[2][2] - r[0][0] - r[1][1]) * 2;
        w = (r[1][0] - r[0][1]) / s; x = (r[0][2] + r[2][0]) / s; y = (r[1][2] + r[2][1]) / s; z = 0.25 * s;
    }
    return [w, x, y, z];
}

export function quatToMat(q: [number, number, number, number]): M3 {
    const n = Math.hypot(q[0], q[1], q[2], q[3]) || 1;
    const [w, x, y, z] = q.map(c => c / n);
    return [
        [1 - 2 * (y * y + z * z), 2 * (x * y - w * z), 2 * (x * z + w * y)],
        [2 * (x * y + w * z), 1 - 2 * (x * x + z * z), 2 * (y * z - w * x)],
        [2 * (x * z - w * y), 2 * (y * z + w * x), 1 - 2 * (x * x + y * y)]
    ];
}

/** The rotation R maximising trace(R^T M) (Horn's quaternion method; a proper rotation always). */
export function bestRotation(m: M3): M3 {
    const [[sxx, sxy, sxz], [syx, syy, syz], [szx, szy, szz]] = m;
    const n = [
        [sxx + syy + szz, szy - syz, sxz - szx, syx - sxy],
        [szy - syz, sxx - syy - szz, sxy + syx, szx + sxz],
        [sxz - szx, sxy + syx, -sxx + syy - szz, syz + szy],
        [syx - sxy, szx + sxz, syz + szy, -sxx - syy + szz]
    ];
    const { vectors } = symmetricEigen(n);
    const q = vectors[0] as [number, number, number, number];
    return quatToMat(q);
}

/** World -> camera rotation (rows right, down, forward) of a view at a compass heading and pitch, in the scan frame. */
export function viewRotation(headingDeg: number, pitchDeg = 0): M3 {
    const h = headingDeg * DEG, p = pitchDeg * DEG;
    const f: V3 = [Math.sin(h) * Math.cos(p), Math.sin(p), -Math.cos(h) * Math.cos(p)];
    const r: V3 = [Math.cos(h), 0, Math.sin(h)];
    const d = cross(f, r);
    return [r, d, f];
}

/** Panorama camera -> view camera for a view turned right by yaw (OpenCV axes). */
export function yawTurn(yawDeg: number): M3 {
    const s = Math.sin(yawDeg * DEG), c = Math.cos(yawDeg * DEG);
    return [[c, 0, -s], [0, 1, 0], [s, 0, c]];
}

function w2cParts(v: RigDepthView): { r: M3; t: V3 } {
    const e = v.w2c;
    return { r: [[e[0], e[1], e[2]], [e[4], e[5], e[6]], [e[8], e[9], e[10]]], t: [e[3], e[7], e[11]] };
}

// ============================================================================================
// 1. Consensus per panorama
// ============================================================================================

function consensusOf(views: RigDepthView[], idx: number[]): { centre: V3; rotation: M3; centres: Map<number, V3> } {
    const centres = new Map<number, V3>();
    const quats: Array<[number, number, number, number]> = [];
    for (const i of idx) {
        const { r, t } = w2cParts(views[i]);
        centres.set(i, scale3(matVec(transpose(r), t), -1));
        quats.push(matToQuat(matMul(transpose(yawTurn(views[i].yawDeg)), r)));
    }
    const median = (k: number) => {
        const s = idx.map(i => centres.get(i)![k]).sort((a, b) => a - b);
        const n = s.length;
        return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
    };
    const q0 = quats[0];
    const mean: [number, number, number, number] = [0, 0, 0, 0];
    for (const q of quats) {
        const sgn = Math.sign(q[0] * q0[0] + q[1] * q0[1] + q[2] * q0[2] + q[3] * q0[3]) || 1;
        for (let k = 0; k < 4; k++) mean[k] += sgn * q[k];
    }
    return { centre: [median(0), median(1), median(2)], rotation: quatToMat(mean), centres };
}

/** Per-panorama consensus pose, dropping views that disagree with it (see the module comment, step 1). */
export function rigConsensus(views: RigDepthView[], opts: RigRegistrationOptions = {}): RigConsensus[] {
    const o = { ...RIG_REGISTRATION_DEFAULTS, ...opts };
    const byPano = new Map<string, number[]>();
    views.forEach((v, i) => {
        const list = byPano.get(v.panoId) ?? [];
        list.push(i);
        byPano.set(v.panoId, list);
    });
    const out: RigConsensus[] = [];
    for (const [panoId, idx] of byPano) {
        const first = consensusOf(views, idx);
        const kept = idx.filter(i => {
            const expected = matMul(yawTurn(views[i].yawDeg), first.rotation);
            const err = rotationAngleDeg(matMul(w2cParts(views[i]).r, transpose(expected)));
            return len(sub(first.centres.get(i)!, first.centre)) <= o.distThresh && err <= o.angleThreshDeg;
        });
        const final = kept.length ? consensusOf(views, kept) : first;
        const devs = kept.map(i => len(sub(final.centres.get(i)!, final.centre)));
        out.push({
            panoId, centre: final.centre, rotation: final.rotation, kept: kept.length, total: idx.length,
            meanDeviation: devs.length ? devs.reduce((a, b) => a + b, 0) / devs.length : Infinity, keptViews: kept
        });
    }
    return out;
}

// ============================================================================================
// 2. Points
// ============================================================================================

function percentile(values: Float32Array, p: number): number {
    const s = Float32Array.from(values).sort();
    if (!s.length) return NaN;
    const k = Math.min(s.length - 1, Math.max(0, Math.round((p / 100) * (s.length - 1))));
    return s[k];
}

/** The kept views' depth back-projected from their panorama's consensus pose (estimate frame, xyz interleaved). */
export function rigPoints(views: RigDepthView[], consensus: RigConsensus[], opts: RigRegistrationOptions = {}): Float32Array {
    const o = { ...RIG_REGISTRATION_DEFAULTS, ...opts };
    const out: number[] = [];
    for (const c of consensus) {
        for (const i of c.keptViews) {
            const v = views[i];
            const rCam = matMul(yawTurn(v.yawDeg), c.rotation);
            const rt = transpose(rCam);
            const floor = Math.max(o.confFloor, percentile(v.conf, o.confPercentile));
            for (let y = 0; y < v.height; y += o.pixelStride) {
                for (let x = 0; x < v.width; x += o.pixelStride) {
                    const k = y * v.width + x;
                    const d = v.depth[k];
                    if (!(d > 0) || !Number.isFinite(d) || !(v.conf[k] >= floor)) continue;
                    const cam: V3 = [(x + 0.5 - v.cx) / v.fx * d, (y + 0.5 - v.cy) / v.fy * d, d];
                    const w = add(matVec(rt, cam), c.centre);
                    out.push(w[0], w[1], w[2]);
                }
            }
        }
    }
    return Float32Array.from(out);
}

// ============================================================================================
// 3. Placement on the stated cameras
// ============================================================================================

/** Scale of the least-squares 2-D similarity src -> dst (Umeyama). */
export function similarityScale2d(src: Array<[number, number]>, dst: Array<[number, number]>): number {
    const n = src.length;
    const ms = [0, 0], md = [0, 0];
    for (let i = 0; i < n; i++) { ms[0] += src[i][0] / n; ms[1] += src[i][1] / n; md[0] += dst[i][0] / n; md[1] += dst[i][1] / n; }
    let a = 0, b = 0, c = 0, d = 0, varS = 0;
    for (let i = 0; i < n; i++) {
        const sx = src[i][0] - ms[0], sy = src[i][1] - ms[1], dx = dst[i][0] - md[0], dy = dst[i][1] - md[1];
        a += sx * dx / n; b += sx * dy / n; c += sy * dx / n; d += sy * dy / n;
        varS += (sx * sx + sy * sy) / n;
    }
    // singular values of [[a, b], [c, d]], with the reflection sign
    const e = (a + d) / 2, f = (a - d) / 2, g = (c + b) / 2, h = (c - b) / 2;
    const q = Math.hypot(e, h), r = Math.hypot(f, g);
    const s1 = q + r, s2 = Math.abs(q - r);
    const det = a * d - b * c;
    return (s1 + Math.sign(det || 1) * s2) / varS;
}

/** One similarity putting each panorama's estimated camera on its stated position (module comment, step 3). */
export function placeRig(consensus: RigConsensus[], stated: StatedPano[], opts: RigRegistrationOptions = {}): RigPlacement {
    const o = { ...RIG_REGISTRATION_DEFAULTS, ...opts };
    const byId = new Map(stated.map(s => [s.panoId, s]));
    const pairs = consensus.filter(c => byId.has(c.panoId));
    if (pairs.length < 2) throw new Error(`placing a drive needs at least two panoramas with a stated pose (${pairs.length} given)`);
    const cams = pairs.map(c => c.centre);
    const eyes = pairs.map(c => byId.get(c.panoId)!.eye);
    // the estimate's horizontal plane: its cameras' best-fit plane (the two largest spread directions)
    const mc = cams.reduce((s, p) => add(s, scale3(p, 1 / cams.length)), [0, 0, 0] as V3);
    const cov = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
    for (const p of cams) {
        const d = sub(p, mc);
        for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) cov[i][j] += d[i] * d[j];
    }
    const { vectors } = symmetricEigen(cov);
    const u = vectors[0] as V3, w = vectors[1] as V3;
    const scale = similarityScale2d(cams.map(p => [dot(sub(p, mc), u), dot(sub(p, mc), w)]), eyes.map(e => [e[0], e[2]]));
    const turns = pairs.map(c => {
        const s = byId.get(c.panoId)!;
        return matMul(transpose(viewRotation(s.referenceHeadingDeg, s.referencePitchDeg ?? 0)), c.rotation);
    });
    const P = cams.map(p => scale3(p, scale));
    const pc = P.reduce((s, p) => add(s, scale3(p, 1 / P.length)), [0, 0, 0] as V3);
    const qc = eyes.reduce((s, p) => add(s, scale3(p, 1 / eyes.length)), [0, 0, 0] as V3);
    const m = [[0, 0, 0], [0, 0, 0], [0, 0, 0]] as M3;
    const wTurn = (o.sigmaM / (o.sigmaDeg * DEG)) ** 2 / 2;
    for (let k = 0; k < P.length; k++) {
        const q = sub(eyes[k], qc), p = sub(P[k], pc);
        for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) m[i][j] += q[i] * p[j] + wTurn * turns[k][i][j];
    }
    const rotation = bestRotation(m);
    const translation = sub(qc, matVec(rotation, pc));
    const cameraOffsetM: Record<string, number> = {};
    pairs.forEach((c, k) => { cameraOffsetM[c.panoId] = len(sub(add(matVec(rotation, P[k]), translation), eyes[k])); });
    const worstTurnDeg = Math.max(0, ...turns.map(t => rotationAngleDeg(matMul(transpose(rotation), t))));
    return { scale, rotation, translation, cameraOffsetM, worstTurnDeg };
}

/** Estimate-frame points into the scan frame under a placement (xyz interleaved). */
export function placePoints(points: Float32Array, p: RigPlacement): Float32Array {
    const out = new Float32Array(points.length);
    const r = p.rotation;
    for (let i = 0; i < points.length; i += 3) {
        const x = points[i] * p.scale, y = points[i + 1] * p.scale, z = points[i + 2] * p.scale;
        out[i] = r[0][0] * x + r[0][1] * y + r[0][2] * z + p.translation[0];
        out[i + 1] = r[1][0] * x + r[1][1] * y + r[1][2] * z + p.translation[1];
        out[i + 2] = r[2][0] * x + r[2][1] * y + r[2][2] * z + p.translation[2];
    }
    return out;
}

// ============================================================================================
// 4. Shift search
// ============================================================================================

/** Occupancy of "within `nearM` of a point" on a voxel grid (a box of that half-width, the cells at `cellM`). */
class NearField {
    private readonly lo: V3;
    private readonly n: [number, number, number];
    private readonly occ: Uint8Array;
    constructor(points: Float32Array, private readonly cellM: number, nearM: number, pad: number) {
        let lo: V3 = [Infinity, Infinity, Infinity], hi: V3 = [-Infinity, -Infinity, -Infinity];
        for (let i = 0; i < points.length; i += 3) for (let k = 0; k < 3; k++) {
            lo[k] = Math.min(lo[k], points[i + k]); hi[k] = Math.max(hi[k], points[i + k]);
        }
        if (!points.length) { lo = [0, 0, 0]; hi = [0, 0, 0]; }
        this.lo = [lo[0] - pad, lo[1] - pad, lo[2] - pad];
        this.n = [0, 1, 2].map(k => Math.max(1, Math.ceil((hi[k] - lo[k] + 2 * pad) / cellM) + 1)) as [number, number, number];
        const [nx, ny, nz] = this.n;
        let occ = new Uint8Array(nx * ny * nz);
        for (let i = 0; i < points.length; i += 3) {
            const ix = Math.floor((points[i] - this.lo[0]) / cellM), iy = Math.floor((points[i + 1] - this.lo[1]) / cellM), iz = Math.floor((points[i + 2] - this.lo[2]) / cellM);
            occ[(iz * ny + iy) * nx + ix] = 1;
        }
        const r = Math.round(nearM / cellM);
        // separable box dilation along x, y, z
        const strides = [1, nx, nx * ny], sizes = [nx, ny, nz];
        for (let axis = 0; axis < 3 && r > 0; axis++) {
            const out = new Uint8Array(occ.length);
            const st = strides[axis], sz = sizes[axis];
            for (let base = 0; base < occ.length; base++) {
                const coord = Math.floor(base / st) % sz;
                if (coord !== 0) continue;
                // walk this line with a running count over the window [i - r, i + r]
                let count = 0;
                for (let j = 0; j <= Math.min(r, sz - 1); j++) count += occ[base + j * st];
                for (let i = 0; i < sz; i++) {
                    if (count > 0) out[base + i * st] = 1;
                    const addIdx = i + r + 1, remIdx = i - r;
                    if (addIdx < sz) count += occ[base + addIdx * st];
                    if (remIdx >= 0) count -= occ[base + remIdx * st];
                }
            }
            occ = out;
        }
        this.occ = occ;
    }
    has(x: number, y: number, z: number): boolean {
        const ix = Math.floor((x - this.lo[0]) / this.cellM), iy = Math.floor((y - this.lo[1]) / this.cellM), iz = Math.floor((z - this.lo[2]) / this.cellM);
        const [nx, ny, nz] = this.n;
        if (ix < 0 || iy < 0 || iz < 0 || ix >= nx || iy >= ny || iz >= nz) return false;
        return this.occ[(iz * ny + iy) * nx + ix] === 1;
    }
}

/** Scan samples near the stated cameras, thinned to about `fitSamples` (module comment, step 4). */
export function fitSamples(scanPoints: Float32Array, eyes: V3[], opts: RigRegistrationOptions = {}): Float32Array {
    const o = { ...RIG_REGISTRATION_DEFAULTS, ...opts };
    const near: number[] = [];
    const r2 = o.fitReachM * o.fitReachM;
    for (let i = 0; i < scanPoints.length; i += 3) {
        for (const e of eyes) {
            const dx = scanPoints[i] - e[0], dy = scanPoints[i + 1] - e[1], dz = scanPoints[i + 2] - e[2];
            if (dx * dx + dy * dy + dz * dz < r2) { near.push(i); break; }
        }
    }
    const step = Math.max(1, Math.floor(near.length / o.fitSamples));
    const out: number[] = [];
    for (let k = 0; k < near.length; k += step) out.push(scanPoints[near[k]], scanPoints[near[k] + 1], scanPoints[near[k] + 2]);
    return Float32Array.from(out);
}

/** The move laying the scan samples on the placed points: most samples within `nearM`, searched coarse to fine. */
export function shiftSearch(samples: Float32Array, placed: Float32Array, opts: RigRegistrationOptions = {}): ShiftSearchResult {
    const o = { ...RIG_REGISTRATION_DEFAULTS, ...opts };
    const reach = o.stepsM.reduce((s, st) => s + st * o.stepsEachWay, 0);
    const cell = Math.max(0.02, Math.min(o.nearM / 3, Math.min(...o.stepsM) / 2));
    const field = new NearField(placed, cell, o.nearM, reach + o.nearM);
    const hits = (m: V3) => {
        let h = 0;
        for (let i = 0; i < samples.length; i += 3) if (field.has(samples[i] + m[0], samples[i + 1] + m[1], samples[i + 2] + m[2])) h++;
        return h;
    };
    let best: V3 = [0, 0, 0];
    const hitsBefore = hits(best);
    let bestHits = hitsBefore;
    const k = o.stepsEachWay;
    for (const step of o.stepsM) {
        const centre = best;
        for (let i = -k; i <= k; i++) for (let j = -k; j <= k; j++) for (let l = -k; l <= k; l++) {
            const m: V3 = [centre[0] + i * step, centre[1] + j * step, centre[2] + l * step];
            const h = hits(m);
            if (h > bestHits || (h === bestHits && len(m) < len(best))) { bestHits = h; best = m; }
        }
    }
    return { move: best, hitsBefore, hitsAfter: bestHits, samples: samples.length / 3 };
}

/** Nearest placed point within `reachM` of a query, by a hash of `reachM` cells. */
class NearestIndex {
    private readonly cells = new Map<string, number[]>();
    constructor(private readonly points: Float32Array, private readonly cellM: number) {
        for (let i = 0; i < points.length; i += 3) {
            const key = `${Math.floor(points[i] / cellM)},${Math.floor(points[i + 1] / cellM)},${Math.floor(points[i + 2] / cellM)}`;
            let list = this.cells.get(key);
            if (!list) { list = []; this.cells.set(key, list); }
            list.push(i);
        }
    }
    nearest(x: number, y: number, z: number): number {
        const cx = Math.floor(x / this.cellM), cy = Math.floor(y / this.cellM), cz = Math.floor(z / this.cellM);
        let best = -1, bestD = this.cellM * this.cellM;
        for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) for (let k = -1; k <= 1; k++) {
            const list = this.cells.get(`${cx + i},${cy + j},${cz + k}`);
            if (!list) continue;
            for (const p of list) {
                const dx = this.points[p] - x, dy = this.points[p + 1] - y, dz = this.points[p + 2] - z;
                const d = dx * dx + dy * dy + dz * dz;
                if (d < bestD) { bestD = d; best = p; }
            }
        }
        return best;
    }
}

/**
 * Ours, after their count search: the count of samples within `nearM` is flat across a band about 2 x `nearM` wide
 * (every move inside it scores the same), so the move is finished by translation-only nearest-point iterations: each
 * sample within `nearM` of a placed point pulls the move by its residual, the mean of those taken until it settles.
 */
export function refineShift(samples: Float32Array, placed: Float32Array, start: V3, opts: RigRegistrationOptions & { iterations?: number } = {}): { move: V3; inliers: number; meanResidualM: number } {
    const o = { ...RIG_REGISTRATION_DEFAULTS, ...opts };
    const index = new NearestIndex(placed, o.nearM);
    let move: V3 = [...start];
    let inliers = 0, meanResidualM = NaN;
    for (let it = 0; it < (opts.iterations ?? 20); it++) {
        let sx = 0, sy = 0, sz = 0, n = 0, sr = 0;
        for (let i = 0; i < samples.length; i += 3) {
            const x = samples[i] + move[0], y = samples[i + 1] + move[1], z = samples[i + 2] + move[2];
            const p = index.nearest(x, y, z);
            if (p < 0) continue;
            const dx = placed[p] - x, dy = placed[p + 1] - y, dz = placed[p + 2] - z;
            sx += dx; sy += dy; sz += dz; sr += Math.hypot(dx, dy, dz); n++;
        }
        inliers = n;
        meanResidualM = n ? sr / n : NaN;
        if (!n) break;
        const step: V3 = [sx / n, sy / n, sz / n];
        move = add(move, step);
        if (len(step) < 1e-3) break;
    }
    return { move, inliers, meanResidualM };
}

// ============================================================================================
// 5. Agreement along the lines of sight
// ============================================================================================

function nearestByDirection(points: Float32Array, eye: V3, reachM: number, binDeg: number): Map<number, number> {
    const out = new Map<number, number>();
    const r2 = reachM * reachM;
    const bins = Math.ceil(180 / binDeg) + 1;
    for (let i = 0; i < points.length; i += 3) {
        const dx = points[i] - eye[0], dy = points[i + 1] - eye[1], dz = points[i + 2] - eye[2];
        const d2 = dx * dx + dy * dy + dz * dz;
        if (d2 >= r2 || d2 < 1e-6) continue;
        const r = Math.sqrt(d2);
        const az = ((Math.atan2(dx, -dz) / DEG) % 360 + 360) % 360;
        const el = Math.asin(Math.max(-1, Math.min(1, dy / r))) / DEG;
        const key = Math.floor(az / binDeg) * bins + Math.floor((el + 90) / binDeg);
        const was = out.get(key);
        if (was === undefined || r < was) out.set(key, r);
    }
    return out;
}

/**
 * Median range difference between the scan's nearest surface and the estimate's, per direction bin round each camera,
 * where they are within `sameM` (module comment, step 5). `cameraMove` moves the cameras and the placed points together.
 */
export function sightAgreement(scanPoints: Float32Array, placed: Float32Array, eyes: V3[], cameraMove: V3, opts: RigRegistrationOptions = {}): { medianM: number; bins: number } {
    const o = { ...RIG_REGISTRATION_DEFAULTS, ...opts };
    const diffs: number[] = [];
    for (const e of eyes) {
        const scan = nearestByDirection(scanPoints, add(e, cameraMove), o.sightReachM, o.sightBinDeg);
        const est = nearestByDirection(placed, e, o.sightReachM, o.sightBinDeg);
        for (const [key, r] of est) {
            const s = scan.get(key);
            if (s === undefined) continue;
            const d = Math.abs(s - r);
            if (d <= o.sameM) diffs.push(d);
        }
    }
    diffs.sort((a, b) => a - b);
    const n = diffs.length;
    return { medianM: n ? (n % 2 ? diffs[(n - 1) / 2] : (diffs[n / 2 - 1] + diffs[n / 2]) / 2) : NaN, bins: n };
}

// ============================================================================================
// The whole registration
// ============================================================================================

/** Heading, pitch and roll (degrees) of a world -> camera rotation. */
export function headingPitchRoll(r: M3): { headingDeg: number; pitchDeg: number; rollDeg: number } {
    const f = r[2], right = r[0];
    const headingDeg = ((Math.atan2(f[0], -f[2]) / DEG) % 360 + 360) % 360;
    const pitchDeg = Math.asin(Math.max(-1, Math.min(1, f[1]))) / DEG;
    const level = viewRotation(headingDeg, pitchDeg);
    const rollDeg = Math.atan2(dot(cross(level[0], right), f), dot(level[0], right)) / DEG;
    return { headingDeg, pitchDeg, rollDeg };
}

/**
 * Registers one drive's panoramas on the scan from their joint depth estimate. `scanPoints` is the scan's surface,
 * sampled densely (xyz interleaved, scan frame).
 */
export function registerRigOnScan(views: RigDepthView[], stated: StatedPano[], scanPoints: Float32Array, opts: RigRegistrationOptions = {}): RigRegistrationResult {
    const o = { ...RIG_REGISTRATION_DEFAULTS, ...opts };
    const consensus = rigConsensus(views, opts);
    const agreeing = consensus.filter(c => c.total > 0 && c.kept / c.total >= o.minKeepRate);
    if (agreeing.length < 2) {
        const rates = consensus.map(c => `${c.panoId}: ${c.kept}/${c.total}`).join(', ');
        throw new RigRegistrationRefused(
            'views_disagree',
            `the depth model's poses do not hold together: fewer than two panoramas have at least ${Math.round(o.minKeepRate * 100)}% of their views within ${o.distThresh} units and ${o.angleThreshDeg} deg of their own consensus (${rates}); the stated poses stand`,
            consensus
        );
    }
    const placement = placeRig(agreeing, stated, opts);
    const placed = placePoints(rigPoints(views, agreeing, opts), placement);
    const byId = new Map(stated.map(s => [s.panoId, s]));
    const eyes = agreeing.filter(c => byId.has(c.panoId)).map(c => byId.get(c.panoId)!.eye);
    const samples = fitSamples(scanPoints, eyes, opts);
    const shift = shiftSearch(samples, placed, opts);
    const refined = refineShift(samples, placed, shift.move, opts);
    const cameraMove = scale3(refined.move, -1);
    const before = sightAgreement(scanPoints, placed, eyes, [0, 0, 0], opts);
    const theirs = sightAgreement(scanPoints, placed, eyes, scale3(shift.move, -1), opts);
    const after = sightAgreement(scanPoints, placed, eyes, cameraMove, opts);
    const corrected: CorrectedPano[] = agreeing.filter(c => byId.has(c.panoId)).map(c => {
        const placedEye = add(matVec(placement.rotation, scale3(c.centre, placement.scale)), placement.translation);
        const eye = add(placedEye, cameraMove);
        const rotation = matMul(c.rotation, transpose(placement.rotation));
        const s = byId.get(c.panoId)!;
        return {
            panoId: c.panoId, stated: s.eye, eye, rotation, movedM: len(sub(eye, s.eye)),
            ...headingPitchRoll(rotation), keptViews: c.kept, totalViews: c.total
        };
    });
    return {
        consensus, placement, shift, refined,
        sightApartM: { before: before.medianM, afterCountSearch: theirs.medianM, after: after.medianM, binsBefore: before.bins, binsAfter: after.bins },
        pointCount: placed.length / 3, corrected
    };
}
