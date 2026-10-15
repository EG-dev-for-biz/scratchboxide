/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Where a scene's live Google 3D Tiles go, and whether that place is usable. Pure (no three.js or tiles renderer), so
 * the viewport's tiles layer and the mount tool on the server judge an anchor the same way.
 */
import type { Scene3DData } from '../../canvas-types';
import { finiteCoordinate } from './geoAnchorLabels';

/** A scene's tiles anchor as stored: numbers, or numeric strings as some saved scenes hold them. */
export interface LiveTilesAnchorInput {
    lat: number | string;
    lng: number | string;
    elevation?: number | string;
    geoidUndulationMeters?: number;
}

/** The scene asks for live tiles: it has an active geoAnchor, or a map-3d object. */
export function sceneAsksForLiveTiles(scene: Pick<Scene3DData, 'geoAnchor' | 'objects'>): boolean {
    return !!((scene.geoAnchor && scene.geoAnchor.active !== false) || scene.objects?.some(o => o?.content?.type === 'map-3d'));
}

/**
 * Where live tiles are placed for a scene: its active geoAnchor, else the anchor of the map-3d object that asks for
 * them. The known geoid undulation travels with it so the tile heights need no lookup. Null when neither has one.
 */
export function liveTilesAnchor(scene: Pick<Scene3DData, 'geoAnchor' | 'objects'>): LiveTilesAnchorInput | null {
    const a = scene.geoAnchor;
    if (a && a.active !== false) {
        return { lat: a.lat, lng: a.lng, elevation: a.elevation, geoidUndulationMeters: a.geoidUndulationMeters };
    }
    const g = scene.objects?.find(o => o?.content?.type === 'map-3d' && o.space?.geoAnchor)?.space?.geoAnchor;
    return g ? { lat: g.lat, lng: g.lng, elevation: g.alt } : null;
}

/** A usable anchor (numbers in range, not 0, 0), or why it is not one. */
export type LiveTilesAnchorCheck =
    | { ok: true; lat: number; lng: number; elevation?: number }
    | { ok: false; missing: boolean; reason: string };

/**
 * Whether live tiles can be placed at an anchor. A missing anchor, non-numeric or out-of-range coordinates and 0, 0
 * (an unset location, not a place) are refused with the reason; nothing is defaulted.
 */
export function checkLiveTilesAnchor(anchor: LiveTilesAnchorInput | null | undefined): LiveTilesAnchorCheck {
    if (!anchor) return { ok: false, missing: true, reason: 'the scene has no geoAnchor (lat/lng)' };
    const lat = finiteCoordinate(anchor.lat);
    const lng = finiteCoordinate(anchor.lng);
    if (lat === undefined || lng === undefined) {
        return { ok: false, missing: false, reason: `the scene's geoAnchor lat/lng are not numbers (lat ${JSON.stringify(anchor.lat)}, lng ${JSON.stringify(anchor.lng)})` };
    }
    if (Math.abs(lat) > 90 || Math.abs(lng) > 180) {
        return { ok: false, missing: false, reason: `the scene's geoAnchor ${lat}, ${lng} is outside the valid latitude/longitude range` };
    }
    if (lat === 0 && lng === 0) {
        return { ok: false, missing: false, reason: 'the scene\'s geoAnchor is 0, 0, which is an unset location, not a place' };
    }
    const elevation = finiteCoordinate(anchor.elevation);
    return { ok: true, lat, lng, ...(elevation !== undefined ? { elevation } : {}) };
}

/** Why the live tiles a scene asks for cannot be placed; null when it asks for none or its anchor is usable. */
export function liveTilesAnchorProblem(scene: Pick<Scene3DData, 'geoAnchor' | 'objects'>): string | null {
    if (!sceneAsksForLiveTiles(scene)) return null;
    const check = checkLiveTilesAnchor(liveTilesAnchor(scene));
    return check.ok ? null : check.reason;
}
