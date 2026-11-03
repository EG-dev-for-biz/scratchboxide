/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The staged build on real Google 3D Tiles data, offline (no billed call, no network): the Washington Square Arch
 * isolated, and Central Park as a district. The tiles, strip's entries, tile_refine's outputs and plant's trees are the
 * files earlier real runs left (gitignored; the suites skip with a reason when they are absent). They are served to the
 * orchestrator exactly as the native stages returned them, so what is tested is the orchestrator, the structure pick, the
 * layers it commits and the summary it writes on real shapes of data, not the native engines (their own suites do that).
 *
 * Two stand-ins, said here and nowhere hidden:
 *  - the request-sized extraction is cut from the r250 extraction (whole primitives touching the circle, as the crawler
 *    takes whole leaves), because the leaf cache holds none of the arch's leaves;
 *  - tile_vegetation's canopy classifier is not in this build: its mask is rasterised from the real strip run's crown
 *    footprints (the regions that classifier is run to find).
 */

import { describe, it, expect, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { runStagedLocation, type StagedExtraction, type StagedLocationDeps } from '../src/node/3d-engine/staged-location/orchestrator';
import { StageCache, stageKey } from '../src/node/3d-engine/staged-location/stage-cache';
import { writeStagedGlbFile } from '../src/node/3d-engine/staged-location/staged-glb-writer';
import { buildGroundModel, loadScanMesh } from '../src/node/spatial/StreetViewSurveyPlanner';
import { readGlbScene } from '../src/node/spatial/StreetViewPoseRegistrar';
import { canopyLookup, checkIsolate, maskCanopy, pickStructure, touchesEdge } from '../src/node/3d-engine/staged-location/extraction-sizing';
import { readRemeshProvenance } from '../src/node/3d-engine/staged-location/remesh-provenance';
import { validateContract, type CanopyMask, type StageEvent } from '../src/common/spatial/staged-location-contracts';
import type { CanvasArtifact } from '../src/browser/generative-canvas/canvas-types';
import { readGlbTriangles, renderClayPng } from './helpers/clay-glb-render';
import { withReason } from './helpers/requirements';
import { archRealData, centralParkRealData, STAGED_SCREENSHOT_DIR } from './helpers/staged-real-data';

const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sbx-staged-real-')));
afterAll(() => fs.rmSync(TMP, { recursive: true, force: true }));

const readJson = (file: string): any => JSON.parse(fs.readFileSync(file, 'utf8'));
const clone = (src: string, dest: string) => fs.copyFileSync(src, dest, fs.constants.COPYFILE_FICLONE);

/** The extraction's primitives as a geometry-only GLB: one node per primitive, the same triangles. */
function writeGeometryOnly(prims: ReturnType<typeof readGlbScene>, file: string): void {
    writeStagedGlbFile(file, prims.map((p, i) => ({ name: `tile_${i}`, positions: p.positions, indices: p.indices })));
}

interface Stands {
    events: Array<{ e: StageEvent; artifact?: CanvasArtifact }>;
    ctx: { emitStage: (e: StageEvent, artifact?: CanvasArtifact) => void };
}
function stands(): Stands {
    const events: Stands['events'] = [];
    return { events, ctx: { emitStage: (e, artifact) => events.push({ e, artifact }) } };
}

function extractionOf(textured: string, geometry: string, radiusM: number, prims: number, over: Partial<StagedExtraction> = {}): StagedExtraction {
    return {
        texturedGlb: textured, geometryGlb: geometry, downloadOrder: Object.fromEntries(Array.from({ length: prims }, (_, i) => [`leaf-${i}`, i])),
        leafIds: Array.from({ length: prims }, (_, i) => `leaf-${i}`), copyrights: ['Google'], fetchedAt: '2026-10-15T12:00:00.000Z',
        radiusM, coveredRadiusM: radiusM, truncated: false, leafTiles: prims, leafGeometricErrorM: 2.0064, originEllipsoidalHeightM: -23.5,
        geoAnchor: { lat: 40.73122, lng: -73.99709 }, ...over
    };
}

// ----------------------------------------------------------------------------------------------------------------
// Central Park: a district of 683,128 triangles, strip's 1,043 measured trees, tile_refine's remesh, plant's trees
// ----------------------------------------------------------------------------------------------------------------

const cp = centralParkRealData();

describe.skipIf(!cp.requirement.ok || !cp.data?.plant)(withReason('Central Park (district, r 250 m) on its real tiles, strip, remesh and plant', cp.requirement.ok && !cp.data?.plant ? { ok: false, reason: 'missing the real plant entry of the Central Park strip' } : cp.requirement), () => {
    let counter = 0;
    function setup() {
        const root = path.join(TMP, `cp${++counter}`);
        fs.mkdirSync(root, { recursive: true });
        const real = cp.data!;
        const calls = { extract: 0, strip: 0, refine: 0, plant: 0 };
        let prims: ReturnType<typeof readGlbScene> | undefined;
        const deps: StagedLocationDeps = {
            cache: new StageCache({ workspaceRoot: root }),
            geocode: async () => ({ lat: 40.78256, lng: -73.96558, formattedAddress: 'Central Park, New York, NY, USA' }),
            extract: async req => {
                calls.extract++;
                const textured = path.join(req.outDir, 'textured.glb'), geometry = path.join(req.outDir, 'geometry.glb');
                clone(real.textured, textured);
                prims ??= readGlbScene(real.textured);
                writeGeometryOnly(prims, geometry);
                return extractionOf(textured, geometry, req.radiusM, prims.length, { geoAnchor: { lat: 40.78256, lng: -73.96558 } });
            },
            vegetation: {
                strip: async () => {
                    calls.strip++;
                    return { devegetatedGlb: real.strip.devegetated, crownsJson: real.strip.crowns, stats: readJson(real.strip.stats), tileSha256: 'ab'.repeat(32), cached: true, ms: 61_500, cacheKey: real.strip.cacheKey };
                },
                plant: async () => {
                    calls.plant++;
                    return { treesGlb: real.plant!.trees, stats: readJson(real.plant!.stats), cached: true, ms: 5_400, cacheKey: real.plant!.cacheKey };
                }
            },
            refine: {
                refine: async () => {
                    calls.refine++;
                    return {
                        texturedGlb: real.remesh.clay, clayGlb: real.remesh.clay, stats: readJson(real.remesh.stats), cached: true, ms: real.remesh.runMs, cacheKey: real.remesh.cacheKey,
                        binary: { path: 'tile_refine', built: false }
                    } as never;
                }
            },
            newRunId: () => `c0ffee0${counter}`, sleep: async () => undefined
        };
        return { root, deps, calls, ...stands() };
    }

    it('commits the tiles, the remesh and the trees in order; the rebuild stages are skipped by design; L1 is geometry-only', async () => {
        const s = setup();
        const real = cp.data!;
        const t0 = Date.now();
        const { result } = await runStagedLocation({ query: 'Central Park', isolate: false, radiusM: 250, trees: true }, s.deps, s.ctx);
        const serverMs = Date.now() - t0;
        expect(validateContract('StagedLocationResult', result)).toEqual([]);
        expect(result.status).toBe('complete');
        expect(s.events.filter(x => x.e.status === 'committed' && x.e.stage !== 'finish' && x.e.stage !== 'terrain' && x.e.stage !== 'textures' && x.e.stage !== 'textures-late').map(x => x.e.stage)).toEqual(['resolve', 'tiles', 'trees-measure', 'remesh', 'trees']);
        for (const stage of ['fit', 'evidence', 'project', 'vision', 'correct', 'detail']) {
            expect(result.stages.find(x => x.stage === stage), stage).toMatchObject({ status: 'skipped', reason: expect.stringMatching(/not an isolated structure/) });
        }
        // one scene, one camera, for the whole run
        const arts = s.events.filter(x => x.artifact).map(x => x.artifact as any);
        expect(new Set(arts.map(a => a.id))).toEqual(new Set(['scene-stg-c0ffee01']));
        expect(new Set(arts.map(a => JSON.stringify(a.data.camera))).size).toBe(1);
        const layers = (result.artifact as any).data.stagedBuild.layers as any[];
        const [l1, l2, l5] = layers;
        expect([l1.layer, l2.layer, l5.layer]).toEqual(['l1', 'l2', 'l5']);
        // L1 holds the tiles' triangles without the photographs: smaller than the textured extraction (here the photographs
        // are about a quarter of its bytes, so the saving is that quarter, not most of it)
        const texturedBytes = fs.statSync(real.textured).size;
        expect(l1.counts.triangles).toBe(683_128);
        expect(l1.bytes).toBeLessThan(texturedBytes * 0.9);
        expect(readGlbTriangles(fs.readFileSync(path.join(s.root, 'public', 'models', path.basename(l1.url)))).json.images).toBeUndefined();
        // the remesh supersedes the tiles and carries tile_refine's own per-vertex provenance
        expect(l2).toMatchObject({ supersedes: [l1.objectId], provenance: { label: 'remeshed' } });
        // the trees: all the measured trees, within the scene's cap, revealed after the remesh they replace canopy in
        expect(result.trees).toMatchObject({ measured: 1043, count: 1043 });
        expect(l5.counts.triangles).toBeLessThanOrEqual(1_500_000);
        expect(l5).toMatchObject({ provenance: { label: 'grown to the measured crown' }, revealAfter: [l2.objectId] });
        expect(result.summary).toContain('Trees, grown to the measured crown: 1,043 of 1,043 trees rebuilt as SB-Veggie; 0 left as scanned');
        // the real disclosures reach the model: trees standing off the mounted ground, what closing the ground added, what the remesh moved
        expect(result.summary).toMatch(/\d+ rebuilt trees stand more than 0\.5 m off the mounted model/);
        expect(result.summary).toContain('not in the scan');
        expect(result.summary).toMatch(/rectify and facade flatten moved \d+% of its [\d,]+ vertices by 1 cm or more/);
        // a district never claims a triangle-edge resolution it did not measure
        expect(result.summary).not.toContain('median triangle edge 0.00');
        expect(result.summary).toContain("The scan's leaf tiles have a geometric error of 2.0 m.");
        expect(result.digest.length).toBeLessThanOrEqual(200);
        expect(result.complexityGate.exemptions[0]).toMatch(/^vertex floor: scan-derived layer/);
        // the time of each stage, recorded (the native stages here are the earlier runs' own, served from their caches)
        for (const stage of ['resolve', 'tiles', 'trees-measure', 'remesh', 'trees']) expect(result.stages.find(x => x.stage === stage)!.timings.ms, stage).toBeGreaterThanOrEqual(0);
        console.log(`[real data] Central Park: server ${serverMs} ms; L1 ${(l1.bytes / 1e6).toFixed(1)} MB (${l1.counts.triangles} triangles) vs the textured extraction ${(texturedBytes / 1e6).toFixed(1)} MB; remesh ${l2.counts.triangles} triangles (${(l2.bytes / 1e6).toFixed(1)} MB); trees ${l5.counts.triangles} triangles (${(l5.bytes / 1e6).toFixed(1)} MB)`);
        // screenshot: the remeshed district with its trees (the first 400 tree nodes)
        const remesh = readGlbTriangles(fs.readFileSync(path.join(s.root, 'public', 'models', path.basename(l2.url))));
        const trees = readGlbTriangles(fs.readFileSync(path.join(s.root, 'public', 'models', path.basename(l5.url))));
        const keep = trees.nodeRanges.slice(0, 400);
        const last = keep[keep.length - 1];
        fs.mkdirSync(STAGED_SCREENSHOT_DIR, { recursive: true });
        const png = renderClayPng([
            { positions: remesh.positions, indices: remesh.indices },
            { positions: trees.positions, indices: trees.indices.subarray(0, last ? (last.firstTriangle + last.triangleCount) * 3 : 0), color: [0.35, 0.62, 0.3] }
        ], { kind: 'aerial', width: 1000, height: 700, region: [-120, -120, 120, 120], bearingDeg: 200, elevationDeg: 38 });
        fs.writeFileSync(path.join(STAGED_SCREENSHOT_DIR, 'real_central_park_remesh_and_trees.png'), png);
        expect(png.subarray(1, 4).toString()).toBe('PNG');
    }, 240_000);

    it('a repeat serves every stage from cache, with the same object ids, and no layer is built twice', async () => {
        const s = setup();
        const first = await runStagedLocation({ query: 'Central Park', isolate: false, radiusM: 250, trees: true }, s.deps, s.ctx);
        const ids = (first.result.artifact as any).data.objects.map((o: any) => [o.id, o.content.durableUri]);
        const before = { ...s.calls };
        const t0 = Date.now();
        const second = await runStagedLocation({ query: 'Central Park', isolate: false, radiusM: 250, trees: true }, s.deps, s.ctx);
        const ms = Date.now() - t0;
        expect(s.calls.extract).toBe(before.extract);
        expect((second.result.artifact as any).data.objects.map((o: any) => [o.id, o.content.durableUri])).toEqual(ids);
        expect(second.result.cache).toMatchObject({ resolve: 'hit', tiles: 'hit' });
        for (const l of (second.result.artifact as any).data.stagedBuild.layers) expect(l.cached, l.layer).toBe(true);
        expect(ms).toBeLessThan(2500);
    }, 240_000);
});

// ----------------------------------------------------------------------------------------------------------------
// the Washington Square Arch: one structure, picked once on real geometry
// ----------------------------------------------------------------------------------------------------------------

const arch = archRealData();

/** A 1 m canopy mask over the central 250 m, rasterised from strip's real crown footprints. */
function canopyMaskFromCrowns(crownsJson: string): CanopyMask {
    const crowns = readJson(crownsJson).crowns as Array<{ status: string; footprint?: Array<[number, number]> }>;
    const half = 125, n = 2 * half;
    const flags = new Uint8Array(n * n);
    const inside = (x: number, z: number, poly: Array<[number, number]>) => {
        let c = false;
        for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) if ((poly[i][1] > z) !== (poly[j][1] > z) && x < ((poly[j][0] - poly[i][0]) * (z - poly[i][1])) / (poly[j][1] - poly[i][1]) + poly[i][0]) c = !c;
        return c;
    };
    for (const c of crowns) {
        if (!c.footprint || !['tree', 'cut_at_boundary_removed', 'cut_at_boundary', 'below_min_height'].includes(c.status)) continue;
        const xs = c.footprint.map(p => p[0]), zs = c.footprint.map(p => p[1]);
        for (let z = Math.max(-half, Math.floor(Math.min(...zs))); z <= Math.min(half - 1, Math.ceil(Math.max(...zs))); z++) {
            for (let x = Math.max(-half, Math.floor(Math.min(...xs))); x <= Math.min(half - 1, Math.ceil(Math.max(...xs))); x++) {
                if (inside(x + 0.5, z + 0.5, c.footprint)) flags[(z + half) * n + (x + half)] = 1;
            }
        }
    }
    const runs: number[] = [];
    let cur = 0, run = 0;
    for (const f of flags) { if (f === cur) run++; else { runs.push(run); cur = f; run = 1; } }
    runs.push(run);
    return { schema: 'scratchbox.canopy-mask/1', cellM: 1, x0: -half, z0: -half, nx: n, nz: n, runs, canopyCells: flags.reduce((a, b) => a + b, 0), ms: 0 };
}

