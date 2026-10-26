/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import { mapLimit } from '../../common/map-limit';
import * as fs from 'fs-extra';
import * as path from 'path';
import { decodeFeatureTile, type DecodedModeledVolume } from './google-feature-tile-decoder';
import { fetchSolarDsm, type DsmRaster } from './solar-dsm';
import { convexHull, densifyRoads, fuseBuilding, RoadPointIndex, streetLevelNear, type FusedBuilding, type LngLat } from './building-shape-fusion';
import { geoidUndulation } from './egm96-geoid';
import type { TileMeshRaycaster } from './tile-mesh-raycast';
import { GltfBinaryPacker } from '../3d-engine/gltf-binary-packer';
import { LocalTangentPlane } from '../../common/coordinate/LocalTangentPlane';

/** The only variables this service reads; loading anything else from .env at import time would leak other
 *  credentials (e.g. a stale GEMINI_API_KEY) into the environment ahead of the server's own secrets handling. */
const LOCAL_ENV_KEYS = new Set(['MAP_TILES_API_KEY', 'GOOGLE_MAPS_API_KEY']);

function tryLoadLocalEnv(): void {
    if (typeof process === 'undefined' || !process.env) return;
    if (process.env.MAP_TILES_API_KEY || process.env.GOOGLE_MAPS_API_KEY) return;
    try {
        const candidates = [
            path.resolve(process.cwd(), '.env'),
            path.resolve(__dirname, '../../../../.env'),
            path.resolve(__dirname, '../../../../../.env')
        ];
        for (const envFile of candidates) {
            if (fs.existsSync(envFile)) {
                const lines = fs.readFileSync(envFile, 'utf8').split('\n');
                for (const line of lines) {
                    const trimmed = line.trim();
                    if (!trimmed || trimmed.startsWith('#')) continue;
                    const eq = trimmed.indexOf('=');
                    if (eq > 0) {
                        const k = trimmed.slice(0, eq).trim();
                        if (!LOCAL_ENV_KEYS.has(k)) continue;
                        let v = trimmed.slice(eq + 1).trim();
                        if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
                            v = v.slice(1, -1);
                        }
                        if (!process.env[k]) {
                            process.env[k] = v;
                        }
                    }
                }
                break;
            }
        }
    } catch {
        // Non-fatal if .env cannot be read
    }
}

tryLoadLocalEnv();

export const DEFAULT_GOOGLE_MAPS_API_KEY = (typeof process !== 'undefined'
    ? process.env?.MAP_TILES_API_KEY || process.env?.GOOGLE_MAPS_API_KEY || ''
    : '');

/** The tile source returned no vector data (wrong endpoint, raster tile, or HTTP error). */
export class VectorTileUnavailableError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'VectorTileUnavailableError';
    }
}

export interface VectorFeaturePolygon {
    id: string;
    type: 'Polygon';
    ring: Array<[number, number]>; // [lng, lat]
    properties: Record<string, any>;
}

export interface VectorFeatureLine {
    id: string;
    type: 'LineString';
    points: Array<[number, number]>; // [lng, lat]
    properties: Record<string, any>;
}

export interface VectorFeaturePoint {
    id: string;
    type: 'Point';
    point: [number, number]; // [lng, lat]
    properties: Record<string, any>;
}

export interface DecodedVectorTileData {
    buildings: VectorFeaturePolygon[];
    landuse: VectorFeaturePolygon[];
    water: VectorFeaturePolygon[];
    roads: VectorFeatureLine[];
    /** Rail centrelines (Google FEATURE_TYPE_RAIL lines). */
    rails?: VectorFeatureLine[];
    pois?: VectorFeaturePoint[];
    /** True 3D building meshes (enableModeledVolumes); vertices are [lng, lat, height above the building base]. */
    modeledVolumes?: DecodedModeledVolume[];
    /** Flat 2D building shapes without height (plan view of 3D buildings); for footprint tests, not extrusion. */
    buildingFootprints2D?: VectorFeaturePolygon[];
}

export interface VectorWorldStagingOptions {
    latitude: number;
    longitude: number;
    elevation?: number; // anchor ground elevation ASL/MSL in meters
    terrainElevationGrid?: ((x: number, z: number) => number) | {
        minX: number;
        maxX: number;
        minZ: number;
        maxZ: number;
        resolutionMeters: number;
        elevations: Float32Array | number[][];
    };
    zoom?: number; // default 16
    radiusTiles?: number; // default 1 (3x3 grid around center tile)
    buildingHeightScale?: number;
    includeRoads?: boolean;
    includeWater?: boolean;
    includePlinth?: boolean;
    style?: 'studio_clay' | 'architectural_white' | 'dark_slate' | (string & {});
    apiKey?: string;
    outputGlbPath?: string;
    fetchImpl?: typeof fetch;
    /**
     * Seat and size buildings from the Google Solar API DSM (measured street level and roof) fused with the vector
     * data. Default true; pass a raster to use it directly, or false to use vector heights on flat ground.
     */
    solarDsm?: DsmRaster | boolean;
    /** DSM radius when fetched (default 175 m, the area the Solar API serves around the anchor). */
    solarDsmRadiusMeters?: number;
    /**
     * Photorealistic 3D Tiles mesh of the area (an extracted GLB). Buildings are seated on its street surface,
     * measured on their nearby roads, so they sit flush with the tiles; base and roof residuals are reported.
     */
    tileMesh?: TileMeshRaycaster;
}

export interface TileAlignmentStats {
    buildingsSnapped: number;
    /** |tile street level - DSM street level| per building (both MSL), meters. */
    groundVsDsm?: { median: number; p90: number; n: number };
    /** |tile roof (median surface inside the footprint) - built roof top| per extruded building, meters. */
    roofVsBuilt?: { median: number; p90: number; n: number };
}

