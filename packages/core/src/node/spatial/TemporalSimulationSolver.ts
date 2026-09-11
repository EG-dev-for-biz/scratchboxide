/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { LocalTangentPlane, LatLngAlt, Vec3 } from '../../common/coordinate/LocalTangentPlane';
import { Entity4D, TelemetryLog } from '../../common/geospatial-4d-protocol';

export class TemporalSimulationSolver {
  /**
   * Evaluates the Catmull-Rom spline at interpolation parameter t (0.0 to 1.0)
   * given four 3D control points.
   */
  public static evaluateCatmullRom(
    p0: Vec3,
    p1: Vec3,
    p2: Vec3,
    p3: Vec3,
    t: number
  ): Vec3 {
    const t2 = t * t;
    const t3 = t2 * t;

    // Catmull-Rom coefficients
    const f0 = -0.5 * t3 + t2 - 0.5 * t;
    const f1 = 1.5 * t3 - 2.5 * t2 + 1.0;
    const f2 = -1.5 * t3 + 2.0 * t2 + 0.5 * t;
    const f3 = 0.5 * t3 - 0.5 * t2;

    return [
      p0[0] * f0 + p1[0] * f1 + p2[0] * f2 + p3[0] * f3,
      p0[1] * f0 + p1[1] * f1 + p2[1] * f2 + p3[1] * f3,
      p0[2] * f0 + p1[2] * f1 + p2[2] * f2 + p3[2] * f3
    ];
  }

  /**
   * Simulates the 4D timeline trajectory of a dynamic entity (like a drone or vehicle).
   * Calculates precise spatial transforms, velocity, and appends telemetry logs over time steps.
   */
  public static simulateSplineTrack(
    entity: Entity4D,
    origin: LatLngAlt,
    splinePoints: Vec3[],
    timeStepMs: number = 250
  ): Entity4D {
    const ltp = new LocalTangentPlane(origin);
    const simulatedEntity = { ...entity };
    const telemetry: TelemetryLog[] = [];

    const durationMs = entity.time.durationMs || 5000;
    const steps = Math.floor(durationMs / timeStepMs);

    // Guardrail: need at least 4 points for Catmull-Rom spline simulation
    if (splinePoints.length < 4) {
      return simulatedEntity;
    }

    let prevPosLocal: Vec3 = splinePoints[1];

    for (let s = 0; s <= steps; s++) {
      const timeMs = s * timeStepMs;
      const progress = timeMs / durationMs; // 0.0 to 1.0
      
      // Calculate active spline segment index
      const numSegments = splinePoints.length - 3;
      const val = progress * numSegments;
      const segmentIndex = Math.min(numSegments - 1, Math.floor(val));
      const segmentT = val - segmentIndex;

      // Select control points
      const p0 = splinePoints[segmentIndex];
      const p1 = splinePoints[segmentIndex + 1];
      const p2 = splinePoints[segmentIndex + 2];
      const p3 = splinePoints[segmentIndex + 3];

      // Interpolate local Cartesian position
      const localPos = this.evaluateCatmullRom(p0, p1, p2, p3, segmentT);

      // Snap-to-ground / clearance check
      // Procedural terrain: if coordinate dips below floor, elevate to terrain height + 3m clearance
      const terrainHeight = -1.5 + Math.sin(localPos[0] * 0.1) * 0.4;
      if (localPos[1] < terrainHeight) {
        localPos[1] = terrainHeight + 3.0; // 3m safety clearance
      }

      // Reverse projection back to geodetic WGS-84
      const geoPos = ltp.toLatLng(localPos);

      // Compute velocity & speed
      const dx = localPos[0] - prevPosLocal[0];
      const dy = localPos[1] - prevPosLocal[1];
      const dz = localPos[2] - prevPosLocal[2];
      const distanceMeters = Math.hypot(dx, dy, dz);

      const speedMps = distanceMeters / (timeStepMs / 1000.0);
      const speedKmh = Math.min(120, speedMps * 3.6); // cap at 120kmh for vehicles/drones

      const heading = (Math.atan2(dx, -dz) * 180.0) / Math.PI;

      telemetry.push({
        timestampMs: timeMs,
        gps: {
          lat: geoPos.lat,
          lng: geoPos.lng,
          alt: geoPos.alt,
          heading: (heading + 360) % 360
        },
        speedKmh: s === 0 ? 0 : parseFloat(speedKmh.toFixed(1)),
        status: s === 0 ? 'STARTING' : s === steps ? 'COMPLETED' : 'FLYING'
      });

      // Update current state if at playhead start
      if (s === 0) {
        simulatedEntity.space.localTransform = {
          position: localPos,
          rotationQuaternion: [0, 0, 0, 1],
          scale: [1, 1, 1]
        };
        simulatedEntity.space.geoAnchor = {
          lat: geoPos.lat,
          lng: geoPos.lng,
          alt: geoPos.alt,
          heading: (heading + 360) % 360
        };
      }

      prevPosLocal = localPos;
    }

    simulatedEntity.behavior.telemetryStream = telemetry;
    return simulatedEntity;
  }
}
