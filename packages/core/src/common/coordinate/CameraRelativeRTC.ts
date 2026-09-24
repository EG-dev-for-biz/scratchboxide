/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import type { SpatialGeodeticAnchor } from '../spatial/spatial-generative-protocol';

// WGS-84 Reference Ellipsoid Constants
export const WGS84_SEMI_MAJOR_AXIS_A = 6378137.0; // meters (a)
export const WGS84_FLATTENING_F = 1.0 / 298.257223563; // (f)
export const WGS84_SEMI_MINOR_AXIS_B = WGS84_SEMI_MAJOR_AXIS_A * (1.0 - WGS84_FLATTENING_F); // meters (b)
export const WGS84_ECCENTRICITY_SQ_E2 =
  (WGS84_SEMI_MAJOR_AXIS_A * WGS84_SEMI_MAJOR_AXIS_A - WGS84_SEMI_MINOR_AXIS_B * WGS84_SEMI_MINOR_AXIS_B) /
  (WGS84_SEMI_MAJOR_AXIS_A * WGS84_SEMI_MAJOR_AXIS_A); // (e^2)
export const WGS84_SECOND_ECCENTRICITY_SQ_EP2 =
  (WGS84_SEMI_MAJOR_AXIS_A * WGS84_SEMI_MAJOR_AXIS_A - WGS84_SEMI_MINOR_AXIS_B * WGS84_SEMI_MINOR_AXIS_B) /
  (WGS84_SEMI_MINOR_AXIS_B * WGS84_SEMI_MINOR_AXIS_B); // (e'^2)

const DEG2RAD = Math.PI / 180.0;
const RAD2DEG = 180.0 / Math.PI;

export interface HighLowFloat32Vec3 {
  high: [number, number, number];
  low: [number, number, number];
}

/**
 * High-precision coordinate transformation engine providing camera-relative
 * Relative-To-Center (RTC) rendering for global planetary to street-level 3D scenes.
 *
 * Solves the 32-bit floating-point precision limit (jitter) by computing double-precision
 * Cartesian transforms on the CPU and uploading camera-relative offsets or split float32
 * high/low pairs to the GPU.
 */
export class CameraRelativeRTC {
  private originGeodetic: SpatialGeodeticAnchor;
  private originEcef: Float64Array; // [X, Y, Z] in meters
  private enuRotationMatrix: Float64Array; // 3x3 rotation matrix from ECEF -> ENU
  private invEnuRotationMatrix: Float64Array; // 3x3 rotation matrix from ENU -> ECEF

  /** Current active camera or viewport optical center in geocentric ECEF */
  private cameraEcef: Float64Array;

  constructor(origin?: SpatialGeodeticAnchor) {
    this.originGeodetic = origin ? { ...origin } : { latitude: 0, longitude: 0, altitudeMsl: 0 };
    this.originEcef = new Float64Array(3);
    this.cameraEcef = new Float64Array(3);
    this.enuRotationMatrix = new Float64Array(9);
    this.invEnuRotationMatrix = new Float64Array(9);

    this.recomputeOriginTransforms();
  }

  /**
   * Updates the world geodetic origin anchor.
   */
  public setOrigin(anchor: SpatialGeodeticAnchor): void {
    this.originGeodetic = { ...anchor };
    this.recomputeOriginTransforms();
  }

  public getOrigin(): SpatialGeodeticAnchor {
    return { ...this.originGeodetic };
  }

  /**
   * Sets the active camera position in geodetic coordinates.
   */
  public setCameraPositionGeodetic(anchor: SpatialGeodeticAnchor): void {
    const ecef = CameraRelativeRTC.geodeticToEcef(anchor.latitude, anchor.longitude, anchor.altitudeMsl);
    this.cameraEcef[0] = ecef[0];
    this.cameraEcef[1] = ecef[1];
    this.cameraEcef[2] = ecef[2];
  }

  /**
   * Sets the active camera position in ECEF coordinates.
   */
  public setCameraPositionEcef(x: number, y: number, z: number): void {
    this.cameraEcef[0] = x;
    this.cameraEcef[1] = y;
    this.cameraEcef[2] = z;
  }

  /**
   * Converts a target geodetic point into Three.js local camera-relative coordinates:
   * +X = East, +Y = Up (gravity aligned), -Z = North (True North aligned).
   *
   * @param target Latitude, Longitude, and Altitude
   * @returns [x, y, z] metric coordinates in Three.js camera-relative space
   */
  public geodeticToCameraRelativeThree(target: SpatialGeodeticAnchor): [number, number, number] {
    const ecef = CameraRelativeRTC.geodeticToEcef(target.latitude, target.longitude, target.altitudeMsl);
    return this.ecefToCameraRelativeThree(ecef[0], ecef[1], ecef[2]);
  }

