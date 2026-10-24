/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * location_building_shape: what Google's own data says about the shape of the building at a place, source by source.
 *
 * - Footprint and vector height: Google Vector Tiles (vectortiles.featuretiles, zoom 17, decoded by
 *   google-feature-tile-decoder.ts through GoogleVectorTileService). A building's extruded areas, its flat plan areas or,
 *   for a modeled 3D volume with no plan areas, the convex hull of the volume's base.
 * - Street level, main roof and peak: the Solar API DSM (dataLayers), measured inside each footprint and on nearby roads.
 * - Roof planes: Solar API buildingInsights roof segments (pitch, azimuth, plane height, area).
 * - Context (2026-10-23): the tiles' points of interest name the building (building-name.ts: a named POI inside the
 *   footprint), the land-use areas around it (parks, parking, forest, with Google's type codes as labels), the roads near
 *   it with their type codes, and, for a modelled volume, its roof prior (pipeline-e/volume-roof-prior.ts: the top
 *   surface as planes with pitch and fall, and its height tiers).
 * Each building's parts are fused with building-shape-fusion.ts (unchanged), and every source's value is reported beside
 * the others with the difference stated; nothing is averaged. A footprint is never made up: no vector building at the
 * place is a typed failure, not a guess. When no footprint contains the place point or lies within maxSnapMeters, a
 * footprint holding a POI named like the request within nameSearchMeters is taken instead (a landmark's address point is
 * often its gate or the road: Fallingwater's lies 116 m from the house), and the report says so.
 */

import * as path from 'path';
import type { ToolDeclaration, ToolHandler, ToolHandlerOutcome } from '../types';
import { PipelineError, LocationUnresolvedError } from '../../../../common/errors/pipeline-errors';
import { assertUsableCoordinates, formatCoordinates, parseCoordinateText } from '../../../../common/coordinate/parse-coordinates';
import { mapLimit } from '../../../../common/map-limit';
import { GoogleMapsService } from '../../../../browser/generative-canvas/services/google-maps-service';
import {
    GoogleVectorTileService,
    VectorTileUnavailableError,
    EarClippingTriangulator,
    type DecodedVectorTileData,
    type VectorFeaturePolygon
} from '../../../spatial/GoogleVectorTileService';
import type { DecodedModeledVolume } from '../../../spatial/google-feature-tile-decoder';
import { TILE_GRID } from '../../../spatial/google-feature-tile-decoder';
import { fetchSolarDsm, type DsmRaster } from '../../../spatial/solar-dsm';
import {
    convexHull,
    densifyRoads,
    fuseBuilding,
    RoadPointIndex,
    streetLevelNear,
    type FusedBuilding,
    type LngLat,
    type SolarRoofSegment
} from '../../../spatial/building-shape-fusion';
import { GltfBinaryPacker } from '../../../3d-engine/gltf-binary-packer';
import { checkDimensions, checkHeightForStoreys, plausibilitySummary, type PlausibilityFlag } from '../../../../common/spatial/plausibility';
import { decideBuildingNames, type BuildingNames } from '../../../3d-engine/staged-location/building-name';
import { placeWords } from '../../../3d-engine/staged-location/extraction-sizing';
import { volumeRoofPrior } from '../../../3d-engine/staged-location/pipeline-e/volume-roof-prior';

export const BUILDING_SHAPE_TOOL_NAME = 'location_building_shape';

/** Stable failure codes (diagnostic strings; open so new causes need no type edit). */
export type BuildingShapeErrorCode = 'geocode_failed' | 'missing_credentials' | 'no_coverage' | 'no_footprint' | 'vector_unavailable' | (string & {});

/** A typed failure of location_building_shape; `details` carries what was found (e.g. the nearest footprints). */
export class BuildingShapeError extends PipelineError {
    constructor(readonly code: BuildingShapeErrorCode, message: string, readonly details: Record<string, unknown> = {}) {
        super(message);
        this.name = 'BuildingShapeError';
    }
}

export interface BuildingShapeRequest {
    /** Place name, address or "lat, lng" (geocoded with Google Places when it is text). */
    location?: string;
    latitude?: number;
    longitude?: number;
    /** Also report the buildings whose footprint comes within this many metres of the target's footprint (default 0: none). */
    neighbourRadiusMeters?: number;
    /** How far outside a footprint the place point may be and still pick that building (default 12 m). */
    maxSnapMeters?: number;
    /**
     * When no footprint contains the place point or lies within maxSnapMeters, a footprint holding a POI named like the
     * request (word overlap with the query) within this distance is taken instead (default 150 m, max 300; 0 turns it off).
     */
    nameSearchMeters?: number;
    /** Write one extruded massing GLB of the buildings reported, from the vector data alone. */
    writeMassingGlb?: boolean;
    /** The target building's storey count when known (from the caller): its heights are checked against it. */
    storeys?: number;
    /** At most this many neighbours are reported, nearest first (default 25, at most 400). */
    maxNeighbours?: number;
    /** Ask the Solar API for each building's roof segments (default true; false skips buildingInsights, the DSM is still read). */
    roofSegments?: boolean;
    /** Where GLBs go (default <workspace>/public/models/building_shape). */
    outputDir?: string;
}

export interface BuildingShapeDeps {
    fetchImpl?: typeof fetch;
    /** Maps Platform key for geocoding and the Solar API; defaults to the configured key. */
    apiKey?: string;
    /** One decoded feature tile; defaults to GoogleVectorTileService.fetchVectorTile (service-account OAuth). */
    fetchTile?: (x: number, y: number, z: number) => Promise<DecodedVectorTileData>;
    progress?: (message: string, fraction?: number) => void;
}

type XY = [number, number];

const ZOOM = 17;
const M_PER_DEG_LAT = 111_320;
const MAX_NEIGHBOURS = 25;
/** A vertex this close to a tile edge (grid units of 1/4096 tile) was cut there by the tile. */
const EDGE_GRID = 1.5;

const r2 = (v: number) => Math.round(v * 100) / 100;
const r1 = (v: number) => Math.round(v * 10) / 10;
const r7 = (v: number) => Math.round(v * 1e7) / 1e7;

function pointInRing(x: number, y: number, ring: XY[]): boolean {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const [xi, yi] = ring[i], [xj, yj] = ring[j];
        if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
}

function distanceToRing(x: number, y: number, ring: XY[]): number {
    let best = Infinity;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const [ax, ay] = ring[j], [bx, by] = ring[i];
        const dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy || 1e-12;
        const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / len2));
        best = Math.min(best, Math.hypot(x - (ax + t * dx), y - (ay + t * dy)));
    }
    return best;
}

/** Smallest gap between two sets of rings (0 when they touch or overlap). */
function footprintGap(a: XY[][], b: XY[][]): number {
    let best = Infinity;
    for (const ra of a) for (const rb of b) {
        if (ra.some(p => pointInRing(p[0], p[1], rb)) || rb.some(p => pointInRing(p[0], p[1], ra))) return 0;
        for (const p of ra) best = Math.min(best, distanceToRing(p[0], p[1], rb));
        for (const p of rb) best = Math.min(best, distanceToRing(p[0], p[1], ra));
    }
    return best;
}

function ringArea(ring: XY[]): number {
    let a = 0;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) a += ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
    return Math.abs(a) / 2;
}

/** Small-area projection about the place point: x east, y north, metres (the frame of building-shape-fusion.ts). */
class LocalFrame {
    readonly kx: number;
    constructor(readonly lat0: number, readonly lng0: number) {
        this.kx = M_PER_DEG_LAT * Math.cos((lat0 * Math.PI) / 180);
    }
    toLocal([lng, lat]: LngLat): XY { return [(lng - this.lng0) * this.kx, (lat - this.lat0) * M_PER_DEG_LAT]; }
    toLngLat([x, y]: XY): LngLat { return [this.lng0 + x / this.kx, this.lat0 + y / M_PER_DEG_LAT]; }
}

function tileOf(lng: number, lat: number, z: number): { x: number; y: number } {
    const n = 2 ** z, r = (lat * Math.PI) / 180;
    return { x: Math.floor(((lng + 180) / 360) * n), y: Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n) };
}

/** Global grid coordinate (tile index * 4096 + position in the tile) of a point at zoom z. */
function globalGrid(lng: number, lat: number, z: number): XY {
    const n = 2 ** z, r = (lat * Math.PI) / 180;
    return [((lng + 180) / 360) * n * TILE_GRID, ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n * TILE_GRID];
}

/** One vector feature (all its pieces in one tile): extruded areas, flat plan areas, modeled volumes. */
interface FeatureRecord {
    key: string;
    tile: { x: number; y: number };
    extruded: VectorFeaturePolygon[];
    areas: VectorFeaturePolygon[];
    modeled: DecodedModeledVolume[];
}

