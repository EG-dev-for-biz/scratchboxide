/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Object or abstract-form request -> native geometry with per-part PBR materials (or all clay on request), in four stages:
 *   1. Reference: Nano Banana Lite (gemini-3.1-flash-lite-image, exactly that model) draws one isolated object in its
 *      real colours and materials under neutral studio light (a clay build asks for a uniform grey clay object).
 *      The image stays a Buffer in this process: it is never written to disk, the media store, public/ or the chat.
 *   2. Build spec: the model chat runs on (the request's model, else the chat's default, walking the chat's own
 *      fallback list on "model not found" and saying so) reads the reference into an ObjectBuildSpec, on the chat's
 *      credentials. Unless the build is clay, every sweep and revolve part also gets a material: continuous factors
 *      (linear RGB base colour, roughness, metalness, transmission, ior, clearcoat, emission) read from the generated
 *      reference, so they are inferred from a generated image, not measured; the result and the GLB say so.
 *      Child geometry that does not start at its attach point is moved there (a translation, recorded in the pass)
 *      instead of a re-ask. A spec the validator or the interpreter cannot build, or whose build runs past its time
 *      limit, gets one corrective re-ask quoting every problem, answered with only the parts that change (a patch
 *      merged by part id), then the call fails.
 *   3. Build: sb.object_spec.build(spec) runs in the native Python engine and writes a GLB, within BUILD_TIMEOUT_MS
 *      (a run past it is stopped and reported as having run out of time). The time limit starts once the engine's
 *      native module is ready: a rebuild after an engine change is waited for first, and a failed one is its own
 *      stage ('engine'), never blamed on the spec.
 *   4. Checks: every part the spec lists is built and touches its parent, the piece count equals expectedBodies, and
 *      the vision model compares a clay render with the reference; unless the build is clay it also compares a render
 *      of the build in its materials (material-preview-render) and lists surface differences per part as corrected
 *      factors. Both comparisons run together, while the contact analysis does (in slices, so the server keeps
 *      answering and a stop ends it). Problems, high-confidence differences and applicable material corrections
 *      go back for up to two revision passes: a revision replies with only the parts it changes, the material
 *      corrections already applied to the spec it is given; a pass whose only problems are material corrections
 *      is rebuilt natively with them, with no model call for the spec. Every stage is timed (result.timings). The result is the last build that passed every check; a revision that fails
 *      is reported as such, and differences still present are listed verbatim. A comparison that cannot be had
 *      (a malformed answer twice, or a model error) leaves that pass measured but not compared, and the result says
 *      so; it never discards a build that passed every check. A build that never passed every check is rejected,
 *      never mounted. A failure after the vision model was chosen names that model, and the chat's model it
 *      stands in for when they differ.
 * buildObjectFromSpec builds a given spec (an edit of an earlier one) through stages 3 and 4 only, with no model call:
 * it fails with every problem listed instead of revising. A stop kills the Python process and ends the build at the
 * stage it reached. Nothing here reads part labels or ids for meaning: ids only pair spec parts with their meshes.
 * There is no other image model, template, neural reconstruction or text-only path to fall back to.
 */

import * as fs from 'fs';
import type { Content, GenerateContentParameters, GenerateContentResponse, Part } from '@google/genai';
import {
    buildObjectSpecScript,
    normalizeChildOrigins,
    objectBuildSpecJsonSchema,
    partsWithoutMaterial,
    validateObjectBuildSpec,
    validatePartMaterial,
    PART_MATERIAL_JSON_SCHEMA,
    type ObjectBuildSpec,
    type PartMaterial,
    type Vec3
} from '../../common/spatial/object-build-spec';
import { classifyMediaGenerationError } from '../../common/media-generation-protocol';
import { GeminiClient, errorMessage, isModelNotFoundError } from '../gemini/gemini-client';
import { describeThinking } from '../gemini/thinking-config';
import { VisionModelChain } from '../gemini/vision-model-chain';
import { NativePythonRunnerService, type PythonExecutionOptions, type PythonExecutionResult } from './native-python-runner-service';
import {
    analyzePartConnectivityAsync,
    glbToNamedTriangleSoupsAsync,
    mergeTriangleSoups,
    type ContactGraph,
    type FloatingPart,
    type PartConnectivityReport,
    type TriangleSoup
} from './part-connectivity';
import { renderReviewViews } from './visual-review';
import { materialPreviewMeshes, renderMaterialPreview } from './material-preview-render';
import { downscaleForVision } from '../vision-image-downscale';

/** Nano Banana Lite. The only model the reference image is ever requested from. */
export const REFERENCE_IMAGE_MODEL = 'gemini-3.1-flash-lite-image';
/** Revision passes after the first build. */
export const MAX_REVISION_PASSES = 2;
/** Backoff retries for 429 / 5xx answers, always on the same model. */
export const MAX_TRANSIENT_RETRIES = 2;
/** Image models sometimes finish with no image part; the same model is asked this many times in all. */
export const EMPTY_IMAGE_ATTEMPTS = 3;
/** How long one native build of a spec may run before it is stopped. */
export const BUILD_TIMEOUT_MS = 120_000;

export type ObjectBuildStage = 'credentials' | 'reference-image' | 'build-spec' | 'engine' | 'build' | 'checks';

export class ReferenceObjectBuildError extends Error {
    constructor(
        readonly stage: ObjectBuildStage,
        message: string,
        readonly details: Record<string, unknown> = {}
    ) {
        super(message);
        this.name = 'ReferenceObjectBuildError';
    }
}

/** The part of a @google/genai client this builder calls. */
export interface GenerateContentClient {
    models: { generateContent(params: GenerateContentParameters): Promise<GenerateContentResponse> };
    /** Set on real clients: true for Vertex AI, false for an AI Studio API key. */
    readonly vertexai?: boolean;
}

/**
 * Where the vision model and the credentials come from: the chat's own GeminiClient by default, so the spec is read
 * by the model chat runs on, through the same backend (Vertex service account, else the Gemini API key).
 */
export interface ChatModelSource {
    getGenAIClient(): Promise<GenerateContentClient | undefined>;
    /** The models chat tries for a request, in order: the requested one (else the chat default), then its fallbacks. */
    getModelCandidates(requestedModel?: string): string[];
}

export interface ReferenceObjectBuildRequest {
    /** What to build, in the user's words plus any detail from the conversation. */
    request: string;
    /** The model the chat request named, if any; unset means the chat's own default model. */
    requestedModel?: string;
    dimensionsHintMeters?: Vec3;
    /**
     * True when the user asked for clay (untextured grey): the reference is drawn as clay, no materials are read and
     * every part is studio clay. Otherwise each part gets the material read from a full-colour reference.
     */
    clay?: boolean;
    signal?: AbortSignal;
    reportProgress?: (message: string, fraction?: number) => void;
}

/**
 * Where the part materials of a build came from. `generated`: read by the vision model from the reference image an
 * image model drew (inferred, never measured); `as-given`: written in the spec the caller passed; `clay`: none.
 */
export interface MaterialProvenance {
    /** Legend key (nothing branches on it). */
    label: 'generated' | 'as-given' | 'clay' | (string & {});
    /** One sentence saying how the materials were obtained, for the result and the GLB extras. */
    note: string;
    /** Sweep and revolve parts with no material, built in studio clay (a spec without them, or a part left out). */
    clayParts: string[];
}

export interface ReferenceObjectBuilderDeps {
    /** Defaults to the chat's credentials and model list (a GeminiClient). */
    chat?: ChatModelSource;
    runPython?: (script: string, options: PythonExecutionOptions) => Promise<PythonExecutionResult>;
    /** Where the build script and GLB are written (the runner's build/3d-python by default). */
    outputDir?: string;
    sleep?: (ms: number) => Promise<void>;
    /** Time limit for one native build (BUILD_TIMEOUT_MS by default), counted once the engine is ready. */
    buildTimeoutMs?: number;
    /**
     * Makes the engine's native module ready before a build's time limit starts, rebuilding it after an engine change;
     * resolves to null when ready or to the build error. Defaults to the Python runner's ensureNativeModule when
     * runPython is not injected, and to nothing when it is.
     */
    prepareEngine?: () => Promise<string | null>;
    /**
     * How corrective re-asks and revisions reply: true (the default) asks for only the parts that change (a spec
     * patch, merged here by part id), false for the complete spec every time. The model writes its output at a fixed
     * rate, so a patch of a few parts comes back several times faster than the whole spec.
     */
    patchReplies?: boolean;
}

export interface ReferenceDifference {
    partId?: string;
    problem: string;
    confidence: 'high' | 'low';
}

/** The material factors a correction may set (the description is the model's words and is not corrected). */
export type MaterialFactors = Partial<Omit<PartMaterial, 'description'>>;

/**
 * A surface the vision model saw differ between the reference and a render of the build in its materials, with the
 * factors it should have instead (only the ones that differ, as continuous values).
 */
export interface MaterialDifference {
    partId: string;
    problem: string;
    confidence: 'high' | 'low';
    correction: MaterialFactors;
}

/** A high-confidence material correction applied to the spec for the next pass. */
export interface AppliedMaterialCorrection {
    partId: string;
    problem: string;
    /** The factors as they were and as they were set. */
    from: MaterialFactors;
    to: MaterialFactors;
}

/** The comparison of one pass's material render with the reference. */
export interface MaterialCheck {
    pass: number;
    /** Every difference listed, high and low confidence. */
    differences: MaterialDifference[];
    /** High-confidence corrections that were applied to the spec for the next pass (empty on the last pass or when none apply). */
    applied: AppliedMaterialCorrection[];
    /** High-confidence corrections that could not be applied, with why (an unknown part, a factor out of range, no change). */
    notApplied: Array<{ partId: string; reason: string }>;
    /** Why the comparison could not be had, when it could not (the pass is then not material-checked). */
    error?: string;
}

/** What one listed part produced in the GLB. */
export interface PartBuildCheck {
    id: string;
    /** Triangles across all of the part's copies. */
    triangles: number;
    sizeMeters: Vec3;
    built: boolean;
    parentId?: string;
    /** For a child part: whether every copy of it touches (or is embedded in) its parent. */
    touchesParent?: boolean;
}

export interface ObjectBuildChecks {
    vertexCount: number;
    triangleCount: number;
    /** One entry per sweep or revolve part in the spec (replicate and relief parts shape these). */
    parts: PartBuildCheck[];
    /** Parts the spec lists that produced no usable geometry. */
    missingParts: string[];
    /** Child parts that do not touch their parent. */
    detachedParts: Array<{ id: string; parentId: string }>;
    connectivity: {
        passed: boolean;
        bodies: number;
        expectedBodies: number;
        floatingParts: FloatingPart[];
        toleranceMeters: number;
        skippedReason?: string;
    };
    /** Shape differences the vision model saw between the reference and a clay render of the build. */
    differences: ReferenceDifference[];
    builtBoundingMeters: Vec3;
}

export interface ObjectBuildPass {
    pass: number;
    /**
     * reference: the first pass from the reference; revision: a pass that fixes problems; material: a pass that only
     * applies material corrections (same geometry, no model call for the spec); spec: a spec rebuilt as given.
     */
    source: 'reference' | 'revision' | 'material' | 'spec';
    /** 'built' when the pass produced a checked build; 'failed' when its spec could not be built or checked. */
    outcome: 'built' | 'failed';
    /** Spec requests the pass took: 1, or 2 when the first answer needed the corrective re-ask. */
    specRequests?: number;
    /** The problems quoted back in the corrective re-ask, when there was one. */
    correctedProblems?: string[];
    /** Child parts whose geometry was moved to start at its attach point instead of a re-ask, one note each. */
    normalizedChildren?: string[];
    vertexCount?: number;
    triangleCount?: number;
    partsBuilt?: number;
    partsListed?: number;
    detachedParts?: string[];
    bodies?: number;
    expectedBodies?: number;
    /** True when every part is built and connected as the spec says. */
    passedChecks?: boolean;
    highConfidenceDifferences?: number;
    /** Why the clay render of this pass could not be compared with the reference, when it could not. */
    comparisonError?: string;
    /** High-confidence material differences the material render showed (not set for a clay build). */
    materialDifferences?: number;
    /** Material corrections this pass's comparison applied to the spec for the next pass. */
    materialCorrections?: number;
    /** Why this pass's material render could not be compared with the reference, when it could not. */
    materialComparisonError?: string;
    /** Problems sent back to the vision model after this pass; empty when nothing was left to fix. */
    problems?: string[];
    /** Why the pass failed, when it did. */
    error?: string;
    buildMs?: number;
}

