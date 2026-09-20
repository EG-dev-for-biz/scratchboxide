/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

// AI Intelligence & Gemini Service
export { GeminiService } from './node/gemini-service';

// Project Artifact & Config Persistence
export { ProjectArtifactStore } from './node/project-artifact-store';
export { WorkspaceConfigService } from './node/workspace-config-service';
export { WorkspaceFileWatcherService } from './node/workspace-file-watcher-service';
export { ProjectContextGraphService } from './node/project-context-graph-service';

// User Memories & Browser Proxy Services
export { UserMemoriesService } from './node/user-memories-service';
export { BrowserProxyService } from './node/browser-proxy-service';

// Media Generation Services
export { MediaAssetStore } from './node/media-asset-store';
export { GoogleMediaGenerationService } from './node/google-media-generation-service';
export { MediaGenerationJobService } from './node/media-generation-job-service';
export { GoogleMediaCredentialsService } from './node/google-media-credentials-service';
export * from './node/texture-processing';

// Autonomous DeepWrite Services
export { DeepWriteService } from './node/deep-write/deep-write-service';
export { GoalAnalyzer } from './node/deep-write/goal-analyzer';
export { MultiPlatformScaffolder } from './node/deep-write/multi-platform-scaffolder';
export { DynamicDagPlanner } from './node/deep-write/dynamic-dag-planner';
export { DeepWriteExecutionBridge } from './node/deep-write/deep-write-execution-bridge';
export { CodebaseLensSyncService } from './node/deep-write/codebase-lens-sync-service';
export { PrimitiveSynthesizer } from './node/deep-write/primitive-synthesizer';
export { UserLearningService } from './node/deep-write/user-learning-service';

// Autonomous Agent, Sandbox & Subagent Services
export { LongRunningAgentService } from './node/long-running-agent-service';
export { SubagentPoolService } from './node/subagent-pool-service';
export { ContainerSandboxService } from './node/container-sandbox-service';
export { LspDiagnosticFeedbackService } from './node/lsp-diagnostic-feedback-service';
export { CodebasePatternEngine } from './node/codebase-pattern-engine';
export { AgentContextCompactor } from './node/agent-context-compactor';
export { ConversationDiffMemoryService } from './node/conversation-diff-memory-service';

// 3D Native Engine Compiler Service
export { NativeCppCompilerService } from './node/3d-engine/native-compiler-service';
export { PhotorealismEvaluator } from './node/3d-engine/photorealism-evaluator';
export { PhotorealTileCleanupService, TileCleanupOptions, TileCleanupMetrics, TileCleanupResult } from './node/3d-engine/tile-cleanup-service';
export {
    FieldAlignedQuadRemeshService,
    QuadRemeshServiceOptions,
    QuadRemeshMetrics,
    QuadRemeshResult
} from './node/3d-engine/field-remesh-service';
export {
    BotanicalVegetationService,
    BotanicalMode,
    LeafMorphologyType,
    BotanicalPipelineOptions,
    BotanicalPipelineTelemetry,
    BotanicalPipelineResult
} from './node/3d-engine/botanical-vegetation-service';
export {
    UniversalTileDecompositionService,
    UtdraService,
    UldraService,
    GeographicDomain,
    UtdraPipelineMode,
    UtdraBenchmarkType,
    UtdraServiceOptions,
    UtdraTelemetry,
    UtdraResult
} from './node/3d-engine/universal-tile-decomposition-service';
export {
    NativeMeshReshaperService,
    MeshReshapingService,
    reshapeMesh,
    parsePromptToMeshOperations,
    MeshDeformationAxis,
    SculptBrushType,
    LatticeOffset,
    MeshDeformationOp,
    MeshReshapingOptions,
    MeshReshapingTelemetry,
    MeshReshapingResult
} from './node/3d-engine/native-mesh-reshaper-service';
export {
    ColmapReconstructionService,
    ColmapCameraModel,
    ColmapGlbOptions,
    ColmapReconstructionSummary,
    GlomapOptions,
    GlomapResult
} from './node/3d-engine/colmap-reconstruction-service';
export {
    SplatService,
    SplatConversionOptions,
    SplatPipelineResult,
    ImageToSplatService,
    VideoTrajectoryType,
    VideoKeyframeInput,
    VideoKeyframeConversionOptions,
    PublicSourceItem,
    PublicSourceCatalog,
    Depthbox360UniverseService,
    DepthboxUniversePreset,
    DepthboxSplatLayer,
    Depthbox360SplatPoint,
    Depthbox360UniverseConfig,
    Depthbox360UniverseResult
} from './node/3d-engine/splat-service';

