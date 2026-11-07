/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The window array of a facade plane, inferred from every window box on it (the facade reader's where it drew, merged into
 * window_fit.json, the window fit's elsewhere): the boxes of one facade are mostly on one lattice (a column pitch and phase, a storey pitch and phase, one box
 * size), read band by band from a photo that is clear in one part and dim in another, so a band read on its own drifts
 * off the facade's grid or comes back oversized, and nothing before this step checked a band's grid against the facade's.
 *
 * - The seed. Before any box is read, the photo's own periodicity: its column and row lightness profiles (the mean over
 *   the valid texels of each column and row) autocorrelated, the pitch on each axis the lag of the strongest correlation
 *   (a smaller lag nearly as strong taken instead, so the pitch wins over its multiples), then the photo folded at those
 *   pitches into one unit cell, where the window is the interval on each axis that differs most from the rest of the cell
 *   (its centre the phase, its length the window's size, its colour against the rest the window's contrast). The seed
 *   is clear when both pitches correlate (P.photo.minAutocorr) and the window stands out of the cell (P.photo.minContrast),
 *   and it stands on its own when P.photo.minRows rows and P.photo.minCols columns show its contrast. The boxes then
 *   refine it: where the two agree the boxes' pitch and phase are kept (refined over many boxes) and the seed's window
 *   size is taken (the box the photo shows, not the median of the boxes read: a reader reading the lower half dim reads
 *   small boxes); where the seed's storey pitch is a whole multiple of the boxes' the boxes are sub-boxes of one window
 *   (a window read as a pane, a transom and a spandrel) and are merged, site by site, into one; where they disagree
 *   outright the lattice with the wider evidence wins (the seed when the rows showing its contrast outnumber the rows the
 *   boxes occupy by P.photo.evidenceRatio: a slab of ribbon windows under a crown read by nothing else), the boxes off it
 *   kept as read; with no usable boxes at all the seed alone is the lattice.
 * - The lattice. The column pitch and phase from every box's centre (strips included: a strip stands in its column), the
 *   storey pitch and phase from the rows the single-site boxes form (rows weighted by their boxes), each by a spacing
 *   histogram over the pairwise distances (a candidate pitch scored by how many distances are a whole number of it within a
 *   tolerance of a share of the boxes' own size, farther multiples counting less, the smallest pitch that reaches three
 *   quarters of the best score taken, so the pitch wins over its half and its multiples) and a consensus phase (the densest bin of the centres modulo the pitch).
 * - Tiers. A contiguous run of rows off that lattice (P.tierMinRows or more; a row is off when its centre is, or when its
 *   boxes are another size) is tried as a tier of its own, with its own row pitch and phase, and kept only when its own fit
 *   is clean (residual RMS under P.tierRms), its pitch differs from the facade's (over P.tierPitchDiff: the same pitch
 *   shifted is a drifted band, snapped instead) and the photo supports it: each lattice's sites over the run's rows, the
 *   window's look against the wall beside it (CIELAB), the tier's lattice separating window from wall more clearly than
 *   the facade's (P.tierGain). Numbers decide, never a name for what the tier is.
 * - Each box. By its distance to the nearest site (in pitches) and its size against the lattice box (the median of the
 *   boxes on a site): on the lattice (within P.settleTol, and within P.keepSizeTol of the lattice box's size) it is left as
 *   it is; else it is moved onto its site as the lattice's box (snapped: its panes carried along) or, when its size was off
 *   too, replaced (both photo-inferred: the photo had a box there); a second box on a taken site is dropped (rejected); a
 *   box far from the array's size (its area outside P.areaRange of the lattice box's) is not of the array and is kept as
 *   read, taking no site. A box spanning more than P.spanSites sites on an axis is a strip or a bay: on a facade read
 *   mostly as cells, a strip one column wide standing on a lattice column is folded into the cells it covers
 *   (photo-inferred; its panes go to the cell they lie in); a wider bay, or a strip on a facade read mostly as strips, is
 *   kept whole and its sites are taken.
 * - The majority. A facade holds an array only when at least P.minBoxes single-site boxes, and P.majority of those of the
 *   array's size, sit on the lattice at its size, and the lattice would not drop more than P.maxRejectedShare of them as
 *   second boxes on taken sites. Else it is left exactly as fitted, with the reason.
 * - The pattern is the facade's, not a site's: every lattice row and column the photo spans is judged by its sites together
 *   (it holds the array when P.extentShare of its sites hold a box, or when its sites on average show the contrast the
 *   neighbouring windows show against the wall beside them: a relative CIELAB test, so a dim part of the photo reads like
 *   a bright one; from the rows and columns the boxes occupy the array steps outward row by row and column by column for as
 *   long as each next one shows that contrast, to the photo's edge if it does, and stops at the first that does not), and
 *   inside the rows and columns that hold it every empty site takes the lattice's box (added, generated):
 *   a site too dim to confirm on its own, or one the photo never reached, is filled on the array's evidence; a site is
 *   withheld only where the photo reads the opposite of a window (its contrast under P.contradict of the windows') or a
 *   bay covers it; where something stood in front of it (its occluded share over P.addMaxOccluded) the array continues
 *   over it unread (generated), as the lattice does over an occluded span. From a row or column that
 *   holds it the array steps on through contiguous blank rows and columns (their sites' texels mostly unreached or
 *   featureless: a smear, a hole refilled with nothing to read) at its pitch and phase (continued, generated, with the
 *   reason): a blank run between two rows (columns) that hold the array, or up from the array's top to the building's
 *   roof line when the envelope is given (ArrayOptions.minRowPx); never sideways past the last holding column, nor above
 *   the array with no envelope, since that may be another surface or the sky. Outside those rows and columns nothing is
 *   added: the array stops where its evidence does.
 *
 * Panes follow their box (a snapped box's own panes moved with it; a replaced or added box takes the pane layout of the
 * nearest box on the lattice). The pre-array boxes are kept in the entry (`array.in`), so the step is repeatable: an entry
 * already carrying this version is not inferred again, one carrying another is restored first.
 */

import * as fs from 'fs';
import * as path from 'path';
import { decodePng } from '../../../texture-processing';
import { labOf8, regionLook, WINDOW_FIT_FILE, type WindowFitFile, type WindowRect } from '../window-fit';
import { countSet, readOccluded } from './occlusion';
import { featurelessMaskName } from './ortho-rectify';

export const WINDOW_ARRAY_VERSION = 'window-array/4';

export const WINDOW_ARRAY_PARAMS = {
    /** Fewer single-site boxes than this: nothing is inferred. */
    minBoxes: 12,
    /** The share of single-site boxes that must sit on the lattice (within snapTol on both axes) for the lattice to hold. */
    majority: 0.5,
    /** A box is on its site when its centre lies within this share of the pitch of the site's, on each axis. */
    snapTol: 0.25,
    /** A box on its site but farther than this share of the pitch from it is still moved onto it, as the lattice's box. */
    settleTol: 0.08,
    /** A box is left as read only when its width and height are within this share of the lattice box's (else it takes the lattice's). */
    keepSizeTol: 0.15,
    /** A box has the lattice's size when its width and height are within this share of the lattice box's. */
    sizeTol: 0.35,
    /** The pitches searched (m) and the histogram's bin (m). */
    pitchM: [0.8, 12] as [number, number], binM: 0.05,
    /** A distance counts toward a candidate pitch when it is within this share of the boxes' own size of a whole number of pitches (centres jitter by a fraction of a box, whatever the pitch; a tolerance that grew with the pitch let a large pitch sweep up several rows at every multiple). */
    harmonicTol: 0.15,
    /** A box wider or taller than this many pitches is a strip or a bay: kept whole, never a member or snapped. */
    spanSites: 1.6,
    /** A run of at least this many rows off the facade's row lattice is tried as a tier of its own. */
    tierMinRows: 3,
    /** A tier's own fit must leave its rows within this RMS (in its pitch) to be clean. */
    tierRms: 0.12,
    /** A tier's lattice must separate window from wall at least this much more clearly than the facade's over its rows. */
    tierGain: 1.1,
    /** A run of rows whose own pitch is within this share of the facade's (and whose boxes are its size) is drift, not a tier. */
    tierPitchDiff: 0.05,
    /** A box whose area is under this share of the lattice box's, or over its inverse, is not of the array: kept as read, never replaced. */
    areaRange: [0.4, 3] as [number, number],
    /** A site's look is read only when at most this share of it is uncovered; a site more than addMaxOccluded occluded (something stood before it) is continued over, never read. */
    addMaxUncovered: 0.5, addMaxOccluded: 0.35,
    /** Members within this many rows of an added site give the window contrast it is compared to. */
    peerRows: 3,
    /** A site shows a window when it has at least this share of its neighbours' contrast against the wall beside it, in the same direction; it contradicts one under contradictShare of that (plain wall reads near zero). */
    addMinContrast: 0.5,
    /** Stepping outward from a row or column that holds the array, the next row (column) is entered while its sites show at least this share of the windows' contrast: a lower bar than addMinContrast, since the array beside it is already established and a storey in shade reads dim; the step stops at the first row under it. */
    stepContrast: 0.3,
    /** A site contradicts a window only when its contrast runs the opposite way, under this (negative) share of the windows' own; plain wall, which reads near zero, does not. */
    contradict: -0.25,
    /** More than this share of the single-site boxes landing as a second box on a taken site means the lattice does not explain the boxes: the facade is left as fitted. */
    maxRejectedShare: 0.2,
    /** A lattice row or column holds the array when at least this share of its sites hold a box, or its sites show the window contrast on average. */
    extentShare: 0.25,
    /** The photo's own periodicity (the seed): the ortho's row and column lightness profiles autocorrelated, the lattice read from the fold of the photo at the pitches found. */
    photo: {
        /** The normalised autocorrelation at the pitch must reach this for the photo to show a pitch on that axis. */
        minAutocorr: 0.15,
        /** A smaller lag with at least this share of the best lag's autocorrelation is the pitch (the best lag may be a multiple). */
        subharmonic: 0.8,
        /** A sub-multiple (a half to an eighth) of an axis's clearest candidate pitch whose fold's window contrast reaches this share of the clearest is the pitch (a unit cell of two windows folds a little more clearly than one). */
        pitchShare: 0.9,
        /** The window must differ from the rest of the unit cell by at least this (CIELAB) for the fold to show a window. */
        minContrast: 6,
        /** The window's share of the cell on an axis lies within this range (a ribbon fills nearly all of it, a slit very little). */
        sizeShare: [0.12, 0.95] as [number, number],
        /** The seed stands on its own (no boxes needed) only when at least this many rows and columns show its window contrast. */
        minRows: 4, minCols: 3,
        /** Two pitches agree within this share; one is a multiple of the other within this share of the smaller. */
        agree: 0.05, multiple: 0.1,
        /** The seed's window size replaces the boxes' only when it lies within this range of the boxes' median size (a fold blurred by mixed light is not trusted over a hundred boxes). */
        sizeRange: [0.5, 2.5] as [number, number],
        /** Where the boxes' lattice and the seed's disagree, the seed wins only when the rows (columns) that show its contrast span this many times the extent of the rows (columns) the boxes occupy. */
        evidenceRatio: 1.5,
        /** Storeys are merged (the seed's storey pitch a multiple of the boxes') only when the seed's window is at least this many times the boxes' tall: the window spans the sub-boxes read apart; a window the boxes' own size is another reading of the same storeys, not sub-boxes. */
        mergeSpan: 1.5,
        /** Where the pitches agree, the boxes' lattice is still replaced by the seed's (better refined over every storey) when the boxes occupy fewer rows (columns) than this share of those showing the seed's contrast, or fewer than minRows (minCols). */
        fewShare: 0.25,
        /** Boxes of which at least this share sit on their own lattice are a clean reading: the seed never folds their columns into a coarser reading of every other column. */
        trustOnShare: 0.8
    },
    /** A row or column is blank when at least this share of its sites' texels the photo never reached or left featureless: the array steps on into it from a row or column that holds it. */
    blankShare: 0.5
} as const;
export type WindowArrayParams = typeof WINDOW_ARRAY_PARAMS;

/** How a site came to hold its box. */
export const SITE_KIND = { on: 0, snapped: 1, replaced: 2, added: 3, span: 4, folded: 5, kept: 6, continued: 7 } as const;

export interface ArrayTier {
    /** The tier's rows, bottom and top of its band in photo pixels (y down). */
    y0: number; y1: number;
    rowPitch: number; rowPhase: number;
    /** The lattice's box (px). */
    boxW: number; boxH: number;
    from: 'majority' | 'residual-tier' | 'photo' | 'merged';
    /** The photo's separation of window from wall under the facade's lattice and this tier's over its rows (CIELAB), when tried as a tier. */
    photoScore?: { facade: number; tier: number };
    rows: number;
}

export interface FacadeArrayReport {
    facadeId: number;
    boxesIn: number; spans: number;
    colPitchM?: number; colPhaseM?: number; cols?: number;
    tiers?: Array<{ rowPitchM: number; rowPhaseM: number; rows: number; boxM: [number, number]; from: ArrayTier['from']; photoScore?: ArrayTier['photoScore'] }>;
    on: number; snapped: number; replaced: number; added: number; rejected: number;
    /** Strips folded into the array's cells, one column of them each (photo-inferred). */
    folded?: number;
    /** Boxes far from the array's size, kept as read and taking no site. */
    kept?: number;
    /** The lattice rows and columns that hold the array, of those the photo spans. */
    rowsIn?: number; colsIn?: number;
    /** Blank rows and columns (unreached or featureless) the array stepped on into from the rows and columns that hold it, and the sites it placed there (generated). */
    continued?: { rows: number; cols: number; sites: number; reason: string };
    /** The input boxes' RMS distance to their nearest site, in pitches, and the output's. */
    rmsIn?: number; rmsOut?: number;
    /** The empty sites of the lattice: those outside the rows and columns that hold the array, those withheld (under a bay, reading the opposite of a window), those continued over an occlusion, and of the filled, those the photo never reached and those too dim to confirm on their own. */
    empty?: { sites: number; outside: number; uncovered: number; occluded: number; wall: number; underBox: number; byRow: number };
    /** Where the lattice came from: the boxes' consensus, the photo's own periodicity, or the boxes' with its storeys (columns) merged into the photo's. */
    source?: 'boxes' | 'photo' | 'merged';
    /** The photo's own lattice (photoLattice), in metres, and the rows and columns that showed its window contrast. */
    seed?: { colPitchM?: number; rowPitchM?: number; windowM?: [number, number]; contrast?: number; ac?: [number, number]; clear: boolean; rows: number; cols: number };
    /** Sub-boxes merged into one window on the photo's storey (or column) pitch, and the multiple on each axis. */
    merged?: number; mergedBy?: { rows?: number; cols?: number };
    /** Why the facade was left as it was. */
    reason?: string;
}

export interface WindowArrayReport { version: string; params: WindowArrayParams; facades: FacadeArrayReport[]; ms: number }

/** What an entry keeps of the step: the boxes before it, the report, and each site's box, kind, confidence and residual (7 numbers a site). */
export interface ArrayRecord { version: string; in: { rects: WindowRect[]; panes?: WindowRect[]; generated?: WindowRect[] }; report: Omit<FacadeArrayReport, 'facadeId'>; sites: number[] }

export interface ArrayPhoto { rgba: ArrayLike<number>; width: number; height: number }

export interface ArrayOptions {
    /** 1 where the photo is covered but featureless (ortho-rectify.ts featurelessMask): a smear or a refill with no detail to read. */
    featureless?: Uint8Array;
    /** The first photo row (px, from the top) inside the building's height envelope: no site is placed above it. Without it the array never steps into an unreached band at the photo's edge. */
    minRowPx?: number;
}

interface Lattice1D { pitch: number; phase: number }

/** Why a continued site is there (its provenance label is generated). */
export const CONTINUED_REASON = "no photo evidence: the photo never reached or left featureless this band, the building's envelope and the array beside it say the wall goes on, so the array steps on at its pitch and phase";
/** The share of the best candidate pitch's score the smallest accepted pitch must reach (consensusPitch). */
const PITCH_SHARE = 0.75;
const r2 = (v: number) => Math.round(v * 100) / 100;
const r3 = (v: number) => Math.round(v * 1000) / 1000;
const cmpRect = (a: WindowRect, b: WindowRect) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2] || a[3] - b[3];

/**
 * The pitch a set of positions repeats at, by consensus: the pairwise distances binned, every candidate pitch scored by the
 * distances that are a whole number of it (weighted by the positions' weights, farther multiples counting less), the best
 * refined by least squares over its own distances. Undefined when nothing repeats.
 */
export function consensusPitch(pos: number[], weight: number[], minPitch: number, maxPitch: number, bin: number, /** The tolerance, in the positions' units (px): how far from a whole number of pitches a distance may fall. */ tol: number): Lattice1D | undefined {
    if (pos.length < 3) return undefined;
    const maxD = maxPitch * 8, nb = Math.ceil(maxD / bin) + 1, hist = new Float64Array(nb);
    for (let i = 0; i < pos.length; i++) for (let j = i + 1; j < pos.length; j++) {
        const d = Math.abs(pos[i] - pos[j]);
        if (d < minPitch * 0.5 || d > maxD) continue;
        hist[Math.min(nb - 1, Math.round(d / bin))] += Math.min(weight[i], weight[j]);
    }
    // every candidate scored with a flat kernel (a sloped one let a doubled pitch, with twice the tolerance, outscore the
    // pitch itself on jittery rows); then the smallest pitch that reaches P_SHARE of the best score, at its local peak: a
    // multiple of the pitch scores about as much (every distance fits it too), its half about half (no distance at its
    // odd multiples), so the pitch itself is the smallest to reach the bar
    const cands: Array<{ p: number; score: number }> = [];
    for (let p = minPitch; p <= maxPitch; p *= 1.01) {
        let score = 0;
        for (let b = 0; b < nb; b++) {
            if (!hist[b]) continue;
            const d = b * bin, k = Math.round(d / p);
            if (k >= 1 && Math.abs(d - k * p) <= tol) score += hist[b] / k;
        }
        cands.push({ p, score });
    }
    const top = Math.max(...cands.map(c => c.score));
    if (!(top > 0)) return undefined;
    const from = cands.findIndex(c => c.score >= PITCH_SHARE * top);
    let at = from;
    while (at + 1 < cands.length && cands[at + 1].score >= cands[at].score * 0.999) at++;
    // the plateau's middle (a flat kernel scores a run of candidates alike), then refined: p = sum(hist d) / sum(hist k)
    // over the distances that fit it (least squares over d - k p, each weighted hist / k), a few rounds, each with the
    // multiples recounted at the refined pitch, over the nearer multiples only (a far one is easily miscounted)
    let pitch = cands[Math.round((from + at) / 2)].p;
    // the nearer multiples first, farther ones as the estimate sharpens (a far multiple is miscounted only by a rough
    // pitch, and over a tall facade it is the far multiples that pin the pitch to the millimetre)
    for (const kMax of [3, 6, 12, 24, 48, 96]) {
        let num = 0, den = 0;
        for (let b = 0; b < nb; b++) {
            if (!hist[b]) continue;
            const d = b * bin, k = Math.round(d / pitch);
            if (k < 1 || k > kMax || Math.abs(d - k * pitch) > tol) continue;
            num += hist[b] * d; den += hist[b] * k;
        }
        if (den > 0) pitch = num / den;
    }
    return { pitch, phase: consensusPhase(pos, weight, pitch) };
}

/** The phase of a lattice of `pitch` through the positions: the densest bin of the positions modulo the pitch, then the mean of its members. */
export function consensusPhase(pos: number[], weight: number[], pitch: number): number {
    const nb = 24, bins = new Float64Array(nb);
    const m = pos.map(v => ((v % pitch) + pitch) % pitch);
    m.forEach((v, i) => { bins[Math.min(nb - 1, Math.floor(v / pitch * nb))] += weight[i]; });
    let best = 0, bestV = -1;
    for (let b = 0; b < nb; b++) { const v = bins[b] + bins[(b + 1) % nb] + bins[(b + nb - 1) % nb]; if (v > bestV) { bestV = v; best = b; } }
    const centre = (best + 0.5) / nb * pitch;
    let s = 0, w = 0;
    m.forEach((v, i) => {
        let d = v - centre; if (d > pitch / 2) d -= pitch; if (d < -pitch / 2) d += pitch;
        if (Math.abs(d) <= pitch * 1.5 / nb) { s += d * weight[i]; w += weight[i]; }
    });
    return ((centre + (w ? s / w : 0)) % pitch + pitch) % pitch;
}

/** A position's nearest site index and its signed residual in pitches. */
const siteOf = (v: number, l: Lattice1D): { k: number; res: number } => { const q = (v - l.phase) / l.pitch, k = Math.round(q); return { k, res: q - k }; };

/** The rows the single-site boxes form (centres grouped within half the typical height), each with its centre and its boxes. */
function rowsOf(boxes: Array<{ cy: number; h: number }>): Array<{ cy: number; members: number[] }> {
    const order = boxes.map((_, i) => i).sort((a, b) => boxes[a].cy - boxes[b].cy);
    const rows: Array<{ cy: number; members: number[] }> = [];
    for (const i of order) {
        const b = boxes[i], last = rows[rows.length - 1];
        if (last && Math.abs(b.cy - last.cy) <= b.h * 0.5) { last.members.push(i); last.cy = last.members.reduce((t, k) => t + boxes[k].cy, 0) / last.members.length; }
        else rows.push({ cy: b.cy, members: [i] });
    }
    return rows;
}

/**
 * The wall around a box: the bands just left, right, above and below it (each 0.4 of the box's width or height), outside
 * every box in `skip`, as one mean colour (CIELAB). A ribbon window reads against the floor band above and below it, a
 * punched one against the pier beside it: the ring sees both.
 */
function ringLook(img: ArrayPhoto, valid: Uint8Array, r: WindowRect, skip: WindowRect[]): number[] | undefined {
    const sw = Math.max(2, Math.round((r[2] - r[0]) * 0.4)), sh = Math.max(2, Math.round((r[3] - r[1]) * 0.4));
    const bands: WindowRect[] = [[r[0] - sw, r[1], r[0], r[3]], [r[2], r[1], r[2] + sw, r[3]], [r[0], r[1] - sh, r[2], r[1]], [r[0], r[3], r[2], r[3] + sh]];
    const m = [0, 0, 0]; let n = 0;
    for (const b of bands) { const l = regionLook(img, valid, b, skip); if (!l.lab) continue; const w = l.validShare * (b[2] - b[0]) * (b[3] - b[1]); for (let k = 0; k < 3; k++) m[k] += l.lab[k] * w; n += w; }
    return n > 0 ? m.map(v => v / n) : undefined;
}

const median = (v: number[]): number => { const s = [...v].sort((a, b) => a - b); return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : NaN; };

/**
 * How clearly a lattice's sites read as windows against the wall beside them over rows `y0..y1` (CIELAB distance between a
 * site's look and the wall just left and right of it, outside every site, averaged over the covered sites).
 */
function photoScore(img: ArrayPhoto, valid: Uint8Array, col: Lattice1D, row: Lattice1D, boxW: number, boxH: number, y0: number, y1: number, cols: [number, number]): number {
    const sites: WindowRect[] = [];
    for (let j = Math.ceil((y0 - row.phase) / row.pitch); j * row.pitch + row.phase <= y1; j++) for (let i = cols[0]; i <= cols[1]; i++) {
        const cx = col.phase + i * col.pitch, cy = row.phase + j * row.pitch;
        sites.push([Math.round(cx - boxW / 2), Math.round(cy - boxH / 2), Math.round(cx + boxW / 2), Math.round(cy + boxH / 2)]);
    }
    let sum = 0, n = 0;
    for (const r of sites) {
        const inside = regionLook(img, valid, r);
        if (!inside.lab || inside.validShare < 0.5) continue;
        const wall = ringLook(img, valid, r, sites);
        if (!wall) continue;
        sum += Math.hypot(inside.lab[0] - wall[0], inside.lab[1] - wall[1], inside.lab[2] - wall[2]); n++;
    }
    return n ? sum / n : 0;
}

/** One axis of the photo's own lattice. */
export interface SeedAxis { pitch: number; phase: number; /** The window's extent on this axis (px). */ size: number; /** The normalised autocorrelation at the pitch. */ ac: number }
/** The photo's own periodicity: a lattice read from the ortho alone. */
export interface PhotoSeed {
    col?: SeedAxis; row?: SeedAxis;
    /** The window's colour less the rest of the unit cell's (CIELAB), and its magnitude. */
    contrast?: number[]; contrastE: number;
    /** Both pitches correlate and the window stands out of the cell. */
    clear: boolean;
    /** The candidate pitches tried on each axis (px) with their correlation and the contrast of the fold at each (the other axis at the pitch chosen). */
    tried?: { col: Array<{ pitch: number; ac: number; contrast: number }>; row: Array<{ pitch: number; ac: number; contrast: number }> };
}

/**
 * A profile's period by normalised autocorrelation over lags in [lo, hi] (px): the lag of the strongest correlation, a
 * smaller lag at least `sub` as strong taken instead (the strongest may be a multiple), refined between texels by the
 * parabola through its neighbours. Gaps (NaN) take the mean; a running mean over 2 hi is removed first (a lit side
 * shading into a dark one is not a period). Undefined when fewer than three periods fit.
 */
export function autocorrPeriod(profile: Float64Array, lo: number, hi: number, sub: number): { lag: number; ac: number } | undefined {
    const peaks = autocorrPeaks(profile, lo, hi);
    if (!peaks.length) return undefined;
    let best = peaks[0];
    // a local peak at the best lag's half, third or quarter nearly as strong is the pitch itself
    for (const q of [4, 3, 2]) { const k = peaks.find(pk => Math.abs(pk.lag - best.lag / q) <= 2.5 && pk.ac >= sub * best.ac); if (k) { best = k; break; } }
    return best;
}

/**
 * The local maxima of a profile's normalised autocorrelation over lags in [lo, hi] (px), strongest first, each refined
 * between texels by the parabola through its neighbours. Gaps (NaN) take the mean; a running mean over 2 hi is removed
 * first (a lit side shading into a dark one is not a period). Empty when fewer than three periods fit.
 */
export function autocorrPeaks(profile: Float64Array, lo: number, hi: number): Array<{ lag: number; ac: number }> {
    const n = profile.length;
    const finite = Array.from(profile).filter(Number.isFinite), mean = finite.length ? finite.reduce((a, b) => a + b, 0) / finite.length : 0;
    const v = Float64Array.from(profile, x => (Number.isFinite(x) ? x : mean));
    const w = Math.min(n, Math.max(3, Math.round(2 * hi)) | 1), h = w >> 1;
    const d = new Float64Array(n);
    for (let i = 0; i < n; i++) { let t = 0, c = 0; for (let j = Math.max(0, i - h); j <= Math.min(n - 1, i + h); j++) { t += v[j]; c++; } d[i] = v[i] - t / c; }
    let s2 = 0; for (let i = 0; i < n; i++) s2 += d[i] * d[i];
    if (!(s2 > 0)) return [];
    const maxLag = Math.min(Math.floor(hi), Math.floor(n / 3)), minLag = Math.max(2, Math.ceil(lo));
    if (maxLag < minLag) return [];
    const ac = new Float64Array(maxLag + 2);
    for (let k = Math.max(1, minLag - 1); k <= maxLag + 1 && k < n; k++) { let c = 0; for (let i = 0; i + k < n; i++) c += d[i] * d[i + k]; ac[k] = c / (s2 * (n - k) / n); }
    const out: Array<{ lag: number; ac: number }> = [];
    for (let k = minLag; k <= maxLag; k++) {
        if (!(ac[k] > 0) || ac[k] < ac[k - 1] || ac[k] < ac[k + 1]) continue;
        let lag = k;
        const a = ac[k - 1], b = ac[k], c = ac[k + 1], den = a - 2 * b + c;
        if (den < 0) lag = k + 0.5 * (a - c) / den;
        out.push({ lag, ac: b });
    }
    return out.sort((x, y) => y.ac - x.ac);
}

/**
 * The interval of a circular profile that differs most from its mean on the side `sign` (the window of the unit cell on
 * one axis: darker than the rest by default, as glass reads under the sky): its start (bin), length and signed deviation,
 * over lengths within `share` of the profile.
 */
function cellInterval(prof: Float64Array, share: [number, number], sign: -1 | 1 = -1): { start: number; len: number; dev: number } | undefined {
    const n = prof.length;
    if (n < 4) return undefined;
    const mean = prof.reduce((a, b) => a + b, 0) / n, dev = Float64Array.from(prof, v => sign * (v - mean));
    const minL = Math.max(1, Math.round(share[0] * n)), maxL = Math.max(minL, Math.floor(share[1] * n));
    let best: { start: number; len: number; dev: number } | undefined;
    for (let start = 0; start < n; start++) {
        let sum = 0;
        for (let len = 1; len <= maxL; len++) {
            sum += dev[(start + len - 1) % n];
            if (len < minL) continue;
            if (sum <= 0) continue;
            const score = sum / Math.sqrt(len); // the mean deviation, weighted toward a long interval
            if (!best || score > best.dev * sign / Math.sqrt(best.len)) best = { start, len, dev: sum * sign };
        }
    }
    return best;
}

/**
 * The photo's own lattice: the column and row pitches by autocorrelation of its lightness profiles over the valid texels,
 * the window's phase, size and contrast from the fold of the photo (CIELAB) at those pitches. `minP`, `maxP` the pitches
 * searched (px). The seed is read from the photo alone; it never names what the pattern is.
 */
/** The photo's CIELAB per valid texel and its column and row lightness profiles (the mean L of each column and row over the valid texels; NaN where under a tenth is valid). */
export function lightnessProfiles(img: ArrayPhoto, valid: Uint8Array): { L: Float32Array; A: Float32Array; B: Float32Array; col: Float64Array; row: Float64Array } {
    const W = img.width, H = img.height, n = W * H;
    const L = new Float32Array(n), A = new Float32Array(n), B = new Float32Array(n);
    for (let k = 0; k < n; k++) if (valid[k]) { const l = labOf8(img.rgba[k * 4], img.rgba[k * 4 + 1], img.rgba[k * 4 + 2]); L[k] = l[0]; A[k] = l[1]; B[k] = l[2]; }
    const col = new Float64Array(W), row = new Float64Array(H), colN = new Int32Array(W), rowN = new Int32Array(H);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const k = y * W + x; if (!valid[k]) continue; col[x] += L[k]; colN[x]++; row[y] += L[k]; rowN[y]++; }
    for (let x = 0; x < W; x++) col[x] = colN[x] >= 0.1 * H ? col[x] / colN[x] : NaN;
    for (let y = 0; y < H; y++) row[y] = rowN[y] >= 0.1 * W ? row[y] / rowN[y] : NaN;
    return { L, A, B, col, row };
}