const FEATURE_ID = /^(\d+\/\d+\/\d+\/f\d+)\/[eam]\d+$/;

function featureKey(id: string): string | undefined {
    return FEATURE_ID.exec(id)?.[1];
}

function collectFeatures(tiles: Array<{ x: number; y: number; data: DecodedVectorTileData }>): FeatureRecord[] {
    const records = new Map<string, FeatureRecord>();
    const get = (id: string, tile: { x: number; y: number }) => {
        const key = featureKey(id) ?? id;
        let r = records.get(key);
        if (!r) records.set(key, (r = { key, tile, extruded: [], areas: [], modeled: [] }));
        return r;
    };
    for (const t of tiles) {
        for (const b of t.data.buildings) if (b.ring.length >= 3) get(b.id, t).extruded.push(b);
        for (const a of t.data.buildingFootprints2D || []) if (a.ring.length >= 3) get(a.id, t).areas.push(a);
        for (const mv of t.data.modeledVolumes || []) {
            if (mv.vertices.length >= 3 && mv.indices.length >= 3 && mv.featureTypes.some(ty => /BUILDING/.test(ty))) get(mv.id, t).modeled.push(mv);
        }
    }
    return [...records.values()];
}

/** Every [lng, lat] of a feature (rings and modeled vertices). */
function featurePoints(r: FeatureRecord): LngLat[] {
    return [
        ...r.extruded.flatMap(p => p.ring as LngLat[]),
        ...r.areas.flatMap(p => p.ring as LngLat[]),
        ...r.modeled.flatMap(m => m.vertices.map(v => [v[0], v[1]] as LngLat))
    ];
}

/**
 * Pieces of one building cut apart by a tile edge arrive as separate features in neighbouring tiles. Two features
 * belong together when both have vertices on their shared tile edge over overlapping stretches of it.
 */
function joinAcrossTileEdges(records: FeatureRecord[]): FeatureRecord[][] {
    type Contact = { line: string; lo: number; hi: number };
    const contacts = records.map(r => {
        const pts = featurePoints(r).map(([lng, lat]) => globalGrid(lng, lat, ZOOM));
        const x0 = r.tile.x * TILE_GRID, y0 = r.tile.y * TILE_GRID;
        const out: Contact[] = [];
        const add = (line: string, along: number[]) => { if (along.length >= 2) out.push({ line, lo: Math.min(...along), hi: Math.max(...along) }); };
        add(`x${r.tile.x}`, pts.filter(p => p[0] - x0 <= EDGE_GRID).map(p => p[1]));
        add(`x${r.tile.x + 1}`, pts.filter(p => x0 + TILE_GRID - p[0] <= EDGE_GRID).map(p => p[1]));
        add(`y${r.tile.y}`, pts.filter(p => p[1] - y0 <= EDGE_GRID).map(p => p[0]));
        add(`y${r.tile.y + 1}`, pts.filter(p => y0 + TILE_GRID - p[1] <= EDGE_GRID).map(p => p[0]));
        return out;
    });
    const parent = records.map((_, i) => i);
    const find = (i: number): number => { while (parent[i] !== i) i = parent[i] = parent[parent[i]]; return i; };
    for (let i = 0; i < records.length; i++) {
        for (let j = i + 1; j < records.length; j++) {
            if (records[i].tile.x === records[j].tile.x && records[i].tile.y === records[j].tile.y) continue;
            const touch = contacts[i].some(a => contacts[j].some(b => a.line === b.line && Math.min(a.hi, b.hi) - Math.max(a.lo, b.lo) > 3));
            if (touch) parent[find(j)] = find(i);
        }
    }
    const groups = new Map<number, FeatureRecord[]>();
    records.forEach((r, i) => { const k = find(i); groups.set(k, [...(groups.get(k) || []), r]); });
    return [...groups.values()];
}

export interface FootprintPartReport {
    id: string;
    /** extruded_area: a 2.5D extrusion footprint; plan_area: a flat plan area of the building; modeled_base_hull: convex hull of a modeled volume's base. */
    kind: 'extruded_area' | 'plan_area' | 'modeled_base_hull';
    ringWgs84: LngLat[];
    /** [east, north] metres from the place point. */
    ringLocalMeters: XY[];
    /** Holes in the part (a courtyard, a light well), when the vector data draws them. */
    holesWgs84?: LngLat[][];
    /** Plan area of the ring less its holes. */
    areaM2: number;
    /** Vector top of this part above its base: extruded maxZ, or the highest modeled vertex over it. */
    vectorHeightMeters?: number;
    vectorMinHeightMeters?: number;
}

export interface RoofSegmentReport {
    pitchDegrees: number;
    azimuthDegrees: number;
    planeHeightMsl: number;
    planeHeightAboveStreetMeters?: number;
    areaM2: number;
    centerWgs84: LngLat;
    centerLocalMeters: XY;
}

export interface SourceComparison {
    vectorMeters?: number;
    vectorKind: string;
    dsmRoofMeters?: number;
    dsmPeakMeters?: number;
    solarRoofPlaneMaxMeters?: number;
    /** |vector - nearer of DSM roof or peak| (building-shape-fusion), on the part where it is largest. */
    vectorVsDsmMeters?: number;
    solarVsDsmRoofMeters?: number;
    toleranceMeters?: number;
    verdict: 'agree' | 'disagree' | 'cannot_compare';
    statement: string;
}

export interface BuildingReport {
    id: string;
    role: 'target' | 'neighbour';
    featureIds: string[];
    /** 0 when the place point is inside the footprint. */
    distanceFromPlaceMeters: number;
    /** Neighbours: the gap between this footprint and the target's (0 when they touch). */
    distanceFromTargetMeters?: number;
    containsPlacePoint: boolean;
    footprint: {
        chosen: FootprintPartReport['kind'];
        why: string;
        alternatives: string[];
        parts: FootprintPartReport[];
        areaM2: number;
        centroidWgs84: LngLat;
        centroidLocalMeters: XY;
        /** True when this building was joined from pieces in neighbouring vector tiles. */
        joinedAcrossTiles: boolean;
    };
    vector: {
        kind: 'extruded' | 'modeled' | 'footprint_only';
        heightMeters?: number;
        note: string;
        modeledGlbPath?: string;
    };
    solarDsm: {
        status: 'measured' | 'partial' | 'unavailable';
        reason?: string;
        imageryDate?: string;
        streetLevelMsl?: number;
        streetLevelSource?: 'roads' | 'band';
        roofMsl?: number;
        peakMsl?: number;
        roofAboveStreetMeters?: number;
        peakAboveStreetMeters?: number;
        coverage?: number;
    };
    solarInsights: {
        status: 'found' | 'other_building' | 'unavailable';
        reason?: string;
        solarBuildingName?: string;
        solarBuildingCenterWgs84?: LngLat;
        imageryDate?: string;
        segmentsTotal?: number;
    };
    roofSegments: RoofSegmentReport[];
    comparison: SourceComparison;
    /** building-shape-fusion's preferred height (DSM where it covers the footprint, else vector); the sources stay above. */
    fusion?: { heightMeters?: number; heightSource: FusedBuilding['heightSource']; confidence: FusedBuilding['confidence'] };
    /** Heights outside their typical range (plausibility.ts): flags only, the values above are unchanged. */
    plausibility: PlausibilityFlag[];
}

export interface BuildingShapeResult {
    place: { query?: string; resolvedAs: string; lat: number; lng: number; source: 'coordinates' | 'geocoded' };
    frame: string;
    target: BuildingReport;
    neighbours: BuildingReport[];
    neighbourRadiusMeters: number;
    sources: { vectorTiles: string; solarDsm: string; solarInsights: string };
    massingGlbPath?: string;
    massingNote?: string;
    /** What the tiles say around the target: names, POIs, land use, roads, and the modelled volume's roof prior. */
    context: BuildingShapeContext;
    summary: string;
}

/** The target's surroundings as Google's vector tiles carry them; type codes are labels (open vocabulary), never a switch. */
export interface BuildingShapeContext {
    names: BuildingNames;
    /** Named or typed points of interest within CONTEXT_REACH_M of the target's footprint, nearest first. */
    nearbyPois: Array<{ name?: string; types: string[]; distanceMeters: number; localMeters: XY }>;
    /** Land-use areas within CONTEXT_REACH_M of the target's footprint (gap 0: touching or overlapping it). */
    landuse: Array<{ types: string[]; areaM2: number; gapToTargetMeters: number }>;
    roads: { withinReach: number; types: string[] };
    /** The modelled volume's top surface, when Google modelled this building: planes and height tiers (metres above the volume's base). */
    volumeRoofPrior?: { planes: Array<{ pitchDeg: number; azimuthDeg: number; planAreaM2: number; areaM2: number; heightMeters: number }>; tiers: Array<{ heightMeters: number; planAreaM2: number }>; notes: string[] };
    note: string;
}

