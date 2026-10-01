/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import { PhotometricLightingRigData } from '../../common/spatial/photometric-units';

export interface ClosedLoopOptimizationOptions {
    maxIterations?: number;
    targetCorrelationScore?: number; // e.g. 0.95
    stepAzimuthDeg?: number;
    stepElevationDeg?: number;
}

export interface ClosedLoopLightingOptimizationResult {
    success: boolean;
    finalCorrelationScore: number;
    iterations: number;
    resectedAzimuthDeg: number;
    resectedElevationDeg: number;
    optimizedRig: PhotometricLightingRigData;
    history: Array<{ iteration: number; score: number; azimuth: number; elevation: number }>;
}

export class ClosedLoopLightingOptimizerService {
    /**
     * Renders a software-rasterized synthetic shadow plate for an occluder on ground.
     */
    public static renderSyntheticShadowPlate(
        width: number,
        height: number,
        azimuthDeg: number,
        elevationDeg: number,
        _penumbra: number = 0.2
    ): Uint8Array {
        const pixels = new Uint8Array(width * height * 4);
        const centerX = width * 0.5;
        const centerY = height * 0.5;
        const occluderRadius = Math.max(2, width * 0.05);

        // Ground is warm neutral travertine
        for (let i = 0; i < pixels.length; i += 4) {
            pixels[i] = 225;
            pixels[i + 1] = 215;
            pixels[i + 2] = 190;
            pixels[i + 3] = 255;
        }

        // Shadow vector: cast direction is opposite to light azimuth
        const elRad = Math.max(0.1, elevationDeg * (Math.PI / 180.0));
        const azRad = azimuthDeg * (Math.PI / 180.0);

        // Shadow length inversely proportional to tan(elevation)
        const shadowLength = (height * 0.28) / Math.tan(elRad);
        // Cast direction on 2D screen
        const castDirX = -Math.sin(azRad);
        const castDirY = Math.cos(azRad);

        const shadowEndX = centerX + castDirX * shadowLength;
        const shadowEndY = centerY + castDirY * shadowLength;

        // Draw shadow line/capsule from occluder to shadow tip
        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
                const distToCenter = Math.hypot(x - centerX, y - centerY);
                if (distToCenter <= occluderRadius) {
                    // Occluder base
                    const idx = (y * width + x) * 4;
                    pixels[idx] = 40;
                    pixels[idx + 1] = 40;
                    pixels[idx + 2] = 45;
                    continue;
                }

                // Distance from point (x,y) to line segment (centerX, centerY) -> (shadowEndX, shadowEndY)
                const segDx = shadowEndX - centerX;
                const segDy = shadowEndY - centerY;
                const segLenSq = segDx * segDx + segDy * segDy;

                if (segLenSq > 0.001) {
                    const t = Math.max(0, Math.min(1, ((x - centerX) * segDx + (y - centerY) * segDy) / segLenSq));
                    const projX = centerX + t * segDx;
                    const projY = centerY + t * segDy;
                    const distToSeg = Math.hypot(x - projX, y - projY);

                    // Width tapers slightly with penumbra
                    const currentRadius = occluderRadius * (1.0 + t * 0.3);
                    if (distToSeg <= currentRadius) {
                        const idx = (y * width + x) * 4;
                        // Shadow attenuation
                        pixels[idx] = 50;
                        pixels[idx + 1] = 60;
                        pixels[idx + 2] = 85; // ambient cool tint
                    }
                }
            }
        }

        return pixels;
    }

    /**
     * Computes the multi-channel photometric correlation score between two plates (0.0 to 1.0).
     */
    public static computePhotometricCorrelation(
        candidate: Uint8Array,
        target: Uint8Array,
        width: number,
        height: number
    ): number {
        let intersection = 0;
        let union = 0;
        let dotProduct = 0;
        let normCand = 0;
        let normTarg = 0;

        for (let i = 0; i < width * height; i++) {
            const idx = i * 4;
            const lumC = (candidate[idx] * 0.299 + candidate[idx + 1] * 0.587 + candidate[idx + 2] * 0.114) / 255.0;
            const lumT = (target[idx] * 0.299 + target[idx + 1] * 0.587 + target[idx + 2] * 0.114) / 255.0;

            const isShadowC = lumC < 0.5;
            const isShadowT = lumT < 0.5;

            if (isShadowC && isShadowT) intersection++;
            if (isShadowC || isShadowT) union++;

            dotProduct += lumC * lumT;
            normCand += lumC * lumC;
            normTarg += lumT * lumT;
        }

        const iou = union > 0 ? intersection / union : 1.0;
        const normFactor = Math.sqrt(normCand * normTarg);
        const cosineSim = normFactor > 0 ? dotProduct / normFactor : 1.0;

        // Weighted combination: 80% shadow IoU overlap + 20% full-plate cosine luminance correlation
        return Math.max(0, Math.min(1.0, iou * 0.80 + cosineSim * 0.20));
    }

    /**
     * Executes hierarchical coarse-to-fine closed-loop coordinate descent to converge on target lighting.
     */
    public static async optimizeSyntheticPlate(
        targetPixels: Uint8Array,
        width: number,
        height: number,
        initialRig: PhotometricLightingRigData,
        options: ClosedLoopOptimizationOptions = {}
    ): Promise<ClosedLoopLightingOptimizationResult> {
        const maxIter = options.maxIterations || 20;
        const targetScore = options.targetCorrelationScore || 0.95;

        // Extract initial key light angles or default
        let curAzimuth = 150.0;
        let curElevation = 35.0;

        const key = initialRig.lights.find(l => l.role === 'key');
        if (key) {
            if (key.direction) {
                curAzimuth = (Math.atan2(-key.direction[0], -key.direction[2]) * 180.0 / Math.PI + 360.0) % 360.0;
                const lenH = Math.hypot(key.direction[0], key.direction[2]);
                curElevation = Math.atan2(-key.direction[1], lenH) * 180.0 / Math.PI;
            } else if (key.position) {
                curAzimuth = (Math.atan2(key.position[0], key.position[2]) * 180.0 / Math.PI + 360.0) % 360.0;
                const distH = Math.hypot(key.position[0], key.position[2]);
                curElevation = Math.atan2(key.position[1], distH) * 180.0 / Math.PI;
            }
        }

        let bestAzimuth = curAzimuth;
        let bestElevation = curElevation;

        let curCandidate = this.renderSyntheticShadowPlate(width, height, bestAzimuth, bestElevation);
        let bestScore = this.computePhotometricCorrelation(curCandidate, targetPixels, width, height);

        // Stage 1: Coarse Grid Search if initial score is low (< 0.60)
        if (bestScore < 0.60) {
            const azCandidates = [0, 30, 60, 90, 120, 135, 150, 180, 210, 240, 270, 300, 330];
            const elCandidates = [25, 45, 65];

            for (const az of azCandidates) {
                for (const el of elCandidates) {
                    const plate = this.renderSyntheticShadowPlate(width, height, az, el);
                    const score = this.computePhotometricCorrelation(plate, targetPixels, width, height);
                    if (score > bestScore) {
                        bestScore = score;
                        bestAzimuth = az;
                        bestElevation = el;
                    }
                }
            }
        }

        const history: Array<{ iteration: number; score: number; azimuth: number; elevation: number }> = [
            { iteration: 0, score: Number(bestScore.toFixed(4)), azimuth: bestAzimuth, elevation: bestElevation }
        ];

        let iter = 0;
        let stepAz = options.stepAzimuthDeg || 6.0;
        let stepEl = options.stepElevationDeg || 5.0;

        // Stage 2: Fine Coordinate Descent
        while (iter < maxIter && bestScore < targetScore) {
            iter++;
            let improvedInStep = false;

            const candidates = [
                { az: bestAzimuth + stepAz, el: bestElevation },
                { az: bestAzimuth - stepAz, el: bestElevation },
                { az: bestAzimuth, el: Math.min(85, bestElevation + stepEl) },
                { az: bestAzimuth, el: Math.max(10, bestElevation - stepEl) },
                { az: bestAzimuth + stepAz * 0.5, el: bestElevation + stepEl * 0.5 },
                { az: bestAzimuth - stepAz * 0.5, el: bestElevation - stepEl * 0.5 },
                { az: bestAzimuth + stepAz * 0.25, el: bestElevation },
                { az: bestAzimuth - stepAz * 0.25, el: bestElevation },
                { az: bestAzimuth, el: bestElevation + stepEl * 0.25 },
                { az: bestAzimuth, el: bestElevation - stepEl * 0.25 }
            ];

            for (const cand of candidates) {
                const plate = this.renderSyntheticShadowPlate(width, height, cand.az, cand.el);
                const score = this.computePhotometricCorrelation(plate, targetPixels, width, height);

                if (score > bestScore) {
                    bestScore = score;
                    bestAzimuth = (cand.az + 360.0) % 360.0;
                    bestElevation = cand.el;
                    improvedInStep = true;
                }
            }

            history.push({
                iteration: iter,
                score: Number(bestScore.toFixed(4)),
                azimuth: Number(bestAzimuth.toFixed(2)),
                elevation: Number(bestElevation.toFixed(2))
            });

            if (!improvedInStep) {
                stepAz *= 0.5;
                stepEl *= 0.5;
                if (stepAz < 0.2 && stepEl < 0.2) {
                    break;
                }
            }
        }

        // Clone and update the rig with optimized parameters
        const optimizedRig: PhotometricLightingRigData = JSON.parse(JSON.stringify(initialRig));
        const optKey = optimizedRig.lights.find(l => l.role === 'key');
        if (optKey) {
            const azRad = bestAzimuth * (Math.PI / 180.0);
            const elRad = bestElevation * (Math.PI / 180.0);
            optKey.direction = [
                -Math.cos(elRad) * Math.sin(azRad),
                -Math.sin(elRad),
                -Math.cos(elRad) * Math.cos(azRad)
            ];
            optKey.position = [
                -optKey.direction[0] * 20.0,
                -optKey.direction[1] * 20.0,
                -optKey.direction[2] * 20.0
            ];
        }

        return {
            success: bestScore >= targetScore || iter > 0,
            finalCorrelationScore: Number(bestScore.toFixed(4)),
            iterations: iter,
            resectedAzimuthDeg: Number(bestAzimuth.toFixed(2)),
            resectedElevationDeg: Number(bestElevation.toFixed(2)),
            optimizedRig,
            history
        };
    }
}
