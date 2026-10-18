/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import * as fs from 'fs-extra';
import { GeminiClient } from '../gemini/gemini-client';
import { decodeImageToRgba, encodeRgbaToJpeg, readImageDimensions, sniffImageFormat } from '../image-codec-ffmpeg';
import { resampleRgba } from '../texture-processing';
import {
    SceneDepthAnnotation,
    SceneDepthPart,
    EnrichedDepthAnnotation,
    EnrichedSceneDepthPart,
    DepthMapSynthesisOptions,
    DenseDepthMapResult,
    SceneDepthRequest,
    SceneDepthResponse
} from '../../common/scene-depth-protocol';

export interface GeminiSceneDepthServiceOptions {
    geminiClient?: GeminiClient;
    defaultFovDegrees?: number;
    defaultAspectRatio?: number;
    defaultSceneWidthUnits?: number;
}

export class GeminiSceneDepthService {
    private geminiClient: GeminiClient;
    private defaultFovDegrees: number;
    private defaultAspectRatio: number;
    private defaultSceneWidthUnits: number;

    constructor(options?: GeminiSceneDepthServiceOptions) {
        this.geminiClient = options?.geminiClient ?? new GeminiClient();
        this.defaultFovDegrees = options?.defaultFovDegrees ?? 50;
        this.defaultAspectRatio = options?.defaultAspectRatio ?? 1.777778; // 16:9
        this.defaultSceneWidthUnits = options?.defaultSceneWidthUnits ?? 6.0;
    }

    /**
     * Builds the specialized Gemini system prompt instructing the model to act as a
     * precision photogrammetric and monocular depth analyst.
     */
    public buildDepthSystemPrompt(): string {
        return `You are a precision photogrammetric depth analyst specializing in 3D scene reconstruction and visual depth perception.
Your task is to analyze the input image and output a strict JSON depth map annotation estimating metric Z positions for every major element, layer, and object in the scene.

### 3D Coordinate & Camera Conventions
- The reference 3D camera sits at Z = +5.0 looking toward the origin (0, 0, 0) along the -Z axis (standard Three.js right-handed coordinate system).
- Foreground / Near elements (close to the camera): Z between +1.0 and +4.0
- Midground / Center-stage elements (the main subject, ground center): Z between -0.5 and +0.5
- Background elements (walls, distant buildings, trees, mountains): Z between -1.0 and -10.0
- Sky / Deep Horizon / Infinity: Z between -20.0 and -50.0

### Monocular Depth Cues to Evaluate
1. **Occlusion Boundaries**: Any object occluding another MUST have a strictly greater Z value.
2. **Contact Shadows & Ground Plane**: Objects resting on the floor or ground recede further into negative Z as their contact line moves higher in the image.
3. **Linear Perspective**: Parallel lines converging to vanishing points indicate receding depth.
4. **Atmospheric Haze & Contrast**: Distant mountains or buildings exhibit lower contrast and blue airlight scattering.
5. **Known Scale Heuristics**: Human bodies (~1.7m), doorways (~2.1m), vehicles (~4.5m), and street furniture.

### Output JSON Format (Output raw JSON only, no markdown wrapping, no prose):
{
  "sceneType": "a short free-form description of the kind of scene",
  "parts": {
    "unique_part_id": {
      "label": "descriptive label",
      "z": 1.5,
      "imageX": 0.5,
      "imageY": 0.6,
      "width": 0.2,
      "height": 0.3,
      "reason": "monocular depth reasoning"
    }
  },
  "z_ranges": {
    "near": [1.0, 4.0],
    "mid": [-0.5, 0.5],
    "far": [-10.0, -1.0]
  }
}
Note: imageX and imageY are normalized coordinates [0.0 = left/top, 1.0 = right/bottom] representing the centroid of each part.`;
    }