  /**
   * Converts an ECEF coordinate into Three.js camera-relative coordinates.
   */
  public ecefToCameraRelativeThree(x: number, y: number, z: number): [number, number, number] {
    // Delta relative to camera in ECEF
    const dx = x - this.cameraEcef[0];
    const dy = y - this.cameraEcef[1];
    const dz = z - this.cameraEcef[2];

    // Multiply by ENU rotation matrix (centered at originGeodetic)
    const east = this.enuRotationMatrix[0] * dx + this.enuRotationMatrix[1] * dy + this.enuRotationMatrix[2] * dz;
    const north = this.enuRotationMatrix[3] * dx + this.enuRotationMatrix[4] * dy + this.enuRotationMatrix[5] * dz;
    const up = this.enuRotationMatrix[6] * dx + this.enuRotationMatrix[7] * dy + this.enuRotationMatrix[8] * dz;

    // Three.js convention: +X = East, +Y = Up, -Z = North
    return [east, up, -north];
  }

  /**
   * Converts a Three.js local camera-relative coordinate back into geodetic coordinates.
   */
  public cameraRelativeThreeToGeodetic(x: number, y: number, z: number): SpatialGeodeticAnchor {
    // Three.js (+X = East, +Y = Up, -Z = North) -> ENU
    const east = x;
    const north = -z;
    const up = y;

    // Multiply by inverse ENU rotation matrix
    const dx = this.invEnuRotationMatrix[0] * east + this.invEnuRotationMatrix[1] * north + this.invEnuRotationMatrix[2] * up;
    const dy = this.invEnuRotationMatrix[3] * east + this.invEnuRotationMatrix[4] * north + this.invEnuRotationMatrix[5] * up;
    const dz = this.invEnuRotationMatrix[6] * east + this.invEnuRotationMatrix[7] * north + this.invEnuRotationMatrix[8] * up;

    const ecefX = this.cameraEcef[0] + dx;
    const ecefY = this.cameraEcef[1] + dy;
    const ecefZ = this.cameraEcef[2] + dz;

    return CameraRelativeRTC.ecefToGeodetic(ecefX, ecefY, ecefZ);
  }

  /**
   * Converts a geodetic point into standard Local Tangent Plane ENU coordinates
   * relative to the origin anchor.
   */
  public geodeticToLocalEnu(target: SpatialGeodeticAnchor): [number, number, number] {
    const ecef = CameraRelativeRTC.geodeticToEcef(target.latitude, target.longitude, target.altitudeMsl);
    const dx = ecef[0] - this.originEcef[0];
    const dy = ecef[1] - this.originEcef[1];
    const dz = ecef[2] - this.originEcef[2];

    const east = this.enuRotationMatrix[0] * dx + this.enuRotationMatrix[1] * dy + this.enuRotationMatrix[2] * dz;
    const north = this.enuRotationMatrix[3] * dx + this.enuRotationMatrix[4] * dy + this.enuRotationMatrix[5] * dz;
    const up = this.enuRotationMatrix[6] * dx + this.enuRotationMatrix[7] * dy + this.enuRotationMatrix[8] * dz;

    return [east, north, up];
  }

  /**
   * Splits a 64-bit coordinate into high and low 32-bit floats for GPU vertex shaders.
   * This technique (emulated double precision on float32 GPUs) provides 14 digits of precision.
   */
  public static splitFloat32(value: number): [number, number] {
    const high = Math.fround(value);
    const low = Math.fround(value - high);
    return [high, low];
  }

  /**
   * Splits a 3D vector into high and low float32 vectors.
   */
  public static splitVec3Float32(x: number, y: number, z: number): HighLowFloat32Vec3 {
    const [xh, xl] = CameraRelativeRTC.splitFloat32(x);
    const [yh, yl] = CameraRelativeRTC.splitFloat32(y);
    const [zh, zl] = CameraRelativeRTC.splitFloat32(z);
    return {
      high: [xh, yh, zh],
      low: [xl, yl, zl]
    };
  }

