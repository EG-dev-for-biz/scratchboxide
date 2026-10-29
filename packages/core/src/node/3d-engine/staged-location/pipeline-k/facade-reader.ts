/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The facade reader: a vision agent deduces each plane's openings and their glass, and judges its own result.
 *
 * Brightness rules cannot say where a building's windows are: on a tower each window is lit its own way (sky, blinds, a
 * lamp), glass is darker than stone on one wall and lighter than dark spandrels on the next. A vision model sees them. Per
 * plane (a wall tile_refine photographed, or any other plane of the building: plane-orthos.ts), with FACADE_READER_MODEL:
 *
 *  1. overview (a plane taller or wider than one read crop): the whole plane, scaled down. The model splits it into
 *     zones, each with one pattern of openings or none (a base, a shaft, a crown, a plain roof, a band of rooflights),
 *     as boxes in per-mille of the plane;
 *  2. unit cell: per zone with openings, a full-resolution crop of it (the best-covered part, up to readCropM tall). The
 *     model gives every row of openings it sees, each window on its own (a bay of two windows is two openings), with its
 *     pane splits, and the zone's glass in its own words and as numbers (how see-through and how reflective, its tint,
 *     whether it is an opaque panel);
 *  3. tiling: the zone is filled from the model's cell: its columns at their read places, its rows repeated through the
 *     zone at the read storey pitch (the pitch measured over the whole zone where it repeats three times or more: the
 *     strongest repeat of the image near the read pitch, whichever way the brightness goes), only where the photo covers
 *     the plane (nothing is drawn where it never reached: no generated windows);
 *  4. judge: the outlines are drawn over the read crop and a second crop of the zone the model was not shown, and the
 *     model accepts or rejects the zone, column by column. A rejected zone draws nothing; a plane with no accepted zone
 *     keeps the window fit's reading.
 *
 * The reading needs only the photos, so it runs beside the window fit (readPlanes); its openings and their equal-split
 * panes then replace the window fit's for that plane in window_fit.json (mergeReadings) (the window fit's
 * own kept as `structural`), with each zone's glass beside them, so the wall grammar, the lattice and the material regions
 * read them as they read the window fit's. Photo-inferred: the model reads and judges, the photo places. The model's
 * words are labels only; what the build uses are its numbers.
 */

import * as fs from 'fs';
import * as path from 'path';
import { decodePng } from '../../../texture-processing';
import { encodePng } from '../png-encode';
import type { FitFrame, FittedPlane, WindowFitFile, WindowRect } from '../window-fit';
import { PLANES_FILE, type PlaneOrthosFile } from './plane-orthos';

export const FACADE_READER_VERSION = 'facade-reader/4';

/** The reader's vision model: fast, cheap and good enough at reading openings (benchmarked 2026-10-29 on the ESB's tower crops against gemini-4-argon and gemini-3.5-flash-lite); the app's other vision models are the fallback. */
export const FACADE_READER_MODEL = { model: 'gemini-3.8-flash', thinkingBudget: 512 } as const;

export const FACADE_READER_PARAMS = {
    /** Planes smaller than this (m), or with less of their photo covered, are not read. */
    minWidthM: 6, minHeightM: 10, minCoverage: 0.3,
    /** The unit cell's crop: up to this tall (m), at least this covered (or nine tenths of the plane's own coverage); the image the model sees is scaled to at most maxSidePx. */
    readCropM: 24, minCropCoverage: 0.7, maxSidePx: 1600, maxScale: 4,
    /** Zones read per plane at most. */
    maxZones: 4,
    /** Planes read per build at most (the largest covered area first; the rest reported unread), and at once. */
    maxPlanes: 80, concurrency: 12,
    /** A plane whose covered photo varies less than this (luminance standard deviation over mean) is blank: nothing to read, no call. */
    minContrast: 0.06,
    /** The pitch is measured within this share of the read pitch; an opening is drawn where this share of it is covered. */
    pitchSearch: 0.1, minCovered: 0.6,
    /** The model's own confidence (0-100) below which a reading or a judgement is not taken. */
    minConf: 40
} as const;
export type FacadeReaderParams = typeof FACADE_READER_PARAMS;

/** Which part of the plane an image shows, in its pixels: columns [x0, x1), rows [y0, y1). */
export interface ImageRegion { x0: number; x1: number; y0: number; y1: number }

/** One call to the vision model: a PNG and a prompt in, the reply's text out; `region` says what part of the plane it shows. */
export type FacadeAsk = (png: Buffer, prompt: string, kind: 'overview' | 'read' | 'judge', region: ImageRegion) => Promise<string>;

/** A zone of the plane with one pattern of openings or none, in per-mille of the plane. */
export interface FacadeZone { box: [number, number, number, number]; openings: boolean; label?: string }

/** The zone's glass as the model sees it: its words (a label) and its numbers (what the build uses). */
export interface GlassReading { label?: string; transparency: number; reflectivity: number; tint?: string; opaque: boolean }

/** The model's reading of a crop: rows of openings, in per-mille of the crop (0 top/left, 1000 bottom/right), and the glass. */
export interface FacadeReading {
    rows: Array<{ y: [number, number]; openings: Array<{ x: [number, number]; panes: number }> }>;
    glass?: GlassReading; between?: string; conf: number; notes?: string;
}

export interface FacadeJudgement { accept: boolean; badColumns: number[]; conf: number; notes?: string }

