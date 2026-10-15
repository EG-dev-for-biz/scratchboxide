/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import { LocationUnresolvedError, MissingInputError } from '../errors/pipeline-errors';

export interface ParsedCoordinates {
    lat: number;
    lng: number;
    /** Metres above sea level, only when the text states it. */
    elevation?: number;
}

const NUMBER = '([-+]?\\d{1,3}(?:\\.\\d+)?)';
const SEPARATOR = '(?:\\s*[,;]\\s*|\\s+)';
const LAT_LABEL = '(lat(?:itude)?\\s*[:=]?\\s*)?';
const LNG_LABEL = '((?:lng|lon|long|longitude)\\s*[:=]?\\s*)?';
const WHOLE_INPUT_COORDINATES = new RegExp(
    '^\\s*[\\[(]?\\s*' +
    `${LAT_LABEL}${NUMBER}\\s*(°)?\\s*([NS])?` +
    `(\\s*[,;]\\s*|\\s+)` +
    `${LNG_LABEL}${NUMBER}\\s*(°)?\\s*([EW])?` +
    `(?:${SEPARATOR}(?:(?:elevation|elev|alt|altitude)\\s*[:=]?\\s*)?([-+]?\\d+(?:\\.\\d+)?)\\s*m?)?` +
    '\\s*[\\])]?\\s*$',
    'i'
);

/**
 * Reads text that is entirely a coordinate pair, such as "40.7411, -73.9897", "40.7411 -73.9897",
 * "40.7411° N, 73.9897° W" or "lat: 40.7411, lng: -73.9897", with an optional trailing elevation in
 * metres. Anything else returns undefined: an address that merely contains numbers
 * ("Pier 39, 2 Beach St, San Francisco") is a place name, not a coordinate.
 *
 * The pair must also be written as coordinates: a decimal point in the latitude or longitude, a comma or
 * semicolon between them, a degree sign, a hemisphere letter or a lat/lng label. Bare whole numbers split by
 * spaces ("7 11", "90 210", "1 2 3") are place text for Places, not coordinates.
 */
export function parseCoordinateText(text: string): ParsedCoordinates | undefined {
    const match = WHOLE_INPUT_COORDINATES.exec(text);
    if (!match) return undefined;
    const [, latLabel, latText, latDegree, latHemi, pairSeparator, lngLabel, lngText, lngDegree, lngHemi, elevationText] = match;
    const writtenAsCoordinates = latText.includes('.') || lngText.includes('.')
        || /[,;]/.test(pairSeparator)
        || !!(latDegree || lngDegree || latHemi || lngHemi || latLabel || lngLabel);
    if (!writtenAsCoordinates) return undefined;
    let lat = parseFloat(latText);
    let lng = parseFloat(lngText);
    if ((latHemi || '').toUpperCase() === 'S') lat = -Math.abs(lat);
    if ((lngHemi || '').toUpperCase() === 'W') lng = -Math.abs(lng);
    const elevation = elevationText !== undefined ? parseFloat(elevationText) : undefined;
    return { lat, lng, ...(elevation !== undefined ? { elevation } : {}) };
}

/**
 * Throws LocationUnresolvedError unless (lat, lng) is a usable point on Earth. (0, 0) is rejected:
 * it is what an unresolved place turns into, not a place anyone asks for.
 */
export function assertUsableCoordinates(lat: number, lng: number, query: string): void {
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
        throw new LocationUnresolvedError(query, 'latitude and longitude must be finite numbers');
    }
    if (Math.abs(lat) > 90 || Math.abs(lng) > 180) {
        throw new LocationUnresolvedError(query, `(${lat}, ${lng}) is outside the valid range (latitude within ±90, longitude within ±180)`);
    }
    if (lat === 0 && lng === 0) {
        throw new LocationUnresolvedError(query, '(0, 0) is not a location; it is what an unresolved place turns into');
    }
}

/** "40.741100, -73.989700": the exact coordinates, for summaries that must not invent a place name. */
export function formatCoordinates(lat: number, lng: number): string {
    return `${lat.toFixed(6)}, ${lng.toFixed(6)}`;
}

/**
 * Reads a tool's latitude/longitude arguments: numbers, or text that is a plain number. Missing values throw
 * MissingInputError (no default place is used); unusable ones throw LocationUnresolvedError.
 */
export function readCoordinateArgs(tool: string, latitude: unknown, longitude: unknown): { lat: number; lng: number } {
    const read = (v: unknown): number | undefined => {
        if (typeof v === 'number') return v;
        if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
        return undefined;
    };
    const lat = read(latitude);
    const lng = read(longitude);
    if (lat === undefined || lng === undefined) {
        throw new MissingInputError(tool, 'latitude and longitude', 'give the place\'s coordinates in degrees; no default location is used');
    }
    assertUsableCoordinates(lat, lng, `${String(latitude)}, ${String(longitude)}`);
    return { lat, lng };
}
