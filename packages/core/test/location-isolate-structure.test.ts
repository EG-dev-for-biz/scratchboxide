/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * location_isolate_structure through its tool path, on synthetic scans with known truth. The extraction and the geocoder
 * are stand-ins (they hand back the synthetic scan); the pick, tile_refine (the native binary), tile_vegetation (the
 * native binary) and the isolate check are the real ones.
 *
 * - a terrace of two houses built wall to wall: the Google vector footprint separates them at the party wall, the
 *   neighbour is reported removed with that reason, and a second call comes from the staged caches;
 * - a structure longer than the largest extraction: containment_failed, the district whole, never a part of it;
 * - an isolate that is not the structure picked: district_fallback (isolate_mismatch), never the fragments;
 * - nothing standing at the place: district_fallback (no_structure_at_anchor);
 * - a roof garden over a hollow building: kept as scanned, with its reason.
 *
 * Screenshots: test-results/screenshots/tool_isolate/.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { runIsolateStructureTool, traceCells, ISOLATE_STRUCTURE_TOOL, type IsolateStructureDeps, type IsolateStructureResult } from '../src/node/gemini/tools/location-evidence/isolate-structure';
import { DEFAULT_TOOL_DECLARATIONS, DEFAULT_TOOL_HANDLERS } from '../src/node/gemini/tools';
import { inferToolGroup } from '../src/node/gemini/tool-registry';
import { StageCache } from '../src/node/3d-engine/staged-location/stage-cache';
import { TileRefineService, type TileRefineRequest } from '../src/node/3d-engine/tile-refine-service';
import { TileVegetationService } from '../src/node/3d-engine/tile-vegetation-service';
import type { StagedExtraction, ResolvedPlace } from '../src/node/3d-engine/staged-location/orchestrator';
import type { VectorEvidence } from '../src/node/3d-engine/staged-location/vector-footprints';
import { renderClayPng, readGlbTriangles } from './helpers/clay-glb-render';
import { buildSyntheticTile } from './helpers/synthetic-textured-tile';
import { type Chunk, flat, quad, writeGlb, buildTileRefine } from './helpers/synthetic-scan-glb';

const REPO = fs.realpathSync(path.resolve(__dirname, '../../..'));
const SHOTS = path.join(REPO, 'test-results/screenshots/tool_isolate');
const BIN = path.join(REPO, 'test-results/tool_isolate/tile_refine');
const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sbx-tool-isolate-')));
afterAll(() => fs.rmSync(TMP, { recursive: true, force: true }));
beforeAll(() => {
    fs.mkdirSync(path.dirname(BIN), { recursive: true });
    buildTileRefine(REPO, BIN);
}, 900_000);

const PLACE: ResolvedPlace = { lat: 40.7243, lng: -73.9952, formattedAddress: 'Synthetic Place, Test City' };

/** Walls (facing out) and roof of an axis-aligned box. */
function box(x0: number, x1: number, z0: number, z1: number, y1: number): Chunk[] {
    const n = 6;
    return [
        quad([x1, 0, z0], [0, 0, z1 - z0], [0, y1, 0], n, n), quad([x0, 0, z1], [0, 0, z0 - z1], [0, y1, 0], n, n),
        quad([x1, 0, z1], [x0 - x1, 0, 0], [0, y1, 0], n, n), quad([x0, 0, z0], [x1 - x0, 0, 0], [0, y1, 0], n, n),
        flat(x0, x1, z0, z1, y1, n)
    ];
}

interface Harness { deps: IsolateStructureDeps; calls: { geocode: number; extract: number[]; refine: TileRefineRequest[] } }

