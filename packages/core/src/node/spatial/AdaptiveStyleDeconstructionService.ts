/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import { downscaleForVision } from '../vision-image-downscale';
import * as fs from 'fs-extra';
import * as path from 'path';
import { Type, type Schema } from '@google/genai';
import { GeminiClient } from '../gemini/gemini-client';
import { AdaptiveWorldStyleContract } from '../../common/spatial/adaptive-style-contract';
import { MissingInputError, VisionUnavailableError } from '../../common/errors/pipeline-errors';

export interface DeconstructionOptions {
  client?: any; // Explicit GenAI client override
  /** 'balanced' (default) reads the image with gemini-2.5-flash, 'deep-multimodal' with gemini-2.5-pro. */
  fidelity?: 'balanced' | 'deep-multimodal';
  promptHint?: string;
}

/** The contract a vision model read from the reference image, and which model read it. */
export interface StyleDeconstructionResult {
  contract: AdaptiveWorldStyleContract;
  modelUsed: string;
}

/** Every field the response schema requires, as dotted paths; a model answer missing any of them is refused. */
const REQUIRED_CONTRACT_FIELDS: Array<[string, 'number' | 'boolean' | 'rgb']> = [
  ['photometric.shadowLift', 'number'], ['photometric.highlightCompress', 'number'], ['photometric.contrastPivot', 'number'],
  ['photometric.colorTemperatureK', 'number'], ['photometric.lutStrength', 'number'],
  ...(['lift', 'gamma', 'gain'] as const).flatMap(w => (['r', 'g', 'b', 'master'] as const)
    .map(c => [`photometric.colorGradingWheel.${w}.${c}`, 'number'] as [string, 'number'])),
  ['microSurface.detailFrequency', 'number'], ['microSurface.normalPerturbationScale', 'number'], ['microSurface.cavitationDepth', 'number'],
  ['microSurface.roughnessBias', 'number'], ['microSurface.specularGlintIntensity', 'number'],
  ['geometricContours.enabled', 'boolean'], ['geometricContours.depthThreshold', 'number'], ['geometricContours.normalThreshold', 'number'],
  ['geometricContours.lineWidth', 'number'], ['geometricContours.inkColor', 'rgb'], ['geometricContours.jitter', 'number'],
  ['stylizationFilter.quantizationBands', 'number'], ['stylizationFilter.quantizationSoftness', 'number'], ['stylizationFilter.kuwaharaRadius', 'number'],
  ['stylizationFilter.halftoneDensity', 'number'], ['stylizationFilter.ditherMatrixSize', 'number']
];

