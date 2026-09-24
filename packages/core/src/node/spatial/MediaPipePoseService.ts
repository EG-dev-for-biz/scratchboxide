/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import * as fs from 'fs-extra';
import * as path from 'path';
import { spawn } from 'child_process';
import {
    MEDIAPIPE_LANDMARK_INDEX,
    MediaPipeLandmark,
    HumanoidPoseAngles,
    EulerAngles3D,
    PoseDetectionResult,
    BodyFrame,
    RiggedPoseOutput,
    PoseDetectionRequest
} from '../../common/character-pose-protocol';

interface Vec3 {
    x: number;
    y: number;
    z: number;
}

const IDX = MEDIAPIPE_LANDMARK_INDEX;
const MIN_VISIBILITY = 0.4;
const DEFAULT_TIMEOUT_MS = 20_000;

export interface MediaPipePoseServiceOptions {
    pythonBinary?: string;
    scriptPath?: string;
    modelAssetPath?: string;
    timeoutMs?: number;
}

export class MediaPipePoseService {
    private pythonBinary: string;
    private scriptPath: string;
    private modelAssetPath: string;
    private timeoutMs: number;
    private static unavailable = false;

    constructor(options?: MediaPipePoseServiceOptions) {
        this.pythonBinary = options?.pythonBinary ?? process.env.PYTHON_BIN ?? 'python3';
        this.scriptPath = options?.scriptPath ?? path.resolve(process.cwd(), 'scripts/detect_pose.py');
        this.modelAssetPath = options?.modelAssetPath ?? path.resolve(process.cwd(), 'assets/models/pose_landmarker_full.task');
        this.timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    }

    /**
     * Executes MediaPipe Pose Landmarker via the Python daemon bridge on a raw image buffer.
     * Returns null if Python or the model is unavailable, or if no persons were detected.
     */
    public async detectPoseLandmarks(
        imageBuffer: Buffer,
        options?: { modelPath?: string; numPoses?: number; minConfidence?: number }
    ): Promise<PoseDetectionResult | null> {
        if (MediaPipePoseService.unavailable) {
            return null;
        }

        if (!fs.existsSync(this.scriptPath)) {
            return null;
        }

        const modelPath = options?.modelPath ?? this.modelAssetPath;
        const numPoses = options?.numPoses ?? 5;
        const minConf = options?.minConfidence ?? 0.5;

        try {
            const rawOutput = await this.spawnPythonWorker(imageBuffer, [
                this.scriptPath,
                modelPath,
                String(numPoses),
                String(minConf)
            ]);

            if (!rawOutput) return null;

            const parsed = JSON.parse(rawOutput);
            if (parsed.error) {
                return null;
            }

            const rawPoses = parsed.poses as Array<{ world: MediaPipeLandmark[]; image: MediaPipeLandmark[] }> | undefined;
            if (!rawPoses || rawPoses.length === 0) {
                return null;
            }

            return {
                worldLandmarks: rawPoses.map(p => p.world),
                imageLandmarks: rawPoses.map(p => p.image)
            };
        } catch {
            return null;
        }
    }

    /**
     * Normalizes image input from path, base64 data URL, or Buffer into a Buffer.
     */
    public async normalizeImageInput(input: string | Buffer): Promise<Buffer> {
        if (Buffer.isBuffer(input)) {
            return input;
        }
        if (typeof input === 'string') {
            if (input.startsWith('data:')) {
                const base64Data = input.split(',')[1] ?? input;
                return Buffer.from(base64Data, 'base64');
            }
            if (await fs.pathExists(input)) {
                return await fs.readFile(input);
            }
            // Assume raw base64 string
            return Buffer.from(input, 'base64');
        }
        throw new Error('Unsupported image input type for pose detection');
    }

