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
import { PerformerPoseTrack, PoseLandmarkTuple } from './PerformerPoseTrackService';
import { Mat3, Vec3, applyMat3, retargetSegmentDirections, rotationBetween } from '../../common/humanoid-skinning';

export interface PoseTrackRetargetOptions {
    clipId?: string;
    targetHeightMeters?: number;
    /** Temporal 1-2-1 smoothing passes applied to tracked landmarks (default 1). */
    smoothingPasses?: number;
    maxFrames?: number;
    /** Hero camera focal length in pixels; defaults to the pipeline's 47 degree horizontal FOV. */
    focalLengthPx?: number;
}

/** Matches the default hero intrinsics in VideoTo4DPerformerPipelineService. */
const DEFAULT_HORIZONTAL_FOV_RAD = 0.8202546810829819;

export interface RetargetOptions {
    groundAltitudeMeters?: number; // Target floor altitude (default: 0.0)
    pinFeetToGround?: boolean;      // Prevent foot-penetration into terrain (default: true)
    scaleFactor?: number;           // Uniform scale to match avatar height (default: 1.0)
    smoothingWindow?: number;       // Temporal joint filtering window (default: 3)
}

/**
 * Bridges MediaPipe 33 pose landmarks to 22 SB-Human skeletal joint representation.
 */
export class HumanoidMotionBridgeService {

    /**
     * Converts a full MediaPipe video motion track into a SB-Human HumanoidMotionData object.
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
                jointPositions = this.convertLandmarksToSbHuman22(frame.worldLandmarks, scale);
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
     * Converts a MediaPipe PoseLandmarker video track into avatar motion: segment directions come
     * from metric world landmarks, bone lengths from the avatar skeleton, lateral root travel from
     * the hip centre's image drift, and the lowest foot is pinned to the canonical floor each frame.
     * The tracking camera's tilt is removed (see camera_to_world) so the avatar stands upright.
     */
    public retargetPoseTrack(
        track: PerformerPoseTrack,
        canonicalJoints: Array<[number, number, number]>,
        options: PoseTrackRetargetOptions = {}
    ): HumanoidMotionData {
        const firstValid = track.frames.findIndex(f => f.world && f.world.length >= 33);
        if (firstValid < 0) {
            throw new Error(`Pose track ${track.source} contains no tracked frames`);
        }
        const limit = Math.min(track.frames.length, options.maxFrames ?? track.frames.length);

        let lastWorld = track.frames[firstValid].world!;
        let lastImage = track.frames[firstValid].image;
        const worlds: PoseLandmarkTuple[][] = [];
        const images: Array<PoseLandmarkTuple[] | null> = [];
        for (let f = 0; f < limit; f++) {
            const fr = track.frames[f];
            if (fr.world && fr.world.length >= 33) lastWorld = fr.world;
            if (fr.image && fr.image.length >= 33) lastImage = fr.image;
            worlds.push(lastWorld);
            images.push(lastImage);
        }

        const worldJoints = worlds.map(w => this.convertLandmarksToSMPLX22(w.map(([x, y, z, v]) => ({ x, y, z, visibility: v }))));
        const focalLengthPx = options.focalLengthPx ?? track.width / (2 * Math.tan(DEFAULT_HORIZONTAL_FOV_RAD / 2));
        const cameraJoints = this.liftLimbsFromImage(worldJoints, worlds, images, canonicalJoints as Vec3[], track.width, track.height, focalLengthPx);

        // World landmarks live in the camera frame, so a tilted camera makes an upright performer
        // lean. The clip-average ankle->shoulder axis estimates gravity; rotate it onto +Y.
        const up: Vec3 = [0, 0, 0];
        for (const j of cameraJoints) {
            for (let a = 0; a < 3; a++) up[a] += (j[16][a] + j[17][a]) * 0.5 - (j[7][a] + j[8][a]) * 0.5;
        }
        const cameraToWorld: Mat3 = rotationBetween(up, [0, 1, 0]);
        const sourceJoints = cameraJoints.map(js => js.map(p => applyMat3(cameraToWorld, p as Vec3)));
        const passes = options.smoothingPasses ?? 1;
        let smoothed = sourceJoints as Vec3[][];
        for (let p = 0; p < passes; p++) {
            smoothed = smoothed.map((_, f) => {
                const a = smoothed[Math.max(0, f - 1)];
                const b = smoothed[f];
                const c = smoothed[Math.min(smoothed.length - 1, f + 1)];
                return b.map((jb, j) => [
                    (a[j][0] + 2 * jb[0] + c[j][0]) * 0.25,
                    (a[j][1] + 2 * jb[1] + c[j][1]) * 0.25,
                    (a[j][2] + 2 * jb[2] + c[j][2]) * 0.25
                ] as Vec3);
            });
        }

        // Metres per normalized-image unit, from the performer's apparent height in the first tracked frame.
        const targetHeight = options.targetHeightMeters ?? (Math.max(...canonicalJoints.map(j => j[1])) + 0.12);
        const hipCenterX = (img: PoseLandmarkTuple[] | null) => (img ? (img[23][0] + img[24][0]) * 0.5 : 0.5);
        const img0 = images[0];
        let metresPerImageX = 0;
        if (img0 && track.width > 0 && track.height > 0) {
            const eyeY = Math.min(img0[2][1], img0[5][1]);
            const footY = Math.max(img0[29][1], img0[30][1], img0[31][1], img0[32][1]);
            const heightPx = Math.max(1, (footY - eyeY) * track.height / 0.935);
            metresPerImageX = (track.width / heightPx) * targetHeight;
        }
        const hipX0 = hipCenterX(img0);

        const canonical = canonicalJoints as Vec3[];
        const floorY = Math.min(canonical[10][1], canonical[11][1]);
        const fps = track.fps || 25;
        const frames: HumanoidMotionFrame[] = smoothed.map((src, f) => {
            const rootX = canonical[0][0] + (hipCenterX(images[f]) - hipX0) * metresPerImageX;
            const joints = retargetSegmentDirections(canonical, src, [rootX, canonical[0][1], canonical[0][2]]);
            const lift = floorY - Math.min(joints[10][1], joints[11][1]);
            for (const j of joints) j[1] += lift;
            const pelvis = joints[0];
            return {
                frame_index: f,
                timestamp: f / fps,
                root_translation: [pelvis[0] - canonical[0][0], pelvis[1] - canonical[0][1], pelvis[2] - canonical[0][2]],
                root_rotation_quat: [0, 0, 0, 1],
                joint_positions_3d: joints as Array<[number, number, number]>,
                confidence: worlds[f].reduce((s, l) => s + l[3], 0) / worlds[f].length
            };
        });

        return {
            clip_id: options.clipId,
            body_model: 'smplx_22',
            fps,
            num_frames: frames.length,
            num_joints: 22,
            joints_name: this.getSMPLX22JointNames(),
            kintree_parents: this.getSMPLX22Parents(),
            canonical_joints: canonicalJoints,
            frames,
            motion_source: 'mediapipe_pose_track',
            source_video: track.source,
            camera_to_world: cameraToWorld
        };
    }

