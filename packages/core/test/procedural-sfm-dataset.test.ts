/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import * as fs from 'fs';
import * as path from 'path';
import { describe, it, expect } from 'vitest';
import {
  ProceduralSfMDatasetService,
  ProceduralCameraPose
} from '../src/node/spatial/ProceduralSfMDatasetService';

describe('ProceduralSfMDatasetService (Procedural Structure SfM / COLMAP Generation)', () => {
  describe('1. Pinhole Intrinsics Calculation', () => {
    it('should compute exact fx, fy, cx, cy from horizontal FOV and image dimensions', () => {
      const width = 1920;
      const height = 1080;
      const fovH = 60.0;

      const intr = ProceduralSfMDatasetService.calculateIntrinsics(width, height, fovH);

      expect(intr.width).toBe(1920);
      expect(intr.height).toBe(1080);
      expect(intr.cx).toBe(960);
      expect(intr.cy).toBe(540);
      expect(intr.fovHorizontalDeg).toBe(60.0);

      // fx = (1920 / 2) / tan(30 deg) = 960 / 0.577350269 = 1662.768775
      expect(intr.fx).toBeCloseTo(1662.7688, 3);
      expect(intr.fy).toBeCloseTo(1662.7688, 3);

      // fy is identical (square pixels), vertical fov = 2 * atan(540 / 1662.7688) = 36.00 deg
      expect(intr.fovVerticalDeg).toBeCloseTo(36.0, 1);
    });
  });

  describe('2. Camera Pose Coordinate Transforms & Invariants', () => {
    it('should maintain strict coordinate conventions between OpenGL, OpenCV, and COLMAP', () => {
      const intr = ProceduralSfMDatasetService.calculateIntrinsics(1920, 1080, 60.0);
      const eye: [number, number, number] = [0, 0, 5];
      const target: [number, number, number] = [0, 0, 0];

      const pose = ProceduralSfMDatasetService.buildCameraPose(1, 'view_001.png', eye, target, intr);

      // Verify quaternion is normalized
      const q = pose.colmapQuaternion;
      const qNorm = Math.hypot(q.w, q.x, q.y, q.z);
      expect(qNorm).toBeCloseTo(1.0, 6);

      // For a camera at (0, 0, 5) looking at (0, 0, 0):
      // Forward vector is (0, 0, -1). Right is (1, 0, 0). Up is (0, 1, 0).
      // In OpenGL: viewing direction is -Z. In OpenCV: viewing direction is +Z.
      // Therefore, the OpenCV viewing direction aligns with world -Z.
      // Translation vector in COLMAP: t = -R * C
      expect(pose.colmapTranslation[2]).toBeCloseTo(5.0, 3);

      // Nerfstudio c2w matrix check (translation column)
      expect(pose.c2wMatrixNerfstudio[3]).toBe(0); // eye X
      expect(pose.c2wMatrixNerfstudio[7]).toBe(0); // eye Y
      expect(pose.c2wMatrixNerfstudio[11]).toBe(5); // eye Z
    });

    it('should verify W2C matrix is mathematically inverse to C2W OpenCV matrix', () => {
      const intr = ProceduralSfMDatasetService.calculateIntrinsics(1920, 1080, 55.0);
      const eye: [number, number, number] = [3, 2, 4];
      const target: [number, number, number] = [0, 0.5, 0];

      const pose = ProceduralSfMDatasetService.buildCameraPose(2, 'view_002.png', eye, target, intr);

      const c2w = pose.c2wMatrixOpenCv;
      const w2c = pose.w2cMatrixOpenCv;

      // Multiply W2C * C2W to check identity matrix
      for (let r = 0; r < 4; r++) {
        for (let c = 0; c < 4; c++) {
          let sum = 0;
          for (let k = 0; k < 4; k++) {
            sum += w2c[r * 4 + k] * c2w[k * 4 + c];
          }
          const expected = r === c ? 1.0 : 0.0;
          expect(sum).toBeCloseTo(expected, 4);
        }
      }
    });
  });

  describe('3. Procedural Trajectory Synthesis', () => {
    it('should generate spherical Fibonacci trajectories with correct view counts', () => {
      const poses = ProceduralSfMDatasetService.generateTrajectory({
        trajectory: 'orbital_fibonacci',
        numViews: 16,
        radius: 5.0,
        target: [0, 1, 0]
      });

      expect(poses).toHaveLength(16);
      for (const pose of poses) {
        // Distance to target must match radius
        const dx = pose.position[0] - 0;
        const dy = pose.position[1] - 1;
        const dz = pose.position[2] - 0;
        const dist = Math.hypot(dx, dy, dz);
        expect(dist).toBeCloseTo(5.0, 3);
        // Altitude must be strictly above ground (y >= target + 0.15 * radius)
        expect(pose.position[1]).toBeGreaterThanOrEqual(1.0);
      }
    });

    it('should generate turntable orbits around the target', () => {
      const poses = ProceduralSfMDatasetService.generateTrajectory({
        trajectory: 'turntable',
        numViews: 12,
        radius: 3.5,
        altitudeRange: [2.0, 2.0],
        target: [0, 0, 0]
      });

      expect(poses).toHaveLength(12);
      for (const pose of poses) {
        expect(pose.position[1]).toBeCloseTo(2.0, 3);
        const radiusXZ = Math.hypot(pose.position[0], pose.position[2]);
        expect(radiusXZ).toBeCloseTo(3.5, 3);
      }
    });
  });

  describe('4. Procedural Geometry Sampling (points3D / sparse_pcd)', () => {
    it('should sample procedural sphere geometry with unit normals and valid RGB', () => {
      const points = ProceduralSfMDatasetService.sampleProceduralGeometry('sphere', 200, 2.0, [0, 1, 0]);

      expect(points).toHaveLength(200);
      for (const pt of points) {
        // Distance to center [0, 1, 0] must be radius = 2.0
        const dist = Math.hypot(pt.position[0] - 0, pt.position[1] - 1, pt.position[2] - 0);
        expect(dist).toBeCloseTo(2.0, 3);

        // Normal must have unit length
        const normLen = Math.hypot(pt.normal[0], pt.normal[1], pt.normal[2]);
        expect(normLen).toBeCloseTo(1.0, 3);

        // Color values in [0, 255]
        expect(pt.color[0]).toBeGreaterThanOrEqual(0);
        expect(pt.color[0]).toBeLessThanOrEqual(255);
      }
    });

    it('should sample procedural box geometry on faces', () => {
      const points = ProceduralSfMDatasetService.sampleProceduralGeometry('box', 150, 1.0, [0, 0, 0]);

      expect(points).toHaveLength(150);
      for (const pt of points) {
        // Each coordinate must be in [-1, 1]
        expect(Math.abs(pt.position[0])).toBeLessThanOrEqual(1.0001);
        expect(Math.abs(pt.position[1])).toBeLessThanOrEqual(1.0001);
        expect(Math.abs(pt.position[2])).toBeLessThanOrEqual(1.0001);
      }
    });
  });

  describe('5. Dataset Serialization & File Formats', () => {
    it('should generate valid COLMAP and Nerfstudio bundles', () => {
      const poses = ProceduralSfMDatasetService.generateTrajectory({
        numViews: 4,
        radius: 3.0
      });
      const points = ProceduralSfMDatasetService.sampleProceduralGeometry('sphere', 50, 1.0);

      const bundle = ProceduralSfMDatasetService.serializeBundle(poses, points);

      // 1. COLMAP cameras.txt
      expect(bundle.camerasText).toContain('CAMERA_ID, MODEL, WIDTH, HEIGHT, PARAMS[]');
      expect(bundle.camerasText).toContain('1 PINHOLE 1920 1080');

      // 2. COLMAP images.txt
      expect(bundle.imagesText).toContain('# Number of images: 4');
      expect(bundle.imagesText).toContain('1 ');
      expect(bundle.imagesText).toContain('view_000.png');

      // 3. COLMAP points3D.txt
      expect(bundle.points3DText).toContain('# Number of points: 50');
      expect(bundle.points3DText).toContain('1 ');

      // 4. Nerfstudio transforms.json
      const parsedTransforms = JSON.parse(bundle.transformsJson);
      expect(parsedTransforms.camera_model).toBe('PINHOLE');
      expect(parsedTransforms.frames).toHaveLength(4);
      expect(parsedTransforms.frames[0].file_path).toBe('./images/view_000.png');
      expect(parsedTransforms.frames[0].transform_matrix).toHaveLength(4);

      // 5. Nerfstudio sparse_pcd.ply
      expect(bundle.sparsePcdPly).toContain('ply');
      expect(bundle.sparsePcdPly).toContain('element vertex 50');
      expect(bundle.sparsePcdPly).toContain('end_header');
    });
  });

  describe('6. Disk Export Integration', () => {
    it('should export all dataset files to target directory', async () => {
      const outDir = path.resolve(process.cwd(), 'public/data/test_procedural_sfm');
      const poses = ProceduralSfMDatasetService.generateTrajectory({ numViews: 3, radius: 2.0 });
      const points = ProceduralSfMDatasetService.sampleProceduralGeometry('box', 20, 1.0);
      const bundle = ProceduralSfMDatasetService.serializeBundle(poses, points);

      const exportResult = await ProceduralSfMDatasetService.exportToDisk(bundle, outDir, 'both');

      expect(fs.existsSync(exportResult.imagesDir)).toBe(true);
      expect(fs.existsSync(path.join(exportResult.colmapDir!, 'cameras.txt'))).toBe(true);
      expect(fs.existsSync(path.join(exportResult.colmapDir!, 'images.txt'))).toBe(true);
      expect(fs.existsSync(path.join(exportResult.colmapDir!, 'points3D.txt'))).toBe(true);
      expect(fs.existsSync(exportResult.nerfstudioTransformsPath!)).toBe(true);
      expect(fs.existsSync(exportResult.sparsePcdPlyPath!)).toBe(true);

      // Cleanup
      fs.rmSync(outDir, { recursive: true, force: true });
    });
  });
});
