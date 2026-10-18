/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import { PanoramaDepthService, type DepthUnits } from '../spatial/PanoramaDepthService';

export interface DepthBoxInferenceConfig {
    fovDegrees?: number;
    minDepth?: number;
    maxDepth?: number;
}

export interface DepthRayPoint {
    x: number;
    y: number;
    z: number;
    u: number;
    v: number;
    depth: number;
    ray: [number, number, number];
    color?: [number, number, number, number];
}

export interface DepthBoxPredictionResult {
    width: number;
    height: number;
    metricDepths: Float32Array;
    rayMap: Float32Array; // 3 * width * height (rx, ry, rz per pixel)
    pointCloud: DepthRayPoint[];
    minDepth: number;
    maxDepth: number;
    averageDepth: number;
    /** 'relative' (median planar depth 1) unless a median depth in metres was given. */
    depthUnits: DepthUnits;
    modelUsed: string;
    farPlanePixels: number;
}

/**
 * DepthBox inference and unprojection: per-pixel depth from the local depth model (Depth Anything V2 Small), the
 * pinhole ray field, and direct P = d * r unprojection.
 */
export class DepthBoxInferenceService {
    private depthService: PanoramaDepthService;
    private defaultFov: number;
    private minDepth: number;
    private maxDepth: number;

    constructor(config: DepthBoxInferenceConfig = {}, depthService: PanoramaDepthService = new PanoramaDepthService()) {
        this.depthService = depthService;
        this.defaultFov = config.fovDegrees ?? 60.0;
        this.minDepth = config.minDepth ?? 0.1;
        this.maxDepth = config.maxDepth ?? 500.0;
    }

    /**
     * Computes unit direction ray field for a pinhole camera:
     * r(u, v) = K^-1 [u, v, 1]^T, normalized to ||r|| = 1.0.
     */
    public computePinholeRayField(width: number, height: number, fovDegrees?: number): Float32Array {
        const fov = (fovDegrees ?? this.defaultFov) * (Math.PI / 180.0);
        const f = 0.5 * height / Math.tan(0.5 * fov);
        const cx = width * 0.5;
        const cy = height * 0.5;

        const rayMap = new Float32Array(width * height * 3);

        for (let y = 0; y < height; ++y) {
            for (let x = 0; x < width; ++x) {
                const idx = (y * width + x) * 3;
                const rx = (x - cx) / f;
                const ry = (y - cy) / f;
                const rz = 1.0;

                const invLen = 1.0 / Math.sqrt(rx * rx + ry * ry + rz * rz);
                rayMap[idx] = rx * invLen;
                rayMap[idx + 1] = ry * invLen;
                rayMap[idx + 2] = rz * invLen;
            }
        }

        return rayMap;
    }

    /**
     * Unprojects pixels directly to 3D points using DepthBox formula:
     * P(u, v) = d(u, v) * r(u, v).
     */
    public unprojectToPoints(
        metricDepths: Float32Array,
        rayMap: Float32Array,
        width: number,
        height: number,
        rgbaColors?: Uint8Array,
        stride: number = 1
    ): DepthRayPoint[] {
        const points: DepthRayPoint[] = [];
        const step = Math.max(1, stride);

        for (let y = 0; y < height; y += step) {
            for (let x = 0; x < width; x += step) {
                const pIdx = y * width + x;
                const rIdx = pIdx * 3;
                const d = metricDepths[pIdx];

                const rx = rayMap[rIdx];
                const ry = rayMap[rIdx + 1];
                const rz = rayMap[rIdx + 2];

                // P = d * r
                const px = d * rx;
                const py = d * ry;
                const pz = d * rz;

                let color: [number, number, number, number] | undefined;
                if (rgbaColors) {
                    const cIdx = pIdx * 4;
                    color = [
                        rgbaColors[cIdx],
                        rgbaColors[cIdx + 1],
                        rgbaColors[cIdx + 2],
                        rgbaColors[cIdx + 3] ?? 255
                    ];
                }

                points.push({
                    x: px,
                    y: py,
                    z: pz,
                    u: x,
                    v: y,
                    depth: d,
                    ray: [rx, ry, rz],
                    color
                });
            }
        }

        return points;
    }

    /**
     * Depth-ray prediction for an RGB or RGBA pixel buffer: the depth comes from the local depth model (Depth Anything
     * V2 Small via PanoramaDepthService), converted to depth along each pixel's pinhole ray and unprojected as
     * P = d * r. Relative units (median planar depth 1) unless `medianDepthMeters` gives the scene's median distance.
     * Throws GeneratorFailedError when the depth model cannot run; nothing is derived from the colours.
     */
    public async predictDepthAndRays(
        imageBuffer: Buffer | Uint8Array,
        width: number,
        height: number,
        options: { fov?: number; stride?: number; channels?: 3 | 4; medianDepthMeters?: number } = {}
    ): Promise<DepthBoxPredictionResult> {
        const fov = options.fov ?? this.defaultFov;
        const stride = options.stride ?? 1;
        const channels = options.channels ?? (imageBuffer.length >= width * height * 4 ? 4 : 3);

        const depth = await this.depthService.generatePixelBufferDepth(imageBuffer, width, height, {
            channels, fovDegrees: fov, medianDepthMeters: options.medianDepthMeters
        });
        const metricDepths = depth.rayDepths;
        let minD = Infinity;
        let maxD = -Infinity;
        let sumD = 0;
        for (let i = 0; i < metricDepths.length; i++) {
            const d = Math.max(this.minDepth, Math.min(this.maxDepth, metricDepths[i]));
            metricDepths[i] = d;
            if (d < minD) minD = d;
            if (d > maxD) maxD = d;
            sumD += d;
        }

        const rayMap = this.computePinholeRayField(width, height, fov);
        let rgba: Uint8Array | undefined;
        if (channels === 4) {
            rgba = imageBuffer as Uint8Array;
        } else {
            rgba = new Uint8Array(width * height * 4);
            for (let i = 0; i < width * height; i++) {
                rgba[i * 4] = imageBuffer[i * 3];
                rgba[i * 4 + 1] = imageBuffer[i * 3 + 1];
                rgba[i * 4 + 2] = imageBuffer[i * 3 + 2];
                rgba[i * 4 + 3] = 255;
            }
        }
        const pointCloud = this.unprojectToPoints(metricDepths, rayMap, width, height, rgba, stride);

        return {
            width,
            height,
            metricDepths,
            rayMap,
            pointCloud,
            minDepth: minD,
            maxDepth: maxD,
            averageDepth: sumD / (width * height),
            depthUnits: depth.depthUnits,
            modelUsed: depth.modelUsed,
            farPlanePixels: depth.farPlanePixels
        };
    }
}
