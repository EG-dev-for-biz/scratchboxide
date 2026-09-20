/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import * as THREE from 'three';
import { SolarCoordinates } from './atmosphere-types';

const RAD = Math.PI / 180;
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
 * High-precision NOAA solar position algorithm.
 * Calculates true solar altitude (elevation) and solar azimuth for any geographic coordinates and time.
 */
export function calculateNOAASolarPosition(date: Date, lat: number, lng: number): SolarCoordinates {
    const localMillis = date.getTime() - date.getTimezoneOffset() * 60000;
    const destinationUtcMillis = localMillis - (lng / 15) * 3600000;

    const jd = destinationUtcMillis / 86400000 + 2440587.5;
    const n = jd - 2451545.0; // Days since J2000 epoch

    // Mean solar anomaly g
    const L = (280.46 + 0.9856474 * n) % 360;
    const g = ((357.528 + 0.9856003 * n) % 360) * RAD;

    // Ecliptic longitude lambda
    const lambda = (L + 1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g)) * RAD;
    const epsilon = (23.439 - 0.0000004 * n) * RAD; // Obliquity of ecliptic

    // Right ascension and declination
    const ra = Math.atan2(Math.cos(epsilon) * Math.sin(lambda), Math.cos(lambda));
    const dec = Math.asin(Math.max(-1, Math.min(1, Math.sin(epsilon) * Math.sin(lambda))));

    // Greenwich Mean Sidereal Time (GMST) and Local Sidereal Time (LST)
    const gmst = (18.697374558 + 24.06570982441908 * n) % 24;
    const gmstHours = (gmst + 24) % 24;
    const lst = ((gmstHours * 15 + lng) % 360) * RAD;

    // Hour angle H
    let H = lst - ra;
    if (H > Math.PI) H -= 2 * Math.PI;
    if (H < -Math.PI) H += 2 * Math.PI;

    const phi = lat * RAD;

    // Altitude (elevation) angle above horizon
    const sinAltitude = Math.sin(phi) * Math.sin(dec) + Math.cos(phi) * Math.cos(dec) * Math.cos(H);
    const altitudeRad = Math.asin(Math.max(-1, Math.min(1, sinAltitude)));

    // Solar azimuth angle (clockwise from North)
    const azimuthRad = Math.atan2(
        -Math.sin(H),
        Math.tan(dec) * Math.cos(phi) - Math.sin(phi) * Math.cos(H)
    );

    const elevationDeg = altitudeRad * DEG;
    const azimuthDeg = ((azimuthRad * DEG) + 360) % 360;

    const distanceAU = 1.00014 - 0.01671 * Math.cos(g) - 0.00014 * Math.cos(2 * g);
    return { altitudeRad, azimuthRad, elevationDeg, azimuthDeg, distanceAU, julianDay: jd };
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
