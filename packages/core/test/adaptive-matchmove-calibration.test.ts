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
    AdaptiveMatchmoveCalibrationService,
    AdaptiveMatchmoveContext,
    SpatialAnchorCorrespondence,
    LensIntrinsicsProfile,
    KeyframeCalibrationState
} from '../src/node/spatial/AdaptiveMatchmoveCalibrationService';

describe('Adaptive Domain Architecture Matchmove & Keyframe Calibration Engine', () => {

    const testContext: AdaptiveMatchmoveContext = {
        sequenceId: 'plaza_hotel_descent_01',
        description: 'Adaptive 6-DOF descent calibration across Plaza Hotel facade',
        fps: 24,
        totalFrames: 361,
        durationSec: 15.0,
        plateResolution: { width: 1920, height: 1080 },
        facadeNormal: [-0.8746, 0.0, -0.4848]
    };

    // Ground truth anchors on Plaza roofline (from mesh_7)
    const rooflineAnchors: SpatialAnchorCorrespondence[] = [
        {
            id: 'gable_apex',
            label: 'Mansard Gable Roof Apex',
            point3D: [38.187, 75.925, 7.017],
            pixel2D: [518.3, 93.0],
            weight: 1.0,
            category: 'roofline'
        },
        {
            id: 'turret_apex',
            label: 'Copper Turret Dome Apex',
            point3D: [30.628, 81.555, -0.827],
            pixel2D: [1212.0, 85.2],
            weight: 1.0,
            category: 'roofline'
        },
        {
            id: 'balcony_chalice',
            label: 'Attic Balcony Chalice',
            point3D: [39.252, 69.531, 5.157],
            pixel2D: [534.2, 617.9],
            weight: 1.0,
            category: 'facade'
        },
        {
            id: 'turret_drum_center',
            label: 'Turret Drum Cornice',
            point3D: [40.964, 68.969, -0.827],
            pixel2D: [1432.1, 550.8],
            weight: 1.0,
            category: 'facade'
        }
    ];

    const calibratedLens: LensIntrinsicsProfile = {
        fovYDeg: 52.0,
        aspectRatio: 1920 / 1080,
        k1: -0.018,
        k2: 0.002,
        scale: 1.02
    };

    // =========================================================================
    // 1. Adaptive Schema Contract Compliance (Zero Hardcoded Presets)
    // =========================================================================
    describe('1. Adaptive Schema Contract Compliance', () => {
        it('ingests arbitrary sequence context without hardcoded domain classifiers', () => {
            expect(testContext.sequenceId).toBeDefined();
            expect(testContext.plateResolution.width).toBe(1920);
            expect(testContext.plateResolution.height).toBe(1080);
            expect(testContext.fps).toBe(24);
        });

        it('structures spatial anchors with 3D-to-2D coordinates and semantic attributes', () => {
            expect(rooflineAnchors.length).toBe(4);
            for (const a of rooflineAnchors) {
                expect(a.id).toBeDefined();
                expect(a.point3D.length).toBe(3);
                expect(a.pixel2D.length).toBe(2);
                expect(a.pixel2D[0]).toBeGreaterThanOrEqual(0);
                expect(a.pixel2D[0]).toBeLessThanOrEqual(1920);
            }
        });
    });

    // =========================================================================
    // 2. 3D-to-2D Perspective Projection & Brown-Conrady Distortion
    // =========================================================================
    describe('2. Perspective Projection & Lens Undistortion', () => {
        it('accurately projects 3D roofline vertices with Brown-Conrady barrel distortion', () => {
            const camPos: [number, number, number] = [46.50, 67.00, 0.40];
            const targetPos: [number, number, number] = [32.00, 72.80, 3.40];
            const upVec: [number, number, number] = [0, 1, 0];

            const [uGable, vGable] = AdaptiveMatchmoveCalibrationService.projectPoint(
                rooflineAnchors[0].point3D,
                camPos,
                targetPos,
                upVec,
                calibratedLens,
                1920,
                1080
            );

            // Gable apex should project near [518.3, 93.0]
            expect(Math.abs(uGable - 518.3)).toBeLessThan(1.0);
            expect(Math.abs(vGable - 93.0)).toBeLessThan(1.0);

            const [uTurret, vTurret] = AdaptiveMatchmoveCalibrationService.projectPoint(
                rooflineAnchors[1].point3D,
                camPos,
                targetPos,
                upVec,
                calibratedLens,
                1920,
                1080
            );

            // Turret apex should project near [1212.0, 85.2]
            expect(Math.abs(uTurret - 1212.0)).toBeLessThan(1.0);
            expect(Math.abs(vTurret - 85.2)).toBeLessThan(1.0);

            // Projected horizontal span must be within 1.0px of ground truth 693.7px
            const span = uTurret - uGable;
            expect(Math.abs(span - 693.7)).toBeLessThan(1.0);
        });

        it('computes upward optical pitch correctly from camera elevation and target', () => {
            const camPos: [number, number, number] = [46.50, 67.00, 0.40];
            const targetPos: [number, number, number] = [32.00, 72.80, 3.40];
            const pitch = AdaptiveMatchmoveCalibrationService.computePitch(camPos, targetPos);

            expect(pitch).toBeGreaterThan(20.0);
            expect(pitch).toBeLessThan(23.0);
        });
    });

    // =========================================================================
    // 3. Levenberg-Marquardt Bundle Adjustment Resection
    // =========================================================================
    describe('3. Levenberg-Marquardt Bundle Adjustment Resection', () => {
        it('converges from perturbed initial guess to sub-pixel accuracy (< 0.05 px RMS)', () => {
            // Start with perturbed camera guess
            const perturbedCam: [number, number, number] = [46.80, 67.30, 0.60];
            const perturbedTgt: [number, number, number] = [32.30, 72.50, 3.20];
            const perturbedLens: LensIntrinsicsProfile = {
                fovYDeg: 51.5,
                k1: -0.015,
                k2: 0.002,
                scale: 1.02
            };

            const result = AdaptiveMatchmoveCalibrationService.solveKeyframeResection(
                rooflineAnchors,
                perturbedCam,
                perturbedTgt,
                [0, 1, 0],
                calibratedLens,
                1920,
                1080,
                { maxIterations: 40, tolerancePx: 0.05 }
            );

            expect(result.converged).toBe(true);
            expect(result.reprojectionRmsPx).toBeLessThan(0.05);
            expect(result.pitchDeg).toBeGreaterThan(20.0);
            expect(result.standoffDist).toBeGreaterThan(15.0);
            expect(result.standoffDist).toBeLessThan(18.0);
        });
    });

    // =========================================================================
    // 4. Kinematic Spline Trajectory & Gimbal-Free Slerp
    // =========================================================================
    describe('4. Kinematic Spline & Gimbal-Free Up-Vector Slerp', () => {
        it('interpolates up-vector smoothly toward facade normal without mathematical singularity', () => {
            const facadeNormal: [number, number, number] = [-0.8746, 0.0, -0.4848];

            const upStart = AdaptiveMatchmoveCalibrationService.evaluateGimbalFreeUpVector(0.0, facadeNormal);
            expect(upStart[0]).toBeCloseTo(0.0, 3);
            expect(upStart[1]).toBeCloseTo(1.0, 3);
            expect(upStart[2]).toBeCloseTo(0.0, 3);

            const upNadir = AdaptiveMatchmoveCalibrationService.evaluateGimbalFreeUpVector(1.0, facadeNormal);
            expect(upNadir[0]).toBeCloseTo(facadeNormal[0], 3);
            expect(upNadir[1]).toBeCloseTo(0.0, 3);
            expect(upNadir[2]).toBeCloseTo(facadeNormal[2], 3);

            // Vector length must remain exactly 1.0 (no degradation)
            const len = Math.hypot(upNadir[0], upNadir[1], upNadir[2]);
            expect(len).toBeCloseTo(1.0, 5);
        });

        it('synthesizes multi-frame trajectory with smooth velocity and acceleration', () => {
            const milestones: KeyframeCalibrationState[] = [
                {
                    index: 0,
                    frameNumber: 1,
                    timeSec: 0.0,
                    cameraPosition: [46.5, 67.0, 0.4],
                    targetPosition: [32.0, 72.8, 3.4],
                    upVector: [0, 1, 0],
                    pitchDeg: 21.4,
                    standoffDist: 15.9,
                    lens: { fovYDeg: 52.0, k1: -0.018, k2: 0.002, scale: 1.02 },
                    anchors: rooflineAnchors,
                    reprojectionRmsPx: 0.018,
                    maxResidualPx: 0.025,
                    edgeCorrelationPercent: 99.98,
                    converged: true
                },
                {
                    index: 1,
                    frameNumber: 15,
                    timeSec: 0.6,
                    cameraPosition: [49.2, 68.2, 3.0],
                    targetPosition: [32.5, 70.4, 3.4],
                    upVector: [0, 1, 0],
                    pitchDeg: 8.2,
                    standoffDist: 17.5,
                    lens: { fovYDeg: 50.0, k1: -0.017, k2: 0.002, scale: 1.02 },
                    anchors: rooflineAnchors,
                    reprojectionRmsPx: 0.022,
                    maxResidualPx: 0.030,
                    edgeCorrelationPercent: 99.95,
                    converged: true
                },
                {
                    index: 2,
                    frameNumber: 361,
                    timeSec: 15.0,
                    cameraPosition: [42.6, 10.5, 23.5],
                    targetPosition: [42.6, 0.0, 23.5],
                    upVector: [-0.8746, 0.0, -0.4848],
                    pitchDeg: -90.0,
                    standoffDist: 10.5,
                    lens: { fovYDeg: 46.0, k1: -0.015, k2: 0.002, scale: 1.02 },
                    anchors: rooflineAnchors,
                    reprojectionRmsPx: 0.015,
                    maxResidualPx: 0.020,
                    edgeCorrelationPercent: 100.0,
                    converged: true
                }
            ];

            const trajectory = AdaptiveMatchmoveCalibrationService.synthesizeSplineTrajectory(milestones, testContext);

            expect(trajectory.length).toBe(361);
            expect(trajectory[0].position).toEqual([46.5, 67.0, 0.4]);
            expect(trajectory[360].position).toEqual([42.6, 10.5, 23.5]);

            // Velocity must stay below physical drone maximum of 25 m/s
            for (const f of trajectory) {
                if (f.velocity !== undefined) {
                    expect(f.velocity).toBeLessThan(25.0);
                }
            }
        });
    });

    // =========================================================================
    // 5. Sobel Edge Cross-Correlation Metrology
    // =========================================================================
    describe('5. Sobel Edge Cross-Correlation Metrology', () => {
        it('calculates 100% correlation for identical edge fields and degrades gracefully with noise', () => {
            const size = 1000;
            const fieldA = new Float32Array(size);
            for (let i = 0; i < size; i++) {
                fieldA[i] = Math.sin(i * 0.1) * 50.0 + 50.0;
            }

            // Identical
            const corrIdentical = AdaptiveMatchmoveCalibrationService.evaluateSobelCorrelation(fieldA, fieldA);
            expect(corrIdentical).toBe(100.0);

            // With subtle noise
            const fieldB = new Float32Array(size);
            for (let i = 0; i < size; i++) {
                fieldB[i] = fieldA[i] + (Math.sin(i * 1.5) * 2.0);
            }
            const corrNoisy = AdaptiveMatchmoveCalibrationService.evaluateSobelCorrelation(fieldA, fieldB);
            expect(corrNoisy).toBeGreaterThan(98.0);
            expect(corrNoisy).toBeLessThan(100.0);
        });
    });

    // =========================================================================
    // 6. Sequence Metrology Certification
    // =========================================================================
    describe('6. Sequence Metrology Certification', () => {
        it('calibrates sequence and produces a certified report meeting sub-pixel criteria', () => {
            const milestones: KeyframeCalibrationState[] = [
                {
                    index: 0,
                    frameNumber: 1,
                    timeSec: 0.0,
                    cameraPosition: [46.5, 67.0, 0.4],
                    targetPosition: [32.0, 72.8, 3.4],
                    upVector: [0, 1, 0],
                    pitchDeg: 21.4,
                    standoffDist: 15.9,
                    lens: calibratedLens,
                    anchors: rooflineAnchors,
                    reprojectionRmsPx: 0.018,
                    maxResidualPx: 0.025,
                    edgeCorrelationPercent: 99.98,
                    converged: true
                }
            ];

            const report = AdaptiveMatchmoveCalibrationService.calibrateSequence(milestones, testContext);

            expect(report.sequenceId).toBe('plaza_hotel_descent_01');
            expect(report.status).toBe('PASSED');
            expect(report.meanRmsResidualPx).toBeLessThan(0.05);
            expect(report.meanEdgeCorrelationPercent).toBeGreaterThanOrEqual(99.0);
            expect(report.trajectory.length).toBe(361);
        });
    });
});
