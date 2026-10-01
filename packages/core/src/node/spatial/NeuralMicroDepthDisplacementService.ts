/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

export interface MicroDepthOptions {
    maxDeltaZ?: number;
    smoothRadius?: number;
    weight?: number;
    cavityDepth?: number;
    cavityLum?: number;
}

export interface MicroDepthResult {
    effectiveDepth: Float32Array;
    deltaZ: Float32Array;
    microDisplacedCount: number;
    meanDeltaZ: number;
    maxObservedDeltaZ: number;
    affineScale?: number;
    affineShift?: number;
}

/**
 * NeuralMicroDepthDisplacementService
 *
 * Implements the Hybrid Micro-Depth Displacement directive:
 * Depth = Z_mesh + ΔZ_neural
 * Δz = z_neural - z_mesh_smooth
 *
 * Recovers sharp architectural relief (columns, fluting, window insets, archway portals,
 * crisp cornices) directly from 2D photographs while anchoring global metric scale
 * to the photogrammetric / 3D tiles mesh.
 */
export class NeuralMicroDepthDisplacementService {

    /**
     * Compute separable 2D box-blur over depth / scalar field with NaN/empty exclusion.
     */
    public static smoothField(
        field: Float32Array,
        width: number,
        height: number,
        radius: number,
        validPredicate?: (val: number) => boolean
    ): Float32Array {
        const isValid = validPredicate ?? ((v: number) => v > 0.05 && v < 1e8 && !isNaN(v));
        const temp = new Float32Array(width * height);
        const out = new Float32Array(width * height);

        // Horizontal pass
        for (let y = 0; y < height; ++y) {
            const rowOffset = y * width;
            let sum = 0;
            let count = 0;

            // Pre-fill window
            for (let x = -radius; x <= radius; ++x) {
                const cx = Math.max(0, Math.min(width - 1, x));
                const v = field[rowOffset + cx];
                if (isValid(v)) {
                    sum += v;
                    count++;
                }
            }

            for (let x = 0; x < width; ++x) {
                temp[rowOffset + x] = count > 0 ? sum / count : field[rowOffset + x];

                // Slide window
                const removeX = Math.max(0, Math.min(width - 1, x - radius));
                const addX = Math.max(0, Math.min(width - 1, x + radius + 1));
                const vRem = field[rowOffset + removeX];
                const vAdd = field[rowOffset + addX];
                if (isValid(vRem)) { sum -= vRem; count--; }
                if (isValid(vAdd)) { sum += vAdd; count++; }
            }
        }

        // Vertical pass
        for (let x = 0; x < width; ++x) {
            let sum = 0;
            let count = 0;

            // Pre-fill window
            for (let y = -radius; y <= radius; ++y) {
                const cy = Math.max(0, Math.min(height - 1, y));
                const v = temp[cy * width + x];
                if (isValid(v)) {
                    sum += v;
                    count++;
                }
            }

            for (let y = 0; y < height; ++y) {
                out[y * width + x] = count > 0 ? sum / count : temp[y * width + x];

                // Slide window
                const removeY = Math.max(0, Math.min(height - 1, y - radius));
                const addY = Math.max(0, Math.min(height - 1, y + radius + 1));
                const vRem = temp[removeY * width + x];
                const vAdd = temp[addY * width + x];
                if (isValid(vRem)) { sum -= vRem; count--; }
                if (isValid(vAdd)) { sum += vAdd; count++; }
            }
        }

        return out;
    }