export interface ModelUse {
    requested: string;
    /** The model version the API reports for the answer (the requested id when the API reports none). */
    answered: string;
}

export interface VisionModelUse extends ModelUse {
    /** The model id that answered: `requested`, or a later one from the chat's fallback list. */
    used: string;
    /** Where `requested` came from: the chat request, or the chat's default model because the request named none. */
    source: 'request' | 'chat-default';
    /** Models tried before `used`, each with the reason it was passed over. */
    skipped: Array<{ model: string; reason: string }>;
    /** The thinking the spec read asked the model for (LOW on Gemini 4; a 512-token budget on 3.x). */
    thinking?: { level: 'LOW' | 'MEDIUM' | 'HIGH' } | { budget: number };
}

export interface RevisionFailure {
    /** The pass that failed. */
    pass: number;
    stage: ObjectBuildStage;
    reason: string;
}

/** The returned pass's clay render could not be compared with the reference. */
export interface ComparisonFailure {
    pass: number;
    reason: string;
    /**
     * High-confidence differences the pass before it had, which this pass was asked to fix: whether it did is
     * unknown. Empty for pass 1.
     */
    unverifiedDifferences: ReferenceDifference[];
}

export interface ReferenceObjectBuildResult {
    spec: ObjectBuildSpec;
    /** True when every part was built as studio clay (a clay request). */
    clay: boolean;
    /** Where the part materials came from; also written into the GLB's material extras. */
    materials: MaterialProvenance;
    sourceCode: string;
    glb: Buffer;
    glbPath: string;
    imageModel: ModelUse;
    visionModel: VisionModelUse;
    backend: 'vertex' | 'api-key' | 'injected';
    passes: ObjectBuildPass[];
    /** The pass whose build this is. */
    resultPass: number;
    /** Set when a later revision failed and this result is an earlier pass. */
    revisionFailed?: RevisionFailure;
    /** Set when the returned pass could not be compared with the reference: its remaining differences are unknown. */
    comparisonFailed?: ComparisonFailure;
    checks: ObjectBuildChecks;
    /** High-confidence differences still present in the returned build, as the vision model wrote them (none known when comparisonFailed is set). */
    remainingDifferences: ReferenceDifference[];
    /** The material comparison of every checked pass, in order (empty for a clay build). */
    materialChecks: MaterialCheck[];
    /** High-confidence material differences still present in the returned build (none known when its comparison failed). */
    remainingMaterialDifferences: MaterialDifference[];
    /** Other problems still present in the returned build (such as its size disagreeing with boundingMeters). */
    openProblems: string[];
    /** How long each stage took, in the order the stages finished. */
    timings: BuildStageTiming[];
    /** Wall time of the whole build. */
    totalMs: number;
}

/**
 * One measured stage of a build, in the order it finished. `startMs` is from the start of the build; model calls also
 * carry the token counts the API reported. Stages of one pass can overlap (the comparison runs while the contact
 * analysis does), so the stages' times do not add up to the wall time.
 */
export interface BuildStageTiming {
    /** What ran (a label for the record; nothing branches on it). */
    stage: 'reference-image' | 'reference-prep' | 'spec-read' | 'spec-correction' | 'engine' | 'native-build' | 'measure'
        | 'render' | 'shape-compare' | 'material-compare' | (string & {});
    pass: number;
    startMs: number;
    ms: number;
    model?: string;
    promptTokens?: number;
    outputTokens?: number;
    thoughtTokens?: number;
    /** Length of the reply text, for model calls. */
    outputChars?: number;
}

/** Records how long each stage of one build takes. */
export class BuildStageClock {
    readonly timings: BuildStageTiming[] = [];
    /** The pass the stages being timed belong to (passes run one after another). */
    pass = 1;
    private readonly t0: number;
    constructor(private readonly now: () => number = Date.now) {
        this.t0 = now();
    }
    get elapsedMs(): number {
        return this.now() - this.t0;
    }
    /** Times `work` as `stage` of the current pass; `extra` adds fields from its result. */
    async time<T>(stage: BuildStageTiming['stage'], work: () => Promise<T> | T, extra?: (value: T) => Partial<BuildStageTiming>): Promise<T> {
        const pass = this.pass;
        const started = this.now();
        const value = await work();
        this.timings.push({ stage, pass, startMs: started - this.t0, ms: this.now() - started, ...(extra ? extra(value) : {}) });
        return value;
    }
}

/** The token counts a model answer reports, as timing fields. */
function usageTiming(response: GenerateContentResponse | undefined): Partial<BuildStageTiming> {
    const u = response?.usageMetadata;
    if (!u) return {};
    return {
        ...(u.promptTokenCount !== undefined ? { promptTokens: u.promptTokenCount } : {}),
        ...(u.candidatesTokenCount !== undefined ? { outputTokens: u.candidatesTokenCount } : {}),
        ...(u.thoughtsTokenCount !== undefined ? { thoughtTokens: u.thoughtsTokenCount } : {})
    };
}

interface ReferenceImage {
    data: Buffer;
    mimeType: string;
    /** The image as an uploaded file (Gemini API Files), sent by reference instead of inline on every later call. */
    part?: Part;
}

/** The reference as a content part: its uploaded file when it has one, else inline. */
function referencePart(reference: ReferenceImage): Part {
    return reference.part ?? imagePart(reference.data, reference.mimeType);
}

/**
 * Prepares the reference for the calls that read it (the spec, every comparison and revision): downscaled to a
 * 1024 px long edge when larger, and, on the Gemini API (which has a Files service; Vertex does not), uploaded once
 * so each call sends a file reference instead of the image. An upload that fails leaves the image inline; returns
 * the uploaded file's name for deletion.
 */
/** The parts of a Gen AI client the reference upload uses (the Gemini API Files service). */
interface FilesCapableClient {
    vertexai?: boolean;
    files?: {
        upload?: (args: { file: Blob; config?: Record<string, unknown> }) => Promise<{ name?: string; uri?: string; mimeType?: string }>;
        delete?: (args: { name: string }) => Promise<unknown>;
    };
}

async function prepareReferenceForReading(client: FilesCapableClient, reference: ReferenceImage, signal?: AbortSignal): Promise<{ reference: ReferenceImage; uploadedName?: string }> {
    const small = await downscaleForVision(reference.data, reference.mimeType).catch(() => undefined);
    const ready: ReferenceImage = small?.downscaled ? { data: small.data, mimeType: small.mimeType } : reference;
    const upload = client?.files?.upload;
    if (client?.vertexai !== false || typeof upload !== 'function') return { reference: ready };
    try {
        const file = await upload.call(client.files, {
            file: new Blob([new Uint8Array(ready.data)], { type: ready.mimeType }),
            config: { mimeType: ready.mimeType, ...(signal ? { abortSignal: signal } : {}) }
        });
        if (!file?.uri) return { reference: ready };
        return { reference: { ...ready, part: { fileData: { fileUri: file.uri, mimeType: file.mimeType || ready.mimeType } } }, uploadedName: file.name };
    } catch {
        if (signal?.aborted) throw new ReferenceObjectBuildError('build-spec', 'Stopped by the user.', { aborted: true });
        return { reference: ready };
    }
}

const THREE_QUARTER_VIEW = [{ label: 'three-quarter view', azimuthDeg: 35, elevationDeg: 22 }];

let chatClient: GeminiClient | undefined;
/** The client and model list chat uses (GeminiClient: Vertex service account when configured, else the API key). */
function defaultChat(): ChatModelSource {
    chatClient ??= new GeminiClient();
    return chatClient;
}

const defaultSleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------

export function buildReferenceImagePrompt(request: string, options: { clay?: boolean } = {}): string {
    return [
        `Reference picture for building a 3D model of: ${request}`,
        'Show exactly one complete object, whole and uncropped, centred and filling most of the square frame, in a three-quarter view from slightly above.',
        options.clay
            ? 'Render it as matte, untextured, uniform mid-grey clay: no colour, pattern, text, logos or decals, so only its shape reads.'
            : 'Show it in its real colours and materials (paint, bare metal, glass, plastic, wood, fabric, stone, organic surfaces), each part\'s finish clearly distinct where it changes, as in a clean product photograph. No text, logos or decals.',
        options.clay
            ? 'Plain flat #808080 background with even, shadowless studio light. No floor, ground plane, cast shadow, display stand that is not part of the object, props, people, hands or text.'
            : 'Plain flat #808080 background with even, soft, neutral white studio light (no coloured light, no room or window reflections). No floor, ground plane, cast shadow, display stand that is not part of the object, props, people, hands or text.'
    ].join('\n');
}

/** How materials are read, added to the conventions of a build that is not clay. */
export function materialConventions(): string {
    return [
        '- material: every sweep and revolve part has one, read from the picture (replicate copies and mirrored parts use their source part\'s; replicate and relief parts have none). Describe the surface itself, not the studio light: ignore highlights, reflections and shading when reading colour.',
        '  baseColor is LINEAR RGB 0..1, not sRGB: convert each sRGB channel v/255 to about (v/255)^2.2 (sRGB 128 is 0.22, sRGB 200 is 0.6, sRGB 240 is 0.87). For a metal it is the metal\'s tint (steel about [0.56, 0.57, 0.58], brass [0.91, 0.78, 0.42], copper [0.95, 0.64, 0.54]).',
        '  roughness 0 mirror-smooth .. 1 chalky; metalness 1 only for bare metal, 0 for paint (even metallic paint), plastic, glass, stone, wood and organic matter; transmission 0 opaque, about 0.9-1 for clear glass, clear plastic or liquid (baseColor then tints what is seen through it); ior only for see-through parts (glass about 1.5, water 1.33); clearcoat for glossy lacquer, car paint or varnish; emissive (linear RGB) with emissiveStrength only for parts that glow.',
        '  A part takes the surface that covers most of it; where the finish changes, split the shape into parts so each has one surface.'
    ].join('\n');
}

/** The rules every spec follows. Sent with the first request and again with every revision, which is stateless. */
export function specConventions(dimensionsHintMeters?: Vec3, options: { materials?: boolean } = {}): string {
    const size = dimensionsHintMeters
        ? `The user gave its size as about ${dimensionsHintMeters.map(d => `${d} m`).join(' x ')} (width x height x depth).`
        : 'Size it to its real-world scale.';
    return [
        'Conventions',
        `- Metres. +Y up, +X to the object's right, +Z toward its front (the side facing the viewer). The origin is the centre of where the object meets the ground; nothing goes below y = 0. ${size}`,
        '- Describe the whole object, including sides the image hides: infer them from symmetry and from how such objects are built.',
        '- Build it from parts. Every part has exactly one operator block:',
        '  sweep: a cross-section swept along a smooth carrier through controlPoints. profile keys (t from 0 at the first control point to 1 at the last) give the section width (sideways), height (along the section\'s up direction) and superellipse exponent (2 round, 4 or more boxy, below 2 pinched); keys interpolate linearly, so use several keys to taper and swell. smoothing 0 = straight segments, 1 = smooth curve. closedLoop joins the end to the start. twistDegAlong turns the section about the carrier; modulation adds periodic ribs.',
        '  revolve: a meridian of [distance along the axis, radius] points revolved about axisDirection through axisOrigin. Trace the full outline: start and end at radius 0 to close the ends at the axis (a disc of radius r and thickness h is [[0, 0], [0, r], [h, r], [h, 0]]); a non-zero end radius is capped flat. Trace a hollow vessel by going up the outside and back down the inside. lobeCount and lobeDepthRatio add radial lobes (flutes, teeth, petals); helixPitchMeters twists them along the axis (0 = straight).',
        '  replicate: copies of seedPartId together with everything attached to it; the seed as built is copy 0 and is emitted only through the replicate. ring: each copy turned a further spanDeg / count degrees about the axis through centerMeters (spanDeg 360 = evenly round a full circle, more for a helix) and raised risePerCopyMeters. path: copies spaced evenly from the first to the last point, optionally turned with the path.',
        '  relief: grooves (negative depthMeters) or beads (positive) of widthMeters along curves on targetPartId. Curves are polylines of [u, v]: u from 0 to 1 along the part (along the carrier of a sweep, along the meridian of a revolve), v = angle / 360 around it; [[u, 0], [u, 1]] is a full ring and v past 1 wraps for spirals.',
        '- Attachment: every part except root parts has parentId (a sweep or revolve part) and attach {u, angleDeg, normalOffsetMeters}. The attach point is on the parent surface at u along it and angleDeg around it; u = 0 or 1 is the centre of that end. normalOffsetMeters moves the point along the surface normal: use a small negative value, about a quarter of the child\'s thickness, so the child sinks into its parent. A child\'s own coordinates are offsets in object axes from its attach point: a child sweep\'s first control point is [0, 0, 0], and a child revolve has axisOrigin [0, 0, 0] with a meridian whose axial distances span 0.',
        '- Angle 0 around a revolve points toward +Z (or +X when the axis is along Z) and angle 90 toward axisDirection x (angle-0 direction): for an upright axis 0 is front, 90 right, 180 back, 270 left. Angle 0 around a sweep is the section\'s up direction (toward +Y, or +Z for a vertical carrier) and 90 is the carrier direction x up.',
        '- Root parts (no parentId) use absolute coordinates. Use one root unless the object really is several separate pieces; expectedBodies is how many separate pieces you intend (usually 1). Every child must touch its parent.',
        '- mirrorPlaneNormal also emits a part and what is attached to it reflected across the plane through the origin with that normal, e.g. [1, 0, 0] for a left/right pair.',
        '- Spend parts on the main mass first, then the secondary assemblies, then small details; use as many parts as the object needs.',
        ...(options.materials ? [materialConventions()] : []),
        `- observations: short notes on proportions, counts and how the parts join${options.materials ? ', and the materials you see' : ''}.`
    ].join('\n');
}

