/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import { CameraPathData } from './Google3DTileBlockoutPipelineService';
import { CameraPose6DOF } from './SubPixelEdgeAlignmentOptimizer';
import {
    ContinuousSplineMatchmoveService,
    TrajectoryBoundaryPose,
    DynamicTrajectoryOptions
} from './ContinuousSplineMatchmoveService';

export type { TrajectoryBoundaryPose, DynamicTrajectoryOptions };

/**
 * Dynamic Multi-Keyframe Temporal Motion Resection & Adaptive Spline Fitting.
 * Backwards-compatible facade forwarding to ContinuousSplineMatchmoveService.
 */
export class DynamicVideoTrajectorySolver {
    /**
     * Catmull-Rom cubic spline interpolation for 1D value.
     */
    public static catmullRom(p0: number, p1: number, p2: number, p3: number, t: number): number {
        return ContinuousSplineMatchmoveService.catmullRomScalar(p0, p1, p2, p3, t);
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
        return ContinuousSplineMatchmoveService.interpolatePoint(p0, p1, p2, p3, t);
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
        return ContinuousSplineMatchmoveService.synthesizeTrajectory(startPose, finalPose, options);
    }
}
