/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The staged location build's stage graph with injected stages over synthetic worlds: what commits and in what order,
 * the artifact every commit carries (one id, one camera), every rung of the degrade ladder (each a simpler version of
 * the same data, never a fabrication), the failed tree stage putting the scanned trees back, the rebuild chain with
 * vision at LOW thinking, Stop, the run deadline, retry by retryRunId, the negative cache and the hard failures.
 * No network, no billed call: geocoding, extraction, native stages, scan_fit and the vision client are stand-ins.
 */

import { describe, it, expect, afterAll } from 'vitest';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { runStagedLocation, StagedLocationHardFailure, type ScanFitDeps, type StagedLocationDeps } from '../src/node/3d-engine/staged-location/orchestrator';
import { StageCache } from '../src/node/3d-engine/staged-location/stage-cache';
import { writeStagedGlbFile } from '../src/node/3d-engine/staged-location/staged-glb-writer';
import { validateContract, type StageEvent, type StructureFit } from '../src/common/spatial/staged-location-contracts';
import type { CanvasArtifact } from '../src/browser/generative-canvas/canvas-types';
import type { VisionGenAIClient } from '../src/node/gemini/vision-model-chain';
import { budgetError, fakeNative, writeTris, building, groundGrid, type WorldSpec } from './helpers/staged-synthetic-world';
import { structureFit } from './helpers/staged-location-fixtures';
import { readGlbTriangles, renderClayPng } from './helpers/clay-glb-render';
import { STAGED_SCREENSHOT_DIR } from './helpers/staged-real-data';
import { scanToGeodetic } from '../src/node/spatial/StreetViewSurveyPlanner';
import { spyOnFsWrites } from './helpers/fs-write-spy';

const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sbx-staged-orch-')));
afterAll(() => fs.rmSync(TMP, { recursive: true, force: true }));

/** A park district: ground, one low building far from the anchor, three trees. */
const PARK: WorldSpec = { ground: 80, buildings: [[30, 44, 30, 40, 9]], trees: [{ x: -12, z: -10, r: 4, h: 7, id: 3 }, { x: 10, z: 14, r: 3.5, h: 6, id: 7 }, { x: -16, z: 16, r: 5, h: 9, id: 9 }] };
/** An isolated structure at the anchor, a tree beside it. */
const ARCH: WorldSpec = { ground: 80, buildings: [[-13, 13, -6, 5, 22]], trees: [{ x: 22, z: 0, r: 4, h: 7, id: 1 }] };

let counter = 0;
function setup(spec: WorldSpec, opts: Parameters<typeof fakeNative>[2] = {}, extra: Partial<StagedLocationDeps> = {}) {
    const root = path.join(TMP, `ws${++counter}`);
    fs.mkdirSync(root, { recursive: true });
    const native = fakeNative(path.join(root, 'native'), spec, opts);
    const cache = new StageCache({ workspaceRoot: root });
    let geocodes = 0;
    let runs = 0;
    const deps: StagedLocationDeps = {
        cache,
        geocode: async q => { geocodes++; return { lat: 40.73122, lng: -73.99709, formattedAddress: `${q}, New York, NY`, placeId: 'p' }; },
        extract: native.deps.extract,
        vegetation: native.deps.vegetation,
        refine: native.deps.refine,
        newRunId: () => (0xa1b2c300 + ++runs).toString(16),
        sleep: async () => undefined,
        ...extra
    };
    const events: Array<{ e: StageEvent; artifact?: CanvasArtifact }> = [];
    const ctx = { emitStage: (e: StageEvent, artifact?: CanvasArtifact) => events.push({ e, artifact }) };
    return { root, native, cache, deps, events, ctx, geocodes: () => geocodes };
}

const statusOf = (events: Array<{ e: StageEvent }>, stage: string) => events.filter(x => x.e.stage === stage).map(x => x.e.status);

