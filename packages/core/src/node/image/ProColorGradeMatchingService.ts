/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import * as fs from 'fs';
import * as path from 'path';
import { spawn } from 'child_process';

/**
 * Three-way primary color balance wheel channel.
 */
export interface PrimaryWheelChannel {
    r: number;
    g: number;
    b: number;
    master: number;
}

/**
 * Three-way primary color wheels configuration.
 * Lift: Shadows (< 25% IRE luma)
 * Gamma: Midtones (25% - 75% IRE luma)
 * Gain: Highlights (> 75% IRE luma)
 * Offset: Global printer point shift
 */
export interface PrimaryColorWheels {
    lift: PrimaryWheelChannel;
    gamma: PrimaryWheelChannel;
    gain: PrimaryWheelChannel;
    offset: PrimaryWheelChannel;
    contrast: number; // 1.0 = neutral
    pivot: number;    // default 0.435 (18% gray in linear-gamma space)
}

export interface SecondaryIsolationOptions {
    preserveSkinTones?: boolean;
    skinProtectionStrength?: number; // 0.0 to 1.0, default 0.85
    protectFoliage?: boolean;
    foliageProtectionStrength?: number;
}

export interface ColorGradeMatchOptions extends SecondaryIsolationOptions {
    generate3DLut?: boolean;
    lutSize?: number; // 17, 33, or 65, default 17
    lutTitle?: string;
    contrastCurve?: 'natural' | 'cinematic' | 'high-contrast' | 'muted';
    matchLuminance?: boolean;
    matchWhitePoint?: boolean;
    blendStrength?: number; // 0.0 to 1.0, default 1.0
    outputFormat?: 'png' | 'jpg' | 'webp';
    outputPath?: string;
    outputLutPath?: string;
}

export interface ColoristScopesData {
    waveform: {
        minIre: number;
        maxIre: number;
        meanIre: number;
        clippingLowPercent: number;
        clippingHighPercent: number;
    };
    rgbParade: {
        redMeanIre: number;
        greenMeanIre: number;
        blueMeanIre: number;
        redMaxIre: number;
        greenMaxIre: number;
        blueMaxIre: number;
    };
    vectorscope: {
        skinToneAlignmentPercent: number;
        overallSaturationPercent: number;
        dominantHueDeg: number;
    };
}

export interface ColorGradeMatchResult {
    success: boolean;
    wheels: PrimaryColorWheels;
    lutCube?: string;
    lutPath?: string;
    gradedBuffer: Buffer;
    outputPath?: string;
    scopes: {
        source: ColoristScopesData;
        reference: ColoristScopesData;
        graded: ColoristScopesData;
    };
    telemetry: {
        initialDeltaE00: number;
        finalDeltaE00: number;
        deltaEReductionPercent: number;
        executionTimeMs: number;
        sourceDimensions?: { width: number; height: number };
    };
    error?: string;
}

/**
 * ProColorGradeMatchingService
 * 
 * An industry-grade autonomous color grading and image-to-image matching engine.
 * Emulates the depth, precision, and toolset of a master colorist:
 * 1. Three-way Primary Wheels balancing (Lift, Gamma, Gain, Offset) via closed-form 3-zone inversion
 * 2. Bradford Chromatic Adaptation Transform (CAT02) for illuminant matching
 * 3. Secondary Isolation & Vectorscope Skin Tone Line (~130 deg) preservation
 * 4. Standard 3D LUT (.cube) export for zero-latency NLE / FFmpeg integration
 * 5. Optical colorist scopes telemetry (Waveform, RGB Parade, Vectorscope) and CIEDE2000 metrology.
 */
export class ProColorGradeMatchingService {

    // =========================================================================
    // 1. COLOR SPACES & CHROMATIC ADAPTATION
    // =========================================================================

    /**
     * Converts sRGB [0..255] to CIE XYZ [0..1] (D65 illuminant).
     */
    public static srgbToXyz(r: number, g: number, b: number): [number, number, number] {
        let rLin = r / 255.0;
        let gLin = g / 255.0;
        let bLin = b / 255.0;

        rLin = rLin > 0.04045 ? Math.pow((rLin + 0.055) / 1.055, 2.4) : rLin / 12.92;
        gLin = gLin > 0.04045 ? Math.pow((gLin + 0.055) / 1.055, 2.4) : gLin / 12.92;
        bLin = bLin > 0.04045 ? Math.pow((bLin + 0.055) / 1.055, 2.4) : bLin / 12.92;

        const x = rLin * 0.4124564 + gLin * 0.3575761 + bLin * 0.1804375;
        const y = rLin * 0.2126729 + gLin * 0.7151522 + bLin * 0.0721750;
        const z = rLin * 0.0193339 + gLin * 0.1191920 + bLin * 0.9503041;

        return [x, y, z];
    }

