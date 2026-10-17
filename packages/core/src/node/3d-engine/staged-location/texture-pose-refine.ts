/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * A second pose registration from the per-chart image alignment (texture-alignment.ts). The box registration
 * (pano-registration.ts) leaves each pano about a metre off; the alignment then finds, chart by chart, where in the photo
 * each texel's detail really is (against the other views and the geometry-registered tile photo). Every aligned sample is
 * a 2D-3D correspondence: the texel's point on the layer and the pixel the alignment moved it to. Per pano (its views
 * share one pose), the eye shift east/north (metres) and the heading and pitch (degrees), the registration's own four
 * values, are solved by damped Gauss-Newton on those correspondences with a Huber loss and the registration's pose prior,
 * and the views are projected again from the refined poses. A pano whose refinement is implausible (beyond what its
 * metadata can be off by) or does not lower its residual keeps its registered pose.
 *
 * The residual is measured on the surface: the reprojection error in pixels times depth over focal length (metres), the
 * same unit as the registration's pair RMS.
 */

import type { Vec3 } from '../../../common/spatial/staged-location-contracts';
import type { PinholeCamera, ProjectionView, UvAtlas } from '../../../common/spatial/texture-pass-contracts';
import { MAX_PLAUSIBLE_PITCH_DEG, MAX_PLAUSIBLE_SHIFT_M, MAX_PLAUSIBLE_YAW_DEG, POSE_PRIOR_SIGMA } from './pano-registration';

export interface PoseRefineSamples { texel: Int32Array; x: Float32Array; y: Float32Array }
export interface PoseRefineShift { view: number; map: number; kind: string }

export interface PoseRefineOptions {
    /** Correspondences kept per (view, chart), evenly subsampled. Default 250. */
    perChart?: number;
    /** Fewest correspondences for a pano to be refined. Default 60. */
    minPoints?: number;
    /** Fewest aligned charts behind them (one chart's shift is fitted exactly by any pose and says nothing). Default 2. */
    minCharts?: number;
    /** Huber threshold on the surface residual, metres. Default 0.3. */
    huberM?: number;
    iterations?: number;
    /** A refinement must lower the pano's RMS to below this share of the registered pose's. Default 0.9. */
    minImprovement?: number;
    /**
     * Solve one pose per pano (its views share it) or one per view (each grounding image keeps its own heading and pitch
     * error, as the imagery API renders each crop separately). Default 'view'.
     */
    groupBy?: 'pano' | 'view' | (string & {});
}

export interface PanoRefinement {
    panoId: string; views: number; points: number;
    /** Surface RMS of the alignment correspondences with the registered pose and with the refined one, metres. */
    rmsBeforeM: number; rmsAfterM: number;
    dxM: number; dzM: number; dyawDeg: number; dpitchDeg: number;
    applied: boolean; reason?: string;
}

export interface PoseRefinement {
    /** The views with refined cameras (the same objects where nothing changed). */
    views: ProjectionView[];
    perPano: PanoRefinement[];
    /** Over every correspondence used. */
    rmsBeforeM: number; rmsAfterM: number; points: number;
    applied: number;
}

const rot = (v: Vec3, k: Vec3, a: number): Vec3 => {
    const c = Math.cos(a), s = Math.sin(a), d = v[0] * k[0] + v[1] * k[1] + v[2] * k[2];
    const x: Vec3 = [k[1] * v[2] - k[2] * v[1], k[2] * v[0] - k[0] * v[2], k[0] * v[1] - k[1] * v[0]];
    return [v[0] * c + x[0] * s + k[0] * d * (1 - c), v[1] * c + x[1] * s + k[1] * d * (1 - c), v[2] * c + x[2] * s + k[2] * d * (1 - c)];
};

/** The camera moved by (dx, dz) metres in the ground plane and turned by yaw (about the world up, +Y) and pitch (about its right axis). */
export function perturbCamera(cam: PinholeCamera, p: readonly number[]): PinholeCamera {
    const [dx, dz, yawDeg, pitchDeg] = p;
    const y = (yawDeg * Math.PI) / 180, pt = (pitchDeg * Math.PI) / 180;
    const upW: Vec3 = [0, 1, 0];
    let fwd = rot(cam.fwd, upW, y), right = rot(cam.right, upW, y), up = rot(cam.up, upW, y);
    fwd = rot(fwd, right, pt); up = rot(up, right, pt);
    return { ...cam, eye: [cam.eye[0] + dx, cam.eye[1], cam.eye[2] + dz], fwd, right, up };
}

function project(cam: PinholeCamera, P: Vec3): { x: number; y: number; z: number } {
    const dx = P[0] - cam.eye[0], dy = P[1] - cam.eye[1], dz = P[2] - cam.eye[2];
    const z = dx * cam.fwd[0] + dy * cam.fwd[1] + dz * cam.fwd[2];
    return {
        x: cam.cx + (cam.fx * (dx * cam.right[0] + dy * cam.right[1] + dz * cam.right[2])) / z,
        y: cam.cy - (cam.fy * (dx * cam.up[0] + dy * cam.up[1] + dz * cam.up[2])) / z,
        z
    };
}

