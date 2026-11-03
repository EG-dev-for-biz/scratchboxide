/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Pipeline K-D with the centre in the cloud (SCRATCHBOX_KD_CHUNK_RUNNER=cloud; kdCentreRunner): the build here reads no
 * tiles, its own stages are skipped with the reason, the centre cell is one more chunk job carrying the hero's address,
 * every chunk is placed in the centre job's frame, the vector paint is cut back as the chunks join, and the result is
 * finished on the centre job's scan. The chunk jobs are stand-ins that write real GLBs; nothing reaches the cloud.
 */

import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { runStagedLocation, type StagedLocationDeps, type StagedLocationOutcome, type StagedLocationRequest } from '../src/node/3d-engine/staged-location/orchestrator';
import { StageCache } from '../src/node/3d-engine/staged-location/stage-cache';
import { writeStagedGlbFile } from '../src/node/3d-engine/staged-location/staged-glb-writer';
import { kdCentreRunner } from '../src/node/3d-engine/staged-location/pipeline-k/district-chunks';
import { nodeWorldMatrices, parseGlbBytes, readAccessor, transformPoint } from '../src/node/3d-engine/staged-location/glb-bytes';
import { fakeNative, type WorldSpec } from './helpers/staged-synthetic-world';
import type { StageEvent } from '../src/common/spatial/staged-location-contracts';

const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sbx-kd-centre-cloud-')));
afterAll(() => fs.rmSync(TMP, { recursive: true, force: true }));
afterEach(() => vi.unstubAllEnvs());

const WORLD: WorldSpec = { ground: 80, buildings: [[-10, 10, -10, 10, 20]], trees: [] };
const ADDRESS = '2 Penn Plaza, New York, NY';
/** One building in each of five cells of the 150 m district's 3 x 3 grid (the centre cell is index 4). */
const square = (cx: number, cz: number) => [[[cx - 8, cz - 8], [cx + 8, cz - 8], [cx + 8, cz + 8], [cx - 8, cz + 8]]] as [number, number][][];
const EVIDENCE = { buildings: [[0, 0], [120, 0], [-120, 0], [0, 120], [0, -120]].map(([x, z], i) => ({ id: `b${i}`, parts: [square(x, z)], heightM: 15, extruded: [{ loops: square(x, z), heightM: 15 }] })), water: [], roads: [], tiles: 1, zoom: 17 };

/** A chunk job: its ground over its rectangle (in its own frame, at y 0), as a cloud job's outcome reads once downloaded. */
function chunkJob(cache: StageCache, req: StagedLocationRequest, originEllipsoidalHeightM: number): StagedLocationOutcome {
    const i = req.chunk!.index, r = req.chunk!.rect!;
    const pos: number[] = [];
    for (let x = Math.floor(r.x0); x < Math.ceil(r.x1); x += 4) for (let z = Math.floor(r.z0); z < Math.ceil(r.z1); z += 4) pos.push(x, 0, z, x + 4, 0, z, x + 4, 0, z + 4, x, 0, z, x + 4, 0, z + 4, x, 0, z + 4);
    fs.mkdirSync(cache.modelsDir, { recursive: true });
    const file = path.join(cache.modelsDir, `ground_c${i}.glb`);
    writeStagedGlbFile(file, [{ name: 'ground', positions: Float32Array.from(pos), indices: Uint32Array.from({ length: pos.length / 3 }, (_, k) => k) }], {});
    const layer = {
        objectId: `stg-c${i}-l2`, stage: 'remesh', layer: 'l2', order: 2, url: `/models/ground_c${i}.glb`, bytes: fs.statSync(file).size,
        counts: { vertices: pos.length / 3, triangles: pos.length / 9 }, provenance: { label: 'remeshed', measuredGeometry: true }, provenanceLabels: ['remeshed'],
        supersedes: [], revealAfter: [], reveal: { durationMs: 300, stagger: 0, crossfadeFrom: [] }, cached: false, builtAtMs: 0
    };
    return {
        result: {
            status: 'complete', stages: [], degradations: [],
            extraction: { radiusM: req.radiusM, sizedTo: 'request', leafTiles: 40 + i, cached: false, geometricErrorM: 1.5, texelM: 0, attribution: [] },
            sourceLimits: { leafGeometricErrorM: 1.5, meshEdgeP50M: 0, meshResolvableM: 0.375, texelM: 0, photoResolvableM: 0 },
            artifact: { data: { camera: CENTRE_CAMERA, stagedBuild: { layers: [layer] } } }
        },
        compat: {
            remesh: { ok: true, url: layer.url }, resolvedAddress: req.place!.formattedAddress,
            geoAnchor: { lat: req.place!.lat, lng: req.place!.lng, elevation: 4.5, landmarkName: req.place!.formattedAddress, formattedAddress: req.place!.formattedAddress, elevationSource: 'tiles_ground' },
            frame: { lat: req.place!.lat, lng: req.place!.lng, originEllipsoidalHeightM }, glbPath: path.join(cache.modelsDir, `raw_c${i}.glb`), groundGlbPath: file
        }
    } as unknown as StagedLocationOutcome;
}