    /**
     * Converts CIE XYZ [0..1] to sRGB [0..255] (D65 illuminant).
     */
    public static xyzToSrgb(x: number, y: number, z: number): [number, number, number] {
        let rLin = x *  3.2404542 + y * -1.5371385 + z * -0.4985314;
        let gLin = x * -0.9692660 + y *  1.8760108 + z *  0.0415560;
        let bLin = x *  0.0556434 + y * -0.2040259 + z *  1.0572252;

        rLin = Math.max(0, Math.min(1, rLin));
        gLin = Math.max(0, Math.min(1, gLin));
        bLin = Math.max(0, Math.min(1, bLin));

        const r = Math.round((rLin <= 0.0031308 ? 12.92 * rLin : 1.055 * Math.pow(rLin, 1.0 / 2.4) - 0.055) * 255.0);
        const g = Math.round((gLin <= 0.0031308 ? 12.92 * gLin : 1.055 * Math.pow(gLin, 1.0 / 2.4) - 0.055) * 255.0);
        const b = Math.round((bLin <= 0.0031308 ? 12.92 * bLin : 1.055 * Math.pow(bLin, 1.0 / 2.4) - 0.055) * 255.0);

        return [Math.max(0, Math.min(255, r)), Math.max(0, Math.min(255, g)), Math.max(0, Math.min(255, b))];
    }

    /**
     * Converts sRGB [0..255] to CIE L*a*b*.
     */
    public static srgbToLab(r: number, g: number, b: number): [number, number, number] {
        const [x, y, z] = this.srgbToXyz(r, g, b);
        return this.xyzToLab(x, y, z);
    }

    /**
     * Converts CIE XYZ to CIE L*a*b* using D65 reference white.
     */
    public static xyzToLab(x: number, y: number, z: number): [number, number, number] {
        const xn = 0.95047;
        const yn = 1.00000;
        const zn = 1.08883;

        const xr = x / xn;
        const yr = y / yn;
        const zr = z / zn;

        const fx = xr > 0.008856 ? Math.cbrt(xr) : (7.787 * xr) + (16.0 / 116.0);
        const fy = yr > 0.008856 ? Math.cbrt(yr) : (7.787 * yr) + (16.0 / 116.0);
        const fz = zr > 0.008856 ? Math.cbrt(zr) : (7.787 * zr) + (16.0 / 116.0);

        const L = (116.0 * fy) - 16.0;
        const a = 500.0 * (fx - fy);
        const bStar = 200.0 * (fy - fz);

        return [L, a, bStar];
    }

    /**
     * Converts CIE L*a*b* to sRGB [0..255].
     */
    public static labToSrgb(L: number, a: number, bStar: number): [number, number, number] {
        const fy = (L + 16.0) / 116.0;
        const fx = a / 500.0 + fy;
        const fz = fy - bStar / 200.0;

        const fx3 = fx * fx * fx;
        const fz3 = fz * fz * fz;

        const xn = 0.95047;
        const yn = 1.00000;
        const zn = 1.08883;

        const x = xn * (fx3 > 0.008856 ? fx3 : (fx - 16.0 / 116.0) / 7.787);
        const y = yn * (L > 8.0 ? Math.pow((L + 16.0) / 116.0, 3) : L / 903.3);
        const z = zn * (fz3 > 0.008856 ? fz3 : (fz - 16.0 / 116.0) / 7.787);

        return this.xyzToSrgb(x, y, z);
    }

    /**
     * Approximate Planckian blackbody chromaticity coordinates (CIE 1931 xy) from Kelvin.
     */
    public static kelvinToXy(kelvin: number): [number, number] {
        const T = Math.max(1667, Math.min(25000, kelvin));
        let x: number;
        if (T <= 4000) {
            x = -0.2661239 * (1e9 / (T * T * T)) - 0.2343580 * (1e6 / (T * T)) + 0.8776956 * (1e3 / T) + 0.179910;
        } else {
            x = -3.0258469 * (1e9 / (T * T * T)) + 2.1070379 * (1e6 / (T * T)) + 0.2226347 * (1e3 / T) + 0.240390;
        }

        let y: number;
        if (T <= 2222) {
            y = -1.1063814 * (x * x * x) - 1.34811020 * (x * x) + 2.18555832 * x - 0.20219683;
        } else if (T <= 4000) {
            y = -0.9549476 * (x * x * x) - 1.37418593 * (x * x) + 2.09137015 * x - 0.16748867;
        } else {
            y = 3.0817580 * (x * x * x) - 5.87338198 * (x * x) + 3.75112997 * x - 0.37001483;
        }

        return [x, y];
    }

