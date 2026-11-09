/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Drive-first Street View registration: the panoramas of one drive are tied to each other before any is fitted to the
 * scan, so no single facade can steer a panorama's pose.
 *
 * Fitted one at a time, a panorama whose scan matches lie mostly on one facade takes a pose that lays that facade
 * right and the rest of its views wrong (a shift and a small turn trade off along one wall), and neighbouring
 * panoramas take moves that disagree (7th Ave & W 32nd St, 2026-11-09: 1.4-6.7 m, in different directions). Photos of
 * one drive share a date, so photo-to-photo matches between panoramas (ties) hold where the scan has changed; they fix
 * the drive's shape. Three stages, each a robust least squares over every panorama's six pose parameters:
 *
 *   1. drive: ties only, each panorama held loosely to its stated pose (`priorPosM`, `priorRotDeg`) for the gauge;
 *   2. rigid: the whole drive moved as one body onto the scan matches (a coarse search over shift and turn, then a
 *      robust refinement), so every panorama's views in every direction vote for the one move;
 *   3. joint: ties, scan matches and the loose priors together, from the rigid stage.
 *
 * A tie is a two-view track whose 3-D point is a free variable, eliminated in each step (Schur complement). Residuals
 * are image distances in pixels under a Cauchy loss (`tieScalePx`, `scanScalePx`), so wrong matches (a changed shop
 * front, a parked car) lose their pull. A pose is the stated eye plus a shift, and a rotation (rotation vector, world
 * frame) turning all of the panorama's views about its eye.
 */

export type V3 = [number, number, number];

/** One view of a panorama: its nominal (stated) camera axes in the world and its intrinsics. */
export interface DriveView {
    right: V3; up: V3; fwd: V3;
    fx: number; fy: number; cx: number; cy: number;
    width: number; height: number;
}

export interface DrivePano {
    panoId: string;
    /** Stated camera centre (world). */
    eye: V3;
    views: DriveView[];
}

/** A pixel in one view of one panorama (indices into the panorama list and its views). */
export interface DriveObs { pano: number; view: number; u: number; v: number }

/** Photo-to-photo match between views of two different panoramas. */
export interface DriveTie { a: DriveObs; b: DriveObs }

/** A photo pixel matched to a scan point (world). */
export interface DriveScanMatch extends DriveObs { X: V3 }

/** A panorama's pose: the eye (world) and a rotation vector (radians, world frame) turning its views about the eye. */
export interface DrivePose { eye: V3; omega: V3 }

export interface DriveRegistrationOptions {
    /** Cauchy scale of tie residuals, px. */
    tieScalePx: number;
    /** Cauchy scale of scan residuals, px. */
    scanScalePx: number;
    /** Loose prior holding each eye to its stated position (1 sigma, m; horizontal and vertical). */
    priorPosM: number;
    priorUpM: number;
    /** Loose prior holding each rotation near the stated one (1 sigma, degrees). */
    priorRotDeg: number;
    /**
     * Prior on positions in the drive stage (1 sigma, m; default `priorPosM`): small keeps the stated relative positions
     * (Street View's own trajectory) and lets the ties fix only the turns, the rigid stage still moving the whole drive.
     */
    drivePriorPosM?: number;
    /** Prior in the joint stage, centred on the rigid stage's poses (1 sigma, m; default `priorPosM`). */
    jointPriorPosM?: number;
    /** Rigid stage's coarse search: shift half-range and step (horizontal, vertical; m) and turn half-range and step (deg). */
    rigidSearchM: number; rigidStepM: number;
    rigidSearchUpM: number; rigidStepUpM: number;
    rigidSearchYawDeg: number; rigidStepYawDeg: number;
    /** Scan matches sampled for the coarse search. */
    rigidSamples: number;
    /** A scan match within this many px counts in the coarse search. */
    inlierPx: number;
    iterations: number;
    /** Ties whose rays meet at less than this angle (degrees) carry no depth and are left out. */
    minTieAngleDeg: number;
}

