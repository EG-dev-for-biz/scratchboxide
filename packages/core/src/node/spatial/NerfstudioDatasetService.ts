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
import { HeadlessMeshSilhouetteRenderer } from './HeadlessMeshSilhouetteRenderer';
import { decodePng } from '../texture-processing';

/**
 * Standard pinhole camera intrinsics.
 */
export interface NerfstudioIntrinsics {
  fx: number;
  fy: number;
  cx: number;
  cy: number;
  width: number;
  height: number;
}

/**
 * Nerfstudio standard frame record within transforms.json.
 */
export interface NerfstudioFrame {
  file_path: string;
  transform_matrix: number[][]; // 4x4 camera-to-world matrix (OpenGL / Nerfstudio convention)
  mask_path?: string;
  depth_file_path?: string;
  fl_x?: number;
  fl_y?: number;
  cx?: number;
  cy?: number;
  w?: number;
  h?: number;
  sharpness?: number;
}

/**
 * Nerfstudio transforms.json structure.
 */
export interface NerfstudioTransforms {
  camera_model?: 'OPENCV' | 'PINHOLE';
  fl_x: number;
  fl_y: number;
  cx: number;
  cy: number;
  w: number;
  h: number;
  k1?: number;
  k2?: number;
  p1?: number;
  p2?: number;
  frames: NerfstudioFrame[];
  applied_transform?: number[][];
}

/**
 * Input camera observation for exporting to Nerfstudio.
 */
export interface CameraObservationInput {
  cameraId: number | string;
  // Either in-memory buffer or existing file path on disk
  imageBuffer?: Buffer;
  imagePath?: string;
  maskBuffer?: Buffer;
  maskPath?: string;
  depthBuffer?: Buffer | Float32Array;
  depthPath?: string;

  // Camera extrinsics (OpenCV convention: +X right, +Y down, +Z forward)
  // Either camera-to-world (c2w) or world-to-camera (w2c)
  c2wMatrix?: number[]; // 16 numbers in row-major order
  w2cMatrix?: number[]; // 16 numbers in row-major order

  // Optional per-camera intrinsics override
  intrinsics?: NerfstudioIntrinsics;
}

/**
 * Item in a generated multi-camera orbital rig.
 */
export interface OrbitalCameraRigItem {
  cameraId: number;
  name: string;
  position: [number, number, number];
  target: [number, number, number];
  c2wMatrix: number[]; // 16 numbers row-major OpenCV (+X Right, +Y Down, +Z Forward)
  w2cMatrix: number[]; // 16 numbers row-major OpenCV
  c2wNerfstudio: number[][]; // 4x4 matrix Nerfstudio/OpenGL (+X Right, +Y Up, -Z Forward)
  intrinsics: NerfstudioIntrinsics;
}

/**
 * Options for exporting a multi-view dataset into Nerfstudio format.
 */
export interface ExportNerfstudioOptions {
  outputDir: string;
  cameraRig: CameraObservationInput[];
  defaultIntrinsics: NerfstudioIntrinsics;
  distortion?: {
    k1?: number;
    k2?: number;
    p1?: number;
    p2?: number;
  };
  maskThreshold?: number; // default: 128 (NERFSTUDIO_MASK_THRESHOLD)
  carveVisualHull?: boolean;
  visualHullOptions?: {
    center?: [number, number, number];
    halfExtent?: number;
    voxelSize?: number;
    minForegroundViews?: number;
    maxPoints?: number;
  };
  sparsePoints?: Array<{
    position: [number, number, number];
    normal?: [number, number, number];
    color: [number, number, number]; // [0..1]
  }>;
}

/**
 * Result of dataset export.
 */
export interface ExportNerfstudioResult {
  success: boolean;
  outputDir: string;
  transformsPath: string;
  sparsePcdPath?: string;
  frameCount: number;
  sparsePointCount: number;
  warnings?: string[];
}

export const NERFSTUDIO_MASK_THRESHOLD = 128;

/**
 * Universal Nerfstudio Dataset Interoperability Service.
 * Implements bidirectional transforms between OpenCV and Nerfstudio/OpenGL conventions,
 * visual-hull voxel initialization, and standard transforms.json serialization.
 */