export function buildSpecPrompt(request: string, dimensionsHintMeters?: Vec3, options: { materials?: boolean } = {}): string {
    return [
        `The image is a reference picture of: ${request}`,
        `Reverse-engineer it into a build spec for a procedural modeller${options.materials ? ', with the surface material of every part' : ''}. Reply with JSON matching the schema.`,
        '',
        specConventions(dimensionsHintMeters, options)
    ].join('\n');
}

/** The spec without its material blocks: what the shape comparison needs to know. */
function shapeOnly(spec: ObjectBuildSpec): ObjectBuildSpec {
    return { ...spec, parts: spec.parts.map(({ material: _m, ...part }) => part) };
}

export function buildComparisonPrompt(request: string, spec: ObjectBuildSpec): string {
    return [
        `Image 1 is the reference picture of: ${request}`,
        'Image 2 is an untextured clay render of the 3D model built from the spec below, seen from a similar three-quarter view.',
        'Compare shapes only, not colour, material, lighting or background. List clear differences: missing or extra parts, wrong counts, wrong proportions, sizes or positions, parts that are detached, crossing or pointing the wrong way. Give the spec part id when one applies.',
        'confidence is exactly "high" or "low": "high" only when a difference is unmistakable, otherwise "low". Reply with an empty list when the shapes match.',
        `Spec:\n${JSON.stringify(shapeOnly(spec))}`
    ].join('\n');
}

/** How a patch reply is written, for the revision and correction prompts. */
const PATCH_REPLY_RULES = 'Reply with only what changes, as JSON matching the schema: in parts, each part you add or change, complete (it replaces the part with the same id; a new id adds a part); in removePartIds, the ids of parts to drop; boundingMeters, expectedBodies or observations only when they change. Parts you leave out stay exactly as they are.';

export function buildRevisionPrompt(request: string, spec: ObjectBuildSpec, problems: string[], dimensionsHintMeters?: Vec3, options: { materials?: boolean; patch?: boolean } = {}): string {
    return [
        `Image 1 is the reference picture of: ${request}. Image 2 is a clay render of the current build.`,
        options.patch
            ? `Correct the current build spec, following the conventions below: fix every problem listed and keep the parts that are right unchanged. ${PATCH_REPLY_RULES}`
            : 'Return the complete corrected build spec as JSON matching the schema, following the conventions below. Fix every problem listed and keep the parts that are right unchanged.',
        '',
        specConventions(dimensionsHintMeters, options),
        '',
        `Problems:\n${problems.map(p => `- ${p}`).join('\n')}`,
        '',
        `Current spec:\n${JSON.stringify(spec)}`
    ].join('\n');
}

export function buildCorrectionPrompt(errors: string[], options: { patch?: boolean } = {}): string {
    return `That build spec cannot be built:\n${errors.map(e => `- ${e}`).join('\n')}\n${options.patch ? `Correct it. ${PATCH_REPLY_RULES}` : 'Reply with the complete corrected spec as JSON matching the schema.'}`;
}

/** The schema of a patch reply: the parts that change (the spec's own part schema), the ids to drop, and the top-level fields that change. */
export function objectBuildSpecPatchJsonSchema(options: { materials: boolean }): Record<string, unknown> {
    const full = objectBuildSpecJsonSchema(options) as { properties: Record<string, any> };
    return {
        type: 'object',
        properties: {
            parts: { ...full.properties.parts, minItems: 0, description: 'Parts added or changed, each complete; a part replaces the part with the same id.' },
            removePartIds: { type: 'array', items: { type: 'string' }, description: 'Ids of parts to drop.' },
            boundingMeters: full.properties.boundingMeters,
            expectedBodies: full.properties.expectedBodies,
            observations: full.properties.observations
        },
        required: ['parts'],
        propertyOrdering: ['observations', 'boundingMeters', 'expectedBodies', 'removePartIds', 'parts']
    };
}

/**
 * A patch reply merged into `base` by part id: a part with a known id replaces that part where it stands, a new id is
 * added at the end, removePartIds drops parts, and boundingMeters, expectedBodies and observations replace the base's
 * when given (an id both removed and given is replaced; removing an id the spec lacks changes nothing). A reply that is
 * a complete spec merges the same way (every part replaced). Returns the problems when
 * the reply is not a patch; the merged spec is checked by the validator afterwards like any other.
 */
export function applySpecPatch(base: ObjectBuildSpec, patch: unknown): { spec?: ObjectBuildSpec; problems: string[] } {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return { problems: ['the reply must be a JSON object with a parts list'] };
    const p = patch as Record<string, unknown>;
    if (!Array.isArray(p.parts)) return { problems: ['the reply needs a parts list (empty when no part changes)'] };
    const problems: string[] = [];
    const remove = p.removePartIds === undefined ? [] : p.removePartIds;
    if (!Array.isArray(remove) || remove.some(id => typeof id !== 'string')) problems.push('removePartIds must be a list of part ids');
    const removing = new Set(Array.isArray(remove) ? remove.filter((id): id is string => typeof id === 'string') : []);
    const known = new Set(base.parts.map(part => part.id));
    const replacing = new Map<string, ObjectBuildSpec['parts'][number]>();
    p.parts.forEach((part, i) => {
        const id = (part as { id?: unknown } | null)?.id;
        if (!part || typeof part !== 'object' || typeof id !== 'string') { problems.push(`parts[${i}] must be a part object with an id`); return; }
        // A part both removed and given is replaced by the one given; removing an id the spec does not have changes nothing.
        removing.delete(id);
        if (replacing.has(id)) problems.push(`part "${id}" is given more than once`);
        replacing.set(id, part as ObjectBuildSpec['parts'][number]);
    });
    if (problems.length) return { problems };
    const parts = base.parts.filter(part => !removing.has(part.id)).map(part => replacing.get(part.id) ?? part);
    for (const [id, part] of replacing) if (!known.has(id)) parts.push(part);
    const spec: ObjectBuildSpec = {
        ...base,
        ...(p.boundingMeters !== undefined ? { boundingMeters: p.boundingMeters as Vec3 } : {}),
        ...(p.expectedBodies !== undefined ? { expectedBodies: p.expectedBodies as number } : {}),
        ...(p.observations !== undefined ? { observations: p.observations as string[] } : {}),
        parts
    };
    return { spec, problems: [] };
}

function buildComparisonCorrectionPrompt(error: string): string {
    return `That comparison cannot be used: ${error}\nReply again with JSON matching the schema: each difference has a problem string and confidence exactly "high" or "low".`;
}

const DIFFERENCES_JSON_SCHEMA: Record<string, unknown> = {
    type: 'object',
    properties: {
        differences: {
            type: 'array',
            items: {
                type: 'object',
                properties: {
                    partId: { type: 'string' },
                    problem: { type: 'string' },
                    confidence: { type: 'string', enum: ['high', 'low'] }
                },
                required: ['problem', 'confidence']
            }
        }
    },
    required: ['differences']
};

// ---------------------------------------------------------------------------
// Model calls
// ---------------------------------------------------------------------------

/** Ends the build at `stage` once the user has pressed stop. */
function throwIfAborted(signal: AbortSignal | undefined, stage: ObjectBuildStage): void {
    if (signal?.aborted) throw new ReferenceObjectBuildError(stage, 'Stopped by the user.', { aborted: true });
}

function responseText(response: GenerateContentResponse): string {
    return (response.candidates?.[0]?.content?.parts || []).map(p => p.text || '').join('');
}

/** One generateContent call on exactly `params.model`, retrying only 429 / 5xx answers with backoff. */
async function callModel(
    client: GenerateContentClient,
    params: GenerateContentParameters,
    stage: ObjectBuildStage,
    deps: ReferenceObjectBuilderDeps,
    signal?: AbortSignal
): Promise<GenerateContentResponse> {
    const sleep = deps.sleep ?? defaultSleep;
    for (let attempt = 0; ; attempt++) {
        throwIfAborted(signal, stage);
        try {
            return await client.models.generateContent(params);
        } catch (err) {
            // A stop aborts the request in flight: report the stop, not a model failure.
            throwIfAborted(signal, stage);
            const classified = classifyMediaGenerationError(err, params.model);
            const retryable = classified.code === 'transient' || classified.code === 'quota';
            if (retryable && attempt < MAX_TRANSIENT_RETRIES && !signal?.aborted) {
                await sleep(1000 * 2 ** attempt);
                continue;
            }
            throw new ReferenceObjectBuildError(stage,
                `${params.model} failed (${classified.code}${classified.status ? ` ${classified.status}` : ''}): ${classified.message}`,
                { model: params.model, code: classified.code, httpStatus: classified.status, modelNotFound: isModelNotFoundError(err) });
        }
    }
}

async function generateReferenceImage(
    client: GenerateContentClient,
    request: string,
    deps: ReferenceObjectBuilderDeps,
    signal?: AbortSignal,
    clay?: boolean
): Promise<{ image: ReferenceImage; answered: string }> {
    let lastFinish: string | undefined;
    // Image models sometimes finish (STOP) with no image part; ask the same model again, never another one.
    for (let attempt = 0; attempt < EMPTY_IMAGE_ATTEMPTS; attempt++) {
        const response = await callModel(client, {
            model: REFERENCE_IMAGE_MODEL,
            contents: [{ role: 'user', parts: [{ text: buildReferenceImagePrompt(request, { clay }) }] }],
            config: {
                responseModalities: ['IMAGE'],
                imageConfig: { aspectRatio: '1:1' },
                abortSignal: signal
            }
        }, 'reference-image', deps, signal);
        const blocked = response.promptFeedback?.blockReason;
        if (blocked) {
            throw new ReferenceObjectBuildError('reference-image', `${REFERENCE_IMAGE_MODEL} refused the request (${blocked}).`, { model: REFERENCE_IMAGE_MODEL, code: 'safety_filtered' });
        }
        const part = response.candidates?.[0]?.content?.parts?.find(p => p.inlineData?.data);
        if (part?.inlineData?.data) {
            return {
                image: { data: Buffer.from(part.inlineData.data, 'base64'), mimeType: part.inlineData.mimeType || 'image/png' },
                answered: response.modelVersion || REFERENCE_IMAGE_MODEL
            };
        }
        lastFinish = response.candidates?.[0]?.finishReason;
    }
    throw new ReferenceObjectBuildError('reference-image',
        `${REFERENCE_IMAGE_MODEL} returned no image in ${EMPTY_IMAGE_ATTEMPTS} attempts${lastFinish ? ` (finish reason ${lastFinish})` : ''}.`,
        { model: REFERENCE_IMAGE_MODEL, code: 'empty_image' });
}