export interface VectorWorldFusionStats {
    /** Why fusion was skipped, if it was. */
    skipped?: string;
    dsmImageryDate?: string;
    buildingsFused: number;
    heightFromDsm: number;
    heightFromVector: number;
    confidence: { high: number; medium: number; low: number };
    /** Street level at the anchor (m above EGM96 mean sea level); local Y = 0. */
    anchorElevationMsl: number;
    /** EGM96 undulation at the anchor; Photorealistic 3D Tiles height = MSL + this. */
    geoidUndulationMeters: number;
    anchorEllipsoidHeightMeters: number;
}

export interface VectorWorldStagingStats {
    fusion?: VectorWorldFusionStats;
    tileAlignment?: TileAlignmentStats;
    buildingCount: number;
    /** Buildings drawn from Google's true 3D modeled volumes (part of buildingCount). */
    modeledVolumeCount?: number;
    /** Footprints with no height data, drawn flat rather than given an invented height. */
    flatFootprintCount?: number;
    roadSegmentCount: number;
    waterPolygonCount: number;
    vertexCount: number;
    triangleCount: number;
    minBounds: [number, number, number];
    maxBounds: [number, number, number];
}

export interface VectorWorldStagingResult {
    success: boolean;
    glbPath: string;
    glbUrl: string;
    stats: VectorWorldStagingStats;
    center: [number, number];
    zoom: number;
    tilesCount: number;
    style: string;
}

/**
 * Converts a position inside a Web Mercator tile ([0..extent] along x and y, extent = the tile's own grid, e.g. 4096) to
 * geodetic [lng, lat]. Pure tile arithmetic: used for tile bounds and tests, not tied to any tile encoding.
 */
export function mvtPointToLatLng(
    x: number,
    y: number,
    extent: number,
    tileX: number,
    tileY: number,
    zoom: number
): [number, number] {
    const numTiles = Math.pow(2, zoom);
    const normX = (tileX + x / extent) / numTiles;
    const normY = (tileY + y / extent) / numTiles;

    const lng = normX * 360 - 180;
    const latRad = Math.atan(Math.sinh(Math.PI * (1 - 2 * normY)));
    const lat = (latRad * 180) / Math.PI;

    return [lng, lat];
}

/**
 * Converts geodetic [lat, lng] to tile indices at zoom level.
 */
export function latLngToTile(lat: number, lng: number, zoom: number): { x: number; y: number } {
    const n = Math.pow(2, zoom);
    const x = Math.floor(((lng + 180) / 360) * n);
    const latRad = (lat * Math.PI) / 180;
    const y = Math.floor(((1 - Math.asinh(Math.tan(latRad)) / Math.PI) / 2) * n);
    return { x, y };
}

const ltpCache = new Map<string, LocalTangentPlane>();

export function getCachedLocalTangentPlane(lat: number, lng: number, alt: number = 0): LocalTangentPlane {
    const key = `${lat.toFixed(6)}_${lng.toFixed(6)}_${alt.toFixed(1)}`;
    let ltp = ltpCache.get(key);
    if (!ltp) {
        ltp = new LocalTangentPlane({ lat, lng, alt });
        if (ltpCache.size > 50) {
            ltpCache.clear();
        }
        ltpCache.set(key, ltp);
    }
    return ltp;
}

/**
 * Projects geodetic [lat, lng] to local ENU tangent plane meters [x, y, z] relative to anchor [anchorLat, anchorLng].
 * Backed by canonical LocalTangentPlane for 100% millimeter-precise alignment with Google 3D Photo Tiles.
 */
export function wgs84ToLocalEnu(
    lat: number,
    lng: number,
    anchorLat: number,
    anchorLng: number,
    anchorElevation: number = 0,
    pointElevation?: number,
    ltpInstance?: LocalTangentPlane
): { x: number; y: number; z: number } {
    const ltp = ltpInstance ?? getCachedLocalTangentPlane(anchorLat, anchorLng, anchorElevation);
    const local = ltp.toLocal({ lat, lng, alt: pointElevation ?? anchorElevation });
    return { x: local[0], y: local[1], z: local[2] };
}

/**
 * 2D Polygon triangulator using ear-clipping.
 */
export class EarClippingTriangulator {
    public static signedArea(poly: Array<{ x: number; z: number }>): number {
        if (poly.length < 3) return 0;
        let area = 0;
        for (let i = 0; i < poly.length; i++) {
            const j = (i + 1) % poly.length;
            area += poly[i].x * poly[j].z - poly[j].x * poly[i].z;
        }
        return area * 0.5;
    }

