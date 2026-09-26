/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { describe, it, expect } from 'vitest';
import * as path from 'path';
import * as fs from 'fs';
import {
    createDefaultToolRegistry,
    inferToolGroup
} from '../src/node/gemini/tool-registry';
import {
    DEFAULT_TOOL_DECLARATIONS,
    DEFAULT_TOOL_HANDLERS
} from '../src/node/gemini/tools';
import {
    ADAPTIVE_MATCHMOVE_TOOL_DECLARATIONS,
    adaptiveMatchmoveHandlers
} from '../src/node/gemini/tools/adaptive-matchmove-tools';
import {
    TaskCapabilityResolver
} from '../src/node/agent/task-capability-resolver';
import type {
    SpatialAnchorCorrespondence,
    LensIntrinsicsProfile,
    KeyframeCalibrationState,
    AdaptiveMatchmoveContext
} from '../src/node/spatial/AdaptiveMatchmoveCalibrationService';

const mockContext: any = {
    request: {} as any,
    workspaceRoot: path.resolve(__dirname, '../../..'),
    sandbox: {} as any,
    lsp: {} as any,
    contextGraph: {} as any,
    browserProxy: {} as any,
    lens: {} as any
};

describe('Adaptive Matchmove Agent Tools Suite', () => {

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

    it('registers all adaptive matchmove declarations in the default registry and groups them into workspace', () => {
        const registry = createDefaultToolRegistry();

        const expectedTools = [
            'adaptive_matchmove_calibrate_sequence',
            'adaptive_matchmove_resect_keyframe',
            'adaptive_matchmove_synthesize_trajectory',
            'adaptive_matchmove_verify_metrology'
        ];

        for (const toolName of expectedTools) {
            expect(registry.has(toolName)).toBe(true);
            const tool = registry.get(toolName);
            expect(tool).toBeDefined();
            expect(tool?.group).toBe('workspace');
            expect(inferToolGroup(toolName)).toBe('workspace');
        }

        // Verify exported arrays contain the tools
        for (const toolName of expectedTools) {
            expect(DEFAULT_TOOL_DECLARATIONS.some(d => d.name === toolName)).toBe(true);
            expect(DEFAULT_TOOL_HANDLERS[toolName]).toBeDefined();
        }
    });

    it('executes adaptive_matchmove_resect_keyframe with sub-pixel precision (< 0.05 px RMS)', async () => {
        // Perturbed initial estimate near the Plaza roofline
        const perturbedCam: [number, number, number] = [46.80, 67.30, 0.60];
        const perturbedTgt: [number, number, number] = [32.30, 72.50, 3.20];
        const upVec: [number, number, number] = [0.0, 1.0, 0.0];

        const outcome = await adaptiveMatchmoveHandlers.adaptive_matchmove_resect_keyframe({
            anchors: rooflineAnchors,
            cameraPosition: perturbedCam,
            targetPosition: perturbedTgt,
            upVector: upVec,
            lens: calibratedLens,
            plateWidth: 1920,
            plateHeight: 1080,
            maxIterations: 40,
            tolerancePx: 0.05
        }, mockContext);

        expect(outcome.status).toBe('completed');
        expect(outcome.resultPayload.success).toBe(true);
        expect(Number(outcome.resultPayload.reprojectionRmsPx)).toBeLessThan(0.05);
        expect(outcome.resultPayload.cameraPosition).toBeDefined();
        expect(outcome.resultPayload.targetPosition).toBeDefined();
        expect(Number(outcome.resultPayload.pitchDeg)).toBeGreaterThan(20.0);
        expect(Number(outcome.resultPayload.standoffDist)).toBeGreaterThan(15.0);
    });

    it('executes adaptive_matchmove_calibrate_sequence and certifies VFX metrology', async () => {
        const milestones: KeyframeCalibrationState[] = [
            {
                index: 0,
                frameNumber: 1,
                timeSec: 0.0,
                phaseLabel: 'Street Level Push',
                cameraPosition: [46.5, 67.0, 0.4],
                targetPosition: [32.0, 72.8, 3.4],
                upVector: [0.0, 1.0, 0.0],
                pitchDeg: 21.4,
                standoffDist: 15.9,
                lens: calibratedLens,
                anchors: rooflineAnchors,
                reprojectionRmsPx: 0.018,
                maxResidualPx: 0.025,
                edgeCorrelationPercent: 99.98,
                converged: true
            },
            {
                index: 1,
                frameNumber: 181,
                timeSec: 7.5,
                phaseLabel: 'Canopy Ascent',
                cameraPosition: [42.0, 69.0, 10.0],
                targetPosition: [30.0, 70.0, 0.0],
                upVector: [0.0, 1.0, 0.0],
                pitchDeg: 12.5,
                standoffDist: 16.5,
                lens: calibratedLens,
                anchors: [],
                reprojectionRmsPx: 0.016,
                maxResidualPx: 0.024,
                edgeCorrelationPercent: 99.98,
                converged: true
            },
            {
                index: 2,
                frameNumber: 361,
                timeSec: 15.0,
                phaseLabel: 'Nadir Roof Orbit',
                cameraPosition: [32.0, 85.0, 3.4],
                targetPosition: [32.0, 72.8, 3.4],
                upVector: [0.0, 1.0, 0.0],
                pitchDeg: -88.0,
                standoffDist: 12.2,
                lens: calibratedLens,
                anchors: [],
                reprojectionRmsPx: 0.014,
                maxResidualPx: 0.022,
                edgeCorrelationPercent: 99.99,
                converged: true
            }
        ];

        const context: AdaptiveMatchmoveContext = {
            sequenceId: 'test_unit_plaza',
            fps: 24,
            totalFrames: 361,
            durationSec: 15.0,
            plateResolution: { width: 1920, height: 1080 },
            facadeNormal: [-0.8746, 0.0, -0.4848]
        };

        const outcome = await adaptiveMatchmoveHandlers.adaptive_matchmove_calibrate_sequence({
            context,
            milestones,
            tolerancePx: 0.05
        }, mockContext);

        expect(outcome.status).toBe('completed');
        expect(outcome.resultPayload.success).toBe(true);
        expect(outcome.resultPayload.status).toBe('PASSED');
        expect(Number(outcome.resultPayload.meanRmsResidualPx)).toBeLessThan(0.05);
        expect(Number(outcome.resultPayload.meanEdgeCorrelationPercent)).toBeGreaterThanOrEqual(98.0);
        expect(Number(outcome.resultPayload.peakVelocityMps)).toBeLessThan(15.0);
        expect(outcome.resultPayload.kinematicsSafe).toBe(true);
    });

    it('does not substitute a saved report when only a landmark name is given', async () => {
        const outcome = await adaptiveMatchmoveHandlers.adaptive_matchmove_calibrate_sequence({
            landmark: 'The Plaza Hotel'
        }, mockContext);

        expect(outcome.status).toBe('failed');
        expect(outcome.resultPayload.success).toBe(false);
    });

    it('leaves residuals unmeasured instead of inventing them when a sequence file omits them', async () => {
        const dir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'adaptive-seq-'));
        const seqPath = path.join(dir, 'seq.json');
        fs.writeFileSync(seqPath, JSON.stringify({
            sequenceId: 'bare', fps: 24, totalFrames: 49, durationSec: 2,
            milestones: [
                { frame: 1, time: 0, position: [0, 10, 50], target: [0, 10, 0] },
                { frame: 49, time: 2, position: [10, 10, 50], target: [0, 10, 0] }
            ]
        }));
        const outcome = await adaptiveMatchmoveHandlers.adaptive_matchmove_calibrate_sequence({ sequencePath: seqPath }, mockContext);
        const reported = Number(outcome.resultPayload?.meanRmsResidualPx);
        expect(Number.isFinite(reported) && reported < 0.05).toBe(false);
    });

    it('synthesizes continuous C2 Hermite trajectory with valid kinematics telemetry', async () => {
        const milestones: KeyframeCalibrationState[] = [
            {
                index: 0,
                frameNumber: 1,
                timeSec: 0.0,
                phaseLabel: 'Start',
                cameraPosition: [0, 10, 50],
                targetPosition: [0, 5, 0],
                upVector: [0, 1, 0],
                pitchDeg: 0,
                standoffDist: 50,
                lens: { fovYDeg: 45, aspectRatio: 16 / 9, k1: 0, k2: 0, scale: 1 },
                anchors: [],
                reprojectionRmsPx: 0.01,
                maxResidualPx: 0.02,
                edgeCorrelationPercent: 99.9,
                converged: true
            },
            {
                index: 1,
                frameNumber: 120,
                timeSec: 5.0,
                phaseLabel: 'Mid',
                cameraPosition: [20, 25, 40],
                targetPosition: [0, 8, 0],
                upVector: [0, 1, 0],
                pitchDeg: -10,
                standoffDist: 45,
                lens: { fovYDeg: 45, aspectRatio: 16 / 9, k1: 0, k2: 0, scale: 1 },
                anchors: [],
                reprojectionRmsPx: 0.01,
                maxResidualPx: 0.02,
                edgeCorrelationPercent: 99.9,
                converged: true
            }
        ];

        const outcome = await adaptiveMatchmoveHandlers.adaptive_matchmove_synthesize_trajectory({
            milestones,
            fps: 24,
            totalFrames: 120,
            durationSec: 5.0
        }, mockContext);

        expect(outcome.status).toBe('completed');
        expect(outcome.resultPayload.totalFrames).toBe(120);
        expect(outcome.resultPayload.kinematicsSafe).toBe(true);
        expect(Number(outcome.resultPayload.peakVelocityMps)).toBeLessThan(15.0);
    });

    it('verifies metrology report and enforces photorealistic certification thresholds', async () => {
        const passingReport = {
            sequenceId: 'certified_run',
            keyframeCount: 25,
            totalFrames: 361,
            meanRmsResidualPx: 0.0155,
            maxResidualPx: 0.041,
            meanEdgeCorrelationPercent: 99.98,
            minEdgeCorrelationPercent: 99.96,
            status: 'PASSED',
            keyframes: [],
            trajectory: [
                { frame: 1, timeSec: 0, velocity: 1.2, acceleration: 0.8 },
                { frame: 180, timeSec: 7.5, velocity: 8.5, acceleration: 3.2 },
                { frame: 361, timeSec: 15.0, velocity: 2.1, acceleration: 0.5 }
            ]
        };

        const outcome = await adaptiveMatchmoveHandlers.adaptive_matchmove_verify_metrology({
            report: passingReport,
            maxAllowedRmsPx: 0.05,
            minAllowedCorrelationPercent: 98.0,
            maxVelocityMps: 15.0,
            maxAccelerationMps2: 10.0
        }, mockContext);

        expect(outcome.status).toBe('completed');
        expect(outcome.resultPayload.success).toBe(true);
        expect(outcome.resultPayload.passed).toBe(true);
    });

    it('routes camera matchmove & tracking tasks natively to Tier 1 via TaskCapabilityResolver', () => {
        const prompt1 = 'Please calibrate the camera matchmove keyframes for the Plaza Hotel footage to align with Google Maps 3D tiles';
        const resolution1 = TaskCapabilityResolver.resolveTaskCapability(prompt1);
        expect(resolution1.recommendedResolutionRoute).toBe('tier1-native');
        expect(resolution1.tier1Assessment.primaryNativeEngine).toBe('adaptive-matchmove-calibration');
        expect(resolution1.tier1Assessment.suggestedNativeAction?.serviceOrTool).toBe('adaptive_matchmove_calibrate_sequence');

        const prompt2 = 'Perform 6-DOF optical camera resection and Levenberg-Marquardt bundle adjustment across the drone video milestones';
        const resolution2 = TaskCapabilityResolver.resolveTaskCapability(prompt2);
        expect(resolution2.recommendedResolutionRoute).toBe('tier1-native');
        expect(resolution2.tier1Assessment.primaryNativeEngine).toBe('adaptive-matchmove-calibration');
    });

    it('executes continuous_spline_matchmove_optimize tool handler', async () => {
        const knots = [
            { timeSec: 0.0, position: [46.0, 65.0, 5.0], target: [32.0, 68.0, 6.0], up: [0, 1, 0], fovYDeg: 46.0 },
            { timeSec: 2.0, position: [45.0, 42.0, 13.0], target: [35.0, 42.0, 15.0], up: [0, 1, 0], fovYDeg: 46.0 },
            { timeSec: 4.0, position: [42.6, 15.0, 22.0], target: [42.6, 0.0, 22.0], up: [-0.87, 0, -0.48], fovYDeg: 46.0 }
        ];

        const tracks = [
            {
                trackId: 'track_1',
                worldPoint3D: [32.0, 68.0, 5.0] as [number, number, number],
                observations: [
                    { frameNumber: 0, timeSec: 0.0, pixel2D: [640, 360] as [number, number], confidence: 1.0 },
                    { frameNumber: 48, timeSec: 2.0, pixel2D: [600, 380] as [number, number], confidence: 1.0 }
                ]
            }
        ];

        const anchors = [
            { timeSec: 0.0, position: [46.0, 65.0, 5.0] as [number, number, number], weight: 100.0 }
        ];

        const outcome = await adaptiveMatchmoveHandlers.continuous_spline_matchmove_optimize({
            knots,
            tracks,
            anchors,
            maxIterations: 10,
            kinematicSmoothnessWeight: 1.0,
            enforceMonotonicDescent: true
        }, mockContext);

        expect(outcome.status).toBe('completed');
        expect(outcome.resultPayload.success).toBe(true);
        expect(outcome.resultPayload.optimizedKnots).toHaveLength(3);
        expect(outcome.resultPayload.initialRmsPx).toBeGreaterThanOrEqual(0);
        expect(outcome.resultPayload.finalRmsPx).toBeDefined();
    });

    it('executes continuous_spline_synthesize_trajectory tool handler', async () => {
        const knots = [
            { timeSec: 0.0, position: [46.0, 65.0, 5.0], target: [32.0, 68.0, 6.0], up: [0, 1, 0], fovYDeg: 46.0 },
            { timeSec: 2.0, position: [42.6, 15.0, 22.0], target: [42.6, 0.0, 22.0], up: [0, 1, 0], fovYDeg: 46.0 }
        ];

        const outcome = await adaptiveMatchmoveHandlers.continuous_spline_synthesize_trajectory({
            knots,
            fps: 24,
            durationSec: 2.0,
            exportSolveTrack: true
        }, mockContext);

        expect(outcome.status).toBe('completed');
        expect(outcome.resultPayload.totalFrames).toBe(49); // 2s * 24fps + 1
        expect(outcome.resultPayload.denseTrajectory).toHaveLength(49);
        expect(outcome.resultPayload.solveTrack).toBeDefined();
        expect((outcome.resultPayload.solveTrack as any).isSolved).toBe(true);
    });

});
