/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * location_split_block: a block of real buildings from Google Photorealistic 3D Tiles, separated into one mesh per
 * building of Google's vector data, with every triangle of the scan in exactly one output.
 *
 *  1. The place (the staged geocode cache) and the buildings around it: location_building_shape's footprints and neighbour
 *     logic (vector footprints joined across tile edges, the vector height and the Solar DSM roof per building).
 *  2. Which buildings: those within a radius of the place, or the block that holds the place's building (the cells the
 *     Google vector road lines enclose around it; the touching buildings when there are no roads).
 *  3. One leaf-LOD extraction holding all of them (the staged extraction cache), the canopy mask, the walkable ground.
 *  4. Each building's structure pick with its vector footprint as the prior (extraction-sizing.ts pickStructure, the
 *     isolation picker), its scan cells; cells two picks share settled by the nearer footprint (block-split.ts).
 *  5. The trees measured in the photo tiles around the block taken out of the buildings (tile_vegetation strip, the block's
 *     cells kept as scanned); optionally the multi-view mask vote per building (as location_isolate_structure runs it)
 *     moving raised triangles across party walls where the vote is decisive.
 *  6. Every triangle labelled (block-split.ts), detached small pieces returned, and the scan written as one textured and
 *     one clay GLB per building plus one "unassigned" pair (ground, trees, street furniture, structures no footprint
 *     owns), with each building's party walls, the evidence that decided each boundary, and plausibility flags.
 *
 * A building whose footprint disagrees with the scan is reported with the reason and its scan left unassigned: it is
 * never forced. Nothing is invented: a structure with no footprint stays in the unassigned mesh, listed with its area.
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import type { ToolContext, ToolDeclaration, ToolHandler, ToolHandlerOutcome, ToolResultPayload } from '../types';
import { MissingInputError } from '../../../../common/errors/pipeline-errors';
import { LocalTangentPlane } from '../../../../common/coordinate/LocalTangentPlane';
import type { CanopyMask, Vec2 } from '../../../../common/spatial/staged-location-contracts';
import { checkDimensions, plausibilitySummary, type PlausibilityFlag } from '../../../../common/spatial/plausibility';
import type { CanvasArtifact } from '../../../../browser/generative-canvas/canvas-types';
import { VisionModelChain } from '../../vision-model-chain';
import { buildGroundModel, geodeticToScan, loadScanMesh, type GroundModel, type ScanMesh } from '../../../spatial/StreetViewSurveyPlanner';
import {
    canopyLookup, grownOutline, insideDistance, maskCanopy, pickStructure, structureKeepCells, touchesEdge, writeIsolationPick,
    CONTAINMENT_MAX_RADIUS_M, CONTAINMENT_MARGIN_M, PICK_STRUCTURE, type StructurePickResult
} from '../../../3d-engine/staged-location/extraction-sizing';
import { evidenceLookup, type EvidenceLookup, type VectorEvidence } from '../../../3d-engine/staged-location/vector-footprints';
import { segmentOwnershipViews } from '../../../3d-engine/staged-location/ownership-masks';
import { stageKey, stagedReplyCache, stagedWorkspaceRoot } from '../../../3d-engine/staged-location/stage-cache';
import { ISOLATE_TREE_REACH_M, VISION_HEDGE_AFTER_MS, type ResolvedPlace, type StagedExtraction } from '../../../3d-engine/staged-location/orchestrator';
import { createStagedLocationDeps } from '../../../3d-engine/staged-location/staged-location-tool';
import { glbBounds } from '../../../3d-engine/staged-location/staged-artifact';
import { readScanGlb, writeColouredPartition, writePartition, STUDIO_CLAY, type PartitionOutput } from '../../../3d-engine/staged-location/glb-partition';
import {
    boundaries, detachPieces, distanceToFootprint, footprintCells, labelTriangles, resolveOwnership, trimBand, unmappedMasses, unmappedStructures, weldVertices,
    SPLIT_RAISED_ABOVE_M, SPLIT_VECTOR_EDGE_M, TRIANGLE_KIND_NAMES, TRI_TREE, TRI_VOTE_MOVED, type BoundarySegment, type BoundarySource, type OwnershipClaim
} from '../../../3d-engine/staged-location/block-split';
import { runBuildingShape, BuildingShapeError, type BuildingReport, type BuildingShapeRequest, type BuildingShapeResult } from './building-shape';
import { resolveStagedPlace, stagedExtractor, traceCells, IsolateStructureFailure, type IsolateStructureDeps } from './isolate-structure';

export const SPLIT_BLOCK_TOOL = 'location_split_block';

/** The block that holds the place is searched within this of it (m). */
export const BLOCK_SEARCH_M = 130;
/** The extraction reaches this past the farthest footprint of the block (m). */
export const SPLIT_EXTRACTION_MARGIN_M = 12;
/** A building is split only when its scan cells and its vector footprint overlap at least this much (IoU). */
export const SPLIT_MIN_IOU = 0.3;
/** A building is in the block when at least this share of its footprint lies in the cells the roads enclose. */
export const BLOCK_MEMBER_SHARE = 0.5;
export const SPLIT_MAX_BUILDINGS_DEFAULT = 80;

// ----------------------------------------------------------------------------------------------------------------
// the declaration
// ----------------------------------------------------------------------------------------------------------------

export const SPLIT_BLOCK_TOOL_DECLARATION: ToolDeclaration = {
    name: SPLIT_BLOCK_TOOL,
    description:
        'Split a block of real buildings from Google Photorealistic 3D Tiles (leaf LOD) into one separated building per Google vector footprint, with every ' +
        'triangle of the scan in exactly one output: a photo-textured GLB and a studio clay GLB per building, and one "unassigned" pair holding the rest ' +
        '(ground, trees, street furniture, structures no footprint owns) with its area. Give a place (name, address or lat/lng) and either a radius, or ' +
        'nothing for the block that holds the place\'s building (the area Google\'s vector road lines enclose). Per building it returns its footprint ' +
        '(the scan cells it owns, traced, and the vector parts), the IoU of the two, its heights (vector, Solar DSM, scan), its ground, its party walls with ' +
        'each neighbour as edge segments, the evidence that decided each boundary (vector-footprint, height-jump, mask-vote, scan-geometry) and plausibility ' +
        'flags. A building whose footprint disagrees with the scan is listed with the reason and never forced; a structure with no footprint is never ' +
        'invented (it stays in the unassigned mesh). Reuses the staged-location caches. Mounts the block in the viewport with each building in its own colour.',
    parameters: {
        type: 'OBJECT',
        properties: {
            query: { type: 'STRING', description: 'The place: a name or an address (e.g. "corner of Haight Street and Ashbury Street, San Francisco"). Optional when lat and lng are given.' },
            lat: { type: 'NUMBER', description: 'Latitude (WGS-84). Give with lng to skip geocoding.' },
            lng: { type: 'NUMBER', description: 'Longitude (WGS-84). Give with lat.' },
            radiusM: { type: 'NUMBER', description: 'Split the buildings whose footprint comes within this many metres of the place (10-120). Leave out for the block that holds the place\'s building.' },
            trees: { type: 'BOOLEAN', description: 'Take the trees measured in the photo tiles out of the buildings (default true): their triangles go to the unassigned mesh.' },
            maskVote: { type: 'BOOLEAN', description: 'Also run the multi-view mask vote per building (a vision model outlines each building in rendered views; decisive votes move triangles across party walls). Default false: it takes about a minute per building.' },
            maxBuildings: { type: 'NUMBER', description: `At most this many buildings are split, nearest the place first (default ${SPLIT_MAX_BUILDINGS_DEFAULT}).` }
        }
    }
};

// ----------------------------------------------------------------------------------------------------------------
// request, dependencies, result
// ----------------------------------------------------------------------------------------------------------------

export interface SplitBlockRequest {
    query: string;
    place?: ResolvedPlace;
    /** Undefined: the block that holds the place's building. */
    radiusM?: number;
    trees: boolean;
    maskVote: boolean;
    maxBuildings: number;
}

export interface SplitBlockDeps extends IsolateStructureDeps {
    /** location_building_shape's run (footprints, heights, neighbours); default runBuildingShape on the workspace. */
    buildingShape?: (req: BuildingShapeRequest) => Promise<BuildingShapeResult>;
}

export interface GlbOutput { path: string; url: string; bytes: number }

export interface SplitPartyWall {
    neighbourId: string;
    neighbourLabel: number;
    lengthM: number;
    decidedByM: Record<string, number>;
    segments: Array<BoundarySegment & { fromLatLng: [number, number]; toLatLng: [number, number] }>;
}

