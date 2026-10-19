/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Google Solar API roof segments (buildingInsights:findClosest) for pipeline E's massing: planar roof facets with pitch,
 * azimuth, the plane's height at its centre (metres above mean sea level) and area. Heights are moved into the tile frame
 * by the EGM96 undulation (tiles are ellipsoidal) and the frame's origin height; the massing then checks each facet
 * against the scan before it shapes a roof.
 */

import { geoidUndulation } from '../../../spatial/egm96-geoid';

export interface SolarRoofSegment {
    pitchDeg: number;
    /** Compass direction the facet faces (downslope), degrees clockwise from north. */
    azimuthDeg: number;
    /** Plane height at the facet centre, metres above mean sea level. */
    planeHeightMsl: number;
    center: { lat: number; lng: number };
    areaM2: number;
}

export interface SolarRoof {
    segments: SolarRoofSegment[];
    imageryQuality?: string;
    imageryDate?: string;
    /** The building the API matched (its centre), for the record. */
    center?: { lat: number; lng: number };
}

/** Parses a buildingInsights answer; tolerant of missing fields (a facet without its numbers is left out). */
export function parseBuildingInsights(json: unknown): SolarRoof {
    const j = (json ?? {}) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
    const segs = Array.isArray(j.solarPotential?.roofSegmentStats) ? j.solarPotential.roofSegmentStats : [];
    const segments: SolarRoofSegment[] = [];
    for (const s of segs) {
        const pitch = Number(s?.pitchDegrees), az = Number(s?.azimuthDegrees ?? 0), h = Number(s?.planeHeightAtCenterMeters);
        const lat = Number(s?.center?.latitude), lng = Number(s?.center?.longitude), area = Number(s?.stats?.areaMeters2);
        if (![pitch, az, h, lat, lng, area].every(Number.isFinite)) continue;
        segments.push({ pitchDeg: pitch, azimuthDeg: az, planeHeightMsl: h, center: { lat, lng }, areaM2: area });
    }
    const d = j.imageryDate;
    return {
        segments,
        ...(typeof j.imageryQuality === 'string' ? { imageryQuality: j.imageryQuality } : {}),
        ...(d?.year ? { imageryDate: `${d.year}-${String(d.month ?? 1).padStart(2, '0')}-${String(d.day ?? 1).padStart(2, '0')}` } : {}),
        ...(Number.isFinite(Number(j.center?.latitude)) ? { center: { lat: Number(j.center.latitude), lng: Number(j.center.longitude) } } : {})
    };
}

const memo = new Map<string, Promise<SolarRoof>>();

/** The Solar roof segments of the building closest to (lat, lng). Throws with the API's message when there is none. */
export function fetchSolarRoof(lat: number, lng: number, apiKey: string, fetchImpl: typeof fetch = fetch): Promise<SolarRoof> {
    if (!apiKey) return Promise.reject(new Error('no Google Maps API key for the Solar API'));
    const key = `${lat.toFixed(6)},${lng.toFixed(6)}`;
    let p = memo.get(key);
    if (!p) {
        p = (async () => {
            const params = new URLSearchParams({ 'location.latitude': String(lat), 'location.longitude': String(lng), requiredQuality: 'LOW', key: apiKey });
            const res = await fetchImpl(`https://solar.googleapis.com/v1/buildingInsights:findClosest?${params}`);
            const json = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(`Solar buildingInsights unavailable (${res.status}): ${(json as { error?: { message?: string } })?.error?.message ?? 'no answer'}`);
            return parseBuildingInsights(json);
        })();
        p.catch(() => memo.delete(key));
        memo.set(key, p);
    }
    return p;
}

/** Tile-frame y of a height above mean sea level at (lat, lng): ellipsoidal (+ EGM96 N) minus the frame origin's height. */
export function mslToTileY(heightMsl: number, lat: number, lng: number, originEllipsoidalHeightM: number): number {
    return heightMsl + geoidUndulation(lat, lng) - originEllipsoidalHeightM;
}
