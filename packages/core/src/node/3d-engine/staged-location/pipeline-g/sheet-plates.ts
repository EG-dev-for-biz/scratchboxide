/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Sheet plates (pipeline H-S, docs/plans/pipeline-h-sheet.md): the wall plates take their colour from a building-survey
 * character sheet where its panels see the wall, and keep the survey's own tile render everywhere else. The method that
 * worked on Haughwout (2026-10-24, "B4"):
 *  1. the sheet is rendered from the ISOLATED structure (no neighbour can block a view; same frame as the tile);
 *  2. four views planned from the walls: the largest wall and its largest roughly perpendicular neighbour straight on,
 *     their corner, an aerial over the corner; every view frames the structure's FULL bounds (roof objects included) with
 *     margin, because a cropped frame makes the image model re-pose the view and a close-up makes it invent the facade;
 *  3. best of several 4K sheets (building-character-sheet.ts: outline, edge QC, borders, colour gate), the usable ones
 *     ranked by the facade reading itself when a scorer is given: one sheet is a high-variance draw;
 *  4. each passing panel is laid onto the plates through its camera and the scan's depth (layStation): a texel any panel
 *     sees takes the panel's colour, the relief stays the scan's, a panel that failed its checks is left out.
 * Every texel taken from the sheet is generated (redrawn by an image model): the plate records how many.
 * Nothing here knows what the structure is: walls, bounds and cameras only.
 */

import type { ColmapCameraPose, GeodeticAnchor } from '../../../../common/spatial/colmap-vector-reference-types';
import { stationFromLookAt } from '../../../../common/spatial/SurveySynthesisEngine';
import { decodePng } from '../../../texture-processing';
import { SurveyStationRenderService } from '../../../spatial/SurveyStationRenderService';
import { beautifyCharacterSheet, type CharacterSheetResult } from '../../../spatial/building-character-sheet';
import type { StationImageGenerator } from '../../../spatial/BeautifyStationService';
import type { MassingFace } from '../pipeline-e/native-massing';
import { emptyPlate, layStation, finishPlate, type Plate } from './plates';
import { STATION_OPTICS, faceAt, type V3 } from './stations';

/** Margin round the structure's full bounds in every sheet view (B4: 1.25 framed the whole structure on Haughwout). */
export const SHEET_FRAME_MARGIN = 1.25;
/** Elevation of the aerial view over the corner. */
export const SHEET_AERIAL_ELEVATION_DEG = 35;

const add = (a: V3, b: V3, k = 1): V3 => [a[0] + b[0] * k, a[1] + b[1] * k, a[2] + b[2] * k];
const norm = (a: V3): V3 => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };

/**
 * The four sheet views for a structure: its largest wall and the largest wall roughly perpendicular to it, each straight
 * on and aimed at the structure's centre projected onto the wall's plane; their corner; an aerial over that corner. Every
 * view stands far enough out (24 mm, 16:9) to frame the structure's full bounds with SHEET_FRAME_MARGIN.
 */
export function planSheetStations(faces: MassingFace[], bounds: { min: number[]; max: number[] }, anchor: GeodeticAnchor): ColmapCameraPose[] {
    const walls = faces.filter(f => Math.abs(f.normal[1]) < 0.5 && f.sMax > f.sMin);
    if (walls.length < 2) throw new Error(`a character sheet needs two walls to plan its views; the massing has ${walls.length}`);
    const area = (f: MassingFace) => (f.sMax - f.sMin) * (f.tMax - f.tMin);
    const A = walls.reduce((a, f) => (area(f) > area(a) ? f : a));
    const across = walls.filter(f => Math.abs(f.normal[0] * A.normal[0] + f.normal[2] * A.normal[2]) < 0.35);
    if (!across.length) throw new Error('no wall roughly perpendicular to the largest one: the sheet needs two sides of the structure');
    const B = across.reduce((a, f) => (area(f) > area(a) ? f : a));
    const lo = bounds.min, hi = bounds.max;
    const centre: V3 = [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2];
    const H = hi[1] - lo[1];
    const th = Math.tan(Math.atan(STATION_OPTICS.sensorWidthMm / 2 / STATION_OPTICS.focalLengthMm)), tv = th / STATION_OPTICS.aspectRatio, M = SHEET_FRAME_MARGIN;
    const straightOn = (f: MassingFace, id: number) => {
        const n = norm([f.normal[0], 0, f.normal[2]]), perp: V3 = [-n[2], 0, n[0]];
        const p0 = faceAt(f, f.sMin, 0);
        const c = add(centre, n, (p0[0] - centre[0]) * n[0] + (p0[2] - centre[2]) * n[2]);   // the centre on the wall's plane
        const xs = [lo[0], hi[0]].flatMap(x => [lo[2], hi[2]].map(z => (x - centre[0]) * perp[0] + (z - centre[2]) * perp[2]));
        const w = Math.max(...xs) - Math.min(...xs);
        const d = Math.max(H / 2 * M / tv, w / 2 * M / th);
        return { id, eye: add(c, n, d), target: c, name: `SHEET_${f.key}` };
    };
    const diag = norm([A.normal[0] + B.normal[0], 0, A.normal[2] + B.normal[2]]);
    const r = 0.5 * Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]), d3 = r * M / Math.sin(Math.atan(tv));
    const el = SHEET_AERIAL_ELEVATION_DEG * Math.PI / 180;
    const up = norm([Math.cos(el) * diag[0], Math.sin(el), Math.cos(el) * diag[2]]);
    return [straightOn(A, 9001), straightOn(B, 9002), { id: 9003, eye: add(centre, diag, d3), target: centre, name: 'SHEET_corner' }, { id: 9004, eye: add(centre, up, d3 * 1.1), target: centre, name: 'SHEET_aerial' }]
        .map(s => stationFromLookAt(s.id, s.eye, s.target, STATION_OPTICS, anchor, { name: s.name }));
}

