/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Google vector data (vectortiles.featuretiles, GoogleVectorTileService) as evidence for the structure pick and the
 * terrain: building footprints (one feature per building, its extruded parts and plan shapes together) give the party
 * walls between touching buildings; water polygons say where the surface is water (never ground); road lines say where
 * the street runs. Everything is placed in the scan frame (x east, z south, metres from the geocoded point) and
 * rasterised onto the ground model's grid. The scan still decides the final shape: extraction-sizing.ts checks a
 * footprint against the scan's raised cells before using it.
 */

import { geodeticToScan } from '../../spatial/StreetViewSurveyPlanner';
import type { FootprintPrior, Vec2 } from '../../../common/spatial/staged-location-contracts';

/** A building: every boundary loop of its parts (outer rings and holes, filled even-odd per part), and its height. */
export interface VectorBuilding { id: string; parts: Vec2[][][]; heightM?: number }

export interface VectorEvidence {
    buildings: VectorBuilding[];
    /** Water areas: boundary loops per area (even-odd). */
    water: Vec2[][][];
    /** Road centrelines. */
    roads: Vec2[][];
    tiles: number;
    zoom: number;
}

/** The decoded tile contents this module reads (GoogleVectorTileService.fetchVectorTile's result). */
interface TileFeatures {
    buildings: Array<{ id: string; ring: Array<[number, number]>; innerRings?: Array<Array<[number, number]>>; properties?: Record<string, unknown> }>;
    buildingFootprints2D?: Array<{ id: string; ring: Array<[number, number]>; innerRings?: Array<Array<[number, number]>> }>;
    water: Array<{ ring: Array<[number, number]>; innerRings?: Array<Array<[number, number]>> }>;
    roads: Array<{ points: Array<[number, number]> }>;
    /** Modeled 3D buildings: [lng, lat, height] vertices and triangle indices. */
    modeledVolumes?: Array<{ id: string; vertices: Array<[number, number, number]>; indices: number[]; heightMeters?: number }>;
}

export const VECTOR_ZOOM = 17;

function tileOf(lat: number, lng: number, z: number): { x: number; y: number } {
    const n = 2 ** z, r = (lat * Math.PI) / 180;
    return { x: Math.floor(((lng + 180) / 360) * n), y: Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n) };
}

/**
 * The vector evidence within `radiusM` of (lat, lng), in the scan frame of that origin. `fetchTile` is
 * GoogleVectorTileService.fetchVectorTile (or a test's stand-in); a failing tile fails the call (the caller records it).
 */
export async function fetchVectorEvidence(opts: {
    lat: number; lng: number; radiusM: number; zoom?: number;
    fetchTile: (x: number, y: number, z: number) => Promise<TileFeatures>;
}): Promise<VectorEvidence> {
    const z = opts.zoom ?? VECTOR_ZOOM;
    const dLat = opts.radiusM / 111_320, dLng = opts.radiusM / (111_320 * Math.cos((opts.lat * Math.PI) / 180));
    const a = tileOf(opts.lat + dLat, opts.lng - dLng, z), b = tileOf(opts.lat - dLat, opts.lng + dLng, z);
    const origin = { lat: opts.lat, lng: opts.lng, heightMeters: 0 };
    const toScan = ([lng, lat]: [number, number]): Vec2 => { const p = geodeticToScan(origin, lat, lng); return [p.x, p.z]; };
    const coords: Array<{ x: number; y: number }> = [];
    for (let y = a.y; y <= b.y; y++) for (let x = a.x; x <= b.x; x++) coords.push({ x, y });
    const tiles = await Promise.all(coords.map(c => opts.fetchTile(c.x, c.y, z)));
    const byFeature = new Map<string, VectorBuilding>();
    const featureOf = (id: string) => id.split('/').slice(0, 4).join('/');  // z/x/y/f<i>: one feature, all its parts
    const water: Vec2[][][] = [];
    const roads: Vec2[][] = [];
    for (const t of tiles) {
        for (const p of [...t.buildings, ...(t.buildingFootprints2D ?? [])]) {
            const key = featureOf(p.id);
            const b = byFeature.get(key) ?? { id: key, parts: [] };
            b.parts.push([p.ring, ...(p.innerRings ?? [])].map(r => r.map(toScan)));
            const h = Number((p as { properties?: Record<string, unknown> }).properties?.heightMeters);
            if (Number.isFinite(h)) b.heightM = Math.max(b.heightM ?? 0, h);
            byFeature.set(key, b);
        }
        // a modeled 3D building: its plan is the union of its triangles seen from above
        for (const m of t.modeledVolumes ?? []) {
            const key = featureOf(m.id);
            const b = byFeature.get(key) ?? { id: key, parts: [] };
            const v = m.vertices.map(([lng, lat]) => toScan([lng, lat]));
            for (let i = 0; i + 2 < m.indices.length; i += 3) {
                const tri = [v[m.indices[i]], v[m.indices[i + 1]], v[m.indices[i + 2]]];
                const area = (tri[1][0] - tri[0][0]) * (tri[2][1] - tri[0][1]) - (tri[2][0] - tri[0][0]) * (tri[1][1] - tri[0][1]);
                if (Math.abs(area) > 1e-3) b.parts.push([tri]);
            }
            if (Number.isFinite(m.heightMeters)) b.heightM = Math.max(b.heightM ?? 0, m.heightMeters!);
            byFeature.set(key, b);
        }
        for (const w of t.water) water.push([w.ring, ...(w.innerRings ?? [])].map(r => r.map(toScan)));
        for (const r of t.roads) roads.push(r.points.map(toScan));
    }
    return { buildings: [...byFeature.values()], water, roads, tiles: tiles.length, zoom: z };
}