    /**
     * Solves anatomical body frame vectors (up, right, forward) from 3D world landmarks.
     * MediaPipe world coordinates: X=right, Y=down, Z=away-from-camera (right-handed).
     * For camera-facing subject: right≈(-1,0,0), up≈(0,-1,0), forward=cross(up, right)≈(0,0,-1) toward camera.
     */
    public deriveBodyFrame(lms: MediaPipeLandmark[]): BodyFrame | null {
        if (!this.allVisible(lms, IDX.LEFT_SHOULDER, IDX.RIGHT_SHOULDER, IDX.LEFT_HIP, IDX.RIGHT_HIP)) {
            return null;
        }

        const lShoulder = this.lm(lms, IDX.LEFT_SHOULDER);
        const rShoulder = this.lm(lms, IDX.RIGHT_SHOULDER);
        const lHip = this.lm(lms, IDX.LEFT_HIP);
        const rHip = this.lm(lms, IDX.RIGHT_HIP);

        const shoulderMid = this.scale(this.add(lShoulder, rShoulder), 0.5);
        const hipMid = this.scale(this.add(lHip, rHip), 0.5);

        const up = this.normalize(this.sub(shoulderMid, hipMid));
        // Anatomical right vector from left shoulder toward right shoulder
        const right = this.normalize(this.sub(rShoulder, lShoulder));
        // Anatomical forward direction (torso facing vector)
        const forward = this.normalize(this.cross(up, right));

        return {
            hipMid: [hipMid.x, hipMid.y, hipMid.z],
            shoulderMid: [shoulderMid.x, shoulderMid.y, shoulderMid.z],
            up: [up.x, up.y, up.z],
            right: [right.x, right.y, right.z],
            forward: [forward.x, forward.y, forward.z]
        };
    }

