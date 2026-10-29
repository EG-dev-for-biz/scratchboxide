/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Quality of a shadow lift on the surfaces seen from above, whatever produced it: the photos before the lift and after,
 * judged on the mesh they texture. It knows nothing of suns or of the method (roof-shadow.ts on one building, a district
 * pass on a district), so any lift can be measured the same way and against the same baseline.
 *
 *  1. Samples: on every up-facing triangle (|normal y| over `flatNy`) a cell every `sampleTexels` texels of its photo,
 *     kept when nothing of the mesh stands over it (a filled map from straight above, `aboveMapM`), with its 3D point and
 *     its luminance before and after (log, linear light). A sample is lifted when it rose more than `liftedLog`.
 *  2. The lit reference: per sample, the median luminance of the unlifted samples of the same surface around it (the
 *     `gridM` cells within `refRadiusCells`, height within `sameHeightM`), with at least `minRef` of them.
 *  3. Each lifted sample with a reference is classed, in this order:
 *     - lifted lit: it was not darker than the unlifted surface around it before the lift (`litLog`): lifted where the
 *       photo was lit (a wrong sun or shadow), or next to shade the lift left alone (the patchwork of a per-photo lift:
 *       its unlifted neighbours are as dark as it was). Either way a brightness step the lift made;
 *     - halo: it was darker, and the lift took it past its surface by `haloLog` or more (a scan edge a few centimetres
 *       off the photo's, a vent, a parapet: an over-lift);
 *     - residual: still darker than its lit surface by `residualLog` after the lift (under-lifted, or a dark material);
 *     - good otherwise. Lifted samples with no lit surface around (a terrace wholly in shadow) are unreferenced.
 *     A halo sample is at an edge when an unlifted sample lies within one grid cell.
 *  4. Seams: the photos' mean patch difference (texture-harmonize.ts's measure: `seamM` cells of space, each photo against
 *     the patch's largest), before and after, on all patches and on the patches holding a lifted sample. With
 *     `reharmonize`, the same after texture-harmonize.ts runs on copies of both, for a lift applied after harmonising.
 *  5. From above: the classes on a `gridM` grid (the worst class wins a pixel), with areas, as a picture (shadowLiftQaPng).
 *
 * Nothing is changed: it reads both photo sets and reports.
 */

import type { ParsedGlb } from '../glb-bytes';
import { SRGB8_TO_LINEAR } from '../../../../common/spatial/photogrammetric-delight';
import type { RgbaImage8 } from '../tile-texture-transfer';
import { encodePng } from '../png-encode';
import { harmonizeTextures, TEXEL_NONE } from './texture-harmonize';
import { shadowMap, shadowedAt } from './roof-shadow';
import { collect } from './view-relight';

export const SHADOW_LIFT_QA_VERSION = 'shadow-lift-qa/2';

export const SHADOW_LIFT_QA_PARAMS = {
    /** Samples: one every this many texels; an up-facing triangle has |normal y| above flatNy; the map from above (m), its bias (m). */
    sampleTexels: 2, flatNy: 0.7, aboveMapM: 0.25, aboveBiasM: 0.5,
    /** A sample rose by this (natural log of luminance) is lifted. */
    liftedLog: Math.log(1.03),
    /** The lit reference: grid (m), cells each way, height tolerance (m), least unlifted samples. */
    gridM: 0.5, refRadiusCells: 2, sameHeightM: 0.5, minRef: 8,
    /** Classes against the lit reference (natural log): halo above, lifted lit at or above, residual below. */
    haloLog: Math.log(1.15), litLog: Math.log(1 / 1.1), residualLog: Math.log(1 / 1.25),
    /** Seams: the patch (m). */
    seamM: 1.5
};
export type ShadowLiftQaParams = typeof SHADOW_LIFT_QA_PARAMS;

export interface ShadowLiftQaReport {
    version: string;
    /** Samples on surfaces seen from above, and those lifted. */
    samples: number; lifted: number;
    /** Lifted samples by class, and the halos at an edge. */
    classes: { good: number; halo: number; haloAtEdge: number; liftedLit: number; residual: number; unreferenced: number };
    /** The same from above, m2 (the worst class wins a pixel). */
    areaM2: { lifted: number; good: number; halo: number; liftedLit: number; residual: number; unreferenced: number };
    /** Shares of the referenced lifted samples: halo, lifted lit, residual. */
    shares: { halo: number; liftedLit: number; residual: number };
    /** Median log-luminance step of good lifted samples against their lit surface, before and after (0: evened out). */
    stepBefore: number | null; stepAfter: number | null;
    /** Mean patch difference between photos (log colour): all patches and those holding a lifted sample, before and after. */
    seams: { pairs: number; before: number; after: number; liftedPairs: number; liftedBefore: number; liftedAfter: number;
        /** After texture-harmonize.ts on copies of both (only with reharmonize). */
        harmonizedBefore?: number; harmonizedAfter?: number };
    ms: number;
    grid?: { cellM: number; x0: number; z0: number; w: number; h: number; classes: Uint8Array };
}

/** Classes on the grid, in the order a pixel two share takes the worse (0: no lifted sample). */
const Q_GOOD = 1, Q_UNREF = 2, Q_RESIDUAL = 3, Q_LIFTED_LIT = 4, Q_HALO = 5;

const lumLog = (img: RgbaImage8, i: number) => 0.2126 * Math.log(1e-4 + SRGB8_TO_LINEAR[img.rgba[i * 4]]) + 0.7152 * Math.log(1e-4 + SRGB8_TO_LINEAR[img.rgba[i * 4 + 1]]) + 0.0722 * Math.log(1e-4 + SRGB8_TO_LINEAR[img.rgba[i * 4 + 2]]);
const median = (a: number[]) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };

