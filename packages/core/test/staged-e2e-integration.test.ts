/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The merged staged build, end to end on real Google 3D Tiles data (the arch isolated, Central Park as a district), with
 * the REAL native engines (scan fitter, tile_refine, tile_vegetation) in a fresh workspace and only the network and the
 * billed calls replaced: geocoding, the tile download (cut from the r250 extraction the earlier real runs left), the
 * vision model and Street View. Records every StageEvent with its time, renders each committed stage and the provenance
 * view in the real viewport (headless Chrome WebGL), runs a second time for the warm timings, and forces a failure at
 * each stage to confirm the degrade rung. Screenshots: test-results/screenshots/staged/e2e_*.png.
 */

import { afterAll, describe, expect, it } from 'vitest';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { runStagedLocation, type StagedExtraction, type StagedLocationDeps } from '../src/node/3d-engine/staged-location/orchestrator';
import { StageCache } from '../src/node/3d-engine/staged-location/stage-cache';
import { writeStagedGlbFile } from '../src/node/3d-engine/staged-location/staged-glb-writer';
import { readGlbScene } from '../src/node/spatial/StreetViewPoseRegistrar';
import { getScanFitService } from '../src/node/3d-engine/scan-fit-service';
import { getTileRefineService } from '../src/node/3d-engine/tile-refine-service';
import { getTileVegetationService } from '../src/node/3d-engine/tile-vegetation-service';
import type { StageEvent } from '../src/common/spatial/staged-location-contracts';
import type { CanvasArtifact } from '../src/browser/generative-canvas/canvas-types';
import { archRealData, centralParkRealData, STAGED_RESULTS_DIR } from './helpers/staged-real-data';
import { openStagedPage, stagedChrome, type StagedPage } from './helpers/staged-build-chrome';
import { stagedSceneData } from './helpers/staged-build-scene';
import { REPO_ROOT } from './helpers/requirements';

const WORK = path.join(REPO_ROOT, 'test-results', 'staged-e2e');
fs.mkdirSync(WORK, { recursive: true });
fs.mkdirSync(STAGED_RESULTS_DIR, { recursive: true });
const arch = archRealData();
const cp = centralParkRealData();

interface Recorded { tMs: number; e: StageEvent; artifact?: CanvasArtifact }
interface Run { events: Recorded[]; result: any; wallMs: number }

async function record(request: any, deps: StagedLocationDeps): Promise<Run> {
    const events: Recorded[] = [];
    const t0 = Date.now();
    const { result } = await runStagedLocation(request, deps, { emitStage: (e, artifact) => events.push({ tMs: Date.now() - t0, e, artifact }) });
    return { events, result, wallMs: Date.now() - t0 };
}

function table(label: string, run: Run): string {
    const rows = run.result.stages.map((s: any) => `${String(s.stage).padEnd(10)} ${String(s.status).padEnd(10)} ${String(s.timings?.ms ?? '-').padStart(8)} ms ${s.timings?.cached ? 'cached' : 'built '}${s.reason ? '  ' + s.reason : ''}`);
    return `[e2e ${label}] wall ${run.wallMs} ms, status ${run.result.status}\n  ${rows.join('\n  ')}`;
}

function saveRun(label: string, run: Run): void {
    const slim = run.events.map(r => ({ tMs: r.tMs, seq: r.e.seq, stage: r.e.stage, status: r.e.status, message: r.e.message, layers: r.e.layers?.map(l => ({ id: l.objectId, layer: l.layer, label: l.provenance.label, counts: l.counts, cached: l.cached })), degradations: r.e.degradations.map(d => d.reasonCode), ms: r.e.timings.ms, cached: r.e.timings.cached }));
    fs.writeFileSync(path.join(STAGED_RESULTS_DIR, `e2e_${label}_events.json`), JSON.stringify({ wallMs: run.wallMs, status: run.result.status, stages: run.result.stages, degradations: run.result.degradations, events: slim }, null, 2));
}

