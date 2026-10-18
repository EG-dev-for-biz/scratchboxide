/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Facade grammar: an ordinary facade repeats, and a photo shows how. The vision model reads the facade's openings from a
 * fronto-parallel orthophoto of the tile texture (tile_refine --relief-orthos: every texel already has its metric place on
 * the facade plane, so no camera pose is involved), as tiers of openings, each tier a band along the facade's height with
 * its own opening columns. The reading is fitted to the facade's metric frame as continuous numbers (opening bands per
 * storey, bay centres and widths, storey heights), regularised into one lattice per facade, and then measured:
 *
 *  (a) the scan: every opening lies on the measured facade within the fit's residual tolerance (PHOTO_CORRECTION_TOLERANCE_M),
 *      and at least half the windows the relief measured on the scan's own photo texture (tile_refine's observed cells)
 *      fall in the grammar's openings within that tolerance;
 *  (b) held-out evidence: the facade is read again from each half of the orthophoto alone, and the grammar read from one
 *      half predicts the openings of the other. Its edges there must agree with the photo better than the relief's own
 *      lattice does (symmetric edge chamfer lower by HELD_OUT_MIN_CHAMFER_GAIN_PX, structural gradient NCC not lower). The
 *      half it is scored on was not shown to it; the relief's lattice there was made from that very photo.
 *
 * Only a grammar passing both is used: tile_refine then takes it as that facade's window lattice (the photo's own cells
 * snap onto it; its other openings are carved only where the photo is no brighter than their frame). Everything it
 * carves is photo-inferred, with the confidence here. The model proposes; the measurement decides.
 *
 * Nothing here knows what a building or an opening is called: a tier is two numbers and a list of intervals, labels are
 * the model's own words and are never read.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { VisionModelChain } from '../../gemini/vision-model-chain';
import { PHOTO_CORRECTION_TOLERANCE_M } from '../../../common/spatial/staged-location-contracts';
import { distanceTransform, gaussianBlur, sobel } from '../../spatial/StreetViewPoseRegistrar';
import { encodePng } from './png-encode';
import { decodeImageInMemory } from './tile-texture-transfer';

export const FACADE_GRAMMAR_PROMPT_VERSION = 'facade-grammar/v1';
/** Off until it passes on real data (SCRATCHBOX_FACADE_GRAMMAR=1 turns it on, =0 off). */
export const FACADE_GRAMMAR_DEFAULT = false;
/** The scan side of the gate: the fit's own residual tolerance. */
export const GRAMMAR_TOLERANCE_M = PHOTO_CORRECTION_TOLERANCE_M;
/** Facades read per build (the nearest the anchor first). */
export const MAX_GRAMMAR_FACADES = 12;
export const MIN_GRAMMAR_FACADE_AREA_M2 = 120;
/** Below this covered width the facade cannot be split into two halves that each show a repeat. */
export const MIN_HELD_OUT_WIDTH_M = 8;
/** Held-out gate: the symmetric edge chamfer must fall by at least this much (ortho px) below the relief's own lattice's... */
export const HELD_OUT_MIN_CHAMFER_GAIN_PX = 0.25;
/** ...and the structural-scale gradient NCC must not fall below the relief's own lattice's. */
export const EDGE_NCC_BLUR_PX = 3;
/**
 * An opening whose photo core is indistinct from its frame (colour distance relative to the frame's brightness below
 * this) is one the photo does not show; tile_refine does not carve such an inferred opening (its grammarMinDistinct).
 */
export const MIN_OPENING_DISTINCTNESS = 0.04;
/** Of the scan's measured windows, at least this share must fall in the grammar's openings (when there are 3 or more). */
export const MIN_MEASURED_EXPLAINED = 0.5;
/** Edge chamfer truncation (ortho px). */
export const EDGE_TRUNCATION_PX = 8;
/** The longest side of an image sent to the model. */
export const GRAMMAR_IMAGE_MAX_SIDE = 1600;
export const GRAMMAR_CONCURRENCY = 6;

export function facadeGrammarEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
    const v = env.SCRATCHBOX_FACADE_GRAMMAR;
    return v === undefined || v === '' ? FACADE_GRAMMAR_DEFAULT : v !== '0' && v.toLowerCase() !== 'false';
}

// ----------------------------------------------------------------------------------------------------------------
// tile_refine's orthophoto export
// ----------------------------------------------------------------------------------------------------------------

export type Vec3 = [number, number, number];

/** One analysed facade of tile_refine's relief (facades.json): its plane frame, orthophoto and the cells the relief made. */
export interface ReliefOrthoFacade {
    facadeId: number;
    planeIndex: number;
    image: string;
    area_m2: number;
    centroid: Vec3; normal: Vec3; axisS: Vec3; axisT: Vec3;
    sMin: number; sMax: number; tMin: number; tMax: number;
    /** Metres per ortho pixel; the ortho's top-left pixel corner is (orthoSMin, orthoTMax), s grows right, t up. */
    pixel: number; texel: number; width: number; height: number; orthoSMin: number; orthoTMax: number;
    coverage: number;
    pattern: string;
    latticeConfirmation: number;
    latticeRejected: boolean;
    /** [s0, s1, t0, t1, height, lattice, evidence]: lattice 1 photo-observed, 2 periodic-inferred, 3/4 grammar. */
    cells: number[][];
}

export function readReliefOrthos(dir: string): ReliefOrthoFacade[] {
    const file = path.join(dir, 'facades.json');
    if (!fs.existsSync(file)) return [];
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Array.isArray(j?.facades) ? j.facades : [];
}

/** A cell rectangle on a facade plane, metres. */
export interface Rect { s0: number; s1: number; t0: number; t1: number }

const observedCells = (f: ReliefOrthoFacade): Rect[] => f.cells.filter(c => c[5] === 1 && c[4] < 0).map(c => ({ s0: c[0], s1: c[1], t0: c[2], t1: c[3] }));
const reliefLatticeCells = (f: ReliefOrthoFacade): Rect[] => f.cells.filter(c => c[4] < 0).map(c => ({ s0: c[0], s1: c[1], t0: c[2], t1: c[3] }));

// ----------------------------------------------------------------------------------------------------------------
// the grammar
// ----------------------------------------------------------------------------------------------------------------

/** One band of openings along the facade's height: [t0, t1] (metres, t up) and its openings' [s0, s1] along s. */
export interface GrammarTier { t0: number; t1: number; cols: Array<[number, number]>; label?: string }

/**
 * A facade's grammar in its plane's metric frame: continuous fields only. Storey heights are the spacings of the tiers,
 * bay pitches and opening sizes are per tier. `source` says where it was read ('tiles' | 'street-view' |
 * 'tiles+street-view', open).
 */
