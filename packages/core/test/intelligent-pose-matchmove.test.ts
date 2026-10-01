/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import { describe, it, expect } from 'vitest';
import * as path from 'path';
import {
    AdaptiveMatchmoveCalibrationService,
    SpatialAnchorCorrespondence
} from '../src/node/spatial/AdaptiveMatchmoveCalibrationService';
import { MEDIAPIPE_LANDMARK_INDEX } from '../src/common/character-pose-protocol';
import {
    adaptiveMatchmoveHandlers,
    ADAPTIVE_MATCHMOVE_TOOL_DECLARATIONS
} from '../src/node/gemini/tools/adaptive-matchmove-tools';

describe('Intelligent Automated Pose Extraction & Matchmove Calibration', () => {

    it('should declare adaptive_matchmove_extract_pose_anchors in tool declarations', () => {
        const decl = ADAPTIVE_MATCHMOVE_TOOL_DECLARATIONS.find(
            d => d.name === 'adaptive_matchmove_extract_pose_anchors'
        );
        expect(decl).toBeDefined();
        expect(decl?.description).toContain('MediaPipe');
        expect(decl?.parameters.properties).toHaveProperty('imagePath');
        expect(decl?.parameters.properties).toHaveProperty('subjectHeightMeters');
        expect(decl?.parameters.properties).toHaveProperty('groundAltitudeMeters');
    });

    it('should convert MediaPipe 33 landmarks into schema-compliant SpatialAnchorCorrespondence[]', () => {
        const synthetic = AdaptiveMatchmoveCalibrationService.synthesizeAnthropometricLandmarks(true);
        expect(synthetic.worldLandmarks).toHaveLength(33);
        expect(synthetic.imageLandmarks).toHaveLength(33);

        const anchors = AdaptiveMatchmoveCalibrationService.extractPoseAnchorsFromLandmarks(
            synthetic.worldLandmarks,
            synthetic.imageLandmarks,
            {
                plateWidth: 1920,
                plateHeight: 1080,
                subjectHeightMeters: 1.80,
                groundAltitudeMeters: 0.0
            }
        );

        expect(anchors).toHaveLength(33);

        // Check key anatomical anchors
        const nose = anchors.find(a => a.id === 'NOSE');
        const lShoulder = anchors.find(a => a.id === 'LEFT_SHOULDER');
        const rShoulder = anchors.find(a => a.id === 'RIGHT_SHOULDER');
        const lHip = anchors.find(a => a.id === 'LEFT_HIP');
        const rHip = anchors.find(a => a.id === 'RIGHT_HIP');
        const lAnkle = anchors.find(a => a.id === 'LEFT_ANKLE');
        const rAnkle = anchors.find(a => a.id === 'RIGHT_ANKLE');

        expect(nose).toBeDefined();
        expect(lShoulder).toBeDefined();
        expect(rShoulder).toBeDefined();
        expect(lHip).toBeDefined();
        expect(rHip).toBeDefined();
        expect(lAnkle).toBeDefined();
        expect(rAnkle).toBeDefined();

        // Biomechanical categories
        expect(nose?.category).toBe('head');
        expect(lShoulder?.category).toBe('torso_shoulder');
        expect(lHip?.category).toBe('torso_pelvis');
        expect(lAnkle?.category).toBe('leg_ankle');

        // Biomechanical structural joint weights
        expect(lShoulder!.weight).toBeGreaterThanOrEqual(1.5);
        expect(rShoulder!.weight).toBeGreaterThanOrEqual(1.5);
        expect(lHip!.weight).toBeGreaterThanOrEqual(1.5);

        // Grounding: Lowest foot point should be grounded at Y = 0.0
        const minY = Math.min(...anchors.map(a => a.point3D[1]));
        expect(minY).toBeGreaterThanOrEqual(-0.01);
        expect(minY).toBeLessThanOrEqual(0.05);

        // Subject height should match target (~1.80m within tolerance)
        const maxY = Math.max(...anchors.map(a => a.point3D[1]));
        expect(maxY).toBeGreaterThanOrEqual(1.65);
        expect(maxY).toBeLessThanOrEqual(1.95);

        // 2D pixel coordinates within plate bounds
        anchors.forEach(a => {
            expect(a.pixel2D[0]).toBeGreaterThanOrEqual(0);
            expect(a.pixel2D[0]).toBeLessThanOrEqual(1920);
            expect(a.pixel2D[1]).toBeGreaterThanOrEqual(0);
            expect(a.pixel2D[1]).toBeLessThanOrEqual(1080);
        });
    });

    it('should extract pose anchors from image buffer or path with zero crash risk', async () => {
        // Use frame0 from the plaza or person demo
        const testImage = path.resolve(__dirname, '../../../public/models/person_dance_kf01_plate.jpg');

        const anchors = await AdaptiveMatchmoveCalibrationService.extractPoseAnchorsFromImage(
            testImage,
            {
                plateWidth: 1920,
                plateHeight: 1080,
                subjectHeightMeters: 1.75
            }
        );

        expect(anchors).toHaveLength(33);
        const lShoulder = anchors.find(a => a.id === 'LEFT_SHOULDER')!;
        expect(lShoulder).toBeDefined();
        expect(lShoulder.point3D[1]).toBeGreaterThan(1.0); // Shoulder above 1 meter
    });

    it('should accurately resect camera pose using 33 automated pose landmarks', () => {
        const synthetic = AdaptiveMatchmoveCalibrationService.synthesizeAnthropometricLandmarks(true);
        const anchors = AdaptiveMatchmoveCalibrationService.extractPoseAnchorsFromLandmarks(
            synthetic.worldLandmarks,
            synthetic.imageLandmarks,
            {
                plateWidth: 1920,
                plateHeight: 1080,
                subjectHeightMeters: 1.80
            }
        );

        // Resect from initial guess
        const initCamPos: [number, number, number] = [0.0, 1.2, 3.4];
        const initTarget: [number, number, number] = [0.0, 1.0, 0.0];
        const initUp: [number, number, number] = [0, 1, 0];
        const lens = { fovYDeg: 35.0, aspectRatio: 16 / 9, k1: 0.0, k2: 0.0, scale: 1.0 };

        const resected = AdaptiveMatchmoveCalibrationService.solveKeyframeResection(
            anchors,
            initCamPos,
            initTarget,
            initUp,
            lens,
            1920,
            1080,
            {
                maxIterations: 50,
                tolerancePx: 0.01,
                optimizeFov: true
            }
        );

        expect(resected.converged).toBe(true);
        expect(resected.reprojectionRmsPx).toBeLessThan(0.05);
        expect(resected.standoffDist).toBeGreaterThan(2.0);
        expect(resected.standoffDist).toBeLessThan(5.0);
    });

    it('should execute adaptive_matchmove_extract_pose_anchors agent tool', async () => {
        const handler = adaptiveMatchmoveHandlers.adaptive_matchmove_extract_pose_anchors;
        expect(handler).toBeDefined();

        const result = await handler(
            {
                imagePath: 'public/models/person_dance_kf01_plate.jpg',
                plateWidth: 1920,
                plateHeight: 1080,
                subjectHeightMeters: 1.78
            },
            { workspaceRoot: path.resolve(__dirname, '../../..') } as any
        );

        expect(result.status).toBe('completed');
        expect(result.resultPayload.success).toBe(true);
        expect(result.resultPayload.anchorCount).toBe(33);
        expect(result.summaryResult).toContain('33');
    });

    it('should execute adaptive_matchmove_resect_keyframe with autoExtractPose', async () => {
        const handler = adaptiveMatchmoveHandlers.adaptive_matchmove_resect_keyframe;
        expect(handler).toBeDefined();

        const result = await handler(
            {
                imagePath: 'public/models/person_dance_kf01_plate.jpg',
                autoExtractPose: true,
                subjectHeightMeters: 1.80,
                plateWidth: 1920,
                plateHeight: 1080
            },
            { workspaceRoot: path.resolve(__dirname, '../../..') } as any
        );

        expect(result.status).toBe('completed');
        expect(result.resultPayload.success).toBe(true);
        expect(result.resultPayload.reprojectionRmsPx).toBeLessThan(0.05);
    });
});
