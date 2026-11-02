/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Something meaningful fast (docs/processes/build_speed_benchmark.md): the order in which a staged build shows what it
 * has, over synthetic worlds with stand-in engines (the vector first paint runs the REAL native massing tool):
 *   - the vector first paint (Google vector buildings, extruded natively) is on screen before the tiles, labelled
 *     vector-modelled; the tiles supersede it; a district keeps the buildings past the tiles' reach as their own layer;
 *   - the geometric isolate is the first clay building; the ownership vote runs after it, and its voted remesh replaces it
 *     (and the rebuild runs again) only when it moves at least 5% of the structure's surface; in pipeline K it is shown only
 *     after the facade work and polish the first isolate had (its base cleaned and clipped to the footprint);
 *   - a twin baked from the tile photo is published before the Street View steps (the fit, the close-ups);
 *   - districts are textured (tile_refine's photo on the district remesh), clay first; a clay request stays clay.
 * No network, no billed call.
 */

import { TEXTURE_RUNG_CLAY } from '../src/common/spatial/texture-pass-contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { runStagedLocation, type StagedLocationDeps } from '../src/node/3d-engine/staged-location/orchestrator';
import { ensureMassingBinary } from '../src/node/3d-engine/staged-location/pipeline-e/native-massing';
import { StageCache } from '../src/node/3d-engine/staged-location/stage-cache';
import { validateContract, type StageEvent } from '../src/common/spatial/staged-location-contracts';
import type { CanvasArtifact } from '../src/browser/generative-canvas/canvas-types';
import type { VectorEvidence } from '../src/node/3d-engine/staged-location/vector-footprints';
import { building, fakeNative, readTris, writeTris, type WorldSpec } from './helpers/staged-synthetic-world';
import { fitter, photoTexture } from './helpers/staged-texture-world';
import { parseGlbBytes } from '../src/node/3d-engine/staged-location/glb-bytes';
import { encodePng } from '../src/node/texture-processing';
import { ownershipChange } from '../src/node/3d-engine/staged-location/ownership-change';
import { tileRefineTwin } from '../src/node/3d-engine/staged-location/tile-refine-twin';
import { carryStagedChoice, deriveMaterialLayers, INITIAL_SWITCH, nextSwitch, withStagedMaterialMode } from '../src/browser/generative-canvas/primitives/scene3d/stagedBuild/texturedTwins';

const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sbx-staged-fast-')));
afterAll(() => fs.rmSync(TMP, { recursive: true, force: true }));
// the vector first paint runs the real native massing tool: built before the races below, as the app has it built after its
// first use, so the paint races the tiles' download and not a cold compile (seconds here, minutes on a 2-vCPU runner)
beforeAll(async () => { await ensureMassingBinary(); }, 600_000);

const ARCH: WorldSpec = { ground: 40, buildings: [[-13, 13, -6, 5, 22]], trees: [] };
const PARK: WorldSpec = { ground: 80, buildings: [[30, 44, 30, 40, 9]], trees: [{ x: -12, z: -10, r: 4, h: 7, id: 3 }] };

/** Vector evidence: each box an extruded footprint part with a height (x0, x1, z0, z1, h). */
function vectorOf(boxes: Array<[number, number, number, number, number]>): VectorEvidence {
    return {
        buildings: boxes.map(([x0, x1, z0, z1, h], i) => {
            const ring: Array<[number, number]> = [[x0, z0], [x1, z0], [x1, z1], [x0, z1]];
            return { id: `17/1/1/f${i}`, parts: [[ring]], heightM: h, extruded: [{ loops: [ring], heightM: h }] };
        }),
        water: [], roads: [], tiles: 1, zoom: 17
    };
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
let counter = 0;
function setup(spec: WorldSpec, extra: Partial<StagedLocationDeps> = {}, opts: { extractDelayMs?: number; coverM?: number; photo?: boolean } = {}) {
    const root = path.join(TMP, `ws${++counter}`);
    fs.mkdirSync(root, { recursive: true });
    const native = fakeNative(path.join(root, 'native'), spec, {});
    const extract: StagedLocationDeps['extract'] = async req => {
        if (opts.extractDelayMs) await sleep(opts.extractDelayMs);
        const r = await native.deps.extract(req);
        if (opts.coverM !== undefined) {
            // the leaf-tile cap: the scan reaches only coverM of the radius asked for
            const near = (t: number[]) => Math.hypot((t[0] + t[3] + t[6]) / 3, (t[2] + t[5] + t[8]) / 3) <= opts.coverM!;
            writeTris(r.texturedGlb, readTris(r.texturedGlb).filter(near));
            writeTris(r.geometryGlb, readTris(r.geometryGlb).filter(near));
            Object.assign(r, { coveredRadiusM: opts.coverM, truncated: true });
        }
        if (opts.photo !== false) photoTexture(r.texturedGlb);
        return r;
    };
    let runs = 0;
    const deps: StagedLocationDeps = {
        cache: new StageCache({ workspaceRoot: root }),
        geocode: async q => ({ lat: 40.73122, lng: -73.99709, formattedAddress: `${q}, New York, NY`, placeId: 'p' }),
        extract, vegetation: native.deps.vegetation, refine: native.deps.refine,
        newRunId: () => (0xc1b2c300 + ++runs).toString(16),
        sleep: async () => undefined,
        textures: { maxDensityTexelsPerMeter: 4, maxSide: 512 },
        ...extra
    };
    const events: Array<{ e: StageEvent; artifact?: CanvasArtifact; at: number }> = [];
    const ctx = { emitStage: (e: StageEvent, artifact?: CanvasArtifact) => events.push({ e, artifact, at: Date.now() }) };
    return { root, native, deps, events, ctx };
}

const firstSeq = (events: Array<{ e: StageEvent }>, pred: (e: StageEvent) => boolean) => events.find(x => pred(x.e))?.e.seq ?? -1;
const layersOf = (a: CanvasArtifact | undefined) => ((a as any)?.data?.stagedBuild?.layers ?? []) as any[];

describe('the vector first paint', () => {
    it('is on screen before the tiles, labelled vector-modelled, and the tiles supersede it', async () => {
        const s = setup(ARCH, { vectorEvidence: async () => vectorOf([[-13, 13, -6, 5, 22], [-30, -20, 10, 20, 12]]), elevations: async pts => pts.map(() => 9.2) }, { extractDelayMs: 1500 });
        const { result } = await runStagedLocation({ query: 'Washington Square Arch', isolate: true, trees: false }, s.deps, s.ctx);
        expect(validateContract('StagedLocationResult', result)).toEqual([]);
        // the first scene the viewport gets holds the vector massing alone
        const firstScene = s.events.find(x => x.artifact)!;
        expect(layersOf(firstScene.artifact).map(l => l.layer)).toEqual(['l0']);
        const l0 = layersOf(firstScene.artifact)[0];
        expect(l0).toMatchObject({ stage: 'vector', provenance: { label: 'vector-modelled', measuredGeometry: false }, provenanceLabels: ['vector-modelled'] });
        expect(l0.counts.triangles).toBeGreaterThan(0);
        // it came before the tiles committed, and the tiles' L1 fades it out
        expect(firstScene.e.seq).toBeLessThan(firstSeq(s.events, e => e.stage === 'tiles' && e.status !== 'running'));
        const final = (result.artifact as any).data.stagedBuild;
        const l1 = final.layers.find((l: any) => l.layer === 'l1');
        expect(l1.supersedes).toContain(l0.objectId);
        expect(l1.reveal.crossfadeFrom).toContain(l0.objectId);
        // an isolated structure keeps no vector massing past the tiles
        expect(final.layers.some((l: any) => l.layer === 'l0o')).toBe(false);
        // the published massing: native geometry, every node labelled vector-modelled
        const glb = parseGlbBytes(fs.readFileSync(path.join(s.root, 'public', 'models', path.basename(l0.url))));
        const meshNodes = glb.json.nodes.filter((n: any) => n.mesh !== undefined);
        expect(meshNodes.length).toBe(2);
        expect(meshNodes.every((n: any) => n.extras.sb.provenance.label === 'vector-modelled')).toBe(true);
        expect(result.stages.find(x => x.stage === 'vector')).toMatchObject({ status: 'committed' });
    });

    it('a district past the leaf-tile cap keeps the buildings the tiles do not cover, on bases against the tiles\' frame', async () => {
        const s = setup(PARK, { vectorEvidence: async () => vectorOf([[-5, 5, -5, 5, 10], [44, 54, -5, 5, 15]]), elevations: async pts => pts.map((_, i) => (i === 2 ? 12.2 : 9.2)) }, { coverM: 30 });
        const { result } = await runStagedLocation({ query: 'Central Park', isolate: false, radiusM: 60, trees: false }, s.deps, s.ctx);
        const final = (result.artifact as any).data.stagedBuild;
        const l0o = final.layers.find((l: any) => l.layer === 'l0o');
        expect(l0o, JSON.stringify(final.layers.map((l: any) => l.layer))).toBeDefined();
        expect(l0o.provenance.label).toBe('vector-modelled');
        expect(l0o.provenance.note).toMatch(/1 vector buildings the 3D Tiles do not cover \(the tiles reach 30 of the 60 m asked for/);
        // only the building past the tiles; its base is its elevation less the frame's own (geoAnchor 9.2 m): 3 m up
        const glb = parseGlbBytes(fs.readFileSync(path.join(s.root, 'public', 'models', path.basename(l0o.url))));
        expect(glb.json.nodes.filter((n: any) => n.mesh !== undefined).map((n: any) => n.name)).toEqual(['17/1/1/f1']);
        const acc = glb.json.accessors[glb.json.meshes[0].primitives[0].attributes.POSITION];
        expect(acc.min[1]).toBeCloseTo(3, 3);
        expect(acc.max[1]).toBeCloseTo(18, 3);
        // still shown at the end, labelled in the legend, and not superseded by anything
        expect(final.layers.some((l: any) => l.supersedes.includes(l0o.objectId))).toBe(false);
        expect(final.provenanceLegend.map((e: any) => e.label)).toContain('vector-modelled');
        expect(result.degradations.find(d => d.reasonCode === 'radius_truncated')).toBeDefined();
    });

    it('without vector credentials the stage is skipped and says why; the tiles are the first 3D', async () => {
        const s = setup(ARCH);
        const { result } = await runStagedLocation({ query: 'Washington Square Arch', isolate: true, trees: false }, s.deps, s.ctx);
        expect(result.stages.find(x => x.stage === 'vector')).toMatchObject({ status: 'skipped', reason: expect.stringMatching(/no Google vector data/) });
        expect(layersOf(s.events.find(x => x.artifact)!.artifact)[0].layer).toBe('l1');
    });
});

/** Views for the ownership vote and a vision model that outlines the whole view, after `delayMs`. */
function voteDeps(dir: string, delayMs: number, opts: { notVisible?: string[] } = {}): Pick<StagedLocationDeps, 'vision'> & { renderOwnershipViews: NonNullable<StagedLocationDeps['refine']['renderOwnershipViews']>; calls: () => number } {
    fs.mkdirSync(dir, { recursive: true });
    const png = encodePng(16, 16, Buffer.alloc(16 * 16 * 4, 200));
    const names = ['v0', 'v1', 'v2'];
    for (const n of names) fs.writeFileSync(path.join(dir, `${n}.png`), png);
    fs.writeFileSync(path.join(dir, 'views.txt'), names.map(n => `${n} 16 16 0 0 0 0 0 0 0 0 0 60`).join('\n') + '\n');
    const reply = JSON.stringify({ visible: true, polygons: [{ outer: [[0, 0], [0, 1000], [1000, 1000], [1000, 0]], holes: [] }] });
    const unseen = JSON.stringify({ visible: false, polygons: [] });
    // the view a request outlines is told by its prompt's size line: every view is 16 x 16, so by the order asked (views.txt order)
    let calls = 0;
    const client = {
        models: {
            generateContent: async () => {
                const view = names[calls++ % names.length];
                await sleep(delayMs);
                return { candidates: [{ content: { parts: [{ text: opts.notVisible?.includes(view) ? unseen : reply }] }, finishReason: 'STOP' }], modelVersion: 'gemini-4-argon-001' } as any;
            },
            generateContentStream: async () => { throw new Error('the ownership vote is not streamed'); }
        }
    };
    return { vision: { client: client as never, candidates: ['gemini-4-argon'] }, renderOwnershipViews: async () => ({ dir, views: names, cached: false, ms: 5 }), calls: () => calls };
}

describe('the fast isolate first', () => {
    it('shows the geometric isolate and starts the fit before the ownership vote; a vote that agrees replaces nothing', async () => {
        const s0 = setup(ARCH);
        const v = voteDeps(path.join(s0.root, 'views'), 1200);
        const refineCalls: any[] = [];
        const s = setup(ARCH, { vision: v.vision, scanFit: fitter(path.join(s0.root, 'fit')), refine: { refine: req => { refineCalls.push(req); return s0.native.deps.refine.refine(req); }, renderOwnershipViews: v.renderOwnershipViews } });
        const { result } = await runStagedLocation({ query: 'Washington Square Arch', isolate: true, trees: false }, s.deps, s.ctx);
        const remeshCommit = firstSeq(s.events, e => e.stage === 'remesh' && e.status === 'committed');
        const voteDone = firstSeq(s.events, e => e.stage === 'ownership' && e.status !== 'running');
        const fitCommit = firstSeq(s.events, e => e.stage === 'fit' && e.status === 'committed');
        expect(remeshCommit).toBeGreaterThan(0);
        expect(voteDone).toBeGreaterThan(remeshCommit);
        // the fit started from the first isolate, before the vote finished
        expect(fitCommit).toBeGreaterThan(0);
        expect(fitCommit).toBeLessThan(voteDone);
        // the first remesh ran without the vote, the vote's own with it
        expect(refineCalls[0].ownership).toBeUndefined();
        expect(refineCalls.some(r => r.ownership?.masksDir)).toBe(true);
        const vote = result.stages.find(x => x.stage === 'ownership')!;
        expect(vote.status).toBe('committed');
        expect(vote.source).toMatch(/^the vote moved 0% of the structure's scan surface .*, under the 5% that would replace the geometric isolate/);
        const final = (result.artifact as any).data.stagedBuild;
        expect(final.layers.some((l: any) => l.layer === 'l2v')).toBe(false);
        expect(final.layers.filter((l: any) => l.layer === 'l3b')).toHaveLength(1);
    });

    it('a vote that moves the structure materially replaces the isolate and what was built on it, and the rebuild runs again on it', async () => {
        const s0 = setup(ARCH);
        const v = voteDeps(path.join(s0.root, 'views'), 600);
        // the vote's isolate holds a rooftop block the geometric one did not (8 x 8 x 6 m on the roof)
        const refine: StagedLocationDeps['refine']['refine'] = async req => {
            const r = await s0.native.deps.refine.refine(req);
            if (!req.ownership) return r;
            const dir = path.join(s0.root, 'voted');
            fs.mkdirSync(dir, { recursive: true });
            const extraTris = building(-4, 4, -4, 4, 6).map(t => t.map((c, k) => (k % 3 === 1 ? c + 22 : c)) as typeof t);
            for (const [name, from] of [['raw_clay.glb', r.rawClayGlb!], ['clay.glb', r.clayGlb], ['textured.glb', r.texturedGlb]] as const) writeTris(path.join(dir, name), [...readTris(from), ...extraTris]);
            return { ...r, rawClayGlb: path.join(dir, 'raw_clay.glb'), clayGlb: path.join(dir, 'clay.glb'), texturedGlb: path.join(dir, 'textured.glb'), cacheKey: 'e'.repeat(64) };
        };
        let fits = 0;
        const sf = fitter(path.join(s0.root, 'fit'));
        const s = setup(ARCH, { vision: v.vision, scanFit: { ...sf, fit: async req => { fits++; return sf.fit(req); } }, refine: { refine, renderOwnershipViews: v.renderOwnershipViews } });
        const { result } = await runStagedLocation({ query: 'Washington Square Arch', isolate: true, trees: false }, s.deps, s.ctx);
        expect(validateContract('StagedLocationResult', result)).toEqual([]);
        const final = (result.artifact as any).data.stagedBuild;
        const l2 = final.layers.find((l: any) => l.layer === 'l2');
        const l2v = final.layers.find((l: any) => l.layer === 'l2v');
        expect(l2v, JSON.stringify(final.layers.map((l: any) => l.layer))).toBeDefined();
        expect(l2v.provenance.note).toMatch(/^the vote moved \d+(\.\d)?% of the structure's scan surface/);
        // it hides the first isolate and the first pass's fitted body; the fit ran twice, the second on the voted remesh
        const bodies = final.layers.filter((l: any) => l.layer === 'l3b');
        expect(bodies.length).toBe(2);
        expect(l2v.supersedes).toEqual(expect.arrayContaining([l2.objectId, bodies[0].objectId]));
        expect(bodies[1].supersedes).toContain(l2v.objectId);
        expect(fits).toBe(2);
        const ownershipDone = firstSeq(s.events, e => e.stage === 'ownership' && e.status === 'committed');
        const fitCommits = s.events.filter(x => x.e.stage === 'fit' && x.e.status === 'committed').map(x => x.e.seq);
        expect(fitCommits.length).toBe(2);
        expect(fitCommits[0]).toBeLessThan(ownershipDone);
        expect(fitCommits[1]).toBeGreaterThan(ownershipDone);
        // the scene stands on the voted remesh
        expect((result.artifact as any).data.objects.find((o: any) => o.content.metadata.isGround).id).toBe(l2v.objectId);
    });

    it('pipeline K: a material vote gets the facade work and polish the first isolate got, so the voted building shown is cut to its footprint', async () => {
        const s0 = setup(ARCH);
        const v = voteDeps(path.join(s0.root, 'views'), 50);
        // the vote's isolate holds a rooftop block the geometric one did not (material), and a neighbour's scrap 10 m up past
        // the footprint's east edge; like the first isolate it keeps tile_refine's ground apron around the base
        const scrap = building(13, 16, -2, 2, 4).map(t => t.map((c, k) => (k % 3 === 1 ? c + 10 : c)) as typeof t);
        const votedKeys: string[] = [];
        const refine: StagedLocationDeps['refine']['refine'] = async req => {
            const r = await s0.native.deps.refine.refine(req);
            if (!req.ownership) return r;
            const dir = path.join(s0.root, `voted_${votedKeys.length}`);
            fs.mkdirSync(dir, { recursive: true });
            const roof = building(-4, 4, -4, 4, 6).map(t => t.map((c, k) => (k % 3 === 1 ? c + 22 : c)) as typeof t);
            for (const [name, from] of [['raw_clay.glb', r.rawClayGlb!], ['clay.glb', r.clayGlb], ['textured.glb', r.texturedGlb]] as const) writeTris(path.join(dir, name), [...readTris(from), ...roof, ...scrap]);
            const cacheKey = String(votedKeys.length + 5).repeat(64);
            votedKeys.push(cacheKey);
            return { ...r, rawClayGlb: path.join(dir, 'raw_clay.glb'), clayGlb: path.join(dir, 'clay.glb'), texturedGlb: path.join(dir, 'textured.glb'), cacheKey };
        };
        const s = setup(ARCH, { vision: v.vision, refine: { refine, renderOwnershipViews: v.renderOwnershipViews } });
        const { result } = await runStagedLocation({ query: 'Washington Square Arch', isolate: true, trees: false, pipeline: 'k' }, s.deps, s.ctx);
        expect(validateContract('StagedLocationResult', result)).toEqual([]);
        const final = (result.artifact as any).data.stagedBuild;
        const l2v = final.layers.find((l: any) => l.layer === 'l2v');
        expect(l2v, JSON.stringify(result.stages.find(x => x.stage === 'ownership'))).toBeDefined();
        // the footprint the base cleanup stood on (no Google footprint here: the scan's own outline, and named so)
        const base = s.deps.cache.readRunNote<{ loops: Array<Array<[number, number]>>; footprint: string; report: { apronSkipped?: string } | null }>(final.runId, 'pipeline_k_base')!;
        expect(base.footprint).toBe('scan outline');
        expect(base.report).not.toBeNull();
        expect(base.report!.apronSkipped).toBeUndefined();
        const loop = base.loops[0];
        const offFootprintM = (x: number, z: number): number => {
            let inside = false, d = Infinity;
            for (let i = 0, j = loop.length - 1; i < loop.length; j = i++) {
                const [ax, az] = loop[j], [bx, bz] = loop[i];
                if ((bz > z) !== (az > z) && x < ((ax - bx) * (z - bz)) / (az - bz) + bx) inside = !inside;
                const ex = bx - ax, ez = bz - az, u = Math.max(0, Math.min(1, ((x - ax) * ex + (z - az) * ez) / (ex * ex + ez * ez)));
                d = Math.min(d, Math.hypot(x - ax - u * ex, z - az - u * ez));
            }
            return inside ? 0 : d;
        };
        // surface past the footprint (and its clip margin); a triangle the polish collapsed to a point has none
        const area = (t: number[]) => { const ax = t[3] - t[0], ay = t[4] - t[1], az = t[5] - t[2], bx = t[6] - t[0], by = t[7] - t[1], bz = t[8] - t[2]; return Math.hypot(ay * bz - az * by, az * bx - ax * bz, ax * by - ay * bx) / 2; };
        const outside = (tris: number[][]) => tris.filter(t => area(t) > 1e-6 && offFootprintM((t[0] + t[3] + t[6]) / 3, (t[2] + t[5] + t[8]) / 3) > 0.35);
        // the raw re-refine had the scrap and the apron past the footprint; the published voted building has none of either
        const rawVoted = readTris(path.join(s0.root, `voted_${votedKeys.length - 1}`, 'clay.glb'));
        expect(outside(rawVoted).length).toBeGreaterThan(20);
        const published = readTris(path.join(s.root, 'public', 'models', path.basename(l2v.url)));
        expect(published.length).toBeGreaterThan(0);
        expect(outside(published)).toEqual([]);
        // its roof block is kept: the vote's change is what the building shows
        expect(published.some(t => t[1] > 27.5 && t[4] > 27.5 && t[7] > 27.5)).toBe(true);
        expect(l2v.provenance.method).toMatch(/then pipeline K's facade work and polish, its base cleaned and clipped to the footprint/);
        // the voted remesh is a polished one: its own cache key and layer id, not the raw re-refine's
        const rec = JSON.parse(fs.readFileSync(s.deps.cache.runRecordPath(final.runId), 'utf8'));
        expect(votedKeys).not.toContain(rec.keys.remesh);
        expect(l2v.objectId).toBe(`stg-${rec.keys.remesh.slice(0, 8)}-l2v`);
        // the node graph's steps are the voted build's: the base cleanup and the clip ran on it, their snapshots drawn with it
        const latest = new Map<string, any>();
        for (const st of final.steps ?? []) latest.set(st.key, st);
        for (const key of ['polish.base', 'polish.clip', 'polish.infill']) {
            expect(latest.get(key), key).toMatchObject({ status: 'done', snapshot: { frameOf: [l2v.objectId, expect.any(String)] } });
            expect(final.steps.filter((st: any) => st.key === key)).toHaveLength(2);
        }
        expect(latest.get('ownership.tileRefine')).toMatchObject({ status: 'done', snapshot: { frameOf: [l2v.objectId, expect.any(String)] } });
        // the scene stands on the voted building, and the texture pass ran again on it
        expect((result.artifact as any).data.objects.find((o: any) => o.content.metadata.isGround).id).toBe(l2v.objectId);
        expect(result.stages.find(x => x.stage === 'ownership')?.status).toMatch(/^(committed|degraded)$/);
    });

    it('a view that cast no vote stays "not voted" when the vote is read back on a repeat build, and the repeat asks no view live', async () => {
        const s0 = setup(ARCH);
        // v2 says the structure is not in its view: the vote goes ahead on v0 and v1, and v2 is recorded as casting no vote
        const v = voteDeps(path.join(s0.root, 'views'), 50, { notVisible: ['v2'] });
        const refineCalls: any[] = [];
        const s = setup(ARCH, { vision: v.vision, scanFit: fitter(path.join(s0.root, 'fit')), refine: { refine: req => { refineCalls.push(req); return s0.native.deps.refine.refine(req); }, renderOwnershipViews: v.renderOwnershipViews } });
        const first = await runStagedLocation({ query: 'Washington Square Arch', isolate: true, trees: false }, s.deps, s.ctx);
        expect(v.calls()).toBe(3);
        const legendOf = (r: typeof first) => (r.result.artifact as any).data.stagedBuild.provenanceLegend.find((e: any) => e.label === 'remeshed').description as string;
        expect(legendOf(first)).toMatch(/outlined the structure in 2 of 3 views of the tile \(no vote from v2: the model did not find the structure in this view\); the vote moved/);
        expect(legendOf(first)).not.toMatch(/read back/);
        const masksDirs = refineCalls.filter(r => r.ownership?.masksDir).map(r => r.ownership.masksDir);
        expect(masksDirs).toHaveLength(1);
        // the same build again: the vote is read back as it went ahead; v2 is not asked live (that would change the masks, the
        // remesh key and run the rebuild again), and it is still reported as not voting
        const again = await runStagedLocation({ query: 'Washington Square Arch', isolate: true, trees: false }, s.deps, s.ctx);
        expect(v.calls()).toBe(3);
        expect(again.result.stages.find(x => x.stage === 'ownership')).toMatchObject({ status: 'committed' });
        expect(legendOf(again)).toMatch(/outlined the structure in 2 of 3 views of the tile \(no vote from v2: the model did not find the structure in this view\) \(read back from the vote of run c1b2c301; 1 of 3 views still cast no vote \(v2: the model did not find the structure in this view\)\); the vote moved/);
        expect(refineCalls.filter(r => r.ownership?.masksDir).map(r => r.ownership.masksDir)).toEqual([masksDirs[0], masksDirs[0]]);
    });

    it('measures the change on the scan triangles: 5% of the surface is the threshold', () => {
        const dir = path.join(TMP, 'change');
        fs.mkdirSync(dir, { recursive: true });
        const a = writeTris(path.join(dir, 'a.glb'), building(-10, 10, -10, 10, 20));
        const b = writeTris(path.join(dir, 'b.glb'), [...building(-10, 10, -10, 10, 20), ...building(20, 21, 0, 1, 1)]);
        const c = writeTris(path.join(dir, 'c.glb'), [...building(-10, 10, -10, 10, 20), ...building(20, 30, 0, 10, 10)]);
        expect(ownershipChange(a, a)).toMatchObject({ share: 0, material: false });
        const small = ownershipChange(a, b);
        expect(small.material).toBe(false);
        expect(small.onlySecondM2).toBeCloseTo(5, 3); // the walls and the roof of a 1 m block
        expect(small.share).toBeLessThan(0.05);
        const big = ownershipChange(a, c);
        expect(big.material).toBe(true);
        expect(big.onlyFirstM2).toBe(0);
    });
});

describe('the photo-textured version first', () => {
    it('publishes a twin baked from the tile photo before the fit and its Street View close-ups', async () => {
        const s0 = setup(ARCH);
        // the fit (and the Street View close-ups it starts) does not answer until a twin is out: the twin cannot wait on them
        let twinOut!: () => void;
        const twinSeen = new Promise<void>(r => { twinOut = r; });
        const sf = fitter(path.join(s0.root, 'fit'));
        const s = setup(ARCH, { scanFit: { ...sf, fit: async req => { await Promise.race([twinSeen, sleep(60_000)]); return sf.fit(req); } } });
        const emit = s.ctx.emitStage;
        s.ctx.emitStage = (e, a) => { emit(e, a); if (e.stage === 'textures' && e.layers?.some(l => l.textured)) twinOut(); };
        const { result } = await runStagedLocation({ query: 'Washington Square Arch', isolate: true, trees: false }, s.deps, s.ctx);
        const firstTwin = s.events.find(x => x.e.stage === 'textures' && x.e.layers?.some(l => l.textured))!;
        expect(firstTwin, 'a twin was published').toBeDefined();
        const twin = firstTwin.e.layers!.find(l => l.textured)!;
        expect(twin.layer).toBe('l2');
        // the tile photo holds the twin; no Street View texel
        expect(twin.textured!.rungShares[2]).toBeGreaterThan(0.5);
        expect(twin.textured!.rungShares[0] + twin.textured!.rungShares[1]).toBe(0);
        expect(firstTwin.e.seq).toBeLessThan(firstSeq(s.events, e => e.stage === 'fit' && e.status !== 'running'));
        // later layers (the fit's) are textured as they land, by the late stage, which the first stage did not wait for
        const tex = result.stages.find(x => x.stage === 'textures')!;
        const late = result.stages.find(x => x.stage === 'textures-late')!;
        expect(tex.status).toBe('committed');
        expect(late.status).toBe('committed');
        expect(tex.timings.endedAtMs!).toBeLessThan(late.timings.endedAtMs!);
        expect(late.source).toMatch(/^textured l3a, l3b|^textured l3b, l3a/);
        expect(result.texturePass!.degradations.some(d => d.reasonCode === 'no_street_view')).toBe(true);
    });
});

describe('districts are textured by default', () => {
    it('the district remesh gets tile_refine\'s photo as its twin, clay first then the twin; the record says so', async () => {
        const s0 = setup(PARK);
        // tile_refine's photo-textured output carries the leaf photos (here: the fixture's striped stone)
        const s = setup(PARK, { refine: { refine: async req => { const r = await s0.native.deps.refine.refine(req); photoTexture(r.texturedGlb); return r; } } });
        const { result } = await runStagedLocation({ query: 'Central Park', isolate: false, radiusM: 60, trees: true }, s.deps, s.ctx);
        expect(validateContract('StagedLocationResult', result)).toEqual([]);
        const tex = result.stages.find(x => x.stage === 'textures')!;
        expect(tex.status).toBe('committed');
        expect(tex.source).toMatch(/with the tile photo tile_refine carries onto its remesh, de-lit/);
        // clay first: the remesh commits without a twin, the twin follows in a later event
        const remeshCommit = s.events.find(x => x.e.stage === 'remesh' && x.e.status === 'committed')!;
        expect(remeshCommit.e.layers!.every(l => !l.textured)).toBe(true);
        const twinEvent = s.events.find(x => x.e.layers?.some(l => l.layer === 'l2' && l.textured))!;
        expect(twinEvent.e.seq).toBeGreaterThan(remeshCommit.e.seq);
        const final = (result.artifact as any).data.stagedBuild;
        const l2 = final.layers.find((l: any) => l.layer === 'l2');
        expect(l2.textured.provenance).toEqual([expect.objectContaining({ source: 'tile-photo', label: 'photo-inferred', coverage: 1 })]);
        expect(l2.textured.rungShares[2]).toBe(1);
        // the twin keeps the photo under the viewport's clay pass: every material carries the confidence extras
        const twin = parseGlbBytes(fs.readFileSync(path.join(s.root, 'public', 'models', path.basename(l2.textured.url))));
        expect(twin.json.materials.every((m: any) => typeof m.extras?.sbTexture?.confidenceTexture === 'number')).toBe(true);
        // the trees stay as grown (vegetation is never textured), and the summary offers the clay view
        expect(final.layers.find((l: any) => l.layer === 'l5').textured).toBeUndefined();
        expect(result.summary).toContain('Show clay');
    });

    it('a clay request stays clay: the choice survives the later commits, and no twin is engaged; textured engages the district twin', async () => {
        const s = setup(PARK);
        await runStagedLocation({ query: 'Central Park', isolate: false, radiusM: 60, trees: false }, s.deps, s.ctx);
        const scenes = s.events.filter(x => x.artifact).map(x => (x.artifact as any).data);
        // the server never picks the mode: it leaves it to the viewer (textured by default, clay on request)
        expect(scenes.every(d => d.stagedBuild.materialMode === undefined)).toBe(true);
        // the user asks for clay on the first scene; every later commit of the run keeps it
        const chosen = withStagedMaterialMode(scenes[0], 'clay') as any;
        const last = carryStagedChoice(chosen, scenes[scenes.length - 1]) as any;
        expect(last.stagedBuild.materialMode).toBe('clay');
        expect(last.renderMode).toBe('clay');
        expect(last.stagedBuild.layers.some((l: any) => l.layer === 'l2' && l.textured)).toBe(true);
        // clay: no twin is engaged; textured: the district remesh's twin is
        expect(deriveMaterialLayers(last.stagedBuild, nextSwitch(INITIAL_SWITCH, 'clay'), new Map()).twins).toEqual([]);
        const textured = deriveMaterialLayers(last.stagedBuild, nextSwitch(INITIAL_SWITCH, 'textured'), new Map());
        expect(textured.twins.map(l => l.layer)).toEqual(['l2']);
    });

    it('the tile_refine twin labels the triangles without a photo as clay, by area', async () => {
        const dir = path.join(TMP, 'twin');
        fs.mkdirSync(dir, { recursive: true });
        const file = writeTris(path.join(dir, 'tex.glb'), building(0, 10, 0, 10, 10));
        const bare = await tileRefineTwin(fs.readFileSync(file), 'l2');
        expect(bare.rungShares[TEXTURE_RUNG_CLAY]).toBeCloseTo(1, 6);
        expect(bare.provenance).toEqual([expect.objectContaining({ source: 'clay', coverage: 1 })]);
    });
});
