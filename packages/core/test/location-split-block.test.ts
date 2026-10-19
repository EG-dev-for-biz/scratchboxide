/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * location_split_block through its tool path, on synthetic scans with known truth. The geocoder, the leaf crawler and
 * Google's vector tiles are stand-ins (synthetic scans and footprints); location_building_shape, the structure picker,
 * the ownership, the per-triangle split and the GLB writer are the real ones.
 *
 * - a terrace of four touching buildings of different heights, with the alley between two of them melted shut in the scan,
 *   inside a block the road lines close (a building across the road is not in it);
 * - a block with a courtyard: a perimeter building with its courtyard as a hole, and an attached neighbour;
 * - a footprint missing from the vector data (its scan stays unassigned, listed), and a footprint with nothing standing on it
 *   (not split, with the reason).
 * Every case checks that each triangle of the scan is in exactly one output, by reading the GLBs written.
 *
 * Screenshots: test-results/screenshots/split_block/.
 */

import { describe, it, expect, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { runSplitBlockTool, SPLIT_BLOCK_TOOL, type SplitBlockDeps, type SplitBlockResult } from '../src/node/gemini/tools/location-evidence/split-block';
import { runBuildingShape } from '../src/node/gemini/tools/location-evidence/building-shape';
import { DEFAULT_TOOL_DECLARATIONS, DEFAULT_TOOL_HANDLERS } from '../src/node/gemini/tools';
import { inferToolGroup } from '../src/node/gemini/tool-registry';
import { StageCache } from '../src/node/3d-engine/staged-location/stage-cache';
import type { StagedExtraction, ResolvedPlace } from '../src/node/3d-engine/staged-location/orchestrator';
import type { VectorEvidence } from '../src/node/3d-engine/staged-location/vector-footprints';
import type { DecodedVectorTileData } from '../src/node/spatial/GoogleVectorTileService';
import { LocalTangentPlane } from '../src/common/coordinate/LocalTangentPlane';
import { renderClayPng, readGlbTriangles } from './helpers/clay-glb-render';
import { type Chunk, flat, quad, writeGlb } from './helpers/synthetic-scan-glb';

const REPO = fs.realpathSync(path.resolve(__dirname, '../../..'));
const SHOTS = path.join(REPO, 'test-results/screenshots/split_block');
const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sbx-split-block-')));
afterAll(() => fs.rmSync(TMP, { recursive: true, force: true }));

// a point well inside its zoom-17 vector tile (location_building_shape's own test place)
const PLACE: ResolvedPlace = { lat: 40.72425, lng: -73.99512, formattedAddress: 'Synthetic Block, Test City' };
const Z = 17;
function tileOf(lat: number, lng: number): { x: number; y: number } {
    const n = 2 ** Z, r = (lat * Math.PI) / 180;
    return { x: Math.floor(((lng + 180) / 360) * n), y: Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n) };
}
const HOME = tileOf(PLACE.lat, PLACE.lng);
/** Tile frame (x east, z south) to [lng, lat]. */
const ll = ([x, z]: [number, number]): [number, number] => { const g = LocalTangentPlane.enuToGeodetic({ lat: PLACE.lat, lng: PLACE.lng, alt: 0 }, x, -z, 0); return [g.lng, g.lat]; };
const rect = (x0: number, z0: number, x1: number, z1: number): Array<[number, number]> => [[x0, z0], [x1, z0], [x1, z1], [x0, z1]];

/** Walls (facing out) and roof of an axis-aligned box. */
function box(x0: number, x1: number, z0: number, z1: number, y1: number, n = 6): Chunk[] {
    return [
        quad([x1, 0, z0], [0, 0, z1 - z0], [0, y1, 0], n, n), quad([x0, 0, z1], [0, 0, z0 - z1], [0, y1, 0], n, n),
        quad([x1, 0, z1], [x0 - x1, 0, 0], [0, y1, 0], n, n), quad([x0, 0, z0], [x1 - x0, 0, 0], [0, y1, 0], n, n),
        flat(x0, x1, z0, z1, y1, n)
    ];
}

interface Footprint { id: string; ring: Array<[number, number]>; holes?: Array<Array<[number, number]>>; heightM: number }