/** A workspace with the real stage cache and tile_refine, and stand-ins for the geocoder and the leaf crawler. */
function harness(name: string, scene: (radiusM: number) => Chunk[] | Buffer, opts: { vector?: VectorEvidence; refine?: (svc: TileRefineService, req: TileRefineRequest) => ReturnType<TileRefineService['refine']>; vegetation?: boolean } = {}): Harness {
    const root = path.join(TMP, name);
    fs.mkdirSync(root, { recursive: true });
    const svc = new TileRefineService({ workspaceRoot: root, repoRoot: REPO, binaryPath: BIN });
    const calls: Harness['calls'] = { geocode: 0, extract: [], refine: [] };
    const veg = opts.vegetation ? new TileVegetationService({ workspaceRoot: root, repoRoot: REPO }) : undefined;
    const deps: IsolateStructureDeps = {
        cache: new StageCache({ workspaceRoot: root }),
        geocode: async () => { calls.geocode++; return PLACE; },
        extract: async req => {
            calls.extract.push(req.radiusM);
            const textured = path.join(req.outDir, 'textured.glb'), geometry = path.join(req.outDir, 'geometry.glb');
            const s = scene(req.radiusM);
            if (Buffer.isBuffer(s)) fs.writeFileSync(textured, s); else writeGlb(textured, s);
            fs.copyFileSync(textured, geometry);
            return {
                texturedGlb: textured, geometryGlb: geometry, leafIds: ['synthetic'], copyrights: ['Google'], fetchedAt: '2026-10-19T00:00:00Z',
                radiusM: req.radiusM, coveredRadiusM: req.radiusM, truncated: false, leafTiles: 1, leafGeometricErrorM: 0.5, originEllipsoidalHeightM: 10,
                geoAnchor: { lat: PLACE.lat, lng: PLACE.lng }
            } satisfies StagedExtraction;
        },
        ...(veg ? { vegetation: { strip: req => veg.strip(req) } } : {}),
        ...(opts.vector ? { vectorEvidence: async () => opts.vector! } : {}),
        refine: {
            refine: req => { calls.refine.push(req); return opts.refine ? opts.refine(svc, req) : svc.refine(req); }
        }
    };
    return { deps, calls };
}

async function run(h: Harness, args: Record<string, unknown> = { query: 'Synthetic Place' }): Promise<{ result: IsolateStructureResult; payload: any; status?: string }> {
    const out = await runIsolateStructureTool(args, {}, h.deps);
    return { result: out.resultPayload as unknown as IsolateStructureResult, payload: out.resultPayload, status: out.status };
}

function isGlb(file: string): boolean {
    return fs.existsSync(file) && fs.readFileSync(file).subarray(0, 4).toString('latin1') === 'glTF';
}

function raised(file: string, pred: (x: number, y: number, z: number) => boolean): number {
    const t = readGlbTriangles(fs.readFileSync(file));
    let n = 0;
    for (let i = 0; i < t.indices.length; i += 3) {
        let x = 0, y = 0, z = 0;
        for (let k = 0; k < 3; k++) { x += t.positions[3 * t.indices[i + k]]; y += t.positions[3 * t.indices[i + k] + 1]; z += t.positions[3 * t.indices[i + k] + 2]; }
        if (pred(x / 3, y / 3, z / 3)) n++;
    }
    return n;
}

function shot(name: string, layers: Array<{ file: string; color: [number, number, number]; dx?: number }>, region: [number, number, number, number]): void {
    fs.mkdirSync(SHOTS, { recursive: true });
    fs.writeFileSync(path.join(SHOTS, `${name}.png`), renderClayPng(layers.map(l => {
        const t = readGlbTriangles(fs.readFileSync(l.file));
        const positions = Float32Array.from(t.positions);
        if (l.dx) for (let i = 0; i < positions.length; i += 3) positions[i] += l.dx;
        return { positions, indices: t.indices, color: l.color };
    }), { kind: 'aerial', width: 960, height: 600, region, bearingDeg: 200, elevationDeg: 38 }));
}

const rect = (x0: number, z0: number, x1: number, z1: number): Array<[number, number]> => [[x0, z0], [x1, z0], [x1, z1], [x0, z1]];

describe('location_isolate_structure is an in-app agent tool', () => {
    it('is declared, handled and routed to the workspace group', () => {
        expect(DEFAULT_TOOL_DECLARATIONS.some(d => d.name === ISOLATE_STRUCTURE_TOOL)).toBe(true);
        expect(typeof DEFAULT_TOOL_HANDLERS[ISOLATE_STRUCTURE_TOOL]).toBe('function');
        expect(inferToolGroup(ISOLATE_STRUCTURE_TOOL)).toBe('workspace');
    });

    it('fails with missing_input, not a guess, when the place is missing or half given', async () => {
        const h = harness('args', () => [flat(-60, 60, -60, 60, 0, 30)]);
        for (const args of [{}, { lat: 40.7 }, { lat: 'north', lng: -73.9 }]) {
            const out = await runIsolateStructureTool(args, {}, h.deps);
            expect(out.status).toBe('failed');
            expect((out.resultPayload as any).code).toBe('missing_input');
        }
        expect(h.calls.geocode + h.calls.extract.length).toBe(0);
    });
});

