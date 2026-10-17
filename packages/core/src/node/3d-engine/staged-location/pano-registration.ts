/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Pose registration from corresponding image boxes.
 *
 * A Street View pano's metadata position is good to a few metres and its heading to a degree or two, so a box cast through the
 * nominal pose lands a few metres from where the thing stands. The same element seen from a second pano is a second ray at
 * the same place: where the two disagree, the poses are wrong. Each pano's eye shift (x, z) and yaw are solved so that the
 * rays through the corresponding boxes agree on the fitted faces (a ray cast onto the face it hits; where a ray misses every
 * face the closest approach of the two rays is used), with a weak prior that keeps the shifts as small as the data allows.
 * The scan stays the authority on length: this places things, it does not size them.
 *
 * What it returns says plainly how well it did: the disagreement before and after, per correspondence, and the position each
 * pair triangulates to.
 */

import type { Vec3 } from '../../../common/spatial/staged-location-contracts';
import { ZERO_CORRECTION, type PoseCorrection } from '../../spatial/StreetViewPoseRegistrar';
import { boxPixels, castCamera, castRay, pixelRay, type CastFace, type CastView } from './survey-casting';

export type Box1000 = [number, number, number, number];
export interface RegView extends CastView { panoId: string }
export interface Correspondence {
    id: string;
    a: { view: RegView; box: Box1000 };
    b: { view: RegView; box: Box1000 };
}

/** How well one box edge/centre can be placed in the image by the vision model: about 1% of the frame. */
export const BOX_PLACEMENT_SIGMA_M = 0.35;
export const POSE_PRIOR_SIGMA = { meters: 2, degrees: 2 } as const;
/** A pair further apart than this before the fit is a wrong match, not a pose error. */
export const MAX_PRIOR_DISAGREEMENT_M = 18;

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const len = (a: Vec3) => Math.hypot(a[0], a[1], a[2]);

/** Closest approach of two rays: the midpoint, the gap, the angle between them and whether both points lie ahead. */
export function triangulate(a: { origin: Vec3; dir: Vec3 }, b: { origin: Vec3; dir: Vec3 }): { point: Vec3; gapM: number; angleDeg: number; ahead: boolean; ok: boolean } {
    const w0 = sub(a.origin, b.origin);
    const A = dot(a.dir, a.dir), B = dot(a.dir, b.dir), C = dot(b.dir, b.dir), D = dot(a.dir, w0), E = dot(b.dir, w0);
    const den = A * C - B * B;
    const angleDeg = Math.acos(Math.max(-1, Math.min(1, B / Math.sqrt(A * C)))) * 180 / Math.PI;
    if (den < 1e-9) return { point: [0, 0, 0], gapM: 0, angleDeg, ahead: false, ok: false };
    const s = (B * E - C * D) / den, t = (A * E - B * D) / den;
    const pa: Vec3 = [a.origin[0] + a.dir[0] * s, a.origin[1] + a.dir[1] * s, a.origin[2] + a.dir[2] * s];
    const pb: Vec3 = [b.origin[0] + b.dir[0] * t, b.origin[1] + b.dir[1] * t, b.origin[2] + b.dir[2] * t];
    return { point: [(pa[0] + pb[0]) / 2, (pa[1] + pb[1]) / 2, (pa[2] + pb[2]) / 2], gapM: len(sub(pa, pb)), angleDeg, ahead: s > 0 && t > 0, ok: true };
}

function samples(box: Box1000, v: CastView): Array<{ x: number; y: number; w: number }> {
    const b = boxPixels(box, v.widthPx, v.heightPx);
    return [
        { x: (b.x0 + b.x1) / 2, y: (b.y0 + b.y1) / 2, w: 1 },
        { x: b.x0, y: b.y0, w: 0.5 }, { x: b.x1, y: b.y0, w: 0.5 }, { x: b.x1, y: b.y1, w: 0.5 }, { x: b.x0, y: b.y1, w: 0.5 }
    ];
}

type Corrections = Map<string, PoseCorrection>;
const withCorr = (v: RegView, c: Corrections): CastView => ({ ...v, correction: c.get(v.panoId) ?? ZERO_CORRECTION });