/** One zoom-17 vector tile holding the footprints (tile frame rings converted to lng/lat), as GoogleVectorTileService decodes it. */
function vectorTile(fps: Footprint[]): DecodedVectorTileData {
    return {
        buildings: fps.map((f, i) => ({
            id: `${Z}/${HOME.x}/${HOME.y}/f${i}/e0`, type: 'Polygon' as const, ring: f.ring.map(ll), properties: { heightMeters: f.heightM, types: ['FEATURE_TYPE_BUILDING'] },
            ...(f.holes ? { innerRings: f.holes.map(h => h.map(ll)) } : {})
        })),
        landuse: [], water: [], roads: []
    };
}

interface Harness { deps: SplitBlockDeps; calls: { extract: number[]; shape: number } }

function harness(name: string, chunks: Chunk[], fps: Footprint[], roads?: Array<Array<[number, number]>>): Harness {
    const root = path.join(TMP, name);
    fs.mkdirSync(root, { recursive: true });
    const calls: Harness['calls'] = { extract: [], shape: 0 };
    const tile = vectorTile(fps);
    const deps: SplitBlockDeps = {
        cache: new StageCache({ workspaceRoot: root }),
        geocode: async () => PLACE,
        extract: async req => {
            calls.extract.push(req.radiusM);
            const textured = path.join(req.outDir, 'textured.glb'), geometry = path.join(req.outDir, 'geometry.glb');
            writeGlb(textured, chunks);
            fs.copyFileSync(textured, geometry);
            return {
                texturedGlb: textured, geometryGlb: geometry, leafIds: ['synthetic'], copyrights: ['Google'], fetchedAt: '2026-10-19T00:00:00Z',
                radiusM: req.radiusM, coveredRadiusM: req.radiusM, truncated: false, leafTiles: 1, leafGeometricErrorM: 0.5, originEllipsoidalHeightM: 10,
                geoAnchor: { lat: PLACE.lat, lng: PLACE.lng }
            } satisfies StagedExtraction;
        },
        ...(roads ? { vectorEvidence: async (): Promise<VectorEvidence> => ({ buildings: [], water: [], roads, tiles: 1, zoom: 17 }) } : {}),
        refine: { refine: async () => { throw new Error('tile_refine is not used without the mask vote'); } },
        buildingShape: req => { calls.shape++; return runBuildingShape(req, { workspaceRoot: root, fetchTile: async (x, y) => (x === HOME.x && y === HOME.y ? tile : { buildings: [], landuse: [], water: [], roads: [] }) }); }
    };
    return { deps, calls };
}

async function run(h: Harness, args: Record<string, unknown>): Promise<{ result: SplitBlockResult; status?: string; payload: any }> {
    const out = await runSplitBlockTool({ query: 'Synthetic Block', trees: false, ...args }, {}, h.deps);
    return { result: out.resultPayload as unknown as SplitBlockResult, status: out.status, payload: out.resultPayload };
}

const centroids = (file: string): Array<[number, number, number]> => {
    const t = readGlbTriangles(fs.readFileSync(file));
    const out: Array<[number, number, number]> = [];
    for (let i = 0; i < t.indices.length; i += 3) {
        let x = 0, y = 0, z = 0;
        for (let k = 0; k < 3; k++) { const v = t.indices[i + k] * 3; x += t.positions[v]; y += t.positions[v + 1]; z += t.positions[v + 2]; }
        out.push([x / 3, y / 3, z / 3]);
    }
    return out;
};

/** Every triangle of the input appears in exactly one output (as a multiset of centroids, 1 mm). */
function expectExactPartition(inputGlb: string, outputs: string[]): void {
    const key = ([x, y, z]: [number, number, number]) => `${Math.round(x * 1000)},${Math.round(y * 1000)},${Math.round(z * 1000)}`;
    const want = new Map<string, number>();
    for (const c of centroids(inputGlb)) want.set(key(c), (want.get(key(c)) ?? 0) + 1);
    let total = 0;
    for (const f of outputs) for (const c of centroids(f)) {
        total++;
        const k = key(c), n = want.get(k) ?? 0;
        expect(n, `triangle at ${k} of ${path.basename(f)} is not in the input, or is in two outputs`).toBeGreaterThan(0);
        want.set(k, n - 1);
    }
    expect([...want.values()].every(v => v === 0)).toBe(true);
    expect(total).toBe(centroids(inputGlb).length);
}