/**
 * The plates with the sheet's passing panels laid over them: a texel any passing panel sees takes the panel's colour (the
 * relief stays the plate's, the scan's); the rest keep the plate. Returns new plates and how many texels came from the sheet.
 */
export function overlaySheet(plates: Plate[], faces: MassingFace[], sheet: Pick<CharacterSheetResult, 'panels'>): { plates: Plate[]; fromSheet: number[] } {
    const over = plates.map(p => emptyPlate(p.face, faces[p.face]));
    for (const p of sheet.panels) {
        if (!p.qc.passed) continue;
        const img = decodePng(p.imagePng), b = p.blockout;
        layStation({ rgba: img.rgba, depth: b.depth, cameraPose: b.cameraPose as never, intrinsics: b.intrinsics, width: b.width, height: b.height }, p.station.id, over, faces);
    }
    const fromSheet = plates.map(() => 0);
    const out = plates.map((pl, k) => {
        const o = over[k], rgb = Uint8Array.from(pl.rgb);
        const stations = [...pl.stations];
        for (let j = 0; j < pl.w * pl.h; j++) {
            if (!(o.score[j] > 0)) continue;
            rgb[j * 3] = o.rgb[j * 3]; rgb[j * 3 + 1] = o.rgb[j * 3 + 1]; rgb[j * 3 + 2] = o.rgb[j * 3 + 2];
            fromSheet[k]++;
        }
        for (const s of o.stations) if (!stations.includes(s)) stations.push(s);
        // a texel the sheet saw but no survey station did: seen now, with the plate's relief left unmeasured (NaN)
        const merged = { ...pl, rgb, stations };
        const fin = finishPlate({ ...merged, score: Float32Array.from({ length: pl.w * pl.h }, (_, j) => (o.score[j] > 0 || !Number.isNaN(pl.relief[j]) ? 1 : 0)) });
        return fin;
    });
    return { plates: out, fromSheet };
}

export interface SheetPlatesOptions {
    /** The isolated structure, textured (the staged run's refined scan): what the sheet is rendered from. */
    structureGlb: string;
    generator: StationImageGenerator;
    anchor: GeodeticAnchor;
    place: string;
    /** Sheets per round and rounds (building-character-sheet.ts); defaults 3 and 2 rerolls. */
    candidates?: number;
    maxRerolls?: number;
    /** Ranks the usable sheets: the overlaid plates in, a value out (higher is better), e.g. the facade reading. */
    score?: (plates: Plate[]) => Promise<{ value: number; detail?: unknown }>;
    signal?: AbortSignal;
}

export interface SheetPlatesResult {
    plates: Plate[];
    sheet: CharacterSheetResult;
    /** Texels per plate that took the sheet's colour. */
    fromSheet: number[];
    stations: ColmapCameraPose[];
}

/** The sheet for these plates' structure, and the plates with it laid over them (or the plates unchanged when no sheet is usable). */
export async function sheetPlates(plates: Plate[], faces: MassingFace[], opts: SheetPlatesOptions): Promise<SheetPlatesResult> {
    const renderer = new SurveyStationRenderService();
    await renderer.loadMesh(opts.structureGlb);
    const bounds = renderer.getMeshBounds();
    if (!bounds) throw new Error(`the structure GLB has no geometry to frame (${opts.structureGlb})`);
    const stations = renderer.enrichStations(planSheetStations(faces, bounds, opts.anchor));
    const sheet = await beautifyCharacterSheet(renderer, opts.generator, stations, opts.place, {
        glbPath: opts.structureGlb, candidates: opts.candidates ?? 3, maxRerolls: opts.maxRerolls ?? 2,
        ...(opts.score ? { score: (s: CharacterSheetResult) => opts.score!(overlaySheet(plates, faces, s).plates), keepAccepted: 2, scoreMaxFailingPanels: 1 } : {}),
        ...(opts.signal ? { signal: opts.signal } : {})
    });
    if (!sheet.accepted && !sheet.usable) return { plates, sheet, fromSheet: plates.map(() => 0), stations };
    const { plates: over, fromSheet } = overlaySheet(plates, faces, sheet);
    return { plates: over, sheet, fromSheet, stations };
}