export interface FacadeGrammar {
    schema: 'scratchbox.facade-grammar/1';
    facadeId: number;
    normal: Vec3;
    centroid: Vec3;
    tiers: GrammarTier[];
    /** Bottom up: the distance between successive tier centres (the storey heights the openings repeat at). */
    storeyHeightsM: number[];
    /** Per tier (bottom up): median opening width and height, and the median centre-to-centre bay pitch (0 with one opening). */
    openings: Array<{ widthM: number; heightM: number; sillM: number; bayPitchM: number; count: number }>;
    confidence: number;
    source: 'tiles' | 'street-view' | 'tiles+street-view' | (string & {});
    /** The model's words for the facade, diagnostic only. */
    label?: string;
}

/** What the model wrote (prompt facade-grammar/v1): per-mille image coordinates. */
export interface GrammarReply {
    tiers: Array<{ y: [number, number]; cols: Array<[number, number]>; label?: string }>;
    conf: number;
    notes?: string;
}

const median = (v: number[]): number => { if (!v.length) return 0; const s = [...v].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : 0.5 * (s[m - 1] + s[m]); };
const r3 = (v: number) => Math.round(v * 1000) / 1000;

export function grammarPrompt(widthM: number, heightM: number, crop: boolean): string {
    return [
        `This is a fronto-parallel orthophoto of ONE building facade, resampled from a photogrammetric 3D scan's photo texture. It is ${widthM.toFixed(1)} m wide and ${heightM.toFixed(1)} m tall; up is up. Uniform grey areas are not covered by the scan${crop ? '; the image is a part of the facade' : ''}.`,
        'Read the facade\'s grammar: its openings (windows, doors, arches, shopfronts, any glazed or open bay) arranged as horizontal TIERS. A tier is one band of openings that share a top and a bottom edge (usually one storey). For each tier give:',
        '- "y": [top, bottom] of its openings, in per-mille of the image height (0 = top edge, 1000 = bottom edge);',
        '- "cols": every opening of the tier from left to right as [left, right] in per-mille of the image width (0 = left edge, 1000 = right edge). Give each opening its own interval, measured on the glass or the void, not on the surrounding frame or the piers.',
        '- "label": a few words, optional.',
        'Rules: list only openings you can see in this image; never continue a pattern into grey areas or past the facade\'s edge. Tiers are listed top to bottom and do not overlap. If the facade shows no openings, return an empty "tiers" list.',
        'Also give "conf": 0..100, how sure you are of the tiers and openings, and "notes": one short sentence.',
        'Answer with JSON only: {"tiers":[{"y":[t,b],"cols":[[l,r],...],"label":"..."}],"conf":0,"notes":"..."}'
    ].join('\n');
}

/** Parses and checks the reply; throws on anything malformed. */
export function parseGrammarReply(text: string): GrammarReply {
    const start = text.indexOf('{'), end = text.lastIndexOf('}');
    if (start < 0 || end <= start) throw new Error('the reply holds no JSON object');
    const j = JSON.parse(text.slice(start, end + 1));
    if (!Array.isArray(j?.tiers)) throw new Error('the reply has no "tiers" list');
    // a coordinate a little past the image edge is the edge (an opening the image cuts); further out is not a reading of it
    const pm = (v: unknown) => typeof v === 'number' && Number.isFinite(v) && v >= -50 && v <= 1050;
    const clamp = (v: number) => Math.max(0, Math.min(1000, v));
    const tiers: GrammarReply['tiers'] = [];
    for (const t of j.tiers) {
        if (!Array.isArray(t?.y) || t.y.length !== 2 || !pm(t.y[0]) || !pm(t.y[1])) throw new Error('a tier without a [top, bottom] in per-mille');
        const cols: Array<[number, number]> = [];
        for (const c of Array.isArray(t.cols) ? t.cols : []) {
            if (!Array.isArray(c) || c.length !== 2 || !pm(c[0]) || !pm(c[1])) throw new Error('an opening without a [left, right] in per-mille');
            const a = clamp(Math.min(c[0], c[1])), b = clamp(Math.max(c[0], c[1]));
            if (b > a) cols.push([a, b]);
        }
        const y0 = clamp(Math.min(t.y[0], t.y[1])), y1 = clamp(Math.max(t.y[0], t.y[1]));
        if (y1 > y0 && cols.length) tiers.push({ y: [y0, y1], cols, ...(typeof t.label === 'string' ? { label: t.label.slice(0, 60) } : {}) });
    }
    const conf = typeof j.conf === 'number' && Number.isFinite(j.conf) ? Math.max(0, Math.min(100, j.conf)) : 50;
    return { tiers, conf, ...(typeof j.notes === 'string' ? { notes: j.notes.slice(0, 200) } : {}) };
}

/** The image a reading saw: which ortho pixel columns [x0, x1) it shows and how its per-mille maps to them. */
export interface ReadWindow { x0: number; x1: number }

/** A reply's tiers in the facade's metric frame. */
export function replyToPlane(reply: GrammarReply, f: ReliefOrthoFacade, win: ReadWindow): GrammarTier[] {
    const sOf = (x: number) => f.orthoSMin + (win.x0 + (x / 1000) * (win.x1 - win.x0)) * f.pixel;
    const tOf = (y: number) => f.orthoTMax - (y / 1000) * f.height * f.pixel;
    return reply.tiers.map(t => ({
        t0: tOf(t.y[1]), t1: tOf(t.y[0]),
        cols: t.cols.map(([a, b]) => [sOf(a), sOf(b)] as [number, number]).sort((p, q) => p[0] - q[0]),
        ...(t.label ? { label: t.label } : {})
    })).sort((a, b) => a.t0 - b.t0);
}

/**
 * The bay rhythm of a tier's openings: the shortest repeating group (1, 2 or 3 openings) that explains the centres, its
 * period and the offsets in it. Used to regularise the reading and to continue the tier past what an image showed.
 */
export function bayRhythm(cols: Array<[number, number]>): { group: number; period: number; offsets: number[]; widths: number[]; rms: number } | undefined {
    const c = cols.map(([a, b]) => 0.5 * (a + b)), w = cols.map(([a, b]) => b - a);
    if (c.length < 2) return undefined;
    let best: { group: number; period: number; offsets: number[]; widths: number[]; rms: number; score: number } | undefined;
    // a group must be seen at least twice (each of its openings twice), or any sequence would "repeat"
    for (let g = 1; g <= 3 && 2 * g <= c.length; g++) {
        // period: median of c[i + g] - c[i]
        const d: number[] = [];
        for (let i = 0; i + g < c.length; i++) d.push(c[i + g] - c[i]);
        const period = median(d);
        if (!(period > 0)) continue;
        // each phase k of the group: centres c[k + j g] - j period, their median is the offset
        const offsets: number[] = [], widths: number[] = [];
        let s2 = 0, n = 0;
        for (let k = 0; k < g; k++) {
            const v: number[] = [], ww: number[] = [];
            for (let i = k; i < c.length; i += g) { v.push(c[i] - ((i - k) / g) * period); ww.push(w[i]); }
            const o = median(v);
            offsets.push(o); widths.push(median(ww));
            for (const x of v) { s2 += (x - o) ** 2; n++; }
        }
        const rms = Math.sqrt(s2 / Math.max(1, n));
        // a longer group must explain the centres clearly better (it has more freedom)
        const score = rms * (1 + 0.5 * (g - 1));
        if (!best || score < best.score) best = { group: g, period, offsets, widths, rms, score };
    }
    if (!best) return undefined;
    return { group: best.group, period: best.period, offsets: best.offsets, widths: best.widths, rms: best.rms };
}