describe('a district', () => {
    it('commits tiles, remesh and trees in order, each commit carrying the scene with one id and one camera', async () => {
        const s = setup(PARK);
        const { result, compat } = await runStagedLocation({ query: 'Central Park', isolate: false, radiusM: 60, trees: true }, s.deps, s.ctx);
        expect(validateContract('StagedLocationResult', result)).toEqual([]);
        expect(result.status).toBe('complete');
        // the stage order a user watches
        const committed = s.events.filter(x => x.e.status === 'committed' && x.e.stage !== 'finish').map(x => x.e.stage);
        expect(committed).toEqual(['resolve', 'tiles', 'trees-measure', 'remesh', 'trees']);
        expect(statusOf(s.events, 'fit')).toEqual(['skipped']);
        expect(s.events.find(x => x.e.stage === 'fit')!.e).toMatchObject({ status: 'skipped' });
        expect(result.stages.find(x => x.stage === 'fit')!.reason).toBe('not an isolated structure');
        // every artifact is the same scene, with the same camera; running events carry none
        const arts = s.events.filter(x => x.artifact).map(x => x.artifact as any);
        expect(new Set(arts.map(a => a.id))).toEqual(new Set(['scene-stg-a1b2c301']));
        expect(new Set(arts.map(a => JSON.stringify(a.data.camera))).size).toBe(1);
        expect(s.events.filter(x => x.e.status === 'running').every(x => !x.artifact)).toBe(true);
        expect(arts.map(a => a.data.objects.length)).toEqual([1, 2, 3, 3]);
        for (const a of arts) expect(validateContract('StagedBuildState', a.data.stagedBuild)).toEqual([]);
        // seq strictly increases
        const seqs = s.events.map(x => x.e.seq);
        expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
        // layers: L1 as scanned; L2 remeshed supersedes it, with tile_refine's per-vertex provenance; L5 waits for L2
        const final = arts[arts.length - 1].data.stagedBuild;
        const [l1, l2, l5] = final.layers;
        expect([l1.layer, l2.layer, l5.layer]).toEqual(['l1', 'l2', 'l5']);
        expect(l1.provenance.label).toBe('as-scanned');
        expect(l2).toMatchObject({ supersedes: [l1.objectId], reveal: { crossfadeFrom: [l1.objectId] }, provenance: { label: 'remeshed' } });
        expect(l2.vertexProvenance.attributes).toEqual(['_RECTIFY_DISPLACEMENT', '_PROUD_BLOCK']);
        expect(l5).toMatchObject({ provenance: { label: 'grown to the measured crown' }, revealAfter: [l2.objectId] });
        expect(l1.reveal.orderUrl).toMatch(/\.order\.json$/);
        // the ground the object builder stands things on is the remesh
        const ground = arts[arts.length - 1].data.objects.filter((o: any) => o.content.metadata.isGround);
        expect(ground.map((o: any) => o.id)).toEqual([l2.objectId]);
        // published, sha-checked files under public/models
        for (const l of final.layers) expect(fs.existsSync(path.join(s.root, 'public', 'models', path.basename(l.url)))).toBe(true);
        expect(compat.remesh.ok).toBe(true);
        expect(result.trees).toMatchObject({ measured: 3, count: 3 });
        expect(result.summary).toContain('Trees, grown to the measured crown: 3 of 3 trees rebuilt as SB-Veggie; 0 left as scanned.');
        expect(result.digest.length).toBeLessThanOrEqual(200);
        expect(result.complexityGate.exemptions[0]).toMatch(/^vertex floor: scan-derived layer/);
        // strip ran on the extraction, the remesh on what strip left, plant against the mounted remesh
        expect(String(s.native.refineCalls[0].tilePath)).toMatch(/devegetated\.glb$/);
        expect(s.native.refineCalls[0].relief).toBeUndefined(); // relief stays on (tile_refine's default)
        expect(String(s.native.plantCalls[0].groundMeshPath)).toMatch(/clay\.glb$/);
    });

    it('a repeat serves every stage from cache, keeps the object ids, and says so', async () => {
        const s = setup(PARK);
        const first = await runStagedLocation({ query: 'Central Park', isolate: false, radiusM: 60, trees: true }, s.deps, s.ctx);
        const ids = (first.result.artifact as any).data.objects.map((o: any) => o.id);
        s.events.length = 0;
        const second = await runStagedLocation({ query: 'Central Park', isolate: false, radiusM: 60, trees: true }, s.deps, s.ctx);
        expect(s.native.extractCalls).toEqual([60]);
        expect(s.geocodes()).toBe(1);
        expect((second.result.artifact as any).data.objects.map((o: any) => o.id)).toEqual(ids);
        expect(second.result.cache).toMatchObject({ resolve: 'hit', tiles: 'hit' });
        expect(second.result.stages.find(x => x.stage === 'tiles')!.timings.cached).toBe(true);
        expect(second.result.summary).toMatch(/from cache \(built \d{4}-\d{2}-\d{2}\)/);
    });
});

