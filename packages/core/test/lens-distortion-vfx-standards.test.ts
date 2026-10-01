/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import {
    VfxLensInterchangeService,
    type VfxLensMetadata
} from '../src/common/optics/VfxLensInterchangeService';
import {
    type LensDistortionParams,
    type CameraSolve
} from '../src/common/vfx-plate-protocol';
import {
    LensDistortionEffect,
    LENS_OPTICAL_PRESETS,
    calculateBrownConradyFromFocalLength
} from '../src/browser/generative-canvas/services/optics/LensDistortionEffect';
import { VfxPlateMatchmoveService } from '../src/browser/generative-canvas/services/video/VfxPlateMatchmoveService';
import { createDefaultToolRegistry } from '../src/node/gemini/tool-registry';

describe('VFX Professional Lens Distortion Standards Suite', () => {

    describe('Pillar 1: 2D Newton-Raphson Analytical Inversion & Roundtrip Convergence', () => {
        it('roundtrips standard barrel distortion with sub-sub-pixel precision (< 1e-5)', () => {
            const params: LensDistortionParams = {
                k1: -0.05,
                k2: 0.01,
                p1: 0.0,
                p2: 0.0,
                model: 'brown_conrady'
            };

            const testCoords: Array<[number, number]> = [
                [0.0, 0.0],
                [0.2, 0.15],
                [-0.3, 0.25],
                [0.4, -0.35],
                [-0.45, -0.45]
            ];

            for (const [x, y] of testCoords) {
                const [dx, dy] = VfxPlateMatchmoveService.distortPoint(x, y, params);
                const [ux, uy] = VfxPlateMatchmoveService.undistortPoint(dx, dy, params);

                expect(ux).toBeCloseTo(x, 5);
                expect(uy).toBeCloseTo(y, 5);
            }
        });

        it('roundtrips high-order radial terms (k3, k4 mustache distortion)', () => {
            const params: LensDistortionParams = {
                k1: -0.08,
                k2: 0.02,
                k3: -0.003,
                k4: 0.0005,
                p1: 0.0005,
                p2: -0.0005,
                model: 'brown_conrady'
            };

            const [x, y] = [0.35, -0.28];
            const [dx, dy] = VfxPlateMatchmoveService.distortPoint(x, y, params);
            const [ux, uy] = VfxPlateMatchmoveService.undistortPoint(dx, dy, params);

            expect(ux).toBeCloseTo(x, 5);
            expect(uy).toBeCloseTo(y, 5);
        });

        it('roundtrips pincushion distortion (telephoto prime)', () => {
            const params: LensDistortionParams = {
                k1: 0.025,
                k2: 0.004,
                p1: 0.0,
                p2: 0.0,
                model: 'brown_conrady'
            };

            const [x, y] = [0.3, 0.3];
            const [dx, dy] = VfxPlateMatchmoveService.distortPoint(x, y, params);
            const [ux, uy] = VfxPlateMatchmoveService.undistortPoint(dx, dy, params);

            expect(ux).toBeCloseTo(x, 5);
            expect(uy).toBeCloseTo(y, 5);
        });

        it('roundtrips asymmetric optical center shift (decentered lens mount)', () => {
            const params: LensDistortionParams = {
                k1: -0.04,
                k2: 0.006,
                opticalCenter: [0.53, 0.47],
                model: 'brown_conrady'
            };

            const [x, y] = [0.25, -0.2];
            const [dx, dy] = VfxPlateMatchmoveService.distortPoint(x, y, params);
            const [ux, uy] = VfxPlateMatchmoveService.undistortPoint(dx, dy, params);

            expect(ux).toBeCloseTo(x, 5);
            expect(uy).toBeCloseTo(y, 5);
        });

        it('roundtrips cinema anamorphic 2x squeeze with cross-axis distortion', () => {
            const params: LensDistortionParams = {
                k1: -0.045,
                k2: 0.008,
                anamorphicSqueeze: 2.0,
                squeezeFactor: 2.0,
                model: 'brown_conrady'
            };

            const [x, y] = [0.4, 0.2];
            const [dx, dy] = VfxPlateMatchmoveService.distortPoint(x, y, params);
            const [ux, uy] = VfxPlateMatchmoveService.undistortPoint(dx, dy, params);

            expect(ux).toBeCloseTo(x, 4);
            expect(uy).toBeCloseTo(y, 4);
        });

        it('roundtrips Kannala-Brandt fisheye model via 1D Newton-Raphson', () => {
            const params: LensDistortionParams = {
                model: 'kannala_brandt_fisheye',
                k1: 0.05,
                k2: 0.01,
                fisheyeK1: 0.05,
                fisheyeK2: 0.01,
                fisheyeK3: 0.002
            };

            const [x, y] = [0.3, 0.25];
            const [dx, dy] = VfxPlateMatchmoveService.distortPoint(x, y, params);
            const [ux, uy] = VfxPlateMatchmoveService.undistortPoint(dx, dy, params);

            expect(ux).toBeCloseTo(x, 4);
            expect(uy).toBeCloseTo(y, 4);
        });

        it('roundtrips 3DEqualizer 4 Anamorphic Degree 4 model', () => {
            const params: LensDistortionParams = {
                model: 'anamorphic_deg4',
                c20: -0.02,
                c02: -0.01,
                c40: 0.003,
                c22: 0.002,
                c04: 0.001
            };

            const [x, y] = [0.25, 0.2];
            const [dx, dy] = VfxPlateMatchmoveService.distortPoint(x, y, params);
            const [ux, uy] = VfxPlateMatchmoveService.undistortPoint(dx, dy, params);

            expect(ux).toBeCloseTo(x, 4);
            expect(uy).toBeCloseTo(y, 4);
        });
    });

    describe('Pillar 2: 3DEqualizer 4 (.lens) File Export & Parsing Interchange', () => {
        const testParams: LensDistortionParams = {
            k1: -0.065,
            k2: 0.018,
            k3: -0.0025,
            k4: 0.0003,
            p1: 0.0004,
            p2: -0.0002,
            opticalCenter: [0.51, 0.49],
            focalLengthMm: 24.0,
            sensorWidthMm: 36.0,
            sensorHeightMm: 24.0,
            aspectRatio: 1.5
        };

        const metadata: VfxLensMetadata = {
            lensName: 'Cooke S4/i 24mm Prime',
            cameraBody: 'ARRI Alexa 35',
            focalLengthMm: 24.0,
            filmBackWidthMm: 36.0,
            filmBackHeightMm: 24.0
        };

        it('exports syntactically valid 3DEqualizer 4 .lens file format', () => {
            const lensFile = VfxLensInterchangeService.export3DEqualizerLensFile(testParams, metadata);

            expect(lensFile).toContain('# 3DEqualizer4 Lens Distortion File');
            expect(lensFile).toContain('distortion_model 3de4_radial_standard_degree_4');
            expect(lensFile).toContain('focal_length 24.000000');
            expect(lensFile).toContain('film_width 36.000000');
            expect(lensFile).toContain('c02 -0.06500000');
            expect(lensFile).toContain('c04 0.01800000');
            expect(lensFile).toContain('c06 -0.00250000');
            expect(lensFile).toContain('c08 0.00030000');
        });

        it('parses .lens file back into typed LensDistortionParams with high fidelity', () => {
            const lensFile = VfxLensInterchangeService.export3DEqualizerLensFile(testParams, metadata);
            const parsed = VfxLensInterchangeService.parse3DEqualizerLensFile(lensFile);

            expect(parsed.k1).toBeCloseTo(testParams.k1, 5);
            expect(parsed.k2).toBeCloseTo(testParams.k2, 5);
            expect(parsed.k3).toBeCloseTo(testParams.k3!, 5);
            expect(parsed.k4).toBeCloseTo(testParams.k4!, 5);
            expect(parsed.p1).toBeCloseTo(testParams.p1!, 5);
            expect(parsed.p2).toBeCloseTo(testParams.p2!, 5);
            expect(parsed.opticalCenter?.[0]).toBeCloseTo(testParams.opticalCenter![0], 4);
            expect(parsed.opticalCenter?.[1]).toBeCloseTo(testParams.opticalCenter![1], 4);
            expect(parsed.focalLengthMm).toBe(24.0);
            expect(parsed.sensorWidthMm).toBe(36.0);
        });

        it('exports 3DEqualizer anamorphic degree 4 model when specified', () => {
            const anamorphicParams: LensDistortionParams = {
                model: 'anamorphic_deg4',
                c20: -0.035,
                c02: -0.015,
                c40: 0.004,
                c22: 0.002,
                c04: 0.001,
                anamorphicSqueeze: 2.0
            };

            const file = VfxLensInterchangeService.export3DEqualizerLensFile(anamorphicParams);
            expect(file).toContain('distortion_model 3de4_anamorphic_standard_degree_4');
            expect(file).toContain('c20 -0.03500000');
            expect(file).toContain('c02 -0.01500000');
            expect(file).toContain('squeeze_factor 2.000000');
        });
    });

    describe('Pillar 3: Foundry Nuke LensDistortion Node & Python Script Generation', () => {
        it('generates production Foundry Nuke .nk script and python script block', () => {
            const params: LensDistortionParams = {
                k1: -0.042,
                k2: 0.009,
                p1: 0.0002,
                p2: -0.0001,
                opticalCenter: [0.5, 0.5],
                anamorphicSqueeze: 1.0,
                focalLengthMm: 28.0,
                sensorWidthMm: 36.0
            };

            const nukeScript = VfxLensInterchangeService.exportNukeLensDistortionScript(params, {
                lensName: 'Zeiss Master Prime 28mm',
                outputMode: 'undistort'
            });

            expect(nukeScript).toContain('LensDistortion2 {');
            expect(nukeScript).toContain('distortionModel "Brown-Conrady"');
            expect(nukeScript).toContain('k1 -0.042');
            expect(nukeScript).toContain('k2 0.009');
            expect(nukeScript).toContain('output "Undistort"');
            expect(nukeScript).toContain('nuke.createNode("LensDistortion2")');
            expect(nukeScript).toContain('ld["output"].setValue("Undistort")');
        });
    });

    describe('Pillar 4: OpenCV Camera Matrix & Calibration Vector Interchange', () => {
        it('computes exact 3x3 camera matrix K and 8-element distortion vector D', () => {
            const params: LensDistortionParams = {
                k1: -0.05,
                k2: 0.012,
                k3: -0.001,
                p1: 0.0003,
                p2: -0.0002,
                opticalCenter: [0.5, 0.5]
            };

            const calib = VfxLensInterchangeService.exportOpenCvCameraMatrix(
                params,
                3840,
                2160,
                36.0 // 36mm sensor width
            );

            expect(calib.imageWidth).toBe(3840);
            expect(calib.imageHeight).toBe(2160);

            // Principal point in center of 3840x2160: [1920, 1080]
            expect(calib.principalPointPx[0]).toBe(1920);
            expect(calib.principalPointPx[1]).toBe(1080);

            // Camera matrix K
            const K = calib.cameraMatrix;
            expect(K[0][0]).toBe(calib.focalLengthPx[0]);
            expect(K[1][1]).toBe(calib.focalLengthPx[1]);
            expect(K[0][2]).toBe(1920);
            expect(K[1][2]).toBe(1080);
            expect(K[2][2]).toBe(1.0);

            // Distortion coefficients [k1, k2, p1, p2, k3, k4, k5, k6]
            const D = calib.distortionCoefficients;
            expect(D[0]).toBe(-0.05);
            expect(D[1]).toBe(0.012);
            expect(D[2]).toBe(0.0003);
            expect(D[3]).toBe(-0.0002);
            expect(D[4]).toBe(-0.001);
            expect(D[5]).toBe(0);
        });
    });

    describe('Pillar 5: STMap Generation, Overscan Margins & Edge Quality', () => {
        it('generates 32-bit floating point STMap with normalized RG UV coordinates', () => {
            const width = 64;
            const height = 36;
            const params: LensDistortionParams = {
                k1: -0.04,
                k2: 0.008,
                model: 'brown_conrady'
            };

            const stmap = LensDistortionEffect.generateSTMap(width, height, {
                params,
                mode: 'undistort'
            });

            expect(stmap).toBeInstanceOf(Float32Array);
            expect(stmap.length).toBe(width * height * 4); // RGBA

            // Center pixel (u=0.5, v=0.5) should have minimal displacement
            const midX = Math.floor(width / 2);
            const midY = Math.floor(height / 2);
            const centerIdx = (midY * width + midX) * 4;

            expect(stmap[centerIdx]).toBeCloseTo(0.5, 1);     // R channel = U
            expect(stmap[centerIdx + 1]).toBeCloseTo(0.5, 1); // G channel = V
            expect(stmap[centerIdx + 2]).toBe(0.0);           // B channel = 0
            expect(stmap[centerIdx + 3]).toBe(1.0);           // A channel = 1
        });

        it('calculates realistic overscan margins for wide-angle distortion', () => {
            const wideParams: LensDistortionParams = {
                k1: -0.08,
                k2: 0.02
            };

            const overscan = LensDistortionEffect.calculateOverscanMargin(
                wideParams,
                16 / 9,
                'undistort'
            );

            // Barrel undistortion requires overscan padding to prevent corner clipping
            expect(overscan).toBeGreaterThan(0.0);
            expect(overscan).toBeLessThan(0.3);
        });

        it('supports cinema prime presets: Cooke S4 18mm, ARRI Ultra Prime 24mm, Panavision 50mm', () => {
            expect(LENS_OPTICAL_PRESETS.cooke_s4_wide_18mm).toBeDefined();
            expect(LENS_OPTICAL_PRESETS.cooke_s4_wide_18mm.config.k3).toBeDefined();

            expect(LENS_OPTICAL_PRESETS.arri_ultra_prime_24mm).toBeDefined();
            expect(LENS_OPTICAL_PRESETS.arri_ultra_prime_24mm.config.k1).toBeCloseTo(-0.019, 3);

            expect(LENS_OPTICAL_PRESETS.panavision_c_series_anamorphic_50mm).toBeDefined();
            expect(LENS_OPTICAL_PRESETS.panavision_c_series_anamorphic_50mm.config.anamorphicSqueeze).toBe(2.0);
        });
    });

    describe('Pillar 6: Camera Matchmove Anti-Drift Integration', () => {
        it('eliminates false optical drift when evaluating tracking markers on curved lenses', () => {
            const pose = {
                position: [0, 0, 5] as [number, number, number],
                rotationQuaternion: [0, 0, 0, 1] as [number, number, number, number],
                fovDegrees: 60,
                focalLengthMm: 24
            };

            const wideDistortion: LensDistortionParams = {
                k1: -0.06,
                k2: 0.015,
                model: 'brown_conrady'
            };

            // Compute ideal ground-truth distorted 2D plate point for a 3D marker at [1.5, 1.0, 0]
            const aspect = 16 / 9;
            const tanHalfFovV = Math.tan((60 * Math.PI / 180) / 2);
            const tanHalfFovH = tanHalfFovV * aspect;
            const ndcX = 1.5 / (5 * tanHalfFovH);
            const ndcY = 1.0 / (5 * tanHalfFovV);
            const [distX, distY] = VfxPlateMatchmoveService.distortPoint(ndcX, ndcY, wideDistortion);
            const plateX = (distX + 1.0) * 0.5 * 1920;
            const plateY = (1.0 - distY) * 0.5 * 1080;

            const markers = [
                {
                    id: 'corner_feature',
                    worldPoint3D: [1.5, 1.0, 0] as [number, number, number],
                    platePoint2D: [plateX, plateY] as [number, number],
                    confidence: 1.0
                }
            ];

            // Without lens distortion compensation, the curved marker has high residual error
            const driftUncompensated = VfxPlateMatchmoveService.evaluateDrift(
                markers,
                pose,
                { width: 1920, height: 1080 }
            );

            // With lens distortion compensation, projected 3D rays pass through distortPoint
            const driftCompensated = VfxPlateMatchmoveService.evaluateDrift(
                markers,
                pose,
                { width: 1920, height: 1080 },
                wideDistortion
            );

            // Compensating for lens distortion eliminates false optical drift
            expect(driftCompensated.maxDriftPx).toBeLessThan(0.01);
            expect(driftUncompensated.maxDriftPx).toBeGreaterThan(2.0);
            expect(driftCompensated.status).toBe('locked');
        });
    });

    describe('Pillar 7: Agent Tools optics_configure_lens_distortion and optics_export_lens_distortion', () => {
        const registry = createDefaultToolRegistry();

        it('registers both optics tools in the central tool registry', () => {
            expect(registry.has('optics_configure_lens_distortion')).toBe(true);
            expect(registry.has('optics_export_lens_distortion')).toBe(true);
        });

        it('configures distortion and computes overscan via optics_configure_lens_distortion', async () => {
            const result = await registry.dispatch('optics_configure_lens_distortion', {
                presetId: 'cooke_s4_wide_18mm',
                mode: 'undistort',
                aspectRatio: 16 / 9,
                sampleUvs: [[0.1, 0.1], [0.5, 0.5]]
            }, {} as any);

            expect(result.exec.summaryResult).toContain('Configured Brown-Conrady lens distortion');
            const payload = result.resultPayload as any;
            expect(payload.config.k1).toBeCloseTo(-0.042, 3);
            expect(payload.config.k3).toBeCloseTo(-0.0012, 4);
            expect(payload.overscanMargin).toBeGreaterThan(0.0);
            expect(payload.distortedSamples.length).toBe(2);
        });

        it('exports all formats via optics_export_lens_distortion', async () => {
            const result = await registry.dispatch('optics_export_lens_distortion', {
                format: 'all',
                presetId: 'arri_ultra_prime_24mm',
                metadata: {
                    lensName: 'ARRI Ultra Prime 24mm',
                    cameraBody: 'Sony Venice 2',
                    resolutionWidth: 3840,
                    resolutionHeight: 2160
                }
            }, {} as any);

            expect(result.exec.summaryResult).toContain('Successfully exported');
            const payload = result.resultPayload as any;
            expect(payload.threeDEqualizerLensFile).toContain('# 3DEqualizer4 Lens Distortion File');
            expect(payload.nukeScript).toContain('LensDistortion');
            expect(payload.openCvCalibration.cameraMatrix).toBeDefined();
            expect(payload.stMapInfo.overscanMargin).toBeDefined();
        });
    });
});
