/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import { GeoFrame } from '../../../../common/coordinate/GeoFrame';

/** A finite number from a number or a numeric string; undefined otherwise (never a default). */
export function finiteCoordinate(v: unknown): number | undefined {
    if (typeof v === 'number') return Number.isFinite(v) ? v : undefined;
    if (typeof v === 'string' && v.trim() !== '') {
        const n = Number(v);
        return Number.isFinite(n) ? n : undefined;
    }
    return undefined;
}

/** A latitude/longitude pair when both parse and lie in range; null otherwise. */
export function geodeticPoint(lat: unknown, lng: unknown): { lat: number; lng: number } | null {
    const la = finiteCoordinate(lat);
    const lo = finiteCoordinate(lng);
    if (la === undefined || lo === undefined || Math.abs(la) > 90 || Math.abs(lo) > 180) return null;
    return { lat: la, lng: lo };
}

/** How far from the anchor a route pin is drawn on the ground plane, in scene units. */
const ROUTE_EXTENT = 20;

/**
 * Where a drone-route pin sits on the ground plane (y = 0): its east/north offset from the scene's anchor, clamped to
 * the routing overlay. Both points are taken at the same height, so no elevation enters the offset (none is assumed).
 * Null when the anchor or the pin has no usable coordinates: the pin is not drawn rather than placed at a default place.
 */
export function projectRoutePoint(anchor: { lat: unknown; lng: unknown }, point: { lat: unknown; lng: unknown }): { x: number; z: number } | null {
    const origin = geodeticPoint(anchor.lat, anchor.lng);
    const target = geodeticPoint(point.lat, point.lng);
    if (!origin || !target) return null;
    const frame = new GeoFrame({ lat: origin.lat, lng: origin.lng, alt: 0 });
    const [x, , z] = frame.toScene({ lat: target.lat, lng: target.lng, alt: 0 });
    return {
        x: Math.max(-ROUTE_EXTENT, Math.min(ROUTE_EXTENT, x)),
        z: Math.max(-ROUTE_EXTENT, Math.min(ROUTE_EXTENT, z))
    };
}

/**
 * The ground-datum badge for an anchor with an elevation: the elevation, and only the source and vertical datum the
 * anchor records. An unrecorded source or datum is said to be unrecorded, never filled in as the Google Elevation API
 * or EGM96 / MSL. Null when the anchor has no usable elevation.
 */
export function groundDatumBadge(anchor: {
    lat: unknown;
    lng: unknown;
    elevation?: unknown;
    elevationSource?: string;
    datum?: string;
    landmarkName?: string;
}): { text: string; title: string } | null {
    const elevation = finiteCoordinate(anchor.elevation);
    if (elevation === undefined) return null;
    const point = geodeticPoint(anchor.lat, anchor.lng);
    const where = point ? ` (${point.lat.toFixed(4)}°, ${point.lng.toFixed(4)}°)` : '';
    const datum = anchor.datum ? ` ${anchor.datum}` : '';
    return {
        text: `${elevation.toFixed(1)} m${datum}`,
        title: `Ground datum: ${anchor.landmarkName || 'geospatial anchor'}${where} · ground elevation ${elevation.toFixed(1)} m` +
            ` [source: ${anchor.elevationSource || 'not recorded'}, vertical datum: ${anchor.datum || 'not recorded'}]`
    };
}