export class NerfstudioDatasetService {
  /**
   * Converts a 4x4 camera-to-world matrix between OpenCV and Nerfstudio/OpenGL conventions.
   *
   * OpenCV: +X Right, +Y Down, +Z Forward
   * Nerfstudio / OpenGL: +X Right, +Y Up, -Z Forward (Z points backward)
   *
   * Operation: T_nerfstudio = T_opencv * diag(1, -1, -1, 1).
   * Note: diag(1, -1, -1, 1) is self-inverse, so calling this twice restores the original matrix.
   */
  public static convertCameraMatrixConvention(mat4RowMajor: number[] | number[][]): number[][] {
    // Flatten if passed as 2D array
    const flat: number[] = Array.isArray(mat4RowMajor[0])
      ? (mat4RowMajor as number[][]).flat()
      : (mat4RowMajor as number[]);

    if (flat.length !== 16) {
      throw new Error(`Expected 16 elements in 4x4 matrix, got ${flat.length}`);
    }

    // Multiply by diag(1, -1, -1, 1) on the right:
    // Invert columns 1 and 2 (Y and Z columns)
    const result: number[][] = [
      [flat[0], -flat[1], -flat[2], flat[3]],
      [flat[4], -flat[5], -flat[6], flat[7]],
      [flat[8], -flat[9], -flat[10], flat[11]],
      [flat[12], -flat[13], -flat[14], flat[15]],
    ];

    return result;
  }

  /**
   * Inverts a 4x4 affine transformation matrix (assumes rigid or uniform scale).
   */
  public static invertMatrix4(m: number[]): number[] {
    const inv = new Array(16);

    inv[0] = m[5] * m[10] * m[15] - m[5] * m[11] * m[14] - m[9] * m[6] * m[15] + m[9] * m[7] * m[14] + m[13] * m[6] * m[11] - m[13] * m[7] * m[10];
    inv[4] = -m[4] * m[10] * m[15] + m[4] * m[11] * m[14] + m[8] * m[6] * m[15] - m[8] * m[7] * m[14] - m[12] * m[6] * m[11] + m[12] * m[7] * m[10];
    inv[8] = m[4] * m[9] * m[15] - m[4] * m[11] * m[13] - m[8] * m[5] * m[15] + m[8] * m[7] * m[13] + m[12] * m[5] * m[11] - m[12] * m[7] * m[9];
    inv[12] = -m[4] * m[9] * m[14] + m[4] * m[10] * m[13] + m[8] * m[5] * m[14] - m[8] * m[6] * m[13] - m[12] * m[5] * m[10] + m[12] * m[6] * m[9];

    inv[1] = -m[1] * m[10] * m[15] + m[1] * m[11] * m[14] + m[9] * m[2] * m[15] - m[9] * m[3] * m[14] - m[13] * m[2] * m[11] + m[13] * m[3] * m[10];
    inv[5] = m[0] * m[10] * m[15] - m[0] * m[11] * m[14] - m[8] * m[2] * m[15] + m[8] * m[3] * m[14] + m[12] * m[2] * m[11] - m[12] * m[3] * m[10];
    inv[9] = -m[0] * m[9] * m[15] + m[0] * m[11] * m[13] + m[8] * m[1] * m[15] - m[8] * m[3] * m[13] - m[12] * m[1] * m[11] + m[12] * m[3] * m[9];
    inv[13] = m[0] * m[9] * m[14] - m[0] * m[10] * m[13] - m[8] * m[1] * m[14] + m[8] * m[2] * m[13] + m[12] * m[1] * m[10] - m[12] * m[2] * m[9];

    inv[2] = m[1] * m[6] * m[15] - m[1] * m[7] * m[14] - m[5] * m[2] * m[15] + m[5] * m[3] * m[14] + m[13] * m[2] * m[7] - m[13] * m[3] * m[6];
    inv[6] = -m[0] * m[6] * m[15] + m[0] * m[7] * m[14] + m[4] * m[2] * m[15] - m[4] * m[3] * m[14] - m[12] * m[2] * m[7] + m[12] * m[3] * m[6];
    inv[10] = m[0] * m[5] * m[15] - m[0] * m[7] * m[13] - m[4] * m[1] * m[15] + m[4] * m[3] * m[13] + m[12] * m[1] * m[7] - m[12] * m[3] * m[5];
    inv[14] = -m[0] * m[5] * m[14] + m[0] * m[6] * m[13] + m[4] * m[1] * m[14] - m[4] * m[2] * m[13] - m[12] * m[1] * m[6] + m[12] * m[2] * m[5];

    inv[3] = -m[1] * m[6] * m[11] + m[1] * m[7] * m[10] + m[5] * m[2] * m[11] - m[5] * m[3] * m[10] - m[9] * m[2] * m[7] + m[9] * m[3] * m[6];
    inv[7] = m[0] * m[6] * m[11] - m[0] * m[7] * m[10] - m[4] * m[2] * m[11] + m[4] * m[3] * m[10] + m[8] * m[2] * m[7] - m[8] * m[3] * m[6];
    inv[11] = -m[0] * m[5] * m[11] + m[0] * m[7] * m[9] + m[4] * m[1] * m[11] - m[4] * m[3] * m[9] - m[8] * m[1] * m[7] + m[8] * m[3] * m[5];
    inv[15] = m[0] * m[5] * m[10] - m[0] * m[6] * m[9] - m[4] * m[1] * m[10] + m[4] * m[2] * m[9] + m[8] * m[1] * m[6] - m[8] * m[2] * m[5];

    let det = m[0] * inv[0] + m[1] * inv[4] + m[2] * inv[8] + m[3] * inv[12];
    if (Math.abs(det) < 1e-8) {
      throw new Error('Matrix is singular and cannot be inverted.');
    }

    det = 1.0 / det;
    for (let i = 0; i < 16; i++) {
      inv[i] *= det;
    }

    return inv;
  }