/** How far from the target's footprint the context (POIs, land use, roads) is reported (m). */
export const CONTEXT_REACH_M = 60;
/** A footprint holding a POI named like the request is taken from this far by default (m). */
export const NAME_SEARCH_DEFAULT_M = 150;

/** A building assembled from its vector features, with the footprint the tool chose. */
interface Candidate {
    id: string;
    features: FeatureRecord[];
    parts: FootprintPartReport[];
    partsLocal: XY[][];
    chosen: FootprintPartReport['kind'];
    why: string;
    alternatives: string[];
    vectorKind: BuildingReport['vector']['kind'];
    vectorHeight?: number;
    modeled: DecodedModeledVolume[];
    modeledMin: number;
    distance: number;
    contains: boolean;
    area: number;
    centroid: XY;
}

/** The holes the decoder found in a polygon (its loops after the outer one). */
function innerRingsOf(p: VectorFeaturePolygon): LngLat[][] {
    const inner = (p as VectorFeaturePolygon & { innerRings?: Array<Array<[number, number]>> }).innerRings;
    return Array.isArray(inner) ? inner.map(r => r as LngLat[]) : [];
}

function buildCandidate(group: FeatureRecord[], frame: LocalFrame): Candidate | undefined {
    const extruded = group.flatMap(f => f.extruded);
    const areas = group.flatMap(f => f.areas);
    const modeled = group.flatMap(f => f.modeled);
    const modeledMin = modeled.length ? Math.min(...modeled.map(m => m.minZMeters)) : 0;
    const modeledMax = modeled.length ? Math.max(...modeled.map(m => m.maxZMeters)) : 0;
    const part = (id: string, kind: FootprintPartReport['kind'], ring: LngLat[], h?: number, minH?: number, holes: LngLat[][] = []): FootprintPartReport => {
        const local = ring.map(p => frame.toLocal(p));
        const holesOk = holes.filter(hl => hl.length >= 3);
        return {
            id, kind,
            ringWgs84: ring.map(([a, b]) => [r7(a), r7(b)] as LngLat),
            ringLocalMeters: local.map(([a, b]) => [r2(a), r2(b)] as XY),
            ...(holesOk.length ? { holesWgs84: holesOk.map(hl => hl.map(([a, b]) => [r7(a), r7(b)] as LngLat)) } : {}),
            areaM2: r1(Math.max(0, ringArea(local) - holesOk.reduce((a, hl) => a + ringArea(hl.map(q => frame.toLocal(q))), 0))),
            ...(h !== undefined && h > 0 ? { vectorHeightMeters: r2(h) } : {}),
            ...(minH ? { vectorMinHeightMeters: r2(minH) } : {})
        };
    };
    const alternatives: string[] = [];
    let parts: FootprintPartReport[];
    let chosen: FootprintPartReport['kind'];
    let why: string;
    let vectorKind: BuildingReport['vector']['kind'];
    let vectorHeight: number | undefined;
    const hull = modeled.length ? convexHull(modeled.flatMap(m => m.vertices.filter(v => v[2] - modeledMin < 2).map(v => [v[0], v[1]] as LngLat))) : [];
    if (extruded.length) {
        parts = extruded.map(e => part(e.id, 'extruded_area', e.ring as LngLat[], Number(e.properties?.heightMeters), Number(e.properties?.minHeightMeters) || undefined, innerRingsOf(e)));
        chosen = 'extruded_area';
        why = `Google extrudes ${extruded.length === 1 ? 'this area' : `these ${extruded.length} areas`} to the building's modeled height, so ${extruded.length === 1 ? 'it is' : 'they are'} the footprint the vector height belongs to.`;
        vectorKind = 'extruded';
        const hs = parts.map(p => p.vectorHeightMeters).filter((h): h is number => h !== undefined);
        vectorHeight = hs.length ? Math.max(...hs) : undefined;
        if (areas.length) alternatives.push(`${areas.length} flat plan area(s), ${r1(areas.reduce((a, p) => a + ringArea((p.ring as LngLat[]).map(q => frame.toLocal(q))), 0))} m2, not used: the extruded areas carry the height`);
    } else if (modeled.length && areas.length) {
        const inside = (ring: XY[]) => modeled.flatMap(m => m.vertices.filter(v => pointInRing(...frame.toLocal([v[0], v[1]]), ring)).map(v => v[2]));
        parts = areas.map(a => {
            const zs = inside((a.ring as LngLat[]).map(q => frame.toLocal(q)));
            return part(a.id, 'plan_area', a.ring as LngLat[], zs.length ? Math.max(...zs) - modeledMin : undefined, undefined, innerRingsOf(a));
        });
        chosen = 'plan_area';
        why = `The building is a modeled 3D volume; its own flat plan area${areas.length === 1 ? ' is' : 's are'} the footprint (exact outline, unlike the convex hull of the volume's base).`;
        vectorKind = 'modeled';
        vectorHeight = modeledMax - modeledMin;
        if (hull.length >= 3) alternatives.push(`convex hull of the modeled volume's base, ${r1(ringArea(hull.map(q => frame.toLocal(q))))} m2, not used: a hull fills in concave corners`);
    } else if (modeled.length && hull.length >= 3) {
        parts = [part(`${modeled[0].id}/hull`, 'modeled_base_hull', hull, modeledMax - modeledMin)];
        chosen = 'modeled_base_hull';
        why = 'The building is a modeled 3D volume with no plan area in the vector data, so the footprint is the convex hull of its base (vertices within 2 m of its lowest point); concave corners are filled in.';
        vectorKind = 'modeled';
        vectorHeight = modeledMax - modeledMin;
    } else if (areas.length) {
        parts = areas.map(a => part(a.id, 'plan_area', a.ring as LngLat[], undefined, undefined, innerRingsOf(a)));
        chosen = 'plan_area';
        why = 'Only a flat plan area exists for this building in the vector data: a footprint with no height.';
        vectorKind = 'footprint_only';
    } else {
        return undefined;
    }
    const partsLocal = parts.map(p => (p.ringWgs84 as LngLat[]).map(q => frame.toLocal(q)));
    const contains = partsLocal.some(r => pointInRing(0, 0, r));
    const holeArea = parts.reduce((a, p) => a + (p.holesWgs84 ?? []).reduce((b, hl) => b + ringArea(hl.map(q => frame.toLocal(q))), 0), 0);
    const distance = contains ? 0 : Math.min(...partsLocal.map(r => distanceToRing(0, 0, r)));
    const area = Math.max(0, partsLocal.reduce((a, r) => a + ringArea(r), 0) - holeArea);
    const all = partsLocal.flat();
    const centroid: XY = [all.reduce((a, p) => a + p[0], 0) / all.length, all.reduce((a, p) => a + p[1], 0) / all.length];
    const featureIds = group.map(f => f.key);
    return {
        id: featureIds.join('+'), features: group, parts, partsLocal, chosen, why, alternatives, vectorKind,
        vectorHeight: vectorHeight !== undefined && vectorHeight > 0 ? vectorHeight : undefined,
        modeled, modeledMin, distance, contains, area, centroid
    };
}

function describeNearest(cands: Candidate[]): Array<{ id: string; distanceMeters: number; footprint: string; vectorHeightMeters?: number; partsWgs84: LngLat[][] }> {
    return [...cands].sort((a, b) => a.distance - b.distance).slice(0, 5).map(c => ({
        id: c.id, distanceMeters: r1(c.distance), footprint: c.chosen, ...(c.vectorHeight !== undefined ? { vectorHeightMeters: r2(c.vectorHeight) } : {}),
        partsWgs84: c.parts.map(p => p.ringWgs84)
    }));
}

