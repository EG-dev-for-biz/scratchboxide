/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import * as THREE from 'three';
import { SolarCoordinates } from './atmosphere-types';
import { computeSolarEphemeris } from '../../../../common/coordinate/solarPosition';

const DEG = 180 / Math.PI;

/**
 * Computes the astronomical Julian Day from civil date components and UTC decimal hours.
 */
export function calculateJulianDay(year: number, month: number, day: number, utcHours: number): number {
    let y = year;
    let m = month;
    if (m <= 2) {
        y -= 1;
        m += 12;
    }
    const a = Math.floor(y / 100);
    const b = 2 - a + Math.floor(a / 4);
    const dayFraction = utcHours / 24.0;
    return Math.floor(365.25 * (y + 4716)) + Math.floor(30.6001 * (m + 1)) + day + b - 1524.5 + dayFraction;
}

/**
 * NOAA-style solar position: geometric altitude (elevation) and azimuth of the sun at the instant `date` names
 * (its UTC time; the host time zone plays no part), seen from lat/lng.
 */
export function calculateNOAASolarPosition(date: Date, lat: number, lng: number): SolarCoordinates {
    const { altitude: altitudeRad, azimuth: azimuthRad, julianDay, meanAnomalyRad: g } = computeSolarEphemeris(date, lat, lng);
    const elevationDeg = altitudeRad * DEG;
    const azimuthDeg = azimuthRad * DEG;
    const distanceAU = 1.00014 - 0.01671 * Math.cos(g) - 0.00014 * Math.cos(2 * g);
    return { altitudeRad, azimuthRad, elevationDeg, azimuthDeg, distanceAU, julianDay };
}

/**
 * Computes an East-North-Up (ENU) 3D unit direction vector pointing towards the sun.
 * Convention in Three.js viewport: +X East, +Y Up, -Z North.
 */
export function calculateENUSunVector(altitudeRad: number, azimuthRad: number): THREE.Vector3 {
    const cosElev = Math.cos(altitudeRad);
    return new THREE.Vector3(
        cosElev * Math.sin(azimuthRad),  // East (+X)
        Math.sin(altitudeRad),          // Up (+Y)
        -cosElev * Math.cos(azimuthRad) // North (-Z)
    ).normalize();
}

/**
 * Convenience helper to compute sun direction vector directly from degree angles.
 */
export function getSunVectorFromAngles(elevationDeg: number, azimuthDeg: number): THREE.Vector3 {
    const radElev = (elevationDeg * Math.PI) / 180;
    const radAzim = azimuthDeg <= 1.0
        ? azimuthDeg * Math.PI * 2
        : (azimuthDeg * Math.PI) / 180;
    return calculateENUSunVector(radElev, radAzim);
}
