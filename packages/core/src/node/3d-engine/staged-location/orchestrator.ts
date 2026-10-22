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
import { TileVegetationError, type TileVegetationPlantRequest, type TileVegetationPlantResult, type TileVegetationStripRequest, type TileVegetationStripResult } from '../tile-vegetation-service';
import type { TileRefineRequest, TileRefineResult } from '../tile-refine-service';
import { evidenceLookup, footprintPriorFor, type EvidenceLookup, type VectorEvidence } from './vector-footprints';
import {
    coveredShare, frameToLatLng, paintGeneratedHeightProvenance, paintProvenance, selectPaintBuildings, tilePlanCoverage, writePaintGlb,
    GENERATED_HEIGHT_LABEL, PLAUSIBLE_DEFAULT_HEIGHT_M, VECTOR_ISOLATE_RADIUS_M, VECTOR_MASSING_VERSION,
    VECTOR_MODELLED_LABEL, VECTOR_OUTER_MAX_COVERED_SHARE, type ElevationLookup, type PaintBuilding, type PaintSelection
} from './vector-first-paint';
import { VisionModelChain, type VisionGenAIClient } from '../../gemini/vision-model-chain';
import { segmentOwnershipViews } from './ownership-masks';
import { buildGroundModel, geodeticToScan, loadScanMesh, surfaceModel, type GeodeticOrigin, type GroundModel, type ScanMesh } from '../../spatial/StreetViewSurveyPlanner';
import { buildRoadMesh, measureRoadSurfaces, sbRoadieEnabled, writeRoadsGlb, ROAD_SURFACE_PARAMS, type RoadMesh, type RoadSurface } from './road-surfaces';
import { renderTopDownPhoto } from './top-down-photo';
import { synthesizeRoadTextures } from './road-texture';
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
    canopyLookup, checkIsolate, grownOutline, pickOnScan, FOOTPRINT_TOLERANCE_M, sizeExtraction, structureKeepCells, writeIsolationPick, ISOLATE_PRECISION_MIN, ISOLATE_ROOFED_MIN, NO_STRUCTURE_DISTRICT_RADIUS_M, type StructurePickResult
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
import { prepareTextureSources, type TextureSources, type TextureSourcesInput } from './texture-sources';
import { ownershipChange, OWNERSHIP_MATERIAL_SHARE } from './ownership-change';
import { tileRefineTwin, TILE_REFINE_TWIN_VERSION, type TileRefineTwin } from './tile-refine-twin';
import { maskTemporaryInViews, textureTemporaryEnabled, visionTemporaryChecker, TEMPORARY_CHECK_VERSION } from './temporary-structures';
import { objectSegmenter, ownViews, OWNERSHIP_VERSION, type OwnershipSegmenter } from './streetview-ownership';
import { correctViewsLighting, lightingModels, lightingPromptVariant, textureArmOptions, LIGHTING_MODEL_LITE, type LightingCorrectedView } from './texture-lighting';
import { TextureWorkerPool, textureWorkersEnabled } from './texture-worker-pool';
import { eventLoopStats, runBlockTracer } from './event-loop-stats';
import { recordStageTimeline } from './stage-timeline';
import type { EnhanceModelClient } from './texture-enhance';
import { CONFIDENCE_CHANNELS } from './staged-glb-writer';
import { fetchFootprints, type FootprintSource } from './facade-footprints';
import { runMassingStage, stagedPipelineE, pipelineEInference, PIPELINE_E_VERSION, massingProvenance, type MassingLayerFiles, type MassingStageResult } from './pipeline-e/pipeline-e';
import type { MassingRun } from './pipeline-e/native-massing';
import { mslToTileY, type SolarRoof } from './pipeline-e/solar-roof';
import { runInferenceE, type InferenceOutcome, type StepRecord } from './pipeline-e/inference';
import { runVersionFEnhanced, stagedGeometryF } from './version-f/f2';
import { runVersionF3, versionFRound } from './version-f/f3';
import { gateDecision, photoMatchGate, pipelineERelief, runReliefStage, GENERATED_LABEL, MEASURED_AVERAGED_LABEL, RELIEF_GATE_JUDGE, RELIEF_PARAMS, RELIEF_VERSION, type PhotoGateResult, type ReliefOutcome } from './pipeline-e/relief';
import { crownsFromStrip } from './pipeline-e/occluders';
import { enhanceGuards, enhanceModels, genAiPlateClient, stagedEnhance, ENHANCE_STREET_VIEWS } from './pipeline-e/enhance';
import { stagedShapeProgram } from './pipeline-e/shape-program';
import { runShapeStage, SHAPE_STAGE_VERSION } from './pipeline-e/shape-stage';
import { projectionViewsFromEvidence } from './texture-pass';
import { contextWithoutStructure, registeredSurveyViews, trustedRegisteredPose } from './streetview-registered-views';
import { GoogleVectorTileService } from '../../spatial/GoogleVectorTileService';
import { facadeGrammarEnabled, grammarFileText, runFacadeGrammarPass, FACADE_GRAMMAR_GATE_VERSION, FACADE_GRAMMAR_PROMPT_VERSION, type GrammarFacadeOutcome } from './facade-grammar';
import { TEXTURE_LADDER_RUNGS, type ProjectionView, type TexturePassDegradation, type TexturePassRecord, type TextureLayerBundle } from '../../../common/spatial/texture-pass-contracts';

/** What the evidence stage spent: free metadata queries, billed images and the seconds the images took. */
export interface EvidenceCost { metadataCalls: number; cachedCalls: number; imagesRequested: number; imagesFetched: number; fetchMs: number }
const NO_EVIDENCE_COST: EvidenceCost = { metadataCalls: 0, cachedCalls: 0, imagesRequested: 0, imagesFetched: 0, fetchMs: 0 };

// ----------------------------------------------------------------------------------------------------------------
// stages
// ----------------------------------------------------------------------------------------------------------------

