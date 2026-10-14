/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import { describe, it, expect } from 'vitest';
import {
    SpatialPoseEstimatorService,
    PNP_MIN_CORRESPONDENCES,
    type Point3D,
    type Point2D,
    type CameraIntrinsics,
    rodriguesToRotationMatrix,
    rotationMatrixToRodrigues,
    orthonormalizeRotation3x3,
    determinant3x3,
    matrixMultiply,
    matrixTranspose
} from '../src/node/spatial/SpatialPoseEstimatorService';

/** Deterministic PRNG (mulberry32) so failures are reproducible. */
function makeRng(seed: number): () => number {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

function gaussian(rng: () => number): number {
    const u = Math.max(rng(), 1e-12);
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng());
}

function randomRotation(rng: () => number): number[][] {
    const axis = [gaussian(rng), gaussian(rng), gaussian(rng)];
    const len = Math.hypot(axis[0], axis[1], axis[2]);
    const angle = rng() * Math.PI * 0.98;
    return rodriguesToRotationMatrix([axis[0] / len * angle, axis[1] / len * angle, axis[2] / len * angle]);
}

/** Geodesic angle between two rotations in degrees. */
function rotationErrorDeg(A: number[][], B: number[][]): number {
    const D = matrixMultiply(A, matrixTranspose(B));
    const c = Math.max(-1, Math.min(1, (D[0][0] + D[1][1] + D[2][2] - 1) / 2));
    return Math.acos(c) * 180 / Math.PI;
}

const intrinsics: CameraIntrinsics = { fx: 1100, fy: 1100, cx: 960, cy: 540, width: 1920, height: 1080 };

interface Scenario {
    R: number[][];
    t: Point3D;
    points3D: Point3D[];
    points2D: Point2D[];
}

/**
 * Builds a random camera pose and n points visible in front of it. Points are sampled in the camera
 * frame (inside the frustum, depth 6-30 m) and mapped to world via X_w = R^T (X_c - t), so the
 * ground-truth projection is guaranteed valid. `planar` places all points on one world plane.
 */
function makeScenario(rng: () => number, n: number, noisePx: number, planar = false): Scenario {
    const R = randomRotation(rng);
    const t: Point3D = [gaussian(rng) * 5, gaussian(rng) * 5, gaussian(rng) * 5];
    const RT = matrixTranspose(R);
    const toWorld = (pc: number[]): Point3D => {
        const d = [pc[0] - t[0], pc[1] - t[1], pc[2] - t[2]];
        return [
            RT[0][0] * d[0] + RT[0][1] * d[1] + RT[0][2] * d[2],
            RT[1][0] * d[0] + RT[1][1] * d[1] + RT[1][2] * d[2],
            RT[2][0] * d[0] + RT[2][1] * d[1] + RT[2][2] * d[2]
        ];
    };

    const points3D: Point3D[] = [];
    const points2D: Point2D[] = [];
    // Plane in camera frame: z = z0 + gx * x + gy * y (tilted, in front of camera)
    const z0 = 12 + rng() * 8;
    const gx = (rng() - 0.5) * 0.8;
    const gy = (rng() - 0.5) * 0.8;
    for (let i = 0; i < n; i++) {
        const u = 100 + rng() * (intrinsics.width! - 200);
        const v = 100 + rng() * (intrinsics.height! - 200);
        const xn = (u - intrinsics.cx) / intrinsics.fx;
        const yn = (v - intrinsics.cy) / intrinsics.fy;
        // Depth along the ray: free for general points, intersect plane for planar scenes
        const z = planar ? z0 / (1 - gx * xn - gy * yn) : 6 + rng() * 24;
        points3D.push(toWorld([xn * z, yn * z, z]));
        points2D.push([u + gaussian(rng) * noisePx, v + gaussian(rng) * noisePx]);
    }
    return { R, t, points3D, points2D };
}

