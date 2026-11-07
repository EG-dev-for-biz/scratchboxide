/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * A plausible height for a footprint nobody measured, from the place's own measured footprints (AGENTS.md §4,
 * "a footprint with no measured height gets a plausible one"; docs/research/2026-11-07-architectural-norms.md).
 *
 * The idea is the one the urban-form literature reports (Milojevic-Dupont et al. 2020: footprint area is by far the
 * strongest single predictor, block-scale context next, and a little local data roughly halves the error; Ma et al. 2025:
 * models fitted per homogeneous area beat one global model). Rewritten here as our own, much smaller method, fitted per
 * place on the heights Google's vector data does carry there:
 *
 *   - Every footprint is continuous numbers only: its plan centroid, ln(area) and compactness 4 pi A / P^2. No class,
 *     zoning or roof type is read (ADA §1).
 *   - The estimate is a kernel-weighted geometric mean of the measured heights: each measured footprint weighs
 *     exp(-d^2 / 2 s_d^2) exp(-(dln A)^2 / 2 s_a^2) exp(-(dc)^2 / 2 s_c^2), with the place's median height as a weak prior so
 *     a footprint far from any measurement falls back to the place's typical height, never to a constant.
 *   - The three widths are chosen per place by leave-one-out error on a fixed grid (deterministic: same samples, same
 *     widths, same answer), and the leave-one-out error of the fitted model and of the old constant are both reported.
 *   - The answer carries its 10-90% band and a confidence from the weights' effective sample size and spread; it is
 *     always labelled `generated`, and never replaces a measured height.
 */

import type { Vec2 } from '../../../common/spatial/staged-location-contracts';
import { DIMENSION_RANGES } from '../../../common/spatial/plausibility';

export const HEIGHT_NORM_VERSION = 'height-norm/1';
/** Below this many measured footprints the place has no norm of its own: the caller keeps its plain default. */
export const HEIGHT_NORM_MIN_SAMPLES = 12;
/** At most this many leave-one-out targets per grid cell when fitting (an even, deterministic subsample beyond it). */
export const HEIGHT_NORM_FIT_TARGETS = 400;
/** The widths tried: plan distance (m), ln(area), compactness. Infinity switches a term off. */
export const HEIGHT_NORM_GRID = {
    spaceM: [30, 60, 120, 240, Infinity],
    logArea: [0.35, 0.7, 1.4, Infinity],
    compact: [0.12, 0.25, Infinity]
} as const;
/** The place median's weight as a prior, in units of one perfectly matching neighbour. */
export const HEIGHT_NORM_PRIOR_WEIGHT = 0.05;
/** No estimate below this (a single low storey with its roof). */
export const HEIGHT_NORM_MIN_M = 2.5;

export interface NormFootprint {
    centroid: Vec2;
    areaM2: number;
    perimeterM: number;
}
export interface NormSample extends NormFootprint { heightM: number }

export interface HeightNormSigma { spaceM: number; logArea: number; compact: number }

export interface HeightNormModel {
    version: string;
    samples: NormSample[];
    sigma: HeightNormSigma;
    /** The place's median measured height (the prior). */
    medianM: number;
    /** Leave-one-out mean absolute error of the fitted model over the fitting targets, metres. */
    looMaeM: number;
    /** The same targets' error against `constantM` (the caller's old default), for the record. */
    looMaeConstM: number;
    constantM: number;
    /** Leave-one-out error of the fitted model by measured height band (m): [low, high) and its count. */
    looByBand: Array<{ band: [number, number]; n: number; maeM: number; maeConstM: number }>;
    fitTargets: number;
}

export interface HeightEstimate {
    heightM: number;
    /** The weighted 10% and 90% heights around the estimate. */
    lowM: number;
    highM: number;
    /** Effective number of measured footprints behind the estimate. */
    support: number;
    /** 0..1, never above 0.6: a guess from neighbours is never as sure as a measurement. */
    confidence: number;
}

// ------------------------------------------------------------------------------------------------
// footprint numbers
// ------------------------------------------------------------------------------------------------

