/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import * as fs from 'fs-extra';
import * as path from 'path';
import { encodePng, decodePng } from '../texture-processing';
import { decodeImageToRgba } from '../image-codec-ffmpeg';
import { GoogleMediaCredentialsService } from '../google-media-credentials-service';
import { IMAGE_MODEL_PRIORITY, SkippedMediaModel, describeModelUsed, resolveRequestedModels } from '../../common/media-generation-protocol';
import { MediaModelUnavailableError, MissingInputError } from '../../common/errors/pipeline-errors';
import { generateImageWithModels, withMediaFailureContext } from '../google-media-generation-service';
import {
    Google360PanoramaPipelineService,
    StreetViewCubeFace,
    StreetViewCubemapFaces,
    EquirectangularStructuredPrompt,
    buildEquirectangularStructuredPrompt
} from './Google360PanoramaPipelineService';

export { EquirectangularStructuredPrompt, buildEquirectangularStructuredPrompt };

export type PanoramaPerspective = 'front' | 'right' | 'back' | 'left' | 'top' | 'bottom';

export interface PerspectiveCameraConfig {
    name: PanoramaPerspective;
    yawDeg: number;       // front: 0, right: 90, back: 180, left: -90, top: 0, bottom: 0
    pitchDeg: number;     // front: 0, right: 0, back: 0, left: 0, top: 90, bottom: -90
    rollDeg: number;      // 0
    fovDeg: number;       // default 90.0
    aspectRatio: number;  // default 1.0 (square rectilinear perspective)
}

export interface PerspectiveFrame {
    perspective: PanoramaPerspective;
    width: number;
    height: number;
    rgba: Buffer;
    pngBuffer?: Buffer;
    isSynthesized: boolean; // false for original input perspective, true for generated perspectives
    prompt?: string;
    cameraConfig: PerspectiveCameraConfig;
    /** The image model that produced this view (absent for the input view, extracted views and mock views). */
    generatedBy?: string;
}

export interface MultiPerspectiveSynthesisOptions {
    inputImagePath?: string;
    inputImageBuffer?: Buffer;
    faceResolution?: number;                // default 512
    equirectangularWidth?: number;          // default 2048
    equirectangularHeight?: number;         // default 1024
    /** The views to generate around the input (default all five). A 360 stitch needs all five: a subset is refused. */
    synthesizePerspectives?: PanoramaPerspective[];
    styleHint?: string;                     // e.g. 'photorealistic urban streetscape at sunset'
    prompt?: string;                        // optional prompt context describing the environment
    locationName?: string;                  // optional landmark or location name
    model?: string;                         // when given, only this model is used; else IMAGE_MODEL_PRIORITY in order
    mockExecution?: boolean;                // tests only: copies of the input view, no model call (labelled as such)
    outputDir?: string;                     // directory to write individual perspective frames and stitched pano
    /** Stops the rig between views and during a view's model call: a stopped request bills no further views. */
    signal?: AbortSignal;
}

export interface MultiPerspectiveSynthesisResult {
    success: boolean;
    perspectives: Record<PanoramaPerspective, PerspectiveFrame>;
    stitchedEquirectangular: {
        width: number;
        height: number;
        rgba: Buffer;
        pngBuffer: Buffer;
        outputPath?: string;
    };
    cubemapFaces: StreetViewCubemapFaces;
    coverageAngleDegrees: {
        horizontal: number; // 360.0
        vertical: number;   // 180.0
    };
    perspectivesSynthesized: PanoramaPerspective[];
    modelUsed: string;
    /** Image models tried before the one that produced the views, with the reason (empty when the first answered). */
    skippedModels?: SkippedMediaModel[];
    /** Which model produced the views and, when it was not the requested one, why. */
    modelNote?: string;
    summary: string;
}

/** The views around the input, in the order a 360 rig needs them. */
export const SURROUNDING_PERSPECTIVES: readonly PanoramaPerspective[] = ['right', 'back', 'left', 'top', 'bottom'];

/**
 * The synthesized views and the image model that produced them. Only the input view and the views that were asked
 * for are present: a view that was not generated is absent, never filled with a procedural stand-in.
 */