/**
 * Fits a reading to the facade: each tier's band is centred on the windows of its size the relief measured in it (when two
 * or more are there), its openings are put on their bay rhythm when that explains them to within a fifth of the opening
 * width, each opening is centred on the measured windows of its size inside it, and tiers whose openings line up share one
 * set of columns. Everything stays a number: no tier or opening has a type.
 */
export function fitGrammar(tiers: GrammarTier[], f: ReliefOrthoFacade, opts: { confidence: number; source: string; label?: string; measured?: Rect[] } = { confidence: 0.5, source: 'tiles' }): FacadeGrammar {
    const measured = opts.measured ?? observedCells(f);
    const mc = measured.map(m => ({ s: 0.5 * (m.s0 + m.s1), t: 0.5 * (m.t0 + m.t1), w: m.s1 - m.s0, h: m.t1 - m.t0 }));
    // a measured window speaks for an opening only when it is about the same size (within 30%): a smaller dark spot inside
    // a tall opening says nothing about where that opening's centre is
    const like = (a: number, b: number) => a >= 0.7 * b && a <= 1.3 * b;
    const out: GrammarTier[] = [];
    for (const raw of tiers) {
        let { t0, t1 } = raw;
        const h = t1 - t0;
        const inBand = mc.filter(m => m.t >= t0 - 0.25 * h && m.t <= t1 + 0.25 * h && like(m.h, h));
        // two or more measured windows of its size: the band is centred on them (their size is the photo-contrast estimate's
        // and is not taken: the reading's own size is the better one)
        if (inBand.length >= 2) { const tc = median(inBand.map(m => m.t)); t0 = tc - 0.5 * h; t1 = tc + 0.5 * h; }
        let cols = raw.cols.map(c => [c[0], c[1]] as [number, number]);
        const rh = bayRhythm(cols);
        const wMed = median(cols.map(([a, b]) => b - a));
        if (rh && rh.rms <= 0.2 * wMed) {
            // the openings on their rhythm: centre = offset of its phase + its group index x period, width = its phase's
            const c0 = cols.map(([a, b]) => 0.5 * (a + b));
            cols = cols.map((_, i) => {
                const k = i % rh.group, j = (i - k) / rh.group;
                const c = rh.offsets[k] + j * rh.period, w = rh.widths[k];
                void c0;
                return [c - 0.5 * w, c + 0.5 * w] as [number, number];
            });
        }
        // each opening column centred on the measured windows inside it (two or more)
        cols = cols.map(([a, b]) => {
            const w = b - a;
            const inside = mc.filter(m => m.s >= a - 0.25 * w && m.s <= b + 0.25 * w && m.t >= t0 - 0.25 * h && m.t <= t1 + 0.25 * h && like(m.w, w) && like(m.h, h));
            // two or more measured windows of its size that agree (within a tenth of its width)
            if (inside.length < 2) return [a, b] as [number, number];
            const sc = median(inside.map(m => m.s));
            if (inside.some(m => Math.abs(m.s - sc) > 0.1 * w)) return [a, b] as [number, number];
            return [sc - 0.5 * w, sc + 0.5 * w] as [number, number];
        });
        out.push({ t0, t1, cols, ...(raw.label ? { label: raw.label } : {}) });
    }
    // tiers whose openings line up (same count, centres within a third of the width) share one set of columns
    const groups: number[][] = [];
    for (let i = 0; i < out.length; i++) {
        const ci = out[i].cols.map(([a, b]) => 0.5 * (a + b)), wi = median(out[i].cols.map(([a, b]) => b - a));
        const g = groups.find(gr => {
            const o = out[gr[0]];
            if (o.cols.length !== ci.length) return false;
            // the same openings: three quarters of them within a third of the width (one stray reading does not split a lattice)
            return o.cols.filter(([a, b], k) => Math.abs(0.5 * (a + b) - ci[k]) <= wi / 3).length >= 0.75 * ci.length;
        });
        if (g) g.push(i); else groups.push([i]);
    }
    for (const g of groups) {
        if (g.length < 2) continue;
        const n = out[g[0]].cols.length;
        const shared: Array<[number, number]> = [];
        for (let k = 0; k < n; k++) {
            const c = median(g.map(i => 0.5 * (out[i].cols[k][0] + out[i].cols[k][1])));
            const w = median(g.map(i => out[i].cols[k][1] - out[i].cols[k][0]));
            shared.push([c - 0.5 * w, c + 0.5 * w]);
        }
        for (const i of g) out[i] = { ...out[i], cols: shared.map(x => [x[0], x[1]] as [number, number]) };
    }
    // storeys: tiers of about one opening height (within 20%) share that height, and a run of three or more of them whose
    // spacing is regular (within 10%) is put on one storey pitch (least squares), so the reading's noise per tier averages out
    regulariseStoreys(out);
    // tiers must not overlap after the fit: an overlapping pair keeps the band of the one with more openings
    out.sort((a, b) => a.t0 - b.t0);
    const tiersOut: GrammarTier[] = [];
    for (const t of out) {
        const prev = tiersOut[tiersOut.length - 1];
        if (prev && t.t0 < prev.t1) { if (t.cols.length > prev.cols.length) tiersOut[tiersOut.length - 1] = t; continue; }
        tiersOut.push(t);
    }
    // openings in one tier must not overlap either
    for (const t of tiersOut) {
        t.cols.sort((a, b) => a[0] - b[0]);
        t.cols = t.cols.filter((c, i) => i === 0 || c[0] > t.cols[i - 1][1]);
    }
    return describeGrammar(tiersOut, f, opts.confidence, opts.source, opts.label);
}