  /**
   * Generates a calibrated multi-camera orbital rig around a center target.
   * Produces OpenCV-convention camera-to-world (c2w) matrices and corresponding Nerfstudio matrices.
   */
  public static generateOrbitalCameraRig(options?: {
    target?: [number, number, number];
    radius?: number;
    cameras?: Array<{
      id: number;
      name: string;
      position: [number, number, number];
      target?: [number, number, number];
    }>;
    intrinsics?: NerfstudioIntrinsics;
  }): OrbitalCameraRigItem[] {
    const defaultTarget: [number, number, number] = options?.target ?? [0.0, 1.0, 0.0];
    const defaultRadius = options?.radius ?? 2.4;
    const defaultIntrinsics: NerfstudioIntrinsics = options?.intrinsics ?? {
      fx: 2484,
      fy: 2484,
      cx: 1080,
      cy: 1920,
      width: 2160,
      height: 3840
    };

    const cameraConfigs = options?.cameras ?? [
      { id: 0, name: 'Cam 0 (Hero Front 0°)', position: [0.0, 1.25, defaultRadius] as [number, number, number] },
      { id: 1, name: 'Cam 1 (Left 45° Lateral)', position: [-1.7, 1.35, 1.7] as [number, number, number] },
      { id: 2, name: 'Cam 2 (Right 45° Lateral)', position: [1.7, 1.35, 1.7] as [number, number, number] },
      { id: 3, name: 'Cam 3 (Rear 180° Survey)', position: [0.0, 1.4, -defaultRadius] as [number, number, number] },
    ];

    const rig: OrbitalCameraRigItem[] = [];

    for (const cfg of cameraConfigs) {
      const target = cfg.target ?? defaultTarget;
      const pos = cfg.position;

      // Forward vector from camera to target (OpenCV +Z is forward along optical axis)
      const fx = target[0] - pos[0];
      const fy = target[1] - pos[1];
      const fz = target[2] - pos[2];
      const fDist = Math.sqrt(fx * fx + fy * fy + fz * fz) || 1.0;
      const zCam = [fx / fDist, fy / fDist, fz / fDist];

      // World Up = [0, 1, 0].
      // Camera Right = forward x worldUp = [ -zCam[2], 0, zCam[0] ]
      let rx = -zCam[2];
      let ry = 0.0;
      let rz = zCam[0];
      const rDist = Math.sqrt(rx * rx + rz * rz);
      if (rDist < 1e-6) {
        rx = 1.0;
        rz = 0.0;
      } else {
        rx /= rDist;
        rz /= rDist;
      }
      const xCam = [rx, ry, rz];

      // Camera Down = zCam x xCam (OpenCV +Y is down)
      const yCam = [
        zCam[1] * xCam[2] - zCam[2] * xCam[1],
        zCam[2] * xCam[0] - zCam[0] * xCam[2],
        zCam[0] * xCam[1] - zCam[1] * xCam[0]
      ];

      // OpenCV c2w matrix (row-major 16 numbers)
      const c2wOpenCV = [
        xCam[0], yCam[0], zCam[0], pos[0],
        xCam[1], yCam[1], zCam[1], pos[1],
        xCam[2], yCam[2], zCam[2], pos[2],
        0.0,     0.0,     0.0,     1.0
      ];

      const w2cOpenCV = NerfstudioDatasetService.invertMatrix4(c2wOpenCV);
      const c2wNerfstudio = NerfstudioDatasetService.convertCameraMatrixConvention(c2wOpenCV);

      rig.push({
        cameraId: cfg.id,
        name: cfg.name,
        position: pos,
        target,
        c2wMatrix: c2wOpenCV,
        w2cMatrix: w2cOpenCV,
        c2wNerfstudio,
        intrinsics: defaultIntrinsics
      });
    }

    return rig;
  }

