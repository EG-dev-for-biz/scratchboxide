/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * google_3d_tiles_get_clay hands off to the staged build when it remeshes: the arguments (and a retry's), the
 * declaration the model reads, the result the model reads (every degradation reaches it, in front of the large scene),
 * the real dependencies' wiring (Street View through the grounding API only, the vision model chain, the scan fitter
 * when this build has it), and the context line a later turn gets.
 */

import { describe, it, expect, afterAll, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
    createStagedLocationDeps, parseStagedLocationArgs, runStagedLocationTool,
    STAGED_CLAY_TOOL_DESCRIPTION, STAGED_RETRY_STAGE_DESCRIPTION
} from '../src/node/3d-engine/staged-location/staged-location-tool';
import { STAGE_IDS, type ScanFitDeps, type StagedLocationDeps } from '../src/node/3d-engine/staged-location/orchestrator';
import { StageCache } from '../src/node/3d-engine/staged-location/stage-cache';
import { MissingInputError } from '../src/common/errors/pipeline-errors';
import { GOOGLE_3D_TILES_TOOL_DECLARATIONS as spatialToolDeclarations } from '../src/node/gemini/tools/spatial-tools';
import { toolResultForModel } from '../src/node/gemini/streaming';
import { buildContents } from '../src/node/gemini/prompt-builder';
import { GeminiClient } from '../src/node/gemini/gemini-client';
import { StreetViewGroundingImageService } from '../src/node/spatial/StreetViewGroundingImageService';
import type { ToolContext } from '../src/node/gemini/tools/types';
import type { StageEvent } from '../src/common/spatial/staged-location-contracts';
import type { CanvasArtifact } from '../src/browser/generative-canvas/canvas-types';
import { budgetError, fakeNative, writeTris, groundGrid, type WorldSpec } from './helpers/staged-synthetic-world';

const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sbx-staged-tool-')));
afterAll(() => fs.rmSync(TMP, { recursive: true, force: true }));
afterEach(() => vi.restoreAllMocks());

const PARK: WorldSpec = { ground: 80, buildings: [[30, 44, 30, 40, 9]], trees: [{ x: -12, z: -10, r: 4, h: 7, id: 3 }, { x: 10, z: 14, r: 3.5, h: 6, id: 7 }, { x: -16, z: 16, r: 5, h: 9, id: 9 }] };

let counter = 0;
function setup(opts: Parameters<typeof fakeNative>[2] = {}, extra: Partial<StagedLocationDeps> = {}) {
    const root = path.join(TMP, `ws${++counter}`);
    fs.mkdirSync(root, { recursive: true });
    const native = fakeNative(path.join(root, 'native'), PARK, opts);
    let runs = 0;
    const deps: StagedLocationDeps = {
        cache: new StageCache({ workspaceRoot: root }),
        geocode: async q => ({ lat: 40.78256, lng: -73.96558, formattedAddress: `${q}, New York, NY` }),
        extract: native.deps.extract, vegetation: native.deps.vegetation, refine: native.deps.refine,
        newRunId: () => (0xc0ffee00 + ++runs).toString(16), sleep: async () => undefined,
        ...extra
    };
    const events: Array<{ e: StageEvent; artifact?: CanvasArtifact }> = [];
    const ctx = { emitStage: (e: StageEvent, artifact?: CanvasArtifact) => events.push({ e, artifact }), reportProgress: () => undefined, request: {} } as unknown as ToolContext;
    return { root, deps, events, ctx, native };
}

const clayArgs = { query: 'Central Park', radiusMeters: 60 };