function regulariseStoreys(tiers: GrammarTier[]): void {
    tiers.sort((a, b) => a.t0 - b.t0);
    const used = new Array(tiers.length).fill(false);
    for (let i = 0; i < tiers.length; i++) {
        if (used[i]) continue;
        const h0 = tiers[i].t1 - tiers[i].t0;
        const group = tiers.map((t, k) => k).filter(k => !used[k] && Math.abs((tiers[k].t1 - tiers[k].t0) - h0) <= 0.2 * h0);
        group.forEach(k => { used[k] = true; });
        if (group.length < 2) continue;
        const h = median(group.map(k => tiers[k].t1 - tiers[k].t0));
        const c = group.map(k => 0.5 * (tiers[k].t0 + tiers[k].t1));
        let centres = c;
        if (group.length >= 3 && group.every((k, j) => j === 0 || k === group[j - 1] + 1)) {
            const d = c.slice(1).map((x, j) => x - c[j]);
            const p = median(d);
            if (p > 0 && d.every(x => Math.abs(x - p) <= 0.1 * p)) {
                // least squares c_j = a + j p
                const n = c.length, sj = (n * (n - 1)) / 2, sjj = ((n - 1) * n * (2 * n - 1)) / 6, sc = c.reduce((s, x) => s + x, 0), sjc = c.reduce((s, x, j) => s + j * x, 0);
                const pitch = (n * sjc - sj * sc) / (n * sjj - sj * sj), a = (sc - pitch * sj) / n;
                centres = c.map((_, j) => a + j * pitch);
            }
        }
        group.forEach((k, j) => { tiers[k] = { ...tiers[k], t0: centres[j] - 0.5 * h, t1: centres[j] + 0.5 * h }; });
    }
}

export function describeGrammar(tiers: GrammarTier[], f: Pick<ReliefOrthoFacade, 'facadeId' | 'normal' | 'centroid'> & { tMin?: number }, confidence: number, source: string, label?: string): FacadeGrammar {
    const centres = tiers.map(t => 0.5 * (t.t0 + t.t1));
    const storeyHeightsM = centres.slice(1).map((c, i) => r3(c - centres[i]));
    const base = f.tMin ?? (tiers[0]?.t0 ?? 0);
    const openings = tiers.map(t => {
        const c = t.cols.map(([a, b]) => 0.5 * (a + b));
        const d = c.slice(1).map((x, i) => x - c[i]);
        return { widthM: r3(median(t.cols.map(([a, b]) => b - a))), heightM: r3(t.t1 - t.t0), sillM: r3(t.t0 - base), bayPitchM: r3(median(d)), count: t.cols.length };
    });
    return {
        schema: 'scratchbox.facade-grammar/1', facadeId: f.facadeId, normal: f.normal, centroid: f.centroid,
        tiers: tiers.map(t => ({ t0: r3(t.t0), t1: r3(t.t1), cols: t.cols.map(([a, b]) => [r3(a), r3(b)] as [number, number]), ...(t.label ? { label: t.label } : {}) })),
        storeyHeightsM, openings, confidence: r3(Math.max(0, Math.min(1, confidence))), source, ...(label ? { label } : {})
    };
}

export function grammarCells(g: Pick<FacadeGrammar, 'tiers'>): Rect[] {
    return g.tiers.flatMap(t => t.cols.map(([s0, s1]) => ({ s0, s1, t0: t.t0, t1: t.t1 })));
}

/**
 * The grammar continued over [sFrom, sTo]: each tier's openings repeat on their rhythm past the ones read (the openings
 * read stay as read). This is how a reading of one part of a facade predicts the rest.
 */
export function continueGrammar(g: Pick<FacadeGrammar, 'tiers'>, sFrom: number, sTo: number): GrammarTier[] {
    return g.tiers.map(t => {
        const rh = bayRhythm(t.cols);
        if (!rh || !(rh.period > 0)) return { ...t, cols: t.cols.map(c => [c[0], c[1]] as [number, number]) };
        const cols: Array<[number, number]> = [];
        const jMin = Math.floor((sFrom - Math.max(...rh.offsets)) / rh.period) - 1, jMax = Math.ceil((sTo - Math.min(...rh.offsets)) / rh.period) + 1;
        for (let j = jMin; j <= jMax; j++)
            for (let k = 0; k < rh.group; k++) {
                const c = rh.offsets[k] + j * rh.period, w = rh.widths[k];
                if (c + 0.5 * w < sFrom || c - 0.5 * w > sTo) continue;
                cols.push([c - 0.5 * w, c + 0.5 * w]);
            }
        cols.sort((a, b) => a[0] - b[0]);
        return { ...t, cols: cols.filter((c, i) => i === 0 || c[0] > cols[i - 1][1]) };
    });
}

// ----------------------------------------------------------------------------------------------------------------
// the orthophoto as numbers
// ----------------------------------------------------------------------------------------------------------------

export interface OrthoRaster { width: number; height: number; lum: Float32Array; cov: Uint8Array; rgb: Uint8Array }

/** tile_refine writes uncovered pixels as exactly (128, 128, 128). */
export function decodeOrtho(png: Uint8Array): OrthoRaster {
    const img = decodeImageInMemory(png);
    const n = img.width * img.height;
    const lum = new Float32Array(n), cov = new Uint8Array(n), rgb = new Uint8Array(n * 3);
    for (let i = 0; i < n; i++) {
        const r = img.rgba[4 * i], g = img.rgba[4 * i + 1], b = img.rgba[4 * i + 2];
        rgb[3 * i] = r; rgb[3 * i + 1] = g; rgb[3 * i + 2] = b;
        cov[i] = r === 128 && g === 128 && b === 128 ? 0 : 1;
        lum[i] = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
    }
    return { width: img.width, height: img.height, lum, cov, rgb };
}

const toX = (f: ReliefOrthoFacade, s: number) => (s - f.orthoSMin) / f.pixel;
const toY = (f: ReliefOrthoFacade, t: number) => (f.orthoTMax - t) / f.pixel;

/**
 * How distinct a rectangle's core (middle 60%) is from the wall around it (the outer half of the band grown by `frameM`):
 * the distance of their mean colours over the wall's brightness. Glazing, voids and frames differ from the wall in colour or brightness either way
 * (a window can be lighter than red brick), so this asks only "is something else there". Null when the photo does not
 * cover it.
 */