/** The textured extraction's leaves that touch the circle of `radiusM` around the anchor (the crawler takes whole leaves); photos and materials untouched. */
function cropLeaves(src: string, dest: string, radiusM: number): number {
    const buf = fs.readFileSync(src);
    const jl = buf.readUInt32LE(12);
    const json = JSON.parse(buf.toString('utf8', 20, 20 + jl));
    const rest = buf.subarray(20 + jl); // the BIN chunk header and data, unchanged
    const root = json.nodes[json.scenes[json.scene ?? 0].nodes[0]];
    let kept = 0;
    void root;
    for (const node of json.nodes as any[]) {
        if (node.mesh === undefined) continue;
        const t = node.translation ?? [0, 0, 0];
        const acc = json.accessors[json.meshes[node.mesh].primitives[0].attributes.POSITION];
        const dx = Math.max(acc.min[0] + t[0], Math.min(0, acc.max[0] + t[0])), dz = Math.max(acc.min[2] + t[2], Math.min(0, acc.max[2] + t[2]));
        if (Math.hypot(dx, dz) <= radiusM) kept++;
        else delete node.mesh; // the leaf is not in this extraction (its bytes stay in the file, unreferenced)
    }
    const text = Buffer.from(JSON.stringify(json));
    const pad = (4 - (text.length % 4)) % 4;
    const jsonChunk = Buffer.concat([text, Buffer.alloc(pad, 0x20)]);
    const head = Buffer.alloc(20);
    head.write('glTF', 0); head.writeUInt32LE(2, 4); head.writeUInt32LE(12 + 8 + jsonChunk.length + rest.length, 8);
    head.writeUInt32LE(jsonChunk.length, 12); head.write('JSON', 16);
    fs.writeFileSync(dest, Buffer.concat([head, jsonChunk, rest]));
    return kept;
}

/**
 * The real tiles standing in for the download: the leaves of the r250 extraction the earlier real runs left, cut to the
 * radius the run asks for, photo texture intact (so the canopy classifier and the orthos have their input).
 */
function standInExtract(texturedSrc: string, anchor: { lat: number; lng: number }, wide = false): StagedLocationDeps['extract'] {
    return async req => {
        // wide: the whole r250 extraction whatever the request (a different isolate: the neighbours of the structure are all there)
        if (wide) req = { ...req, radiusM: 250 };
        if (req.radiusM > 250) throw new Error(`the stand-in extraction covers 250 m, not ${req.radiusM} m`);
        const textured = path.join(req.outDir, 'textured.glb'), geometry = path.join(req.outDir, 'geometry.glb');
        const n = cropLeaves(texturedSrc, textured, req.radiusM);
        const prims = readGlbScene(textured);
        writeStagedGlbFile(geometry, prims.map((p, i) => ({ name: `tile_${i}`, positions: p.positions, indices: p.indices })));
        const ids = Array.from({ length: n }, (_, i) => `leaf-${i}`);
        return {
            texturedGlb: textured, geometryGlb: geometry, downloadOrder: Object.fromEntries(ids.map((id, i) => [id, i])), leafIds: ids, copyrights: ['Google'],
            fetchedAt: '2026-10-15T12:00:00.000Z', radiusM: req.radiusM, coveredRadiusM: req.radiusM, truncated: false, leafTiles: n,
            leafGeometricErrorM: 2.0064, originEllipsoidalHeightM: -23.5, geoAnchor: anchor
        } as StagedExtraction;
    };
}

/** Vision fake: places one roundel on the first slot the prompt offers, citing the first image. No model is called. */
function fakeVision(calls: any[]): NonNullable<StagedLocationDeps['vision']> {
    const client = {
        models: {
            generateContent: async () => { throw new Error('streaming expected'); },
            generateContentStream: async (params: any) => {
                calls.push(params.model);
                const text = JSON.stringify(params.contents).match(/\bS\d\d\b/)?.[0] ?? 'S01';
                const reply = { elements: [{ slot: text, op: { revolve: { at: [5000, 15000], axis: 'n', profile: [0, 0, 900, 0, 900, 120, 0, 180] } }, conf: 62, depthBasis: 'rim highlight', ev: [[0, 300, 120, 470, 260]] }], corrections: [], emptySlots: [] };
                return (async function* () { yield { candidates: [{ content: { parts: [{ text: JSON.stringify(reply) }] }, finishReason: 'STOP' }], modelVersion: `${params.model}-001` } as any; })();
            }
        }
    };
    return { client: client as never, candidates: ['gemini-4-argon'] };
}