function shot(name: string, r: SplitBlockResult, region: [number, number, number, number]): void {
    fs.mkdirSync(SHOTS, { recursive: true });
    const hex = (h: string): [number, number, number] => [parseInt(h.slice(1, 3), 16) / 255, parseInt(h.slice(3, 5), 16) / 255, parseInt(h.slice(5, 7), 16) / 255];
    const layers = [
        ...r.buildings.map(b => ({ file: b.clayGlb.path, color: hex(b.colour) })),
        { file: r.unassigned.clayGlb.path, color: [0.82, 0.82, 0.82] as [number, number, number] }
    ].map(l => { const t = readGlbTriangles(fs.readFileSync(l.file)); return { positions: t.positions, indices: t.indices, color: l.color }; });
    fs.writeFileSync(path.join(SHOTS, `${name}.png`), renderClayPng(layers, { kind: 'aerial', width: 960, height: 600, region, bearingDeg: 200, elevationDeg: 42 }));
    fs.writeFileSync(path.join(SHOTS, `${name}_top.png`), renderClayPng(layers, { kind: 'top', width: 800, height: 800, region }));
}

describe('location_split_block is an in-app agent tool', () => {
    it('is declared, handled and routed to the workspace group', () => {
        expect(DEFAULT_TOOL_DECLARATIONS.some(d => d.name === SPLIT_BLOCK_TOOL)).toBe(true);
        expect(typeof DEFAULT_TOOL_HANDLERS[SPLIT_BLOCK_TOOL]).toBe('function');
        expect(inferToolGroup(SPLIT_BLOCK_TOOL)).toBe('workspace');
    });

    it('fails with missing_input, not a guess, when the place or the radius is wrong', async () => {
        const h = harness('args', [flat(-40, 40, -40, 40, 0, 20)], []);
        for (const args of [{ query: '' }, { query: '', lat: 40.7 }, { radiusM: 500 }, { radiusM: 'wide' }]) {
            const out = await runSplitBlockTool(args, {}, h.deps);
            expect(out.status).toBe('failed');
            expect((out.resultPayload as any).code).toBe('missing_input');
        }
    });
});