describe('the footprint polygon', () => {
    it('traces an L-shaped region with a courtyard hole along its cell edges', () => {
        const nx = 10, nz = 8;
        const m = new Uint8Array(nx * nz);
        for (let k = 0; k < nz; k++) for (let i = 0; i < nx; i++) if ((i < 4 || k < 3) && !(i === 1 && k === 4)) m[k * nx + i] = 1;
        const t = traceCells(m, { x0: -5, z0: -4, nx, nz, cellMeters: 1 });
        expect(t.areaM2).toBe(4 * 8 + 6 * 3 - 1);
        expect(t.outer).toHaveLength(6);
        expect(t.holes).toHaveLength(1);
        expect(t.holes[0]).toHaveLength(4);
        const area = (r: Array<[number, number]>) => Math.abs(r.reduce((s, [x1, z1], j) => { const [x2, z2] = r[(j + 1) % r.length]; return s + x1 * z2 - x2 * z1; }, 0) / 2);
        expect(area(t.outer) - area(t.holes[0])).toBe(t.areaM2);
    });
});

describe('isolating a terrace house by its vector footprint', () => {
    // two 15 m houses built wall to wall at x = 2; the place (the origin) is in the west one
    const scene = (): Chunk[] => [flat(-60, 60, -60, 60, 0, 60), ...box(-12, 2, -8, 8, 15), ...box(2, 18, -8, 8, 15)];
    const vector: VectorEvidence = { buildings: [{ id: 'west', parts: [[rect(-11.6, -7.6, 2.4, 7.6)]] }, { id: 'east', parts: [[rect(2.4, -7.6, 18.4, 8.4)]] }], water: [], roads: [[[-60, 12], [60, 12]]], tiles: 1, zoom: 17 };
    let h: Harness;
    let first: IsolateStructureResult;

    it('returns the west house alone, whole, with its footprint, ground and the neighbour removed at the party wall', async () => {
        h = harness('terrace', scene, { vector });
        const { result, payload, status } = await run(h, { query: 'Synthetic Place', target: 'the west house' });
        first = result;
        expect(status).toBe('completed');
        expect(result.outcome).toBe('isolated');
        expect(result.reasonCode).toBeUndefined();
        // the footprint: the vector one, the scan agreeing with it
        const f = result.footprint!;
        expect(f.source).toBe('vector-footprint');
        expect(f.pickSource).toBe('vector-footprint');
        expect(f.vectorFootprint).toMatchObject({ used: true, featureIds: ['west'] });
        expect(f.iouWithScan).toBeGreaterThan(0.7);
        expect(f.areaM2).toBeGreaterThan(14 * 16 * 0.9);
        expect(f.areaM2).toBeLessThan(16 * 18);
        const xs = f.polygon.map(p => p[0]);
        expect(Math.max(...xs)).toBeLessThanOrEqual(5);
        expect(Math.min(...xs)).toBeLessThanOrEqual(-11);
        expect(f.polygonLatLng).toHaveLength(f.polygon.length);
        for (const [lat, lng] of f.polygonLatLng) { expect(Math.abs(lat - PLACE.lat)).toBeLessThan(0.0005); expect(Math.abs(lng - PLACE.lng)).toBeLessThan(0.0005); }
        expect(f.isolateCheck!.ok).toBe(true);
        expect(f.maskVote!.ran).toBe(false);
        // its heights are within their typical range: no plausibility warning, none in the digest
        expect(result.plausibility).toEqual([]);
        expect(result.digest).not.toContain('plausibility');
        // the ground: the walkable street, with the vector road as its level
        expect(result.ground!.source).toBe('walkable-surface');
        expect(result.ground!.roadsFromVectorData).toBe(true);
        expect(Math.abs(result.ground!.heightM)).toBeLessThan(0.5);
        expect(result.ground!.ellipsoidalHeightM).toBeCloseTo(10 + result.ground!.heightM, 3);
        // kept and removed, with the reasons
        expect(result.kept.find(k => k.reasonCode === 'within_vector_footprint')!.areaM2).toBe(f.areaM2);
        const neighbour = result.removed.find(r => r.reasonCode === 'outside_vector_footprint');
        expect(neighbour).toBeDefined();
        expect(neighbour!.areaM2).toBeGreaterThan(14 * 16 * 0.8);
        expect(neighbour!.reason).toMatch(/party wall/);
        // the outputs: real GLBs, published, the east house not in them
        const s = result.structure!;
        for (const g of [s.texturedGlb, s.clayGlb, s.rawClayGlb!]) { expect(isGlb(g.path)).toBe(true); expect(g.url).toMatch(/^\/models\/.+\.glb$/); }
        // (tile_refine keeps triangles within its 2 m core grow of the footprint, so a strip of the neighbour's roof edge at
        // the party wall comes along; nothing of the neighbour beyond it)
        expect(raised(s.clayGlb.path, (x, y) => y > 2.5 && x > 7)).toBe(0);
        expect(raised(s.clayGlb.path, (x, y) => y > 2.5 && x < 0)).toBeGreaterThan(20);
        expect(result.digest).toMatch(/Isolated the structure.*Google vector data/);
        // mounted: the textured isolate and its clay twin
        expect(payload.artifact.type).toBe('3d-scene');
        expect(payload.artifact.data.objects.map((o: any) => o.content.durableUri)).toEqual([s.texturedGlb.url, s.clayGlb.url]);
        shot('terrace_isolated_vs_scan', [
            { file: result.extraction.rawGlbPath, color: [0.75, 0.75, 0.75] },
            { file: s.clayGlb.path, color: [0.25, 0.5, 0.75], dx: 70 }
        ], [-30, -20, 100, 20]);
        shot('terrace_isolated_clay', [{ file: s.clayGlb.path, color: [0.62, 0.64, 0.66] }], [-20, -15, 10, 15]);
    }, 600_000);

    it('comes from the staged caches the second time: no geocode, no extraction, the same files', async () => {
        const before = { geocode: h.calls.geocode, extract: h.calls.extract.length };
        const { result } = await run(h, { query: 'Synthetic Place', target: 'the west house' });
        expect(h.calls.geocode).toBe(before.geocode);
        expect(h.calls.extract.length).toBe(before.extract);
        expect(result.place.cached).toBe(true);
        expect(result.extraction.cached).toBe(true);
        expect(result.structure!.clayGlb.path).toBe(first.structure!.clayGlb.path);
        expect(result.footprint!.areaM2).toBe(first.footprint!.areaM2);
    }, 300_000);

    it('takes coordinates as given, without geocoding', async () => {
        const g = harness('coords', scene, { vector });
        const { result } = await run(g, { lat: PLACE.lat, lng: PLACE.lng });
        expect(g.calls.geocode).toBe(0);
        expect(result.place.geocoded).toBe(false);
        expect(result.outcome).toBe('isolated');
    }, 300_000);
});

