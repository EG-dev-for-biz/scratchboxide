/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import { describe, it, expect } from 'vitest';
import {
    ProColorGradeMatchingService,
    type PrimaryColorWheels,
    type ColorGradeMatchOptions,
    type ColoristScopesData
} from '../src/node/image/ProColorGradeMatchingService';

describe('ProColorGradeMatchingService (Hollywood-Grade Color Matching & Grading Engine)', () => {
    // 1. Color Science & Chromatic Adaptation
    describe('Color Science & Bradford Chromatic Adaptation', () => {
        it('converts RGB to XYZ and back with sub-1% numerical precision', () => {
            const colors: [number, number, number][] = [
                [255, 255, 255],
                [0, 0, 0],
                [128, 128, 128],
                [235, 180, 140], // Skin tone
                [45, 120, 70],   // Foliage green
                [30, 80, 190]    // Deep sky blue
            ];

            for (const [r, g, b] of colors) {
                const [x, y, z] = ProColorGradeMatchingService.srgbToXyz(r, g, b);
                const [rBack, gBack, bBack] = ProColorGradeMatchingService.xyzToSrgb(x, y, z);

                expect(Math.abs(r - rBack)).toBeLessThanOrEqual(2);
                expect(Math.abs(g - gBack)).toBeLessThanOrEqual(2);
                expect(Math.abs(b - bBack)).toBeLessThanOrEqual(2);
            }
        });

        it('computes Bradford Chromatic Adaptation Transform between D65 and 3200K Tungsten', () => {
            // A neutral gray under D65
            const [x, y, z] = ProColorGradeMatchingService.srgbToXyz(180, 180, 180);
            
            // Adapt to warm 3200K illuminant
            const [adaptedX, adaptedY, adaptedZ] = ProColorGradeMatchingService.applyBradfordCat(
                x, y, z,
                6500, // Source Kelvin (Daylight D65)
                3200  // Target Kelvin (Warm Tungsten)
            );

            const [rAdapted, gAdapted, bAdapted] = ProColorGradeMatchingService.xyzToSrgb(adaptedX, adaptedY, adaptedZ);
            
            // Warm adaptation should boost red and attenuate blue
            expect(rAdapted).toBeGreaterThan(180);
            expect(bAdapted).toBeLessThan(180);
        });

        it('calculates CIEDE2000 (Delta E 00) with perceptual accuracy', () => {
            // Identical colors should have Delta E == 0
            const lab1: [number, number, number] = [50, 20, -10];
            const deltaZero = ProColorGradeMatchingService.calculateDeltaE00(lab1, lab1);
            expect(deltaZero).toBeCloseTo(0, 4);

            // Subtly different colors should have small Delta E (< 2.0 is just noticeable)
            const lab2: [number, number, number] = [51, 21, -9];
            const deltaSmall = ProColorGradeMatchingService.calculateDeltaE00(lab1, lab2);
            expect(deltaSmall).toBeGreaterThan(0);
            expect(deltaSmall).toBeLessThan(3.0);

            // Large difference
            const labOpposite: [number, number, number] = [90, -40, 50];
            const deltaLarge = ProColorGradeMatchingService.calculateDeltaE00(lab1, labOpposite);
            expect(deltaLarge).toBeGreaterThan(40.0);
        });
    });

    // 2. Three-Way Primary Color Wheels (Lift, Gamma, Gain, Offset)
    describe('Three-Way Primary Color Wheels Engine', () => {
        it('analytically solves Lift, Gamma, Gain, and Offset between cold and warm imagery', () => {
            const width = 32;
            const height = 32;
            const total = width * height;

            // Cold source plate (biased blue, low contrast)
            const coldPlate = Buffer.alloc(total * 4);
            // Warm reference plate (golden hour, rich contrast)
            const warmPlate = Buffer.alloc(total * 4);

            for (let i = 0; i < total; i++) {
                const normY = Math.floor(i / width) / height;
                const lum = Math.round(normY * 220 + 20);

                // Cold plate: high blue in shadows and highlights
                coldPlate[i * 4] = Math.min(255, Math.round(lum * 0.85));
                coldPlate[i * 4 + 1] = Math.min(255, Math.round(lum * 0.95));
                coldPlate[i * 4 + 2] = Math.min(255, Math.round(lum * 1.25));
                coldPlate[i * 4 + 3] = 255;

                // Warm plate: rich amber highlights, warm deep shadows
                warmPlate[i * 4] = Math.min(255, Math.round(lum * 1.3));
                warmPlate[i * 4 + 1] = Math.min(255, Math.round(lum * 1.05));
                warmPlate[i * 4 + 2] = Math.min(255, Math.round(lum * 0.7));
                warmPlate[i * 4 + 3] = 255;
            }

            const wheels: PrimaryColorWheels = ProColorGradeMatchingService.solvePrimaryWheels(
                coldPlate,
                warmPlate,
                width,
                height
            );

            // Gain (highlights) must push Red > 1.0 and Blue < 1.0
            expect(wheels.gain.r).toBeGreaterThan(1.0);
            expect(wheels.gain.b).toBeLessThan(1.0);

            // Gamma (midtones) should be well-behaved
            expect(wheels.gamma.r).toBeGreaterThan(0.2);
            expect(wheels.gamma.r).toBeLessThan(3.0);
        });

        it('applies primary wheels with contrast and pivot to transform pixels', () => {
            const inputRgba = Buffer.from([
                20, 20, 40, 255,   // Shadow pixel
                128, 128, 128, 255, // Midtone pixel
                220, 220, 240, 255  // Highlight pixel
            ]);

            const wheels: PrimaryColorWheels = {
                lift: { r: 0.05, g: 0.0, b: -0.05, master: 0.0 },
                gamma: { r: 1.15, g: 1.0, b: 0.85, master: 1.0 },
                gain: { r: 1.2, g: 1.05, b: 0.75, master: 1.0 },
                offset: { r: 0.0, g: 0.0, b: 0.0, master: 0.0 },
                contrast: 1.0,
                pivot: 0.435
            };

            const outputRgba = ProColorGradeMatchingService.applyPrimaryWheels(inputRgba, 3, 1, wheels);

            // Shadow pixel: red lifted, blue attenuated
            expect(outputRgba[0]).toBeGreaterThan(inputRgba[0]);
            expect(outputRgba[2]).toBeLessThan(inputRgba[2]);

            // Highlight pixel: red gained, blue reduced
            expect(outputRgba[8]).toBeGreaterThan(inputRgba[8]);
            expect(outputRgba[10]).toBeLessThan(inputRgba[10]);
        });
    });

    // 3. Secondary Isolation & Vectorscope Skin Tone Line
    describe('Secondary Isolation & Skin Tone Line Preservation', () => {
        it('accurately identifies pixels lying along the Vectorscope Skin Tone Line (~130 deg in dCb, dCr)', () => {
            // True skin tone sample (Caucasian/Mediterranean/Asian/African melanin range)
            const skinColor: [number, number, number] = [215, 160, 125];
            const isSkin = ProColorGradeMatchingService.isSkinTonePixel(skinColor[0], skinColor[1], skinColor[2]);
            expect(isSkin.isSkinTone).toBe(true);
            expect(isSkin.confidence).toBeGreaterThan(0.7);

            // Foliage green should NOT be skin tone
            const greenLeaf: [number, number, number] = [40, 160, 50];
            const isGreenSkin = ProColorGradeMatchingService.isSkinTonePixel(greenLeaf[0], greenLeaf[1], greenLeaf[2]);
            expect(isGreenSkin.isSkinTone).toBe(false);

            // Deep sky cyan should NOT be skin tone
            const skyCyan: [number, number, number] = [70, 170, 240];
            const isSkySkin = ProColorGradeMatchingService.isSkinTonePixel(skyCyan[0], skyCyan[1], skyCyan[2]);
            expect(isSkySkin.isSkinTone).toBe(false);
        });

        it('protects skin tones from radical green or magenta grading shifts', () => {
            const width = 2;
            const height = 2;
            const rgba = Buffer.from([
                210, 155, 120, 255, // Skin pixel
                215, 160, 125, 255, // Skin pixel
                50, 180, 60, 255,   // Grass pixel
                60, 140, 220, 255   // Sky pixel
            ]);

            // Radical green matrix grade
            const radicalGreenGrade: PrimaryColorWheels = {
                lift: { r: -0.1, g: 0.2, b: -0.1, master: 0.0 },
                gamma: { r: 0.7, g: 1.4, b: 0.7, master: 1.0 },
                gain: { r: 0.6, g: 1.5, b: 0.6, master: 1.0 },
                offset: { r: 0.0, g: 0.0, b: 0.0, master: 0.0 },
                contrast: 1.0,
                pivot: 0.435
            };

            // Grade WITH skin tone protection
            const protectedRgba = ProColorGradeMatchingService.applyGradingWithSecondaries(
                rgba,
                width,
                height,
                radicalGreenGrade,
                { preserveSkinTones: true, skinProtectionStrength: 0.9 }
            );

            // Grade WITHOUT skin tone protection
            const unprotectedRgba = ProColorGradeMatchingService.applyGradingWithSecondaries(
                rgba,
                width,
                height,
                radicalGreenGrade,
                { preserveSkinTones: false }
            );

            // Protected skin pixel should retain healthy red/green ratio (R > G)
            expect(protectedRgba[0]).toBeGreaterThan(protectedRgba[1]);

            // Unprotected skin pixel gets corrupted by green gain (G >= R)
            expect(unprotectedRgba[1]).toBeGreaterThanOrEqual(unprotectedRgba[0]);
        });
    });

    // 4. Industry-Standard 3D LUT (.cube) Generation
    describe('3D LUT (.cube) Generation & Export', () => {
        it('synthesizes a valid Adobe/ACES/Resolve-compliant .cube 3D LUT at size 17x17x17', () => {
            const wheels: PrimaryColorWheels = {
                lift: { r: 0.02, g: 0.0, b: -0.02, master: 0.0 },
                gamma: { r: 1.1, g: 1.0, b: 0.9, master: 1.0 },
                gain: { r: 1.15, g: 1.02, b: 0.88, master: 1.0 },
                offset: { r: 0.01, g: 0.0, b: -0.01, master: 0.0 },
                contrast: 1.0,
                pivot: 0.435
            };

            const lutString = ProColorGradeMatchingService.generate3DLutCube(wheels, {
                size: 17,
                title: 'Scratchbox_Warm_Golden_Match'
            });

            // Format check
            expect(lutString).toContain('TITLE "Scratchbox_Warm_Golden_Match"');
            expect(lutString).toContain('LUT_3D_SIZE 17');
            expect(lutString).toContain('DOMAIN_MIN 0.0 0.0 0.0');
            expect(lutString).toContain('DOMAIN_MAX 1.0 1.0 1.0');

            // 17^3 = 4913 RGB lines
            const lines = lutString.trim().split('\n').filter(l => !l.startsWith('#') && !l.startsWith('TITLE') && !l.startsWith('LUT_') && !l.startsWith('DOMAIN_') && l.trim().length > 0);
            expect(lines.length).toBe(17 * 17 * 17);

            // Verify first line (black point mapping) and last line (white point mapping)
            const [r0, g0, b0] = lines[0].split(/\s+/).map(Number);
            expect(r0).toBeGreaterThanOrEqual(0.0);
            expect(b0).toBeGreaterThanOrEqual(0.0);

            const [rMax, gMax, bMax] = lines[lines.length - 1].split(/\s+/).map(Number);
            expect(rMax).toBeGreaterThan(0.9);
            expect(gMax).toBeGreaterThan(0.9);
        });
    });

    // 5. Colorist Scopes & Metrology Telemetry
    describe('Colorist Scopes & Quality Metrology', () => {
        it('computes complete scopes telemetry: Waveform, RGB Parade, Vectorscope, and Delta E', () => {
            const width = 16;
            const height = 16;
            const total = width * height;
            const rgba = Buffer.alloc(total * 4);

            for (let i = 0; i < total; i++) {
                rgba[i * 4] = (i % 16) * 16;
                rgba[i * 4 + 1] = Math.floor(i / 16) * 16;
                rgba[i * 4 + 2] = 128;
                rgba[i * 4 + 3] = 255;
            }

            const scopes: ColoristScopesData = ProColorGradeMatchingService.computeScopes(rgba, width, height);

            // Waveform IRE levels [0, 100]
            expect(scopes.waveform.minIre).toBeGreaterThanOrEqual(0);
            expect(scopes.waveform.maxIre).toBeLessThanOrEqual(100);
            expect(scopes.waveform.meanIre).toBeGreaterThan(0);

            // RGB Parade IRE metrics
            expect(scopes.rgbParade.redMeanIre).toBeGreaterThan(0);
            expect(scopes.rgbParade.greenMeanIre).toBeGreaterThan(0);
            expect(scopes.rgbParade.blueMeanIre).toBeGreaterThan(0);

            // Vectorscope stats
            expect(scopes.vectorscope.skinToneAlignmentPercent).toBeGreaterThanOrEqual(0);
            expect(scopes.vectorscope.skinToneAlignmentPercent).toBeLessThanOrEqual(100);
            expect(scopes.vectorscope.overallSaturationPercent).toBeGreaterThan(0);
        });
    });

    // 6. End-to-End Grade Matching Pipeline
    describe('End-to-End Grade Matching Pipeline', () => {
        it('matches a cool overcast source image to a warm sunset reference image and reduces Delta E 00', async () => {
            const width = 32;
            const height = 32;
            const total = width * height;

            const sourceRgba = Buffer.alloc(total * 4);
            const targetRefRgba = Buffer.alloc(total * 4);

            for (let i = 0; i < total; i++) {
                const norm = i / total;
                // Source: cool blue-cyan overcast
                sourceRgba[i * 4] = Math.min(255, Math.round(norm * 140 + 30));
                sourceRgba[i * 4 + 1] = Math.min(255, Math.round(norm * 160 + 40));
                sourceRgba[i * 4 + 2] = Math.min(255, Math.round(norm * 210 + 60));
                sourceRgba[i * 4 + 3] = 255;

                // Target reference: Mediterranean warm sunset
                targetRefRgba[i * 4] = Math.min(255, Math.round(norm * 220 + 50));
                targetRefRgba[i * 4 + 1] = Math.min(255, Math.round(norm * 150 + 30));
                targetRefRgba[i * 4 + 2] = Math.min(255, Math.round(norm * 90 + 10));
                targetRefRgba[i * 4 + 3] = 255;
            }

            const matchResult = await ProColorGradeMatchingService.matchImageBuffers(
                sourceRgba,
                targetRefRgba,
                width,
                height,
                {
                    generate3DLut: true,
                    lutSize: 17,
                    preserveSkinTones: true
                }
            );

            expect(matchResult.success).toBe(true);
            expect(matchResult.wheels).toBeDefined();
            expect(matchResult.lutCube).toBeDefined();
            expect(matchResult.lutCube).toContain('LUT_3D_SIZE 17');

            // Delta E 00 must be substantially reduced between graded output and reference (> 30% reduction)
            expect(matchResult.telemetry.initialDeltaE00).toBeGreaterThan(matchResult.telemetry.finalDeltaE00);
            expect(matchResult.telemetry.deltaEReductionPercent).toBeGreaterThan(30.0);

            // Output buffer must exist and have same dimensions
            expect(matchResult.gradedBuffer).toBeDefined();
            expect(matchResult.gradedBuffer.length).toBe(total * 4);

            // Verify graded buffer is now warmer (Red > Blue)
            let sumR = 0, sumB = 0;
            for (let i = 0; i < total; i++) {
                sumR += matchResult.gradedBuffer[i * 4];
                sumB += matchResult.gradedBuffer[i * 4 + 2];
            }
            expect(sumR).toBeGreaterThan(sumB);
        });
    });

    describe('Measured, size-safe metrics', () => {
        const gradient = (w: number, h: number, f: (n: number) => [number, number, number]) => {
            const buf = Buffer.alloc(w * h * 4);
            for (let i = 0; i < w * h; i++) {
                const [r, g, b] = f(i / (w * h));
                buf[i * 4] = r; buf[i * 4 + 1] = g; buf[i * 4 + 2] = b; buf[i * 4 + 3] = 255;
            }
            return buf;
        };
        /** Nearest-neighbour 2x upscale: the same tonal distribution at four times the pixels. */
        const upscale2x = (src: Buffer, w: number, h: number) => {
            const out = Buffer.alloc(w * h * 16);
            for (let y = 0; y < h * 2; y++) for (let x = 0; x < w * 2; x++) {
                src.copy(out, (y * w * 2 + x) * 4, ((y >> 1) * w + (x >> 1)) * 4, ((y >> 1) * w + (x >> 1)) * 4 + 4);
            }
            return out;
        };
        const source = gradient(16, 16, n => [Math.round(30 + n * 140), Math.round(40 + n * 160), Math.round(60 + n * 190)]);
        const reference = gradient(16, 16, n => [Math.round(50 + n * 200), Math.round(30 + n * 150), Math.round(10 + n * 90)]);

        it('solves the wheels from each image over its own pixels, so a differently sized reference gives the same grade', () => {
            const same = ProColorGradeMatchingService.solvePrimaryWheels(source, reference, 16, 16);
            const bigger = ProColorGradeMatchingService.solvePrimaryWheels(source, upscale2x(reference, 16, 16), 16, 16, 32, 32);
            expect(bigger).toEqual(same);
            expect(() => ProColorGradeMatchingService.solvePrimaryWheels(source, upscale2x(reference, 16, 16), 16, 16)).toThrow(/reference buffer/);
        });

        it('averages CIEDE2000 over every pixel and states the basis, resampling a differently sized reference', async () => {
            const same = await ProColorGradeMatchingService.matchImageBuffers(source, reference, 16, 16, { preserveSkinTones: false });
            expect(same.telemetry.deltaESampleCount).toBe(256);
            expect(same.telemetry.deltaESampleStride).toBe(1);
            expect(same.telemetry.deltaEBasis).toBe('same-size per-pixel');

            const bigRef = upscale2x(reference, 16, 16);
            const resized = await ProColorGradeMatchingService.matchImageBuffers(source, bigRef, 16, 16, { preserveSkinTones: false }, { width: 32, height: 32 });
            expect(resized.telemetry.deltaEBasis).toBe('per-pixel vs reference resampled to source size');
            expect(resized.telemetry.referenceDimensions).toEqual({ width: 32, height: 32 });
            expect(resized.scopes.reference.waveform.meanIre).toBeCloseTo(same.scopes.reference.waveform.meanIre, 1);
            expect(resized.telemetry.finalDeltaE00).toBeLessThan(resized.telemetry.initialDeltaE00);
        });

        it('measures the dominant vectorscope hue instead of reporting a fixed 130 degrees', () => {
            const blue = gradient(8, 8, () => [20, 40, 220]);
            const hue = ProColorGradeMatchingService.computeScopes(blue, 8, 8).vectorscope.dominantHueDeg!;
            const cb = -0.168736 * 20 - 0.331264 * 40 + 0.5 * 220;
            const cr = 0.5 * 20 - 0.418688 * 40 - 0.081312 * 220;
            let expected = Math.atan2(cr, cb) * 180 / Math.PI;
            if (expected < 0) expected += 360;
            expect(Math.abs(hue - expected)).toBeLessThanOrEqual(2.5);
            expect(hue).not.toBe(130);
            expect(ProColorGradeMatchingService.computeScopes(gradient(8, 8, () => [128, 128, 128]), 8, 8).vectorscope.dominantHueDeg).toBeNull();
        });
    });
});
