/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * location_isolate_structure: the staged-location build's structure isolation, on its own, as one tool call.
 *
 * It runs exactly the isolation path google_3d_tiles_get_clay runs with isolate (orchestrator.ts, tiles and remesh
 * stages), through the same functions and the same caches, and stops there:
 *
 *  1. the place (the staged geocode cache, or the coordinates as given);
 *  2. the request-sized leaf-LOD extraction and the structure pick (`sizeExtraction` / `pickStructure`,
 *     extraction-sizing.ts): the Google vector building footprint as a prior, the walkable street surface as the ground,
 *     the tile_vegetation canopy mask; the containment rounds and their district fallbacks;
 *  3. the trees measured in the photo tiles taken out around the structure (tile_vegetation strip), and the pick made
 *     again on that scan (`pickOnScan`), so the footprint tile_refine isolates holds no crown;
 *  4. tile_refine's isolate on the shared pick (`--isolate-pick`, SBIP v1), with the multi-view mask vote
 *     (ownership-masks.ts, scratchbox_mask_vote.hpp) when a vision model is configured;
 *  5. `checkIsolate`: when what tile_refine isolated is not the structure picked, the district around it is remeshed
 *     whole and returned instead (isolate_mismatch), never the fragments.
 *
 * The picker's behaviour is not changed here: this module only calls it and reads what it returns. It adds the
 * accounting the result reports (the footprint traced as a polygon, what was kept and what was removed around it and
 * why, the rooftop canopy kept as scanned) from the pick, the ground model, tile_vegetation's crown records and
 * tile_refine's own statistics.
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import type { ToolContext, ToolDeclaration, ToolHandler, ToolHandlerOutcome, ToolResultPayload } from '../types';
import { MissingInputError } from '../../../../common/errors/pipeline-errors';
import { TILE_REFINE_RELIEF_DEFAULT, type CanopyMask, type Vec2 } from '../../../../common/spatial/staged-location-contracts';
import { LocalTangentPlane } from '../../../../common/coordinate/LocalTangentPlane';
import type { CanvasArtifact } from '../../../../browser/generative-canvas/canvas-types';
import { VisionModelChain } from '../../vision-model-chain';
import type { TileRefineRequest, TileRefineResult } from '../../../3d-engine/tile-refine-service';
import type { TileVegetationStripResult } from '../../../3d-engine/tile-vegetation-service';
import type { GroundModel } from '../../../spatial/StreetViewSurveyPlanner';
import {
    checkIsolate, grownOutline, pickOnScan, sizeExtraction, writeIsolationPick,
    FOOTPRINT_TOLERANCE_M, ISOLATE_PRECISION_MIN, ISOLATE_RECALL_MIN, ISOLATE_ROOFED_MIN,
    PICK_CANOPY, PICK_LOW_ATTACHMENT, PICK_STRUCTURE, STRUCTURE_MIN_HEIGHT_M,
    type IsolateCheck, type SizingNote, type StructurePickResult
} from '../../../3d-engine/staged-location/extraction-sizing';
import { segmentOwnershipViews } from '../../../3d-engine/staged-location/ownership-masks';
import { evidenceLookup, type EvidenceLookup } from '../../../3d-engine/staged-location/vector-footprints';
import { stageKey, stagedReplyCache, stagedWorkspaceRoot, type PublishedFile, type StageCache } from '../../../3d-engine/staged-location/stage-cache';
import {
    EXTRACTION_TTL_MS, GEOCODE_TTL_MS, ISOLATE_TREE_REACH_M, VISION_HEDGE_AFTER_MS,
    type ResolvedPlace, type StagedExtraction, type StagedLocationDeps
} from '../../../3d-engine/staged-location/orchestrator';
import { createStagedLocationDeps } from '../../../3d-engine/staged-location/staged-location-tool';
import { glbBounds } from '../../../3d-engine/staged-location/staged-artifact';

export const ISOLATE_STRUCTURE_TOOL = 'location_isolate_structure';

// ----------------------------------------------------------------------------------------------------------------
// the declaration
// ----------------------------------------------------------------------------------------------------------------

export const ISOLATE_STRUCTURE_TOOL_DECLARATION: ToolDeclaration = {
    name: ISOLATE_STRUCTURE_TOOL,
    description:
        'Isolate one real-world structure (a building, a church, a bridge, a monument) from Google Photorealistic 3D Tiles at leaf LOD and return it whole, ' +
        'as a photo-textured GLB and a studio clay GLB, with how it was decided. Runs the staged-location isolation and nothing after it (no rebuild, no ' +
        'Street View, no regrown trees): the extraction is sized until the structure is contained; the footprint is the Google vector building footprint ' +
        'under the place when the scan agrees with it, else the scan geometry alone; the ground is the walkable street surface; tile_refine isolates ' +
        'exactly that footprint; when a vision model is configured, a multi-view mask vote decides which raised triangles belong to the structure. ' +
        'Returns the footprint polygon (tile frame and lat/lng) and area, the footprint source (vector-footprint, scan-geometry or mask-vote) and its IoU ' +
        'with the scan, the ground height and how it was measured, the areas kept and removed around it with the reason for each, and rooftop canopy kept as ' +
        'scanned. It never returns fragments: when the structure cannot be contained (outcome containment_failed), when no structure stands at the place, ' +
        'or when the isolate does not match the pick (outcome district_fallback), it returns the district around it, remeshed whole, with the reason. ' +
        'Reuses the staged-location caches, so a place already built with google_3d_tiles_get_clay comes back quickly. Mounts the result in the viewport.',
    parameters: {
        type: 'OBJECT',
        properties: {
            query: { type: 'STRING', description: 'The place: a name or an address (e.g. "Puck Building, 295 Lafayette St, New York"). Optional when lat and lng are given (then it only labels the result).' },
            lat: { type: 'NUMBER', description: 'Latitude of the structure (WGS-84). Give with lng to skip geocoding.' },
            lng: { type: 'NUMBER', description: 'Longitude of the structure (WGS-84). Give with lat.' },
            target: { type: 'STRING', description: 'Optional: what to isolate, in words (e.g. "the red-brick church with the steeple"). Given to the vision model that outlines the structure for the mask vote; default the query.' },
            trees: { type: 'BOOLEAN', description: 'Take the trees measured in the photo tiles out around the structure before isolating it (default true), so no crown joins it. Rooftop canopy whose roof the scan replaced is kept as scanned either way.' },
            relief: { type: 'BOOLEAN', description: 'tile_refine photometric facade relief on the isolated structure (default true, the staged build\'s setting, so its cache is shared). Relief depths are photo-inferred and labelled.' }
        }
    }
};

// ----------------------------------------------------------------------------------------------------------------
// request, dependencies, result
// ----------------------------------------------------------------------------------------------------------------

