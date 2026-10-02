/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import { describe, it, expect } from 'vitest';
import * as path from 'path';
import * as fs from 'fs-extra';
import {
    AdaptiveSurveyRigService,
    type AdaptiveSurveyRigOptions
} from '../src/node/spatial/AdaptiveSurveyRigService';
import { HeadlessMeshSilhouetteRenderer } from '../src/node/spatial/HeadlessMeshSilhouetteRenderer';
import { OrientedBoundingBoxSolver } from '../src/node/spatial/OrientedBoundingBoxSolver';

describe('AdaptiveSurveyRigService: Scene-Conformal Survey Rig Synthesis', () => {
    it('plans an adaptive rig for a synthetic rectangular structure', () => {
        // Create synthetic box: 40m x 20m x 30m sitting on ground at Y = 10m
        // Vertices: [x, y, z]
        const verts: number[] = [
            -20, 10, -15,  20, 10, -15,  20, 30, -15, -20, 30, -15, // front
            -20, 10,  15,  20, 10,  15,  20, 30,  15, -20, 30,  15  // back
        ];
        const indices = [
            0, 1, 2, 0, 2, 3,
            4, 5, 6, 4, 6, 7,
            0, 4, 7, 0, 7, 3,
            1, 5, 6, 1, 6, 2,
            3, 2, 6, 3, 6, 7,
            0, 1, 5, 0, 5, 4
        ];
        const mesh = {
            vertices: new Float32Array(verts),
            indices: new Uint32Array(indices)
        };

        const result = AdaptiveSurveyRigService.planRig(mesh, {
            cameraBudget: 12,
            mode: 'facade-perimeter',
            focalLengthMm: 35
        });

        expect(result.poses).toHaveLength(12);
        expect(result.stats.stationCount).toBe(12);
        expect(result.groundDatumY).toBeCloseTo(10.0, 0);

        // Invariant 1: Zero underground cameras
        for (const pose of result.poses) {
            expect(pose.positionLocalENU[1]).toBeGreaterThanOrEqual(10.0 + 1.8);
            expect(pose.cameraHeightAboveGround).toBeGreaterThanOrEqual(1.8);
            expect((pose as any).maxDepth).toBeLessThan(150.0);
            expect((pose as any).dropSky).toBe(true);
        }
    });

    it('plans a high-precision adaptive rig for real-world Colosseum GLB', () => {
        const glbPath = path.resolve(process.cwd(), 'public/models/colosseum_grounded.glb');
        if (!fs.existsSync(glbPath)) {
            console.warn('Skipping Colosseum test: GLB not found');
            return;
        }

        const result = AdaptiveSurveyRigService.planRig(glbPath, {
            cameraBudget: 40,
            mode: 'multitier-complete',
            focalLengthMm: 35,
            targetResolutionMm: 2.5
        });

        expect(result.poses).toHaveLength(40);
        // Ground datum must be at ~33.4m (not 0.0m!)
        expect(result.groundDatumY).toBeGreaterThan(25.0);
        expect(result.groundDatumY).toBeLessThan(40.0);

        console.log('COLOSSEUM STATS:', JSON.stringify({
            centroid: result.stats.structureCentroid,
            dimensions: result.stats.structureDimensions,
            groundDatumY: result.groundDatumY,
            aabb: result.aabb,
            obb: result.obb
        }, null, 2));

        // Let's inspect the distribution of vertices in the GLB
        const m = HeadlessMeshSilhouetteRenderer.loadMeshFromGlb(glbPath);
        const v = m.vertices;
        let elevXMin = Infinity, elevXMax = -Infinity;
        let elevZMin = Infinity, elevZMax = -Infinity;
        let elevCount = 0;
        for (let i = 0; i < v.length; i += 3) {
            const vy = v[i + 1];
            if (vy > result.groundDatumY + 5.0) {
                elevCount++;
                const vx = v[i];
                const vz = v[i + 2];
                if (vx < elevXMin) elevXMin = vx;
                if (vx > elevXMax) elevXMax = vx;
                if (vz < elevZMin) elevZMin = vz;
                if (vz > elevZMax) elevZMax = vz;
            }
        }
        console.log('STRUCTURE ELEVATED VERTICES (> ground + 5m):', {
            elevCount,
            elevXSpan: [elevXMin, elevXMax, elevXMax - elevXMin],
            elevZSpan: [elevZMin, elevZMax, elevZMax - elevZMin],
            center: [(elevXMin + elevXMax) / 2, (elevZMin + elevZMax) / 2]
        });

        expect(result.stats.structureCentroid[0]).toBeLessThan(0.0);
        expect(result.stats.structureCentroid[2]).toBeGreaterThan(0.0);

        // Invariant: ZERO underground cameras across all 40 stations
        for (const pose of result.poses) {
            const eyeY = pose.positionLocalENU[1];
            expect(eyeY).toBeGreaterThanOrEqual(result.groundDatumY + 1.8);
            expect(pose.cameraHeightAboveGround).toBeGreaterThanOrEqual(1.8);

            // Forward vector must point towards the structure
            const fwd = pose.forwardVector;
            expect(Math.hypot(fwd[0], fwd[1], fwd[2])).toBeCloseTo(1.0, 3);

            // Strict depth bound
            expect((pose as any).maxDepth).toBeLessThanOrEqual(120.0);
        }

        // Tiers must cover street, mid, attic, and overview
        expect(result.tiers.length).toBeGreaterThanOrEqual(3);
    });

    it('plans an adaptive rig with focusCentroid and cropRadius isolating target landmark', () => {
        const glbPath = path.resolve(process.cwd(), 'public/models/colosseum_grounded.glb');
        if (!fs.existsSync(glbPath)) return;

        const result = AdaptiveSurveyRigService.planRig(glbPath, {
            cameraBudget: 40,
            mode: 'multitier-complete',
            focusCentroid: [-43.42, 24.0, 62.54],
            cropRadius: 110.0,
            targetResolutionMm: 2.5
        });

        expect(result.poses).toHaveLength(40);
        // OBB must tightly enclose the Colosseum structure (~216m), not the entire 750m tile chunk
        expect(result.obb.dimensions[0]).toBeGreaterThan(150.0);
        expect(result.obb.dimensions[0]).toBeLessThan(260.0);
        expect(result.obb.dimensions[2]).toBeGreaterThan(150.0);
        expect(result.obb.dimensions[2]).toBeLessThan(260.0);

        // Ground datum must be plausible
        expect(result.groundDatumY).toBeGreaterThan(20.0);
        expect(result.groundDatumY).toBeLessThan(36.0);

        // Zero underground cameras
        for (const pose of result.poses) {
            expect(pose.positionLocalENU[1]).toBeGreaterThanOrEqual(result.groundDatumY + 1.8);
            expect(pose.cameraHeightAboveGround).toBeGreaterThanOrEqual(1.8);
            expect((pose as any).dropSky).toBe(true);
        }
    });
});