/** The disagreement vectors (metres) of one correspondence, one per sample point, weighted. */
function disagreement(c: Correspondence, corr: Corrections, faces: CastFace[]): Array<{ v: Vec3; w: number; point?: Vec3 }> {
    const camA = castCamera(withCorr(c.a.view, corr)), camB = castCamera(withCorr(c.b.view, corr));
    const sa = samples(c.a.box, c.a.view), sb = samples(c.b.box, c.b.view);
    const out: Array<{ v: Vec3; w: number; point?: Vec3 }> = [];
    for (let k = 0; k < sa.length; k++) {
        const ra = pixelRay(camA, sa[k].x, sa[k].y), rb = pixelRay(camB, sb[k].x, sb[k].y);
        const ha = castRay(ra, faces, 0.5), hb = castRay(rb, faces, 0.5);
        if (ha && hb && ha.faceId === hb.faceId) {
            out.push({ v: sub(ha.point, hb.point), w: sa[k].w, point: [(ha.point[0] + hb.point[0]) / 2, (ha.point[1] + hb.point[1]) / 2, (ha.point[2] + hb.point[2]) / 2] });
        } else {
            const t = triangulate(ra, rb);
            out.push(t.ok && t.ahead ? { v: [t.gapM, 0, 0] as Vec3, w: sa[k].w * 0.5, point: t.point } : { v: [0, 0, 0] as Vec3, w: 0 });
        }
    }
    return out;
}

export interface PairReport {
    id: string;
    /** Distance between the two views' points on the face, after the fit (the rays' gap where they missed the faces), metres. */
    residualM: number;
    beforeM: number;
    /** The triangulated place (the two rays' closest approach), tile frame. Absent when the rays are parallel or diverge. */
    triangulated?: { point: Vec3; gapM: number; angleDeg: number; baselineM: number };
    used: boolean;
}

export interface Registration {
    corrections: Corrections;
    perPano: Array<{ panoId: string; dxM: number; dzM: number; dyawDeg: number; pairs: number }>;
    pairs: PairReport[];
    /** RMS disagreement of the used pairs before and after the fit, metres. */
    beforeRmsM: number;
    afterRmsM: number;
    used: number;
    rejected: number;
}

function rmsPair(c: Correspondence, corr: Corrections, faces: CastFace[]): number {
    const d = disagreement(c, corr, faces);
    let s = 0, w = 0;
    for (const x of d) { if (x.w <= 0.05) continue; s += x.w * (x.v[0] ** 2 + x.v[1] ** 2 + x.v[2] ** 2); w += x.w; }
    return w > 0 ? Math.sqrt(s / w) : Infinity;
}

