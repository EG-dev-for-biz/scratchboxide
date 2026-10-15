/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import { Universal4DSceneDocument } from '../../common/geospatial-4d-protocol';
import { LocalTangentPlane } from '../../common/coordinate/LocalTangentPlane';
import { MissingInputError } from '../../common/errors/pipeline-errors';
import { WorldBranchManager } from './WorldBranchManager';

export interface SpatialAIConditioningPayload {
  restylePrompt: string;
  depthBufferBase64?: string;
  normalMapBase64?: string;
  cameraExtrinsics?: number[]; // 16-element 4x4 matrix
  s2CellToken?: string;
}

export class HeadlessSpatialAiBridge {
  /**
   * Translates a universal 4D Scene Document and a target entity into a highly detailed,
   * conditioned, mathematically grounded prompt suitable for Google Imagen 3 (images) and Veo 2 (videos).
   */
  public static synthesizeGroundedMultimodalPrompt(
    sceneDoc: Universal4DSceneDocument,
    targetEntityId: string,
    rawUserConcept: string
  ): { structuredPrompt: string; payload: SpatialAIConditioningPayload } {
    const entity = sceneDoc.entities.find(e => e.id === targetEntityId);
    if (!entity) {
      throw new Error(`Target Entity ${targetEntityId} not found in 4D Scene Document`);
    }

    // The prompt is grounded on where the entity is: without its geoAnchor there is nothing to ground it on.
    if (!entity.space.geoAnchor) {
      throw new MissingInputError('synthesizeGroundedMultimodalPrompt', `a geoAnchor on entity ${targetEntityId}`, 'no default location is used');
    }
    const origin = entity.space.geoAnchor;
    const ltp = new LocalTangentPlane(origin);

    // Compute geographic positions and angles
    const geoPos = entity.space.geoAnchor || origin;
    const localPos = ltp.toLocal(geoPos);

    const solar = sceneDoc.environment.solar || { altitude: 0.5, azimuth: 3.2 };
    const sunAzimuthDeg = (solar.azimuth * 180.0) / Math.PI;
    const sunAltitudeDeg = (solar.altitude * 180.0) / Math.PI;

    const weather = sceneDoc.environment.weather?.conditions || 'sunny';
    const fogDensity = sceneDoc.environment.weather?.fogDensity ?? 0.0;

    // Build the structured spatial-temporal text instructions
    let prompt = `================================================================================\n`;
    prompt += `GOOGLE MULTIMODAL AI GROUNDING COMPILER (IMAGEN 3 / VEO 2 ENGINE)\n`;
    prompt += `================================================================================\n`;
    prompt += `CONTEXT PRIOR: Spatio-Temporal 4D Conditioning Matrix\n`;
    prompt += `- Geodetic Origin : Lat ${origin.lat.toFixed(5)}°, Lng ${origin.lng.toFixed(5)}° (Alt: ${(origin.alt ?? 0).toFixed(1)}m)\n`;
    prompt += `- Target Coordinates: Lat ${geoPos.lat.toFixed(5)}°, Lng ${geoPos.lng.toFixed(5)}° (Alt: ${(geoPos.alt ?? 0).toFixed(1)}m)\n`;
    prompt += `- Metric Transform : Local ENU [${localPos[0].toFixed(3)}m East, ${localPos[1].toFixed(3)}m Up, ${localPos[2].toFixed(3)}m South]\n`;
    prompt += `- Astronomical Sun : Altitude ${sunAltitudeDeg.toFixed(1)}° above horizon, Azimuth ${sunAzimuthDeg.toFixed(1)}° (North-relative)\n`;
    prompt += `- Atmospheric State: Weather: ${weather} (Fog Density: ${(fogDensity * 100).toFixed(0)}%)\n`;
    prompt += `- Lineage Layer    : Branch "${entity.lineage.worldBranchId}" (Version ${entity.lineage.version})\n`;
    prompt += `================================================================================\n\n`;

    prompt += `DIRECTIVE FOR GENERATIVE STYLIZATION:\n`;
    prompt += `Synthesize a high-fidelity visual composition based on the following user concept: "${rawUserConcept}".\n`;
    prompt += `Your output must strictly respect the physical light rays and geographic horizon vectors compiled above:\n`;
    prompt += `1. LIGHTING DIRECTION: Cast sharp, coherent directional light rays pointing from sun azimuth ${sunAzimuthDeg.toFixed(1)}° and elevation ${sunAltitudeDeg.toFixed(1)}°.\n`;
    prompt += `2. SHADOW GEOMETRY: Cast physically accurate volumetric shadows stretching opposite the sun vector. Shadow length ratio relative to height must scale exactly to ${Math.max(0.1, 1.0 / Math.tan(solar.altitude)).toFixed(2)}x.\n`;
    prompt += `3. WEATHER & SKYDOME: Map the ambient hemisphere light to ${weather} sky characteristics, setting the color temperature to ${this.estimateColorTemperature(sunAltitudeDeg)}K.\n`;
    prompt += `4. BOUNDING GEOMETRY: Retain all real architectural boundaries, height caps, and terrain slopes of the Local Tangent Plane. Do not warp buildings or streets.\n`;

    const payload: SpatialAIConditioningPayload = {
      restylePrompt: prompt,
      s2CellToken: entity.space.s2CellToken,
      cameraExtrinsics: entity.space.localTransform?.rotationQuaternion ? [
        ...entity.space.localTransform.position,
        ...entity.space.localTransform.rotationQuaternion
      ] : undefined
    };

    return {
      structuredPrompt: prompt,
      payload
    };
  }

  /**
   * Synthesizes a grounded visual prompt directly from a specific multiverse branch history.
   */
  public static synthesizePromptFromBranch(
    branchManager: WorldBranchManager,
    branchId: string,
    targetEntityId: string,
    rawUserConcept: string,
    baseSceneDoc: Universal4DSceneDocument
  ): { structuredPrompt: string; payload: SpatialAIConditioningPayload } {
    const history = branchManager.getBranchHistory(branchId);
    if (!history || history.length === 0) {
      throw new Error(`Multiverse branch ${branchId} not found in manager`);
    }

    const latestCommit = history[history.length - 1];
    const entity = latestCommit.entitiesSnapshot.find(e => e.id === targetEntityId);
    if (!entity) {
      throw new Error(`Target Entity ${targetEntityId} not found on multiverse branch ${branchId}`);
    }

    // Build temporary scene document reflecting the branch's latest state
    const branchSceneDoc: Universal4DSceneDocument = {
      ...baseSceneDoc,
      environment: {
        ...baseSceneDoc.environment,
        weather: entity.environment?.weather || baseSceneDoc.environment.weather,
        solar: entity.environment?.solar || baseSceneDoc.environment.solar
      },
      entities: latestCommit.entitiesSnapshot
    };

    return this.synthesizeGroundedMultimodalPrompt(branchSceneDoc, targetEntityId, rawUserConcept);
  }

  /**
   * Helper to estimate color temperature (Kelvins) based on solar altitude angle.
   */
  private static estimateColorTemperature(sunAltitudeDeg: number): number {
    if (sunAltitudeDeg <= 0) return 1800; // Deep twilight / sodium candlelight
    if (sunAltitudeDeg < 5) return 2500;  // Sunset/Sunrise golden hues
    if (sunAltitudeDeg < 20) return 3500; // Early morning / late afternoon warm light
    if (sunAltitudeDeg < 45) return 5000; // Mid-day warm white
    return 6500;                          // Overcast / high-altitude solar noon (cool daylight)
  }
}