/** Resolve the request to a place point. */
async function resolvePlace(req: BuildingShapeRequest, deps: BuildingShapeDeps): Promise<BuildingShapeResult['place']> {
    if (typeof req.latitude === 'number' && typeof req.longitude === 'number') {
        const label = formatCoordinates(req.latitude, req.longitude);
        try { assertUsableCoordinates(req.latitude, req.longitude, label); } catch (err) {
            throw new BuildingShapeError('geocode_failed', err instanceof Error ? err.message : String(err));
        }
        return { ...(req.location ? { query: req.location } : {}), resolvedAs: req.location ? `${req.location} (${label}, as given)` : label, lat: req.latitude, lng: req.longitude, source: 'coordinates' };
    }
    const query = (req.location || '').trim();
    if (!query) throw new BuildingShapeError('geocode_failed', 'Give a place name, an address, or latitude and longitude.');
    const coords = parseCoordinateText(query);
    if (coords) {
        try { assertUsableCoordinates(coords.lat, coords.lng, query); } catch (err) {
            throw new BuildingShapeError('geocode_failed', err instanceof Error ? err.message : String(err));
        }
        return { query, resolvedAs: formatCoordinates(coords.lat, coords.lng), lat: coords.lat, lng: coords.lng, source: 'coordinates' };
    }
    const key = GoogleVectorTileService.resolveApiKey(deps.apiKey);
    if (!key) {
        throw new BuildingShapeError('missing_credentials', `No Google Maps API key is configured, so "${query}" cannot be geocoded (add the key in Settings, or give latitude and longitude).`);
    }
    try {
        const place = await GoogleMapsService.getInstance().geocode(query, { apiKey: key, fetchImpl: deps.fetchImpl });
        const name = place.name && !place.formattedAddress.startsWith(place.name) ? `${place.name}, ${place.formattedAddress}` : place.formattedAddress;
        return { query, resolvedAs: name, lat: place.lat, lng: place.lng, source: 'geocoded' };
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        throw new BuildingShapeError('geocode_failed', err instanceof LocationUnresolvedError ? message : `Could not geocode "${query}": ${message}`);
    }
}

type FetchedTile = { x: number; y: number; data: DecodedVectorTileData };

/** Fetches the zoom-17 tiles covering a local [east, north] box that are not in `have` yet; returns all held tiles. */
async function fetchTiles(frame: LocalFrame, box: [number, number, number, number], have: Map<string, FetchedTile>, deps: BuildingShapeDeps): Promise<FetchedTile[]> {
    const [w, s0, e, n] = box;
    const nwLL = frame.toLngLat([w, n]), seLL = frame.toLngLat([e, s0]);
    const nw = tileOf(nwLL[0], nwLL[1], ZOOM), se = tileOf(seLL[0], seLL[1], ZOOM);
    const xy: Array<[number, number]> = [];
    for (let x = nw.x; x <= se.x; x++) for (let y = nw.y; y <= se.y; y++) if (!have.has(`${x}/${y}`)) xy.push([x, y]);
    const fetchTile = deps.fetchTile ?? ((x: number, y: number, z: number) => GoogleVectorTileService.fetchVectorTile(x, y, z, '', deps.fetchImpl ?? fetch));
    try {
        for (const t of await mapLimit(xy, 6, async ([x, y]) => ({ x, y, data: await fetchTile(x, y, ZOOM) }))) have.set(`${t.x}/${t.y}`, t);
        return [...have.values()];
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (/service account|service-account|HTTP 40[13]\b/i.test(message)) {
            throw new BuildingShapeError('missing_credentials', `Google vector tiles refused or lacked credentials: ${message}`);
        }
        if (/HTTP 404\b/.test(message)) throw new BuildingShapeError('no_coverage', `Google vector tiles have no tile here: ${message}`);
        if (err instanceof VectorTileUnavailableError) throw new BuildingShapeError('vector_unavailable', message);
        throw new BuildingShapeError('vector_unavailable', `Google vector tiles could not be fetched: ${message}`);
    }
}

/** The parts of a buildingInsights:findClosest answer this tool reads (the API's own JSON, unvalidated). */
interface SolarInsightsJson {
    name?: string;
    center?: { latitude?: number; longitude?: number };
    imageryDate?: { year?: number; month?: number; day?: number };
    solarPotential?: {
        roofSegmentStats?: Array<{
            pitchDegrees?: number;
            azimuthDegrees?: number;
            planeHeightAtCenterMeters?: number;
            center?: { latitude?: number; longitude?: number };
            stats?: { areaMeters2?: number };
        }>;
    };
}

function solarSegments(insights: SolarInsightsJson | undefined): SolarRoofSegment[] {
    const segs = insights?.solarPotential?.roofSegmentStats;
    if (!Array.isArray(segs)) return [];
    const out: SolarRoofSegment[] = [];
    for (const s of segs) {
        const h = s?.planeHeightAtCenterMeters, lat = s?.center?.latitude, lng = s?.center?.longitude;
        if (!Number.isFinite(h) || !Number.isFinite(lat) || !Number.isFinite(lng)) continue;
        out.push({
            pitchDegrees: Number(s.pitchDegrees) || 0,
            azimuthDegrees: Number(s.azimuthDegrees) || 0,
            planeHeightAtCenterMeters: h as number,
            center: { latitude: lat as number, longitude: lng as number },
            areaMeters2: Number(s.stats?.areaMeters2) || 0
        });
    }
    return out;
}

function dateOf(d: SolarInsightsJson['imageryDate']): string | undefined {
    return d?.year ? `${d.year}-${String(d.month).padStart(2, '0')}-${String(d.day).padStart(2, '0')}` : undefined;
}