export const DRIVE_REGISTRATION_DEFAULTS: DriveRegistrationOptions = {
    tieScalePx: 2,
    scanScalePx: 3,
    priorPosM: 5,
    priorUpM: 3,
    priorRotDeg: 3,
    rigidSearchM: 8, rigidStepM: 1,
    rigidSearchUpM: 4, rigidStepUpM: 0.5,
    rigidSearchYawDeg: 4, rigidStepYawDeg: 1,
    rigidSamples: 3000,
    inlierPx: 3,
    iterations: 30,
    minTieAngleDeg: 1
};

// ---------------------------------------------------------------------------------------------
// Small vector and rotation helpers
// ---------------------------------------------------------------------------------------------

const DEG = Math.PI / 180;
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const scale = (a: V3, s: number): V3 => [a[0] * s, a[1] * s, a[2] * s];

/** Rotation matrix (row-major 3x3) of a rotation vector. */
export function rotationFromVector(w: V3): number[] {
    const t = Math.hypot(w[0], w[1], w[2]);
    if (t < 1e-12) return [1, 0, 0, 0, 1, 0, 0, 0, 1];
    const k = scale(w, 1 / t), c = Math.cos(t), s = Math.sin(t), C = 1 - c;
    return [
        c + k[0] * k[0] * C, k[0] * k[1] * C - k[2] * s, k[0] * k[2] * C + k[1] * s,
        k[1] * k[0] * C + k[2] * s, c + k[1] * k[1] * C, k[1] * k[2] * C - k[0] * s,
        k[2] * k[0] * C - k[1] * s, k[2] * k[1] * C + k[0] * s, c + k[2] * k[2] * C
    ];
}
/** Rotation vector of a rotation matrix (row-major). */
export function vectorFromRotation(R: number[]): V3 {
    const c = Math.min(1, Math.max(-1, (R[0] + R[4] + R[8] - 1) / 2));
    const t = Math.acos(c);
    if (t < 1e-9) return [(R[7] - R[5]) / 2, (R[2] - R[6]) / 2, (R[3] - R[1]) / 2];
    const f = t / (2 * Math.sin(t));
    return [(R[7] - R[5]) * f, (R[2] - R[6]) * f, (R[3] - R[1]) * f];
}
const matVec = (R: number[], v: V3): V3 => [R[0] * v[0] + R[1] * v[1] + R[2] * v[2], R[3] * v[0] + R[4] * v[1] + R[5] * v[2], R[6] * v[0] + R[7] * v[1] + R[8] * v[2]];
const matMul = (A: number[], B: number[]): number[] => {
    const C = new Array(9).fill(0);
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) for (let k = 0; k < 3; k++) C[i * 3 + j] += A[i * 3 + k] * B[k * 3 + j];
    return C;
};

/** A view's camera under a pose: its axes turned by the pose's rotation, its eye the pose's. */
export interface PosedCamera { eye: V3; right: V3; up: V3; fwd: V3; fx: number; fy: number; cx: number; cy: number; width: number; height: number }

export function posedCamera(view: DriveView, pose: DrivePose): PosedCamera {
    const R = rotationFromVector(pose.omega);
    return { ...view, eye: pose.eye, right: matVec(R, view.right), up: matVec(R, view.up), fwd: matVec(R, view.fwd) };
}

function project(cam: PosedCamera, X: V3): [number, number] | null {
    const d = sub(X, cam.eye);
    const z = dot(d, cam.fwd);
    if (z <= 1e-3) return null;
    return [cam.cx + cam.fx * dot(d, cam.right) / z, cam.cy - cam.fy * dot(d, cam.up) / z];
}

/** Heading, pitch and roll change (degrees) a pose's rotation makes, read at heading 0 (yaw positive turning right). */
export function poseTurnDeg(pose: DrivePose): { yawDeg: number; pitchDeg: number; rollDeg: number; angleDeg: number } {
    const R = rotationFromVector(pose.omega);
    const f = matVec(R, [0, 0, -1]), r = matVec(R, [1, 0, 0]);
    return {
        yawDeg: Math.atan2(f[0], -f[2]) / DEG,
        pitchDeg: Math.asin(Math.max(-1, Math.min(1, f[1]))) / DEG,
        rollDeg: -Math.asin(Math.max(-1, Math.min(1, r[1]))) / DEG,
        angleDeg: Math.hypot(...pose.omega) / DEG
    };
}

