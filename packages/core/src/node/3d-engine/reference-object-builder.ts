/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Object or abstract-form request -> native clay geometry, in four stages:
 *   1. Reference: Nano Banana Lite (gemini-3.1-flash-lite-image, exactly that model) draws one isolated grey object.
 *      The image stays a Buffer in this process: it is never written to disk, the media store, public/ or the chat.
 *   2. Build spec: the model chat runs on (the request's model, else the chat's default, walking the chat's own
 *      fallback list on "model not found" and saying so) reads the reference into an ObjectBuildSpec, on the chat's
 *      credentials. A spec the validator or the interpreter cannot build, or whose build runs past its time limit,
 *      gets one corrective re-ask quoting every problem, then the call fails.
 *   3. Build: sb.object_spec.build(spec) runs in the native Python engine and writes a GLB, within BUILD_TIMEOUT_MS
 *      (a run past it is stopped and reported as having run out of time). The time limit starts once the engine's
 *      native module is ready: a rebuild after an engine change is waited for first, and a failed one is its own
 *      stage ('engine'), never blamed on the spec.
 *   4. Checks: every part the spec lists is built and touches its parent, the piece count equals expectedBodies, and
 *      the vision model compares a clay render with the reference. The contact analysis runs in slices, so the
 *      server keeps answering and a stop ends it. Problems and high-confidence differences go back
 *      for up to two revision passes. The result is the last build that passed every check; a revision that fails
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
    OBJECT_BUILD_SPEC_JSON_SCHEMA,
    buildObjectSpecScript,
    validateObjectBuildSpec,
    type ObjectBuildSpec,
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
    signal?: AbortSignal;
    reportProgress?: (message: string, fraction?: number) => void;
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
}

export interface ReferenceDifference {
    partId?: string;
    problem: string;
    confidence: 'high' | 'low';
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
    /** reference: the first pass from the reference; revision: a pass that fixes problems; spec: a spec rebuilt as given. */
    source: 'reference' | 'revision' | 'spec';
    /** 'built' when the pass produced a checked build; 'failed' when its spec could not be built or checked. */
    outcome: 'built' | 'failed';
    /** Spec requests the pass took: 1, or 2 when the first answer needed the corrective re-ask. */
    specRequests?: number;
    /** The problems quoted back in the corrective re-ask, when there was one. */
    correctedProblems?: string[];
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
    /** Other problems still present in the returned build (such as its size disagreeing with boundingMeters). */
    openProblems: string[];
}

interface ReferenceImage {
    data: Buffer;
    mimeType: string;
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

export function buildReferenceImagePrompt(request: string): string {
    return [
        `Reference picture for building a 3D model of: ${request}`,
        'Show exactly one complete object, whole and uncropped, centred and filling most of the square frame, in a three-quarter view from slightly above.',
        'Render it as matte, untextured, uniform mid-grey clay: no colour, pattern, text, logos or decals, so only its shape reads.',
        'Plain flat #808080 background with even, shadowless studio light. No floor, ground plane, cast shadow, display stand that is not part of the object, props, people, hands or text.'
    ].join('\n');
}

/** The rules every spec follows. Sent with the first request and again with every revision, which is stateless. */
export function specConventions(dimensionsHintMeters?: Vec3): string {
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
        '- observations: short notes on proportions, counts and how the parts join.'
    ].join('\n');
}

export function buildSpecPrompt(request: string, dimensionsHintMeters?: Vec3): string {
    return [
        `The image is a reference picture of: ${request}`,
        'Reverse-engineer it into a build spec for a procedural modeller. Reply with JSON matching the schema.',
        '',
        specConventions(dimensionsHintMeters)
    ].join('\n');
}

export function buildComparisonPrompt(request: string, spec: ObjectBuildSpec): string {
    return [
        `Image 1 is the reference picture of: ${request}`,
        'Image 2 is an untextured clay render of the 3D model built from the spec below, seen from a similar three-quarter view.',
        'Compare shapes only, not colour, material, lighting or background. List clear differences: missing or extra parts, wrong counts, wrong proportions, sizes or positions, parts that are detached, crossing or pointing the wrong way. Give the spec part id when one applies.',
        'confidence is exactly "high" or "low": "high" only when a difference is unmistakable, otherwise "low". Reply with an empty list when the shapes match.',
        `Spec:\n${JSON.stringify(spec)}`
    ].join('\n');
}