    /**
     * Converts MediaPipe 3D metric world landmarks and 2D image landmarks into
     * articulated anatomical joint angles in radians, aligned with the SB-Human standard.
     */
    public landmarksToPose(
        worldLms: MediaPipeLandmark[],
        imageLms?: MediaPipeLandmark[]
    ): { angles: HumanoidPoseAngles; confidence: number; bodyFrame?: BodyFrame } {
        const frame = this.deriveBodyFrame(worldLms);
        const imgLms = imageLms && imageLms.length >= 33 ? imageLms : worldLms;

        // Default rest pose (standing neutral)
        let leftArmElevDeg = 15;
        let rightArmElevDeg = 15;
        let leftArmFwdDeg = 0;
        let rightArmFwdDeg = 0;
        let leftElbowBendDeg = 10;
        let rightElbowBendDeg = 10;

        let leftHipFwdDeg = 0;
        let rightHipFwdDeg = 0;
        let leftHipSpreadDeg = 5;
        let rightHipSpreadDeg = 5;
        let leftKneeBendDeg = 5;
        let rightKneeBendDeg = 5;

        let spineFwdDeg = 0;
        let spineLateralDeg = 0;
        let headTiltDeg = 0;
        let headTurnDeg = 0;
        let headRollDeg = 0;

        if (frame) {
            const frameUp: Vec3 = { x: frame.up[0], y: frame.up[1], z: frame.up[2] };
            const frameRight: Vec3 = { x: frame.right[0], y: frame.right[1], z: frame.right[2] };
            const frameFwd: Vec3 = { x: frame.forward[0], y: frame.forward[1], z: frame.forward[2] };

            // 1. Spine tilt
            if (this.allVisible(worldLms, IDX.LEFT_HIP, IDX.RIGHT_HIP, IDX.LEFT_SHOULDER, IDX.RIGHT_SHOULDER)) {
                const sMid = this.scale(this.add(this.lm(worldLms, IDX.LEFT_SHOULDER), this.lm(worldLms, IDX.RIGHT_SHOULDER)), 0.5);
                const hMid = this.scale(this.add(this.lm(worldLms, IDX.LEFT_HIP), this.lm(worldLms, IDX.RIGHT_HIP)), 0.5);
                const spineVec = this.normalize(this.sub(sMid, hMid));
                const latComp = this.dot(spineVec, frameRight);
                const fwdComp = this.dot(spineVec, frameFwd);

                spineFwdDeg = this.clamp(this.toDeg(Math.asin(this.clamp(fwdComp, -1, 1))), -25, 45);
                spineLateralDeg = this.clamp(this.toDeg(Math.asin(this.clamp(-latComp, -1, 1))), -25, 25);
            }

            // 2. Arms
            if (this.allVisible(worldLms, IDX.LEFT_SHOULDER, IDX.LEFT_ELBOW)) {
                const armVec = this.normalize(this.sub(this.lm(worldLms, IDX.LEFT_ELBOW), this.lm(worldLms, IDX.LEFT_SHOULDER)));
                const fwd = this.dot(armVec, frameFwd);
                leftArmFwdDeg = this.clamp(this.toDeg(Math.asin(this.clamp(fwd, -1, 1))), -30, 90);

                // Arm elevation relative to body-down
                const bodyDown = this.scale(frameUp, -1);
                const downDot = this.clamp(this.dot(armVec, bodyDown), -1, 1);
                leftArmElevDeg = this.clamp(this.toDeg(Math.acos(downDot)), 0, 160);
            }

            if (this.allVisible(worldLms, IDX.RIGHT_SHOULDER, IDX.RIGHT_ELBOW)) {
                const armVec = this.normalize(this.sub(this.lm(worldLms, IDX.RIGHT_ELBOW), this.lm(worldLms, IDX.RIGHT_SHOULDER)));
                const fwd = this.dot(armVec, frameFwd);
                rightArmFwdDeg = this.clamp(this.toDeg(Math.asin(this.clamp(fwd, -1, 1))), -30, 90);

                const bodyDown = this.scale(frameUp, -1);
                const downDot = this.clamp(this.dot(armVec, bodyDown), -1, 1);
                rightArmElevDeg = this.clamp(this.toDeg(Math.acos(downDot)), 0, 160);
            }

            // 3. Elbows
            if (this.allVisible(worldLms, IDX.LEFT_SHOULDER, IDX.LEFT_ELBOW, IDX.LEFT_WRIST)) {
                const interior = this.interiorAngleDeg(
                    this.lm(worldLms, IDX.LEFT_SHOULDER),
                    this.lm(worldLms, IDX.LEFT_ELBOW),
                    this.lm(worldLms, IDX.LEFT_WRIST)
                );
                leftElbowBendDeg = this.clamp(180 - interior, 0, 145);
            }

            if (this.allVisible(worldLms, IDX.RIGHT_SHOULDER, IDX.RIGHT_ELBOW, IDX.RIGHT_WRIST)) {
                const interior = this.interiorAngleDeg(
                    this.lm(worldLms, IDX.RIGHT_SHOULDER),
                    this.lm(worldLms, IDX.RIGHT_ELBOW),
                    this.lm(worldLms, IDX.RIGHT_WRIST)
                );
                rightElbowBendDeg = this.clamp(180 - interior, 0, 145);
            }

            // 4. Hips & Legs
            if (this.allVisible(worldLms, IDX.LEFT_HIP, IDX.LEFT_KNEE)) {
                const thighVec = this.normalize(this.sub(this.lm(worldLms, IDX.LEFT_KNEE), this.lm(worldLms, IDX.LEFT_HIP)));
                const fwd = this.dot(thighVec, frameFwd);
                const bodyDown = this.scale(frameUp, -1);
                const vert = this.dot(thighVec, bodyDown);
                leftHipFwdDeg = this.clamp(this.toDeg(Math.atan2(fwd, vert)), -30, 90);

                const lateral = this.dot(thighVec, frameRight);
                leftHipSpreadDeg = this.clamp(this.toDeg(Math.asin(this.clamp(-lateral, -1, 1))), -15, 55);
            }

            if (this.allVisible(worldLms, IDX.RIGHT_HIP, IDX.RIGHT_KNEE)) {
                const thighVec = this.normalize(this.sub(this.lm(worldLms, IDX.RIGHT_KNEE), this.lm(worldLms, IDX.RIGHT_HIP)));
                const fwd = this.dot(thighVec, frameFwd);
                const bodyDown = this.scale(frameUp, -1);
                const vert = this.dot(thighVec, bodyDown);
                rightHipFwdDeg = this.clamp(this.toDeg(Math.atan2(fwd, vert)), -30, 90);

                const lateral = this.dot(thighVec, frameRight);
                rightHipSpreadDeg = this.clamp(this.toDeg(Math.asin(this.clamp(lateral, -1, 1))), -15, 55);
            }

            // 5. Knees
            if (this.allVisible(worldLms, IDX.LEFT_HIP, IDX.LEFT_KNEE, IDX.LEFT_ANKLE)) {
                const interior = this.interiorAngleDeg(
                    this.lm(worldLms, IDX.LEFT_HIP),
                    this.lm(worldLms, IDX.LEFT_KNEE),
                    this.lm(worldLms, IDX.LEFT_ANKLE)
                );
                leftKneeBendDeg = this.clamp(180 - interior, 0, 130);
            }

            if (this.allVisible(worldLms, IDX.RIGHT_HIP, IDX.RIGHT_KNEE, IDX.RIGHT_ANKLE)) {
                const interior = this.interiorAngleDeg(
                    this.lm(worldLms, IDX.RIGHT_HIP),
                    this.lm(worldLms, IDX.RIGHT_KNEE),
                    this.lm(worldLms, IDX.RIGHT_ANKLE)
                );
                rightKneeBendDeg = this.clamp(180 - interior, 0, 130);
            }

            // 6. Head
            if (this.allVisible(imgLms, IDX.NOSE, IDX.LEFT_SHOULDER, IDX.RIGHT_SHOULDER)) {
                const sMidX = (imgLms[IDX.LEFT_SHOULDER].x + imgLms[IDX.RIGHT_SHOULDER].x) / 2;
                const sMidY = (imgLms[IDX.LEFT_SHOULDER].y + imgLms[IDX.RIGHT_SHOULDER].y) / 2;
                const offX = imgLms[IDX.NOSE].x - sMidX;
                const offY = imgLms[IDX.NOSE].y - sMidY;
                const sWidth = Math.max(Math.abs(imgLms[IDX.RIGHT_SHOULDER].x - imgLms[IDX.LEFT_SHOULDER].x), 0.05);

                headTurnDeg = this.clamp((offX / sWidth) * 45, -60, 60);
                headTiltDeg = this.clamp((-offY / sWidth) * 35, -30, 40);
            }
        }

        const angles: HumanoidPoseAngles = {
            leftUpperArm: [this.toRad(leftArmElevDeg), this.toRad(leftArmFwdDeg), 0],
            rightUpperArm: [this.toRad(rightArmElevDeg), this.toRad(rightArmFwdDeg), 0],
            leftLowerArm: [this.toRad(leftElbowBendDeg), 0, 0],
            rightLowerArm: [this.toRad(rightElbowBendDeg), 0, 0],
            leftUpperLeg: [this.toRad(leftHipFwdDeg), 0, this.toRad(leftHipSpreadDeg)],
            rightUpperLeg: [this.toRad(rightHipFwdDeg), 0, this.toRad(-rightHipSpreadDeg)],
            leftLowerLeg: [this.toRad(-leftKneeBendDeg), 0, 0],
            rightLowerLeg: [this.toRad(-rightKneeBendDeg), 0, 0],
            spine: [this.toRad(spineFwdDeg), 0, this.toRad(spineLateralDeg)],
            head: [this.toRad(headTiltDeg), this.toRad(headTurnDeg), this.toRad(headRollDeg)]
        };

        const visibilities = worldLms.map(l => l.visibility ?? 1.0);
        const avgConf = visibilities.reduce((a, b) => a + b, 0) / Math.max(visibilities.length, 1);

        return {
            angles,
            confidence: Math.round(avgConf * 100) / 100,
            bodyFrame: frame ?? undefined
        };
    }