/** The schema the reply must follow, as an instruction appended to the last user turn. */
export function schemaInstruction(schema: Record<string, unknown>): string {
    return `Reply with one JSON object only, no prose or code fences, that follows this JSON Schema exactly:\n${JSON.stringify(schema)}`;
}

/** Thinking tokens for the spec read: LOW on Gemini 4 (thinkingConfigFor), a 512-token budget on 3.x. */
export const SPEC_READ_THINKING_BUDGET = 512;

/**
 * The vision model for one build, on the shared visible fallback chain (vision-model-chain): its first call walks the
 * chat's candidate list the way chat does, only a "model not found" answer moves on to the next model, and each skipped
 * model is recorded with its error. After a model answers, every later call in the build uses that model only. Only the
 * spec read asks for LOW thinking; the comparisons keep the model's default.
 */
class VisionModel {
    private readonly chain: VisionModelChain<ObjectBuildStage>;
    /** The thinking the spec read asked for, as recorded on the result. */
    private specThinking?: VisionModelUse['thinking'];

    constructor(
        client: GenerateContentClient,
        private readonly candidates: string[],
        readonly source: 'request' | 'chat-default',
        deps: ReferenceObjectBuilderDeps,
        signal?: AbortSignal,
        /** Where this build's stage times are recorded. */
        readonly clock: BuildStageClock = new BuildStageClock()
    ) {
        this.chain = new VisionModelChain<ObjectBuildStage>({
            client,
            candidates,
            signal,
            sleep: deps.sleep ?? defaultSleep,
            makeError: (stage, message, details) => new ReferenceObjectBuildError(stage, message, { ...details })
        });
    }

    get current(): string {
        return this.chain.current;
    }

    use(): VisionModelUse {
        const used = this.chain.answeredModel ?? this.current;
        return {
            requested: this.candidates[0], used, answered: this.chain.answered ?? used, source: this.source, skipped: [...this.chain.skipped],
            ...(this.specThinking ? { thinking: this.specThinking } : {})
        };
    }

    /**
     * A failure after a model was asked, naming that model and, when it is not the chat's own, the chat's model it
     * stands in for and why that one was skipped. A stop is left as it is.
     */
    annotate(err: unknown): unknown {
        if (!(err instanceof ReferenceObjectBuildError) || !this.chain.wasAsked || err.details.aborted) return err;
        const requested = this.candidates[0];
        const chatModel = `the chat's ${this.source === 'chat-default' ? 'default ' : ''}model ${requested}`;
        const skipped = this.chain.skipped;
        const used = this.chain.answeredModel;
        // "None of the chat's models is served" already lists every skipped model.
        const note = skipped.length && !Array.isArray(err.details.skipped)
            ? ` (The spec was ${used ? 'read by' : 'asked of'} ${used ?? this.current} because ${chatModel} is not served: ${skipped.map(s => `${s.model}: ${s.reason}`).join('; ')}.)`
            : '';
        const visionModel = {
            requested,
            source: this.source,
            ...(used ? { used, answered: this.chain.answered ?? used } : { asked: this.current ?? null, answered: null }),
            skipped: [...skipped],
            ...(this.specThinking ? { thinking: this.specThinking } : {})
        };
        return new ReferenceObjectBuildError(err.stage, err.message + note, { ...err.details, visionModel });
    }

    async generate(params: Omit<GenerateContentParameters, 'model'>, stage: ObjectBuildStage, thinkingBudget?: number): Promise<GenerateContentResponse> {
        if (thinkingBudget !== undefined) this.specThinking = this.chain.thinkingFor(thinkingBudget);
        const result = await this.chain.generate(params, { stage, ...(thinkingBudget !== undefined ? { thinkingBudget } : {}) });
        if (result.thinking) this.specThinking = describeThinking(result.thinking);
        return result.response;
    }
}

interface JsonReply {
    text: string;
    value: unknown;
    parseError?: string;
}

/** The timing label of a model call: what it is for. */
type CallLabel = BuildStageTiming['stage'];

/**
 * A JSON answer from the vision model, parsed. JSON mode with the schema in the prompt: Vertex refused
 * responseJsonSchema with the spec schema on the chat model (400 INVALID_ARGUMENT, verified live), so the schema is
 * stated in the request and every reply is checked here instead.
 */
async function callJson(vision: VisionModel, contents: Content[], schema: Record<string, unknown>, stage: ObjectBuildStage, label: CallLabel, signal?: AbortSignal, thinkingBudget?: number): Promise<JsonReply> {
    const last = contents[contents.length - 1];
    const withSchema: Content[] = [...contents.slice(0, -1), { ...last, parts: [...(last.parts || []), { text: schemaInstruction(schema) }] }];
    const response = await vision.clock.time(label, () => vision.generate({
        contents: withSchema,
        config: { responseMimeType: 'application/json', temperature: 0.2, abortSignal: signal }
    }, stage, thinkingBudget), r => ({ model: vision.current, ...usageTiming(r), outputChars: responseText(r).length }));
    const blocked = response.promptFeedback?.blockReason;
    if (blocked) throw new ReferenceObjectBuildError(stage, `${vision.current} refused the request (${blocked}).`, { model: vision.current });
    const text = responseText(response);
    try {
        return { text, value: JSON.parse(text) };
    } catch (err) {
        return { text, value: undefined, parseError: `the reply was not valid JSON (${errorMessage(err)})` };
    }
}

function imagePart(data: Buffer, mimeType: string): Part {
    return { inlineData: { mimeType, data: data.toString('base64') } };
}

function parseDifferences(reply: JsonReply): { differences?: ReferenceDifference[]; error?: string } {
    if (reply.parseError) return { error: reply.parseError };
    const list = (reply.value as { differences?: unknown })?.differences;
    if (!Array.isArray(list)) return { error: 'the reply has no differences list' };
    const differences: ReferenceDifference[] = [];
    for (const d of list as any[]) {
        if (!d || typeof d.problem !== 'string' || !d.problem.trim() || (d.confidence !== 'high' && d.confidence !== 'low')) {
            return { error: `entry ${JSON.stringify(d).slice(0, 200)} needs a problem string and confidence "high" or "low"` };
        }
        differences.push({ ...(typeof d.partId === 'string' && d.partId ? { partId: d.partId } : {}), problem: d.problem, confidence: d.confidence });
    }
    return { differences };
}

/** Asks for the comparison; a malformed answer gets one corrective re-ask, then the check fails. */
async function compareToReference(
    vision: VisionModel,
    request: string,
    reference: ReferenceImage,
    render: Buffer,
    spec: ObjectBuildSpec,
    signal?: AbortSignal
): Promise<ReferenceDifference[]> {
    const contents: Content[] = [{
        role: 'user',
        parts: [referencePart(reference), imagePart(render, 'image/png'), { text: buildComparisonPrompt(request, spec) }]
    }];
    const first = await callJson(vision, contents, DIFFERENCES_JSON_SCHEMA, 'checks', 'shape-compare', signal);
    const parsed = parseDifferences(first);
    if (parsed.differences) return parsed.differences;
    const again = await callJson(vision, [
        ...contents,
        { role: 'model', parts: [{ text: first.text }] },
        { role: 'user', parts: [{ text: buildComparisonCorrectionPrompt(parsed.error!) }] }
    ], DIFFERENCES_JSON_SCHEMA, 'checks', 'shape-compare', signal);
    const reparsed = parseDifferences(again);
    if (reparsed.differences) return reparsed.differences;
    throw new ReferenceObjectBuildError('checks',
        `${vision.current} did not return a usable comparison of the build with the reference after one correction: ${reparsed.error}`,
        { model: vision.current });
}

/** The parts' current materials, one line each, as the material comparison is told them. */
function describePartMaterials(spec: ObjectBuildSpec): string {
    return spec.parts.filter(p => p.sweep || p.revolve).map(p => {
        const { description: _d, ...factors } = p.material ?? {};
        return `- ${p.id} (${p.label}): ${p.material ? JSON.stringify(factors) : 'no material (studio clay)'}`;
    }).join('\n');
}

export function buildMaterialComparisonPrompt(request: string, spec: ObjectBuildSpec): string {
    return [
        `Image 1 is the reference picture of: ${request}`,
        'Image 2 is a render of the 3D model built from it, each part in the material listed below, on the same plain #808080 backdrop under neutral white studio light, from a similar three-quarter view. The renderer is simple: it shows base colour, roughness, metalness, see-through transmission, clearcoat and glow, but no texture maps, printed patterns, wear, dirt, shadows or refraction, and the shapes may differ from the reference.',
        'Compare the surface of each part only: not shape, size, position, count, patterns, fine detail, wear or lighting. List a part when its surface clearly differs from the same part in the reference: a wrong colour or brightness, matte where it should be glossy or the reverse, metal where it should not be or the reverse, opaque where it should be see-through or the reverse, glowing where it should not or the reverse.',
        'For each, give partId (one of the ids below), the problem in a few words, and a correction holding only the factors that should change, at their corrected values: baseColor LINEAR RGB 0..1 (an sRGB channel v/255 is about (v/255)^2.2 linear; for a metal, its tint), roughness 0 mirror .. 1 chalky, metalness 1 only for bare metal, transmission 0 opaque .. about 0.9-1 clear, ior, clearcoat 0..1, emissive LINEAR RGB with emissiveStrength for a glow.',
        'confidence is exactly "high" or "low": "high" only when the difference is unmistakable, otherwise "low". Reply with an empty list when the surfaces match.',
        `Parts and their current materials:\n${describePartMaterials(spec)}`
    ].join('\n');
}

const MATERIAL_CORRECTION_PROPERTIES: Record<string, unknown> = Object.fromEntries(
    Object.entries((PART_MATERIAL_JSON_SCHEMA.properties as Record<string, unknown>)).filter(([k]) => k !== 'description'));

const MATERIAL_DIFFERENCES_JSON_SCHEMA: Record<string, unknown> = {
    type: 'object',
    properties: {
        differences: {
            type: 'array',
            items: {
                type: 'object',
                properties: {
                    partId: { type: 'string' },
                    problem: { type: 'string' },
                    confidence: { type: 'string', enum: ['high', 'low'] },
                    correction: { type: 'object', properties: MATERIAL_CORRECTION_PROPERTIES }
                },
                required: ['partId', 'problem', 'confidence', 'correction']
            }
        }
    },
    required: ['differences']
};

const MATERIAL_FACTOR_KEYS = ['baseColor', 'roughness', 'metalness', 'transmission', 'ior', 'clearcoat', 'emissive', 'emissiveStrength'] as const;

function parseMaterialDifferences(reply: JsonReply): { differences?: MaterialDifference[]; error?: string } {
    if (reply.parseError) return { error: reply.parseError };
    const list = (reply.value as { differences?: unknown })?.differences;
    if (!Array.isArray(list)) return { error: 'the reply has no differences list' };
    const differences: MaterialDifference[] = [];
    for (const d of list as any[]) {
        if (!d || typeof d.partId !== 'string' || !d.partId || typeof d.problem !== 'string' || !d.problem.trim()
            || (d.confidence !== 'high' && d.confidence !== 'low') || (d.correction !== undefined && (typeof d.correction !== 'object' || d.correction === null || Array.isArray(d.correction)))) {
            return { error: `entry ${JSON.stringify(d).slice(0, 200)} needs a partId, a problem string, confidence "high" or "low" and a correction object` };
        }
        const correction: MaterialFactors = {};
        for (const key of MATERIAL_FACTOR_KEYS) {
            if (d.correction?.[key] !== undefined && d.correction[key] !== null) (correction as Record<string, unknown>)[key] = d.correction[key];
        }
        differences.push({ partId: d.partId, problem: d.problem, confidence: d.confidence, correction });
    }
    return { differences };
}

/** Asks for the material comparison; a malformed answer gets one corrective re-ask, then the comparison fails. */
async function compareMaterialsToReference(
    vision: VisionModel,
    request: string,
    reference: ReferenceImage,
    render: Buffer,
    spec: ObjectBuildSpec,
    signal?: AbortSignal
): Promise<MaterialDifference[]> {
    const contents: Content[] = [{
        role: 'user',
        parts: [referencePart(reference), imagePart(render, 'image/png'), { text: buildMaterialComparisonPrompt(request, spec) }]
    }];
    const first = await callJson(vision, contents, MATERIAL_DIFFERENCES_JSON_SCHEMA, 'checks', 'material-compare', signal);
    const parsed = parseMaterialDifferences(first);
    if (parsed.differences) return parsed.differences;
    const again = await callJson(vision, [
        ...contents,
        { role: 'model', parts: [{ text: first.text }] },
        { role: 'user', parts: [{ text: `That comparison cannot be used: ${parsed.error}\nReply again with JSON matching the schema: each difference has partId, a problem string, confidence exactly "high" or "low" and a correction object.` }] }
    ], MATERIAL_DIFFERENCES_JSON_SCHEMA, 'checks', 'material-compare', signal);
    const reparsed = parseMaterialDifferences(again);
    if (reparsed.differences) return reparsed.differences;
    throw new ReferenceObjectBuildError('checks',
        `${vision.current} did not return a usable material comparison of the build with the reference after one correction: ${reparsed.error}`,
        { model: vision.current });
}