// ---------------------------------------------------------------------------------------------
// Linear algebra
// ---------------------------------------------------------------------------------------------

/** Solves A x = b (n x n, row-major, symmetric positive definite expected) by Gaussian elimination with pivoting. */
function solveLinear(A: Float64Array, b: Float64Array, n: number): Float64Array | null {
    const M = Float64Array.from(A), x = Float64Array.from(b);
    for (let c = 0; c < n; c++) {
        let p = c;
        for (let r = c + 1; r < n; r++) if (Math.abs(M[r * n + c]) > Math.abs(M[p * n + c])) p = r;
        if (Math.abs(M[p * n + c]) < 1e-14) return null;
        if (p !== c) {
            for (let k = 0; k < n; k++) { const t = M[c * n + k]; M[c * n + k] = M[p * n + k]; M[p * n + k] = t; }
            const t = x[c]; x[c] = x[p]; x[p] = t;
        }
        for (let r = c + 1; r < n; r++) {
            const f = M[r * n + c] / M[c * n + c];
            if (f === 0) continue;
            for (let k = c; k < n; k++) M[r * n + k] -= f * M[c * n + k];
            x[r] -= f * x[c];
        }
    }
    for (let r = n - 1; r >= 0; r--) {
        let s = x[r];
        for (let k = r + 1; k < n; k++) s -= M[r * n + k] * x[k];
        x[r] = s / M[r * n + r];
    }
    return x;
}

function inv3(m: number[]): number[] | null {
    const [a, b, c, d, e, f, g, h, i] = m;
    const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
    const det = a * A + b * B + c * C;
    if (Math.abs(det) < 1e-18) return null;
    return [A / det, -(b * i - c * h) / det, (b * f - c * e) / det, B / det, (a * i - c * g) / det, -(a * f - c * d) / det, C / det, -(a * h - b * g) / det, (a * e - b * d) / det];
}

// ---------------------------------------------------------------------------------------------
// The robust bundle step
// ---------------------------------------------------------------------------------------------

/** Parameters of one panorama in a step: [dx, dy, dz, dwx, dwy, dwz] applied to the current pose. */
function applyDelta(p: DrivePose, d: ArrayLike<number>, o: number): DrivePose {
    const Rd = rotationFromVector([d[o + 3], d[o + 4], d[o + 5]]);
    return { eye: [p.eye[0] + d[o], p.eye[1] + d[o + 1], p.eye[2] + d[o + 2]], omega: vectorFromRotation(matMul(Rd, rotationFromVector(p.omega))) };
}

const cauchyCost = (r2: number, c: number) => 0.5 * c * c * Math.log1p(r2 / (c * c));
const cauchyWeight = (r2: number, c: number) => 1 / (1 + r2 / (c * c));

/** Triangulates a tie's point as the midpoint of the closest approach of its two rays, or null when they barely meet. */
function triangulate(ca: PosedCamera, oa: DriveObs, cb: PosedCamera, ob: DriveObs, minAngleRad: number): V3 | null {
    const ray = (c: PosedCamera, o: DriveObs): V3 => {
        const x = (o.u - c.cx) / c.fx, y = (c.cy - o.v) / c.fy;
        const d = add(add(c.fwd, scale(c.right, x)), scale(c.up, y));
        return scale(d, 1 / Math.hypot(...d));
    };
    const da = ray(ca, oa), db = ray(cb, ob);
    const cosang = dot(da, db);
    if (Math.acos(Math.min(1, Math.abs(cosang))) < minAngleRad) return null;
    const w = sub(ca.eye, cb.eye);
    const b = cosang, d = dot(da, w), e = dot(db, w);
    const den = 1 - b * b;
    if (den < 1e-12) return null;
    const s = (b * e - d) / den, t = (e - b * d) / den;
    if (s <= 0.5 || t <= 0.5) return null;
    return scale(add(add(ca.eye, scale(da, s)), add(cb.eye, scale(db, t))), 0.5);
}

