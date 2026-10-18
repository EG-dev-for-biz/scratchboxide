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
import { GltfBinaryPacker } from '../3d-engine/gltf-binary-packer';
import {
    GoogleVectorTileService,
    DecodedVectorTileData,
    VectorFeaturePolygon,
    VectorFeatureLine,
    wgs84ToLocalEnu,
    latLngToTile,
    EarClippingTriangulator,
    getCachedLocalTangentPlane
} from './GoogleVectorTileService';
import { fetchSolarDsm, type DsmRaster } from './solar-dsm';
import { densifyRoads, fuseBuilding, streetLevelNear, type LngLat } from './building-shape-fusion';

export interface EnuPoint {
    x: number;
    z: number;
    y?: number;
}

export interface EnuRoadCorridor {
    id: string;
    name?: string;
    class: string;
    points: EnuPoint[];
    totalLengthMeters: number;
    widthMeters: number;
    laneCount: number;
    speedLimitKmh: number;
    oneWay: boolean;
    surface: string;
}

/**
 * Where a building's height came from (diagnostic label; nothing branches on it except 'none' = no height):
 * 'dsm' measured roof (Solar DSM), 'vector' Google/tagged height, 'levels' tagged floor count x 3.5 m,
 * 'none' no height data (drawn as a flat footprint, never extruded to an invented height).
 */
export type BuildingHeightSource = 'dsm' | 'vector' | 'levels' | 'none' | (string & {});

export interface EnuBuildingParcel {
    id: string;
    ring: EnuPoint[];
    areaM2: number;
    /** Height above its ground; undefined when there is no height data (heightSource 'none'). */
    heightMeters?: number;
    heightSource: BuildingHeightSource;
    /** Floor count from the data (building:levels); undefined when not tagged. */
    levels?: number;
    /** Measured street level beside the building, m above sea level (Solar DSM). */
    groundMsl?: number;
    centroid: EnuPoint;
    type: string;
}

export interface EnuLanduseArea {
    id: string;
    ring: EnuPoint[];
    areaM2: number;
    type: 'park' | 'grass' | 'plaza' | 'commercial' | 'industrial' | (string & {});
    centroid: EnuPoint;
}

export interface EnuWaterPolygon {
    id: string;
    ring: EnuPoint[];
    areaM2: number;
}

export interface VectorFeatureGraph {
    anchorLat: number;
    anchorLng: number;
    anchorElevation?: number;
    roads: EnuRoadCorridor[];
    buildings: EnuBuildingParcel[];
    landuse: EnuLanduseArea[];
    water: EnuWaterPolygon[];
    bounds: {
        min: [number, number, number];
        max: [number, number, number];
    };
}

export interface HeroStagingPlacementQuery {
    type?: 'lane' | 'sidewalk' | 'plaza';
    roadIndex?: number;
    roadName?: string;
    laneIndex?: number; // 0 to laneCount-1
    distanceAlongM?: number;
    offsetLateralM?: number;
    side?: 'left' | 'right';
    landuseIndex?: number;
}

export interface HeroStagingPlacementResult {
    position: [number, number, number];
    headingRad: number;
    headingDeg: number;
    targetSurface: 'road' | 'sidewalk' | 'plaza';
    surfaceY: number;
    forwardVec: [number, number, number];
    roadId?: string;
    roadName?: string;
    laneIndex?: number;
}

export interface VectorWorldPopulationOptions {
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
    radiusTiles?: number; // default 1
    apiKey?: string;
    fetchImpl?: typeof fetch;
    outputGlbPath?: string;
    style?: 'studio_clay' | 'architectural_white' | 'dark_slate' | (string & {});
    // Geometric Layers
    includeBuildings?: boolean;
    buildingHeightScale?: number;
    buildingArticulation?: boolean; // floor cornices & roof parapets
    includeRoads?: boolean;
    includeSidewalks?: boolean;
    sidewalkWidthMeters?: number;
    includeCurbs?: boolean;
    curbHeightMeters?: number;
    curbBevelMeters?: number;
    includeLaneMarkings?: boolean;
    includeWater?: boolean;
    includePlinth?: boolean;
    // World Population Props
    includeStreetlamps?: boolean;
    streetlampPitchMeters?: number;
    /**
     * Place SYNTHETIC background vehicles in the lanes (default false). Positions are not observed traffic: they
     * are drawn from a seeded PRNG (trafficSeed) and reported as synthetic.
     */
    includeTraffic?: boolean;
    trafficDensity?: number; // vehicles per 100m of lane
    /** PRNG seed for synthetic traffic (default: derived from latitude/longitude, so a location is reproducible). */
    trafficSeed?: number;
    /**
     * Seat and size buildings from the Google Solar API DSM fused with the vector data (as stage_3d_vector_world
     * does). Default true; pass a raster to use it directly, or false to use vector heights only.
     */
    solarDsm?: DsmRaster | boolean;
    /** DSM radius when fetched (default 175 m). */
    solarDsmRadiusMeters?: number;
    // Hero Staging
    heroStaging?: HeroStagingPlacementQuery;
}

export interface VectorWorldPopulationStats {
    /** Buildings extruded to a height from the data (DSM, vector or tagged levels). */
    buildingCount: number;
    /** Footprints with no height data, drawn flat at ground level rather than given an invented height. */
    flatFootprintCount: number;
    /** Per-source counts of building heights. */
    heightSources: Record<string, number>;
    /** DSM fusion: why it was skipped, or how many buildings it seated/sized. */
    fusion: { skipped?: string; dsmImageryDate?: string; buildingsFused: number; anchorElevationMsl?: number };
    /** True when trafficVehicleCount > 0: the vehicles are seeded synthetic placements, not observed traffic. */
    trafficSynthetic: boolean;
    trafficSeed?: number;
    roadSegmentCount: number;
    waterPolygonCount: number;
    streetlampCount: number;
    trafficVehicleCount: number;
    vertexCount: number;
    triangleCount: number;
    minBounds: [number, number, number];
    maxBounds: [number, number, number];
}

export interface VectorWorldPopulationResult {
    success: boolean;
    glbPath: string;
    glbUrl: string;
    stats: VectorWorldPopulationStats;
    center: [number, number];
    zoom: number;
    tilesCount: number;
    style: string;
    featureGraph: VectorFeatureGraph;
    heroPlacement?: HeroStagingPlacementResult;
}