describe('parseStagedLocationArgs', () => {
    it('reads a place request: isolate, radius, trees (on by default), budget, staging', () => {
        expect(parseStagedLocationArgs('google_3d_tiles_get_clay', { query: ' Washington Square Arch ', isolate: true, radiusMeters: 90, treeTriangleBudget: 50_000, stageIntoActiveScene: true }).request)
            .toEqual({ query: 'Washington Square Arch', isolate: true, radiusM: 90, trees: true, treeTriangleBudget: 50_000, stageIntoActiveScene: true, procedural: true });
        expect(parseStagedLocationArgs('google_3d_tiles_get_clay', { query: 'q', trees: false }).request).toMatchObject({ trees: false, isolate: false });
        // one building is pipeline G's unless procedural false asks for the scan detailed; a district is never procedural
        expect(parseStagedLocationArgs('google_3d_tiles_get_clay', { query: 'q', isolate: true, procedural: false }).request).not.toHaveProperty('procedural');
        expect(parseStagedLocationArgs('google_3d_tiles_get_clay', { query: 'q', procedural: true }).request).not.toHaveProperty('procedural');
    });

    it('needs a query, a sound tree budget, and for a retry a run id of 8 hex digits and a known stage; a retry needs no query', () => {
        expect(() => parseStagedLocationArgs('t', {})).toThrow(MissingInputError);
        expect(() => parseStagedLocationArgs('t', { query: 'q', treeTriangleBudget: 0 })).toThrow(/treeTriangleBudget of at least 1 triangle/);
        expect(() => parseStagedLocationArgs('t', { retryRunId: 'xyz', retryStage: 'vision' })).toThrow(/retryRunId of 8 hex digits/);
        expect(() => parseStagedLocationArgs('t', { retryRunId: 'a1b2c3d4', retryStage: 'dessert' })).toThrow(/retryStage of resolve, vector, tiles/);
        expect(() => parseStagedLocationArgs('t', { retryRunId: 'a1b2c3d4' })).toThrow(/retryStage/);
        // resume: the run alone, no stage; never together with a retry
        expect(parseStagedLocationArgs('t', { resumeRunId: 'a1b2c3d4' }).resume).toEqual({ runId: 'a1b2c3d4' });
        expect(() => parseStagedLocationArgs('t', { resumeRunId: 'zz' })).toThrow(/resumeRunId of 8 hex digits/);
        expect(() => parseStagedLocationArgs('t', { resumeRunId: 'a1b2c3d4', retryRunId: 'a1b2c3d4', retryStage: 'vision' })).toThrow(/either resumeRunId or retryRunId/);
        const retry = parseStagedLocationArgs('t', { retryRunId: 'a1b2c3d4', retryStage: 'vision' });
        expect(retry.retry).toEqual({ runId: 'a1b2c3d4', stage: 'vision' });
        expect(retry.request.query).toBe('');
    });
});

describe('the declaration the model reads', () => {
    const decl = spatialToolDeclarations.find(d => d.name === 'google_3d_tiles_get_clay')!;
    const props = (decl.parameters as any).properties;

    it('says what degrades to what, that nothing is invented, and that photo-inferred detail is an inference', () => {
        expect(decl.description).toBe(STAGED_CLAY_TOOL_DESCRIPTION);
        for (const rung of ['photo-read detail becomes the flat fitted face', 'a failed rebuild becomes the remeshed scan', 'a failed remesh becomes the raw scan with its facades flattened',
            'a tree that cannot regrow stays as scanned', 'a failed tree stage puts the scanned trees back, labelled as scanned']) {
            expect(decl.description).toContain(rung);
        }
        expect(decl.description).toMatch(/Nothing is invented/);
        expect(decl.description).toMatch(/photo-inferred is read from photographs: an inference with a confidence, not a measurement/);
        expect(decl.description).toMatch(/Only an unresolved place, or a place with no tile coverage, fails the call/);
    });

    it('lists every stage a retry can name, and says the radius is ignored for an isolated structure', () => {
        expect(props.retryStage.description).toBe(STAGED_RETRY_STAGE_DESCRIPTION);
        for (const id of STAGE_IDS) expect(props.retryStage.description).toContain(id);
        expect(props.retryRunId.type).toBe('STRING');
        expect(props.radiusMeters.description).toMatch(/Ignored with isolate/);
        expect(props.isolate.description).toMatch(/Street View images \(up to 4 per building, Google captures only\)/);
        expect(props.isolate.description).toMatch(/labelled photo-inferred/);
    });

    it('no longer says a failed remesh fails the call, or that a failed tree stage shows nothing', () => {
        expect(props.remesh.description).not.toMatch(/nothing else is shown instead/);
        expect(props.remesh.description).toMatch(/scan-flattened/);
        expect(props.trees.description).toMatch(/scanned trees are put back, labelled as scanned/);
    });
});

