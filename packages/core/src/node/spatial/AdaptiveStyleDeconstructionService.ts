/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import * as fs from 'fs-extra';
import * as path from 'path';
import { GoogleGenAI, Type, type Schema } from '@google/genai';
import { GeminiClient } from '../gemini/gemini-client';
import {
  AdaptiveWorldStyleContract,
  DEFAULT_ADAPTIVE_STYLE_CONTRACT
} from '../../common/spatial/adaptive-style-contract';

export interface DeconstructionOptions {
  client?: any; // Explicit GenAI client override
  fidelity?: 'fast-analytical' | 'balanced' | 'deep-multimodal';
  promptHint?: string;
}

const adaptiveStyleSchema: Schema = {
  type: Type.OBJECT,
  properties: {
    photometric: {
      type: Type.OBJECT,
      properties: {
        shadowLift: { type: Type.NUMBER, description: 'Shadow lift (0.0 to 1.0) to lift dark crevices toward stone baseline' },
        highlightCompress: { type: Type.NUMBER, description: 'Highlight compression (0.0 to 1.0) to tame burnt highlights' },
        contrastPivot: { type: Type.NUMBER, description: 'Contrast midpoint pivot (0.1 to 0.9, default 0.435)' },
        colorTemperatureK: { type: Type.NUMBER, description: 'Estimated atmospheric color temperature in Kelvin (1000 to 40000)' },
        colorGradingWheel: {
          type: Type.OBJECT,
          properties: {
            lift: {
              type: Type.OBJECT,
              properties: {
                r: { type: Type.NUMBER },
                g: { type: Type.NUMBER },
                b: { type: Type.NUMBER },
                master: { type: Type.NUMBER }
              },
              required: ['r', 'g', 'b', 'master']
            },
            gamma: {
              type: Type.OBJECT,
              properties: {
                r: { type: Type.NUMBER },
                g: { type: Type.NUMBER },
                b: { type: Type.NUMBER },
                master: { type: Type.NUMBER }
              },
              required: ['r', 'g', 'b', 'master']
            },
            gain: {
              type: Type.OBJECT,
              properties: {
                r: { type: Type.NUMBER },
                g: { type: Type.NUMBER },
                b: { type: Type.NUMBER },
                master: { type: Type.NUMBER }
              },
              required: ['r', 'g', 'b', 'master']
            }
          },
          required: ['lift', 'gamma', 'gain']
        },
        lutStrength: { type: Type.NUMBER, description: 'Target LUT strength blending (0.0 to 1.0)' }
      },
      required: ['shadowLift', 'highlightCompress', 'contrastPivot', 'colorTemperatureK', 'colorGradingWheel', 'lutStrength']
    },
    microSurface: {
      type: Type.OBJECT,
      properties: {
        detailFrequency: { type: Type.NUMBER, description: 'Micro-detail tiling frequency (typically 5.0 to 40.0)' },
        normalPerturbationScale: { type: Type.NUMBER, description: 'Intensity of physical bump perturbation (0.0 to 1.0)' },
        cavitationDepth: { type: Type.NUMBER, description: 'Depth of porous cavities/pockets (0.0 to 1.0)' },
        roughnessBias: { type: Type.NUMBER, description: 'PBR roughness modifier (-1.0 to 1.0)' },
        specularGlintIntensity: { type: Type.NUMBER, description: 'Facetted glint highlight brightness (0.0 to 1.0)' }
      },
      required: ['detailFrequency', 'normalPerturbationScale', 'cavitationDepth', 'roughnessBias', 'specularGlintIntensity']
    },
    geometricContours: {
      type: Type.OBJECT,
      properties: {
        enabled: { type: Type.BOOLEAN, description: 'Whether to enable line inking contours' },
        depthThreshold: { type: Type.NUMBER, description: 'Sensitivity to depth boundaries (0.01 to 1.0)' },
        normalThreshold: { type: Type.NUMBER, description: 'Sensitivity to normal angle changes (0.01 to 1.0)' },
        lineWidth: { type: Type.NUMBER, description: 'Outline line-width in pixels (0.5 to 10.0)' },
        inkColor: {
          type: Type.ARRAY,
          items: { type: Type.NUMBER },
          description: '[r, g, b] color of outlines'
        },
        jitter: { type: Type.NUMBER, description: 'Line waviness jitter (0.0 to 1.0)' }
      },
      required: ['enabled', 'depthThreshold', 'normalThreshold', 'lineWidth', 'inkColor', 'jitter']
    },
    stylizationFilter: {
      type: Type.OBJECT,
      properties: {
        quantizationBands: { type: Type.NUMBER, description: 'Number of stepped Cel shading bands (0 for off, 2 to 8)' },
        quantizationSoftness: { type: Type.NUMBER, description: 'Ramp boundary softness (0.01 to 1.0)' },
        kuwaharaRadius: { type: Type.NUMBER, description: 'Radius of anisotropic Kuwahara painterly smoothing (0 for off, 1 to 8)' },
        halftoneDensity: { type: Type.NUMBER, description: 'Ben-day halftone screening density (0 for off, >0)' },
        ditherMatrixSize: { type: Type.NUMBER, description: 'Matrix size for ordered dither (0 for off, 4 or 8)' }
      },
      required: ['quantizationBands', 'quantizationSoftness', 'kuwaharaRadius', 'halftoneDensity', 'ditherMatrixSize']
    }
  },
  required: ['photometric', 'microSurface', 'geometricContours', 'stylizationFilter']
};

