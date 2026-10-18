/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import { describe, it, expect, vi } from 'vitest';
import {
    SpatialPoseEstimatorService,
    type Point3D,
    type Point2D,
    type CameraIntrinsics,
    rodriguesToRotationMatrix,
    svdJacobi,
    orthonormalizeRotation3x3
} from '../src/node/spatial/SpatialPoseEstimatorService';

describe('SpatialPoseEstimatorService (solvePnP & solvePnPRansac)', () => {
    it('accurately computes SVD and recovers orthonormal rotation via Procrustes', () => {
        // Known orthogonal rotation matrix
        const angle = Math.PI / 4;
        const R_exact = [
            [Math.cos(angle), -Math.sin(angle), 0],
            [Math.sin(angle), Math.cos(angle), 0],
            [0, 0, 1]
        ];

        // Add small perturbation
        const R_noisy = R_exact.map(row => row.map(v => v + 0.05));
        const R_recovered = orthonormalizeRotation3x3(R_noisy);

        // Check determinant = 1
        const det =
            R_recovered[0][0] * (R_recovered[1][1] * R_recovered[2][2] - R_recovered[1][2] * R_recovered[2][1]) -
            R_recovered[0][1] * (R_recovered[1][0] * R_recovered[2][2] - R_recovered[1][2] * R_recovered[2][0]) +
            R_recovered[0][2] * (R_recovered[1][0] * R_recovered[2][1] - R_recovered[1][1] * R_recovered[2][0]);

        expect(det).toBeCloseTo(1.0, 5);
    });

    it('solves exact 6-DOF camera pose from 8 known 3D-to-2D correspondences', () => {
        const intrinsics: CameraIntrinsics = {
            fx: 800,
            fy: 800,
            cx: 640,
            cy: 360,
            width: 1280,
            height: 720
        };

        // Ground-truth camera pose
        // Camera at [10, 15, -25] looking towards origin
        const groundTruthW: [number, number, number] = [0.15, -0.22, 0.05];
        const R_gt = rodriguesToRotationMatrix(groundTruthW);
        const t_gt: Point3D = [2.5, -1.8, 30.0];

        // 8 3D points forming a building / cube proxy
        const points3D: Point3D[] = [
            [-5, 0, -5],
            [5, 0, -5],
            [5, 10, -5],
            [-5, 10, -5],
            [-5, 0, 5],
            [5, 0, 5],
            [5, 10, 5],
            [-5, 10, 5]
        ];

        // Project into 2D camera coordinates
        const points2D: Point2D[] = points3D.map(([X, Y, Z]) => {
            const xc = R_gt[0][0] * X + R_gt[0][1] * Y + R_gt[0][2] * Z + t_gt[0];
            const yc = R_gt[1][0] * X + R_gt[1][1] * Y + R_gt[1][2] * Z + t_gt[1];
            const zc = R_gt[2][0] * X + R_gt[2][1] * Y + R_gt[2][2] * Z + t_gt[2];

            const u = intrinsics.fx * (xc / zc) + intrinsics.cx;
            const v = intrinsics.fy * (yc / zc) + intrinsics.cy;
            return [u, v];
        });

        // Solve PnP
        const solved = SpatialPoseEstimatorService.solvePnP(points3D, points2D, intrinsics);

        // Verify sub-pixel reprojection error
        expect(solved.converged).toBe(true);
        expect(solved.meanReprojectionErrorPx).toBeLessThan(0.01);
        expect(solved.maxReprojectionErrorPx).toBeLessThan(0.02);

        // Verify recovered translation matches ground truth
        expect(solved.translationCamera[0]).toBeCloseTo(t_gt[0], 2);
        expect(solved.translationCamera[1]).toBeCloseTo(t_gt[1], 2);
        expect(solved.translationCamera[2]).toBeCloseTo(t_gt[2], 2);

        // Verify rotation matches
        for (let r = 0; r < 3; r++) {
            for (let c = 0; c < 3; c++) {
                expect(solved.rotationMatrix[r][c]).toBeCloseTo(R_gt[r][c], 2);
            }
        }
    });

    it('rejects outlier correspondences using solvePnPRansac', () => {
        const intrinsics: CameraIntrinsics = {
            fx: 1000,
            fy: 1000,
            cx: 500,
            cy: 500,
            width: 1000,
            height: 1000
        };

        const groundTruthW: [number, number, number] = [0.1, 0.2, 0.0];
        const R_gt = rodriguesToRotationMatrix(groundTruthW);
        const t_gt: Point3D = [0.0, 0.0, 20.0];

        // 12 3D points
        const points3D: Point3D[] = [];
        const points2D: Point2D[] = [];

        for (let i = 0; i < 12; i++) {
            const x = (i % 4 - 1.5) * 4;
            const y = (Math.floor(i / 4) - 1.0) * 4;
            const z = (i % 2) * 3;
            points3D.push([x, y, z]);

            const xc = R_gt[0][0] * x + R_gt[0][1] * y + R_gt[0][2] * z + t_gt[0];
            const yc = R_gt[1][0] * x + R_gt[1][1] * y + R_gt[1][2] * z + t_gt[1];
            const zc = R_gt[2][0] * x + R_gt[2][1] * y + R_gt[2][2] * z + t_gt[2];

            let u = intrinsics.fx * (xc / zc) + intrinsics.cx;
            let v = intrinsics.fy * (yc / zc) + intrinsics.cy;

            // Corrupt 3 out of 12 points (25% outliers)
            if (i === 2 || i === 7 || i === 10) {
                u += 150.0;
                v -= 120.0;
            }

            points2D.push([u, v]);
        }

        const ransacResult = SpatialPoseEstimatorService.solvePnPRansac(points3D, points2D, intrinsics, {
            inlierThresholdPx: 2.0,
            maxRansacIterations: 100
        });

        // Outliers (indices 2, 7, 10) should be excluded
        expect(ransacResult.inlierIndices).not.toContain(2);
        expect(ransacResult.inlierIndices).not.toContain(7);
        expect(ransacResult.inlierIndices).not.toContain(10);
        expect(ransacResult.inlierCount).toBe(9);
        expect(ransacResult.pose.meanReprojectionErrorPx).toBeLessThan(0.05);

        // Translation recovered accurately
        expect(ransacResult.pose.translationCamera[2]).toBeCloseTo(t_gt[2], 2);
    });

    it('RANSAC draws are seeded (same input, same pose; no Math.random) and only the winning hypothesis is refined', () => {
        let seed = 9;
        const rnd = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32);
        const intrinsics: CameraIntrinsics = { fx: 1400, fy: 1400, cx: 960, cy: 540, width: 1920, height: 1080 };
        const R = rodriguesToRotationMatrix([0.12, -0.3, 0.05]);
        const t: Point3D = [0.4, -0.2, 12];
        const p3: Point3D[] = [], p2: Point2D[] = [];
        for (let i = 0; i < 240; i++) {
            const X: Point3D = [(rnd() - 0.5) * 8, (rnd() - 0.5) * 6, (rnd() - 0.5) * 4];
            const xc = R[0][0] * X[0] + R[0][1] * X[1] + R[0][2] * X[2] + t[0];
            const yc = R[1][0] * X[0] + R[1][1] * X[1] + R[1][2] * X[2] + t[1];
            const zc = R[2][0] * X[0] + R[2][1] * X[1] + R[2][2] * X[2] + t[2];
            const outlier = i % 5 < 2; // 40% outliers
            p3.push(X);
            p2.push(outlier ? [rnd() * 1920, rnd() * 1080] : [1400 * xc / zc + 960 + (rnd() - 0.5) * 0.5, 1400 * yc / zc + 540 + (rnd() - 0.5) * 0.5]);
        }
        const random = vi.spyOn(Math, 'random');
        const refine = vi.spyOn(SpatialPoseEstimatorService as any, 'refineWithLevenbergMarquardt');
        const a = SpatialPoseEstimatorService.solvePnPRansac(p3, p2, intrinsics, { inlierThresholdPx: 2 });
        const refinesPerSolve = refine.mock.calls.length;
        const b = SpatialPoseEstimatorService.solvePnPRansac(p3, p2, intrinsics, { inlierThresholdPx: 2 });
        expect(random).not.toHaveBeenCalled();
        expect(refinesPerSolve).toBeLessThanOrEqual(1);
        random.mockRestore();
        refine.mockRestore();
        expect(b.pose.translationCamera).toEqual(a.pose.translationCamera);
        expect(b.inlierIndices).toEqual(a.inlierIndices);
        expect(a.consensus).toBe(true);
        expect(a.inlierCount).toBeGreaterThanOrEqual(140);
        for (let k = 0; k < 3; k++) expect(a.pose.translationCamera[k]).toBeCloseTo(t[k], 1);
        for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) expect(a.pose.rotationMatrix[r][c]).toBeCloseTo(R[r][c], 2);
        const other = SpatialPoseEstimatorService.solvePnPRansac(p3, p2, intrinsics, { inlierThresholdPx: 2, seed: 77 });
        for (let k = 0; k < 3; k++) expect(other.pose.translationCamera[k]).toBeCloseTo(t[k], 1);
    });
});
