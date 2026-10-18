/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * A second witness for the Street View texels that only one pano saw.
 *
 * Where two panos see a texel, the per-region outlier rejection (texture-seams.ts) outvotes a view that holds something
 * else (a passer-by, a branch, the sky through a misplaced opening). Where one pano is all there is (one view, or several
 * crops of the same pano: same viewpoint, same pose error, same pigeon), nothing outvotes it. The tile photo is a second,
 * independent capture of the same surface: coarse (0.15 m texels) and melted in places, but right about the
 * low-frequency colour. Here the projection's single-pano texels are compared with the tile transfer at the same texel,
 * both low-passed over ~0.3 m and exposure-matched over the layer; where they disagree by more than `maxDeltaE` (CIE76)
 * the single-pano texel is dropped, so the next rung (the tile transfer) colours it, and the count is reported. Texels
 * with no tile surface near them have no witness and stay as they are.
 *
 * Live (Washington Square Arch, run 1ac2b311): a pigeon on the back frieze, the sky on a fitted wedge of the right
 * spandrel and a pale square at the keystone were each one pano's texels (the square from two crops of one pano).
 */

import type { Vec3 } from '../../../common/spatial/staged-location-contracts';
import type { BakedTexturePlanes, UvAtlas } from '../../../common/spatial/texture-pass-contracts';
import { SRGB8_TO_LINEAR } from '../../../common/spatial/photogrammetric-delight';
import { linearToLab } from './texel-exposure';

export const WITNESS_RADIUS_M = 0.2;
export const WITNESS_MAX_DELTA_E = 20;
/** How far from the texel the tile surface may be to act as its witness. */
export const WITNESS_MAX_DISTANCE_M = 0.3;

export interface SinglePanoWitnessReport {
    /** Single-pano texels with a tile witness, and those dropped for disagreeing with it. */
    checked: number;
    rejected: number;
    /** Single-pano texels with no tile surface near (kept unchecked). */
    noWitness: number;
    /** Linear per-channel gain applied to the tile before comparing (median Street View / tile over the texels both cover). */
    gain: Vec3;
}

export interface SinglePanoWitnessOptions { radiusM?: number; maxDeltaE?: number; maxDistanceM?: number }

type Sampler = (position: Vec3, normal: Vec3, maxDistanceM: number) => { rgb: Vec3 } | undefined;

const median = (v: number[]): number => { if (!v.length) return 1; const s = [...v].sort((a, b) => a - b); return s[s.length >> 1]; };

/** Box mean of a 3-channel plane over (2r+1)^2 texels, counting only texels where `mask` is set (normalized convolution). */
function maskedBoxMean(src: Float32Array, mask: Uint8Array, W: number, H: number, r: number): Float32Array {
    const I = new Float64Array((W + 1) * (H + 1) * 4);
    for (let y = 0; y < H; y++) {
        const row = [0, 0, 0, 0];
        for (let x = 0; x < W; x++) {
            const t = y * W + x;
            if (mask[t]) { row[0] += src[t * 3]; row[1] += src[t * 3 + 1]; row[2] += src[t * 3 + 2]; row[3] += 1; }
            const o = ((y + 1) * (W + 1) + x + 1) * 4, u = (y * (W + 1) + x + 1) * 4;
            for (let k = 0; k < 4; k++) I[o + k] = I[u + k] + row[k];
        }
    }
    const out = new Float32Array(W * H * 3).fill(NaN);
    for (let y = 0; y < H; y++) {
        const y0 = Math.max(0, y - r), y1 = Math.min(H, y + r + 1);
        for (let x = 0; x < W; x++) {
            const t = y * W + x;
            if (!mask[t]) continue;
            const x0 = Math.max(0, x - r), x1 = Math.min(W, x + r + 1);
            const a = (y1 * (W + 1) + x1) * 4, b = (y0 * (W + 1) + x1) * 4, c = (y1 * (W + 1) + x0) * 4, d = (y0 * (W + 1) + x0) * 4;
            const n = I[a + 3] - I[b + 3] - I[c + 3] + I[d + 3];
            for (let k = 0; k < 3; k++) out[t * 3 + k] = (I[a + k] - I[b + k] - I[c + k] + I[d + k]) / n;
        }
    }
    return out;
}

/**
 * Drops the single-pano texels of `planes` (a projection bake) that the tile photo contradicts. `tileSample` samples the
 * tile's de-lit sRGB colour at a position and normal (TileTextureSurface.sample); `positions` are where the photos were
 * sampled (the scan's surface under off-scan texels), defaulting to the atlas texels.
 */
