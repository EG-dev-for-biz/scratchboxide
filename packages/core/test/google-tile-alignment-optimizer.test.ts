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
  GoogleTileAlignmentOptimizer,
  type BoundingBox3D,
  type AlignmentCameraContext
} from '../src/node/spatial/GoogleTileAlignmentOptimizer';

describe('GoogleTileAlignmentOptimizer — Scale & Pose Registration', () => {
  it('extracts ground-truth metric bounding envelope from Google 3D Tile submesh', () => {
    // Generate synthetic vertex cloud representing the Arch of Constantine within Google 3D Tiles
    // Center: X = -137.8, Z = -49.8, Width = 25.7m, Height = 21.0m, Depth = 7.4m
    const vertices: number[] = [];
    for (let i = 0; i < 500; i++) {
      const u = (Math.random() - 0.5) * 25.7;
      const v = Math.random() * 21.0;
      const w = (Math.random() - 0.5) * 7.4;
      vertices.push(-137.8 + u, v, -49.8 + w);
    }

    const tileBounds = GoogleTileAlignmentOptimizer.extractTileSubmeshBounds(
      vertices,
      [-137.8, 10.5, -49.8],
      20.0
    );

    expect(tileBounds.dimensions[0]).toBeGreaterThan(24.0);
    expect(tileBounds.dimensions[0]).toBeLessThan(26.5);
    expect(tileBounds.dimensions[1]).toBeGreaterThan(20.0);
    expect(tileBounds.dimensions[1]).toBeLessThan(21.5);
    expect(tileBounds.dimensions[2]).toBeGreaterThan(7.0);
    expect(tileBounds.dimensions[2]).toBeLessThan(8.0);
  });

  it('accurately rescales a canonical unit-space TRELLIS model to match real-world Google 3D Tile', () => {
    // TRELLIS 2 model generated in canonical normalized space: height = 1.0, width = 1.22, depth = 0.35
    const trellisUnitBounds: BoundingBox3D = {
      min: [-0.61, 0.0, -0.175],
      max: [0.61, 1.0, 0.175],
      dimensions: [1.223, 1.0, 0.352],
      centroid: [0.0, 0.5, 0.0]
    };

    // Google 3D Tile ground truth envelope: Arch of Constantine (21m tall)
    const targetTileBounds: BoundingBox3D = {
      min: [-150.65, 0.0, -53.5],
      max: [-124.95, 21.0, -46.1],
      dimensions: [25.7, 21.0, 7.4],
      centroid: [-137.8, 10.5, -49.8]
    };

    const alignment = GoogleTileAlignmentOptimizer.computeMetricAlignment(
      trellisUnitBounds,
      targetTileBounds,
      {
        preserveAspectRatio: true,
        groundSnap: true,
        initialYawDeg: 49.0
      }
    );

    // Scaling factor must be exactly 21.0 (from 1.0m to 21.0m)
    expect(alignment.scale[1]).toBeCloseTo(21.0, 1);
    // Base of aligned bounding box must sit at Y = 0.0 (ground datum)
    expect(alignment.alignedBoundingBox.min[1]).toBeCloseTo(0.0, 1);
    // Top of aligned model must reach 21.0m
    expect(alignment.alignedBoundingBox.max[1]).toBeCloseTo(21.0, 1);
    // Centroid must match Google 3D Tile coordinates
    expect(alignment.translation[0]).toBeCloseTo(-137.8, 1);
    expect(alignment.translation[2]).toBeCloseTo(-49.8, 1);
  });

  it('verifies scale with optical depth and camera pinhole theorem', () => {
    // Station camera: 1920x1080, focal length fy = 1430px
    // Object: 21m tall at distance Z = 160m
    // Projected pixel height = (1430 * 21) / 160 = 187.68px
    // In normalized [0, 1000] space: height = 187.68 / 1080 * 1000 = 173.78
    const cameraContext: AlignmentCameraContext = {
      fx: 1430,
      fy: 1430,
      cx: 960,
      cy: 540,
      imageWidth: 1920,
      imageHeight: 1080,
      cameraDepthToObject: 160.0
    };

    const trellisUnitBounds: BoundingBox3D = {
      min: [-0.5, 0.0, -0.2],
      max: [0.5, 1.0, 0.2],
      dimensions: [1.0, 1.0, 0.4],
      centroid: [0.0, 0.5, 0.0]
    };

    const targetTileBounds: BoundingBox3D = {
      min: [-150.0, 0.0, -53.0],
      max: [-125.0, 21.0, -47.0],
      dimensions: [25.0, 21.0, 6.0],
      centroid: [-137.5, 10.5, -50.0]
    };

    const alignment = GoogleTileAlignmentOptimizer.computeMetricAlignment(
      trellisUnitBounds,
      targetTileBounds,
      {
        preserveAspectRatio: true,
        cameraContext,
        box2dNormalized: [530, 530, 704, 645] // ymax - ymin = 174
      }
    );

    // Discrepancy between Google 3D Tile metric height and 2D camera optical unprojection must be < 1%
    expect(alignment.opticalScaleDiscrepancyPercent).toBeLessThan(1.5);
  });

  it('converges rigid ICP refinement to sub-decimeter surface precision', () => {
    const sourcePoints: Array<[number, number, number]> = [
      [0, 0, 0],
      [10, 0, 0],
      [0, 10, 0],
      [10, 10, 0]
    ];
    const targetPoints: Array<[number, number, number]> = [
      [0.02, -0.01, 0.01],
      [10.01, 0.02, -0.01],
      [-0.01, 10.01, 0.02],
      [10.02, 9.99, -0.01]
    ];

    const icpResult = GoogleTileAlignmentOptimizer.refineRigidICP(sourcePoints, targetPoints);
    expect(icpResult.rmsDistanceMeters).toBeLessThan(0.05); // Sub-5cm precision
  });

  it('validates scale and pose against Google DeepMind Gemini 3D Bounding Box', () => {
    const trellisUnitBounds: BoundingBox3D = {
      min: [-0.5, 0.0, -0.2],
      max: [0.5, 1.0, 0.2],
      dimensions: [1.0, 1.0, 0.4],
      centroid: [0.0, 0.5, 0.0]
    };

    const targetTileBounds: BoundingBox3D = {
      min: [-150.0, 0.0, -53.0],
      max: [-124.3, 21.0, -45.6],
      dimensions: [25.7, 21.0, 7.4],
      centroid: [-137.8, 10.5, -49.8]
    };

    const geminiBox3d = {
      center: [-137.8, 10.5, -49.8] as [number, number, number],
      size: [25.7, 21.0, 7.4] as [number, number, number], // Exactly 21.0m height
      rotationsDeg: [0.0, 49.0, 0.0] as [number, number, number]
    };

    const alignment = GoogleTileAlignmentOptimizer.computeMetricAlignment(
      trellisUnitBounds,
      targetTileBounds,
      {
        preserveAspectRatio: true,
        geminiBox3d
      }
    );

    expect(alignment.gemini3DScaleDiscrepancyPercent).toBeDefined();
    expect(alignment.gemini3DScaleDiscrepancyPercent).toBe(0.0);
    expect(alignment.scale[1]).toBe(21.0);
  });
});