export interface IsolateStructureRequest {
    /** The place as asked (or the coordinates, as text). */
    query: string;
    /** Coordinates given by the caller: used as given, nothing is geocoded. */
    place?: ResolvedPlace;
    /** What the vision model outlines for the mask vote. */
    target: string;
    trees: boolean;
    relief: boolean;
}

/** The staged build's own dependencies this tool uses (createStagedLocationDeps wires them to the app's services). */
export interface IsolateStructureDeps {
    cache: StageCache;
    geocode: StagedLocationDeps['geocode'];
    extract: StagedLocationDeps['extract'];
    vegetation?: { strip?: StagedLocationDeps['vegetation']['strip']; canopy?: StagedLocationDeps['vegetation']['canopy'] };
    vectorEvidence?: StagedLocationDeps['vectorEvidence'];
    refine: StagedLocationDeps['refine'];
    vision?: StagedLocationDeps['vision'];
    now?: () => number;
    sleep?: (ms: number) => Promise<void>;
}

export interface IsolateStructureContext {
    signal?: AbortSignal;
    reportProgress?: (message: string, fraction?: number) => void;
}

/** isolated: the structure alone. containment_failed / district_fallback: the district around it, whole, with the reason. */
export type IsolateOutcome = 'isolated' | 'containment_failed' | 'district_fallback' | 'failed';

export type FootprintSource = 'vector-footprint' | 'scan-geometry' | 'mask-vote' | (string & {});

export interface AreaRecord {
    part: string;
    areaM2: number;
    /** plan: footprint area on the ground (1 m cells); surface: area of the triangles themselves (walls included). */
    areaKind: 'plan' | 'surface';
    reasonCode: string;
    reason: string;
    /** Further measurements of the part (heights, triangle counts, positions). */
    detail?: Record<string, unknown>;
}

export interface RooftopCanopyRecord {
    crownId: number;
    stem: [number, number];
    apexY: number;
    areaM2: number;
    reasonCode: string;
    reason: string;
}

export interface GlbOutput { path: string; url: string; bytes: number }

export interface IsolateStructureResult {
    schema: 'scratchbox.isolate-structure/1';
    outcome: IsolateOutcome;
    /** Why the outcome is not `isolated` (containment_failed, no_structure_at_anchor, district_extract_failed, isolate_mismatch, remesh_failed). */
    reasonCode?: string;
    reason?: string;
    place: { query: string; resolvedAddress: string; lat: number; lng: number; geocoded: boolean; cached: boolean };
    target: string;
    extraction: { radiusM: number; rounds: number; leafTiles: number; coveredRadiusM: number; rawGlbPath: string; cached: boolean; originEllipsoidalHeightM: number };
    /** The isolated structure (outcome isolated only). */
    structure?: {
        texturedGlb: GlbOutput;
        clayGlb: GlbOutput;
        /** The isolated scan before the remesh, as clay. */
        rawClayGlb?: GlbOutput;
        seed: { x: number; z: number };
        geocodeToStructureM: number;
        heightM: number;
        facadeHeadingsDeg: number[];
    };
    /** The district shown instead (every outcome but isolated). */
    district?: { clayGlb?: GlbOutput; texturedGlb?: GlbOutput; rawGlbPath: string; remeshError?: string };
    footprint?: {
        source: FootprintSource;
        /** The pick's own source (the mask vote refines it): vector-footprint or scan-geometry. */
        pickSource: string;
        /** Traced outline of the footprint's cells, tile frame (x east, z south, metres from the geocoded point). */
        polygon: Vec2[];
        holes: Vec2[][];
        polygonLatLng: Array<[number, number]>;
        convexOutline: Vec2[];
        areaM2: number;
        /**
         * Agreement with the scan: for a vector footprint, the IoU of the footprint with the scan's raised cells picked
         * by it; for the scan geometry and the mask vote, the IoU of the pick with the structure tile_refine isolated.
         */
        iouWithScan: number;
        vectorFootprint?: { used: boolean; featureIds: string[]; areaM2: number; raisedShare: number; iou: number; reason?: string; polygon?: Vec2[][] };
        maskVote?: { ran: boolean; reason: string; votingViews?: number; views?: number; joinedTriangles?: number; leftTriangles?: number; model?: string };
        isolateCheck?: { iou: number; precision: number; recall: number; roofed: number; holdsSeed: boolean; isolatedAreaM2: number; ok: boolean };
    };
    ground?: {
        /** Ground height at the structure, scan frame y (metres above the geocoded point's ellipsoidal height). */
        heightM: number;
        ellipsoidalHeightM: number;
        source: 'walkable-surface' | 'low-percentile' | (string & {});
        roadsFromVectorData: boolean;
        walkableAreaM2?: number;
        /** tile_refine's own ground under the footprint. */
        isolateGroundY?: number;
        reason: string;
    };
    kept: AreaRecord[];
    removed: AreaRecord[];
    rooftopCanopyKeptAsScanned: RooftopCanopyRecord[];
    notes: string[];
    timingsMs: Record<string, number>;
    digest: string;
}

// ----------------------------------------------------------------------------------------------------------------
// arguments
// ----------------------------------------------------------------------------------------------------------------

function asString(v: unknown): string {
    return typeof v === 'string' ? v.trim() : '';
}

function asNumber(v: unknown): number | undefined {
    if (v === undefined || v === null || v === '') return undefined;
    const n = Number(v);
    return Number.isFinite(n) ? n : NaN;
}

export function parseIsolateStructureArgs(args: Record<string, unknown>): IsolateStructureRequest {
    const query = asString(args.query);
    const lat = asNumber(args.lat), lng = asNumber(args.lng);
    let place: ResolvedPlace | undefined;
    if (lat !== undefined || lng !== undefined) {
        if (lat === undefined || lng === undefined || !Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
            throw new MissingInputError(ISOLATE_STRUCTURE_TOOL, 'both lat and lng as finite WGS-84 degrees', `got lat ${JSON.stringify(args.lat)}, lng ${JSON.stringify(args.lng)}`);
        }
        place = { lat, lng, formattedAddress: query || `${lat.toFixed(6)}, ${lng.toFixed(6)}` };
    }
    if (!query && !place) throw new MissingInputError(ISOLATE_STRUCTURE_TOOL, 'query, or lat and lng', 'a place name, an address or coordinates');
    const label = query || place!.formattedAddress;
    return { query: label, ...(place ? { place } : {}), target: asString(args.target) || label, trees: args.trees !== false, relief: typeof args.relief === 'boolean' ? args.relief : TILE_REFINE_RELIEF_DEFAULT };
}

// ----------------------------------------------------------------------------------------------------------------
// geometry accounting (reads the pick; never changes it)
// ----------------------------------------------------------------------------------------------------------------

/**
 * The outline of the cells set in `mask` (one 4-connected region and its holes), traced along cell edges and with
 * collinear corners dropped, in the grid's frame. The outer ring is the one of largest area; holes are the rest.
 */