describe('never fragments', () => {
    it('a structure longer than the largest extraction: containment_failed, the district whole', async () => {
        // a 12 m bar 800 m long: every extraction cuts it at its edge
        const h = harness('bar', r => [flat(-r, r, -r, r, 0, Math.max(8, Math.round(r / 4))), ...box(-r, r, -6, 6, 12)]);
        const { result, status } = await run(h);
        expect(status).toBe('completed');
        expect(result.outcome).toBe('containment_failed');
        expect(result.reasonCode).toBe('containment_failed');
        expect(result.reason).toMatch(/extends past \d+ m/);
        expect(result.structure).toBeUndefined();
        expect(result.footprint).toBeUndefined();
        expect(h.calls.extract[0]).toBe(25);
        expect(h.calls.extract.length).toBeGreaterThanOrEqual(3);
        expect(h.calls.extract.at(-1)).toBeLessThanOrEqual(150);
        // tile_refine was never asked to isolate: the district only
        expect(h.calls.refine.every(r => !r.isolate)).toBe(true);
        expect(isGlb(result.district!.clayGlb!.path)).toBe(true);
        expect(result.digest).toMatch(/containment_failed/);
        shot('bar_containment_failed_district', [{ file: result.district!.clayGlb!.path, color: [0.62, 0.64, 0.66] }], [-150, -60, 150, 60]);
    }, 900_000);

    it('an isolate that is not the structure picked: district_fallback with isolate_mismatch, never the isolate', async () => {
        // A at the place, B across a 12 m street; tile_refine "isolates" B
        const scene = (): Chunk[] => [flat(-60, 60, -60, 60, 0, 60), ...box(-8, 8, -8, 8, 18), ...box(20, 34, -8, 8, 12)];
        const h = harness('mismatch', scene, {
            refine: async (svc, req) => {
                const r = await svc.refine(req);
                if (!req.isolate) return r;
                const other = await svc.refine({ tilePath: req.tilePath, isolate: true, anchor: { x: 27, z: 0 } });
                return { ...r, rawClayGlb: other.rawClayGlb };
            }
        });
        const { result } = await run(h);
        expect(result.outcome).toBe('district_fallback');
        expect(result.reasonCode).toBe('isolate_mismatch');
        expect(result.reason).toMatch(/does not hold the structure at the seed/);
        expect(result.structure).toBeUndefined();
        expect(result.footprint!.isolateCheck!.ok).toBe(false);
        const d = result.district!.clayGlb!.path;
        expect(isGlb(d)).toBe(true);
        // the district holds both buildings whole
        expect(raised(d, (x, y) => y > 15 && Math.abs(x) < 7)).toBeGreaterThan(10);
        expect(raised(d, (x, y) => y > 10 && x > 21 && x < 33)).toBeGreaterThan(10);
        shot('mismatch_district_fallback', [{ file: d, color: [0.62, 0.64, 0.66] }], [-30, -25, 45, 25]);
    }, 600_000);

    it('nothing standing at the place: district_fallback with no_structure_at_anchor', async () => {
        const h = harness('open', r => [flat(-r - 10, r + 10, -r - 10, r + 10, 0, 20)]);
        const { result } = await run(h);
        expect(result.outcome).toBe('district_fallback');
        expect(result.reasonCode).toBe('no_structure_at_anchor');
        expect(h.calls.extract).toEqual([25, 60]);
        expect(result.extraction.radiusM).toBe(60);
        expect(isGlb(result.district!.clayGlb!.path)).toBe(true);
    }, 600_000);
});