interface StepInput {
    panos: DrivePano[];
    stated: DrivePose[];
    ties: DriveTie[];
    scan: DriveScanMatch[];
    opts: DriveRegistrationOptions;
    useTies: boolean;
    useScan: boolean;
}

interface BundleState { poses: DrivePose[]; points: Array<V3 | null> }

function totalCost(inp: StepInput, st: BundleState): number {
    const { panos, opts } = inp;
    const cams = st.poses.map((p, i) => panos[i].views.map(v => posedCamera(v, p)));
    let cost = 0;
    if (inp.useTies) inp.ties.forEach((t, k) => {
        const P = st.points[k]; if (!P) return;
        for (const o of [t.a, t.b]) {
            const pr = project(cams[o.pano][o.view], P);
            cost += pr ? cauchyCost((pr[0] - o.u) ** 2 + (pr[1] - o.v) ** 2, opts.tieScalePx) : cauchyCost(1e6, opts.tieScalePx);
        }
    });
    if (inp.useScan) for (const m of inp.scan) {
        const pr = project(cams[m.pano][m.view], m.X);
        cost += pr ? cauchyCost((pr[0] - m.u) ** 2 + (pr[1] - m.v) ** 2, opts.scanScalePx) : cauchyCost(1e6, opts.scanScalePx);
    }
    st.poses.forEach((p, i) => cost += priorCost(p, inp.stated[i], opts));
    return cost;
}

function priorResiduals(p: DrivePose, s: DrivePose, o: DriveRegistrationOptions): number[] {
    const d = sub(p.eye, s.eye);
    const w = vectorFromRotation(matMul(rotationFromVector(p.omega), transpose3(rotationFromVector(s.omega))));
    const sr = o.priorRotDeg * DEG;
    return [d[0] / o.priorPosM, d[1] / o.priorUpM, d[2] / o.priorPosM, w[0] / sr, w[1] / sr, w[2] / sr];
}
const priorCost = (p: DrivePose, s: DrivePose, o: DriveRegistrationOptions) => 0.5 * priorResiduals(p, s, o).reduce((a, r) => a + r * r, 0);
const transpose3 = (R: number[]) => [R[0], R[3], R[6], R[1], R[4], R[7], R[2], R[5], R[8]];

/**
 * Levenberg-Marquardt over every panorama's pose, tie points eliminated by the Schur complement, residuals re-weighted
 * (Cauchy) every iteration. Returns the poses and the tie points it ends on.
 */