/** A lattice's unit cell: the photo folded at both pitches. */
export interface Fold { col: SeedAxis; row: SeedAxis; contrast: number[]; contrastE: number }

/**
 * The photo folded at a column and a row pitch (px) into one unit cell, over the valid texels: the window the interval on
 * each axis darker than the rest of the cell (grown to half-max), its centre the phase, its colour against the rest of
 * the cell the contrast. `lab` is the photo's CIELAB per texel (lightnessProfiles).
 */
export function foldCell(lab: { L: Float32Array; A: Float32Array; B: Float32Array; W: number; H: number; valid: Uint8Array }, cp: { lag: number; ac: number }, rp: { lag: number; ac: number }, P: WindowArrayParams = WINDOW_ARRAY_PARAMS): Fold | undefined {
    const { L, A, B, W, H, valid } = lab;
    const nu = Math.max(4, Math.round(cp.lag)), nv = Math.max(4, Math.round(rp.lag));
    const cell = new Float64Array(nu * nv * 3), cnt = new Int32Array(nu * nv);
    for (let y = 0; y < H; y++) { const v = Math.min(nv - 1, Math.floor(((y % rp.lag) + rp.lag) % rp.lag / rp.lag * nv)); for (let x = 0; x < W; x++) { const k = y * W + x; if (!valid[k]) continue; const u = Math.min(nu - 1, Math.floor(((x % cp.lag) + cp.lag) % cp.lag / cp.lag * nu)), c = v * nu + u; cell[c * 3] += L[k]; cell[c * 3 + 1] += A[k]; cell[c * 3 + 2] += B[k]; cnt[c]++; } }
    const cu = new Float64Array(nu), cv = new Float64Array(nv), cun = new Int32Array(nu), cvn = new Int32Array(nv);
    for (let v = 0; v < nv; v++) for (let u = 0; u < nu; u++) { const c = v * nu + u; if (!cnt[c]) continue; cu[u] += cell[c * 3]; cun[u] += cnt[c]; cv[v] += cell[c * 3]; cvn[v] += cnt[c]; }
    for (let u = 0; u < nu; u++) cu[u] = cun[u] ? cu[u] / cun[u] : 0;
    for (let v = 0; v < nv; v++) cv[v] = cvn[v] ? cv[v] / cvn[v] : 0;
    const iu = cellInterval(cu, P.photo.sizeShare), iv = cellInterval(cv, P.photo.sizeShare);
    if (!iu || !iv) return undefined;
    // the interval grown to half-max: every bin beyond it still darker than halfway between the window and the rest
    const grow = (prof: Float64Array, iv0: { start: number; len: number }, n: number) => {
        const inI = (q: number, st: number, ln: number) => (q - st + n) % n < ln;
        let wm = 0, wn = 0, rm = 0, rn = 0;
        for (let q = 0; q < n; q++) if (inI(q, iv0.start, iv0.len)) { wm += prof[q]; wn++; } else { rm += prof[q]; rn++; }
        if (!wn || !rn) return iv0;
        const half = (wm / wn + rm / rn) / 2, maxL = Math.floor(P.photo.sizeShare[1] * n);
        let st = iv0.start, ln = iv0.len;
        while (ln < maxL && prof[(st - 1 + n) % n] < half) { st = (st - 1 + n) % n; ln++; }
        while (ln < maxL && prof[(st + ln) % n] < half) ln++;
        return { start: st, len: ln };
    };
    const gu = grow(cu, iu, nu), gv = grow(cv, iv, nv);
    const inU = (u: number) => (u - gu.start + nu) % nu < gu.len, inV = (v: number) => (v - gv.start + nv) % nv < gv.len;
    const win = [0, 0, 0], rest = [0, 0, 0]; let wn = 0, rn = 0;
    for (let v = 0; v < nv; v++) for (let u = 0; u < nu; u++) { const c = v * nu + u; if (!cnt[c]) continue; const t = inU(u) && inV(v) ? win : rest; for (let q = 0; q < 3; q++) t[q] += cell[c * 3 + q]; if (t === win) wn += cnt[c]; else rn += cnt[c]; }
    if (!wn || !rn) return undefined;
    const contrast = [0, 1, 2].map(q => win[q] / wn - rest[q] / rn);
    return {
        col: { pitch: cp.lag, phase: ((gu.start + gu.len / 2) / nu * cp.lag) % cp.lag, size: gu.len / nu * cp.lag, ac: cp.ac },
        row: { pitch: rp.lag, phase: ((gv.start + gv.len / 2) / nv * rp.lag) % rp.lag, size: gv.len / nv * rp.lag, ac: rp.ac },
        contrast, contrastE: Math.hypot(contrast[0], contrast[1], contrast[2])
    };
}

