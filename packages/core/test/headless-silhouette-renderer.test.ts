/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import { describe, it, expect } from 'vitest';
import { HeadlessMeshSilhouetteRenderer } from '../src/node/spatial/HeadlessMeshSilhouetteRenderer';
import {
    SubPixelEdgeAlignmentOptimizer,
    evaluateEdgeOverlap,
    type CameraPose6DOF
} from '../src/node/spatial/SubPixelEdgeAlignmentOptimizer';

describe('HeadlessMeshSilhouetteRenderer & Closed-Loop Optimizer', () => {
    // Create a 3D building proxy (10m x 20m x 15m) centered at [0, 10, 0]
    const buildingMesh = HeadlessMeshSilhouetteRenderer.createBoxMesh([0, 10, 0], [10, 20, 15]);

    const groundTruthPose: CameraPose6DOF = {
        x: 0,
        y: 10,
        z: -40,
        targetX: 0,
        targetY: 10,
        targetZ: 0,
        fov: 45
    };

    it('renders a 3D mesh into depth and silhouette buffers', () => {
        const render = HeadlessMeshSilhouetteRenderer.renderMesh(buildingMesh, groundTruthPose, 160, 120);

        expect(render.width).toBe(160);
        expect(render.height).toBe(120);

        // Count silhouette pixels
        let foregroundPixels = 0;
        for (let i = 0; i < render.silhouetteBuffer.length; i++) {
            if (render.silhouetteBuffer[i] > 0) {
                foregroundPixels++;
                // Depth must be ~40 meters
                expect(render.depthBuffer[i]).toBeGreaterThan(25.0);
                expect(render.depthBuffer[i]).toBeLessThan(55.0);
            }
        }

        expect(foregroundPixels).toBeGreaterThan(500);
    });

    it('computes edge field and evaluates 100% overlap on identical pose', () => {
        const field1 = HeadlessMeshSilhouetteRenderer.renderEdgeField(buildingMesh, groundTruthPose, 160, 120);
        const field2 = HeadlessMeshSilhouetteRenderer.renderEdgeField(buildingMesh, groundTruthPose, 160, 120);

        expect(field1.meanMagnitude).toBeGreaterThan(0.5);

        const evalResult = evaluateEdgeOverlap(field1, field2);
        expect(evalResult.overlapScorePercent).toBeCloseTo(100.0, 1);
        expect(evalResult.residualPx).toBeLessThan(0.05);
    });

    it('optimizes a perturbed camera pose towards ground-truth in a closed loop', () => {
        // Render target image (ground truth)
        const targetField = HeadlessMeshSilhouetteRenderer.renderEdgeField(buildingMesh, groundTruthPose, 160, 120);

        // Perturbed camera pose (shifted in X, Y, and FOV)
        const perturbedPose: CameraPose6DOF = {
            x: 2.5,
            y: 11.5,
            z: -38.0,
            targetX: 0.5,
            targetY: 9.5,
            targetZ: 0.0,
            fov: 47.0
        };

        const initialField = HeadlessMeshSilhouetteRenderer.renderEdgeField(buildingMesh, perturbedPose, 160, 120);
        const initialEval = evaluateEdgeOverlap(targetField, initialField);

        // Closed-loop optimizer: dynamically renders at each coordinate perturbation
        const optimization = SubPixelEdgeAlignmentOptimizer.optimizePoseTo100Percent(
            perturbedPose,
            targetField,
            (pose) => HeadlessMeshSilhouetteRenderer.renderEdgeField(buildingMesh, pose, 160, 120),
            {
                maxIterations: 15,
                targetOverlapScore: 98.0,
                subpixelTolerancePx: 0.2
            }
        );
        // Verify optimizer significantly improved overlap score
        expect(optimization.overlapScorePercent).toBeGreaterThan(initialEval.overlapScorePercent);
        expect(optimization.subpixelResidualPx).toBeLessThan(initialEval.residualPx);

        // Camera position converged closer to ground truth
        expect(Math.abs(optimization.finalPose.x - groundTruthPose.x)).toBeLessThan(Math.abs(perturbedPose.x - groundTruthPose.x));
    });
});