function bundle(inp: StepInput, start: BundleState): BundleState & { cost: number; iterations: number } {
    const { panos, opts } = inp;
    const N = panos.length, n = 6 * N;
    let st: BundleState = { poses: start.poses.map(p => ({ eye: [...p.eye] as V3, omega: [...p.omega] as V3 })), points: start.points.slice() };
    let cost = totalCost(inp, st);
    let lambda = 1e-3;
    const hP = 1e-4, hW = 1e-6;
    let it = 0;
    for (; it < opts.iterations; it++) {
        const cams = st.poses.map((p, i) => panos[i].views.map(v => posedCamera(v, p)));
        // pose Jacobians by finite differences: perturbed cameras per panorama and parameter
        const pert: PosedCamera[][][] = st.poses.map((p, i) => [0, 1, 2, 3, 4, 5].map(k => {
            const d = [0, 0, 0, 0, 0, 0]; d[k] = k < 3 ? hP : hW;
            const q = applyDelta(p, d, 0);
            return panos[i].views.map(v => posedCamera(v, q));
        }));
        const H = new Float64Array(n * n), g = new Float64Array(n);
        const poseJ = (o: DriveObs, X: V3, base: [number, number]): number[][] => {
            const J: number[][] = [[], []];
            for (let k = 0; k < 6; k++) {
                const pr = project(pert[o.pano][k][o.view], X);
                const h = k < 3 ? hP : hW;
                J[0][k] = pr ? (pr[0] - base[0]) / h : 0; J[1][k] = pr ? (pr[1] - base[1]) / h : 0;
            }
            return J;
        };
        const addPose = (pi: number, J: number[][], r: number[], w: number) => {
            const o = 6 * pi;
            for (let a = 0; a < 6; a++) {
                g[o + a] += w * (J[0][a] * r[0] + J[1][a] * r[1]);
                for (let b = 0; b < 6; b++) H[(o + a) * n + o + b] += w * (J[0][a] * J[0][b] + J[1][a] * J[1][b]);
            }
        };
        // ties, with their point eliminated
        const tieBlocks: Array<{ k: number; Hinv: number[]; HpP: Array<{ pi: number; M: number[] }>; gP: V3 } | null> = [];
        if (inp.useTies) inp.ties.forEach((t, k) => {
            const P = st.points[k]; if (!P) { tieBlocks.push(null); return; }
            const HPP = [0, 0, 0, 0, 0, 0, 0, 0, 0]; const gP: V3 = [0, 0, 0];
            const HpP: Array<{ pi: number; M: number[] }> = [];
            let ok = true;
            for (const o of [t.a, t.b]) {
                const cam = cams[o.pano][o.view];
                const base = project(cam, P); if (!base) { ok = false; break; }
                const r = [base[0] - o.u, base[1] - o.v];
                const w = cauchyWeight(r[0] * r[0] + r[1] * r[1], opts.tieScalePx);
                const Jp = poseJ(o, P, base);
                const JX: number[][] = [[], []];
                for (let a = 0; a < 3; a++) {
                    const Q: V3 = [...P] as V3; Q[a] += hP;
                    const pr = project(cam, Q)!;
                    JX[0][a] = pr ? (pr[0] - base[0]) / hP : 0; JX[1][a] = pr ? (pr[1] - base[1]) / hP : 0;
                }
                addPose(o.pano, Jp, r, w);
                const M = new Array(18).fill(0);
                for (let a = 0; a < 6; a++) for (let b = 0; b < 3; b++) M[a * 3 + b] = w * (Jp[0][a] * JX[0][b] + Jp[1][a] * JX[1][b]);
                HpP.push({ pi: o.pano, M });
                for (let a = 0; a < 3; a++) {
                    gP[a] += w * (JX[0][a] * r[0] + JX[1][a] * r[1]);
                    for (let b = 0; b < 3; b++) HPP[a * 3 + b] += w * (JX[0][a] * JX[0][b] + JX[1][a] * JX[1][b]);
                }
            }
            if (!ok) { tieBlocks.push(null); return; }
            for (let a = 0; a < 3; a++) HPP[a * 4] *= 1 + lambda;
            const Hinv = inv3(HPP); if (!Hinv) { tieBlocks.push(null); return; }
            // Schur: H -= HpP Hinv HPp ; g -= HpP Hinv gP
            for (const A of HpP) {
                const AH = new Array(18).fill(0);
                for (let a = 0; a < 6; a++) for (let b = 0; b < 3; b++) for (let c = 0; c < 3; c++) AH[a * 3 + b] += A.M[a * 3 + c] * Hinv[c * 3 + b];
                for (let a = 0; a < 6; a++) {
                    g[6 * A.pi + a] -= AH[a * 3] * gP[0] + AH[a * 3 + 1] * gP[1] + AH[a * 3 + 2] * gP[2];
                    for (const B of HpP) for (let b = 0; b < 6; b++) {
                        H[(6 * A.pi + a) * n + 6 * B.pi + b] -= AH[a * 3] * B.M[b * 3] + AH[a * 3 + 1] * B.M[b * 3 + 1] + AH[a * 3 + 2] * B.M[b * 3 + 2];
                    }
                }
            }
            tieBlocks.push({ k, Hinv, HpP, gP });
        });
        if (inp.useScan) for (const m of inp.scan) {
            const base = project(cams[m.pano][m.view], m.X); if (!base) continue;
            const r = [base[0] - m.u, base[1] - m.v];
            addPose(m.pano, poseJ(m, m.X, base), r, cauchyWeight(r[0] * r[0] + r[1] * r[1], opts.scanScalePx));
        }
        // priors (their Jacobian by finite differences too)
        st.poses.forEach((p, i) => {
            const r0 = priorResiduals(p, inp.stated[i], opts);
            const J: number[][] = r0.map(() => []);
            for (let k = 0; k < 6; k++) {
                const d = [0, 0, 0, 0, 0, 0]; const h = k < 3 ? hP : hW; d[k] = h;
                const r1 = priorResiduals(applyDelta(p, d, 0), inp.stated[i], opts);
                for (let a = 0; a < 6; a++) J[a][k] = (r1[a] - r0[a]) / h;
            }
            for (let a = 0; a < 6; a++) for (let b = 0; b < 6; b++) {
                let s = 0; for (let q = 0; q < 6; q++) s += J[q][a] * J[q][b];
                H[(6 * i + a) * n + 6 * i + b] += s;
            }
            for (let a = 0; a < 6; a++) { let s = 0; for (let q = 0; q < 6; q++) s += J[q][a] * r0[q]; g[6 * i + a] += s; }
        });
        for (let a = 0; a < n; a++) H[a * n + a] *= 1 + lambda;
        const neg = g.map(x => -x);
        const dp = solveLinear(H, neg, n);
        if (!dp) { lambda *= 10; continue; }
        const poses = st.poses.map((p, i) => applyDelta(p, dp, 6 * i));
        const points = st.points.slice();
        for (const tb of tieBlocks) {
            if (!tb) continue;
            const rhs: V3 = [...tb.gP] as V3;
            for (const A of tb.HpP) for (let b = 0; b < 3; b++) for (let a = 0; a < 6; a++) rhs[b] += A.M[a * 3 + b] * dp[6 * A.pi + a];
            const dX = matVec(tb.Hinv, rhs);
            points[tb.k] = sub(st.points[tb.k]!, dX);
        }
        const next = { poses, points };
        const c2 = totalCost(inp, next);
        const stepSize = Math.max(...Array.from(dp).map(Math.abs));
        if (c2 < cost) {
            st = next; lambda = Math.max(1e-7, lambda / 3);
            const rel = (cost - c2) / cost; cost = c2;
            if (rel < 1e-7 || stepSize < 1e-6) { it++; break; }
        } else {
            lambda *= 10;
            if (lambda > 1e8) break;
        }
    }
    return { ...st, cost, iterations: it };
}

