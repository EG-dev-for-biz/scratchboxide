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

// Spatial Precision Resectioning & Image Location
export {
    GeoBoxPrecisionResectionService,
    type GeoBoxResectionRequest,
    type GeoBoxResectionResult,
    type ImageLocationResectionRequest,
    type ImageLocationResectionResult,
    resectImageLocation
} from './node/spatial/GeoBoxPrecisionResectionService';

// Spatial Pose Estimation (solvePnP & solvePnPRansac)
export {
    SpatialPoseEstimatorService,
    type Point2D,
    type Point3D,
    type CameraIntrinsics,
    type SolvedCameraPose,
    type PnPOptions,
    type PnPRansacOptions,
    type PnPRansacResult
} from './node/spatial/SpatialPoseEstimatorService';

// Visual Feature Matching (Harris + 128-D Descriptors + Lowe's + 2D-to-3D Ray Lifting)
export {
    VisualFeatureMatcherService,
    type VisualKeypoint,
    type FeatureMatch2D,
    type FeatureMatch2D3D,
    type DepthBuffer3D,
    type KeypointDetectionOptions,
    type MatchingOptions
} from './node/spatial/VisualFeatureMatcherService';

// Sub-Pixel Edge Alignment & Headless Silhouette Rendering
export {
    SubPixelEdgeAlignmentOptimizer,
    computeSobelField,
    evaluateEdgeOverlap,
    type CameraPose6DOF,
    type SobelEdgeField,
    type EdgeOverlapEvaluation,
    type EdgeAlignmentMetrics,
    type OptimizationOptions,
    type OptimizationResult
} from './node/spatial/SubPixelEdgeAlignmentOptimizer';
export {
    HeadlessMeshSilhouetteRenderer,
    type RenderMesh3D,
    type RenderTargetBuffer
} from './node/spatial/HeadlessMeshSilhouetteRenderer';

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

// 2D Image-to-Image Color Transfer API (Standalone Service)
export {
    ImageColorTransferService,
    transferImageColor,
    type ImageColorTransferRequest,
    type ImageColorTransferResult,
    type LocalCielabOptions
} from './node/image/ImageColorTransferService';

// Sophisticated 3D Tile Recoloring Engine v2 (Architecture 2: Atlas Re-grade & PBR Synthesis)
export {
    GlbTextureRecolorService,
    recolor3DTilesGlb,
    DEFAULT_NANO_BANANA_GLB_PALETTE,
    GLB_RECOLOR_PRESETS,
    hexToLab,
    type NanoBananaGlbPalette,
    type LabColor,
    type MaterialSegmentationOptions,
    type PbrSynthesisOptions,
    type GlbRecolorOptions,
    type GlbRecolorResult,
    type GlbRecolorApiOptions,
    type GlbRecolorApiResult
} from './node/spatial/GlbTextureRecolorService';

// Google 360 Panorama Pipeline & 4K Monumental Generator
export {
    Google360PanoramaPipelineService,
    generate4KMonumentalPanorama,
    generate360Panorama,
    healPanoramaSeam,
    inpaintPanorama,
    auditPanoramaQuality,
    reprojectZenithPanorama,
    extractZenithRectilinearPatch,
    type Generate4KMonumentalPanoramaOptions,
    type Generate4KMonumentalPanoramaResult,
    type Generate360PanoramaOptions,
    type Generate360PanoramaResult,
    type PanoramaSeamOptions,
    type PanoramaSeamResult,
    type PanoramaInpaintOptions,
    type PanoramaInpaintResult,
    type PanoramaQualityAuditOptions,
    type PanoramaQualityAuditResult,
    type ZenithReprojectionOptions,
    type ZenithReprojectionResult,
    type EquirectangularStructuredPrompt
} from './node/spatial/Google360PanoramaPipelineService';

// Algorithmic UV Unwrap & Rewrap Engine & MaxRects Atlas Packer
export {
    AlgorithmicUvEngine,
    type UvEngineMode,
    type DetailSynthesisOptions,
    type PbrDecompositionOptions,
    type AlgorithmicUvOptions,
    type PbrDecompositionResult,
    type AlgorithmicUvResult
} from './node/spatial/AlgorithmicUvEngine';

export {
    TextureAtlasPacker,
    MaxRectsAtlasPacker,
    type TextureItem,
    type PackedRect,
    type AtlasResult,
    type AtlasPackerOptions
} from './node/spatial/TextureAtlasPacker';


