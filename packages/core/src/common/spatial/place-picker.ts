/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The place picker: a map in the chat's question card (ask_user_question `placePicker`) on which the user clicks the
 * place they mean (user ask, 2026-11-11). This module is the part with no DOM in it: the request and answer shapes, the
 * Web Mercator arithmetic the map is drawn with, and the sentence the pick is sent back to the chat as.
 *
 * Everything here is a measurement (degrees, metres, pixels, zoom): there is no kind of place and no list of places.
 * The map's tiles are Google's 2D roadmap, served by the app's own route (/api/map-data/roadmap/tile/z/x/y).
 */

/** Tiles are 256 CSS px on a side at every zoom (Google's 2D Tiles, as the Map data view draws them). */
export const PLACE_PICKER_TILE_PX = 256;
export const PLACE_PICKER_MIN_ZOOM = 2;
export const PLACE_PICKER_MAX_ZOOM = 20;
/** Zoom the map opens at on a known centre (a few city blocks across) and with none (the world). */
export const PLACE_PICKER_PLACE_ZOOM = 16;
export const PLACE_PICKER_WORLD_ZOOM = 2;
/** The area circle's radius limits, the staged build's own (google_3d_tiles_get_clay radiusMeters). */
export const PLACE_PICKER_MIN_RADIUS_M = 50;
export const PLACE_PICKER_MAX_RADIUS_M = 500;
const MERCATOR_MAX_LAT = 85.05112878;
const EARTH_CIRCUMFERENCE_M = 40075016.686;

/** What the chat asks the picker to show. Every field is optional: with none, the map opens on the world. */
export interface PlacePickerRequest {
    /** A sentence or two shown above the map: what will be made, and a suggestion of what to try. */
    message?: string;
    /** A place name or address to centre the map on (looked up by the app's geocoder when the card opens). */
    query?: string;
    /** A centre already known, in degrees. */
    lat?: number;
    lng?: number;
    /** When given, the pick is an area: a circle of this radius the user can resize. Absent: the pick is one point. */
    radiusMeters?: number;
}

/** What the user picked. */
export interface PlacePick {
    lat: number;
    lng: number;
    /** The area's radius, only when the request asked for an area. */
    radiusMeters?: number;
    /** The address the user searched for and then confirmed without moving the pin, when there is one. */
    address?: string;
}