describe('runStagedLocationTool: what the model reads', () => {
    it('leads with the digest and the summary, ahead of the structured result and the scene, and every degradation is in them', async () => {
        const flatDir = path.join(TMP, 'flat');
        fs.mkdirSync(flatDir, { recursive: true });
        const flatten: ScanFitDeps['flatten'] = async () => {
            const glb = writeTris(path.join(flatDir, 'flattened.glb'), [...groundGrid(30)]);
            return { value: { schema: 'scratchbox.flatten-stats/1', inputTriangles: 900, keptTriangles: 900, planes: 4, movedVertices: 120, maxMoveM: 0.09, p95MoveM: 0.04, bandM: 0.1, timingsMs: {} }, glb, path: glb, dir: flatDir, key: 'flat0001', binarySha256: 'b'.repeat(64), cached: false, builtAtMs: Date.now(), ms: 5, waitedForEngineMs: 0 };
        };
        const s = setup({ refineFails: new Error('tile_refine timed out') }, { scanFit: { flatten, fit: null as any, refit: null as any, ornament: null as any } });
        const out = await runStagedLocationTool('google_3d_tiles_get_clay', clayArgs, s.ctx, s.deps);
        const payload = out.resultPayload as any;
        expect(Object.keys(payload).slice(0, 4)).toEqual(['success', 'status', 'digest', 'summary']);
        expect(Object.keys(payload).pop()).toBe('artifact');
        expect(payload.status).toBe('degraded');
        expect(out.summaryResult).toBe(payload.digest);
        expect(payload.digest.length).toBeLessThanOrEqual(200);
        expect(payload.digest).toMatch(/^Staged build degraded: /);
        expect(payload.digest).toMatch(/retry retryRunId [0-9a-f]{8}/);
        // every degradation is in the structured result, and the summary names each degraded part
        expect(payload.degradations.length).toBeGreaterThan(0);
        for (const d of payload.degradations) {
            expect(JSON.stringify(payload.degradations)).toContain(d.reason);
            expect(payload.summary.toLowerCase()).toContain(d.fellTo.toLowerCase().slice(0, 30));
        }
        expect(payload.summary).toContain('tile_refine timed out');
        // what the model is actually sent: the digest, the summary and the degradations survive the cap, in front of the scene
        const modelSees = toolResultForModel('google_3d_tiles_get_clay', { status: 'completed' }, out.resultPayload);
        const text = JSON.stringify(modelSees);
        expect(text.indexOf('"digest"')).toBeLessThan(text.indexOf('"artifact"'));
        expect(text.indexOf('"summary"')).toBeLessThan(text.indexOf('"degradations"'));
        expect(text.indexOf('"degradations"')).toBeLessThan(text.indexOf('"artifact"'));
        // the mounted scene is the final one, with the camera and the staged build state
        expect(payload.artifact.id).toMatch(/^scene-stg-[0-9a-f]{8}$/);
        expect(payload.artifact.data.stagedBuild.runState).toBe('finished');
        // the compatibility fields the object builder and other tools read
        expect(payload.mode).toBe('clay');
        // the remesh did not succeed, and says so: the scan is shown flattened instead
        expect(payload.remesh).toMatchObject({ ok: false, error: expect.stringContaining('tile_refine timed out') });
        expect(payload.resolvedAddress).toBe('Central Park, New York, NY');
        expect(fs.existsSync(payload.glbPath)).toBe(true);
    });

    it('a failed tree stage reaches the model: scanned trees put back, labelled as scanned, with the reason', async () => {
        const s = setup({ plantFails: budgetError() });
        const out = await runStagedLocationTool('google_3d_tiles_get_clay', clayArgs, s.ctx, s.deps);
        const payload = out.resultPayload as any;
        const rec = payload.degradations.find((d: any) => d.stage === 'trees');
        expect(rec).toMatchObject({ fellTo: 'the scanned trees put back', provenanceAfter: 'as-scanned' });
        expect(payload.remesh).toMatchObject({ ok: true });
        expect(payload.summary).toContain('The tree stage failed (');
        expect(payload.summary).toContain('so the scanned trees were put back, labelled as scanned');
        expect(payload.summary).not.toMatch(/no trees|without trees/i);
        expect(JSON.stringify(toolResultForModel('google_3d_tiles_get_clay', { status: 'completed' }, out.resultPayload))).toContain(rec.reason.slice(0, 60));
    });

    it('a hard failure (no tile coverage) fails the call with the reason and nothing mounted', async () => {
        const s = setup();
        const deps = { ...s.deps, extract: async () => { throw new Error('no Photorealistic 3D Tiles coverage at 0, 0'); } };
        await expect(runStagedLocationTool('google_3d_tiles_get_clay', clayArgs, s.ctx, deps)).rejects.toThrow(/No Photorealistic 3D Tiles could be extracted at Central Park, New York, NY: no Photorealistic 3D Tiles coverage/);
        expect(s.events.some(x => x.artifact)).toBe(false);
    });

    it('a retry rebuilds the recorded request, recomputes only the named stage, and needs no query', async () => {
        const s = setup({ plantFails: budgetError() });
        const first = await runStagedLocationTool('google_3d_tiles_get_clay', clayArgs, s.ctx, s.deps);
        const runId = (first.resultPayload as any).artifact.data.stagedBuild.runId as string;
        s.native.extractCalls.length = 0;
        const retried = await runStagedLocationTool('google_3d_tiles_get_clay', { retryRunId: runId, retryStage: 'trees' }, s.ctx, s.deps);
        expect(s.native.extractCalls).toEqual([]); // the extraction came from cache
        expect((retried.resultPayload as any).place.query).toBe('Central Park');
        expect((retried.resultPayload as any).stages.find((x: any) => x.stage === 'tiles').timings.cached).toBe(true);
    });

    it('writes the caller\'s own copy of the raw extraction where it asked (an absolute path as given)', async () => {
        const s = setup();
        const target = path.join(TMP, 'copies', 'raw_copy.glb');
        const out = await runStagedLocationTool('google_3d_tiles_get_clay', { ...clayArgs, trees: false, outputGlbPath: target }, s.ctx, s.deps);
        expect(fs.readFileSync(target)).toEqual(fs.readFileSync((out.resultPayload as any).glbPath));
    });
});