const sameFactor = (a: unknown, b: unknown): boolean => Array.isArray(a) && Array.isArray(b)
    ? a.length === b.length && a.every((v, i) => Math.abs(Number(v) - Number(b[i])) < 1e-3)
    : typeof a === 'number' && typeof b === 'number' ? Math.abs(a - b) < 1e-3 : a === b;

/**
 * The spec with every high-confidence material correction applied, each checked against the factor ranges (a
 * correction that names no material-bearing part, leaves a factor out of range or changes nothing is not applied,
 * and says why). Returns undefined for the spec when nothing was applied.
 */
export function applyMaterialCorrections(spec: ObjectBuildSpec, differences: MaterialDifference[]): {
    spec?: ObjectBuildSpec;
    applied: AppliedMaterialCorrection[];
    notApplied: Array<{ partId: string; reason: string }>;
} {
    const applied: AppliedMaterialCorrection[] = [];
    const notApplied: Array<{ partId: string; reason: string }> = [];
    const parts = spec.parts.map(p => ({ ...p }));
    for (const d of differences.filter(x => x.confidence === 'high')) {
        const part = parts.find(p => p.id === d.partId);
        if (!part || !(part.sweep || part.revolve)) {
            notApplied.push({ partId: d.partId, reason: 'no sweep or revolve part has this id' });
            continue;
        }
        const current: PartMaterial = part.material ?? { baseColor: [0.55, 0.57, 0.6], roughness: 0.85, metalness: 0, transmission: 0 };
        const changed = (Object.keys(d.correction) as Array<keyof MaterialFactors>).filter(k => !sameFactor(d.correction[k], current[k]));
        if (changed.length === 0) {
            notApplied.push({ partId: d.partId, reason: 'the correction changes no factor' });
            continue;
        }
        const next = { ...current, ...Object.fromEntries(changed.map(k => [k, d.correction[k]])) } as PartMaterial;
        // a glow needs its colour: a strength without emissive takes the base colour
        if (next.emissiveStrength !== undefined && next.emissiveStrength > 0 && !next.emissive) next.emissive = next.baseColor;
        const errors: string[] = [];
        validatePartMaterial(next, `part "${d.partId}"`, errors);
        if (errors.length) {
            notApplied.push({ partId: d.partId, reason: errors.join('; ') });
            continue;
        }
        applied.push({
            partId: d.partId,
            problem: d.problem,
            from: Object.fromEntries(changed.map(k => [k, current[k]])) as MaterialFactors,
            to: Object.fromEntries(changed.map(k => [k, next[k]])) as MaterialFactors
        });
        part.material = next;
    }
    return { ...(applied.length ? { spec: { ...spec, parts } } : {}), applied, notApplied };
}

/** The returned pass's own corrections were never built (no later pass is the result): recorded as not applied. */
function unbuiltCorrections(check: MaterialCheck): MaterialCheck {
    if (check.applied.length === 0) return check;
    return {
        ...check,
        applied: [],
        notApplied: [...check.notApplied, ...check.applied.map(a => ({ partId: a.partId, reason: `not built: no later pass was kept to apply it (${a.problem})` }))]
    };
}

/** How an applied material correction is told to the model in a revision (the spec it is given already has it). */
function materialCorrectionNote(c: AppliedMaterialCorrection): string {
    return `Part "${c.partId}" surface: ${c.problem}. Already corrected in the current spec (${Object.entries(c.to).map(([k, v]) => `${k} ${JSON.stringify(v)}`).join(', ')}); keep that material.`;
}

// ---------------------------------------------------------------------------
// Build and check
// ---------------------------------------------------------------------------

/** The problems in a SpecError the interpreter raised, read back from the traceback; undefined for other failures. */
export function interpreterSpecProblems(stderr: string): string[] | undefined {
    const marker = 'scratchbox.object_spec.SpecError: ';
    const at = stderr.lastIndexOf(marker);
    if (at < 0) return undefined;
    const tail = stderr.slice(at + marker.length).trim();
    const listed = tail.split('\n').filter(line => line.startsWith('- ')).map(line => line.slice(2).trim()).filter(Boolean);
    return listed.length ? listed : [tail.split('\n')[0]];
}

interface NativeBuild {
    glb: Buffer;
    glbPath: string;
    sourceCode: string;
    buildMs: number;
}

/** What the model and the user are told when a build runs past its time limit. */
export function buildTimeoutProblem(timeoutMs: number): string {
    return `The build did not finish within ${Math.round(timeoutMs / 1000)} s, so it was stopped: the spec is too heavy to build in that time. Use fewer parts, copies or relief curves, or smaller ones.`;
}

/** A spec the build rejected: the interpreter's SpecError problems, or the time limit. */
interface RejectedBuild {
    specProblems: string[];
    timedOut?: boolean;
}

/** Resolves with `work`, or throws the stop as soon as `signal` aborts (the work itself may run on, shared with others). */
async function untilStopped<T>(work: Promise<T>, signal: AbortSignal | undefined, stage: ObjectBuildStage): Promise<T> {
    if (!signal) return work;
    throwIfAborted(signal, stage);
    let onAbort: (() => void) | undefined;
    const stopped = new Promise<never>((_, reject) => {
        onAbort = () => reject(new ReferenceObjectBuildError(stage, 'Stopped by the user.', { aborted: true }));
        signal.addEventListener('abort', onAbort, { once: true });
    });
    try {
        return await Promise.race([work, stopped]);
    } finally {
        signal.removeEventListener('abort', onAbort!);
    }
}

/**
 * Makes the engine's native module ready before a build's time limit starts: after an engine change the first build
 * waits for the rebuild (a cold build takes minutes), which is not the spec's time. A rebuild that fails is the
 * 'engine' stage's error.
 */
async function prepareEngine(deps: ReferenceObjectBuilderDeps, signal: AbortSignal | undefined, reportProgress?: (message: string) => void): Promise<void> {
    let prepare = deps.prepareEngine;
    if (!prepare && !deps.runPython) {
        const runner = NativePythonRunnerService.getInstance();
        if (!runner.isNativeModuleFresh()) reportProgress?.('Building the native engine after an engine change (a cold build takes a few minutes)');
        prepare = () => runner.ensureNativeModule();
    }
    if (!prepare) return;
    const error = await untilStopped(prepare(), signal, 'engine');
    if (error) {
        throw new ReferenceObjectBuildError('engine', `The native engine could not be built, so no spec can be built: ${error}`, { engineError: error });
    }
}

/**
 * Runs the spec's script. A SpecError, or a run past the time limit, comes back as problems for the model; any other
 * failure throws.
 */
async function runBuild(
    spec: ObjectBuildSpec,
    deps: ReferenceObjectBuilderDeps,
    signal?: AbortSignal,
    reportProgress?: (message: string) => void,
    clay = false,
    clock: BuildStageClock = new BuildStageClock()
): Promise<NativeBuild | RejectedBuild> {
    throwIfAborted(signal, 'build');
    const sourceCode = buildObjectSpecScript(spec, { clay });
    await clock.time('engine', () => prepareEngine(deps, signal, reportProgress));
    throwIfAborted(signal, 'build');
    const runPython = deps.runPython ?? ((script: string, options: PythonExecutionOptions) => NativePythonRunnerService.getInstance().runScript(script, options));
    const timeoutMs = deps.buildTimeoutMs ?? BUILD_TIMEOUT_MS;
    // The time limit is a signal of its own, so a run it ends is known to have timed out (the runner's own timeout,
    // set later as a backstop, reports only a failed command). A stop kills the Python process the same way.
    const limit = new AbortController();
    const timer = setTimeout(() => limit.abort(), timeoutMs);
    const runSignal = signal ? AbortSignal.any([signal, limit.signal]) : limit.signal;
    const started = Date.now();
    let result: PythonExecutionResult;
    try {
        result = await clock.time('native-build', () => runPython(sourceCode, { timeoutMs: timeoutMs + 30_000, ...(deps.outputDir ? { outputDir: deps.outputDir } : {}), signal: runSignal }));
    } finally {
        clearTimeout(timer);
    }
    throwIfAborted(signal, 'build');
    if (!result.success && limit.signal.aborted) {
        return { specProblems: [buildTimeoutProblem(timeoutMs)], timedOut: true };
    }
    if (!result.success) {
        const stderr = result.stderr || result.errorDetails || '';
        const specProblems = interpreterSpecProblems(stderr);
        if (specProblems) return { specProblems };
        const detail = (result.errorDetails || result.stderr || `exit code ${result.exitCode}`).trim();
        throw new ReferenceObjectBuildError('build', `The native build of the spec failed: ${detail.slice(-3000)}`, { exitCode: result.exitCode });
    }
    const glb = result.glbBase64 ? Buffer.from(result.glbBase64, 'base64') : result.glbPath && fs.existsSync(result.glbPath) ? fs.readFileSync(result.glbPath) : undefined;
    if (!glb || !result.glbPath || glb.length < 20 || glb.toString('utf8', 0, 4) !== 'glTF') {
        throw new ReferenceObjectBuildError('build', 'The native build finished without writing a GLB.', { stdout: result.stdout.slice(-1000) });
    }
    return { glb, glbPath: result.glbPath, sourceCode, buildMs: Date.now() - started };
}

interface BuildableSpec {
    spec: ObjectBuildSpec;
    build: NativeBuild;
    specRequests: number;
    correctedProblems?: string[];
    /** Child parts moved to start at their attach points (normalizeChildOrigins), one note each. */
    normalized?: string[];
}

/**
 * Asks for a spec and builds it. With `base`, the first reply is a patch on it (a revision); without, a complete spec.
 * Problems the validator or the interpreter finds get one corrective re-ask that quotes all of them, answered with a
 * patch on the spec that failed when patch replies are on (a reply that was not a spec at all gets a complete re-ask);
 * a spec that still cannot be built fails (build-spec for validator problems, build for the interpreter's).
 */
