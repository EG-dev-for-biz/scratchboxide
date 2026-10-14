/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Building shape fusion: one best estimate per building from independent Google sources.
 *
 * - Vector Tiles (featuretiles): the footprint (plan shape) and a modeled height (extruded maxZ or 3D volume).
 * - Solar API DSM (dataLayers): a measured surface model, giving street level on nearby roads and the roof surface
 *   inside the footprint, both in meters above sea level.
 * - Solar API roof segments (buildingInsights): planar roof facets with pitch, azimuth and plane height, which
 *   shape pitched and stepped roofs.
 *
 * Each source is reported with the estimate, so disagreement is visible instead of averaged away.
 */
import { sampleDsm, type DsmRaster } from './solar-dsm';

export type LngLat = [number, number];

export interface FusionFootprint {
    id: string;
    ring: LngLat[];
    /** Height from the vector data, meters above the building base (extruded maxZ or modeled volume span). */
    vectorHeightMeters?: number;
    source: 'extruded' | 'modeled' | 'footprint';
}

export interface SolarRoofSegment {
    pitchDegrees: number;
    azimuthDegrees: number;
    /** Plane height at the segment centre, meters above sea level. */
    planeHeightAtCenterMeters: number;
    center: { latitude: number; longitude: number };
    areaMeters2: number;
}

export interface FusedBuilding {
    id: string;
    ring: LngLat[];
    /** Ground (street level) beside the building, meters above sea level, from the DSM. */
    groundMsl?: number;
    /** Where groundMsl was measured: DSM on nearby roads, or the band just outside the footprint. */
    groundSource?: 'roads' | 'band';
    /**
     * Main roof level: the median DSM height inside the footprint, m above sea level. The median resists footprint
     * edges that overlap a taller neighbour; measured around the ESB it matched the vector height within 5 m for
     * 69% of buildings, against 44% for the 90th percentile.
     */
    roofMsl?: number;
    /** Highest DSM point inside the footprint (spires, masts), m above sea level. */
    peakMsl?: number;
    /** Fraction of footprint samples with DSM data. */
    dsmCoverage: number;
    /** Measured main roof above ground (DSM median inside the footprint minus street level). */
    dsmRoofHeightMeters?: number;
    /** Measured highest point above ground (DSM maximum). Thin masts and antennas are under-sampled by the DSM. */
    dsmPeakHeightMeters?: number;
    vectorHeightMeters?: number;
    /** Best main-roof height above ground and where it came from. */
    heightMeters?: number;
    heightSource: 'dsm' | 'vector' | 'none';
    /**
     * |vector height - nearer of the DSM roof or peak height|. A vector massing describes either the main roof
     * (extrusions) or the full silhouette including masts (modeled volumes), so it is compared with the closer one.
     */
    disagreementMeters?: number;
    confidence: 'high' | 'medium' | 'low';
    roofSegments: SolarRoofSegment[];
}

const M_PER_DEG_LAT = 111_320;

function toLocal(ring: LngLat[], lat0: number, lng0: number): Array<[number, number]> {
    const k = M_PER_DEG_LAT * Math.cos((lat0 * Math.PI) / 180);
    return ring.map(([lng, lat]) => [(lng - lng0) * k, (lat - lat0) * M_PER_DEG_LAT]);
}

function pointInRing(x: number, y: number, ring: Array<[number, number]>): boolean {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const [xi, yi] = ring[i], [xj, yj] = ring[j];
        if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
}

function distanceToRing(x: number, y: number, ring: Array<[number, number]>): number {
    let best = Infinity;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const [ax, ay] = ring[j], [bx, by] = ring[i];
        const dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy || 1e-12;
        const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / len2));
        best = Math.min(best, Math.hypot(x - (ax + t * dx), y - (ay + t * dy)));
    }
    return best;
}

function percentile(values: number[], p: number): number | undefined {
    if (!values.length) return undefined;
    const s = [...values].sort((a, b) => a - b);
    return s[Math.min(s.length - 1, Math.max(0, Math.round((p / 100) * (s.length - 1))))];
}