/** Street View fake: Google captures a few tens of metres out on each side of the arch; images come back in memory only. */
function fakeStreetView(requested: string[]): StagedLocationDeps['streetView'] {
    // a Google capture wherever the selection looks (the real streets of the arch are not known offline): each metadata
    // query is answered with a pano at the queried point, so the REAL selection, occlusion test and view geometry decide
    const fetchImpl = (async (url: string) => {
        const [lat, lng] = new URL(url).searchParams.get('location')!.split(',').map(Number);
        const body = { status: 'OK', pano_id: `PANO_${lat.toFixed(5)}_${lng.toFixed(5)}`, location: { lat, lng }, date: '2025-06', copyright: '© Google' };
        return { ok: true, status: 200, statusText: 'OK', json: async () => body } as any;
    }) as typeof fetch;
    const grounding = {
        retrieveGroundingImage: async (req: any) => {
            requested.push(req.panoId);
            const portrait = req.aspectRatio === 'RATIO_3X4';
            const w = portrait ? 480 : 640, h = portrait ? 640 : 480;
            const image = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, h >> 8, h & 255, w >> 8, w & 255, 0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01]), crypto.createHash('sha512').update(`${req.panoId}|${req.headingDegree}|${req.pitchDegree}|${req.fovDegree}`).digest(), Buffer.from([0xff, 0xd9])]);
            return { image, mimeType: 'image/jpeg', panoId: req.panoId, headingDegree: req.headingDegree, pitchDegree: req.pitchDegree, fovDegree: req.fovDegree };
        }
    };
    return { mapsApiKey: 'maps-key', grounding, fetchImpl } as never;
}

interface Over { fitFails?: boolean; ornamentFails?: boolean; remeshFails?: boolean; plantFails?: boolean; stripFails?: boolean }
function realDeps(root: string, kind: 'arch' | 'park', over: Over = {}, sv: string[] = [], visionCalls: any[] = [], wide = false): StagedLocationDeps {
    const real = kind === 'arch' ? arch.data! : cp.data!;
    const anchor = kind === 'arch' ? { lat: 40.73122, lng: -73.99709 } : { lat: 40.78256, lng: -73.96558 };
    const fit = getScanFitService(root);
    const refine = getTileRefineService(root);
    const veg = getTileVegetationService(root);
    const boom = (what: string) => async (): Promise<never> => { throw new Error(`forced failure: ${what}`); };
    return {
        cache: new StageCache({ workspaceRoot: root }),
        geocode: async () => ({ ...anchor, formattedAddress: kind === 'arch' ? 'Washington Square Arch, Washington Square N, New York, NY' : 'Central Park, New York, NY, USA' }),
        extract: standInExtract(real.textured, anchor, wide),
        vegetation: {
            strip: over.stripFails ? boom('strip') as never : req => veg.strip(req),
            plant: over.plantFails ? boom('plant') as never : req => veg.plant(req),
            canopy: (req: any) => (veg as any).canopy(req)
        },
        refine: { refine: over.remeshFails ? boom('tile_refine') as never : req => refine.refine(req) },
        scanFit: {
            fit: over.fitFails ? boom('scan_fit fit') as never : req => fit.fit(req),
            refit: req => fit.refit(req),
            ornament: over.ornamentFails ? boom('scan_fit ornament') as never : req => fit.ornament(req),
            flatten: req => fit.flatten(req)
        },
        streetView: fakeStreetView(sv),
        vision: fakeVision(visionCalls),
        newRunId: () => crypto.randomBytes(4).toString('hex')
    };
}

const STEP = 16;
async function advanceTo(page: StagedPage, id: string, p: number): Promise<void> {
    for (let i = 0; i < 1200; i++) {
        const f = await page.eval<{ phase: string; progress: number } | null>(`sbHarness.layer(${JSON.stringify(id)})`);
        if (f && (f.phase === 'revealed' || (f.phase === 'revealing' && f.progress >= p))) return;
        await page.step(1, STEP);
    }
    throw new Error(`${id} never reached ${p}`);
}

