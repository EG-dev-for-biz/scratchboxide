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
 * fronto-parallel orthophoto of the tile texture (tile_refine --relief-orthos: the textured scan within a slab around the
 * facade plane, projected onto it; every texel already has its metric place, so no camera pose is involved), as tiers of
 * openings, each tier a band along the facade's height with its own opening columns. One wall plane often carries several
 * buildings side by side: a tier spans only its own part of the width, and the tiers of neighbouring sections may share
 * heights. The reading is fitted to the facade's metric frame as continuous numbers (opening bands per
 * storey, bay centres and widths, storey heights), regularised into one lattice per facade, and then measured:
 *
 *  (a) the scan: the openings lie on the measured facade within the fit's residual tolerance (PHOTO_CORRECTION_TOLERANCE_M;
 *      the few read off it are dropped, more than MAX_OFF_FACADE_SHARE and the grammar is not taken). How many of the
 *      relief's own dark cells fall in its openings is reported, not gated: on the Puck Building most of them lay on
 *      piers, spandrels and a fire escape, so they are no measurement of where the windows are;
 *  (b) held-out evidence: the facade is read again four times with parts of its photo hidden (greyed out): alternate
 *      vertical stripes (two readings, each hiding the stripes the other shows) and alternate horizontal bands (two more).
 *      The grammar read from what was shown predicts the openings of what was hidden: bays continue on their rhythm,
 *      storeys on their pitch. Over the four folds its edges there must agree with the photo better than the relief's own lattice does
 *      (symmetric edge chamfer lower by HELD_OUT_MIN_CHAMFER_GAIN_PX, structural gradient NCC not lower), and better than
 *      the same prediction moved by half its bay and half its storey (the control: as many edges, out of place). The
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
import { VISION_CALL_POLICY, type VisionModelChain } from '../../gemini/vision-model-chain';
import { PHOTO_CORRECTION_TOLERANCE_M } from '../../../common/spatial/staged-location-contracts';
import { distanceTransform, gaussianBlur, sobel } from '../../spatial/StreetViewPoseRegistrar';
import { encodePng } from './png-encode';
import { facadeBuildingParts, footprintAgreement, type FootprintAgreement, type FootprintBuilding } from './facade-footprints';
import { decodeImageInMemory } from './tile-texture-transfer';
import { checkDimensions, plausibilitySummary, type PlausibilityFlag } from '../../../common/spatial/plausibility';

export const FACADE_GRAMMAR_PROMPT_VERSION = 'facade-grammar/v1';
/** The fit and the gates (part of the stage's cache key with the prompt version). */
export const FACADE_GRAMMAR_GATE_VERSION = 'grammar-gates/v10';
/** Openings read off the measured facade (beyond the tolerance) are dropped; more than this share of them and the grammar is not taken. */
export const MAX_OFF_FACADE_SHARE = 0.1;
/**
 * The held-out folds: the covered width cut into alternating stripes, the covered height into alternating bands, each
 * about HELD_OUT_SPAN_M (so every fold hides several bays or storeys, never the whole facade in one piece). The stripe/
 * band count follows the facade's own covered extent (extent / HELD_OUT_SPAN_M); these are only the sanity ceiling —
 * high enough that a supertall's held-out bands stay close to HELD_OUT_SPAN_M instead of silently widening past it (a
 * facade merged across dozens of storeys, e.g. a stepped-setback shaft, otherwise gets only a handful of bands spanning
 * tens of metres each, which the cross-validation was never tuned to score). Raising this costs nothing extra: each
 * fold is still exactly one vision call (heldOutFolds always returns 4), only its mask gets finer-grained.
 */
export const HELD_OUT_STRIPES = 128;
export const HELD_OUT_BANDS = 128;
export const HELD_OUT_SPAN_M = 8;
/**
 * On: it passed on real data (Haughwout Building and Puck Building, 2026-10-18: the accepted grammars beat the relief's
 * own lattice and their out-of-place control on held-out photo evidence). SCRATCHBOX_FACADE_GRAMMAR=0 turns it off.
 */
export const FACADE_GRAMMAR_DEFAULT = true;
/** The scan side of the gate: the fit's own residual tolerance. */
export const GRAMMAR_TOLERANCE_M = PHOTO_CORRECTION_TOLERANCE_M;
/** Facades read per build (the nearest the anchor first). */
export const MAX_GRAMMAR_FACADES = 12;
export const MIN_GRAMMAR_FACADE_AREA_M2 = 120;
/** A facade whose photo covers less of its frame than this is not read. */
export const MIN_PHOTO_COVERAGE = 0.3;
/** A grammar the vector footprints disagree with keeps this share of its confidence. */
export const FOOTPRINT_DISAGREEMENT_CONFIDENCE = 0.75;
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
/** Edge chamfer truncation (ortho px). */
export const EDGE_TRUNCATION_PX = 8;
/** The longest side of an image sent to the model. */
export const GRAMMAR_IMAGE_MAX_SIDE = 1600;
/**
 * How many grammar readings are out at once, across every facade of the pass (one pool; each facade is judged as soon as
 * its own five readings are in). Before 2026-10-21 the pass read 3 facades at a time, each waiting for all 5 of its readings:
 * about 4 rounds of "slowest of 5" at the Flatiron District (12 facades, 60 readings), 35-40 s each
 * (docs/processes/vision_call_hedging.md). The chain keeps its own caps: at most VISION_HEDGE_MAX_IN_FLIGHT duplicates
 * and no duplicate to a model in its 429 pause. SCRATCHBOX_GRAMMAR_READ_POOL overrides.
 */
export const GRAMMAR_READ_POOL = 14;