export interface PerspectiveSynthesisOutcome {
    perspectives: Partial<Record<PanoramaPerspective, PerspectiveFrame>> & { front: PerspectiveFrame };
    modelUsed: string;
    skippedModels: SkippedMediaModel[];
    modelNote: string;
}

export class MultiPerspectivePanoramaSynthesisService {
    protected credentialsService: GoogleMediaCredentialsService;

    public static readonly CANONICAL_CAMERAS: Record<PanoramaPerspective, PerspectiveCameraConfig> = {
        front:  { name: 'front',  yawDeg: 0.0,   pitchDeg: 0.0,   rollDeg: 0.0, fovDeg: 90.0, aspectRatio: 1.0 },
        right:  { name: 'right',  yawDeg: 90.0,  pitchDeg: 0.0,   rollDeg: 0.0, fovDeg: 90.0, aspectRatio: 1.0 },
        back:   { name: 'back',   yawDeg: 180.0, pitchDeg: 0.0,   rollDeg: 0.0, fovDeg: 90.0, aspectRatio: 1.0 },
        left:   { name: 'left',   yawDeg: -90.0, pitchDeg: 0.0,   rollDeg: 0.0, fovDeg: 90.0, aspectRatio: 1.0 },
        top:    { name: 'top',    yawDeg: 0.0,   pitchDeg: 90.0,  rollDeg: 0.0, fovDeg: 90.0, aspectRatio: 1.0 },
        bottom: { name: 'bottom', yawDeg: 0.0,   pitchDeg: -90.0, rollDeg: 0.0, fovDeg: 90.0, aspectRatio: 1.0 }
    };

    constructor(credentialsService?: GoogleMediaCredentialsService) {
        this.credentialsService = credentialsService || new GoogleMediaCredentialsService();
    }

    /**
     * Extracts a rectilinear camera perspective from a 2:1 equirectangular panorama.
     */
    static extractPerspectiveFromEquirectangular(
        panoRgba: Buffer,
        panoWidth: number,
        panoHeight: number,
        camera: PerspectiveCameraConfig,
        outWidth = 512,
        outHeight = 512
    ): PerspectiveFrame {
        const outRgba = Buffer.alloc(outWidth * outHeight * 4);
        const yawRad = (camera.yawDeg * Math.PI) / 180.0;
        const pitchRad = (camera.pitchDeg * Math.PI) / 180.0;
        const rollRad = (camera.rollDeg * Math.PI) / 180.0;
        const fovRad = (camera.fovDeg * Math.PI) / 180.0;
        const halfFov = fovRad * 0.5;
        const tanHalfFov = Math.tan(halfFov);

        // Rotation matrix: R = R_yaw * R_pitch * R_roll
        const cy = Math.cos(yawRad), sy = Math.sin(yawRad);
        const cp = Math.cos(pitchRad), sp = Math.sin(pitchRad);
        const cr = Math.cos(rollRad), sr = Math.sin(rollRad);

        // Camera basis vectors in world space:
        const rX = cy * cr + sy * sp * sr;
        const rY = cp * sr;
        const rZ = -sy * cr + cy * sp * sr;

        const uX = -cy * sr + sy * sp * cr;
        const uY = cp * cr;
        const uZ = sy * sr + cy * sp * cr;

        const fX = sy * cp;
        const fY = -sp;
        const fZ = cy * cp;

        for (let py = 0; py < outHeight; py++) {
            const vNorm = 1.0 - 2.0 * ((py + 0.5) / outHeight); // [+1 at top, -1 at bottom]
            const rowOffset = py * outWidth * 4;

            for (let px = 0; px < outWidth; px++) {
                const uNorm = 2.0 * ((px + 0.5) / outWidth) - 1.0; // [-1 at left, +1 at right]

                // Direction in camera space: (uNorm * tanHalfFov, vNorm * tanHalfFov, 1.0)
                const cx = uNorm * tanHalfFov;
                const cy_ = vNorm * tanHalfFov;
                const cz = 1.0;

                // Transform to world ray
                const dx = rX * cx + uX * cy_ + fX * cz;
                const dy = rY * cx + uY * cy_ + fY * cz;
                const dz = rZ * cx + uZ * cy_ + fZ * cz;

                const { theta, phi } = Google360PanoramaPipelineService.cartesianToSpherical(dx, dy, dz);
                const uEq = (theta / (2.0 * Math.PI)) + 0.5;
                const vEq = 0.5 - (phi / Math.PI);

                const [r, g, b, a] = Google360PanoramaPipelineService.sampleEquirectangularBilinear(
                    panoRgba, panoWidth, panoHeight, uEq, vEq
                );

                const idx = rowOffset + px * 4;
                outRgba[idx] = r;
                outRgba[idx + 1] = g;
                outRgba[idx + 2] = b;
                outRgba[idx + 3] = a;
            }
        }

        return {
            perspective: camera.name,
            width: outWidth,
            height: outHeight,
            rgba: outRgba,
            pngBuffer: encodePng(outWidth, outHeight, outRgba),
            isSynthesized: false,
            cameraConfig: camera
        };
    }

