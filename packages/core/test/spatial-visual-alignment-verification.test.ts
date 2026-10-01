/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import { describe, it, expect } from 'vitest';
import * as path from 'path';
import {
  SpatialVisualAlignmentVerificationService,
  type AlignmentVerificationRequest,
  type AlignmentVerificationReport
} from '../src/node/spatial/SpatialVisualAlignmentVerificationService';

describe('SpatialVisualAlignmentVerificationService (Universal Visual Alignment & Metrology)', () => {
  it('verifies 1:1 metric scale, translation, and ground snapping against 3D bounding geometry', () => {
    const service = new SpatialVisualAlignmentVerificationService();

    const request: AlignmentVerificationRequest = {
      sourceBoundingBox: {
        min: [-10, 0, -5],
        max: [10, 20, 5],
        dimensions: [20, 20, 10],
        centroid: [0, 10, 0]
      },
      targetReferenceBox: {
        min: [-50, 15, -25],
        max: [50, 65, 25],
        dimensions: [100, 50, 50],
        centroid: [0, 40, 0]
      },
      groundSnap: true,
      preserveAspectRatio: true
    };

    const report: AlignmentVerificationReport = service.verifyAlignment(request);

    expect(report).toBeDefined();
    expect(report.scale[1]).toBeCloseTo(2.5, 2); // 50m / 20m = 2.5
    expect(report.scale[0]).toBeCloseTo(2.5, 2); // aspect preserved
    expect(report.scale[2]).toBeCloseTo(2.5, 2);

    // Ground snapped: target.min.y is 15
    expect(report.alignedBoundingBox.min[1]).toBeCloseTo(15.0, 1);
    expect(report.alignedBoundingBox.centroid[0]).toBeCloseTo(0.0, 1);
    expect(report.alignedBoundingBox.centroid[2]).toBeCloseTo(0.0, 1);
    expect(report.transformMatrix4x4.length).toBe(16);
  });

  it('verifies optical pinhole depth consistency (H_3d = h_px * d / fy)', () => {
    const service = new SpatialVisualAlignmentVerificationService();

    const request: AlignmentVerificationRequest = {
      sourceBoundingBox: {
        min: [-1, 0, -1],
        max: [1, 21, 1],
        dimensions: [2, 21, 2],
        centroid: [0, 10.5, 0]
      },
      targetReferenceBox: {
        min: [-12, 0, -4],
        max: [13.7, 21, 3.4],
        dimensions: [25.7, 21.0, 7.4],
        centroid: [0.85, 10.5, -0.3]
      },
      cameraContext: {
        fx: 1866.66,
        fy: 1866.66,
        cx: 960,
        cy: 540,
        imageWidth: 1920,
        imageHeight: 1080,
        cameraDepthToObject: 147.5 // meters
      },
      box2dNormalized: [530, 530, 720, 645] // height in px: (720-530)/1000 * 1080 = 205.2 px
    };

    const report = service.verifyAlignment(request);

    // Optical height = 205.2 * 147.5 / 1866.66 = ~16.2m vs 21.0m target -> discrepancy check is calculated
    expect(report.opticalDiscrepancyPercent).toBeDefined();
    expect(report.opticalDiscrepancyPercent).toBeGreaterThanOrEqual(0);
    expect(report.opticalDiscrepancyPercent).toBeLessThan(40);
  });

  it('evaluates sub-pixel edge overlap and generates certified metrology audit', () => {
    const service = new SpatialVisualAlignmentVerificationService();

    // Create 32x32 test silhouette buffers
    const width = 32;
    const height = 32;
    const refBuffer = new Uint8Array(width * height);
    const alignedBuffer = new Uint8Array(width * height);

    // Draw a square in center [8..24]
    for (let y = 8; y < 24; y++) {
      for (let x = 8; x < 24; x++) {
        refBuffer[y * width + x] = 255;
        alignedBuffer[y * width + x] = 255; // 100% overlap
      }
    }

    const overlapResult = service.evaluateEdgeOverlap(refBuffer, alignedBuffer, width, height);

    expect(overlapResult.overlapScorePercent).toBeCloseTo(100.0, 1);
    expect(overlapResult.residualErrorPx).toBeLessThan(0.05);

    // Generate comprehensive certified audit report
    const certifiedAudit = service.certifyMetrology({
      modelName: 'ArchOfConstantine_Watertight',
      sourceDimensions: [25.7, 21.0, 7.4],
      overlapScorePercent: overlapResult.overlapScorePercent,
      residualErrorPx: overlapResult.residualErrorPx,
      tightnessGainPercent: 50.9,
      opticalDiscrepancyPercent: 2.1
    });

    expect(certifiedAudit.auditStatus).toBe('PASS');
    expect(certifiedAudit.isCertified).toBe(true);
    expect(certifiedAudit.checks.edgeOverlapPassed).toBe(true);
    expect(certifiedAudit.checks.residualErrorPassed).toBe(true);
    expect(certifiedAudit.summaryReport).toContain('PASS');
  });
});
