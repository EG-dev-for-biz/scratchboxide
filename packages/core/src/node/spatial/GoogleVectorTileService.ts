/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import * as fs from 'fs-extra';
import * as path from 'path';
import Pbf from 'pbf';
import { VectorTile } from '@mapbox/vector-tile';
import { GltfBinaryPacker } from '../3d-engine/gltf-binary-packer';
import { LocalTangentPlane } from '../../common/coordinate/LocalTangentPlane';

export const DEFAULT_GOOGLE_MAPS_API_KEY = 'AIzaSyCSHRfQGTmZykmM4LA6mI7avjEQEkQive4';

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

export interface DecodedVectorTileData {
    buildings: VectorFeaturePolygon[];
    landuse: VectorFeaturePolygon[];
    water: VectorFeaturePolygon[];
    roads: VectorFeatureLine[];
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
}

export interface VectorWorldStagingStats {
    buildingCount: number;
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
 * Converts MVT tile coordinates [0..extent] to geodetic [lng, lat].
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
 * Service for ingesting Google 2D roadmap vector tiles and staging 3D world populations.
 */
export class GoogleVectorTileService {
    private static sessionToken: string | null = null;
    private static sessionPromise: Promise<string | null> | null = null;
    private static tileCache = new Map<string, DecodedVectorTileData>();

    public static resolveApiKey(key?: string): string {
        return key || process.env.MAP_TILES_API_KEY || process.env.GOOGLE_MAPS_API_KEY || DEFAULT_GOOGLE_MAPS_API_KEY;
    }