export interface SplitBuilding {
    label: number;
    id: string;
    featureIds: string[];
    /** Its colour in the block overview (sRGB hex). */
    colour: string;
    footprint: {
        /** The scan cells it owns, traced (tile frame: x east, z south, metres from the extraction origin). */
        polygon: Vec2[];
        holes: Vec2[][];
        polygonLatLng: Array<[number, number]>;
        areaM2: number;
        /** IoU of the owned cells with the vector footprint's cells. */
        iouWithScan: number;
        /** The vector footprint (building-shape's parts, with holes). */
        vector: { kind: string; areaM2: number; parts: Array<{ id: string; ringLatLng: Array<[number, number]>; holesLatLng: Array<Array<[number, number]>>; ring: Vec2[] }> };
        /** What the pick saw of the footprint in the scan. */
        pick: { source: string; seed: { x: number; z: number }; raisedShare: number; openShare: number; canopyShare: number; enclosesStructure: boolean };
        /** Cells it shared with another pick and kept (settled by the nearer footprint). */
        contestedCellsKept: number;
        /** Cells the pick took past its outline where a raised mass continues (a structure with no footprint), left to it. */
        bandCellsLeft: number;
    };
    heights: {
        vectorM?: number; vectorKind: string;
        dsmRoofM?: number; dsmPeakM?: number;
        /** Above its ground, from the scan's surface model over its interior cells: the 95th percentile and the highest cell. */
        scanRoofM: number; scanMaxM: number;
        comparison: string;
    };
    ground: { heightM: number; ellipsoidalHeightM: number };
    texturedGlb: GlbOutput;
    clayGlb: GlbOutput;
    triangles: number;
    surfaceAreaM2: number;
    partyWalls: SplitPartyWall[];
    exterior: { lengthM: number; decidedByM: Record<string, number> };
    /** Total boundary length decided by each source (party walls and exterior). */
    boundaryDecidedByM: Record<string, number>;
    plausibility: PlausibilityFlag[];
    detachedPieces: { triangles: number; surfaceM2: number };
    maskVote?: { ran: boolean; reason: string; movedIn: number; movedOut: number };
}

export interface NotSplitBuilding {
    id: string;
    featureIds: string[];
    reasonCode: 'no_raised_scan' | 'footprint_scan_disagree' | 'picked_other_footprint' | 'extends_past_extraction' | 'low_iou' | 'outside_extraction' | 'over_limit' | (string & {});
    reason: string;
    vectorAreaM2: number;
    vectorHeightM?: number;
    dsmRoofM?: number;
    footprintLatLng: Array<Array<[number, number]>>;
    iouWithScan?: number;
}

export interface SplitBlockResult {
    schema: 'scratchbox.split-block/1';
    place: { query: string; resolvedAddress: string; lat: number; lng: number; geocoded: boolean; cached: boolean };
    selection: { mode: 'block' | 'radius'; radiusM?: number; boundedByRoads?: boolean; blockCellsM2?: number; reason: string; footprintsConsidered: number };
    extraction: { radiusM: number; leafTiles: number; coveredRadiusM: number; rawGlbPath: string; cached: boolean; originEllipsoidalHeightM: number; triangles: number };
    buildings: SplitBuilding[];
    notSplit: NotSplitBuilding[];
    unassigned: {
        texturedGlb: GlbOutput;
        clayGlb: GlbOutput;
        triangles: number;
        surfaceAreaM2: number;
        /** Plan area of the extraction's cells no building owns. */
        planAreaM2: number;
        /** Surface by what it is: ground, trees, raised scan no footprint owns, below ground, detached pieces, outside the grid. */
        surfaceByKindM2: Record<string, number>;
        /** Raised masses (3 m or more, not canopy) no building owns: an unmapped structure, or a footprint not split. */
        /**
         * Raised masses (3 m or more, not canopy) no split building owns, those touching a split building first: with the
         * share of their cells inside some vector footprint (about 0: a structure with no footprint; about 1: buildings outside
         * the block, or a footprint not split) and the footprint holding their centroid.
         */
        unmappedStructures: Array<{ areaM2: number; heightM: number; centroid: Vec2; latLng: [number, number]; touches: string[]; footprintShare: number; withinFootprint?: string }>;
    };
    overview: { clayGlb: GlbOutput; colours: Record<string, string> };
    partition: { inputTriangles: number; outputTriangles: number; everyTriangleOnce: boolean; byKind: Record<string, number> };
    trees: { ran: boolean; reason: string; triangles?: number; crowns?: number };
    maskVote: { ran: boolean; reason: string };
    plausibility: { warnings: number; buildings: number };
    notes: string[];
    timingsMs: Record<string, number>;
    cached: boolean;
    digest: string;
}

export class SplitBlockFailure extends Error {
    constructor(readonly code: 'place_unresolved' | 'no_footprint' | 'no_tile_coverage' | 'missing_credentials' | 'no_buildings' | (string & {}), message: string) {
        super(message);
        this.name = 'SplitBlockFailure';
    }
}

// ----------------------------------------------------------------------------------------------------------------
// arguments
// ----------------------------------------------------------------------------------------------------------------

const asString = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
function asNumber(v: unknown): number | undefined {
    if (v === undefined || v === null || v === '') return undefined;
    const n = Number(v);
    return Number.isFinite(n) ? n : NaN;
}

export function parseSplitBlockArgs(args: Record<string, unknown>): SplitBlockRequest {
    const query = asString(args.query);
    const lat = asNumber(args.lat), lng = asNumber(args.lng);
    let place: ResolvedPlace | undefined;
    if (lat !== undefined || lng !== undefined) {
        if (lat === undefined || lng === undefined || !Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
            throw new MissingInputError(SPLIT_BLOCK_TOOL, 'both lat and lng as finite WGS-84 degrees', `got lat ${JSON.stringify(args.lat)}, lng ${JSON.stringify(args.lng)}`);
        }
        place = { lat, lng, formattedAddress: query || `${lat.toFixed(6)}, ${lng.toFixed(6)}` };
    }
    if (!query && !place) throw new MissingInputError(SPLIT_BLOCK_TOOL, 'query, or lat and lng', 'a place name, an address or coordinates');
    const r = asNumber(args.radiusM);
    if (r !== undefined && (!Number.isFinite(r) || r < 10 || r > 120)) throw new MissingInputError(SPLIT_BLOCK_TOOL, 'radiusM between 10 and 120 m', `got ${JSON.stringify(args.radiusM)}`);
    const mb = asNumber(args.maxBuildings);
    return {
        query: query || place!.formattedAddress, ...(place ? { place } : {}), ...(r !== undefined ? { radiusM: r } : {}),
        trees: args.trees !== false, maskVote: args.maskVote === true,
        maxBuildings: mb !== undefined && Number.isFinite(mb) ? Math.max(1, Math.min(200, Math.round(mb))) : SPLIT_MAX_BUILDINGS_DEFAULT
    };
}

// ----------------------------------------------------------------------------------------------------------------
// helpers
// ----------------------------------------------------------------------------------------------------------------

const r2 = (v: number) => Math.round(v * 100) / 100;
const r3 = (v: number) => Math.round(v * 1000) / 1000;
const errorMessage = (err: unknown) => (err instanceof Error ? err.message : String(err));
function slug(text: string): string {
    return text.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 32) || 'place';
}

/** Distinct colours by the golden angle: linear RGB for glTF and sRGB hex for the card. */
export function buildingColour(i: number): { linear: [number, number, number]; hex: string } {
    const h = (i * 137.508) % 360, s = 0.62, l = 0.56;
    const c = (1 - Math.abs(2 * l - 1)) * s, x = c * (1 - Math.abs(((h / 60) % 2) - 1)), m = l - c / 2;
    const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
    const srgb = [r + m, g + m, b + m];
    const lin = srgb.map(v => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)) as [number, number, number];
    return { linear: lin.map(r3) as [number, number, number], hex: `#${srgb.map(v => Math.round(v * 255).toString(16).padStart(2, '0')).join('')}` };
}

/** Footprint parts of a building-shape report in the scan frame (each part: outer ring, then its holes). */
function partsInScan(b: BuildingReport, origin: { lat: number; lng: number }): Vec2[][][] {
    const o = { lat: origin.lat, lng: origin.lng, heightMeters: 0 };
    const conv = (ring: Array<[number, number]>): Vec2[] => ring.map(([lng, lat]) => { const p = geodeticToScan(o, lat, lng); return [p.x, p.z] as Vec2; });
    return b.footprint.parts.map(p => [conv(p.ringWgs84 as Array<[number, number]>), ...(p.holesWgs84 ?? []).map(h => conv(h as Array<[number, number]>))]);
}