export function buildRevisionPrompt(request: string, spec: ObjectBuildSpec, problems: string[], dimensionsHintMeters?: Vec3): string {
    return [
        `Image 1 is the reference picture of: ${request}. Image 2 is a clay render of the current build.`,
        'Return the complete corrected build spec as JSON matching the schema, following the conventions below. Fix every problem listed and keep the parts that are right unchanged.',
        '',
        specConventions(dimensionsHintMeters),
        '',
        `Problems:\n${problems.map(p => `- ${p}`).join('\n')}`,
        '',
        `Current spec:\n${JSON.stringify(spec)}`
    ].join('\n');
}

export function buildCorrectionPrompt(errors: string[]): string {
    return `That build spec cannot be built:\n${errors.map(e => `- ${e}`).join('\n')}\nReply with the complete corrected spec as JSON matching the schema.`;
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
    signal?: AbortSignal
): Promise<{ image: ReferenceImage; answered: string }> {
    let lastFinish: string | undefined;
    // Image models sometimes finish (STOP) with no image part; ask the same model again, never another one.
    for (let attempt = 0; attempt < EMPTY_IMAGE_ATTEMPTS; attempt++) {
        const response = await callModel(client, {
            model: REFERENCE_IMAGE_MODEL,
            contents: [{ role: 'user', parts: [{ text: buildReferenceImagePrompt(request) }] }],
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
        signal?: AbortSignal
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

/**
 * A JSON answer from the vision model, parsed. JSON mode with the schema in the prompt: Vertex refused
 * responseJsonSchema with the spec schema on the chat model (400 INVALID_ARGUMENT, verified live), so the schema is
 * stated in the request and every reply is checked here instead.
 */
async function callJson(vision: VisionModel, contents: Content[], schema: Record<string, unknown>, stage: ObjectBuildStage, signal?: AbortSignal, thinkingBudget?: number): Promise<JsonReply> {
    const last = contents[contents.length - 1];
    const withSchema: Content[] = [...contents.slice(0, -1), { ...last, parts: [...(last.parts || []), { text: schemaInstruction(schema) }] }];
    const response = await vision.generate({
        contents: withSchema,
        config: { responseMimeType: 'application/json', temperature: 0.2, abortSignal: signal }
    }, stage, thinkingBudget);
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
        parts: [imagePart(reference.data, reference.mimeType), imagePart(render, 'image/png'), { text: buildComparisonPrompt(request, spec) }]
    }];
    const first = await callJson(vision, contents, DIFFERENCES_JSON_SCHEMA, 'checks', signal);
    const parsed = parseDifferences(first);
    if (parsed.differences) return parsed.differences;
    const again = await callJson(vision, [
        ...contents,
        { role: 'model', parts: [{ text: first.text }] },
        { role: 'user', parts: [{ text: buildComparisonCorrectionPrompt(parsed.error!) }] }
    ], DIFFERENCES_JSON_SCHEMA, 'checks', signal);
    const reparsed = parseDifferences(again);
    if (reparsed.differences) return reparsed.differences;
    throw new ReferenceObjectBuildError('checks',
        `${vision.current} did not return a usable comparison of the build with the reference after one correction: ${reparsed.error}`,
        { model: vision.current });
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
    reportProgress?: (message: string) => void
): Promise<NativeBuild | RejectedBuild> {
    throwIfAborted(signal, 'build');
    const sourceCode = buildObjectSpecScript(spec);
    await prepareEngine(deps, signal, reportProgress);
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
        result = await runPython(sourceCode, { timeoutMs: timeoutMs + 30_000, ...(deps.outputDir ? { outputDir: deps.outputDir } : {}), signal: runSignal });
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
}

/**
 * Asks for a spec and builds it. Problems the validator or the interpreter finds get one corrective re-ask that
 * quotes all of them; a spec that still cannot be built fails (build-spec for validator problems, build for the
 * interpreter's).
 */
async function requestBuildableSpec(
    vision: VisionModel,
    contents: Content[],
    deps: ReferenceObjectBuilderDeps,
    signal?: AbortSignal,
    reportProgress?: (message: string) => void
): Promise<BuildableSpec> {
    type Attempt = { build?: NativeBuild; spec?: ObjectBuildSpec; problems: string[]; from: 'build-spec' | 'build'; timedOut?: boolean };
    const attempt = async (reply: JsonReply): Promise<Attempt> => {
        const errors = reply.parseError ? [reply.parseError] : validateObjectBuildSpec(reply.value);
        if (errors.length) return { problems: errors, from: 'build-spec' };
        const spec = reply.value as ObjectBuildSpec;
        const built = await runBuild(spec, deps, signal, reportProgress);
        if ('specProblems' in built) return { problems: built.specProblems, from: 'build', ...(built.timedOut ? { timedOut: true } : {}) };
        return { build: built, spec, problems: [], from: 'build' };
    };
    const finder = (a: Attempt) => a.timedOut ? 'the build ran out of time' : a.from === 'build' ? 'the interpreter found' : 'the validator found';

    const first = await callJson(vision, contents, OBJECT_BUILD_SPEC_JSON_SCHEMA, 'build-spec', signal, SPEC_READ_THINKING_BUDGET);
    const one = await attempt(first);
    if (one.build && one.spec) return { spec: one.spec, build: one.build, specRequests: 1 };

    const corrected = await callJson(vision, [
        ...contents,
        { role: 'model', parts: [{ text: first.text }] },
        { role: 'user', parts: [{ text: buildCorrectionPrompt(one.problems) }] }
    ], OBJECT_BUILD_SPEC_JSON_SCHEMA, 'build-spec', signal, SPEC_READ_THINKING_BUDGET);
    const two = await attempt(corrected);
    if (two.build && two.spec) return { spec: two.spec, build: two.build, specRequests: 2, correctedProblems: one.problems };
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
    options: { signal?: AbortSignal } = {}
): Promise<Omit<ObjectBuildChecks, 'differences'> & { soup: TriangleSoup; partBounds: PartBounds }> {
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
    /** What is left to fix after this pass (empty when nothing is). */
    problems: string[];
    /** Why the comparison with the reference could not be had; the pass is then measured but not compared. */
    comparisonError?: string;
}

/**
 * Measures a pass and compares its clay render with the reference. A comparison that cannot be had leaves the pass
 * measured but not compared (its differences unknown), so a build that passed every check is never thrown away for
 * it; a stop still ends the build.
 */
async function checkBuild(
    pass: number,
    spec: ObjectBuildSpec,
    build: NativeBuild,
    input: ReferenceObjectBuildRequest,
    vision: VisionModel,
    reference: ReferenceImage
): Promise<CheckedPass> {
    input.reportProgress?.(`Checking pass ${pass}: every part built and attached`);
    const { soup, partBounds, ...measured } = await measureBuild(spec, build.glb, { signal: input.signal });
    throwIfAborted(input.signal, 'checks');
    const render = renderReviewViews(soup, 512, { views: THREE_QUARTER_VIEW })[0].png;
    input.reportProgress?.(`Comparing the clay build (pass ${pass}) with the reference`);
    let differences: ReferenceDifference[] = [];
    let comparisonError: string | undefined;
    try {
        differences = await compareToReference(vision, input.request, reference, render, spec, input.signal);
    } catch (err) {
        if (!(err instanceof ReferenceObjectBuildError) || err.details.aborted || input.signal?.aborted) throw err;
        comparisonError = err.message;
    }
    const checks: ObjectBuildChecks = { ...measured, differences };
    return {
        pass, spec, build, render, checks, partBounds,
        problems: describeProblems(checks, spec, partBounds),
        ...(comparisonError ? { comparisonError } : {})
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

function passRecord(checked: CheckedPass, source: ObjectBuildPass['source'], requested: BuildableSpec): ObjectBuildPass {
    const c = checked.checks;
    return {
        pass: checked.pass,
        source,
        outcome: 'built',
        specRequests: requested.specRequests,
        ...(requested.correctedProblems ? { correctedProblems: requested.correctedProblems } : {}),
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
        problems: checked.problems,
        buildMs: checked.build.buildMs
    };
}

export interface SpecObjectBuildResult {
    spec: ObjectBuildSpec;
    sourceCode: string;
    glb: Buffer;
    glbPath: string;
    /** The measured checks; there is no comparison with a reference, so no differences. */
    checks: Omit<ObjectBuildChecks, 'differences'>;
    /** Problems that do not stop the build (such as its size disagreeing with boundingMeters). */
    openProblems: string[];
    buildMs: number;
}

/**
 * Builds a spec exactly as given, typically an edit of an earlier build's spec: no reference image, no model call
 * and no comparison. A spec the validator or the interpreter rejects, or a build that fails its checks (a part not
 * built, a child off its parent, a piece count other than expectedBodies), throws with every problem listed for the
 * caller to fix; nothing is revised here and nothing failing is returned.
 */
export async function buildObjectFromSpec(
    spec: unknown,
    input: Pick<ReferenceObjectBuildRequest, 'signal' | 'reportProgress'> = {},
    deps: ReferenceObjectBuilderDeps = {}
): Promise<SpecObjectBuildResult> {
    const errors = validateObjectBuildSpec(spec);
    if (errors.length) {
        throw new ReferenceObjectBuildError('build-spec', `The spec cannot be built (the validator found: ${errors.join('; ')})`, { errors });
    }
    const valid = spec as ObjectBuildSpec;
    input.reportProgress?.('Building the spec natively', 0.2);
    const built = await runBuild(valid, deps, input.signal, input.reportProgress);
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
    return { spec: valid, sourceCode: built.sourceCode, glb: built.glb, glbPath: built.glbPath, checks: measured, openProblems: problems, buildMs: built.buildMs };
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
    const vision = new VisionModel(client, candidates, requestedModel ? 'request' : 'chat-default', deps, input.signal);

    progress(`Drawing an internal reference with ${REFERENCE_IMAGE_MODEL}`, 0.05);
    let generated: { image: ReferenceImage; answered: string } | undefined = await generateReferenceImage(client, input.request, deps, input.signal);
    try {
        const reference = generated.image;
        const imageModel: ModelUse = { requested: REFERENCE_IMAGE_MODEL, answered: generated.answered };

        progress(`Reading the reference into a build spec with ${vision.current}`, 0.2);
        const firstSpec = await requestBuildableSpec(vision, [{
            role: 'user',
            parts: [imagePart(reference.data, reference.mimeType), { text: buildSpecPrompt(input.request, input.dimensionsHintMeters) }]
        }], deps, input.signal, progress);
        let current = await checkBuild(1, firstSpec.spec, firstSpec.build, input, vision, reference);
        const passes: ObjectBuildPass[] = [passRecord(current, 'reference', firstSpec)];
        const checkedPasses = new Map<number, CheckedPass>([[1, current]]);
        let accepted: CheckedPass | undefined = passedEveryCheck(current.checks) ? current : undefined;
        let revisionFailed: RevisionFailure | undefined;

        for (let revision = 1; revision <= MAX_REVISION_PASSES && current.problems.length > 0; revision++) {
            throwIfAborted(input.signal, 'build-spec');
            const pass = revision + 1;
            const count = current.problems.length;
            progress(`Revision ${revision}: fixing ${count} problem${count === 1 ? '' : 's'}`, 0.35 + 0.25 * revision);
            try {
                const revised = await requestBuildableSpec(vision, [{
                    role: 'user',
                    parts: [
                        imagePart(reference.data, reference.mimeType),
                        imagePart(current.render, 'image/png'),
                        { text: buildRevisionPrompt(input.request, current.spec, current.problems, input.dimensionsHintMeters) }
                    ]
                }], deps, input.signal, progress);
                const checked = await checkBuild(pass, revised.spec, revised.build, input, vision, reference);
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
                { passes, lastPass: last, connectivity: current.checks.connectivity, missingParts: current.checks.missingParts, detachedParts: current.checks.detachedParts, spec: current.spec });
        }
        // The returned pass could not be compared: say so, and which differences it was asked to fix are unchecked.
        const comparisonFailed: ComparisonFailure | undefined = accepted.comparisonError
            ? {
                pass: accepted.pass,
                reason: accepted.comparisonError,
                unverifiedDifferences: (checkedPasses.get(accepted.pass - 1)?.checks.differences || []).filter(d => d.confidence === 'high')
            }
            : undefined;
        return {
            spec: accepted.spec,
            sourceCode: accepted.build.sourceCode,
            glb: accepted.build.glb,
            glbPath: accepted.build.glbPath,
            imageModel,
            visionModel: vision.use(),
            backend,
            passes,
            resultPass: accepted.pass,
            ...(revisionFailed ? { revisionFailed } : {}),
            ...(comparisonFailed ? { comparisonFailed } : {}),
            checks: accepted.checks,
            remainingDifferences: accepted.checks.differences.filter(d => d.confidence === 'high'),
            openProblems: accepted.problems.filter(p => !accepted!.checks.differences.some(d => d.confidence === 'high' && differenceProblem(d) === p))
        };
    } catch (err) {
        throw vision.annotate(err);
    } finally {
        // The reference only ever lived in memory; drop it so nothing outlives the call.
        generated = undefined;
    }
}
