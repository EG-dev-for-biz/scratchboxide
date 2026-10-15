/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * build_3d_object_from_reference with an injected Gemini client (no billed calls): the reference comes from exactly
 * gemini-3.1-flash-lite-image; the spec is read by the model chat runs on (its default when the request names none,
 * and the chat's next model, said so, when the named one is not served); every failing stage fails the call with
 * its own error; spec problems the interpreter finds get the same single corrective re-ask as validator problems;
 * a failed revision returns the last build that passed every check and says so; a given spec is rebuilt exactly,
 * with no model call; a stop reaches the Python process; an object at a place is drawn where the viewport's own
 * rules put it; the native build is real; and the reference image never reaches the payload or the disk.
 */

import { describe, it, expect, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as THREE from 'three';
import { createObjectReferenceHandlers, OBJECT_REFERENCE_TOOL_DECLARATIONS, yawForHeading } from '../src/node/gemini/tools/object-reference-tools';
import { generatorFileIsObject } from '../src/browser/generative-canvas/primitives/Scene3DPrimitive';
import { TerrainManager } from '../src/browser/generative-canvas/services/TerrainManager';
import { glbToTriangleSoup, mergeTriangleSoups } from '../src/node/3d-engine/part-connectivity';
import { renderReviewViews } from '../src/node/3d-engine/visual-review';
import { REFERENCE_IMAGE_MODEL, schemaInstruction, type ChatModelSource, type GenerateContentClient } from '../src/node/3d-engine/reference-object-builder';
import { OBJECT_BUILD_SPEC_JSON_SCHEMA, type ObjectBuildSpec } from '../src/common/spatial/object-build-spec';
import { NativePythonRunnerService, type PythonExecutionResult } from '../src/node/3d-engine/native-python-runner-service';
import { HeadlessMeshSilhouetteRenderer } from '../src/node/spatial/HeadlessMeshSilhouetteRenderer';
import { createDefaultToolRegistry } from '../src/node/gemini/tool-registry';
import { CORE_WORKSPACE_PACK } from '../src/node/gemini/domain-tool-packs';
import type { ToolContext, ToolHandlerOutcome } from '../src/node/gemini/tools/types';
import { REPO_ROOT } from './helpers/requirements';

const CHAT_MODEL = 'gemini-4-argon';
const FALLBACK_MODEL = 'gemini-3.8-flash';
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'sbx-object-ref-'));
const SCREENSHOT_DIR = path.join(REPO_ROOT, 'test-results/screenshots');
const MODELS_DIR = path.join(TMP, 'models');
afterAll(() => fs.rmSync(TMP, { recursive: true, force: true }));

/** A distinctive 16x16 PNG standing in for the reference, so its bytes can be searched for afterwards. */
const REFERENCE_PNG = (() => {
    const rgba = new Uint8Array(16 * 16 * 4);
    for (let i = 0; i < rgba.length; i += 4) { rgba[i] = (i * 7) % 251; rgba[i + 1] = 128; rgba[i + 2] = (i * 3) % 199; rgba[i + 3] = 255; }
    return HeadlessMeshSilhouetteRenderer.encodePng(16, 16, rgba);
})();
const REFERENCE_B64 = REFERENCE_PNG.toString('base64');

const revolve = (meridian: Array<[number, number]>, over: Record<string, unknown> = {}) => ({
    axisOrigin: [0, 0, 0], axisDirection: [0, 1, 0], meridian, smoothing: 0, lobeCount: 0, lobeDepthRatio: 0, helixPitchMeters: 0, ...over
}) as any;

const VASE: ObjectBuildSpec = {
    subject: 'fluted vase with a knob',
    observations: ['tall fluted body', 'small knob on top'],
    boundingMeters: [0.36, 0.66, 0.36],
    expectedBodies: 1,
    parts: [
        { id: 'vase', label: 'vase', revolve: revolve([[0, 0], [0, 0.12], [0.2, 0.18], [0.45, 0.1], [0.6, 0.14]], { smoothing: 0.8, lobeCount: 10, lobeDepthRatio: 0.15, helixPitchMeters: 0.9 }) },
        { id: 'knob', label: 'knob', parentId: 'vase', attach: { u: 1, angleDeg: 0, normalOffsetMeters: -0.01 }, revolve: revolve([[-0.02, 0], [-0.02, 0.03], [0.04, 0.025], [0.06, 0]]) }
    ]
};

/** Two roots far apart while expectedBodies says one: the connectivity check must catch it. */
const DETACHED: ObjectBuildSpec = {
    ...VASE,
    parts: [
        VASE.parts[0],
        { id: 'loose', label: 'loose knob', revolve: revolve([[0, 0], [0, 0.05], [0.1, 0]], { axisOrigin: [0.8, 0.2, 0] }) }
    ]
};

/** The knob is attached to the vase but lifted 20 cm off it, and expectedBodies counts it as a second piece. */
const LIFTED_CHILD: ObjectBuildSpec = {
    ...VASE,
    expectedBodies: 2,
    parts: [VASE.parts[0], { ...VASE.parts[1], attach: { u: 1, angleDeg: 0, normalOffsetMeters: 0.2 } }]
};

/** Passes the validator; only the interpreter sees that the outline revolves into nothing. */
const FLAT_COIN: ObjectBuildSpec = {
    subject: 'coin', observations: [], boundingMeters: [0.03, 0.002, 0.03], expectedBodies: 1,
    parts: [{ id: 'coin', label: 'coin', revolve: revolve([[0, 0], [0, 0.015]]) }]
};

/** A horizontal disc whose id names a wheel: nothing may read the id and demand it stand upright. */
const ROULETTE: ObjectBuildSpec = {
    subject: 'roulette wheel', observations: ['flat spinning wheel on a spindle'], boundingMeters: [0.8, 0.16, 0.8], expectedBodies: 1,
    parts: [
        { id: 'wheel', label: 'wheel', revolve: revolve([[0, 0], [0, 0.4], [0.05, 0.4], [0.08, 0.3], [0.08, 0]]) },
        { id: 'spindle', label: 'spindle', parentId: 'wheel', attach: { u: 1, angleDeg: 0, normalOffsetMeters: -0.005 }, revolve: revolve([[-0.01, 0], [-0.01, 0.02], [0.06, 0.015], [0.08, 0]]) }
    ]
};

const NO_DIFFERENCES = '{"differences": []}';
const highDifference = (problem: string, partId?: string) => JSON.stringify({ differences: [{ ...(partId ? { partId } : {}), problem, confidence: 'high' }] });

interface Call { model: string; config: any; contents: any[] }