async function requestBuildableSpec(
    vision: VisionModel,
    contents: Content[],
    deps: ReferenceObjectBuilderDeps,
    signal?: AbortSignal,
    reportProgress?: (message: string) => void,
    clay = false,
    base?: ObjectBuildSpec
): Promise<BuildableSpec> {
    const fullSchema = objectBuildSpecJsonSchema({ materials: !clay });
    const patchSchema = objectBuildSpecPatchJsonSchema({ materials: !clay });
    const patching = deps.patchReplies !== false;
    type Attempt = { build?: NativeBuild; spec?: ObjectBuildSpec; candidate?: ObjectBuildSpec; problems: string[]; from: 'build-spec' | 'build'; timedOut?: boolean; normalized?: string[] };
    const attempt = async (reply: JsonReply, patchOn?: ObjectBuildSpec): Promise<Attempt> => {
        if (reply.parseError) return { problems: [reply.parseError], from: 'build-spec' };
        let value: unknown = reply.value;
        if (patchOn) {
            const merged = applySpecPatch(patchOn, reply.value);
            if (!merged.spec) return { problems: merged.problems, from: 'build-spec', candidate: patchOn };
            value = merged.spec;
        }
        // Child geometry that does not start at its attach point is moved there (a translation, recorded), rather
        // than sent back for a whole corrective re-ask.
        const normalized = normalizeChildOrigins(value);
        value = normalized.value;
        const moved = normalized.notes.length ? { normalized: normalized.notes } : {};
        // A reply that has a parts list can be patched in a correction even when it is not valid yet.
        const candidate = value && typeof value === 'object' && Array.isArray((value as { parts?: unknown }).parts) ? value as ObjectBuildSpec : undefined;
        const errors = validateObjectBuildSpec(value, { requireMaterials: !clay });
        if (errors.length) return { problems: errors, from: 'build-spec', ...(candidate ? { candidate } : {}), ...moved };
        const spec = value as ObjectBuildSpec;
        const built = await runBuild(spec, deps, signal, reportProgress, clay, vision.clock);
        if ('specProblems' in built) return { problems: built.specProblems, from: 'build', candidate: spec, ...(built.timedOut ? { timedOut: true } : {}), ...moved };
        return { build: built, spec, problems: [], from: 'build', ...moved };
    };
    const finder = (a: Attempt) => a.timedOut ? 'the build ran out of time' : a.from === 'build' ? 'the interpreter found' : 'the validator found';

    const patchFirst = patching && base !== undefined;
    const first = await callJson(vision, contents, patchFirst ? patchSchema : fullSchema, 'build-spec', 'spec-read', signal, SPEC_READ_THINKING_BUDGET);
    const one = await attempt(first, patchFirst ? base : undefined);
    if (one.build && one.spec) return { spec: one.spec, build: one.build, specRequests: 1, ...(one.normalized ? { normalized: one.normalized } : {}) };

    const patchFix = patching && one.candidate !== undefined;
    const corrected = await callJson(vision, [
        ...contents,
        { role: 'model', parts: [{ text: first.text }] },
        { role: 'user', parts: [{ text: buildCorrectionPrompt(one.problems, { patch: patchFix }) }] }
    ], patchFix ? patchSchema : fullSchema, 'build-spec', 'spec-correction', signal, SPEC_READ_THINKING_BUDGET);
    const two = await attempt(corrected, patchFix ? one.candidate : undefined);
    if (two.build && two.spec) {
        const normalized = [...(one.normalized ?? []), ...(two.normalized ?? [])];
        return { spec: two.spec, build: two.build, specRequests: 2, correctedProblems: one.problems, ...(normalized.length ? { normalized } : {}) };
    }
    const errors = two.problems;
    throw new ReferenceObjectBuildError(two.from,
        `${vision.current} did not produce a buildable spec after one correction (${finder(two)}: ${errors.slice(0, 8).join('; ')}${errors.length > 8 ? `; and ${errors.length - 8} more` : ''})`,
        { model: vision.current, errors, firstErrors: one.problems, ...(two.timedOut ? { timedOut: true, timeoutMs: deps.buildTimeoutMs ?? BUILD_TIMEOUT_MS } : {}) });
}

function soupBounds(soup: TriangleSoup): { min: Vec3; max: Vec3 } {
    const min: Vec3 = [Infinity, Infinity, Infinity], max: Vec3 = [-Infinity, -Infinity, -Infinity];
    const p = soup.positions;
    for (let i = 0; i < p.length; i += 3) {
        for (let k = 0; k < 3; k++) { min[k] = Math.min(min[k], p[i + k]); max[k] = Math.max(max[k], p[i + k]); }
    }
    return { min, max };
}

const round3 = (v: number) => +v.toFixed(3);

/**
 * Whether every piece of a child part is joined to its parent: reachable from the parent's pieces through pieces of
 * the two parts that touch or embed each other (so each copy of a replicated child is covered, and a child made of
 * several touching pieces counts as attached when one of them reaches the parent).
 */
function reachesParent(childPieces: Set<number>, parentPieces: Set<number>, graph: ContactGraph): boolean {
    const allowed = new Set([...childPieces, ...parentPieces]);
    const reached = new Set(parentPieces);
    const stack = [...parentPieces];
    while (stack.length) {
        for (const next of graph.touching[stack.pop()!]) {
            if (allowed.has(next) && !reached.has(next)) { reached.add(next); stack.push(next); }
        }
    }
    return [...childPieces].every(p => reached.has(p));
}

const yieldToEventLoop = () => new Promise<void>(resolve => setImmediate(resolve));

/**
 * Measures what was modelled: every sweep and revolve part the spec lists has real geometry, every child touches
 * its parent, and the whole build is as many pieces as expectedBodies. One contact analysis of the whole build
 * answers all three, whatever the number of parts. Part ids pair parts with their meshes only. The analysis runs in
 * short slices so the server keeps answering while it measures, and a stop ends it at the next slice.
 */
export async function measureBuild(
    spec: ObjectBuildSpec,
    glb: Buffer,
    options: {
        signal?: AbortSignal;
        /** Called with the merged soup and each part's mesh (by part id) before the connectivity analysis starts. */
        onSoup?: (soup: TriangleSoup, meshes: Map<string, TriangleSoup>) => void;
    } = {}
): Promise<Omit<ObjectBuildChecks, 'differences'> & { soup: TriangleSoup; meshes: Map<string, TriangleSoup>; partBounds: PartBounds }> {
    throwIfAborted(options.signal, 'checks');
    let named: Map<string, TriangleSoup> | null;
    try {
        named = await glbToNamedTriangleSoupsAsync(glb, { signal: options.signal });
    } catch (err) {
        throwIfAborted(options.signal, 'checks');
        throw err;
    }
    const meshes = named ? [...named].filter(([, s]) => s.indices.length > 0) : [];
    if (meshes.length === 0) {
        throw new ReferenceObjectBuildError('checks', 'The built GLB could not be read back for checking.');
    }
    // The whole build as one soup, each mesh's triangles a known range of it.
    const soup = mergeTriangleSoups(meshes.map(([, s]) => s));
    const triangleRange = new Map<string, [number, number]>();
    let first = 0;
    for (const [id, s] of meshes) {
        triangleRange.set(id, [first, first + s.indices.length / 3]);
        first += s.indices.length / 3;
    }
    const meshMap = new Map(meshes);
    options.onSoup?.(soup, meshMap);
    await yieldToEventLoop();
    let whole: PartConnectivityReport;
    try {
        whole = await analyzePartConnectivityAsync(soup, { withGraph: true, signal: options.signal });
    } catch (err) {
        throwIfAborted(options.signal, 'checks');
        throw err;
    }
    const { min, max } = soupBounds(soup);

    const parts: PartBuildCheck[] = spec.parts.filter(p => p.sweep || p.revolve).map(p => {
        const own = named!.get(p.id);
        const triangles = own ? own.indices.length / 3 : 0;
        const b = own && triangles ? soupBounds(own) : undefined;
        const sizeMeters: Vec3 = b ? [round3(b.max[0] - b.min[0]), round3(b.max[1] - b.min[1]), round3(b.max[2] - b.min[2])] : [0, 0, 0];
        const built = triangles > 0 && sizeMeters.every(Number.isFinite) && Math.max(...sizeMeters) > 1e-4;
        return { id: p.id, triangles, sizeMeters, built, ...(p.parentId ? { parentId: p.parentId } : {}) };
    });

    // Without the graph (the analysis was skipped) nothing is judged detached here; the skipped check fails below.
    const graph = whole.graph;
    if (graph) {
        const piecesOf = (id: string): Set<number> => {
            const [from, to] = triangleRange.get(id)!;
            const pieces = new Set<number>();
            for (let t = from; t < to; t++) pieces.add(graph.trianglePiece[t]);
            return pieces;
        };
        const byId = new Map(parts.map(p => [p.id, p]));
        for (const part of parts) {
            if (!part.parentId || !part.built || !byId.get(part.parentId)?.built) continue;
            part.touchesParent = reachesParent(piecesOf(part.id), piecesOf(part.parentId), graph);
        }
    }

    const partBounds: PartBounds = new Map(meshes.map(([id, s]) => [id, soupBounds(s)]));
    return {
        soup,
        meshes: meshMap,
        partBounds,
        vertexCount: soup.positions.length / 3,
        triangleCount: soup.indices.length / 3,
        parts,
        missingParts: parts.filter(p => !p.built).map(p => p.id),
        detachedParts: parts.filter(p => p.touchesParent === false).map(p => ({ id: p.id, parentId: p.parentId! })),
        connectivity: {
            // A check that could not run is not a pass.
            passed: !whole.skippedReason && whole.structureCount === spec.expectedBodies,
            bodies: whole.structureCount,
            expectedBodies: spec.expectedBodies,
            floatingParts: whole.floatingParts,
            toleranceMeters: whole.toleranceMeters,
            ...(whole.skippedReason ? { skippedReason: whole.skippedReason } : {})
        },
        builtBoundingMeters: [round3(max[0] - min[0]), round3(max[1] - min[1]), round3(max[2] - min[2])]
    };
}

/** Every listed part built, every child on its parent, and the piece count the spec intends. */
export function passedEveryCheck(checks: Pick<ObjectBuildChecks, 'missingParts' | 'detachedParts' | 'connectivity'>): boolean {
    return checks.missingParts.length === 0 && checks.detachedParts.length === 0 && checks.connectivity.passed;
}

interface CheckedPass {
    pass: number;
    spec: ObjectBuildSpec;
    build: NativeBuild;
    render: Buffer;
    checks: ObjectBuildChecks;
    partBounds: PartBounds;
    /** Each part's mesh, by part id (a material-only pass re-renders these with the corrected materials). */
    meshes: Map<string, TriangleSoup>;
    /** What is left to fix after this pass (empty when nothing is). */
    problems: string[];
    /** Why the comparison with the reference could not be had; the pass is then measured but not compared. */
    comparisonError?: string;
    /** The comparison of the material render with the reference (a build that is not clay). */
    material?: MaterialCheck;
    /** The spec with this pass's material corrections applied, when any were. */
    materialFixedSpec?: ObjectBuildSpec;
}

/** Times a synchronous render as a 'render' stage of the current pass. */
function timedRender<T>(clock: BuildStageClock, stage: BuildStageTiming['stage'], work: () => T): T {
    const started = Date.now();
    const value = work();
    clock.timings.push({ stage, pass: clock.pass, startMs: clock.elapsedMs - (Date.now() - started), ms: Date.now() - started });
    return value;
}

/**
 * Renders the build in its materials and asks the vision model for the material differences from the reference;
 * the high-confidence corrections are applied to a copy of the spec. A comparison that cannot be had is recorded as
 * such (the pass is then not material-checked); a stop is rethrown.
 */
async function checkMaterials(
    pass: number,
    spec: ObjectBuildSpec,
    meshes: Map<string, TriangleSoup>,
    input: ReferenceObjectBuildRequest,
    vision: VisionModel,
    reference: ReferenceImage,
    signal: AbortSignal
): Promise<{ check: MaterialCheck; fixedSpec?: ObjectBuildSpec; error?: unknown }> {
    try {
        const byId = new Map(spec.parts.map(p => [p.id, p]));
        const render = timedRender(vision.clock, 'material-render', () => renderMaterialPreview(
            materialPreviewMeshes(meshes, id => byId.get(id)?.material), THREE_QUARTER_VIEW[0], 512));
        const differences = await compareMaterialsToReference(vision, input.request, reference, render, spec, signal);
        const fixed = applyMaterialCorrections(spec, differences);
        return { check: { pass, differences, applied: fixed.applied, notApplied: fixed.notApplied }, ...(fixed.spec ? { fixedSpec: fixed.spec } : {}) };
    } catch (error) {
        return { check: { pass, differences: [], applied: [], notApplied: [], error: errorMessage(error) }, error };
    }
}

/** A material comparison that failed for a stop (or a fault that is not the builder's own) ends the build. */
function rethrowMaterialStop(result: { error?: unknown }, signal?: AbortSignal): void {
    const err = result.error;
    if (err === undefined) return;
    if (!(err instanceof ReferenceObjectBuildError) || err.details.aborted || signal?.aborted) throw err;
}

/**
 * Measures a pass and compares its clay render with the reference and, unless the build is clay, its material render
 * too (the two comparisons run together, while the contact analysis runs). A comparison that cannot be had leaves the
 * pass measured but not compared on that count (its differences unknown), so a build that passed every check is never
 * thrown away for it; a stop still ends the build.
 */