/** Mean patch difference between photos over the samples (each photo in a patch against the patch's largest). */
function seamDiff(n: number, img: Int32Array, key: Int32Array, colour: (i: number, c: number) => number, only?: Uint8Array): { pairs: number; diff: number } {
    const patches = new Map<number, Map<number, number[]>>();
    for (let i = 0; i < n; i++) {
        let m = patches.get(key[i]); if (!m) patches.set(key[i], (m = new Map()));
        const l = m.get(img[i]); if (l) l.push(i); else m.set(img[i], [i]);
    }
    let s = 0, wt = 0, pairs = 0;
    for (const [k, m] of patches) {
        if (m.size < 2 || (only && !only[k])) continue;
        const groups = [...m.values()].sort((a, b) => b.length - a.length);
        const mean = (g: number[]) => [0, 1, 2].map(c => g.reduce((a, i) => a + colour(i, c), 0) / g.length);
        const m0 = mean(groups[0]);
        for (let j = 1; j < groups.length; j++) {
            const mj = mean(groups[j]), w = Math.min(groups[0].length, groups[j].length);
            for (let c = 0; c < 3; c++) { s += w * Math.abs(m0[c] - mj[c]); wt += w; }
            pairs++;
        }
    }
    return { pairs, diff: wt ? s / wt : 0 };
}

/**
 * Judges the lift that turned `before` into `after` (photos by image index, the GLB's base-colour images) on the mesh of
 * `g`/`json`. `surfaces` (texture-harmonize.ts surfaceClassMasks) skips texels no triangle uses; `groundY` is only for
 * re-harmonising.
 */
