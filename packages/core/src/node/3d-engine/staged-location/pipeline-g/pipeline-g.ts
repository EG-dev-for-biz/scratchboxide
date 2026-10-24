/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Pipeline G: the isolated structure rebuilt procedurally from a survey of the photo tile, in pipeline E's grammar slot
 * (request.procedural, set for every isolated building unless the caller passes procedural false; or SCRATCHBOX_STAGED_GEOMETRY=g everywhere). E's massing stands as built (the vector footprint, its
 * walls on the facades the scan measures); G then
 *   0. groups the walls of a footprint that traces piers or bays into the facades they make (facades.ts), surveyed and read
 *      whole, what is read laid back onto the walls,
 *   1. places survey stations by the staged survey's own rules (stations.ts),
 *   2. path-traces them from the tile with metric depth and lays them onto metric wall plates (plates.ts),
 *   3. reads every well-seen plate as a facade program in metres (read.ts), checks each reading against its plate (check.ts)
 *      and reads a wall again when its reading does not fit, keeping the reading that fits better (alongside this, asks a
 *      search-grounded reference of every wall still weak after that, for the brief rather than the build: references.ts),
 *   4. builds it natively on the massing, with what stands on the roof built from the scan's measures (roof-objects.ts:
 *      skylights, bulkheads, penthouses, tanks as parts with their outlines, heights and fitted roof planes), (scratchbox_staged_massing.hpp: arched openings with their frames, mullions and
 *      transoms, sills and surrounds, swept bands, members) with no tile
 *      texture and no scanned residual, and
 *   5. surveys the roof from above and redraws it as its texture (roof-texture.ts), labelled generated, and
 *   6. paints each face from its own reading: wall colour, glazing in its openings, band and member colours on their
 *      footprints; a wall nobody read takes the read walls' median colour.
 * Everything read is photo-inferred, everything continued into unseen parts and every unread wall generated; the measured
 * massing stays vector-modelled. A weak wall's search-grounded reference never feeds the build itself (nothing it shows is
 * built automatically): it is written into the brief for whoever next works from the brief to look at and use only where
 * its two independent references agree and the scan does not contradict them, labelled generated. Measured on the
 * Haughwout Building (2026-10-22): arched arcades on both street walls, piers and colonnettes, bands and cornice, shop
 * fronts to the pavement, about 44,000 vertices.
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { TEXTURE_LADDER_RUNGS } from '../../../../common/spatial/texture-pass-contracts';
import type { ColmapCameraPose, GeodeticAnchor } from '../../../../common/spatial/colmap-vector-reference-types';
import { HeadlessMeshSilhouetteRenderer } from '../../../spatial/HeadlessMeshSilhouetteRenderer';
import type { GroundModel } from '../../../spatial/StreetViewSurveyPlanner';
import type { VisionModelChain } from '../../../gemini/vision-model-chain';
import type { StructurePickResult } from '../extraction-sizing';
import type { FaceTexture, TexelSource } from '../pipeline-e/massing-glb';
import { massingSpecText, type FaceSweepItem, type Massing, type OpeningItem } from '../pipeline-e/massing-spec';
import { readFaceOrtho, runMassing, type MassingFace, type MassingRun } from '../pipeline-e/native-massing';
import { writeMassingLayer } from '../pipeline-e/pipeline-e';
import type { InferenceOutcome, StepRecord } from '../pipeline-e/inference';
import { ENHANCE_CONCURRENCY, MAX_SHIFT_PX, SEARCH_SIDE, TEXTURE_PLATE_PROMPT_ID, edges, transform, type EnhanceWallRecord, type PlateModelClient, type WallStreetView } from '../pipeline-e/enhance';
import { bestStreetViewForWall, wallReference, type GuideView } from '../pipeline-e/plate-streetview';
import { exactDistanceTransform } from '../../../spatial/StreetViewStage3Metrics';
import { resizeRgba } from '../texture-enhance';
import { visionFacadeCounter } from '../pipeline-e/plate-identity';
import { buildFacadeTexture, repeatFill } from '../facade-texture/facade-texture';
import type { EnhanceModelClient } from '../texture-enhance';
import { planStations } from './stations';
import { platePng, reliefPng, surveyPlates, type Plate } from './plates';
import { MIN_READ_COVERAGE, PIPELINE_G_READ_VERSION, programItems, readPlate, type FacadeProgram, type ProgramItems } from './read';
import { checkPlate, checkReading, type ReadingCheck } from './check';
import { groupFacades, layBack } from './facades';
import { roofObjects, type RoofObject } from './roof-objects';
import { writeBuildingBrief, type BuildingBriefRecord } from './brief';
import { closePlateGaps, redrawRoof, roofStations, ROOF_PLATE_PROMPT_ID, type RoofTextureRecord } from './roof-texture';
import { referenceQuery, weakWallReferences, type WeakWallReference } from './references';
import { decideBuildingNames, footprintDistanceM, type BuildingNames, type Poi } from '../building-name';
import { BRIEF_NEARBY_POI_M } from './brief';
import type { GroundedReferenceClient } from '../../../spatial/search-grounded-reference';
import type { LedgerEntry } from '../pipeline-h/ledger';

export const PIPELINE_G_VERSION = `pipeline-g/v6+${PIPELINE_G_READ_VERSION}`;  // v6: band stations up tall walls (v5: roofs redrawn largest first, small tops painted, the budget checked per roof)
/** A roof face under this is an object's top: it keeps its painted colour rather than an image-model redraw of its own. */
export const ROOF_REDRAW_MIN_M2 = 20;
/** Native build parameters: the massing only, nothing baked from the tile, no scanned residual. */
export const G_BUILD_PARAMS = { bake: 0, residual: 0, sections: 0, topdown: 0, snapMaxM: 0 } as const;
/** Plates read at once. */
export const READ_POOL = 4;

/**
 * The rules a procedural rebuild runs under. Pipeline G is the defaults (G_POLICY: no budget, every reading built, the
 * native tool's rejections listed by id); pipeline H (pipeline-h/pipeline-h.ts) sets each of these. One implementation,
 * two policies: the steps are the same, the decisions around them differ.
 */
export interface RebuildPolicy {
    name: string;
    /**
     * Milliseconds from the start within which the layer must be written. A step that cannot fit what is left is skipped
     * with a note (readings get a shorter deadline, textures and references are not started) and the build commits what
     * it has, rather than the stage's own limit discarding a finished survey (run 5c3555af: 15 minutes lost at 900 s).
     */
    budgetMs?: number;
    /** A reading still explaining under this share of its plate after its re-read, with a lift under gateLift, is dropped: its wall is painted generated, not built from a lattice nobody saw. */
    gateExplained?: number;
    gateLift?: number;
    /** Continued (generated) openings that overlap another opening on their wall, or lie past its ends, are dropped before the native build. */
    dedupeContinued?: boolean;
    /** The native build's rejections grouped by the reason the tool gives, instead of listed by id. */
    rejectionReasons?: boolean;
    /** The evidence ledger (pipeline-h/ledger.ts) kept and written into the brief. */
    ledger?: boolean;
}
export const G_POLICY: RebuildPolicy = { name: 'g' };
/** Time the build, paint, layer write, brief and footprint lock need after the last reading or texture (measured: 40-60 s). */
export const BUDGET_RESERVE_MS = 90_000;
/** No reading is started with less than this left for it. */
export const BUDGET_MIN_READ_MS = 60_000;
/** A facade texture or a roof texture is not started with less than this left (measured: 20-75 s each). */
export const BUDGET_TEXTURE_MS = 90_000;
/**
 * The Street View survey (registration, cut-outs, obstruction-free copies) runs beside the stations and the reading from
 * the start; when the walls are drawn it is waited for at most this long, then the walls go without it (said so).
 */
export const G_STREET_VIEW_WAIT_MS = 120_000;

/** Pipeline G for this request: asked for (procedural), or SCRATCHBOX_STAGED_GEOMETRY=g. */
export function stagedPipelineG(request: { procedural?: boolean }, env: NodeJS.ProcessEnv = process.env): boolean {
    return request.procedural === true || (env.SCRATCHBOX_STAGED_GEOMETRY ?? '').trim().toLowerCase() === 'g';
}

