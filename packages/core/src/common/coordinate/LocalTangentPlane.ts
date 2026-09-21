/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

export interface LatLngAlt {
  lat: number;
  lng: number;
  alt?: number;
}

export type Vec3 = [number, number, number];

// WGS-84 Ellipsoid constants
const WGS84_A = 6378137.0; // semi-major axis (meters)
const WGS84_F = 1.0 / 298.257223563; // flattening
const WGS84_B = WGS84_A * (1.0 - WGS84_F); // semi-minor axis (meters)
const WGS84_E2 = (WGS84_A * WGS84_A - WGS84_B * WGS84_B) / (WGS84_A * WGS84_A); // eccentricity squared
const WGS84_E_PRIME2 = (WGS84_A * WGS84_A - WGS84_B * WGS84_B) / (WGS84_B * WGS84_B); // second eccentricity squared

/**
 * High-precision WGS-84 Coordinate system converter.
 * Converts Geodetic (Lat, Lng, Alt in MSL) <-> ECEF <-> local ENU tangent plane.
 * Prevents WebGL single-precision vertex jitter and resolves coordinate drift.
 */
export class LocalTangentPlane {
  private originEcef: Vec3;
  private rotMatrix: [Vec3, Vec3, Vec3]; // Strongly typed 3x3 rotation matrix
  private invRotMatrix: [Vec3, Vec3, Vec3]; // Strongly typed 3x3 inverse rotation matrix

  constructor(
    public readonly origin: LatLngAlt,
    public readonly geoidHeight: number = 0
  ) {
    const latRad = origin.lat * (Math.PI / 180);
    const lngRad = origin.lng * (Math.PI / 180);
    const altEllipsoid = (origin.alt ?? 0) + geoidHeight;

    // 1. Calculate origin in ECEF
    this.originEcef = this.geodeticToEcef(latRad, lngRad, altEllipsoid);

    // 2. Set up rotation matrix (ECEF -> ENU)
    const cosLat = Math.cos(latRad);
    const sinLat = Math.sin(latRad);
    const cosLng = Math.cos(lngRad);
    const sinLng = Math.sin(lngRad);

    this.rotMatrix = [
      [-sinLng, cosLng, 0],
      [-sinLat * cosLng, -sinLat * sinLng, cosLat],
      [cosLat * cosLng, cosLat * sinLng, sinLat]
    ];

    // Transpose of rotation matrix is its inverse (since it is orthogonal)
    this.invRotMatrix = [
      [this.rotMatrix[0][0], this.rotMatrix[1][0], this.rotMatrix[2][0]],
      [this.rotMatrix[0][1], this.rotMatrix[1][1], this.rotMatrix[2][1]],
      [this.rotMatrix[0][2], this.rotMatrix[1][2], this.rotMatrix[2][2]]
    ];
  }

  /**
   * Converts Geodetic (Lat, Lng, Alt in MSL) to local Three.js coordinate system.
   * Three.js coordinate convention:
   *   Three.js X = ENU East
   *   Three.js Y = ENU Up
   *   Three.js Z = -ENU North
   */
  toLocal(p: LatLngAlt): Vec3 {
    const latRad = p.lat * (Math.PI / 180);
    const lngRad = p.lng * (Math.PI / 180);
    const altEllipsoid = (p.alt ?? 0) + this.geoidHeight;

    const ecef = this.geodeticToEcef(latRad, lngRad, altEllipsoid);
    const dx = ecef[0] - this.originEcef[0];
    const dy = ecef[1] - this.originEcef[1];
    const dz = ecef[2] - this.originEcef[2];

    const east = this.rotMatrix[0][0] * dx + this.rotMatrix[0][1] * dy + this.rotMatrix[0][2] * dz;
    const north = this.rotMatrix[1][0] * dx + this.rotMatrix[1][1] * dy + this.rotMatrix[1][2] * dz;
    const up = this.rotMatrix[2][0] * dx + this.rotMatrix[2][1] * dy + this.rotMatrix[2][2] * dz;

    return [east, up, -north];
  }

  /**
   * Converts Geodetic (Lat, Lng, Alt in MSL) to standard East-North-Up (ENU) coordinates in meters.
   */
  geodeticToEnu(p: LatLngAlt): Vec3 {
    const local = this.toLocal(p);
    return [local[0], -local[2], local[1]]; // [east, north, up]
  }

  /**
   * Converts local ENU (East, North, Up) coordinates in meters to Geodetic.
   */
  enuToGeodetic(enu: Vec3): LatLngAlt {
    return this.toLatLng([enu[0], enu[2], -enu[1]]);
  }

