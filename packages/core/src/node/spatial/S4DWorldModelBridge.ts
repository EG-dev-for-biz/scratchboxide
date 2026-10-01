/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import { LatLngAlt, LocalTangentPlane, Vec3 } from '../../common/coordinate/LocalTangentPlane';
import {
  Entity4D,
  OccupancyGrid4D
} from '../../common/geospatial-4d-protocol';

/**
 * 6-DOF Trajectory Waypoint for S4D Diffusion Transformer Conditioning.
 */
export interface S4DTrajectoryWaypoint {
  x: number;          // Local East meters
  y: number;          // Local North meters
  z: number;          // Local Up meters
  yawDeg: number;     // Azimuth/heading (0 = North, 90 = East)
  pitchDeg: number;   // Horizon pitch (-90 = Nadir down, +90 = Zenith up)
  rollDeg: number;    // Bank roll (-180 to +180)
  speedKmh: number;   // Forward velocity
  timestampMs: number;// Timestamp in millisecond timeline
}

/**
 * Complete Trajectory Prompt Payload for S4D Model Inference / Training.
 */
export interface S4DTrajectoryPrompt {
  entityId: string;
  originWGS84: LatLngAlt;
  timeStepMs: number;
  totalDurationMs: number;
  waypoints: S4DTrajectoryWaypoint[];
  bounds: {
    min: Vec3;
    max: Vec3;
  };
}

export interface S4DInferenceOptions {
  dimensions?: [number, number, number, number]; // [T, X, Y, Z], default [16, 128, 128, 64]
  voxelSizeMeters?: [number, number, number];    // [1.0, 1.0, 1.0]
  numInferenceSteps?: number;                    // e.g. 20 (Flow Matching / DPM-Solver++)
  guidanceScale?: number;                        // Classifier-Free Guidance (CFG), e.g. 4.5
  seed?: number;
}

export interface S4DInferenceRequest {
  model: 'scratchbox-4d-dit-v1';
  prompt: S4DTrajectoryPrompt;
  options: Required<S4DInferenceOptions>;
}

/**
 * S4DWorldModelBridge
 * Translates between Scratchbox geospatial 4D entities and the S4D 4D Occupancy Diffusion engine.
 */
export class S4DWorldModelBridge {
  public static readonly DEFAULT_DIMENSIONS: [number, number, number, number] = [16, 128, 128, 64];
  public static readonly DEFAULT_VOXEL_SIZE: [number, number, number] = [1.0, 1.0, 1.0];

  /**
   * Serializes an Entity4D's telemetry log stream into a 6-DOF S4D trajectory prompt.
   */
  public static serializeTrajectoryPrompt(
    entity: Entity4D,
    origin: LatLngAlt
  ): S4DTrajectoryPrompt {
    const ltp = new LocalTangentPlane(origin);
    const telemetry = entity.behavior.telemetryStream || [];

    const waypoints: S4DTrajectoryWaypoint[] = [];
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;

    for (let i = 0; i < telemetry.length; ++i) {
      const log = telemetry[i];
      const enu = ltp.geodeticToEnu({
        lat: log.gps.lat,
        lng: log.gps.lng,
        alt: log.gps.alt
      });

      const x = parseFloat(enu[0].toFixed(3));
      const y = parseFloat(enu[1].toFixed(3));
      const z = parseFloat(enu[2].toFixed(3));
      const yawDeg = log.gps.heading ?? 0.0;
      const pitchDeg = log.gps.pitch ?? 0.0;
      const rollDeg = log.gps.roll ?? 0.0;
      const speedKmh = log.speedKmh ?? 0.0;

      waypoints.push({
        x,
        y,
        z,
        yawDeg,
        pitchDeg,
        rollDeg,
        speedKmh,
        timestampMs: log.timestampMs
      });

      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      minZ = Math.min(minZ, z);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
      maxZ = Math.max(maxZ, z);
    }

    // Fallback bounds if telemetry is empty
    if (waypoints.length === 0) {
      minX = minY = minZ = -64.0;
      maxX = maxY = maxZ = 64.0;
    }

    const durationMs = entity.time.durationMs || (waypoints.length > 0
      ? waypoints[waypoints.length - 1].timestampMs - waypoints[0].timestampMs
      : 5000);

    const timeStepMs = waypoints.length > 1
      ? (waypoints[waypoints.length - 1].timestampMs - waypoints[0].timestampMs) / (waypoints.length - 1)
      : 250;

    return {
      entityId: entity.id,
      originWGS84: origin,
      timeStepMs: Math.round(timeStepMs),
      totalDurationMs: durationMs,
      waypoints,
      bounds: {
        min: [minX, minY, minZ],
        max: [maxX, maxY, maxZ]
      }
    };
  }

  /**
   * Constructs a complete S4D model inference request payload with sane defaults.
   */
  public static buildInferencePayload(
    entity: Entity4D,
    origin: LatLngAlt,
    options: S4DInferenceOptions = {}
  ): S4DInferenceRequest {
    const prompt = this.serializeTrajectoryPrompt(entity, origin);

    return {
      model: 'scratchbox-4d-dit-v1',
      prompt,
      options: {
        dimensions: options.dimensions ?? this.DEFAULT_DIMENSIONS,
        voxelSizeMeters: options.voxelSizeMeters ?? this.DEFAULT_VOXEL_SIZE,
        numInferenceSteps: options.numInferenceSteps ?? 20,
        guidanceScale: options.guidanceScale ?? 4.5,
        seed: options.seed ?? 42
      }
    };
  }