export function evaluateShadowLift(g: ParsedGlb, json: any, before: Map<number, RgbaImage8>, after: Map<number, RgbaImage8>, opts: { surfaces?: Map<number, Uint8Array>; groundY?: number; reharmonize?: boolean; params?: Partial<ShadowLiftQaParams> } = {}): ShadowLiftQaReport {
    const P = { ...SHADOW_LIFT_QA_PARAMS, ...(opts.params ?? {}) };
    const t0 = Date.now();
    const soup = collect(g, json);
    const report: ShadowLiftQaReport = {
        version: SHADOW_LIFT_QA_VERSION, samples: 0, lifted: 0,
        classes: { good: 0, halo: 0, haloAtEdge: 0, liftedLit: 0, residual: 0, unreferenced: 0 },
        areaM2: { lifted: 0, good: 0, halo: 0, liftedLit: 0, residual: 0, unreferenced: 0 },
        shares: { halo: 0, liftedLit: 0, residual: 0 }, stepBefore: null, stepAfter: null,
        seams: { pairs: 0, before: 0, after: 0, liftedPairs: 0, liftedBefore: 0, liftedAfter: 0 }, ms: 0
    };
    if (!soup.n) { report.ms = Date.now() - t0; return report; }
    const above = shadowMap(soup, 0, 89.9, P.aboveMapM);

    // 1: samples on surfaces seen from above
    const S = P.sampleTexels;
    const xs: number[] = [], ys: number[] = [], zs: number[] = [], ims: number[] = [], lb: number[] = [], la: number[] = [], tex: number[] = [];
    const taken = new Map<number, Set<number>>();
    for (let t = 0; t < soup.n; t++) {
        const im = soup.img[t];
        if (im < 0 || Math.abs(soup.N[t * 3 + 1]) < P.flatNy) continue;
        const b = before.get(im), a = after.get(im);
        if (!b || !a || a.width !== b.width || a.height !== b.height) continue;
        const mask = opts.surfaces?.get(im), W = b.width, H = b.height;
        let seen = taken.get(im); if (!seen) taken.set(im, (seen = new Set()));
        const q = t * 6, p = t * 9;
        const ax = (soup.UV[q] * W) / S, ay = (soup.UV[q + 1] * H) / S, bx = (soup.UV[q + 2] * W) / S, by = (soup.UV[q + 3] * H) / S, cx = (soup.UV[q + 4] * W) / S, cy = (soup.UV[q + 5] * H) / S;
        const det = (bx - ax) * (cy - ay) - (cx - ax) * (by - ay);
        if (Math.abs(det) < 1e-12) continue;
        const gw = Math.ceil(W / S);
        for (let gy = Math.max(0, Math.floor(Math.min(ay, by, cy))); gy <= Math.min(Math.ceil(H / S) - 1, Math.ceil(Math.max(ay, by, cy))); gy++)
            for (let gx = Math.max(0, Math.floor(Math.min(ax, bx, cx))); gx <= Math.min(gw - 1, Math.ceil(Math.max(ax, bx, cx))); gx++) {
                const px = gx + 0.5, py = gy + 0.5;
                const b1 = ((px - ax) * (cy - ay) - (cx - ax) * (py - ay)) / det, b2 = ((bx - ax) * (py - ay) - (px - ax) * (by - ay)) / det, b0 = 1 - b1 - b2;
                if (b0 < 0 || b1 < 0 || b2 < 0) continue;
                const k = gy * gw + gx;
                if (seen.has(k)) continue;
                const tx = Math.min(W - 1, Math.floor(px * S)), ty = Math.min(H - 1, Math.floor(py * S)), i = ty * W + tx;
                if (mask && mask[i] === TEXEL_NONE) continue;
                const x = b0 * soup.P[p] + b1 * soup.P[p + 3] + b2 * soup.P[p + 6], y = b0 * soup.P[p + 1] + b1 * soup.P[p + 4] + b2 * soup.P[p + 7], z = b0 * soup.P[p + 2] + b1 * soup.P[p + 5] + b2 * soup.P[p + 8];
                if (shadowedAt(above, x, y, z, P.aboveBiasM)) continue;
                seen.add(k);
                xs.push(x); ys.push(y); zs.push(z); ims.push(im); tex.push(i);
                lb.push(lumLog(b, i)); la.push(lumLog(a, i));
            }
    }
    const n = xs.length;
    report.samples = n;
    if (!n) { report.ms = Date.now() - t0; return report; }

    // 2: the grid, and each cell's unlifted samples
    let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
    for (let i = 0; i < n; i++) { x0 = Math.min(x0, xs[i]); x1 = Math.max(x1, xs[i]); z0 = Math.min(z0, zs[i]); z1 = Math.max(z1, zs[i]); }
    const c = P.gridM, w = Math.ceil((x1 - x0) / c) + 1, h = Math.ceil((z1 - z0) / c) + 1;
    const cellOf = (i: number) => Math.floor((zs[i] - z0) / c) * w + Math.floor((xs[i] - x0) / c);
    const lifted = new Uint8Array(n);
    const unlifted = new Map<number, number[]>();
    for (let i = 0; i < n; i++) {
        if (la[i] - lb[i] > P.liftedLog) { lifted[i] = 1; report.lifted++; continue; }
        const k = cellOf(i), l = unlifted.get(k); if (l) l.push(i); else unlifted.set(k, [i]);
    }

    // 3: classes
    const grid = new Uint8Array(w * h);
    const stepB: number[] = [], stepA: number[] = [];
    for (let i = 0; i < n; i++) {
        if (!lifted[i]) continue;
        const cx = Math.floor((xs[i] - x0) / c), cz = Math.floor((zs[i] - z0) / c);
        const ref: number[] = [];
        let edge = false;
        for (let dz = -P.refRadiusCells; dz <= P.refRadiusCells; dz++) for (let dx = -P.refRadiusCells; dx <= P.refRadiusCells; dx++) {
            const l = unlifted.get((cz + dz) * w + (cx + dx));
            if (!l) continue;
            for (const j of l) if (Math.abs(ys[j] - ys[i]) <= P.sameHeightM) { ref.push(la[j]); if (Math.abs(dx) <= 1 && Math.abs(dz) <= 1) edge = true; }
        }
        let cls: number;
        if (ref.length < P.minRef) { cls = Q_UNREF; report.classes.unreferenced++; }
        else {
            const r = median(ref);
            if (lb[i] - r >= P.litLog) { cls = Q_LIFTED_LIT; report.classes.liftedLit++; }
            else if (la[i] - r > P.haloLog) { cls = Q_HALO; report.classes.halo++; if (edge) report.classes.haloAtEdge++; }
            else if (la[i] - r < P.residualLog) { cls = Q_RESIDUAL; report.classes.residual++; }
            else { cls = Q_GOOD; report.classes.good++; stepB.push(r - lb[i]); stepA.push(r - la[i]); }
        }
        const g2 = cz * w + cx;
        if (cls > grid[g2]) grid[g2] = cls;
    }
    const referenced = report.classes.good + report.classes.halo + report.classes.liftedLit + report.classes.residual;
    if (referenced) report.shares = { halo: +(report.classes.halo / referenced).toFixed(4), liftedLit: +(report.classes.liftedLit / referenced).toFixed(4), residual: +(report.classes.residual / referenced).toFixed(4) };
    if (stepB.length) { report.stepBefore = +median(stepB).toFixed(4); report.stepAfter = +median(stepA).toFixed(4); }
    const area = [0, 0, 0, 0, 0, 0];
    for (let k = 0; k < w * h; k++) area[grid[k]] += c * c;
    report.areaM2 = { lifted: Math.round(area.slice(1).reduce((a, b) => a + b, 0)), good: Math.round(area[Q_GOOD]), halo: Math.round(area[Q_HALO]), liftedLit: Math.round(area[Q_LIFTED_LIT]), residual: Math.round(area[Q_RESIDUAL]), unreferenced: Math.round(area[Q_UNREF]) };
    report.grid = { cellM: c, x0, z0, w, h, classes: grid };

    // 4: seams, before and after, all patches and lifted ones
    const imgA = Int32Array.from(ims), key = new Int32Array(n), patchKeys = new Map<string, number>();
    for (let i = 0; i < n; i++) {
        const k = `${Math.floor(xs[i] / P.seamM)},${Math.floor(ys[i] / P.seamM)},${Math.floor(zs[i] / P.seamM)}`;
        let v = patchKeys.get(k); if (v === undefined) { v = patchKeys.size; patchKeys.set(k, v); }
        key[i] = v;
    }
    const liftedPatch = new Uint8Array(patchKeys.size);
    for (let i = 0; i < n; i++) if (lifted[i]) liftedPatch[key[i]] = 1;
    const colourOf = (set: Map<number, RgbaImage8>) => (i: number, ch: number) => Math.log(1e-4 + SRGB8_TO_LINEAR[set.get(ims[i])!.rgba[tex[i] * 4 + ch]]);
    const sb = seamDiff(n, imgA, key, colourOf(before)), sa = seamDiff(n, imgA, key, colourOf(after));
    const lbS = seamDiff(n, imgA, key, colourOf(before), liftedPatch), laS = seamDiff(n, imgA, key, colourOf(after), liftedPatch);
    report.seams = { pairs: sb.pairs, before: +sb.diff.toFixed(4), after: +sa.diff.toFixed(4), liftedPairs: lbS.pairs, liftedBefore: +lbS.diff.toFixed(4), liftedAfter: +laS.diff.toFixed(4) };
    if (opts.reharmonize) {
        const hb = harmonizeTextures(g, json, new Map(before), opts.groundY ?? 0, undefined, opts.surfaces);
        const ha = harmonizeTextures(g, json, new Map(after), opts.groundY ?? 0, undefined, opts.surfaces);
        report.seams.harmonizedBefore = hb.seams.after; report.seams.harmonizedAfter = ha.seams.after;
    }
    report.ms = Date.now() - t0;
    return report;
}