export function grammarReadPool(env: NodeJS.ProcessEnv = process.env): number {
    const v = Number(env.SCRATCHBOX_GRAMMAR_READ_POOL);
    return Number.isFinite(v) && v >= 1 ? Math.floor(v) : GRAMMAR_READ_POOL;
}

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
    /** The straightened photo's horizontal repeat (m) and the autocorrelation it was found at (ortho-rectify.ts): the plane's own column pitch, when it has one. */
    periodM?: number; periodNcc?: number;
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
        `This is a fronto-parallel orthophoto of a building facade (or of several facades side by side on one street wall), resampled from a photogrammetric 3D scan's photo texture. It is ${widthM.toFixed(1)} m wide and ${heightM.toFixed(1)} m tall; up is up. Uniform grey areas are not covered by the scan${crop ? '; the image is a part of the wall' : ''}.`,
        'Read the facades\' grammar: their openings (windows, doors, arches, shopfronts, any glazed or open bay) arranged as horizontal TIERS. A tier is one band of openings of one facade that share a top and a bottom edge (usually one storey of one building). Where several buildings stand side by side, give each building its own tiers (a tier then spans only that building\'s part of the width, and tiers of different buildings may overlap in height). For each tier give:',
        '- "y": [top, bottom] of its openings, in per-mille of the image height (0 = top edge, 1000 = bottom edge);',
        '- "cols": every opening of the tier from left to right as [left, right] in per-mille of the image width (0 = left edge, 1000 = right edge). Give each opening its own interval, measured on the glass or the void, not on the surrounding frame or the piers.',
        '- "label": a few words, optional.',
        'Rules: list only openings you can see in this image; never continue a pattern into grey areas or past a facade\'s edge. Openings never overlap. If no openings show, return an empty "tiers" list.',
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

/** The part of the ortho a reading saw, pixels: columns [x0, x1), rows [y0, y1). Its per-mille maps onto it. */
export interface ReadWindow { x0: number; x1: number; y0: number; y1: number }

/** A reply's tiers in the facade's metric frame. */
export function replyToPlane(reply: GrammarReply, f: ReliefOrthoFacade, win: ReadWindow): GrammarTier[] {
    const sOf = (x: number) => f.orthoSMin + (win.x0 + (x / 1000) * (win.x1 - win.x0)) * f.pixel;
    const tOf = (y: number) => f.orthoTMax - (win.y0 + (y / 1000) * (win.y1 - win.y0)) * f.pixel;
    return reply.tiers.map(t => ({
        t0: tOf(t.y[1]), t1: tOf(t.y[0]),
        cols: t.cols.map(([a, b]) => [sOf(a), sOf(b)] as [number, number]).sort((p, q) => p[0] - q[0]),
        ...(t.label ? { label: t.label } : {})
    })).sort((a, b) => a.t0 - b.t0);
}

/** Where along s the photo shows the facade to a reading (a hidden stripe does not; default: everywhere). */
export type ShownAlong = (s: number) => boolean;

/**
 * The bay rhythm of a tier's openings: a period p and one to three phase offsets (a group of openings that repeats) with
 * each phase's width, such that every opening centre is offset_k + n p for an integer n. Openings need not be
 * consecutive (a reading may skip what it was not shown), so the candidates are the openings' spacings over 1..6, and a
 * candidate is kept only when it explains every opening (within a fifth of the width) and puts at most a fifth of its
 * places, between the openings and where the reading was shown the facade, on wall. The fewest phases win, then the shortest period (a longer one that also fits is
 * a multiple of it that leaves out openings the reading was not shown).
 */
export function bayRhythm(cols: Array<[number, number]>, shown: ShownAlong = () => true): { group: number; period: number; offsets: number[]; widths: number[]; rms: number } | undefined {
    const c = cols.map(([a, b]) => 0.5 * (a + b)), w = cols.map(([a, b]) => b - a);
    if (c.length < 2) return undefined;
    const wMed = median(w), tol = Math.max(0.2 * wMed, 0.05);
    const cands: number[] = [];
    for (let i = 0; i < c.length; i++) for (let j = i + 1; j < c.length; j++) for (let m = 1; m <= 6; m++) {
        const p = Math.abs(c[j] - c[i]) / m;
        if (p >= 1.1 * wMed && !cands.some(q => Math.abs(q - p) <= 0.02 * p)) cands.push(p);
    }
    const lo = Math.min(...c), hi = Math.max(...c);
    let best: { group: number; period: number; offsets: number[]; widths: number[]; rms: number; score: number } | undefined;
    for (const p of cands) {
        // phases of the centres in [0, p), clustered (circularly) within the tolerance
        const ph = c.map((x, i) => ({ v: (((x - lo) % p) + p) % p, i })).sort((a, b) => a.v - b.v);
        const clusters: Array<typeof ph> = [];
        for (const q of ph) { const last = clusters[clusters.length - 1]; if (last && q.v - last[last.length - 1].v <= tol) last.push(q); else clusters.push([q]); }
        if (clusters.length > 1 && clusters[0][0].v + p - clusters[clusters.length - 1][clusters[clusters.length - 1].length - 1].v <= tol) {
            clusters[0] = [...clusters.pop()!.map(q => ({ ...q, v: q.v - p })), ...clusters[0]];
        }
        if (clusters.length > 3) continue;
        // a group of openings must repeat: each phase seen twice at least, unless the rhythm has one phase
        if (clusters.length > 1 && clusters.some(k => k.length < 2)) continue;
        const offsets = clusters.map(k => lo + median(k.map(q => q.v)));
        const widths = clusters.map(k => median(k.map(q => w[q.i])));
        let s2 = 0;
        for (const k of clusters) { const m = median(k.map(q => q.v)); for (const q of k) s2 += (q.v - m) ** 2; }
        const rms = Math.sqrt(s2 / c.length);
        if (rms > tol) continue;
        // wall where the rhythm puts an opening, between the openings read, in what the reading was shown: not this rhythm
        // (a reading may miss an opening or two: up to a fifth of the places may be empty)
        let missing = 0, places = 0;
        for (let n = Math.floor((lo - Math.max(...offsets)) / p) - 1; n <= Math.ceil((hi - Math.min(...offsets)) / p) + 1; n++)
            for (const o of offsets) {
                const x = o + n * p;
                if (x < lo - tol || x > hi + tol || !shown(x)) continue;
                places++;
                if (!c.some(y => Math.abs(y - x) <= Math.max(tol, 0.5 * wMed))) missing++;
            }
        if (missing > Math.floor(0.2 * places)) continue;
        // the fewest phases, then the shortest period: a longer one is a multiple that leaves out openings nothing showed
        const score = clusters.length * 1000 + p;
        if (!best || score < best.score) best = { group: clusters.length, period: p, offsets, widths, rms, score };
    }
    if (!best) return undefined;
    return { group: best.group, period: best.period, offsets: best.offsets, widths: best.widths, rms: best.rms };
}