  /**
   * Projects and rasterizes 3D point cloud onto a camera view to synthesize
   * multi-view foreground masks and RGB image buffers.
   */
  public static rasterizePointsToObservation(
    points: Array<{ position: [number, number, number]; color: [number, number, number] }>,
    camera: { w2cMatrix: number[]; intrinsics: NerfstudioIntrinsics },
    options?: { splatRadius?: number; outputWidth?: number; outputHeight?: number }
  ): { maskBuffer: Buffer; imageBuffer: Buffer } {
    const targetW = options?.outputWidth ?? Math.min(camera.intrinsics.width, 540);
    const targetH = options?.outputHeight ?? Math.min(camera.intrinsics.height, 960);
    const scaleX = targetW / camera.intrinsics.width;
    const scaleY = targetH / camera.intrinsics.height;

    const fx = camera.intrinsics.fx * scaleX;
    const fy = camera.intrinsics.fy * scaleY;
    const cx = camera.intrinsics.cx * scaleX;
    const cy = camera.intrinsics.cy * scaleY;
    const w2c = camera.w2cMatrix;
    const radius = Math.max(1, options?.splatRadius ?? 3);

    const maskBuffer = Buffer.alloc(targetW * targetH, 0);
    const imageBuffer = Buffer.alloc(targetW * targetH * 3, 0);

    for (const pt of points) {
      const [x, y, z] = pt.position;
      const xc = w2c[0] * x + w2c[1] * y + w2c[2] * z + w2c[3];
      const yc = w2c[4] * x + w2c[5] * y + w2c[6] * z + w2c[7];
      const zc = w2c[8] * x + w2c[9] * y + w2c[10] * z + w2c[11];

      if (zc <= 0.05) continue;

      const u = Math.round(fx * (xc / zc) + cx);
      const v = Math.round(fy * (yc / zc) + cy);

      const rVal = Math.round(Math.max(0, Math.min(1, pt.color[0])) * 255);
      const gVal = Math.round(Math.max(0, Math.min(1, pt.color[1])) * 255);
      const bVal = Math.round(Math.max(0, Math.min(1, pt.color[2])) * 255);

      for (let dy = -radius; dy <= radius; dy++) {
        const py = v + dy;
        if (py < 0 || py >= targetH) continue;
        for (let dx = -radius; dx <= radius; dx++) {
          const px = u + dx;
          if (px < 0 || px >= targetW) continue;
          if (dx * dx + dy * dy <= radius * radius) {
            const idx = py * targetW + px;
            maskBuffer[idx] = 255;
            const rgbIdx = idx * 3;
            imageBuffer[rgbIdx] = rVal;
            imageBuffer[rgbIdx + 1] = gVal;
            imageBuffer[rgbIdx + 2] = bVal;
          }
        }
      }
    }

    return { maskBuffer, imageBuffer };
  }

  /**
   * Binarizes an alpha or grayscale mask buffer with a strict threshold (>= 128).
   * Essential for Nerfstudio which casts masks directly to boolean.
   */
  public static binarizeMask(maskBuffer: Buffer, threshold: number = NERFSTUDIO_MASK_THRESHOLD): Buffer {
    const output = Buffer.alloc(maskBuffer.length);
    for (let i = 0; i < maskBuffer.length; i++) {
      output[i] = maskBuffer[i] >= threshold ? 255 : 0;
    }
    return output;
  }

  /**
   * Generates a standard Nerfstudio sparse_pcd.ply file.
   */
  public static serializeSparsePcdPly(
    points: Array<{
      position: [number, number, number];
      normal?: [number, number, number];
      color: [number, number, number];
    }>
  ): string {
    const lines: string[] = [
      'ply',
      'format ascii 1.0',
      `element vertex ${points.length}`,
      'property float x',
      'property float y',
      'property float z',
      'property float nx',
      'property float ny',
      'property float nz',
      'property uchar red',
      'property uchar green',
      'property uchar blue',
      'end_header',
    ];

    for (const pt of points) {
      const [x, y, z] = pt.position;
      const [nx, ny, nz] = pt.normal ?? [0.0, 1.0, 0.0];
      const r = Math.max(0, Math.min(255, Math.round(pt.color[0] * 255)));
      const g = Math.max(0, Math.min(255, Math.round(pt.color[1] * 255)));
      const b = Math.max(0, Math.min(255, Math.round(pt.color[2] * 255)));
      lines.push(`${x.toFixed(5)} ${y.toFixed(5)} ${z.toFixed(5)} ${nx.toFixed(4)} ${ny.toFixed(4)} ${nz.toFixed(4)} ${r} ${g} ${b}`);
    }

    return lines.join('\n') + '\n';
  }