/** The dotted paths of REQUIRED_CONTRACT_FIELDS that `value` lacks or has with the wrong type. */
export function invalidStyleContractFields(value: unknown): string[] {
  return REQUIRED_CONTRACT_FIELDS.filter(([field, kind]) => {
    const v = field.split('.').reduce<any>((o, k) => (o && typeof o === 'object' ? o[k] : undefined), value);
    if (kind === 'boolean') return typeof v !== 'boolean';
    if (kind === 'rgb') return !Array.isArray(v) || v.length !== 3 || !v.every(n => typeof n === 'number' && Number.isFinite(n));
    return typeof v !== 'number' || !Number.isFinite(v);
  }).map(([field]) => field);
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
   * Has a Gemini vision model read the reference image into an AdaptiveWorldStyleContract. Every value comes from
   * the model's answer; when no model can read the image (no credentials, a failed call, or an incomplete answer)
   * this throws VisionUnavailableError. There is no offline or keyword-based stand-in.
   */
  public async deconstructStyle(
    imageInput: string | Buffer,
    cameraPose?: { position: [number, number, number]; target: [number, number, number]; fov: number },
    options: DeconstructionOptions = {}
  ): Promise<StyleDeconstructionResult> {
    const fidelity = options.fidelity || 'balanced';
    if (fidelity !== 'balanced' && fidelity !== 'deep-multimodal') {
      throw new MissingInputError('adaptive style deconstruction', 'fidelity', `"${fidelity}" is not one of "balanced" or "deep-multimodal"`);
    }
    const modelName = fidelity === 'deep-multimodal' ? 'gemini-2.5-pro' : 'gemini-2.5-flash';
    const full = await this.readImage(imageInput);
    // Style is read from the image's content: a 1024 px long edge carries it, and uploads and answers faster.
    // An image this process cannot decode is sent as given; the model reads more formats than we do.
    const vision = await downscaleForVision(Buffer.from(full.data, 'base64'), full.mimeType).catch(() => undefined);
    const imageBase64 = vision?.downscaled ? vision.data.toString('base64') : full.data;
    const mimeType = vision?.downscaled ? vision.mimeType : full.mimeType;
    const sizeNote = vision?.downscaled
      ? `The image was downscaled from ${vision.originalWidth}x${vision.originalHeight} to ${vision.width}x${vision.height} for analysis; give pixel measures (such as lineWidth) at the original ${vision.originalWidth}x${vision.originalHeight} size.`
      : '';

    let genai: any;
    try {
      genai = options.client || await this.getGenAIClient();
    } catch (err: any) {
      throw new VisionUnavailableError(modelName, 'no-credentials', err?.message || String(err));
    }
    if (!genai?.models?.generateContent) {
      throw new VisionUnavailableError(modelName, 'no-credentials', 'no Gemini client is configured');
    }

    const contents: any[] = [
      { inlineData: { mimeType, data: imageBase64 } },
      `Analyze the attached style reference image or design plate. Deconstruct its entire artistic, physical, and lighting DNA into a continuous WebGL shader parameter structure.

CRITICAL DIRECTIVES:
1. Examine lighting (noon, sunset, twilight, high-contrast, or soft overcast) to calibrate shadowLift (crevice lifting), highlightCompress (glare protection), contrastPivot, and colorTemperatureK.
2. Characterize color wheels: lift (shadow tinting), gamma (midtones), gain (highlights). Format each with rgb and master components.
3. Detect PBR micro-surface texture: is the image smooth/glossy (low roughnessBias, high glint), or is it heavily textured stone, brick, paper grain, canvas, or rough aggregate (high normalPerturbationScale, high detailFrequency)?
4. Inspect contour details: are there crisp hand-drawn or cartoon outlines, ink creases, or technical lines? Set enabled, lineWidth, inkColor, and jitter.
5. Identify non-photorealistic filters: cel shading (quantizationBands, quantizationSoftness), paint strokes / painterly effects (kuwaharaRadius), halftone screens (halftoneDensity), or retro dither matrices (ditherMatrixSize).

${options.promptHint ? `Additional Style Intent / Hint: "${options.promptHint}"` : ''}
${sizeNote}
${cameraPose ? `The target 3D world camera pose will be: Position: [${cameraPose.position}], Target: [${cameraPose.target}], FOV: ${cameraPose.fov}°` : ''}`
    ];

    let text: string;
    try {
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
      text = response?.text || '';
    } catch (err: any) {
      throw new VisionUnavailableError(modelName, err?.status || err?.code || 'request-failed', err?.message || String(err));
    }

    let contract: AdaptiveWorldStyleContract;
    try {
      contract = JSON.parse(text) as AdaptiveWorldStyleContract;
    } catch {
      throw new VisionUnavailableError(modelName, 'invalid-response', `the answer is not JSON: ${text.slice(0, 200) || '(empty)'}`);
    }
    const invalid = invalidStyleContractFields(contract);
    if (invalid.length) {
      throw new VisionUnavailableError(modelName, 'invalid-response', `the answer lacks ${invalid.join(', ')}`);
    }

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

    return { contract, modelUsed: modelName };
  }

  /** The reference image as base64 and its MIME type; a missing file or malformed data URI is a MissingInputError. */
  private async readImage(imageInput: string | Buffer): Promise<{ data: string; mimeType: string }> {
    if (Buffer.isBuffer(imageInput)) {
      return { data: imageInput.toString('base64'), mimeType: 'image/png' };
    }
    if (imageInput.startsWith('data:')) {
      const match = imageInput.match(/^data:([^;]+);base64,(.+)$/);
      if (!match) throw new MissingInputError('adaptive style deconstruction', 'referenceImage', 'the data URI is not base64 image data');
      return { mimeType: match[1], data: match[2] };
    }
    if (!(await fs.pathExists(imageInput))) {
      throw new MissingInputError('adaptive style deconstruction', 'referenceImage', `${imageInput} does not exist`);
    }
    const ext = path.extname(imageInput).toLowerCase();
    const mimeType = ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : ext === '.webp' ? 'image/webp' : 'image/png';
    return { mimeType, data: (await fs.readFile(imageInput)).toString('base64') };
  }
}