export function photoLattice(img: ArrayPhoto, valid: Uint8Array, minP: number, maxP: number, P: WindowArrayParams = WINDOW_ARRAY_PARAMS, profiles = lightnessProfiles(img, valid)): PhotoSeed {
    const W = img.width, H = img.height;
    const { L, A, B, col: colP, row: rowP } = profiles;
    const none: PhotoSeed = { contrastE: 0, clear: false };
    // the candidate pitches on each axis: the strongest correlations, and among them the smallest nearly as strong as the
    // best (the best may be a multiple of the pitch)
    const cands = (prof: Float64Array) => {
        const peaks = autocorrPeaks(prof, minP, maxP).filter(pk => pk.ac >= P.photo.minAutocorr).slice(0, 6);
        return peaks;
    };
    const cps = cands(colP), rps = cands(rowP);
    if (!cps.length || !rps.length) return { ...none, ...(cps.length ? { col: { pitch: cps[0].lag, phase: 0, size: 0, ac: cps[0].ac } } : {}), ...(rps.length ? { row: { pitch: rps[0].lag, phase: 0, size: 0, ac: rps[0].ac } } : {}) };
    // the unit cell at a pair of pitches: the photo folded, the window the interval on each axis darker than the rest, its
    // colour against the rest of the cell
    const fold = (cp: { lag: number; ac: number }, rp: { lag: number; ac: number }): Fold | undefined => foldCell({ L, A, B, W, H, valid }, cp, rp, P);
    // each axis's pitch: among its candidates (the other axis at its strongest), the fold whose window stands out of the
    // cell most clearly, the smaller pitch when within a tenth of the clearest (a storey over the transoms that divide
    // its window, the bay over the pier rhythm folded twice)
    const tried = { col: [] as Array<{ pitch: number; ac: number; contrast: number }>, row: [] as Array<{ pitch: number; ac: number; contrast: number }> };
    const pick = (list: Array<{ lag: number; ac: number }>, other: { lag: number; ac: number }, axis: 'col' | 'row'): { lag: number; ac: number } => {
        const scored = list.map(c => ({ c, f: axis === 'col' ? fold(c, other) : fold(other, c) })).filter((x): x is { c: { lag: number; ac: number }; f: Fold } => !!x.f);
        tried[axis] = scored.map(x => ({ pitch: x.c.lag, ac: x.c.ac, contrast: x.f.contrastE }));
        if (!scored.length) return list[0];
        const best = scored.reduce((a, b) => (b.f.contrastE > a.f.contrastE ? b : a));
        // a sub-multiple of the clearest pitch (its half, third or quarter) that folds nearly as clearly is the pitch
        const sub = scored.filter(x => x.f.contrastE >= P.photo.pitchShare * best.f.contrastE && [2, 3, 4, 5, 6, 7, 8].some(k => Math.abs(x.c.lag * k - best.c.lag) <= P.photo.multiple * x.c.lag)).sort((a, b) => a.c.lag - b.c.lag);
        return (sub[0] ?? best).c;
    };
    const cp = pick(cps, rps[0], 'col'), rp = pick(rps, cp, 'row');
    const f = fold(cp, rp);
    if (!f) return { ...none, col: { pitch: cp.lag, phase: 0, size: 0, ac: cp.ac }, row: { pitch: rp.lag, phase: 0, size: 0, ac: rp.ac }, tried };
    return { ...f, clear: cp.ac >= P.photo.minAutocorr && rp.ac >= P.photo.minAutocorr && f.contrastE >= P.photo.minContrast, tried };
}

