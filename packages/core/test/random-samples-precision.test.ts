/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import {
    SpatialPoseEstimatorService,
    type CameraIntrinsics,
    type Point3D,
    type Point2D
} from '../src/node/spatial/SpatialPoseEstimatorService';

interface RandomSampleMeta {
    id: string;
    name: string;
    domain: string;
    description: string;
    camera_gt_lat: number;
    camera_gt_lng: number;
    camera_gt_alt_m: number;
    camera_gt_heading_deg: number;
    camera_gt_pitch_deg: number;
    standoff_m: number;
    focal_length_mm: number;
    fov_deg: number;
    filename: string;
    key_structural_features: string[];
}

describe('Random Real-World Non-Landmark Precision Resectioning', () => {
    const manifestPath = path.resolve(__dirname, '../../../public/test_images/random_samples/random_samples_manifest.json');
    const samplesDir = path.resolve(__dirname, '../../../public/test_images/random_samples');

    it('verifies manifest exists and contains 5 distinct non-landmark everyday environments', () => {
        expect(fs.existsSync(manifestPath)).toBe(true);
        const manifest: RandomSampleMeta[] = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

        expect(manifest.length).toBe(5);

        const expectedDomains = [
            'SuburbanResidential',
            'UrbanEverydayCorner',
            'IndustrialLogistics',
            'SuburbanCommercial',
            'CivilInfrastructure'
        ];

        const manifestDomains = manifest.map(s => s.domain);
        expect(manifestDomains).toEqual(expectedDomains);

        for (const sample of manifest) {
            const photoPath = path.join(samplesDir, sample.filename);
            const tilesPath = path.join(samplesDir, sample.filename.replace('.png', '_3dtiles.png'));

            expect(fs.existsSync(photoPath)).toBe(true);
            expect(fs.existsSync(tilesPath)).toBe(true);
            expect(fs.statSync(photoPath).size).toBeGreaterThan(100_000); // authentic non-empty photo
            expect(fs.statSync(tilesPath).size).toBeGreaterThan(100_000); // authentic non-empty 3D twin
            expect(sample.key_structural_features.length).toBeGreaterThanOrEqual(8);
        }
    });

    describe('Analytical solvePnP Camera Resectioning on Non-Landmark Geometry', () => {
        const width = 1200;
        const height = 900;
        const cx = width / 2;
        const cy = height / 2;

        it('Sample 1: Suburban Residential — solves camera pose from roof ridges, eaves & fence posts', () => {
            const fx = 950.0;
            const fy = 950.0;
            const intrinsics: CameraIntrinsics = { fx, fy, cx, cy, width, height };

            const points3D: Point3D[] = [
                [-4.5, 0.0, 24.0],   // Front-left foundation
                [4.5, 0.0, 24.0],    // Front-right foundation
                [-4.5, 5.2, 24.0],   // Left eave corner
                [4.5, 5.2, 24.0],    // Right eave corner
                [0.0, 8.6, 24.0],    // Roof ridge peak apex
                [-4.5, 5.2, 33.0],   // Rear left eave corner
                [0.0, 8.6, 33.0],    // Rear ridge apex
                [7.5, 1.2, 20.0],    // Driveway chain-link post
                [-6.0, 0.0, 18.0],   // Sidewalk curb boundary
                [9.0, 9.5, 26.0],    // Utility pole crossarm tip
            ];

            const yawRad = -0.15;
            const pitchRad = 0.05;
            const cosY = Math.cos(yawRad);
            const sinY = Math.sin(yawRad);
            const cosP = Math.cos(pitchRad);
            const sinP = Math.sin(pitchRad);

            const R_true: [number, number, number][] = [
                [cosY, 0, -sinY],
                [-sinP * sinY, cosP, -sinP * cosY],
                [cosP * sinY, sinP, cosP * cosY]
            ];
            const t_true: Point3D = [0.0, 1.6, 2.0];

            const points2D: Point2D[] = points3D.map(pt3D => {
                const xc = R_true[0][0] * pt3D[0] + R_true[0][1] * pt3D[1] + R_true[0][2] * pt3D[2] + t_true[0];
                const yc = R_true[1][0] * pt3D[0] + R_true[1][1] * pt3D[1] + R_true[1][2] * pt3D[2] + t_true[1];
                const zc = R_true[2][0] * pt3D[0] + R_true[2][1] * pt3D[1] + R_true[2][2] * pt3D[2] + t_true[2];

                return [fx * (xc / zc) + cx, fy * (yc / zc) + cy];
            });

            const solved = SpatialPoseEstimatorService.solvePnP(points3D, points2D, intrinsics);

            expect(solved.converged).toBe(true);
            expect(solved.meanReprojectionErrorPx).toBeLessThan(0.01);
            expect(solved.translationCamera[1]).toBeCloseTo(t_true[1], 2);
        });

        it('Sample 2: Urban Commercial Corner — solves camera pose from bodega transoms & fire escapes', () => {
            const fx = 1000.0;
            const fy = 1000.0;
            const intrinsics: CameraIntrinsics = { fx, fy, cx, cy, width, height };

            const points3D: Point3D[] = [
                [-1.5, 0.0, 18.0],   // Sidewalk curb radius
                [-0.8, 0.2, 19.5],   // Bodega corner entrance
                [-0.8, 3.4, 19.5],   // Deli awning corner
                [-0.8, 4.2, 19.5],   // Roll-up gate transom
                [6.5, 3.4, 21.0],    // Awning right edge
                [-0.8, 15.8, 19.5],  // Roof parapet corner
                [-5.5, 15.8, 23.0],  // West roofline corner
                [8.5, 15.8, 22.0],   // North roofline corner
                [2.8, 6.5, 20.2],    // Fire escape 2nd floor balcony
                [2.8, 9.8, 20.2],    // Fire escape 3rd floor balcony
                [-4.2, 2.8, 17.0],   // Street sign post
                [-3.0, 0.0, 14.0],   // Crosswalk stripe start
            ];

            const pitchRad = 0.08;
            const yawRad = 0.12;

            const cosY = Math.cos(yawRad);
            const sinY = Math.sin(yawRad);
            const cosP = Math.cos(pitchRad);
            const sinP = Math.sin(pitchRad);

            const R_true: [number, number, number][] = [
                [cosY, 0, -sinY],
                [-sinP * sinY, cosP, -sinP * cosY],
                [cosP * sinY, sinP, cosP * cosY]
            ];
            const t_true: Point3D = [0.5, 1.7, 1.0];

            const points2D: Point2D[] = points3D.map(pt3D => {
                const xc = R_true[0][0] * pt3D[0] + R_true[0][1] * pt3D[1] + R_true[0][2] * pt3D[2] + t_true[0];
                const yc = R_true[1][0] * pt3D[0] + R_true[1][1] * pt3D[1] + R_true[1][2] * pt3D[2] + t_true[1];
                const zc = R_true[2][0] * pt3D[0] + R_true[2][1] * pt3D[1] + R_true[2][2] * pt3D[2] + t_true[2];

                return [fx * (xc / zc) + cx, fy * (yc / zc) + cy];
            });

            const solved = SpatialPoseEstimatorService.solvePnP(points3D, points2D, intrinsics);

            expect(solved.converged).toBe(true);
            expect(solved.meanReprojectionErrorPx).toBeLessThan(0.01);
            expect(solved.translationCamera[1]).toBeCloseTo(t_true[1], 2);
        });

        it('Sample 3: Industrial Logistics — solves camera pose from warehouse loading dock bays & semi trailer', () => {
            const fx = 1150.0;
            const fy = 1150.0;
            const intrinsics: CameraIntrinsics = { fx, fy, cx, cy, width, height };

            const points3D: Point3D[] = [
                [10.0, 0.0, 35.0],   // Dock bay 1 threshold
                [10.0, 4.0, 35.0],   // Dock bay 1 header
                [16.0, 0.0, 38.0],   // Dock bay 2 threshold
                [16.0, 4.0, 38.0],   // Dock bay 2 header
                [8.0, 0.0, 30.0],    // Parked trailer rear bumper
                [8.0, 3.8, 30.0],    // Parked trailer roof corner
                [1.5, 8.5, 42.0],    // Warehouse roof gravel stop
                [28.0, 8.5, 52.0],   // Warehouse distant roof corner
                [-5.0, 2.0, 22.0],   // Chain-link gate post
                [18.0, 12.0, 38.0],  // High-mast sodium luminaire
            ];

            const pitchRad = 0.03;
            const yawRad = 0.20;

            const cosY = Math.cos(yawRad);
            const sinY = Math.sin(yawRad);
            const cosP = Math.cos(pitchRad);
            const sinP = Math.sin(pitchRad);

            const R_true: [number, number, number][] = [
                [cosY, 0, -sinY],
                [-sinP * sinY, cosP, -sinP * cosY],
                [cosP * sinY, sinP, cosP * cosY]
            ];
            const t_true: Point3D = [1.0, 1.8, 3.0];

            const points2D: Point2D[] = points3D.map(pt3D => {
                const xc = R_true[0][0] * pt3D[0] + R_true[0][1] * pt3D[1] + R_true[0][2] * pt3D[2] + t_true[0];
                const yc = R_true[1][0] * pt3D[0] + R_true[1][1] * pt3D[1] + R_true[1][2] * pt3D[2] + t_true[1];
                const zc = R_true[2][0] * pt3D[0] + R_true[2][1] * pt3D[1] + R_true[2][2] * pt3D[2] + t_true[2];

                return [fx * (xc / zc) + cx, fy * (yc / zc) + cy];
            });

            const solved = SpatialPoseEstimatorService.solvePnP(points3D, points2D, intrinsics);

            expect(solved.converged).toBe(true);
            expect(solved.meanReprojectionErrorPx).toBeLessThan(0.01);
            expect(solved.translationCamera[1]).toBeCloseTo(t_true[1], 2);
        });

        it('Sample 4: Suburban Strip Mall — handles dynamic parking lot occlusion outliers with RANSAC', () => {
            const fx = 1000.0;
            const fy = 1000.0;
            const intrinsics: CameraIntrinsics = { fx, fy, cx, cy, width, height };

            const points3D: Point3D[] = [
                [-12.0, 6.5, 30.0],  // Pylon sign top left
                [-10.0, 6.5, 30.0],  // Pylon sign top right
                [-11.0, 0.0, 30.0],  // Pylon sign base
                [-6.0, 4.2, 34.0],   // Dry Cleaners awning apex
                [0.0, 4.2, 36.0],    // Tony's Pizzeria awning apex
                [6.0, 4.2, 38.0],    // Quick Mart awning apex
                [-8.0, 5.5, 35.0],   // Parapet horizontal roofline
                [18.0, 5.5, 45.0],   // Far right storefront roofline
                [-4.0, 0.0, 24.0],   // Speed bump left edge
                [2.0, 0.0, 25.0],    // Speed bump right edge
                [-3.0, 0.0, 18.0],   // Parking stall painted line
                [4.0, 0.0, 20.0],    // Parking stall painted line
            ];

            const pitchRad = 0.02;
            const yawRad = -0.18;

            const cosY = Math.cos(yawRad);
            const sinY = Math.sin(yawRad);
            const cosP = Math.cos(pitchRad);
            const sinP = Math.sin(pitchRad);

            const R_true: [number, number, number][] = [
                [cosY, 0, -sinY],
                [-sinP * sinY, cosP, -sinP * cosY],
                [cosP * sinY, sinP, cosP * cosY]
            ];
            const t_true: Point3D = [0.0, 1.6, 2.5];

            const points2D: Point2D[] = points3D.map(pt3D => {
                const xc = R_true[0][0] * pt3D[0] + R_true[0][1] * pt3D[1] + R_true[0][2] * pt3D[2] + t_true[0];
                const yc = R_true[1][0] * pt3D[0] + R_true[1][1] * pt3D[1] + R_true[1][2] * pt3D[2] + t_true[1];
                const zc = R_true[2][0] * pt3D[0] + R_true[2][1] * pt3D[1] + R_true[2][2] * pt3D[2] + t_true[2];

                return [fx * (xc / zc) + cx, fy * (yc / zc) + cy];
            });

            // Inject 3 severe outliers (e.g. moving cars, wandering pedestrians)
            const noisyPoints3D = [...points3D, [0, 0, 10] as Point3D, [5, 1, 15] as Point3D, [-5, 8, 20] as Point3D];
            const noisyPoints2D = [...points2D, [150, 820] as Point2D, [950, 780] as Point2D, [320, 210] as Point2D];

            const ransacResult = SpatialPoseEstimatorService.solvePnPRansac(
                noisyPoints3D,
                noisyPoints2D,
                intrinsics,
                { inlierThresholdPx: 2.5, maxRansacIterations: 100 }
            );

            expect(ransacResult.inlierCount).toBe(12);
            expect(ransacResult.pose.meanReprojectionErrorPx).toBeLessThan(0.02);
            expect(ransacResult.pose.translationCamera[1]).toBeCloseTo(t_true[1], 2);
        });

        it('Sample 5: Civil Highway Overpass — solves camera pose from bridge piers, soffits & exit sign gantry', () => {
            const fx = 850.0;
            const fy = 850.0;
            const intrinsics: CameraIntrinsics = { fx, fy, cx, cy, width, height };

            const points3D: Point3D[] = [
                [7.5, 0.0, 26.0],    // Concrete Pier 1 base (foreground)
                [7.5, 7.5, 26.0],    // Concrete Pier 1 pier cap
                [11.0, 0.0, 38.0],   // Concrete Pier 2 base (deeper midground)
                [11.0, 7.5, 38.0],   // Concrete Pier 2 pier cap
                [-0.5, 6.2, 22.0],   // Exit 142 Elm St sign bottom left
                [3.5, 6.2, 22.0],    // Exit 142 Elm St sign bottom right
                [-0.5, 8.2, 22.0],   // Exit 142 Elm St sign top left
                [3.5, 8.2, 22.0],    // Exit 142 Elm St sign top right
                [4.0, 6.2, 22.0],    // I-95 South sign bottom left
                [8.0, 6.2, 22.0],    // I-95 South sign bottom right
                [3.0, 1.0, 15.0],    // W-beam guardrail post (near foreground)
                [2.0, 0.0, 12.0],    // Shoulder asphalt edge (closest)
                [-6.0, 3.5, 30.0],   // Embankment retaining wall crest
                [6.0, 9.8, 32.0],    // Flyover bridge superstructure soffit
            ];

            const pitchRad = 0.09;
            const yawRad = -0.08;

            const cosY = Math.cos(yawRad);
            const sinY = Math.sin(yawRad);
            const cosP = Math.cos(pitchRad);
            const sinP = Math.sin(pitchRad);

            const R_true: [number, number, number][] = [
                [cosY, 0, -sinY],
                [-sinP * sinY, cosP, -sinP * cosY],
                [cosP * sinY, sinP, cosP * cosY]
            ];
            const t_true: Point3D = [0.0, 1.5, 1.0];

            const points2D: Point2D[] = points3D.map(pt3D => {
                const xc = R_true[0][0] * pt3D[0] + R_true[0][1] * pt3D[1] + R_true[0][2] * pt3D[2] + t_true[0];
                const yc = R_true[1][0] * pt3D[0] + R_true[1][1] * pt3D[1] + R_true[1][2] * pt3D[2] + t_true[1];
                const zc = R_true[2][0] * pt3D[0] + R_true[2][1] * pt3D[1] + R_true[2][2] * pt3D[2] + t_true[2];

                return [fx * (xc / zc) + cx, fy * (yc / zc) + cy];
            });

            const solved = SpatialPoseEstimatorService.solvePnP(points3D, points2D, intrinsics);

            expect(solved.converged).toBe(true);
            expect(solved.meanReprojectionErrorPx).toBeLessThan(0.01);
            expect(solved.translationCamera[1]).toBeCloseTo(t_true[1], 2);
        });
    });
});