export function traceCells(mask: Uint8Array, g: { x0: number; z0: number; nx: number; nz: number; cellMeters: number }): { outer: Vec2[]; holes: Vec2[][]; areaM2: number } {
    const { nx, nz, cellMeters: cell } = g;
    const on = (i: number, k: number) => i >= 0 && k >= 0 && i < nx && k < nz && mask[k * nx + i] === 1;
    // directed boundary edges, each cell's boundary walked (i,k) -> (i,k+1) -> (i+1,k+1) -> (i+1,k)
    const next = new Map<number, number[]>();
    const vid = (i: number, k: number) => k * (nx + 1) + i;
    const add = (a: number, b: number) => { const l = next.get(a); if (l) l.push(b); else next.set(a, [b]); };
    let cells = 0;
    for (let k = 0; k < nz; k++) for (let i = 0; i < nx; i++) {
        if (!on(i, k)) continue;
        cells++;
        if (!on(i - 1, k)) add(vid(i, k), vid(i, k + 1));
        if (!on(i, k + 1)) add(vid(i, k + 1), vid(i + 1, k + 1));
        if (!on(i + 1, k)) add(vid(i + 1, k + 1), vid(i + 1, k));
        if (!on(i, k - 1)) add(vid(i + 1, k), vid(i, k));
    }
    const rings: Array<{ pts: Vec2[]; area: number }> = [];
    for (const [start, outs] of next) {
        while (outs.length) {
            const ring: number[] = [start];
            let cur = outs.pop()!;
            while (cur !== start) {
                ring.push(cur);
                const l = next.get(cur);
                if (!l || !l.length) break;
                cur = l.pop()!;
            }
            // drop collinear corners
            const xy = ring.map(v => [v % (nx + 1), Math.floor(v / (nx + 1))] as [number, number]);
            const keep: Vec2[] = [];
            for (let j = 0; j < xy.length; j++) {
                const p = xy[(j + xy.length - 1) % xy.length], q = xy[j], r = xy[(j + 1) % xy.length];
                if ((q[0] - p[0]) * (r[1] - q[1]) - (q[1] - p[1]) * (r[0] - q[0]) !== 0) keep.push([g.x0 + q[0] * cell, g.z0 + q[1] * cell]);
            }
            let a = 0;
            for (let j = 0; j < keep.length; j++) { const [x1, z1] = keep[j], [x2, z2] = keep[(j + 1) % keep.length]; a += x1 * z2 - x2 * z1; }
            if (keep.length >= 3) rings.push({ pts: keep, area: a / 2 });
        }
    }
    rings.sort((p, q) => Math.abs(q.area) - Math.abs(p.area));
    const round = (v: number) => Math.round(v * 1000) / 1000;
    const fix = (r: Vec2[]): Vec2[] => r.map(([x, z]) => [round(x), round(z)] as Vec2);
    return { outer: rings.length ? fix(rings[0].pts) : [], holes: rings.slice(1).map(r => fix(r.pts)), areaM2: cells * cell * cell };
}

/** Raised masses touching the structure that the pick left out, with why, largest contact first. */
export function adjacentMassesRemoved(pick: StructurePickResult, ground: GroundModel): AreaRecord[] {
    const { nx, nz, cellMeters: cell } = ground;
    const N = nx * nz;
    const above = (c: number) => ground.top[c] - ground.ground[c];
    const comp = Uint8Array.from(pick.footprintMask, s => (s === PICK_STRUCTURE ? 1 : 0));
    const free = (c: number) => !comp[c] && above(c) >= STRUCTURE_MIN_HEIGHT_M;
    const seen = new Uint8Array(N);
    const out: Array<AreaRecord & { contact: number }> = [];
    const nb = (c: number): number[] => {
        const i = c % nx, k = (c / nx) | 0, r: number[] = [];
        if (i > 0) r.push(c - 1); if (i < nx - 1) r.push(c + 1); if (k > 0) r.push(c - nx); if (k < nz - 1) r.push(c + nx);
        return r;
    };
    for (let s = 0; s < N; s++) {
        if (seen[s] || !free(s) || !nb(s).some(n => comp[n])) continue;
        let cells = 0, contact = 0, low = 0, hmax = 0;
        const st = [s];
        seen[s] = 1;
        while (st.length) {
            const c = st.pop()!;
            cells++;
            hmax = Math.max(hmax, above(c));
            if (pick.footprintMask[c] === PICK_LOW_ATTACHMENT) low++;
            for (const n of nb(c)) {
                if (comp[n]) contact++;
                else if (!seen[n] && free(n)) { seen[n] = 1; st.push(n); }
            }
        }
        const vf = pick.vectorFootprint;
        const lowAttachment = low * 2 >= cells;
        const reasonCode = lowAttachment ? 'low_attachment' : vf?.used ? 'outside_vector_footprint' : 'separate_mass';
        const reason = lowAttachment
            ? `a lower part attached to the structure (below its core height of ${pick.coreHeightM} m), left out as a low attachment`
            : vf?.used ? `raised scan beyond Google vector footprint ${vf.featureIds.join(', ')} grown by ${FOOTPRINT_TOLERANCE_M} m: the neighbouring building past the party wall`
            : `a raised mass the structure rule separates from it (a narrow neck the opening cuts, or a height step of more than 3 m between parts)`;
        out.push({ part: lowAttachment ? 'low attachment' : 'adjacent raised mass', areaKind: 'plan', areaM2: cells * cell * cell, reasonCode, reason, contact, detail: { contactM: contact * cell, maxHeightM: Math.round(hmax * 100) / 100 } });
    }
    return out.sort((a, b) => b.contact - a.contact).slice(0, 12).map(({ contact: _c, ...r }) => r);
}

/** Cells of `state` within `reachM` of the structure. */
function cellsNearStructure(pick: StructurePickResult, ground: GroundModel, state: number, reachM: number): number {
    const { nx, nz, cellMeters: cell } = ground;
    const r = Math.ceil(reachM / cell);
    let n = 0;
    for (let k = 0; k < nz; k++) for (let i = 0; i < nx; i++) {
        if (pick.footprintMask[k * nx + i] !== state) continue;
        search: for (let dk = -r; dk <= r; dk++) for (let di = -r; di <= r; di++) {
            const ii = i + di, kk = k + dk;
            if (ii >= 0 && kk >= 0 && ii < nx && kk < nz && di * di + dk * dk <= r * r && pick.footprintMask[kk * nx + ii] === PICK_STRUCTURE) { n++; break search; }
        }
    }
    return n * cell * cell;
}

