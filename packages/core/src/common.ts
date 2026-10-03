/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

// Geodetic and Local Tangent Plane Coordinate Systems
export { GeoFrame } from './common/coordinate/GeoFrame';
export { LocalTangentPlane } from './common/coordinate/LocalTangentPlane';
export type { LatLngAlt } from './common/coordinate/LocalTangentPlane';

// Common Gemini Protocols & RPC Message Contracts
export * from './common/gemini-protocol';

// API client auth configuration (per-launch token plumbing)
export * from './common/api-client-config';

// Project Artifact Graph Protocol
export * from './common/project-artifact-graph-protocol';

// Media Generation Protocol (Nano Banana, Omni 1.1, Imagen, Veo)
export * from './common/media-generation-protocol';

// Workspace Sync Protocol & File Tree
export * from './common/workspace-sync-protocol';

// Geospatial 4D Protocol & Entities
export * from './common/geospatial-4d-protocol';

// ComfyUI Pipeline & Agent Protocol
export * from './common/comfyui-protocol';

// Performer 4DGS Gaussian PLY codec & 22-joint humanoid skinning (shared by Node pipeline and browser viewer)
export {
    decodeGaussianPly,
    encodeGaussianPly,
    SCRATCHBOX_PLY_ENCODING_COMMENT,
    type DecodedGaussianRecord,
    type GaussianPlyEncoding
} from './common/gaussian-ply-codec';
export {
    computeBoneRotations,
    skinPoint,
    retargetSegmentDirections,
    SBHUMAN22_PARENTS,
    SBHUMAN22_SEGMENT_CHILD,
    SBHUMAN22_LATERAL_REF
} from './common/humanoid-skinning';

// Universal COLMAP Vector Reference Types (Zero Presets)
export * from './common/spatial/colmap-vector-reference-types';
export { SurveySynthesisEngine, stationFromLookAt, stationToPinhole, horizontalFovDegrees, yawPitchFromForward, cameraBasis } from './common/spatial/SurveySynthesisEngine';
export type { PinholeIntrinsics, RankOptions, StationOptics } from './common/spatial/SurveySynthesisEngine';

// VFX Plate & Lens Distortion Protocols
export * from './common/vfx-plate-protocol';
export * from './common/optics/VfxLensInterchangeService';

// Spatial Generative Runtime Protocols & High-Precision RTC Kernel
export * from './common/spatial/spatial-generative-protocol';
export * from './common/coordinate/CameraRelativeRTC';

// Parametric Humanoid & Spatial Character Protocols
export * from './common/character-morph-protocol';
export * from './common/character-pose-protocol';

// Gemini Multimodal Scene Depth & Spatial Protocols
export * from './common/scene-depth-protocol';

// Physical Camera Optics & Dynamic DoF Tracking
export * from './common/optics/physical-camera-protocol';
export * from './common/optics/PhysicalCameraModel';

// Google DeepMind TAPIR Point Tracking & 4DGS Deformation Protocols
export * from './common/tracking/tapir-tracking-protocol';
export * from './common/tracking/PointTrackingModel';

// Google Solar API dataLayers & Multi-Class Foliage Segmentation
export * from './common/spatial/GoogleSolarDataLayersTypes';

// SB-Veggie (formerly SMPL-Tree) Parametric Botanical & Inversion Protocols
export * from './common/botanical/sb-veggie-protocol';
export * from './common/botanical/smpl-tree-protocol';

// SB-Archi Parametric Architecture & Inversion Protocols
export * from './common/spatial/sb-archi-protocol';

// Photometric Units & Photographic Stop Radiometry
export * from './common/spatial/photometric-units';

// Living World Graph & Spatial Entity Contracts
export * from './common/spatial/living-world-graph-types';