// ---------------------------------------------------------------------------------------------
// Stages
// ---------------------------------------------------------------------------------------------

function triangulateAll(panos: DrivePano[], poses: DrivePose[], ties: DriveTie[], minAngleDeg: number): Array<V3 | null> {
    const cams = poses.map((p, i) => panos[i].views.map(v => posedCamera(v, p)));
    return ties.map(t => triangulate(cams[t.a.pano][t.a.view], t.a, cams[t.b.pano][t.b.view], t.b, minAngleDeg * DEG));
}

/** The drive moved as one body: eye' = c + R (eye - c) + t, rotation' = R rotation. */
export function moveDrive(poses: DrivePose[], t: V3, w: V3, centre: V3): DrivePose[] {
    const R = rotationFromVector(w);
    return poses.map(p => ({ eye: add(add(centre, matVec(R, sub(p.eye, centre))), t), omega: vectorFromRotation(matMul(R, rotationFromVector(p.omega))) }));
}

function scanInliers(panos: DrivePano[], poses: DrivePose[], scan: DriveScanMatch[], px: number): number {
    const cams = poses.map((p, i) => panos[i].views.map(v => posedCamera(v, p)));
    let n = 0;
    for (const m of scan) { const pr = project(cams[m.pano][m.view], m.X); if (pr && (pr[0] - m.u) ** 2 + (pr[1] - m.v) ** 2 <= px * px) n++; }
    return n;
}