/** Fused per part; the building reports its highest part's roof and the street level of its largest part. */
function reportBuilding(
    c: Candidate,
    role: BuildingReport['role'],
    frame: LocalFrame,
    dsm: (DsmRaster & { imageryDate?: string }) | undefined,
    dsmReason: string | undefined,
    insights: { data?: SolarInsightsJson; reason?: string },
    otherRings: LngLat[][],
    roads: RoadPointIndex,
    storeys?: number
): BuildingReport {
    const segments = solarSegments(insights.data);
    const fused = c.parts.map(p => fuseBuilding(
        { id: p.id, ring: p.ringWgs84, vectorHeightMeters: p.vectorHeightMeters, source: c.vectorKind === 'footprint_only' ? 'footprint' : c.vectorKind },
        dsm, segments, { neighbours: otherRings, roadPoints: roads, sampleSpacingMeters: 1 }
    ));
    const largest = fused[c.parts.reduce((bi, p, i) => (p.areaM2 > c.parts[bi].areaM2 ? i : bi), 0)];
    const groundMsl = largest.groundMsl ?? fused.find(f => f.groundMsl !== undefined)?.groundMsl;
    const groundSource = largest.groundMsl !== undefined ? largest.groundSource : fused.find(f => f.groundMsl !== undefined)?.groundSource;
    const measured = fused.filter(f => f.dsmRoofHeightMeters !== undefined);
    const top = measured.length ? measured.reduce((a, b) => (b.dsmRoofHeightMeters! > a.dsmRoofHeightMeters! ? b : a)) : undefined;
    const peak = measured.length ? Math.max(...measured.map(f => f.dsmPeakHeightMeters!)) : undefined;
    const coverage = fused.reduce((a, f, i) => a + f.dsmCoverage * c.parts[i].areaM2, 0) / Math.max(1e-9, c.parts.reduce((a, p) => a + p.areaM2, 0));
    const dsmStatus: BuildingReport['solarDsm']['status'] = !dsm ? 'unavailable' : measured.length === fused.length ? 'measured' : measured.length ? 'partial' : 'unavailable';
    const solarDsm: BuildingReport['solarDsm'] = {
        status: dsmStatus,
        ...(dsmStatus !== 'measured' ? { reason: !dsm ? dsmReason : measured.length ? `DSM covers ${measured.length} of ${fused.length} footprint parts (needs half the part and a street level)` : `The DSM does not cover this footprint well enough to measure it (coverage ${r2(coverage)})` } : {}),
        ...(dsm?.imageryDate ? { imageryDate: dsm.imageryDate } : {}),
        ...(groundMsl !== undefined ? { streetLevelMsl: r2(groundMsl), streetLevelSource: groundSource } : {}),
        ...(top ? { roofMsl: r2(top.roofMsl!), peakMsl: r2(Math.max(...measured.map(f => f.peakMsl!))), roofAboveStreetMeters: r2(top.dsmRoofHeightMeters!), peakAboveStreetMeters: r2(peak!) } : {}),
        ...(dsm ? { coverage: r2(coverage) } : {})
    };

    const ownSegments = new Set(fused.flatMap(f => f.roofSegments));
    const roofSegments: RoofSegmentReport[] = [...ownSegments].map(s => ({
        pitchDegrees: r1(s.pitchDegrees),
        azimuthDegrees: r1(s.azimuthDegrees),
        planeHeightMsl: r2(s.planeHeightAtCenterMeters),
        ...(groundMsl !== undefined ? { planeHeightAboveStreetMeters: r2(s.planeHeightAtCenterMeters - groundMsl) } : {}),
        areaM2: r1(s.areaMeters2),
        centerWgs84: [r7(s.center.longitude), r7(s.center.latitude)] as LngLat,
        centerLocalMeters: frame.toLocal([s.center.longitude, s.center.latitude]).map(r2) as XY
    }));
    const solarCenter = insights.data?.center && Number.isFinite(insights.data.center.latitude) ? [insights.data.center.longitude, insights.data.center.latitude] as LngLat : undefined;
    const solarInsights: BuildingReport['solarInsights'] = insights.data
        ? {
            status: roofSegments.length ? 'found' : 'other_building',
            ...(roofSegments.length ? {} : { reason: `The Solar API's closest building (${insights.data.name ?? 'unnamed'}) has no roof segment inside this footprint, so its segments belong to another building.` }),
            ...(insights.data.name ? { solarBuildingName: insights.data.name } : {}),
            ...(solarCenter ? { solarBuildingCenterWgs84: [r7(solarCenter[0]), r7(solarCenter[1])] as LngLat } : {}),
            ...(dateOf(insights.data.imageryDate) ? { imageryDate: dateOf(insights.data.imageryDate) } : {}),
            segmentsTotal: segments.length
        }
        : { status: 'unavailable', reason: insights.reason };

    // Side by side; the part with the largest vector-vs-DSM gap is the one reported (a disagreement is never hidden).
    const solarMax = roofSegments.length && groundMsl !== undefined ? Math.max(...roofSegments.map(s => s.planeHeightAboveStreetMeters!)) : undefined;
    const gaps = fused.filter(f => f.disagreementMeters !== undefined);
    const worst = gaps.length ? gaps.reduce((a, b) => (b.disagreementMeters! > a.disagreementMeters! ? b : a)) : undefined;
    const tolerance = worst?.heightMeters !== undefined ? Math.max(3, 0.05 * worst.heightMeters) : undefined;
    const solarVsDsm = solarMax !== undefined && top ? Math.abs(solarMax - top.dsmRoofHeightMeters!) : undefined;
    const vectorLabel = c.vectorKind === 'extruded' ? 'extruded top' : c.vectorKind === 'modeled' ? 'modeled volume height' : 'no vector height';
    const bits: string[] = [];
    bits.push(c.vectorHeight !== undefined ? `Vector ${vectorLabel} ${r1(c.vectorHeight)} m` : 'Vector data gives a footprint but no height');
    bits.push(top ? `Solar DSM main roof ${r1(top.dsmRoofHeightMeters!)} m and highest point ${r1(peak!)} m above street (street ${r1(groundMsl!)} m above sea level, measured on ${groundSource === 'roads' ? 'nearby roads' : 'a band around the footprint'})` : `no DSM measurement (${solarDsm.reason})`);
    bits.push(solarMax !== undefined ? `Solar roof planes up to ${r1(solarMax)} m above street (${roofSegments.length} segment${roofSegments.length === 1 ? '' : 's'})` : 'no Solar roof segments inside the footprint');
    let verdict: SourceComparison['verdict'] = 'cannot_compare';
    if (worst && tolerance !== undefined) {
        verdict = worst.disagreementMeters! <= tolerance ? 'agree' : 'disagree';
        const partNote = c.parts.length > 1 ? ` on part ${worst.id}` : '';
        bits.push(verdict === 'agree'
            ? `vector and DSM agree within ${r1(worst.disagreementMeters!)} m${partNote} (tolerance ${r1(tolerance)} m)`
            : `vector and DSM DISAGREE by ${r1(worst.disagreementMeters!)} m${partNote} (tolerance ${r1(tolerance)} m); both values are kept, not averaged`);
    } else {
        bits.push('vector and DSM cannot be compared (one of them is missing)');
    }
    if (solarVsDsm !== undefined) bits.push(`Solar roof planes and DSM main roof differ by ${r1(solarVsDsm)} m`);
    const comparison: SourceComparison = {
        ...(c.vectorHeight !== undefined ? { vectorMeters: r2(c.vectorHeight) } : {}),
        vectorKind: vectorLabel,
        ...(top ? { dsmRoofMeters: r2(top.dsmRoofHeightMeters!), dsmPeakMeters: r2(peak!) } : {}),
        ...(solarMax !== undefined ? { solarRoofPlaneMaxMeters: r2(solarMax) } : {}),
        ...(worst ? { vectorVsDsmMeters: r2(worst.disagreementMeters!) } : {}),
        ...(solarVsDsm !== undefined ? { solarVsDsmRoofMeters: r2(solarVsDsm) } : {}),
        ...(tolerance !== undefined ? { toleranceMeters: r2(tolerance) } : {}),
        verdict,
        statement: `${bits.join('; ')}.`
    };
    const pref = top ?? fused.find(f => f.heightMeters !== undefined);
    const plausibility = buildingPlausibility(c.vectorHeight, top?.dsmRoofHeightMeters, storeys);
    const vectorNote = c.vectorKind === 'extruded'
        ? 'Height of the extrusion top (maxZ) above its base, from the vector tile.'
        : c.vectorKind === 'modeled'
            ? 'Span of the modeled 3D volume from its lowest to its highest vertex (the tile\'s own height datum).'
            : 'The vector data has a footprint but no height for this building; none is assumed.';
    return {
        id: c.id,
        role,
        featureIds: c.features.map(f => f.key),
        distanceFromPlaceMeters: r1(c.distance),
        containsPlacePoint: c.contains,
        footprint: {
            chosen: c.chosen,
            why: c.why,
            alternatives: c.alternatives,
            parts: c.parts,
            areaM2: r1(c.area),
            centroidWgs84: frame.toLngLat(c.centroid).map(r7) as LngLat,
            centroidLocalMeters: c.centroid.map(r2) as XY,
            joinedAcrossTiles: c.features.length > 1 && new Set(c.features.map(f => `${f.tile.x}/${f.tile.y}`)).size > 1
        },
        vector: { kind: c.vectorKind, ...(c.vectorHeight !== undefined ? { heightMeters: r2(c.vectorHeight) } : {}), note: vectorNote },
        solarDsm,
        solarInsights,
        roofSegments,
        comparison,
        ...(pref ? { fusion: { ...(pref.heightMeters !== undefined ? { heightMeters: r2(pref.heightMeters) } : {}), heightSource: pref.heightSource, confidence: pref.confidence } } : {}),
        plausibility
    };
}

/** The vector and DSM heights against the building-height range, and against the storey count when it is known. */
export function buildingPlausibility(vectorHeightM: number | undefined, dsmRoofM: number | undefined, storeys?: number): PlausibilityFlag[] {
    const flags = checkDimensions([
        { dimension: 'buildingHeight', valueM: vectorHeightM, label: 'vector height', cause: 'vector data' },
        { dimension: 'buildingHeight', valueM: dsmRoofM, label: 'Solar DSM main roof height', cause: 'DSM or street level' }
    ]);
    if (storeys !== undefined) {
        for (const [h, label, cause] of [[vectorHeightM, 'vector height', 'vector height or storey count'], [dsmRoofM, 'Solar DSM main roof height', 'DSM or storey count']] as const) {
            const f = h !== undefined ? checkHeightForStoreys(h, storeys, { label, cause }) : undefined;
            if (f) flags.push(f);
        }
    }
    return flags;
}

interface MeshOut { name: string; positions: number[]; normals: number[]; indices: number[]; extras: Record<string, unknown> }

/** Writes meshes (y up, metres) as one GLB, one node per mesh, a single matte clay material. */
function writeMeshesGlb(file: string, meshes: MeshOut[], assetExtras: Record<string, unknown>): void {
    const views: Buffer[] = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- glTF JSON assembled field by field
    const gltf: any = {
        asset: { version: '2.0', generator: 'Scratchbox location_building_shape', extras: assetExtras },
        scene: 0,
        scenes: [{ nodes: meshes.map((_, i) => i) }],
        nodes: meshes.map((m, i) => ({ name: m.name, mesh: i, extras: m.extras })),
        materials: [{ name: 'clay', pbrMetallicRoughness: { baseColorFactor: [0.55, 0.57, 0.6, 1], metallicFactor: 0, roughnessFactor: 0.85 } }],
        meshes: [],
        accessors: [],
        bufferViews: []
    };
    for (const m of meshes) {
        const n = m.positions.length / 3;
        const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
        for (let i = 0; i < m.positions.length; i++) {
            min[i % 3] = Math.min(min[i % 3], m.positions[i]);
            max[i % 3] = Math.max(max[i % 3], m.positions[i]);
        }
        const base = gltf.accessors.length;
        views.push(Buffer.from(new Float32Array(m.positions).buffer), Buffer.from(new Float32Array(m.normals).buffer), Buffer.from(new Uint32Array(m.indices).buffer));
        gltf.bufferViews.push({ buffer: 0, byteOffset: 0, byteLength: 0, target: 34962 }, { buffer: 0, byteOffset: 0, byteLength: 0, target: 34962 }, { buffer: 0, byteOffset: 0, byteLength: 0, target: 34963 });
        gltf.accessors.push(
            { bufferView: base, componentType: 5126, count: n, type: 'VEC3', min, max },
            { bufferView: base + 1, componentType: 5126, count: n, type: 'VEC3' },
            { bufferView: base + 2, componentType: 5125, count: m.indices.length, type: 'SCALAR' }
        );
        gltf.meshes.push({ name: m.name, primitives: [{ attributes: { POSITION: base, NORMAL: base + 1 }, indices: base + 2, material: 0, mode: 4 }] });
    }
    GltfBinaryPacker.writeGlb(file, gltf, views);
}

