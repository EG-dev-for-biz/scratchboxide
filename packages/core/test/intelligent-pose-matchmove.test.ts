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
import { MEDIAPIPE_LANDMARK_INDEX, MediaPipeLandmark } from '../src/common/character-pose-protocol';
import { GeneratorFailedError, MissingInputError } from '../src/common/errors/pipeline-errors';
import type { MediaPipePoseService } from '../src/node/spatial/MediaPipePoseService';
import {
    adaptiveMatchmoveHandlers,
    ADAPTIVE_MATCHMOVE_TOOL_DECLARATIONS
} from '../src/node/gemini/tools/adaptive-matchmove-tools';

/**
 * Test fixture: a standing body in MediaPipe world space (Y down, hip at 0, about 1.8 m tall) and its
 * projection through a 35 degree lens from [0, 1.2, 3.2] onto a 1920x1080 plate. Test data only; the
 * service never substitutes a body when detection fails.
 */
function fixtureBodyLandmarks(): { worldLandmarks: MediaPipeLandmark[]; imageLandmarks: MediaPipeLandmark[] } {
    const I = MEDIAPIPE_LANDMARK_INDEX;
    const world: MediaPipeLandmark[] = Array.from({ length: 33 }, () => ({ x: 0, y: 0, z: 0, visibility: 0.95 }));
    const set = (idx: number, x: number, y: number, z: number) => { world[idx] = { x, y, z, visibility: 0.95 }; };
    set(I.NOSE, 0.0, -0.74, -0.10);
    set(I.LEFT_EYE_INNER, 0.02, -0.78, -0.09); set(I.LEFT_EYE, 0.04, -0.78, -0.09); set(I.LEFT_EYE_OUTER, 0.06, -0.78, -0.08);
    set(I.RIGHT_EYE_INNER, -0.02, -0.78, -0.09); set(I.RIGHT_EYE, -0.04, -0.78, -0.09); set(I.RIGHT_EYE_OUTER, -0.06, -0.78, -0.08);
    set(I.LEFT_EAR, 0.09, -0.75, -0.02); set(I.RIGHT_EAR, -0.09, -0.75, -0.02);
    set(I.MOUTH_LEFT, 0.03, -0.70, -0.08); set(I.MOUTH_RIGHT, -0.03, -0.70, -0.08);
    set(I.LEFT_SHOULDER, 0.22, -0.52, 0.0); set(I.RIGHT_SHOULDER, -0.22, -0.52, 0.0);
    set(I.LEFT_ELBOW, 0.28, -0.24, 0.04); set(I.RIGHT_ELBOW, -0.28, -0.24, 0.04);
    set(I.LEFT_WRIST, 0.26, 0.06, 0.08); set(I.RIGHT_WRIST, -0.26, 0.06, 0.08);
    set(I.LEFT_PINKY, 0.28, 0.12, 0.09); set(I.RIGHT_PINKY, -0.28, 0.12, 0.09);
    set(I.LEFT_INDEX, 0.26, 0.14, 0.09); set(I.RIGHT_INDEX, -0.26, 0.14, 0.09);
    set(I.LEFT_THUMB, 0.24, 0.10, 0.08); set(I.RIGHT_THUMB, -0.24, 0.10, 0.08);
    set(I.LEFT_HIP, 0.13, 0.0, 0.0); set(I.RIGHT_HIP, -0.13, 0.0, 0.0);
    set(I.LEFT_KNEE, 0.14, 0.44, 0.02); set(I.RIGHT_KNEE, -0.14, 0.44, 0.02);
    set(I.LEFT_ANKLE, 0.14, 0.86, 0.0); set(I.RIGHT_ANKLE, -0.14, 0.86, 0.0);
    set(I.LEFT_HEEL, 0.14, 0.90, -0.05); set(I.RIGHT_HEEL, -0.14, 0.90, -0.05);
    set(I.LEFT_FOOT_INDEX, 0.14, 0.91, 0.12); set(I.RIGHT_FOOT_INDEX, -0.14, 0.91, 0.12);

    const lowest = Math.max(...world.map(w => w.y));
    const lens = { fovYDeg: 35.0, aspectRatio: 16 / 9, k1: 0.0, k2: 0.0, scale: 1.0 };
    const image = world.map(w => {
        const [u, v] = AdaptiveMatchmoveCalibrationService.projectPoint(
            [w.x, lowest - w.y, -w.z], [0.0, 1.20, 3.20], [0.0, 0.95, 0.0], [0, 1, 0], lens, 1920, 1080
        );
        return { x: u / 1920, y: v / 1080, z: w.z, visibility: w.visibility };
    });
    return { worldLandmarks: world, imageLandmarks: image };
}