/**
 * World Population Staging Service leveraging 3D Vector Tiles.
 * Ingests 2D roadmap vector tiles, extracts topologically consistent road networks,
 * building parcels, and landuse areas into SI metric space, sweeps 5-tier road cross-sections,
 * articulates buildings at their measured (Solar DSM) or vector height, and populates street furniture.
 * Buildings without height data are drawn as flat footprints and counted, never given a guessed height.
 * Traffic is opt-in and synthetic (seeded PRNG), labelled as such in the stats.
 * It places no trees: tree positions are never invented (every 18 m along roads, random points in parks);
 * a location's trees are measured from its photo tiles and rebuilt by google_3d_tiles_get_clay.
 */
export class VectorWorldPopulatorService {
    /**
     * Height from the vector data only, as stage_3d_vector_world reads it: Google's maxZ (heightMeters minus
     * minHeightMeters), else a tagged height, else tagged levels x 3.5 m. Nothing is guessed from the footprint.
     */
    public static vectorHeightOf(props: Record<string, any> | undefined): { heightMeters?: number; heightSource: BuildingHeightSource; levels?: number } {
        const lv = parseInt(props?.['building:levels'] ?? props?.levels, 10);
        const levels = Number.isFinite(lv) && lv > 0 ? lv : undefined;
        if (typeof props?.heightMeters === 'number' && props.heightMeters > 0) {
            const h = props.heightMeters - (props.minHeightMeters || 0);
            if (h > 0) return { heightMeters: h, heightSource: 'vector', levels };
        }
        const tagged = parseFloat(props?.height);
        if (Number.isFinite(tagged) && tagged > 0) return { heightMeters: tagged, heightSource: 'vector', levels };
        if (levels !== undefined) return { heightMeters: levels * 3.5, heightSource: 'levels', levels };
        return { heightSource: 'none' };
    }

    /**
     * Extracts a continuous, topologically unified VectorFeatureGraph in local ENU metric coordinates.
     */
    public static extractFeatureGraph(
        anchorLat: number,
        anchorLng: number,
        decoded: DecodedVectorTileData,
        anchorElevation: number = 0
    ): VectorFeatureGraph {
        const ltp = getCachedLocalTangentPlane(anchorLat, anchorLng, anchorElevation);
        const roads: EnuRoadCorridor[] = [];
        const buildings: EnuBuildingParcel[] = [];
        const landuse: EnuLanduseArea[] = [];
        const water: EnuWaterPolygon[] = [];

        const minBounds: [number, number, number] = [Infinity, Infinity, Infinity];
        const maxBounds: [number, number, number] = [-Infinity, -Infinity, -Infinity];

        const updateBounds = (x: number, y: number, z: number) => {
            minBounds[0] = Math.min(minBounds[0], x);
            minBounds[1] = Math.min(minBounds[1], y);
            minBounds[2] = Math.min(minBounds[2], z);
            maxBounds[0] = Math.max(maxBounds[0], x);
            maxBounds[1] = Math.max(maxBounds[1], y);
            maxBounds[2] = Math.max(maxBounds[2], z);
        };

        // 1. Process Roads
        for (const r of decoded.roads) {
            if (r.points.length < 2) continue;
            const enuPoints: EnuPoint[] = r.points.map(([lng, lat]) => {
                const enu = wgs84ToLocalEnu(lat, lng, anchorLat, anchorLng, anchorElevation, undefined, ltp);
                updateBounds(enu.x, 0.0, enu.z);
                return enu;
            });

            let totalLen = 0;
            for (let i = 0; i < enuPoints.length - 1; i++) {
                const dx = enuPoints[i + 1].x - enuPoints[i].x;
                const dz = enuPoints[i + 1].z - enuPoints[i].z;
                totalLen += Math.sqrt(dx * dx + dz * dz);
            }
            if (totalLen < 1.0) continue; // Skip micro-stubs

            const rClass = String(r.properties?.class || r.properties?.highway || 'residential').toLowerCase();
            let width = 7.0;
            let lanes = 2;
            let speedLimit = 50;

            if (rClass.includes('motorway') || rClass.includes('highway') || rClass.includes('trunk')) {
                width = 14.0;
                lanes = 4;
                speedLimit = 100;
            } else if (rClass.includes('primary') || rClass.includes('arterial')) {
                width = 11.0;
                lanes = 3;
                speedLimit = 60;
            } else if (rClass.includes('secondary')) {
                width = 8.5;
                lanes = 2;
                speedLimit = 50;
            } else if (rClass.includes('service') || rClass.includes('alley') || rClass.includes('path')) {
                width = 4.5;
                lanes = 1;
                speedLimit = 30;
            }

            if (r.properties?.lanes) {
                const parsedLanes = parseInt(r.properties.lanes, 10);
                if (!isNaN(parsedLanes) && parsedLanes > 0) {
                    lanes = parsedLanes;
                    width = Math.max(width, lanes * 3.5);
                }
            }

            roads.push({
                id: r.id,
                name: r.properties?.name || undefined,
                class: rClass,
                points: enuPoints,
                totalLengthMeters: totalLen,
                widthMeters: width,
                laneCount: lanes,
                speedLimitKmh: speedLimit,
                oneWay: Boolean(r.properties?.oneway === 'yes' || r.properties?.oneway === true),
                surface: r.properties?.surface || 'asphalt'
            });
        }

        // 2. Process Buildings
        for (const b of decoded.buildings) {
            if (b.ring.length < 3) continue;
            const enuRing: EnuPoint[] = b.ring.map(([lng, lat]) => {
                const enu = wgs84ToLocalEnu(lat, lng, anchorLat, anchorLng, anchorElevation, undefined, ltp);
                updateBounds(enu.x, 0.0, enu.z);
                return enu;
            });

            const area = Math.abs(EarClippingTriangulator.signedArea(enuRing));
            if (area < 5.0) continue; // Skip degenerates

            const { heightMeters: height, heightSource, levels } = VectorWorldPopulatorService.vectorHeightOf(b.properties);

            const uniquePoints = (enuRing.length > 3 && Math.abs(enuRing[0].x - enuRing[enuRing.length - 1].x) < 1e-4 && Math.abs(enuRing[0].z - enuRing[enuRing.length - 1].z) < 1e-4)
                ? enuRing.slice(0, -1)
                : enuRing;

            let cx = 0, cz = 0;
            for (const pt of uniquePoints) {
                cx += pt.x;
                cz += pt.z;
            }
            cx /= uniquePoints.length;
            cz /= uniquePoints.length;

            updateBounds(cx, height ?? 0, cz);

            buildings.push({
                id: b.id,
                ring: enuRing,
                areaM2: area,
                heightMeters: height,
                heightSource,
                levels,
                centroid: { x: cx, z: cz },
                type: b.properties?.type || b.properties?.building || 'building'
            });
        }

        // 3. Process Landuse
        for (const l of decoded.landuse) {
            if (l.ring.length < 3) continue;
            const enuRing: EnuPoint[] = l.ring.map(([lng, lat]) => {
                const enu = wgs84ToLocalEnu(lat, lng, anchorLat, anchorLng, anchorElevation, undefined, ltp);
                updateBounds(enu.x, 0.0, enu.z);
                return enu;
            });

            const area = Math.abs(EarClippingTriangulator.signedArea(enuRing));
            if (area < 5.0) continue;

            const uniquePoints = (enuRing.length > 3 && Math.abs(enuRing[0].x - enuRing[enuRing.length - 1].x) < 1e-4 && Math.abs(enuRing[0].z - enuRing[enuRing.length - 1].z) < 1e-4)
                ? enuRing.slice(0, -1)
                : enuRing;

            let cx = 0, cz = 0;
            for (const pt of uniquePoints) {
                cx += pt.x;
                cz += pt.z;
            }
            cx /= uniquePoints.length;
            cz /= uniquePoints.length;

            const lType = String(l.properties?.class || l.properties?.type || 'park').toLowerCase();

            landuse.push({
                id: l.id,
                ring: enuRing,
                areaM2: area,
                type: lType.includes('park') ? 'park' : lType.includes('grass') ? 'grass' : lType.includes('plaza') ? 'plaza' : (lType as any),
                centroid: { x: cx, z: cz }
            });
        }

        // 4. Process Water
        for (const w of decoded.water) {
            if (w.ring.length < 3) continue;
            const enuRing: EnuPoint[] = w.ring.map(([lng, lat]) => {
                const enu = wgs84ToLocalEnu(lat, lng, anchorLat, anchorLng, anchorElevation, undefined, ltp);
                updateBounds(enu.x, 0.0, enu.z);
                return enu;
            });
            const area = Math.abs(EarClippingTriangulator.signedArea(enuRing));
            if (area < 5.0) continue;

            water.push({
                id: w.id,
                ring: enuRing,
                areaM2: area
            });
        }

        return {
            anchorLat,
            anchorLng,
            anchorElevation,
            roads,
            buildings,
            landuse,
            water,
            bounds: {
                min: isFinite(minBounds[0]) ? minBounds : [-100, 0, -100],
                max: isFinite(maxBounds[0]) ? maxBounds : [100, 50, 100]
            }
        };
    }