    /**
     * Projects normalized 2D image coordinates (imageX, imageY) and metric depth (z)
     * into 3D world space (worldX, worldY, worldZ) under pinhole camera intrinsics.
     */
    public enrichDepthAnnotation(
        annotation: SceneDepthAnnotation,
        options?: { aspectRatio?: number; fovDegrees?: number; sceneWidthUnits?: number }
    ): EnrichedDepthAnnotation {
        const aspectRatio = options?.aspectRatio ?? this.defaultAspectRatio;
        const fovDegrees = options?.fovDegrees ?? this.defaultFovDegrees;
        const sceneWidth = options?.sceneWidthUnits ?? this.defaultSceneWidthUnits;
        const sceneHeight = sceneWidth / aspectRatio;

        const enrichedParts: Record<string, EnrichedSceneDepthPart> = {};

        for (const [key, part] of Object.entries(annotation.parts)) {
            // Unproject imageX/imageY from [0, 1] to centered world coordinates
            const worldX = (part.imageX - 0.5) * sceneWidth;
            const worldY = (0.5 - part.imageY) * sceneHeight;
            const worldZ = part.z;

            enrichedParts[key] = {
                ...part,
                worldX: Math.round(worldX * 1000) / 1000,
                worldY: Math.round(worldY * 1000) / 1000,
                worldZ: Math.round(worldZ * 1000) / 1000
            };
        }

        return {
            parts: enrichedParts,
            z_ranges: annotation.z_ranges,
            aspectRatio,
            cameraFovDegrees: fovDegrees,
            sceneWidthUnits: sceneWidth
        };
    }

    /**
     * Synthesizes a continuous 2D metric depth buffer (Float32Array) from semantic depth parts.
     * Maps each pixel (u, v) to a metric distance (in meters) from the camera plane at Z = +5.0.
     */
    public synthesizeMetricDepthBuffer(
        annotation: SceneDepthAnnotation,
        options: DepthMapSynthesisOptions
    ): DenseDepthMapResult {
        const width = Math.max(16, Math.floor(options.width));
        const height = Math.max(16, Math.floor(options.height));
        const nearDepth = options.nearDepth ?? 1.0;
        const farDepth = options.farDepth ?? 25.0;
        const horizonY = options.horizonY ?? 0.5;

        const buffer = new Float32Array(width * height);
        const partsList = Object.values(annotation.parts);

        // Reference camera sits at Z = +5.
        // Distance from camera = 5.0 - part.z.
        const partDistances = partsList.map(p => ({
            u: p.imageX,
            v: p.imageY,
            dist: Math.max(nearDepth, Math.min(farDepth, 5.0 - p.z)),
            radius: Math.max(p.width ?? 0.15, p.height ?? 0.15, 0.1)
        }));

        let globalMin = Infinity;
        let globalMax = -Infinity;

        for (let y = 0; y < height; y++) {
            const v = (y + 0.5) / height;

            // Base ground / atmospheric perspective ramp:
            // Below horizon (v > horizonY): floor extending toward foreground (closer distance).
            // Above horizon (v <= horizonY): sky / background (far distance).
            let baseDist: number;
            if (v >= horizonY) {
                const groundT = (v - horizonY) / Math.max(1.0 - horizonY, 0.001);
                // Non-linear perspective ramp from midground to near foreground
                baseDist = nearDepth + (farDepth * 0.4 - nearDepth) * Math.pow(1.0 - groundT, 1.8);
            } else {
                const skyT = v / Math.max(horizonY, 0.001);
                baseDist = farDepth * 0.6 + (farDepth - farDepth * 0.6) * (1.0 - skyT);
            }

            for (let x = 0; x < width; x++) {
                const u = (x + 0.5) / width;
                const idx = y * width + x;

                if (partDistances.length === 0) {
                    buffer[idx] = baseDist;
                    if (baseDist < globalMin) globalMin = baseDist;
                    if (baseDist > globalMax) globalMax = baseDist;
                    continue;
                }

                // Smooth Gaussian / Inverse-distance blend across known parts
                let weightSum = 0;
                let weightedDistSum = 0;

                for (const p of partDistances) {
                    const du = (u - p.u);
                    const dv = (v - p.v);
                    const distSq = du * du + dv * dv;
                    const rSq = p.radius * p.radius;

                    // Gaussian kernel influence
                    const weight = Math.exp(-distSq / (2.0 * rSq));
                    if (weight > 1e-4) {
                        weightSum += weight;
                        weightedDistSum += weight * p.dist;
                    }
                }

                let finalDist: number;
                if (weightSum > 1e-4) {
                    const partBlend = weightedDistSum / weightSum;
                    const alpha = Math.min(weightSum, 1.0);
                    finalDist = partBlend * alpha + baseDist * (1.0 - alpha);
                } else {
                    finalDist = baseDist;
                }

                finalDist = Math.max(nearDepth, Math.min(farDepth, finalDist));
                buffer[idx] = finalDist;

                if (finalDist < globalMin) globalMin = finalDist;
                if (finalDist > globalMax) globalMax = finalDist;
            }
        }

        return {
            width,
            height,
            metricDepths: buffer,
            minDepth: Math.round(globalMin * 100) / 100,
            maxDepth: Math.round(globalMax * 100) / 100
        };
    }

