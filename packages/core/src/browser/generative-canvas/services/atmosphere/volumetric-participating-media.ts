/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import { VolumetricMedium, VolumetricResult } from './atmosphere-types';

/**
 * Single-lobe Henyey-Greenstein Phase Function.
 * g > 0: Forward scattering (sunbeams / god rays)
 * g = 0: Isotropic scattering
 * g < 0: Back-scattering
 */
export function henyeyGreensteinPhase(cosTheta: number, g: number): number {
    const g2 = g * g;
    const denom = 1.0 + g2 - 2.0 * g * cosTheta;
    if (denom <= 0.0) return 0.0;
    return (1.0 - g2) / (4.0 * Math.PI * Math.pow(denom, 1.5));
}

/**
 * Rayleigh Phase Function for clean molecular atmospheric scattering (sky blue haze).
 */
export function rayleighPhase(cosTheta: number): number {
    return (3.0 / (16.0 * Math.PI)) * (1.0 + cosTheta * cosTheta);
}

/**
 * Dual-lobe phase function blending forward Mie scattering (aerosols/dust) with backward halo.
 */
export function dualLobePhase(
    cosTheta: number,
    gForward: number = 0.75,
    gBackward: number = -0.25,
    blendWeight: number = 0.85
): number {
    return (
        blendWeight * henyeyGreensteinPhase(cosTheta, gForward) +
        (1.0 - blendWeight) * henyeyGreensteinPhase(cosTheta, gBackward)
    );
}

/**
 * Evaluates exponential height-dependent atmospheric medium density.
 */
export function evaluateDensityAtHeight(y: number, medium: VolumetricMedium): number {
    const groundLevel = medium.groundLevel ?? 0.0;
    const density = medium.density ?? 0.035;
    const heightScale = medium.heightScale ?? 4.0;
    const h = Math.max(0.0, y - groundLevel);
    return density * Math.exp(-h / heightScale);
}

/**
 * Volumetric In-Scattering Raymarcher.
 * Marches through participating media along ray (ro -> rd) towards maxDistance,
 * accumulating in-scattered light and computing optical transmittance (Beer-Lambert).
 * TypeScript mirror of C++20 scratchbox::volumetrics::marchVolumetrics.
 */