/** Area (outer rings less holes, even-odd by nesting is not needed: rings are signed by winding), perimeter and centroid. */
export function footprintNumbers(loops: Vec2[][]): NormFootprint | undefined {
    let area = 0, perim = 0, cx = 0, cz = 0, outer = 0;
    loops.forEach((r, k) => {
        if (r.length < 3) return;
        let a = 0, sx = 0, sz = 0;
        for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
            const c = r[j][0] * r[i][1] - r[i][0] * r[j][1];
            a += c; sx += (r[j][0] + r[i][0]) * c; sz += (r[j][1] + r[i][1]) * c;
            perim += Math.hypot(r[i][0] - r[j][0], r[i][1] - r[j][1]);
        }
        a /= 2;
        // the first loop is the outer ring; the rest are holes taken off whatever their winding
        const s = k === 0 ? 1 : -1;
        area += s * Math.abs(a);
        if (k === 0 && Math.abs(a) > 1e-9) { cx = sx / (6 * a); cz = sz / (6 * a); outer = Math.abs(a); }
    });
    if (!(area > 0) || !(outer > 0) || !(perim > 0)) return undefined;
    return { centroid: [cx, cz], areaM2: area, perimeterM: perim };
}

const compactness = (f: NormFootprint) => Math.min(1, (4 * Math.PI * f.areaM2) / (f.perimeterM * f.perimeterM));

// ------------------------------------------------------------------------------------------------
// the kernel estimate
// ------------------------------------------------------------------------------------------------

interface Prepared { x: number; z: number; la: number; c: number; lh: number }

function prepare(f: NormFootprint, h = 1): Prepared {
    return { x: f.centroid[0], z: f.centroid[1], la: Math.log(f.areaM2), c: compactness(f), lh: Math.log(h) };
}

function weighted(target: Prepared, pool: Prepared[], sigma: HeightNormSigma, priorLh: number, skip = -1): { mu: number; sd: number; neff: number } {
    const kd = Number.isFinite(sigma.spaceM) ? 1 / (2 * sigma.spaceM * sigma.spaceM) : 0;
    const ka = Number.isFinite(sigma.logArea) ? 1 / (2 * sigma.logArea * sigma.logArea) : 0;
    const kc = Number.isFinite(sigma.compact) ? 1 / (2 * sigma.compact * sigma.compact) : 0;
    let sw = HEIGHT_NORM_PRIOR_WEIGHT, sw2 = 0, s1 = HEIGHT_NORM_PRIOR_WEIGHT * priorLh, s2 = HEIGHT_NORM_PRIOR_WEIGHT * priorLh * priorLh;
    for (let j = 0; j < pool.length; j++) {
        if (j === skip) continue;
        const p = pool[j];
        const dx = p.x - target.x, dz = p.z - target.z, da = p.la - target.la, dc = p.c - target.c;
        const e = kd * (dx * dx + dz * dz) + ka * da * da + kc * dc * dc;
        if (e > 30) continue;
        const w = Math.exp(-e);
        sw += w; sw2 += w * w; s1 += w * p.lh; s2 += w * p.lh * p.lh;
    }
    const mu = s1 / sw;
    const sd = Math.sqrt(Math.max(0, s2 / sw - mu * mu));
    const wOnly = sw - HEIGHT_NORM_PRIOR_WEIGHT;
    return { mu, sd, neff: sw2 > 0 ? (wOnly * wOnly) / sw2 : 0 };
}

const BANDS: Array<[number, number]> = [[0, 10], [10, 30], [30, 80], [80, Infinity]];