describe('SpatialPoseEstimatorService synthetic accuracy (EPnP / DLT / RANSAC)', () => {
    it('enforces det(R) = +1 on the weakest singular direction, including rank-2 inputs', () => {
        const rng = makeRng(7);
        for (let trial = 0; trial < 50; trial++) {
            const R = randomRotation(rng);
            // Reflected (det -1) and rank-deficient (coplanar Kabsch) inputs
            const reflected = R.map(row => [row[0], row[1], -row[2]]);
            const rank2 = matrixMultiply(R, [[3, 0, 0], [0, 1, 0], [0, 0, 0]]);
            for (const M of [R, reflected, rank2]) {
                const Q = orthonormalizeRotation3x3(M);
                expect(determinant3x3(Q)).toBeCloseTo(1, 9);
                const QtQ = matrixMultiply(matrixTranspose(Q), Q);
                for (let r = 0; r < 3; r++) {
                    for (let c = 0; c < 3; c++) expect(QtQ[r][c]).toBeCloseTo(r === c ? 1 : 0, 9);
                }
            }
            // Rank-2 projection of a proper rotation must give back that rotation
            expect(rotationErrorDeg(orthonormalizeRotation3x3(rank2), R)).toBeLessThan(1e-4);
        }
    });

    it('round-trips Rodrigues vectors near theta = pi', () => {
        const rng = makeRng(11);
        for (let trial = 0; trial < 50; trial++) {
            const axis = [gaussian(rng), gaussian(rng), gaussian(rng)];
            const len = Math.hypot(axis[0], axis[1], axis[2]);
            const theta = Math.PI - rng() * 5e-4;
            const R = rodriguesToRotationMatrix([axis[0] / len * theta, axis[1] / len * theta, axis[2] / len * theta]);
            const R2 = rodriguesToRotationMatrix(rotationMatrixToRodrigues(R));
            expect(rotationErrorDeg(R, R2)).toBeLessThan(1e-3);
        }
    });

    it('rejects fewer than the minimum and collinear correspondences with clear errors', () => {
        const rng = makeRng(3);
        const s = makeScenario(rng, 3, 0);
        expect(() => SpatialPoseEstimatorService.solvePnP(s.points3D, s.points2D, intrinsics))
            .toThrow(`at least ${PNP_MIN_CORRESPONDENCES}`);
        expect(() => SpatialPoseEstimatorService.solvePnPRansac(s.points3D, s.points2D, intrinsics))
            .toThrow(`at least ${PNP_MIN_CORRESPONDENCES}`);

        const collinear3D: Point3D[] = [[0, 0, 10], [1, 1, 11], [2, 2, 12], [3, 3, 13], [4, 4, 14]];
        const collinear2D: Point2D[] = collinear3D.map(([x, y, z]) => [1100 * x / z + 960, 1100 * y / z + 540]);
        expect(() => SpatialPoseEstimatorService.solvePnP(collinear3D, collinear2D, intrinsics)).toThrow(/collinear/);
    });

    it('recovers exact poses from minimal (4, 5) and over-determined non-coplanar sets', () => {
        const rng = makeRng(42);
        let worstRotDeg = 0;
        let worstTransRel = 0;
        for (const n of [4, 5, 6, 8, 12, 20]) {
            for (let trial = 0; trial < 25; trial++) {
                const s = makeScenario(rng, n, 0);
                const pose = SpatialPoseEstimatorService.solvePnP(s.points3D, s.points2D, intrinsics);
                // With 4-5 points P(n)P can have several exact solutions; require an exact reprojection
                // and, for n >= 6 (unique solution), the ground-truth pose itself.
                expect(pose.meanReprojectionErrorPx).toBeLessThan(1e-3);
                expect(determinant3x3(pose.rotationMatrix)).toBeCloseTo(1, 9);
                if (n >= 6) {
                    const rotErr = rotationErrorDeg(pose.rotationMatrix, s.R);
                    const transErr = Math.hypot(
                        pose.translationCamera[0] - s.t[0],
                        pose.translationCamera[1] - s.t[1],
                        pose.translationCamera[2] - s.t[2]
                    ) / Math.hypot(s.t[0], s.t[1], s.t[2]);
                    worstRotDeg = Math.max(worstRotDeg, rotErr);
                    worstTransRel = Math.max(worstTransRel, transErr);
                }
            }
        }
        expect(worstRotDeg).toBeLessThan(1e-4);
        expect(worstTransRel).toBeLessThan(1e-5);
    });

    it('recovers exact poses from coplanar point sets (4 and 10 points)', () => {
        const rng = makeRng(99);
        for (const n of [4, 10]) {
            for (let trial = 0; trial < 25; trial++) {
                const s = makeScenario(rng, n, 0, true);
                const pose = SpatialPoseEstimatorService.solvePnP(s.points3D, s.points2D, intrinsics);
                expect(pose.meanReprojectionErrorPx).toBeLessThan(1e-3);
                if (n >= 10) {
                    expect(rotationErrorDeg(pose.rotationMatrix, s.R)).toBeLessThan(1e-4);
                }
            }
        }
    });

    it('stays accurate under 0.5 px Gaussian noise and excludes gross outliers via RANSAC', () => {
        const rng = makeRng(2026);
        let worstRotDeg = 0;
        let worstTransRel = 0;
        for (const n of [6, 10, 14, 20]) {
            for (let trial = 0; trial < 10; trial++) {
                const s = makeScenario(rng, n, 0.5);
                const outliers = new Set<number>();
                const nOut = Math.floor(n * 0.25);
                while (outliers.size < nOut) outliers.add(Math.floor(rng() * n));
                const corrupted2D = s.points2D.map((p, i) =>
                    outliers.has(i)
                        ? [p[0] + (rng() < 0.5 ? -1 : 1) * (60 + rng() * 200), p[1] + (rng() < 0.5 ? -1 : 1) * (60 + rng() * 200)] as Point2D
                        : p
                );

                const result = SpatialPoseEstimatorService.solvePnPRansac(s.points3D, corrupted2D, intrinsics, {
                    inlierThresholdPx: 3.0,
                    maxRansacIterations: 300
                });

                expect(result.consensus).toBe(true);
                for (const o of outliers) expect(result.inlierIndices).not.toContain(o);
                expect(result.inlierCount).toBeGreaterThanOrEqual(n - nOut - 1);
                expect(result.inlierRatio).toBeCloseTo(result.inlierCount / n, 12);

                worstRotDeg = Math.max(worstRotDeg, rotationErrorDeg(result.pose.rotationMatrix, s.R));
                worstTransRel = Math.max(worstTransRel, Math.hypot(
                    result.pose.translationCamera[0] - s.t[0],
                    result.pose.translationCamera[1] - s.t[1],
                    result.pose.translationCamera[2] - s.t[2]
                ) / Math.hypot(s.t[0], s.t[1], s.t[2]));
            }
        }
        // eslint-disable-next-line no-console
        console.log(`[pnp-synthetic] noisy RANSAC worst rotation error ${worstRotDeg.toFixed(4)} deg, worst relative translation error ${(worstTransRel * 100).toFixed(3)}%`);
        expect(worstRotDeg).toBeLessThan(1.0);
        expect(worstTransRel).toBeLessThan(0.05);
    });

    it('reports consensus: false with honestly measured inliers when no hypothesis is supported', () => {
        const rng = makeRng(5);
        const s = makeScenario(rng, 12, 0);
        // Shuffle 2D observations so correspondences are meaningless
        const scrambled2D = s.points2D.map(() => [rng() * 1920, rng() * 1080] as Point2D);
        const result = SpatialPoseEstimatorService.solvePnPRansac(s.points3D, scrambled2D, intrinsics, {
            inlierThresholdPx: 0.5,
            maxRansacIterations: 60
        });
        expect(result.consensus).toBe(false);
        expect(result.inlierCount).toBeLessThan(PNP_MIN_CORRESPONDENCES);
        expect(result.inlierCount).toBe(result.inlierIndices.length);
        expect(result.inlierRatio).toBeLessThan(1.0);
        for (const i of result.inlierIndices) {
            expect(result.pose.reprojectionErrorsPx[i]).toBeLessThanOrEqual(0.5 + 1e-9);
        }
    });
});