export interface FusionOptions {
    /** Sample spacing inside the footprint, meters (default 1). */
    sampleSpacingMeters?: number;
    /** Ground band outside the footprint, meters (default 2-8). */
    groundBandMeters?: [number, number];
    /** Other buildings' rings, so the ground band skips neighbouring roofs. */
    neighbours?: LngLat[][];
    /**
     * Road centerline vertices (from vector tiles). In a dense block the band around a footprint is neighbouring
     * roofs, not ground; street level is measured on the roads instead. Densify long segments before passing them.
     */
    roadPoints?: LngLat[];
    /** Roads within this distance of the building centre count for its ground (default 60 m). */
    roadRadiusMeters?: number;
}

/** Fuse one building's vector footprint/height with the Solar DSM and roof segments. */
export function fuseBuilding(
    fp: FusionFootprint,
    dsm: DsmRaster | undefined,
    segments: SolarRoofSegment[] = [],
    options: FusionOptions = {}
): FusedBuilding {
    const lat0 = fp.ring.reduce((a, p) => a + p[1], 0) / fp.ring.length;
    const lng0 = fp.ring.reduce((a, p) => a + p[0], 0) / fp.ring.length;
    const k = M_PER_DEG_LAT * Math.cos((lat0 * Math.PI) / 180);
    const local = toLocal(fp.ring, lat0, lng0);
    const neighbours = (options.neighbours || []).map(r => toLocal(r, lat0, lng0));
    const step = options.sampleSpacingMeters ?? 1;
    const [bandIn, bandOut] = options.groundBandMeters ?? [2, 8];
    const xs = local.map(p => p[0]), ys = local.map(p => p[1]);
    const [minX, maxX, minY, maxY] = [Math.min(...xs) - bandOut, Math.max(...xs) + bandOut, Math.min(...ys) - bandOut, Math.max(...ys) + bandOut];

    const inside: number[] = [], ground: number[] = [];
    let insideTotal = 0;
    if (dsm) {
        for (let y = minY; y <= maxY; y += step) {
            for (let x = minX; x <= maxX; x += step) {
                const isInside = pointInRing(x, y, local);
                const h = sampleDsm(dsm, lat0 + y / M_PER_DEG_LAT, lng0 + x / k);
                if (isInside) {
                    insideTotal++;
                    if (Number.isFinite(h)) inside.push(h);
                } else if (Number.isFinite(h)) {
                    const d = distanceToRing(x, y, local);
                    if (d >= bandIn && d <= bandOut && !neighbours.some(n => pointInRing(x, y, n))) ground.push(h);
                }
            }
        }
    }
    const dsmCoverage = insideTotal ? inside.length / insideTotal : 0;
    // Street level from the roads when there are any nearby; a low percentile ignores vehicles and trees.
    const roadGround: number[] = [];
    if (dsm) {
        const r = options.roadRadiusMeters ?? 60;
        for (const [lng, lat] of options.roadPoints || []) {
            const x = (lng - lng0) * k, y = (lat - lat0) * M_PER_DEG_LAT;
            if (Math.hypot(x, y) > r) continue;
            const h = sampleDsm(dsm, lat, lng);
            if (Number.isFinite(h)) roadGround.push(h);
        }
    }
    const groundSource: FusedBuilding['groundSource'] = roadGround.length >= 5 ? 'roads' : ground.length ? 'band' : undefined;
    const groundMsl = groundSource === 'roads' ? percentile(roadGround, 20) : percentile(ground, 10);
    const roofMsl = percentile(inside, 50);
    const peakMsl = percentile(inside, 100);
    const measured = groundMsl !== undefined && roofMsl !== undefined && peakMsl !== undefined && dsmCoverage >= 0.5;
    const dsmRoof = measured ? roofMsl! - groundMsl! : undefined;
    const dsmPeak = measured ? peakMsl! - groundMsl! : undefined;

    const vectorHeight = fp.vectorHeightMeters && fp.vectorHeightMeters > 0 ? fp.vectorHeightMeters : undefined;
    const disagreement = measured && vectorHeight !== undefined
        ? Math.min(Math.abs(dsmRoof! - vectorHeight), Math.abs(dsmPeak! - vectorHeight))
        : undefined;
    // The DSM is a measurement, so it leads when it covers the footprint; the vector height is the fallback.
    const heightMeters = dsmRoof ?? vectorHeight;
    const heightSource = dsmRoof !== undefined ? 'dsm' : vectorHeight !== undefined ? 'vector' : 'none';
    const tolerance = heightMeters !== undefined ? Math.max(3, 0.05 * heightMeters) : 0;
    const confidence: FusedBuilding['confidence'] = disagreement !== undefined
        ? (disagreement <= tolerance ? 'high' : disagreement <= 3 * tolerance ? 'medium' : 'low')
        : heightSource === 'dsm' ? 'medium' : 'low';

    const ownSegments = segments.filter(s => pointInRing((s.center.longitude - lng0) * k, (s.center.latitude - lat0) * M_PER_DEG_LAT, local));
    return {
        id: fp.id,
        ring: fp.ring,
        groundMsl,
        groundSource,
        roofMsl,
        peakMsl,
        dsmCoverage,
        dsmRoofHeightMeters: dsmRoof,
        dsmPeakHeightMeters: dsmPeak,
        vectorHeightMeters: vectorHeight,
        heightMeters,
        heightSource,
        disagreementMeters: disagreement,
        confidence,
        roofSegments: ownSegments
    };
}