function median(v: number[]): number {
    const s = v.slice().sort((a, b) => a - b);
    return s.length ? (s.length % 2 ? s[s.length >> 1] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : NaN;
}

/**
 * Fits the place's norm on its measured footprints (undefined below HEIGHT_NORM_MIN_SAMPLES). `constantM` is the default
 * the caller would otherwise use; its leave-one-out error is reported beside the model's.
 */
export function fitHeightNorm(samplesIn: NormSample[], opts: { constantM: number; grid?: typeof HEIGHT_NORM_GRID; fitTargets?: number }): HeightNormModel | undefined {
    const samples = samplesIn.filter(s => Number.isFinite(s.heightM) && s.heightM > 0 && s.areaM2 > 0 && s.perimeterM > 0 && Number.isFinite(s.centroid[0]) && Number.isFinite(s.centroid[1]));
    if (samples.length < HEIGHT_NORM_MIN_SAMPLES) return undefined;
    const pool = samples.map(s => prepare(s, s.heightM));
    const medianM = median(samples.map(s => s.heightM));
    const priorLh = Math.log(medianM);
    const maxT = opts.fitTargets ?? HEIGHT_NORM_FIT_TARGETS;
    const step = Math.max(1, Math.ceil(pool.length / maxT));
    const targets: number[] = [];
    for (let i = 0; i < pool.length; i += step) targets.push(i);
    const grid = opts.grid ?? HEIGHT_NORM_GRID;
    let best: { sigma: HeightNormSigma; mae: number } | undefined;
    for (const spaceM of grid.spaceM) for (const logArea of grid.logArea) for (const compact of grid.compact) {
        const sigma = { spaceM, logArea, compact };
        let err = 0;
        for (const i of targets) err += Math.abs(Math.exp(weighted(pool[i], pool, sigma, priorLh, i).mu) - samples[i].heightM);
        const mae = err / targets.length;
        if (!best || mae < best.mae - 1e-9) best = { sigma, mae };
    }
    const sigma = best!.sigma;
    let errConst = 0;
    const byBand = BANDS.map(band => ({ band, n: 0, e: 0, ec: 0 }));
    for (const i of targets) {
        const h = samples[i].heightM;
        const est = Math.exp(weighted(pool[i], pool, sigma, priorLh, i).mu);
        errConst += Math.abs(opts.constantM - h);
        const b = byBand.find(q => h >= q.band[0] && h < q.band[1])!;
        b.n++; b.e += Math.abs(est - h); b.ec += Math.abs(opts.constantM - h);
    }
    const r2 = (v: number) => Math.round(v * 100) / 100;
    return {
        version: HEIGHT_NORM_VERSION, samples, sigma, medianM: r2(medianM),
        looMaeM: r2(best!.mae), looMaeConstM: r2(errConst / targets.length), constantM: opts.constantM,
        looByBand: byBand.filter(b => b.n).map(b => ({ band: b.band, n: b.n, maeM: r2(b.e / b.n), maeConstM: r2(b.ec / b.n) })),
        fitTargets: targets.length
    };
}

/** The plausible height of an unmeasured footprint under the place's norm, clamped to what any building can be. */
export function estimateHeight(model: HeightNormModel, f: NormFootprint): HeightEstimate {
    const pool = model.samples.map(s => prepare(s, s.heightM));
    return estimateWithPool(model, pool, f);
}

/** As estimateHeight for many footprints, preparing the samples once. */
export function estimateHeights(model: HeightNormModel, fs: NormFootprint[]): HeightEstimate[] {
    const pool = model.samples.map(s => prepare(s, s.heightM));
    return fs.map(f => estimateWithPool(model, pool, f));
}

function estimateWithPool(model: HeightNormModel, pool: Prepared[], f: NormFootprint): HeightEstimate {
    const { mu, sd, neff } = weighted(prepare(f), pool, model.sigma, Math.log(model.medianM));
    const [lo, hi] = DIMENSION_RANGES.buildingHeight.possible;
    const clamp = (v: number) => Math.min(hi, Math.max(Math.max(lo, HEIGHT_NORM_MIN_M), v));
    const z = 1.2816;
    const r1 = (v: number) => Math.round(v * 10) / 10;
    const confidence = Math.min(0.6, 0.2 + 0.4 * Math.min(1, neff / 8) * Math.max(0, 1 - sd / 1.2));
    return { heightM: r1(clamp(Math.exp(mu))), lowM: r1(clamp(Math.exp(mu - z * sd))), highM: r1(clamp(Math.exp(mu + z * sd))), support: Math.round(neff * 10) / 10, confidence: Math.round(confidence * 100) / 100 };
}
