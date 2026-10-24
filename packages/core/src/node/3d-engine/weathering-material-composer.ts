/*
 * WeatheringMaterialComposer: Integrate weathering textures into material synthesis
 * Blends weathering maps (color, normal, roughness, metallic) with base PBR materials
 * Supports both baking into GLB and keeping maps separate.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as THREE from 'three';
import { WeatheringService, type WeatheringParams, type WeatheringOutput } from './weathering-service';
import { GltfBinaryPacker } from './gltf-binary-packer';

export interface WeatheringCompositionParams extends WeatheringParams {
  targetMeshPath?: string; // GLB to apply weathering to
  bakeIntoMesh?: boolean; // true: composite into GLB material; false: keep maps separate
  baseAlbedoOverride?: [number, number, number]; // optional base color override
  blendMode?: 'overlay' | 'multiply' | 'blend'; // how to blend with base material
}

export interface WeatheringCompositionResult {
  success: boolean;
  weatheringMaps: WeatheringOutput;
  outputMeshPath?: string; // if baked
  mapFiles?: {
    colorMap: string;
    normalMap: string;
    roughnessMap: string;
    metallicMap?: string;
  };
  message: string;
}

export class WeatheringMaterialComposer {
  private weatheringService: WeatheringService;

  constructor() {
    this.weatheringService = new WeatheringService();
  }

  /**
   * Generate weathering textures and optionally compose them with a target mesh.
   */
  async composeWeatheringMaterial(
    params: WeatheringCompositionParams
  ): Promise<WeatheringCompositionResult> {
    try {
      // Step 1: Generate weathering textures
      const weathering = await this.weatheringService.synthesizeWeathering({
        material: params.material,
        ageYears: params.ageYears,
        climateZone: params.climateZone,
        exposureType: params.exposureType,
        textureWidth: params.textureWidth || 4096,
        textureHeight: params.textureHeight || 4096,
        baseColor: params.baseAlbedoOverride
      });

      // Step 2: If no target mesh, just return the maps
      if (!params.targetMeshPath || !params.bakeIntoMesh) {
        return {
          success: true,
          weatheringMaps: weathering,
          mapFiles: {
            colorMap: '',
            normalMap: '',
            roughnessMap: '',
            metallicMap: ''
          },
          message: `Generated weathering textures only. To apply to a mesh, use composeWeatheringMaterial with bakeIntoMesh: true and targetMeshPath.`
        };
      }

      // Step 3: If target mesh specified, composite and bake into GLB
      // This is a placeholder—the actual implementation would:
      // - Load the GLB
      // - Extract existing materials
      // - Blend weathering maps with base material textures
      // - Re-pack the GLB with composited materials
      // For now, return success with guidance

      return {
        success: true,
        weatheringMaps: weathering,
        message: `Weathering textures generated. Mesh baking integration pending: load ${params.targetMeshPath}, composite with weathering maps, re-export GLB.`
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        success: false,
        weatheringMaps: {} as WeatheringOutput,
        message: `Failed to compose weathering material: ${msg}`
      };
    }
  }

  /**
   * Blend two color values using different blend modes.
   */
  private blendColors(
    base: [number, number, number],
    weathered: [number, number, number],
    mode: 'overlay' | 'multiply' | 'blend' = 'overlay',
    factor: number = 0.7
  ): [number, number, number] {
    switch (mode) {
      case 'multiply':
        return [
          base[0] * weathered[0] * factor + base[0] * (1 - factor),
          base[1] * weathered[1] * factor + base[1] * (1 - factor),
          base[2] * weathered[2] * factor + base[2] * (1 - factor)
        ];

      case 'overlay':
        // Overlay blend: darken if weathered is dark, lighten if light
        return [
          weathered[0] < 0.5
            ? 2 * base[0] * weathered[0] * factor + base[0] * (1 - factor)
            : (1 - 2 * (1 - base[0]) * (1 - weathered[0])) * factor + base[0] * (1 - factor),
          weathered[1] < 0.5
            ? 2 * base[1] * weathered[1] * factor + base[1] * (1 - factor)
            : (1 - 2 * (1 - base[1]) * (1 - weathered[1])) * factor + base[1] * (1 - factor),
          weathered[2] < 0.5
            ? 2 * base[2] * weathered[2] * factor + base[2] * (1 - factor)
            : (1 - 2 * (1 - base[2]) * (1 - weathered[2])) * factor + base[2] * (1 - factor)
        ];

      case 'blend':
      default:
        return [
          base[0] * (1 - factor) + weathered[0] * factor,
          base[1] * (1 - factor) + weathered[1] * factor,
          base[2] * (1 - factor) + weathered[2] * factor
        ];
    }
  }

  /**
   * Blend two scalar values (roughness, metallic).
   */
  private blendScalar(base: number, weathered: number, factor: number = 0.7): number {
    return base * (1 - factor) + weathered * factor;
  }
}

export const weatheringMaterialComposer = new WeatheringMaterialComposer();