function latLngOf(origin: { lat: number; lng: number }, p: Vec2): [number, number] {
    const g = LocalTangentPlane.enuToGeodetic({ lat: origin.lat, lng: origin.lng, alt: 0 }, p[0], -p[1], 0);
    return [Math.round(g.lat * 1e8) / 1e8, Math.round(g.lng * 1e8) / 1e8];
}

function iou(a: Uint8Array, b: ArrayLike<number>): number {
    let i = 0, u = 0;
    for (let c = 0; c < a.length; c++) { const x = a[c] ? 1 : 0, y = b[c] ? 1 : 0; i += x & y; u += x | y; }
    return u ? i / u : 0;
}

/** Cells the Google vector road lines enclose around the target's footprint (flooded through non-road cells within `maxM`). */
function blockCells(ev: EvidenceLookup, targetParts: Vec2[][][], maxM: number): { inBlock: Uint8Array; bounded: boolean; cells: number } {
    const g = ev.grid;
    const N = g.nx * g.nz;
    const start = footprintCells(g, targetParts);
    const inBlock = new Uint8Array(N);
    const st: number[] = [];
    for (let c = 0; c < N; c++) if (start[c] && !ev.raster.road[c]) { inBlock[c] = 1; st.push(c); }
    let bounded = true, cells = st.length;
    while (st.length) {
        const c = st.pop()!;
        const i = c % g.nx, k = (c / g.nx) | 0;
        for (const [ii, kk] of [[i + 1, k], [i - 1, k], [i, k + 1], [i, k - 1]]) {
            if (ii < 0 || kk < 0 || ii >= g.nx || kk >= g.nz) { bounded = false; continue; }
            const n = kk * g.nx + ii;
            if (inBlock[n] || ev.raster.road[n]) continue;
            const x = g.x0 + (ii + 0.5) * g.cellMeters, z = g.z0 + (kk + 0.5) * g.cellMeters;
            if (Math.hypot(x, z) > maxM) { bounded = false; continue; }
            inBlock[n] = 1; cells++;
            st.push(n);
        }
    }
    return { inBlock, bounded, cells };
}

/** SBOV v1 (tile_refine --ownership-out): per triangle centroid, score, weight, owner (-1 other, 0 undecided, 1 target). */
export function readOwnershipVotes(file: string): Map<string, number> {
    const b = fs.readFileSync(file);
    if (b.length < 12 || b.toString('latin1', 0, 4) !== 'SBOV') throw new Error(`not an SBOV file: ${file}`);
    const n = b.readUInt32LE(8);
    const out = new Map<string, number>();
    for (let i = 0; i < n; i++) {
        const o = 12 + i * 24;
        if (o + 24 > b.length) break;
        const owner = b.readInt8(o + 20);
        if (owner) out.set(centroidKey(b.readFloatLE(o), b.readFloatLE(o + 4), b.readFloatLE(o + 8)), owner);
    }
    return out;
}

/** A triangle centroid's key on a 1 cm lattice (matches the same triangle read by another reader). */
export function centroidKey(x: number, y: number, z: number): string {
    return `${Math.round(x * 100)},${Math.round(y * 100)},${Math.round(z * 100)}`;
}


// ----------------------------------------------------------------------------------------------------------------
// the run
// ----------------------------------------------------------------------------------------------------------------

interface Member { report: BuildingReport; parts: Vec2[][][]; reach: number; label: number }

