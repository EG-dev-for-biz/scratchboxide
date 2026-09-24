/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

// Main Canvas Studio & Core Error Boundary
export { GenerativeCanvasStudio } from './browser/generative-canvas/GenerativeCanvasStudio';
export { CanvasErrorBoundary } from './browser/generative-canvas/CanvasErrorBoundary';

// 8 Custom Visual Canvas Primitives
export { Scene3DPrimitive } from './browser/generative-canvas/primitives/Scene3DPrimitive';
export { LiveCodeSandboxPrimitive } from './browser/generative-canvas/primitives/LiveCodeSandboxPrimitive';
export { MarkdownDocumentPrimitive } from './browser/generative-canvas/primitives/MarkdownDocumentPrimitive';
export { KanbanBoardPrimitive } from './browser/generative-canvas/primitives/KanbanBoardPrimitive';
export { NodeGraphPrimitive } from './browser/generative-canvas/primitives/NodeGraphPrimitive';
export { MetricCardsPrimitive } from './browser/generative-canvas/primitives/MetricCardsPrimitive';
export { InteractiveBrowserPrimitive } from './browser/generative-canvas/primitives/InteractiveBrowserPrimitive';
export { VideoTimelinePrimitive } from './browser/generative-canvas/primitives/VideoTimelinePrimitive';

// Pro Video / NLE Compositor & Timeline Services
export * from './browser/generative-canvas/services/video';

// Canvas Types & Protocols
export * from './browser/generative-canvas/canvas-types';

// Browser subpath re-export
export * from './browser';

// Common coordinate frames and protocols
export * from './common';


// Atmosphere & Location 3D Object Lighting
export {
    LocationObjectLightingService,
    harmonizeLocationObjectAtmosphere
} from './browser/generative-canvas/services/atmosphere';

// Native Prompt-Driven 3D Mesh Reshaping & Parametric Deformation (Types)
export type {
    MeshDeformationAxis,
    SculptBrushType,
    LatticeOffset,
    MeshDeformationOp,
    MeshDeformOperation,
    MeshReshapingOptions,
    MeshReshapingTelemetry,
    MeshReshapingResult
} from './node/3d-engine/native-mesh-reshaper-service';

// Native Physical De-Lighting & Per-Face Material Assignment (Types)
export type {
    NativeSunEstimateOptions,
    NativeSunEstimateResult,
    NativeDelightOptions,
    NativePerFaceMaterialResult,
    NativeMaterialClassifyOptions
} from './node/3d-engine/native-tile-lighting-service';

// Nano Banana Color Transfer Pipeline (Method 2: Two-Step Extract-then-Apply)
export {
    NanoBananaColorService,
    buildExtractPalettePrompt,
    parseExtractedPalette,
    buildApplyPalettePrompt,
    formatPaletteAsMarkdown,
    executeTwoStepColorTransfer,
    type ExtractedColorTone,
    type ShadowHighlightProfile,
    type ExtractedColorPalette,
    type ExtractPalettePromptOptions,
    type ApplyPaletteOptions,
    type TwoStepColorTransferOptions,
    type ColorTransferPlan
} from './browser/generative-canvas/services/nano-banana-color-service';

// Survey-to-Atlas Inverse Projection (SAIP) Engine
export {
    SurveyTextureUnprojector,
    type SurveyTextureUnprojectorOptions,
    type StationPlate,
    type StationContribution,
    type UnprojectionMetrics,
    type SurveyTextureResult,
    type SurveyTexturePipelineRequest
} from './node/spatial/SurveyTextureUnprojector';

// Zero-Preset Adaptive Material PBR Architecture
export type {
    AdaptiveMaterialPbrService
} from './node/3d-engine/adaptive-material-pbr-service';
export type {
    UniversalPbrBakingKernel,
    UniversalTexelContext,
    UniversalTexelOutput,
    UniversalPbrOptions,
    UniversalPbrTelemetry,
    UniversalPbrResult
} from './node/3d-engine/universal-pbr-baking-kernel';
export type {
    VirtualBevelKernel,
    EdgeAdjacencyRecord,
    TriangleGeometricFrame,
    SubmeshAdjacencyGraph,
    GeometricNormalResult
} from './node/3d-engine/virtual-bevel-kernel';
export type {
    AdaptiveMaterialSchema,
    IntrinsicSignalMetrics,
    ContinuousBiophysicalFields,
    AdaptivePbrOptions,
    AdaptivePbrResult,
    AdaptiveAtlasTelemetry
} from './common/adaptive-material-types';

// 4DAnyone 4D Gaussian Splatting Dynamic Humanoid Avatar Engine
export {
    Dynamic4DGaussianSplatService,
    type HumanoidMotionData,
    type HumanoidMotionFrame,
    type DeformedGaussianFrame,
    type Avatar4DGSDetails,
    type SkinWeightedGaussian
} from './node/3d-engine/Dynamic4DGaussianSplatService';
export {
    HumanoidMotionBridgeService,
    type RetargetOptions
} from './node/spatial/HumanoidMotionBridgeService';
export {
    ConcertStagePerformerService,
    PerformerSkinningMode,
    MUSIC_VENUE_PRESETS,
    SMPLX_22_JOINT_NAMES,
    SMPLX_22_PARENTS,
    DEFAULT_CANONICAL_JOINTS,
    type MusicVenuePreset,
    type ConcertStageOptions,
    type PerformerKinematicsFrame,
    type PerformerTelemetry
} from './browser/generative-canvas/services/ConcertStagePerformerService';
export type {
    TextureCompressionService,
    TextureMapType,
    TextureCompressionOptions,
    TextureCompressionResult,
    GlbCompressionStats,
    GlbCompressionOptions
} from './node/texture-compression-service';


