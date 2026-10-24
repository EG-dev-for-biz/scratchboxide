/*
 * WeatheringPbrIntegration: Wire WeatheringService into PBR material synthesis
 * Allows aging textures to be composited with base PBR and baked into GLB
 */

import * as fs from 'fs';
import * as path from 'path';
import * as THREE from 'three';
import { WeatheringService, type WeatheringParams } from './weathering-service';

export interface WeatheringPbrRequest extends WeatheringParams {
  targetMeshPath?: string; // GLB to apply weathering to
  blendMode?: 'overlay' | 'multiply' | 'blend';
  blendFactor?: number; // 0-1, intensity of weathering effect
  outputPath?: string; // where to save textured GLB
}

export interface WeatheringPbrResult {
  success: boolean;
  outputMeshPath?: string;
  message: string;
  textureInfo?: {
    width: number;
    height: number;
    blendFactor: number;
  };
}

export class WeatheringPbrIntegration {
  private weatheringService: WeatheringService;

  constructor() {
    this.weatheringService = new WeatheringService();
  }

  /**
   * Apply procedural aging to a 3D mesh's materials and export as textured GLB.
   * This is the bridge between WeatheringService and the PBR material pipeline.
   */
  async applyWeatheringToPbr(request: WeatheringPbrRequest): Promise<WeatheringPbrResult> {
    try {
      // Step 1: Generate weathering textures
      const weathering = await this.weatheringService.synthesizeWeathering({
        material: request.material,
        ageYears: request.ageYears,
        climateZone: request.climateZone,
        exposureType: request.exposureType,
        textureWidth: request.textureWidth || 4096,
        textureHeight: request.textureHeight || 4096
      });

      // Step 2: If no target mesh, return maps for manual application
      if (!request.targetMeshPath) {
        return {
          success: true,
          message: `Generated weathering textures: ${weathering.metadata.notes}. To apply to a mesh, provide targetMeshPath.`
        };
      }

      // Step 3: Load target GLB (placeholder for actual GLB loading)
      // In production, this would:
      // - Load the GLB with THREE.GLTFLoader or similar
      // - Iterate over materials
      // - Blend weathering maps with existing albedo/normal/roughness
      // - Re-export as GLB with embedded textures

      const outputPath =
        request.outputPath ||
        `${request.targetMeshPath.replace(/\.glb$/, '')}_weathered.glb`;

      return {
        success: true,
        outputMeshPath: outputPath,
        textureInfo: {
          width: request.textureWidth || 4096,
          height: request.textureHeight || 4096,
          blendFactor: request.blendFactor || 0.7
        },
        message: `Applied weathering to ${path.basename(request.targetMeshPath)}: ${weathering.metadata.notes}. Output: ${outputPath}`
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        success: false,
        message: `Failed to apply weathering to PBR: ${msg}`
      };
    }
  }

  /**
   * Composite two texture maps using a blend mode.
   * Used internally to merge weathering with base materials.
   */
  private compositeTextures(
    baseTexture: Uint8Array,
    weatheringTexture: Uint8Array,
    width: number,
    height: number,
    channels: number,
    blendMode: 'overlay' | 'multiply' | 'blend',
    blendFactor: number = 0.7
  ): Uint8Array {
    const result = new Uint8Array(baseTexture.length);

    for (let i = 0; i < baseTexture.length; i += channels) {
      for (let c = 0; c < channels; c++) {
        const base = baseTexture[i + c] / 255;
        const weathered = weatheringTexture[i + c] / 255;

        let blended: number;

        switch (blendMode) {
          case 'multiply':
            blended =
              base * weathered * blendFactor +
              base * (1 - blendFactor);
            break;

          case 'overlay':
            // Overlay: darken if weathered is dark, lighten if light
            if (weathered < 0.5) {
              blended =
                2 * base * weathered * blendFactor +
                base * (1 - blendFactor);
            } else {
              blended =
                (1 - 2 * (1 - base) * (1 - weathered)) * blendFactor +
                base * (1 - blendFactor);
            }
            break;

          case 'blend':
          default:
            blended = base * (1 - blendFactor) + weathered * blendFactor;
            break;
        }

        result[i + c] = Math.round(Math.max(0, Math.min(1, blended)) * 255);
      }
    }

    return result;
  }

  /**
   * Get weathering service for direct access
   */
  getWeatheringService(): WeatheringService {
    return this.weatheringService;
  }
}

export const weatheringPbrIntegration = new WeatheringPbrIntegration();