export async function runSplitBlock(request: SplitBlockRequest, deps: SplitBlockDeps, ctx: { signal?: AbortSignal; reportProgress?: (m: string, f?: number) => void } = {}): Promise<SplitBlockResult> {
    const now = deps.now ?? Date.now;
    const cache = deps.cache;
    const progress = (m: string, f?: number) => ctx.reportProgress?.(m, f);
    const timings: Record<string, number> = {};
    const notes: string[] = [];
    const t0 = now();
    let t = now();
    const lap = (name: string) => { timings[name] = now() - t; t = now(); };

    // ---------------- the place ----------------
    const resolved = await resolveStagedPlace(request, deps, ctx);
    const place = resolved.place;
    lap('resolve');

    // ---------------- the buildings around it (location_building_shape's footprints and neighbour logic) ----------------
    progress('reading the vector footprints and heights around the place');
    const searchM = request.radiusM !== undefined ? Math.min(150, request.radiusM + 30) : BLOCK_SEARCH_M;
    const shape = deps.buildingShape ?? ((req: BuildingShapeRequest) => runBuildingShape(req, { workspaceRoot: cache.workspaceRoot }));
    let bs: BuildingShapeResult;
    try {
        bs = await shape({ latitude: place.lat, longitude: place.lng, location: request.query, neighbourRadiusMeters: searchM, maxSnapMeters: 40, maxNeighbours: 400, roofSegments: false });
    } catch (err) {
        if (err instanceof BuildingShapeError) throw new SplitBlockFailure(err.code === 'no_footprint' ? 'no_footprint' : err.code, `location_building_shape found no block to split: ${err.message}`);
        throw err;
    }
    lap('footprints');
    const all = [bs.target, ...bs.neighbours];
    const originPlace = { lat: place.lat, lng: place.lng };

    // ---------------- which buildings ----------------
    let vector: EvidenceLookup | undefined, vectorError: string | undefined;
    if (deps.vectorEvidence) {
        try { vector = evidenceLookup(await deps.vectorEvidence({ lat: place.lat, lng: place.lng, radiusM: BLOCK_SEARCH_M + 30 }), BLOCK_SEARCH_M + 30); } catch (err) {
            if (ctx.signal?.aborted) throw err;
            vectorError = errorMessage(err);
        }
    }
    lap('vector_evidence');
    const inPlace = all.map(b => ({ report: b, parts: partsInScan(b, originPlace) }));
    let chosen: typeof inPlace;
    let selection: SplitBlockResult['selection'];
    if (request.radiusM !== undefined) {
        chosen = inPlace.filter(b => b.report.distanceFromPlaceMeters <= request.radiusM!);
        selection = { mode: 'radius', radiusM: request.radiusM, reason: `the ${chosen.length} vector footprints within ${request.radiusM} m of the place`, footprintsConsidered: all.length };
    } else if (vector && vector.raster.road.some(v => v)) {
        const blk = blockCells(vector, inPlace[0].parts, BLOCK_SEARCH_M);
        chosen = inPlace.filter(b => {
            const m = footprintCells(vector!.grid, b.parts);
            let n = 0, inside = 0;
            for (let c = 0; c < m.length; c++) if (m[c]) { n++; if (blk.inBlock[c]) inside++; }
            return n > 0 && inside >= BLOCK_MEMBER_SHARE * n;
        });
        if (!chosen.includes(inPlace[0])) chosen.unshift(inPlace[0]);
        selection = {
            mode: 'block', boundedByRoads: blk.bounded, blockCellsM2: blk.cells * vector.grid.cellMeters ** 2, footprintsConsidered: all.length,
            reason: blk.bounded
                ? `the ${chosen.length} vector footprints with half or more of their area in the ${Math.round(blk.cells)} m² the Google vector road lines enclose around ${bs.target.id}`
                : `the road lines around ${bs.target.id} do not close within ${BLOCK_SEARCH_M} m of the place, so the block is the ${chosen.length} footprints in the open area reached within that distance`
        };
        if (!blk.bounded) notes.push(`block_not_closed: ${selection.reason}`);
    } else {
        // no roads: the buildings that touch the place's building, and those touching them
        const linked = new Set<number>([0]);
        for (let changed = true; changed;) {
            changed = false;
            inPlace.forEach((b, i) => {
                if (linked.has(i)) return;
                if ([...linked].some(j => b.parts.some(p => p[0].some(([x, z]) => distanceToFootprint(x, z, inPlace[j].parts) <= 0.75)) || inPlace[j].parts.some(p => p[0].some(([x, z]) => distanceToFootprint(x, z, b.parts) <= 0.75)))) { linked.add(i); changed = true; }
            });
        }
        chosen = [...linked].sort((a, b) => a - b).map(i => inPlace[i]);
        selection = { mode: 'block', footprintsConsidered: all.length, reason: `no vector road lines ${vectorError ? `(${vectorError})` : 'were available'}, so the block is the ${chosen.length} footprints touching ${bs.target.id} and each other` };
        notes.push(`block_from_touching_footprints: ${selection.reason}`);
    }
    const notSplit: NotSplitBuilding[] = [];
    const notSplitOf = (b: BuildingReport, reasonCode: NotSplitBuilding['reasonCode'], reason: string, extra: Partial<NotSplitBuilding> = {}): NotSplitBuilding => ({
        id: b.id, featureIds: b.featureIds, reasonCode, reason, vectorAreaM2: b.footprint.areaM2,
        ...(b.vector.heightMeters !== undefined ? { vectorHeightM: b.vector.heightMeters } : {}),
        ...(b.solarDsm.roofAboveStreetMeters !== undefined ? { dsmRoofM: b.solarDsm.roofAboveStreetMeters } : {}),
        footprintLatLng: b.footprint.parts.map(p => (p.ringWgs84 as Array<[number, number]>).map(([lng, lat]) => [lat, lng] as [number, number])), ...extra
    });
    chosen.sort((a, b) => a.report.distanceFromPlaceMeters - b.report.distanceFromPlaceMeters);
    for (const b of chosen.slice(request.maxBuildings)) notSplit.push(notSplitOf(b.report, 'over_limit', `more than ${request.maxBuildings} buildings: split the nearest ${request.maxBuildings} (maxBuildings)`));
    chosen = chosen.slice(0, request.maxBuildings);
    // the extraction holds them all; a footprint that reaches past the largest extraction is not split
    const reachOf = (parts: Vec2[][][]) => Math.max(...parts.flatMap(p => p[0].map(([x, z]) => Math.hypot(x, z))));
    const fits: Array<{ report: BuildingReport; parts: Vec2[][][]; reach: number }> = [];
    for (const b of chosen) {
        const reach = reachOf(b.parts);
        if (reach + CONTAINMENT_MARGIN_M > CONTAINMENT_MAX_RADIUS_M) notSplit.push(notSplitOf(b.report, 'outside_extraction', `its footprint reaches ${Math.round(reach)} m from the place, past the ${CONTAINMENT_MAX_RADIUS_M} m the extraction can hold whole`));
        else fits.push({ ...b, reach });
    }
    if (!fits.length) throw new SplitBlockFailure('no_buildings', `None of the ${chosen.length} buildings chosen can be held whole by one extraction around the place.`);
    const radiusM = Math.min(CONTAINMENT_MAX_RADIUS_M, Math.max(30, Math.ceil(Math.max(...fits.map(f => f.reach)) + SPLIT_EXTRACTION_MARGIN_M)));
    lap('select');

    // ---------------- the extraction (the staged extraction cache) ----------------
    progress(`extracting the leaf tiles within ${radiusM} m of the place`);
    const extractor = stagedExtractor(place, deps, ctx);
    let extraction: StagedExtraction;
    try { extraction = await extractor.extract(radiusM); } catch (err) {
        if (ctx.signal?.aborted) throw err;
        throw new SplitBlockFailure('no_tile_coverage', `No Photorealistic 3D Tiles could be extracted at ${place.formattedAddress}: ${errorMessage(err)}`);
    }
    lap('extract');
    const origin = { lat: extraction.geoAnchor?.lat ?? place.lat, lng: extraction.geoAnchor?.lng ?? place.lng };
    const members: Member[] = fits.map((f, i) => ({ report: f.report, parts: partsInScan(f.report, origin), reach: f.reach, label: i + 1 }));

    // ---------------- the whole split, cached on its inputs ----------------
    const key = stageKey('split-block/v2', extractor.last()?.key ?? extraction.texturedGlb, members.map(m => [m.report.id, m.parts.map(p => p.map(r => r.map(([x, z]) => [r2(x), r2(z)])))]),
        all.filter(b => !members.some(m => m.report === b)).map(b => b.id), request.trees, request.maskVote, !!deps.vegetation?.canopy, !!vector);
    const base = slug(request.query);
    const k8 = key.slice(0, 8);
    let computed: Omit<SplitBlockResult, 'place' | 'timingsMs' | 'cached' | 'digest'> | undefined;
    let innerTimings: Record<string, number> = {};
    const entry = await cache.run<{ result: Omit<SplitBlockResult, 'place' | 'timingsMs' | 'cached' | 'digest'>; timings: Record<string, number> }>('split-block', key, async dir => {
        const r = await splitInto(dir);
        return { value: r };
    }, {
        publish: (dir, v) => {
            const files: Array<{ from: string; as: string }> = [];
            for (const b of v.result.buildings) files.push({ from: path.join(dir, path.basename(b.texturedGlb.path)), as: path.basename(b.texturedGlb.path) }, { from: path.join(dir, path.basename(b.clayGlb.path)), as: path.basename(b.clayGlb.path) });
            files.push({ from: path.join(dir, path.basename(v.result.unassigned.texturedGlb.path)), as: path.basename(v.result.unassigned.texturedGlb.path) });
            files.push({ from: path.join(dir, path.basename(v.result.unassigned.clayGlb.path)), as: path.basename(v.result.unassigned.clayGlb.path) });
            files.push({ from: path.join(dir, path.basename(v.result.overview.clayGlb.path)), as: path.basename(v.result.overview.clayGlb.path) });
            return files;
        }
    });
    computed = entry.value.result;
    innerTimings = entry.cached ? {} : entry.value.timings;
    // the published copies are what the result points to
    const pub = new Map(entry.published.map(p => [p.name, { path: p.path, url: p.url, bytes: p.bytes }]));
    const fix = (g: GlbOutput): GlbOutput => pub.get(path.basename(g.path)) ?? g;
    computed = {
        ...computed,
        buildings: computed.buildings.map(b => ({ ...b, texturedGlb: fix(b.texturedGlb), clayGlb: fix(b.clayGlb) })),
        unassigned: { ...computed.unassigned, texturedGlb: fix(computed.unassigned.texturedGlb), clayGlb: fix(computed.unassigned.clayGlb) },
        overview: { ...computed.overview, clayGlb: fix(computed.overview.clayGlb) }
    };
    lap('split');
    Object.assign(timings, Object.fromEntries(Object.entries(innerTimings).map(([k, v]) => [`split.${k}`, v])));
    timings.total = now() - t0;
    const result: SplitBlockResult = {
        ...computed,
        notes: [...notes, ...computed.notes],
        place: { query: request.query, resolvedAddress: place.formattedAddress, lat: place.lat, lng: place.lng, geocoded: !request.place, cached: resolved.cached },
        timingsMs: timings, cached: entry.cached, digest: ''
    };
    result.digest = digestOf(result);
    return result;

    // ------------------------------------------------------------------------------------------------------------
    async function splitInto(dir: string): Promise<{ result: Omit<SplitBlockResult, 'place' | 'timingsMs' | 'cached' | 'digest'>; timings: Record<string, number> }> {
        const tm: Record<string, number> = {};
        let ts = now();
        const step = (name: string) => { tm[name] = now() - ts; ts = now(); };
        const innerNotes: string[] = [];
        // the canopy mask, the scan and its ground model (as the isolation picker builds them)
        let canopy: CanopyMask | undefined;
        if (deps.vegetation?.canopy) {
            progress('masking the tree canopy');
            try { canopy = (await deps.vegetation.canopy({ tilePath: extraction.texturedGlb, signal: ctx.signal })).mask; } catch (err) {
                if (ctx.signal?.aborted) throw err;
                innerNotes.push(`canopy_not_masked: the canopy could not be masked (${errorMessage(err)}); raised tree canopy may join a building`);
            }
        } else innerNotes.push('canopy_not_masked: tile_vegetation has no canopy classifier in this build; raised tree canopy may join a building');
        step('canopy');
        progress('reading the scan');
        const scan: ScanMesh = loadScanMesh(extraction.texturedGlb);
        let ground: GroundModel = buildGroundModel(scan, { cellMeters: 1, ...(canopy ? { exclude: canopyLookup(canopy) } : {}), ...(vector ? { water: vector.waterAt, road: vector.roadAt } : {}) });
        if (canopy) ground = maskCanopy(ground, canopy).masked;
        step('ground_model');
        // the footprints as the picker reads them: every building building-shape reported (neighbours too, so a pick never
        // grows into a footprint outside the block)
        const ev: VectorEvidence = { buildings: all.map(b => ({ id: b.id, parts: partsInScan(b, origin), ...(b.vector.heightMeters !== undefined ? { heightM: b.vector.heightMeters } : {}) })), water: [], roads: [], tiles: 0, zoom: 17 };
        const fpLookup = evidenceLookup(ev, radiusM + CONTAINMENT_MARGIN_M + 20);
        const footprints = { buildingAt: fpLookup.buildingAt, buildings: fpLookup.raster.buildings };
        const N = ground.nx * ground.nz;
        const masks = members.map(m => footprintCells(ground, m.parts));

        // ---------------- each building's structure pick, its vector footprint the prior ----------------
        const picks = new Map<number, StructurePickResult>();
        const failed = new Map<number, { code: NotSplitBuilding['reasonCode']; reason: string }>();
        members.forEach((m, mi) => {
            progress(`picking building ${mi + 1} of ${members.length} (${m.report.id})`);
            const mask = masks[mi];
            const inside = insideDistance(mask, ground.nx, ground.nz, ground.cellMeters);
            let best = -1, bd = -1;
            for (let c = 0; c < N; c++) if (mask[c] && inside[c] > bd) { bd = inside[c]; best = c; }
            if (best < 0) { failed.set(m.label, { code: 'outside_extraction', reason: 'its footprint covers no cell of the extraction' }); return; }
            const anchor = { x: ground.x0 + ((best % ground.nx) + 0.5) * ground.cellMeters, z: ground.z0 + (((best / ground.nx) | 0) + 0.5) * ground.cellMeters };
            const pick = pickStructure(scan, ground, { anchor, footprints });
            if (!pick) { failed.set(m.label, { code: 'no_raised_scan', reason: 'no structure 3 m or taller stands in the scan within 30 m of its footprint' }); return; }
            const vf = pick.vectorFootprint;
            if (!vf?.used) { failed.set(m.label, { code: 'footprint_scan_disagree', reason: vf?.reason ?? 'the picker did not use its vector footprint' }); return; }
            if (!vf.featureIds.includes(m.report.id)) { failed.set(m.label, { code: 'picked_other_footprint', reason: `the scan nearest its footprint belongs to footprint ${vf.featureIds.join(', ')}` }); return; }
            if (touchesEdge(pick, ground)) { failed.set(m.label, { code: 'extends_past_extraction', reason: 'its raised scan reaches the edge of the extraction, so it would be cut' }); return; }
            picks.set(m.label, pick);
        });
        step('picks');

        // ---------------- ownership: the picks' cells; shared cells to the nearer footprint; low agreement released ----------------
        // each pick's cells, less those past its outline that lie in a raised mass no footprint holds (block-split.ts trimBand)
        const pickCells = new Map<number, Uint8Array>();
        for (const [l, pk] of picks) pickCells.set(l, Uint8Array.from(pk.footprintMask, s => (s === PICK_STRUCTURE ? 1 : 0)));
        const bandDropped = new Map<number, number>();
        const trimmed = new Map<number, Uint8Array>();
        const anyFootprint = new Uint8Array(N);
        for (let c = 0; c < N; c++) if (fpLookup.buildingAt(ground.x0 + ((c % ground.nx) + 0.5) * ground.cellMeters, ground.z0 + (((c / ground.nx) | 0) + 0.5) * ground.cellMeters)) anyFootprint[c] = 1;
        const masses = unmappedMasses(ground, anyFootprint);
        for (const [l, cells] of pickCells) {
            const tb = trimBand(cells, masks[l - 1], masses);
            trimmed.set(l, tb.cells);
            if (tb.dropped) bandDropped.set(l, tb.dropped);
        }
        const claimOf = (m: Member): OwnershipClaim => ({ label: m.label, cells: trimmed.get(m.label)!, parts: m.parts });
        let own = resolveOwnership(ground, members.filter(m => picks.has(m.label)).map(claimOf));
        for (const m of members) {
            if (!picks.has(m.label)) continue;
            const v = iou(masks[m.label - 1], Int32Array.from(own.owner, o => (o === m.label ? 1 : 0)));
            if (v < SPLIT_MIN_IOU) failed.set(m.label, { code: 'low_iou', reason: `the scan cells it would own and its vector footprint overlap with IoU ${v.toFixed(2)}, under ${SPLIT_MIN_IOU}: they disagree, so it is not split` });
        }
        for (const l of failed.keys()) picks.delete(l);
        own = resolveOwnership(ground, members.filter(m => picks.has(m.label)).map(claimOf));
        const owner = own.owner;
        step('ownership');

        // ---------------- the trees around the block, measured in the photo tiles ----------------
        let treeKeys: Set<string> | undefined;
        let treesOut: SplitBlockResult['trees'] = { ran: false, reason: request.trees ? 'tile_vegetation is not available' : 'not asked for (trees false)' };
        if (request.trees && deps.vegetation?.strip && picks.size) {
            progress('measuring the trees around the block');
            try {
                const keep = structureKeepCells({ footprintMask: Uint8Array.from(owner, o => (o ? PICK_STRUCTURE : 0)), coreHeightM: 0 }, ground);
                const corners: Vec2[] = [];
                for (let c = 0; c < N; c++) if (owner[c]) { const x = ground.x0 + (c % ground.nx) * ground.cellMeters, z = ground.z0 + ((c / ground.nx) | 0) * ground.cellMeters; corners.push([x, z], [x + 1, z + 1]); }
                const hull = grownOutline(convexHullOf(corners), 0);
                const strip = await deps.vegetation.strip({ tilePath: extraction.texturedGlb, signal: ctx.signal, roi: { schema: 'scratchbox.strip-roi/1', polygon: grownOutline(hull, ISOLATE_TREE_REACH_M), ...(keep ? { keep } : {}) } });
                const removed = loadScanMesh(strip.removedTreesGlb);
                treeKeys = new Set<string>();
                for (let q = 0; q < removed.triCount; q++) treeKeys.add(centroidKey(removed.triCentroid[q * 3], removed.triCentroid[q * 3 + 1], removed.triCentroid[q * 3 + 2]));
                let crowns = 0;
                try { crowns = (JSON.parse(fs.readFileSync(strip.crownsJson, 'utf8')).crowns ?? []).filter((c: { status?: string }) => c.status === 'tree').length; } catch { /* the count is diagnostic */ }
                treesOut = { ran: true, reason: `tile_vegetation measured ${crowns} tree crown${crowns === 1 ? '' : 's'} within ${ISOLATE_TREE_REACH_M} m of the block; the triangles it took out go to the unassigned mesh, never to a building`, triangles: removed.triCount, crowns };
            } catch (err) {
                if (ctx.signal?.aborted) throw err;
                treesOut = { ran: false, reason: `the trees could not be measured (${errorMessage(err)}); tree crowns against a facade may join that building` };
                innerNotes.push(`trees_not_measured: ${treesOut.reason}`);
            }
        }
        step('trees');

        // ---------------- every triangle's label ----------------
        progress('labelling every triangle of the scan');
        const isTree = treeKeys ? (q: number) => treeKeys!.has(centroidKey(scan.triCentroid[q * 3], scan.triCentroid[q * 3 + 1], scan.triCentroid[q * 3 + 2])) : undefined;
        const tl = labelTriangles(scan, ground, owner, { labels: members.length, ...(isTree ? { isTree } : {}) });
        step('labels');

        // ---------------- the multi-view mask vote (optional) ----------------
        let voteOut: SplitBlockResult['maskVote'] = { ran: false, reason: 'not asked for (maskVote false)' };
        const voteCells = new Uint8Array(N);
        const voteMoves = new Map<number, { in: number; out: number; ran: boolean; reason: string }>();
        if (request.maskVote) {
            const visionClient = deps.vision && 'client' in deps.vision ? deps.vision : undefined;
            if (!deps.refine.renderOwnershipViews) voteOut = { ran: false, reason: 'this build of tile_refine cannot render views for the mask vote' };
            else if (!visionClient) voteOut = { ran: false, reason: `no vision model is configured${deps.vision && 'unavailable' in deps.vision ? ` (${deps.vision.unavailable})` : ''}` };
            else {
                const votes = new Map<number, Map<string, number>>();
                const ordered = members.filter(m => picks.has(m.label));
                let next = 0, done = 0;
                const work = async () => {
                    for (let i; (i = next++) < ordered.length;) {
                        const m = ordered[i];
                        const pick = picks.get(m.label)!;
                        try {
                            const bytesKey = crypto.createHash('sha256').update(pick.footprintMask).update(Buffer.from(Float32Array.from(ground.ground).buffer)).digest('hex').slice(0, 16);
                            const sbip = writeIsolationPick(path.join(path.dirname(extraction.texturedGlb), `structure_pick_${bytesKey}.sbip`), pick, ground);
                            const views = await deps.refine.renderOwnershipViews!({ tilePath: extraction.texturedGlb, isolate: true, anchor: pick.seed, isolatePick: sbip });
                            const target = `the one building standing at the centre of the image, up to its party walls with the buildings beside it`;
                            const masksDir = path.join(views.dir, `masks_${crypto.createHash('sha256').update(target).digest('hex').slice(0, 16)}`);
                            const chain = new VisionModelChain<string>({ client: visionClient.client, candidates: visionClient.candidates, signal: ctx.signal, hedgeAfterMs: VISION_HEDGE_AFTER_MS, replyCache: stagedReplyCache(cache), ...(deps.sleep ? { sleep: deps.sleep } : {}) });
                            const seg = await segmentOwnershipViews({ viewsDir: views.dir, masksDir, target, chain, concurrency: 6 });
                            if (seg.masks < 2) throw new Error(`only ${seg.masks} of ${seg.views} views got a usable outline`);
                            const r = await deps.refine.refine({ tilePath: extraction.texturedGlb, isolate: true, anchor: pick.seed, isolatePick: sbip, ownership: { masksDir }, relief: false });
                            if (!r.ownershipVotes) throw new Error('tile_refine wrote no ownership votes');
                            votes.set(m.label, readOwnershipVotes(r.ownershipVotes));
                            voteMoves.set(m.label, { in: 0, out: 0, ran: true, reason: `${seg.model ?? 'the vision model'} outlined the building in ${seg.masks} of ${seg.views} views` });
                        } catch (err) {
                            if (ctx.signal?.aborted) throw err;
                            voteMoves.set(m.label, { in: 0, out: 0, ran: false, reason: `the mask vote could not be made (${errorMessage(err)})` });
                        } finally { progress(`mask vote: ${++done} of ${ordered.length} buildings`); }
                    }
                };
                await Promise.all([work(), work()]);
                // decisive votes move raised triangles at a building's edge: to the neighbour that claims them, or from unassigned
                // to the one building that claims them
                const near = (c: number, l: number) => {
                    const i = c % ground.nx, k = (c / ground.nx) | 0;
                    for (let dk = -3; dk <= 3; dk++) for (let di = -3; di <= 3; di++) {
                        const ii = i + di, kk = k + dk;
                        if (ii >= 0 && kk >= 0 && ii < ground.nx && kk < ground.nz && owner[kk * ground.nx + ii] === l) return true;
                    }
                    return false;
                };
                let moved = 0;
                for (let q = 0; q < scan.triCount; q++) {
                    if (tl.kind[q] === TRI_TREE) continue;
                    const x = scan.triCentroid[q * 3], y = scan.triCentroid[q * 3 + 1], z = scan.triCentroid[q * 3 + 2];
                    const c = ground.cellIndex(x, z);
                    if (c < 0 || !(y - ground.ground[c] > SPLIT_RAISED_ABOVE_M)) continue;
                    const keyQ = centroidKey(x, y, z);
                    const claims: number[] = [];
                    for (const [l, v] of votes) if (v.get(keyQ) === 1 && near(c, l)) claims.push(l);
                    const cur = tl.labels[q];
                    const curVote = cur ? votes.get(cur)?.get(keyQ) : undefined;
                    let to = cur;
                    if (cur && curVote === -1 && claims.length === 1 && claims[0] !== cur) to = claims[0];
                    else if (!cur && claims.length === 1) to = claims[0];
                    if (to === cur) continue;
                    if (cur) voteMoves.get(cur)!.out++;
                    voteMoves.get(to)!.in++;
                    tl.labels[q] = to;
                    tl.kind[q] = TRI_VOTE_MOVED;
                    voteCells[c] = 1;
                    moved++;
                }
                const ran = [...voteMoves.values()].filter(v => v.ran).length;
                voteOut = { ran: ran > 0, reason: `the mask vote ran for ${ran} of ${ordered.length} buildings and moved ${moved} triangles where it was decisive` };
            }
        }
        step('mask_vote');

        // ---------------- no fragments: small pieces off a building's body go back to unassigned ----------------
        const detached = detachPieces(scan, tl, members.length);
        step('pieces');

        // ---------------- the boundaries and what decided them ----------------
        const nearVector = (l: number, x: number, z: number) => {
            const m = members[l - 1];
            return !!m && m.parts.some(loops => loops.some(r => distanceToLoopsQuick(x, z, r) <= SPLIT_VECTOR_EDGE_M));
        };
        const bounds = boundaries(ground, owner, members.length, { nearVector, voteCells });
        step('boundaries');

        // ---------------- the outputs: per building, unassigned, the coloured overview ----------------
        progress('writing the separated buildings');
        const glb = readScanGlb(extraction.texturedGlb);
        if (glb.triangleCount !== scan.triCount) throw new Error(`the scan GLB holds ${glb.triangleCount} triangles where the scan read ${scan.triCount}`);
        const labels = tl.labels;
        const split = members.filter(m => picks.has(m.label));
        const counts = new Int32Array(members.length + 1);
        const surface = new Float64Array(members.length + 1);
        for (let q = 0; q < scan.triCount; q++) { counts[labels[q]]++; surface[labels[q]] += scan.triArea[q]; }
        // a building with no triangle left (every one went elsewhere) is not split
        for (const m of split) if (!counts[m.label]) failed.set(m.label, { code: 'no_triangles', reason: 'no triangle of the scan was left to it' });
        const outputs: PartitionOutput[] = [];
        const fileOf = (name: string) => path.join(dir, name);
        const nameOf = (m: Member, kind: string) => `${base}_blk_${k8}_${m.label}_${kind}.glb`;
        const kept = split.filter(m => !failed.has(m.label));
        for (const m of kept) {
            const extras = { source: 'location_split_block', building: m.report.id, featureIds: m.report.featureIds, label: m.label, frame: 'tile frame: x east, y up, z south, metres from the extraction origin', provenance: 'as-scanned (Google Photorealistic 3D Tiles), split by footprint' };
            outputs.push({ label: m.label, file: fileOf(nameOf(m, 'textured')), kind: 'textured', extras }, { label: m.label, file: fileOf(nameOf(m, 'clay')), kind: 'clay', color: STUDIO_CLAY, extras });
        }
        // a failed building's triangles are unassigned (it is never forced)
        for (let q = 0; q < scan.triCount; q++) if (labels[q] && !kept.some(m => m.label === labels[q])) { labels[q] = 0; }
        const unExtras = { source: 'location_split_block', part: 'unassigned: ground, trees, street furniture and structures no footprint owns' };
        outputs.push({ label: 0, file: fileOf(`${base}_blk_${k8}_unassigned_textured.glb`), kind: 'textured', extras: unExtras }, { label: 0, file: fileOf(`${base}_blk_${k8}_unassigned_clay.glb`), kind: 'clay', color: [0.8, 0.8, 0.8], extras: unExtras });
        const written = writePartition(glb, labels, outputs);
        const colours = new Map(kept.map((m, i) => [m.label, buildingColour(i)]));
        writeColouredPartition(glb, labels, [
            ...kept.map(m => ({ label: m.label, name: m.report.id, color: colours.get(m.label)!.linear, extras: { building: m.report.id } })),
            { label: 0, name: 'unassigned', color: [0.78, 0.78, 0.78] as [number, number, number] }
        ], fileOf(`${base}_blk_${k8}_overview.glb`), { source: 'location_split_block', note: 'each building in its own colour; unassigned scan in light grey' });
        step('write');
        const outOf = (file: string): GlbOutput => ({ path: file, url: '', bytes: fs.statSync(file).size });
        let outputTriangles = 0;
        outputs.forEach((o, i) => { if (o.kind === 'textured') outputTriangles += written[i]; });
        const recount = new Int32Array(members.length + 1);
        for (let q = 0; q < scan.triCount; q++) recount[labels[q]]++;

        // ---------------- the report ----------------
        const ellipsoid = extraction.originEllipsoidalHeightM;
        const idOf = (l: number) => members[l - 1]?.report.id ?? String(l);
        const buildings: SplitBuilding[] = kept.map(m => {
            const b = m.report;
            const ownMask = new Uint8Array(N);
            // heights over its interior cells (an edge cell's surface holds the top of whatever wall stands on its line)
            const inner: number[] = [], edge: number[] = [], grounds: number[] = [];
            let contestedKept = 0;
            for (let c = 0; c < N; c++) {
                if (owner[c] !== m.label) continue;
                ownMask[c] = 1;
                if (own.contested[c]) contestedKept++;
                if (!(ground.ground[c] === ground.ground[c])) continue;
                grounds.push(ground.ground[c]);
                if (!(ground.top[c] === ground.top[c])) continue;
                const i = c % ground.nx, k = (c / ground.nx) | 0;
                const interior = i > 0 && k > 0 && i < ground.nx - 1 && k < ground.nz - 1 && owner[c - 1] === m.label && owner[c + 1] === m.label && owner[c - ground.nx] === m.label && owner[c + ground.nx] === m.label;
                (interior ? inner : edge).push(ground.top[c] - ground.ground[c]);
            }
            const heights = inner.length ? inner : edge;
            heights.sort((a, c) => a - c); grounds.sort((a, c) => a - c);
            const traced = traceCells(ownMask, ground);
            const pick = picks.get(m.label)!;
            const vf = pick.vectorFootprint!;
            const bd = bounds.get(m.label)!;
            const scanRoof = heights.length ? heights[Math.floor(0.95 * (heights.length - 1))] : 0;
            const scanMax = heights.length ? heights[heights.length - 1] : 0;
            const gy = grounds.length ? grounds[Math.floor(grounds.length / 2)] : pick.groundY;
            const boundaryDecidedByM: Record<string, number> = { ...bd.exteriorDecidedByM };
            for (const pw of bd.partyWalls) for (const [s, v] of Object.entries(pw.decidedByM)) boundaryDecidedByM[s] = (boundaryDecidedByM[s] ?? 0) + v;
            const vote = voteMoves.get(m.label);
            const plausibility = [
                ...b.plausibility,
                ...checkDimensions([{ dimension: 'buildingHeight', valueM: scanRoof, label: 'scan roof height above its ground', cause: 'structure pick or ground' }])
            ];
            return {
                label: m.label, id: b.id, featureIds: b.featureIds, colour: colours.get(m.label)!.hex,
                footprint: {
                    polygon: traced.outer, holes: traced.holes, polygonLatLng: traced.outer.map(p => latLngOf(origin, p)), areaM2: traced.areaM2,
                    iouWithScan: r3(iou(masks[m.label - 1], ownMask)),
                    vector: {
                        kind: b.footprint.chosen, areaM2: b.footprint.areaM2,
                        parts: b.footprint.parts.map((p, i) => ({
                            id: p.id, ringLatLng: (p.ringWgs84 as Array<[number, number]>).map(([lng, lat]) => [lat, lng] as [number, number]),
                            holesLatLng: (p.holesWgs84 ?? []).map(h => (h as Array<[number, number]>).map(([lng, lat]) => [lat, lng] as [number, number])),
                            ring: m.parts[i][0].map(([x, z]) => [r3(x), r3(z)] as Vec2)
                        }))
                    },
                    pick: { source: pick.footprintSource, seed: pick.seed, raisedShare: vf.raisedShare, openShare: vf.openShare, canopyShare: vf.canopyShare, enclosesStructure: vf.enclosesStructure },
                    contestedCellsKept: contestedKept, bandCellsLeft: bandDropped.get(m.label) ?? 0
                },
                heights: {
                    ...(b.vector.heightMeters !== undefined ? { vectorM: b.vector.heightMeters } : {}), vectorKind: b.vector.kind,
                    ...(b.solarDsm.roofAboveStreetMeters !== undefined ? { dsmRoofM: b.solarDsm.roofAboveStreetMeters } : {}),
                    ...(b.solarDsm.peakAboveStreetMeters !== undefined ? { dsmPeakM: b.solarDsm.peakAboveStreetMeters } : {}),
                    scanRoofM: r2(scanRoof), scanMaxM: r2(scanMax), comparison: b.comparison.statement
                },
                ground: { heightM: r3(gy), ellipsoidalHeightM: r3(ellipsoid + gy) },
                texturedGlb: outOf(fileOf(nameOf(m, 'textured'))), clayGlb: outOf(fileOf(nameOf(m, 'clay'))),
                triangles: recount[m.label], surfaceAreaM2: r2(surface[m.label]),
                partyWalls: bd.partyWalls.filter(pw => kept.some(o => o.label === pw.neighbour)).map(pw => ({
                    neighbourId: idOf(pw.neighbour), neighbourLabel: pw.neighbour, lengthM: pw.lengthM, decidedByM: pw.decidedByM,
                    segments: pw.segments.map(s => ({ ...s, fromLatLng: latLngOf(origin, s.from), toLatLng: latLngOf(origin, s.to) }))
                })),
                exterior: { lengthM: bd.exteriorM, decidedByM: bd.exteriorDecidedByM },
                boundaryDecidedByM, plausibility,
                detachedPieces: { triangles: detached.returnedTriangles[m.label], surfaceM2: r2(detached.returnedM2[m.label]) },
                ...(vote ? { maskVote: { ran: vote.ran, reason: vote.reason, movedIn: vote.in, movedOut: vote.out } } : {})
            };
        });
        for (const m of members) {
            const f = failed.get(m.label);
            if (!f) continue;
            const ownMask = Int32Array.from(owner, o => (o === m.label ? 1 : 0));
            notSplit.push(notSplitOf(m.report, f.code, f.reason, f.code === 'low_iou' ? { iouWithScan: r3(iou(masks[m.label - 1], ownMask)) } : {}));
        }
        // what stays unassigned, by kind, and the raised masses no building owns
        const byKind: Record<string, number> = {}, surfaceByKindM2: Record<string, number> = {};
        let unTris = 0, unSurface = 0;
        for (let q = 0; q < scan.triCount; q++) {
            const name = TRIANGLE_KIND_NAMES[tl.kind[q]] ?? String(tl.kind[q]);
            byKind[name] = (byKind[name] ?? 0) + 1;
            if (labels[q]) continue;
            unTris++; unSurface += scan.triArea[q];
            const un = tl.kind[q] === 1 || tl.kind[q] === 2 || tl.kind[q] === 7 || tl.kind[q] === TRI_VOTE_MOVED ? 'footprint not split' : name;
            surfaceByKindM2[un] = (surfaceByKindM2[un] ?? 0) + scan.triArea[q];
        }
        for (const k of Object.keys(surfaceByKindM2)) surfaceByKindM2[k] = r2(surfaceByKindM2[k]);
        let ownedCells = 0, dataCells = 0;
        for (let c = 0; c < N; c++) { if (owner[c] && kept.some(m => m.label === owner[c])) ownedCells++; if (ground.top[c] === ground.top[c]) dataCells++; }
        const keptOwner = Int32Array.from(owner, o => (kept.some(m => m.label === o) ? o : 0));
        const unmapped = unmappedStructures(ground, keptOwner, 6, anyFootprint)
            .sort((p, q) => Number(q.touches.length > 0) - Number(p.touches.length > 0) || q.areaM2 - p.areaM2).slice(0, 25).map(u => {
                const within = all.find(b => distanceToFootprint(u.centroid[0], u.centroid[1], partsInScan(b, origin)) === 0);
                return { areaM2: u.areaM2, heightM: u.heightM, centroid: u.centroid, latLng: latLngOf(origin, u.centroid), touches: u.touches.map(idOf), footprintShare: u.footprintShare, ...(within ? { withinFootprint: within.id } : {}) };
            });
        const plausibleWarnings = buildings.reduce((s, b) => s + b.plausibility.length, 0);
        return {
            timings: tm,
            result: {
                schema: 'scratchbox.split-block/1', selection,
                extraction: {
                    radiusM, leafTiles: extraction.leafTiles, coveredRadiusM: extraction.coveredRadiusM, rawGlbPath: extraction.rawGlbPath ?? extraction.texturedGlb,
                    cached: extractor.last()?.cached ?? false, originEllipsoidalHeightM: extraction.originEllipsoidalHeightM, triangles: scan.triCount
                },
                buildings, notSplit,
                unassigned: {
                    texturedGlb: outOf(outputs[outputs.length - 2].file), clayGlb: outOf(outputs[outputs.length - 1].file), triangles: unTris, surfaceAreaM2: r2(unSurface),
                    planAreaM2: dataCells - ownedCells, surfaceByKindM2, unmappedStructures: unmapped
                },
                overview: { clayGlb: outOf(fileOf(`${base}_blk_${k8}_overview.glb`)), colours: Object.fromEntries(kept.map(m => [m.report.id, colours.get(m.label)!.hex])) },
                partition: { inputTriangles: scan.triCount, outputTriangles, everyTriangleOnce: outputTriangles === scan.triCount && recount.reduce((s, v) => s + v, 0) === scan.triCount, byKind },
                trees: treesOut, maskVote: voteOut,
                plausibility: { warnings: plausibleWarnings, buildings: buildings.filter(b => b.plausibility.length).length },
                notes: innerNotes
            }
        };
    }
}

