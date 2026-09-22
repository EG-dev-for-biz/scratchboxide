/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import {
    MediaPipeLandmark,
    MEDIAPIPE_LANDMARK_INDEX,
    HumanoidPoseAngles,
    RiggedPoseOutput
} from '../../common/character-pose-protocol';
import {
    HumanoidMotionData,
    HumanoidMotionFrame
} from '../3d-engine/Dynamic4DGaussianSplatService';
import { VideoMotionTrackResult, VideoMotionPoseFrame } from '../video/MediaPipeVideoDirectorService';

export interface RetargetOptions {
    groundAltitudeMeters?: number; // Target floor altitude (default: 0.0)
    pinFeetToGround?: boolean;      // Prevent foot-penetration into terrain (default: true)
    scaleFactor?: number;           // Uniform scale to match avatar height (default: 1.0)
    smoothingWindow?: number;       // Temporal joint filtering window (default: 3)
}

/**
 * Bridges MediaPipe 33 pose landmarks to 4DAnyone 22 SMPL-X skeletal joint representation.
 */
export class HumanoidMotionBridgeService {

    /**
     * Converts a full MediaPipe video motion track into a 4DAnyone HumanoidMotionData object.
     */
    public retargetVideoMotionTrack(
        trackResult: VideoMotionTrackResult,
        canonicalRestJoints?: Array<[number, number, number]>,
        options?: RetargetOptions
    ): HumanoidMotionData {
        const canonical = canonicalRestJoints || this.getDefaultCanonicalJoints();
        const groundAlt = options?.groundAltitudeMeters ?? 0.0;
        const pinFeet = options?.pinFeetToGround ?? true;
        const scale = options?.scaleFactor ?? 1.0;

        const frames: HumanoidMotionFrame[] = [];

        for (const frame of trackResult.frames) {
            let jointPositions: Array<[number, number, number]>;

            if (frame.worldLandmarks && frame.worldLandmarks.length >= 33) {
                jointPositions = this.convertLandmarksToSMPLX22(frame.worldLandmarks, scale);
            } else {
                jointPositions = this.synthesizeJointsFromAngles(frame.angles, canonical, scale);
            }

            // Ground-contact altitude compensation (pin lowest foot to groundAlt)
            if (pinFeet) {
                const leftFootY = jointPositions[10][1];
                const rightFootY = jointPositions[11][1];
                const lowestFootY = Math.min(leftFootY, rightFootY);
                const deltaY = groundAlt - lowestFootY;

                for (let j = 0; j < jointPositions.length; j++) {
                    jointPositions[j][1] += deltaY;
                }
            }

            const pelvis = jointPositions[0];
            const rootTrans: [number, number, number] = [pelvis[0], pelvis[1] - canonical[0][1], pelvis[2]];
            const rootRot: [number, number, number, number] = [0, 0, 0, 1];

            frames.push({
                frame_index: frame.frameIndex,
                timestamp: frame.timestampSec,
                root_translation: rootTrans,
                root_rotation_quat: rootRot,
                joint_positions_3d: jointPositions,
                confidence: frame.confidence
            });
        }

        // Apply temporal smoothing if requested
        const windowSize = options?.smoothingWindow ?? 1;
        const smoothedFrames = (windowSize > 1 && frames.length > 2)
            ? this.smoothJointTrajectories(frames, windowSize)
            : frames;

        return {
            fps: trackResult.sampleFps || 25.0,
            num_frames: smoothedFrames.length,
            num_joints: 22,
            joints_name: this.getSMPLX22JointNames(),
            kintree_parents: this.getSMPLX22Parents(),
            canonical_joints: canonical,
            frames: smoothedFrames
        };
    }