/** Road polylines to points every `spacingMeters` along them, for ground sampling. */
export function densifyRoads(lines: LngLat[][], spacingMeters = 4): LngLat[] {
    const out: LngLat[] = [];
    for (const line of lines) {
        for (let i = 0; i + 1 < line.length; i++) {
            const [a, b] = [line[i], line[i + 1]];
            const k = M_PER_DEG_LAT * Math.cos((a[1] * Math.PI) / 180);
            const len = Math.hypot((b[0] - a[0]) * k, (b[1] - a[1]) * M_PER_DEG_LAT);
            const n = Math.max(1, Math.ceil(len / spacingMeters));
            for (let j = 0; j < n; j++) out.push([a[0] + ((b[0] - a[0]) * j) / n, a[1] + ((b[1] - a[1]) * j) / n]);
        }
        if (line.length) out.push(line[line.length - 1]);
    }
    return out;
}

/** Convex hull of [lng, lat] points (monotone chain), e.g. the plan outline of a modeled volume's base. */
export function convexHull(points: LngLat[]): LngLat[] {
    const p = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    if (p.length < 3) return p;
    const cross = (o: LngLat, a: LngLat, b: LngLat) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
    const lower: LngLat[] = [], upper: LngLat[] = [];
    for (const q of p) { while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], q) <= 0) lower.pop(); lower.push(q); }
    for (const q of p.reverse()) { while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], q) <= 0) upper.pop(); upper.push(q); }
    return lower.slice(0, -1).concat(upper.slice(0, -1));
}

/** Street level (m above sea level) near a point: the 20th percentile of the DSM on roads within `radius` m. */
export function streetLevelNear(dsm: DsmRaster, latDeg: number, lngDeg: number, roadPoints: LngLat[], radius = 60): number | undefined {
    const k = M_PER_DEG_LAT * Math.cos((latDeg * Math.PI) / 180);
    const hs: number[] = [];
    for (const [lng, lat] of roadPoints) {
        if (Math.hypot((lng - lngDeg) * k, (lat - latDeg) * M_PER_DEG_LAT) > radius) continue;
        const h = sampleDsm(dsm, lat, lng);
        if (Number.isFinite(h)) hs.push(h);
    }
    return hs.length >= 5 ? percentile(hs, 20) : undefined;
}