function solve(A: number[][], b: number[]): number[] {
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

/** A pano position is good to a few metres and its heading to a degree or two: a solved shift past 2.5 sigma of that is a bad match, not a pose. */
export const MAX_PLAUSIBLE_SHIFT_M = 5;
export const MAX_PLAUSIBLE_YAW_DEG = 5;

/** Solves the poses; a pano whose solved shift is implausible is set aside (with the pairs that name it) and the rest are solved again. */
export function registerPanos(corrs: Correspondence[], faces: CastFace[], opts: { iterations?: number } = {}): Registration {
    let set = corrs;
    for (let round = 0; round < 4; round++) {
        const r = solvePanos(set, faces, opts);
        const bad = r.perPano.filter(p => Math.hypot(p.dxM, p.dzM) > MAX_PLAUSIBLE_SHIFT_M || Math.abs(p.dyawDeg) > MAX_PLAUSIBLE_YAW_DEG).map(p => p.panoId);
        if (!bad.length) return corrs === set ? r : { ...r, pairs: [...r.pairs, ...corrs.filter(c => !set.includes(c)).map(c => ({ id: c.id, residualM: Infinity, beforeM: Infinity, used: false }))], rejected: r.rejected + (corrs.length - set.length) };
        set = set.filter(c => !bad.includes(c.a.view.panoId) && !bad.includes(c.b.view.panoId));
    }
    return solvePanos(set, faces, opts);
}

function solvePanos(corrs: Correspondence[], faces: CastFace[], opts: { iterations?: number } = {}): Registration {
    const nominal: Corrections = new Map();
    const before = corrs.map(c => rmsPair(c, nominal, faces));
    // wrong matches (the same word on a different thing) are not pose errors
    const keep = corrs.filter((_, i) => before[i] <= MAX_PRIOR_DISAGREEMENT_M);
    const panoIds = [...new Set(keep.flatMap(c => [c.a.view.panoId, c.b.view.panoId]))].sort();
    const P = panoIds.length;
    const idx = new Map(panoIds.map((id, i) => [id, i]));
    const toCorr = (x: number[]): Corrections => {
        const m: Corrections = new Map();
        panoIds.forEach((id, i) => m.set(id, { ...ZERO_CORRECTION, dx: x[3 * i], dz: x[3 * i + 1], dyawDeg: x[3 * i + 2] }));
        return m;
    };
    const residuals = (x: number[], set: Correspondence[]): number[] => {
        const corr = toCorr(x);
        const r: number[] = [];
        for (const c of set) for (const d of disagreement(c, corr, faces)) {
            const w = Math.sqrt(d.w) / BOX_PLACEMENT_SIGMA_M;
            r.push(d.v[0] * w, d.v[1] * w, d.v[2] * w);
        }
        for (let i = 0; i < P; i++) r.push(x[3 * i] / POSE_PRIOR_SIGMA.meters, x[3 * i + 1] / POSE_PRIOR_SIGMA.meters, x[3 * i + 2] / POSE_PRIOR_SIGMA.degrees);
        return r;
    };
    const fit = (set: Correspondence[], x0: number[]): number[] => {
        let x = x0.slice();
        let lambda = 1;
        let r = residuals(x, set);
        let cost = r.reduce((s, v) => s + v * v, 0);
        const steps = [0.05, 0.05, 0.05];
        for (let it = 0; it < (opts.iterations ?? 25); it++) {
            const J: number[][] = r.map(() => new Array<number>(3 * P).fill(0));
            for (let j = 0; j < 3 * P; j++) {
                const xp = x.slice(); xp[j] += steps[j % 3];
                const xm = x.slice(); xm[j] -= steps[j % 3];
                const rp = residuals(xp, set), rm = residuals(xm, set);
                for (let i = 0; i < r.length; i++) J[i][j] = (rp[i] - rm[i]) / (2 * steps[j % 3]);
            }
            const H: number[][] = Array.from({ length: 3 * P }, () => new Array<number>(3 * P).fill(0));
            const g = new Array<number>(3 * P).fill(0);
            for (let i = 0; i < r.length; i++) for (let a = 0; a < 3 * P; a++) { g[a] += J[i][a] * r[i]; for (let b = 0; b < 3 * P; b++) H[a][b] += J[i][a] * J[i][b]; }
            let improved = false;
            for (let tries = 0; tries < 8 && !improved; tries++) {
                const Hl = H.map((row, a) => row.map((v, b) => v + (a === b ? lambda * (v || 1) : 0)));
                const delta = solve(Hl, g.map(v => -v));
                const xn = x.map((v, i) => v + delta[i]);
                const rn = residuals(xn, set);
                const cn = rn.reduce((s, v) => s + v * v, 0);
                if (cn < cost) { x = xn; r = rn; improved = cn < cost - 1e-9; cost = cn; lambda = Math.max(1e-4, lambda / 3); improved = true; } else lambda *= 4;
            }
            if (!improved) break;
        }
        return x;
    };
    let x = new Array<number>(3 * P).fill(0);
    let used = keep;
    if (P && keep.length) {
        x = fit(used, x);
        // a second pass without the pairs that still disagree by more than three times the median: they were matches of the wrong thing
        const corr1 = toCorr(x);
        const after1 = used.map(c => rmsPair(c, corr1, faces)).filter(Number.isFinite).sort((a, b) => a - b);
        const med = after1.length ? after1[Math.floor(after1.length / 2)] : 0;
        const cut = Math.max(3 * med, 1.5);
        const inliers = used.filter(c => rmsPair(c, corr1, faces) <= cut);
        if (inliers.length < used.length && inliers.length >= Math.max(1, Math.floor(used.length / 2))) { used = inliers; x = fit(used, x); }
    }
    const corrections = toCorr(x);
    const usedIds = new Set(used.map(c => c.id));
    const pairs: PairReport[] = corrs.map((c, i) => {
        const camA = castCamera(withCorr(c.a.view, corrections)), camB = castCamera(withCorr(c.b.view, corrections));
        const sa = samples(c.a.box, c.a.view)[0], sb = samples(c.b.box, c.b.view)[0];
        const t = triangulate(pixelRay(camA, sa.x, sa.y), pixelRay(camB, sb.x, sb.y));
        const baselineM = len(sub(camA.eye, camB.eye));
        return {
            id: c.id, residualM: Math.round(rmsPair(c, corrections, faces) * 1000) / 1000, beforeM: Math.round(before[i] * 1000) / 1000,
            ...(t.ok && t.ahead ? { triangulated: { point: t.point, gapM: Math.round(t.gapM * 1000) / 1000, angleDeg: Math.round(t.angleDeg * 10) / 10, baselineM: Math.round(baselineM * 100) / 100 } } : {}),
            used: usedIds.has(c.id)
        };
    });
    const rmsOf = (vals: number[]) => (vals.length ? Math.sqrt(vals.reduce((s, v) => s + v * v, 0) / vals.length) : 0);
    const usedPairs = pairs.filter(p => p.used && Number.isFinite(p.residualM));
    const perPano = panoIds.map((id, i) => ({
        panoId: id, dxM: Math.round(x[3 * i] * 1000) / 1000, dzM: Math.round(x[3 * i + 1] * 1000) / 1000, dyawDeg: Math.round(x[3 * i + 2] * 100) / 100,
        pairs: used.filter(c => c.a.view.panoId === id || c.b.view.panoId === id).length
    }));
    void idx;
    return {
        corrections, perPano, pairs, used: used.length, rejected: corrs.length - used.length,
        beforeRmsM: Math.round(rmsOf(usedPairs.map(p => p.beforeM)) * 1000) / 1000, afterRmsM: Math.round(rmsOf(usedPairs.map(p => p.residualM)) * 1000) / 1000
    };
}