    /**
     * Maps 33 MediaPipe 3D landmarks into 22 SMPL-X / 4DAnyone joints in Y-up metric space.
     */
    public convertLandmarksToSMPLX22(
        lm: MediaPipeLandmark[],
        scale: number = 1.0
    ): Array<[number, number, number]> {
        const IDX = MEDIAPIPE_LANDMARK_INDEX;

        // Convert MediaPipe (X=right, Y=down, Z=depth) to Three.js/4DAnyone metric space (X=right, Y=up, Z=depth)
        const pt = (index: number): [number, number, number] => {
            const p = lm[index] || { x: 0, y: 0, z: 0 };
            return [p.x * scale, -p.y * scale, -p.z * scale];
        };

        const lerp = (a: [number, number, number], b: [number, number, number], t: number): [number, number, number] => [
            a[0] + (b[0] - a[0]) * t,
            a[1] + (b[1] - a[1]) * t,
            a[2] + (b[2] - a[2]) * t
        ];

        const lHip = pt(IDX.LEFT_HIP);
        const rHip = pt(IDX.RIGHT_HIP);
        const pelvis = lerp(lHip, rHip, 0.5);

        const lShoulder = pt(IDX.LEFT_SHOULDER);
        const rShoulder = pt(IDX.RIGHT_SHOULDER);
        const shoulderMid = lerp(lShoulder, rShoulder, 0.5);

        const lKnee = pt(IDX.LEFT_KNEE);
        const rKnee = pt(IDX.RIGHT_KNEE);

        const lAnkle = pt(IDX.LEFT_ANKLE);
        const rAnkle = pt(IDX.RIGHT_ANKLE);

        const lHeel = pt(IDX.LEFT_HEEL);
        const rHeel = pt(IDX.RIGHT_HEEL);
        const lFootIdx = pt(IDX.LEFT_FOOT_INDEX);
        const rFootIdx = pt(IDX.RIGHT_FOOT_INDEX);

        const lFoot = lerp(lHeel, lFootIdx, 0.5);
        const rFoot = lerp(rHeel, rFootIdx, 0.5);

        const nose = pt(IDX.NOSE);
        const lEar = pt(IDX.LEFT_EAR);
        const rEar = pt(IDX.RIGHT_EAR);
        const head = lerp(lEar, rEar, 0.5);

        const neck = lerp(shoulderMid, nose, 0.35);
        const lCollar = lerp(shoulderMid, lShoulder, 0.5);
        const rCollar = lerp(shoulderMid, rShoulder, 0.5);

        const lElbow = pt(IDX.LEFT_ELBOW);
        const rElbow = pt(IDX.RIGHT_ELBOW);
        const lWrist = pt(IDX.LEFT_WRIST);
        const rWrist = pt(IDX.RIGHT_WRIST);

        // Spine interpolation between pelvis and shoulder center
        const spine1 = lerp(pelvis, shoulderMid, 0.25);
        const spine2 = lerp(pelvis, shoulderMid, 0.50);
        const spine3 = lerp(pelvis, shoulderMid, 0.75);

        // Exactly 22 Canonical SMPL-X joints
        return [
            pelvis,    // 0
            lHip,      // 1
            rHip,      // 2
            spine1,    // 3
            lKnee,     // 4
            rKnee,     // 5
            spine2,    // 6
            lAnkle,    // 7
            rAnkle,    // 8
            spine3,    // 9
            lFoot,     // 10
            rFoot,     // 11
            neck,      // 12
            lCollar,   // 13
            rCollar,   // 14
            head,      // 15
            lShoulder, // 16
            rShoulder, // 17
            lElbow,    // 18
            rElbow,    // 19
            lWrist,    // 20
            rWrist     // 21
        ];
    }

