/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Pipeline E, enhanced mode: the carved openings follow the accepted plate.
 *
 * A wall whose facade grammar was accepted on the tile ortho has its openings carved where the tile's lattice puts them. An
 * accepted plate keeps the wall's storeys and bays (plate-identity.ts) but may lay each row and column a few decimetres off
 * the melted tile's, so the texture's windows would no longer sit in the carved recesses. The lattice is read again from
 * the plate: every tier's top and bottom line and every opening's left and right line is moved, within LATTICE_REFIT_MAX_M,
 * to where the plate's edges are (the mean distance from the line to the plate's nearest edge, each pixel counted at most
 * LINE_COST_CAP_PX, is lowest), and kept only where that distance falls by LINE_IMPROVEMENT and LINE_MIN_GAIN_PX; tiers and
 * columns keep their count and order, and every opening at least MIN_SIZE_SHARE of its size. The massing (scan or vector) is not touched: only
 * the openings' rectangles on the wall move.
 */

import { edgeMap, exactDistanceTransform } from '../../../spatial/StreetViewStage3Metrics';
import type { FacadeGrammar, GrammarTier } from '../facade-grammar';
import { lumaPlane } from './image-ops';

/** A lattice line moves at most this far, metres. */
export const LATTICE_REFIT_MAX_M = 0.6;
/** A pixel's distance to the nearest plate edge counts at most this much, pixels. */
export const LINE_COST_CAP_PX = 6;
/** A line moves only when its mean distance to the plate's edges falls to this share of where it was or less. */
export const LINE_IMPROVEMENT = 0.85;
/** ... and by at least this much, pixels (a line already on the plate's edge does not hop a pixel either way). */
export const LINE_MIN_GAIN_PX = 1;
/** An opening keeps at least this share of its width and height. */
export const MIN_SIZE_SHARE = 0.5;

/** The ortho frame of a wall: metres per pixel, the left edge s and the top edge t of pixel (0, 0). */
export interface OrthoFrame { pixel: number; orthoSMin: number; orthoTMax: number; width: number; height: number }

export interface LatticeRefit {
    grammar: FacadeGrammar;
    /** Lines moved / lines tried. */
    moved: number;
    lines: number;
    /** Mean distance of the openings' borders to the plate's nearest edge, pixels, before and after. */
    beforePx: number;
    afterPx: number;
    /** Mean |shift| of the moved lines, metres. */
    meanShiftM: number;
    why: string;
}

/** The plate's edge distance field (capped) over the `use` pixels. */
export function plateEdgeDistance(plate: Uint8Array, W: number, H: number, use: Uint8Array): Float32Array {
    const e = edgeMap(lumaPlane(plate, W, H), W, H, use, 0.88, 1);
    const dt = exactDistanceTransform(e, W, H);
    const out = new Float32Array(W * H);
    for (let i = 0; i < W * H; i++) out[i] = Math.min(LINE_COST_CAP_PX, dt[i]);
    return out;
}

function hCost(d: Float32Array, W: number, H: number, use: Uint8Array, y: number, spans: Array<[number, number]>): number {
    const yy = Math.round(y);
    if (yy < 0 || yy >= H) return LINE_COST_CAP_PX;
    let s = 0, n = 0;
    for (const [a, b] of spans) for (let x = Math.max(0, Math.round(a)); x < Math.min(W, Math.round(b)); x++) { const i = yy * W + x; if (use[i]) { s += d[i]; n++; } }
    return n ? s / n : LINE_COST_CAP_PX;
}

function vCost(d: Float32Array, W: number, H: number, use: Uint8Array, x: number, y0: number, y1: number): number {
    const xx = Math.round(x);
    if (xx < 0 || xx >= W) return LINE_COST_CAP_PX;
    let s = 0, n = 0;
    for (let y = Math.max(0, Math.round(y0)); y < Math.min(H, Math.round(y1)); y++) { const i = y * W + xx; if (use[i]) { s += d[i]; n++; } }
    return n ? s / n : LINE_COST_CAP_PX;
}

/** The best position of a line within [lo, hi] of `at` (integer steps), and whether it beats `at` by LINE_IMPROVEMENT. */
function bestLine(at: number, lo: number, hi: number, cost: (v: number) => number): { at: number; moved: boolean; c0: number; c: number } {
    const c0 = cost(at);
    let best = at, c = c0;
    for (let v = Math.ceil(lo); v <= Math.floor(hi); v++) { const q = cost(v); if (q < c - 1e-6) { c = q; best = v; } }
    return c <= LINE_IMPROVEMENT * c0 && c0 - c >= LINE_MIN_GAIN_PX && best !== at ? { at: best, moved: true, c0, c } : { at, moved: false, c0, c: c0 };
}

/**
 * The grammar's lattice read again from the plate (W x H RGBA8 in the wall's ortho frame, `use` its covered texels).
 */
