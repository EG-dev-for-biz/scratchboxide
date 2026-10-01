/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Canonical 33 MediaPipe Pose Landmark Indices.
 * Follows the Google MediaPipe Pose Landmarker full model specification.
 */
export const MEDIAPIPE_LANDMARK_INDEX = {
    NOSE: 0,
    LEFT_EYE_INNER: 1,
    LEFT_EYE: 2,
    LEFT_EYE_OUTER: 3,
    RIGHT_EYE_INNER: 4,
    RIGHT_EYE: 5,
    RIGHT_EYE_OUTER: 6,
    LEFT_EAR: 7,
    RIGHT_EAR: 8,
    MOUTH_LEFT: 9,
    MOUTH_RIGHT: 10,
    LEFT_SHOULDER: 11,
    RIGHT_SHOULDER: 12,
    LEFT_ELBOW: 13,
    RIGHT_ELBOW: 14,
    LEFT_WRIST: 15,
    RIGHT_WRIST: 16,
    LEFT_PINKY: 17,
    RIGHT_PINKY: 18,
    LEFT_INDEX: 19,
    RIGHT_INDEX: 20,
    LEFT_THUMB: 21,
    RIGHT_THUMB: 22,
    LEFT_HIP: 23,
    RIGHT_HIP: 24,
    LEFT_KNEE: 25,
    RIGHT_KNEE: 26,
    LEFT_ANKLE: 27,
    RIGHT_ANKLE: 28,
    LEFT_HEEL: 29,
    RIGHT_HEEL: 30,
    LEFT_FOOT_INDEX: 31,
    RIGHT_FOOT_INDEX: 32
} as const;

export type MediaPipeLandmarkName = keyof typeof MEDIAPIPE_LANDMARK_INDEX;

/**
 * 3D Landmark representation.
 * - In `imageLandmarks`: normalized to image dimensions [0.0 - 1.0].
 * - In `worldLandmarks`: true metric 3D coordinates in meters relative to hip midpoint
 *   (X=right, Y=down, Z=toward camera).
 */
export interface MediaPipeLandmark {
    x: number;
    y: number;
    z: number;
    visibility?: number;
}

export type EulerAngles3D = [number, number, number]; // [pitch, yaw, roll] in radians

/**
 * Anatomical joint rotation Euler angles in radians, aligned with the
 * Scratchbox Parametric Humanoid Standard (SB-Human) and Mixamo rig conventions.
 */
export interface HumanoidPoseAngles {
    leftUpperArm: EulerAngles3D;
    rightUpperArm: EulerAngles3D;
    leftLowerArm: EulerAngles3D;
    rightLowerArm: EulerAngles3D;
    leftUpperLeg: EulerAngles3D;
    rightUpperLeg: EulerAngles3D;
    leftLowerLeg: EulerAngles3D;
    rightLowerLeg: EulerAngles3D;
    spine: EulerAngles3D;
    head: EulerAngles3D;
}

/**
 * Raw multi-person detection result directly from MediaPipe.
 */
export interface PoseDetectionResult {
    /** Metric 3D landmarks in meters per detected person (for angle computation) */
    worldLandmarks: MediaPipeLandmark[][];
    /** Normalized 2D/3D image-space coordinates [0, 1] per detected person */
    imageLandmarks: MediaPipeLandmark[][];
}

/**
 * Anatomical body frame computed from shoulder and hip planes.
 */
export interface BodyFrame {
    hipMid: [number, number, number];
    shoulderMid: [number, number, number];
    up: [number, number, number];
    right: [number, number, number];
    forward: [number, number, number];
}

/**
 * Solved kinematic output ready to apply to 3D characters, parametric humanoids, or rigs.
 */
export interface RiggedPoseOutput {
    success: boolean;
    personIndex: number;
    angles: HumanoidPoseAngles;
    hipPositionMeters: [number, number, number];
    groundedYOffsetMeters: number;
    confidence: number;
    bodyFrame?: BodyFrame;
    error?: string;
}

/**
 * Input request for pose detection.
 */
export interface PoseDetectionRequest {
    /** File path, base64 string, data URL, or Buffer */
    image: string | Buffer;
    modelQuality?: 'lite' | 'full' | 'heavy';
    minConfidence?: number;
    maxPoses?: number;
}
