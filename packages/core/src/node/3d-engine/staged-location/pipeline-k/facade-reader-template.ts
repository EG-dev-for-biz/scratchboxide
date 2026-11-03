/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * A family's window, found again on its other planes (facade-reader.ts, facade-reader-brief.ts). Once the vision model has
 * read and its judge accepted a zone of a family's lead plane, one of that zone's openings, with the wall around it, is
 * the family's EXEMPLAR. On every other plane of the family the exemplar is looked for in the photo itself (normalised
 * cross-correlation of luminance, so a darker or lighter photo matches the same window; texels the photo never reached
 * take no part): coarse at coarseM a pixel, then refined at the photo's own pixel. Matches at minNcc are openings; where
 * they stand in columns and rows, a crossing of a column and a row with no match is an opening when the photo there still
 * matches at gridNcc (the pattern holds, the window is partly shaded or lit). The plane's judge then accepts or rejects the
 * outlines, as it does a reading's. Photo-inferred: the model read one window, the photo places every other.
 */

import type { WindowRect } from '../window-fit';

export const TEMPLATE_PARAMS = {
    /** Wall kept around the exemplar's opening, each side (m): enough to tell a window from a dark panel. */
    marginM: 0.6,
    /** The coarse search's pixel (m). */
    coarseM: 0.25,
    /** A match is an opening at this correlation; a gap in the matches' grid at gridNcc. */
    minNcc: 0.6, gridNcc: 0.45,
    /** At least this share of the exemplar's texels covered where it is compared (its margins are what keep a match true: on
     * a patch half off the photo the correlation slides onto the edge of the uncovered area), and of the opening itself
     * where one is drawn (as a reading's tiling asks of its openings). */
    minCovered: 0.85, openingCovered: 0.6,
    /** Fewer matches than this on a plane: the template does not hold there (the plane is read instead). */
    minMatches: 6
} as const;
export type TemplateParams = typeof TEMPLATE_PARAMS;

export interface WindowExemplar {
    /** The plane and zone it was read on. */
    fromPlane: number; zoneLabel?: string;
    /** Luminance around the opening (NaN where the photo never reached), at `pixel` m a texel; the opening's box within it. */
    patch: Float32Array; pw: number; ph: number; pixel: number;
    opening: WindowRect;
    panes: number;
    /** The storey pitch its zone was tiled at (m), when it repeats. */
    pitchM?: number;
}

/** A grid of luminance (NaN = not covered). */
export interface LumGrid { L: Float32Array; W: number; H: number; pixel: number }

/** The exemplar around one accepted opening of a plane, or none when it lies too near the photo's edge or is too little covered. */
export function exemplarOf(g: LumGrid, rect: WindowRect, panes: number, fromPlane: number, zoneLabel: string | undefined, P: TemplateParams = TEMPLATE_PARAMS): WindowExemplar | undefined {
    const m = Math.round(P.marginM / g.pixel);
    const x0 = Math.floor(rect[0]) - m, y0 = Math.floor(rect[1]) - m, x1 = Math.ceil(rect[2]) + m, y1 = Math.ceil(rect[3]) + m;
    if (x0 < 0 || y0 < 0 || x1 > g.W || y1 > g.H) return undefined;
    const pw = x1 - x0, ph = y1 - y0, patch = new Float32Array(pw * ph);
    let covered = 0;
    for (let y = 0; y < ph; y++) for (let x = 0; x < pw; x++) { const v = g.L[(y0 + y) * g.W + x0 + x]; patch[y * pw + x] = v; if (Number.isFinite(v)) covered++; }
    if (covered < P.minCovered * pw * ph) return undefined;
    return { fromPlane, ...(zoneLabel ? { zoneLabel } : {}), patch, pw, ph, pixel: g.pixel, opening: [rect[0] - x0, rect[1] - y0, rect[2] - x0, rect[3] - y0], panes };
}