/** Flat-shaded triangle soup builder. */
function soup(): { tri: (a: number[], b: number[], c: number[]) => void; mesh: (name: string, extras: Record<string, unknown>) => MeshOut } {
    const positions: number[] = [], normals: number[] = [], indices: number[] = [];
    return {
        tri(a, b, c) {
            const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2], vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
            let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
            const len = Math.hypot(nx, ny, nz);
            if (len < 1e-9) return;
            nx /= len; ny /= len; nz /= len;
            for (const p of [a, b, c]) { indices.push(positions.length / 3); positions.push(p[0], p[1], p[2]); normals.push(nx, ny, nz); }
        },
        mesh: (name, extras) => ({ name, positions, normals, indices, extras })
    };
}

/** The modeled volume as Google gives it, in the place frame (x east, y up from its lowest vertex, -z north). */
function modeledMesh(c: Candidate, frame: LocalFrame): MeshOut {
    const s = soup();
    for (const mv of c.modeled) {
        const pos = mv.vertices.map(([lng, lat, h]) => { const [x, y] = frame.toLocal([lng, lat]); return [x, h - c.modeledMin, -y]; });
        for (let t = 0; t + 2 < mv.indices.length; t += 3) {
            const a = pos[mv.indices[t]], b = pos[mv.indices[t + 1]], cc = pos[mv.indices[t + 2]];
            if (a && b && cc) s.tri(a, b, cc);
        }
    }
    return s.mesh(`modeled ${c.id}`, { source: 'from Google vector data (modeled volume)', featureIds: c.features.map(f => f.key) });
}

/** Footprint parts extruded from y = 0 to each part's vector height; parts without one are left out. */
function massingMesh(c: Candidate): MeshOut | undefined {
    const s = soup();
    let used = 0;
    c.partsLocal.forEach((ringIn, i) => {
        const h = c.parts[i].vectorHeightMeters;
        if (h === undefined || ringIn.length < 3) return;
        let ring = ringIn.slice();
        if (ring.length > 3 && Math.hypot(ring[0][0] - ring[ring.length - 1][0], ring[0][1] - ring[ring.length - 1][1]) < 1e-6) ring = ring.slice(0, -1);
        // counter-clockwise seen from above (x east, y north), so walls face outward
        let a2 = 0;
        for (let k = 0, j = ring.length - 1; k < ring.length; j = k++) a2 += ring[j][0] * ring[k][1] - ring[k][0] * ring[j][1];
        if (a2 < 0) ring.reverse();
        const top = (p: XY) => [p[0], h, -p[1]], bot = (p: XY) => [p[0], 0, -p[1]];
        for (let k = 0; k < ring.length; k++) {
            const p = ring[k], q = ring[(k + 1) % ring.length];
            s.tri(bot(p), bot(q), top(q));
            s.tri(bot(p), top(q), top(p));
        }
        // EarClippingTriangulator works in (x, z); feed north as z so its CCW test matches, then order roofs upward
        const caps = EarClippingTriangulator.triangulate(ring.map(([x, y]) => ({ x, z: y })));
        for (let k = 0; k + 2 < caps.length; k += 3) {
            const [p, q, r] = [ring[caps[k]], ring[caps[k + 1]], ring[caps[k + 2]]];
            const cross = (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
            if (cross >= 0) { s.tri(top(p), top(q), top(r)); s.tri(bot(p), bot(r), bot(q)); } else { s.tri(top(p), top(r), top(q)); s.tri(bot(p), bot(q), bot(r)); }
        }
        used++;
    });
    return used ? s.mesh(`massing ${c.id}`, { source: 'from Google vector data', footprint: c.chosen, vectorKind: c.vectorKind, featureIds: c.features.map(f => f.key) }) : undefined;
}

function slug(text: string): string {
    return text.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 48) || 'place';
}

/** The tiles' POIs in the local frame, with their names and type codes. */
function tilePois(tiles: FetchedTile[], frame: LocalFrame): Array<{ local: XY; name?: string; types: string[] }> {
    return tiles.flatMap(t => (t.data.pois ?? []).map(p => {
        const name = typeof p.properties?.name === 'string' && p.properties.name.trim() ? p.properties.name.trim() : undefined;
        const types = Array.isArray(p.properties?.types) ? (p.properties.types as unknown[]).filter((x): x is string => typeof x === 'string') : [];
        return { local: frame.toLocal(p.point as LngLat), ...(name ? { name } : {}), types };
    }));
}

/**
 * The candidate footprint within `reachM` of the place that holds (or comes within 5 m of) a POI whose name shares the
 * most words with the request; undefined when no named POI matches or none stands in a footprint.
 */
function namedFootprint(candidates: Candidate[], tiles: FetchedTile[], frame: LocalFrame, request: string, reachM: number): { candidate: Candidate; poiName: string; matched: string[] } | undefined {
    const words = placeWords(request);
    if (!words.length) return undefined;
    let best: { candidate: Candidate; poiName: string; matched: string[] } | undefined;
    for (const poi of tilePois(tiles, frame)) {
        if (!poi.name) continue;
        const matched = placeWords(poi.name).filter(w => words.includes(w));
        if (!matched.length) continue;
        for (const c of candidates) {
            if (c.distance > reachM) continue;
            const inside = c.partsLocal.some(ring => pointInRing(poi.local[0], poi.local[1], ring)) || c.partsLocal.some(ring => distanceToRing(poi.local[0], poi.local[1], ring) <= 5);
            if (!inside) continue;
            if (!best || matched.length > best.matched.length || (matched.length === best.matched.length && c.distance < best.candidate.distance)) best = { candidate: c, poiName: poi.name, matched };
        }
    }
    return best;
}

/** The target's surroundings from the tiles: names, POIs, land use, roads, and the modelled volume's roof prior. */
function buildContext(target: Candidate, tiles: FetchedTile[], frame: LocalFrame, query: string | undefined, address: string): BuildingShapeContext {
    // building-name.ts speaks the scan frame (x east, z south): local [east, north] → [east, -north]
    const toScan = ([e, n]: XY): [number, number] => [e, -n];
    const parts = target.partsLocal.map(ring => [ring.map(toScan)]);
    const pois = tilePois(tiles, frame);
    const names = decideBuildingNames({ parts, pois: pois.map(p => ({ x: p.local[0], z: -p.local[1], types: p.types, ...(p.name ? { name: p.name } : {}) })), query, address });
    const gapTo = (pt: XY) => Math.min(...target.partsLocal.map(ring => pointInRing(pt[0], pt[1], ring) ? 0 : distanceToRing(pt[0], pt[1], ring)));
    const nearbyPois = pois
        .map(p => ({ ...(p.name ? { name: p.name } : {}), types: p.types, distanceMeters: r1(gapTo(p.local)), localMeters: [r2(p.local[0]), r2(p.local[1])] as XY }))
        .filter(p => p.distanceMeters <= CONTEXT_REACH_M)
        .sort((a, b) => a.distanceMeters - b.distanceMeters);
    const landuse = tiles.flatMap(t => t.data.landuse ?? []).map(a => {
        const ring = (a.ring as LngLat[]).map(p => frame.toLocal(p));
        const types = Array.isArray(a.properties?.types) ? (a.properties.types as unknown[]).filter((x): x is string => typeof x === 'string') : [];
        return { types, areaM2: r1(ringArea(ring)), gapToTargetMeters: r1(footprintGap(target.partsLocal, [ring])) };
    }).filter(a => a.gapToTargetMeters <= CONTEXT_REACH_M).sort((a, b) => a.gapToTargetMeters - b.gapToTargetMeters);
    const roadLines = tiles.flatMap(t => t.data.roads.map(r => ({ pts: (r.points as LngLat[]).map(p => frame.toLocal(p)), types: Array.isArray(r.properties?.types) ? (r.properties.types as unknown[]).filter((x): x is string => typeof x === 'string') : [] })));
    const nearRoads = roadLines.filter(r => r.pts.some(pt => gapTo(pt) <= CONTEXT_REACH_M));
    const roads = { withinReach: nearRoads.length, types: [...new Set(nearRoads.flatMap(r => r.types))].sort() };
    let prior: BuildingShapeContext['volumeRoofPrior'];
    if (target.modeled.length) {
        const volumes = target.modeled.map(m => ({
            vertices: m.vertices.map(v => { const [e, n] = frame.toLocal([v[0], v[1]]); return [e, v[2] - target.modeledMin, -n] as [number, number, number]; }),
            indices: m.indices.slice()
        }));
        const p = volumeRoofPrior(volumes, 0);
        if (p) prior = {
            planes: p.planes.map(pl => ({ pitchDeg: r1(pl.pitchDeg), azimuthDeg: r1(pl.azimuthDeg), planAreaM2: r1(pl.planAreaM2), areaM2: r1(pl.areaM2), heightMeters: r2(pl.centreY) })),
            tiers: p.tiers.map(t => ({ heightMeters: r2(t.topY), planAreaM2: r1(t.planAreaM2) })),
            notes: p.notes
        };
    }
    const note = `${names.primary ? `Named '${names.primary}' (${names.names.find(n => n.name === names.primary)?.source === 'poi' ? 'a POI inside the footprint' : 'the request'}). ` : 'No POI inside the footprint names it. '}`
        + `${nearbyPois.length} POI${nearbyPois.length === 1 ? '' : 's'}, ${landuse.length} land-use area${landuse.length === 1 ? '' : 's'} and ${roads.withinReach} road line${roads.withinReach === 1 ? '' : 's'} within ${CONTEXT_REACH_M} m of the footprint; type codes are Google's labels, carried as given.`
        + (prior ? ` Modelled volume: ${prior.planes.length} roof plane${prior.planes.length === 1 ? '' : 's'}, ${prior.tiers.length} tier${prior.tiers.length === 1 ? '' : 's'}.` : '');
    return { names, nearbyPois, landuse, roads, ...(prior ? { volumeRoofPrior: prior } : {}), note };
}

