# Scratchbox IDE — Comprehensive Codebase API & Engine Ledger

> **Status**: Living Architectural Ledger & Completed API Index  
> **Repository**: `scratchbox-ide` (`packages/core`, `desktop-app`, `packages/cli`)  
> **Last Updated**: 2026-10-02

This ledger provides an exhaustive index of all completed APIs, services, operators, agent tools, REST endpoints, CLI commands, and native C++ modules built across Scratchbox IDE, followed by an architectural blueprint for how they interlock as an end-to-end pipeline for Visual Effects (VFX), Virtual Production, and Generative Spatial Video.

> **Looking for the external API?** This ledger covers *internal* implementation — services, operators, and the in-app Gemini agent tool registry. For the contract other apps/agents use to call into Scratchbox Studio over MCP, see [docs/integrations/mcp/README.md](integrations/mcp/README.md).

---

## Table of Contents

1. [Core TypeScript Services & SDK (@scratchbox/core)](#1-core-typescript-services--sdk-scratchboxcore)
   - [3D Geospatial, Google 3D Tiles & Environment](#3d-geospatial-google-3d-tiles--environment)
   - [Atmospheric Scattering, Ephemeris & Radiometric Lighting](#atmospheric-scattering-ephemeris--radiometric-lighting)
   - [Optics, Lens Distortion & Physical Cameras](#optics-lens-distortion--physical-cameras)
   - [6-DOF Camera Resection, Tracking & Matchmoving](#6-dof-camera-resection-tracking--matchmoving)
   - [4D Gaussian Splatting & Parametric Humanoids (Performer 4DGS / SB-Human)](#4d-gaussian-splatting--parametric-humanoids-performer-4dgs--sb-human)
   - [Universal Tile Decomposition & Mesh Engineering (UTDRA / ULDRA)](#universal-tile-decomposition--mesh-engineering-utdra--uldra)
   - [PBR Materials, Texture Baking & Algorithmic UV Rewrapping](#pbr-materials-texture-baking--algorithmic-uv-rewrapping)
   - [Parametric Botany & Architecture (SB-Veggie & SB-Archi)](#parametric-botany--architecture-sb-veggie--sb-archi)
   - [360° Gigapixel Panoramas & Zenith/Nadir Synthesis](#360-gigapixel-panoramas--zenithnadir-synthesis)
   - [Pro NLE Video Compositor, Timeline & FFmpeg Processing](#pro-nle-video-compositor-timeline--ffmpeg-processing)
   - [Survey Station Synthesis & AI Beautify](#survey-station-synthesis--ai-beautify)
   - [WebXR Metric Geospatial Bridge](#webxr-metric-geospatial-bridge)
   - [Autonomous Intelligence & DeepWrite](#autonomous-intelligence--deepwrite)
   - [Canvas Primitives & Codebase Lenses](#canvas-primitives--codebase-lenses)
2. [Gemini Agent Tool Suite (In-App Tool Registry)](#2-gemini-agent-tool-suite-in-app-tool-registry)
3. [Direct-Dispatch Canvas Operators (Three.js Stage Engine)](#3-direct-dispatch-canvas-operators-threejs-stage-engine)
4. [Desktop App REST API Endpoints (Server & Routers)](#4-desktop-app-rest-api-endpoints-server--routers)
5. [Native C++20 Astro 3D Engine Modules](#5-native-c20-astro-3d-engine-modules)
6. [Scratchbox CLI (`sbox`) Commands](#6-scratchbox-cli-sbox-commands)
7. [VFX Pipeline Integration Architecture: How Everything Fits Together](#7-vfx-pipeline-integration-architecture-how-everything-fits-together)

---

## 1. Core TypeScript Services & SDK (@scratchbox/core)

Exported through `@scratchbox/core`, `@scratchbox/core/node`, `@scratchbox/core/browser`, and `@scratchbox/core/common`.

### 3D Geospatial, Google 3D Tiles & Environment
- **`Google3DTileBlockoutPipelineService`** (`packages/core/src/node/spatial/Google3DTileBlockoutPipelineService.ts`)
  - `getGoogle3DTilesFullTexture(queryOrCoords, options)`: Ingests photogrammetric textured mesh at leaf LOD ($\le 0.5$ error target) and packages standard binary glTF 2.0 (`.glb`).
  - `getGoogle3DTilesClay(queryOrCoords, options)`: Ingests studio grey clay massing without baked lighting.
  - `runTileClayBlockoutRunner(req)`: Headless Chrome runner rendering 72-frame orbital/canyon camera trajectories and start frame PNG `<IMAGE_REF_0>`.
  - `create3DTilesTrajectory`, `create3DTilesOrbitTrajectory`, `create3DTilesPushInTrajectory`.
- **`GooglePhotorealistic3DTilesLayer`** (`packages/core/src/browser/generative-canvas/services/GooglePhotorealistic3DTilesLayer.ts`): Client-side 3D Tiles renderer with high-altitude zenith rigs and SSE budget controls.
- **`Google3DTileService`** (`packages/core/src/browser/generative-canvas/services/Google3DTileService.ts`): Tile session and runtime lifecycle orchestrator.
- **`GoogleElevationService`** (`packages/core/src/browser/generative-canvas/services/google-elevation-service.ts`): Samples elevation profiles and geoid undulation grids along flight paths.
- **`GoogleSolarService`** (`packages/core/src/browser/generative-canvas/services/google-solar-service.ts`): Building insights, roof segment pitches, azimuths, and 3D facet meshes.
- **`TerrainManager`** (`packages/core/src/browser/generative-canvas/services/TerrainManager.ts`): High-speed elevation heightfield collider and surface snapping.
- **`TileClayProcessor`** (`packages/core/src/browser/generative-canvas/services/TileClayProcessor.ts`): Shaders and material overrides for architectural clay blockouts (`CLAY_PRESETS`).
- **`Google3DTileCrawlerBaker`** (`packages/core/src/node/spatial/Google3DTileCrawlerBaker.ts`): Crawls 3D tile hierarchies and bakes multi-tile geographic bounding volumes into unified scenes.

### Atmospheric Scattering, Ephemeris & Radiometric Lighting
- **`AtmosphereService`** (`packages/core/src/browser/generative-canvas/services/atmosphere/AtmosphereService.ts`): Unified coordinator for physical atmospheric rendering.
  - `calculateNOAASolarPosition(lat, lng, date)`: Sub-arcminute solar azimuth and elevation.
  - `computeDiurnalLightingProfile(elevationDeg, turbidity)`: Kelvin blackbody color temp ($1,000\text{K} - 40,000\text{K}$), direct solar lux, ambient bounce.
  - `classifyDiurnalPhase(elevationDeg)`: Classifies 10 natural diurnal phases (astronomical, nautical, civil dawn/dusk, golden hour, solar noon, etc.).
  - `kelvinToRGB`, `blackbodyKelvinToLinearRgb`: Exact Planckian radiant spectral integration.
- **`AtmosphericSkyDome`** (`packages/core/src/browser/generative-canvas/services/atmosphere/AtmosphericSkyDome.ts`): Real-time Preetham/Bruneton Rayleigh ($\lambda^{-4}$) and Mie phase sky dome.
- **`AerialPerspectiveEffect`** (`packages/core/src/browser/generative-canvas/services/atmosphere/AerialPerspectiveEffect.ts`): Multi-spectral Beer-Lambert distance extinction $T(s) = \exp(-\beta_{\text{ext}} \cdot s)$ with height stratification.
- **`TerrainCloudShadows`** (`packages/core/src/browser/generative-canvas/services/atmosphere/TerrainCloudShadows.ts`): Analytical solar projection of dynamic cloud lattices onto 3D ground geometry.
- **`VolumetricGodRays`** (`packages/core/src/browser/generative-canvas/services/atmosphere/VolumetricGodRays.ts`): Radial screen-space Crepuscular shaft pass driven by sun vector occlusions.
- **`LocationObjectLightingService`** (`packages/core/src/browser/generative-canvas/services/atmosphere/LocationObjectLightingService.ts`):
  - `harmonizeLocationObjectAtmosphere`: Analytical GLSL de-lighting chunks (shadow lifting, highlight compression, calibrated albedos: travertine, limestone, marble).
  - `generateCanonicalAmbulatoryFixtures`: Places $2,850\text{K}$ incandescent portal fixtures in architectural window apertures.
- **`AtmosphereImageEstimationService`** (`packages/core/src/browser/generative-canvas/services/atmosphere/AtmosphereImageEstimationService.ts`): Inverse estimates solar position and sky turbidity from photographic plates.

### Optics, Lens Distortion & Physical Cameras
- **`LensDistortionEffect`** & **`BrownConradyLensDistortionPass`** (`packages/core/src/browser/generative-canvas/services/optics/LensDistortionEffect.ts`):
  - Brown-Conrady polynomial radial and tangential distortion engine ($k_1, k_2, p_1, p_2$).
  - Undistort / redistort GLSL post-process passes.
- **`VfxLensInterchangeService`** (`packages/core/src/common/optics/VfxLensInterchangeService.ts`): Bidirectional interchange format for OpenCV, Nuke, 3DEqualizer, and SynthEyes lens calibration profiles.
- **`PhysicalCameraModel`** (`packages/core/src/common/optics/PhysicalCameraModel.ts`): Full-frame, Super 35, IMAX, and custom sensor gates; computes circle of confusion, hyperfocal distances, and optical focal breathing.
- **`CinematicBokehPass`** (`packages/core/src/browser/generative-canvas/services/optics/CinematicBokehPass.ts`): Poisson-disk sampling depth-of-field kernel with anamorphic bokeh weighting.

### 6-DOF Camera Resection, Tracking & Matchmoving
- **`SpatialPoseEstimatorService`** (`packages/core/src/node/spatial/SpatialPoseEstimatorService.ts`):
  - `solvePnP`: Direct Linear Transform (DLT) with SVD matrix decomposition + Levenberg-Marquardt non-linear least squares.
  - `solvePnPRansac`: Minimal 4-point consensus outlier rejection ($< 0.05\text{ px RMS}$ residual).
- **`VisualFeatureMatcherService`** (`packages/core/src/node/spatial/VisualFeatureMatcherService.ts`): 2D Harris/FAST corner detection, 128-D patch descriptors, Lowe ratio matching ($< 0.75$), and 3D surface depth unprojection.
- **`SubPixelEdgeAlignmentOptimizer`** (`packages/core/src/node/spatial/SubPixelEdgeAlignmentOptimizer.ts`): Iterative coordinate descent edge alignment optimizing Sobel edge fields against dynamic offscreen silhouettes ($\ge 98\%$ overlap).
- **`HeadlessMeshSilhouetteRenderer`** (`packages/core/src/node/spatial/HeadlessMeshSilhouetteRenderer.ts`): Pure Node.js software rasterizer executing 3D triangle projections in $< 5\text{ms}$ per pose.
- **`GeoBoxPrecisionResectionService`** (`packages/core/src/node/spatial/GeoBoxPrecisionResectionService.ts`): End-to-end photograph-to-geographic 6-DOF camera pose solver.
- **`AdaptiveMatchmoveCalibrationService`** (`packages/core/src/node/spatial/AdaptiveMatchmoveCalibrationService.ts`): Multi-milestone sequence bundle adjustment and non-uniform $C^2$ Hermite spline trajectory generator.
- **`AdaptiveKeyframeDensityOptimizer`** (`packages/core/src/node/spatial/AdaptiveKeyframeDensityOptimizer.ts`): Dynamic keyframe placement based on angular and translational camera velocity.
- **`GeoCameraMatchmovePipelineService`** (`packages/core/src/node/spatial/GeoCameraMatchmovePipelineService.ts`): High-level plate-to-landmark matchmove runner.
- **`DynamicVideoTrajectorySolver`** (`packages/core/src/node/spatial/DynamicVideoTrajectorySolver.ts`): Solves smooth 6-DOF trajectories between anchor keyframes with boundary constraints.
- **`VanishingPointHorizonEstimator`** (`packages/core/src/node/spatial/VanishingPointHorizonEstimator.ts`): 3-point vanishing perspective analysis for camera pitch and roll estimation.
- **`TapirTrackingService`** (`packages/core/src/node/spatial/TapirTrackingService.ts`): Google DeepMind TAPIR dense point tracking integration for tracking physical feature points across frames.

### 4D Gaussian Splatting & Parametric Humanoids (Performer 4DGS / SB-Human)
- **`Dynamic4DGaussianSplatService`** (`packages/core/src/node/3d-engine/Dynamic4DGaussianSplatService.ts`):
  - 4-bone partition-of-unity Linear Blend Skinning (LBS) for dynamic Gaussians.
  - Streaming real-time deformed Gaussian point clouds at 60 FPS.
- **`VideoTo4DPerformerPipelineService`** (`packages/core/src/node/spatial/VideoTo4DPerformerPipelineService.ts`):
  - Ingests casual video, runs Google Veo 2 / multi-view synthesis, BiRefNet silhouette extraction, visual-hull carving, and fits SB-Human 22-joint canonical splat representations.
- **`HumanoidMotionBridgeService`** (`packages/core/src/node/spatial/HumanoidMotionBridgeService.ts`): Retargets MediaPipe 33-landmark and GVHMR 3D kinematics into the canonical SB-Human 22-joint kinematic skeleton.
- **`GvhmrBodyService`** (`packages/core/src/node/spatial/GvhmrBodyService.ts`): 3D human body mesh and trajectory extraction from monocular video.
- **`PerformerPoseTrackService`** (`packages/core/src/node/spatial/PerformerPoseTrackService.ts`): Trajectory filtering, velocity smoothing, and foot-sliding contact clamping.
- **`SbHumanLoader`** (`packages/core/src/common/spatial/SbHumanLoader.ts`): Serializes/deserializes `.sbhuman` binary skinning assets (header, joints, 4-bone skin weights, canonical Gaussian positions).
- **`CharacterClothingMorphology`** (`packages/core/src/node/spatial/CharacterClothingMorphology.ts`): Models loose clothing offset fields and drape deformation vectors.
- **`MultiviewCloudService`** (`packages/core/src/node/spatial/MultiviewCloudService.ts`): Google Cloud Run NVIDIA L4 GPU dispatcher for dense neural 4D avatar training.
- **`gaussian-ply-codec`** (`packages/core/src/common/gaussian-ply-codec.ts`): High-speed binary PLY encoder/decoder supporting Spherical Harmonics degree 0-3, scale, rotation quaternions, and opacity.
- **`NerfstudioDatasetService`** (`packages/core/src/node/spatial/NerfstudioDatasetService.ts`): Universal interchange serializer (`transforms.json`, `sparse_pcd.ply`, `images/`, `masks/`) with OpenGL $\leftrightarrow$ OpenCV coordinate transform matrices and visual-hull voxel carving.
- **`SplatService`** & **`ImageToSplatService`** (`packages/core/src/node/3d-engine/splat-service.ts`): 3D Gaussian Splatting conversion, PLY optimization, and viewing utilities.
- **`Depthbox360UniverseService`** (`packages/core/src/node/3d-engine/depthbox-360-universe-service.ts`): Multi-layer 360° spherical depth splatting for immersive backgrounds.

### Universal Tile Decomposition & Mesh Engineering (UTDRA / ULDRA)
- **`UniversalTileDecompositionService`** (`packages/core/src/node/3d-engine/universal-tile-decomposition-service.ts`):
  - `probeTile`: Measures a given tile (bounds, relief, surface area by slope band, wall orientation, vertex-colour green index). It classifies nothing and reports no confidence.
  - `sliceElevation`: Keeps the part above an elevation, clipping straddling triangles (Sutherland-Hodgman).
  - `carveBridgeUnderpass`: Removes the near-vertical triangles inside a span box the caller gives (deck footprint, ground and deck heights); it does not find bridges itself.
  - Outputs keep the input's own material; GLBs the native reader would misread (transforms, several materials, textures) are refused.
- **`NativeMeshReshaperService`** (`packages/core/src/node/3d-engine/native-mesh-reshaper-service.ts`): C++20 Astro engine deformation runner (taper, twist, bend, bulge, squash, shear, FFD tensor lattices, sculpt brushes).
- **`FieldAlignedQuadRemeshService`** (`packages/core/src/node/3d-engine/field-remesh-service.ts`): 4-RoSy directional cross-field calculation and quad-dominant remeshing.
- **`PhotorealTileCleanupService`** (`packages/core/src/node/3d-engine/tile-cleanup-service.ts`): Decimates coplanar triangles, repairs non-manifold seams, and removes floating geometry.

### PBR Materials, Texture Baking & Algorithmic UV Rewrapping
- **`AdaptiveMaterialPbrService`** (`packages/core/src/node/3d-engine/adaptive-material-pbr-service.ts`): Dynamically resolves material albedos, roughness, and metalness without static presets.
- **`UniversalPbrBakingKernel`** (`packages/core/src/node/3d-engine/universal-pbr-baking-kernel.ts`): High-resolution normal/roughness map baking with Toksvig roughness coupling for anti-aliasing.
- **`LivingFoliageKernel`** (`packages/core/src/node/3d-engine/living-foliage-kernel.ts`): Synthesizes continuous chlorophyll albedos, subsurface translucency, and wind flutter vectors.
- **`VirtualBevelKernel`** (`packages/core/src/node/3d-engine/virtual-bevel-kernel.ts`): Screen-space and object-space normal-map beveling along sharp triangle boundaries.
- **`TextureCompressionService`** (`packages/core/src/node/texture-compression-service.ts`): Compresses PBR textures and GLB files using Basis Universal, KTX2, and Draco geometric compression.
- **`GlbTextureRecolorService`** (`packages/core/src/node/spatial/GlbTextureRecolorService.ts`): In-place material segmentation in CIELAB space with PBR synthesis.
- **`AlgorithmicUvEngine`** (`packages/core/src/node/spatial/AlgorithmicUvEngine.ts`): Seam cutting, conformal parameterization, and inverse barycentric UV rewrapping.
- **`MaxRectsAtlasPacker`** (`packages/core/src/node/spatial/TextureAtlasPacker.ts`): 2D texture packing engine minimizing UV wastage.
- **`SurveyTextureUnprojector`** (SAIP) (`packages/core/src/node/spatial/SurveyTextureUnprojector.ts`): Survey-to-Atlas Inverse Projection unprojecting multi-station photograph plates onto 3D mesh atlases.

### Parametric Botany & Architecture (SB-Veggie & SB-Archi)
- **`SbVeggieService`** & **`BotanicalVegetationService`** (`packages/core/src/node/3d-engine/sb-veggie-service.ts`):
  - Parametric synthesis of tree species (Pine, Cypress, Oak, Birch, Palm, Olive).
  - Phenological seasonal states (spring bud, summer lush, autumn senescent, winter bare).
  - Inverse parameter fitting from 3D point clouds and photographs.
- **`TileVegetationService`** (`packages/core/src/node/3d-engine/tile-vegetation-service.ts`): Measures tree crowns in photo-textured Google 3D Tiles (strip: removes them and closes the ground) and regrows one SB-Veggie space-colonisation tree per measured crown within a triangle budget (plant); orchestrated with tile_refine by `runLocationClayPipeline` (`location-clay-pipeline.ts`).
- **Staged location build** (`packages/core/src/node/3d-engine/staged-location/`): `runStagedLocation` (`orchestrator.ts`) runs `google_3d_tiles_get_clay`'s remesh path as committed stages (resolve, tiles, trees-measure, remesh, then for an isolated structure fit, evidence, project, vision, correct, detail beside the trees), each streamed through `ToolContext.emitStage`, with a degrade ladder that always keeps the earlier stages and the same real data (`DegradationRecord`s in the result, the scene state and the digest). `runStagedLocationTool` / `createStagedLocationDeps` (`staged-location-tool.ts`) wire it to the Places geocoder, the leaf crawler (`GoogleTileDistrictCrawler.buildDistrictGlb` writes run-independent node extras and a `geometryOnly` first layer, `downloadLeaves` reports completion ranks), tile_vegetation, tile_refine, the scan fitter when present (`scan-fit-loader.ts`), Street View evidence through `StreetViewGroundingImageService` only (`streetview-evidence.ts`, in memory, never on disk), and the vision chain (`vision-model-chain.ts`, default `gemini-4-argon` at LOW thinking, `ornament-vision.ts`). Also `stage-cache.ts` (atomic entries and publishing, negative entries, run records for `retryRunId`), `extraction-sizing.ts` (request-sized extraction and the one structure pick), `staged-artifact.ts` (one scene id and one fixed camera), `staged-summary.ts` (digest, summary rules, `stagedBuildContext`), `scanned-trees.ts` (the failed tree stage puts the scanned trees back), `remesh-provenance.ts` (tile_refine's per-vertex provenance, read in bands), and `native-warmup.ts` (`warmNativeEngine`, after the server listens). Process: `docs/processes/staged-location-builds.md`.
- **`SbArchiService`** (`packages/core/src/node/3d-engine/sb-archi-service.ts`):
  - Classical architectural order generator (Doric, Ionic, Corinthian, Tuscan, Composite).
  - Monumental structural inversion (Arch of Constantine, Colosseum arches, entablatures, peristyles).
- **`UniversalArchiBridgeService`** (`packages/core/src/node/spatial/UniversalArchiBridgeService.ts`): Integrates classical architectural components directly into geospatial coordinates.
- **`Colosseum3DMeshSeparatorService`** & **`ColosseumObjectSeparationService`** (`packages/core/src/node/spatial/Colosseum3DMeshSeparatorService.ts`): Decomposes massive complex photogrammetric sites into individual semantic 3D objects with oriented bounding boxes.

### 360° Gigapixel Panoramas & Zenith/Nadir Synthesis
- **`Google360PanoramaPipelineService`** (`packages/core/src/node/spatial/Google360PanoramaPipelineService.ts`):
  - `healPanoramaSeam`: Blends left/right boundary discontinuities in equirectangular rasters.
  - `inpaintPanorama`: Inpaints ground tripods or occlusion voids.
  - `generate4KMonumentalPanorama`: Multimodal synthesis of 4K/8K panoramas.
  - `reprojectZenithPanorama`: Cubic-to-equirectangular reprojection repairing sky polar pinching.
  - `upscalePanorama16K`: 16K gigapixel upscaling pass.
- **`MultiPerspectivePanoramaSynthesisService`** (`packages/core/src/node/spatial/MultiPerspectivePanoramaSynthesisService.ts`): Extracts rectilinear perspective camera frustums at arbitrary azimuths and elevations.

### Pro NLE Video Compositor, Timeline & FFmpeg Processing
- **`VideoCompositor`** & **`Video3DLayerRenderer`** (`packages/core/src/browser/generative-canvas/services/video/`): Real-time multi-track WebGL/WebGPU compositor blending 3D viewports, live video plates, and anti-drift holdout mattes (`destination-out`).
- **`videoTimelineSynthesizer`**, **`rationalTime`**, **`timecode`**, **`otioSerializer`**: Frame-accurate NLE timeline data structures with OpenTimelineIO interchange.
- **`HeadlessVideoEditorService`** (`packages/core/src/node/video/HeadlessVideoEditorService.ts`):
  - Safe FFmpeg execution: clip extraction, 50/50 comparison splits, 3D LUT grading (.cube), chromakeying, ControlNet conditioning maps (depth/canny/openpose), seamless looping, and EBU R128 loudness normalization.
- **`HeadlessVideoCompositorService`** (`packages/core/src/node/video/HeadlessVideoCompositorService.ts`): Server-side timeline rendering and frame stacking.
- **`MediaPipeVideoDirectorService`** (`packages/core/src/node/video/MediaPipeVideoDirectorService.ts`): Autonomous camera framing, subject tracking, and the 8-Dimension Visual Critic audit.
- **`omniVideoPromptService`** (`packages/core/src/browser/generative-canvas/services/video/omniVideoPromptService.ts`):
  - `buildNeutralPerformerPrompt`: Head-to-toe, flat studio, `#808080` shadowless lighting, symmetrical A-pose prompt builder.
  - `buildFrameMotivatedPerformerVideoPrompt`: Closed-loop (`<FIRST_FRAME>` + `<LAST_FRAME>`) video conditioning syntax for Google Veo 2 (`veo-2.0-generate-001`) / multi-view.
  - `buildBeautifyPrompt`: Location beautification prompt maintaining 1:1 camera parameters.

### Survey Station Synthesis & AI Beautify
- **`SurveySynthesisEngine`** (`packages/core/src/common/spatial/SurveySynthesisEngine.ts`): Solves optimal pinhole camera stations around physical structures.
- **`SurveyStationRenderService`** (`packages/core/src/node/spatial/SurveyStationRenderService.ts`): Headless multi-station blockout rendering with solar ephemeris grounding.
- **`BeautifyStationService`** (`packages/core/src/node/spatial/BeautifyStationService.ts`): Warps AI-beautified images back into geometric spatial alignment.
- **`SurveySplatPipelineService`** (`packages/core/src/node/spatial/SurveySplatPipelineService.ts`): Bakes beautified station photographs into dense 3D Gaussian Splats.
- **`Location3DGaussianSplatService`** (`packages/core/src/node/spatial/Location3DGaussianSplatService.ts`): Unified end-to-end facade service and standalone functional API (`generateLocation3DGS`) synthesizing location 3DGS radiance fields with implicit Nano Banana multi-station restyling, C++20 metric depth unprojection, OGC 3D Tiles packaging, and direct Three.js 3D viewport mounting.

### WebXR Metric Geospatial Bridge
- **`WebXRGeospatialAnchorBridge`** (`packages/core/src/browser/generative-canvas/services/xr/WebXRGeospatialAnchorBridge.ts`):
  - Bidirectional coordinate transformation: WGS-84 (lat/lng/alt) $\leftrightarrow$ ENU Cartesian $\leftrightarrow$ WebXR `local-floor` (+Y Up, 1 unit = 1m).
  - Sensor fusion: fuses GPS fixes, hardware compass heading, and 6-DOF viewer poses.
  - Manual optical pin zero-drift calibration.
  - Vector projection: projects Google Maps Platform road corridors and parcel boundaries into 3D metric meshes.

### Autonomous Intelligence & DeepWrite
- **`GeminiService`** (`packages/core/src/node/gemini-service.ts`): Multimodal reasoning, tool dispatch, and streaming.
- **`TaskCapabilityResolver`** (`packages/core/src/node/agent/task-capability-resolver.ts`): Pre-flight task-domain classification that selects tool packs and reports `canSolveNatively: false` for unsupported neural tasks.
- **`DeepWriteService`** & **`DynamicDagPlanner`** (`packages/core/src/node/deep-write/`): Multi-file autonomous code generation, scaffold planning, and verification loops.
- **`LongRunningAgentService`** & **`SubagentPoolService`** (`packages/core/src/node/`): Spawns, monitors, and compacts background agent contexts.

### Canvas Primitives & Codebase Lenses
- **8 Core Visual Primitives**: `Scene3DPrimitive`, `VideoTimelinePrimitive`, `LiveCodeSandboxPrimitive`, `NodeGraphPrimitive`, `KanbanBoardPrimitive`, `MetricCardsPrimitive`, `MarkdownDocumentPrimitive`, `InteractiveBrowserPrimitive`.
- **6 Bidirectional Lenses**: `Scene3DWorldLens`, `NodeGraphWorkflowLens`, `MarkdownDocumentLens`, `KanbanTaskLens`, `MetricDashboardLens`, `LiveCodeSandboxLens`.

---

## 2. Gemini Agent Tool Suite (In-App Tool Registry)

57 specialized tools across 9 modular domain packs registered in `packages/core/src/node/gemini/tools/`:

### 1. Workspace & Subagents (`workspace-tools.ts`)
- `workspace_read_file`: Reads file content from disk.
- `workspace_view_file`: Reads formatted lines with line numbers.
- `workspace_write_file`: Overwrites file content.
- `workspace_apply_diff`: Applies unified diff hunks.
- `workspace_list_directory`: Lists directory contents.
- `workspace_search`: Global ripgrep search.
- `workspace_grep_search`: Regex search with file filters.
- `workspace_find_by_name`: Finds files by glob pattern.
- `workspace_run_command`: Executes terminal commands.
- `workspace_get_diagnostics`: Fetches language server errors/warnings.
- `workspace_find_symbols`: Finds AST symbols.
- `workspace_semantic_search`: Vector similarity search across project.
- `invoke_subagent`: Dispatches subagents from pool.

### 3. Geospatial 3D Tiles & Reconstruction (`spatial-tools.ts`)
- `google_3d_tiles_get_full_texture`: Ingests photorealistic textured 3D tile GLB.
- `google_3d_tiles_get_clay`: Ingests a real-world place as studio grey clay, built in committed stages (tiles, remesh, trees; for `isolate` also a scan-fitted rebuild with photo-inferred detail). A failing stage degrades to a simpler version of the same real data and says so; `retryRunId` + `retryStage` retry one stage from cache.
- `google_3d_tiles_clay_blockout_runner`: Runs automated headless camera flight blockout.
- `google_3d_tiles_recolor_glb`: Recolors tile meshes with PBR texture synthesis.
- `splat_to_3dtiles`: Converts Gaussian splats into Cesium 3D Tiles format.
- `survey_synthesize_stations`: Generates optimal camera capture viewpoints.
- `survey_rank_stations`: Ranks stations by coverage and parallax.
- `survey_export_colmap`: Exports station poses to COLMAP format.
- `survey_render_station`: Headless renders station blockouts.
- `survey_beautify_station`: AI-beautifies station render.
- `survey_beautify_to_splats`: Directly reconstructs beautified stations into splats.
- `survey_beautify_to_texture`: Inverse projects beautified views into the mesh's own UV atlas (a mesh without TEXCOORD_0 is refused before any station image is generated; NOAA de-lighting only with the stations' anchor coordinates and a given isoDate; the result says whether it ran).

### 4. Panoramas & Zenith Reconstruction (`spatial-tools.ts`)
- `panorama_heal_seam`: Heals the 360 wrap-around seam with an image model (fails when no model answers; refuses an answer that would be enlarged more than `maxModelUpscale`, default 2x).
- `panorama_inpaint`: Inpaints ground tripod occlusions with an image model (same answer checks as the seam heal).
- `panorama_generate_360`: Generates complete spherical panoramas.
- `panorama_generate_4k`: Synthesizes 4K monumental environments.
- `panorama_reproject_zenith`: Solves zenith polar distortion.
- `panorama_extract_zenith`: Extracts rectilinear top-down patch.
- `panorama_generate_perspectives`: Extracts multiple rectilinear cameras.
- `panorama_audit_quality`: Evaluates seams, resolution, and dynamic range.
- `location_generate_3dgs`: End-to-end location 3D Gaussian Splatting (3DGS) radiance field and OGC 3D Tiles synthesis with implicit Nano Banana restyling, rendered from the caller's clay GLB or a fresh Google 3D Tiles clay extraction (a failed extraction fails the call).
- `panorama_to_3dgs`: Projects an equirectangular panorama into Gaussian splats using Depth Anything V2 Metric depth (the depth sidecar fails rather than invent depth or an eye height).
- `single_image_to_3dgs`: Lifts a photo into Gaussian splats along pinhole rays at the depth the Depth Anything V2 Metric sidecar measures; fails when the model cannot run, and says when the field of view was assumed.
- `splat_to_3dtiles`: Converts Gaussian splat cloud (.splat or .spz) into OGC 3D Tiles 1.1 tileset.
- `survey_beautify_to_splats`: Runs full survey synthesis to beautified splat tileset.

### 5. Universal Tile Decomposition & Rectification (`spatial-tools.ts`)
- `utdra_probe_tile`: Measurements only (bounds, relief, area by slope band, wall orientation); no classification or confidence.
- `utdra_slice_elevation`: Keeps the part above an elevation, clipping straddling triangles (Sutherland-Hodgman).
- `utdra_carve_bridge_voids`: Removes near-vertical triangles inside a caller-given span box. (`utdra_decompose_tile`, its domain classifier and its "rectification" are removed.)

### 6. WebXR Metric Alignment (`spatial-tools.ts`)
- `webxr_geospatial_align_coordinates`: Bidirectional WGS-84 $\leftrightarrow$ WebXR metric coords.
- `webxr_geospatial_calibrate`: Calibrates sensor fusion and optical pins.
- `webxr_geospatial_project_vectors`: Projects road corridors and parcels into 3D.

### 7. Optical Resection & Edge Alignment (`spatial-tools.ts`)
- `geobox_resect_image_location`: Full autonomous 6-DOF photograph-to-tile resection.
- `geobox_resect_camera_pose`: Resects camera position and attitude.
- `geobox_harmonize_location_lighting`: De-lights photogrammetry and matches photograph atmosphere.
- `geobox_optimize_edge_alignment`: Same as `spatial_closed_loop_edge_align`.
- `spatial_solve_pnp`: Analytical DLT + Levenberg-Marquardt pose solver.
- `spatial_match_features_2d_3d`: 2D-to-3D keypoint matcher.
- `spatial_closed_loop_edge_align` / `geobox_closed_loop_edge_align`: Refines a camera pose so a given model (`glbPath`) lines up with a given photograph (`imagePath`), from a required `initialPose`; reports edge correlation before/after, the mean edge distance in pixels, the renders made and why it stopped. It yields between renders, stops on the chat's Stop, and has bounded limits (`maxIterations` 1-50, `analysisMaxSide` 32-640, `timeBudgetSeconds` 5-240, default 120).
- `spatial_resect_image_location`: High-level resection alias.
- `optics_configure_lens_distortion`: Configures Brown-Conrady coefficients.
- `optics_export_lens_distortion`: Exports lens profiles to OpenCV/Nuke format.

### 8. Humanoid, Motion & 4D Avatars (`spatial-tools.ts`)
- `mediapipe_detect_pose`: Extracts 33 3D body landmarks.
- `gemini_estimate_scene_depth`: Monocular relative metric depth estimation.
- `configure_physical_camera`: Configures sensor gate, aperture, and focal length.
- `camera_track_focus_target`: Tracks dynamic focal distance on moving subjects.
- (No point-tracking or 4DGS-build tools: `tapir_track_video_points` and `build_4dgs_from_video` took no video and are removed. `TapirTrackingService` and `GaussianSplat4DService` remain for code that has real frames.)
- `avatar_4dgs_list`: Catalogs registered 4D avatars.
- `avatar_4dgs_get`: Fetches avatar manifest and skeleton.
- `avatar_4dgs_animate`: Drives avatar with novel motion frames.
- `avatar_4dgs_retarget`: Retargets a recorded motion track (the JSON `vfx_mediapipe_track_video_motion` writes to `outputJsonPath`) onto an avatar and writes the avatar motion JSON; fails without a track.
- `performer_4d_create_from_video`: End-to-end video-to-4D performer pipeline.

### 9. Atmospheric Scattering & Solar Ephemeris (`atmosphere-tools.ts`)
- `atmosphere_calculate_solar_position`: NOAA geodetic solar position solver.
- `atmosphere_get_diurnal_profile`: Photometric illumination and Kelvin temperatures.
- `atmosphere_configure_scene`: High-level atmospheric scene configuration.
- `atmosphere_estimate_from_image`: Inverse photograph lighting estimator.
- `atmosphere_harmonize_location_3d`: Harmonizes 3D objects with physical skies.

### 10. Native C++20 Mesh Reshaping (`mesh-shaping-tools.ts`)
- `mesh_apply_deformers`: Applies explicit taper, twist, bend, shear, bulge, sculpt, FFD lattice, subdivide, repair and weathering operations to a given GLB; positions and sizes are fractions of the mesh's measured bounding box. A GLB with node transforms, instanced meshes, non-triangle primitives, encodings the native reader cannot decode, several materials or textures is refused, because the reader uses raw vertex positions and the writer writes one material and no textures (the UTDRA tools refuse such tiles too); the output keeps the input's own material. (`mesh_reshape_via_prompt` and its keyword parser, and the tile restructure tools with their closed style/primitive taxonomy, are removed.)

### 11. VFX, Video & Prompt Formatting (`vfx-video-tools.ts`)
- `build_beautify_prompt`: Verbatim AI Beautify prompt template.
- `build_neutral_performer_prompt`: Symmetrical A-pose flat studio prompt builder.
- `build_frame_motivated_performer_prompt`: `<FIRST_FRAME>` syntax builder.
- `vfx_ffmpeg_quick_edit`: Fast trimming and concatenation.
- `vfx_ffmpeg_extract_frames`: Extracts PNG keyframes.
- `vfx_ffmpeg_split_screen`: Compiles synchronized side-by-side comparisons.
- `vfx_ffmpeg_storyboard_sheet`: Compiles contact sheets.
- `vfx_ffmpeg_lut_grade`: Applies `.cube` 3D LUTs.
- `vfx_ffmpeg_chromakey`: Green/blue screen keying with despill.
- `vfx_ffmpeg_controlnet_map`: Generates depth/canny/openpose conditioning maps.
- `vfx_ffmpeg_audio_normalize`: Normalizes audio to -14 LUFS.
- `vfx_ffmpeg_seamless_loop`: Creates perfect crossfaded video loops.
- `vfx_ffmpeg_encode_sequence`: Encodes image sequences to ProRes or H.264.
- `vfx_composite_patch`: Composites generative patches into plates.
- `vfx_composite_timeline`: Headless timeline track compositor.
- `vfx_mediapipe_track_video_motion`: Tracks video motion trajectories.
- `vfx_video_auto_reframe`: Re-frames to any aspect ratio with one static crop at the tracked person's average position (no dry run).
- `vfx_visual_critic_audit`: A Gemini vision model scores the 8-Dimension Visual Fidelity Rubric from an FFmpeg contact sheet, with MediaPipe limb-length stability as measured evidence; passes only when every dimension passes, and fails (no score) when the sheet, the tracking or the vision model fails.

### 12. Algorithmic UVs, PBR & Color Transfer (`algorithmic-uv-tools.ts` & `nano-banana-tools.ts`)
- `algorithmic_uv_unwrap_rewrap`: Algorithmic UV unwrapping and repack.
- `uv_analyze_texel_density`: Analyzes texel density across submeshes.
- `pbr_material_decompose`: Decodes an image file (`inputImagePath`) and writes albedo, glTF normal and ORM PNGs computed from its pixels.
- `atlas_maxrects_pack`: Packs textures into unified atlas.
- `nano_banana_apply_color_palette`: Builds the palette application prompt from a complete palette the caller read from the reference (temperatures and contrast in the caller's own words). The extract and transfer tools, which returned a stock palette for any image, are removed.

### 13. Botany & Tree Synthesis (`botanical-tree-tools.ts`)
- `botanical_synthesize_tree`: Grows one standalone SB-Veggie tree (space colonisation, studio clay) to the height and crown spread given; a location's trees are measured and rebuilt by `google_3d_tiles_get_clay`.

### 14. Codebase Lenses, Browser & Canvas Primitives (`lens-browser-tools.ts` & `canvas-tools.ts`)
- `lens_project`: Projects file contents into interactive stage models.
- `lens_unproject`: Writes stage state changes back to disk.
- `lens_list_bindings`: Lists active disk-to-stage bindings.
- `lens_sync`: Triggers bidirectional state synchronization.
- `browser_navigate`, `browser_snapshot`, `browser_extract_content`, `browser_click`, `browser_type`, `browser_evaluate`: Headless web automation.
- `mount_canvas_primitive`: Mounts visual primitives directly on stage.

---

## 3. Direct-Dispatch Canvas Operators (Three.js Stage Engine)

Operators dispatched through `DirectDispatchOperatorEngine` (packages/core/src/browser/generative-canvas/services/direct-dispatch-operator-engine.ts; packs in `services/operators/`). An operator either does its work or fails: geometry operators marked **(live)** edit the mesh in the attached Three.js viewport and fail with `errorCode: 'not_available_here'` when none is attached (the server-side `scene_3d_dispatch_operators` tool runs on scene data only). Features without a backend were removed from the registry rather than kept as flags.

### Inspect Operators
- `sb_list_objects`, `sb_inspect_object`, `sb_inspect_scene`: Scene data readout (meshes, media objects, transforms, materials, physics, keyframes).
- `sb_get_mesh_stats` **(live)**: Measured vertex/face/edge counts, boundary and non-manifold edges, bounds, surface area, watertight check, and volume when closed.
- `sb_raycast_mesh` **(live)**: Nearest ray-triangle hit (point, distance, world face normal, face, mesh) via `THREE.Raycaster`.
- `sb_compute_halfedge_curvature` **(live)**: Per-vertex principal-curvature estimate summarised as min/max/mean.

### Transform Operators
- `sb_set_transform`, `sb_translate`, `sb_rotate`, `sb_scale`: Spatial manipulation of an existing object (an unknown id fails).
- `sb_set_origin` **(live)**: Moves the pivot to the bounds center, bottom, top, or a custom local point; the mesh stays in place.
- `sb_set_tile_anchor`: Sets the scene's geodetic anchor.
- `sb_snap_to_terrain` **(live)**: Raycasts objects onto the ground (one TerrainManager per viewport scene).

### Mesh Edit Operators (live)
- `sb_subdivide_mesh`: Midpoint subdivision (shape and uvs kept), `sb_loop_subdivide`: Loop subdivision.
- `sb_smooth_mesh`: Laplacian smoothing with fixed boundaries.
- `sb_deform_vertices`, `sb_taper_mesh`, `sb_twist_mesh`, `sb_bend_mesh`, `sb_lattice_deform`, `sb_reshape_mesh`: Deformers.
- `sb_sculpt_stroke`: Sculpt brushes (grab, clay, inflate, flatten, pinch, crease, smooth).
- `sb_repair_mesh`: Removes collapsed and repeated faces, makes winding consistent, recomputes normals.
- `sb_refine_building_structure`: Archie facade-normal and plinth refinement of a named scanned building.

### Physics & Animation Operators
- `sb_add_physics`: Rigid body config read by the viewport animation runtime (gravity and ground contact).
- `sb_insert_keyframe`: Property keyframes interpolated by the viewport each frame.

### Material & PBR Operators
- `sb_create_material`, `sb_assign_material`, `sb_assign_pbr_preset`: Material registry, assignment, presets.
- `sb_set_material_pbr`, `sb_set_pbr_clearcoat`, `sb_set_pbr_transmission`: Rendered PBR properties.
- `sb_set_clay_mode`: Studio clay rendering. `sb_set_staged_material_mode`: Staged-build material mode and provenance view.
- `sb_apply_slope_materials` **(live)**: Slope-ramped PBR on named terrain meshes.
- `sb_synthesize_differential_wear`, `sb_apply_thin_film_interference`, `sb_apply_subsurface_scattering` **(live)**: Vertex-color edge wear, physical iridescence, transmission plus directional back-scatter.

### Lighting & Camera Operators
- `sb_setup_lighting`: Lighting preset, skybox, kelvin, ambient level, opt-in atmosphere and god rays.
- `sb_setup_lighting_rig`: Named cinematic rig (`environment.cinematicRig`).
- `sb_set_camera`, `sb_frame_bounds`: Camera pose; framing from live bounds or customMesh shapes.
- `sb_optimize_light_budget` **(live)**: Render budget telemetry; optional shadow-caster trimming.

### Nature & Atmosphere Operators
- `sb_configure_atmospheric_scattering`, `sb_set_diurnal_time_of_day`, `sb_configure_aerial_perspective`, `sb_configure_terrain_cloud_shadows`, `sb_add_volumetric_god_rays`: Atmosphere settings read by the viewport sky dome (sun position from a preset, an elevation, or NOAA ephemeris at a location).
- `sb_set_cpp_generator`: Links a C++ generator to the scene.

### Mesh Modifiers (live)
- `sb_apply_weighted_normals`, `sb_apply_normal_bevel`, `sb_transfer_canopy_normals`: Shading-normal edits.
- `sb_simulate_geomorphological_erosion`: Height erosion over welded neighbourhoods. `sb_synthesize_moisture_runoff`: Moisture darkening in vertex colors.

### State
- `sb_undo`, `sb_redo`, `sb_reset_scene`: History navigation (one dispatch is one step; the shared viewport timeline when attached).

---

## 4. Desktop App REST API Endpoints (Server & Routers)

Hosted by the desktop application server in `desktop-app/server/app.ts`:

| Route Prefix | Router / Handler | Core Capabilities |
|---|---|---|
| `/health` | Health Check | System uptime, platform specs, and status |
| `/api/browser` | `browserRouter` | Web automation, page navigation, snapshots, clicks, evaluate |
| `/gemini` | `geminiRouter` | Streaming multimodal generation, tool dispatch, chat turns |
| `/workspace` | `workspaceRouter` | Workspace file tree, file reads/writes, directory creation, search |
| `/git`, `/workspace/git` | `gitRouter` | Git status, commit, branch, diff, push, and remote sync |
| `/3d`, `/compiler` | `cppRouter` | Native C++20 compilation via Apple Clang, binary `.glb` streaming |
| `/media`, `/gemini/media`| `mediaRouter` | Media generation jobs, Imagen 3, Veo, asset persistence |
| `/video`, `/api/video`, `/media/video` | `videoRouter` | FFmpeg quick edit, split-screen, storyboard, audio normalization |
| `/api/3d/tiles`, `/api/3d/cleanup-tiles` | `tileCleanupRouter` | Photogrammetric tile cleanup, decimation, and manifold healing |
| `/api/3d/pbr` | `pbrRouter` | Universal PBR texture baking, Toksvig coupling, material synthesis |
| `/api/3d/survey` | `createSurveyRouter` | Survey camera station synthesis, ranking, and beautification |
| `/api/3d/ar` | `arRouter` | WebXR geospatial anchor alignment, WGS-84 coordinate transforms |
| `/api/3d-engine/depthbox-360` | `depthbox360Router` | 360° spherical depth splatting and camera projection |
| `/api/panorama` | `panoramaRouter` | Seam healing, ground inpainting, 4K synthesis, zenith reprojection |
| `/api/3d-engine/splat-studio` | `splatStudioRouter` | Gaussian splatting editing, bounding crops, PLY exporting |
| `/api/tools` | `toolsRouter` | Dynamic tools registry, tool execution, schema reflection |
| `/api/models` | `modelsRouter` | Catalog of trained neural models, checkpoints, and LoRAs |
| `/api/performer/pipeline`, `/api/models/performer/pipeline` | `performerRouter` | End-to-end Performer 4D dynamic performer reconstruction pipeline |
| `/api/capabilities/resolve`| `resolveTaskCapability`| Native capability assessor (task domain, suggested tool, `canSolveNatively`) |

---

## 5. Native C++20 Astro 3D Engine Modules

77 header modules in `packages/core/src/native/3d-engine/include/`, compiled on-the-fly with Apple Clang (`-std=c++20 -O3`):

1. **`scratchbox_engine.hpp`**: Primary engine entrypoint, glTF chunk packer, and pipeline coordinator.
2. **`scratchbox_math.hpp`**: SIMD-accelerated 3D vector, matrix, and quaternion math.
3. **`scratchbox_geometry.hpp`**: Half-edge mesh topology, winged-edge structures, and manifold connectivity.
4. **`scratchbox_sdf.hpp`**: Signed Distance Field primitives, smooth CSG min/max/subtraction blending.
5. **`scratchbox_utdra.hpp`**: Tile measurements, Sutherland-Hodgman elevation slicer and span-box curtain carver.
6. **`scratchbox_visual_hull.hpp`**: High-performance multi-camera silhouette voxel carving.
7. **`scratchbox_4dgs_humanoid.hpp`**: Dynamic 4D Gaussian Splatting with 4-bone partition-of-unity LBS.
8. **`scratchbox_skinning.hpp`**: SIMD linear blend skinning and dual quaternion skinning.
9. **`scratchbox_kinematics.hpp`**: Forward and inverse kinematics solvers for humanoid rigs.
10. **`scratchbox_parametric_human.hpp`**: Parametric human body topology and shape blendshapes.
11. **`scratchbox_smpl_optimizer.hpp`**: Levenberg-Marquardt optimizer for SB-Human parametric body parameters.
12. **`scratchbox_shaper.hpp`**: Prompt-driven non-linear mesh deformation (taper, twist, bend, bulge, FFD).
13. **`scratchbox_field_remesh.hpp`**: 4-RoSy directional cross-field calculation and quad remeshing.
14. **`scratchbox_halfedge.hpp`**: Half-edge geometric Euler operators and face adjacency graphs.
15. **`scratchbox_bvh.hpp`**: Bounding Volume Hierarchy construction and fast SIMD AABB traversal.
16. **`scratchbox_pathtracer.hpp`**: Monte Carlo unidirectional path tracer with Next Event Estimation (NEE).
17. **`scratchbox_ephemeris.hpp`**: NOAA solar ephemeris computation and terrestrial Julian day tracking.
18. **`scratchbox_atmosphere.hpp`**: Spectral Rayleigh and Mie scattering raymarcher.
19. **`scratchbox_sky.hpp`**: Analytical Preetham/Hosek-Wilkie sky dome generator.
20. **`scratchbox_volumetrics.hpp`**: Participating media raymarching with 3D Worley cloud noise.
21. **`scratchbox_lighting.hpp`**: Photometric light evaluation (lumens, lux, candelas, IES profiles).
22. **`scratchbox_ibl.hpp`**: Split-sum image-based lighting and spherical harmonics irradiance integration.
23. **`scratchbox_lumen.hpp`**: Real-time diffuse global illumination cache and surface radiance probes.
24. **`scratchbox_pbr.hpp`**: Cook-Torrance microfacet specular BRDF and Smith masking-shadowing.
25. **`scratchbox_pbr_50_library.hpp`**: Validated optical parameters for 50 real-world metals and dielectrics.
26. **`scratchbox_pbr_texture_expert.hpp`**: Multi-resolution normal, roughness, and displacement synthesizer.
27. **`scratchbox_material.hpp`**: Layered material evaluation and micro-surface BSDFs.
28. **`scratchbox_delight.hpp`**: Analytical photogrammetric shadow lifting and baked noon glare removal.
29. **`scratchbox_sss.hpp`**: Subsurface scattering dipoles and Christensen-Burley normalized diffusion.
30. **`scratchbox_triplanar.hpp`**: Distance-blended triplanar projection with normal perturbation.
31. **`scratchbox_texture.hpp`**: Bilinear and bicubic texture sampling with anisotropic filtering.
32. **`scratchbox_texture_inducer.hpp`**: High-frequency photographic micro-detail induction.
33. **`scratchbox_uv_engine.hpp`**: Least Squares Conformal Mapping (LSCM) and ABF++ parameterization.
34. **`scratchbox_uv_tangent.hpp`**: MikkTSpace compliant tangent and bitangent generator.
35. **`scratchbox_splat_octree.hpp`**: Spatial octree partitioning for dense Gaussian splat pruning.
36. **`scratchbox_360_gaussian.hpp`**: Panoramic spherical Gaussian unprojection.
37. **`scratchbox_gaussian_opt.hpp`**: Gradient descent optimization for Gaussian scale and opacity.
38. **`scratchbox_depth_to_gaussian.hpp`**: Direct unprojection of metric depth maps into Gaussian splats.
39. **`scratchbox_spz.hpp`**: Compact Gaussian splat binary serialization format.
40. **`scratchbox_photoreal_reconstruction.hpp`**: Multi-view geometric bundle adjustment.
41. **`scratchbox_camera_reprojector.hpp`**: Camera matrix unprojection, depth testing, and occlusion culling.
42. **`scratchbox_colmap.hpp`**: COLMAP sparse and dense reconstruction parser.
43. **`scratchbox_lens_shader.hpp`**: Brown-Conrady and anamorphic barrel distortion kernels.
44. **`scratchbox_view_transform.hpp`**: ACEScg, AgX, and Filmic display transform curves.
45. **`scratchbox_headless_realism.hpp`**: Multi-spectral ground bounce and sky occlusion evaluation.
46. **`scratchbox_lod.hpp`**: Continuous Level-Of-Detail generator and geometric error evaluation.
47. **`scratchbox_nanite.hpp`**: Cluster-based hierarchical geometric level of detail and streaming.
48. **`scratchbox_tile_cleanup.hpp`**: Automated photogrammetric noise pruning and planar simplification.
49. **`scratchbox_tile_abstractor.hpp`**: Semantic architectural element abstraction from point clouds.
50. **`scratchbox_tiles.hpp`**: Cesium 3D Tiles 1.1 (B3DM, I3DM, PNTS) parsing and streaming.
51. **`scratchbox_geospatial.hpp`**: WGS-84 reference ellipsoid geodetic conversions to ECEF and ENU.
52. **`scratchbox_footprints.hpp`**: 2D building footprint polygon extrusion into volumetric massing.
53. **`scratchbox_tectonics.hpp`**: Structural tectonic load-path analysis for architectural shells.
54. **`scratchbox_tectonic_analyzer.hpp`**: Classifies entablatures, columns, and vaults.
55. **`scratchbox_architecture.hpp`**: Procedural classical architectural orders (Doric, Ionic, Corinthian).
56. **`scratchbox_sb_archi.hpp`**: Monumental arch and column generation.
57. **`scratchbox_sb_archi_optimizer.hpp`**: Inverse architectural parameter fitting.
58. **`scratchbox_botanical_pipeline.hpp`**: Botanical growth simulation and organ morphogenesis.
59. **`scratchbox_botanical_texture.hpp`**: Chlorophyll, bark lenticels, and leaf venation synthesizers.
60. **`scratchbox_nature.hpp`**: Terrain heightfields, biome distribution, and hydraulic erosion.
61. **`scratchbox_sb_veggie.hpp`**: Parametric tree synthesis engine.
62. **`scratchbox_sb_veggie_optimizer.hpp`**: Point-cloud-to-tree branch inverse parameter fitting.
63. **`scratchbox_smpl_tree.hpp`**: Standardized skeletal joint structure for procedural trees.
64. **`scratchbox_xpbd.hpp`**: Extended Position Based Dynamics solver for sub-millisecond physics.
65. **`scratchbox_fabric.hpp`**: Stretch, shear, and bending constraints for clothing simulation.
66. **`scratchbox_hair.hpp`**: Hair guide curve simulation with Cosserat rod dynamics.
67. **`scratchbox_particles.hpp`**: GPU particle simulation with curl noise advection.
68. **`scratchbox_rigidbody.hpp`**: Convex hull collision detection and impulse resolution.
69. **`scratchbox_fracture.hpp`**: Voronoi diagram procedural destruction and mesh shattering.
70. **`scratchbox_trajectory_collision.hpp`**: Continuous swept-sphere camera path collision avoidance.
71. **`scratchbox_scene_composer.hpp`**: Multi-mesh spatial composition and bounding box hierarchy.
72. **`scratchbox_gltf_scene.hpp`**: Fast binary glTF 2.0 parser and serializer.
73. **`scratchbox_denoise.hpp`**: Joint bilateral and cross-filtering image denoisers.
74. **`scratchbox_jpeg.hpp`**: High-speed JPEG and PNG raster decode/encode kernels.
75. **`scratchbox_substrate.hpp`**: Multi-tier memory buffer management.
76. **`scratchbox_io.hpp`**: Thread-safe memory-mapped disk I/O.
77. **`scratchbox_spatial_kernel.hpp`**: Spatial octrees, Kd-trees, and radius nearest neighbor queries.

---

## 6. Scratchbox CLI (`sbox`) Commands

Located in `packages/cli/src/commands/`:

- **`sbox init [dir]`**: Initializes a new Scratchbox spatial workspace and `.scratchbox` metadata repository.
- **`sbox branch`**: Lists, creates (`sbox branch create <name>`), or switches (`sbox branch checkout <name>`) spatial timelines.
- **`sbox status`**: Displays active branch, latest commit, and staged 3D assets.
- **`sbox attach <file.glb> --lat <deg> --lng <deg> [--alt <m>] [--heading <deg>]`**: Stages a 3D asset into the physical world anchored with geodetic coordinates.
- **`sbox commit -m <message>`**: Creates a new spatial commit snapshotting geometry, transforms, and metadata.
- **`sbox diff <commitA> <commitB>`**: Computes 3D geometric and volumetric deltas between two spatial commits.
- **`sbox bake`**: Bakes procedural C++ geometry, high-res PBR textures, and LOD pyramids into static GLBs.
- **`sbox generate --prompt <text> [--out <file.glb>]`**: Natural-language 3D generation via the native C++ Astro engine.
- **`sbox qa [--rubric]`**: Runs the automated 8-Dimension Visual Critic quality audit on the workspace.
- **`sbox splat <input> [--out <file.ply>]`**: Converts multi-view photos, videos, or meshes into optimized 3D Gaussian Splats.
- **`sbox matchmove <video> --location <coords/address>`**: Solves 6-DOF camera matchmove and exports camera trajectories.

---

## 7. VFX Pipeline Integration Architecture: How Everything Fits Together

All components form a unified, circular Visual Effects & Virtual Production pipeline:

```
                                 [Live-Action Video Plate]
                                             │
                       ┌─────────────────────┴─────────────────────┐
                       ▼                                           ▼
             [6-DOF Matchmove & Solve]                   [Lighting & Atmosphere Solve]
          - SpatialPoseEstimatorService (solvePnP)     - AtmosphereImageEstimationService
          - SubPixelEdgeAlignmentOptimizer             - calculateNOAASolarPosition
          - VfxLensInterchangeService (Brown-Conrady)   - computeDiurnalLightingProfile
                       │                                           │
                       └─────────────────────┬─────────────────────┘
                                             ▼
                              [Geospatial Blockout & Massing]
                            - Google3DTileBlockoutPipelineService
                            - UniversalTileDecompositionService (UTDRA)
                            - HeadlessMeshSilhouetteRenderer
                                             │
                       ┌─────────────────────┴─────────────────────┐
                       ▼                                           ▼
             [Environment & Set Extension]             [Dynamic Character & Performer]
          - SurveySynthesisEngine & SAIP unproject      - VideoTo4DPerformerPipelineService
          - AlgorithmicUvEngine & PBR Baking            - Google Veo 2 Multi-View Orbit Synthesis
          - SbVeggie & SbArchi procedural assets        - Dynamic4DGaussianSplatService (LBS)
          - Google360PanoramaPipelineService            - SB-Human 22-Joint Kinematic Rig
                       │                                           │
                       └─────────────────────┬─────────────────────┘
                                             ▼
                             [Photoreal 3DGS & Scene Viewport]
                           - Three.js WebGL/WebGPU Viewport Stage
                           - Anisotropic Covariance Splat Material
                           - Soft-Z Depth Interleaver & Screen Space Reflections
                                             │
                                             ▼
                             [Pro Compositor & Timeline NLE]
                           - VideoCompositor & Video3DLayerRenderer
                           - BrownConradyLensDistortionPass & CinematicBokehPass
                           - Anti-Drift Holdout Mattes (`destination-out`)
                           - HeadlessVideoEditorService (LUTs, Chromakey, EBU R128)
                                             │
                                             ▼
                             [Native C++20 Render]
                           - NativeCppCompilerService
                           - Apple Clang -O3 SIMD Math
                           - Streaming Binary GLTF 2.0
                                             │
                                             ▼
                             [Visual Critic & Metrology Audit]
                           - MediaPipeVideoDirectorService
                           - 8-Dimension Visual Fidelity Rubric (Score >= 8.5/10)
                           - Sequence Reprojection RMS < 0.05 px
```

### Stage 1: Plate Ingestion & Optical Calibration
1. **Lens Undistortion & Metrology**: Live-action footage is ingested. `VfxLensInterchangeService` and `LensDistortionEffect` solve or extract Brown-Conrady coefficients ($k_1, k_2, p_1, p_2$), linearizing barrel/pincushion distortion.
2. **6-DOF Camera Resection**: `VisualFeatureMatcherService` detects Harris/FAST corners, unprojects 2D features against 3D surface depth, and `SpatialPoseEstimatorService.solvePnPRansac` solves analytical camera extrinsics and focal breathing.
3. **Edge Alignment**: `SubPixelEdgeAlignmentOptimizer` renders the model's silhouette with `HeadlessMeshSilhouetteRenderer` at each candidate pose and searches the pose that raises the edge overlap with the photo; it reports the overlap before and after and the measured mean edge distance (chamfer, px), with no guaranteed residual.

### Stage 2: Physical Sky, Solar Ephemeris & Lighting Inversion
1. **NOAASolar Ephemeris**: `calculateNOAASolarPosition` computes sun elevation and azimuth from real-world GPS coordinates and timestamps.
2. **Atmosphere Matching**: `AtmosphereImageEstimationService` inverse-estimates Planckian Kelvin temperature ($1,000\text{K} - 40,000\text{K}$) and aerosol turbidity, aligning `AtmosphericSkyDome` and `AerialPerspectiveEffect` with the physical plate.
3. **Photogrammetric De-Lighting**: `LocationObjectLightingService` applies GLSL de-lighting to 3D tiles, lifting dark shadows and compressing noon highlights so synthetic assets match the lighting plate.

### Stage 3: Real-World Set Extension & Volumetric Massing
1. **Leaf LOD 3D Tiles**: `Google3DTileBlockoutPipelineService` downloads high-fidelity geometry without preset boundaries.
2. **UTDRA edits**: `UniversalTileDecompositionService` measures the tile, slices below-ground geometry at a given elevation, and removes curtain-wall triangles inside a span box the caller gives (deck footprint and heights in the tile's coordinates); it does not find bridges itself.
3. **Procedural Set Dressing**: `TileVegetationService` (SB-Veggie) rebuilds the trees measured in the location's own photo tiles, while `UniversalArchiBridgeService` (SB-Archi) snaps classical architectural colonnades and entablatures to real-world ground datum planes.

### Stage 4: 4D Dynamic Performer & Character Integration
1. **Google Veo 2 Closed-Loop Orbital Video Conditioning**: When synthesizing a dynamic character or performer from casual video, `VideoTo4DPerformerPipelineService` conditions on `<FIRST_FRAME>` and `<LAST_FRAME>` latents using Google Veo 2 (`veo-2.0-generate-001`) to produce seamless 360° orbital camera trajectories (72 frames, $\Delta\theta = 5.0^\circ$) with Zero-COLMAP analytical extrinsics.
2. **Visual-Hull Carving & SB-Human Skinning**: `NerfstudioDatasetService` carves candidate voxels into initial point clouds without relying on brittle SfM. `HumanoidMotionBridgeService` retargets body landmarks into 22-joint SB-Human kinematic skeletons.
3. **Real-Time 4DGS Deformed Playback**: `Dynamic4DGaussianSplatService` evaluates 4-bone partition-of-unity Linear Blend Skinning in real-time WebGL at 60 FPS, with dynamic cloth wrinkles simulated via `CharacterClothingMorphology`.

### Stage 5: Compositing, Holdout Mattes & Lens Emulation
1. **Layered WebGL Timeline NLE**: `Video3DLayerRenderer` composites 3D Gaussian Splats, C++ procedural geometry, and video plates onto synchronized video tracks.
2. **Anti-Drift Holdouts**: Real-world massing serves as dynamic occlusion mattes (`destination-out`) so performers and vehicles naturally pass behind architectural pillars and street corners.
3. **Optical Realism**: `BrownConradyLensDistortionPass` reapplies original plate distortion, and `CinematicBokehPass` applies anamorphic circle of confusion blur keyed to dynamic focus targets (`camera_track_focus_target`).

### Stage 6: Quality Gate
1. **Automated Visual Critic**: `vfx_visual_critic_audit` checks final pixel buffers against the 8-Dimension Visual Fidelity Rubric ($\ge 8.5/10$), ensuring zero void backgrounds, zero billboard splats, and zero sticker drop shadows before export.