describe('the degrade ladder', () => {
    it('strip fails: the raw tile is remeshed with its own trees, and nothing is planted', async () => {
        const s = setup(PARK, { stripFails: Object.assign(new Error('photo texture 3 could not be decoded'), { code: 'texture_decode' }) });
        const { result } = await runStagedLocation({ query: 'Central Park', isolate: false, radiusM: 60, trees: true }, s.deps, s.ctx);
        expect(result.status).toBe('degraded');
        expect(String(s.native.refineCalls[0].tilePath)).toMatch(/textured\.glb$/);
        expect(s.native.plantCalls).toEqual([]);
        expect(result.degradations.map(d => [d.stage, d.reasonCode, d.fellTo])).toEqual([['trees-measure', 'trees_not_measured', "the scan's own trees, left in the remeshed scan"]]);
        expect(result.stages.find(x => x.stage === 'trees')!.status).toBe('skipped');
    });

    it('the remesh fails without the flattener: the raw scan as downloaded stays the ground, its trees in it', async () => {
        const s = setup(PARK, { refineFails: new Error('tile_refine exited with code 134') });
        const { result, compat } = await runStagedLocation({ query: 'Central Park', isolate: false, radiusM: 60, trees: true }, s.deps, s.ctx);
        const remesh = result.degradations.find(d => d.stage === 'remesh')!;
        expect(remesh).toMatchObject({ reasonCode: 'remesh_failed', provenanceAfter: 'as-scanned', transient: true, retry: { args: { retryStage: 'remesh' } } });
        expect(remesh.fellTo).toBe('the raw scan as downloaded (facade flattening, scan_fit, is not in this build)');
        expect(result.degradations.find(d => d.stage === 'trees')).toMatchObject({ reasonCode: 'trees_stay_scanned', fellTo: 'the trees as scanned, inside the raw scan' });
        expect(s.native.plantCalls).toEqual([]); // never a tree over scanned canopy
        const objects = (result.artifact as any).data.objects;
        expect(objects).toHaveLength(1);
        expect(objects[0].content.metadata).toMatchObject({ isGround: true, stagedLayer: 'l1', provenance: 'as-scanned' });
        expect(compat.remesh).toEqual({ ok: false, error: remesh.reason });
        expect(result.digest).toBe('Staged build degraded: resolve, tiles, trees-measure committed; remesh: remesh_failed; trees: trees_stay_scanned; retry retryRunId a1b2c301 stage remesh.');
    });

    it('the remesh fails with the flattener: the raw scan with its facades flattened, labelled scan-flattened', async () => {
        const flatDir = path.join(TMP, 'flat');
        fs.mkdirSync(flatDir, { recursive: true });
        const flatten: ScanFitDeps['flatten'] = async req => {
            const glb = writeTris(path.join(flatDir, 'flattened.glb'), [...groundGrid(30)]);
            return { value: { schema: 'scratchbox.flatten-stats/1', inputTriangles: 900, keptTriangles: 900, planes: 4, movedVertices: 120, maxMoveM: 0.09, p95MoveM: 0.04, bandM: 0.1, timingsMs: {} }, glb, path: glb, dir: flatDir, key: 'f'.repeat(64), binarySha256: 'b', cached: false, builtAtMs: Date.now(), ms: 5, waitedForEngineMs: 0, ...(req ? {} : {}) };
        };
        const s = setup(PARK, { refineFails: new Error('tile_refine timed out') }, { scanFit: { flatten, fit: null as any, refit: null as any, ornament: null as any } });
        const { result } = await runStagedLocation({ query: 'Central Park', isolate: false, radiusM: 60, trees: true }, s.deps, s.ctx);
        const l2 = (result.artifact as any).data.stagedBuild.layers.find((l: any) => l.layer === 'l2');
        expect(l2.provenance).toMatchObject({ label: 'scan-flattened', note: '120 vertices moved onto 4 planes (max 0.09 m, p95 0.04 m)' });
        expect(result.degradations.find(d => d.stage === 'remesh')).toMatchObject({ fellTo: 'the raw scan with its facades flattened, its scanned trees kept in it', provenanceAfter: 'scan-flattened' });
        expect((result.artifact as any).data.objects.find((o: any) => o.content.metadata.isGround).id).toBe(l2.objectId);
    });

    it('the tree stage fails: the scanned trees are put back, labelled as scanned', async () => {
        const s = setup(PARK, { plantFails: budgetError() });
        const { result } = await runStagedLocation({ query: 'Central Park', isolate: false, radiusM: 60, trees: true }, s.deps, s.ctx);
        const rec = result.degradations.find(d => d.stage === 'trees')!;
        expect(rec).toMatchObject({ reasonCode: 'trees_failed', fellTo: 'the scanned trees put back', provenanceAfter: 'as-scanned', transient: false });
        expect(rec.reason).toContain('a triangle budget of 10 cannot hold 3 trees');
        expect(rec.reason).toContain('Ask again with a smaller radiusMeters');
        const l5x = (result.artifact as any).data.stagedBuild.layers.find((l: any) => l.layer === 'l5x');
        expect(l5x.provenance).toMatchObject({ label: 'as-scanned', measuredGeometry: true });
        expect(l5x.revealAfter).toEqual([(result.artifact as any).data.stagedBuild.layers.find((l: any) => l.layer === 'l2').objectId]);
        // the put-back layer holds the crowns strip removed, unchanged, one node per crown
        const g = readGlbTriangles(fs.readFileSync(path.join(s.root, 'public', 'models', path.basename(l5x.url))));
        expect(g.nodeRanges.map(n => n.extras.sb.ids.crownId)).toEqual([3, 7, 9]);
        expect(g.nodeRanges.every(n => n.extras.sb.provenance.label === 'as-scanned')).toBe(true);
        expect(result.summary).toContain('The tree stage failed (');
        expect(result.summary).toContain('so the scanned trees were put back, labelled as scanned');
        // screenshot: the remesh with the scanned trees put back
        const remesh = readGlbTriangles(fs.readFileSync(path.join(s.root, 'public', 'models', path.basename((result.artifact as any).data.stagedBuild.layers.find((l: any) => l.layer === 'l2').url))));
        fs.mkdirSync(STAGED_SCREENSHOT_DIR, { recursive: true });
        fs.writeFileSync(path.join(STAGED_SCREENSHOT_DIR, 'orchestrator_trees_put_back.png'), renderClayPng([
            { positions: remesh.positions, indices: remesh.indices },
            { positions: g.positions, indices: g.indices, color: [0.9, 0.62, 0.0] }
        ], { kind: 'aerial', width: 900, height: 600, region: [-30, -30, 30, 30], bearingDeg: 200, elevationDeg: 35 }));
    });
});

