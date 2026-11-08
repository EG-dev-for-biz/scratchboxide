/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The building's architectural system, read by the vision model from the whole structure at once (user direction,
 * 2026-11-07: "we may need the context of the entire structure to infer the placements", and the per-face heuristics
 * "not smart enough"). The facade photos go on one contact sheet (facade-reader-brief.ts), each cell told where its
 * plane stands and what the photo's own periodicity measured there, and the model answers as an architect. The top line
 * (user, 2026-11-07): understand what an ARRAY is (openings of one size repeating at one spacing across and one storey
 * up), what its pattern is, how the pattern changes from region to region of a structure, and that some structures, or
 * parts of them, have no array at all. So the answer is PATTERNS (each an array with its measures in metres, or openings
 * that do not repeat) and, for every face, its REGIONS bottom to top (each band's heights above the lowest plane and its
 * pattern, or none: no openings). Numbers and one structural fact (repeats or not), never a name to route on: an
 * unforeseen building answers in the same fields.
 *
 * Nothing is drawn from the answer as such. window-array.ts runs each region of a face on its own: in an array region it
 * lays the pattern's lattice (through the plane frame), folds the photo at it and takes it only where the fold shows the
 * window (the model's pitches and sizes, the photo's phases); a region whose openings do not repeat, or with none, keeps
 * the openings read there as they were and gains nothing. The answer is kept in the model readings store by the sheet's
 * pixels and the prompt, so a rebuild asks once.
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { contactSheet, describePlace, planePlaces, type ContactSheet, type NamedBuilding, type PlanePlace } from './facade-reader-brief';
import type { FacadeAsk } from './facade-reader';
import { readingKey, type ModelReadingStore } from './model-readings';
import { facadePhotoFor, photoLattice, WINDOW_ARRAY_PARAMS, type BuildingStorey, type WindowArrayParams } from './window-array';

export const BUILDING_SYSTEM_VERSION = 'building-system/2';
/** The prompt's version, in every kept answer's key: a change to what is asked asks again. */
export const BUILDING_SYSTEM_PROMPT_VERSION = 'building-system-prompts/2';

export const BUILDING_SYSTEM_PARAMS = {
    /** Floor-to-floor heights (m) and bay pitches (m) accepted from the answer; windows per bay at most. */
    storeyM: [2.2, 9] as [number, number], bayM: [0.6, 24] as [number, number], maxWindowsPerBay: 8,
    /** The model's own confidence (0-100) under which the answer is not used. */
    minConf: 40
} as const;

/**
 * A pattern of openings the model saw. `repeats` true: an ARRAY, openings of one size repeating at one spacing across
 * and one storey up, with its measures (m). `repeats` false: openings that do not form an array (placed one by one, of
 * differing sizes or spacing): nothing is inferred from it, the openings read are kept as read.
 */
export interface SystemPattern {
    name: string; repeats: boolean;
    storeyM?: number; bayM?: number; windowsPerBay?: number; windowWidthM?: number; windowHeightM?: number;
    /** The window's bottom above its floor. */
    sillM?: number;
}
/** A band of one face where one pattern holds (its bottom and top above the lowest plane, m); pattern null: no openings. */
export interface SystemRegion { facadeId: number; pattern: string | null; bottomM: number; topM: number }
export interface BuildingSystem {
    version: string;
    building: string;
    patterns: SystemPattern[]; regions: SystemRegion[];
    conf: number;
    /** The lowest plane's bottom (world Y): what the regions' heights are measured from. */
    groundY: number;
    /** The contact sheet's pixels (sha256) the answer was read from, and whether it came from the store. */
    sheet: string; reused: boolean;
}

type FrameLike = { facadeId: number; kind?: string; image: string; width: number; height: number; pixel: number; coverage?: number; centroid?: number[]; normal?: number[]; axisT?: number[]; tMin?: number; tMax?: number; orthoTMax?: number; uncoveredMask?: string; occludedMask?: string };

/** The ground the tiers are measured from: the lowest plane's bottom (world Y), as planePlaces measures it. */
export function lowestPlaneY(frames: FrameLike[]): number {
    return Math.min(...frames.map(f => { const c = f.centroid ?? [0, 0, 0], up = f.axisT ?? [0, 1, 0]; return Math.min(c[1] + up[1] * (f.tMin ?? 0), c[1] + up[1] * (f.tMax ?? 0)); }));
}

/** What the photo's own periodicity measured on a plane, told to the model as a hint it may confirm or correct. */
export interface MeasuredHint { facadeId: number; colPitchM?: number; rowPitchM?: number; windowM?: [number, number]; clear: boolean }