    /**
     * MediaPipe world depth is weak for frontal limbs (straight legs come back bent 30-50 degrees) and its
     * bone lengths are asymmetric, while 2D image landmarks are accurate. Limbs are re-lifted under full
     * perspective: each limb joint is the intersection of its image ray with a sphere around its parent;
     * world landmarks only choose the near or far intersection.
     * Output is in the camera frame (x right, y up, z towards the camera).
     */
    private liftLimbsFromImage(
        worldJoints: Vec3[][],
        worlds: PoseLandmarkTuple[][],
        images: Array<PoseLandmarkTuple[] | null>,
        canonical: Vec3[],
        width: number,
        height: number,
        focalLengthPx: number
    ): Vec3[][] {
        const LIMBS: Array<[number, number]> = [[16, 18], [18, 20], [17, 19], [19, 21], [1, 4], [4, 7], [2, 5], [5, 8]];
        const parents = this.getSMPLX22Parents();
        const dist = (a: Vec3, b: Vec3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
        const mid = (a: Vec3, b: Vec3): Vec3 => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
        const median = (v: number[]) => {
            const s = v.filter(Number.isFinite).sort((x, y) => x - y);
            return s.length ? s[Math.floor(s.length / 2)] : NaN;
        };
        if (!(width > 0 && height > 0 && focalLengthPx > 0)) return worldJoints;
        const cx = width / 2;
        const cy = height / 2;

        const pixelJoints = images.map(img => img
            ? this.convertLandmarksToSMPLX22(img.map(([x, y, , v]) => ({ x: x * width, y: -y * height, z: 0, visibility: v })))
            : null);
        const visibility = worlds.map(w => this.convertLandmarksToSMPLX22(w.map(([, , , v]) => ({ x: v, y: 0, z: 0, visibility: v }))));
        const ray = (px: Vec3): Vec3 => {
            const d: Vec3 = [(px[0] - cx) / focalLengthPx, -(px[1] - cy) / focalLengthPx, -1];
            const l = Math.hypot(d[0], d[1], d[2]);
            return [d[0] / l, d[1] / l, d[2] / l];
        };

        // Depth from the torso's pixel length against the avatar torso, median-filtered over +-12 frames
        // (performers stay mostly upright; single-frame torso foreshortening would otherwise dominate).
        const torsoLen = dist(mid(canonical[16], canonical[17]), mid(canonical[1], canonical[2]));
        const rawDepth = pixelJoints.map(px => {
            if (!px) return NaN;
            const l = dist(mid(px[16], px[17]), mid(px[1], px[2]));
            return l > 2 ? (focalLengthPx * torsoLen) / l : NaN;
        });
        const depth = rawDepth.map((_, f) => median(rawDepth.slice(Math.max(0, f - 12), f + 13)));

        // Performer limb lengths: median apparent length at that depth. Straight-in-image limbs lift straight;
        // an underestimate only flattens a limb towards the image plane.
        const boneLen = new Map<number, number>();
        for (const [p, c] of LIMBS) {
            const apparent = median(pixelJoints.map((px, f) =>
                px && visibility[f][p][0] >= 0.5 && visibility[f][c][0] >= 0.5 ? (dist(px[p], px[c]) * depth[f]) / focalLengthPx : NaN));
            boneLen.set(c, Number.isFinite(apparent) ? apparent : dist(canonical[p], canonical[c]));
        }

        return worldJoints.map((joints, f) => {
            const px = pixelJoints[f];
            const d0 = depth[f];
            if (!px || !Number.isFinite(d0)) return joints;
            const r0 = ray(px[0]);
            const pelvis: Vec3 = [r0[0] * d0 / -r0[2], r0[1] * d0 / -r0[2], -d0];
            const out = joints.map(j => [j[0] - joints[0][0] + pelvis[0], j[1] - joints[0][1] + pelvis[1], j[2] - joints[0][2] + pelvis[2]] as Vec3);

            for (const [p, c] of LIMBS) {
                if (visibility[f][p][0] < 0.5 || visibility[f][c][0] < 0.5) continue;
                const L = boneLen.get(c)!;
                const r = ray(px[c]);
                const P = out[p];
                const rp = r[0] * P[0] + r[1] * P[1] + r[2] * P[2];
                const disc = rp * rp - (P[0] * P[0] + P[1] * P[1] + P[2] * P[2] - L * L);
                let t = rp;
                if (disc > 0) {
                    // Perspective makes the two intersections asymmetric; take the one whose depth offset
                    // best matches the world landmarks rather than just its sign.
                    const root = Math.sqrt(disc);
                    const expectedDz = joints[c][2] - joints[p][2];
                    const dzOf = (tt: number) => r[2] * tt - P[2];
                    t = Math.abs(dzOf(rp - root) - expectedDz) <= Math.abs(dzOf(rp + root) - expectedDz) ? rp - root : rp + root;
                }
                const target: Vec3 = [r[0] * t, r[1] * t, r[2] * t];
                const delta: Vec3 = [target[0] - out[c][0], target[1] - out[c][1], target[2] - out[c][2]];
                for (let j = c; j < out.length; j++) {
                    let a = j;
                    while (a > c) a = parents[a];
                    if (a === c) out[j] = [out[j][0] + delta[0], out[j][1] + delta[1], out[j][2] + delta[2]];
                }
            }
            return out;
        });
    }

    /**
     * Maps 33 MediaPipe 3D landmarks into 22 SB-Human joints in Y-up metric space.
     */
    public convertLandmarksToSbHuman22(
        lm: MediaPipeLandmark[],
        scale: number = 1.0
    ): Array<[number, number, number]> {
        const IDX = MEDIAPIPE_LANDMARK_INDEX;

        // Convert MediaPipe (X=right, Y=down, Z=depth) to Three.js metric space (X=right, Y=up, Z=depth)
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

        // Exactly 22 Canonical SB-Human joints
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
     * Backward-compatible alias for convertLandmarksToSbHuman22.
     */
    public convertLandmarksToSMPLX22(
        lm: MediaPipeLandmark[],
        scale: number = 1.0
    ): Array<[number, number, number]> {
        return this.convertLandmarksToSbHuman22(lm, scale);
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