export interface ZoneRecord {
    label?: string; region: ImageRegion; outcome: 'drawn' | 'none' | 'rejected' | 'failed'; why: string;
    reading?: { rows: number; openings: number; conf: number; notes?: string; between?: string };
    fit?: { pitchPx: number; pitchM: number; measured: boolean; columns: number; rows: number; openings: number };
    glass?: GlassReading; judge?: FacadeJudgement;
}

export interface FacadeReadRecord {
    facadeId: number;
    outcome: 'replaced' | 'kept' | 'skipped' | 'failed';
    why: string;
    zones?: ZoneRecord[];
    calls?: number;
    ms: number;
}

// ------------------------------------------------------------------------------------------------ prompts and replies

const where = (widthM: number, heightM: number, roof: boolean, part: boolean) => roof
    ? `This is a photo of ${part ? 'part of ' : ''}a flat roof or terrace of a building seen from straight above, straightened from a 3D scan's photo texture: ${widthM.toFixed(1)} m by ${heightM.toFixed(1)} m. Black or uniform grey areas are not covered.`
    : `This is a fronto-parallel photo of ${part ? 'part of ' : ''}a building wall, straightened from a 3D scan's photo texture: ${widthM.toFixed(1)} m wide and ${heightM.toFixed(1)} m tall, up is up. Uniform grey or black areas are not covered.`;

export function overviewPrompt(widthM: number, heightM: number, roof = false): string {
    return [
        where(widthM, heightM, roof, false),
        'Split it into ZONES: parts that each carry one repeating pattern of openings (windows, glazed panels, doors, rooflights, skylights, glass balustrades), or none (blank wall, plain roof, plant). Typical zones on a wall are a base, a shaft of identical storeys, a crown; on a roof, a band or grid of rooflights and the plain roof around it.',
        'For each zone give "box": [left, top, right, bottom] in per-mille of the image (0..1000), "openings": true or false, and "label": a few words.',
        'Zones do not overlap; leave out uncovered areas. Also give "conf": 0..100.',
        'Answer with JSON only: {"zones":[{"box":[l,t,r,b],"openings":true,"label":"..."}],"conf":0}'
    ].join('\n');
}

export function readPrompt(widthM: number, heightM: number, roof = false): string {
    return [
        where(widthM, heightM, roof, true),
        `List every ${roof ? 'line' : 'horizontal row'} of openings you can see (windows, glazed panels, doors, rooflights, any glazed or open bay): one row is the openings that share a top and a bottom edge${roof ? '' : ' (usually one storey)'}. For each row give:`,
        '- "y": [top, bottom] of its openings in per-mille of the image height (0 = top edge, 1000 = bottom edge), on the glass, not the frame, the spandrel or the sill;',
        '- "openings": each opening from left to right as {"x": [left, right] in per-mille of the image width, "panes": how many side-by-side panes vertical mullions divide it into (1 if undivided)}.',
        'Each window on its own: a bay or a frame holding two or three windows side by side is two or three openings, never one. Openings never overlap; never continue a pattern into grey areas or past the image edge; leave out a row the image edge cuts.',
        'Also give "glass": {"label": a few words on the glass (e.g. clear, tinted, mirrored, frosted, or an opaque panel), "transparency": 0..1, "reflectivity": 0..1, "tint": its colour as #rrggbb, "opaque": true when the openings are panels, not glass}; "between": a few words on what lies between the rows; "conf": 0..100; "notes": one short sentence.',
        'Answer with JSON only: {"rows":[{"y":[t,b],"openings":[{"x":[l,r],"panes":1}]}],"glass":{"label":"...","transparency":0.5,"reflectivity":0.3,"tint":"#6b7a80","opaque":false},"between":"...","conf":0,"notes":"..."}'
    ].join('\n');
}

export function judgePrompt(columns: number): string {
    return [
        'This image is two parts of one zone of a building surface side by side, with magenta outlines drawn by a program where it thinks each opening\'s glass is.',
        `The outlines stand in ${columns} column${columns === 1 ? '' : 's'} on each part, numbered 1 to ${columns} from left to right (the same numbering on both parts).`,
        'Judge whether the outlines sit on the real openings: each outline should cover one opening\'s glass, not a pier, a spandrel or blank surface, and every opening in a column should have its outline.',
        'Give "accept": true when most outlines sit on openings; "badColumns": the numbers of columns whose outlines mostly miss the openings; "conf": 0..100; "notes": one short sentence.',
        'Answer with JSON only: {"accept":true,"badColumns":[],"conf":0,"notes":"..."}'
    ].join('\n');
}

const jsonOf = (text: string): any => {
    const a = text.indexOf('{'), b = text.lastIndexOf('}');
    if (a < 0 || b <= a) throw new Error('the reply holds no JSON object');
    return JSON.parse(text.slice(a, b + 1));
};
const pm = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= -50 && v <= 1050;
const clampPm = (v: number) => Math.max(0, Math.min(1000, v));
const confOf = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.min(100, v)) : 50);
const unit = (v: unknown, fallback: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : fallback);

/** Parses and checks an overview; throws on anything malformed. */
export function parseZones(text: string): { zones: FacadeZone[]; conf: number } {
    const j = jsonOf(text);
    if (!Array.isArray(j?.zones)) throw new Error('the reply has no "zones" list');
    const zones: FacadeZone[] = [];
    for (const z of j.zones) {
        if (!Array.isArray(z?.box) || z.box.length !== 4 || !z.box.every(pm)) throw new Error('a zone without a [left, top, right, bottom] in per-mille');
        const [l, t, r, b] = z.box.map(clampPm);
        if (r > l && b > t) zones.push({ box: [Math.min(l, r), Math.min(t, b), Math.max(l, r), Math.max(t, b)], openings: z.openings === true, ...(typeof z.label === 'string' ? { label: z.label.slice(0, 60) } : {}) });
    }
    return { zones, conf: confOf(j.conf) };
}