function solveSmall(A: number[][], b: number[]): number[] {
    const n = b.length;
    const M = A.map((r, i) => [...r, b[i]]);
    for (let i = 0; i < n; i++) {
        let p = i;
        for (let r = i + 1; r < n; r++) if (Math.abs(M[r][i]) > Math.abs(M[p][i])) p = r;
        [M[i], M[p]] = [M[p], M[i]];
        const piv = M[i][i] || 1e-12;
        for (let r = i + 1; r < n; r++) { const f = M[r][i] / piv; for (let c = i; c <= n; c++) M[r][c] -= f * M[i][c]; }
    }
    const x = new Array<number>(n).fill(0);
    for (let i = n - 1; i >= 0; i--) { let s = M[i][n]; for (let c = i + 1; c < n; c++) s -= M[i][c] * x[c]; x[i] = s / (M[i][i] || 1e-12); }
    return x;
}

/**
 * Refines each pano's pose from the alignment's correspondences (see the file comment). `samples[k]` are view k's projected
 * samples (texel, pixel), `dx`/`dy` the alignment's per-sample shifts and `shifts` its per-(view, chart) kinds: only the
 * charts it aligned on their own ('aligned') give correspondences. `residualM(k)` is the registration's residual for the
 * view's pano (the prior's sigma on the shift).
 */
