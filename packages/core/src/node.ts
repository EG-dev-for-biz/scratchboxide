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
    MeshletPipelineService,
    type MeshletBuildOptions,
    type MeshletData,
    type GpuClusterDescriptor,
    type MeshletDAGResult,
    type WebGpuIndirectDrawArgs,
    type LODCutResult
} from './node/3d-engine/native-meshlet-service';
export {
    FieldAlignedQuadRemeshService,
    QuadRemeshServiceOptions,
    QuadRemeshMetrics,
    QuadRemeshResult
} from './node/3d-engine/field-remesh-service';
export { AdaptiveMaterialPbrService } from './node/3d-engine/adaptive-material-pbr-service';
export type {
    AdaptiveMaterialSchema,
    IntrinsicSignalMetrics,
    ContinuousBiophysicalFields,
    AdaptivePbrOptions,
    AdaptivePbrResult,
    AdaptiveAtlasTelemetry
} from './common/adaptive-material-types';
export {
    UniversalPbrBakingKernel,
    applyUniversalSleightOfHand,
    applyToksvigRoughnessCoupling,
    type UniversalTexelContext,
    type UniversalTexelOutput,
    type UniversalPbrOptions,
    type UniversalPbrTelemetry,
    type UniversalPbrResult
} from './node/3d-engine/universal-pbr-baking-kernel';
export {
    LivingFoliageKernel,
    synthesizeLivingFoliage,
    hash3D as livingFoliageHash3D,
    valueNoise3D as livingFoliageValueNoise3D,
    type LivingFoliageContext,
    type LivingFoliageOutput,
    type LivingFoliageOptions
} from './node/3d-engine/living-foliage-kernel';
export {
    VirtualBevelKernel,
    buildSubmeshAdjacency,
    pointSegmentDistance,
    evaluateGeometricNormal,
    type EdgeAdjacencyRecord,
    type TriangleGeometricFrame,
    type SubmeshAdjacencyGraph,
    type GeometricNormalResult
} from './node/3d-engine/virtual-bevel-kernel';
export {
    BotanicalVegetationService,
    BotanicalMode,
    LeafMorphologyType,
    BotanicalPipelineOptions,
    BotanicalPipelineTelemetry,
    BotanicalPipelineResult
} from './node/3d-engine/botanical-vegetation-service';
export {
    SbVeggieService,
    SmplTreeService
} from './node/3d-engine/sb-veggie-service';
export {
    type SbVeggieArchetype,
    type SbVeggieShapeParams,
    type SbVeggiePoseParams,
    type SbVeggiePhenologyParams,
    type SbVeggieShapingParams,
    type SbVeggieSynthesizeOptions,
    type SbVeggieInversionOptions,
    type SbVeggieInversionTelemetry,
    type SbVeggieTelemetry,
    type SbVeggieResult,
    type SmplTreeArchetype,
    type SmplTreeShapeParams,
    type SmplTreePoseParams,
    type SmplTreePhenologyParams,
    type SmplTreeSynthesizeOptions,
    type SmplTreeInversionOptions,
    type SmplInversionTelemetry,
    type SmplTreeTelemetry,
    type SmplTreeResult
} from './common/botanical/sb-veggie-protocol';
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
    NativeTilePathTracerService,
    TileShadingMode,
    TileViewLook,
    TileSunSpec,
    TileCameraSpec,
    TileAutoCameraSpec,
    TileAtmosphereSpec,
    TilePathTraceRequest,
    TilePathTraceStats,
    TilePathTraceResult
} from './node/3d-engine/native-tile-path-tracer-service';
export {
    ColmapReconstructionService,
    ColmapCameraModel,
    ColmapGlbOptions,
    ColmapReconstructionSummary,
    GlomapOptions,
    GlomapResult
} from './node/3d-engine/colmap-reconstruction-service';
export {
    NativeTileLightingService,
    type NativeSunEstimateOptions,
    type NativeSunEstimateResult,
    type NativeDelightOptions,
    type NativePerFaceMaterialResult,
    type NativeMaterialClassifyOptions
} from './node/3d-engine/native-tile-lighting-service';
export {
    NativeSkyService,
    type AtmosphereParameters,
    type PhysicalSkyOptions,
    type PhysicalSkyResult
} from './node/3d-engine/native-sky-service';
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
export { OccSoraBridge, S4DWorldModelBridge, S4DTrajectoryPrompt, S4DTrajectoryWaypoint, S4DInferenceRequest } from './node/spatial/S4DWorldModelBridge';
export { Synthetic4DDataGenerator, Synthetic4DGenerationConfig, Synthetic4DDatasetItem } from './node/spatial/Synthetic4DDataGenerator';

