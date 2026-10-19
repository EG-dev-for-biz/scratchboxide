/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Decoder for Google Vector Tiles (`vectortiles.featuretiles`, JSON FeatureTile).
 *
 * Geometry is on a local grid of 4096 units across the tile, origin at its north-west corner, with Z on the same
 * scale (maxZ 4096 = as tall as the tile is wide). Every vertexOffsets list is delta-encoded: each entry is the
 * offset from the previous vertex, the first from (0, 0, 0).
 */

export const TILE_GRID = 4096;
const EARTH_RADIUS_M = 6378137;

export interface FeatureTileJson {
    x: number;
    y: number;
    zoom: number;
    features?: Array<{ types?: string[]; geometry?: any; labels?: any[] }>;
}

export interface DecodedPolygon {
    id: string;
    type: 'Polygon';
    /** Outer boundary, [lng, lat]. */
    ring: Array<[number, number]>;
    /** Further boundary loops (holes or separate parts), [lng, lat]. */
    innerRings: Array<Array<[number, number]>>;
    properties: Record<string, any>;
}

export interface DecodedLine {
    id: string;
    type: 'LineString';
    points: Array<[number, number]>;
    properties: Record<string, any>;
}

/** A modeled 3D building: vertices in WGS84 with height above the tile's ground plane, and triangle indices. */
export interface DecodedModeledVolume {
    id: string;
    featureTypes: string[];
    /**
     * [lng, lat, height] per vertex. Heights keep the tile's own vertical datum (not sea level, not street level), so the
     * pieces of a building split across tiles line up: seat a building by the lowest point of all its pieces.
     */
    vertices: Array<[number, number, number]>;
    indices: number[];
    /** Lowest and highest vertex of this piece, in the same datum as `vertices`. */
    minZMeters: number;
    maxZMeters: number;
    /** maxZMeters - minZMeters of this piece. */
    heightMeters: number;
}

export interface DecodedFeatureTile {
    /** Buildings with a height: 2.5D extruded footprints (heightMeters, minHeightMeters). */
    buildings: DecodedPolygon[];
    /**
     * Flat 2D building shapes (geometry.areas) with no height. With modeled volumes enabled these are the plan
     * decomposition of 3D buildings, so they are kept apart from `buildings` and suit footprint tests (is this
     * point under a building?) rather than extrusion.
     */
    buildingFootprints2D: DecodedPolygon[];
    landuse: DecodedPolygon[];
    water: DecodedPolygon[];
    roads: DecodedLine[];
    pois: Array<{ id: string; type: 'Point'; point: [number, number]; properties: Record<string, any> }>;
    modeledVolumes: DecodedModeledVolume[];
}

/** Ground width of a Web Mercator tile at a latitude (meters). */
export function tileWidthMeters(latDeg: number, zoom: number): number {
    return (2 * Math.PI * EARTH_RADIUS_M * Math.cos((latDeg * Math.PI) / 180)) / 2 ** zoom;
}

/** Meters per vector-tile grid unit, horizontally and vertically. */
export function gridUnitMeters(latDeg: number, zoom: number): number {
    return tileWidthMeters(latDeg, zoom) / TILE_GRID;
}

/** Tile-local grid point to [lng, lat]. */
export function gridToLngLat(tile: { x: number; y: number; zoom: number }, gx: number, gy: number): [number, number] {
    const n = 2 ** tile.zoom;
    const wx = (tile.x + gx / TILE_GRID) / n;
    const wy = (tile.y + gy / TILE_GRID) / n;
    return [wx * 360 - 180, (Math.atan(Math.sinh(Math.PI * (1 - 2 * wy))) * 180) / Math.PI];
}

function cumulative(offsets: number[] | undefined): number[] {
    const out: number[] = [];
    let sum = 0;
    for (const d of offsets || []) out.push((sum += d));
    return out;
}

/** Boundary loops of an area, as indices into its vertices, per its encoding. */
export function areaBoundaryLoops(area: { type?: string; vertexOffsets?: { xOffsets?: number[] }; loopBreaks?: number[] }): number[][] {
    const n = area.vertexOffsets?.xOffsets?.length || 0;
    const all = Array.from({ length: n }, (_, i) => i);
    switch (area.type) {
        case 'TRIANGLE_FAN':
            // Vertex 0 is a corner of the outline, not an interior centre: in real tiles the fan triangles (0, i, i+1)
            // always sum to the area of the polygon through every vertex in order, and vertex 0 lies outside the
            // others' outline in most fans (around SoHo, 419 of 512). Dropping it turned every rectangle into a triangle.
            return [all];
        case 'TRIANGLE_STRIP': {
            const even = all.filter(i => i % 2 === 0), odd = all.filter(i => i % 2 === 1).reverse();
            return [[...even, ...odd]];
        }
        case 'INDEXED_TRIANGLES':
        default: {
            const starts = [0, ...(area.loopBreaks || []).filter(b => b > 0 && b < n)];
            return starts.map((s, i) => all.slice(s, starts[i + 1] ?? n)).filter(loop => loop.length >= 3);
        }
    }
}