export interface ArrayInput { rects: WindowRect[]; panes?: WindowRect[]; generated?: WindowRect[] }
export interface ArrayOutput extends ArrayInput { report: Omit<FacadeArrayReport, 'facadeId'>; sites: number[] }

/**
 * One facade's boxes brought onto its array. `valid` is 1 where the photo may be read (covered, not occluded); `occluded`
 * 1 where something stood in front; `pixel` the photo's texel size (m).
 */
export function inferWindowArray(inputIn: ArrayInput, img: ArrayPhoto, valid: Uint8Array, occluded: Uint8Array | undefined, pixel: number, P: WindowArrayParams = WINDOW_ARRAY_PARAMS, opts: ArrayOptions = {}): ArrayOutput {
    // whole texels: the facade reader's boxes come at fractional pixels, and a texel loop over a fractional box reads
    // nothing (its indices fall between texels)
    const whole = (r: WindowRect): WindowRect => [Math.round(r[0]), Math.round(r[1]), Math.round(r[2]), Math.round(r[3])];
    const input: ArrayInput = { rects: inputIn.rects.map(whole), ...(inputIn.panes ? { panes: inputIn.panes.map(whole) } : {}), ...(inputIn.generated ? { generated: inputIn.generated.map(whole) } : {}) };
    const rects = input.rects, W = img.width, H = img.height;
    let seedReport: FacadeArrayReport['seed'] | undefined;
    const unchanged = (reason: string): ArrayOutput => ({ rects: inputIn.rects, ...(inputIn.panes ? { panes: inputIn.panes } : {}), ...(inputIn.generated ? { generated: inputIn.generated } : {}), report: { boxesIn: rects.length, spans: 0, on: 0, snapped: 0, replaced: 0, added: 0, rejected: 0, ...(seedReport ? { seed: seedReport } : {}), reason }, sites: [] });
    const genSet = new Set((input.generated ?? []).map(r => r.join(',')));
    const boxes = rects.map(r => ({ r, cx: (r[0] + r[2]) / 2, cy: (r[1] + r[3]) / 2, w: r[2] - r[0], h: r[3] - r[1] }));
    const minP = P.pitchM[0] / pixel, maxP = P.pitchM[1] / pixel, bin = Math.max(1, P.binM / pixel);
    // the seed: the photo's own lattice, read before any box (seedLattice below)
    const lab = lightnessProfiles(img, valid), seed = photoLattice(img, valid, minP, maxP, P, lab);
    // the column lattice from every box; a box wider than spanSites pitches (a bay) is then a span, so columns are fitted
    // twice: first from all, then without the spans
    // a pitch is never under the boxes' own size (boxes do not overlap): the typical width for the columns, the typical
    // height of the single-site boxes for the rows
    let col = boxes.length >= 3 ? consensusPitch(boxes.map(b => b.cx), boxes.map(() => 1), Math.max(minP, 0.9 * median(boxes.map(b => b.w))), maxP, bin, P.harmonicTol * median(boxes.map(b => b.w))) : undefined;
    const spanW = (b: { w: number }) => !!col && b.w > P.spanSites * col.pitch;
    const narrow = boxes.filter(b => !spanW(b));
    if (col && narrow.length >= 3) col = consensusPitch(narrow.map(b => b.cx), narrow.map(() => 1), Math.max(minP, 0.9 * median(narrow.map(b => b.w))), maxP, bin, P.harmonicTol * median(narrow.map(b => b.w))) ?? col;
    // the row lattice from the rows the single-site boxes form (strips, taller than spanSites of the typical box, stand aside)
    const typicalH = narrow.length ? median(narrow.map(b => b.h)) : 0;
    const single = narrow.filter(b => b.h <= P.spanSites * typicalH);
    let row: Lattice1D | undefined;
    if (single.length >= P.minBoxes) {
        const rows = rowsOf(single);
        // rows never nearer than the boxes are tall (rows of windows do not overlap)
        row = consensusPitch(rows.map(r => r.cy), rows.map(r => r.members.length), Math.max(minP, median(single.map(b => b.h))), maxP, bin, P.harmonicTol * median(single.map(b => b.h)));
    }
    // the boxes' own lattice and its majority: boxes on a site and of the facade's size (the median of those on a site)
    const majorityOf = (c: Lattice1D, r: Lattice1D, among: typeof boxes) => {
        const onSite = among.filter(b => Math.abs(siteOf(b.cx, c).res) <= P.snapTol && Math.abs(siteOf(b.cy, r).res) <= P.snapTol);
        const w = median(onSite.map(b => b.w)), h = median(onSite.map(b => b.h));
        const on = onSite.filter(b => Math.abs(b.w - w) <= P.sizeTol * w && Math.abs(b.h - h) <= P.sizeTol * h);
        const ofArray = among.filter(b => { const q = (b.w * b.h) / Math.max(1, w * h); return q >= P.areaRange[0] && q <= P.areaRange[1]; });
        return { on, ofArray, w: median(on.map(b => b.w)), h: median(on.map(b => b.h)), holds: on.length >= P.minBoxes && on.length >= P.majority * ofArray.length };
    };
    const boxSingles = col && row ? boxes.filter(b => !(b.w > P.spanSites * col!.pitch || b.h > P.spanSites * row!.pitch)) : [];
    const boxMaj = col && row ? majorityOf(col, row, boxSingles) : undefined;
    // the photo's own evidence for a lattice: the rows and columns whose sites show its window contrast on average
    const projection = (r: WindowRect, D: number[], skip: WindowRect[]): number | undefined => {
        const look = regionLook(img, valid, r);
        if (!look.lab || look.validShare < 1 - P.addMaxUncovered) return undefined;
        const beside = ringLook(img, valid, r, skip);
        if (!beside) return undefined;
        const D2 = D[0] * D[0] + D[1] * D[1] + D[2] * D[2];
        const d = [0, 1, 2].map(k => look.lab![k] - beside[k]);
        return D2 > 1 ? (d[0] * D[0] + d[1] * D[1] + d[2] * D[2]) / D2 : 0;
    };
    const evidenceOf = (c: Lattice1D, r: Lattice1D, bw: number, bh: number, D: number[]): { rows: number; cols: number; rowExtent: number; colExtent: number } => {
        const i0 = Math.ceil((bw / 2 - c.phase) / c.pitch), i1 = Math.floor((W - bw / 2 - c.phase) / c.pitch), j0 = Math.ceil((bh / 2 - r.phase) / r.pitch), j1 = Math.floor((H - bh / 2 - r.phase) / r.pitch);
        if (i1 < i0 || j1 < j0) return { rows: 0, cols: 0, rowExtent: 0, colExtent: 0 };
        const box = (i: number, j: number): WindowRect => { const cx = c.phase + i * c.pitch, cy = r.phase + j * r.pitch; return [Math.round(cx - bw / 2), Math.round(cy - bh / 2), Math.round(cx + bw / 2), Math.round(cy + bh / 2)]; };
        const all: WindowRect[] = []; for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) all.push(box(i, j));
        const pr = new Map<string, number | undefined>();
        for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) pr.set(`${i}:${j}`, projection(box(i, j), D, all));
        const holds = (keys: string[]) => { const v = keys.map(k => pr.get(k)).filter((x): x is number => x !== undefined); return v.length >= 3 && v.reduce((a, x) => a + x, 0) / v.length >= P.addMinContrast; };
        const rows: number[] = [], cols: number[] = [];
        for (let j = j0; j <= j1; j++) if (holds(Array.from({ length: i1 - i0 + 1 }, (_, k) => `${i0 + k}:${j}`))) rows.push(j);
        for (let i = i0; i <= i1; i++) if (holds(Array.from({ length: j1 - j0 + 1 }, (_, k) => `${i}:${j0 + k}`))) cols.push(i);
        // the extent (px) the holding rows and columns span: evidence over a whole slab outweighs a crown's few rows
        return { rows: rows.length, cols: cols.length, rowExtent: rows.length ? (Math.max(...rows) - Math.min(...rows) + 1) * r.pitch : 0, colExtent: cols.length ? (Math.max(...cols) - Math.min(...cols) + 1) * c.pitch : 0 };
    };
    const agree = (a: number, b: number) => Math.abs(a - b) <= P.photo.agree * Math.max(a, b);
    /** k when `big` is k times `small` (k = 2..4) within P.photo.multiple of `small`. */
    const multipleOf = (big: number, small: number): number | undefined => { for (let k = 2; k <= 4; k++) if (Math.abs(big - k * small) <= P.photo.multiple * small) return k; return undefined; };
    // the lattice decided: the boxes', the seed's, or the boxes' with its storeys merged (seedLattice in the doc above)
    let source: 'boxes' | 'photo' | 'merged' = 'boxes';
    let boxW = boxMaj?.w ?? NaN, boxH = boxMaj?.h ?? NaN;
    const seedEv = seed.clear ? evidenceOf(seed.col!, seed.row!, seed.col!.size, seed.row!.size, seed.contrast!) : { rows: 0, cols: 0, rowExtent: 0, colExtent: 0 };
    const seedStands = seed.clear && seedEv.rows >= P.photo.minRows && seedEv.cols >= P.photo.minCols;
    const seedNote = seed.clear ? `photo seed ${r2(seed.col!.pitch * pixel)} x ${r2(seed.row!.pitch * pixel)} m, window ${r2(seed.col!.size * pixel)} x ${r2(seed.row!.size * pixel)} m, contrast ${r2(seed.contrastE)}, ${seedEv.rows} rows and ${seedEv.cols} columns show it` : `no photo seed (${seed.col ? `columns ${r2(seed.col.pitch * pixel)} m at ${r2(seed.col.ac)}` : 'no column pitch'}, ${seed.row ? `rows ${r2(seed.row.pitch * pixel)} m at ${r2(seed.row.ac)}` : 'no row pitch'}, contrast ${r2(seed.contrastE)})`;
    seedReport = { ...(seed.col ? { colPitchM: r3(seed.col.pitch * pixel) } : {}), ...(seed.row ? { rowPitchM: r3(seed.row.pitch * pixel) } : {}), ...(seed.clear ? { windowM: [r3(seed.col!.size * pixel), r3(seed.row!.size * pixel)] as [number, number] } : {}), contrast: r2(seed.contrastE), ...(seed.col && seed.row ? { ac: [r2(seed.col.ac), r2(seed.row.ac)] as [number, number] } : {}), clear: seed.clear, rows: seedEv.rows, cols: seedEv.cols };
    let mergeRows: number | undefined, mergeCols: number | undefined;
    if (!col || !row || !boxMaj!.holds) {
        const why = !col ? 'no column pitch repeats among the boxes' : !row ? `${single.length} single-site boxes${single.length >= P.minBoxes ? ', no row pitch repeats' : `, fewer than ${P.minBoxes}`}` : `${boxMaj!.on.length} of ${boxMaj!.ofArray.length} single-site boxes on their lattice at its size (column pitch ${r2(col.pitch * pixel)} m, row pitch ${r2(row.pitch * pixel)} m): no majority`;
        if (!seedStands) return unchanged(`${why}; ${seedNote}`);
        source = 'photo'; col = seed.col!; row = seed.row!; boxW = seed.col!.size; boxH = seed.row!.size;
    } else if (seed.clear && boxMaj) {
        // boxes that sit cleanly on their lattice keep their pitch against a seed that reads every other column; where the
        // two disagree outright the lattice with the wider evidence wins, clean or not (a crown's louvres read cleanly
        // say nothing about the slab below)
        const clean = boxMaj.on.length >= P.photo.trustOnShare * boxSingles.length;
        // the extent the boxes on their lattice span (px): a crown's few rows against a slab the photo shows whole
        const occRowExtent = Math.max(...boxMaj.on.map(b => b.cy)) - Math.min(...boxMaj.on.map(b => b.cy)) + row.pitch, occColExtent = Math.max(...boxMaj.on.map(b => b.cx)) - Math.min(...boxMaj.on.map(b => b.cx)) + col.pitch;
        const sizeFrom = (seedSize: number, own: number) => (seedSize >= P.photo.sizeRange[0] * own && seedSize <= P.photo.sizeRange[1] * own ? seedSize : own);
        // where the pitches agree the window's size is read from the fold at the boxes' own lattice (its pitch refined
        // over many boxes; a seed pitch a few percent off smears the fold over a tall facade into a narrow core)
        const refold = agree(seed.row!.pitch, row.pitch) || agree(seed.col!.pitch, col.pitch) ? foldCell({ ...lab, W, H, valid }, { lag: agree(seed.col!.pitch, col.pitch) ? col.pitch : seed.col!.pitch, ac: seed.col!.ac }, { lag: agree(seed.row!.pitch, row.pitch) ? row.pitch : seed.row!.pitch, ac: seed.row!.ac }, P) : undefined;
        // the boxes' rows and columns on their lattice: few of them against the seed's, and the seed's pitch and phase
        // are the better refined (a pitch from three rows of a fifty-storey facade is off by the width of a window at the
        // far end; the photo's correlates over every storey)
        const occRows = rowsOf(boxMaj.on).length, occCols = new Set(boxMaj.on.map(b => siteOf(b.cx, col!).k)).size;
        const fewRows = occRows < Math.max(P.photo.minRows, P.photo.fewShare * seedEv.rows), fewCols = occCols < Math.max(P.photo.minCols, P.photo.fewShare * seedEv.cols);
        // rows. A seed pitch a whole multiple of the boxes' is the coarser reading of the same storeys: the boxes' stand,
        // unless the seed's window spans the boxes (then they are sub-boxes of one window, merged)
        const kr = multipleOf(seed.row!.pitch, row.pitch);
        if (agree(seed.row!.pitch, row.pitch)) { if (fewRows && seedStands) { row = seed.row!; boxH = seed.row!.size; source = 'photo'; } else boxH = sizeFrom((refold ?? seed).row!.size, boxH); }
        else if (kr) { if (seed.row!.size >= P.photo.mergeSpan * boxH) { mergeRows = kr; row = seed.row!; boxH = seed.row!.size; source = 'merged'; } }
        else if (seedStands && seedEv.rowExtent >= P.photo.evidenceRatio * occRowExtent) { row = seed.row!; boxH = seed.row!.size; source = 'photo'; }
        // columns: a seed pitch a multiple of the boxes' is the bay over their panes (the boxes' kept); the boxes' a
        // multiple of the seed's is a reading of every other column (the seed's taken)
        const kc = multipleOf(col.pitch, seed.col!.pitch);
        if (agree(seed.col!.pitch, col.pitch)) { if (fewCols && seedStands) { col = seed.col!; boxW = seed.col!.size; source = 'photo'; } else boxW = sizeFrom((refold ?? seed).col!.size, boxW); }
        else if (multipleOf(seed.col!.pitch, col.pitch)) { /* the boxes' columns stand */ }
        else if (kc && !clean && seed.col!.size <= boxW) { mergeCols = kc; col = seed.col!; boxW = seed.col!.size; if (source === 'boxes') source = 'merged'; }
        else if (seedStands && seedEv.colExtent >= P.photo.evidenceRatio * occColExtent) { col = seed.col!; boxW = seed.col!.size; source = 'photo'; }
    }
    // a strip spans sites once the row pitch is known
    const isSpan = (b: { w: number; h: number }) => b.w > P.spanSites * col!.pitch || b.h > P.spanSites * row!.pitch;
    const spans = boxes.filter(isSpan);
    let singles = boxes.filter(b => !isSpan(b));
    // merged storeys (or columns): the boxes standing in one site of the lattice are sub-boxes of one window (a pane, a
    // transom and a spandrel read apart; a window read as its halves) when the window the photo shows spans them: their
    // union is the window, the sub-boxes its panes (photo-inferred)
    let merged = 0;
    if (source === 'boxes' && seed.clear && singles.length) {
        const subW = median(singles.map(b => b.w)), subH = median(singles.map(b => b.h));
        if (boxH >= P.photo.mergeSpan * subH) { mergeRows = Math.round(boxH / subH); source = 'merged'; }
        if (boxW >= P.photo.mergeSpan * subW) { mergeCols = Math.round(boxW / subW); source = 'merged'; }
    }
    if (source === 'merged') {
        const groups = new Map<string, typeof singles>();
        for (const b of singles) { const k = `${siteOf(b.cx, col).k}:${siteOf(b.cy, row).k}`; groups.set(k, [...(groups.get(k) ?? []), b]); }
        const joined: typeof singles = [];
        for (const g of groups.values()) {
            if (g.length < 2) { joined.push(...g); continue; }
            const r: WindowRect = [Math.min(...g.map(b => b.r[0])), Math.min(...g.map(b => b.r[1])), Math.max(...g.map(b => b.r[2])), Math.max(...g.map(b => b.r[3]))];
            joined.push({ r, cx: (r[0] + r[2]) / 2, cy: (r[1] + r[3]) / 2, w: r[2] - r[0], h: r[3] - r[1] });
            input.panes = [...(input.panes ?? []), ...g.map(b => b.r)];
            merged += g.length;
        }
        singles = joined;
    }
    if (source === 'boxes' && singles.length < P.minBoxes) return unchanged(`${singles.length} single-site boxes, fewer than ${P.minBoxes}; ${seedNote}`);
    // tiers: the facade's lattice, then each contiguous run of rows off it tried on its own
    // a row is off the facade's lattice when its centre is, or when its boxes are another size than the facade's (a base
    // of taller windows at another storey pitch can still land within the tolerance of the shaft's rows)
    const rows2 = rowsOf(singles);
    const typW = boxW, typH = boxH;
    const offRow = rows2.map(r => Math.abs(siteOf(r.cy, row!).res) > P.snapTol || Math.abs(median(r.members.map(k => singles[k].w)) - typW) > P.sizeTol * typW || Math.abs(median(r.members.map(k => singles[k].h)) - typH) > P.sizeTol * typH);
    const tiers: ArrayTier[] = [];
    const colRange = (() => { const ks = singles.map(b => siteOf(b.cx, col!).k); return [Math.min(...ks), Math.max(...ks)] as [number, number]; })();
    let k0 = 0;
    while (k0 < rows2.length) {
        if (!offRow[k0]) { k0++; continue; }
        let k1 = k0; while (k1 + 1 < rows2.length && offRow[k1 + 1]) k1++;
        const run = rows2.slice(k0, k1 + 1);
        if (run.length >= P.tierMinRows) {
            const own = consensusPitch(run.map(r => r.cy), run.map(r => r.members.length), Math.max(minP, median(run.flatMap(r => r.members.map(k => singles[k].h)))), maxP, bin, P.harmonicTol * median(run.flatMap(r => r.members.map(k => singles[k].h))));
            if (own) {
                const res = run.map(r => siteOf(r.cy, own).res), rms = Math.sqrt(res.reduce((t, v) => t + v * v, 0) / res.length);
                if (rms <= P.tierRms) {
                    const members = run.flatMap(r => r.members.map(k => singles[k]));
                    const bw = median(members.map(b => b.w)), bh = median(members.map(b => b.h));
                    const y0 = Math.min(...members.map(b => b.cy)) - own.pitch / 2, y1 = Math.max(...members.map(b => b.cy)) + own.pitch / 2;
                    const facadeScore = photoScore(img, valid, col!, row!, bw, bh, y0, y1, colRange), tierScore = photoScore(img, valid, col!, own, bw, bh, y0, y1, colRange);
                    // the facade's own pitch and box, shifted: a band that drifted, not a tier; its rows are snapped instead
                    const sameArray = Math.abs(own.pitch - row!.pitch) <= P.tierPitchDiff * row!.pitch && Math.abs(bh - typH) <= P.sizeTol * typH;
                    if (!sameArray && tierScore >= facadeScore * P.tierGain && tierScore > 0) tiers.push({ y0, y1, rowPitch: own.pitch, rowPhase: own.phase, boxW: bw, boxH: bh, from: 'residual-tier', photoScore: { facade: r2(facadeScore), tier: r2(tierScore) }, rows: run.length });
                }
            }
        }
        k0 = k1 + 1;
    }
    const tierOf = (cy: number): ArrayTier | undefined => tiers.find(t => cy >= t.y0 && cy < t.y1);
    // the facade's own tier: with the boxes' lattice, its box from the boxes on it outside the other tiers; with the seed's
    // (or a merged) lattice, the window the photo shows
    const mainBoxes = singles.filter(b => !tierOf(b.cy));
    const onMain = majorityOf(col, row, mainBoxes).on;
    if (source === 'boxes') { boxW = median(onMain.map(b => b.w)); boxH = median(onMain.map(b => b.h)); if (!(boxW > 0 && boxH > 0)) return unchanged(`no boxes on the lattice outside its tiers; ${seedNote}`); }
    const main: ArrayTier = { y0: -Infinity, y1: Infinity, rowPitch: row.pitch, rowPhase: row.phase, boxW, boxH, from: source === 'boxes' ? 'majority' : source === 'photo' ? 'photo' : 'merged', rows: rowsOf(onMain).length };
    const tierFor = (cy: number): ArrayTier => tierOf(cy) ?? main;
    // every site: key by tier index, row, column
    const tierIndex = (t: ArrayTier) => (t === main ? -1 : tiers.indexOf(t));
    const siteKey = (t: ArrayTier, i: number, j: number) => `${tierIndex(t)}:${i}:${j}`;
    const siteBox = (t: ArrayTier, i: number, j: number): WindowRect => { const cx = col!.phase + i * col!.pitch, cy = t.rowPhase + j * t.rowPitch; return [Math.round(cx - t.boxW / 2), Math.round(cy - t.boxH / 2), Math.round(cx + t.boxW / 2), Math.round(cy + t.boxH / 2)]; };
    const taken = new Map<string, number>(); // site -> output index
    const out: Array<{ r: WindowRect; kind: number; conf: number; res: number; src?: number; panes?: WindowRect[] }> = [];
    const panesOf = (r: WindowRect): WindowRect[] => (input.panes ?? []).filter(p => p[0] >= r[0] - 1 && p[2] <= r[2] + 1 && p[1] >= r[1] - 1 && p[3] <= r[3] + 1);
    const movePanes = (from: WindowRect, to: WindowRect, panes: WindowRect[]): WindowRect[] => {
        const sx = (to[2] - to[0]) / Math.max(1, from[2] - from[0]), sy = (to[3] - to[1]) / Math.max(1, from[3] - from[1]);
        return panes.map(p => [Math.round(to[0] + (p[0] - from[0]) * sx), Math.round(to[1] + (p[1] - from[1]) * sy), Math.round(to[0] + (p[2] - from[0]) * sx), Math.round(to[1] + (p[3] - from[1]) * sy)] as WindowRect);
    };
    let rmsInSum = 0, rmsInN = 0, rejected = 0, folded = 0;
    const siteCy = (t: ArrayTier, j: number) => t.rowPhase + j * t.rowPitch;
    // spans first. A facade read mostly as cells is one array: a strip standing on a lattice column (one column wide) is a
    // column of its cells, folded into the sites it covers (photo-inferred: the strip was read there), its panes going to
    // the cell they lie in. A bay wider than a column, or a strip on a facade read mostly as strips, is kept whole and its
    // sites taken
    const foldStrips = singles.length >= spans.length || (seed.clear && agree(seed.row!.pitch, row.pitch));
    for (const b of spans) {
        const ci = siteOf(b.cx, col);
        if (foldStrips && b.w <= P.spanSites * col.pitch && Math.abs(ci.res) <= P.snapTol) {
            const own = panesOf(b.r);
            let n = 0;
            for (const t of [main, ...tiers]) {
                const j0 = Math.ceil((b.r[1] - t.rowPhase) / t.rowPitch), j1 = Math.floor((b.r[3] - t.rowPhase) / t.rowPitch);
                for (let j = j0; j <= j1; j++) {
                    const cy = siteCy(t, j);
                    if (tierFor(cy) !== t) continue;
                    const key = siteKey(t, ci.k, j);
                    if (taken.has(key)) continue;
                    const r = siteBox(t, ci.k, j);
                    const panes = own.filter(q => (q[1] + q[3]) / 2 >= r[1] && (q[1] + q[3]) / 2 < r[3]).map(q => [Math.max(r[0], q[0]), Math.max(r[1], q[1]), Math.min(r[2], q[2]), Math.min(r[3], q[3])] as WindowRect).filter(q => q[2] > q[0] && q[3] > q[1]);
                    taken.set(key, out.push({ r, kind: SITE_KIND.folded, conf: r3(0.6 * (1 - Math.abs(ci.res) / P.snapTol)), res: r3(Math.abs(ci.res)), src: boxes.indexOf(b), ...(panes.length ? { panes } : {}) }) - 1); n++;
                }
            }
            if (n) { folded++; continue; }
        }
        const idx = out.push({ r: b.r, kind: SITE_KIND.span, conf: 1, res: 0, panes: panesOf(b.r) }) - 1;
        for (const t of [main, ...tiers]) {
            const i0 = siteOf(b.r[0], col).k, i1 = siteOf(b.r[2], col).k, j0 = siteOf(b.r[1], { pitch: t.rowPitch, phase: t.rowPhase }).k, j1 = siteOf(b.r[3], { pitch: t.rowPitch, phase: t.rowPhase }).k;
            for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) { const s = siteBox(t, i, j); const ov = Math.max(0, Math.min(s[2], b.r[2]) - Math.max(s[0], b.r[0])) * Math.max(0, Math.min(s[3], b.r[3]) - Math.max(s[1], b.r[1])); if (ov > 0.3 * (s[2] - s[0]) * (s[3] - s[1])) taken.set(siteKey(t, i, j), idx); }
        }
    }
    // members on their sites first (so an outlier never takes a member's site), then the outliers
    const classified = singles.map(b => {
        const t = tierFor(b.cy), ci = siteOf(b.cx, col!), rj = siteOf(b.cy, { pitch: t.rowPitch, phase: t.rowPhase });
        const dist = Math.hypot(ci.res, rj.res), onSite = Math.abs(ci.res) <= P.snapTol && Math.abs(rj.res) <= P.snapTol;
        const sizeOk = Math.abs(b.w - t.boxW) <= P.sizeTol * t.boxW && Math.abs(b.h - t.boxH) <= P.sizeTol * t.boxH;
        const areaRatio = (b.w * b.h) / Math.max(1, t.boxW * t.boxH), ofArray = areaRatio >= P.areaRange[0] && areaRatio <= P.areaRange[1];
        rmsInSum += dist * dist; rmsInN++;
        return { b, t, i: ci.k, j: rj.k, ci: ci.res, rj: rj.res, dist, onSite, sizeOk, ofArray };
    }).sort((a, b) => (a.onSite && a.sizeOk ? 0 : 1) - (b.onSite && b.sizeOk ? 0 : 1) || a.dist - b.dist);
    for (const c of classified) {
        // a box far from the array's size (a small opening on a facade of strips, a doorway among windows) is not of the
        // array: kept as read, taking no site
        if (!c.ofArray) { out.push({ r: c.b.r, kind: SITE_KIND.kept, conf: 1, res: r3(c.dist), src: boxes.indexOf(c.b), panes: panesOf(c.b.r) }); continue; }
        // on the seed's lattice a box of another size is the reader's, not the array's (a crown's louvres over a slab):
        // kept as read, never moved or replaced; one of the lattice's size off its site is a window drifted, snapped
        if (source === 'photo' && !c.sizeOk) { out.push({ r: c.b.r, kind: SITE_KIND.kept, conf: 1, res: r3(c.dist), src: boxes.indexOf(c.b), panes: panesOf(c.b.r) }); continue; }
        const key = siteKey(c.t, c.i, c.j);
        if (taken.has(key)) { rejected++; continue; }
        const site = siteBox(c.t, c.i, c.j);
        // on its site within settleTol and of the lattice box's size within keepSizeTol: left as read
        const keepSize = Math.abs(c.b.w - c.t.boxW) <= P.keepSizeTol * c.t.boxW && Math.abs(c.b.h - c.t.boxH) <= P.keepSizeTol * c.t.boxH;
        if (c.onSite && keepSize && Math.abs(c.ci) <= P.settleTol && Math.abs(c.rj) <= P.settleTol) { taken.set(key, out.push({ r: c.b.r, kind: SITE_KIND.on, conf: r3(1 - c.dist / (P.snapTol * Math.SQRT2)), res: r3(c.dist), src: boxes.indexOf(c.b), panes: panesOf(c.b.r) }) - 1); continue; }
        // moved onto its site as the lattice's box (a box read off its site was read in a dim or smeared part of the photo,
        // and its size with it; one array has one box), its own panes carried into it; replaced when its size was off too
        if (c.sizeOk) taken.set(key, out.push({ r: site, kind: SITE_KIND.snapped, conf: r3(0.5 * (1 - Math.min(1, c.dist))), res: r3(c.dist), src: boxes.indexOf(c.b), panes: movePanes(c.b.r, site, panesOf(c.b.r)) }) - 1);
        else taken.set(key, out.push({ r: site, kind: SITE_KIND.replaced, conf: r3(0.4 * (1 - Math.min(1, c.dist))), res: r3(c.dist), src: boxes.indexOf(c.b) }) - 1);
    }
    // a lattice that puts many boxes two to a site (a pitch twice the facade's, two readings of one storey) does not
    // explain the boxes: nothing is changed
    if (source === 'boxes' && rejected > P.maxRejectedShare * singles.length) return unchanged(`${rejected} of ${singles.length} single-site boxes would be a second box on a taken site (column pitch ${r2(col.pitch * pixel)} m, row pitch ${r2(row.pitch * pixel)} m): the lattice does not explain them`);
    // the pane layout of the nearest box on the lattice with panes, for a replaced or added box
    const withPanes = out.filter(o => o.kind === SITE_KIND.on && o.panes?.length);
    const templatePanes = (r: WindowRect): WindowRect[] => {
        if (!withPanes.length) return [];
        const cx = (r[0] + r[2]) / 2, cy = (r[1] + r[3]) / 2;
        let best = withPanes[0], bd = Infinity;
        for (const o of withPanes) { const d = Math.hypot((o.r[0] + o.r[2]) / 2 - cx, (o.r[1] + o.r[3]) / 2 - cy); if (d < bd) { bd = d; best = o; } }
        return movePanes(best.r, r, best.panes!);
    };
    for (const o of out) if (o.kind === SITE_KIND.replaced || (o.kind === SITE_KIND.folded && !o.panes?.length)) o.panes = templatePanes(o.r);
    const members = out.filter(o => o.kind === SITE_KIND.on || o.kind === SITE_KIND.snapped || o.kind === SITE_KIND.replaced || o.kind === SITE_KIND.folded);
    // each member's contrast: its look less the wall's around it (the ring beside, above and below it, outside every box);
    // a site is a window when it shows at least addMinContrast of its neighbours' contrast in the same direction, whatever
    // the light
    const besideOf = (r: WindowRect, _bw: number, skip: WindowRect[]): number[] | undefined => ringLook(img, valid, r, skip);
    const allBoxes = out.map(o => o.r);
    const memberLook = members.map(o => {
        const inside = regionLook(img, valid, o.r).lab, beside = besideOf(o.r, o.r[2] - o.r[0], allBoxes);
        return { o, cy: (o.r[1] + o.r[3]) / 2, contrast: inside && beside ? [0, 1, 2].map(k => inside[k] - beside[k]) : undefined };
    });
    const occ = occluded;
    const share = (m: ArrayLike<number> | undefined, r: WindowRect, set: boolean): number => {
        if (!m) return 0;
        let n = 0, hit = 0;
        for (let y = Math.max(0, r[1]); y < Math.min(H, r[3]); y++) for (let x = Math.max(0, r[0]); x < Math.min(W, r[2]); x++) { n++; if (!!m[y * W + x] === set) hit++; }
        return n ? hit / n : 1;
    };
    // the array's extent and its empty sites. The pattern is the facade's, not a site's: every lattice row and column the
    // photo spans is judged by its sites together (it holds the array when extentShare of its sites hold a box, or its sites
    // show the neighbours' window contrast on average), and inside the rows and columns that hold it every empty site takes
    // the lattice's box (generated) unless the photo contradicts it (the site reads the opposite way to a window against the
    // wall beside it), something stood in front of it, or it lies under a bay. A site the photo never reached is filled when
    // boxes flank it (left and right, or above and below). Outside those rows and columns nothing is added: the array stops
    // where its evidence does
    const sites = out.map(o => o.r);
    let added = 0, rowsIn = 0, colsIn = 0, continuedRows = 0, continuedCols = 0, continuedSites = 0;
    const empty = { sites: 0, outside: 0, uncovered: 0, occluded: 0, wall: 0, underBox: 0, byRow: 0 };
    const projOf = (r: WindowRect, t: ArrayTier, cy: number): number | undefined => {
        const look = regionLook(img, valid, r);
        if (!look.lab || look.validShare < 1 - P.addMaxUncovered) return undefined;
        const peers = memberLook.filter(m => m.contrast && Math.abs(m.cy - cy) <= P.peerRows * t.rowPitch + 1);
        const use = peers.length ? peers : memberLook.filter(m => m.contrast);
        const beside = besideOf(r, t.boxW, sites);
        if (!beside || (!use.length && !seed.contrast)) return undefined;
        const D = use.length ? [0, 1, 2].map(k => use.reduce((a, m) => a + m.contrast![k], 0) / use.length) : seed.contrast!, D2 = D[0] * D[0] + D[1] * D[1] + D[2] * D[2];
        const d = [0, 1, 2].map(k => look.lab![k] - beside[k]);
        return D2 > 1 ? (d[0] * D[0] + d[1] * D[1] + d[2] * D[2]) / D2 : 0;
    };
    const i0 = Math.ceil((main.boxW / 2 - col.phase) / col.pitch), i1 = Math.floor((W - main.boxW / 2 - col.phase) / col.pitch);
    for (const t of [main, ...tiers]) {
        const j0 = Math.ceil((t.boxH / 2 - t.rowPhase) / t.rowPitch), j1 = Math.floor((H - t.boxH / 2 - t.rowPhase) / t.rowPitch);
        const js: number[] = [];
        for (let j = j0; j <= j1; j++) if (tierFor(siteCy(t, j)) === t) js.push(j);
        if (!js.length) continue;
        // each site scored once: occupied, or its contrast projection (undefined where unread)
        const occupied = new Map<string, boolean>(), proj = new Map<string, number | undefined>();
        for (const j of js) for (let i = i0; i <= i1; i++) {
            const key = siteKey(t, i, j);
            if (taken.has(key)) { occupied.set(key, true); continue; }
            proj.set(key, projOf(siteBox(t, i, j), t, siteCy(t, j)));
        }
        // the array's extent: the rows and columns that hold boxes (extentShare of their sites), and from them outward,
        // row by row and column by column, every next one whose sites show the window contrast on average, to the
        // photo's edge if they do; the step stops at the first that does not (a crown's lattice is carried down a slab
        // only as far as the slab shows it, storey by storey). With no occupied row (the seed's lattice over a plane
        // nothing read), the step starts from the row and column showing the contrast most clearly
        const byOcc = (keys: string[]) => keys.filter(k => occupied.get(k)).length >= P.extentShare * keys.length;
        const byContrast = (keys: string[]): number | undefined => { const v = keys.map(k => proj.get(k)).filter((x): x is number => x !== undefined); return v.length >= 3 ? v.reduce((a, x) => a + x, 0) / v.length : undefined; };
        const holds = (keys: string[], bar: number = P.addMinContrast) => byOcc(keys) || (byContrast(keys) ?? -Infinity) >= bar;
        const rowKeysOf = (j: number) => Array.from({ length: i1 - i0 + 1 }, (_, k) => siteKey(t, i0 + k, j));
        // a row or column is blank when its sites' texels are mostly unreached, occluded (something stood before it: the
        // array continues over it, as the lattice does) or featureless (a smear, a hole refilled with nothing to read)
        const blankOf = (keys: string[], boxes: WindowRect[]): boolean => {
            let n = 0, blank = 0;
            for (const r of boxes) for (let y = Math.max(0, r[1]); y < Math.min(H, r[3]); y++) for (let x = Math.max(0, r[0]); x < Math.min(W, r[2]); x++) { n++; const k = y * W + x; if (!valid[k] || opts.featureless?.[k]) blank++; }
            const occ = keys.filter(k => occupied.get(k)).length;
            return n > 0 && blank >= P.blankShare * n && occ < P.extentShare * keys.length;
        };
        const rowKeys = (j: number) => Array.from({ length: i1 - i0 + 1 }, (_, k) => siteKey(t, i0 + k, j)), rowBoxes = (j: number) => Array.from({ length: i1 - i0 + 1 }, (_, k) => siteBox(t, i0 + k, j));
        const colKeys = (i: number) => js.map(j => siteKey(t, i, j)), colBoxes = (i: number) => js.map(j => siteBox(t, i, j));
        const rowBlank = new Map(js.map(j => [j, blankOf(rowKeys(j), rowBoxes(j))] as const)), colBlank = new Map<number, boolean>();
        for (let i = i0; i <= i1; i++) colBlank.set(i, blankOf(colKeys(i), colBoxes(i)));
        /**
         * The rows (columns) that hold the array and those it steps on into. From the rows holding boxes (or, with none,
         * the row showing the contrast most clearly) outward: each next row is entered while it shows the contrast
         * (P.stepContrast); a blank run is crossed, and continued (generated), when the first row read beyond it holds
         * again; the walk stops at a row that reads and does not hold (the evidence changes: a screen, a setback), and at
         * a blank run that no held row closes (the photo's edge, or another surface beyond it)
         */
        const walk = (idx: number[], keysOf: (v: number) => string[], blank: (v: number) => boolean): { inSet: Set<number>; cont: Set<number> } => {
            const inSet = new Set(idx.filter(v => byOcc(keysOf(v)))), cont = new Set<number>();
            if (!inSet.size) {
                let best: number | undefined, bestC = -Infinity;
                for (const v of idx) { const c = byContrast(keysOf(v)); if (c !== undefined && c > bestC) { bestC = c; best = v; } }
                if (best === undefined || bestC < P.addMinContrast) return { inSet, cont };
                inSet.add(best);
            }
            const sorted = [...idx].sort((a, b) => a - b), lo = sorted.findIndex(v => inSet.has(v)), hi = sorted.length - 1 - [...sorted].reverse().findIndex(v => inSet.has(v));
            // between the extremes that hold boxes: each by its own evidence, a blank one continued
            for (let q = lo; q <= hi; q++) { const v = sorted[q]; if (holds(keysOf(v))) inSet.add(v); else if (blank(v)) cont.add(v); }
            for (const dir of [-1, 1]) {
                let q = (dir < 0 ? lo : hi) + dir;
                while (q >= 0 && q < sorted.length) {
                    const v = sorted[q];
                    if (holds(keysOf(v), P.stepContrast)) { inSet.add(v); q += dir; continue; }
                    if (!blank(v)) break;
                    let e = q; while (e + dir >= 0 && e + dir < sorted.length && blank(sorted[e + dir]) && !holds(keysOf(sorted[e + dir]), P.stepContrast)) e += dir;
                    const next = e + dir;
                    if (!(next >= 0 && next < sorted.length) || !holds(keysOf(sorted[next]), P.stepContrast)) break;
                    for (let w = q; w !== next; w += dir) cont.add(sorted[w]);
                    inSet.add(sorted[next]); q = next + dir;
                }
            }
            return { inSet, cont };
        };
        const rw = walk(js, rowKeysOf, j => rowBlank.get(j)!), rowIn = rw.inSet, rowCont = rw.cont;
        const cw = rowIn.size ? walk(Array.from({ length: i1 - i0 + 1 }, (_, k) => i0 + k), i => [...rowIn].map(j => siteKey(t, i, j)), i => colBlank.get(i)!) : { inSet: new Set<number>(), cont: new Set<number>() };
        const colIn = cw.inSet, colCont = cw.cont;
        rowsIn += rowIn.size; colsIn = Math.max(colsIn, colIn.size);
        // up from the highest holding row to the building's roof line, through blank rows only, when the envelope is
        // given (a blank band above the array's top with no envelope may be another surface or the sky)
        const jsSorted = [...js].sort((a, b) => a - b), held = jsSorted.filter(j => rowIn.has(j));
        if (held.length && opts.minRowPx !== undefined) for (let q = jsSorted.indexOf(held[0]) - 1; q >= 0; q--) {
            const j = jsSorted[q];
            if (rowIn.has(j) || rowCont.has(j)) continue;
            if (!rowBlank.get(j) || siteCy(t, j) - t.boxH / 2 < opts.minRowPx) break;
            rowCont.add(j);
        }
        continuedRows += rowCont.size; continuedCols = Math.max(continuedCols, colCont.size);
        for (const j of js) for (let i = i0; i <= i1; i++) {
            const key = siteKey(t, i, j);
            if (occupied.get(key)) continue;
            empty.sites++;
            const inRow = rowIn.has(j), inCol = colIn.has(i), contRow = rowCont.has(j), contCol = colCont.has(i);
            const continuing = (contRow && (inCol || contCol)) || (inRow && contCol);
            if (!((inRow && inCol) || continuing)) { empty.outside++; continue; }
            const r = siteBox(t, i, j);
            if (opts.minRowPx !== undefined && r[1] < opts.minRowPx) { empty.outside++; continue; }
            if (sites.some(q => Math.max(0, Math.min(q[2], r[2]) - Math.max(q[0], r[0])) * Math.max(0, Math.min(q[3], r[3]) - Math.max(q[1], r[1])) > 0.2 * (r[2] - r[0]) * (r[3] - r[1]))) { empty.underBox++; continue; }
            // an occluded site (something stood before it) inside the array: the array continues over it, as the lattice
            // does over an occluded span (generated, counted)
            if (share(occ, r, true) > P.addMaxOccluded) {
                empty.occluded++;
                taken.set(key, out.push({ r, kind: SITE_KIND.continued, conf: 0.25, res: 0, panes: templatePanes(r) }) - 1);
                occupied.set(key, true); sites.push(r); continuedSites++;
                continue;
            }
            if (continuing) {
                // stepped on into a blank row or column: generated, on the array's pitch and phase alone
                taken.set(key, out.push({ r, kind: SITE_KIND.continued, conf: 0.25, res: 0, panes: templatePanes(r) }) - 1);
                occupied.set(key, true); sites.push(r); continuedSites++;
                continue;
            }
            const p = proj.get(key);
            // the array is the facade's: inside the rows and columns that hold it a site is withheld only when the photo
            // reads the opposite of a window there; one it never reached, or one too dim to confirm, is filled on the
            // array's evidence (and counted)
            if (p !== undefined && p < P.contradict) { empty.wall++; continue; }
            if (p === undefined) empty.uncovered++;
            else if (p < P.addMinContrast) empty.byRow++;
            taken.set(key, out.push({ r, kind: SITE_KIND.added, conf: r3(p === undefined ? 0.3 : 0.3 + 0.7 * Math.min(1, Math.max(0, p))), res: 0, panes: templatePanes(r) }) - 1);
            occupied.set(key, true); sites.push(r); added++;
        }
    }
    // the output
    let rmsOutSum = 0, rmsOutN = 0;
    for (const o of out) if (o.kind !== SITE_KIND.span && o.kind !== SITE_KIND.kept) { const t = tierFor((o.r[1] + o.r[3]) / 2); const d = Math.hypot(siteOf((o.r[0] + o.r[2]) / 2, col).res, siteOf((o.r[1] + o.r[3]) / 2, { pitch: t.rowPitch, phase: t.rowPhase }).res); rmsOutSum += d * d; rmsOutN++; }
    const order = out.map((_, k) => k).sort((a, b) => cmpRect(out[a].r, out[b].r));
    const outRects = order.map(k => out[k].r), outPanes = order.flatMap(k => out[k].panes ?? []).sort(cmpRect);
    const outGenerated = order.flatMap(k => { const o = out[k]; return o.kind === SITE_KIND.added || o.kind === SITE_KIND.continued || (o.src !== undefined && o.src >= 0 && genSet.has(boxes[o.src].r.join(','))) ? [o.r] : []; }).sort(cmpRect);
    const count = (kind: number) => out.filter(o => o.kind === kind).length;
    const report: Omit<FacadeArrayReport, 'facadeId'> = {
        boxesIn: rects.length, spans: spans.length, colPitchM: r3(col.pitch * pixel), colPhaseM: r3(col.phase * pixel), cols: colRange[1] - colRange[0] + 1,
        tiers: [main, ...tiers].map(t => ({ rowPitchM: r3(t.rowPitch * pixel), rowPhaseM: r3(t.rowPhase * pixel), rows: t.rows, boxM: [r3(t.boxW * pixel), r3(t.boxH * pixel)] as [number, number], from: t.from, ...(t.photoScore ? { photoScore: t.photoScore } : {}) })),
        on: count(SITE_KIND.on), snapped: count(SITE_KIND.snapped), replaced: count(SITE_KIND.replaced), added, rejected, folded, kept: count(SITE_KIND.kept), rowsIn, colsIn,
        source, seed: seedReport, ...(merged ? { merged, mergedBy: { ...(mergeRows ? { rows: mergeRows } : {}), ...(mergeCols ? { cols: mergeCols } : {}) } } : {}),
        ...(continuedSites ? { continued: { rows: continuedRows, cols: continuedCols, sites: continuedSites, reason: CONTINUED_REASON } } : {}),
        rmsIn: r3(Math.sqrt(rmsInSum / Math.max(1, rmsInN))), rmsOut: r3(Math.sqrt(rmsOutSum / Math.max(1, rmsOutN))), empty
    };
    return { rects: outRects, panes: outPanes, ...(outGenerated.length ? { generated: outGenerated } : {}), report, sites: order.flatMap(k => { const o = out[k]; return [...o.r, o.kind, o.conf, o.res]; }) };
}