    /**
     * Builds the specialized Nano Banana 2 conditioning prompt for generating a target
     * perspective camera plate from the initial front perspective image.
     */
    static buildNanoBananaPerspectivePrompt(
        perspective: PanoramaPerspective,
        options?: {
            locationName?: string;
            styleHint?: string;
            prompt?: string;
        }
    ): string {
        const sceneContext = options?.prompt || options?.styleHint || 'an authentic real-world streetscape environment';
        const locationStr = options?.locationName ? ` at ${options.locationName}` : '';

        switch (perspective) {
            case 'right':
                return `Generate the right lateral flank perspective (+90° yaw clockwise rotation) of ${sceneContext}${locationStr}, matching the provided front reference image. CRITICAL FRAMING & CONTINUITY RULES: (1) Output MUST be exactly 1:1 square aspect ratio rectilinear perspective (90° x 90° FoV). (2) The left boundary of this image connects seamlessly to the right boundary of the front reference image. (3) Strictly preserve the exact architectural style, facade heights, lighting vector, solar shadow angles, color temperature, and atmospheric perspective established in the front view. (4) Level horizon line at exactly 50% image height. (5) Crisp architectural edges, physical PBR material textures, no fish-eye distortion, clean photograph only with no overlays or text.`;

            case 'back':
                return `Generate the rear perspective looking directly backwards (180° yaw rotation) in ${sceneContext}${locationStr}, showing the opposing vista directly behind the camera vantage point of the front reference image. CRITICAL FRAMING & CONTINUITY RULES: (1) Output MUST be exactly 1:1 square aspect ratio rectilinear perspective (90° x 90° FoV). (2) Strictly maintain the identical environment, time of day, sky illumination, color temperature, ground surface materials, and architectural era. (3) Level horizon line at exactly 50% image height. (4) Natural streetscape/square continuation opposite the front view. Clean photograph only with no overlays, navigation UI, or text.`;

            case 'left':
                return `Generate the left lateral flank perspective (-90° yaw counter-clockwise rotation) of ${sceneContext}${locationStr}, matching the provided front reference image. CRITICAL FRAMING & CONTINUITY RULES: (1) Output MUST be exactly 1:1 square aspect ratio rectilinear perspective (90° x 90° FoV). (2) The right boundary of this image connects seamlessly to the left boundary of the front reference image. (3) Strictly preserve the exact architectural style, facade heights, lighting vector, solar shadow angles, color temperature, and atmospheric perspective established in the front view. (4) Level horizon line at exactly 50% image height. (5) Crisp architectural edges, physical PBR material textures, no fish-eye distortion, clean photograph only with no overlays or text.`;

            case 'top':
                return `Generate the celestial zenith perspective looking straight up (+90° vertical pitch) directly above the camera position of ${sceneContext}${locationStr}, matching the provided front reference image. CRITICAL FRAMING & CONTINUITY RULES: (1) Output MUST be exactly 1:1 square aspect ratio rectilinear perspective (90° x 90° FoV). (2) Camera pointing vertically upward into the sky dome, showing celestial illumination, clouds, atmospheric haze, and the upper rooftops/crowns/spires of buildings bordering the periphery. (3) The bottom boundary of this image welds seamlessly to the top boundary of the front reference image; left, right, and top edges align with left, right, and back perspectives respectively. (4) Photorealistic atmospheric scattering and natural zenith gradient. Clean photograph only with no overlays or text.`;

            case 'bottom':
                return `Generate the nadir ground perspective looking straight down (-90° vertical pitch) directly beneath the camera position of ${sceneContext}${locationStr}, matching the provided front reference image. CRITICAL FRAMING & CONTINUITY RULES: (1) Output MUST be exactly 1:1 square aspect ratio rectilinear perspective (90° x 90° FoV). (2) Camera pointing vertically downward toward the ground, showing authentic pavement, cobblestones, asphalt, road markings, drainage, or flooring materials matching the bottom edge of the front reference image. (3) Strictly zero tripod legs, zero camera rigs, zero equipment shadows, zero robotic artifacts (clean in-scene floor). (4) The top boundary of this image welds seamlessly to the bottom boundary of the front reference image; left, right, and bottom edges align with left, right, and back perspectives respectively. Clean photograph only with no overlays or text.`;

            case 'front':
            default:
                return `Authentic rectilinear front perspective photograph (90° x 90° FoV) of ${sceneContext}${locationStr}, featuring photorealistic materials, natural lighting, and architectural detail.`;
        }
    }