// Headless Video Compositor & Editor Services
export {
    HeadlessVideoCompositorService,
    CompositeJobRequest,
    CompositeJobResult
} from './node/video/HeadlessVideoCompositorService';

export {
    HeadlessVideoEditorService,
    VideoProbeResult,
    VideoFilterBakeConfig,
    QuickEditOptions,
    ExtractKeyframesOptions,
    SplitScreenOptions,
    ConcatClipsOptions,
    StoryboardSheetOptions,
    LutGradeOptions,
    ChromaKeyOptions,
    ConditioningMapOptions,
    MotionStabilizationOptions,
    SeamlessLoopOptions,
    AudioLoudnessOptions,
    AudioDuckingOptions,
    EncodeFrameSequenceOptions,
    VideoEditorJobResult,
    resolveBinary,
    toEven
} from './node/video/HeadlessVideoEditorService';

// MediaPipe Video Director Service (FFmpeg + MediaPipe + Gemini Coordination)
export {
    MediaPipeVideoDirectorService,
    TrackVideoMotionOptions,
    VideoMotionPoseFrame,
    VideoMotionTrackResult,
    AutoReframeOptions,
    ReframeWaypoint,
    AutoReframeResult,
    VisualCriticDimensionAudit,
    VisualCriticAuditOptions,
    VisualCriticAuditResult
} from './node/video/MediaPipeVideoDirectorService';

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
    getGoogle3DTilesClay,
    create3DTilesOrbitTrajectory,
    create3DTilesPushInTrajectory,
    runTileClayBlockoutRunner,
    type TileClayBlockoutRunnerRequest,
    type TileClayBlockoutRunnerResult
} from './node/spatial/Google3DTileBlockoutPipelineService';


// 2D Image-to-Image Color Transfer API (Standalone Service)
export {
    ImageColorTransferService,
    transferImageColor,
    type ImageColorTransferRequest,
    type ImageColorTransferResult,
    type LocalCielabOptions
} from './node/image/ImageColorTransferService';