/** Distance from a point to one closed ring's edges. */
function distanceToLoopsQuick(x: number, z: number, r: Vec2[]): number {
    let best = Infinity;
    for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
        const [ax, az] = r[j], [bx, bz] = r[i];
        const dx = bx - ax, dz = bz - az, l2 = dx * dx + dz * dz || 1e-12;
        const tt = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / l2));
        const d = Math.hypot(x - (ax + tt * dx), z - (az + tt * dz));
        if (d < best) best = d;
    }
    return best;
}

function convexHullOf(points: Vec2[]): Vec2[] {
    const pts = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    if (pts.length < 3) return pts;
    const cross = (o: Vec2, a: Vec2, b: Vec2) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
    const lower: Vec2[] = [], upper: Vec2[] = [];
    for (const p of pts) { while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop(); lower.push(p); }
    for (let i = pts.length - 1; i >= 0; i--) { const p = pts[i]; while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop(); upper.push(p); }
    return [...lower.slice(0, -1), ...upper.slice(0, -1)];
}

// ----------------------------------------------------------------------------------------------------------------
// what the model reads, and the scene
// ----------------------------------------------------------------------------------------------------------------

export function digestOf(r: SplitBlockResult): string {
    const parts: string[] = [];
    const total = r.buildings.length + r.notSplit.length;
    parts.push(`Split ${r.selection.mode === 'radius' ? `the buildings within ${r.selection.radiusM} m of` : 'the block at'} ${r.place.resolvedAddress} into ${r.buildings.length} separated building${r.buildings.length === 1 ? '' : 's'} (${total} footprint${total === 1 ? '' : 's'} chosen)`);
    if (r.buildings.length) {
        const ious = r.buildings.map(b => b.footprint.iouWithScan).sort((a, b) => a - b);
        const walls = r.buildings.reduce((s, b) => s + b.partyWalls.length, 0) / 2;
        parts.push(`footprint IoU with the scan median ${ious[Math.floor(ious.length / 2)].toFixed(2)} (min ${ious[0].toFixed(2)})`);
        parts.push(`${walls} party wall${walls === 1 ? '' : 's'}`);
    }
    if (r.notSplit.length) {
        const by = new Map<string, number>();
        for (const n of r.notSplit) by.set(n.reasonCode, (by.get(n.reasonCode) ?? 0) + 1);
        parts.push(`not split: ${[...by].map(([k, v]) => `${v} ${k}`).join(', ')} (each with its reason; their scan is in the unassigned mesh)`);
    }
    const noFootprint = r.unassigned.unmappedStructures.filter(u => u.touches.length && u.footprintShare < 0.5);
    parts.push(`unassigned ${Math.round(r.unassigned.surfaceAreaM2).toLocaleString('en-US')} m² of scan surface over ${Math.round(r.unassigned.planAreaM2).toLocaleString('en-US')} m² of plan`
        + (noFootprint.length ? `, with ${noFootprint.length} raised structure(s) against the block that no vector footprint holds (${noFootprint.slice(0, 3).map(u => `${Math.round(u.areaM2)} m², ${u.heightM} m`).join('; ')}), left unassigned` : ''));
    parts.push(r.partition.everyTriangleOnce ? `all ${r.partition.inputTriangles.toLocaleString('en-US')} triangles in exactly one output` : `PARTITION CHECK FAILED: ${r.partition.outputTriangles} of ${r.partition.inputTriangles} triangles written`);
    const flags = r.buildings.flatMap(b => b.plausibility);
    if (flags.length) parts.push(`${plausibilitySummary(flags, 2)} on ${r.plausibility.buildings} building(s)`);
    return `${parts.join('; ')}.`;
}