    public static triangulate(poly: Array<{ x: number; z: number }>): number[] {
        const indices: number[] = [];
        if (poly.length < 3) return indices;

        const V: number[] = [];
        for (let i = 0; i < poly.length; i++) V.push(i);

        const workingPoly = [...poly];
        if (this.signedArea(workingPoly) < 0) {
            workingPoly.reverse();
            V.reverse();
        }

        let n = workingPoly.length;
        let count = 2 * n;

        for (let v = n - 1; n > 2; ) {
            if (count-- <= 0) {
                // Degenerate/complex polygon fallback fan
                for (let i = 1; i < n - 1; i++) {
                    indices.push(V[0], V[i], V[i + 1]);
                }
                break;
            }

            let u = v;
            if (n <= u) u = 0;
            v = u + 1;
            if (n <= v) v = 0;
            let w = v + 1;
            if (n <= w) w = 0;

            const A = workingPoly[u];
            const B = workingPoly[v];
            const C = workingPoly[w];

            // Convex test
            const cross = (B.x - A.x) * (C.z - A.z) - (B.z - A.z) * (C.x - A.x);
            if (cross <= 1e-6) continue;

            // Ear test
            let isEar = true;
            for (let p = 0; p < n; p++) {
                if (p === u || p === v || p === w) continue;
                const pt = workingPoly[p];
                // Point in triangle test
                const c1 = (B.x - A.x) * (pt.z - A.z) - (B.z - A.z) * (pt.x - A.x);
                const c2 = (C.x - B.x) * (pt.z - B.z) - (C.z - B.z) * (pt.x - B.x);
                const c3 = (A.x - C.x) * (pt.z - C.z) - (A.z - C.z) * (pt.x - C.x);
                const hasNeg = c1 < 0 || c2 < 0 || c3 < 0;
                const hasPos = c1 > 0 || c2 > 0 || c3 > 0;
                if (!(hasNeg && hasPos)) {
                    isEar = false;
                    break;
                }
            }

            if (isEar) {
                indices.push(V[u], V[v], V[w]);
                workingPoly.splice(v, 1);
                V.splice(v, 1);
                n--;
                count = 2 * n;
            }
        }

        return indices;
    }
}

/**
 * Google vector feature tiles (vectortiles.featuretiles JSON: building footprints and modelled volumes, roads, rails, water,
 * land use and POIs, decoded by google-feature-tile-decoder.ts) and the 3D world populations staged from them. The tiles are
 * fetched with the app's service account (OAuth); the old Map Tiles session / MVT path is gone (that API no longer answers).
 */
/** Vector tiles fetched at once by the district builders (3x3 to 7x7 grids). */
export const VECTOR_TILE_FETCH_CONCURRENCY = 6;

export class GoogleVectorTileService {
    private static tileCache = new Map<string, DecodedVectorTileData>();
    /** One credential request shared by the tiles fetched together (see VECTOR_TILE_FETCH_CONCURRENCY). */
    private static pendingAuth?: { provider: () => Promise<{ token: string; project: string }>; promise: Promise<{ token: string; project: string }>; at: number };

    public static resolveApiKey(key?: string): string {
        tryLoadLocalEnv();
        return key || (typeof process !== 'undefined' ? process.env?.MAP_TILES_API_KEY || process.env?.GOOGLE_MAPS_API_KEY || '' : '') || DEFAULT_GOOGLE_MAPS_API_KEY;
    }

    /**
     * Fetches and decodes Google Vector Tiles (vectortiles.featuretiles JSON) for tile (x, y, z).
     */
    public static async fetchVectorTile(
        x: number,
        y: number,
        z: number,
        /** Not sent: feature tiles authenticate with the service account (the endpoint refuses API keys). Kept because callers pass it. */
        _apiKey: string,
        fetchImpl: typeof fetch = fetch
    ): Promise<DecodedVectorTileData> {
        const cacheKey = `${z}/${x}/${y}`;
        if (this.tileCache.has(cacheKey)) {
            return this.tileCache.get(cacheKey)!;
        }

        // Google Vector Tiles (vectortiles.featuretiles): JSON, OAuth through an allowlisted project (API keys get
        // "Method not found"); languageCode and regionCode are required.
        const auth = await this.sharedAuth();
        const params = new URLSearchParams({
            enableModeledVolumes: 'true',
            alwaysIncludeBuildingFootprints: 'false',
            languageCode: 'en-US',
            regionCode: 'US'
        });
        const res = await fetchImpl(`https://tile.googleapis.com/v1/vectortiles/featuretiles/${z}/${x}/${y}?${params}`, {
            headers: { Authorization: `Bearer ${auth.token}`, 'X-Goog-User-Project': auth.project }
        });
        const contentType = res.headers?.get?.('content-type') || '';
        if (!res.ok || !contentType.includes('json')) {
            const detail = await res.text().catch(() => '');
            throw new VectorTileUnavailableError(
                `Google vector tile ${z}/${x}/${y} unavailable (HTTP ${res.status}${contentType ? `, ${contentType}` : ''}): ${detail.slice(0, 200)}`
            );
        }
        const decoded = decodeFeatureTile(await res.json());
        const result: DecodedVectorTileData = {
            buildings: decoded.buildings,
            landuse: decoded.landuse,
            water: decoded.water,
            roads: decoded.roads,
            rails: decoded.rails,
            pois: decoded.pois,
            modeledVolumes: decoded.modeledVolumes,
            buildingFootprints2D: decoded.buildingFootprints2D
        };
        this.tileCache.set(cacheKey, result);
        return result;
    }

    /**
     * `authProvider`, shared: callers in flight together share one request, and the credential is reused for a few
     * minutes (service-account tokens last an hour), so a district's tiles cost one token request, not one each.
     */
    private static sharedAuth(): Promise<{ token: string; project: string }> {
        const provider = this.authProvider;
        const held = this.pendingAuth;
        if (held?.provider === provider && Date.now() - held.at < 5 * 60_000) return held.promise;
        const promise = provider();
        const entry = { provider, promise, at: Date.now() };
        this.pendingAuth = entry;
        promise.catch(() => { if (this.pendingAuth === entry) this.pendingAuth = undefined; });
        return promise;
    }

    /**
     * Credentials for vector tiles: the app's service account token and project. Tests replace this.
     */
    public static authProvider: () => Promise<{ token: string; project: string }> = async () => {
        const { GeminiClient } = await import('../gemini/gemini-client');
        const client = new GeminiClient();
        if (!client.ensureAuth()) throw new VectorTileUnavailableError('Google vector tiles need the Google Cloud service account (none is configured).');
        const t = (await client.getAccessToken()) as { token?: string | null };
        const project = (client as any).cachedProjectId as string | undefined;
        if (!t?.token || !project) throw new VectorTileUnavailableError('Could not get a service-account token for Google vector tiles.');
        return { token: t.token, project };
    };