/** The parts of tile_refine's stats.isolate (scratchbox_tile_refine.hpp) the accounting reads. */
interface IsolateStats {
    groundY?: number;
    apron_m?: number;
    groundPatch?: { triangles: number; area_m2: number };
    lowAttachment?: { coreHeight_m: number; cells: number; area_m2: number; trianglesDropped: number };
    interiorFloorsDropped?: number;
    belowGround?: { margin_m: number; clipY: number; dropped: number; cut: number };
    ownership?: {
        views?: number; votingViews?: number; joined?: number; left?: number; leftAsOrphans?: number; orphanPieces?: number;
        clusters?: Array<{ change: 'joined' | 'left'; triangles: number; area_m2: number; bearingFromAnchorDeg: number; distanceFromAnchor_m: number; aboveTerrain_m: [number, number] }>;
    };
}

interface CrownRecord { id: number; status: string; stem: [number, number]; apex: [number, number, number]; areaM2: number; ground?: { reasonCode: string; reason: string } }

function readCrowns(file: string | undefined): CrownRecord[] {
    if (!file || !fs.existsSync(file)) return [];
    try { return (JSON.parse(fs.readFileSync(file, 'utf8')).crowns ?? []) as CrownRecord[]; } catch { return []; }
}

function insidePolygon(p: Vec2, poly: Vec2[]): boolean {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
        const [xi, zi] = poly[i], [xj, zj] = poly[j];
        if ((zi > p[1]) !== (zj > p[1]) && p[0] < ((xj - xi) * (p[1] - zi)) / (zj - zi) + xi) inside = !inside;
    }
    return inside;
}

// ----------------------------------------------------------------------------------------------------------------
// the run
// ----------------------------------------------------------------------------------------------------------------

/** A place that cannot be resolved, or has no tile coverage: there is nothing real to return. */
export class IsolateStructureFailure extends Error {
    constructor(readonly code: 'place_unresolved' | 'no_tile_coverage' | (string & {}), message: string) {
        super(message);
        this.name = 'IsolateStructureFailure';
    }
}

function errorMessage(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}

function slug(text: string): string {
    return text.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40) || 'place';
}

const round3 = (v: number) => Math.round(v * 1000) / 1000;

function publish(cache: StageCache, file: string, name: string): GlbOutput {
    const p: PublishedFile = cache.publishFile(file, name);
    return { path: p.path, url: p.url, bytes: p.bytes };
}