describe('a terrace of four touching buildings with a melted alley, in a block the roads close', () => {
    // A 9 m, B 15 m, alley (2 m, melted shut at 6 m), C 12 m, D 21 m; across the road to the south, F 10 m
    const A = rect(-14, -7, -6, 7), B = rect(-6, -7, 2, 7), C = rect(4, -7, 12, 7), D = rect(12, -7, 20, 7), F = rect(-5, 18, 5, 26);
    const fps: Footprint[] = [{ id: 'B', ring: B, heightM: 15 }, { id: 'A', ring: A, heightM: 9 }, { id: 'C', ring: C, heightM: 12 }, { id: 'D', ring: D, heightM: 21 }, { id: 'F', ring: F, heightM: 10 }];
    const chunks: Chunk[] = [
        flat(-60, 60, -45, 45, 0, 60),
        ...box(-14, -6, -7, 7, 9), ...box(-6, 2, -7, 7, 15), ...box(2, 4, -7, 7, 6, 2), ...box(4, 12, -7, 7, 12), ...box(12, 20, -7, 7, 21), ...box(-5, 5, 18, 26, 10)
    ];
    const roads: Array<Array<[number, number]>> = [[[-70, -14], [70, -14]], [[-70, 13], [70, 13]], [[-26, -60], [-26, 60]], [[32, -60], [32, 60]]];
    let h: Harness;
    let r: SplitBlockResult;

    it('splits the four buildings of the block (not the one across the road), each whole and agreeing with its footprint', async () => {
        h = harness('terrace', chunks, fps, roads);
        const out = await run(h, {});
        r = out.result;
        expect(out.status).toBe('completed');
        expect(r.schema).toBe('scratchbox.split-block/1');
        expect(r.selection.mode).toBe('block');
        expect(r.selection.boundedByRoads).toBe(true);
        const ids = (id: string) => r.buildings.find(b => b.featureIds.some(f => f.endsWith(`/f${fps.findIndex(x => x.id === id)}`)));
        expect(r.buildings).toHaveLength(4);
        for (const id of ['A', 'B', 'C', 'D']) expect(ids(id), id).toBeDefined();
        expect(ids('F')).toBeUndefined();
        expect(r.notSplit.find(n => n.featureIds.some(f => f.endsWith('/f4')))).toBeUndefined();
        for (const b of r.buildings) {
            expect(b.footprint.iouWithScan, b.id).toBeGreaterThan(0.8);
            expect(b.footprint.areaM2).toBeGreaterThan(100);
            expect(b.footprint.areaM2).toBeLessThan(8 * 14 + 30);
            expect(b.footprint.polygonLatLng.length).toBe(b.footprint.polygon.length);
            expect(fs.readFileSync(b.texturedGlb.path).subarray(0, 4).toString('latin1')).toBe('glTF');
            expect(b.triangles).toBeGreaterThan(100);
        }
        // the heights: the vector height of each, and the scan's roof, side by side
        expect(ids('D')!.heights.vectorM).toBe(21);
        expect(ids('D')!.heights.scanRoofM).toBeCloseTo(21, 0);
        expect(ids('A')!.heights.scanRoofM).toBeCloseTo(9, 0);
        // each building's clay holds only triangles over its own footprint (grown by the wall reach)
        for (const [id, ring] of [['A', A], ['B', B], ['C', C], ['D', D]] as const) {
            const [x0, z0] = ring[0], [x1, z1] = ring[2];
            for (const [x, , z] of centroids(ids(id)!.clayGlb.path)) {
                expect(x).toBeGreaterThanOrEqual(x0 - 2.6); expect(x).toBeLessThanOrEqual(x1 + 2.6);
                expect(z).toBeGreaterThanOrEqual(z0 - 2.6); expect(z).toBeLessThanOrEqual(z1 + 2.6);
            }
        }
    });

    it('puts every triangle in exactly one output: the four buildings or the unassigned rest (the building across the road included)', () => {
        expect(r.partition.everyTriangleOnce).toBe(true);
        expect(r.partition.outputTriangles).toBe(r.partition.inputTriangles);
        expectExactPartition(r.extraction.rawGlbPath, [...r.buildings.map(b => b.texturedGlb.path), r.unassigned.texturedGlb.path]);
        // the clay twins hold the same triangles
        expectExactPartition(r.extraction.rawGlbPath, [...r.buildings.map(b => b.clayGlb.path), r.unassigned.clayGlb.path]);
        // the building across the road, and the ground, are unassigned
        expect(centroids(r.unassigned.clayGlb.path).filter(([x, y, z]) => z > 18 && z < 26 && x > -5 && x < 5 && y > 9).length).toBeGreaterThan(10);
        expect(r.unassigned.surfaceByKindM2.ground).toBeGreaterThan(5000);
        expect(r.unassigned.unmappedStructures.some(u => u.withinFootprint && u.areaM2 > 60)).toBe(true);
    });

    it('splits the melted alley between its two neighbours at the line between their footprints, and says what decided each party wall', () => {
        const byFid = (i: number) => r.buildings.find(b => b.featureIds.some(f => f.endsWith(`/f${i}`)))!;
        const a = byFid(1), b = byFid(0), c = byFid(2), d = byFid(3);
        const wall = (p: typeof a, q: typeof a) => p.partyWalls.find(w => w.neighbourLabel === q.label);
        // A|B and C|D touch; B|C meet in the melted alley, which their picks shared
        for (const [p, q] of [[a, b], [b, c], [c, d]]) {
            const w = wall(p, q)!;
            expect(w, `${p.id}|${q.id}`).toBeDefined();
            expect(w.lengthM).toBeGreaterThanOrEqual(12);
            expect(w.segments.length).toBeGreaterThan(0);
            expect(wall(q, p)!.lengthM).toBe(w.lengthM);
            for (const s of w.segments) { expect(s.fromLatLng[0]).toBeCloseTo(PLACE.lat, 2); expect(s.decidedBy.length).toBeGreaterThan(0); }
        }
        expect(wall(a, c)).toBeUndefined();
        // A (9 m) | B (15 m) and C (12 m) | D (21 m): a height jump and the vector outline; B | C: the vector footprints (the alley is 6 m)
        expect(wall(a, b)!.decidedByM['height-jump']).toBeGreaterThanOrEqual(12);
        expect(wall(a, b)!.decidedByM['vector-footprint']).toBeGreaterThanOrEqual(12);
        expect(wall(c, d)!.decidedByM['height-jump']).toBeGreaterThanOrEqual(12);
        expect(wall(b, c)!.decidedByM['vector-footprint']).toBeGreaterThanOrEqual(12);
        // the alley wall lies between the footprints (x 2 .. 4), not on either facade line beyond them
        for (const s of wall(b, c)!.segments) { expect(s.from[0]).toBeGreaterThanOrEqual(2); expect(s.from[0]).toBeLessThanOrEqual(4); }
        expect(b.footprint.contestedCellsKept + c.footprint.contestedCellsKept).toBeGreaterThan(10);
        // the melt's roof went to B and C, none of it to unassigned
        const meltRoof = (f: string) => centroids(f).filter(([x, y]) => x > 2 && x < 4 && Math.abs(y - 6) < 0.01).length;
        expect(meltRoof(b.clayGlb.path)).toBeGreaterThan(0);
        expect(meltRoof(c.clayGlb.path)).toBeGreaterThan(0);
        expect(meltRoof(r.unassigned.clayGlb.path)).toBe(0);
        // the taller D's wall above C's roof is D's
        expect(centroids(c.clayGlb.path).filter(([x, y]) => Math.abs(x - 12) < 0.05 && y > 13).length).toBe(0);
        shot('terrace_melted_alley', r, [-30, -20, 36, 30]);
    });

    it('comes from the staged caches the second time', async () => {
        const again = await run(h, {});
        expect(again.result.cached).toBe(true);
        expect(again.result.buildings.map(b => b.id)).toEqual(r.buildings.map(b => b.id));
        expect(h.calls.extract).toHaveLength(1);
        expect(again.result.digest).toMatch(/Split the block at .* into 4 separated buildings/);
        expect(again.payload.artifact.type).toBe('3d-scene');
    });
});