export function measuredHints(orthosDir: string, frames: FrameLike[], P: WindowArrayParams = WINDOW_ARRAY_PARAMS): MeasuredHint[] {
    return frames.flatMap(f => {
        const photo = facadePhotoFor(orthosDir, f);
        if (!photo) return [];
        const s = photoLattice(photo.img, photo.valid, P.pitchM[0] / f.pixel, P.pitchM[1] / f.pixel, P);
        const r = (v: number) => Math.round(v * f.pixel * 100) / 100;
        return [{ facadeId: f.facadeId, ...(s.col ? { colPitchM: r(s.col.pitch) } : {}), ...(s.row ? { rowPitchM: r(s.row.pitch) } : {}), ...(s.clear ? { windowM: [r(s.col!.size), r(s.row!.size)] as [number, number] } : {}), clear: s.clear }];
    });
}

export function systemPrompt(cells: ContactSheet['cells'], places: Map<number, PlanePlace>, hints: MeasuredHint[], building?: NamedBuilding, storey?: BuildingStorey): string {
    const hintOf = new Map(hints.map(h => [h.facadeId, h]));
    const hint = (id: number) => {
        const h = hintOf.get(id);
        if (!h || (!h.colPitchM && !h.rowPitchM)) return '';
        return ` Measured in the photo: ${[h.colPitchM ? `columns repeat every ${h.colPitchM} m` : '', h.rowPitchM ? `rows every ${h.rowPitchM} m` : '', h.windowM ? `a darker patch ${h.windowM[0]} x ${h.windowM[1]} m` : ''].filter(Boolean).join(', ')}${h.clear ? '' : ' (faint)'}.`;
    };
    return [
        ...(building ? [`These are the surfaces of ${building.name}${building.address && building.address !== building.name ? ` (${building.address})` : ''}: use what you know of it, and what the photos show.`] : []),
        'This sheet shows the surfaces of ONE building, each photographed straight on and straightened from a 3D scan, each in its own cell (cells are not to one scale; uniform grey or black is not covered by the photo). The cells, row by row:',
        ...cells.map(c => `- ${c.cell}: ${describePlace(places.get(c.facadeId)!)}.${hint(c.facadeId)}`),
        ...(storey ? [`Across the faces the photos' rows repeat every ${storey.pitchM} m (${storey.facades} faces, ${storey.rows} rows).`] : []),
        'Read the building as an architect would, from the whole building, so that a face photographed badly is still understood from what its neighbours show.',
        'An ARRAY is a set of openings of one size repeating at one spacing across and one storey height up. Decide, region by region, WHETHER there is an array and WHAT its pattern is. The pattern often changes from one region of a structure to the next (a base, a shaft, a setback, a crown, a mechanical floor, a different wing), and many buildings, or parts of them, have NO array: openings placed one by one, of differing sizes or spacing, or no openings at all. Say so where that is what you see; never invent a repetition.',
        'Give "building": two or three sentences (its style, its tiers or setbacks, its wall and window materials).',
        'Give "patterns": each distinct pattern of openings you see, with "name" and "repeats" (true for an array, false for openings that do not repeat). For an array also give, in metres: "storeyM" (floor to floor), "bayM" (the repeating bay across, centre to centre), "windowsPerBay" (windows side by side in one bay; 1 for a single window), "windowWidthM" and "windowHeightM" (one window\'s glass, not the bay; a ribbon window is one window as wide as its bay), and "sillM" (its bottom above its floor). Two arrays that differ in size, spacing or storey are two patterns.',
        'Give "regions": for every cell, its bands from bottom to top, each with "cell", "bottomM" and "topM" (metres above the building\'s lowest plane: use the cells\' heights) and "pattern" (a pattern\'s name, or null where the band has no openings). A cell with one pattern throughout is one region; cover each cell from its bottom to its top.',
        'Give "conf": 0..100.',
        'Answer with JSON only: {"building":"...","patterns":[{"name":"shaft windows","repeats":true,"storeyM":3.6,"bayM":5.9,"windowsPerBay":2,"windowWidthM":1.7,"windowHeightM":2.4,"sillM":0.8},{"name":"shopfronts","repeats":false}],"regions":[{"cell":"r1c1","bottomM":0,"topM":8,"pattern":"shopfronts"},{"cell":"r1c1","bottomM":8,"topM":60,"pattern":"shaft windows"}],"conf":0}'
    ].join('\n');
}

const num = (v: unknown, lo: number, hi: number): number | undefined => (typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi ? Math.round(v * 100) / 100 : undefined);