export async function runIsolateStructure(request: IsolateStructureRequest, deps: IsolateStructureDeps, ctx: IsolateStructureContext = {}): Promise<IsolateStructureResult> {
    const now = deps.now ?? Date.now;
    const cache = deps.cache;
    const progress = (m: string, f?: number) => ctx.reportProgress?.(m, f);
    const timings: Record<string, number> = {};
    const notes: string[] = [];
    const kept: AreaRecord[] = [];
    const removed: AreaRecord[] = [];
    const rooftop: RooftopCanopyRecord[] = [];
    const t0 = now();
    const lap = (name: string, since: number) => { timings[name] = now() - since; };

    // ---------------- the place (the staged geocode cache) ----------------
    let place: ResolvedPlace, placeCached = false;
    let t = now();
    if (request.place) place = request.place;
    else {
        progress(`resolving ${request.query}`);
        const key = stageKey('geocode/v1', request.query.trim().toLowerCase().replace(/\s+/g, ' '));
        const hit = cache.get<ResolvedPlace>('resolve', key);
        if (hit && now() - hit.builtAtMs < GEOCODE_TTL_MS) { place = hit.value; placeCached = true; }
        else {
            try {
                place = (await cache.run('resolve', key, async () => ({ value: await deps.geocode(request.query, ctx.signal) }), { bypass: true })).value;
            } catch (err) {
                if (ctx.signal?.aborted) throw err;
                throw new IsolateStructureFailure('place_unresolved', `The place could not be resolved: ${errorMessage(err)}`);
            }
        }
    }
    lap('resolve', t);

    // ---------------- the extraction sized to the structure, and the pick (the staged extraction cache) ----------------
    let last: { key: string; cached: boolean } | undefined;
    const extractCached = async (radiusM: number): Promise<StagedExtraction> => {
        const key = stageKey('extract/v2', place.lat.toFixed(6), place.lng.toFixed(6), Math.round(radiusM));
        const inEntry = (dir: string, v: StagedExtraction): StagedExtraction => ({ ...v, texturedGlb: path.join(dir, v.texturedGlb), geometryGlb: path.join(dir, v.geometryGlb) });
        const hit = cache.get<StagedExtraction>('tiles', key);
        if (hit && now() - hit.builtAtMs < EXTRACTION_TTL_MS) {
            const v = inEntry(hit.dir, hit.value);
            if (fs.existsSync(v.texturedGlb) && fs.existsSync(v.geometryGlb)) { last = { key, cached: true }; return v; }
        }
        const entry = await cache.run('tiles', key, async dir => {
            const x = await deps.extract({ lat: place.lat, lng: place.lng, radiusM, outDir: dir, place, signal: ctx.signal, onProgress: m => progress(m) });
            return { value: { ...x, texturedGlb: path.relative(dir, x.texturedGlb), geometryGlb: path.relative(dir, x.geometryGlb) } };
        }, { bypass: true });
        last = { key, cached: false };
        return inEntry(entry.dir, entry.value);
    };
    t = now();
    let sizing: Awaited<ReturnType<typeof sizeExtraction<StagedExtraction>>>;
    try {
        sizing = await sizeExtraction<StagedExtraction>({
            extract: radiusM => extractCached(radiusM),
            ...(deps.vegetation?.canopy ? { canopy: async (tile: string) => (await deps.vegetation!.canopy!({ tilePath: tile, signal: ctx.signal })).mask } : {}),
            ...(deps.vectorEvidence ? { vector: async (radiusM: number) => evidenceLookup(await deps.vectorEvidence!({ lat: place.lat, lng: place.lng, radiusM }), radiusM) } : {}),
            onProgress: m => progress(m), signal: ctx.signal
        }, { now });
    } catch (err) {
        if (ctx.signal?.aborted) throw err;
        throw new IsolateStructureFailure('no_tile_coverage', `No Photorealistic 3D Tiles could be extracted at ${place.formattedAddress}: ${errorMessage(err)}`);
    }
    lap('extract_and_pick', t);
    Object.assign(timings, Object.fromEntries(Object.entries(sizing.timingsMs).map(([k, v]) => [`sizing.${k}`, v])));
    for (const n of sizing.notes) notes.push(`${n.reasonCode}: ${n.reason}`);
    const extraction = sizing.extraction;
    const base = slug(request.query);
    const placeOut: IsolateStructureResult['place'] = {
        query: request.query, resolvedAddress: place.formattedAddress, lat: place.lat, lng: place.lng, geocoded: !request.place, cached: placeCached
    };
    const extractionOut: IsolateStructureResult['extraction'] = {
        radiusM: sizing.radiusM, rounds: sizing.rounds, leafTiles: extraction.leafTiles, coveredRadiusM: extraction.coveredRadiusM,
        rawGlbPath: extraction.rawGlbPath ?? extraction.texturedGlb, cached: last?.cached ?? false, originEllipsoidalHeightM: extraction.originEllipsoidalHeightM
    };
    const reliefOpt = request.relief ? {} : { relief: false };

    /** The district around the place, remeshed whole (every outcome but isolated). */
    const district = async (tilePath: string): Promise<NonNullable<IsolateStructureResult['district']>> => {
        progress('remeshing the district around the place');
        const rawGlbPath = extraction.rawGlbPath ?? extraction.texturedGlb;
        const td = now();
        try {
            const r = await deps.refine.refine({ tilePath, ...reliefOpt });
            const k = r.cacheKey.slice(0, 8);
            return { clayGlb: publish(cache, r.clayGlb, `${base}_district_${k}_clay.glb`), texturedGlb: publish(cache, r.texturedGlb, `${base}_district_${k}_textured.glb`), rawGlbPath };
        } catch (err) {
            if (ctx.signal?.aborted) throw err;
            notes.push(`the district remesh failed (${errorMessage(err)}); the raw extraction as downloaded is the district`);
            return { rawGlbPath, remeshError: errorMessage(err) };
        } finally { lap('district_remesh', td); }
    };
    const finish = (r: Omit<IsolateStructureResult, 'schema' | 'place' | 'target' | 'extraction' | 'kept' | 'removed' | 'rooftopCanopyKeptAsScanned' | 'notes' | 'timingsMs' | 'digest'>): IsolateStructureResult => {
        timings.total = now() - t0;
        const full: IsolateStructureResult = {
            schema: 'scratchbox.isolate-structure/1', place: placeOut, target: request.target, extraction: extractionOut,
            ...r, kept, removed, rooftopCanopyKeptAsScanned: rooftop, notes, timingsMs: timings, digest: ''
        };
        full.digest = digestOf(full);
        return full;
    };

    // ---------------- no structure contained: the district, with the reason ----------------
    const structure = sizing.sizedTo === 'structure' ? sizing.structure : undefined;
    if (!structure || !sizing.ground) {
        const note: SizingNote | undefined = sizing.notes.find(n => n.reasonCode !== 'canopy_not_masked');
        const code = note?.reasonCode ?? 'no_structure_at_anchor';
        const d = await district(extraction.texturedGlb);
        return finish({
            outcome: code === 'containment_failed' ? 'containment_failed' : 'district_fallback',
            reasonCode: code,
            reason: `${note?.reason ?? 'no structure was picked at the place'}. Nothing is isolated, so no fragment of it is returned; the district around the place is returned whole instead.`,
            district: d
        });
    }
    const ground = sizing.ground;

    // ---------------- the trees measured in the photo tiles, taken out around the structure ----------------
    let tilePath = extraction.texturedGlb;
    let strip: TileVegetationStripResult | undefined;
    const roiPolygon = grownOutline(structure.outline, ISOLATE_TREE_REACH_M);
    if (request.trees && deps.vegetation?.strip) {
        progress('measuring the trees around the structure');
        t = now();
        try {
            strip = await deps.vegetation.strip({ tilePath: extraction.texturedGlb, signal: ctx.signal, roi: { schema: 'scratchbox.strip-roi/1', polygon: roiPolygon } });
            tilePath = strip.devegetatedGlb;
        } catch (err) {
            if (ctx.signal?.aborted) throw err;
            notes.push(`trees_not_measured: the trees around the structure could not be measured (${errorMessage(err)}); the structure was isolated on the scan with its trees in it`);
        }
        lap('trees_measure', t);
    } else if (request.trees) {
        notes.push('trees_not_measured: tile_vegetation is not available, so the structure was isolated on the scan with its trees in it');
    }

    // ---------------- the shared pick, on the scan tile_refine is given ----------------
    t = now();
    let remeshPick: { pick: StructurePickResult; ground: GroundModel } = { pick: structure, ground };
    if (tilePath !== extraction.texturedGlb) remeshPick = pickOnScan(tilePath, structure.seed, sizing.canopy as CanopyMask | undefined, sizing.vector as EvidenceLookup | undefined) ?? remeshPick;
    const bytesKey = crypto.createHash('sha256').update(remeshPick.pick.footprintMask).update(Buffer.from(Float32Array.from(remeshPick.ground.ground).buffer)).update(Buffer.from(Float32Array.from(remeshPick.ground.top).buffer)).digest('hex').slice(0, 16);
    const isolatePick = writeIsolationPick(path.join(path.dirname(tilePath), `structure_pick_${bytesKey}.sbip`), remeshPick.pick, remeshPick.ground);
    lap('pick_on_scan', t);
    const pick = remeshPick.pick;
    const terrain = remeshPick.ground;

    // ---------------- the multi-view mask vote ----------------
    const visionClient = deps.vision && 'client' in deps.vision ? deps.vision : undefined;
    let ownership: { masksDir: string } | undefined;
    let maskVote: NonNullable<IsolateStructureResult['footprint']>['maskVote'];
    if (!deps.refine.renderOwnershipViews) maskVote = { ran: false, reason: 'this build of tile_refine cannot render views for the mask vote' };
    else if (!visionClient) maskVote = { ran: false, reason: `no vision model is configured for the multi-view mask vote${deps.vision && 'unavailable' in deps.vision ? ` (${deps.vision.unavailable})` : ''}; the geometric rules alone (footprint and connectivity) decide what belongs to the structure` };
    else {
        t = now();
        try {
            progress('rendering views of the structure for the ownership vote');
            const views = await deps.refine.renderOwnershipViews({ tilePath, isolate: true, anchor: { x: structure.seed.x, z: structure.seed.z }, isolatePick });
            const masksDir = path.join(views.dir, `masks_${crypto.createHash('sha256').update(request.target.trim()).digest('hex').slice(0, 16)}`);
            const chain = new VisionModelChain<string>({ client: visionClient.client, candidates: visionClient.candidates, signal: ctx.signal, hedgeAfterMs: VISION_HEDGE_AFTER_MS, replyCache: stagedReplyCache(cache), ...(deps.sleep ? { sleep: deps.sleep } : {}) });
            const seg = await segmentOwnershipViews({ viewsDir: views.dir, masksDir, target: request.target.trim(), chain, concurrency: 6, onProgress: m => progress(m) });
            if (seg.masks < 2) throw new Error(`only ${seg.masks} of ${seg.views} views got a usable outline (${seg.skipped.slice(0, 3).map(x => `${x.view}: ${x.reason}`).join('; ')})`);
            ownership = { masksDir };
            maskVote = { ran: true, reason: `${seg.model ?? 'the vision model'} outlined "${request.target.trim()}" in ${seg.masks} of ${seg.views} views of the tile; the vote decides the raised triangles near it, the geometric rules the rest`, views: seg.views, ...(seg.model ? { model: seg.model } : {}) };
        } catch (err) {
            if (ctx.signal?.aborted) throw err;
            maskVote = { ran: false, reason: `the multi-view mask vote could not be made (${errorMessage(err)}); the geometric rules alone decide what belongs to the structure` };
        }
        lap('mask_vote', t);
    }

    // ---------------- tile_refine's isolate on the shared pick ----------------
    progress('isolating the structure (tile_refine)');
    t = now();
    const isolateRequest: TileRefineRequest = { tilePath, isolate: true, anchor: { x: structure.seed.x, z: structure.seed.z }, isolatePick, ...(ownership ? { ownership } : {}), ...reliefOpt };
    let r: TileRefineResult;
    try {
        r = await deps.refine.refine(isolateRequest);
    } catch (err) {
        if (ctx.signal?.aborted) throw err;
        lap('isolate', t);
        const d = await district(tilePath);
        return finish({ outcome: 'district_fallback', reasonCode: 'remesh_failed', reason: `tile_refine's isolate failed (${errorMessage(err)}), so the district around the place is returned whole instead`, district: d });
    }
    lap('isolate', t);

    // ---------------- is it the structure picked? ----------------
    let check: IsolateCheck | undefined;
    let mismatch: string | undefined;
    if (!r.rawClayGlb) mismatch = 'tile_refine wrote no isolated raw scan to compare with the structure picked';
    else {
        check = checkIsolate(r.rawClayGlb, pick, terrain);
        if (!check.ok) {
            const why = !check.holdsSeed ? 'it does not hold the structure at the seed'
                : check.precision < ISOLATE_PRECISION_MIN ? `only ${Math.round(check.precision * 100)}% of it lies on the footprint picked`
                : check.roofed < ISOLATE_ROOFED_MIN ? `only ${Math.round(check.roofed * 100)}% of it is roofed (a shell of facades)`
                : `it covers only ${Math.round(check.recall * 100)}% of the footprint picked (under ${Math.round(ISOLATE_RECALL_MIN * 100)}%: the ownership vote took the rest away)`;
            mismatch = `tile_refine isolated a different structure than the one picked: ${why} (${Math.round(check.areaM2)} m² isolated against ${Math.round(pick.areaM2)} m² picked, ${Math.round(check.recall * 100)}% of the pick covered, seed ${structure.seed.x}, ${structure.seed.z})`;
        }
    }

    // ---------------- the accounting ----------------
    const iso = (r.stats?.isolate ?? {}) as IsolateStats;
    const own = iso.ownership;
    if (maskVote && own) Object.assign(maskVote, { votingViews: own.votingViews, joinedTriangles: own.joined, leftTriangles: own.left });
    const voteChanged = !!own && (Number(own.joined ?? 0) > 0 || Number(own.left ?? 0) + Number(own.leftAsOrphans ?? 0) > 0);
    const source: FootprintSource = voteChanged ? 'mask-vote' : pick.footprintSource;
    // the footprint: the pick's cells, or (mask vote) the cells of the structure tile_refine isolated
    const fpMask = new Uint8Array(terrain.nx * terrain.nz);
    if (voteChanged && check) {
        for (const k of check.cells) { const [x, z] = k.split(',').map(Number); const c = terrain.cellIndex(x + 0.5, z + 0.5); if (c >= 0) fpMask[c] = 1; }
    } else for (let c = 0; c < fpMask.length; c++) fpMask[c] = pick.footprintMask[c] === PICK_STRUCTURE ? 1 : 0;
    const traced = traceCells(fpMask, terrain);
    const origin = { lat: extraction.geoAnchor?.lat ?? place.lat, lng: extraction.geoAnchor?.lng ?? place.lng };
    const polygonLatLng = traced.outer.map(([x, z]) => { const g = LocalTangentPlane.enuToGeodetic(origin, x, -z, 0); return [Math.round(g.lat * 1e8) / 1e8, Math.round(g.lng * 1e8) / 1e8] as [number, number]; });
    const vf = pick.vectorFootprint;
    const vectorPolygon = vf?.featureIds.length && sizing.vector
        ? sizing.vector.raster.buildings.find(b => b.id === vf.featureIds[0])?.parts.map(part => part[0]) : undefined;
    const footprint: NonNullable<IsolateStructureResult['footprint']> = {
        source, pickSource: pick.footprintSource,
        polygon: traced.outer, holes: traced.holes, polygonLatLng, convexOutline: pick.outline, areaM2: traced.areaM2,
        iouWithScan: round3(source === 'vector-footprint' && vf ? vf.iou : check?.iou ?? 0),
        ...(vf ? { vectorFootprint: { ...vf, ...(vectorPolygon ? { polygon: vectorPolygon } : {}) } } : {}),
        ...(maskVote ? { maskVote } : {}),
        ...(check ? { isolateCheck: { iou: round3(check.iou), precision: round3(check.precision), recall: round3(check.recall), roofed: round3(check.roofed), holdsSeed: check.holdsSeed, isolatedAreaM2: check.areaM2, ok: check.ok } } : {})
    };
    if (!vf) notes.push(`footprint from the scan's geometry alone: ${sizing.vectorError ? `Google vector data could not be read (${sizing.vectorError})` : 'no Google vector data was available'}`);
    const walkable = terrain.walkable ? terrain.walkable.reduce((s, v) => s + v, 0) * terrain.cellMeters ** 2 : undefined;
    const groundOut: NonNullable<IsolateStructureResult['ground']> = {
        heightM: pick.groundY, ellipsoidalHeightM: round3(extraction.originEllipsoidalHeightM + pick.groundY),
        source: terrain.terrainMethod, roadsFromVectorData: !!sizing.vector,
        ...(walkable !== undefined ? { walkableAreaM2: walkable } : {}),
        ...(typeof iso.groundY === 'number' ? { isolateGroundY: round3(iso.groundY) } : {}),
        reason: terrain.terrainMethod === 'walkable-surface'
            ? `measured on the walkable street surface (the open surface the most structure rises from${sizing.vector ? ', with Google vector road cells as the street level and its water cells never joining it' : ''}), ${walkable ?? 0} m² of it in the extraction`
            : 'no walkable street surface was found in the extraction, so the terrain is a low percentile of the surface around each cell'
    };

    // kept
    kept.push({
        part: 'structure footprint', areaKind: 'plan', areaM2: pick.areaM2,
        reasonCode: pick.footprintSource === 'vector-footprint' ? 'within_vector_footprint' : 'structure_rule',
        reason: pick.footprintSource === 'vector-footprint' && vf
            ? `the scan's cells ${STRUCTURE_MIN_HEIGHT_M} m or more above the ground within ${FOOTPRINT_TOLERANCE_M} m of Google vector footprint ${vf.featureIds.join(', ')} (${Math.round(vf.areaM2)} m², ${Math.round(vf.raisedShare * 100)}% of it raised in the scan)`
            : `the raised mass (${STRUCTURE_MIN_HEIGHT_M} m or more above the ground) at the place, after the opening scaled to the mass and the parts across height steps${vf?.reason ? `; the vector footprint was not used: ${vf.reason}` : ''}`,
        detail: { heightM: pick.heightM, seed: pick.seed, coreHeightM: pick.coreHeightM }
    });
    let enclosed = 0;
    if (terrain.canopy) for (let c = 0; c < fpMask.length; c++) if (pick.footprintMask[c] === PICK_STRUCTURE && terrain.canopy[c]) enclosed++;
    if (enclosed) kept.push({ part: 'enclosed tree canopy', areaKind: 'plan', areaM2: enclosed * terrain.cellMeters ** 2, reasonCode: 'canopy_enclosed_by_structure', reason: 'tree canopy the structure encloses (a roof garden or a courtyard planting the street cannot reach without crossing the structure) is part of it' });
    if (typeof iso.groundPatch?.area_m2 === 'number') kept.push({ part: 'ground apron', areaKind: 'surface', areaM2: round3(iso.groundPatch.area_m2), reasonCode: 'apron', reason: `the ground within ${iso.apron_m ?? 4} m of the footprint, so the structure stands on its street`, detail: { triangles: iso.groundPatch.triangles } });
    for (const c of own?.clusters ?? []) {
        const rec: AreaRecord = { part: c.change === 'joined' ? 'mask-vote addition' : 'mask-vote removal', areaKind: 'surface', areaM2: round3(Number(c.area_m2)), reasonCode: c.change === 'joined' ? 'vote_joined' : 'vote_left',
            reason: c.change === 'joined' ? 'outlined as part of the structure in the views that see it, though the geometric rules left it out' : 'outlined as not part of the structure in the views that see it, though the geometric rules took it',
            detail: { triangles: c.triangles, bearingFromAnchorDeg: c.bearingFromAnchorDeg, distanceFromAnchorM: c.distanceFromAnchor_m, aboveTerrainM: c.aboveTerrain_m } };
        (c.change === 'joined' ? kept : removed).push(rec);
    }
    // removed
    removed.push(...adjacentMassesRemoved(pick, terrain));
    const canopyNear = cellsNearStructure(pick, terrain, PICK_CANOPY, 4);
    if (canopyNear) removed.push({ part: 'tree canopy at the structure', areaKind: 'plan', areaM2: canopyNear, reasonCode: 'canopy_masked', reason: 'cells tile_vegetation classifies as tree canopy within 4 m of the structure, left out of its footprint' });
    const la = iso.lowAttachment;
    if (la && la.trianglesDropped > 0) removed.push({ part: 'low attachment (triangles)', areaKind: 'plan', areaM2: round3(la.area_m2), reasonCode: 'low_attachment', reason: `scan below the core height of ${la.coreHeight_m} m on cells the pick left out as a low attachment`, detail: { triangles: la.trianglesDropped } });
    if (Number(iso.interiorFloorsDropped) > 0) removed.push({ part: 'interior floors', areaKind: 'surface', areaM2: 0, reasonCode: 'interior_floor', reason: 'surfaces inside the structure below its roof that no view can see', detail: { triangles: iso.interiorFloorsDropped } });
    const bg = iso.belowGround;
    if (bg && bg.dropped > 0) removed.push({ part: 'below ground', areaKind: 'surface', areaM2: 0, reasonCode: 'below_ground', reason: `scan more than ${bg.margin_m} m below the ground (y < ${bg.clipY})`, detail: { triangles: bg.dropped, cut: bg.cut } });
    if (Number(own?.leftAsOrphans) > 0) removed.push({ part: 'orphaned pieces', areaKind: 'surface', areaM2: 0, reasonCode: 'vote_orphan', reason: 'pieces the vote cut off from the structure, holding nothing it kept', detail: { triangles: own!.leftAsOrphans, pieces: own!.orphanPieces } });
    if (strip) {
        const crowns = readCrowns(strip.crownsJson);
        const trees = crowns.filter(c => c.status === 'tree' && insidePolygon(c.stem, roiPolygon));
        if (trees.length) removed.push({ part: 'trees', areaKind: 'plan', areaM2: round3(trees.reduce((s, c) => s + c.areaM2, 0)), reasonCode: 'measured_tree', reason: `${trees.length} tree crown${trees.length === 1 ? '' : 's'} measured in the photo tiles within ${ISOLATE_TREE_REACH_M} m of the structure, taken out of the scan so no crown joins it (this tool does not regrow them)`, detail: { crownIds: trees.map(c => c.id) } });
        for (const c of crowns) {
            if (c.ground?.reasonCode !== 'raised_level_not_under_it') continue;
            rooftop.push({ crownId: c.id, stem: c.stem, apexY: c.apex[1], areaM2: round3(c.areaM2), reasonCode: c.ground.reasonCode, reason: c.ground.reason });
        }
        if (rooftop.length) kept.push({ part: 'rooftop canopy', areaKind: 'plan', areaM2: round3(rooftop.reduce((s, c) => s + c.areaM2, 0)), reasonCode: 'raised_level_not_under_it', reason: 'crowns at roof level over a roof the scan replaced with the planting: kept as scanned, not regrown from the street', detail: { crownIds: rooftop.map(c => c.crownId) } });
    }

    if (mismatch) {
        const d = await district(tilePath);
        if (!d.clayGlb) {
            return finish({ outcome: 'failed', reasonCode: 'isolate_mismatch', reason: `${mismatch}; remeshing the district failed too (${d.remeshError}), so no remesh is returned (never the partial isolate). The raw extraction is at district.rawGlbPath.`, district: d, footprint, ground: groundOut });
        }
        return finish({ outcome: 'district_fallback', reasonCode: 'isolate_mismatch', reason: `${mismatch}, so the district around it is returned whole instead of a partial isolate`, district: d, footprint, ground: groundOut });
    }

    const k = r.cacheKey.slice(0, 8);
    return finish({
        outcome: 'isolated',
        structure: {
            texturedGlb: publish(cache, r.texturedGlb, `${base}_isolate_${k}_textured.glb`),
            clayGlb: publish(cache, r.clayGlb, `${base}_isolate_${k}_clay.glb`),
            ...(r.rawClayGlb ? { rawClayGlb: publish(cache, r.rawClayGlb, `${base}_isolate_${k}_raw_clay.glb`) } : {}),
            seed: structure.seed, geocodeToStructureM: structure.geocodeToStructureM, heightM: pick.heightM, facadeHeadingsDeg: pick.facadeHeadingsDeg
        },
        footprint, ground: groundOut
    });
}