describe('a block with a courtyard', () => {
    // P: a perimeter building (12 m) around an 18 x 18 m courtyard, its footprint drawn with the courtyard as a hole; Q (18 m) attached east
    const outer = rect(-15, -15, 15, 15), hole = rect(-9, -9, 9, 9), Q = rect(15, -15, 25, 15);
    const fps: Footprint[] = [{ id: 'P', ring: outer, holes: [hole], heightM: 12 }, { id: 'Q', ring: Q, heightM: 18 }];
    const wings = [...box(-15, 15, -15, -9, 12), ...box(-15, 15, 9, 15, 12), ...box(-15, -9, -9, 9, 12), ...box(9, 15, -9, 9, 12)];
    const chunks: Chunk[] = [flat(-50, 50, -40, 40, 0, 50), ...wings, ...box(15, 25, -15, 15, 18)];

    it('keeps the courtyard out of the building: a hole in its footprint, its floor unassigned, its walls the building\'s', async () => {
        const h = harness('courtyard', chunks, fps);
        const { result: r, status } = await run(h, { radiusM: 30 });
        expect(status).toBe('completed');
        expect(r.buildings).toHaveLength(2);
        const p = r.buildings.find(b => b.footprint.vector.parts[0].holesLatLng.length)!;
        const q = r.buildings.find(b => b !== p)!;
        expect(p.footprint.holes.length).toBe(1);
        const holeArea = (h0: Array<[number, number]>) => { let a = 0; for (let i = 0, j = h0.length - 1; i < h0.length; j = i++) a += h0[j][0] * h0[i][1] - h0[i][0] * h0[j][1]; return Math.abs(a) / 2; };
        expect(holeArea(p.footprint.holes[0])).toBeGreaterThan(14 * 14);
        expect(p.footprint.iouWithScan).toBeGreaterThan(0.8);
        expect(p.footprint.areaM2).toBeLessThan(30 * 30 - 15 * 15);
        // the courtyard floor: unassigned; the courtyard walls: P's
        const inCourt = ([x, , z]: [number, number, number]) => x > -8.5 && x < 8.5 && z > -8.5 && z < 8.5;
        expect(centroids(p.clayGlb.path).filter(c => inCourt(c) && c[1] < 0.1).length).toBe(0);
        expect(centroids(r.unassigned.clayGlb.path).filter(c => inCourt(c) && c[1] < 0.1).length).toBeGreaterThan(20);
        expect(centroids(p.clayGlb.path).filter(([x, y, z]) => Math.abs(x + 9) < 0.05 && y > 1 && Math.abs(z) < 8).length).toBeGreaterThan(5);
        // P | Q party wall along x = 15, decided by the vector outline and the height jump
        const w = p.partyWalls.find(x => x.neighbourLabel === q.label)!;
        expect(w.lengthM).toBeGreaterThanOrEqual(28);
        expect(w.decidedByM['vector-footprint']).toBeGreaterThanOrEqual(28);
        expect(w.decidedByM['height-jump']).toBeGreaterThanOrEqual(28);
        expect(r.partition.everyTriangleOnce).toBe(true);
        expectExactPartition(r.extraction.rawGlbPath, [...r.buildings.map(b => b.texturedGlb.path), r.unassigned.texturedGlb.path]);
        shot('courtyard_block', r, [-30, -25, 35, 25]);
    });
});