export interface EvidenceGrid { x0: number; z0: number; nx: number; nz: number; cellMeters: number }

/** Fills boundary loops even-odd at cell centres into `out` (value `v`). */
function fillLoops(loops: Vec2[][], g: EvidenceGrid, out: Uint8Array | Int32Array, v: number): void {
    let k0 = Infinity, k1 = -Infinity;
    for (const r of loops) for (const [, z] of r) { k0 = Math.min(k0, Math.floor((z - g.z0) / g.cellMeters)); k1 = Math.max(k1, Math.ceil((z - g.z0) / g.cellMeters)); }
    const xs: number[] = [];
    for (let k = Math.max(0, k0); k <= Math.min(g.nz - 1, k1); k++) {
        const cz = g.z0 + (k + 0.5) * g.cellMeters;
        xs.length = 0;
        for (const r of loops) for (let i = 0; i < r.length; i++) {
            const [ax, az] = r[i], [bx, bz] = r[(i + 1) % r.length];
            if ((az <= cz) === (bz <= cz)) continue;
            xs.push(ax + ((cz - az) / (bz - az)) * (bx - ax));
        }
        xs.sort((p, q) => p - q);
        for (let j = 0; j + 1 < xs.length; j += 2) {
            const i0 = Math.max(0, Math.ceil((xs[j] - g.x0) / g.cellMeters - 0.5)), i1 = Math.min(g.nx - 1, Math.floor((xs[j + 1] - g.x0) / g.cellMeters - 0.5));
            for (let i = i0; i <= i1; i++) out[k * g.nx + i] = v;
        }
    }
}

export interface EvidenceRaster {
    /** Building feature index + 1 per cell (0: none). */
    building: Int32Array;
    water: Uint8Array;
    /** Cells within ROAD_HALF_WIDTH_M of a road centreline. */
    road: Uint8Array;
    buildings: VectorBuilding[];
}

/** Half the width of the carriageway a centreline stands for (m): what the terrain may count as street. */
export const ROAD_HALF_WIDTH_M = 3;

