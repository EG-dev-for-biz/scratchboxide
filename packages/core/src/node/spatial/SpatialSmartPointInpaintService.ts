/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import { HeadlessMeshSilhouetteRenderer, RenderMesh3D } from './HeadlessMeshSilhouetteRenderer';
import { CameraPose6DOF } from './SubPixelEdgeAlignmentOptimizer';
import { encodePng, resampleRgba } from '../texture-processing';
import { GeminiClient } from '../gemini/gemini-client';
import { decodeImageToRgba } from '../image-codec-ffmpeg';
import { generateImageWithModels } from '../google-media-generation-service';
import { IMAGE_MODEL_ASPECT_RATIOS, IMAGE_MODEL_PRIORITY, nearestImageAspectRatio, resolveRequestedModels, type SkippedMediaModel } from '../../common/media-generation-protocol';
import { MediaModelUnavailableError, MissingInputError } from '../../common/errors/pipeline-errors';
import { MODEL_ANSWER_ASPECT_TOLERANCE, ModelAnswerResolutionError } from './Google360PanoramaPipelineService';

export interface SmartPointInpaintResult {
    x: number;
    y: number;
    mask: Buffer; // PNG encoded feathered mask
    /** Distance of the point from the camera along the view direction, in scene units. */
    depth: number;
    /** Depth of the mesh surface at the projected pixel (undefined when no surface covers it). */
    surfaceDepth?: number;
    /** Pixels the mask edits (any weight above zero). */
    maskedPixels: number;
}

/** The renderer's near plane: a point nearer than this along the view direction is not in the image. */
const NEAR_PLANE = 0.5;

export interface SpatialSmartPointInpaintServiceOptions {
    client?: any; // Google GenAI client
}

export class SpatialSmartPointInpaintService {
    private client: any;

    constructor(options?: SpatialSmartPointInpaintServiceOptions) {
        this.client = options?.client;
    }

    private async getClient() {
        if (this.client) return this.client;
        const gemini = new GeminiClient();
        this.client = await gemini.getGenAIClient();
        if (!this.client) {
            throw new Error('SpatialSmartPointInpaintService: Failed to resolve Gemini GenAI Client (missing credentials or API key).');
        }
        return this.client;
    }