/** The QA from above as a PNG (rows along the model's +z): good green, unreferenced blue, residual cyan, lifted lit magenta, halo red. */
export function shadowLiftQaPng(grid: NonNullable<ShadowLiftQaReport['grid']>): Uint8Array {
    const colours: Array<[number, number, number]> = [[235, 235, 235], [40, 170, 70], [60, 90, 220], [40, 200, 210], [210, 40, 200], [230, 30, 30]];
    const rgba = new Uint8Array(grid.w * grid.h * 4);
    for (let k = 0; k < grid.w * grid.h; k++) { const [r, gg, b] = colours[grid.classes[k]]; rgba[k * 4] = r; rgba[k * 4 + 1] = gg; rgba[k * 4 + 2] = b; rgba[k * 4 + 3] = 255; }
    return new Uint8Array(encodePng(grid.w, grid.h, rgba, 4));
}

/** The numbers a lift is compared on against a baseline (the ESB's per-building lift): any lift method, the same keys. */
export interface ShadowLiftQaBaseline { liftedM2: number; haloShare: number; liftedLitShare: number; seamsAfterAll: number; seamsAfterLifted: number; stepAfter: number | null }

/**
 * The regression baseline: the per-building lift (roof-shadow/9) on the Empire State Building's pipeline K twin, live run
 * 651b85ee (2026-10-29), judged before harmonising. Any lift method run on the ESB should meet it (compareToBaseline).
 */