/** Replays the committed states of a run into the real viewport, in build order, one screenshot per state, then the provenance view. */
async function render(label: string, root: string, run: Run): Promise<string[]> {
    const shots: string[] = [];
    const page = await openStagedPage({ manualFrames: true });
    try {
        const served = new Set<string>();
        const serveAll = (state: any) => {
            for (const l of state.layers) {
                const name = path.basename(l.url);
                if (served.has(name)) continue;
                const file = path.join(root, 'public', 'models', name);
                if (!fs.existsSync(file)) throw new Error(`layer file missing: ${file}`);
                page.serve(name, fs.readFileSync(file));
                served.add(name);
            }
        };
        const states = run.events.filter(r => r.artifact && (r.artifact as any).data?.stagedBuild);
        expect(states.length, 'at least one committed state with an artifact').toBeGreaterThan(0);
        let mounted = false, last: any;
        const seen = new Set<string>();
        for (const r of states) {
            const state = (r.artifact as any).data.stagedBuild;
            const camera = (r.artifact as any).data.camera;
            serveAll(state);
            const data = stagedSceneData(state, { camera });
            if (!mounted) {
                await page.eval(`sbHarness.mount(${JSON.stringify({ ...data, objects: [] })})`);
                await page.waitFor('sbHarness.ready()');
                await page.step(6, STEP);
                mounted = true;
            }
            await page.eval(`sbHarness.update(${JSON.stringify(data)})`);
            const fresh = state.layers.filter((l: any) => !l.retired && !seen.has(l.objectId));
            for (const l of fresh) { await page.waitFor(`sbHarness.attached(${JSON.stringify(l.objectId)})`, 60_000); seen.add(l.objectId); }
            for (const l of fresh) await advanceTo(page, l.objectId, 1);
            await page.step(4, STEP);
            const name = `e2e_${label}_${String(r.e.seq).padStart(2, '0')}_${r.e.stage}_${r.e.status}`;
            await page.screenshot(name);
            shots.push(name);
            last = state;
        }
        await page.eval(`sbHarness.click('[data-testid="sb-staged-provenance-toggle"]')`);
        await page.step(4, STEP);
        const name = `e2e_${label}_provenance`;
        await page.screenshot(name);
        shots.push(name);
        const legend = await page.eval<string>(`sbHarness.text('[data-testid="sb-staged-legend"]')`);
        fs.writeFileSync(path.join(STAGED_RESULTS_DIR, `e2e_${label}_legend.txt`), legend);
        expect(legend.length).toBeGreaterThan(0);
        void last;
        expect(page.consoleErrors().filter(m => !/favicon/i.test(m))).toEqual([]);
    } finally { await page.close(); }
    return shots;
}

/**
 * Frame time of the finished scene in the real viewport on a real clock (not stepped): the committed layers of the run
 * mounted whole, the reveal allowed to finish, then the frames the viewport draws over a few seconds. The park carries
 * about 1.4 M triangles of tree, remesh and ground; a viewport that cannot hold it shows here and not in a screenshot.
 */