// ----------------------------------------------------------------------------------------------------------------
// what the model reads, and the scene
// ----------------------------------------------------------------------------------------------------------------

export function digestOf(r: IsolateStructureResult): string {
    const place = r.place.resolvedAddress;
    const parts: string[] = [];
    if (r.outcome === 'isolated' && r.footprint) {
        const f = r.footprint;
        parts.push(`Isolated the structure at ${place}: ${Math.round(f.areaM2).toLocaleString('en-US')} m² footprint, ${r.structure?.heightM ?? '?'} m tall`);
        parts.push(`footprint from ${f.source === 'vector-footprint' ? 'Google vector data' : f.source === 'mask-vote' ? 'the multi-view mask vote' : 'the scan geometry'} (IoU ${f.iouWithScan} with the scan)`);
    } else if (r.outcome === 'failed') {
        parts.push(`Could not isolate the structure at ${place}: ${r.reason}`);
    } else {
        parts.push(`Did not isolate the structure at ${place} (${r.outcome}, ${r.reasonCode}): ${r.reason}`);
    }
    if (r.ground) parts.push(`ground ${r.ground.source} at y ${r.ground.heightM} m`);
    if (r.rooftopCanopyKeptAsScanned.length) parts.push(`${r.rooftopCanopyKeptAsScanned.length} rooftop crown(s) kept as scanned`);
    const removed = r.removed.filter(x => x.areaKind === 'plan' && x.areaM2 > 0);
    if (removed.length) parts.push(`removed ${removed.map(x => `${x.part} ${Math.round(x.areaM2)} m² (${x.reasonCode})`).join(', ')}`);
    return `${parts.join('; ')}.`;
}