// Professional Autonomous Color Grading & Matching Engine (ProColorGradeMatchingService)
export {
    ProColorGradeMatchingService,
    type PrimaryColorWheels,
    type PrimaryWheelChannel,
    type ColorGradeMatchOptions,
    type ColorGradeMatchResult,
    type ColoristScopesData,
    type SecondaryIsolationOptions
} from './node/image/ProColorGradeMatchingService';

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
export { SurveyApi, createSurveyRouter, createNodeHttpHandler, registerBeautifyHandlers } from './node/spatial/survey-router';
export type { SurveyApiDeps, SurveyJob } from './node/spatial/survey-router';
export { BeautifyStationService, warpStationImage, createGoogleStationImageGenerator } from './node/spatial/BeautifyStationService';
export type { StationImageGenerator, BeautifyStationOptions, BeautifyStationResult, BeautifyQc, StationWarp } from './node/spatial/BeautifyStationService';
export { ColosseumObjectSeparationService, type GeocodedPlaceEntity, type GeminiVisionBoundingBox, type SeparatedSceneObject, type ColosseumSeparationResult } from './node/spatial/ColosseumObjectSeparationService';
export { SurveySplatPipelineService } from './node/spatial/SurveySplatPipelineService';
export type { SurveySplatPipelineRequest, SurveySplatPipelineResult, SurveySplatStationReport } from './node/spatial/SurveySplatPipelineService';
export {
    Location3DGaussianSplatService,
    Location3DGSService,
    generateLocation3DGS,
    type Location3DGSRequest,
    type Location3DGSResult
} from './node/spatial/Location3DGaussianSplatService';
export { Splat3DTilesService } from './node/spatial/Splat3DTilesService';
export type { Splat3DTilesOptions, Splat3DTilesResult } from './node/spatial/Splat3DTilesService';
export { NeuralMicroDepthDisplacementService } from './node/spatial/NeuralMicroDepthDisplacementService';
export type { MicroDepthOptions, MicroDepthResult } from './node/spatial/NeuralMicroDepthDisplacementService';

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
    InverseLightingEstimatorService,
    type InverseLightingOptions,
    type InverseLightingResult
} from './node/spatial/InverseLightingEstimatorService';
export {
    ClosedLoopLightingOptimizerService,
    type ClosedLoopOptimizationOptions,
    type ClosedLoopLightingOptimizationResult
} from './node/spatial/ClosedLoopLightingOptimizerService';
export {
    PhotometricUsdBridgeService,
    matchLightingToReference,
    matchImageAndLightingToLocation,
    type UsdExportOptions,
    type UsdExportResult,
    type MaterialXExportOptions,
    type MatchLightingReferenceOptions,
    type MatchLightingReferenceResult,
    type MatchImageAndLightingToLocationOptions,
    type MatchImageAndLightingToLocationResult,
    type CameraUsdParameters
} from './node/spatial/PhotometricUsdBridgeService';


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
export {
    AdaptiveMatchmoveCalibrationService,
    type AdaptiveMatchmoveContext,
    type SpatialAnchorCorrespondence,
    type LensIntrinsicsProfile,
    type KeyframeCalibrationState,
    type TrajectoryFrameState,
    type SequenceMetrologyReport,
    type OptimizationOptions as AdaptiveOptimizationOptions,
    type PoseAnchorExtractionOptions,
    AdaptiveKeyframeDensityOptimizer,
    type MotionAdaptiveConfig,
    type KeyframeSelectionResult,
    type TrajectoryInputPoint,
    type SelectedKeyframeAnchor
} from './node/spatial/AdaptiveMatchmoveCalibrationService';
export {
    ADAPTIVE_MATCHMOVE_TOOL_DECLARATIONS,
    adaptiveMatchmoveHandlers
} from './node/gemini/tools/adaptive-matchmove-tools';

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
// 4DAnyone & Video-to-Performer 4D Projection Pipeline Services
export {
    Dynamic4DGaussianSplatService,
    type HumanoidMotionData,
    type HumanoidMotionFrame,
    type SkinWeightedGaussian,
    type DeformedGaussianFrame,
    type Avatar4DGSDetails
} from './node/3d-engine/Dynamic4DGaussianSplatService';
export {
    HumanoidMotionBridgeService,
    type RetargetOptions,
    type PoseTrackRetargetOptions
} from './node/spatial/HumanoidMotionBridgeService';
export {
    GvhmrBodyService,
    type GvhmrBody,
    type GvhmrCanonicalAvatar
} from './node/spatial/GvhmrBodyService';
export {
    PerformerPoseTrackService,
    type PerformerPoseTrack,
    type PerformerPoseTrackFrame,
    type PoseLandmarkTuple
} from './node/spatial/PerformerPoseTrackService';
export {
    SbHumanLoader,
    type SbHumanHeader,
    type SbHumanJoint,
    type SbHumanSkinWeight,
    type SampledHumanoidSurface
} from './common/spatial/SbHumanLoader';
export {
    VideoTo4DPerformerPipelineService,
    type VideoTo4DPerformerOptions,
    type VideoTo4DPerformerResult,
    type SilhouetteExtractionResult,
    type CanonicalGaussiansResult,
    SMPLX_22_JOINTS
} from './node/spatial/VideoTo4DPerformerPipelineService';
export {
    CharacterClothingMorphology,
    type CharacterClothingMorphologyOptions
} from './node/spatial/CharacterClothingMorphology';
export {
    NerfstudioDatasetService,
    type NerfstudioFrame,
    type NerfstudioTransforms,
    type NerfstudioIntrinsics,
    type OrbitalCameraRigItem,
    type CameraObservationInput,
    type ExportNerfstudioOptions,
    type ExportNerfstudioResult,
    NERFSTUDIO_MASK_THRESHOLD
} from './node/spatial/NerfstudioDatasetService';

// Google Solar API dataLayers & Multi-Class Foliage Segmentation
export {
    GeoTiffRasterParser,
    TIFF_TAGS,
    TIFF_TYPES,
    type DecodedTiffIfd
} from './node/spatial/GeoTiffRasterParser';
export {
    GoogleSolarFoliageClassifier
} from './node/spatial/GoogleSolarFoliageClassifier';

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

