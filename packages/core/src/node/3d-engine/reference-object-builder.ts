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
 *   2. Build spec: the chat's model reads the reference into an ObjectBuildSpec (structured JSON output), validated,
 *      with one corrective re-ask that quotes the validator's errors.
 *   3. Build: sb.object_spec.build(spec) runs in the native Python engine and writes a GLB.
 *   4. Checks: the prop complexity floor, part connectivity against the spec's expectedBodies, and a comparison of a
 *      clay render with the reference; up to two revision passes. A build that still fails the floor or the
 *      connectivity check is rejected, never mounted.
 * Every stage either does what it was asked or throws ReferenceObjectBuildError naming the stage; there is no
 * other image model, template, neural reconstruction or text-only path to fall back to.
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
import { GeometricComplexityGate, type ComplexityGateReport } from '../../common/spatial/GeometricComplexityGate';
import { classifyMediaGenerationError } from '../../common/media-generation-protocol';
import { EMPTY_IMAGE_RESPONSE_ATTEMPTS } from '../google-media-generation-service';
import { GeminiClient, errorMessage } from '../gemini/gemini-client';
import { extractGlbAnalysis } from '../gemini/tools/python-3d-tools';
import { NativePythonRunnerService, type PythonExecutionOptions, type PythonExecutionResult } from './native-python-runner-service';
import { analyzePartConnectivity, glbToTriangleSoup, type FloatingPart } from './part-connectivity';
import { renderReviewViews } from './visual-review';

/** Nano Banana Lite. The only model the reference image is ever requested from. */
export const REFERENCE_IMAGE_MODEL = 'gemini-3.1-flash-lite-image';
/** Revision passes after the first build. */
export const MAX_REVISION_PASSES = 2;
/** Backoff retries for 429 / 5xx answers, always on the same model. */
export const MAX_TRANSIENT_RETRIES = 2;
/** Floor for a single object (GeometricComplexityGate's single-asset floor). */
export const PROP_MIN_VERTICES = GeometricComplexityGate.DEFAULT_SINGLE_ASSET_MIN_VERTICES;
export const PROP_MIN_TRIANGLES = 3000;

export type ObjectBuildStage = 'credentials' | 'reference-image' | 'build-spec' | 'build' | 'checks';

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

export interface ReferenceObjectBuildRequest {
    /** What to build, in the user's words plus any detail from the conversation. */
    request: string;
    /** The chat's model; it reads the reference and the renders. */
    visionModel: string;
    dimensionsHintMeters?: Vec3;
    signal?: AbortSignal;
    reportProgress?: (message: string, fraction?: number) => void;
}

export interface ReferenceObjectBuilderDeps {
    /** Resolves the client; defaults to the chat's credentials (GeminiClient.getGenAIClient). */
    createClient?: () => Promise<GenerateContentClient | undefined>;
    runPython?: (script: string, options: PythonExecutionOptions) => Promise<PythonExecutionResult>;
    /** Where the build script and GLB are written (the runner's build/3d-python by default). */
    outputDir?: string;
    sleep?: (ms: number) => Promise<void>;
}

export interface ReferenceDifference {
    partId?: string;
    problem: string;
    confidence: 'high' | 'low';
}

export interface ObjectBuildChecks {
    gate: ComplexityGateReport;
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
    source: 'reference' | 'revision';
    vertexCount: number;
    triangleCount: number;
    gatePassed: boolean;
    bodies: number;
    expectedBodies: number;
    highConfidenceDifferences: number;
    /** Problems sent back to the vision model after this pass; empty when the pass was accepted. */
    problems: string[];
    buildMs: number;
}

export interface ModelUse {
    requested: string;
    /** The model version the API reports for the answer (the requested id when the API reports none). */
    answered: string;
}

export interface ReferenceObjectBuildResult {
    spec: ObjectBuildSpec;
    sourceCode: string;
    glb: Buffer;
    glbPath: string;
    imageModel: ModelUse;
    visionModel: ModelUse;
    backend: 'vertex' | 'api-key' | 'injected';
    passes: ObjectBuildPass[];
    checks: ObjectBuildChecks;
    /** High-confidence differences still present in the accepted build. */
    remainingDifferences: ReferenceDifference[];
}

interface ReferenceImage {
    data: Buffer;
    mimeType: string;
}

const THREE_QUARTER_VIEW = [{ label: 'three-quarter view', azimuthDeg: 35, elevationDeg: 22 }];

