/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import * as fs from 'fs';
import * as path from 'path';
import { spawn } from 'child_process';
import { decodeImageToRgba, encodeRgbaToJpeg, encodeRgbaToPng, resolveFfmpegPath } from '../image-codec-ffmpeg';
import { MissingInputError } from '../../common/errors/pipeline-errors';

export interface ImageColorTransferRequest {
    /**
     * Path, buffer, or base64 data URI of the reference image containing desired lighting & palette look.
     */
    referenceImage: string | Buffer;

    /**
     * Path, buffer, or base64 data URI of the target image whose geometric structure must be 100% locked.
     */
    targetImage: string | Buffer;

    /**
     * Optional contrast curve applied after the transfer: 'cinematic' (S-curve) or 'high-contrast'. None by default.
     */
    contrastCurve?: 'natural' | 'cinematic' | 'high-contrast' | 'muted';

    /**
     * Whether to detect and protect human skin tones from extreme color grading tinting.
     * Defaults to true.
     */
    preserveSkinTones?: boolean;

    /**
     * Target output format. Defaults to 'jpg'.
     */
    outputFormat?: 'png' | 'jpg' | 'webp';

    /**
     * Optional output file path. If specified, the recolored image is saved to disk.
     */
    outputPath?: string;
}

/** Mean and standard deviation of an image in CIELAB, as measured by the transfer. */
export interface LabStatistics {
    mean: [number, number, number];
    std: [number, number, number];
}

export interface ImageColorTransferResult {
    success: boolean;
    outputImagePath?: string;
    outputBuffer: Buffer;
    /** The measured colour statistics the transfer mapped between (reference onto target). */
    referenceStatistics: LabStatistics;
    targetStatistics: LabStatistics;
    telemetry: {
        executionTimeMs: number;
        mode: 'local-cielab';
        preservedGeometry: boolean;
        dimensions: { width: number; height: number };
    };
}

export interface LocalCielabOptions {
    preserveSkinTones?: boolean;
    contrastCurve?: 'natural' | 'cinematic' | 'high-contrast' | 'muted';
    intensity?: number; // 0.0 (no change) to 1.0 (full transfer), default 1.0
    outputFormat?: 'png' | 'jpg' | 'webp';
}

/**
 * 2D image-to-image colour transfer: Reinhard et al. statistical transfer in CIELAB, computed from the two images'
 * own pixels with every pixel staying where it is. No palette is invented: the result reports the statistics it
 * measured. (Prompt-based transfer with an image model is the Nano Banana Method 2 plan in nano-banana-color-service,
 * which needs the palette a model read from the reference.)
 */
export class ImageColorTransferService {

    /**
     * Transfers the reference image's colour statistics onto the target image. Throws when an image cannot be read
     * or decoded.
     */
    static async transferColor(request: ImageColorTransferRequest): Promise<ImageColorTransferResult> {
        const startTime = Date.now();
        const targetBuf = await this.resolveImageBuffer(request.targetImage, 'targetImage');
        const refBuf = await this.resolveImageBuffer(request.referenceImage, 'referenceImage');

        const transfer = await this.transferColorLocalCielabWithStats(targetBuf, refBuf, {
            preserveSkinTones: request.preserveSkinTones ?? true,
            contrastCurve: request.contrastCurve,
            outputFormat: request.outputFormat || 'jpg'
        });

        const outPath = request.outputPath;
        if (outPath) {
            fs.mkdirSync(path.dirname(outPath), { recursive: true });
            fs.writeFileSync(outPath, transfer.buffer);
        }

        return {
            success: true,
            outputImagePath: outPath,
            outputBuffer: transfer.buffer,
            referenceStatistics: transfer.reference,
            targetStatistics: transfer.target,
            telemetry: {
                executionTimeMs: Date.now() - startTime,
                mode: 'local-cielab',
                preservedGeometry: true,
                dimensions: { width: transfer.width, height: transfer.height }
            }
        };
    }

    /**
     * High-speed, offline Reinhard et al. statistical color transfer in CIELAB space.
     * Guaranteed 100% pixel geometry alignment with zero deformation or hallucination.
     */
    static async transferColorLocalCielab(
        targetImage: string | Buffer,
        referenceImage: string | Buffer,
        options: LocalCielabOptions = {}
    ): Promise<Buffer> {
        return (await this.transferColorLocalCielabWithStats(targetImage, referenceImage, options)).buffer;
    }