/** The opening of a rhythm nearest a centre: its lattice centre and its phase's width. */
function onRhythm(rh: NonNullable<ReturnType<typeof bayRhythm>>, centre: number): [number, number] {
    let bc = centre, bw = rh.widths[0], bd = Infinity;
    rh.offsets.forEach((o, k) => { const n = Math.round((centre - o) / rh.period), x = o + n * rh.period; if (Math.abs(x - centre) < bd) { bd = Math.abs(x - centre); bc = x; bw = rh.widths[k]; } });
    return [bc - 0.5 * bw, bc + 0.5 * bw];
}

/**
 * Fits a reading to the facade: each tier's band is centred on the windows of its size the relief measured in it (when two
 * or more are there), its openings are put on their bay rhythm when that explains them to within a fifth of the opening
 * width, each opening is centred on the measured windows of its size inside it, and tiers whose openings line up share one
 * set of columns. Everything stays a number: no tier or opening has a type.
 */
export function fitGrammar(tiers: GrammarTier[], f: ReliefOrthoFacade, opts: { confidence: number; source: string; label?: string; measured?: Rect[]; shown?: ShownAlong } = { confidence: 0.5, source: 'tiles' }): FacadeGrammar {
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
        // the openings on their rhythm: each on its lattice place, with its phase's width
        const rh = bayRhythm(cols, opts.shown);
        if (rh) cols = cols.map(([a, b]) => onRhythm(rh, 0.5 * (a + b)));
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
    // per section (tiers over the same part of the width): columns shared, storeys regularised, overlaps settled
    const tiersOut: GrammarTier[] = [];
    for (const sec of sections(out)) tiersOut.push(...fitSection(sec));
    // openings must not overlap across sections either: a later one overlapping a kept one is dropped
    const kept: GrammarTier[] = [];
    const cellsKept: Rect[] = [];
    for (const t of tiersOut.sort((a, b) => b.cols.length - a.cols.length)) {
        const cols = t.cols.filter(([a, b]) => !cellsKept.some(c => a < c.s1 && b > c.s0 && t.t0 < c.t1 && t.t1 > c.t0));
        if (!cols.length) continue;
        kept.push({ ...t, cols });
        for (const [a, b] of cols) cellsKept.push({ s0: a, s1: b, t0: t.t0, t1: t.t1 });
    }
    kept.sort((a, b) => a.t0 - b.t0 || a.cols[0][0] - b.cols[0][0]);
    return describeGrammar(kept, f, opts.confidence, opts.source, opts.label);
}

/** Tiers over the same part of the facade's width (their spans overlap by half the narrower one): one section each. */
export function sections(tiers: GrammarTier[]): GrammarTier[][] {
    const span = (t: GrammarTier): [number, number] => [Math.min(...t.cols.map(c => c[0])), Math.max(...t.cols.map(c => c[1]))];
    const parent = tiers.map((_, i) => i);
    const find = (x: number): number => (parent[x] === x ? x : (parent[x] = find(parent[x])));
    for (let i = 0; i < tiers.length; i++)
        for (let j = i + 1; j < tiers.length; j++) {
            const [a0, a1] = span(tiers[i]), [b0, b1] = span(tiers[j]);
            const ov = Math.min(a1, b1) - Math.max(a0, b0);
            if (ov >= 0.5 * Math.min(a1 - a0, b1 - b0)) parent[find(i)] = find(j);
        }
    const by = new Map<number, GrammarTier[]>();
    tiers.forEach((t, i) => { const r = find(i); by.set(r, [...(by.get(r) ?? []), t]); });
    return [...by.values()];
}

