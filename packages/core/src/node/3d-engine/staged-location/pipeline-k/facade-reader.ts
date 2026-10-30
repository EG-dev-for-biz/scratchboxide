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
 *     The wide walls go first; a narrow face (a tower's window column, a few metres wide, where the model tends to
 *     skip storeys) is guided by the storey pitch they were read at: a reading whose rows are a whole number of
 *     those storeys apart, or a single row, is tiled at it (storeys run on around a building). Its overview and reading
 *     go out at once; only its tiling waits for every wide wall to be read;
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
import { contactSheet, contextFor, parseBrief, briefPrompt, planePlaces, type BuildingBrief, type NamedBuilding, type PlaneFamily } from './facade-reader-brief';
import { exemplarOf, matchExemplar, mergeMatches, TEMPLATE_PARAMS, type TemplateMatch, type WindowExemplar } from './facade-reader-template';
import { PLANES_FILE, type PlaneOrthosFile } from './plane-orthos';

export const FACADE_READER_VERSION = 'facade-reader/10';

/** The reader's vision model: fast, cheap and good enough at reading openings (benchmarked 2026-10-29 on the ESB's tower crops against gemini-4-argon and gemini-3.5-flash-lite); the app's other vision models are the fallback. */
export const FACADE_READER_MODEL = { model: 'gemini-3.8-flash', thinkingBudget: 512 } as const;

export const FACADE_READER_PARAMS = {
    /** Planes smaller than this (m), or with less of their photo covered, are not read: a wall at least minWallWidthM wide and minHeightM tall (a tower's narrow window-column faces included), a roof at least minWidthM each way. */
    minWallWidthM: 2, minWidthM: 6, minHeightM: 10, minCoverage: 0.3,
    /** The unit cell's crop: up to this tall (m), at least this covered (or nine tenths of the plane's own coverage); the image the model sees
     * is scaled to at most maxSidePx. (2026-10-29: cut to 1200 and concurrency to 6 chasing an OOM that looked like request-compression
     * pressure; the real cause was tileZone's pitch refinement, fixed in facade-reader/9. Restored to 1600 now that it's fixed.) */
    readCropM: 24, minCropCoverage: 0.7, maxSidePx: 1600, maxScale: 4,
    /** Zones read per plane at most. */
    maxZones: 4,
    /** Planes read per build at most (the walls first, then the roofs, each largest covered area first; the rest reported unread). */
    maxPlanes: 120,
    /** Model calls in flight at once, over every plane: a plane's zone reads go out together once its overview is back, so
     * the calls, not the planes, are what is limited (2026-10-29: the planes one call at a time kept ~4 of 12 slots busy;
     * replayed on the ESB's recorded call chains, 198 s with 12 planes -> 83 s with 32 calls over 24 planes, the floor ~65 s). */
    concurrency: 32,
    /** Planes being read at once, each holding its decoded photo while its calls are out. */
    openPlanes: 24,
    /** A plane whose covered photo varies less than this (luminance standard deviation over mean) is blank: nothing to read, no call. */
    minContrast: 0.06,
    /** The pitch is measured within this share of the read pitch; an opening is drawn where this share of it is covered. */
    pitchSearch: 0.1, minCovered: 0.6,
    /** The model's own confidence (0-100) below which a reading or a judgement is not taken. */
    minConf: 40,
    /** The building brief first (facade-reader-brief.ts): every reading told the building, its plane's family and place. */
    brief: true,
    /** A family's other planes look for its lead's accepted window in their photo before being read (facade-reader-template.ts). */
    template: true,
    /** A family member drawn from its lead's window must reach this share of the lead's openings per covered square metre, or it is read (the judge checks the outlines drawn, not the openings missed). */
    templateDensity: 0.6
} as const;
export type FacadeReaderParams = typeof FACADE_READER_PARAMS;

/** Which part of the plane an image shows, in its pixels: columns [x0, x1), rows [y0, y1). */
export interface ImageRegion { x0: number; x1: number; y0: number; y1: number }

/** One call to the vision model: a PNG and a prompt in, the reply's text out; `region` says what part of the plane it shows. */
export type FacadeAsk = (png: Buffer, prompt: string, kind: 'overview' | 'read' | 'judge' | 'brief', region: ImageRegion) => Promise<string>;

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
    fit?: { pitchPx: number; pitchM: number; measured: boolean; /** The storey pitch taken from the building's wide walls (readPlanes' guide). */ guided?: boolean; columns: number; rows: number; openings: number };
    glass?: GlassReading; judge?: FacadeJudgement;
    /** Drawn from the family's window found again in this photo (facade-reader-template.ts), not read: from which plane, how many matched, how many filled in on their grid. */
    template?: { fromPlane: number; matches: number; gridFilled: number };
}

