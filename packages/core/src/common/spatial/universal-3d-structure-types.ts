/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { GeodeticAnchor, ColmapCameraPose } from './colmap-vector-reference-types';
import {
  ProceduralCameraPose,
  ProceduralPinholeIntrinsics,
  ProceduralPoint3D,
  Vector3Tuple
} from '../../node/spatial/ProceduralSfMDatasetService';

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
  triangleCount: number;
  vertexCount: number;
}

/**
 * Simplified Collision Hull for physics, raycasting, and obstacle navigation.
 */
export interface UniversalCollisionHull {
  type: 'box' | 'convex_hull' | 'bounding_sphere';
  center: Vector3Tuple;
  dimensions: Vector3Tuple; // [width, height, depth]
  radius?: number;
  convexVertices?: Vector3Tuple[];
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
  | 'geojson';

/**
 * Options when synthesizing or ingesting into the Universal 3D Structure.
 */
export interface Universal3DStructureInitOptions {
  id?: string;
  name?: string;
  anchor?: GeodeticAnchor;
  mesh?: UniversalSurfaceMesh;
  points?: ProceduralPoint3D[];
  cameras?: ProceduralCameraPose[];
  boundingBox?: MetricBoundingBox;
  collisionHull?: UniversalCollisionHull;
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
  geoJson?: Record<string, any>;
  glbBuffer?: Buffer;
}
