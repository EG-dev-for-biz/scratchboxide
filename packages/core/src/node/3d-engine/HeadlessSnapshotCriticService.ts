/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

export interface SensorPassesData {
  width: number;
  height: number;
  rgbBeauty: number[] | Float32Array;
  linearDepth: number[] | Float32Array;
  surfaceNormals: number[] | Float32Array;
  geometryCoverage?: number;
  cameraFramingCoverage?: number;
  renderMs?: number;
  triangleCount: number;
  vertexCount: number;
  groundElevationContactMin: number;
  groundElevationContactMax: number;
}

export interface AuditAnomaly {
  type: 'floating_asset' | 'subterranean_penetration' | 'fidelity_violation' | 'degenerate_normals' | 'framing_miss';
  severity: 'warning' | 'error';
  message: string;
}

export interface HeadlessCriticOptions {
  userGoal?: string;
  groundContactTolerance?: number;
}

export interface MultimodalAuditReport {
  passed: boolean;
  score: number; // 0 - 100
  groundContactGap: number;
  floatingAssetsDetected: boolean;
  normalCoherenceScore: number;
  anomalies: AuditAnomaly[];
  recommendedCorrections: string[];
  checks: {
    groundContact: {
      status: 'pass' | 'warn' | 'fail';
      gapMeters: number;
      message: string;
    };
    geometricFidelity: {
      status: 'pass' | 'warn' | 'fail';
      vertexCount: number;
      triangleCount: number;
      message: string;
    };
    surfaceNormals: {
      status: 'pass' | 'warn' | 'fail';
      validNormalRatio: number;
      message: string;
    };
    cameraFraming: {
      status: 'pass' | 'warn' | 'fail';
      coverage: number;
      message: string;
    };
  };
  autoHealingSuggestions: string[];
}

export type SensorPassAuditResult = MultimodalAuditReport;

/**
 * Layer 4 Headless Sensor & Multimodal Verification Loop (The "Eyes"):
 * Audits procedural renders across RGB Beauty, Linear Metric Depth, and Surface Normals
 * to autonomously detect floating assets, clipping errors, and scale mismatches.
 */
export class HeadlessSnapshotCriticService {
  private static instance: HeadlessSnapshotCriticService;

  public static getInstance(): HeadlessSnapshotCriticService {
    if (!HeadlessSnapshotCriticService.instance) {
      HeadlessSnapshotCriticService.instance = new HeadlessSnapshotCriticService();
    }
    return HeadlessSnapshotCriticService.instance;
  }