async function checkBuild(
    pass: number,
    spec: ObjectBuildSpec,
    build: NativeBuild,
    input: ReferenceObjectBuildRequest,
    vision: VisionModel,
    reference: ReferenceImage,
    clay = false
): Promise<CheckedPass> {
    input.reportProgress?.(`Checking pass ${pass}: every part built and attached, and comparing it with the reference`);
    // The comparisons need only the renders, which need only the read-back meshes: they start as soon as the meshes
    // are read and run while the connectivity analysis does. A measuring failure stops them.
    const compareStop = new AbortController();
    const compareSignal = input.signal ? AbortSignal.any([input.signal, compareStop.signal]) : compareStop.signal;
    let render: Buffer | undefined;
    let comparing: Promise<{ differences: ReferenceDifference[]; error?: unknown }> | undefined;
    let materialComparing: Promise<Awaited<ReturnType<typeof checkMaterials>>> | undefined;
    const startComparison = (soup: TriangleSoup, meshes: Map<string, TriangleSoup>) => {
        render = timedRender(vision.clock, 'render', () => renderReviewViews(soup, 512, { views: THREE_QUARTER_VIEW })[0].png);
        comparing = compareToReference(vision, input.request, reference, render, spec, compareSignal)
            .then(differences => ({ differences }), error => ({ differences: [], error }));
        if (!clay) materialComparing = checkMaterials(pass, spec, meshes, input, vision, reference, compareSignal);
    };
    let measuredBuild: Awaited<ReturnType<typeof measureBuild>>;
    try {
        measuredBuild = await vision.clock.time('measure', () => measureBuild(spec, build.glb, { signal: input.signal, onSoup: startComparison }));
    } catch (err) {
        compareStop.abort();
        await Promise.all([comparing, materialComparing]);
        throw err;
    }
    const { soup, meshes, partBounds, ...measured } = measuredBuild;
    throwIfAborted(input.signal, 'checks');
    if (!comparing) startComparison(soup, meshes);
    const [compared, materials] = await Promise.all([comparing!, materialComparing]);
    let differences: ReferenceDifference[] = compared.differences;
    let comparisonError: string | undefined;
    if (compared.error !== undefined) {
        const err = compared.error;
        if (!(err instanceof ReferenceObjectBuildError) || err.details.aborted || input.signal?.aborted) throw err;
        comparisonError = err.message;
        differences = [];
    }
    if (materials) rethrowMaterialStop(materials, input.signal);
    const checks: ObjectBuildChecks = { ...measured, differences };
    return {
        pass, spec, build, render: render!, checks, partBounds, meshes,
        problems: describeProblems(checks, spec, partBounds),
        ...(comparisonError ? { comparisonError } : {}),
        ...(materials ? { material: materials.check } : {}),
        ...(materials?.fixedSpec ? { materialFixedSpec: materials.fixedSpec } : {})
    };
}

/**
 * A pass that only applies the previous pass's material corrections: the geometry is unchanged, so the spec is rebuilt
 * natively (for the GLB) while the corrected materials are rendered on the previous pass's meshes and compared with
 * the reference again. The structural checks and the shape comparison carry over from the previous pass.
 */
async function materialOnlyPass(
    pass: number,
    previous: CheckedPass,
    spec: ObjectBuildSpec,
    input: ReferenceObjectBuildRequest,
    vision: VisionModel,
    reference: ReferenceImage,
    deps: ReferenceObjectBuilderDeps
): Promise<CheckedPass> {
    input.reportProgress?.(`Pass ${pass}: applying ${previous.material?.applied.length ?? 0} material correction(s) and checking them against the reference`);
    const compareStop = new AbortController();
    const compareSignal = input.signal ? AbortSignal.any([input.signal, compareStop.signal]) : compareStop.signal;
    const materialComparing = checkMaterials(pass, spec, previous.meshes, input, vision, reference, compareSignal);
    let built: NativeBuild | RejectedBuild;
    try {
        built = await runBuild(spec, deps, input.signal, input.reportProgress, false, vision.clock);
    } catch (err) {
        compareStop.abort();
        await materialComparing;
        throw err;
    }
    if ('specProblems' in built) {
        compareStop.abort();
        await materialComparing;
        throw new ReferenceObjectBuildError('build', `The material corrections could not be built: ${built.specProblems.join('; ')}`, { errors: built.specProblems });
    }
    const materials = await materialComparing;
    rethrowMaterialStop(materials, input.signal);
    return {
        ...previous,
        pass,
        spec,
        build: built,
        material: materials.check,
        ...(materials.fixedSpec ? { materialFixedSpec: materials.fixedSpec } : { materialFixedSpec: undefined })
    };
}

/** World-space bounds of each part's mesh, by part id. */
export type PartBounds = Map<string, { min: Vec3; max: Vec3 }>;

/** Which parts' meshes contain a point, to name the pieces of a floating group in the revision request. */
function partsAt(center: Vec3, partBounds?: PartBounds): string[] {
    if (!partBounds) return [];
    return [...partBounds].filter(([, b]) => [0, 1, 2].every(k => center[k] >= b.min[k] - 1e-3 && center[k] <= b.max[k] + 1e-3)).map(([id]) => id);
}

/** Problems that come from the comparison with the reference, as opposed to the measured checks. */
function differenceProblem(d: ReferenceDifference): string {
    return `${d.partId ? `Part "${d.partId}": ` : ''}${d.problem}`;
}

/** What the vision model must fix after a pass; empty when nothing is left to fix. */
export function describeProblems(checks: ObjectBuildChecks, spec: ObjectBuildSpec, partBounds?: PartBounds): string[] {
    const problems: string[] = [];
    for (const id of checks.missingParts) {
        problems.push(`Part "${id}" produced no usable geometry; give it a real size and shape.`);
    }
    for (const d of checks.detachedParts) {
        problems.push(`Part "${d.id}" does not touch its parent "${d.parentId}". Attach it at a point on "${d.parentId}"'s surface (attach u and angleDeg) with a small negative normalOffsetMeters so it sinks in, and keep its own geometry starting at that point.`);
    }
    const c = checks.connectivity;
    if (c.skippedReason) {
        problems.push(`Part connections could not be checked (${c.skippedReason}); use fewer copies or parts.`);
    } else if (c.bodies !== c.expectedBodies) {
        const groups = c.floatingParts.slice(0, 6).map(f => {
            const near = partsAt(f.center, partBounds);
            return `a piece at [${f.center.join(', ')}] sized [${f.size.join(', ')}] m${near.length ? ` (parts ${near.join(', ')})` : ''}, ${f.gapMeters >= 0.5 ? 'over 50 cm' : `${(f.gapMeters * 100).toFixed(1)} cm`} from the main body`;
        });
        problems.push(`The build is ${c.bodies} separate pieces but expectedBodies is ${c.expectedBodies}.${groups.length ? ` Not joined: ${groups.join('; ')}.` : ''} Attach each part to the one it touches (parentId + attach), or set expectedBodies if the pieces really are separate.`);
    }
    for (const d of checks.differences.filter(x => x.confidence === 'high')) {
        problems.push(differenceProblem(d));
    }
    // A size disagreement counts when it is large both relatively and against the object's overall size.
    const scale = Math.max(...spec.boundingMeters);
    const offSize = checks.builtBoundingMeters.some((v, k) => {
        const ratio = v / spec.boundingMeters[k];
        return (ratio < 0.67 || ratio > 1.5) && Math.abs(v - spec.boundingMeters[k]) > 0.1 * scale;
    });
    if (offSize) {
        problems.push(`The built object measures ${checks.builtBoundingMeters.join(' x ')} m but boundingMeters says ${spec.boundingMeters.join(' x ')} m; make the parts and the stated size agree.`);
    }
    return problems;
}

function passRecord(checked: CheckedPass, source: ObjectBuildPass['source'], requested?: BuildableSpec): ObjectBuildPass {
    const c = checked.checks;
    const m = checked.material;
    return {
        pass: checked.pass,
        source,
        outcome: 'built',
        ...(requested ? { specRequests: requested.specRequests } : {}),
        ...(requested?.correctedProblems ? { correctedProblems: requested.correctedProblems } : {}),
        ...(requested?.normalized ? { normalizedChildren: requested.normalized } : {}),
        vertexCount: c.vertexCount,
        triangleCount: c.triangleCount,
        partsBuilt: c.parts.filter(p => p.built).length,
        partsListed: c.parts.length,
        detachedParts: c.detachedParts.map(d => d.id),
        bodies: c.connectivity.bodies,
        expectedBodies: c.connectivity.expectedBodies,
        passedChecks: passedEveryCheck(c),
        ...(checked.comparisonError
            ? { comparisonError: checked.comparisonError }
            : { highConfidenceDifferences: c.differences.filter(d => d.confidence === 'high').length }),
        ...(m?.error ? { materialComparisonError: m.error } : {}),
        ...(m && !m.error ? { materialDifferences: m.differences.filter(d => d.confidence === 'high').length, materialCorrections: m.applied.length } : {}),
        problems: checked.problems,
        buildMs: checked.build.buildMs
    };
}

export interface SpecObjectBuildResult {
    spec: ObjectBuildSpec;
    clay: boolean;
    materials: MaterialProvenance;
    sourceCode: string;
    glb: Buffer;
    glbPath: string;
    /** The measured checks; there is no comparison with a reference, so no differences. */
    checks: Omit<ObjectBuildChecks, 'differences'>;
    /** Problems that do not stop the build (such as its size disagreeing with boundingMeters). */
    openProblems: string[];
    buildMs: number;
}

/** How a build's materials are labelled: read from the generated reference, as written in a given spec, or clay. */
export function describeMaterialProvenance(spec: ObjectBuildSpec, how: { clay: boolean; source: 'reference' | 'spec'; imageModel?: string; visionModel?: string }): MaterialProvenance {
    if (how.clay) return { label: 'clay', note: 'Clay build: every part is studio clay, no materials were read.', clayParts: [] };
    const clayParts = partsWithoutMaterial(spec);
    const missing = clayParts.length ? ` Parts without a material are studio clay: ${clayParts.join(', ')}.` : '';
    if (how.source === 'reference') {
        return {
            label: 'generated',
            note: `Part materials (colour, roughness, metalness, transmission, ior, clearcoat, emission) were read by ${how.visionModel ?? 'the vision model'} from a reference image drawn by ${how.imageModel ?? REFERENCE_IMAGE_MODEL}: inferred from a generated picture, not measured from the real object. Factors only, no texture maps.${missing}`,
            clayParts
        };
    }
    return {
        label: 'as-given',
        note: `Part materials are as written in the given spec (a reference build reads them from a generated image; they are never measured). Factors only, no texture maps.${missing}`,
        clayParts
    };
}

/**
 * The GLB with each material's provenance in its extras (materials[i].extras.scratchbox: provenance, note, the part
 * it belongs to and the spec's description) and the build's in asset.extras.scratchbox.materialProvenance. Geometry
 * and the binary chunk are unchanged.
 */
export function stampMaterialProvenance(glb: Buffer, spec: ObjectBuildSpec, provenance: MaterialProvenance): Buffer {
    if (glb.length < 20 || glb.toString('utf8', 0, 4) !== 'glTF' || glb.readUInt32LE(16) !== 0x4E4F534A) return glb;
    const jsonLength = glb.readUInt32LE(12);
    const json = JSON.parse(glb.toString('utf8', 20, 20 + jsonLength));
    const byId = new Map(spec.parts.map(p => [p.id, p]));
    for (const mesh of json.meshes || []) {
        for (const prim of mesh.primitives || []) {
            const material = typeof prim.material === 'number' ? json.materials?.[prim.material] : undefined;
            if (!material) continue;
            const part = byId.get(mesh.name);
            const own = !provenance.clayParts.includes(mesh.name) && provenance.label !== 'clay';
            material.extras = {
                ...(material.extras || {}),
                scratchbox: {
                    partId: mesh.name,
                    provenance: own ? provenance.label : 'clay',
                    ...(own && part?.material?.description ? { description: part.material.description } : {})
                }
            };
        }
    }
    json.asset = { ...(json.asset || {}), extras: { ...(json.asset?.extras || {}), scratchbox: { ...(json.asset?.extras?.scratchbox || {}), materialProvenance: { label: provenance.label, note: provenance.note } } } };
    let text = JSON.stringify(json);
    while (Buffer.byteLength(text) % 4) text += ' ';
    const jsonChunk = Buffer.from(text, 'utf8');
    const rest = glb.subarray(20 + jsonLength);
    const header = Buffer.alloc(20);
    header.write('glTF', 0, 'ascii');
    header.writeUInt32LE(2, 4);
    header.writeUInt32LE(20 + jsonChunk.length + rest.length, 8);
    header.writeUInt32LE(jsonChunk.length, 12);
    header.writeUInt32LE(0x4E4F534A, 16);
    return Buffer.concat([header, jsonChunk, rest]);
}