/** A facade's photo and masks as the array reads them. */
export function facadePhotoFor(dir: string, f: { image: string; width: number; height: number; uncoveredMask?: string; occludedMask?: string }): { img: ArrayPhoto; valid: Uint8Array; occluded?: Uint8Array; featureless?: Uint8Array } | undefined {
    const file = path.join(dir, f.image);
    if (!fs.existsSync(file)) return undefined;
    const img = decodePng(fs.readFileSync(file));
    if (img.width !== f.width || img.height !== f.height) return undefined;
    const n = img.width * img.height, valid = new Uint8Array(n);
    const mf = f.uncoveredMask ? path.join(dir, f.uncoveredMask) : undefined;
    if (mf && fs.existsSync(mf)) { const m = decodePng(fs.readFileSync(mf)); for (let k = 0; k < n; k++) valid[k] = m.rgba[k * 4] >= 128 ? 0 : 1; }
    else for (let k = 0; k < n; k++) valid[k] = img.rgba[k * 4 + 3] === 0 || (img.rgba[k * 4] === 128 && img.rgba[k * 4 + 1] === 128 && img.rgba[k * 4 + 2] === 128) ? 0 : 1;
    const occluded = readOccluded(dir, f, img.width, img.height);
    if (occluded && countSet(occluded)) for (let k = 0; k < n; k++) if (occluded[k]) valid[k] = 0;
    const ff = path.join(dir, featurelessMaskName(f.image));
    let featureless: Uint8Array | undefined;
    if (fs.existsSync(ff)) { const m = decodePng(fs.readFileSync(ff)); if (m.width === img.width && m.height === img.height) { featureless = new Uint8Array(n); for (let k = 0; k < n; k++) featureless[k] = m.rgba[k * 4] >= 128 ? 1 : 0; } }
    return { img, valid, ...(occluded ? { occluded } : {}), ...(featureless ? { featureless } : {}) };
}