/** scan_fit stand-in: the fixture StructureFit, with its GLBs and ortho written. */
function fakeScanFit(dir: string, opts: { fitFails?: Error & { code?: string }; rejected?: boolean } = {}) {
    fs.mkdirSync(dir, { recursive: true });
    const calls = { fit: 0, refit: 0, ornament: 0 };
    const writeFit = (name: string, mutate?: (f: StructureFit) => void) => {
        const f = structureFit();
        f.outputs.fittedGlb = writeTris(path.join(dir, `${name}_fitted.glb`), building(-13, 13, -5.5, 5.5, 24));
        f.outputs.outlinesGlb = writeTris(path.join(dir, `${name}_outlines.glb`), building(-13, 13, -5.5, 5.5, 0.1));
        f.outputs.passThroughGlb = writeTris(path.join(dir, `${name}_pass.glb`), building(-11, -9, -7.4, -5.5, 6));
        const png = path.join(dir, `${name}_s00.png`);
        fs.writeFileSync(png, Buffer.from('89504e470d0a1a0a0000000d494844520000020e000001e808060000001ff3ff61', 'hex'));
        f.outputs.orthos = [{ ...f.outputs.orthos[0], path: png }];
        // the body can be photo-corrected in its height (param 0), inside what the scan allows
        f.primitives[0].correctable = [{ param: 0, key: 'height', value: 24.4, min: 24.0, max: 25.0, unit: 'm', description: 'body height', toleranceM: 0.31, residualCurve: [[24, 0.05], [24.4, 0.028], [25, 0.2]] }];
        if (opts.rejected) { f.accepted = false; f.gates[1] = { ...f.gates[1], value: 0.071, passed: false }; }
        mutate?.(f);
        f.outputs.reportJson = path.join(dir, `${name}_structure_fit.json`);
        fs.writeFileSync(f.outputs.reportJson, JSON.stringify(f));
        return f;
    };
    const out = (value: any, file: string, key: string) => ({ value, path: file, dir, key: key.padEnd(64, '0'), binarySha256: 'b', cached: false, builtAtMs: Date.now(), ms: 30, waitedForEngineMs: 0 });
    const deps: ScanFitDeps = {
        fit: async () => {
            calls.fit++;
            if (opts.fitFails) throw opts.fitFails;
            const f = writeFit('fit');
            return out(f, f.outputs.reportJson, '7c1e04aa');
        },
        refit: async req => {
            calls.refit++;
            const f = writeFit('refit', g => {
                const p = g.primitives[0];
                g.input.refitOf = 'fit';
                p.provenance = { label: 'photo-corrected', measuredGeometry: false, confidence: 0.8, method: 'scan_fit refit', sources: [] };
                p.correction = {
                    primitiveId: 'p00', param: 0, key: 'height', from: 24.4, to: req.set[0].value, confidence: 0.8, reason: 'photo',
                    evidence: [], check: { residualBefore: g.primitives[0].fit, residualAfter: { ...g.primitives[0].fit, rmsM: 0.05 }, toleranceM: 0.31, accepted: true, why: '5.0 cm rms is within 0.31 m' }
                };
            });
            return out(f, f.outputs.reportJson, '8d2f15bb');
        },
        ornament: async req => {
            calls.ornament++;
            const glb = writeTris(path.join(dir, 'detail.glb'), building(2, 3, -6, -5.5, 1));
            return {
                ...out({ schema: 'scratchbox.ornament-build/1', structureFitSha256: req.spec.structureFitSha256, ornamentSpecSha256: 'c'.repeat(64), built: req.spec.elements.map((e, i) => ({ elementId: e.id, slotId: e.slotId, node: i, vertices: 36, triangles: 12 })), dropped: [], degradedSlots: [], counts: { vertices: 36, triangles: 12 }, timingsMs: {} }, path.join(dir, 'build_report.json'), '9e3a26cc'),
                detailGlb: glb
            };
        },
        flatten: async () => { throw new Error('not used'); }
    };
    return { deps, calls };
}

/** A vision client answering with one roundel on the north spandrel and a correction of the body's height. */
function visionClient(reply: object | Error, record: any[] = []): VisionGenAIClient {
    return {
        models: {
            generateContent: async () => { throw new Error('streaming expected'); },
            generateContentStream: async (params: any) => {
                record.push(params);
                if (reply instanceof Error) throw reply;
                const text = JSON.stringify(reply);
                return (async function* () { yield { candidates: [{ content: { parts: [{ text }] }, finishReason: 'STOP' }], modelVersion: `${params.model}-001` } as any; })();
            }
        }
    };
}

