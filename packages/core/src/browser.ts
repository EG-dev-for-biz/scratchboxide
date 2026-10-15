/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

// 3D Geospatial & Google 3D Tiles Layer
export { GooglePhotorealistic3DTilesLayer } from './browser/generative-canvas/services/GooglePhotorealistic3DTilesLayer';
export type { Google3DTilesLayerOptions } from './browser/generative-canvas/services/GooglePhotorealistic3DTilesLayer';
export { Google3DTileService } from './browser/generative-canvas/services/Google3DTileService';
export { GoogleElevationService } from './browser/generative-canvas/services/google-elevation-service';
export type {
    ElevationPoint,
    ElevationResult,
    ElevationPathRequest,
    ElevationCacheEntry
} from './browser/generative-canvas/services/google-elevation-service';
export { GoogleSolarService } from './browser/generative-canvas/services/google-solar-service';
export type {
    SolarLatLng,
    SolarBoundingBox,
    RoofSegmentStats,
    WholeRoofStats,
    SolarPotential,
    BuildingInsightsResponse,
    DataLayersResponse,
    RoofTier,
    RoofFacet3D,
    GoogleSolarServiceOptions
} from './browser/generative-canvas/services/google-solar-service';
export { TerrainManager } from './browser/generative-canvas/services/TerrainManager';
export { TileClayProcessor, CLAY_PRESETS } from './browser/generative-canvas/services/TileClayProcessor';
export type { ClayPresetId } from './browser/generative-canvas/services/TileClayProcessor';

// Atmospheric Scattering & Diurnal Lighting Pipeline
export {
    AtmosphereService,
    createAtmosphericSkyDome,
    createAerialPerspectiveEffect,
    AerialPerspectiveEffect,
    createTerrainCloudShadows,
    TerrainCloudShadows,
    createVolumetricGodRays,
    VolumetricGodRays,
    calculateNOAASolarPosition,
    calculateENUSunVector,
    getSunVectorFromAngles,
    calculateJulianDay,
    classifyDiurnalPhase,
    computeDiurnalLightingProfile,
    getDiurnalLightingState,
    getPresetLightingState,
    kelvinToRGB,
    blackbodyKelvinToLinearRgb,
    marchVolumetrics,
    SphericalHarmonics9,
    henyeyGreensteinPhase,
    rayleighPhase,
    dualLobePhase,
    evaluateDensityAtHeight,
    computeBeerLambertTransmittance,
    computeInscatteringRadiance,
    evaluateAerialPerspective,
    AtmosphereImageEstimationService,
    fitPlanckianKelvinTemperature,
    computeSkyAtmosphereMetrics,
    WELL_KNOWN_ATMOSPHERE_LANDMARKS,
    LocationObjectLightingService,
    harmonizeLocationObjectAtmosphere,
    generateCanonicalAmbulatoryFixtures,
    STONE_ALBEDO_PROFILES,
    LOCATION_DELIGHT_FRAGMENT_CHUNK,
    LOCATION_DELIGHT_VERTEX_CHUNK,
    LOCATION_DELIGHT_VERTEX_BODY
} from './browser/generative-canvas/services/atmosphere';
export type {
    AtmosphericScatteringConfig,
    AtmosphericSkyDomeModule,
    AtmosphereHandle,
    AtmosphereServiceAttachOptions,
    DiurnalPhase,
    DiurnalLightingProfile,
    TimeOfDayPreset,
    SolarCoordinates,
    VolumetricGodRaysConfig,
    VolumetricGodRaysModule,
    VolumetricMedium,
    VolumetricResult,
    AerialPerspectiveOptions,
    CloudShadowConfig,
    ImageAtmospherePixelOptions,
    ImageAtmosphereRequest,
    AtmosphericEstimationResult,
    StoneType,
    DelightUniformsConfig,
    AtmosphereSceneLightingConfig,
    ArchitecturalPortalFixtureConfig,
    LocationObjectAtmosphereRequest,
    LocationObjectAtmosphereResult
} from './browser/generative-canvas/services/atmosphere';

// 3D Manipulation & Mesh Sculpting Engines
export {
    evaluateFalloff,
    applySculptStroke,
    MeshHistoryStack,
    createSculptableGeometry,
    recomputeGeometryNormals
} from './browser/generative-canvas/services/mesh-sculpting-engine';
export type { SculptBrushOptions } from './browser/generative-canvas/services/mesh-sculpting-engine';

export {
    TransformGizmoEngine,
    computeAxisTranslation,
    computePlaneTranslation,
    computeRotationAngle,
    computeScaleFactor
} from './browser/generative-canvas/services/transform-gizmo-engine';
export type { GizmoHandleType } from './browser/generative-canvas/services/transform-gizmo-engine';

export {
    DirectDispatchOperatorEngine,
    createOperatorEngine
} from './browser/generative-canvas/services/direct-dispatch-operator-engine';

// Client-Side Canvas Controllers & Transformers
export { ProjectArtifactController } from './browser/generative-canvas/project-artifact-controller';
export { morphArtifact } from './browser/generative-canvas/primitive-transformer-engine';

// Pro Video / NLE Compositor & Timeline Services
export * from './browser/generative-canvas/services/video';

// Universal COLMAP Vector Reference Pipeline & Dock (Zero Presets)
export { ColmapVectorPipeline } from './browser/generative-canvas/services/colmap-vector-pipeline';
export { ColmapVectorDockService } from './browser/generative-canvas/services/colmap-vector-dock-service';
export * from './common/spatial/colmap-vector-reference-types';

