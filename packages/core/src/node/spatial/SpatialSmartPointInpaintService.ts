/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import { RenderMesh3D } from './HeadlessMeshSilhouetteRenderer';
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
}

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
     * Projects a 3D world coordinate (smart point) onto the screen using 6-DOF camera pose matrices,
     * and generates a high-quality feathered radial PNG mask centered at the projected point.
     */
    public projectSmartPointToMask(
        mesh: RenderMesh3D,
        pose: CameraPose6DOF,
        smartPoint: [number, number, number],
        radiusPx: number = 20,
        width: number = 640,
        height: number = 480
    ): SmartPointInpaintResult {
        // 1. Build View Matrix V
        const eye: [number, number, number] = [pose.x, pose.y, pose.z];
        const target: [number, number, number] = [pose.targetX, pose.targetY, pose.targetZ];
        const up: [number, number, number] = pose.up ?? [0, 1, 0];

        let fx = target[0] - eye[0];
        let fy = target[1] - eye[1];
        let fz = target[2] - eye[2];
        let fLen = Math.hypot(fx, fy, fz) || 1;
        fx /= fLen; fy /= fLen; fz /= fLen;

        let rx = fy * up[2] - fz * up[1];
        let ry = fz * up[0] - fx * up[2];
        let rz = fx * up[1] - fy * up[0];
        let rLen = Math.hypot(rx, ry, rz) || 1;
        rx /= rLen; ry /= rLen; rz /= rLen;

        const ux = ry * fz - rz * fy;
        const uy = rz * fx - rx * fz;
        const uz = rx * fy - ry * fx;

        const V = [
            rx, ux, -fx, 0,
            ry, uy, -fy, 0,
            rz, uz, -fz, 0,
            -(eye[0] * rx + eye[1] * ry + eye[2] * rz),
            -(eye[0] * ux + eye[1] * uy + eye[2] * uz),
            (eye[0] * fx + eye[1] * fy + eye[2] * fz),
            1
        ];

        // 2. Build Projection Matrix P
        const fovRad = (pose.fov * Math.PI) / 180.0;
        const f = 1.0 / Math.tan(fovRad * 0.5);
        const aspect = width / height;
        const zNear = 0.5;
        const zFar = 20000.0;

        const P = [
            f / aspect, 0, 0, 0,
            0, f, 0, 0,
            0, 0, (zFar + zNear) / (zNear - zFar), -1,
            0, 0, (2 * zFar * zNear) / (zNear - zFar), 0
        ];

        // 3. Compute View-Projection Matrix VP
        const VP = new Float32Array(16);
        for (let i = 0; i < 4; i++) {
            for (let j = 0; j < 4; j++) {
                let sum = 0;
                for (let k = 0; k < 4; k++) {
                    sum += V[i * 4 + k] * P[k * 4 + j];
                }
                VP[i * 4 + j] = sum;
            }
        }

        // 4. Project the Smart Point
        const [vx, vy, vz] = smartPoint;
        const cx = vx * VP[0] + vy * VP[4] + vz * VP[8] + VP[12];
        const cy = vx * VP[1] + vy * VP[5] + vz * VP[9] + VP[13];
        const cw = vx * VP[3] + vy * VP[7] + vz * VP[11] + VP[15];

        const invW = 1.0 / (cw || 1);
        const ndcX = cx * invW;
        const ndcY = cy * invW;
        const screenX = (ndcX * 0.5 + 0.5) * width;
        const screenY = (1.0 - (ndcY * 0.5 + 0.5)) * height;

        // 5. Generate Feathered Radial Mask
        const size = width * height;
        const maskRgba = Buffer.alloc(size * 4);

        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
                const idx = (y * width + x) * 4;
                const dist = Math.hypot(x - screenX, y - screenY);

                let grayscale = 0;
                if (dist <= radiusPx * 0.5) {
                    grayscale = 255;
                } else if (dist <= radiusPx) {
                    const t = (dist - radiusPx * 0.5) / (radiusPx * 0.5);
                    // Smooth linear/cosine falloff
                    grayscale = Math.round(255 * (0.5 + 0.5 * Math.cos(t * Math.PI)));
                }

                maskRgba[idx] = grayscale;
                maskRgba[idx + 1] = grayscale;
                maskRgba[idx + 2] = grayscale;
                maskRgba[idx + 3] = 255;
            }
        }

        const maskPng = encodePng(width, height, maskRgba);

        return {
            x: screenX,
            y: screenY,
            mask: maskPng
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
