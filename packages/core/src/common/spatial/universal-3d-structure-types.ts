/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import { GeodeticAnchor, ColmapCameraPose } from './colmap-vector-reference-types';
import {
  ProceduralCameraPose,
  ProceduralPinholeIntrinsics,
  ProceduralPoint3D,
  Vector3Tuple
} from '../../node/spatial/ProceduralSfMDatasetService';
import type { UniversalAnimationClip } from './universal-animation-types';

/**
 * 3D Bounding Box in local metric coordinates.
 */
export interface MetricBoundingBox {
  min: Vector3Tuple;
  max: Vector3Tuple;
  center: Vector3Tuple;
  extents: Vector3Tuple;
  boundingSphereRadius: number;
}

/**
 * Core Surface Mesh representation for the solid geometric master.
 */
export interface UniversalSurfaceMesh {
  vertices: Float32Array | number[]; // Flattened [x0, y0, z0, x1, y1, z1, ...]
  indices?: Uint32Array | number[];  // Triangle index array [i0, i1, i2, ...]
  normals?: Float32Array | number[]; // Per-vertex normals
  colors?: Float32Array | number[];  // Per-vertex RGB [r0, g0, b0, ...] normalized [0, 1]
  uvs?: Float32Array | number[];     // Per-vertex UVs [u0, v0, u1, v1, ...]
  tangents?: Float32Array | number[]; // Per-vertex tangents [tx, ty, tz, tw]
  materialIndex?: number;            // Index into structure materials array
  triangleCount: number;
  vertexCount: number;
}

/**
 * Simplified Collision Hull for physics, raycasting, and obstacle navigation.
 */
export interface UniversalCollisionHull {
  type: 'box' | 'obb' | 'convex_hull' | 'bounding_sphere' | 'inflated_bumper';
  center: Vector3Tuple;
  dimensions: Vector3Tuple; // [width, height, depth] or [extentU, extentV, extentW]
  radius?: number;
  safetyMarginMeters?: number;
  axes?: [Vector3Tuple, Vector3Tuple, Vector3Tuple]; // 3 orthogonal unit vectors (u, v, w) for OBB
  rotationMatrix?: [number, number, number, number, number, number, number, number, number]; // 3x3 orientation
  convexVertices?: Vector3Tuple[];
  indices?: Uint32Array | number[]; // triangle faces for polyhedron
}

/**
 * Options for computing a collision envelope / hull.
 */
export interface CollisionEnvelopeOptions {
  mode?: 'aabb' | 'obb' | 'convex_hull' | 'inflated_bumper';
  safetyMarginMeters?: number;
  maxHullVertices?: number;
}

/**
 * Camera Flight Blockout for Video Diffusion (Google Omni, Veo, Sora).
 */
export interface VideoDiffusionCameraBlockout {
  videoRef: '<VIDEO_REF_0>';
  fps: number;
  frameCount: number;
  durationSeconds: number;
  trajectoryType: 'cinematic_arc' | 'orbit_360' | 'canyon_push' | 'custom_spline';
  startPose: {
    position: Vector3Tuple;
    target: Vector3Tuple;
    fovDegrees: number;
  };
  frames: Array<{
    frameIndex: number;
    timestampSeconds: number;
    position: Vector3Tuple;
    target: Vector3Tuple;
    c2wMatrix: number[]; // 4x4 matrix
    fovDegrees: number;
  }>;
}

/**
 * Supported output format targets from the Universal 3D Structure Foundation.
 */
export type Target3DFormat =
  | 'glb'
  | 'colmap'
  | 'nerfstudio'
  | 'video_blockout'
  | 'collision_hull'
  | 'geojson'
  | 'manifest'
  | 'animation_track';

/**
 * PBR Alpha Mode standard in glTF 2.0.
 */
export type PbrAlphaMode = 'OPAQUE' | 'MASK' | 'BLEND';