/** The build with its material provenance stamped into the GLB in memory and on disk. */
function stampBuild(build: NativeBuild, spec: ObjectBuildSpec, provenance: MaterialProvenance): NativeBuild {
    const glb = stampMaterialProvenance(build.glb, spec, provenance);
    if (glb !== build.glb) fs.writeFileSync(build.glbPath, glb);
    return { ...build, glb };
}

/**
 * Builds a spec exactly as given, typically an edit of an earlier build's spec: no reference image, no model call
 * and no comparison. A spec the validator or the interpreter rejects, or a build that fails its checks (a part not
 * built, a child off its parent, a piece count other than expectedBodies), throws with every problem listed for the
 * caller to fix; nothing is revised here and nothing failing is returned.
 */
export async function buildObjectFromSpec(
    spec: unknown,
    input: Pick<ReferenceObjectBuildRequest, 'signal' | 'reportProgress' | 'clay'> = {},
    deps: ReferenceObjectBuilderDeps = {}
): Promise<SpecObjectBuildResult> {
    const clay = input.clay === true;
    const errors = validateObjectBuildSpec(spec);
    if (errors.length) {
        throw new ReferenceObjectBuildError('build-spec', `The spec cannot be built (the validator found: ${errors.join('; ')})`, { errors });
    }
    const valid = spec as ObjectBuildSpec;
    input.reportProgress?.('Building the spec natively', 0.2);
    const built = await runBuild(valid, deps, input.signal, input.reportProgress, clay);
    if ('specProblems' in built) {
        throw new ReferenceObjectBuildError('build',
            `The spec cannot be built (${built.timedOut ? 'the build ran out of time' : 'the interpreter found'}: ${built.specProblems.join('; ')})`,
            { errors: built.specProblems, ...(built.timedOut ? { timedOut: true, timeoutMs: deps.buildTimeoutMs ?? BUILD_TIMEOUT_MS } : {}) });
    }
    input.reportProgress?.('Checking that every part is built and attached', 0.8);
    const { soup: _soup, partBounds, ...measured } = await measureBuild(valid, built.glb, { signal: input.signal });
    const problems = describeProblems({ ...measured, differences: [] }, valid, partBounds);
    if (!passedEveryCheck(measured)) {
        throw new ReferenceObjectBuildError('checks', `The build does not pass its checks, so nothing was mounted: ${problems.join(' ')}`,
            { problems, connectivity: measured.connectivity, missingParts: measured.missingParts, detachedParts: measured.detachedParts });
    }
    const materials = describeMaterialProvenance(valid, { clay, source: 'spec' });
    const stamped = stampBuild(built, valid, materials);
    return { spec: valid, clay, materials, sourceCode: stamped.sourceCode, glb: stamped.glb, glbPath: stamped.glbPath, checks: measured, openProblems: problems, buildMs: stamped.buildMs };
}

/**
 * Builds a request as native clay geometry from an internal reference image. Throws ReferenceObjectBuildError
 * for any stage that cannot do what it was asked.
 */
export async function buildObjectFromReference(
    input: ReferenceObjectBuildRequest,
    deps: ReferenceObjectBuilderDeps = {}
): Promise<ReferenceObjectBuildResult> {
    if (!input.request?.trim()) throw new ReferenceObjectBuildError('build-spec', 'Nothing to build: the request is empty.');
    const chat = deps.chat ?? defaultChat();
    const requestedModel = input.requestedModel?.trim() || undefined;
    const candidates = chat.getModelCandidates(requestedModel).filter(m => typeof m === 'string' && m.trim());
    if (candidates.length === 0) throw new ReferenceObjectBuildError('build-spec', 'The chat has no model to read the reference with.');
    const client = await chat.getGenAIClient();
    if (!client) throw new ReferenceObjectBuildError('credentials', 'No Google API key or service account configured');
    const backend: ReferenceObjectBuildResult['backend'] = client.vertexai === true ? 'vertex' : client.vertexai === false ? 'api-key' : 'injected';
    const progress = input.reportProgress ?? (() => undefined);
    const clock = new BuildStageClock();
    const vision = new VisionModel(client, candidates, requestedModel ? 'request' : 'chat-default', deps, input.signal, clock);

    progress(`Drawing an internal reference with ${REFERENCE_IMAGE_MODEL}`, 0.05);
    const clay = input.clay === true;
    let generated: { image: ReferenceImage; answered: string } | undefined = await clock.time('reference-image',
        () => generateReferenceImage(client, input.request, deps, input.signal, clay), g => ({ model: g.answered }));
    let uploadedName: string | undefined;
    try {
        const prepared = await clock.time('reference-prep', () => prepareReferenceForReading(client as FilesCapableClient, generated!.image, input.signal));
        uploadedName = prepared.uploadedName;
        const reference = prepared.reference;
        const imageModel: ModelUse = { requested: REFERENCE_IMAGE_MODEL, answered: generated.answered };

        progress(`Reading the reference into a build spec with ${vision.current}`, 0.2);
        const firstSpec = await requestBuildableSpec(vision, [{
            role: 'user',
            parts: [referencePart(reference), { text: buildSpecPrompt(input.request, input.dimensionsHintMeters, { materials: !clay }) }]
        }], deps, input.signal, progress, clay);
        let current = await checkBuild(1, firstSpec.spec, firstSpec.build, input, vision, reference, clay);
        const passes: ObjectBuildPass[] = [passRecord(current, 'reference', firstSpec)];
        const checkedPasses = new Map<number, CheckedPass>([[1, current]]);
        let accepted: CheckedPass | undefined = passedEveryCheck(current.checks) ? current : undefined;
        let revisionFailed: RevisionFailure | undefined;

        // A pass with shape or structural problems gets a revision from the vision model (its material corrections
        // already applied to the spec it is given); a pass whose only problems are material corrections gets a
        // material-only pass: the corrected spec rebuilt, no model call for the spec.
        for (let revision = 1; revision <= MAX_REVISION_PASSES && (current.problems.length > 0 || current.materialFixedSpec); revision++) {
            throwIfAborted(input.signal, 'build-spec');
            const pass = revision + 1;
            clock.pass = pass;
            const fixes = current.material?.applied ?? [];
            try {
                if (current.problems.length === 0 && current.materialFixedSpec) {
                    progress(`Revision ${revision}: correcting ${fixes.length} part material${fixes.length === 1 ? '' : 's'}`, 0.35 + 0.25 * revision);
                    const checked = await materialOnlyPass(pass, current, current.materialFixedSpec, input, vision, reference, deps);
                    passes.push(passRecord(checked, 'material'));
                    checkedPasses.set(pass, checked);
                    current = checked;
                    if (passedEveryCheck(checked.checks)) accepted = checked;
                    continue;
                }
                const count = current.problems.length + fixes.length;
                progress(`Revision ${revision}: fixing ${count} problem${count === 1 ? '' : 's'}`, 0.35 + 0.25 * revision);
                const revised = await requestBuildableSpec(vision, [{
                    role: 'user',
                    parts: [
                        referencePart(reference),
                        imagePart(current.render, 'image/png'),
                        { text: buildRevisionPrompt(input.request, current.materialFixedSpec ?? current.spec, [...current.problems, ...fixes.map(materialCorrectionNote)], input.dimensionsHintMeters, { materials: !clay, patch: deps.patchReplies !== false }) }
                    ]
                }], deps, input.signal, progress, clay, current.materialFixedSpec ?? current.spec);
                const checked = await checkBuild(pass, revised.spec, revised.build, input, vision, reference, clay);
                passes.push(passRecord(checked, 'revision', revised));
                checkedPasses.set(pass, checked);
                current = checked;
                if (passedEveryCheck(checked.checks)) accepted = checked;
            } catch (err) {
                // A stop or an unexpected fault ends the build; a revision that cannot be built or measured ends the
                // revisions, and the result says so. (A comparison that cannot be had does not: checkBuild keeps the
                // pass, measured but not compared.)
                if (!(err instanceof ReferenceObjectBuildError) || err.details.aborted || input.signal?.aborted) throw err;
                revisionFailed = { pass, stage: err.stage, reason: err.message };
                passes.push({ pass, source: 'revision', outcome: 'failed', ...(Array.isArray(err.details.firstErrors) ? { specRequests: 2 } : {}), error: err.message });
                break;
            }
        }

        // The last pass built but still fails its structural checks: an earlier pass that passed them is the result.
        if (!revisionFailed && accepted && accepted !== current) {
            revisionFailed = {
                pass: current.pass,
                stage: 'checks',
                reason: `pass ${current.pass}, the last revision, still fails its checks: ${current.problems.filter((_, i) => i < 4).join(' ')}`
            };
        }
        if (!accepted) {
            const last = passes[passes.length - 1];
            const why = revisionFailed ? `revision pass ${revisionFailed.pass} failed (${revisionFailed.reason}); ` : '';
            throw new ReferenceObjectBuildError('checks',
                `No build passed every check, so nothing was mounted: ${why}pass ${current.pass} still has these problems: ${current.problems.join(' ')}`,
                { passes, lastPass: last, connectivity: current.checks.connectivity, missingParts: current.checks.missingParts, detachedParts: current.checks.detachedParts, spec: current.spec, timings: clock.timings, totalMs: clock.elapsedMs });
        }
        // The passes the returned build descends from (a later pass that failed its checks is not one of them).
        const lineage = new Set([...checkedPasses.keys()].filter(p => p <= accepted!.pass));
        // The returned build still has material corrections and no revision was left to apply them: one material-only
        // pass applies them (same geometry, a native rebuild and one material comparison, no spec call). Only once.
        if (accepted.materialFixedSpec) {
            const pass = passes.length + 1;
            clock.pass = pass;
            try {
                const fixed = await materialOnlyPass(pass, accepted, accepted.materialFixedSpec, input, vision, reference, deps);
                passes.push(passRecord(fixed, 'material'));
                checkedPasses.set(pass, fixed);
                lineage.add(pass);
                accepted = fixed;
            } catch (err) {
                if (!(err instanceof ReferenceObjectBuildError) || err.details.aborted || input.signal?.aborted) throw err;
                passes.push({ pass, source: 'material', outcome: 'failed', error: err.message });
            }
        }
        // The returned pass could not be compared: say so, and which differences it was asked to fix are unchecked.
        const comparisonFailed: ComparisonFailure | undefined = accepted.comparisonError
            ? {
                pass: accepted.pass,
                reason: accepted.comparisonError,
                unverifiedDifferences: (checkedPasses.get(accepted.pass - 1)?.checks.differences || []).filter(d => d.confidence === 'high')
            }
            : undefined;
        const visionModel = vision.use();
        const materials = describeMaterialProvenance(accepted.spec, { clay, source: 'reference', imageModel: imageModel.answered, visionModel: visionModel.used });
        const stamped = stampBuild(accepted.build, accepted.spec, materials);
        return {
            spec: accepted.spec,
            clay,
            materials,
            sourceCode: stamped.sourceCode,
            glb: stamped.glb,
            glbPath: stamped.glbPath,
            imageModel,
            visionModel,
            backend,
            passes,
            resultPass: accepted.pass,
            ...(revisionFailed ? { revisionFailed } : {}),
            ...(comparisonFailed ? { comparisonFailed } : {}),
            checks: accepted.checks,
            remainingDifferences: accepted.checks.differences.filter(d => d.confidence === 'high'),
            materialChecks: [...checkedPasses.values()].filter(c => lineage.has(c.pass) && c.material).map(c => c.pass === accepted!.pass ? unbuiltCorrections(c.material!) : c.material!),
            remainingMaterialDifferences: (accepted.material?.differences ?? []).filter(d => d.confidence === 'high'),
            timings: clock.timings,
            totalMs: clock.elapsedMs,
            openProblems: accepted.problems.filter(p => !accepted!.checks.differences.some(d => d.confidence === 'high' && differenceProblem(d) === p))
        };
    } catch (err) {
        const annotated = vision.annotate(err);
        if (annotated instanceof ReferenceObjectBuildError && !annotated.details.timings) Object.assign(annotated.details, { timings: clock.timings, totalMs: clock.elapsedMs });
        throw annotated;
    } finally {
        // The reference lived in memory (and, on the Gemini API, as an uploaded file for this build's calls); drop
        // both so nothing outlives the call.
        generated = undefined;
        const files = (client as FilesCapableClient).files;
        if (uploadedName && files?.delete) await files.delete({ name: uploadedName }).catch(() => undefined);
    }
}