  /**
   * Carves a visual hull point cloud from multi-view camera masks and RGB pixels.
   * Directly solves the cold-start problem without requiring COLMAP SfM.
   */
  public static carveVisualHull(
    cameras: CameraObservationInput[],
    options?: {
      center?: [number, number, number];
      halfExtent?: number;
      voxelSize?: number;
      minForegroundViews?: number;
      maskThreshold?: number;
      maxPoints?: number;
    }
  ): Array<{
    position: [number, number, number];
    normal?: [number, number, number];
    color: [number, number, number];
  }> {
    const center = options?.center ?? [0.0, 0.9, 0.0];
    const halfExtent = options?.halfExtent ?? 1.25; // 2.5m cube
    const voxelSize = options?.voxelSize ?? 0.04; // 4cm default for fast TS execution
    const minViews = Math.max(1, options?.minForegroundViews ?? 2);
    const threshold = options?.maskThreshold ?? NERFSTUDIO_MASK_THRESHOLD;
    const maxPoints = options?.maxPoints ?? 150000;

    const points: Array<{
      position: [number, number, number];
      normal?: [number, number, number];
      color: [number, number, number];
    }> = [];

    // Pre-calculate world-to-camera matrices for all valid cameras
    interface PreparedCam {
      w2c: number[];
      fx: number;
      fy: number;
      cx: number;
      cy: number;
      w: number;
      h: number;
      mask?: Buffer | Uint8Array;
      rgb?: Buffer | Uint8Array;
    }

    const preparedCams: PreparedCam[] = [];

    for (const cam of cameras) {
      let w2c: number[] | undefined = cam.w2cMatrix;
      if (!w2c && cam.c2wMatrix) {
        w2c = this.invertMatrix4(cam.c2wMatrix);
      }
      if (!w2c) continue;

      let maskBuf = cam.maskBuffer;
      if (!maskBuf && cam.maskPath && fs.existsSync(cam.maskPath)) {
        try {
          maskBuf = fs.readFileSync(cam.maskPath);
        } catch {
          // ignore read error
        }
      }

      let imgBuf = cam.imageBuffer;
      if (!imgBuf && cam.imagePath && fs.existsSync(cam.imagePath)) {
        try {
          imgBuf = fs.readFileSync(cam.imagePath);
        } catch {
          // ignore read error
        }
      }

      let w = cam.intrinsics?.width ?? 1920;
      let h = cam.intrinsics?.height ?? 1080;
      let processedMask: Buffer | Uint8Array | undefined = maskBuf;
      let processedRgb: Buffer | Uint8Array | undefined = imgBuf;

      if (maskBuf && maskBuf.length > 8 && maskBuf[0] === 0x89 && maskBuf[1] === 0x50 && maskBuf[2] === 0x4E && maskBuf[3] === 0x47) {
        try {
          const decoded = decodePng(maskBuf);
          w = decoded.width;
          h = decoded.height;
          const gray = Buffer.alloc(w * h);
          for (let p = 0; p < w * h; p++) {
            gray[p] = decoded.rgba[p * 4];
          }
          processedMask = gray;
        } catch {
          // ignore decode error
        }
      }

      if (imgBuf && imgBuf.length > 8 && imgBuf[0] === 0x89 && imgBuf[1] === 0x50 && imgBuf[2] === 0x4E && imgBuf[3] === 0x47) {
        try {
          const decoded = decodePng(imgBuf);
          const rgb = Buffer.alloc(decoded.width * decoded.height * 3);
          for (let p = 0; p < decoded.width * decoded.height; p++) {
            rgb[p * 3] = decoded.rgba[p * 4];
            rgb[p * 3 + 1] = decoded.rgba[p * 4 + 1];
            rgb[p * 3 + 2] = decoded.rgba[p * 4 + 2];
          }
          processedRgb = rgb;
        } catch {
          // ignore decode error
        }
      }

      const fx = cam.intrinsics?.fx ?? 2484;
      const fy = cam.intrinsics?.fy ?? 2484;
      const cx = cam.intrinsics?.cx ?? (cam.intrinsics?.width ? cam.intrinsics.width / 2 : w / 2);
      const cy = cam.intrinsics?.cy ?? (cam.intrinsics?.height ? cam.intrinsics.height / 2 : h / 2);

      preparedCams.push({
        w2c,
        fx,
        fy,
        cx,
        cy,
        w,
        h,
        mask: processedMask,
        rgb: processedRgb,
      });
    }

    if (preparedCams.length === 0) return points;

    const minX = center[0] - halfExtent;
    const maxX = center[0] + halfExtent;
    const minY = center[1] - halfExtent;
    const maxY = center[1] + halfExtent;
    const minZ = center[2] - halfExtent;
    const maxZ = center[2] + halfExtent;

    for (let z = minZ; z <= maxZ; z += voxelSize) {
      for (let y = minY; y <= maxY; y += voxelSize) {
        for (let x = minX; x <= maxX; x += voxelSize) {
          if (points.length >= maxPoints) return points;

          let fgCount = 0;
          let rgbSamples = 0;
          let sumR = 0;
          let sumG = 0;
          let sumB = 0;

          for (const cam of preparedCams) {
            // w2c transform
            const xc = cam.w2c[0] * x + cam.w2c[1] * y + cam.w2c[2] * z + cam.w2c[3];
            const yc = cam.w2c[4] * x + cam.w2c[5] * y + cam.w2c[6] * z + cam.w2c[7];
            const zc = cam.w2c[8] * x + cam.w2c[9] * y + cam.w2c[10] * z + cam.w2c[11];

            if (zc <= 0.05) continue;

            const u = Math.round(cam.fx * (xc / zc) + cam.cx);
            const v = Math.round(cam.fy * (yc / zc) + cam.cy);

            if (u < 0 || u >= cam.w || v < 0 || v >= cam.h) continue;

            if (cam.mask) {
              const pixelIdx = v * cam.w + u;
              if (pixelIdx < cam.mask.length && cam.mask[pixelIdx] >= threshold) {
                fgCount++;
                if (cam.rgb) {
                  const rgbIdx = pixelIdx * 3;
                  if (rgbIdx + 2 < cam.rgb.length) {
                    sumR += cam.rgb[rgbIdx];
                    sumG += cam.rgb[rgbIdx + 1];
                    sumB += cam.rgb[rgbIdx + 2];
                    rgbSamples++;
                  }
                }
              }
            } else {
              // Without mask, consider in-frustum
              fgCount++;
            }
          }

          if (fgCount >= minViews) {
            let r = 0.72;
            let g = 0.72;
            let b = 0.72;
            if (rgbSamples > 0) {
              r = Math.min(1.0, Math.max(0.0, (sumR / rgbSamples) / 255.0));
              g = Math.min(1.0, Math.max(0.0, (sumG / rgbSamples) / 255.0));
              b = Math.min(1.0, Math.max(0.0, (sumB / rgbSamples) / 255.0));
            }

            points.push({
              position: [x, y, z],
              normal: [0.0, 1.0, 0.0],
              color: [r, g, b],
            });
          }
        }
      }
    }

    return points;
  }