/** A grid resampled to `pixel` m a texel by averaging the covered texels of each new one (NaN where none is covered). */
export function resample(L: Float32Array, W: number, H: number, from: number, to: number): LumGrid {
    const f = to / from, w = Math.max(1, Math.round(W / f)), h = Math.max(1, Math.round(H / f));
    const out = new Float32Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        // the source texels under this one: at least the one it falls in (upsampling)
        const y0 = Math.floor(y * f), y1 = Math.max(y0 + 1, Math.floor((y + 1) * f)), x0 = Math.floor(x * f), x1 = Math.max(x0 + 1, Math.floor((x + 1) * f));
        let s = 0, n = 0;
        for (let yy = y0; yy < Math.min(H, y1); yy++) for (let xx = x0; xx < Math.min(W, x1); xx++) { const v = L[yy * W + xx]; if (Number.isFinite(v)) { s += v; n++; } }
        out[y * w + x] = n ? s / n : NaN;
    }
    return { L: out, W: w, H: h, pixel: to };
}

/** Normalised cross-correlation of patch t (tw x th) placed at (ox, oy) on g, over the texels both cover; -1 when too few are. */
export function nccAt(g: LumGrid, t: Float32Array, tw: number, th: number, ox: number, oy: number, minCovered: number): number {
    let n = 0, sa = 0, sb = 0, saa = 0, sbb = 0, sab = 0;
    for (let y = 0; y < th; y++) {
        const gy = oy + y;
        if (gy < 0 || gy >= g.H) continue;
        for (let x = 0; x < tw; x++) {
            const gx = ox + x;
            if (gx < 0 || gx >= g.W) continue;
            const a = t[y * tw + x], b = g.L[gy * g.W + gx];
            if (!Number.isFinite(a) || !Number.isFinite(b)) continue;
            n++; sa += a; sb += b; saa += a * a; sbb += b * b; sab += a * b;
        }
    }
    if (n < minCovered * tw * th) return -1;
    const va = saa - (sa * sa) / n, vb = sbb - (sb * sb) / n;
    if (!(va > 1e-6) || !(vb > 1e-6)) return -1;
    return (sab - (sa * sb) / n) / Math.sqrt(va * vb);
}

/** Matches top to bottom, then left to right (a stable sort: equal positions keep their order). */
export const byRowThenColumn = (a: { rect: WindowRect }, b: { rect: WindowRect }) => a.rect[1] - b.rect[1] || a.rect[0] - b.rect[0];

export interface TemplateMatch { rect: WindowRect; ncc: number; grid?: boolean; /** The panes of the exemplar it matched. */ panes?: number; fromPlane?: number; /** Which of the plane's exemplars it matched. */ exemplar?: number }