    /**
     * Welds the boundaries between a target perspective face and the front perspective
     * using smooth C0/C1 bilateral interpolation to guarantee seamless 360 cubemap stitching.
     */
    static weldPerspectiveBoundaries(
        perspective: PanoramaPerspective,
        targetRgba: Buffer,
        frontRgba: Buffer,
        res: number,
        weldWidth = 5
    ): void {
        if (perspective === 'right') {
            // Left border of right face welds to right border of front face
            for (let y = 0; y < res; y++) {
                const frontIdx = (y * res + (res - 1)) * 4;
                const frR = frontRgba[frontIdx], frG = frontRgba[frontIdx + 1], frB = frontRgba[frontIdx + 2];
                for (let x = 0; x < weldWidth; x++) {
                    const blend = Math.min(1.0, x / (weldWidth - 1));
                    const idx = (y * res + x) * 4;
                    targetRgba[idx] = Math.round(frR * (1 - blend) + targetRgba[idx] * blend);
                    targetRgba[idx + 1] = Math.round(frG * (1 - blend) + targetRgba[idx + 1] * blend);
                    targetRgba[idx + 2] = Math.round(frB * (1 - blend) + targetRgba[idx + 2] * blend);
                }
            }
        } else if (perspective === 'left') {
            // Right border of left face welds to left border of front face
            for (let y = 0; y < res; y++) {
                const frontIdx = y * res * 4;
                const frR = frontRgba[frontIdx], frG = frontRgba[frontIdx + 1], frB = frontRgba[frontIdx + 2];
                for (let i = 0; i < weldWidth; i++) {
                    const x = res - 1 - i;
                    const blend = Math.min(1.0, i / (weldWidth - 1));
                    const idx = (y * res + x) * 4;
                    targetRgba[idx] = Math.round(frR * (1 - blend) + targetRgba[idx] * blend);
                    targetRgba[idx + 1] = Math.round(frG * (1 - blend) + targetRgba[idx + 1] * blend);
                    targetRgba[idx + 2] = Math.round(frB * (1 - blend) + targetRgba[idx + 2] * blend);
                }
            }
        } else if (perspective === 'top') {
            // Bottom border of top face welds to top border of front face
            for (let x = 0; x < res; x++) {
                const frontIdx = x * 4;
                const frR = frontRgba[frontIdx], frG = frontRgba[frontIdx + 1], frB = frontRgba[frontIdx + 2];
                for (let i = 0; i < weldWidth; i++) {
                    const y = res - 1 - i;
                    const blend = Math.min(1.0, i / (weldWidth - 1));
                    const idx = (y * res + x) * 4;
                    targetRgba[idx] = Math.round(frR * (1 - blend) + targetRgba[idx] * blend);
                    targetRgba[idx + 1] = Math.round(frG * (1 - blend) + targetRgba[idx + 1] * blend);
                    targetRgba[idx + 2] = Math.round(frB * (1 - blend) + targetRgba[idx + 2] * blend);
                }
            }
        } else if (perspective === 'bottom') {
            // Top border of bottom face welds to bottom border of front face
            for (let x = 0; x < res; x++) {
                const frontIdx = ((res - 1) * res + x) * 4;
                const frR = frontRgba[frontIdx], frG = frontRgba[frontIdx + 1], frB = frontRgba[frontIdx + 2];
                for (let y = 0; y < weldWidth; y++) {
                    const blend = Math.min(1.0, y / (weldWidth - 1));
                    const idx = (y * res + x) * 4;
                    targetRgba[idx] = Math.round(frR * (1 - blend) + targetRgba[idx] * blend);
                    targetRgba[idx + 1] = Math.round(frG * (1 - blend) + targetRgba[idx + 1] * blend);
                    targetRgba[idx + 2] = Math.round(frB * (1 - blend) + targetRgba[idx + 2] * blend);
                }
            }
        }
    }

