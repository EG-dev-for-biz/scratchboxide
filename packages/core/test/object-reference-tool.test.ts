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
 * gemini-3.1-flash-lite-image, every failing stage fails the call with its own error, the native build is real, and
 * the reference image never reaches the payload or the disk.
 */

import { describe, it, expect, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createObjectReferenceHandlers, OBJECT_REFERENCE_TOOL_DECLARATIONS } from '../src/node/gemini/tools/object-reference-tools';
import { REFERENCE_IMAGE_MODEL, type GenerateContentClient } from '../src/node/3d-engine/reference-object-builder';
import { OBJECT_BUILD_SPEC_JSON_SCHEMA, type ObjectBuildSpec } from '../src/common/spatial/object-build-spec';
import { NativePythonRunnerService, type PythonExecutionResult } from '../src/node/3d-engine/native-python-runner-service';
import { HeadlessMeshSilhouetteRenderer } from '../src/node/spatial/HeadlessMeshSilhouetteRenderer';
import { createDefaultToolRegistry } from '../src/node/gemini/tool-registry';
import { CORE_WORKSPACE_PACK } from '../src/node/gemini/domain-tool-packs';
import type { ToolContext, ToolHandlerOutcome } from '../src/node/gemini/tools/types';
import { REPO_ROOT } from './helpers/requirements';

const CHAT_MODEL = 'gemini-4-argon';
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'sbx-object-ref-'));
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

interface Call { model: string; config: any; contents: any[] }

/** Records every call; image calls and JSON calls are answered by the given scripts in order. */
function fakeClient(opts: {
    image?: Array<(call: Call) => any>;
    specs?: string[];
    differences?: string[];
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
                if (params.config?.responseModalities?.includes('IMAGE')) {
                    const next = images.length > 1 ? images.shift()! : images[0];
                    return next(call);
                }
                const isSpec = params.config?.responseJsonSchema === OBJECT_BUILD_SPEC_JSON_SCHEMA;
                const queue = isSpec ? specs : diffs;
                const text = queue.length > 1 ? queue.shift()! : (queue[0] ?? (isSpec ? '' : '{"differences": []}'));
                return { candidates: [{ content: { parts: [{ text }] } }], modelVersion: params.model } as any;
            }
        }
    };
}

function imageResponse(): any {
    return { candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: REFERENCE_B64 } }] }, finishReason: 'STOP' }], modelVersion: REFERENCE_IMAGE_MODEL };
}

function httpError(status: number, message: string): Error {
    return Object.assign(new Error(message), { status });
}

function ctx(model: string | undefined = CHAT_MODEL): ToolContext {
    return { request: { prompt: 'build it', model } as any, workspaceRoot: REPO_ROOT } as ToolContext;
}

function handlerWith(client: GenerateContentClient | undefined, extra: {
    runPython?: (script: string, options: any) => Promise<PythonExecutionResult>;
    stageAtLocation?: (args: Record<string, unknown>, ctx: ToolContext) => Promise<ToolHandlerOutcome>;
} = {}) {
    const pythonRuns: string[] = [];
    const runPython = extra.runPython ?? ((script: string, options: any) => NativePythonRunnerService.getInstance().runScript(script, options));
    const handlers = createObjectReferenceHandlers({
        builder: {
            createClient: async () => client,
            runPython: async (script, options) => { pythonRuns.push(script); return runPython(script, options); },
            outputDir: path.join(TMP, 'build'),
            sleep: async () => undefined
        },
        stageAtLocation: extra.stageAtLocation,
        publicModelsDir: path.join(TMP, 'models')
    });
    return { run: (args: Record<string, unknown>, c: ToolContext = ctx()) => handlers.build_3d_object_from_reference(args, c), pythonRuns };
}

