/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  NerfstudioDatasetService,
  NERFSTUDIO_MASK_THRESHOLD,
  CameraObservationInput,
} from '../src/node/spatial/NerfstudioDatasetService';

describe('NerfstudioDatasetService & Coordinate Interoperability', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nerfstudio_test_'));
  });

  afterEach(() => {
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  describe('1. Camera Matrix Convention Conversions (OpenCV <-> Nerfstudio/OpenGL)', () => {
    it('negates column 1 (Y) and column 2 (Z) to bridge OpenCV and Nerfstudio/OpenGL frames', () => {
      // Identity camera-to-world
      const identityMat = [
        1, 0, 0, 0,
        0, 1, 0, 0,
        0, 0, 1, 0,
        0, 0, 0, 1,
      ];

      const converted = NerfstudioDatasetService.convertCameraMatrixConvention(identityMat);

      expect(converted).toEqual([
        [1, -0, -0, 0],
        [0, -1, -0, 0],
        [0, -0, -1, 0],
        [0, -0, -0, 1],
      ]);
    });

    it('satisfies involution (T = convert(convert(T))) ensuring lossless bidirectional round-trip', () => {
      const c2wOpenCV = [
        0.866, -0.05,  0.497, 1.25,
        0.0,    0.995, 0.100, 0.85,
       -0.5,   -0.086, 0.862, 2.75,
        0.0,    0.0,   0.0,   1.0,
      ];

      const c2wNerfstudio = NerfstudioDatasetService.convertCameraMatrixConvention(c2wOpenCV);
      const roundTrip = NerfstudioDatasetService.convertCameraMatrixConvention(c2wNerfstudio);

      for (let r = 0; r < 4; r++) {
        for (let c = 0; c < 4; c++) {
          const expected = c2wOpenCV[r * 4 + c];
          expect(roundTrip[r][c]).toBeCloseTo(expected, 4);
        }
      }
    });

    it('inverts a 4x4 rigid transformation matrix correctly', () => {
      // Translation only
      const tMat = [
        1, 0, 0, 5,
        0, 1, 0, -3,
        0, 0, 1, 8,
        0, 0, 0, 1,
      ];

      const inv = NerfstudioDatasetService.invertMatrix4(tMat);
      expect(inv[3]).toBeCloseTo(-5, 4);
      expect(inv[7]).toBeCloseTo(3, 4);
      expect(inv[11]).toBeCloseTo(-8, 4);
      expect(inv[15]).toBeCloseTo(1, 4);
    });
  });

  describe('2. Mask Binarization', () => {
    it('applies strict threshold >= 128 to soft alpha masks', () => {
      const rawMask = Buffer.from([0, 50, 127, 128, 129, 200, 255]);
      const binarized = NerfstudioDatasetService.binarizeMask(rawMask, NERFSTUDIO_MASK_THRESHOLD);

      expect(Array.from(binarized)).toEqual([0, 0, 0, 255, 255, 255, 255]);
    });
  });

  describe('3. Sparse PCD PLY Serializer', () => {
    it('produces valid ASCII PLY header and point entries', () => {
      const points = [
        {
          position: [0.123456, 1.234567, -0.987654] as [number, number, number],
          normal: [0, 1, 0] as [number, number, number],
          color: [1.0, 0.5, 0.0] as [number, number, number],
        },
      ];

      const plyText = NerfstudioDatasetService.serializeSparsePcdPly(points);

      expect(plyText).toContain('ply\n');
      expect(plyText).toContain('format ascii 1.0\n');
      expect(plyText).toContain('element vertex 1\n');
      expect(plyText).toContain('property float x\n');
      expect(plyText).toContain('property uchar red\n');
      expect(plyText).toContain('end_header\n');
      // Point values: pos [0.12346, 1.23457, -0.98765], normal [0.0000, 1.0000, 0.0000], color 255, 128, 0
      expect(plyText).toContain('0.12346 1.23457 -0.98765 0.0000 1.0000 0.0000 255 128 0');
    });
  });

  describe('4. Visual-Hull Voxel Carving', () => {
    it('carves points within multi-camera mask intersections', () => {
      // Create 2 orthogonal cameras observing the origin [0, 0, 0]
      const width = 100;
      const height = 100;

      // Fully white mask (entire frustum is foreground)
      const whiteMask = Buffer.alloc(width * height, 255);
      // Red texture
      const redRgb = Buffer.alloc(width * height * 3);
      for (let i = 0; i < width * height; i++) {
        redRgb[i * 3 + 0] = 255;
        redRgb[i * 3 + 1] = 0;
        redRgb[i * 3 + 2] = 0;
      }

      // Cam 1: at [0, 0, 2], looking along -Z toward origin (camera forward is +Z_cam = world -Z)
      const c2w1 = [
        -1, 0,  0, 0,
         0, 1,  0, 0,
         0, 0, -1, 2,
         0, 0,  0, 1,
      ];

      // Cam 2: at [2, 0, 0], looking along -X toward origin (camera forward is +Z_cam = world -X)
      const c2w2 = [
        0, 0, -1, 2,
        0, 1,  0, 0,
        1, 0,  0, 0,
        0, 0,  0, 1,
      ];

      const cameras: CameraObservationInput[] = [
        {
          cameraId: 0,
          c2wMatrix: c2w1,
          maskBuffer: whiteMask,
          imageBuffer: redRgb,
          intrinsics: { fx: 100, fy: 100, cx: 50, cy: 50, width: 100, height: 100 },
        },
        {
          cameraId: 1,
          c2wMatrix: c2w2,
          maskBuffer: whiteMask,
          imageBuffer: redRgb,
          intrinsics: { fx: 100, fy: 100, cx: 50, cy: 50, width: 100, height: 100 },
        },
      ];

      const points = NerfstudioDatasetService.carveVisualHull(cameras, {
        center: [0, 0, 0],
        halfExtent: 0.2,
        voxelSize: 0.1,
        minForegroundViews: 2,
      });

      expect(points.length).toBeGreaterThan(0);
      // Color should be red
      expect(points[0].color[0]).toBeCloseTo(1.0, 1);
      expect(points[0].color[1]).toBeCloseTo(0.0, 1);
    });
  });

  describe('5. Full Dataset Export & Import Round-Trip', () => {
    it('exports a compliant Nerfstudio dataset and accurately reconstructs camera poses on import', async () => {
      const c2wOriginal = [
        1, 0, 0, 0,
        0, 1, 0, 1.0,
        0, 0, 1, 2.5,
        0, 0, 0, 1,
      ];

      const imgBuf = Buffer.from('mock_png_data');
      const maskBuf = Buffer.from([255, 255, 0, 0]);

      const service = new NerfstudioDatasetService();
      const exportResult = await service.exportDataset({
        outputDir: tempDir,
        cameraRig: [
          {
            cameraId: 0,
            c2wMatrix: c2wOriginal,
            imageBuffer: imgBuf,
            maskBuffer: maskBuf,
          },
        ],
        defaultIntrinsics: {
          fx: 1200,
          fy: 1200,
          cx: 960,
          cy: 540,
          width: 1920,
          height: 1080,
        },
        sparsePoints: [
          {
            position: [0, 1, 0],
            color: [0.8, 0.8, 0.8],
          },
        ],
      });

      expect(exportResult.success).toBe(true);
      expect(fs.existsSync(exportResult.transformsPath)).toBe(true);
      expect(fs.existsSync(path.join(tempDir, 'sparse_pcd.ply'))).toBe(true);
      expect(fs.existsSync(path.join(tempDir, 'images/00.png'))).toBe(true);
      expect(fs.existsSync(path.join(tempDir, 'masks/00.png'))).toBe(true);

      // Verify transforms.json structure
      const rawTransforms = JSON.parse(fs.readFileSync(exportResult.transformsPath, 'utf-8'));
      expect(rawTransforms.camera_model).toBe('OPENCV');
      expect(rawTransforms.fl_x).toBe(1200);
      expect(rawTransforms.frames.length).toBe(1);
      expect(rawTransforms.frames[0].file_path).toBe('images/00.png');
      expect(rawTransforms.frames[0].mask_path).toBe('masks/00.png');

      // Import back
      const imported = NerfstudioDatasetService.importDataset(tempDir);
      expect(imported.cameraRig.length).toBe(1);

      // Check reconstructed OpenCV matrix matches original
      const recomputedC2w = imported.cameraRig[0].c2wMatrix!;
      for (let i = 0; i < 16; i++) {
        expect(recomputedC2w[i]).toBeCloseTo(c2wOriginal[i], 4);
      }
    });
  });
});