function scanCost(panos: DrivePano[], poses: DrivePose[], scan: DriveScanMatch[], c: number): number {
    const cams = poses.map((p, i) => panos[i].views.map(v => posedCamera(v, p)));
    let s = 0;
    for (const m of scan) { const pr = project(cams[m.pano][m.view], m.X); s += pr ? cauchyCost((pr[0] - m.u) ** 2 + (pr[1] - m.v) ** 2, c) : cauchyCost(1e6, c); }
    return s;
}

/** The rigid stage: a coarse search over the drive's shift and turn, then a robust refinement of the six parameters. */
function rigidFit(panos: DrivePano[], drive: DrivePose[], scan: DriveScanMatch[], opts: DriveRegistrationOptions): { t: V3; w: V3; inliers: number } {
    const centre = scale(drive.reduce((a, p) => add(a, p.eye), [0, 0, 0] as V3), 1 / drive.length);
    const step = Math.max(1, Math.floor(scan.length / opts.rigidSamples));
    const sample = scan.filter((_, i) => i % step === 0);
    const seeds: Array<{ t: V3; w: V3; n: number }> = [];
    const range = (h: number, s: number) => { const v: number[] = []; for (let x = -h; x <= h + 1e-9; x += s) v.push(x); return v; };
    for (const yaw of range(opts.rigidSearchYawDeg, opts.rigidStepYawDeg)) {
        const w: V3 = [0, -yaw * DEG, 0];
        for (const tx of range(opts.rigidSearchM, opts.rigidStepM)) for (const tz of range(opts.rigidSearchM, opts.rigidStepM)) for (const ty of range(opts.rigidSearchUpM, opts.rigidStepUpM)) {
            const n = scanInliers(panos, moveDrive(drive, [tx, ty, tz], w, centre), sample, opts.inlierPx * 1.5);
            seeds.push({ t: [tx, ty, tz], w, n });
        }
    }
    seeds.sort((a, b) => b.n - a.n);
    let best = { t: [0, 0, 0] as V3, w: [0, 0, 0] as V3, cost: Infinity };
    for (const s of seeds.slice(0, 6)) {
        // coordinate-wise robust refinement, halving steps (6 parameters: cheap, no derivatives)
        let p = [...s.t, ...s.w];
        let c = scanCost(panos, moveDrive(drive, [p[0], p[1], p[2]], [p[3], p[4], p[5]], centre), scan, opts.scanScalePx);
        for (const [sm, sr] of [[0.5, 0.5 * DEG], [0.2, 0.2 * DEG], [0.05, 0.05 * DEG], [0.01, 0.01 * DEG]]) {
            for (let rep = 0; rep < 8; rep++) {
                let moved = false;
                for (let k = 0; k < 6; k++) for (const sg of [1, -1]) {
                    const q = p.slice(); q[k] += sg * (k < 3 ? sm : sr);
                    const cq = scanCost(panos, moveDrive(drive, [q[0], q[1], q[2]], [q[3], q[4], q[5]], centre), scan, opts.scanScalePx);
                    if (cq < c) { c = cq; p = q; moved = true; }
                }
                if (!moved) break;
            }
        }
        if (c < best.cost) best = { t: [p[0], p[1], p[2]], w: [p[3], p[4], p[5]], cost: c };
    }
    return { t: best.t, w: best.w, inliers: scanInliers(panos, moveDrive(drive, best.t, best.w, centre), scan, opts.inlierPx) };
}

export interface DriveStageResult {
    poses: DrivePose[];
    /** Scan matches within `inlierPx` under these poses. */
    scanInliers: number;
    /** Ties whose point reprojects within `tieScalePx` in both views. */
    tieInliers: number;
}

export interface DriveRegistrationResult {
    stated: DriveStageResult;
    drive: DriveStageResult;
    rigid: DriveStageResult & { shift: V3; turnDeg: number };
    joint: DriveStageResult;
    /** Ties used (rays meeting at `minTieAngleDeg` or more under the stated poses). */
    tiesUsed: number;
}