function fitSection(out: GrammarTier[]): GrammarTier[] {
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
    // tiers of one section must not overlap: an overlapping pair keeps the band of the one with more openings
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
    return tiersOut;
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
    // storey heights: the spacing of the tiers of the widest section (side-by-side sections have their own)
    const secs = tiers.length ? sections(tiers) : [];
    const main = secs.sort((a, b) => b.reduce((n, t) => n + t.cols.length, 0) - a.reduce((n, t) => n + t.cols.length, 0))[0] ?? [];
    const centres = main.map(t => 0.5 * (t.t0 + t.t1)).sort((a, b) => a - b);
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
 * The grammar continued over a part of the facade (metres): in each tier, the openings repeat on their bay rhythm past the
 * ones read; in each section, the regular storeys (the most tiers of one opening height on one rhythm) repeat on it
 * above and below, with the columns of their nearest tier, inside the section's own width. This is how a reading of one
 * part of a facade predicts the rest; where the facade does not repeat (a ground floor, an attic) the prediction is
 * wrong and the held-out check counts it against the grammar. This is how a reading of one
 * part of a facade predicts the rest. The openings read stay as read.
 */
export function continueGrammar(g: Pick<FacadeGrammar, 'tiers'>, area: { s0: number; s1: number; t0: number; t1: number }, shown?: ShownAlong, shownT?: ShownAlong): GrammarTier[] {
    const along = (t: GrammarTier): GrammarTier => {
        const rh = bayRhythm(t.cols, shown);
        if (!rh || !(rh.period > 0)) return { ...t, cols: t.cols.map(c => [c[0], c[1]] as [number, number]) };
        const cols: Array<[number, number]> = [];
        const jMin = Math.floor((area.s0 - Math.max(...rh.offsets)) / rh.period) - 1, jMax = Math.ceil((area.s1 - Math.min(...rh.offsets)) / rh.period) + 1;
        for (let j = jMin; j <= jMax; j++)
            for (let k = 0; k < rh.group; k++) {
                const c = rh.offsets[k] + j * rh.period, w = rh.widths[k];
                if (c + 0.5 * w < area.s0 || c - 0.5 * w > area.s1) continue;
                cols.push([c - 0.5 * w, c + 0.5 * w]);
            }
        // the openings read stay as read; the continuation fills only where none was read
        const read = t.cols.map(c => [c[0], c[1]] as [number, number]);
        for (const c of cols) if (!read.some(r => c[0] < r[1] && c[1] > r[0])) read.push(c);
        read.sort((a, b) => a[0] - b[0]);
        return { ...t, cols: read.filter((c, i) => i === 0 || c[0] > read[i - 1][1]) };
    };
    const out: GrammarTier[] = [];
    for (const sec of sections(g.tiers)) {
        const tiers = sec.map(along);
        out.push(...tiers);
        // the section's regular storeys: the largest group of tiers of one opening height (within 20%), on their rhythm along t
        const sorted = [...sec].sort((a, b) => a.t0 - b.t0);
        let best: GrammarTier[] = [];
        for (const t0 of sorted) {
            const h = t0.t1 - t0.t0;
            const grp = sorted.filter(t => Math.abs((t.t1 - t.t0) - h) <= 0.2 * h);
            if (grp.length > best.length) best = grp;
        }
        if (best.length < 2) continue;
        const rh = bayRhythm(best.map(t => [t.t0, t.t1] as [number, number]), shownT);
        if (!rh) continue;
        const span: [number, number] = [Math.min(...sec.flatMap(t => t.cols.map(x => x[0]))), Math.max(...sec.flatMap(t => t.cols.map(x => x[1])))];
        const occupied = (t0: number, t1: number) => sec.some(t => t1 > t.t0 && t0 < t.t1);
        for (let n = Math.floor((area.t0 - Math.max(...rh.offsets)) / rh.period) - 1; n <= Math.ceil((area.t1 - Math.min(...rh.offsets)) / rh.period) + 1; n++)
            rh.offsets.forEach((o, k) => {
                const tc = o + n * rh.period, h = rh.widths[k];
                if (tc - 0.5 * h > area.t1 || tc + 0.5 * h < area.t0 || occupied(tc - 0.5 * h, tc + 0.5 * h)) return;
                // the columns of the nearest storey of the group, inside the section's own width
                const near = best.reduce((p, q) => (Math.abs(0.5 * (q.t0 + q.t1) - tc) < Math.abs(0.5 * (p.t0 + p.t1) - tc) ? q : p));
                const cols = along(near).cols.filter(([a, b]) => b > span[0] && a < span[1]);
                if (cols.length) out.push({ t0: tc - 0.5 * h, t1: tc + 0.5 * h, cols: cols.map(x => [x[0], x[1]] as [number, number]) });
            });
    }
    return out;
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

/** Rows of the ortho that hold any covered pixel: [first, last + 1). */
export function coveredRows(o: OrthoRaster): [number, number] {
    let a = o.height, b = -1;
    for (let y = 0; y < o.height; y++) for (let x = 0; x < o.width; x++) if (o.cov[y * o.width + x]) { a = Math.min(a, y); b = Math.max(b, y); break; }
    return b < a ? [0, 0] : [a, b + 1];
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
 * How well a set of rectangles' outlines agrees with the photo's edges over the covered pixels of a part of the ortho.
 * Photo edges: the blurred luminance's gradient maxima across the edge, in the top 15% of the region's magnitudes.
 */
export function edgeAgreement(o: OrthoRaster, f: ReliefOrthoFacade, cells: Rect[], scored: Uint8Array): EdgeAgreement {
    const W = o.width, H = o.height, n = W * H;
    const region = new Uint8Array(n);
    let pixels = 0;
    for (let i = 0; i < n; i++) if (scored[i] && o.cov[i]) { region[i] = 1; pixels++; }
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
    /** Openings read off the measured facade (beyond the tolerance): dropped from the grammar. */
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
/** An opening further off the measured facade than the tolerance. */
export const offFacade = (c: Rect, f: Pick<ReliefOrthoFacade, 'sMin' | 'sMax' | 'tMin' | 'tMax'>, tol = GRAMMAR_TOLERANCE_M) => c.s0 < f.sMin - tol || c.s1 > f.sMax + tol || c.t0 < f.tMin - tol || c.t1 > f.tMax + tol;

/** The grammar without the openings off the measured facade, and how many were dropped. */
export function onFacade(g: FacadeGrammar, f: ReliefOrthoFacade, tol = GRAMMAR_TOLERANCE_M): { grammar: FacadeGrammar; dropped: number } {
    let dropped = 0;
    const tiers = g.tiers.map(t => ({ ...t, cols: t.cols.filter(([a, b]) => { const off = offFacade({ s0: a, s1: b, t0: t.t0, t1: t.t1 }, f, tol); if (off) dropped++; return !off; }) })).filter(t => t.cols.length);
    return { grammar: dropped ? describeGrammar(tiers, f, g.confidence, g.source, g.label) : g, dropped };
}

export function checkAgainstScan(g: FacadeGrammar, f: ReliefOrthoFacade, o: OrthoRaster, tol = GRAMMAR_TOLERANCE_M, droppedOff = 0): ScanCheck {
    const cells = grammarCells(g);
    const off = droppedOff + cells.filter(c => offFacade(c, f, tol)).length;
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
    for (let a = 0; a < cells.length; a++)
        for (let b = a + 1; b < cells.length; b++)
            gap = Math.min(gap, Math.max(cells[b].s0 - cells[a].s1, cells[a].s0 - cells[b].s1, cells[b].t0 - cells[a].t1, cells[a].t0 - cells[b].t1));
    const frame = Math.max(f.pixel, Math.min(1, Number.isFinite(gap) ? 0.5 * gap : 1));
    let indistinct = 0, judged = 0;
    for (const c of cells) { const k = cellDistinctness(o, f, c, frame); if (k === null) continue; judged++; if (k < MIN_OPENING_DISTINCTNESS) indistinct++; }
    const fails: string[] = [];
    if (!cells.length) fails.push('the grammar has no openings');
    if (off > MAX_OFF_FACADE_SHARE * (cells.length + droppedOff)) fails.push(`${off} of ${cells.length + droppedOff} openings lie off the measured facade by more than ${tol.toFixed(2)} m`);
    return {
        passed: fails.length === 0,
        why: fails.length ? fails.join('; ') : `${cells.length} openings on the measured facade${off ? ` (${off} read off it dropped)` : ''}; ${explained} of ${measured.length} windows measured on the scan's photo in them (centres ${rms.toFixed(2)} m rms from theirs); ${indistinct} of ${judged} indistinct in the photo`,
        toleranceM: tol, openingsOffFacade: off, measuredWindows: measured.length, measuredExplained: explained, explainedRmsM: r3(rms), indistinct, judged
    };
}

export interface HeldOutFold {
    /** Which fold (stripes or bands, and which of the two) and the pixel spans it hid: what it was scored on. */
    fold: string; hidden: Hidden;
    /** The openings it predicted there (metres, facade plane). */
    cells: Rect[];
    before: EdgeAgreement;
    after: EdgeAgreement;
    /** The prediction moved by half a bay along s and by half a storey along t (mean of the two): as many edges, out of place. */
    control: { chamferPx: number; gradNcc: number };
    /** Openings of the held-out part the shown part predicted. */
    predicted: number;
}

export interface HeldOutCheck {
    passed: boolean;
    why: string;
    folds: HeldOutFold[];
    /** Pixel-weighted over the folds that predicted openings: the relief's own lattice (before), the grammar's prediction (after), and the control. */
    before: { chamferPx: number; gradNcc: number };
    after: { chamferPx: number; gradNcc: number };
    control: { chamferPx: number; gradNcc: number };
    pixels: number;
}

/** Pixel spans of the ortho hidden from a reading: columns (stripes) or rows (bands). */
export interface Hidden { xs?: Array<[number, number]>; ys?: Array<[number, number]> }

export function hiddenMask(o: OrthoRaster, h: Hidden): Uint8Array {
    const m = new Uint8Array(o.width * o.height);
    for (const [a, b] of h.xs ?? []) for (let y = 0; y < o.height; y++) for (let x = Math.max(0, a); x < Math.min(o.width, b); x++) m[y * o.width + x] = 1;
    for (const [a, b] of h.ys ?? []) for (let y = Math.max(0, a); y < Math.min(o.height, b); y++) for (let x = 0; x < o.width; x++) m[y * o.width + x] = 1;
    return m;
}

/** Where along s a reading with these parts hidden was shown the facade (bands hide no s). */
export function shownAlong(f: ReliefOrthoFacade, h: Hidden | undefined): ShownAlong {
    const spans = (h?.xs ?? []).map(([a, b]) => [f.orthoSMin + a * f.pixel, f.orthoSMin + b * f.pixel] as [number, number]);
    return s => !spans.some(([a, b]) => s >= a && s <= b);
}

/** Where along t (up) a reading with these parts hidden was shown the facade (stripes hide no t). */
export function shownUp(f: ReliefOrthoFacade, h: Hidden | undefined): ShownAlong {
    const spans = (h?.ys ?? []).map(([a, b]) => [f.orthoTMax - b * f.pixel, f.orthoTMax - a * f.pixel] as [number, number]);
    return t => !spans.some(([a, b]) => t >= a && t <= b);
}

/** The four held-out folds: alternate stripes of the covered width, and alternate bands of the covered height. */
export function heldOutFolds(o: OrthoRaster, f: Pick<ReliefOrthoFacade, 'pixel'>): Array<{ fold: string; hidden: Hidden }> {
    const [ca, cb] = coveredColumns(o), [ra, rb] = coveredRows(o);
    const cut = (a: number, b: number, k: number) => Array.from({ length: k }, (_, i) => [Math.round(a + ((b - a) * i) / k), Math.round(a + ((b - a) * (i + 1)) / k)] as [number, number]);
    // stripes and bands about HELD_OUT_SPAN_M wide (each shows several bays or storeys); at least 2, scaled to the
    // facade's own covered extent up to the sanity ceiling (HELD_OUT_STRIPES / HELD_OUT_BANDS)
    const k = (px: number, most: number) => Math.max(2, Math.min(most, Math.round((px * f.pixel) / HELD_OUT_SPAN_M)));
    const stripes = cut(ca, cb, k(cb - ca, HELD_OUT_STRIPES)), bands = cut(ra, rb, k(rb - ra, HELD_OUT_BANDS));
    const pick = <T,>(v: T[], odd: number) => v.filter((_, i) => i % 2 === odd);
    return [
        { fold: 'stripes-a', hidden: { xs: pick(stripes, 1) } }, { fold: 'stripes-b', hidden: { xs: pick(stripes, 0) } },
        { fold: 'bands-a', hidden: { ys: pick(bands, 1) } }, { fold: 'bands-b', hidden: { ys: pick(bands, 0) } }
    ];
}

/** (b): each reading with parts hidden predicts the hidden parts; scored there against the relief's own cells and the control. */
export function heldOutCheck(f: ReliefOrthoFacade, o: OrthoRaster, folds: Array<{ fold: string; hidden: Hidden; grammar: FacadeGrammar | undefined }>): HeldOutCheck {
    const before = reliefLatticeCells(f);
    const out: HeldOutFold[] = [];
    const whole = { s0: f.orthoSMin, s1: f.orthoSMin + o.width * f.pixel, t0: f.orthoTMax - o.height * f.pixel, t1: f.orthoTMax };
    for (const fo of folds) {
        const mask = hiddenMask(o, fo.hidden);
        const inHidden = (c: Rect) => { const x = Math.floor(toX(f, 0.5 * (c.s0 + c.s1))), y = Math.floor(toY(f, 0.5 * (c.t0 + c.t1))); return x >= 0 && y >= 0 && x < o.width && y < o.height && mask[y * o.width + x] === 1; };
        const shown = shownAlong(f, fo.hidden);
        const predicted = fo.grammar ? grammarCells({ tiers: continueGrammar(fo.grammar, whole, shown, shownUp(f, fo.hidden)) }).filter(inHidden) : [];
        const after = edgeAgreement(o, f, predicted, mask);
        // the control: the same openings half a bay along s, and half a storey along t, out of place
        const { ds, dt } = halfPitches(predicted);
        const cs = edgeAgreement(o, f, predicted.map(c => ({ ...c, s0: c.s0 + ds, s1: c.s1 + ds })), mask);
        const ct = edgeAgreement(o, f, predicted.map(c => ({ ...c, t0: c.t0 + dt, t1: c.t1 + dt })), mask);
        const control = predicted.length ? { chamferPx: r3(0.5 * (cs.chamferPx + ct.chamferPx)), gradNcc: r3(0.5 * (cs.gradNcc + ct.gradNcc)) } : { chamferPx: after.chamferPx, gradNcc: after.gradNcc };
        out.push({ fold: fo.fold, hidden: fo.hidden, cells: predicted, before: edgeAgreement(o, f, before, mask), after, control, predicted: predicted.length });
    }
    // scored where the reading predicted something: a fold whose reading found no rhythm to continue makes no claim there
    // (the relief's own lattice is scored on the same folds); at least two folds and 40% of the hidden pixels must be
    const used = out.filter(x => x.predicted > 0);
    const all = out.reduce((s, x) => s + x.before.pixels, 0);
    const px = used.reduce((s, x) => s + x.before.pixels, 0);
    const avg = (pick: (x: HeldOutFold) => number) => px ? r3(used.reduce((s, x) => s + pick(x) * x.before.pixels, 0) / px) : 0;
    const b = { chamferPx: avg(x => x.before.chamferPx), gradNcc: avg(x => x.before.gradNcc) };
    const a = { chamferPx: avg(x => x.after.chamferPx), gradNcc: avg(x => x.after.gradNcc) };
    const c = { chamferPx: avg(x => x.control.chamferPx), gradNcc: avg(x => x.control.gradNcc) };
    const fails: string[] = [];
    if (used.length < 2 || px < 0.4 * all) fails.push(`the readings with parts hidden predicted openings in ${used.length} of ${out.length} folds (${all ? Math.round((100 * px) / all) : 0}% of the hidden facade): too little to judge`);
    else {
        if (a.chamferPx > b.chamferPx - HELD_OUT_MIN_CHAMFER_GAIN_PX) fails.push(`held-out edge chamfer ${a.chamferPx.toFixed(2)} px against ${b.chamferPx.toFixed(2)} px for the relief's own lattice (needs ${HELD_OUT_MIN_CHAMFER_GAIN_PX} px less)`);
        if (a.gradNcc < b.gradNcc) fails.push(`held-out gradient NCC ${a.gradNcc.toFixed(3)} against ${b.gradNcc.toFixed(3)} for the relief's own lattice`);
        if (a.chamferPx > c.chamferPx - HELD_OUT_MIN_CHAMFER_GAIN_PX || a.gradNcc <= c.gradNcc) fails.push(`no better than its openings moved half a bay or storey out of place (chamfer ${a.chamferPx.toFixed(2)} against ${c.chamferPx.toFixed(2)} px, NCC ${a.gradNcc.toFixed(3)} against ${c.gradNcc.toFixed(3)})`);
    }
    return {
        passed: fails.length === 0,
        why: fails.length ? fails.join('; ') : `held out (${used.length} of ${folds.length} readings with parts hidden): gradient NCC ${b.gradNcc.toFixed(3)} -> ${a.gradNcc.toFixed(3)}, edge chamfer ${b.chamferPx.toFixed(2)} -> ${a.chamferPx.toFixed(2)} px (out of place: ${c.chamferPx.toFixed(2)} px, ${c.gradNcc.toFixed(3)})`,
        folds: out, before: b, after: a, control: c, pixels: px
    };
}

/** Half the median spacing of neighbouring openings along s (same band) and of neighbouring bands along t. */
function halfPitches(cells: Rect[]): { ds: number; dt: number } {
    const bands = new Map<string, Rect[]>();
    for (const c of cells) { const k = `${c.t0.toFixed(2)}`; bands.set(k, [...(bands.get(k) ?? []), c]); }
    const dS: number[] = [];
    for (const b of bands.values()) {
        const cs = b.map(c => 0.5 * (c.s0 + c.s1)).sort((x, y) => x - y);
        for (let i = 1; i < cs.length; i++) dS.push(cs[i] - cs[i - 1]);
    }
    const ts = [...new Set(cells.map(c => 0.5 * (c.t0 + c.t1)))].sort((x, y) => x - y);
    const dT = ts.slice(1).map((t, i) => t - ts[i]);
    const w = median(cells.map(c => c.s1 - c.s0)), h = median(cells.map(c => c.t1 - c.t0));
    return { ds: 0.5 * (dS.length ? median(dS) : 2 * w), dt: 0.5 * (dT.length ? median(dT) : 2 * h) };
}

// ----------------------------------------------------------------------------------------------------------------
// reading
// ----------------------------------------------------------------------------------------------------------------

/** A window of the ortho as a PNG the model reads (at most GRAMMAR_IMAGE_MAX_SIDE on its long side). */
export function windowPng(o: OrthoRaster, win: ReadWindow, hidden?: Hidden): Buffer {
    const mask = hidden ? hiddenMask(o, hidden) : undefined;
    const w0 = win.x1 - win.x0, h0 = win.y1 - win.y0;
    const k = Math.min(1, GRAMMAR_IMAGE_MAX_SIDE / Math.max(w0, h0));
    const w = Math.max(1, Math.round(w0 * k)), h = Math.max(1, Math.round(h0 * k));
    const px = new Uint8Array(w * h * 3);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        // box filter over the source footprint
        const sx0 = win.x0 + Math.floor(x / k), sx1 = Math.max(sx0 + 1, win.x0 + Math.floor((x + 1) / k)), sy0 = win.y0 + Math.floor(y / k), sy1 = Math.max(sy0 + 1, win.y0 + Math.floor((y + 1) / k));
        let r = 0, g = 0, b = 0, n = 0;
        for (let yy = sy0; yy < Math.min(win.y1, sy1); yy++) for (let xx = sx0; xx < Math.min(win.x1, sx1); xx++) { const p = yy * o.width + xx, i = p * 3; if (mask?.[p]) { r += 128; g += 128; b += 128; } else { r += o.rgb[i]; g += o.rgb[i + 1]; b += o.rgb[i + 2]; } n++; }
        const j = (y * w + x) * 3;
        px[j] = n ? Math.round(r / n) : 128; px[j + 1] = n ? Math.round(g / n) : 128; px[j + 2] = n ? Math.round(b / n) : 128;
    }
    return encodePng(w, h, px, 3);
}

const responseText = (r: { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> }) => r.candidates?.[0]?.content?.parts?.map(p => p.text ?? '').join('') ?? '';

export interface GrammarReading { reply: GrammarReply; tiers: GrammarTier[]; model: string; ms: number; cached: boolean }

export async function readGrammar(chain: VisionModelChain<string>, f: ReliefOrthoFacade, o: OrthoRaster, win: ReadWindow, hidden?: Hidden): Promise<GrammarReading> {
    const png = windowPng(o, win, hidden);
    const r = await chain.generate({
        contents: [{ role: 'user', parts: [{ inlineData: { mimeType: 'image/png', data: png.toString('base64') } }, { text: grammarPrompt((win.x1 - win.x0) * f.pixel, (win.y1 - win.y0) * f.pixel, win.x0 > 0 || win.x1 < o.width || win.y0 > 0 || win.y1 < o.height || !!hidden) }] }],
        config: { responseMimeType: 'application/json', temperature: 0 }
    }, { stage: 'grammar', ...VISION_CALL_POLICY.grammar, valid: res => { try { parseGrammarReply(responseText(res)); return true; } catch { return false; } } });
    const text = responseText(r.response);
    const reply = parseGrammarReply(text);
    r.remember();
    // an opening the image's cut edge runs through is only part of an opening: it is not read (the facade's own edges are kept)
    const cutLeft = win.x0 > 0, cutRight = win.x1 < o.width, cutTop = win.y0 > 0, cutBottom = win.y1 < o.height;
    const whole: GrammarReply = {
        ...reply,
        tiers: reply.tiers.filter(t => !(cutTop && t.y[0] <= 5) && !(cutBottom && t.y[1] >= 995))
            .map(t => ({ ...t, cols: t.cols.filter(([a, b]) => !(cutLeft && a <= 5) && !(cutRight && b >= 995)) })).filter(t => t.cols.length)
    };
    // an opening touching a hidden span (within 1% of the image) is only partly shown: it is not read either
    const nearX = (x0: number, x1: number) => (hidden?.xs ?? []).some(([a, b]) => x1 > a - 0.01 * o.width && x0 < b + 0.01 * o.width);
    const nearY = (y0: number, y1: number) => (hidden?.ys ?? []).some(([a, b]) => y1 > a - 0.01 * o.height && y0 < b + 0.01 * o.height);
    const px = (v: number, a: number, b: number) => a + (v / 1000) * (b - a);
    const shown: GrammarReply = {
        ...whole,
        tiers: whole.tiers.filter(t => !nearY(px(t.y[0], win.y0, win.y1), px(t.y[1], win.y0, win.y1)))
            .map(t => ({ ...t, cols: t.cols.filter(([a, b]) => !nearX(px(a, win.x0, win.x1), px(b, win.x0, win.x1))) })).filter(t => t.cols.length)
    };
    return { reply: shown, tiers: replyToPlane(shown, f, win), model: r.model, ms: r.ms, cached: !!r.cached };
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
    /** The grammars read with parts hidden (stripes a, b, bands a, b): what the held-out check scored. */
    halves?: Array<FacadeGrammar | undefined>;
    scan?: ScanCheck;
    heldOut?: HeldOutCheck;
    /** Openings the relief's own lattice had on the facade. */
    reliefCells: number;
    /** The vector building footprints on the facade, and whether they agree with the grammar (absent: none were given). */
    footprints?: FootprintAgreement;
    /** The independent sources that agree with the accepted grammar: 'tiles' (it was read there), 'vector footprints' (open). */
    agreedSources?: string[];
    readings: Array<{ view: string; tiers: number; openings: number; conf: number; model: string; ms: number; cached: boolean; error?: string }>;
    /** The grammar's storey heights, bay widths and opening sizes outside their typical range (plausibility.ts): flags only. */
    plausibility?: PlausibilityFlag[];
    ms: number;
}

/**
 * A grammar's measured dimensions against their typical ranges: the storey heights (the lowest spacing against the ground
 * storey's range), and per tier the opening width and height and the bay pitch. Flags only; the grammar is unchanged.
 */
export function grammarPlausibility(g: Pick<FacadeGrammar, 'facadeId' | 'storeyHeightsM' | 'openings'>): PlausibilityFlag[] {
    const cause = 'fit or grammar';
    const at = `facade ${g.facadeId}`;
    return checkDimensions([
        ...g.storeyHeightsM.map((h, i) => ({ dimension: i === 0 ? 'groundStoreyHeight' : 'storeyHeight', valueM: h, label: `${at}, storey ${i + 1}`, cause })),
        ...g.openings.flatMap((o, i) => [
            { dimension: 'windowWidth', valueM: o.count ? o.widthM : undefined, label: `${at}, tier ${i + 1} opening width`, cause },
            { dimension: 'windowHeight', valueM: o.count ? o.heightM : undefined, label: `${at}, tier ${i + 1} opening height`, cause },
            { dimension: 'bayWidth', valueM: o.count >= 2 ? o.bayPitchM : undefined, label: `${at}, tier ${i + 1} bay width`, cause }
        ])
    ]);
}

export interface GrammarPassResult {
    facades: GrammarFacadeOutcome[];
    accepted: FacadeGrammar[];
    calls: number;
    ms: number;
}

/** The facades worth reading: large enough, nearest the anchor first (how much of each the photo covers is judged on its photo). */
export function selectGrammarFacades(facades: ReliefOrthoFacade[], anchor: { x: number; z: number } = { x: 0, z: 0 }, max = MAX_GRAMMAR_FACADES): ReliefOrthoFacade[] {
    return facades
        .filter(f => f.area_m2 >= MIN_GRAMMAR_FACADE_AREA_M2 && f.width >= 16 && f.height >= 16)
        .sort((a, b) => Math.hypot(a.centroid[0] - anchor.x, a.centroid[2] - anchor.z) - Math.hypot(b.centroid[0] - anchor.x, b.centroid[2] - anchor.z) || b.area_m2 - a.area_m2)
        .slice(0, max);
}

/** A counting semaphore: at most `n` callers inside at once, admitted in the order they asked. */
export function readingPool(n: number): <R>(fn: () => Promise<R>) => Promise<R> {
    let inside = 0;
    const waiting: Array<() => void> = [];
    const enter = () => new Promise<void>(resolve => { if (inside < n) { inside++; resolve(); } else waiting.push(() => { inside++; resolve(); }); });
    const leave = () => { inside--; waiting.shift()?.(); };
    return async fn => { await enter(); try { return await fn(); } finally { leave(); } };
}

/**
 * Reads, fits and gates the grammar of each selected facade of a relief ortho export. Five readings per facade: the
 * whole orthophoto (the grammar used) and four with parts hidden (the held-out check). A facade whose reading fails, or whose
 * grammar fails a gate, keeps the relief's own lattice; the outcome says why. Each reading is hedged and has a deadline
 * (VISION_CALL_POLICY.grammar): a whole reading with no answer by then is a failed reading (the relief's lattice stays,
 * the reason says "no answer within ..."), a held-out reading with none is not scored. Every facade's readings go through
 * one pool of `readPool` (default grammarReadPool()) calls in flight, in facade order, and each facade is judged as soon as
 * its own five are in.
 */
export async function runFacadeGrammarPass(opts: {
    orthosDir: string; chain: VisionModelChain<string>; anchor?: { x: number; z: number }; maxFacades?: number; signal?: AbortSignal; onProgress?: (m: string) => void;
    /** Readings in flight at once across the pass (default grammarReadPool()). */
    readPool?: number;
    /** Diagnostic overlays (the photo with the relief's cells and the grammar's) are written here when set. */
    overlayDir?: string;
    /** Vector building footprints in the tile frame (facade-footprints.ts): an independent check of each grammar. */
    footprints?: FootprintBuilding[];
}): Promise<GrammarPassResult> {
    const t0 = Date.now();
    const all = readReliefOrthos(opts.orthosDir);
    const chosen = selectGrammarFacades(all, opts.anchor, opts.maxFacades);
    let calls = 0, done = 0;
    const take = readingPool(Math.max(1, opts.readPool ?? grammarReadPool()));
    const results = await Promise.all(chosen.map(async (f): Promise<GrammarFacadeOutcome> => {
        const tf = Date.now();
        const base: GrammarFacadeOutcome = { facadeId: f.facadeId, areaM2: r3(f.area_m2), accepted: false, reason: '', reliefCells: reliefLatticeCells(f).length, readings: [], ms: 0 };
        try {
            // the facades before this one get their readings sent before this one's ortho is decoded (CPU)
            await new Promise<void>(resolve => setImmediate(resolve));
            if (opts.signal?.aborted) throw opts.signal.reason ?? new Error('stopped');
            const o = decodeOrtho(fs.readFileSync(path.join(opts.orthosDir, f.image)));
            let covered = 0;
            for (let i = 0; i < o.cov.length; i++) covered += o.cov[i];
            if (covered < MIN_PHOTO_COVERAGE * o.cov.length) return { ...base, reason: `the tile photo covers only ${Math.round((100 * covered) / o.cov.length)}% of the facade`, ms: Date.now() - tf };
            const [ca, cb] = coveredColumns(o);
            const coveredM = (cb - ca) * f.pixel;
            if (coveredM < MIN_HELD_OUT_WIDTH_M) return { ...base, reason: `the facade is ${coveredM.toFixed(1)} m wide where the scan covers it: too narrow to hold half of it out`, ms: Date.now() - tf };
            const full: ReadWindow = { x0: 0, x1: o.width, y0: 0, y1: o.height };
            const folds = heldOutFolds(o, f);
            const views: Array<Hidden | undefined> = [undefined, ...folds.map(x => x.hidden)];
            const reads = await Promise.all(views.map(async h => {
                calls++;
                try { return await take(() => readGrammar(opts.chain, f, o, full, h)); } catch (err) { return err instanceof Error ? err : new Error(String(err)); }
            }));
            const labels = ['whole', ...folds.map(x => x.fold)];
            reads.forEach((r, k) => base.readings.push(r instanceof Error
                ? { view: labels[k], tiers: 0, openings: 0, conf: 0, model: '', ms: 0, cached: false, error: r.message.slice(0, 200) }
                : { view: labels[k], tiers: r.tiers.length, openings: r.tiers.reduce((s, t) => s + t.cols.length, 0), conf: r.reply.conf, model: r.model, ms: r.ms, cached: r.cached }));
            const whole = reads[0];
            if (whole instanceof Error) return { ...base, reason: `the reading failed (${whole.message.slice(0, 160)})`, ms: Date.now() - tf };
            if (!whole.tiers.length) return { ...base, reason: 'the model read no openings on the facade', ms: Date.now() - tf };
            const fit = (r: GrammarReading, h?: Hidden) => fitGrammar(r.tiers, f, { confidence: r.reply.conf / 100, source: 'tiles', shown: shownAlong(f, h), ...(r.reply.notes ? { label: r.reply.notes } : {}) });
            const clipped = onFacade(fit(whole), f);
            const grammar0 = clipped.grammar;
            const scan = checkAgainstScan(grammar0, f, o, GRAMMAR_TOLERANCE_M, clipped.dropped);
            // the vector footprints, when given: do the grammar's sections stay inside one building each, and does its top
            // opening reach each building's roof? Not a gate: a disagreement lowers the confidence and is reported
            let foot: FootprintAgreement | undefined;
            if (opts.footprints) {
                const spans = sections(grammar0.tiers).map(sec => [Math.min(...sec.flatMap(t => t.cols.map(c => c[0]))), Math.max(...sec.flatMap(t => t.cols.map(c => c[1])))] as [number, number]);
                foot = footprintAgreement(grammar0, spans, f, facadeBuildingParts(f, opts.footprints));
            }
            const footFactor = foot && foot.buildings > 0 && !foot.agrees ? FOOTPRINT_DISAGREEMENT_CONFIDENCE : 1;
            const grammar: FacadeGrammar = { ...grammar0, confidence: r3(grammar0.confidence * footFactor * (scan.judged ? 1 - scan.indistinct / scan.judged : 1)) };
            const halves = reads.slice(1).map((r, k) => (r instanceof Error || !r.tiers.length ? undefined : fit(r, folds[k].hidden)));
            const heldOut = heldOutCheck(f, o, folds.map((x, k) => ({ ...x, grammar: halves[k] })));
            if (opts.overlayDir) {
                try {
                    writeOverlay(path.join(opts.overlayDir, `facade_${f.facadeId}_grammar.png`), o, f, reliefLatticeCells(f), grammarCells(grammar));
                    writeOverlay(path.join(opts.overlayDir, `facade_${f.facadeId}_heldout.png`), o, f, reliefLatticeCells(f), heldOut.folds.flatMap(x => x.cells));
                } catch { /* diagnostic only */ }
            }
            const accepted = scan.passed && heldOut.passed;
            const reason = !scan.passed ? `scan: ${scan.why}` : !heldOut.passed ? `held-out: ${heldOut.why}` : `${scan.why}; ${heldOut.why}`;
            const agreedSources = accepted ? ['tiles', ...(foot?.agrees ? ['vector footprints'] : [])] : undefined;
            // the grammar's dimensions against their typical ranges: reported beside it, never a gate and never a change
            const plausibility = grammarPlausibility(grammar);
            const why = `${foot ? `${reason}; footprints: ${foot.why}` : reason}${plausibility.length ? `; ${plausibilitySummary(plausibility)}` : ''}`;
            return { ...base, accepted, reason: why, grammar, halves, scan, heldOut, ...(foot ? { footprints: foot } : {}), ...(agreedSources ? { agreedSources } : {}), plausibility, ms: Date.now() - tf };
        } catch (err) {
            if (opts.signal?.aborted) throw err;
            return { ...base, reason: `the facade could not be read (${err instanceof Error ? err.message : String(err)})`, ms: Date.now() - tf };
        } finally {
            opts.onProgress?.(`facade grammar: ${++done} of ${chosen.length} facades read`);
        }
    }));
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