    /**
     * Calculates the vertical ground compensation offset in meters.
     * In MediaPipe world coordinates (+Y is down), the lowest point on the human
     * (ankles or heels) has the largest positive Y.
     * Subtracting this ground reference ensures characters stand naturally on Y=0.
     */
    public computeGroundedYOffset(worldLms: MediaPipeLandmark[]): number {
        const footIndices = [
            IDX.LEFT_ANKLE,
            IDX.RIGHT_ANKLE,
            IDX.LEFT_HEEL,
            IDX.RIGHT_HEEL,
            IDX.LEFT_FOOT_INDEX,
            IDX.RIGHT_FOOT_INDEX
        ];

        let maxY = -Infinity;
        for (const idx of footIndices) {
            const lm = worldLms[idx];
            if (lm && (lm.visibility ?? 1) >= MIN_VISIBILITY) {
                if (lm.y > maxY) maxY = lm.y;
            }
        }

        if (maxY === -Infinity) {
            // Default leg length fallback: approx 0.85m below hip
            return 0.85;
        }

        // Return positive distance from hip midpoint to ground
        return Math.max(maxY, 0.4);
    }

    /**
     * End-to-end estimation pipeline: normalizes image, runs detection (or heuristic fallback),
     * and returns a complete RiggedPoseOutput.
     */
    public async estimatePoseFromImage(request: PoseDetectionRequest): Promise<RiggedPoseOutput> {
        try {
            const buffer = await this.normalizeImageInput(request.image);
            const detection = await this.detectPoseLandmarks(buffer, {
                minConfidence: request.minConfidence,
                numPoses: request.maxPoses ?? 1
            });

            if (detection && detection.worldLandmarks.length > 0) {
                const world = detection.worldLandmarks[0];
                const image = detection.imageLandmarks[0];
                const solved = this.landmarksToPose(world, image);
                const groundedY = this.computeGroundedYOffset(world);

                const hipMid = solved.bodyFrame?.hipMid ?? [0, 0, 0];

                return {
                    success: true,
                    personIndex: 0,
                    angles: solved.angles,
                    hipPositionMeters: [hipMid[0], hipMid[1], hipMid[2]],
                    groundedYOffsetMeters: groundedY,
                    confidence: solved.confidence,
                    bodyFrame: solved.bodyFrame
                };
            }
        } catch {
            // Fall through to heuristic fallback
        }

        // Graceful heuristic fallback
        return this.synthesizeHeuristicPose('neutral_standing');
    }

