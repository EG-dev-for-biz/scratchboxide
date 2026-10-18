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
    type StagedLayer,
    type StagedLocationResult,
    type StripRoi,
    type VisionModelUse
} from '../../../common/spatial/staged-location-contracts';
import { glbMeshCounts, plantTrees, summarizeTrees, type LocationClayTrees } from '../location-clay-pipeline';
import { TileVegetationError, type TileVegetationPlantRequest, type TileVegetationPlantResult, type TileVegetationStripRequest, type TileVegetationStripResult } from '../tile-vegetation-service';
import type { TileRefineRequest, TileRefineResult } from '../tile-refine-service';
import { VisionModelChain, type VisionGenAIClient } from '../../gemini/vision-model-chain';
import { loadScanMesh, type GeodeticOrigin, type GroundModel, type ScanMesh } from '../../spatial/StreetViewSurveyPlanner';
import { readGlbScene, sceneToRenderMesh } from '../../spatial/StreetViewPoseRegistrar';
import type { RenderMesh3D } from '../../spatial/HeadlessMeshSilhouetteRenderer';
import { StageCache, sha256File, stageKey, stagedReplyCache, type CachedStage } from './stage-cache';
import {
    composeStagedArtifact, glbBounds, layerObjectId, retireSupersededLayers, stagedArtifactId, stagedCamera,
    type StagedCamera, type StagedLayerObjectMeta
} from './staged-artifact';
import { describeRemeshProvenance, readRemeshProvenance } from './remesh-provenance';
import { putBackScannedTrees } from './scanned-trees';
import {
    footprintIoU, grownOutline, isolatedStructureCells, sizeExtraction, ISOLATE_IOU_MIN, NO_STRUCTURE_DISTRICT_RADIUS_M, type StructurePickResult
} from './extraction-sizing';
import {
    discoverPanos, facadeGeometry, fetchViews, missingCredentials, EVIDENCE_STAGE_BUDGET_MS, type EvidenceImage, type PanoCandidate, type StreetViewEvidenceDeps
} from './streetview-evidence';
import { selectViewsForFit } from './evidence-aim';
import { describeSurvey, runFaceSurvey, surveyCandidates, surveyFaceTargets, surveyImageBytes, SURVEY_IMAGE_TIMEOUT_MS, SURVEY_VISION_TIMEOUT_MS, type SurveyResult } from './face-survey';
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
import { prepareTextureSources, type TextureSourcesInput } from './texture-sources';
import { TextureWorkerPool, textureWorkersEnabled } from './texture-worker-pool';
import { eventLoopStats, runBlockTracer } from './event-loop-stats';
import type { EnhanceModelClient } from './texture-enhance';
import { CONFIDENCE_CHANNELS } from './staged-glb-writer';
import { TEXTURE_LADDER_RUNGS, type TexturePassDegradation, type TexturePassRecord, type TextureLayerBundle } from '../../../common/spatial/texture-pass-contracts';

/** What the evidence stage spent: free metadata queries, billed images and the seconds the images took. */
export interface EvidenceCost { metadataCalls: number; cachedCalls: number; imagesRequested: number; imagesFetched: number; fetchMs: number }
const NO_EVIDENCE_COST: EvidenceCost = { metadataCalls: 0, cachedCalls: 0, imagesRequested: 0, imagesFetched: 0, fetchMs: 0 };

// ----------------------------------------------------------------------------------------------------------------
// stages
// ----------------------------------------------------------------------------------------------------------------

/** The focused run readings get at most this long after the wide reading (and less when the wide reading ran long). */
export const VISION_RUNS_ALLOWANCE_MS = 120_000;
/** What the vision stage keeps back from its limit: the merge, the cache write and the records after the readings. */
export const VISION_STAGE_MARGIN_MS = 20_000;
/** Below this, the focused run readings are not started: there is no time for a call to answer. */
const MIN_RUNS_WINDOW_MS = 30_000;

/** Canonical order (-1: no layer), overlay title and per-stage time limit. */
export const STAGES = {
    resolve: { order: -1, title: 'Place', budgetMs: 10_000 },
    tiles: { order: 1, title: 'Google 3D Tiles', budgetMs: 360_000 },
    survey: { order: -1, title: 'Surveying the four faces', budgetMs: EVIDENCE_DISCOVERY_ALLOWANCE_MS + SURVEY_IMAGE_TIMEOUT_MS + SURVEY_VISION_TIMEOUT_MS + 15_000 },
    evidence: { order: -1, title: 'Street View close-ups', budgetMs: EVIDENCE_STAGE_BUDGET_MS + 30_000 + MATCH_TIMEOUT_MS + 60_000 + EDGE_REGISTRATION_BUDGET_MS + 15_000 + JOINT_REGISTRATION_BUDGET_MS + 30_000 },
    'trees-measure': { order: -1, title: 'Measuring the trees', budgetMs: 300_000 },
    remesh: { order: 2, title: 'Remeshed scan', budgetMs: 300_000 },
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
    /**
     * Background: the real-world texture pass (textured twins of the staged layers); clay stays the first result. The
     * limit covers the first layers (about 2 to 3 min live) plus the wait for the photo-read detail the rebuild commits
     * later (about 4 min after the Street View close-ups live), whose layers are textured once it settles.
     */
    textures: { order: -1, title: 'Real textures', budgetMs: 600_000 }
} as const;
export type StageId = keyof typeof STAGES;
export const STAGE_IDS = Object.keys(STAGES) as StageId[];