// 4D Spatial & World Branching Substrates
export { WorldBranchManager, BranchCommit } from './node/spatial/WorldBranchManager';
export { SpatialAssetVaultService, VaultMetadata } from './node/spatial/SpatialAssetVaultService';
export { HeadlessSpatialAiBridge, SpatialAIConditioningPayload } from './node/spatial/HeadlessSpatialAiBridge';
export { DeploymentManifestCompiler, DeploymentCompileOptions } from './node/spatial/DeploymentManifestCompiler';
export { TemporalSimulationSolver } from './node/spatial/TemporalSimulationSolver';
export { OccSoraBridge, S4DTrajectoryPrompt, S4DTrajectoryWaypoint, S4DInferenceRequest } from './node/spatial/OccSoraBridge';
export { Synthetic4DDataGenerator, Synthetic4DGenerationConfig, Synthetic4DDatasetItem } from './node/spatial/Synthetic4DDataGenerator';

// Headless Video Compositor Service
export {
    HeadlessVideoCompositorService,
    CompositeJobRequest,
    CompositeJobResult
} from './node/video/HeadlessVideoCompositorService';

// Google 3D Tile Camera Blockout Pipeline Service (<VIDEO_REF_0>)
export {
    Google3DTileBlockoutPipelineService,
    GeoAnchor,
    CameraPoseFrame,
    CameraPathData,
    TileAtmosphereRenderMode,
    TilePipelineMode,
    TileAtmosphereConfig,
    TileLodQualityConfig,
    TileBlockoutOutputConfig,
    TileBlockoutPipelineRequest,
    TileBlockoutPipelineResult,
    Google3DTileMeshStats,
    Google3DTileQualityReport,
    Google3DTileRenderOutput,
    Google3DTile3DObjectResult,
    Google3DTilesQueryOptions,
    DEFAULT_GOOGLE_MAPS_TILES_API_KEY,
    geocode3DTilesAddress,
    create3DTilesTrajectory,
    runGoogle3DTilesPipeline,
    getGoogle3DTilesFullTexture,
    getGoogle3DTilesClay
} from './node/spatial/Google3DTileBlockoutPipelineService';


// 2D Image-to-Image Color Transfer API (Standalone Service)
export {
    ImageColorTransferService,
    transferImageColor,
    type ImageColorTransferRequest,
    type ImageColorTransferResult,
    type LocalCielabOptions
} from './node/image/ImageColorTransferService';

// Google 360 Panorama Pipeline Service (Seam Healing & Inpainting)
export {
    Google360PanoramaPipelineService,
    PanoramaSeamOptions,
    PanoramaSeamResult,
    PanoramaInpaintOptions,
    PanoramaInpaintResult,
    Generate360PanoramaOptions,
    Generate360PanoramaResult,
    healPanoramaSeam,
    inpaintPanorama,
    generate360Panorama,
    generate4KMonumentalPanorama,
    auditPanoramaQuality,
    reprojectZenithPanorama,
    extractZenithRectilinearPatch,
    type Generate4KMonumentalPanoramaOptions,
    type Generate4KMonumentalPanoramaResult,
    type PanoramaQualityAuditOptions,
    type PanoramaQualityAuditResult,
    type ZenithReprojectionOptions,
    type ZenithReprojectionResult,
    type EquirectangularStructuredPrompt,
    UpscalePanorama16KOptions,
    UpscalePanorama16KResult,
    upscalePanorama16K
} from './node/spatial/Google360PanoramaPipelineService';

// Multi-Perspective 360° & Zenith/Nadir Synthesis Service
export {
    MultiPerspectivePanoramaSynthesisService,
    PanoramaPerspective,
    PerspectiveCameraConfig,
    PerspectiveFrame,
    MultiPerspectiveSynthesisOptions,
    MultiPerspectiveSynthesisResult,
    generate360Perspectives
} from './node/spatial/MultiPerspectivePanoramaSynthesisService';

// Trained Neural Model Registry & Asset Services
export {
    TrainedModelRegistryService,
    TrainedModelItem,
    TrainedModelFamily,
    Avatar4DGSManifest,
    ModelCatalogSummary
} from './node/models/TrainedModelRegistryService';