    /**
     * Obtains an active Map Tiles API session token for 2D roadmap vector tiles.
     */
    public static async getSessionToken(apiKey: string, fetchImpl: typeof fetch = fetch): Promise<string | null> {
        if (this.sessionToken) return this.sessionToken;
        if (this.sessionPromise) return this.sessionPromise;

        this.sessionPromise = (async () => {
            try {
                if (!apiKey) return null;
                const url = `https://tile.googleapis.com/v1/createSession?key=${apiKey}`;
                const res = await fetchImpl(url, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        mapType: 'roadmap',
                        language: 'en-US',
                        region: 'US',
                        overlay: true
                    })
                });

                if (!res.ok) {
                    console.warn(`[GoogleVectorTileService] createSession returned status ${res.status}`);
                    return null;
                }

                const json = (await res.json()) as any;
                this.sessionToken = json?.session || null;
                return this.sessionToken;
            } catch (err: any) {
                console.warn(`[GoogleVectorTileService] Failed to create vector tile session: ${err?.message}`);
                return null;
            }
        })();

        return this.sessionPromise;
    }

    /**
     * Fetches and decodes MVT protobuf data for tile (x, y, z).
     */
    public static async fetchVectorTile(
        x: number,
        y: number,
        z: number,
        apiKey: string,
        fetchImpl: typeof fetch = fetch
    ): Promise<DecodedVectorTileData> {
        const emptyResult: DecodedVectorTileData = {
            buildings: [],
            landuse: [],
            water: [],
            roads: []
        };

        const cacheKey = `${z}/${x}/${y}`;
        if (this.tileCache.has(cacheKey)) {
            return this.tileCache.get(cacheKey)!;
        }

        try {
            const session = await this.getSessionToken(apiKey, fetchImpl);
            const url = session
                ? `https://tile.googleapis.com/v1/2d/tiles/${z}/${x}/${y}?session=${session}&key=${apiKey}`
                : `https://tile.googleapis.com/v1/2d/vectortiles/${z}/${x}/${y}?key=${apiKey}`;

            const res = await fetchImpl(url);
            if (!res.ok) {
                return emptyResult;
            }

            const arrayBuffer = await res.arrayBuffer();
            const decoded = this.decodeTileBuffer(arrayBuffer, x, y, z);
            this.tileCache.set(cacheKey, decoded);
            return decoded;
        } catch (err: any) {
            console.warn(`[GoogleVectorTileService] Error fetching tile ${z}/${x}/${y}: ${err?.message}`);
            return emptyResult;
        }
    }

    /**
     * Decodes Mapbox Vector Tile (.mvt / .pbf) buffer into structured building, road, and water features.
     */
    public static decodeTileBuffer(
        buffer: ArrayBuffer,
        tileX: number,
        tileY: number,
        zoom: number
    ): DecodedVectorTileData {
        const result: DecodedVectorTileData = {
            buildings: [],
            landuse: [],
            water: [],
            roads: []
        };

        if (!buffer || buffer.byteLength === 0) return result;

        try {
            const PbfConstructor = typeof Pbf === 'function' ? Pbf : (Pbf as any).default || Pbf;
            const pbf = new PbfConstructor(new Uint8Array(buffer));
            const tile = new VectorTile(pbf as any);

            for (const layerName of Object.keys(tile.layers)) {
                const layer = tile.layers[layerName];
                if (!layer) continue;

                const lowerName = layerName.toLowerCase();
                const isBuildingLayer = lowerName.includes('building') || lowerName.includes('structure');
                const isLanduseLayer = lowerName.includes('landuse') || lowerName.includes('park') || lowerName.includes('green');
                const isWaterLayer = lowerName.includes('water');
                const isRoadLayer = lowerName.includes('road') || lowerName.includes('transport') || lowerName.includes('street');

                for (let i = 0; i < layer.length; i++) {
                    const feature = layer.feature(i);
                    const props = feature.properties || {};
                    const rawGeom = feature.loadGeometry();
                    if (!rawGeom || rawGeom.length === 0) continue;

                    // Type 3 = Polygon, Type 2 = LineString
                    if (feature.type === 3) {
                        for (const ringPts of rawGeom) {
                            if (ringPts.length < 3) continue;
                            const ring: Array<[number, number]> = ringPts.map(p =>
                                mvtPointToLatLng(p.x, p.y, layer.extent, tileX, tileY, zoom)
                            );

                            const polygonFeature: VectorFeaturePolygon = {
                                id: `${layerName}-${i}-${ring.length}`,
                                type: 'Polygon',
                                ring,
                                properties: props
                            };

                            if (isBuildingLayer || props.type === 'building') {
                                result.buildings.push(polygonFeature);
                            } else if (isLanduseLayer || props.class === 'park' || props.type === 'park' || props.class === 'grass') {
                                result.landuse.push(polygonFeature);
                            } else if (isWaterLayer || props.class === 'water') {
                                result.water.push(polygonFeature);
                            }
                        }
                    } else if (feature.type === 2) {
                        for (const linePts of rawGeom) {
                            if (linePts.length < 2) continue;
                            const points: Array<[number, number]> = linePts.map(p =>
                                mvtPointToLatLng(p.x, p.y, layer.extent, tileX, tileY, zoom)
                            );

                            const lineFeature: VectorFeatureLine = {
                                id: `${layerName}-${i}-${points.length}`,
                                type: 'LineString',
                                points,
                                properties: props
                            };

                            if (isRoadLayer || props.class === 'road' || props.highway) {
                                result.roads.push(lineFeature);
                            } else if (isWaterLayer) {
                                result.water.push({
                                    id: lineFeature.id,
                                    type: 'Polygon',
                                    ring: points,
                                    properties: props
                                });
                            }
                        }
                    }
                }
            }
        } catch (err: any) {
            console.warn(`[GoogleVectorTileService] Error parsing tile protobuf: ${err?.message}`);
        }

        return result;
    }

    /**
     * Stages a complete 3D vector world population in 18% Studio Grey Clay.
     * Ingests Google 2D roadmap vector tiles, extrudes building massing, road ribbons,
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

        let tilesCount = 0;
        for (let dx = -radius; dx <= radius; dx++) {
            for (let dy = -radius; dy <= radius; dy++) {
                const tx = centerTile.x + dx;
                const ty = centerTile.y + dy;
                tilesCount++;
                const tileData = await this.fetchVectorTile(tx, ty, zoom, apiKey, fetchImpl);
                allBuildings.push(...tileData.buildings);
                if (options.includeRoads !== false) {
                    allRoads.push(...tileData.roads);
                }
                if (options.includeWater !== false) {
                    allWater.push(...tileData.water);
                }
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
        const anchorElevation = options.elevation ?? 0.0;
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
        for (const b of allBuildings) {
            if (b.ring.length < 3) continue;

            const localRing = b.ring.map(([lng, lat]) =>
                wgs84ToLocalEnu(lat, lng, options.latitude, options.longitude, anchorElevation, undefined, ltp)
            );

            // Compute height from properties or default
            let height = 15.0;
            if (b.properties?.height) {
                height = parseFloat(b.properties.height);
            } else if (b.properties?.['building:levels']) {
                height = parseFloat(b.properties['building:levels']) * 3.5;
            } else if (b.properties?.levels) {
                height = parseFloat(b.properties.levels) * 3.5;
            } else {
                // Procedural variation based on area
                const area = Math.abs(EarClippingTriangulator.signedArea(localRing));
                if (area > 1500) height = 45.0;
                else if (area > 600) height = 28.0;
                else height = 12.0;
            }
            height *= heightScale;

            const groundElevations = localRing.map(p => sampleElevation(p.x, p.z));
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