describe('rooftop canopy', () => {
    it('a roof garden over a hollow building is kept as scanned with its reason; a street tree is removed as a tree', async () => {
        const building = { x0: -6, z0: -6, x1: 6, z1: 6, height: 15, roofBump: { x: 0, z: 0, height: 3.5, radius: 3 }, hollow: true };
        const tile = buildSyntheticTile({ halfSize: 34, spacing: 0.75, trees: [{ x: -14, z: 10, height: 9, radius: 3.5 }], building });
        const h = harness('garden', () => tile, { vegetation: true });
        const { result } = await run(h);
        expect(result.outcome).toBe('isolated');
        expect(result.rooftopCanopyKeptAsScanned.length).toBeGreaterThanOrEqual(1);
        const garden = result.rooftopCanopyKeptAsScanned[0];
        expect(garden.reasonCode).toBe('raised_level_not_under_it');
        expect(garden.reason).toMatch(/kept as scanned/);
        expect(Math.hypot(garden.stem[0], garden.stem[1])).toBeLessThan(2.5);
        expect(result.kept.some(k => k.reasonCode === 'raised_level_not_under_it')).toBe(true);
        const trees = result.removed.find(r => r.reasonCode === 'measured_tree');
        expect(trees).toBeDefined();
        // the isolate keeps the roof garden on the roof and holds no street tree
        const clay = result.structure!.clayGlb.path;
        expect(raised(clay, (x, y, z) => y > building.height + 1 && Math.hypot(x, z) < 3)).toBeGreaterThan(0);
        expect(raised(clay, (x, y, z) => y > 3 && Math.hypot(x + 14, z - 10) < 3)).toBe(0);
        shot('roof_garden_isolated', [{ file: result.structure!.texturedGlb.path, color: [0.55, 0.62, 0.5] }], [-45, -35, 45, 35]);
    }, 900_000);
});