function stubPoseService(run: Awaited<ReturnType<MediaPipePoseService['runPoseLandmarker']>>): MediaPipePoseService {
    return {
        normalizeImageInput: async () => Buffer.from([0xff, 0xd8]),
        runPoseLandmarker: async () => run
    } as unknown as MediaPipePoseService;
}

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
        const synthetic = fixtureBodyLandmarks();
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

    it('extracts anchors from a real MediaPipe detection and keeps its metric scale when no height is given', async () => {
        const body = fixtureBodyLandmarks();
        const anchors = await AdaptiveMatchmoveCalibrationService.extractPoseAnchorsFromImage(Buffer.from([0]), {
            plateWidth: 1920,
            plateHeight: 1080,
            poseService: stubPoseService({ detection: { worldLandmarks: [body.worldLandmarks], imageLandmarks: [body.imageLandmarks] } })
        });
        expect(anchors).toHaveLength(33);
        // Unscaled: the nose sits (0.91 - -0.74) = 1.65 m above the lowest foot point, as MediaPipe measured it
        const nose = anchors.find(a => a.id === 'NOSE')!;
        expect(nose.point3D[1]).toBeCloseTo(1.65, 3);
    });

    it('throws instead of synthesizing a body when MediaPipe cannot run or finds nobody', async () => {
        await expect(AdaptiveMatchmoveCalibrationService.extractPoseAnchorsFromImage(Buffer.from([0]), {
            poseService: stubPoseService({ unavailable: 'python3 not found' })
        })).rejects.toBeInstanceOf(GeneratorFailedError);
        await expect(AdaptiveMatchmoveCalibrationService.extractPoseAnchorsFromImage(Buffer.from([0]), {
            poseService: stubPoseService({ noPerson: 'MediaPipe found no person in the image' })
        })).rejects.toBeInstanceOf(MissingInputError);
    });

    it('should accurately resect camera pose using 33 automated pose landmarks', () => {
        const synthetic = fixtureBodyLandmarks();
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

    it('adaptive_matchmove_extract_pose_anchors requires the plate size and fails typed without a detectable person', async () => {
        const handler = adaptiveMatchmoveHandlers.adaptive_matchmove_extract_pose_anchors;
        const ctx = { workspaceRoot: path.resolve(__dirname, '../../..') } as any;
        await expect(handler({ imagePath: 'missing_plate.jpg' }, ctx))
            .rejects.toMatchObject({ code: 'missing_input', message: expect.stringContaining('plateWidth') });
    });

    it('adaptive_matchmove_resect_keyframe with autoExtractPose fails typed instead of resecting a stand-in body', async () => {
        const handler = adaptiveMatchmoveHandlers.adaptive_matchmove_resect_keyframe;
        const ctx = { workspaceRoot: path.resolve(__dirname, '../../..') } as any;
        // No camera prior is assumed for a human pose
        await expect(handler({ imagePath: 'missing_plate.jpg', autoExtractPose: true, plateWidth: 1920, plateHeight: 1080, lens: { fovYDeg: 35 } }, ctx))
            .rejects.toMatchObject({ code: 'missing_input', message: expect.stringContaining('cameraPosition') });
    });
});