const rung = (name: (typeof TEXTURE_LADDER_RUNGS)[number]) => TEXTURE_LADDER_RUNGS.indexOf(name);
/** Texel sources of G's paint (indices into the legend). */
export const G_SRC = { read: 0, continued: 1, enhanced: 2, roof: 3, measured: 4 } as const;
export function gLegend(): TexelSource[] {
    return [
        { source: 'pipeline-g-read', label: 'photo-inferred', method: 'pipeline G: a flat colour the vision model read off the survey plate of this wall (station renders of the photo tile laid onto the wall in metres), painted on the wall, its openings, bands and members', rung: rung('generated tileable PBR'), weight: 0.3 },
        { source: 'pipeline-g-continued', label: 'generated', method: "pipeline G: a part the survey did not see (an opening or member the reading continued from the wall's own repeats, or a wall nobody read, given the read walls' median colour)", rung: rung('generated tileable PBR'), weight: 0.15 },
        { source: 'pipeline-g-enhanced', label: 'generated', method: `pipeline G: AI-enhanced from the survey plate of this wall by the facade texture builder (${TEXTURE_PLATE_PROMPT_ID}), kept through its identity gate and quality score, what the score faulted redrawn by generative infill`, rung: rung('generated tileable PBR'), weight: 0.25 },
        { source: 'pipeline-g-roof', label: 'generated', method: `pipeline G: the roof redrawn by the image model (${ROOF_PLATE_PROMPT_ID}) from its survey plate, a station looking down on it, kept where its edges held to the plate`, rung: rung('generated tileable PBR'), weight: 0.25 },
        { source: 'pipeline-g-measured-colour', label: 'photo-inferred', method: "pipeline G: a face nobody read, in the one flat colour measured on its own bake of the tile photo (pipeline E's ortho of it, the mean of its lit texels): no texture of the photo drawn", rung: rung('generated tileable PBR'), weight: 0.2 }
    ];
}

export interface PipelineGInput {
    massing: Massing;
    /** Pipeline E's native run of the massing: its walls are the faces surveyed. */
    run: MassingRun;
    /** The photo tile the stations are rendered from (devegetated where the strip ran). */
    tilePath: string;
    dir: string;
    stage: string;
    stageKey: string;
    chain: Pick<VisionModelChain<string>, 'generate'>;
    place: string;
    structure: Pick<StructurePickResult, 'cells' | 'groundY' | 'centroid'>;
    ground: GroundModel;
    anchor: GeodeticAnchor;
    signal?: AbortSignal;
    onProgress?: (m: string) => void;
    /** The facade texture builder's image model (absent: the walls keep their painted colours). */
    enhance?: { client: PlateModelClient; models: string[]; cacheDir?: string;
        /** Generative infill of what the quality score faults (a survey plate is worse than its redraw: never reverted to). */
        infill?: { client: EnhanceModelClient; models: string[] };
        /** The models for a wall with unseen areas (the facade texture builder's unseenModels). */
        unseenModels?: string[];
        /**
         * The registered Street View views of the structure (streetview-registered-views.ts): each wall's best one is sent to
         * the model with its plate, as its obstruction-free copy where the view has one (wallReference).
         */
        streetViews?: () => Promise<GuideView[]> };
    /** A search-grounded reference for every wall the check marks weak, written into the brief (references.ts; absent: none are fetched). */
    references?: { client: GroundedReferenceClient; models?: string[]; outputDir: string };
    /**
     * What names the building (building-name.ts): the evidence's points of interest (scan frame), the request's query and the
     * resolved address. The weak-wall references search by the name decided; the brief carries the names and nearby POIs.
     */
    naming?: { pois?: readonly Poi[]; query?: string; address?: string };
    /** Where the building brief and its images are published, outside the chat tools' IGNORED_DIRS (brief.ts; absent: workspace_view_file cannot reach the brief). */
    publicDir?: string;
    /** The rules (G_POLICY when absent). */
    policy?: RebuildPolicy;
    /** Ledger entries the orchestrator decided before the rebuild (structure, footprint, heights), kept ahead of the rebuild's own. */
    ledger?: LedgerEntry[];
    /**
     * The massing already carries what stands on its roof (the scan-led massing, scan-massing.ts: outlines from the photo
     * straight down, heights from the scan): these notes describe it, and the scan-blob roof objects (roof-objects.ts) are
     * not built over it.
     */
    roofObjectsGiven?: string[];
}

export interface PipelineGOutcome extends InferenceOutcome {
    /** The evidence ledger (policy.ledger), the orchestrator's entries first. */
    ledger: LedgerEntry[];
    /** Steps the budget cut short or skipped, each with what was left and what it needed. */
    budgetNotes: string[];
    plates: Array<{ face: string; coverage: number; read: boolean; model?: string; notes?: string; counts?: ProgramItems['counts']; check?: ReadingCheck; reread?: 'first' | 'second' }>;
    /** The building brief written beside the build (brief.ts), or why it was not. */
    brief?: BuildingBriefRecord | { error: string };
    /** What the evidence calls the building (building-name.ts); `names.primary` is what the references searched by. */
    names: BuildingNames;
    stations: { kept: number; dropped: number; candidates: number; skipped: Array<{ face: string; reason: string }> };
}

const median = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : NaN; };

/** Whether (s, t) is inside an opening's outline (the rectangle to its springing line and its arch above). */
export function inOpening(o: Pick<OpeningItem, 's0' | 's1' | 't0' | 't1' | 'archRiseM'>, s: number, t: number): boolean {
    if (s < o.s0 || s > o.s1 || t < o.t0 || t > o.t1) return false;
    const half = (o.s1 - o.s0) / 2, rise = Math.min(o.archRiseM ?? 0, half, 0.95 * (o.t1 - o.t0));
    if (rise < 0.01 || t <= o.t1 - rise) return true;
    const r = (half * half + rise * rise) / (2 * rise), cx = (o.s0 + o.s1) / 2, cy = o.t1 - r;
    return (s - cx) ** 2 + (t - cy) ** 2 <= r * r;
}

/**
 * Whether (s, t) lies on an opening's divided glazing (OpeningItem panes): within frameM of its outline, or on one of its
 * evenly spaced mullions or transoms (scratchbox_staged_massing.hpp emitPanes lays them the same way).
 */
export function onPaneBar(o: OpeningItem, s: number, t: number): boolean {
    const p = o.panes;
    if (!p || !inOpening(o, s, t)) return false;
    const fw = p.frameM;
    if (fw > 0 && !inOpening({ s0: o.s0 + fw, s1: o.s1 - fw, t0: o.t0 + fw, t1: o.t1 - fw, archRiseM: Math.max(0, (o.archRiseM ?? 0) - fw) }, s, t)) return true;
    const half = p.barM / 2;
    for (let k = 1; k < p.cols; k++) if (Math.abs(s - (o.s0 + ((o.s1 - o.s0) * k) / p.cols)) <= half) return true;
    for (let k = 1; k < p.rows; k++) if (Math.abs(t - (o.t0 + ((o.t1 - o.t0) * k) / p.rows)) <= half) return true;
    return false;
}

/** The (s, t) footprint of a face sweep on its face: [s0, s1, t0, t1] per placement. */
export function sweepFootprints(w: FaceSweepItem): Array<[number, number, number, number]> {
    // the whole profile's span: its ends sit on the face at offset 0 and it stands proud between them
    const cs = w.profile.map(([, c]) => c);
    if (cs.length < 2 || !w.profile.some(([o]) => o > 0.005)) return [];
    const lo = Math.min(...cs), hi = Math.max(...cs);
    return w.placements.map(([a0, a1, dc]) => (w.axis === 0 ? [a0, a1, dc + lo, dc + hi] : [dc + lo, dc + hi, a0, a1]) as [number, number, number, number]);
}

/** Paint resolution, metres per texel, and the largest raster side (a larger face is painted coarser). */
export const PAINT_PIXEL_M = 0.05;
export const PAINT_MAX_SIDE = 2048;

/**
 * Gives a face built without the tile bake (G_BUILD_PARAMS: no ortho) its own raster frame over its (s, t) extent, the
 * frame the layer writer maps its vertices through. A face that has one (a baked build) keeps it.
 */
export function ensurePaintFrame(f: MassingFace): void {
    if (f.width > 0 && f.height > 0 && f.pixel > 0) return;
    if (!(f.sMax > f.sMin) || !(f.tMax > f.tMin)) return;
    const pixel = Math.max(PAINT_PIXEL_M, (f.sMax - f.sMin) / PAINT_MAX_SIDE, (f.tMax - f.tMin) / PAINT_MAX_SIDE);
    f.pixel = pixel;
    f.orthoSMin = f.sMin;
    f.orthoTMax = f.tMax;
    f.width = Math.max(1, Math.ceil((f.sMax - f.sMin) / pixel));
    f.height = Math.max(1, Math.ceil((f.tMax - f.tMin) / pixel));
}

/**
 * A face's own colour, measured on pipeline E's bake of it from the tile photo (its ortho in `dir`): the mean colour of its
 * lit texels (luma between the 60th and 90th percentile of its covered texels, so baked shadow does not darken it).
 */
export function measuredFaceColour(dir: string, f: Pick<MassingFace, 'index' | 'width' | 'height'>): [number, number, number] | undefined {
    let o;
    try { o = readFaceOrtho(dir, f); } catch { return undefined; }
    if (!o) return undefined;
    const px: Array<[number, number, number, number]> = [];
    for (let i = 0; i < o.width * o.height; i++) {
        if (o.rgba[i * 4 + 3] < 128) continue;
        const r = o.rgba[i * 4], g = o.rgba[i * 4 + 1], b = o.rgba[i * 4 + 2];
        px.push([0.299 * r + 0.587 * g + 0.114 * b, r, g, b]);
    }
    if (px.length < 100) return undefined;
    px.sort((a, b) => a[0] - b[0]);
    const lit = px.slice(Math.floor(px.length * 0.6), Math.floor(px.length * 0.9));
    return [1, 2, 3].map(k => Math.round(lit.reduce((s, p) => s + p[k], 0) / lit.length)) as [number, number, number];
}