export function cellDistinctness(o: OrthoRaster, f: ReliefOrthoFacade, c: Rect, frameM: number): number | null {
    const x0 = Math.max(0, Math.floor(toX(f, c.s0 - frameM))), x1 = Math.min(o.width - 1, Math.ceil(toX(f, c.s1 + frameM)));
    const y0 = Math.max(0, Math.floor(toY(f, c.t1 + frameM))), y1 = Math.min(o.height - 1, Math.ceil(toY(f, c.t0 - frameM)));
    if (x1 < x0 || y1 < y0) return null;
    const ws = c.s1 - c.s0, ht = c.t1 - c.t0;
    const core = [0, 0, 0], ring = [0, 0, 0], edge = [0, 0, 0];
    let nc = 0, nr = 0, ne = 0, tot = 0, cov = 0;
    for (let y = y0; y <= y1; y++) {
        const t = f.orthoTMax - (y + 0.5) * f.pixel;
        for (let x = x0; x <= x1; x++) {
            tot++;
            const i = y * o.width + x;
            if (!o.cov[i]) continue;
            cov++;
            const s = f.orthoSMin + (x + 0.5) * f.pixel;
            // the wall: the outer half of the frame band (the inner half is the opening's own surround)
            const inGrown = s >= c.s0 - 0.5 * frameM && s <= c.s1 + 0.5 * frameM && t >= c.t0 - 0.5 * frameM && t <= c.t1 + 0.5 * frameM;
            const inCore = s >= c.s0 + 0.2 * ws && s <= c.s1 - 0.2 * ws && t >= c.t0 + 0.2 * ht && t <= c.t1 - 0.2 * ht;
            if (inCore) { for (let k = 0; k < 3; k++) core[k] += o.rgb[3 * i + k]; nc++; }
            else if (!inGrown) { for (let k = 0; k < 3; k++) ring[k] += o.rgb[3 * i + k]; nr++; }
            else { for (let k = 0; k < 3; k++) edge[k] += o.rgb[3 * i + k]; ne++; }
        }
    }
    if (!tot || cov / tot < 0.9 || !nc || !nr) return null;
    // the opening shows in its core (glass, void) or its surround (frame, jamb, reveal): either differs from the wall
    const w = ring.map(v => v / nr);
    const dc = Math.hypot(core[0] / nc - w[0], core[1] / nc - w[1], core[2] / nc - w[2]);
    const de = ne ? Math.hypot(edge[0] / ne - w[0], edge[1] / ne - w[1], edge[2] / ne - w[2]) : 0;
    return Math.max(dc, de) / Math.max(20, Math.hypot(w[0], w[1], w[2]));
}

/** The column that splits the covered pixels in two equal halves (the held-out split). */
export function splitColumn(o: OrthoRaster): number {
    const perCol = new Float64Array(o.width);
    let total = 0;
    for (let y = 0; y < o.height; y++) for (let x = 0; x < o.width; x++) if (o.cov[y * o.width + x]) { perCol[x]++; total++; }
    let acc = 0;
    for (let x = 0; x < o.width; x++) { acc += perCol[x]; if (acc >= 0.5 * total) return x + 1; }
    return o.width >> 1;
}

/** Columns of the ortho that hold any covered pixel: [first, last + 1). */
export function coveredColumns(o: OrthoRaster): [number, number] {
    let a = o.width, b = -1;
    for (let x = 0; x < o.width; x++) {
        let any = false;
        for (let y = 0; y < o.height && !any; y++) any = o.cov[y * o.width + x] === 1;
        if (any) { a = Math.min(a, x); b = Math.max(b, x); }
    }
    return b < a ? [0, 0] : [a, b + 1];
}

export interface EdgeAgreement {
    /** Symmetric truncated edge chamfer (ortho px): rectangle edges to photo edges and back. Lower is better. */
    chamferPx: number;
    /** NCC of the blurred rectangle-edge map against the photo's gradient magnitude. Higher is better. */
    gradNcc: number;
    pixels: number;
    modelEdgePixels: number;
    photoEdgePixels: number;
}

/**
 * How well a set of rectangles' outlines agrees with the photo's edges over the covered pixels of columns [xa, xb).
 * Photo edges: the blurred luminance's gradient maxima across the edge, in the top 15% of the region's magnitudes.
 */
export function edgeAgreement(o: OrthoRaster, f: ReliefOrthoFacade, cells: Rect[], xa: number, xb: number): EdgeAgreement {
    const W = o.width, H = o.height, n = W * H;
    const region = new Uint8Array(n);
    let pixels = 0;
    for (let y = 0; y < H; y++) for (let x = Math.max(0, xa); x < Math.min(W, xb); x++) { const i = y * W + x; if (o.cov[i]) { region[i] = 1; pixels++; } }
    const blurred = gaussianBlur(o.lum, W, H, 1.0);
    const { gx, gy, mag } = sobel(blurred, W, H);
    const mags: number[] = [];
    for (let i = 0; i < n; i++) if (region[i]) mags.push(mag[i]);
    mags.sort((a, b) => a - b);
    const thr = mags.length ? mags[Math.floor(0.85 * (mags.length - 1))] : Infinity;
    const photo = new Uint8Array(n);
    let photoEdgePixels = 0;
    for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) {
        const i = y * W + x;
        if (!region[i] || mag[i] < thr || mag[i] <= 0) continue;
        // non-maximum along the gradient (4 directions)
        const ax = Math.abs(gx[i]), ay = Math.abs(gy[i]);
        let j1: number, j2: number;
        if (ax > 2.414 * ay) { j1 = i - 1; j2 = i + 1; }
        else if (ay > 2.414 * ax) { j1 = i - W; j2 = i + W; }
        else if (gx[i] * gy[i] > 0) { j1 = i - W - 1; j2 = i + W + 1; }
        else { j1 = i - W + 1; j2 = i + W - 1; }
        if (mag[i] >= mag[j1] && mag[i] >= mag[j2]) { photo[i] = 1; photoEdgePixels++; }
    }
    const model = new Uint8Array(n);
    let modelEdgePixels = 0;
    const put = (x: number, y: number) => { if (x < 0 || y < 0 || x >= W || y >= H) return; const i = y * W + x; if (!model[i]) { model[i] = 1; if (region[i]) modelEdgePixels++; } };
    for (const c of cells) {
        const x0 = Math.round(toX(f, c.s0)), x1 = Math.round(toX(f, c.s1)), y0 = Math.round(toY(f, c.t1)), y1 = Math.round(toY(f, c.t0));
        for (let x = x0; x <= x1; x++) { put(x, y0); put(x, y1); }
        for (let y = y0; y <= y1; y++) { put(x0, y); put(x1, y); }
    }
    const T = EDGE_TRUNCATION_PX;
    const dPhoto = distanceTransform(photo, W, H, T + 1), dModel = distanceTransform(model, W, H, T + 1);
    let a = 0, na = 0, b = 0, nb = 0;
    for (let i = 0; i < n; i++) {
        if (!region[i]) continue;
        if (model[i]) { a += Math.min(dPhoto[i], T); na++; }
        if (photo[i]) { b += Math.min(dModel[i], T); nb++; }
    }
    const chamferPx = 0.5 * ((na ? a / na : T) + (nb ? b / nb : T));
    // NCC of the outline map against the gradient magnitude, both at a structural scale (EDGE_NCC_BLUR_PX), over the region
    const mb = gaussianBlur(Float32Array.from(model, v => v), W, H, EDGE_NCC_BLUR_PX);
    const coarse = sobel(gaussianBlur(o.lum, W, H, EDGE_NCC_BLUR_PX), W, H).mag;
    let sm = 0, sp = 0, cnt = 0;
    for (let i = 0; i < n; i++) if (region[i]) { sm += mb[i]; sp += coarse[i]; cnt++; }
    let gradNcc = 0;
    if (cnt) {
        const mm = sm / cnt, mp = sp / cnt;
        let num = 0, dm = 0, dp = 0;
        for (let i = 0; i < n; i++) if (region[i]) { const u = mb[i] - mm, v = coarse[i] - mp; num += u * v; dm += u * u; dp += v * v; }
        gradNcc = dm > 0 && dp > 0 ? num / Math.sqrt(dm * dp) : 0;
    }
    return { chamferPx: r3(chamferPx), gradNcc: r3(gradNcc), pixels, modelEdgePixels, photoEdgePixels };
}