  /**
   * Exports a multi-view dataset conforming to Nerfstudio standards.
   */
  public async exportDataset(options: ExportNerfstudioOptions): Promise<ExportNerfstudioResult> {
    const {
      outputDir,
      cameraRig,
      defaultIntrinsics,
      distortion,
      maskThreshold = NERFSTUDIO_MASK_THRESHOLD,
    } = options;

    const warnings: string[] = [];

    // Ensure output directories exist
    const imagesDir = path.join(outputDir, 'images');
    const masksDir = path.join(outputDir, 'masks');
    fs.mkdirSync(imagesDir, { recursive: true });
    fs.mkdirSync(masksDir, { recursive: true });

    // Synthesize observations for any cameras lacking buffers/paths if sparsePoints is provided
    if (options.sparsePoints && options.sparsePoints.length > 0) {
      for (const cam of cameraRig) {
        if (!cam.imageBuffer && (!cam.imagePath || !fs.existsSync(cam.imagePath))) {
          let w2c = cam.w2cMatrix;
          if (!w2c && cam.c2wMatrix) {
            w2c = NerfstudioDatasetService.invertMatrix4(cam.c2wMatrix);
          }
          if (w2c) {
            const camIntrinsics = cam.intrinsics || defaultIntrinsics;
            const rasterW = Math.min(camIntrinsics.width, 540);
            const rasterH = Math.min(camIntrinsics.height, 960);
            const syn = NerfstudioDatasetService.rasterizePointsToObservation(
              options.sparsePoints,
              { w2cMatrix: w2c, intrinsics: camIntrinsics },
              { outputWidth: rasterW, outputHeight: rasterH, splatRadius: 4 }
            );
            cam.maskBuffer = syn.maskBuffer;
            cam.imageBuffer = syn.imageBuffer;
            cam.intrinsics = {
              ...defaultIntrinsics,
              width: rasterW,
              height: rasterH,
              fx: defaultIntrinsics.fx * (rasterW / defaultIntrinsics.width),
              fy: defaultIntrinsics.fy * (rasterH / defaultIntrinsics.height),
              cx: defaultIntrinsics.cx * (rasterW / defaultIntrinsics.width),
              cy: defaultIntrinsics.cy * (rasterH / defaultIntrinsics.height),
            };
          }
        }
      }
    }

    const frames: NerfstudioFrame[] = [];

    for (let i = 0; i < cameraRig.length; i++) {
      const cam = cameraRig[i];
      const frameIdxStr = String(i).padStart(2, '0');

      // Resolve camera-to-world (c2w) matrix in OpenCV space
      let c2wOpenCV: number[];
      if (cam.c2wMatrix) {
        c2wOpenCV = cam.c2wMatrix;
      } else if (cam.w2cMatrix) {
        c2wOpenCV = NerfstudioDatasetService.invertMatrix4(cam.w2cMatrix);
      } else {
        // Fallback: identity
        c2wOpenCV = [
          1, 0, 0, 0,
          0, 1, 0, 0,
          0, 0, 1, 0,
          0, 0, 0, 1,
        ];
        warnings.push(`Camera ${cam.cameraId} has no extrinsic matrices; using identity.`);
      }

      // Convert OpenCV c2w to Nerfstudio/OpenGL c2w
      const c2wNerfstudio = NerfstudioDatasetService.convertCameraMatrixConvention(c2wOpenCV);

      // Handle image writing / copying
      const imageRelPath = `images/${frameIdxStr}.png`;
      const imageDestPath = path.join(outputDir, imageRelPath);

      const curWidth = cam.intrinsics?.width ?? defaultIntrinsics.width;
      const curHeight = cam.intrinsics?.height ?? defaultIntrinsics.height;

      if (cam.imageBuffer) {
        let bufToWrite = cam.imageBuffer;
        if (bufToWrite.length === curWidth * curHeight * 3) {
          const rgba = Buffer.alloc(curWidth * curHeight * 4);
          for (let p = 0; p < curWidth * curHeight; p++) {
            rgba[p * 4] = bufToWrite[p * 3];
            rgba[p * 4 + 1] = bufToWrite[p * 3 + 1];
            rgba[p * 4 + 2] = bufToWrite[p * 3 + 2];
            rgba[p * 4 + 3] = 255;
          }
          bufToWrite = HeadlessMeshSilhouetteRenderer.encodePng(curWidth, curHeight, rgba);
        } else if (bufToWrite.length === curWidth * curHeight * 4) {
          bufToWrite = HeadlessMeshSilhouetteRenderer.encodePng(curWidth, curHeight, bufToWrite);
        }
        fs.writeFileSync(imageDestPath, bufToWrite);
      } else if (cam.imagePath && fs.existsSync(cam.imagePath)) {
        fs.copyFileSync(cam.imagePath, imageDestPath);
      } else {
        // Create 1x1 placeholder
        warnings.push(`No image buffer or file found for frame ${i}; creating empty image.`);
        fs.writeFileSync(imageDestPath, Buffer.from([]));
      }

      // Handle mask writing
      let maskRelPath: string | undefined;
      if (cam.maskBuffer || (cam.maskPath && fs.existsSync(cam.maskPath))) {
        maskRelPath = `masks/${frameIdxStr}.png`;
        const maskDestPath = path.join(outputDir, maskRelPath);

        let rawMask: Buffer;
        if (cam.maskBuffer) {
          rawMask = cam.maskBuffer;
        } else {
          rawMask = fs.readFileSync(cam.maskPath!);
        }

        const binarizedMask = NerfstudioDatasetService.binarizeMask(rawMask, maskThreshold);
        let maskToWrite = binarizedMask;
        if (binarizedMask.length === curWidth * curHeight) {
          const rgba = Buffer.alloc(curWidth * curHeight * 4);
          for (let p = 0; p < curWidth * curHeight; p++) {
            const m = binarizedMask[p];
            rgba[p * 4] = m;
            rgba[p * 4 + 1] = m;
            rgba[p * 4 + 2] = m;
            rgba[p * 4 + 3] = 255;
          }
          maskToWrite = HeadlessMeshSilhouetteRenderer.encodePng(curWidth, curHeight, rgba);
        }
        fs.writeFileSync(maskDestPath, maskToWrite);
      }

      const frame: NerfstudioFrame = {
        file_path: imageRelPath,
        transform_matrix: c2wNerfstudio,
      };

      if (maskRelPath) {
        frame.mask_path = maskRelPath;
      }

      if (cam.intrinsics) {
        frame.fl_x = cam.intrinsics.fx;
        frame.fl_y = cam.intrinsics.fy;
        frame.cx = cam.intrinsics.cx;
        frame.cy = cam.intrinsics.cy;
        frame.w = cam.intrinsics.width;
        frame.h = cam.intrinsics.height;
      }

      frames.push(frame);
    }

    // Build root transforms.json object
    const transforms: NerfstudioTransforms = {
      camera_model: 'OPENCV',
      fl_x: defaultIntrinsics.fx,
      fl_y: defaultIntrinsics.fy,
      cx: defaultIntrinsics.cx,
      cy: defaultIntrinsics.cy,
      w: defaultIntrinsics.width,
      h: defaultIntrinsics.height,
      k1: distortion?.k1 ?? 0.0,
      k2: distortion?.k2 ?? 0.0,
      p1: distortion?.p1 ?? 0.0,
      p2: distortion?.p2 ?? 0.0,
      frames,
    };

    const transformsPath = path.join(outputDir, 'transforms.json');
    fs.writeFileSync(transformsPath, JSON.stringify(transforms, null, 2), 'utf-8');

    // Handle point cloud initialization (visual-hull or supplied points)
    let sparsePcdPath: string | undefined;
    let sparsePointCount = 0;

    let points = options.sparsePoints;

    if (!points && options.carveVisualHull) {
      points = NerfstudioDatasetService.carveVisualHull(cameraRig, options.visualHullOptions);
    }

    if (points && points.length > 0) {
      sparsePcdPath = path.join(outputDir, 'sparse_pcd.ply');
      const plyContent = NerfstudioDatasetService.serializeSparsePcdPly(points);
      fs.writeFileSync(sparsePcdPath, plyContent, 'utf-8');
      sparsePointCount = points.length;
    }

    return {
      success: true,
      outputDir,
      transformsPath,
      sparsePcdPath,
      frameCount: frames.length,
      sparsePointCount,
      warnings: warnings.length > 0 ? warnings : undefined,
    };
  }

