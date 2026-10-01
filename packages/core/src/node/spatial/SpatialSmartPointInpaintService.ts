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
import { encodePng } from '../texture-processing';
import { GeminiClient } from '../gemini/gemini-client';

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
     * Executes localized inpainting of an image using Gemini's native image editing API.
     */
    public async executeSpatialInpaint(request: {
        image: Buffer;
        mask: Buffer;
        prompt: string;
        model?: string;
        aspectRatio?: string;
    }): Promise<{ image: Buffer; mimeType: string }> {
        const client = await this.getClient();
        const model = request.model || 'gemini-3.1-flash-image-preview';
        const aspectRatio = request.aspectRatio || '16:9';

        const contents = [
            {
                role: 'user',
                parts: [
                    {
                        inlineData: {
                            mimeType: 'image/png',
                            data: request.image.toString('base64')
                        }
                    },
                    {
                        inlineData: {
                            mimeType: 'image/png',
                            data: request.mask.toString('base64')
                        }
                    },
                    {
                        text: request.prompt
                    }
                ]
            }
        ];

        const response = await client.models.generateContent({
            model,
            contents,
            config: {
                responseModalities: ['IMAGE'],
                imageConfig: {
                    aspectRatio
                }
            }
        });

        const part = response.candidates?.[0]?.content?.parts?.[0];
        if (!part || !part.inlineData || !part.inlineData.data) {
            throw new Error('No image data returned from Gemini for spatial inpainting');
        }

        return {
            image: Buffer.from(part.inlineData.data, 'base64'),
            mimeType: part.inlineData.mimeType || 'image/png'
        };
    }
}