function scene(r: SplitBlockResult): CanvasArtifact | undefined {
    const g = r.overview.clayGlb;
    if (!g?.path || !fs.existsSync(g.path)) return undefined;
    // framed on the separated buildings (the unassigned scan around them reaches the extraction's edge)
    const bb = { min: [Infinity, Infinity, Infinity] as [number, number, number], max: [-Infinity, -Infinity, -Infinity] as [number, number, number] };
    for (const b of r.buildings) {
        const x = fs.existsSync(b.clayGlb.path) ? glbBounds(b.clayGlb.path) : undefined;
        if (x) for (let k = 0; k < 3; k++) { bb.min[k] = Math.min(bb.min[k], x.min[k]); bb.max[k] = Math.max(bb.max[k], x.max[k]); }
    }
    if (!(bb.max[0] > bb.min[0])) { const all = glbBounds(g.path) ?? { min: [-50, 0, -50] as [number, number, number], max: [50, 30, 50] as [number, number, number] }; bb.min = all.min; bb.max = all.max; }
    const grounds = r.buildings.map(b => b.ground.heightM).sort((a, b) => a - b);
    const gy = grounds.length ? grounds[Math.floor(grounds.length / 2)] : 0;
    const target: [number, number, number] = [(bb.min[0] + bb.max[0]) / 2, (bb.min[1] + bb.max[1]) / 3 - gy, (bb.min[2] + bb.max[2]) / 2];
    const radius = Math.hypot(bb.max[0] - bb.min[0], bb.max[1] - bb.min[1], bb.max[2] - bb.min[2]) / 2;
    const dist = (radius / Math.sin((45 * Math.PI) / 360)) * 0.9;
    const el = (40 * Math.PI) / 180, az = (25 * Math.PI) / 180;
    const camera = { position: [target[0] + dist * Math.cos(el) * Math.sin(az), target[1] + dist * Math.sin(el), target[2] + dist * Math.cos(el) * Math.cos(az)].map(r3), target: target.map(r3), fov: 45 };
    const tag = crypto.createHash('sha256').update(g.url).digest('hex').slice(0, 10);
    return {
        id: `scene-split-${tag}`,
        type: '3d-scene',
        title: `${r.place.resolvedAddress}: ${r.buildings.length} buildings split`,
        summary: r.digest,
        version: 1,
        data: {
            title: `${r.place.resolvedAddress}: the block split by footprint`,
            subtitle: `Each separated building in its own colour; the unassigned scan (ground, trees, street furniture, unmapped structures) in light grey.`,
            renderMode: 'pbr', cameraMode: 'orbit',
            environment: { skybox: 'studio', lighting: 'studio', ground: false },
            groundDatum: { coordinateSystem: 'metric-enu', units: 'meters', scale: 1.0, groundDatumMeters: 0.0, groundLogic: 'shared-metric-ground' },
            camera,
            objects: [{
                id: `split-${tag}-overview`,
                content: { type: '3d-model', durableUri: g.url, mimeType: 'model/gltf-binary', metadata: { source: SPLIT_BLOCK_TOOL, role: 'hero', description: 'the block, one colour per separated building', metricScale: 1.0, groundDatumMeters: 0.0, resolvedAddress: r.place.resolvedAddress, colours: r.overview.colours } },
                space: { spatial3d: { x: 0, y: r3(-gy), z: 0 } },
                time: { startMs: 0, durationMs: 20000 },
                lineage: { version: 1 }
            }]
        }
    } as unknown as CanvasArtifact;
}