// ----------------------------------------------------------------------------------------------------------------
// the gates
// ----------------------------------------------------------------------------------------------------------------

export interface ScanCheck {
    passed: boolean;
    why: string;
    toleranceM: number;
    /** Openings off the measured facade (beyond the tolerance). */
    openingsOffFacade: number;
    measuredWindows: number;
    measuredExplained: number;
    /** RMS distance of the explained measured windows' centres to their opening's centre. */
    explainedRmsM: number;
    /** Openings whose photo core is indistinct from their frame (MIN_OPENING_DISTINCTNESS): tile_refine will not carve them. */
    indistinct: number;
    judged: number;
}

/** (a): the grammar against the scan (the measured facade and the windows the relief measured on it). */
export function checkAgainstScan(g: FacadeGrammar, f: ReliefOrthoFacade, o: OrthoRaster, tol = GRAMMAR_TOLERANCE_M): ScanCheck {
    const cells = grammarCells(g);
    const off = cells.filter(c => c.s0 < f.sMin - tol || c.s1 > f.sMax + tol || c.t0 < f.tMin - tol || c.t1 > f.tMax + tol).length;
    const measured = observedCells(f);
    let explained = 0, s2 = 0;
    for (const m of measured) {
        const ms = 0.5 * (m.s0 + m.s1), mt = 0.5 * (m.t0 + m.t1);
        const c = cells.find(c => ms >= c.s0 - tol && ms <= c.s1 + tol && mt >= c.t0 - tol && mt <= c.t1 + tol);
        if (!c) continue;
        explained++;
        s2 += (ms - 0.5 * (c.s0 + c.s1)) ** 2 + (mt - 0.5 * (c.t0 + c.t1)) ** 2;
    }
    const rms = explained ? Math.sqrt(s2 / explained) : 0;
    // frame: half the smallest gap between openings, within 1 px .. 1 m (tile_refine's rule)
    let gap = Infinity;
    const tiers = [...g.tiers].sort((a, b) => a.t0 - b.t0);
    for (let i = 0; i < tiers.length; i++) {
        if (i) gap = Math.min(gap, tiers[i].t0 - tiers[i - 1].t1);
        for (let k = 1; k < tiers[i].cols.length; k++) gap = Math.min(gap, tiers[i].cols[k][0] - tiers[i].cols[k - 1][1]);
    }
    const frame = Math.max(f.pixel, Math.min(1, Number.isFinite(gap) ? 0.5 * gap : 1));
    let indistinct = 0, judged = 0;
    for (const c of cells) { const k = cellDistinctness(o, f, c, frame); if (k === null) continue; judged++; if (k < MIN_OPENING_DISTINCTNESS) indistinct++; }
    const fails: string[] = [];
    if (!cells.length) fails.push('the grammar has no openings');
    if (off > 0) fails.push(`${off} of ${cells.length} openings lie off the measured facade by more than ${tol.toFixed(2)} m`);
    if (measured.length >= 3 && explained / measured.length < MIN_MEASURED_EXPLAINED) fails.push(`only ${explained} of the ${measured.length} windows measured on the scan's photo fall in its openings`);
    return {
        passed: fails.length === 0,
        why: fails.length ? fails.join('; ') : `${cells.length} openings on the measured facade; ${explained} of ${measured.length} windows measured on the scan's photo in them (centres ${rms.toFixed(2)} m rms from theirs); ${indistinct} of ${judged} indistinct in the photo`,
        toleranceM: tol, openingsOffFacade: off, measuredWindows: measured.length, measuredExplained: explained, explainedRmsM: r3(rms), indistinct, judged
    };
}

export interface HeldOutFold {
    /** The ortho columns the reading saw, and the ones it was scored on. */
    shown: [number, number]; scored: [number, number];
    /** The openings it predicted there (metres, facade plane). */
    cells: Rect[];
    before: EdgeAgreement;
    after: EdgeAgreement;
    /** Openings of the held-out part the shown part predicted. */
    predicted: number;
}

export interface HeldOutCheck {
    passed: boolean;
    why: string;
    folds: HeldOutFold[];
    /** Pixel-weighted over the folds: the relief's own lattice (before) and the grammar's prediction (after). */
    before: { chamferPx: number; gradNcc: number };
    after: { chamferPx: number; gradNcc: number };
    pixels: number;
}

/** (b): each half's reading predicts the other half; scored against the relief's own cells there. */
export function heldOutCheck(f: ReliefOrthoFacade, o: OrthoRaster, folds: Array<{ shown: [number, number]; scored: [number, number]; grammar: FacadeGrammar | undefined }>): HeldOutCheck {
    const before = reliefLatticeCells(f);
    const out: HeldOutFold[] = [];
    for (const fo of folds) {
        const sA = f.orthoSMin + fo.scored[0] * f.pixel, sB = f.orthoSMin + fo.scored[1] * f.pixel;
        const predicted = fo.grammar ? grammarCells({ tiers: continueGrammar(fo.grammar, sA, sB) }).filter(c => c.s1 > sA && c.s0 < sB) : [];
        out.push({ shown: fo.shown, scored: fo.scored, cells: predicted, before: edgeAgreement(o, f, before, fo.scored[0], fo.scored[1]), after: edgeAgreement(o, f, predicted, fo.scored[0], fo.scored[1]), predicted: predicted.length });
    }
    const px = out.reduce((s, x) => s + x.before.pixels, 0);
    const avg = (pick: (x: HeldOutFold) => number) => px ? r3(out.reduce((s, x) => s + pick(x) * x.before.pixels, 0) / px) : 0;
    const b = { chamferPx: avg(x => x.before.chamferPx), gradNcc: avg(x => x.before.gradNcc) };
    const a = { chamferPx: avg(x => x.after.chamferPx), gradNcc: avg(x => x.after.gradNcc) };
    const fails: string[] = [];
    if (!folds.every(x => x.grammar)) fails.push('a half of the facade gave no reading');
    if (a.chamferPx > b.chamferPx - HELD_OUT_MIN_CHAMFER_GAIN_PX) fails.push(`held-out edge chamfer ${a.chamferPx.toFixed(2)} px against ${b.chamferPx.toFixed(2)} px for the relief's own lattice (needs ${HELD_OUT_MIN_CHAMFER_GAIN_PX} px less)`);
    if (a.gradNcc < b.gradNcc) fails.push(`held-out gradient NCC ${a.gradNcc.toFixed(3)} against ${b.gradNcc.toFixed(3)} for the relief's own lattice`);
    return {
        passed: fails.length === 0,
        why: fails.length ? fails.join('; ') : `held out: gradient NCC ${b.gradNcc.toFixed(3)} -> ${a.gradNcc.toFixed(3)}, edge chamfer ${b.chamferPx.toFixed(2)} -> ${a.chamferPx.toFixed(2)} px`,
        folds: out, before: b, after: a, pixels: px
    };
}