    /**
     * Executes scene depth analysis on an input image.
     * Throws SceneDepthError when the image cannot be read, the model call fails, or the model's answer is not a
     * usable depth annotation. Never substitutes a canned annotation.
     */
    public async analyzeSceneDepth(request: SceneDepthRequest): Promise<SceneDepthResponse> {
        const encoded = await this.readImageInput(request.image);
        const { data, mimeType } = await this.prepareImageForModel(encoded);

        let text: string;
        try {
            const response = await this.geminiClient.generateContent({
                systemInstruction: this.buildDepthSystemPrompt(),
                prompt: 'Analyze this image and generate the precision metric depth annotation JSON.',
                inlineData: [{ mimeType, data: data.toString('base64') }],
                temperature: 0.2
            });
            text = response.text?.trim() ?? '';
        } catch (err: any) {
            throw new SceneDepthError('MODEL_CALL_FAILED', `Gemini depth analysis call failed: ${err?.message ?? String(err)}`);
        }

        const annotation = parseDepthAnnotation(text);
        const enriched = this.enrichDepthAnnotation(annotation, {
            aspectRatio: request.aspectRatio ?? this.defaultAspectRatio,
            fovDegrees: request.fovDegrees ?? this.defaultFovDegrees
        });

        let depthMap: DenseDepthMapResult | undefined;
        if (request.generateDepthMap) {
            const res = request.depthMapResolution ?? { width: 128, height: 72 };
            depthMap = this.synthesizeMetricDepthBuffer(annotation, { width: res.width, height: res.height });
        }

        return {
            success: true,
            annotation,
            enriched,
            depthMap,
            explanation: `Gemini placed ${Object.keys(annotation.parts).length} scene parts in depth (model estimate, not a measured depth).`
        };
    }

    /** Resolves a path, data URL, base64 string or Buffer to the encoded image bytes. */
    private async readImageInput(image: SceneDepthRequest['image']): Promise<Buffer> {
        if (Buffer.isBuffer(image)) return image;
        if (typeof image !== 'string' || image.length === 0) {
            throw new SceneDepthError('IMAGE_UNREADABLE', 'image must be a file path, data URL, base64 string or Buffer.');
        }
        if (image.startsWith('data:')) {
            const comma = image.indexOf(',');
            if (comma === -1) throw new SceneDepthError('IMAGE_UNREADABLE', 'data URL has no payload.');
            return Buffer.from(image.slice(comma + 1), 'base64');
        }
        if (await fs.pathExists(image)) return fs.readFile(image);
        if (/^[A-Za-z0-9+/=\s]+$/.test(image) && image.length > 64) return Buffer.from(image, 'base64');
        throw new SceneDepthError('IMAGE_UNREADABLE', `Image file not found: ${image}`);
    }