export function refitLatticeToPlate(g: FacadeGrammar, f: OrthoFrame, plate: Uint8Array, use: Uint8Array): LatticeRefit {
    const W = f.width, H = f.height, p = f.pixel;
    const d = plateEdgeDistance(plate, W, H, use);
    const R = Math.max(1, Math.round(LATTICE_REFIT_MAX_M / p));
    const X = (s: number) => (s - f.orthoSMin) / p, Y = (t: number) => (f.orthoTMax - t) / p;
    const S = (x: number) => f.orthoSMin + x * p, T = (y: number) => f.orthoTMax - y * p;
    let moved = 0, lines = 0, shift = 0;
    const border = (tiers: GrammarTier[]) => {
        let s = 0, n = 0;
        for (const tr of tiers) for (const [s0, s1] of tr.cols) {
            const x0 = X(s0), x1 = X(s1), y0 = Y(tr.t1), y1 = Y(tr.t0);
            s += hCost(d, W, H, use, y0, [[x0, x1]]) + hCost(d, W, H, use, y1, [[x0, x1]]) + vCost(d, W, H, use, x0, y0, y1) + vCost(d, W, H, use, x1, y0, y1); n += 4;
        }
        return n ? s / n : 0;
    };
    const tiers: GrammarTier[] = g.tiers.map(tr => {
        const spans = tr.cols.map(([s0, s1]) => [X(s0), X(s1)] as [number, number]);
        const yTop = Y(tr.t1), yBot = Y(tr.t0), h = yBot - yTop;
        lines += 2;
        const top = bestLine(yTop, yTop - R, Math.min(yTop + R, yBot - MIN_SIZE_SHARE * h), y => hCost(d, W, H, use, y, spans));
        const bot = bestLine(yBot, Math.max(yBot - R, top.at + MIN_SIZE_SHARE * h), yBot + R, y => hCost(d, W, H, use, y, spans));
        for (const l of [top, bot]) if (l.moved) { moved++; shift += Math.abs(l.at - (l === top ? yTop : yBot)) * p; }
        const cols: Array<[number, number]> = [];
        const xs = spans;
        for (let k = 0; k < xs.length; k++) {
            const [x0, x1] = xs[k], w = x1 - x0;
            const prevRight = k ? X(cols[k - 1][1]) + 2 : -Infinity;
            const nextLeft = k + 1 < xs.length ? xs[k + 1][0] - 2 : Infinity;
            lines += 2;
            const left = bestLine(x0, Math.max(x0 - R, prevRight), Math.min(x0 + R, x1 - MIN_SIZE_SHARE * w), x => vCost(d, W, H, use, x, top.at, bot.at));
            const right = bestLine(x1, Math.max(x1 - R, left.at + MIN_SIZE_SHARE * w), Math.min(x1 + R, nextLeft), x => vCost(d, W, H, use, x, top.at, bot.at));
            for (const [l, from] of [[left, x0], [right, x1]] as const) if (l.moved) { moved++; shift += Math.abs(l.at - from) * p; }
            cols.push([S(left.at), S(right.at)]);
        }
        return { ...tr, t0: T(bot.at), t1: T(top.at), cols };
    });
    const beforePx = Math.round(border(g.tiers) * 100) / 100, afterPx = Math.round(border(tiers) * 100) / 100;
    const storeyCentres = tiers.map(t => (t.t0 + t.t1) / 2);
    const grammar: FacadeGrammar = {
        ...g, tiers,
        storeyHeightsM: storeyCentres.slice(1).map((c, k) => Math.round((c - storeyCentres[k]) * 1000) / 1000),
        openings: tiers.map((t, k) => {
            const ws = t.cols.map(([a, b]) => b - a).sort((a, b) => a - b), cs = t.cols.map(([a, b]) => (a + b) / 2);
            const pitches = cs.slice(1).map((c, j) => c - cs[j]).sort((a, b) => a - b);
            return { ...g.openings[k], sillM: Math.round(((g.openings[k]?.sillM ?? 0) + t.t0 - g.tiers[k].t0) * 1000) / 1000, widthM: Math.round((ws[ws.length >> 1] ?? 0) * 1000) / 1000, heightM: Math.round((t.t1 - t.t0) * 1000) / 1000, bayPitchM: Math.round((pitches[pitches.length >> 1] ?? 0) * 1000) / 1000 };
        }),
        source: `${g.source}+enhanced-plate`
    };
    const meanShiftM = moved ? Math.round((shift / moved) * 100) / 100 : 0;
    const why = moved
        ? `${moved} of ${lines} lattice lines moved onto the plate's edges (mean ${meanShiftM} m); the openings' borders lie ${afterPx} px from the plate's nearest edge (${beforePx} px at the tile's lattice)`
        : `the plate's edges sit on the tile's lattice (${beforePx} px from its borders): nothing moved`;
    return { grammar, moved, lines, beforePx, afterPx, meanShiftM, why };
}