/** The whole pipeline; the tool handler is a thin wrapper around it. */
export async function runBuildingShape(req: BuildingShapeRequest, deps: BuildingShapeDeps & { workspaceRoot: string }): Promise<BuildingShapeResult> {
    const progress = deps.progress ?? (() => undefined);
    const neighbourRadius = Math.max(0, Math.min(150, Number(req.neighbourRadiusMeters) || 0));
    const maxSnap = Math.max(0, Math.min(50, req.maxSnapMeters ?? 12));
    const nameSearch = Math.max(0, Math.min(300, req.nameSearchMeters ?? NAME_SEARCH_DEFAULT_M));
    const maxNeighbours = Math.max(0, Math.min(400, Math.round(req.maxNeighbours ?? MAX_NEIGHBOURS)));
    progress('Resolving the place', 0.05);
    const place = await resolvePlace(req, deps);
    const frame = new LocalFrame(place.lat, place.lng);

    // Fetch wide enough that a building within reach of the place point is whole.
    const searchRadius = Math.max(maxSnap + 60, nameSearch);
    const held = new Map<string, FetchedTile>();
    progress('Fetching Google vector tiles', 0.15);
    let tiles = await fetchTiles(frame, [-searchRadius, -searchRadius, searchRadius, searchRadius], held, deps);
    const features = collectFeatures(tiles);
    if (!features.length) {
        throw new BuildingShapeError('no_coverage', `Google's vector tiles have no buildings within ${Math.round(searchRadius)} m of ${place.resolvedAs} (${tiles.length} zoom-${ZOOM} tile${tiles.length === 1 ? '' : 's'} read).`, { place });
    }
    let candidates = joinAcrossTileEdges(features).map(g => buildCandidate(g, frame)).filter((c): c is Candidate => !!c);

    // Target: a footprint containing the place point (the most specific: has a height, then the smallest), else the
    // nearest within maxSnap. Never a made-up footprint.
    const containing = candidates.filter(c => c.contains).sort((a, b) => Number(b.vectorHeight !== undefined) - Number(a.vectorHeight !== undefined) || a.area - b.area);
    const byDistance = [...candidates].sort((a, b) => a.distance - b.distance);
    let target: Candidate | undefined = containing[0];
    const gapById = new Map<string, number>();
    let targetWhy: string;
    if (target) {
        targetWhy = containing.length > 1
            ? `The place point lies inside ${containing.length} footprints; chose ${target.id} (${target.vectorHeight !== undefined ? 'has a vector height, ' : ''}smallest area ${r1(target.area)} m2). Also containing it: ${containing.slice(1).map(c => c.id).join(', ')}.`
            : `The place point lies inside this footprint.`;
    } else if (byDistance[0] && byDistance[0].distance <= maxSnap) {
        target = byDistance[0];
        const next = byDistance[1];
        targetWhy = `No footprint contains the place point; chose the nearest, ${r1(target.distance)} m away (within ${maxSnap} m).`
            + (next && next.distance - target.distance < 3 ? ` Ambiguous: ${next.id} is ${r1(next.distance)} m away, almost as close.` : '');
    } else {
        // a footprint holding a POI named like the request, within nameSearch: the place's own building when its address
        // point lies off it (never a made-up footprint; without a name match the typed failure stands)
        const named = nameSearch > 0 ? namedFootprint(candidates, tiles, frame, place.query ?? place.resolvedAs, nameSearch) : undefined;
        if (named) {
            target = named.candidate;
            targetWhy = `No footprint contains the place point or lies within ${maxSnap} m of it; chose ${target.id}, ${r1(target.distance)} m away, because it holds the POI named '${named.poiName}' (${named.matched.join(', ')} match the request).`;
        } else {
            const nearest = describeNearest(candidates);
            throw new BuildingShapeError(
                'no_footprint',
                `No building footprint in Google's vector data contains ${place.resolvedAs} or lies within ${maxSnap} m of it`
                + (nearest.length ? `; the nearest is ${nearest[0].distanceMeters} m away (${nearest[0].id}).` : '.')
                + (nameSearch > 0 ? ` No POI named like the request stands in a footprint within ${nameSearch} m.` : '')
                + ' No footprint is invented for it.',
                { place, nearestFootprints: nearest }
            );
        }
    }
    // Neighbours: buildings whose footprint comes within the radius of the target's footprint. Widen the tiles so the
    // whole band (and the buildings reaching into it) is read, then rebuild the candidates on the larger set.
    let neighbours: Candidate[] = [];
    if (neighbourRadius > 0) {
        const pts = target.partsLocal.flat();
        const pad = neighbourRadius + 60;
        const box: [number, number, number, number] = [Math.min(...pts.map(p => p[0])) - pad, Math.min(...pts.map(p => p[1])) - pad, Math.max(...pts.map(p => p[0])) + pad, Math.max(...pts.map(p => p[1])) + pad];
        const before = tiles.length;
        tiles = await fetchTiles(frame, box, held, deps);
        if (tiles.length > before) {
            const key = target.features[0].key;
            candidates = joinAcrossTileEdges(collectFeatures(tiles)).map(g => buildCandidate(g, frame)).filter((c): c is Candidate => !!c);
            target = candidates.find(c => c.features.some(f => f.key === key))!;
        }
        const t = target;
        neighbours = candidates
            .filter(c => c !== t)
            .map(c => ({ c, gap: footprintGap(t.partsLocal, c.partsLocal) }))
            .filter(x => x.gap <= neighbourRadius)
            .sort((a, b) => a.gap - b.gap)
            .slice(0, maxNeighbours)
            .map(x => { gapById.set(x.c.id, x.gap); return x.c; });
    }
    const reported = [target, ...neighbours];

    // Solar API: one DSM around everything reported, and building insights per building.
    const apiKey = GoogleVectorTileService.resolveApiKey(deps.apiKey);
    const fetchImpl = deps.fetchImpl ?? fetch;
    const reach = Math.max(...reported.flatMap(c => c.partsLocal.flat().map(p => Math.hypot(p[0], p[1]))));
    const dsmRadius = Math.min(175, Math.max(60, Math.ceil(reach + 60)));
    let dsm: (DsmRaster & { imageryDate?: string }) | undefined;
    let dsmReason: string | undefined;
    progress('Fetching the Solar API DSM and roof segments', 0.4);
    const insightsP = mapLimit(reported, 4, async c => {
        if (req.roofSegments === false) return { reason: 'Roof segments were not asked for (roofSegments false).' };
        if (!apiKey) return { reason: 'No Google Maps API key is configured for the Solar API.' };
        const [lng, lat] = frame.toLngLat(c.centroid);
        try {
            return { data: await GoogleMapsService.getInstance().fetchBuildingSolarInsights({ lat, lng }, { apiKey, fetchImpl }) as SolarInsightsJson };
        } catch (err) {
            return { reason: err instanceof Error ? err.message : String(err) };
        }
    });
    if (!apiKey) dsmReason = 'No Google Maps API key is configured for the Solar API DSM.';
    else {
        try {
            dsm = await fetchSolarDsm(place.lat, place.lng, dsmRadius, apiKey, { fetchImpl });
        } catch (err) {
            dsmReason = err instanceof Error ? err.message : String(err);
        }
    }
    const insights = await insightsP;

    const roads = new RoadPointIndex(densifyRoads(tiles.flatMap(t => t.data.roads.map(r => r.points as LngLat[]))));
    const placeStreet = dsm ? streetLevelNear(dsm, place.lat, place.lng, roads, 80) : undefined;
    progress('Fusing the sources', 0.75);
    const allRings = candidates.map(c => c.parts.map(p => p.ringWgs84));
    const reports = reported.map((c, i) => {
        const others = candidates.flatMap((o, k) => (o === c ? [] : allRings[k]));
        const r = reportBuilding(c, i === 0 ? 'target' : 'neighbour', frame, dsm, dsmReason, insights[i], others, roads, i === 0 ? req.storeys : undefined);
        const gap = gapById.get(c.id);
        return gap === undefined ? r : { ...r, distanceFromTargetMeters: r1(gap) };
    });

    // GLBs: the modeled volume (as Google gives it) when there is one; an extruded massing when asked.
    const outDir = req.outputDir ?? path.join(deps.workspaceRoot, 'public', 'models', 'building_shape');
    const base = slug(place.query || place.resolvedAs);
    reported.forEach((c, i) => {
        if (!c.modeled.length) return;
        const file = path.join(outDir, `${base}_${i === 0 ? 'target' : `n${i}`}_modeled.glb`);
        writeMeshesGlb(file, [modeledMesh(c, frame)], { source: 'from Google vector data', place: place.resolvedAs, frame: 'metres; origin at the place point, y up from the lowest modeled vertex, x east, -z north' });
        reports[i].vector.modeledGlbPath = file;
    });
    let massingGlbPath: string | undefined;
    let massingNote: string | undefined;
    if (req.writeMassingGlb) {
        const built = reported.map(c => ({ c, mesh: massingMesh(c) }));
        const meshes = built.map(b => b.mesh).filter((m): m is MeshOut => !!m);
        const skipped = built.filter(b => !b.mesh).map(b => b.c.id);
        if (meshes.length) {
            massingGlbPath = path.join(outDir, `${base}_massing.glb`);
            writeMeshesGlb(massingGlbPath, meshes, {
                source: 'from Google vector data',
                place: place.resolvedAs,
                frame: 'metres; origin at the place point, flat base at y = 0 (not seated on terrain), x east, -z north',
                note: 'Footprints extruded to the vector heights only; no DSM or Solar values are used.'
            });
        }
        massingNote = `Extruded massing from Google vector data only (base y = 0, not seated on terrain): ${meshes.length} building${meshes.length === 1 ? '' : 's'}`
            + (skipped.length ? `; left out (no vector height, none assumed): ${skipped.join(', ')}` : '') + '.';
    }

    const t = reports[0];
    const summary = `${place.resolvedAs}: ${targetWhy} Footprint: ${t.footprint.chosen.replace(/_/g, ' ')}, ${t.footprint.parts.length} part${t.footprint.parts.length === 1 ? '' : 's'}, ${t.footprint.areaM2} m2. ${t.comparison.statement}`
        + (neighbours.length ? ` ${neighbours.length} neighbour${neighbours.length === 1 ? '' : 's'} within ${neighbourRadius} m of its footprint reported.` : '')
        + (t.plausibility.length ? ` ${plausibilitySummary(t.plausibility)}.` : '')
        + (reports.slice(1).some(r => r.plausibility.length) ? ` ${reports.slice(1).filter(r => r.plausibility.length).length} neighbour(s) carry plausibility warnings.` : '');
    const context = buildContext(target, tiles, frame, place.query, place.resolvedAs);
    progress('Done', 1);
    return {
        place,
        frame: 'Local metres are [east, north] from the place point; heights above street are DSM measurements minus the measured street level.',
        context,
        target: { ...t, footprint: { ...t.footprint, why: `${targetWhy} ${t.footprint.why}` } },
        neighbours: reports.slice(1),
        neighbourRadiusMeters: neighbourRadius,
        sources: {
            vectorTiles: `Google Vector Tiles (vectortiles.featuretiles, zoom ${ZOOM}, ${tiles.length} tile${tiles.length === 1 ? '' : 's'}, ${candidates.length} buildings within ${Math.round(searchRadius)} m)`,
            solarDsm: dsm ? `Solar API DSM, ${dsmRadius} m radius${dsm.imageryDate ? `, imagery ${dsm.imageryDate}` : ''}${placeStreet !== undefined ? `; street level at the place ${r2(placeStreet)} m above sea level` : ''}` : `unavailable: ${dsmReason}`,
            solarInsights: `Solar API buildingInsights:findClosest per building (${insights.filter(x => x.data).length} of ${insights.length} answered)`
        },
        ...(massingGlbPath ? { massingGlbPath } : {}),
        ...(massingNote ? { massingNote } : {}),
        summary
    };
}