    /**
     * Resamples an RGBA buffer to target dimensions using nearest/bilinear interpolation.
     */
    static resampleRgba(srcRgba: Buffer, srcW: number, srcH: number, dstW: number, dstH: number): Buffer {
        if (srcW === dstW && srcH === dstH) {
            return Buffer.from(srcRgba);
        }
        const dst = Buffer.alloc(dstW * dstH * 4);
        const scaleX = srcW / dstW;
        const scaleY = srcH / dstH;
        for (let dy = 0; dy < dstH; dy++) {
            const sy = Math.min(srcH - 1, Math.floor(dy * scaleY));
            const dstRow = dy * dstW * 4;
            const srcRow = sy * srcW * 4;
            for (let dx = 0; dx < dstW; dx++) {
                const sx = Math.min(srcW - 1, Math.floor(dx * scaleX));
                const dstIdx = dstRow + dx * 4;
                const srcIdx = srcRow + sx * 4;
                dst[dstIdx] = srcRgba[srcIdx];
                dst[dstIdx + 1] = srcRgba[srcIdx + 1];
                dst[dstIdx + 2] = srcRgba[srcIdx + 2];
                dst[dstIdx + 3] = srcRgba[srcIdx + 3];
            }
        }
        return dst;
    }

    /**
     * Stitches 6 rectilinear perspective frames into a full 360 equirectangular panorama.
     */
    static stitchPerspectivesToEquirectangular(
        perspectives: Record<PanoramaPerspective, PerspectiveFrame>,
        outWidth = 2048,
        outHeight = 1024,
        useEac = true
    ): {
        panoRgba: Buffer;
        pngBuffer: Buffer;
        cubemapFaces: StreetViewCubemapFaces;
    } {
        const faceRes = perspectives.front.width;
        const cubemapFaces: StreetViewCubemapFaces = {
            front: perspectives.front.rgba,
            right: perspectives.right.rgba,
            back: perspectives.back.rgba,
            left: perspectives.left.rgba,
            top: perspectives.top.rgba,
            bottom: perspectives.bottom.rgba,
            faceResolution: faceRes,
            useEac
        };

        // Project cubemap back to 2:1 equirectangular
        let panoRgba = Google360PanoramaPipelineService.streetViewCubemapToEquirectangular(
            cubemapFaces,
            outWidth,
            outHeight,
            useEac
        );

        // Apply Google Street View / Photo Sphere polar cap smoothing
        panoRgba = Google360PanoramaPipelineService.applyStreetViewPolarCaps(
            panoRgba,
            outWidth,
            outHeight,
            { zenithRatio: 0.12, nadirRatio: 0.12, smoothExponent: 2.0 }
        );

        // Apply seamless toroidal seam healing at x = 0 <-> x = W - 1
        panoRgba = Google360PanoramaPipelineService.proceduralSeamHeal(
            panoRgba,
            outWidth,
            outHeight,
            Math.round(outWidth * 0.08)
        );

        return {
            panoRgba,
            pngBuffer: encodePng(outWidth, outHeight, panoRgba),
            cubemapFaces
        };
    }