    private static async transferColorLocalCielabWithStats(
        targetImage: string | Buffer,
        referenceImage: string | Buffer,
        options: LocalCielabOptions = {}
    ): Promise<{ buffer: Buffer; width: number; height: number; reference: LabStatistics; target: LabStatistics }> {
        const targetBuf = await this.resolveImageBuffer(targetImage, 'targetImage');
        const refBuf = await this.resolveImageBuffer(referenceImage, 'referenceImage');

        // Decode both images to raw RGBA at their real sizes (the shared codec reads the size from the file)
        const targetDecoded = await decodeImageToRgba(targetBuf);
        const refDecoded = await decodeImageToRgba(refBuf);
        const targetRgba = { data: targetDecoded.rgba, width: targetDecoded.width, height: targetDecoded.height };
        const refRgba = { data: refDecoded.rgba, width: refDecoded.width, height: refDecoded.height };

        const tPixels = targetRgba.width * targetRgba.height;
        const rPixels = refRgba.width * refRgba.height;

        // Convert target and reference pixels to CIELAB and accumulate statistics
        let tSumL = 0, tSumA = 0, tSumB = 0;
        const tLab = new Float32Array(tPixels * 3);

        for (let i = 0; i < tPixels; i++) {
            const r = targetRgba.data[i * 4];
            const g = targetRgba.data[i * 4 + 1];
            const b = targetRgba.data[i * 4 + 2];
            const [L, a, bStar] = this.srgbToLab(r, g, b);
            tLab[i * 3] = L;
            tLab[i * 3 + 1] = a;
            tLab[i * 3 + 2] = bStar;
            tSumL += L;
            tSumA += a;
            tSumB += bStar;
        }

        const tMeanL = tSumL / tPixels;
        const tMeanA = tSumA / tPixels;
        const tMeanB = tSumB / tPixels;

        let tVarL = 0, tVarA = 0, tVarB = 0;
        for (let i = 0; i < tPixels; i++) {
            tVarL += (tLab[i * 3] - tMeanL) ** 2;
            tVarA += (tLab[i * 3 + 1] - tMeanA) ** 2;
            tVarB += (tLab[i * 3 + 2] - tMeanB) ** 2;
        }
        const tStdL = Math.max(Math.sqrt(tVarL / tPixels), 0.001);
        const tStdA = Math.max(Math.sqrt(tVarA / tPixels), 0.001);
        const tStdB = Math.max(Math.sqrt(tVarB / tPixels), 0.001);

        // Reference statistics
        let rSumL = 0, rSumA = 0, rSumB = 0;
        const rLab = new Float32Array(rPixels * 3);

        for (let i = 0; i < rPixels; i++) {
            const r = refRgba.data[i * 4];
            const g = refRgba.data[i * 4 + 1];
            const b = refRgba.data[i * 4 + 2];
            const [L, a, bStar] = this.srgbToLab(r, g, b);
            rLab[i * 3] = L;
            rLab[i * 3 + 1] = a;
            rLab[i * 3 + 2] = bStar;
            rSumL += L;
            rSumA += a;
            rSumB += bStar;
        }

        const rMeanL = rSumL / rPixels;
        const rMeanA = rSumA / rPixels;
        const rMeanB = rSumB / rPixels;

        let rVarL = 0, rVarA = 0, rVarB = 0;
        for (let i = 0; i < rPixels; i++) {
            rVarL += (rLab[i * 3] - rMeanL) ** 2;
            rVarA += (rLab[i * 3 + 1] - rMeanA) ** 2;
            rVarB += (rLab[i * 3 + 2] - rMeanB) ** 2;
        }
        const rStdL = Math.max(Math.sqrt(rVarL / rPixels), 0.001);
        const rStdA = Math.max(Math.sqrt(rVarA / rPixels), 0.001);
        const rStdB = Math.max(Math.sqrt(rVarB / rPixels), 0.001);

        // Scale factors
        const scaleL = rStdL / tStdL;
        const scaleA = rStdA / tStdA;
        const scaleB = rStdB / tStdB;

        const preserveSkin = options.preserveSkinTones ?? true;
        const intensity = options.intensity ?? 1.0;

        const outRgba = Buffer.alloc(tPixels * 4);

        for (let i = 0; i < tPixels; i++) {
            const origL = tLab[i * 3];
            const origA = tLab[i * 3 + 1];
            const origB = tLab[i * 3 + 2];

            // Reinhard normalization & reference alignment
            let newL = (origL - tMeanL) * scaleL + rMeanL;
            let newA = (origA - tMeanA) * scaleA + rMeanA;
            let newB = (origB - tMeanB) * scaleB + rMeanB;

            // Optional contrast curve modification
            if (options.contrastCurve === 'cinematic') {
                const normL = Math.max(0, Math.min(100, newL)) / 100.0;
                const sL = normL < 0.5 ? 2 * normL * normL : 1 - 2 * (1 - normL) * (1 - normL);
                newL = sL * 100.0;
            } else if (options.contrastCurve === 'high-contrast') {
                newL = Math.pow(Math.max(0, Math.min(100, newL)) / 100.0, 1.25) * 100.0;
            }

            // Skin tone detection in CIELAB
            let skinWeight = 0;
            if (preserveSkin) {
                if (origL >= 25 && origL <= 85 && origA >= 6 && origA <= 28 && origB >= 8 && origB <= 35) {
                    skinWeight = 0.75;
                }
            }

            const blend = (1.0 - skinWeight) * intensity;
            const finalL = origL * (1 - blend) + newL * blend;
            const finalA = origA * (1 - blend) + newA * blend;
            const finalB = origB * (1 - blend) + newB * blend;

            const [r, g, b] = this.labToSrgb(finalL, finalA, finalB);

            outRgba[i * 4] = r;
            outRgba[i * 4 + 1] = g;
            outRgba[i * 4 + 2] = b;
            outRgba[i * 4 + 3] = targetRgba.data[i * 4 + 3];
        }

        // Encode back to image
        const buffer = await this.encodeRgbaToImage(outRgba, targetRgba.width, targetRgba.height, options.outputFormat || 'jpg');
        return {
            buffer,
            width: targetRgba.width,
            height: targetRgba.height,
            reference: { mean: [rMeanL, rMeanA, rMeanB], std: [rStdL, rStdA, rStdB] },
            target: { mean: [tMeanL, tMeanA, tMeanB], std: [tStdL, tStdA, tStdB] }
        };
    }