  /**
   * Mathematical conversion from WGS-84 Geodetic (lat, lon, alt) to Earth-Centered Earth-Fixed (ECEF).
   */
  public static geodeticToEcef(latDeg: number, lonDeg: number, altMeters: number): [number, number, number] {
    const latRad = latDeg * DEG2RAD;
    const lonRad = lonDeg * DEG2RAD;

    const sinLat = Math.sin(latRad);
    const cosLat = Math.cos(latRad);
    const sinLon = Math.sin(lonRad);
    const cosLon = Math.cos(lonRad);

    // Radius of curvature in the prime vertical
    const n = WGS84_SEMI_MAJOR_AXIS_A / Math.sqrt(1.0 - WGS84_ECCENTRICITY_SQ_E2 * sinLat * sinLat);

    const x = (n + altMeters) * cosLat * cosLon;
    const y = (n + altMeters) * cosLat * sinLon;
    const z = (n * (1.0 - WGS84_ECCENTRICITY_SQ_E2) + altMeters) * sinLat;

    return [x, y, z];
  }

  /**
   * Analytical conversion from geocentric ECEF (X, Y, Z) to WGS-84 Geodetic (lat, lon, alt)
   * using Bowring's closed-form algorithm (accurate to within 0.1 mm globally).
   */
  public static ecefToGeodetic(x: number, y: number, z: number): SpatialGeodeticAnchor {
    const p = Math.sqrt(x * x + y * y);
    if (p < 1e-6) {
      // Polar singular condition
      const lat = z >= 0 ? 90 : -90;
      const alt = Math.abs(z) - WGS84_SEMI_MINOR_AXIS_B;
      return { latitude: lat, longitude: 0, altitudeMsl: alt };
    }

    const theta = Math.atan2(z * WGS84_SEMI_MAJOR_AXIS_A, p * WGS84_SEMI_MINOR_AXIS_B);
    const sinTheta = Math.sin(theta);
    const cosTheta = Math.cos(theta);

    const latRad = Math.atan2(
      z + WGS84_SECOND_ECCENTRICITY_SQ_EP2 * WGS84_SEMI_MINOR_AXIS_B * sinTheta * sinTheta * sinTheta,
      p - WGS84_ECCENTRICITY_SQ_E2 * WGS84_SEMI_MAJOR_AXIS_A * cosTheta * cosTheta * cosTheta
    );
    const lonRad = Math.atan2(y, x);

    const sinLat = Math.sin(latRad);
    const n = WGS84_SEMI_MAJOR_AXIS_A / Math.sqrt(1.0 - WGS84_ECCENTRICITY_SQ_E2 * sinLat * sinLat);
    const altMeters = p / Math.cos(latRad) - n;

    return {
      latitude: latRad * RAD2DEG,
      longitude: lonRad * RAD2DEG,
      altitudeMsl: altMeters
    };
  }

  /**
   * Computes rotation matrix to orient a model given True North heading, pitch, and roll.
   * Heading = clockwise angle from True North (degrees).
   * Pitch = elevation angle looking up/down (degrees).
   * Roll = rotation around forward viewing axis (degrees).
   */
  public static computeOrientationMatrix(
    headingDeg: number = 0,
    pitchDeg: number = 0,
    rollDeg: number = 0
  ): Float32Array {
    // In Three.js: +X = East, +Y = Up, -Z = North
    // Heading is clockwise from North (-Z), meaning positive heading rotates towards East (+X) -> negative rotation around +Y.
    const yawRad = -headingDeg * DEG2RAD;
    const pitchRad = pitchDeg * DEG2RAD;
    const rollRad = rollDeg * DEG2RAD;

    const cy = Math.cos(yawRad);
    const sy = Math.sin(yawRad);
    const cp = Math.cos(pitchRad);
    const sp = Math.sin(pitchRad);
    const cr = Math.cos(rollRad);
    const sr = Math.sin(rollRad);

    // Standard Tait-Bryan Z-X-Y rotation matrix in Three.js camera space
    const out = new Float32Array(16);
    out[0] = cy * cr + sy * sp * sr;
    out[1] = cp * sr;
    out[2] = -sy * cr + cy * sp * sr;
    out[3] = 0;

    out[4] = -cy * sr + sy * sp * cr;
    out[5] = cp * cr;
    out[6] = sy * sr + cy * sp * cr;
    out[7] = 0;

    out[8] = sy * cp;
    out[9] = -sp;
    out[10] = cy * cp;
    out[11] = 0;

    out[12] = 0;
    out[13] = 0;
    out[14] = 0;
    out[15] = 1;

    return out;
  }