/** Parses and checks an answer against the sheet's cells; throws on anything malformed or out of range. */
export function parseSystem(text: string, cells: ContactSheet['cells'], P = BUILDING_SYSTEM_PARAMS): Omit<BuildingSystem, 'version' | 'groundY' | 'sheet' | 'reused'> {
    const a = text.indexOf('{'), b = text.lastIndexOf('}');
    if (a < 0 || b <= a) throw new Error('the reply holds no JSON object');
    const j = JSON.parse(text.slice(a, b + 1));
    if (typeof j?.building !== 'string' || !Array.isArray(j.patterns) || !Array.isArray(j.regions)) throw new Error('the reply has no "building", "patterns" or "regions"');
    const patterns: SystemPattern[] = [];
    for (const q of j.patterns) {
        if (typeof q?.name !== 'string' || typeof q.repeats !== 'boolean') throw new Error(`a pattern is malformed: ${JSON.stringify(q).slice(0, 120)}`);
        if (patterns.some(x => x.name === q.name)) continue;
        if (!q.repeats) { patterns.push({ name: q.name.slice(0, 60), repeats: false }); continue; }
        const storeyM = num(q.storeyM, P.storeyM[0], P.storeyM[1]), bayM = num(q.bayM, P.bayM[0], P.bayM[1]), perBay = num(q.windowsPerBay, 1, P.maxWindowsPerBay), w = num(q.windowWidthM, 0.2, P.bayM[1]), h = num(q.windowHeightM, 0.2, P.storeyM[1]), sill = num(q.sillM, 0, P.storeyM[1]);
        if (storeyM === undefined || bayM === undefined || perBay === undefined || w === undefined || h === undefined || sill === undefined) throw new Error(`an array pattern is malformed or out of range: ${JSON.stringify(q).slice(0, 160)}`);
        const per = Math.round(perBay);
        patterns.push({ name: q.name.slice(0, 60), repeats: true, storeyM, bayM, windowsPerBay: per, windowWidthM: Math.min(w, bayM / per), windowHeightM: Math.min(h, storeyM), sillM: sill });
    }
    const byCell = new Map(cells.map(c => [c.cell.toLowerCase(), c.facadeId]));
    const regions: SystemRegion[] = [];
    for (const r of j.regions) {
        const id = typeof r?.cell === 'string' ? byCell.get(r.cell.trim().toLowerCase()) : undefined;
        const bottomM = num(r?.bottomM, -50, 2000), topM = num(r?.topM, -50, 2000);
        if (id === undefined || bottomM === undefined || topM === undefined || topM <= bottomM) continue;
        const pattern = r.pattern === null || r.pattern === undefined ? null : typeof r.pattern === 'string' && patterns.some(x => x.name === r.pattern) ? r.pattern : undefined;
        if (pattern === undefined) throw new Error(`a region names no known pattern: ${JSON.stringify(r).slice(0, 120)}`);
        regions.push({ facadeId: id, pattern, bottomM, topM });
    }
    regions.sort((x, y) => x.facadeId - y.facadeId || x.bottomM - y.bottomM);
    const conf = typeof j.conf === 'number' && Number.isFinite(j.conf) ? Math.max(0, Math.min(100, j.conf)) : 50;
    return { building: j.building.slice(0, 600), patterns, regions, conf };
}

/** A kept answer (model-readings.ts), under `building-system/<sha256>`. */
export interface SystemReadingRecord { schema: 'scratchbox.building-system/1'; key: string; model: string; promptVersion: string; text: string; atMs: number }

/**
 * The system read from the building's facades (facades.json): the sheet, the prompt with each cell's place and measured
 * hint, one call (or the kept answer), the answer parsed and checked. Returns undefined, with the reason, when the model
 * is unsure or the answer malformed. The sheet is written beside the orthos for review (building_system_sheet.png).
 */
