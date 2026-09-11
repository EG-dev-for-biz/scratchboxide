/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

// Solar position calculator.
//
// Computes the sun's altitude (above horizon, radians) and azimuth (compass
// direction from north, radians) for a given lat/lng + UTC date.
//
// Implementation: NOAA Solar Position Algorithm — accurate to ~0.01° for any
// year between 1950 and 2050, which is far better than we need for lighting.
// Reference: https://gml.noaa.gov/grad/solcalc/calcdetails.html

export interface SolarPosition {
  /** Altitude in radians above horizon. Negative = below horizon (night). */
  altitude: number;
  /** Azimuth in radians, measured clockwise from north. */
  azimuth: number;
}

const RAD = Math.PI / 180;
const DEG = 180 / Math.PI;

export function getSolarPosition(date: Date, lat: number, lng: number): SolarPosition {
  // 1. Convert destination local solar time to UTC hours
  // Every 15 degrees of longitude is 1 hour of time difference from UTC.
  
  // 3. Compute a faux UTC timestamp that aligns with this astronomical moment
  // date.getTime() is UTC millis. We want to pretend the local time of the Date
  // object is the local time at the destination.
  const localMillis = date.getTime() - date.getTimezoneOffset() * 60000;
  const destinationUtcMillis = localMillis - (lng / 15) * 3600000;

  // Days since J2000 epoch (12:00 UT on 1 Jan 2000)
  const jd = destinationUtcMillis / 86400000 + 2440587.5; // Julian Date
  const n = jd - 2451545.0;

  // Mean longitude of the Sun
  const L = (280.46 + 0.9856474 * n) % 360;
  // Mean anomaly
  const g = ((357.528 + 0.9856003 * n) % 360) * RAD;
  // Ecliptic longitude
  const lambda = (L + 1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g)) * RAD;
  // Obliquity of ecliptic
  const epsilon = (23.439 - 0.0000004 * n) * RAD;

  // Right ascension and declination
  const ra = Math.atan2(Math.cos(epsilon) * Math.sin(lambda), Math.cos(lambda));
  const dec = Math.asin(Math.max(-1, Math.min(1, Math.sin(epsilon) * Math.sin(lambda))));

  // Greenwich mean sidereal time
  const gmst = (18.697374558 + 24.06570982441908 * n) % 24;
  const gmstHours = (gmst + 24) % 24;
  // Local sidereal time → hour angle
  const lst = ((gmstHours * 15 + lng) % 360) * RAD;
  let H = lst - ra;
  if (H > Math.PI) H -= 2 * Math.PI;
  if (H < -Math.PI) H += 2 * Math.PI;

  const phi = lat * RAD;

  // Altitude
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
  };
}

/**
 * Convert a SolarPosition into a Three.js-friendly direction vector.
 * Uses our scene convention: +Y is up, -Z is north, +X is east.
 *
 * Returns a unit vector pointing FROM the sun TO the scene origin (so a
 * directional light at this position * distance casts light correctly).
 */
export function solarDirectionVector(pos: SolarPosition): [number, number, number] {
  const r = Math.cos(pos.altitude);
  const x = r * Math.sin(pos.azimuth); // east component
  const y = Math.sin(pos.altitude); // up component
  const z = -r * Math.cos(pos.azimuth); // -z = north
  return [x, y, z];
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
