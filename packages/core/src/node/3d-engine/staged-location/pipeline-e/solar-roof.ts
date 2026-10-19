/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Google Solar API roof segments (buildingInsights, read through location_building_shape) for pipeline E's massing: planar roof facets with pitch,
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

/**
 * The Solar roof facets of the building at (lat, lng), through location_building_shape (runBuildingShape: the vector
 * footprint the Solar building is matched to, its buildingInsights roof segments). Facets of another building (the API
 * answered for a neighbour) are not used. Throws with the tool's typed reason when there is nothing.
 */
export async function solarRoofFromBuildingShape(lat: number, lng: number, workspaceRoot: string, apiKey?: string): Promise<SolarRoof> {
    const { runBuildingShape } = await import('../../../gemini/tools/location-evidence/building-shape');
    const r = await runBuildingShape({ latitude: lat, longitude: lng }, { workspaceRoot, ...(apiKey ? { apiKey } : {}) });
    const ins = r.target.solarInsights;
    if (ins.status !== 'found') throw new Error(`no Solar roof facets for the building (${ins.status}${ins.reason ? `: ${ins.reason}` : ''})`);
    return {
        segments: r.target.roofSegments.map(s => ({ pitchDeg: s.pitchDegrees, azimuthDeg: s.azimuthDegrees, planeHeightMsl: s.planeHeightMsl, center: { lat: s.centerWgs84[1], lng: s.centerWgs84[0] }, areaM2: s.areaM2 })),
        ...(ins.imageryDate ? { imageryDate: ins.imageryDate } : {}),
        ...(ins.solarBuildingCenterWgs84 ? { center: { lat: ins.solarBuildingCenterWgs84[1], lng: ins.solarBuildingCenterWgs84[0] } } : {})
    };
}

/** Tile-frame y of a height above mean sea level at (lat, lng): ellipsoidal (+ EGM96 N) minus the frame origin's height. */
export function mslToTileY(heightMsl: number, lat: number, lng: number, originEllipsoidalHeightM: number): number {
    return heightMsl + geoidUndulation(lat, lng) - originEllipsoidalHeightM;
}