// ----------------------------------------------------------------------------------------------------------------
// reading
// ----------------------------------------------------------------------------------------------------------------

/** The ortho columns [x0, x1) as a PNG the model reads (at most GRAMMAR_IMAGE_MAX_SIDE on its long side). */
export function windowPng(o: OrthoRaster, win: ReadWindow): Buffer {
    const w0 = win.x1 - win.x0, h0 = o.height;
    const k = Math.min(1, GRAMMAR_IMAGE_MAX_SIDE / Math.max(w0, h0));
    const w = Math.max(1, Math.round(w0 * k)), h = Math.max(1, Math.round(h0 * k));
    const px = new Uint8Array(w * h * 3);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        // box filter over the source footprint
        const sx0 = win.x0 + Math.floor(x / k), sx1 = Math.max(sx0 + 1, win.x0 + Math.floor((x + 1) / k)), sy0 = Math.floor(y / k), sy1 = Math.max(sy0 + 1, Math.floor((y + 1) / k));
        let r = 0, g = 0, b = 0, n = 0;
        for (let yy = sy0; yy < Math.min(h0, sy1); yy++) for (let xx = sx0; xx < Math.min(win.x1, sx1); xx++) { const i = (yy * o.width + xx) * 3; r += o.rgb[i]; g += o.rgb[i + 1]; b += o.rgb[i + 2]; n++; }
        const j = (y * w + x) * 3;
        px[j] = n ? Math.round(r / n) : 128; px[j + 1] = n ? Math.round(g / n) : 128; px[j + 2] = n ? Math.round(b / n) : 128;
    }
    return encodePng(w, h, px, 3);
}

export interface GrammarReading { reply: GrammarReply; tiers: GrammarTier[]; model: string; ms: number; cached: boolean }

export async function readGrammar(chain: VisionModelChain<string>, f: ReliefOrthoFacade, o: OrthoRaster, win: ReadWindow): Promise<GrammarReading> {
    const png = windowPng(o, win);
    const r = await chain.generate({
        contents: [{ role: 'user', parts: [{ inlineData: { mimeType: 'image/png', data: png.toString('base64') } }, { text: grammarPrompt((win.x1 - win.x0) * f.pixel, o.height * f.pixel, win.x0 > 0 || win.x1 < o.width) }] }],
        config: { responseMimeType: 'application/json', temperature: 0 }
    }, { stage: 'grammar' });
    const text = r.response.candidates?.[0]?.content?.parts?.map(p => p.text ?? '').join('') ?? '';
    const reply = parseGrammarReply(text);
    r.remember();
    // an opening the image's cut edge runs through is only part of an opening: it is not read (the facade's own edges are kept)
    const cutLeft = win.x0 > 0, cutRight = win.x1 < o.width;
    const whole: GrammarReply = { ...reply, tiers: reply.tiers.map(t => ({ ...t, cols: t.cols.filter(([a, b]) => !(cutLeft && a <= 5) && !(cutRight && b >= 995)) })).filter(t => t.cols.length) };
    return { reply: whole, tiers: replyToPlane(whole, f, win), model: r.model, ms: r.ms, cached: !!r.cached };
}

// ----------------------------------------------------------------------------------------------------------------
// the pass
// ----------------------------------------------------------------------------------------------------------------

export interface GrammarFacadeOutcome {
    facadeId: number;
    areaM2: number;
    accepted: boolean;
    /** Why it was not used (the gate that failed), or what it passed. */
    reason: string;
    grammar?: FacadeGrammar;
    /** The grammars read from each half alone (left, right): what the held-out check scored. */
    halves?: Array<FacadeGrammar | undefined>;
    scan?: ScanCheck;
    heldOut?: HeldOutCheck;
    /** Openings the relief's own lattice had on the facade. */
    reliefCells: number;
    readings: Array<{ window: [number, number]; tiers: number; openings: number; conf: number; model: string; ms: number; cached: boolean; error?: string }>;
    ms: number;
}

export interface GrammarPassResult {
    facades: GrammarFacadeOutcome[];
    accepted: FacadeGrammar[];
    calls: number;
    ms: number;
}

/** The facades worth reading: large enough, covered, nearest the anchor first. */
export function selectGrammarFacades(facades: ReliefOrthoFacade[], anchor: { x: number; z: number } = { x: 0, z: 0 }, max = MAX_GRAMMAR_FACADES): ReliefOrthoFacade[] {
    return facades
        .filter(f => f.area_m2 >= MIN_GRAMMAR_FACADE_AREA_M2 && f.coverage >= 0.3 && f.width >= 16 && f.height >= 16)
        .sort((a, b) => Math.hypot(a.centroid[0] - anchor.x, a.centroid[2] - anchor.z) - Math.hypot(b.centroid[0] - anchor.x, b.centroid[2] - anchor.z) || b.area_m2 - a.area_m2)
        .slice(0, max);
}

async function pool<T, R>(items: T[], n: number, fn: (t: T) => Promise<R>): Promise<R[]> {
    const out: R[] = new Array(items.length);
    let next = 0;
    await Promise.all(Array.from({ length: Math.max(1, Math.min(n, items.length)) }, async () => {
        for (let i; (i = next++) < items.length;) out[i] = await fn(items[i]);
    }));
    return out;
}

/**
 * Reads, fits and gates the grammar of each selected facade of a relief ortho export. Three readings per facade: the
 * whole orthophoto (the grammar used) and each half alone (the held-out check). A facade whose reading fails, or whose
 * grammar fails a gate, keeps the relief's own lattice; the outcome says why.
 */