export async function readBuildingSystem(orthosDir: string, ask: FacadeAsk, opts: { building?: NamedBuilding; readings?: { store: ModelReadingStore; model: string }; storey?: BuildingStorey; signal?: AbortSignal; P?: WindowArrayParams } = {}): Promise<{ system?: BuildingSystem; reason?: string; calls: number; reused: number; ms: number }> {
    const t0 = Date.now();
    const frames = (JSON.parse(fs.readFileSync(path.join(orthosDir, 'facades.json'), 'utf8')).facades as FrameLike[])
        .filter(f => fs.existsSync(path.join(orthosDir, f.image)))
        .sort((a, b) => b.width * b.height * b.pixel * b.pixel * (b.coverage ?? 0) - a.width * a.height * a.pixel * a.pixel * (a.coverage ?? 0));
    if (frames.length < 1) return { reason: 'no facade photographed', calls: 0, reused: 0, ms: Date.now() - t0 };
    const sheet = await contactSheet(orthosDir, frames);
    try { fs.writeFileSync(path.join(orthosDir, 'building_system_sheet.png'), sheet.png); } catch { /* review only */ }
    const places = planePlaces(frames), hints = measuredHints(orthosDir, frames.slice(0, sheet.cells.length), opts.P);
    const prompt = systemPrompt(sheet.cells, places, hints, opts.building, opts.storey);
    const hash = crypto.createHash('sha256').update(sheet.png).digest('hex');
    const key = opts.readings ? readingKey('building-system', [BUILDING_SYSTEM_PROMPT_VERSION, opts.readings.model, hash, prompt]) : undefined;
    let text: string | undefined, reused = false, calls = 0;
    if (key) { const kept = await opts.readings!.store.get<SystemReadingRecord>(key); if (kept && typeof kept.text === 'string') { text = kept.text; reused = true; } }
    if (text === undefined) {
        calls = 1;
        text = await ask(sheet.png, prompt, 'brief', { x0: 0, y0: 0, x1: sheet.width, y1: sheet.height });
        if (key) opts.readings!.store.put(key, { schema: 'scratchbox.building-system/1', key, model: opts.readings!.model, promptVersion: BUILDING_SYSTEM_PROMPT_VERSION, text, atMs: Date.now() } satisfies SystemReadingRecord);
    }
    let parsed: ReturnType<typeof parseSystem>;
    try { parsed = parseSystem(text, sheet.cells); }
    catch (err) { return { reason: `the answer could not be read: ${err instanceof Error ? err.message : String(err)}`, calls, reused: reused ? 1 : 0, ms: Date.now() - t0 }; }
    if (parsed.conf < BUILDING_SYSTEM_PARAMS.minConf) return { reason: `the model was unsure of the building's system (${parsed.conf})`, calls, reused: reused ? 1 : 0, ms: Date.now() - t0 };
    return { system: { version: BUILDING_SYSTEM_VERSION, ...parsed, groundY: lowestPlaneY(frames), sheet: hash, reused }, calls, reused: reused ? 1 : 0, ms: Date.now() - t0 };
}

/** The lattice an array pattern prescribes on one face (px): the pane pitch across, the storeys and the window's centre line up, the window's size. */
export interface FaceSystem { family: string; tier: string; col: { pitch: number; size: number; /** The model's bay (px) and windows per bay, when it read more than one: the photo decides whether they stand evenly or grouped. */ bay?: number; perBay?: number }; row: { pitch: number; phase: number; size: number } }
/** A region of a face in its photo's rows [y0, y1) (y down), its pattern, and the lattice when it is an array. */
export interface FaceRegion { y0: number; y1: number; pattern: string | null; repeats: boolean; bottomM: number; topM: number; lattice?: FaceSystem }

/**
 * The system's regions on a face's photo, top to bottom (y down), each band's rows from its heights through the plane
 * frame (world Y = centroid.y + axisT.y (orthoTMax - y pixel)); an array region's lattice: its pattern's pane pitch
 * (bayM / windowsPerBay) and window across, its storeys up with the window's centre on the floor at the region's
 * bottom + sill + half the window. Empty for a face the answer does not cover.
 */
export function systemOnFace(sys: BuildingSystem, f: FrameLike): FaceRegion[] {
    if (!f.centroid || !f.axisT || f.orthoTMax === undefined || Math.abs(f.axisT[1]) < 0.5) return [];
    const c = f.centroid, up = f.axisT, along = f.pixel * Math.abs(up[1]);
    const yOf = (hM: number) => (f.orthoTMax! - (sys.groundY + hM - c[1]) / up[1]) / f.pixel;
    const out: FaceRegion[] = [];
    for (const r of sys.regions.filter(x => x.facadeId === f.facadeId)) {
        const a = yOf(r.topM), b = yOf(r.bottomM), y0 = Math.max(0, Math.round(Math.min(a, b))), y1 = Math.min(f.height, Math.round(Math.max(a, b)));
        if (y1 - y0 < 2) continue;
        const pat = r.pattern === null ? undefined : sys.patterns.find(p => p.name === r.pattern);
        const region: FaceRegion = { y0, y1, pattern: r.pattern, repeats: !!pat?.repeats, bottomM: r.bottomM, topM: r.topM };
        if (pat?.repeats) {
            const pitch = pat.storeyM! / along, y = yOf(r.bottomM + pat.sillM! + pat.windowHeightM! / 2);
            region.lattice = {
                family: pat.name, tier: `${r.bottomM}-${r.topM} m`,
                col: { pitch: pat.bayM! / pat.windowsPerBay! / f.pixel, size: Math.min(pat.windowWidthM!, pat.bayM! / pat.windowsPerBay! * 0.95) / f.pixel, ...(pat.windowsPerBay! > 1 ? { bay: pat.bayM! / f.pixel, perBay: pat.windowsPerBay! } : {}) },
                row: { pitch, phase: ((y % pitch) + pitch) % pitch, size: Math.min(pat.windowHeightM!, pat.storeyM! * 0.95) / along }
            };
        }
        out.push(region);
    }
    return out.sort((a, b) => a.y0 - b.y0);
}
