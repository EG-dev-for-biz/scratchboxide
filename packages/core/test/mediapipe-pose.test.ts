/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { describe, it, expect } from 'vitest';
import {
    MediaPipePoseService
} from '../src/node/spatial/MediaPipePoseService';
import {
    MEDIAPIPE_LANDMARK_INDEX,
    MediaPipeLandmark
} from '../src/common/character-pose-protocol';

describe('MediaPipePoseService (3D Metric Pose Landmarker & Kinematics)', () => {
    const service = new MediaPipePoseService();

    function createMockHumanLandmarks(facingCamera = true): MediaPipeLandmark[] {
        const lms: MediaPipeLandmark[] = Array.from({ length: 33 }, () => ({
            x: 0,
            y: 0,
            z: 0,
            visibility: 0.95
        }));

        // Nose & head
        lms[MEDIAPIPE_LANDMARK_INDEX.NOSE] = { x: 0.0, y: -0.65, z: facingCamera ? -0.1 : 0.1, visibility: 0.95 };
        lms[MEDIAPIPE_LANDMARK_INDEX.LEFT_EYE] = { x: 0.03, y: -0.68, z: -0.08, visibility: 0.95 };
        lms[MEDIAPIPE_LANDMARK_INDEX.RIGHT_EYE] = { x: -0.03, y: -0.68, z: -0.08, visibility: 0.95 };
        lms[MEDIAPIPE_LANDMARK_INDEX.LEFT_EAR] = { x: 0.07, y: -0.66, z: 0.0, visibility: 0.95 };
        lms[MEDIAPIPE_LANDMARK_INDEX.RIGHT_EAR] = { x: -0.07, y: -0.66, z: 0.0, visibility: 0.95 };

        // Shoulders (MediaPipe: anatomical left is positive X for camera facing)
        lms[MEDIAPIPE_LANDMARK_INDEX.LEFT_SHOULDER] = { x: 0.22, y: -0.45, z: 0.0, visibility: 0.95 };
        lms[MEDIAPIPE_LANDMARK_INDEX.RIGHT_SHOULDER] = { x: -0.22, y: -0.45, z: 0.0, visibility: 0.95 };

        // Arms hanging down
        lms[MEDIAPIPE_LANDMARK_INDEX.LEFT_ELBOW] = { x: 0.24, y: -0.18, z: 0.0, visibility: 0.95 };
        lms[MEDIAPIPE_LANDMARK_INDEX.RIGHT_ELBOW] = { x: -0.24, y: -0.18, z: 0.0, visibility: 0.95 };
        lms[MEDIAPIPE_LANDMARK_INDEX.LEFT_WRIST] = { x: 0.23, y: 0.08, z: 0.0, visibility: 0.95 };
        lms[MEDIAPIPE_LANDMARK_INDEX.RIGHT_WRIST] = { x: -0.23, y: 0.08, z: 0.0, visibility: 0.95 };

        // Hips (origin at midpoint)
        lms[MEDIAPIPE_LANDMARK_INDEX.LEFT_HIP] = { x: 0.12, y: 0.0, z: 0.0, visibility: 0.95 };
        lms[MEDIAPIPE_LANDMARK_INDEX.RIGHT_HIP] = { x: -0.12, y: 0.0, z: 0.0, visibility: 0.95 };

        // Legs
        lms[MEDIAPIPE_LANDMARK_INDEX.LEFT_KNEE] = { x: 0.12, y: 0.45, z: 0.0, visibility: 0.95 };
        lms[MEDIAPIPE_LANDMARK_INDEX.RIGHT_KNEE] = { x: -0.12, y: 0.45, z: 0.0, visibility: 0.95 };
        lms[MEDIAPIPE_LANDMARK_INDEX.LEFT_ANKLE] = { x: 0.12, y: 0.88, z: 0.0, visibility: 0.95 };
        lms[MEDIAPIPE_LANDMARK_INDEX.RIGHT_ANKLE] = { x: -0.12, y: 0.88, z: 0.0, visibility: 0.95 };

        // Feet & Heels
        lms[MEDIAPIPE_LANDMARK_INDEX.LEFT_HEEL] = { x: 0.12, y: 0.92, z: -0.04, visibility: 0.95 };
        lms[MEDIAPIPE_LANDMARK_INDEX.RIGHT_HEEL] = { x: -0.12, y: 0.92, z: -0.04, visibility: 0.95 };
        lms[MEDIAPIPE_LANDMARK_INDEX.LEFT_FOOT_INDEX] = { x: 0.12, y: 0.91, z: 0.12, visibility: 0.95 };
        lms[MEDIAPIPE_LANDMARK_INDEX.RIGHT_FOOT_INDEX] = { x: -0.12, y: 0.91, z: 0.12, visibility: 0.95 };

        return lms;
    }

    it('should have exact 33 landmark index constants matching Google MediaPipe spec', () => {
        expect(Object.keys(MEDIAPIPE_LANDMARK_INDEX).length).toBe(33);
        expect(MEDIAPIPE_LANDMARK_INDEX.NOSE).toBe(0);
        expect(MEDIAPIPE_LANDMARK_INDEX.LEFT_SHOULDER).toBe(11);
        expect(MEDIAPIPE_LANDMARK_INDEX.RIGHT_SHOULDER).toBe(12);
        expect(MEDIAPIPE_LANDMARK_INDEX.LEFT_HIP).toBe(23);
        expect(MEDIAPIPE_LANDMARK_INDEX.RIGHT_HIP).toBe(24);
        expect(MEDIAPIPE_LANDMARK_INDEX.LEFT_ANKLE).toBe(27);
        expect(MEDIAPIPE_LANDMARK_INDEX.RIGHT_FOOT_INDEX).toBe(32);
    });

    it('should accurately derive anatomical BodyFrame from 3D world landmarks', () => {
        const lms = createMockHumanLandmarks(true);
        const frame = service.deriveBodyFrame(lms);
        expect(frame).not.toBeNull();
        if (!frame) return;

        // Hip midpoint should be near [0, 0, 0]
        expect(Math.abs(frame.hipMid[0])).toBeLessThan(0.01);
        expect(Math.abs(frame.hipMid[1])).toBeLessThan(0.01);
        expect(Math.abs(frame.hipMid[2])).toBeLessThan(0.01);

        // Shoulder midpoint should be at Y = -0.45 (MediaPipe Y is down, so shoulders are negative Y)
        expect(frame.shoulderMid[1]).toBeCloseTo(-0.45, 2);

        // Torso Up vector should point upward (in MediaPipe, that is negative Y)
        expect(frame.up[1]).toBeLessThan(-0.9);

        // Right vector from left shoulder to right shoulder should point along -X
        expect(frame.right[0]).toBeLessThan(-0.9);

        // Forward vector = cross(up, right) should point toward camera (negative Z)
        expect(frame.forward[2]).toBeLessThan(-0.9);
    });

    it('should solve anatomical Euler joint angles and confidence correctly', () => {
        const lms = createMockHumanLandmarks(true);
        const solved = service.landmarksToPose(lms);

        expect(solved.confidence).toBeGreaterThan(0.9);
        expect(solved.bodyFrame).toBeDefined();

        // Arms hanging down at side: elevation should be small (< 0.4 rad ≈ 23 deg)
        expect(solved.angles.leftUpperArm[0]).toBeLessThan(0.5);
        expect(solved.angles.rightUpperArm[0]).toBeLessThan(0.5);

        // Legs straight down: knee bend should be small (< 0.2 rad ≈ 11 deg)
        expect(Math.abs(solved.angles.leftLowerLeg[0])).toBeLessThan(0.2);
        expect(Math.abs(solved.angles.rightLowerLeg[0])).toBeLessThan(0.2);

        // Spine upright
        expect(Math.abs(solved.angles.spine[0])).toBeLessThan(0.2);
    });

    it('should calculate accurate grounded Y-offset in meters from foot landmarks', () => {
        const lms = createMockHumanLandmarks(true);
        const groundedY = service.computeGroundedYOffset(lms);

        // Heel at Y = 0.92m
        expect(groundedY).toBeCloseTo(0.92, 2);
    });

    it('should synthesize standard heuristic poses cleanly across presets', () => {
        const neutral = service.synthesizeHeuristicPose('neutral_standing');
        expect(neutral.success).toBe(true);
        expect(neutral.groundedYOffsetMeters).toBeCloseTo(0.85, 2);

        const tPose = service.synthesizeHeuristicPose('t_pose');
        // In T-pose, arms are elevated 90 degrees (pi/2 radians)
        expect(tPose.angles.leftUpperArm[2]).toBeCloseTo(Math.PI / 2, 2);
        expect(tPose.angles.rightUpperArm[2]).toBeCloseTo(-Math.PI / 2, 2);

        const walking = service.synthesizeHeuristicPose('walking');
        // One leg forward, one leg back
        expect(walking.angles.leftUpperLeg[0]).toBeGreaterThan(0);
        expect(walking.angles.rightUpperLeg[0]).toBeLessThan(0);
    });

    it('should gracefully fallback to valid heuristic pose on arbitrary image input when Python is absent', async () => {
        const dummyBuffer = Buffer.from('fake-image-bytes-for-unit-test');
        const output = await service.estimatePoseFromImage({
            image: dummyBuffer
        });

        expect(output.success).toBe(true);
        expect(output.personIndex).toBe(0);
        expect(output.confidence).toBeGreaterThan(0.7);
        expect(output.angles).toBeDefined();
        expect(output.groundedYOffsetMeters).toBeGreaterThan(0.5);
    });
});
