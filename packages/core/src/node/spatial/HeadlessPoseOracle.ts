/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { LocalTangentPlane, LatLngAlt, Vec3 } from '../../common/coordinate/LocalTangentPlane';
import { getSolarPosition, solarDirectionVector, SolarPosition } from '../../common/coordinate/solarPosition';

export interface HeadlessCamera {
  id: string;
  role: 'orbital' | 'street_level' | 'aerial_oblique' | 'cinematic_drone' | 'facade';
  positionLocal: Vec3;
  geodeticPose: LatLngAlt & { heading: number; pitch: number; roll: number };
  intrinsics: {
    fx: number;
    fy: number;
    cx: number;
    cy: number;
    width: number;
    height: number;
    fov: number;
  };
  extrinsics: number[]; // 16-element row-major 4x4 matrix
}

export interface CaptureRigConfig {
  preset: 'orbit' | 'hero_arc' | 'street_dolly' | 'cinematic_drone';
  viewCount: number;
  radiusM: number;
  heightM: number;
  lookAtHeightM: number;
  startHeadingDeg: number;
  arcDeg?: number;
  fovDeg: number;
  width: number;
  height: number;
}

export class HeadlessPoseOracle {
  /**
   * Generates a calibrated multi-view camera rig around a geodetic anchor.
   */
  public static generateRig(
    origin: LatLngAlt,
    config: CaptureRigConfig,
    date: Date = new Date()
  ): { views: HeadlessCamera[]; solar: SolarPosition; sunVector: Vec3 } {
    const ltp = new LocalTangentPlane(origin);
    const centerLtp = ltp.toLocal(origin);
    const views: HeadlessCamera[] = [];

    const fovRad = (config.fovDeg * Math.PI) / 180.0;
    const fy = config.height / (2 * Math.tan(fovRad / 2));
    const fx = fy;
    const cx = config.width / 2;
    const cy = config.height / 2;

    const startHeadingRad = (config.startHeadingDeg * Math.PI) / 180.0;
    const sweepRad = ((config.arcDeg ?? 360) * Math.PI) / 180.0;

    for (let i = 0; i < config.viewCount; i++) {
      const fraction = config.viewCount > 1 ? i / (config.viewCount - 1) : 0;
      const currentAngle = startHeadingRad + (config.preset === 'orbit' ? (i / config.viewCount) * 2 * Math.PI : fraction * sweepRad);

      let localPos: Vec3 = [0, 0, 0];
      let role: HeadlessCamera['role'] = 'orbital';

      if (config.preset === 'street_dolly') {
        // Linear movement along a path
        role = 'street_level';
        const offsetDist = (fraction - 0.5) * config.radiusM;
        localPos = [
          centerLtp[0] + offsetDist * Math.cos(startHeadingRad),
          centerLtp[1] + config.heightM,
          centerLtp[2] - offsetDist * Math.sin(startHeadingRad) // ENU Y up, -Z North
        ];
      } else if (config.preset === 'cinematic_drone') {
        role = 'cinematic_drone';
        // Spiral ascent trajectory
        const spiralRadius = config.radiusM * (1.0 - fraction * 0.4);
        const spiralHeight = config.heightM + fraction * 30.0;
        localPos = [
          centerLtp[0] + spiralRadius * Math.cos(currentAngle),
          centerLtp[1] + spiralHeight,
          centerLtp[2] + spiralRadius * Math.sin(currentAngle)
        ];
      } else {
        // Orbit and Hero Arc
        role = config.heightM > 25.0 ? 'aerial_oblique' : 'orbital';
        localPos = [
          centerLtp[0] + config.radiusM * Math.cos(currentAngle),
          centerLtp[1] + config.heightM,
          centerLtp[2] + config.radiusM * Math.sin(currentAngle)
        ];
      }

      // Compute look-at targets
      const targetLtp: Vec3 = [centerLtp[0], centerLtp[1] + config.lookAtHeightM, centerLtp[2]];
      const extrinsics = this.computeLookAtMatrix(localPos, targetLtp, [0, 1, 0]);

      // Unproject local coordinates back to geodetic WGS84 for the camera's real geodetic coordinates
      const camGeo = ltp.toLatLng(localPos);

      // Calculate camera heading, pitch and roll from the orientation axes
      const heading = (currentAngle * 180.0) / Math.PI;
      const pitch = -Math.atan2(config.heightM - config.lookAtHeightM, config.radiusM) * (180.0 / Math.PI);

      views.push({
        id: `view-${config.preset}-${i}`,
        role,
        positionLocal: localPos,
        geodeticPose: {
          lat: camGeo.lat,
          lng: camGeo.lng,
          alt: camGeo.alt,
          heading,
          pitch,
          roll: 0
        },
        intrinsics: {
          fx,
          fy,
          cx,
          cy,
          width: config.width,
          height: config.height,
          fov: config.fovDeg
        },
        extrinsics
      });
    }

    const solar = getSolarPosition(date, origin.lat, origin.lng);
    const sunVector = solarDirectionVector(solar);

    return { views, solar, sunVector };
  }

  /**
   * Computes a standard 4x4 camera-to-world (extrinsics) matrix.
   * Standard camera conventions: X = Right, Y = Up, Z = -Forward (Pointing OUT of the scene)
   */
  private static computeLookAtMatrix(eye: Vec3, target: Vec3, up: Vec3): number[] {
    const zAxis = [eye[0] - target[0], eye[1] - target[1], eye[2] - target[2]];
    const lenZ = Math.hypot(...zAxis);
    const zNorm = zAxis.map(v => v / (lenZ || 1));

    // xAxis = up x zNorm
    const xAxis = [
      up[1] * zNorm[2] - up[2] * zNorm[1],
      up[2] * zNorm[0] - up[0] * zNorm[2],
      up[0] * zNorm[1] - up[1] * zNorm[0]
    ];
    const lenX = Math.hypot(...xAxis);
    const xNorm = xAxis.map(v => v / (lenX || 1));

    // yAxis = zNorm x xNorm
    const yNorm = [
      zNorm[1] * xNorm[2] - zNorm[2] * xNorm[1],
      zNorm[2] * xNorm[0] - zNorm[0] * xNorm[2],
      zNorm[0] * xNorm[1] - zNorm[1] * xNorm[0]
    ];

    return [
      xNorm[0], yNorm[0], zNorm[0], eye[0],
      xNorm[1], yNorm[1], zNorm[1], eye[1],
      xNorm[2], yNorm[2], zNorm[2], eye[2],
      0, 0, 0, 1
    ];
  }
}
