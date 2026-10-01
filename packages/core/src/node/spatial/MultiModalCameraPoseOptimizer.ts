/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import { CameraPose6DOF, SobelEdgeField, evaluateEdgeOverlap } from './SubPixelEdgeAlignmentOptimizer';
import { VanishingPointResult } from './VanishingPointHorizonEstimator';
import { ViewingQuadrantBounds } from './LandmarkBearingGatedMatcher';

export interface MultiLossWeights {
    wEdge?: number;    // default: 1.0
    wVp?: number;      // default: 2.5 (vanishing point pitch constraint)
    wNormal?: number;  // default: 5.0 (surface normal / roof occlusion penalty)
    wAltitude?: number;// default: 2.0 (altitude bounding constraint)
}

export interface MultiModalOptimizationMetrics {
    bestPose: CameraPose6DOF;
    totalLoss: number;
    edgeOverlapPercent: number;
    pitchDeg: number;
    pitchResidualDeg: number;
    normalPenalty: number;
    altitudePenalty: number;
    evaluatedHypotheses: number;
    converged: boolean;
}

/**
 * Multi-Loss Regularized 3D-to-2D Camera Pose Optimizer.
 * Evaluates edge correlation, vanishing point attitude constraints, surface normal visibility,
 * and eye-level altitude bounds across multi-hypothesis spherical candidate basins.
 */
export class MultiModalCameraPoseOptimizer {
    /**
     * Evaluates the multi-objective loss function for a given candidate camera pose.
     */
    public static computePoseLoss(
        pose: CameraPose6DOF,
        queryField: SobelEdgeField,
        renderFunc: (pose: CameraPose6DOF) => SobelEdgeField,
        vpResult?: VanishingPointResult,
        quadrantBounds?: ViewingQuadrantBounds,
        weights: MultiLossWeights = {}
    ): {
        totalLoss: number;
        edgeLoss: number;
        vpLoss: number;
        normalLoss: number;
        altLoss: number;
        overlapPercent: number;
        computedPitchDeg: number;
    } {
        const wEdge = weights.wEdge ?? 1.0;
        const wVp = weights.wVp ?? 2.5;
        const wNormal = weights.wNormal ?? 5.0;
        const wAlt = weights.wAltitude ?? 2.0;

        // 1. Edge Overlap Loss
        const renderedField = renderFunc(pose);
        const edgeEval = evaluateEdgeOverlap(queryField, renderedField);
        const overlapPercent = edgeEval.overlapScorePercent;
        const edgeLoss = Math.max(0.0, (100.0 - overlapPercent) / 100.0);

        // 2. Vanishing Point Pitch Loss
        // Optical pitch from camera position and target
        const dx = pose.targetX - pose.x;
        const dy = pose.targetY - pose.y;
        const dz = pose.targetZ - pose.z;
        const horizontalDist = Math.hypot(dx, dz);
        const computedPitchDeg = Math.atan2(dy, Math.max(0.1, horizontalDist)) * (180.0 / Math.PI);

        let vpLoss = 0.0;
        let normalLoss = 0.0;

        if (vpResult) {
            const expectedPitchDeg = vpResult.pitchDeg;
            const pitchDelta = Math.abs(computedPitchDeg - expectedPitchDeg);
            vpLoss = (pitchDelta / 15.0) * (pitchDelta / 15.0);

            // 3. Surface Normal & Upward-Looking Occlusion Penalty
            // If the plate is looking UPWARD (pitch > 0), camera MUST be lower than target (dy > 0).
            // A camera with y > targetY or dy <= 0 exposes flat roof tops and mechanical HVAC units!
            if (vpResult.classification === 'looking-upward') {
                if (dy <= 0.0) {
                    // Massive penalty for looking down when ground truth is looking up!
                    normalLoss += 10.0 + Math.abs(dy);
                }
            } else if (vpResult.classification === 'looking-downward') {
                if (dy >= 0.0) {
                    normalLoss += 10.0 + Math.abs(dy);
                }
            }
        }

        // 4. Altitude Bounding Loss
        let altLoss = 0.0;
        if (quadrantBounds) {
            const bounds = quadrantBounds.cameraPositionBounds;
            if (pose.y < bounds.minY) {
                altLoss += (bounds.minY - pose.y) / 10.0;
            } else if (pose.y > bounds.maxY) {
                altLoss += (pose.y - bounds.maxY) / 10.0;
            }

            if (pose.x < bounds.minX) {
                altLoss += (bounds.minX - pose.x) / 10.0;
            } else if (pose.x > bounds.maxX) {
                altLoss += (pose.x - bounds.maxX) / 10.0;
            }
        }

        const totalLoss = (wEdge * edgeLoss) + (wVp * vpLoss) + (wNormal * normalLoss) + (wAlt * altLoss);

        return {
            totalLoss,
            edgeLoss,
            vpLoss,
            normalLoss,
            altLoss,
            overlapPercent,
            computedPitchDeg
        };
    }

