/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { CameraPathData, CameraPoseFrame, GeoAnchor } from './Google3DTileBlockoutPipelineService';
import { CameraPose6DOF } from './SubPixelEdgeAlignmentOptimizer';

export interface TrajectoryBoundaryPose {
    timeSec: number;
    position: [number, number, number];
    target: [number, number, number];
    fov: number;
    up?: [number, number, number];
    rollDeg?: number;
}

export interface DynamicTrajectoryOptions {
    fps?: number;
    durationSec?: number;
    totalFrames?: number;
    geoAnchor?: GeoAnchor;
    intermediateKeyframeAnchors?: TrajectoryBoundaryPose[];
    minClearanceMeters?: number;
    tension?: number; // Catmull-Rom tension parameter (default: 0.5)
}

/**
 * Dynamic Multi-Keyframe Temporal Motion Resection & Adaptive Spline Fitting.
 * Replaces hardcoded crane/orbit presets with dynamic motion paths grounded in
 * true boundary resections (Frame 0 upward look, Final Frame nadir look) and
 * smooth C2 continuous Catmull-Rom interpolation.
 */
export class DynamicVideoTrajectorySolver {
    /**
     * Catmull-Rom cubic spline interpolation for 1D value.
     */
    private static catmullRom(p0: number, p1: number, p2: number, p3: number, t: number): number {
        const t2 = t * t;
        const t3 = t2 * t;
        return 0.5 * (
            (2 * p1) +
            (-p0 + p2) * t +
            (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 +
            (-p0 + 3 * p1 - 3 * p2 + p3) * t3
        );
    }

    /**
     * Catmull-Rom interpolation for 3D point.
     */
    public static interpolatePoint(
        p0: [number, number, number],
        p1: [number, number, number],
        p2: [number, number, number],
        p3: [number, number, number],
        t: number
    ): [number, number, number] {
        return [
            this.catmullRom(p0[0], p1[0], p2[0], p3[0], t),
            this.catmullRom(p0[1], p1[1], p2[1], p3[1], t),
            this.catmullRom(p0[2], p1[2], p2[2], p3[2], t)
        ];
    }

    /**
     * Synthesizes a full multi-frame camera path from solved boundary frames (t=0 and t=final)
     * and optional intermediate visual-odometry anchors.
     */
    public static synthesizeTrajectory(
        startPose: TrajectoryBoundaryPose | CameraPose6DOF,
        finalPose: TrajectoryBoundaryPose | CameraPose6DOF,
        options: DynamicTrajectoryOptions = {}
    ): CameraPathData {
        const fps = options.fps ?? 24;
        const durationSec = options.durationSec ?? 15.0;
        const totalFrames = options.totalFrames ?? Math.round(fps * durationSec);

        // Normalize start & final poses
        const start: TrajectoryBoundaryPose = 'x' in startPose ? {
            timeSec: 0.0,
            position: [startPose.x, startPose.y, startPose.z],
            target: [startPose.targetX, startPose.targetY, startPose.targetZ],
            fov: startPose.fov
        } : startPose;

        const end: TrajectoryBoundaryPose = 'x' in finalPose ? {
            timeSec: durationSec,
            position: [finalPose.x, finalPose.y, finalPose.z],
            target: [finalPose.targetX, finalPose.targetY, finalPose.targetZ],
            fov: finalPose.fov
        } : finalPose;

        // Build milestone control points across duration
        const controlPoints: TrajectoryBoundaryPose[] = [];
        controlPoints.push(start);

        if (options.intermediateKeyframeAnchors && options.intermediateKeyframeAnchors.length > 0) {
            controlPoints.push(...options.intermediateKeyframeAnchors);
        } else {
            // Synthesize intermediate smooth kinematic transitions
            // Phase 1 (t=0.25): Descending past upper floors, transition tilt from upward to neutral
            const p1Pos: [number, number, number] = [
                start.position[0] * 0.85 + end.position[0] * 0.15,
                start.position[1] * 0.70 + end.position[1] * 0.30,
                start.position[2] * 0.85 + end.position[2] * 0.15
            ];
            const p1Tgt: [number, number, number] = [
                start.target[0] * 0.75 + end.target[0] * 0.25,
                start.target[1] * 0.65 + end.target[1] * 0.35,
                start.target[2] * 0.75 + end.target[2] * 0.25
            ];
            controlPoints.push({
                timeSec: durationSec * 0.25,
                position: p1Pos,
                target: p1Tgt,
                fov: start.fov * 0.8 + end.fov * 0.2
            });

            // Phase 2 (t=0.60): Canopy/Marquee approach, transitioning tilt to steep downward
            const p2Pos: [number, number, number] = [
                start.position[0] * 0.40 + end.position[0] * 0.60,
                start.position[1] * 0.25 + end.position[1] * 0.75,
                start.position[2] * 0.40 + end.position[2] * 0.60
            ];
            const p2Tgt: [number, number, number] = [
                start.target[0] * 0.30 + end.target[0] * 0.70,
                start.target[1] * 0.20 + end.target[1] * 0.80,
                start.target[2] * 0.30 + end.target[2] * 0.70
            ];
            controlPoints.push({
                timeSec: durationSec * 0.60,
                position: p2Pos,
                target: p2Tgt,
                fov: start.fov * 0.4 + end.fov * 0.6
            });
        }

        controlPoints.push(end);
        controlPoints.sort((a, b) => a.timeSec - b.timeSec);

        // Generate dense per-frame positions using Catmull-Rom spline
        const frames: CameraPoseFrame[] = [];
        const nControls = controlPoints.length;

        for (let frameIdx = 0; frameIdx < totalFrames; frameIdx++) {
            const timeSec = (frameIdx / Math.max(1, totalFrames - 1)) * durationSec;

            // Find enclosing control point segment
            let segIdx = 0;
            while (segIdx < nControls - 2 && controlPoints[segIdx + 1].timeSec <= timeSec) {
                segIdx++;
            }

            const cp1 = controlPoints[segIdx];
            const cp2 = controlPoints[segIdx + 1];
            const cp0 = segIdx > 0 ? controlPoints[segIdx - 1] : cp1;
            const cp3 = segIdx + 2 < nControls ? controlPoints[segIdx + 2] : cp2;

            const segDuration = cp2.timeSec - cp1.timeSec;
            const u = segDuration > 1e-4 ? Math.max(0.0, Math.min(1.0, (timeSec - cp1.timeSec) / segDuration)) : 0.0;

            // Smooth cubic ease parameter
            const easeU = u * u * (3.0 - 2.0 * u);

            const pos = this.interpolatePoint(cp0.position, cp1.position, cp2.position, cp3.position, easeU);
            const tgt = this.interpolatePoint(cp0.target, cp1.target, cp2.target, cp3.target, easeU);
            const fov = cp1.fov + (cp2.fov - cp1.fov) * easeU;

            frames.push({
                frame: frameIdx,
                timeSec: Number(timeSec.toFixed(4)),
                position: [Number(pos[0].toFixed(3)), Number(pos[1].toFixed(3)), Number(pos[2].toFixed(3))],
                target: [Number(tgt[0].toFixed(3)), Number(tgt[1].toFixed(3)), Number(tgt[2].toFixed(3))],
                up: [0, 1, 0],
                fov: Number(fov.toFixed(2)),
                rollDeg: 0.0
            });
        }

        return {
            fps,
            durationSec,
            totalFrames,
            frames,
            origin: options.geoAnchor,
            environment: 'Google Photorealistic 3D Tiles'
        };
    }
}