/** The ownership vote's outlines are waited for this long; a view not outlined by then is left out of the vote. */
export const OWNERSHIP_VOTE_WINDOW_MS = 60_000;
/** The focused run readings get at most this long after the wide reading (and less when the wide reading ran long). */
export const VISION_RUNS_ALLOWANCE_MS = 120_000;
/** What the vision stage keeps back from its limit: the merge, the cache write and the records after the readings. */
export const VISION_STAGE_MARGIN_MS = 20_000;
/** Below this, the focused run readings are not started: there is no time for a call to answer. */
const MIN_RUNS_WINDOW_MS = 30_000;

/** Canonical order (-1: no layer), overlay title and per-stage time limit. */
export const STAGES = {
    resolve: { order: -1, title: 'Place', budgetMs: 10_000 },
    // the first paint: Google's vector buildings extruded natively while the tiles stream (vector-first-paint.ts); it ends once
    // the tiles have committed and the buildings they do not cover are kept as their own layer
    vector: { order: 0, title: 'Google vector massing', budgetMs: 120_000 },
    tiles: { order: 1, title: 'Google 3D Tiles', budgetMs: 360_000 },
    // the real ground around the place from the Google Elevation API, out to TERRAIN_RADIUS_M, under everything else
    terrain: { order: 0, title: 'Surrounding terrain', budgetMs: 120_000 },
    // the streets: Google's road centrelines measured kerb to kerb on the scan, textured from the tile photo rendered from above
    roads: { order: 2, title: 'Road surfaces', budgetMs: 240_000 },
    survey: { order: -1, title: 'Surveying the four faces', budgetMs: EVIDENCE_DISCOVERY_ALLOWANCE_MS + SURVEY_IMAGE_TIMEOUT_MS + SURVEY_VISION_TIMEOUT_MS + 15_000 },
    evidence: { order: -1, title: 'Street View close-ups', budgetMs: EVIDENCE_STAGE_BUDGET_MS + 30_000 + MATCH_TIMEOUT_MS + 60_000 + EDGE_REGISTRATION_BUDGET_MS + 15_000 + JOINT_REGISTRATION_BUDGET_MS + 30_000 },
    'trees-measure': { order: -1, title: 'Measuring the trees', budgetMs: 300_000 },
    remesh: { order: 2, title: 'Remeshed scan', budgetMs: 300_000 },
    // the facades' grammars read from the tile photo (three readings per facade, concurrently), gated, and the relief run
    // again with the accepted ones; pipeline E's inference runs here too, and in its enhanced mode (the default within E) also a registered
    // Street View survey (about 3 min, alongside the readings) and up to 8 redraws (about 2.5 min)
    // version F (on by default; SCRATCHBOX_STAGED_GEOMETRY=e reverts to E's own inference) reads, adjusts and redraws
    // in this slot: a longer limit
    grammar: { order: 2, title: 'Facade grammar', budgetMs: stagedGeometryF() ? 900_000 : 420_000 },
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
     * later (about 4 min after the Street View close-ups live), whose layers are textured once it settles.
     */
    textures: { order: -1, title: 'Real textures', budgetMs: 600_000 },
    /** Background: the twins of the layers committed after the remesh (fit, detail, grammar, figures), as each lands; it waits for the rebuild and the grammar to settle. */
    'textures-late': { order: -1, title: 'Real textures of later layers', budgetMs: 1_200_000 }
} as const;
export type StageId = keyof typeof STAGES;
export const STAGE_IDS = Object.keys(STAGES) as StageId[];