export function marchVolumetrics(
    ro: [number, number, number],
    rd: [number, number, number],
    maxDist: number,
    lightPos: [number, number, number],
    lightColor: [number, number, number],
    lightIntensity: number,
    medium: VolumetricMedium = {},
    numSteps: number = 24
): VolumetricResult {
    const stepSize = maxDist / Math.max(1, numSteps);

    // Normalize rd
    const rdLen = Math.sqrt(rd[0] * rd[0] + rd[1] * rd[1] + rd[2] * rd[2]) || 1.0;
    const nrd: [number, number, number] = [rd[0] / rdLen, rd[1] / rdLen, rd[2] / rdLen];

    // Direction from ray origin to light
    const toLightOrigin: [number, number, number] = [
        lightPos[0] - ro[0],
        lightPos[1] - ro[1],
        lightPos[2] - ro[2]
    ];
    const toLightOriginLen = Math.sqrt(
        toLightOrigin[0] * toLightOrigin[0] +
        toLightOrigin[1] * toLightOrigin[1] +
        toLightOrigin[2] * toLightOrigin[2]
    ) || 1.0;
    const cosTheta =
        (nrd[0] * toLightOrigin[0] + nrd[1] * toLightOrigin[1] + nrd[2] * toLightOrigin[2]) /
        toLightOriginLen;

    const anisotropy = medium.anisotropy ?? 0.72;
    const scatteringAlbedo = medium.scatteringAlbedo ?? 0.9;
    const scatteringColor = medium.scatteringColor ?? [0.95, 0.88, 0.72];
    const phase = dualLobePhase(cosTheta, anisotropy, -0.2, 0.85);

    let accumulatedInscatter: [number, number, number] = [0, 0, 0];
    let transmittance = 1.0;

    for (let i = 0; i < numSteps; ++i) {
        const t = (i + 0.5) * stepSize;
        const samplePos: [number, number, number] = [
            ro[0] + nrd[0] * t,
            ro[1] + nrd[1] * t,
            ro[2] + nrd[2] * t
        ];

        const localDensity = evaluateDensityAtHeight(samplePos[1], medium);
        if (localDensity <= 1e-5) continue;

        // Optical depth attenuation of the step itself
        const stepOpticalDepth = localDensity * stepSize;
        const stepTransmittance = Math.exp(-stepOpticalDepth);

        // Vector to light source from sample position
        const toLight: [number, number, number] = [
            lightPos[0] - samplePos[0],
            lightPos[1] - samplePos[1],
            lightPos[2] - samplePos[2]
        ];
        const distToLight = Math.sqrt(
            toLight[0] * toLight[0] + toLight[1] * toLight[1] + toLight[2] * toLight[2]
        );

        // Distance light attenuation
        const lightAtten = lightIntensity / (1.0 + 0.1 * distToLight * distToLight);

        // In-scattering radiance slice
        const commonFactor = lightAtten * phase * scatteringAlbedo * localDensity;
        const inscatterSlice: [number, number, number] = [
            scatteringColor[0] * lightColor[0] * commonFactor,
            scatteringColor[1] * lightColor[1] * commonFactor,
            scatteringColor[2] * lightColor[2] * commonFactor
        ];

        // Integrate via Riemann sum
        const stepWeight = transmittance * (1.0 - stepTransmittance);
        accumulatedInscatter[0] += inscatterSlice[0] * stepWeight;
        accumulatedInscatter[1] += inscatterSlice[1] * stepWeight;
        accumulatedInscatter[2] += inscatterSlice[2] * stepWeight;

        transmittance *= stepTransmittance;
        if (transmittance < 0.01) break;
    }

    return {
        inscatteredRadiance: accumulatedInscatter,
        transmittance
    };
}

/**
 * 9-Coefficient Order-3 Spherical Harmonics for Irradiance Caching (Image-Based Lighting).
 * Implements Ravi Ramamoorthi's analytical evaluation algorithm.
 */
export class SphericalHarmonics9 {
    public coeffs: [number, number, number][];

    constructor(coeffs?: [number, number, number][]) {
        if (coeffs && coeffs.length === 9) {
            this.coeffs = coeffs.map(c => [c[0], c[1], c[2]]);
        } else {
            this.coeffs = Array.from({ length: 9 }, () => [0, 0, 0]);
        }
    }

    /**
     * Evaluates diffuse ambient irradiance for any surface normal using Ravi Ramamoorthi's formula.
     */
    public evaluateIrradiance(normal: [number, number, number] | { x: number; y: number; z: number }): [number, number, number] {
        let x: number, y: number, z: number;
        if (Array.isArray(normal)) {
            x = normal[0];
            y = normal[1];
            z = normal[2];
        } else {
            x = normal.x;
            y = normal.y;
            z = normal.z;
        }

        const len = Math.sqrt(x * x + y * y + z * z) || 1.0;
        x /= len;
        y /= len;
        z /= len;

        // Constant factors for L0, L1, L2 polynomials
        const c1 = 0.429043;
        const c2 = 0.511664;
        const c3 = 0.743125;
        const c4 = 0.886227;
        const c5 = 0.247708;

        const out: [number, number, number] = [0, 0, 0];

        for (let ch = 0; ch < 3; ++ch) {
            const c = (idx: number) => this.coeffs[idx][ch];

            const val =
                c(0) * c4 -
                c(6) * c5 +
                c(6) * (c3 * z * z) +
                (c(8) * (x * x - y * y) +
                    c(4) * (2.0 * x * y) +
                    c(7) * (2.0 * x * z) +
                    c(5) * (2.0 * y * z)) *
                    c1 +
                (c(3) * x + c(1) * y + c(2) * z) * (2.0 * c2);

            out[ch] = Math.max(0.0, val);
        }

        return out;
    }