/** The tool's budget is 40 minutes; the run stops starting stages 2 minutes before it. */
export const RUN_BUDGET_MS = 38 * 60_000;
export const RUN_DEADLINE_MARGIN_MS = 120_000;
/** Layers the texture pass works on at once. */
export const TEXTURE_LAYER_CONCURRENCY = 3;
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
    /** Extracts the leaves within radiusM of (lat, lng) into `outDir` (textured.glb, geometry.glb). */
    extract(req: { lat: number; lng: number; radiusM: number; outDir: string; place: ResolvedPlace; signal?: AbortSignal; onProgress?: (message: string) => void }): Promise<StagedExtraction>;
    vegetation: {
        strip(req: TileVegetationStripRequest & { roi?: StripRoi }): Promise<TileVegetationStripResult>;
        plant(req: TileVegetationPlantRequest): Promise<TileVegetationPlantResult>;
        /** tile_vegetation's canopy classifier; absent until the engine has it. */
        canopy?(req: { tilePath: string; cellM?: number; signal?: AbortSignal }): Promise<{ mask: CanopyMask; cached: boolean; ms: number }>;
    };
    refine: { refine(req: TileRefineRequest): Promise<TileRefineResult> };
    /** The scan fitter; absent until the engine has it (then the rebuild stages degrade and say so). */
    scanFit?: ScanFitDeps;
    /** Why scanFit is absent (shown to the user). */
    scanFitUnavailable?: string;
    streetView?: StreetViewEvidenceDeps;
    /** The vision model client and the models to try (the staged default first); or why there is none. */
    vision?: { client: VisionGenAIClient; candidates: string[] } | { unavailable: string };
    /** Builds a figure spec natively and returns its GLB (metres, +Y up, front +Z, origin at the centre of its base); the reference object builder's native build by default. */
    figureBuilder?: (spec: ObjectBuildSpec, signal?: AbortSignal) => Promise<{ glb: Buffer }>;
    /**
     * The texture pass's optional model enhancement of the tile transfer (an image model, edge-gated); absent = that
     * rung is not attempted (tests, or no client). `densityTexelsPerMeter` caps the atlas density (default 20, 5 cm).
     */
    textures?: { enhance?: EnhanceModelClient; enhanceModels?: string[]; maxDensityTexelsPerMeter?: number; maxSide?: number; disabled?: string };
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
        const used = new Set<ProvenanceLabel>([...this.state.layers.filter(l => !l.retired).flatMap(l => l.provenanceLabels), ...this.state.degradations.map(d => d.provenanceAfter)]);
        return DEFAULT_PROVENANCE_LEGEND.filter(e => used.has(e.label)).map(e => ({ ...e, description: this.legendNotes[e.label] ?? defaultLegendText(e.label) }));
    }

    artifact(summary: string): CanvasArtifact | undefined {
        if (!this.camera || this.state.layers.length === 0) return undefined;
        this.state.provenanceLegend = this.legend();
        this.state.updatedAtMs = this.now();
        return composeStagedArtifact({
            state: JSON.parse(JSON.stringify(this.state)), camera: this.camera, layerMeta: this.layerMeta, geoAnchor: this.geoAnchor,
            activeScene: this.activeScene, summary, version: this.version++
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

    async stage<T>(def: StageDef<T>, extraSignal?: AbortSignal): Promise<Omit<StageResult<T>, 'status'> & { status: StageResult<T>['status'] | 'stopped' }> {
        if (this.ctx.signal?.aborted) throw abortError();
        const id = def.id;
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
    return `textured ${v.layers.map(l => l.layer).join(', ')} from ${v.views} registered Street View view${v.views === 1 ? '' : 's'}${v.tileUnavailable ? '' : ' and the tile photo'}: ${rungs}`
        + `${v.modelsUsed.length ? `; enhanced by ${v.modelsUsed.join(', ')}` : ''}; photo-derived texels are photo-inferred`;
}

function loadMesh(files: Array<string | undefined>): RenderMesh3D {
    const prims = files.filter((f): f is string => !!f && fs.existsSync(f)).flatMap(f => readGlbScene(f));
    return sceneToRenderMesh(prims);
}

// ----------------------------------------------------------------------------------------------------------------
// the run
// ----------------------------------------------------------------------------------------------------------------

export async function runStagedLocation(requestIn: StagedLocationRequest, deps: StagedLocationDeps, ctx: StagedLocationContext = {}): Promise<StagedLocationOutcome> {
    const now = deps.now ?? Date.now;
    const cache = deps.cache;
    // one grounding request per view per run: a view fetched ahead (the ring, while the survey reads) is reused, never refetched
    const streetView = deps.streetView?.grounding ? { ...deps.streetView, grounding: memoizeGrounding(deps.streetView.grounding) } : deps.streetView;
    // a retry rebuilds the recorded request exactly; the model never re-words it
    let request = requestIn;
    let recordedArtifactId: string | undefined;
    if (ctx.retry) {
        const rec = cache.readRunRecord<RunRecord>(ctx.retry.runId);
        if (!rec) throw new StagedLocationHardFailure('resolve', 'unknown_run', `There is no staged run ${ctx.retry.runId} to retry (its record is not in .scratchbox/cache/staged_location/runs).`);
        request = rec.request;
        recordedArtifactId = rec.artifactId;
    }
    const retryStage = ctx.retry?.stage;
    const bypass = (id: StageId) => retryStage === id;
    // the vision replies of identical earlier requests are read back (a retry of the stage asks the model again), and a
    // call whose first token is late is sent once more (VisionModelChainOptions.hedgeAfterMs)
    const chainExtras = (id: StageId) => ({ hedgeAfterMs: VISION_HEDGE_AFTER_MS, ...(bypass(id) ? {} : { replyCache: stagedReplyCache(cache) }) });
    const runId = deps.newRunId?.() ?? crypto.randomBytes(4).toString('hex');
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

        // ---------------- tiles ----------------
        type TilesValue = { extraction: StagedExtraction; key: string; sizedTo: 'structure' | 'request' | 'district-fallback'; structure?: StructurePickResult; ground?: GroundModel; scan?: ScanMesh; unmaskedTop?: Float32Array; rounds: number; cached: boolean; builtAtMs: number };
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
                        onProgress: m => io.progress(m), signal: io.signal
                    });
                    value = { extraction: sizing.extraction, key: last!.key, sizedTo: sizing.sizedTo, structure: sizing.structure, ground: sizing.ground, scan: sizing.scan, unmaskedTop: sizing.unmaskedTop, rounds: sizing.rounds, cached: last!.cached, builtAtMs: last!.builtAtMs };
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
                const layer: StagedLayer = {
                    objectId: layerObjectId(value.key, 'l1'), stage: 'tiles', layer: 'l1', order: STAGES.tiles.order, url: published.url, bytes: published.bytes,
                    provenance: { label: PROVENANCE.asScanned, measuredGeometry: true, method: 'Google Photorealistic 3D Tiles, leaf LOD, as downloaded', sources: [{ kind: 'tile-extraction', id: `extract:${key8}` }] },
                    provenanceLabels: [PROVENANCE.asScanned], supersedes: [], revealAfter: [],
                    reveal: { durationMs: 1200, stagger: 1, crossfadeFrom: [], ...(orderUrl ? { orderUrl } : {}) },
                    cached: value.cached, builtAtMs: value.builtAtMs, counts: layerCounts(e.geometryGlb)
                };
                run.commit(layer, { source: 'Google3DTilesClay', resolvedAddress: placeValue!.formattedAddress, isGround: true, extra: { rawGlbPath: e.rawGlbPath ?? e.texturedGlb } });
                if (st) {
                    run.state.structure = { seed: [st.seed.x, st.seed.z], geocodeToStructureM: st.geocodeToStructureM, footprintAreaM2: st.areaM2, extractionRadiusM: e.radiusM, containmentRounds: value.rounds };
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
        if (tiles.status === 'stopped' || !tiles.value) throw new StagedLocationHardFailure('tiles', 'run_deadline', `The run reached its time limit before any tiles were extracted, so there is nothing to show.`);
        const t = tiles.value;
        const extraction = t.extraction;
        const structure = request.isolate && t.sizedTo === 'structure' ? t.structure : undefined;
        const isolateMode = !!structure;

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
                                    const ring = planRingViews(faces, surveyCandidates(found.panos, faces, structure!, t.ground!, t.unmaskedTop ?? t.ground!.top), { faces: faces.map(f => ({ faceId: f.faceId, headingDeg: f.headingDeg, source: f.source, elements: [], materials: [] })), read }, undefined, false);
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

        // ---------------- evidence (starts when the fit is accepted: a rejected fit has nothing to place a photo on, and no image is fetched for it) ----------------
        let evidencePromise = undefined as Promise<{ images: EvidenceImage[]; panos: PanoCandidate[]; cost: EvidenceCost; plan?: DetailPlan; registration?: Registration; match?: MatchResult; runCrops?: RunCrops; status: string }> | undefined;
        // ended (skipped, as not needed) when the run ends before the evidence does
        const evidenceStop = new AbortController();

        const startEvidence = (fit: StructureFit): void => {
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
                    if (surveyOut?.result && visionAvailable) {
                        try {
                            const surveyFaces = surveyFaceTargets(structure!);
                            const candidates = surveyCandidates(found.panos, surveyFaces, structure!, t.ground!, t.unmaskedTop ?? t.ground!.top);
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
                    let plan = surveyOut?.result ? planDetailFromSurvey(surveyOut.result, fit, undefined, registration) : undefined;
                    const views = plan?.views.length ? plan.views : selectViewsForFit(found.panos, fit, structure!, t.ground!, t.unmaskedTop ?? t.ground!.top);
                    if (plan) io.progress(describeLocated(surveyOut!.result!.faces, plan));
                    const discovery = { metadataCalls: found.metadataCalls, cachedCalls: found.cachedCalls };
                    if (!views.length) {
                        return {
                            status: 'degraded', value: { images: [], panos: found.panos, cost: { ...NO_EVIDENCE_COST, ...discovery }, ...(plan ? { plan } : {}) }, source: 'no Street View images', reason: 'no Google Street View panorama looks at the fitted slots',
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
                            ...(registration ? { prior: registration } : {}), correspondences: match?.correspondences ?? [], faces: fitFaces(fit)
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
                            if (plan && surveyOut?.result) plan = { ...plan, ...locateSurveyElements(surveyOut.result, fit, registration) };
                        }
                    } catch (err) {
                        if (isAbort(err) || io.signal.aborted) throw err;
                        io.progress(`geometric registration failed (${errorMessage(err)}); the box registration stands`);
                    }
                    // the narrow crops of the repeating runs and bands the reading will look at, fetched now, before the texture pass
                    // starts its long computations (the reading would otherwise fetch them while those hold the thread)
                    let runCrops: RunCrops | undefined;
                    if (visionAvailable && plan?.located.length && t.ground) {
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
                        status, value: { images: got.images, panos: found.panos, cost, ...(plan ? { plan } : {}), ...(registration ? { registration } : {}), ...(match ? { match } : {}), ...(runCrops ? { runCrops } : {}) }, source: `${got.images.length} of ${views.length} Street View images (© Google), kept in memory only${match ? `; ${match.images} ring views, ${match.correspondences.length} matched element pairs${registration ? `, ${describeRegistration(registration, match.correspondences.length)}` : ', no pose registered'}${edgeReg ? `; ${describeEdgeRegistration(edgeReg)}` : ''}${match.failures.length ? `; ${match.failures.length} matching call${match.failures.length === 1 ? '' : 's'} failed (${match.failures[0].slice(0, 80)})` : ''}` : ''}`,
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

        // ---------------- textures (background: after the photo survey/registration and the fit commit; the clay layers never wait for it) ----------------
        let texturesPromise: Promise<unknown> | undefined;
        let textureValue: TextureStageValue | undefined;
        const startTextures = (): void => {
            if (texturesPromise) return;
            if (deps.textures?.disabled) { runner.skip('textures', deps.textures.disabled); return; }
            const waits = [surveyPromise, evidencePromise].filter((p): p is NonNullable<typeof p> => !!p).map(p => (p as Promise<unknown>).catch(() => undefined));
            texturesPromise = Promise.all(waits).then(() => runner.stage<TextureStageValue>({
                id: 'textures',
                run: async io => {
                    // the stage's CPU work runs in worker threads; the main thread's event-loop delay over the stage is recorded
                    let texturePool: TextureWorkerPool | undefined;
                    const loopDelay = monitorEventLoopDelay({ resolution: 10 });
                    loopDelay.enable();
                    try {
                    const started = now();
                    const evidence = evidencePromise ? await evidencePromise.catch(() => undefined) : undefined;
                    const fitNow = rebuildOut.refit?.value ?? rebuildOut.fit?.value;
                    // what gets a textured twin: every committed mesh layer the scene shows, or stands on (the ground), except vegetation;
                    // a layer another layer supersedes is hidden once that one reveals, so it is skipped unless it is the ground
                    const fitSurfaces = () => (rebuildOut.refit ?? rebuildOut.fit)?.value.surfaces.filter(x => x.chart).map(x => ({ id: x.id, chart: x.chart })) ?? [];
                    const handled = new Set<string>();
                    const pick = (): Array<{ layer: StagedLayer; file: string; surfaces?: Array<{ id: string; chart: any }>; late?: boolean }> => {
                        const live = run.state.layers.filter(l => !l.retired);
                        const superseded = new Set(live.flatMap(l => l.supersedes));
                        return live.filter(l => {
                            const meta = run.layerMeta[l.objectId];
                            if (handled.has(l.objectId) || l.textured || meta?.vegetation || !(l.counts.triangles > 0)) return false;
                            if (superseded.has(l.objectId) && !meta?.isGround) return false;
                            return fs.existsSync(path.join(cache.modelsDir, path.basename(l.url)));
                        }).map(l => ({ layer: l, file: path.join(cache.modelsDir, path.basename(l.url)), surfaces: fitSurfaces() }));
                    };
                    const targets = pick();
                    if (!targets.length) return { status: 'skipped', source: '', reason: 'no committed mesh layer to texture' };

                    // the sources, once for every layer: decoded, parsed and indexed in a texture worker thread (texture-worker-pool.ts),
                    // the layers' CPU work after them too, so the main thread keeps serving the vision calls running beside the stage
                    const images = evidence?.images ?? [];
                    // photo tier A anchors each pano on the tile outline through a WIDE view of it: the survey's and the ring's
                    // whole-face views (registered by the same joint poses), used by that tier only
                    const surveyRes = surveyPromise ? (await surveyPromise.catch(() => undefined))?.result : undefined;
                    const wideHeld = [
                        ...(surveyRes?.read ?? []).flatMap(r => { const bytes = surveyImageBytes(surveyRes!, r.imageIndex); return bytes ? [{ view: r.view, bytes, widthPx: r.widthPx, heightPx: r.heightPx, sha256: r.sha256 }] : []; }),
                        ...(evidence?.match ? matchRingImages(evidence.match) : [])
                    ];
                    const sourcesInput: TextureSourcesInput = {
                        images, wide: wideHeld as EvidenceImage[], ...(evidence?.registration ? { registration: evidence.registration } : {}),
                        ...(extraction.texturedGlb ? { texturedGlb: extraction.texturedGlb } : {}),
                        // the scan is the occluder and the judge of what the photos show: a fitted face where the scan has no surface
                        // (an arch opening) is not painted with the sky seen through it; the full tile mesh: the real opening, the
                        // statues, the trees and the buildings behind decide what each photo shows
                        occluderFiles: [remeshed?.clayGlb], contextFiles: [extraction.geometryGlb]
                    };
                    texturePool = textureWorkersEnabled() ? new TextureWorkerPool() : undefined;
                    // the threads load while the first prepares the sources; the layers start once they all can
                    const warming = texturePool?.warm();
                    const sources = texturePool ? await texturePool.prepare(sourcesInput, io.signal) : prepareTextureSources(sourcesInput, now);
                    await warming;
                    const { views, failures, wideViews, tile, tileUnavailable, tileLoadMs, tileSha, occluder, context } = sources;
                    const viewsUnavailable = images.length ? (views.length ? undefined : `none of the ${images.length} grounding images decoded (${failures[0] ?? ''})`)
                        : evidence ? `the Street View stage ${evidence.status === 'skipped' ? 'was skipped' : 'returned no image'}` : (visionAvailable ? 'the Street View stage did not run (no accepted fit to aim it at)' : 'no vision model is configured, so no Street View close-ups were fetched');
                    const palette = palettesFromSurvey(run.state.materialHints?.faces);
                    const bestSample = Math.min(...images.map(i => i.nativeSampleM).filter(v => v > 0), ...(tile && Number.isFinite(tile.texelSizeM) && !views.length ? [tile.texelSizeM] : []));
                    const cap = deps.textures?.maxDensityTexelsPerMeter ?? 20;
                    const density = Number.isFinite(bestSample) && bestSample > 0 ? Math.min(cap, 1 / bestSample) : cap;
                    const residual = evidence?.registration?.afterRmsM;
                    const poseHash = evidence?.registration ? [
                        ...[...evidence.registration.corrections.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)),
                        ...[...(evidence.registration.warps?.entries() ?? [])].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([id, w]) => [id, Array.from(w.dh), Array.from(w.dp)])
                    ] : [];
                    const enhance = deps.textures?.enhance;
                    const outcomes: Array<{ layer: StagedLayer; out: Omit<TextureLayerOutcome, 'glb' | 'measureLoo'>; url: string; bytes: number; cached: boolean; builtAtMs: number; surfaces: string; late: boolean }> = [];
                    // leave-one-pano-out fits, run once every layer is textured (TextureLayerOutcome.measureLoo)
                    const looJobs = new Map<string, NonNullable<TextureLayerOutcome['measureLoo']>>();
                    const done = (k: number) => {
                        run.state.texturePass = {
                            status: 'running', layersDone: k, layersTotal: targets.length,
                            ...(outcomes.length ? { rungShares: weightedShares(outcomes.map(o => ({ shares: o.out.rungShares, texels: o.out.atlasTexels }))) } : {}),
                            message: k < targets.length ? `texturing ${targets[k].layer.layer}` : 'textures ready'
                        };
                    };
                    done(0);
                    // layers in parallel (TEXTURE_LAYER_CONCURRENCY at once): one layer's projection runs while another waits on
                    // its image model, so the stage's wall clock is not the sum of every layer's enhancement
                    const textureOne = async (target: typeof targets[number]) => {
                        handled.add(target.layer.objectId);
                        const clay = fs.readFileSync(target.file);
                        const key = stageKey(TEXTURE_PASS_VERSION, target.layer.layer, sha256Bytes(clay), images.map(i => i.sha256), wideHeld.map(i => i.sha256), poseHash, tileSha, palette, !!enhance, density, deps.textures?.maxSide ?? 2048, surfacesKey(target.surfaces));
                        const entry = await cache.run<Omit<TextureLayerOutcome, 'glb'>>('textures', key, async dir => {
                            const out = await (texturePool ? texturePool.textureLayer.bind(texturePool) : textureLayer)({ layerKey: target.layer.layer, clayGlb: clay, ...(target.surfaces?.length ? { surfaces: target.surfaces } : {}) }, {
                                views, ...(wideViews.length ? { photoTierViews: wideViews } : {}), ...(photoTierEnabled() ? { photoTier: true } : {}), ...(viewsUnavailable ? { viewsUnavailable } : {}), occluder, ...(context.indices.length ? { context } : {}), observedSurface: TEXTURE_OBSERVED_SURFACE, poseEdgeGuardShare: TEXTURE_POSE_EDGE_GUARD_SHARE,
                                delight: { latitude: run.geoAnchor.lat, longitude: run.geoAnchor.lng },
                                ...(tile ? { tile } : {}), ...(tileUnavailable ? { tileUnavailable } : {}),
                                ...(residual !== undefined ? { registrationResidualM: residual } : {}),
                                ...(enhance ? { enhance: { client: enhance, ...(deps.textures?.enhanceModels ? { models: deps.textures.enhanceModels } : {}) } } : { enhanceUnavailable: 'no image model client is configured for it' }),
                                palette, densityTexelsPerMeter: density, maxSide: deps.textures?.maxSide ?? 2048, signal: io.signal,
                                onProgress: m => { io.progress(`textures: ${m}`); run.emit('textures', 'running', { message: m }); }
                            });
                            fs.writeFileSync(path.join(dir, 'twin.glb'), out.glb);
                            // a worker's layer keeps its thread for the leave-one-pano-out job; the pool's close ends it if it never runs
                            const { glb: _glb, measureLoo, release: _release, ...value } = out as TextureLayerOutcome & { release?: () => void };
                            if (measureLoo) looJobs.set(target.layer.objectId, measureLoo);
                            return { value };
                        }, { publish: () => [{ from: 'twin.glb', as: `${base}_${target.layer.layer}_tex_${key.slice(0, 8)}.glb` }], bypass: bypass('textures') });
                        const pub = entry.published[0];
                        const prior = outcomes.findIndex(o => o.layer.objectId === target.layer.objectId);
                        if (prior >= 0) outcomes.splice(prior, 1);
                        outcomes.push({ layer: target.layer, out: entry.value, url: pub.url, bytes: pub.bytes, cached: entry.cached, builtAtMs: entry.builtAtMs, surfaces: surfacesKey(target.surfaces), late: !!target.late });
                        // the layer gains its textured variant: same object, clay stays mounted; the viewport shows it in the textured material mode
                        const current = run.state.layers.find(l => l.objectId === target.layer.objectId) ?? target.layer;
                        const updated: StagedLayer = {
                            ...current,
                            textured: {
                                url: pub.url, bytes: pub.bytes, ladderRung: entry.value.bundle.ladderRung, rungShares: entry.value.rungShares.map(x => round(x, 4)),
                                provenance: entry.value.bundle.provenance.map(p => ({ ...p, coverage: round(p.coverage, 4) })), confidenceChannels: CONFIDENCE_CHANNELS,
                                builtAtMs: entry.builtAtMs, cached: entry.cached
                            }
                        };
                        run.commit(updated, run.layerMeta[current.objectId]);
                        const k = outcomes.length;
                        done(k);
                        run.emit('textures', 'running', { message: `${target.layer.layer} textured`, layers: [updated], progress: Math.min(1, k / targets.length) }, true);
                    };
                    // at most TEXTURE_LAYER_CONCURRENCY layers at once, the first targets and the late ones alike, in the order they came
                    let running = 0;
                    const waiting: Array<() => void> = [];
                    const withSlot = async (fn: () => Promise<void>) => {
                        if (running >= TEXTURE_LAYER_CONCURRENCY) await new Promise<void>(r => waiting.push(r));
                        running++;
                        try { await fn(); } finally { running--; waiting.shift()?.(); }
                    };
                    const textureAll = (list: typeof targets) => Promise.all(list.map(t => withSlot(() => textureOne(t))));
                    // a layer the rebuild commits later (photo-read detail, a refit body, figures) is textured as soon as it lands,
                    // beside the others; once the rebuild settles, each is checked against what the settled scene asks of it
                    const lateWork: Array<Promise<unknown>> = [];
                    const takeLate = () => {
                        const late = pick().map(t => ({ ...t, late: true }));
                        for (const t of late) handled.add(t.layer.objectId);
                        if (!late.length) return;
                        targets.push(...late);
                        const work = textureAll(late);
                        work.catch(() => undefined);
                        lateWork.push(work);
                    };
                    const onCommit = (layer: StagedLayer) => { if (request.isolate && !layer.textured && !handled.has(layer.objectId)) takeLate(); };
                    // the leave-one-pano-out fits (TextureLayerOutcome.measureLoo), one at a time, each layer once: those textured first
                    // are measured while the rebuild settles (the thread is mostly waiting on the model then), the rest after
                    // within the stage's own limit (the layers come first): what is left of it, less a margin, is the measurement's
                    const looDeadline = started + STAGES.textures.budgetMs - TEXTURE_LOO_MARGIN_MS;
                    const measured = new Set<object>();
                    const looLane = async () => {
                        // layers the rectified photo tier wrote come first (their fit is the one in question), then the others in order
                        const pending = outcomes.filter(o => !measured.has(o));
                        for (const o of [...pending.filter(x => (x.out.photoTier?.texelShare ?? 0) > 0), ...pending.filter(x => !((x.out.photoTier?.texelShare ?? 0) > 0))]) {
                            if (measured.has(o) || !outcomes.includes(o)) continue;
                            measured.add(o);
                            const job = looJobs.get(o.layer.objectId);
                            if (!job || !o.out.bundle.fit) continue;
                            const left = looDeadline - now();
                            if (left < 10_000) { io.progress(`textures: ${o.layer.layer}: no time left in the stage for the leave-one-pano-out fit`); continue; }
                            const tl = now();
                            try {
                                const loo = await job(Math.min(LOO_BUDGET_MS, left));
                                o.out = { ...o.out, bundle: { ...o.out.bundle, fit: { ...o.out.bundle.fit!, loo } }, timingsMs: { ...o.out.timingsMs, fitLoo: now() - tl } };
                                io.progress(`textures: ${o.layer.layer}: leave-one-pano-out fit over ${loo.panos} panos${loo.sampled ? ` (sampled: ${loo.panos} of ${loo.panosTotal})` : ''}: texture edge chamfer ${loo.chamferPx ?? 'n/a'} px, gradient NCC ${loo.gradNcc ?? 'n/a'}${loo.skipped ? ` (${loo.skipped} panos past the budget)` : ''}`);
                            } catch (err) {
                                if (isAbort(err) || io.signal.aborted) throw err;
                                io.progress(`textures: ${o.layer.layer}: the leave-one-pano-out fit could not be measured (${errorMessage(err)})`);
                            }
                            await new Promise(r => setImmediate(r));
                        }
                    };
                    run.commitListeners.add(onCommit);
                    try {
                        await textureAll(targets.slice());
                        if (request.isolate) {
                            const early = looLane();
                            early.catch(() => undefined);
                            await rebuildPromise.catch(() => undefined);
                            if (figuresPromise) await (figuresPromise as Promise<unknown>).catch(() => undefined);
                            run.commitListeners.delete(onCommit);
                            takeLate();
                            for (let i = 0; i < lateWork.length; i++) await lateWork[i];
                            // what the settled scene asks of the layers textured early: a layer another one now hides is not
                            // textured (unless it is the ground); one textured with charts a later refit replaced is textured again
                            const live = run.state.layers.filter(l => !l.retired);
                            const superseded = new Set(live.flatMap(l => l.supersedes));
                            const redo: typeof targets = [];
                            for (const o of outcomes.filter(x => x.late)) {
                                const meta = run.layerMeta[o.layer.objectId];
                                const current = run.state.layers.find(l => l.objectId === o.layer.objectId);
                                if (!current || current.retired || (superseded.has(o.layer.objectId) && !meta?.isGround)) {
                                    outcomes.splice(outcomes.indexOf(o), 1);
                                    looJobs.delete(o.layer.objectId);
                                    if (current) { const { textured: _t, ...clay } = current; run.commit(clay, run.layerMeta[current.objectId]); }
                                    continue;
                                }
                                const surfaces = fitSurfaces();
                                if (surfacesKey(surfaces) !== o.surfaces) {
                                    const t = targets.find(x => x.layer.objectId === o.layer.objectId)!;
                                    redo.push({ ...t, surfaces });
                                }
                            }
                            if (redo.length) await textureAll(redo);
                            await early;
                        }
                    } finally {
                        run.commitListeners.delete(onCommit);
                    }
                    // the layers in a fixed order: the first targets as picked, then the late ones in scene order
                    const sceneIndex = (id: string) => run.state.layers.findIndex(l => l.objectId === id);
                    const firstIndex = new Map(targets.filter(t => !t.late).map((t, i) => [t.layer.objectId, i]));
                    outcomes.sort((a, b) => (a.late === b.late ? (a.late ? sceneIndex(a.layer.objectId) - sceneIndex(b.layer.objectId) : firstIndex.get(a.layer.objectId)! - firstIndex.get(b.layer.objectId)!) : a.late ? 1 : -1));
                    const passDegradations: TexturePassDegradation[] = outcomes.flatMap(o => o.out.degradations);
                    await looLane();
                    const layers: TextureLayerBundle[] = outcomes.map(o => ({ ...o.out.bundle, maps: { albedo: `${o.url}#albedo` }, confidence: `${o.url}#confidence` }));
                    loopDelay.disable();
                    const timingsMs: Record<string, number> = { total: now() - started, tileLoad: tileLoadMs, ...eventLoopStats(loopDelay), ...(texturePool ? { textureWorkers: texturePool.size } : {}) };
                    cache.writeRunNote(runId, 'texture_timings', timingsMs);
                    io.progress(`textures: main-thread event-loop delay over the stage: p99 ${timingsMs.eventLoopP99Ms} ms, max ${timingsMs.eventLoopMaxMs} ms (${texturePool ? `${texturePool.size} texture worker threads` : 'texture work on the main thread'})`);
                    for (const o of outcomes) for (const [kk, v] of Object.entries(o.out.timingsMs)) timingsMs[`${o.layer.layer}.${kk}`] = v;
                    const record: TexturePassRecord = { passVersion: TEXTURE_PASS_VERSION, layers, degradations: passDegradations, timingsMs };
                    // the held-out fit per layer, kept with the run so rounds can be compared on the same measure
                    cache.writeRunNote(runId, 'texture_fit', outcomes.map(o => ({ layer: o.layer.layer, fit: o.out.bundle.fit ?? null, projection: o.out.projection ? { outputSeam: o.out.projection.outputSeam, context: o.out.projection.context, alignment: o.out.projection.alignment && { nccBefore: o.out.projection.alignment.nccBefore, nccAfter: o.out.projection.alignment.nccAfter }, poseRefine: o.out.projection.poseRefine } : null, rungShares: o.out.rungShares, timingsMs: o.out.timingsMs })));
                    const shares = weightedShares(outcomes.map(o => ({ shares: o.out.rungShares, texels: o.out.atlasTexels })));
                    run.state.texturePass = { status: 'committed', layersDone: outcomes.length, layersTotal: targets.length, rungShares: shares.map(x => round(x, 4)), message: 'textures ready' };
                    textureValue = {
                        record, shares, views: views.length, modelsUsed: [...new Set(outcomes.flatMap(o => o.out.modelsUsed))],
                        layers: outcomes.map(o => ({ layer: o.layer.layer, objectId: o.layer.objectId, url: o.url, rungShares: o.out.rungShares, atlasTexels: o.out.atlasTexels, atlas: o.out.atlas, projection: o.out.projection, enhance: o.out.enhance, cached: o.cached })),
                        tileUnavailable, viewsUnavailable
                    };
                    return {
                        status: 'committed', value: textureValue, layers: outcomes.map(o => run.state.layers.find(l => l.objectId === o.layer.objectId)!).filter(Boolean),
                        source: describeTextures(textureValue), cached: outcomes.every(o => o.cached), builtAtMs: Math.max(...outcomes.map(o => o.builtAtMs)),
                        breakdownMs: timingsMs
                    };
                    } finally {
                        loopDelay.disable();
                        texturePool?.close();
                    }
                },
                degrade: async err => {
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
            }));
            texturesPromise.catch(() => undefined);
            siblings.push(texturesPromise);
        };

        // ---------------- trees-measure ----------------
        let strip: TileVegetationStripResult | undefined;
        if (request.trees) {
            const roi: StripRoi | undefined = structure ? { schema: 'scratchbox.strip-roi/1', polygon: grownOutline(structure.outline, ISOLATE_TREE_REACH_M) } : undefined;
            const measured = await runner.stage<TileVegetationStripResult>({
                id: 'trees-measure',
                run: async io => {
                    const r = await deps.vegetation.strip({ tilePath: extraction.texturedGlb, signal: io.signal, ...(roi ? { roi } : {}) });
                    run.keys['trees-measure'] = r.cacheKey;
                    run.cacheStatus['trees-measure'] = r.cached ? 'hit' : 'miss';
                    const removed = Number(r.stats?.triangles?.removed ?? 0);
                    return { status: 'committed', value: r, source: `tile_vegetation strip: ${removed.toLocaleString('en-US')} canopy triangles measured as trees and removed`, cached: r.cached };
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

        // ---------------- remesh ----------------
        type RemeshValue = { refined?: TileRefineResult; flattened?: ScanFitFlattenResult; groundLayerId: string; groundFile: string; committed: boolean };
        const remesh = await runner.stage<RemeshValue>({
            id: 'remesh',
            run: async io => {
                io.progress(isolateMode ? 'remeshing the structure' : 'remeshing the district');
                const r = await deps.refine.refine({
                    tilePath: strip ? strip.devegetatedGlb : extraction.texturedGlb,
                    ...(isolateMode ? { isolate: true, anchor: { x: structure!.seed.x, z: structure!.seed.z } } : {}),
                    ...((request.relief ?? TILE_REFINE_RELIEF_DEFAULT) === false ? { relief: false } : {})
                });
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
                const degradations: DegradationRecord[] = [];
                let status: 'committed' | 'degraded' = 'committed';
                if (isolateMode) {
                    if (!r.rawClayGlb) {
                        degradations.push(run.degrade(record('remesh', 'isolate_mismatch', {
                            part: { description: 'the isolated structure' }, intended: 'a scan-fitted rebuild of the structure', fellTo: 'the remeshed scan, without a rebuild',
                            provenanceAfter: PROVENANCE.remeshed, reason: 'tile_refine wrote no isolated raw scan to compare with the structure picked', transient: false, runId, now: now()
                        })));
                    } else {
                        const iso = isolatedStructureCells(r.rawClayGlb, structure!.seed);
                        const iou = round(footprintIoU(structure!.cells, iso.cells), 3);
                        run.state.structure = { ...run.state.structure!, isolateIoU: iou };
                        if (iou < ISOLATE_IOU_MIN) {
                            degradations.push(run.degrade(record('remesh', 'isolate_mismatch', {
                                part: { description: 'the isolated structure' }, intended: 'a scan-fitted rebuild of the structure picked', fellTo: 'the remeshed scan, without a rebuild',
                                provenanceAfter: PROVENANCE.remeshed,
                                reason: `tile_refine isolated a different structure than the one picked (footprint IoU ${iou}, ${Math.round(iso.areaM2)} m² against ${Math.round(structure!.areaM2)} m², seed ${structure!.seed.x}, ${structure!.seed.z}), so it is not rebuilt`,
                                transient: false, runId, now: now()
                            })));
                        }
                    }
                }
                if (degradations.length) status = 'degraded';
                return {
                    status, value: { refined: r, groundLayerId: layer.objectId, groundFile: r.clayGlb, committed: true },
                    source: `tile_refine: ${layer.counts.triangles.toLocaleString('en-US')} triangles${prov.summary.relief?.carvedVertices ? `, ${prov.summary.relief.carvedVertices} vertices carved by photo relief (photo-inferred)` : ''}`,
                    layers: [layer], degradations, cached: r.cached, builtAtMs: remembered.builtAtMs
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
        const remeshed = remesh.status !== 'stopped' && remesh.value?.committed === true ? remesh.value.refined : undefined;
        const isolateOk = isolateMode && !!remeshed?.rawClayGlb && !run.state.degradations.some(d => d.reasonCode === 'isolate_mismatch');

        // ---------------- trees (plant) ‖ the rebuild ----------------
        const treesRun = async (): Promise<{ trees?: LocationClayTrees; putBack?: { triangles: number; crowns: number; reason: string } }> => {
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
                    io.progress(`growing ${toPlant} SB-Veggie trees to their measured crowns`);
                    const planted = await plantTrees({ vegetation: deps.vegetation }, strip!, {
                        treeTriangleBudget: request.treeTriangleBudget,
                        supportMeshPath: isolateMode ? remeshed.clayGlb : undefined,
                        groundMeshPath: remeshed.clayGlb,
                        signal: io.signal
                    });
                    run.keys.trees = planted.cacheKey;
                    run.cacheStatus.trees = planted.cached ? 'hit' : 'miss';
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
        const rebuildOut: Rebuild = { droppedNotResolvable: 0 };
        const rebuildRun = async (): Promise<Rebuild> => {
            const out = rebuildOut;
            const skipRest = (reason: string, from: StageId[] = ['fit', 'evidence', 'project', 'vision', 'correct', 'detail', 'figures']) => {
                // the Street View fetch may still be running: it is ended as not needed, saying why
                if (from.includes('evidence')) evidenceStop.abort(reason);
                for (const id of from) runner.skip(id, reason);
            };
            if (!request.isolate) { skipRest('not an isolated structure'); return out; }
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
                skipRest('there is no fitted structure to place detail on', ['evidence', 'project', 'vision', 'correct', 'detail', 'figures']);
                return out;
            }
            // fit
            const fitKey = stageKey('scan_fit/fit/v2', remeshed.cacheKey, sha256File(remeshed.rawClayGlb!), structure!.seed);
            run.keys.fit = fitKey;
            const negative = !bypass('fit') ? cache.negative('fit', fitKey) : undefined;
            const fitted = await runner.stage<ScanFitFitResult>({
                id: 'fit',
                run: async io => {
                    if (negative) throw Object.assign(new Error(negative.message), { code: negative.code, cachedNegative: true });
                    const r = await deps.scanFit!.fit({
                        scanGlb: remeshed.rawClayGlb!, texturedGlb: extraction.texturedGlb, remeshGlb: remeshed.clayGlb, anchor: structure!.seed,
                        sourceLimits: out.sourceLimits!, signal: io.signal, onProgress: (f, m) => io.progress(`scan_fit: ${m}`, f), timeoutMs: STAGES.fit.budgetMs
                    });
                    run.cacheStatus.fit = r.cached ? 'hit' : 'miss';
                    const fit = r.value;
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
                skipRest('there is no accepted fit to place detail on', ['evidence', 'project', 'vision', 'correct', 'detail', 'figures']);
                // the remeshed scan still gets its textures (tile photo; no Street View was fetched for a rejected fit)
                startTextures();
                return out;
            }
            out.fit = fitted.value;
            const fit = fitted.value.value;
            persist();
            if (rebuildPossible && visionAvailable) startEvidence(fit);
            if (rebuildPossible) startFigures(fit, out);
            startTextures();

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
        const rebuildPromise = rebuildRun().catch((err): Rebuild => {
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

        // both branches, and the Street View fetch, are settled before the call goes on: none runs, or rejects unseen, after it
        const settled = await Promise.allSettled([treesPromise, rebuildPromise, ...(evidencePromise ? [evidencePromise] : []), ...(surveyPromise ? [surveyPromise] : []), ...(figuresPromise ? [figuresPromise] : [])]);
        // the figures stage starts inside the rebuild, after the line above built its list, so it is awaited here: finishing before it would
        // stop it ("not started before the run ended") whenever every other stage came from cache
        const late = await Promise.allSettled(siblings);
        // the texture pass starts inside the rebuild; a run that never reached it (no isolated structure, no fitter) says why
        runner.skip('textures', request.isolate ? 'the rebuild did not reach the texture pass (no remeshed, fitted structure)' : 'the texture pass runs on an isolated structure');
        const failure = [...settled, ...late].find((r): r is PromiseRejectedResult => r.status === 'rejected');
        if (failure) throw failure.reason;
        const treesOut = (settled[0] as PromiseFulfilledResult<Awaited<typeof treesPromise>>).value;
        const rebuild = (settled[1] as PromiseFulfilledResult<Awaited<typeof rebuildPromise>>).value;
        persist();

        // ---------------- finish ----------------
        cache.writeRunNote(runId, 'main_thread', blockTracer.stop());
        return finishRun(run, {
            request, place: placeValue, extraction, structure, sizedTo: t.sizedTo, remeshed, groundFile: remesh.value?.groundFile, groundLayerId: remesh.value?.groundLayerId ?? run.state.layers.find(l => l.layer === 'l1')?.objectId,
            trees: treesOut.trees, putBack: treesOut.putBack, rebuild, strip, ...(textureValue ? { textures: textureValue } : {}), now, persist
        });
    } catch (err) {
        // the Street View fetch and the two branches are ended with the call: none is left running, or rejecting unseen, behind it
        await Promise.allSettled(siblings);
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
    const remesh = run.state.layers.find(l => l.layer === 'l2');
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
    const remeshLayer = run.state.layers.find(l => l.layer === 'l2' && l.stage === 'remesh' && l.provenance.label === PROVENANCE.remeshed);
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