export async function runFacadeGrammarPass(opts: {
    orthosDir: string; chain: VisionModelChain<string>; anchor?: { x: number; z: number }; maxFacades?: number; signal?: AbortSignal; onProgress?: (m: string) => void;
    /** Diagnostic overlays (the photo with the relief's cells and the grammar's) are written here when set. */
    overlayDir?: string;
}): Promise<GrammarPassResult> {
    const t0 = Date.now();
    const all = readReliefOrthos(opts.orthosDir);
    const chosen = selectGrammarFacades(all, opts.anchor, opts.maxFacades);
    let calls = 0, done = 0;
    const jobs = chosen.map(f => ({ f }));
    const results = await pool(jobs, Math.max(1, Math.floor(GRAMMAR_CONCURRENCY / 3)), async ({ f }): Promise<GrammarFacadeOutcome> => {
        const tf = Date.now();
        const base: GrammarFacadeOutcome = { facadeId: f.facadeId, areaM2: r3(f.area_m2), accepted: false, reason: '', reliefCells: reliefLatticeCells(f).length, readings: [], ms: 0 };
        try {
            if (opts.signal?.aborted) throw opts.signal.reason ?? new Error('stopped');
            const o = decodeOrtho(fs.readFileSync(path.join(opts.orthosDir, f.image)));
            const [ca, cb] = coveredColumns(o);
            const coveredM = (cb - ca) * f.pixel;
            if (coveredM < MIN_HELD_OUT_WIDTH_M) return { ...base, reason: `the facade is ${coveredM.toFixed(1)} m wide where the scan covers it: too narrow to hold half of it out`, ms: Date.now() - tf };
            const mid = splitColumn(o);
            const windows: ReadWindow[] = [{ x0: 0, x1: o.width }, { x0: 0, x1: mid }, { x0: mid, x1: o.width }];
            const reads = await Promise.all(windows.map(async w => {
                calls++;
                try { return await readGrammar(opts.chain, f, o, w); } catch (err) { return err instanceof Error ? err : new Error(String(err)); }
            }));
            reads.forEach((r, k) => base.readings.push(r instanceof Error
                ? { window: [windows[k].x0, windows[k].x1], tiers: 0, openings: 0, conf: 0, model: '', ms: 0, cached: false, error: r.message.slice(0, 200) }
                : { window: [windows[k].x0, windows[k].x1], tiers: r.tiers.length, openings: r.tiers.reduce((s, t) => s + t.cols.length, 0), conf: r.reply.conf, model: r.model, ms: r.ms, cached: r.cached }));
            const full = reads[0];
            if (full instanceof Error) return { ...base, reason: `the reading failed (${full.message.slice(0, 160)})`, ms: Date.now() - tf };
            if (!full.tiers.length) return { ...base, reason: 'the model read no openings on the facade', ms: Date.now() - tf };
            const fit = (r: GrammarReading) => fitGrammar(r.tiers, f, { confidence: r.reply.conf / 100, source: 'tiles', ...(r.reply.notes ? { label: r.reply.notes } : {}) });
            const grammar0 = fit(full);
            const scan = checkAgainstScan(grammar0, f, o);
            const grammar: FacadeGrammar = { ...grammar0, confidence: r3(grammar0.confidence * (scan.judged ? 1 - scan.indistinct / scan.judged : 1)) };
            const halves = [reads[1], reads[2]].map(r => (r instanceof Error || !r.tiers.length ? undefined : fit(r)));
            const heldOut = heldOutCheck(f, o, [
                { shown: [0, mid], scored: [mid, o.width], grammar: halves[0] },
                { shown: [mid, o.width], scored: [0, mid], grammar: halves[1] }
            ]);
            if (opts.overlayDir) {
                try {
                    writeOverlay(path.join(opts.overlayDir, `facade_${f.facadeId}_grammar.png`), o, f, reliefLatticeCells(f), grammarCells(grammar));
                    writeOverlay(path.join(opts.overlayDir, `facade_${f.facadeId}_heldout.png`), o, f, reliefLatticeCells(f), heldOut.folds.flatMap(x => x.cells));
                } catch { /* diagnostic only */ }
            }
            const accepted = scan.passed && heldOut.passed;
            const reason = !scan.passed ? `scan: ${scan.why}` : !heldOut.passed ? `held-out: ${heldOut.why}` : `${scan.why}; ${heldOut.why}`;
            return { ...base, accepted, reason, grammar, halves, scan, heldOut, ms: Date.now() - tf };
        } catch (err) {
            if (opts.signal?.aborted) throw err;
            return { ...base, reason: `the facade could not be read (${err instanceof Error ? err.message : String(err)})`, ms: Date.now() - tf };
        } finally {
            opts.onProgress?.(`facade grammar: ${++done} of ${chosen.length} facades read`);
        }
    });
    return { facades: results, accepted: results.filter(r => r.accepted && r.grammar).map(r => r.grammar!), calls, ms: Date.now() - t0 };
}

/** tile_refine --facade-grammar input (scripts/tile_refine.cpp readFacadeGrammars). */
export function grammarFileText(grammars: FacadeGrammar[]): string {
    const n = (v: number) => (Number.isFinite(v) ? Number(v.toFixed(6)).toString() : '0');
    const lines = ['# scratchbox facade grammar v1: facade id nx ny nz cx cy cz confidence source / tier t0 t1 s0 s1 ...'];
    for (const g of grammars) {
        lines.push(`facade ${g.facadeId} ${g.normal.map(n).join(' ')} ${g.centroid.map(n).join(' ')} ${n(g.confidence)} ${g.source.replace(/[\r\n]/g, ' ')}`);
        for (const t of g.tiers) if (t.cols.length) lines.push(`tier ${n(t.t0)} ${n(t.t1)} ${t.cols.map(([a, b]) => `${n(a)} ${n(b)}`).join(' ')}`);
    }
    return lines.join('\n') + '\n';
}

/** The orthophoto with the relief's cells (blue) and the grammar's openings (orange) drawn on it. */
export function writeOverlay(file: string, o: OrthoRaster, f: ReliefOrthoFacade, before: Rect[], after: Rect[]): void {
    const W = o.width, H = o.height;
    const px = Uint8Array.from(o.rgb);
    const draw = (cells: Rect[], col: [number, number, number], inset: number) => {
        for (const c of cells) {
            const x0 = Math.round(toX(f, c.s0)) + inset, x1 = Math.round(toX(f, c.s1)) - inset, y0 = Math.round(toY(f, c.t1)) + inset, y1 = Math.round(toY(f, c.t0)) - inset;
            const put = (x: number, y: number) => { if (x < 0 || y < 0 || x >= W || y >= H) return; const i = (y * W + x) * 3; px[i] = col[0]; px[i + 1] = col[1]; px[i + 2] = col[2]; };
            for (let x = x0; x <= x1; x++) { put(x, y0); put(x, y1); }
            for (let y = y0; y <= y1; y++) { put(x0, y); put(x1, y); }
        }
    };
    draw(before, [40, 140, 255], 0);
    draw(after, [255, 150, 0], 1);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, encodePng(W, H, px, 3));
}