// ComfyUI Bridge, Cloud Run & Pipeline Agent Services
export { ComfyUiBridgeService, ComfyBridgeOptions, ComfyQueuePromptResult } from './node/comfyui/comfyui-bridge-service';
export { ComfyUiCloudRunService } from './node/cloudrun/comfyui-cloudrun-service';
export { ComfyUiPipelineAgent, TwoTierExecutionResult } from './node/agent/comfyui-pipeline-agent';

// Geo Camera Matchmove Pipeline Service
export {
    GeoCameraMatchmovePipelineService,
    CameraMotionType,
    GeoMatchmoveRequest,
    GeoMatchmoveResult,
    LandmarkAnchorInfo,
    KNOWN_LANDMARK_ANCHORS,
    TrajectoryKeyframeAnchor,
    AdaptiveDenseSamplingConfig,
    VideoMetadata,
    PrecisionMetrics,
    PrecisionProofArtifacts
} from './node/spatial/GeoCameraMatchmovePipelineService';

// Universal COLMAP Vector Reference Pipeline Service (Zero Presets)
export {
    ColmapVectorPipelineService,
    ColmapNodeExecutionOptions
} from './node/spatial/ColmapVectorPipelineService';

// Survey Synthesis: station camera truth for blockout render, AI Beautify and splat baking
export { SurveySynthesisEngine, stationFromLookAt, stationToPinhole, horizontalFovDegrees, yawPitchFromForward } from './common/spatial/SurveySynthesisEngine';
export type { PinholeIntrinsics, RankOptions, StationOptics } from './common/spatial/SurveySynthesisEngine';
export { SurveyStationRenderService, solarAtUtcInstant, EMPTY_DEPTH } from './node/spatial/SurveyStationRenderService';
export type { StationBlockoutRender, StationBlockoutRenderOptions, StationEnrichOptions } from './node/spatial/SurveyStationRenderService';
export { SurveyApi, createSurveyRouter, createNodeHttpHandler } from './node/spatial/survey-router';
export type { SurveyApiDeps, SurveyJob } from './node/spatial/survey-router';
export { Splat3DTilesService } from './node/spatial/Splat3DTilesService';
export type { Splat3DTilesOptions, Splat3DTilesResult } from './node/spatial/Splat3DTilesService';

// GeoBox Multimodal Camera Resectioning & 100% Sub-Pixel Edge Alignment
export {
    GeoBoxPrecisionResectionService,
    type GeoBoxResectionRequest,
    type GeoBoxResectionResult,
    type ImageLocationResectionRequest,
    type ImageLocationResectionResult,
    resectImageLocation,
    type LensDistortionParams,
    type SubPixelOptimizationRequest,
    KNOWN_RESECTION_LANDMARKS
} from './node/spatial/GeoBoxPrecisionResectionService';
export {
    SubPixelEdgeAlignmentOptimizer,
    type SobelEdgeField,
    type EdgeOverlapEvaluation,
    type OptimizationResult,
    type CameraPose6DOF,
    type EdgeAlignmentMetrics,
    type OptimizationOptions,
    computeSobelField,
    evaluateEdgeOverlap
} from './node/spatial/SubPixelEdgeAlignmentOptimizer';
export {
    HeadlessMeshSilhouetteRenderer,
    type RenderMesh3D,
    type RenderTargetBuffer
} from './node/spatial/HeadlessMeshSilhouetteRenderer';
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
export {
    VisualFeatureMatcherService,
    type VisualKeypoint,
    type FeatureMatch2D,
    type FeatureMatch2D3D,
    type DepthBuffer3D,
    type KeypointDetectionOptions,
    type MatchingOptions
} from './node/spatial/VisualFeatureMatcherService';
export {
    VanishingPointHorizonEstimator,
    type VanishingPointResult,
    type LineSegment2D,
    type CameraTiltClassification
} from './node/spatial/VanishingPointHorizonEstimator';
export {
    LandmarkBearingGatedMatcher,
    type ViewingQuadrantBounds,
    type FacadePlane,
    type ExteriorCornerFeature
} from './node/spatial/LandmarkBearingGatedMatcher';
export {
    MultiModalCameraPoseOptimizer,
    type MultiModalOptimizationMetrics,
    type MultiLossWeights
} from './node/spatial/MultiModalCameraPoseOptimizer';
export {
    DynamicVideoTrajectorySolver,
    type TrajectoryBoundaryPose,
    type DynamicTrajectoryOptions
} from './node/spatial/DynamicVideoTrajectorySolver';
export * from './node/3d-engine/geobox-pipeline-types';

