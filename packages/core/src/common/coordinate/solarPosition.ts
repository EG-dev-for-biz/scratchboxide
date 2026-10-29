/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

// Solar position calculator.
//
// Computes the sun's altitude (above horizon, radians) and azimuth (compass
// direction from north, radians) for a given lat/lng at a UTC instant.
//
// Implementation: NOAA Solar Position Algorithm — accurate to ~0.01° for any
// year between 1950 and 2050, which is far better than we need for lighting.
// Reference: https://gml.noaa.gov/grad/solcalc/calcdetails.html

export interface SolarPosition {
  /** Altitude in radians above horizon. Negative = below horizon (night). */
  altitude: number;
  /** Azimuth in radians, measured clockwise from north. */
  azimuth: number;
  /** Altitude in degrees above horizon. */
  altitudeDegrees?: number;
  /** Azimuth in degrees from north. */
  azimuthDegrees?: number;
}

const RAD = Math.PI / 180;
const DEG = 180 / Math.PI;

export interface SolarEphemeris {
  /** Geometric altitude in radians above the horizon (no refraction). */
  altitude: number;
  /** Azimuth in radians, clockwise from north, in [0, 2π). */
  azimuth: number;
  /** Julian Date (UT) of the instant. */
  julianDay: number;
  /** Sun's mean anomaly in radians (for the Earth–Sun distance). */
  meanAnomalyRad: number;
}

/**
 * Sun position at the instant `date` names (its UTC time; the host time zone plays no part), seen from lat/lng.
 */
export function computeSolarEphemeris(date: Date, lat: number, lng: number): SolarEphemeris {
  // Julian Date (UT) straight from the instant: 1970-01-01T00:00Z is JD 2440587.5.
  const jd = date.getTime() / 86400000 + 2440587.5;
  const n = jd - 2451545.0; // days since J2000.0

  // Mean longitude and mean anomaly of the Sun
  const L = (280.46 + 0.9856474 * n) % 360;
  const g = ((357.528 + 0.9856003 * n) % 360) * RAD;
  // Ecliptic longitude and obliquity of the ecliptic
  const lambda = (L + 1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g)) * RAD;
  const epsilon = (23.439 - 0.0000004 * n) * RAD;

  // Right ascension and declination
  const ra = Math.atan2(Math.cos(epsilon) * Math.sin(lambda), Math.cos(lambda));
  const dec = Math.asin(Math.max(-1, Math.min(1, Math.sin(epsilon) * Math.sin(lambda))));

  // Greenwich mean sidereal time (hours) at this UT, then local sidereal time east of Greenwich
  const gmstHours = (((18.697374558 + 24.06570982441908 * n) % 24) + 24) % 24;
  const lst = (gmstHours * 15 + lng) * RAD;
  let H = (lst - ra) % (2 * Math.PI);
  if (H > Math.PI) H -= 2 * Math.PI;
  if (H < -Math.PI) H += 2 * Math.PI;

  const phi = lat * RAD;
  const altitude = Math.asin(
    Math.max(-1, Math.min(1, Math.sin(phi) * Math.sin(dec) + Math.cos(phi) * Math.cos(dec) * Math.cos(H)))
  );
  // Azimuth (clockwise from north)
  const azimuth = Math.atan2(
    -Math.sin(H),
    Math.tan(dec) * Math.cos(phi) - Math.sin(phi) * Math.cos(H)
  );

  return {
    altitude,
    azimuth: (azimuth + 2 * Math.PI) % (2 * Math.PI),
    julianDay: jd,
    meanAnomalyRad: g,
  };
}

/**
 * The instant at which local mean solar time at longitude `lng` reads `solarHours` on the given UTC calendar day
 * (month0 is 0-based, as in Date.UTC). For time-of-day sliders and solar searches that mean "hour at the destination".
 */
export function instantAtLocalMeanSolarTime(year: number, month0: number, day: number, solarHours: number, lng: number): Date {
  return new Date(Date.UTC(year, month0, day) + (solarHours - lng / 15) * 3600000);
}

/** Local mean solar time (hours in [0, 24)) at longitude `lng` at the instant `date`. */
export function localMeanSolarHours(date: Date, lng: number): number {
  const utcHours = (date.getTime() / 3600000) % 24;
  return (((utcHours + lng / 15) % 24) + 24) % 24;
}

/**
 * Sun altitude/azimuth at the instant `date` names. A caller with a destination wall-clock time must build the
 * instant in the destination's time zone (e.g. an ISO string with its offset); the host time zone is never used.
 */
export function getSolarPosition(date: Date, lat: number, lng: number): SolarPosition {
  const { altitude, azimuth } = computeSolarEphemeris(date, lat, lng);
  return { altitude, azimuth };
}

/**
 * Convert a SolarPosition into a Three.js-friendly direction vector.
 * Uses our scene convention: +Y is up, -Z is north, +X is east.
 *
 * Returns a unit vector pointing FROM the sun TO the scene origin (so a
 * directional light at this position * distance casts light correctly).
 */
export function solarDirectionVector(pos: SolarPosition): [number, number, number] {
  return sunDirectionFromRadians(pos.altitude, pos.azimuth);
}

/**
 * The one sun direction of the app (unit vector toward the sun, scene convention +X east, +Y up, -Z north) from its
 * elevation above the horizon and its azimuth clockwise from north, in radians. Every sun direction is computed here:
 * the viewport's (solar-position.ts), the sky photometry's and the photo match's.
 */
export function sunDirectionFromRadians(elevationRad: number, azimuthRad: number): [number, number, number] {
  const r = Math.cos(elevationRad);
  return [r * Math.sin(azimuthRad), Math.sin(elevationRad), -r * Math.cos(azimuthRad)];
}

/** sunDirectionFromRadians in degrees. */
export function sunDirectionFromAngles(elevationDeg: number, azimuthDeg: number): [number, number, number] {
  return sunDirectionFromRadians((elevationDeg * Math.PI) / 180, (azimuthDeg * Math.PI) / 180);
}

/**
 * Convenience: format a small human-readable label for the current sun.
 * E.g. "Sun: 32° above, SW" or "Below horizon (night)".
 */
export function formatSolarPosition(pos: SolarPosition): string {
  if (pos.altitude < 0) {
    const deg = Math.round(pos.altitude * DEG);
    return `Below horizon (${deg}°)`;
  }
  const altDeg = Math.round(pos.altitude * DEG);
  const azDeg = pos.azimuth * DEG;
  const compass = compassFromAzimuth(azDeg);
  return `${altDeg}° altitude, ${compass}`;
}

function compassFromAzimuth(azDeg: number): string {
  const dirs = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
  const idx = Math.round(((azDeg % 360) + 360) / 45) % 8;
  return dirs[idx]!;
}

/**
 * Returns true if the sun is up at the given moment.
 */
export function isDaytime(date: Date, lat: number, lng: number): boolean {
  return getSolarPosition(date, lat, lng).altitude > 0;
}