type FitEntry = Extract<WindowFitFile['facades'][number], { rects: WindowRect[] }> & { array?: ArrayRecord };

/**
 * Every facade of window_fit.json brought onto its array (the file rewritten in place). An entry already carrying this
 * version is left; one carrying another is restored to its pre-array boxes and inferred again.
 */
export function inferWindowArrays(orthosDir: string, fit: WindowFitFile, P: WindowArrayParams = WINDOW_ARRAY_PARAMS, opts: { /** The building's roof line (world Y): the array steps into an unreached band at a photo's top edge only below it. */ envelopeTopY?: number } = {}): WindowArrayReport {
    const t0 = Date.now();
    const frames = (JSON.parse(fs.readFileSync(path.join(orthosDir, 'facades.json'), 'utf8')).facades as Array<{ facadeId: number; image: string; width: number; height: number; pixel: number; uncoveredMask?: string; occludedMask?: string; centroid?: number[]; axisT?: number[]; orthoTMax?: number }>);
    const facades: FacadeArrayReport[] = [];
    for (const entry of fit.facades) {
        if ('error' in entry) continue;
        const e = entry as FitEntry;
        if (e.array?.version === WINDOW_ARRAY_VERSION) { facades.push({ facadeId: e.facadeId, ...e.array.report }); continue; }
        if (e.array) { e.rects = e.array.in.rects; if (e.array.in.panes) e.panes = e.array.in.panes; else delete e.panes; if (e.array.in.generated) e.generated = e.array.in.generated; else delete e.generated; delete e.array; }
        const f = frames.find(x => x.facadeId === e.facadeId);
        const photo = f && f.width === e.width && f.height === e.height ? facadePhotoFor(orthosDir, f) : undefined;
        if (!f || !photo) { facades.push({ facadeId: e.facadeId, boxesIn: e.rects.length, spans: 0, on: 0, snapped: 0, replaced: 0, added: 0, rejected: 0, reason: 'no photo of the entry\'s size' }); continue; }
        // the roof line in the photo: world Y = centroid.y + t axisT.y, t = orthoTMax - y pixel (the plane frame)
        let minRowPx: number | undefined;
        if (opts.envelopeTopY !== undefined && f.centroid && f.axisT && f.orthoTMax !== undefined && Math.abs(f.axisT[1]) > 1e-6) {
            const tTop = (opts.envelopeTopY - f.centroid[1]) / f.axisT[1];
            minRowPx = Math.max(0, (f.orthoTMax - tTop) / f.pixel);
        }
        const out = inferWindowArray({ rects: e.rects, ...(e.panes ? { panes: e.panes } : {}), ...(e.generated ? { generated: e.generated } : {}) }, photo.img, photo.valid, photo.occluded, f.pixel, P, { ...(photo.featureless ? { featureless: photo.featureless } : {}), ...(minRowPx !== undefined ? { minRowPx } : {}) });
        facades.push({ facadeId: e.facadeId, ...out.report });
        if (out.report.reason) continue;
        e.array = { version: WINDOW_ARRAY_VERSION, in: { rects: e.rects, ...(e.panes ? { panes: e.panes } : {}), ...(e.generated ? { generated: e.generated } : {}) }, report: out.report, sites: out.sites };
        e.rects = out.rects; e.panes = out.panes ?? []; if (out.generated) e.generated = out.generated; else delete e.generated;
    }
    (fit as WindowFitFile & { array?: string }).array = WINDOW_ARRAY_VERSION;
    fs.writeFileSync(path.join(orthosDir, WINDOW_FIT_FILE), JSON.stringify(fit));
    return { version: WINDOW_ARRAY_VERSION, params: P, facades, ms: Date.now() - t0 };
}