  private recomputeOriginTransforms(): void {
    const latRad = this.originGeodetic.latitude * DEG2RAD;
    const lonRad = this.originGeodetic.longitude * DEG2RAD;

    const sinLat = Math.sin(latRad);
    const cosLat = Math.cos(latRad);
    const sinLon = Math.sin(lonRad);
    const cosLon = Math.cos(lonRad);

    // Origin in ECEF
    const ecef = CameraRelativeRTC.geodeticToEcef(
      this.originGeodetic.latitude,
      this.originGeodetic.longitude,
      this.originGeodetic.altitudeMsl
    );
    this.originEcef[0] = ecef[0];
    this.originEcef[1] = ecef[1];
    this.originEcef[2] = ecef[2];

    // Default camera center to origin if not set
    if (this.cameraEcef[0] === 0 && this.cameraEcef[1] === 0 && this.cameraEcef[2] === 0) {
      this.cameraEcef[0] = ecef[0];
      this.cameraEcef[1] = ecef[1];
      this.cameraEcef[2] = ecef[2];
    }

    // 3x3 ENU rotation matrix from ECEF
    // Row 0 (East):  [-sinLon,          cosLon,           0      ]
    // Row 1 (North): [-sinLat*cosLon,  -sinLat*sinLon,    cosLat ]
    // Row 2 (Up):    [ cosLat*cosLon,   cosLat*sinLon,    sinLat ]
    this.enuRotationMatrix[0] = -sinLon;
    this.enuRotationMatrix[1] = cosLon;
    this.enuRotationMatrix[2] = 0;

    this.enuRotationMatrix[3] = -sinLat * cosLon;
    this.enuRotationMatrix[4] = -sinLat * sinLon;
    this.enuRotationMatrix[5] = cosLat;

    this.enuRotationMatrix[6] = cosLat * cosLon;
    this.enuRotationMatrix[7] = cosLat * sinLon;
    this.enuRotationMatrix[8] = sinLat;

    // Transpose is the inverse for an orthogonal rotation matrix
    this.invEnuRotationMatrix[0] = this.enuRotationMatrix[0];
    this.invEnuRotationMatrix[1] = this.enuRotationMatrix[3];
    this.invEnuRotationMatrix[2] = this.enuRotationMatrix[6];

    this.invEnuRotationMatrix[3] = this.enuRotationMatrix[1];
    this.invEnuRotationMatrix[4] = this.enuRotationMatrix[4];
    this.invEnuRotationMatrix[5] = this.enuRotationMatrix[7];

    this.invEnuRotationMatrix[6] = this.enuRotationMatrix[2];
    this.invEnuRotationMatrix[7] = this.enuRotationMatrix[5];
    this.invEnuRotationMatrix[8] = this.enuRotationMatrix[8];
  }

  /**
   * GLSL vertex shader chunk for Split-64 Relative-To-Center (RTC) precision emulation.
   */
  public static getVertexShaderRTCChunk(): string {
    return `
      attribute vec3 instanceCenterHigh;
      attribute vec3 instanceCenterLow;
      uniform vec3 uCameraHigh;
      uniform vec3 uCameraLow;
      uniform float uEnableRTC;

      vec3 evaluateRtcCenter(vec3 fallbackCenter) {
        if (uEnableRTC > 0.5) {
          return (instanceCenterHigh - uCameraHigh) + (instanceCenterLow - uCameraLow);
        }
        return fallbackCenter;
      }
    `;
  }

  /**
   * Splits an array of 3D positions into float32 high and low arrays for GPU upload.
   */
  public static getSplit64Attributes(positions: Float32Array | Float64Array | number[]): {
    high: Float32Array;
    low: Float32Array;
  } {
    const count = Math.floor(positions.length / 3);
    const high = new Float32Array(count * 3);
    const low = new Float32Array(count * 3);

    for (let i = 0; i < count; i++) {
      const idx = i * 3;
      const [xh, xl] = CameraRelativeRTC.splitFloat32(positions[idx]);
      const [yh, yl] = CameraRelativeRTC.splitFloat32(positions[idx + 1]);
      const [zh, zl] = CameraRelativeRTC.splitFloat32(positions[idx + 2]);
      high[idx] = xh;
      high[idx + 1] = yh;
      high[idx + 2] = zh;
      low[idx] = xl;
      low[idx + 1] = yl;
      low[idx + 2] = zl;
    }

    return { high, low };
  }

  /**
   * Splits a single 3D camera coordinate into high and low Float32 components for uniform binding.
   */
  public static splitCameraPosition(x: number, y: number, z: number): {
    high: [number, number, number];
    low: [number, number, number];
  } {
    const v = CameraRelativeRTC.splitVec3Float32(x, y, z);
    return { high: v.high, low: v.low };
  }
}