async function measureFrames(label: string, root: string, run: Run, ms = 3000): Promise<{ frames: number; p50: number; p95: number; max: number; trianglesDrawn: number; layerTriangles: number }> {
    const page = await openStagedPage({ manualFrames: false, width: 1280, height: 800 });
    try {
        const art = run.result.artifact as any;
        const state = art.data.stagedBuild;
        const live = (state.layers as any[]).filter(l => !l.retired);
        for (const l of live) {
            const file = path.join(root, 'public', 'models', path.basename(l.url));
            if (!fs.existsSync(file)) throw new Error(`layer file missing: ${file}`);
            page.serve(path.basename(l.url), fs.readFileSync(file));
        }
        const data = stagedSceneData(state, { camera: art.data.camera });
        await page.eval(`sbHarness.mount(${JSON.stringify({ ...data, objects: [] })})`);
        await page.waitFor('sbHarness.ready()');
        await page.eval(`sbHarness.update(${JSON.stringify(data)})`);
        for (const l of live) await page.waitFor(`sbHarness.attached(${JSON.stringify(l.objectId)})`, 120_000, l.objectId);
        // the reveal runs on the real clock: wait for it to end, so the frames below are the scene at rest
        await new Promise(r => setTimeout(r, 4000));
        await page.eval('sbHarness.startFrameLog()');
        await new Promise(r => setTimeout(r, ms));
        const log = await page.eval<{ times: number[]; triangles: number[] }>('sbHarness.stopFrameLog()');
        const dts = log.times.slice(1).map((t, i) => t - log.times[i]).sort((a, b) => a - b);
        const at = (q: number) => dts[Math.min(dts.length - 1, Math.floor(q * (dts.length - 1)))];
        const out = {
            frames: dts.length, p50: +at(0.5).toFixed(1), p95: +at(0.95).toFixed(1), max: +dts[dts.length - 1].toFixed(1),
            trianglesDrawn: Math.max(0, ...log.triangles), layerTriangles: live.reduce((a, l) => a + l.counts.triangles, 0)
        };
        fs.writeFileSync(path.join(STAGED_RESULTS_DIR, `e2e_${label}_frames.json`), JSON.stringify(out, null, 2));
        await page.screenshot(`e2e_${label}_frametime_scene`);
        return out;
    } finally { await page.close(); }
}

const fresh = (name: string) => { const root = path.join(WORK, name); fs.rmSync(root, { recursive: true, force: true }); fs.mkdirSync(root, { recursive: true }); return root; };
const degraded = (run: Run, stage: string) => run.result.degradations.filter((d: any) => d.stage === stage);
const layerLabels = (run: Run) => (run.result.artifact.data.stagedBuild.layers as any[]).filter(l => !l.retired).map(l => `${l.layer}:${l.provenance.label}`);