    /**
     * Pre-calibrated Golden Hour Sky HDR Spherical Harmonics.
     */
    public static getSkyGoldenHourSH(): SphericalHarmonics9 {
        return new SphericalHarmonics9([
            [0.79, 0.62, 0.45], // L00
            [0.39, 0.35, 0.22], // L1-1
            [0.21, 0.24, 0.30], // L10
            [0.14, 0.12, 0.08], // L11
            [0.02, 0.02, 0.01], // L2-2
            [0.06, 0.07, 0.08], // L2-1
            [0.12, 0.10, 0.06], // L20
            [0.04, 0.03, 0.02], // L21
            [0.08, 0.06, 0.03]  // L22
        ]);
    }

    /**
     * Pre-calibrated Overcast Forest Sky HDR Spherical Harmonics.
     */
    public static getSkyForestCanopySH(): SphericalHarmonics9 {
        return new SphericalHarmonics9([
            [0.42, 0.52, 0.38],
            [0.18, 0.25, 0.15],
            [0.25, 0.30, 0.22],
            [0.08, 0.10, 0.07],
            [0.01, 0.02, 0.01],
            [0.03, 0.04, 0.03],
            [0.07, 0.09, 0.06],
            [0.02, 0.03, 0.02],
            [0.04, 0.05, 0.03]
        ]);
    }

    /**
     * Filament cmgen-style analytical projection:
     * Projects any equirectangular HDR/linear RGB radiance map into 9 Spherical Harmonic coefficients.
     * Integrates over the sphere using solid angle dOmega = sin(theta) * dTheta * dPhi.
     */
    public static projectEquirectangular(
        rgbData: Float32Array | number[] | Uint8ClampedArray | Uint8Array,
        width: number,
        height: number,
        channels: number = 3
    ): SphericalHarmonics9 {
        const sh = new SphericalHarmonics9();
        if (!rgbData || width <= 0 || height <= 0) return sh;

        const isByte = rgbData instanceof Uint8ClampedArray || rgbData instanceof Uint8Array;
        const scale = isByte ? 1.0 / 255.0 : 1.0;

        const dTheta = Math.PI / height;
        const dPhi = (2.0 * Math.PI) / width;

        for (let v = 0; v < height; ++v) {
            const theta = (v + 0.5) * dTheta;
            const sinTheta = Math.sin(theta);
            const cosTheta = Math.cos(theta);
            const dOmega = sinTheta * dTheta * dPhi;

            for (let u = 0; u < width; ++u) {
                const phi = (u + 0.5) * dPhi;
                const sinPhi = Math.sin(phi);
                const cosPhi = Math.cos(phi);

                // Cartesian unit vector (Y-up convention)
                const x = -sinTheta * sinPhi;
                const y = cosTheta;
                const z = -sinTheta * cosPhi;

                // 9 SH Basis Functions (Ramamoorthi & Hanrahan / Filament cmgen)
                const Y0 = 0.282095;
                const Y1 = 0.488603 * y;
                const Y2 = 0.488603 * z;
                const Y3 = 0.488603 * x;
                const Y4 = 1.092548 * x * y;
                const Y5 = 1.092548 * y * z;
                const Y6 = 0.315392 * (3.0 * z * z - 1.0);
                const Y7 = 1.092548 * x * z;
                const Y8 = 0.546274 * (x * x - y * y);

                const Y = [Y0, Y1, Y2, Y3, Y4, Y5, Y6, Y7, Y8];

                const idx = (v * width + u) * channels;
                const r = rgbData[idx] * scale;
                const g = rgbData[idx + 1] * scale;
                const b = rgbData[idx + 2] * scale;

                for (let i = 0; i < 9; ++i) {
                    const wY = dOmega * Y[i];
                    sh.coeffs[i][0] += r * wY;
                    sh.coeffs[i][1] += g * wY;
                    sh.coeffs[i][2] += b * wY;
                }
            }
        }

        return sh;
    }
}