/** The paint: per face of the built run, its raster in the face's ortho frame (given one when it was built without). */
export function paintFaces(faces: MassingFace[], items: Map<string, ProgramItems>, fallback: [number, number, number], measured?: Map<string, [number, number, number]>): Map<number, FaceTexture> {
    const textures = new Map<number, FaceTexture>();
    for (const f of faces) {
        if (f.kind === 'base') continue;
        ensurePaintFrame(f);
        if (!f.width || !f.height) continue;
        const own = items.get(f.key) ?? [...items.entries()].find(([k]) => f.key.startsWith(k + ':'))?.[1];
        // a face nobody read: its own measured colour, else the read walls' median (a roof darker)
        const measuredC = own ? undefined : measured?.get(f.key) ?? [...(measured ?? new Map<string, [number, number, number]>()).entries()].find(([k]) => f.key.startsWith(k + ':'))?.[1];
        const wallC = own?.wallColour ?? measuredC ?? (f.kind === 'roof' ? fallback.map(c => Math.round(c * 0.6)) as [number, number, number] : fallback);
        const wallSrc = own ? G_SRC.read : measuredC ? G_SRC.measured : G_SRC.continued;
        const rgba = new Uint8Array(f.width * f.height * 4), source = new Uint8Array(f.width * f.height).fill(wallSrc);
        for (let i = 0; i < f.width * f.height; i++) rgba.set([wallC[0], wallC[1], wallC[2], 255], i * 4);
        if (own) {
            const put = (s0: number, s1: number, t0: number, t1: number, c: [number, number, number], src: number, inside?: (s: number, t: number) => boolean) => {
                const x0 = Math.max(0, Math.floor((s0 - f.orthoSMin) / f.pixel)), x1 = Math.min(f.width - 1, Math.ceil((s1 - f.orthoSMin) / f.pixel));
                const y0 = Math.max(0, Math.floor((f.orthoTMax - t1) / f.pixel)), y1 = Math.min(f.height - 1, Math.ceil((f.orthoTMax - t0) / f.pixel));
                for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
                    const s = f.orthoSMin + (x + 0.5) * f.pixel, t = f.orthoTMax - (y + 0.5) * f.pixel;
                    if (inside && !inside(s, t)) continue;
                    rgba.set([c[0], c[1], c[2], 255], (y * f.width + x) * 4);
                    source[y * f.width + x] = src;
                }
            };
            for (const w of own.faceSweeps) for (const [s0, s1, t0, t1] of sweepFootprints(w)) put(s0, s1, t0, t1, own.colours.get(w.id) ?? wallC, w.provenance === 'generated' ? G_SRC.continued : G_SRC.read);
            for (const o of own.openings) put(o.s0, o.s1, o.t0, o.t1, own.colours.get(o.id) ?? [40, 44, 50], o.provenance === 'generated' ? G_SRC.continued : G_SRC.read, (s, t) => inOpening(o, s, t));
            // divided glazing: the frame and bars in their own colour (the native build stands them proud of the glass there)
            for (const o of own.openings) {
                if (!o.panes) continue;
                const fc = own.colours.get(`${o.id}:frame`) ?? [30, 30, 32];
                put(o.s0, o.s1, o.t0, o.t1, fc, o.provenance === 'generated' ? G_SRC.continued : G_SRC.read, (s, t) => onPaneBar(o, s, t));
            }
        }
        textures.set(f.index, { width: f.width, height: f.height, rgba, source });
    }
    return textures;
}

/**
 * The band of a wall above the street, metres, where the tile melts what stands at the kerb into the facade (vehicles, vans,
 * people, street furniture): not in front of the wall, so PLATE_PROUD_M does not see it, and pipeline G does not run the
 * vehicle removal. It is never taken as seen: it is sent as the painted reading (the read shopfront openings), and the model is
 * told it is the street level to draw as the ground floor.
 */
export const STREET_CLUTTER_M = 2.5;

/** A seen-through hole larger than this is not an opening (a part of the wall no station reached). */
export const MAX_OPENING_M2 = 20;

/** The holes of `mask` that are openings: connected regions not touching the frame's edge and under MAX_OPENING_M2. */
export function enclosedHoles(mask: Uint8Array, W: number, H: number, pixelM: number): Uint8Array {
    const out = new Uint8Array(W * H), seen = new Uint8Array(W * H), maxPx = MAX_OPENING_M2 / (pixelM * pixelM);
    for (let s = 0; s < W * H; s++) {
        if (!mask[s] || seen[s]) continue;
        const region: number[] = [], stack = [s];
        seen[s] = 1;
        let edge = false;
        while (stack.length) {
            const i = stack.pop()!;
            region.push(i);
            const x = i % W, y = (i - x) / W;
            if (x === 0 || y === 0 || x === W - 1 || y === H - 1) edge = true;
            for (const j of [i - 1, i + 1, i - W, i + W]) {
                if (j < 0 || j >= W * H || Math.abs((j % W) - x) > 1 || seen[j] || !mask[j]) continue;
                seen[j] = 1; stack.push(j);
            }
        }
        if (!edge && region.length <= maxPx) for (const i of region) out[i] = 1;
    }
    return out;
}

/**
 * A plate texel standing further than this in front of the wall's own surface (the median offset of the plate's texels from
 * the massing plane: the melted scan sits off the plane as a whole) is something in front of the wall: a car, a person, a
 * pole, melted into the tile.
 */
export const PLATE_PROUD_M = 0.6;

/**
 * A built face's texture for the facade texture builder: the survey plate of its wall resampled into the face's raster
 * through world space (the plate is in the surveyed face's frame), over the painted texture where the plate saw nothing.
 * `use` marks the texels a station saw of the wall itself: not the plate's unseen mid-grey, and not what stands more than
 * PLATE_PROUD_M in front of the wall's surface (the street clutter melted into the tile before the ground floor). The builder draws the
 * rest as the wall continues. Undefined when the plate covers none of the face.
 */
export function plateOntoFace(f: MassingFace, painted: FaceTexture, pl: Plate, pf: MassingFace): { tex: FaceTexture; use: Uint8Array; covered: number; openings: Uint8Array; street: Uint8Array } | undefined {
    const rgba = painted.rgba.slice(), use = new Uint8Array(painted.width * painted.height);
    // the street band texels the plate covers: never seen (see STREET_CLUTTER_M)
    const street = new Uint8Array(painted.width * painted.height);
    // what the stations saw through (no surface within the plate's slab): the openings, once only enclosed holes are kept
    const through = new Uint8Array(painted.width * painted.height);
    let covered = 0;
    const dot = (a: number[], b: number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    const plPix = pl.widthM / pl.w;
    // the wall's own surface: the median offset of what the stations saw
    const offs: number[] = [];
    for (let j = 0; j < pl.relief.length; j += 7) if (!Number.isNaN(pl.relief[j])) offs.push(pl.relief[j]);
    offs.sort((a, b) => a - b);
    const surface = offs.length ? offs[Math.floor(offs.length / 2)] : 0;
    for (let y = 0; y < painted.height; y++) for (let x = 0; x < painted.width; x++) {
        const s = f.orthoSMin + (x + 0.5) * f.pixel, t = f.orthoTMax - (y + 0.5) * f.pixel;
        // a wall's street band (a roof's t runs across it, not up: it has none)
        const inBand = f.kind === 'wall' && t - f.tBottom < STREET_CLUTTER_M;
        const p = [0, 1, 2].map(k => f.origin[k] + s * f.axisS[k] + t * f.axisT[k]);
        const d = [0, 1, 2].map(k => p[k] - pf.origin[k]);
        const ps = dot(d, pf.axisS as number[]), pt = dot(d, pf.axisT as number[]);
        const px = Math.floor((ps - pf.sMin) / plPix), py = Math.floor((pf.tMax - pt) / plPix);
        if (px < 0 || py < 0 || px >= pl.w || py >= pl.h) continue;
        const j = py * pl.w + px;
        if (Number.isNaN(pl.relief[j])) { if (!inBand) through[y * painted.width + x] = 1; continue; }
        if (pl.relief[j] - surface > PLATE_PROUD_M) continue;
        if (Math.abs(pl.rgb[j * 3] - 128) <= 4 && Math.abs(pl.rgb[j * 3 + 1] - 128) <= 4 && Math.abs(pl.rgb[j * 3 + 2] - 128) <= 4) continue;
        const i = y * painted.width + x;
        rgba[i * 4] = pl.rgb[j * 3]; rgba[i * 4 + 1] = pl.rgb[j * 3 + 1]; rgba[i * 4 + 2] = pl.rgb[j * 3 + 2]; rgba[i * 4 + 3] = 255;
        // the street band: laid on (so it is drawn over it) but never taken as seen
        if (inBand) { street[i] = 1; continue; }
        use[i] = 1; covered++;
    }
    return covered ? { tex: { width: painted.width, height: painted.height, rgba, source: painted.source.slice() }, use, covered: covered / use.length, openings: enclosedHoles(through, painted.width, painted.height, f.pixel), street } : undefined;
}

export interface GeometryAlignResult { dx: number; dy: number; chamferPx: number; coveredOpenings: number; why: string; aligned: Uint8Array }

/** The opening rectangles' own silhouette (inOpening, which already draws the arch) rasterised at (W, H) over a grid pixel pM metres wide, and its boundary pixels (a mask transition) restricted to `use`: a chamfer target like alignPlate's edges(), built from geometry instead of a second photo. */
function openingBoundary(openings: Array<Pick<OpeningItem, 's0' | 's1' | 't0' | 't1' | 'archRiseM'>>, frame: Pick<MassingFace, 'orthoSMin' | 'orthoTMax'>, W: number, H: number, pM: number, use: Uint8Array): { boundary: Uint8Array; covered: number } {
    const mask = new Uint8Array(W * H);
    let covered = 0;
    for (const o of openings) {
        const x0 = Math.max(0, Math.floor((o.s0 - frame.orthoSMin) / pM)), x1 = Math.min(W - 1, Math.ceil((o.s1 - frame.orthoSMin) / pM));
        const y0 = Math.max(0, Math.floor((frame.orthoTMax - o.t1) / pM)), y1 = Math.min(H - 1, Math.ceil((frame.orthoTMax - o.t0) / pM));
        let seen = false;
        for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
            const s = frame.orthoSMin + (x + 0.5) * pM, t = frame.orthoTMax - (y + 0.5) * pM;
            if (!inOpening(o, s, t)) continue;
            mask[y * W + x] = 1;
            if (use[y * W + x]) seen = true;
        }
        if (seen) covered++;
    }
    const boundary = new Uint8Array(W * H);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const i = y * W + x;
        if (!mask[i] || !use[i]) continue;
        if (x === 0 || y === 0 || x === W - 1 || y === H - 1 || !mask[i - 1] || !mask[i + 1] || !mask[i - W] || !mask[i + W]) boundary[i] = 1;
    }
    return { boundary, covered };
}