export class AdaptiveStyleDeconstructionService {
  private client: any;

  constructor(options?: { client?: any }) {
    this.client = options?.client;
  }

  private async getGenAIClient(): Promise<any> {
    if (this.client) return this.client;
    const gemini = new GeminiClient();
    this.client = await gemini.getGenAIClient();
    return this.client;
  }

  /**
   * Main entry point: Projects any visual image reference into a continuous AdaptiveWorldStyleContract.
   */
  public async deconstructStyle(
    imageInput: string | Buffer,
    cameraPose?: { position: [number, number, number]; target: [number, number, number]; fov: number },
    options: DeconstructionOptions = {}
  ): Promise<AdaptiveWorldStyleContract> {
    const fidelity = options.fidelity || 'balanced';

    // Fast-analytical mode bypasses AI models entirely, matching our instant offline guidelines
    if (fidelity === 'fast-analytical') {
      return this.deconstructHeuristic(imageInput, cameraPose, options.promptHint);
    }

    try {
      const genai = await this.getGenAIClient();
      if (!genai) {
        console.warn('[AdaptiveStyleDeconstructionService] GenAI Client not authenticated. Falling back to analytical deconstruction.');
        return this.deconstructHeuristic(imageInput, cameraPose, options.promptHint);
      }

      let imageBase64 = '';
      let mimeType = 'image/png';

      if (Buffer.isBuffer(imageInput)) {
        imageBase64 = imageInput.toString('base64');
      } else if (typeof imageInput === 'string') {
        if (imageInput.startsWith('data:')) {
          const match = imageInput.match(/^data:([^;]+);base64,(.+)$/);
          if (match) {
            mimeType = match[1];
            imageBase64 = match[2];
          } else {
            throw new Error('AdaptiveStyleDeconstructionService: Invalid data URI schema.');
          }
        } else {
          if (await fs.pathExists(imageInput)) {
            const ext = path.extname(imageInput).toLowerCase();
            if (ext === '.jpg' || ext === '.jpeg') mimeType = 'image/jpeg';
            else if (ext === '.webp') mimeType = 'image/webp';
            const buffer = await fs.readFile(imageInput);
            imageBase64 = buffer.toString('base64');
          } else {
            throw new Error(`AdaptiveStyleDeconstructionService: File not found at path ${imageInput}`);
          }
        }
      }

      const contents: any[] = [
        {
          inlineData: {
            mimeType,
            data: imageBase64
          }
        },
        `Analyze the attached style reference image or design plate. Deconstruct its entire artistic, physical, and lighting DNA into a continuous WebGL shader parameter structure.

CRITICAL DIRECTIVES:
1. Examine lighting (noon, sunset, twilight, high-contrast, or soft overcast) to calibrate shadowLift (crevice lifting), highlightCompress (glare protection), contrastPivot, and colorTemperatureK.
2. Characterize color wheels: lift (shadow tinting), gamma (midtones), gain (highlights). Format each with rgb and master components.
3. Detect PBR micro-surface texture: is the image smooth/glossy (low roughnessBias, high glint), or is it heavily textured stone, brick, paper grain, canvas, or rough aggregate (high normalPerturbationScale, high detailFrequency)?
4. Inspect contour details: are there crisp hand-drawn or cartoon outlines, ink creases, or technical lines? Set enabled, lineWidth, inkColor, and jitter.
5. Identify non-photorealistic filters: cel shading (quantizationBands, quantizationSoftness), paint strokes / painterly effects (kuwaharaRadius), halftone screens (halftoneDensity), or retro retro dither matrices (ditherMatrixSize).

${options.promptHint ? `Additional Style Intent / Hint: "${options.promptHint}"` : ''}
${cameraPose ? `The target 3D world camera pose will be: Position: [${cameraPose.position}], Target: [${cameraPose.target}], FOV: ${cameraPose.fov}°` : ''}`
      ];

      const modelName = fidelity === 'deep-multimodal' ? 'gemini-2.5-pro' : 'gemini-2.5-flash';

      const response = await genai.models.generateContent({
        model: modelName,
        contents,
        config: {
          systemInstruction: 'You are an elite graphics programmer, technical director, and master colorist. Your job is to translate artistic reference frames into raw WebGL/PBR shader configuration parameter maps.',
          responseMimeType: 'application/json',
          responseSchema: adaptiveStyleSchema,
          temperature: 0.15
        }
      });

      const text = response.text || '{}';
      const contract = JSON.parse(text) as AdaptiveWorldStyleContract;

      // Add camera projection anchor if cameraPose is provided
      if (cameraPose && typeof imageInput === 'string' && !imageInput.startsWith('data:')) {
        contract.cameraProjection = {
          enabled: true,
          position: cameraPose.position,
          target: cameraPose.target,
          fovDeg: cameraPose.fov,
          grazingAngleCutoff: 0.5,
          referenceImageUri: imageInput
        };
      }

      return contract;
    } catch (err) {
      console.warn('[AdaptiveStyleDeconstructionService] Multimodal styling extraction failed. Falling back to analytical deconstruction:', err);
      return this.deconstructHeuristic(imageInput, cameraPose, options.promptHint);
    }
  }