// Optics & Brown-Conrady Lens Distortion Shader Engine
export {
    LENS_DISTORTION_SHADER,
    LENS_OPTICAL_PRESETS,
    computeBrownConradyUV,
    calculateBrownConradyFromFocalLength
} from './browser/generative-canvas/services/optics/LensDistortionEffect';
export type {
    LensDistortionConfig,
    LensOpticalProfile
} from './browser/generative-canvas/services/optics/LensDistortionEffect';

// Atmosphere & Physical Lighting Inverse Estimation
export {
    AtmosphereImageEstimationService,
    fitPlanckianKelvinTemperature,
    computeSkyAtmosphereMetrics,
    WELL_KNOWN_ATMOSPHERE_LANDMARKS,
    AtmosphereService,
    LocationObjectLightingService,
    harmonizeLocationObjectAtmosphere,
    generateCanonicalAmbulatoryFixtures,
    STONE_ALBEDO_PROFILES,
    LOCATION_DELIGHT_FRAGMENT_CHUNK,
    LOCATION_DELIGHT_VERTEX_CHUNK,
    LOCATION_DELIGHT_VERTEX_BODY
} from './browser/generative-canvas/services/atmosphere';
export type {
    ImageAtmospherePixelOptions,
    ImageAtmosphereRequest,
    AtmosphericEstimationResult,
    AtmosphericScatteringConfig,
    StoneType,
    DelightUniformsConfig,
    AtmosphereSceneLightingConfig,
    ArchitecturalPortalFixtureConfig,
    LocationObjectAtmosphereRequest,
    LocationObjectAtmosphereResult
} from './browser/generative-canvas/services/atmosphere';

// Gemini In-App Spatial, Atmosphere & Nano Banana Tools
export {
    ATMOSPHERE_TOOL_DECLARATIONS,
    atmosphereHandlers,
    GEOBOX_PRECISION_TOOL_DECLARATIONS,
    geoboxPrecisionHandlers,
    NANO_BANANA_TOOL_DECLARATIONS,
    nanoBananaHandlers
} from './node/gemini/tool-registry';

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

// Algorithmic UV Unwrap & Rewrap Engine API & Tools
export {
    AlgorithmicUvEngine,
    type UvEngineMode,
    type DetailSynthesisOptions,
    type PbrDecompositionOptions,
    type PbrDecompositionResult,
    type AlgorithmicUvOptions,
    type AlgorithmicUvResult
} from './node/spatial/AlgorithmicUvEngine';
export {
    MaxRectsAtlasPacker,
    type AtlasPackerOptions,
    type AtlasResult,
    type PackedRect,
    type TextureItem
} from './node/spatial/TextureAtlasPacker';
export {
    ALGORITHMIC_UV_TOOL_DECLARATIONS,
    algorithmicUvHandlers
} from './node/gemini/tools/algorithmic-uv-tools';

// Professional VFX Lens Distortion Interchange & Optical Services
export {
    VfxLensInterchangeService
} from './common/optics/VfxLensInterchangeService';
export type {
    VfxLensMetadata,
    OpenCvCameraCalibration
} from './common/optics/VfxLensInterchangeService';

// Parametric Character Kinematics & MediaPipe 3D Pose Services
export {
    MediaPipePoseService,
    type MediaPipePoseServiceOptions
} from './node/spatial/MediaPipePoseService';
export {
    CharacterSilhouetteSolver
} from './node/spatial/CharacterSilhouetteSolver';
export {
    CharacterImageMorphEstimator
} from './node/spatial/CharacterImageMorphEstimator';

// Gemini Multimodal Scene Depth Services
export {
    GeminiSceneDepthService,
    type GeminiSceneDepthServiceOptions
} from './node/spatial/GeminiSceneDepthService';

// Physical Camera Optics & Dynamic DoF Tracking
export {
    PhysicalCameraModel
} from './common/optics/PhysicalCameraModel';
export type {
    PhysicalCameraConfig,
    SensorDimensions,
    SensorFormatPreset,
    OpticalFrustumCalculation,
    DepthOfFieldCalculation,
    FocusTargetDefinition,
    DynamicFocusTrackingState
} from './common/optics/physical-camera-protocol';

// Google DeepMind TAPIR Point Tracking & 4DGS Deformation Services
export {
    TapirTrackingService,
    type TapirTrackingServiceOptions,
    type TrackingExecutionResult
} from './node/spatial/TapirTrackingService';
export {
    GaussianSplat4DService,
    type CameraIntrinsicsInput,
    type Build4DFromCanonicalOptions
} from './node/3d-engine/gaussian-splat-4d-service';


