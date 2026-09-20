/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * Standard geodetic point on the WGS-84 reference ellipsoid.
 */
export interface SpatialGeodeticAnchor {
  /** Latitude in decimal degrees [-90.0, +90.0] */
  latitude: number;
  /** Longitude in decimal degrees [-180.0, +180.0] */
  longitude: number;
  /** Height above Mean Sea Level / WGS-84 ellipsoid in meters */
  altitudeMsl: number;
  /** Optional geoid undulation height in meters (EGM96/EGM2008) */
  geoidHeight?: number;
}

/**
 * Type alias for generative geodetic anchor.
 */
export type GenerativeGeodeticAnchor = SpatialGeodeticAnchor;

/**
 * Local metric bounding box in East-North-Up (ENU) coordinates.
 */
export interface MetricBoundingBox {
  min: [number, number, number]; // [East, North, Up] in meters
  max: [number, number, number]; // [East, North, Up] in meters
  dimensions: [number, number, number]; // [Width (E-W), Depth (N-S), Height] in meters
}

/**
 * Extracted physical spatial affordance of a real-world location sampled from
 * Google Photorealistic 3D Tiles and geodetic solar ephemeris.
 * Feeds directly as conditioning context into generative AI models.
 */
export interface SpatialAffordance {
  /** Target geodetic center anchor */
  anchor: SpatialGeodeticAnchor;
  /** Local surface elevation in meters */
  surfaceElevationMsl: number;
  /** Local ground plane normal vector in Three.js space ([0, 1, 0] is vertical Up) */
  groundNormal: [number, number, number];
  /** Surrounding volumetric architectural envelope */
  boundingEnvelope: MetricBoundingBox;
  /** Calculated solar vector [x, y, z] pointing toward the sun */
  solarVector: [number, number, number];
  /** Sun azimuth (degrees clockwise from True North [0, 360)) */
  solarAzimuthDeg: number;
  /** Sun elevation above physical horizon (degrees [-90, +90]) */
  solarElevationDeg: number;
  /** Skyline horizon occlusion profile (samples at 8 cardinal directions) */
  skylineOcclusionAnglesDeg: number[];
  /** Suggested camera standoff distance in meters */
  recommendedStandoffMeters: number;
  /** Recommended camera focal length in mm (35mm equivalent) */
  recommendedFocalLengthMm: number;
  /** Estimated primary ground material classification (e.g. asphalt, stone, grass, water) */
  groundMaterialClass: 'asphalt' | 'stone' | 'concrete' | 'vegetation' | 'water' | 'unknown';
}

/**
 * Structured conditioning context passed to generative models (Gemini, Omni, Imagen, 3DGS diffusion)
 * to enforce physical-world geometric and radiometric consistency.
 */
export interface GenerativeSpatialConditioning {
  /** Formatted system prompt instructions guaranteeing non-negotiable framing and scale */
  promptDirectives: string;
  /** Bounding envelope description in human-readable and model-interpretable format */
  spatialContextSummary: string;
  /** Exact subject distance hint for depth of field and atmospheric haze */
  distanceHint: string;
  /** Recommended aspect ratio conforming to target viewport (e.g. '16:9', '1:1') */
  aspectRatio: string;
  /** Calculated solar lighting description (e.g. 'Golden hour sun at 12° elevation, casting 4.5m shadows') */
  lightingDescription: string;
  /** Normalized coordinate boundary for generative placement */
  normalizedBbox: {
    widthMeters: number;
    depthMeters: number;
    heightMeters: number;
  };
}

/**
 * Supported media source types for generative assets physically placed in the world.
 */
export type GenerativeSourceType =
  | 'gaussian-splat-splat'
  | 'gaussian-splat-spz'
  | 'gaussian-splat-ply'
  | 'neural-video-quad'
  | 'glb-mesh'
  | 'procedural-sdf';

/**
 * A generative media entity anchored to a real-world geodetic position in relation
 * to Google 3D Tiles.
 */
export interface GenerativeMediaPlacement {
  /** Unique entity ID */
  id: string;
  /** Media type */
  sourceType: GenerativeSourceType;
  /** Asset URL (local path or remote URI) */
  url?: string;
  /** In-memory binary buffer for fast splat / mesh ingestion */
  buffer?: ArrayBuffer | Uint8Array;
  /** Real-world geodetic location */
  anchor: SpatialGeodeticAnchor;
  /** Orientation [Heading, Pitch, Roll] in degrees: Heading is clockwise from True North */
  headingPitchRollDeg?: [number, number, number];
  /** Metric scale [Width, Depth, Height] in meters. Default is [1, 1, 1] */
  scaleMeters?: [number, number, number];
  /** Local metric offset [East, North, Up] relative to anchor in meters */
  offsetMeters?: [number, number, number];
  /** Whether to apply soft-Z depth interleaving against Google 3D Tiles */
  enableSoftZ?: boolean;
  /** Custom soft-Z depth threshold epsilon in meters (default 0.05m) */
  softZEpsilonMeters?: number;
  /** Whether to harmonize lighting with target diurnal sky dome */
  enableRadiometricHarmonization?: boolean;
  /** Entity visibility flag */
  visible?: boolean;
  /** Additional arbitrary metadata */
  metadata?: Record<string, unknown>;
}

/**
 * Configuration options for the SpatialGenerativeRuntime engine.
 */
export interface SpatialRuntimeConfig {
  /** Target canvas element */
  canvas?: HTMLCanvasElement;
  /** Google Maps Platform 3D Tiles API Key */
  googleMapsApiKey?: string;
  /** Initial geodetic camera focus / world origin */
  originAnchor?: SpatialGeodeticAnchor;
  /** Rendering backend preference */
  backend?: 'webgl2' | 'webgpu';
  /** Whether to enable dual-pass G-buffer soft-Z depth interleaving */
  enableSoftZCompositing?: boolean;
  /** Default soft-Z depth transition softness in meters */
  defaultSoftZEpsilonMeters?: number;
  /** Whether to enable radiometric solar ephemeris and de-lighting */
  enableRadiometricHarmonization?: boolean;
  /** Screen-Space Error (SSE) target for tile refinement (lower = sharper) */
  sseErrorTarget?: number;
  /** Maximum visible splat count budget */
  maxSplatBudget?: number;
  /** Target frame duration budget in ms (16.6ms = 60 FPS) */
  targetFrameDurationMs?: number;
}

/**
 * Real-time runtime telemetry metrics.
 */
export interface SpatialRuntimeMetrics {
  fps: number;
  frameTimeMs: number;
  activeTileCount: number;
  activeSplatCount: number;
  splatBudget: number;
  cameraAltitudeMeters: number;
  currentSSE: number;
  softZEnabled: boolean;
  radiometricPhase: string;
}