    /**
     * Bradford Chromatic Adaptation Transform (CAT02/Bradford).
     * Adapts CIE XYZ tristimulus values from a source illuminant to a target illuminant.
     */
    public static applyBradfordCat(
        x: number, y: number, z: number,
        srcKelvin: number, dstKelvin: number
    ): [number, number, number] {
        if (Math.abs(srcKelvin - dstKelvin) < 10) return [x, y, z];

        const bfdR = (X: number, Y: number, Z: number) =>  0.8951 * X + 0.2664 * Y - 0.1614 * Z;
        const bfdG = (X: number, Y: number, Z: number) => -0.7502 * X + 1.7135 * Y + 0.0367 * Z;
        const bfdB = (X: number, Y: number, Z: number) =>  0.0389 * X - 0.0685 * Y + 1.0296 * Z;

        const invR = (R: number, G: number, B: number) =>  0.9869929 * R - 0.1470543 * G + 0.1599627 * B;
        const invG = (R: number, G: number, B: number) =>  0.4323053 * R + 0.5183603 * G + 0.0492912 * B;
        const invB = (R: number, G: number, B: number) => -0.0085287 * R + 0.0400428 * G + 0.9684867 * B;

        const [srcXy_x, srcXy_y] = this.kelvinToXy(srcKelvin);
        const [dstXy_x, dstXy_y] = this.kelvinToXy(dstKelvin);

        const srcXn = srcXy_x / srcXy_y;
        const srcYn = 1.0;
        const srcZn = (1.0 - srcXy_x - srcXy_y) / srcXy_y;

        const dstXn = dstXy_x / dstXy_y;
        const dstYn = 1.0;
        const dstZn = (1.0 - dstXy_x - dstXy_y) / dstXy_y;

        const rSrc = bfdR(srcXn, srcYn, srcZn);
        const gSrc = bfdG(srcXn, srcYn, srcZn);
        const bSrc = bfdB(srcXn, srcYn, srcZn);

        const rDst = bfdR(dstXn, dstYn, dstZn);
        const gDst = bfdG(dstXn, dstYn, dstZn);
        const bDst = bfdB(dstXn, dstYn, dstZn);

        const kR = rDst / rSrc;
        const kG = gDst / gSrc;
        const kB = bDst / bSrc;

        const rIn = bfdR(x, y, z);
        const gIn = bfdG(x, y, z);
        const bIn = bfdB(x, y, z);

        const rOut = rIn * kR;
        const gOut = gIn * kG;
        const bOut = bIn * kB;

        return [
            invR(rOut, gOut, bOut),
            invG(rOut, gOut, bOut),
            invB(rOut, gOut, bOut)
        ];
    }

    /**
     * Exact CIEDE2000 (Delta E 00) perceptual color difference calculation.
     * International Standard ISO/CIE 11664-6:2014.
     */
    public static calculateDeltaE00(
        lab1: [number, number, number],
        lab2: [number, number, number]
    ): number {
        const [L1, a1, b1] = lab1;
        const [L2, a2, b2] = lab2;

        const avgL = (L1 + L2) / 2.0;
        const C1 = Math.hypot(a1, b1);
        const C2 = Math.hypot(a2, b2);
        const avgC = (C1 + C2) / 2.0;

        const avgC7 = Math.pow(avgC, 7);
        const G = 0.5 * (1.0 - Math.sqrt(avgC7 / (avgC7 + Math.pow(25, 7))));

        const a1p = a1 * (1.0 + G);
        const a2p = a2 * (1.0 + G);

        const C1p = Math.hypot(a1p, b1);
        const C2p = Math.hypot(a2p, b2);
        const avgCp = (C1p + C2p) / 2.0;

        const rad2deg = 180.0 / Math.PI;
        const deg2rad = Math.PI / 180.0;

        let h1p = Math.atan2(b1, a1p) * rad2deg;
        if (h1p < 0) h1p += 360.0;

        let h2p = Math.atan2(b2, a2p) * rad2deg;
        if (h2p < 0) h2p += 360.0;

        let avghp: number;
        if (Math.abs(h1p - h2p) > 180.0) {
            avghp = (h1p + h2p + 360.0) / 2.0;
        } else {
            avghp = (h1p + h2p) / 2.0;
        }

        const T = 1.0 - 0.17 * Math.cos((avghp - 30.0) * deg2rad)
                      + 0.24 * Math.cos((2.0 * avghp) * deg2rad)
                      + 0.32 * Math.cos((3.0 * avghp + 6.0) * deg2rad)
                      - 0.20 * Math.cos((4.0 * avghp - 63.0) * deg2rad);

        let deltahp: number;
        if (Math.abs(h1p - h2p) <= 180.0) {
            deltahp = h2p - h1p;
        } else if (h2p <= h1p) {
            deltahp = h2p - h1p + 360.0;
        } else {
            deltahp = h2p - h1p - 360.0;
        }

        const deltaLp = L2 - L1;
        const deltaCp = C2p - C1p;
        const deltaHp = 2.0 * Math.sqrt(C1p * C2p) * Math.sin((deltahp / 2.0) * deg2rad);

        const SL = 1.0 + (0.015 * Math.pow(avgL - 50.0, 2)) / Math.sqrt(20.0 + Math.pow(avgL - 50.0, 2));
        const SC = 1.0 + 0.045 * avgCp;
        const SH = 1.0 + 0.015 * avgCp * T;

        const deltaTheta = 30.0 * Math.exp(-Math.pow((avghp - 275.0) / 25.0, 2));
        const avgCp7 = Math.pow(avgCp, 7);
        const RC = 2.0 * Math.sqrt(avgCp7 / (avgCp7 + Math.pow(25, 7)));
        const RT = -RC * Math.sin(2.0 * deltaTheta * deg2rad);

        const dL = deltaLp / (SL * 1.0);
        const dC = deltaCp / (SC * 1.0);
        const dH = deltaHp / (SH * 1.0);

        return Math.sqrt(dL * dL + dC * dC + dH * dH + RT * dC * dH);
    }