export function rasterizeEvidence(ev: VectorEvidence, g: EvidenceGrid): EvidenceRaster {
    const N = g.nx * g.nz;
    const building = new Int32Array(N), water = new Uint8Array(N), road = new Uint8Array(N);
    ev.buildings.forEach((b, bi) => { for (const part of b.parts) fillLoops(part, g, building, bi + 1); });
    for (const w of ev.water) fillLoops(w, g, water, 1);
    const r = Math.ceil(ROAD_HALF_WIDTH_M / g.cellMeters);
    for (const line of ev.roads) for (let s = 0; s + 1 < line.length; s++) {
        const [ax, az] = line[s], [bx, bz] = line[s + 1];
        const len = Math.hypot(bx - ax, bz - az), n = Math.max(1, Math.ceil(len / (g.cellMeters / 2)));
        for (let q = 0; q <= n; q++) {
            const i = Math.floor((ax + ((bx - ax) * q) / n - g.x0) / g.cellMeters), k = Math.floor((az + ((bz - az) * q) / n - g.z0) / g.cellMeters);
            for (let dk = -r; dk <= r; dk++) for (let di = -r; di <= r; di++) {
                const ii = i + di, kk = k + dk;
                if (ii >= 0 && kk >= 0 && ii < g.nx && kk < g.nz && di * di + dk * dk <= r * r) road[kk * g.nx + ii] = 1;
            }
        }
    }
    return { building, water, road, buildings: ev.buildings };
}

/** Point lookups over the evidence, rasterised at `cellMeters` over the square `radiusM` around the origin. */
export interface EvidenceLookup {
    raster: EvidenceRaster;
    grid: EvidenceGrid;
    buildingAt(x: number, z: number): number;
    waterAt(x: number, z: number): boolean;
    roadAt(x: number, z: number): boolean;
}

export function evidenceLookup(ev: VectorEvidence, radiusM: number, cellMeters = 1): EvidenceLookup {
    const half = Math.ceil(radiusM + 20);
    const grid: EvidenceGrid = { x0: -half, z0: -half, nx: Math.ceil((2 * half) / cellMeters), nz: Math.ceil((2 * half) / cellMeters), cellMeters };
    const raster = rasterizeEvidence(ev, grid);
    const at = (x: number, z: number) => {
        const i = Math.floor((x - grid.x0) / cellMeters), k = Math.floor((z - grid.z0) / cellMeters);
        return i < 0 || k < 0 || i >= grid.nx || k >= grid.nz ? -1 : k * grid.nx + i;
    };
    return {
        raster, grid,
        buildingAt: (x, z) => { const c = at(x, z); return c < 0 ? 0 : raster.building[c]; },
        waterAt: (x, z) => { const c = at(x, z); return c >= 0 && raster.water[c] === 1; },
        roadAt: (x, z) => { const c = at(x, z); return c >= 0 && raster.road[c] === 1; }
    };
}

/** Neighbours whose plan comes within this of the building's are given to the fit (m). */
export const PRIOR_NEIGHBOUR_REACH_M = 30;

/**
 * The fit's footprint prior (FootprintPrior) for the building the pick used: its parts (the features `featureIds` name),
 * its height, and the buildings within PRIOR_NEIGHBOUR_REACH_M of it, which say where its party walls are. Undefined when
 * the evidence holds none of the features.
 */
export function footprintPriorFor(buildings: VectorBuilding[], featureIds: string[]): FootprintPrior | undefined {
    const target = buildings.filter(b => featureIds.includes(b.id));
    if (!target.length) return undefined;
    const box = (bs: VectorBuilding[]) => {
        let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
        for (const b of bs) for (const part of b.parts) for (const loop of part) for (const [x, z] of loop) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); z0 = Math.min(z0, z); z1 = Math.max(z1, z); }
        return { x0, x1, z0, z1 };
    };
    const t = box(target), r = PRIOR_NEIGHBOUR_REACH_M;
    const heights = target.map(b => b.heightM).filter((h): h is number => Number.isFinite(h) && (h as number) > 0);
    const neighbours = buildings.filter(b => !featureIds.includes(b.id)).filter(b => {
        const n = box([b]);
        return n.x1 >= t.x0 - r && n.x0 <= t.x1 + r && n.z1 >= t.z0 - r && n.z0 <= t.z1 + r;
    });
    return {
        source: `Google vector data (building ${featureIds.join(', ')})`,
        footprint: target.flatMap(b => b.parts),
        ...(heights.length ? { heightM: Math.max(...heights) } : {}),
        neighbours: neighbours.map(b => ({ id: b.id, parts: b.parts, ...(Number.isFinite(b.heightM) && (b.heightM as number) > 0 ? { heightM: b.heightM } : {}) }))
    };
}