/** Width and depth (m) of the smallest rectangle, at any angle, that holds the outline. */
function orientedBox(outline: Array<[number, number]>): { long: number; short: number } {
    let best = { long: Infinity, short: Infinity, area: Infinity };
    for (let deg = 0; deg < 90; deg += 0.5) {
        const a = (deg * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
        const u = outline.map(([x, z]) => x * c + z * s), v = outline.map(([x, z]) => -x * s + z * c);
        const w = Math.max(...u) - Math.min(...u), h = Math.max(...v) - Math.min(...v);
        if (w * h < best.area) best = { long: Math.max(w, h), short: Math.min(w, h), area: w * h };
    }
    return best;
}

describe.skipIf(!arch.requirement.ok)(withReason('the Washington Square Arch, isolated, on its real tiles and tile_refine isolate', arch.requirement), () => {
    function setup(over: Partial<StagedLocationDeps> = {}) {
        const root = path.join(TMP, `arch${++counter2}`);
        fs.mkdirSync(root, { recursive: true });
        const real = arch.data!;
        const cuts: Array<{ radiusM: number; textured: string }> = [];
        const deps: StagedLocationDeps = {
            cache: new StageCache({ workspaceRoot: root }),
            geocode: async () => ({ lat: 40.73122, lng: -73.99709, formattedAddress: 'Washington Square Arch, Washington Square N, New York, NY' }),
            extract: async req => {
                // whole primitives touching the circle (the crawler takes whole leaves)
                archPrims ??= readGlbScene(real.textured);
                const kept = archPrims.filter(p => {
                    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
                    for (let i = 0; i < p.positions.length; i += 3) { minX = Math.min(minX, p.positions[i]); maxX = Math.max(maxX, p.positions[i]); minZ = Math.min(minZ, p.positions[i + 2]); maxZ = Math.max(maxZ, p.positions[i + 2]); }
                    const dx = Math.max(minX, Math.min(0, maxX)), dz = Math.max(minZ, Math.min(0, maxZ));
                    return Math.hypot(dx, dz) <= req.radiusM;
                });
                const textured = path.join(req.outDir, 'textured.glb'), geometry = path.join(req.outDir, 'geometry.glb');
                writeGeometryOnly(kept, textured);
                writeGeometryOnly(kept, geometry);
                cuts.push({ radiusM: req.radiusM, textured });
                return extractionOf(textured, geometry, req.radiusM, kept.length);
            },
            vegetation: {
                strip: async () => { throw new Error('not asked for: trees are off'); },
                plant: async () => { throw new Error('not asked for: trees are off'); },
                canopy: async () => ({ mask: canopyMaskFromCrowns(real.strip.crowns), cached: true, ms: 0 })
            },
            refine: {
                refine: async () => ({
                    texturedGlb: real.refine.textured, clayGlb: real.refine.clay, rawClayGlb: real.refine.rawClay, stats: readJson(real.refine.stats), cached: true, ms: real.refine.runMs,
                    cacheKey: real.refine.cacheKey, binary: { path: 'tile_refine', built: false }
                }) as never
            },
            newRunId: () => `a2c4e60${counter2}`, sleep: async () => undefined,
            ...over
        };
        return { root, deps, cuts, ...stands() };
    }
    let counter2 = 0;
    let archPrims: ReturnType<typeof readGlbScene> | undefined;

    it('sizes the extraction to the structure, picks it once with the canopy masked out, and the remesh isolates the same one', async () => {
        const s = setup();
        const real = arch.data!;
        const { result } = await runStagedLocation({ query: 'Washington Square Arch', isolate: true, trees: false }, s.deps, s.ctx);
        expect(validateContract('StagedLocationResult', result)).toEqual([]);
        expect(result.extraction.sizedTo).toBe('structure');
        expect(result.structure).toBeDefined();
        // the structure was found at the geocoded point, and tile_refine's isolate (given the same seed) is the same structure
        expect(result.structure!.geocodeToStructureM).toBeLessThan(2);
        expect(result.structure!.isolateIoU).toBeGreaterThanOrEqual(0.7);
        // no degradation says the pick may hold canopy: the mask was applied
        expect(result.degradations.map(d => d.reasonCode)).not.toContain('canopy_not_masked');
        expect(result.degradations.map(d => d.reasonCode)).not.toContain('isolate_mismatch');
        expect(result.degradations.map(d => d.reasonCode)).toContain('scan_fit_unavailable');

        // the pick, recomputed on the extraction the run used: inside the structure's box (26.3 x 11.0 m, plus 2 m), no canopy
        // cell in it, and well inside the extraction (the structure is never clipped)
        const last = s.cuts[s.cuts.length - 1];
        const lastEntry = s.deps.cache.entryDir('tiles', stageKey('extract/v3', (40.73122).toFixed(6), (-73.99709).toFixed(6), Math.round(last.radiusM)));
        const scan = loadScanMesh(path.join(lastEntry, 'textured.glb'));
        const mask = canopyMaskFromCrowns(real.strip.crowns);
        const ground = buildGroundModel(scan, { cellMeters: 1, exclude: canopyLookup(mask) });
        const { masked, cells } = maskCanopy(ground, mask);
        expect(cells).toBeGreaterThan(1000);
        const pick = pickStructure(scan, masked, { canopyCellsMasked: cells })!;
        const box = orientedBox(pick.outline);
        expect(box.long).toBeLessThanOrEqual(26.3 + 2);
        expect(box.short).toBeLessThanOrEqual(11.0 + 2);
        const isCanopy = canopyLookup(mask);
        const canopyInside = [...pick.cells].filter(k => { const [x, z] = k.split(',').map(Number); return isCanopy(x + 0.5, z + 0.5); });
        expect(canopyInside).toEqual([]);
        expect(touchesEdge(pick, ground)).toBe(false);
        expect(Math.hypot(pick.seed.x - result.structure!.seed[0], pick.seed.z - result.structure!.seed[1])).toBeLessThan(0.01);
        // tile_refine's isolated structure, on the pick's terrain, is this one
        const iso = checkIsolate(real.refine.rawClay, pick, masked);
        expect(iso.ok).toBe(true);
        expect(iso.iou).toBeGreaterThanOrEqual(0.7);
        console.log(`[real data] Arch: extraction sized to ${result.extraction.radiusM} m in ${result.structure!.containmentRounds} round(s); footprint ${Math.round(pick.areaM2)} m² (${box.long.toFixed(1)} x ${box.short.toFixed(1)} m oriented box, ${Math.round(pick.heightM)} m tall), ${cells} canopy cells masked, IoU with tile_refine's isolate ${result.structure!.isolateIoU}`);

        // the layers: the tiles as downloaded (geometry only), then the real remesh of the structure, with tile_refine's own
        // per-vertex provenance read in bands
        const layers = (result.artifact as any).data.stagedBuild.layers as any[];
        expect(layers.map(l => l.layer)).toEqual(['l1', 'l2']);
        const vp = readRemeshProvenance(real.refine.clay).summary;
        expect(vp.vertices).toBeGreaterThan(1000);
        if (vp.rectifyDisplacement) expect(vp.rectifyDisplacement.bands.reduce((n, b) => n + b.vertices, 0)).toBe(vp.vertices);
        expect(layers[1].vertexProvenance).toEqual(vp);
        expect(layers[1].provenance.label).toBe('remeshed');
        // the scene is framed once on the structure, from tile_refine's footprint
        const camera = (result.artifact as any).data.camera;
        const toCamera = Math.hypot(camera.position[0] - camera.target[0], camera.position[1] - camera.target[1], camera.position[2] - camera.target[2]);
        expect(toCamera).toBeGreaterThan(20);
        expect(toCamera).toBeLessThan(200);
        // screenshots: the extraction the pick was made on, and the real remesh of the structure
        fs.mkdirSync(STAGED_SCREENSHOT_DIR, { recursive: true });
        const l1 = readGlbTriangles(fs.readFileSync(path.join(s.root, 'public', 'models', path.basename(layers[0].url))));
        fs.writeFileSync(path.join(STAGED_SCREENSHOT_DIR, 'real_arch_l1_tiles.png'), renderClayPng([{ positions: l1.positions, indices: l1.indices }], { kind: 'aerial', width: 900, height: 600, region: [-40, -40, 40, 40], bearingDeg: 215, elevationDeg: 35 }));
        const l2 = readGlbTriangles(fs.readFileSync(path.join(s.root, 'public', 'models', path.basename(layers[1].url))));
        fs.writeFileSync(path.join(STAGED_SCREENSHOT_DIR, 'real_arch_l2_remesh.png'), renderClayPng([{ positions: l2.positions, indices: l2.indices }], { kind: 'aerial', width: 900, height: 600, bearingDeg: 215, elevationDeg: 30 }));
    }, 240_000);

    it('a remesh that fails leaves the structure as downloaded, skips the rebuild, and says so; the earlier stages stay committed', async () => {
        const s = setup({
            refine: { refine: async () => { throw new Error('tile_refine exited with code 134'); } }
        });
        const { result } = await runStagedLocation({ query: 'Washington Square Arch', isolate: true, trees: false }, s.deps, s.ctx);
        expect(result.status).toBe('degraded');
        const remesh = result.degradations.find(d => d.stage === 'remesh')!;
        expect(remesh).toMatchObject({ reasonCode: 'remesh_failed', provenanceAfter: 'as-scanned', transient: true });
        expect(remesh.reason).toContain('tile_refine exited with code 134');
        const layers = (result.artifact as any).data.stagedBuild.layers as any[];
        expect(layers.map(l => l.layer)).toEqual(['l1']);
        expect(layers[0].provenance.label).toBe('as-scanned');
        // the structure was still picked and extracted whole before anything failed
        expect(result.extraction.sizedTo).toBe('structure');
        for (const stage of ['fit', 'vision', 'detail']) expect(result.stages.find(x => x.stage === stage)!.status, stage).toBe('skipped');
        expect(s.events.filter(x => x.e.status === 'committed').map(x => x.e.stage)).toContain('tiles');
    }, 240_000);
});