    /**
     * Synthesizes canonical kinematic poses without requiring external Python execution.
     */
    public synthesizeHeuristicPose(
        preset: 'neutral_standing' | 't_pose' | 'walking' | 'action_ready' = 'neutral_standing'
    ): RiggedPoseOutput {
        const angles: HumanoidPoseAngles = {
            leftUpperArm: [this.toRad(12), 0, 0],
            rightUpperArm: [this.toRad(12), 0, 0],
            leftLowerArm: [this.toRad(8), 0, 0],
            rightLowerArm: [this.toRad(8), 0, 0],
            leftUpperLeg: [0, 0, this.toRad(4)],
            rightUpperLeg: [0, 0, this.toRad(-4)],
            leftLowerLeg: [0, 0, 0],
            rightLowerLeg: [0, 0, 0],
            spine: [0, 0, 0],
            head: [0, 0, 0]
        };

        if (preset === 't_pose') {
            angles.leftUpperArm = [0, 0, this.toRad(90)];
            angles.rightUpperArm = [0, 0, this.toRad(-90)];
        } else if (preset === 'walking') {
            angles.leftUpperArm = [this.toRad(-20), 0, 0];
            angles.rightUpperArm = [this.toRad(25), 0, 0];
            angles.leftUpperLeg = [this.toRad(25), 0, this.toRad(3)];
            angles.rightUpperLeg = [this.toRad(-20), 0, this.toRad(-3)];
            angles.leftLowerLeg = [this.toRad(-15), 0, 0];
            angles.rightLowerLeg = [this.toRad(-5), 0, 0];
        } else if (preset === 'action_ready') {
            angles.leftUpperArm = [this.toRad(35), this.toRad(20), 0];
            angles.rightUpperArm = [this.toRad(35), this.toRad(-20), 0];
            angles.leftLowerArm = [this.toRad(65), 0, 0];
            angles.rightLowerArm = [this.toRad(65), 0, 0];
            angles.leftUpperLeg = [this.toRad(15), 0, this.toRad(8)];
            angles.rightUpperLeg = [this.toRad(-10), 0, this.toRad(-8)];
            angles.leftLowerLeg = [this.toRad(-25), 0, 0];
            angles.rightLowerLeg = [this.toRad(-20), 0, 0];
            angles.spine = [this.toRad(10), 0, 0];
        }

        return {
            success: true,
            personIndex: 0,
            angles,
            hipPositionMeters: [0, 0, 0],
            groundedYOffsetMeters: 0.85,
            confidence: 0.85
        };
    }