    /**
     * Projects a 3D world coordinate (smart point) into a width x height image taken with the camera pose, checks that
     * the image really shows it, and builds a feathered radial PNG mask centred on it. The point must be in front of
     * the camera, project inside the image, and not be hidden behind the mesh (the mesh's depth at that pixel is
     * rendered and compared); otherwise MissingInputError is thrown, before any model is asked to edit the wrong
     * pixels.
     */
    public projectSmartPointToMask(
        mesh: RenderMesh3D,
        pose: CameraPose6DOF,
        smartPoint: [number, number, number],
        radiusPx: number = 20,
        width: number = 640,
        height: number = 480
    ): SmartPointInpaintResult {
        const tool = 'spatial_smart_point_inpaint';
        if (!Array.isArray(smartPoint) || smartPoint.length !== 3 || !smartPoint.every(v => Number.isFinite(v))) {
            throw new MissingInputError(tool, 'smartPoint', `an [x, y, z] point is required (got ${JSON.stringify(smartPoint)})`);
        }
        if (!(radiusPx > 0)) throw new MissingInputError(tool, 'radiusPx', `a positive pixel radius is required (got ${radiusPx})`);
        if (!(pose?.fov > 0 && pose.fov < 180)) throw new MissingInputError(tool, 'pose.fov', `a vertical field of view between 0 and 180 degrees is required (got ${pose?.fov})`);

        // Camera frame, as the renderer builds it: +X right, +Y up, looking from the eye to the target.
        const eye: [number, number, number] = [pose.x, pose.y, pose.z];
        const up: [number, number, number] = pose.up ?? [0, 1, 0];
        let fwd: [number, number, number] = [pose.targetX - pose.x, pose.targetY - pose.y, pose.targetZ - pose.z];
        const fLen = Math.hypot(...fwd);
        if (!(fLen > 1e-9)) throw new MissingInputError(tool, 'pose', 'the camera position equals its target, so it has no view direction');
        fwd = [fwd[0] / fLen, fwd[1] / fLen, fwd[2] / fLen];
        let right: [number, number, number] = [fwd[1] * up[2] - fwd[2] * up[1], fwd[2] * up[0] - fwd[0] * up[2], fwd[0] * up[1] - fwd[1] * up[0]];
        const rLen = Math.hypot(...right);
        if (!(rLen > 1e-9)) throw new MissingInputError(tool, 'pose.up', 'the up vector is parallel to the view direction, so the image has no orientation');
        right = [right[0] / rLen, right[1] / rLen, right[2] / rLen];
        const camUp: [number, number, number] = [right[1] * fwd[2] - right[2] * fwd[1], right[2] * fwd[0] - right[0] * fwd[2], right[0] * fwd[1] - right[1] * fwd[0]];

        const rel = [smartPoint[0] - eye[0], smartPoint[1] - eye[1], smartPoint[2] - eye[2]];
        const depth = rel[0] * fwd[0] + rel[1] * fwd[1] + rel[2] * fwd[2];
        if (!(depth > NEAR_PLANE)) {
            throw new MissingInputError(tool, 'smartPoint', `[${smartPoint.join(', ')}] is ${depth.toFixed(3)} along the view direction: behind the camera (or nearer than its ${NEAR_PLANE} near plane), so the image does not show it`);
        }
        const tanHalf = Math.tan((pose.fov * Math.PI) / 360);
        const ndcX = (rel[0] * right[0] + rel[1] * right[1] + rel[2] * right[2]) / (depth * tanHalf * (width / height));
        const ndcY = (rel[0] * camUp[0] + rel[1] * camUp[1] + rel[2] * camUp[2]) / (depth * tanHalf);
        const screenX = (ndcX * 0.5 + 0.5) * width;
        const screenY = (1.0 - (ndcY * 0.5 + 0.5)) * height;
        if (!(screenX >= 0 && screenX < width && screenY >= 0 && screenY < height)) {
            throw new MissingInputError(tool, 'smartPoint', `[${smartPoint.join(', ')}] projects to (${screenX.toFixed(1)}, ${screenY.toFixed(1)}), outside the ${width}x${height} image`);
        }

        // Occlusion: the mesh's nearest surface around the projected pixel. The point is hidden when every surface
        // there lies in front of it by more than a small depth tolerance (1% of its distance).
        const { depthBuffer } = HeadlessMeshSilhouetteRenderer.renderMesh(mesh, pose, width, height, { clipNearPlane: true });
        const px = Math.floor(screenX), py = Math.floor(screenY);
        const tolerance = Math.max(depth * 0.01, 1e-3);
        let surfaceDepth: number | undefined;
        let visible = false;
        for (let dy = -1; dy <= 1; dy++) {
            for (let dx = -1; dx <= 1; dx++) {
                const x = px + dx, y = py + dy;
                if (x < 0 || y < 0 || x >= width || y >= height) continue;
                const d = depthBuffer[y * width + x];
                if (d >= 1e9) { visible = true; continue; }
                if (dx === 0 && dy === 0) surfaceDepth = d;
                if (d >= depth - tolerance) visible = true;
            }
        }
        if (!visible) {
            throw new MissingInputError(tool, 'smartPoint', `[${smartPoint.join(', ')}] is ${depth.toFixed(3)} from the camera, but the mesh surface at its pixel (${screenX.toFixed(1)}, ${screenY.toFixed(1)}) is ${(surfaceDepth ?? NaN).toFixed(3)} away: the point is hidden behind it, so an edit there would paint the occluder`);
        }

        // Feathered radial mask
        const maskRgba = Buffer.alloc(width * height * 4);
        let maskedPixels = 0;
        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
                const idx = (y * width + x) * 4;
                const dist = Math.hypot(x - screenX, y - screenY);
                let grayscale = 0;
                if (dist <= radiusPx * 0.5) {
                    grayscale = 255;
                } else if (dist <= radiusPx) {
                    const t = (dist - radiusPx * 0.5) / (radiusPx * 0.5);
                    grayscale = Math.round(255 * (0.5 + 0.5 * Math.cos(t * Math.PI)));
                }
                if (grayscale > 0) maskedPixels++;
                maskRgba[idx] = grayscale;
                maskRgba[idx + 1] = grayscale;
                maskRgba[idx + 2] = grayscale;
                maskRgba[idx + 3] = 255;
            }
        }

        return {
            x: screenX,
            y: screenY,
            mask: encodePng(width, height, maskRgba),
            depth,
            surfaceDepth,
            maskedPixels
        };
    }

    /**
     * Inpaints the masked region of an image with an image model (the requested one, or IMAGE_MODEL_PRIORITY in order,
     * moving on only past models that are not served; the result says which answered and why any was skipped). The
     * request asks for the image's own aspect ratio; an image whose ratio the models do not accept is refused, and an
     * answer at another ratio is refused rather than stretched (the inpainted pixels would no longer line up with the
     * projected point). The answer is resampled to the image's size and blended through the mask, so pixels outside
     * the mask are the input's own.
     */
    public async executeSpatialInpaint(request: {
        image: Buffer;
        mask: Buffer;
        prompt: string;
        model?: string;
        signal?: AbortSignal;
    }): Promise<{ image: Buffer; mimeType: string; width: number; height: number; modelUsed: string; modelNote: string; skippedModels?: SkippedMediaModel[]; answerWidth: number; answerHeight: number }> {
        const base = await decodeImageToRgba(request.image);
        const mask = await decodeImageToRgba(request.mask);
        if (mask.width !== base.width || mask.height !== base.height) {
            throw new MissingInputError('spatial_smart_point_inpaint', 'mask', `the mask is ${mask.width}x${mask.height} but the image is ${base.width}x${base.height}`);
        }
        const aspectRatio = nearestImageAspectRatio(base.width, base.height);
        const asked = IMAGE_MODEL_ASPECT_RATIOS.find(([label]) => label === aspectRatio)![1];
        const own = base.width / base.height;
        if (Math.abs(own - asked) / asked > MODEL_ANSWER_ASPECT_TOLERANCE) {
            throw new MissingInputError('spatial_smart_point_inpaint', 'imagePath',
                `a ${base.width}x${base.height} image (${own.toFixed(3)}:1) has no aspect ratio the image models accept (nearest ${aspectRatio}); the answer would be re-framed and the edit would not line up`);
        }
        const client = await this.getClient();
        const answer = await generateImageWithModels(client, {
            models: resolveRequestedModels(request.model, IMAGE_MODEL_PRIORITY),
            contents: [
                { inlineData: { mimeType: 'image/png', data: encodePng(base.width, base.height, base.rgba).toString('base64') } },
                { inlineData: { mimeType: 'image/png', data: request.mask.toString('base64') } },
                { text: `${request.prompt} Edit only the white region of the mask (the second image); answer with the whole image at exactly the same framing and ${aspectRatio} aspect ratio.` }
            ],
            imageConfig: { aspectRatio },
            signal: request.signal
        });
        let decoded: { rgba: Buffer; width: number; height: number };
        try {
            decoded = await decodeImageToRgba(answer.data);
        } catch (err: any) {
            throw new MediaModelUnavailableError(answer.modelUsed, `the returned image could not be decoded (${err?.message || err})`);
        }
        const answered = decoded.width / decoded.height;
        if (Math.abs(answered - asked) / asked > MODEL_ANSWER_ASPECT_TOLERANCE) {
            throw new ModelAnswerResolutionError(false,
                `${answer.modelUsed} was asked for a ${aspectRatio} image and answered ${decoded.width}x${decoded.height} (${answered.toFixed(3)}:1); the inpainted region would not line up with the smart point`);
        }
        const edited = decoded.width === base.width && decoded.height === base.height
            ? decoded.rgba
            : resampleRgba(decoded.rgba, decoded.width, decoded.height, base.width, base.height);
        const out = Buffer.from(base.rgba);
        for (let i = 0; i < out.length; i += 4) {
            const m = mask.rgba[i] / 255;
            if (m <= 0) continue;
            for (let k = 0; k < 3; k++) out[i + k] = Math.round(base.rgba[i + k] * (1 - m) + edited[i + k] * m);
        }
        return {
            image: encodePng(base.width, base.height, out),
            mimeType: 'image/png',
            width: base.width,
            height: base.height,
            modelUsed: answer.modelUsed,
            modelNote: answer.modelNote,
            skippedModels: answer.skippedModels,
            answerWidth: decoded.width,
            answerHeight: decoded.height
        };
    }
}