/**
 * A small corrective shift (alignPlate's edge-chamfer search, translation only: the grid plateOntoFace wrote the texture
 * onto is already correctly scaled, so unlike alignPlate there is no scale to search) that brings a texture plateOntoFace
 * already placed by its geometric reprojection nearest the wall's OWN known openings (the facade program's read
 * rectangles, the same ones the native build actually opened) — catching a residual drift the reprojection cannot, such
 * as a survey station's calibrated pose being a little off the true camera. Openings plateOntoFace's own `use` never
 * covers (behind cladding the plate never saw) are excluded from both the target and the reported count; a wall with
 * none covered, or no read openings at all, is returned unchanged.
 */
export function alignTextureToOpenings(texture: Uint8Array, W: number, H: number, use: Uint8Array, openings: Array<Pick<OpeningItem, 's0' | 's1' | 't0' | 't1' | 'archRiseM'>>, frame: Pick<MassingFace, 'orthoSMin' | 'orthoTMax' | 'pixel'>, pixelM: number): GeometryAlignResult {
    if (!openings.length) return { dx: 0, dy: 0, chamferPx: 0, coveredOpenings: 0, why: 'no read openings on this wall to align against', aligned: texture };
    const full = openingBoundary(openings, frame, W, H, frame.pixel, use);
    if (!full.covered) return { dx: 0, dy: 0, chamferPx: 0, coveredOpenings: 0, why: 'none of the read openings land where the plate saw the wall', aligned: texture };
    // the search on a copy at most SEARCH_SIDE px long (shift in its pixels, like alignPlate), the measurement at full size
    const k = Math.min(1, SEARCH_SIDE / Math.max(W, H));
    const w = Math.max(8, Math.round(W * k)), h = Math.max(8, Math.round(H * k));
    const texS = resizeRgba({ width: W, height: H, rgba: texture }, w, h).rgba;
    const useS = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) useS[y * w + x] = use[Math.min(H - 1, Math.floor((y + 0.5) / k)) * W + Math.min(W - 1, Math.floor((x + 0.5) / k))];
    const { boundary: boundaryS } = openingBoundary(openings, frame, w, h, frame.pixel / k, useS);
    const dtS = exactDistanceTransform(boundaryS, w, h);
    const meanS = (img: Uint8Array) => {
        const e = edges(img, w, h, useS);
        let s = 0, n = 0;
        for (let i = 0; i < w * h; i++) if (e[i] && useS[i]) { s += Math.min(8, dtS[i]); n++; }
        return n ? s / n : 8;
    };
    const R = Math.max(1, Math.round(MAX_SHIFT_PX * k));
    let best = { dx: 0, dy: 0, v: meanS(texS) };
    for (let dy = -R; dy <= R; dy++) for (let dx = -R; dx <= R; dx++) {
        if (!dx && !dy) continue;
        const v = meanS(transform(texS, w, h, dx, dy, 1));
        if (v < best.v - 1e-6) best = { dx, dy, v };
    }
    const dx = Math.round(best.dx / k), dy = Math.round(best.dy / k);
    const aligned = (dx || dy) ? transform(texture, W, H, dx, dy, 1) : texture;
    // the measurement at full size, against the full-resolution boundary already built above
    const dtFull = exactDistanceTransform(full.boundary, W, H);
    const eAligned = edges(aligned, W, H, use);
    let s = 0, n = 0;
    for (let i = 0; i < W * H; i++) if (eAligned[i] && use[i]) { s += Math.min(8, dtFull[i]); n++; }
    const chamferPx = Math.round((n ? s / n : 8) * 100) / 100;
    return { dx, dy, chamferPx, coveredOpenings: full.covered, why: `corrective shift ${dx}, ${dy} px (${(dx * pixelM).toFixed(2)}, ${(dy * pixelM).toFixed(2)} m) against ${full.covered} read opening${full.covered === 1 ? '' : 's'} the plate saw; mean edge-to-opening-boundary distance ${chamferPx.toFixed(2)} px (${(chamferPx * pixelM).toFixed(2)} m)`, aligned };
}

/** Runs `fn` over `xs` with at most `n` in flight. */
/**
 * Drops, in place, the continued (generated) openings of one wall's items that lie past the wall's ends or overlap an
 * opening kept before them (read openings first, then continued ones in order), with their sills and surrounds. Says
 * which and why. A read opening is never dropped here: the native tool judges those and says why (rejectionsByReason).
 */
export function dedupeContinuedOpenings(it: ProgramItems, face: Pick<MassingFace, 'sMin' | 'sMax'> | undefined): { dropped: string[] } {
    const dropped: string[] = [];
    const keep: OpeningItem[] = [];
    const ordered = [...it.openings.filter(o => o.provenance !== 'generated'), ...it.openings.filter(o => o.provenance === 'generated')];
    for (const o of ordered) {
        if (o.provenance !== 'generated') { keep.push(o); continue; }
        const past = face ? o.s0 < face.sMin + 0.02 || o.s1 > face.sMax - 0.02 : false;
        const over = keep.find(p => o.s0 < p.s1 && p.s0 < o.s1 && o.t0 < p.t1 && p.t0 < o.t1);
        if (past || over) { dropped.push(`${o.id}: ${past ? 'past the wall\'s ends' : `overlaps ${over!.id}`}`); continue; }
        keep.push(o);
    }
    if (dropped.length) {
        const ids = new Set(dropped.map(d => d.split(':')[0]));
        it.openings = it.openings.filter(o => !ids.has(o.id));
        it.faceSweeps = it.faceSweeps.filter(s => !ids.has(s.id.replace(/:(sill|surround)$/, '')));
    }
    return { dropped };
}

/** Whether a (kept, possibly re-read) reading is dropped by the policy's gate: it explains under gateExplained of its plate and lifts under gateLift over its displaced copies. */
export function readingGated(c: Pick<ReadingCheck, 'explained' | 'lift'>, policy: Pick<RebuildPolicy, 'gateExplained' | 'gateLift'>): boolean {
    return policy.gateExplained !== undefined && c.explained < policy.gateExplained && c.lift < (policy.gateLift ?? Infinity);
}

/** The native tool's rejected openings counted by reason ('overlaps opening <id>' folded into one reason). */
export function rejectionsByReason(report: Pick<MassingRun['report'], 'rejectedOpenings' | 'rejectedOpeningReasons'>): Map<string, number> {
    const reasons = report.rejectedOpeningReasons ?? {};
    const byReason = new Map<string, number>();
    for (const id of report.rejectedOpenings) { const r = (reasons[id] ?? 'no reason given').replace(/ opening \S+$/, ' another opening'); byReason.set(r, (byReason.get(r) ?? 0) + 1); }
    return byReason;
}

async function pool<T, R>(xs: T[], n: number, fn: (x: T) => Promise<R>): Promise<R[]> {
    const out: R[] = new Array(xs.length);
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(n, xs.length) }, async () => { while (next < xs.length) { const i = next++; out[i] = await fn(xs[i]); } }));
    return out;
}