export const ESB_SHADOW_LIFT_BASELINE: ShadowLiftQaBaseline = {
    liftedM2: 2891, haloShare: 0.1117, liftedLitShare: 0.3272, seamsAfterAll: 0.5908, seamsAfterLifted: 0.6064, stepAfter: 0.0507
};

export function qaBaselineOf(r: ShadowLiftQaReport): ShadowLiftQaBaseline {
    return { liftedM2: r.areaM2.lifted, haloShare: r.shares.halo, liftedLitShare: r.shares.liftedLit, seamsAfterAll: r.seams.after, seamsAfterLifted: r.seams.liftedAfter, stepAfter: r.stepAfter === null ? null : Math.abs(r.stepAfter) };
}

/** Each measure against the baseline: met (at least as good, within its tolerance) or worse, with the numbers. */
export function compareToBaseline(r: ShadowLiftQaReport, base: ShadowLiftQaBaseline): Array<{ measure: string; value: number | null; baseline: number | null; met: boolean }> {
    const b = qaBaselineOf(r);
    const row = (measure: string, value: number | null, baseline: number | null, better: 'higher' | 'lower', tol: number) => ({
        measure, value, baseline, met: value === null || baseline === null ? baseline === null : better === 'higher' ? value >= baseline * (1 - tol) : value <= baseline * (1 + tol) + 1e-4
    });
    return [
        row('lifted area (m2)', b.liftedM2, base.liftedM2, 'higher', 0.1),
        row('halo share', b.haloShare, base.haloShare, 'lower', 0.1),
        row('lifted-lit share', b.liftedLitShare, base.liftedLitShare, 'lower', 0.1),
        row('photo seams after, all patches', b.seamsAfterAll, base.seamsAfterAll, 'lower', 0.02),
        row('photo seams after, lifted patches', b.seamsAfterLifted, base.seamsAfterLifted, 'lower', 0.02),
        row('step left to the lit surface (log)', b.stepAfter, base.stepAfter, 'lower', 0.1)
    ];
}