/** Records every call; image calls and JSON calls are answered by the given scripts in order (the last repeats). */
function fakeClient(opts: {
    image?: Array<(call: Call) => any>;
    specs?: string[];
    differences?: string[];
    unserved?: string[];
}): GenerateContentClient & { calls: Call[] } {
    const images = [...(opts.image ?? [() => imageResponse()])];
    const specs = [...(opts.specs ?? [])];
    const diffs = [...(opts.differences ?? [])];
    const calls: Call[] = [];
    return {
        calls,
        models: {
            generateContent: async (params: any) => {
                const call: Call = { model: params.model, config: params.config, contents: params.contents };
                calls.push(call);
                if (opts.unserved?.includes(params.model)) throw httpError(404, `Publisher Model \`projects/p/locations/global/publishers/google/models/${params.model}\` was not found (404)`);
                if (params.config?.responseModalities?.includes('IMAGE')) {
                    const next = images.length > 1 ? images.shift()! : images[0];
                    return next(call);
                }
                // Spec requests carry the spec schema; comparisons carry the differences schema.
                const isSpec = askedText(call).includes(schemaInstruction(OBJECT_BUILD_SPEC_JSON_SCHEMA));
                const queue = isSpec ? specs : diffs;
                const text = queue.length > 1 ? queue.shift()! : (queue[0] ?? (isSpec ? '' : NO_DIFFERENCES));
                return { candidates: [{ content: { parts: [{ text }] } }], modelVersion: params.model } as any;
            }
        }
    };
}

const askedText = (call: Call) => (call.contents as any[]).flatMap(c => c.parts || []).map((p: any) => p.text || '').join('\n');
const isSpecCall = (call: Call) => !call.config?.responseModalities && askedText(call).includes(schemaInstruction(OBJECT_BUILD_SPEC_JSON_SCHEMA));
const isComparisonCall = (call: Call) => !call.config?.responseModalities && !isSpecCall(call);

function imageResponse(): any {
    return { candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: REFERENCE_B64 } }] }, finishReason: 'STOP' }], modelVersion: REFERENCE_IMAGE_MODEL };
}

function httpError(status: number, message: string): Error {
    return Object.assign(new Error(message), { status });
}

/** The chat's model list, as GeminiClient.getModelCandidates gives it: the request's model, else the default, then fallbacks. */
function chatSource(client: GenerateContentClient | undefined): ChatModelSource {
    return {
        getGenAIClient: async () => client,
        getModelCandidates: (requested?: string) => [...new Set([requested || CHAT_MODEL, FALLBACK_MODEL])]
    };
}

/** A tool context whose chat request names `model`; null for a request that names no model. */
function ctx(model: string | null = CHAT_MODEL): ToolContext {
    return { request: { prompt: 'build it', ...(model ? { model } : {}) } as any, workspaceRoot: REPO_ROOT } as ToolContext;
}

function handlerWith(client: GenerateContentClient | undefined, extra: {
    runPython?: (script: string, options: any) => Promise<PythonExecutionResult>;
    stageAtLocation?: (args: Record<string, unknown>, ctx: ToolContext) => Promise<ToolHandlerOutcome>;
    buildTimeoutMs?: number;
} = {}) {
    const pythonRuns: string[] = [];
    const runPython = extra.runPython ?? ((script: string, options: any) => NativePythonRunnerService.getInstance().runScript(script, options));
    const handlers = createObjectReferenceHandlers({
        builder: {
            chat: chatSource(client),
            runPython: async (script, options) => { pythonRuns.push(script); return runPython(script, options); },
            outputDir: path.join(TMP, 'build'),
            sleep: async () => undefined,
            ...(extra.buildTimeoutMs ? { buildTimeoutMs: extra.buildTimeoutMs } : {})
        },
        stageAtLocation: extra.stageAtLocation,
        publicModelsDir: MODELS_DIR
    });
    return { run: (args: Record<string, unknown>, c: ToolContext = ctx()) => handlers.build_3d_object_from_reference(args, c), pythonRuns };
}

const IMAGE_EXT = /\.(png|jpe?g|webp|gif|bmp)$/i;
/** Every file under `dirs` with its modification time. */
function filesIn(dirs: string[]): Map<string, number> {
    const found = new Map<string, number>();
    const walk = (dir: string, depth: number) => {
        if (depth > 6 || !fs.existsSync(dir)) return;
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) walk(full, depth + 1);
            else if (entry.isFile()) found.set(full, fs.statSync(full).mtimeMs);
        }
    };
    dirs.forEach(d => walk(d, 0));
    return found;
}

/** A minimal one-mesh GLB (positions and indices only), for staged ground models. */
function makeGlb(positions: number[], indices: number[]): Buffer {
    const pad = (b: Buffer, fill: number) => Buffer.concat([b, Buffer.alloc((4 - (b.length % 4)) % 4, fill)]);
    const pos = Buffer.from(new Float32Array(positions).buffer);
    const idx = Buffer.from(new Uint32Array(indices).buffer);
    const bin = pad(Buffer.concat([pos, idx]), 0);
    const min = [0, 1, 2].map(k => Math.min(...positions.filter((_, i) => i % 3 === k)));
    const max = [0, 1, 2].map(k => Math.max(...positions.filter((_, i) => i % 3 === k)));
    const json = pad(Buffer.from(JSON.stringify({
        asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0, name: 'tile' }],
        meshes: [{ name: 'tile', primitives: [{ attributes: { POSITION: 0 }, indices: 1 }] }],
        buffers: [{ byteLength: bin.length }],
        bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: pos.length }, { buffer: 0, byteOffset: pos.length, byteLength: idx.length }],
        accessors: [
            { bufferView: 0, componentType: 5126, count: positions.length / 3, type: 'VEC3', min, max },
            { bufferView: 1, componentType: 5125, count: indices.length, type: 'SCALAR' }
        ]
    })), 0x20);
    const header = Buffer.alloc(12);
    header.write('glTF', 0, 'ascii');
    header.writeUInt32LE(2, 4);
    header.writeUInt32LE(12 + 8 + json.length + 8 + bin.length, 8);
    const chunk = (data: Buffer, type: string) => {
        const h = Buffer.alloc(8);
        h.writeUInt32LE(data.length, 0);
        h.write(type, 4, 'ascii');
        return Buffer.concat([h, data]);
    };
    return Buffer.concat([header, chunk(json, 'JSON'), chunk(bin, 'BIN\0')]);
}

/** Ground at y = 1.5 over 100 m x 100 m, with a 10 m square roof at y = 20 over the anchor (tile frame: x east, z south). */
function writeStagedTiles(): string {
    const quad = (x0: number, x1: number, z0: number, z1: number, y: number, base: number) => ({
        p: [x0, y, z0, x1, y, z0, x1, y, z1, x0, y, z1],
        i: [base, base + 2, base + 1, base, base + 3, base + 2]
    });
    const ground = quad(-50, 50, -50, 50, 1.5, 0);
    const roof = quad(-5, 5, -5, 5, 20, 4);
    fs.mkdirSync(MODELS_DIR, { recursive: true });
    fs.writeFileSync(path.join(MODELS_DIR, 'staged_tiles_test.glb'), makeGlb([...ground.p, ...roof.p], [...ground.i, ...roof.i]));
    return '/models/staged_tiles_test.glb';
}

function stagedScene(tileUri: string): (args: Record<string, unknown>, c: ToolContext) => Promise<ToolHandlerOutcome> {
    const tile = { id: 'tile-clay-1', content: { type: '3d-model', durableUri: tileUri, metadata: { role: 'environment', isGround: true } } };
    return async () => ({
        status: 'completed',
        resultPayload: {
            success: true, resolvedAddress: 'Union Square, San Francisco, CA', geoAnchor: { lat: 37.788, lng: -122.4075 },
            remesh: { ok: true }, artifact: { id: 'a', type: '3d-scene', title: 'Union Square', data: { renderMode: 'clay', environment: { skybox: 'studio', lighting: 'studio', ground: false }, objects: [tile], geoAnchor: { lat: 37.788, lng: -122.4075 } } }
        }
    });
}