export const BUILDING_SHAPE_TOOL_DECLARATION: ToolDeclaration = {
    name: BUILDING_SHAPE_TOOL_NAME,
    description: 'What Google\'s own data says about the shape of the building at a real place, source by source: its footprint polygon (WGS-84 and local metres) from Google vector tiles, the vector height (extruded or modeled) with the modeled volume as a GLB when there is one, street level and roof/peak heights measured by the Solar API DSM, and the Solar roof segments (pitch, azimuth, height, area). Every source\'s value is shown side by side with the disagreement stated, never averaged, and it says which footprint was chosen and why. Each building carries plausibility flags for heights outside their typical range (and against the storey count when given); flags only, no value is changed. Optionally reports neighbouring buildings and writes an extruded massing GLB from the vector data. When there is no building footprint at the place it fails with code no_footprint and lists the nearest ones; it never invents a footprint. Other failure codes: geocode_failed, missing_credentials, no_coverage, vector_unavailable. Also the context around it from the same tiles: the building\'s name from a POI inside its footprint, nearby POIs, land-use areas (parks, parking, forest; Google\'s type codes as labels), road lines with their types, and, for a modelled building, the volume\'s roof planes and height tiers. When no footprint contains the place point, one holding a POI named like the request within nameSearchMeters is taken and the report says so.',
    parameters: {
        type: 'OBJECT',
        properties: {
            location: { type: 'STRING', description: 'Place name or address (geocoded with Google Places), or "lat, lng". Optional when latitude and longitude are given.' },
            latitude: { type: 'NUMBER', description: 'WGS-84 latitude of the place point (with longitude; used instead of geocoding).' },
            longitude: { type: 'NUMBER', description: 'WGS-84 longitude of the place point.' },
            neighbourRadiusMeters: { type: 'NUMBER', description: 'Also report the buildings whose footprint comes within this many metres of the target building\'s footprint (default 0, max 150; at most 25 neighbours, nearest first).' },
            maxSnapMeters: { type: 'NUMBER', description: 'When no footprint contains the place point, the nearest within this distance is used (default 12 m, max 50).' },
            nameSearchMeters: { type: 'NUMBER', description: 'When neither rule finds a footprint, one holding a POI named like the request within this distance is taken (default 150 m, max 300; 0 turns it off). The result says which POI matched.' },
            writeMassingGlb: { type: 'BOOLEAN', description: 'Also write a clean extruded massing GLB of the reported buildings from the vector data alone (flat base, provenance "from Google vector data").' },
            storeys: { type: 'NUMBER', description: 'The target building\'s storey count, when known: its vector and DSM heights are checked against it (plausibility flags only, nothing is changed).' }
        }
    }
};

export const buildingShapeHandler: ToolHandler = async (args, ctx): Promise<ToolHandlerOutcome> => {
    try {
        const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
        const result = await runBuildingShape({
            location: typeof args.location === 'string' ? args.location : undefined,
            latitude: num(args.latitude),
            longitude: num(args.longitude),
            neighbourRadiusMeters: num(args.neighbourRadiusMeters),
            maxSnapMeters: num(args.maxSnapMeters),
            nameSearchMeters: num(args.nameSearchMeters),
            writeMassingGlb: args.writeMassingGlb === true,
            storeys: num(args.storeys)
        }, { workspaceRoot: ctx.workspaceRoot, progress: ctx.reportProgress });
        return { status: 'completed', summaryResult: result.summary, resultPayload: { status: 'success', ...result } };
    } catch (err) {
        if (err instanceof BuildingShapeError) {
            return {
                status: 'failed',
                summaryResult: `${BUILDING_SHAPE_TOOL_NAME} (${err.code}): ${err.message}`,
                resultPayload: { status: 'error', code: err.code, error: err.message, ...err.details }
            };
        }
        throw err;
    }
};