let chatCredentials: GeminiClient | undefined;
/** The client chat uses: the Vertex service account when one is configured, otherwise the Gemini API key. */
async function defaultCreateClient(): Promise<GenerateContentClient | undefined> {
    chatCredentials ??= new GeminiClient();
    return chatCredentials.getGenAIClient();
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

export function buildSpecPrompt(request: string, dimensionsHintMeters?: Vec3): string {
    const size = dimensionsHintMeters
        ? `The user gave its size as about ${dimensionsHintMeters.map(d => `${d} m`).join(' x ')} (width x height x depth).`
        : 'Size it to its real-world scale.';
    return [
        `The image is a reference picture of: ${request}`,
        'Reverse-engineer it into a build spec for a procedural modeller. Reply with JSON matching the schema.',
        '',
        'Conventions',
        `- Metres. +Y up, +X to the object's right, +Z toward its front (the side facing the viewer). The origin is the centre of where the object meets the ground; nothing goes below y = 0. ${size}`,
        '- Describe the whole object, including sides the image hides: infer them from symmetry and from how such objects are built.',
        '- Build it from parts. Every part has exactly one operator block:',
        '  sweep: a cross-section swept along a smooth carrier through controlPoints. profile keys (t from 0 at the first control point to 1 at the last) give the section width (sideways), height (along the section\'s up direction) and superellipse exponent (2 round, 4 or more boxy, below 2 pinched); keys interpolate linearly, so use several keys to taper and swell. smoothing 0 = straight segments, 1 = smooth curve. closedLoop joins the end to the start. twistDegAlong turns the section about the carrier; modulation adds periodic ribs.',
        '  revolve: a meridian of [distance along the axis, radius] points revolved about axisDirection through axisOrigin. Radius 0 closes an end at the axis; a non-zero end radius is capped flat. Trace a hollow vessel by going up the outside and back down the inside. lobeCount and lobeDepthRatio add radial lobes (flutes, teeth, petals); helixPitchMeters twists them along the axis (0 = straight).',
        '  replicate: copies of seedPartId together with everything attached to it; the seed as built is copy 0 and is emitted only through the replicate. ring: each copy turned a further spanDeg / count degrees about the axis through centerMeters (spanDeg 360 = evenly round a full circle, more for a helix) and raised risePerCopyMeters. path: copies spaced evenly from the first to the last point, optionally turned with the path.',
        '  relief: grooves (negative depthMeters) or beads (positive) of widthMeters along curves on targetPartId. Curves are polylines of [u, v]: u from 0 to 1 along the part (along the carrier of a sweep, along the meridian of a revolve), v = angle / 360 around it; [[u, 0], [u, 1]] is a full ring and v past 1 wraps for spirals.',
        '- Attachment: every part except root parts has parentId (a sweep or revolve part) and attach {u, angleDeg, normalOffsetMeters}. The attach point is on the parent surface at u along it and angleDeg around it; u = 0 or 1 is the centre of that end. normalOffsetMeters moves the point along the surface normal: use a small negative value, about a quarter of the child\'s thickness, so the child sinks into its parent. A child\'s own coordinates are offsets in object axes from its attach point: a child sweep\'s first control point is [0, 0, 0], and a child revolve has axisOrigin [0, 0, 0] with a meridian whose axial distances span 0.',
        '- Angle 0 around a revolve points toward +Z (or +X when the axis is along Z) and angle 90 toward axisDirection x (angle-0 direction): for an upright axis 0 is front, 90 right, 180 back, 270 left. Angle 0 around a sweep is the section\'s up direction (toward +Y, or +Z for a vertical carrier) and 90 is the carrier direction x up.',
        '- Root parts (no parentId) use absolute coordinates. Use one root unless the object really is several separate pieces; expectedBodies is how many separate pieces you intend (usually 1).',
        '- mirrorPlaneNormal also emits a part and what is attached to it reflected across the plane through the origin with that normal, e.g. [1, 0, 0] for a left/right pair.',
        '- Spend parts on the main mass first, then the secondary assemblies, then small details; use as many parts as the object needs.',
        '- observations: short notes on proportions, counts and how the parts join.'
    ].join('\n');
}

export function buildComparisonPrompt(request: string, spec: ObjectBuildSpec): string {
    return [
        `Image 1 is the reference picture of: ${request}`,
        'Image 2 is an untextured clay render of the 3D model built from the spec below, seen from a similar three-quarter view.',
        'Compare shapes only, not colour, material, lighting or background. List clear differences: missing or extra parts, wrong counts, wrong proportions, sizes or positions, parts that are detached, crossing or pointing the wrong way. Give the spec part id when one applies.',
        'Mark a difference "high" confidence only when it is unmistakable; otherwise "low". Reply with an empty list when the shapes match.',
        `Spec:\n${JSON.stringify(spec)}`
    ].join('\n');
}

export function buildRevisionPrompt(request: string, spec: ObjectBuildSpec, problems: string[]): string {
    return [
        `Image 1 is the reference picture of: ${request}. Image 2 is a clay render of the current build.`,
        'Return the complete corrected build spec (same schema and conventions as before). Fix every problem below and keep the parts that are right unchanged.',
        `Problems:\n${problems.map(p => `- ${p}`).join('\n')}`,
        `Current spec:\n${JSON.stringify(spec)}`
    ].join('\n');
}

export function buildCorrectionPrompt(errors: string[]): string {
    return `That build spec cannot be built:\n${errors.map(e => `- ${e}`).join('\n')}\nReply with the complete corrected spec as JSON matching the schema.`;
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

function throwIfAborted(signal?: AbortSignal): void {
    if (signal?.aborted) throw new ReferenceObjectBuildError('build-spec', 'Stopped by the user.');
}

function responseText(response: GenerateContentResponse): string {
    return (response.candidates?.[0]?.content?.parts || []).map(p => p.text || '').join('');
}

/** One generateContent call on exactly `model`, retrying only 429 / 5xx answers with backoff. */
async function callModel(
    client: GenerateContentClient,
    params: GenerateContentParameters,
    stage: ObjectBuildStage,
    deps: ReferenceObjectBuilderDeps,
    signal?: AbortSignal
): Promise<GenerateContentResponse> {
    const sleep = deps.sleep ?? defaultSleep;
    for (let attempt = 0; ; attempt++) {
        throwIfAborted(signal);
        try {
            return await client.models.generateContent(params);
        } catch (err) {
            const classified = classifyMediaGenerationError(err, params.model);
            const retryable = classified.code === 'transient' || classified.code === 'quota';
            if (retryable && attempt < MAX_TRANSIENT_RETRIES && !signal?.aborted) {
                await sleep(1000 * 2 ** attempt);
                continue;
            }
            throw new ReferenceObjectBuildError(stage,
                `${params.model} failed (${classified.code}${classified.status ? ` ${classified.status}` : ''}): ${classified.message}`,
                { model: params.model, code: classified.code, status: classified.status });
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
    for (let attempt = 0; attempt < EMPTY_IMAGE_RESPONSE_ATTEMPTS; attempt++) {
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
        `${REFERENCE_IMAGE_MODEL} returned no image in ${EMPTY_IMAGE_RESPONSE_ATTEMPTS} attempts${lastFinish ? ` (finish reason ${lastFinish})` : ''}.`,
        { model: REFERENCE_IMAGE_MODEL, code: 'empty_image' });
}

/** A JSON answer from the vision model, parsed. */
async function callJson(
    client: GenerateContentClient,
    model: string,
    contents: Content[],
    schema: Record<string, unknown>,
    stage: ObjectBuildStage,
    deps: ReferenceObjectBuilderDeps,
    signal?: AbortSignal
): Promise<{ text: string; value: unknown; parseError?: string; answered: string }> {
    const response = await callModel(client, {
        model,
        contents,
        config: {
            responseMimeType: 'application/json',
            responseJsonSchema: schema,
            temperature: 0.2,
            abortSignal: signal
        }
    }, stage, deps, signal);
    const blocked = response.promptFeedback?.blockReason;
    if (blocked) throw new ReferenceObjectBuildError(stage, `${model} refused the request (${blocked}).`, { model });
    const text = responseText(response);
    const answered = response.modelVersion || model;
    try {
        return { text, value: JSON.parse(text), answered };
    } catch (err) {
        return { text, value: undefined, parseError: `the reply was not valid JSON (${errorMessage(err)})`, answered };
    }
}

/** Asks for a spec, validates it, and allows one corrective re-ask that quotes the validator's errors. */
async function requestSpec(
    client: GenerateContentClient,
    model: string,
    contents: Content[],
    deps: ReferenceObjectBuilderDeps,
    signal?: AbortSignal
): Promise<{ spec: ObjectBuildSpec; answered: string }> {
    const first = await callJson(client, model, contents, OBJECT_BUILD_SPEC_JSON_SCHEMA, 'build-spec', deps, signal);
    const firstErrors = first.parseError ? [first.parseError] : validateObjectBuildSpec(first.value);
    if (firstErrors.length === 0) return { spec: first.value as ObjectBuildSpec, answered: first.answered };

    const corrected = await callJson(client, model, [
        ...contents,
        { role: 'model', parts: [{ text: first.text }] },
        { role: 'user', parts: [{ text: buildCorrectionPrompt(firstErrors) }] }
    ], OBJECT_BUILD_SPEC_JSON_SCHEMA, 'build-spec', deps, signal);
    const errors = corrected.parseError ? [corrected.parseError] : validateObjectBuildSpec(corrected.value);
    if (errors.length === 0) return { spec: corrected.value as ObjectBuildSpec, answered: corrected.answered };
    throw new ReferenceObjectBuildError('build-spec',
        `${model} did not produce a buildable spec after one correction: ${errors.slice(0, 8).join('; ')}${errors.length > 8 ? ` (and ${errors.length - 8} more)` : ''}`,
        { model, errors });
}

function imagePart(data: Buffer, mimeType: string): Part {
    return { inlineData: { mimeType, data: data.toString('base64') } };
}

async function compareToReference(
    client: GenerateContentClient,
    model: string,
    request: string,
    reference: ReferenceImage,
    render: Buffer,
    spec: ObjectBuildSpec,
    deps: ReferenceObjectBuilderDeps,
    signal?: AbortSignal
): Promise<ReferenceDifference[]> {
    const reply = await callJson(client, model, [{
        role: 'user',
        parts: [imagePart(reference.data, reference.mimeType), imagePart(render, 'image/png'), { text: buildComparisonPrompt(request, spec) }]
    }], DIFFERENCES_JSON_SCHEMA, 'checks', deps, signal);
    const list = (reply.value as { differences?: unknown })?.differences;
    if (reply.parseError || !Array.isArray(list)) {
        throw new ReferenceObjectBuildError('checks', `${model} did not return a usable comparison: ${reply.parseError ?? 'no differences list'}`, { model });
    }
    return list.map((d: any): ReferenceDifference => {
        if (!d || typeof d.problem !== 'string' || (d.confidence !== 'high' && d.confidence !== 'low')) {
            throw new ReferenceObjectBuildError('checks', `${model} returned a malformed comparison entry: ${JSON.stringify(d).slice(0, 200)}`, { model });
        }
        return { ...(typeof d.partId === 'string' && d.partId ? { partId: d.partId } : {}), problem: d.problem, confidence: d.confidence };
    });
}

// ---------------------------------------------------------------------------
// Build and check
// ---------------------------------------------------------------------------

interface BuiltPass {
    glb: Buffer;
    glbPath: string;
    sourceCode: string;
    render: Buffer;
    checks: ObjectBuildChecks;
    vertexCount: number;
    triangleCount: number;
    meshBounds: Array<{ name: string; min: Vec3; max: Vec3 }>;
    buildMs: number;
}

async function buildPass(
    spec: ObjectBuildSpec,
    input: ReferenceObjectBuildRequest,
    client: GenerateContentClient,
    reference: ReferenceImage,
    deps: ReferenceObjectBuilderDeps
): Promise<BuiltPass> {
    const sourceCode = buildObjectSpecScript(spec);
    const runPython = deps.runPython ?? ((script: string, options: PythonExecutionOptions) => NativePythonRunnerService.getInstance().runScript(script, options));
    const started = Date.now();
    const result = await runPython(sourceCode, { timeoutMs: 120_000, ...(deps.outputDir ? { outputDir: deps.outputDir } : {}) });
    if (!result.success) {
        const detail = (result.errorDetails || result.stderr || `exit code ${result.exitCode}`).trim();
        throw new ReferenceObjectBuildError('build', `The native build of the spec failed: ${detail.slice(-3000)}`, { exitCode: result.exitCode });
    }
    const glb = result.glbBase64 ? Buffer.from(result.glbBase64, 'base64') : result.glbPath && fs.existsSync(result.glbPath) ? fs.readFileSync(result.glbPath) : undefined;
    if (!glb || !result.glbPath || glb.length < 20 || glb.toString('utf8', 0, 4) !== 'glTF') {
        throw new ReferenceObjectBuildError('build', 'The native build finished without writing a GLB.', { stdout: result.stdout.slice(-1000) });
    }
    const buildMs = Date.now() - started;

    const analysis = extractGlbAnalysis(glb);
    const soup = glbToTriangleSoup(glb);
    if (!analysis.metrics || !analysis.bounds || !soup) {
        throw new ReferenceObjectBuildError('checks', 'The built GLB could not be read back for checking.');
    }
    const gate = GeometricComplexityGate.evaluate(analysis.metrics, {
        minVertexCount: PROP_MIN_VERTICES,
        minTriangleCount: PROP_MIN_TRIANGLES,
        requireMultiMeshHierarchy: false
    });
    const connectivity = analyzePartConnectivity(soup);
    const render = renderReviewViews(soup, 512, { views: THREE_QUARTER_VIEW })[0].png;
    input.reportProgress?.('Comparing the clay build with the reference');
    const differences = await compareToReference(client, input.visionModel, input.request, reference, render, spec, deps, input.signal);
    const b = analysis.bounds;
    return {
        glb,
        glbPath: result.glbPath,
        sourceCode,
        render,
        vertexCount: analysis.metrics.totalVertices,
        triangleCount: analysis.metrics.totalTriangles,
        meshBounds: analysis.metrics.submeshes.filter(m => m.bounds).map(m => ({ name: m.name, min: m.bounds!.min, max: m.bounds!.max })),
        buildMs,
        checks: {
            gate,
            connectivity: {
                // A check that could not run is not a pass.
                passed: !connectivity.skippedReason && connectivity.structureCount === spec.expectedBodies,
                bodies: connectivity.structureCount,
                expectedBodies: spec.expectedBodies,
                floatingParts: connectivity.floatingParts,
                toleranceMeters: connectivity.toleranceMeters,
                ...(connectivity.skippedReason ? { skippedReason: connectivity.skippedReason } : {})
            },
            differences,
            builtBoundingMeters: [+(b.max[0] - b.min[0]).toFixed(3), +(b.max[1] - b.min[1]).toFixed(3), +(b.max[2] - b.min[2]).toFixed(3)]
        }
    };
}

/** Part ids whose meshes contain a point, to name the pieces of a floating group. */
function partsAt(center: Vec3, meshBounds: BuiltPass['meshBounds']): string[] {
    return meshBounds.filter(m => [0, 1, 2].every(k => center[k] >= m.min[k] - 1e-3 && center[k] <= m.max[k] + 1e-3)).map(m => m.name);
}

/** What the vision model must fix after a pass; empty when the pass is acceptable as it is. */
export function describeProblems(checks: ObjectBuildChecks, spec: ObjectBuildSpec, meshBounds: BuiltPass['meshBounds'] = []): string[] {
    const problems: string[] = [];
    if (!checks.gate.passed) {
        if (checks.gate.totalVertices < PROP_MIN_VERTICES || checks.gate.totalTriangles < PROP_MIN_TRIANGLES) {
            problems.push(`The build has ${checks.gate.totalVertices} vertices and ${checks.gate.totalTriangles} triangles, under the ${PROP_MIN_VERTICES} / ${PROP_MIN_TRIANGLES} floor for an object: model the parts and detail the reference shows.`);
        }
        problems.push(...checks.gate.violations.filter(v => !/^Insufficient/.test(v)));
    }
    const c = checks.connectivity;
    if (c.skippedReason) {
        problems.push(`Part connections could not be checked (${c.skippedReason}); use fewer copies or parts.`);
    } else if (c.bodies !== c.expectedBodies) {
        const groups = c.floatingParts.slice(0, 6).map(f => {
            const near = partsAt(f.center, meshBounds);
            return `a piece at [${f.center.join(', ')}] sized [${f.size.join(', ')}] m${near.length ? ` (parts ${near.join(', ')})` : ''}, ${f.gapMeters >= 0.5 ? 'over 50 cm' : `${(f.gapMeters * 100).toFixed(1)} cm`} from the main body`;
        });
        problems.push(`The build is ${c.bodies} separate pieces but expectedBodies is ${c.expectedBodies}.${groups.length ? ` Not joined: ${groups.join('; ')}.` : ''} Attach each part to the one it touches (parentId + attach), or set expectedBodies if the pieces really are separate.`);
    }
    for (const d of checks.differences.filter(x => x.confidence === 'high')) {
        problems.push(`${d.partId ? `Part "${d.partId}": ` : ''}${d.problem}`);
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

/**
 * Builds a request as native clay geometry from an internal reference image. Throws ReferenceObjectBuildError
 * for any stage that cannot do what it was asked.
 */
export async function buildObjectFromReference(
    input: ReferenceObjectBuildRequest,
    deps: ReferenceObjectBuilderDeps = {}
): Promise<ReferenceObjectBuildResult> {
    if (!input.request?.trim()) throw new ReferenceObjectBuildError('build-spec', 'Nothing to build: the request is empty.');
    if (!input.visionModel?.trim()) {
        throw new ReferenceObjectBuildError('build-spec', 'No chat model is set for this request, so there is no model to read the reference with.');
    }
    const client = await (deps.createClient ?? defaultCreateClient)();
    if (!client) throw new ReferenceObjectBuildError('credentials', 'No Google API key or service account configured');
    const backend: ReferenceObjectBuildResult['backend'] = client.vertexai === true ? 'vertex' : client.vertexai === false ? 'api-key' : 'injected';
    const progress = input.reportProgress ?? (() => undefined);

    progress(`Drawing an internal reference with ${REFERENCE_IMAGE_MODEL}`, 0.05);
    let generated: { image: ReferenceImage; answered: string } | undefined = await generateReferenceImage(client, input.request, deps, input.signal);
    try {
        const reference = generated.image;
        progress(`Reading the reference into a build spec with ${input.visionModel}`, 0.2);
        const first = await requestSpec(client, input.visionModel, [{
            role: 'user',
            parts: [imagePart(reference.data, reference.mimeType), { text: buildSpecPrompt(input.request, input.dimensionsHintMeters) }]
        }], deps, input.signal);
        let spec = first.spec;
        let visionAnswered = first.answered;
        const passes: ObjectBuildPass[] = [];
        for (let pass = 1; ; pass++) {
            throwIfAborted(input.signal);
            progress(pass === 1 ? 'Building the spec in the native engine' : `Rebuilding after revision ${pass - 1}`, 0.35 + 0.2 * (pass - 1));
            const built = await buildPass(spec, input, client, reference, deps);
            const problems = describeProblems(built.checks, spec, built.meshBounds);
            const accepted = problems.length === 0 || pass > MAX_REVISION_PASSES;
            passes.push({
                pass,
                source: pass === 1 ? 'reference' : 'revision',
                vertexCount: built.vertexCount,
                triangleCount: built.triangleCount,
                gatePassed: built.checks.gate.passed,
                bodies: built.checks.connectivity.bodies,
                expectedBodies: built.checks.connectivity.expectedBodies,
                highConfidenceDifferences: built.checks.differences.filter(d => d.confidence === 'high').length,
                problems: accepted ? [] : problems,
                buildMs: built.buildMs
            });
            if (accepted) {
                if (!built.checks.gate.passed || !built.checks.connectivity.passed) {
                    throw new ReferenceObjectBuildError('checks',
                        `The build still fails its checks after ${MAX_REVISION_PASSES} revision passes, so it was not mounted: ${problems.join(' ')}`,
                        { passes, gate: built.checks.gate, connectivity: built.checks.connectivity, spec });
                }
                return {
                    spec,
                    sourceCode: built.sourceCode,
                    glb: built.glb,
                    glbPath: built.glbPath,
                    imageModel: { requested: REFERENCE_IMAGE_MODEL, answered: generated.answered },
                    visionModel: { requested: input.visionModel, answered: visionAnswered },
                    backend,
                    passes,
                    checks: built.checks,
                    remainingDifferences: built.checks.differences.filter(d => d.confidence === 'high')
                };
            }
            progress(`Revision ${pass}: fixing ${problems.length} problem${problems.length === 1 ? '' : 's'}`, 0.45 + 0.2 * (pass - 1));
            const revised = await requestSpec(client, input.visionModel, [{
                role: 'user',
                parts: [imagePart(reference.data, reference.mimeType), imagePart(built.render, 'image/png'), { text: buildRevisionPrompt(input.request, spec, problems) }]
            }], deps, input.signal);
            spec = revised.spec;
            visionAnswered = revised.answered;
        }
    } finally {
        // The reference only ever lived in memory; drop it so nothing outlives the call.
        generated = undefined;
    }
}