    /**
     * Aligns neural depth (from Depth Anything V2/V3 or MoGe) to metric mesh depth
     * via least-squares affine regression: s* · z_neural + t* ≈ z_mesh,
     * then extracts micro-relief offset: Δz = z_neural_metric - z_mesh_smooth.
     */
    public static alignAndDisplace(
        meshDepth: Float32Array,
        neuralDepth: Float32Array,
        width: number,
        height: number,
        options?: MicroDepthOptions
    ): MicroDepthResult {
        const maxDeltaZ = options?.maxDeltaZ ?? 3.5;
        const radius = options?.smoothRadius ?? 15;
        const weight = options?.weight ?? 1.0;

        const meshSmooth = this.smoothField(meshDepth, width, height, radius);

        // Affine fit: z_neural -> z_mesh_smooth
        let sumN = 0, sumM = 0, sumNN = 0, sumNM = 0;
        let validSamples = 0;
        const N = width * height;

        for (let i = 0; i < N; ++i) {
            const m = meshSmooth[i];
            const n = neuralDepth[i];
            if (m > 0.05 && m < 1e8 && n > 0.001 && n < 1e8) {
                sumN += n;
                sumM += m;
                sumNN += n * n;
                sumNM += n * m;
                validSamples++;
            }
        }

        let sScale = 1.0;
        let tShift = 0.0;
        if (validSamples > 100) {
            const meanN = sumN / validSamples;
            const meanM = sumM / validSamples;
            let num = 0, den = 0;
            for (let i = 0; i < N; ++i) {
                const m = meshSmooth[i];
                const n = neuralDepth[i];
                if (m > 0.05 && m < 1e8 && n > 0.001 && n < 1e8) {
                    num += (n - meanN) * (m - meanM);
                    den += (n - meanN) * (n - meanN);
                }
            }
            if (den > 1e-6) {
                sScale = num / den;
                tShift = meanM - sScale * meanN;
            }
        }

        const effective = new Float32Array(N);
        const deltaField = new Float32Array(N);
        let microDisplacedCount = 0;
        let sumDelta = 0;
        let maxObservedDeltaZ = 0;

        for (let i = 0; i < N; ++i) {
            const dMesh = meshDepth[i];
            if (dMesh <= 0.05 || dMesh >= 1e8) {
                effective[i] = dMesh;
                continue;
            }

            const zNeuralMetric = sScale * neuralDepth[i] + tShift;
            let dz = zNeuralMetric - meshSmooth[i];
            dz = Math.max(-maxDeltaZ, Math.min(maxDeltaZ, dz));

            const absDz = Math.abs(dz);
            if (absDz > 0.005) {
                microDisplacedCount++;
                sumDelta += absDz;
                if (absDz > maxObservedDeltaZ) maxObservedDeltaZ = absDz;
            }

            deltaField[i] = dz;
            effective[i] = Math.max(0.05, dMesh + weight * dz);
        }

        const meanDeltaZ = microDisplacedCount > 0 ? sumDelta / microDisplacedCount : 0;

        return {
            effectiveDepth: effective,
            deltaZ: deltaField,
            microDisplacedCount,
            meanDeltaZ,
            maxObservedDeltaZ,
            affineScale: sScale,
            affineShift: tShift
        };
    }

    /**
     * Photometric high-frequency micro-depth displacement:
     * Derives micro-relief Δz from local image luminance variance ΔL = L - L_smooth
     * and carves hollow corridors for archway portals.
     */
    public static extractPhotometricMicroRelief(
        meshDepth: Float32Array,
        rgb: Uint8Array,
        channels: number,
        width: number,
        height: number,
        options?: MicroDepthOptions
    ): MicroDepthResult {
        const maxDeltaZ = options?.maxDeltaZ ?? 3.5;
        const radius = options?.smoothRadius ?? 15;
        const weight = options?.weight ?? 1.0;
        const cavityDepth = options?.cavityDepth ?? 3.5;
        const cavityLum = options?.cavityLum ?? 0.18;

        const N = width * height;
        const lum = new Float32Array(N);
        for (let i = 0; i < N; ++i) {
            const ci = i * channels;
            const r = rgb[ci] / 255.0;
            const g = rgb[ci + 1] / 255.0;
            const b = rgb[ci + 2] / 255.0;
            lum[i] = 0.2126 * r + 0.7152 * g + 0.0722 * b;
        }

        const lumSmooth = this.smoothField(lum, width, height, radius, (v) => !isNaN(v));

        const effective = new Float32Array(N);
        const deltaField = new Float32Array(N);
        let microDisplacedCount = 0;
        let sumDelta = 0;
        let maxObservedDeltaZ = 0;

        for (let i = 0; i < N; ++i) {
            const dMesh = meshDepth[i];
            if (dMesh <= 0.05 || dMesh >= 1e8) {
                effective[i] = dMesh;
                continue;
            }

            const L = lum[i];
            const dL = L - lumSmooth[i];
            // Micro-relief: bright flutes/cornices project forward (-Z), dark insets recede (+Z)
            const relief = -dL * 0.45;

            // Archway cavity pull
            let cav = 0.0;
            if (cavityDepth > 0 && L < cavityLum) {
                const factor = Math.max(0.0, Math.min(1.0, (cavityLum - L) / cavityLum));
                cav = cavityDepth * factor;
            }

            let dz = relief + cav;
            dz = Math.max(-maxDeltaZ, Math.min(maxDeltaZ, dz));

            const absDz = Math.abs(dz);
            if (absDz > 0.005) {
                microDisplacedCount++;
                sumDelta += absDz;
                if (absDz > maxObservedDeltaZ) maxObservedDeltaZ = absDz;
            }

            deltaField[i] = dz;
            effective[i] = Math.max(0.05, dMesh + weight * dz);
        }

        const meanDeltaZ = microDisplacedCount > 0 ? sumDelta / microDisplacedCount : 0;

        return {
            effectiveDepth: effective,
            deltaZ: deltaField,
            microDisplacedCount,
            meanDeltaZ,
            maxObservedDeltaZ
        };
    }
}