    /**
     * Sniffs the real MIME type and downscales so the long edge is at most SCENE_DEPTH_MAX_EDGE_PX (re-encoded as JPEG).
     * Images already within the limit are sent unchanged with their own MIME type.
     */
    public async prepareImageForModel(encoded: Buffer): Promise<{ data: Buffer; mimeType: string; width: number; height: number }> {
        const format = sniffImageFormat(encoded);
        if (format === 'unknown') {
            throw new SceneDepthError('UNSUPPORTED_IMAGE_FORMAT', 'Image is not a JPEG, PNG or WebP (unrecognised header).');
        }
        const dims = readImageDimensions(encoded);
        if (!dims) throw new SceneDepthError('IMAGE_UNREADABLE', `Could not read the ${format} image dimensions from its header.`);
        const longEdge = Math.max(dims.width, dims.height);
        if (longEdge <= SCENE_DEPTH_MAX_EDGE_PX) {
            return { data: encoded, mimeType: `image/${format}`, width: dims.width, height: dims.height };
        }
        let img;
        try {
            img = await decodeImageToRgba(encoded);
        } catch (err: any) {
            throw new SceneDepthError('IMAGE_UNREADABLE', `Could not decode the ${format} image to downscale it: ${err?.message ?? err}`);
        }
        const scale = SCENE_DEPTH_MAX_EDGE_PX / longEdge;
        const dstW = Math.max(1, Math.round(img.width * scale));
        const dstH = Math.max(1, Math.round(img.height * scale));
        // Halve with 2x2 averaging (bilinear at exactly 0.5) while still over 2x the target, then one bilinear pass.
        let rgba: Buffer = img.rgba;
        let w = img.width;
        let h = img.height;
        while (w >= dstW * 2 && h >= dstH * 2) {
            const nw = Math.floor(w / 2);
            const nh = Math.floor(h / 2);
            rgba = resampleRgba(rgba, w, h, nw, nh);
            w = nw;
            h = nh;
        }
        rgba = resampleRgba(rgba, w, h, dstW, dstH);
        const data = await encodeRgbaToJpeg(rgba, dstW, dstH, { quality: 90 });
        return { data, mimeType: 'image/jpeg', width: dstW, height: dstH };
    }
}

/** Longest image edge sent to the model. */
export const SCENE_DEPTH_MAX_EDGE_PX = 1024;

/** Typed failure from GeminiSceneDepthService. `code`: IMAGE_UNREADABLE, UNSUPPORTED_IMAGE_FORMAT, MODEL_CALL_FAILED, MODEL_RESPONSE_INVALID. */
export class SceneDepthError extends Error {
    public override readonly name = 'SceneDepthError';
    constructor(public readonly code: string, message: string) {
        super(`[GeminiSceneDepthService] ${code}: ${message}`);
    }
}

function isFiniteNumber(v: unknown): v is number {
    return typeof v === 'number' && Number.isFinite(v);
}

/** Parses and validates the model's JSON answer; throws MODEL_RESPONSE_INVALID rather than guessing. */
export function parseDepthAnnotation(text: string): SceneDepthAnnotation {
    const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
    if (!cleaned) throw new SceneDepthError('MODEL_RESPONSE_INVALID', 'Gemini returned an empty response.');
    let parsed: any;
    try {
        parsed = JSON.parse(cleaned);
    } catch (err: any) {
        throw new SceneDepthError('MODEL_RESPONSE_INVALID', `Gemini response is not JSON (${err?.message}): ${cleaned.slice(0, 200)}`);
    }
    const parts = parsed?.parts;
    if (!parts || typeof parts !== 'object' || Array.isArray(parts) || Object.keys(parts).length === 0) {
        throw new SceneDepthError('MODEL_RESPONSE_INVALID', 'Gemini response has no "parts" object.');
    }
    for (const [key, part] of Object.entries<any>(parts)) {
        if (!part || !isFiniteNumber(part.z) || !isFiniteNumber(part.imageX) || !isFiniteNumber(part.imageY)) {
            throw new SceneDepthError('MODEL_RESPONSE_INVALID', `Part "${key}" lacks numeric z / imageX / imageY.`);
        }
    }
    return parsed as SceneDepthAnnotation;
}