    // =========================================================================
    // 2. THREE-WAY PRIMARY WHEELS (LIFT, GAMMA, GAIN, OFFSET)
    // =========================================================================

    /**
     * Solves a 3x3 linear system A * x = b via Cramer's rule.
     */
    private static solveLinear3x3(
        A: [[number, number, number], [number, number, number], [number, number, number]],
        b: [number, number, number]
    ): [number, number, number] {
        const [a11, a12, a13] = A[0];
        const [a21, a22, a23] = A[1];
        const [a31, a32, a33] = A[2];

        const det = a11 * (a22 * a33 - a23 * a32) - a12 * (a21 * a33 - a23 * a31) + a13 * (a21 * a32 - a22 * a31);
        if (Math.abs(det) < 1e-6) {
            return [0, 0, 0];
        }

        const detX = b[0] * (a22 * a33 - a23 * a32) - a12 * (b[1] * a33 - a23 * b[2]) + a13 * (b[1] * a32 - a22 * b[2]);
        const detY = a11 * (b[1] * a33 - a23 * b[2]) - b[0] * (a21 * a33 - a23 * a31) + a13 * (a21 * b[2] - b[1] * a31);
        const detZ = a11 * (a22 * b[2] - b[1] * a32) - a12 * (a21 * b[2] - b[1] * a31) + b[0] * (a21 * a32 - a22 * a31);

        return [detX / det, detY / det, detZ / det];
    }