  /**
   * Ingests a Nerfstudio dataset folder and parses transforms.json into Scratchbox camera trajectory.
   */
  public static importDataset(outputDir: string): {
    transforms: NerfstudioTransforms;
    cameraRig: CameraObservationInput[];
  } {
    const transformsPath = path.join(outputDir, 'transforms.json');
    if (!fs.existsSync(transformsPath)) {
      throw new Error(`transforms.json not found in ${outputDir}`);
    }

    const content = fs.readFileSync(transformsPath, 'utf-8');
    const transforms: NerfstudioTransforms = JSON.parse(content);

    const cameraRig: CameraObservationInput[] = [];

    for (let i = 0; i < transforms.frames.length; i++) {
      const frame = transforms.frames[i];

      // Convert Nerfstudio/OpenGL c2w matrix back to OpenCV c2w matrix
      const c2wOpenCV2D = NerfstudioDatasetService.convertCameraMatrixConvention(frame.transform_matrix);
      const c2wOpenCV = c2wOpenCV2D.flat();
      const w2cOpenCV = NerfstudioDatasetService.invertMatrix4(c2wOpenCV);

      const imageAbsPath = path.join(outputDir, frame.file_path);
      const maskAbsPath = frame.mask_path ? path.join(outputDir, frame.mask_path) : undefined;

      cameraRig.push({
        cameraId: i,
        imagePath: fs.existsSync(imageAbsPath) ? imageAbsPath : undefined,
        maskPath: maskAbsPath && fs.existsSync(maskAbsPath) ? maskAbsPath : undefined,
        c2wMatrix: c2wOpenCV,
        w2cMatrix: w2cOpenCV,
        intrinsics: {
          fx: frame.fl_x ?? transforms.fl_x,
          fy: frame.fl_y ?? transforms.fl_y,
          cx: frame.cx ?? transforms.cx,
          cy: frame.cy ?? transforms.cy,
          width: frame.w ?? transforms.w,
          height: frame.h ?? transforms.h,
        },
      });
    }

    return {
      transforms,
      cameraRig,
    };
  }
}