const REPLY = {
    elements: [{ slot: 'S01', op: { revolve: { at: [5000, 15000], axis: 'n', profile: [0, 0, 900, 0, 900, 120, 0, 180] } }, conf: 62, depthBasis: 'rim highlight', ev: [[0, 300, 120, 470, 260]] }],
    corrections: [{ prim: 'p00', param: 0, to: 24.8, conf: 80, why: 'the parapet sits higher in the ortho', ev: [[0, 270, 90, 500, 290]] }],
    emptySlots: [{ slot: 'S03', why: 'no image shows it' }]
};

describe('an isolated structure', () => {
    it('without the scan fitter: the remeshed structure stands, and the rebuild stages say why', async () => {
        const s = setup(ARCH);
        const { result } = await runStagedLocation({ query: 'Washington Square Arch', isolate: true, trees: true }, s.deps, s.ctx);
        expect(result.extraction.sizedTo).toBe('structure');
        expect(s.native.extractCalls[0]).toBe(25);
        expect(s.native.refineCalls[0]).toMatchObject({ isolate: true, anchor: { x: expect.any(Number), z: expect.any(Number) } });
        expect(result.structure!.isolateIoU).toBeGreaterThanOrEqual(0.7);
        expect(result.degradations.map(d => d.reasonCode)).toEqual(expect.arrayContaining(['canopy_not_masked', 'scan_fit_unavailable']));
        for (const st of ['evidence', 'project', 'vision', 'correct', 'detail']) expect(result.stages.find(x => x.stage === st)!.status).toBe('skipped');
        // the strip got the ROI around the structure
        expect(s.native.stripCalls[0].roi).toMatchObject({ schema: 'scratchbox.strip-roi/1' });
        // trees plant against the isolated structure
        expect(String(s.native.plantCalls[0].supportMeshPath)).toMatch(/clay\.glb$/);
    });

    it('tile_refine isolating another structure skips the rebuild (isolate_mismatch)', async () => {
        // a second, taller building 7 m east of the arch, inside the probe: tile_refine is made to isolate it
        const spec: WorldSpec = { ground: 80, buildings: [[-13, 13, -6, 5, 22], [20, 30, -5, 5, 30]], trees: [] };
        const s = setup(spec, { isolateAt: { x: 25, z: 0 } }, { scanFit: fakeScanFit(path.join(TMP, 'sf-mismatch')).deps });
        const { result } = await runStagedLocation({ query: 'Washington Square Arch', isolate: true, trees: false }, s.deps, s.ctx);
        const rec = result.degradations.find(d => d.reasonCode === 'isolate_mismatch')!;
        expect(rec.reason).toMatch(/^tile_refine isolated a different structure than the one picked \(footprint IoU 0/);
        expect(result.stages.find(x => x.stage === 'fit')!).toMatchObject({ status: 'skipped', reason: 'tile_refine isolated a different structure than the one picked' });
    });

    it('fits, reads the photos at LOW thinking, photo-corrects within the tolerance, builds detail, and records it all', async () => {
        const sf = fakeScanFit(path.join(TMP, 'sf-full'));
        const calls: any[] = [];
        const s = setup(ARCH, {}, { scanFit: sf.deps, vision: { client: visionClient(REPLY, calls), candidates: ['gemini-4-argon', 'gemini-3.8-flash'] } });
        const { result } = await runStagedLocation({ query: 'Washington Square Arch', isolate: true, trees: true }, s.deps, s.ctx);
        expect(validateContract('StagedLocationResult', result)).toEqual([]);
        expect(calls[0].config.thinkingConfig).toEqual({ thinkingLevel: 'LOW' });
        const layers = (result.artifact as any).data.stagedBuild.layers;
        // the rebuild chain commits in its real order; the trees (l5) commit beside it, whenever they finish
        const order = layers.map((l: any) => l.layer);
        expect(order.filter((x: string) => x !== 'l5')).toEqual(['l1', 'l2', 'l3a', 'l3b', 'l3c', 'l3ar', 'l3br', 'l4']);
        expect(order).toContain('l5');
        expect(order.indexOf('l5')).toBeGreaterThan(order.indexOf('l2'));
        const byLayer = Object.fromEntries(layers.map((l: any) => [l.layer, l]));
        expect(byLayer.l3b).toMatchObject({ supersedes: [byLayer.l2.objectId], reveal: { crossfadeFrom: [byLayer.l2.objectId] }, revealAfter: [byLayer.l2.objectId, byLayer.l3a.objectId] });
        expect(byLayer.l3br).toMatchObject({ supersedes: [byLayer.l3b.objectId], reveal: { crossfadeFrom: [byLayer.l3b.objectId], only: { primitiveIds: ['p00'] } } });
        expect(byLayer.l4).toMatchObject({ provenance: { label: 'photo-inferred', measuredGeometry: false }, revealAfter: [byLayer.l3br.objectId] });
        expect(result.structureFit!.corrections.filter(c => c.check.accepted).map(c => [c.primitiveId, c.to, c.check.residualAfter.rmsM])).toEqual([['p00', 24.8, 0.05]]);
        expect(result.ornament).toMatchObject({ elements: 1, evidence: { tileOrthos: 1, streetView: 0 }, model: { used: 'gemini-4-argon', thinking: { level: 'LOW' }, outcome: 'answered' } });
        // no Street View credentials: tile orthos only, said so
        expect(result.degradations.find(d => d.stage === 'evidence')!.reason).toMatch(/^Street View not configured: no Google Maps API key/);
        // a measured rebuild is exempt from the floor on its own StructureFit
        expect(result.complexityGate.exemptions.some(e => e.startsWith('vertex floor: measured rebuild'))).toBe(true);
        expect(result.summary).toContain('The details were read by gemini-4-argon (thinking low');
        expect(result.summary).toContain('Primitive p00 was photo-corrected from height 24.40 to 24.80');
        expect(sf.calls).toEqual({ fit: 1, refit: 1, ornament: 1 });
        // trees and the rebuild ran side by side after the remesh
        const t = (st: string) => result.stages.find(x => x.stage === st)!.timings;
        expect(t('trees').startedAtMs).toBeLessThan(t('detail').endedAtMs!);
    });

    it('reads Street View close-ups through the grounding service only: four images, their bytes unchanged into the vision request, never written anywhere', async () => {
        const sf = fakeScanFit(path.join(TMP, 'sf-sv'));
        const place = { lat: 40.73122, lng: -73.99709 };
        const origin = { ...place, heightMeters: 0 };
        // Google captures a few tens of metres out on each side of the arch (the free metadata endpoint)
        const panos = { PN: [0, -35], PE: [45, 0], PS: [0, 38], PW: [-45, 0] } as const;
        const metadata = (async (url: string) => {
            const [lat, lng] = new URL(url).searchParams.get('location')!.split(',').map(Number);
            const hit = Object.entries(panos).find(([, [x, z]]) => { const g = scanToGeodetic(origin, x, 0, z); return Math.hypot((g.lat - lat) * 111_320, (g.lng - lng) * 84_400) < 12; });
            const body = hit ? { status: 'OK', pano_id: hit[0], location: scanToGeodetic(origin, hit[1][0], 0, hit[1][1]), date: '2025-06', copyright: '© Google' } : { status: 'ZERO_RESULTS' };
            return { ok: true, status: 200, statusText: 'OK', json: async () => body } as any;
        }) as typeof fetch;
        // distinctive, undecodable JPEGs: SOI, an SOF0 header giving the size, a random payload
        const sent = new Map<string, Buffer>();
        const requested: string[] = [];
        const grounding = {
            retrieveGroundingImage: async (req: any) => {
                requested.push(req.panoId);
                const portrait = req.aspectRatio === 'RATIO_3X4';
                const w = portrait ? 480 : 640, h = portrait ? 640 : 480;
                const bytes = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, h >> 8, h & 255, w >> 8, w & 255, 0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01]), crypto.randomBytes(4000), Buffer.from([0xff, 0xd9])]);
                sent.set(req.panoId, bytes);
                return { image: bytes, mimeType: 'image/jpeg', panoId: req.panoId, headingDegree: req.headingDegree, pitchDegree: req.pitchDegree, fovDegree: req.fovDegree };
            }
        };
        const spy = spyOnFsWrites();
        const written = spy.writes;
        // control: the spy sees a write made through this file's own `import * as fs`, bytes and all
        const canary = crypto.randomBytes(64);
        fs.writeFileSync(path.join(TMP, 'canary.bin'), canary);
        expect(written.filter(w => w.api === 'writeFileSync' && w.data?.equals(canary))).toHaveLength(1);
        written.length = 0;
        try {
            const calls: any[] = [];
            const s = setup(ARCH, {}, {
                scanFit: sf.deps, vision: { client: visionClient(REPLY, calls), candidates: ['gemini-4-argon'] },
                streetView: { mapsApiKey: 'maps-key', grounding, fetchImpl: metadata }
            });
            const { result } = await runStagedLocation({ query: 'Washington Square Arch', isolate: true, trees: false }, s.deps, s.ctx);
            spy.restore();
            // four images, one per facade, each fetched through the grounding service and no other route
            expect(requested.sort()).toEqual(['PE', 'PN', 'PS', 'PW']);
            expect(result.ornament!.evidence).toEqual({ tileOrthos: 1, streetView: 4 });
            expect(result.extraction.attribution).toContain('Street View ©Google');
            // the vision request carries exactly the bytes the service returned
            const parts: any[] = calls[0].contents[0].parts;
            const inline = parts.filter(p => p.inlineData && p.inlineData.mimeType === 'image/jpeg').map(p => Buffer.from(p.inlineData.data, 'base64'));
            expect(inline).toHaveLength(4);
            for (const b of inline) expect([...sent.values()].some(o => o.equals(b))).toBe(true);
            // no write anywhere (the spies saw them all) held an image, or named a JPEG
            const marks = [...sent.values()].map(b => b.subarray(30, 90));
            expect(written.length).toBeGreaterThan(0); // the spies were live: the build wrote its own files
            expect(written.filter(w => w.data && marks.some(m => w.data!.includes(m)))).toEqual([]);
            expect(written.filter(w => /\.jpe?g$/i.test(w.target))).toEqual([]);
            // and no file left anywhere in the workspace holds an image, raw or as base64 (the vision cache keeps ids and boxes)
            const holders: string[] = [];
            const walk = (dir: string) => {
                for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
                    const p = path.join(dir, e.name);
                    if (e.isDirectory()) { walk(p); continue; }
                    const b = fs.readFileSync(p);
                    const text = b.toString('latin1');
                    if (marks.some(m => b.includes(m) || text.includes(m.toString('base64').slice(0, 40)))) holders.push(p);
                }
            };
            walk(s.root);
            expect(holders).toEqual([]);
            // the pano ids are kept (a policy-permitted cache), the metadata cache holds nothing else
            const metaFile = path.join(s.root, '.scratchbox', 'cache', 'staged_location', 'streetview', 'metadata.json');
            expect(fs.existsSync(metaFile)).toBe(true);
            for (const rec of Object.values(JSON.parse(fs.readFileSync(metaFile, 'utf8'))) as any[]) expect(Object.keys(rec).every(k => ['status', 'panoId', 'lat', 'lng', 'date', 'copyright'].includes(k))).toBe(true);
        } finally {
            spy.restore();
        }
    });

    it('a vision failure keeps the flat fitted faces, names the model and thinking tried, and a retry reads afresh', async () => {
        const sf = fakeScanFit(path.join(TMP, 'sf-vision'));
        const down = Object.assign(new Error('UNAVAILABLE'), { status: 503 });
        const s = setup(ARCH, {}, { scanFit: sf.deps, vision: { client: visionClient(down), candidates: ['gemini-4-argon'] } });
        const first = await runStagedLocation({ query: 'Washington Square Arch', isolate: true, trees: false }, s.deps, s.ctx);
        const rec = first.result.degradations.find(d => d.stage === 'vision')!;
        expect(rec).toMatchObject({ reasonCode: 'vision_unavailable', fellTo: 'the flat fitted face', provenanceAfter: 'fitted', transient: true, model: { used: 'gemini-4-argon', thinking: { level: 'LOW' }, outcome: 'failed' } });
        expect(rec.retry).toEqual({ tool: 'google_3d_tiles_get_clay', args: { retryRunId: 'a1b2c301', retryStage: 'vision' }, reuses: ['resolve', 'tiles', 'remesh', 'fit', 'evidence'] });
        expect((first.result.artifact as any).data.stagedBuild.visionModel).toMatchObject({ outcome: 'failed', error: 'gemini-4-argon failed (transient 503): UNAVAILABLE' });
        expect(first.result.digest).toContain('retry retryRunId a1b2c301 stage vision');
        expect(first.result.stages.find(x => x.stage === 'detail')!.status).toBe('skipped');

        // the retry: the recorded request, every other stage from cache, vision asked again
        const ok = setup(ARCH, {}, { scanFit: sf.deps, vision: { client: visionClient(REPLY), candidates: ['gemini-4-argon'] } });
        Object.assign(ok, { root: s.root });
        const retryDeps: StagedLocationDeps = { ...s.deps, vision: { client: visionClient(REPLY), candidates: ['gemini-4-argon'] } };
        const again = await runStagedLocation({ query: 'ignored', isolate: false, trees: true }, retryDeps, { ...s.ctx, retry: { runId: 'a1b2c301', stage: 'vision' } });
        expect(again.result.place.query).toBe('Washington Square Arch');
        expect(again.result.cache).toMatchObject({ resolve: 'hit', tiles: 'hit', vision: 'bypassed' });
        expect(again.result.ornament!.elements).toBe(1);
        expect(s.native.extractCalls).toEqual([25]);
    });

    it('a deterministic scan_fit failure is negative-cached; a retry of the fit bypasses it', async () => {
        const sf = fakeScanFit(path.join(TMP, 'sf-neg'), { fitFails: Object.assign(new Error('no connected structure at the anchor'), { code: 'no_structure' }) });
        const s = setup(ARCH, {}, { scanFit: sf.deps });
        const first = await runStagedLocation({ query: 'Washington Square Arch', isolate: true, trees: false }, s.deps, s.ctx);
        expect(first.result.degradations.find(d => d.stage === 'fit')).toMatchObject({ reasonCode: 'fit_rejected', transient: false });
        const second = await runStagedLocation({ query: 'Washington Square Arch', isolate: true, trees: false }, s.deps, s.ctx);
        expect(sf.calls.fit).toBe(1); // failed fast from the negative entry
        expect(second.result.degradations.find(d => d.stage === 'fit')!.reason).toContain('no connected structure at the anchor');
        await runStagedLocation({ query: 'x', isolate: false, trees: false }, s.deps, { ...s.ctx, retry: { runId: 'a1b2c301', stage: 'fit' } });
        expect(sf.calls.fit).toBe(2);
    });

    it('a rejected fit keeps the remeshed structure, with the gates that failed', async () => {
        const s = setup(ARCH, {}, { scanFit: fakeScanFit(path.join(TMP, 'sf-rej'), { rejected: true }).deps });
        const { result } = await runStagedLocation({ query: 'Washington Square Arch', isolate: true, trees: false }, s.deps, s.ctx);
        expect(result.degradations.find(d => d.stage === 'fit')!.reason).toBe('the fit did not pass its gates (scan→fit rms 7.1 cm > 6.0 cm); the remeshed scan stands as the structure');
        expect((result.artifact as any).data.stagedBuild.layers.map((l: any) => l.layer)).toEqual(['l1', 'l2']);
    });

    it('no structure at the place: the area around it at 60 m, without a rebuild', async () => {
        const s = setup({ ground: 100, buildings: [], trees: [] });
        const { result } = await runStagedLocation({ query: 'Sheep Meadow', isolate: true, trees: false }, s.deps, s.ctx);
        expect(s.native.extractCalls).toEqual([25, 60]);
        expect(result.extraction).toMatchObject({ sizedTo: 'district-fallback', radiusM: 60 });
        expect(result.degradations.find(d => d.reasonCode === 'no_structure_at_anchor')!.fellTo).toBe('the remeshed area around the place, without a rebuild');
        expect(s.native.refineCalls[0].isolate).toBeUndefined();
        expect(result.stages.find(x => x.stage === 'fit')!.reason).toBe('the structure could not be isolated, so it is shown without a rebuild');
    });
});

