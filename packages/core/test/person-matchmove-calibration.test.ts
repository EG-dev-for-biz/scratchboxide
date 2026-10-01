/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import { describe, it, expect, beforeAll } from 'vitest';
import * as path from 'path';
import * as fs from 'fs-extra';
import { 
    adaptiveMatchmoveHandlers 
} from '../src/node/gemini/tools/adaptive-matchmove-tools';
import { 
    AdaptiveMatchmoveCalibrationService,
    SpatialAnchorCorrespondence,
    CameraIntrinsicsParams
} from '../src/node/spatial/AdaptiveMatchmoveCalibrationService';

describe('Person Subject Matchmove & Optical Resection Metrology', () => {
    const mockContext = {
        toolGroup: 'workspace',
        invokingAgent: 'gemini-agent'
    };

    const groundTruthCam: [number, number, number] = [0.0, 1.45, 2.50];
    const groundTruthTgt: [number, number, number] = [0.0, 1.35, 0.0];
    const upVec: [number, number, number] = [0.0, 1.0, 0.0];
    const groundTruthLens: LensIntrinsicsProfile = {
        fovYDeg: 34.5,
        aspectRatio: 1376 / 768,
        k1: -0.002,
        k2: 0.0,
        scale: 1.0
    };

    // 16 anatomical 3D metric landmarks mapped to the 1.80m dynamic dancer
    const anatomical3DPoints: Array<{ id: string; label: string; point3D: [number, number, number]; category: string }> = [
        { id: 'cranium_apex', label: 'Cranium / Crown', point3D: [0.000, 1.820, 0.080], category: 'head' },
        { id: 'nose_tip', label: 'Nose / Mid-Face', point3D: [0.000, 1.680, 0.120], category: 'facial' },
        { id: 'chin_menton', label: 'Chin / Menton', point3D: [0.000, 1.570, 0.090], category: 'facial' },
        { id: 'left_eye', label: 'Left Pupil (Performer Left)', point3D: [0.035, 1.700, 0.100], category: 'facial' },
        { id: 'right_eye', label: 'Right Pupil (Performer Right)', point3D: [-0.035, 1.700, 0.100], category: 'facial' },
        { id: 'right_shoulder', label: 'Right Acromion', point3D: [-0.230, 1.480, 0.040], category: 'torso' },
        { id: 'left_shoulder', label: 'Left Acromion', point3D: [0.240, 1.480, 0.020], category: 'torso' },
        { id: 'sternum_center', label: 'Suprasternal / Chest', point3D: [0.000, 1.380, 0.060], category: 'torso' },
        { id: 'right_raised_elbow', label: 'Right Elbow (Raised)', point3D: [-0.340, 1.420, 0.220], category: 'arm' },
        { id: 'right_raised_hand', label: 'Right Hand / Fingers', point3D: [-0.270, 1.740, 0.350], category: 'arm' },
        { id: 'left_extended_elbow', label: 'Left Elbow (Abducted)', point3D: [0.490, 1.440, -0.040], category: 'arm' },
        { id: 'left_extended_wrist', label: 'Left Wrist / Hand', point3D: [0.550, 1.340, 0.080], category: 'arm' },
        { id: 'navel_waist', label: 'Navel / Waistline', point3D: [0.000, 1.120, 0.040], category: 'torso' },
        { id: 'right_hip', label: 'Right ASIS / Hip', point3D: [-0.150, 0.960, 0.010], category: 'pelvis' },
        { id: 'left_hip', label: 'Left ASIS / Hip', point3D: [0.150, 0.960, 0.010], category: 'pelvis' },
        { id: 'left_bent_knee', label: 'Left Patella / Knee', point3D: [0.360, 0.580, 0.280], category: 'leg' }
    ];

    const performer3DAnchors: SpatialAnchorCorrespondence[] = anatomical3DPoints.map(pt => {
        const [u, v] = AdaptiveMatchmoveCalibrationService.projectPoint(
            pt.point3D,
            groundTruthCam,
            groundTruthTgt,
            upVec,
            groundTruthLens,
            1376,
            768
        );
        return {
            id: pt.id,
            label: pt.label,
            point3D: pt.point3D,
            pixel2D: [Number(u.toFixed(2)), Number(v.toFixed(2))],
            weight: 1.0,
            category: pt.category
        };
    });

    it('1. should perform 6-DOF optical resection on human subject plate and achieve RMS < 0.05 px', async () => {
        const perturbedCam: [number, number, number] = [0.12, 1.52, 2.65];
        const perturbedTgt: [number, number, number] = [-0.04, 1.38, 0.05];

        const resectResult = await adaptiveMatchmoveHandlers.adaptive_matchmove_resect_keyframe({
            anchors: performer3DAnchors,
            cameraPosition: perturbedCam,
            targetPosition: perturbedTgt,
            upVector: upVec,
            lens: groundTruthLens,
            plateWidth: 1376,
            plateHeight: 768,
            tolerancePx: 0.05
        }, mockContext);

        expect(resectResult.status).toBe('completed');
        expect(resectResult.resultPayload.reprojectionRmsPx).toBeLessThan(0.05);
        expect(resectResult.resultPayload.pitchDeg).toBeDefined();
        expect(resectResult.resultPayload.standoffDist).toBeGreaterThan(2.0);
        expect(resectResult.resultPayload.standoffDist).toBeLessThan(3.0);
        expect(resectResult.resultPayload.lens.k1).toBeDefined();
    });

    it('2. should calibrate 72-frame orbital camera trajectory around human subject with C2 Hermite splines', async () => {
        // Resect the center hero keyframe first from perturbed guess
        const heroResect = await adaptiveMatchmoveHandlers.adaptive_matchmove_resect_keyframe({
            anchors: performer3DAnchors,
            cameraPosition: [0.12, 1.52, 2.65],
            targetPosition: [-0.04, 1.38, 0.05],
            upVector: upVec,
            lens: groundTruthLens,
            plateWidth: 1376,
            plateHeight: 768,
            tolerancePx: 0.05
        }, mockContext);

        const milestones = [
            {
                keyframeIndex: 0,
                frameNumber: 1,
                timecodeSeconds: 0.0,
                cameraPosition: [-0.60, 1.42, 2.38],
                targetPosition: [0.0, 1.35, 0.0],
                upVector: [0.0, 1.0, 0.0],
                opticalPitchDeg: -1.7,
                standoffDistanceMeters: 2.45,
                lens: groundTruthLens,
                reprojectionRmsPx: 0.028,
                maxResidualPx: 0.045,
                edgeCorrelationPercent: 99.95,
                anchors: []
            },
            {
                keyframeIndex: 1,
                frameNumber: 18,
                timecodeSeconds: 0.75,
                cameraPosition: [-0.30, 1.44, 2.44],
                targetPosition: [0.0, 1.35, 0.0],
                upVector: [0.0, 1.0, 0.0],
                opticalPitchDeg: -2.1,
                standoffDistanceMeters: 2.46,
                lens: groundTruthLens,
                reprojectionRmsPx: 0.022,
                maxResidualPx: 0.038,
                edgeCorrelationPercent: 99.97,
                anchors: []
            },
            {
                keyframeIndex: 2,
                frameNumber: 36,
                timecodeSeconds: 1.50,
                cameraPosition: heroResect.resultPayload.cameraPosition,
                targetPosition: heroResect.resultPayload.targetPosition,
                upVector: heroResect.resultPayload.upVector,
                opticalPitchDeg: heroResect.resultPayload.pitchDeg,
                standoffDistanceMeters: heroResect.resultPayload.standoffDist,
                lens: groundTruthLens,
                reprojectionRmsPx: heroResect.resultPayload.reprojectionRmsPx,
                maxResidualPx: 0.035,
                edgeCorrelationPercent: 99.98,
                anchors: performer3DAnchors
            },
            {
                keyframeIndex: 3,
                frameNumber: 54,
                timecodeSeconds: 2.25,
                cameraPosition: [0.35, 1.44, 2.42],
                targetPosition: [0.0, 1.35, 0.0],
                upVector: [0.0, 1.0, 0.0],
                opticalPitchDeg: -2.1,
                standoffDistanceMeters: 2.45,
                lens: groundTruthLens,
                reprojectionRmsPx: 0.024,
                maxResidualPx: 0.040,
                edgeCorrelationPercent: 99.96,
                anchors: []
            },
            {
                keyframeIndex: 4,
                frameNumber: 72,
                timecodeSeconds: 3.00,
                cameraPosition: [0.65, 1.42, 2.36],
                targetPosition: [0.0, 1.35, 0.0],
                upVector: [0.0, 1.0, 0.0],
                opticalPitchDeg: -1.7,
                standoffDistanceMeters: 2.45,
                lens: groundTruthLens,
                reprojectionRmsPx: 0.031,
                maxResidualPx: 0.048,
                edgeCorrelationPercent: 99.94,
                anchors: []
            }
        ];

        const sequenceContext = {
            sequenceId: 'person_dancer_orbit_3s',
            totalFrames: 72,
            fps: 24.0,
            plateResolution: [1376, 768] as [number, number],
            durationSeconds: 3.0,
            facadeNormal: [0.0, 0.0, 1.0] as [number, number, number]
        };

        const calibResult = await adaptiveMatchmoveHandlers.adaptive_matchmove_calibrate_sequence({
            context: sequenceContext,
            milestones: milestones,
            tolerancePx: 0.05
        }, mockContext);

        expect(calibResult.status).toBe('completed');
        expect(calibResult.resultPayload.meanRmsResidualPx).toBeLessThan(0.05);
        expect(calibResult.resultPayload.meanEdgeCorrelationPercent).toBeGreaterThan(98.0);
        expect(calibResult.resultPayload.peakVelocityMps).toBeLessThan(15.0);
        expect(calibResult.resultPayload.peakAccelerationMps2).toBeLessThan(10.0);
        expect(calibResult.resultPayload.kinematicsSafe).toBe(true);

        // Verify and write artifacts for public inspection
        const reportPath = path.resolve(__dirname, '../../../public/models/person_subject_adaptive_metrology_report.json');
        await fs.ensureDir(path.dirname(reportPath));
        await fs.writeJson(reportPath, calibResult.resultPayload.metrologyReport, { spaces: 2 });

        const splinePath = path.resolve(__dirname, '../../../public/models/person_subject_trajectory_spline.json');
        await fs.writeJson(splinePath, calibResult.resultPayload.trajectory, { spaces: 2 });

        expect(fs.existsSync(reportPath)).toBe(true);
        expect(fs.existsSync(splinePath)).toBe(true);

        // Run verification tool
        const verifyResult = await adaptiveMatchmoveHandlers.adaptive_matchmove_verify_metrology({
            report: calibResult.resultPayload.metrologyReport
        }, mockContext);

        expect(verifyResult.status).toBe('completed');
        expect(verifyResult.resultPayload.success).toBe(true);
        expect(verifyResult.resultPayload.passed).toBe(true);
        expect(verifyResult.resultPayload.evaluations.reprojectionRms.pass).toBe(true);
        expect(verifyResult.resultPayload.evaluations.edgeCorrelation.pass).toBe(true);
        expect(verifyResult.resultPayload.evaluations.droneVelocity.pass).toBe(true);
    });
});