    // =========================================================================
    // COLOR SPACE CONVERSION & FFMPEG HELPERS
    // =========================================================================

    private static srgbToLab(r: number, g: number, b: number): [number, number, number] {
        let rLin = r / 255.0;
        let gLin = g / 255.0;
        let bLin = b / 255.0;

        rLin = rLin > 0.04045 ? Math.pow((rLin + 0.055) / 1.055, 2.4) : rLin / 12.92;
        gLin = gLin > 0.04045 ? Math.pow((gLin + 0.055) / 1.055, 2.4) : gLin / 12.92;
        bLin = bLin > 0.04045 ? Math.pow((bLin + 0.055) / 1.055, 2.4) : bLin / 12.92;

        const x = (rLin * 0.4124564 + gLin * 0.3575761 + bLin * 0.1804375) / 0.95047;
        const y = (rLin * 0.2126729 + gLin * 0.7151522 + bLin * 0.0721750) / 1.00000;
        const z = (rLin * 0.0193339 + gLin * 0.1191920 + bLin * 0.9503041) / 1.08883;

        const fx = x > 0.008856 ? Math.cbrt(x) : (7.787 * x) + (16.0 / 116.0);
        const fy = y > 0.008856 ? Math.cbrt(y) : (7.787 * y) + (16.0 / 116.0);
        const fz = z > 0.008856 ? Math.cbrt(z) : (7.787 * z) + (16.0 / 116.0);

        const L = (116.0 * fy) - 16.0;
        const a = 500.0 * (fx - fy);
        const bStar = 200.0 * (fy - fz);

        return [L, a, bStar];
    }

    private static labToSrgb(L: number, a: number, bStar: number): [number, number, number] {
        const fy = (L + 16.0) / 116.0;
        const fx = a / 500.0 + fy;
        const fz = fy - bStar / 200.0;

        const fx3 = fx * fx * fx;
        const fz3 = fz * fz * fz;

        const x = 0.95047 * (fx3 > 0.008856 ? fx3 : (fx - 16.0 / 116.0) / 7.787);
        const y = 1.00000 * (L > 8.0 ? Math.pow((L + 16.0) / 116.0, 3) : L / 903.3);
        const z = 1.08883 * (fz3 > 0.008856 ? fz3 : (fz - 16.0 / 116.0) / 7.787);

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

    private static async resolveImageBuffer(img: string | Buffer, arg: string): Promise<Buffer> {
        if (Buffer.isBuffer(img)) return img;
        if (typeof img === 'string') {
            if (img.startsWith('data:image/')) {
                const base64Data = img.replace(/^data:image\/\w+;base64,/, '');
                return Buffer.from(base64Data, 'base64');
            }
            if (fs.existsSync(img)) {
                return fs.readFileSync(img);
            }
            throw new MissingInputError('image colour transfer', arg, `${img} is not a readable image file or data URI`);
        }
        throw new MissingInputError('image colour transfer', arg, 'give a path, a data URI or the image bytes');
    }

    private static async encodeRgbaToImage(rgba: Buffer, width: number, height: number, format: string): Promise<Buffer> {
        if (format === 'png') return encodeRgbaToPng(rgba, width, height);
        if (format !== 'webp') return encodeRgbaToJpeg(rgba, width, height);
        return new Promise((resolve, reject) => {
            const ffmpeg = spawn(resolveFfmpegPath(), [
                '-hide_banner', '-loglevel', 'error',
                '-f', 'rawvideo',
                '-pix_fmt', 'rgba',
                '-s', `${width}x${height}`,
                '-i', 'pipe:0',
                '-c:v', 'libwebp',
                '-f', 'webp',
                'pipe:1'
            ]);

            const chunks: Buffer[] = [];
            ffmpeg.stdout.on('data', chunk => chunks.push(chunk));
            ffmpeg.stderr.on('data', () => {});
            ffmpeg.on('close', code => {
                if (code !== 0) return reject(new Error(`ffmpeg WebP encode failed with code ${code}`));
                resolve(Buffer.concat(chunks));
            });
            ffmpeg.on('error', err => reject(new Error(`WebP output needs ffmpeg (${err.message})`)));
            ffmpeg.stdin.end(rgba);
        });
    }
}

export const transferImageColor = ImageColorTransferService.transferColor.bind(ImageColorTransferService);
