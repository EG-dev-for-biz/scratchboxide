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


// Professional Autonomous Color Grading & Matching Engine (Types)
export type {
    PrimaryColorWheels,
    PrimaryWheelChannel,
    ColorGradeMatchOptions,
    ColorGradeMatchResult,
    ColoristScopesData,
    SecondaryIsolationOptions
} from './node/image/ProColorGradeMatchingService';

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
export type {
    SurveyTextureUnprojector,
    SurveyTextureUnprojectorOptions,
    StationPlate,
    StationContribution,
    UnprojectionMetrics,
    SurveyTextureResult,
    SurveyTexturePipelineRequest
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
    LivingFoliageKernel,
    LivingFoliageContext,
    LivingFoliageOutput,
    LivingFoliageOptions
} from './node/3d-engine/living-foliage-kernel';
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
export type {
    Dynamic4DGaussianSplatService,
    HumanoidMotionData,
    HumanoidMotionFrame,
    DeformedGaussianFrame,
    Avatar4DGSDetails,
    SkinWeightedGaussian
} from './node/3d-engine/Dynamic4DGaussianSplatService';
export type {
    HumanoidMotionBridgeService,
    RetargetOptions
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
export {
    SbHumanLoader,
    type SbHumanHeader,
    type SbHumanJoint,
    type SbHumanSkinWeight,
    type SampledHumanoidSurface
} from './common/spatial/SbHumanLoader';
export type {
    VideoTo4DPerformerPipelineService,
    VideoTo4DPerformerOptions,
    VideoTo4DPerformerResult,
    SilhouetteExtractionResult,
    CanonicalGaussiansResult
} from './node/spatial/VideoTo4DPerformerPipelineService';

// Adaptive Domain Architecture 6-DOF Matchmove & Universal Keyframe Calibration
export type {
    AdaptiveMatchmoveCalibrationService,
    AdaptiveMatchmoveContext,
    SpatialAnchorCorrespondence,
    LensIntrinsicsProfile,
    KeyframeCalibrationState,
    TrajectoryFrameState,
    SequenceMetrologyReport,
    OptimizationOptions,
    PoseAnchorExtractionOptions,
    AdaptiveKeyframeDensityOptimizer,
    MotionAdaptiveConfig,
    KeyframeSelectionResult,
    TrajectoryInputPoint,
    SelectedKeyframeAnchor
} from './node/spatial/AdaptiveMatchmoveCalibrationService';
export type {
    NerfstudioDatasetService,
    NerfstudioFrame,
    NerfstudioTransforms,
    NerfstudioIntrinsics,
    OrbitalCameraRigItem,
    CameraObservationInput,
    ExportNerfstudioOptions,
    ExportNerfstudioResult
} from './node/spatial/NerfstudioDatasetService';
export type {
    TextureCompressionService,
    TextureMapType,
    TextureCompressionOptions,
    TextureCompressionResult,
    GlbCompressionStats,
    GlbCompressionOptions
} from './node/texture-compression-service';
export type {
    Colosseum3DMeshSeparatorService,
    Separated3DObject,
    Separated3DScene,
    BoundingBox3DMetric,
    SpatialEntityDefinition,
    SpatialCategory
} from './node/spatial/Colosseum3DMeshSeparatorService';
export type {
    OrientedBoundingBoxSolver,
    OrientedBoundingBox3D,
    DualBoundingBoxResult
} from './node/spatial/OrientedBoundingBoxSolver';
export type {
    BoundingBoxComparisonService,
    BoundingBoxBenchmarkEntity,
    BoundingBoxMetrology,
    BoundingBoxComparisonResult,
    BenchmarkManifest,
    Gemini3DBoxProxy
} from './node/spatial/BoundingBoxComparisonService';
export type {
    GeminiMultimodalObjectDetectorService,
    GeminiDetectedObject2D,
    GeminiObjectDetectionTelemetry,
    GeminiDetectionResult
} from './node/spatial/GeminiMultimodalObjectDetectorService';

export type { SbArchiService } from './node/3d-engine/sb-archi-service';
export type {
    RomanOrderType,
    ArchiSectionMode,
    ArchiPbrMode,
    SbArchiParams,
    SbArchiInversionOptions,
    SbArchiTelemetry,
    SbArchiInversionResult,
    ClassicalOrder,
    TectonicStructureClass,
    TectonicAnalysisReport
} from './common/spatial/sb-archi-protocol';

export type {
    UniversalBotanicalBridgeService,
    SupportedTreeSpecies,
    BotanicalSpeciesAdapter,
    SpatialTreeEntity,
    TreeSynthesisBridgeOptions,
    TreeSynthesisBridgeResult
} from './node/spatial/UniversalBotanicalBridgeService';

export type {
    UniversalArchiBridgeService,
    SupportedArchiTypology,
    ArchiTypologyAdapter,
    SpatialArchiEntity,
    ArchiSynthesisBridgeOptions,
    ArchiSynthesisBridgeResult
} from './node/spatial/UniversalArchiBridgeService';

export type {
    Universal3DObjectSeparationService,
    UniversalSpatialCategory,
    DownstreamGeneratorRouting,
    UniversalSeparatedObject,
    UniversalSeparatedScene,
    UniversalSeparationOptions,
    UniversalSeparationAndSceneResult
} from './node/spatial/Universal3DObjectSeparationService';

export type {
    SpatialVisualAlignmentVerificationService,
    AlignmentVerificationRequest,
    AlignmentVerificationReport,
    EdgeOverlapResult,
    MetrologyCertificationParams,
    MetrologyCertificate
} from './node/spatial/SpatialVisualAlignmentVerificationService';

export type {
    ContinuousSplineMatchmoveService,
    SplineKnot,
    EvaluatedPose,
    PersistentTrack3D2D,
    SplineAnchorConstraint,
    ContinuousSplineSolveOptions,
    SplineOptimizationResult,
    DenseTrajectoryFrame
} from './node/spatial/ContinuousSplineMatchmoveService';

// Location 3D Gaussian Splatting (3DGS) Canonical Service
export type {
    Location3DGaussianSplatService,
    Location3DGSService,
    Location3DGSRequest,
    Location3DGSResult
} from './node/spatial/Location3DGaussianSplatService';

// Adaptive Domain Style Shader API & Schema Contract
export {
    DEFAULT_ADAPTIVE_STYLE_CONTRACT
} from './common/spatial/adaptive-style-contract';
export type {
    AdaptiveColorChannel,
    AdaptiveLabColor,
    AdaptiveWorldStyleContract
} from './common/spatial/adaptive-style-contract';
export {
    AdaptiveTileShaderPatcher
} from './browser/generative-canvas/services/spatial/AdaptiveTileShaderPatcher';
export {
    AdaptiveStyleComposer
} from './browser/generative-canvas/services/spatial/AdaptiveStyleComposer';
export {
    AdaptiveDomainStyleService
} from './browser/generative-canvas/services/spatial/AdaptiveDomainStyleService';
export type {
    StyleApplyHandle
} from './browser/generative-canvas/services/spatial/AdaptiveDomainStyleService';
export type {
    AdaptiveStyleDeconstructionService,
    DeconstructionOptions
} from './node/spatial/AdaptiveStyleDeconstructionService';

// Universal Prompt-Driven Particle & Volumetric Simulation Protocol
export {
    DEFAULT_FIRE_SIMULATION_PROFILE,
    compileSimulationFromPrompt,
    interpolateSimulationProfiles
} from './common/prompt-particle-simulation-protocol';
export type {
    ParticleSimulationProfile
} from './common/prompt-particle-simulation-protocol';

// Adaptive Domain Particle Architecture (Zero-Preset & Schema-Guided)
export {
    DEFAULT_ADAPTIVE_PARTICLE_CONTRACT,
    interpolateAdaptiveParticleContracts
} from './common/spatial/adaptive-particle-contract';
export type {
    AdaptiveParticleContract,
    ParticleEmissionModel
} from './common/spatial/adaptive-particle-contract';
export {
    AdaptiveDomainParticleService
} from './browser/generative-canvas/services/spatial/AdaptiveDomainParticleService';

// AMD FidelityFX Super Resolution 1.0 (EASU + RCAS) Postprocessing
export {
    FidelityFXSuperResolution,
    createFidelityFXSuperResolution,
    FSRQualityPreset,
    FSR_PRESET_SCALES,
    computeInputDimensionsForPreset,
    EASU_SHADER,
    RCAS_SHADER,
    FSR_QUAD_VERT,
    type FidelityFXSuperResolutionOptions
} from './browser/generative-canvas/services/postprocessing/FidelityFXSuperResolution';