    /**
     * Executes multi-hypothesis global search across the valid quadrant bounds,
     * followed by local Levenberg-Marquardt / coordinate refinement.
     */
    public static optimizeGlobalPose(
        queryField: SobelEdgeField,
        renderFunc: (pose: CameraPose6DOF) => SobelEdgeField,
        vpResult: VanishingPointResult,
        quadrantBounds: ViewingQuadrantBounds,
        options: {
            gridStepsX?: number;
            gridStepsY?: number;
            gridStepsZ?: number;
            refinementIters?: number;
            weights?: MultiLossWeights;
        } = {}
    ): MultiModalOptimizationMetrics {
        const bounds = quadrantBounds.cameraPositionBounds;
        const tgt = quadrantBounds.preferredTarget;

        const stepsX = options.gridStepsX ?? 4;
        const stepsY = options.gridStepsY ?? 4;
        const stepsZ = options.gridStepsZ ?? 3;
        const refIters = options.refinementIters ?? 15;
        const weights = options.weights ?? {};

        const stepX = (bounds.maxX - bounds.minX) / Math.max(1, stepsX - 1);
        const stepY = (bounds.maxY - bounds.minY) / Math.max(1, stepsY - 1);
        const stepZ = (bounds.maxZ - bounds.minZ) / Math.max(1, stepsZ - 1);

        let bestLoss = Infinity;
        let bestPose: CameraPose6DOF = {
            x: bounds.minX,
            y: bounds.minY,
            z: bounds.minZ,
            targetX: tgt[0],
            targetY: tgt[1],
            targetZ: tgt[2],
            fov: 40.0
        };
        let bestOverlap = 0.0;
        let bestPitch = 0.0;
        let bestNormalLoss = 0.0;
        let bestAltLoss = 0.0;
        let totalEvaluations = 0;

        // 1. Multi-Hypothesis Grid Search
        for (let ix = 0; ix < stepsX; ix++) {
            const x = bounds.minX + ix * stepX;
            for (let iy = 0; iy < stepsY; iy++) {
                const y = bounds.minY + iy * stepY;
                for (let iz = 0; iz < stepsZ; iz++) {
                    const z = bounds.minZ + iz * stepZ;
                    totalEvaluations++;

                    const candidatePose: CameraPose6DOF = {
                        x,
                        y,
                        z,
                        targetX: tgt[0],
                        targetY: tgt[1],
                        targetZ: tgt[2],
                        fov: 40.0
                    };

                    const evalRes = this.computePoseLoss(
                        candidatePose,
                        queryField,
                        renderFunc,
                        vpResult,
                        quadrantBounds,
                        weights
                    );

                    if (evalRes.totalLoss < bestLoss) {
                        bestLoss = evalRes.totalLoss;
                        bestPose = { ...candidatePose };
                        bestOverlap = evalRes.overlapPercent;
                        bestPitch = evalRes.computedPitchDeg;
                        bestNormalLoss = evalRes.normalLoss;
                        bestAltLoss = evalRes.altLoss;
                    }
                }
            }
        }

        // 2. Coordinate Local Refinement around Best Basin
        let refinedPose = { ...bestPose };
        let currentStepPos = Math.max(0.5, stepX * 0.25);
        let currentStepFov = 1.0;

        for (let iter = 0; iter < refIters; iter++) {
            let improved = false;
            const deltas: [number, number, number][] = [
                [currentStepPos, 0, 0], [-currentStepPos, 0, 0],
                [0, currentStepPos, 0], [0, -currentStepPos, 0],
                [0, 0, currentStepPos], [0, 0, -currentStepPos]
            ];

            for (const [dx, dy, dz] of deltas) {
                const testPose: CameraPose6DOF = {
                    ...refinedPose,
                    x: refinedPose.x + dx,
                    y: refinedPose.y + dy,
                    z: refinedPose.z + dz
                };

                const testRes = this.computePoseLoss(
                    testPose,
                    queryField,
                    renderFunc,
                    vpResult,
                    quadrantBounds,
                    weights
                );

                if (testRes.totalLoss < bestLoss) {
                    bestLoss = testRes.totalLoss;
                    refinedPose = { ...testPose };
                    bestOverlap = testRes.overlapPercent;
                    bestPitch = testRes.computedPitchDeg;
                    bestNormalLoss = testRes.normalLoss;
                    bestAltLoss = testRes.altLoss;
                    improved = true;
                }
            }

            // Test FOV tuning
            for (const dfov of [currentStepFov, -currentStepFov]) {
                const testPose: CameraPose6DOF = {
                    ...refinedPose,
                    fov: refinedPose.fov + dfov
                };
                const testRes = this.computePoseLoss(
                    testPose,
                    queryField,
                    renderFunc,
                    vpResult,
                    quadrantBounds,
                    weights
                );
                if (testRes.totalLoss < bestLoss) {
                    bestLoss = testRes.totalLoss;
                    refinedPose = { ...testPose };
                    bestOverlap = testRes.overlapPercent;
                    bestPitch = testRes.computedPitchDeg;
                    bestNormalLoss = testRes.normalLoss;
                    bestAltLoss = testRes.altLoss;
                    improved = true;
                }
            }

            if (!improved) {
                currentStepPos *= 0.5;
                currentStepFov *= 0.5;
                if (currentStepPos < 0.05) break;
            }
        }

        const expectedPitch = vpResult?.pitchDeg ?? 0.0;
        const pitchResidual = Math.abs(bestPitch - expectedPitch);

        return {
            bestPose: refinedPose,
            totalLoss: Number(bestLoss.toFixed(4)),
            edgeOverlapPercent: Number(bestOverlap.toFixed(2)),
            pitchDeg: Number(bestPitch.toFixed(2)),
            pitchResidualDeg: Number(pitchResidual.toFixed(2)),
            normalPenalty: Number(bestNormalLoss.toFixed(4)),
            altitudePenalty: Number(bestAltLoss.toFixed(4)),
            evaluatedHypotheses: totalEvaluations,
            converged: bestLoss < 0.25 && bestNormalLoss === 0.0
        };
    }
}