export interface FacadeReadRecord {
    facadeId: number;
    outcome: 'replaced' | 'kept' | 'skipped' | 'failed';
    why: string;
    zones?: ZoneRecord[];
    /** Its family in the building brief. */
    family?: string;
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
        'Judge whether the outlines sit on the real openings: each outline should cover one opening\'s glass, not a pier, a spandrel or blank surface, and every opening in a column should have its outline. Uniform grey or black areas are not covered by the photo: no outlines are drawn there on purpose, so openings you cannot see there are not missed.',
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

/**
 * A region of the photo as a PNG scaled by `scale` (nearest texel), with optional outlines (photo pixels). With `L`, the
 * texels the photo never reached (NaN there) are drawn uniform grey, so the model neither reads nor misses openings in
 * texture filled from the facade's repeats.
 */
export function regionPng(img: FacadePhoto, r: ImageRegion, scale: number, outlines: WindowRect[] = [], L?: Float32Array): { png: Buffer; width: number; height: number; rgba: Uint8Array } {
    const W = img.width, ow = Math.max(1, Math.round((r.x1 - r.x0) * scale)), oh = Math.max(1, Math.round((r.y1 - r.y0) * scale));
    const out = new Uint8Array(ow * oh * 4);
    for (let y = 0; y < oh; y++) for (let x = 0; x < ow; x++) {
        const sx = Math.min(W - 1, r.x0 + Math.floor(x / scale)), sy = Math.min(img.height - 1, r.y0 + Math.floor(y / scale)), p = (sy * W + sx) * 4, q = (y * ow + x) * 4;
        if (L && !Number.isFinite(L[sy * W + sx])) { out[q] = out[q + 1] = out[q + 2] = 128; out[q + 3] = 255; continue; }
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

export interface ZoneTiling { pitch: number; measured: boolean; guided?: boolean; columns: ReaderColumn[]; rows: Array<[number, number]>; rects: WindowRect[]; columnOf: number[] }

/**
 * The zone filled from the model's cell: its columns at their read places; its rows at the read storey pitch (measured
 * over the zone, within pitchSearch, where it repeats three times or more: the image's strongest repeat down the columns,
 * whichever way the brightness goes) from the read rows' own phase, each row the read opening height, through the zone;
 * an opening where the photo covers it. With `guidePx`, the storey pitch the building's wide walls were read at: a narrow
 * face's reading that skips storeys (its rows a whole number of guide pitches apart, within a fifth of one) or holds a
 * single row is tiled at the guide pitch instead (storeys run on around a building).
 */
export function tileZone(L: Float32Array, W: number, zone: ImageRegion, crop: ImageRegion, reading: FacadeReading, P: FacadeReaderParams = FACADE_READER_PARAMS, guidePx?: number): ZoneTiling | { why: string } {
    const cw = crop.x1 - crop.x0, ch = crop.y1 - crop.y0;
    const columns = columnsOf(reading, cw).map(c => ({ ...c, x0: c.x0 + crop.x0, x1: c.x1 + crop.x0 }));
    if (!columns.length) return { why: 'the reading gave no column of openings' };
    const read = reading.rows.map(r => [crop.y0 + (r.y[0] / 1000) * ch, crop.y0 + (r.y[1] / 1000) * ch] as [number, number]).sort((a, b) => a[0] - b[0]);
    const oh = [...read.map(r => r[1] - r[0])].sort((a, b) => a - b)[read.length >> 1];
    // one row read: it alone (a ground floor, one band of rooflights), unless a guide says the storeys run on
    if (read.length < 2 && !(guidePx && guidePx > 2)) {
        const rects: WindowRect[] = [], columnOf: number[] = [];
        columns.forEach((c, ci) => { if (coveredShare(L, W, c.x0, read[0][0], c.x1, read[0][1]) >= P.minCovered) { rects.push([c.x0, read[0][0], c.x1, read[0][1]]); columnOf.push(ci); } });
        return rects.length ? { pitch: 0, measured: false, columns, rows: [read[0]], rects, columnOf } : { why: 'the photo does not cover the one row read' };
    }
    const tops = read.map(r => r[0]), steps = tops.slice(1).map((t, i) => t - tops[i]).filter(s => s > 2).sort((a, b) => a - b);
    if (!steps.length && !(guidePx && guidePx > 2)) return { why: 'the rows read overlap' };
    let pitch = steps.length ? steps[steps.length >> 1] : guidePx!, measured = false, guided = !steps.length;
    // a reading that skips storeys: its rows a whole number of the building's storeys apart
    if (guidePx && guidePx > 2 && steps.length) { const n = pitch / guidePx; if (Math.round(n) >= 1 && Math.abs(n - Math.round(n)) <= 0.2) { guided = Math.round(n) > 1 || Math.abs(pitch - guidePx) > 1; pitch = guidePx; } }
    // the pitch measured over the zone: the strongest autocorrelation of the columns' mean brightness near the read pitch
    if ((zone.y1 - zone.y0) >= 3 * pitch) {
        const prof: number[] = [];
        for (let y = zone.y0; y < zone.y1; y++) { let s = 0, n = 0; for (const c of columns) for (let x = Math.max(0, Math.floor(c.x0)); x < Math.min(W, Math.ceil(c.x1)); x++) { const v = L[y * W + x]; if (Number.isFinite(v)) { s += v; n++; } } prof.push(n ? s / n : NaN); }
        const fin = prof.filter(Number.isFinite), m = fin.reduce((a, b) => a + b, 0) / Math.max(1, fin.length);
        const ac = (lag: number) => { let s = 0, n = 0; for (let i = 0; i + lag < prof.length; i++) if (Number.isFinite(prof[i]) && Number.isFinite(prof[i + lag])) { s += (prof[i] - m) * (prof[i + lag] - m); n++; } return n > pitch ? s / n : -Infinity; };
        let best = -Infinity, bl = -1;
        // guided: the building's pitch held within 3% (a narrow face's own repeat is noisy)
        const span = guided ? 0.03 : P.pitchSearch;
        for (let lag = Math.max(3, Math.floor(pitch * (1 - span))); lag <= Math.ceil(pitch * (1 + span)); lag++) { const v = ac(lag); if (v > best) { best = v; bl = lag; } }
        if (bl > 0 && best > 0) {
            // the parabola's vertex only when the best lag peaks above both neighbours (then within half a lag of it): at the
            // search's edge, the repeat still rising past it, the vertex can lie anywhere, and a pitch near or below zero
            // tiled the zone without end until the process ran out of memory (ESB, 2026-10-29)
            const a1 = ac(bl - 1), a2 = ac(bl + 1), den = a1 - 2 * best + a2;
            const m2 = Number.isFinite(a1) && Number.isFinite(a2) && den < 0 && a1 <= best && a2 <= best ? bl + 0.5 * (a1 - a2) / den : bl;
            if (!guided || Math.abs(m2 - pitch) <= 0.03 * pitch) { pitch = m2; measured = true; }
        }
    }
    // a row loop over a pitch this small would not end
    if (!(pitch > 2)) return { why: `the storey pitch came to ${Number.isFinite(pitch) ? pitch.toFixed(2) : String(pitch)} px` };
    // the read rows' phase at that pitch (their circular mean), then every row through the zone
    let c = 0, sn = 0;
    for (const t of tops) { const a = (2 * Math.PI * t) / pitch; c += Math.cos(a); sn += Math.sin(a); }
    const phase = ((((Math.atan2(sn, c) / (2 * Math.PI)) * pitch) % pitch) + pitch) % pitch;
    const rows: Array<[number, number]> = [];
    for (let k = Math.ceil((zone.y0 - oh * 0.25 - phase) / pitch); phase + k * pitch + oh <= zone.y1 + oh * 0.25; k++) rows.push([phase + k * pitch, phase + k * pitch + oh]);
    const rects: WindowRect[] = [], columnOf: number[] = [];
    columns.forEach((col, ci) => { for (const [y0, y1] of rows) if (coveredShare(L, W, col.x0, y0, col.x1, y1) >= P.minCovered) { rects.push([col.x0, y0, col.x1, y1]); columnOf.push(ci); } });
    if (!rects.length) return { why: 'the photo does not cover the zone\'s openings' };
    return { pitch, measured, ...(guided ? { guided } : {}), columns, rows, rects, columnOf };
}

// ------------------------------------------------------------------------------------------------ one plane, all planes

type FacadeFrame = FitFrame & { facadeId: number; image: string; coverage: number; uncoveredMask?: string; width: number; height: number; kind?: string };

const round2 = (r: WindowRect): WindowRect => r.map(v => Math.round(v * 100) / 100) as WindowRect;

/**
 * The agent on one plane (see the file comment): overview, a unit cell per zone, the zone tiled, judged. The record says
 * what each zone came to; the openings, panes and glass zones are returned when any zone was drawn.
 */
export async function readFacade(img: FacadePhoto, uncovered: ArrayLike<number> | undefined, f: FacadeFrame, ask: FacadeAsk, P: FacadeReaderParams = FACADE_READER_PARAMS, review?: (png: Buffer, tag: string) => void, guide?: { pitchM: number } | Promise<{ pitchM: number } | undefined>, context = ''): Promise<{ record: FacadeReadRecord; rects?: WindowRect[]; panes?: WindowRect[]; glass?: Array<{ region: ImageRegion; glass: GlassReading }>; exemplars?: WindowExemplar[] }> {
    const t0 = Date.now(), W = img.width, H = img.height, roof = f.kind === 'roof';
    let calls = 0;
    const rec = (outcome: FacadeReadRecord['outcome'], why: string, zones?: ZoneRecord[]): FacadeReadRecord => ({ facadeId: f.facadeId, outcome, why, ...(zones ? { zones } : {}), calls, ms: Date.now() - t0 });
    const L = luminanceOf(img, uncovered);
    // a blank plane (its covered photo nearly uniform) holds nothing to read: no call
    { let s = 0, s2 = 0, n = 0; for (let k = 0; k < L.length; k++) if (Number.isFinite(L[k])) { s += L[k]; s2 += L[k] * L[k]; n++; } const m = n ? s / n : 0, sd = n ? Math.sqrt(Math.max(0, s2 / n - m * m)) : 0; if (!(m > 0) || sd / m < P.minContrast) return { record: rec('skipped', `blank: its photo varies by ${m > 0 ? Math.round((sd / m) * 100) : 0}% (under ${Math.round(P.minContrast * 100)}%)`) }; }
    const call = async (png: Buffer, prompt: string, kind: 'overview' | 'read' | 'judge', region: ImageRegion) => { calls++; return ask(png, prompt, kind, region); };
    // the building around the plane, for the overview and the reading (never the judge: it sees only the outlines and the photo)
    const told = (prompt: string) => (context ? `${context}\n\n${prompt}` : prompt);
    const whole: ImageRegion = { x0: 0, x1: W, y0: 0, y1: H };
    const cropPx = P.readCropM / f.pixel;
    // 1. the zones: the whole plane when it fits one read crop, else the model's overview
    let zones: Array<{ region: ImageRegion; label?: string }>;
    if (H <= cropPx * 1.25) zones = [{ region: whole }];
    else {
        let parsed: ReturnType<typeof parseZones>;
        try { parsed = parseZones(await call(regionPng(img, whole, Math.min(1, scaleFor(whole, P)), [], L).png, told(overviewPrompt(W * f.pixel, H * f.pixel, roof)), 'overview', whole)); }
        catch (err) { return { record: rec('failed', `the overview failed: ${err instanceof Error ? err.message : String(err)}`.slice(0, 300)) }; }
        if (parsed.conf < P.minConf) return { record: rec('kept', `the model was unsure of the plane's zones (${parsed.conf})`) };
        zones = parsed.zones.filter(z => z.openings).slice(0, P.maxZones).map(z => ({ region: { x0: Math.floor((z.box[0] / 1000) * W), y0: Math.floor((z.box[1] / 1000) * H), x1: Math.ceil((z.box[2] / 1000) * W), y1: Math.ceil((z.box[3] / 1000) * H) }, ...(z.label ? { label: z.label } : {}) }));
        if (!zones.length) return { record: rec('kept', 'the model saw no openings on the plane') };
    }
    // 2-4. per zone, every zone at once: the unit cell, the tiling, the judge
    const readZone = async (z: { region: ImageRegion; label?: string }, zi: number): Promise<{ zr: ZoneRecord; rects: WindowRect[]; panes: WindowRect[]; glass?: { region: ImageRegion; glass: GlassReading }; exemplar?: WindowExemplar }> => {
        const zr: ZoneRecord = { ...(z.label ? { label: z.label } : {}), region: z.region, outcome: 'failed', why: '' };
        const rects: WindowRect[] = [], panes: WindowRect[] = [];
        if (z.region.x1 - z.region.x0 < 4 || z.region.y1 - z.region.y0 < 4) { zr.outcome = 'none'; zr.why = 'the zone is too small to read'; return { zr, rects, panes }; }
        const { read, heldOut } = zoneCrops(L, W, z.region, cropPx, P);
        if (!read) { zr.outcome = 'none'; zr.why = 'no part of the zone is covered enough to read'; return { zr, rects, panes }; }
        const scale = scaleFor(read, P);
        let reading: FacadeReading;
        try { reading = parseReading(await call(regionPng(img, read, scale, [], L).png, told(readPrompt((read.x1 - read.x0) * f.pixel, (read.y1 - read.y0) * f.pixel, roof)), 'read', read)); }
        catch (err) { zr.why = `the reading failed: ${err instanceof Error ? err.message : String(err)}`.slice(0, 300); return { zr, rects, panes }; }
        zr.reading = { rows: reading.rows.length, openings: reading.rows.reduce((a, r) => a + r.openings.length, 0), conf: reading.conf, ...(reading.notes ? { notes: reading.notes } : {}), ...(reading.between ? { between: reading.between } : {}) };
        if (reading.glass) zr.glass = reading.glass;
        if (reading.conf < P.minConf) { zr.outcome = 'none'; zr.why = `the model was unsure of its reading (${reading.conf})`; return { zr, rects, panes }; }
        if (!reading.rows.length) { zr.outcome = 'none'; zr.why = 'the model saw no openings in the zone'; return { zr, rects, panes }; }
        // a narrow face's tiling waits here for the building's storey pitch (every wide wall read)
        const g = guide && !roof ? await guide : undefined;
        const t = tileZone(L, W, z.region, read, reading, P, g ? g.pitchM / f.pixel : undefined);
        if ('why' in t) { zr.outcome = 'none'; zr.why = t.why; return { zr, rects, panes }; }
        zr.fit = { pitchPx: Math.round(t.pitch * 100) / 100, pitchM: Math.round(t.pitch * f.pixel * 100) / 100, measured: t.measured, ...(t.guided ? { guided: true } : {}), columns: t.columns.length, rows: t.rows.length, openings: t.rects.length };
        // the judge: the outlines over the read crop and a held-out one
        const kept = [...new Set(t.columnOf)].sort((a, b) => a - b);
        const judged = sideBySide(regionPng(img, read, scale, t.rects, L), regionPng(img, heldOut ?? read, scale, t.rects, L));
        review?.(judged, `z${zi}`);
        let judge: FacadeJudgement;
        try { judge = parseJudgement(await call(judged, judgePrompt(kept.length), 'judge', heldOut ?? read)); }
        catch (err) { zr.why = `the judgement failed: ${err instanceof Error ? err.message : String(err)}`.slice(0, 300); return { zr, rects, panes }; }
        zr.judge = judge;
        if (!judge.accept || judge.conf < P.minConf) { zr.outcome = 'rejected'; zr.why = judge.accept ? `the judge was unsure (${judge.conf})` : `the judge rejected the outlines${judge.notes ? `: ${judge.notes}` : ''}`; return { zr, rects, panes }; }
        const bad = new Set(judge.badColumns.map(n => kept[n - 1]).filter(v => v !== undefined));
        let drawn = 0;
        t.rects.forEach((r, i) => {
            const ci = t.columnOf[i];
            if (bad.has(ci)) return;
            rects.push(round2(r)); drawn++;
            const n = t.columns[ci].panes, pw = (r[2] - r[0]) / n;
            for (let q = 0; q < n; q++) panes.push(round2([r[0] + q * pw, r[1], r[0] + (q + 1) * pw, r[3]]));
        });
        if (!drawn) { zr.outcome = 'rejected'; zr.why = 'the judge rejected every column'; return { zr, rects, panes }; }
        zr.outcome = 'drawn'; zr.why = `${drawn} openings in ${kept.length - bad.size} columns${t.rows.length > 1 ? `, every ${zr.fit.pitchM} m` : ''}${bad.size ? `; ${bad.size} columns rejected by the judge` : ''}`;
        // the zone's window for its family's other planes: the accepted opening nearest the zone's middle
        const cx = (z.region.x0 + z.region.x1) / 2, cy = (z.region.y0 + z.region.y1) / 2;
        const byMiddle = t.rects.map((r, i) => ({ r, i })).filter(({ i }) => !bad.has(t.columnOf[i])).sort((a, b) => Math.hypot((a.r[0] + a.r[2]) / 2 - cx, (a.r[1] + a.r[3]) / 2 - cy) - Math.hypot((b.r[0] + b.r[2]) / 2 - cx, (b.r[1] + b.r[3]) / 2 - cy));
        let exemplar: WindowExemplar | undefined;
        for (const { r, i } of byMiddle) { exemplar = exemplarOf({ L, W, H, pixel: f.pixel }, r, t.columns[t.columnOf[i]].panes, f.facadeId, z.label); if (exemplar) break; }
        if (exemplar && t.rows.length > 1 && t.pitch > 0) exemplar.pitchM = t.pitch * f.pixel;
        return { zr, rects, panes, ...(reading.glass ? { glass: { region: z.region, glass: reading.glass } } : {}), ...(exemplar ? { exemplar } : {}) };
    };
    // each zone's result in zone order, as one zone after another gave them
    const results = await Promise.all(zones.map((z, zi) => readZone(z, zi)));
    const zoneRecs = results.map(r => r.zr), rects = results.flatMap(r => r.rects), panes = results.flatMap(r => r.panes);
    const glassZones = results.flatMap(r => (r.glass ? [r.glass] : []));
    const drawnZones = zoneRecs.filter(z => z.outcome === 'drawn');
    if (!drawnZones.length) return { record: rec('kept', zoneRecs.map(z => `${z.label ?? 'zone'}: ${z.why}`).join('; ').slice(0, 400) || 'no zone drawn', zoneRecs) };
    const exemplars = results.flatMap(r => (r.exemplar ? [r.exemplar] : []));
    return { record: rec('replaced', `${rects.length} openings in ${drawnZones.length} of ${zoneRecs.length} zones`, zoneRecs), rects, panes, glass: glassZones, ...(exemplars.length ? { exemplars } : {}) };
}

/**
 * A family member drawn from its family's windows found again in its own photo (facade-reader-template.ts), with no reading:
 * the matches gathered into columns and judged on two crops as a reading's outlines are. Undefined when too few match or
 * the judge does not accept them (the plane is then read).
 */
export async function readFromTemplates(img: FacadePhoto, uncovered: ArrayLike<number> | undefined, f: FacadeFrame, family: { name: string; exemplars: WindowExemplar[]; glass?: GlassReading; /** The lead's openings per covered square metre. */ density?: number }, ask: FacadeAsk, P: FacadeReaderParams = FACADE_READER_PARAMS, review?: (png: Buffer, tag: string) => void): Promise<{ record: FacadeReadRecord; rects: WindowRect[]; panes: WindowRect[]; glass?: Array<{ region: ImageRegion; glass: GlassReading }> } | undefined> {
    const t0 = Date.now(), W = img.width, H = img.height;
    const L = luminanceOf(img, uncovered);
    // the photo's matches of each exemplar give its grid (facade-reader-template.ts): the columns they stand in, at least a
    // quarter as often as the best (and three times), and the rows at the exemplar's zone's storey pitch, phased on the
    // matches; the grid is then drawn where the photo covers each opening, as a reading's tiling is
    const lattice = family.exemplars.flatMap((ex, ei) => {
        const ms = matchExemplar({ L, W, H, pixel: f.pixel }, ex).filter(m => !m.grid);
        if (ms.length < TEMPLATE_PARAMS.minMatches) return [];
        const med = (v: number[]) => { const q = [...v].sort((a, b) => a - b); return q[q.length >> 1]; };
        const ow = med(ms.map(m => m.rect[2] - m.rect[0])), oh = med(ms.map(m => m.rect[3] - m.rect[1]));
        const xs = ms.map(m => m.rect[0]).sort((a, b) => a - b), groups: number[][] = [];
        for (const x of xs) { const g = groups[groups.length - 1]; if (g && x - g[g.length - 1] <= 0.3 * ow) g.push(x); else groups.push([x]); }
        const most = Math.max(...groups.map(g => g.length));
        const colX = groups.filter(g => g.length >= Math.max(3, 0.25 * most)).map(med);
        if (!colX.length) return [];
        // the storey pitch: the exemplar's zone's, else the commonest step between matches in one column
        let pitch = ex.pitchM ? ex.pitchM / f.pixel : 0;
        if (!(pitch > 2)) {
            const steps = colX.flatMap(x => { const ys = ms.filter(m => Math.abs(m.rect[0] - x) <= 0.3 * ow).map(m => m.rect[1]).sort((a, b) => a - b); return ys.slice(1).map((y, k) => y - ys[k]).filter(d => d > oh); });
            pitch = steps.length ? med(steps) : 0;
        }
        if (!(pitch > 2)) return [];
        let c = 0, sn = 0;
        for (const m of ms) { const a = (2 * Math.PI * m.rect[1]) / pitch; c += Math.cos(a); sn += Math.sin(a); }
        const phase = ((((Math.atan2(sn, c) / (2 * Math.PI)) * pitch) % pitch) + pitch) % pitch;
        const top = Math.min(...ms.map(m => m.rect[1])) - 0.25 * pitch, bottom = Math.max(...ms.map(m => m.rect[3])) + 0.25 * pitch;
        const out: TemplateMatch[] = [];
        for (let k = Math.ceil((top - phase) / pitch); phase + k * pitch + oh <= bottom; k++) for (const x of colX) {
            const r: WindowRect = [x, phase + k * pitch, x + ow, phase + k * pitch + oh];
            if (r[1] >= 0 && r[3] <= H && r[2] <= W && coveredShare(L, W, r[0], r[1], r[2], r[3]) >= P.minCovered) out.push({ rect: r, ncc: 1, panes: ex.panes, fromPlane: ex.fromPlane, exemplar: ei });
        }
        return out;
    });
    const matches = mergeMatches([lattice]);
    if (matches.length < TEMPLATE_PARAMS.minMatches) return undefined;
    // as many openings for its covered wall as the lead had (within templateDensity), or the window was not this plane's
    const coveredM2 = coveredAreaM2(L, f.pixel);
    if (family.density !== undefined && matches.length < P.templateDensity * family.density * coveredM2) return undefined;
    // columns by the openings' centres, left to right (as a reading's are gathered)
    const widths = matches.map(m => m.rect[2] - m.rect[0]).sort((a, b) => a - b), tol = 0.5 * widths[widths.length >> 1];
    const order = matches.map((m, i) => ({ c: (m.rect[0] + m.rect[2]) / 2, i })).sort((a, b) => a.c - b.c);
    const columnOf = new Array<number>(matches.length);
    let col = -1, last = -Infinity;
    for (const { c, i } of order) { if (c - last > tol) col++; columnOf[i] = col; last = c; }
    const columns = col + 1;
    const box: ImageRegion = { x0: Math.max(0, Math.floor(Math.min(...matches.map(m => m.rect[0])))), y0: Math.max(0, Math.floor(Math.min(...matches.map(m => m.rect[1])))), x1: Math.min(W, Math.ceil(Math.max(...matches.map(m => m.rect[2])))), y1: Math.min(H, Math.ceil(Math.max(...matches.map(m => m.rect[3])))) };
    const { read, heldOut } = zoneCrops(L, W, box, P.readCropM / f.pixel, P);
    if (!read) return undefined;
    const scale = scaleFor(read, P), rects = matches.map(m => m.rect);
    const judged = sideBySide(regionPng(img, read, scale, rects, L), regionPng(img, heldOut ?? read, scale, rects, L));
    review?.(judged, 'template');
    let judge: FacadeJudgement;
    try { judge = parseJudgement(await ask(judged, judgePrompt(columns), 'judge', heldOut ?? read)); }
    catch { return undefined; }
    if (!judge.accept || judge.conf < P.minConf) return undefined;
    const bad = new Set(judge.badColumns.map(n => n - 1));
    const outRects: WindowRect[] = [], panes: WindowRect[] = [];
    matches.forEach((m, i) => {
        if (bad.has(columnOf[i])) return;
        outRects.push(round2(m.rect));
        const n = m.panes ?? 1, pw = (m.rect[2] - m.rect[0]) / n;
        for (let q = 0; q < n; q++) panes.push(round2([m.rect[0] + q * pw, m.rect[1], m.rect[0] + (q + 1) * pw, m.rect[3]]));
    });
    if (!outRects.length || (family.density !== undefined && outRects.length < P.templateDensity * family.density * coveredM2)) return undefined;
    const from = family.exemplars[0].fromPlane, gridFilled = 0;
    const zr: ZoneRecord = {
        label: `${family.name}: plane ${from}'s window`, region: box, outcome: 'drawn', judge, ...(family.glass ? { glass: family.glass } : {}),
        why: `${outRects.length} openings on the grid plane ${from}'s window was found in, in ${columns - bad.size} columns${bad.size ? `; ${bad.size} columns rejected by the judge` : ''}`,
        template: { fromPlane: from, matches: matches.length, gridFilled }
    };
    const record: FacadeReadRecord = { facadeId: f.facadeId, outcome: 'replaced', why: zr.why, zones: [zr], family: family.name, calls: 1, ms: Date.now() - t0 };
    return { record, rects: outRects, panes, ...(family.glass ? { glass: [{ region: box, glass: family.glass }] } : {}) };
}

/** The area the photo covers (m²). */
export function coveredAreaM2(L: Float32Array, pixel: number): number {
    let n = 0;
    for (let k = 0; k < L.length; k++) if (Number.isFinite(L[k])) n++;
    return n * pixel * pixel;
}

/** One plane's drawn openings, panes and glass zones, in its photo's pixels. */
export interface PlaneReading { facadeId: number; width: number; height: number; rects: WindowRect[]; panes: WindowRect[]; glass?: Array<{ region: ImageRegion; glass: GlassReading }> }

export interface FacadeReaderFile {
    version: string; params: FacadeReaderParams; ms: number; facades: FacadeReadRecord[];
    /** The planes past maxPlanes, not read, and their covered area. */
    unread: { planes: number; areaM2: number };
    /** The planes whose openings were drawn. */
    readings: PlaneReading[];
    /** The storey pitch the wide walls were read at, given to the narrow ones. */
    guide?: { pitchM: number };
    /** The building brief every reading was told (facade-reader-brief.ts), or why there is none. */
    brief?: (BuildingBrief & { cells: number }) | { failed: string };
}

export const FACADE_READER_FILE = 'facade_reader.json';

/** At most n calls of fn at once, the rest queued in order; a finishing call hands its slot straight to the next. */
function callLimiter(n: number): <T>(fn: () => Promise<T>) => Promise<T> {
    let active = 0;
    const waiting: Array<() => void> = [];
    return async fn => {
        if (active < n) active++; else await new Promise<void>(resolve => waiting.push(resolve));
        try { return await fn(); }
        finally { const go = waiting.shift(); if (go) go(); else active--; }
    };
}

/**
 * Reads the planes of an orthos directory (maxPlanes at most, the walls first, each kind largest first): the walls tile_refine photographed
 * (facades.json) and every other plane (planes.json). Needs only the photos, so it runs beside the window fit; its
 * readings go into window_fit.json after (mergeReadings). Done once per photo set: facade_reader.json of this version is
 * returned as it is. The judged overlays are kept in facade_reader/ for review.
 */
export async function readPlanes(orthosDir: string, ask: FacadeAsk, opts: { signal?: AbortSignal; params?: FacadeReaderParams; progress?: (m: string) => void; /** The building the request named, told to the brief and every reading. */ building?: NamedBuilding } = {}): Promise<{ records: FacadeReaderFile; cached: boolean }> {
    const P = opts.params ?? FACADE_READER_PARAMS;
    const recFile = path.join(orthosDir, FACADE_READER_FILE);
    if (fs.existsSync(recFile)) {
        const prior = JSON.parse(fs.readFileSync(recFile, 'utf8')) as FacadeReaderFile;
        if (prior.version === FACADE_READER_VERSION && JSON.stringify(prior.params) === JSON.stringify(P) && Array.isArray(prior.readings)) return { records: prior, cached: true };
    }
    const t0 = Date.now();
    // the walls tile_refine photographed (facades.json), then every other plane of the building (plane-orthos.ts: roofs,
    // terraces, slopes, the walls it did not analyse); walls then roofs, up to maxPlanes, the rest reported
    const pf = path.join(orthosDir, PLANES_FILE);
    const others = fs.existsSync(pf) ? (JSON.parse(fs.readFileSync(pf, 'utf8')) as PlaneOrthosFile).planes as unknown as FacadeFrame[] : [];
    const areaOf = (f: FacadeFrame) => f.width * f.height * f.pixel * f.pixel * (f.coverage ?? 0);
    const eligible = [...(JSON.parse(fs.readFileSync(path.join(orthosDir, 'facades.json'), 'utf8')).facades as FacadeFrame[]), ...others]
        .filter(f => fs.existsSync(path.join(orthosDir, f.image)) && (f.coverage ?? 0) >= P.minCoverage && (f.kind === 'roof' ? f.width * f.pixel >= P.minWidthM && f.height * f.pixel >= P.minWidthM : f.width * f.pixel >= P.minWallWidthM && f.height * f.pixel >= P.minHeightM))
        // the walls first (most of a building's openings), then the roofs and terraces, each the largest covered area first
        .sort((a, b) => Number(a.kind === 'roof') - Number(b.kind === 'roof') || areaOf(b) - areaOf(a));
    const frames = eligible.slice(0, P.maxPlanes);
    const unread = { planes: eligible.length - frames.length, areaM2: Math.round(eligible.slice(P.maxPlanes).reduce((a, f) => a + areaOf(f), 0)) };
    const reviewDir = path.join(orthosDir, 'facade_reader');
    fs.mkdirSync(reviewDir, { recursive: true });
    const records: FacadeReadRecord[] = [], readings: PlaneReading[] = [];
    // the wide walls first, then the narrow faces (a tower's window columns, where the model tends to skip storeys) and the
    // roofs. Every plane's calls go out as soon as it opens, under one limit on the calls in flight; a narrow wall's tiling
    // waits for the storey pitch the wide walls were read at (their drawn zones' median, by openings), a roof's for nothing
    const wide = (f: FacadeFrame) => f.kind !== 'roof' && f.width * f.pixel >= P.minWidthM;
    const queue = [...frames.filter(wide), ...frames.filter(f => !wide(f))];
    const wideIds = new Set(queue.filter(wide).map(f => f.facadeId));
    let wideLeft = wideIds.size, guide: { pitchM: number } | undefined, settleGuide!: (g: { pitchM: number } | undefined) => void;
    const guideRead = new Promise<{ pitchM: number } | undefined>(resolve => { settleGuide = resolve; });
    const wideDone = () => {
        if (--wideLeft > 0) return;
        const pitches: Array<[number, number]> = records.filter(r => wideIds.has(r.facadeId)).flatMap(r => (r.zones ?? []).filter(z => z.outcome === 'drawn' && z.fit && z.fit.rows > 1 && z.fit.pitchM > 0).map(z => [z.fit!.pitchM, z.fit!.openings] as [number, number])).sort((a, b) => a[0] - b[0]);
        if (pitches.length) { const half = pitches.reduce((a, p) => a + p[1], 0) / 2; let acc = 0; for (const [m, w] of pitches) { acc += w; if (acc >= half) { guide = { pitchM: m }; break; } } }
        settleGuide(guide);
    };
    if (!wideLeft) settleGuide(undefined);
    const limited: FacadeAsk = (() => { const slot = callLimiter(P.concurrency); return (png, prompt, kind, region) => slot(() => ask(png, prompt, kind, region)); })();
    // the building brief: the largest planes on one contact sheet, read as one building and grouped into families
    // (facade-reader-brief.ts); every reading is told it, its plane's family and where its plane stands
    const places = planePlaces(frames);
    let brief: BuildingBrief | undefined, briefNote: FacadeReaderFile['brief'];
    if (P.brief && frames.length > 1) {
        try {
            const sheet = contactSheet(orthosDir, frames);
            fs.writeFileSync(path.join(reviewDir, 'brief_sheet.png'), sheet.png);
            brief = parseBrief(await limited(sheet.png, briefPrompt(sheet.cells, places, opts.building), 'brief', { x0: 0, y0: 0, x1: sheet.width, y1: sheet.height }), sheet.cells);
            briefNote = { ...brief, cells: sheet.cells.length };
        } catch (err) {
            if (opts.signal?.aborted) throw err;
            briefNote = { failed: (err instanceof Error ? err.message : String(err)).slice(0, 300) };
        }
    }
    const familyOf = new Map<number, PlaneFamily>();
    for (const fam of brief?.families ?? []) for (const id of fam.planes) familyOf.set(id, fam);
    // a family's lead (its first plane in queue order) is read; its other planes wait for it, then look for its accepted
    // windows in their own photo (facade-reader-template.ts) and are read only where they do not hold
    type FamilyState = { lead: number; exemplars: WindowExemplar[]; glass?: GlassReading; density?: number; done: Promise<void>; settle: () => void };
    const families = new Map<PlaneFamily, FamilyState>();
    for (const f of queue) {
        const fam = familyOf.get(f.facadeId);
        if (!fam || families.has(fam)) continue;
        let settle!: () => void;
        const done = new Promise<void>(resolve => { settle = resolve; });
        families.set(fam, { lead: f.facadeId, exemplars: [], done, settle });
    }
    let next = 0, done = 0;
    // planes open in queue order, so every wide wall has opened before any narrow face waits on them
    const worker = async () => {
        for (;;) {
            const f = queue[next++];
            if (!f) return;
            if (opts.signal?.aborted) { settleGuide(undefined); throw opts.signal.reason ?? new Error('aborted'); }
            const fam = familyOf.get(f.facadeId), st = fam ? families.get(fam) : undefined, isLead = st?.lead === f.facadeId;
            try {
                const d = decodePng(fs.readFileSync(path.join(orthosDir, f.image)));
                let uncovered: Uint8Array | undefined;
                const mf = f.uncoveredMask ? path.join(orthosDir, f.uncoveredMask) : undefined;
                if (mf && fs.existsSync(mf)) { const m = decodePng(fs.readFileSync(mf)); uncovered = Uint8Array.from({ length: m.width * m.height }, (_, k) => (m.rgba[k * 4] >= 128 ? 1 : 0)); }
                const img = { rgba: d.rgba, width: d.width, height: d.height }, review = (png: Buffer, tag: string) => fs.writeFileSync(path.join(reviewDir, `${f.facadeId}_${tag}.png`), png);
                let r: { record: FacadeReadRecord; rects?: WindowRect[]; panes?: WindowRect[]; glass?: Array<{ region: ImageRegion; glass: GlassReading }>; exemplars?: WindowExemplar[] } | undefined;
                if (P.template && st && fam && !isLead) {
                    await st.done;
                    if (st.exemplars.length) r = await readFromTemplates(img, uncovered, f, { name: fam.name, exemplars: st.exemplars, ...(st.glass ? { glass: st.glass } : {}), ...(st.density !== undefined ? { density: st.density } : {}) }, limited, P, review);
                }
                r ??= await readFacade(img, uncovered, f, limited, P, review, wide(f) ? undefined : guideRead, P.brief ? contextFor(brief, places.get(f.facadeId), fam, opts.building) : '');
                if (fam) r.record.family = fam.name;
                if (isLead && r.exemplars && r.rects) { st!.exemplars = r.exemplars; st!.glass = r.glass?.[0]?.glass; st!.density = r.rects.length / Math.max(1, coveredAreaM2(luminanceOf(img, uncovered), f.pixel)); }
                records.push(r.record);
                if (r.rects && r.panes) readings.push({ facadeId: f.facadeId, width: d.width, height: d.height, rects: r.rects, panes: r.panes, ...(r.glass?.length ? { glass: r.glass } : {}) });
            } catch (err) {
                if (opts.signal?.aborted) { settleGuide(undefined); throw err; }
                records.push({ facadeId: f.facadeId, outcome: 'failed', why: (err instanceof Error ? err.message : String(err)).slice(0, 300), ms: 0 });
            } finally { if (wide(f)) wideDone(); if (isLead) st!.settle(); }
            opts.progress?.(`pipeline K: reading the building's planes (${++done} of ${frames.length})`);
        }
    };
    await Promise.all(Array.from({ length: Math.max(1, Math.min(P.openPlanes, queue.length)) }, worker));
    records.sort((a, b) => a.facadeId - b.facadeId);
    readings.sort((a, b) => a.facadeId - b.facadeId);
    const file: FacadeReaderFile = { version: FACADE_READER_VERSION, params: P, ms: Date.now() - t0, facades: records, unread, readings, ...(guide ? { guide } : {}), ...(briefNote ? { brief: briefNote } : {}) };
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