function tieInliers(panos: DrivePano[], poses: DrivePose[], ties: DriveTie[], points: Array<V3 | null>, px: number): number {
    const cams = poses.map((p, i) => panos[i].views.map(v => posedCamera(v, p)));
    let n = 0;
    ties.forEach((t, k) => {
        const P = points[k]; if (!P) return;
        const ok = [t.a, t.b].every(o => { const pr = project(cams[o.pano][o.view], P); return pr && (pr[0] - o.u) ** 2 + (pr[1] - o.v) ** 2 <= px * px; });
        if (ok) n++;
    });
    return n;
}

/**
 * Registers a drive: its panoramas tied to each other by photo-to-photo matches, then moved as one body onto the scan,
 * then refined jointly. `scan` may leave a panorama out entirely (a held-out check): its pose then follows from its
 * ties to the others.
 */
export function registerDriveOnScan(panos: DrivePano[], ties: DriveTie[], scan: DriveScanMatch[], options: Partial<DriveRegistrationOptions> = {}): DriveRegistrationResult {
    const opts = { ...DRIVE_REGISTRATION_DEFAULTS, ...options };
    if (panos.length < 2) throw new Error('registerDriveOnScan needs at least two panoramas');
    const stated: DrivePose[] = panos.map(p => ({ eye: [...p.eye] as V3, omega: [0, 0, 0] }));
    const pts0 = triangulateAll(panos, stated, ties, opts.minTieAngleDeg);
    const keep = pts0.map((p, i) => p ? i : -1).filter(i => i >= 0);
    const T = keep.map(i => ties[i]);
    const P0 = keep.map(i => pts0[i]);
    const summary = (poses: DrivePose[], points: Array<V3 | null>): DriveStageResult => ({
        poses, scanInliers: scanInliers(panos, poses, scan, opts.inlierPx), tieInliers: tieInliers(panos, poses, T, points, opts.tieScalePx)
    });
    const base = { panos, stated, ties: T, scan, opts };
    const withPos = (m: number | undefined) => m === undefined ? opts : { ...opts, priorPosM: m, priorUpM: Math.min(opts.priorUpM, m) };
    const drive = bundle({ ...base, opts: withPos(opts.drivePriorPosM), useTies: true, useScan: false }, { poses: stated, points: P0 });
    const rf = rigidFit(panos, drive.poses, scan, opts);
    const centre = scale(drive.poses.reduce((a, p) => add(a, p.eye), [0, 0, 0] as V3), 1 / drive.poses.length);
    const rigidPoses = moveDrive(drive.poses, rf.t, rf.w, centre);
    const rigidPoints = triangulateAll(panos, rigidPoses, T, opts.minTieAngleDeg);
    const joint = bundle({ ...base, stated: rigidPoses, opts: withPos(opts.jointPriorPosM), useTies: true, useScan: true }, { poses: rigidPoses, points: rigidPoints });
    return {
        stated: summary(stated, P0),
        drive: summary(drive.poses, drive.points),
        rigid: { ...summary(rigidPoses, rigidPoints), shift: rf.t, turnDeg: Math.hypot(...rf.w) / DEG },
        joint: summary(joint.poses, joint.points),
        tiesUsed: T.length
    };
}

/** Per-view scan residual statistics under poses: median px and the share within `px`. */
export function scanResidualsByView(panos: DrivePano[], poses: DrivePose[], scan: DriveScanMatch[], px = 3): Array<Array<{ n: number; medianPx: number; within: number }>> {
    const cams = poses.map((p, i) => panos[i].views.map(v => posedCamera(v, p)));
    const res: number[][][] = panos.map(p => p.views.map(() => []));
    for (const m of scan) {
        const pr = project(cams[m.pano][m.view], m.X);
        res[m.pano][m.view].push(pr ? Math.hypot(pr[0] - m.u, pr[1] - m.v) : Infinity);
    }
    return res.map(pv => pv.map(r => {
        if (!r.length) return { n: 0, medianPx: NaN, within: NaN };
        const s = r.slice().sort((a, b) => a - b);
        return { n: r.length, medianPx: s[Math.floor(s.length / 2)], within: r.filter(x => x <= px).length / r.length };
    }));
}