export function witnessSinglePano(planes: BakedTexturePlanes, atlas: Pick<UvAtlas, 'width' | 'height' | 'texels'>, tileSample: Sampler,
    opts: SinglePanoWitnessOptions & { positions?: Float32Array } = {}): { planes: BakedTexturePlanes; report: SinglePanoWitnessReport } {
    const W = planes.width, H = planes.height, n = W * H;
    const maxDeltaE = opts.maxDeltaE ?? WITNESS_MAX_DELTA_E, maxDist = opts.maxDistanceM ?? WITNESS_MAX_DISTANCE_M;
    const pos = opts.positions ?? atlas.texels.position, nrm = atlas.texels.normal;
    const singleEntry = planes.provenance.map(p => new Set(p.panoIds ?? []).size <= 1);
    const conf = planes.confidence.data, alb = planes.albedo;
    const single = new Uint8Array(n), both = new Uint8Array(n);
    const sv = new Float32Array(n * 3), tile = new Float32Array(n * 3);
    const sizes: number[] = [];
    let anySingle = false;
    for (let t = 0; t < n; t++) if (conf[t * 4 + 3] && singleEntry[conf[t * 4]]) { single[t] = 1; anySingle = true; }
    const report: SinglePanoWitnessReport = { checked: 0, rejected: 0, noWitness: 0, gain: [1, 1, 1] };
    if (!anySingle) return { planes, report };
    const ratios: number[][] = [[], [], []], ratiosMulti: number[][] = [[], [], []];
    for (let t = 0; t < n; t++) {
        if (!conf[t * 4 + 3]) continue;
        const s = tileSample([pos[t * 3], pos[t * 3 + 1], pos[t * 3 + 2]], [nrm[t * 3], nrm[t * 3 + 1], nrm[t * 3 + 2]], maxDist);
        if (!s) { if (single[t]) report.noWitness++; continue; }
        both[t] = 1;
        if ((t & 15) === 0) sizes.push(atlas.texels.sizeM[t]);
        for (let k = 0; k < 3; k++) {
            const a = SRGB8_TO_LINEAR[alb[t * 4 + k]], b = SRGB8_TO_LINEAR[Math.max(0, Math.min(255, Math.round(s.rgb[k])))];
            sv[t * 3 + k] = a; tile[t * 3 + k] = b;
            if (b > 0.01 && (t & 3) === 0) (single[t] ? ratios : ratiosMulti)[k].push(a / b);
        }
    }
    // exposure: the tile and the photos differ by a gain (another day, another camera); measured where they agree most
    // (the multi-pano texels when there are enough of them)
    const src = ratiosMulti[0].length >= 200 ? ratiosMulti : [0, 1, 2].map(k => [...ratios[k], ...ratiosMulti[k]]);
    report.gain = [median(src[0]), median(src[1]), median(src[2])];
    const labSv = new Float32Array(n * 3), labTile = new Float32Array(n * 3);
    for (let t = 0; t < n; t++) {
        if (!both[t]) continue;
        const a = linearToLab(sv[t * 3], sv[t * 3 + 1], sv[t * 3 + 2]);
        const b = linearToLab(Math.min(1, tile[t * 3] * report.gain[0]), Math.min(1, tile[t * 3 + 1] * report.gain[1]), Math.min(1, tile[t * 3 + 2] * report.gain[2]));
        labSv.set(a, t * 3); labTile.set(b, t * 3);
    }
    sizes.sort((a, b) => a - b);
    const texelM = sizes.length ? sizes[sizes.length >> 1] : 0.05;
    const r = Math.max(1, Math.round((opts.radiusM ?? WITNESS_RADIUS_M) / Math.max(1e-3, texelM)));
    const mSv = maskedBoxMean(labSv, both, W, H, r), mTile = maskedBoxMean(labTile, both, W, H, r);
    // hysteresis (as an edge detector's): texels past maxDeltaE seed a region, which grows through neighbouring single-pano
    // texels past half of it, so the blurred rim of a pigeon or the thin tip of a wedge goes with its core
    const dE = new Float32Array(n);
    for (let t = 0; t < n; t++) {
        if (!single[t] || !both[t]) continue;
        report.checked++;
        dE[t] = Math.hypot(mSv[t * 3] - mTile[t * 3], mSv[t * 3 + 1] - mTile[t * 3 + 1], mSv[t * 3 + 2] - mTile[t * 3 + 2]);
    }
    const drop = new Uint8Array(n);
    const stack: number[] = [];
    for (let t = 0; t < n; t++) if (dE[t] > maxDeltaE) { drop[t] = 1; stack.push(t); }
    while (stack.length) {
        const t = stack.pop()!, x = t % W;
        for (const q of [x > 0 ? t - 1 : -1, x < W - 1 ? t + 1 : -1, t - W, t + W]) {
            if (q < 0 || q >= n || drop[q] || !(dE[q] > maxDeltaE / 2)) continue;
            drop[q] = 1; stack.push(q);
        }
    }
    const albedo = new Uint8Array(alb);
    const data = new Uint8Array(conf);
    for (let t = 0; t < n; t++) {
        if (!drop[t]) continue;
        report.rejected++;
        albedo.fill(0, t * 4, t * 4 + 4);
        data.fill(0, t * 4, t * 4 + 4);
    }
    if (!report.rejected) return { planes, report };
    return { planes: { ...planes, albedo, confidence: { ...planes.confidence, data } }, report };
}