    /**
     * Stages a complete 3D vector world population in 18% Studio Grey Clay.
     * Ingests Google vector feature tiles (footprints, modelled volumes, roads, water), extrudes building massing, road ribbons,
     * water basins, and packs them into a standard binary glTF 2.0 (.glb) for stage void placement.
     */
    public static async stage3DVectorWorld(options: VectorWorldStagingOptions): Promise<VectorWorldStagingResult> {
        const apiKey = this.resolveApiKey(options.apiKey);
        const fetchImpl = options.fetchImpl || fetch;
        const zoom = options.zoom ?? 16;
        const radius = options.radiusTiles ?? 1;
        const centerTile = latLngToTile(options.latitude, options.longitude, zoom);

        const allBuildings: VectorFeaturePolygon[] = [];
        const allRoads: VectorFeatureLine[] = [];
        const allWater: VectorFeaturePolygon[] = [];
        const allModeled = new Map<string, DecodedModeledVolume>();

        const tileXY: Array<[number, number]> = [];
        for (let dx = -radius; dx <= radius; dx++) for (let dy = -radius; dy <= radius; dy++) tileXY.push([centerTile.x + dx, centerTile.y + dy]);
        const tilesCount = tileXY.length;
        // Tiles are fetched in parallel (bounded) and merged in grid order, so the output matches a sequential loop.
        const fetched = await mapLimit(tileXY, VECTOR_TILE_FETCH_CONCURRENCY, ([tx, ty]) => this.fetchVectorTile(tx, ty, zoom, apiKey, fetchImpl));
        for (const tileData of fetched) {
            allBuildings.push(...tileData.buildings);
            for (const mv of tileData.modeledVolumes || []) allModeled.set(mv.id, mv);
            if (options.includeRoads !== false) {
                allRoads.push(...tileData.roads);
            }
            if (options.includeWater !== false) {
                allWater.push(...tileData.water);
            }
        }

        // Geometric builders
        const positions: number[] = [];
        const normals: number[] = [];
        const uvs: number[] = [];
        const indices: number[] = [];

        let currentVertexCount = 0;

        const addVertex = (
            x: number,
            y: number,
            z: number,
            nx: number,
            ny: number,
            nz: number,
            u: number,
            v: number
        ): number => {
            positions.push(x, y, z);
            normals.push(nx, ny, nz);
            uvs.push(u, v);
            return currentVertexCount++;
        };

        const minBounds: [number, number, number] = [Infinity, Infinity, Infinity];
        const maxBounds: [number, number, number] = [-Infinity, -Infinity, -Infinity];

        const expandBounds = (x: number, y: number, z: number) => {
            minBounds[0] = Math.min(minBounds[0], x);
            minBounds[1] = Math.min(minBounds[1], y);
            minBounds[2] = Math.min(minBounds[2], z);
            maxBounds[0] = Math.max(maxBounds[0], x);
            maxBounds[1] = Math.max(maxBounds[1], y);
            maxBounds[2] = Math.max(maxBounds[2], z);
        };

        const heightScale = options.buildingHeightScale ?? 1.0;

        // Measured surface (Solar DSM) fused with the vector data: street level per building from the DSM on
        // nearby roads, roof height from the DSM inside each footprint, vector height where the DSM has no cover.
        let dsm: DsmRaster | undefined;
        let fusionSkipped: string | undefined;
        if (options.solarDsm && typeof options.solarDsm === 'object') dsm = options.solarDsm;
        else if (options.solarDsm !== false) {
            try {
                dsm = await fetchSolarDsm(options.latitude, options.longitude, options.solarDsmRadiusMeters ?? 175, apiKey, { fetchImpl });
            } catch (err: any) {
                fusionSkipped = err?.message || String(err);
            }
        } else fusionSkipped = 'disabled';
        const roadPoints = new RoadPointIndex(dsm ? densifyRoads(allRoads.map(r => r.points as LngLat[])) : []);
        const measuredAnchor = dsm ? streetLevelNear(dsm, options.latitude, options.longitude, roadPoints, 80) : undefined;
        const anchorElevation = options.elevation ?? measuredAnchor ?? 0.0;
        const fusedStats = { fused: 0, dsm: 0, vector: 0, high: 0, medium: 0, low: 0 };
        const fuse = (id: string, ring: LngLat[], vectorHeight: number | undefined, source: 'extruded' | 'modeled'): FusedBuilding | undefined => {
            if (!dsm || ring.length < 3) return undefined;
            const f = fuseBuilding({ id, ring, vectorHeightMeters: vectorHeight, source }, dsm, [], { roadPoints, sampleSpacingMeters: 1 });
            if (f.groundMsl === undefined) return undefined;
            fusedStats.fused++;
            fusedStats[f.heightSource === 'dsm' ? 'dsm' : 'vector']++;
            fusedStats[f.confidence]++;
            return f;
        };

        // Prompt 5 of the alignment guide: seat each building on the 3D tile surface. A ray straight down at the
        // building centre hits its own roof in the photoreal mesh, so the street level is read on nearby roads.
        const tileRoadPoints = options.tileMesh ? (roadPoints.points.length ? roadPoints : new RoadPointIndex(densifyRoads(allRoads.map(r => r.points as LngLat[])))) : new RoadPointIndex([]);
        const groundDiffs: number[] = [], roofDiffs: number[] = [];
        let snapped = 0;
        const tileGroundMsl = (ring: LngLat[]): number | undefined => {
            if (!options.tileMesh) return undefined;
            const c = ring.reduce((a, p) => [a[0] + p[0] / ring.length, a[1] + p[1] / ring.length], [0, 0]);
            const kx = 111_320 * Math.cos((c[1] * Math.PI) / 180);
            const hits: number[] = [];
            for (const [lng, lat] of tileRoadPoints.near(c[0], c[1], 60)) {
                if (Math.hypot((lng - c[0]) * kx, (lat - c[1]) * 111_320) > 60) continue;
                const h = options.tileMesh.topHitMsl(lat, lng);
                if (h !== undefined) hits.push(h);
            }
            if (hits.length < 5) return undefined;
            hits.sort((a, b) => a - b);
            return hits[Math.floor(hits.length * 0.2)];
        };
        const tileRoofMsl = (ring: LngLat[]): number | undefined => {
            if (!options.tileMesh) return undefined;
            const lngs = ring.map(p => p[0]), lats = ring.map(p => p[1]);
            const lat0 = (Math.min(...lats) + Math.max(...lats)) / 2, kx = 111_320 * Math.cos((lat0 * Math.PI) / 180);
            const inRing = (lng: number, lat: number) => {
                let inside = false;
                for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
                    const [xi, yi] = ring[i], [xj, yj] = ring[j];
                    if ((yi > lat) !== (yj > lat) && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
                }
                return inside;
            };
            const hits: number[] = [];
            for (let lat = Math.min(...lats); lat <= Math.max(...lats); lat += 2 / 111_320) {
                for (let lng = Math.min(...lngs); lng <= Math.max(...lngs); lng += 2 / kx) {
                    if (!inRing(lng, lat)) continue;
                    const h = options.tileMesh.topHitMsl(lat, lng);
                    if (h !== undefined) hits.push(h);
                }
            }
            if (hits.length < 3) return undefined;
            hits.sort((a, b) => a - b);
            return hits[Math.floor(hits.length / 2)];
        };
        const ltp = getCachedLocalTangentPlane(options.latitude, options.longitude, anchorElevation);

        const sampleElevation = (x: number, z: number): number => {
            if (typeof options.terrainElevationGrid === 'function') {
                return options.terrainElevationGrid(x, z);
            }
            if (options.terrainElevationGrid && typeof options.terrainElevationGrid === 'object') {
                const grid = options.terrainElevationGrid;
                if (Array.isArray(grid.elevations) && grid.elevations.length > 0) {
                    const normX = Math.max(0, Math.min(1, (x - grid.minX) / (grid.maxX - grid.minX || 1)));
                    const gx = Math.min(grid.elevations.length - 1, Math.floor(normX * (grid.elevations.length - 1)));
                    const row = grid.elevations[gx];
                    if (Array.isArray(row) && row.length > 0) {
                        const normZ = Math.max(0, Math.min(1, (z - grid.minZ) / (grid.maxZ - grid.minZ || 1)));
                        const gz = Math.min(row.length - 1, Math.floor(normZ * (row.length - 1)));
                        return row[gz];
                    }
                }
            }
            return 0.0;
        };

        // 1. Extrude Buildings (70-20-10 Geometric Form Hierarchy)
        let buildingCount = 0;
        let flatFootprintCount = 0;
        for (const b of allBuildings) {
            if (b.ring.length < 3) continue;

            const localRing = b.ring.map(([lng, lat]) =>
                wgs84ToLocalEnu(lat, lng, options.latitude, options.longitude, anchorElevation, undefined, ltp)
            );

            // Height from the data only: Google's maxZ (heightMeters), else tagged height/levels. A footprint
            // with no height is drawn flat rather than given an invented one.
            let height = 0.2;
            if (typeof b.properties?.heightMeters === 'number' && b.properties.heightMeters > 0) {
                height = b.properties.heightMeters - (b.properties.minHeightMeters || 0);
            } else if (b.properties?.height) {
                height = parseFloat(b.properties.height);
            } else if (b.properties?.['building:levels']) {
                height = parseFloat(b.properties['building:levels']) * 3.5;
            } else if (b.properties?.levels) {
                height = parseFloat(b.properties.levels) * 3.5;
            } else {
                flatFootprintCount++;
            }
            const fused = fuse(b.id, b.ring as LngLat[], height > 0.2 ? height : undefined, 'extruded');
            if (fused?.heightMeters !== undefined) height = fused.heightMeters;
            height *= heightScale;

            const tileGround = tileGroundMsl(b.ring as LngLat[]);
            if (tileGround !== undefined) {
                snapped++;
                if (fused?.groundMsl !== undefined) groundDiffs.push(Math.abs(tileGround - fused.groundMsl));
                const tileRoof = tileRoofMsl(b.ring as LngLat[]);
                if (tileRoof !== undefined) roofDiffs.push(Math.abs(tileRoof - (tileGround + height)));
            }
            const groundMsl = tileGround ?? fused?.groundMsl;
            const groundElevations = groundMsl !== undefined
                ? localRing.map(() => groundMsl - anchorElevation)
                : localRing.map(p => sampleElevation(p.x, p.z));
            const minGroundY = Math.min(...groundElevations);
            const maxGroundY = Math.max(...groundElevations);
            // Skirt embeds slightly below ground so slope never exposes gaps
            const baseY = minGroundY - 0.5;
            const topY = maxGroundY + height;
            const n = localRing.length;

            // Walls
            let uCoord = 0.0;
            for (let i = 0; i < n; i++) {
                const next = (i + 1) % n;
                const p0 = localRing[i];
                const p1 = localRing[next];

                const dx = p1.x - p0.x;
                const dz = p1.z - p0.z;
                const segLen = Math.sqrt(dx * dx + dz * dz);
                if (segLen < 1e-4) continue;

                // Outward normal in XZ plane
                const nx = dz / segLen;
                const nz = -dx / segLen;

                const u0 = uCoord;
                const u1 = uCoord + segLen;
                uCoord = u1;

                const v0 = 0.0;
                const v1 = height / 3.5; // UV tiles per floor

                const vIdx0 = addVertex(p0.x, baseY, p0.z, nx, 0, nz, u0, v0);
                const vIdx1 = addVertex(p1.x, baseY, p1.z, nx, 0, nz, u1, v0);
                const vIdx2 = addVertex(p1.x, topY, p1.z, nx, 0, nz, u1, v1);
                const vIdx3 = addVertex(p0.x, topY, p0.z, nx, 0, nz, u0, v1);

                indices.push(vIdx0, vIdx1, vIdx2);
                indices.push(vIdx0, vIdx2, vIdx3);

                expandBounds(p0.x, baseY, p0.z);
                expandBounds(p1.x, topY, p1.z);
            }

            // Roof
            const roofTriangles = EarClippingTriangulator.triangulate(localRing);
            const roofStartIdx = currentVertexCount;
            for (let i = 0; i < n; i++) {
                const p = localRing[i];
                addVertex(p.x, topY, p.z, 0, 1, 0, p.x * 0.1, p.z * 0.1);
                expandBounds(p.x, topY, p.z);
            }

            for (const triIdx of roofTriangles) {
                indices.push(roofStartIdx + triIdx);
            }

            buildingCount++;
        }

        // 1b. Google's true 3D modeled volumes (buildings such as the Empire State Building that have no 2.5D
        // footprint in this request), seated on the measured street level. Flat-shaded triangles. A building split
        // across tiles arrives as several pieces in one shared height datum: pieces that touch are seated together by
        // their common lowest point (seating each by its own minimum offset the Flatiron's two halves by 0.29 m).
        let modeledVolumeCount = 0;
        const pieces = [...allModeled.values()].filter(mv => mv.vertices.length >= 3 && mv.indices.length >= 3);
        const pieceLocal = pieces.map(mv => mv.vertices.map(([lng, lat]) =>
            wgs84ToLocalEnu(lat, lng, options.latitude, options.longitude, anchorElevation, undefined, ltp)));
        const pieceBox = pieceLocal.map(l => ({
            minX: Math.min(...l.map(p => p.x)), maxX: Math.max(...l.map(p => p.x)),
            minZ: Math.min(...l.map(p => p.z)), maxZ: Math.max(...l.map(p => p.z))
        }));
        const pieceParent = pieces.map((_, i) => i);
        const findPiece = (i: number): number => { while (pieceParent[i] !== i) { pieceParent[i] = pieceParent[pieceParent[i]]; i = pieceParent[i]; } return i; };
        const touchMeters = 0.5;
        for (let i = 0; i < pieces.length; i++) {
            for (let j = i + 1; j < pieces.length; j++) {
                const a = pieceBox[i], b = pieceBox[j];
                if (a.minX - touchMeters <= b.maxX && b.minX - touchMeters <= a.maxX && a.minZ - touchMeters <= b.maxZ && b.minZ - touchMeters <= a.maxZ) {
                    pieceParent[findPiece(j)] = findPiece(i);
                }
            }
        }
        const pieceGroups = new Map<number, number[]>();
        pieces.forEach((_, i) => {
            const r = findPiece(i);
            if (!pieceGroups.has(r)) pieceGroups.set(r, []);
            pieceGroups.get(r)!.push(i);
        });
        for (const group of pieceGroups.values()) {
            const groupMin = Math.min(...group.map(i => pieces[i].minZMeters));
            const groupMax = Math.max(...group.map(i => pieces[i].maxZMeters));
            const groupPoints = group.flatMap(i => pieceLocal[i]);
            const cx = groupPoints.reduce((a, p) => a + p.x, 0) / groupPoints.length;
            const cz = groupPoints.reduce((a, p) => a + p.z, 0) / groupPoints.length;
            // A modeled volume keeps its own shape; fusion only seats it on the measured street level.
            const base = convexHull(group.flatMap(i => pieces[i].vertices.filter(v => v[2] - groupMin < 2).map(v => [v[0], v[1]] as LngLat)));
            const fusedMv = fuse(pieces[group[0]].id, base, groupMax - groupMin, 'modeled');
            const tileGroundMv = tileGroundMsl(base);
            if (tileGroundMv !== undefined) {
                snapped++;
                if (fusedMv?.groundMsl !== undefined) groundDiffs.push(Math.abs(tileGroundMv - fusedMv.groundMsl));
            }
            const mvGroundMsl = tileGroundMv ?? fusedMv?.groundMsl;
            const groundY = mvGroundMsl !== undefined ? mvGroundMsl - anchorElevation : sampleElevation(cx, cz);
            for (const i of group) {
                const mv = pieces[i];
                const pos = pieceLocal[i].map((p, k) => [p.x, groundY + (mv.vertices[k][2] - groupMin) * heightScale, p.z] as [number, number, number]);
                for (let t = 0; t + 2 < mv.indices.length; t += 3) {
                    const a = pos[mv.indices[t]], b2 = pos[mv.indices[t + 1]], c = pos[mv.indices[t + 2]];
                    if (!a || !b2 || !c) continue;
                    const ux = b2[0] - a[0], uy = b2[1] - a[1], uz = b2[2] - a[2];
                    const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
                    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
                    const len = Math.hypot(nx, ny, nz);
                    if (len < 1e-9) continue;
                    nx /= len; ny /= len; nz /= len;
                    for (const p of [a, b2, c]) {
                        indices.push(addVertex(p[0], p[1], p[2], nx, ny, nz, p[0] * 0.1, p[2] * 0.1));
                        expandBounds(p[0], p[1], p[2]);
                    }
                }
                modeledVolumeCount++;
            }
            buildingCount++;
        }

        // 2. Extrude Roads (as ground ribbons elevated slightly at y = 0.05 + ground elevation)
        let roadSegmentCount = 0;
        if (options.includeRoads !== false) {
            for (const r of allRoads) {
                if (r.points.length < 2) continue;

                const localPoints = r.points.map(([lng, lat]) =>
                    wgs84ToLocalEnu(lat, lng, options.latitude, options.longitude, anchorElevation, undefined, ltp)
                );

                const roadWidth = 6.0; // 6 meters wide road ribbon
                const roadYOffset = 0.05;

                for (let i = 0; i < localPoints.length - 1; i++) {
                    const p0 = localPoints[i];
                    const p1 = localPoints[i + 1];

                    const dx = p1.x - p0.x;
                    const dz = p1.z - p0.z;
                    const len = Math.sqrt(dx * dx + dz * dz);
                    if (len < 1e-4) continue;

                    const perpX = (-dz / len) * (roadWidth * 0.5);
                    const perpZ = (dx / len) * (roadWidth * 0.5);

                    const roadY0 = sampleElevation(p0.x, p0.z) + roadYOffset;
                    const roadY1 = sampleElevation(p1.x, p1.z) + roadYOffset;

                    const vIdx0 = addVertex(p0.x - perpX, roadY0, p0.z - perpZ, 0, 1, 0, 0, 0);
                    const vIdx1 = addVertex(p0.x + perpX, roadY0, p0.z + perpZ, 0, 1, 0, 1, 0);
                    const vIdx2 = addVertex(p1.x + perpX, roadY1, p1.z + perpZ, 0, 1, 0, 1, 1);
                    const vIdx3 = addVertex(p1.x - perpX, roadY1, p1.z - perpZ, 0, 1, 0, 0, 1);

                    indices.push(vIdx0, vIdx1, vIdx2);
                    indices.push(vIdx0, vIdx2, vIdx3);

                    expandBounds(p0.x, roadY0, p0.z);
                    expandBounds(p1.x, roadY1, p1.z);
                    roadSegmentCount++;
                }
            }
        }

        // 3. Extrude Water (as reflective basins at y = 0.02 + ground elevation)
        let waterPolygonCount = 0;
        if (options.includeWater !== false) {
            for (const w of allWater) {
                if (w.ring.length < 3) continue;

                const localRing = w.ring.map(([lng, lat]) =>
                    wgs84ToLocalEnu(lat, lng, options.latitude, options.longitude, anchorElevation, undefined, ltp)
                );

                const waterYOffset = 0.02;
                const waterTriangles = EarClippingTriangulator.triangulate(localRing);
                const waterStartIdx = currentVertexCount;

                for (const p of localRing) {
                    const waterY = sampleElevation(p.x, p.z) + waterYOffset;
                    addVertex(p.x, waterY, p.z, 0, 1, 0, p.x * 0.05, p.z * 0.05);
                    expandBounds(p.x, waterY, p.z);
                }

                for (const triIdx of waterTriangles) {
                    indices.push(waterStartIdx + triIdx);
                }
                waterPolygonCount++;
            }
        }

        // 4. Ground Plinth Disc (Studio Neutral Void Stage)
        if (options.includePlinth !== false) {
            const plinthRadius = Math.max(Math.abs(maxBounds[0] - minBounds[0]), Math.abs(maxBounds[2] - minBounds[2])) * 0.75 + 100;
            const segments = 64;
            const centerIdx = addVertex(0, 0, 0, 0, 1, 0, 0.5, 0.5);

            const ringStartIdx = currentVertexCount;
            for (let i = 0; i <= segments; i++) {
                const angle = (i / segments) * Math.PI * 2;
                const px = Math.cos(angle) * plinthRadius;
                const pz = Math.sin(angle) * plinthRadius;
                addVertex(px, 0, pz, 0, 1, 0, 0.5 + Math.cos(angle) * 0.5, 0.5 + Math.sin(angle) * 0.5);
                expandBounds(px, 0, pz);
            }

            for (let i = 0; i < segments; i++) {
                indices.push(centerIdx, ringStartIdx + i, ringStartIdx + i + 1);
            }
        }

        // Convert to typed arrays for glTF packing
        const posArray = new Float32Array(positions);
        const normArray = new Float32Array(normals);
        const uvArray = new Float32Array(uvs);
        const idxArray = new Uint32Array(indices);

        const posBuffer = Buffer.from(posArray.buffer);
        const normBuffer = Buffer.from(normArray.buffer);
        const uvBuffer = Buffer.from(uvArray.buffer);
        const idxBuffer = Buffer.from(idxArray.buffer);

        // Define glTF document structure conforming to 18% Studio Grey Clay
        const gltf = {
            asset: { version: '2.0', generator: 'Scratchbox 3D Vector World Staging Engine' },
            scenes: [{ nodes: [0] }],
            scene: 0,
            nodes: [{ name: 'VectorWorldRoot', mesh: 0 }],
            materials: [
                {
                    name: 'StudioGreyClay',
                    pbrMetallicRoughness: {
                        baseColorFactor: [0.55, 0.57, 0.60, 1.0], // 18% Studio Grey Clay
                        metallicFactor: 0.0,
                        roughnessFactor: 0.85
                    },
                    doubleSided: false
                }
            ],
            meshes: [
                {
                    name: 'VectorWorldMesh',
                    primitives: [
                        {
                            attributes: {
                                POSITION: 0,
                                NORMAL: 1,
                                TEXCOORD_0: 2
                            },
                            indices: 3,
                            material: 0,
                            mode: 4 // TRIANGLES
                        }
                    ]
                }
            ],
            accessors: [
                {
                    bufferView: 0,
                    byteOffset: 0,
                    componentType: 5126, // FLOAT
                    count: currentVertexCount,
                    type: 'VEC3',
                    min: [minBounds[0], minBounds[1], minBounds[2]],
                    max: [maxBounds[0], maxBounds[1], maxBounds[2]]
                },
                {
                    bufferView: 1,
                    byteOffset: 0,
                    componentType: 5126, // FLOAT
                    count: currentVertexCount,
                    type: 'VEC3',
                    min: [-1, -1, -1],
                    max: [1, 1, 1]
                },
                {
                    bufferView: 2,
                    byteOffset: 0,
                    componentType: 5126, // FLOAT
                    count: currentVertexCount,
                    type: 'VEC2',
                    min: [0, 0],
                    max: [1, 1]
                },
                {
                    bufferView: 3,
                    byteOffset: 0,
                    componentType: 5125, // UNSIGNED_INT
                    count: indices.length,
                    type: 'SCALAR',
                    min: [0],
                    max: [Math.max(0, currentVertexCount - 1)]
                }
            ],
            bufferViews: [
                { buffer: 0, byteOffset: 0, byteLength: posBuffer.length, target: 34962 }, // ARRAY_BUFFER
                { buffer: 0, byteOffset: 0, byteLength: normBuffer.length, target: 34962 },
                { buffer: 0, byteOffset: 0, byteLength: uvBuffer.length, target: 34962 },
                { buffer: 0, byteOffset: 0, byteLength: idxBuffer.length, target: 34963 } // ELEMENT_ARRAY_BUFFER
            ]
        };

        const bufferViews = [posBuffer, normBuffer, uvBuffer, idxBuffer];

        const cleanLat = options.latitude.toFixed(4).replace('.', '_');
        const cleanLng = options.longitude.toFixed(4).replace('.', '_');
        const defaultOutDir = path.resolve(process.cwd(), 'public/models');
        await fs.mkdirp(defaultOutDir);

        const outPath = options.outputGlbPath || path.resolve(defaultOutDir, `vector_world_${cleanLat}_${cleanLng}.glb`);
        GltfBinaryPacker.writeGlb(outPath, gltf, bufferViews);

        const glbUrl = `/models/${path.basename(outPath)}`;

        return {
            success: true,
            glbPath: outPath,
            glbUrl,
            stats: {
                buildingCount,
                modeledVolumeCount,
                flatFootprintCount,
                tileAlignment: options.tileMesh ? (() => {
                    const summary = (d: number[]) => {
                        if (!d.length) return undefined;
                        const sorted = [...d].sort((a, b) => a - b);
                        return { median: sorted[Math.floor(sorted.length / 2)], p90: sorted[Math.floor(sorted.length * 0.9)], n: sorted.length };
                    };
                    return { buildingsSnapped: snapped, groundVsDsm: summary(groundDiffs), roofVsBuilt: summary(roofDiffs) };
                })() : undefined,
                fusion: (() => {
                    const n = geoidUndulation(options.latitude, options.longitude);
                    return {
                        skipped: fusionSkipped,
                        dsmImageryDate: (dsm as { imageryDate?: string } | undefined)?.imageryDate,
                        buildingsFused: fusedStats.fused,
                        heightFromDsm: fusedStats.dsm,
                        heightFromVector: fusedStats.vector,
                        confidence: { high: fusedStats.high, medium: fusedStats.medium, low: fusedStats.low },
                        anchorElevationMsl: anchorElevation,
                        geoidUndulationMeters: n,
                        anchorEllipsoidHeightMeters: anchorElevation + n
                    };
                })(),
                roadSegmentCount,
                waterPolygonCount,
                vertexCount: currentVertexCount,
                triangleCount: Math.floor(indices.length / 3),
                minBounds,
                maxBounds
            },
            center: [options.latitude, options.longitude],
            zoom,
            tilesCount,
            style: options.style || 'studio_clay'
        };
    }