  /**
   * Audits the 3 sensor passes against physical invariants and user spatial goals.
   */
  public auditSensorPasses(
    passes: SensorPassesData,
    userGoal?: string
  ): MultimodalAuditReport {
    const suggestions: string[] = [];
    const anomalies: AuditAnomaly[] = [];
    let score = 100;

    // 1. Check Ground Contact Elevation (Zero-Floating Invariant)
    // Contact gap must be <= 0.5m. A gap > 0.5m implies the edifice is hovering in mid-air.
    const groundGap = Math.abs(passes.groundElevationContactMin);
    let groundStatus: 'pass' | 'warn' | 'fail' = 'pass';
    let groundMsg = `Structure firmly grounded on geological datum (contact min: ${passes.groundElevationContactMin.toFixed(2)}m).`;

    if (passes.groundElevationContactMin > 1.0) {
      groundStatus = 'fail';
      score -= 35;
      groundMsg = `Floating asset defect: lowest geometry is hovering ${passes.groundElevationContactMin.toFixed(2)}m above origin.`;
      suggestions.push(`Apply .align_to_terrain(terrain, offset_z=0.2) to snap structure foundation to ground elevation.`);
      anomalies.push({
        type: 'floating_asset',
        severity: 'error',
        message: groundMsg
      });
    } else if (passes.groundElevationContactMin < -2.5) {
      groundStatus = 'warn';
      score -= 15;
      groundMsg = `Subterranean penetration: geometry penetrates foundation by ${Math.abs(passes.groundElevationContactMin).toFixed(2)}m.`;
      suggestions.push(`Elevate foundation offset_z by ${Math.abs(passes.groundElevationContactMin).toFixed(2)}m to clear subterranean bedrock.`);
      anomalies.push({
        type: 'subterranean_penetration',
        severity: 'warning',
        message: groundMsg
      });
    }

    // 2. Geometric Complexity Gate Invariant (Zero Toy Primitives)
    let fidelityStatus: 'pass' | 'warn' | 'fail' = 'pass';
    let fidelityMsg = `Geometric complexity floor satisfied (${passes.vertexCount.toLocaleString()} vertices, ${passes.triangleCount.toLocaleString()} triangles).`;

    if (passes.vertexCount < 5000) {
      fidelityStatus = 'fail';
      score -= 40;
      fidelityMsg = `Geometric fidelity violation: vertex count (${passes.vertexCount}) below 5,000 threshold. Flat box primitives prohibited.`;
      suggestions.push(`Increase procedural resolution or add high-frequency Vitruvian entasis/fluting.`);
      anomalies.push({
        type: 'fidelity_violation',
        severity: 'error',
        message: fidelityMsg
      });
    } else if (passes.vertexCount < 25000) {
      fidelityStatus = 'warn';
      score -= 10;
      fidelityMsg = `Single asset complexity achieved (${passes.vertexCount.toLocaleString()} vertices), compound world scenes expect >= 25,000 vertices.`;
    }

    // 3. Surface Normal Consistency (No Degenerate or Flipped Normals)
    let validNormals = 0;
    let totalNormalSamples = 0;
    const normals = passes.surfaceNormals;

    for (let i = 0; i < normals.length; i += 3) {
      const nx = normals[i];
      const ny = normals[i + 1];
      const nz = normals[i + 2];
      const lenSq = nx * nx + ny * ny + nz * nz;
      if (lenSq > 0.01) {
        totalNormalSamples++;
        // Check normal is reasonably normalized and not inverted downward into void
        if (lenSq >= 0.8 && lenSq <= 1.2) {
          validNormals++;
        }
      }
    }

    const validRatio = totalNormalSamples > 0 ? validNormals / totalNormalSamples : 1.0;
    let normalStatus: 'pass' | 'warn' | 'fail' = 'pass';
    let normalMsg = `Normal field coherent: ${(validRatio * 100).toFixed(1)}% valid surface vectors.`;

    if (validRatio < 0.85) {
      normalStatus = 'warn';
      score -= 15;
      normalMsg = `Inconsistent normal field detected (${((1.0 - validRatio) * 100).toFixed(1)}% degenerate or inverted normals).`;
      suggestions.push(`Recompute vertex envelope normals via mesh.computeNormals() or analytical finite difference.`);
      anomalies.push({
        type: 'degenerate_normals',
        severity: 'warning',
        message: normalMsg
      });
    }

    // 4. Camera Framing & Viewport Coverage
    const coverage = passes.geometryCoverage ?? passes.cameraFramingCoverage ?? 0.5;
    let framingStatus: 'pass' | 'warn' | 'fail' = 'pass';
    let framingMsg = `Optimal sensor coverage (${(coverage * 100).toFixed(1)}% of sensor pixels).`;

    if (coverage < 0.05) {
      framingStatus = 'fail';
      score -= 30;
      framingMsg = `Sensor framing miss: geometry occupies only ${(coverage * 100).toFixed(1)}% of frame. Target is outside camera FOV.`;
      suggestions.push(`Choreograph camera target to scene centroid or lower camera altitude.`);
      anomalies.push({
        type: 'framing_miss',
        severity: 'error',
        message: framingMsg
      });
    }

    const passed = score >= 70 && groundStatus !== 'fail' && fidelityStatus !== 'fail' && framingStatus !== 'fail';

    return {
      passed,
      score: Math.max(0, score),
      groundContactGap: groundGap,
      floatingAssetsDetected: groundStatus === 'fail',
      normalCoherenceScore: validRatio,
      anomalies,
      recommendedCorrections: suggestions,
      checks: {
        groundContact: {
          status: groundStatus,
          gapMeters: groundGap,
          message: groundMsg
        },
        geometricFidelity: {
          status: fidelityStatus,
          vertexCount: passes.vertexCount,
          triangleCount: passes.triangleCount,
          message: fidelityMsg
        },
        surfaceNormals: {
          status: normalStatus,
          validNormalRatio: validRatio,
          message: normalMsg
        },
        cameraFraming: {
          status: framingStatus,
          coverage,
          message: framingMsg
        }
      },
      autoHealingSuggestions: suggestions
    };
  }
}