/**
 * Universal Physical Material definition matching glTF 2.0 PBR Next specifications.
 */
export interface UniversalPbrMaterial {
  name: string;
  baseColorFactor?: [number, number, number, number]; // [R, G, B, A] normalized [0, 1], default [1, 1, 1, 1]
  metallicFactor?: number;   // [0, 1], default 0.1
  roughnessFactor?: number;  // [0.04, 1.0], default 0.5
  emissiveFactor?: Vector3Tuple; // [R, G, B] normalized [0, 1], default [0, 0, 0]
  emissiveStrength?: number; // default 1.0
  ior?: number;              // Index of refraction, default 1.5
  doubleSided?: boolean;     // default false
  alphaMode?: PbrAlphaMode;  // default 'OPAQUE'
  alphaCutoff?: number;      // default 0.5

  // Extended glTF PBR Next parameters
  clearcoatFactor?: number;
  clearcoatRoughnessFactor?: number;
  transmissionFactor?: number;
  sheenColorFactor?: Vector3Tuple;
  anisotropyStrength?: number;
  subsurfaceTranslucency?: number;

  // Texture map bindings (references texture IDs)
  baseColorTextureId?: string;
  metallicRoughnessTextureId?: string; // Standard glTF ORM (Green: Roughness, Blue: Metallic)
  normalTextureId?: string;
  occlusionTextureId?: string;
  emissiveTextureId?: string;
}

/**
 * Texture map type classification.
 */
export type UniversalTextureType =
  | 'albedo'
  | 'normal'
  | 'metallicRoughness'
  | 'roughness'
  | 'metallic'
  | 'occlusion'
  | 'emissive'
  | 'displacement';

/**
 * Universal Texture Map containing encoded or raw raster image bytes.
 */
export interface UniversalTextureMap {
  id: string;
  type: UniversalTextureType;
  width: number;
  height: number;
  channels: 1 | 3 | 4;
  buffer: Buffer; // Encoded PNG/JPEG buffer or raw pixel buffer
  mimeType: 'image/png' | 'image/jpeg' | 'image/raw';
  uri?: string;
}

/**
 * Procedural PBR Material Presets matching native C++20 Astra engine definitions.
 */
export type MaterialPresetName =
  | 'titanium'
  | 'gold'
  | 'chrome'
  | 'basalt'
  | 'oak'
  | 'concrete'
  | 'clay'
  | 'default';

/**
 * Options when synthesizing or ingesting into the Universal 3D Structure.
 */
export interface Universal3DStructureInitOptions {
  id?: string;
  name?: string;
  anchor?: GeodeticAnchor;
  mesh?: UniversalSurfaceMesh;
  materials?: UniversalPbrMaterial[];
  textures?: UniversalTextureMap[];
  material?: UniversalPbrMaterial; // Convenience single material shorthand
  points?: ProceduralPoint3D[];
  cameras?: ProceduralCameraPose[];
  boundingBox?: MetricBoundingBox;
  collisionHull?: UniversalCollisionHull;
  animations?: UniversalAnimationClip[];
  tags?: string[];
  metadata?: Record<string, any>;
}

/**
 * Export results map containing synthesized representations.
 */
export interface MultiFormatExportResult {
  structureId: string;
  name: string;
  formatsExported: Target3DFormat[];
  filesWritten?: Record<string, string>;
  textureFiles?: Record<string, string>; // textureId -> path written
  colmap?: {
    camerasText: string;
    imagesText: string;
    points3DText: string;
  };
  nerfstudio?: {
    transformsJson: string;
    sparsePcdPly: string;
  };
  videoBlockout?: VideoDiffusionCameraBlockout;
  collisionHull?: UniversalCollisionHull;
  animations?: UniversalAnimationClip[];
  cameraSolveTrack?: any;
  geoJson?: Record<string, any>;
  glbBuffer?: Buffer;
  manifestMarkdown?: string;
}