    /**
     * Extracts a topological VectorFeatureGraph around (lat, lng) with SI metric coordinates.
     */
    public static async getVectorFeatureGraph(options: {
        latitude: number;
        longitude: number;
        zoom?: number;
        radiusTiles?: number;
        apiKey?: string;
        fetchImpl?: typeof fetch;
    }): Promise<any> {
        const { VectorWorldPopulatorService } = await import('./VectorWorldPopulatorService');
        const apiKey = this.resolveApiKey(options.apiKey);
        const fetchImpl = options.fetchImpl || fetch;
        const zoom = options.zoom ?? 16;
        const radius = options.radiusTiles ?? 1;
        const centerTile = latLngToTile(options.latitude, options.longitude, zoom);

        const merged: DecodedVectorTileData = {
            buildings: [],
            landuse: [],
            water: [],
            roads: []
        };

        for (let dx = -radius; dx <= radius; dx++) {
            for (let dy = -radius; dy <= radius; dy++) {
                const tx = centerTile.x + dx;
                const ty = centerTile.y + dy;
                const tileData = await this.fetchVectorTile(tx, ty, zoom, apiKey, fetchImpl);
                merged.buildings.push(...tileData.buildings);
                merged.roads.push(...tileData.roads);
                merged.water.push(...tileData.water);
                merged.landuse.push(...tileData.landuse);
            }
        }

        return VectorWorldPopulatorService.extractFeatureGraph(options.latitude, options.longitude, merged);
    }

    /**
     * Stages a fully populated 3D world with road cross-sections, beveled curbs, sidewalks,
     * streetlamps, botanical trees, and traffic streams.
     */
    public static async populate3DVectorWorld(options: any): Promise<any> {
        const { VectorWorldPopulatorService } = await import('./VectorWorldPopulatorService');
        return VectorWorldPopulatorService.generatePopulatedWorld(options);
    }
}