    /**
     * Solves semantic placement for a hero asset onto the vector world graph.
     */
    public static solveHeroStaging(
        graph: VectorFeatureGraph,
        query: HeroStagingPlacementQuery,
        elevationSampler?: (x: number, z: number) => number
    ): HeroStagingPlacementResult | undefined {
        const type = query.type || 'lane';

        if (type === 'lane' && graph.roads.length > 0) {
            let road = graph.roads[0];
            if (typeof query.roadIndex === 'number' && graph.roads[query.roadIndex]) {
                road = graph.roads[query.roadIndex];
            } else if (query.roadName) {
                const match = graph.roads.find(r => r.name?.toLowerCase().includes(query.roadName!.toLowerCase()));
                if (match) road = match;
            }

            const laneCount = road.laneCount;
            const laneIndex = Math.max(0, Math.min(laneCount - 1, query.laneIndex ?? Math.floor(laneCount / 2)));
            const laneWidth = road.widthMeters / laneCount;
            const lateralOffset = -road.widthMeters * 0.5 + (laneIndex + 0.5) * laneWidth + (query.offsetLateralM ?? 0);

            let targetDist = query.distanceAlongM ?? (road.totalLengthMeters * 0.5);
            targetDist = Math.max(0.1, Math.min(road.totalLengthMeters - 0.1, targetDist));

            // Walk polyline to find target point and heading
            let accumulated = 0;
            for (let i = 0; i < road.points.length - 1; i++) {
                const p0 = road.points[i];
                const p1 = road.points[i + 1];
                const dx = p1.x - p0.x;
                const dz = p1.z - p0.z;
                const segLen = Math.sqrt(dx * dx + dz * dz);

                if (accumulated + segLen >= targetDist || i === road.points.length - 2) {
                    const localT = Math.max(0, Math.min(1, (targetDist - accumulated) / segLen));
                    const cx = p0.x + dx * localT;
                    const cz = p0.z + dz * localT;

                    const forwardX = dx / segLen;
                    const forwardZ = dz / segLen;
                    const normalX = -forwardZ;
                    const normalZ = forwardX;

                    const posX = cx + normalX * lateralOffset;
                    const posZ = cz + normalZ * lateralOffset;
                    const surfaceY = (elevationSampler ? elevationSampler(posX, posZ) : 0.0) + 0.02;

                    const headingRad = Math.atan2(forwardX, forwardZ);
                    const headingDeg = (headingRad * 180) / Math.PI;

                    return {
                        position: [posX, surfaceY, posZ],
                        headingRad,
                        headingDeg,
                        targetSurface: 'road',
                        surfaceY,
                        forwardVec: [forwardX, 0, forwardZ],
                        roadId: road.id,
                        roadName: road.name,
                        laneIndex
                    };
                }
                accumulated += segLen;
            }
        } else if (type === 'sidewalk' && graph.roads.length > 0) {
            let road = graph.roads[0];
            if (typeof query.roadIndex === 'number' && graph.roads[query.roadIndex]) {
                road = graph.roads[query.roadIndex];
            }
            const side = query.side || 'right';
            const sidewalkDist = road.widthMeters * 0.5 + 1.2;
            const lateralOffset = side === 'left' ? -sidewalkDist : sidewalkDist;

            let targetDist = query.distanceAlongM ?? (road.totalLengthMeters * 0.5);
            targetDist = Math.max(0.1, Math.min(road.totalLengthMeters - 0.1, targetDist));

            let accumulated = 0;
            for (let i = 0; i < road.points.length - 1; i++) {
                const p0 = road.points[i];
                const p1 = road.points[i + 1];
                const dx = p1.x - p0.x;
                const dz = p1.z - p0.z;
                const segLen = Math.sqrt(dx * dx + dz * dz);

                if (accumulated + segLen >= targetDist || i === road.points.length - 2) {
                    const localT = Math.max(0, Math.min(1, (targetDist - accumulated) / segLen));
                    const cx = p0.x + dx * localT;
                    const cz = p0.z + dz * localT;

                    const forwardX = dx / segLen;
                    const forwardZ = dz / segLen;
                    const normalX = -forwardZ;
                    const normalZ = forwardX;

                    const posX = cx + normalX * lateralOffset;
                    const posZ = cz + normalZ * lateralOffset;
                    const surfaceY = (elevationSampler ? elevationSampler(posX, posZ) : 0.0) + 0.17; // Elevated sidewalk slab

                    const headingRad = Math.atan2(forwardX, forwardZ);
                    const headingDeg = (headingRad * 180) / Math.PI;

                    return {
                        position: [posX, surfaceY, posZ],
                        headingRad,
                        headingDeg,
                        targetSurface: 'sidewalk',
                        surfaceY,
                        forwardVec: [forwardX, 0, forwardZ],
                        roadId: road.id,
                        roadName: road.name
                    };
                }
                accumulated += segLen;
            }
        } else if (type === 'plaza' && graph.landuse.length > 0) {
            const idx = query.landuseIndex ?? 0;
            const area = graph.landuse[Math.min(graph.landuse.length - 1, idx)];
            const surfaceY = (elevationSampler ? elevationSampler(area.centroid.x, area.centroid.z) : 0.0) + 0.05;
            return {
                position: [area.centroid.x, surfaceY, area.centroid.z],
                headingRad: 0.0,
                headingDeg: 0.0,
                targetSurface: 'plaza',
                surfaceY,
                forwardVec: [0, 0, 1]
            };
        }

        return undefined;
    }

