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
 * plane stands and what the photo's own periodicity measured there, and the model answers as an architect, in numbers:
 * the TIERS (from the lowest plane up: where each begins and ends, its floor-to-floor height and storey count), the
 * FAMILIES of faces that carry one window system (the bay pitch, windows per bay, the window's width and height, its sill
 * above the floor), and the faces with no openings. Numbers only, never a name to route on: an unforeseen building
 * answers in the same fields.
 *
 * Nothing is drawn from the answer as such. For each face in a family, window-array.ts lays the system's lattice on the
 * face (the pane pitch across, the tier's storeys up, converted into the photo by the plane frame), folds the photo at
 * it and keeps it only where the fold shows the window against the rest of its cell (the photo places: the fold's own
 * phases, the model's sizes); a face the fold contradicts falls back to the photo's own periodicity and its boxes. The
 * answer is kept in the model readings store by the sheet's pixels and the prompt, so a rebuild asks once.
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { contactSheet, describePlace, planePlaces, type ContactSheet, type NamedBuilding, type PlanePlace } from './facade-reader-brief';
import type { FacadeAsk } from './facade-reader';
import { readingKey, type ModelReadingStore } from './model-readings';
import { facadePhotoFor, photoLattice, WINDOW_ARRAY_PARAMS, type BuildingStorey, type WindowArrayParams } from './window-array';

export const BUILDING_SYSTEM_VERSION = 'building-system/1';
/** The prompt's version, in every kept answer's key: a change to what is asked asks again. */
export const BUILDING_SYSTEM_PROMPT_VERSION = 'building-system-prompts/1';

export const BUILDING_SYSTEM_PARAMS = {
    /** Floor-to-floor heights (m) and bay pitches (m) accepted from the answer; windows per bay at most. */
    storeyM: [2.2, 9] as [number, number], bayM: [0.6, 24] as [number, number], maxWindowsPerBay: 8,
    /** The model's own confidence (0-100) under which the answer is not used. */
    minConf: 40
} as const;

/** One tier of the building: its band above the lowest plane (m), its floor-to-floor height and storey count. */
export interface SystemTier { name: string; bottomM: number; topM: number; storeyM: number; storeys: number }
/** The faces carrying one window system, with its measures (m). */
export interface SystemFamily {
    name: string; planes: number[];
    /** The tier the family's storeys follow (its name), when it says. */
    tier?: string;
    /** The repeating bay, centre to centre, and the windows in it (so the pane pitch is bayM / windowsPerBay). */
    bayM: number; windowsPerBay: number;
    windowWidthM: number; windowHeightM: number;
    /** The window's bottom above its floor. */
    sillM: number;
}
export interface BuildingSystem {
    version: string;
    building: string;
    tiers: SystemTier[]; families: SystemFamily[];
    /** Faces with no openings. */
    blank: number[];
    conf: number;
    /** The lowest plane's bottom (world Y): what the tiers' heights are measured from. */
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
        ...(storey ? [`Across the faces the photos' rows repeat every ${storey.pitchM} m (${storey.facades} faces, ${storey.rows} rows): the storey height, unless you see otherwise.`] : []),
        'Read the building as an architect would, and describe its SYSTEM in numbers (metres), from the whole building, so that a face photographed badly is still placed by the system its neighbours show.',
        'Give "building": two or three sentences (its style, its tiers or setbacks, its wall and window materials).',
        'Give "tiers", from the lowest plane up: each with "name", "bottomM" and "topM" (its band above the lowest plane, in metres: use the cells\' heights), "storeyM" (floor to floor) and "storeys" (how many). A podium, a shaft and a crown with different floor heights are different tiers; one uniform tower is one tier.',
        'Give "families": the cells that carry one window system (the same bay, windows and storey), each with "name", "cells", "tier" (the tier\'s name), "bayM" (the repeating bay across the face, centre to centre), "windowsPerBay" (windows in one bay, side by side; 1 for a single window), "windowWidthM" and "windowHeightM" (one window\'s glass, not the bay), and "sillM" (the window\'s bottom above its floor). A ribbon window is one window as wide as its bay. Never put together cells whose windows differ in size, spacing or storey.',
        'Give "blank": the cells with no openings at all (a party wall, a service core).',
        'Give "conf": 0..100.',
        'Answer with JSON only: {"building":"...","tiers":[{"name":"...","bottomM":0,"topM":60,"storeyM":3.6,"storeys":16}],"families":[{"name":"...","cells":["r1c1"],"tier":"...","bayM":5.9,"windowsPerBay":2,"windowWidthM":1.7,"windowHeightM":2.4,"sillM":0.8}],"blank":["r2c3"],"conf":0}'
    ].join('\n');
}

const num = (v: unknown, lo: number, hi: number): number | undefined => (typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi ? Math.round(v * 100) / 100 : undefined);

/** Parses and checks an answer against the sheet's cells; throws on anything malformed or out of range. */
export function parseSystem(text: string, cells: ContactSheet['cells'], P = BUILDING_SYSTEM_PARAMS): Omit<BuildingSystem, 'version' | 'groundY' | 'sheet' | 'reused'> {
    const a = text.indexOf('{'), b = text.lastIndexOf('}');
    if (a < 0 || b <= a) throw new Error('the reply holds no JSON object');
    const j = JSON.parse(text.slice(a, b + 1));
    if (typeof j?.building !== 'string' || !Array.isArray(j.tiers) || !Array.isArray(j.families)) throw new Error('the reply has no "building", "tiers" or "families"');
    const byCell = new Map(cells.map(c => [c.cell.toLowerCase(), c.facadeId]));
    const ids = (v: unknown): number[] => (Array.isArray(v) ? v : []).flatMap(c => { const id = typeof c === 'string' ? byCell.get(c.trim().toLowerCase()) : undefined; return id !== undefined ? [id] : []; });
    const tiers: SystemTier[] = [];
    for (const t of j.tiers) {
        const storeyM = num(t?.storeyM, P.storeyM[0], P.storeyM[1]), bottomM = num(t?.bottomM, -50, 2000), topM = num(t?.topM, -50, 2000), storeys = num(t?.storeys, 1, 400);
        if (typeof t?.name !== 'string' || storeyM === undefined || bottomM === undefined || topM === undefined || topM <= bottomM || storeys === undefined) throw new Error(`a tier is malformed: ${JSON.stringify(t).slice(0, 120)}`);
        tiers.push({ name: t.name.slice(0, 60), bottomM, topM, storeyM, storeys: Math.round(storeys) });
    }
    if (!tiers.length) throw new Error('no tier');
    tiers.sort((x, y) => x.bottomM - y.bottomM);
    const taken = new Set<number>(), families: SystemFamily[] = [];
    for (const f of j.families) {
        const planes = ids(f?.cells).filter(id => !taken.has(id));
        const bayM = num(f?.bayM, P.bayM[0], P.bayM[1]), perBay = num(f?.windowsPerBay, 1, P.maxWindowsPerBay), w = num(f?.windowWidthM, 0.2, P.bayM[1]), h = num(f?.windowHeightM, 0.2, P.storeyM[1]), sill = num(f?.sillM, 0, P.storeyM[1]);
        if (typeof f?.name !== 'string' || bayM === undefined || perBay === undefined || w === undefined || h === undefined || sill === undefined) throw new Error(`a family is malformed: ${JSON.stringify(f).slice(0, 160)}`);
        if (!planes.length) continue;
        planes.forEach(id => taken.add(id));
        families.push({ name: f.name.slice(0, 60), planes, ...(typeof f.tier === 'string' ? { tier: f.tier.slice(0, 60) } : {}), bayM, windowsPerBay: Math.round(perBay), windowWidthM: Math.min(w, bayM / Math.round(perBay)), windowHeightM: h, sillM: sill });
    }
    const blank = ids(j.blank).filter(id => !taken.has(id));
    const conf = typeof j.conf === 'number' && Number.isFinite(j.conf) ? Math.max(0, Math.min(100, j.conf)) : 50;
    return { building: j.building.slice(0, 600), tiers, families, blank, conf };
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

/** The lattice the system prescribes on one face (px): the pane pitch across, the tier's storeys and the window's centre line up, the window's size. */
export interface FaceSystem { family: string; tier: string; col: { pitch: number; size: number }; row: { pitch: number; phase: number; size: number } }

/**
 * The system laid on a face's photo: its family's pane pitch and window across; up, the tier its band lies in (the one
 * it overlaps most, else the family's named tier, else the lowest), the storey converted along the plane's up axis, the
 * window's centre on the k-th floor at ground + tier.bottomM + k storeyM + sillM + windowHeightM / 2, converted by the
 * plane frame (world Y = centroid.y + axisT.y (orthoTMax - y pixel)). Undefined for a face in no family or blank.
 */
export function systemOnFace(sys: BuildingSystem, f: FrameLike): FaceSystem | undefined {
    const fam = sys.families.find(x => x.planes.includes(f.facadeId));
    if (!fam || !f.centroid || !f.axisT || f.orthoTMax === undefined || Math.abs(f.axisT[1]) < 0.5) return undefined;
    const c = f.centroid, up = f.axisT, ya = c[1] + up[1] * (f.tMin ?? 0), yb = c[1] + up[1] * (f.tMax ?? 0);
    const bottom = Math.min(ya, yb) - sys.groundY, top = Math.max(ya, yb) - sys.groundY;
    let tier = sys.tiers.reduce<{ t: SystemTier; ov: number } | undefined>((best, t) => { const ov = Math.min(top, t.topM) - Math.max(bottom, t.bottomM); return ov > (best?.ov ?? 0) ? { t, ov } : best; }, undefined)?.t;
    tier ??= sys.tiers.find(t => t.name === fam.tier) ?? sys.tiers[0];
    const along = f.pixel * Math.abs(up[1]);
    const rowPitch = tier.storeyM / along;
    const yCentre = sys.groundY + tier.bottomM + fam.sillM + fam.windowHeightM / 2;
    const y0 = (f.orthoTMax - (yCentre - c[1]) / up[1]) / f.pixel;
    return {
        family: fam.name, tier: tier.name,
        col: { pitch: fam.bayM / fam.windowsPerBay / f.pixel, size: Math.min(fam.windowWidthM, fam.bayM / fam.windowsPerBay * 0.95) / f.pixel },
        row: { pitch: rowPitch, phase: ((y0 % rowPitch) + rowPitch) % rowPitch, size: Math.min(fam.windowHeightM, tier.storeyM * 0.95) / along }
    };
}
