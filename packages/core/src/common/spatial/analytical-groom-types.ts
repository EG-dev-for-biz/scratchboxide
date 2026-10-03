/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Continuous physical surface descriptor.
 * In strict alignment with Scratchbox IDE Adaptive Domain Architecture (ADA):
 * - ZERO Closed Taxonomies: No static shape enums (no 'star_creature' | 'fur_sphere').
 * - Continuous Dimensional Parameters: Radius, harmonic frequencies, modulation amplitudes,
 *   axial taper, or arbitrary surface mesh attachment.
 */
export interface ContinuousSurfaceDescriptor {
  /** Metric center in world units [x, y, z]. Default [0, 0, 0]. */
  center?: [number, number, number];
  /** Base radius in metric units. Default 1.0. */
  baseRadius?: number;
  /** Integer azimuthal harmonic frequency (e.g. 5 for 5-pointed star, 0 for sphere, 3 for clover, 8 for starburst). */
  harmonicFrequency?: number;
  /** Continuous harmonic modulation amplitude in [0, 1]. Default 0.0. */
  harmonicAmplitude?: number;
  /** Axial vertical taper factor in [-1, 1]. Default 0.0. Positive values taper top pole. */
  axialTaper?: number;
  /** Optional file path to a GLB/OBJ mesh to sample surface positions and normals directly from. */
  meshGlbPath?: string;
  /** Optional surface flow direction vector [x, y, z] for directional fur/hair groom. */
  flowDirection?: [number, number, number];
}

/**
 * Continuous biophysical hair grooming descriptor.
 * Defines hair follicle density, strand morphology, Voronoi clumping, curl noise, and melanin pigmentation.
 */
export interface ContinuousGroomDescriptor {
  /** Number of sparse guide curves across surface. Default 64. */
  guideCount?: number;
  /** Dense synthesized strand count. Default 4096. */
  strandCount?: number;
  /** Polyline vertices per strand. Default 12. */
  segmentsPerStrand?: number;
  /** Physical strand length in metric units. Default 0.25. */
  length?: number;
  /** Root follicle width in metric units. Default 0.003. */
  rootWidth?: number;
  /** Tip follicle width in metric units. Default 0.0006. */
  tipWidth?: number;
  /** Voronoi cluster tip clumping factor in [0, 1]. Default 0.75. */
  clumping?: number;
  /** Procedural helical curl radius in metric units. Default 0.012. */
  curlRadius?: number;
  /** Procedural helical curl frequency along strand length. Default 3.5. */
  curlFrequency?: number;
  /** Procedural planar wave frequency along strand. Default 2.0. */
  waveFrequency?: number;
  /** Procedural planar wave amplitude in metric units. Default 0.008. */
  waveAmplitude?: number;
  /** Marschner biophysical eumelanin content in [0, 1] (dark brown/black). Default 0.6. */
  eumelanin?: number;
  /** Marschner biophysical pheomelanin content in [0, 1] (red/auburn). Default 0.2. */
  pheomelanin?: number;
  /** Optional custom RGB albedo at follicle root [r, g, b] in [0, 1]. Overrides melanin if provided. */
  baseColorRgb?: [number, number, number];
  /** Optional custom RGB albedo at strand tip [r, g, b] in [0, 1]. Overrides melanin if provided. */
  tipColorRgb?: [number, number, number];
}

/**
 * Anisotropic 3D Gaussian Splat mapping options.
 */
export interface ContinuousSplatOptions {
  /** Anisotropic covariance radial scaling multiplier. Default 1.0. */
  scaleMultiplier?: number;
  /** Base splat opacity in [0, 1]. Default 0.92. */
  opacity?: number;
  /** Desired export format. Default 'spz'. */
  exportFormat?: 'spz' | 'ply' | 'glb' | 'all';
  /** Destination directory or file path. */
  outputPath?: string;
}

/**
 * Analytical Groom & Splat Synthesis Contract.
 */
export interface AnalyticalGroomContract {
  id: string;
  surface: ContinuousSurfaceDescriptor;
  groom: ContinuousGroomDescriptor;
  splat?: ContinuousSplatOptions;
}

/**
 * Result of an analytical groom and splat execution.
 */
export interface AnalyticalGroomExecutionResult {
  success: boolean;
  contract: AnalyticalGroomContract;
  splatCount: number;
  strandCount: number;
  spzPath?: string;
  spzBuffer?: Uint8Array;
  plyPath?: string;
  glbPath?: string;
  executionTimeMs: number;
  compilationTimeMs: number;
  error?: string;
}