describe('createStagedLocationDeps: the real dependencies', () => {
    it('with no credentials, says which is missing instead of reaching for anything else', async () => {
        const root = path.join(TMP, 'nocreds');
        fs.mkdirSync(root, { recursive: true });
        vi.spyOn(GeminiClient.prototype, 'ensureAuth').mockReturnValue(false);
        vi.spyOn(GeminiClient.prototype, 'getGenAIClient').mockResolvedValue(undefined);
        const deps = await createStagedLocationDeps(root);
        expect(deps.vision).toEqual({ unavailable: expect.stringMatching(/no Gemini credentials/) });
        expect(deps.streetView!.grounding).toBeUndefined();
        expect(deps.streetView!.groundingUnavailable).toMatch(/no Google Cloud service account is configured for the Maps Imagery Grounding API/);
        // the scan fitter is part of this build and needs no credentials
        expect(deps.scanFit).toBeDefined();
        expect(deps.scanFitUnavailable).toBeUndefined();
    });

    it('wires Street View to StreetViewGroundingImageService only, and the vision chain to the staged default model first', async () => {
        const root = path.join(TMP, 'creds');
        fs.mkdirSync(root, { recursive: true });
        vi.spyOn(GeminiClient.prototype, 'ensureAuth').mockReturnValue(true);
        const client = { models: { generateContent: async () => ({}) } };
        vi.spyOn(GeminiClient.prototype, 'getGenAIClient').mockResolvedValue(client as never);
        vi.spyOn(GeminiClient.prototype, 'getModelCandidates').mockReturnValue(['gemini-3.8-flash', 'gemini-2.5-pro']);
        const deps = await createStagedLocationDeps(root);
        expect(deps.streetView!.grounding).toBeInstanceOf(StreetViewGroundingImageService);
        expect(deps.vision).toEqual({ client, candidates: ['gemini-4-argon', 'gemini-3.8-flash', 'gemini-2.5-pro'] });
        // the model chain never names the staged default twice when chat already prefers it
        vi.spyOn(GeminiClient.prototype, 'getModelCandidates').mockReturnValue(['gemini-4-argon', 'gemini-3.8-flash']);
        expect(((await createStagedLocationDeps(root)).vision as any).candidates).toEqual(['gemini-4-argon', 'gemini-3.8-flash']);
    });

    it('no code in the staged build asks the Street View Static API for an image', () => {
        const dir = path.join(__dirname, '../src/node/3d-engine/staged-location');
        for (const file of fs.readdirSync(dir).filter(f => f.endsWith('.ts'))) {
            const text = fs.readFileSync(path.join(dir, file), 'utf8');
            expect(text, file).not.toMatch(/maps\.googleapis\.com\/maps\/api\/streetview(?!\/metadata)/);
        }
    });
});

describe('the context line on a later turn', () => {
    it('adds the staged build to the prompt ahead of the capped scene summary, and nothing for a scene without one', async () => {
        const s = setup({ plantFails: budgetError() });
        const out = await runStagedLocationTool('google_3d_tiles_get_clay', clayArgs, s.ctx, s.deps);
        const artifact = (out.resultPayload as any).artifact as CanvasArtifact;
        const withStaged = buildContents({ prompt: 'make the trees bigger', activeArtifact: artifact } as never);
        const text = (withStaged[withStaged.length - 1].parts![0] as { text: string }).text;
        expect(text).toMatch(/\[Staged location build: \{"runState":"finished"/);
        expect(text.indexOf('[Staged location build:')).toBeLessThan(text.indexOf('[Active 3D Scene In-Memory State'));
        expect(text).toMatch(/"degradations":\[\{"stage":"trees","reasonCode":"trees_failed"/);
        const plain = { ...artifact, data: { ...(artifact.data as object), stagedBuild: undefined } } as CanvasArtifact;
        const without = buildContents({ prompt: 'x', activeArtifact: plain } as never);
        expect((without[without.length - 1].parts![0] as { text: string }).text).not.toContain('[Staged location build:');
    });
});