describe('a footprint missing from the vector data, and one with nothing standing on it', () => {
    // A (10 m), M (16 m, no vector footprint), C (10 m) wall to wall; E: a vector footprint on an empty lot
    const A = rect(-15, -6, -5, 6), C = rect(5, -6, 15, 6), E = rect(22, -6, 30, 6);
    const fps: Footprint[] = [{ id: 'A', ring: A, heightM: 10 }, { id: 'C', ring: C, heightM: 10 }, { id: 'E', ring: E, heightM: 8 }];
    const chunks: Chunk[] = [flat(-50, 50, -40, 40, 0, 50), ...box(-15, -5, -6, 6, 10), ...box(-5, 5, -6, 6, 16), ...box(5, 15, -6, 6, 10)];

    it('never invents the missing building: its scan stays unassigned, listed with its area; the empty lot is not split, with the reason', async () => {
        const h = harness('missing', chunks, fps);
        const { result: r, status } = await run(h, { radiusM: 40 });
        expect(status).toBe('completed');
        expect(r.buildings).toHaveLength(2);
        const [a, c] = [...r.buildings].sort((p, q) => p.footprint.polygon[0][0] - q.footprint.polygon[0][0]);
        for (const b of [a, c]) expect(b.footprint.iouWithScan).toBeGreaterThan(0.8);
        // A and C share no party wall: the missing building stands between them
        expect(a.partyWalls).toHaveLength(0);
        expect(c.partyWalls).toHaveLength(0);
        // the boundary to it is the vector outline and the height jump (16 m against 10 m)
        expect(a.exterior.decidedByM['vector-footprint']).toBeGreaterThanOrEqual(12);
        expect(a.exterior.decidedByM['height-jump']).toBeGreaterThanOrEqual(10);
        // its scan: unassigned, one raised mass of about its plan area, touching both, inside no footprint
        const m = r.unassigned.unmappedStructures[0];
        expect(m.areaM2).toBeGreaterThan(10 * 12 - 30);
        expect(m.areaM2).toBeLessThan(10 * 12 + 30);
        expect(m.heightM).toBeCloseTo(16, 0);
        expect(m.withinFootprint).toBeUndefined();
        expect(m.touches.sort()).toEqual([a.id, c.id].sort());
        expect(centroids(r.unassigned.clayGlb.path).filter(([x, y]) => Math.abs(x) < 4 && y > 15.9).length).toBeGreaterThan(10);
        // the empty lot: not split, with the reason; nothing of it is written
        const e = r.notSplit.find(n => n.featureIds.some(f => f.endsWith('/f2')))!;
        expect(e).toBeDefined();
        expect(['footprint_scan_disagree', 'no_raised_scan']).toContain(e.reasonCode);
        expect(e.reason.length).toBeGreaterThan(20);
        expect(r.digest).toMatch(/not split: 1 (footprint_scan_disagree|no_raised_scan)/);
        expect(r.partition.everyTriangleOnce).toBe(true);
        expectExactPartition(r.extraction.rawGlbPath, [...r.buildings.map(b => b.texturedGlb.path), r.unassigned.texturedGlb.path]);
        // nothing of the missing building is given to its neighbours: no triangle of A or C past their outlines toward it
        expect(centroids(a.clayGlb.path).filter(([x]) => x > -4.9).length).toBe(0);
        expect(centroids(c.clayGlb.path).filter(([x]) => x < 4.9).length).toBe(0);
        shot('missing_footprint', r, [-25, -20, 35, 20]);
    });
});
