/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The staged location build: one tool call, many committed stages.
 *
 *   resolve → tiles → trees-measure → remesh → (isolated structure: fit ‖ evidence → project → vision → correct →
 *   detail) ‖ trees → finish
 *
 * Every stage commits as it finishes and a later failure never removes an earlier one. Degrade, don't fabricate: a
 * failing stage drops one rung to a simpler version of the same real data (STAGED_DEGRADE_LADDER):
 *   - photo-read detail becomes the flat fitted face;
 *   - a failed rebuild becomes the remeshed scan;
 *   - a failed remesh becomes the raw scan with its facades flattened (or, without that, the raw scan as downloaded),
 *     its scanned trees left in it, so nothing is planted over them;
 *   - a tree that cannot regrow is kept as scanned (strip's own rule);
 *   - a failed tree stage puts the scanned trees back, labelled as scanned.
 * Every degraded part gets a DegradationRecord, is in the scene state the viewport shades from, and is in the result
 * the model reads. The only hard failures are an unresolved place and no tile coverage: there is no real data then.
 *
 * Each status change is streamed (ctx.emitStage), with the scene artifact on a commit, a degrade and the finish. The run
 * stops starting stages at its deadline (the tool budget minus 2 min) and returns what is committed, marked degraded.
 * A Stop marks the run stopped and ends at once (tile_refine has no signal and runs on to its own cache).
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import { clampToFootprint, footprintConformance, FOOTPRINT_MAX_PROJECTION_M } from './footprint-lock';
import { readTileTriangles, type RgbaImage8 } from './tile-texture-transfer';
import { monitorEventLoopDelay } from 'perf_hooks';
import * as path from 'path';
import type { CanvasArtifact } from '../../../browser/generative-canvas/canvas-types';
import { GeometricComplexityGate, type ComplexityExemption, type GeometricMeshSummary } from '../../../common/spatial/GeometricComplexityGate';
import {
    DEFAULT_PROVENANCE_LEGEND,
    NON_MEASURED_PROVENANCE_LABELS,
    PHOTO_CORRECTION_TOLERANCE_M,
    PROVENANCE,
    SCAN_FIT_ERROR_TRANSIENT,
    STAGED_VISION_MODEL_DEFAULT,
    TILE_REFINE_RELIEF_DEFAULT,
    type CanopyMask,
    type DegradationRecord,
    type EvidenceImageRef,
    type FigureRecord,
    type OrnamentSpec,
    type StructureFit,
    type PrimitiveCorrection,
    type ProvenanceLabel,
    type ProvenanceRecord,
    type ScanFitFitRequest,
    type ScanFitFitResult,
    type ScanFitFlattenRequest,
    MAX_STREET_VIEW_IMAGES_PER_BUILDING,
    MAX_SURVEY_FACES,
    type ScanFitFlattenResult,
    type ScanFitOrnamentRequest,
    type ScanFitOrnamentResult,
    type ScanFitRefitRequest,
    type SourceLimits,
    type StageEvent,
    type StageStatus,
    type StageSummary,
    type StagedBuildState,
    type StagedActiveSceneReport,
    type StagedLayer,
    type StagedTexturedVariant,
    type StagedLocationResult,
    type StripRoi,
    type VisionModelUse
} from '../../../common/spatial/staged-location-contracts';
import { glbMeshCounts, plantTrees, summarizeTrees, type LocationClayTrees } from '../location-clay-pipeline';
import { treeSpeciesPlaceParams } from '../../../common/spatial/tree-species-library';
import { TileVegetationError, type TileVegetationPlantRequest, type TileVegetationPlantResult, type TileVegetationStripRequest, type TileVegetationStripResult } from '../tile-vegetation-service';
import type { TileRefineIsolate, TileRefineRequest, TileRefineResult } from '../tile-refine-service';
import { evidenceLookup, footprintPriorFor, type EvidenceLookup, type VectorBuilding, type VectorEvidence } from './vector-footprints';
import { auditDistrict, DISTRICT_AUDIT_VERSION, districtStreetAuditSummary, type DistrictStreetAuditSummary } from './district-residual-audit';
import { buildSceneInventory, sceneInventorySummary, SCENE_INVENTORY_VERSION, type InventoryCrown, type SceneInventorySummary } from './scene-inventory';
import { buildDistrictMassingLayer, districtFootprint, districtMassingEnabled, DISTRICT_MASSING_PARAMS, DISTRICT_MASSING_VERSION, DISTRICT_TEXEL_M, massDistrict, planeFirstEnabled, proceduralDistrictEnabled } from './district-massing';
import { REVOLUTION_FIT_VERSION, revolutionFitEnabled, reviseForRevolutions, type RevolutionLayerSummary } from './revolution-fit';
import { districtEDetail, districtEDetailEnabled, DISTRICT_E_DETAIL_VERSION } from './district-e-detail';
import { contentHash, describePolish, polishRemesh, REMESH_POLISH_VERSION, type PolishedRemesh } from './remesh-polish';
import { remeshWorkersEnabled, remeshWorkerThreads, runRemeshJob, runRemeshJobs } from './remesh-worker-pool';
import { ensureNativePolishFor, ensureNativeWallGrammar, ensureNativeWallSheets } from './remesh-polish-native';
import type { PolishJobInput } from './remesh-worker';
import { remeshCleanupEnabled } from './remesh-cleanup';
import { remeshOrientEnabled } from './remesh-orient';
import { fittedWindowRects, fitWindowsForOrthos, openingSegmenter, segmentSummary, WINDOW_FIT_FILE, WINDOW_FIT_VERSION, type OrthoFacade, type WindowFitEntry, type WindowFitFile, type WindowFitParams } from './window-fit';
import { readWallGrammar, WALL_GRAMMAR_FILE, WALL_GRAMMAR_VERSION, type WallGrammarFile } from './wall-grammar';
import { buildWallSheets, WALL_SHEETS_VERSION, type WallSheet } from './wall-sheets';
import { decodePng as decodePngForGrammar } from '../../texture-processing';
import { TILE_SEAMS_VERSION, type TileSeamWeldRequest, type TileSeamWeldResult } from '../tile-seam-weld-service';
import { measureRevealDepth, REVEAL_DEPTH_VERSION, type RevealFacade, type RevealView } from './reveal-depth';
import { streetViewClayScores, visibleDefects } from './remesh-scores';
import { decodeJpegInMemory } from './photo-palette';
import { FACADE_LATTICE_VERSION, type ReliefFacade } from './facade-lattice';
import { wallSampleIndex } from './wall-plane-fit';
import { assembleDistrictLayer, inBackground, districtMassingManifest, findStoredLayer, objectFrameOf, objectReuseEnabled, objectStoreEnabled, planDistrictObjects, readLayerManifests, storeSceneObjects, treesManifest, wholeLayerManifest, writeLayerManifests, type DistrictObjectPlan, type LayerObjectManifest } from './scene-objects';
import { objectInputHash } from '../../asset-store/scene-object-store';
import { parseGlbBytes } from './glb-bytes';
import { defaultDurableAssetStore } from '../../asset-store/durable-asset-store';
import { REVOLUTION_REFERENCE_VERSION, revolutionReferenceEnabled, revolutionReferenceFor } from './revolution-reference';
import { buildGroundProgram, buildGroundSurface, crownCanopyAt, groundCoverRegions, groundHeightAt, groundProgramNotes, landuseAreaAt, PROCEDURAL_GROUND_VERSION, settleRoadsOnGround, type GroundProgram } from './procedural-ground';
import { BRIDGE_BUILD_VERSION, buildBridgesLayer, measureWaterColour, proceduralBridgesEnabled, writeWaterGlb, WATER_VERSION, type BridgeBuildResult } from './bridge-build';
import { fetchGroundedReferences } from '../../spatial/search-grounded-reference';
import {
    coveredShare, frameToLatLng, paintGeneratedHeightProvenance, paintProvenance, selectPaintBuildings, tilePlanCoverage, writePaintGlb,
    GENERATED_HEIGHT_LABEL, PLAUSIBLE_DEFAULT_HEIGHT_M, VECTOR_ISOLATE_RADIUS_M, VECTOR_MASSING_VERSION,
    VECTOR_MODELLED_LABEL, VECTOR_OUTER_MAX_COVERED_SHARE, type ElevationLookup, type PaintBuilding, type PaintSelection
} from './vector-first-paint';
import { VISION_CALL_POLICY, VisionModelChain, type VisionGenAIClient } from '../../gemini/vision-model-chain';
import { budgetedClient, ModelCallMeter } from '../../gemini/model-call-budget';
import { segmentOwnershipViews } from './ownership-masks';
import { buildGroundModel, geodeticToScan, loadScanMesh, scanToGeodetic, surfaceModel, type GeodeticOrigin, type GroundModel, type ScanMesh } from '../../spatial/StreetViewSurveyPlanner';
import { carriagewayLevelAt, removeStreetResidue, streetResidueEnabled, writeStreetResidue, STREET_RESIDUE_VERSION, type StreetResidueReport } from './street-residue';
import { SURFACE_INFILL_VERSION } from './surface-infill';
import { removeVehiclesOffThread } from './vehicle-removal-run';
import { vehicleRemovalEnabled, vehicleRemovalParams, visionVehicleBatchJudge, visionVehicleJudge, VEHICLE_REMOVAL_VERSION, type VehicleRemovalReport } from './vehicle-removal';
import { buildRoadMesh, measureRoadSurfaces, sbRoadieEnabled, writeRoadsGlb, PROCEDURAL_ROADS_VERSION, ROAD_SURFACE_PARAMS, type RoadMesh, type RoadSurface } from './road-surfaces';
import { renderTopDownPhoto, topDownJpeg } from './top-down-photo';
import { synthesizeRoadTextures } from './road-texture';
import { buildKerbedRoadMesh, measureKerbs, nearStreets, planarFrameOf, roadKerbsEnabled, scanHeightIndex, withGlbImage, writeKerbedRoadsGlb, ROAD_KERBS_VERSION, type FootprintTri, type KerbModelStats } from './road-kerbs';
import { carveUnderRoads, isRoadCarved, prepareFootprint, ROAD_CARVE_VERSION, type CarveFootprint, type RoadCarveReport } from './road-carve';
import { flattenRoadsInGlb, flattenTargets, roadFlattenEnabled, ROAD_FLATTEN_PARAMS, ROAD_FLATTEN_VERSION, type RoadFlattenStats } from './road-flatten';
import { buildStepsMesh, groundStepsEnabled, measureSteps, writeStepsGlb, GROUND_STEPS_VERSION, type FlightModel } from './ground-steps';
import { streetViewStepCounter } from './step-count-streetview';
import { LIBRARY_FILL_VERSION, type LibraryFillSpec } from './texture-library-fill';
import { addLibraryDetail, TWIN_DETAIL_VERSION } from './twin-library-detail';
import { loadSurfaceLibrary, type SurfaceLibrary } from './surface-materials';
import { loadFillSpec, prepareProceduralTexturing, proceduralSurfaceMode, PROCEDURAL_ATLAS_MAX_SIDE, PROCEDURAL_MATERIALS_VERSION, PROCEDURAL_TRANSFER_MAX_DISTANCE_M, type ProceduralTexturingSummary, type StoredFillSpec } from './procedural-materials';
import * as jpegJs from 'jpeg-js';
import { TERRAIN_INNER_RADIUS_M, TERRAIN_INNER_STEP_M, TERRAIN_OUTER_STEP_M, TERRAIN_RADIUS_M, buildTerrainMesh, coverageHoleFromGlb, planTerrainGrid, terrainHeroGapM, writeTerrainGlb } from './terrain-surround';
import { readGlbScene, renderFrameDepth, sceneToRenderMesh } from '../../spatial/StreetViewPoseRegistrar';
import type { RenderMesh3D } from '../../spatial/HeadlessMeshSilhouetteRenderer';
import { StageCache, sha256File, stageKey, stagedReplyCache, type CachedStage } from './stage-cache';
import {
    composeStagedArtifact, glbBounds, layerObjectId, retireSupersededLayers, stagedArtifactId, stagedCamera,
    type StagedCamera, type StagedLayerObjectMeta
} from './staged-artifact';
import { describeRemeshProvenance, readRemeshProvenance } from './remesh-provenance';
import { putBackScannedTrees } from './scanned-trees';
import {
    canopyLookup, checkIsolate, grownOutline, pickOnScan, CONTAINMENT_MAX_RADIUS_M, FOOTPRINT_TOLERANCE_M, sizeExtraction, structureKeepCells, writeIsolationPick, ISOLATE_PRECISION_MIN, ISOLATE_ROOFED_MIN, NO_STRUCTURE_DISTRICT_RADIUS_M, type StructurePickResult
} from './extraction-sizing';
import {
    discoverPanos, facadeGeometry, fetchViews, missingCredentials, EVIDENCE_STAGE_BUDGET_MS, type EvidenceImage, type PanoCandidate, type StreetViewEvidenceDeps
} from './streetview-evidence';
import { selectViewsForFit, selectViewsForStructure } from './evidence-aim';
import { describeSurvey, footprintSurveyFaces, runFaceSurvey, surveyCandidates, surveyFaceTargets, surveyImageBytes, SURVEY_IMAGE_TIMEOUT_MS, SURVEY_VISION_TIMEOUT_MS, type SurveyResult } from './face-survey';
import { describeLocated, locateSurveyElements, planDetailFromSurvey, type DetailPlan } from './survey-detail';
import { DETAIL_REPROJECTION_MIN_IOU, reprojectDetailAsync } from './detail-reprojection';
import { EDGE_REGISTRATION_BUDGET_MS, describeEdgeRegistration, type EdgeRegistrationResult } from './pano-edge-registration';
import { registerPanosOffThread, runPanoRegistrationOffThread } from './pano-registration-run';
import { describeJointRegistration, JOINT_REGISTRATION_BUDGET_MS } from './pano-joint-registration';
import { LOO_BUDGET_MS } from './texture-fit-metric';
import type { Registration } from './pano-registration';
import { MATCH_TIMEOUT_MS, matchRingImages, planRingViews, runViewMatch, type MatchResult } from './view-match';
import { castCamera, fitFaces } from './survey-casting';
import type { AnchorNote } from './ornament-anchor';
import { EVIDENCE_DISCOVERY_ALLOWANCE_MS, memoizeGrounding } from './streetview-evidence';
import {
    constrainFigure, detectFigureBlobs, figureNode, figureProvenance, figureRecord, FIGURE_VISION_TIMEOUT_MS, planFigureViews, readFigure, corroborate, FIGURE_CONCURRENCY, type FigureOutcome, type FigureReading, smoothLump, SMOOTHED_SCAN_LABEL, TAUBIN,
    type FigureBlob, type FigureImage, type FigureView
} from './figures';
import { parseGlbNodes, readGlbNodes } from './glb-nodes';
import { anchorOffset, hideFootprintInGlb, partitionActiveScene, structureFootprint, type ActiveScenePartition, type StructureFootprint } from './kept-structure';
import { splitPassThroughFile, type PassThroughSplit } from './redundant-scan';
import { writeStagedGlbFile, type StagedGlbNode } from './staged-glb-writer';
import { buildObjectFromSpec } from '../reference-object-builder';
import type { ObjectBuildSpec } from '../../../common/spatial/object-build-spec';
import { nominalPose, projectSlots, registeredPose } from './slot-projection';
import { computeSlotOfferAsync, describeOffer } from './slot-exposure';
import { fetchRunCrops, mergeRunReadings, readRunTargets, RUN_PASS_BUDGET_MS, type RunCrops, type RunReadingReport, type RunTargetReadings } from './run-reading';
import { readOrnamentBatched, ORNAMENT_PASS_BUDGET_MS, ORNAMENT_REVISION_BUDGET_MS } from './ornament-batches';
import { registeredUncertaintyAt } from './survey-detail';
import {
    orthoCaption, orthoRef, plannedThinking, streetViewCaption, visionUse, VisionStageError, ORNAMENT_PROMPT_VERSION,
    ORNAMENT_THINKING_BUDGET, type EvidenceInput
} from './ornament-vision';
import { buildSwitchLocationPills, switchLocationMarkdown } from '../../../common/spatial/switch-location';
import { summarizeStagedBuild, type StagedSummaryInput } from './staged-summary';
import { palettesFromSurvey, photoTierEnabled, textureLayer, TEXTURE_PASS_VERSION, type TextureLayerOutcome } from './texture-pass';
import { facadeMaterialsEnabled, gatherMaterialEvidence, scanFacePlanes, segmenterTool, type MaterialEvidence, type SegmentImage } from './facade-material-evidence';
import { gatherSelfRenderEvidence } from '../../spatial/specular-material-evidence';
import { projectMaskedViewsToUv } from '../../spatial/specular-material-projection';
import { bakeSpecularMaterials } from '../../spatial/specular-material-bake';
import { prepareTextureSources, type TextureSources, type TextureSourcesInput } from './texture-sources';
import { ownershipChange, OWNERSHIP_MATERIAL_SHARE } from './ownership-change';
import { SKY_DELIGHT_VERSION } from './pipeline-k/sky-delight';
import { tileRefineTwin, TILE_REFINE_TWIN_VERSION, type TileRefineTwin } from './tile-refine-twin';
import { maskTemporaryInViews, textureTemporaryEnabled, visionTemporaryChecker, TEMPORARY_CHECK_VERSION } from './temporary-structures';
import { objectSegmenter, ownViews, OWNERSHIP_VERSION, type OwnershipSegmenter } from './streetview-ownership';
import { correctViewsLighting, lightingModels, lightingPromptVariant, textureArmOptions, LIGHTING_MODEL_FULL, LIGHTING_MODEL_LITE, type LightingCorrectedView } from './texture-lighting';
import { TextureWorkerPool, textureWorkersEnabled } from './texture-worker-pool';
import { eventLoopStats, runBlockTracer } from './event-loop-stats';
import { recordStageTimeline } from './stage-timeline';
import { recordDiscoveredObjects } from '../../asset-store/object-catalog';
import { genAiEnhanceClient, type EnhanceModelClient } from './texture-enhance';
import { CONFIDENCE_CHANNELS } from './staged-glb-writer';
import { fetchFootprints, type FootprintSource } from './facade-footprints';
import { runMassingStage, stagedPipelineE, pipelineEInference, PIPELINE_E_VERSION, SCAN_FOOTPRINT_TOKEN, massingProvenance, type MassingLayerFiles, type MassingStageResult } from './pipeline-e/pipeline-e';
import { stagedModelService } from './staged-switches';
import { describeRectified, PIPELINE_K_VERSION, rectifyReliefOrthos, stagedPipelineK, stagedPipelineKD } from './pipeline-k/pipeline-k';
import { describeMirrorFill, describeMirrorWindows, describeSymmetry, detectSymmetry, mirrorFillOrthos, mirrorWindows, stampSymmetryGlb, symmetryFillOn, symmetryOn, symmetryWindowsOn, SYMMETRY_VERSION, type SymmetryReport } from './pipeline-k/symmetry';
import { districtBuildingIndex, districtFootprints, type DistrictFootprint } from './pipeline-k/district-buildings';
import { chunkCpuShare, chunkOwner, chunkParallel, chunkSteps, fastChunkIndices, isCellChunk, kdFastChunks, kdBand, kdCentreRunner, kdChunkUnit, chunkTerritory, DISTRICT_CHUNKS_PARAMS, DISTRICT_CHUNKS_VERSION, frameTransform, joinChunkGlb, KD_CHUNK_CUT_VERSION, planDistrictChunks, type ChunkLayerJoinResult, type DistrictChunk, type DistrictChunkPlan, type KdChunkCutSpec, type TileFrame } from './pipeline-k/district-chunks';
import { createChunkJoiner } from './pipeline-k/chunk-join-worker';
import { auditDistrictForPlace, placeStoreEnabled, pullPlaceForRun, syncPlaceAfterObjects } from './place-store-district';
import { PLACE_STORE_PARAMS } from './place-store';
import { kdLookCode, showBestVersions } from './place-store-best';
import { addSeamEdges, applySeamGain, cutChunkLayer, DISTRICT_SEAMS_PARAMS, DISTRICT_SEAMS_VERSION, sampleSeamColour, seamCoverage, seamOwner, solveSeamGains, type SeamCoverage, type SeamCutReport, type SeamEdges, type SeamSamples } from './pipeline-k/district-seams';
import * as os from 'os';
import { PARTY_WALL_TEXTURE_VERSION, texturePartyWall } from './pipeline-k/party-wall-texture';
import { applyHeightRelief, HEIGHT_RELIEF_PARAMS, HEIGHT_RELIEF_VERSION, heightReliefAsked, heightReliefProvenance } from '../height-relief';
import { FACADE_UPSCALE_DISTRICT_PARAMS, FACADE_UPSCALE_EXTRA_MS, FACADE_UPSCALE_MODELS, FACADE_UPSCALE_PARAMS, FACADE_UPSCALE_VERSION, facadeUpscaleAsked, facadeUpscaleProvenance, upscaleFacadeTextures } from './pipeline-k/facade-upscale';
import { detailBakeProvenance, TILE_DETAIL_BAKE_VERSION, type TileDetailBakeReport } from '../../spatial/tile-detail-bake';
import { measureVisibleDefects, VISIBLE_DEFECTS_PARAMS } from './pipeline-k/visible-defects';
import { TEXTURE_HARMONIZE_VERSION, type TextureHarmonizeReport } from './pipeline-k/texture-harmonize';
import { VIEW_RELIGHT_VERSION, viewRelightEnvParams } from './pipeline-k/view-relight';
import { ROOF_SHADOW_VERSION, roofShadowAuditPng } from './pipeline-k/roof-shadow';
import { FACADE_READER_MODEL, FACADE_READER_MODEL_KEY, FACADE_READER_PARAMS, FACADE_READER_VERSION, facadeReplyUsable, mergeReadings, readPlanes, type FacadeAsk } from './pipeline-k/facade-reader';
import { readOnTwin, TWIN_READER_VERSION } from './pipeline-k/twin-reader';
import { describeWindowArrays, inferWindowArrays, inferWindowArraysOnThreads, WINDOW_ARRAY_VERSION, type ArrayOutput } from './pipeline-k/window-array';
import { BUILDING_SYSTEM_VERSION, readBuildingSystem, type BuildingSystem } from './pipeline-k/building-system';
import { CHOICE_SPAN_M, candidateSheetPng, choicePrompt, chooseWithMemory, MATERIAL_CHOICE_VERSION, parseChoices, type ChoiceRow, type SetChoice } from './pipeline-k/material-choice';
import { fileReadingStore, MODEL_READINGS_DIR, modelReadingsDir, readingKey, type ModelReadingStore } from './pipeline-k/model-readings';
import { betweenSeen, MATERIAL_NAMING_VERSION, namingPrompt, parseClassWords } from './pipeline-k/material-naming';
import { finishPrompt, MATERIAL_FINISH_VERSION, parseClassFinish, type ClassFinish } from './pipeline-k/material-finish';
import type { FacadeReadRecord, FacadeReaderFile } from './pipeline-k/facade-reader';
import { composeReusedOrthos, FACADE_REUSE_VERSION, planFacadeReuse, type FacadeReusePlan } from './pipeline-k/facade-reuse';
import { shadowLiftQaPng } from './pipeline-k/shadow-lift-qa';
import { describeMaterialRegions, MATERIAL_REGIONS_VERSION, type RegionClass, type RegionSet } from './pipeline-k/material-regions';
import { MIN_FOOTPRINT_COVERAGE_TO_SUPERSEDE, PIPELINE_I_VERSION, TRELLIS_SEEDS, runPipelineI } from './pipeline-i/pipeline-i';
import { PROJECT_MAX_RELIEF_M, pipelineIRefineEnabled, refinePipelineI, type RefineOutcome } from './pipeline-i/refine';
import { defaultWorldCacheBucket } from '../../cloud-store/world-cache';
import { publishDistrictWorld } from '../../cloud-store/district-world';
import { captureBuildingTrainingInBackground, sweepPendingBuildingTraining, type BuildingTrainingCaptureInput } from '../../cloud-store/building-training-capture';
import { captureTrainingPairsInBackground } from '../../cloud-store/training-pair-capture';
import { sceneTrainingPairs } from './scene-training-pairs';
import type { ModelClient } from './pipeline-i/fal-trellis';
import type { StationImageGenerator } from '../../spatial/BeautifyStationService';
import { ledgerFromMassingNote, type LedgerEntry } from './pipeline-h/ledger';
import type { GroundedReferenceClient } from '../../spatial/search-grounded-reference';
import type { MassingRun } from './pipeline-e/native-massing';
import { mslToTileY, type SolarRoof } from './pipeline-e/solar-roof';
import { runInferenceE, type InferenceOutcome, type StepRecord } from './pipeline-e/inference';
import { runVersionFEnhanced, stagedGeometryF } from './version-f/f2';
import { runVersionF3, versionFRound } from './version-f/f3';
import { gateDecision, photoMatchGate, pipelineERelief, runReliefStage, GENERATED_LABEL, MEASURED_AVERAGED_LABEL, RELIEF_GATE_JUDGE, RELIEF_PARAMS, RELIEF_VERSION, type PhotoGateResult, type ReliefOutcome } from './pipeline-e/relief';
import { crownsFromStrip } from './pipeline-e/occluders';
import { enhanceGuards, enhanceModels, genAiPlateClient, stagedEnhance, ENHANCE_STREET_VIEWS } from './pipeline-e/enhance';
import { visionFacadeCounter } from './pipeline-e/plate-identity';
import { stagedShapeProgram } from './pipeline-e/shape-program';
import { runShapeStage, SHAPE_STAGE_VERSION } from './pipeline-e/shape-stage';
import { projectionViewsFromEvidence } from './texture-pass';
import { contextWithoutStructure, registeredSurveyViews, trustedRegisteredPose } from './streetview-registered-views';
import { GoogleVectorTileService } from '../../spatial/GoogleVectorTileService';
import { facadeGrammarEnabled, grammarFileText, runFacadeGrammarPass, FACADE_GRAMMAR_GATE_VERSION, FACADE_GRAMMAR_PROMPT_VERSION, type GrammarFacadeOutcome } from './facade-grammar';
import { TEXTURE_LADDER_RUNGS, type ProjectionView, type TexturePassDegradation, type TexturePassRecord, type TextureLayerBundle } from '../../../common/spatial/texture-pass-contracts';
import { TOGGLEABLE_STEPS } from '../../../common/staged-build-steps';

/** What the evidence stage spent: free metadata queries, billed images and the seconds the images took. */
export interface EvidenceCost { metadataCalls: number; cachedCalls: number; imagesRequested: number; imagesFetched: number; fetchMs: number }
const NO_EVIDENCE_COST: EvidenceCost = { metadataCalls: 0, cachedCalls: 0, imagesRequested: 0, imagesFetched: 0, fetchMs: 0 };

// ----------------------------------------------------------------------------------------------------------------
// stages
// ----------------------------------------------------------------------------------------------------------------

/** The voted build may show holes on at most this much more of itself than the first isolate's (a share of its pixels over the outside audit's views), or the first isolate stands. */
const OWNERSHIP_TEAR_TOLERANCE = 0.001;
/** The ownership vote's outlines are waited for this long; a view not outlined by then is left out of the vote. */
export const OWNERSHIP_VOTE_WINDOW_MS = 60_000;
/** The focused run readings get at most this long after the wide reading (and less when the wide reading ran long). */
export const VISION_RUNS_ALLOWANCE_MS = 120_000;
/** What the vision stage keeps back from its limit: the merge, the cache write and the records after the readings. */
export const VISION_STAGE_MARGIN_MS = 20_000;
/** Below this, the focused run readings are not started: there is no time for a call to answer. */
const MIN_RUNS_WINDOW_MS = 30_000;

/** Canonical order (-1: no layer), overlay title and per-stage time limit. */
/** Why a stage is skipped on a procedural request (the 3D Building button): it runs its procedural pipeline and only what that builds on. */
/**
 * The footprint is the source of truth for every rebuild (user decision, 2026-10-22): Google's footprint, else the 3D tiles'
 * plan of the structure; height and roof from the Solar API first; no wall moved onto the scan. In every cache key it reaches.
 */
export const FOOTPRINT_LOCK_VERSION = 'footprint-lock/v1';
const PROCEDURAL_ONLY = 'procedural build only: the 3D Building build runs only the steps its procedural pipeline needs';
/** The stages a procedural-only build runs: the place, the tiles, the vector data, the massing it builds on (remesh) and the procedural pipeline (grammar). */
const PROCEDURAL_STAGES: ReadonlySet<string> = new Set(['resolve', 'tiles', 'vector', 'remesh', 'grammar', 'finish']);
const PIPELINE_K_ISOLATE = 'pipeline K builds the one building: the surroundings (vector massing, terrain, street cleanup) are not loaded';
const CENTRE_IN_CLOUD = "the district's centre cell is built in the cloud as one more chunk job (SCRATCHBOX_KD_CENTRE_RUNNER=local builds it here): this build plans, paints, joins and publishes";
/** What a build whose centre cell is a cloud job runs itself. */
const CENTRE_IN_CLOUD_STAGES: ReadonlySet<StageId> = new Set<StageId>(['resolve', 'vector', 'chunks']);
const PIPELINE_K_KEEPS_SCAN = 'pipeline K keeps the building\'s own scan, straightened: a scan-fitted rebuild, and the detail placed on it, would replace it';
/** The rebuild stages a pipeline K isolate leaves out, as it keeps the straightened scan as the structure. */
const PIPELINE_K_FIT_SKIPPED: StageId[] = ['fit', 'project', 'vision', 'correct', 'detail', 'figures'];
/** What a pipeline K isolate leaves out: the surroundings (it keeps the one building's scan, on the scene's own ground) and the fit. */
const PIPELINE_K_ISOLATE_SKIPPED: ReadonlySet<StageId> = new Set<StageId>(['vector', 'vehicles', 'terrain', 'roads', ...PIPELINE_K_FIT_SKIPPED]);

export const STAGES = {
    resolve: { order: -1, title: 'Place', budgetMs: 10_000 },
    // the first paint: Google's vector buildings extruded natively while the tiles stream (vector-first-paint.ts); it ends once
    // the tiles have committed and the buildings they do not cover are kept as their own layer
    vector: { order: 0, title: 'Google vector massing', budgetMs: 120_000 },
    tiles: { order: 1, title: 'Google 3D Tiles', budgetMs: 360_000 },
    // the vehicles the scan baked in, read by the vision model in top-down crops and patched out of the scan every later
    // stage builds on (vehicle-removal.ts; user rule, 2026-10-22); its layer replaces the raw tiles
    vehicles: { order: 1, title: 'Removing vehicles and street clutter', budgetMs: 480_000 },
    // the real ground around the place from the Google Elevation API, out to TERRAIN_RADIUS_M, under everything else
    terrain: { order: 0, title: 'Surrounding terrain', budgetMs: 120_000 },
    // the streets: Google's road centrelines measured kerb to kerb on the scan, textured from the tile photo rendered from above
    roads: { order: 2, title: 'Road surfaces', budgetMs: 240_000 },
    survey: { order: -1, title: 'Surveying the four faces', budgetMs: EVIDENCE_DISCOVERY_ALLOWANCE_MS + SURVEY_IMAGE_TIMEOUT_MS + SURVEY_VISION_TIMEOUT_MS + 15_000 },
    evidence: { order: -1, title: 'Street View close-ups', budgetMs: EVIDENCE_STAGE_BUDGET_MS + 30_000 + MATCH_TIMEOUT_MS + 60_000 + EDGE_REGISTRATION_BUDGET_MS + 15_000 + JOINT_REGISTRATION_BUDGET_MS + 30_000 },
    'trees-measure': { order: -1, title: 'Measuring the trees', budgetMs: 300_000 },
    // pipeline K's remesh grew past 300 s with the window fit (~100 s), reveal depth (30-70 s) and the oblique tear audit
    // (ESB: 275-323 s, run 7e4bd290 timed out at 309 s), so it got 600 s; the facade reader (a vision agent over up to 80
    // planes, beside the window fit) cut off at 600 s on a loaded machine (ESB run 9cd54e94: tile_refine 134 s, window fit
    // 207 s), so 900 s
    remesh: { order: 2, title: 'Remeshed scan', budgetMs: 900_000 },
    // a district's rebuilt buildings: pipeline E's massing for every building that passes its own check, and the remesh carved
    // where they stand (district-massing.ts); on unless SCRATCHBOX_STAGED_DISTRICT=scan
    // 5x the earlier 25 min (user decision, 2026-10-25): Haughwout's block took 38 min once its remesh committed
    massing: { order: 2, title: 'Rebuilt buildings', budgetMs: 7_500_000 },
    // the facades' grammars read from the tile photo (three readings per facade, concurrently), gated, and the relief run
    // again with the accepted ones; pipeline E's inference runs here too, and in its enhanced mode (the default within E) also a registered
    // Street View survey (about 3 min, alongside the readings) and up to 8 redraws (about 2.5 min)
    // version F (on by default; SCRATCHBOX_STAGED_GEOMETRY=e reverts to E's own inference) reads, adjusts and redraws
    // in this slot: a longer limit
    // 5000 s (user decision 2026-10-24, was 900 s, for the procedural rebuilds' re-reads): pipeline J's character sheet and
    // model service take their budget from this
    grammar: { order: 2, title: 'Facade grammar', budgetMs: 5_000_000 },
    // pipeline E: measured relief on the clean massing (the scan averaged along what repeats), then the photo-match gate
    relief: { order: 2, title: 'Measured relief', budgetMs: 480_000 },
    fit: { order: 3, title: 'Scan-fitted rebuild', budgetMs: 30_000 },
    project: { order: -1, title: 'Slots in the photos', budgetMs: 10_000 },
    // the batched wide reading (bounded by its own budget), then the focused run readings in what is left, then the margin the
    // stage keeps so that its own limit never discards a reading that finished
    vision: { order: -1, title: 'Reading the photos', budgetMs: ORNAMENT_PASS_BUDGET_MS + ORNAMENT_REVISION_BUDGET_MS + VISION_RUNS_ALLOWANCE_MS + VISION_STAGE_MARGIN_MS },
    correct: { order: 3, title: 'Photo corrections', budgetMs: 30_000 },
    // the build, the reprojection gate, and a second build without the elements it rejects
    detail: { order: 4, title: 'Photo-inferred detail', budgetMs: 45_000 },
    figures: { order: 4, title: 'Figures', budgetMs: EVIDENCE_DISCOVERY_ALLOWANCE_MS + SURVEY_IMAGE_TIMEOUT_MS + 2 * FIGURE_VISION_TIMEOUT_MS + 4 * 120_000 + 30_000 },
    trees: { order: 5, title: 'Trees', budgetMs: 300_000 },
    // the multi-view mask vote on what belongs to the structure: after the first (geometric) isolate is shown; it replaces that
    // isolate only when it changes it materially (ownership-change.ts), and the rebuild then runs again on the voted remesh
    ownership: { order: -1, title: 'Ownership vote', budgetMs: 300_000 },
    /**
     * Background: the real-world texture pass (textured twins of the staged layers); clay is the first result and the viewport crossfades to each twin as it commits (unless the user chose clay). The
     * limit covers the first layers (about 2 to 3 min live) plus the wait for the photo-read detail the rebuild commits
     * later (about 4 min after the Street View close-ups live), whose layers are textured once it settles. Raised 10x
     * (2026-10-24, user decision) after the Empire State Building's atlas-growth fix (texture-uv.ts hardMaxSide) made a
     * single layer's bake genuinely slower than 600 s on a supertall's much larger atlas, where it used to fail fast
     * instead; 600 s stays the right budget for an ordinary building, so this is headroom, not a new expected duration.
     */
    textures: { order: -1, title: 'Real textures', budgetMs: 6_000_000 },
    /**
     * Background: the twins of the layers committed after the remesh (fit, detail, grammar, figures), as each lands; it
     * waits for the rebuild and the grammar to settle. Raised 10x alongside `textures` (2026-10-24, user decision,
     * same cause): a live Empire State Building run hit "Real textures of later layers took longer than its 1200 s
     * limit" after the atlas-growth fix, the same bigger-atlas-takes-longer tradeoff as the main textures stage, just
     * on whichever later layer the rebuild/grammar/fit/figures passes actually commit. Kept at 2x the main stage's
     * budget, the same ratio as before the raise (this stage waits on top of the main pass, and may texture more than
     * one later layer).
     */
    'textures-late': { order: -1, title: 'Real textures of later layers', budgetMs: 12_000_000 },
    // pipeline K-D: the rest of a chunked district, each chunk a build of its own, several at once, joined as each finishes
    chunks: { order: 2, title: 'The rest of the district', budgetMs: 21_600_000 }
} as const;
export type StageId = keyof typeof STAGES;

/**
 * A district's tile-refine twin (tile-refine-twin.ts) can carry hundreds of leaf-tile photos; this caps how long its
 * model recreate pass runs within the textures stage's own budget (STAGES.textures.budgetMs), leaving room for
 * everything else the stage does. Past it, images still queued keep their de-lit (not recreated) version - never the
 * raw, un-de-lit one. Left at its original value (not raised with the textures budget): a district's hundreds of
 * leaf tiles are a different cost shape from one supertall's atlas, and this was never what timed out.
 */
const TILE_REFINE_RECREATE_BUDGET_MS = 420_000;

/**
 * Atomic building integrity (AGENTS.md: "no extraction boundary, slice or frustum may cut through a building"), for
 * a district build: a one-shot radius growth, from Google's own vector footprints, so a building the base radius
 * only partly reaches (the screenshot this fixes: a tower split at its own tile seam, the top jogged sideways from
 * the bottom - its footprint reached past a radius that stopped mid-tower) is extracted whole instead of cut. This
 * already exists for an isolated structure (sizeExtraction/containmentRadius, extraction-sizing.ts); a district has
 * no single structure to size around, so this grows once, around every building the base radius already touches, not
 * iteratively round by round. Capped so one oversized building near the edge cannot balloon the whole extraction.
 */
const DISTRICT_CONTAINMENT_MAX_GROWTH_M = 100;

/** The radius that keeps every building whole that the base radius already reaches at least one vertex of (capped by DISTRICT_CONTAINMENT_MAX_GROWTH_M past it), or the base radius unchanged if no building needs it. */
export function districtContainmentRadiusM(ev: VectorEvidence, baseRadiusM: number): number {
    let grown = baseRadiusM;
    for (const b of ev.buildings) {
        let nearest = Infinity, farthest = 0;
        for (const part of b.parts) for (const loop of part) for (const [x, z] of loop) {
            const d = Math.hypot(x, z);
            if (d < nearest) nearest = d;
            if (d > farthest) farthest = d;
        }
        if (nearest <= baseRadiusM && farthest > grown) grown = farthest;
    }
    return Math.min(baseRadiusM + DISTRICT_CONTAINMENT_MAX_GROWTH_M, grown);
}

/**
 * The extraction radius that keeps whole every building the base radius reaches, from Google's vector footprints
 * (`evidence`): districtContainmentRadiusM, then a second round, since the grown area reaches a second ring of
 * buildings the first did not size it for (Haughwout, 2026-10-22: 23 of 87 footprints ran past the extraction); the
 * same cap holds.
 */
export async function districtContainedRadiusM(evidence: (radiusM: number) => Promise<VectorEvidence>, baseRadiusM: number): Promise<number> {
    const radiusM = districtContainmentRadiusM(await evidence(baseRadiusM), baseRadiusM);
    if (radiusM <= baseRadiusM) return radiusM;
    return Math.min(baseRadiusM + DISTRICT_CONTAINMENT_MAX_GROWTH_M, districtContainmentRadiusM(await evidence(radiusM), radiusM));
}

/**
 * A fallback building for pipeline E/G when Google's vector data has no footprint at the place (e.g. the Great Pyramid
 * of Giza: Google's vector tiles carry no building there) — extruded from the structure's own convex outline on the
 * scan (StructurePickResult.outline, already computed in the tiles stage regardless of vector data) and its measured
 * height, instead of leaving pipeline E unable to run and the build falling back to an unstructured remeshed scan.
 * Labelled SCAN_FOOTPRINT_TOKEN ('measured', not 'vector-massing': a real, if simplified, measurement of the scan) by
 * buildMassing/massingProvenance via VectorBuilding.provenance. The outline is its raw convex hull, not squared to right
 * angles or otherwise regularized — a footprint-regularization pass on it would be a natural follow-up, not done here.
 * Returns undefined when there is no structure, a usable vector footprint already exists, or the outline is degenerate.
 */
export function scanDerivedFootprint(structure: Pick<StructurePickResult, 'outline' | 'heightM'> | undefined): VectorBuilding | undefined {
    if (!structure || structure.outline.length < 3) return undefined;
    return { id: 'scan-derived-footprint', parts: [], extruded: [{ loops: [structure.outline], heightM: structure.heightM }], provenance: SCAN_FOOTPRINT_TOKEN };
}

/**
 * Where a footprint's loops come from, for the run notes: Google's vector footprint only when every building is one of
 * Google's (a building carrying its own provenance token is not: scanDerivedFootprint's is the scan's outline).
 */
export function footprintSource(buildings: ReadonlyArray<Pick<VectorBuilding, 'provenance'>>): string {
    if (buildings.length && buildings.every(b => b.provenance === undefined)) return 'Google vector footprint';
    if (!buildings.length || buildings.some(b => b.provenance === SCAN_FOOTPRINT_TOKEN)) return 'scan outline';
    return [...new Set(buildings.map(b => b.provenance ?? 'Google vector footprint'))].join(' + ');
}

export const STAGE_IDS = Object.keys(STAGES) as StageId[];

/** The tool's budget is 40 minutes; the run stops starting stages 2 minutes before it. */
export const RUN_BUDGET_MS = 38 * 60_000;
/**
 * A district's (no isolate): the tiles, trees and remesh before the massing (about 15 min uncached) plus the massing's
 * own 125 min; the chat tool's limit for a district call (tool-time-budgets.ts) is this plus the margin.
 */
export const DISTRICT_RUN_BUDGET_MS = 140 * 60_000;
/** Pipeline K-D's chunked district: its chunks are whole district builds of their own, several at a time (tool-time-budgets.ts adds the margin). */
export const CHUNKED_DISTRICT_RUN_BUDGET_MS = 360 * 60_000;
export const RUN_DEADLINE_MARGIN_MS = 120_000;
/** Layers the texture pass works on at once. */
export /** The no-fit rung's Street View is kept only on at least this many held-out views (fewer cannot tell it from the clay). */
const NO_FIT_MIN_SCORED_VIEWS = 5;
const TEXTURE_LAYER_CONCURRENCY = 3;
/**
 * A vision call with no first token after this long is sent once more and the first answer taken. Live (Washington Square
 * Arch): first tokens came in 2-9 s for the survey and reading calls, 38-108 s at times for the same kind of call.
 */
export const VISION_HEDGE_AFTER_MS = 25_000;
export const EXTRACTION_TTL_MS = 7 * 24 * 3600_000;
export const GEOCODE_TTL_MS = 30 * 24 * 3600_000;
/** Apron (4 m, tile_refine's) plus crown reach (8 m): where an isolated structure's trees can stand. */
export const ISOLATE_TREE_REACH_M = 12;

/** tile_vegetation error codes that a retry cannot change (negative-cached); every other code is transient. */
export const TILE_VEGETATION_DETERMINISTIC: Record<string, boolean> = {
    bad_input: true, texture_decode: true, no_photo_texture: true, budget_too_small: true, budget_exceeded: true, plant_failed: true,
    bad_request: true, not_found: false, timeout: false, failed: false, build_failed: false, io: false
};

// ----------------------------------------------------------------------------------------------------------------
// request and dependencies
// ----------------------------------------------------------------------------------------------------------------

export interface StagedLocationRequest {
    query: string;
    /** One structure at the place (rebuilt and detailed) instead of the area around it. */
    isolate: boolean;
    /** District radius (default 250 m); ignored for an isolated structure, whose extraction is sized to it. */
    radiusM?: number;
    trees: boolean;
    treeTriangleBudget?: number;
    /** tile_refine's photometric relief (default on). */
    relief?: boolean;
    stageIntoActiveScene?: boolean;
    /** The place already resolved (a 'Switch location' choice): used as given, the query is not geocoded. */
    place?: ResolvedPlace;
    /**
     * Pipeline E's enhanced appearance (the default within pipeline E; false, or SCRATCHBOX_STAGED_ENHANCE=0, is the real-data
     * view): each large wall's texture redrawn once by an image model, kept only where it keeps the tile's edges and erases
     * or contradicts nothing distinct; labelled generated.
     */
    enhance?: boolean;
    /**
     * A procedural rebuild (with isolate): pipeline J, a generated model of the structure in place of pipeline E's
     * inference (pipelines G and H, the earlier procedural rebuilds, were retired on 2026-10-30).
     */
    procedural?: boolean;
    /**
     * Which pipeline: 'j' (pipeline-i/: a character sheet of the scan made into a model by `modelService` on Fal.ai and
     * fitted to the scan; with procedural) or 'k' (pipeline-k/, not procedural: the remeshed scan, its facade orthos
     * straightened and levelled, its facades rebuilt on them; it replaces pipeline E and the facade grammar for the build).
     * SCRATCHBOX_STAGED_BUILDING_PIPELINE changes the default.
     */
    pipeline?: 'j' | 'k' | (string & {});
    /**
     * Pipeline J's 3D model service (staged-switches.ts): 'meshy' (Meshy 7.1, one seed, its own texture kept; the
     * default) or 'trellis' (Trellis multi, the best of six seeds, then a swatch colour match; formerly pipeline I).
     * SCRATCHBOX_STAGED_MODEL_SERVICE changes the default.
     */
    modelService?: 'meshy' | 'trellis' | (string & {});
    /**
     * How the district is shown in a build without isolate (staged-switches.ts stagedDistrict): 'scan', 'massing' (the
     * default), 'rebuilt', or 'kd' (pipeline K over the whole district, in chunks). SCRATCHBOX_STAGED_DISTRICT changes the
     * default.
     */
    district?: 'scan' | 'massing' | 'rebuilt' | 'kd' | (string & {});
    /**
     * Steps turned on or off for this build, by step key (TOGGLEABLE_STEPS in staged-build-steps.ts): the node graph's
     * toggles. A step not named keeps its default (its environment switch, else on).
     */
    steps?: Record<string, boolean>;
    /**
     * Pipeline K-D: this build is one chunk of a chunked district (pipeline-k/district-chunks.ts), run by the district's own
     * build, which places its layers in the district's frame and cuts them to what the chunk owns; it never chunks itself.
     */
    chunk?: { of: string; index: number; /** What it extracts (x east, z south, m about its own place): its cell grown to its buildings. */ rect?: { x0: number; z0: number; x1: number; z1: number } };
}

export interface StagedExtraction {
    /** The photo-textured extraction: strip, remesh and the orthos read it. */
    texturedGlb: string;
    /** Where the raw high-resolution extraction is kept for reuse (public/models/..._textured.glb); the result reports it. */
    rawGlbPath?: string;
    /** L1: the same leaves without images, textures or UVs, one node per leaf primitive with run-independent extras. */
    geometryGlb: string;
    /** {leafId: rank} in download-completion order (published beside L1, never in its bytes). */
    downloadOrder?: Record<string, number>;
    leafIds: string[];
    copyrights: string[];
    fetchedAt: string;
    radiusM: number;
    coveredRadiusM: number;
    truncated: boolean;
    leafTiles: number;
    leafGeometricErrorM: number;
    originEllipsoidalHeightM: number;
    geoAnchor: { lat: number; lng: number; elevation?: number; [k: string]: unknown };
}

export interface ResolvedPlace { lat: number; lng: number; formattedAddress: string; placeId?: string; elevation?: number; alternatives?: NonNullable<StagedBuildState['place']['alternatives']> }

export interface ScanFitDeps {
    fit(req: ScanFitFitRequest): Promise<ScanFitFitResult>;
    refit(req: ScanFitRefitRequest): Promise<ScanFitFitResult>;
    ornament(req: ScanFitOrnamentRequest): Promise<ScanFitOrnamentResult>;
    flatten(req: ScanFitFlattenRequest): Promise<ScanFitFlattenResult>;
}

export interface StagedLocationDeps {
    cache: StageCache;
    geocode(query: string, signal?: AbortSignal): Promise<ResolvedPlace>;
    /** Heights above mean sea level (metres) for geodetic points, in order (the Google Elevation API); absent without a key. */
    elevation?: { sample(points: Array<{ lat: number; lng: number }>, signal?: AbortSignal): Promise<number[]> };
    /** Extracts the leaves within radiusM of (lat, lng) into `outDir` (textured.glb, geometry.glb). */
    extract(req: { lat: number; lng: number; radiusM: number; outDir: string; place: ResolvedPlace; signal?: AbortSignal; onProgress?: (message: string) => void; /** Only the leaves touching this rectangle (x east, z south, m about the place): a chunk of a chunked district. */ rect?: { x0: number; z0: number; x1: number; z1: number } }): Promise<StagedExtraction>;
    vegetation: {
        strip(req: TileVegetationStripRequest & { roi?: StripRoi }): Promise<TileVegetationStripResult>;
        plant(req: TileVegetationPlantRequest): Promise<TileVegetationPlantResult>;
        /** tile_vegetation's canopy classifier; absent until the engine has it. */
        canopy?(req: { tilePath: string; cellM?: number; signal?: AbortSignal }): Promise<{ mask: CanopyMask; cached: boolean; ms: number }>;
    };
    /** Building footprints, water and roads from Google vector data around (lat, lng), in its scan frame; absent without credentials. */
    vectorEvidence?(req: { lat: number; lng: number; radiusM: number }): Promise<VectorEvidence>;
    /** Terrain heights above mean sea level (the Google Elevation API): the first paint's building bases; absent without a Maps key. */
    elevations?: ElevationLookup;
    refine: {
        refine(req: TileRefineRequest): Promise<TileRefineResult>;
        /** Registered views of the tile around the structure the geometric isolate finds, for the multi-view mask vote. */
        renderOwnershipViews?(req: Pick<TileRefineRequest, 'tilePath' | 'anchor' | 'isolate' | 'isolatePick'>): Promise<{ dir: string; views: string[]; cached: boolean; ms: number }>;
        /** The isolate alone (with its ownership vote): the raw scan as clay, no remesh. The vote is judged on it; absent, a whole refine stands in. */
        isolate?(req: TileRefineRequest): Promise<TileRefineIsolate>;
    };
    /** The scan fitter; absent until the engine has it (then the rebuild stages degrade and say so). */
    scanFit?: ScanFitDeps;
    /** Why scanFit is absent (shown to the user). */
    scanFitUnavailable?: string;
    streetView?: StreetViewEvidenceDeps;
    /** The vision model client and the models to try (the staged default first); or why there is none. */
    vision?: { client: VisionGenAIClient; candidates: string[] } | { unavailable: string };
    /**
     * Vehicle removal (vehicle-removal.ts) reads the scan with `vision`: true in the app's deps (createStagedLocationDeps);
     * stand-in deps leave it out, so their vision replies are not asked about vehicles.
     */
    vehicleRemoval?: boolean;
    /**
     * Street residue (street-residue.ts): in a district, what the residual audit finds standing in the streets that nothing
     * explains (floating artefacts, wide-and-low lumps, twisted spikes) taken out of the tree-stripped scan and the street
     * under it filled by the surface infill, before anything builds on the scan. True in the app's deps; stand-in deps leave
     * it out, so their builds read the stripped scan as it is.
     */
    streetResidue?: boolean;
    /**
     * The tile seam stage (tile-seam-weld-service.ts runTileSeamWeld): the extraction's seams closed as it arrives, and
     * every later stage reads the welded scan. The app's deps provide it; stand-in deps leave it out (the raw extraction is
     * used and the run says so).
     */
    tileSeams?(req: TileSeamWeldRequest): Promise<TileSeamWeldResult>;
    /** Google Solar API roof facets of the building closest to (lat, lng) (pipeline E's massing); absent without a key. */
    solarRoof?(lat: number, lng: number): Promise<SolarRoof>;
    /**
     * Pipeline J's paid services (pipeline-i/): the image model for the character sheet and a Fal.ai model client by
     * model service ('meshy' or 'trellis'), made on first use so a missing key fails that build with its reason. The
     * app's deps (createStagedLocationDeps) provide them; without them a procedural build degrades with that reason.
     */
    pipelineI?: { generator: () => StationImageGenerator; model: (name?: string) => ModelClient };
    /** Vector building footprints near a place (facade grammar's independent check); default: Google vector feature tiles. */
    footprints?: (place: { lat: number; lng: number }, radiusM: number) => Promise<FootprintSource>;
    /** Builds a figure spec natively and returns its GLB (metres, +Y up, front +Z, origin at the centre of its base); the reference object builder's native build by default. */
    figureBuilder?: (spec: ObjectBuildSpec, signal?: AbortSignal) => Promise<{ glb: Buffer }>;
    /**
     * The texture pass's optional model enhancement of the tile transfer (an image model, edge-gated); absent = that
     * rung is not attempted (tests, or no client). `densityTexelsPerMeter` caps the atlas density (default 20, 5 cm).
     */
    /** Search-grounded reference images (search-grounded-reference.ts; the bridges' detail): a client with the image models; absent = none. */
    groundedReferences?: () => Promise<GroundedReferenceClient>;
    /** Pipeline K's material regions: one texture library set per appearance class (pipeline-k/material-sets.ts); absent = the stage is not run (tests, stand-in deps). */
    pipelineK?: {
        materialSets?: (classes: RegionClass[], opts: { signal?: AbortSignal; progress?: (m: string) => void; /** The pick by appearance among each class's nearest sets (pipeline-k/material-choice.ts). */ choose?: (rows: ChoiceRow[]) => Promise<Array<SetChoice | undefined>>; /** Each class's finish read by the vision model (pipeline-k/material-finish.ts), before the ranking. */ finish?: () => Promise<Array<ClassFinish | undefined>>; /** Where prepared library maps are kept between builds. */ store?: ModelReadingStore }) => Promise<RegionSet[]>;
        /** The swatch detail bake (tile-detail-bake.ts): the building's survey swatches harvested from the tiles, baked into the twin's atlases. */
        detailBake?: (input: { glb: Uint8Array; tilesGlb: string; lat: number; lng: number; place: string; workDir: string; signal: AbortSignal; progress: (m: string) => void }) => Promise<{ glb: Buffer; report: TileDetailBakeReport }>;
    };
    textures?: {
        enhance?: EnhanceModelClient; enhanceModels?: string[]; maxDensityTexelsPerMeter?: number; maxSide?: number; disabled?: string;
        /** 'recreate' (default) removes the tile transfer's own baked shadow/highlight and recovers the material's true colour, gated on structure and hue/chroma; 'sharpen' is the earlier, lighting-locked mode. See texture-enhance.ts. */
        enhanceMode?: 'sharpen' | 'recreate';
        /**
         * The model lighting correction of the Street View photos and the tile photo (texture-lighting.ts; SCRATCHBOX_TEXTURE_LIGHTING);
         * absent = not run. `lightingModels` default lightingModels().
         */
        lighting?: EnhanceModelClient; lightingModels?: string[];
        /**
         * The segmenter that cuts the structure out of each Street View photo (streetview-ownership.ts); default the repo's
         * ObjectSegmenterService (MediaPipe interactive + GrabCut). false = no ownership check (SCRATCHBOX_TEXTURE_OWNERSHIP=0 too).
         */
        segmenter?: OwnershipSegmenter | false;
        /** The facade material reading's segmenter (default: vfx_segment_subject's ObjectSegmenterService); used only with SCRATCHBOX_FACADE_MATERIALS=1. */
        segment?: SegmentImage;
    };
    now?: () => number;
    newRunId?: () => string;
    sleep?: (ms: number) => Promise<void>;
    /** Pipeline K-D: every leaf tile of the district's radius fetched into the shared leaf cache while the chunks build; absent = each chunk fetches its own. */
    prefetchTiles?: (req: { lat: number; lng: number; elevation?: number; radiusM: number; signal?: AbortSignal; onProgress?: (done: number, total: number) => void }) => Promise<{ leaves: number; downloaded: number; ms: number }>;
    /** Pipeline K-D: one chunk of a chunked district built on its own (its own worker, staged-location-tool.ts); absent = no chunking. */
    runChunk?: (request: StagedLocationRequest, opts: { signal?: AbortSignal; onProgress?: (message: string) => void; atOnce?: number; /** What the chunk keeps, for a build that cuts its own layers (the cloud job); one that does not sends them uncut. */ cut?: KdChunkCutSpec }) => Promise<StagedLocationOutcome>;
}

export interface StagedLocationContext {
    signal?: AbortSignal;
    emitStage?: (event: StageEvent, artifact?: CanvasArtifact) => void;
    reportProgress?: (message: string, fraction?: number) => void;
    /** Time left in the tool's budget (the computer-use plan's field); the static budget otherwise. */
    remainingMs?: () => number;
    activeArtifact?: CanvasArtifact;
    /** A retry: the run to rebuild and the one stage to recompute (bypassing its cache). */
    retry?: { runId: string; stage: StageId };
    /** A resume: the run to rebuild as recorded; cached stages are reused, nothing is bypassed. */
    resume?: { runId: string };
    /** The run's frame (the outcome's compat.frame) as soon as its tiles are in: a chunked district's centre job publishes it to the others. */
    onFrame?: (frame: TileFrame) => void;
}

/** No real data exists to show: the place could not be resolved, or the tiles do not cover it. */
export class StagedLocationHardFailure extends Error {
    constructor(readonly stage: StageId, readonly reasonCode: string, message: string) {
        super(message);
        this.name = 'StagedLocationHardFailure';
    }
}

interface RunRecord {
    schema: 'scratchbox.staged-run/1';
    runId: string;
    request: StagedLocationRequest;
    place?: ResolvedPlace;
    artifactId: string;
    keys: Partial<Record<StageId, string>>;
    statuses: Partial<Record<StageId, StageStatus>>;
    createdAtMs: number;
}

/** The payload beside the contract result, for consumers of the previous result shape (the object builder). */
export interface StagedLocationOutcome {
    result: StagedLocationResult;
    /** The run's id (its records under staged_location/runs/<runId>/): a district's chunks are found by it. */
    runId?: string;
    compat: {
        remesh: { ok: boolean; url?: string; error?: string };
        resolvedAddress: string;
        geoAnchor: StagedExtraction['geoAnchor'];
        /** The tangent frame every layer is in (x east, y up, z south about the place, at the extraction's origin height). */
        frame?: TileFrame;
        /** The raw high-resolution textured extraction. */
        glbPath: string;
        /** The clay ground the objects stand on (the remeshed scan, or its rung). */
        groundGlbPath?: string;
        trees?: LocationClayTrees;
    };
}

// ----------------------------------------------------------------------------------------------------------------
// the run's state and emission
// ----------------------------------------------------------------------------------------------------------------

function abortError(): Error {
    return Object.assign(new Error('Stopped by the chat before it finished'), { name: 'AbortError' });
}

/** Stop, as the chat raises it; and a hard failure: the two errors that end the whole call. Anything else is a failed part. */
function isAbort(err: unknown): boolean {
    return (err as Error)?.name === 'AbortError' || err instanceof StagedLocationHardFailure;
}

function slug(text: string): string {
    return text.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40) || 'place';
}

function round(v: number, d = 3): number {
    const k = 10 ** d;
    return Math.round(v * k) / k;
}

class StagedRun {
    readonly state: StagedBuildState;
    readonly layerMeta: Record<string, StagedLayerObjectMeta> = {};
    /** What each layer holds, by layer object id (scene-objects.ts): the separable objects kept when the build finishes. */
    readonly objectManifests = new Map<string, LayerObjectManifest>();
    readonly cacheStatus: Record<string, 'hit' | 'miss' | 'bypassed'> = {};
    readonly keys: Partial<Record<StageId, string>> = {};
    camera?: StagedCamera;
    geoAnchor: StagedExtraction['geoAnchor'] = { lat: 0, lng: 0 };
    firstVisualAt?: number;
    readonly startedAt: number;
    private seq = 0;
    private version = 1;
    private legendNotes: Partial<Record<string, string>> = {};
    /** Set once the call has returned or thrown: work a stage abandoned (a Stop, a time limit) can no longer change or stream anything. */
    private closed = false;
    /** The active scene this run is staged into, split (kept-structure.ts); set once the place is resolved. */
    carried?: ActiveScenePartition;
    /** Applied to every layer as it commits (the district without the kept structure's own scan); it may return the layer unchanged. */
    layerTransform?: (layer: StagedLayer, meta: StagedLayerObjectMeta) => StagedLayer;

    constructor(
        readonly runId: string,
        readonly request: StagedLocationRequest,
        private readonly ctx: StagedLocationContext,
        private readonly now: () => number,
        artifactId: string,
        private readonly activeScene?: CanvasArtifact
    ) {
        this.startedAt = now();
        this.state = {
            schema: 'scratchbox.staged-build/2',
            runId,
            requestKey: `${request.place ? `${request.query.trim().toLowerCase()}@${request.place.lat.toFixed(6)},${request.place.lng.toFixed(6)}` : request.query.trim().toLowerCase()}|${request.isolate ? 'isolate' : `r${request.radiusM ?? 250}`}|${request.trees ? 'trees' : 'no-trees'}`,
            artifactId,
            place: { query: request.query, resolvedAddress: '', lat: 0, lng: 0 },
            runState: 'running',
            updatedAtMs: this.startedAt,
            stages: STAGE_IDS.map(id => ({
                stage: id, order: STAGES[id].order, title: STAGES[id].title, source: '', status: 'pending' as StageStatus,
                layerIds: [], timings: { startedAtMs: this.startedAt, cached: false }, degradationIds: []
            })),
            layers: [],
            degradations: [],
            provenanceLegend: [],
            attribution: ['Map data ©Google']
        };
    }

    summary(id: StageId): StageSummary {
        return this.state.stages.find(s => s.stage === id)!;
    }

    /** A timed step inside a stage started or ended (key "<group>.<step>"); it streams with the stage's next event. */
    step(key: string, stage: string, status: 'running' | 'done' | 'failed' | 'skipped'): void {
        if (this.closed) return;
        const steps = this.state.steps ?? (this.state.steps = []);
        let s = status === 'running' ? undefined : [...steps].reverse().find(x => x.key === key);
        if (!s) { s = { key, stage, status, startedAtMs: this.now() }; steps.push(s); }
        s.status = status;
        if (status !== 'running') { s.endedAtMs = this.now(); s.ms = s.endedAtMs - s.startedAtMs; }
    }

    /** The model as it stood after a step: on that step's latest record. */
    stepSnapshot(key: string, snapshot: NonNullable<NonNullable<StagedBuildState['steps']>[number]['snapshot']>): void {
        if (this.closed) return;
        const s = [...(this.state.steps ?? [])].reverse().find(x => x.key === key);
        if (s) s.snapshot = snapshot;
    }

    /** Ends the run's record: later calls from abandoned work change nothing and stream nothing. */
    close(): void {
        this.closed = true;
    }

    note(label: ProvenanceLabel, description: string): void {
        if (this.closed) return;
        this.legendNotes[label] = description;
    }

    private legend(): StagedBuildState['provenanceLegend'] {
        const used = new Set<ProvenanceLabel>([...this.state.layers.filter(l => !l.retired).flatMap(l => l.provenanceLabels), ...(this.carried?.structureLayers ?? []).flatMap(l => l.provenanceLabels), ...this.state.degradations.map(d => d.provenanceAfter)]);
        return DEFAULT_PROVENANCE_LEGEND.filter(e => used.has(e.label)).map(e => ({ ...e, description: this.legendNotes[e.label] ?? defaultLegendText(e.label) }));
    }

    artifact(summary: string): CanvasArtifact | undefined {
        if (!this.camera || this.state.layers.length === 0) return undefined;
        this.state.provenanceLegend = this.legend();
        this.state.updatedAtMs = this.now();
        return composeStagedArtifact({
            state: { ...JSON.parse(JSON.stringify(this.state)), stages: this.state.stages.filter(st => !st.outOfScope).map(st => JSON.parse(JSON.stringify(st))) }, camera: this.camera, layerMeta: this.layerMeta, geoAnchor: this.geoAnchor,
            activeScene: this.activeScene, ...(this.carried ? { carried: this.carried } : {}), summary, version: this.version++
        });
    }

    /** Updates a stage's summary and streams it (with the scene on a commit, degrade or finish). */
    emit(id: StageId, status: StageStatus, extra: { source?: string; reason?: string; layers?: StagedLayer[]; degradations?: DegradationRecord[]; model?: VisionModelUse; message?: string; progress?: number; outOfScope?: boolean } = {}, withArtifact = false): void {
        if (this.closed) return;
        const s = this.summary(id);
        const wasRunning = s.status === 'running';
        s.status = status;
        if (extra.source !== undefined) s.source = extra.source;
        if (extra.reason !== undefined) s.reason = extra.reason;
        if (extra.outOfScope) s.outOfScope = true;
        if (status === 'running' && !wasRunning) s.timings = { startedAtMs: this.now(), cached: false };
        if (status !== 'running' && status !== 'pending') {
            s.timings.endedAtMs = this.now();
            s.timings.ms = s.timings.endedAtMs - s.timings.startedAtMs;
        }
        for (const l of extra.layers ?? []) if (!s.layerIds.includes(l.objectId)) s.layerIds.push(l.objectId);
        for (const d of extra.degradations ?? []) if (!s.degradationIds.includes(d.id)) s.degradationIds.push(d.id);
        const artifact = withArtifact ? this.artifact(`${s.title}: ${status}`) : undefined;
        const event: StageEvent = {
            schema: 'scratchbox.stage-event/2', runId: this.runId, seq: ++this.seq, stage: id, order: s.order, status, title: s.title, source: s.source,
            ...(extra.progress !== undefined ? { progress: extra.progress } : {}),
            ...(extra.message ? { message: extra.message } : {}),
            ...(extra.outOfScope ? { outOfScope: true } : {}),
            ...(extra.layers?.length ? {
                patch: {
                    upsertObjects: extra.layers.map(l => l.objectId), removeObjects: [],
                    supersede: extra.layers.flatMap(l => l.supersedes.map(objectId => ({ objectId, by: l.objectId })))
                }, layers: extra.layers
            } : {}),
            degradations: extra.degradations ?? [],
            timings: s.timings,
            ...(extra.model ? { model: extra.model } : {})
        };
        this.ctx.emitStage?.(event, artifact);
        if (artifact && !this.firstVisualAt) this.firstVisualAt = this.now();
    }

    /** The finish event: the final scene, without touching any stage's summary. */
    emitFinish(status: StageStatus, source: string): void {
        if (this.closed) return;
        const artifact = this.artifact(source);
        const end = this.now();
        this.ctx.emitStage?.({
            schema: 'scratchbox.stage-event/2', runId: this.runId, seq: ++this.seq, stage: 'finish', order: -1, status, title: 'Finished', source,
            degradations: [], timings: { startedAtMs: this.startedAt, endedAtMs: end, ms: end - this.startedAt, cached: false }
        }, artifact);
    }

    /** Told of every commit (the texture pass textures a layer the rebuild commits as soon as it lands). */
    readonly commitListeners = new Set<(layer: StagedLayer) => void>();

    commit(layer: StagedLayer, meta: StagedLayerObjectMeta): void {
        if (this.closed) return;
        // in place, so the stage's own record of the layer (its event and result) says what was committed
        if (this.layerTransform) { const t = this.layerTransform(layer, meta); if (t !== layer) Object.assign(layer, t); }
        const i = this.state.layers.findIndex(l => l.objectId === layer.objectId);
        if (i >= 0) this.state.layers[i] = layer; else this.state.layers.push(layer);
        this.layerMeta[layer.objectId] = meta;
        for (const listen of this.commitListeners) listen(layer);
    }

    /** Makes `objectId` the one layer objects stand on. */
    setGround(objectId: string): void {
        if (this.closed) return;
        for (const [id, meta] of Object.entries(this.layerMeta)) meta.isGround = id === objectId;
    }

    /**
     * Opens stages again for a second pass (the ownership vote replaced the remesh they were built on): their summaries go back
     * to pending and the degradations they recorded on the first pass are taken out of the run's (returned, for the run notes).
     */
    reopen(ids: string[]): DegradationRecord[] {
        if (this.closed) return [];
        const set = new Set(ids);
        for (const s of this.state.stages) {
            if (!set.has(s.stage)) continue;
            s.status = 'pending';
            delete s.reason;
            s.layerIds = [];
            s.degradationIds = [];
            s.timings = { startedAtMs: this.now(), cached: false };
        }
        const dropped = this.state.degradations.filter(d => set.has(d.stage));
        this.state.degradations = this.state.degradations.filter(d => !set.has(d.stage));
        return dropped;
    }

    degrade(record: DegradationRecord): DegradationRecord {
        if (this.closed) return record;
        if (!this.state.degradations.some(d => d.id === record.id)) this.state.degradations.push(record);
        return record;
    }
}

function defaultLegendText(label: ProvenanceLabel): string {
    switch (label) {
        case PROVENANCE.asScanned: return 'Google 3D Tiles triangles as downloaded';
        case PROVENANCE.scanFlattened: return 'the scan with its facades flattened onto fitted planes; nothing added';
        case PROVENANCE.remeshed: return 'tile_refine remesh of the scan';
        case PROVENANCE.fitted: return 'fitted to the scan, with residuals';
        case PROVENANCE.fittedUnobserved: return 'a face the fit placed where the scan has no samples';
        case PROVENANCE.photoCorrected: return 'a fitted value changed by the photos inside what the scan allows';
        case PROVENANCE.photoInferred: return 'read from photos, with a confidence: inference, not measurement';
        case PROVENANCE.grownToMeasuredCrown: return 'SB-Veggie trees grown to the measured crown';
        case VECTOR_MODELLED_LABEL: return "Google's vector buildings (footprints and heights) carried unchanged: not scan measurement";
        default: return String(label);
    }
}

// ----------------------------------------------------------------------------------------------------------------
// the stage runner
// ----------------------------------------------------------------------------------------------------------------

interface StageIO {
    signal: AbortSignal;
    progress(message: string, fraction?: number): void;
}

/** Why a stage's work was ended: Stop, the run's time limit, its own time limit, or the run no longer needs it. */
type Why = 'stop' | 'deadline' | 'budget' | 'cancelled';

interface StageDef<T> {
    id: StageId;
    /** The stage's time limit for this run, when it is not STAGES[id].budgetMs. */
    budgetMs?: number;
    /** The work; it returns its value and what it committed (status committed, or degraded for parts). */
    run(io: StageIO): Promise<StageResult<T>>;
    /** One rung down on the same real data; absent = the stage's failure is hard (resolve, tiles) or has no rung. */
    degrade?(err: unknown, io: StageIO): Promise<StageResult<T>>;
    hardFail?(err: unknown): StagedLocationHardFailure | undefined;
}

interface StageResult<T> {
    status: 'committed' | 'degraded' | 'skipped';
    value?: T;
    source: string;
    reason?: string;
    layers?: StagedLayer[];
    degradations?: DegradationRecord[];
    model?: VisionModelUse;
    cached?: boolean;
    builtAtMs?: number;
    breakdownMs?: Record<string, number>;
}

class Runner {
    private readonly deadlineAt: number;
    constructor(private readonly run: StagedRun, private readonly ctx: StagedLocationContext, private readonly now: () => number, budgetMs = RUN_BUDGET_MS) {
        const left = ctx.remainingMs?.() ?? budgetMs + RUN_DEADLINE_MARGIN_MS;
        this.deadlineAt = now() + Math.max(0, left - RUN_DEADLINE_MARGIN_MS);
    }

    get pastDeadline(): boolean {
        return this.now() >= this.deadlineAt;
    }

    /** A procedural-only build (the 3D Building button): every skip is a step outside that build, left out of the progress view. */
    proceduralOnly = false;
    /** Every stage's limit times this: a chunked district's builds share the machine (pipeline-k/district-chunks.ts chunkCpuShare). */
    budgetScale = 1;
    private budget(id: StageId, ms = STAGES[id].budgetMs): number { return ms * this.budgetScale; }
    /** Stages outside this kind of build on their own (a pipeline K isolate's surroundings), also left out of the progress view. */
    outOfScope: ReadonlySet<StageId> = new Set();

    skip(id: StageId, reason: string, degradations: DegradationRecord[] = []): void {
        const s = this.run.summary(id);
        if (s.status !== 'pending') return;
        this.run.emit(id, 'skipped', { reason, degradations, ...(this.proceduralOnly || this.outOfScope.has(id) ? { outOfScope: true } : {}) });
    }

    /**
     * The stages built on the remesh (grammar, the rebuild, the textures) and the signal that ends them when the ownership
     * vote replaces that remesh: they are skipped, with the reason, and run again on the voted remesh.
     */
    passSignal?: () => AbortSignal;
    static readonly PASS_STAGES: ReadonlySet<StageId> = new Set<StageId>(['grammar', 'relief', 'fit', 'evidence', 'project', 'vision', 'correct', 'detail', 'figures', 'textures', 'textures-late']);

    async stage<T>(def: StageDef<T>, extraSignalIn?: AbortSignal): Promise<Omit<StageResult<T>, 'status'> & { status: StageResult<T>['status'] | 'stopped' }> {
        if (this.ctx.signal?.aborted) throw abortError();
        const id = def.id;
        const pass = this.passSignal && Runner.PASS_STAGES.has(id) ? this.passSignal() : undefined;
        const extraSignal = pass && extraSignalIn ? AbortSignal.any([extraSignalIn, pass]) : (pass ?? extraSignalIn);
        if (this.pastDeadline) {
            const reason = `stopped at the time limit before ${STAGES[id].title.toLowerCase()}`;
            this.run.emit(id, 'stopped', { reason });
            return { status: 'stopped', source: '', reason };
        }
        this.run.emit(id, 'running');
        const budgetMs = this.budget(id, def.budgetMs);
        const io = this.io(budgetMs, extraSignal);
        try {
            const out = await this.race(def.run(io.io), io);
            return this.finish(id, out);
        } catch (err) {
            io.dispose();
            const why = io.why();
            if (why === 'stop' || this.ctx.signal?.aborted) throw abortError();
            if (why === 'cancelled') return this.cancelled(id, extraSignal);
            if (why === 'deadline') return this.stoppedAtDeadline(id);
            const hard = def.hardFail?.(err);
            if (hard) {
                this.run.emit(id, 'failed', { reason: hard.message });
                throw hard;
            }
            const failure = why === 'budget' ? Object.assign(new Error(`${STAGES[id].title} took longer than its ${Math.round(budgetMs / 1000)} s limit`), { code: 'timeout' }) : err;
            if (!def.degrade) throw failure;
            const rung = this.io(budgetMs, extraSignal);
            try {
                const out = await this.race(def.degrade(failure, rung.io), rung);
                return this.finish(id, out);
            } catch (rungErr) {
                const w = rung.why();
                if (w === 'stop' || this.ctx.signal?.aborted) throw abortError();
                if (w === 'cancelled') return this.cancelled(id, extraSignal);
                if (w === 'deadline') return this.stoppedAtDeadline(id);
                throw rungErr;
            } finally {
                rung.dispose();
            }
        } finally {
            io.dispose();
        }
    }

    private stoppedAtDeadline(id: StageId): { status: 'stopped'; source: string; reason: string } {
        const reason = `stopped at the time limit during ${STAGES[id].title.toLowerCase()}`;
        this.run.emit(id, 'stopped', { reason });
        return { status: 'stopped', source: '', reason };
    }

    /**
     * A stage the run ended because nothing downstream can use it (the Street View fetch, once the fit failed). It is
     * skipped, with the reason it was ended for. It hit no time limit and fell to nothing, so it records no degradation.
     */
    private cancelled(id: StageId, extraSignal: AbortSignal | undefined): { status: 'skipped'; source: string; reason: string } {
        const why = extraSignal?.reason;
        const reason = typeof why === 'string' && why ? why : 'the run no longer needs it';
        this.run.emit(id, 'skipped', { reason });
        return { status: 'skipped', source: '', reason };
    }

    private finish<T>(id: StageId, out: StageResult<T>): StageResult<T> {
        const s = this.run.summary(id);
        for (const l of out.layers ?? []) {
            if (!s.layerIds.includes(l.objectId)) s.layerIds.push(l.objectId);
        }
        if (out.cached !== undefined) s.timings.cached = out.cached;
        if (out.builtAtMs !== undefined) s.timings.builtAtMs = out.builtAtMs;
        if (out.breakdownMs) s.timings.breakdownMs = out.breakdownMs;
        const commitsScene = (out.layers?.length ?? 0) > 0 || out.status === 'degraded';
        this.run.emit(id, out.status, {
            source: out.source, ...(out.reason ? { reason: out.reason } : {}), layers: out.layers, degradations: out.degradations, model: out.model
        }, commitsScene);
        return out;
    }

    private io(budgetMs: number, extraSignal?: AbortSignal): { io: StageIO; why(): Why | undefined; dispose(): void; aborted: Promise<never> } {
        const controller = new AbortController();
        let why: Why | undefined;
        const endedBy = (w: Why): Error => w === 'stop' ? abortError()
            : w === 'cancelled' ? Object.assign(new Error('the stage is not needed any more'), { name: 'CancelledError' })
            : Object.assign(new Error(w === 'deadline' ? 'the run reached its time limit' : 'the stage reached its time limit'), { name: 'TimeoutError' });
        const fire = (w: Why) => { if (!why) { why = w; controller.abort(endedBy(w)); } };
        const onStop = () => fire('stop');
        this.ctx.signal?.addEventListener('abort', onStop, { once: true });
        if (this.ctx.signal?.aborted) fire('stop');
        // a stage the run no longer needs (the evidence, once the fit failed) is ended as not needed: it is not a time limit
        const onExtra = () => fire('cancelled');
        extraSignal?.addEventListener('abort', onExtra, { once: true });
        if (extraSignal?.aborted) fire('cancelled');
        const budgetTimer = setTimeout(() => fire('budget'), budgetMs);
        const deadlineTimer = setTimeout(() => fire('deadline'), Math.max(0, this.deadlineAt - this.now()));
        const aborted = new Promise<never>((_, reject) => controller.signal.addEventListener('abort', () => reject(controller.signal.reason), { once: true }));
        aborted.catch(() => undefined);
        return {
            io: { signal: controller.signal, progress: (m, f) => this.ctx.reportProgress?.(m, f) },
            why: () => why,
            dispose: () => { clearTimeout(budgetTimer); clearTimeout(deadlineTimer); this.ctx.signal?.removeEventListener('abort', onStop); extraSignal?.removeEventListener('abort', onExtra); },
            aborted
        };
    }

    private race<T>(work: Promise<T>, io: { aborted: Promise<never> }): Promise<T> {
        work.catch(() => undefined);
        return Promise.race([work, io.aborted]);
    }
}

// ----------------------------------------------------------------------------------------------------------------
// helpers
// ----------------------------------------------------------------------------------------------------------------

function record(stage: StageId | 'finish', reasonCode: string, fields: {
    part: DegradationRecord['part']; intended: string; fellTo: string; provenanceAfter: ProvenanceLabel; reason: string;
    cause?: unknown; transient: boolean; model?: VisionModelUse; runId: string; now: number; suffix?: string; reuses?: StageId[];
}): DegradationRecord {
    const error = fields.cause === undefined ? undefined : (fields.cause instanceof Error ? fields.cause.message : String(fields.cause));
    return {
        id: `d-${stage}-${reasonCode}${fields.suffix ? `-${fields.suffix}` : ''}`,
        stage, part: fields.part, intended: fields.intended, fellTo: fields.fellTo, provenanceAfter: fields.provenanceAfter,
        reasonCode, reason: fields.reason,
        ...(error ? { cause: { error: error.slice(0, 600), at: stage } } : {}),
        ...(fields.model ? { model: fields.model } : {}),
        transient: fields.transient,
        ...(fields.transient && stage !== 'finish' ? { retry: { tool: 'google_3d_tiles_get_clay' as const, args: { retryRunId: fields.runId, retryStage: stage }, reuses: fields.reuses ?? [] } } : {}),
        atMs: fields.now
    };
}

/** Google's vector building footprints (feature tiles, the app's service account). */
const defaultFootprints = (place: { lat: number; lng: number }, radiusM: number): Promise<FootprintSource> =>
    fetchFootprints(place, radiusM, (x, y, z) => GoogleVectorTileService.fetchVectorTile(x, y, z, ''));

function errorMessage(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}

function scanFitCode(err: unknown): string | undefined {
    const code = (err as { code?: unknown })?.code;
    return typeof code === 'string' ? code : undefined;
}

/** Whether a scan_fit error can succeed on a retry: SCAN_FIT_ERROR_TRANSIENT, an unknown code being transient. */
export function scanFitTransient(err: unknown): boolean {
    const code = scanFitCode(err);
    return code === undefined || !(code in SCAN_FIT_ERROR_TRANSIENT) ? true : SCAN_FIT_ERROR_TRANSIENT[code as keyof typeof SCAN_FIT_ERROR_TRANSIENT];
}

/** Whether a tile_vegetation error can succeed on a retry (TILE_VEGETATION_DETERMINISTIC). */
export function vegetationTransient(err: unknown): boolean {
    if (!(err instanceof TileVegetationError)) return true;
    return !TILE_VEGETATION_DETERMINISTIC[err.code];
}

/** What the scan and the photo resolve, measured on the scan's triangles (optionally only those of the structure). */
export function measureSourceLimits(scan: ScanMesh, leafGeometricErrorM: number, cells?: ReadonlySet<string>): SourceLimits {
    const edges: number[] = [];
    const texels: number[] = [];
    const V = scan.mesh.vertices as Float32Array, I = scan.mesh.indices as Uint32Array;
    const stride = Math.max(1, Math.floor(scan.triCount / 200_000));
    for (let t = 0; t < scan.triCount; t += stride) {
        if (cells && !cells.has(`${Math.floor(scan.triCentroid[t * 3])},${Math.floor(scan.triCentroid[t * 3 + 2])}`)) continue;
        const a = I[t * 3] * 3, b = I[t * 3 + 1] * 3;
        edges.push(Math.hypot(V[b] - V[a], V[b + 1] - V[a + 1], V[b + 2] - V[a + 2]));
        const tx = scan.triTexelMeters[t];
        if (tx === tx) texels.push(tx);
    }
    const median = (v: number[]) => { if (!v.length) return 0; const s = [...v].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
    const meshEdgeP50M = round(median(edges));
    const texelM = round(median(texels));
    return {
        leafGeometricErrorM: round(leafGeometricErrorM, 4), meshEdgeP50M,
        meshResolvableM: round(Math.max(meshEdgeP50M, 0.25 * leafGeometricErrorM)), texelM, photoResolvableM: round(2 * texelM)
    };
}

/** What the remesh changed that the scan did not hold, from tile_refine's and strip's stats and the per-vertex provenance. */
export function remeshNote(stats: Record<string, any>, vertexText: string, strip?: Record<string, any>): string {
    const parts: string[] = [];
    const iso = stats?.isolate;
    if (iso?.enabled) {
        const closure = iso.triangles?.closure, patch = iso.groundPatch?.area_m2;
        if (closure || patch) parts.push(`the ground under the structure is rebuilt (${closure ? `${closure} closure triangles` : ''}${closure && patch ? ', ' : ''}${patch ? `a ${Math.round(patch)} m² ground patch` : ''}) and is not in the scan`);
    }
    const removed = strip?.triangles?.removed;
    if (removed > 0) {
        const skirts = strip?.skirts?.areaM2 ? Object.values(strip.skirts.areaM2 as Record<string, number>).reduce((s, v) => s + Number(v || 0), 0) : 0;
        parts.push(`where trees were removed the ground was closed (${(strip?.triangles?.cap ?? 0).toLocaleString('en-US')} cap triangles${skirts >= 1 ? `, ${Math.round(skirts)} m² of closing walls` : ''}), which is not in the scan`);
        const fill = strip?.fill;
        if (fill?.enabled) {
            const gen = Number(fill.cap?.generatedAreaM2 ?? 0) + Number(fill.skirt?.generatedAreaM2 ?? 0);
            const conf = (k: any) => (Number(k?.meanConfidence ?? 0)).toFixed(2);
            parts.push(`the closed ground and walls carry photo-inferred texels from the scan's photo around them (caps: confidence ${conf(fill.cap)}, closing walls: ${conf(fill.skirt)})${gen >= 0.5 ? `, except ${Math.round(gen)} m² with no photographed neighbour, which is generated (the tile's mean colour)` : ''}`);
        }
        const dec = strip?.skirtDecisions;
        if (dec) {
            const sum = (field: 'dropped' | 'shortened') => Object.values(dec as Record<string, any>).filter(v => v && typeof v === 'object' && v[field]).reduce((a, v) => ({ count: a.count + Number(v[field].count ?? 0), area: a.area + Number(v[field].areaM2 ?? v[field].areaRemovedM2 ?? 0) }), { count: 0, area: 0 });
            const dropped = sum('dropped'), shortened = sum('shortened');
            if (dropped.count || shortened.count) parts.push(`${dropped.count ? `${dropped.count} closing walls (${Math.round(dropped.area)} m²) were not built` : ''}${dropped.count && shortened.count ? ' and ' : ''}${shortened.count ? `${shortened.count} were cut down (${Math.round(shortened.area)} m² off)` : ''} where the scan has the real wall behind them`);
        }
        const guard = strip?.buildingGuard;
        if (guard) {
            const kept = Number(guard.keptAsBuilding?.count ?? 0), after = Number(guard.removedOnBuilding?.after?.onWalls ?? 0);
            parts.push(`buildings win over trees: ${kept ? `${kept} scan triangles (${Math.round(Number(guard.keptAsBuilding?.areaM2 ?? 0))} m²) the tree cut would have taken lie on scanned walls and were kept as facade; ` : ''}${after === 0 ? 'no removed triangle lies on a scanned wall' : `${after} removed triangles still lie on scanned walls`}`);
        }
    }
    if (vertexText) parts.push(vertexText);
    return parts.join('; ');
}

function layerCounts(file: string): { vertices: number; triangles: number } {
    return glbMeshCounts(file);
}

/** The registration in words for the stage panel: the overall disagreement, each pano's, and any pano set aside. */
function describeRegistration(r: Registration, pairs: number): string {
    const per = r.perPano.map(p => `${p.panoId.slice(0, 6)}: ${p.pairs} pairs, ${p.beforeRmsM.toFixed(2)} -> ${p.afterRmsM.toFixed(2)} m (shift ${Math.hypot(p.dxM, p.dzM).toFixed(2)} m, heading ${p.dyawDeg.toFixed(2)}°, pitch ${p.dpitchDeg.toFixed(2)}°)`).join('; ');
    const aside = r.setAside.length ? `; set aside as implausible and left at their stated poses: ${r.setAside.map(a => `${a.panoId.slice(0, 6)} (${a.reason})`).join('; ')}` : '';
    return `pano poses registered from ${r.used} of ${pairs} matched pairs: ${r.beforeRmsM.toFixed(2)} m RMS disagreement before, ${r.afterRmsM.toFixed(2)} m after. Per pano ${per}${aside}`;
}

/** The texture bake's observed-surface tolerance against the scan: 0.5 m + 3 cm per metre of view distance (the scan's
 *  leaf error is ~0.6 m median edge; fitted faces sit within centimetres of the scan where the scan has samples). */
export const TEXTURE_OBSERVED_SURFACE = { baseM: 0.5, perMeter: 0.03 };
/**
 * A quarter of the pose uncertainty (live: ~1.2 m residual, so ~0.3 m on the surface) is kept clear of every silhouette.
 * Measured on the live Washington Square Arch (replayed bake, Street View share of the layer's texels / share of baked
 * texels whose 5 x 5 colour is > 25 CIEDE2000 from the tile photo there, a background-leak proxy):
 *   l3b  0: 33.1 % / 7.4 %   0.15: 29.3 % / 6.5 %   0.25: 25.8 % / 6.6 %   0.3: 23.9 % / 7.1 %   0.5: 18.3 % / 4.1 %
 *   l2   0: 32.7 % / 4.0 %   0.25: 26.2 % / 3.9 %   0.5: 18.9 % / 3.3 %
 * The texels 0.5 -> 0.25 adds are 'far' about 13 % (l3b) and 5 % (l2) of the time (against 4 % and 3 % of what 0.5 keeps),
 * the ones 0.25 -> 0 adds 10 % and 4 %. 0.25 gives back 40 % of the coverage 0.5 cost (l3b 18 -> 26 %) for a leak proxy
 * between the two ends (l3b 6.6 % against 4.1 % and 7.4 %); the per-chart alignment and one view per region now take
 * part of what the wider guard was for (a sample carried across a silhouette by the pose error).
 */
export const TEXTURE_POSE_EDGE_GUARD_SHARE = 0.25;
/** Time the texture stage keeps free of the leave-one-pano-out measurement at its end (writing the record, publishing). */
export const TEXTURE_LOO_MARGIN_MS = 60_000;

/** What the texture stage hands the result and the summary. */
export interface TextureStageValue {
    record: TexturePassRecord;
    /** Share of all textured atlas texels per rung (TEXTURE_LADDER_RUNGS order). */
    shares: number[];
    views: number;
    modelsUsed: string[];
    layers: Array<{
        layer: string; objectId: string; url: string; rungShares: number[]; atlasTexels: number; atlas: TextureLayerOutcome['atlas'];
        projection?: TextureLayerOutcome['projection']; enhance?: TextureLayerOutcome['enhance']; cached: boolean;
    }>;
    tileUnavailable?: string;
    viewsUnavailable?: string;
    /** The twins are tile_refine's own photo-textured remesh (a district), not the texture pass's bake. */
    tileRefine?: boolean;
}

/** The fitted charts a layer is textured with, as a key: a layer textured with charts a later refit replaced is textured again. */
function surfacesKey(surfaces: Array<{ id: string; chart: unknown }> | undefined): string {
    return surfaces?.length ? sha256Bytes(Buffer.from(JSON.stringify(surfaces))) : 'none';
}

function sha256Bytes(bytes: Uint8Array): string {
    return crypto.createHash('sha256').update(bytes).digest('hex');
}

/** Rung shares over several layers, weighted by each layer's texel count. */
export function weightedShares(parts: Array<{ shares: number[]; texels: number }>): number[] {
    const total = parts.reduce((a, p) => a + p.texels, 0);
    const out = new Array<number>(TEXTURE_LADDER_RUNGS.length).fill(0);
    if (!total) return out;
    for (const p of parts) p.shares.forEach((v, r) => { out[r] += (v * p.texels) / total; });
    return out;
}

/** One line: the texture rungs as measured, the views and the models. */
export function describeTextures(v: TextureStageValue): string {
    const pct = (x: number) => `${Math.round(x * 1000) / 10}%`;
    const rungs = v.shares.map((x, r) => (x > 0 ? `${TEXTURE_LADDER_RUNGS[r]} ${pct(x)}` : '')).filter(Boolean).join(', ');
    if (v.tileRefine) return `textured ${v.layers.map(l => l.layer).join(', ')} with the tile photo tile_refine carries onto its remesh, de-lit (the shadow and highlight it was captured under lifted/compressed): ${rungs}; photo-derived texels are photo-inferred`;
    return `textured ${v.layers.map(l => l.layer).join(', ')} from ${v.views} registered Street View view${v.views === 1 ? '' : 's'}${v.tileUnavailable ? '' : ' and the tile photo'}: ${rungs}`
        + `${v.modelsUsed.length ? `; enhanced by ${v.modelsUsed.join(', ')}` : ''}; photo-derived texels are photo-inferred`;
}

/**
 * The camera of a run whose first layer is the vector first paint: for a district, the one the tiles will give (the anchor on
 * the ground, the requested radius), so the view does not move when they arrive; for an isolated structure, framed on the
 * vector building under the place (or the nearest one within 30 m), which the tiles' structure pick then refines.
 */
export function vectorCamera(bounds: { min: [number, number, number]; max: [number, number, number] }, buildings: PaintBuilding[], isolate: boolean, radiusM: number, bases?: number[]): StagedCamera {
    if (!isolate) return stagedCamera(bounds, [0, 0, 0], radiusM);
    let best = -1, bestD = Infinity;
    buildings.forEach((b, i) => { const d = Math.hypot(b.centroid[0], b.centroid[1]); if (d < bestD) { bestD = d; best = i; } });
    if (best < 0 || bestD > 30) return stagedCamera(bounds, [0, 0, 0], radiusM);
    const b = buildings[best];
    const top = Math.max(0, ...b.parts.map(p => p.topH), ...b.volumes.flatMap(v => v.vertices.map(q => q[1])));
    const y0 = bases?.[best] ?? 0;
    const half = Math.sqrt(Math.max(1, b.areaM2)) / 2;
    return stagedCamera(bounds, [b.centroid[0], y0 + top / 2, b.centroid[1]], Math.hypot(half, half, top / 2));
}

/** The remesh the scene stands on now: the voted remesh once the ownership vote replaced the first isolate, else the remesh. */
function currentRemeshLayer(run: StagedRun): StagedLayer | undefined {
    return run.state.layers.filter(l => !l.retired && ((l.layer === 'l2' && l.stage === 'remesh') || l.layer === 'l2v')).pop();
}

/** A promise with its resolve, for a stage that waits on a decision another stage makes. */
function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
    let resolve!: (v: T) => void;
    const promise = new Promise<T>(r => { resolve = r; });
    return { promise, resolve };
}

function loadMesh(files: Array<string | undefined>): RenderMesh3D {
    const prims = files.filter((f): f is string => !!f && fs.existsSync(f)).flatMap(f => readGlbScene(f));
    return sceneToRenderMesh(prims);
}

// ----------------------------------------------------------------------------------------------------------------
// the run
// ----------------------------------------------------------------------------------------------------------------

/** A district layer published without the kept structure's footprint (keptStructureCarver). */
const CARVED_URL = /_around_[0-9a-f]{8}\.glb$/;

/** The roads stage's extra time with the kerbs on: at Penn over 210 m their read and photo alone took 2.5 minutes, at a load of 150-300. */
const ROAD_KERBS_EXTRA_BUDGET_MS = 360_000;
/** And with the steps on: the inclines read, and each melted flight's two Street View views counted, four flights at a time. */
const GROUND_STEPS_EXTRA_BUDGET_MS = 300_000;
/** A ground layer published with the scan carved under the streets' kerbs (roadCarver). */
const ROAD_CARVED_URL = /_road_[0-9a-f]{8}\.glb$/;

/** What the district layers lost to the kept structure, per layer (the result's activeScene.footprintHidden). */
const FOOTPRINT_REPORTS = new WeakMap<StagedRun, { footprint?: StructureFootprint; error?: string; layers: Array<{ objectId: string; removedTriangles: number; keptTriangles: number }> }>();

/** The native steps' own time limit when the request names none (tile-refine-service.ts, tile-vegetation-service.ts). */
const NATIVE_STEP_TIMEOUT_MS = 300_000;

/** The services with each native step held to `share.threads` and its time limit scaled by `share.slowdown` (a chunked district). */
function withCpuShare(deps: StagedLocationDeps, share: { threads: number; slowdown: number }): StagedLocationDeps {
    const limit = (ms: number | undefined) => ms ?? Math.round(NATIVE_STEP_TIMEOUT_MS * share.slowdown);
    const refine = deps.refine;
    return {
        ...deps,
        refine: {
            refine: req => refine.refine({ ...req, threads: req.threads ?? share.threads, timeoutMs: limit(req.timeoutMs) }),
            ...(refine.renderOwnershipViews ? { renderOwnershipViews: refine.renderOwnershipViews.bind(refine) } : {}),
            ...(refine.isolate ? { isolate: (req: TileRefineRequest) => refine.isolate!({ ...req, threads: req.threads ?? share.threads, timeoutMs: limit(req.timeoutMs) }) } : {})
        },
        vegetation: {
            ...deps.vegetation,
            strip: req => deps.vegetation.strip({ ...req, threads: req.threads ?? share.threads, timeoutMs: limit(req.timeoutMs) }),
            plant: req => deps.vegetation.plant({ ...req, threads: req.threads ?? share.threads, timeoutMs: limit(req.timeoutMs) })
        }
    };
}

/** Two layer transforms one after the other (either may be absent). */
function chainLayerTransforms(a: StagedRun['layerTransform'], b: StagedRun['layerTransform']): StagedRun['layerTransform'] {
    if (!a) return b;
    if (!b) return a;
    return (layer, meta) => b(a(layer, meta), meta);
}

/** What joining one chunk took here, from its outcome in hand to its last layer published (the chunks stage's report). */
interface ChunkJoinRecord {
    files: number;
    /** Layer files that came cut by the chunk's own build (the cloud job), and those cut here. */
    cutByJob: number;
    cutHere: number;
    /** Bytes read (as downloaded) and written, and the bytes the compaction dropped (in the job, or here). */
    bytesIn: number;
    bytesOut: number;
    droppedBytes: number;
    /** On the join's worker thread (read; check, or cut, place and compact; write), and publishing on this thread. */
    workerMs: number;
    publishMs: number;
    ms: number;
}

/** A layer file joined into a chunked district (published under this suffix): never cut again. */
const CHUNK_URL = /_kd\d+_[0-9a-f]{8}\.glb$/;

/**
 * Pipeline K-D: the centre build of a chunked district keeps only what it owns (pipeline-k/district-chunks.ts): each layer
 * it commits (and its textured twin) is cut, the scan and ground by triangle to `keep` (what it owns and a band past it, for
 * the seam stage), trees whole to `keepOwn`. The vector first paint and the chunks joined from the other builds
 * (meta.extra.chunk) are left as they are.
 */
function territoryClipper(run: StagedRun, cache: StageCache, keep: (x: number, z: number) => boolean, keepOwn: (x: number, z: number) => boolean): (layer: StagedLayer, meta: StagedLayerObjectMeta) => StagedLayer {
    const done = new Map<string, { url: string; bytes: number; kept: number } | undefined>();
    const identity = Float64Array.from([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
    const clip = (url: string, whole: boolean) => {
        if (!url.startsWith('/models/') || CHUNK_URL.test(url)) return undefined;
        if (done.has(url)) return done.get(url);
        const source = path.join(cache.modelsDir, path.basename(url));
        if (!fs.existsSync(source)) return undefined;
        const out = joinChunkGlb(fs.readFileSync(source), identity, whole ? keepOwn : keep, { whole });
        let r: { url: string; bytes: number; kept: number } | undefined;
        if (out.removedTriangles) {
            const dir = path.join(cache.dir, 'district-chunks');
            fs.mkdirSync(dir, { recursive: true });
            const name = `${path.basename(url, '.glb')}_kd0_${crypto.createHash('sha256').update(url).digest('hex').slice(0, 8)}.glb`;
            fs.writeFileSync(path.join(dir, name), out.glb);
            const pub = cache.publishFile(path.join(dir, name), name);
            r = { url: pub.url, bytes: pub.bytes, kept: out.keptTriangles };
        }
        done.set(url, r);
        return r;
    };
    return (layer, meta) => {
        if (layer.stage === 'vector' || (meta.extra as { chunk?: number } | undefined)?.chunk !== undefined) return layer;
        const whole = !!meta.vegetation;
        const c = clip(layer.url, whole), ct = layer.textured ? clip(layer.textured.url, whole) : undefined;
        if (!c && !ct) return layer;
        return {
            ...layer,
            ...(c ? { url: c.url, bytes: c.bytes, counts: { vertices: layer.counts.vertices, triangles: c.kept } } : {}),
            ...(layer.textured && ct ? { textured: { ...layer.textured, url: ct.url, bytes: ct.bytes } } : {})
        };
    };
}

/**
 * The layer transform of a run staged around a kept structure: each district scan layer (source Google3DTilesClay, not
 * vegetation) is republished without its triangles inside the structure's footprint and above its base. The footprint
 * is measured once, from the kept structure's shown layers moved into this run's frame (so it needs the extraction's
 * anchor, which is set before the first layer commits).
 */
function keptStructureCarver(run: StagedRun, cache: StageCache, base: string): (layer: StagedLayer, meta: StagedLayerObjectMeta) => StagedLayer {
    const report: { footprint?: StructureFootprint; error?: string; layers: Array<{ objectId: string; removedTriangles: number; keptTriangles: number }> } = { layers: [] };
    FOOTPRINT_REPORTS.set(run, report);
    let measured = false;
    return (layer, meta) => {
        // a layer already carved (its later commits: a textured twin added) is not carved again
        if (meta.source !== 'Google3DTilesClay' || meta.vegetation || CARVED_URL.test(layer.url)) return layer;
        const carried = run.carried!;
        if (!measured) {
            measured = true;
            try {
                const ids = new Set(carried.structure.map(o => o.id));
                const hidden = new Set(carried.structureLayers.flatMap(l => l.supersedes));
                const shown = carried.structure.filter(o => ids.has(o.id) && !hidden.has(o.id));
                const files = shown.map(o => String((o.content as { durableUri?: string }).durableUri ?? ''))
                    .filter(u => u.startsWith('/models/')).map(u => path.join(cache.modelsDir, path.basename(u))).filter(f => fs.existsSync(f));
                if (!files.length) throw new Error('none of the kept structure\'s model files is on disk');
                report.footprint = structureFootprint(files.map(f => fs.readFileSync(f)), anchorOffset(carried.anchor, run.geoAnchor));
            } catch (err) {
                report.error = errorMessage(err);
            }
        }
        const fp = report.footprint;
        if (!fp) return layer;
        const source = path.join(cache.modelsDir, path.basename(layer.url));
        if (!fs.existsSync(source)) return layer;
        const out = hideFootprintInGlb(fs.readFileSync(source), fp);
        report.layers = [...report.layers.filter(r => r.objectId !== layer.objectId), { objectId: layer.objectId, removedTriangles: out.removedTriangles, keptTriangles: out.keptTriangles }];
        if (!out.removedTriangles) return layer;
        const key8 = crypto.createHash('sha256').update('kept-structure/v2').update([...fp.cells].sort().join(';')).update(String(fp.baseY)).digest('hex').slice(0, 8);
        const dir = path.join(cache.dir, 'kept-structure');
        fs.mkdirSync(dir, { recursive: true });
        const name = `${path.basename(layer.url, '.glb')}_around_${key8}.glb`;
        const tmp = path.join(dir, name);
        fs.writeFileSync(tmp, out.glb);
        const pub = cache.publishFile(tmp, name);
        const note = `${out.removedTriangles.toLocaleString('en-US')} triangles inside the kept structure's footprint (${fp.cells.size} cells of ${fp.cellM} m) and more than 0.3 m above the ground around it (${out.groundY.toFixed(2)} m) taken out, where the kept rebuild stands`;
        return {
            ...layer, url: pub.url, bytes: pub.bytes,
            counts: { vertices: layer.counts.vertices, triangles: out.keptTriangles },
            provenance: { ...layer.provenance, note: layer.provenance.note ? `${layer.provenance.note}; ${note}` : note }
        };
    };
}

/** What the streets' carve did to a ground layer's file (the run note road_carve). */
interface RoadCarveRecord { objectId: string; url: string; textured: boolean; report: RoadCarveReport; flatten?: RoadFlattenStats; ms: number }

/**
 * The layer transform of a build whose streets were drawn with kerbs and gutters (road-kerbs.ts): the shown ground (the
 * remesh, or whatever layer is the ground) and its textured twin are republished with the scan's streets just outside the
 * new surfaces settled onto SB-Roadie's levels (road-flatten.ts), then carved under them (road-carve.ts), so nothing of the
 * scan pokes through. Each file is carved once; a file carved already (a later commit adding the twin, the seam stage's cut
 * of a carved ground) is left as it is, and a chunk's own layers come carved by its own build.
 */
function roadCarver(cache: StageCache, roads: RoadSurface[], footprint: CarveFootprint, key8: string, buildingAt: ((x: number, z: number) => number) | undefined, records: RoadCarveRecord[]): (layer: StagedLayer, meta: StagedLayerObjectMeta) => StagedLayer {
    const done = new Map<string, { url: string; bytes: number; kept: number } | undefined>();
    const target = roadFlattenEnabled() ? flattenTargets(roads, ROAD_FLATTEN_PARAMS, { liftM: 0, ...(buildingAt ? { buildingAt } : {}) }) : undefined;
    const carve = (url: string, objectId: string, textured: boolean) => {
        if (!url.startsWith('/models/') || ROAD_CARVED_URL.test(url)) return undefined;
        if (done.has(url)) return done.get(url);
        const source = path.join(cache.modelsDir, path.basename(url));
        let r: { url: string; bytes: number; kept: number } | undefined;
        if (fs.existsSync(source)) {
            const t0 = Date.now();
            let bytes: Uint8Array = fs.readFileSync(source);
            if (!isRoadCarved(bytes)) {
                const flat = target ? flattenRoadsInGlb(bytes, target) : undefined;
                if (flat) bytes = flat.glb;
                const out = carveUnderRoads(bytes, footprint);
                const dir = path.join(cache.dir, 'road-carve');
                fs.mkdirSync(dir, { recursive: true });
                const name = `${path.basename(url, '.glb')}_road_${key8}.glb`;
                fs.writeFileSync(path.join(dir, name), out.glb);
                const pub = cache.publishFile(path.join(dir, name), name);
                r = { url: pub.url, bytes: pub.bytes, kept: layerCounts(path.join(dir, name)).triangles };
                records.push({ objectId, url, textured, report: out.report, ...(flat ? { flatten: flat.stats } : {}), ms: Date.now() - t0 });
            }
        }
        done.set(url, r);
        return r;
    };
    return (layer, meta) => {
        const ground = layer.layer === 'l2' || meta.isGround === true;
        // a chunk joined from another build (meta.extra.chunk) was carved by that build; the centre's own ground, clipped to
        // its territory first (published as _kd0_), is carved here like any other
        if (!ground || meta.source !== 'Google3DTilesClay' || meta.vegetation || (meta.extra as { chunk?: number } | undefined)?.chunk !== undefined) return layer;
        const c = carve(layer.url, layer.objectId, false), ct = layer.textured ? carve(layer.textured.url, layer.objectId, true) : undefined;
        if (!c && !ct) return layer;
        const rec = records.filter(x => x.objectId === layer.objectId && !x.textured).pop()?.report;
        const note = rec && !layer.provenance.note?.includes(ROAD_CARVE_VERSION)
            ? `the scan carved under the streets' new surfaces (${ROAD_CARVE_VERSION}): ${rec.removed.toLocaleString('en-US')} triangles removed and ${rec.cut.toLocaleString('en-US')} cut at their outline (${Math.round(rec.removedAreaM2)} m²), ${rec.standing} pieces standing on them kept; its rim set onto their edge (${rec.pinned} points, at most ${rec.maxPinM} m), ${rec.curtainTriangles} curtain triangles (generated) where it stood further`
            : undefined;
        return {
            ...layer,
            ...(c ? { url: c.url, bytes: c.bytes, counts: { vertices: layer.counts.vertices, triangles: c.kept } } : {}),
            ...(layer.textured && ct ? { textured: { ...layer.textured, url: ct.url, bytes: ct.bytes } } : {}),
            ...(note ? { provenance: { ...layer.provenance, note: layer.provenance.note ? `${layer.provenance.note}; ${note}` : note } } : {})
        };
    };
}

/** A new surface's layer (the kerbed streets, the steps) with its photo seen from above taken again from `twinFile` over the
 *  same planar frame its texture coordinates read, at its own level; undefined when its file is gone or its texture is not
 *  planar. */
function recolourFromTwin(cache: StageCache, layer: StagedLayer, twinFile: string, tag: string): { url: string; bytes: number; ms: number; cached: boolean } | undefined {
    const source = path.join(cache.modelsDir, path.basename(layer.url));
    if (!fs.existsSync(source)) return undefined;
    const t0 = Date.now();
    const name = `${path.basename(layer.url, '.glb').replace(/_tw[0-9a-f]{8}$/, '')}_tw${tag}.glb`;
    const dir = path.join(cache.dir, 'road-carve'), file = path.join(dir, name);
    const cached = fs.existsSync(file);
    if (!cached) {
        const bytes = fs.readFileSync(source);
        const frame = planarFrameOf(bytes);
        if (!frame) return undefined;
        const photo = renderTopDownPhoto(fs.readFileSync(twinFile), frame, { texelM: Math.max(0.05, Math.max(frame.widthM, frame.heightM) / 4096), maxPx: 4096, referenceY: frame.meanY });
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(file, withGlbImage(bytes, topDownJpeg(photo, 90)));
    }
    const pub = cache.publishFile(file, name);
    return { url: pub.url, bytes: pub.bytes, ms: Date.now() - t0, cached };
}

/** The result's account of the active scene: what was kept and what was taken out, by object id. */
function activeSceneReport(run: StagedRun): StagedActiveSceneReport | undefined {
    const c = run.carried;
    if (!c) return undefined;
    const fp = FOOTPRINT_REPORTS.get(run);
    const layerOf = new Map(c.structureLayers.map(l => [l.objectId, l]));
    const kept = c.structure.map(o => {
        const l = layerOf.get(o.id);
        return { objectId: o.id, ...(l ? { layer: l.layer, provenance: String(l.provenance.label) } : {}), source: String((o.content as { metadata?: { source?: string } }).metadata?.source ?? ''), textured: !!l?.textured };
    });
    const offset = anchorOffset(c.anchor, run.geoAnchor);
    const notes: string[] = [];
    if (kept.length && c.anchor?.elevation === undefined) notes.push('the earlier scene had no anchor height, so the kept structure is not moved vertically');
    if (fp?.error) notes.push(`the district's own scan of the structure could not be taken out (${fp.error}), so both stand in the same place`);
    return {
        artifactId: run.state.artifactId, kept, removed: c.removed, otherObjectsKept: c.other.length,
        ...(c.runId ? { keptFromRunId: c.runId } : {}),
        ...(kept.length && c.materialMode ? { materialMode: c.materialMode } : {}),
        ...(kept.length ? { offsetM: offset } : {}),
        ...(fp?.footprint ? { footprintHidden: { cellM: fp.footprint.cellM, cells: fp.footprint.cells.size, layers: fp.layers } } : {}),
        ...(notes.length ? { note: notes.join('; ') } : {})
    };
}

/**
 * The deps with every model client taken out (request.steps.models false): the vision chain (the facade reader, the
 * building system, the window reader, vehicles, material naming, picks and finishes, the upscale), the texture pass's
 * enhancement and lighting models, the grounded references and pipeline J's paid services. Each stage that needed one
 * then runs its own model-free path, as it does where no model is configured, and says so.
 */
export function withoutModels(deps: StagedLocationDeps): StagedLocationDeps {
    const { groundedReferences: _g, pipelineI: _i, ...rest } = deps;
    const textures = deps.textures ? (({ enhance: _e, lighting: _l, ...t }) => t)(deps.textures) : undefined;
    return { ...rest, vision: { unavailable: 'no model is asked in this build (models off: the district\'s shown band, its model-refined detail after)' }, ...(textures ? { textures } : {}) };
}

export async function runStagedLocation(requestIn: StagedLocationRequest, deps: StagedLocationDeps, ctx: StagedLocationContext = {}): Promise<StagedLocationOutcome> {
    // every request to the vision models this run makes is kept to the process's call budget and counted (model_calls note)
    const modelCalls = new ModelCallMeter();
    // `models` off (a district's shown band, district-chunks.ts KD_SHOWN_STEPS): this build asks no model anything
    if (requestIn.steps?.models === false) deps = withoutModels(deps);
    if (deps.vision && 'client' in deps.vision) deps = { ...deps, vision: { ...deps.vision, client: budgetedClient(deps.vision.client, { meter: modelCalls }) } };
    const now = deps.now ?? Date.now;
    const cache = deps.cache;
    // one grounding request per view per run: a view fetched ahead (the ring, while the survey reads) is reused, never refetched
    // the grounding API's refusals this run: a refused pano is never asked for again, and the next eligible one is
    const streetView = deps.streetView?.grounding ? { ...deps.streetView, grounding: memoizeGrounding(deps.streetView.grounding), refusedPanos: deps.streetView.refusedPanos ?? new Map<string, string>() } : deps.streetView;
    // a retry rebuilds the recorded request exactly; the model never re-words it
    let request = requestIn;
    let recordedArtifactId: string | undefined;
    const recordedRunId = ctx.retry?.runId ?? ctx.resume?.runId;
    if (recordedRunId) {
        const rec = cache.readRunRecord<RunRecord>(recordedRunId);
        if (!rec) throw new StagedLocationHardFailure('resolve', 'unknown_run', `There is no staged run ${recordedRunId} to ${ctx.retry ? 'retry' : 'resume'} (its record is not in .scratchbox/cache/staged_location/runs).`);
        request = rec.request;
        recordedArtifactId = rec.artifactId;
    }
    const retryStage = ctx.retry?.stage;
    const bypass = (id: StageId) => retryStage === id;
    // the vision replies of identical earlier requests are read back (a retry of the stage asks the model again), and a
    // call whose first token is late is sent once more (VisionModelChainOptions.hedgeAfterMs)
    const chainExtras = (id: StageId) => ({ hedgeAfterMs: VISION_HEDGE_AFTER_MS, ...(bypass(id) ? {} : { replyCache: stagedReplyCache(cache) }) });
    // the vision model's answers kept between builds (pipeline-k/model-readings.ts), one store a run; one this workspace
    // lacks is read back from the cache mirror's bucket before the model is asked (stage-cache.ts restoreFile)
    let readingStore: ReturnType<typeof fileReadingStore> | undefined;
    const modelReadingsStore = () => (readingStore ??= fileReadingStore(modelReadingsDir(cache.dir), { restore: rel => cache.restoreFile(`${MODEL_READINGS_DIR}/${rel}`) }));
    const runId = deps.newRunId?.() ?? crypto.randomBytes(4).toString('hex');
    cache.activeRunId = runId;
    // every stage event also goes to the run's wall-clock timeline (runs/<runId>/timeline.jsonl)
    const timelineFile = (() => { try { return path.join(path.dirname(cache.runRecordPath(runId)), 'timeline.jsonl'); } catch { return undefined; } })();
    if (timelineFile) ctx = { ...ctx, emitStage: recordStageTimeline(timelineFile, runId, now(), ctx.emitStage, now) };
    // main-thread blocks over the whole run, kept as a run note (event-loop-stats.ts)
    let runningStages: () => string[] = () => [];
    const blockTracer = runBlockTracer(() => runningStages());
    const active = ctx.activeArtifact?.type === '3d-scene' ? ctx.activeArtifact : undefined;
    const intoActive = active && (request.stageIntoActiveScene || (recordedArtifactId && active.id === recordedArtifactId)) ? active : undefined;
    const artifactId = stagedArtifactId(runId, intoActive?.id);
    const run = new StagedRun(runId, request, ctx, now, artifactId, intoActive);
    runningStages = () => STAGE_IDS.filter(id => run.summary(id).status === 'running');
    const runner = new Runner(run, ctx, now, (request.isolate ? RUN_BUDGET_MS : stagedPipelineKD(request) && !request.chunk ? CHUNKED_DISTRICT_RUN_BUDGET_MS : DISTRICT_RUN_BUDGET_MS) + (request.isolate && facadeUpscaleAsked(request.steps) ? FACADE_UPSCALE_EXTRA_MS : 0));
    runner.proceduralOnly = request.procedural === true;
    // a procedural-only build never lists the other stages, not even as pending before they are skipped
    if (runner.proceduralOnly) for (const s of run.state.stages) if (!PROCEDURAL_STAGES.has(s.stage)) s.outOfScope = true;
    // a pipeline K isolate (the 3D Building default) never loads the place around the building
    const kIsolate = request.isolate === true && request.procedural !== true && stagedPipelineK(request);
    /** Pipeline K-D: K over a whole district; its vector buildings, once read, group the twin's colour match per building. */
    const kdDistrict = stagedPipelineKD(request);
    let districtBuildings: PaintBuilding[] | undefined;
    /** Pipeline K-D's chunks, when the district is larger than one build reaches (planned once the place is resolved). */
    let chunkPlan: DistrictChunkPlan | undefined;
    // a chunked district's builds share the machine: each its share of the cores, its native and stage limits scaled to match
    const cpuShare = kdDistrict && (request.chunk || (request.radiusM ?? 250) > DISTRICT_CHUNKS_PARAMS.minChunkedRadiusM) ? chunkCpuShare() : undefined;
    if (cpuShare) { deps = withCpuShare(deps, cpuShare); runner.budgetScale = cpuShare.slowdown; }
    if (kIsolate) {
        runner.outOfScope = PIPELINE_K_ISOLATE_SKIPPED;
        for (const s of run.state.stages) if (PIPELINE_K_ISOLATE_SKIPPED.has(s.stage as StageId)) s.outOfScope = true;
    }
    const base = `${slug(request.query)}${request.isolate ? '_iso' : ''}`;
    // a step the node graph can turn on or off for this build: the request's choice, else the step's default
    const stepOn = (key: string, byDefault: boolean): boolean => {
        const asked = request.steps?.[key];
        return typeof asked === 'boolean' && TOGGLEABLE_STEPS.has(key) ? asked : byDefault;
    };
    // a timed step: the run's step log (steps.jsonl) and the run record the node graph reads (StagedBuildState.steps)
    const STEP_STAGE: Record<string, string> = { polish: 'remesh', twin: 'textures' };
    const logStep = (key: string, state: 'running' | 'done' | 'failed' | 'skipped') => {
        cache.logRunStep(runId, key, state);
        const group = key.split('.', 1)[0];
        run.step(key, STEP_STAGE[group] ?? group, state);
    };
    const persist = () => {
        const rec: RunRecord = {
            schema: 'scratchbox.staged-run/1', runId, request, place: placeValue, artifactId, keys: run.keys,
            statuses: Object.fromEntries(run.state.stages.map(s => [s.stage, s.status])), createdAtMs: run.startedAt
        };
        cache.writeRunRecord(runId, rec);
    };
    let placeValue: ResolvedPlace | undefined;
    let placePull: Promise<void> | undefined;
    // every stage promise the call starts is settled before it returns or throws, so none runs on, or rejects unseen, after it
    const siblings: Array<Promise<unknown>> = [];
    // the tiles' extraction, for the stages that start before it and finish after it (the vector first paint)
    let tilesSettle!: (v: { extraction: StagedExtraction; key: string } | undefined) => void;
    const tilesReady = new Promise<{ extraction: StagedExtraction; key: string } | undefined>(r => { tilesSettle = r; });
    // the texture worker threads load for seconds (ts-node): an isolated structure's start loading as soon as its tiles are in
    let earlyTexturePool: TextureWorkerPool | undefined;
    const takeEarlyPool = (): TextureWorkerPool | undefined => { const p = earlyTexturePool; earlyTexturePool = undefined; return p; };

    try {
        // ---------------- resolve ----------------
        const resolved = await runner.stage<ResolvedPlace>({
            id: 'resolve',
            run: async io => {
                if (request.place) {
                    // chosen from the alternatives Google already returned: the coordinates are used as given, nothing is looked up
                    run.keys.resolve = stageKey('place/v1', request.place.lat.toFixed(6), request.place.lng.toFixed(6));
                    run.cacheStatus.resolve = 'miss';
                    return { status: 'committed', value: request.place, source: request.place.formattedAddress };
                }
                const key = stageKey('geocode/v1', request.query.trim().toLowerCase().replace(/\s+/g, ' '));
                run.keys.resolve = key;
                const hit = cache.get<ResolvedPlace>('resolve', key);
                if (hit && now() - hit.builtAtMs < GEOCODE_TTL_MS) {
                    run.cacheStatus.resolve = 'hit';
                    return { status: 'committed', value: hit.value, source: hit.value.formattedAddress, cached: true, builtAtMs: hit.builtAtMs };
                }
                run.cacheStatus.resolve = 'miss';
                const entry = await cache.run('resolve', key, async () => ({ value: await deps.geocode(request.query, io.signal) }), { bypass: true });
                return { status: 'committed', value: entry.value, source: entry.value.formattedAddress };
            },
            hardFail: err => new StagedLocationHardFailure('resolve', 'place_unresolved', `The place could not be resolved: ${errorMessage(err)}`)
        });
        if (resolved.status === 'stopped' || !resolved.value) throw new StagedLocationHardFailure('resolve', 'run_deadline', `The run reached its time limit before the place was resolved, so there is nothing to show.`);
        placeValue = resolved.value;
        // a district run reads its place's store first (place-store.ts pullPlace): the place's objects into the object store,
        // its readings into the reading store; read in the background, waited for before the run's objects are kept
        if (kdDistrict && !request.chunk && placeStoreEnabled()) placePull = pullPlaceForRun({ place: placeValue, store: defaultDurableAssetStore(), readingsDir: modelReadingsDir(cache.dir), workspace: cache.workspaceRoot })
            .then(r => { cache.writeRunNote(runId, 'place_pull', r); }, () => undefined);
        run.state.place = { query: request.query, resolvedAddress: placeValue.formattedAddress, lat: placeValue.lat, lng: placeValue.lng, ...(placeValue.alternatives?.length ? { alternatives: placeValue.alternatives } : {}) };
        persist();
        // pipeline K-D: a district larger than one build reaches is cut into chunks (pipeline-k/district-chunks.ts); this build is the
        // centre chunk, its extraction sized to the buildings it owns, and the 'chunks' stage builds and joins the rest
        if (kdDistrict && !request.chunk && deps.runChunk && deps.vectorEvidence) {
            try {
                const radius = request.radiusM ?? 250;
                // the buildings the circle may reach too (their middles up to the edge growth past it): each planned whole or left out
                const reach = radius + DISTRICT_CHUNKS_PARAMS.edgeGrowthM;
                const ev = await deps.vectorEvidence({ lat: placeValue.lat, lng: placeValue.lng, radiusM: reach });
                // a task per building only where every chunk, the centre too, builds in the cloud: a centre built here would
                // rebuild its cell's buildings only for them to be cut away
                let unit = kdChunkUnit();
                if (unit === 'building' && kdCentreRunner() !== 'cloud') {
                    unit = 'cell';
                    run.note(PROVENANCE.asScanned, 'a task per building (SCRATCHBOX_KD_CHUNK_UNIT=building) needs the cloud chunk runner with its centre in the cloud: the district is built by cells');
                }
                chunkPlan = planDistrictChunks(radius, selectPaintBuildings(ev, reach).buildings.map(b => ({ id: b.id, centroid: b.centroid, loops: b.parts.map(p => p.loops[0]).filter(l => l && l.length >= 3) })), DISTRICT_CHUNKS_PARAMS, unit);
                if (chunkPlan) {
                    // the whole plan, footprints too: the seam stage's ownership can be rebuilt from it offline
                    cache.writeRunNote(runId, 'district_chunks', chunkPlan);
                    const owner = chunkOwner(chunkPlan), centre = chunkPlan.chunks.find(c => c.centre)!;
                    const cellCount = chunkPlan.chunks.filter(isCellChunk).length;
                    run.note(PROVENANCE.asScanned, chunkPlan.unit === 'building'
                        ? `chunked district (${chunkPlan.version}): the ${Math.round(radius)} m asked for cut into ${cellCount} cells of ${chunkPlan.cellM} m for the ground, streets and trees, and a task of its own for each of its ${chunkPlan.chunks.length - cellCount} buildings, each whole; every chunk is built alongside the others and joined`
                        : `chunked district (${DISTRICT_CHUNKS_VERSION}): the ${Math.round(radius)} m asked for cut into ${chunkPlan.chunks.length} chunks of ${chunkPlan.cellM} m, each building whole in one of them; this build is the centre one (${Math.round(centre.radiusM)} m), the others are built alongside it and joined`);
                    run.layerTransform = chainLayerTransforms(run.layerTransform, territoryClipper(run, cache, chunkTerritory(chunkPlan, centre.index, DISTRICT_CHUNKS_PARAMS.seamBandM), (x, z) => owner(x, z) === centre.index));
                }
            } catch (err) {
                if (isAbort(err)) throw err;
                chunkPlan = undefined;
                run.note(PROVENANCE.asScanned, `the district could not be planned in chunks (${errorMessage(err)}): it is built as one, as far as one build reaches`);
            }
        }
        // staged into the active scene: an earlier build's structure rebuild stays (unless this run rebuilds it at the same
        // place), and the district layers lose their own scan of it where it stands
        if (intoActive) {
            run.carried = partitionActiveScene(intoActive, request.isolate ? placeValue : undefined);
            if (run.carried.structure.length) run.layerTransform = keptStructureCarver(run, cache, base);
        }
        // pipeline K-D with the cloud runner: the centre cell is one more chunk job (kdCentreRunner), so this build reads no
        // tiles of its own and its own stages are skipped; the vector paint stands for the whole district until the chunks join
        const centreInCloud = !!chunkPlan && kdCentreRunner() === 'cloud' && !!deps.runChunk;
        if (centreInCloud) {
            for (const id of STAGE_IDS) if (!CENTRE_IN_CLOUD_STAGES.has(id)) runner.skip(id, CENTRE_IN_CLOUD);
            tilesSettle(undefined);
        }
        /** The centre job's outcome (or, when it failed, the first chunk joined): the scan the finish reads with the centre in the cloud. */
        let cloudScan: StagedLocationOutcome | undefined;

        // ---------------- vector (the first paint: Google's vector buildings, extruded natively, beside the tile download) ----------------
        // it commits l0 as soon as it is built, unless the tiles were first; once the tiles commit, the buildings they do not cover
        // (a district past the leaf-tile cap) are kept as l0o, on bases measured against the tiles' own frame
        if (kIsolate) runner.skip('vector', PIPELINE_K_ISOLATE);
        const vectorPromise = kIsolate ? Promise.resolve(undefined) : runner.stage<{ buildings: number; outer: number }>({
            id: 'vector',
            run: async io => {
                if (!deps.vectorEvidence) return { status: 'skipped', source: '', reason: 'no Google vector data: no service account is configured for vectortiles.featuretiles' };
                const place = placeValue!;
                // an isolate's vector search reaches as far as its extraction may grow (the containment cap): the building
                // the place names can stand well past the first paint's radius (a house that geocodes to its gate)
                const radiusM = request.isolate ? Math.max(VECTOR_ISOLATE_RADIUS_M, CONTAINMENT_MAX_RADIUS_M) : (request.radiusM ?? 250);
                const msBy: Record<string, number> = {};
                const t0 = now();
                const key = stageKey(VECTOR_MASSING_VERSION, place.lat.toFixed(6), place.lng.toFixed(6), Math.round(radiusM));
                const key8 = key.slice(0, 8);
                run.keys.vector = key;
                type Inputs = { sel: PaintSelection; elevations?: number[]; elevationError?: string; tiles: number };
                // the vector data and the elevations are cached together (an answer without elevations is not cached)
                const hit = !bypass('vector') ? cache.get<Inputs>('vector', key) : undefined;
                let inputs = hit && now() - hit.builtAtMs < EXTRACTION_TTL_MS ? hit.value : undefined;
                run.cacheStatus.vector = inputs ? 'hit' : bypass('vector') ? 'bypassed' : 'miss';
                if (!inputs) {
                    io.progress(`reading Google's vector buildings within ${Math.round(radiusM)} m`);
                    let t = now();
                    const ev = await deps.vectorEvidence({ lat: place.lat, lng: place.lng, radiusM });
                    msBy.fetch = now() - t;
                    const sel = selectPaintBuildings(ev, radiusM);
                    let elevations: number[] | undefined, elevationError: string | undefined;
                    if (!deps.elevations) elevationError = 'no Google Maps API key is set for the Elevation API';
                    else if (sel.buildings.length) {
                        t = now();
                        try { elevations = await deps.elevations([{ lat: place.lat, lng: place.lng }, ...sel.buildings.map(b => frameToLatLng(place, b.centroid))], io.signal); } catch (err) { if (io.signal.aborted) throw err; elevationError = errorMessage(err); }
                        msBy.elevation = now() - t;
                    }
                    inputs = { sel, ...(elevations ? { elevations } : {}), ...(elevationError ? { elevationError } : {}), tiles: ev.tiles };
                    if (elevations) { const value = inputs; await cache.run('vector', key, async () => ({ value }), { bypass: true }); }
                }
                const { sel, elevations, elevationError } = inputs;
                if (kdDistrict) districtBuildings = sel.buildings;
                const left = [
                    sel.partsGivenDefaultHeight ? `${sel.partsGivenDefaultHeight} footprint part${sel.partsGivenDefaultHeight === 1 ? '' : 's'} with no height in the vector data shown at a plausible ${PLAUSIBLE_DEFAULT_HEIGHT_M} m (generated)` : '',
                    sel.buildingsGivenDefaultHeight ? `${sel.buildingsGivenDefaultHeight} building${sel.buildingsGivenDefaultHeight === 1 ? '' : 's'} with no measured height at all, shown at ${PLAUSIBLE_DEFAULT_HEIGHT_M} m (generated)` : '',
                    sel.buildingsWithNoFootprint ? `${sel.buildingsWithNoFootprint} building${sel.buildingsWithNoFootprint === 1 ? '' : 's'} with no footprint shape and no Google volume left out` :'',
                    sel.buildingsUnderOtherVolume ? `${sel.buildingsUnderOtherVolume} 2D-only footprint${sel.buildingsUnderOtherVolume === 1 ? '' : 's'} under another feature's modelled 3D volume left out (the volume draws that building at its own height)` : ''
                ].filter(Boolean).join('; ');
                if (!sel.buildings.length) return { status: 'skipped', source: '', reason: `Google's vector data has no building with a footprint or volume within ${Math.round(radiusM)} m${left ? ` (${left})` : ''}`, breakdownMs: msBy };
                const baseNote = (frame: 'street' | 'tiles') => elevations
                    ? `each building stands on the Google Elevation API's terrain height at its centroid, relative to ${frame === 'street' ? 'the terrain at the place (the street level the tiles also take as their origin, to about a metre)' : "the tiles' own frame height"}`
                    : `every building stands at the street level of the place (no terrain heights: ${elevationError ?? 'not asked'})`;
                const layerOf = (glb: { url: string; bytes: number }, layer: 'l0' | 'l0o', counts: { vertices: number; triangles: number }, note: string, builtAtMs: number, cached: boolean, revealAfter: string[]): StagedLayer => ({
                    objectId: layerObjectId(key, layer), stage: 'vector', layer, order: STAGES.vector.order, url: glb.url, bytes: glb.bytes,
                    provenance: paintProvenance(note, `vectortiles:${key8}`),
                    provenanceLabels: sel.buildingsGivenDefaultHeight ? [VECTOR_MODELLED_LABEL, GENERATED_HEIGHT_LABEL] : [VECTOR_MODELLED_LABEL],
                    supersedes: [], revealAfter,
                    reveal: { durationMs: 700, stagger: 0.6, crossfadeFrom: [] }, cached, builtAtMs, counts
                });
                const meta: StagedLayerObjectMeta = { source: 'GoogleVectorMassing', resolvedAddress: place.formattedAddress, extra: { vectorMassing: true } };
                const committed: StagedLayer[] = [];
                const degradations: DegradationRecord[] = [];
                const refusedNote = (refused: Array<{ buildings: string[]; error: string }>, layer: string) => {
                    if (!refused.length) return;
                    const n = refused.reduce((a, r) => a + r.buildings.length, 0);
                    degradations.push(run.degrade(record('vector', 'vector_buildings_refused', {
                        part: { description: `${n} vector building${n === 1 ? '' : 's'} of ${layer}` }, intended: 'every vector building with a height, extruded', fellTo: 'those buildings left out of the vector massing',
                        provenanceAfter: VECTOR_MODELLED_LABEL, reason: `the native massing tool refused them (${refused[0].error.slice(0, 200)})`, transient: false, runId, now: now(), suffix: layer
                    })));
                };
                // ---- l0: everything, unless the tiles were first ----
                let paintedFirst = false;
                if (!run.state.layers.some(l => l.layer === 'l1')) {
                    const t = now();
                    const ground0 = elevations?.[0];
                    const pkey = stageKey(key, 'first', elevations ? 'elev' : 'street');
                    const entry = await cache.run<{ counts: { vertices: number; triangles: number }; refused: Array<{ buildings: string[]; error: string }>; nativeMs: number }>('vector', pkey, async dir => {
                        const r = await writePaintGlb(sel.buildings, (_b, i) => (elevations && ground0 !== undefined ? elevations[i + 1] - ground0 : 0), { dir, stage: 'vector', stageKey: pkey, provenance: paintProvenance(baseNote('street'), `vectortiles:${key8}`), generatedHeightProvenance: paintGeneratedHeightProvenance(`vectortiles:${key8}`), signal: io.signal });
                        return { value: { counts: r.counts, refused: r.refused, nativeMs: r.nativeMs } };
                    }, { publish: () => [{ from: 'vector_massing.glb', as: `${base}_vector_${pkey.slice(0, 8)}.glb` }], bypass: bypass('vector') });
                    msBy.native = entry.cached ? 0 : entry.value.nativeMs;
                    msBy.first = now() - t;
                    // the tiles may have committed while it was built: then it is not shown where they are
                    if (!run.state.layers.some(l => l.layer === 'l1')) {
                        const note = `${sel.buildings.length} buildings within ${Math.round(radiusM)} m from Google's vector data${left ? `; ${left}` : ''}; ${baseNote('street')}; shown until the 3D Tiles arrive`;
                        const l0 = layerOf(entry.published[0], 'l0', entry.value.counts, note, entry.builtAtMs, entry.cached, []);
                        // the scene's place until the tiles give their own anchor (the viewport reads lat 0, lng 0 as no place)
                        if (!run.state.layers.length) run.geoAnchor = { lat: place.lat, lng: place.lng, ...(typeof place.elevation === 'number' ? { elevation: place.elevation } : {}) };
                        if (!run.camera) {
                            const bounds = glbBounds(path.join(entry.dir, 'vector_massing.glb'));
                            if (bounds) run.camera = vectorCamera(bounds, sel.buildings, request.isolate, radiusM, elevations && ground0 !== undefined ? elevations.slice(1).map(e => e - ground0) : undefined);
                        }
                        run.commit(l0, meta);
                        committed.push(l0);
                        refusedNote(entry.value.refused, 'l0');
                        paintedFirst = true;
                        msBy.firstPaint = now() - t0;
                        run.emit('vector', 'running', { message: `${sel.buildings.length} vector buildings shown (${((now() - t0) / 1000).toFixed(1)} s)`, layers: [l0] }, true);
                    }
                }
                // ---- l0o: past the tiles (districts only: an isolated structure is the one building asked for) ----
                const tiles = await tilesReady;
                let outerCount = 0;
                if (tiles && !request.isolate) {
                    const t = now();
                    const coverage = tilePlanCoverage(tiles.extraction.geometryGlb);
                    const outer = sel.buildings.map((b, i) => ({ b, i })).filter(({ b }) => coveredShare(b, coverage) <= VECTOR_OUTER_MAX_COVERED_SHARE);
                    msBy.coverage = now() - t;
                    outerCount = outer.length;
                    if (outer.length) {
                        const frameElev = typeof tiles.extraction.geoAnchor.elevation === 'number' ? tiles.extraction.geoAnchor.elevation : elevations?.[0];
                        const okey = stageKey(key, 'outer', tiles.key, elevations ? `elev:${frameElev}` : 'street', outer.map(o => o.b.id));
                        const t2 = now();
                        const entry = await cache.run<{ counts: { vertices: number; triangles: number }; refused: Array<{ buildings: string[]; error: string }>; nativeMs: number }>('vector', okey, async dir => {
                            const list: PaintBuilding[] = outer.map(o => o.b);
                            const r = await writePaintGlb(list, (_b, k) => (elevations && frameElev !== undefined ? elevations[outer[k].i + 1] - frameElev : 0), { dir, stage: 'vector', stageKey: okey, provenance: paintProvenance(baseNote('tiles'), `vectortiles:${key8}`), generatedHeightProvenance: paintGeneratedHeightProvenance(`vectortiles:${key8}`), signal: io.signal });
                            return { value: { counts: r.counts, refused: r.refused, nativeMs: r.nativeMs } };
                        }, { publish: () => [{ from: 'vector_massing.glb', as: `${base}_vector_outer_${okey.slice(0, 8)}.glb` }], bypass: bypass('vector') });
                        msBy.outer = now() - t2;
                        const reach = tiles.extraction.truncated ? `the tiles reach ${Math.round(tiles.extraction.coveredRadiusM)} of the ${Math.round(tiles.extraction.radiusM)} m asked for` : 'the tiles do not cover them';
                        const note = `${outer.length} vector buildings the 3D Tiles do not cover (${reach}; at most ${Math.round(VECTOR_OUTER_MAX_COVERED_SHARE * 100)}% of a building's plan under the tiles); ${baseNote('tiles')}; Google's modelled footprints and heights, not scanned`;
                        const l1 = run.state.layers.find(l => l.layer === 'l1');
                        const l0o = layerOf(entry.published[0], 'l0o', entry.value.counts, note, entry.builtAtMs, entry.cached, l1 ? [l1.objectId] : []);
                        run.commit(l0o, meta);
                        committed.push(l0o);
                        refusedNote(entry.value.refused, 'l0o');
                        run.note(VECTOR_MODELLED_LABEL, note);
                        run.emit('vector', 'running', { message: `${outer.length} vector buildings kept past the tiles`, layers: [l0o] }, true);
                    }
                }
                if (!paintedFirst && !outerCount) {
                    return { status: 'skipped', source: '', reason: tiles ? `the 3D Tiles arrived first (${((now() - t0) / 1000).toFixed(1)} s) and cover every vector building` : 'the tiles did not commit', breakdownMs: msBy };
                }
                if (!committed.some(l => l.layer === 'l0o')) run.note(VECTOR_MODELLED_LABEL, `${sel.buildings.length} buildings from Google's vector data (${baseNote('street')}), shown until the 3D Tiles arrived`);
                return {
                    status: degradations.length ? 'degraded' : 'committed', value: { buildings: sel.buildings.length, outer: outerCount }, layers: committed, degradations, breakdownMs: msBy,
                    cached: run.cacheStatus.vector === 'hit',
                    source: `${sel.buildings.length} buildings from Google vector data${paintedFirst ? `, shown in ${((msBy.firstPaint ?? 0) / 1000).toFixed(1)} s` : ' (the tiles were first)'}${outerCount ? `; ${outerCount} kept past the tiles` : ''}${left ? `; ${left}` : ''}`
                };
            },
            degrade: async err => ({
                status: 'degraded', source: 'no vector massing: the tiles are the first 3D', reason: `the vector massing could not be built (${errorMessage(err)})`,
                degradations: [run.degrade(record('vector', 'vector_massing_failed', {
                    part: { description: 'the first paint (Google vector buildings)' }, intended: 'a vector massing of the area while the tiles stream', fellTo: 'nothing until the 3D Tiles arrive',
                    provenanceAfter: PROVENANCE.asScanned, reason: `the vector massing could not be built (${errorMessage(err)})`, cause: err, transient: true, runId, now: now()
                }))]
            })
        });
        vectorPromise.catch(() => undefined);
        siblings.push(vectorPromise);

        // ---------------- chunks (pipeline K-D: the rest of a chunked district, pipeline-k/district-chunks.ts) ----------------
        // each chunk is a district build of its own on its own worker, several at once, nearest first; as each finishes its
        // layers are placed in this build's frame, cut to what it owns and committed here
        if (!chunkPlan) runner.skip('chunks', kdDistrict && !request.chunk ? 'the district is small enough for one build' : 'not a chunked district (pipeline K-D)');
        const plan = chunkPlan;
        const chunksPromise = !plan ? Promise.resolve(undefined) : runner.stage<{ chunks: number; joined: number; failed: number }>({
            id: 'chunks',
            run: async io => {
                const chunksStartMs = now();
                const tiles = centreInCloud ? undefined : await tilesReady;
                if (!tiles && !centreInCloud) return { status: 'skipped', source: '', reason: 'the centre build has no tiles to join the chunks to' };
                // the district's frame: the centre build's tiles; with the centre in the cloud, its job's frame once it is back
                // (every other chunk waits for it to be joined), else, when the centre could not be built, the place at the
                // first joined chunk's origin height
                let here: TileFrame | undefined = tiles ? { lat: placeValue!.lat, lng: placeValue!.lng, originEllipsoidalHeightM: tiles.extraction.originEllipsoidalHeightM } : undefined;
                const centreFrame = deferred<TileFrame | undefined>();
                if (!centreInCloud) centreFrame.resolve(here);
                const owner = chunkOwner(plan);
                // with the centre in the cloud it is one of them, the first (nearest)
                // a task per building: the centre first (the others cut in its frame), then the largest extractions first, so the
                // longest builds start first and, with the pool in several regions, the largest land in different regions;
                // otherwise nearest first
                const area = (c: DistrictChunk) => (c.rect.x1 - c.rect.x0) * (c.rect.z1 - c.rect.z0);
                // the largest building tasks marked for the fast VMs (SCRATCHBOX_KD_FAST_CHUNKS)
                const fast = fastChunkIndices(plan, kdFastChunks());
                const todo = plan.chunks.filter(c => !c.centre || centreInCloud).sort(plan.unit === 'building'
                    ? (a, b) => Number(b.centre) - Number(a.centre) || area(b) - area(a) || a.index - b.index
                    : (a, b) => Math.hypot(a.cx, a.cz) - Math.hypot(b.cx, b.cz));
                // several at once, as memory allows (a district build holds several GB), the centre build running beside them (here,
                // or with the centre in the cloud as the first of them)
                const parallel = chunkParallel();
                // every chunk's leaf tiles fetched while the first chunks build, nearest first (the chunks are built nearest first too):
                // a later chunk's extraction then reads its leaves from disk; best effort, a chunk fetches what is missing itself
                let prefetch: { leaves: number; downloaded: number; ms: number } | { error: string } | undefined;
                const prefetching = deps.prefetchTiles ? deps.prefetchTiles({ lat: placeValue!.lat, lng: placeValue!.lng, ...(placeValue!.elevation !== undefined ? { elevation: placeValue!.elevation } : {}), radiusM: plan.radiusM, signal: io.signal, onProgress: (d, n) => { if (d === n || d % 512 === 0) io.progress(`fetched ${d} of ${n} leaf tiles for the chunks`); } })
                    .then(r => { prefetch = r; }, err => { if (!io.signal.aborted) prefetch = { error: errorMessage(err) }; }) : Promise.resolve();
                const committed: StagedLayer[] = [];
                const degradations: DegradationRecord[] = [];
                const report: Array<{ index: number; radiusM: number; buildings: number; status: string; runId?: string; layers?: number; truncated?: boolean; ms: number; error?: string; join?: ChunkJoinRecord }> = [];
                // the chunks' layers checked and written (cut, placed and compacted when they came uncut) on a worker thread, not this one
                const joiner = createChunkJoiner();
                // the vector buildings shown past the centre build's tiles stand in only where no chunk has been joined yet: as each
                // chunk joins, the placeholders it owns are taken out (the layer republished without them, whole buildings by their middle)
                const joinedChunks = new Set<number>(), replacedPlaceholders = new Set<string>();
                const identity = Float64Array.from([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
                const retirePlaceholders = (index: number) => {
                    joinedChunks.add(index);
                    // with the centre in the cloud the first paint (l0) stands for the whole district: it is cut back the same way
                    for (const l of run.state.layers.filter(x => (x.layer === 'l0o' || (centreInCloud && x.layer === 'l0')) && !x.retired && !replacedPlaceholders.has(x.objectId))) {
                        const source = path.join(cache.modelsDir, path.basename(l.url));
                        if (!fs.existsSync(source)) continue;
                        const r = joinChunkGlb(fs.readFileSync(source), identity, (x, z) => !joinedChunks.has(owner(x, z)), { whole: true });
                        if (!r.removedTriangles) continue;
                        replacedPlaceholders.add(l.objectId);
                        if (!r.keptTriangles) { run.commit({ ...l, retired: true }, run.layerMeta[l.objectId]); continue; }
                        const root = l.objectId.replace(/-p\d+$/, ''), name = `${path.basename(l.url, '.glb').replace(/_p\d+$/, '')}_p${joinedChunks.size}.glb`;
                        const dir = path.join(cache.dir, 'district-chunks', runId);
                        fs.mkdirSync(dir, { recursive: true });
                        fs.writeFileSync(path.join(dir, name), r.glb);
                        const pub = cache.publishFile(path.join(dir, name), name);
                        const next: StagedLayer = {
                            ...l, objectId: `${root}-p${joinedChunks.size}`, url: pub.url, bytes: pub.bytes, counts: { vertices: l.counts.vertices, triangles: r.keptTriangles },
                            supersedes: [l.objectId], revealAfter: [], reveal: { durationMs: 300, stagger: 0, crossfadeFrom: [l.objectId] }
                        };
                        run.commit(next, run.layerMeta[l.objectId]);
                        committed.push(next);
                    }
                };
                let next = 0, joined = 0;
                // set below, once the seam stage's start is wired: a cell that has joined or failed for good
                let settleCell: (c: DistrictChunk) => void = () => undefined;
                const retry: Array<DistrictChunkPlan['chunks'][number]> = [];
                const one = async (c: DistrictChunkPlan['chunks'][number], atOnce: number, last = false) => {
                    const t0 = now();
                    const ll = frameToLatLng(placeValue!, [c.cx, c.cz]);
                    io.progress(`chunk ${c.index}: building ${c.buildings.length} buildings within ${Math.round(c.radiusM)} m`);
                    try {
                        const out = await deps.runChunk!({
                            query: request.query, isolate: false, radiusM: c.radiusM, trees: request.trees, stageIntoActiveScene: false, district: 'kd',
                            // the centre keeps the hero's address: its scene is the one the district is published on
                            place: { lat: ll.lat, lng: ll.lng, formattedAddress: c.centre ? placeValue!.formattedAddress : `${placeValue!.formattedAddress} (chunk ${c.index})` },
                            ...(request.enhance !== undefined ? { enhance: request.enhance } : {}),
                            // with a task per building a cell builds its ground with K's facade work off (its buildings are the tasks');
                            // in the shown band no chunk calls a model (district-chunks.ts chunkSteps)
                            ...((s => s ? { steps: s } : {})(chunkSteps(plan, c, request.steps, kdBand()))),
                            chunk: { of: runId, index: c.index, rect: { x0: c.rect.x0 - c.cx, z0: c.rect.z0 - c.cz, x1: c.rect.x1 - c.cx, z1: c.rect.z1 - c.cz } }
                        }, {
                            signal: io.signal, onProgress: m => io.progress(`chunk ${c.index}: ${m}`), atOnce, ...(fast.has(c.index) ? { fast: true } : {}),
                            // the district's frame when known already (the centre built here); else the centre job publishes it to the
                            // others (district-chunks.ts cutChunkLayer)
                            cut: { version: KD_CHUNK_CUT_VERSION, plan, district: here ? { ...here } : { lat: placeValue!.lat, lng: placeValue!.lng }, bandM: DISTRICT_CHUNKS_PARAMS.seamBandM }
                        });
                        if (!out.compat.frame) throw new Error('the chunk did not report its frame');
                        if (c.centre) {
                            here = out.compat.frame;
                            cloudScan = out;
                            run.geoAnchor = { ...out.compat.geoAnchor };
                            // the vector paint frames the scene; when it could not, the centre job's own camera (its frame is the district's)
                            const camera = (out.result.artifact as { data?: { camera?: StagedCamera } } | null)?.data?.camera;
                            if (!run.camera && camera) run.camera = camera;
                            centreFrame.resolve(here);
                        } else if (!here) {
                            here = (await centreFrame.promise) ?? { lat: placeValue!.lat, lng: placeValue!.lng, originEllipsoidalHeightM: out.compat.frame.originEllipsoidalHeightM };
                            cloudScan ??= out;
                        }
                        const tJoin = now();
                        const m = frameTransform(out.compat.frame, here);
                        const layers = ((out.result.artifact as { data?: { stagedBuild?: { layers?: StagedLayer[] } } } | undefined)?.data?.stagedBuild?.layers ?? []);
                        const hidden = new Set(layers.filter(l => !l.retired).flatMap(l => l.supersedes));
                        const take = layers.filter(l => !l.retired && !hidden.has(l.objectId) && l.stage !== 'vector');
                        const dir = path.join(cache.dir, 'district-chunks');
                        fs.mkdirSync(dir, { recursive: true });
                        const join: ChunkJoinRecord = { files: 0, cutByJob: 0, cutHere: 0, bytesIn: 0, bytesOut: 0, droppedBytes: 0, workerMs: 0, publishMs: 0, ms: 0 };
                        const joinFile = async (url: string, whole: boolean) => {
                            const source = path.join(cache.modelsDir, path.basename(url));
                            if (!fs.existsSync(source)) return undefined;
                            const name = `${path.basename(url, '.glb')}_kd${c.index}_${crypto.createHash('sha256').update(`${runId}:${url}`).digest('hex').slice(0, 8)}.glb`;
                            let t = now();
                            const r: ChunkLayerJoinResult = await joiner.join({ source, target: path.join(dir, name), transform: Array.from(m), whole, of: runId, chunk: c.index, plan, bandM: DISTRICT_CHUNKS_PARAMS.seamBandM });
                            join.workerMs += now() - t;
                            t = now();
                            const pub = cache.publishFile(path.join(dir, name), name);
                            join.publishMs += now() - t;
                            join.files++;
                            if (r.cutBy === 'job') join.cutByJob++; else join.cutHere++;
                            join.bytesIn += r.bytesIn; join.bytesOut += r.bytesOut; join.droppedBytes += r.droppedBytes;
                            return { ...pub, kept: r.keptTriangles };
                        };
                        const batch: StagedLayer[] = [];
                        for (const l of take) {
                            const whole = l.stage === 'trees';
                            const clay = await joinFile(l.url, whole);
                            if (!clay || !clay.kept) continue;
                            const tex = l.textured ? await joinFile(l.textured.url, whole) : undefined;
                            const layer: StagedLayer = {
                                ...l, objectId: `${l.objectId}-kd${c.index}`, url: clay.url, bytes: clay.bytes, counts: { vertices: l.counts.vertices, triangles: clay.kept },
                                supersedes: [], revealAfter: [], reveal: { ...l.reveal, crossfadeFrom: [] },
                                ...(l.textured && tex ? { textured: { ...l.textured, url: tex.url, bytes: tex.bytes } } : {}),
                                provenance: { ...l.provenance, note: `${l.provenance.note ? `${l.provenance.note}; ` : ''}chunk ${c.index} of the district, built on its own and joined here: what it owns (its buildings whole, its cell of the ground)` }
                            };
                            run.commit(layer, { source: l.stage === 'trees' ? 'SB-Veggie' : 'Google3DTilesClay', resolvedAddress: placeValue!.formattedAddress, ...(l.stage === 'trees' ? { vegetation: true } : {}), extra: { chunk: c.index } });
                            batch.push(layer);
                        }
                        committed.push(...batch);
                        joined++;
                        retirePlaceholders(c.index);
                        settleCell(c);
                        join.ms = now() - tJoin;
                        io.progress(`chunk ${c.index}: joined in ${(join.ms / 1000).toFixed(1)} s (${join.files} files, ${(join.bytesIn / 1e6).toFixed(0)} MB in, ${join.cutByJob} cut by its build${join.cutHere ? `, ${join.cutHere} cut here` : ''})`);
                        const truncated = out.result.stages.some(s => s.stage === 'tiles' && s.status === 'degraded');
                        report.push({ index: c.index, radiusM: c.radiusM, buildings: c.buildings.length, status: out.result.status, ...(out.runId ? { runId: out.runId } : {}), layers: batch.length, truncated, ms: now() - t0, join });
                        if (truncated) degradations.push(run.degrade(record('chunks', 'chunk_truncated', {
                            part: { description: `chunk ${c.index} of the district` }, intended: `its ${Math.round(c.radiusM)} m at leaf LOD`, fellTo: 'as far as its leaf tiles reach',
                            provenanceAfter: PROVENANCE.asScanned, reason: `chunk ${c.index}'s extraction reached the leaf-tile cap before its own radius`, transient: false, runId, now: now()
                        })));
                        run.emit('chunks', 'running', { message: `${joined} of ${todo.length} chunks joined`, layers: batch }, true);
                    } catch (err) {
                        // only this build being stopped ends the stage: a chunk's own hard failure (its tiles could not be fetched,
                        // a network error of the moment) is that chunk's, built once more after the others, then left to its vector buildings
                        if (io.signal.aborted || (err as Error)?.name === 'AbortError') throw err;
                        // the centre, which every other chunk waits for, is built again at once
                        if (!last && c.centre) { io.progress(`the centre chunk failed (${errorMessage(err)}); it is built again`); return one(c, atOnce, true); }
                        if (!last) { retry.push(c); io.progress(`chunk ${c.index} failed (${errorMessage(err)}); it is built again after the others`); return; }
                        if (c.centre) centreFrame.resolve(undefined);
                        settleCell(c);
                        report.push({ index: c.index, radiusM: c.radiusM, buildings: c.buildings.length, status: 'failed', ms: now() - t0, error: errorMessage(err) });
                        degradations.push(run.degrade(record('chunks', 'chunk_failed', {
                            part: { description: `chunk ${c.index} of the district` }, intended: `its ${c.buildings.length} buildings and ground at leaf LOD`, fellTo: "the vector buildings past the centre build's tiles",
                            provenanceAfter: PROVENANCE.asScanned, reason: `chunk ${c.index} could not be built (${errorMessage(err)})`, cause: err, transient: true, runId, now: now()
                        })));
                    }
                };
                const closeSeams = async (): Promise<Record<string, unknown> | undefined> => {
                    let seams: Record<string, unknown> | undefined;
                    if (joined) {
                        // the centre build's own ground, its texture and its streets are committed first
                        for (const id of ['remesh', 'textures', 'textures-late', 'roads'] as StageId[]) {
                            while (['pending', 'running'].includes(run.summary(id).status)) {
                                if (io.signal.aborted) throw io.signal.reason ?? abortError();
                                await new Promise(r => setTimeout(r, 5_000));
                            }
                        }
                        const t1 = now();
                        const centreIndex = plan.chunks.find(c => c.centre)!.index;
                        const chunkOf = (l: StagedLayer) => (run.layerMeta[l.objectId]?.extra as { chunk?: number } | undefined)?.chunk ?? centreIndex;
                        const shown = run.state.layers.filter(l => !l.retired);
                        const hiddenNow = new Set(shown.flatMap(l => l.supersedes));
                        // the order the chunks were built (the centre, then nearest first): a later chunk's cut edge moves onto an earlier one's
                        const dist = (l: StagedLayer) => { const c = plan.chunks[chunkOf(l)]; return c.centre ? -1 : Math.hypot(c.cx, c.cz); };
                        // a building's task (plan.unit 'building') is not seamed: its job cut it to its footprint, it meets no cell line
                        // and keeps a gain of 1 (district-seams.ts); only the cells' grounds and streets go through the seam stage
                        const seamed = (l: StagedLayer) => !!plan.chunks[chunkOf(l)] && isCellChunk(plan.chunks[chunkOf(l)]);
                        const grounds = shown.filter(l => l.layer === 'l2' && !hiddenNow.has(l.objectId) && seamed(l)).sort((a, b) => dist(a) - dist(b));
                        if (grounds.length >= 2) {
                            const dir = path.join(cache.dir, 'district-chunks', runId);
                            fs.mkdirSync(dir, { recursive: true });
                            const read = (url: string) => fs.readFileSync(path.join(cache.modelsDir, path.basename(url)));
                            // 1. colour: each textured ground sampled in the bands either side of the cell lines, one gain per chunk
                            const samples = new Map<number, SeamSamples>();
                            for (const g of grounds) {
                                if (!g.textured) continue;
                                if (io.signal.aborted) throw io.signal.reason ?? abortError();
                                io.progress(`reading the colour where chunk ${chunkOf(g)} meets its neighbours`);
                                samples.set(chunkOf(g), sampleSeamColour(read(g.textured.url), plan));
                                await new Promise(r => setImmediate(r));
                            }
                            const { gains, fields, report: colour } = solveSeamGains(samples, plan);
                            // who keeps each point, the same for every chunk: ground a chunk's build never reached goes to one whose did.
                            // A chunk's streets count as its surface: each chunk carved its own ground under its own streets
                            const streets = shown.filter(l => l.layer === 'l1r' && !hiddenNow.has(l.objectId) && seamed(l)).sort((a, b) => dist(a) - dist(b));
                            const coverage = new Map<number, SeamCoverage>();
                            for (const g of grounds) {
                                const c = chunkOf(g);
                                coverage.set(c, seamCoverage([read(g.url), ...streets.filter(s => chunkOf(s) === c).map(s => read(s.url))]));
                                await new Promise(r => setImmediate(r));
                            }
                            const seamOwnerOf = seamOwner(plan, coverage, grounds.map(chunkOf));
                            // 2-4. each chunk's ground cut at its cell lines, snapped onto the chunks before it, its gain applied
                            const edges: SeamEdges = new Map();
                            const cuts: Array<{ chunk: number; clay: SeamCutReport; gain?: [number, number, number]; gainMode?: string }> = [];
                            for (const g of grounds) {
                                if (io.signal.aborted) throw io.signal.reason ?? abortError();
                                const c = chunkOf(g);
                                io.progress(`closing chunk ${c}'s seams (${cuts.length + 1} of ${grounds.length})`);
                                const key8 = crypto.createHash('sha256').update(`${runId}:${DISTRICT_SEAMS_VERSION}:${g.url}`).digest('hex').slice(0, 8);
                                const clay = cutChunkLayer(read(g.url), plan, c, { snapTo: edges, owner: seamOwnerOf });
                                fs.writeFileSync(path.join(dir, `ground_${c}.glb`), clay.glb);
                                const pubClay = cache.publishFile(path.join(dir, `ground_${c}.glb`), `${base}_kd_ground_${c}_${key8}.glb`);
                                let pubTex: { url: string; bytes: number } | undefined, gainMode: string | undefined;
                                const gain = gains.get(c);
                                if (g.textured) {
                                    const tex = cutChunkLayer(read(g.textured.url), plan, c, { snapTo: edges, owner: seamOwnerOf });
                                    const levelled = applySeamGain(tex.glb, gain ?? [1, 1, 1], fields.get(c));
                                    gainMode = levelled.mode;
                                    fs.writeFileSync(path.join(dir, `ground_${c}_tex.glb`), levelled.glb);
                                    pubTex = cache.publishFile(path.join(dir, `ground_${c}_tex.glb`), `${base}_kd_ground_tex_${c}_${key8}.glb`);
                                }
                                addSeamEdges(edges, clay.edges);
                                const note = `chunk ${c}'s ground cut at its cell lines (${DISTRICT_SEAMS_VERSION}): ${clay.report.cut} triangles cut there, ${clay.report.snapped} cut corners moved at most ${Math.round(clay.report.maxSnapM * 100)} cm onto the edge its neighbour left${gain && gainMode !== 'none' ? `; its photos levelled to its neighbours' by a gain of ${gain.map(x => x.toFixed(3)).join(' / ')}${fields.get(c)?.lines.length ? ` and a correction fading in over its last ${DISTRICT_SEAMS_PARAMS.featherM} m to each neighbour` : ''} (generated)` : ''}`;
                                const layer: StagedLayer = {
                                    ...g, objectId: `${g.objectId}-seam`, url: pubClay.url, bytes: pubClay.bytes, counts: layerCounts(path.join(dir, `ground_${c}.glb`)),
                                    supersedes: [g.objectId], revealAfter: [], reveal: { durationMs: 600, stagger: 0, crossfadeFrom: [g.objectId] },
                                    ...(g.textured && pubTex ? { textured: { ...g.textured, url: pubTex.url, bytes: pubTex.bytes } } : {}),
                                    provenance: { ...g.provenance, note: `${g.provenance.note ? `${g.provenance.note}; ` : ''}${note}` }, cached: false, builtAtMs: now()
                                };
                                const meta = run.layerMeta[g.objectId];
                                run.commit(layer, { ...meta, extra: { ...(meta?.extra ?? {}), chunk: c } });
                                if (meta?.isGround) run.setGround(layer.objectId);
                                committed.push(layer);
                                run.emit('chunks', 'running', { message: `chunk ${c}'s seams closed`, layers: [layer] }, true);
                                cuts.push({ chunk: c, clay: clay.report, ...(gain ? { gain } : {}), ...(gainMode ? { gainMode } : {}) });
                                await new Promise(r => setImmediate(r));
                            }
                            // 5. SB-Roadie's streets (l1r): each joined with the seam band past its cell like the ground, so a street crossing
                            // a cell line was drawn twice there. A street is kept by whoever keeps the ground there (seamOwnerOf), cut exactly
                            // at the cell lines; both chunks measured it on the same tiles, so its cut edge stays where it was measured (no
                            // snap) and its colour as drawn (no gain)
                            const roads: Array<{ chunk: number; objectId: string; clay: SeamCutReport; textured?: SeamCutReport }> = [];
                            for (const listed of streets) {
                                if (io.signal.aborted) throw io.signal.reason ?? abortError();
                                // as it stands now: a street may have been committed again since it was listed (coloured again from a
                                // ground committed above), and the cut keeps that
                                const s = run.state.layers.find(l => l.objectId === listed.objectId) ?? listed;
                                const c = chunkOf(s), meta = run.layerMeta[s.objectId];
                                io.progress(`cutting chunk ${c}'s streets at its cell lines (${roads.length + 1} of ${streets.length})`);
                                const key8 = crypto.createHash('sha256').update(`${runId}:${DISTRICT_SEAMS_VERSION}:${s.url}`).digest('hex').slice(0, 8);
                                const subject = "as measured: the chunk's streets";
                                const clay = cutChunkLayer(read(s.url), plan, c, { owner: seamOwnerOf, subject });
                                const tex = s.textured ? cutChunkLayer(read(s.textured.url), plan, c, { owner: seamOwnerOf, subject }) : undefined;
                                roads.push({ chunk: c, objectId: s.objectId, clay: clay.report, ...(tex ? { textured: tex.report } : {}) });
                                // every triangle of it is its neighbours' to draw: the joined layer goes
                                if (clay.report.trianglesIn <= clay.report.dropped && !clay.report.skippedPrimitives) {
                                    run.commit({ ...s, retired: true }, meta);
                                    continue;
                                }
                                fs.writeFileSync(path.join(dir, `roads_${c}_${key8}.glb`), clay.glb);
                                const pubClay = cache.publishFile(path.join(dir, `roads_${c}_${key8}.glb`), `${base}_kd_roads_${c}_${key8}.glb`);
                                let pubTex: { url: string; bytes: number } | undefined;
                                if (tex) {
                                    fs.writeFileSync(path.join(dir, `roads_${c}_${key8}_tex.glb`), tex.glb);
                                    pubTex = cache.publishFile(path.join(dir, `roads_${c}_${key8}_tex.glb`), `${base}_kd_roads_tex_${c}_${key8}.glb`);
                                }
                                const note = `chunk ${c}'s streets cut at its cell lines by who keeps the ground there (${DISTRICT_SEAMS_VERSION}): ${clay.report.cut} triangles cut there and ${clay.report.dropped} left to its neighbours; the cut edge where it was measured, its colour as drawn`;
                                const layer: StagedLayer = {
                                    ...s, objectId: `${s.objectId}-seam`, url: pubClay.url, bytes: pubClay.bytes, counts: layerCounts(path.join(dir, `roads_${c}_${key8}.glb`)),
                                    supersedes: [s.objectId], revealAfter: [], reveal: { durationMs: 600, stagger: 0, crossfadeFrom: [s.objectId] },
                                    ...(s.textured && pubTex ? { textured: { ...s.textured, url: pubTex.url, bytes: pubTex.bytes } } : {}),
                                    provenance: { ...s.provenance, note: `${s.provenance.note ? `${s.provenance.note}; ` : ''}${note}` }, cached: false, builtAtMs: now()
                                };
                                run.commit(layer, { ...meta, extra: { ...(meta?.extra ?? {}), chunk: c } });
                                committed.push(layer);
                                run.emit('chunks', 'running', { message: `chunk ${c}'s streets cut at its cell lines`, layers: [layer] }, true);
                                await new Promise(r => setImmediate(r));
                            }
                            const before = colour.pairs.map(p => p.stepBeforePct).sort((a, b) => a - b), after = colour.pairs.map(p => p.stepAfterFieldPct ?? p.stepAfterPct).sort((a, b) => a - b);
                            const med = (v: number[]) => (v.length ? v[v.length >> 1] : 0);
                            run.note(PROVENANCE.remeshed, `the ${grounds.length} chunks' ground joined (${DISTRICT_SEAMS_VERSION}): each cut exactly at its cell lines and its cut edge moved onto its neighbour's (at most ${DISTRICT_SEAMS_PARAMS.snapM * 100} cm); the colour step where chunks meet, median ${med(before)}% before and ${med(after)}% after a gain per chunk and a correction fading in over each chunk's last ${DISTRICT_SEAMS_PARAMS.featherM} m (generated)${roads.length ? `; SB-Roadie's streets (${roads.length} layers) cut at the same lines by the same owner, ${roads.reduce((n, r) => n + r.clay.cut, 0)} triangles cut there` : ''}`);
                            seams = { version: DISTRICT_SEAMS_VERSION, grounds: grounds.length, colour, cuts, roads, ms: now() - t1 };
                        }
                    }
                    return seams;
                };
                // with a task per building the seam stage, which reads only the cells, starts once every cell has joined (or failed
                // for good), alongside the building tasks still building: the cells land minutes before the largest building
                const streamSeams = plan.unit === 'building';
                const cellsLeft = { n: todo.filter(isCellChunk).length };
                const cellsSettled = deferred<void>();
                if (!cellsLeft.n) cellsSettled.resolve();
                settleCell = (c: DistrictChunk) => { if (streamSeams && isCellChunk(c) && --cellsLeft.n === 0) cellsSettled.resolve(); };
                const seamsStreamed = streamSeams ? cellsSettled.promise.then(() => { io.progress('every cell joined: closing the seams while the buildings finish'); return closeSeams(); }) : Promise.resolve(undefined);
                seamsStreamed.catch(() => undefined);
                const width = Math.min(parallel, todo.length);
                try {
                    await Promise.all(Array.from({ length: width }, async () => { while (next < todo.length) await one(todo[next++], width); }));
                    if (retry.length) { let k = 0; const again = Math.min(parallel, retry.length); await Promise.all(Array.from({ length: again }, async () => { while (k < retry.length) await one(retry[k++], again, true); })); }
                } finally {
                    await joiner.close();
                }
                // ---- the seam stage over the joined ground (scene-healing §3.1; pipeline-k/district-seams.ts), one chunk at a time:
                // the chunks' photos levelled to one another by a gain per chunk, fitted where they meet; each chunk's ground cut
                // exactly at the cell lines around what it owns, and its cut edge moved onto the edge the chunks before it left
                // there; each committed in place of the chunk's joined ground; then SB-Roadie's streets cut the same way, by the
                // same owner. Never the district's ground in memory at once ----
                const seams = streamSeams ? await seamsStreamed : await closeSeams();
                await prefetching;
                // the district is shown: every chunk joined, the seams closed (the shown band's 3-minute mark is measured here)
                const shownAtMs = now() - chunksStartMs;
                io.progress(`district shown: ${joined} of ${todo.length} chunks joined, seams closed (${Math.round(shownAtMs / 1000)} s)`);
                cache.writeRunNote(runId, 'district_chunks_joined', { version: DISTRICT_CHUNKS_VERSION, parallel, chunks: report, shownAtMs, band: kdBand(), ...(seams ? { seams } : {}), ...(prefetch ? { prefetch } : {}) });
                // the vector buildings shown past the centre build's tiles stand in only where no chunk was joined
                if (joined === todo.length) for (const l of run.state.layers.filter(x => (x.layer === 'l0o' || (centreInCloud && x.layer === 'l0')) && !x.retired)) run.commit({ ...l, retired: true }, run.layerMeta[l.objectId]);
                // the place store (place-store-district.ts; SCRATCHBOX_PLACE_STORE=0 off): the joined district audited, its buildings listed for the object store
                const footprints: DistrictFootprint[] = [];
                // the shown band's objects are a preview (no model reading, material set or upscale): they never compete with a
                // full build's in the place store, so it is neither audited nor shown from it here
                const storeThisRun = placeStoreEnabled() && kdBand() !== 'shown';
                if (!storeThisRun && placeStoreEnabled()) cache.writeRunNote(runId, 'place_audit', { skipped: true, reason: 'the shown band (SCRATCHBOX_KD_BAND=shown): a preview, not kept in the place store' });
                if (storeThisRun && here) cache.writeRunNote(runId, 'place_audit', await auditDistrictForPlace({ runId, place: placeValue!, originEllipsoidalHeightM: here.originEllipsoidalHeightM, plan, layers: run.state.layers, manifests: run.objectManifests, footprintsOut: footprints, modelsDir: cache.modelsDir, workspaceRoot: cache.workspaceRoot, request, ...(deps.vectorEvidence ? { vectorEvidence: deps.vectorEvidence } : {}), signal: io.signal, progress: m => io.progress(m) }));
                // each building shown at its best (place-store-best.ts): one whose version here is worse than its stored one stands as that
                // the frame the run's objects are kept in: this build's extraction, else (the centre in the cloud) the centre job's
                const objectsFrame = tiles ? objectFrameOf(tiles.extraction) : cloudScan ? objectFrameOf(cloudScanOf(cloudScan)) : undefined;
                if (storeThisRun && footprints.length && objectsFrame) {
                    if (placePull) await Promise.race([placePull, new Promise(r => setTimeout(r, PLACE_STORE_PARAMS.pullWaitMs).unref())]);
                    const best = showBestVersions({
                        runId, frame: objectsFrame, layers: run.state.layers, manifests: run.objectManifests, footprints, store: defaultDurableAssetStore(),
                        look: kdLookCode(process.env, request.steps), modelsDir: cache.modelsDir, outDir: path.join(cache.dir, 'district-best'), publish: (file, name) => cache.publishFile(file, name)
                    });
                    for (const b of best.layers) {
                        // the layer as built is kept by the superseding one: the run's own versions are still stored (as history where worse)
                        run.objectManifests.set(b.layer.objectId, b.manifest);
                        run.commit(b.layer, run.layerMeta[b.original.objectId]);
                        committed.push(b.layer);
                        run.emit('chunks', 'running', { message: `${b.layer.layer}: ${b.layer.provenance.note?.split('; ').pop() ?? 'buildings shown from an earlier run'}`, layers: [b.layer] }, true);
                    }
                    cache.writeRunNote(runId, 'place_best', best.report);
                }
                const failed = todo.length - joined;
                return {
                    status: failed || degradations.length ? 'degraded' : 'committed', value: { chunks: plan.chunks.length, joined, failed }, layers: committed, degradations,
                    source: `${joined} of ${todo.length} chunks ${centreInCloud ? 'of the district, the centre among them, built in the cloud' : 'around the centre built'} and joined (${parallel} at a time), every building whole in one chunk`
                };
            },
            degrade: async err => ({
                status: 'degraded', source: '', reason: `the chunks could not be built (${errorMessage(err)})`,
                degradations: [run.degrade(record('chunks', 'chunks_failed', {
                    part: { description: 'the district past the centre chunk' }, intended: 'every chunk built and joined', fellTo: "the vector buildings past the centre build's tiles",
                    provenanceAfter: PROVENANCE.asScanned, reason: `the chunks could not be built (${errorMessage(err)})`, cause: err, transient: true, runId, now: now()
                }))]
            })
        });
        chunksPromise.catch(() => undefined);
        siblings.push(chunksPromise);

        // ---------------- the centre in the cloud: no tiles here; the district is its chunks joined, finished on the centre job's scan ----------------
        if (centreInCloud) {
            const settled = await Promise.allSettled(siblings);
            const failed = settled.find((r): r is PromiseRejectedResult => r.status === 'rejected');
            if (failed) throw failed.reason;
            const scanOut = cloudScan;
            if (!scanOut) throw new StagedLocationHardFailure('chunks', 'no_chunk_built', `No chunk of the district at ${placeValue.formattedAddress} could be built in the cloud, so there is nothing to show.`);
            const scan = cloudScanOf(scanOut);
            persist();
            cache.writeRunNote(runId, 'main_thread', blockTracer.stop());
            cache.writeRunNote(runId, 'model_calls', modelCalls.report());
            const outcome = finishRun(run, {
                request, place: placeValue, extraction: scan, sizedTo: 'request', remeshedElsewhere: true, now, persist,
                keep: { modelsDir: cache.modelsDir, note: (name, value) => cache.writeRunNote(runId, name, value) },
                ...(scanOut.compat.groundGlbPath ? { groundFile: scanOut.compat.groundGlbPath } : {}), ...(scanOut.compat.trees ? { trees: scanOut.compat.trees } : {}),
                rebuild: { droppedNotResolvable: 0, sourceLimits: scanOut.result.sourceLimits }
            });
            // no training pairs from here: the centre job's raw scan stays in the cloud (its caches go to the training bucket)
            // the place's versions are in the object store before this run's are offered to it (as the finish below does)
            if (placePull) await Promise.race([placePull, new Promise(r => setTimeout(r, PLACE_STORE_PARAMS.pullWaitMs).unref())]);
            keepSceneObjects(run, cache, outcome, scan, request.query, { isolate: false });
            return outcome;
        }

        // ---------------- tiles ----------------
        type TilesValue = { extraction: StagedExtraction; key: string; sizedTo: 'structure' | 'request' | 'district-fallback' | 'district-containment'; structure?: StructurePickResult; ground?: GroundModel; scan?: ScanMesh; unmaskedTop?: Float32Array; canopy?: CanopyMask; vector?: EvidenceLookup; vectorError?: string; rounds: number; cached: boolean; builtAtMs: number };
        /** One extraction, cached for 7 days by place and radius; the entry holds its files, named relative to it. */
        const extractCached = async (radiusM: number, io: StageIO, rect?: { x0: number; z0: number; x1: number; z1: number }): Promise<{ extraction: StagedExtraction; key: string; cached: boolean; builtAtMs: number }> => {
            const key = stageKey('extract/v3', placeValue!.lat.toFixed(6), placeValue!.lng.toFixed(6), Math.round(radiusM), rect ? [rect.x0, rect.z0, rect.x1, rect.z1].map(v => v.toFixed(1)).join(',') : '');
            const inEntry = (dir: string, v: StagedExtraction): StagedExtraction => ({ ...v, texturedGlb: path.join(dir, v.texturedGlb), geometryGlb: path.join(dir, v.geometryGlb) });
            const hit = !bypass('tiles') ? cache.get<StagedExtraction>('tiles', key) : undefined;
            if (hit && now() - hit.builtAtMs < EXTRACTION_TTL_MS) {
                const v = inEntry(hit.dir, hit.value);
                if (fs.existsSync(v.texturedGlb) && fs.existsSync(v.geometryGlb)) return { extraction: v, key, cached: true, builtAtMs: hit.builtAtMs };
            }
            const entry = await cache.run('tiles', key, async dir => {
                const x = await deps.extract({ lat: placeValue!.lat, lng: placeValue!.lng, radiusM, outDir: dir, place: placeValue!, signal: io.signal, onProgress: m => io.progress(m), ...(rect ? { rect } : {}) });
                return { value: { ...x, texturedGlb: path.relative(dir, x.texturedGlb), geometryGlb: path.relative(dir, x.geometryGlb) } };
            }, { bypass: true });
            return { extraction: inEntry(entry.dir, entry.value), key, cached: false, builtAtMs: entry.builtAtMs };
        };
        const tiles = await runner.stage<TilesValue>({
            id: 'tiles',
            run: async io => {
                let value: TilesValue;
                if (request.isolate) {
                    let last: { key: string; cached: boolean; builtAtMs: number } | undefined;
                    const sizing = await sizeExtraction<StagedExtraction>({
                        extract: async radiusM => { const x = await extractCached(radiusM, io); last = x; return x.extraction; },
                        ...(deps.vegetation.canopy ? { canopy: async (tile: string) => (await deps.vegetation.canopy!({ tilePath: tile, signal: io.signal })).mask } : {}),
                        ...(deps.vectorEvidence ? { vector: async (radiusM: number) => evidenceLookup(await deps.vectorEvidence!({ lat: placeValue!.lat, lng: placeValue!.lng, radiusM }), radiusM) } : {}),
                        // a procedural build: the pick seeded on the vector building nearest the place (a landmark's address point is often the road)
                        ...(request.procedural === true ? { seedFromVector: true } : {}),
                        placeName: request.query, onProgress: m => io.progress(m), signal: io.signal
                    });
                    if (sizing.structure?.seededOn) run.note(PROVENANCE.asScanned, `structure pick seeded on ${sizing.structure.seededOn}`);
                    value = { extraction: sizing.extraction, key: last!.key, sizedTo: sizing.sizedTo, structure: sizing.structure, ground: sizing.ground, scan: sizing.scan, unmaskedTop: sizing.unmaskedTop, ...(sizing.canopy ? { canopy: sizing.canopy } : {}), ...(sizing.vector ? { vector: sizing.vector } : {}), ...(sizing.vectorError ? { vectorError: sizing.vectorError } : {}), rounds: sizing.rounds, cached: last!.cached, builtAtMs: last!.builtAtMs };
                    for (const n of sizing.notes) {
                        const masked = n.reasonCode === 'canopy_not_masked';
                        const districtLost = n.reasonCode === 'district_extract_failed';
                        run.degrade(record('tiles', n.reasonCode, {
                            part: { description: masked ? 'the structure pick' : districtLost ? 'the district around the place' : 'the isolated structure' },
                            intended: masked ? 'a structure picked with the tree canopy masked out' : districtLost ? `the ${Math.round(NO_STRUCTURE_DISTRICT_RADIUS_M)} m district around the place` : 'one structure, extracted whole and rebuilt',
                            fellTo: masked ? 'the structure picked on the unmasked surface model'
                                : districtLost ? 'the smaller area already extracted, remeshed without a rebuild'
                                : n.reasonCode === 'no_structure_at_anchor' ? 'the remeshed area around the place, without a rebuild'
                                : 'the remeshed district around it, without a rebuild',
                            provenanceAfter: masked ? PROVENANCE.asScanned : PROVENANCE.remeshed, reason: n.reason, cause: n.error, transient: !!n.error && (districtLost || n.reasonCode === 'containment_failed'), runId, now: now()
                        }));
                    }
                } else {
                    // a chunked district's centre build reaches its own chunk; the others reach the rest
                    const baseRadiusM = chunkPlan ? chunkPlan.chunks.find(c => c.centre)!.radiusM : request.radiusM ?? 250;
                    let radiusM = baseRadiusM;
                    // a chunk of a chunked district extracts its rectangle: its cell already grown to every building it owns
                    const chunkRect = request.chunk?.rect ?? (chunkPlan ? chunkPlan.chunks.find(c => c.centre)!.rect : undefined);
                    if (deps.vectorEvidence && !chunkRect) {
                        try {
                            const vectorEvidence = deps.vectorEvidence;
                            radiusM = await districtContainedRadiusM(r => vectorEvidence({ lat: placeValue!.lat, lng: placeValue!.lng, radiusM: r }), baseRadiusM);
                        } catch (err) {
                            // atomic building integrity is best-effort for a district: a vector-fetch failure keeps the
                            // base radius rather than failing the whole build over it
                            if (io.signal.aborted) throw err;
                        }
                    }
                    const x = await extractCached(radiusM, io, chunkRect);
                    value = { extraction: x.extraction, key: x.key, sizedTo: radiusM > baseRadiusM ? 'district-containment' : 'request', rounds: 1, cached: x.cached, builtAtMs: x.builtAtMs };
                }
                // the tile seams closed as the extraction arrives (tile-seam-weld-service.ts: the tiles' caps removed, their rims
                // zipped at every cut, overlaps trimmed, positions welded, T-junctions split, then tile by tile the adaptive close
                // and the strip fill), cached beside it; every later stage
                // reads the welded scan, the raw extraction stays as it came
                if (deps.tileSeams && process.env.SCRATCHBOX_TILE_SEAMS?.trim() !== '0') {
                    // the passes on unless switched off (SCRATCHBOX_TILE_SEAM_TJUNCTIONS=0, SCRATCHBOX_TILE_SEAM_OVERLAP=0); the adaptive
                    // close and strip fill only when asked (SCRATCHBOX_TILE_SEAM_ADAPTIVE=1: on the ESB, Penn 2 and a Penn district they
                    // closed 30-142 points for up to 2 min, the seams left being capped cut planes); the cache name says which ran
                    const tj = process.env.SCRATCHBOX_TILE_SEAM_TJUNCTIONS?.trim() !== '0', ov = process.env.SCRATCHBOX_TILE_SEAM_OVERLAP?.trim() !== '0';
                    const ad = process.env.SCRATCHBOX_TILE_SEAM_ADAPTIVE?.trim() === '1';
                    // the tiles' photos levelled toward each other across their cuts only when asked (SCRATCHBOX_TILE_SEAM_TONE=1: it
                    // halves the colour step at the cuts, but pipeline K reads the photos, and on Penn 2 its untextured share rose)
                    const tn = process.env.SCRATCHBOX_TILE_SEAM_TONE?.trim() === '1';
                    // the caps two tiles carry in a shared cut plane are removed and the two tiles' rims at every cut zipped onto one
                    // line and welded (the service's defaults, where the extraction gives each leaf's box; user decision 2026-11-07:
                    // on the ESB and Penn 2 the slots across a rebuilt facade's bays go, the tear audit's holes drop)
                    const raw = value.extraction, tag = `${TILE_SEAMS_VERSION.replace(/\W/g, '_')}${tj ? '' : '_notj'}${ov ? '' : '_noov'}${ad ? '_ad' : ''}${tn ? '_tone' : ''}`, dir = path.dirname(raw.texturedGlb);
                    const tex = path.join(dir, `textured_${tag}.glb`), clay = path.join(dir, `geometry_${tag}.glb`), report = path.join(dir, `seams_${tag}.json`);
                    try {
                        if (!(fs.existsSync(tex) && fs.existsSync(clay) && fs.existsSync(report))) {
                            // written under temporary names and renamed: a build reading the same extraction never sees half a file
                            const sfx = `.tmp-${process.pid}-${Date.now()}`;
                            const r = await deps.tileSeams({ inputGlb: raw.texturedGlb, outputGlb: tex + sfx, outputClayGlb: clay + sfx, tJunctions: tj, overlapTrim: ov, adaptive: ad, tone: tn, defaultGeometricErrorM: raw.leafGeometricErrorM, timeoutMs: 600_000 });
                            fs.renameSync(tex + sfx, tex); fs.renameSync(clay + sfx, clay);
                            fs.writeFileSync(report, JSON.stringify({ version: TILE_SEAMS_VERSION, ...r }));
                        }
                        const r = JSON.parse(fs.readFileSync(report, 'utf8')) as TileSeamWeldResult;
                        const sw = r.seamWeld, tjs = r.tJunctions, ot = r.overlapTrim, ac = r.adaptive, sf = r.stripFill, au = r.seamAudit, tf = r.tone, ct = r.capTrim;
                        cache.writeRunNote(runId, 'tile_seams', {
                            version: TILE_SEAMS_VERSION, raw: raw.texturedGlb, inputTriangles: r.inputTriangles, outputTriangles: r.outputTriangles, toleranceM: r.toleranceM, seamWeld: sw,
                            ...(ot ? { overlapTrim: ot } : {}), ...(tjs ? { tJunctions: tjs } : {}), ...(ac ? { adaptive: ac } : { adaptive: false }), ...(sf ? { stripFill: sf } : {}),
                            ...(r.tiles ? { tiles: r.tiles } : {}), ...(au ? { seamAudit: au } : {}), ...(tf ? { tone: tf } : {}), ...(ct ? { capTrim: ct } : {}), ...(r.rimZip ? { rimZip: r.rimZip } : {}), ...(r.reweld ? { reweld: r.reweld } : {}), ...(r.photoOffset ? { photoOffset: r.photoOffset } : {}), ...(r.cutScores ? { cutScores: r.cutScores } : {}), ms: r.ms
                        });
                        // open seam length (km) under 3 cm / 3-10 / 10-30 / 30-100 cm / no other tile within 1 m
                        const km = (a: { bandLengthM: number[] }) => a.bandLengthM.map(v => (v / 1000).toFixed(1)).join(' / ');
                        run.note(PROVENANCE.asScanned, `tile seams closed (${TILE_SEAMS_VERSION}, within ${Math.round(r.toleranceM * 100)} cm` +
                            `${ac ? `, and up to ${Math.round(ac.maxToleranceM * 100)} cm where the two tiles' surfaces agree` : ''}, nothing moved further): ` +
                            `${ct && ct.trianglesDropped ? `${Math.round(ct.areaM2).toLocaleString('en-US')} m² of the tiles' caps (the strips two tiles carry back to back in a shared cut plane) removed, ` : ''}` +
                            `${ot ? `${Math.round(ot.areaM2)} m² of doubled surface trimmed, ` : ''}${sw.groupsWelded.toLocaleString('en-US')} border points welded to the next tile's, ` +
                            `${tjs ? `${tjs.closed.toLocaleString('en-US')} T-junctions split into the next tile's edge, ` : ''}${sw.trianglesDropped.toLocaleString('en-US')} collapsed slivers dropped` +
                            `${ac ? `; ${(ac.splitsClosed + ac.vertexMoves).toLocaleString('en-US')} wider gaps closed of ${ac.agreed.toLocaleString('en-US')} where the surfaces agree (${ac.candidates.toLocaleString('en-US')} looked at)` : ''}` +
                            `${sf && sf.triangles ? `; ${sf.areaM2.toFixed(1)} m² of strip bridged (generated)` : ''}` +
                            `${tf && tf.imagesChanged ? `; the tiles' photos levelled toward each other across ${tf.cuts.toLocaleString('en-US')} cuts (generated levels: the median colour step across them ${tf.dEBefore[0].toFixed(1)} -> ${tf.dEAfter[0].toFixed(1)} CIELAB)` : ''}` +
                            `${au ? `; open seam km by gap (<3 / 3-10 / 10-30 / 30-100 cm / none within 1 m) ${km(au.before)} before, ${km(au.after)} after` : ''}; the raw extraction is kept as it came`);
                        value.extraction = { ...raw, texturedGlb: tex, geometryGlb: clay };
                        // later stages key on the tiles key: the welded scan is another input; the sizing's scan was the raw one
                        value.key = stageKey(value.key, tag);
                        value.scan = undefined;
                    } catch (err) {
                        if (io.signal.aborted) throw err;
                        run.note(PROVENANCE.asScanned, `the tile seams could not be closed (${errorMessage(err)}); every stage reads the extraction as it came`);
                    }
                } else if (!deps.tileSeams) run.note(PROVENANCE.asScanned, 'the tile seams are left as the extraction came (no seam stage in these deps)');
                // L1: the extraction (welded at its seams when the seam stage ran), geometry only, with the run's fixed camera
                const e = value.extraction;
                run.keys.tiles = value.key;
                run.cacheStatus.tiles = value.cached ? 'hit' : 'miss';
                run.geoAnchor = e.geoAnchor;
                run.state.attribution = [...new Set(['Map data ©Google', ...e.copyrights.filter(c => c && c !== 'Google').map(c => `Map data ©${c}`)])];
                const key8 = value.key.slice(0, 8);
                const published = cache.publishFile(e.geometryGlb, `${base}_tiles_${key8}.glb`);
                let orderUrl: string | undefined;
                if (e.downloadOrder) {
                    const orderFile = path.join(path.dirname(e.geometryGlb), 'download_order.json');
                    if (!fs.existsSync(orderFile)) fs.writeFileSync(orderFile, JSON.stringify(e.downloadOrder));
                    orderUrl = cache.publishFile(orderFile, `${base}_tiles_${key8}.order.json`).url;
                }
                const bounds = glbBounds(e.geometryGlb) ?? { min: [-e.radiusM, -5, -e.radiusM] as [number, number, number], max: [e.radiusM, 30, e.radiusM] as [number, number, number] };
                const st = value.structure;
                const target: [number, number, number] = st ? [st.centroid.x, st.groundY + st.heightM / 2, st.centroid.z] : [0, 0, 0];
                const focus = st ? Math.hypot((st.bounds.maxX - st.bounds.minX) / 2, st.heightM / 2, (st.bounds.maxZ - st.bounds.minZ) / 2) : e.radiusM;
                run.camera = stagedCamera(bounds, target, focus);
                // the vector first paint, when it was shown, fades out under the tiles
                const painted = run.state.layers.filter(l => l.layer === 'l0').map(l => l.objectId);
                const layer: StagedLayer = {
                    objectId: layerObjectId(value.key, 'l1'), stage: 'tiles', layer: 'l1', order: STAGES.tiles.order, url: published.url, bytes: published.bytes,
                    provenance: { label: PROVENANCE.asScanned, measuredGeometry: true, method: 'Google Photorealistic 3D Tiles, leaf LOD, as downloaded', sources: [{ kind: 'tile-extraction', id: `extract:${key8}` }] },
                    provenanceLabels: [PROVENANCE.asScanned], supersedes: painted, revealAfter: [],
                    reveal: { durationMs: 1200, stagger: 1, crossfadeFrom: painted, ...(orderUrl ? { orderUrl } : {}) },
                    cached: value.cached, builtAtMs: value.builtAtMs, counts: layerCounts(e.geometryGlb)
                };
                run.commit(layer, { source: 'Google3DTilesClay', resolvedAddress: placeValue!.formattedAddress, isGround: true, extra: { rawGlbPath: e.rawGlbPath ?? e.texturedGlb } });
                if (st) {
                    run.state.structure = {
                        seed: [st.seed.x, st.seed.z], geocodeToStructureM: st.geocodeToStructureM, footprintAreaM2: st.areaM2, extractionRadiusM: e.radiusM, containmentRounds: value.rounds,
                        footprintSource: st.footprintSource, ...(st.vectorFootprint?.used ? { vectorFootprintIoU: st.vectorFootprint.iou } : {})
                    };
                    // what decided the footprint, said where the provenance is read
                    const vf = st.vectorFootprint;
                    const chosen = vf?.choice ? `; ${vf.choice.note}` : '';
                    if (vf?.used) run.note(PROVENANCE.remeshed, `footprint from Google vector data: building ${vf.featureIds.join(', ')} (${Math.round(vf.areaM2)} m²), ${Math.round(vf.raisedShare * 100)}% of it raised in the scan, ${Math.round(vf.openShare * 100)}% open ground, ${Math.round(vf.canopyShare * 100)}% tree canopy${vf.enclosesStructure ? ' (larger than the structure: it encloses it)' : ''}; the scan's raised cells within ${FOOTPRINT_TOLERANCE_M} m of it are the structure (IoU ${vf.iou} with the footprint)${chosen}`);
                    else run.note(PROVENANCE.remeshed, `footprint from the scan's geometry alone: ${vf?.reason ?? (value.vectorError ? `Google vector data could not be read (${value.vectorError})` : 'no Google vector data was available')}${chosen}`);
                }
                // a cap on leaf tiles can stop a large request short: the scan reaches less far than asked, and says so
                if (e.truncated && e.coveredRadiusM < e.radiusM - 0.5) {
                    const asked = Math.round(e.radiusM), covered = Math.round(e.coveredRadiusM);
                    run.degrade(record('tiles', 'radius_truncated', {
                        part: { description: `the outer ring of the extraction (${covered} to ${asked} m)` }, intended: `every leaf tile within ${asked} m of the place`,
                        fellTo: `the ${e.leafTiles} leaf tiles nearest in plan, which reach ${covered} m`, provenanceAfter: PROVENANCE.asScanned,
                        reason: `more leaf tiles lie within ${asked} m than the build keeps (the ${e.leafTiles} nearest in plan), so the scan reaches ${covered} m, not the ${asked} m asked for`,
                        transient: false, runId, now: now()
                    }));
                }
                const degradations = run.state.degradations.filter(d => d.stage === 'tiles');
                return {
                    status: degradations.length ? 'degraded' : 'committed', value,
                    source: `${e.leafTiles} leaf tiles within ${Math.round(e.coveredRadiusM)} m${value.sizedTo === 'structure' ? ` (sized to the structure: ${Math.round(e.radiusM)} m, ${value.rounds} round${value.rounds === 1 ? '' : 's'})` : value.sizedTo === 'district-containment' ? ` (grown from ${Math.round(request.radiusM ?? 250)} m to ${Math.round(e.radiusM)} m so a building the base radius reached is not cut by it)` : ''}`,
                    layers: [layer], degradations, cached: value.cached, builtAtMs: value.builtAtMs
                };
            },
            hardFail: err => new StagedLocationHardFailure('tiles', 'no_tile_coverage', `No Photorealistic 3D Tiles could be extracted at ${placeValue!.formattedAddress}: ${errorMessage(err)}`)
        });
        persist();
        tilesSettle(tiles.value ? { extraction: tiles.value.extraction, key: tiles.value.key } : undefined);
        if (tiles.value) ctx.onFrame?.({ lat: placeValue!.lat, lng: placeValue!.lng, originEllipsoidalHeightM: tiles.value.extraction.originEllipsoidalHeightM });
        if (tiles.status === 'stopped' || !tiles.value) throw new StagedLocationHardFailure('tiles', 'run_deadline', `The run reached its time limit before any tiles were extracted, so there is nothing to show.`);
        const t = tiles.value;

        // ---------------- vehicles (vehicle-removal.ts): every later stage builds on the scan without them ----------------
        /** The vehicle step's report once it has committed: its readings of fixtures keep the street residue off them. */
        let vehicleReport: VehicleRemovalReport | undefined;
        const devehicled = await (async (): Promise<typeof t.extraction | undefined> => {
            if (request.procedural === true) { runner.skip('vehicles', PROCEDURAL_ONLY); return undefined; }
            if (kIsolate) { runner.skip('vehicles', PIPELINE_K_ISOLATE); return undefined; }
            if (!vehicleRemovalEnabled() || !deps.vehicleRemoval) { runner.skip('vehicles', 'vehicle removal is off (SCRATCHBOX_STAGED_VEHICLES=0, or not in these deps)'); return undefined; }
            const vis = deps.vision && 'client' in deps.vision ? deps.vision : undefined;
            const notRemoved = (reason: string, cause?: unknown, transient = false) => run.degrade(record('vehicles', 'vehicles_not_removed', {
                part: { description: 'the vehicles the scan baked into the streets' }, intended: 'every vehicle read from the scan photo removed and the street under it patched',
                fellTo: 'the scan with its vehicles (melted lumps on the carriageways and kerbsides)', provenanceAfter: PROVENANCE.asScanned, reason,
                ...(cause !== undefined ? { cause } : {}), transient, runId, now: now(), reuses: ['resolve', 'tiles']
            }));
            if (!vis) {
                // as the survey does without a model: skipped, the reason said where the stages are read
                runner.skip('vehicles', `no vision model is configured (${deps.vision && 'unavailable' in deps.vision ? deps.vision.unavailable : 'none'}), so the scan keeps its vehicles: they cannot be told from the street furniture`);
                return undefined;
            }
            const r = await runner.stage<{ extraction: typeof t.extraction; report: VehicleRemovalReport }>({
                id: 'vehicles',
                run: async io => {
                    const e = t.extraction;
                    const covered = e.coveredRadiusM;
                    let look: EvidenceLookup | undefined = t.vector;
                    let vectorNote = t.vector ? 'vector' : 'none';
                    if (!look && deps.vectorEvidence) {
                        try { look = evidenceLookup(await deps.vectorEvidence({ lat: placeValue!.lat, lng: placeValue!.lng, radiusM: covered + 20 }), covered + 20); vectorNote = 'vector'; }
                        catch (err) { if (isAbort(err) || io.signal.aborted) throw err; vectorNote = `none (${errorMessage(err)})`; }
                    }
                    // the vehicles and the street clutter (temporary objects, carriageway debris; SCRATCHBOX_STAGED_CLUTTER=0 keeps them)
                    const vehicleParams = vehicleRemovalParams();
                    const key = stageKey(VEHICLE_REMOVAL_VERSION, t.key, vectorNote === 'none' ? 'none' : 'vector', covered.toFixed(1), vis.candidates, vehicleParams);
                    run.keys.vehicles = key;
                    type V = { textured: string; geometry: string; report: VehicleRemovalReport };
                    const entry = await cache.run<V>('vehicles', key, async dir => {
                        io.progress('reading the vehicles from above');
                        // SCRATCHBOX_VEHICLES_MODEL: a model tried first for these reads (a faster one; not the default until a checked set shows it reads as well)
                        const vehicleModel = process.env.SCRATCHBOX_VEHICLES_MODEL?.trim();
                        const chain = new VisionModelChain<string>({ client: vis.client, candidates: vehicleModel ? [vehicleModel, ...vis.candidates.filter(m => m !== vehicleModel)] : vis.candidates, signal: io.signal, ...chainExtras('vehicles'), ...(deps.sleep ? { sleep: deps.sleep } : {}) });
                        // the scan's load, its street model, the candidates, the crops, the surface infill and both patched GLBs run in a
                        // worker thread (vehicle-removal-run.ts): live they held the main thread for minutes; the vision calls stay here
                        const out = await removeVehiclesOffThread({
                            texturedGlb: e.texturedGlb, geometryGlb: e.geometryGlb, ...(t.scan ? { scan: t.scan } : { scanGlb: e.texturedGlb }), groundOptions: { cellMeters: 1 },
                            lookups: { ...(look ? { raster: { building: look.raster.building, water: look.raster.water, road: look.raster.road }, grid: look.grid } : {}), within: { radiusM: covered } },
                            outDir: dir, P: vehicleParams
                        }, { judge: visionVehicleJudge(chain), judgeMany: visionVehicleBatchJudge(chain), signal: io.signal, log: m => io.progress(m) });
                        if (out.report.failedCalls.length) throw new Error(`the vision model could not read ${out.report.failedCalls.length} of ${out.report.crops} crops (${out.report.failedCalls[0].error})`);
                        const rel = (p: string) => (path.dirname(p) === dir ? path.basename(p) : p);
                        return { value: { textured: rel(out.texturedGlb), geometry: rel(out.geometryGlb ?? e.geometryGlb), report: out.report } };
                    });
                    const abs = (p: string) => (path.isAbsolute(p) ? p : path.join(entry.dir, p));
                    const report = entry.value.report;
                    run.cacheStatus.vehicles = entry.cached ? 'hit' : 'miss';
                    cache.writeRunNote(runId, 'vehicles', { key, cached: entry.cached, dir: entry.dir, notes: report.notes, vehicles: report.vehicles, boxOnly: report.boxOnlyVehicles, unpatched: report.unpatchedVehicles, transientKept: report.transientKept, temporaryRemoved: report.temporaryRemoved ?? 0, debrisRemoved: report.debrisRemoved ?? 0, removed: report.removed, patch: report.patch, crops: report.crops, candidates: report.candidates, ms: report.ms, rawExtraction: e.texturedGlb });
                    if (!report.removed.length) return { status: 'committed', value: { extraction: e, report }, source: `no vehicle to remove (${report.candidates} candidates read in ${report.crops} crops)`, cached: entry.cached, builtAtMs: entry.builtAtMs };
                    const extraction = { ...e, texturedGlb: abs(entry.value.textured), geometryGlb: abs(entry.value.geometry), rawGlbPath: abs(entry.value.textured) };
                    // the tiles without the vehicles replace the raw tiles in the viewport
                    const raw = run.state.layers.find(l => l.layer === 'l1');
                    const key8 = key.slice(0, 8);
                    const published = cache.publishFile(extraction.geometryGlb, `${base}_tiles_${t.key.slice(0, 8)}_novehicles_${key8}.glb`);
                    const area = report.removed.reduce((s, x) => s + x.areaM2, 0);
                    const generatedShare = report.removed.reduce((s, x) => s + x.areaM2 * x.provenance.texture.generatedShare, 0) / Math.max(area, 1e-6);
                    const gateFailed = report.removed.filter(x => x.infill && !x.infill.gatePassed).length;
                    const note = `${report.removed.length} vehicle region${report.removed.length === 1 ? '' : 's'} (${report.vehicles} vehicles read by the vision model, ${Math.round(area)} m²) removed: the surface under each rebuilt from the measured scan around it by the surface infill (generated: nothing was measured under a vehicle; kerbs kept as steps), its texels continued from the street's own photo along its measured direction or repeat (photo-inferred) or synthesised from its grain (${Math.round(generatedShare * 100)} % generated)${gateFailed ? `; ${gateFailed} region${gateFailed === 1 ? '' : 's'} kept the fill that failed the seam gate least, labelled generated` : ''}`;
                    const layer: StagedLayer = {
                        objectId: layerObjectId(key, 'l1'), stage: 'vehicles', layer: 'l1', order: STAGES.tiles.order, url: published.url, bytes: published.bytes,
                        provenance: { label: PROVENANCE.asScanned, measuredGeometry: true, method: 'Google Photorealistic 3D Tiles, leaf LOD, with the vehicles the scan baked in removed (vehicle-removal.ts)', sources: [{ kind: 'tile-extraction', id: `extract:${t.key.slice(0, 8)}` }], note },
                        provenanceLabels: [PROVENANCE.asScanned, 'generated'], supersedes: raw ? [raw.objectId] : [], revealAfter: [],
                        reveal: { durationMs: 800, stagger: 0, crossfadeFrom: raw ? [raw.objectId] : [] },
                        cached: entry.cached, builtAtMs: entry.builtAtMs, counts: layerCounts(extraction.geometryGlb)
                    };
                    run.commit(layer, { source: 'Google3DTilesClay', resolvedAddress: placeValue!.formattedAddress, isGround: true, extra: { rawGlbPath: extraction.texturedGlb, vehiclesRemoved: report.removed.length } });
                    run.setGround(layer.objectId);
                    run.note('generated', note);
                    return { status: 'committed', value: { extraction, report }, source: report.notes[0] ?? note, layers: [layer], cached: entry.cached, builtAtMs: entry.builtAtMs };
                },
                degrade: async err => ({
                    status: 'degraded', source: 'the scan keeps its vehicles', reason: `the vehicles could not be removed: ${errorMessage(err)}`,
                    degradations: [notRemoved(`the vehicles could not be removed (${errorMessage(err)})`, err, true)]
                })
            });
            persist();
            if (r.status === 'committed') vehicleReport = r.value?.report;
            return r.status === 'committed' ? r.value?.extraction : undefined;
        })();
        const extraction = devehicled ?? t.extraction;
        /** The tiles layer standing now: the one without the vehicles once that has committed. */
        const currentL1 = () => [...run.state.layers].reverse().find(l => l.layer === 'l1');
        const structure = request.isolate && t.sizedTo === 'structure' ? t.structure : undefined;
        const isolateMode = !!structure;

        // ---------------- terrain (starts now and runs beside everything else; needs only the extraction's frame) ----------------
        if (request.procedural === true) {
            runner.skip('terrain', PROCEDURAL_ONLY);
        } else if (kIsolate) {
            runner.skip('terrain', PIPELINE_K_ISOLATE);
        } else if (!deps.elevation) {
            runner.skip('terrain', 'no Google Maps API key for the Elevation API, so the ground around the place is not measured');
        } else {
            const elevation = deps.elevation;
            siblings.push(runner.stage({
                id: 'terrain',
                run: async io => {
                    const origin: GeodeticOrigin = { lat: placeValue!.lat, lng: placeValue!.lng, heightMeters: extraction.originEllipsoidalHeightM };
                    // the hole is the ground the tiles actually occupy (their vertices, not a disc) plus a clear gap, so the
                    // two ground surfaces never share a patch and fight there
                    const heroGapM = terrainHeroGapM();
                    const key = stageKey('terrain/v2', origin.lat.toFixed(6), origin.lng.toFixed(6), origin.heightMeters.toFixed(2), TERRAIN_RADIUS_M, TERRAIN_INNER_RADIUS_M, TERRAIN_INNER_STEP_M, TERRAIN_OUTER_STEP_M, t.key.slice(0, 16), heroGapM);
                    run.keys.terrain = key;
                    const key8 = key.slice(0, 8);
                    const entry = await cache.run<{ minY: number; maxY: number; samples: number; holeTriangles: number; hole: Record<string, number | string> }>('terrain', key, async dir => {
                        const hole = coverageHoleFromGlb(extraction.geometryGlb, { gapM: heroGapM });
                        const plan = planTerrainGrid(origin);
                        io.progress(`measuring the ground at ${plan.points.length.toLocaleString('en-US')} points out to ${TERRAIN_RADIUS_M / 1000} km`);
                        const heights = await elevation.sample(plan.points, io.signal);
                        const mesh = buildTerrainMesh(origin, plan, heights, hole);
                        writeTerrainGlb(path.join(dir, 'terrain.glb'), mesh, { radiusM: TERRAIN_RADIUS_M, hole: hole.describe(), heroGapM, samples: plan.points.length, source: 'Google Elevation API (EGM96)' });
                        return { value: { minY: mesh.minY, maxY: mesh.maxY, samples: plan.points.length, holeTriangles: mesh.holeTriangles, hole: hole.describe() }, inputs: { origin, radiusM: TERRAIN_RADIUS_M, heroGapM, tiles: t.key } };
                    }, { publish: () => [{ from: 'terrain.glb', as: `${base}_terrain_${key8}.glb` }], bypass: bypass('terrain') });
                    run.cacheStatus.terrain = entry.cached ? 'hit' : 'miss';
                    const pub = entry.published[0];
                    const layer: StagedLayer = {
                        objectId: layerObjectId(key, 'l0'), stage: 'terrain', layer: 'l0', order: STAGES.terrain.order, url: pub.url, bytes: pub.bytes,
                        provenance: {
                            label: 'measured', measuredGeometry: true,
                            method: `Google Elevation API heightfield (EGM96 mean sea level into the tile frame), ${TERRAIN_INNER_STEP_M} m grid to ${TERRAIN_INNER_RADIUS_M / 1000} km and ${TERRAIN_OUTER_STEP_M} m to ${TERRAIN_RADIUS_M / 1000} km, left out under the tiles`,
                            sources: [{ kind: 'elevation', id: `terrain:${key8}` }],
                            note: `${entry.value.samples.toLocaleString('en-US')} measured heights, ${(entry.value.maxY - entry.value.minY).toFixed(1)} m of relief`
                        },
                        provenanceLabels: ['measured'], supersedes: [], revealAfter: [],
                        reveal: { durationMs: 1200, stagger: 0.4, crossfadeFrom: [] },
                        cached: entry.cached, builtAtMs: entry.builtAtMs, counts: layerCounts(pub.path)
                    };
                    run.commit(layer, { source: 'GoogleElevation', resolvedAddress: placeValue!.formattedAddress, extra: { terrainRadiusM: TERRAIN_RADIUS_M, heroGapM, hole: entry.value.hole, samples: entry.value.samples } });
                    return { status: 'committed', source: `Google Elevation API: ${entry.value.samples.toLocaleString('en-US')} heights out to ${TERRAIN_RADIUS_M / 1000} km`, layers: [layer], cached: entry.cached, builtAtMs: entry.builtAtMs };
                }
            }).catch(err => { if (err?.name === 'AbortError') throw err; run.emit('terrain', 'failed', { reason: errorMessage(err) }); return undefined; }));
        }


        // ---------------- survey (pass 1: starts now and runs beside the remesh and the fit; needs only the structure pick) ----------------
        const visionForSurvey = deps.vision && 'client' in deps.vision ? deps.vision : undefined;
        const visionAvailable = deps.vision && 'client' in deps.vision ? deps.vision : undefined;
        // the facade reader's calls (pipeline-k/facade-reader.ts): its fast, cheap model first (FACADE_READER_MODEL), the app's
        // other vision models behind it, each reply checked as its kind is parsed
        const facadeReaderAsk = (signal: AbortSignal, stage: StageId): FacadeAsk | undefined => {
            if (!visionAvailable) return undefined;
            const readChain = new VisionModelChain<string>({ client: visionAvailable.client, candidates: [...new Set([FACADE_READER_MODEL.model, ...visionAvailable.candidates])], signal, ...chainExtras(stage), ...(deps.sleep ? { sleep: deps.sleep } : {}) });
            const replyText = (res: { candidates?: Array<{ content?: { parts?: Array<{ text?: string; thought?: boolean }> } }> }) => (res.candidates?.[0]?.content?.parts ?? []).filter(q => !q.thought).map(q => q.text ?? '').join('');
            return async (png, prompt, kind) => {
                // a plane's zones read or judged together: one image a zone, in zone order
                const images = Array.isArray(png) ? png : [png];
                const res = await readChain.generate({ contents: [{ role: 'user', parts: [...images.map(p => ({ inlineData: { mimeType: 'image/png', data: p.toString('base64') } })), { text: prompt }] }], config: { responseMimeType: 'application/json', temperature: 0, abortSignal: signal } },
                    { stage: 'grammar', ...VISION_CALL_POLICY.grammar, thinkingBudget: FACADE_READER_MODEL.thinkingBudget, valid: x => facadeReplyUsable(kind, replyText(x), images.length) });
                const text = replyText(res.response);
                // only a reply the reader can parse is recorded: a malformed one replayed would fail the same plane in every later build
                if (facadeReplyUsable(kind, text, images.length)) res.remember();
                return text;
            };
        };
        const rebuildPossible = isolateMode && !!deps.scanFit;
        // the free pano discovery is done once for the survey and the close-ups; it ends only with the call
        const discoveryStop = new AbortController();
        ctx.signal?.addEventListener('abort', () => discoveryStop.abort(), { once: true });
        let panoDiscovery: ReturnType<typeof discoverPanos> | undefined;
        const discoverOnce = (): ReturnType<typeof discoverPanos> => {
            panoDiscovery ??= (async () => {
                const origin: GeodeticOrigin = { lat: placeValue!.lat, lng: placeValue!.lng, heightMeters: extraction.originEllipsoidalHeightM };
                return discoverPanos(origin, facadeGeometry(structure!), { ...(streetView ?? {}), metadataCachePath: path.join(cache.dir, 'streetview', 'metadata.json') }, discoveryStop.signal, structure!.centroid);
            })();
            return panoDiscovery;
        };
        const surveyStop = new AbortController();
        let surveyPromise: Promise<{ result?: SurveyResult; status: string }> | undefined;
        // pipeline E, the default for an isolated building (SCRATCHBOX_STAGED_PIPELINE=d or 0 turns it off; user decision
        // 2026-10-22 confirms it): the structure from the vector massing; it needs the building's vector footprint, else
        // the remesh pipeline runs and the reason is recorded
        /** Pipeline K (pipeline-k/): the remeshed scan with straightened facade photos, in place of E and the grammar. */
        const pipelineK = stagedPipelineK(request);
        const pipelineE = stagedPipelineE() && request.isolate && !pipelineK;
        /** The procedural pipeline of this request, 'j' (pipeline-i/), undefined when none is asked for (G and H retired 2026-10-30). */
        const procedural: 'j' | undefined = request.procedural === true && !pipelineK ? 'j' : undefined;
        /** Pipeline J's 3D model service: Meshy unless the request or SCRATCHBOX_STAGED_MODEL_SERVICE asks for Trellis. */
        const modelService = stagedModelService(request);
        /** The scan-led structure and massing rules pipeline J builds on: the scan's own plan when the vector massing fails its check. */
        const scanLed = procedural !== undefined;
        // no usable vector footprint at the place (eg. the Great Pyramid of Giza): pipeline E still runs, on the
        // structure's own convex outline on the scan instead of leaving it to the unstructured remeshed-scan fallback.
        // structure.vectorFootprint is only present when a vector-evidence lookup actually ran (extraction-sizing.ts);
        // it stays undefined, not {used:false}, when none was attempted at all (no credentials, vector-less test
        // fixtures) — the scan fallback only replaces a lookup that genuinely ran and found nothing, never a lookup
        // that was never tried, so it does not change behaviour anywhere vector evidence is simply not in the picture.
        const eBuildings = structure?.vectorFootprint?.used && t.vector
            ? t.vector.raster.buildings.filter(b => structure.vectorFootprint!.featureIds.includes(b.id))
            : (() => { const b = structure?.vectorFootprint && !structure.vectorFootprint.used ? scanDerivedFootprint(structure) : undefined; return b ? [b] : []; })();
        // the shape program trial (SCRATCHBOX_STAGED_SHAPE_PROGRAM) shapes from the tree-free scan: a vector footprint only
        // bounds the height map where the two agree, so a footprint that disagrees (or none) does not send the build back
        const shapeMode = pipelineE ? stagedShapeProgram() : undefined;
        const shapeFootprint = t.vector && structure?.vectorFootprint?.featureIds?.length ? t.vector.raster.buildings.filter(b => structure.vectorFootprint!.featureIds.includes(b.id)) : [];
        const eWhyNot = !pipelineE ? undefined : !isolateMode ? 'the structure could not be isolated'
            // without a Google footprint, a 3D Building (procedural) build takes the 3D tiles' plan of the structure as its footprint
            // (buildMassing); any other structure (an arch, a monument) keeps the scan fit, which follows its own shape
            : !eBuildings.length && !shapeMode && request.procedural !== true ? `the structure's footprint did not come from Google vector data (${structure?.vectorFootprint?.reason ?? 'no vector footprint at the place'})` : undefined;
        const eEligible = pipelineE && !eWhyNot;
        const startSurvey = (): void => {
        // pipeline K reads no Street View survey unless its evidence stage is on: the survey's images only fed the window
        // reveal depth (off since 2026-10-28) and a diagnostic score, and the remesh waited for it before texturing could
        // start (user ask, 2026-11-07: drop the Street View check, get to texturing sooner)
        if (pipelineK && isolateMode && !stepOn('evidence', process.env.SCRATCHBOX_K_EVIDENCE?.trim() === '1')) {
            runner.skip('survey', 'a 3D Building reads no Street View survey (SCRATCHBOX_K_EVIDENCE=1 turns it on)');
            return;
        }
        if (isolateMode && visionForSurvey) {
            const noSurvey = (reasonCode: string, reason: string, cause?: unknown, model?: VisionModelUse, transient = false) => ({
                status: 'degraded' as const, source: 'no survey: the detail passes aim at the scan-only slots', reason,
                ...(model ? { model } : {}),
                degradations: [run.degrade(record('survey', reasonCode, {
                    part: { description: 'the draft survey of the structure\'s faces' }, intended: 'an inventory of the faces, their materials and measured colours, from up to 4 wide Street View views',
                    fellTo: 'the detail passes aim at the scan-only slots', provenanceAfter: PROVENANCE.photoInferred, reason, ...(cause ? { cause } : {}), ...(model ? { model } : {}), transient, runId, now: now()
                }))]
            });
            surveyPromise = runner.stage<SurveyResult>({
                id: 'survey',
                run: async io => {
                    const sv = streetView ?? {};
                    const missing = missingCredentials(sv);
                    if (missing) return noSurvey('no_street_view', missing);
                    io.progress('finding Google Street View panoramas around the structure');
                    const found = await discoverOnce();
                    const faces = surveyFaceTargets(structure!);
                    // a tall structure's faces carry several height bands each (footprintSurveyFaces): raise the image
                    // budget to cover them, bounded by the build's shared real-image budget, rather than let the
                    // ordinary one-per-heading default silently starve every band past the first
                    const bandedCeiling = faces.length > MAX_SURVEY_FACES ? Math.min(MAX_STREET_VIEW_IMAGES_PER_BUILDING, faces.length) : undefined;
                    let result: SurveyResult;
                    const chain = new VisionModelChain<string>({ client: visionForSurvey.client, candidates: visionForSurvey.candidates, signal: ctx.signal, ...chainExtras('survey'), ...(deps.sleep ? { sleep: deps.sleep } : {}) });
                    try {
                        result = await runFaceSurvey({
                            faces, panos: found.panos, structure: structure!, ground: t.ground!, top: t.unmaskedTop ?? t.ground!.top, deps: sv, chain, signal: io.signal, onProgress: m => io.progress(m), now, ...(bandedCeiling ? { bandedCeiling } : {}),
                            // while the faces are read, the ring views the matching will want are fetched (for every face with an image: a superset)
                            onFetched: read => {
                                if (!visionAvailable || !rebuildPossible) return;
                                try {
                                    const ring = planRingViews(faces, surveyCandidates(found.panos.filter(p => !sv.refusedPanos?.has(p.panoId)), faces, structure!, t.ground!, t.unmaskedTop ?? t.ground!.top), { faces: faces.map(f => ({ faceId: f.faceId, headingDeg: f.headingDeg, source: f.source, elements: [], materials: [] })), read }, undefined, false);
                                    if (ring.length) void fetchViews(ring, sv, discoveryStop.signal, 30_000).catch(() => undefined);
                                } catch { /* the matching fetches its own views */ }
                            }
                        });
                    } catch (err) {
                        if (isAbort(err) || io.signal.aborted) throw err;
                        const model = err instanceof VisionStageError ? err.model : visionUse(chain, 'failed', { error: errorMessage(err) });
                        run.state.visionModel ??= model;
                        return noSurvey(err instanceof VisionStageError && err.reasonCode === 'no_street_view' ? 'no_street_view' : 'survey_failed',
                            `no survey (${errorMessage(err)}); the detail passes aim at the scan-only slots`, err, model, err instanceof VisionStageError ? err.transient : true);
                    }
                    run.state.materialHints = result.hints;
                    run.summary('survey').cost = result.cost;
                    if (result.refusals.length) cache.writeRunNote(runId, 'grounding_refusals', { stage: 'survey', refusals: result.refusals });
                    if (result.faces.some(f => f.panoId)) run.state.attribution = [...new Set([...run.state.attribution, 'Street View ©Google'])];
                    const degradations = result.faces.filter(f => f.skipped).map(f => run.degrade(record('survey', 'face_not_surveyed', {
                        part: { description: `the ${Math.round(f.headingDeg)}° face of the structure` }, intended: 'a wide Street View view of this face in the survey',
                        fellTo: 'this face is left out of the survey and reported', provenanceAfter: PROVENANCE.photoInferred, reason: `the ${Math.round(f.headingDeg)}° face was not surveyed: ${f.skipped}`,
                        transient: /did not arrive|reading failed/.test(f.skipped ?? ''), runId, now: now(), suffix: f.faceId
                    })));
                    return { status: degradations.length ? 'degraded' : 'committed', value: result, source: describeSurvey(result), model: result.model, degradations };
                },
                degrade: async err => noSurvey('survey_failed', `no survey (${errorMessage(err)}); the detail passes aim at the scan-only slots`, err, undefined, true)
            }, surveyStop.signal).then(r => ({ result: r.value, status: r.status }));
            surveyPromise.catch(() => undefined);
            siblings.push(surveyPromise);
        } else {
            runner.skip('survey', isolateMode ? (deps.vision && 'unavailable' in deps.vision ? deps.vision.unavailable : 'no vision model is configured') : 'not an isolated structure');
        }
        };
        if (!eEligible) startSurvey();

        // ---------------- evidence (starts when the fit is accepted, aimed at its slots; when no fit is accepted, aimed at the structure's
        // facades, and the images then only texture the remeshed scan: nothing is read from them) ----------------
        let evidencePromise = undefined as Promise<{ images: EvidenceImage[]; panos: PanoCandidate[]; cost: EvidenceCost; plan?: DetailPlan; registration?: Registration; match?: MatchResult; runCrops?: RunCrops; status: string }> | undefined;
        // ended (skipped, as not needed) when the run ends before the evidence does
        const evidenceStop = new AbortController();

        const startEvidence = (fit: StructureFit | undefined): void => {
            // a 3D Building (pipeline K) reads no Street View close-up and no registration: its textures come from tile_refine's
            // twin and the fit stage is skipped, so the stage is off for it (SCRATCHBOX_K_EVIDENCE=1, or the node graph's
            // 'evidence' switch, turns it back on)
            if (pipelineK && !stepOn('evidence', process.env.SCRATCHBOX_K_EVIDENCE?.trim() === '1')) {
                runner.skip('evidence', 'a 3D Building reads no Street View close-ups or their registration (SCRATCHBOX_K_EVIDENCE=1 turns them on)');
                evidenceDecided.resolve();
                return;
            }
            // the close-ups are planned from what the survey found: they wait for it (it began long before the fit ended)
            const surveyDone = surveyPromise ? surveyPromise.catch(() => undefined) : Promise.resolve(undefined);
            evidencePromise = surveyDone.then(surveyOut => runner.stage<{ images: EvidenceImage[]; panos: PanoCandidate[]; cost: EvidenceCost; plan?: DetailPlan; registration?: Registration; match?: MatchResult; runCrops?: RunCrops }>({
                id: 'evidence',
                run: async io => {
                    const sv = streetView ?? {};
                    const missing = missingCredentials(sv);
                    if (missing) {
                        return {
                            status: 'degraded', value: { images: [], panos: [], cost: NO_EVIDENCE_COST }, source: 'no Street View images', reason: missing,
                            degradations: [run.degrade(record('evidence', 'no_street_view', {
                                part: { description: 'Street View close-ups of the structure' }, intended: `up to 4 Street View images (© Google)`, fellTo: 'no Street View images',
                                provenanceAfter: PROVENANCE.photoInferred, reason: missing, transient: false, runId, now: now()
                            }))]
                        };
                    }
                    io.progress('finding Google Street View panoramas around the facades');
                    const found = await discoverOnce();
                    // from the survey: each element located on the fitted faces, one narrow crop per slot group; with no survey (or nothing located)
                    // the views are aimed at the scan-only slots
                    // a ring of further views of the surveyed faces from other panos: the surveyed elements are found again in them, and the
                    // poses of the panos are solved so that the rays through the same element agree on the fitted faces (pano-registration.ts)
                    let match: MatchResult | undefined;
                    let registration: Registration | undefined;
                    if (fit && surveyOut?.result && visionAvailable) {
                        try {
                            const surveyFaces = surveyFaceTargets(structure!);
                            const candidates = surveyCandidates(found.panos.filter(p => !sv.refusedPanos?.has(p.panoId)), surveyFaces, structure!, t.ground!, t.unmaskedTop ?? t.ground!.top);
                            const matchChain = new VisionModelChain<string>({ client: visionAvailable.client, candidates: visionAvailable.candidates, signal: ctx.signal, ...chainExtras('evidence'), ...(deps.sleep ? { sleep: deps.sleep } : {}) });
                            match = await runViewMatch({ faces: surveyFaces, survey: surveyOut.result, candidates, deps: sv, chain: matchChain, signal: io.signal, onProgress: m => io.progress(m) });
                            if (match.correspondences.length) {
                                registration = await registerPanosOffThread(match.correspondences, fitFaces(fit), { signal: io.signal });
                                io.progress(describeRegistration(registration, match.correspondences.length));
                                cache.writeRunNote(runId, 'registration', { correspondences: match.correspondences, registration: { ...registration, corrections: [...registration.corrections.entries()] } });
                            } else io.progress(`no element could be matched across views (${match.failures.length} failed call${match.failures.length === 1 ? '' : 's'}); the nominal pano poses stand, good to ±2 m`);
                        } catch (err) {
                            if (isAbort(err) || io.signal.aborted) throw err;
                            io.progress(`pose registration failed (${errorMessage(err)}); the nominal pano poses stand, good to ±2 m`);
                        }
                    }
                    let plan = fit && surveyOut?.result ? planDetailFromSurvey(surveyOut.result, fit, undefined, registration) : undefined;
                    const usable = found.panos.filter(p => !sv.refusedPanos?.has(p.panoId));
                    const views = plan?.views.length ? plan.views
                        : fit ? selectViewsForFit(usable, fit, structure!, t.ground!, t.unmaskedTop ?? t.ground!.top)
                        // no accepted fit: the structure's facades, cut into tiles a view can frame
                        : selectViewsForStructure(usable, footprintSurveyFaces(structure!), structure!, t.ground!, t.unmaskedTop ?? t.ground!.top);
                    if (!fit) io.progress(`no fit was accepted: ${views.length} Street View views aimed at the structure's facades, to texture the remeshed scan`);
                    if (plan) io.progress(describeLocated(surveyOut!.result!.faces, plan));
                    const discovery = { metadataCalls: found.metadataCalls, cachedCalls: found.cachedCalls };
                    if (!views.length) {
                        return {
                            status: 'degraded', value: { images: [], panos: found.panos, cost: { ...NO_EVIDENCE_COST, ...discovery }, ...(plan ? { plan } : {}) }, source: 'no Street View images', reason: `no Google Street View panorama looks at the ${fit ? 'fitted slots' : "structure's facades"}`,
                            degradations: [run.degrade(record('evidence', 'no_street_view', {
                                part: { description: 'Street View close-ups of the structure' }, intended: 'up to 4 Street View images (© Google)', fellTo: 'no Street View images',
                                provenanceAfter: PROVENANCE.photoInferred, reason: `no Google-captured Street View panorama within 12-60 m looks at the facades (${found.panos.length} found nearby)`, transient: false, runId, now: now()
                            }))]
                        };
                    }
                    io.progress(`fetching ${views.length} Street View images through the grounding API`);
                    const got = await fetchViews(views, sv, io.signal);
                    // ended while the images were coming (the fit failed, Stop, a time limit): they are dropped, and nothing here changes the run
                    if (io.signal.aborted) throw io.signal.reason;
                    const degradations = got.failures.map(f => run.degrade(record('evidence', 'image_not_fetched', {
                        part: { description: `Street View image of pano ${f.view.panoId} (heading ${f.view.headingDeg}°)` }, intended: 'one Street View close-up', fellTo: 'the other Street View images',
                        provenanceAfter: PROVENANCE.photoInferred, reason: `the image could not be fetched: ${f.error}`, cause: f.error, transient: f.transient, runId, now: now(), suffix: f.view.panoId
                    })));
                    if (got.images.length) run.state.attribution = [...new Set([...run.state.attribution, 'Street View ©Google'])];
                    if (got.images.length && !fit) run.note(PROVENANCE.photoInferred, `Street View (© Google) projected onto the remeshed scan: no fit was accepted, so ${got.images.length} views were aimed at the structure's facades (the no-fit rung); nothing was read from them`);
                    // geometric registration: every pano with an image in hand (survey, ring and close-ups) is posed against the full tile
                    // mesh by its silhouette and edges; the pose that agrees better with the other panos is kept per pano (pano-edge-registration.ts)
                    let edgeReg: EdgeRegistrationResult | undefined;
                    try {
                        const surveyFrames = (surveyOut?.result?.read ?? []).flatMap(r => {
                            const bytes = surveyImageBytes(surveyOut!.result!, r.imageIndex);
                            return bytes ? [{ id: `survey:${r.imageIndex}`, bytes, widthPx: r.widthPx, heightPx: r.heightPx, view: r.view }] : [];
                        });
                        // edges, then jointly, in a worker thread (pano-registration-run.ts): the main thread keeps serving the
                        // vision calls in flight (figures, reading) instead of being held ~100 s
                        const reg = await runPanoRegistrationOffThread({
                            images: [...surveyFrames, ...(match ? matchRingImages(match) : []), ...got.images], meshFiles: [extraction.geometryGlb],
                            ...(registration ? { prior: registration } : {}), correspondences: match?.correspondences ?? [], faces: fit ? fitFaces(fit) : []
                        }, { signal: io.signal, log: m => io.progress(m) });
                        if (reg.edge) {
                            edgeReg = reg.edge;
                            io.progress(describeEdgeRegistration(edgeReg));
                            cache.writeRunNote(runId, 'edge_registration', { panos: edgeReg.panos, ncc: edgeReg.ncc, boxRmsM: edgeReg.boxRmsM, ms: edgeReg.ms, skipped: edgeReg.skipped });
                        }
                        const joint = reg.joint;
                        if (joint) {
                            io.progress(describeJointRegistration(joint));
                            cache.writeRunNote(runId, 'joint_registration', {
                                chosen: joint.chosen, reason: joint.reason, matches: joint.matches, timingsMs: joint.timingsMs, panos: joint.panos, outlineTerm: joint.outlineTerm,
                                fit: Object.fromEntries(Object.entries(joint.fit).map(([k, v]) => [k, v && { chamferPx: v.chamferPx, clayChamferPx: v.clayChamferPx, gradNcc: v.gradNcc, outlinePx: v.outlinePx ?? null, views: v.views }])),
                                warps: joint.warps.map(w => ({ panoId: w.panoId, samples: w.samples, medianDeg: w.medianDeg }))
                            });
                        }
                        if (reg.registration) {
                            registration = reg.registration;
                            // the surveyed elements are placed again through the edge or joint poses, so the built detail and the texture agree
                            if (fit && plan && surveyOut?.result) plan = { ...plan, ...locateSurveyElements(surveyOut.result, fit, registration) };
                        }
                    } catch (err) {
                        if (isAbort(err) || io.signal.aborted) throw err;
                        io.progress(`geometric registration failed (${errorMessage(err)}); the box registration stands`);
                    }
                    // the narrow crops of the repeating runs and bands the reading will look at, fetched now, before the texture pass
                    // starts its long computations (the reading would otherwise fetch them while those hold the thread)
                    let runCrops: RunCrops | undefined;
                    if (fit && visionAvailable && plan?.located.length && t.ground) {
                        try {
                            runCrops = await fetchRunCrops({
                                fit, located: plan.located, panos: found.panos, groundAt: (x, z) => t.ground!.groundAt(x, z), fallbackGroundY: structure!.groundY,
                                ...(registration ? { registration } : {}), occluder: loadMesh([fit.outputs.fittedGlb, fit.outputs.passThroughGlb]), streetView: sv, signal: io.signal, onProgress: m => io.progress(m)
                            });
                        } catch (err) {
                            if (isAbort(err) || io.signal.aborted) throw err;
                            io.progress(`the narrow crops of the runs could not be fetched ahead (${errorMessage(err)}); the reading fetches them`);
                        }
                    }
                    const status = got.images.length ? (degradations.length ? 'degraded' : 'committed') : 'degraded';
                    const cost: EvidenceCost = { ...discovery, imagesRequested: views.length, imagesFetched: got.images.length, fetchMs: got.elapsedMs };
                    run.summary('evidence').cost = { images: got.images.length + (match?.images ?? 0), visionCalls: match?.visionCalls ?? 0, seconds: round(got.elapsedMs / 1000 + (match?.seconds ?? 0), 1) };
                    return {
                        status, value: { images: got.images, panos: found.panos, cost, ...(plan ? { plan } : {}), ...(registration ? { registration } : {}), ...(match ? { match } : {}), ...(runCrops ? { runCrops } : {}) }, source: `${got.images.length} of ${views.length} Street View images (© Google), kept in memory only${fit ? '' : ", aimed at the structure's facades (no fit was accepted): they texture the remeshed scan"}${match ? `; ${match.images} ring views, ${match.correspondences.length} matched element pairs${registration ? `, ${describeRegistration(registration, match.correspondences.length)}` : ', no pose registered'}${edgeReg ? `; ${describeEdgeRegistration(edgeReg)}` : ''}${match.failures.length ? `; ${match.failures.length} matching call${match.failures.length === 1 ? '' : 's'} failed (${match.failures[0].slice(0, 80)})` : ''}` : ''}`,
                        ...(got.images.length ? {} : { reason: 'every Street View image failed to fetch' }),
                        degradations
                    };
                },
                degrade: async err => ({
                    status: 'degraded', value: { images: [], panos: [], cost: NO_EVIDENCE_COST }, source: 'no Street View images', reason: `no Street View close-ups: ${errorMessage(err)}`,
                    degradations: [run.degrade(record('evidence', 'no_street_view', {
                        part: { description: 'Street View close-ups of the structure' }, intended: 'up to 4 Street View images (© Google)', fellTo: 'no Street View images',
                        provenanceAfter: PROVENANCE.photoInferred, reason: `no Street View close-ups (${errorMessage(err)})`, cause: err, transient: true, runId, now: now()
                    }))]
                })
            }, evidenceStop.signal).then(r => ({ images: r.value?.images ?? [], panos: r.value?.panos ?? [], cost: r.value?.cost ?? NO_EVIDENCE_COST, ...(r.value?.plan ? { plan: r.value.plan } : {}), ...(r.value?.registration ? { registration: r.value.registration } : {}), ...(r.value?.match ? { match: r.value.match } : {}), ...(r.value?.runCrops ? { runCrops: r.value.runCrops } : {}), status: r.status })));
            // a Stop rejects it; whoever awaits it sees that, and nobody else is left holding a rejection nobody handles
            evidencePromise.catch(() => undefined);
            siblings.push(evidencePromise);
            evidenceDecided.resolve();
        };

        // ---------------- figures (compact scanned blobs on a fitted pedestal: read from a close-up, built inside the blob's bounds) ----------------
        let figuresPromise: Promise<unknown> | undefined;
        const startFigures = (fit: StructureFit, out: { figures?: FigureRecord[]; passThroughHidden?: PassThroughSplit }): void => {
            const surveyDone = surveyPromise ? surveyPromise.catch(() => undefined) : Promise.resolve(undefined);
            // the figures are found and read without the survey (it only corroborates them), so they start with the fit
            figuresPromise = Promise.resolve().then(() => runner.stage<{ records: FigureRecord[] }>({
                id: 'figures',
                run: async io => {
                    const passFile = fit.outputs.passThroughGlb;
                    if (!passFile || !fs.existsSync(passFile)) return { status: 'skipped', source: '', reason: 'the fit kept no part of the scan as scanned' };
                    const nodes = readGlbNodes(passFile);
                    const detection = detectFigureBlobs(fit, nodes, undefined);
                    if (!detection.figures.length) return { status: 'skipped', source: '', reason: `no compact scanned blob stands on a fitted pedestal (${detection.rejected.length} kept region${detection.rejected.length === 1 ? '' : 's'} checked)` };
                    io.progress(`${detection.figures.length} scanned figure${detection.figures.length === 1 ? '' : 's'} found standing on fitted pedestals`);
                    const fitSha = sha256File(fit.outputs.reportJson);
                    const key = stageKey('figures/v1', fitSha, detection.figures.map(b => [b.regionId, b.min, b.max]));
                    const rungs = new Map<string, { reason: string; reasonCode: string; transient: boolean }>();
                    const built = new Map<string, { node: StagedGlbNode; record: FigureRecord }>();
                    let cost = { images: 0, visionCalls: 0, seconds: 0 };
                    const started = now();
                    const fail = (b: FigureBlob, reasonCode: string, reason: string, transient = false) => { rungs.set(b.regionId, { reasonCode, reason, transient }); };
                    const readyFigures: Array<{ im: FigureImage; reading: FigureReading; fitted: ReturnType<typeof constrainFigure> }> = [];

                    // the crops and the one reading
                    const sv = streetView ?? {};
                    const missing = missingCredentials(sv);
                    const chainSource = deps.vision && 'client' in deps.vision ? deps.vision : undefined;
                    let images: FigureImage[] = [];
                    let model: VisionModelUse | undefined;
                    if (missing || !chainSource) {
                        for (const b of detection.figures) fail(b, missing ? 'no_street_view' : 'vision_unavailable', missing ?? (deps.vision && 'unavailable' in deps.vision ? deps.vision.unavailable : 'no vision model is configured'));
                    } else {
                        const found = await discoverOnce();
                        const plan = planFigureViews(detection.figures, found.panos, structure!, t.ground!, t.unmaskedTop ?? t.ground!.top);
                        for (const sk of plan.skipped) fail(detection.figures.find(b => b.regionId === sk.regionId)!, 'no_view_of_figure', sk.reason);
                        if (plan.views.length) {
                            io.progress(`fetching ${plan.views.length} figure crop${plan.views.length === 1 ? '' : 's'} through the grounding API`);
                            const got = await fetchViews(plan.views, sv, io.signal);
                            if (io.signal.aborted) throw io.signal.reason;
                            images = got.images.map((im, index) => ({ index, blob: detection.figures.find(b => b.regionId === (im.view as FigureView).regionId)!, view: im.view as FigureView, bytes: im.bytes, mimeType: im.mimeType, widthPx: im.widthPx, heightPx: im.heightPx }));
                            for (const f of got.failures) fail(detection.figures.find(b => b.regionId === (f.view as FigureView).regionId)!, 'figure_image_failed', `its Street View crop did not arrive (${f.error})`, f.transient);
                            cost.images = got.images.length;
                        }
                        if (images.length) {
                            const chain = new VisionModelChain<string>({ client: chainSource.client, candidates: chainSource.candidates, signal: ctx.signal, ...chainExtras('figures'), ...(deps.sleep ? { sleep: deps.sleep } : {}) });
                            const builder = deps.figureBuilder ?? (async (spec: ObjectBuildSpec, signal?: AbortSignal) => ({ glb: (await buildObjectFromSpec(spec, { signal })).glb }));
                            // each figure is read and built on its own, FIGURE_CONCURRENCY at once; a spec the builder refuses is
                            // asked again with the builder's reason (figures.ts readFigure)
                            const buildOne = (im: FigureImage) => async (spec: ObjectBuildSpec) => {
                                const glb = await builder(spec, io.signal);
                                const nodesBuilt = parseGlbNodes(glb.glb);
                                const merged = { positions: Float32Array.from(nodesBuilt.flatMap(n => Array.from(n.positions))), indices: undefined as Uint32Array | undefined };
                                // one node per part: stitch indices with offsets
                                let offset = 0; const idx: number[] = [];
                                for (const n of nodesBuilt) { const ii = n.indices ?? Uint32Array.from({ length: n.positions.length / 3 }, (_, k) => k); for (const v of ii) idx.push(v + offset); offset += n.positions.length / 3; }
                                merged.indices = Uint32Array.from(idx);
                                return constrainFigure(merged, im.blob, im.view.eye);
                            };
                            const outcomes: Array<FigureOutcome<ReturnType<typeof constrainFigure>>> = new Array(images.length);
                            let nextFigure = 0;
                            await Promise.all(Array.from({ length: Math.min(FIGURE_CONCURRENCY, images.length) }, async () => {
                                while (nextFigure < images.length) {
                                    const k = nextFigure++;
                                    outcomes[k] = await readFigure({ image: images[k], chain, signal: io.signal, onProgress: m => io.progress(m), build: buildOne(images[k]) });
                                }
                            }));
                            if (io.signal.aborted) throw io.signal.reason;
                            model = outcomes.find(o => o.model)?.model;
                            if (!model) {
                                // no figure got any usable reply
                                const err = outcomes.find(o => o.error)?.error ?? new Error('no figure was read');
                                const used = err instanceof VisionStageError ? err.model : undefined;
                                if (used) { model = used; cost.visionCalls = 1; }
                                for (const im of images) fail(im.blob, 'figures_unreadable', `the vision model gave no usable reading (${errorMessage(err)})`, err instanceof VisionStageError ? err.transient : true);
                            } else {
                                cost.visionCalls = outcomes.reduce((n, o) => n + o.calls, 0);
                                images.forEach((im, k) => {
                                    const o = outcomes[k];
                                    if (o.built && o.reading) { readyFigures.push({ im, reading: o.reading, fitted: o.built }); return; }
                                    if (o.reading && o.buildError) { fail(im.blob, 'figure_not_built', `its spec could not be built inside the scan's bounds (${errorMessage(o.buildError)})`); return; }
                                    const why = o.problems ?? (o.error ? [`its reading failed (${(o.error as Error)?.message ?? String(o.error)})`] : undefined);
                                    fail(im.blob, 'figure_not_read', why ? `its spec could not be built (${why.join('; ')})` : 'the reading gave no figure for its crop');
                                });
                            }
                        }
                    }
                    // the survey only corroborates the figures (it may still be reading when they are built): its word goes on their notes
                    const surveyOut = await surveyDone;
                    if (surveyOut?.result) for (const f of detection.figures) f.corroboratedBy = corroborate(f, surveyOut.result);
                    let builtOrder = 0;
                    for (const { im, reading, fitted } of readyFigures) {
                        const node = figureNode({
                            id: `fig-${im.blob.regionId}`, positions: fitted.positions, indices: fitted.indices, order: builtOrder++, count: images.length, regionId: im.blob.regionId,
                            provenance: figureProvenance('photo-inferred', {
                                confidence: reading.confidence / 100, sourceId: `sv:${im.view.panoId}:${im.view.headingDeg}:${im.view.pitchDeg}:${im.view.fovDeg}`,
                                method: `ObjectBuildSpec read from one Street View crop by ${model!.used}, built natively and fitted to the scan blob's bounds (scale ${fitted.scale.join(' × ')}, yaw ${fitted.yawDeg}°)`,
                                note: `bounded by the scanned lump ${im.blob.acrossM} × ${im.blob.alongM} × ${im.blob.heightM} m on the pedestal ${im.blob.pedestal.surfaceId}${im.blob.corroboratedBy ? `; the survey saw "${im.blob.corroboratedBy.kind}" there` : ''}`
                            })
                        });
                        built.set(im.blob.regionId, { node, record: figureRecord(im.blob, 'photo-inferred', { panoId: im.view.panoId, confidence: reading.confidence / 100 }) });
                    }
                    cost.seconds = round((now() - started) / 1000, 1);
                    run.summary('figures').cost = cost;
                    if (cost.images) run.state.attribution = [...new Set([...run.state.attribution, 'Street View ©Google'])];

                    // the rung under: the scanned lump, smoothed inside the scan's own tolerance
                    const tolerance = Math.max(0.02, Math.min(fit.sourceLimits.meshResolvableM, PHOTO_CORRECTION_TOLERANCE_M));
                    const smoothed: Array<{ node: StagedGlbNode; record: FigureRecord }> = [];
                    const untouched: FigureBlob[] = [];
                    let order = built.size;
                    for (const b of detection.figures) {
                        if (built.has(b.regionId)) continue;
                        const why = rungs.get(b.regionId) ?? { reason: 'it was not read', reasonCode: 'figure_not_read', transient: false };
                        try {
                            const lump = smoothLump(nodes.find(n => n.name === b.regionId)!, tolerance);
                            smoothed.push({
                                node: figureNode({
                                    id: `fig-${b.regionId}`, positions: lump.positions, indices: lump.indices, order: order++, count: detection.figures.length, regionId: b.regionId,
                                    provenance: figureProvenance('smoothed-scan', { sourceId: `fit:${key.slice(0, 8)}:${b.regionId}`, method: `the scanned lump smoothed (Taubin ${TAUBIN.lambda}|${TAUBIN.mu}, ${TAUBIN.iterations} iterations), no vertex moved more than ${tolerance.toFixed(2)} m`, note: `${why.reason}; max move ${lump.maxMoveM} m` })
                                }),
                                record: figureRecord(b, 'smoothed-scan', { reason: why.reason })
                            });
                        } catch (err) {
                            untouched.push(b);
                            fail(b, 'figure_not_smoothed', `${why.reason}; and the lump could not be smoothed (${errorMessage(err)}), so it stays as scanned`);
                        }
                    }
                    const degradations = [...smoothed.map(x => x.record.id.replace('fig-', '')), ...untouched.map(b => b.regionId)].map(regionId => {
                        const b = detection.figures.find(x => x.regionId === regionId)!;
                        const r = rungs.get(regionId) ?? { reason: 'it was not read', reasonCode: 'figure_not_read', transient: false };
                        const kept = untouched.includes(b);
                        return run.degrade(record('figures', kept ? 'figure_not_smoothed' : 'figure_smoothed', {
                            part: { description: `the scanned figure ${regionId} on pedestal ${b.pedestal.surfaceId}` }, intended: 'a photo-inferred figure built inside the scan blob\'s bounds',
                            fellTo: kept ? 'the scanned lump as scanned' : 'the scanned lump, smoothed inside the scan tolerance', provenanceAfter: kept ? PROVENANCE.asScanned : SMOOTHED_SCAN_LABEL,
                            reason: `${r.reason}; ${kept ? 'it stays as scanned' : 'it is the scan smoothed, labelled smoothed scan'}`, ...(model ? { model } : {}), transient: r.transient, runId, now: now(), suffix: regionId
                        }));
                    });

                    // the layers: the pass-through scan without the figure regions (replacing the layer that held them, which stays viewable), and the figures
                    const replaced = new Set([...built.keys(), ...smoothed.map(x => x.record.id.replace('fig-', ''))]);
                    const l3c = run.state.layers.filter(l => l.layer === 'l3c').pop();
                    const layers: StagedLayer[] = [];
                    const dir = path.join(cache.dir, 'figures', key.slice(0, 8));
                    fs.mkdirSync(dir, { recursive: true });
                    const rootExtras = { sb: { schema: 'scratchbox.staged-glb/2', stage: 'figures', stageKey: key, buildingId: fit.buildingId, frame: 'tile frame: x east, y up, z south (metres)' } };
                    const figureNodes = [...built.values(), ...smoothed].sort((a, b) => a.node.name!.localeCompare(b.node.name!));
                    let restId: string | undefined;
                    if (replaced.size && l3c) {
                        // the drawn pass-through (without the parts a fitted face already shows) without the figure regions
                        const drawn = out.passThroughHidden ? (out.passThroughHidden.visibleFile ? readGlbNodes(out.passThroughHidden.visibleFile) : []) : nodes;
                        const rest = drawn.filter(n => !replaced.has(n.name));
                        const file = path.join(dir, 'passthrough_without_figures.glb');
                        writeStagedGlbFile(file, rest.map(n => ({ name: n.name, positions: n.positions, ...(n.indices ? { indices: n.indices } : {}), extras: n.extras })), { rootExtras, copyright: 'Google' });
                        const pub = cache.publishFile(file, `${base}_l3cf_${key.slice(0, 8)}.glb`);
                        restId = layerObjectId(key, 'l3cf');
                        layers.push({
                            objectId: restId, stage: 'figures', layer: 'l3cf', order: STAGES.fit.order, url: pub.url, bytes: pub.bytes, provenance: l3c.provenance, provenanceLabels: l3c.provenanceLabels,
                            supersedes: [l3c.objectId], revealAfter: [l3c.objectId], reveal: { durationMs: 400, stagger: 1, crossfadeFrom: [l3c.objectId] }, cached: false, builtAtMs: now(),
                            counts: { vertices: rest.reduce((n, x) => n + x.positions.length / 3, 0), triangles: rest.reduce((n, x) => n + (x.indices ? x.indices.length : x.positions.length / 3) / 3, 0) }
                        });
                    }
                    if (figureNodes.length) {
                        const file = path.join(dir, 'figures.glb');
                        writeStagedGlbFile(file, figureNodes.map(x => x.node), { rootExtras, copyright: 'Google' });
                        const pub = cache.publishFile(file, `${base}_l4f_${key.slice(0, 8)}.glb`);
                        const anyPhoto = built.size > 0;
                        const confidences = [...built.values()].map(x => x.record.confidence ?? 0);
                        layers.push({
                            objectId: layerObjectId(key, 'l4f'), stage: 'figures', layer: 'l4f', order: STAGES.figures.order, url: pub.url, bytes: pub.bytes,
                            provenance: anyPhoto
                                ? { label: PROVENANCE.photoInferred, measuredGeometry: false, confidence: Math.min(...confidences), method: 'figures read from Street View crops (ObjectBuildSpec), built natively inside the scan blob\'s bounds', sources: [{ kind: 'stage-output', id: `fit:${fitSha.slice(0, 8)}` }] }
                                : { label: SMOOTHED_SCAN_LABEL, measuredGeometry: true, method: 'the scanned lumps, smoothed inside the scan tolerance', sources: [{ kind: 'stage-output', id: `fit:${fitSha.slice(0, 8)}` }] },
                            provenanceLabels: [...(anyPhoto ? [PROVENANCE.photoInferred] : []), ...(smoothed.length ? [SMOOTHED_SCAN_LABEL] : [])],
                            supersedes: [], revealAfter: restId ? [restId] : l3c ? [l3c.objectId] : [], reveal: { durationMs: 1200, stagger: 0.7, crossfadeFrom: [] }, cached: false, builtAtMs: now(),
                            counts: { vertices: figureNodes.reduce((n, x) => n + x.node.positions.length / 3, 0), triangles: figureNodes.reduce((n, x) => n + (x.node.indices ? x.node.indices.length : x.node.positions.length / 3) / 3, 0) }
                        });
                    }
                    for (const l of layers) run.commit(l, { source: 'scan_fit', resolvedAddress: placeValue!.formattedAddress });
                    const records = [...built.values(), ...smoothed].map(x => x.record).concat(untouched.map(b => figureRecord(b, 'as-scanned', { reason: rungs.get(b.regionId)?.reason })));
                    out.figures = records;
                    return {
                        status: degradations.length ? 'degraded' : 'committed', value: { records }, layers,
                        source: `${built.size} figure${built.size === 1 ? '' : 's'} photo-inferred${smoothed.length ? `, ${smoothed.length} smoothed scan` : ''}${untouched.length ? `, ${untouched.length} as scanned` : ''} (${cost.images} image${cost.images === 1 ? '' : 's'}, ${cost.visionCalls} vision call, ${cost.seconds.toFixed(1)} s)`,
                        ...(model ? { model } : {}), degradations
                    };
                },
                degrade: async err => ({
                    status: 'degraded', source: 'the scanned figures stay as scanned', reason: `the figures stage failed (${errorMessage(err)}); the scanned lumps stay as they are`,
                    degradations: [run.degrade(record('figures', 'figures_failed', {
                        part: { description: 'the scanned figures' }, intended: 'photo-inferred figures built inside the scan blobs', fellTo: 'the scanned lumps as scanned', provenanceAfter: PROVENANCE.asScanned,
                        reason: `the figures stage failed (${errorMessage(err)}); the scanned lumps stay as scanned`, cause: err, transient: true, runId, now: now()
                    }))]
                })
            }, evidenceStop.signal));
            (figuresPromise as Promise<unknown>).catch(() => undefined);
            siblings.push(figuresPromise as Promise<unknown>);
        };

        // ---------------- textures (background: the clay layers never wait for it) ----------------
        // Two stages, both started as soon as the remesh commits:
        //  - 'textures': an isolated structure's layers get a twin baked from the tile photo first (seconds); once the Street View
        //    close-ups are in (the survey, the fit's evidence) each layer is baked again with them, and that twin replaces the
        //    first only where Street View adds texels. A district, or a structure that could not be isolated, gets tile_refine's
        //    own photo-textured remesh as its twin (tile-refine-twin.ts): unwrapping a million triangles would take minutes.
        //  - 'textures-late': every layer committed after that (the fit's, the detail, the grammar's l2g, figures) is textured as
        //    it lands; once the rebuild and the grammar have settled, the twins are checked against the settled scene. The first
        //    stage never waits for them.
        let texturesPromise: Promise<unknown> | undefined;
        let lateTexturesPromise: Promise<unknown> | undefined;
        let textureValue: TextureStageValue | undefined;
        /** The facade grammar stage (it commits l2g, a layer the texture pass must texture however late it lands). */
        const grammarGate: { settled?: Promise<unknown> } = {};
        /** The district massing stage (it commits l2c and l2m, which the texture pass must take however late they land). */
        const massingGate: { settled?: Promise<unknown> } = {};
        /** Resolved once the rebuild has decided its Street View close-ups (evidencePromise is set, or none will come). */
        let evidenceDecided = deferred<void>();
        /** Resolved once the fit stage has returned (its charts are known), or the rebuild ended without one. */
        let fitDecided = deferred<void>();
        /** tile_refine's photo-textured output per committed remesh layer (the source of a district's twins). */
        const refineTextured = new Map<string, string>();
        type TexTarget = { layer: StagedLayer; file: string; surfaces?: Array<{ id: string; chart: any }>; late?: boolean };
        /** A procedural district's rebuilt layer: textured by the texture pass even in a district, its library spec as the generated fill. */
        const proceduralFillOf = (l: StagedLayer): string | undefined => { const f = run.layerMeta[l.objectId]?.extra?.proceduralFill; return typeof f === 'string' ? f : undefined; };
        const fillSpecs = new Map<string, { spec: LibraryFillSpec; sha: string; library: SurfaceLibrary }>();
        const fillSpecFor = (file: string): { spec: LibraryFillSpec; sha: string; library: SurfaceLibrary } => {
            let got = fillSpecs.get(file);
            if (!got) {
                const text = fs.readFileSync(file, 'utf8'), library = loadSurfaceLibrary();
                // the library's own version is part of the key: a regenerated entry is a new fill
                got = { spec: loadFillSpec(JSON.parse(text) as StoredFillSpec, library), sha: sha256Bytes(Buffer.from(text + library.source)), library };
                fillSpecs.set(file, got);
            }
            return got;
        };
        type TexOutcome = {
            layer: StagedLayer; out: Omit<TextureLayerOutcome, 'glb' | 'measureLoo'>; url: string; bytes: number; cached: boolean; builtAtMs: number;
            surfaces: string; late: boolean; sources: 'tile' | 'street-view' | 'tile-refine'; streetViewTried?: boolean
        };
        const startTextures = (): void => {
            if (texturesPromise) return;
            if (deps.textures?.disabled) { runner.skip('textures', deps.textures.disabled); runner.skip('textures-late', deps.textures.disabled); return; }
            // a district (or a structure tile_refine could not isolate) is textured with tile_refine's own photo, and so is
            // pipeline K's structure: its facades carry their straightened photos, which a re-bake from the tile would undo
            const mode: 'texture-pass' | 'tile-refine' = isolateOk && !pipelineK ? 'texture-pass' : 'tile-refine';
            const texStarted = now();
            const pass = { rebuild: rebuildPromise, grammar: grammarGate.settled, massing: massingGate.settled };
            const outcomes: TexOutcome[] = [];
            const handled = new Set<string>();
            const looJobs = new Map<string, NonNullable<TextureLayerOutcome['measureLoo']>>();
            const extraDegradations: TexturePassDegradation[] = [];
            const arm = textureArmOptions();
            const armTargets = arm.targetLayers;
            const fitSurfaces = () => (rebuildOut.refit ?? rebuildOut.fit)?.value.surfaces.filter(x => x.chart).map(x => ({ id: x.id, chart: x.chart })) ?? [];
            const loopDelay = monitorEventLoopDelay({ resolution: 10 });
            loopDelay.enable();
            // the threads started loading when the tiles committed (earlyTexturePool); a second pass starts its own
            const texturePool = mode === 'texture-pass' && textureWorkersEnabled() ? (takeEarlyPool() ?? new TextureWorkerPool()) : undefined;
            const warming = texturePool?.warm();
            warming?.catch(() => undefined);
            const enhance = deps.textures?.enhance;
            const lightingClient = deps.textures?.lighting;
            const lightingModelIds = deps.textures?.lightingModels ?? lightingModels();
            const timed = (into: Record<string, number>) => async <R>(k: string, work: () => Promise<R>): Promise<R> => { const t0 = now(); logStep(`textures.${k}`, 'running'); let ok = false; try { const v = await work(); ok = true; return v; } finally { into[k] = (into[k] ?? 0) + now() - t0; logStep(`textures.${k}`, ok ? 'done' : 'failed'); } };
            const mainMs: Record<string, number> = {}, lateMs: Record<string, number> = {};
            // what gets a twin: every committed mesh layer the scene shows, or stands on (the ground), except vegetation and the
            // vector massing; a superseded layer is skipped unless it is the ground; the voted remesh is the next pass's own target
            const pick = (opts: { late?: boolean } = {}): TexTarget[] => {
                const live = run.state.layers.filter(l => !l.retired);
                const superseded = new Set(live.flatMap(l => l.supersedes));
                return live.filter(l => {
                    const meta = run.layerMeta[l.objectId];
                    if (handled.has(l.objectId) || l.textured || meta?.vegetation || meta?.extra?.vectorMassing || meta?.extra?.selfTextured || !(l.counts.triangles > 0)) return false;
                    if (opts.late && l.layer === 'l2v') return false;
                    if (mode === 'tile-refine' && !refineTextured.has(l.objectId) && !meta?.extra?.proceduralFill) return false;
                    // bake-off arms (SCRATCHBOX_TEXTURE_TARGET_LAYERS, experiment only): exactly the named layers, superseded or not
                    if (armTargets) return armTargets.includes(l.layer) && fs.existsSync(path.join(cache.modelsDir, path.basename(l.url)));
                    if (superseded.has(l.objectId) && !meta?.isGround) return false;
                    return fs.existsSync(path.join(cache.modelsDir, path.basename(l.url)));
                }).map(l => ({ layer: l, file: path.join(cache.modelsDir, path.basename(l.url)), surfaces: fitSurfaces(), ...(opts.late ? { late: true } : {}) }));
            };
            const progress = (message: string) => {
                run.state.texturePass = {
                    status: 'running', layersDone: outcomes.length, layersTotal: Math.max(handled.size, outcomes.length),
                    ...(outcomes.length ? { rungShares: weightedShares(outcomes.map(o => ({ shares: o.out.rungShares, texels: o.out.atlasTexels }))) } : {}), message
                };
            };
            // at most TEXTURE_LAYER_CONCURRENCY layers at once, over both stages
            let running = 0;
            const waiting: Array<() => void> = [];
            const withSlot = async <R>(fn: () => Promise<R>): Promise<R> => {
                if (running >= TEXTURE_LAYER_CONCURRENCY) await new Promise<void>(r => waiting.push(r));
                running++;
                try { return await fn(); } finally { running--; waiting.shift()?.(); }
            };

            // ---- the sources: the tile photo alone (the first twins), then with the Street View close-ups ----
            type Src = {
                kind: 'tile' | 'street-view'; views: ProjectionView[]; viewsUnavailable?: string; prepared: TextureSources; imagesSha: string[]; wideSha: string[]; poseHash: unknown[];
                residual?: number; ownershipKey?: string; temporaryKey?: string; lightingViews?: LightingCorrectedView[]; lightingUnavailable?: string;
                materials?: MaterialEvidence; materialsUnavailable?: string; materialsKey: string; palette: ReturnType<typeof palettesFromSurvey>; density: number; nativeBest: number
            };
            const prepare = async (input: TextureSourcesInput, signal: AbortSignal): Promise<TextureSources> => {
                const sources = texturePool ? await texturePool.prepare(input, signal) : prepareTextureSources(input, now);
                if (warming) await warming;
                return sources;
            };
            const baseInput = (): Pick<TextureSourcesInput, 'texturedGlb' | 'occluderFiles' | 'contextFiles'> => ({
                ...(extraction.texturedGlb ? { texturedGlb: extraction.texturedGlb } : {}),
                // the scan is the occluder and the judge of what the photos show; the full tile mesh: the real opening, the
                // statues, the trees and the buildings behind decide what each photo shows
                occluderFiles: [remeshedNow?.clayGlb], contextFiles: [extraction.geometryGlb]
            });
            const densityFor = (nativeSamples: number[], prepared: TextureSources, views: ProjectionView[]) => {
                const best = Math.min(...nativeSamples.filter(v => v > 0), ...(prepared.tile && Number.isFinite(prepared.tile.texelSizeM) && !views.length ? [prepared.tile.texelSizeM] : []));
                const cap = deps.textures?.maxDensityTexelsPerMeter ?? 20;
                return { density: Number.isFinite(best) && best > 0 ? Math.min(cap, 1 / best) : cap, best };
            };
            const tileSource = async (signal: AbortSignal): Promise<Src> => {
                const prepared = await prepare({ images: [], wide: [], ...baseInput() }, signal);
                const d = densityFor([], prepared, []);
                return {
                    kind: 'tile', views: [], prepared, imagesSha: [], wideSha: [], poseHash: [], palette: palettesFromSurvey(run.state.materialHints?.faces),
                    viewsUnavailable: arm.streetView === 'off' ? 'Street View is turned off for this build (SCRATCHBOX_TEXTURE_STREET_VIEW=off, an experiment arm)' : 'the first twin is baked from the tile photo alone, before the Street View close-ups are in; they refine it where they add texels',
                    materialsKey: facadeMaterialsEnabled() ? 'materials-first-twin' : 'materials-off', density: d.density, nativeBest: d.best
                };
            };
            /** The Street View sources, or why there are none (then the tile-photo twins stand). */
            const streetViewSource = async (io: StageIO, step: ReturnType<typeof timed>): Promise<{ src?: Src; why: string }> => {
                await evidenceDecided.promise;
                const evidence = evidencePromise ? await evidencePromise.catch(() => undefined) : undefined;
                const images = evidence?.images ?? [];
                const why = arm.streetView === 'off' ? 'Street View is turned off for this build (SCRATCHBOX_TEXTURE_STREET_VIEW=off, an experiment arm)'
                    : images.length ? '' : evidence ? `the Street View stage ${evidence.status === 'skipped' ? 'was skipped' : 'returned no image'}` : (visionAvailable ? 'the Street View stage did not run' : 'no vision model is configured, so no Street View close-ups were fetched');
                if (why) return { why };
                // photo tier A anchors each pano on the tile outline through a WIDE view of it: the survey's and the ring's whole-face views
                const surveyRes = surveyPromise ? (await surveyPromise.catch(() => undefined))?.result : undefined;
                const wideHeld = [
                    ...(surveyRes?.read ?? []).flatMap(r => { const bytes = surveyImageBytes(surveyRes!, r.imageIndex); return bytes ? [{ view: r.view, bytes, widthPx: r.widthPx, heightPx: r.heightPx, sha256: r.sha256 }] : []; }),
                    ...(evidence?.match ? matchRingImages(evidence.match) : [])
                ];
                const prepared = await step('prepareStreetView', () => prepare({ images, wide: wideHeld as EvidenceImage[], ...(evidence?.registration ? { registration: evidence.registration } : {}), ...baseInput() }, io.signal));
                let views = prepared.views;
                if (!views.length) return { why: `none of the ${images.length} grounding images decoded (${prepared.failures[0] ?? ''})` };
                // pixel ownership: a photo pixel textures the structure only if the photo shows the structure there (streetview-ownership.ts)
                const ownVision = visionAvailable;
                const segmenter = process.env.SCRATCHBOX_TEXTURE_OWNERSHIP === '0' ? false : deps.textures?.segmenter
                    ?? objectSegmenter(ownVision ? { modelSource: { getGenAIClient: async () => ownVision.client, getModelCandidates: () => ownVision.candidates } } : {});
                let ownershipKey: string | undefined;
                const { occluder, context } = prepared;
                if (segmenter && occluder.indices.length) {
                    const to = now();
                    const own = await step('streetViewOwnership', () => ownViews({ views, structure: occluder, ...(ownVision ? { target: request.query } : {}), ...(context.indices.length ? { context } : {}), segment: segmenter, describe: v => !trustedRegisteredPose(evidence?.registration, v.panoId), signal: io.signal, onProgress: m => io.progress(`textures: ${m}`), ...(process.env.SCRATCHBOX_OWNERSHIP_DEBUG_DIR ? { debugDir: path.join(process.env.SCRATCHBOX_OWNERSHIP_DEBUG_DIR, runId) } : {}) }));
                    views = own.views;
                    const kept = own.records.filter(r => r.status === 'segmented').length;
                    ownershipKey = `sv-ownership/${OWNERSHIP_VERSION}:${sha256Bytes(Buffer.concat(views.map(v => Buffer.from(v.ownerMask ?? new Uint8Array(0)))))}`;
                    cache.writeRunNote(runId, 'texture_ownership', { ms: now() - to, records: own.records });
                    io.progress(`textures: the structure was cut out of ${kept} of ${own.records.length} Street View photos; ${own.records.length - kept} photos vouch for no pixel (${own.records.find(r => r.status === 'refused')?.reason ?? 'none'})`);
                }
                // temporary structures (SCRATCHBOX_TEXTURE_TEMPORARY=1 only): what is outlined as temporary in front of the structure textures nothing
                let temporaryKey: string | undefined;
                if (views.length && textureTemporaryEnabled() && visionAvailable) {
                    const tt = now();
                    const chain = new VisionModelChain<string>({ client: visionAvailable.client, candidates: visionAvailable.candidates, signal: io.signal, ...chainExtras('textures'), ...(deps.sleep ? { sleep: deps.sleep } : {}) });
                    const tmp = await step('temporaryCheck', () => maskTemporaryInViews({ views, check: visionTemporaryChecker(chain), target: request.query, signal: io.signal, onProgress: m => io.progress(`textures: ${m}`) }));
                    views = tmp.views;
                    temporaryKey = `sv-temporary/${TEMPORARY_CHECK_VERSION}:${sha256Bytes(Buffer.from(JSON.stringify(tmp.records.map(r => [r.panoId, r.flagged, r.maskedPixels]))))}`;
                    cache.writeRunNote(runId, 'texture_temporary', { ms: now() - tt, records: tmp.records });
                    const flagged = tmp.records.filter(r => r.flagged);
                    io.progress(`textures: ${flagged.length} of ${tmp.records.length} Street View photos show something temporary in front of the structure${flagged.length ? ` (${flagged.map(r => r.description).filter(Boolean).slice(0, 3).join('; ')}); those regions texture nothing` : ''}`);
                }
                // the model lighting correction of the Street View photos (texture-lighting.ts), once for every layer
                let lightingViews: LightingCorrectedView[] | undefined;
                let lightingUnavailable: string | undefined;
                if (lightingClient && views.length) {
                    const tl = now();
                    io.progress(`textures: correcting the lighting of ${views.length} Street View photos with ${lightingModelIds.join(', ')} (detail-locked)`);
                    try {
                        const maskFor = context.indices.length ? (k: number) => {
                            const d = renderFrameDepth(context, views[k].camera), m = new Uint8Array(d.length);
                            for (let i = 0; i < d.length; i++) m[i] = Number.isFinite(d[i]) && d[i] < 1e8 ? 1 : 0;
                            return m;
                        } : undefined;
                        const r = await correctViewsLighting({ views, client: lightingClient, models: lightingModelIds, ...(maskFor ? { maskFor } : {}), signal: io.signal });
                        lightingViews = r.corrected;
                        cache.writeRunNote(runId, 'texture_lighting_views', { models: lightingModelIds, ms: now() - tl, corrected: r.corrected.length, records: r.records });
                        io.progress(`textures: lighting: ${r.corrected.length} of ${views.length} photos came back as a usable relighting (${Math.round((now() - tl) / 1000)} s)`);
                        if (!r.corrected.length) lightingUnavailable = `none of the ${views.length} Street View photos came back as a usable relighting (${r.records.find(x => x.reason)?.reason ?? 'no answer'})`;
                    } catch (err) {
                        if (isAbort(err) || io.signal.aborted) throw err;
                        lightingUnavailable = `the lighting correction of the Street View photos failed (${errorMessage(err)})`;
                    }
                }
                // the facade material reading's evidence (opt-in)
                let materials: MaterialEvidence | undefined;
                let materialsUnavailable: string | undefined;
                if (facadeMaterialsEnabled()) {
                    if (!visionAvailable && !deps.textures?.segment) materialsUnavailable = 'no vision model is configured to segment the photos';
                    else {
                        const tm = now();
                        try {
                            materials = await gatherMaterialEvidence({
                                views, surfaces: fitSurfaces().length ? fitSurfaces() : occluder ? scanFacePlanes(occluder) : [], ...(prepared.tile ? { tile: prepared.tile } : {}), segment: deps.textures?.segment ?? segmenterTool(), signal: io.signal,
                                onProgress: m => io.progress(`textures: ${m}`)
                            });
                            io.progress(`textures: facade material masks: ${materials.views.length} Street View views, ${materials.surfaces.length} tile faces, ${materials.calls} segmentation calls (${materials.failedCalls} failed) in ${((now() - tm) / 1000).toFixed(1)} s`);
                            if (!materials.views.length && !materials.surfaces.length) { materialsUnavailable = `no mask was read (${materials.unavailable.join('; ') || 'no source'})`; materials = undefined; }
                        } catch (err) {
                            if (isAbort(err) || io.signal.aborted) throw err;
                            materialsUnavailable = `the masks could not be gathered (${errorMessage(err)})`;
                        }
                    }
                }
                const materialsKey = materials ? sha256Bytes(Buffer.concat([...materials.views.map(v => Buffer.from(v.mask)), ...materials.surfaces.map(f => Buffer.from(f.mask))])) : facadeMaterialsEnabled() ? 'materials-unavailable' : 'materials-off';
                const d = densityFor(images.map(i => i.nativeSampleM), prepared, views);
                const poseHash = evidence?.registration ? [
                    ...[...evidence.registration.corrections.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)),
                    ...[...(evidence.registration.warps?.entries() ?? [])].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([id, w]) => [id, Array.from(w.dh), Array.from(w.dp)])
                ] : [];
                return {
                    why: '', src: {
                        kind: 'street-view', views, prepared, imagesSha: images.map(i => i.sha256), wideSha: wideHeld.map(i => i.sha256), poseHash, ...(evidence?.registration ? { residual: evidence.registration.afterRmsM } : {}),
                        ...(ownershipKey ? { ownershipKey } : {}), ...(temporaryKey ? { temporaryKey } : {}), ...(lightingViews ? { lightingViews } : {}), ...(lightingUnavailable ? { lightingUnavailable } : {}),
                        ...(materials ? { materials } : {}), ...(materialsUnavailable ? { materialsUnavailable } : {}), materialsKey, palette: palettesFromSurvey(run.state.materialHints?.faces), density: d.density, nativeBest: d.best
                    }
                };
            };

            // ---- one layer, one source set: the bake (cached), published ----
            const bake = async (target: TexTarget, src: Src, io: StageIO, stage: StageId) => {
                const clay = fs.readFileSync(target.file);
                const views = src.views;
                const fillFile = proceduralFillOf(target.layer);
                const fill = fillFile ? fillSpecFor(fillFile) : undefined;
                // a rebuilt surface no Street View reaches: the tile's relighting stands without the agreement gate (no baked shadow)
                const ungated = !!fill && !views.length && !!lightingClient;
                // a district-wide rebuilt layer at the tile photo's own texel needs a larger atlas than one structure's 2048
                const maxSide = deps.textures?.maxSide ?? (fill ? PROCEDURAL_ATLAS_MAX_SIDE : 2048);
                const { tile, tileUnavailable, tileSha, occluder, context, wideViews } = src.prepared;
                const key = stageKey(TEXTURE_PASS_VERSION, target.layer.layer, sha256Bytes(clay), src.imagesSha, src.wideSha, src.poseHash, tileSha, src.palette, !!enhance, deps.textures?.enhanceMode ?? 'recreate', src.density, maxSide, surfacesKey(target.surfaces), ...(!(rebuildOut.refit ?? rebuildOut.fit) && views.length ? ['no-fit-held-out-gate/2'] : []), ...(lightingClient && views.length ? [`light:${lightingModelIds.join(',')}:${lightingPromptVariant()}:${src.lightingViews?.length ?? 0}`] : []), ...(arm.key ? [arm.key] : []), ...(src.ownershipKey ? [src.ownershipKey] : []), ...(src.temporaryKey ? [src.temporaryKey] : []), src.materialsKey, ...(fill ? [`fill:${fill.sha}`, LIBRARY_FILL_VERSION, TWIN_DETAIL_VERSION, `transfer:${PROCEDURAL_TRANSFER_MAX_DISTANCE_M}`, 'islands-relit'] : []), ...(ungated ? [`light-ungated:${lightingModelIds.join(',')}:${lightingPromptVariant()}`] : []));
                let loo: NonNullable<TextureLayerOutcome['measureLoo']> | undefined;
                const entry = await cache.run<Omit<TextureLayerOutcome, 'glb'>>('textures', key, async dir => {
                    const run1 = (bakeViews: ProjectionView[], bakeUnavailable: string | undefined) => (texturePool ? texturePool.textureLayer.bind(texturePool) : textureLayer)({ layerKey: target.layer.layer, clayGlb: clay, ...(target.surfaces?.length ? { surfaces: target.surfaces } : {}) }, {
                        views: bakeViews, ...(wideViews.length && bakeViews.length ? { photoTierViews: wideViews } : {}), ...(photoTierEnabled() ? { photoTier: true } : {}), ...(bakeUnavailable ? { viewsUnavailable: bakeUnavailable } : {}), occluder,
                        ...(src.materials ? { materials: src.materials } : {}), ...(src.materialsUnavailable ? { materialsUnavailable: src.materialsUnavailable } : {}), ...(context.indices.length ? { context } : {}), observedSurface: TEXTURE_OBSERVED_SURFACE, poseEdgeGuardShare: TEXTURE_POSE_EDGE_GUARD_SHARE,
                        delight: { latitude: run.geoAnchor.lat, longitude: run.geoAnchor.lng },
                        ...(tile ? { tile } : {}), ...(tileUnavailable ? { tileUnavailable } : {}),
                        ...(src.residual !== undefined ? { registrationResidualM: src.residual } : {}),
                        ...(enhance ? { enhance: { client: enhance, ...(deps.textures?.enhanceModels ? { models: deps.textures.enhanceModels } : {}), ...(deps.textures?.enhanceMode ? { mode: deps.textures.enhanceMode } : {}) } } : { enhanceUnavailable: 'no image model client is configured for it' }),
                        ...(src.lightingViews?.length ? { lightingViews: src.lightingViews } : {}), ...(lightingClient && (bakeViews.length || ungated) ? { lighting: { client: lightingClient, models: lightingModelIds } } : {}), ...(src.lightingUnavailable ? { lightingUnavailable: src.lightingUnavailable } : {}),
                        ...(ungated ? { lightingUngated: true } : {}), ...(fill ? { generatedFill: fill.spec, transferMaxDistanceM: PROCEDURAL_TRANSFER_MAX_DISTANCE_M } : {}),
                        palette: src.palette, densityTexelsPerMeter: src.density, maxSide, signal: io.signal,
                        onProgress: m => { io.progress(`textures: ${m}`); progress(m); run.emit(stage, 'running', { message: m }); }
                    });
                    let out = await run1(views, src.viewsUnavailable);
                    // the no-fit rung keeps its Street View only where it shows the structure better than the clay does, on enough
                    // held-out evidence; otherwise the layer is baked again from the tile photo, and says why
                    const heldOut = out.bundle.fit;
                    const noFit = !(rebuildOut.refit ?? rebuildOut.fit) && views.length > 0 && arm.streetView !== 'keep';
                    const scored = heldOut && typeof heldOut.chamferPx === 'number' && typeof heldOut.clayChamferPx === 'number' ? heldOut : undefined;
                    const why = !noFit ? undefined
                        : !scored ? 'no held-out view could score it'
                        : scored.scoredViews < NO_FIT_MIN_SCORED_VIEWS ? `only ${scored.scoredViews} held-out views scored it (at least ${NO_FIT_MIN_SCORED_VIEWS} are needed to decide)`
                        : scored.chamferPx! >= scored.clayChamferPx! ? `its held-out edge chamfer ${scored.chamferPx} px is no better than the clay's ${scored.clayChamferPx} px over ${scored.scoredViews} views`
                        : undefined;
                    if (why) {
                        const reason = `Street View aimed at the facades (no fit was accepted) was set aside on ${target.layer.layer}: ${why}, so the layer is textured from the tile photo`;
                        io.progress(`textures: ${reason}`);
                        (out as TextureLayerOutcome & { release?: () => void }).release?.();
                        const again = await run1([], reason);
                        out = { ...again, degradations: [...again.degradations, { stage: 'projection', reasonCode: 'street_view_set_aside', reason, layerKey: target.layer.layer, fromRung: 1, toRung: 2 }] };
                    }
                    // a rebuilt layer: the library's relief and sheen under the twin's colour, at their real size
                    if (fill) out = { ...out, glb: addLibraryDetail(out.glb, fill.spec, fill.library).glb };
                    fs.writeFileSync(path.join(dir, 'twin.glb'), out.glb);
                    const { glb: _glb, measureLoo, release: _release, ...value } = out as TextureLayerOutcome & { release?: () => void };
                    loo = measureLoo;
                    return { value };
                }, { publish: () => [{ from: 'twin.glb', as: `${base}_${target.layer.layer}_tex_${key.slice(0, 8)}.glb` }], bypass: bypass('textures') });
                return { entry, loo };
            };
            /** The layer gains (or changes) its textured variant: same object, clay stays mounted; the viewport crossfades to it. */
            const commitTwin = (target: TexTarget, o: Omit<TexOutcome, 'layer'>, ladderRung: number, provenance: StagedTexturedVariant['provenance'], stage: StageId) => {
                const prior = outcomes.findIndex(x => x.layer.objectId === target.layer.objectId);
                if (prior >= 0) outcomes.splice(prior, 1);
                outcomes.push({ ...o, layer: target.layer });
                const current = run.state.layers.find(l => l.objectId === target.layer.objectId) ?? target.layer;
                const updated: StagedLayer = {
                    ...current,
                    textured: { url: o.url, bytes: o.bytes, ladderRung, rungShares: o.out.rungShares.map(x => round(x, 4)), provenance: provenance.map(p => ({ ...p, coverage: round(p.coverage, 4) })), confidenceChannels: CONFIDENCE_CHANNELS, builtAtMs: o.builtAtMs, cached: o.cached }
                };
                run.commit(updated, run.layerMeta[current.objectId]);
                progress(`${target.layer.layer} textured`);
                run.emit(stage, 'running', { message: `${target.layer.layer} textured (${o.sources === 'street-view' ? 'Street View and the tile photo' : o.sources === 'tile-refine' ? "tile_refine's tile photo" : 'the tile photo'})`, layers: [updated], progress: Math.min(1, outcomes.length / Math.max(1, handled.size)) }, true);
            };
            const textureWith = async (target: TexTarget, src: Src, io: StageIO, stage: StageId): Promise<'committed' | 'kept'> => {
                const { entry, loo } = await bake(target, src, io, stage);
                const sv = (entry.value.rungShares[0] ?? 0) + (entry.value.rungShares[1] ?? 0);
                const had = outcomes.find(x => x.layer.objectId === target.layer.objectId);
                if (had) had.streetViewTried = src.kind === 'street-view' || had.streetViewTried;
                // a Street View bake replaces the tile-photo twin only where it adds texels
                if (src.kind === 'street-view' && had && had.sources !== 'street-view' && !(sv > 0)) {
                    const reason = `Street View added no texel to ${target.layer.layer} (its photos do not reach this layer's surface past the ownership and visibility checks), so the twin baked from the tile photo stands`;
                    extraDegradations.push({ stage: 'projection', reasonCode: 'street_view_no_texels', reason, layerKey: target.layer.layer, fromRung: 0, toRung: 2 });
                    io.progress(`textures: ${reason}`);
                    return 'kept';
                }
                if (loo) looJobs.set(target.layer.objectId, loo); else looJobs.delete(target.layer.objectId);
                const pub = entry.published[0];
                commitTwin(target, { out: entry.value, url: pub.url, bytes: pub.bytes, cached: entry.cached, builtAtMs: entry.builtAtMs, surfaces: surfacesKey(target.surfaces), late: !!target.late, sources: src.kind, streetViewTried: src.kind === 'street-view' }, entry.value.bundle.ladderRung, entry.value.bundle.provenance, stage);
                return 'committed';
            };
            /** A district's twin: tile_refine's own photo-textured remesh (tile-refine-twin.ts). */
            const textureFromRefine = async (target: TexTarget, stage: StageId, io: StageIO) => {
                const src = refineTextured.get(target.layer.objectId)!;
                let bytes: Uint8Array = fs.readFileSync(src);
                // a district staged around a kept structure: its twin loses the structure's footprint as its clay layer did
                const carvedBy = CARVED_URL.test(target.layer.url) ? FOOTPRINT_REPORTS.get(run)?.footprint : undefined;
                if (carvedBy) bytes = hideFootprintInGlb(bytes, carvedBy).glb;
                // pipeline K: no per-photo model recreate (it treats neighbouring photos differently); the de-lit photos are
                // harmonised instead, one colour per side and height band with their seams levelled
                // pipeline K-D: a district's twin too, its colours matched per building (district-buildings.ts)
                const kTwin = pipelineK && (isolateOk || (kdDistrict && !request.isolate));
                const kdBuildings = kTwin && kdDistrict && districtBuildings?.length ? districtFootprints(districtBuildings) : undefined;
                const harmonizeOn = kTwin && stepOn('twin.harmonize', true);
                // pipeline K-D: the delight's shadow lift on the district's upward surfaces seen from above (roofs, terraces,
                // streets, plazas), off by default; SCRATCHBOX_KD_UPWARD_LIFT=0.3 on (a brightness curve: it lifts dark
                // materials as well as shadows, so gentler than the walls' 0.6)
                const upwardLift = kTwin && kdDistrict ? Math.max(0, Math.min(1, Number(process.env.SCRATCHBOX_KD_UPWARD_LIFT?.trim() || 0) || 0)) : 0;
                // the image-model party wall: off by default (user decision, 2026-10-28: the tiled wall did not work; the clip and infill close the side), SCRATCHBOX_K_PARTY_WALL_TEXTURE=1 or the node graph on
                const partyWallOn = kTwin && stepOn('twin.partyWall', process.env.SCRATCHBOX_K_PARTY_WALL_TEXTURE?.trim() === '1');
                // pipeline K's material regions: only with the app's texture library (deps.pipelineK); on again since the user's
                // decision of 2026-10-30 (off 2026-10-28 to 10-30 while the openings' finishes were wrong); SCRATCHBOX_K_MATERIAL_REGIONS=0 off
                const materialSets = kTwin && stepOn('twin.materials', process.env.SCRATCHBOX_K_MATERIAL_REGIONS?.trim() !== '0') ? deps.pipelineK?.materialSets : undefined;
                if (kTwin && !materialSets) logStep('twin.materials', 'skipped');
                // the swatch detail bake: the building's survey swatches (AI Beautify, one image call per station) baked into the
                // twin's atlases as the detail band the tile cannot carry (generated); off by default, SCRATCHBOX_K_DETAIL_BAKE=1 or the node graph on
                const detailBakeOn = kTwin && !!deps.pipelineK?.detailBake && stepOn('twin.detailBake', process.env.SCRATCHBOX_K_DETAIL_BAKE?.trim() === '1');
                // the facade upscale: each rebuilt facade's photo given fine detail by an image model, only where its answer still
                // matches the photo (pipeline-k/facade-upscale.ts, generated); on by default for a district (K-D, capped per chunk),
                // off for a single building; SCRATCHBOX_K_FACADE_UPSCALE=1/0 or the node graph sets it
                const upscaleDistrict = kdDistrict && !request.isolate;
                const facadeUpscaleOn = kTwin && facadeUpscaleAsked(request.steps, { district: upscaleDistrict });
                // the rebuilt facades' lowest storey tessellated and displaced by their materials' height (height-relief.ts,
                // generated), drawn by the viewer only up close; on for one building, off for a district
                const heightReliefOn = kTwin && !!materialSets && heightReliefAsked(request.steps);
                // the view relight: the photos evened out from image-model relights of rendered views (pipeline-k/view-relight.ts);
                // off by default, SCRATCHBOX_K_VIEW_RELIGHT=1 or the node graph on; needs the lighting model client
                const relightClient = harmonizeOn && stepOn('twin.viewRelight', process.env.SCRATCHBOX_K_VIEW_RELIGHT?.trim() === '1') ? deps.textures?.lighting : undefined;
                if (kTwin && !relightClient) logStep('twin.viewRelight', 'skipped');
                // the roof shadow lift: suns fitted from the mesh, its cast shadow on every roof and terrace lifted (pipeline-k/roof-shadow.ts),
                // a single building (pipeline K, with harmonising) or a district's twin alike; on by default for pipeline K (user decision,
                // 2026-10-29), SCRATCHBOX_K_ROOF_SHADOW=0 or the node graph off; elsewhere off, SCRATCHBOX_K_ROOF_SHADOW=1 or the node graph on
                const roofShadowEnv = process.env.SCRATCHBOX_K_ROOF_SHADOW?.trim();
                const roofShadowOn = (!kTwin || harmonizeOn) && stepOn('twin.roofShadow', kTwin ? roofShadowEnv !== '0' : roofShadowEnv === '1');
                const roofShadowOpts = roofShadowOn ? { roofShadow: { ...(extraction.geometryGlb && fs.existsSync(extraction.geometryGlb) ? { context: sceneToRenderMesh(readGlbScene(extraction.geometryGlb)) } : {}), progress: (m: string) => io.progress(`textures: ${m}`) } } : {};
                if (kTwin && !roofShadowOn) logStep('twin.roofShadow', 'skipped');
                if (kTwin && !materialSets) cache.writeRunNote(runId, 'pipeline_k_materials', { skipped: deps.pipelineK?.materialSets ? 'off (SCRATCHBOX_K_MATERIAL_REGIONS=0 or the node graph)' : 'no texture library in this build\'s services' });
                const kOrthos = materialSets ? cache.readRunNote<{ orthosDir?: string }>(runId, 'pipeline_k')?.orthosDir : undefined;
                const fitFile = kOrthos ? path.join(kOrthos, WINDOW_FIT_FILE) : undefined;
                // the facade reader on the finished exterior (pipeline-k/twin-reader.ts): after the twin's de-light, roof shadow and
                // harmonising, every plane read on the photos as they will be shown; what it saw (the brief, what lies between the
                // windows) is told to the finish read, the pick by look and the namer below. tile_refine's flat scan (beside the K
                // orthos) gives the other planes their frames
                const flatGlb = kOrthos ? path.join(path.dirname(kOrthos), 'textured.glb') : undefined;
                const readerAsk = kOrthos && flatGlb && fs.existsSync(flatGlb) && stepOn('remesh.facadeRead', process.env.SCRATCHBOX_K_FACADE_READ?.trim() !== '0') ? facadeReaderAsk(io.signal, 'textures') : undefined;
                // what the reader saw, for the namer of the building's materials below
                let readerSeen: { records: FacadeReadRecord[]; brief?: string } | undefined;
                // the reader's answers and the material choices kept beside the stage caches, so a rebuild or a later run asks
                // only about what changed (pipeline-k/model-readings.ts); a retry of the stage asks again, as its reply cache does
                const modelReadings = bypass('textures') ? undefined : modelReadingsStore();
                const readExterior = readerAsk ? async (finalImage: Map<number, RgbaImage8>, json: any): Promise<void> => {
                    try {
                        const tr = await readOnTwin({ orthosDir: kOrthos!, flatGlb: flatGlb!, twinJson: json, finalImage, ask: readerAsk, building: { name: request.query, ...(run.state.place?.resolvedAddress ? { address: run.state.place.resolvedAddress } : {}) }, signal: io.signal, progress: (m: string) => io.progress(`textures: ${m}`), ...(modelReadings ? { readings: { store: modelReadings, model: FACADE_READER_MODEL_KEY } } : {}) });
                        const recs = tr.records.facades, by = (o: string) => recs.filter(x => x.outcome === o).length;
                        readerSeen = { records: recs, ...(tr.records.brief && 'building' in tr.records.brief ? { brief: tr.records.brief.building } : {}) };
                        cache.writeRunNote(runId, 'pipeline_k_facade_reader', { version: FACADE_READER_VERSION, on: TWIN_READER_VERSION, ...tr.report, read: recs.length, replaced: by('replaced'), kept: by('kept'), skipped: by('skipped'), failed: by('failed'), unread: tr.records.unread, ms: tr.records.ms, ...(tr.records.calls ? { calls: tr.records.calls } : {}), ...(tr.records.brief ? { brief: tr.records.brief } : {}), reviewDir: path.join(tr.report.dir, 'facade_reader'), records: recs });
                        run.note(PROVENANCE.photoInferred, `facade reader (${FACADE_READER_VERSION}) on the finished exterior: of ${recs.length} planes read, ${by('replaced')} had their openings placed by a vision model's reading (told the building and its families), fitted to the photo and judged; recorded and told to the material reads, nothing drawn from them`);
                    } catch (err) {
                        if (isAbort(err) || io.signal.aborted) throw err;
                        cache.writeRunNote(runId, 'pipeline_k_facade_reader', { version: FACADE_READER_VERSION, on: TWIN_READER_VERSION, failed: true, reason: errorMessage(err) });
                    }
                } : undefined;
                // the building's materials named from a picture of each appearance class (pipeline-k/material-naming.ts), told the
                // building, its brief and what the reader saw between its windows; saved with the twin
                const nameClasses = materialSets && visionAvailable ? async (classes: RegionClass[], swatches: Buffer) => {
                    const seen = readerSeen?.records ?? [];
                    try {
                        const chain = new VisionModelChain<string>({ client: visionAvailable.client, candidates: [...new Set([FACADE_READER_MODEL.model, ...visionAvailable.candidates])], signal: io.signal, ...chainExtras('textures'), ...(deps.sleep ? { sleep: deps.sleep } : {}) });
                        const replyText = (res: { candidates?: Array<{ content?: { parts?: Array<{ text?: string; thought?: boolean }> } }> }) => (res.candidates?.[0]?.content?.parts ?? []).filter(q => !q.thought).map(q => q.text ?? '').join('');
                        const prompt = namingPrompt(classes, { building: [request.query, run.state.place?.resolvedAddress].filter(Boolean).join(', '), ...(readerSeen?.brief ? { brief: readerSeen.brief } : {}), between: betweenSeen(seen) });
                        const res = await chain.generate({ contents: [{ role: 'user', parts: [{ inlineData: { mimeType: 'image/png', data: swatches.toString('base64') } }, { text: prompt }] }], config: { responseMimeType: 'application/json', temperature: 0, abortSignal: io.signal } },
                            { stage: 'grammar', ...VISION_CALL_POLICY.grammar, thinkingBudget: FACADE_READER_MODEL.thinkingBudget, valid: x => { try { parseClassWords(replyText(x), classes.length); return true; } catch { return false; } } });
                        const words = parseClassWords(replyText(res.response), classes.length);
                        res.remember();
                        return { words };
                    } catch (err) {
                        if (isAbort(err) || io.signal.aborted) throw err;
                        return { unnamed: `naming the classes failed: ${errorMessage(err)}` };
                    }
                } : undefined;
                // each class's finish read from the classes' swatch sheet before the sets are ranked (pipeline-k/material-finish.ts):
                // roughness and metalness as numbers with a confidence, which the ranking ranks toward
                const readFinish = materialSets && visionAvailable ? async (classes: RegionClass[], swatches: Buffer): Promise<Array<ClassFinish | undefined>> => {
                    const chain = new VisionModelChain<string>({ client: visionAvailable.client, candidates: [...new Set([FACADE_READER_MODEL.model, ...visionAvailable.candidates])], signal: io.signal, ...chainExtras('textures'), ...(deps.sleep ? { sleep: deps.sleep } : {}) });
                    const replyText = (res: { candidates?: Array<{ content?: { parts?: Array<{ text?: string; thought?: boolean }> } }> }) => (res.candidates?.[0]?.content?.parts ?? []).filter(q => !q.thought).map(q => q.text ?? '').join('');
                    const prompt = finishPrompt(classes, { building: [request.query, run.state.place?.resolvedAddress].filter(Boolean).join(', '), ...(readerSeen?.brief ? { brief: readerSeen.brief } : {}) });
                    // a sheet read before (another run, chunk or machine, the same prompt and model) is not asked again
                    const memoKey = readingKey('material-finish', [MATERIAL_FINISH_VERSION, FACADE_READER_MODEL_KEY, prompt, swatches]);
                    const memo = modelReadings ? await modelReadings.get<Array<ClassFinish | null>>(memoKey) : undefined;
                    if (memo && memo.length === classes.length) return memo.map(f => f ?? undefined);
                    const res = await chain.generate({ contents: [{ role: 'user', parts: [{ inlineData: { mimeType: 'image/png', data: swatches.toString('base64') } }, { text: prompt }] }], config: { responseMimeType: 'application/json', temperature: 0, abortSignal: io.signal } },
                        { stage: 'grammar', ...VISION_CALL_POLICY.grammar, thinkingBudget: FACADE_READER_MODEL.thinkingBudget, valid: x => { try { parseClassFinish(replyText(x), classes.length); return true; } catch { return false; } } });
                    const finish = parseClassFinish(replyText(res.response), classes.length);
                    res.remember();
                    modelReadings?.put(memoKey, finish.map(f => f ?? null));
                    return finish;
                } : undefined;
                // each class's library set picked by its look among the nearest the ranking gives (pipeline-k/material-choice.ts):
                // the class's patches beside each candidate at the same real size, recoloured to the class's colour
                const askSets = materialSets && visionAvailable ? async (rows: ChoiceRow[], swatches: { png: Buffer; spanM?: number }) => {
                    const spanM = swatches.spanM ?? CHOICE_SPAN_M, sheet = candidateSheetPng(rows, spanM);
                    const chain = new VisionModelChain<string>({ client: visionAvailable.client, candidates: [...new Set([FACADE_READER_MODEL.model, ...visionAvailable.candidates])], signal: io.signal, ...chainExtras('textures'), ...(deps.sleep ? { sleep: deps.sleep } : {}) });
                    const replyText = (res: { candidates?: Array<{ content?: { parts?: Array<{ text?: string; thought?: boolean }> } }> }) => (res.candidates?.[0]?.content?.parts ?? []).filter(q => !q.thought).map(q => q.text ?? '').join('');
                    const prompt = choicePrompt(rows, spanM, { building: [request.query, run.state.place?.resolvedAddress].filter(Boolean).join(', '), ...(readerSeen?.brief ? { brief: readerSeen.brief } : {}) });
                    const res = await chain.generate({ contents: [{ role: 'user', parts: [{ inlineData: { mimeType: 'image/png', data: swatches.png.toString('base64') } }, { inlineData: { mimeType: 'image/png', data: sheet.toString('base64') } }, { text: prompt }] }], config: { responseMimeType: 'application/json', temperature: 0, abortSignal: io.signal } },
                        { stage: 'grammar', ...VISION_CALL_POLICY.grammar, thinkingBudget: FACADE_READER_MODEL.thinkingBudget, valid: x => { try { parseChoices(replyText(x), rows); return true; } catch { return false; } } });
                    const picks = parseChoices(replyText(res.response), rows);
                    res.remember();
                    return picks;
                } : undefined;
                // a class shown the same candidates as one chosen before (another building, chunk or run) and of its colour takes that pick; only the rest are asked
                const chooseSets = askSets ? async (rows: ChoiceRow[], swatches: { png: Buffer; spanM?: number }): Promise<Array<SetChoice | undefined>> => (await chooseWithMemory(rows, swatches, askSets, modelReadings ? { store: modelReadings, model: FACADE_READER_MODEL_KEY } : undefined)).picks : undefined;
                const grammarFile = kOrthos ? path.join(kOrthos, WALL_GRAMMAR_FILE) : undefined;
                const key = stageKey(TILE_REFINE_TWIN_VERSION, upwardLift ? `upLift:${upwardLift}` : '', target.layer.layer, sha256Bytes(bytes), fitFile && fs.existsSync(fitFile) ? contentHash(fitFile) : '', grammarFile && fs.existsSync(grammarFile) ? contentHash(grammarFile) : '', !!enhance && !harmonizeOn, harmonizeOn ? TEXTURE_HARMONIZE_VERSION : '', materialSets && visionAvailable ? MATERIAL_FINISH_VERSION : '', materialSets ? `${MATERIAL_REGIONS_VERSION}${process.env.SCRATCHBOX_K_MATERIAL_PICK?.trim() === 'spectrum' ? '+harvest' : ''}` : '', partyWallOn ? PARTY_WALL_TEXTURE_VERSION : '', partyWallOn && visionAvailable ? 'party-wall-image' : '', facadeUpscaleOn ? `${FACADE_UPSCALE_VERSION}:${visionAvailable ? 'image' : 'none'}${upscaleDistrict ? ':district' : ''}` : '', heightReliefOn ? `${HEIGHT_RELIEF_VERSION}:${JSON.stringify(HEIGHT_RELIEF_PARAMS)}` : '', detailBakeOn ? `${TILE_DETAIL_BAKE_VERSION}:${sha256Bytes(fs.readFileSync(extraction.texturedGlb)).slice(0, 12)}` : '', relightClient ? `${VIEW_RELIGHT_VERSION}:${lightingModels().join(',')}:${lightingPromptVariant()}:${viewRelightEnvParams().key}` : '', roofShadowOn ? ROOF_SHADOW_VERSION : '', process.env.SCRATCHBOX_K_SKY_DELIGHT === '1' ? SKY_DELIGHT_VERSION : '', readerAsk ? `${FACADE_READER_VERSION}:${TWIN_READER_VERSION}:${JSON.stringify(FACADE_READER_PARAMS)}` : '', nameClasses ? MATERIAL_NAMING_VERSION : '', chooseSets ? MATERIAL_CHOICE_VERSION : '');
                const entry = await cache.run<{ rungShares: number[]; provenance: TileRefineTwin['provenance']; ladderRung: number; triangles: number; harmonize?: TextureHarmonizeReport; materialRegions?: TileRefineTwin['materialRegions']; materialClasses?: TileRefineTwin['materialClasses'] }>('textures', key, async dir => {
                    const twin = await tileRefineTwin(bytes, target.layer.layer, kTwin ? { onStep: (step: string, state: 'running' | 'done' | 'failed') => logStep(`twin.${step}`, state), ...(upwardLift ? { upwardShadowLift: upwardLift } : {}), ...(harmonizeOn ? { harmonize: { groundY: structure?.groundY ?? 0, ...(kdBuildings ? { buildingOf: districtBuildingIndex(kdBuildings) } : {}), ...(process.env.SCRATCHBOX_K_SKY_DELIGHT === '1' && extraction.geometryGlb && fs.existsSync(extraction.geometryGlb) ? { skyContext: sceneToRenderMesh(readGlbScene(extraction.geometryGlb)) } : {}) } } : {}), ...(relightClient ? { viewRelight: { client: relightClient, models: lightingModels(), params: viewRelightEnvParams().params, signal: io.signal, progress: (m: string) => io.progress(`textures: ${m}`) } } : {}), ...roofShadowOpts, ...(materialSets ? { materialRegions: { harvest: process.env.SCRATCHBOX_K_MATERIAL_PICK?.trim() === 'spectrum', sets: (classes: RegionClass[], swatches?: { png: Buffer; spanM?: number }) => materialSets(classes, { signal: io.signal, progress: (m: string) => io.progress(m), ...(chooseSets && swatches ? { choose: (rows: ChoiceRow[]) => chooseSets(rows, swatches) } : {}), ...(readFinish && swatches ? { finish: () => readFinish(classes, swatches.png) } : {}), ...(modelReadings ? { store: modelReadings } : {}) }), ...(readExterior ? { readExterior } : {}), ...(nameClasses ? { nameClasses } : {}) } } : {}) } : enhance || roofShadowOn ? {
                        ...(enhance ? { recreate: {
                            client: enhance, ...(deps.textures?.enhanceModels ? { models: deps.textures.enhanceModels } : {}),
                            budgetMs: TILE_REFINE_RECREATE_BUDGET_MS
                        } } : {}),
                        ...roofShadowOpts,
                        // a district's twin logs its roof shadow step too (the other twin steps are pipeline K's)
                        ...(roofShadowOn ? { onStep: (step: string, state: 'running' | 'done' | 'failed') => { if (step === 'roofShadow') logStep(`twin.${step}`, state); } } : {})
                    } : undefined);
                    if (twin.harmonize) cache.writeRunNote(runId, 'pipeline_k_texture', { version: TEXTURE_HARMONIZE_VERSION, layer: target.layer.layer, ...twin.harmonize });
                    if (twin.viewRelight) cache.writeRunNote(runId, 'pipeline_k_view_relight', { version: VIEW_RELIGHT_VERSION, layer: target.layer.layer, ...twin.viewRelight });
                    if (twin.roofShadow) {
                        // the audit from above beside the twin (run notes hold no images); the note names it
                        const { auditGrid, ...note } = twin.roofShadow;
                        const auditPng = auditGrid ? path.join(dir, 'roof_shadow_topdown.png') : undefined;
                        if (auditGrid && auditPng) fs.writeFileSync(auditPng, roofShadowAuditPng(auditGrid));
                        // the stage writes into <entry>.tmp-<pid>-<hex>, renamed to <entry> when it finishes: the note names the entry
                        const auditFinal = auditPng ? path.join(dir.replace(/\.tmp-\d+-[0-9a-f]+$/, ''), 'roof_shadow_topdown.png') : undefined;
                        if (twin.roofShadowQa) {
                            // the lift judged from above (halos, lifts on lit surfaces, seams), its picture beside the audit
                            const { grid, ...qa } = twin.roofShadowQa;
                            if (grid) fs.writeFileSync(path.join(dir, 'roof_shadow_qa.png'), shadowLiftQaPng(grid));
                            cache.writeRunNote(runId, 'roof_shadow_qa', { layer: target.layer.layer, ...(grid ? { png: path.join(dir.replace(/\.tmp-\d+-[0-9a-f]+$/, ''), 'roof_shadow_qa.png') } : {}), ...qa });
                        }
                        if (auditFinal) io.progress(`textures: the roof shadow lift seen from above (green lifted, orange rejected, magenta no sun, grey lit): ${auditFinal}`);
                        cache.writeRunNote(runId, 'roof_shadow', { version: ROOF_SHADOW_VERSION, layer: target.layer.layer, ...(auditGrid && auditFinal ? { auditPng: auditFinal, auditGrid: { cellM: auditGrid.cellM, x0: auditGrid.x0, z0: auditGrid.z0, w: auditGrid.w, h: auditGrid.h } } : {}), ...note });
                    }
                    // pipeline K: the party wall (a wall the scan lacks, base-cleanup.ts) drawn as the building's masonry continued, by the image model
                    let twinGlb: Uint8Array = twin.glb;
                    if (kTwin && !harmonizeOn) logStep('twin.harmonize', 'skipped');
                    if (kTwin && !partyWallOn) logStep('twin.partyWall', 'skipped');
                    if (partyWallOn) {
                        const orthosDir = cache.readRunNote<{ orthosDir?: string }>(runId, 'pipeline_k')?.orthosDir;
                        logStep('twin.partyWall', 'running');
                        const pw = await texturePartyWall(twin.glb, { ...(visionAvailable ? { client: genAiEnhanceClient(visionAvailable.client) } : {}), models: [LIGHTING_MODEL_FULL], ...(orthosDir ? { orthosDir } : {}), signal: io.signal, progress: (m: string) => io.progress(m) }).catch((err: unknown) => {
                            if (isAbort(err) || io.signal.aborted) throw err;
                            return { glb: Buffer.from(twin.glb), report: { walls: -1, skipped: `texturing the party wall failed: ${errorMessage(err)}` } };
                        });
                        logStep('twin.partyWall', 'done');
                        twinGlb = pw.glb;
                        cache.writeRunNote(runId, 'pipeline_k_party_wall', { version: PARTY_WALL_TEXTURE_VERSION, layer: target.layer.layer, ...pw.report });
                    }
                    let provenance = twin.provenance;
                    if (kTwin && !detailBakeOn) logStep('twin.detailBake', 'skipped');
                    if (detailBakeOn) {
                        logStep('twin.detailBake', 'running');
                        const place = run.state.place;
                        const db = await deps.pipelineK!.detailBake!({ glb: twinGlb, tilesGlb: extraction.texturedGlb, lat: place.lat, lng: place.lng, place: place.resolvedAddress || request.query, workDir: path.join(cache.dir, 'detail_bake'), signal: io.signal, progress: (m: string) => io.progress(m) }).catch((err: unknown) => {
                            if (isAbort(err) || io.signal.aborted) throw err;
                            return { glb: Buffer.from(twinGlb), report: { version: TILE_DETAIL_BAKE_VERSION, replaced: 0, skipped: `the detail bake failed: ${errorMessage(err)}` } as TileDetailBakeReport };
                        });
                        logStep('twin.detailBake', db.report.replaced ? 'done' : 'skipped');
                        if (db.report.replaced) { twinGlb = db.glb; provenance = [...provenance, detailBakeProvenance(db.report)]; }
                        io.progress(db.report.replaced ? `swatch detail baked into ${db.report.replaced} of ${db.report.images} atlases (${Math.round(100 * db.report.coverage)}% of the surface, generated)` : `no swatch detail baked: ${db.report.skipped}`);
                        cache.writeRunNote(runId, 'pipeline_k_detail_bake', { layer: target.layer.layer, ...db.report });
                    }
                    if (kTwin && !facadeUpscaleOn) logStep('twin.facadeUpscale', 'skipped');
                    if (facadeUpscaleOn) {
                        logStep('twin.facadeUpscale', 'running');
                        const fu = await upscaleFacadeTextures(twinGlb, { ...(visionAvailable ? { client: genAiEnhanceClient(visionAvailable.client) } : {}), models: FACADE_UPSCALE_MODELS, ...(modelReadings ? { store: modelReadings } : {}), place: { lat: extraction.geoAnchor.lat, lng: extraction.geoAnchor.lng, heightMeters: extraction.originEllipsoidalHeightM }, signal: io.signal, progress: (m: string) => io.progress(m) }, upscaleDistrict ? FACADE_UPSCALE_DISTRICT_PARAMS : FACADE_UPSCALE_PARAMS);
                        logStep('twin.facadeUpscale', fu.report.upscaled ? 'done' : 'skipped');
                        if (fu.report.upscaled) { twinGlb = fu.glb; provenance = [...provenance, facadeUpscaleProvenance(fu.report)]; }
                        io.progress(fu.report.upscaled ? `facade upscale: ${fu.report.upscaled} of ${fu.report.facades} rebuilt facades given fine detail (${fu.report.reused ? `${fu.report.reused} from their kept best upscale, ` : ''}${fu.report.calls} image calls, ${fu.report.cached} tiles saved before; generated)` : `no facade upscaled: ${fu.report.skipped}`);
                        cache.writeRunNote(runId, 'pipeline_k_facade_upscale', { layer: target.layer.layer, ...fu.report });
                    }
                    if (kTwin && !heightReliefOn) logStep('twin.heightRelief', 'skipped');
                    if (heightReliefOn) {
                        // a failed native build or run is thrown (no flat stand-in is written in its place)
                        logStep('twin.heightRelief', 'running');
                        const hr = await applyHeightRelief(twinGlb, HEIGHT_RELIEF_PARAMS, { signal: io.signal });
                        logStep('twin.heightRelief', hr.report.cells ? 'done' : 'skipped');
                        if (hr.report.cells) { twinGlb = hr.glb; provenance = [...provenance, heightReliefProvenance(hr.report, twin.surfaceAreaM2)]; }
                        io.progress(hr.report.cells ? `height relief: ${hr.report.cells} cells of ${hr.report.displacedSurfaces} rebuilt facades (${hr.report.areaM2} m2, the lowest ${hr.report.bandM} m) displaced by their materials' height, up to ${Math.round(hr.report.maxRecessM * 1000)} mm inward: ${hr.report.nearTriangles + hr.report.riserTriangles} triangles in place of ${hr.report.baseTriangles}, drawn within ${hr.report.showWithinM} m (edges from ${Math.round(hr.report.edgeMinUsedM * 1000)} mm; generated)` : `no surface displaced: ${hr.report.skipped}`);
                        cache.writeRunNote(runId, 'pipeline_k_height_relief', { layer: target.layer.layer, ...hr.report });
                    }
                    fs.writeFileSync(path.join(dir, 'twin.glb'), twinGlb);
                    return { value: { rungShares: twin.rungShares, provenance, ladderRung: twin.ladderRung, triangles: twin.triangles, ...(twin.harmonize ? { harmonize: twin.harmonize } : {}), ...(twin.materialRegions ? { materialRegions: twin.materialRegions } : {}), ...(twin.materialClasses ? { materialClasses: twin.materialClasses } : {}) } };
                }, { publish: () => [{ from: 'twin.glb', as: `${base}_${target.layer.layer}_tex_${key.slice(0, 8)}.glb` }], bypass: bypass('textures') });
                const pub = entry.published[0];
                // the material regions' report, whether the stage ran now or its result came from the cache
                if (materialSets) {
                    const mr = entry.value.materialRegions;
                    // a layer whose textures drew no regions (the vision vote's, with no rebuilt facade) keeps the note of
                    // one that did, so the run's report is the building's
                    const prior = cache.readRunNote<{ layer?: string; skipped?: string }>(runId, 'pipeline_k_materials');
                    if (mr && 'skipped' in mr && prior && !prior.skipped && prior.layer !== target.layer.layer) io.progress(`material regions not drawn on ${target.layer.layer}: ${mr.skipped} (the report stays ${prior.layer}'s)`);
                    else cache.writeRunNote(runId, 'pipeline_k_materials', { layer: target.layer.layer, cached: entry.cached, ...(mr ?? { skipped: 'the cached textures were written before their result carried the material regions\' report; nothing was recorded for them' }), ...(entry.value.materialClasses ? { materialClasses: entry.value.materialClasses } : {}) });
                    if (mr && !('skipped' in mr && prior && !prior.skipped && prior.layer !== target.layer.layer)) io.progress('skipped' in mr ? `material regions not drawn: ${mr.skipped}` : `${describeMaterialRegions(mr)}${entry.cached ? ' (cached)' : ''}`);
                }
                // pipeline K's finished model, for scripts that rebuild the building from it (site-guides.ts)
                if (harmonizeOn) cache.writeRunNote(runId, 'pipeline_k_model', { model: path.join(entry.dir, 'twin.glb'), url: pub.url, layer: target.layer.layer });
                // the finished model looked at from outside, for what is still untextured once everything is painted
                if (harmonizeOn && isolateMode) {
                    const seen = measureVisibleDefects(fs.readFileSync(path.join(entry.dir, 'twin.glb')));
                    cache.writeRunNote(runId, 'pipeline_k_visible_defects_textured', { ...seen, views: seen.views.map(({ mask: _m, ...v }) => v), layer: target.layer.layer, cached: entry.cached });
                    io.progress(`${target.layer.layer} seen from outside: ${seen.why}`);
                    if (seen.clayShare > VISIBLE_DEFECTS_PARAMS.maxClayShare || seen.maxViewClayShare > VISIBLE_DEFECTS_PARAMS.maxViewClayShare) extraDegradations.push({ stage: 'textures', reasonCode: 'visible_clay', reason: `untextured surface seen on the finished building: ${seen.why}`, layerKey: target.layer.layer });
                }
                const out = {
                    layerKey: target.layer.layer, rungShares: entry.value.rungShares, atlasTexels: entry.value.triangles, atlas: { width: 0, height: 0, texelsPerMeter: 0 } as unknown as TextureLayerOutcome['atlas'],
                    // no atlas: the twin keeps each primitive's own UVs into its leaf image
                    bundle: { layerKey: target.layer.layer, uv: [], ladderRung: entry.value.ladderRung, rungReason: "tile_refine's photo-textured remesh (each primitive's UVs into its leaf tile's image)", provenance: entry.value.provenance } as unknown as TextureLayerOutcome['bundle'],
                    degradations: [], modelsUsed: [], timingsMs: {}
                } as unknown as Omit<TextureLayerOutcome, 'glb' | 'measureLoo'>;
                commitTwin(target, { out, url: pub.url, bytes: pub.bytes, cached: entry.cached, builtAtMs: entry.builtAtMs, surfaces: 'none', late: !!target.late, sources: 'tile-refine' }, entry.value.ladderRung, entry.value.provenance, stage);
            };
            // the leave-one-pano-out fits (Street View twins only), one at a time, within the stage's own limit
            const measured = new Set<object>();
            const looLane = async (io: StageIO, started: number, budgetMs: number) => {
                const looDeadline = started + budgetMs - TEXTURE_LOO_MARGIN_MS;
                const pending = outcomes.filter(o => !measured.has(o));
                for (const o of [...pending.filter(x => (x.out.photoTier?.texelShare ?? 0) > 0), ...pending.filter(x => !((x.out.photoTier?.texelShare ?? 0) > 0))]) {
                    if (measured.has(o) || !outcomes.includes(o)) continue;
                    measured.add(o);
                    const job = looJobs.get(o.layer.objectId);
                    if (!job || !o.out.bundle.fit) continue;
                    looJobs.delete(o.layer.objectId);
                    const left = looDeadline - now();
                    if (left < 10_000) { io.progress(`textures: ${o.layer.layer}: no time left in the stage for the leave-one-pano-out fit`); continue; }
                    const tl = now();
                    try {
                        const { materials: materialsLoo, ...loo } = await job(Math.min(LOO_BUDGET_MS, left));
                        const materials = o.out.bundle.materials && materialsLoo ? { ...o.out.bundle.materials, loo: materialsLoo } : o.out.bundle.materials;
                        o.out = { ...o.out, bundle: { ...o.out.bundle, fit: { ...o.out.bundle.fit!, loo }, ...(materials ? { materials } : {}) }, ...(materials ? { materials } : {}), timingsMs: { ...o.out.timingsMs, fitLoo: now() - tl } };
                        if (materialsLoo) io.progress(`textures: ${o.layer.layer}: facade materials, walls' held-out fit before ${materialsLoo.wallBefore.chamferPx ?? 'n/a'} px / NCC ${materialsLoo.wallBefore.gradNcc ?? 'n/a'}, after ${materialsLoo.wallAfter.chamferPx ?? 'n/a'} px / NCC ${materialsLoo.wallAfter.gradNcc ?? 'n/a'} (${materialsLoo.reason})`);
                        io.progress(`textures: ${o.layer.layer}: leave-one-pano-out fit over ${loo.panos} panos${loo.sampled ? ` (sampled: ${loo.panos} of ${loo.panosTotal})` : ''}: texture edge chamfer ${loo.chamferPx ?? 'n/a'} px, gradient NCC ${loo.gradNcc ?? 'n/a'}${loo.skipped ? ` (${loo.skipped} panos past the budget)` : ''}`);
                    } catch (err) {
                        if (isAbort(err) || io.signal.aborted) throw err;
                        io.progress(`textures: ${o.layer.layer}: the leave-one-pano-out fit could not be measured (${errorMessage(err)})`);
                    }
                    await new Promise(r => setImmediate(r));
                }
            };
            const value = (status: 'running' | 'committed'): TextureStageValue => {
                const sceneIndex = (id: string) => run.state.layers.findIndex(l => l.objectId === id);
                const ordered = [...outcomes].sort((a, b) => (a.late === b.late ? sceneIndex(a.layer.objectId) - sceneIndex(b.layer.objectId) : a.late ? 1 : -1));
                const layers: TextureLayerBundle[] = ordered.map(o => ({ ...o.out.bundle, maps: { albedo: `${o.url}#albedo` }, confidence: `${o.url}#confidence` }));
                const passDegradations: TexturePassDegradation[] = [...ordered.flatMap(o => o.out.degradations), ...extraDegradations];
                const timingsMs: Record<string, number> = { total: now() - texStarted, ...Object.fromEntries(Object.entries(mainMs).map(([k, v]) => [`step.${k}`, v])), ...Object.fromEntries(Object.entries(lateMs).map(([k, v]) => [`late.${k}`, v])), ...eventLoopStats(loopDelay), ...(texturePool ? { textureWorkers: texturePool.size } : {}) };
                for (const o of ordered) for (const [kk, v] of Object.entries(o.out.timingsMs ?? {})) timingsMs[`${o.layer.layer}.${kk}`] = v;
                const shares = weightedShares(ordered.map(o => ({ shares: o.out.rungShares, texels: o.out.atlasTexels })));
                run.state.texturePass = { status: status === 'committed' ? 'committed' : 'running', layersDone: ordered.length, layersTotal: Math.max(handled.size, ordered.length), rungShares: shares.map(x => round(x, 4)), message: status === 'committed' ? 'textures ready' : 'texturing the later layers' };
                const sv = ordered.filter(o => o.sources === 'street-view').length;
                const record: TexturePassRecord = { passVersion: mode === 'tile-refine' ? TILE_REFINE_TWIN_VERSION : TEXTURE_PASS_VERSION, layers, degradations: passDegradations, timingsMs };
                return {
                    record, shares, views: sv ? (svSrc?.views.length ?? 0) : 0, modelsUsed: [...new Set(ordered.flatMap(o => o.out.modelsUsed ?? []))],
                    layers: ordered.map(o => ({ layer: o.layer.layer, objectId: o.layer.objectId, url: o.url, rungShares: o.out.rungShares, atlasTexels: o.out.atlasTexels, atlas: o.out.atlas, projection: o.out.projection, enhance: o.out.enhance, cached: o.cached })),
                    ...(tileSrc?.prepared.tileUnavailable ? { tileUnavailable: tileSrc.prepared.tileUnavailable } : {}),
                    ...(mode === 'tile-refine' ? { viewsUnavailable: 'a district is textured with the tile photo tile_refine carries onto its remesh; Street View is read for an isolated structure only' } : svWhy ? { viewsUnavailable: svWhy } : {}),
                    ...(mode === 'tile-refine' ? { tileRefine: true } : {})
                };
            };
            let tileSrc: Src | undefined;
            let tileSrcP: Promise<Src> | undefined;
            const getTileSrc = async (signal: AbortSignal): Promise<Src> => (tileSrc = await (tileSrcP ??= tileSource(signal)));
            let svSrc: Src | undefined;
            let svWhy = '';
            /** The Street View pass: ready once its sources are; done once every tile-photo twin taken so far was tried with them. */
            const sv = { ready: false, loopDone: false };
            const refineWithStreetView = async (target: TexTarget, io: StageIO, stage: StageId) => {
                if (!svSrc) return;
                const current = run.state.layers.find(l => l.objectId === target.layer.objectId);
                if (!current || current.retired) return;
                await withSlot(() => textureWith({ ...target, surfaces: fitSurfaces().length && target.late ? fitSurfaces() : target.surfaces }, svSrc!, io, stage));
            };

            texturesPromise = runner.stage<TextureStageValue>({
                id: 'textures',
                run: async io => {
                    const started = now();
                    const step = timed(mainMs);
                    const targets = pick();
                    if (!targets.length) return { status: 'skipped', source: '', reason: 'no committed mesh layer to texture' };
                    for (const t of targets) handled.add(t.layer.objectId);
                    if (mode === 'tile-refine') {
                        await step('tileRefineTwins', () => Promise.all(targets.map(async t => proceduralFillOf(t.layer) ? withSlot(async () => { await textureWith({ ...t, surfaces: [] }, await getTileSrc(io.signal), io, 'textures'); }) : withSlot(() => textureFromRefine(t, 'textures', io)))));
                        textureValue = value('running');
                        return { status: 'committed', value: textureValue, layers: outcomes.map(o => run.state.layers.find(l => l.objectId === o.layer.objectId)!).filter(Boolean), source: `${describeTextures(textureValue)}; the twins of later layers follow as they land`, cached: outcomes.every(o => o.cached), breakdownMs: { ...mainMs, total: now() - started } };
                    }
                    // the first twins: the tile photo alone
                    const first = await step('prepareSources', () => getTileSrc(io.signal));
                    await step('firstLayers', () => Promise.all(targets.map(t => withSlot(() => textureWith(t, first, io, 'textures')))));
                    mainMs.firstTwin = now() - started;
                    // then with the Street View close-ups, where they add texels
                    const got = await step('waitStreetView', () => streetViewSource(io, step));
                    svWhy = got.why;
                    if (got.src) {
                        svSrc = got.src;
                        sv.ready = true;
                        await step('streetViewLayers', async () => {
                            // every layer twinned from the tile photo so far, again until none is left untried (late ones land meanwhile)
                            for (;;) {
                                const todo = outcomes.filter(o => o.sources === 'tile' && !o.streetViewTried);
                                if (!todo.length) break;
                                for (const o of todo) o.streetViewTried = true;
                                await Promise.all(todo.map(o => refineWithStreetView({ layer: run.state.layers.find(l => l.objectId === o.layer.objectId) ?? o.layer, file: path.join(cache.modelsDir, path.basename(o.layer.url)), surfaces: o.late ? fitSurfaces() : undefined, late: o.late }, io, 'textures')));
                            }
                        });
                        await step('looLane', () => looLane(io, started, STAGES.textures.budgetMs));
                    } else io.progress(`textures: no Street View pass (${svWhy}); the twins baked from the tile photo stand`);
                    sv.loopDone = true;
                    textureValue = value('running');
                    return {
                        status: 'committed', value: textureValue, layers: outcomes.filter(o => !o.late).map(o => run.state.layers.find(l => l.objectId === o.layer.objectId)!).filter(Boolean),
                        source: `${describeTextures(textureValue)}; tile-photo twins first, ${svSrc ? 'then Street View where it adds texels' : `no Street View pass (${svWhy})`}`,
                        cached: outcomes.every(o => o.cached), breakdownMs: { ...mainMs, total: now() - started }
                    };
                },
                degrade: async err => {
                    sv.loopDone = true;
                    run.state.texturePass = { status: 'degraded', layersDone: run.state.layers.filter(l => l.textured).length, layersTotal: run.state.layers.filter(l => l.textured).length, message: `the texture pass failed: ${errorMessage(err)}` };
                    return {
                        status: 'degraded', source: 'the layers stay studio grey clay', reason: `the texture pass failed (${errorMessage(err)}); the layers stay clay`,
                        degradations: [run.degrade(record('textures', 'texture_pass_failed', {
                            part: { description: 'the real-world textures of the staged layers' }, intended: 'photo textures (Street View, tile photo) on the staged layers', fellTo: 'studio grey clay',
                            provenanceAfter: rebuildOut.fit ? PROVENANCE.fitted : PROVENANCE.remeshed, reason: `the texture pass failed (${errorMessage(err)}); the layers stay clay`,
                            cause: err, transient: true, runId, now: now(), reuses: ['resolve', 'tiles', 'remesh', 'fit', 'evidence']
                        }))]
                    };
                }
            });
            texturesPromise.catch(() => undefined);
            siblings.push(texturesPromise);

            lateTexturesPromise = runner.stage<TextureStageValue>({
                id: 'textures-late',
                run: async io => {
                    const started = now();
                    const step = timed(lateMs);
                    const lateWork: Array<Promise<unknown>> = [];
                    const textureLate = async (target: TexTarget) => {
                        let t = target;
                        if (proceduralFillOf(t.layer)) {
                            // a procedural district's rebuilt layer: the tile photo (a district reads no Street View), the library under it
                            const src = await getTileSrc(io.signal);
                            await withSlot(() => textureWith({ ...t, surfaces: [] }, src, io, 'textures-late'));
                            return;
                        }
                        if (mode === 'tile-refine') { await withSlot(() => textureFromRefine(t, 'textures-late', io)); return; }
                        // a fitted layer is textured with the fit's charts: they are known once the fit stage has returned (it commits its
                        // layers just before), so the layer is not textured twice
                        await fitDecided.promise;
                        t = { ...t, surfaces: fitSurfaces() };
                        // the first twins' sources (the tile photo) until the Street View ones are ready, then those
                        const src = sv.ready && svSrc ? svSrc : await getTileSrc(io.signal);
                        await withSlot(() => textureWith(t, src, io, 'textures-late'));
                        if (src.kind === 'tile' && sv.ready && sv.loopDone && svSrc) {
                            const o = outcomes.find(x => x.layer.objectId === t.layer.objectId);
                            if (o && !o.streetViewTried) { o.streetViewTried = true; await refineWithStreetView(t, io, 'textures-late'); }
                        }
                    };
                    const takeLate = () => {
                        // the first stage's own targets are not late; it takes them before this stage can (both start together)
                        const late = pick({ late: true });
                        for (const t of late) handled.add(t.layer.objectId);
                        for (const t of late) { const w = textureLate(t); w.catch(() => undefined); lateWork.push(w); }
                    };
                    const onCommit = (layer: StagedLayer) => { if (!layer.textured && !handled.has(layer.objectId)) takeLate(); };
                    run.commitListeners.add(onCommit);
                    try {
                        // the first stage takes the layers standing now; this one everything committed from here on
                        await Promise.resolve();
                        takeLate();
                        await step('waitRebuildGrammar', async () => {
                            await (pass.rebuild ?? Promise.resolve()).catch(() => undefined);
                            if (figuresPromise) await (figuresPromise as Promise<unknown>).catch(() => undefined);
                            if (pass.grammar) await pass.grammar.catch(() => undefined);
                            if (pass.massing) await pass.massing.catch(() => undefined);
                        });
                        run.commitListeners.delete(onCommit);
                        takeLate();
                        // a late layer that could not be textured fails the stage (it degrades to clay, with the reason), after the others settled
                        let lateError: unknown;
                        await step('lateLayers', async () => { for (let i = 0; i < lateWork.length; i++) await lateWork[i].catch(err => { lateError ??= err; }); });
                        if (lateError) throw lateError;
                        // the first stage's Street View pass may still be running on a late layer
                        await (texturesPromise ?? Promise.resolve()).catch(() => undefined);
                        // what the settled scene asks of the layers textured late: a layer another one now hides is not textured (unless
                        // it is the ground); one textured with charts a later refit replaced is textured again
                        const live = run.state.layers.filter(l => !l.retired);
                        const superseded = new Set(live.flatMap(l => l.supersedes));
                        const redo: TexTarget[] = [];
                        for (const o of outcomes.filter(x => x.late)) {
                            const meta = run.layerMeta[o.layer.objectId];
                            const current = run.state.layers.find(l => l.objectId === o.layer.objectId);
                            if (!current || current.retired || (superseded.has(o.layer.objectId) && !meta?.isGround)) {
                                outcomes.splice(outcomes.indexOf(o), 1);
                                looJobs.delete(o.layer.objectId);
                                if (current) { const { textured: _t, ...clay } = current; run.commit(clay, run.layerMeta[current.objectId]); }
                                continue;
                            }
                            if (mode === 'texture-pass' && surfacesKey(fitSurfaces()) !== o.surfaces) redo.push({ layer: current, file: path.join(cache.modelsDir, path.basename(current.url)), surfaces: fitSurfaces(), late: true });
                        }
                        if (redo.length) { const src = svSrc ?? await getTileSrc(io.signal); await step('redo', () => Promise.all(redo.map(t => withSlot(() => textureWith(t, src, io, 'textures-late'))))); }
                        if (mode === 'texture-pass') await step('looLane', () => looLane(io, started, STAGES['textures-late'].budgetMs));
                    } finally {
                        run.commitListeners.delete(onCommit);
                    }
                    if (outcomes.length) textureValue = value('committed');
                    else run.state.texturePass = { status: 'skipped', layersDone: 0, layersTotal: 0, message: 'no layer was textured' };
                    cache.writeRunNote(runId, 'texture_timings', { ...Object.fromEntries(Object.entries(mainMs).map(([k, v]) => [`step.${k}`, v])), ...Object.fromEntries(Object.entries(lateMs).map(([k, v]) => [`late.${k}`, v])) });
                    cache.writeRunNote(runId, 'texture_fit', outcomes.map(o => ({ layer: o.layer.layer, sources: o.sources, fit: o.out.bundle?.fit ?? null, ...(o.out.bundle?.materials ? { materials: o.out.bundle.materials } : {}), sourceSeam: o.out.sourceSeam ?? null, maskedFill: o.out.maskedFill ?? null, inpaint: o.out.inpaint ?? null, lighting: o.out.lighting ?? null, projection: o.out.projection ? { outputSeam: o.out.projection.outputSeam, context: o.out.projection.context, alignment: o.out.projection.alignment && { nccBefore: o.out.projection.alignment.nccBefore, nccAfter: o.out.projection.alignment.nccAfter }, poseRefine: o.out.projection.poseRefine } : null, rungShares: o.out.rungShares, timingsMs: o.out.timingsMs })));
                    const lateLayers = outcomes.filter(o => o.late);
                    return {
                        status: 'committed', ...(textureValue ? { value: textureValue } : {}), layers: lateLayers.map(o => run.state.layers.find(l => l.objectId === o.layer.objectId)!).filter(Boolean),
                        source: lateLayers.length ? `textured ${lateLayers.map(o => o.layer.layer).join(', ')} as they landed (${lateLayers.map(o => o.sources).filter((x, i, a) => a.indexOf(x) === i).join(', ')})` : 'no later layer needed a twin',
                        cached: lateLayers.every(o => o.cached), breakdownMs: { ...lateMs, total: now() - started }
                    };
                },
                degrade: async err => ({
                    status: 'degraded', source: 'the later layers stay studio grey clay', reason: `texturing the later layers failed (${errorMessage(err)})`,
                    degradations: [run.degrade(record('textures-late', 'texture_late_failed', {
                        part: { description: 'the real-world textures of the layers committed after the remesh' }, intended: 'photo textures on every later layer', fellTo: 'studio grey clay on those layers',
                        provenanceAfter: rebuildOut.fit ? PROVENANCE.fitted : PROVENANCE.remeshed, reason: `texturing the later layers failed (${errorMessage(err)})`,
                        cause: err, transient: true, runId, now: now(), reuses: ['resolve', 'tiles', 'remesh', 'fit', 'evidence']
                    }))]
                })
            });
            lateTexturesPromise.catch(() => undefined);
            siblings.push(lateTexturesPromise);
            void Promise.allSettled([texturesPromise, lateTexturesPromise]).then(() => { loopDelay.disable(); texturePool?.close(); });
        };

        if (structure && !deps.textures?.disabled && textureWorkersEnabled() && !eEligible) {
            earlyTexturePool = new TextureWorkerPool();
            earlyTexturePool.warm().catch(() => undefined);
        }

        // ---------------- trees-measure ----------------
        let strip: TileVegetationStripResult | undefined;
        // a single building (pipeline K, isolated) keeps no surroundings: its trees are neither measured nor planted
        const oneBuildingK = pipelineK && isolateMode;
        if (request.trees && request.procedural !== true && !oneBuildingK) {
            // (the structure picked stays as scanned: a tree taken out beside it never takes its roof or walls along)
            const keep = structure && t.ground ? structureKeepCells(structure, t.ground) : undefined;
            const roi: StripRoi | undefined = structure ? { schema: 'scratchbox.strip-roi/1', polygon: grownOutline(structure.outline, ISOLATE_TREE_REACH_M), ...(keep ? { keep } : {}) } : undefined;
            const measured = await runner.stage<TileVegetationStripResult>({
                id: 'trees-measure',
                run: async io => {
                    // the same climate cost plantTrees is given below, so a crown's regrowability check and its final
                    // geometry pick the same species (scratchbox_tree_species.hpp; user report, 2026-10-21).
                    const r = await deps.vegetation.strip({ tilePath: extraction.texturedGlb, signal: io.signal, params: treeSpeciesPlaceParams(run.geoAnchor), ...(roi ? { roi } : {}) });
                    run.keys['trees-measure'] = r.cacheKey;
                    run.cacheStatus['trees-measure'] = r.cached ? 'hit' : 'miss';
                    const removed = Number(r.stats?.triangles?.removed ?? 0);
                    // the caps and skirts that closed the ground carry photo-inferred texels; the pieces with no photographed
                    // neighbour are generated (the tile's mean colour) and said so, one record per kind
                    const degradations: DegradationRecord[] = [];
                    const fill = r.stats?.fill;
                    for (const kind of ['cap', 'skirt'] as const) {
                        const k = fill?.[kind];
                        const generatedArea = Number(k?.generatedAreaM2 ?? 0), pieces = Number(k?.piecesGenerated ?? 0);
                        if (!(fill?.enabled && pieces > 0 && generatedArea > 0.05)) continue;
                        degradations.push(run.degrade(record('trees-measure', 'strip_fill_generated', {
                            part: { description: kind === 'cap' ? 'the ground closed where trees were removed' : 'the walls closed down to the ground where trees were removed' },
                            intended: 'photo-inferred texels from the scan\'s photo of the surface around the piece',
                            fellTo: `the tile's mean colour of such surfaces (generated) on ${pieces} piece${pieces === 1 ? '' : 's'}, ${generatedArea.toFixed(1)} m²`,
                            provenanceAfter: 'generated',
                            reason: `no kept photographed surface facing the same way lies within reach of ${pieces === 1 ? 'this piece' : 'these pieces'}: the scan has nothing to carry a texel from, so the piece is coloured, not sampled`,
                            transient: false, runId, now: now(), suffix: kind
                        })));
                    }
                    return { status: 'committed', value: r, source: `tile_vegetation strip: ${removed.toLocaleString('en-US')} canopy triangles measured as trees and removed`, cached: r.cached, ...(degradations.length ? { degradations } : {}) };
                },
                degrade: async err => ({
                    status: 'degraded', source: 'the scan keeps its trees',
                    reason: `the trees could not be measured: ${errorMessage(err)}`,
                    degradations: [run.degrade(record('trees-measure', 'trees_not_measured', {
                        part: { description: 'the trees in the photo tiles' }, intended: 'trees grown to the measured crown', fellTo: "the scan's own trees, left in the remeshed scan",
                        provenanceAfter: PROVENANCE.remeshed, reason: `the trees could not be measured (${errorMessage(err)}); the scan's own trees remain in the remeshed scan`, cause: err,
                        transient: vegetationTransient(err), runId, now: now(), reuses: ['resolve', 'tiles']
                    }))]
                })
            });
            strip = measured.status === 'committed' ? measured.value : undefined;
        } else {
            runner.skip('trees-measure', request.procedural === true ? PROCEDURAL_ONLY : oneBuildingK ? 'a single building keeps no surroundings, so its trees are not measured' : 'trees were not asked for');
        }

        // ---------------- street residue (street-residue.ts): what the residual audit finds standing in the streets that nothing explains, out of the tree-stripped scan before anything builds on it ----------------
        if (strip && !request.isolate && deps.streetResidue && deps.vectorEvidence && streetResidueEnabled()) {
            const stripped = strip;
            try {
                const covered = extraction.coveredRadiusM;
                const look = t.vector ?? evidenceLookup(await deps.vectorEvidence({ lat: placeValue!.lat, lng: placeValue!.lng, radiusM: covered + 20 }), covered + 20);
                // the fixtures the vehicle step's model read stay, whatever their shape
                const keep = (vehicleReport?.readings ?? []).filter(r => r.permanent && !r.vehicle).map(r => ({ lo: r.lo, hi: r.hi }));
                const key = stageKey(STREET_RESIDUE_VERSION, DISTRICT_AUDIT_VERSION, SURFACE_INFILL_VERSION, stripped.cacheKey, covered.toFixed(1), crypto.createHash('sha256').update(JSON.stringify(keep)).digest('hex').slice(0, 16));
                const entry = await cache.run<{ glb: string | null; report: StreetResidueReport }>('street-residue', key, async dir => {
                    const scan = loadScanMesh(stripped.devegetatedGlb);
                    const ground = buildGroundModel(scan, { cellMeters: 1, water: look.waterAt, road: look.roadAt });
                    const within = (x: number, z: number) => Math.hypot(x, z) <= covered;
                    const audit = await auditDistrict({ scan, ground, buildingAt: look.buildingAt, waterAt: look.waterAt, within, dir: path.join(dir, 'residual_audit'), ...(ctx.signal ? { signal: ctx.signal } : {}), idPrefix: `residue/${key.slice(0, 8)}` });
                    // the carriageways, measured kerb to kerb on the stripped scan: a lump is taken only on one
                    const centrelines = look.raster.roads.filter(l => l.some(([x, z]) => Math.hypot(x, z) <= covered));
                    const roads = centrelines.length ? measureRoadSurfaces({ roads: centrelines, grid: { ...surfaceModel(scan, 0.5), cellM: 0.5 }, within, buildingAt: look.buildingAt, groundAt: ground.groundAt }) : [];
                    const r = await removeStreetResidue({
                        glb: fs.readFileSync(stripped.devegetatedGlb), scan, ground, audit, keep, carriageway: carriagewayLevelAt(roads), look: { buildingAt: look.buildingAt, waterAt: look.waterAt, roadAt: look.roadAt, within },
                        recordsDir: path.join(dir, 'infill'), ...(ctx.signal ? { signal: ctx.signal } : {})
                    });
                    const changed = r.report.floating.triangles > 0 || r.report.lumps.length > 0;
                    if (changed) writeStreetResidue(dir, r);
                    else fs.writeFileSync(path.join(dir, 'street_residue.json'), JSON.stringify(r.report, null, 1));
                    return { value: { glb: changed ? 'street_residue.glb' : null, report: r.report } };
                });
                const rep = entry.value.report;
                cache.writeRunNote(runId, 'street_residue', {
                    key, cached: entry.cached, dir: entry.dir, notes: rep.notes, floating: rep.floating, kept: rep.kept, patch: rep.patch ?? null, ms: rep.ms,
                    lumps: rep.lumps.map(l => ({ id: l.id, kind: l.kind, clusters: l.clusters, lo: l.lo, hi: l.hi, planM2: l.planM2, heightM: l.heightM, real: l.real, infill: l.infill }))
                });
                if (entry.value.glb) {
                    strip = { ...stripped, devegetatedGlb: path.join(entry.dir, entry.value.glb), cacheKey: key };
                    if (rep.lumps.length) run.note('generated', `${rep.notes[0]}: the street under each estimated from the measured scan around it (generated), its texels from the street's own photo by the surface infill`);
                }
            } catch (err) {
                if (isAbort(err) || ctx.signal?.aborted) throw err;
                cache.writeRunNote(runId, 'street_residue', { error: `the street residue could not be taken out (${errorMessage(err)}); the tree-stripped scan is built on as it is` });
            }
        }

        // ---------------- roads (SB-Roadie: Google's road centrelines measured kerb to kerb on the tree-stripped scan; runs beside the remesh) ----------------
        let roadsMeasured: RoadSurface[] | undefined;
        type RoadStageValue = { stats: RoadMesh['stats']; measuredKerbShare: number; photo: { width: number; height: number; texelM: number; ms: number }; markings?: { runs: number; markings: number; dashed: number; solid: number }; kerbs?: KerbModelStats & { triangles: number; footprintM2: number; ms: number } } | undefined;
        // kerbs and gutters as geometry (road-kerbs.ts), the scan carved under them: the surfaces stand at the measured levels
        const kerbsOn = roadKerbsEnabled();
        // steps, stairs and ramps as geometry (ground-steps.ts), the scan carved under them: their own switch
        const stepsOn = groundStepsEnabled(), roadsOn = sbRoadieEnabled() || kerbsOn;
        const roadParams = kerbsOn ? { ...ROAD_SURFACE_PARAMS, liftM: 0 } : ROAD_SURFACE_PARAMS;
        const roadsPromise: Promise<unknown> = (async () => {
            if (request.procedural === true) { runner.skip('roads', PROCEDURAL_ONLY); return; }
            if (kIsolate) { runner.skip('roads', PIPELINE_K_ISOLATE); return; }
            if (!roadsOn && !stepsOn) { runner.skip('roads', 'SB-Roadie is shelved for now (SCRATCHBOX_STAGED_ROADS=1 to try it; SCRATCHBOX_STAGED_ROAD_KERBS=1 with kerbs and gutters as geometry; SCRATCHBOX_STAGED_STEPS=1 for steps and ramps)'); return; }
            const covered = extraction.coveredRadiusM;
            // the vector evidence the sizing fetched (an isolate), else fetched now for the extraction's cover (a district)
            let vector = t.vector;
            if (!vector && deps.vectorEvidence) {
                try { vector = evidenceLookup(await deps.vectorEvidence({ lat: placeValue!.lat, lng: placeValue!.lng, radiusM: covered + 20 }), covered + 20); }
                catch (err) { if (isAbort(err)) throw err; runner.skip('roads', `no Google vector data (${errorMessage(err)})`); return; }
            }
            if (!vector) { runner.skip('roads', t.vectorError ? `no Google vector data (${t.vectorError})` : 'no Google vector data: no service account is configured for vectortiles.featuretiles'); return; }
            const centrelines = vector.raster.roads.filter(l => l.some(([x, z]) => Math.hypot(x, z) <= covered));
            if (!centrelines.length && !stepsOn) { runner.skip('roads', 'no road centreline from Google vector data runs through the extraction'); return; }
            // the footprints the carve cuts under: the kerbed streets' and the steps', carved by one transform once both are known
            const carveTris: FootprintTri[] = [];
            const roadsRun = async (io: StageIO): Promise<StageResult<RoadStageValue>> => {
                    const tileForRoads = strip ? strip.devegetatedGlb : extraction.texturedGlb;
                    const key = stageKey(kerbsOn ? `roads/v5+${ROAD_KERBS_VERSION}` : 'roads/v5', t.key, strip ? strip.cacheKey : 'scan', crypto.createHash('sha256').update(JSON.stringify(centrelines)).digest('hex').slice(0, 16), covered.toFixed(1), roadParams.liftM);
                    run.keys.roads = key;
                    const key8 = key.slice(0, 8);
                    const entry = await cache.run<RoadStageValue>('roads', key, async dir => {
                        io.progress(`measuring ${centrelines.length} street${centrelines.length === 1 ? '' : 's'} kerb to kerb on the ${strip ? 'tree-stripped ' : ''}scan`);
                        // the tree-stripped tile (the trees stage's own output) when the trees were measured: no canopy over the streets
                        const scan = strip ? loadScanMesh(tileForRoads) : t.scan ?? loadScanMesh(extraction.texturedGlb);
                        const grid = { ...surfaceModel(scan, 0.5), cellM: 0.5 };
                        const canopy = !strip && t.canopy ? canopyLookup(t.canopy) : undefined;
                        // the terrain the scan shows (the walkable street surface): a line whose street stands far above it runs under a roof or deck
                        const ground = t.ground ?? buildGroundModel(scan, { cellMeters: 1, ...(canopy ? { exclude: canopy } : {}), water: vector!.waterAt, road: vector!.roadAt });
                        // SB-Veggie comes first: the measured crowns (their stems and mean radii) are kept clear of
                        const avoid = strip ? ((JSON.parse(fs.readFileSync(strip.crownsJson, 'utf8')) as { crowns?: any[] }).crowns ?? [])
                            .filter(c => c.status === 'tree' && Array.isArray(c.stem) && Array.isArray(c.sectorRadii))
                            .map(c => ({ x: Number(c.stem[0]), z: Number(c.stem[1]), radiusM: (c.sectorRadii as number[]).reduce((a, b) => a + b, 0) / 16 })) : [];
                        const roads = measureRoadSurfaces({
                            roads: centrelines, grid, within: (x, z) => Math.hypot(x, z) <= covered, ...(canopy ? { exclude: canopy } : {}), buildingAt: vector!.buildingAt, groundAt: ground.groundAt, avoid
                        }, roadParams);
                        if (!roads.length) return { value: undefined, inputs: { centrelines: centrelines.length, covered, noRoadResurfaced: true } };
                        if (kerbsOn) {
                            // every kerb read again on the scan's own triangles near the streets, swept with its gutter, joined at the crossings
                            const t0 = Date.now();
                            io.progress(`reading ${roads.length} street${roads.length === 1 ? '' : 's'}' kerbs on the scan's triangles`);
                            const near = nearStreets(roads, roadParams.maxHalfWidthM + 6);
                            const h = scanHeightIndex(scan, 1, tri => near(scan.triCentroid[tri * 3], scan.triCentroid[tri * 3 + 2]));
                            const model = measureKerbs(roads, h, roadParams);
                            // coloured by the tile photo itself seen from above (planar texture coordinates): the new surfaces continue the
                            // scan's own photo at the carve's rim, crossings and markings included
                            const mesh = buildKerbedRoadMesh(model);
                            const stations = roads.reduce((n, r) => n + r.stations.length, 0);
                            const measuredKerbShare = stations ? roads.reduce((n, r) => n + r.measuredKerbShare * r.stations.length, 0) / stations : 0;
                            io.progress(`colouring ${mesh.stats.samples} street samples from the tile photo seen from above`);
                            const photo = renderTopDownPhoto(fs.readFileSync(tileForRoads), mesh.uvFrame, { texelM: 0.1, maxPx: 4096, referenceY: (mesh.minY + mesh.maxY) / 2 });
                            const kerbs = { ...model.stats, triangles: mesh.stats.triangles, footprintM2: mesh.stats.footprintM2, ms: Date.now() - t0 };
                            // the legacy stats the layer's note and the tool read, from the same streets
                            const legacy = buildRoadMesh(roads, roadParams).stats;
                            writeKerbedRoadsGlb(path.join(dir, 'roads.glb'), mesh, {
                                stats: legacy, kerbs, measuredKerbShare, liftM: 0,
                                source: 'SB-Roadie with kerbs and gutters as geometry: Google vector road centrelines; kerbs, levels and camber measured on the tree-stripped photo tiles, each kerb read again on the scan\'s triangles; coloured by the tile photo seen from above'
                            }, { jpeg: topDownJpeg(photo, 90), width: photo.width, height: photo.height });
                            fs.writeFileSync(path.join(dir, 'roads.json'), JSON.stringify({ schema: 'scratchbox.road-surfaces/1', roads }));
                            fs.writeFileSync(path.join(dir, 'kerbs.json'), JSON.stringify({ schema: 'scratchbox.road-kerbs/1', model }));
                            fs.writeFileSync(path.join(dir, 'footprint.bin'), Buffer.from(Float64Array.from(mesh.footprint.flat()).buffer));
                            return { value: { stats: { ...legacy, triangles: mesh.stats.triangles }, measuredKerbShare, photo: { width: photo.width, height: photo.height, texelM: photo.texelM, ms: photo.ms }, kerbs }, inputs: { centrelines: centrelines.length, covered, tile: path.basename(tileForRoads), kerbs: ROAD_KERBS_VERSION } };
                        }
                        const planar = buildRoadMesh(roads);
                        const stations = roads.reduce((n, r) => n + r.stations.length, 0);
                        const measuredKerbShare = stations ? roads.reduce((n, r) => n + r.measuredKerbShare * r.stations.length, 0) / stations : 0;
                        io.progress(`reading the road surfaces from the tile photo over ${planar.stats.stations} stations`);
                        const photo = renderTopDownPhoto(fs.readFileSync(tileForRoads), planar.uvFrame, { texelM: 0.1, maxPx: 4096 });
                        // the surfaces redrawn: tarmac and markings read along each street (cars and shadows do not repeat), lines redrawn crisp
                        const atlas = synthesizeRoadTextures(roads, photo, planar.uvFrame);
                        const mesh = buildRoadMesh(roads, ROAD_SURFACE_PARAMS, atlas);
                        const jpeg = jpegJs.encode({ data: Buffer.from(atlas.rgba.buffer, atlas.rgba.byteOffset, atlas.rgba.byteLength), width: atlas.width, height: atlas.height }, 90).data;
                        writeRoadsGlb(path.join(dir, 'roads.glb'), mesh, {
                            stats: mesh.stats, measuredKerbShare, liftM: ROAD_SURFACE_PARAMS.liftM, markings: atlas.stats,
                            source: 'SB-Roadie: Google vector road centrelines; kerbs, levels and camber measured on the tree-stripped photo tiles; tarmac and lane markings read along each street from the tile photo and redrawn'
                        }, { jpeg: Buffer.from(jpeg), width: atlas.width, height: atlas.height });
                        fs.writeFileSync(path.join(dir, 'roads.json'), JSON.stringify({ schema: 'scratchbox.road-surfaces/1', roads }));
                        return { value: { stats: mesh.stats, measuredKerbShare, photo: { width: atlas.width, height: atlas.height, texelM: photo.texelM, ms: photo.ms }, markings: atlas.stats }, inputs: { centrelines: centrelines.length, covered, tile: path.basename(tileForRoads) } };
                    }, { publish: (dir, value) => (value ? [{ from: 'roads.glb', as: `${base}_roads_${key8}.glb` }] : []), bypass: bypass('roads') });
                    run.cacheStatus.roads = entry.cached ? 'hit' : 'miss';
                    if (!entry.value) {
                        return { status: 'skipped', source: '', reason: `none of the ${centrelines.length} streets had both kerbs measured on the scan over ${ROAD_SURFACE_PARAMS.minRunLengthM} m, so nothing was resurfaced` };
                    }
                    roadsMeasured = (JSON.parse(fs.readFileSync(path.join(entry.dir, 'roads.json'), 'utf8')) as { roads: RoadSurface[] }).roads;
                    const pub = entry.published[0];
                    const v = entry.value;
                    if (kerbsOn && v.kerbs) return commitKerbedRoads(v, entry, pub, key, key8);
                    const measured = v.measuredKerbShare >= 0.5;
                    const layer: StagedLayer = {
                        objectId: layerObjectId(key, 'l1r'), stage: 'roads', layer: 'l1r', order: STAGES.roads.order, url: pub.url, bytes: pub.bytes,
                        provenance: {
                            label: measured ? 'measured' : VECTOR_MODELLED_LABEL, measuredGeometry: measured, confidence: v.measuredKerbShare,
                            method: 'SB-Roadie: ribbons swept along Google vector road centrelines through levels read low on the tree-stripped photo tiles at stations every 2 m; kerbs where the scan steps up (a default half-width where none shows); the tarmac colour and the lane markings read along each street from the tile photo (what repeats along the road) and redrawn',
                            sources: [{ kind: 'vector-tiles', id: `roads:${key8}` }, { kind: 'tile-extraction', id: `extract:${t.key.slice(0, 8)}` }],
                            note: `${v.stats.roads} street runs, ${v.stats.stations} stations; ${v.stats.measuredKerbs} kerbs measured, ${v.stats.defaultKerbs} defaulted; ${v.stats.medians} median stations; ${Math.round(v.stats.sidewalkM)} m of sidewalk; ${Object.values(v.stats.droppedStations).reduce((a, b) => a + b, 0)} stations left out (${v.stats.droppedStations.noKerb} without both kerbs measured, ${v.stats.droppedStations.underTree} under a measured tree, ${v.stats.droppedStations.noSurface} no street surface near the line, ${v.stats.droppedStations.aboveGround} under a roof or deck, ${v.stats.droppedStations.uneven} uneven); ${v.markings ? `${v.markings.markings} lane markings read and redrawn (${v.markings.solid} solid, ${v.markings.dashed} dashed); ` : ''}stands ${ROAD_SURFACE_PARAMS.liftM} m above the scan`
                        },
                        provenanceLabels: measured ? ['measured', VECTOR_MODELLED_LABEL] : [VECTOR_MODELLED_LABEL], supersedes: [], revealAfter: [],
                        reveal: { durationMs: 1500, stagger: 0.3, crossfadeFrom: [] },
                        cached: entry.cached, builtAtMs: entry.builtAtMs, counts: layerCounts(pub.path)
                    };
                    run.commit(layer, { source: 'GoogleVectorRoads', resolvedAddress: placeValue!.formattedAddress, extra: { selfTextured: true, roads: v.stats.roads, measuredKerbShare: v.measuredKerbShare, photo: v.photo } });
                    return { status: 'committed', source: `${v.stats.roads} streets measured kerb to kerb (${Math.round(100 * v.measuredKerbShare)} % of kerbs found), textured from the tile photo`, layers: [layer], cached: entry.cached };
            };
            await runner.stage<RoadStageValue>({
                id: 'roads',
                // the kerbs are read again on the scan's triangles and coloured from above: 2-5 minutes more over a 200 m district;
                // the steps are found and read on it, their melted flights counted on Street View
                ...(kerbsOn || stepsOn ? { budgetMs: STAGES.roads.budgetMs + (kerbsOn ? ROAD_KERBS_EXTRA_BUDGET_MS : 0) + (stepsOn ? GROUND_STEPS_EXTRA_BUDGET_MS : 0) } : {}),
                run: async io => {
                    const r = roadsOn && centrelines.length ? await roadsRun(io) : undefined;
                    const st = stepsOn ? await stepsRun(io) : undefined;
                    // the scan carved under every new surface at once (a carved file is not carved again)
                    if (carveTris.length) installCarve(io);
                    if (!st) return r!;
                    if (!r || r.status !== 'committed') {
                        if (st.status === 'committed') return { ...st, source: r?.status === 'skipped' && r.reason ? `${st.source}; streets: ${r.reason}` : st.source };
                        return { status: 'skipped', source: '', reason: [r?.status === 'skipped' ? r.reason : roadsOn ? undefined : 'the streets are off', st.status === 'skipped' ? st.reason : undefined].filter(Boolean).join('; ') };
                    }
                    if (st.status !== 'committed') return { ...r, source: `${r.source}; steps: ${st.status === 'skipped' ? st.reason : st.status}` };
                    return { ...r, source: `${r.source}; ${st.source}`, layers: [...(r.layers ?? []), ...(st.layers ?? [])] };
                }
            }).catch(err => {
                if (err?.name === 'AbortError') throw err;
                run.emit('roads', 'failed', { reason: errorMessage(err) });
                return undefined;
            });
            // the new surfaces coloured again from the ground's textured twin once it is in: its de-lit photo, seen from above, is
            // what the ground around them shows (the tile photo they were first coloured with is darker), so they meet it without a
            // seam of colour; the twin they read is the one before the carve, which still has the ground under them
            // only this build's own: in a chunked district a joined chunk's streets come coloured by their own build, and a joined
            // or seam-cut ground covers its own cell only
            const own = (l: StagedLayer) => (run.layerMeta[l.objectId]?.extra as { chunk?: number } | undefined)?.chunk === undefined;
            const ownSurfaces = () => run.state.layers.filter(x => !x.retired && x.stage === 'roads' && (x.layer === 'l1r' || x.layer === 'l1s') && own(x));
            if ((kerbsOn || stepsOn) && ownSurfaces().length) {
                const seen = new Set<string>(), records: Array<{ layer: string; twin: string; ms: number; cached: boolean } | { layer: string; twin: string; failed: string }> = [];
                const recolour = (ground: StagedLayer) => {
                    const meta = run.layerMeta[ground.objectId];
                    if (!(ground.layer === 'l2' || meta?.isGround) || !ground.textured?.url || meta?.vegetation || !own(ground) || !(ground.stage === 'remesh' || ground.stage === 'tiles')) return;
                    const twin = path.join(cache.modelsDir, path.basename(ground.textured.url).replace(/_road_[0-9a-f]{8}(?=\.glb$)/, ''));
                    if (seen.has(twin) || !fs.existsSync(twin)) return;
                    seen.add(twin);
                    const tag = crypto.createHash('sha256').update(path.basename(twin)).digest('hex').slice(0, 8);
                    for (const l of ownSurfaces()) {
                        try {
                            const r = recolourFromTwin(cache, l, twin, tag);
                            if (!r) continue;
                            records.push({ layer: l.layer, twin: path.basename(twin), ms: r.ms, cached: r.cached });
                            const why = `coloured again from the ground's textured twin seen from above (its de-lit photo), so it meets the ground around it without a seam of colour`;
                            run.commit({ ...l, url: r.url, bytes: r.bytes, provenance: { ...l.provenance, ...(l.provenance.note?.includes(why) ? {} : { note: l.provenance.note ? `${l.provenance.note}; ${why}` : why }) } }, run.layerMeta[l.objectId]);
                        } catch (err) {
                            if (isAbort(err)) throw err;
                            records.push({ layer: l.layer, twin: path.basename(twin), failed: errorMessage(err) });
                        }
                    }
                    cache.writeRunNote(runId, 'road_recolour', { records });
                };
                for (const l of run.state.layers.filter(x => !x.retired)) recolour(l);
                run.commitListeners.add(recolour);
            }
            // the kerbed streets' layer, and the scan carved under them from here on (the ground already standing carved now)
            function commitKerbedRoads(v: NonNullable<RoadStageValue>, entry: { dir: string; cached: boolean; builtAtMs: number }, pub: { url: string; bytes: number; path: string }, key: string, key8: string) {
                const k = v.kerbs!;
                const raw = fs.readFileSync(path.join(entry.dir, 'footprint.bin'));
                const flat = new Float64Array(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength));
                const tris: FootprintTri[] = [];
                for (let i = 0; i + 9 <= flat.length; i += 9) tris.push(Array.from(flat.subarray(i, i + 9)) as FootprintTri);
                const kerbNote = `${v.stats.roads} street runs, ${v.stats.stations} stations; kerb line ${k.measuredM} m measured, ${k.drawnM} m drawn (${k.fineM} m read on the scan's triangles, ${k.softM} m of it a step the scan smears, drawn at its half-rise crossing; ${k.coarseM} m at SB-Roadie's step; ${k.betweenM} m carried along the line, through ramps and past single samples where an object stands on the kerb); ${k.notDrawnM} m of kerb line with no kerb measured, nothing drawn there; ${k.rampM} m of ramps where the face drops to the road; ${k.corners.drawn} corners on their measured radius (median ${k.corners.radiusP50M ?? '-'} m), ${k.corners.notDrawn} not drawn; ${k.straightJoins.drawn} straight joins across gaps; faces ${k.faceP10M ?? '-'} / ${k.faceP50M ?? '-'} / ${k.faceP90M ?? '-'} m (10th / 50th / 90th percentile); gutters ${k.gutterMeasuredM} m measured, ${k.gutterGeneratedM} m generated (the scan resolves no dip at the face's foot); nosings (a 1 cm chamfer: 1.5 % of the kerb's smallest dimension, 1-5 cm) and kerb tops (0.15 m) generated; the surfaces stand at the measured levels with the scan carved under them`;
                const layer: StagedLayer = {
                    objectId: layerObjectId(key, 'l1r'), stage: 'roads', layer: 'l1r', order: STAGES.roads.order, url: pub.url, bytes: pub.bytes,
                    provenance: {
                        label: 'measured', measuredGeometry: true, confidence: v.measuredKerbShare,
                        method: 'SB-Roadie with kerbs and gutters as geometry (road-kerbs.ts): one profile swept along each Google vector road centreline through the levels and camber read low on the tree-stripped photo tiles; each kerb read again across its line on the scan\'s triangles (its face, its rise, a gutter\'s dip, a ramp), the kerbs joined around corners on the radius rays across them measure, the carriageway only between two measured kerbs; coloured by the tile photo seen from above (its own texels)',
                        sources: [{ kind: 'vector-tiles', id: `roads:${key8}` }, { kind: 'tile-extraction', id: `extract:${t.key.slice(0, 8)}` }],
                        note: kerbNote
                    },
                    provenanceLabels: ['measured', 'generated'], supersedes: [], revealAfter: [],
                    reveal: { durationMs: 1500, stagger: 0.3, crossfadeFrom: [] },
                    cached: entry.cached, builtAtMs: entry.builtAtMs, counts: layerCounts(pub.path)
                };
                run.commit(layer, { source: 'GoogleVectorRoads', resolvedAddress: placeValue!.formattedAddress, extra: { selfTextured: true, roads: v.stats.roads, measuredKerbShare: v.measuredKerbShare, photo: v.photo, kerbs: k } });
                carveTris.push(...tris);
                return { status: 'committed' as const, source: `${v.stats.roads} streets with kerbs and gutters: ${k.drawnM} m of kerb drawn of ${k.measuredM} m measured, ${k.corners.drawn} corners; the scan carved under them`, layers: [layer], cached: entry.cached };
            }
            // the scan carved under every new surface (the kerbed streets', the steps'): one transform on the ground layers from here
            // on, and the ground already standing committed again, carved
            function installCarve(io: StageIO) {
                const records: RoadCarveRecord[] = [];
                const key8 = crypto.createHash('sha256').update(Buffer.from(Float64Array.from(carveTris.flat()).buffer)).digest('hex').slice(0, 8);
                io.progress(`carving the scan under ${carveTris.length.toLocaleString('en-US')} footprint triangles of new surfaces`);
                run.layerTransform = chainLayerTransforms(run.layerTransform, roadCarver(cache, roadsMeasured ?? [], prepareFootprint(carveTris), key8, vector!.buildingAt, records));
                const t0 = now();
                for (const l of run.state.layers.filter(x => !x.retired && x.stage !== 'roads')) {
                    const meta = run.layerMeta[l.objectId];
                    if (meta && (l.layer === 'l2' || meta.isGround)) run.commit({ ...l }, meta);
                }
                const note = () => ({ version: ROAD_CARVE_VERSION, flatten: roadFlattenEnabled() ? ROAD_FLATTEN_VERSION : 'off', footprintTriangles: carveTris.length, layers: records });
                cache.writeRunNote(runId, 'road_carve', { ...note(), atRoadsMs: now() - t0 });
                // later carves (the twin, a ground committed after the roads) are recorded as they happen
                run.commitListeners.add(() => { if (records.length) cache.writeRunNote(runId, 'road_carve', note()); });
            }
            // steps, stairs and ramps the scan melted (ground-steps.ts): found on the scan, counted on Street View where the scan cannot
            // tell the steps apart, rebuilt by the step replicated at its pitch, their layer l1s
            async function stepsRun(io: StageIO): Promise<StageResult<RoadStageValue>> {
                const tileForSteps = strip ? strip.devegetatedGlb : extraction.texturedGlb;
                const visionClient = deps.vision && 'client' in deps.vision ? deps.vision : undefined;
                const counterReady = !!(streetView?.grounding && visionClient);
                const counterWhy = counterReady ? 'Street View' : `no Street View count (${!streetView?.grounding ? missingCredentials(streetView ?? {}) ?? 'no grounding service' : 'no vision model is configured'})`;
                const key = stageKey(GROUND_STEPS_VERSION, t.key, strip ? strip.cacheKey : 'scan', covered.toFixed(1), counterReady ? 'streetview' : 'estimate');
                // the stage's key is the streets' when they ran, else the steps'
                run.keys.roads ??= key;
                const key8 = key.slice(0, 8);
                type StepsValue = { stats: ReturnType<typeof buildStepsMesh>['stats']; flights: Array<Pick<FlightModel, 'id' | 'kind' | 'count' | 'riseM' | 'runEachM' | 'countSource' | 'countNote' | 'slope'> & { totalRiseM: number; lengthM: number; widthM: number; landings: number }>; inclines: number; refused: number } | undefined;
                const entry = await cache.run<StepsValue>('roads', key, async dir => {
                    io.progress(`looking for steps and ramps on the ${strip ? 'tree-stripped ' : ''}scan`);
                    const scan = strip ? loadScanMesh(tileForSteps) : t.scan ?? loadScanMesh(extraction.texturedGlb);
                    const ground = t.ground ?? buildGroundModel(scan, { cellMeters: 1, water: vector!.waterAt, road: vector!.roadAt });
                    const h = scanHeightIndex(scan, 1);
                    const counter = counterReady ? streetViewStepCounter({
                        origin: { lat: placeValue!.lat, lng: placeValue!.lng, heightMeters: extraction.originEllipsoidalHeightM },
                        streetView: { ...streetView!, metadataCachePath: path.join(cache.dir, 'streetview', 'metadata.json') }, vision: visionClient!,
                        groundAt: ground.groundAt, signal: io.signal, chainExtras: chainExtras('roads'), onProgress: m => io.progress(m)
                    }) : undefined;
                    const found = await measureSteps(scan, h, { groundAt: ground.groundAt, exclude: (x, z) => Math.hypot(x, z) > covered || vector!.roadAt(x, z), ...(counter ? { counter } : {}) });
                    const inputs = { tile: path.basename(tileForSteps), covered, counter: counterWhy };
                    if (!found.flights.length) return { value: { stats: { flights: 0, ramps: 0, steps: 0, triangles: 0, footprintM2: 0 }, flights: [], inclines: found.inclines, refused: found.refused.length }, inputs };
                    // coloured by the tile photo seen from above (planar), 5 cm a texel, over the flights and a margin
                    let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
                    for (const f of found.flights) for (const [sv, bv] of [[f.sFoot - 1, f.bMin - 1], [f.sFoot - 1, f.bMax + 1], [f.sTop + 1, f.bMin - 1], [f.sTop + 1, f.bMax + 1]]) {
                        const x = f.cx + f.ux * sv + f.vx * bv, z = f.cz + f.uz * sv + f.vz * bv;
                        x0 = Math.min(x0, x); x1 = Math.max(x1, x); z0 = Math.min(z0, z); z1 = Math.max(z1, z);
                    }
                    const uvFrame = { x0, z0, widthM: Math.max(1, x1 - x0), heightM: Math.max(1, z1 - z0) };
                    const photo = renderTopDownPhoto(fs.readFileSync(tileForSteps), uvFrame, { texelM: 0.05, maxPx: 4096, referenceY: found.flights.reduce((t, f) => t + (f.footY + f.topY) / 2, 0) / found.flights.length });
                    const mesh = buildStepsMesh(found.flights, undefined, uvFrame);
                    const flights = found.flights.map(f => ({ id: f.id, kind: f.kind, slope: f.slope, totalRiseM: f.topY - f.footY, lengthM: f.sTop - f.sFoot, widthM: f.bMax - f.bMin, landings: f.landings.length, ...(f.count !== undefined ? { count: f.count, riseM: f.riseM, runEachM: f.runEachM, countSource: f.countSource, countNote: f.countNote } : {}) }));
                    writeStepsGlb(path.join(dir, 'steps.glb'), mesh, { stats: mesh.stats, flights }, { jpeg: topDownJpeg(photo, 90), width: photo.width, height: photo.height });
                    fs.writeFileSync(path.join(dir, 'steps.json'), JSON.stringify({ schema: 'scratchbox.ground-steps/1', flights: found.flights, refused: found.refused, inclines: found.inclines }));
                    fs.writeFileSync(path.join(dir, 'steps_footprint.bin'), Buffer.from(Float64Array.from(mesh.footprint.flat()).buffer));
                    return { value: { stats: mesh.stats, flights, inclines: found.inclines, refused: found.refused.length }, inputs };
                }, { publish: (dir, value) => (value?.flights.length ? [{ from: 'steps.glb', as: `${base}_steps_${key8}.glb` }] : []), bypass: bypass('roads') });
                const v = entry.value;
                cache.writeRunNote(runId, 'ground_steps', { version: GROUND_STEPS_VERSION, key, cached: entry.cached, counter: counterWhy, ...(v ?? {}) });
                if (!v?.flights.length) return { status: 'skipped', source: '', reason: `no steps or ramps found on the scan (${v?.inclines ?? 0} incline${v?.inclines === 1 ? '' : 's'} looked at, ${v?.refused ?? 0} not a flight)` };
                const raw = fs.readFileSync(path.join(entry.dir, 'steps_footprint.bin'));
                const flat = new Float64Array(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength));
                for (let i = 0; i + 9 <= flat.length; i += 9) carveTris.push(Array.from(flat.subarray(i, i + 9)) as FootprintTri);
                const pub = entry.published[0];
                const sources = [...new Set(v.flights.map(f => f.countSource).filter((x): x is NonNullable<typeof x> => !!x))];
                const flightsNote = v.flights.map(f => f.kind === 'ramp'
                    ? `a ramp rising ${f.totalRiseM.toFixed(2)} m over ${f.lengthM.toFixed(1)} m (1:${(1 / f.slope).toFixed(0)}), ${f.widthM.toFixed(1)} m wide`
                    : `a flight of ${f.count} steps rising ${f.totalRiseM.toFixed(2)} m over ${f.lengthM.toFixed(1)} m, ${f.widthM.toFixed(1)} m wide: ${((f.riseM ?? 0) * 100).toFixed(1)} cm rise, ${((f.runEachM ?? 0) * 100).toFixed(1)} cm run (${f.countSource}: ${f.countNote})${f.landings ? `, ${f.landings} landing${f.landings === 1 ? '' : 's'}` : ''}`).join('; ');
                const layer: StagedLayer = {
                    objectId: layerObjectId(key, 'l1s'), stage: 'roads', layer: 'l1s', order: STAGES.roads.order, url: pub.url, bytes: pub.bytes,
                    provenance: {
                        label: 'measured', measuredGeometry: true,
                        method: 'Steps and ramps as geometry (ground-steps.ts): inclines found on the scan, their extent, levels, slope and landings read on its triangles; each flight one step profile replicated at its pitch (the scan\'s, else the count Street View gives, else an estimated rise), each ramp a plane through its slope; nosings by the bevel rule and the sides generated; coloured by the tile photo seen from above',
                        sources: [{ kind: 'tile-extraction', id: `extract:${t.key.slice(0, 8)}` }, ...(sources.includes('photo-inferred') ? [{ kind: 'streetview-grounding' as const, id: `steps:${key8}` }] : [])],
                        note: `${v.stats.flights} flight${v.stats.flights === 1 ? '' : 's'} (${v.stats.steps} steps), ${v.stats.ramps} ramp${v.stats.ramps === 1 ? '' : 's'}: ${flightsNote}; the scan carved under them`
                    },
                    provenanceLabels: ['measured', ...sources.filter(x => x !== 'measured'), ...(sources.includes('generated') ? [] : ['generated' as const])], supersedes: [], revealAfter: [],
                    reveal: { durationMs: 1200, stagger: 0.2, crossfadeFrom: [] },
                    cached: entry.cached, builtAtMs: entry.builtAtMs, counts: layerCounts(pub.path)
                };
                run.commit(layer, { source: 'Google3DTilesSteps', resolvedAddress: placeValue!.formattedAddress, extra: { selfTextured: true, steps: v.stats } });
                return { status: 'committed', source: `${v.stats.flights} flight${v.stats.flights === 1 ? '' : 's'} of steps and ${v.stats.ramps} ramp${v.stats.ramps === 1 ? '' : 's'} rebuilt from the scan`, layers: [layer], cached: entry.cached };
            }
        })();
        siblings.push(roadsPromise);

        // ---------------- the district's scene inventory (scene-inventory.ts, with the street audit: labels, a run note and the object catalog; the build unchanged) ----------------
        if (!request.isolate && strip && deps.vectorEvidence) {
            const stripped = strip;
            siblings.push((async () => {
                const covered = extraction.coveredRadiusM;
                try {
                    const ev = await deps.vectorEvidence!({ lat: placeValue!.lat, lng: placeValue!.lng, radiusM: covered + 20 });
                    const look = evidenceLookup(ev, covered + 20);
                    const vectorKey = crypto.createHash('sha256').update(JSON.stringify([ev.buildings.map(b => [b.id, b.parts, b.heightM ?? null]), ev.water, ev.roads, ev.rails ?? []])).digest('hex').slice(0, 16);
                    const key = stageKey(SCENE_INVENTORY_VERSION, DISTRICT_AUDIT_VERSION, stripped.cacheKey, vectorKey, covered.toFixed(1));
                    type InventoryValue = { inventory: SceneInventorySummary; street: DistrictStreetAuditSummary };
                    const entry = await cache.run<InventoryValue>('scene-inventory', key, async dir => {
                        const scan = loadScanMesh(stripped.devegetatedGlb);
                        const ground = buildGroundModel(scan, { cellMeters: 1, water: look.waterAt, road: look.roadAt });
                        const within = (x: number, z: number) => Math.hypot(x, z) <= covered;
                        const audit = await auditDistrict({
                            scan, ground, buildingAt: look.buildingAt, waterAt: look.waterAt, within, rails: ev.rails ?? [], roads: ev.roads,
                            dir: path.join(dir, 'residual_audit'), ...(ctx.signal ? { signal: ctx.signal } : {}), idPrefix: `district/${key.slice(0, 8)}`
                        });
                        fs.writeFileSync(path.join(dir, 'district_audit.json'), JSON.stringify(audit));
                        const crownsInFile = (JSON.parse(fs.readFileSync(stripped.crownsJson, 'utf8')) as { crowns?: InventoryCrown[] }).crowns ?? [];
                        const crowns = crownsInFile.filter(c => Array.isArray(c.stem) && Array.isArray(c.sectorRadii) && Array.isArray(c.apex));
                        const inventory = buildSceneInventory({
                            vector: ev, look, ground, within, audit, crowns, crownsInFile: crownsInFile.length,
                            sourceIds: { extraction: `extract:${t.key.slice(0, 8)}`, vector: `vectortiles:${vectorKey.slice(0, 8)}`, trees: `strip:${stripped.cacheKey.slice(0, 8)}`, audit: `audit:${key.slice(0, 8)}` }
                        });
                        fs.writeFileSync(path.join(dir, 'scene_inventory.json'), JSON.stringify(inventory));
                        return { value: { inventory: sceneInventorySummary(inventory), street: districtStreetAuditSummary(audit) } };
                    });
                    const { inventory, street } = entry.value;
                    cache.writeRunNote(runId, 'scene_inventory', {
                        key, cached: entry.cached, file: path.join(entry.dir, 'scene_inventory.json'), audit: path.join(entry.dir, 'district_audit.json'),
                        counts: inventory.counts, outsideExtraction: inventory.outsideExtraction, checks: inventory.checks,
                        street: { counts: street.counts, notes: street.notes, split: street.split, rails: street.rails, uprights: street.uprights, reassessed: street.reassessed, ms: street.ms }
                    });
                    const geoOrigin: GeodeticOrigin = { lat: run.geoAnchor.lat, lng: run.geoAnchor.lng, heightMeters: run.geoAnchor.elevation ?? 0 };
                    const toCatalog = (c: { type: string; label: string; confidence: number; lo: [number, number, number]; hi: [number, number, number] }, source: string) => {
                        const lo = scanToGeodetic(geoOrigin, c.lo[0], c.lo[1], c.lo[2]), hi = scanToGeodetic(geoOrigin, c.hi[0], c.hi[1], c.hi[2]);
                        const centre = scanToGeodetic(geoOrigin, (c.lo[0] + c.hi[0]) / 2, (c.lo[1] + c.hi[1]) / 2, (c.lo[2] + c.hi[2]) / 2);
                        return {
                            type: c.type, label: c.label, confidence: c.confidence, lat: centre.lat, lng: centre.lng,
                            bboxLo: { lat: Math.min(lo.lat, hi.lat), lng: Math.min(lo.lng, hi.lng), alt: lo.alt }, bboxHi: { lat: Math.max(lo.lat, hi.lat), lng: Math.max(lo.lng, hi.lng), alt: hi.alt },
                            source, runId
                        };
                    };
                    recordDiscoveredObjects([
                        ...inventory.buildings.map(b => toCatalog({ type: b.type, label: b.description, confidence: b.confidence, lo: b.lo, hi: b.hi }, 'scene-inventory')),
                        ...street.catalog.map(c => toCatalog({ type: c.type, label: c.reason, confidence: c.confidence, lo: c.lo, hi: c.hi }, 'district-residual-audit'))
                    ]);
                } catch (err) {
                    if (isAbort(err) || ctx.signal?.aborted) return;
                    cache.writeRunNote(runId, 'scene_inventory', { error: `the scene inventory could not be built (${errorMessage(err)}); the build is unchanged, its streets unlabelled` });
                }
            })());
        }

        // ---------------- remesh ----------------
        // facade grammar: on by flag, with a vision model, on a relief that runs
        const grammarOn = facadeGrammarEnabled() && !!visionAvailable && (request.relief ?? TILE_REFINE_RELIEF_DEFAULT) !== false;
        let remeshRequest: TileRefineRequest | undefined;
        type RemeshValue = { refined?: TileRefineResult; flattened?: ScanFitFlattenResult; groundLayerId: string; groundFile: string; committed: boolean };
        /**
         * What pipeline J (iRun) and its specular pass actually need: the isolated scan, a layer id to supersede, and a
         * cache key. `stage` (pipeline E's vector massing) is optional: iRun only reads it for its own optional refine
         * step (pipelineIRefineEnabled), so pipeline J can run on the plain remeshed scan too, when pipeline E's massing
         * did not pass the scan-agreement gate (user decision, 2026-10-24: default to generative facades there rather
         * than none at all — see grammarRun's `!eState` branch).
         */
        type IRunState = { refined: TileRefineResult; layer: { objectId: string }; key: string; stage?: MassingStageResult };
        let eState: { stage: MassingStageResult; refined: TileRefineResult; layer: StagedLayer; key: string; ms: number } | undefined;
        /** The ownership vote to run after the first isolate commits: what it needs to remesh the same structure again. */
        let voteLater: { tilePath: string; isolatePick?: string; pick?: { pick: StructurePickResult; ground: GroundModel }; request: TileRefineRequest; orthos: { reliefOrthos?: boolean; reliefCarve?: boolean; reliefAnalyse?: boolean } } | undefined;
        /** The residual audit of one pipeline E native run, into the build notes (and a degradation when it failed or left clusters unsure). */
        /** The footprint lock's check of a built layer against the footprint its massing stood on: recorded, and a breach
         * degraded -- unless `opts.clamp`, where a breach is first re-fit (pulled back onto the footprint, same vertices
         * pulled in its textured twin) and only still degraded if vertices remain beyond the limit after that. */
        const checkFootprintLock = (stage: StageId, layerName: string, files: { clayGlb: string; texturedGlb?: string }, parts: Array<{ loops: Array<Array<[number, number]>>; provenance?: string }>, opts: { clamp?: boolean } = {}): { say: string; files: { clayGlb: string; texturedGlb?: string } } => {
            const loops = parts.flatMap(p => p.loops);
            if (!loops.length) return { say: 'footprint lock: no footprint to check against', files };
            let c = footprintConformance(readTileTriangles(fs.readFileSync(files.clayGlb)).positions, loops);
            // a footprint that is the scan's own plan (no Google footprint: scanDerivedFootprint, a simplified outline of the
            // structure) is coarser than the walls built on it: the Flatiron's rounded prow stood 5 m past its 11-corner plan.
            // Its breach is recorded, not degraded (a scan-led build; the lock proper needs a footprint that is not the scan itself)
            const scanPlan = parts.length > 0 && parts.every(p => p.provenance === SCAN_FOOTPRINT_TOKEN);
            let outFiles = files, fitNote = '';
            if (!c.ok && !scanPlan && opts.clamp) {
                const clayBytes = fs.readFileSync(files.clayGlb);
                const texBytes = files.texturedGlb ? fs.readFileSync(files.texturedGlb) : undefined;
                const clamped = clampToFootprint(clayBytes, texBytes ? [texBytes] : [], loops);
                if (clamped.pulled > 0) {
                    const fitDir = path.join(path.dirname(files.clayGlb), 'footprint_fit');
                    fs.mkdirSync(fitDir, { recursive: true });
                    const clayPath = path.join(fitDir, path.basename(files.clayGlb));
                    fs.writeFileSync(clayPath, clamped.clay);
                    outFiles = { clayGlb: clayPath };
                    if (files.texturedGlb && clamped.others[0]) {
                        const texPath = path.join(fitDir, path.basename(files.texturedGlb));
                        fs.writeFileSync(texPath, clamped.others[0]);
                        outFiles.texturedGlb = texPath;
                    } else if (files.texturedGlb) outFiles.texturedGlb = files.texturedGlb;
                    c = footprintConformance(readTileTriangles(fs.readFileSync(clayPath)).positions, loops);
                    fitNote = ` ${clamped.pulled} vertices pulled back onto it (were up to ${clamped.maxOutBeforeM} m out)`;
                }
            }
            // a run note's name is lowercase letters, '_' and '-' only (stage-cache.ts): "pipeline G layer" once became
            // "footprint_lock_pipeline_G_layer", the write threw, and a finished G build was lost to it (run 92f97642)
            cache.writeRunNote(runId, `footprint_lock_${layerName.toLowerCase().replace(/[^a-z]+/g, '_').replace(/^_+|_+$/g, '')}`, c);
            const say = `footprint lock (${layerName}): ${Math.round(c.outsideShare * 1000) / 10}% of the vertices stand outside the footprint, at most ${c.maxOutsideM} m (projections may reach ${FOOTPRINT_MAX_PROJECTION_M} m)${fitNote}${scanPlan ? '; the footprint is the scan\'s own simplified plan, so a breach is recorded, not degraded' : ''}`;
            run.note(PROVENANCE.photoInferred, say);
            if (!c.ok && !scanPlan) run.degrade(record(stage, 'footprint_breach', {
                part: { description: `the ${layerName}` }, intended: `every wall on the footprint, projections within ${FOOTPRINT_MAX_PROJECTION_M} m of it`, fellTo: fitNote ? 'the layer pulled back onto the footprint, still short of it' : 'the layer as built, its breach recorded',
                provenanceAfter: PROVENANCE.photoInferred, reason: `${c.beyondLimit} vertices stand more than ${FOOTPRINT_MAX_PROJECTION_M} m outside the footprint (at most ${c.maxOutsideM} m)`, transient: false, runId, now: now(), suffix: layerName.replace(/\W+/g, '_')
            }));
            return { say, files: outFiles };
        };
        const recordResidualAudit = (stage: StageId, massingRun: MassingRun, layerName: string): string => {
            const a = massingRun.audit;
            if (!a) return 'residual audit: nothing to audit';
            if ('error' in a) {
                run.degrade(record(stage, 'residual_audit_failed', {
                    part: { description: `the scanned residual of the ${layerName}` }, intended: 'leftover scan clusters measured and judged: scan artefacts removed, real objects kept and listed',
                    fellTo: 'the residual as the massing tool kept it, unaudited (artefacts may show)', provenanceAfter: PROVENANCE.asScanned,
                    reason: `the residual audit could not run (${a.error})`, transient: false, runId, now: now(), suffix: layerName.replace(/\W+/g, '_')
                }));
                return `residual audit failed (${a.error})`;
            }
            cache.writeRunNote(runId, `residual_audit_${layerName.replace(/\W+/g, '_')}`, { counts: a.counts, notes: a.notes, candidates: a.candidates, clusters: a.clusters.map(c => ({ id: c.id, verdict: c.verdict, confidence: c.confidence, reason: c.reason, types: c.feature.types, areaM2: c.areaM2, lo: c.lo, hi: c.hi, scores: c.scores })) });
            run.note(PROVENANCE.asScanned, `${layerName}: ${a.notes.slice(0, 6).join(' | ')}`);
            // "everything in a tile" object catalog (user decision, 2026-10-21): every non-artefact cluster (a real
            // object, or unsure - never a verdict the audit itself is confident is scan noise) gets recorded in the
            // durable asset store's objects table, deduplicated against earlier discoveries at the same place.
            const geoOrigin: GeodeticOrigin = { lat: run.geoAnchor.lat, lng: run.geoAnchor.lng, heightMeters: run.geoAnchor.elevation ?? 0 };
            recordDiscoveredObjects(a.clusters.filter(c => c.verdict !== 'scan-artefact').map(c => {
                const lo = scanToGeodetic(geoOrigin, c.lo[0], c.lo[1], c.lo[2]), hi = scanToGeodetic(geoOrigin, c.hi[0], c.hi[1], c.hi[2]);
                const centre = scanToGeodetic(geoOrigin, (c.lo[0] + c.hi[0]) / 2, (c.lo[1] + c.hi[1]) / 2, (c.lo[2] + c.hi[2]) / 2);
                return {
                    type: c.feature.types[c.feature.types.length - 1] ?? 'SB_FEATURE_TYPE_OBJECT', label: c.reason, confidence: c.confidence,
                    lat: centre.lat, lng: centre.lng, bboxLo: { lat: Math.min(lo.lat, hi.lat), lng: Math.min(lo.lng, hi.lng), alt: lo.alt },
                    bboxHi: { lat: Math.max(lo.lat, hi.lat), lng: Math.max(lo.lng, hi.lng), alt: hi.alt },
                    source: 'residual-audit', runId
                };
            }));
            if (a.counts.unsure > 0) {
                const uns = a.clusters.filter(c => c.verdict === 'unsure').sort((p, q) => q.areaM2 - p.areaM2);
                run.degrade(record(stage, 'residual_unsure', {
                    part: { description: `${uns.length} leftover scan cluster${uns.length === 1 ? '' : 's'} of the ${layerName}` }, intended: 'every leftover scan cluster judged a real object or a scan artefact by its measures',
                    fellTo: 'kept as scanned and labelled unsure (provenance as-scanned:unsure)', provenanceAfter: PROVENANCE.asScanned,
                    reason: `the measures did not decide: ${uns.slice(0, 3).map(c => `cluster ${c.id}, ${Math.round(c.areaM2)} m2: ${c.reason}`).join(' / ')}`, transient: false, runId, now: now(), suffix: layerName.replace(/\W+/g, '_')
                }));
            }
            return a.notes[0];
        };
        /** Pipeline E's massing (step 1-3): the committed clean layer, or undefined (the reason recorded) for the current pipeline. */
        const runPipelineE = async (io: StageIO): Promise<StageResult<RemeshValue> | undefined> => {
            const t0 = now();
            const fallBack = (reasonCode: string, reason: string, cause?: unknown): undefined => {
                run.degrade(record('remesh', reasonCode, {
                    part: { description: 'the structure' }, intended: 'pipeline E: a clean massing from Google vector data, textured from the tile photo', fellTo: 'the current pipeline (remesh, fit, detail)',
                    provenanceAfter: PROVENANCE.remeshed, reason, ...(cause ? { cause } : {}), transient: false, runId, now: now()
                }));
                cache.writeRunNote(runId, 'pipeline_e', { fellBack: true, reasonCode, reason });
                io.progress(`pipeline E: ${reason}; the current pipeline builds the structure`);
                startSurvey();
                return undefined;
            };
            try {
                io.progress('pipeline E: the isolated scan');
                const tilePath = strip ? strip.devegetatedGlb : extraction.texturedGlb;
                let picked: { pick: StructurePickResult; ground: GroundModel } = { pick: structure!, ground: t.ground! };
                if (tilePath !== extraction.texturedGlb) picked = pickOnScan(tilePath, structure!.seed, t.canopy, t.vector) ?? picked;
                const bytesKey = crypto.createHash('sha256').update(picked.pick.footprintMask).update(Buffer.from(Float32Array.from(picked.ground.ground).buffer)).update(Buffer.from(Float32Array.from(picked.ground.top).buffer)).digest('hex').slice(0, 16);
                const isolatePick = writeIsolationPick(path.join(path.dirname(tilePath), `structure_pick_${bytesKey}.sbip`), picked.pick, picked.ground);
                const refined = await deps.refine.refine({ tilePath, isolate: true, anchor: { x: structure!.seed.x, z: structure!.seed.z }, isolatePick, relief: false });
                if (!refined.rawClayGlb) return fallBack('pipeline_e_fallback', 'tile_refine wrote no isolated scan');
                const chk = checkIsolate(refined.rawClayGlb, picked.pick, picked.ground);
                if (!chk.ok) return fallBack('pipeline_e_fallback', `the isolated scan does not match the structure picked (IoU ${round(chk.iou, 2)}, agreement ${round(chk.agreement, 2)})`);
                // the structure's isolated scan, for the in-app Python API (sb.massing via execute_3d_python_script on this scene):
                // the scan, the street level it stands on, its footprint (Google's when used, else the scan's outline), and the
                // district around it (for the hidden-wall test), all in the scene's frame
                // footprint loops from extruded parts only: a modelled volume's parts are its triangles seen from above, not
                // an outline, so without extruded parts the structure's own outline (the pick's) stands in
                const planLoops = eBuildings.flatMap(b => (b.extruded?.length ? b.extruded.filter(p => !p.planOnly).map(p => p.loops[0]) : [])).filter(l => l && l.length >= 3);
                cache.writeRunNote(runId, 'structure_scan', { schema: 'scratchbox.structure-scan/1', scanGlb: refined.rawClayGlb, districtGlb: tilePath, groundY: picked.pick.groundY, plan: planLoops.length ? planLoops : [structure!.outline], planSource: planLoops.length ? footprintSource(eBuildings) : 'scan outline', place: placeValue?.formattedAddress ?? request.query });
                // Solar roof facets, in the tile frame
                let solar: Array<{ pitchDeg: number; azimuthDeg: number; planeHeightMsl: number; center: { lat: number; lng: number }; areaM2: number; x: number; z: number; y: number }> = [];
                let solarNote = 'no Solar roof facets (no API key)';
                if (deps.solarRoof) {
                    try {
                        const sr = await deps.solarRoof(placeValue!.lat, placeValue!.lng);
                        const origin = { lat: placeValue!.lat, lng: placeValue!.lng, heightMeters: 0 };
                        solar = sr.segments.map(sg => { const q = geodeticToScan(origin, sg.center.lat, sg.center.lng); return { ...sg, x: q.x, z: q.z, y: mslToTileY(sg.planeHeightMsl, sg.center.lat, sg.center.lng, extraction.originEllipsoidalHeightM) }; });
                        solarNote = `${solar.length} Solar roof facets (imagery ${sr.imageryQuality ?? '?'}, ${sr.imageryDate ?? 'date unknown'})`;
                    } catch (err) { solarNote = `no Solar roof facets (${errorMessage(err)})`; }
                }
                const key = stageKey(PIPELINE_E_VERSION, refined.cacheKey, sha256File(tilePath).slice(0, 16), sha256Bytes(Buffer.from(JSON.stringify({ eBuildings, solar }))), ...(shapeMode ? [SHAPE_STAGE_VERSION, shapeMode, request.query.trim()] : []), FOOTPRINT_LOCK_VERSION);
                const dir = path.join(cache.dir, 'pipeline_e', key.slice(0, 24));
                io.progress('pipeline E: the clean massing, its orthos and the scanned residual');
                const ground = picked.ground;
                const scanTop = (x: number, z: number) => { const i = ground.cellIndex(x, z); return i < 0 ? NaN : ground.top[i]; };
                let shapeMassing: MassingStageResult['massing'] | undefined;
                if (shapeMode) {
                    io.progress(`shape program trial (${shapeMode}): trees out, the height map${shapeMode === 'program' ? ', the program and its fit' : ''}`);
                    const shapeT0 = now();
                    const shapeVision = visionAvailable ? new VisionModelChain<string>({ client: visionAvailable.client, candidates: visionAvailable.candidates, signal: ctx.signal, ...chainExtras('remesh'), ...(deps.sleep ? { sleep: deps.sleep } : {}) }) : undefined;
                    const sr = await runShapeStage({
                        mode: shapeMode, isolateGlb: refined.rawClayGlb, groundY: picked.pick.groundY, footprintLoops: shapeFootprint.flatMap(b => (b.extruded?.length ? b.extruded.flatMap(p => p.loops) : b.parts.flat())),
                        ...(strip ? { crownsJson: strip.crownsJson, removedTreesGlb: strip.removedTreesGlb } : {}), scanTop, cells: picked.pick.cells, place: placeValue!.formattedAddress || request.query,
                        ...(shapeVision ? { vision: shapeVision } : {}), outDir: path.join(dir, 'shape'), signal: io.signal
                    });
                    shapeMassing = sr.massing;
                    cache.writeRunNote(runId, 'shape_program', { mode: shapeMode, ms: now() - shapeT0, timingsMs: sr.timingsMs, notes: sr.notes, trees: sr.trees, scan: sr.scan, files: sr.files, check: sr.massing.check, parts: sr.massing.parts.length, meshes: sr.massing.meshes.length, ...(sr.program ? { program: { model: sr.program.model, elements: sr.program.validated.elements.length, problems: sr.program.problems, parameters: sr.program.parameters, fit: sr.program.fit, correction: sr.program.correction } } : {}) });
                    io.progress(`shape program trial: ${sr.notes.join('; ')}`);
                }
                let r = await runMassingStage({ tilePath, isolateGlb: refined.rawClayGlb, buildings: eBuildings, groundY: picked.pick.groundY, scanTop, cells: picked.pick.cells, solar, outDir: dir, signal: io.signal, ...(shapeMassing ? { massing: shapeMassing } : {}), preferExtrusion: true, ...(request.procedural === true ? { audit: false } : {}) }, 'remesh', key);
                let c = r.massing.check;
                /** The scan-led massing's ledger of its choices (footprint, heights), kept in the run note. */
                const massingLedger: LedgerEntry[] = [];
                if (scanLed) massingLedger.push({ decision: 'structure', chosen: structure?.seededOn ? `the structure at ${structure.seededOn}` : `the raised structure nearest the place (${structure?.geocodeToStructureM ?? '?'} m from it)`, why: structure?.seededOn ? 'a vector building stands within the search window: its raised cell nearest the place seeds the pick' : 'no vector building raised within the search window, or none asked for', sources: [{ source: 'vector', value: structure?.seededOn ?? 'none used', used: !!structure?.seededOn }, { source: 'scan', value: `${structure?.areaM2 ?? '?'} m2 raised, ${structure?.heightM ?? '?'} m high`, used: true }] });
                // a procedural build: the vector massing is guidance; when it fails its check against the scan, the massing is
                // built again from the scan's own plan before anything falls back (the NYPL fell back at 5.41 m vs 4.96 m allowed)
                const scanPlan = scanLed && !c.ok && !eBuildings.some(b => b.provenance === SCAN_FOOTPRINT_TOKEN) ? scanDerivedFootprint(structure) : undefined;
                if (scanPlan) {
                    io.progress(`the vector massing ${c.reason ?? 'could not be built'}; the massing from the scan's own plan instead`);
                    const r2 = await runMassingStage({ tilePath, isolateGlb: refined.rawClayGlb, buildings: [scanPlan], groundY: picked.pick.groundY, scanTop, cells: picked.pick.cells, solar, outDir: `${dir}_scanplan`, signal: io.signal, preferExtrusion: true, ...(request.procedural === true ? { audit: false } : {}) }, 'remesh', `${key}_scanplan`);
                    massingLedger.push({ decision: 'footprint', chosen: r2.massing.check.ok ? "the scan's own plan" : 'none', why: `the vector massing ${c.reason ?? 'could not be built'}; the scan's plan ${r2.massing.check.ok ? `passed (IoU ${r2.massing.check.iou}, roof ${r2.massing.check.heightErrMedianM} m off)` : `failed too (${r2.massing.check.reason ?? 'could not be built'})`}`, sources: [{ source: 'vector', value: `IoU ${c.iou}, roof ${c.heightErrMedianM} m off`, used: false }, { source: 'scan', value: `IoU ${r2.massing.check.iou}, roof ${r2.massing.check.heightErrMedianM} m off`, used: r2.massing.check.ok }] });
                    if (r2.massing.check.ok) { r = r2; c = r2.massing.check; }
                } else if (scanLed) {
                    massingLedger.push({ decision: 'footprint', chosen: eBuildings.some(b => b.provenance === SCAN_FOOTPRINT_TOKEN) ? "the scan's own plan (no Google footprint)" : `Google vector footprint${eBuildings.length > 1 ? 's' : ''} ${eBuildings.map(b => b.id).join(', ')}`, why: c.ok ? `plan IoU ${c.iou}, roof ${c.heightErrMedianM} m off the scan` : c.reason ?? 'the massing could not be built', sources: [{ source: eBuildings.some(b => b.provenance === SCAN_FOOTPRINT_TOKEN) ? 'scan' : 'vector', value: `IoU ${c.iou}`, used: c.ok }] });
                }
                if (scanLed) for (const n of r.massing.notes) { const e = ledgerFromMassingNote(n); if (e) massingLedger.push(e); }
                cache.writeRunNote(runId, 'pipeline_e', { check: r.massing.check, solar: r.massing.solar, solarNote, notes: r.massing.notes, timingsMs: r.timingsMs, native: r.run ? { timingsMs: r.run.report.timingsMs, snap: r.run.report.snap, residual: r.run.report.residual, faces: r.run.report.faces.length } : undefined, ...(massingLedger.length ? { ledger: massingLedger } : {}) });
                if (!c.ok || !r.run || !r.files) return fallBack('pipeline_e_fallback', `${c.reason ?? 'the massing could not be built'} (plan IoU ${c.iou}, roof ${c.heightErrMedianM} m off the scan, median; ${c.heightErrP90M} m at the 90th percentile)`);
                run.keys.remesh = key;
                run.cacheStatus.remesh = 'miss';
                const lock = checkFootprintLock('remesh', 'massing layer', { clayGlb: r.files.clayGlb, texturedGlb: r.files.texturedGlb }, r.massing.parts, { clamp: true });
                r.files.clayGlb = lock.files.clayGlb;
                if (lock.files.texturedGlb) r.files.texturedGlb = lock.files.texturedGlb;
                const key8 = key.slice(0, 8);
                const pubClay = cache.publishFile(r.files.clayGlb, `${base}_massing_${key8}.glb`);
                const pubTex = cache.publishFile(r.files.texturedGlb, `${base}_massing_${key8}_tex.glb`);
                const l1 = currentL1()!;
                const counts = layerCounts(r.files.clayGlb);
                const residual = r.run.report.residual;
                const auditLine = recordResidualAudit('remesh', r.run, 'massing layer');
                const note = `pipeline E massing: ${r.massing.parts.length} extruded parts, ${r.massing.meshes.length} modelled volumes; plan IoU with the scan ${c.iou}, roof ${c.heightErrMedianM} m off (median); ${solarNote}; walls moved onto the scanned facade: ${r.run.report.snap.filter(x => x.applied).length} of ${r.run.report.snap.length}; scanned residual: ${residual.proud} proud and ${residual.cut} cut-in triangles in ${residual.clusters.length} clusters, ${residual.apron} ground apron; ${auditLine}`;
                const legend = r.legend!;
                const layer: StagedLayer = {
                    objectId: layerObjectId(key, 'l2'), stage: 'remesh', layer: 'l2', order: STAGES.remesh.order, url: pubClay.url, bytes: pubClay.bytes,
                    provenance: { ...massingProvenance({ kind: 'wall', provenance: 'massing', confidence: null }, r.massing), note },
                    provenanceLabels: ['vector-massing', PROVENANCE.asScanned], supersedes: [l1.objectId], revealAfter: [],
                    reveal: { durationMs: 800, stagger: 0, crossfadeFrom: [l1.objectId] }, cached: false, builtAtMs: now(), counts,
                    // the 3D Building build (request.procedural) shows no tile-photo texture: its massing stays clay until pipeline
                    // J's generated model replaces it (user decision 2026-10-22)
                    ...(request.procedural === true ? {} : { textured: {
                        url: pubTex.url, bytes: pubTex.bytes, ladderRung: r.files.texturedShares.findIndex((_, k, a) => a.slice(k + 1).reduce((x, y) => x + y, 0) <= 0.1),
                        rungShares: r.files.texturedShares, provenance: (r.files.legend ?? legend).map(e => ({ source: e.source, label: e.label, method: e.method, coverage: 0 })),
                        confidenceChannels: 'R = index into provenance[], G = weight 0..255, B = ladder rung (TEXTURE_LADDER_RUNGS), A = 255 where a stage produced the texel', builtAtMs: now(), cached: false
                    } })
                };
                run.commit(layer, { source: 'Google3DTilesClay', resolvedAddress: placeValue!.formattedAddress, extra: { rawGlbPath: extraction.rawGlbPath ?? extraction.texturedGlb, pipeline: 'e' } });
                run.setGround(layer.objectId);
                run.note('vector-massing', note);
                eState = { stage: r, refined, layer, key, ms: now() - t0 };
                return {
                    status: 'committed', value: { refined, groundLayerId: layer.objectId, groundFile: r.files.clayGlb, committed: true },
                    source: `pipeline E: clean massing from Google vector data, textured from the tile photo, in ${((now() - t0) / 1000).toFixed(1)} s (${counts.triangles.toLocaleString('en-US')} triangles)`,
                    layers: [layer], cached: false, builtAtMs: now()
                };
            } catch (err) {
                if (isAbort(err) || io.signal.aborted) throw err;
                return fallBack('pipeline_e_failed', `pipeline E failed (${errorMessage(err)})`, err);
            }
        };
        if (pipelineE && eWhyNot) {
            run.degrade(record('remesh', 'pipeline_e_fallback', {
                part: { description: 'the structure' }, intended: 'pipeline E: a clean massing from Google vector data, textured from the tile photo', fellTo: 'the current pipeline (remesh, fit, detail)',
                provenanceAfter: PROVENANCE.remeshed, reason: eWhyNot, transient: false, runId, now: now()
            }));
            cache.writeRunNote(runId, 'pipeline_e', { fellBack: true, reasonCode: 'pipeline_e_fallback', reason: eWhyNot });
        }
        /** Where finishRefine's run notes, legend notes and degradations go: the run's own, or held until a remesh is committed. */
        type RefineNotes = { write(name: string, data: unknown): void; note(label: ProvenanceLabel, text: string): void; degrade(rec: DegradationRecord): DegradationRecord };
        const directNotes: RefineNotes = { write: (name, data) => cache.writeRunNote(runId, name, data), note: (label, text) => run.note(label, text), degrade: rec => run.degrade(rec) };
        /**
         * What follows tile_refine before its remesh is shown: pipeline K's facade work (the photos straightened, the windows
         * and wall grammar fitted, whole-wall sheets) and the polish (cleanup, lattice, K's base cleanup and clip to the
         * footprint, infill, orient). The remesh stage runs it on the first isolate; in pipeline K the ownership vote runs it on
         * the voted remesh when that replaces the first isolate, so the building shown is never the raw re-refine. Its run
         * notes and steps describe the remesh it last ran on; `stage` is the stage its degradations are recorded under, and
         * `notes` where its run notes, legend notes and degradations go (the vote holds them until its remesh is committed).
         */
        // what the outside audit saw on each polished build (holes), the vote's judged against the first isolate's below
        const defectsSeen = new Map<'remesh' | 'ownership', { holeShare: number; largestHoleRegionM2: number; why: string }>();
        /**
         * Pipeline K's facade pass as each remesh ran it: tile_refine's orthos (or the set composed from both passes), the
         * straightened set, and the window fit (merged with the reader's openings and arrayed) and the reader's records as
         * the lattice took them. The ownership vote takes the facades it left unchanged from the first isolate's (facade-reuse.ts).
         */
        type FacadePass = { rawDir: string; kDir: string; fit?: WindowFitFile; reader?: FacadeReaderFile };
        const facadePasses = new Map<'remesh' | 'ownership', FacadePass>();
        const finishRefine = async (r: TileRefineResult, io: StageIO, timed: <R>(k: string, work: () => Promise<R>) => Promise<R>, stepFiles: Array<[string, string]>, degradations: DegradationRecord[], stage: 'remesh' | 'ownership', notes: RefineNotes = directNotes, reuse?: { plan: FacadeReusePlan; first: FacadePass }): Promise<TileRefineResult> => {
            // pipeline K: the facade orthos straightened and their smears levelled before the facades are rebuilt on them
            let orthosKey: string | undefined, windowFit: string | undefined, wallGrammar: string | undefined, wallSheets: string | undefined, revealDepth: string | undefined, surveyViews: RevealView[] | undefined;
            let symmetry: SymmetryReport | undefined;
            if (pipelineK) {
                if (!r.reliefOrthosDir) notes.note(PROVENANCE.remeshed, 'pipeline K: tile_refine wrote no facade orthophotos, so no facade could be straightened; the remesh stands as cleaned');
                else {
                    try {
                        io.progress('pipeline K: straightening the facade photos');
                        // the facades' small holes no real source covers: inpainted by the image model when the build has one
                        // (capped per build, pipeline-k.ts HOLE_INPAINT); SCRATCHBOX_K_HOLE_INPAINT=0 off
                        const holeInpaint = deps.textures?.enhance && process.env.SCRATCHBOX_K_HOLE_INPAINT?.trim() !== '0' ? { client: deps.textures.enhance, models: [LIGHTING_MODEL_LITE], ...(bypass('remesh') ? {} : { readings: modelReadingsStore() }) } : undefined;
                        // the ownership vote's remesh: the facades it left unchanged put back as the first pass's (facade-reuse.ts),
                        // and taken whole from the first pass's straightened set; only the others are straightened
                        const keptIds = new Set(reuse?.plan.kept.map(x => x.firstId) ?? []);
                        const srcDir = reuse ? composeReusedOrthos(reuse.first.rawDir, r.reliefOrthosDir!, reuse.plan) : r.reliefOrthosDir!;
                        const rectifyReuse = reuse ? { fromDir: reuse.first.kDir, ids: [...keptIds], key: `${path.basename(path.dirname(reuse.first.kDir))}/${path.basename(reuse.first.kDir)}` } : undefined;
                        let k = await timed('pipelineK', () => rectifyReliefOrthos(srcDir, { signal: io.signal, ...(cpuShare ? { threads: cpuShare.threads } : {}), ...(holeInpaint ? { inpaint: holeInpaint } : {}), ...(rectifyReuse ? { reuse: rectifyReuse } : {}) }));
                        const pass: FacadePass = { rawDir: srcDir, kDir: k.orthosDir };
                        facadePasses.set(stage, pass);
                        // the first pass's window fit as the lattice took it, for the kept facades: neither fitted nor read again
                        const fitReused = new Map<number, WindowFitEntry>();
                        if (reuse?.first.fit) for (const e of reuse.first.fit.facades) if (keptIds.has(e.facadeId)) fitReused.set(e.facadeId, e);
                        orthosKey = `${PIPELINE_K_VERSION}:${k.key}`;
                        r = { ...r, reliefOrthosDir: k.orthosDir };
                        notes.write('pipeline_k', { version: PIPELINE_K_VERSION, orthosDir: k.orthosDir, cached: k.cached, ms: k.ms, reports: k.reports });
                        notes.note(PROVENANCE.photoInferred, `pipeline K (${PIPELINE_K_VERSION}): ${describeRectified(k)}`);
                        // the symmetry the scan, the footprint and the straightened photos imply (pipeline-k/symmetry.ts): detected and
                        // reported only (step 1), off unless SCRATCHBOX_K_SYMMETRY=1 or the node graph's remesh.symmetry
                        if (structure && stepOn('remesh.symmetry', symmetryOn())) {
                            try {
                                io.progress('pipeline K: reading the building\'s symmetry');
                                const vec = eBuildings.flatMap(b => (b.extruded?.length ? b.extruded.filter(p => !p.planOnly).map(p => p.loops[0]) : [])).filter(l => l && l.length >= 3);
                                const footprint = (vec.length ? vec : [structure.outline]).map(l => l.map(p => [p[0], p[1]] as [number, number]));
                                const symIn = { scanGlb: r.clayGlb, groundY: structure.groundY, footprint };
                                const symOpts = { signal: io.signal, ...(cpuShare ? { threads: cpuShare.threads } : {}) };
                                if (symmetryFillOn()) {
                                    // step 2: the unread facade texels filled from the mirror (generated), on a clone of the orthos that every
                                    // later stage reads; the polish's key follows it
                                    const filled = await timed('symmetry', () => mirrorFillOrthos(k.orthosDir, k.key, symIn, symOpts));
                                    symmetry = filled.report;
                                    k = { ...k, orthosDir: filled.orthosDir, key: `${k.key}-sym-${filled.key}` };
                                    orthosKey = `${PIPELINE_K_VERSION}:${k.key}`;
                                    r = { ...r, reliefOrthosDir: k.orthosDir };
                                    notes.note(PROVENANCE.generated, describeMirrorFill(filled.report));
                                } else symmetry = await timed('symmetry', () => detectSymmetry({ ...symIn, orthosDir: k.orthosDir }, symOpts));
                                notes.write('pipeline_k_symmetry', { version: SYMMETRY_VERSION, footprint: vec.length ? footprintSource(eBuildings) : 'scan outline', ...symmetry });
                                notes.note(PROVENANCE.photoInferred, describeSymmetry(symmetry));
                            } catch (err) {
                                if (isAbort(err) || io.signal.aborted) throw err;
                                notes.write('pipeline_k_symmetry', { version: SYMMETRY_VERSION, failed: true, reason: errorMessage(err) });
                                notes.note(PROVENANCE.photoInferred, `the symmetry reading failed (${errorMessage(err)}); nothing reads it yet, so the build is unchanged`);
                            }
                        } else logStep('remesh.symmetry', 'skipped');
                        // the windows fitted on the straightened photos (window-fit.ts), for the lattice to hand to the material regions
                        if (!stepOn('remesh.windowFit', true)) {
                            logStep('remesh.windowFit', 'skipped');
                            notes.write('pipeline_k_window_fit', { version: WINDOW_FIT_VERSION, skipped: true, reason: 'turned off for this build' });
                        } else try {
                            io.progress('pipeline K: fitting the windows on the facade photos');
                            // the no-pattern tail only (window-fit.ts): an open-vocabulary mask of "window"/"door", opt-in since it
                            // bills per call (docs/research/2026-10-27-sb-fenestra-window-fit-design.md, section 1, evidence 6)
                            const windowSegmentOn = process.env.SCRATCHBOX_K_WINDOW_SEGMENT?.trim() === '1';
                            const windowSegment = windowSegmentOn ? openingSegmenter(deps.textures?.segment ?? segmenterTool()) : undefined;
                            // the facade reader reads the straightened photos here for the window geometry (below), and every plane on the
                            // finished exterior in the texture stage for the material reads (pipeline-k/twin-reader.ts, user decision 2026-10-30)
                            const readerOn = !!(visionAvailable && stepOn('remesh.facadeRead', process.env.SCRATCHBOX_K_FACADE_READ?.trim() !== '0'));
                            // with the reader on, the segmenter takes only the walls its gates leave unread (as readPlanes filters them:
                            // shorter than minHeightM, narrower than minWallWidthM or under minCoverage covered); the reader would
                            // replace the segmenter's windows on every other plane
                            const RP = FACADE_READER_PARAMS;
                            const segmentScope = windowSegment && readerOn ? { key: `beside-${FACADE_READER_VERSION}:${RP.minWallWidthM}/${RP.minHeightM}/${RP.minCoverage}`, includes: (p: { widthM: number; heightM: number; coverage: number }) => !(p.coverage >= RP.minCoverage && p.widthM >= RP.minWallWidthM && p.heightM >= RP.minHeightM) } : undefined;
                            // the steps below run on worker threads, off this thread and each in a heap of its own (remesh-worker-pool.ts),
                            // unless SCRATCHBOX_REMESH_WORKERS=0: the window fit a facade a job, largest first
                            const onThreads = remeshWorkersEnabled();
                            const fitOnThreads = (facades: OrthoFacade[], P: WindowFitParams) =>
                                runRemeshJobs<WindowFitEntry>(facades.map(facade => ({ kind: 'windowFacade' as const, orthosDir: k.orthosDir, facade, params: P })), { threads: cpuShare ? Math.min(cpuShare.threads, remeshWorkerThreads()) : remeshWorkerThreads(), order: facades.map((_, i) => i).sort((a, b) => facades[b].width * facades[b].height - facades[a].width * facades[a].height || a - b), signal: io.signal });
                            // the facade reader on the straightened photos, beside the window fit (it needs only the photos): its accepted
                            // openings and pane splits drive the window geometry (user decision, 2026-11-05), merged into the fit below
                            const geometryAsk = readerOn ? facadeReaderAsk(io.signal, 'remesh') : undefined;
                            const geometryReadings = bypass('remesh') ? undefined : modelReadingsStore();
                            const readerReuse = reuse?.first.reader && fitReused.size ? { file: reuse.first.reader, ids: new Set(fitReused.keys()) } : undefined;
                            const geometryRead = geometryAsk ? timed('facadeRead', () => readPlanes(k.orthosDir, geometryAsk, { signal: io.signal, progress: m => io.progress(`pipeline K: ${m}`), building: { name: request.query, ...(run.state.place?.resolvedAddress ? { address: run.state.place.resolvedAddress } : {}) }, ...(geometryReadings ? { readings: { store: geometryReadings, model: FACADE_READER_MODEL_KEY } } : {}), ...(readerReuse ? { reuse: readerReuse } : {}) })) : undefined;
                            // awaited after the window fit; a failure is handled there
                            geometryRead?.catch(() => undefined);
                            if (!geometryRead) logStep('remesh.facadeRead', 'skipped');
                            const wf = await timed('windowFit', () => fitWindowsForOrthos(k.orthosDir, { signal: io.signal, ...(cpuShare ? { concurrency: cpuShare.threads } : {}), ...(windowSegment ? { segment: windowSegment } : {}), ...(segmentScope ? { segmentScope } : {}), ...(onThreads ? { fitFacades: fitOnThreads } : {}), ...(fitReused.size ? { reuse: fitReused } : {}) }));
                            windowFit = wf.file;
                            // the reader's openings in place of the window fit's inside the zones it drew; the window fit's stand
                            // elsewhere (planes unread, zones rejected); the wall grammar, wall sheets and lattice below read the merged fit
                            if (geometryRead) {
                                try {
                                    const fr = await geometryRead;
                                    pass.reader = fr.records;
                                    // a kept facade's fit entry already holds its reading, merged and arrayed in the first pass
                                    const m = mergeReadings(k.orthosDir, wf.fit, fr.records.readings.filter(x => !fitReused.has(x.facadeId))).merged;
                                    const recs = fr.records.facades, by = (o: string) => recs.filter(x => x.outcome === o).length;
                                    notes.write('pipeline_k_window_reader', { version: FACADE_READER_VERSION, on: 'the straightened facade photos', cached: fr.cached, ...(fr.records.reusedPlanes ? { reusedPlanes: fr.records.reusedPlanes } : {}), read: recs.length, replaced: by('replaced'), kept: by('kept'), skipped: by('skipped'), failed: by('failed'), unread: fr.records.unread, ms: fr.records.ms, ...(fr.records.calls ? { calls: fr.records.calls } : {}), merged: m });
                                    notes.note(PROVENANCE.photoInferred, `facade reader (${FACADE_READER_VERSION}) on the straightened photos: ${m.readerWindows} openings on ${m.planes} of ${recs.length} planes read drive the window geometry, in place of ${m.replacedFitWindows} of the window fit's; ${m.keptFitWindows} of the window fit's kept on those planes outside the zones it drew, and all of them on the rest`);
                                } catch (err) {
                                    if (isAbort(err) || io.signal.aborted) throw err;
                                    notes.write('pipeline_k_window_reader', { version: FACADE_READER_VERSION, failed: true, reason: errorMessage(err) });
                                    notes.note(PROVENANCE.photoInferred, `the facade reader on the straightened photos failed (${errorMessage(err)}); the window geometry is the window fit's`);
                                }
                            }
                            // each facade's boxes (the reader's where it drew, the window fit's elsewhere) brought onto the array the majority
                            // of them form (pipeline-k/window-array.ts), read against the photo; the wall grammar, wall sheets and lattice
                            // below read the arrayed fit. On unless
                            // SCRATCHBOX_K_WINDOW_ARRAY=0 or the node graph's remesh.windowArray off
                            if (stepOn('remesh.windowArray', process.env.SCRATCHBOX_K_WINDOW_ARRAY?.trim() !== '0')) {
                                try {
                                    // the building's system first, read by the vision model from the whole structure on one contact sheet
                                    // (pipeline-k/building-system.ts; user direction 2026-11-07): tiers, families and their measures, kept in
                                    // the readings store; laid on each face below where the photo shows it. SCRATCHBOX_K_BUILDING_SYSTEM=0 off
                                    let system: BuildingSystem | undefined;
                                    const systemAsk = geometryAsk && process.env.SCRATCHBOX_K_BUILDING_SYSTEM?.trim() !== '0' ? geometryAsk : undefined;
                                    if (systemAsk) {
                                        try {
                                            const bs = await timed('buildingSystem', () => readBuildingSystem(k.orthosDir, systemAsk, { signal: io.signal, building: { name: request.query, ...(run.state.place?.resolvedAddress ? { address: run.state.place.resolvedAddress } : {}) }, ...(geometryReadings ? { readings: { store: geometryReadings, model: FACADE_READER_MODEL_KEY } } : {}) }));
                                            system = bs.system;
                                            notes.write('pipeline_k_building_system', { version: BUILDING_SYSTEM_VERSION, ...(bs.system ? { system: bs.system } : {}), ...(bs.reason ? { reason: bs.reason } : {}), calls: bs.calls, reused: bs.reused, ms: bs.ms });
                                        } catch (err) {
                                            if (isAbort(err) || io.signal.aborted) throw err;
                                            notes.write('pipeline_k_building_system', { version: BUILDING_SYSTEM_VERSION, failed: true, reason: errorMessage(err) });
                                        }
                                    } else notes.write('pipeline_k_building_system', { version: BUILDING_SYSTEM_VERSION, skipped: geometryAsk ? 'SCRATCHBOX_K_BUILDING_SYSTEM=0' : 'no vision model, or the facade reader off' });
                                    // the structure's roof line bounds the array's step into an unreached band at a photo's top
                                    // each facade's first pass on the worker threads (the same bytes; 12-24 s on this thread for Penn's largest buildings)
                                    const arrayOpts = { ...(structure ? { envelopeTopY: structure.groundY + structure.heightM } : {}), ...(system ? { system } : {}) };
                                    const wa = await timed('windowArray', async () => onThreads
                                        ? inferWindowArraysOnThreads(k.orthosDir, wf.fit, jobs => runRemeshJobs<ArrayOutput | null>(jobs.map(job => ({ kind: 'windowArrayFacade' as const, job })), { threads: cpuShare ? Math.min(cpuShare.threads, remeshWorkerThreads()) : remeshWorkerThreads(), signal: io.signal }).then(r => r.map(x => x ?? undefined)), undefined, arrayOpts)
                                        : inferWindowArrays(k.orthosDir, wf.fit, undefined, arrayOpts));
                                    notes.write('pipeline_k_window_array', { ...wa, on: "the window fit, with the facade reader's openings merged in" });
                                    notes.note(PROVENANCE.photoInferred, describeWindowArrays(wa));
                                } catch (err) {
                                    if (isAbort(err) || io.signal.aborted) throw err;
                                    notes.write('pipeline_k_window_array', { version: WINDOW_ARRAY_VERSION, failed: true, reason: errorMessage(err) });
                                    notes.note(PROVENANCE.photoInferred, `the window array step failed (${errorMessage(err)}); the windows stay as the window fit read them`);
                                }
                            } else logStep('remesh.windowArray', 'skipped');
                            // step 2 of the symmetry: the reader's windows confirm or fill their mirror sites (unread sites only), and a
                            // reader phase error is flagged where the mirror halves disagree (pipeline-k/symmetry.ts mirrorWindows)
                            if (symmetry && symmetryWindowsOn() && stepOn('remesh.mirrorWindows', true)) {
                                try {
                                    const sym = symmetry;
                                    const mw = await timed('mirrorWindows', async () => mirrorWindows(k.orthosDir, wf.fit, sym));
                                    notes.write('pipeline_k_mirror_windows', mw);
                                    notes.note(PROVENANCE.generated, describeMirrorWindows(mw));
                                } catch (err) {
                                    if (isAbort(err) || io.signal.aborted) throw err;
                                    notes.write('pipeline_k_mirror_windows', { version: SYMMETRY_VERSION, failed: true, reason: errorMessage(err) });
                                }
                            } else logStep('remesh.mirrorWindows', 'skipped');
                            // the fit as the lattice takes it, for a later pass to take its unchanged facades from
                            pass.fit = structuredClone(wf.fit);
                            // the bay grammar read per wall, from all the photos of each wall's facades together (wall-grammar.ts)
                            try {
                                const wg = await timed('wallGrammar', async () => { await ensureNativeWallGrammar(); return onThreads ? runRemeshJob<{ file: string; grammar: WallGrammarFile }>({ kind: 'wallGrammar', orthosDir: k.orthosDir, fit: wf.fit, ...(cpuShare ? { threads: cpuShare.threads } : {}) }, { signal: io.signal }) : readWallGrammar(k.orthosDir, wf.fit, b => { const d = decodePngForGrammar(b); return { rgba: d.rgba, width: d.width, height: d.height }; }, undefined, cpuShare ? { threads: cpuShare.threads } : {}); });
                                wallGrammar = wg.file;
                                const bays = wg.grammar.walls.flatMap(w => w.bays);
                                notes.write('pipeline_k_wall_grammar', { version: WALL_GRAMMAR_VERSION, walls: wg.grammar.walls.length, multiFacadeWalls: wg.grammar.walls.filter(w => w.facades.length > 1).length, tiers: new Set(wg.grammar.walls.map(w => w.tier)).size, baysRead: bays.filter(b => b.from === 'photo-inferred').length, baysGenerated: bays.filter(b => b.from === 'generated').length });
                                // one sheet per multi-facade wall, rebuilt in place of its facades (on unless SCRATCHBOX_K_WHOLE_WALLS=0)
                                if (stepOn('remesh.wallSheets', process.env.SCRATCHBOX_K_WHOLE_WALLS?.trim() !== '0')) {
                                    const ws = await timed('wallSheets', async () => { await ensureNativeWallSheets(); return onThreads ? runRemeshJob<{ file: string; sheets: WallSheet[] }>({ kind: 'wallSheets', orthosDir: k.orthosDir, grammar: wg.grammar, fit: wf.fit, ...(cpuShare ? { threads: cpuShare.threads } : {}) }, { signal: io.signal }) : buildWallSheets(k.orthosDir, wg.grammar, wf.fit, b => { const d = decodePngForGrammar(b); return { rgba: d.rgba, width: d.width, height: d.height }; }, cpuShare ? { threads: cpuShare.threads } : {}); });
                                    wallSheets = ws.file;
                                    notes.write('pipeline_k_wall_sheets', { version: WALL_SHEETS_VERSION, sheets: ws.sheets.map(sh => ({ wallId: sh.wallId, members: sh.members, sizeM: [Math.round(sh.facade.sMax - sh.facade.sMin), Math.round(sh.facade.tMax - sh.facade.tMin)], filledShare: sh.facade.textureFill?.share, windows: sh.windows.length, bays: sh.bays.length })) });
                                    notes.note(PROVENANCE.photoInferred, `whole walls (${WALL_SHEETS_VERSION}): ${ws.sheets.length} walls rebuilt as one sheet each from ${ws.sheets.reduce((a, sh) => a + sh.members.length, 0)} facades; their photo-less texels filled from each sheet's own repeats (generated)`);
                                } else logStep('remesh.wallSheets', 'skipped');
                                notes.note(PROVENANCE.photoInferred, `wall grammar (${WALL_GRAMMAR_VERSION}): ${wg.grammar.walls.length} walls from ${wg.grammar.walls.reduce((a, w) => a + w.facades.length, 0)} facades, ${bays.filter(b => b.from === 'photo-inferred').length} bays read from their photos together, ${bays.filter(b => b.from === 'generated').length} continued along a wall's rhythm or laid by its tier's grammar (generated)`);
                            } catch (err) {
                                if (isAbort(err) || io.signal.aborted) throw err;
                                notes.write('pipeline_k_wall_grammar', { version: WALL_GRAMMAR_VERSION, failed: true, reason: errorMessage(err) });
                            }
                            const ok = wf.fit.facades.filter(f => !('error' in f)), failed = wf.fit.facades.filter(f => 'error' in f);
                            const seg = segmentSummary(wf.fit);
                            notes.write('pipeline_k_window_fit', { version: WINDOW_FIT_VERSION, cached: wf.cached, segment: windowSegmentOn, ...(windowSegmentOn ? { segmentTries: seg, segmentScope: segmentScope?.key ?? 'every facade the fit left empty' } : {}), ms: wf.fit.ms, facades: wf.fit.facades.map(f => ('error' in f ? f : { facadeId: f.facadeId, windows: f.rects.length, bands: f.bands.length, accepted: f.bands.filter(b => b.accepted).length, kinds: f.bands.filter(b => b.accepted).map(b => b.kind), ...(f.segmentTry ? { segmentTry: f.segmentTry } : {}), ms: f.ms })) });
                            const segNote = seg.attempted ? `; of the ${seg.attempted} facades the structural fit left empty, an open-vocabulary mask of their photo gave windows the photo confirms on ${seg.assisted}, openings the photo does not confirm on ${seg.noWindows}, and nothing on ${seg.notFound}${seg.failed ? `, and ${seg.failed} calls failed (${seg.errors.join('; ')})` : ''}` : '';
                            notes.note(PROVENANCE.photoInferred, `window fit (${WINDOW_FIT_VERSION}): ${ok.reduce((a, f) => a + ('rects' in f ? f.rects.length : 0), 0)} windows on ${ok.filter(f => 'rects' in f && f.rects.length).length} of ${wf.fit.facades.length} facades${segNote}${failed.length ? `; ${failed.length} facades not fitted (${failed.map(f => `${f.facadeId}: ${'error' in f ? f.error : ''}`).join('; ').slice(0, 300)}), opened by their bay rhythm instead` : ''}`);
                        } catch (err) {
                            if (isAbort(err) || io.signal.aborted) throw err;
                            notes.write('pipeline_k_window_fit', { version: WINDOW_FIT_VERSION, failed: true, reason: errorMessage(err) });
                            notes.note(PROVENANCE.photoInferred, `window fit failed (${errorMessage(err)}); the facades are opened by their bay rhythm and the lattice's window cells instead`);
                        }
                        // how deep the fitted windows sit, read from the survey's Street View photos (reveal-depth.ts)
                        if (windowFit) {
                            try {
                                const sres = surveyPromise ? (await surveyPromise.catch(() => undefined))?.result : undefined;
                                const views: RevealView[] = (sres?.read ?? []).flatMap(rd => {
                                    const bytes = surveyImageBytes(sres!, rd.imageIndex);
                                    if (!bytes) return [];
                                    const d = decodeJpegInMemory(bytes);
                                    return [{ id: `${rd.view.panoId}_h${Math.round(rd.view.headingDeg)}_p${Math.round(rd.view.pitchDeg)}`, camera: castCamera({ ...rd.view, widthPx: d.width, heightPx: d.height }), rgba: d.data, width: d.width, height: d.height }];
                                });
                                surveyViews = views;
                                // off for now (user decision, 2026-10-28): the reading was never confident enough to use on the ESB; the photos still
                                // feed the Street View score. SCRATCHBOX_K_REVEAL_DEPTH=1 turns it back on
                                if (!stepOn('remesh.revealDepth', process.env.SCRATCHBOX_K_REVEAL_DEPTH?.trim() === '1')) {
                                    notes.write('pipeline_k_reveal_depth', { version: REVEAL_DEPTH_VERSION, skipped: true, reason: request.steps?.['remesh.revealDepth'] === false ? 'turned off for this build' : 'off (SCRATCHBOX_K_REVEAL_DEPTH=1 or the node graph turns it on)' });
                                    logStep('remesh.revealDepth', 'skipped');
                                } else if (!views.length) notes.note(PROVENANCE.photoInferred, 'window depth: no Street View photo of the survey to read it from; the recesses follow the photo-contrast rule');
                                else {
                                    const fitFile = JSON.parse(fs.readFileSync(windowFit, 'utf8')) as WindowFitFile;
                                    const frames = (JSON.parse(fs.readFileSync(path.join(k.orthosDir, 'facades.json'), 'utf8')).facades as ReliefFacade[]);
                                    const revealFacades: RevealFacade[] = frames.flatMap(f => {
                                        const rects = fittedWindowRects(fitFile, f.facadeId);
                                        return rects ? [{ facadeId: f.facadeId, centroid: f.centroid, normal: f.normal, axisS: f.axisS, axisT: f.axisT, windows: rects.map(([x0, y0, x1, y1]) => [f.orthoSMin + x0 * f.pixel, f.orthoTMax - y1 * f.pixel, f.orthoSMin + x1 * f.pixel, f.orthoTMax - y0 * f.pixel] as [number, number, number, number]) }] : [];
                                    });
                                    // what each photo sees first: the whole tile mesh (neighbours and trees too) from its camera
                                    const tileMesh = sceneToRenderMesh(readGlbScene(extraction.geometryGlb));
                                    for (const v of views) v.depth = renderFrameDepth(tileMesh, v.camera);
                                    const rd = await timed('revealDepth', async () => measureRevealDepth(revealFacades, views, undefined, process.env.SCRATCHBOX_REVEAL_DEBUG === '1' ? path.join(k.orthosDir, 'reveal_debug') : undefined));
                                    revealDepth = path.join(k.orthosDir, 'reveal_depth.json');
                                    fs.writeFileSync(revealDepth, JSON.stringify(rd));
                                    const own = Object.values(rd.facades).filter(x => x.from === 'own');
                                    notes.write('pipeline_k_reveal_depth', { version: REVEAL_DEPTH_VERSION, views: rd.views, pairs: rd.pairs, building: rd.building ?? null, facades: rd.facades, fits: rd.fits });
                                    notes.note(PROVENANCE.photoInferred, `window depth (${REVEAL_DEPTH_VERSION}): ${rd.pairs} window readings in ${rd.views} Street View photos (© Google); ${own.length} facades read their own depth${rd.building ? `; the building's windows read together give ${rd.building.depthM} ± ${rd.building.seM} m, used on the ${Object.values(rd.facades).length - own.length} others` : '; the building as a whole gave no reading, so the others follow the photo-contrast rule'}`);
                                }
                            } catch (err) {
                                if (isAbort(err) || io.signal.aborted) throw err;
                                notes.write('pipeline_k_reveal_depth', { version: REVEAL_DEPTH_VERSION, failed: true, reason: errorMessage(err) });
                                notes.note(PROVENANCE.photoInferred, `window depth could not be read from Street View (${errorMessage(err)}); the recesses follow the photo-contrast rule`);
                            }
                        }
                    } catch (err) {
                        if (isAbort(err) || io.signal.aborted) throw err;
                        notes.write('pipeline_k', { version: PIPELINE_K_VERSION, failed: true, reason: errorMessage(err) });
                        notes.note(PROVENANCE.remeshed, `pipeline K: straightening the facade photos failed (${errorMessage(err)}); the facades are rebuilt on their photos as extracted`);
                    }
                }
            }
            // the scan cleaned and its rectified facades rebuilt on their photo's lines before it is textured (remesh-polish.ts)
            {
                // pipeline K: the base cleaned by the structure's footprint (Google's vector footprint, else the scan's own outline),
                // named by where its loops come from
                const kBase = pipelineK && isolateMode && structure ? (() => {
                    const vec = eBuildings.flatMap(b => (b.extruded?.length ? b.extruded.filter(p => !p.planOnly).map(p => p.loops[0]) : [])).filter(l => l && l.length >= 3);
                    return vec.length ? { loops: vec, source: footprintSource(eBuildings) } : { loops: [structure.outline], source: 'scan outline' };
                })() : undefined;
                const kLoops = kBase?.loops;
                // pipeline K's polish (the lattice, clip and infill: a minute and more) on a worker thread, in a heap of its own
                // (remesh-worker-pool.ts), unless SCRATCHBOX_REMESH_WORKERS=0; a lighter polish stays here, short of a thread's start
                const polishInput: PolishJobInput = { clayGlb: r.clayGlb, ...(r.texturedGlb ? { texturedGlb: r.texturedGlb } : {}), cacheKey: r.cacheKey, ...(r.reliefOrthosDir ? { orthosDir: r.reliefOrthosDir } : {}), ...(orthosKey ? { orthosKey, lattice: stepOn('polish.lattice', true), photoRecess: true } : {}), ...(windowFit ? { windowFit } : {}), ...(wallGrammar ? { wallGrammar } : {}), ...(wallSheets ? { walls: wallSheets } : {}), ...(pipelineK && r.rawClayGlb ? { rawScan: r.rawClayGlb } : {}), ...(revealDepth ? { revealDepth } : {}), ...(kLoops && stepOn('polish.base', true) ? { base: { loops: kLoops, groundY: structure!.groundY, ...(kBase?.source === 'scan outline' ? { scanOutline: true } : {}) } } : {}), ...(pipelineK && stepOn('polish.seal', process.env.SCRATCHBOX_K_SEAL?.trim() === '1') ? { seal: true } : {}), ...(pipelineK && stepOn('polish.clip', process.env.SCRATCHBOX_K_CLIP?.trim() !== '0') ? { clip: true } : {}), ...(pipelineK && stepOn('polish.infill', process.env.SCRATCHBOX_K_INFILL?.trim() !== '0') ? { infill: true } : {}), ...(pipelineK && stepOn('polish.latticeCut', process.env.SCRATCHBOX_K_LATTICE_CUT?.trim() !== '0') ? { latticeCut: true } : {}), ...(pipelineK && process.env.SCRATCHBOX_K_PROUD_REMOVE?.trim() === '0' ? { proudRemove: false } : {}), ...(pipelineK && isolateMode && stepOn('polish.closure', process.env.SCRATCHBOX_K_CLOSURE?.trim() !== '0') ? { closure: { joins: process.env.SCRATCHBOX_K_CORNER_JOIN?.trim() !== '0', core: process.env.SCRATCHBOX_K_CORE?.trim() !== '0', repair: process.env.SCRATCHBOX_K_HOLE_REPAIR?.trim() !== '0' } } : {}), ...(cpuShare ? { threads: cpuShare.threads } : {}), cleanup: stepOn('polish.cleanup', remeshCleanupEnabled()), orient: stepOn('polish.orient', remeshOrientEnabled()) };
                const onPolishStep = (step: string, state: 'running' | 'done' | 'failed') => logStep(`polish.${step}`, state);
                // the native infill runs inside the synchronous polish, so its binary is built first (remesh-polish-native.ts)
                const pol = await timed('polish', async () => { await ensureNativePolishFor(polishInput); return pipelineK && remeshWorkersEnabled() ? runRemeshJob<PolishedRemesh>({ kind: 'polish', input: polishInput }, { signal: io.signal, onStep: onPolishStep }) : polishRemesh({ ...polishInput, onStep: onPolishStep }); });
                for (const [name, file] of Object.entries(pol.snapshots)) stepFiles.push([`polish.${name}`, file]);
                // the steps turned off for this build, shown as skipped
                for (const key of ['polish.cleanup', 'polish.lattice', 'polish.latticeCut', 'polish.base', 'polish.clip', 'polish.infill', 'polish.seal', 'polish.orient', 'polish.closure', 'remesh.streetViewScore', 'remesh.visibleDefects']) if (request.steps?.[key] === false) logStep(key, 'skipped');
                // the clay's relief against Street View, before the polish and after it (streetview-clay-score.ts)
                if (pipelineK && surveyViews?.length && pol.clayGlb !== r.clayGlb && stepOn('remesh.streetViewScore', true)) {
                    try {
                        // on a remesh worker thread, as the polish (remesh-scores.ts)
                        const score = await timed('streetViewScore', () => streetViewClayScores(r.clayGlb, pol.clayGlb, surveyViews!, { signal: io.signal }));
                        notes.write('pipeline_k_streetview_score', { views: surveyViews.length, poses: 'nominal survey poses (±2 m), common to both', ...score });
                        notes.note(PROVENANCE.photoInferred, `clay against Street View (${surveyViews.length} photos, © Google): model edges ${score.before.modelToPhotoPx ?? '–'} → ${score.after.modelToPhotoPx ?? '–'} px from the photo's, photo edges ${score.before.photoToModelPx ?? '–'} → ${score.after.photoToModelPx ?? '–'} px from the model's (before → after the polish; lower is better)`);
                    } catch (err) {
                        if (isAbort(err) || io.signal.aborted) throw err;
                        notes.write('pipeline_k_streetview_score', { failed: true, reason: errorMessage(err) });
                    }
                }
                if (kBase) notes.write('pipeline_k_base', { loops: kBase.loops, groundY: structure!.groundY, footprint: kBase.source, report: pol.stats.base ?? null });
                if (pol.stats.closure) notes.write('pipeline_k_closure', pol.stats.closure);
                // the lattice's audits for the run's records: the tear audit, the proud audit and the cut (the benchmark reads them)
                if (pol.stats.lattice) notes.write('pipeline_k_lattice', { version: FACADE_LATTICE_VERSION, cut: !!pol.stats.lattice.cut, facades: pol.stats.lattice.facades, rebuilt: pol.stats.lattice.rebuilt, cells: pol.stats.lattice.cells, removedTriangles: pol.stats.lattice.removedTriangles, ...(pol.stats.lattice.cut ? { cutReport: pol.stats.lattice.cut } : {}), tears: pol.stats.lattice.tears ?? null, proud: pol.stats.lattice.proud ?? null });
                if (pol.clayGlb !== r.clayGlb) {
                    notes.note(PROVENANCE.remeshed, `remesh polish (${REMESH_POLISH_VERSION}): ${describePolish(pol.stats)}`);
                    r = { ...r, cacheKey: pol.cacheKey, clayGlb: pol.clayGlb, ...(pol.texturedGlb ? { texturedGlb: pol.texturedGlb } : {}) };
                }
                // the symmetry read above carried into the model's asset.extras (sbSymmetry), on copies beside the cached remesh
                if (symmetry) {
                    try {
                        r = { ...r, clayGlb: stampSymmetryGlb(r.clayGlb, symmetry), ...(r.texturedGlb ? { texturedGlb: stampSymmetryGlb(r.texturedGlb, symmetry) } : {}) };
                    } catch (err) {
                        notes.note(PROVENANCE.photoInferred, `the symmetry reading could not be written into the model's extras (${errorMessage(err)}); it stays in the run notes`);
                    }
                }
                // the build looked at from outside: holes seen on it are flagged here, where its geometry is final; untextured surface
                // is judged on the finished model in the texture stage, which still paints some of it (the party wall)
                if (pipelineK && isolateMode && pol.texturedGlb && stepOn('remesh.visibleDefects', true)) {
                    const seen = await timed('visibleDefects', () => visibleDefects(pol.texturedGlb!, { signal: io.signal }));
                    defectsSeen.set(stage, { holeShare: seen.holeShare, largestHoleRegionM2: seen.largestHoleRegionM2, why: seen.why });
                    notes.write('pipeline_k_visible_defects', { ...seen, views: seen.views.map(({ mask: _m, ...v }) => v), judged: 'holes (untextured surface is judged on the finished model: pipeline_k_visible_defects_textured)' });
                    if (seen.holesFlagged) degradations.push(notes.degrade(record(stage, 'visible_defects', {
                        part: { description: 'holes seen on the outside of the building' }, intended: 'every surface seen from outside closed',
                        fellTo: 'a hole where it shows', provenanceAfter: PROVENANCE.generated, reason: `from ${seen.views.length} views, ${/[\d.]+% through holes.*$/.exec(seen.why)?.[0] ?? seen.why}`, transient: false, runId, now: now()
                    })));
                }
            }
            return r;
        };
        const remesh = await runner.stage<RemeshValue>({
            id: 'remesh',
            run: async io => {
                if (eEligible) {
                    const e = await runPipelineE(io);
                    if (e) return e;
                }
                io.progress(isolateMode ? 'remeshing the structure' : 'remeshing the district');
                const tilePath = strip ? strip.devegetatedGlb : extraction.texturedGlb;
                // where the stage's time goes (the stage summary's breakdownMs)
                const remeshMs: Record<string, number> = {};
                const timed = async <R>(k: string, work: () => Promise<R>): Promise<R> => { const t0 = now(); logStep(`remesh.${k}`, 'running'); let ok = false; try { const v = await work(); ok = true; return v; } finally { remeshMs[k] = (remeshMs[k] ?? 0) + now() - t0; logStep(`remesh.${k}`, ok ? 'done' : 'failed'); } };
                // object ownership: outlines of the requested structure in registered views of the tile, voted onto its triangles
                // the shared structure pick: tile_refine isolates exactly this footprint on this terrain
                // (picked again, by the same rule at the same seed, on the scan tile_refine is given: with the measured trees
                // taken out it holds no crown the canopy classifier left in)
                let isolatePick: string | undefined;
                let remeshPick: { pick: StructurePickResult; ground: GroundModel } | undefined = isolateMode && t.ground ? { pick: structure!, ground: t.ground } : undefined;
                if (remeshPick && tilePath !== extraction.texturedGlb) remeshPick = pickOnScan(tilePath, structure!.seed, t.canopy, t.vector) ?? remeshPick;
                if (remeshPick) {
                    const bytesKey = crypto.createHash('sha256').update(remeshPick.pick.footprintMask).update(Buffer.from(Float32Array.from(remeshPick.ground.ground).buffer)).update(Buffer.from(Float32Array.from(remeshPick.ground.top).buffer)).digest('hex').slice(0, 16);
                    isolatePick = writeIsolationPick(path.join(path.dirname(tilePath), `structure_pick_${bytesKey}.sbip`), remeshPick.pick, remeshPick.ground);
                }
                // object ownership: the first isolate is the geometric rules' (footprint and connectivity), shown at once; the multi-view
                // mask vote (a dozen vision calls, as slow as the slowest) runs afterwards as its own stage and replaces this isolate
                // only when it changes the structure materially (ownership-change.ts)
                if (isolateMode && deps.refine.renderOwnershipViews) {
                    if (!visionAvailable) run.note(PROVENANCE.remeshed, 'object ownership: the geometric rules alone (footprint and connectivity) decide what belongs to the structure: no vision model is configured for the multi-view mask vote');
                    else run.note(PROVENANCE.remeshed, 'object ownership: the geometric rules (footprint and connectivity) decide what belongs to the structure in the first isolate; the multi-view mask vote runs beside the rest of the build and replaces it only when it changes the structure materially');
                }
                const reliefOpt = (request.relief ?? TILE_REFINE_RELIEF_DEFAULT) === false ? { relief: false } : {};
                remeshRequest = {
                    tilePath,
                    ...(isolateMode ? { isolate: true, anchor: { x: structure!.seed.x, z: structure!.seed.z }, ...(isolatePick ? { isolatePick } : {}) } : {}),
                    ...reliefOpt
                };
                // the facades' orthophotos for the grammar reading (facade-grammar.ts), only when it will run; pipeline K: the relief
                // carves nothing in the scan (its window recesses are carved on the rebuilt facades, from the straightened photos)
                // pipeline K: an occlusion mask beside each ortho (what stood in front of the facade when it was photographed),
                // cast against the scan before the tree strip took its crowns out, else the scan as loaded
                const occlusionOn = pipelineK && stepOn('remesh.occlusion', process.env.SCRATCHBOX_K_OCCLUSION?.trim() !== '0');
                const occlusion = occlusionOn ? { reliefOcclusion: tilePath !== extraction.texturedGlb ? extraction.texturedGlb : true } : {};
                const orthos = grammarOn || pipelineK ? { reliefOrthos: true, ...(pipelineK ? { reliefCarve: false, reliefAnalyse: false, ...occlusion } : {}) } : {};
                if (isolateMode && request.procedural !== true && deps.refine.renderOwnershipViews && visionAvailable) voteLater = { tilePath, ...(isolatePick ? { isolatePick } : {}), ...(remeshPick ? { pick: remeshPick } : {}), request: remeshRequest, orthos };
                let r = await timed('tileRefine', () => deps.refine.refine({ ...remeshRequest!, ...orthos }));
                logStep('remesh.occlusion', occlusionOn ? 'done' : 'skipped');
                // the model after each step that changed it, for the node graph (published once the layer is committed)
                const stepFiles: Array<[string, string]> = [['remesh.tileRefine', r.texturedGlb ?? r.clayGlb]];
                // the isolated structure must be the one picked; when it is not (or tile_refine wrote no isolated scan to
                // check), the district around it is remeshed whole and shown instead, labelled: never isolated fragments
                const isolateDegradations: DegradationRecord[] = [];
                if (isolateMode) {
                    let mismatch: string | undefined;
                    if (!r.rawClayGlb) mismatch = 'tile_refine wrote no isolated raw scan to compare with the structure picked';
                    else {
                        const picked = remeshPick?.pick ?? structure!;
                        const terrain = remeshPick?.ground ?? t.ground;
                        if (!terrain) mismatch = 'the structure was picked without a terrain to check the isolated scan against';
                        else {
                            const chk = checkIsolate(r.rawClayGlb, picked, terrain);
                            run.state.structure = { ...run.state.structure!, isolateIoU: round(chk.iou, 3), isolateAgreement: round(chk.agreement, 3) };
                            if (!chk.ok) {
                                const why = !chk.holdsSeed ? 'it does not hold the structure at the seed'
                                    : chk.precision < ISOLATE_PRECISION_MIN ? `only ${Math.round(chk.precision * 100)}% of it lies on the footprint picked`
                                    : chk.roofed < ISOLATE_ROOFED_MIN ? `only ${Math.round(chk.roofed * 100)}% of it is roofed (a shell of facades)`
                                    : `it covers only ${Math.round(chk.recall * 100)}% of the footprint picked (the ownership vote took the rest away)`;
                                mismatch = `tile_refine isolated a different structure than the one picked: ${why} (${Math.round(chk.areaM2)} m² isolated against ${Math.round(picked.areaM2)} m² picked, ${Math.round(chk.recall * 100)}% of the pick covered, seed ${structure!.seed.x}, ${structure!.seed.z})`;
                            }
                        }
                    }
                    if (mismatch) {
                        io.progress('remeshing the district around the structure');
                        let district: TileRefineResult | undefined, districtErr: unknown;
                        const districtRequest: TileRefineRequest = { tilePath, ...reliefOpt };
                        try { district = await timed('tileRefineDistrict', () => deps.refine.refine({ ...districtRequest, ...orthos })); } catch (err) { districtErr = err; }
                        // the grammar is read from, and applied to, the remesh that stands
                        if (district) remeshRequest = districtRequest;
                        isolateDegradations.push(run.degrade(record('remesh', 'isolate_mismatch', {
                            part: { description: 'the isolated structure' }, intended: 'a scan-fitted rebuild of the structure picked',
                            fellTo: district ? 'the remeshed district around it, whole, without a rebuild' : 'the isolated remesh, without a rebuild',
                            provenanceAfter: PROVENANCE.remeshed,
                            reason: district ? `${mismatch}, so the district around it is shown whole instead of a partial isolate, and nothing is rebuilt`
                                : `${mismatch}; remeshing the district failed too (${errorMessage(districtErr)}), so the isolated remesh stands, without a rebuild`,
                            ...(districtErr ? { cause: districtErr } : {}), transient: false, runId, now: now()
                        })));
                        if (district) r = district;
                    }
                }
                r = await finishRefine(r, io, timed, stepFiles, isolateDegradations, 'remesh');
                run.keys.remesh = r.cacheKey;
                run.cacheStatus.remesh = r.cached ? 'hit' : 'miss';
                const key8 = r.cacheKey.slice(0, 8);
                const remembered = cache.remember('remesh', r.cacheKey, { clay: r.clayGlb }, [{ from: r.clayGlb, as: `${base}_remesh_${key8}.glb` }], { ms: r.ms });
                const pub = remembered.published[0];
                const prov = readRemeshProvenance(r.clayGlb);
                const vertexText = describeRemeshProvenance(prov.summary);
                const note = remeshNote(r.stats, vertexText, strip?.stats);
                const labels: ProvenanceLabel[] = [PROVENANCE.remeshed];
                if ((prov.summary.proudBlocks?.keptAsScannedVertices ?? 0) > 0) labels.push(PROVENANCE.asScanned);
                if ((prov.summary.relief?.carvedVertices ?? 0) > 0) labels.push(PROVENANCE.photoInferred);
                run.note(PROVENANCE.remeshed, `tile_refine remesh: ${note || 'no change beyond the remesh itself'}`);
                const l1 = currentL1()!;
                const remeshCounts = layerCounts(r.clayGlb);
                // the layer is measured only where the scan is: vertices carved by photo relief are inferred, and the record says so
                const carved = prov.summary.relief?.carvedVertices ?? 0;
                const reliefShare = carved > 0 && remeshCounts.vertices > 0 ? Math.min(1, carved / remeshCounts.vertices) : 0;
                const layer: StagedLayer = {
                    objectId: layerObjectId(r.cacheKey, 'l2'), stage: 'remesh', layer: 'l2', order: STAGES.remesh.order, url: pub.url, bytes: pub.bytes,
                    provenance: {
                        label: PROVENANCE.remeshed, measuredGeometry: carved === 0,
                        ...(carved > 0 ? { confidence: round(1 - reliefShare, 4), inferred: { reliefCarvedVertices: carved, reliefMaxAbsHeightM: prov.summary.relief!.maxAbsHeightM } } : {}),
                        method: `tile_refine: hidden shells culled, facades rectified and flattened, cracks closed${(request.relief ?? TILE_REFINE_RELIEF_DEFAULT) ? ', photometric relief (inferred, gated)' : ''}`,
                        sources: [{ kind: 'stage-output', id: `remesh:${key8}` }], ...(note ? { note } : {})
                    },
                    provenanceLabels: labels, vertexProvenance: prov.summary, supersedes: [l1.objectId], revealAfter: [],
                    reveal: { durationMs: 800, stagger: 0, crossfadeFrom: [l1.objectId] },
                    cached: r.cached, builtAtMs: remembered.builtAtMs, counts: remeshCounts
                };
                run.commit(layer, {
                    source: 'Google3DTilesClay', resolvedAddress: placeValue!.formattedAddress,
                    // the trees measured in the photo tiles were taken out of this model (and are regrown in the trees layer)
                    extra: { rawGlbPath: extraction.rawGlbPath ?? extraction.texturedGlb, treesRemoved: Number(strip?.stats?.triangles?.removed ?? 0) > 0 }
                });
                run.setGround(layer.objectId);
                // one file per place and step, so the next run's snapshot replaces this one (only the latest run is kept)
                for (const [key, file] of stepFiles) {
                    try {
                        const snap = cache.publishFile(file, `${base}_step_${key.replace('.', '_')}.glb`);
                        run.stepSnapshot(key, { url: snap.url, bytes: snap.bytes, frameOf: [layer.objectId, l1.objectId] });
                    } catch { /* a snapshot is a view of the build, never part of it */ }
                }
                const degradations: DegradationRecord[] = [...isolateDegradations];
                refineTextured.set(layer.objectId, r.texturedGlb);
                let status: 'committed' | 'degraded' = 'committed';
                if (degradations.length) status = 'degraded';
                return {
                    status, value: { refined: r, groundLayerId: layer.objectId, groundFile: r.clayGlb, committed: true },
                    source: `tile_refine: ${layer.counts.triangles.toLocaleString('en-US')} triangles${prov.summary.relief?.carvedVertices ? `, ${prov.summary.relief.carvedVertices} vertices carved by photo relief (photo-inferred)` : ''}`,
                    layers: [layer], degradations, cached: r.cached, builtAtMs: remembered.builtAtMs, breakdownMs: remeshMs
                };
            },
            degrade: async (err, io) => {
                const why = errorMessage(err);
                const l1 = currentL1()!;
                if (deps.scanFit) {
                    try {
                        const f = await deps.scanFit.flatten({ inputGlb: extraction.texturedGlb, ...(structure ? { footprint: structure.outline } : {}), signal: io.signal });
                        const pub = cache.publishFile(f.glb, `${base}_flattened_${f.key.slice(0, 8)}.glb`);
                        const layer: StagedLayer = {
                            objectId: layerObjectId(f.key, 'l2'), stage: 'remesh', layer: 'l2', order: STAGES.remesh.order, url: pub.url, bytes: pub.bytes,
                            provenance: {
                                label: PROVENANCE.scanFlattened, measuredGeometry: true, method: 'scan_fit flatten: vertices within 0.10 m of a fitted plane moved onto it; nothing added',
                                sources: [{ kind: 'stage-output', id: `flatten:${f.key.slice(0, 8)}` }],
                                note: `${f.value.movedVertices.toLocaleString('en-US')} vertices moved onto ${f.value.planes} planes (max ${f.value.maxMoveM.toFixed(2)} m, p95 ${f.value.p95MoveM.toFixed(2)} m)`
                            },
                            provenanceLabels: [PROVENANCE.scanFlattened], supersedes: [l1.objectId], revealAfter: [],
                            reveal: { durationMs: 800, stagger: 0, crossfadeFrom: [l1.objectId] }, cached: f.cached, builtAtMs: f.builtAtMs, counts: layerCounts(f.glb)
                        };
                        run.commit(layer, { source: 'Google3DTilesClay', resolvedAddress: placeValue!.formattedAddress });
                        run.setGround(layer.objectId);
                        return {
                            status: 'degraded', value: { flattened: f, groundLayerId: layer.objectId, groundFile: f.glb, committed: false }, source: 'the raw scan with its facades flattened',
                            reason: `the remesh failed (${why}); the raw scan with its facades flattened stands in, its scanned trees kept`, layers: [layer],
                            degradations: [run.degrade(record('remesh', 'remesh_failed', {
                                part: { description: isolateMode ? 'the structure' : 'the district' }, intended: 'the remeshed scan', fellTo: 'the raw scan with its facades flattened, its scanned trees kept in it',
                                provenanceAfter: PROVENANCE.scanFlattened, reason: `tile_refine failed (${why}); the raw scan with its facades flattened stands in, and its scanned trees stay in it`, cause: err, transient: true, runId, now: now(), reuses: ['resolve', 'tiles', 'trees-measure']
                            }))]
                        };
                    } catch (flattenErr) {
                        run.degrade(record('remesh', 'flatten_failed', {
                            part: { description: isolateMode ? 'the structure' : 'the district' }, intended: 'the raw scan with its facades flattened', fellTo: 'the raw scan as downloaded',
                            provenanceAfter: PROVENANCE.asScanned, reason: `flattening the raw scan failed too (${errorMessage(flattenErr)})`, cause: flattenErr, transient: scanFitTransient(flattenErr), runId, now: now()
                        }));
                    }
                }
                run.setGround(l1.objectId);
                return {
                    status: 'degraded', value: { groundLayerId: l1.objectId, groundFile: extraction.geometryGlb, committed: false }, source: 'the raw scan as downloaded',
                    reason: `the remesh failed (${why}); the raw scan as downloaded stays, its scanned trees in it`,
                    degradations: [run.degrade(record('remesh', 'remesh_failed', {
                        part: { description: isolateMode ? 'the structure' : 'the district' }, intended: 'the remeshed scan',
                        fellTo: deps.scanFit ? 'the raw scan as downloaded' : 'the raw scan as downloaded (facade flattening, scan_fit, is not in this build)',
                        provenanceAfter: PROVENANCE.asScanned, reason: `tile_refine failed (${why}); the raw scan as downloaded stays, and its scanned trees stay in it`, cause: err, transient: true, runId, now: now(), reuses: ['resolve', 'tiles', 'trees-measure']
                    }))]
                };
            }
        });
        persist();
        // what this pass built on the remesh is ended when the ownership vote replaces it (Runner.passSignal)
        let passStop = new AbortController();
        runner.passSignal = () => passStop.signal;
        // the remesh the rest of the build stands on: the first isolate, until the ownership vote replaces it (a second pass)
        let remeshedNow = remesh.status !== 'stopped' && remesh.value?.committed === true ? remesh.value.refined : undefined;
        let isolateOk = isolateMode && !!remeshedNow?.rawClayGlb && !run.state.degradations.some(d => d.reasonCode === 'isolate_mismatch');
        let groundOverride: { groundFile: string; groundLayerId: string } | undefined;

        // ---------------- ownership: the multi-view mask vote, run after the first (geometric) isolate is shown ----------------
        type VoteOutcome = { material: boolean; refined?: TileRefineResult; request: TileRefineRequest; isolateOk: boolean; layer?: StagedLayer };
        const ownershipRun = async (v: NonNullable<typeof voteLater>): Promise<VoteOutcome | undefined> => {
            const r = await runner.stage<VoteOutcome>({
                id: 'ownership',
                // pipeline K: a material vote also runs the remesh's facade work and polish on the voted remesh (finishRefine)
                budgetMs: STAGES.ownership.budgetMs + (pipelineK ? STAGES.remesh.budgetMs : 0),
                run: async io => {
                    const msBy: Record<string, number> = {};
                    const timedAs = (group: string) => async <R>(k: string, work: () => Promise<R>): Promise<R> => { const t0 = now(); logStep(`${group}.${k}`, 'running'); let ok = false; try { const v = await work(); ok = true; return v; } finally { msBy[k] = (msBy[k] ?? 0) + now() - t0; logStep(`${group}.${k}`, ok ? 'done' : 'failed'); } };
                    const timed = timedAs('ownership');
                    const first = remeshedNow;
                    const firstLayer = currentRemeshLayer(run);
                    if (!first || !firstLayer) return { status: 'skipped', source: '', reason: 'the remesh committed nothing to compare the vote with' };
                    const firstWasIsolate = isolateOk;
                    const notUsed = (reasonCode: string, reason: string, cause?: unknown): StageResult<VoteOutcome> => ({
                        status: 'degraded', value: { material: false, request: v.request, isolateOk: firstWasIsolate }, source: 'the geometric isolate stands', reason, breakdownMs: msBy,
                        degradations: [run.degrade(record('ownership', reasonCode, {
                            part: { description: 'what belongs to the structure' }, intended: 'object ownership by multi-view mask voting', fellTo: 'the structure as the geometric rules isolate it (footprint and connectivity)',
                            provenanceAfter: PROVENANCE.remeshed, reason, ...(cause ? { cause } : {}), transient: false, runId, now: now()
                        }))]
                    });
                    let masksDir: string, seg: Pick<Awaited<ReturnType<typeof segmentOwnershipViews>>, 'masks' | 'views' | 'skipped' | 'model' | 'cut'>;
                    let readBack: string | undefined;
                    // The vote as it went ahead is read back for an identical later vote (the same first isolate, place and models):
                    // its outlines, and which views cast none and why (cut by the quorum or the window, not visible, unreadable).
                    // The rule: a view the vote went ahead without stays "not voted" in the provenance of every repeat; the record is
                    // kept so a repeat does not ask those views live, which gave them outlines, a new set of masks, a new tile_refine
                    // key and a new remesh, and ran the grammar, the rebuild and the textures again on it (warm Haughwout 44 -> 70 s,
                    // docs/processes/vision_call_hedging.md). The vote is asked again only for a different first isolate (a new key)
                    // or when the ownership stage is bypassed.
                    const voteKey = stageKey('ownership-vote/v2', first.cacheKey, request.query.trim(), visionAvailable!.candidates, OWNERSHIP_VOTE_WINDOW_MS);
                    type VoteRecord = { masksDir: string; masks: number; views: number; model?: string; skipped: Array<{ view: string; reason: string }>; cut?: NonNullable<typeof seg.cut>; runId: string };
                    const voteHit = !bypass('ownership') ? cache.get<VoteRecord>('ownership', voteKey) : undefined;
                    if (voteHit && fs.existsSync(path.join(voteHit.value.masksDir, 'views.txt'))) {
                        masksDir = voteHit.value.masksDir;
                        const notVoted = voteHit.value.skipped ?? [];
                        seg = { masks: voteHit.value.masks, views: voteHit.value.views, skipped: notVoted, ...(voteHit.value.model ? { model: voteHit.value.model } : {}), ...(voteHit.value.cut ? { cut: voteHit.value.cut } : {}) };
                        readBack = `read back from the vote of run ${voteHit.value.runId}${notVoted.length ? `; ${notVoted.length} of ${seg.views} views still cast no vote (${notVoted.map(x => `${x.view}: ${x.reason}`).join('; ')})` : ''}`;
                        io.progress(`ownership vote: ${seg.masks} of ${seg.views} outlines ${readBack}`);
                        run.cacheStatus.ownership = 'hit';
                    } else try {
                        io.progress('rendering views of the structure for the ownership vote');
                        const views = await timed('ownershipViews', () => deps.refine.renderOwnershipViews!({ tilePath: v.tilePath, isolate: true, anchor: { x: structure!.seed.x, z: structure!.seed.z }, ...(v.isolatePick ? { isolatePick: v.isolatePick } : {}) }));
                        masksDir = path.join(views.dir, `masks_${crypto.createHash('sha256').update(request.query.trim()).digest('hex').slice(0, 16)}`);
                        // the views not outlined within OWNERSHIP_VOTE_WINDOW_MS are left out (their triangles keep the geometric rules):
                        // one late call (live: 299 s) must not hold the build's finish
                        const cut = new AbortController();
                        const cutTimer = setTimeout(() => cut.abort(Object.assign(new Error(`not outlined within the vote's ${Math.round(OWNERSHIP_VOTE_WINDOW_MS / 1000)} s`), { name: 'TimeoutError' })), OWNERSHIP_VOTE_WINDOW_MS);
                        const chain = new VisionModelChain<string>({ client: visionAvailable!.client, candidates: visionAvailable!.candidates, signal: ctx.signal ? AbortSignal.any([ctx.signal, cut.signal]) : cut.signal, ...chainExtras('remesh'), ...(deps.sleep ? { sleep: deps.sleep } : {}) });
                        try {
                            // 12 at once; from 30 s on the vote goes ahead on a quorum of outlines (OWNERSHIP_VOTE_RULE), the window is the backstop
                            seg = await timed('ownershipVision', () => segmentOwnershipViews({ viewsDir: views.dir, masksDir, target: request.query.trim(), chain, concurrency: 12, onProgress: m => io.progress(m), ...(bypass('ownership') ? {} : { readings: modelReadingsStore() }) }));
                        } finally {
                            clearTimeout(cutTimer);
                        }
                        if (ctx.signal?.aborted) throw abortError();
                        if (cut.signal.aborted) io.progress(`ownership vote: ${seg.masks} of ${seg.views} views outlined within ${Math.round(OWNERSHIP_VOTE_WINDOW_MS / 1000)} s; the others are left out`);
                        if (seg.masks < 2) throw new Error(`only ${seg.masks} of ${seg.views} views got a usable outline (${seg.skipped.slice(0, 3).map(x => `${x.view}: ${x.reason}`).join('; ')})`);
                        const outlines: VoteRecord = { masksDir, masks: seg.masks, views: seg.views, ...(seg.model ? { model: seg.model } : {}), skipped: seg.skipped, ...(seg.cut ? { cut: seg.cut } : {}), runId };
                        await cache.run('ownership', voteKey, async () => ({ value: outlines }), { bypass: true });
                        run.cacheStatus.ownership = 'miss';
                    } catch (err) {
                        if (isAbort(err) || io.signal.aborted) throw err;
                        return notUsed('ownership_vote_unavailable', `the multi-view mask vote could not be made (${errorMessage(err)}); the geometric isolate stands`, err);
                    }
                    const votedRequest: TileRefineRequest = { ...v.request, ownership: { masksDir } };
                    // the vote is judged on its isolate alone (the raw scan the vote keeps, seconds: tile_refine stops after the
                    // isolate), and tile_refine runs whole, with the facade orthos the rebuild reads, only for a vote that replaces
                    // the first isolate. Without the isolate-only run, one whole refine (with the orthos) is judged instead
                    let voted: TileRefineResult | undefined;
                    let isolated: { rawClayGlb?: string };
                    if (deps.refine.isolate) isolated = await timed('isolate', () => deps.refine.isolate!({ ...votedRequest }));
                    else isolated = voted = await timed('tileRefine', () => deps.refine.refine({ ...votedRequest, ...v.orthos }));
                    const picked = v.pick?.pick ?? structure!;
                    const terrain = v.pick?.ground ?? t.ground;
                    if (!isolated.rawClayGlb || !terrain) return notUsed('ownership_vote_not_used', 'tile_refine wrote no voted isolate to check; the geometric isolate stands');
                    const chk = checkIsolate(isolated.rawClayGlb, picked, terrain);
                    if (!chk.ok) return notUsed('ownership_vote_not_used', `the voted isolate is not the structure picked (${Math.round(chk.recall * 100)}% of the pick covered, ${Math.round(chk.precision * 100)}% of it on the pick, ${Math.round(chk.roofed * 100)}% roofed); the geometric isolate stands`);
                    // how much the vote moved: compared on the isolates' raw scan triangles (a first isolate that fell back to the district is replaced outright)
                    const change = firstWasIsolate && first.rawClayGlb ? ownershipChange(first.rawClayGlb, isolated.rawClayGlb) : undefined;
                    const moved = change ? `${round(change.share * 100, 1)}% of the structure's scan surface (${round(change.onlySecondM2, 1)} m² joined, ${round(change.onlyFirstM2, 1)} m² left)` : 'the first isolate had fallen back to the district around the structure';
                    const notVoted = seg.skipped.filter(x => !seg.cut?.views.includes(x.view));
                    const ownershipNote = `object ownership: ${seg.model ?? 'the vision model'} outlined the structure in ${seg.masks} of ${seg.views} views of the tile${seg.cut ? ` (${seg.cut.note})` : ''}${notVoted.length ? ` (no vote from ${notVoted.map(x => `${x.view}: ${x.reason}`).join('; ')})` : ''}${readBack ? ` (${readBack})` : ''}; the vote moved ${moved}`;
                    run.note(PROVENANCE.remeshed, ownershipNote);
                    if (change && !change.material) {
                        return {
                            status: 'committed', value: { material: false, request: votedRequest, isolateOk: true }, breakdownMs: msBy,
                            source: `the vote moved ${moved}, under the ${Math.round(OWNERSHIP_MATERIAL_SHARE * 100)}% that would replace the geometric isolate; the first isolate and everything built on it stand (the vote's own remesh is not shown)`
                        };
                    }
                    // material: the voted remesh replaces the first isolate and what was built on it (the rebuild runs again on it),
                    // refined once, with the facade orthos the rebuild reads
                    voted ??= await timed('tileRefine', () => deps.refine.refine({ ...votedRequest, ...v.orthos }));
                    // pipeline K: the facades the vote left unchanged (the same plane, no scan moved near it, the same photo:
                    // facade-reuse.ts) keep the first isolate's straightened photo, reading, window fit and arrays; only the
                    // others are read and fitted again. SCRATCHBOX_K_FACADE_REUSE=0 reads every facade again
                    const firstPass = facadePasses.get('remesh');
                    let reusePlan: FacadeReusePlan | undefined;
                    if (pipelineK && change && firstPass && voted.reliefOrthosDir && process.env.SCRATCHBOX_K_FACADE_REUSE?.trim() !== '0') {
                        const votedOrthos = voted.reliefOrthosDir;
                        try { reusePlan = await timed('facadeMatch', async () => planFacadeReuse(firstPass.rawDir, votedOrthos, change.moved, change.movedAreas)); }
                        catch (err) { if (isAbort(err) || io.signal.aborted) throw err; io.progress(`facade reuse: the facades could not be matched (${errorMessage(err)}); every facade is read again`); }
                    }
                    // pipeline K: the voted remesh gets K's facade work and polish (its base cleanup and clip to the footprint) as the
                    // first isolate did, under the remesh's step names, so the node graph shows the voted build's steps. Its notes and
                    // degradations are held until it is committed: a vote that ends before then leaves the first isolate's in place
                    // (the texture pass reads its orthos from the pipeline_k note)
                    const voteSteps: Array<[string, string]> = [['ownership.tileRefine', voted.texturedGlb ?? voted.clayGlb]];
                    const voteDegradations: DegradationRecord[] = [];
                    const held: Array<() => void> = [];
                    if (pipelineK) {
                        const heldNotes: RefineNotes = { write: (name, data) => held.push(() => cache.writeRunNote(runId, name, data)), note: (label, text) => held.push(() => run.note(label, text)), degrade: rec => { held.push(() => run.degrade(rec)); return rec; } };
                        if (reusePlan) heldNotes.write('pipeline_k_facade_reuse', { version: FACADE_REUSE_VERSION, first: firstPass!.rawDir, voted: voted.reliefOrthosDir, kept: reusePlan.kept.length, changed: reusePlan.changed.length, keptAreaM2: reusePlan.keptAreaM2, changedAreaM2: reusePlan.changedAreaM2, params: reusePlan.params, facades: [...reusePlan.kept.map(x => ({ ...x, outcome: 'kept' })), ...reusePlan.changed.map(x => ({ ...x, outcome: 'changed' }))] });
                        if (reusePlan) heldNotes.note(PROVENANCE.photoInferred, `facade reuse (${FACADE_REUSE_VERSION}): ${reusePlan.kept.length} of ${reusePlan.kept.length + reusePlan.changed.length} facades (${reusePlan.keptAreaM2} of ${reusePlan.keptAreaM2 + reusePlan.changedAreaM2} m² covered) the vote left unchanged keep the first isolate's straightened photo, reading, window fit and arrays; the other ${reusePlan.changed.length} are read and fitted again`);
                        const reuse = reusePlan?.kept.length && firstPass ? { plan: reusePlan, first: firstPass } : undefined;
                        voted = await finishRefine(voted, io, timedAs('remesh'), voteSteps, voteDegradations, 'ownership', heldNotes, reuse);
                        // the vote decides what belongs to the structure; it may not tear it. Its build is kept only when the outside
                        // audit sees it no more torn than the first isolate's (scan the vote took away that no rebuild covered opens
                        // the base or a face: Penn 2, 2026-11-07, a 475 m² hole against 86 m²); else the first isolate stands
                        const firstSeen = defectsSeen.get('remesh'), votedSeen = defectsSeen.get('ownership');
                        if (firstSeen && votedSeen && (votedSeen.holeShare > firstSeen.holeShare + OWNERSHIP_TEAR_TOLERANCE || votedSeen.largestHoleRegionM2 > Math.max(firstSeen.largestHoleRegionM2, VISIBLE_DEFECTS_PARAMS.maxHoleRegionM2))) {
                            return notUsed('ownership_vote_torn', `the voted build is more torn than the first isolate (holes on ${round(votedSeen.holeShare * 100, 2)}% of it against ${round(firstSeen.holeShare * 100, 2)}%, the largest ${round(votedSeen.largestHoleRegionM2, 1)} m² against ${round(firstSeen.largestHoleRegionM2, 1)} m²): the vote took away scan no rebuild covers; the geometric isolate stands`);
                        }
                    }
                    run.keys.remesh = voted.cacheKey;
                    const key8 = voted.cacheKey.slice(0, 8);
                    const remembered = cache.remember('remesh', voted.cacheKey, { clay: voted.clayGlb }, [{ from: voted.clayGlb, as: `${base}_remesh_${key8}.glb` }], { ms: voted.ms });
                    const pub = remembered.published[0];
                    const prov = readRemeshProvenance(voted.clayGlb);
                    const carved = prov.summary.relief?.carvedVertices ?? 0;
                    const counts = layerCounts(voted.clayGlb);
                    const reliefShare = carved > 0 && counts.vertices > 0 ? Math.min(1, carved / counts.vertices) : 0;
                    const builtOnFirst = run.state.layers.filter(l => !l.retired && l.objectId !== firstLayer.objectId && ['grammar', 'fit', 'correct', 'detail', 'figures'].includes(l.stage)).map(l => l.objectId);
                    const layer: StagedLayer = {
                        objectId: layerObjectId(voted.cacheKey, 'l2v'), stage: 'ownership', layer: 'l2v', order: STAGES.remesh.order, url: pub.url, bytes: pub.bytes,
                        provenance: {
                            label: PROVENANCE.remeshed, measuredGeometry: carved === 0,
                            ...(carved > 0 ? { confidence: round(1 - reliefShare, 4), inferred: { reliefCarvedVertices: carved, reliefMaxAbsHeightM: prov.summary.relief!.maxAbsHeightM } } : {}),
                            method: `tile_refine with the multi-view ownership vote: ${seg.model ?? 'the vision model'}'s outlines in ${seg.masks} views decide the raised triangles near the structure, the geometric rules the rest${pipelineK ? "; then pipeline K's facade work and polish, its base cleaned and clipped to the footprint, as on the first isolate" : ''}`,
                            sources: [{ kind: 'stage-output', id: `remesh:${key8}` }], note: `the vote moved ${moved}; it replaces the first isolate and the rebuild runs again on it`
                        },
                        provenanceLabels: [PROVENANCE.remeshed, ...((prov.summary.proudBlocks?.keptAsScannedVertices ?? 0) > 0 ? [PROVENANCE.asScanned] : []), ...(carved > 0 ? [PROVENANCE.photoInferred] : [])],
                        vertexProvenance: prov.summary, supersedes: [firstLayer.objectId, ...builtOnFirst], revealAfter: [],
                        reveal: { durationMs: 800, stagger: 0, crossfadeFrom: [firstLayer.objectId, ...builtOnFirst] }, cached: voted.cached, builtAtMs: remembered.builtAtMs, counts
                    };
                    run.commit(layer, { source: 'Google3DTilesClay', resolvedAddress: placeValue!.formattedAddress, extra: { rawGlbPath: extraction.rawGlbPath ?? extraction.texturedGlb, treesRemoved: Number(strip?.stats?.triangles?.removed ?? 0) > 0 } });
                    run.setGround(layer.objectId);
                    refineTextured.set(layer.objectId, voted.texturedGlb);
                    if (pipelineK) {
                        // the voted build's notes, and its steps' snapshots, in place of the first isolate's (one file per place and step);
                        // the ownership summary stays the remesh legend's last word, as without K
                        for (const flush of held) flush();
                        run.note(PROVENANCE.remeshed, ownershipNote);
                        for (const [key, file] of voteSteps) {
                            try {
                                const snap = cache.publishFile(file, `${base}_step_${key.replace('.', '_')}.glb`);
                                run.stepSnapshot(key, { url: snap.url, bytes: snap.bytes, frameOf: [layer.objectId, firstLayer.objectId] });
                            } catch { /* a snapshot is a view of the build, never part of it */ }
                        }
                    }
                    // what this pass still has running on the first isolate is set aside: the next pass builds it on the voted remesh
                    passStop.abort('the ownership vote replaced the first isolate, so this stage runs again on the voted remesh');
                    run.state.structure = { ...run.state.structure!, isolateIoU: round(chk.iou, 3), isolateAgreement: round(chk.agreement, 3) };
                    return {
                        status: voteDegradations.length ? 'degraded' : 'committed', value: { material: true, refined: voted, request: votedRequest, isolateOk: true, layer }, layers: [layer], breakdownMs: msBy, cached: voted.cached, ...(voteDegradations.length ? { degradations: voteDegradations } : {}),
                        source: `the vote moved ${moved} (at least ${Math.round(OWNERSHIP_MATERIAL_SHARE * 100)}%): the voted remesh replaces the first isolate and the rebuild runs again on it`
                    };
                },
                // the vote never fails the build: the geometric isolate stands, and says why
                degrade: async err => ({
                    status: 'degraded', value: { material: false, request: v.request, isolateOk }, source: 'the geometric isolate stands', reason: `the ownership vote did not finish (${errorMessage(err)}); the geometric isolate stands`,
                    degradations: [run.degrade(record('ownership', 'ownership_vote_unavailable', {
                        part: { description: 'what belongs to the structure' }, intended: 'object ownership by multi-view mask voting', fellTo: 'the structure as the geometric rules isolate it (footprint and connectivity)',
                        provenanceAfter: PROVENANCE.remeshed, reason: `the ownership vote did not finish (${errorMessage(err)}); the geometric isolate stands`, cause: err, transient: true, runId, now: now()
                    }))]
                })
            });
            return r.status === 'stopped' ? undefined : r.value;
        };

        // ---------------- pipeline E inference (the grammar stage's slot): roof, bands, windows, bays, fill, straightening, colour ----------------
        // one Street View survey of the structure for a stage: the views registered against the tile mesh and cut out by the
        // ownership and occluder masks, with their obstruction-free copies (pipeline E's inference)
        const streetSurveyFor = (e: NonNullable<typeof eState>, io: { progress(m: string): void; signal: AbortSignal }, structureMesh: ReturnType<typeof sceneToRenderMesh>, maxViews = ENHANCE_STREET_VIEWS) => {
            const sv = streetView ?? {};
            const segmenter = process.env.SCRATCHBOX_TEXTURE_OWNERSHIP === '0' ? false : deps.textures?.segmenter
                ?? objectSegmenter(visionAvailable ? { modelSource: { getGenAIClient: async () => visionAvailable.client, getModelCandidates: () => visionAvailable.candidates } } : {});
            // one Street View survey for both uses below: the views registered against the tile mesh (edges, then jointly) and
            // cut out by the ownership and occluder masks (streetview-registered-views.ts). The colour step used to fetch its own
            // views at nominal poses (about ±2 m): at the Haughwout the projection fell on the neighbours and 3 of 4 were refused.
            // The context for the masks is the tile mesh without the structure's own scan: the melted scan bulging past the
            // massing plane is not something in front of it.
            let survey: Promise<Awaited<ReturnType<typeof registeredSurveyViews>>> | undefined;
            const registeredSurvey = !missingCredentials(sv) && segmenter ? () => {
                survey ??= (async () => {
                    const found = await discoverOnce();
                    const usable = found.panos.filter(p => !sv.refusedPanos?.has(p.panoId));
                    io.progress(`pipeline E: surveying the facades with Street View (${usable.length} Google panos near; registered views)`);
                    const tileMesh = sceneToRenderMesh(readGlbScene(extraction.geometryGlb));
                    const context = e.refined.rawClayGlb && fs.existsSync(e.refined.rawClayGlb) ? contextWithoutStructure(tileMesh, sceneToRenderMesh(readGlbScene(e.refined.rawClayGlb))) : tileMesh;
                    const got = await registeredSurveyViews({
                        site: { structure: structure!, ground: t.ground!, unmaskedTop: t.unmaskedTop ?? t.ground!.top }, panos: usable, maxViews, streetLevel: true,
                        sv: { ...sv, refusedPanos: sv.refusedPanos ?? new Map<string, string>() }, tileMeshFiles: [extraction.geometryGlb], structureMesh,
                        context, segment: segmenter, ...(visionAvailable ? { target: request.query } : {}),
                        ...(process.env.SCRATCHBOX_OWNERSHIP_DEBUG_DIR ? { debugDir: path.join(process.env.SCRATCHBOX_OWNERSHIP_DEBUG_DIR, runId, 'survey') } : {}),
                        // the views' obstruction-free copies, for the image model's references (streetview-clean.ts)
                        ...(deps.textures?.enhance ? { clean: { client: deps.textures.enhance, models: [LIGHTING_MODEL_FULL, LIGHTING_MODEL_LITE], cacheDir: path.join(cache.dir, 'streetview_clean') } } : {}),
                        signal: io.signal, onProgress: m => io.progress(`pipeline E: Street View: ${m}`)
                    });
                    if (got.images.length) run.state.attribution = [...new Set([...run.state.attribution, 'Street View ©Google'])];
                    cache.writeRunNote(runId, 'pipeline_e_enhance_streetview', {
                        views: got.views.map(v => ({ panoId: v.panoId, faceId: v.faceId, registration: v.registration, ownership: v.ownership?.status, prompts: v.ownership?.prompts, iou: v.ownership?.iou, ownedPixels: v.ownerMask?.reduce((a, x) => a + (x ? 1 : 0), 0) ?? 0, occluders: v.ownership?.occluders, ...(v.clean ? { clean: v.clean } : {}) })),
                        refusals: got.refusals, failures: got.failures, registrationError: got.registrationError, registration: got.registration, ms: got.ms, panosNear: usable.length, contextCut: context !== tileMesh
                    });
                    cache.writeRunNote(runId, 'pipeline_e_ownership', { records: got.views.map(v => v.ownership).filter(Boolean), panos: got.images.map(i => i.view.panoId) });
                    return got;
                })();
                return survey;
            } : undefined;
            return registeredSurvey;
        };

        const eInferenceRun = async (e: NonNullable<typeof eState>): Promise<{ out: InferenceOutcome; layer: StagedLayer } | undefined> => {
            if (!pipelineEInference()) { runner.skip('grammar', 'pipeline E without inference (SCRATCHBOX_STAGED_PIPELINE_E_INFERENCE=0)'); return undefined; }
            let done: { out: InferenceOutcome; layer: StagedLayer } | undefined;
            await runner.stage<{ steps: StepRecord[] }>({
                id: 'grammar',
                run: async io => {
                    const t0 = now();
                    const r = e.stage;
                    const chain = visionAvailable ? new VisionModelChain<string>({ client: visionAvailable.client, candidates: visionAvailable.candidates, signal: ctx.signal, ...chainExtras('grammar'), ...(deps.sleep ? { sleep: deps.sleep } : {}) }) : undefined;
                    const structureMesh = sceneToRenderMesh(readGlbScene(r.files!.clayGlb));
                    const registeredSurvey = streetSurveyFor(e, io, structureMesh);
                    const streetViews = registeredSurvey ? async () => (await registeredSurvey()).views : undefined;
                    const crowns = strip ? crownsFromStrip(JSON.parse(fs.readFileSync(strip.crownsJson, 'utf8'))) : [];
                    const enhanceOn = request.enhance ?? stagedEnhance();
                    // enhanced mode's guidance and check of each wall's redraw use the same registered views (plate-streetview.ts)
                    const guideViews = enhanceOn && enhanceGuards() && registeredSurvey ? async () => (await registeredSurvey()).views : undefined;
                    const enhance = deps.textures?.enhance;
                    const inferenceInput: Parameters<typeof runInferenceE>[0] = {
                        massing: r.massing, run: r.run!, textures: r.textures!, tilePath: strip ? strip.devegetatedGlb : extraction.texturedGlb, isolateGlb: e.refined.rawClayGlb!,
                        dir: path.join(cache.dir, 'pipeline_e', e.key.slice(0, 24), 'inference'), stage: 'grammar', stageKey: e.key,
                        ...(chain ? { chain } : {}), ...(streetViews ? { streetViews } : {}), structureMesh, crowns,
                        ...(enhance ? { inpaint: { client: enhance, models: [LIGHTING_MODEL_LITE] } } : {}),
                        ...(enhanceOn && visionAvailable ? { enhance: { client: genAiPlateClient(visionAvailable.client), models: enhanceModels(), locationName: placeValue!.formattedAddress, guards: enhanceGuards(), cacheDir: path.join(cache.dir, 'enhance_plates'), ...(guideViews ? { streetViews: guideViews } : {}) } } : {}),
                        solar: [], anchor: structure!.seed, signal: io.signal, onProgress: m => io.progress(m)
                    };
                    // version F (on by default; SCRATCHBOX_STAGED_GEOMETRY=e reverts to E's own inference): its procedural
                    // geometry in place of E's inference, E's enhanced texturing on it; round 3 (f3.ts) by default,
                    // SCRATCHBOX_VERSION_F_ROUND=2 for round 2 (f2.ts)
                    const key8 = e.key.slice(0, 8);
                    let earlyLayers = 0;
                    // round 3 hands the layer over as it exists: the clay shape right after the adjustment, the textured twin as
                    // walls are redrawn; each is the same l2g object, replaced in place (the final commit below replaces it last)
                    const onEarlyLayer = (files: MassingLayerFiles, phase: 'shape' | 'textures' | 'final', note: string) => {
                        if (phase === 'final' || io.signal.aborted) return;
                        earlyLayers++;
                        const pubClayE = cache.publishFile(files.clayGlb, `${base}_massing_${key8}_versionf_${phase}${earlyLayers}.glb`);
                        const pubTexE = cache.publishFile(files.texturedGlb, `${base}_massing_${key8}_versionf_${phase}${earlyLayers}_tex.glb`);
                        const early: StagedLayer = {
                            objectId: layerObjectId(e.key, 'l2g'), stage: 'grammar', layer: 'l2g', order: STAGES.grammar.order, url: pubClayE.url, bytes: pubClayE.bytes,
                            provenance: { label: PROVENANCE.photoInferred, measuredGeometry: false, confidence: 0.5, method: 'version F round 3: the procedural shape (read per wall, adjusted natively against the tile); its walls are being redrawn', sources: [{ kind: 'stage-output', id: `version-f/v3:${key8}` }], note },
                            provenanceLabels: ['vector-modelled', PROVENANCE.photoInferred, 'generated'], supersedes: [e.layer.objectId], revealAfter: [e.layer.objectId],
                            reveal: { durationMs: 800, stagger: 0, crossfadeFrom: [e.layer.objectId] }, cached: false, builtAtMs: now(), counts: layerCounts(files.clayGlb),
                            textured: { url: pubTexE.url, bytes: pubTexE.bytes, ladderRung: files.texturedShares.findIndex((_, k, a) => a.slice(k + 1).reduce((x, y) => x + y, 0) <= 0.1), rungShares: files.texturedShares, provenance: [], confidenceChannels: 'R = index into provenance[], G = weight 0..255, B = ladder rung (TEXTURE_LADDER_RUNGS), A = 255 where a stage produced the texel', builtAtMs: now(), cached: false }
                        };
                        run.commit(early, { source: 'Google3DTilesClay', resolvedAddress: placeValue!.formattedAddress, extra: { pipeline: 'e' } });
                        run.emit('grammar', 'running', { message: `version F: ${phase === 'shape' ? 'the clay shape is in' : 'textures streamed'} (${note})`, layers: [early] }, true);
                    };
                    const roofClusters = (r.run!.audit && !('error' in r.run!.audit) ? r.run!.audit.clusters : []).filter(c => c.verdict === 'real-object' && c.lo[1] >= Math.min(...r.massing.parts.map(p => p.topY)) - 1).map(c => ({ lo: c.lo, hi: c.hi }));
                    const out = stagedGeometryF() && visionAvailable
                        ? versionFRound() === 2
                            ? await runVersionFEnhanced({ ...inferenceInput, place: placeValue!.formattedAddress, genai: visionAvailable.client })
                            : await runVersionF3({ ...inferenceInput, place: placeValue!.formattedAddress, genai: visionAvailable.client, onLayer: onEarlyLayer, roofClusters })
                        : await runInferenceE(inferenceInput);
                    cache.writeRunNote(runId, 'pipeline_e_inference', { steps: out.steps, timingsMs: out.timingsMs, streetViewTexels: out.streetViewTexels });
                    recordResidualAudit('grammar', out.run, enhanceOn ? 'enhanced layer' : 'inferred layer');
                    const kept = out.steps.filter(s => s.accepted > 0);
                    const conf = Math.max(0.05, Math.min(1, ...out.grammars.map(g => g.confidence), 0.75));
                    // the enhanced layer is published under its own name: it never replaces the plain inferred one
                    const suffix = stagedGeometryF() && visionAvailable ? 'versionf' : enhanceOn ? 'enhanced' : 'inferred';
                    const pubClay = cache.publishFile(out.files.clayGlb, `${base}_massing_${key8}_${suffix}.glb`);
                    const pubTex = cache.publishFile(out.files.texturedGlb, `${base}_massing_${key8}_${suffix}_tex.glb`);
                    const enh = out.enhanced;
                    const enhNote = enhanceOn ? `; enhanced mode (the default within pipeline E; SCRATCHBOX_STAGED_ENHANCE=0 or the real-data view turns it off) was used: ${enh.filter(x => x.accepted).length} of ${enh.length} walls redrawn by ${enhanceModels().join(', ')} and kept (labelled generated, "AI-enhanced from tile"), ${enh.filter(x => !x.accepted).length} rejected (identity gate or region audit) and keep the tile texture; edge chamfer per wall ${enh.filter(x => x.chamferPx !== undefined).map(x => `${x.face} ${x.chamferPx} px / ${Math.round(100 * (x.lostShare ?? 0))}% lost`).join(', ') || 'none'} (reported, not gated)${visionAvailable ? '' : ' (no image model: nothing was enhanced)'}` : '';
                    const describe = out.steps.map(s => `${s.step}: ${s.skipped ? `skipped (${s.skipped})` : `${s.accepted} of ${s.proposed} kept`}`).join('; ') + enhNote;
                    const layer: StagedLayer = {
                        objectId: layerObjectId(e.key, 'l2g'), stage: 'grammar', layer: 'l2g', order: STAGES.grammar.order, url: pubClay.url, bytes: pubClay.bytes,
                        provenance: { label: PROVENANCE.photoInferred, measuredGeometry: false, confidence: conf, method: 'pipeline E inference on the clean massing: roof, bands and windows read from the tile photo and kept where the scan agrees; averaged bays, occluder fill, straightened texture and Street View colour on its textures', sources: [{ kind: 'stage-output', id: `pipeline-e:${key8}` }], note: describe },
                        provenanceLabels: ['vector-massing', PROVENANCE.photoInferred, PROVENANCE.asScanned, 'generated'], supersedes: [e.layer.objectId], revealAfter: [e.layer.objectId],
                        reveal: { durationMs: 800, stagger: 0, crossfadeFrom: [e.layer.objectId] }, cached: false, builtAtMs: now(), counts: layerCounts(out.files.clayGlb),
                        textured: {
                            url: pubTex.url, bytes: pubTex.bytes, ladderRung: out.files.texturedShares.findIndex((_, k, a) => a.slice(k + 1).reduce((x, y) => x + y, 0) <= 0.1),
                            rungShares: out.files.texturedShares, provenance: (out.files.legend ?? out.legend).map(x => ({ source: x.source, label: x.label, method: x.method, coverage: 0, ...(x.chamferPx !== undefined ? { chamferPx: x.chamferPx } : {}), ...(x.lostShare !== undefined ? { lostShare: x.lostShare } : {}) })),
                            confidenceChannels: 'R = index into provenance[], G = weight 0..255, B = ladder rung (TEXTURE_LADDER_RUNGS), A = 255 where a stage produced the texel', builtAtMs: now(), cached: false
                        }
                    };
                    run.commit(layer, { source: 'Google3DTilesClay', resolvedAddress: placeValue!.formattedAddress, extra: { pipeline: 'e' } });
                    run.note(PROVENANCE.photoInferred, `pipeline E inference: ${describe}`);
                    captureTraining(e, {
                        source: 'pipeline-e', pipelineVersion: PIPELINE_E_VERSION, outcome: 'delivered',
                        files: { 'target.textured': out.files.texturedGlb, 'target.clay': out.files.clayGlb }, provenanceLabels: layer.provenanceLabels, notes: { steps: out.steps }
                    });
                    done = { out, layer };
                    return { status: kept.length ? 'committed' : 'degraded', value: { steps: out.steps }, layers: [layer], source: `pipeline E inference in ${((now() - t0) / 1000).toFixed(0)} s: ${describe}`, ...(kept.length ? {} : { reason: 'no inferred step was kept' }) };
                },
                degrade: async err => ({
                    status: 'degraded', source: 'the clean massing stands without inference', reason: `pipeline E inference failed (${errorMessage(err)})`,
                    degradations: [run.degrade(record('grammar', 'pipeline_e_inference_failed', {
                        part: { description: 'the inferred detail of the massing' }, intended: 'photo-inferred roof, bands, windows and texture repairs', fellTo: 'the clean massing with its tile ortho textures',
                        provenanceAfter: 'vector-massing', reason: `pipeline E inference failed (${errorMessage(err)})`, cause: err, transient: true, runId, now: now(), reuses: ['resolve', 'tiles', 'trees-measure', 'remesh']
                    }))]
                })
            });
            return done;
        };

        // every grammar-slot build, delivered or failed, kept as a training pair (melted scan -> finished building) where this
        // instance has a training bucket (building-training-capture.ts); started and forgotten, never part of the build
        const captureTraining = (e: Pick<IRunState, 'refined'>, pair: { source: string; pipelineVersion: string; outcome: 'delivered' | 'failed'; reason?: string; files?: Record<string, string | undefined>; fit?: BuildingTrainingCaptureInput['fit']; provenanceLabels?: string[]; targetBeyondScan?: { note: string }; notes?: unknown }): void => {
            if (!structure || !placeValue) return;
            try {
                captureBuildingTrainingInBackground({
                    runId, place: placeValue.formattedAddress || request.query, anchor: { lat: placeValue.lat, lng: placeValue.lng },
                    outcome: pair.outcome, ...(pair.reason ? { reason: pair.reason } : {}), source: pair.source, pipelineVersion: pair.pipelineVersion,
                    files: { 'input.scan_textured': e.refined.texturedGlb, 'input.scan_clay': e.refined.rawClayGlb ?? e.refined.clayGlb, ...(pair.files ?? {}) },
                    footprint: { cells: structure.cells, groundY: structure.groundY, heightM: structure.heightM },
                    ...(pair.fit ? { fit: pair.fit } : {}), provenanceLabels: pair.provenanceLabels ?? [], ...(pair.targetBeyondScan ? { targetBeyondScan: pair.targetBeyondScan } : {}), ...(pair.notes !== undefined ? { notes: pair.notes } : {})
                });
            } catch (err) {
                console.warn(`[training-capture] run ${runId}: ${errorMessage(err)}`);
            }
        };

        // ---------------- pipeline J (the grammar stage's slot, request.procedural): character sheet -> Meshy (one seed) or Trellis (best of six), fitted to the scan ----------------
        const iRun = async (e: IRunState): Promise<void> => {
            const isMeshy = modelService === 'meshy';
            await runner.stage<{ steps: Array<{ step: string; accepted: number; proposed: number }> }>({
                id: 'grammar',
                run: async io => {
                    const t0 = now();
                    if (!deps.pipelineI) throw new Error(`pipeline J needs its image model and a Fal.ai 3D model service (${modelService}), which these deps do not provide`);
                    // the model client first: a missing FAL_KEY fails here, before the 4K sheet is drawn
                    const model = deps.pipelineI.model(modelService);
                    // Meshy's single output is already texture-complete, so it skips Trellis's best-of-six seed selection and
                    // its swatch colour match (tuned for Trellis's own colour drift)
                    const out = await runPipelineI({
                        texturedGlb: e.refined.texturedGlb, clayGlb: e.refined.rawClayGlb ?? e.refined.clayGlb,
                        footprint: { cells: structure!.cells, groundY: structure!.groundY, heightM: structure!.heightM },
                        anchor: { lat: placeValue!.lat, lng: placeValue!.lng, elevationMeters: 0 }, place: placeValue!.formattedAddress || request.query,
                        dir: path.join(cache.dir, 'pipeline_i', stageKey(PIPELINE_I_VERSION, e.key).slice(0, 24)),
                        generator: deps.pipelineI.generator(), model, budgetMs: Math.max(0, STAGES.grammar.budgetMs - (now() - t0) - 20_000),
                        ...(isMeshy ? { seeds: [TRELLIS_SEEDS[0]], skipColourMatch: true } : {}),
                        ...(visionAvailable ? { infill: { client: genAiEnhanceClient(visionAvailable.client), models: [LIGHTING_MODEL_FULL] } } : {}),
                        signal: io.signal, onProgress: m => io.progress(m), now
                    });
                    cache.writeRunNote(runId, 'pipeline_i', { steps: out.steps, timingsMs: out.timingsMs, plan: out.plan, sheet: out.sheet, model: out.model, candidates: out.candidates, swatch: out.swatch, fit: out.fit, ...(out.holes ? { holes: out.holes } : {}), files: out.files });
                    // the prototype refinement with the survey's evidence (refine.ts, SCRATCHBOX_PIPELINE_I_REFINE=1): the massing's footprint as
                    // the fit target, the tile's wall plates scored against the model's and projected where its walls lie on the planes.
                    // Any failure leaves pipeline J's own model standing, with the reason in the run note.
                    let refined: RefineOutcome | undefined;
                    if (pipelineIRefineEnabled() && e.stage?.run && t.ground) {
                        try {
                            refined = await refinePipelineI({
                                rawModelGlb: out.files.modelGlb, swatch: out.swatch, scanFit: out.fit,
                                scanFootprint: { cells: structure!.cells, groundY: structure!.groundY, heightM: structure!.heightM },
                                massing: e.stage.run.report, tileGlb: strip ? strip.devegetatedGlb : extraction.texturedGlb, structure: structure!, ground: t.ground,
                                anchor: { lat: placeValue!.lat, lng: placeValue!.lng, elevationMeters: 0 }, dir: path.join(cache.dir, 'pipeline_i', stageKey(PIPELINE_I_VERSION, e.key).slice(0, 24), 'refine'),
                                ...(visionAvailable ? { infill: { client: genAiEnhanceClient(visionAvailable.client), models: [LIGHTING_MODEL_FULL] } } : {}),
                                // the facade texture builder cleans each plate before it is projected (generated help: off in the real-data view)
                                ...((request.enhance ?? stagedEnhance()) && visionAvailable ? { clean: {
                                    client: genAiPlateClient(visionAvailable.client), models: enhanceModels(), locationName: placeValue!.formattedAddress || request.query,
                                    infill: { client: genAiEnhanceClient(visionAvailable.client), models: [LIGHTING_MODEL_FULL] }, unseenModels: [LIGHTING_MODEL_FULL],
                                    counter: visionFacadeCounter(new VisionModelChain<string>({ client: visionAvailable.client, candidates: visionAvailable.candidates, ...(ctx.signal ? { signal: ctx.signal } : {}) })),
                                    cacheDir: path.join(cache.dir, 'enhance_plates')
                                } } : {}),
                                signal: io.signal, onProgress: m => io.progress(m)
                            });
                            cache.writeRunNote(runId, 'pipeline_i_refine', refined);
                        } catch (err) {
                            if (isAbort(err) || io.signal.aborted) throw err;
                            cache.writeRunNote(runId, 'pipeline_i_refine', { error: errorMessage(err) });
                        }
                    }
                    const f = out.fit;
                    if (f.coverage < MIN_FOOTPRINT_COVERAGE_TO_SUPERSEDE) {
                        throw new Error(`the fitted model covers only ${(f.coverage * 100).toFixed(0)}% of the scan's footprint (plan IoU ${f.planIoU.toFixed(2)}; needs at least ${(MIN_FOOTPRINT_COVERAGE_TO_SUPERSEDE * 100).toFixed(0)}% to stand in for the measured scan) — ${out.model.model}'s shape is too far from the real building's at the scale register.ts could reach`);
                    }
                    const key8 = e.key.slice(0, 8);
                    const pubClay = cache.publishFile(refined?.files.clayGlb ?? out.files.clayGlb, `${base}_massing_${key8}_pipelinei.glb`);
                    const pubTex = cache.publishFile(refined?.files.texturedGlb ?? out.files.texturedGlb, `${base}_massing_${key8}_pipelinei_tex.glb`);
                    const projectedFaces = refined?.facades.filter(x => x.projected) ?? [];
                    const describe = `${out.steps.map(s => `${s.step}: ${s.accepted} of ${s.proposed}`).join('; ')}; fit to the scan: plan IoU ${f.planIoU.toFixed(2)}, ${(f.overflowShare * 100).toFixed(0)}% of the model outside the footprint (reported, not clipped), ${(f.coverage * 100).toFixed(0)}% of the footprint covered` +
                        (refined ? `; refined with the survey: fitted to the massing footprint (plan IoU with the scan ${refined.fit.scanIoUOfMassingFit.toFixed(2)}, shifted ${refined.fit.shift.map(v => v.toFixed(2)).join(', ')} m), ${refined.facades.length} facades scored, the tile's plates projected onto ${projectedFaces.length} (${refined.projected.texels.toLocaleString('en-US')} texels, photo-inferred)` : '') +
                        (refined?.holes?.holePixels ? `; ${refined.holes.holePixels} texels of the model's own texture it never covered: ${refined.holes.decision === 'accepted' ? `${refined.holes.filledPixels} filled by ${refined.holes.modelUsed} (generated)` : `left as the model built them (${refined.holes.reason ?? refined.holes.decision})`}` : '');
                    const method = `pipeline J (${modelService}): the isolated scan rendered from its tile photos at four planned stations, made into one building-survey character sheet (one 4K image, every panel checked against the scan), the four views sent together to ${out.model.model} on Fal.ai ${isMeshy ? `once (job ${out.model.requestId}), its own textures kept` : `once per seed, the best of ${out.candidates.length} (seed ${out.model.seed}, job ${out.model.requestId}) by its silhouette against the sheet and its plan fit, its textures colour-matched to the structure's swatch`}, fitted onto the scan's footprint and height (yaw ${f.yawDeg.toFixed(1)} deg${f.mirrored ? ', mirrored' : ''}, scale ${f.scale.toFixed(2)})`;
                    const generated = TEXTURE_LADDER_RUNGS.indexOf('generated tileable PBR');
                    const layer: StagedLayer = {
                        objectId: layerObjectId(e.key, 'l2i'), stage: 'grammar', layer: 'l2i', order: STAGES.grammar.order, url: pubClay.url, bytes: pubClay.bytes,
                        // a generated model: its confidence is the fit to the scan, never more than a generated source
                        provenance: { label: 'generated', measuredGeometry: false, confidence: Math.round(Math.min(0.5, f.planIoU * 0.5) * 100) / 100, method, sources: [{ kind: 'stage-output', id: `pipeline-i:${key8}` }], note: describe },
                        provenanceLabels: projectedFaces.length ? ['generated', PROVENANCE.photoInferred] : ['generated'], supersedes: [e.layer.objectId], revealAfter: [e.layer.objectId],
                        reveal: { durationMs: 800, stagger: 0, crossfadeFrom: [e.layer.objectId] }, cached: false, builtAtMs: now(), counts: layerCounts(refined?.files.clayGlb ?? out.files.clayGlb),
                        textured: {
                            url: pubTex.url, bytes: pubTex.bytes, ladderRung: generated, rungShares: TEXTURE_LADDER_RUNGS.map((_, k) => (k === generated ? 1 : 0)),
                            provenance: [{ source: `pipeline-j-${modelService}`, label: 'generated', method: `${out.model.model}'s textures (seed ${out.model.seed}), made from the character sheet's four views${isMeshy ? '' : ' and colour-matched to the structure\'s swatch measured from them'}`, coverage: 1 },
                                ...(projectedFaces.length ? [{ source: 'pipeline-i-refine-plates', label: refined?.cleaned ? 'generated' : PROVENANCE.photoInferred, method: `the tile's wall plates (the survey stations)${refined?.cleaned ? ', redrawn by the facade texture builder and kept through its identity gate,' : ''} projected onto the model where its wall lies within ${PROJECT_MAX_RELIEF_M} m of the massing's plane: ${projectedFaces.map(x => x.key).join(', ')}`, coverage: 0 }] : [])],
                            confidenceChannels: 'none: the model carries its own textures', builtAtMs: now(), cached: false
                        }
                    };
                    run.commit(layer, { source: 'Google3DTilesClay', resolvedAddress: placeValue!.formattedAddress, extra: { pipeline: 'j', modelService } });
                    run.note('generated', `pipeline J (${modelService}): ${describe}`);
                    captureTraining(e, {
                        source: out.model.model, pipelineVersion: PIPELINE_I_VERSION, outcome: 'delivered',
                        files: {
                            ...Object.fromEntries(out.files.views.map((v, k) => [`input.view_${k + 1}`, v])), 'input.sheet': out.files.sheetPng, 'input.sheet_reference': out.files.sheetReferencePng,
                            'target.textured': out.files.texturedGlb, 'target.clay': out.files.clayGlb, 'target.raw': out.files.modelGlb
                        },
                        fit: { planIoU: f.planIoU, coverage: f.coverage, overflowShare: f.overflowShare, heightRatio: f.heightRatio, yawDeg: f.yawDeg, scale: f.scale, mirrored: f.mirrored },
                        provenanceLabels: layer.provenanceLabels,
                        // the model draws the sides and roof no scan saw: the pair says so, for whoever trains on it
                        targetBeyondScan: { note: `${out.model.model} drew the whole structure from the character sheet's views; sides, backs and roof the scan did not see are generated` },
                        notes: { steps: out.steps, plan: out.plan, sheet: out.sheet, model: out.model, candidates: out.candidates, swatch: out.swatch, fitMatrix: f.matrix }
                    });
                    return { status: 'committed', value: { steps: out.steps }, layers: [layer], source: `pipeline J (${modelService}) in ${((now() - t0) / 1000).toFixed(0)} s: ${describe}` };
                },
                degrade: async err => (captureTraining(e, { source: 'pipeline-i', pipelineVersion: PIPELINE_I_VERSION, outcome: 'failed', reason: errorMessage(err) }), {
                    status: 'degraded', source: 'the clean massing stands without the generated model', reason: `pipeline J (${modelService}) failed (${errorMessage(err)})`,
                    degradations: [run.degrade(record('grammar', 'pipeline_i_failed', {
                        part: { description: 'the generated model of the structure' }, intended: isMeshy ? 'a model made by Meshy from a character sheet of the scan and fitted to the scan' : 'a model made by Trellis from a character sheet of the scan, the best of several seeds, colour-matched and fitted to the scan', fellTo: 'the clean massing with its tile ortho textures',
                        provenanceAfter: 'vector-massing', reason: `pipeline J (${modelService}) failed (${errorMessage(err)})`, cause: err, transient: true, runId, now: now(), reuses: ['resolve', 'tiles', 'trees-measure', 'remesh']
                    }))]
                })
            });
        };

        // pipeline J's generated model checked for glass the same way photo-read facades are (facade-material-evidence.ts's
        // floor, generalized to any mesh: specular-material-projection.ts): self-rendered, since there is no photo evidence of a model
        // nobody has seen built; accepted regions are baked straight into the already-published textured GLB, in place, so nothing
        // downstream needs to know this ran. Best-effort: any failure is recorded and never fails the build.
        const iSpecularPass = async (e: Pick<IRunState, 'key'>): Promise<void> => {
            if (!facadeMaterialsEnabled()) return;
            const committed = run.state.layers.find(l => l.objectId === layerObjectId(e.key, 'l2i'));
            const texUrl = committed?.textured?.url;
            if (!texUrl) return;
            const texPath = path.join(cache.modelsDir, path.basename(texUrl));
            if (!fs.existsSync(texPath)) return;
            try {
                const views = await gatherSelfRenderEvidence(texPath, segmenterTool());
                const projection = await projectMaskedViewsToUv(texPath, views);
                if (projection.cellsAccepted > 0) {
                    await bakeSpecularMaterials(texPath, projection, texPath);
                    cache.writeRunNote(runId, 'pipeline_i_specular', { cellsAccepted: projection.cellsAccepted, cellsSampled: projection.cellsSampled, regions: projection.regions.length });
                } else {
                    cache.writeRunNote(runId, 'pipeline_i_specular', { cellsAccepted: 0, cellsSampled: projection.cellsSampled });
                }
            } catch (err) {
                cache.writeRunNote(runId, 'pipeline_i_specular', { error: errorMessage(err) });
            }
        };

        // ---------------- pipeline E relief: measured detail by averaging the scan along repeats, after the clean (and inferred) layer ----------------
        const eReliefRun = async (e: NonNullable<typeof eState>, inf: { out: InferenceOutcome; layer: StagedLayer } | undefined): Promise<void> => {
            if (!pipelineERelief()) { runner.skip('relief', 'the measured relief is off (SCRATCHBOX_STAGED_PIPELINE_E_RELIEF=0)'); return; }
            await runner.stage<{ outcome: Pick<ReliefOutcome, 'counts'>; gate?: PhotoGateResult }>({
                id: 'relief',
                run: async io => {
                    const t0 = now();
                    const r = e.stage;
                    const baseLayer = inf?.layer ?? e.layer;
                    const baseTextured = inf?.out.files.texturedGlb ?? r.files!.texturedGlb;
                    const snapped = r.massing.parts.map(p => {
                        const q = r.run!.report.parts.find(x => x.id === p.id);
                        return { ...p, loops: q ? q.loops.map(l => l.map(([x, z]) => [x, z] as [number, number])) : p.loops };
                    });
                    const crowns = strip ? crownsFromStrip(JSON.parse(fs.readFileSync(strip.crownsJson, 'utf8'))) : [];
                    const key = stageKey(RELIEF_VERSION, e.key, inf ? inf.layer.objectId : 'no-inference', RELIEF_PARAMS);
                    const out = await runReliefStage({
                        massing: r.massing, run: r.run!,
                        build: inf ? inf.out.build : { parts: snapped, sweeps: [], openings: [] },
                        base: inf ? { run: inf.out.run, textures: inf.out.textures, legend: inf.out.legend } : { run: r.run!, textures: r.textures!, legend: r.legend! },
                        grammars: inf?.out.grammars ?? [], ...(inf ? { occluderMasks: inf.out.occluderMasks } : {}), crowns,
                        tilePath: strip ? strip.devegetatedGlb : extraction.texturedGlb, isolateGlb: e.refined.rawClayGlb!,
                        dir: path.join(cache.dir, 'pipeline_e', e.key.slice(0, 24), 'relief'), stage: 'relief', stageKey: key, signal: io.signal, onProgress: m => io.progress(m)
                    });
                    const c = out.counts;
                    const gen = out.generated;
                    const builtMeasured = out.geometry.features.some(f => f.built);
                    // the real-data view (enhanced mode off) shows real sources only: measured relief, never the generated typical profiles
                    const realDataView = !(request.enhance ?? stagedEnhance());
                    const builtGenerated = !realDataView && !!gen && gen.geometry.features.some(f => f.label === GENERATED_LABEL && f.built);
                    const kept = out.geometry.features.filter(f => f.built);
                    const depths = kept.map(f => `${f.role}: ${f.depthM.toFixed(2)} +- ${f.seM.toFixed(2)} m`).slice(0, 12).join('; ');
                    const describe = `measured: bands ${c.bands.accepted} of ${c.bands.proposed} kept, vertical elements ${c.verticals.accepted} of ${c.verticals.proposed}, window reveals ${c.reveals.accepted} of ${c.reveals.proposed}, projections beside openings ${c.projections.accepted} of ${c.projections.proposed} (gate: depth >= ${RELIEF_PARAMS.k} standard errors and >= ${RELIEF_PARAMS.minDepth} m, from >= ${RELIEF_PARAMS.minBlocks} blocks of ${RELIEF_PARAMS.block} m or >= ${RELIEF_PARAMS.minOpenings} openings)` +
                        (gen ? (realDataView ? `; generated typical profiles not used (the real-data view shows real sources only)` : `; generated (typical profiles in the scan's evidence bounds): bands ${gen.counts.bands.built}, window reveals ${gen.counts.reveals.built}`) : '');
                    recordResidualAudit('relief', out.run, 'relief layer');
                    cache.writeRunNote(runId, 'pipeline_e_relief', { counts: c, features: out.geometry.features, generated: gen ? { counts: gen.counts, features: gen.geometry.features.filter(f => f.label === GENERATED_LABEL) } : undefined, replacedSweeps: out.geometry.replacedSweeps, maps: out.maps, timingsMs: out.timingsMs });
                    if (!builtMeasured && !builtGenerated) return { status: 'degraded', value: { outcome: { counts: c } }, source: `measured relief: nothing stood out of the scan significantly (${describe})`, reason: 'no measured feature passed its gate' };
                    // the layer gate: the layer it refines, the measured layer, and the measured layer with the generated
                    let gate: PhotoGateResult;
                    const views = inf?.out.streetViews ?? [];
                    const arms = [{ id: 'base', glb: baseTextured }, ...(builtMeasured ? [{ id: 'measured', glb: out.files.texturedGlb }] : []), ...(builtGenerated ? [{ id: 'generated', glb: gen!.files.texturedGlb }] : [])];
                    if (!visionAvailable) gate = { ran: false, why: 'no vision model for the photo-match judge', views: 0, repeats: 0 };
                    else if (!views.length) gate = { ran: false, why: 'no Street View photo of the structure was had in this build', views: 0, repeats: 0 };
                    else {
                        io.progress(`pipeline E relief: the photo-match gate on ${Math.min(4, views.length)} Street View photos (${arms.map(x => x.id).join(', ')})`);
                        const judge = new VisionModelChain<string>({ client: visionAvailable.client, candidates: [...new Set([RELIEF_GATE_JUDGE, ...visionAvailable.candidates])], signal: ctx.signal, ...chainExtras('relief'), ...(deps.sleep ? { sleep: deps.sleep } : {}) });
                        try {
                            gate = await photoMatchGate({ views, arms, judge, place: placeValue!.formattedAddress, occluder: sceneToRenderMesh(readGlbScene(extraction.geometryGlb)), dir: path.join(cache.dir, 'pipeline_e', e.key.slice(0, 24), 'relief', 'gate'), signal: io.signal });
                        } catch (err) {
                            if (isAbort(err) || io.signal.aborted) throw err;
                            gate = { ran: false, why: `the photo-match judge could not be had (${errorMessage(err).slice(0, 160)})`, views: 0, repeats: 0 };
                        }
                    }
                    // a measured-only arm missing (nothing measured was built): the generated is judged against the base
                    const decision = gateDecision(gate, 'base', builtMeasured ? 'measured' : 'base', builtGenerated ? 'generated' : undefined);
                    const useMeasured = builtMeasured && decision.measured;
                    const useGenerated = builtGenerated && decision.generated && (useMeasured || !builtMeasured);
                    cache.writeRunNote(runId, 'pipeline_e_relief_gate', { gate, decision });
                    if (!useMeasured && !useGenerated) {
                        return {
                            status: 'degraded', value: { outcome: { counts: c }, gate }, source: `measured relief not used: ${decision.why}`, reason: `the relief layer scored lower on the photo-match judge (${decision.why})`,
                            degradations: [run.degrade(record('relief', 'relief_photo_match_worse', {
                                part: { description: 'the measured relief of the massing' }, intended: 'measured bands, vertical elements and window units averaged from the scan', fellTo: 'the layer before it',
                                provenanceAfter: baseLayer.provenance.label, reason: `the relief layer scored lower on the photo-match judge (${decision.why})`, transient: false, runId, now: now()
                            }))]
                        };
                    }
                    const files = useGenerated ? gen!.files : out.files;
                    const key8 = key.slice(0, 8);
                    const suffix = useGenerated ? 'relief_gen' : 'relief';
                    const pubClay = cache.publishFile(files.clayGlb, `${base}_massing_${key8}_${suffix}.glb`);
                    const pubTex = cache.publishFile(files.texturedGlb, `${base}_massing_${key8}_${suffix}_tex.glb`);
                    const gateNote = decision.why;
                    const labels = [...(useMeasured ? [MEASURED_AVERAGED_LABEL] : []), ...(useGenerated ? [GENERATED_LABEL] : [])];
                    const layer: StagedLayer = {
                        objectId: layerObjectId(key, 'l2r'), stage: 'relief', layer: 'l2r', order: STAGES.relief.order, url: pubClay.url, bytes: pubClay.bytes,
                        provenance: {
                            label: useMeasured ? MEASURED_AVERAGED_LABEL : GENERATED_LABEL, measuredGeometry: useMeasured, ...(useMeasured ? {} : { confidence: 0.5 }),
                            method: 'pipeline E relief: the scan\'s relief maps about each face of the clean massing, averaged along what repeats (rows for bands, columns for vertical elements, the facade grammar\'s lattice for openings); each measured feature carries its depth and standard error' +
                                (useGenerated ? '; typical profiles (labelled generated) where the facade clearly has a band or a window recess the averages could not resolve, their depth within the scan\'s evidence bounds' : ''),
                            sources: [{ kind: 'tile-extraction', id: 'isolate' }, { kind: 'stage-output', id: `pipeline-e-relief:${key8}` }], note: `${describe}; ${depths}; ${gateNote}`
                        },
                        provenanceLabels: [...new Set([...(baseLayer.provenanceLabels ?? []), ...labels])], supersedes: [baseLayer.objectId], revealAfter: [baseLayer.objectId],
                        reveal: { durationMs: 800, stagger: 0, crossfadeFrom: [baseLayer.objectId] }, cached: false, builtAtMs: now(), counts: layerCounts(files.clayGlb),
                        textured: {
                            url: pubTex.url, bytes: pubTex.bytes, ladderRung: files.texturedShares.findIndex((_, k, a) => a.slice(k + 1).reduce((x, y) => x + y, 0) <= 0.1),
                            rungShares: files.texturedShares, provenance: (files.legend ?? inf?.out.legend ?? r.legend!).map(x => ({ source: x.source, label: x.label, method: x.method, coverage: 0, ...(x.chamferPx !== undefined ? { chamferPx: x.chamferPx } : {}), ...(x.lostShare !== undefined ? { lostShare: x.lostShare } : {}) })),
                            confidenceChannels: 'R = index into provenance[], G = weight 0..255, B = ladder rung (TEXTURE_LADDER_RUNGS), A = 255 where a stage produced the texel', builtAtMs: now(), cached: false
                        }
                    };
                    run.commit(layer, { source: 'Google3DTilesClay', resolvedAddress: placeValue!.formattedAddress, extra: { pipeline: 'e' } });
                    run.note(MEASURED_AVERAGED_LABEL, `pipeline E relief: ${describe}; ${gateNote}`);
                    return { status: 'committed', value: { outcome: { counts: c }, gate }, layers: [layer], source: `relief in ${((now() - t0) / 1000).toFixed(0)} s: ${describe}; ${gateNote}` };
                },
                degrade: async err => ({
                    status: 'degraded', source: 'the layer before it stands without measured relief', reason: `pipeline E relief failed (${errorMessage(err)})`,
                    degradations: [run.degrade(record('relief', 'pipeline_e_relief_failed', {
                        part: { description: 'the measured relief of the massing' }, intended: 'measured bands, vertical elements and window units averaged from the scan', fellTo: 'the layer before it',
                        provenanceAfter: 'vector-massing', reason: `pipeline E relief failed (${errorMessage(err)})`, cause: err, transient: true, runId, now: now(), reuses: ['resolve', 'tiles', 'trees-measure', 'remesh']
                    }))]
                })
            });
        };

        // ---------------- facade grammar (photo-inferred window lattices on the remeshed facades) ----------------
        const grammarRun = async (): Promise<void> => {
            const remeshed = remeshedNow;
            if (eState && procedural) {
                await iRun(eState);
                await iSpecularPass(eState);
                runner.skip('relief', 'pipeline J places a generated model of the structure; the measured relief would put scan detail on the massing it replaces');
                return;
            }
            if (eState) { const inf = await eInferenceRun(eState); await eReliefRun(eState, inf); return; }
            if (!eState && remeshed && procedural) {
                // The vector-massing gate rejected (eWhyNot) — but pipeline J does not actually need pipeline E's clean
                // massing: it generates its own model from a character sheet of the scan and fits that to the scan's own
                // footprint and height afterward (out.fit, reported). Default to generative here too (user decision,
                // 2026-10-24): try it directly on the plain remeshed scan. There is no fit-quality gate yet deciding
                // whether to keep it over the textured remesh when it comes out implausible (a photo-match judge like
                // pipeline E relief's, comparing both against real Street View photos, is the natural next step — see
                // the pipeline-i findings doc) — for now the generated model always supersedes once it commits.
                const groundLayerId = remesh.value?.groundLayerId;
                if (groundLayerId) {
                    await iRun({ refined: remeshed, layer: { objectId: groundLayerId }, key: remeshed.cacheKey });
                    await iSpecularPass({ key: remeshed.cacheKey });
                    runner.skip('relief', `pipeline J places a generated model of the structure on the remeshed scan (its vector massing did not pass agreement with the scan: ${eWhyNot ?? 'see the pipeline E fallback'}); the measured relief would put scan detail on the massing it replaces`);
                    return;
                }
            }
            if (procedural) {
                // asked for a procedural rebuild, but neither E's massing nor a remeshed scan stands to build it on: say so, never silently
                run.degrade(record('grammar', 'pipeline_j_unavailable', {
                    part: { description: 'the procedural rebuild of the structure' }, intended: 'pipeline J: a generated model of the structure from a character sheet of the scan, fitted to the scan',
                    fellTo: 'the current pipeline (remesh, fit, detail)', provenanceAfter: PROVENANCE.remeshed,
                    reason: `pipeline J builds on pipeline E's massing or the remeshed scan, and this structure got neither (${eWhyNot ?? 'the remesh did not commit'})`,
                    transient: false, runId, now: now()
                }));
            }
            runner.skip('relief', 'the measured relief runs on pipeline E\'s clean massing (SCRATCHBOX_STAGED_PIPELINE=e)');
            if (pipelineK) {
                runner.skip('grammar', 'pipeline K rebuilds the facades on their straightened photos instead of reading them as a grammar');
                return;
            }
            if (!grammarOn) {
                runner.skip('grammar', !facadeGrammarEnabled() ? 'facade grammar is off (SCRATCHBOX_FACADE_GRAMMAR=0)' : !visionAvailable ? 'no vision model is configured' : 'the photometric relief is off');
                return;
            }
            const orthosDir = remeshed?.reliefOrthosDir;
            const l2 = currentRemeshLayer(run);
            if (!remeshed || !orthosDir || !remeshRequest || !l2) { runner.skip('grammar', remeshed ? 'the remesh wrote no facade orthophotos' : 'the remesh failed, so there are no remeshed facades to read'); return; }
            type GrammarValue = { facades: GrammarFacadeOutcome[]; calls: number; passMs: number; footprintsNote?: string; refine?: { cacheKey: string; clayGlb: string; texturedGlb?: string; stats: Record<string, any>; ms: number } };
            await runner.stage<GrammarValue>({
                id: 'grammar',
                run: async io => {
                    const chain = new VisionModelChain<string>({ client: visionAvailable!.client, candidates: visionAvailable!.candidates, signal: ctx.signal, ...chainExtras('grammar'), ...(deps.sleep ? { sleep: deps.sleep } : {}) });
                    const key = stageKey('facade-grammar/v1', FACADE_GRAMMAR_PROMPT_VERSION, FACADE_GRAMMAR_GATE_VERSION, remeshed.cacheKey, visionAvailable!.candidates);
                    run.keys.grammar = key;
                    const entry = await cache.run<GrammarValue>('grammar', key, async dir => {
                        // the vector building footprints: an independent check of each grammar (which building each section is, how tall)
                        let footprints: FootprintSource | undefined;
                        let footprintsNote = '';
                        try {
                            footprints = await (deps.footprints ?? defaultFootprints)({ lat: extraction.geoAnchor.lat, lng: extraction.geoAnchor.lng }, Math.max(100, extraction.coveredRadiusM ?? extraction.radiusM));
                            footprintsNote = footprints.note;
                        } catch (err) {
                            footprintsNote = `no vector building footprints (${errorMessage(err)})`;
                        }
                        io.progress(`facade grammar: ${footprintsNote}`);
                        io.progress('reading the facades\' grammar from the tile photo');
                        const pass = await runFacadeGrammarPass({
                            orthosDir, chain, anchor: structure ? structure.seed : { x: 0, z: 0 }, signal: io.signal, onProgress: m => io.progress(m), overlayDir: path.join(dir, 'overlays'),
                            ...(footprints ? { footprints: footprints.buildings } : {})
                        });
                        fs.writeFileSync(path.join(dir, 'pass.json'), JSON.stringify(pass));
                        const value: GrammarValue = { facades: pass.facades, calls: pass.calls, passMs: pass.ms, footprintsNote };
                        if (pass.accepted.length) {
                            const file = path.join(dir, 'grammar.txt');
                            fs.writeFileSync(file, grammarFileText(pass.accepted));
                            fs.writeFileSync(path.join(dir, 'grammar.json'), JSON.stringify(pass.accepted, null, 1));
                            io.progress(`relief with ${pass.accepted.length} facade grammar${pass.accepted.length === 1 ? '' : 's'}`);
                            const r = await deps.refine.refine({ ...remeshRequest!, facadeGrammar: file });
                            // the same polish as the remesh; the facades whose grammar was accepted keep the grammar's windows
                            const pol = polishRemesh({ clayGlb: r.clayGlb, ...(r.texturedGlb ? { texturedGlb: r.texturedGlb } : {}), cacheKey: r.cacheKey, orthosDir, skipFacades: value.facades.filter(f => f.accepted && f.grammar).map(f => f.facadeId) });
                            value.refine = { cacheKey: pol.cacheKey, clayGlb: pol.clayGlb, ...(pol.texturedGlb ? { texturedGlb: pol.texturedGlb } : {}), stats: { relief: { grammar: r.stats?.relief?.grammar ?? [], lattices: (r.stats?.relief?.lattices ?? []).filter((l: any) => l.grammar) } }, ms: r.ms };
                        }
                        return { value };
                    }, { bypass: bypass('grammar') });
                    run.cacheStatus.grammar = entry.cached ? 'hit' : bypass('grammar') ? 'bypassed' : 'miss';
                    const v = entry.value;
                    cache.writeRunNote(runId, 'facade_grammar', v);
                    const accepted = v.facades.filter(f => f.accepted && f.grammar);
                    const rejected = v.facades.filter(f => !f.accepted && f.grammar);
                    const applied = new Map<number, any>((v.refine?.stats.relief.grammar ?? []).map((g: any) => [g.facadeId, g]));
                    const describe = (f: GrammarFacadeOutcome) => {
                        const h = f.heldOut;
                        return `facade ${f.facadeId} (${Math.round(f.areaM2)} m², read from ${f.grammar!.source}${f.agreedSources && f.agreedSources.length > 1 ? `, agreed by ${f.agreedSources.slice(1).join(', ')}` : f.footprints?.buildings ? ', footprints disagree' : ''}): ${f.grammar!.tiers.length} tiers, ${f.grammar!.tiers.reduce((s, t) => s + t.cols.length, 0)} openings${h ? `; held out: edge chamfer ${h.before.chamferPx.toFixed(2)} -> ${h.after.chamferPx.toFixed(2)} px, gradient NCC ${h.before.gradNcc.toFixed(3)} -> ${h.after.gradNcc.toFixed(3)}` : ''}${f.plausibility?.length ? `; plausibility: ${f.plausibility.map(p => p.message).join('; ')}` : ''}`;
                    };
                    for (const f of v.facades) io.progress(`facade grammar: facade ${f.facadeId}: ${f.accepted ? 'accepted' : 'not used'}: ${f.reason}`);
                    const degradations = rejected.map(f => run.degrade(record('grammar', 'grammar_rejected', {
                        part: { description: `the window lattice of facade ${f.facadeId} (${Math.round(f.areaM2)} m²)` }, intended: 'a photo-inferred facade grammar as its window lattice',
                        fellTo: "the relief's own window lattice on that facade", provenanceAfter: PROVENANCE.remeshed,
                        reason: `the grammar read from the tile photo was not used: ${f.reason}`, transient: false, runId, now: now(), suffix: String(f.facadeId)
                    })));
                    if (!accepted.length || !v.refine) {
                        return {
                            status: degradations.length ? 'degraded' : 'committed', value: v, degradations, cached: entry.cached, builtAtMs: entry.builtAtMs,
                            source: `facade grammar: no facade took a grammar (${v.facades.length} read, ${rejected.length} rejected by the scan or held-out check)`
                        };
                    }
                    const key8 = v.refine.cacheKey.slice(0, 8);
                    const pub = cache.publishFile(v.refine.clayGlb, `${base}_grammar_${key8}.glb`);
                    const prov = readRemeshProvenance(v.refine.clayGlb);
                    const confidence = Math.min(...accepted.map(f => f.grammar!.confidence));
                    const cells = [...applied.values()].reduce((s, g) => s + g.overObserved + g.inferred, 0);
                    const note = `facade grammar (photo-inferred, confidence ${confidence.toFixed(2)}): ${accepted.map(describe).join('; ')}`;
                    const layer: StagedLayer = {
                        objectId: layerObjectId(v.refine.cacheKey, 'l2g'), stage: 'grammar', layer: 'l2g', order: STAGES.grammar.order, url: pub.url, bytes: pub.bytes,
                        provenance: {
                            label: PROVENANCE.remeshed, measuredGeometry: false, confidence,
                            inferred: { grammarFacades: accepted.length, grammarCells: cells, grammarConfidence: confidence, reliefCarvedVertices: prov.summary.relief?.carvedVertices ?? 0 },
                            method: `${l2.provenance.method}; facade grammar read from the tile photo by the vision model (tiers of openings, fitted to the facade's metric frame), used where it passed the scan and held-out checks`,
                            sources: [...l2.provenance.sources, { kind: 'stage-output', id: `grammar:${key8}` }], note
                        },
                        provenanceLabels: [PROVENANCE.remeshed, PROVENANCE.photoInferred], vertexProvenance: prov.summary, supersedes: [l2.objectId], revealAfter: [l2.objectId],
                        reveal: { durationMs: 800, stagger: 0, crossfadeFrom: [l2.objectId] }, cached: entry.cached, builtAtMs: entry.builtAtMs, counts: layerCounts(v.refine.clayGlb)
                    };
                    // tile_refine's photo-textured output of the grammar's relief: a district's twin of l2g (an entry cached before it
                    // was kept asks tile_refine again, from its own cache)
                    if (!isolateOk) {
                        let textured = v.refine.texturedGlb && fs.existsSync(v.refine.texturedGlb) ? v.refine.texturedGlb : undefined;
                        if (!textured) {
                            try { textured = (await deps.refine.refine({ ...remeshRequest!, facadeGrammar: path.join(entry.dir, 'grammar.txt') })).texturedGlb; } catch (err) { io.progress(`facade grammar: tile_refine's textured output of l2g could not be had (${errorMessage(err)}); l2g stays clay`); }
                        }
                        if (textured) refineTextured.set(layer.objectId, textured);
                    }
                    run.commit(layer, { source: 'Google3DTilesClay', resolvedAddress: placeValue!.formattedAddress });
                    run.note(PROVENANCE.photoInferred, note);
                    return {
                        status: degradations.length ? 'degraded' : 'committed', value: v, layers: [layer], degradations, cached: entry.cached, builtAtMs: entry.builtAtMs,
                        ...(rejected.length ? { reason: `${accepted.length} of ${v.facades.length} facades took a photo-inferred grammar; ${rejected.length} read ${rejected.length === 1 ? 'was' : 'were'} not used (facade ${rejected[0].facadeId}: ${rejected[0].reason.slice(0, 160)})` } : {}),
                        source: `facade grammar: ${accepted.length} of ${v.facades.length} facades took a photo-inferred grammar (${cells} openings, confidence ${confidence.toFixed(2)}); ${accepted.map(describe).join('; ')}${rejected.length ? `; ${rejected.length} rejected` : ''}${v.footprintsNote ? `; checked against ${v.footprintsNote}` : ''}`
                    };
                },
                degrade: async err => ({
                    status: 'degraded', source: "the relief's own window lattices stand", reason: `the facade grammar failed (${errorMessage(err)})`,
                    degradations: [run.degrade(record('grammar', 'grammar_failed', {
                        part: { description: 'the window lattices of the remeshed facades' }, intended: 'photo-inferred facade grammars as the window lattices',
                        fellTo: "the remeshed scan with the relief's own window lattices", provenanceAfter: PROVENANCE.remeshed,
                        reason: `the facade grammar failed (${errorMessage(err)}); the relief's own window lattices stand`, cause: err, transient: true, runId, now: now(), reuses: ['resolve', 'tiles', 'trees-measure', 'remesh']
                    }))]
                })
            });
        };
        const startGrammar = (): void => {
            const grammarPromise = grammarRun().catch(err => {
                if (isAbort(err)) throw err;
                const why = `the facade grammar stopped on an unexpected error (${errorMessage(err)})`;
                const st = run.summary('grammar').status;
                if (st === 'pending' || st === 'running') run.emit('grammar', 'degraded', { source: "the relief's own window lattices stand", reason: why, degradations: [] }, true);
            });
            grammarGate.settled = grammarPromise;
            siblings.push(grammarPromise);
        };
        startGrammar();

        // ---------------- the district's rebuilt buildings (district-massing.ts) ----------------
        // pipeline K-D keeps the district's scan and straightens it (pipeline K): no building is massed again
        if (!request.isolate && !kdDistrict && strip && deps.vectorEvidence && remesh.value?.refined && remesh.value.committed && districtMassingEnabled(request)) {
            const stripped = strip, refined = remesh.value.refined, remeshId = remesh.value.groundLayerId;
            const procedural = proceduralDistrictEnabled(request);
            type DistrictMassingValue = {
                rebuilt: number; buildings: number; reasons: Record<string, number>; roofErrMedianM: number | null; removedTriangles: number; residualOffFootprint: number; timingsMs: Record<string, number>;
                caveats?: number;
                revolutions?: RevolutionLayerSummary & { cut: Record<string, number> };
                /** Plane-first walls (wall-plane-fit.ts): walls by fit status, relief kept, scan lumps taken out of the residual. */
                planeFirst?: { walls: number; measured: number; estimated: number; unseen: number; recesses: number; projections: number; rejectedRelief: number; residualRemovedTriangles: number; residualRemovedAreaM2: number };
                /** The scene object store (scene-objects.ts): buildings taken from it unchanged instead of massed again, and the ground and streets. */
                objects?: { reused: number; generated: number; planMs: number; groundReused?: boolean; roadsReused?: boolean };
                procedural?: {
                    /** `program`: the ground program (procedural-ground.ts): each land-use region's measurements and the material decided from them. */
                    ground: { vertices: number; triangles: number; openVertices: number; terrainVertices: number; program?: Omit<GroundProgram, 'vertexRegion'> }; roads?: { roads: number; stations: number; measuredKerbs: number; defaultKerbs: number; triangles: number };
                    /** Prepared for the texture pass (procedural-materials.ts): the clays and the library fill; absent with the reason when it could not be. */
                    texturePass?: ProceduralTexturingSummary; texturePassUnavailable?: string;
                    /** The bridges (bridge-build.ts) and the water: absent when off or when nothing crossed the water. */
                    bridges?: BridgeBuildResult['stats'] & { notes: string[]; perBridge: Array<{ id: string; openings: number; supports: number; posts: number; read: boolean; references: number; detailAgreed: string[]; detailRejected: string[] }> };
                    water?: { levelY: number; cells: number; triangles: number; colourSrgb: [number, number, number]; colourMeasured: boolean };
                };
            };
            const massingPromise = runner.stage<DistrictMassingValue>({
                id: 'massing',
                run: async io => {
                    const covered = extraction.coveredRadiusM;
                    const ev = await deps.vectorEvidence!({ lat: placeValue!.lat, lng: placeValue!.lng, radiusM: covered + 20 });
                    const look = evidenceLookup(ev, covered + 20);
                    const vectorKey = crypto.createHash('sha256').update(JSON.stringify([ev.buildings.map(b => [b.id, b.parts, b.heightM ?? null, b.extruded ?? null]), ev.water, ev.roads])).digest('hex').slice(0, 16);
                    const revolutionsOn = revolutionFitEnabled();
                    // detail the scan cannot resolve (ribs) from search-grounded references, when a model client is configured
                    const referenceClient = revolutionsOn && revolutionReferenceEnabled() && deps.vision && 'client' in deps.vision ? deps.vision.client : undefined;
                    const surfaceMode = proceduralSurfaceMode();
                    const bridgesOn = procedural && proceduralBridgesEnabled();
                    const key = stageKey(DISTRICT_MASSING_VERSION, districtEDetailEnabled() ? DISTRICT_E_DETAIL_VERSION : 'no-detail', stripped.cacheKey, vectorKey, refined.cacheKey, covered.toFixed(1), String(DISTRICT_TEXEL_M), procedural ? `${PROCEDURAL_GROUND_VERSION}+${PROCEDURAL_ROADS_VERSION}${deps.textures?.disabled && surfaceMode === 'photo' ? '' : `+${PROCEDURAL_MATERIALS_VERSION}+${surfaceMode}`}${bridgesOn ? `+${BRIDGE_BUILD_VERSION}+${WATER_VERSION}` : ''}` : 'carve', ...(revolutionsOn ? [REVOLUTION_FIT_VERSION] : []), ...(referenceClient ? [REVOLUTION_REFERENCE_VERSION] : []));
                    run.keys.massing = key;
                    const key8 = key.slice(0, 8);
                    // the scene object store: each rebuilt building, the ground and the streets kept as their own versioned
                    // GLBs; a building whose own inputs are unchanged since it was stored is taken from there, not massed again
                    const frame = objectFrameOf(extraction);
                    const objectStore = objectStoreEnabled() ? defaultDurableAssetStore() : undefined;
                    const reuseObjects = objectReuseEnabled();
                    const objectVersions = { massing: DISTRICT_MASSING_VERSION, texelM: DISTRICT_TEXEL_M, params: DISTRICT_MASSING_PARAMS, revolutions: revolutionsOn ? REVOLUTION_FIT_VERSION : 'off' };
                    const groundHash = objectInputHash('ground', PROCEDURAL_GROUND_VERSION, stripped.cacheKey, covered.toFixed(1), ev.water, ev.roads, ev.landuse ?? [], bridgesOn ? BRIDGE_BUILD_VERSION : 'no-bridges');
                    const roadsHash = objectInputHash('road', PROCEDURAL_ROADS_VERSION, stripped.cacheKey, covered.toFixed(1), vectorKey, ROAD_SURFACE_PARAMS);
                    const massProducer = { stage: 'massing', stageKey: key, layer: 'l2m', version: DISTRICT_MASSING_VERSION };
                    const massRows = () => {
                        const scan = loadScanMesh(stripped.devegetatedGlb);
                        const ground = buildGroundModel(scan, { cellMeters: 1, water: look.waterAt, road: look.roadAt });
                        const within = (x: number, z: number) => Math.hypot(x, z) <= covered;
                        // plane first: the scan's near-vertical surface as samples, each wall fitted as one plane (wall-plane-fit.ts)
                        const walls = planeFirstEnabled() ? wallSampleIndex(scan.mesh.vertices, scan.mesh.indices, { keep: (x, z) => Math.hypot(x, z) <= covered + 10 }) : undefined;
                        const rows = massDistrict({ buildings: ev.buildings, look, ground, within, lenient: procedural, ...(walls ? { walls } : {}) });
                        return { scan, ground, within, rows, okRows: rows.filter(r => r.ok && r.massing) };
                    };
                    const wholeManifest = (kind: string, identity: string, hash: string, file: string, layerName: string, version: string, labels: string[]): LayerObjectManifest =>
                        wholeLayerManifest(kind, identity, hash, sha256File(file), { stage: 'massing', stageKey: key, layer: layerName, version }, { labels, confidence: null });
                    const entry = await cache.run<DistrictMassingValue>('massing', key, async dir => {
                        io.progress('massing every building from its footprint and the scan');
                        const { scan, ground, within, rows, okRows } = massRows();
                        const reasons: Record<string, number> = {};
                        for (const r of rows.filter(x => !x.ok)) { const k = (r.reason ?? 'unknown').split(':')[0].replace(/[\d.]+/g, 'N'); reasons[k] = (reasons[k] ?? 0) + 1; }
                        const ok = rows.filter(r => r.ok);
                        const errs = ok.map(r => r.massing!.check.heightErrMedianM).sort((a, b) => a - b);
                        const summary = { buildings: rows.length, reasons, roofErrMedianM: errs.length ? errs[errs.length >> 1] : null };
                        fs.writeFileSync(path.join(dir, 'buildings.json'), JSON.stringify(rows.map(({ massing, ...r }) => ({ ...r, parts: massing?.parts.length ?? 0, roofErrMedianM: massing?.check.heightErrMedianM ?? null }))));
                        const plan: DistrictObjectPlan | undefined = objectStore && okRows.length
                            ? planDistrictObjects({ rows: okRows, buildings: ev.buildings, scan, look, within, frame, versions: objectVersions, store: objectStore, reuse: reuseObjects })
                            : undefined;
                        const reused = plan?.reusable ?? new Map<string, { file: string }>();
                        io.progress(`${ok.length} of ${rows.length} buildings pass their check; building ${reused.size ? `${ok.length - reused.size} (${reused.size} unchanged since they were stored, reused)` : 'them'}`);
                        const freshRows = rows.filter(r => !reused.has(r.id));
                        const layer = freshRows.some(r => r.ok && r.massing)
                            ? await buildDistrictMassingLayer({ rows: freshRows, look, within, scanGlb: stripped.devegetatedGlb, outDir: dir, stage: 'massing', stageKey: key, signal: io.signal })
                            : undefined;
                        if (!layer && !reused.size) return { value: { rebuilt: 0, ...summary, removedTriangles: 0, residualOffFootprint: 0, timingsMs: {} } };
                        // pipeline E's detail on every building massed now: inference, then measured relief (district-e-detail.ts)
                        if (layer && districtEDetailEnabled()) {
                            const td = Date.now();
                            io.progress(`pipeline E detail on ${layer.rebuilt} buildings: roofs, bands, windows, textures, then measured relief`);
                            const vis = deps.vision && 'client' in deps.vision ? deps.vision : undefined;
                            const chain = vis ? new VisionModelChain<string>({ client: vis.client, candidates: vis.candidates, signal: io.signal, ...chainExtras('massing'), ...(deps.sleep ? { sleep: deps.sleep } : {}) }) : undefined;
                            const detail = await districtEDetail({ layer, scanGlb: stripped.devegetatedGlb, dir: path.join(dir, 'detail'), stageKey: key, ...(chain ? { chain } : {}), signal: io.signal, onProgress: m => io.progress(m) });
                            if (detail.files.texturedGlb !== layer.files.texturedGlb) {
                                fs.copyFileSync(detail.files.texturedGlb, layer.files.texturedGlb);
                                fs.copyFileSync(detail.files.clayGlb, layer.files.clayGlb);
                            }
                            cache.writeRunNote(runId, 'district_e_detail', detail);
                            run.note(PROVENANCE.photoInferred, `pipeline E detail on the district's ${layer.rebuilt} rebuilt buildings: ${detail.inference ? detail.inference.steps.map(s2 => `${s2.step} ${s2.accepted}/${s2.proposed}${s2.skipped ? ` (skipped: ${s2.skipped})` : ''}`).join(', ') : 'no inference'}; ${detail.relief ? `measured relief: ${detail.relief.built} features built (bands ${detail.relief.counts.bands.accepted}, reveals ${detail.relief.counts.reveals.accepted})` : 'no measured relief'}; ${detail.notes.join('; ')}`);
                            layer.timingsMs.detail = Date.now() - td;
                        }
                        const texturedFile = path.join(dir, 'district_massing_textured.glb');
                        const timingsMs: Record<string, number> = { ...(layer?.timingsMs ?? {}), ...(plan ? { objectPlan: plan.ms } : {}) };
                        if (reused.size) {
                            const tm = Date.now();
                            // nothing massed now: the residual standing on no footprint comes from the store too (it is the same stage's)
                            const unattributed = layer ? undefined : findStoredLayer(objectStore, reuseObjects, 'scan-residual', 'unattributed', frame, objectInputHash('scan-residual', DISTRICT_MASSING_VERSION, key));
                            assembleDistrictLayer(layer?.files.texturedGlb, [...[...reused.values()].map(r => r.file), ...(unattributed ? [unattributed] : [])], texturedFile,
                                { sb: { schema: 'scratchbox.staged-glb/2', stage: 'massing', stageKey: key, frame: 'tile frame: x east, y up, z south (metres)' } });
                            timingsMs.reuseAssemble = Date.now() - tm;
                        }
                        // the cut of the scan's own buildings covers every rebuilt one, massed now or reused
                        const footprint = districtFootprint(okRows, look, within, 1);
                        const manifests: Record<string, LayerObjectManifest> = {};
                        // listed once the layer is final (the revolution fit cuts it in place)
                        const listBuildings = () => { if (plan) manifests['district_massing_textured.glb'] = districtMassingManifest(parseGlbBytes(fs.readFileSync(texturedFile)), sha256File(texturedFile), okRows, plan.owners, plan.hashes, massProducer); };
                        const objects: DistrictMassingValue['objects'] = plan ? { reused: reused.size, generated: okRows.length - reused.size, planMs: plan.ms } : undefined;
                        const residualOffFootprint = layer?.residualOffFootprint ?? 0;
                        const caveats = ok.filter(r => r.caveat).length;
                        const pfWalls = ok.flatMap(r => r.planeFirst?.walls ?? []);
                        const planeFirst = layer?.planeFirst ? {
                            walls: pfWalls.length, measured: pfWalls.filter(w => w.fit.status === 'measured').length, estimated: pfWalls.filter(w => w.fit.status === 'estimated').length, unseen: pfWalls.filter(w => w.fit.status === 'unseen').length,
                            recesses: ok.reduce((a, r) => a + (r.planeFirst?.openings.length ?? 0), 0), projections: ok.reduce((a, r) => a + (r.planeFirst?.faceSweeps.length ?? 0), 0),
                            rejectedRelief: layer.planeFirst.rejectedRelief.length, residualRemovedTriangles: layer.planeFirst.residualRemovedTriangles, residualRemovedAreaM2: layer.planeFirst.residualRemovedAreaM2
                        } : undefined;
                        fs.writeFileSync(path.join(dir, 'plane_first_walls.json'), JSON.stringify(ok.filter(r => r.planeFirst).map(r => ({ id: r.id, caveat: r.caveat ?? null, overhangAfterShare: r.planeFirst!.overhangAfterShare, summary: r.planeFirst!.summary, walls: r.planeFirst!.walls }))));
                        // the district's solids of revolution (revolution-fit.ts): rebuilt clean, their scan and massing cut out
                        const reviseRevolutions = async (cutFiles: string[]) => {
                            if (!revolutionsOn) return undefined;
                            io.progress('fitting the solids of revolution (domes, drums, lanterns) the scan measures');
                            try {
                                const vis = deps.vision && 'client' in deps.vision ? deps.vision : undefined;
                                const planChain = vis ? new VisionModelChain<string>({ client: vis.client, candidates: vis.candidates, signal: io.signal, ...chainExtras('massing'), ...(deps.sleep ? { sleep: deps.sleep } : {}) }) : undefined;
                                const judgePlan = planChain ? async (image: { bytes: Uint8Array; mimeType: string }, prompt: string) => {
                                    const r = await planChain.generate({ contents: [{ role: 'user', parts: [{ inlineData: { mimeType: image.mimeType, data: Buffer.from(image.bytes).toString('base64') } }, { text: prompt }] }], config: { responseMimeType: 'application/json', temperature: 0, abortSignal: io.signal } }, { stage: 'massing' });
                                    const text = (r.response.candidates?.[0]?.content?.parts ?? []).filter(p => !(p as { thought?: boolean }).thought).map(p => p.text ?? '').join('');
                                    r.remember();
                                    return text;
                                } : undefined;
                                const origin: GeodeticOrigin = { lat: placeValue!.lat, lng: placeValue!.lng, heightMeters: 0 };
                                const reference = referenceClient ? revolutionReferenceFor({ client: referenceClient, place: placeValue!.formattedAddress, toLatLng: (x, z) => scanToGeodetic(origin, x, 0, z) }) : undefined;
                                return await reviseForRevolutions({ dir, scanGlb: stripped.devegetatedGlb, within, cutFiles: cutFiles.map(f => path.join(dir, f)), signal: io.signal, ...(judgePlan ? { judgePlan } : {}), ...(reference ? { reference } : {}), outlines: ev.buildings.flatMap(b => [...(b.extruded ?? []).map(e => e.loops[0]), ...b.parts.map(pt => pt[0])]).filter(Boolean) as Array<Array<[number, number]>> });
                            } catch (err) {
                                if (isAbort(err)) throw err;
                                cache.writeRunNote(runId, 'revolution_fit', { error: errorMessage(err) });
                                return undefined;
                            }
                        };
                        if (procedural) {
                            const tileBytes = fs.readFileSync(stripped.devegetatedGlb);
                            const bounds = { x0: -covered, z0: -covered, x1: covered, z1: covered };
                            // the bridges and the water (bridge-build.ts): every crossing of a road or rail line over the water,
                            // measured on the scan, its elevation read from a focused leaf-LOD extraction, its detail from
                            // search-grounded references; the ground is not drawn under a deck or over the water
                            let bridgeBuild: BridgeBuildResult | undefined;
                            const bridgeNotes: string[] = [];
                            if (bridgesOn) {
                                const tb = Date.now();
                                io.progress('measuring the bridges where the streets cross the water');
                                const visionSrc = deps.vision && 'client' in deps.vision ? deps.vision : undefined;
                                const chain = visionSrc ? new VisionModelChain<string>({ client: visionSrc.client, candidates: visionSrc.candidates, signal: io.signal, ...chainExtras('massing'), ...(deps.sleep ? { sleep: deps.sleep } : {}) }) : undefined;
                                const geoOrigin: GeodeticOrigin = { lat: extraction.geoAnchor.lat, lng: extraction.geoAnchor.lng, heightMeters: extraction.originEllipsoidalHeightM };
                                try {
                                    bridgeBuild = await buildBridgesLayer({
                                        scan, ground, waterAt: look.waterAt, lines: [...ev.roads, ...(ev.rails ?? [])], within, bounds, tile: () => readTileTriangles(tileBytes), dir,
                                        toGeodetic: (x, z) => { const g = scanToGeodetic(geoOrigin, x, 0, z); return { lat: g.lat, lng: g.lng }; },
                                        focus: async (b, i) => {
                                            const mid = b.stations[b.stations.length >> 1];
                                            const g = scanToGeodetic(geoOrigin, mid.x, 0, mid.z);
                                            const x = await deps.extract({ lat: g.lat, lng: g.lng, radiusM: b.lengthM / 2 + 15, outDir: path.join(dir, 'bridges', String(i), 'focus'), place: placeValue!, signal: io.signal, onProgress: m => io.progress(`bridge ${i + 1}: ${m}`) });
                                            const tile = readTileTriangles(fs.readFileSync(x.texturedGlb));
                                            const off = anchorOffset({ lat: x.geoAnchor.lat, lng: x.geoAnchor.lng, elevation: x.originEllipsoidalHeightM }, { lat: extraction.geoAnchor.lat, lng: extraction.geoAnchor.lng, elevation: extraction.originEllipsoidalHeightM });
                                            for (let k = 0; k < tile.positions.length; k += 3) { tile.positions[k] += off[0]; tile.positions[k + 1] += off[1]; tile.positions[k + 2] += off[2]; }
                                            return tile;
                                        },
                                        ...(chain ? {
                                            read: async (image, mimeType, prompt) => {
                                                const r = await chain.generate({ contents: [{ role: 'user', parts: [{ inlineData: { mimeType, data: image.toString('base64') } }, { text: prompt }] }], config: { responseMimeType: 'application/json', temperature: 0 } }, { stage: 'massing', thinkingBudget: 2048 });
                                                const text = (r.response.candidates?.[0]?.content?.parts ?? []).filter((q: { thought?: boolean }) => !q.thought).map((q: { text?: string }) => q.text ?? '').join('').trim();
                                                if (text) r.remember();
                                                return text || undefined;
                                            }
                                        } : {}),
                                        ...(deps.groundedReferences ? {
                                            references: async req => {
                                                const client = await deps.groundedReferences!();
                                                const res = await fetchGroundedReferences(client, {
                                                    place: placeValue!.formattedAddress, subject: req.subject, view: 'from the river bank, the whole side of the bridge straight on, in even daylight', aspectRatio: '16:9',
                                                    questions: ['what stands on the parapet (lamp standards, columns, statues) and where', 'how the parapet is made (a solid wall, balusters, a railing)', 'the shape of the supports where they meet the water and what caps them', 'how the arches are edged']
                                                }, { signal: io.signal });
                                                return res.references.filter(r => r.image).map(r => ({ image: r.image!.data, mimeType: r.image!.mimeType, model: r.model, account: r.account }));
                                            }
                                        } : {}),
                                        signal: io.signal, onProgress: m => io.progress(m)
                                    });
                                    bridgeNotes.push(...bridgeBuild.notes);
                                } catch (err) {
                                    if (isAbort(err)) throw err;
                                    bridgeNotes.push(`the bridges could not be built (${errorMessage(err)}); the ground drapes over the water as before`);
                                    cache.writeRunNote(runId, 'bridges', { error: errorMessage(err) });
                                }
                                timingsMs.bridges = Date.now() - tb;
                                cache.writeRunNote(runId, 'bridges', { ...(bridgeBuild ? { stats: bridgeBuild.stats, bridges: bridgeBuild.bridges.map(b => b.record) } : {}), notes: bridgeNotes });
                            }
                            const underDeck = bridgeBuild?.underDeck ?? (() => false);
                            const waterCut = bridgeBuild?.waterY !== undefined;
                            // the ground: one measured surface over the extraction, the photo's colour from above
                            const groundFile = path.join(dir, 'ground.glb');
                            const storedGround = findStoredLayer(objectStore, reuseObjects, 'ground', 'surface', frame, groundHash);
                            let groundStats: { vertices: number; triangles: number; openVertices: number; terrainVertices: number; program?: Omit<GroundProgram, 'vertexRegion'> };
                            if (storedGround) {
                                // the ground stored for these very inputs: its bytes as they were written
                                io.progress('the ground is unchanged since it was stored: reusing it');
                                const tg = Date.now();
                                fs.copyFileSync(storedGround, groundFile);
                                const sbGround = parseGlbBytes(fs.readFileSync(groundFile)).json.nodes[0].extras.sbGround;
                                groundStats = { ...sbGround.stats, ...(sbGround.program ? { program: sbGround.program } : {}) };
                                timingsMs.groundReused = Date.now() - tg;
                            } else {
                                io.progress('building the ground from the measured street surface');
                                const tg = Date.now();
                                const surf = buildGroundSurface({ ground, within, bounds, skip: (x, z) => underDeck(x, z) || (waterCut && look.waterAt(x, z)) });
                                const groundPhoto = renderTopDownPhoto(tileBytes, surf.uvFrame, { texelM: 0.1, maxPx: 8192 });
                                // the ground program: each land-use area of the vector evidence read as a region, its material decided from
                                // the scan's roughness, the measured crowns, the carriageways and the photo's colour (the type codes ride along as labels)
                                const landuseAreas = ev.landuse ?? [];
                                const crownDiscs = ((JSON.parse(fs.readFileSync(stripped.crownsJson, 'utf8')) as { crowns?: any[] }).crowns ?? [])
                                    .filter(c => c.status === 'tree' && Array.isArray(c.stem) && Array.isArray(c.sectorRadii))
                                    .map(c => ({ x: Number(c.stem[0]), z: Number(c.stem[1]), radiusM: (c.sectorRadii as number[]).reduce((a, b) => a + b, 0) / 16 }));
                                const { vertexRegion, ...program } = buildGroundProgram({
                                    ground, within, bounds, surface: surf, areas: landuseAreas, areaAt: landuseAreaAt(look), roadAt: look.roadAt,
                                    canopyAt: crownCanopyAt(crownDiscs), photo: { photo: groundPhoto, frame: surf.uvFrame }
                                });
                                const groundJpeg = jpegJs.encode({ data: Buffer.from(groundPhoto.rgba.buffer, groundPhoto.rgba.byteOffset, groundPhoto.rgba.byteLength), width: groundPhoto.width, height: groundPhoto.height }, 88).data;
                                const groundExtras = {
                                    version: PROCEDURAL_GROUND_VERSION, uvFrame: surf.uvFrame, stats: surf.stats, method: `the scan's open surface (within 1.5 m of the measured terrain, its local median) and the terrain where something stands on it${waterCut ? '; not drawn over the water areas' : ''}${bridgeBuild?.bridges.length ? ' nor under the rebuilt bridge decks' : ''}; coloured from a top-down render of the tile photo`,
                                    program, provenance: { heights: 'measured', material: 'generated: decided from the measurements per region (program.regions[].material.why)' },
                                    groundCover: { regions: groundCoverRegions(program, landuseAreas).map(({ loops, ...r }) => r), status: 'not planted: SB-Veggie (scripts/tile_vegetation.cpp) grows measured crowns only and has no low-vegetation input yet' }
                                };
                                writeStagedGlbFile(groundFile, [{ name: 'ground', ...surf.mesh, attributes: { _SB_GROUND_REGION: Float32Array.from(vertexRegion) }, extras: groundExtras }], { rootExtras: { sbGround: groundExtras }, generator: 'scratchbox staged-location procedural-ground', copyright: 'Google', texture: { bytes: groundJpeg, mimeType: 'image/jpeg' } });
                                groundStats = { ...surf.stats, program };
                                timingsMs.ground = Date.now() - tg;
                            }
                            if (plan) manifests['ground.glb'] = wholeManifest('ground', 'surface', groundHash, groundFile, 'l1g', PROCEDURAL_GROUND_VERSION, ['measured']);
                            // the streets: SB-Roadie's carriageways and kerbs over that ground, a default width where no kerb shows
                            let roadsStats: NonNullable<DistrictMassingValue['procedural']>['roads'];
                            const centrelines = ev.roads.filter(l => l.some(([x, z]) => within(x, z)));
                            const roadsFile = path.join(dir, 'roads.glb');
                            const storedRoads = centrelines.length ? findStoredLayer(objectStore, reuseObjects, 'road', 'network', frame, roadsHash) : undefined;
                            if (storedRoads) {
                                io.progress(`the ${centrelines.length} streets are unchanged since they were stored: reusing them`);
                                const tr = Date.now();
                                fs.copyFileSync(storedRoads, roadsFile);
                                const st = parseGlbBytes(fs.readFileSync(roadsFile)).json.nodes[0].extras.sbRoads.stats;
                                roadsStats = { roads: st.roads, stations: st.stations, measuredKerbs: st.measuredKerbs, defaultKerbs: st.defaultKerbs, triangles: st.triangles };
                                timingsMs.roadsReused = Date.now() - tr;
                            } else if (centrelines.length) {
                                const tr = Date.now();
                                io.progress(`measuring ${centrelines.length} streets kerb to kerb`);
                                const P = { ...ROAD_SURFACE_PARAMS, requireBothKerbs: false, liftM: 0.08, buildSidewalks: false };
                                const grid = { ...surfaceModel(scan, 0.5), cellM: 0.5 };
                                const avoid = ((JSON.parse(fs.readFileSync(stripped.crownsJson, 'utf8')) as { crowns?: any[] }).crowns ?? [])
                                    .filter(c => c.status === 'tree' && Array.isArray(c.stem) && Array.isArray(c.sectorRadii))
                                    .map(c => ({ x: Number(c.stem[0]), z: Number(c.stem[1]), radiusM: (c.sectorRadii as number[]).reduce((a, b) => a + b, 0) / 16 }));
                                const measured = measureRoadSurfaces({ roads: centrelines, grid, within, buildingAt: look.buildingAt, groundAt: ground.groundAt, avoid }, P);
                                // where the streets run and how wide they are come from the scan; their levels from the measured ground
                                // a street crossing a rebuilt bridge rides its deck
                                const roads = settleRoadsOnGround(measured, (x, z) => bridgeBuild?.deckYAt(x, z) ?? groundHeightAt(ground, x, z).y, { liftM: P.liftM, defaultHalfWidthM: P.defaultHalfWidthM });
                                if (roads.length) {
                                    const planar = buildRoadMesh(roads, P);
                                    const photo = renderTopDownPhoto(tileBytes, planar.uvFrame, { texelM: 0.1, maxPx: 4096 });
                                    const atlas = synthesizeRoadTextures(roads, photo, planar.uvFrame);
                                    const mesh = buildRoadMesh(roads, P, atlas);
                                    const jpeg = jpegJs.encode({ data: Buffer.from(atlas.rgba.buffer, atlas.rgba.byteOffset, atlas.rgba.byteLength), width: atlas.width, height: atlas.height }, 90).data;
                                    writeRoadsGlb(roadsFile, mesh, { stats: mesh.stats, liftM: P.liftM, markings: atlas.stats, source: 'SB-Roadie in a procedural district: Google vector road centrelines; kerbs measured on the tree-stripped scan where they show, a default width where they do not (labelled per station); tarmac and markings read from the tile photo and redrawn' }, { jpeg: Buffer.from(jpeg), width: atlas.width, height: atlas.height });
                                    roadsStats = { roads: mesh.stats.roads, stations: mesh.stats.stations, measuredKerbs: mesh.stats.measuredKerbs, defaultKerbs: mesh.stats.defaultKerbs, triangles: mesh.stats.triangles };
                                }
                                timingsMs.roads = Date.now() - tr;
                            }
                            // the water: one sheet at its measured level, the tile photo's colour over it
                            let waterStats: NonNullable<DistrictMassingValue['procedural']>['water'];
                            const waterFile = path.join(dir, 'water.glb');
                            if (bridgeBuild?.waterY !== undefined) {
                                const tw = Date.now();
                                const colour = measureWaterColour(tileBytes, look.waterAt, within, bounds);
                                const w = writeWaterGlb(waterFile, { waterAt: look.waterAt, within, bounds, levelY: bridgeBuild.waterY, ...(colour ? { colourSrgb: colour.colourSrgb, colourTexels: colour.texels } : {}) });
                                waterStats = { levelY: round(bridgeBuild.waterY, 2), cells: w.cells, triangles: w.triangles, colourSrgb: colour?.colourSrgb ?? [58, 68, 74], colourMeasured: !!colour };
                                timingsMs.water = Date.now() - tw;
                            }
                            const bridgesFile = bridgeBuild?.file;
                            const bridgesStats: NonNullable<DistrictMassingValue['procedural']>['bridges'] = bridgeBuild ? {
                                ...bridgeBuild.stats, notes: bridgeNotes,
                                perBridge: bridgeBuild.bridges.map(b => ({ id: b.record.id, openings: b.record.openings, supports: b.record.supports, posts: b.record.posts, read: !!b.record.reading, references: b.record.referenceImages, detailAgreed: Object.keys(b.record.detail ?? {}).filter(k => ['posts', 'rail', 'supports', 'arches'].includes(k)), detailRejected: (b.record.detail?.rejected ?? []).map(r => `${r.item}: ${r.reason}`) }))
                            } : undefined;
                            const revolutions = await reviseRevolutions(['district_massing_textured.glb', 'district_massing_clay.glb']);
                            listBuildings();
                            if (plan && roadsStats && fs.existsSync(roadsFile)) manifests['roads.glb'] = wholeManifest('road', 'network', roadsHash, roadsFile, 'l2r', PROCEDURAL_ROADS_VERSION, ['measured', VECTOR_MODELLED_LABEL]);
                            if (plan && bridgesFile) manifests['bridges.glb'] = wholeManifest('bridge', 'network', objectInputHash('bridge', BRIDGE_BUILD_VERSION, stripped.cacheKey, covered.toFixed(1), vectorKey), bridgesFile, 'l2b', BRIDGE_BUILD_VERSION, ['photo-inferred', 'generated']);
                            if (plan && waterStats) manifests['water.glb'] = wholeManifest('water', 'surface', objectInputHash('water', WATER_VERSION, stripped.cacheKey, covered.toFixed(1), ev.water), waterFile, 'l1w', WATER_VERSION, ['generated']);
                            if (plan) writeLayerManifests(dir, manifests);
                            // the texture pass's inputs (user decision 2026-10-22: the staged texture pass on the rebuilt geometry, the
                            // surface library where no photo reaches; no baked shadows): clays and the library fill, read from the files
                            let texturePass: ProceduralTexturingSummary | undefined, texturePassUnavailable: string | undefined;
                            if (deps.textures?.disabled && surfaceMode === 'photo') texturePassUnavailable = deps.textures.disabled;
                            else {
                                const tp = Date.now();
                                try {
                                    const visionSrc = deps.vision && 'client' in deps.vision ? deps.vision : undefined;
                                    texturePass = await prepareProceduralTexturing({
                                        dir, tileBytes, files: { ground: groundFile, ...(fs.existsSync(roadsFile) ? { roads: roadsFile } : {}), massing: texturedFile, ...(bridgesFile ? { bridges: bridgesFile } : {}) },
                                        buildingIds: okRows.map(r => r.id), ...(layer?.run ? { run: layer.run } : {}),
                                        include: (x, z) => within(x, z) && look.buildingAt(x, z) === 0 && !look.waterAt(x, z), library: loadSurfaceLibrary(),
                                        ...(visionSrc ? { chain: new VisionModelChain<string>({ client: visionSrc.client, candidates: visionSrc.candidates, signal: io.signal, ...chainExtras('massing'), ...(deps.sleep ? { sleep: deps.sleep } : {}) }) } : {}),
                                        ...(deps.vision && 'unavailable' in deps.vision ? { unavailable: deps.vision.unavailable } : {}), signal: io.signal, onProgress: m => io.progress(m), mode: surfaceMode
                                    });
                                } catch (err) {
                                    if (isAbort(err)) throw err;
                                    texturePassUnavailable = surfaceMode === 'inferred'
                                        ? `no material could be inferred for the rebuilt surfaces (${errorMessage(err)}); they keep the tile photo laid on them`
                                        : `the rebuilt layers could not be prepared for the texture pass (${errorMessage(err)}); they keep the tile photo laid on them`;
                                }
                                timingsMs.texturePrep = Date.now() - tp;
                            }
                            return { value: { rebuilt: okRows.length, ...summary, caveats, ...(planeFirst ? { planeFirst } : {}), removedTriangles: 0, residualOffFootprint, timingsMs, ...(revolutions ? { revolutions } : {}), ...(objects ? { objects: { ...objects, groundReused: !!storedGround, roadsReused: !!storedRoads } } : {}), procedural: { ground: { vertices: groundStats.vertices, triangles: groundStats.triangles, openVertices: groundStats.openVertices, terrainVertices: groundStats.terrainVertices, ...(groundStats.program ? { program: groundStats.program } : {}) }, ...(roadsStats ? { roads: roadsStats } : {}), ...(texturePass ? { texturePass } : {}), ...(texturePassUnavailable ? { texturePassUnavailable } : {}), ...(bridgesStats ? { bridges: bridgesStats } : {}), ...(waterStats ? { water: waterStats } : {}) } } };
                        }
                        // the scan's own buildings out where the rebuilt ones stand: the clay remesh and tile_refine's textured twin alike
                        const clay = hideFootprintInGlb(fs.readFileSync(refined.clayGlb), footprint);
                        fs.writeFileSync(path.join(dir, 'remesh_carved.glb'), clay.glb);
                        fs.writeFileSync(path.join(dir, 'remesh_carved_textured.glb'), hideFootprintInGlb(fs.readFileSync(refined.texturedGlb), footprint).glb);
                        const revolutions = await reviseRevolutions(['district_massing_textured.glb', 'district_massing_clay.glb', 'remesh_carved.glb', 'remesh_carved_textured.glb']);
                        listBuildings();
                        if (plan) writeLayerManifests(dir, manifests);
                        return { value: { rebuilt: okRows.length, ...summary, caveats, ...(planeFirst ? { planeFirst } : {}), removedTriangles: clay.removedTriangles, residualOffFootprint, timingsMs, ...(revolutions ? { revolutions } : {}), ...(objects ? { objects } : {}) } };
                    }, {
                        publish: (dir, v) => !v.rebuilt ? []
                            : v.procedural?.texturePass?.inferred ? [
                                // each surface in the material inferred for it (no texture pass needed)
                                { from: v.procedural.texturePass.inferred.massing, as: `${base}_massing_${key8}.glb` }, { from: v.procedural.texturePass.inferred.ground, as: `${base}_ground_${key8}.glb` },
                                ...(v.procedural.texturePass.inferred.roads ? [{ from: v.procedural.texturePass.inferred.roads, as: `${base}_proc_roads_${key8}.glb` }] : []), ...(v.revolutions?.accepted ? [{ from: 'revolutions.glb', as: `${base}_revolutions_${key8}.glb` }] : [])
                            ]
                            : v.procedural?.texturePass ? [
                                // clay, for the texture pass to texture (the tile photo transferred and relit, the library where it does not reach)
                                { from: 'massing_clay.glb', as: `${base}_massing_${key8}.glb` }, { from: 'ground_clay.glb', as: `${base}_ground_${key8}.glb` },
                                ...(fs.existsSync(path.join(dir, 'roads_clay.glb')) ? [{ from: 'roads_clay.glb', as: `${base}_proc_roads_${key8}.glb` }] : []), ...(v.revolutions?.accepted ? [{ from: 'revolutions.glb', as: `${base}_revolutions_${key8}.glb` }] : []),
                                ...(fs.existsSync(path.join(dir, 'bridges_clay.glb')) ? [{ from: 'bridges_clay.glb', as: `${base}_bridges_${key8}.glb` }] : fs.existsSync(path.join(dir, 'bridges.glb')) ? [{ from: 'bridges.glb', as: `${base}_bridges_${key8}.glb` }] : []),
                                ...(fs.existsSync(path.join(dir, 'water.glb')) ? [{ from: 'water.glb', as: `${base}_water_${key8}.glb` }] : [])
                            ]
                            : v.procedural ? [{ from: 'district_massing_textured.glb', as: `${base}_massing_${key8}.glb` }, { from: 'ground.glb', as: `${base}_ground_${key8}.glb` }, ...(fs.existsSync(path.join(dir, 'roads.glb')) ? [{ from: 'roads.glb', as: `${base}_proc_roads_${key8}.glb` }] : []), ...(v.revolutions?.accepted ? [{ from: 'revolutions.glb', as: `${base}_revolutions_${key8}.glb` }] : []),
                                ...(fs.existsSync(path.join(dir, 'bridges.glb')) ? [{ from: 'bridges.glb', as: `${base}_bridges_${key8}.glb` }] : []), ...(fs.existsSync(path.join(dir, 'water.glb')) ? [{ from: 'water.glb', as: `${base}_water_${key8}.glb` }] : [])]
                            : [{ from: 'district_massing_textured.glb', as: `${base}_massing_${key8}.glb` }, { from: 'remesh_carved.glb', as: `${base}_remesh_carved_${key8}.glb` }, ...(v.revolutions?.accepted ? [{ from: 'revolutions.glb', as: `${base}_revolutions_${key8}.glb` }] : [])],
                        bypass: bypass('massing')
                    });
                    const v = entry.value;
                    cache.writeRunNote(runId, 'district_massing', { key, cached: entry.cached, ...v });
                    let manifests = v.rebuilt && objectStore ? readLayerManifests(entry.dir) : {};
                    if (v.rebuilt && objectStore && !manifests['district_massing_textured.glb']) {
                        // an entry massed before the object store: its buildings are listed now (the inputs are the entry's own)
                        io.progress('listing the buildings of an earlier massing for the object store');
                        try {
                            const tb = Date.now();
                            const { scan, within, okRows } = massRows();
                            const plan = planDistrictObjects({ rows: okRows, buildings: ev.buildings, scan, look, within, frame, versions: objectVersions, reuse: false });
                            const file = path.join(entry.dir, 'district_massing_textured.glb');
                            manifests = { ...manifests, 'district_massing_textured.glb': districtMassingManifest(parseGlbBytes(fs.readFileSync(file)), sha256File(file), okRows, plan.owners, plan.hashes, massProducer) };
                            if (v.procedural) {
                                const g = path.join(entry.dir, 'ground.glb'), r = path.join(entry.dir, 'roads.glb');
                                if (fs.existsSync(g)) manifests['ground.glb'] = wholeManifest('ground', 'surface', groundHash, g, 'l1g', PROCEDURAL_GROUND_VERSION, ['measured']);
                                if (fs.existsSync(r)) manifests['roads.glb'] = wholeManifest('road', 'network', roadsHash, r, 'l2r', PROCEDURAL_ROADS_VERSION, ['measured', VECTOR_MODELLED_LABEL]);
                            }
                            writeLayerManifests(entry.dir, manifests);
                            cache.writeRunNote(runId, 'object_manifest_backfill', { ms: Date.now() - tb, buildings: okRows.length });
                        } catch (err) {
                            if (isAbort(err)) throw err;
                            cache.writeRunNote(runId, 'object_manifest_backfill', { error: errorMessage(err) });
                        }
                    }
                    if (!v.rebuilt) return { status: 'skipped', value: v, source: 'the remeshed scan stands', reason: `no building passed its check (${Object.entries(v.reasons).map(([k, n]) => `${n}: ${k}`).join('; ')})`, cached: entry.cached };
                    const [pubMass, pubCarved] = entry.published;
                    const remeshLayer = run.state.layers.find(l => l.objectId === remeshId)!;
                    // the facade grammar's l2g is the same scan with windows read in, landing in parallel: once it has settled, the
                    // layers here replace it too, or it stands over the rebuilt buildings
                    await grammarGate.settled;
                    const replaced = [remeshId, ...run.state.layers.filter(l => l.layer === 'l2g' && !l.retired).map(l => l.objectId)];
                    const why = Object.entries(v.reasons).map(([k, n]) => `${n} ${k}`).join('; ');
                    const sources = [{ kind: 'vector-tiles', id: `vectortiles:${vectorKey.slice(0, 8)}` }, { kind: 'tile-extraction', id: `extract:${t.key.slice(0, 8)}` }];
                    const massLayer: StagedLayer = {
                        objectId: layerObjectId(key, 'l2m'), stage: 'massing', layer: 'l2m', order: STAGES.massing.order, url: pubMass.url, bytes: pubMass.bytes,
                        provenance: {
                            label: VECTOR_MODELLED_LABEL, measuredGeometry: false, confidence: 0.8,
                            method: `${DISTRICT_MASSING_VERSION}: each building that passes its own check (footprint raised in the scan, no scan spilling past it, roof within pipeline E's error, wholly inside the extraction) rebuilt from its Google footprint at the heights and setbacks the scan measures, ${v.planeFirst ? "each wall one plumb plane at the depth the scan measures (its lumps snapped flat), relief only where the scan departs from the plane consistently over a real area; buildings failing a soft check rebuilt with it as their caveat" : 'walls snapped to the scanned facades'}, textured from the tile photo`,
                            sources: [{ kind: 'vector-tiles', id: `vectortiles:${vectorKey.slice(0, 8)}` }, { kind: 'tile-extraction', id: `extract:${t.key.slice(0, 8)}` }],
                            note: `${v.rebuilt} of ${v.buildings} buildings rebuilt (roof ${v.roofErrMedianM} m off the scan, median); the rest keep the scan${why ? ` (${why})` : ''}${v.planeFirst ? `; plane-first walls: ${v.planeFirst.measured} measured planes, ${v.planeFirst.estimated} estimated (no clean plane, labelled generated), ${v.planeFirst.unseen} on the footprint edge (the scan does not see them); ${v.planeFirst.recesses} recesses and ${v.planeFirst.projections} projections kept (${v.planeFirst.rejectedRelief} did not fit their wall); ${v.planeFirst.residualRemovedAreaM2} m2 of scan lumps on the walls snapped flat; ${v.caveats ?? 0} rebuilt despite a failed check, labelled with it` : ''}`
                        },
                        provenanceLabels: [VECTOR_MODELLED_LABEL, PROVENANCE.asScanned], supersedes: [], revealAfter: [],
                        reveal: { durationMs: 1200, stagger: 0.3, crossfadeFrom: [] }, cached: entry.cached, builtAtMs: entry.builtAtMs, counts: layerCounts(pubMass.path)
                    };
                    const carvedLayer: StagedLayer = {
                        ...remeshLayer, objectId: layerObjectId(key, 'l2c'), stage: 'massing', layer: 'l2c', url: pubCarved.url, bytes: pubCarved.bytes,
                        provenance: { ...remeshLayer.provenance, note: `${remeshLayer.provenance.note ? `${remeshLayer.provenance.note}; ` : ''}the ${v.rebuilt} rebuilt buildings' scan taken out (${v.removedTriangles} triangles)` },
                        supersedes: replaced, revealAfter: [], reveal: { durationMs: 800, stagger: 0, crossfadeFrom: replaced }, cached: entry.cached, builtAtMs: entry.builtAtMs, counts: layerCounts(pubCarved.path)
                    };
                    delete (carvedLayer as Partial<StagedLayer>).textured;
                    // the rebuilt solids of revolution: their own layer, self-coloured from the tile photo
                    const pubRev = v.revolutions?.accepted ? entry.published.find(p => p.url.includes(`_revolutions_${key8}`)) : undefined;
                    const revLayer: StagedLayer | undefined = pubRev && v.revolutions ? {
                        objectId: layerObjectId(key, 'l2v'), stage: 'massing', layer: 'l2v', order: STAGES.massing.order, url: pubRev.url, bytes: pubRev.bytes,
                        provenance: {
                            label: 'generated', measuredGeometry: false, confidence: round(Math.min(...v.revolutions.revolutions.map(r => r.confidence)), 3),
                            method: `${REVOLUTION_FIT_VERSION}: parts whose horizontal sections the scan measures as circles about one vertical axis, rebuilt as one smooth profile (rings where the sections step, stacked revolutions above the cap, periodic ribs only where the residual shows them) instead of the scan's dented copy; masts as their measured sections; ribs the scan cannot resolve from search-grounded references only where they agree (an estimate where they disagree on a count), labelled per node; coloured per height from the de-lit tile photo`,
                            sources, note: v.revolutions.revolutions.map(r => r.summary).join(' | ')
                        },
                        provenanceLabels: ['generated'], supersedes: [], revealAfter: [], reveal: { durationMs: 1200, stagger: 0.3, crossfadeFrom: [] },
                        cached: entry.cached, builtAtMs: entry.builtAtMs, counts: layerCounts(pubRev.path)
                    } : undefined;
                    if (v.procedural) {
                        // the procedural district: the rebuilt buildings, the measured ground and the streets; the scan's layer is superseded
                        const [, pubGround, pubRoads] = entry.published;
                        // prepared for the texture pass: clay layers it textures (the tile photo transferred and relit, the library
                        // where no photo reaches); otherwise each layer is its own textured twin (the tile photo laid on it): the
                        // viewport keeps a twin's photo material through its clay pass, as it does every other twin's
                        const inferred = v.procedural.texturePass?.inferred ? v.procedural.texturePass : undefined;
                        const tp = inferred ? undefined : v.procedural.texturePass;
                        const fillSpec = path.join(entry.dir, 'fill-spec.json');
                        const ownTwin = (pub: { url: string; bytes: number }, method: string): StagedLayer['textured'] => (inferred ? {
                            url: pub.url, bytes: pub.bytes, ladderRung: 5, rungShares: [0, 0, 0, 0, 0, 1, 0],
                            provenance: [{ source: 'surface-library', label: 'generated', method: 'a library material inferred per surface by the vision model, at real scale, tinted to the colour measured on lit tile-photo texels; no photo texel drawn', coverage: 1 }], confidenceChannels: CONFIDENCE_CHANNELS, builtAtMs: entry.builtAtMs, cached: entry.cached
                        } : {
                            url: pub.url, bytes: pub.bytes, ladderRung: 2, rungShares: [0, 0, 1, 0, 0, 0, 0],
                            provenance: [{ source: 'tile-photo', label: 'as-scanned', method, coverage: 1 }], confidenceChannels: CONFIDENCE_CHANNELS, builtAtMs: entry.builtAtMs, cached: entry.cached
                        });
                        const twinOr = (pub: { url: string; bytes: number }, method: string): Pick<StagedLayer, 'textured'> => (tp ? {} : { textured: ownTwin(pub, method) });
                        const texExtra = (extra: Record<string, unknown>) => ({ ...extra, ...(tp ? { proceduralFill: fillSpec } : { selfTextured: true }) });
                        const texNote = inferred ? `; each surface in the material the vision model inferred for it (${Object.entries(inferred.entries).map(([k, n]) => `${k} x${n}`).join(', ')}; ${inferred.byVision} by vision, ${inferred.byColour} by measured colour alone), tinted to its lit colour` : tp ? `; textured by the texture pass (the tile photo transferred onto its own atlas, its lighting corrected; the surface library where no photo reaches: ${Object.entries(tp.entries).map(([k, n]) => `${k} x${n}`).join(', ')}, ${tp.byVision} chosen by the vision model, ${tp.byColour} by measured colour alone)` : v.procedural.texturePassUnavailable ? `; ${v.procedural.texturePassUnavailable}` : '';
                        const groundLayer: StagedLayer = {
                            objectId: layerObjectId(key, 'l1g'), stage: 'massing', layer: 'l1g', order: STAGES.remesh.order, url: pubGround.url, bytes: pubGround.bytes,
                            provenance: {
                                label: 'measured', measuredGeometry: true, confidence: v.procedural.ground.vertices ? round(v.procedural.ground.openVertices / v.procedural.ground.vertices, 3) : 0,
                                method: `${PROCEDURAL_GROUND_VERSION}: the street surface the scan measures (its open surface's local median; the terrain where something stands on it), coloured from a top-down render of the tile photo`,
                                sources, note: `${v.procedural.ground.openVertices} vertices on the scan's open surface, ${v.procedural.ground.terrainVertices} on the terrain under something standing there${v.procedural.ground.program ? `; ground program (material generated per region from the measurements; ${v.procedural.ground.program.landuse.areas} Google land-use areas, type codes as labels: ${v.procedural.ground.program.landuse.typeCodes.join(', ') || 'none'}): ${groundProgramNotes(v.procedural.ground.program).join(' | ')}` : ''}`
                            },
                            provenanceLabels: ['measured'], supersedes: replaced, revealAfter: [], reveal: { durationMs: 1000, stagger: 0, crossfadeFrom: replaced },
                            cached: entry.cached, builtAtMs: entry.builtAtMs, counts: layerCounts(pubGround.path),
                            ...twinOr(pubGround, 'a top-down render of the tile photo, planar onto the ground surface')
                        };
                        if (tp) groundLayer.provenance = { ...groundLayer.provenance, method: groundLayer.provenance.method.replace(', coloured from a top-down render of the tile photo', ''), note: `${groundLayer.provenance.note}${texNote}; ${tp.groundRegions} ground regions by appearance (${tp.shadowedCells} cast-shadow cells set aside)` };
                        const massCommitted: StagedLayer = { ...massLayer, provenance: { ...massLayer.provenance, ...(tp ? { method: massLayer.provenance.method.replace(', textured from the tile photo', '') } : {}), note: `${massLayer.provenance.note}; ${v.caveats ?? 0} rebuilt despite a failed check (lenient: the scan is not shown), labelled with it${texNote}` } };
                        const layers: StagedLayer[] = [massCommitted, groundLayer];
                        run.commit(layers[0], { source: 'DistrictMassing', resolvedAddress: placeValue!.formattedAddress, extra: texExtra({ rebuilt: v.rebuilt, stageDir: entry.dir }) });
                        run.commit(groundLayer, { source: 'ProceduralGround', resolvedAddress: placeValue!.formattedAddress, extra: texExtra({}) });
                        if (revLayer) { run.commit(revLayer, { source: 'RevolutionFit', resolvedAddress: placeValue!.formattedAddress, extra: { selfTextured: true } }); layers.push(revLayer); }
                        if (manifests['district_massing_textured.glb']) run.objectManifests.set(layers[0].objectId, { ...manifests['district_massing_textured.glb'], sourceFile: path.join(entry.dir, 'district_massing_textured.glb') });
                        if (manifests['ground.glb']) run.objectManifests.set(groundLayer.objectId, { ...manifests['ground.glb'], sourceFile: path.join(entry.dir, 'ground.glb') });
                        run.setGround(groundLayer.objectId);
                        // the bridges (bridge-build.ts) and the water
                        const pubBridges = entry.published.find(p => p.url.includes(`_bridges_${key8}`)), pubWater = entry.published.find(p => p.url.includes(`_water_${key8}`));
                        const bst = v.procedural.bridges;
                        if (pubBridges && bst?.bridges) {
                            const agreed = bst.perBridge.flatMap(b => b.detailAgreed), rejected = bst.perBridge.flatMap(b => b.detailRejected);
                            const bridgeLayer: StagedLayer = {
                                objectId: layerObjectId(key, 'l2b'), stage: 'massing', layer: 'l2b', order: STAGES.massing.order, url: pubBridges.url, bytes: pubBridges.bytes,
                                provenance: {
                                    label: 'photo-inferred', measuredGeometry: false, confidence: bst.read ? 0.7 : 0.5,
                                    method: `${BRIDGE_BUILD_VERSION}: each crossing of a street or rail line over the water measured on the scan (deck level, width, elevation probed on both faces), its openings (springing and crown), fascia and parapet read by the vision model off a tile photo elevation rendered from a focused leaf-LOD extraction (photo-inferred); the parapet's make, the supports' noses and caps, the arch rings and the posts read from search-grounded reference images where independent references agree and the scan does not contradict them (generated, never measured); built natively as sweeps, solids of revolution and replicators`,
                                    sources, note: `${bst.bridges} bridge${bst.bridges === 1 ? '' : 's'}, ${bst.openings} openings; ${bst.read} elevation${bst.read === 1 ? '' : 's'} read, ${bst.focused} from a focused extraction; ${bst.referenced} reference reading${bst.referenced === 1 ? '' : 's'}${agreed.length ? `; detail agreed: ${[...new Set(agreed)].join(', ')}` : ''}${rejected.length ? `; left out: ${rejected.join('; ')}` : ''}${bst.notes.length ? `; ${bst.notes.join('; ')}` : ''}${texNote}`
                                },
                                provenanceLabels: ['photo-inferred', 'generated'], supersedes: [], revealAfter: [], reveal: { durationMs: 1200, stagger: 0.3, crossfadeFrom: [] },
                                cached: entry.cached, builtAtMs: entry.builtAtMs, counts: layerCounts(pubBridges.path),
                                ...twinOr(pubBridges, 'the measured structure colour on every face (vertex colours; the texture pass could not be prepared)')
                            };
                            run.commit(bridgeLayer, { source: 'ProceduralBridges', resolvedAddress: placeValue!.formattedAddress, extra: texExtra({ bridges: bst.bridges }) });
                            if (manifests['bridges.glb']) run.objectManifests.set(bridgeLayer.objectId, { ...manifests['bridges.glb'], sourceFile: path.join(entry.dir, 'bridges.glb') });
                            layers.push(bridgeLayer);
                        }
                        if (pubWater && v.procedural.water) {
                            const w = v.procedural.water;
                            const waterLayer: StagedLayer = {
                                objectId: layerObjectId(key, 'l1w'), stage: 'massing', layer: 'l1w', order: STAGES.remesh.order, url: pubWater.url, bytes: pubWater.bytes,
                                provenance: {
                                    label: 'generated', measuredGeometry: false, confidence: 0.6,
                                    method: `${WATER_VERSION}: one flat sheet over Google's water areas at the level the scan measures (a low percentile of its surface over the water), in the median colour of the tile photo over the water, with generated ripples`,
                                    sources, note: `level ${w.levelY} m, ${w.cells} cells; colour ${w.colourMeasured ? 'measured on the tile photo' : 'a default (too little water in the photo)'}; photogrammetry holds no water surface: the sheet is drawn, its level and colour measured`
                                },
                                provenanceLabels: ['generated'], supersedes: [], revealAfter: [], reveal: { durationMs: 1000, stagger: 0, crossfadeFrom: [] },
                                cached: entry.cached, builtAtMs: entry.builtAtMs, counts: layerCounts(pubWater.path),
                                textured: ownTwin(pubWater, 'the tile photo\'s measured water colour with generated ripples')
                            };
                            run.commit(waterLayer, { source: 'ProceduralWater', resolvedAddress: placeValue!.formattedAddress, extra: { selfTextured: true } });
                            if (manifests['water.glb']) run.objectManifests.set(waterLayer.objectId, { ...manifests['water.glb'], sourceFile: path.join(entry.dir, 'water.glb') });
                            layers.push(waterLayer);
                        }
                        if (pubRoads && v.procedural.roads) {
                            const r = v.procedural.roads;
                            const roadLayer: StagedLayer = {
                                objectId: layerObjectId(key, 'l2r'), stage: 'massing', layer: 'l2r', order: STAGES.roads.order, url: pubRoads.url, bytes: pubRoads.bytes,
                                provenance: {
                                    label: r.measuredKerbs >= r.defaultKerbs ? 'measured' : VECTOR_MODELLED_LABEL, measuredGeometry: true, confidence: round(r.measuredKerbs / Math.max(1, r.measuredKerbs + r.defaultKerbs), 3),
                                    method: 'SB-Roadie: carriageways and kerbs swept along Google vector road centrelines through the levels the scan measures; kerbs measured where they show, a default width where they do not; tarmac and lane markings read from the tile photo and redrawn',
                                    sources, note: `${r.roads} street runs, ${r.stations} stations; ${r.measuredKerbs} kerbs measured, ${r.defaultKerbs} defaulted`
                                },
                                provenanceLabels: ['measured', VECTOR_MODELLED_LABEL], supersedes: [], revealAfter: [], reveal: { durationMs: 1200, stagger: 0.3, crossfadeFrom: [] },
                                cached: entry.cached, builtAtMs: entry.builtAtMs, counts: layerCounts(pubRoads.path),
                                ...twinOr(pubRoads, 'tarmac and lane markings read along each street from the top-down tile photo and redrawn')
                            };
                            if (tp) roadLayer.provenance = { ...roadLayer.provenance, method: roadLayer.provenance.method.replace('; tarmac and lane markings read from the tile photo and redrawn', ''), note: `${roadLayer.provenance.note}${texNote}` };
                            run.commit(roadLayer, { source: 'GoogleVectorRoads', resolvedAddress: placeValue!.formattedAddress, extra: texExtra({}) });
                            if (manifests['roads.glb']) run.objectManifests.set(roadLayer.objectId, { ...manifests['roads.glb'], sourceFile: path.join(entry.dir, 'roads.glb') });
                            layers.push(roadLayer);
                        }
                        return { status: 'committed', value: v, layers, source: `procedural district: ${v.rebuilt} of ${v.buildings} buildings rebuilt, the ground measured${v.procedural.roads ? `, ${v.procedural.roads.roads} streets` : ''}${v.procedural.bridges?.bridges ? `, ${v.procedural.bridges.bridges} bridge${v.procedural.bridges.bridges === 1 ? '' : 's'} over the water` : ''}; the scan superseded (kept as the reference)`, cached: entry.cached, builtAtMs: entry.builtAtMs };
                    }
                    run.commit(massLayer, { source: 'DistrictMassing', resolvedAddress: placeValue!.formattedAddress, extra: { selfTextured: true, rebuilt: v.rebuilt } });
                    if (manifests['district_massing_textured.glb']) run.objectManifests.set(massLayer.objectId, { ...manifests['district_massing_textured.glb'], sourceFile: path.join(entry.dir, 'district_massing_textured.glb') });
                    refineTextured.set(carvedLayer.objectId, path.join(entry.dir, 'remesh_carved_textured.glb'));
                    run.commit(carvedLayer, run.layerMeta[remeshId]);
                    run.setGround(carvedLayer.objectId);
                    if (revLayer) run.commit(revLayer, { source: 'RevolutionFit', resolvedAddress: placeValue!.formattedAddress, extra: { selfTextured: true } });
                    return { status: 'committed', value: v, layers: [massLayer, carvedLayer, ...(revLayer ? [revLayer] : [])], source: `${v.rebuilt} of ${v.buildings} buildings rebuilt from their footprints and the scan, the remesh carved where they stand`, cached: entry.cached, builtAtMs: entry.builtAtMs };
                },
                degrade: async err => ({
                    status: 'degraded', source: 'the remeshed scan stands', reason: `the district's buildings could not be rebuilt (${errorMessage(err)})`,
                    degradations: [run.degrade(record('massing', 'district_massing_failed', {
                        part: { description: "the district's buildings" }, intended: 'each building rebuilt from its footprint and the scan, the remesh carved where it stands',
                        fellTo: 'the remeshed scan', provenanceAfter: PROVENANCE.remeshed, reason: `the district massing failed (${errorMessage(err)})`, cause: err, transient: false, runId, now: now(), reuses: ['resolve', 'tiles', 'trees-measure', 'remesh']
                    }))]
                })
            }).catch(err => { if (isAbort(err)) throw err; });
            massingGate.settled = massingPromise;
            siblings.push(massingPromise);
        } else {
            runner.skip('massing', request.isolate ? 'an isolated structure is rebuilt by its own pipeline'
                : kdDistrict ? "pipeline K-D keeps the district's scan and straightens its facades instead of massing its buildings again"
                : !districtMassingEnabled(request) ? 'the district is shown as scanned (district "scan" or SCRATCHBOX_STAGED_DISTRICT=scan; massing, the default, rebuilds its buildings)'
                : !strip ? 'the trees were not measured: there is no tree-free scan to measure the buildings on'
                : !deps.vectorEvidence ? 'no Google vector data: no footprints to rebuild from'
                : 'the remesh did not commit: there is nothing to rebuild the buildings in');
        }

        // ---------------- trees (plant) ‖ the rebuild ----------------
        const treesRun = async (): Promise<{ trees?: LocationClayTrees; putBack?: { triangles: number; crowns: number; reason: string } }> => {
            const remeshed = remeshedNow;
            if (!request.trees || request.procedural === true || (pipelineK && isolateMode)) { runner.skip('trees', request.procedural === true ? PROCEDURAL_ONLY : pipelineK && isolateMode ? 'a single building keeps no surroundings, so no trees are planted' : 'trees were not asked for'); return {}; }
            if (!strip) { runner.skip('trees', 'the trees were not measured, so the scan keeps its own'); return {}; }
            if (!remeshed) {
                const rec = run.degrade(record('trees', 'trees_stay_scanned', {
                    part: { description: 'the measured trees' }, intended: 'trees grown to the measured crown', fellTo: 'the trees as scanned, inside the raw scan',
                    provenanceAfter: PROVENANCE.asScanned, reason: 'the remesh failed, so the trees stay as scanned in the scan that stands in for it; no SB-Veggie tree is planted over scanned canopy', transient: true, runId, now: now(), reuses: ['resolve', 'tiles', 'trees-measure']
                }));
                runner.skip('trees', 'the remesh failed: the trees stay as scanned in the raw scan', [rec]);
                return {};
            }
            let summaryTrees: LocationClayTrees | undefined;
            let putBack: { triangles: number; crowns: number; reason: string } | undefined;
            const remeshLayer = run.state.layers.find(l => l.layer === 'l2' && l.stage === 'remesh')!;
            await runner.stage<LocationClayTrees>({
                id: 'trees',
                run: async io => {
                    const crownsFile = JSON.parse(fs.readFileSync(strip!.crownsJson, 'utf8'));
                    const crowns = crownsFile.crowns ?? [];
                    // "everything in a tile" object catalog (user decision, 2026-10-21): every measured crown is a
                    // discovered tree, bounding box included - crowns.json's own frame.anchor is this run's measured
                    // geodetic origin, so no separate conversion is needed to place it in the durable catalog. A crown
                    // the extraction boundary cuts through (status cut_at_boundary[_removed]) is cataloged too, at
                    // lower confidence and labelled as truncated, instead of vanishing as unlabelled raw scan geometry
                    // (user report, 2026-10-21, with a screenshot: an unrecognisable blob at an extraction edge that
                    // "may only be detectable by seeing the adjacent tile" - this crown IS already measured enough to
                    // know it is probably a tree; what is missing is the neighbouring tile's geometry to regrow it,
                    // not the knowledge that something is there. Growing the extraction to the whole crown, the way
                    // sizeExtraction already does for buildings (extraction-sizing.ts), is the fuller fix and is not
                    // done here - this only stops the honest, already-measured half of the answer from being thrown away).
                    if (crownsFile.frame?.anchor) {
                        const geoOrigin: GeodeticOrigin = { lat: crownsFile.frame.anchor.lat, lng: crownsFile.frame.anchor.lng, heightMeters: crownsFile.frame.anchor.ellipsoidalHeightM ?? 0 };
                        const catalogable = crowns.filter((c: any) => (c.status === 'tree' || c.status === 'cut_at_boundary' || c.status === 'cut_at_boundary_removed') && c.stem && c.apex);
                        recordDiscoveredObjects(catalogable.map((c: any) => {
                            const cut = c.status !== 'tree';
                            const r = Math.max(0, ...(Array.isArray(c.sectorRadii) ? c.sectorRadii : [0]));
                            const lo = scanToGeodetic(geoOrigin, c.stem[0] - r, c.supportY ?? c.apex[1], c.stem[1] - r);
                            const hi = scanToGeodetic(geoOrigin, c.stem[0] + r, c.apex[1], c.stem[1] + r);
                            const centre = scanToGeodetic(geoOrigin, c.stem[0], c.apex[1], c.stem[1]);
                            return {
                                type: 'SB_FEATURE_TYPE_TREE',
                                label: cut
                                    ? `crown cut by the extraction boundary (${Math.round((c.areaM2 ?? 0))} m2 measured so far); likely a tree, not regrown - the neighbouring tile has the rest of it`
                                    : `measured crown, ${Math.round((c.apexAboveSupport ?? 0) * 10) / 10} m tall, ${Math.round((c.areaM2 ?? 0))} m2`,
                                confidence: cut ? 0.4 : 1,
                                lat: centre.lat, lng: centre.lng,
                                bboxLo: { lat: Math.min(lo.lat, hi.lat), lng: Math.min(lo.lng, hi.lng), alt: lo.alt }, bboxHi: { lat: Math.max(lo.lat, hi.lat), lng: Math.max(lo.lng, hi.lng), alt: hi.alt },
                                source: 'tree-crown', runId
                            };
                        }));
                    }
                    const toPlant = crowns.filter((c: any) => c.status === 'tree').length;
                    const kept = crowns.filter((c: any) => c.status === 'not_regrowable').length;
                    if (toPlant === 0 && !(isolateMode && kept > 0)) {
                        summaryTrees = summarizeTrees(strip!, undefined, { isolate: isolateMode, stripMs: strip!.ms });
                        return { status: 'committed', value: summaryTrees, source: summaryTrees.outcome };
                    }
                    // SB-Veggie comes first: the trees stand where they were measured; the road stage keeps its ribbons clear of their crowns
                    const stripForPlant = strip!;
                    io.progress(`growing ${toPlant} SB-Veggie trees to their measured crowns`);
                    const planted = await plantTrees({ vegetation: deps.vegetation }, stripForPlant, {
                        treeTriangleBudget: request.treeTriangleBudget,
                        // a crown's shape alone can match a climate-limited species (a palm) regardless of where the
                        // build actually is; this build's own measured latitude costs that match down (user report,
                        // 2026-10-21, with a screenshot: a thin, tall "palm-shaped" tree in New York).
                        // and its signed place, for the species choice's region cost (the same strip was given)
                        place: treeSpeciesPlaceParams(run.geoAnchor),
                        supportMeshPath: isolateMode ? remeshed.clayGlb : undefined,
                        groundMeshPath: remeshed.clayGlb,
                        signal: io.signal
                    });
                    run.keys.trees = planted.cacheKey;
                    run.cacheStatus.trees = planted.cached ? 'hit' : 'miss';
                    if (planted.rebuiltStaleCache) io.progress(planted.rebuiltStaleCache);
                    let url: string | undefined;
                    const layers: StagedLayer[] = [];
                    if (Number(planted.stats.trees ?? 0) > 0) {
                        const remembered = cache.remember('trees', planted.cacheKey, { trees: planted.treesGlb }, [{ from: planted.treesGlb, as: `${base}_trees_${planted.cacheKey.slice(0, 8)}.glb` }], { ms: planted.ms });
                        url = remembered.published[0].url;
                        layers.push({
                            objectId: layerObjectId(planted.cacheKey, 'l5'), stage: 'trees', layer: 'l5', order: STAGES.trees.order, url, bytes: remembered.published[0].bytes,
                            provenance: {
                                // the stem, extent and height are measured; the branching inside the crown is grown, so the geometry is not measurement (unrated)
                                label: PROVENANCE.grownToMeasuredCrown, measuredGeometry: false, confidence: 0,
                                method: 'SB-Veggie space colonisation grown inside each crown measured in the photo tiles (stem, extent and height measured; the branching is procedural)',
                                sources: [{ kind: 'stage-output', id: `trees-measure:${strip!.cacheKey.slice(0, 8)}` }],
                                inferred: Object.fromEntries(Object.entries(planted.stats.inferred ?? {}).filter(([, v]) => typeof v === 'number')) as Record<string, number>
                            },
                            provenanceLabels: [PROVENANCE.grownToMeasuredCrown], supersedes: [], revealAfter: [remeshLayer.objectId],
                            reveal: { durationMs: 1500, stagger: 0.3, crossfadeFrom: [] }, cached: planted.cached, builtAtMs: remembered.builtAtMs,
                            counts: layerCounts(planted.treesGlb)
                        });
                    }
                    summaryTrees = summarizeTrees(strip!, planted, { isolate: isolateMode, stripMs: strip!.ms, plantMs: planted.ms, treeTriangleBudget: request.treeTriangleBudget, ...(url ? { url } : {}) });
                    if (layers[0]) {
                        run.commit(layers[0], {
                            source: 'SB-Veggie', vegetation: true, resolvedAddress: placeValue!.formattedAddress,
                            extra: {
                                generator: 'space colonisation from the measured crowns', treeCount: summaryTrees.count, treesLeftAsScanned: summaryTrees.notRegrowable,
                                canopyAreaM2: summaryTrees.treeCanopyAreaM2, measuredFrom: extraction.rawGlbPath ?? extraction.texturedGlb
                            }
                        });
                        // the scene object store keeps each grown tree as its own GLB when the build finishes
                        if (objectStoreEnabled() && defaultDurableAssetStore()) {
                            try {
                                run.objectManifests.set(layers[0].objectId, {
                                    ...treesManifest(parseGlbBytes(fs.readFileSync(planted.treesGlb)), sha256File(planted.treesGlb), { stage: 'trees', stageKey: planted.cacheKey, layer: 'l5', version: 'sb-veggie-trees' }),
                                    sourceFile: planted.treesGlb
                                });
                            } catch (err) {
                                cache.writeRunNote(runId, 'object_manifest_trees', { error: errorMessage(err) });
                            }
                        }
                    }
                    run.note(PROVENANCE.grownToMeasuredCrown, `SB-Veggie trees grown to the measured crown: ${summaryTrees.outcome}`);
                    const degradations = summaryTrees.keptAsScanned.map(k => run.degrade(record('trees', 'not_regrowable', {
                        part: { description: `measured tree, crown ${k.crownId}`, crownId: k.crownId }, intended: 'a tree grown to the measured crown', fellTo: 'that tree kept as scanned',
                        provenanceAfter: PROVENANCE.asScanned, reason: k.reason, transient: false, runId, now: now(), suffix: String(k.crownId)
                    })));
                    return { status: degradations.length ? 'degraded' : 'committed', value: summaryTrees, source: summaryTrees.outcome, layers, degradations, cached: planted.cached };
                },
                degrade: async err => {
                    // the scanned trees go back, as they were downloaded, labelled as scanned (user decision)
                    const reason = errorMessage(err);
                    try {
                        const putKey = stageKey('trees-putback/v1', strip!.cacheKey, sha256File(extraction.texturedGlb).slice(0, 16), isolateMode ? remeshed.cacheKey : 'district');
                        const bounds = isolateMode ? glbBounds(remeshed.clayGlb) : undefined;
                        const entry = await cache.run('trees', putKey, async dir => {
                            const r = putBackScannedTrees({
                                rawGlb: extraction.texturedGlb, devegetatedGlb: strip!.devegetatedGlb, crownsJson: strip!.crownsJson, outGlb: path.join(dir, 'scanned_trees.glb'),
                                ...(bounds ? { keepXZ: { minX: bounds.min[0] - 1, maxX: bounds.max[0] + 1, minZ: bounds.min[2] - 1, maxZ: bounds.max[2] + 1 } } : {}), reason
                            });
                            return { value: { triangles: r.triangles, crowns: r.crowns.length, file: 'scanned_trees.glb' } };
                        }, { publish: () => [{ from: 'scanned_trees.glb', as: `${base}_scanned_trees_${putKey.slice(0, 8)}.glb` }] });
                        putBack = { triangles: entry.value.triangles, crowns: entry.value.crowns, reason };
                        const file = path.join(entry.dir, entry.value.file);
                        const layer: StagedLayer = {
                            objectId: layerObjectId(putKey, 'l5x'), stage: 'trees', layer: 'l5x', order: STAGES.trees.order, url: entry.published[0].url, bytes: entry.published[0].bytes,
                            provenance: {
                                label: PROVENANCE.asScanned, measuredGeometry: true, method: 'the scan triangles strip removed as measured trees, put back as downloaded',
                                sources: [{ kind: 'stage-output', id: `trees-measure:${strip!.cacheKey.slice(0, 8)}` }], note: `put back as scanned because the tree stage failed: ${reason}`
                            },
                            provenanceLabels: [PROVENANCE.asScanned], supersedes: [], revealAfter: [remeshLayer.objectId],
                            reveal: { durationMs: 1200, stagger: 0.3, crossfadeFrom: [] }, cached: entry.cached, builtAtMs: entry.builtAtMs, counts: layerCounts(file)
                        };
                        run.commit(layer, { source: 'Google3DTilesClay', vegetation: true, resolvedAddress: placeValue!.formattedAddress });
                        summaryTrees = { ...summarizeTrees(strip!, undefined, { isolate: isolateMode, stripMs: strip!.ms }), outcome: '' };
                        summaryTrees.outcome = `the tree stage failed (${reason}); the ${summaryTrees.measured.toLocaleString('en-US')} measured trees were put back as scanned`;
                        return {
                            status: 'degraded', value: summaryTrees, source: `the scanned trees put back: ${entry.value.triangles.toLocaleString('en-US')} triangles over ${entry.value.crowns} crowns`,
                            reason: `the tree stage failed (${reason}); the scanned trees were put back, labelled as scanned`, layers: [layer],
                            degradations: [run.degrade(record('trees', 'trees_failed', {
                                part: { description: `the ${entry.value.crowns} measured trees`, objectId: layer.objectId }, intended: 'trees grown to the measured crown', fellTo: 'the scanned trees put back',
                                provenanceAfter: PROVENANCE.asScanned, reason: `the tree stage failed (${reason}); the scanned trees were put back, labelled as scanned`, cause: err,
                                transient: vegetationTransient(err), runId, now: now(), reuses: ['resolve', 'tiles', 'trees-measure', 'remesh']
                            }))]
                        };
                    } catch (putErr) {
                        return {
                            status: 'degraded', source: 'no trees', reason: `the tree stage failed (${reason}) and the scanned trees could not be put back (${errorMessage(putErr)})`,
                            degradations: [run.degrade(record('trees', 'trees_failed', {
                                part: { description: 'the measured trees' }, intended: 'trees grown to the measured crown', fellTo: 'nothing: the ground where they stood stays closed',
                                provenanceAfter: PROVENANCE.remeshed, reason: `the tree stage failed (${reason}) and the scanned trees could not be put back (${errorMessage(putErr)})`, cause: err,
                                transient: vegetationTransient(err), runId, now: now(), reuses: ['resolve', 'tiles', 'trees-measure', 'remesh']
                            }))]
                        };
                    }
                }
            });
            return { trees: summaryTrees, putBack };
        };
        // anything unexpected in the glue around the tree stage degrades it like a failed stage; it never fails the call or runs on after it
        const treesPromise = treesRun().catch((err): { trees?: LocationClayTrees; putBack?: { triangles: number; crowns: number; reason: string } } => {
            if (isAbort(err)) throw err;
            const why = `the tree stage stopped on an unexpected error (${errorMessage(err)})`;
            const rec = run.degrade(record('trees', 'trees_failed', {
                part: { description: 'the measured trees' }, intended: 'trees grown to the measured crown', fellTo: 'nothing: the ground where they stood stays closed',
                provenanceAfter: PROVENANCE.remeshed, reason: why, cause: err, transient: true, runId, now: now(), reuses: ['resolve', 'tiles', 'trees-measure', 'remesh']
            }));
            const st = run.summary('trees').status;
            if (st === 'pending' || st === 'running') run.emit('trees', 'degraded', { source: 'no trees', reason: why, degradations: [rec] }, true);
            return {};
        });
        siblings.push(treesPromise);

        // ---------------- the rebuild (isolated structure) ----------------
        type Rebuild = { figures?: FigureRecord[]; anchored?: AnchorNote[]; located?: DetailPlan; fit?: ScanFitFitResult; refit?: ScanFitFitResult; spec?: OrnamentSpec; rejected?: PrimitiveCorrection[]; detail?: ScanFitOrnamentResult; droppedNotResolvable: number; sourceLimits?: SourceLimits; evidenceCounts?: { tileOrthos: number; streetView: number }; runReadings?: RunReadingReport; registration?: NonNullable<NonNullable<StagedLocationResult['ornament']>['registration']>; slotsOffered?: { offered: number; total: number; hidden: number; unseen: number; exposureJudged: boolean }; passThroughHidden?: PassThroughSplit };
        let rebuildOut: Rebuild = { droppedNotResolvable: 0 };
        // the texture pass's Street View phase waits until the rebuild has decided its close-ups (or that none will come)
        const rebuildRun = async (): Promise<Rebuild> => { try { return await rebuildChain(); } finally { fitDecided.resolve(); evidenceDecided.resolve(); } };
        const rebuildChain = async (): Promise<Rebuild> => {
            const remeshed = remeshedNow;
            const out = rebuildOut;
            const skipRest = (reason: string, from: StageId[] = ['fit', 'evidence', 'project', 'vision', 'correct', 'detail', 'figures']) => {
                // the Street View fetch may still be running: it is ended as not needed, saying why
                if (from.includes('evidence')) evidenceStop.abort(reason);
                for (const id of from) runner.skip(id, reason);
            };
            if (!request.isolate) { skipRest('not an isolated structure'); return out; }
            if (eState) {
                const j = request.procedural === true;
                const why = j ? 'pipeline J places a generated model of the structure, fitted to the scan' : 'pipeline E built the structure from the vector massing (SCRATCHBOX_STAGED_PIPELINE=e)';
                const tex = j ? 'pipeline J\'s model carries its own textures' : 'pipeline E textures its faces from orthographic renders of the tile photo';
                skipRest(why);
                runner.skip('survey', why);
                runner.skip('textures', tex);
                runner.skip('textures-late', tex);
                return out;
            }
            if (!isolateMode) { skipRest('the structure could not be isolated, so it is shown without a rebuild'); return out; }
            if (!remeshed) { skipRest('the remesh failed, so there is no isolated scan to fit'); return out; }
            if (!isolateOk) { skipRest('tile_refine isolated a different structure than the one picked'); return out; }
            out.sourceLimits = measureSourceLimits(t.scan ?? loadScanMesh(extraction.texturedGlb), extraction.leafGeometricErrorM, structure!.cells);
            if (kIsolate) {
                skipRest(PIPELINE_K_KEEPS_SCAN, PIPELINE_K_FIT_SKIPPED);
                // the remeshed scan is textured as when no fit is accepted
                startEvidence(undefined);
                return out;
            }
            if (!deps.scanFit) {
                const reason = deps.scanFitUnavailable ?? 'the scan fitter (scan_fit) is not in this build';
                const rec = run.degrade(record('fit', 'scan_fit_unavailable', {
                    part: { description: 'the structure' }, intended: 'a scan-fitted rebuild with photo-inferred detail', fellTo: 'the remeshed scan',
                    provenanceAfter: PROVENANCE.remeshed, reason: `${reason}, so the remeshed scan stands as the structure`, transient: false, runId, now: now()
                }));
                runner.skip('fit', reason, [rec]);
                skipRest('there is no fitted structure to place detail on', ['project', 'vision', 'correct', 'detail', 'figures']);
                // the remeshed scan is still textured, with Street View aimed at the structure's facades (the no-fit rung)
                startEvidence(undefined);
                return out;
            }
            // fit: with the building's plan from Google vector data, and its neighbours', when the pick used it
            const vf = structure!.vectorFootprint;
            // Google's footprint, when the pick accepted it as this structure's (one it rejected belongs to something else)
            const fitPrior = vf?.used && t.vector ? footprintPriorFor(t.vector.raster.buildings, vf.featureIds) : undefined;
            const fitKey = stageKey('scan_fit/fit/v3', remeshed.cacheKey, sha256File(remeshed.rawClayGlb!), structure!.seed, fitPrior ? sha256Bytes(Buffer.from(JSON.stringify(fitPrior))) : 'no-prior');
            run.keys.fit = fitKey;
            const negative = !bypass('fit') ? cache.negative('fit', fitKey) : undefined;
            const fitted = await runner.stage<ScanFitFitResult>({
                id: 'fit',
                run: async io => {
                    if (negative) throw Object.assign(new Error(negative.message), { code: negative.code, cachedNegative: true });
                    const r = await deps.scanFit!.fit({
                        scanGlb: remeshed.rawClayGlb!, texturedGlb: extraction.texturedGlb, remeshGlb: remeshed.clayGlb, anchor: structure!.seed,
                        ...(remeshed.ownershipVotes ? { ownershipVotes: remeshed.ownershipVotes } : {}),
                        ...(fitPrior ? { prior: fitPrior } : {}),
                        sourceLimits: out.sourceLimits!, signal: io.signal, onProgress: (f, m) => io.progress(`scan_fit: ${m}`, f), timeoutMs: STAGES.fit.budgetMs
                    });
                    run.cacheStatus.fit = r.cached ? 'hit' : 'miss';
                    const fit = r.value;
                    const fp = fit.input.footprintPrior;
                    if (fp) {
                        io.progress(fp.used
                            ? `scan_fit: plan from ${fp.source} (${Math.round(fp.areaM2)} m², fitted footprint IoU ${fp.fittedIoU.toFixed(2)}), roof levels ${fp.roofLevelsM.map(l => `${l.toFixed(1)} m`).join(', ')} measured in the scan`
                            : `scan_fit: ${fp.source} was given, but the scan measured no roof level inside it; the plan was traced from the scan's walls`);
                        if (fit.accepted && (fit.metrics.partyWallAreaM2 ?? 0) > 0) run.note(PROVENANCE.fittedUnobserved, `${(fit.metrics.partyWallAreaM2 ?? 0).toFixed(1)} m² of the rebuild stands against neighbouring buildings (${fp.source}): party walls, labelled, not counted as unobserved`);
                    }
                    if (!fit.accepted) {
                        const failed = fit.gates.filter(g => !g.passed).map(g => `${g.gate} ${g.unit === 'm' ? `${(g.value * 100).toFixed(1)} cm` : g.value} ${g.comparison === '<=' ? '>' : '<'} ${g.unit === 'm' ? `${(g.threshold * 100).toFixed(1)} cm` : g.threshold}`).join('; ');
                        return {
                            status: 'degraded', value: r, source: `scan_fit: rejected (${failed})`, reason: `the fit did not pass its gates (${failed}); the remeshed scan stands as the structure`,
                            degradations: [run.degrade(record('fit', 'fit_rejected', {
                                part: { description: 'the structure', buildingId: fit.buildingId }, intended: 'a scan-fitted rebuild', fellTo: 'the remeshed scan', provenanceAfter: PROVENANCE.remeshed,
                                reason: `the fit did not pass its gates (${failed}); the remeshed scan stands as the structure`, transient: false, runId, now: now()
                            }))]
                        };
                    }
                    run.state.structure = { ...run.state.structure!, buildingId: fit.buildingId };
                    // the pass-through scan lying on a fitted face, within the tolerance of it, is hidden (redundant-scan.ts): the fitted
                    // face shows there; what stands proud of it, or has no fitted face behind it, stays drawn
                    // SCRATCHBOX_STAGED_HIDE_REDUNDANT=0 draws all of it (the behaviour before; for comparisons on replayed evidence)
                    let split: PassThroughSplit | undefined;
                    if (process.env.SCRATCHBOX_STAGED_HIDE_REDUNDANT !== '0') try {
                        split = splitPassThroughFile(fit, path.join(cache.dir, 'passthrough-hide', fitKey.slice(0, 8)));
                    } catch (err) {
                        io.progress(`the pass-through scan was not checked against the fitted faces (${errorMessage(err)}); all of it stays drawn`);
                    }
                    if (split) out.passThroughHidden = split;
                    const layers = commitFitLayers(run, r, fitKey, base, cache, placeValue!.formattedAddress, undefined, split);
                    const hiddenLayerId = layers.find(l => l.layer === 'l3ch')?.objectId;
                    const hiddenBy = new Map((split?.report.regions ?? []).filter(x => x.areaHiddenM2 > 0).map(x => [x.name, x]));
                    const wholly = (id: string) => { const h = hiddenBy.get(id); return !!h && h.trianglesHidden === h.trianglesIn; };
                    const hiddenDegradations = [...hiddenBy.values()].map(h => run.degrade(record('fit', 'pass_through_hidden', {
                        part: { description: `region ${h.name}: ${h.areaHiddenM2.toFixed(1)} of ${h.areaInM2.toFixed(1)} m² lie on a fitted face`, buildingId: fit.buildingId, ...(hiddenLayerId ? { objectId: hiddenLayerId } : {}), ...(h.surfaceIds[0] ? { surfaceId: h.surfaceIds[0] } : {}) },
                        intended: 'that region as scanned (pass-through)', fellTo: 'the fitted surface behind it', provenanceAfter: PROVENANCE.fitted,
                        reason: `pass-through hidden: redundant with fitted surface, offset ${(h.offsetMedianM ?? 0).toFixed(3)} m (largest ${(h.offsetMaxM ?? 0).toFixed(3)} m, tolerance ${split!.report.toleranceM.min === split!.report.toleranceM.max ? split!.report.toleranceM.max.toFixed(2) : `${split!.report.toleranceM.min.toFixed(2)}-${split!.report.toleranceM.max.toFixed(2)}`} m); shown under replaced layers`,
                        transient: false, runId, now: now(), suffix: h.name
                    })));
                    const degradations = fit.passThrough.regions.filter(region => !wholly(region.id)).map(region => run.degrade(record('fit', 'pass_through', {
                        part: { description: `region ${region.id} (${region.areaM2.toFixed(1)} m²)`, buildingId: fit.buildingId }, intended: 'a fitted shape', fellTo: 'that region as scanned (pass-through)',
                        provenanceAfter: PROVENANCE.asScanned, reason: `no fitted shape explains it (${region.reason})`, transient: false, runId, now: now(), suffix: region.id
                    }))).concat(hiddenDegradations);
                    const unobserved = fit.surfaces.filter(x => x.supportFraction < 0.5).reduce((sum, x) => sum + x.areaM2, 0);
                    run.note(PROVENANCE.fitted, `fitted to the scan: ${(fit.metrics.scanToFit.rmsM * 100).toFixed(1)} cm rms over ${Math.round(fit.metrics.coverage * 100)}% of the visible surface`);
                    if (unobserved > 0) run.note(PROVENANCE.fittedUnobserved, `${unobserved.toFixed(1)} m² of faces the fit placed where the scan has no samples`);
                    return {
                        status: 'committed', value: r, layers, degradations,
                        source: `scan_fit: ${fit.primitives.length} primitives fitted to ${fit.input.scanTriangles.toLocaleString('en-US')} scan triangles, ${(fit.metrics.scanToFit.rmsM * 100).toFixed(1)} cm rms`,
                        cached: r.cached, builtAtMs: r.builtAtMs
                    };
                },
                degrade: async err => {
                    const code = scanFitCode(err);
                    const transient = scanFitTransient(err);
                    if (!transient && !(err as any)?.cachedNegative) cache.putNegative('fit', fitKey, { code: code ?? 'failed', message: errorMessage(err) });
                    return {
                        status: 'degraded', source: 'scan_fit failed', reason: `the fit failed (${errorMessage(err)}); the remeshed scan stands as the structure`,
                        degradations: [run.degrade(record('fit', 'fit_rejected', {
                            part: { description: 'the structure' }, intended: 'a scan-fitted rebuild', fellTo: 'the remeshed scan', provenanceAfter: PROVENANCE.remeshed,
                            reason: `scan_fit failed (${code ?? 'error'}: ${errorMessage(err)}); the remeshed scan stands as the structure`, cause: err, transient, runId, now: now(), reuses: ['resolve', 'tiles', 'trees-measure', 'remesh']
                        }))]
                    };
                }
            });
            if (fitted.status !== 'committed' || !fitted.value) {
                skipRest('there is no accepted fit to place detail on', ['project', 'vision', 'correct', 'detail', 'figures']);
                // the remeshed scan still gets its textures: Street View aimed at the structure's facades (the no-fit rung: nothing is
                // read from the images, they are projected onto the remeshed scan), then the tile photo where they do not reach
                startEvidence(undefined);
                return out;
            }
            out.fit = fitted.value;
            fitDecided.resolve();
            const fit = fitted.value.value;
            persist();
            if (rebuildPossible && visionAvailable) startEvidence(fit);
            if (rebuildPossible) startFigures(fit, out);

            // evidence, projection, vision
            if (!visionAvailable) {
                const reason = deps.vision && 'unavailable' in deps.vision ? deps.vision.unavailable : 'no vision model is configured';
                const model: VisionModelUse = {
                    requested: STAGED_VISION_MODEL_DEFAULT.model, used: STAGED_VISION_MODEL_DEFAULT.model, answered: '', thinking: plannedThinking(STAGED_VISION_MODEL_DEFAULT.model),
                    skipped: [], backend: 'injected', ms: 0, outcome: 'failed', error: reason, selection: STAGED_VISION_MODEL_DEFAULT.selection
                };
                run.state.visionModel = model;
                const rec = run.degrade(record('vision', 'vision_unavailable', {
                    part: { description: 'facade detail of the structure', buildingId: fit.buildingId }, intended: 'photo-inferred detail', fellTo: 'the flat fitted face',
                    provenanceAfter: PROVENANCE.fitted, reason: `${reason}; the fitted faces stay flat`, model, transient: true, runId, now: now(), reuses: ['resolve', 'tiles', 'remesh', 'fit']
                }));
                runner.skip('evidence', reason);
                runner.skip('project', reason);
                runner.skip('vision', reason, [rec]);
                runner.skip('correct', 'no detail was read');
                runner.skip('detail', 'no detail was read');
                return out;
            }
            const evidence: { images: EvidenceImage[]; panos: PanoCandidate[]; cost: EvidenceCost; plan?: DetailPlan; registration?: Registration; match?: MatchResult; runCrops?: RunCrops; status: string } = evidencePromise ? await evidencePromise : { images: [], panos: [], cost: NO_EVIDENCE_COST, status: 'skipped' };
            const located = evidence.plan?.located ?? [];
            // the evidence the reading gets: the fit's facade orthos of the tile photos, then the Street View close-ups with the slots projected into them
            type Projected = { inputs: EvidenceInput[]; refs: EvidenceImageRef[] };
            const readOrthos = (): EvidenceInput[] => {
                const found: EvidenceInput[] = [];
                // design §5.1: one per fitted surface at least 30% visible and 4 m² large, the 6 largest, largest first (the fitter
                // renders every visible face; the reading has 16 image slots and its attention is for the faces that carry detail)
                const surfaceOf = new Map(fit.surfaces.map(s => [s.id, s]));
                const chosen = fit.outputs.orthos
                    .map(o => ({ o, s: surfaceOf.get(o.surfaceId) }))
                    .filter((x): x is { o: typeof x.o; s: NonNullable<typeof x.s> } => !!x.s && x.s.visibleFraction >= 0.3 && x.s.areaM2 >= 4)
                    .sort((a, b) => b.s.areaM2 - a.s.areaM2)
                    .slice(0, 6);
                for (const { o } of chosen) {
                    if (!fs.existsSync(o.path)) continue;
                    const bytes = fs.readFileSync(o.path);
                    const ref = orthoRef(o, found.length, fit, bytes);
                    found.push({ ref, bytes, mimeType: 'image/png', caption: orthoCaption(ref, fit) });
                }
                return found;
            };
            const projected = await runner.stage<Projected>({
                id: 'project',
                run: async () => {
                    const orthos = readOrthos();
                    if (!evidence.images.length) return { status: 'skipped', value: { inputs: orthos, refs: [] }, source: '', reason: 'no Street View image to project the slots into' };
                    const occluder = loadMesh([fit.outputs.fittedGlb, fit.outputs.passThroughGlb]);
                    const refs = evidence.images.map((img, k) => {
                        const correction = evidence.registration?.corrections.get(img.view.panoId);
                        const slotsShown = projectSlots(fit, { eye: img.view.eye, headingDeg: img.view.headingDeg, pitchDeg: img.view.pitchDeg, fovDeg: img.view.fovDeg, widthPx: img.widthPx, heightPx: img.heightPx, ...(correction ? { correction } : {}) }, occluder);
                        const ref: EvidenceImageRef = {
                            id: img.id, index: orthos.length + k, kind: 'streetview-grounding', widthPx: img.widthPx, heightPx: img.heightPx, sha256: img.sha256, nativeSampleM: img.nativeSampleM,
                            panoId: img.view.panoId, ...(img.view.date ? { captureDate: img.view.date } : {}), copyright: img.view.copyright ?? '© Google',
                            headingDeg: img.view.headingDeg, pitchDeg: img.view.pitchDeg, fovDeg: img.view.fovDeg, distanceM: img.view.distanceM,
                            pose: correction ? registeredPose(img.view.eye, correction, registeredUncertaintyAt(img.view.distanceM, evidence.registration!.afterRmsM, 0)) : nominalPose(img.view.eye), slotsShown
                        };
                        return ref;
                    });
                    return {
                        status: 'committed', value: { inputs: orthos, refs }, source: `${refs.reduce((n, r) => n + r.slotsShown.length, 0)} slot outlines in ${refs.length} Street View images (${refs.filter(r => r.pose?.registered).length} with registered poses, ${refs.filter(r => !r.pose?.registered).length} nominal, ±2 m)`
                    };
                },
                // the images could not be prepared: the model gets whichever tile photos can still be read, and no Street View close-up
                degrade: async err => {
                    let inputs: EvidenceInput[] = [];
                    try { inputs = readOrthos(); } catch { /* no tile photo either: nothing is read */ }
                    const rest = inputs.length ? 'the tile photos that could be read' : 'no image';
                    return {
                        status: 'degraded', value: { inputs, refs: [] }, source: 'no Street View close-ups used', reason: `the images could not be prepared (${errorMessage(err)})`,
                        degradations: [run.degrade(record('project', 'evidence_not_prepared', {
                            part: { description: 'the images shown to the vision model' }, intended: 'the facade views of the tile photos and the Street View close-ups, with the fitted slots outlined',
                            fellTo: rest, provenanceAfter: PROVENANCE.photoInferred, reason: `the images could not be prepared (${errorMessage(err)}); ${inputs.length ? 'only the tile photos are read' : 'nothing is read'}`,
                            cause: err, transient: false, runId, now: now()
                        }))]
                    };
                }
            });
            if (projected.status === 'skipped') run.summary('project').reason = projected.reason;
            const inputs: EvidenceInput[] = [...(projected.value?.inputs ?? [])];
            evidence.images.forEach((img, k) => {
                const ref = projected.value?.refs[k];
                if (ref) inputs.push({ ref, bytes: img.bytes, mimeType: img.mimeType, caption: streetViewCaption(ref) });
            });
            if (evidence.plan) out.located = evidence.plan;
            out.evidenceCounts = { tileOrthos: inputs.filter(i => i.ref.kind === 'tile-ortho').length, streetView: inputs.filter(i => i.ref.kind === 'streetview-grounding').length };
            const chain = new VisionModelChain<string>({ client: visionAvailable.client, candidates: visionAvailable.candidates, signal: ctx.signal, ...chainExtras('vision'), ...(deps.sleep ? { sleep: deps.sleep } : {}) });
            let fitSha = '';
            let visionKey = '';
            let offer: Awaited<ReturnType<typeof computeSlotOfferAsync>> | undefined;
            const read = await runner.stage<OrnamentSpec>({
                id: 'vision',
                run: async io => {
                    const stageStarted = Date.now();
                    if (!inputs.length) return { status: 'skipped', source: '', reason: 'no image shows the structure' };
                    fitSha = sha256File(fit.outputs.reportJson);
                    offer = await computeSlotOfferAsync(fit, inputs.map(i => i.ref));
                    if (evidence.registration) out.registration = { pairs: evidence.match?.correspondences.length ?? evidence.registration.pairs.length, used: evidence.registration.used, beforeRmsM: evidence.registration.beforeRmsM, afterRmsM: evidence.registration.afterRmsM, perPano: evidence.registration.perPano, setAside: evidence.registration.setAside.map(a => ({ panoId: a.panoId, reason: a.reason })) };
                    out.slotsOffered = { offered: offer.offeredIds.size, total: fit.slots.length, hidden: offer.hidden, unseen: offer.unseen, exposureJudged: offer.exposureJudged };
                    io.progress(describeOffer(offer, fit.slots.length));
                    visionKey = stageKey('ornament-vision/v4', ORNAMENT_PROMPT_VERSION, visionAvailable.candidates, ORNAMENT_THINKING_BUDGET, fitSha, inputs.map(i => i.ref.id), inputs.map(i => i.ref.sha256), [...offer.offeredIds].sort(), located.map(l => [l.id, l.slotId, l.repeat?.count, l.runAlongM, l.regionUv]));
                    run.keys.vision = visionKey;
                    const hit = !bypass('vision') ? cache.get<{ spec: OrnamentSpec; supportTestRequired: string[]; anchored?: AnchorNote[]; runReadings?: RunReadingReport }>('vision', visionKey) : undefined;
                    if (hit) {
                        run.cacheStatus.vision = 'hit';
                        run.state.visionModel = hit.value.spec.model;
                        out.anchored = hit.value.anchored ?? [];
                        if (hit.value.runReadings) out.runReadings = hit.value.runReadings;
                        return { status: 'committed', value: hit.value.spec, source: `${hit.value.spec.elements.length} photo-inferred elements (cached reading by ${hit.value.spec.model.used})`, model: hit.value.spec.model, cached: true, builtAtMs: hit.builtAtMs };
                    }
                    run.cacheStatus.vision = bypass('vision') ? 'bypassed' : 'miss';
                    // the targeted second pass: every repeating run or band the survey found, read again alone from narrow crops
                    // (run-reading.ts). It needs no wide reading, so it runs beside it and is merged into it after; it is cut at
                    // its own window, and the wide reading is never lost to it
                    const svDeps = streetView ?? {};
                    const runsWindowMs = Math.min(RUN_PASS_BUDGET_MS, STAGES.vision.budgetMs - VISION_STAGE_MARGIN_MS - (Date.now() - stageStarted));
                    if (evidence.plan?.located.length && runsWindowMs < MIN_RUNS_WINDOW_MS) io.progress(`the focused run readings were not started: ${Math.max(0, Math.round(runsWindowMs / 1000))} s of the stage were left; the wide reading stands`);
                    const runsCut = new AbortController();
                    let runsTimer: ReturnType<typeof setTimeout> | undefined;
                    let runsPromise: Promise<RunTargetReadings> | undefined;
                    if (evidence.plan?.located.length && runsWindowMs >= MIN_RUNS_WINDOW_MS && !missingCredentials(svDeps) && t.ground) {
                        runsTimer = setTimeout(() => runsCut.abort(Object.assign(new Error(`the focused run readings ran past their ${Math.round(runsWindowMs / 1000)} s`), { name: 'TimeoutError' })), runsWindowMs + 5_000);
                        // started as a promise so that a failure to set it up (the fitted body cannot be read) is the runs' failure, not the reading's
                        runsPromise = Promise.resolve().then(() => readRunTargets({
                            fit, fitSha256: fitSha, located: evidence.plan!.located, panos: evidence.panos, groundAt: (x, z) => t.ground!.groundAt(x, z), fallbackGroundY: structure!.groundY,
                            ...(evidence.registration ? { registration: evidence.registration } : {}), occluder: loadMesh([fit.outputs.fittedGlb, fit.outputs.passThroughGlb]), streetView: svDeps, chain,
                            signal: AbortSignal.any([io.signal, runsCut.signal]), budgetMs: runsWindowMs, onProgress: m => io.progress(m)
                        }, evidence.runCrops));
                        runsPromise.catch(() => undefined);
                    }
                    let reading: Awaited<ReturnType<typeof readOrnamentBatched>>;
                    try {
                        reading = await readOrnamentBatched({ fit, fitSha256: fitSha, evidence: inputs, chain, signal: io.signal, onProgress: m => io.progress(m), located, offer, budgetMs: ORNAMENT_PASS_BUDGET_MS });
                    } catch (err) {
                        runsCut.abort(err);
                        clearTimeout(runsTimer);
                        throw err;
                    }
                    const batchFailures = reading.batches.filter(b => b.status === 'failed');
                    io.progress(`${reading.batches.length - batchFailures.length} of ${reading.batches.length} batches read in ${(reading.spec.model.ms / 1000).toFixed(1)} s (${reading.calls} calls${reading.retries ? `, ${reading.retries} asked again after a stall` : ''})${batchFailures.length ? `; ${batchFailures.map(b => `${b.id} failed: ${b.reason}`).join('; ')}` : ''}`);
                    let spec = reading.spec;
                    let anchored = reading.anchored;
                    let runReport: RunReadingReport | undefined;
                    const runDropped: Array<{ elementId: string; slotId: string; reasonCode: string; problems: string[] }> = [];
                    if (runsPromise) {
                        try {
                            const rr = mergeRunReadings({ fit, base: reading.spec }, await runsPromise);
                            spec = rr.spec; anchored = [...reading.anchored, ...rr.anchored]; runReport = rr.report; runDropped.push(...rr.dropped);
                            io.progress(`${rr.report.read} of ${rr.report.targets} runs and bands read from narrow crops: ${rr.report.elements} elements${rr.report.replaced ? `, replacing ${rr.report.replaced} from the wide reading` : ''}${rr.report.skipped.length ? `; ${rr.report.skipped.length} left as they were (${rr.report.skipped[0].reason})` : ''}`);
                        } catch (err) {
                            // a stop or the stage's own limit ends the stage; the runs' own cut does not
                            if (io.signal.aborted || (isAbort(err) && !runsCut.signal.aborted)) throw err;
                            io.progress(`the focused run readings failed (${runsCut.signal.aborted ? (runsCut.signal.reason as Error).message : errorMessage(err)}); the wide reading stands`);
                        } finally {
                            clearTimeout(runsTimer);
                        }
                    }
                    // a reading with a failed batch is not cached: a retry reads every batch again
                    if (!batchFailures.length) await cache.run('vision', visionKey, async dir => {
                        fs.writeFileSync(path.join(dir, 'replies.json'), JSON.stringify(reading.replies));
                        return { value: { spec, supportTestRequired: reading.supportTestRequired, anchored, ...(runReport ? { runReadings: runReport } : {}) } };
                    }, { bypass: true });
                    run.state.visionModel = spec.model;
                    run.summary('vision').cost = { images: runReport ? runReport.perTarget.reduce((n, p) => n + p.views, 0) : 0, imagesSent: inputs.length, visionCalls: reading.calls + (runReport?.read ?? 0), seconds: round(reading.spec.model.ms / 1000, 1) };
                    const degradations = [
                        // a batch that gave no usable reply: its slots stay flat, with why; the other batches stand
                        ...batchFailures.map(b => run.degrade(record('vision', 'vision_batch_failed', {
                            part: { description: `facade detail of slots ${b.slotIds.join(', ')} (reading batch ${b.id}, ${b.imageIds.length} images)`, buildingId: fit.buildingId },
                            intended: 'photo-inferred detail', fellTo: 'the flat fitted face', provenanceAfter: PROVENANCE.fitted,
                            reason: `batch ${b.id} of the reading gave no usable reply (${b.reasonCode ?? 'vision_unavailable'}: ${b.reason}); its ${b.slotIds.length} slots stay flat, the other batches stand`,
                            ...(b.model ? { model: b.model } : {}), transient: b.transient ?? true, runId, now: now(), suffix: b.id, reuses: ['resolve', 'tiles', 'remesh', 'fit', 'evidence']
                        }))),
                        ...[...reading.dropped, ...runDropped].map(d => run.degrade(record('vision', d.reasonCode, {
                            part: { description: `photo-read element ${d.elementId} in slot ${d.slotId}`, slotId: d.slotId, elementId: d.elementId, buildingId: fit.buildingId },
                            intended: 'photo-inferred detail', fellTo: 'the flat fitted face', provenanceAfter: PROVENANCE.fitted, reason: d.problems.join('; '), transient: false, runId, now: now(), suffix: d.elementId
                        })))
                    ];
                    out.droppedNotResolvable = [...reading.dropped, ...runDropped].filter(d => d.reasonCode === 'not_resolvable_in_evidence').length;
                    out.rejected = reading.rejectedCorrections;
                    out.anchored = anchored;
                    if (runReport) out.runReadings = runReport;
                    return {
                        status: degradations.length ? 'degraded' : 'committed', value: spec,
                        source: `${spec.elements.length} photo-inferred elements read by ${spec.model.used} (${'level' in spec.model.thinking ? `thinking ${spec.model.thinking.level.toLowerCase()}` : `budget ${spec.model.thinking.budget}`}, ${(spec.model.ms / 1000).toFixed(1)} s)${runReport ? `; ${runReport.elements} of them from ${runReport.read} focused run readings` : ''}`,
                        degradations, model: spec.model
                    };
                },
                degrade: async err => {
                    const model = err instanceof VisionStageError ? err.model : visionUse(chain, 'failed', { error: errorMessage(err) });
                    run.state.visionModel = model;
                    const transient = err instanceof VisionStageError ? err.transient : true;
                    return {
                        status: 'degraded', source: `no detail: ${model.used || model.requested} (${'level' in model.thinking ? `thinking ${model.thinking.level.toLowerCase()}` : `budget ${model.thinking.budget}`})`,
                        reason: `the vision model gave no usable reading (${errorMessage(err)}); the fitted faces stay flat`, model,
                        degradations: [run.degrade(record('vision', err instanceof VisionStageError ? err.reasonCode : 'vision_unavailable', {
                            part: { description: 'facade detail of the structure', buildingId: fit.buildingId }, intended: 'photo-inferred detail', fellTo: 'the flat fitted face', provenanceAfter: PROVENANCE.fitted,
                            reason: `${model.used || model.requested} (${'level' in model.thinking ? `thinking ${model.thinking.level}` : `thinking budget ${model.thinking.budget}`}) gave no usable reading: ${errorMessage(err)}; the fitted faces stay flat`,
                            cause: err, model, transient, runId, now: now(), reuses: ['resolve', 'tiles', 'remesh', 'fit', 'evidence']
                        }))]
                    };
                }
            });
            if (read.status === 'skipped') { runner.skip('correct', 'no detail was read'); runner.skip('detail', 'no image shows the structure'); return out; }
            if (!read.value) { runner.skip('correct', 'no detail was read'); runner.skip('detail', 'no detail was read'); return out; }
            out.spec = read.value;

            // corrections
            let currentFit = fitted.value;
            if (out.spec.corrections.length) {
                const proposed = out.spec.corrections;
                // a correction is applied only when the refit keeps the scan residual inside the tolerance; the others are
                // recorded as rejected (not a degradation: the fitted value stays)
                const settle = (fromRefit: Map<string, PrimitiveCorrection>, why: string) => {
                    const accepted: PrimitiveCorrection[] = [];
                    for (const c of proposed) {
                        // the refit's residual check, with the photo evidence and reasoning the correction came with
                        const checked = fromRefit.get(`${c.primitiveId}:${c.param}`);
                        const merged: PrimitiveCorrection = checked ? { ...c, from: checked.from, to: checked.to, check: checked.check } : { ...c, check: { ...c.check, accepted: false, why } };
                        if (merged.check.accepted) accepted.push(merged);
                        else (out.rejected ??= []).push(merged);
                    }
                    out.spec = { ...out.spec!, corrections: accepted };
                };
                const corrected = await runner.stage<ScanFitFitResult>({
                    id: 'correct',
                    run: async io => {
                        const r = await deps.scanFit!.refit({ fitPath: fitted.value!.path, scanGlb: remeshed.rawClayGlb!, set: proposed.map(c => ({ primitiveId: c.primitiveId, param: c.param, value: c.to })), signal: io.signal });
                        const byKey = new Map(r.value.primitives.filter(p => p.correction).map(p => [`${p.id}:${p.correction!.param}`, p.correction!]));
                        settle(byKey, 'the refit did not apply it');
                        // the refit is given values only (ScanFitRefitRequest.set): each correction it applied gets back the
                        // photo evidence, confidence and reason it came with
                        for (const p of r.value.primitives) {
                            const c = out.spec!.corrections.find(x => x.primitiveId === p.id && x.param === p.correction?.param);
                            if (p.correction && c) p.correction = c;
                        }
                        const ids = [...new Set(out.spec!.corrections.map(c => c.primitiveId))];
                        if (!ids.length) return { status: 'committed', source: 'no correction stayed within the scan tolerance; the fitted values are kept' };
                        const confidence = Math.min(...out.spec!.corrections.map(c => c.confidence));
                        const layers = commitFitLayers(run, r, stageKey('scan_fit/refit/v1', r.key), base, cache, placeValue!.formattedAddress, { ids, confidence });
                        currentFit = r;
                        return { status: 'committed', value: r, source: `${ids.length} primitive${ids.length === 1 ? '' : 's'} photo-corrected inside the scan tolerance`, layers };
                    },
                    degrade: async err => {
                        settle(new Map(), `the refit failed (${errorMessage(err)})`);
                        return { status: 'committed', source: `the refit failed (${errorMessage(err)}); the fitted values are kept` };
                    }
                });
                if (corrected.value) out.refit = corrected.value;
            } else {
                runner.skip('correct', 'no photo correction was proposed');
            }

            // detail
            if (!out.spec.elements.length) { runner.skip('detail', 'no element passed the evidence checks'); return out; }
            const detailed = await runner.stage<ScanFitOrnamentResult>({
                id: 'detail',
                run: async io => {
                    let spec: OrnamentSpec = { ...out.spec!, structureFitSha256: sha256File(currentFit.value.outputs.reportJson) };
                    let r = await deps.scanFit!.ornament({ fitPath: currentFit.path, spec, texturedGlb: extraction.texturedGlb, signal: io.signal });
                    // reprojection gate: each built element rendered through the registered cameras of the images it was read from
                    // must land on the box the model cited there; one that lands elsewhere was not where it was read (detail-reprojection.ts)
                    const cams = new Map(evidence.images.map(img => [img.id, castCamera({
                        eye: img.view.eye, headingDeg: img.view.headingDeg, pitchDeg: img.view.pitchDeg, fovDeg: img.view.fovDeg, widthPx: img.widthPx, heightPx: img.heightPx,
                        ...(evidence.registration?.corrections.get(img.view.panoId) ? { correction: evidence.registration.corrections.get(img.view.panoId)! } : {})
                    })]));
                    const gated = spec.elements.some(e => e.evidence.some(v => cams.has(v.imageId)));
                    let gateOccluder: ReturnType<typeof loadMesh> | undefined;
                    if (gated) {
                        // the fitted structure hides what stands behind it; without it (a body that cannot be read) the elements are rendered alone
                        try { gateOccluder = loadMesh([currentFit.value.outputs.fittedGlb, currentFit.value.outputs.passThroughGlb]); } catch { gateOccluder = undefined; }
                    }
                    const gate = gated ? await reprojectDetailAsync(readGlbNodes(r.detailGlb), spec.elements, id => cams.get(id), gateOccluder ? { occluder: gateOccluder } : {}) : [];
                    const rejectedByGate = gate.filter(g => !g.accepted);
                    if (gated) cache.writeRunNote(runId, 'detail_reprojection', { minIoU: DETAIL_REPROJECTION_MIN_IOU, elements: gate });
                    if (gated) io.progress(`reprojection gate: ${gate.length - rejectedByGate.length} of ${gate.length} elements land where they were read (IoU >= ${DETAIL_REPROJECTION_MIN_IOU})${rejectedByGate.length ? `; rejected ${rejectedByGate.map(g => `${g.elementId}${g.label ? ` (${g.label})` : ''} IoU ${g.iou?.toFixed(2) ?? 'n/a'}`).join(', ')}` : ''}`);
                    if (rejectedByGate.length) {
                        const ids = new Set(rejectedByGate.map(g => g.elementId));
                        spec = { ...spec, elements: spec.elements.filter(e => !ids.has(e.id)), dropped: [...spec.dropped, ...rejectedByGate.map(g => ({ elementId: g.elementId, slotId: g.slotId, by: 'reprojection', problems: [g.reason] }))] };
                        out.spec = spec;
                        if (spec.elements.length) r = await deps.scanFit!.ornament({ fitPath: currentFit.path, spec, texturedGlb: extraction.texturedGlb, signal: io.signal });
                    }
                    const gateDegradations = rejectedByGate.map(g => run.degrade(record('detail', 'detail_rejected', {
                        part: { description: `photo-read element ${g.elementId}${g.label ? ` (${g.label})` : ''} in slot ${g.slotId}`, slotId: g.slotId, elementId: g.elementId }, intended: 'photo-inferred detail', fellTo: 'the flat fitted face',
                        provenanceAfter: PROVENANCE.fitted, reason: g.reason, transient: false, runId, now: now(), suffix: g.elementId
                    })));
                    if (!spec.elements.length) {
                        return { status: 'degraded', source: 'no detail', reason: 'every photo-read element was rejected by the reprojection gate', degradations: gateDegradations };
                    }
                    const pub = cache.publishFile(r.detailGlb, `${base}_detail_${r.key.slice(0, 8)}.glb`);
                    const bodyId = run.state.layers.filter(l => l.layer === 'l3br' || l.layer === 'l3b').pop()?.objectId;
                    const layer: StagedLayer = {
                        objectId: layerObjectId(r.key, 'l4'), stage: 'detail', layer: 'l4', order: STAGES.detail.order, url: pub.url, bytes: pub.bytes,
                        provenance: { label: PROVENANCE.photoInferred, measuredGeometry: false, confidence: Math.min(...spec.elements.map(e => e.confidence)), method: 'scan_fit ornament: the photo-read elements built with the four operators in their host charts', sources: spec.evidence.map(e => ({ kind: e.kind, id: e.id })) },
                        provenanceLabels: [PROVENANCE.photoInferred, ...(spec.elements.some(e => e.provenance.label === PROVENANCE.photoCorrected) ? [PROVENANCE.photoCorrected] : [])], supersedes: [], revealAfter: bodyId ? [bodyId] : [],
                        reveal: { durationMs: 1200, stagger: 0.5, crossfadeFrom: [] }, cached: r.cached, builtAtMs: r.builtAtMs, counts: r.value.counts
                    };
                    // every element dropped by the evidence checks: nothing was built, so there is no photo-inferred layer to show (an empty
                    // layer labelled photo-inferred would claim detail that is not there)
                    const built = r.value.built.length > 0;
                    if (built) run.commit(layer, { source: 'scan_fit', resolvedAddress: placeValue!.formattedAddress });
                    const degradations = r.value.dropped.map(d => run.degrade(record('detail', 'detail_failed', {
                        part: { description: `photo-read element ${d.elementId} in slot ${d.slotId}`, slotId: d.slotId, elementId: d.elementId }, intended: 'photo-inferred detail', fellTo: 'the flat fitted face',
                        provenanceAfter: PROVENANCE.fitted, reason: d.checks.map(c => c.message).join('; '), transient: false, runId, now: now(), suffix: d.elementId
                    })));
                    degradations.push(...gateDegradations);
                    return { status: degradations.length ? 'degraded' : 'committed', value: r, source: `${r.value.built.length} photo-inferred elements built; ${rejectedByGate.length} of ${gate.length} rejected by the reprojection gate`, layers: built ? [layer] : [], degradations, cached: r.cached };
                },
                degrade: async err => ({
                    status: 'degraded', source: 'no detail', reason: `the ornament build failed (${errorMessage(err)}); the fitted faces stay flat`,
                    degradations: [run.degrade(record('detail', 'detail_failed', {
                        part: { description: 'facade detail of the structure' }, intended: 'photo-inferred detail', fellTo: 'the flat fitted face', provenanceAfter: PROVENANCE.fitted,
                        reason: `the ornament build failed (${errorMessage(err)}); the fitted faces stay flat`, cause: err, transient: scanFitTransient(err), runId, now: now(), reuses: ['resolve', 'tiles', 'remesh', 'fit', 'vision']
                    }))]
                })
            });
            if (detailed.value) out.detail = detailed.value;
            return out;
        };
        // an unexpected error in the glue between the rebuild's stages degrades what has not run, like any failed stage
        let rebuildPromise: Promise<Rebuild> = Promise.resolve(rebuildOut);
        const startRebuild = (): void => {
            rebuildPromise = rebuildRun().catch((err): Rebuild => {
                if (isAbort(err)) throw err;
                const why = `the rebuild stopped on an unexpected error (${errorMessage(err)})`;
                evidenceStop.abort(why);
                const open = (['fit', 'evidence', 'project', 'vision', 'correct', 'detail', 'figures'] as StageId[]).filter(id => run.summary(id).status === 'pending');
                const standing = run.state.layers.some(l => l.layer === 'l3b' || l.layer === 'l3br');
                const rec = run.degrade(record(open[0] ?? 'fit', 'rebuild_failed', {
                    part: { description: standing ? 'the rest of the rebuild' : 'the structure' }, intended: standing ? 'photo-read detail on the fitted structure' : 'a scan-fitted rebuild',
                    fellTo: standing ? 'the fitted faces as built so far' : 'the remeshed scan', provenanceAfter: standing ? PROVENANCE.fitted : PROVENANCE.remeshed,
                    reason: why, cause: err, transient: true, runId, now: now(), reuses: ['resolve', 'tiles', 'trees-measure', 'remesh']
                }));
                open.forEach((id, k) => runner.skip(id, why, k === 0 ? [rec] : []));
                return rebuildOut;
            });
            siblings.push(rebuildPromise);
        };
        startRebuild();
        // the texture pass starts from the first remesh, beside the rebuild (pipeline E textures its own faces)
        if (remeshedNow && !eState) startTextures();

        // ---------------- ownership (the multi-view mask vote, after the first isolate is shown) ----------------
        const ownershipPromise = voteLater && isolateMode ? ownershipRun(voteLater) : Promise.resolve(undefined);
        if (!voteLater) runner.skip('ownership', !isolateMode ? 'not an isolated structure' : !deps.refine.renderOwnershipViews ? 'tile_refine cannot render ownership views in this build' : !visionAvailable ? (deps.vision && 'unavailable' in deps.vision ? deps.vision.unavailable : 'no vision model is configured') : 'the remesh did not run the geometric isolate');
        ownershipPromise.catch(() => undefined);
        siblings.push(ownershipPromise);

        /** Every sibling settled, including those a stage started while the others were awaited (figures start inside the rebuild). */
        const settleAll = async (): Promise<PromiseSettledResult<unknown>[]> => {
            let seen = 0;
            const all: PromiseSettledResult<unknown>[] = [];
            while (seen < siblings.length) {
                const batch = siblings.slice(seen);
                seen = siblings.length;
                all.push(...await Promise.allSettled(batch));
            }
            return all;
        };
        let results = await settleAll();
        let failure = results.find((r): r is PromiseRejectedResult => r.status === 'rejected');
        if (failure) throw failure.reason;

        // ---------------- the second pass: the vote changed the structure materially ----------------
        const vote = await ownershipPromise;
        if (vote?.material && vote.refined) {
            const redo: StageId[] = ['grammar', 'relief', 'fit', 'evidence', 'project', 'vision', 'correct', 'detail', 'figures', 'textures', 'textures-late'];
            const dropped = run.reopen(redo);
            if (dropped.length) cache.writeRunNote(runId, 'first_pass_degradations', dropped);
            remeshedNow = vote.refined;
            remeshRequest = vote.request;
            isolateOk = vote.isolateOk;
            groundOverride = { groundFile: vote.refined.clayGlb, groundLayerId: vote.layer!.objectId };
            passStop = new AbortController();
            rebuildOut = { droppedNotResolvable: 0 };
            texturesPromise = undefined;
            lateTexturesPromise = undefined;
            textureValue = undefined;
            evidencePromise = undefined;
            figuresPromise = undefined;
            evidenceDecided = deferred<void>();
            fitDecided = deferred<void>();
            startGrammar();
            startRebuild();
            startTextures();
            results = await settleAll();
            failure = results.find((r): r is PromiseRejectedResult => r.status === 'rejected');
            if (failure) throw failure.reason;
        }
        takeEarlyPool()?.close();
        // a run that never started the texture pass says why
        const noTextures = remeshedNow ? 'the texture pass did not start' : 'the remesh failed, so there is no remeshed layer to texture';
        runner.skip('textures', noTextures);
        runner.skip('textures-late', noTextures);
        const treesOut = await treesPromise;
        const rebuild = await rebuildPromise;
        persist();

        // ---------------- finish ----------------
        cache.writeRunNote(runId, 'main_thread', blockTracer.stop());
        cache.writeRunNote(runId, 'model_calls', modelCalls.report());
        if (readingStore) cache.writeRunNote(runId, 'model_readings', readingStore.report());
        const outcome = finishRun(run, {
            request, place: placeValue, extraction, structure, sizedTo: t.sizedTo, remeshed: remeshedNow, groundFile: groundOverride?.groundFile ?? remesh.value?.groundFile, groundLayerId: groundOverride?.groundLayerId ?? remesh.value?.groundLayerId ?? currentL1()?.objectId,
            trees: treesOut.trees, putBack: treesOut.putBack, rebuild, strip, ...(textureValue ? { textures: textureValue } : {}), now, persist,
            keep: { modelsDir: cache.modelsDir, note: (name, value) => cache.writeRunNote(runId, name, value) }
        });
        // the place's versions are in the object store before this run's are offered to it (a pull still out keeps reading)
        if (placePull) await Promise.race([placePull, new Promise(r => setTimeout(r, PLACE_STORE_PARAMS.pullWaitMs).unref())]);
        keepSceneObjects(run, cache, outcome, extraction, request.query, { isolate: !!request.isolate, place: placeValue ? { name: placeValue.formattedAddress || request.query, lat: placeValue.lat, lng: placeValue.lng } : undefined });
        return outcome;
    } catch (err) {
        // the Street View fetch and the two branches are ended with the call: none is left running, or rejecting unseen, behind it
        tilesSettle(undefined);
        await Promise.allSettled(siblings);
        try { takeEarlyPool()?.close(); } catch { /* nothing to free */ }
        if ((err as Error)?.name === 'AbortError') {
            run.state.runState = 'stopped';
            for (const s of run.state.stages) if (s.status === 'running' || s.status === 'pending') s.status = 'stopped';
        } else {
            // a hard failure, or an error nothing could degrade: the run is recorded failed, whatever it left open is stopped
            run.state.runState = 'failed';
            if (!(err instanceof StagedLocationHardFailure)) {
                for (const s of run.state.stages) if (s.status === 'running' || s.status === 'pending') { s.status = 'stopped'; s.reason = s.reason ?? `the call failed: ${errorMessage(err)}`; }
            }
        }
        persist();
        run.close();
        try { cache.writeRunNote(runId, 'main_thread', blockTracer.stop()); } catch { /* the note is diagnostics only */ }
        try { cache.writeRunNote(runId, 'model_calls', modelCalls.report()); } catch { /* the note is diagnostics only */ }
        try { if (readingStore) cache.writeRunNote(runId, 'model_readings', readingStore.report()); } catch { /* the note is diagnostics only */ }
        throw err;
    }
}

/**
 * The finished scene into the scene object store (scene-objects.ts): each separable object of its layers as its own
 * versioned GLB, and the scene's data with the versions it used. Informative like the rest of the asset store: a failure
 * is written to the run's notes and never fails the build.
 */
function keepSceneObjects(run: StagedRun, cache: StageCache, outcome: StagedLocationOutcome, extraction: FinishScan, query: string, training: { isolate: boolean; place?: { name: string; lat: number; lng: number } }): void {
    if (!objectStoreEnabled()) return;
    const store = defaultDurableAssetStore();
    if (!store) return;
    // after the result: the build does not wait for its objects to be cut and kept
    inBackground(storeSceneObjects({
        store, runId: run.runId, sceneId: run.state.artifactId, query, frame: objectFrameOf(extraction), layers: run.state.layers, manifests: run.objectManifests,
        modelsDir: cache.modelsDir, scene: (outcome.result.artifact as { data?: unknown } | null)?.data ?? null, workspace: cache.workspaceRoot
    }).then(report => {
        cache.writeRunNote(run.runId, 'object_store', report);
        // a chunked district's kept objects copied to the place store (place-store-district.ts)
        if (placeStoreEnabled()) inBackground(syncPlaceAfterObjects({ runId: run.runId, cache, store, kept: report.kept }).then(r => { if (r) cache.writeRunNote(run.runId, 'place_store', r); }));
        console.log(`[staged-location] scene objects: ${report.objects} (${report.stored} stored, ${report.reused} reused, ${report.failed.length} failed) in ${report.ms} ms; scene ${report.scenePath ?? 'not kept'}`);
        // the district and object training pairs (scene-training-pairs.ts), where this instance has a training bucket;
        // started and forgotten like the objects themselves
        if (training.place) {
            try {
                const superseded = new Set(run.state.layers.filter(l => !l.retired).flatMap(l => l.supersedes));
                captureTrainingPairsInBackground(sceneTrainingPairs({
                    runId: run.runId, place: training.place.name, anchor: { lat: training.place.lat, lng: training.place.lng }, isolate: training.isolate,
                    scanGlb: extraction.texturedGlb, report, store,
                    liveLayers: run.state.layers.filter(l => !l.retired && !superseded.has(l.objectId)).map(l => ({ layer: l.layer, url: l.url, provenanceLabels: l.provenanceLabels }))
                }), sweepPendingBuildingTraining);
            } catch (err) {
                console.warn(`[training-capture] run ${run.runId}: ${errorMessage(err)}`);
            }
        }
    }, err => {
        try { cache.writeRunNote(run.runId, 'object_store', { error: errorMessage(err) }); } catch { /* notes are diagnostics */ }
    }));
}

/** The result's record of the pass-through scan hidden as redundant with the fitted surface. */
function passThroughHiddenSummary(split: PassThroughSplit): NonNullable<NonNullable<StagedLocationResult['structureFit']>['passThroughHidden']> {
    const r = split.report;
    return {
        triangles: r.trianglesHidden, trianglesSplit: r.trianglesSplit, areaM2: r.areaHiddenM2, areaKeptM2: r.areaKeptM2,
        regions: r.regions.filter(x => x.areaHiddenM2 > 0).length, toleranceM: { min: r.toleranceM.min, max: r.toleranceM.max }, reportPath: split.reportPath
    };
}

/** Publishes a fit's (or refit's) layers: outlines, the fitted body (one node per surface) and the pass-through scan. */
function commitFitLayers(run: StagedRun, r: ScanFitFitResult, key: string, base: string, cache: StageCache, address: string, corrected: { ids: string[]; confidence: number } | undefined, split?: PassThroughSplit): StagedLayer[] {
    const fit = r.value;
    const refit = !!corrected;
    const correctedIds = corrected?.ids;
    const out: StagedLayer[] = [];
    const prior = (layer: string) => run.state.layers.filter(l => l.layer === layer).pop();
    const remesh = currentRemeshLayer(run);
    const fitRecord = (label: ProvenanceLabel): ProvenanceRecord => {
        const sources = [{ kind: 'stage-output' as const, id: `fit:${key.slice(0, 8)}` }];
        // a value the photos moved is read from the photos, not measured in the scan: it says so, with the correction's confidence
        if (corrected && NON_MEASURED_PROVENANCE_LABELS.includes(label)) {
            return {
                label, measuredGeometry: false, confidence: corrected.confidence, residual: fit.metrics.scanToFit, sources,
                method: `scan_fit refit: ${corrected.ids.length} primitive${corrected.ids.length === 1 ? '' : 's'} moved to a value read from the photos, kept only inside the scan tolerance`,
                note: `only ${corrected.ids.join(', ')} ${corrected.ids.length === 1 ? 'is' : 'are'} photo-corrected; the residual is the whole fit's against the scan`
            };
        }
        // faces the fit placed where the scan has no samples are not measurement: the share of the fitted area the scan supports is the confidence
        const totalArea = fit.surfaces.reduce((a, x) => a + x.areaM2, 0);
        const unobservedArea = fit.surfaces.filter(x => x.supportFraction < 0.5).reduce((a, x) => a + x.areaM2, 0);
        if (label === PROVENANCE.fitted && unobservedArea > 0 && totalArea > 0) {
            return {
                label, measuredGeometry: false, confidence: round(1 - unobservedArea / totalArea, 4), residual: fit.metrics.scanToFit, sources,
                method: 'scan_fit: the four operators fitted to the isolated scan',
                note: `${round(unobservedArea, 1)} m² of ${round(totalArea, 1)} m² of fitted faces are placed where the scan has no samples (fitted-unobserved)`
            };
        }
        return { label, measuredGeometry: true, method: 'scan_fit: the four operators fitted to the isolated scan', sources, residual: fit.metrics.scanToFit };
    };
    const unobserved = fit.surfaces.filter(s => s.supportFraction < 0.5);
    const labels: ProvenanceLabel[] = [PROVENANCE.fitted, ...(unobserved.length ? [PROVENANCE.fittedUnobserved] : []), ...(refit ? [PROVENANCE.photoCorrected] : [])];
    const add = (layerName: string, file: string | undefined, label: ProvenanceLabel, labelsHere: ProvenanceLabel[], reveal: Partial<StagedLayer['reveal']>, supersedes: string[], revealAfter: string[], note?: string) => {
        if (!file || !fs.existsSync(file)) return;
        const pub = cache.publishFile(file, `${base}_${layerName}_${key.slice(0, 8)}.glb`);
        const provenance = fitRecord(label);
        const layer: StagedLayer = {
            objectId: layerObjectId(key, layerName), stage: refit ? 'correct' : 'fit', layer: layerName, order: STAGES.fit.order, url: pub.url, bytes: pub.bytes,
            provenance: note ? { ...provenance, note: provenance.note ? `${provenance.note}; ${note}` : note } : provenance, provenanceLabels: labelsHere, supersedes, revealAfter,
            reveal: { durationMs: 900, stagger: 1, crossfadeFrom: [], ...reveal }, cached: r.cached, builtAtMs: r.builtAtMs, counts: glbMeshCounts(file)
        };
        run.commit(layer, { source: 'scan_fit', resolvedAddress: address });
        out.push(layer);
    };
    if (!refit) {
        add('l3a', fit.outputs.outlinesGlb, PROVENANCE.fitted, [PROVENANCE.fitted], {}, [], []);
        const outlines = out[0]?.objectId;
        // the pass-through scan a fitted face already shows: its own layer, which the fitted body supersedes (viewable under
        // "Show replaced layers"); the rest is the pass-through layer that is drawn, textured and exported
        const rep = split?.report;
        const tol = rep ? (rep.toleranceM.min === rep.toleranceM.max ? `${rep.toleranceM.max.toFixed(2)} m` : `${rep.toleranceM.min.toFixed(2)}-${rep.toleranceM.max.toFixed(2)} m`) : '';
        add('l3ch', split?.hiddenFile, PROVENANCE.asScanned, [PROVENANCE.asScanned], {}, [], [],
            rep && `hidden: redundant with the fitted surface (${rep.trianglesHidden} triangles hidden whole, ${rep.trianglesSplit} clipped at a face edge, ${rep.areaHiddenM2.toFixed(1)} m² within ${tol} of a fitted face behind them)`);
        const hiddenId = out.find(l => l.layer === 'l3ch')?.objectId;
        add('l3b', fit.outputs.fittedGlb, PROVENANCE.fitted, labels, { crossfadeFrom: remesh ? [remesh.objectId] : [] }, [...(remesh ? [remesh.objectId] : []), ...(hiddenId ? [hiddenId] : [])], [...(remesh ? [remesh.objectId] : []), ...(outlines ? [outlines] : [])]);
        add('l3c', split ? split.visibleFile : fit.outputs.passThroughGlb, PROVENANCE.asScanned, [PROVENANCE.asScanned], { crossfadeFrom: remesh ? [remesh.objectId] : [] }, [], remesh ? [remesh.objectId] : [],
            rep && rep.areaHiddenM2 > 0 ? `${rep.areaKeptM2.toFixed(1)} of ${rep.areaInM2.toFixed(1)} m² drawn; ${rep.areaHiddenM2.toFixed(1)} m² lying within ${tol} of a fitted face are hidden (layer l3ch)` : undefined);
    } else {
        const a = prior('l3a'), b = prior('l3b');
        add('l3ar', fit.outputs.outlinesGlb, PROVENANCE.photoCorrected, [PROVENANCE.fitted, PROVENANCE.photoCorrected], { crossfadeFrom: a ? [a.objectId] : [], only: { primitiveIds: correctedIds! } }, a ? [a.objectId] : [], a ? [a.objectId] : []);
        add('l3br', fit.outputs.fittedGlb, PROVENANCE.photoCorrected, labels, { crossfadeFrom: b ? [b.objectId] : [], only: { primitiveIds: correctedIds! } }, b ? [b.objectId] : [], b ? [b.objectId] : []);
    }
    return out;
}

/** What the finish reads of the extraction: this build's own, or with the centre in the cloud the centre job's (cloudScanOf). */
type FinishScan = Pick<StagedExtraction, 'texturedGlb' | 'rawGlbPath' | 'radiusM' | 'coveredRadiusM' | 'truncated' | 'leafTiles' | 'leafGeometricErrorM' | 'originEllipsoidalHeightM' | 'geoAnchor'>;

/** The centre job's extraction as its outcome reports it (its paths moved onto this workspace; its raw scan is not downloaded). */
function cloudScanOf(out: StagedLocationOutcome): FinishScan {
    const e = out.result.extraction;
    const truncated = out.result.stages.some(s => s.stage === 'tiles' && s.status === 'degraded');
    return {
        texturedGlb: out.compat.glbPath, rawGlbPath: out.compat.glbPath, radiusM: e.radiusM, coveredRadiusM: e.radiusM, truncated, leafTiles: e.leafTiles,
        leafGeometricErrorM: out.result.sourceLimits?.leafGeometricErrorM ?? e.geometricErrorM, originEllipsoidalHeightM: out.compat.frame!.originEllipsoidalHeightM, geoAnchor: out.compat.geoAnchor
    };
}

interface FinishInput {
    request: StagedLocationRequest;
    place: ResolvedPlace;
    extraction: FinishScan;
    /** The remesh ran in the centre's cloud job, not here. */
    remeshedElsewhere?: boolean;
    structure?: StructurePickResult;
    sizedTo: 'structure' | 'request' | 'district-fallback' | 'district-containment';
    remeshed?: TileRefineResult;
    groundFile?: string;
    groundLayerId?: string;
    trees?: LocationClayTrees;
    putBack?: { triangles: number; crowns: number; reason: string };
    rebuild: { figures?: FigureRecord[]; anchored?: AnchorNote[]; located?: DetailPlan; fit?: ScanFitFitResult; refit?: ScanFitFitResult; spec?: OrnamentSpec; rejected?: PrimitiveCorrection[]; detail?: ScanFitOrnamentResult; droppedNotResolvable: number; sourceLimits?: SourceLimits; evidenceCounts?: { tileOrthos: number; streetView: number }; runReadings?: RunReadingReport; registration?: NonNullable<NonNullable<StagedLocationResult['ornament']>['registration']>; slotsOffered?: { offered: number; total: number; hidden: number; unseen: number; exposureJudged: boolean }; passThroughHidden?: PassThroughSplit };
    strip?: TileVegetationStripResult;
    textures?: TextureStageValue;
    now: () => number;
    persist: () => void;
    /** Where this run's models were published, and its run notes: a finished district is kept as a world and backed up (backupDistrictWorld). */
    keep?: { modelsDir: string; note: (name: string, value: unknown) => void };
}

/** A district's world name: its place and its run, e.g. `district_2_penn_plaza_new_york_8e3a912b`. */
export function districtWorldSlug(query: string, runId: string): string {
    return `district_${query.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 80)}_${runId}`;
}

/**
 * Every finished district (not one isolated building) kept as a world in the folder that serves /tilesets beside the
 * published models, and backed up to the cloud world cache, so it opens again on any machine (user ask, 2026-11-04;
 * cloud-store/district-world.ts). In the background: the build's result never waits on the upload, and a failure is a run
 * note, never a failed build. Only with a world cache bucket (SCRATCHBOX_WORLD_CACHE_BUCKET or cloud-store.json; none in
 * tests), and not with SCRATCHBOX_DISTRICT_BACKUP=0.
 */
function backupDistrictWorld(f: FinishInput, runId: string, artifact: CanvasArtifact | undefined): void {
    if (f.request.isolate || !artifact || !f.keep || process.env.SCRATCHBOX_DISTRICT_BACKUP?.trim() === '0') return;
    const bucket = defaultWorldCacheBucket();
    if (!bucket) return;
    const keep = f.keep, slug = districtWorldSlug(f.request.query, runId);
    const started = Date.now();
    void publishDistrictWorld({
        artifact: artifact as unknown as { data?: Record<string, unknown> }, modelsDir: keep.modelsDir, slug, runId, bucket,
        worldsDir: path.join(path.dirname(keep.modelsDir), 'tilesets'),
        title: `${f.place.formattedAddress} district (${runId})`, log: m => console.log(m)
    }).then(r => keep.note('district_world', { slug, models: r.models, bytes: r.bytes, ...(r.stored ? { stored: r.stored } : {}), ms: Date.now() - started }))
        .catch(err => keep.note('district_world', { slug, failed: errorMessage(err), ms: Date.now() - started }));
}

function finishRun(run: StagedRun, f: FinishInput): StagedLocationOutcome {
    const now = f.now;
    // stages never reached (a deadline) are stopped
    for (const s of run.state.stages) if (s.status === 'pending' || s.status === 'running') { s.status = 'stopped'; s.reason = s.reason ?? 'not started before the run ended'; }
    const stoppedAtDeadline = run.state.stages.some(s => s.status === 'stopped');
    if (stoppedAtDeadline) {
        const last = run.state.stages.filter(s => s.status === 'committed' || s.status === 'degraded').sort((a, b) => (a.timings.endedAtMs ?? 0) - (b.timings.endedAtMs ?? 0)).pop();
        run.degrade(record('finish', 'run_deadline', {
            part: { description: 'the stages not started' }, intended: 'every stage', fellTo: 'the stages committed so far', provenanceAfter: PROVENANCE.remeshed,
            reason: `stopped at the time limit after ${last ? last.title.toLowerCase() : 'the start'}`, transient: true, runId: run.runId, now: now(), reuses: []
        }));
    }
    // the gate, over the visible layers
    const visible = run.state.layers.filter(l => !l.retired && !run.state.layers.some(o => o.supersedes.includes(l.objectId)));
    const submeshes: GeometricMeshSummary[] = visible.map(l => ({ name: l.objectId, vertexCount: l.counts.vertices, triangleCount: l.counts.triangles, tag: String(l.provenance.label) }));
    const exemptions: ComplexityExemption[] = [];
    const scanNames = visible.filter(l => [PROVENANCE.asScanned, PROVENANCE.scanFlattened, PROVENANCE.remeshed].includes(l.provenance.label as never) && l.layer !== 'l3c').map(l => l.objectId);
    if (scanNames.length) exemptions.push({ scanDerived: { submeshes: scanNames, label: PROVENANCE.remeshed, leafGeometricErrorM: f.extraction.leafGeometricErrorM } });
    const fitResult = f.rebuild.refit ?? f.rebuild.fit;
    const rebuildNames = visible.filter(l => ['l3a', 'l3b', 'l3c', 'l3ar', 'l3br', 'l4', 'l3cf', 'l4f'].includes(l.layer)).map(l => l.objectId);
    const refusedHere: string[] = [];
    if (fitResult && rebuildNames.length) {
        // the gate quotes the StructureFit's sha: a report that can no longer be read earns no exemption, and the layers are counted
        try {
            exemptions.push({ measuredRebuild: { submeshes: rebuildNames, structureFit: fitResult.value, structureFitSha256: sha256File(fitResult.value.outputs.reportJson) } });
        } catch (err) {
            refusedHere.push(`measured rebuild ${rebuildNames.join(', ')}: its StructureFit report could not be read (${errorMessage(err)})`);
        }
    }
    // SB-Veggie trees grown inside the crowns the strip measured: the count of trees is the scan's, so the layer is judged by that and not padded
    const grownTrees = visible.filter(l => l.layer === 'l5').map(l => l.objectId);
    if (grownTrees.length && f.trees && f.trees.count > 0) exemptions.push({ measuredCrowns: { submeshes: grownTrees, crowns: f.trees.count } });
    const gate = GeometricComplexityGate.evaluate({
        totalVertices: submeshes.reduce((s, m) => s + m.vertexCount, 0), totalTriangles: submeshes.reduce((s, m) => s + m.triangleCount, 0), submeshes, engineKernel: 'scratchbox-native'
    }, { exemptions });

    // retire large superseded layers (never the ground)
    run.state.layers = retireSupersededLayers(run.state.layers, new Set(f.groundLayerId ? [f.groundLayerId] : []));
    const degradedAny = run.state.degradations.length > 0 || run.state.stages.some(s => s.status === 'degraded' || s.status === 'stopped');
    const status: StagedLocationResult['status'] = degradedAny ? 'degraded' : 'complete';
    run.state.runState = 'finished';
    const retryStages = [...new Set(run.state.degradations.filter(d => d.transient && d.retry).map(d => d.retry!.args.retryStage))];
    if (retryStages.length) run.state.retry = { retryRunId: run.runId, stages: retryStages };
    // Street View imagery is credited where it was read; a fetch the fit's failure made moot shows nothing to credit
    if (!f.rebuild.evidenceCounts?.streetView && !run.state.materialHints?.cost.images) run.state.attribution = run.state.attribution.filter(a => a !== 'Street View ©Google');
    const sourceLimits = f.rebuild.sourceLimits ?? { leafGeometricErrorM: f.extraction.leafGeometricErrorM, meshEdgeP50M: 0, meshResolvableM: round(0.25 * f.extraction.leafGeometricErrorM), texelM: 0, photoResolvableM: 0 };
    const fit = fitResult?.value;
    const ornament = f.rebuild.spec;
    const provenance = new Map<ProvenanceLabel, { label: ProvenanceLabel; objects: number; triangles: number }>();
    for (const l of visible) {
        const p = provenance.get(l.provenance.label) ?? { label: l.provenance.label, objects: 0, triangles: 0 };
        p.objects++;
        p.triangles += l.counts.triangles;
        provenance.set(l.provenance.label, p);
    }
    const remeshLayer = run.state.layers.filter(l => ((l.layer === 'l2' && l.stage === 'remesh') || l.layer === 'l2v') && l.provenance.label === PROVENANCE.remeshed).pop();
    const byStage = Object.fromEntries(run.state.stages.filter(s => s.timings.ms !== undefined).map(s => [s.stage, s.timings.ms!]));
    // what is said to have been built is what the detail build built and committed as a layer, not what the reading kept
    const detailLayerMounted = visible.some(l => l.layer === 'l4');
    const builtIds = new Set(detailLayerMounted ? (f.rebuild.detail?.value.built ?? []).map(b => b.elementId) : []);
    const builtElements = ornament?.elements.filter(e => builtIds.has(e.id)) ?? [];
    const confidences = builtElements.map(e => e.confidence).sort((a, b) => a - b);
    const costed = run.state.stages.filter(x => x.cost);
    const photoCost = costed.length ? {
        total: { images: costed.reduce((n, x) => n + x.cost!.images, 0), visionCalls: costed.reduce((n, x) => n + x.cost!.visionCalls, 0), seconds: round(costed.reduce((n, x) => n + x.cost!.seconds, 0), 1) },
        byStage: Object.fromEntries(costed.map(x => [x.stage, x.cost!]))
    } : undefined;
    const activeScene = activeSceneReport(run);
    const base: Omit<StagedLocationResult, 'digest' | 'summary' | 'artifact'> = {
        success: true,
        status,
        place: { query: f.request.query, resolvedAddress: f.place.formattedAddress, lat: f.place.lat, lng: f.place.lng, ...(typeof f.extraction.geoAnchor.elevation === 'number' ? { elevationM: f.extraction.geoAnchor.elevation } : {}), ...(f.place.alternatives?.length ? { alternatives: f.place.alternatives } : {}) },
        ...(run.state.structure ? { structure: run.state.structure } : {}),
        extraction: {
            ...(f.request.isolate ? {} : { requestedRadiusM: f.request.radiusM ?? 250 }),
            // the radius the tiles really reach: the leaf-tile cap can stop a large request short of the one asked for
            radiusM: f.extraction.truncated ? Math.min(f.extraction.radiusM, f.extraction.coveredRadiusM) : f.extraction.radiusM, sizedTo: f.sizedTo, leafTiles: f.extraction.leafTiles,
            cached: run.cacheStatus.tiles === 'hit', ...(run.cacheStatus.tiles === 'hit' ? { ageDays: round((now() - (run.summary('tiles').timings.builtAtMs ?? now())) / 86_400_000, 1) } : {}),
            geometricErrorM: f.extraction.leafGeometricErrorM, texelM: sourceLimits.texelM, attribution: run.state.attribution
        },
        // copies: the result is the record of this call, and stays so
        stages: JSON.parse(JSON.stringify(run.state.stages)) as StageSummary[],
        degradations: JSON.parse(JSON.stringify(run.state.degradations)) as DegradationRecord[],
        provenance: [...provenance.values()],
        ...(remeshLayer?.vertexProvenance ? { remeshVertexProvenance: remeshLayer.vertexProvenance } : {}),
        ...(fit ? {
            structureFit: {
                buildingId: fit.buildingId, accepted: fit.accepted, primitives: fit.primitives.length,
                scanToFitRmsM: fit.metrics.scanToFit.rmsM, fitToScanRmsM: fit.metrics.fitToScan.rmsM, coverage: fit.metrics.coverage,
                passThroughAreaM2: fit.passThrough.areaM2, unobservedFaceAreaM2: round(fit.surfaces.filter(s => s.supportFraction < 0.5).reduce((s, x) => s + x.areaM2, 0), 2),
                gates: fit.gates, corrections: [...(ornament?.corrections ?? []), ...(f.rebuild.rejected ?? [])], reportPath: fit.outputs.reportJson,
                ...(f.rebuild.passThroughHidden ? { passThroughHidden: passThroughHiddenSummary(f.rebuild.passThroughHidden) } : {})
            }
        } : {}),
        ...(ornament ? {
            ornament: {
                elements: builtElements.length, read: ornament.elements.length, slotsFilled: new Set(builtElements.map(e => e.slotId)).size, slotsEmpty: ornament.emptySlots.length,
                confidence: { min: confidences[0] ?? 0, median: confidences[Math.floor(confidences.length / 2)] ?? 0, max: confidences[confidences.length - 1] ?? 0 },
                evidence: f.rebuild.evidenceCounts ?? { tileOrthos: 0, streetView: 0 }, model: ornament.model, revisionPass: ornament.revision.passes === 1,
                ...(f.rebuild.anchored?.length ? { anchoring: f.rebuild.anchored.map(n => ({ elementId: n.elementId, slotId: n.slotId, kind: n.kind, errorM: n.errorM, toleranceM: n.toleranceM, note: n.note })) } : {}),
                ...(f.rebuild.slotsOffered ? { slotsOffered: f.rebuild.slotsOffered } : {}),
                ...(f.rebuild.registration ? { registration: f.rebuild.registration } : {}),
                ...(f.rebuild.runReadings ? { runReadings: { targets: f.rebuild.runReadings.targets, read: f.rebuild.runReadings.read, elements: f.rebuild.runReadings.elements, replaced: f.rebuild.runReadings.replaced, skipped: f.rebuild.runReadings.skipped } } : {}),
                ...(f.rebuild.located ? { surveyLocated: { elements: f.rebuild.located.located.length, unlocated: f.rebuild.located.unlocated.length, slots: new Set(f.rebuild.located.located.map(l => l.slotId)).size, crops: f.rebuild.located.views.length } } : {}),
                dropped: ornament.dropped.length, specPath: run.keys.vision ? path.join('.scratchbox', 'cache', 'staged_location', 'vision', run.keys.vision, 'done.json') : ''
            }
        } : {}),
        ...(activeScene ? { activeScene } : {}),
        ...(run.state.materialHints ? { materialHints: run.state.materialHints } : {}),
        ...(f.textures ? { texturePass: f.textures.record } : {}),
        ...(photoCost ? { photoCost } : {}),
        ...(f.rebuild.figures?.length ? { figures: f.rebuild.figures } : {}),
        ...(f.trees ? { trees: f.trees } : {}),
        complexityGate: { passed: gate.passed, totalVertices: gate.totalVertices, totalTriangles: gate.totalTriangles, violations: gate.violations, exemptions: gate.exemptions },
        sourceLimits,
        timingsMs: { total: now() - run.startedAt, firstVisual: (run.firstVisualAt ?? now()) - run.startedAt, byStage },
        cache: { ...run.cacheStatus }
    };
    // layers the floor exempted as measured that are partly inferred or grown: said beside the exemption, not only in the provenance toggle
    const exemptIds = new Set([...scanNames, ...rebuildNames, ...grownTrees]);
    const exemptInferred = visible.filter(l => exemptIds.has(l.objectId) && !l.provenance.measuredGeometry)
        .map(l => `${l.objectId} (${l.provenance.label}) is ${round((1 - (l.provenance.confidence ?? 0)) * 100, 1)}% inferred or grown, not measured`);
    const summaryInput: StagedSummaryInput = {
        ...base, runId: run.runId,
        ...(remeshLayer?.provenance.note ? { remeshNote: remeshLayer.provenance.note } : {}),
        ...(f.putBack ? { treesPutBack: f.putBack } : {}),
        ...(exemptInferred.length ? { exemptInferred } : {}),
        ...(gate.exemptionsRefused.length || refusedHere.length ? { exemptionsRefused: [...refusedHere, ...gate.exemptionsRefused] } : {}),
        droppedNotResolvable: f.rebuild.droppedNotResolvable,
        ...(f.textures ? { textures: { shares: f.textures.shares, views: f.textures.views, modelsUsed: f.textures.modelsUsed, layers: f.textures.layers.map(l => l.layer), totalMs: f.textures.record.timingsMs.total ?? 0, ...(f.textures.tileUnavailable ? { tileUnavailable: f.textures.tileUnavailable } : {}), ...(f.textures.viewsUnavailable ? { viewsUnavailable: f.textures.viewsUnavailable } : {}) } } : {})
    };
    const switchPills = buildSwitchLocationPills({ ...f.place, ...(f.place.alternatives?.length ? { alternatives: f.place.alternatives } : {}) }, { query: f.request.query, isolate: f.request.isolate, radiusM: f.request.radiusM, trees: f.request.trees, stageIntoActiveScene: f.request.stageIntoActiveScene });
    const { digest, summary } = summarizeStagedBuild({ ...summaryInput, switchLocation: switchLocationMarkdown(switchPills) });
    const artifact = run.artifact(digest);
    const result: StagedLocationResult = { ...base, artifact: artifact ?? null, digest, summary };
    // the finish event carries the final scene
    run.emitFinish(status === 'complete' ? 'committed' : 'degraded', digest);
    backupDistrictWorld(f, run.runId, artifact);
    f.persist();
    run.close();
    return {
        result,
        runId: run.runId,
        compat: {
            remesh: f.remeshed || f.remeshedElsewhere ? { ok: true, url: remeshLayer?.url } : { ok: false, error: (run.state.degradations.find(d => d.stage === 'remesh' && d.reasonCode === 'remesh_failed') ?? run.state.degradations.find(d => d.stage === 'remesh'))?.reason ?? 'the remesh did not run' },
            resolvedAddress: f.place.formattedAddress,
            geoAnchor: f.extraction.geoAnchor,
            frame: { lat: f.place.lat, lng: f.place.lng, originEllipsoidalHeightM: f.extraction.originEllipsoidalHeightM },
            glbPath: f.extraction.rawGlbPath ?? f.extraction.texturedGlb,
            ...(f.groundFile ? { groundGlbPath: f.groundFile } : {}),
            ...(f.trees ? { trees: f.trees } : {})
        }
    };
}