/** The tool call. `injected` replaces the app's services (tests). */
export async function runSplitBlockTool(args: Record<string, unknown>, ctx: Pick<ToolContext, 'signal' | 'reportProgress'>, injected?: SplitBlockDeps): Promise<ToolHandlerOutcome> {
    let request: SplitBlockRequest;
    try { request = parseSplitBlockArgs(args); } catch (err) {
        return { status: 'failed', summaryResult: errorMessage(err), resultPayload: { status: 'error', code: 'missing_input', message: errorMessage(err) } };
    }
    try {
        const deps = injected ?? await createStagedLocationDeps(stagedWorkspaceRoot(), { signal: ctx.signal });
        const result = await runSplitBlock(request, deps, { signal: ctx.signal, reportProgress: ctx.reportProgress });
        const artifact = scene(result);
        return { status: 'completed', summaryResult: result.digest, resultPayload: { success: true, ...result, ...(artifact ? { artifact } : {}) } as unknown as ToolResultPayload };
    } catch (err) {
        if (ctx.signal?.aborted) throw err;
        const code = err instanceof SplitBlockFailure || err instanceof IsolateStructureFailure ? err.code : 'failed';
        return { status: 'failed', summaryResult: `${SPLIT_BLOCK_TOOL} failed (${code}): ${errorMessage(err)}`, resultPayload: { status: 'error', success: false, code, message: errorMessage(err) } };
    }
}

export const splitBlockHandler: ToolHandler = (args, ctx) => runSplitBlockTool(args, ctx);

// re-exported for tests: the weld the piece check uses
export { weldVertices };
export type { BoundarySource };
