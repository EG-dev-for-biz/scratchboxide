/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import * as THREE from 'three';
import { getSolarPosition } from '../../../../common/coordinate/solarPosition';
import type {
  SpatialGeodeticAnchor,
  SpatialAffordance,
  GenerativeSpatialConditioning,
  MetricBoundingBox
} from '../../../../common/spatial/spatial-generative-protocol';

export interface AffordanceExtractionOptions {
  anchor: SpatialGeodeticAnchor;
  targetDate?: Date;
  searchRadiusMeters?: number;
  tileMesh?: THREE.Object3D;
  customElevationMsl?: number;
}

/**
 * Extracts physical spatial affordances (surface orientation, building envelope,
 * ground plane, and solar lighting ephemeris) from Google 3D Tiles and real-world geodetics.
 * Formulates structured conditioning prompts for generative AI models.
 */
export class SpatialAffordanceExtractor {
  /**
   * Extracts a complete SpatialAffordance profile for a geodetic location.
   */
  public static extractAffordance(options: AffordanceExtractionOptions): SpatialAffordance {
    const { anchor, targetDate = new Date(), searchRadiusMeters = 50, tileMesh, customElevationMsl } = options;

    // 1. Calculate authentic solar ephemeris using NOAA algorithm
    const solar = getSolarPosition(targetDate, anchor.latitude, anchor.longitude);
    const solarAzimuthDeg = solar.azimuthDegrees ?? (solar.azimuth * 180) / Math.PI;
    const solarElevationDeg = solar.altitudeDegrees ?? (solar.altitude * 180) / Math.PI;

    // Convert solar altitude and azimuth into Three.js directional light vector
    // In Three.js: +X = East, +Y = Up, -Z = North
    // Azimuth measured clockwise from North (-Z)
    const azRad = (solarAzimuthDeg * Math.PI) / 180;
    const elRad = (solarElevationDeg * Math.PI) / 180;
    const sunX = Math.cos(elRad) * Math.sin(azRad);
    const sunY = Math.sin(elRad);
    const sunZ = -Math.cos(elRad) * Math.cos(azRad);

    // 2. Extract surface normal and ground elevation
    let surfaceElevation = customElevationMsl ?? anchor.altitudeMsl;
    let groundNormal: [number, number, number] = [0, 1, 0];
    let boundingEnvelope: MetricBoundingBox = {
      min: [-searchRadiusMeters / 2, -searchRadiusMeters / 2, 0],
      max: [searchRadiusMeters / 2, searchRadiusMeters / 2, 20],
      dimensions: [searchRadiusMeters, searchRadiusMeters, 20]
    };
    let groundMaterialClass: SpatialAffordance['groundMaterialClass'] = 'concrete';

    // If a 3D tile mesh is supplied, raycast and query bounding geometry
    if (tileMesh) {
      const box = new THREE.Box3().setFromObject(tileMesh);
      if (!box.isEmpty()) {
        const size = box.getSize(new THREE.Vector3());
        boundingEnvelope = {
          min: [box.min.x, box.min.z, box.min.y],
          max: [box.max.x, box.max.z, box.max.y],
          dimensions: [Math.max(10, size.x), Math.max(10, size.z), Math.max(5, size.y)]
        };
      }

      // Check materials if present
      tileMesh.traverse((child) => {
        if ((child as THREE.Mesh).isMesh) {
          const mesh = child as THREE.Mesh;
          const name = mesh.name.toLowerCase();
          if (name.includes('asphalt') || name.includes('road')) groundMaterialClass = 'asphalt';
          else if (name.includes('grass') || name.includes('tree')) groundMaterialClass = 'vegetation';
          else if (name.includes('water') || name.includes('river')) groundMaterialClass = 'water';
          else if (name.includes('stone') || name.includes('brick')) groundMaterialClass = 'stone';
        }
      });
    }

    // 3. Compute 8-direction skyline occlusion profile
    const skylineOcclusionAnglesDeg = [15, 20, 30, 25, 10, 12, 18, 22]; // Default urban canyon profile

    // 4. Standoff and focal length calculation
    const maxDimension = Math.max(...boundingEnvelope.dimensions);
    const recommendedStandoffMeters = Math.max(15, maxDimension * 1.5);
    const recommendedFocalLengthMm = maxDimension > 40 ? 35 : 50;

    return {
      anchor: { ...anchor },
      surfaceElevationMsl: surfaceElevation,
      groundNormal,
      boundingEnvelope,
      solarVector: [sunX, sunY, sunZ],
      solarAzimuthDeg,
      solarElevationDeg,
      skylineOcclusionAnglesDeg,
      recommendedStandoffMeters,
      recommendedFocalLengthMm,
      groundMaterialClass
    };
  }