export function refinePosesFromAlignment(atlas: UvAtlas, views: ProjectionView[], samples: PoseRefineSamples[], dx: Float32Array[], dy: Float32Array[],
    shifts: PoseRefineShift[], opts: PoseRefineOptions = {}): PoseRefinement {
    const perChart = opts.perChart ?? 250, minPoints = opts.minPoints ?? 60, huber = opts.huberM ?? 0.3, iters = opts.iterations ?? 12, minImp = opts.minImprovement ?? 0.9;
    const { mapIndex, position } = atlas.texels;
    const aligned = new Set(shifts.filter(s => s.kind === 'aligned').map(s => `${s.view}:${s.map}`));
    // correspondences per view
    type Corr = { P: Vec3; x: number; y: number; map: number };
    const corr: Corr[][] = views.map(() => []);
    samples.forEach((s, k) => {
        const byMap = new Map<number, number[]>();
        for (let i = 0; i < s.texel.length; i++) {
            const m = mapIndex[s.texel[i]];
            if (!aligned.has(`${k}:${m}`)) continue;
            let l = byMap.get(m);
            if (!l) { l = []; byMap.set(m, l); }
            l.push(i);
        }
        for (const [m, list] of byMap) {
            const step = Math.max(1, Math.floor(list.length / perChart));
            for (let j = 0; j < list.length; j += step) {
                const i = list[j], t = s.texel[i];
                corr[k].push({ P: [position[t * 3], position[t * 3 + 1], position[t * 3 + 2]], x: s.x[i] + dx[k][i], y: s.y[i] + dy[k][i], map: m });
            }
        }
    });
    const perView = (opts.groupBy ?? 'view') !== 'pano';
    const groupOf = (k: number) => (perView ? `${views[k].panoId}#${k}` : views[k].panoId);
    const panos = [...new Set(views.map((_, k) => groupOf(k)))];
    const out = views.slice();
    const perPano: PanoRefinement[] = [];
    let sb = 0, sa = 0, np = 0, applied = 0;
    for (const panoId of panos) {
        const ks = views.map((_, k) => (groupOf(k) === panoId ? k : -1)).filter(k => k >= 0);
        const pts = ks.reduce((n, k) => n + corr[k].length, 0);
        const charts = new Set(ks.flatMap(k => corr[k].map(c => `${k}:${c.map}`))).size;
        if (pts && charts < (opts.minCharts ?? 2)) { perPano.push({ panoId, views: ks.length, points: pts, rmsBeforeM: NaN, rmsAfterM: NaN, dxM: 0, dzM: 0, dyawDeg: 0, dpitchDeg: 0, applied: false, reason: `its correspondences come from ${charts} aligned chart` }); continue; }
        if (pts < minPoints) { if (pts) perPano.push({ panoId, views: ks.length, points: pts, rmsBeforeM: NaN, rmsAfterM: NaN, dxM: 0, dzM: 0, dyawDeg: 0, dpitchDeg: 0, applied: false, reason: `only ${pts} aligned correspondences` }); continue; }
        // the prior's sigma on the shift: the registration's residual for this pano (the pose sigma in px over fx), at least 0.25 m
        const sigM = Math.max(0.25, Math.min(POSE_PRIOR_SIGMA.meters, views[ks[0]].poseSigmaPx / views[ks[0]].camera.fx));
        const sig = [sigM, sigM, POSE_PRIOR_SIGMA.degrees, POSE_PRIOR_SIGMA.degrees];
        /** Surface residuals (metres) of every correspondence, x then y, at parameters p. */
        const resid = (p: number[]): Float64Array => {
            const r = new Float64Array(pts * 2);
            let q = 0;
            for (const k of ks) {
                const cam = perturbCamera(views[k].camera, p);
                for (const c of corr[k]) {
                    const pr = project(cam, c.P);
                    const s = Math.max(1, pr.z) / cam.fx;
                    r[q++] = (pr.x - c.x) * s; r[q++] = (pr.y - c.y) * s;
                }
            }
            return r;
        };
        const rms = (r: Float64Array) => { let s = 0; for (let i = 0; i < r.length; i += 2) s += r[i] * r[i] + r[i + 1] * r[i + 1]; return Math.sqrt(s / (r.length / 2)); };
        const robustW = (r: Float64Array): Float64Array => {
            const w = new Float64Array(r.length / 2);
            for (let i = 0; i < w.length; i++) { const e = Math.hypot(r[2 * i], r[2 * i + 1]); w[i] = e <= huber ? 1 : huber / e; }
            return w;
        };
        const cost = (r: Float64Array, w: Float64Array, p: number[]) => {
            let c = 0;
            for (let i = 0; i < w.length; i++) c += w[i] * (r[2 * i] ** 2 + r[2 * i + 1] ** 2);
            for (let j = 0; j < 4; j++) c += (p[j] / sig[j]) ** 2;
            return c;
        };
        let p = [0, 0, 0, 0];
        let r = resid(p);
        const r0 = rms(r);
        let lambda = 1e-2;
        for (let it = 0; it < iters; it++) {
            const w = robustW(r);
            const c0 = cost(r, w, p);
            const J: Float64Array[] = [];
            const steps = [0.02, 0.02, 0.02, 0.02];
            for (let j = 0; j < 4; j++) { const pp = p.slice(); pp[j] += steps[j]; const rp = resid(pp); J.push(rp.map((v, i) => (v - r[i]) / steps[j])); }
            const A = Array.from({ length: 4 }, () => new Array<number>(4).fill(0)), g = new Array<number>(4).fill(0);
            for (let i = 0; i < r.length; i++) {
                const wi = w[i >> 1];
                for (let a = 0; a < 4; a++) { g[a] += wi * J[a][i] * r[i]; for (let b = 0; b < 4; b++) A[a][b] += wi * J[a][i] * J[b][i]; }
            }
            for (let j = 0; j < 4; j++) { g[j] += p[j] / (sig[j] * sig[j]); A[j][j] += 1 / (sig[j] * sig[j]); }
            let improved = false;
            for (let tries = 0; tries < 6; tries++) {
                const Al = A.map((row, a) => row.map((v, b) => v + (a === b ? lambda * (v || 1) : 0)));
                const d = solveSmall(Al, g.map(v => -v));
                const pn = p.map((v, j) => v + d[j]);
                const rn = resid(pn);
                if (cost(rn, w, pn) < c0) { p = pn; r = rn; lambda = Math.max(1e-6, lambda / 3); improved = true; break; }
                lambda *= 5;
            }
            if (!improved) break;
        }
        const r1 = rms(r);
        const implausible = Math.hypot(p[0], p[1]) > MAX_PLAUSIBLE_SHIFT_M || Math.abs(p[2]) > MAX_PLAUSIBLE_YAW_DEG || Math.abs(p[3]) > MAX_PLAUSIBLE_PITCH_DEG;
        const ok = !implausible && r1 < minImp * r0;
        const rep: PanoRefinement = {
            panoId, views: ks.length, points: pts, rmsBeforeM: r0, rmsAfterM: ok ? r1 : r0, dxM: p[0], dzM: p[1], dyawDeg: p[2], dpitchDeg: p[3], applied: ok,
            ...(ok ? {} : { reason: implausible ? 'the refined pose is beyond what a pano can be off by' : `it lowered the residual only from ${r0.toFixed(2)} to ${r1.toFixed(2)} m` })
        };
        perPano.push(rep);
        sb += r0 * r0 * pts; sa += rep.rmsAfterM * rep.rmsAfterM * pts; np += pts;
        if (!ok) continue;
        applied++;
        for (const k of ks) {
            const v = views[k];
            // the pose uncertainty becomes the refined residual (it never grows)
            const sigmaPx = Math.min(v.poseSigmaPx, v.camera.fx * Math.max(0.1, r1));
            out[k] = { ...v, camera: perturbCamera(v.camera, p), poseSigmaPx: sigmaPx, poseQuality: Math.max(v.poseQuality, Math.exp(-0.5 * (Math.max(0.1, r1) / POSE_PRIOR_SIGMA.meters) ** 2)) };
        }
    }
    return { views: out, perPano, rmsBeforeM: np ? Math.sqrt(sb / np) : 0, rmsAfterM: np ? Math.sqrt(sa / np) : 0, points: np, applied };
}