export async function runPipelineG(input: PipelineGInput): Promise<PipelineGOutcome> {
    const timingsMs: Record<string, number> = {};
    const steps: StepRecord[] = [];
    const progress = (m: string) => input.onProgress?.(m);
    const policy = input.policy ?? G_POLICY;
    const tStart = Date.now();
    /** Milliseconds the budget still allows (Infinity without one). */
    const left = () => policy.budgetMs === undefined ? Infinity : tStart + policy.budgetMs - Date.now();
    const budgetNotes: string[] = [];
    const ledger: LedgerEntry[] = policy.ledger ? [...(input.ledger ?? [])] : [];
    const tag = `pipeline ${policy.name.toUpperCase()}`;
    fs.mkdirSync(path.join(input.dir, 'plates'), { recursive: true });
    const faces = input.run.report.faces;
    // the Street View survey, started now so it runs beside the stations and the reading (it takes minutes)
    const surveyStarted = Date.now();
    const streetViews = input.enhance?.streetViews?.();
    streetViews?.catch(() => undefined);
    // the walls grouped into the facades the survey sees (facades.ts): a footprint tracing piers or bays is surveyed and read
    // a street front at a time, and what is read laid back onto its walls
    const grouping = groupFacades(faces);
    const surveyFaces = grouping.surveyFaces;
    if (grouping.groups.length) steps.push({ step: 'facades', proposed: grouping.groups.reduce((a, g) => a + g.members.length, 0), accepted: grouping.groups.length, rejected: 0, notes: grouping.groups.map(g => `${g.face.key}: ${g.members.length} walls read as one facade ${(g.face.sMax - g.face.sMin).toFixed(1)} m wide`), ms: 0 });

    // 1. stations
    let t = Date.now();
    progress(`${tag}: placing the survey stations on the street`);
    const tileMesh = HeadlessMeshSilhouetteRenderer.loadMeshFromGlb(input.tilePath);
    const plan = planStations({ allFaces: surveyFaces, structure: input.structure, ground: input.ground, tileMesh, anchor: input.anchor });
    timingsMs.stations = Date.now() - t;
    steps.push({ step: 'survey stations', proposed: plan.stations.length + plan.dropped.length, accepted: plan.stations.length, rejected: plan.dropped.length, notes: [`${plan.candidates} candidate eyes on the walkable street`, ...plan.skipped.map(s => `${s.face}: ${s.reason}`)], ms: timingsMs.stations });
    // the plan on disk before anything can fail, so a failed run still shows where its cameras stood
    fs.writeFileSync(path.join(input.dir, 'stations.json'), JSON.stringify({ candidates: plan.candidates, stations: plan.stations.map(s => ({ name: s.station.name, face: s.face, row: s.row, distanceM: s.distanceM, onFace: s.onFace })), dropped: plan.dropped, skipped: plan.skipped }, null, 1));
    if (!plan.stations.length) throw new Error(`no survey station sees a wall of the structure (${plan.candidates} candidate eyes on the walkable street; ${plan.skipped.map(s => s.reason).join('; ') || 'every placed station was blocked'})`);

    // 2. plates
    t = Date.now();
    // every surveyed wall gets a plate: an aerial lays onto walls no street station reached
    const faceIdx = [...new Set([...plan.stations.map(s => s.face), ...(plan.stations.some(s => s.row === 'aerial') ? plan.faces : [])])];
    const briefDir = path.join(input.dir, 'brief');
    const { plates, renders: wallRenders } = await surveyPlates({ keepRendersDir: path.join(briefDir, 'survey'), stations: plan.stations, faces: surveyFaces, faceIdx, tileGlb: input.tilePath, ...(input.signal ? { signal: input.signal } : {}), onProgress: progress });
    for (const pl of plates) {
        fs.writeFileSync(path.join(input.dir, 'plates', `face_${pl.face}_colour.png`), platePng(pl, false));
        fs.writeFileSync(path.join(input.dir, 'plates', `face_${pl.face}_relief.png`), reliefPng(pl));
    }
    timingsMs.plates = Date.now() - t;
    // the roof, from above (roof-texture.ts): its own station and plates, only when there is an image model to redraw them
    let roofPlates: Plate[] = [];
    let roofRenders: Array<{ station: number; file: string }> = [];
    let roofStationList: Array<{ station: ColmapCameraPose; faces: number[] }> = [];
    if (input.enhance) {
        const tr = Date.now();
        const roofIdx = surveyFaces.map((f, i) => ({ f, i })).filter(x => x.f.kind === 'roof');
        const rs = roofStations(roofIdx.map(x => x.f), input.anchor, 900);
        roofStationList = rs.map(s => ({ station: s.station, faces: s.faces.map(k => roofIdx[k].i) }));
        if (rs.length) {
            try {
                const rp = await surveyPlates({ keepRendersDir: path.join(briefDir, 'survey'), stations: rs, faces: surveyFaces, faceIdx: rs.flatMap(s => s.faces.map(k => roofIdx[k].i)), tileGlb: input.tilePath, ...(input.signal ? { signal: input.signal } : {}), onProgress: progress });
                roofPlates = rp.plates;
                roofRenders = rp.renders;
                const laidShare = roofPlates.map(p => p.coverage);
                const closed = roofPlates.map(p => closePlateGaps(p));
                for (const pl of roofPlates) fs.writeFileSync(path.join(input.dir, 'plates', `roof_${pl.face}_colour.png`), platePng(pl, false));
                steps.push({ step: 'roof survey', proposed: roofPlates.length, accepted: roofPlates.filter(p => p.coverage > 0).length, rejected: roofPlates.filter(p => p.coverage <= 0).length, notes: roofPlates.map((p, k) => `${p.key}: ${Math.round(laidShare[k] * 100)}% of its texels hit from above, ${Math.round(p.coverage * 100)}% after the gaps between the station's pixels were closed (${closed[k]} texels)`), ms: Date.now() - tr });
            } catch (err) {
                if (input.signal?.aborted) throw err;
                steps.push({ step: 'roof survey', proposed: rs.length, accepted: 0, rejected: rs.length, skipped: `the roof station could not be rendered (${err instanceof Error ? err.message : String(err)})`, notes: [], ms: Date.now() - tr });
            }
        }
    }
    const readable = plates.filter(p => p.coverage >= MIN_READ_COVERAGE);
    steps.push({ step: 'wall plates', proposed: plates.length, accepted: readable.length, rejected: plates.length - readable.length, notes: plates.map(p => `${p.key}: ${Math.round(p.coverage * 100)}% seen from ${p.stations.length} stations`), ms: timingsMs.plates });
    if (!readable.length) throw new Error(`no wall was seen well enough to read (best ${Math.round(Math.max(...plates.map(p => p.coverage)) * 100)}% of a wall; at least ${Math.round(MIN_READ_COVERAGE * 100)}% is needed)`);

    // 3. read (cached by the plate's pixels and the prompt version: a rerun on the same tile never bills twice)
    t = Date.now();
    progress(`${tag}: reading ${readable.length} wall${readable.length === 1 ? '' : 's'} as facade programs`);
    const readings = await pool(readable, READ_POOL, async (pl: Plate) => {
        const hash = crypto.createHash('sha256').update(PIPELINE_G_READ_VERSION).update(input.place).update(pl.rgb).update(Buffer.from(pl.relief.buffer)).digest('hex').slice(0, 24);
        const read = async (file: string, again?: string) => {
            const cached = path.join(input.dir, 'plates', file);
            if (fs.existsSync(cached)) return { ...(JSON.parse(fs.readFileSync(cached, 'utf8')) as { program: FacadeProgram; model: string; ms: number }), cached: true };
            // under a budget a reading gets what is left after the reserve, never more than the wall's own deadline
            const room = left() - BUDGET_RESERVE_MS;
            if (room < BUDGET_MIN_READ_MS) throw new Error(`not started: ${Math.round(Math.max(0, room) / 1000)} s of the budget left for it, at least ${BUDGET_MIN_READ_MS / 1000} s needed`);
            const r = await readPlate(input.chain, input.place, pl, input.signal, again, Number.isFinite(room) ? room : undefined);
            fs.writeFileSync(cached, JSON.stringify(r, null, 1));
            return { ...r, cached: false };
        };
        try {
            // the check (check.ts): a reading that explains little of its plate, or no more than its own displaced copies, is
            // read once more with what was measured, and the reading that explains more is kept
            const cp = checkPlate(pl);
            const first = await read(`reading_${hash}.json`);
            const c1 = checkReading(cp, first.program);
            if (!c1.weak) return { pl, ...first, check: c1 };
            if (left() - BUDGET_RESERVE_MS < BUDGET_MIN_READ_MS) { budgetNotes.push(`${pl.key}: weak reading kept without a re-read (${Math.round(Math.max(0, left()) / 1000)} s of the budget left)`); return { pl, ...first, check: c1 }; }
            const again = `A first reading of this wall was checked against the image and did not fit it: drawn back onto Image 1, its openings and members account for ${Math.round(c1.explained * 100)}% of the wall's light and dark variation, about ${c1.lift}x what the same reading moved half a bay out of place does. Look again: measure each row's bottom and top and each opening's left and right edges off the tick marks, and list only what the image shows.`;
            try {
                const second = await read(`reading_${hash}_again.json`, again);
                const c2 = checkReading(cp, second.program);
                return c2.explained > c1.explained ? { pl, ...second, check: c2, reread: { kept: 'second' as const, first: c1 } } : { pl, ...first, check: c1, reread: { kept: 'first' as const, second: c2 } };
            } catch (err) {
                if (input.signal?.aborted) throw err;
                return { pl, ...first, check: c1, reread: { kept: 'first' as const, error: err instanceof Error ? err.message : String(err) } };
            }
        } catch (err) {
            if (input.signal?.aborted) throw err;
            return { pl, error: err instanceof Error ? err.message : String(err) };
        }
    });
    timingsMs.read = Date.now() - t;
    const items = new Map<string, ProgramItems>();
    const checkNote = (c: ReadingCheck) => `explains ${Math.round(c.explained * 100)}% of the plate (${c.lift}x its displaced copies), edges P ${c.precision} R ${c.recall}, opening contrast ${c.openingContrast}`;
    /** Readings the gate dropped (policy.gateExplained): their walls are painted generated instead of built from them. */
    const gated: string[] = [];
    for (const r of readings) {
        if (!('program' in r && r.program)) continue;
        const c = 'check' in r ? r.check : undefined;
        if (c && readingGated(c, policy)) {
            gated.push(`${r.pl.key}: dropped by the gate (${checkNote(c)}; under ${Math.round((policy.gateExplained ?? 0) * 100)}% explained and ${policy.gateLift ?? '-'}x lift after its re-read): the wall keeps its measured colour, generated`);
            if (policy.ledger) ledger.push({ decision: `reading:${r.pl.key}`, chosen: 'none (generated wall)', why: `the reading explained ${Math.round(c.explained * 100)}% of the plate after its re-read`, sources: [{ source: 'reading', value: checkNote(c), used: false }] });
            continue;
        }
        items.set(r.pl.key, programItems(r.program, surveyFaces[r.pl.face], `g${r.pl.face}_`));
        if (policy.ledger && c) ledger.push({ decision: `reading:${r.pl.key}`, chosen: `${'model' in r ? r.model : 'reading'}${'reread' in r && r.reread ? ` (${r.reread.kept} reading kept)` : ''}`, why: checkNote(c), sources: [{ source: 'reading', value: checkNote(c), used: true }, ...('reread' in r && r.reread && 'first' in r.reread && r.reread.first ? [{ source: 'first reading', value: checkNote(r.reread.first), used: false }] : []), ...('reread' in r && r.reread && 'second' in r.reread && r.reread.second ? [{ source: 're-reading', value: checkNote(r.reread.second), used: false }] : [])] });
    }
    steps.push({ step: 'facade reading', proposed: readable.length, accepted: items.size, rejected: readable.length - items.size, notes: readings.map(r => ('error' in r && r.error) ? `${r.pl.key}: not read (${r.error})` : `${r.pl.key}: ${'model' in r ? r.model : ''}${'cached' in r && r.cached ? ' (cached)' : ''}${'check' in r && r.check ? `; ${checkNote(r.check)}` : ''}${'reread' in r && r.reread ? `; read again (${r.reread.kept} reading kept${'first' in r.reread && r.reread.first ? `, the first ${checkNote(r.reread.first)}` : ''}${'second' in r.reread && r.reread.second ? `, the second ${checkNote(r.reread.second)}` : ''}${'error' in r.reread && r.reread.error ? `, the second failed: ${r.reread.error}` : ''})` : ''}`), ms: timingsMs.read });
    if (gated.length) steps[steps.length - 1].notes.push(...gated);
    if (!items.size) throw new Error(`no wall could be read (${[...readings.map(r => ('error' in r && r.error) || ''), ...gated].filter(Boolean).join('; ')})`);

    // a search-grounded reference for every wall the check still marks weak (references.ts): started now, awaited just
    // before the brief is written, so it runs alongside the build rather than adding its own time to the total
    // the building's name, from the POIs in or by its footprint and the request's own words (building-name.ts): the search
    // query for the references, and a block of the brief; the address stands in when nothing names it
    const names = decideBuildingNames({ parts: input.massing.parts.map(p => p.loops), pois: input.naming?.pois, query: input.naming?.query, address: input.naming?.address ?? input.place });
    const searchQuery = referenceQuery({ name: names.primary, address: input.place });
    if (names.primary) progress(`pipeline G: the building is named ${names.primary} (${names.names.find(n => n.name === names.primary)?.source === 'poi' ? 'a point of interest in its footprint' : 'the request'}); references search by "${searchQuery}"`);
    const tRef = Date.now();
    const referencesFit = left() >= BUDGET_RESERVE_MS + BUDGET_TEXTURE_MS;
    if (input.references && !referencesFit) budgetNotes.push(`weak-wall references not fetched (${Math.round(Math.max(0, left()) / 1000)} s of the budget left)`);
    const referencesPromise: Promise<WeakWallReference[]> = input.references && referencesFit
        ? weakWallReferences({
            client: input.references.client, query: searchQuery, models: input.references.models, outputDir: input.references.outputDir,
            signal: input.signal, plates: readable.map(pl => ({ face: surveyFaces[pl.face], check: (readings.find(r => r.pl.key === pl.key) as { check?: ReadingCheck } | undefined)?.check }))
        })
        : Promise.resolve([]);

    // what was read on a grouped facade laid back onto its walls (facades.ts); a wall read on its own keeps its reading
    const built = new Map<string, ProgramItems>();
    const dropped: string[] = [];
    for (const [key, it] of items) {
        const group = grouping.groups.find(g => g.face.key === key);
        if (!group) { built.set(key, it); continue; }
        const laid = layBack(group, it);
        for (const [k, v] of laid.byMember) built.set(k, v);
        dropped.push(...laid.droppedOpenings);
    }
    // continued (generated) openings that overlap another opening on their wall, or lie past its ends, are not sent to
    // the native tool (policy.dedupeContinued): on the Flatiron 583 of 678 openings were rejected there, unexplained
    const deduped: string[] = [];
    if (policy.dedupeContinued) {
        for (const [key, it] of built) {
            const d = dedupeContinuedOpenings(it, input.run.report.faces.find(f => f.key === key));
            deduped.push(...d.dropped);
            if (d.dropped.length && policy.ledger) ledger.push({ decision: `continuation:${key}`, chosen: `${it.openings.filter(o => o.provenance === 'generated').length} continued openings built`, why: `${d.dropped.length} dropped: past the wall's ends or over another opening`, sources: [{ source: 'continuation', value: `${it.counts.filledOpenings} continued`, used: true }] });
        }
    }

    // 4. build
    t = Date.now();
    progress(`${tag}: building the facades natively on the massing`);
    const openings = [...built.values()].flatMap(x => x.openings);
    const faceSweeps = [...built.values()].flatMap(x => x.faceSweeps);
    // what stands on the roof, built from what the scan measures there (roof-objects.ts)
    let roofParts: Massing['parts'] = [];
    let roofObjectRecords: RoofObject[] = [];
    if (input.roofObjectsGiven) {
        steps.push({ step: 'roof objects', proposed: input.roofObjectsGiven.length, accepted: input.roofObjectsGiven.length, rejected: 0, notes: ['part of the scan-led massing (outlines from the photo straight down, heights from the scan)', ...input.roofObjectsGiven], ms: 0 });
    } else try {
        const ro = await roofObjects(input.run, input.massing.parts, { groundY: input.structure.groundY, dir: input.dir, ...(input.signal ? { signal: input.signal } : {}) });
        roofParts = ro.parts;
        roofObjectRecords = ro.objects;
        steps.push({ step: 'roof objects', proposed: ro.audit?.clusters.length ?? 0, accepted: ro.parts.length, rejected: (ro.audit?.clusters.length ?? 0) - ro.parts.length, notes: ro.notes, ms: Date.now() - t });
    } catch (err) {
        if (input.signal?.aborted) throw err;
        steps.push({ step: 'roof objects', proposed: 0, accepted: 0, rejected: 0, skipped: `the residual audit failed (${err instanceof Error ? err.message : String(err)}); the roof stays flat`, notes: [], ms: Date.now() - t });
    }
    const buildDir = path.join(input.dir, 'build');
    const run = await runMassing(massingSpecText({ ...input.massing, parts: [...input.massing.parts, ...roofParts] }, { outDir: buildDir, tile: input.tilePath, params: { ...G_BUILD_PARAMS }, openings, faceSweeps }), buildDir, { ...(input.signal ? { signal: input.signal } : {}) });
    timingsMs.build = Date.now() - t;
    const c = [...built.values()].reduce((a, x) => ({ o: a.o + x.counts.openings, fo: a.fo + x.counts.filledOpenings, h: a.h + x.counts.horizontal, v: a.v + x.counts.vertical, fv: a.fv + x.counts.filledVertical, pn: a.pn + x.counts.paned, sl: a.sl + x.counts.sills, sr: a.sr + x.counts.surrounds }), { o: 0, fo: 0, h: 0, v: 0, fv: 0, pn: 0, sl: 0, sr: 0 });
    // the native tool's rejections: by reason (policy.rejectionReasons, from the tool's rejectedOpeningReasons) or by id
    const byReason = rejectionsByReason(run.report);
    const rejectionNotes = policy.rejectionReasons
        ? [...byReason.entries()].sort((a, b) => b[1] - a[1]).map(([why, n]) => `${n} opening${n === 1 ? '' : 's'} rejected by the native tool: ${why}`)
        : run.report.rejectedOpenings.map(id => `opening ${id} rejected by the native tool`);
    if (policy.ledger && run.report.rejectedOpenings.length) ledger.push({ decision: 'rejections', chosen: `${openings.length - run.report.rejectedOpenings.length} of ${openings.length} openings built`, why: [...byReason.entries()].map(([w, n]) => `${n}: ${w}`).join('; '), sources: [...byReason.entries()].map(([w, n]) => ({ source: 'native', value: `${n} ${w}`, used: false })) });
    steps.push({ step: 'native build', proposed: openings.length + faceSweeps.length, accepted: openings.length + faceSweeps.length - run.report.rejectedOpenings.length - run.report.rejectedSweeps.length, rejected: run.report.rejectedOpenings.length + run.report.rejectedSweeps.length, notes: [`${c.o} openings (${c.fo} continued into unseen parts; ${c.pn} with divided glazing, ${c.sl} with sills, ${c.sr} with surrounds), ${c.h} horizontal profiles, ${c.v} vertical members (${c.fv} continued)`, ...rejectionNotes, ...(deduped.length ? [`${deduped.length} continued openings not sent to the native tool: ${deduped.slice(0, 6).join('; ')}${deduped.length > 6 ? '; ...' : ''}`] : []), ...(dropped.length ? [`${dropped.length} openings read on a grouped facade lay across walls and were not built (${dropped.slice(0, 8).join(', ')}${dropped.length > 8 ? ', ...' : ''})`] : [])], ms: timingsMs.build });

    // 5. paint
    t = Date.now();
    const walls = [...items.values()].map(x => x.wallColour);
    const fallback: [number, number, number] = [0, 1, 2].map(k => Math.round(median(walls.map(w => w[k])))) as [number, number, number];
    // each face nobody read in its own colour, measured on pipeline E's bake of it (not the read walls' median)
    const measured = new Map<string, [number, number, number]>();
    for (const f of input.run.report.faces) if (f.kind !== 'base' && f.width > 0 && f.height > 0) { const c = measuredFaceColour(input.run.dir, f); if (c) measured.set(f.key, c); }
    const textures = paintFaces(run.report.faces, built, fallback, measured);
    const legend = gLegend();
    timingsMs.paint = Date.now() - t;
    steps.push({ step: 'paint', proposed: textures.size, accepted: textures.size, rejected: 0, notes: [`${[...built.keys()].length} walls painted from their own reading or their facade's; of the other ${textures.size - built.size} faces, ${[...textures.values()].filter(x => x.source[0] === G_SRC.measured).length} in the colour measured on their own bake of the tile photo, the rest the read walls' median colour (generated)`], ms: timingsMs.paint });

    // 6. facade textures: each read wall's survey plate redrawn by the facade texture builder, over its paint where accepted
    const enhanced: EnhanceWallRecord[] = [];
    const texturesFit = left() >= BUDGET_RESERVE_MS + BUDGET_TEXTURE_MS;
    if (input.enhance && !texturesFit) {
        budgetNotes.push(`facade and roof textures not drawn (${Math.round(Math.max(0, left()) / 1000)} s of the budget left, ${(BUDGET_RESERVE_MS + BUDGET_TEXTURE_MS) / 1000} s needed): the walls keep their painted colours`);
        steps.push({ step: 'facade textures', proposed: 0, accepted: 0, rejected: 0, skipped: budgetNotes[budgetNotes.length - 1], notes: [], ms: 0 });
    }
    if (input.enhance && texturesFit) {
        t = Date.now();
        const e = input.enhance;
        const step: StepRecord = { step: 'facade textures', proposed: 0, accepted: 0, rejected: 0, notes: [], ms: 0 };
        const plateOf = (f: MassingFace) => plates.find(p => p.key === f.key || f.key.startsWith(p.key + ':') || p.key === grouping.groupOf.get(f.key));
        // the same lookup paintFaces used, so the geometry alignment below targets exactly the openings this wall was painted with
        const ownOf = (f: MassingFace) => built.get(f.key) ?? [...built.entries()].find(([k]) => f.key.startsWith(k + ':'))?.[1];
        const walls = run.report.faces.filter(f => f.kind === 'wall' && textures.has(f.index) && plateOf(f) && items.has(plateOf(f)!.key)).sort((a, b) => b.area - a.area);
        const done: FaceTexture[] = [];
        // the Street View photos of the structure, once: each wall's best is its street-level reference
        let guide: GuideView[] = [], noGuide: string | undefined = e.streetViews ? undefined : 'no Street View source';
        if (e.streetViews) {
            progress(`${tag}: surveying the facades with Street View`);
            try {
                let timer: ReturnType<typeof setTimeout> | undefined;
                const late = new Promise<'late'>(res => { timer = setTimeout(() => res('late'), G_STREET_VIEW_WAIT_MS); });
                const got = await Promise.race([streetViews!, late]).finally(() => clearTimeout(timer));
                if (got === 'late') noGuide = `the Street View survey had not finished ${Math.round((Date.now() - surveyStarted) / 1000)} s after it started (waited ${G_STREET_VIEW_WAIT_MS / 1000} s at the walls)`;
                else { guide = got; if (!guide.length) noGuide = 'no Street View photo of the structure'; }
            } catch (err) {
                if (input.signal?.aborted) throw err;
                noGuide = `the Street View survey failed (${(err as Error).message.slice(0, 160)})`;
            }
            const clean = guide.filter(v => v.cleanImage).length;
            step.notes.push(`Street View: ${guide.length} registered view(s), ${clean} with an obstruction-free copy${noGuide ? ` (${noGuide})` : ''}`);
        }
        const one = async (f: MassingFace) => {
            const pl = plateOf(f)!;
            const on = plateOntoFace(f, textures.get(f.index)!, pl, surveyFaces[pl.face]);
            if (!on) return;
            // the plate's own geometric reprojection can still drift from the wall's built openings (eg. a station's pose a
            // little off): a small corrective shift against what the wall itself was actually opened at, before the facade
            // texture builder sees it (so its reference crop and the quality score both judge the corrected texture)
            const ownOpenings = ownOf(f)?.openings ?? [];
            let geometryAlign: EnhanceWallRecord['geometryAlign'];
            if (ownOpenings.length) {
                const align = alignTextureToOpenings(on.tex.rgba, on.tex.width, on.tex.height, on.use, ownOpenings, f, f.pixel);
                if (align.dx || align.dy) on.tex.rgba = align.aligned;
                geometryAlign = { dx: align.dx, dy: align.dy, chamferPx: align.chamferPx, coveredOpenings: align.coveredOpenings, why: align.why };
            }
            let sv: WallStreetView | undefined, noSv = noGuide;
            if (guide.length) {
                const best = bestStreetViewForWall(f, guide);
                if (best.view && best.rect) sv = { view: best.view, rect: best.rect, crop: wallReference(f, best.view, best.rect, on.tex.width, on.tex.height), why: `${best.why}; ${best.view.cleanImage ? 'its obstruction-free copy (occluders filled, labelled generated)' : 'as captured (no obstruction-free copy)'}` };
                else noSv = best.why;
            }
            progress(`${tag}: drawing the facade texture of wall ${f.index} (${Math.round(f.area)} m2)${sv ? `, guided by Street View ${sv.view.panoId}${sv.view.cleanImage ? ' (obstruction-free copy)' : ''}` : ''}`);
            const r = await buildFacadeTexture(f, on.tex, on.use, {
                ...(sv ? { streetView: sv, streetViewGuide: true } : {}), ...(noSv ? { noStreetView: noSv } : {}),
                client: e.client, models: e.models, locationName: input.place, source: G_SRC.enhanced,
                // a survey plate is the melted tile: the region audit reads its blobs as elements the redraw erased, so G keeps the
                // identity gate and lets the quality score (with infill of what it faults) judge the texture itself
                guards: false,
                ...(done[0] ? { reference: done[0] } : {}), ...(e.cacheDir ? { cacheDir: e.cacheDir } : {}),
                counter: visionFacadeCounter(input.chain as VisionModelChain<string>), ...(input.signal ? { signal: input.signal } : {}),
                ...(e.infill ? { infill: e.infill } : {}), ...(e.unseenModels ? { unseenModels: e.unseenModels } : {}), quality: true,
                // what no station saw of the wall itself is drawn as the wall continues (never the melt)
                // sent as a fill feathered in: never as grey holes, whose outlines the model paints, nor flat paint, which it keeps flat
                // the median of the storey row's bays at the same place in the bay, the painted reading where too few bays vote;
                // the street band is the painted reading (its read shopfront openings), described to the model as the street
                // level to draw (the median of its melted clutter came back as rows of odd panels)
                unseen: { source: G_SRC.enhanced, fill: repeatFill(on.tex.rgba, on.use, on.tex.width, on.tex.height, f.pixel, textures.get(f.index)!.rgba) }, openings: on.openings,
                streetBandM: STREET_CLUTTER_M
            });
            step.proposed++;
            enhanced.push({ ...r, plate: undefined, guarded: undefined, labels: undefined, grid: undefined, ...(geometryAlign ? { geometryAlign } : {}) } as EnhanceWallRecord);
            if (r.accepted) { step.accepted++; textures.set(f.index, on.tex); done.push(on.tex); }
            else step.rejected++;
            step.notes.push(`wall ${f.index}: ${r.accepted ? 'textured' : 'keeps its painted colours'}: ${r.why}${r.model ? ` (${r.model})` : ''}${sv ? `; Street View reference: ${sv.why}` : noSv ? `; no Street View reference (${noSv})` : ''}`);
        };
        // the largest wall alone, then ENHANCE_CONCURRENCY at a time, each referencing the first finished wall; under a
        // budget, no further round starts with less than a texture's time left
        for (let k = 0; k < walls.length;) {
            if (left() < BUDGET_RESERVE_MS + BUDGET_TEXTURE_MS) { budgetNotes.push(`${walls.length - k} facade texture(s) not drawn (${Math.round(Math.max(0, left()) / 1000)} s of the budget left)`); step.notes.push(budgetNotes[budgetNotes.length - 1]); break; }
            const round = walls.slice(k, k === 0 ? 1 : k + ENHANCE_CONCURRENCY);
            k += round.length;
            await Promise.all(round.map(one));
        }
        step.ms = timingsMs.facadeTextures = Date.now() - t;
        steps.push(step);
    }

    // 7. the roof's texture: each roof face of the massing redrawn from its plate (roof-texture.ts)
    const roofRecords: RoofTextureRecord[] = [];
    if (input.enhance && roofPlates.length && left() >= BUDGET_RESERVE_MS + BUDGET_TEXTURE_MS) {
        t = Date.now();
        const e = input.enhance;
        const skippedRoofs: string[] = [];
        // largest first; under a budget, no redraw starts without a texture's time left (the scan-led massing's roof objects
        // are surveyed parts with plates of their own: redrawn one by one they overran the stage's limit)
        for (const f of run.report.faces.filter(x => x.kind === 'roof' && x.normal[1] > 0.3).sort((a, b) => b.area - a.area)) {
            if (f.area < ROOF_REDRAW_MIN_M2) { skippedRoofs.push(`${f.key}: under ${ROOF_REDRAW_MIN_M2} m2 (an object's top), keeps its painted colour`); continue; }
            if (left() < BUDGET_RESERVE_MS + BUDGET_TEXTURE_MS) { budgetNotes.push(`roof textures stopped (${Math.round(Math.max(0, left()) / 1000)} s of the budget left)`); skippedRoofs.push(`${f.key}: ${budgetNotes[budgetNotes.length - 1]}`); break; }
            const pl = roofPlates.find(p => p.key === f.key || f.key.startsWith(p.key + ':'));
            // a roof object's own top has no plate (they are parts added after the survey): it keeps its paint, unsaid
            if (!pl) { if (!f.part.startsWith('roof-object-')) skippedRoofs.push(`${f.key}: no plate`); continue; }
            if (!textures.has(f.index)) { skippedRoofs.push(`${f.key}: not painted`); continue; }
            if (pl.coverage <= 0) { skippedRoofs.push(`${f.key}: its plate saw none of it`); continue; }
            const on = plateOntoFace(f, textures.get(f.index)!, pl, surveyFaces[pl.face]);
            if (!on) { skippedRoofs.push(`${f.key}: none of its plate lands on the built roof (what the plate saw stands off it, or outside it)`); continue; }
            progress(`${tag}: drawing the roof texture (${Math.round(f.area)} m2)`);
            try {
                roofRecords.push(await redrawRoof(f, textures.get(f.index)!, on, { client: e.client, locationName: input.place, source: G_SRC.roof, ...(e.cacheDir ? { cacheDir: e.cacheDir } : {}), ...(input.signal ? { signal: input.signal } : {}) }));
            } catch (err) {
                if (input.signal?.aborted) throw err;
                roofRecords.push({ face: f.index, accepted: false, why: `the redraw failed (${err instanceof Error ? err.message : String(err)}): the roof keeps its painted colour`, covered: on.covered });
            }
        }
        timingsMs.roofTexture = Date.now() - t;
        steps.push({ step: 'roof texture', proposed: roofRecords.length, accepted: roofRecords.filter(r => r.accepted).length, rejected: roofRecords.filter(r => !r.accepted).length, notes: [...roofRecords.map(r => `roof ${r.face}: ${r.why}${r.model ? ` (${r.model})` : ''}`), ...skippedRoofs.map(s => `not redrawn: ${s}`)], ms: timingsMs.roofTexture });
    }
    const files = writeMassingLayer(run, input.massing, textures, legend, input.dir, input.stage, input.stageKey, 'pipeline_g');

    // the weak-wall references (started right after the facade reading step) joined here, alongside everything else
    const references = await referencesPromise;
    if (input.references) {
        const got = references.reduce((a, r) => a + r.references.length, 0);
        steps.push({
            step: 'weak-wall references', proposed: references.length, accepted: references.filter(r => r.references.length > 0).length, rejected: references.filter(r => !r.references.length).length,
            notes: references.length ? references.map(r => r.skipped ? `${r.face}: not fetched (${r.skipped})` : `${r.face}: ${r.references.length} reference${r.references.length === 1 ? '' : 's'} (${r.references.map(x => x.model).join(', ')})`) : ['no wall was still weak after its reading'],
            ms: Date.now() - tRef
        });
        if (got) progress(`${tag}: ${got} search-grounded reference${got === 1 ? '' : 's'} of ${references.filter(r => r.references.length).length} weak wall${references.filter(r => r.references.length).length === 1 ? '' : 's'}`);
    }
    const referencesByFace = new Map(references.map(r => [r.face, r.references]));

    // the building brief beside the build (brief.ts): what the next tool, script or person works from
    let brief: BuildingBriefRecord | { error: string };
    try {
        brief = writeBuildingBrief({
            dir: briefDir, ...(input.publicDir ? { publicDir: input.publicDir } : {}), place: input.place, groundY: input.structure.groundY,
            names, nearbyPois: (input.naming?.pois ?? []).map(p => ({ ...p, distanceM: footprintDistanceM(p.x, p.z, input.massing.parts.map(q => q.loops)) })).filter(p => p.distanceM <= BRIEF_NEARBY_POI_M).sort((a, b) => a.distanceM - b.distanceM),
            massing: { parts: [...input.massing.parts, ...roofParts] }, roofObjects: roofObjectRecords,
            builtFaces: run.report.faces, facades: grouping.groups,
            stations: [...plan.stations, ...roofStationList.map(r => ({ station: r.station, face: r.faces[0] ?? -1, row: 'aerial' as const, distanceM: 0, onFace: 0 }))],
            renders: [...wallRenders, ...roofRenders],
            plates: plates.map(pl => {
                const rd = readings.find(x => x.pl.key === pl.key);
                const refs = referencesByFace.get(pl.key);
                return {
                    key: pl.key, face: surveyFaces[pl.face], coverage: pl.coverage, widthM: pl.widthM, heightM: pl.heightM,
                    colour: path.join(input.dir, 'plates', `face_${pl.face}_colour.png`), relief: path.join(input.dir, 'plates', `face_${pl.face}_relief.png`),
                    ...(rd && 'program' in rd && rd.program ? { program: rd.program } : {}), ...(rd && 'check' in rd && rd.check ? { check: rd.check } : {}),
                    ...(refs?.length ? { references: refs.map(r => ({ model: r.model, image: r.path, account: r.account, queries: r.queries, sources: r.sources, query: searchQuery })) } : {})
                };
            }),
            roofPlates: roofPlates.map(p => ({ key: p.key, coverage: p.coverage, colour: path.join(input.dir, 'plates', `roof_${p.face}_colour.png`) })),
            files, steps, ...(policy.ledger ? { ledger } : {})
        });
    } catch (err) {
        brief = { error: err instanceof Error ? err.message : String(err) };
    }

    if (budgetNotes.length) steps.push({ step: 'budget', proposed: budgetNotes.length, accepted: 0, rejected: budgetNotes.length, notes: budgetNotes, ms: Date.now() - tStart });
    return {
        files, run, steps, legend, grammars: [], timingsMs, enhanced, brief, names, ledger, budgetNotes,
        build: { parts: [...input.massing.parts, ...roofParts], sweeps: [], openings },
        textures, occluderMasks: new Map(),
        plates: plates.map(p => {
            const r = readings.find(x => x.pl.key === p.key);
            return { face: p.key, coverage: +p.coverage.toFixed(3), read: items.has(p.key), ...(r && 'model' in r ? { model: r.model, notes: r.program?.notes } : {}), ...(items.get(p.key) ? { counts: items.get(p.key)!.counts } : {}), ...(r && 'check' in r && r.check ? { check: r.check } : {}), ...(r && 'reread' in r && r.reread ? { reread: r.reread.kept } : {}) };
        }),
        stations: { kept: plan.stations.length, dropped: plan.dropped.length, candidates: plan.candidates, skipped: plan.skipped }
    };
}