function scene(r: IsolateStructureResult): CanvasArtifact | undefined {
    const glbs: Array<{ id: string; g: GlbOutput; role: string; label: string }> = [];
    if (r.structure) {
        glbs.push({ id: 'isolated-textured', g: r.structure.texturedGlb, role: 'hero', label: 'isolated structure (photo-textured)' });
        glbs.push({ id: 'isolated-clay', g: r.structure.clayGlb, role: 'hero', label: 'isolated structure (clay)' });
    } else if (r.district?.clayGlb) glbs.push({ id: 'district-clay', g: r.district.clayGlb, role: 'environment', label: `district (${r.reasonCode})` });
    if (!glbs.length) return undefined;
    // the clay twin beside the textured isolate, east of it by the isolate's width and a gap, both standing on y = 0
    const bounds = glbs.map(x => glbBounds(x.g.path) ?? { min: [-30, 0, -30] as [number, number, number], max: [30, 30, 30] as [number, number, number] });
    const gy = r.ground?.heightM ?? 0;
    const offsetX = glbs.length > 1 ? bounds[0].max[0] - bounds[1].min[0] + 10 : 0;
    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    bounds.forEach((bb, i) => { for (let k = 0; k < 3; k++) { const o = k === 0 && i === 1 ? offsetX : k === 1 ? -gy : 0; lo[k] = Math.min(lo[k], bb.min[k] + o); hi[k] = Math.max(hi[k], bb.max[k] + o); } });
    const target: [number, number, number] = [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 3, (lo[2] + hi[2]) / 2];
    const radius = Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) / 2;
    const dist = (radius / Math.sin((45 * Math.PI) / 360)) * 1.05;
    const el = (28 * Math.PI) / 180, az = (20 * Math.PI) / 180;
    const camera = { position: [target[0] + dist * Math.cos(el) * Math.sin(az), target[1] + dist * Math.sin(el), target[2] + dist * Math.cos(el) * Math.cos(az)].map(round3), target: target.map(round3), fov: 45 };
    const tag = crypto.createHash('sha256').update(glbs.map(x => x.g.url).join('|')).digest('hex').slice(0, 10);
    const objects = glbs.map(x => ({
        id: `iso-${tag}-${x.id}`,
        content: { type: '3d-model', durableUri: x.g.url, mimeType: 'model/gltf-binary', metadata: { source: 'location_isolate_structure', role: x.role, description: x.label, metricScale: 1.0, groundDatumMeters: 0.0, resolvedAddress: r.place.resolvedAddress, outcome: r.outcome } },
        space: { spatial3d: { x: x.id === 'isolated-clay' ? round3(offsetX) : 0, y: round3(-gy), z: 0 } },
        time: { startMs: 0, durationMs: 20000 },
        lineage: { version: 1 }
    }));
    return {
        id: `scene-iso-${tag}`,
        type: '3d-scene',
        title: `${r.place.resolvedAddress} (isolated)`,
        summary: r.digest,
        version: 1,
        data: {
            title: `${r.place.resolvedAddress}: ${r.outcome === 'isolated' ? 'isolated structure' : `district (${r.reasonCode})`}`,
            subtitle: r.outcome === 'isolated' ? 'Left: the isolated scan with its tile photos. Right: the same in studio clay.' : r.reason,
            renderMode: 'pbr',
            cameraMode: 'orbit',
            environment: { skybox: 'studio', lighting: 'studio', ground: false },
            groundDatum: { coordinateSystem: 'metric-enu', units: 'meters', scale: 1.0, groundDatumMeters: 0.0, groundLogic: 'shared-metric-ground' },
            camera,
            objects
        }
    } as unknown as CanvasArtifact;
}