describe.skipIf(!arch.requirement.ok || !stagedChrome.ok)('staged build end to end: the Washington Square Arch, isolated (real engines, injected vision and Street View)', () => {
    const root = fresh('arch');
    const shots: string[] = [];
    let cold: Run;

    it('cold: every stage runs for real and every committed state renders in the viewport', async () => {
        const sv: string[] = [], vc: any[] = [];
        cold = await record({ query: 'Washington Square Arch', isolate: true, trees: false }, realDeps(root, 'arch', {}, sv, vc));
        console.log(table('arch cold', cold));
        console.log(`[e2e arch cold] layers ${layerLabels(cold).join(', ')}; degradations ${cold.result.degradations.map((d: any) => `${d.stage}/${d.reasonCode}`).join(', ') || 'none'}; vision calls ${vc.length}; street view panos ${sv.length}`);
        saveRun('arch_cold', cold);
        expect(cold.result.stages.find((s: any) => s.stage === 'tiles').status).toBe('committed');
        expect(cold.result.stages.find((s: any) => s.stage === 'remesh').status).toBe('committed');
        expect(cold.result.artifact.data.stagedBuild.layers.length).toBeGreaterThanOrEqual(2);
        shots.push(...await render('arch', root, cold));
    }, 900_000);

    it('wide extraction (the whole r250 tile around the arch): a different isolate, the fit is accepted and the rest of the ladder runs', async () => {
        const wideRoot = fresh('arch_wide');
        const sv: string[] = [], vc: any[] = [];
        const wide = await record({ query: 'Washington Square Arch', isolate: true, trees: false }, realDeps(wideRoot, 'arch', {}, sv, vc, true));
        console.log(table('arch wide', wide));
        saveRun('arch_wide', wide);
        expect(wide.result.stages.find((s: any) => s.stage === 'remesh').status).toBe('committed');
        // a detail stage whose every element was dropped commits no photo-inferred layer: an empty one would claim detail that is not there
        const l4 = (wide.result.artifact.data.stagedBuild.layers as any[]).filter(l => l.layer === 'l4');
        for (const l of l4) expect(l.counts.triangles, 'a committed photo-inferred layer has geometry').toBeGreaterThan(0);
        await render('arch_wide', wideRoot, wide);
    }, 900_000);

    it('warm: the same request serves every built stage from cache', async () => {
        const warm = await record({ query: 'Washington Square Arch', isolate: true, trees: false }, realDeps(root, 'arch'));
        console.log(table('arch warm', warm));
        saveRun('arch_warm', warm);
        // Street View bytes are never written to disk, so the evidence and its projection are fetched again by design; every
        // stage that builds geometry or reads the evidence comes from cache (the same bytes give the same vision key)
        const fetchedAgain = new Set(['evidence', 'project']);
        const built = warm.result.stages.filter((s: any) => s.status === 'committed' && !s.timings?.cached && !fetchedAgain.has(s.stage)).map((s: any) => s.stage);
        expect(built, 'stages that were rebuilt on the warm run').toEqual([]);
        expect(warm.wallMs).toBeLessThan(cold.wallMs);
        expect(layerLabels(warm)).toEqual(layerLabels(cold));
    }, 900_000);

    it('forced failures: remesh -> as scanned; fit -> remesh only; detail -> flat fitted face; each is listed with its reason', async () => {
        const remesh = await record({ query: 'Washington Square Arch', isolate: true, trees: false }, realDeps(fresh('arch_f_remesh'), 'arch', { remeshFails: true }));
        saveRun('arch_fail_remesh', remesh);
        console.log(table('arch fail remesh', remesh));
        expect(remesh.result.status).toBe('degraded');
        const rf = degraded(remesh, 'remesh').find((d: any) => d.reasonCode === 'remesh_failed');
        expect(rf, JSON.stringify(degraded(remesh, 'remesh').map((d: any) => d.reasonCode))).toBeDefined();
        expect(rf.reason).toContain('forced failure: tile_refine');
        // the rung below a failed remesh is the raw scan with facades flattened; as downloaded only if that fails too
        expect(['scan-flattened', 'as-scanned']).toContain(rf.provenanceAfter);
        expect(layerLabels(remesh).filter(l => l.startsWith('l2')).concat(layerLabels(remesh).filter(l => l === 'l1:as-scanned'))).toContain(rf.provenanceAfter === 'scan-flattened' ? 'l2:scan-flattened' : 'l1:as-scanned');

        const fit = await record({ query: 'Washington Square Arch', isolate: true, trees: false }, realDeps(fresh('arch_f_fit'), 'arch', { fitFails: true }));
        saveRun('arch_fail_fit', fit);
        console.log(table('arch fail fit', fit));
        expect(fit.result.status).toBe('degraded');
        expect(fit.result.degradations.map((d: any) => d.stage)).toContain('fit');
        expect(fit.result.degradations.find((d: any) => d.stage === 'fit').reason).toContain('forced failure: scan_fit fit');
        expect(fit.result.stages.find((s: any) => s.stage === 'remesh').status, 'the remesh stays committed when the fit fails').toBe('committed');
        expect(layerLabels(fit)).toContain('l2:remeshed');

        const detail = await record({ query: 'Washington Square Arch', isolate: true, trees: false }, realDeps(fresh('arch_f_detail'), 'arch', { ornamentFails: true }, [], [], true));
        saveRun('arch_fail_detail', detail);
        console.log(table('arch fail detail', detail));
        console.log(`[e2e arch fail detail] ${detail.result.degradations.map((d: any) => `${d.stage}/${d.reasonCode}: ${d.reason}`).join(' | ')}`);
        expect(detail.result.stages.find((s: any) => s.stage === 'remesh').status).toBe('committed');
        // on the whole tile the fit is accepted, so the failure is the ornament build's: the fitted faces stay flat and it says why
        expect(detail.result.stages.find((s: any) => s.stage === 'fit').status).toBe('committed');
        expect(detail.result.degradations.some((d: any) => d.stage === 'detail' && d.provenanceAfter === 'fitted' && /forced failure: scan_fit ornament/.test(d.reason))).toBe(true);
        expect((detail.result.artifact.data.stagedBuild.layers as any[]).some(l => l.layer === 'l4')).toBe(false);
    }, 1_800_000);
});