  /**
   * Validates kinematics continuity to prevent erratic teleports or unrealistic physics.
   */
  public static validateTrajectoryContinuity(prompt: S4DTrajectoryPrompt): {
    valid: boolean;
    maxSpeedKmh: number;
    totalDistanceMeters: number;
    warnings: string[];
  } {
    const warnings: string[] = [];
    let maxSpeedKmh = 0.0;
    let totalDistanceMeters = 0.0;

    if (prompt.waypoints.length < 2) {
      return {
        valid: false,
        maxSpeedKmh: 0,
        totalDistanceMeters: 0,
        warnings: ['Trajectory prompt requires at least 2 waypoints for temporal evaluation']
      };
    }

    for (let i = 1; i < prompt.waypoints.length; ++i) {
      const prev = prompt.waypoints[i - 1];
      const curr = prompt.waypoints[i];

      const dtSec = (curr.timestampMs - prev.timestampMs) / 1000.0;
      if (dtSec <= 0) {
        warnings.push(`Non-increasing timestamp detected at waypoint index ${i}`);
        continue;
      }

      const dx = curr.x - prev.x;
      const dy = curr.y - prev.y;
      const dz = curr.z - prev.z;
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
      totalDistanceMeters += dist;

      const calculatedSpeedKmh = (dist / dtSec) * 3.6;
      maxSpeedKmh = Math.max(maxSpeedKmh, calculatedSpeedKmh);

      // Warning if acceleration/speed exceeds reasonable drone/vehicle boundaries (e.g. supersonic jump)
      if (calculatedSpeedKmh > 500.0) {
        warnings.push(`Extreme velocity jump of ${calculatedSpeedKmh.toFixed(1)} km/h between steps ${i - 1} and ${i}`);
      }
    }

    return {
      valid: warnings.length === 0,
      maxSpeedKmh: parseFloat(maxSpeedKmh.toFixed(2)),
      totalDistanceMeters: parseFloat(totalDistanceMeters.toFixed(2)),
      warnings
    };
  }

  /**
   * Wraps generated 4D occupancy data into a formal Scratchbox Entity4D.
   */
  public static createOccupancyEntity(
    id: string,
    name: string,
    prompt: S4DTrajectoryPrompt,
    occupancyGrid: OccupancyGrid4D
  ): Entity4D {
    return {
      id,
      name,
      space: {
        geoAnchor: {
          lat: prompt.originWGS84.lat,
          lng: prompt.originWGS84.lng,
          alt: prompt.originWGS84.alt
        },
        localTransform: {
          position: [0, 0, 0],
          scale: [1, 1, 1]
        },
        boundingBox: {
          min: prompt.bounds.min,
          max: prompt.bounds.max
        }
      },
      time: {
        startMs: 0,
        durationMs: prompt.totalDurationMs,
        isContinuous: false
      },
      environment: {
        weather: {
          conditions: 'sunny'
        },
        solar: {
          altitude: Math.PI / 4,
          azimuth: Math.PI
        }
      },
      content: {
        type: 'occupancy-4d',
        durableUri: occupancyGrid.denseTensorUri || `scratchbox://occupancy/${id}`,
        occupancy4D: occupancyGrid,
        metadata: {
          dimensions: occupancyGrid.metadata.dimensions,
          voxelSizeMeters: occupancyGrid.metadata.voxelSizeMeters,
          generator: 'scratchbox-4d-dit-v1'
        }
      },
      behavior: {
        telemetryStream: prompt.waypoints.map(w => ({
          timestampMs: w.timestampMs,
          gps: {
            lat: prompt.originWGS84.lat,
            lng: prompt.originWGS84.lng,
            alt: prompt.originWGS84.alt,
            heading: w.yawDeg,
            pitch: w.pitchDeg,
            roll: w.rollDeg
          },
          speedKmh: w.speedKmh,
          status: 'SIMULATED'
        }))
      },
      lineage: {
        worldBranchId: 'earth/main',
        version: 1,
        provenance: {
          authorAgent: 'Scratchbox4DWorldEngine',
          timestamp: new Date().toISOString()
        }
      }
    };
  }

  /**
   * Run-Length Encodes a dense uint8 voxel array for compact network transfer and storage.
   */
  public static rleEncode(voxelArray: Uint8Array): string {
    const encoded: number[] = [];
    if (voxelArray.length === 0) return '';

    let currentVal = voxelArray[0];
    let runLength = 1;

    for (let i = 1; i < voxelArray.length; ++i) {
      if (voxelArray[i] === currentVal && runLength < 255) {
        runLength++;
      } else {
        encoded.push(runLength, currentVal);
        currentVal = voxelArray[i];
        runLength = 1;
      }
    }
    encoded.push(runLength, currentVal);

    return Buffer.from(new Uint8Array(encoded)).toString('base64');
  }

  /**
   * Decodes a Run-Length Encoded base64 string back into a dense uint8 voxel buffer.
   */
  public static rleDecode(rleBase64: string, totalCount: number): Uint8Array {
    const raw = Buffer.from(rleBase64, 'base64');
    const output = new Uint8Array(totalCount);
    let outIdx = 0;

    for (let i = 0; i < raw.length; i += 2) {
      const runLength = raw[i];
      const val = raw[i + 1];
      for (let r = 0; r < runLength && outIdx < totalCount; ++r) {
        output[outIdx++] = val;
      }
    }

    return output;
  }
}

/**
 * @deprecated Use S4DWorldModelBridge instead.
 */
export const OccSoraBridge = S4DWorldModelBridge;
export type OccSoraBridge = S4DWorldModelBridge;