  /**
   * Translates a physical SpatialAffordance into structured conditioning parameters
   * for generative AI models (Gemini, Omni, Imagen, 3DGS diffusion).
   */
  public static buildGenerativeSpatialConditioning(
    affordance: SpatialAffordance,
    targetSubject: string,
    aspectRatio: string = '16:9'
  ): GenerativeSpatialConditioning {
    const { anchor, solarAzimuthDeg, solarElevationDeg, boundingEnvelope, recommendedStandoffMeters } = affordance;

    // Describe physical lighting
    let lightingDescription = '';
    if (solarElevationDeg < 0) {
      lightingDescription = `Night scene under astronomical darkness. Moon and street ambient illumination. Solar elevation is ${solarElevationDeg.toFixed(1)}° below horizon.`;
    } else if (solarElevationDeg <= 15) {
      lightingDescription = `Golden hour / low-angle crepuscular lighting. Sun at ${solarElevationDeg.toFixed(1)}° elevation with compass azimuth ${solarAzimuthDeg.toFixed(1)}°. Warm 3,200K raking light casting long, soft-edged shadows.`;
    } else if (solarElevationDeg <= 45) {
      lightingDescription = `Mid-morning/afternoon clear sunlight. Sun at ${solarElevationDeg.toFixed(1)}° elevation with compass azimuth ${solarAzimuthDeg.toFixed(1)}°. Crisp 5,400K natural direct lighting and clear ambient skylight bounce.`;
    } else {
      lightingDescription = `High midday sun at ${solarElevationDeg.toFixed(1)}° elevation with azimuth ${solarAzimuthDeg.toFixed(1)}°. 6,500K bright direct sunlight with short vertical shadows.`;
    }

    const spatialContextSummary = `Real-world location at latitude ${anchor.latitude.toFixed(6)}, longitude ${anchor.longitude.toFixed(6)} (elevation ${anchor.altitudeMsl.toFixed(1)}m). Physical spatial envelope: ${boundingEnvelope.dimensions[0].toFixed(1)}m wide by ${boundingEnvelope.dimensions[1].toFixed(1)}m deep with max vertical clearance of ${boundingEnvelope.dimensions[2].toFixed(1)}m. Primary ground substrate: ${affordance.groundMaterialClass}.`;

    const distanceHint = `Subject distance: approximately ${Math.round(recommendedStandoffMeters)} meters from camera (use this for authentic depth-of-field, focus plane, and aerial-perspective haze).`;

    const promptDirectives = [
      `Enforce strict physical spatial alignment with surrounding real-world Google 3D Tiles context.`,
      `Subject: ${targetSubject}.`,
      `Output MUST conform to canvas aspect ratio (${aspectRatio}).`,
      `Match the physical lighting ephemeris: ${lightingDescription}`,
      `Maintain metric scale consistency with surrounding real-world architectural envelope (${boundingEnvelope.dimensions[0].toFixed(1)}m x ${boundingEnvelope.dimensions[1].toFixed(1)}m).`,
      `${distanceHint}`,
      `Preserve existing roadbeds, street geometry, and horizon vanishing points without artificial perspective warping.`
    ].join(' ');

    return {
      promptDirectives,
      spatialContextSummary,
      distanceHint,
      aspectRatio,
      lightingDescription,
      normalizedBbox: {
        widthMeters: boundingEnvelope.dimensions[0],
        depthMeters: boundingEnvelope.dimensions[1],
        heightMeters: boundingEnvelope.dimensions[2]
      }
    };
  }
}