    /**
     * Synthesizes and stages a populated 3D world from vector tiles into a standard binary .glb.
     */
    public static async generatePopulatedWorld(
        options: VectorWorldPopulationOptions
    ): Promise<VectorWorldPopulationResult> {
        const apiKey = GoogleVectorTileService.resolveApiKey(options.apiKey);
        const fetchImpl = options.fetchImpl || fetch;
        const zoom = options.zoom ?? 16;
        const radius = options.radiusTiles ?? 1;
        const centerTile = latLngToTile(options.latitude, options.longitude, zoom);

        const mergedDecoded: DecodedVectorTileData = {
            buildings: [],
            landuse: [],
            water: [],
            roads: []
        };

        let tilesCount = 0;
        for (let dx = -radius; dx <= radius; dx++) {
            for (let dy = -radius; dy <= radius; dy++) {
                const tx = centerTile.x + dx;
                const ty = centerTile.y + dy;
                tilesCount++;
                const tileData = await GoogleVectorTileService.fetchVectorTile(tx, ty, zoom, apiKey, fetchImpl);
                mergedDecoded.buildings.push(...tileData.buildings);
                mergedDecoded.roads.push(...tileData.roads);
                mergedDecoded.water.push(...tileData.water);
                mergedDecoded.landuse.push(...tileData.landuse);
            }
        }

        // Measured surface (Solar DSM) fused with the vector data, exactly as stage_3d_vector_world does: street
        // level per building from the DSM on nearby roads, roof height from the DSM inside the footprint, vector
        // height where the DSM has no cover. Without a DSM, vector heights are used and the reason is reported.
        let dsm: (DsmRaster & { imageryDate?: string }) | undefined;
        let fusionSkipped: string | undefined;
        if (options.solarDsm && typeof options.solarDsm === 'object') dsm = options.solarDsm;
        else if (options.solarDsm !== false) {
            try {
                dsm = await fetchSolarDsm(options.latitude, options.longitude, options.solarDsmRadiusMeters ?? 175, apiKey, { fetchImpl });
            } catch (err: any) {
                fusionSkipped = err?.message || String(err);
            }
        } else fusionSkipped = 'disabled';
        const roadPoints: LngLat[] = dsm ? densifyRoads(mergedDecoded.roads.map(r => r.points as LngLat[])) : [];
        const measuredAnchor = dsm ? streetLevelNear(dsm, options.latitude, options.longitude, roadPoints, 80) : undefined;
        const anchorElevation = options.elevation ?? measuredAnchor ?? 0.0;

        // Extract topological graph in ENU metric meters
        const graph = this.extractFeatureGraph(options.latitude, options.longitude, mergedDecoded, anchorElevation);

        let buildingsFused = 0;
        if (dsm) {
            const rings = new Map(mergedDecoded.buildings.map(b => [b.id, b.ring as LngLat[]]));
            for (const b of graph.buildings) {
                const ring = rings.get(b.id);
                if (!ring || ring.length < 3) continue;
                const f = fuseBuilding({ id: b.id, ring, vectorHeightMeters: b.heightMeters, source: 'extruded' }, dsm, [], { roadPoints, sampleSpacingMeters: 1 });
                if (f.groundMsl === undefined) continue;
                buildingsFused++;
                b.groundMsl = f.groundMsl;
                if (f.heightMeters !== undefined && f.heightSource === 'dsm') {
                    b.heightMeters = f.heightMeters;
                    b.heightSource = 'dsm';
                }
            }
        }

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

        // Geometric stream buffers
        const positions: number[] = [];
        const normals: number[] = [];
        const uvs: number[] = [];
        const indices: number[] = [];
        let currentVertexCount = 0;

        const addVertex = (
            x: number, y: number, z: number,
            nx: number, ny: number, nz: number,
            u: number, v: number
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

        const addQuad = (
            p0: [number, number, number],
            p1: [number, number, number],
            p2: [number, number, number],
            p3: [number, number, number],
            normal: [number, number, number],
            uvRect: [number, number, number, number] = [0, 0, 1, 1]
        ) => {
            const v0 = addVertex(p0[0], p0[1], p0[2], normal[0], normal[1], normal[2], uvRect[0], uvRect[1]);
            const v1 = addVertex(p1[0], p1[1], p1[2], normal[0], normal[1], normal[2], uvRect[2], uvRect[1]);
            const v2 = addVertex(p2[0], p2[1], p2[2], normal[0], normal[1], normal[2], uvRect[2], uvRect[3]);
            const v3 = addVertex(p3[0], p3[1], p3[2], normal[0], normal[1], normal[2], uvRect[0], uvRect[3]);

            indices.push(v0, v1, v2);
            indices.push(v0, v2, v3);

            expandBounds(p0[0], p0[1], p0[2]);
            expandBounds(p1[0], p1[1], p1[2]);
            expandBounds(p2[0], p2[1], p2[2]);
            expandBounds(p3[0], p3[1], p3[2]);
        };

        // Counters
        let streetlampCount = 0;
        let trafficVehicleCount = 0;
        let roadSegmentCount = 0;

        // Configuration defaults
        const includeRoads = options.includeRoads !== false;
        const includeSidewalks = options.includeSidewalks !== false;
        const sidewalkWidth = options.sidewalkWidthMeters ?? 2.4;
        const includeCurbs = options.includeCurbs !== false;
        const curbHeight = options.curbHeightMeters ?? 0.15;
        const curbBevel = options.curbBevelMeters ?? 0.03;
        const includeLaneMarkings = options.includeLaneMarkings !== false;
        const includeStreetlamps = options.includeStreetlamps !== false;
        const lampPitch = options.streetlampPitchMeters ?? 25.0;
        const includeTraffic = options.includeTraffic === true;
        const trafficDensity = options.trafficDensity ?? 0.25;
        // Synthetic traffic is reproducible: a seeded mulberry32 stream, never Math.random.
        const trafficSeed = includeTraffic
            ? (options.trafficSeed ?? (Math.round(options.latitude * 1e5) * 73856093) ^ (Math.round(options.longitude * 1e5) * 19349663)) >>> 0
            : undefined;
        let prngState = trafficSeed ?? 0;
        const nextRandom = (): number => {
            prngState = (prngState + 0x6D2B79F5) >>> 0;
            let t = prngState;
            t = Math.imul(t ^ (t >>> 15), t | 1);
            t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
            return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
        };
        const buildingArticulation = options.buildingArticulation !== false;
        const heightScale = options.buildingHeightScale ?? 1.0;

        // ------------------------------------------------------------------------
        // 1. PROCEDURAL PROP GENERATORS (Streetlamps, Traffic Vehicles)
        // ------------------------------------------------------------------------

        // Helper to spawn a 3D streetlamp at (px, pz) oriented along normalVec
        const spawnStreetlamp = (px: number, py: number, pz: number, forwardVec: [number, number], normalVec: [number, number]) => {
            const poleHeight = 6.0;
            const poleRadius = 0.07;
            const armLen = 1.6;

            // Vertical pole cylinder (hexagonal prism)
            const sides = 6;
            for (let i = 0; i < sides; i++) {
                const a0 = (i / sides) * Math.PI * 2;
                const a1 = ((i + 1) / sides) * Math.PI * 2;
                const dx0 = Math.cos(a0) * poleRadius;
                const dz0 = Math.sin(a0) * poleRadius;
                const dx1 = Math.cos(a1) * poleRadius;
                const dz1 = Math.sin(a1) * poleRadius;

                addQuad(
                    [px + dx0, py, pz + dz0],
                    [px + dx1, py, pz + dz1],
                    [px + dx1, py + poleHeight, pz + dz1],
                    [px + dx0, py + poleHeight, pz + dz0],
                    [dx0, 0, dz0]
                );
            }

            // Curved cantilever bracket projecting out over the roadway (along normalVec)
            const armTipX = px - normalVec[0] * armLen;
            const armTipZ = pz - normalVec[1] * armLen;
            const armBaseY = py + poleHeight;
            const armTipY = armBaseY + 0.4;

            // Arm beam
            addQuad(
                [px, armBaseY, pz],
                [armTipX, armTipY, armTipZ],
                [armTipX, armTipY + 0.08, armTipZ],
                [px, armBaseY + 0.08, pz],
                [0, 1, 0]
            );

            // Luminaire fixture box at the arm tip
            const fixW = 0.35;
            const fixL = 0.6;
            const fixH = 0.12;
            const fX = forwardVec[0] * (fixW * 0.5);
            const fZ = forwardVec[1] * (fixW * 0.5);
            const nX = -normalVec[0] * (fixL * 0.5);
            const nZ = -normalVec[1] * (fixL * 0.5);

            addQuad(
                [armTipX - fX - nX, armTipY - fixH, armTipZ - fZ - nZ],
                [armTipX + fX - nX, armTipY - fixH, armTipZ + fZ - nZ],
                [armTipX + fX + nX, armTipY - fixH, armTipZ + fZ + nZ],
                [armTipX - fX + nX, armTipY - fixH, armTipZ - fZ + nZ],
                [0, -1, 0]
            );

            streetlampCount++;
        };

        // Helper to spawn a procedural vehicle in a lane
        const spawnVehicle = (
            px: number, py: number, pz: number,
            forwardX: number, forwardZ: number,
            normalX: number, normalZ: number
        ) => {
            const vLen = 4.4;
            const vWidth = 1.9;
            const vHeight = 1.45;
            const halfL = vLen * 0.5;
            const halfW = vWidth * 0.5;

            // Chassis box corners
            const pFL = [px + forwardX * halfL - normalX * halfW, py + 0.15, pz + forwardZ * halfL - normalZ * halfW] as [number, number, number];
            const pFR = [px + forwardX * halfL + normalX * halfW, py + 0.15, pz + forwardZ * halfL + normalZ * halfW] as [number, number, number];
            const pRL = [px - forwardX * halfL - normalX * halfW, py + 0.15, pz - forwardZ * halfL - normalZ * halfW] as [number, number, number];
            const pRR = [px - forwardX * halfL + normalX * halfW, py + 0.15, pz - forwardZ * halfL + normalZ * halfW] as [number, number, number];

            const waistY = py + 0.75;
            const topY = py + vHeight;

            // Chassis top
            addQuad(
                [pRL[0], waistY, pRL[2]],
                [pRR[0], waistY, pRR[2]],
                [pFR[0], waistY, pFR[2]],
                [pFL[0], waistY, pFL[2]],
                [0, 1, 0]
            );

            // Front fascia
            addQuad(pFR, pFL, [pFL[0], waistY, pFL[2]], [pFR[0], waistY, pFR[2]], [forwardX, 0, forwardZ]);
            // Rear bumper
            addQuad(pRL, pRR, [pRR[0], waistY, pRR[2]], [pRL[0], waistY, pRL[2]], [-forwardX, 0, -forwardZ]);
            // Left flank
            addQuad(pFL, pRL, [pRL[0], waistY, pRL[2]], [pFL[0], waistY, pFL[2]], [-normalX, 0, -normalZ]);
            // Right flank
            addQuad(pRR, pFR, [pFR[0], waistY, pFR[2]], [pRR[0], waistY, pRR[2]], [normalX, 0, normalZ]);

            // Setback cabin roof
            const cFL = [px + forwardX * (halfL * 0.2) - normalX * (halfW * 0.8), topY, pz + forwardZ * (halfL * 0.2) - normalZ * (halfW * 0.8)] as [number, number, number];
            const cFR = [px + forwardX * (halfL * 0.2) + normalX * (halfW * 0.8), topY, pz + forwardZ * (halfL * 0.2) + normalZ * (halfW * 0.8)] as [number, number, number];
            const cRL = [px - forwardX * (halfL * 0.6) - normalX * (halfW * 0.8), topY, pz - forwardZ * (halfL * 0.6) - normalZ * (halfW * 0.8)] as [number, number, number];
            const cRR = [px - forwardX * (halfL * 0.6) + normalX * (halfW * 0.8), topY, pz - forwardZ * (halfL * 0.6) + normalZ * (halfW * 0.8)] as [number, number, number];

            addQuad(cRL, cRR, cFR, cFL, [0, 1, 0]);

            trafficVehicleCount++;
        };

        // ------------------------------------------------------------------------
        // 2. TESSELLATE ROADS, BEVELED CURBS, SIDEWALKS & POPULATION
        // ------------------------------------------------------------------------
        if (includeRoads) {
            for (const r of graph.roads) {
                if (r.points.length < 2) continue;

                const halfW = r.widthMeters * 0.5;
                const swOuterOffset = halfW + (includeSidewalks ? sidewalkWidth : 0);

                let accumulatedDistance = 0;
                let lastLampDist = -lampPitch * 0.5;

                for (let i = 0; i < r.points.length - 1; i++) {
                    const p0 = r.points[i];
                    const p1 = r.points[i + 1];

                    const dx = p1.x - p0.x;
                    const dz = p1.z - p0.z;
                    const segLen = Math.sqrt(dx * dx + dz * dz);
                    if (segLen < 1e-4) continue;

                    const forwardX = dx / segLen;
                    const forwardZ = dz / segLen;
                    const perpX = -forwardZ;
                    const perpZ = forwardX;

                    const roadY0 = sampleElevation(p0.x, p0.z) + 0.02;
                    const roadY1 = sampleElevation(p1.x, p1.z) + 0.02;
                    const curbTopY0 = roadY0 + curbHeight;
                    const curbTopY1 = roadY1 + curbHeight;

                    // 1. Asphalt Carriageway
                    const rL0: [number, number, number] = [p0.x - perpX * halfW, roadY0, p0.z - perpZ * halfW];
                    const rR0: [number, number, number] = [p0.x + perpX * halfW, roadY0, p0.z + perpZ * halfW];
                    const rR1: [number, number, number] = [p1.x + perpX * halfW, roadY1, p1.z + perpZ * halfW];
                    const rL1: [number, number, number] = [p1.x - perpX * halfW, roadY1, p1.z - perpZ * halfW];

                    addQuad(rL0, rR0, rR1, rL1, [0, 1, 0], [0, 0, 1, segLen * 0.2]);

                    // 2. Dashed Lane Markings
                    if (includeLaneMarkings && r.laneCount > 1) {
                        const laneWidth = r.widthMeters / r.laneCount;
                        for (let l = 1; l < r.laneCount; l++) {
                            const lOffset = -halfW + l * laneWidth;
                            const markHalfW = 0.08;
                            const markY0 = roadY0 + 0.005;
                            const markY1 = roadY1 + 0.005;

                            const mP0L: [number, number, number] = [p0.x + perpX * (lOffset - markHalfW), markY0, p0.z + perpZ * (lOffset - markHalfW)];
                            const mP0R: [number, number, number] = [p0.x + perpX * (lOffset + markHalfW), markY0, p0.z + perpZ * (lOffset + markHalfW)];
                            const mP1R: [number, number, number] = [p1.x + perpX * (lOffset + markHalfW), markY1, p1.z + perpZ * (lOffset + markHalfW)];
                            const mP1L: [number, number, number] = [p1.x + perpX * (lOffset - markHalfW), markY1, p1.z + perpZ * (lOffset - markHalfW)];

                            addQuad(mP0L, mP0R, mP1R, mP1L, [0, 1, 0]);
                        }
                    }

                    // 3. Beveled Granite Curbs & Sidewalk Slabs
                    if (includeCurbs) {
                        // Left curb vertical riser
                        addQuad(
                            [p0.x - perpX * halfW, roadY0, p0.z - perpZ * halfW],
                            [p1.x - perpX * halfW, roadY1, p1.z - perpZ * halfW],
                            [p1.x - perpX * halfW, curbTopY1, p1.z - perpZ * halfW],
                            [p0.x - perpX * halfW, curbTopY0, p0.z - perpZ * halfW],
                            [perpX, 0, perpZ]
                        );

                        // Right curb vertical riser
                        addQuad(
                            [p1.x + perpX * halfW, roadY1, p1.z + perpZ * halfW],
                            [p0.x + perpX * halfW, roadY0, p0.z + perpZ * halfW],
                            [p0.x + perpX * halfW, curbTopY0, p0.z + perpZ * halfW],
                            [p1.x + perpX * halfW, curbTopY1, p1.z + perpZ * halfW],
                            [-perpX, 0, -perpZ]
                        );

                        if (includeSidewalks) {
                            // Left sidewalk top slab
                            addQuad(
                                [p0.x - perpX * swOuterOffset, curbTopY0, p0.z - perpZ * swOuterOffset],
                                [p0.x - perpX * halfW, curbTopY0, p0.z - perpZ * halfW],
                                [p1.x - perpX * halfW, curbTopY1, p1.z - perpZ * halfW],
                                [p1.x - perpX * swOuterOffset, curbTopY1, p1.z - perpZ * swOuterOffset],
                                [0, 1, 0]
                            );

                            // Right sidewalk top slab
                            addQuad(
                                [p0.x + perpX * halfW, curbTopY0, p0.z + perpZ * halfW],
                                [p0.x + perpX * swOuterOffset, curbTopY0, p0.z + perpZ * swOuterOffset],
                                [p1.x + perpX * swOuterOffset, curbTopY1, p1.z + perpZ * swOuterOffset],
                                [p1.x + perpX * halfW, curbTopY1, p1.z + perpZ * halfW],
                                [0, 1, 0]
                            );
                        }
                    }

                    // 4. Prop Population along the Segment
                    const segMidDist = accumulatedDistance + segLen * 0.5;

                    // Streetlamps at pitch p on right sidewalk curb
                    if (includeStreetlamps && (segMidDist - lastLampDist) >= lampPitch) {
                        const lampX = p0.x + perpX * (halfW + 0.45);
                        const lampZ = p0.z + perpZ * (halfW + 0.45);
                        const lampY = sampleElevation(lampX, lampZ) + 0.02 + curbHeight;
                        spawnStreetlamp(lampX, lampY, lampZ, [forwardX, forwardZ], [perpX, perpZ]);
                        lastLampDist = segMidDist;
                    }

                    // Traffic vehicles in lanes
                    if (includeTraffic && nextRandom() < (trafficDensity * segLen * 0.02)) {
                        const laneIdx = Math.floor(nextRandom() * r.laneCount);
                        const laneW = r.widthMeters / r.laneCount;
                        const laneOffset = -halfW + (laneIdx + 0.5) * laneW;
                        const carX = p0.x + perpX * laneOffset + forwardX * (segLen * 0.5);
                        const carZ = p0.z + perpZ * laneOffset + forwardZ * (segLen * 0.5);
                        const carY = sampleElevation(carX, carZ) + 0.02;
                        spawnVehicle(carX, carY, carZ, forwardX, forwardZ, perpX, perpZ);
                    }

                    accumulatedDistance += segLen;
                    roadSegmentCount++;
                }
            }
        }

        // ------------------------------------------------------------------------
        // 3. ARTICULATED BUILDINGS (Floors, Cornices, Roof Parapets)
        // ------------------------------------------------------------------------
        let buildingCount = 0;
        let flatFootprintCount = 0;
        const heightSources: Record<string, number> = {};
        if (options.includeBuildings !== false) {
            for (const b of graph.buildings) {
                if (b.ring.length < 3) continue;
                heightSources[b.heightSource] = (heightSources[b.heightSource] ?? 0) + 1;

                const groundElevations = b.groundMsl !== undefined
                    ? b.ring.map(() => b.groundMsl! - anchorElevation)
                    : b.ring.map(p => sampleElevation(p.x, p.z));

                if (b.heightMeters === undefined) {
                    // No height data: the footprint is drawn flat on the ground, not extruded to a guessed height.
                    const tris = EarClippingTriangulator.triangulate(b.ring);
                    const start = currentVertexCount;
                    b.ring.forEach((p, i) => {
                        const y = groundElevations[i] + 0.05;
                        addVertex(p.x, y, p.z, 0, 1, 0, p.x * 0.1, p.z * 0.1);
                        expandBounds(p.x, y, p.z);
                    });
                    for (const t of tris) indices.push(start + t);
                    flatFootprintCount++;
                    continue;
                }

                const height = b.heightMeters * heightScale;
                const minGroundY = Math.min(...groundElevations);
                const maxGroundY = Math.max(...groundElevations);
                const baseY = minGroundY - 0.5; // Foundation skirt embeds into terrain
                const topY = maxGroundY + height;
                const n = b.ring.length;

                // Walls
                for (let i = 0; i < n; i++) {
                    const next = (i + 1) % n;
                    const p0 = b.ring[i];
                    const p1 = b.ring[next];

                    const dx = p1.x - p0.x;
                    const dz = p1.z - p0.z;
                    const segLen = Math.sqrt(dx * dx + dz * dz);
                    if (segLen < 1e-4) continue;

                    const nx = dz / segLen;
                    const nz = -dx / segLen;

                    // Main Facade Quad
                    addQuad(
                        [p0.x, baseY, p0.z],
                        [p1.x, baseY, p1.z],
                        [p1.x, topY, p1.z],
                        [p0.x, topY, p0.z],
                        [nx, 0, nz]
                    );

                    // Floor cornices only where the data gives the floor count
                    if (buildingArticulation && b.levels !== undefined && b.levels > 1) {
                        const floorH = height / b.levels;
                        const corniceOut = 0.18; // 18cm ledge protrusion

                        for (let lvl = 1; lvl < b.levels; lvl++) {
                            const cY = baseY + lvl * floorH;
                            const cP0Out: [number, number, number] = [p0.x + nx * corniceOut, cY, p0.z + nz * corniceOut];
                            const cP1Out: [number, number, number] = [p1.x + nx * corniceOut, cY, p1.z + nz * corniceOut];

                            // Horizontal projecting ledge
                            addQuad(
                                [p0.x, cY, p0.z],
                                [p1.x, cY, p1.z],
                                cP1Out,
                                cP0Out,
                                [0, 1, 0]
                            );
                        }

                        // Roof Parapet Perimeter Wall (0.8m high barrier around roof)
                        const parapetH = 0.85;
                        addQuad(
                            [p0.x, topY, p0.z],
                            [p1.x, topY, p1.z],
                            [p1.x, topY + parapetH, p1.z],
                            [p0.x, topY + parapetH, p0.z],
                            [nx, 0, nz]
                        );
                    }
                }

                // Roof Slab
                const roofTriangles = EarClippingTriangulator.triangulate(b.ring);
                const roofStart = currentVertexCount;
                for (let i = 0; i < n; i++) {
                    const p = b.ring[i];
                    addVertex(p.x, topY, p.z, 0, 1, 0, p.x * 0.1, p.z * 0.1);
                    expandBounds(p.x, topY, p.z);
                }
                for (const t of roofTriangles) {
                    indices.push(roofStart + t);
                }

                buildingCount++;
            }
        }

        // ------------------------------------------------------------------------
        // 5. WATER BASINS
        // ------------------------------------------------------------------------
        let waterPolygonCount = 0;
        if (options.includeWater !== false) {
            for (const w of graph.water) {
                if (w.ring.length < 3) continue;
                const tris = EarClippingTriangulator.triangulate(w.ring);
                const startIdx = currentVertexCount;

                for (const p of w.ring) {
                    const waterY = sampleElevation(p.x, p.z) + 0.02;
                    addVertex(p.x, waterY, p.z, 0, 1, 0, p.x * 0.05, p.z * 0.05);
                    expandBounds(p.x, waterY, p.z);
                }
                for (const t of tris) {
                    indices.push(startIdx + t);
                }
                waterPolygonCount++;
            }
        }

        // ------------------------------------------------------------------------
        // 6. STUDIO VOID PLINTH
        // ------------------------------------------------------------------------
        if (options.includePlinth !== false) {
            const spanX = Math.abs(maxBounds[0] - minBounds[0]);
            const spanZ = Math.abs(maxBounds[2] - minBounds[2]);
            const plinthRadius = Math.max(150, Math.max(spanX, spanZ) * 0.75 + 100);
            const plinthY = sampleElevation(0, 0);
            const segments = 64;
            const centerIdx = addVertex(0, plinthY, 0, 0, 1, 0, 0.5, 0.5);

            const ringStart = currentVertexCount;
            for (let i = 0; i <= segments; i++) {
                const ang = (i / segments) * Math.PI * 2;
                const px = Math.cos(ang) * plinthRadius;
                const pz = Math.sin(ang) * plinthRadius;
                addVertex(px, plinthY, pz, 0, 1, 0, 0.5 + Math.cos(ang) * 0.5, 0.5 + Math.sin(ang) * 0.5);
                expandBounds(px, plinthY, pz);
            }
            for (let i = 0; i < segments; i++) {
                indices.push(centerIdx, ringStart + i, ringStart + i + 1);
            }
        }

        // ------------------------------------------------------------------------
        // 7. SOLVE HERO STAGING IF REQUESTED
        // ------------------------------------------------------------------------
        let heroPlacement: HeroStagingPlacementResult | undefined;
        if (options.heroStaging) {
            heroPlacement = this.solveHeroStaging(graph, options.heroStaging, sampleElevation);
        }

        // ------------------------------------------------------------------------
        // 8. GLTF 2.0 BINARY PACKING (18% Studio Grey Clay)
        // ------------------------------------------------------------------------
        const posArray = new Float32Array(positions);
        const normArray = new Float32Array(normals);
        const uvArray = new Float32Array(uvs);
        const idxArray = new Uint32Array(indices);

        const posBuffer = Buffer.from(posArray.buffer);
        const normBuffer = Buffer.from(normArray.buffer);
        const uvBuffer = Buffer.from(uvArray.buffer);
        const idxBuffer = Buffer.from(idxArray.buffer);

        const gltf = {
            asset: { version: '2.0', generator: 'Scratchbox 3D Vector World Population Engine' },
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
                            mode: 4
                        }
                    ]
                }
            ],
            accessors: [
                {
                    bufferView: 0,
                    byteOffset: 0,
                    componentType: 5126,
                    count: currentVertexCount,
                    type: 'VEC3',
                    min: [minBounds[0], minBounds[1], minBounds[2]],
                    max: [maxBounds[0], maxBounds[1], maxBounds[2]]
                },
                {
                    bufferView: 1,
                    byteOffset: 0,
                    componentType: 5126,
                    count: currentVertexCount,
                    type: 'VEC3',
                    min: [-1, -1, -1],
                    max: [1, 1, 1]
                },
                {
                    bufferView: 2,
                    byteOffset: 0,
                    componentType: 5126,
                    count: currentVertexCount,
                    type: 'VEC2',
                    min: [0, 0],
                    max: [1, 1]
                },
                {
                    bufferView: 3,
                    byteOffset: 0,
                    componentType: 5125,
                    count: indices.length,
                    type: 'SCALAR',
                    min: [0],
                    max: [Math.max(0, currentVertexCount - 1)]
                }
            ],
            bufferViews: [
                { buffer: 0, byteOffset: 0, byteLength: posBuffer.length, target: 34962 },
                { buffer: 0, byteOffset: 0, byteLength: normBuffer.length, target: 34962 },
                { buffer: 0, byteOffset: 0, byteLength: uvBuffer.length, target: 34962 },
                { buffer: 0, byteOffset: 0, byteLength: idxBuffer.length, target: 34963 }
            ]
        };

        const bufferViews = [posBuffer, normBuffer, uvBuffer, idxBuffer];

        const cleanLat = options.latitude.toFixed(4).replace('.', '_');
        const cleanLng = options.longitude.toFixed(4).replace('.', '_');
        const defaultOutDir = path.resolve(process.cwd(), 'public/models');
        await fs.mkdirp(defaultOutDir);

        const outPath = options.outputGlbPath || path.resolve(defaultOutDir, `vector_populated_world_${cleanLat}_${cleanLng}.glb`);
        GltfBinaryPacker.writeGlb(outPath, gltf, bufferViews);

        const glbUrl = `/models/${path.basename(outPath)}`;

        return {
            success: true,
            glbPath: outPath,
            glbUrl,
            stats: {
                buildingCount,
                flatFootprintCount,
                heightSources,
                fusion: {
                    skipped: fusionSkipped,
                    dsmImageryDate: dsm?.imageryDate,
                    buildingsFused,
                    anchorElevationMsl: measuredAnchor !== undefined || options.elevation !== undefined ? anchorElevation : undefined
                },
                trafficSynthetic: trafficVehicleCount > 0,
                trafficSeed,
                roadSegmentCount,
                waterPolygonCount,
                streetlampCount,
                trafficVehicleCount,
                vertexCount: currentVertexCount,
                triangleCount: Math.floor(indices.length / 3),
                minBounds,
                maxBounds
            },
            center: [options.latitude, options.longitude],
            zoom,
            tilesCount,
            style: options.style || 'studio_clay',
            featureGraph: graph,
            heroPlacement
        };
    }
}