  /**
   * Converts local Three.js coordinates to Geodetic (Lat, Lng, Alt in MSL).
   */
  toLatLng(local: Vec3): LatLngAlt {
    const east = local[0];
    const up = local[1];
    const north = -local[2];

    // Transform from ENU to ECEF difference
    const dx = this.invRotMatrix[0][0] * east + this.invRotMatrix[0][1] * north + this.invRotMatrix[0][2] * up;
    const dy = this.invRotMatrix[1][0] * east + this.invRotMatrix[1][1] * north + this.invRotMatrix[1][2] * up;
    const dz = this.invRotMatrix[2][0] * east + this.invRotMatrix[2][1] * north + this.invRotMatrix[2][2] * up;

    const ecefX = this.originEcef[0] + dx;
    const ecefY = this.originEcef[1] + dy;
    const ecefZ = this.originEcef[2] + dz;

    const geodetic = this.ecefToGeodetic(ecefX, ecefY, ecefZ);

    return {
      lat: geodetic.lat * (180 / Math.PI),
      lng: geodetic.lng * (180 / Math.PI),
      alt: geodetic.alt - this.geoidHeight
    };
  }

  /**
   * Raw conversion: Geodetic (radians) to ECEF Cartesian coordinates (meters).
   */
  private geodeticToEcef(lat: number, lng: number, alt: number): Vec3 {
    const sinLat = Math.sin(lat);
    const cosLat = Math.cos(lat);
    const sinLng = Math.sin(lng);
    const cosLng = Math.cos(lng);

    const n = WGS84_A / Math.sqrt(1.0 - WGS84_E2 * sinLat * sinLat);

    const x = (n + alt) * cosLat * cosLng;
    const y = (n + alt) * cosLat * sinLng;
    const z = ((1.0 - WGS84_E2) * n + alt) * sinLat;

    return [x, y, z];
  }

  /**
   * Bowring (1985) Closed-form formulation for ECEF Cartesian to Geodetic (radians, meters).
   * Millimetric precision, non-iterative.
   */
  private ecefToGeodetic(x: number, y: number, z: number): { lat: number; lng: number; alt: number } {
    const p = Math.hypot(x, y);
    if (p < 1e-6) {
      // Handle polar case
      const lat = z >= 0 ? Math.PI / 2 : -Math.PI / 2;
      const alt = Math.abs(z) - WGS84_B;
      return { lat, lng: 0, alt };
    }

    const theta = Math.atan2(z * WGS84_A, p * WGS84_B);
    const sinTheta = Math.sin(theta);
    const cosTheta = Math.cos(theta);

    const lat = Math.atan2(
      z + WGS84_E_PRIME2 * WGS84_B * sinTheta * sinTheta * sinTheta,
      p - WGS84_E2 * WGS84_A * cosTheta * cosTheta * cosTheta
    );

    const lng = Math.atan2(y, x);

    const sinLat = Math.sin(lat);
    const cosLat = Math.cos(lat);
    const n = WGS84_A / Math.sqrt(1.0 - WGS84_E2 * sinLat * sinLat);

    // Height above ellipsoid
    const alt = p * cosLat + z * sinLat - (WGS84_A * WGS84_A) / n;

    return { lat, lng, alt };
  }

  /**
   * Static helper: converts Geodetic target point to ENU relative to an origin anchor.
   */
  static geodeticToEnu(origin: LatLngAlt, target: LatLngAlt): { x: number; y: number; z: number } {
    const ltp = new LocalTangentPlane(origin);
    const enu = ltp.geodeticToEnu(target);
    return { x: enu[0], y: enu[1], z: enu[2] };
  }

  /**
   * Static helper: converts local ENU coordinates in meters to Geodetic relative to an origin anchor.
   */
  static enuToGeodetic(origin: LatLngAlt, east: number, north: number, up: number): LatLngAlt {
    const ltp = new LocalTangentPlane(origin);
    return ltp.enuToGeodetic([east, north, up]);
  }

  /**
   * Google Maps Ground Surface & Elevation Standard Invariant:
   * Across Google Maps Platform, Google Earth, and Scratchbox IDE:
   * - origin.alt represents the real-world ground surface (street level / terrain) in meters above Mean Sea Level (EGM96 geoid).
   * - In local ENU / Three.js metric space (+X East, +Y Up, -Z North), Y = 0.0m is strictly Ground Level.
   * - Y > 0.0m represents Above Ground Level (AGL) (human eye height = 1.7m, drone survey stations, building height).
   * - Y < 0.0m represents Sub-Surface (basements, foundations, tunnels).
   */
  public static readonly GROUND_SURFACE_LOCAL_Y = 0.0;

  /**
   * Returns the local Y coordinate of the canonical ground surface (0.0m).
   */
  public static groundLevel(): number {
    return LocalTangentPlane.GROUND_SURFACE_LOCAL_Y;
  }

  /**
   * Returns the ground surface elevation above Mean Sea Level in meters.
   */
  public getGroundElevationMsl(): number {
    return this.origin.alt ?? 0.0;
  }
}