/** The tool call. `injected` replaces the app's services (tests). */
export async function runIsolateStructureTool(args: Record<string, unknown>, ctx: Pick<ToolContext, 'signal' | 'reportProgress'>, injected?: IsolateStructureDeps): Promise<ToolHandlerOutcome> {
    let request: IsolateStructureRequest;
    try {
        request = parseIsolateStructureArgs(args);
    } catch (err) {
        return { status: 'failed', summaryResult: errorMessage(err), resultPayload: { status: 'error', code: 'missing_input', message: errorMessage(err) } };
    }
    try {
        const deps = injected ?? await createStagedLocationDeps(stagedWorkspaceRoot(), { signal: ctx.signal });
        const result = await runIsolateStructure(request, deps, { signal: ctx.signal, reportProgress: ctx.reportProgress });
        const artifact = scene(result);
        return {
            status: result.outcome === 'failed' ? 'failed' : 'completed',
            summaryResult: result.digest,
            resultPayload: { success: result.outcome !== 'failed', ...result, ...(artifact ? { artifact } : {}) } as unknown as ToolResultPayload
        };
    } catch (err) {
        if (ctx.signal?.aborted) throw err;
        const code = err instanceof IsolateStructureFailure ? err.code : 'failed';
        return { status: 'failed', summaryResult: `${ISOLATE_STRUCTURE_TOOL} failed: ${errorMessage(err)}`, resultPayload: { status: 'error', success: false, outcome: 'failed', code, message: errorMessage(err) } };
    }
}

export const isolateStructureHandler: ToolHandler = (args, ctx) => runIsolateStructureTool(args, ctx);