/** The extras of a facade's array for the GLB (sbFacadeLattice.windows.array): its lattice, counts, and the snapped and replaced boxes' UVs. */
export function arrayExtras(fit: WindowFitFile, facadeId: number): Record<string, unknown> | undefined {
    const e = fit.facades.find(x => x.facadeId === facadeId) as FitEntry | undefined;
    if (!e || 'error' in e || !e.array || e.array.report.reason) return undefined;
    const a = e.array, q = (v: number) => Math.round(v * 10000) / 10000;
    const uvs = (kind: number): number[] => { const o: number[] = []; for (let k = 0; k + 6 < a.sites.length; k += 7) if (a.sites[k + 4] === kind) o.push(q(a.sites[k] / e.width), q(a.sites[k + 1] / e.height), q(a.sites[k + 2] / e.width), q(a.sites[k + 3] / e.height)); return o; };
    return {
        version: a.version, latticeFrom: a.report.source, seed: a.report.seed, ...(a.report.merged ? { merged: a.report.merged } : {}), colPitchM: a.report.colPitchM, tiers: a.report.tiers, boxesIn: a.report.boxesIn, on: a.report.on, snapped: a.report.snapped, replaced: a.report.replaced, added: a.report.added, rejected: a.report.rejected, rmsIn: a.report.rmsIn, rmsOut: a.report.rmsOut,
        snapped_uv: uvs(SITE_KIND.snapped), replaced_uv: uvs(SITE_KIND.replaced), folded_uv: uvs(SITE_KIND.folded), continued_uv: uvs(SITE_KIND.continued), snappedLabel: 'photo-inferred', addedLabel: 'generated', ...(a.report.continued ? { continued: a.report.continued } : {}),
        source: "the facade's window array: the photo's own periodicity (its lightness profiles autocorrelated, the fold at those pitches) seeding column and storey pitches that the boxes refine by consensus, each box moved to its site or replaced by the lattice's, empty sites filled row by row and column by column as far as the photo shows the array (window-array.ts)"
    };
}