/** Parses and checks a reading; throws on anything malformed. */
export function parseReading(text: string): FacadeReading {
    const j = jsonOf(text);
    if (!Array.isArray(j?.rows)) throw new Error('the reply has no "rows" list');
    const rows: FacadeReading['rows'] = [];
    for (const r of j.rows) {
        if (!Array.isArray(r?.y) || r.y.length !== 2 || !pm(r.y[0]) || !pm(r.y[1])) throw new Error('a row without a [top, bottom] in per-mille');
        const openings: FacadeReading['rows'][number]['openings'] = [];
        for (const o of Array.isArray(r.openings) ? r.openings : []) {
            if (!Array.isArray(o?.x) || o.x.length !== 2 || !pm(o.x[0]) || !pm(o.x[1])) throw new Error('an opening without a [left, right] in per-mille');
            const a = clampPm(Math.min(o.x[0], o.x[1])), b = clampPm(Math.max(o.x[0], o.x[1]));
            const panes = typeof o.panes === 'number' && Number.isFinite(o.panes) ? Math.max(1, Math.min(8, Math.round(o.panes))) : 1;
            if (b > a) openings.push({ x: [a, b], panes });
        }
        const y0 = clampPm(Math.min(r.y[0], r.y[1])), y1 = clampPm(Math.max(r.y[0], r.y[1]));
        if (y1 > y0 && openings.length) rows.push({ y: [y0, y1], openings });
    }
    const g = j.glass && typeof j.glass === 'object' ? j.glass : undefined;
    const glass: GlassReading | undefined = g ? {
        ...(typeof g.label === 'string' ? { label: g.label.slice(0, 60) } : {}), transparency: unit(g.transparency, 0.5), reflectivity: unit(g.reflectivity, 0.3),
        ...(typeof g.tint === 'string' && /^#[0-9a-f]{6}$/i.test(g.tint) ? { tint: g.tint.toLowerCase() } : {}), opaque: g.opaque === true
    } : undefined;
    return { rows, ...(glass ? { glass } : {}), ...(typeof j.between === 'string' ? { between: j.between.slice(0, 80) } : {}), conf: confOf(j.conf), ...(typeof j.notes === 'string' ? { notes: j.notes.slice(0, 200) } : {}) };
}

export function parseJudgement(text: string): FacadeJudgement {
    const j = jsonOf(text);
    if (typeof j?.accept !== 'boolean') throw new Error('the reply has no "accept"');
    const bad = Array.isArray(j.badColumns) ? j.badColumns.filter((v: unknown) => typeof v === 'number' && Number.isInteger(v) && v >= 1) as number[] : [];
    return { accept: j.accept, badColumns: [...new Set(bad)].sort((a, b) => a - b), conf: confOf(j.conf), ...(typeof j.notes === 'string' ? { notes: j.notes.slice(0, 200) } : {}) };
}

// ------------------------------------------------------------------------------------------------ the photo

export interface FacadePhoto { rgba: ArrayLike<number>; width: number; height: number }

/** Luminance per pixel (NaN where the photo never reached): only for what is covered, the blank test and the pitch's repeat. */
export function luminanceOf(img: FacadePhoto, uncovered?: ArrayLike<number>): Float32Array {
    const L = new Float32Array(img.width * img.height);
    for (let k = 0; k < L.length; k++) {
        const p = k * 4, grey = img.rgba[p] === 128 && img.rgba[p + 1] === 128 && img.rgba[p + 2] === 128;
        L[k] = (uncovered && uncovered[k]) || img.rgba[p + 3] === 0 || grey ? NaN : 0.2126 * img.rgba[p] + 0.7152 * img.rgba[p + 1] + 0.0722 * img.rgba[p + 2];
    }
    return L;
}

const coveredShare = (L: Float32Array, W: number, x0: number, y0: number, x1: number, y1: number) => {
    let n = 0, c = 0;
    for (let y = Math.max(0, Math.floor(y0)); y < Math.min(L.length / W, Math.ceil(y1)); y++) for (let x = Math.max(0, Math.floor(x0)); x < Math.min(W, Math.ceil(x1)); x++) { n++; if (Number.isFinite(L[y * W + x])) c++; }
    return n ? c / n : 0;
};

/**
 * Crops of a zone [x0, x1) x [y0, y1): rows h tall (the zone's height when shorter), the best covered (its middle first)
 * to read, and a held-out one at least one crop away (the best covered of the rest), or none. A crop must be
 * minCropCoverage covered, or nine tenths of the zone's own coverage when that is less (a roof's photo is its outline).
 */
export function zoneCrops(L: Float32Array, W: number, zone: ImageRegion, h: number, P: FacadeReaderParams = FACADE_READER_PARAMS): { read?: ImageRegion; heldOut?: ImageRegion } {
    const zh = zone.y1 - zone.y0;
    h = Math.max(4, Math.min(zh, Math.round(h)));
    const rowCov = (y: number) => coveredShare(L, W, zone.x0, y, zone.x1, y + 1);
    const rc = Array.from({ length: zh }, (_, i) => rowCov(zone.y0 + i));
    const cov = (y0: number) => { let s = 0; for (let y = y0; y < y0 + h; y++) s += rc[y - zone.y0]; return s / h; };
    const step = Math.max(1, Math.round(h / 4)), starts: number[] = [];
    for (let y0 = zone.y0; y0 + h <= zone.y1; y0 += step) starts.push(y0);
    if (!starts.length || starts[starts.length - 1] + h < zone.y1) starts.push(zone.y1 - h);
    const need = Math.min(P.minCropCoverage, 0.9 * (rc.reduce((a, b) => a + b, 0) / Math.max(1, zh)));
    const mid = zone.y0 + (zh - h) / 2;
    const ranked = starts.filter(y0 => cov(y0) >= need && cov(y0) > 0).sort((a, b) => cov(b) - cov(a) || Math.abs(a - mid) - Math.abs(b - mid));
    if (!ranked.length) return {};
    const best = cov(ranked[0]);
    const read = ranked.filter(y0 => cov(y0) >= best - 0.02).sort((a, b) => Math.abs(a - mid) - Math.abs(b - mid))[0];
    const held = ranked.filter(y0 => Math.abs(y0 - read) >= h).sort((a, b) => cov(b) - cov(a))[0];
    const box = (y0: number): ImageRegion => ({ x0: zone.x0, x1: zone.x1, y0, y1: y0 + h });
    return { read: box(read), ...(held !== undefined ? { heldOut: box(held) } : {}) };
}

/** A region of the photo as a PNG scaled by `scale` (nearest texel), with optional outlines (photo pixels). */
export function regionPng(img: FacadePhoto, r: ImageRegion, scale: number, outlines: WindowRect[] = []): { png: Buffer; width: number; height: number; rgba: Uint8Array } {
    const W = img.width, ow = Math.max(1, Math.round((r.x1 - r.x0) * scale)), oh = Math.max(1, Math.round((r.y1 - r.y0) * scale));
    const out = new Uint8Array(ow * oh * 4);
    for (let y = 0; y < oh; y++) for (let x = 0; x < ow; x++) {
        const sx = Math.min(W - 1, r.x0 + Math.floor(x / scale)), sy = Math.min(img.height - 1, r.y0 + Math.floor(y / scale)), p = (sy * W + sx) * 4, q = (y * ow + x) * 4;
        out[q] = img.rgba[p]; out[q + 1] = img.rgba[p + 1]; out[q + 2] = img.rgba[p + 2]; out[q + 3] = 255;
    }
    const lw = Math.max(1, Math.round(scale / 2));
    for (const [x0, y0, x1, y1] of outlines) {
        const X0 = Math.round((x0 - r.x0) * scale), X1 = Math.round((x1 - r.x0) * scale) - 1, Y0 = Math.round((y0 - r.y0) * scale), Y1 = Math.round((y1 - r.y0) * scale) - 1;
        if (Y1 < 0 || Y0 >= oh || X1 < 0 || X0 >= ow) continue;
        for (let y = Math.max(0, Y0); y <= Math.min(oh - 1, Y1); y++) for (let x = Math.max(0, X0); x <= Math.min(ow - 1, X1); x++) {
            if (x - X0 >= lw && X1 - x >= lw && y - Y0 >= lw && Y1 - y >= lw) continue;
            out.set([255, 0, 255, 255], (y * ow + x) * 4);
        }
    }
    return { png: encodePng(ow, oh, out, 4), width: ow, height: oh, rgba: out };
}

/** Two crops side by side with a white gap, as one PNG. */
function sideBySide(a: { rgba: Uint8Array; width: number; height: number }, b: { rgba: Uint8Array; width: number; height: number }): Buffer {
    const gap = 16, w = a.width + gap + b.width, h = Math.max(a.height, b.height), out = new Uint8Array(w * h * 4).fill(255);
    for (let y = 0; y < a.height; y++) out.set(a.rgba.subarray(y * a.width * 4, (y + 1) * a.width * 4), y * w * 4);
    for (let y = 0; y < b.height; y++) out.set(b.rgba.subarray(y * b.width * 4, (y + 1) * b.width * 4), (y * w + a.width + gap) * 4);
    return encodePng(w, h, out, 4);
}

const scaleFor = (r: ImageRegion, P: FacadeReaderParams) => Math.min(P.maxScale, P.maxSidePx / Math.max(r.x1 - r.x0, r.y1 - r.y0));

// ------------------------------------------------------------------------------------------------ tiling the model's cell

export interface ReaderColumn { x0: number; x1: number; panes: number; rows: number }

/** The reading's openings gathered into columns by their centres (crop per-mille -> pixels across `cropW`), each seen in at least half the rows (or every one when a single row). */
export function columnsOf(reading: FacadeReading, cropW: number): ReaderColumn[] {
    const all = reading.rows.flatMap(r => r.openings.map(o => ({ x0: (o.x[0] / 1000) * cropW, x1: (o.x[1] / 1000) * cropW, panes: o.panes })));
    if (!all.length) return [];
    const widths = all.map(o => o.x1 - o.x0).sort((a, b) => a - b), tol = 0.5 * widths[widths.length >> 1];
    const groups: Array<typeof all> = [];
    for (const o of [...all].sort((a, b) => (a.x0 + a.x1) - (b.x0 + b.x1))) {
        const c = (o.x0 + o.x1) / 2, g = groups[groups.length - 1];
        if (g && Math.abs(c - (g[g.length - 1].x0 + g[g.length - 1].x1) / 2) <= tol) g.push(o); else groups.push([o]);
    }
    const med = (v: number[]) => { const s = [...v].sort((a, b) => a - b); return s[s.length >> 1]; };
    const need = reading.rows.length === 1 ? 1 : Math.ceil(reading.rows.length / 2);
    return groups.filter(g => g.length >= need).map(g => ({ x0: med(g.map(o => o.x0)), x1: med(g.map(o => o.x1)), panes: med(g.map(o => o.panes)), rows: g.length }));
}

export interface ZoneTiling { pitch: number; measured: boolean; columns: ReaderColumn[]; rows: Array<[number, number]>; rects: WindowRect[]; columnOf: number[] }

/**
 * The zone filled from the model's cell: its columns at their read places; its rows at the read storey pitch (measured
 * over the zone, within pitchSearch, where it repeats three times or more: the image's strongest repeat down the columns,
 * whichever way the brightness goes) from the read rows' own phase, each row the read opening height, through the zone;
 * an opening where the photo covers it.
 */
export function tileZone(L: Float32Array, W: number, zone: ImageRegion, crop: ImageRegion, reading: FacadeReading, P: FacadeReaderParams = FACADE_READER_PARAMS): ZoneTiling | { why: string } {
    const cw = crop.x1 - crop.x0, ch = crop.y1 - crop.y0;
    const columns = columnsOf(reading, cw).map(c => ({ ...c, x0: c.x0 + crop.x0, x1: c.x1 + crop.x0 }));
    if (!columns.length) return { why: 'the reading gave no column of openings' };
    const read = reading.rows.map(r => [crop.y0 + (r.y[0] / 1000) * ch, crop.y0 + (r.y[1] / 1000) * ch] as [number, number]).sort((a, b) => a[0] - b[0]);
    const oh = [...read.map(r => r[1] - r[0])].sort((a, b) => a - b)[read.length >> 1];
    // one row read: it alone (a ground floor, one band of rooflights)
    if (read.length < 2) {
        const rects: WindowRect[] = [], columnOf: number[] = [];
        columns.forEach((c, ci) => { if (coveredShare(L, W, c.x0, read[0][0], c.x1, read[0][1]) >= P.minCovered) { rects.push([c.x0, read[0][0], c.x1, read[0][1]]); columnOf.push(ci); } });
        return rects.length ? { pitch: 0, measured: false, columns, rows: [read[0]], rects, columnOf } : { why: 'the photo does not cover the one row read' };
    }
    const tops = read.map(r => r[0]), steps = tops.slice(1).map((t, i) => t - tops[i]).filter(s => s > 2).sort((a, b) => a - b);
    if (!steps.length) return { why: 'the rows read overlap' };
    let pitch = steps[steps.length >> 1], measured = false;
    // the pitch measured over the zone: the strongest autocorrelation of the columns' mean brightness near the read pitch
    if ((zone.y1 - zone.y0) >= 3 * pitch) {
        const prof: number[] = [];
        for (let y = zone.y0; y < zone.y1; y++) { let s = 0, n = 0; for (const c of columns) for (let x = Math.max(0, Math.floor(c.x0)); x < Math.min(W, Math.ceil(c.x1)); x++) { const v = L[y * W + x]; if (Number.isFinite(v)) { s += v; n++; } } prof.push(n ? s / n : NaN); }
        const fin = prof.filter(Number.isFinite), m = fin.reduce((a, b) => a + b, 0) / Math.max(1, fin.length);
        const ac = (lag: number) => { let s = 0, n = 0; for (let i = 0; i + lag < prof.length; i++) if (Number.isFinite(prof[i]) && Number.isFinite(prof[i + lag])) { s += (prof[i] - m) * (prof[i + lag] - m); n++; } return n > pitch ? s / n : -Infinity; };
        let best = -Infinity, bl = -1;
        for (let lag = Math.max(3, Math.floor(pitch * (1 - P.pitchSearch))); lag <= Math.ceil(pitch * (1 + P.pitchSearch)); lag++) { const v = ac(lag); if (v > best) { best = v; bl = lag; } }
        if (bl > 0 && best > 0) {
            const a1 = ac(bl - 1), a2 = ac(bl + 1), den = a1 - 2 * best + a2;
            pitch = Number.isFinite(a1) && Number.isFinite(a2) && den < 0 ? bl + 0.5 * (a1 - a2) / den : bl;
            measured = true;
        }
    }
    // the read rows' phase at that pitch (their circular mean), then every row through the zone
    let c = 0, sn = 0;
    for (const t of tops) { const a = (2 * Math.PI * t) / pitch; c += Math.cos(a); sn += Math.sin(a); }
    const phase = ((((Math.atan2(sn, c) / (2 * Math.PI)) * pitch) % pitch) + pitch) % pitch;
    const rows: Array<[number, number]> = [];
    for (let k = Math.ceil((zone.y0 - oh * 0.25 - phase) / pitch); phase + k * pitch + oh <= zone.y1 + oh * 0.25; k++) rows.push([phase + k * pitch, phase + k * pitch + oh]);
    const rects: WindowRect[] = [], columnOf: number[] = [];
    columns.forEach((col, ci) => { for (const [y0, y1] of rows) if (coveredShare(L, W, col.x0, y0, col.x1, y1) >= P.minCovered) { rects.push([col.x0, y0, col.x1, y1]); columnOf.push(ci); } });
    if (!rects.length) return { why: 'the photo does not cover the zone\'s openings' };
    return { pitch, measured, columns, rows, rects, columnOf };
}

// ------------------------------------------------------------------------------------------------ one plane, all planes

type FacadeFrame = FitFrame & { facadeId: number; image: string; coverage: number; uncoveredMask?: string; width: number; height: number; kind?: string };

const round2 = (r: WindowRect): WindowRect => r.map(v => Math.round(v * 100) / 100) as WindowRect;

/**
 * The agent on one plane (see the file comment): overview, a unit cell per zone, the zone tiled, judged. The record says
 * what each zone came to; the openings, panes and glass zones are returned when any zone was drawn.
 */
export async function readFacade(img: FacadePhoto, uncovered: ArrayLike<number> | undefined, f: FacadeFrame, ask: FacadeAsk, P: FacadeReaderParams = FACADE_READER_PARAMS, review?: (png: Buffer, tag: string) => void): Promise<{ record: FacadeReadRecord; rects?: WindowRect[]; panes?: WindowRect[]; glass?: Array<{ region: ImageRegion; glass: GlassReading }> }> {
    const t0 = Date.now(), W = img.width, H = img.height, roof = f.kind === 'roof';
    let calls = 0;
    const rec = (outcome: FacadeReadRecord['outcome'], why: string, zones?: ZoneRecord[]): FacadeReadRecord => ({ facadeId: f.facadeId, outcome, why, ...(zones ? { zones } : {}), calls, ms: Date.now() - t0 });
    const L = luminanceOf(img, uncovered);
    // a blank plane (its covered photo nearly uniform) holds nothing to read: no call
    { let s = 0, s2 = 0, n = 0; for (let k = 0; k < L.length; k++) if (Number.isFinite(L[k])) { s += L[k]; s2 += L[k] * L[k]; n++; } const m = n ? s / n : 0, sd = n ? Math.sqrt(Math.max(0, s2 / n - m * m)) : 0; if (!(m > 0) || sd / m < P.minContrast) return { record: rec('skipped', `blank: its photo varies by ${m > 0 ? Math.round((sd / m) * 100) : 0}% (under ${Math.round(P.minContrast * 100)}%)`) }; }
    const call = async (png: Buffer, prompt: string, kind: 'overview' | 'read' | 'judge', region: ImageRegion) => { calls++; return ask(png, prompt, kind, region); };
    const whole: ImageRegion = { x0: 0, x1: W, y0: 0, y1: H };
    const cropPx = P.readCropM / f.pixel;
    // 1. the zones: the whole plane when it fits one read crop, else the model's overview
    let zones: Array<{ region: ImageRegion; label?: string }>;
    if (H <= cropPx * 1.25) zones = [{ region: whole }];
    else {
        let parsed: ReturnType<typeof parseZones>;
        try { parsed = parseZones(await call(regionPng(img, whole, Math.min(1, scaleFor(whole, P))).png, overviewPrompt(W * f.pixel, H * f.pixel, roof), 'overview', whole)); }
        catch (err) { return { record: rec('failed', `the overview failed: ${err instanceof Error ? err.message : String(err)}`.slice(0, 300)) }; }
        if (parsed.conf < P.minConf) return { record: rec('kept', `the model was unsure of the plane's zones (${parsed.conf})`) };
        zones = parsed.zones.filter(z => z.openings).slice(0, P.maxZones).map(z => ({ region: { x0: Math.floor((z.box[0] / 1000) * W), y0: Math.floor((z.box[1] / 1000) * H), x1: Math.ceil((z.box[2] / 1000) * W), y1: Math.ceil((z.box[3] / 1000) * H) }, ...(z.label ? { label: z.label } : {}) }));
        if (!zones.length) return { record: rec('kept', 'the model saw no openings on the plane') };
    }
    // 2-4. per zone: the unit cell, the tiling, the judge
    const zoneRecs: ZoneRecord[] = [], rects: WindowRect[] = [], panes: WindowRect[] = [], glassZones: Array<{ region: ImageRegion; glass: GlassReading }> = [];
    for (const [zi, z] of zones.entries()) {
        const zr: ZoneRecord = { ...(z.label ? { label: z.label } : {}), region: z.region, outcome: 'failed', why: '' };
        zoneRecs.push(zr);
        if (z.region.x1 - z.region.x0 < 4 || z.region.y1 - z.region.y0 < 4) { zr.outcome = 'none'; zr.why = 'the zone is too small to read'; continue; }
        const { read, heldOut } = zoneCrops(L, W, z.region, cropPx, P);
        if (!read) { zr.outcome = 'none'; zr.why = 'no part of the zone is covered enough to read'; continue; }
        const scale = scaleFor(read, P);
        let reading: FacadeReading;
        try { reading = parseReading(await call(regionPng(img, read, scale).png, readPrompt((read.x1 - read.x0) * f.pixel, (read.y1 - read.y0) * f.pixel, roof), 'read', read)); }
        catch (err) { zr.why = `the reading failed: ${err instanceof Error ? err.message : String(err)}`.slice(0, 300); continue; }
        zr.reading = { rows: reading.rows.length, openings: reading.rows.reduce((a, r) => a + r.openings.length, 0), conf: reading.conf, ...(reading.notes ? { notes: reading.notes } : {}), ...(reading.between ? { between: reading.between } : {}) };
        if (reading.glass) zr.glass = reading.glass;
        if (reading.conf < P.minConf) { zr.outcome = 'none'; zr.why = `the model was unsure of its reading (${reading.conf})`; continue; }
        if (!reading.rows.length) { zr.outcome = 'none'; zr.why = 'the model saw no openings in the zone'; continue; }
        const t = tileZone(L, W, z.region, read, reading, P);
        if ('why' in t) { zr.outcome = 'none'; zr.why = t.why; continue; }
        zr.fit = { pitchPx: Math.round(t.pitch * 100) / 100, pitchM: Math.round(t.pitch * f.pixel * 100) / 100, measured: t.measured, columns: t.columns.length, rows: t.rows.length, openings: t.rects.length };
        // the judge: the outlines over the read crop and a held-out one
        const kept = [...new Set(t.columnOf)].sort((a, b) => a - b);
        const judged = sideBySide(regionPng(img, read, scale, t.rects), regionPng(img, heldOut ?? read, scale, t.rects));
        review?.(judged, `z${zi}`);
        let judge: FacadeJudgement;
        try { judge = parseJudgement(await call(judged, judgePrompt(kept.length), 'judge', heldOut ?? read)); }
        catch (err) { zr.why = `the judgement failed: ${err instanceof Error ? err.message : String(err)}`.slice(0, 300); continue; }
        zr.judge = judge;
        if (!judge.accept || judge.conf < P.minConf) { zr.outcome = 'rejected'; zr.why = judge.accept ? `the judge was unsure (${judge.conf})` : `the judge rejected the outlines${judge.notes ? `: ${judge.notes}` : ''}`; continue; }
        const bad = new Set(judge.badColumns.map(n => kept[n - 1]).filter(v => v !== undefined));
        let drawn = 0;
        t.rects.forEach((r, i) => {
            const ci = t.columnOf[i];
            if (bad.has(ci)) return;
            rects.push(round2(r)); drawn++;
            const n = t.columns[ci].panes, pw = (r[2] - r[0]) / n;
            for (let q = 0; q < n; q++) panes.push(round2([r[0] + q * pw, r[1], r[0] + (q + 1) * pw, r[3]]));
        });
        if (!drawn) { zr.outcome = 'rejected'; zr.why = 'the judge rejected every column'; continue; }
        zr.outcome = 'drawn'; zr.why = `${drawn} openings in ${kept.length - bad.size} columns${t.rows.length > 1 ? `, every ${zr.fit.pitchM} m` : ''}${bad.size ? `; ${bad.size} columns rejected by the judge` : ''}`;
        if (reading.glass) glassZones.push({ region: z.region, glass: reading.glass });
    }
    const drawnZones = zoneRecs.filter(z => z.outcome === 'drawn');
    if (!drawnZones.length) return { record: rec('kept', zoneRecs.map(z => `${z.label ?? 'zone'}: ${z.why}`).join('; ').slice(0, 400) || 'no zone drawn', zoneRecs) };
    return { record: rec('replaced', `${rects.length} openings in ${drawnZones.length} of ${zoneRecs.length} zones`, zoneRecs), rects, panes, glass: glassZones };
}

/** One plane's drawn openings, panes and glass zones, in its photo's pixels. */
export interface PlaneReading { facadeId: number; width: number; height: number; rects: WindowRect[]; panes: WindowRect[]; glass?: Array<{ region: ImageRegion; glass: GlassReading }> }

export interface FacadeReaderFile {
    version: string; params: FacadeReaderParams; ms: number; facades: FacadeReadRecord[];
    /** The planes past maxPlanes, not read, and their covered area. */
    unread: { planes: number; areaM2: number };
    /** The planes whose openings were drawn. */
    readings: PlaneReading[];
}

export const FACADE_READER_FILE = 'facade_reader.json';

/**
 * Reads the largest covered planes of an orthos directory (maxPlanes at most): the walls tile_refine photographed
 * (facades.json) and every other plane (planes.json). Needs only the photos, so it runs beside the window fit; its
 * readings go into window_fit.json after (mergeReadings). Done once per photo set: facade_reader.json of this version is
 * returned as it is. The judged overlays are kept in facade_reader/ for review.
 */
export async function readPlanes(orthosDir: string, ask: FacadeAsk, opts: { signal?: AbortSignal; params?: FacadeReaderParams; progress?: (m: string) => void } = {}): Promise<{ records: FacadeReaderFile; cached: boolean }> {
    const P = opts.params ?? FACADE_READER_PARAMS;
    const recFile = path.join(orthosDir, FACADE_READER_FILE);
    if (fs.existsSync(recFile)) {
        const prior = JSON.parse(fs.readFileSync(recFile, 'utf8')) as FacadeReaderFile;
        if (prior.version === FACADE_READER_VERSION && JSON.stringify(prior.params) === JSON.stringify(P) && Array.isArray(prior.readings)) return { records: prior, cached: true };
    }
    const t0 = Date.now();
    // the walls tile_refine photographed (facades.json), then every other plane of the building (plane-orthos.ts: roofs,
    // terraces, slopes, the walls it did not analyse); the largest covered area first, up to maxPlanes, the rest reported
    const pf = path.join(orthosDir, PLANES_FILE);
    const others = fs.existsSync(pf) ? (JSON.parse(fs.readFileSync(pf, 'utf8')) as PlaneOrthosFile).planes as unknown as FacadeFrame[] : [];
    const areaOf = (f: FacadeFrame) => f.width * f.height * f.pixel * f.pixel * (f.coverage ?? 0);
    const eligible = [...(JSON.parse(fs.readFileSync(path.join(orthosDir, 'facades.json'), 'utf8')).facades as FacadeFrame[]), ...others]
        .filter(f => fs.existsSync(path.join(orthosDir, f.image)) && (f.coverage ?? 0) >= P.minCoverage && (f.kind === 'roof' ? f.width * f.pixel >= P.minWidthM && f.height * f.pixel >= P.minWidthM : f.width * f.pixel >= P.minWidthM && f.height * f.pixel >= P.minHeightM))
        .sort((a, b) => areaOf(b) - areaOf(a));
    const frames = eligible.slice(0, P.maxPlanes);
    const unread = { planes: eligible.length - frames.length, areaM2: Math.round(eligible.slice(P.maxPlanes).reduce((a, f) => a + areaOf(f), 0)) };
    const reviewDir = path.join(orthosDir, 'facade_reader');
    fs.mkdirSync(reviewDir, { recursive: true });
    const records: FacadeReadRecord[] = [], readings: PlaneReading[] = [];
    let next = 0, done = 0;
    const worker = async () => {
        for (;;) {
            const f = frames[next++];
            if (!f) return;
            if (opts.signal?.aborted) throw opts.signal.reason ?? new Error('aborted');
            try {
                const d = decodePng(fs.readFileSync(path.join(orthosDir, f.image)));
                let uncovered: Uint8Array | undefined;
                const mf = f.uncoveredMask ? path.join(orthosDir, f.uncoveredMask) : undefined;
                if (mf && fs.existsSync(mf)) { const m = decodePng(fs.readFileSync(mf)); uncovered = Uint8Array.from({ length: m.width * m.height }, (_, k) => (m.rgba[k * 4] >= 128 ? 1 : 0)); }
                const r = await readFacade({ rgba: d.rgba, width: d.width, height: d.height }, uncovered, f, ask, P, (png, tag) => fs.writeFileSync(path.join(reviewDir, `${f.facadeId}_${tag}.png`), png));
                records.push(r.record);
                if (r.rects && r.panes) readings.push({ facadeId: f.facadeId, width: d.width, height: d.height, rects: r.rects, panes: r.panes, ...(r.glass?.length ? { glass: r.glass } : {}) });
            } catch (err) {
                if (opts.signal?.aborted) throw err;
                records.push({ facadeId: f.facadeId, outcome: 'failed', why: (err instanceof Error ? err.message : String(err)).slice(0, 300), ms: 0 });
            }
            opts.progress?.(`pipeline K: reading the building's planes (${++done} of ${frames.length})`);
        }
    };
    await Promise.all(Array.from({ length: Math.max(1, Math.min(P.concurrency, frames.length)) }, worker));
    records.sort((a, b) => a.facadeId - b.facadeId);
    readings.sort((a, b) => a.facadeId - b.facadeId);
    const file: FacadeReaderFile = { version: FACADE_READER_VERSION, params: P, ms: Date.now() - t0, facades: records, unread, readings };
    fs.writeFileSync(recFile, JSON.stringify(file));
    return { records: file, cached: false };
}

/**
 * The readings written into window_fit.json in place of the window fit's openings for those planes (the window fit's own
 * kept as `structural`; a plane the window fit never saw, a roof, gets an entry of its own). Returns the merged fit.
 */
export function mergeReadings(orthosDir: string, fit: WindowFitFile, readings: PlaneReading[]): WindowFitFile {
    for (const r of readings) {
        let entry = fit.facades.find(e => e.facadeId === r.facadeId);
        if (entry && 'error' in entry) continue;
        if (!entry) { entry = { facadeId: r.facadeId, width: r.width, height: r.height, rects: [], panes: [], bands: [], ms: 0 }; fit.facades.push(entry); }
        const e = entry as Extract<WindowFitFile['facades'][number], { rects: WindowRect[] }> & { structural?: { rects: WindowRect[]; panes?: WindowRect[]; generated?: WindowRect[] }; reader?: string; glass?: PlaneReading['glass'] };
        if (e.reader !== FACADE_READER_VERSION) e.structural = { rects: e.rects, ...(e.panes ? { panes: e.panes } : {}), ...(e.generated ? { generated: e.generated } : {}) };
        e.rects = r.rects; e.panes = r.panes; delete e.generated; e.reader = FACADE_READER_VERSION;
        if (r.glass) e.glass = r.glass; else delete e.glass;
    }
    (fit as WindowFitFile & { reader?: string }).reader = FACADE_READER_VERSION;
    fs.writeFileSync(path.join(orthosDir, 'window_fit.json'), JSON.stringify(fit));
    return fit;
}

/** The planes past the walls (planes.json) whose openings the reader placed, as fitted planes for the material regions' scan pieces. */
export function readerPlanesOf(orthosDir: string): FittedPlane[] {
    const pf = path.join(orthosDir, PLANES_FILE), wf = path.join(orthosDir, 'window_fit.json');
    if (!fs.existsSync(pf) || !fs.existsSync(wf)) return [];
    const fit = JSON.parse(fs.readFileSync(wf, 'utf8')) as WindowFitFile;
    return (JSON.parse(fs.readFileSync(pf, 'utf8')) as PlaneOrthosFile).planes.flatMap(f => {
        const e = fit.facades.find(x => x.facadeId === f.facadeId);
        if (!e || 'error' in e || !e.rects.length || e.width !== f.width || e.height !== f.height) return [];
        return [{ facadeId: f.facadeId, centroid: f.centroid, normal: f.normal, axisS: f.axisS, axisT: f.axisT, orthoSMin: f.orthoSMin, orthoTMax: f.orthoTMax, pixel: f.pixel, width: f.width, height: f.height, windows: e.rects, panes: e.panes ?? [] }];
    });
}