/** Triangle strips to a flat triangle index list (alternating winding kept consistent). */
export function stripsToTriangles(strips: Array<{ vertexIndices?: number[] }>): number[] {
    const out: number[] = [];
    for (const s of strips || []) {
        const v = s.vertexIndices || [];
        for (let i = 2; i < v.length; i++) {
            const [a, b, c] = i % 2 === 0 ? [v[i - 2], v[i - 1], v[i]] : [v[i - 1], v[i - 2], v[i]];
            if (a !== b && b !== c && a !== c) out.push(a, b, c);
        }
    }
    return out;
}

const hasType = (types: string[] | undefined, re: RegExp) => (types || []).some(t => re.test(t));

export function decodeFeatureTile(tile: FeatureTileJson, idPrefix = `${tile.zoom}/${tile.x}/${tile.y}`): DecodedFeatureTile {
    const out: DecodedFeatureTile = { buildings: [], buildingFootprints2D: [], landuse: [], water: [], roads: [], pois: [], modeledVolumes: [] };
    const centre = gridToLngLat(tile, TILE_GRID / 2, TILE_GRID / 2);
    const unit = gridUnitMeters(centre[1], tile.zoom);

    (tile.features || []).forEach((feature, fi) => {
        const types = feature.types || [];
        const g = feature.geometry || {};
        const isBuilding = hasType(types, /^FEATURE_TYPE_BUILDING$|_BUILDING$/);
        const isWater = hasType(types, /WATER/);
        const isRoad = hasType(types, /ROAD|HIGHWAY|STREET/);
        const isLanduse = hasType(types, /NATURAL|LAND_COVER|PARK|VEGETATION|CROPS|URBAN_AREA/);
        const properties = { types };

        const polygonOf = (area: any, id: string, extra: Record<string, any>): DecodedPolygon | undefined => {
            const xs = cumulative(area?.vertexOffsets?.xOffsets), ys = cumulative(area?.vertexOffsets?.yOffsets);
            const loops = areaBoundaryLoops(area || {}).map(loop => loop.map(i => gridToLngLat(tile, xs[i], ys[i])));
            if (!loops.length) return undefined;
            return { id, type: 'Polygon', ring: loops[0], innerRings: loops.slice(1), properties: { ...properties, ...extra } };
        };

        (g.extrudedAreas || []).forEach((ea: any, i: number) => {
            const minZ = ea.minZ || 0, maxZ = ea.maxZ || 0;
            const poly = polygonOf(ea.area, `${idPrefix}/f${fi}/e${i}`, {
                minHeightMeters: minZ * unit,
                heightMeters: maxZ * unit,
                extruded: true
            });
            if (poly && isBuilding) out.buildings.push(poly);
        });
        (g.areas || []).forEach((a: any, i: number) => {
            const poly = polygonOf(a, `${idPrefix}/f${fi}/a${i}`, {});
            if (!poly) return;
            if (isBuilding) out.buildingFootprints2D.push(poly);
            else if (isWater) out.water.push(poly);
            else if (isLanduse) out.landuse.push(poly);
        });
        (g.lines || []).forEach((l: any, i: number) => {
            const xs = cumulative(l?.vertexOffsets?.xOffsets), ys = cumulative(l?.vertexOffsets?.yOffsets);
            if (xs.length < 2 || !isRoad) return;
            out.roads.push({ id: `${idPrefix}/f${fi}/l${i}`, type: 'LineString', points: xs.map((x, k) => gridToLngLat(tile, x, ys[k])), properties });
        });
        (g.modeledVolumes || []).forEach((mv: any, i: number) => {
            const xs = cumulative(mv.vertexOffsets?.xOffsets), ys = cumulative(mv.vertexOffsets?.yOffsets), zs = cumulative(mv.vertexOffsets?.zOffsets);
            if (!xs.length) return;
            const minZ = Math.min(...zs), maxZ = Math.max(...zs);
            const vertices = xs.map((x, k): [number, number, number] => [...gridToLngLat(tile, x, ys[k]), zs[k] * unit]);
            out.modeledVolumes.push({
                id: `${idPrefix}/f${fi}/m${i}`,
                featureTypes: types,
                vertices,
                indices: stripsToTriangles(mv.strips),
                minZMeters: minZ * unit,
                maxZMeters: maxZ * unit,
                heightMeters: (maxZ - minZ) * unit
            });
        });
        if (hasType(types, /POI/)) {
            const pos = feature.labels?.find((l: any) => l.pointPosition)?.pointPosition?.point;
            if (pos && typeof pos.x === 'number') {
                const name = feature.labels?.[0]?.textComponents?.[0]?.texts?.[0]?.text;
                out.pois.push({ id: `${idPrefix}/f${fi}/p`, type: 'Point', point: gridToLngLat(tile, pos.x, pos.y), properties: { ...properties, name } });
            }
        }
    });
    return out;
}