describe.skipIf(!cp.requirement.ok || !cp.data?.plant || !stagedChrome.ok)('staged build end to end: Central Park, a district (real engines, trees regrown from the measured crowns)', () => {
    const root = fresh('park');
    let cold: Run;

    it('cold: tiles, remesh and trees run for real and render in build order', async () => {
        cold = await record({ query: 'Central Park', isolate: false, radiusM: 250, trees: true }, realDeps(root, 'park'));
        console.log(table('park cold', cold));
        console.log(`[e2e park cold] layers ${layerLabels(cold).join(', ')}; degradations ${cold.result.degradations.map((d: any) => `${d.stage}/${d.reasonCode}`).join(', ') || 'none'}`);
        saveRun('park_cold', cold);
        expect(cold.result.stages.find((s: any) => s.stage === 'tiles').status).toBe('committed');
        await render('park', root, cold);
        // the finished park (trees, remesh, ground) on a real clock: the viewport holds it, in frames
        const f = await measureFrames('park', root, cold);
        console.log(`[e2e park frames] ${f.layerTriangles.toLocaleString('en-US')} layer triangles, ${f.trianglesDrawn.toLocaleString('en-US')} drawn; ${f.frames} frames, p50 ${f.p50} ms, p95 ${f.p95} ms, max ${f.max} ms`);
        expect(f.frames).toBeGreaterThan(20);
        expect(f.trianglesDrawn).toBeGreaterThan(0);
        expect(f.p50).toBeLessThan(40);
        expect(f.p95).toBeLessThan(100);
    }, 1_800_000);

    it('warm: every built stage comes from cache', async () => {
        const warm = await record({ query: 'Central Park', isolate: false, radiusM: 250, trees: true }, realDeps(root, 'park'));
        console.log(table('park warm', warm));
        saveRun('park_warm', warm);
        expect(warm.result.stages.filter((s: any) => s.status === 'committed' && !s.timings?.cached).map((s: any) => s.stage)).toEqual([]);
        expect(layerLabels(warm)).toEqual(layerLabels(cold));
    }, 900_000);

    it('forced failures: a failed tree stage puts the scanned trees back, labelled as scanned; a failed remesh keeps the scan', async () => {
        const trees = await record({ query: 'Central Park', isolate: false, radiusM: 250, trees: true }, realDeps(fresh('park_f_trees'), 'park', { plantFails: true }));
        saveRun('park_fail_trees', trees);
        console.log(table('park fail trees', trees));
        console.log(`[e2e park fail trees] layers ${layerLabels(trees).join(', ')}; ${trees.result.degradations.map((d: any) => `${d.stage}/${d.reasonCode}/${d.provenanceAfter}: ${d.reason}`).join(' | ')}`);
        expect(trees.result.status).toBe('degraded');
        expect(trees.result.degradations.some((d: any) => d.stage === 'trees' && /forced failure: plant/.test(d.reason))).toBe(true);
        expect(layerLabels(trees).join(' ')).toContain('as-scanned');
        await render('park_fail_trees', path.join(WORK, 'park_f_trees'), trees);

        const remesh = await record({ query: 'Central Park', isolate: false, radiusM: 250, trees: true }, realDeps(fresh('park_f_remesh'), 'park', { remeshFails: true }));
        saveRun('park_fail_remesh', remesh);
        console.log(table('park fail remesh', remesh));
        expect(remesh.result.status).toBe('degraded');
        // the rung below a failed remesh is the flattened raw scan; when that fails too (a 683,000-triangle district can outrun the fitter's time limit) it is the raw scan as downloaded: both are listed
        const reasons = degraded(remesh, 'remesh').map((d: any) => d.reasonCode);
        expect(reasons).toContain('remesh_failed');
        expect(degraded(remesh, 'remesh').find((d: any) => d.reasonCode === 'remesh_failed').reason).toContain('forced failure: tile_refine');
        expect(layerLabels(remesh).join(' ')).toMatch(/as-scanned|scan-flattened/);
        expect(remesh.result.stages.find((s: any) => s.stage === 'trees').status).toBe('skipped');
    }, 3_600_000);
});

afterAll(() => undefined);
