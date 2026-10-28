/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Window scoring: fitted windows against a checked set, on a crop of a facade photo, in that photo's pixels. For any window
 * fit (the app's window-fit.ts, a prototype, another detector), any facade, any checked set:
 *  - pixel scores: the fitted and the checked windows rasterised in the crop; IoU, precision (the share of fitted pixels that
 *    are window) and recall (the share of window pixels fitted);
 *  - window counts: a checked window is found when a fitted window overlaps it by IoU matchIoU or covers coverShare of it
 *    (a bay holding windows still finds them); a fitted window is correct when it does the same for some checked window;
 *  - edge error (px): for each checked window and the fitted window that are each other's best match (IoU at least
 *    matchIoU), how far each of the four fitted edges lies from the checked one. A checked edge on the crop's border is not
 *    an edge (the window runs on past the crop) and is left out.
 * Rects are [x0, y0, x1, y1] in crop pixels, y down, x1 and y1 exclusive.
 *
 * Two things are scored, from separate checked sets: windows (each opening) against the fitted windows, and bays (the long
 * run of window columns between two piers that the relief recesses, facade-lattice.ts windowStrips) against the bays drawn
 * from those windows. A good bay score with a poor window score still gives the right relief.
 */

export type WindowRect = [number, number, number, number];

export const WINDOW_SCORE = { matchIoU: 0.3, coverShare: 0.5 };
export type WindowScoreParams = typeof WINDOW_SCORE;

export interface EdgeStats { n: number; meanPx: number; medianPx: number; p90Px: number; maxPx: number }

export interface WindowScore {
    pixel: { iou: number; precision: number; recall: number; fittedPx: number; checkedPx: number };
    /** Checked windows found, of checked; fitted windows correct, of fitted. */
    found: number; checked: number; correct: number; fitted: number;
    /** Edge error over every matched pair's edges, and per side. */
    edges: EdgeStats & { bySide: Record<'left' | 'top' | 'right' | 'bottom', EdgeStats> };
    /** Matched pairs: indices into checked and fitted, their IoU, and the fitted edges' signed offsets (px; NaN on a crop border). */
    pairs: Array<{ checked: number; fitted: number; iou: number; offsetPx: [number, number, number, number] }>;
}

export function rectIoU(a: WindowRect, b: WindowRect): number {
    const ix = Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0])), iy = Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));
    const i = ix * iy, u = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - i;
    return u > 0 ? i / u : 0;
}

/** The share of `a` that `b` covers. */
function covers(a: WindowRect, b: WindowRect): number {
    const ix = Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0])), iy = Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));
    const area = (a[2] - a[0]) * (a[3] - a[1]);
    return area > 0 ? (ix * iy) / area : 0;
}

function edgeStats(v: number[]): EdgeStats {
    if (!v.length) return { n: 0, meanPx: NaN, medianPx: NaN, p90Px: NaN, maxPx: NaN };
    const s = [...v].sort((a, b) => a - b), q = (p: number) => s[Math.min(s.length - 1, Math.floor(p * s.length))];
    return { n: v.length, meanPx: v.reduce((a, b) => a + b, 0) / v.length, medianPx: q(0.5), p90Px: q(0.9), maxPx: s[s.length - 1] };
}

/** Clips rects to the crop (width x height), dropping any left empty. */
export function clipRects(rects: WindowRect[], width: number, height: number): WindowRect[] {
    return rects.map(r => [Math.max(0, r[0]), Math.max(0, r[1]), Math.min(width, r[2]), Math.min(height, r[3])] as WindowRect).filter(r => r[2] > r[0] && r[3] > r[1]);
}