/** The tool's budget is 40 minutes; the run stops starting stages 2 minutes before it. */
export const RUN_BUDGET_MS = 38 * 60_000;
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
    extract(req: { lat: number; lng: number; radiusM: number; outDir: string; place: ResolvedPlace; signal?: AbortSignal; onProgress?: (message: string) => void }): Promise<StagedExtraction>;
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
    };
    /** The scan fitter; absent until the engine has it (then the rebuild stages degrade and say so). */
    scanFit?: ScanFitDeps;
    /** Why scanFit is absent (shown to the user). */
    scanFitUnavailable?: string;
    streetView?: StreetViewEvidenceDeps;
    /** The vision model client and the models to try (the staged default first); or why there is none. */
    vision?: { client: VisionGenAIClient; candidates: string[] } | { unavailable: string };
    /** Google Solar API roof facets of the building closest to (lat, lng) (pipeline E's massing); absent without a key. */
    solarRoof?(lat: number, lng: number): Promise<SolarRoof>;
    /** Vector building footprints near a place (facade grammar's independent check); default: Google vector feature tiles. */
    footprints?: (place: { lat: number; lng: number }, radiusM: number) => Promise<FootprintSource>;
    /** Builds a figure spec natively and returns its GLB (metres, +Y up, front +Z, origin at the centre of its base); the reference object builder's native build by default. */
    figureBuilder?: (spec: ObjectBuildSpec, signal?: AbortSignal) => Promise<{ glb: Buffer }>;
    /**
     * The texture pass's optional model enhancement of the tile transfer (an image model, edge-gated); absent = that
     * rung is not attempted (tests, or no client). `densityTexelsPerMeter` caps the atlas density (default 20, 5 cm).
     */
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
    compat: {
        remesh: { ok: boolean; url?: string; error?: string };
        resolvedAddress: string;
        geoAnchor: StagedExtraction['geoAnchor'];
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
            state: JSON.parse(JSON.stringify(this.state)), camera: this.camera, layerMeta: this.layerMeta, geoAnchor: this.geoAnchor,
            activeScene: this.activeScene, ...(this.carried ? { carried: this.carried } : {}), summary, version: this.version++
        });
    }

    /** Updates a stage's summary and streams it (with the scene on a commit, degrade or finish). */
    emit(id: StageId, status: StageStatus, extra: { source?: string; reason?: string; layers?: StagedLayer[]; degradations?: DegradationRecord[]; model?: VisionModelUse; message?: string; progress?: number } = {}, withArtifact = false): void {
        if (this.closed) return;
        const s = this.summary(id);
        const wasRunning = s.status === 'running';
        s.status = status;
        if (extra.source !== undefined) s.source = extra.source;
        if (extra.reason !== undefined) s.reason = extra.reason;
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
    constructor(private readonly run: StagedRun, private readonly ctx: StagedLocationContext, private readonly now: () => number) {
        const left = ctx.remainingMs?.() ?? RUN_BUDGET_MS + RUN_DEADLINE_MARGIN_MS;
        this.deadlineAt = now() + Math.max(0, left - RUN_DEADLINE_MARGIN_MS);
    }

    get pastDeadline(): boolean {
        return this.now() >= this.deadlineAt;
    }

    skip(id: StageId, reason: string, degradations: DegradationRecord[] = []): void {
        const s = this.run.summary(id);
        if (s.status !== 'pending') return;
        this.run.emit(id, 'skipped', { reason, degradations });
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
        const io = this.io(STAGES[id].budgetMs, extraSignal);
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
            const failure = why === 'budget' ? Object.assign(new Error(`${STAGES[id].title} took longer than its ${Math.round(STAGES[id].budgetMs / 1000)} s limit`), { code: 'timeout' }) : err;
            if (!def.degrade) throw failure;
            const rung = this.io(STAGES[id].budgetMs, extraSignal);
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
    if (v.tileRefine) return `textured ${v.layers.map(l => l.layer).join(', ')} with the tile photo tile_refine carries onto its remesh (as captured, not de-lit): ${rungs}; photo-derived texels are photo-inferred`;
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

/** What the district layers lost to the kept structure, per layer (the result's activeScene.footprintHidden). */
const FOOTPRINT_REPORTS = new WeakMap<StagedRun, { footprint?: StructureFootprint; error?: string; layers: Array<{ objectId: string; removedTriangles: number; keptTriangles: number }> }>();

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

export async function runStagedLocation(requestIn: StagedLocationRequest, deps: StagedLocationDeps, ctx: StagedLocationContext = {}): Promise<StagedLocationOutcome> {
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
    const runner = new Runner(run, ctx, now);
    const base = `${slug(request.query)}${request.isolate ? '_iso' : ''}`;
    const persist = () => {
        const rec: RunRecord = {
            schema: 'scratchbox.staged-run/1', runId, request, place: placeValue, artifactId, keys: run.keys,
            statuses: Object.fromEntries(run.state.stages.map(s => [s.stage, s.status])), createdAtMs: run.startedAt
        };
        cache.writeRunRecord(runId, rec);
    };
    let placeValue: ResolvedPlace | undefined;
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
        run.state.place = { query: request.query, resolvedAddress: placeValue.formattedAddress, lat: placeValue.lat, lng: placeValue.lng, ...(placeValue.alternatives?.length ? { alternatives: placeValue.alternatives } : {}) };
        persist();
        // staged into the active scene: an earlier build's structure rebuild stays (unless this run rebuilds it at the same
        // place), and the district layers lose their own scan of it where it stands
        if (intoActive) {
            run.carried = partitionActiveScene(intoActive, request.isolate ? placeValue : undefined);
            if (run.carried.structure.length) run.layerTransform = keptStructureCarver(run, cache, base);
        }

        // ---------------- vector (the first paint: Google's vector buildings, extruded natively, beside the tile download) ----------------
        // it commits l0 as soon as it is built, unless the tiles were first; once the tiles commit, the buildings they do not cover
        // (a district past the leaf-tile cap) are kept as l0o, on bases measured against the tiles' own frame
        const vectorPromise = runner.stage<{ buildings: number; outer: number }>({
            id: 'vector',
            run: async io => {
                if (!deps.vectorEvidence) return { status: 'skipped', source: '', reason: 'no Google vector data: no service account is configured for vectortiles.featuretiles' };
                const place = placeValue!;
                const radiusM = request.isolate ? VECTOR_ISOLATE_RADIUS_M : (request.radiusM ?? 250);
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
                const left = [
                    sel.partsGivenDefaultHeight ? `${sel.partsGivenDefaultHeight} footprint part${sel.partsGivenDefaultHeight === 1 ? '' : 's'} with no height in the vector data shown at a plausible ${PLAUSIBLE_DEFAULT_HEIGHT_M} m (generated)` : '',
                    sel.buildingsGivenDefaultHeight ? `${sel.buildingsGivenDefaultHeight} building${sel.buildingsGivenDefaultHeight === 1 ? '' : 's'} with no measured height at all, shown at ${PLAUSIBLE_DEFAULT_HEIGHT_M} m (generated)` : '',
                    sel.buildingsWithNoFootprint ? `${sel.buildingsWithNoFootprint} building${sel.buildingsWithNoFootprint === 1 ? '' : 's'} with no footprint shape and no Google volume left out` : ''
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

        // ---------------- tiles ----------------
        type TilesValue = { extraction: StagedExtraction; key: string; sizedTo: 'structure' | 'request' | 'district-fallback'; structure?: StructurePickResult; ground?: GroundModel; scan?: ScanMesh; unmaskedTop?: Float32Array; canopy?: CanopyMask; vector?: EvidenceLookup; vectorError?: string; rounds: number; cached: boolean; builtAtMs: number };
        /** One extraction, cached for 7 days by place and radius; the entry holds its files, named relative to it. */
        const extractCached = async (radiusM: number, io: StageIO): Promise<{ extraction: StagedExtraction; key: string; cached: boolean; builtAtMs: number }> => {
            const key = stageKey('extract/v2', placeValue!.lat.toFixed(6), placeValue!.lng.toFixed(6), Math.round(radiusM));
            const inEntry = (dir: string, v: StagedExtraction): StagedExtraction => ({ ...v, texturedGlb: path.join(dir, v.texturedGlb), geometryGlb: path.join(dir, v.geometryGlb) });
            const hit = !bypass('tiles') ? cache.get<StagedExtraction>('tiles', key) : undefined;
            if (hit && now() - hit.builtAtMs < EXTRACTION_TTL_MS) {
                const v = inEntry(hit.dir, hit.value);
                if (fs.existsSync(v.texturedGlb) && fs.existsSync(v.geometryGlb)) return { extraction: v, key, cached: true, builtAtMs: hit.builtAtMs };
            }
            const entry = await cache.run('tiles', key, async dir => {
                const x = await deps.extract({ lat: placeValue!.lat, lng: placeValue!.lng, radiusM, outDir: dir, place: placeValue!, signal: io.signal, onProgress: m => io.progress(m) });
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
                        onProgress: m => io.progress(m), signal: io.signal
                    });
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
                    const x = await extractCached(request.radiusM ?? 250, io);
                    value = { extraction: x.extraction, key: x.key, sizedTo: 'request', rounds: 1, cached: x.cached, builtAtMs: x.builtAtMs };
                }
                // L1: the extraction as downloaded, geometry only, with the run's fixed camera
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
                    if (vf?.used) run.note(PROVENANCE.remeshed, `footprint from Google vector data: building ${vf.featureIds.join(', ')} (${Math.round(vf.areaM2)} m²), ${Math.round(vf.raisedShare * 100)}% of it raised in the scan, ${Math.round(vf.openShare * 100)}% open ground, ${Math.round(vf.canopyShare * 100)}% tree canopy${vf.enclosesStructure ? ' (larger than the structure: it encloses it)' : ''}; the scan's raised cells within ${FOOTPRINT_TOLERANCE_M} m of it are the structure (IoU ${vf.iou} with the footprint)`);
                    else run.note(PROVENANCE.remeshed, `footprint from the scan's geometry alone: ${vf?.reason ?? (value.vectorError ? `Google vector data could not be read (${value.vectorError})` : 'no Google vector data was available')}`);
                }
                // the cap on leaf tiles can stop a large request short: the scan reaches less far than asked, and says so
                if (e.truncated && e.coveredRadiusM < e.radiusM - 0.5) {
                    const asked = Math.round(e.radiusM), covered = Math.round(e.coveredRadiusM);
                    run.degrade(record('tiles', 'radius_truncated', {
                        part: { description: `the outer ring of the extraction (${covered} to ${asked} m)` }, intended: `every leaf tile within ${asked} m of the place`,
                        fellTo: `the nearest ${e.leafTiles} leaf tiles, which reach ${covered} m`, provenanceAfter: PROVENANCE.asScanned,
                        reason: `more leaf tiles lie within ${asked} m than the build keeps (the nearest ${e.leafTiles}), so the scan reaches ${covered} m, not the ${asked} m asked for`,
                        transient: false, runId, now: now()
                    }));
                }
                const degradations = run.state.degradations.filter(d => d.stage === 'tiles');
                return {
                    status: degradations.length ? 'degraded' : 'committed', value,
                    source: `${e.leafTiles} leaf tiles within ${Math.round(e.coveredRadiusM)} m${value.sizedTo === 'structure' ? ` (sized to the structure: ${Math.round(e.radiusM)} m, ${value.rounds} round${value.rounds === 1 ? '' : 's'})` : ''}`,
                    layers: [layer], degradations, cached: value.cached, builtAtMs: value.builtAtMs
                };
            },
            hardFail: err => new StagedLocationHardFailure('tiles', 'no_tile_coverage', `No Photorealistic 3D Tiles could be extracted at ${placeValue!.formattedAddress}: ${errorMessage(err)}`)
        });
        persist();
        tilesSettle(tiles.value ? { extraction: tiles.value.extraction, key: tiles.value.key } : undefined);
        if (tiles.status === 'stopped' || !tiles.value) throw new StagedLocationHardFailure('tiles', 'run_deadline', `The run reached its time limit before any tiles were extracted, so there is nothing to show.`);
        const t = tiles.value;
        const extraction = t.extraction;
        const structure = request.isolate && t.sizedTo === 'structure' ? t.structure : undefined;
        const isolateMode = !!structure;

        // ---------------- terrain (starts now and runs beside everything else; needs only the extraction's frame) ----------------
        if (!deps.elevation) {
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
        // pipeline E (SCRATCHBOX_STAGED_PIPELINE=e, off by default): the structure from the vector massing; it needs the
        // building's vector footprint, else the current pipeline runs and the reason is recorded
        const pipelineE = stagedPipelineE() && request.isolate;
        const eBuildings = structure?.vectorFootprint?.used && t.vector ? t.vector.raster.buildings.filter(b => structure.vectorFootprint!.featureIds.includes(b.id)) : [];
        // the shape program trial (SCRATCHBOX_STAGED_SHAPE_PROGRAM) shapes from the tree-free scan: a vector footprint only
        // bounds the height map where the two agree, so a footprint that disagrees (or none) does not send the build back
        const shapeMode = pipelineE ? stagedShapeProgram() : undefined;
        const shapeFootprint = t.vector && structure?.vectorFootprint?.featureIds?.length ? t.vector.raster.buildings.filter(b => structure.vectorFootprint!.featureIds.includes(b.id)) : [];
        const eWhyNot = !pipelineE ? undefined : !isolateMode ? 'the structure could not be isolated' : !eBuildings.length && !shapeMode ? `the structure's footprint did not come from Google vector data (${structure?.vectorFootprint?.reason ?? 'no vector footprint at the place'})` : undefined;
        const eEligible = pipelineE && !eWhyNot;
        const startSurvey = (): void => {
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
                    let result: SurveyResult;
                    const chain = new VisionModelChain<string>({ client: visionForSurvey.client, candidates: visionForSurvey.candidates, signal: ctx.signal, ...chainExtras('survey'), ...(deps.sleep ? { sleep: deps.sleep } : {}) });
                    try {
                        result = await runFaceSurvey({
                            faces, panos: found.panos, structure: structure!, ground: t.ground!, top: t.unmaskedTop ?? t.ground!.top, deps: sv, chain, signal: io.signal, onProgress: m => io.progress(m), now,
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
        /** Resolved once the rebuild has decided its Street View close-ups (evidencePromise is set, or none will come). */
        let evidenceDecided = deferred<void>();
        /** Resolved once the fit stage has returned (its charts are known), or the rebuild ended without one. */
        let fitDecided = deferred<void>();
        /** tile_refine's photo-textured output per committed remesh layer (the source of a district's twins). */
        const refineTextured = new Map<string, string>();
        type TexTarget = { layer: StagedLayer; file: string; surfaces?: Array<{ id: string; chart: any }>; late?: boolean };
        type TexOutcome = {
            layer: StagedLayer; out: Omit<TextureLayerOutcome, 'glb' | 'measureLoo'>; url: string; bytes: number; cached: boolean; builtAtMs: number;
            surfaces: string; late: boolean; sources: 'tile' | 'street-view' | 'tile-refine'; streetViewTried?: boolean
        };
        const startTextures = (): void => {
            if (texturesPromise) return;
            if (deps.textures?.disabled) { runner.skip('textures', deps.textures.disabled); runner.skip('textures-late', deps.textures.disabled); return; }
            // a district (or a structure tile_refine could not isolate) is textured with tile_refine's own photo
            const mode: 'texture-pass' | 'tile-refine' = isolateOk ? 'texture-pass' : 'tile-refine';
            const texStarted = now();
            const pass = { rebuild: rebuildPromise, grammar: grammarGate.settled };
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
            const timed = (into: Record<string, number>) => async <R>(k: string, work: () => Promise<R>): Promise<R> => { const t0 = now(); try { return await work(); } finally { into[k] = (into[k] ?? 0) + now() - t0; } };
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
                    if (mode === 'tile-refine' && !refineTextured.has(l.objectId)) return false;
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
                const { tile, tileUnavailable, tileSha, occluder, context, wideViews } = src.prepared;
                const key = stageKey(TEXTURE_PASS_VERSION, target.layer.layer, sha256Bytes(clay), src.imagesSha, src.wideSha, src.poseHash, tileSha, src.palette, !!enhance, deps.textures?.enhanceMode ?? 'recreate', src.density, deps.textures?.maxSide ?? 2048, surfacesKey(target.surfaces), ...(!(rebuildOut.refit ?? rebuildOut.fit) && views.length ? ['no-fit-held-out-gate/2'] : []), ...(lightingClient && views.length ? [`light:${lightingModelIds.join(',')}:${lightingPromptVariant()}:${src.lightingViews?.length ?? 0}`] : []), ...(arm.key ? [arm.key] : []), ...(src.ownershipKey ? [src.ownershipKey] : []), ...(src.temporaryKey ? [src.temporaryKey] : []), src.materialsKey);
                let loo: NonNullable<TextureLayerOutcome['measureLoo']> | undefined;
                const entry = await cache.run<Omit<TextureLayerOutcome, 'glb'>>('textures', key, async dir => {
                    const run1 = (bakeViews: ProjectionView[], bakeUnavailable: string | undefined) => (texturePool ? texturePool.textureLayer.bind(texturePool) : textureLayer)({ layerKey: target.layer.layer, clayGlb: clay, ...(target.surfaces?.length ? { surfaces: target.surfaces } : {}) }, {
                        views: bakeViews, ...(wideViews.length && bakeViews.length ? { photoTierViews: wideViews } : {}), ...(photoTierEnabled() ? { photoTier: true } : {}), ...(bakeUnavailable ? { viewsUnavailable: bakeUnavailable } : {}), occluder,
                        ...(src.materials ? { materials: src.materials } : {}), ...(src.materialsUnavailable ? { materialsUnavailable: src.materialsUnavailable } : {}), ...(context.indices.length ? { context } : {}), observedSurface: TEXTURE_OBSERVED_SURFACE, poseEdgeGuardShare: TEXTURE_POSE_EDGE_GUARD_SHARE,
                        delight: { latitude: run.geoAnchor.lat, longitude: run.geoAnchor.lng },
                        ...(tile ? { tile } : {}), ...(tileUnavailable ? { tileUnavailable } : {}),
                        ...(src.residual !== undefined ? { registrationResidualM: src.residual } : {}),
                        ...(enhance ? { enhance: { client: enhance, ...(deps.textures?.enhanceModels ? { models: deps.textures.enhanceModels } : {}), ...(deps.textures?.enhanceMode ? { mode: deps.textures.enhanceMode } : {}) } } : { enhanceUnavailable: 'no image model client is configured for it' }),
                        ...(src.lightingViews?.length ? { lightingViews: src.lightingViews } : {}), ...(lightingClient && bakeViews.length ? { lighting: { client: lightingClient, models: lightingModelIds } } : {}), ...(src.lightingUnavailable ? { lightingUnavailable: src.lightingUnavailable } : {}),
                        palette: src.palette, densityTexelsPerMeter: src.density, maxSide: deps.textures?.maxSide ?? 2048, signal: io.signal,
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
            const textureFromRefine = async (target: TexTarget, stage: StageId) => {
                const src = refineTextured.get(target.layer.objectId)!;
                let bytes: Uint8Array = fs.readFileSync(src);
                // a district staged around a kept structure: its twin loses the structure's footprint as its clay layer did
                const carvedBy = CARVED_URL.test(target.layer.url) ? FOOTPRINT_REPORTS.get(run)?.footprint : undefined;
                if (carvedBy) bytes = hideFootprintInGlb(bytes, carvedBy).glb;
                const key = stageKey(TILE_REFINE_TWIN_VERSION, target.layer.layer, sha256Bytes(bytes));
                const entry = await cache.run<{ rungShares: number[]; provenance: TileRefineTwin['provenance']; ladderRung: number; triangles: number }>('textures', key, async dir => {
                    const twin = tileRefineTwin(bytes, target.layer.layer);
                    fs.writeFileSync(path.join(dir, 'twin.glb'), twin.glb);
                    return { value: { rungShares: twin.rungShares, provenance: twin.provenance, ladderRung: twin.ladderRung, triangles: twin.triangles } };
                }, { publish: () => [{ from: 'twin.glb', as: `${base}_${target.layer.layer}_tex_${key.slice(0, 8)}.glb` }], bypass: bypass('textures') });
                const pub = entry.published[0];
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
                        await step('tileRefineTwins', () => Promise.all(targets.map(t => withSlot(() => textureFromRefine(t, 'textures')))));
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
                        if (mode === 'tile-refine') { await withSlot(() => textureFromRefine(t, 'textures-late')); return; }
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
        if (request.trees) {
            // (the structure picked stays as scanned: a tree taken out beside it never takes its roof or walls along)
            const keep = structure && t.ground ? structureKeepCells(structure, t.ground) : undefined;
            const roi: StripRoi | undefined = structure ? { schema: 'scratchbox.strip-roi/1', polygon: grownOutline(structure.outline, ISOLATE_TREE_REACH_M), ...(keep ? { keep } : {}) } : undefined;
            const measured = await runner.stage<TileVegetationStripResult>({
                id: 'trees-measure',
                run: async io => {
                    const r = await deps.vegetation.strip({ tilePath: extraction.texturedGlb, signal: io.signal, ...(roi ? { roi } : {}) });
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
            runner.skip('trees-measure', 'trees were not asked for');
        }

        // ---------------- roads (SB-Roadie: Google's road centrelines measured kerb to kerb on the tree-stripped scan; runs beside the remesh) ----------------
        let roadsMeasured: RoadSurface[] | undefined;
        type RoadStageValue = { stats: RoadMesh['stats']; measuredKerbShare: number; photo: { width: number; height: number; texelM: number; ms: number }; markings?: { runs: number; markings: number; dashed: number; solid: number } } | undefined;
        const roadsPromise: Promise<unknown> = (async () => {
            if (!sbRoadieEnabled()) { runner.skip('roads', 'SB-Roadie is shelved for now (SCRATCHBOX_STAGED_ROADS=1 to try it)'); return; }
            const covered = extraction.coveredRadiusM;
            // the vector evidence the sizing fetched (an isolate), else fetched now for the extraction's cover (a district)
            let vector = t.vector;
            if (!vector && deps.vectorEvidence) {
                try { vector = evidenceLookup(await deps.vectorEvidence({ lat: placeValue!.lat, lng: placeValue!.lng, radiusM: covered + 20 }), covered + 20); }
                catch (err) { if (isAbort(err)) throw err; runner.skip('roads', `no Google vector data (${errorMessage(err)})`); return; }
            }
            if (!vector) { runner.skip('roads', t.vectorError ? `no Google vector data (${t.vectorError})` : 'no Google vector data: no service account is configured for vectortiles.featuretiles'); return; }
            const centrelines = vector.raster.roads.filter(l => l.some(([x, z]) => Math.hypot(x, z) <= covered));
            if (!centrelines.length) { runner.skip('roads', 'no road centreline from Google vector data runs through the extraction'); return; }
            await runner.stage<RoadStageValue>({
                id: 'roads',
                run: async io => {
                    const tileForRoads = strip ? strip.devegetatedGlb : extraction.texturedGlb;
                    const key = stageKey('roads/v5', t.key, strip ? strip.cacheKey : 'scan', crypto.createHash('sha256').update(JSON.stringify(centrelines)).digest('hex').slice(0, 16), covered.toFixed(1), ROAD_SURFACE_PARAMS.liftM);
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
                        });
                        if (!roads.length) return { value: undefined, inputs: { centrelines: centrelines.length, covered, noRoadResurfaced: true } };
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
                }
            }).catch(err => {
                if (err?.name === 'AbortError') throw err;
                run.emit('roads', 'failed', { reason: errorMessage(err) });
                return undefined;
            });
        })();
        siblings.push(roadsPromise);

        // ---------------- remesh ----------------
        // facade grammar: on by flag, with a vision model, on a relief that runs
        const grammarOn = facadeGrammarEnabled() && !!visionAvailable && (request.relief ?? TILE_REFINE_RELIEF_DEFAULT) !== false;
        let remeshRequest: TileRefineRequest | undefined;
        type RemeshValue = { refined?: TileRefineResult; flattened?: ScanFitFlattenResult; groundLayerId: string; groundFile: string; committed: boolean };
        let eState: { stage: MassingStageResult; refined: TileRefineResult; layer: StagedLayer; key: string; ms: number } | undefined;
        /** The ownership vote to run after the first isolate commits: what it needs to remesh the same structure again. */
        let voteLater: { tilePath: string; isolatePick?: string; pick?: { pick: StructurePickResult; ground: GroundModel }; request: TileRefineRequest; orthos: { reliefOrthos?: boolean } } | undefined;
        /** The residual audit of one pipeline E native run, into the build notes (and a degradation when it failed or left clusters unsure). */
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
                const key = stageKey(PIPELINE_E_VERSION, refined.cacheKey, sha256File(tilePath).slice(0, 16), sha256Bytes(Buffer.from(JSON.stringify({ eBuildings, solar }))), ...(shapeMode ? [SHAPE_STAGE_VERSION, shapeMode, request.query.trim()] : []));
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
                const r = await runMassingStage({ tilePath, isolateGlb: refined.rawClayGlb, buildings: eBuildings, groundY: picked.pick.groundY, scanTop, cells: picked.pick.cells, solar, outDir: dir, signal: io.signal, ...(shapeMassing ? { massing: shapeMassing } : {}) }, 'remesh', key);
                cache.writeRunNote(runId, 'pipeline_e', { check: r.massing.check, solar: r.massing.solar, solarNote, notes: r.massing.notes, timingsMs: r.timingsMs, native: r.run ? { timingsMs: r.run.report.timingsMs, snap: r.run.report.snap, residual: r.run.report.residual, faces: r.run.report.faces.length } : undefined });
                const c = r.massing.check;
                if (!c.ok || !r.run || !r.files) return fallBack('pipeline_e_fallback', `${c.reason ?? 'the massing could not be built'} (plan IoU ${c.iou}, roof ${c.heightErrMedianM} m off the scan, median; ${c.heightErrP90M} m at the 90th percentile)`);
                run.keys.remesh = key;
                run.cacheStatus.remesh = 'miss';
                const key8 = key.slice(0, 8);
                const pubClay = cache.publishFile(r.files.clayGlb, `${base}_massing_${key8}.glb`);
                const pubTex = cache.publishFile(r.files.texturedGlb, `${base}_massing_${key8}_tex.glb`);
                const l1 = run.state.layers.find(l => l.layer === 'l1')!;
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
                    textured: {
                        url: pubTex.url, bytes: pubTex.bytes, ladderRung: r.files.texturedShares.findIndex((_, k, a) => a.slice(k + 1).reduce((x, y) => x + y, 0) <= 0.1),
                        rungShares: r.files.texturedShares, provenance: legend.map(e => ({ source: e.source, label: e.label, method: e.method, coverage: 0 })),
                        confidenceChannels: 'R = index into provenance[], G = weight 0..255, B = ladder rung (TEXTURE_LADDER_RUNGS), A = 255 where a stage produced the texel', builtAtMs: now(), cached: false
                    }
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
                const timed = async <R>(k: string, work: () => Promise<R>): Promise<R> => { const t0 = now(); try { return await work(); } finally { remeshMs[k] = (remeshMs[k] ?? 0) + now() - t0; } };
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
                // the facades' orthophotos for the grammar reading (facade-grammar.ts), only when it will run
                const orthos = grammarOn ? { reliefOrthos: true } : {};
                if (isolateMode && deps.refine.renderOwnershipViews && visionAvailable) voteLater = { tilePath, ...(isolatePick ? { isolatePick } : {}), ...(remeshPick ? { pick: remeshPick } : {}), request: remeshRequest, orthos };
                let r = await timed('tileRefine', () => deps.refine.refine({ ...remeshRequest!, ...orthos }));
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
                const l1 = run.state.layers.find(l => l.layer === 'l1')!;
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
                const l1 = run.state.layers.find(l => l.layer === 'l1')!;
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
                run: async io => {
                    const msBy: Record<string, number> = {};
                    const timed = async <R>(k: string, work: () => Promise<R>): Promise<R> => { const t0 = now(); try { return await work(); } finally { msBy[k] = (msBy[k] ?? 0) + now() - t0; } };
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
                            seg = await timed('ownershipVision', () => segmentOwnershipViews({ viewsDir: views.dir, masksDir, target: request.query.trim(), chain, concurrency: 12, onProgress: m => io.progress(m) }));
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
                    const voted = await timed('tileRefine', () => deps.refine.refine({ ...votedRequest, ...v.orthos }));
                    const picked = v.pick?.pick ?? structure!;
                    const terrain = v.pick?.ground ?? t.ground;
                    if (!voted.rawClayGlb || !terrain) return notUsed('ownership_vote_not_used', 'tile_refine wrote no voted isolate to check; the geometric isolate stands');
                    const chk = checkIsolate(voted.rawClayGlb, picked, terrain);
                    if (!chk.ok) return notUsed('ownership_vote_not_used', `the voted isolate is not the structure picked (${Math.round(chk.recall * 100)}% of the pick covered, ${Math.round(chk.precision * 100)}% of it on the pick, ${Math.round(chk.roofed * 100)}% roofed); the geometric isolate stands`);
                    // how much the vote moved: compared on the isolates' raw scan triangles (a first isolate that fell back to the district is replaced outright)
                    const change = firstWasIsolate && first.rawClayGlb ? ownershipChange(first.rawClayGlb, voted.rawClayGlb) : undefined;
                    const moved = change ? `${round(change.share * 100, 1)}% of the structure's scan surface (${round(change.onlySecondM2, 1)} m² joined, ${round(change.onlyFirstM2, 1)} m² left)` : 'the first isolate had fallen back to the district around the structure';
                    const notVoted = seg.skipped.filter(x => !seg.cut?.views.includes(x.view));
                    run.note(PROVENANCE.remeshed, `object ownership: ${seg.model ?? 'the vision model'} outlined the structure in ${seg.masks} of ${seg.views} views of the tile${seg.cut ? ` (${seg.cut.note})` : ''}${notVoted.length ? ` (no vote from ${notVoted.map(x => `${x.view}: ${x.reason}`).join('; ')})` : ''}${readBack ? ` (${readBack})` : ''}; the vote moved ${moved}`);
                    if (change && !change.material) {
                        return {
                            status: 'committed', value: { material: false, request: votedRequest, isolateOk: true }, breakdownMs: msBy,
                            source: `the vote moved ${moved}, under the ${Math.round(OWNERSHIP_MATERIAL_SHARE * 100)}% that would replace the geometric isolate; the first isolate and everything built on it stand (the vote's own remesh is not shown)`
                        };
                    }
                    // material: the voted remesh replaces the first isolate and what was built on it (the rebuild runs again on it)
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
                            method: `tile_refine with the multi-view ownership vote: ${seg.model ?? 'the vision model'}'s outlines in ${seg.masks} views decide the raised triangles near the structure, the geometric rules the rest`,
                            sources: [{ kind: 'stage-output', id: `remesh:${key8}` }], note: `the vote moved ${moved}; it replaces the first isolate and the rebuild runs again on it`
                        },
                        provenanceLabels: [PROVENANCE.remeshed, ...((prov.summary.proudBlocks?.keptAsScannedVertices ?? 0) > 0 ? [PROVENANCE.asScanned] : []), ...(carved > 0 ? [PROVENANCE.photoInferred] : [])],
                        vertexProvenance: prov.summary, supersedes: [firstLayer.objectId, ...builtOnFirst], revealAfter: [],
                        reveal: { durationMs: 800, stagger: 0, crossfadeFrom: [firstLayer.objectId, ...builtOnFirst] }, cached: voted.cached, builtAtMs: remembered.builtAtMs, counts
                    };
                    run.commit(layer, { source: 'Google3DTilesClay', resolvedAddress: placeValue!.formattedAddress, extra: { rawGlbPath: extraction.rawGlbPath ?? extraction.texturedGlb, treesRemoved: Number(strip?.stats?.triangles?.removed ?? 0) > 0 } });
                    run.setGround(layer.objectId);
                    refineTextured.set(layer.objectId, voted.texturedGlb);
                    // what this pass still has running on the first isolate is set aside: the next pass builds it on the voted remesh
                    passStop.abort('the ownership vote replaced the first isolate, so this stage runs again on the voted remesh');
                    run.state.structure = { ...run.state.structure!, isolateIoU: round(chk.iou, 3), isolateAgreement: round(chk.agreement, 3) };
                    return {
                        status: 'committed', value: { material: true, refined: voted, request: votedRequest, isolateOk: true, layer }, layers: [layer], breakdownMs: msBy, cached: voted.cached,
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
                                site: { structure: structure!, ground: t.ground!, unmaskedTop: t.unmaskedTop ?? t.ground!.top }, panos: usable, maxViews: ENHANCE_STREET_VIEWS, streetLevel: true,
                                sv: { ...sv, refusedPanos: sv.refusedPanos ?? new Map<string, string>() }, tileMeshFiles: [extraction.geometryGlb], structureMesh,
                                context, segment: segmenter, ...(visionAvailable ? { target: request.query } : {}),
                                ...(process.env.SCRATCHBOX_OWNERSHIP_DEBUG_DIR ? { debugDir: path.join(process.env.SCRATCHBOX_OWNERSHIP_DEBUG_DIR, runId, 'survey') } : {}),
                                signal: io.signal, onProgress: m => io.progress(`pipeline E: Street View: ${m}`)
                            });
                            if (got.images.length) run.state.attribution = [...new Set([...run.state.attribution, 'Street View ©Google'])];
                            cache.writeRunNote(runId, 'pipeline_e_enhance_streetview', {
                                views: got.views.map(v => ({ panoId: v.panoId, faceId: v.faceId, registration: v.registration, ownership: v.ownership?.status, prompts: v.ownership?.prompts, iou: v.ownership?.iou, ownedPixels: v.ownerMask?.reduce((a, x) => a + (x ? 1 : 0), 0) ?? 0, occluders: v.ownership?.occluders })),
                                refusals: got.refusals, failures: got.failures, registrationError: got.registrationError, registration: got.registration, ms: got.ms, panosNear: usable.length, contextCut: context !== tileMesh
                            });
                            cache.writeRunNote(runId, 'pipeline_e_ownership', { records: got.views.map(v => v.ownership).filter(Boolean), panos: got.images.map(i => i.view.panoId) });
                            return got;
                        })();
                        return survey;
                    } : undefined;
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
                            rungShares: out.files.texturedShares, provenance: out.legend.map(x => ({ source: x.source, label: x.label, method: x.method, coverage: 0, ...(x.chamferPx !== undefined ? { chamferPx: x.chamferPx } : {}), ...(x.lostShare !== undefined ? { lostShare: x.lostShare } : {}) })),
                            confidenceChannels: 'R = index into provenance[], G = weight 0..255, B = ladder rung (TEXTURE_LADDER_RUNGS), A = 255 where a stage produced the texel', builtAtMs: now(), cached: false
                        }
                    };
                    run.commit(layer, { source: 'Google3DTilesClay', resolvedAddress: placeValue!.formattedAddress, extra: { pipeline: 'e' } });
                    run.note(PROVENANCE.photoInferred, `pipeline E inference: ${describe}`);
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
                            rungShares: files.texturedShares, provenance: (inf?.out.legend ?? r.legend!).map(x => ({ source: x.source, label: x.label, method: x.method, coverage: 0, ...(x.chamferPx !== undefined ? { chamferPx: x.chamferPx } : {}), ...(x.lostShare !== undefined ? { lostShare: x.lostShare } : {}) })),
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
            if (eState) { const inf = await eInferenceRun(eState); await eReliefRun(eState, inf); return; }
            runner.skip('relief', 'the measured relief runs on pipeline E\'s clean massing (SCRATCHBOX_STAGED_PIPELINE=e)');
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
                            value.refine = { cacheKey: r.cacheKey, clayGlb: r.clayGlb, texturedGlb: r.texturedGlb, stats: { relief: { grammar: r.stats?.relief?.grammar ?? [], lattices: (r.stats?.relief?.lattices ?? []).filter((l: any) => l.grammar) } }, ms: r.ms };
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

        // ---------------- trees (plant) ‖ the rebuild ----------------
        const treesRun = async (): Promise<{ trees?: LocationClayTrees; putBack?: { triangles: number; crowns: number; reason: string } }> => {
            const remeshed = remeshedNow;
            if (!request.trees) { runner.skip('trees', 'trees were not asked for'); return {}; }
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
                    const crowns = JSON.parse(fs.readFileSync(strip!.crownsJson, 'utf8')).crowns ?? [];
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
                const why = 'pipeline E built the structure from the vector massing (SCRATCHBOX_STAGED_PIPELINE=e)';
                skipRest(why);
                runner.skip('survey', why);
                runner.skip('textures', 'pipeline E textures its faces from orthographic renders of the tile photo');
                runner.skip('textures-late', 'pipeline E textures its faces from orthographic renders of the tile photo');
                return out;
            }
            if (!isolateMode) { skipRest('the structure could not be isolated, so it is shown without a rebuild'); return out; }
            if (!remeshed) { skipRest('the remesh failed, so there is no isolated scan to fit'); return out; }
            if (!isolateOk) { skipRest('tile_refine isolated a different structure than the one picked'); return out; }
            out.sourceLimits = measureSourceLimits(t.scan ?? loadScanMesh(extraction.texturedGlb), extraction.leafGeometricErrorM, structure!.cells);
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
        return finishRun(run, {
            request, place: placeValue, extraction, structure, sizedTo: t.sizedTo, remeshed: remeshedNow, groundFile: groundOverride?.groundFile ?? remesh.value?.groundFile, groundLayerId: groundOverride?.groundLayerId ?? remesh.value?.groundLayerId ?? run.state.layers.find(l => l.layer === 'l1')?.objectId,
            trees: treesOut.trees, putBack: treesOut.putBack, rebuild, strip, ...(textureValue ? { textures: textureValue } : {}), now, persist
        });
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
        throw err;
    }
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

interface FinishInput {
    request: StagedLocationRequest;
    place: ResolvedPlace;
    extraction: StagedExtraction;
    structure?: StructurePickResult;
    sizedTo: 'structure' | 'request' | 'district-fallback';
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
    f.persist();
    run.close();
    return {
        result,
        compat: {
            remesh: f.remeshed ? { ok: true, url: remeshLayer?.url } : { ok: false, error: (run.state.degradations.find(d => d.stage === 'remesh' && d.reasonCode === 'remesh_failed') ?? run.state.degradations.find(d => d.stage === 'remesh'))?.reason ?? 'the remesh did not run' },
            resolvedAddress: f.place.formattedAddress,
            geoAnchor: f.extraction.geoAnchor,
            glbPath: f.extraction.rawGlbPath ?? f.extraction.texturedGlb,
            ...(f.groundFile ? { groundGlbPath: f.groundFile } : {}),
            ...(f.trees ? { trees: f.trees } : {})
        }
    };
}