describe('build_3d_object_from_reference', () => {
    it('is declared for the agent and offered in the core workspace pack', () => {
        expect(OBJECT_REFERENCE_TOOL_DECLARATIONS[0].name).toBe('build_3d_object_from_reference');
        const registry = createDefaultToolRegistry();
        expect(registry.get('build_3d_object_from_reference')?.group).toBe('workspace');
        expect(registry.declarations(['workspace']).some(d => d.name === 'build_3d_object_from_reference')).toBe(true);
        expect(CORE_WORKSPACE_PACK.toolNames).toContain('build_3d_object_from_reference');
    });

    it('asks only gemini-3.1-flash-lite-image for the reference and fails when it is not served (404)', async () => {
        const client = fakeClient({ image: [() => { throw httpError(404, `models/${REFERENCE_IMAGE_MODEL} is not found for API version v1beta`); }] });
        const { run, pythonRuns } = handlerWith(client);
        const out = await run({ request: 'a vintage brass telescope on a tripod' });
        expect(out.status).toBe('failed');
        expect(client.calls.map(c => c.model)).toEqual([REFERENCE_IMAGE_MODEL]);
        expect(out.resultPayload.stage).toBe('reference-image');
        expect(String(out.resultPayload.error)).toContain(REFERENCE_IMAGE_MODEL);
        expect(String(out.resultPayload.error)).toContain('unsupported');
        expect(out.resultPayload.artifact).toBeUndefined();
        expect(pythonRuns).toHaveLength(0);
        // The HTTP status is a detail of its own; it never replaces the outcome.
        expect(out.resultPayload).toMatchObject({ status: 'failed', success: false, httpStatus: 404 });
    });

    it('requests the image with responseModalities IMAGE at 1:1 and retries 503 and empty answers on the same model only', async () => {
        const client = fakeClient({
            image: [() => { throw httpError(503, 'UNAVAILABLE'); }, () => ({ candidates: [{ content: { parts: [{ text: 'no image' }] }, finishReason: 'STOP' }] }), () => imageResponse()],
            specs: ['not json', 'still not json']
        });
        const { run } = handlerWith(client);
        const out = await run({ request: 'a ceramic teapot' });
        const imageCalls = client.calls.filter(c => c.config?.responseModalities);
        expect(imageCalls.map(c => c.model)).toEqual([REFERENCE_IMAGE_MODEL, REFERENCE_IMAGE_MODEL, REFERENCE_IMAGE_MODEL]);
        expect(imageCalls[0].config.responseModalities).toEqual(['IMAGE']);
        expect(imageCalls[0].config.imageConfig).toEqual({ aspectRatio: '1:1' });
        expect(JSON.stringify(imageCalls[0].contents)).toContain('a ceramic teapot');
        expect(out.status).toBe('failed');
    });

    it('fails after three empty image answers instead of trying another model', async () => {
        const client = fakeClient({ image: [() => ({ candidates: [{ content: { parts: [] }, finishReason: 'STOP' }] })] });
        const out = await handlerWith(client).run({ request: 'a chess knight' });
        expect(out.status).toBe('failed');
        expect(out.resultPayload.stage).toBe('reference-image');
        expect(client.calls.map(c => c.model)).toEqual([REFERENCE_IMAGE_MODEL, REFERENCE_IMAGE_MODEL, REFERENCE_IMAGE_MODEL]);
        expect(String(out.resultPayload.error)).toContain('returned no image in 3 attempts');
    });

    it('fails on invalid vision JSON after one corrective re-ask, before any build', async () => {
        const client = fakeClient({ specs: ['{"subject": "", "parts": []', JSON.stringify({ subject: 'x', observations: [], boundingMeters: [1, 1, 1], expectedBodies: 1, parts: [{ id: 'a', label: 'a' }] })] });
        const { run, pythonRuns } = handlerWith(client);
        const out = await run({ request: 'a bioluminescent mycelium lantern' });
        expect(out.status).toBe('failed');
        expect(out.resultPayload.stage).toBe('build-spec');
        expect(client.calls.map(c => c.model)).toEqual([REFERENCE_IMAGE_MODEL, CHAT_MODEL, CHAT_MODEL]);
        // The re-ask quotes the validator's errors back to the same model.
        expect(JSON.stringify(client.calls[2].contents)).toContain('not valid JSON');
        expect(String(out.resultPayload.error)).toContain('must have exactly one of sweep, revolve, replicate, relief');
        expect(pythonRuns).toHaveLength(0);
        // The vision call is JSON mode with the spec schema stated in the request (Vertex refused responseJsonSchema).
        expect(client.calls[1].config.responseMimeType).toBe('application/json');
        expect(client.calls[1].config.responseJsonSchema).toBeUndefined();
        const visionParts = client.calls[1].contents[0].parts;
        expect(visionParts[0].inlineData.mimeType).toBe('image/png');
        expect(visionParts[visionParts.length - 1].text).toBe(schemaInstruction(OBJECT_BUILD_SPEC_JSON_SCHEMA));
    });

    it('gives a spec only the interpreter rejects the same corrective re-ask, quoting its problem', async () => {
        const client = fakeClient({ specs: [JSON.stringify(FLAT_COIN), JSON.stringify(VASE)] });
        const { run, pythonRuns } = handlerWith(client);
        const out = await run({ request: 'a fluted vase with a knob on top' });
        expect(out.status, String(out.resultPayload.error)).toBe('completed');
        const specCalls = client.calls.filter(isSpecCall);
        expect(specCalls).toHaveLength(2);
        expect(askedText(specCalls[1])).toContain('That build spec cannot be built');
        expect(askedText(specCalls[1])).toContain('part "coin" revolve.meridian: the outline encloses no area with the axis');
        expect(pythonRuns).toHaveLength(2);
        const passes = out.resultPayload.passes as any[];
        expect(passes[0]).toMatchObject({ pass: 1, specRequests: 2, outcome: 'built' });
        expect(passes[0].correctedProblems[0]).toContain('part "coin" revolve.meridian');
    }, 180_000);

    it('fails at the build stage with the interpreter\'s problems when the corrected spec still cannot be built', async () => {
        const client = fakeClient({ specs: [JSON.stringify(FLAT_COIN)] });
        const { run, pythonRuns } = handlerWith(client);
        const out = await run({ request: 'a coin' });
        expect(out.status).toBe('failed');
        expect(out.resultPayload.stage).toBe('build');
        expect(client.calls.filter(isSpecCall)).toHaveLength(2);
        expect(pythonRuns).toHaveLength(2);
        expect(String(out.resultPayload.error)).toContain('after one correction (the interpreter found: part "coin" revolve.meridian');
        expect(out.resultPayload.artifact).toBeUndefined();
    }, 180_000);

    it('fails with the Python error, without a re-ask, when the build crashes for a reason other than the spec', async () => {
        const client = fakeClient({ specs: [JSON.stringify(VASE)] });
        const out = await handlerWith(client, {
            runPython: async () => ({ success: false, exitCode: 1, stdout: '', stderr: 'Traceback (most recent call last):\nImportError: scratchbox_native is stale', executionTimeMs: 5, errorDetails: 'ImportError: scratchbox_native is stale' })
        }).run({ request: 'a fluted vase' });
        expect(out.status).toBe('failed');
        expect(out.resultPayload.stage).toBe('build');
        expect(String(out.resultPayload.error)).toContain('scratchbox_native is stale');
        expect(client.calls.filter(isSpecCall)).toHaveLength(1);
        expect(out.resultPayload.artifact).toBeUndefined();
    });

    it('reads the spec with the chat\'s default model when the request names none, and says so', async () => {
        const client = fakeClient({ specs: [JSON.stringify(VASE)] });
        const out = await handlerWith(client).run({ request: 'a fluted vase with a knob on top' }, ctx(null));
        expect(out.status, String(out.resultPayload.error)).toBe('completed');
        expect(client.calls.filter(c => !c.config?.responseModalities).every(c => c.model === CHAT_MODEL)).toBe(true);
        const build = (out.resultPayload.artifact as any).data.objectBuild;
        expect(build.visionModel).toEqual({ requested: CHAT_MODEL, used: CHAT_MODEL, answered: CHAT_MODEL, source: 'chat-default', skipped: [] });
        expect(out.summaryResult).toContain(`spec read by ${CHAT_MODEL}, the chat's default model`);
    }, 180_000);

    it('moves to the chat\'s next model when the named one is not served, and records why', async () => {
        const client = fakeClient({ specs: [JSON.stringify(VASE)], unserved: ['gemini-retired'] });
        const out = await handlerWith(client).run({ request: 'a fluted vase with a knob on top' }, ctx('gemini-retired'));
        expect(out.status, String(out.resultPayload.error)).toBe('completed');
        const visionCalls = client.calls.filter(c => !c.config?.responseModalities);
        // One 404 on the named model, then every vision call on the fallback.
        expect(visionCalls[0].model).toBe('gemini-retired');
        expect(visionCalls.slice(1).every(c => c.model === FALLBACK_MODEL)).toBe(true);
        const use = (out.resultPayload.artifact as any).data.objectBuild.visionModel;
        expect(use).toMatchObject({ requested: 'gemini-retired', used: FALLBACK_MODEL, source: 'request' });
        expect(use.skipped[0].model).toBe('gemini-retired');
        expect(use.skipped[0].reason).toContain('404');
        expect(out.summaryResult).toContain(`spec read by ${FALLBACK_MODEL} instead of the chat's model gemini-retired, which is not served`);
    }, 180_000);

    it('fails before any model call when no credentials are configured', async () => {
        const noCreds = await handlerWith(undefined).run({ request: 'a lamp' });
        expect(noCreds.status).toBe('failed');
        expect(noCreds.resultPayload.error).toBe('No Google API key or service account configured');
    });

    it('builds a clay 3d-scene from the spec without any image in the payload or on disk', async () => {
        const watched = [path.join(REPO_ROOT, 'build'), path.join(REPO_ROOT, 'public'), path.join(REPO_ROOT, '.scratchbox'), TMP];
        const before = filesIn(watched);
        const client = fakeClient({ specs: [JSON.stringify(VASE)], differences: ['{"differences": [{"problem": "the knob is slightly taller", "confidence": "low"}]}'] });
        const out = await handlerWith(client).run({ request: 'a fluted vase with a knob on top', dimensionsHintMeters: [0.36, 0.66, 0.36] });
        expect(out.status, String(out.resultPayload.error)).toBe('completed');

        const artifact = out.resultPayload.artifact as any;
        expect(artifact.type).toBe('3d-scene');
        expect(artifact.data.renderMode).toBe('clay');
        expect(artifact.data.environment).toEqual({ skybox: 'studio', lighting: 'studio', ground: false });
        expect(artifact.data.pythonGenerator.sourceCode).toContain('sb.object_spec.build(SPEC)');
        expect(artifact.data.objects[0].content.durableUri).toMatch(/^\/models\/.+\.glb$/);
        expect(fs.existsSync(String(out.resultPayload.glbPath))).toBe(true);
        const build = artifact.data.objectBuild;
        expect(build.spec.parts.map((p: any) => p.id)).toEqual(['vase', 'knob']);
        expect(build.imageModel).toEqual({ requested: REFERENCE_IMAGE_MODEL, answered: REFERENCE_IMAGE_MODEL });
        expect(build.visionModel).toMatchObject({ requested: CHAT_MODEL, used: CHAT_MODEL, source: 'request' });
        expect(build.passes).toHaveLength(1);
        expect(build.resultPass).toBe(1);
        expect(build.revisionFailed).toBeUndefined();
        expect(build.remainingDifferences).toEqual([]);
        // Measured detail: every listed part built and attached, one piece as the spec says; no vertex floor.
        expect(build.checks.parts.map((p: any) => [p.id, p.built, p.touchesParent])).toEqual([['vase', true, undefined], ['knob', true, true]]);
        expect(build.checks.missingParts).toEqual([]);
        expect(build.checks.detachedParts).toEqual([]);
        expect(build.checks.connectivity).toMatchObject({ passed: true, bodies: 1, expectedBodies: 1 });
        expect(build.checks.gate).toBeUndefined();
        expect(out.summaryResult).toContain(REFERENCE_IMAGE_MODEL);
        expect(out.summaryResult).toContain(CHAT_MODEL);
        expect(out.summaryResult).toContain('2 of 2 listed parts built and attached');

        // The comparison saw the reference and a clay render; the reference never comes back out.
        const compare = client.calls[client.calls.length - 1];
        expect(compare.contents[0].parts.filter((p: any) => p.inlineData)).toHaveLength(2);
        const payloadJson = JSON.stringify(out.resultPayload);
        expect(payloadJson).not.toContain(REFERENCE_B64);
        expect(payloadJson).not.toContain('iVBORw0KGgo');
        expect(payloadJson).not.toMatch(/image\/(png|jpeg|webp)/);
        // Other suites running in parallel may write their own images under build/, so the check is by content:
        // no file written meanwhile holds the reference (raw or base64), and the builder's own folders hold no image.
        const after = filesIn(watched);
        const written = [...after.entries()].filter(([file, mtime]) => before.get(file) !== mtime).map(([file]) => file)
            .filter(file => !file.includes(`${path.sep}test-results${path.sep}`));
        const holdsReference = written.filter(file => {
            const bytes = fs.readFileSync(file);
            return bytes.includes(REFERENCE_PNG) || bytes.includes(Buffer.from(REFERENCE_B64));
        });
        expect(holdsReference).toEqual([]);
        expect(written.filter(file => file.startsWith(TMP) && IMAGE_EXT.test(file))).toEqual([]);
        expect(written.some(file => file.startsWith(MODELS_DIR) && file.endsWith('.glb'))).toBe(true);
    }, 180_000);

    it('runs no label-based orientation check: a flat disc whose id is "wheel" is accepted in one pass', async () => {
        const client = fakeClient({ specs: [JSON.stringify(ROULETTE)] });
        const out = await handlerWith(client).run({ request: 'a roulette wheel' });
        expect(out.status, String(out.resultPayload.error)).toBe('completed');
        const passes = out.resultPayload.passes as any[];
        expect(passes).toHaveLength(1);
        expect(passes[0].problems).toEqual([]);
        expect(JSON.stringify(out.resultPayload)).not.toMatch(/Kinematic|orient/i);
    }, 180_000);

    it('revises a build whose parts float apart, sending the reference, the clay render and the conventions back', async () => {
        const client = fakeClient({ specs: [JSON.stringify(DETACHED), JSON.stringify(VASE)] });
        const { run, pythonRuns } = handlerWith(client);
        const out = await run({ request: 'a fluted vase with a knob on top' });
        expect(out.status, String(out.resultPayload.error)).toBe('completed');
        const passes = (out.resultPayload.passes as any[]);
        expect(passes).toHaveLength(2);
        expect(passes[0]).toMatchObject({ source: 'reference', bodies: 2, expectedBodies: 1, passedChecks: false });
        expect(passes[0].problems.join(' ')).toContain('2 separate pieces but expectedBodies is 1');
        expect(passes[1]).toMatchObject({ source: 'revision', bodies: 1, problems: [], passedChecks: true });
        expect(out.resultPayload.resultPass).toBe(2);
        expect(pythonRuns).toHaveLength(2);
        const revision = client.calls.find(c => askedText(c).includes('Return the complete corrected build spec'))!;
        expect(revision.model).toBe(CHAT_MODEL);
        expect(revision.contents[0].parts.filter((p: any) => p.inlineData)).toHaveLength(2);
        // The stateless revision request carries the full conventions block the first request had.
        const first = client.calls.find(isSpecCall)!;
        const conventions = askedText(first).slice(askedText(first).indexOf('Conventions'), askedText(first).indexOf('- observations:'));
        expect(conventions.length).toBeGreaterThan(2000);
        expect(askedText(revision)).toContain(conventions);
    }, 180_000);

    it('sends back a child that does not touch its parent even when the piece count matches', async () => {
        const client = fakeClient({ specs: [JSON.stringify(LIFTED_CHILD), JSON.stringify(VASE)] });
        const out = await handlerWith(client).run({ request: 'a fluted vase with a knob on top' });
        expect(out.status, String(out.resultPayload.error)).toBe('completed');
        const passes = out.resultPayload.passes as any[];
        expect(passes[0]).toMatchObject({ bodies: 2, expectedBodies: 2, detachedParts: ['knob'], passedChecks: false });
        expect(passes[0].problems[0]).toContain('Part "knob" does not touch its parent "vase"');
        expect(out.resultPayload.resultPass).toBe(2);
    }, 180_000);

    it('feeds high-confidence differences into the revisions and lists any left verbatim', async () => {
        const left = 'The knob should be a tall finial, about a third of the body height.';
        const client = fakeClient({ specs: [JSON.stringify(VASE)], differences: [highDifference(left, 'knob')] });
        const out = await handlerWith(client).run({ request: 'a fluted vase with a tall finial' });
        expect(out.status, String(out.resultPayload.error)).toBe('completed');
        const revisions = client.calls.filter(c => askedText(c).includes('Return the complete corrected build spec'));
        expect(revisions).toHaveLength(2);
        expect(askedText(revisions[0])).toContain(`Part "knob": ${left}`);
        const build = (out.resultPayload.artifact as any).data.objectBuild;
        expect(build.passes).toHaveLength(3);
        expect(build.resultPass).toBe(3);
        expect(build.remainingDifferences).toEqual([{ partId: 'knob', problem: left, confidence: 'high' }]);
        expect(out.summaryResult).toContain(`Differences from the reference that remain in pass 3: "part "knob": ${left}"`);
    }, 180_000);

    it('returns the last build that passed every check, and says so, when a revision cannot be built', async () => {
        const client = fakeClient({ specs: [JSON.stringify(VASE), 'not json', '{"also": "not a spec"}'], differences: [highDifference('The body should be taller.')] });
        const { run, pythonRuns } = handlerWith(client);
        const out = await run({ request: 'a tall fluted vase' });
        expect(out.status, String(out.resultPayload.error)).toBe('completed');
        expect(pythonRuns).toHaveLength(1);
        const build = (out.resultPayload.artifact as any).data.objectBuild;
        expect(build.resultPass).toBe(1);
        expect(build.revisionFailed).toMatchObject({ pass: 2, stage: 'build-spec' });
        expect(build.revisionFailed.reason).toContain('did not produce a buildable spec after one correction');
        expect(build.passes.map((p: any) => p.outcome)).toEqual(['built', 'failed']);
        expect(build.remainingDifferences).toEqual([{ problem: 'The body should be taller.', confidence: 'high' }]);
        expect(out.summaryResult).toContain('Revision pass 2 failed (build-spec:');
        expect(out.summaryResult).toContain('the result is pass 1, the last build that passed every check');
    }, 180_000);

    it('reports a revision the interpreter rejects twice as failed and returns pass 1', async () => {
        const client = fakeClient({ specs: [JSON.stringify(VASE), JSON.stringify(FLAT_COIN)], differences: [highDifference('The body should be taller.')] });
        const out = await handlerWith(client).run({ request: 'a tall fluted vase' });
        expect(out.status, String(out.resultPayload.error)).toBe('completed');
        expect(out.resultPayload.revisionFailed).toMatchObject({ pass: 2, stage: 'build' });
        expect(out.resultPayload.resultPass).toBe(1);
        expect(out.summaryResult).toContain('Revision pass 2 failed (build:');
    }, 180_000);

    it('returns an earlier pass when the last revision still fails its checks', async () => {
        const client = fakeClient({ specs: [JSON.stringify(VASE), JSON.stringify(DETACHED)], differences: [highDifference('The body should be taller.')] });
        const out = await handlerWith(client).run({ request: 'a tall fluted vase' });
        expect(out.status, String(out.resultPayload.error)).toBe('completed');
        expect(out.resultPayload.resultPass).toBe(1);
        expect(out.resultPayload.revisionFailed).toMatchObject({ pass: 3, stage: 'checks' });
        expect(out.summaryResult).toContain('Revision pass 3 failed (checks:');
    }, 180_000);

    it('re-asks once for a malformed comparison, and fails the check when it stays malformed', async () => {
        const fixed = fakeClient({ specs: [JSON.stringify(VASE)], differences: ['{"differences": [{"problem": "knob a little small", "confidence": "medium"}]}', NO_DIFFERENCES] });
        const ok = await handlerWith(fixed).run({ request: 'a fluted vase with a knob on top' });
        expect(ok.status, String(ok.resultPayload.error)).toBe('completed');
        const comparisons = fixed.calls.filter(isComparisonCall);
        expect(comparisons).toHaveLength(2);
        expect(askedText(comparisons[1])).toContain('confidence "high" or "low"');

        const broken = fakeClient({ specs: [JSON.stringify(VASE)], differences: ['{"differences": [{"problem": "x", "confidence": "medium"}]}'] });
        const out = await handlerWith(broken).run({ request: 'a fluted vase with a knob on top' });
        expect(out.status).toBe('failed');
        expect(out.resultPayload.stage).toBe('checks');
        expect(String(out.resultPayload.error)).toContain('did not return a usable comparison');
        expect(out.resultPayload.artifact).toBeUndefined();
    }, 180_000);

    it('rejects a build that never passes its checks and mounts nothing', async () => {
        const client = fakeClient({ specs: [JSON.stringify(DETACHED)] });
        const { run, pythonRuns } = handlerWith(client);
        const out = await run({ request: 'a fluted vase with a knob on top' });
        expect(out.status).toBe('failed');
        expect(out.resultPayload.stage).toBe('checks');
        expect(out.resultPayload.artifact).toBeUndefined();
        expect(pythonRuns).toHaveLength(3);
        expect(String(out.resultPayload.error)).toContain('No build passed every check');
    }, 180_000);

    it('with a location, stages on the clay tiles path first and fails the call when staging fails', async () => {
        const client = fakeClient({ specs: [JSON.stringify(VASE)] });
        const stageArgs: Array<Record<string, unknown>> = [];
        const failing = handlerWith(client, {
            stageAtLocation: async args => { stageArgs.push(args); return { status: 'failed', resultPayload: { status: 'failed', error: 'No place matched "Atlantis Plaza"' }, summaryResult: 'Failed' }; }
        });
        const out = await failing.run({ request: 'a bronze statue', location: 'Atlantis Plaza', placement: { eastMeters: 0, northMeters: 0, headingDeg: 0 } });
        expect(out.status).toBe('failed');
        expect(out.resultPayload.stage).toBe('staging');
        expect(String(out.resultPayload.error)).toContain('No place matched "Atlantis Plaza"');
        expect(stageArgs).toEqual([{ query: 'Atlantis Plaza' }]);
        expect(client.calls).toHaveLength(0);

        const unremeshed = await handlerWith(client, {
            stageAtLocation: async () => ({ status: 'completed', resultPayload: { success: true, remesh: { ok: false, error: 'tile_refine crashed' }, artifact: { type: '3d-scene', data: { objects: [] } } } })
        }).run({ request: 'a bronze statue', location: 'Union Square, San Francisco', placement: { eastMeters: 0, northMeters: 0, headingDeg: 0 } });
        expect(unremeshed.status).toBe('failed');
        expect(String(unremeshed.resultPayload.error)).toContain('not remeshed (tile_refine crashed)');
    });

    it('with a location and placement, stands the object at its offset and heading and frames the camera on it', async () => {
        const client = fakeClient({ specs: [JSON.stringify(VASE)] });
        const out = await handlerWith(client, { stageAtLocation: stagedScene(writeStagedTiles()) })
            .run({ request: 'a fluted vase', location: 'Union Square, San Francisco', placement: { eastMeters: 12, northMeters: 8, headingDeg: 90 } });
        expect(out.status, String(out.resultPayload.error)).toBe('completed');
        const artifact = out.resultPayload.artifact as any;
        expect(artifact.title).toContain('Union Square, San Francisco, CA');
        expect(artifact.data.objects.map((o: any) => o.content.metadata.role)).toEqual(['environment', 'hero']);
        expect(artifact.data.geoAnchor).toEqual({ lat: 37.788, lng: -122.4075 });
        // Tile frame: x east, z south. The base rests on the surface there (y 0 lets the viewport seat it).
        const hero = artifact.data.objects[1];
        expect(hero.space.spatial3d).toEqual({ x: 12, y: 0, z: -8, yaw: 90 });
        const placement = artifact.data.objectBuild.placement;
        expect(placement).toEqual({ eastMeters: 12, northMeters: 8, headingDeg: 90, sceneX: 12, sceneZ: -8, yawDeg: 90, surfaceYMeters: 1.5 });
        expect(artifact.data.objectBuild.location).toEqual({ query: 'Union Square, San Francisco', resolvedAddress: 'Union Square, San Francisco, CA' });
        // The camera looks at the object's middle, from close by, not at the whole district.
        const size = artifact.data.objectBuild.checks.builtBoundingMeters;
        expect(artifact.data.camera.target[0]).toBeCloseTo(12, 3);
        expect(artifact.data.camera.target[1]).toBeCloseTo(1.5 + size[1] / 2, 2);
        expect(artifact.data.camera.target[2]).toBeCloseTo(-8, 3);
        const distance = Math.hypot(...[0, 1, 2].map(k => artifact.data.camera.position[k] - artifact.data.camera.target[k]));
        expect(distance).toBeLessThan(5);
        expect(out.summaryResult).toContain('12 m east and 8 m north of the anchor, facing 90 degrees');
        expect(out.summaryResult).toContain('call build_3d_object_from_reference with specJson set to the edited spec, and with this location and placement');
    }, 180_000);

    it('is drawn by the viewport where the placement says, whichever of the object and the tiles loads first', async () => {
        const tileUri = writeStagedTiles();
        const client = fakeClient({ specs: [JSON.stringify(VASE)] });
        const handler = handlerWith(client, { stageAtLocation: stagedScene(tileUri) });
        for (const placementArgs of [{ eastMeters: 12, northMeters: 8, headingDeg: 90 }, { eastMeters: 1, northMeters: -2, headingDeg: 200 }]) {
            const out = await handler.run({ request: 'a fluted vase', location: 'Union Square, San Francisco', placement: placementArgs });
            expect(out.status, String(out.resultPayload.error)).toBe('completed');
            const data = (out.resultPayload.artifact as any).data;
            const placement = data.objectBuild.placement;
            const hero = data.objects.find((o: any) => o.content.metadata.role === 'hero');

            // Scene3DPrimitive: effect 5b draws an inline generator GLB at the origin, unturned, and effect 5c then
            // drops every object loading the same file; 5a-bis rebuilds a generator without one unless an object
            // loads its file. The staged object must reach the viewport as the hero object, so no inline GLB.
            const gen = data.pythonGenerator;
            expect(gen.glbBase64).toBeUndefined();
            expect(gen.sourceCode).toContain('sb.object_spec.build(SPEC)');
            const generatorGlbFile = gen.glbBase64 ? path.basename(gen.glbPath) : undefined;
            const drawn = data.objects.filter((o: any) => !generatorGlbFile || path.basename(o.content.durableUri) !== generatorGlbFile);
            expect(drawn).toContain(hero);
            expect(generatorFileIsObject(gen, data.objects)).toBe(true);

            // Seat it with the real TerrainManager by the viewport's settleOnGround rules, in both load orders.
            const meshFrom = (file: string) => {
                const soup = glbToTriangleSoup(fs.readFileSync(file))!;
                const geometry = new THREE.BufferGeometry();
                geometry.setAttribute('position', new THREE.BufferAttribute(soup.positions, 3));
                geometry.setIndex(new THREE.BufferAttribute(soup.indices, 1));
                return new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }));
            };
            const s = hero.space.spatial3d;
            for (const order of ['object first', 'tiles first']) {
                const scene = new THREE.Scene();
                const terrain = new TerrainManager({ scene });
                const tiles = meshFrom(path.join(MODELS_DIR, path.basename(tileUri)));
                const model = meshFrom(String(out.resultPayload.glbPath));
                model.position.set(s.x, s.y, s.z);
                model.rotation.y = (s.yaw * Math.PI) / 180;
                // A hero attaching: y 0 snaps it onto the ground. Tiles attaching: every hero is re-seated with y as an offset.
                const heroAttaches = () => { scene.add(model); if (!s.y) terrain.snapObjectToGround(model, 0); };
                const tilesAttach = () => { scene.add(tiles); if (model.parent) terrain.snapObjectToGround(model, s.y !== 0 ? s.y : 0); };
                if (order === 'object first') { heroAttaches(); tilesAttach(); } else { tilesAttach(); heroAttaches(); }
                const box = new THREE.Box3().setFromObject(model);
                expect(box.min.y, order).toBeCloseTo(placement.surfaceYMeters, 3);
                expect((box.min.x + box.max.x) / 2, order).toBeCloseTo(placement.sceneX, 1);
                expect((box.min.z + box.max.z) / 2, order).toBeCloseTo(placement.sceneZ, 1);
                expect(data.camera.target[0]).toBeCloseTo(placement.sceneX, 3);
                expect(data.camera.target[2]).toBeCloseTo(placement.sceneZ, 3);
                expect(data.camera.target[1]).toBeGreaterThan(box.min.y);
                expect(data.camera.target[1]).toBeLessThan(box.max.y);
                if (order === 'object first') {
                    // Screenshot: the seated object on the staged surface, cropped to 3 m around it and 2 m above and
                    // below (tiles the crop squashes to nothing, or another level, would stretch the framing).
                    const tileSoup = glbToTriangleSoup(fs.readFileSync(path.join(MODELS_DIR, path.basename(tileUri))))!;
                    const crop = new Float32Array(tileSoup.positions);
                    for (let i = 0; i < crop.length; i += 3) {
                        crop[i] = Math.min(placement.sceneX + 1.5, Math.max(placement.sceneX - 1.5, crop[i]));
                        crop[i + 2] = Math.min(placement.sceneZ + 1.5, Math.max(placement.sceneZ - 1.5, crop[i + 2]));
                    }
                    const at = (k: number) => new THREE.Vector3(crop[k * 3], crop[k * 3 + 1], crop[k * 3 + 2]);
                    const cropPositions: number[] = [];
                    for (let t = 0; t < tileSoup.indices.length; t += 3) {
                        const [a, b, c] = [at(tileSoup.indices[t]), at(tileSoup.indices[t + 1]), at(tileSoup.indices[t + 2])];
                        const nearSurface = [a, b, c].every(p => Math.abs(p.y - placement.surfaceYMeters) < 2);
                        if (nearSurface && b.clone().sub(a).cross(c.clone().sub(a)).length() > 1e-6) cropPositions.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z);
                    }
                    const heroSoup = glbToTriangleSoup(fs.readFileSync(String(out.resultPayload.glbPath)))!;
                    model.updateMatrixWorld(true);
                    const v = new THREE.Vector3();
                    const placed = new Float32Array(heroSoup.positions.length);
                    for (let i = 0; i < placed.length; i += 3) {
                        v.set(heroSoup.positions[i], heroSoup.positions[i + 1], heroSoup.positions[i + 2]).applyMatrix4(model.matrixWorld);
                        placed.set([v.x, v.y, v.z], i);
                    }
                    const scene3 = mergeTriangleSoups([{ positions: Float32Array.from(cropPositions), indices: Uint32Array.from({ length: cropPositions.length / 3 }, (_, i) => i) }, { positions: placed, indices: heroSoup.indices }]);
                    const [view] = renderReviewViews(scene3, 512, { views: [{ label: 'three-quarter view', azimuthDeg: 35, elevationDeg: 22 }] });
                    fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
                    fs.writeFileSync(path.join(SCREENSHOT_DIR, `object_reference_placed_e${placementArgs.eastMeters}_n${placementArgs.northMeters}.png`), view.png);
                }
            }
        }
    }, 180_000);

    it('with a location, needs a placement, and rests the object on a roof when one is there', async () => {
        const client = fakeClient({ specs: [JSON.stringify(VASE)] });
        const stageArgs: unknown[] = [];
        const tileUri = writeStagedTiles();
        const staging = stagedScene(tileUri);
        const handler = handlerWith(client, { stageAtLocation: async (args, c) => { stageArgs.push(args); return staging(args, c); } });
        const missing = await handler.run({ request: 'a fluted vase', location: 'Union Square, San Francisco' });
        expect(missing.status).toBe('failed');
        expect(String(missing.resultPayload.error)).toContain('With location, pass placement {eastMeters, northMeters, headingDeg}');
        expect(stageArgs).toHaveLength(0);
        expect(client.calls).toHaveLength(0);

        const out = await handler.run({ request: 'a fluted vase', location: 'Union Square, San Francisco', placement: { eastMeters: 0, northMeters: 0, headingDeg: 180 } });
        expect(out.status, String(out.resultPayload.error)).toBe('completed');
        expect((out.resultPayload.artifact as any).data.objectBuild.placement.surfaceYMeters).toBe(20);
        expect(out.summaryResult).toContain('likely a roof or raised structure');
    }, 180_000);

    it('fails before any model call when the placement is off the staged tiles, lifts the object, or has no location', async () => {
        const client = fakeClient({ specs: [JSON.stringify(VASE)] });
        const off = await handlerWith(client, { stageAtLocation: stagedScene(writeStagedTiles()) })
            .run({ request: 'a fluted vase', location: 'Union Square, San Francisco', placement: { eastMeters: 400, northMeters: 0, headingDeg: 0 } });
        expect(off.status).toBe('failed');
        expect(off.resultPayload.stage).toBe('placement');
        expect(String(off.resultPayload.error)).toContain('outside the staged tiles');
        // No lift: the viewport would seat a lifted object at a height that depends on load order.
        const lifted = await handlerWith(client, { stageAtLocation: stagedScene(writeStagedTiles()) })
            .run({ request: 'a balloon', location: 'Union Square, San Francisco', placement: { eastMeters: 0, northMeters: 0, headingDeg: 0, upMeters: 1 } });
        expect(lifted.status).toBe('failed');
        expect(String(lifted.resultPayload.error)).toContain('placement takes only eastMeters, northMeters and headingDeg (not upMeters)');
        const noPlace = await handlerWith(client).run({ request: 'a fluted vase', placement: { eastMeters: 1, northMeters: 1, headingDeg: 0 } });
        expect(noPlace.status).toBe('failed');
        expect(String(noPlace.resultPayload.error)).toContain('placement is relative to a place');
        expect(client.calls).toHaveLength(0);
    });

    it('rebuilds a given spec exactly, with no model call, and keeps the object at its place', async () => {
        const client = fakeClient({});
        const taller: ObjectBuildSpec = { ...VASE, boundingMeters: [0.36, 0.86, 0.36], parts: [{ ...VASE.parts[0], revolve: revolve([[0, 0], [0, 0.12], [0.3, 0.18], [0.65, 0.1], [0.8, 0.14]], { smoothing: 0.8, lobeCount: 10, lobeDepthRatio: 0.15, helixPitchMeters: 0.9 }) }, VASE.parts[1]] };
        const { run, pythonRuns } = handlerWith(client, { stageAtLocation: stagedScene(writeStagedTiles()) });
        const out = await run({ request: 'make the vase taller', specJson: JSON.stringify(taller), location: 'Union Square, San Francisco', placement: { eastMeters: 12, northMeters: 8, headingDeg: 90 } });
        expect(out.status, String(out.resultPayload.error)).toBe('completed');
        expect(client.calls).toHaveLength(0);
        expect(pythonRuns).toHaveLength(1);
        const build = (out.resultPayload.artifact as any).data.objectBuild;
        expect(build.source).toBe('spec');
        expect(build.spec).toEqual(taller);
        expect(build.imageModel).toBeUndefined();
        expect(build.visionModel).toBeUndefined();
        expect(build.remainingDifferences).toBeUndefined();
        expect(build.passes).toEqual([expect.objectContaining({ pass: 1, source: 'spec', outcome: 'built', passedChecks: true })]);
        expect(build.checks.parts.map((p: any) => [p.id, p.built, p.touchesParent])).toEqual([['vase', true, undefined], ['knob', true, true]]);
        expect(build.checks.builtBoundingMeters[1]).toBeGreaterThan(0.8);
        expect(build.placement).toMatchObject({ sceneX: 12, sceneZ: -8, yawDeg: 90 });
        expect((out.resultPayload.artifact as any).data.objects[1].space.spatial3d).toEqual({ x: 12, y: 0, z: -8, yaw: 90 });
        expect(out.summaryResult).toContain('from the given spec, built exactly as given');
        expect(out.summaryResult).toContain('No reference image was drawn and no model was called or compared the result.');
    }, 180_000);

    it('fails a given spec with every problem listed when it cannot be built or does not pass its checks', async () => {
        const client = fakeClient({});
        const { run } = handlerWith(client);
        const badJson = await run({ request: 'the vase', specJson: '{"subject": "vase", ' });
        expect(badJson.resultPayload).toMatchObject({ status: 'failed', stage: 'build-spec' });
        expect(String(badJson.resultPayload.error)).toContain('specJson is not valid JSON');
        const invalid = await run({ request: 'the vase', specJson: JSON.stringify({ ...VASE, parts: [{ id: 'a', label: 'a' }] }) });
        expect(invalid.resultPayload.stage).toBe('build-spec');
        expect(String(invalid.resultPayload.error)).toContain('must have exactly one of sweep, revolve, replicate, relief');
        const flat = await run({ request: 'a coin', specJson: JSON.stringify(FLAT_COIN) });
        expect(flat.resultPayload.stage).toBe('build');
        expect(String(flat.resultPayload.error)).toContain('part "coin" revolve.meridian: the outline encloses no area with the axis');
        const apart = await run({ request: 'the vase', specJson: JSON.stringify(DETACHED) });
        expect(apart.resultPayload.stage).toBe('checks');
        expect(String(apart.resultPayload.error)).toContain('The build is 2 separate pieces but expectedBodies is 1');
        expect(apart.resultPayload.artifact).toBeUndefined();
        const sized = await run({ request: 'the vase', specJson: JSON.stringify(VASE), dimensionsHintMeters: [1, 1, 1] });
        expect(String(sized.resultPayload.error)).toContain('with specJson, set the sizes in the spec itself');
        expect(client.calls).toHaveLength(0);
    }, 180_000);

    it('passes a stop to the Python process and ends at the build without checking or comparing', async () => {
        const controller = new AbortController();
        const client = fakeClient({ specs: [JSON.stringify(VASE)] });
        let seen: AbortSignal | undefined;
        const { run } = handlerWith(client, {
            runPython: async (_script, options) => {
                seen = options.signal;
                controller.abort();
                return { success: false, exitCode: 1, stdout: '', stderr: 'The operation was aborted', executionTimeMs: 1, errorDetails: 'The operation was aborted' };
            }
        });
        const out = await run({ request: 'a fluted vase' }, { ...ctx(), signal: controller.signal });
        // The runner gets a signal that the stop (or the build's time limit) aborts.
        expect(seen?.aborted).toBe(true);
        expect(out.status).toBe('failed');
        expect(out.resultPayload).toMatchObject({ status: 'failed', stage: 'build', aborted: true, error: 'Stopped by the user.' });
        expect(client.calls.filter(isComparisonCall)).toHaveLength(0);
    });

    it('reports a stop during a model call as a stop, not as a model failure', async () => {
        const controller = new AbortController();
        const client: GenerateContentClient = {
            models: {
                generateContent: (params: any) => new Promise((_, reject) => {
                    const signal: AbortSignal | undefined = params.config?.abortSignal;
                    const abort = () => reject(Object.assign(new Error('This operation was aborted'), { name: 'AbortError' }));
                    if (signal?.aborted) abort(); else signal?.addEventListener('abort', abort);
                })
            }
        };
        setTimeout(() => controller.abort(), 50);
        const out = await handlerWith(client).run({ request: 'a fluted vase' }, { ...ctx(), signal: controller.signal });
        expect(out.status).toBe('failed');
        expect(out.resultPayload).toMatchObject({ status: 'failed', stage: 'reference-image', aborted: true, error: 'Stopped by the user.' });
        expect(out.resultPayload.code).toBeUndefined();
    });

    it('says a build ran out of time, re-asks once quoting the limit, and fails naming it', async () => {
        // A runner that only ends when its signal is aborted, like a build that never finishes in time.
        const hang = (_script: string, options: any) => new Promise<PythonExecutionResult>(resolve => {
            options.signal.addEventListener('abort', () => resolve({ success: false, exitCode: 1, stdout: '', stderr: 'Command failed: python scene.py', executionTimeMs: 1000, errorDetails: 'Command failed: python scene.py' }));
        });
        const given = await handlerWith(fakeClient({}), { runPython: hang, buildTimeoutMs: 1000 }).run({ request: 'the vase', specJson: JSON.stringify(VASE) });
        expect(given.status).toBe('failed');
        expect(given.resultPayload).toMatchObject({ stage: 'build', timedOut: true, timeoutMs: 1000 });
        expect(String(given.resultPayload.error)).toContain('The build did not finish within 1 s, so it was stopped');
        expect(String(given.resultPayload.error)).not.toContain('Command failed');

        const client = fakeClient({ specs: [JSON.stringify(VASE)] });
        const fresh = await handlerWith(client, { runPython: hang, buildTimeoutMs: 1000 }).run({ request: 'a fluted vase' });
        expect(fresh.status).toBe('failed');
        expect(fresh.resultPayload).toMatchObject({ stage: 'build', timedOut: true });
        expect(String(fresh.resultPayload.error)).toContain('the build ran out of time: The build did not finish within 1 s');
        const specCalls = client.calls.filter(isSpecCall);
        expect(specCalls).toHaveLength(2);
        expect(askedText(specCalls[1])).toContain('The build did not finish within 1 s, so it was stopped');
    }, 60_000);

    it('the Python runner kills the script when its signal aborts', async () => {
        const controller = new AbortController();
        const started = Date.now();
        setTimeout(() => controller.abort(), 1500);
        const res = await NativePythonRunnerService.getInstance().runScript('import time\ntime.sleep(90)\n', { outputDir: path.join(TMP, 'build'), timeoutMs: 120_000, signal: controller.signal });
        expect(res.success).toBe(false);
        expect(Date.now() - started).toBeLessThan(45_000);
    }, 180_000);

    it('turns the object front (+Z) to a compass heading in the tile frame (x east, z south)', () => {
        const front = (heading: number) => {
            const yaw = (yawForHeading(heading) * Math.PI) / 180;
            return [Math.sin(yaw), Math.cos(yaw)].map(v => +v.toFixed(6) + 0);
        };
        expect(front(0)).toEqual([0, -1]);   // north is -z
        expect(front(90)).toEqual([1, 0]);   // east is +x
        expect(front(180)).toEqual([0, 1]);  // south is +z
        expect(front(270)).toEqual([-1, 0]); // west is -x
    });
});