  /**
   * Fast, zero-dependency, robust offline heuristic to infer style profiles from images.
   */
  public deconstructHeuristic(
    imageInput: string | Buffer,
    cameraPose?: { position: [number, number, number]; target: [number, number, number]; fov: number },
    promptHint?: string
  ): AdaptiveWorldStyleContract {
    const contract = JSON.parse(JSON.stringify(DEFAULT_ADAPTIVE_STYLE_CONTRACT)) as AdaptiveWorldStyleContract;
    const promptLower = (promptHint || '').toLowerCase();

    // 1. Detect Non-Photorealistic Presets from prompts/hints
    if (promptLower.includes('comic') || promptLower.includes('spider-verse') || promptLower.includes('anime') || promptLower.includes('cartoon') || promptLower.includes('cel')) {
      contract.stylizationFilter.quantizationBands = 4;
      contract.stylizationFilter.quantizationSoftness = 0.08;
      contract.geometricContours.enabled = true;
      contract.geometricContours.lineWidth = 2.0;
      contract.geometricContours.depthThreshold = 0.15;
      contract.geometricContours.normalThreshold = 0.12;
      contract.geometricContours.inkColor = [0.02, 0.02, 0.05];
      contract.photometric.shadowLift = 0.6;
      contract.photometric.highlightCompress = 0.5;

      if (promptLower.includes('halftone')) {
        contract.stylizationFilter.halftoneDensity = 14.0;
      }
    } else if (promptLower.includes('oil') || promptLower.includes('painterly') || promptLower.includes('watercolor') || promptLower.includes('arcane') || promptLower.includes('brush')) {
      contract.stylizationFilter.kuwaharaRadius = 4;
      contract.microSurface.normalPerturbationScale = 0.25;
      contract.microSurface.roughnessBias = 0.15;
      contract.geometricContours.enabled = promptLower.includes('watercolor') || promptLower.includes('ink');
      contract.geometricContours.lineWidth = 1.0;
      contract.geometricContours.depthThreshold = 0.2;
      contract.geometricContours.inkColor = [0.1, 0.1, 0.12];
    } else if (promptLower.includes('psx') || promptLower.includes('retro') || promptLower.includes('low-fi') || promptLower.includes('dither') || promptLower.includes('console')) {
      contract.stylizationFilter.ditherMatrixSize = 4;
      contract.photometric.shadowLift = 0.3;
      contract.photometric.highlightCompress = 0.2;
      contract.microSurface.detailFrequency = 4.0;
      contract.microSurface.normalPerturbationScale = 0.05;
    } else if (promptLower.includes('blueprint') || promptLower.includes('drawing') || promptLower.includes('sketch') || promptLower.includes('contour')) {
      contract.geometricContours.enabled = true;
      contract.geometricContours.lineWidth = 1.5;
      contract.geometricContours.depthThreshold = 0.08;
      contract.geometricContours.normalThreshold = 0.05;
      contract.geometricContours.jitter = 0.15;
      contract.photometric.shadowLift = 0.8;
      contract.photometric.highlightCompress = 0.7;
      if (promptLower.includes('blueprint')) {
        contract.geometricContours.inkColor = [0.0, 0.85, 1.0];
        contract.photometric.colorGradingWheel.lift = { r: 0.0, g: 0.2, b: 0.8, master: 1.0 };
      }
    }

    // 2. Adjust color temperatures based on diurnal lighting descriptors
    if (promptLower.includes('sunset') || promptLower.includes('dusk') || promptLower.includes('twilight')) {
      contract.photometric.colorTemperatureK = 3200;
      contract.photometric.shadowLift = 0.7;
      contract.photometric.colorGradingWheel.lift = { r: 0.1, g: 0.12, b: 0.25, master: 0.95 };
      contract.photometric.colorGradingWheel.gamma = { r: 0.95, g: 0.65, b: 0.55, master: 1.0 };
      contract.photometric.colorGradingWheel.gain = { r: 1.05, g: 0.78, b: 0.45, master: 1.05 };
    } else if (promptLower.includes('golden hour') || promptLower.includes('sunset golden') || promptLower.includes('warm')) {
      contract.photometric.colorTemperatureK = 2800;
      contract.photometric.shadowLift = 0.55;
      contract.photometric.colorGradingWheel.gamma = { r: 1.05, g: 0.85, b: 0.65, master: 1.0 };
      contract.photometric.colorGradingWheel.gain = { r: 1.15, g: 0.95, b: 0.55, master: 1.1 };
    } else if (promptLower.includes('cyberpunk') || promptLower.includes('neon') || promptLower.includes('night')) {
      contract.photometric.colorTemperatureK = 18000;
      contract.photometric.shadowLift = 0.85;
      contract.photometric.colorGradingWheel.lift = { r: 0.05, g: 0.02, b: 0.12, master: 1.0 };
      contract.photometric.colorGradingWheel.gamma = { r: 0.85, g: 0.15, b: 0.95, master: 1.0 };
      contract.photometric.colorGradingWheel.gain = { r: 0.15, g: 0.95, b: 0.85, master: 1.15 };
    }

    // 3. Setup camera projection if requested and inputs allow
    if (cameraPose && typeof imageInput === 'string' && !imageInput.startsWith('data:')) {
      contract.cameraProjection = {
        enabled: true,
        position: cameraPose.position,
        target: cameraPose.target,
        fovDeg: cameraPose.fov,
        grazingAngleCutoff: 0.5,
        referenceImageUri: imageInput
      };
    }

    return contract;
  }
}