function setup(failCentre = 0, evidence: () => Promise<typeof EVIDENCE> = async () => EVIDENCE) {
    const root = fs.mkdtempSync(path.join(TMP, 'ws-'));
    const cache = new StageCache({ workspaceRoot: root });
    const native = fakeNative(path.join(root, 'native'), WORLD, {});
    const asked: StagedLocationRequest[] = [];
    let extracts = 0, centreTries = 0;
    const deps: StagedLocationDeps = {
        cache,
        geocode: async () => ({ lat: 40.750316, lng: -73.991722, formattedAddress: ADDRESS, placeId: 'p' }),
        extract: async (...a: Parameters<StagedLocationDeps['extract']>) => { extracts++; return native.deps.extract(...a); },
        vegetation: native.deps.vegetation,
        refine: native.deps.refine,
        vectorEvidence: evidence,
        newRunId: () => 'c0ffee01',
        sleep: async () => undefined,
        runChunk: async req => {
            asked.push(req);
            const centre = !req.place!.formattedAddress.includes('(chunk');
            if (centre && ++centreTries <= failCentre) throw new Error('the job ran out of memory');
            // the centre's frame 30 m up; each other chunk's own origin height a little off it
            return chunkJob(cache, req, centre ? 30 : 30 + req.chunk!.index);
        }
    };
    const events: StageEvent[] = [];
    return { root, cache, deps, asked, events, ctx: { emitStage: (e: StageEvent) => events.push(e) }, extracts: () => extracts };
}

/** Every vertex of a published GLB in its world frame. */
function vertices(cache: StageCache, url: string): number[][] {
    const g = parseGlbBytes(fs.readFileSync(path.join(cache.modelsDir, path.basename(url)))), world = nodeWorldMatrices(g.json), out: number[][] = [];
    g.json.nodes.forEach((n: any, ni: number) => {
        if (n.mesh === undefined) return;
        for (const p of g.json.meshes[n.mesh].primitives) {
            const pos = readAccessor(g, p.attributes.POSITION).data;
            for (let k = 0; k < pos.length; k += 3) out.push(transformPoint(world[ni], pos[k], pos[k + 1], pos[k + 2]));
        }
    });
    return out;
}

const CENTRE_CAMERA = { position: [120, 160, 220] as [number, number, number], target: [0, 0, 0] as [number, number, number], fov: 45 };
const REQUEST: StagedLocationRequest = { query: '2 Penn Plaza, New York', isolate: false, radiusM: 150, trees: false, district: 'kd', stageIntoActiveScene: false };

