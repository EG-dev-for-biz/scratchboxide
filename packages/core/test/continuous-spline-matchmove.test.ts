/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * Unit tests for ContinuousSplineMatchmoveService:
 * Continuous-Time SE(3) Spline Bundle Adjustment with Persistent Video Track Fusion.
 ********************************************************************************/

import { describe, it, expect } from 'vitest';
import {
    ContinuousSplineMatchmoveService,
    SplineKnot,
    PersistentTrack3D2D,
    SplineAnchorConstraint,
    ContinuousSplineSolveOptions
} from '../src/node/spatial/ContinuousSplineMatchmoveService';

describe('ContinuousSplineMatchmoveService', () => {
    const width = 1280;
    const height = 720;
    const fovYDeg = 46.0;

    // Helper to create simple baseline knots for testing
    function createLinearKnots(numKnots: number = 5, durationSec: number = 10.0): SplineKnot[] {
        const knots: SplineKnot[] = [];
        for (let i = 0; i < numKnots; i++) {
            const u = i / (numKnots - 1);
            knots.push({
                timeSec: u * durationSec,
                position: [46.0 - 4.0 * u, 70.0 - 60.0 * u, 5.0 + 18.0 * u],
                target: [30.0 + 12.0 * u, 70.0 - 70.0 * u, 5.0 + 18.0 * u],
                up: [0.0, 1.0, 0.0],
                fovYDeg: 46.0,
                k1: -0.015
            });
        }
        return knots;
    }

    it('evaluates spline at any continuous time with smooth interpolation', () => {
        const knots = createLinearKnots(5, 10.0);
        const service = new ContinuousSplineMatchmoveService();

        // Evaluate at exact knot
        const pose0 = service.evaluateAt(knots, 0.0);
        expect(pose0.position[0]).toBeCloseTo(46.0, 2);
        expect(pose0.position[1]).toBeCloseTo(70.0, 2);
        expect(pose0.position[2]).toBeCloseTo(5.0, 2);

        // Evaluate at midpoint
        const poseMid = service.evaluateAt(knots, 5.0);
        expect(poseMid.position[1]).toBeLessThan(70.0);
        expect(poseMid.position[1]).toBeGreaterThan(10.0);
        expect(poseMid.timeSec).toBe(5.0);

        // Evaluate at end
        const poseEnd = service.evaluateAt(knots, 10.0);
        expect(poseEnd.position[0]).toBeCloseTo(42.0, 2);
        expect(poseEnd.position[1]).toBeCloseTo(10.0, 2);
        expect(poseEnd.position[2]).toBeCloseTo(23.0, 2);
    });

    it('projects 3D world points to 2D image coordinates with Brown-Conrady lens distortion', () => {
        const service = new ContinuousSplineMatchmoveService();
        const cameraPos: [number, number, number] = [0.0, 0.0, 10.0];
        const targetPos: [number, number, number] = [0.0, 0.0, 0.0];
        const upVec: [number, number, number] = [0.0, 1.0, 0.0];

        // Center point projects to principal point (width/2, height/2)
        const centerPoint: [number, number, number] = [0.0, 0.0, 0.0];
        const projCenter = service.projectPoint(
            centerPoint, cameraPos, targetPos, upVec, fovYDeg, 0.0, width, height
        );
        expect(projCenter).not.toBeNull();
        expect(projCenter![0]).toBeCloseTo(width / 2, 1);
        expect(projCenter![1]).toBeCloseTo(height / 2, 1);

        // Barrel distortion pulls corner points closer to center
        const offCenterPoint: [number, number, number] = [3.0, 2.0, 0.0];
        const projRect = service.projectPoint(
            offCenterPoint, cameraPos, targetPos, upVec, fovYDeg, 0.0, width, height
        );
        const projBarrel = service.projectPoint(
            offCenterPoint, cameraPos, targetPos, upVec, fovYDeg, -0.05, width, height
        );
        expect(projRect).not.toBeNull();
        expect(projBarrel).not.toBeNull();
        const distRect = Math.hypot(projRect![0] - width / 2, projRect![1] - height / 2);
        const distBarrel = Math.hypot(projBarrel![0] - width / 2, projBarrel![1] - height / 2);
        expect(distBarrel).toBeLessThan(distRect);
    });

    it('optimizes spline knots to minimize reprojection error across multi-frame persistent tracks', () => {
        const service = new ContinuousSplineMatchmoveService();
        const durationSec = 4.0;
        const fps = 24;
        const totalFrames = 97;

        // Ground-truth knots
        const trueKnots: SplineKnot[] = [
            { timeSec: 0.0, position: [46.0, 65.0, 5.0], target: [32.0, 68.0, 6.0], up: [0, 1, 0], fovYDeg: 46.0, k1: -0.015 },
            { timeSec: 2.0, position: [44.0, 40.0, 14.0], target: [35.0, 42.0, 15.0], up: [0, 1, 0], fovYDeg: 46.0, k1: -0.015 },
            { timeSec: 4.0, position: [42.6, 15.0, 22.0], target: [42.6, 0.0, 22.0], up: [-0.87, 0, -0.48], fovYDeg: 46.0, k1: -0.015 }
        ];

        // Synthesize 3D points on building facade
        const points3D: [number, number, number][] = [
            [32.0, 68.0, 5.0],
            [32.0, 55.0, 8.0],
            [34.0, 45.0, 12.0],
            [36.0, 30.0, 16.0],
            [40.0, 15.0, 20.0],
            [42.0, 5.0, 22.0]
        ];

        // Project 3D points into ground truth frames to create synthetic TAPIR persistent tracks
        const tracks: PersistentTrack3D2D[] = [];
        for (let ptIdx = 0; ptIdx < points3D.length; ptIdx++) {
            const pt = points3D[ptIdx];
            const observations: { frameNumber: number; timeSec: number; pixel2D: [number, number]; confidence: number }[] = [];

            for (let f = 0; f < totalFrames; f += 4) {
                const t = (f / (totalFrames - 1)) * durationSec;
                const pose = service.evaluateAt(trueKnots, t);
                const proj = service.projectPoint(pt, pose.position, pose.target, pose.up, pose.fovYDeg, pose.k1, width, height);
                if (proj && proj[0] >= 0 && proj[0] <= width && proj[1] >= 0 && proj[1] <= height) {
                    observations.push({
                        frameNumber: f,
                        timeSec: t,
                        pixel2D: proj,
                        confidence: 1.0
                    });
                }
            }

            if (observations.length >= 3) {
                tracks.push({
                    trackId: `pt_${ptIdx}`,
                    worldPoint3D: pt,
                    observations
                });
            }
        }

        expect(tracks.length).toBeGreaterThan(2);

        // Perturb the middle knot to simulate tracking drift
        const perturbedKnots: SplineKnot[] = JSON.parse(JSON.stringify(trueKnots));
        perturbedKnots[1].position[0] += 2.5; // +2.5m x error
        perturbedKnots[1].position[1] += 4.0; // +4.0m altitude error
        perturbedKnots[1].position[2] -= 2.0;

        const initialResidual = service.computeTotalReprojectionError(perturbedKnots, tracks, width, height);
        expect(initialResidual.rmsPx).toBeGreaterThan(15.0);

        // Run Continuous Spline Levenberg-Marquardt Bundle Adjustment
        const solveOptions: ContinuousSplineSolveOptions = {
            maxIterations: 30,
            tolerancePx: 0.1,
            kinematicSmoothnessWeight: 1.0,
            huberLossThresholdPx: 4.0
        };

        const result = service.optimizeSplineTrajectory(perturbedKnots, tracks, [], width, height, solveOptions);

        expect(result.success).toBe(true);
        expect(result.finalRmsPx).toBeLessThan(1.5);
        expect(result.finalRmsPx).toBeLessThan(initialResidual.rmsPx * 0.1);

        // Optimized knot should have converged back towards ground truth
        expect(Math.abs(result.optimizedKnots[1].position[0] - trueKnots[1].position[0])).toBeLessThan(0.8);
        expect(Math.abs(result.optimizedKnots[1].position[1] - trueKnots[1].position[1])).toBeLessThan(0.8);
    });

    it('enforces hard anchor constraints at key boundary frames', () => {
        const service = new ContinuousSplineMatchmoveService();
        const knots = createLinearKnots(4, 6.0);

        // Anchor constraint at Frame 1 (t=0) and Final Frame (t=6)
        const anchors: SplineAnchorConstraint[] = [
            {
                timeSec: 0.0,
                position: [46.5, 67.0, 0.4],
                target: [32.0, 72.8, 3.4],
                weight: 100.0 // Strong anchor lock
            },
            {
                timeSec: 6.0,
                position: [42.6, 10.5, 23.5],
                target: [42.6, 0.0, 23.5],
                weight: 100.0
            }
        ];

        const result = service.optimizeSplineTrajectory(knots, [], anchors, width, height, {
            maxIterations: 15,
            kinematicSmoothnessWeight: 5.0
        });

        expect(result.success).toBe(true);
        const startPose = service.evaluateAt(result.optimizedKnots, 0.0);
        const endPose = service.evaluateAt(result.optimizedKnots, 6.0);

        // Anchors should be tightly locked
        expect(Math.hypot(
            startPose.position[0] - 46.5,
            startPose.position[1] - 67.0,
            startPose.position[2] - 0.4
        )).toBeLessThan(0.1);

        expect(Math.hypot(
            endPose.position[0] - 42.6,
            endPose.position[1] - 10.5,
            endPose.position[2] - 23.5
        )).toBeLessThan(0.1);
    });

    it('kinematic regularization enforces monotonic altitude descent without floor hopping', () => {
        const service = new ContinuousSplineMatchmoveService();
        const numKnots = 6;
        const durationSec = 10.0;
        const knots = createLinearKnots(numKnots, durationSec);

        // Artificially create a floor-hopping jitter in knot 2 & 3
        knots[2].position[1] += 8.0; // jumps up 8 meters (approx 2 floors)
        knots[3].position[1] -= 6.0;

        const result = service.optimizeSplineTrajectory(knots, [], [], width, height, {
            maxIterations: 20,
            kinematicSmoothnessWeight: 20.0,
            enforceMonotonicDescent: true
        });

        expect(result.success).toBe(true);

        // Verify sampled dense trajectory is strictly monotonic in descent (altitude decreasing)
        const totalSamples = 50;
        let prevY = service.evaluateAt(result.optimizedKnots, 0.0).position[1];

        for (let i = 1; i <= totalSamples; i++) {
            const t = (i / totalSamples) * durationSec;
            const pose = service.evaluateAt(result.optimizedKnots, t);
            expect(pose.position[1]).toBeLessThanOrEqual(prevY + 0.01); // no upward jumping
            prevY = pose.position[1];
        }
    });

    it('synthesizes dense per-frame trajectory table with full 6-DOF velocity, acceleration, and jerk telemetry', () => {
        const service = new ContinuousSplineMatchmoveService();
        const knots = createLinearKnots(5, 5.0);
        const denseTrajectory = service.synthesizeDenseTrajectory(knots, 24, 5.0);

        expect(denseTrajectory.length).toBe(121); // 5s * 24fps + 1 = 121 frames
        expect(denseTrajectory[0].frame).toBe(1);
        expect(denseTrajectory[120].frame).toBe(121);
        expect(denseTrajectory[0].velocityMps).toBeDefined();
        expect(denseTrajectory[0].accelerationMps2).toBeDefined();
        expect(denseTrajectory[0].jerkMps3).toBeDefined();
        expect(denseTrajectory[0].rotationQuaternion).toHaveLength(4);
        expect(denseTrajectory[60].velocityMps).toBeGreaterThan(0);

        // Boundary velocity at frame 0 should be consistent with forward frame velocity, not artificially halved
        expect(denseTrajectory[0].velocityMps).toBeCloseTo(denseTrajectory[1].velocityMps, 0);
    });

    it('converts bidirectionally to and from CameraSolveTrack protocol', () => {
        const service = new ContinuousSplineMatchmoveService();
        const knots = createLinearKnots(5, 4.0);
        const solveTrack = service.toCameraSolveTrack(knots, 24, 4.0, 'test_solve');

        expect(solveTrack.id).toBe('test_solve');
        expect(solveTrack.coordinateSystem).toBe('threejs');
        expect(solveTrack.fps).toBe(24);
        expect(solveTrack.totalFrames).toBe(97); // 4.0s * 24fps + 1
        expect(solveTrack.frames.length).toBe(97);
        expect(solveTrack.frames[0].position).toHaveLength(3);
        expect(solveTrack.frames[0].rotationQuaternion).toHaveLength(4);
        expect(solveTrack.isSolved).toBe(true);

        // Convert back to knots
        const reconstructedKnots = service.fromCameraSolveTrack(solveTrack, 5);
        expect(reconstructedKnots.length).toBe(5);
        expect(reconstructedKnots[0].timeSec).toBe(0.0);
        expect(reconstructedKnots[4].timeSec).toBeCloseTo(4.0, 2);
        expect(reconstructedKnots[0].position[0]).toBeCloseTo(knots[0].position[0], 1);
        expect(reconstructedKnots[0].position[1]).toBeCloseTo(knots[0].position[1], 1);
    });
});