// Spatial & Vision Node Services
export {
    TextureCompressionService,
    type TextureMapType,
    type TextureCompressionOptions,
    type TextureCompressionResult,
    type GlbCompressionStats,
    type GlbCompressionOptions
} from './node/texture-compression-service';
export {
    Colosseum3DMeshSeparatorService,
    COLOSSEUM_3D_ENTITIES,
    COLOSSEUM_GRANULAR_3D_ENTITIES,
    COLOSSEUM_TOTAL_IDENTIFIABLE_ENTITIES,
    generateTotalIdentifiableEntities,
    type Separated3DObject,
    type Separated3DScene,
    type BoundingBox3DMetric,
    type SpatialEntityDefinition,
    type SpatialCategory
} from './node/spatial/Colosseum3DMeshSeparatorService';
export {
    OrientedBoundingBoxSolver,
    type OrientedBoundingBox3D,
    type DualBoundingBoxResult
} from './node/spatial/OrientedBoundingBoxSolver';
export {
    GeminiMultimodalObjectDetectorService,
    type GeminiDetectedObject2D,
    type GeminiObjectDetectionTelemetry,
    type GeminiDetectionResult
} from './node/spatial/GeminiMultimodalObjectDetectorService';
export {
    StreetViewRestyleService,
    STREET_VIEW_RESTYLE_MODEL,
    buildStreetViewRestylePrompt,
    buildStreetViewLightingDescription,
    compositeWithinRegions,
    removedObjectRegions,
    type StreetViewLighting,
    type StreetViewRestyleRequest,
    type StreetViewRestyleResult,
    type StreetViewShotRequest,
    type StreetViewShot,
    type PixelRegion
} from './node/spatial/StreetViewRestyleService';
export {
    OmniVideoService,
    OMNI_VIDEO_MODEL,
    buildBlockoutFirstLastPrompt,
    type OmniMedia,
    type OmniBlockoutRequest,
    type OmniVideoResult,
    type OmniVideoServiceOptions,
    type OmniVideoTask,
    type BlockoutPromptOptions
} from './node/video/OmniVideoService';
export {
    ContinuousSplineMatchmoveService,
    type SplineKnot,
    type EvaluatedPose,
    type PersistentTrack3D2D,
    type SplineAnchorConstraint,
    type ContinuousSplineSolveOptions,
    type SplineOptimizationResult,
    type DenseTrajectoryFrame
} from './node/spatial/ContinuousSplineMatchmoveService';
export {
    MatchmoveApi,
    createMatchmoveRouter,
    createMatchmoveNodeHttpHandler,
    type MatchmoveCapabilitiesResponse
} from './node/spatial/matchmove-router';

// SB-Archi Monumental Architecture Inversion Service
export {
    SbArchiService,
    type SbArchiInversionOptions,
    type SbArchiTelemetry,
    type SbArchiInversionResult,
    type ArchConstantineOptions,
    type ArchConstantineResult,
    type TectonicAnalysisReport
} from './node/3d-engine/sb-archi-service';

// SB-Veggie Universal Botanical Bridge Service
export {
    UniversalBotanicalBridgeService,
    type SupportedTreeSpecies,
    type BotanicalSpeciesAdapter,
    SPECIES_ADAPTERS,
    type SpatialTreeEntity,
    type TreeSynthesisBridgeOptions,
    type TreeSynthesisBridgeResult
} from './node/spatial/UniversalBotanicalBridgeService';

// SB-Archi Universal Architectural Bridge Service
export {
    UniversalArchiBridgeService,
    type SupportedArchiTypology,
    type ArchiTypologyAdapter,
    ARCHI_TYPOLOGY_ADAPTERS,
    type SpatialArchiEntity,
    type ArchiSynthesisBridgeOptions,
    type ArchiSynthesisBridgeResult,
    generateProceduralArchiGlb
} from './node/spatial/UniversalArchiBridgeService';

// Universal 3D Object Separation & Visual Alignment Verification Services
export {
    Universal3DObjectSeparationService,
    type UniversalSpatialCategory,
    type DownstreamGeneratorRouting,
    type UniversalSeparatedObject,
    type UniversalSeparatedScene,
    type UniversalSeparationOptions,
    type UniversalSeparationAndSceneResult
} from './node/spatial/Universal3DObjectSeparationService';

export {
    SpatialVisualAlignmentVerificationService,
    type AlignmentVerificationRequest,
    type AlignmentVerificationReport,
    type EdgeOverlapResult,
    type MetrologyCertificationParams,
    type MetrologyCertificate
} from './node/spatial/SpatialVisualAlignmentVerificationService';

// Adaptive Domain Style Shader API, Schema & Deconstruct Services
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
export {
    AdaptiveStyleDeconstructionService
} from './node/spatial/AdaptiveStyleDeconstructionService';
export type {
    DeconstructionOptions
} from './node/spatial/AdaptiveStyleDeconstructionService';