    // ── Internal Vector Utilities ──────────────────────────────────────────────

    private sub(a: Vec3, b: Vec3): Vec3 {
        return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
    }

    private add(a: Vec3, b: Vec3): Vec3 {
        return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z };
    }

    private scale(a: Vec3, s: number): Vec3 {
        return { x: a.x * s, y: a.y * s, z: a.z * s };
    }

    private dot(a: Vec3, b: Vec3): number {
        return a.x * b.x + a.y * b.y + a.z * b.z;
    }

    private cross(a: Vec3, b: Vec3): Vec3 {
        return {
            x: a.y * b.z - a.z * b.y,
            y: a.z * b.x - a.x * b.z,
            z: a.x * b.y - a.y * b.x
        };
    }

    private len(a: Vec3): number {
        return Math.sqrt(this.dot(a, a));
    }

    private normalize(a: Vec3): Vec3 {
        const l = this.len(a);
        if (l < 1e-9) return { x: 0, y: 1, z: 0 };
        return this.scale(a, 1 / l);
    }

    private clamp(v: number, lo: number, hi: number): number {
        return Math.max(lo, Math.min(hi, v));
    }

    private toDeg(rad: number): number {
        return (rad * 180) / Math.PI;
    }

    private toRad(deg: number): number {
        return (deg * Math.PI) / 180;
    }

    private interiorAngleDeg(a: Vec3, b: Vec3, c: Vec3): number {
        const ba = this.normalize(this.sub(a, b));
        const bc = this.normalize(this.sub(c, b));
        return this.toDeg(Math.acos(this.clamp(this.dot(ba, bc), -1, 1)));
    }

    private allVisible(lms: MediaPipeLandmark[], ...indices: number[]): boolean {
        return indices.every(i => (lms[i]?.visibility ?? 1) >= MIN_VISIBILITY);
    }

    private lm(lms: MediaPipeLandmark[], i: number): Vec3 {
        const l = lms[i];
        return { x: l.x, y: l.y, z: l.z };
    }

    private spawnPythonWorker(imageBuffer: Buffer, args: string[]): Promise<string | null> {
        return new Promise((resolve) => {
            const child = spawn(this.pythonBinary, args, { stdio: ['pipe', 'pipe', 'pipe'] });
            let stdout = '';
            let timedOut = false;

            const timer = setTimeout(() => {
                timedOut = true;
                child.kill('SIGTERM');
                resolve(null);
            }, this.timeoutMs);

            child.stdout.on('data', (data) => {
                stdout += data.toString();
            });

            child.on('close', (code) => {
                clearTimeout(timer);
                if (timedOut || code !== 0) {
                    resolve(null);
                } else {
                    resolve(stdout.trim());
                }
            });

            child.on('error', () => {
                clearTimeout(timer);
                resolve(null);
            });

            child.stdin.on('error', () => {});

            try {
                child.stdin.write(imageBuffer);
                child.stdin.end();
            } catch {
                clearTimeout(timer);
                resolve(null);
            }
        });
    }
}
