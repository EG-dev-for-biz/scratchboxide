/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * Test suite for 3D Bounding Box Technology Comparison:
 * Axis-Aligned Bounding Box (AABB) vs. Ground-Constrained Oriented Bounding Box (OBB)
 * with PCA Covariance Analysis and Gemini 3D Box Spatial Grounding.
 ********************************************************************************/

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  BoundingBoxComparisonService,
  type BoundingBoxComparisonResult,
  type BoundingBoxBenchmarkEntity
} from '../src/node/spatial/BoundingBoxComparisonService';
import { OrientedBoundingBoxSolver } from '../src/node/spatial/OrientedBoundingBoxSolver';

describe('BoundingBoxComparisonService (AABB vs OBB Comparison)', () => {
  it('computes accurate comparative metrology for a synthetic 45-degree rotated cuboid', () => {
    // Generate a rotated cuboid: length 20m, height 6m, depth 4m oriented at 45 degrees
    const theta = Math.PI / 4; // 45 degrees
    const cosT = Math.cos(theta);
    const sinT = Math.sin(theta);
    const vertices: [number, number, number][] = [];

    for (let u = -10; u <= 10; u += 1) {
      for (let y = 0; y <= 6; y += 1) {
        for (let w = -2; w <= 2; w += 1) {
          const x = u * cosT - w * sinT;
          const z = u * sinT + w * cosT;
          vertices.push([x, y, z]);
        }
      }
    }

    const comparison: BoundingBoxComparisonResult = BoundingBoxComparisonService.compareVertices(
      'Synthetic 45° Box Benchmark',
      vertices
    );

    expect(comparison).toBeDefined();
    expect(comparison.entityName).toBe('Synthetic 45° Box Benchmark');
    expect(comparison.vertexCount).toBe(vertices.length);

    // OBB orientation should match 45 degrees
    expect(comparison.obb.yawDeg).toBeCloseTo(45.0, 0);

    // OBB dimensions should reflect local dimensions [20m, 6m, 4m]
    expect(comparison.obb.dimensions[0]).toBeCloseTo(20.0, 0.5);
    expect(comparison.obb.dimensions[1]).toBeCloseTo(6.0, 0.1);
    expect(comparison.obb.dimensions[2]).toBeCloseTo(4.0, 0.5);

    // Theoretical local volume = 20 * 6 * 4 = 480 m³
    expect(comparison.obb.volumeM3).toBeCloseTo(480, 10);

    // AABB at 45 degrees has width & depth ~ (20+4)*sqrt(2)/2 ≈ 17.0m -> Volume ~ 17 * 6 * 17 ≈ 1730 m³
    expect(comparison.aabb.dimensions[0]).toBeGreaterThan(16.0);
    expect(comparison.aabb.dimensions[2]).toBeGreaterThan(16.0);
    expect(comparison.aabb.volumeM3).toBeGreaterThan(1500);

    // Tightness gain should exceed 60%
    expect(comparison.metrology.tightnessGainPercent).toBeGreaterThan(60.0);
    expect(comparison.metrology.volumeReductionPercent).toBeGreaterThan(60.0);
    expect(comparison.metrology.volumeDeltaM3).toBeGreaterThan(1000);
    expect(comparison.metrology.airPenaltyRatio).toBeGreaterThan(2.5);

    // Footprint area comparison
    expect(comparison.metrology.footprint2dAreaOBB).toBeCloseTo(80, 5); // 20 * 4 = 80 m²
    expect(comparison.metrology.footprint2dAreaAABB).toBeGreaterThan(250);
  });

  it('generates 8 canonical corners in 3D world space for both AABB and OBB', () => {
    const vertices: [number, number, number][] = [
      [10, 0, 10],
      [20, 5, 10],
      [10, 0, 30],
      [20, 5, 30]
    ];

    const comparison = BoundingBoxComparisonService.compareVertices('Corner Test Box', vertices);

    expect(comparison.cornersAABB).toHaveLength(8);
    expect(comparison.cornersOBB).toHaveLength(8);

    // All corners must have valid 3D coordinates [x, y, z]
    for (const pt of comparison.cornersAABB) {
      expect(pt).toHaveLength(3);
      expect(Number.isFinite(pt[0])).toBe(true);
      expect(Number.isFinite(pt[1])).toBe(true);
      expect(Number.isFinite(pt[2])).toBe(true);
    }

    for (const pt of comparison.cornersOBB) {
      expect(pt).toHaveLength(3);
      expect(Number.isFinite(pt[0])).toBe(true);
      expect(Number.isFinite(pt[1])).toBe(true);
      expect(Number.isFinite(pt[2])).toBe(true);
    }
  });

  it('compares real-world photogrammetric entities from the Colosseum spatial dataset', () => {
    const archEntity: BoundingBoxBenchmarkEntity = {
      id: 'arch-of-constantine',
      name: 'Arch of Constantine: Central Triumphal Fornix',
      category: 'monument',
      aabb: {
        min: [-144.75, 25.75, -50.04],
        max: [-134.49, 37.25, -40.52],
        dimensions: [10.26, 11.5, 9.52],
        centroid: [-139.62, 31.5, -45.28],
        volumeM3: 1123.82
      },
      obb: {
        center: [-139.62, 31.5, -45.28],
        dimensions: [8.5, 11.5, 7.4],
        halfExtents: [4.25, 5.75, 3.7],
        yawDeg: 16.63,
        yawRad: 0.2902,
        quaternion: [0, 0.1446, 0, 0.9895],
        rotationMatrix3x3: [
          [0.9582, 0, 0.2861],
          [0, 1, 0],
          [-0.2861, 0, 0.9582]
        ],
        volumeM3: 723.35,
        tightnessGainPercent: 35.6
      },
      gemini3DBox: {
        center: [-137.8, 10.5, -49.8],
        size: [25.7, 21.0, 7.4],
        rotationsDeg: [0.0, 49.0, 0.0]
      }
    };

    const comparison = BoundingBoxComparisonService.compareEntity(archEntity);

    expect(comparison.entityName).toContain('Arch of Constantine');
    expect(comparison.metrology.tightnessGainPercent).toBeCloseTo(35.6, 0.5);
    expect(comparison.metrology.volumeDeltaM3).toBeCloseTo(400.47, 1);
    expect(comparison.metrology.airPenaltyRatio).toBeGreaterThan(1.5);
    expect(comparison.obb.yawDeg).toBeCloseTo(16.63, 0.1);
  });

  it('builds a benchmark comparison collection containing diverse architectural and natural entities', () => {
    const benchmarks = BoundingBoxComparisonService.getDefaultBenchmarks();
    expect(benchmarks.length).toBeGreaterThanOrEqual(4);

    const names = benchmarks.map(b => b.name);
    expect(names.some(n => n.includes('Constantine'))).toBe(true);
    expect(names.some(n => n.includes('Colosseum'))).toBe(true);
    expect(names.some(n => n.includes('Pine') || n.includes('Tree'))).toBe(true);
    expect(names.some(n => n.includes('45°') || n.includes('Rotated'))).toBe(true);

    for (const b of benchmarks) {
      const comp = BoundingBoxComparisonService.compareEntity(b);
      expect(comp.metrology.tightnessGainPercent).toBeGreaterThanOrEqual(0);
      expect(comp.cornersAABB).toHaveLength(8);
      expect(comp.cornersOBB).toHaveLength(8);
    }
  });

  it('generates an actionable comparative summary report and verified JSON benchmark artifact', () => {
    const report = BoundingBoxComparisonService.generateComparisonReport();
    expect(report).toContain('3D BOUNDING BOX TECHNOLOGY COMPARISON REPORT');
    expect(report).toContain('AABB (Axis-Aligned)');
    expect(report).toContain('OBB (Ground-Constrained PCA Yaw)');
    expect(report).toContain('Tightness Gain');

    const manifest = BoundingBoxComparisonService.generateBenchmarkManifest();
    expect(manifest.version).toBe('1.0.0');
    expect(manifest.comparisons.length).toBeGreaterThanOrEqual(4);
    expect(manifest.summary.averageTightnessGainPercent).toBeGreaterThan(20);
  });

  it('generates a self-contained interactive HTML/WebGL comparison demo file', () => {
    const html = BoundingBoxComparisonService.generateInteractiveHtmlDemo();
    expect(html).toContain('<!DOCTYPE html>');
    expect(html).toContain('3D Bounding Box Comparison Demo');
    expect(html).toContain('Three.js');
    expect(html).toContain('OrbitControls');
    expect(html).toContain('viewport-aabb');
    expect(html).toContain('viewport-obb');
    expect(html).toContain('Loose AABB (Amber)');
    expect(html).toContain('Tight OBB (Cyan)');
    expect(html).toContain('Air Penalty / Void Space');
    expect(html).toContain('Tightness Gain');

    // Save demo HTML to a temp dir (public/demos/bounding_box_comparison_demo.html is tracked;
    // tests must not rewrite it) and check the written file.
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sbx-bbox-demo-'));
    try {
      const demoPath = path.join(outDir, 'bounding_box_comparison_demo.html');
      fs.writeFileSync(demoPath, html, 'utf8');
      expect(fs.existsSync(demoPath)).toBe(true);
      expect(fs.statSync(demoPath).size).toBeGreaterThan(10 * 1024); // > 10 KB
    } finally {
      fs.rmSync(outDir, { recursive: true, force: true });
    }
  });
});