export function scoreWindows(fittedIn: WindowRect[], checked: WindowRect[], width: number, height: number, P: WindowScoreParams = WINDOW_SCORE): WindowScore {
    const fitted = clipRects(fittedIn, width, height);
    // pixel scores
    const raster = (rects: WindowRect[]) => {
        const m = new Uint8Array(width * height);
        for (const r of rects) for (let y = Math.max(0, Math.floor(r[1])); y < Math.min(height, Math.ceil(r[3])); y++) for (let x = Math.max(0, Math.floor(r[0])); x < Math.min(width, Math.ceil(r[2])); x++) m[y * width + x] = 1;
        return m;
    };
    const fm = raster(fitted), gm = raster(checked);
    let both = 0, f = 0, g = 0;
    for (let i = 0; i < fm.length; i++) { both += fm[i] & gm[i]; f += fm[i]; g += gm[i]; }
    const union = f + g - both;
    const pixel = { iou: union ? both / union : 0, precision: f ? both / f : 0, recall: g ? both / g : 0, fittedPx: f, checkedPx: g };
    // window counts
    const hit = (w: WindowRect, x: WindowRect) => rectIoU(w, x) >= P.matchIoU || covers(w, x) >= P.coverShare;
    const found = checked.filter(w => fitted.some(x => hit(w, x))).length;
    const correct = fitted.filter(x => checked.some(w => hit(w, x))).length;
    // edge error: mutual best matches
    const best = (r: WindowRect, among: WindowRect[]) => { let k = -1, v = 0; among.forEach((o, i) => { const s = rectIoU(r, o); if (s > v) { v = s; k = i; } }); return [k, v] as const; };
    const pairs: WindowScore['pairs'] = [];
    const sides: number[][] = [[], [], [], []];
    checked.forEach((w, ci) => {
        const [fi, iou] = best(w, fitted);
        if (fi < 0 || iou < P.matchIoU || best(fitted[fi], checked)[0] !== ci) return;
        const x = fitted[fi];
        // a checked edge on the crop's border is no edge: the window runs on past the crop
        const onBorder = [w[0] <= 0, w[1] <= 0, w[2] >= width, w[3] >= height];
        const offsetPx = [0, 1, 2, 3].map(k => (onBorder[k] ? NaN : x[k] - w[k])) as [number, number, number, number];
        offsetPx.forEach((o, k) => { if (Number.isFinite(o)) sides[k].push(Math.abs(o)); });
        pairs.push({ checked: ci, fitted: fi, iou, offsetPx });
    });
    const all = sides.flat();
    return {
        pixel, found, checked: checked.length, correct, fitted: fitted.length,
        edges: { ...edgeStats(all), bySide: { left: edgeStats(sides[0]), top: edgeStats(sides[1]), right: edgeStats(sides[2]), bottom: edgeStats(sides[3]) } },
        pairs
    };
}

/** Scores over several crops: pixel scores pooled over all crops' pixels, counts summed, edge errors pooled. */
export function scoreTotals(scores: WindowScore[]): Omit<WindowScore, 'pairs' | 'edges'> & { edges: EdgeStats } {
    const sum = (k: 'fittedPx' | 'checkedPx') => scores.reduce((a, s) => a + s.pixel[k], 0);
    const both = scores.reduce((a, s) => a + s.pixel.precision * s.pixel.fittedPx, 0), f = sum('fittedPx'), g = sum('checkedPx'), union = f + g - both;
    const offsets = scores.flatMap(s => s.pairs.flatMap(p => p.offsetPx.filter(Number.isFinite).map(Math.abs)));
    return {
        pixel: { iou: union ? both / union : 0, precision: f ? both / f : 0, recall: g ? both / g : 0, fittedPx: f, checkedPx: g },
        found: scores.reduce((a, s) => a + s.found, 0), checked: scores.reduce((a, s) => a + s.checked, 0),
        correct: scores.reduce((a, s) => a + s.correct, 0), fitted: scores.reduce((a, s) => a + s.fitted, 0),
        edges: edgeStats(offsets)
    };
}

/** A checked set: one crop of one facade's straightened photo and the windows in it (crop pixels). */
export interface CheckedSet {
    /** What the set's rects are: 'windows' (each opening) or 'bays' (the relief's runs between piers); windows when absent. */
    kind?: 'windows' | 'bays' | (string & {});
    facadeId: number;
    /** [x0, x1, y0, y1] in the facade photo's pixels. */
    crop: [number, number, number, number];
    /** The photo's texel (m) when the set was checked: a fit on a photo of another texel is not scored. */
    pixel: number;
    windows: WindowRect[];
    note?: string; checked?: string;
}

/** A facade's fitted windows (photo pixels) moved into a checked set's crop. */
export function fittedInCrop(fittedPhotoPx: WindowRect[], set: CheckedSet): WindowRect[] {
    const [x0, , y0] = set.crop;
    return fittedPhotoPx.map(r => [r[0] - x0, r[1] - y0, r[2] - x0, r[3] - y0] as WindowRect);
}