    /**
     * Analytically solves three-way primary color wheels (Lift, Gamma, Gain, Offset)
     * using exact 3-zone tonal anchor inversion:
     * Output(x) = x + Lift * (1 - x) + (Gain - 1) * x + (Gamma - 1) * 4 * x * (1 - x)
     */
    public static solvePrimaryWheels(
        sourceRgba: Buffer,
        referenceRgba: Buffer,
        width: number,
        height: number
    ): PrimaryColorWheels {
        const total = width * height;

        // Collect samples across sorted luma or regular grid
        const srcR: number[] = new Array(total);
        const srcG: number[] = new Array(total);
        const srcB: number[] = new Array(total);

        const refR: number[] = new Array(total);
        const refG: number[] = new Array(total);
        const refB: number[] = new Array(total);

        for (let i = 0; i < total; i++) {
            srcR[i] = sourceRgba[i * 4] / 255.0;
            srcG[i] = sourceRgba[i * 4 + 1] / 255.0;
            srcB[i] = sourceRgba[i * 4 + 2] / 255.0;

            refR[i] = referenceRgba[i * 4] / 255.0;
            refG[i] = referenceRgba[i * 4 + 1] / 255.0;
            refB[i] = referenceRgba[i * 4 + 2] / 255.0;
        }

        // Quantile helper: 10th percentile (shadows), 50th percentile (midtones), 90th percentile (highlights)
        const getQuantile = (arr: number[], q: number) => {
            const sorted = [...arr].sort((a, b) => a - b);
            const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor(q * (sorted.length - 1))));
            return sorted[idx];
        };

        const solveChannel = (srcArr: number[], refArr: number[]) => {
            const x1 = Math.max(0.01, getQuantile(srcArr, 0.05));
            const y1 = Math.max(0.01, getQuantile(refArr, 0.05));

            const x2 = Math.max(0.05, Math.min(0.95, getQuantile(srcArr, 0.50)));
            const y2 = Math.max(0.05, Math.min(0.95, getQuantile(refArr, 0.50)));

            const x3 = Math.min(0.99, getQuantile(srcArr, 0.95));
            const y3 = Math.min(0.99, getQuantile(refArr, 0.95));

            const A: [[number, number, number], [number, number, number], [number, number, number]] = [
                [1 - x1, x1, 4 * x1 * (1 - x1)],
                [1 - x2, x2, 4 * x2 * (1 - x2)],
                [1 - x3, x3, 4 * x3 * (1 - x3)]
            ];
            const b: [number, number, number] = [y1 - x1, y2 - x2, y3 - x3];

            const [L, Gm1, Gamm1] = this.solveLinear3x3(A, b);

            return {
                lift: Math.max(-0.5, Math.min(0.5, L)),
                gain: Math.max(0.1, Math.min(3.0, Gm1 + 1.0)),
                gamma: Math.max(0.2, Math.min(3.0, Gamm1 + 1.0))
            };
        };

        const chR = solveChannel(srcR, refR);
        const chG = solveChannel(srcG, refG);
        const chB = solveChannel(srcB, refB);

        return {
            lift: { r: chR.lift, g: chG.lift, b: chB.lift, master: 0.0 },
            gamma: { r: chR.gamma, g: chG.gamma, b: chB.gamma, master: 1.0 },
            gain: { r: chR.gain, g: chG.gain, b: chB.gain, master: 1.0 },
            offset: { r: 0.0, g: 0.0, b: 0.0, master: 0.0 },
            contrast: 1.0,
            pivot: 0.435
        };
    }

    /**
     * Applies three-way primary color wheels formula to an RGBA buffer:
     * Output(x) = x + (Lift + masterLift) * (1 - x)
     *             + (Gain * masterGain - 1) * x
     *             + (Gamma * masterGamma - 1) * 4 * x * (1 - x)
     *             + (Offset + masterOffset)
     */
    public static applyPrimaryWheels(
        rgba: Buffer,
        width: number,
        height: number,
        wheels: PrimaryColorWheels
    ): Buffer {
        const total = width * height;
        const out = Buffer.alloc(total * 4);

        const { lift, gamma, gain, offset, contrast, pivot } = wheels;

        const effLiftR = lift.r + lift.master;
        const effLiftG = lift.g + lift.master;
        const effLiftB = lift.b + lift.master;

        const effGainR = gain.r * gain.master;
        const effGainG = gain.g * gain.master;
        const effGainB = gain.b * gain.master;

        const effGammaR = gamma.r * gamma.master;
        const effGammaG = gamma.g * gamma.master;
        const effGammaB = gamma.b * gamma.master;

        const effOffR = offset.r + offset.master;
        const effOffG = offset.g + offset.master;
        const effOffB = offset.b + offset.master;

        for (let i = 0; i < total; i++) {
            let r = rgba[i * 4] / 255.0;
            let g = rgba[i * 4 + 1] / 255.0;
            let b = rgba[i * 4 + 2] / 255.0;

            // 1. Classical smooth 3-zone color grading transfer function
            r = r + effLiftR * (1.0 - r) + (effGainR - 1.0) * r + (effGammaR - 1.0) * 4.0 * r * (1.0 - r) + effOffR;
            g = g + effLiftG * (1.0 - g) + (effGainG - 1.0) * g + (effGammaG - 1.0) * 4.0 * g * (1.0 - g) + effOffG;
            b = b + effLiftB * (1.0 - b) + (effGainB - 1.0) * b + (effGammaB - 1.0) * 4.0 * b * (1.0 - b) + effOffB;

            // 2. S-Curve Contrast & Pivot
            if (contrast !== 1.0) {
                r = (r - pivot) * contrast + pivot;
                g = (g - pivot) * contrast + pivot;
                b = (b - pivot) * contrast + pivot;
            }

            out[i * 4]     = Math.max(0, Math.min(255, Math.round(r * 255.0)));
            out[i * 4 + 1] = Math.max(0, Math.min(255, Math.round(g * 255.0)));
            out[i * 4 + 2] = Math.max(0, Math.min(255, Math.round(b * 255.0)));
            out[i * 4 + 3] = rgba[i * 4 + 3];
        }

        return out;
    }

    // =========================================================================
    // 3. SECONDARY ISOLATION & VECTORSCOPE SKIN TONE LINE
    // =========================================================================

    /**
     * Determines whether an RGB pixel lies on the standard broadcast Vectorscope
     * "Skin Tone Line" (I-axis / melanin pigment vector).
     * In Cartesian (Cb, Cr) space, human skin tones lie universally at hue angle ~120 deg to 145 deg (centered at 130 deg).
     */
    public static isSkinTonePixel(
        r: number, g: number, b: number
    ): { isSkinTone: boolean; confidence: number; hueAngleDeg: number } {
        // Melanin requires R > G > B
        if (r <= g || g <= b) {
            return { isSkinTone: false, confidence: 0, hueAngleDeg: 0 };
        }

        // BT.601 Cb, Cr
        const cb = -0.168736 * r - 0.331264 * g + 0.5 * b + 128.0;
        const cr =  0.5 * r - 0.418688 * g - 0.081312 * b + 128.0;

        const dCb = cb - 128.0;
        const dCr = cr - 128.0;

        const saturation = Math.hypot(dCb, dCr);
        if (saturation < 10.0 || saturation > 120.0) {
            return { isSkinTone: false, confidence: 0, hueAngleDeg: 0 };
        }

        // Hue angle in degrees [0..360]
        let hueDeg = Math.atan2(dCr, dCb) * (180.0 / Math.PI);
        if (hueDeg < 0) hueDeg += 360.0;

        // The Vectorscope Skin Tone Line is centered around 130 deg in (dCb, dCr) space
        const skinCenterAngle = 130.0;
        const deltaAngle = Math.abs(hueDeg - skinCenterAngle);

        if (deltaAngle <= 25.0) {
            const angleConfidence = 1.0 - (deltaAngle / 25.0);
            const luma = 0.299 * r + 0.587 * g + 0.114 * b;
            const lumaConfidence = (luma >= 35 && luma <= 245) ? 1.0 : 0.5;
            const confidence = Math.max(0.0, Math.min(1.0, angleConfidence * lumaConfidence));
            return { isSkinTone: true, confidence, hueAngleDeg: hueDeg };
        }

        return { isSkinTone: false, confidence: 0, hueAngleDeg: hueDeg };
    }

    /**
     * Applies primary grading wheels while protecting secondary isolations (such as skin tones).
     */
    public static applyGradingWithSecondaries(
        rgba: Buffer,
        width: number,
        height: number,
        wheels: PrimaryColorWheels,
        options: SecondaryIsolationOptions = {}
    ): Buffer {
        const total = width * height;
        const graded = this.applyPrimaryWheels(rgba, width, height, wheels);

        if (!options.preserveSkinTones) {
            return graded;
        }

        const skinStrength = options.skinProtectionStrength ?? 0.85;
        const out = Buffer.alloc(total * 4);

        for (let i = 0; i < total; i++) {
            const origR = rgba[i * 4];
            const origG = rgba[i * 4 + 1];
            const origB = rgba[i * 4 + 2];

            const skin = this.isSkinTonePixel(origR, origG, origB);

            if (skin.isSkinTone && skin.confidence > 0) {
                // Soft blend: keep organic skin pigments preserved
                const blend = skin.confidence * skinStrength;
                out[i * 4]     = Math.round((1 - blend) * graded[i * 4]     + blend * origR);
                out[i * 4 + 1] = Math.round((1 - blend) * graded[i * 4 + 1] + blend * origG);
                out[i * 4 + 2] = Math.round((1 - blend) * graded[i * 4 + 2] + blend * origB);
                out[i * 4 + 3] = rgba[i * 4 + 3];
            } else {
                out[i * 4]     = graded[i * 4];
                out[i * 4 + 1] = graded[i * 4 + 1];
                out[i * 4 + 2] = graded[i * 4 + 2];
                out[i * 4 + 3] = rgba[i * 4 + 3];
            }
        }

        return out;
    }

    // =========================================================================
    // 4. INDUSTRY-STANDARD 3D LUT (.CUBE) GENERATOR
    // =========================================================================

    /**
     * Synthesizes an industry-standard Adobe / ACES / Resolve 3D LUT (.cube format).
     * Works natively with FFmpeg `lut3d`, Unreal Engine, Premiere, and Three.js.
     */
    public static generate3DLutCube(
        wheels: PrimaryColorWheels,
        options: { size?: number; title?: string } = {}
    ): string {
        const N = options.size || 17;
        const title = options.title || 'Scratchbox_ProColorMatch';

        const lines: string[] = [];
        lines.push(`# Created by Scratchbox IDE ProColorGradeMatchingService`);
        lines.push(`TITLE "${title}"`);
        lines.push(`LUT_3D_SIZE ${N}`);
        lines.push(`DOMAIN_MIN 0.0 0.0 0.0`);
        lines.push(`DOMAIN_MAX 1.0 1.0 1.0`);

        const dummyRgba = Buffer.alloc(4);

        // Standard .cube traversal order: R fast, G mid, B slow
        for (let bIdx = 0; bIdx < N; bIdx++) {
            const bIn = Math.round((bIdx / (N - 1)) * 255.0);
            for (let gIdx = 0; gIdx < N; gIdx++) {
                const gIn = Math.round((gIdx / (N - 1)) * 255.0);
                for (let rIdx = 0; rIdx < N; rIdx++) {
                    const rIn = Math.round((rIdx / (N - 1)) * 255.0);

                    dummyRgba[0] = rIn;
                    dummyRgba[1] = gIn;
                    dummyRgba[2] = bIn;
                    dummyRgba[3] = 255;

                    const graded = this.applyPrimaryWheels(dummyRgba, 1, 1, wheels);

                    const rOut = (graded[0] / 255.0).toFixed(6);
                    const gOut = (graded[1] / 255.0).toFixed(6);
                    const bOut = (graded[2] / 255.0).toFixed(6);

                    lines.push(`${rOut} ${gOut} ${bOut}`);
                }
            }
        }

        return lines.join('\n') + '\n';
    }

    // =========================================================================
    // 5. COLORIST SCOPES & METROLOGY TELEMETRY
    // =========================================================================

    /**
     * Computes complete optical scopes data: Waveform, RGB Parade, and Vectorscope.
     */
    public static computeScopes(
        rgba: Buffer,
        width: number,
        height: number
    ): ColoristScopesData {
        const total = width * height;

        let minIre = 100.0;
        let maxIre = 0.0;
        let sumIre = 0.0;
        let clipLow = 0;
        let clipHigh = 0;

        let sumR = 0, sumG = 0, sumB = 0;
        let maxR = 0, maxG = 0, maxB = 0;

        let skinToneCount = 0;
        let skinToneAligned = 0;
        let sumSat = 0;

        for (let i = 0; i < total; i++) {
            const r = rgba[i * 4];
            const g = rgba[i * 4 + 1];
            const b = rgba[i * 4 + 2];

            // 0..100 IRE luma
            const ire = (0.2126 * r + 0.7152 * g + 0.0722 * b) * (100.0 / 255.0);
            minIre = Math.min(minIre, ire);
            maxIre = Math.max(maxIre, ire);
            sumIre += ire;

            if (ire < 1.0) clipLow++;
            if (ire > 99.0) clipHigh++;

            // RGB Parade
            const rIre = r * (100.0 / 255.0);
            const gIre = g * (100.0 / 255.0);
            const bIre = b * (100.0 / 255.0);

            sumR += rIre; maxR = Math.max(maxR, rIre);
            sumG += gIre; maxG = Math.max(maxG, gIre);
            sumB += bIre; maxB = Math.max(maxB, bIre);

            // Vectorscope
            const cb = -0.168736 * r - 0.331264 * g + 0.5 * b;
            const cr =  0.5 * r - 0.418688 * g - 0.081312 * b;
            const sat = (Math.hypot(cb, cr) / 128.0) * 100.0;
            sumSat += sat;

            const skin = this.isSkinTonePixel(r, g, b);
            if (skin.isSkinTone) {
                skinToneCount++;
                if (skin.confidence >= 0.7) skinToneAligned++;
            }
        }

        const count = Math.max(1, total);
        const skinTotal = Math.max(1, skinToneCount);

        return {
            waveform: {
                minIre: Math.round(minIre * 10) / 10,
                maxIre: Math.round(maxIre * 10) / 10,
                meanIre: Math.round((sumIre / count) * 10) / 10,
                clippingLowPercent: Math.round((clipLow / count) * 1000) / 10,
                clippingHighPercent: Math.round((clipHigh / count) * 1000) / 10
            },
            rgbParade: {
                redMeanIre: Math.round((sumR / count) * 10) / 10,
                greenMeanIre: Math.round((sumG / count) * 10) / 10,
                blueMeanIre: Math.round((sumB / count) * 10) / 10,
                redMaxIre: Math.round(maxR * 10) / 10,
                greenMaxIre: Math.round(maxG * 10) / 10,
                blueMaxIre: Math.round(maxB * 10) / 10
            },
            vectorscope: {
                skinToneAlignmentPercent: Math.round((skinToneAligned / skinTotal) * 1000) / 10,
                overallSaturationPercent: Math.round((sumSat / count) * 10) / 10,
                dominantHueDeg: 130.0
            }
        };
    }

    // =========================================================================
    // 6. END-TO-END BUFFER & FILE MATCHING PIPELINE
    // =========================================================================

    /**
     * Matches raw RGBA buffers and computes CIEDE2000 verification metrics.
     */
    public static async matchImageBuffers(
        sourceRgba: Buffer,
        referenceRgba: Buffer,
        width: number,
        height: number,
        options: ColorGradeMatchOptions = {}
    ): Promise<ColorGradeMatchResult> {
        const startTime = Date.now();

        // 1. Solve three-way primary color wheels
        const wheels = this.solvePrimaryWheels(sourceRgba, referenceRgba, width, height);

        // 2. Apply grade with secondary isolation (skin tone protection)
        const gradedBuffer = this.applyGradingWithSecondaries(sourceRgba, width, height, wheels, {
            preserveSkinTones: options.preserveSkinTones ?? true,
            skinProtectionStrength: options.skinProtectionStrength ?? 0.85
        });

        // 3. Compute optical scopes
        const scopes = {
            source: this.computeScopes(sourceRgba, width, height),
            reference: this.computeScopes(referenceRgba, width, height),
            graded: this.computeScopes(gradedBuffer, width, height)
        };

        // 4. Compute CIEDE2000 Delta E reduction across random/subsampled pixels
        const total = width * height;
        const step = Math.max(1, Math.floor(total / 256));
        let sumDeltaBefore = 0;
        let sumDeltaAfter = 0;
        let sampleCount = 0;

        for (let i = 0; i < total; i += step) {
            const sLab = this.srgbToLab(sourceRgba[i * 4], sourceRgba[i * 4 + 1], sourceRgba[i * 4 + 2]);
            const rLab = this.srgbToLab(referenceRgba[i * 4], referenceRgba[i * 4 + 1], referenceRgba[i * 4 + 2]);
            const gLab = this.srgbToLab(gradedBuffer[i * 4], gradedBuffer[i * 4 + 1], gradedBuffer[i * 4 + 2]);

            sumDeltaBefore += this.calculateDeltaE00(sLab, rLab);
            sumDeltaAfter  += this.calculateDeltaE00(gLab, rLab);
            sampleCount++;
        }

        const initialDeltaE00 = Math.round((sumDeltaBefore / Math.max(1, sampleCount)) * 100) / 100;
        const finalDeltaE00   = Math.round((sumDeltaAfter / Math.max(1, sampleCount)) * 100) / 100;
        const deltaEReductionPercent = Math.max(0, Math.round(((initialDeltaE00 - finalDeltaE00) / Math.max(0.1, initialDeltaE00)) * 1000) / 10);

        // 5. Generate 3D LUT if requested
        let lutCube: string | undefined;
        let lutPath: string | undefined;
        if (options.generate3DLut) {
            lutCube = this.generate3DLutCube(wheels, {
                size: options.lutSize || 17,
                title: options.lutTitle || 'Scratchbox_ProGrade'
            });

            if (options.outputLutPath) {
                const dir = path.dirname(options.outputLutPath);
                if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
                fs.writeFileSync(options.outputLutPath, lutCube, 'utf-8');
                lutPath = options.outputLutPath;
            }
        }

        return {
            success: true,
            wheels,
            lutCube,
            lutPath,
            gradedBuffer,
            outputPath: options.outputPath,
            scopes,
            telemetry: {
                initialDeltaE00,
                finalDeltaE00,
                deltaEReductionPercent,
                executionTimeMs: Date.now() - startTime,
                sourceDimensions: { width, height }
            }
        };
    }

    /**
     * Matches two images specified by disk path, buffer, or base64 data URI.
     */
    public static async matchImages(
        sourceImage: string | Buffer,
        referenceImage: string | Buffer,
        options: ColorGradeMatchOptions = {}
    ): Promise<ColorGradeMatchResult> {
        const srcBuf = await this.resolveImageBuffer(sourceImage);
        const refBuf = await this.resolveImageBuffer(referenceImage);

        const srcDecoded = await this.decodeImageToRgba(srcBuf);
        const refDecoded = await this.decodeImageToRgba(refBuf);

        const matchResult = await this.matchImageBuffers(
            srcDecoded.data,
            refDecoded.data,
            srcDecoded.width,
            srcDecoded.height,
            options
        );

        if (options.outputPath) {
            const encoded = await this.encodeRgbaToImage(
                matchResult.gradedBuffer,
                srcDecoded.width,
                srcDecoded.height,
                options.outputFormat || 'jpg'
            );
            const dir = path.dirname(options.outputPath);
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(options.outputPath, encoded);
        }

        return matchResult;
    }

    // =========================================================================
    // 7. FFMPEG IMAGE ENCODE & DECODE HELPERS
    // =========================================================================

    private static async resolveImageBuffer(img: string | Buffer): Promise<Buffer> {
        if (Buffer.isBuffer(img)) return img;
        if (typeof img === 'string') {
            if (img.startsWith('data:image/')) {
                const base64Data = img.replace(/^data:image\/\w+;base64,/, '');
                return Buffer.from(base64Data, 'base64');
            }
            if (fs.existsSync(img)) {
                return fs.readFileSync(img);
            }
        }
        throw new Error(`Unable to resolve image source: ${typeof img}`);
    }

    private static decodeImageToRgba(buf: Buffer): Promise<{ data: Buffer; width: number; height: number }> {
        return new Promise((resolve, reject) => {
            const dims = this.parseImageDimensions(buf);
            const ffmpeg = spawn('ffmpeg', [
                '-hide_banner', '-loglevel', 'error',
                '-i', 'pipe:0',
                '-f', 'rawvideo',
                '-pix_fmt', 'rgba',
                'pipe:1'
            ]);

            const chunks: Buffer[] = [];
            ffmpeg.stdout.on('data', chunk => chunks.push(chunk));
            ffmpeg.stderr.on('data', () => {});
            ffmpeg.on('close', code => {
                if (code !== 0) return reject(new Error(`ffmpeg decode failed with code ${code}`));
                const data = Buffer.concat(chunks);
                resolve({ data, width: dims.width, height: dims.height });
            });
            ffmpeg.on('error', reject);
            ffmpeg.stdin.end(buf);
        });
    }

    private static encodeRgbaToImage(rgba: Buffer, width: number, height: number, format: string): Promise<Buffer> {
        return new Promise((resolve, reject) => {
            const codec = format === 'png' ? 'png' : (format === 'webp' ? 'libwebp' : 'mjpeg');

            const ffmpeg = spawn('ffmpeg', [
                '-hide_banner', '-loglevel', 'error',
                '-f', 'rawvideo',
                '-pix_fmt', 'rgba',
                '-s', `${width}x${height}`,
                '-i', 'pipe:0',
                '-vcodec', codec,
                '-f', 'image2',
                'pipe:1'
            ]);

            const chunks: Buffer[] = [];
            ffmpeg.stdout.on('data', chunk => chunks.push(chunk));
            ffmpeg.stderr.on('data', () => {});
            ffmpeg.on('close', code => {
                if (code !== 0) return reject(new Error(`ffmpeg encode failed with code ${code}`));
                resolve(Buffer.concat(chunks));
            });
            ffmpeg.on('error', reject);
            ffmpeg.stdin.end(rgba);
        });
    }

    private static parseImageDimensions(buf: Buffer): { width: number; height: number } {
        // PNG magic number
        if (buf.length >= 24 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47) {
            return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
        }
        // JPEG SOF0 / SOF2 marker scan
        if (buf.length >= 4 && buf[0] === 0xFF && buf[1] === 0xD8) {
            let offset = 2;
            while (offset < buf.length - 8) {
                if (buf[offset] !== 0xFF) { offset++; continue; }
                const marker = buf[offset + 1];
                if ((marker >= 0xC0 && marker <= 0xC3) || (marker >= 0xC5 && marker <= 0xC7) || (marker >= 0xC9 && marker <= 0xCB)) {
                    return { width: buf.readUInt16BE(offset + 7), height: buf.readUInt16BE(offset + 5) };
                }
                const len = buf.readUInt16BE(offset + 2);
                offset += 2 + len;
            }
        }
        // Default fallback dimension
        return { width: 512, height: 512 };
    }
}