/** One line for the build's notes. */
export function describeWindowArrays(r: WindowArrayReport): string {
    const done = r.facades.filter(f => !f.reason), left = r.facades.filter(f => f.reason);
    const sum = (k: 'boxesIn' | 'on' | 'snapped' | 'replaced' | 'added' | 'rejected') => done.reduce((t, f) => t + f[k], 0);
    const tiers = done.reduce((t, f) => t + (f.tiers?.length ?? 1), 0), folded = done.reduce((t, f) => t + (f.folded ?? 0), 0);
    const by = (k: FacadeArrayReport['source']) => done.filter(f => f.source === k).length, merged = done.reduce((t, f) => t + (f.merged ?? 0), 0);
    return `window arrays (${r.version}): ${done.length} of ${r.facades.length} facades brought onto their array (${tiers} tiers; the lattice from the boxes on ${by('boxes')}, from the photo's own periodicity on ${by('photo')}, the boxes' with ${merged} sub-boxes merged into their windows on ${by('merged')}; of ${sum('boxesIn')} boxes ${sum('on')} on the lattice, ${sum('snapped')} moved to their site, ${sum('replaced')} replaced by the lattice's box and ${folded} strips folded into its cells (photo-inferred), ${sum('rejected')} dropped, ${done.reduce((t, f) => t + (f.kept ?? 0), 0)} of another size kept as read; ${sum('added')} added at the empty sites inside the rows and columns the array holds, where the photo does not read the opposite of a window, and ${done.reduce((t, f) => t + (f.continued?.sites ?? 0), 0)} stepped on into blank bands the photo never reached or left featureless (generated))${left.length ? `; ${left.length} left as fitted (${left.slice(0, 3).map(f => `${f.facadeId}: ${f.reason}`).join('; ')}${left.length > 3 ? '; ...' : ''})` : ''}`;
}
