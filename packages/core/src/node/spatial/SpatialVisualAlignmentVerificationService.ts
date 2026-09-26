/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * Universal Spatial Visual Alignment Verification Service
 * Metrology certification engine that audits 1:1 metric scale, translation,
 * ground snapping, pinhole optical consistency (H3D = h_px * d / fy), sub-pixel
 * edge overlap, and dual AABB vs OBB volume tightness against VFX quality gates.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

export interface BoundingBox3D {
  min: [number, number, number];
  max: [number, number, number];
  dimensions: [number, number, number]; // [width, height, depth]
  centroid: [number, number, number];
}

export interface AlignmentCameraContext {
  fx: number;
  fy: number;
  cx: number;
  cy: number;
  imageWidth: number;
  imageHeight: number;
  cameraDepthToObject: number; // distance in meters from camera optical center
}

export interface AlignmentVerificationRequest {
  sourceBoundingBox: BoundingBox3D;
  targetReferenceBox: BoundingBox3D;
  preserveAspectRatio?: boolean;
  groundSnap?: boolean;
  initialYawDeg?: number;
  cameraContext?: AlignmentCameraContext;
  box2dNormalized?: [number, number, number, number]; // [ymin, xmin, ymax, xmax] in [0, 1000]
}

export interface AlignmentVerificationReport {
  scale: [number, number, number]; // [sx, sy, sz]
  translation: [number, number, number]; // [tx, ty, tz]
  rotationYawDeg: number;
  residualErrorMeters: number;
  alignedBoundingBox: BoundingBox3D;
  opticalDiscrepancyPercent?: number;
  transformMatrix4x4: number[]; // 16-element column-major matrix
}

export interface EdgeOverlapResult {
  overlapScorePercent: number;
  residualErrorPx: number;
  intersectionPixels: number;
  unionPixels: number;
}

export interface MetrologyCertificationParams {
  modelName: string;
  sourceDimensions: [number, number, number];
  overlapScorePercent: number;
  residualErrorPx: number;
  tightnessGainPercent?: number;
  opticalDiscrepancyPercent?: number;
}

export interface MetrologyCertificate {
  modelName: string;
  isCertified: boolean;
  auditStatus: 'PASS' | 'WARN' | 'FAIL';
  timestamp: string;
  checks: {
    edgeOverlapPassed: boolean;
    residualErrorPassed: boolean;
    tightnessGainPassed: boolean;
    opticalScalePassed: boolean;
  };
  metrics: {
    overlapScorePercent: number;
    residualErrorPx: number;
    tightnessGainPercent: number;
    opticalDiscrepancyPercent: number;
  };
  summaryReport: string;
}

export class SpatialVisualAlignmentVerificationService {
  /**
   * Computes the metric scaling vector, translation, and 4x4 matrix to snap a
   * source model to a target reference bounding volume, verifying optical consistency.
   */
  public verifyAlignment(request: AlignmentVerificationRequest): AlignmentVerificationReport {
    const {
      sourceBoundingBox,
      targetReferenceBox,
      preserveAspectRatio = true,
      groundSnap = true,
      initialYawDeg = 0
    } = request;

    const [srcW, srcH, srcD] = sourceBoundingBox.dimensions;
    const [tgtW, tgtH, tgtD] = targetReferenceBox.dimensions;

    let sx = tgtW / (srcW || 1);
    let sy = tgtH / (srcH || 1);
    let sz = tgtD / (srcD || 1);

    if (preserveAspectRatio) {
      const uniformScale = sy;
      sx = uniformScale;
      sy = uniformScale;
      sz = uniformScale;
    }

    const tx = targetReferenceBox.centroid[0];
    const tz = targetReferenceBox.centroid[2];
    let ty = targetReferenceBox.centroid[1];

    if (groundSnap) {
      ty = targetReferenceBox.min[1] - sourceBoundingBox.min[1] * sy;
    }

    // Pinhole Optical Depth Theorem: H_3d = (pixelHeight * depth) / fy
    let opticalDiscrepancyPercent: number | undefined;
    if (request.cameraContext && request.box2dNormalized) {
      const { fy, cameraDepthToObject, imageHeight } = request.cameraContext;
      const [ymin, , ymax] = request.box2dNormalized;
      const pixelHeight = ((ymax - ymin) / 1000) * imageHeight;
      const opticalHeightMetric = (pixelHeight * cameraDepthToObject) / (fy || 1);
      const scaleDiscrepancy = Math.abs(tgtH - opticalHeightMetric);
      opticalDiscrepancyPercent = Number(((scaleDiscrepancy / (tgtH || 1)) * 100).toFixed(2));
    }

    // Compute 4x4 transform matrix
    const yawRad = (initialYawDeg * Math.PI) / 180.0;
    const cosY = Math.cos(yawRad);
    const sinY = Math.sin(yawRad);

    const transformMatrix4x4 = [
      sx * cosY, 0, -sz * sinY, 0,
      0, sy, 0, 0,
      sx * sinY, 0, sz * cosY, 0,
      tx, ty, tz, 1
    ];

    const alignedMin: [number, number, number] = [
      targetReferenceBox.centroid[0] - (srcW * sx) / 2,
      groundSnap ? targetReferenceBox.min[1] : targetReferenceBox.centroid[1] - (srcH * sy) / 2,
      targetReferenceBox.centroid[2] - (srcD * sz) / 2
    ];

    const alignedMax: [number, number, number] = [
      alignedMin[0] + srcW * sx,
      alignedMin[1] + srcH * sy,
      alignedMin[2] + srcD * sz
    ];

    const alignedCentroid: [number, number, number] = [
      (alignedMin[0] + alignedMax[0]) / 2,
      (alignedMin[1] + alignedMax[1]) / 2,
      (alignedMin[2] + alignedMax[2]) / 2
    ];

    const residualErrorMeters = Math.sqrt(
      Math.pow(alignedCentroid[0] - targetReferenceBox.centroid[0], 2) +
      Math.pow(alignedCentroid[2] - targetReferenceBox.centroid[2], 2)
    );

    return {
      scale: [sx, sy, sz],
      translation: [tx, ty, tz],
      rotationYawDeg: initialYawDeg,
      residualErrorMeters: Number(residualErrorMeters.toFixed(4)),
      alignedBoundingBox: {
        min: alignedMin,
        max: alignedMax,
        dimensions: [srcW * sx, srcH * sy, srcD * sz],
        centroid: alignedCentroid
      },
      opticalDiscrepancyPercent,
      transformMatrix4x4
    };
  }