    /**
     * Synthesizes joint positions from Euler angles via forward kinematics when raw landmarks are unavailable.
     */
    public synthesizeJointsFromAngles(
        angles: HumanoidPoseAngles,
        canonical: Array<[number, number, number]>,
        scale: number = 1.0
    ): Array<[number, number, number]> {
        const posed: Array<[number, number, number]> = canonical.map(j => [j[0] * scale, j[1] * scale, j[2] * scale]);

        // Apply arm angles
        if (angles.leftUpperArm) {
            const rot = angles.leftUpperArm;
            posed[18][0] += Math.sin(rot[1]) * 0.25;
            posed[18][1] -= Math.cos(rot[0]) * 0.25;
        }
        if (angles.rightUpperArm) {
            const rot = angles.rightUpperArm;
            posed[19][0] -= Math.sin(rot[1]) * 0.25;
            posed[19][1] -= Math.cos(rot[0]) * 0.25;
        }

        // Apply leg angles
        if (angles.leftUpperLeg) {
            const rot = angles.leftUpperLeg;
            posed[4][2] += Math.sin(rot[0]) * 0.40;
            posed[4][1] -= (1.0 - Math.cos(rot[0])) * 0.10;
        }
        if (angles.rightUpperLeg) {
            const rot = angles.rightUpperLeg;
            posed[5][2] += Math.sin(rot[0]) * 0.40;
            posed[5][1] -= (1.0 - Math.cos(rot[0])) * 0.10;
        }

        return posed;
    }

    /**
     * Performs temporal moving average smoothing over joint trajectories.
     */
    private smoothJointTrajectories(frames: HumanoidMotionFrame[], windowSize: number): HumanoidMotionFrame[] {
        const numFrames = frames.length;
        const numJoints = frames[0].joint_positions_3d.length;
        const smoothed: HumanoidMotionFrame[] = [];
        const halfWindow = Math.floor(windowSize / 2);

        for (let i = 0; i < numFrames; i++) {
            const start = Math.max(0, i - halfWindow);
            const end = Math.min(numFrames - 1, i + halfWindow);
            const count = end - start + 1;

            const avgJoints: Array<[number, number, number]> = [];
            for (let j = 0; j < numJoints; j++) {
                let sx = 0, sy = 0, sz = 0;
                for (let k = start; k <= end; k++) {
                    const pos = frames[k].joint_positions_3d[j];
                    sx += pos[0];
                    sy += pos[1];
                    sz += pos[2];
                }
                avgJoints.push([sx / count, sy / count, sz / count]);
            }

            smoothed.push({
                ...frames[i],
                joint_positions_3d: avgJoints
            });
        }

        return smoothed;
    }

    public getSMPLX22JointNames(): string[] {
        return [
            'pelvis', 'left_hip', 'right_hip', 'spine1',
            'left_knee', 'right_knee', 'spine2', 'left_ankle',
            'right_ankle', 'spine3', 'left_foot', 'right_foot',
            'neck', 'left_collar', 'right_collar', 'head',
            'left_shoulder', 'right_shoulder', 'left_elbow', 'right_elbow',
            'left_wrist', 'right_wrist'
        ];
    }

    public getSMPLX22Parents(): number[] {
        return [-1, 0, 0, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 9, 9, 12, 13, 14, 16, 17, 18, 19];
    }

    public getDefaultCanonicalJoints(): Array<[number, number, number]> {
        return [
            [0.0031, 0.9353, 0.0400],
            [0.0613, 0.8426, -0.0140],
            [-0.0601, 0.8415, -0.0140],
            [0.0028, 1.0253, 0.0245],
            [0.0898, 0.4682, -0.0050],
            [-0.0892, 0.4685, -0.0050],
            [0.0035, 1.1553, 0.0125],
            [0.0712, 0.0782, -0.0520],
            [-0.0715, 0.0780, -0.0520],
            [0.0038, 1.2453, 0.0045],
            [0.0815, 0.0250, 0.0980],
            [-0.0812, 0.0250, 0.0980],
            [0.0040, 1.3453, -0.0247],
            [0.0448, 1.3143, -0.0003],
            [-0.0492, 1.3137, -0.0065],
            [0.0111, 1.5549, -0.0040],
            [0.1641, 1.3720, -0.0158],
            [-0.1518, 1.3672, -0.0191],
            [0.4182, 1.2998, -0.0582],
            [-0.4229, 1.3307, -0.0456],
            [0.6702, 1.3231, -0.0607],
            [-0.6722, 1.3262, -0.0609]
        ];
    }
}