// WebXR Geospatial Spatial Services & Metric Anchor Bridge
export * from './browser/generative-canvas/services/xr';

// Optics & Brown-Conrady Lens Distortion Shader Engine
export {
    LensDistortionEffect,
    BrownConradyLensDistortionPass,
    LENS_DISTORTION_SHADER,
    LENS_OPTICAL_PRESETS,
    computeBrownConradyUV,
    calculateBrownConradyFromFocalLength
} from './browser/generative-canvas/services/optics/LensDistortionEffect';
export type {
    LensDistortionUniforms,
    LensDistortionConfig,
    LensOpticalProfile,
    LensDistortionMode,
    LensDistortionEdgeMode,
    LensDistortionFilterQuality
} from './browser/generative-canvas/services/optics/LensDistortionEffect';
export {
    VfxLensInterchangeService
} from './common/optics/VfxLensInterchangeService';
export type {
    VfxLensMetadata,
    OpenCvCameraCalibration
} from './common/optics/VfxLensInterchangeService';

// Nano Banana Color Transfer Pipeline (Method 2: Two-Step Extract-then-Apply)
export {
    NanoBananaColorService,
    buildExtractPalettePrompt,
    parseExtractedPalette,
    buildApplyPalettePrompt,
    formatPaletteAsMarkdown,
    executeTwoStepColorTransfer
} from './browser/generative-canvas/services/nano-banana-color-service';
export type {
    ExtractedColorTone,
    ShadowHighlightProfile,
    ExtractedColorPalette,
    ExtractPalettePromptOptions,
    ApplyPaletteOptions,
    TwoStepColorTransferOptions,
    ColorTransferPlan
} from './browser/generative-canvas/services/nano-banana-color-service';

// Spatial Generative Runtime Services & 5 Proprietary Moats
export * from './browser/generative-canvas/services/spatial';

// Cinematic Depth-of-Field & Bokeh Pass
export {
    CinematicBokehPass,
    generatePoissonDiskKernel
} from './browser/generative-canvas/services/optics/CinematicBokehPass';
export type {
    BokehPassParams,
    CinematicBokehPassOptions,
    CinematicBokehPassConfig,
    CinematicBokehUniforms
} from './browser/generative-canvas/services/optics/CinematicBokehPass';

// Concert Stage & 4D Gaussian Splatting Performer Service
export {
    ConcertStagePerformerService,
    PerformerSkinningMode,
    MUSIC_VENUE_PRESETS,
    SBHUMAN_22_JOINT_NAMES,
    SBHUMAN_22_PARENTS,
    DEFAULT_CANONICAL_JOINTS,
    type MusicVenuePreset,
    type ConcertStageOptions,
    type PerformerKinematicsFrame,
    type PerformerTelemetry
} from './browser/generative-canvas/services/ConcertStagePerformerService';

// Headless Realism & Filament PBR Extensions
export {
    evaluateGgxEnergyCompensation,
    applyFilamentEnergyCompensation,
    evaluateCharlieSheen,
    applyFilamentClothSheen,
    projectEquirectangularToSH,
    type GgxEnergyCompensationResult,
    type FilamentClothOptions,
    type ClothSheenEvaluation
} from './browser/generative-canvas/services/headless-realism-service';

// Universal Archie Building Structure Refinement & SB-Terrain Ground Engine
export {
    ArchieBuildingRefiner,
    smoothFacadeNormals,
    generateWatertightPlinth,
    createArchieMaterial,
    type ArchieMaterialParameters,
    type ArchieBuildingRefineOptions,
    type ArchieRefinedBuildingResult
} from './browser/generative-canvas/services/spatial/ArchieBuildingRefiner';

export {
    SbTerrainGroundEngine,
    measureSurfaceSlope,
    materialAtSlope,
    validateSlopeStops,
    type SlopeMaterialStop,
    type SurfaceSlopeMetrics,
    type SlopeMaterialResult
} from './browser/generative-canvas/services/spatial/SbTerrainGroundEngine';

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


// Procedural Micro-Surface Triplanar PBR Shaders
export {
    ProceduralMicroSurfaceShaderPatcher,
    resolveMicroSurfaceConfig,
    type MicroSurfacePreset,
    type ProceduralMicroSurfaceConfig,
    type MortarDeepeningConfig,
    type CavitationPoresConfig,
    type GlazeCrackleConfig
} from './browser/generative-canvas/services/spatial/ProceduralMicroSurfaceShaderPatcher';

// Next-Gen Astro Viewport Engine & Real WebGPU Compute Culling Pipeline
export {
    NextGenAstroViewportEngine,
    NextGenAstraViewportEngine,
    CULL_MESHLETS_WGSL,
    MICRO_RASTERIZER_WGSL,
    VISIBILITY_BUFFER_SHADING_WGSL,
    TEMPORAL_SUPER_RES_WGSL,
    RELIEF_MICRO_DISPLACEMENT_WGSL,
    CLUSTER_SLOT_SIZE_BYTES,
    VRAM_PAGE_POOL_SIZE_MB,
    TOTAL_RESIDENT_SLOTS,
    VIRTUAL_GEOMETRY_CAPACITY_TRIANGLES,
    type ViewportTelemetry,
    type MeshletCluster,
    type NextGenViewportOptions,
    type VirtualClusterSlot
} from './browser/generative-canvas/services/NextGenAstraViewportEngine';

export {
    WebGpuMeshletCullingPipeline,
    type WebGpuPipelineTelemetry,
    type FrustumPlane
} from './browser/generative-canvas/services/WebGpuMeshletCullingPipeline';