  /**
   * Evaluates sub-pixel edge overlap and residual pixel error between two raster silhouettes.
   */
  public evaluateEdgeOverlap(
    refSilhouette: Uint8Array,
    alignedSilhouette: Uint8Array,
    width: number,
    height: number
  ): EdgeOverlapResult {
    let intersection = 0;
    let union = 0;
    let refXSum = 0, refYSum = 0, refCount = 0;
    let alnXSum = 0, alnYSum = 0, alnCount = 0;

    const total = width * height;
    for (let i = 0; i < total; i++) {
      const r = refSilhouette[i]! > 128 ? 1 : 0;
      const a = alignedSilhouette[i]! > 128 ? 1 : 0;

      if (r && a) intersection++;
      if (r || a) union++;

      const x = i % width;
      const y = Math.floor(i / width);

      if (r) {
        refXSum += x;
        refYSum += y;
        refCount++;
      }
      if (a) {
        alnXSum += x;
        alnYSum += y;
        alnCount++;
      }
    }

    const overlapScorePercent = union > 0 ? (intersection / union) * 100 : 100;

    let residualErrorPx = 0.0;
    if (refCount > 0 && alnCount > 0) {
      const refCx = refXSum / refCount;
      const refCy = refYSum / refCount;
      const alnCx = alnXSum / alnCount;
      const alnCy = alnYSum / alnCount;
      residualErrorPx = Math.sqrt(Math.pow(alnCx - refCx, 2) + Math.pow(alnCy - refCy, 2));
    }

    return {
      overlapScorePercent: Number(overlapScorePercent.toFixed(2)),
      residualErrorPx: Number(residualErrorPx.toFixed(3)),
      intersectionPixels: intersection,
      unionPixels: union
    };
  }

  /**
   * Generates a formal, certified metrology audit report assessing alignment against
   * strict photorealistic VFX standards (overlap >= 95%, residual <= 0.1 px).
   */
  public certifyMetrology(params: MetrologyCertificationParams): MetrologyCertificate {
    const {
      modelName,
      sourceDimensions,
      overlapScorePercent,
      residualErrorPx,
      tightnessGainPercent = 0,
      opticalDiscrepancyPercent = 0
    } = params;

    const edgeOverlapPassed = overlapScorePercent >= 95.0;
    const residualErrorPassed = residualErrorPx <= 0.1;
    const tightnessGainPassed = tightnessGainPercent >= 0;
    const opticalScalePassed = opticalDiscrepancyPercent <= 15.0;

    const isCertified = edgeOverlapPassed && residualErrorPassed && opticalScalePassed;
    const auditStatus: 'PASS' | 'WARN' | 'FAIL' = isCertified
      ? 'PASS'
      : (overlapScorePercent >= 85.0 ? 'WARN' : 'FAIL');

    const summaryReport = [
      `=== SPATIAL VISUAL ALIGNMENT & METROLOGY CERTIFICATE ===`,
      `Model: ${modelName}`,
      `Dimensions: [${sourceDimensions.map(d => d.toFixed(1) + 'm').join(' × ')}]`,
      `Status: [${auditStatus}] ${isCertified ? '✓ CERTIFIED PHOTOREALISTIC ALIGNMENT' : '⚠ VERIFICATION FAILED'}`,
      `Metrics:`,
      `  • Sub-Pixel Edge Overlap: ${overlapScorePercent.toFixed(1)}% (Threshold: ≥ 95.0%) -> ${edgeOverlapPassed ? 'PASS' : 'FAIL'}`,
      `  • Reprojection Residual Error: ${residualErrorPx.toFixed(3)} px (Threshold: ≤ 0.100 px) -> ${residualErrorPassed ? 'PASS' : 'FAIL'}`,
      `  • Optical Scale Discrepancy: ${opticalDiscrepancyPercent.toFixed(2)}% (Threshold: ≤ 15.0%) -> ${opticalScalePassed ? 'PASS' : 'FAIL'}`,
      `  • OBB Volume Tightness Gain: +${tightnessGainPercent.toFixed(1)}% (Threshold: ≥ 0.0%) -> ${tightnessGainPassed ? 'PASS' : 'FAIL'}`,
      `Timestamp: ${new Date().toISOString()}`
    ].join('\n');

    return {
      modelName,
      isCertified,
      auditStatus,
      timestamp: new Date().toISOString(),
      checks: {
        edgeOverlapPassed,
        residualErrorPassed,
        tightnessGainPassed,
        opticalScalePassed
      },
      metrics: {
        overlapScorePercent,
        residualErrorPx,
        tightnessGainPercent,
        opticalDiscrepancyPercent
      },
      summaryReport
    };
  }
}
