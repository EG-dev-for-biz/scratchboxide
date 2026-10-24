/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * How well a candidate shape agrees with the scan, in 3D and for any shape: both surfaces are sampled evenly, and
 *   - coverage is the share of the scan's surface within `tauM` of the candidate (what the candidate explains), and
 *   - precision the share of the candidate's surface within `tauM` of the scan (what of it the scan supports: a wall
 *     standing in air, where the scan has nothing, lowers it).
 * Their harmonic mean (F) ranks candidates. The plan-view check (checkMassing) cannot see a shape that is right from
 * above and wrong in height (a block standing where a needle and its deck are); this can.
 */

import { readGlbScene } from '../../../spatial/StreetViewPoseRegistrar';

export const SURFACE_AGREEMENT_PARAMS = {
    /** Distance within which two surfaces agree (m). */
    tauM: 1.0,
    /** Spacing of the surface samples (m). */
    spacingM: 0.5,
    /** Most samples taken from one surface; the spacing grows to stay under it. */
    maxSamples: 400_000
};

export interface SurfaceAgreement {
    coverage: number; precision: number; f: number;
    /** Median distance from the scan's samples to the candidate (m). */
    medianScanToCandidateM: number;
    /** 90th percentile distance from the candidate's samples to the scan (m): how far its unsupported parts stand off. */
    p90CandidateToScanM: number;
    samples: { scan: number; candidate: number };
}

/** Evenly spaced points on a triangle soup (x, y, z triples), deterministic: about one per spacing². */
export function sampleSurface(positions: ArrayLike<number>, indices: ArrayLike<number>, spacingM: number, maxSamples = SURFACE_AGREEMENT_PARAMS.maxSamples): Float32Array {
    let area = 0;
    const nt = Math.floor(indices.length / 3);
    const areas = new Float64Array(nt);
    for (let t = 0; t < nt; t++) {
        const a = indices[t * 3] * 3, b = indices[t * 3 + 1] * 3, c = indices[t * 3 + 2] * 3;
        const ux = positions[b] - positions[a], uy = positions[b + 1] - positions[a + 1], uz = positions[b + 2] - positions[a + 2];
        const vx = positions[c] - positions[a], vy = positions[c + 1] - positions[a + 1], vz = positions[c + 2] - positions[a + 2];
        areas[t] = 0.5 * Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx);
        area += areas[t];
    }
    const spacing = Math.max(spacingM, Math.sqrt(area / maxSamples));
    const per = 1 / (spacing * spacing);
    const out: number[] = [];
    let carry = 0, k = 0;
    for (let t = 0; t < nt; t++) {
        carry += areas[t] * per;
        const n = Math.floor(carry);
        carry -= n;
        const a = indices[t * 3] * 3, b = indices[t * 3 + 1] * 3, c = indices[t * 3 + 2] * 3;
        for (let j = 0; j < n; j++, k++) {
            // a low-discrepancy point in the triangle (R2 sequence, folded into the triangle)
            let r1 = (0.7548776662 * (k + 1)) % 1, r2 = (0.5698402910 * (k + 1)) % 1;
            if (r1 + r2 > 1) { r1 = 1 - r1; r2 = 1 - r2; }
            for (let q = 0; q < 3; q++) out.push(positions[a + q] + r1 * (positions[b + q] - positions[a + q]) + r2 * (positions[c + q] - positions[a + q]));
        }
    }
    return Float32Array.from(out);
}

/** Every triangle of a GLB (world space) sampled as sampleSurface does. */
export function sampleGlbSurface(glbPath: string, spacingM = SURFACE_AGREEMENT_PARAMS.spacingM, maxSamples = SURFACE_AGREEMENT_PARAMS.maxSamples): Float32Array {
    const prims = readGlbScene(glbPath);
    let nv = 0, ni = 0;
    for (const p of prims) { nv += p.positions.length; ni += p.indices.length; }
    const pos = new Float32Array(nv), idx = new Uint32Array(ni);
    let ov = 0, oi = 0;
    for (const p of prims) {
        pos.set(p.positions, ov);
        for (let i = 0; i < p.indices.length; i++) idx[oi + i] = p.indices[i] + ov / 3;
        ov += p.positions.length; oi += p.indices.length;
    }
    return sampleSurface(pos, idx, spacingM, maxSamples);
}

/** Nearest-neighbour distances from each point of `from` to the points of `to`, capped at `capM` (a uniform grid). */
function nearestDistances(from: Float32Array, to: Float32Array, capM: number): Float32Array {
    const cell = capM, key = (i: number, j: number, k: number) => `${i},${j},${k}`;
    const grid = new Map<string, number[]>();
    for (let p = 0; p < to.length; p += 3) {
        const kk = key(Math.floor(to[p] / cell), Math.floor(to[p + 1] / cell), Math.floor(to[p + 2] / cell));
        let b = grid.get(kk);
        if (!b) grid.set(kk, b = []);
        b.push(p);
    }
    const out = new Float32Array(from.length / 3);
    for (let p = 0, o = 0; p < from.length; p += 3, o++) {
        const x = from[p], y = from[p + 1], z = from[p + 2];
        const i0 = Math.floor(x / cell), j0 = Math.floor(y / cell), k0 = Math.floor(z / cell);
        let best = capM * capM;
        for (let di = -1; di <= 1; di++) for (let dj = -1; dj <= 1; dj++) for (let dk = -1; dk <= 1; dk++) {
            const b = grid.get(key(i0 + di, j0 + dj, k0 + dk));
            if (!b) continue;
            for (const q of b) {
                const dx = to[q] - x, dy = to[q + 1] - y, dz = to[q + 2] - z, d = dx * dx + dy * dy + dz * dz;
                if (d < best) best = d;
            }
        }
        out[o] = Math.sqrt(best);
    }
    return out;
}

const quantile = (v: Float32Array, q: number) => { if (!v.length) return NaN; const s = Float32Array.from(v).sort(); return s[Math.min(s.length - 1, Math.floor(q * s.length))]; };

/** The agreement of a candidate's surface samples with the scan's (both from sampleSurface / sampleGlbSurface). */
export function surfaceAgreement(scan: Float32Array, candidate: Float32Array, tauM = SURFACE_AGREEMENT_PARAMS.tauM): SurfaceAgreement {
    // distances past a few tau only need to be known as far: the cap keeps the grid queries local
    const cap = 4 * tauM;
    const s2c = nearestDistances(scan, candidate, cap), c2s = nearestDistances(candidate, scan, cap);
    let hit = 0;
    for (const d of s2c) if (d <= tauM) hit++;
    const coverage = s2c.length ? hit / s2c.length : 0;
    hit = 0;
    for (const d of c2s) if (d <= tauM) hit++;
    const precision = c2s.length ? hit / c2s.length : 0;
    const f = coverage + precision > 0 ? (2 * coverage * precision) / (coverage + precision) : 0;
    const r3 = (x: number) => Math.round(x * 1000) / 1000;
    return {
        coverage: r3(coverage), precision: r3(precision), f: r3(f),
        medianScanToCandidateM: r3(quantile(s2c, 0.5)), p90CandidateToScanM: r3(quantile(c2s, 0.9)),
        samples: { scan: s2c.length, candidate: c2s.length }
    };
}
