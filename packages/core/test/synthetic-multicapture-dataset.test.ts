/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  NerfstudioDatasetService,
  NERFSTUDIO_MASK_THRESHOLD,
  OrbitalCameraRigItem
} from '../src/node/spatial/NerfstudioDatasetService';

describe('Synthetic Multi-Capture Nerfstudio Dataset Pipeline', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scratchbox_multicapture_test_'));
  });

  afterEach(() => {
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  describe('1. Synthetic Multi-Camera Orbital Rig Generation', () => {
    it('generates a calibrated 4-view orbital rig around target with closed-form c2w/w2c matrices', () => {
      const rig = NerfstudioDatasetService.generateOrbitalCameraRig({
        target: [0.0, 1.0, 0.0],
        radius: 2.4,
        cameras: [
          { id: 0, name: 'Cam 0 (Hero Front 0°)', position: [0.0, 1.25, 2.4] },
          { id: 1, name: 'Cam 1 (Left 45° Lateral)', position: [-1.7, 1.35, 1.7] },
          { id: 2, name: 'Cam 2 (Right 45° Lateral)', position: [1.7, 1.35, 1.7] },
          { id: 3, name: 'Cam 3 (Rear 180° Survey)', position: [0.0, 1.4, -2.4] },
        ],
        intrinsics: {
          fx: 2484,
          fy: 2484,
          cx: 1080,
          cy: 1920,
          width: 2160,
          height: 3840
        }
      });

      expect(rig.length).toBe(4);
      expect(rig[0].name).toContain('Hero Front');
      expect(rig[1].name).toContain('Left 45°');
      expect(rig[2].name).toContain('Right 45°');
      expect(rig[3].name).toContain('Rear 180°');

      // Verify that each camera has 16-element OpenCV c2w and w2c matrices
      for (const cam of rig) {
        expect(cam.c2wMatrix.length).toBe(16);
        expect(cam.w2cMatrix.length).toBe(16);
        expect(cam.c2wNerfstudio.length).toBe(4);
        expect(cam.c2wNerfstudio[0].length).toBe(4);

        // In OpenCV: +X right, +Y down, +Z forward
        // In Nerfstudio: columns 1 & 2 must be negated relative to OpenCV c2w
        // Nerfstudio element [r][c] corresponds to OpenCV [r * 4 + c], with col 1 & 2 negated
        expect(cam.c2wNerfstudio[0][0]).toBeCloseTo(cam.c2wMatrix[0], 5);
        expect(cam.c2wNerfstudio[0][1]).toBeCloseTo(-cam.c2wMatrix[1], 5);
        expect(cam.c2wNerfstudio[0][2]).toBeCloseTo(-cam.c2wMatrix[2], 5);
        expect(cam.c2wNerfstudio[0][3]).toBeCloseTo(cam.c2wMatrix[3], 5);

        expect(cam.c2wNerfstudio[1][0]).toBeCloseTo(cam.c2wMatrix[4], 5);
        expect(cam.c2wNerfstudio[1][1]).toBeCloseTo(-cam.c2wMatrix[5], 5);
        expect(cam.c2wNerfstudio[1][2]).toBeCloseTo(-cam.c2wMatrix[6], 5);
        expect(cam.c2wNerfstudio[1][3]).toBeCloseTo(cam.c2wMatrix[7], 5);

        expect(cam.c2wNerfstudio[2][0]).toBeCloseTo(cam.c2wMatrix[8], 5);
        expect(cam.c2wNerfstudio[2][1]).toBeCloseTo(-cam.c2wMatrix[9], 5);
        expect(cam.c2wNerfstudio[2][2]).toBeCloseTo(-cam.c2wMatrix[10], 5);
        expect(cam.c2wNerfstudio[2][3]).toBeCloseTo(cam.c2wMatrix[11], 5);
      }
    });
  });

  describe('2. Multi-View Observation Rasterization', () => {
    it('rasterizes 3D point cloud onto camera view synthesizing binary mask and RGB image buffers', () => {
      const rig = NerfstudioDatasetService.generateOrbitalCameraRig({
        target: [0.0, 1.0, 0.0],
        radius: 2.0,
      });

      const points = [
        { position: [0.0, 1.0, 0.0] as [number, number, number], color: [1.0, 0.0, 0.0] as [number, number, number] }, // Pure red center
        { position: [0.0, 1.5, 0.0] as [number, number, number], color: [0.0, 1.0, 0.0] as [number, number, number] }, // Green top
        { position: [0.0, 0.5, 0.0] as [number, number, number], color: [0.0, 0.0, 1.0] as [number, number, number] }, // Blue bottom
      ];

      const outW = 200;
      const outH = 200;
      const observation = NerfstudioDatasetService.rasterizePointsToObservation(
        points,
        { w2cMatrix: rig[0].w2cMatrix, intrinsics: { ...rig[0].intrinsics, width: outW, height: outH, cx: 100, cy: 100 } },
        { outputWidth: outW, outputHeight: outH, splatRadius: 5 }
      );

      expect(observation.maskBuffer.length).toBe(outW * outH);
      expect(observation.imageBuffer.length).toBe(outW * outH * 3);

      // Verify that foreground pixels exist
      let fgPixels = 0;
      for (let i = 0; i < observation.maskBuffer.length; i++) {
        if (observation.maskBuffer[i] === 255) {
          fgPixels++;
        }
      }
      expect(fgPixels).toBeGreaterThan(50);

      // Verify that RGB buffer has non-zero colors
      let hasRed = false;
      for (let i = 0; i < observation.imageBuffer.length; i += 3) {
        if (observation.imageBuffer[i] > 200 && observation.imageBuffer[i + 1] === 0) {
          hasRed = true;
          break;
        }
      }
      expect(hasRed).toBe(true);
    });
  });

  describe('3. Automated Multi-View Dataset Export with Synthetic Observations', () => {
    it('exports 4-view Nerfstudio dataset with valid PNGs and transforms.json', async () => {
      const rig = NerfstudioDatasetService.generateOrbitalCameraRig({
        target: [0.0, 1.0, 0.0],
        radius: 2.4,
      });

      const sparsePoints = [
        { position: [0.0, 1.0, 0.0] as [number, number, number], color: [0.9, 0.8, 0.7] as [number, number, number] },
        { position: [0.2, 1.2, 0.1] as [number, number, number], color: [0.8, 0.7, 0.6] as [number, number, number] },
        { position: [-0.2, 0.8, -0.1] as [number, number, number], color: [0.7, 0.6, 0.5] as [number, number, number] },
      ];

      // Provide real buffer only for Cam 0, leave Cam 1..3 undefined to trigger synthetic rasterization
      const service = new NerfstudioDatasetService();
      const exportResult = await service.exportDataset({
        outputDir: tempDir,
        cameraRig: [
          { cameraId: 0, c2wMatrix: rig[0].c2wMatrix, imageBuffer: Buffer.from('mock_hero_frame') },
          { cameraId: 1, c2wMatrix: rig[1].c2wMatrix },
          { cameraId: 2, c2wMatrix: rig[2].c2wMatrix },
          { cameraId: 3, c2wMatrix: rig[3].c2wMatrix },
        ],
        defaultIntrinsics: rig[0].intrinsics,
        sparsePoints
      });

      expect(exportResult.success).toBe(true);
      expect(exportResult.frameCount).toBe(4);
      expect(fs.existsSync(exportResult.transformsPath)).toBe(true);
      expect(fs.existsSync(path.join(tempDir, 'sparse_pcd.ply'))).toBe(true);

      // Verify that transforms.json has 4 frames
      const transforms = JSON.parse(fs.readFileSync(exportResult.transformsPath, 'utf-8'));
      expect(transforms.frames.length).toBe(4);
      expect(transforms.camera_model).toBe('OPENCV');

      // Verify that synthetic images were encoded as valid PNG files
      const cam1ImagePath = path.join(tempDir, 'images/01.png');
      expect(fs.existsSync(cam1ImagePath)).toBe(true);
      const cam1ImageBytes = fs.readFileSync(cam1ImagePath);
      // PNG header check: 0x89 'P' 'N' 'G'
      expect(cam1ImageBytes[0]).toBe(0x89);
      expect(cam1ImageBytes[1]).toBe(0x50);
      expect(cam1ImageBytes[2]).toBe(0x4E);
      expect(cam1ImageBytes[3]).toBe(0x47);

      // Verify synthetic mask was encoded as valid PNG
      const cam1MaskPath = path.join(tempDir, 'masks/01.png');
      expect(fs.existsSync(cam1MaskPath)).toBe(true);
      const cam1MaskBytes = fs.readFileSync(cam1MaskPath);
      expect(cam1MaskBytes[0]).toBe(0x89);
      expect(cam1MaskBytes[1]).toBe(0x50);
      expect(cam1MaskBytes[2]).toBe(0x4E);
      expect(cam1MaskBytes[3]).toBe(0x47);
    });
  });

  describe('5. Demo Multi-Camera transforms.json Verification', () => {
    // Written into the per-test temp dir: the test must not overwrite the installed demo's transforms.json.
    it('generates a demo-layout transforms.json (10331522 hero + 3 survey cameras) with all 4 calibrated camera frames', () => {
      const rig = NerfstudioDatasetService.generateOrbitalCameraRig({
        target: [0.0, 1.0, 0.0],
        radius: 2.4,
        cameras: [
          { id: 0, name: 'Cam 0 (Hero Front 0°)', position: [0.0, 1.25, 2.4] },
          { id: 1, name: 'Cam 1 (Left 45° Lateral)', position: [-1.7, 1.35, 1.7] },
          { id: 2, name: 'Cam 2 (Right 45° Lateral)', position: [1.7, 1.35, 1.7] },
          { id: 3, name: 'Cam 3 (Rear 180° Survey)', position: [0.0, 1.4, -2.4] }
        ],
        intrinsics: {
          fx: 2484,
          fy: 2484,
          cx: 1080,
          cy: 1920,
          width: 2160,
          height: 3840
        }
      });

      const demoTransformsPath = path.join(tempDir, 'transforms.json');
      const transformsData = {
        camera_model: 'OPENCV',
        fl_x: 2484,
        fl_y: 2484,
        cx: 1080,
        cy: 1920,
        w: 2160,
        h: 3840,
        applied_transform: [
          [1.0, 0.0, 0.0, 0.0],
          [0.0, -1.0, 0.0, 0.0],
          [0.0, 0.0, -1.0, 0.0],
          [0.0, 0.0, 0.0, 1.0]
        ],
        frames: rig.map((cam, idx) => ({
          file_path: idx === 0 ? 'canonical_frame.jpg' : `cam_${String(idx).padStart(2, '0')}.png`,
          transform_matrix: cam.c2wNerfstudio,
          mask_path: idx === 0 ? 'canonical_mask.png' : `cam_${String(idx).padStart(2, '0')}_mask.png`,
          fl_x: cam.intrinsics.fx,
          fl_y: cam.intrinsics.fy,
          cx: cam.intrinsics.cx,
          cy: cam.intrinsics.cy,
          w: cam.intrinsics.width,
          h: cam.intrinsics.height
        }))
      };

      fs.writeFileSync(demoTransformsPath, JSON.stringify(transformsData, null, 2), 'utf-8');

      const loaded = JSON.parse(fs.readFileSync(demoTransformsPath, 'utf-8'));
      expect(loaded.frames.length).toBe(4);
      expect(loaded.frames[0].file_path).toBe('canonical_frame.jpg');
      expect(loaded.frames[1].file_path).toBe('cam_01.png');
      expect(loaded.frames[2].file_path).toBe('cam_02.png');
      expect(loaded.frames[3].file_path).toBe('cam_03.png');
    });
  });
});
