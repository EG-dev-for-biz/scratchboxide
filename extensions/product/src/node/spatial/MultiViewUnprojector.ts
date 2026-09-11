/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { Vec3 } from '../../common/coordinate/LocalTangentPlane';

export interface BakedGaussian {
  position: Vec3;                     // Center μ [x, y, z] in local Cartesian meters
  scale: Vec3;                        // Scale / covariance diagonal [sx, sy, sz]
  rotationQuaternion: [number, number, number, number]; // [qx, qy, qz, qw]
  colorRgb: [number, number, number]; // RGB color [0 - 255]
  opacity: number;                    // Alpha opacity [0.0 - 1.0]
}

export class MultiViewUnprojector {
  /**
   * Unprojects a single camera image plate and depth map into 3D Gaussian Splats in the local space.
   * Standard camera conventions:
   *   Camera space coordinate: Z is pointing backward (-Z is looking forward), X is right, Y is up.
   *   K intrinsics = [fx, fy, cx, cy]
   *   extrinsics = row-major 4x4 camera-to-world transform
   */
  public static unprojectPlate(
    rgbaBuffer: Uint8Array,             // Pixel array (Width * Height * 4)
    depthMeters: Float32Array,          // Depth array (Width * Height)
    width: number,
    height: number,
    intrinsics: { fx: number; fy: number; cx: number; cy: number },
    extrinsics: number[],               // 4x4 camera-to-world transformation
    voxelDecimation: number = 4         // Step downsample factor (increase for higher speed)
  ): BakedGaussian[] {
    const splats: BakedGaussian[] = [];

    // Extract 3x3 rotation columns and translation from 4x4 row-major matrix
    const r00 = extrinsics[0], r01 = extrinsics[1], r02 = extrinsics[2], tx = extrinsics[3];
    const r10 = extrinsics[4], r11 = extrinsics[5], r12 = extrinsics[6], ty = extrinsics[7];
    const r20 = extrinsics[8], r21 = extrinsics[9], r22 = extrinsics[10], tz = extrinsics[11];

    for (let v = 0; v < height; v += voxelDecimation) {
      for (let u = 0; u < width; u += voxelDecimation) {
        const idx = v * width + u;
        const d = depthMeters[idx];

        // Skip background sky or zero/invalid values
        if (!d || isNaN(d) || d <= 0.1 || d > 250.0) continue;

        // 1. Camera space coordinate
        // (X_c / d) = (u - cx) / fx => X_c = (u - cx) / fx * d
        const xc = ((u - intrinsics.cx) / intrinsics.fx) * d;
        const yc = ((v - intrinsics.cy) / intrinsics.fy) * d;
        const zc = -d; // standard Three.js viewing direction

        // 2. Transform camera space to World space in Local Tangent Plane
        const xw = r00 * xc + r01 * yc + r02 * zc + tx;
        const yw = r10 * xc + r11 * yc + r12 * zc + ty;
        const zw = r20 * xc + r21 * yc + r22 * zc + tz;

        // 3. Pixel Color Extraction
        const pixelIdx = idx * 4;
        const r = rgbaBuffer[pixelIdx];
        const g = rgbaBuffer[pixelIdx + 1];
        const b = rgbaBuffer[pixelIdx + 2];
        const opacity = rgbaBuffer[pixelIdx + 3] / 255.0;

        // Calculate size proportional to distance to prevent gaps (splat thickness)
        const size = Math.max(0.015, d * 0.005);

        splats.push({
          position: [xw, yw, zw],
          scale: [size, size, size],
          rotationQuaternion: [0, 0, 0, 1], // aligned with coordinate axes
          colorRgb: [r, g, b],
          opacity
        });
      }
    }

    return splats;
  }
}