const IMAGE_EXT = /\.(png|jpe?g|webp|gif|bmp)$/i;
function imageFiles(dirs: string[]): Map<string, number> {
    const found = new Map<string, number>();
    const walk = (dir: string, depth: number) => {
        if (depth > 6 || !fs.existsSync(dir)) return;
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) walk(full, depth + 1);
            else if (IMAGE_EXT.test(entry.name)) found.set(full, fs.statSync(full).mtimeMs);
        }
    };
    dirs.forEach(d => walk(d, 0));
    return found;
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
        // The vision call is structured output against the spec schema.
        expect(client.calls[1].config.responseMimeType).toBe('application/json');
        expect(client.calls[1].config.responseJsonSchema).toBe(OBJECT_BUILD_SPEC_JSON_SCHEMA);
    });

    it('fails with the Python error when the native build fails', async () => {
        const client = fakeClient({ specs: [JSON.stringify(VASE)] });
        const out = await handlerWith(client, {
            runPython: async () => ({ success: false, exitCode: 1, stdout: '', stderr: 'Traceback (most recent call last):\nSpecError: part "vase" needs 900 x 900 samples', executionTimeMs: 5, errorDetails: 'SpecError: part "vase" needs 900 x 900 samples' })
        }).run({ request: 'a fluted vase' });
        expect(out.status).toBe('failed');
        expect(out.resultPayload.stage).toBe('build');
        expect(String(out.resultPayload.error)).toContain('part "vase" needs 900 x 900 samples');
        expect(out.resultPayload.artifact).toBeUndefined();
    });

    it('fails before any model call when no chat model or no credentials are configured', async () => {
        const client = fakeClient({});
        const noModel = await handlerWith(client).run({ request: 'a lamp' }, ctx(''));
        expect(noModel.status).toBe('failed');
        expect(String(noModel.resultPayload.error)).toContain('No chat model');
        const noCreds = await handlerWith(undefined).run({ request: 'a lamp' });
        expect(noCreds.status).toBe('failed');
        expect(noCreds.resultPayload.error).toBe('No Google API key or service account configured');
        expect(client.calls).toHaveLength(0);
    });

    it('builds a clay 3d-scene from the spec without any image in the payload or on disk', async () => {
        const watched = [path.join(REPO_ROOT, 'build'), path.join(REPO_ROOT, 'public'), path.join(REPO_ROOT, '.scratchbox'), TMP];
        const before = imageFiles(watched);
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
        expect(build.visionModel).toEqual({ requested: CHAT_MODEL, answered: CHAT_MODEL });
        expect(build.passes).toHaveLength(1);
        expect(build.checks.gate.passed).toBe(true);
        expect(build.checks.connectivity).toMatchObject({ passed: true, bodies: 1, expectedBodies: 1 });
        expect(out.summaryResult).toContain(REFERENCE_IMAGE_MODEL);
        expect(out.summaryResult).toContain(CHAT_MODEL);

        // The comparison saw the reference and a clay render; the reference never comes back out.
        const compare = client.calls[client.calls.length - 1];
        expect(compare.contents[0].parts.filter((p: any) => p.inlineData)).toHaveLength(2);
        const payloadJson = JSON.stringify(out.resultPayload);
        expect(payloadJson).not.toContain(REFERENCE_B64);
        expect(payloadJson).not.toContain('iVBORw0KGgo');
        expect(payloadJson).not.toMatch(/image\/(png|jpeg|webp)/);
        const after = imageFiles(watched);
        const added = [...after.entries()].filter(([file, mtime]) => before.get(file) !== mtime).map(([file]) => file)
            .filter(file => !file.includes(`${path.sep}test-results${path.sep}`));
        expect(added).toEqual([]);
    }, 180_000);

    it('revises a build whose parts float apart, sending the reference and the clay render back', async () => {
        const client = fakeClient({ specs: [JSON.stringify(DETACHED), JSON.stringify(VASE)] });
        const { run, pythonRuns } = handlerWith(client);
        const out = await run({ request: 'a fluted vase with a knob on top' });
        expect(out.status, String(out.resultPayload.error)).toBe('completed');
        const passes = (out.resultPayload.passes as any[]);
        expect(passes).toHaveLength(2);
        expect(passes[0]).toMatchObject({ source: 'reference', bodies: 2, expectedBodies: 1 });
        expect(passes[0].problems.join(' ')).toContain('2 separate pieces but expectedBodies is 1');
        expect(passes[1]).toMatchObject({ source: 'revision', bodies: 1, problems: [] });
        expect(pythonRuns).toHaveLength(2);
        const revision = client.calls.find(c => JSON.stringify(c.contents).includes('Return the complete corrected build spec'))!;
        expect(revision.model).toBe(CHAT_MODEL);
        expect(revision.contents[0].parts.filter((p: any) => p.inlineData)).toHaveLength(2);
    }, 180_000);

    it('rejects a build that still fails connectivity after two revisions and mounts nothing', async () => {
        const client = fakeClient({ specs: [JSON.stringify(DETACHED)] });
        const { run, pythonRuns } = handlerWith(client);
        const out = await run({ request: 'a fluted vase with a knob on top' });
        expect(out.status).toBe('failed');
        expect(out.resultPayload.stage).toBe('checks');
        expect(out.resultPayload.artifact).toBeUndefined();
        expect(pythonRuns).toHaveLength(3);
        expect(String(out.resultPayload.error)).toContain('after 2 revision passes');
    }, 180_000);

    it('with a location, stages on the clay tiles path first and fails the call when staging fails', async () => {
        const client = fakeClient({ specs: [JSON.stringify(VASE)] });
        const stageArgs: Array<Record<string, unknown>> = [];
        const failing = handlerWith(client, {
            stageAtLocation: async args => { stageArgs.push(args); return { status: 'failed', resultPayload: { status: 'failed', error: 'No place matched "Atlantis Plaza"' }, summaryResult: 'Failed' }; }
        });
        const out = await failing.run({ request: 'a bronze statue', location: 'Atlantis Plaza' });
        expect(out.status).toBe('failed');
        expect(out.resultPayload.stage).toBe('staging');
        expect(String(out.resultPayload.error)).toContain('No place matched "Atlantis Plaza"');
        expect(stageArgs).toEqual([{ query: 'Atlantis Plaza' }]);
        expect(client.calls).toHaveLength(0);

        const unremeshed = await handlerWith(client, {
            stageAtLocation: async () => ({ status: 'completed', resultPayload: { success: true, remesh: { ok: false, error: 'tile_refine crashed' }, artifact: { type: '3d-scene', data: { objects: [] } } } })
        }).run({ request: 'a bronze statue', location: 'Union Square, San Francisco' });
        expect(unremeshed.status).toBe('failed');
        expect(String(unremeshed.resultPayload.error)).toContain('not remeshed (tile_refine crashed)');
    });

    it('with a location, puts the built object into the staged clay tile scene', async () => {
        const client = fakeClient({ specs: [JSON.stringify(VASE)] });
        const tile = { id: 'tile-clay-1', content: { type: '3d-model', durableUri: '/models/tile.glb', metadata: { role: 'environment', isGround: true } } };
        const out = await handlerWith(client, {
            stageAtLocation: async () => ({
                status: 'completed',
                resultPayload: {
                    success: true, resolvedAddress: 'Union Square, San Francisco, CA', geoAnchor: { lat: 37.788, lng: -122.4075 },
                    remesh: { ok: true }, artifact: { id: 'a', type: '3d-scene', title: 'Union Square', data: { renderMode: 'clay', environment: { skybox: 'studio', lighting: 'studio', ground: false }, objects: [tile], geoAnchor: { lat: 37.788, lng: -122.4075 } } }
                }
            })
        }).run({ request: 'a fluted vase', location: 'Union Square, San Francisco' });
        expect(out.status, String(out.resultPayload.error)).toBe('completed');
        const artifact = out.resultPayload.artifact as any;
        expect(artifact.title).toContain('Union Square, San Francisco, CA');
        expect(artifact.data.objects.map((o: any) => o.content.metadata.role)).toEqual(['environment', 'hero']);
        expect(artifact.data.geoAnchor).toEqual({ lat: 37.788, lng: -122.4075 });
        expect(artifact.data.objectBuild.spec.subject).toBe(VASE.subject);
        expect(out.summaryResult).toContain('Staged at Union Square, San Francisco, CA');
    }, 180_000);
});