/** Where the exemplar's opening stands on the plane g: matches at minNcc, then the crossings of their columns and rows that still match at gridNcc. */
export function matchExemplar(g: LumGrid, ex: WindowExemplar, P: TemplateParams = TEMPLATE_PARAMS): TemplateMatch[] {
    // the exemplar at the plane's pixel, and both at the coarse pixel
    const t = resample(ex.patch, ex.pw, ex.ph, ex.pixel, g.pixel);
    const k = ex.pixel / g.pixel, opening: WindowRect = [ex.opening[0] * k, ex.opening[1] * k, ex.opening[2] * k, ex.opening[3] * k];
    const cg = resample(g.L, g.W, g.H, g.pixel, P.coarseM), ct = resample(t.L, t.W, t.H, g.pixel, P.coarseM);
    const scores = new Float32Array(cg.W * cg.H).fill(-1);
    for (let y = 0; y + ct.H <= cg.H; y++) for (let x = 0; x + ct.W <= cg.W; x++) scores[y * cg.W + x] = nccAt(cg, ct.L, ct.W, ct.H, x, y, P.minCovered);
    // local maxima at minNcc, at least half an exemplar apart, the strongest first
    const peaks: Array<{ x: number; y: number; s: number }> = [];
    const rx = Math.max(1, Math.floor(ct.W / 2)), ry = Math.max(1, Math.floor(ct.H / 2));
    for (let y = 0; y < cg.H; y++) for (let x = 0; x < cg.W; x++) {
        const s = scores[y * cg.W + x];
        if (s < P.minNcc) continue;
        let top = true;
        for (let yy = Math.max(0, y - ry); yy <= Math.min(cg.H - 1, y + ry) && top; yy++) for (let xx = Math.max(0, x - rx); xx <= Math.min(cg.W - 1, x + rx); xx++) { const o = scores[yy * cg.W + xx]; if (o > s || (o === s && yy * cg.W + xx < y * cg.W + x)) { top = false; break; } }
        if (top) peaks.push({ x, y, s });
    }
    // each peak refined at the plane's pixel, within one coarse texel
    const f = P.coarseM / g.pixel, r = Math.ceil(f);
    const refine = (cx: number, cy: number) => {
        let best = { x: Math.round(cx), y: Math.round(cy), s: -1 };
        for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) { const x = Math.round(cx) + dx, y = Math.round(cy) + dy, s = nccAt(g, t.L, t.W, t.H, x, y, P.minCovered); if (s > best.s) best = { x, y, s }; }
        return best;
    };
    const at = (x: number, y: number): WindowRect => [x + opening[0], y + opening[1], x + opening[2], y + opening[3]];
    // the opening itself covered by the photo where it would be drawn (nothing is drawn where the photo never reached)
    const covered = (r: WindowRect) => {
        let n = 0, c = 0;
        for (let y = Math.max(0, Math.floor(r[1])); y < Math.min(g.H, Math.ceil(r[3])); y++) for (let x = Math.max(0, Math.floor(r[0])); x < Math.min(g.W, Math.ceil(r[2])); x++) { n++; if (Number.isFinite(g.L[y * g.W + x])) c++; }
        return n > 0 && c >= P.openingCovered * n;
    };
    const found: TemplateMatch[] = [];
    for (const p of peaks) { const b = refine(p.x * f, p.y * f); if (b.s >= P.minNcc && covered(at(b.x, b.y))) found.push({ rect: at(b.x, b.y), ncc: Math.round(b.s * 1000) / 1000, panes: ex.panes, fromPlane: ex.fromPlane }); }
    if (!found.length) return found;
    // the matches' columns and rows; a crossing with no match is an opening when the photo there still matches at gridNcc
    const ow = opening[2] - opening[0], oh = opening[3] - opening[1];
    const cluster = (v: number[], tol: number) => { const s = [...v].sort((a, b) => a - b), out: number[][] = []; for (const x of s) { const last = out[out.length - 1]; if (last && x - last[last.length - 1] <= tol) last.push(x); else out.push([x]); } return out.map(c => c[c.length >> 1]); };
    const cols = cluster(found.map(m => m.rect[0]), 0.3 * ow), rows = cluster(found.map(m => m.rect[1]), 0.3 * oh);
    const near = (x: number, y: number) => found.some(m => Math.abs(m.rect[0] - x) <= 0.3 * ow && Math.abs(m.rect[1] - y) <= 0.3 * oh);
    for (const x of cols) for (const y of rows) {
        if (near(x, y)) continue;
        const b = refine(x - opening[0], y - opening[1]);
        if (b.s >= P.gridNcc && covered(at(b.x, b.y))) found.push({ rect: at(b.x, b.y), ncc: Math.round(b.s * 1000) / 1000, grid: true, panes: ex.panes, fromPlane: ex.fromPlane });
    }
    return found.sort(byRowThenColumn);
}

/** Matches of several exemplars on one plane: an opening overlapping a stronger one by half its area is dropped. */
export function mergeMatches(sets: TemplateMatch[][]): TemplateMatch[] {
    const all = sets.flat().sort((a, b) => b.ncc - a.ncc), kept: TemplateMatch[] = [];
    const area = (r: WindowRect) => Math.max(0, r[2] - r[0]) * Math.max(0, r[3] - r[1]);
    const overlap = (a: WindowRect, b: WindowRect) => Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0])) * Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));
    for (const m of all) if (!kept.some(k => overlap(k.rect, m.rect) > 0.5 * Math.min(area(k.rect), area(m.rect)))) kept.push(m);
    return kept.sort(byRowThenColumn);
}