export interface MapView {
    lat: number;
    lng: number;
    zoom: number;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** World pixel coordinates (x east, y south) of a point at a zoom. */
export function lngLatToWorldPx(lng: number, lat: number, zoom: number): { x: number; y: number } {
    const size = PLACE_PICKER_TILE_PX * 2 ** zoom;
    const phi = clamp(lat, -MERCATOR_MAX_LAT, MERCATOR_MAX_LAT) * Math.PI / 180;
    return {
        x: (lng + 180) / 360 * size,
        y: (0.5 - Math.log(Math.tan(Math.PI / 4 + phi / 2)) / (2 * Math.PI)) * size
    };
}

/** The inverse of lngLatToWorldPx; the longitude is wrapped into [-180, 180). */
export function worldPxToLngLat(x: number, y: number, zoom: number): { lng: number; lat: number } {
    const size = PLACE_PICKER_TILE_PX * 2 ** zoom;
    const lng = ((x / size * 360 - 180) % 360 + 540) % 360 - 180;
    const lat = (2 * Math.atan(Math.exp((0.5 - y / size) * 2 * Math.PI)) - Math.PI / 2) * 180 / Math.PI;
    return { lng, lat: clamp(lat, -MERCATOR_MAX_LAT, MERCATOR_MAX_LAT) };
}

/** Ground metres one CSS pixel covers at a latitude and zoom. */
export function metersPerPixel(lat: number, zoom: number): number {
    return EARTH_CIRCUMFERENCE_M * Math.cos(clamp(lat, -MERCATOR_MAX_LAT, MERCATOR_MAX_LAT) * Math.PI / 180) / (PLACE_PICKER_TILE_PX * 2 ** zoom);
}

export interface PlacedTile {
    z: number;
    x: number;
    y: number;
    /** Where the tile's top-left corner sits in the viewport, in CSS px. */
    left: number;
    top: number;
}

/** The tiles a viewport of width x height px shows when centred on a view; columns wrap around the antimeridian. */
export function tilesForView(view: MapView, width: number, height: number): PlacedTile[] {
    const z = Math.round(view.zoom);
    const n = 2 ** z;
    const c = lngLatToWorldPx(view.lng, view.lat, z);
    const left = c.x - width / 2, top = c.y - height / 2;
    const tiles: PlacedTile[] = [];
    for (let ty = Math.floor(top / PLACE_PICKER_TILE_PX); ty * PLACE_PICKER_TILE_PX < top + height; ty++) {
        if (ty < 0 || ty >= n) continue;
        for (let tx = Math.floor(left / PLACE_PICKER_TILE_PX); tx * PLACE_PICKER_TILE_PX < left + width; tx++) {
            tiles.push({ z, x: ((tx % n) + n) % n, y: ty, left: tx * PLACE_PICKER_TILE_PX - left, top: ty * PLACE_PICKER_TILE_PX - top });
        }
    }
    return tiles;
}

/** The point under a viewport pixel. */
export function viewportToLngLat(view: MapView, width: number, height: number, px: number, py: number): { lng: number; lat: number } {
    const z = Math.round(view.zoom);
    const c = lngLatToWorldPx(view.lng, view.lat, z);
    return worldPxToLngLat(c.x - width / 2 + px, c.y - height / 2 + py, z);
}

/** The viewport pixel a point is drawn at. */
export function lngLatToViewport(view: MapView, width: number, height: number, lng: number, lat: number): { x: number; y: number } {
    const z = Math.round(view.zoom);
    const c = lngLatToWorldPx(view.lng, view.lat, z), p = lngLatToWorldPx(lng, lat, z);
    return { x: p.x - c.x + width / 2, y: p.y - c.y + height / 2 };
}

/** The view after a drag of (dx, dy) px: the map follows the pointer. */
export function panView(view: MapView, dx: number, dy: number): MapView {
    const z = Math.round(view.zoom);
    const c = lngLatToWorldPx(view.lng, view.lat, z);
    const size = PLACE_PICKER_TILE_PX * 2 ** z;
    const moved = worldPxToLngLat(c.x - dx, clamp(c.y - dy, 0, size), z);
    return { ...view, lat: moved.lat, lng: moved.lng };
}

/** The view after zooming by whole steps about a viewport pixel, which stays over the same point. */
export function zoomView(view: MapView, steps: number, width: number, height: number, px = width / 2, py = height / 2): MapView {
    const zoom = clamp(Math.round(view.zoom) + Math.round(steps), PLACE_PICKER_MIN_ZOOM, PLACE_PICKER_MAX_ZOOM);
    if (zoom === Math.round(view.zoom)) return { ...view, zoom };
    const anchor = viewportToLngLat(view, width, height, px, py);
    const a = lngLatToWorldPx(anchor.lng, anchor.lat, zoom);
    const centre = worldPxToLngLat(a.x - (px - width / 2), a.y - (py - height / 2), zoom);
    return { lat: centre.lat, lng: centre.lng, zoom };
}

/** The request as the card keeps it: numbers checked, the radius held to the build's limits. */
export function normalizePlacePickerRequest(raw: unknown): PlacePickerRequest | undefined {
    if (!raw || typeof raw !== 'object') return undefined;
    const r = raw as Record<string, unknown>;
    const out: PlacePickerRequest = {};
    if (typeof r.message === 'string' && r.message.trim()) out.message = r.message.trim();
    if (typeof r.query === 'string' && r.query.trim()) out.query = r.query.trim();
    const lat = Number(r.lat), lng = Number(r.lng);
    if (r.lat !== undefined && r.lng !== undefined && Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180) {
        out.lat = lat;
        out.lng = lng;
    }
    const radius = Number(r.radiusMeters ?? r.radius_meters);
    if (Number.isFinite(radius) && radius > 0) out.radiusMeters = clamp(Math.round(radius), PLACE_PICKER_MIN_RADIUS_M, PLACE_PICKER_MAX_RADIUS_M);
    return out;
}

/**
 * The pick as the chat reads it: the coordinates first, written so a tool takes them as a "latitude, longitude" query,
 * then the radius of an area pick and the address the user searched for.
 */
export function formatPlacePick(pick: PlacePick): string {
    const coords = `${pick.lat.toFixed(6)}, ${pick.lng.toFixed(6)}`;
    const area = pick.radiusMeters ? `, an area of ${Math.round(pick.radiusMeters)} m radius around it` : '';
    const address = pick.address ? ` (searched for: ${pick.address})` : '';
    return `[Place picked on the map]: ${coords}${area}${address}. Use these coordinates as the place.`;
}