    /**
     * Synthesizes the 5 missing perspective views (right, back, left, top, bottom)
     * conditioned on the initial front image using Nano Banana 2 (or Google GenAI).
     * The models tried are exactly `options.model` when given, else IMAGE_MODEL_PRIORITY; the first model that
     * answers produces every view (one model per rig keeps the views consistent), and the outcome says which model
     * that was and why any earlier one was skipped. Throws MediaModelUnavailableError when there are no
     * credentials or no model produces a view; only mockExecution (tests) returns copies of the input view.
     */
    async synthesizePerspectivesWithNanoBanana(
        frontRgba: Buffer,
        res = 512,
        options?: {
            model?: string;
            prompt?: string;
            styleHint?: string;
            locationName?: string;
            mockExecution?: boolean;
            perspectivesToGenerate?: PanoramaPerspective[];
            signal?: AbortSignal;
        }
    ): Promise<PerspectiveSynthesisOutcome> {
        let models = resolveRequestedModels(options?.model, IMAGE_MODEL_PRIORITY);
        let skippedModels: SkippedMediaModel[] = [];
        let modelUsed: string | undefined;
        const targetPerspectives: PanoramaPerspective[] = options?.perspectivesToGenerate || [...SURROUNDING_PERSPECTIVES];

        const frontPng = encodePng(res, res, frontRgba);
        const frontFrame: PerspectiveFrame = {
            perspective: 'front',
            width: res,
            height: res,
            rgba: frontRgba,
            pngBuffer: frontPng,
            isSynthesized: false,
            prompt: MultiPerspectivePanoramaSynthesisService.buildNanoBananaPerspectivePrompt('front', options),
            cameraConfig: MultiPerspectivePanoramaSynthesisService.CANONICAL_CAMERAS.front
        };

        // Only the input view and the views generated below: nothing stands in for a view that was not asked for.
        const result: PerspectiveSynthesisOutcome['perspectives'] = { front: frontFrame };

        const frontBase64 = frontPng.toString('base64');

        let client: any = null;
        if (!options?.mockExecution) {
            try {
                client = await this.credentialsService.createClient();
            } catch (err: any) {
                throw new MediaModelUnavailableError(models[0], `Google media credentials are not available (${err?.message || err})`);
            }
        }

        for (const p of targetPerspectives) {
            if (p === 'front') continue;
            if (options?.signal?.aborted) {
                throw Object.assign(new Error(`Stopped before the ${p} perspective`), { name: 'AbortError' });
            }

            const prompt = MultiPerspectivePanoramaSynthesisService.buildNanoBananaPerspectivePrompt(p, options);
            let targetRgba: Buffer;
            let generatedBy: string | undefined;

            if (client) {
                // Moves on only past models that are not served (each recorded with its reason); any other
                // failure ends the run with the model and perspective named.
                let answer;
                try {
                    answer = await generateImageWithModels(client, {
                        models,
                        contents: [
                            { text: prompt },
                            { inlineData: { data: frontBase64, mimeType: 'image/png' } }
                        ],
                        imageConfig: { aspectRatio: '1:1' },
                        signal: options?.signal
                    });
                } catch (err) {
                    // Model failures gain the perspective name; any other error propagates as it is.
                    throw withMediaFailureContext(err, `on the ${p} perspective`);
                }
                if (!modelUsed) {
                    // The first view decides the model: the rest of the rig is asked of that model only.
                    modelUsed = answer.modelUsed;
                    skippedModels = answer.skippedModels;
                    models = [answer.modelUsed];
                }
                let dec;
                try {
                    dec = await decodeImageToRgba(answer.data);
                } catch (err: any) {
                    throw new MediaModelUnavailableError(answer.modelUsed, `the ${p} perspective image could not be decoded (${err?.message || err})`);
                }
                targetRgba = MultiPerspectivePanoramaSynthesisService.resampleRgba(dec.rgba, dec.width, dec.height, res, res);
                generatedBy = answer.modelUsed;
            } else {
                // mockExecution (tests only): a plain copy of the input view, not model output
                targetRgba = Buffer.from(frontRgba);
            }

            // Weld adjacent boundaries with front plate to guarantee zero seam tears
            MultiPerspectivePanoramaSynthesisService.weldPerspectiveBoundaries(p, targetRgba, frontRgba, res);

            result[p] = {
                perspective: p,
                width: res,
                height: res,
                rgba: targetRgba,
                pngBuffer: encodePng(res, res, targetRgba),
                isSynthesized: true,
                prompt,
                cameraConfig: MultiPerspectivePanoramaSynthesisService.CANONICAL_CAMERAS[p],
                generatedBy
            };
        }

        if (!client) {
            return {
                perspectives: result,
                modelUsed: `${models[0]} mock: copies of the input view, no model call`,
                skippedModels: [],
                modelNote: 'Mock run: copies of the input view, no model call.'
            };
        }
        const used = modelUsed || models[0];
        return { perspectives: result, modelUsed: used, skippedModels, modelNote: describeModelUsed(used, skippedModels) };
    }