describe('Stop, the deadline and hard failures', () => {
    it('Stop after the remesh commits: no later stage runs, the run is recorded stopped', async () => {
        const s = setup(PARK);
        const stop = new AbortController();
        const ctx = { emitStage: (e: StageEvent, a?: CanvasArtifact) => { s.events.push({ e, artifact: a }); if (e.stage === 'remesh' && e.status === 'committed') stop.abort(); }, signal: stop.signal };
        const err = await runStagedLocation({ query: 'Central Park', isolate: false, radiusM: 60, trees: true }, s.deps, ctx).catch(e => e);
        expect(err.name).toBe('AbortError');
        expect(s.native.plantCalls).toEqual([]);
        const rec = s.cache.readRunRecord<any>('a1b2c301');
        expect(rec.statuses).toMatchObject({ remesh: 'committed', trees: 'stopped' });
        // the last scene the viewport received holds the committed layers
        const last = s.events.filter(x => x.artifact).pop()!.artifact as any;
        expect(last.data.stagedBuild.layers.map((l: any) => l.layer)).toEqual(['l1', 'l2']);
    });

    it('the run deadline stops what has not finished and returns what is committed, degraded', async () => {
        const s = setup(PARK, { plantDelayMs: 400 });
        const started = Date.now();
        const remaining = 120_000 + 300; // the run stops starting stages 2 min before the tool budget
        const { result } = await runStagedLocation({ query: 'Central Park', isolate: false, radiusM: 60, trees: true }, s.deps, { ...s.ctx, remainingMs: () => remaining - (Date.now() - started) });
        expect(result.status).toBe('degraded');
        expect(result.stages.find(x => x.stage === 'trees')!.status).toBe('stopped');
        expect(result.degradations.find(d => d.reasonCode === 'run_deadline')!.reason).toMatch(/^stopped at the time limit after /);
        expect((result.artifact as any).data.stagedBuild.layers.map((l: any) => l.layer)).toEqual(['l1', 'l2']);
    });

    it('fails hard only without real data: the place cannot be resolved, or no tiles cover it', async () => {
        const s = setup(PARK, {}, { geocode: async () => { throw new Error('ZERO_RESULTS'); } });
        const err = await runStagedLocation({ query: 'Atlantis Plaza', isolate: false, trees: true }, s.deps, s.ctx).catch(e => e);
        expect(err).toBeInstanceOf(StagedLocationHardFailure);
        expect(err.message).toBe('The place could not be resolved: ZERO_RESULTS');
        const t = setup(PARK, {}, { extract: async () => { throw new Error('no Photorealistic 3D Tiles coverage at 0, 0'); } });
        const err2 = await runStagedLocation({ query: 'Mid-Atlantic', isolate: false, trees: true }, t.deps, t.ctx).catch(e => e);
        expect(err2).toBeInstanceOf(StagedLocationHardFailure);
        expect(err2.reasonCode).toBe('no_tile_coverage');
        void writeStagedGlbFile;
    });
});