describe('pipeline K-D: the centre cell in the cloud', () => {
    it('is chosen only with the cloud runner, and SCRATCHBOX_KD_CENTRE_RUNNER=local keeps it here', () => {
        expect(kdCentreRunner({})).toBe('local');
        expect(kdCentreRunner({ SCRATCHBOX_KD_CHUNK_RUNNER: 'cloud' })).toBe('cloud');
        expect(kdCentreRunner({ SCRATCHBOX_KD_CHUNK_RUNNER: 'cloud', SCRATCHBOX_KD_CENTRE_RUNNER: 'local' })).toBe('local');
    });

    it("builds the centre as one more chunk job with the hero's address, joins every chunk in its frame and finishes on its scan", async () => {
        vi.stubEnv('SCRATCHBOX_KD_CHUNK_RUNNER', 'cloud');
        const s = setup();
        const { result, compat } = await runStagedLocation(REQUEST, s.deps, s.ctx);
        // nothing extracted here: every stage of its own skipped with the reason
        expect(s.extracts()).toBe(0);
        for (const id of ['tiles', 'vehicles', 'terrain', 'remesh', 'trees', 'textures']) {
            expect(result.stages.find(x => x.stage === id), id).toMatchObject({ status: 'skipped', reason: expect.stringMatching(/built in the cloud as one more chunk job/) });
        }
        // nine jobs: the centre (cell 4, first) with the hero's address, the eight others as chunks
        expect(s.asked).toHaveLength(9);
        expect(s.asked[0]).toMatchObject({ query: REQUEST.query, district: 'kd', place: { formattedAddress: ADDRESS }, chunk: { of: 'c0ffee01', index: 4 } });
        expect(s.asked.slice(1).every(r => /\(chunk \d+\)$/.test(r.place!.formattedAddress))).toBe(true);
        expect(result.stages.find(x => x.stage === 'chunks')).toMatchObject({ status: 'committed', source: expect.stringMatching(/9 of 9 chunks of the district, the centre among them, built in the cloud/) });
        // the scene sits in the centre job's frame, on its anchor and scan
        expect(compat.frame).toEqual({ lat: 40.750316, lng: -73.991722, originEllipsoidalHeightM: 30 });
        expect(compat.geoAnchor).toMatchObject({ elevation: 4.5, formattedAddress: ADDRESS });
        expect(compat.remesh.ok).toBe(true);
        expect(result.extraction).toMatchObject({ radiusM: s.asked[0].radiusM, leafTiles: 44, geometricErrorM: 1.5 });
        const layers = (result.artifact as any).data.stagedBuild.layers as any[];
        // the centre's ground unmoved (its frame is the district's); a chunk whose origin is 7 m higher sits 7 m up here
        const centre = layers.find(l => !l.retired && l.objectId.startsWith('stg-c4-l2'));
        const c7 = layers.find(l => !l.retired && l.objectId.startsWith('stg-c7-l2'));
        expect(Math.max(...vertices(s.cache, centre.url).map(p => Math.abs(p[1])))).toBeLessThan(1e-3);
        const y7 = vertices(s.cache, c7.url).map(p => p[1]);
        expect(Math.min(...y7)).toBeGreaterThan(6.9); expect(Math.max(...y7)).toBeLessThan(7.1);
        // the vector paint stood for the district until the chunks joined; with all nine joined it is retired
        const paint = layers.filter(l => l.layer === 'l0' && l.stage === 'vector');
        expect(paint.length).toBeGreaterThan(0);
        expect(paint.every(l => l.retired)).toBe(true);
        expect(result.status).toBe('complete');
    });

    it("frames the scene with the centre job's camera when the vector paint could not be drawn", async () => {
        vi.stubEnv('SCRATCHBOX_KD_CHUNK_RUNNER', 'cloud');
        // the plan reads the evidence first; the paint's own read then fails
        let reads = 0;
        const s = setup(0, async () => { if (++reads > 1) throw new Error('vectortiles: 503'); return EVIDENCE; });
        const { result } = await runStagedLocation(REQUEST, s.deps, s.ctx);
        expect(result.stages.find(x => x.stage === 'vector')).toMatchObject({ status: 'degraded' });
        expect((result.artifact as any).data.camera).toEqual(CENTRE_CAMERA);
        // one visible ground per chunk (the seam stage's grounds superseding the joined ones)
        const layers = (result.artifact as any).data.stagedBuild.layers as any[];
        const hidden = new Set(layers.filter(l => !l.retired).flatMap(l => l.supersedes));
        expect(layers.filter(l => !l.retired && !hidden.has(l.objectId) && l.layer === 'l2')).toHaveLength(9);
    });

    it('builds a failed centre again at once, and with it failed twice places the district on the first chunk joined', async () => {
        vi.stubEnv('SCRATCHBOX_KD_CHUNK_RUNNER', 'cloud');
        const once = setup(1);
        const first = await runStagedLocation(REQUEST, once.deps, once.ctx);
        expect(once.asked.filter(r => r.chunk!.index === 4)).toHaveLength(2);
        expect(first.compat.frame!.originEllipsoidalHeightM).toBe(30);
        expect(first.result.status).toBe('complete');

        const twice = setup(2);
        const { result, compat } = await runStagedLocation(REQUEST, twice.deps, twice.ctx);
        expect(twice.asked.filter(r => r.chunk!.index === 4)).toHaveLength(2);
        expect(result.degradations.find(d => d.reasonCode === 'chunk_failed')).toMatchObject({ reason: expect.stringMatching(/chunk 4 could not be built \(the job ran out of memory\)/) });
        expect(result.stages.find(x => x.stage === 'chunks')).toMatchObject({ status: 'degraded' });
        // the frame and the scan of a chunk that did join, at the place
        expect(compat.frame).toMatchObject({ lat: 40.750316, lng: -73.991722 });
        expect(compat.frame!.originEllipsoidalHeightM).toBeGreaterThan(30);
        expect(result.status).toBe('degraded');
    });

    it('without the cloud runner the centre is built here, as before', async () => {
        const s = setup();
        await runStagedLocation(REQUEST, s.deps, s.ctx);
        expect(s.extracts()).toBeGreaterThan(0);
        expect(s.asked.every(r => /\(chunk \d+\)$/.test(r.place!.formattedAddress))).toBe(true);
        expect(s.asked.some(r => r.chunk!.index === 4)).toBe(false);
    });
});