    /**
     * Orchestrates end-to-end multi-perspective generation and 360 equirectangular stitching.
     */
    async generate360Perspectives(
        options: MultiPerspectiveSynthesisOptions
    ): Promise<MultiPerspectiveSynthesisResult> {
        let inputRgba: Buffer;
        let inWidth: number;
        let inHeight: number;

        if (options.inputImageBuffer) {
            const dec = decodePng(options.inputImageBuffer);
            inputRgba = dec.rgba;
            inWidth = dec.width;
            inHeight = dec.height;
        } else if (options.inputImagePath) {
            const buf = await fs.readFile(options.inputImagePath);
            const dec = decodePng(buf);
            inputRgba = dec.rgba;
            inWidth = dec.width;
            inHeight = dec.height;
        } else {
            throw new Error('generate360Perspectives: Either "inputImagePath" or "inputImageBuffer" must be provided.');
        }

        const faceRes = options.faceResolution || 512;
        const panoW = options.equirectangularWidth || 2048;
        const panoH = options.equirectangularHeight || 1024;
        if (options.synthesizePerspectives) {
            const missing = SURROUNDING_PERSPECTIVES.filter(p => !options.synthesizePerspectives!.includes(p));
            if (missing.length) {
                throw new MissingInputError('panorama_generate_perspectives', 'synthesizePerspectives',
                    `a 360 stitch needs all of ${SURROUNDING_PERSPECTIVES.join(', ')}; ${missing.join(', ')} would be missing and no view is filled in procedurally`);
            }
        }

        let perspectives: Record<PanoramaPerspective, PerspectiveFrame>;
        let perspectivesSynthesized: PanoramaPerspective[];
        let modelUsed: string;
        let skippedModels: SkippedMediaModel[] | undefined;
        let modelNote: string | undefined;

        const ar = inWidth / inHeight;
        if (ar >= 1.85 && ar <= 2.15) {
            perspectives = {
                front: MultiPerspectivePanoramaSynthesisService.extractPerspectiveFromEquirectangular(
                    inputRgba, inWidth, inHeight, MultiPerspectivePanoramaSynthesisService.CANONICAL_CAMERAS.front, faceRes, faceRes
                ),
                right: MultiPerspectivePanoramaSynthesisService.extractPerspectiveFromEquirectangular(
                    inputRgba, inWidth, inHeight, MultiPerspectivePanoramaSynthesisService.CANONICAL_CAMERAS.right, faceRes, faceRes
                ),
                back: MultiPerspectivePanoramaSynthesisService.extractPerspectiveFromEquirectangular(
                    inputRgba, inWidth, inHeight, MultiPerspectivePanoramaSynthesisService.CANONICAL_CAMERAS.back, faceRes, faceRes
                ),
                left: MultiPerspectivePanoramaSynthesisService.extractPerspectiveFromEquirectangular(
                    inputRgba, inWidth, inHeight, MultiPerspectivePanoramaSynthesisService.CANONICAL_CAMERAS.left, faceRes, faceRes
                ),
                top: MultiPerspectivePanoramaSynthesisService.extractPerspectiveFromEquirectangular(
                    inputRgba, inWidth, inHeight, MultiPerspectivePanoramaSynthesisService.CANONICAL_CAMERAS.top, faceRes, faceRes
                ),
                bottom: MultiPerspectivePanoramaSynthesisService.extractPerspectiveFromEquirectangular(
                    inputRgba, inWidth, inHeight, MultiPerspectivePanoramaSynthesisService.CANONICAL_CAMERAS.bottom, faceRes, faceRes
                )
            };
            perspectivesSynthesized = [];
            modelUsed = 'Equirectangular Camera Extractor (EAC Bilinear Backward Ray)';
            modelNote = 'All six views were extracted from the input panorama; no model call.';
        } else {
            const frontRgba = Buffer.alloc(faceRes * faceRes * 4);
            const scaleX = inWidth / faceRes;
            const scaleY = inHeight / faceRes;

            for (let py = 0; py < faceRes; py++) {
                const srcY = Math.min(inHeight - 1, Math.floor(py * scaleY));
                const rowOffset = py * faceRes * 4;
                const srcRowOffset = srcY * inWidth * 4;

                for (let px = 0; px < faceRes; px++) {
                    const srcX = Math.min(inWidth - 1, Math.floor(px * scaleX));
                    const dstIdx = rowOffset + px * 4;
                    const srcIdx = srcRowOffset + srcX * 4;

                    frontRgba[dstIdx] = inputRgba[srcIdx];
                    frontRgba[dstIdx + 1] = inputRgba[srcIdx + 1];
                    frontRgba[dstIdx + 2] = inputRgba[srcIdx + 2];
                    frontRgba[dstIdx + 3] = inputRgba[srcIdx + 3] || 255;
                }
            }

            const outcome = await this.synthesizePerspectivesWithNanoBanana(
                frontRgba,
                faceRes,
                {
                    model: options.model,
                    prompt: options.prompt,
                    styleHint: options.styleHint,
                    locationName: options.locationName,
                    mockExecution: options.mockExecution,
                    perspectivesToGenerate: options.synthesizePerspectives,
                    signal: options.signal
                }
            );
            const missing = SURROUNDING_PERSPECTIVES.filter(p => !outcome.perspectives[p]);
            if (missing.length) {
                throw new MediaModelUnavailableError(outcome.modelUsed, `no ${missing.join(', ')} view was generated, so there is nothing to stitch there`);
            }
            perspectives = outcome.perspectives as Record<PanoramaPerspective, PerspectiveFrame>;
            perspectivesSynthesized = [...SURROUNDING_PERSPECTIVES];
            modelUsed = outcome.modelUsed;
            skippedModels = outcome.skippedModels;
            modelNote = outcome.modelNote;
        }

        const stitched = MultiPerspectivePanoramaSynthesisService.stitchPerspectivesToEquirectangular(
            perspectives,
            panoW,
            panoH,
            true
        );

        let stitchedOutputPath: string | undefined;
        if (options.outputDir) {
            await fs.ensureDir(options.outputDir);
            for (const key of Object.keys(perspectives) as PanoramaPerspective[]) {
                const frame = perspectives[key];
                if (frame.pngBuffer) {
                    await fs.writeFile(path.join(options.outputDir, `perspective_${key}.png`), frame.pngBuffer);
                }
            }
            stitchedOutputPath = path.join(options.outputDir, 'stitched_360_equirectangular.png');
            await fs.writeFile(stitchedOutputPath, stitched.pngBuffer);
        }

        return {
            success: true,
            perspectives,
            stitchedEquirectangular: {
                width: panoW,
                height: panoH,
                rgba: stitched.panoRgba,
                pngBuffer: stitched.pngBuffer,
                outputPath: stitchedOutputPath
            },
            cubemapFaces: stitched.cubemapFaces,
            coverageAngleDegrees: {
                horizontal: 360.0,
                vertical: 180.0
            },
            perspectivesSynthesized,
            modelUsed,
            skippedModels,
            modelNote,
            summary: `Generated a 6-camera rectilinear perspective rig and stitched a 360 equirectangular panorama (${panoW}x${panoH}, coverage: 360°x180°, perspectives via ${modelUsed}).${modelNote ? ` ${modelNote}` : ''}`
        };
    }
}

export async function generate360Perspectives(
    options: MultiPerspectiveSynthesisOptions
): Promise<MultiPerspectiveSynthesisResult> {
    const service = new MultiPerspectivePanoramaSynthesisService();
    return service.generate360Perspectives(options);
}
