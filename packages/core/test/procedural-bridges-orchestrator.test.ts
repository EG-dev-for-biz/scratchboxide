/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The bridges and the water as the massing stage builds them (bridge-build.ts): a synthetic scan with a deck over a river,
 * a fake vision reader (three arches) and two fake references that agree; the bridge GLB (glTF magic bytes, at least
 * three openings, every node labelled), the ground not drawn under the deck nor over the water, the streets' heights on
 * the deck, the water sheet; the carrier program (carrier-program.ts) built natively; the reference agreement
 * (bridge-references.ts). No model is called: the readers are fakes.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterAll, describe, expect, it } from 'vitest';
import { buildBridgesLayer, elevationColour, measureWaterColour, writeWaterGlb } from '../src/node/3d-engine/staged-location/bridge-build';
import { agreeBridgeDetail, meridianDistance, numbersAgree, parseBridgeDetail, type BridgeDetailReading } from '../src/node/3d-engine/staged-location/bridge-references';
import { runCarrierProgram, mergeGroups } from '../src/node/3d-engine/staged-location/carrier-program';
import { parseGlbBytes } from '../src/node/3d-engine/staged-location/glb-bytes';
import { encodePng } from '../src/node/3d-engine/staged-location/png-encode';
import { bridgeProgram, bridgeSpans, measureBridges, ScanProbe, underDeck } from '../src/node/3d-engine/staged-location/procedural-bridges';
import { buildGroundSurface } from '../src/node/3d-engine/staged-location/procedural-ground';
import { readGlbNodes } from '../src/node/3d-engine/staged-location/procedural-materials';
import type { TileTriangles } from '../src/node/3d-engine/staged-location/tile-texture-transfer';
import type { ScanMesh } from '../src/node/spatial/StreetViewSurveyPlanner';

type P3 = [number, number, number];
const tmpDirs: string[] = [];
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-bridges-')); tmpDirs.push(d); return d; };
afterAll(() => { for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true }); });

/** A ScanMesh over a triangle soup (each triangle its own three vertices). */
function scanOf(soup: number[]): ScanMesh {
    const V = Float32Array.from(soup), n = V.length / 9;
    const I = Uint32Array.from({ length: n * 3 }, (_, i) => i);
    const triCentroid = new Float32Array(n * 3), triArea = new Float32Array(n), triNormal = new Float32Array(n * 3);
    for (let t = 0; t < n; t++) for (let k = 0; k < 3; k++) triCentroid[t * 3 + k] = (V[t * 9 + k] + V[t * 9 + 3 + k] + V[t * 9 + 6 + k]) / 3;
    const min: P3 = [Infinity, Infinity, Infinity], max: P3 = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < V.length; i += 3) for (let k = 0; k < 3; k++) { min[k] = Math.min(min[k], V[i + k]); max[k] = Math.max(max[k], V[i + k]); }
    return { mesh: { vertices: V, indices: I } as unknown as ScanMesh['mesh'], triCount: n, triNormal, triArea, triCentroid, triTexelMeters: new Float32Array(n).fill(NaN), bounds: { min, max } };
}

/** A quad as two triangles (soup). */
const quad = (a: P3, b: P3, c: P3, d: P3): number[] => [...a, ...b, ...c, ...a, ...c, ...d];
/** A quad tiled into `n` x `n` cells (so the probe's bins hold small triangles). */
function grid(a: P3, b: P3, c: P3, d: P3, n: number): number[] {
    const out: number[] = [];
    const at = (u: number, v: number): P3 => [0, 1, 2].map(k => (a[k] * (1 - u) + b[k] * u) * (1 - v) + (d[k] * (1 - u) + c[k] * u) * v) as P3;
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) out.push(...quad(at(i / n, j / n), at((i + 1) / n, j / n), at((i + 1) / n, (j + 1) / n), at(i / n, (j + 1) / n)));
    return out;
}

// the district: a river 100 m wide (z 0..100) at y = -3 between banks at y = 0; a deck 20 m wide (x -10..10) at y = 8 crossing
// it (z -12..112), its side faces solid from the deck down to the water (the scan drapes a bridge's side shut)
const waterAt = (x: number, z: number) => z > 0 && z < 100;
const onDeck = (x: number, z: number) => Math.abs(x) <= 10 && z > -12 && z < 112;
const topAt = (x: number, z: number) => (onDeck(x, z) ? 8 : waterAt(x, z) ? -3 : 0);
const groundAt = (x: number, z: number) => (waterAt(x, z) ? -3 : 0);
const ground = { topAt, groundAt, cellMeters: 1 };
const within = () => true, bounds = { x0: -60, z0: -40, x1: 60, z1: 140 };
const soup = [
    ...grid([-60, 0, -40], [60, 0, -40], [60, 0, 0], [-60, 0, 0], 12), ...grid([-60, 0, 100], [60, 0, 100], [60, 0, 140], [-60, 0, 140], 12),
    ...grid([-60, -3, 0], [60, -3, 0], [60, -3, 100], [-60, -3, 100], 12),
    ...grid([-10, 8, -12], [10, 8, -12], [10, 8, 112], [-10, 8, 112], 12),
    ...grid([10, -3, 0], [10, -3, 100], [10, 8, 100], [10, 8, 0], 20), ...grid([-10, -3, 0], [-10, -3, 100], [-10, 8, 100], [-10, 8, 0], 20)
];
const scan = scanOf(soup);
const tile = (): TileTriangles => {
    const positions = Float32Array.from(soup), n = positions.length / 9;
    return { positions, uvs: new Float32Array(n * 6), normals: new Float32Array(n * 3), texture: new Int32Array(n).fill(-1), flatLinear: Float32Array.from({ length: n * 3 }, (_, i) => [0.08, 0.1, 0.12][i % 3]), textures: [] };
};

const READING = { openings: [{ fromM: 3, toM: 33, springM: 6, crownM: 9 }, { fromM: 37, toM: 67, springM: 6, crownM: 9 }, { fromM: 71, toM: 101, springM: 6, crownM: 9 }], fasciaTopM: 11, parapetTopM: 12, repeats: [{ what: 'lamp posts', spacingM: 34, heightM: 3 }], colourSrgb: [75, 88, 100], form: 'three arches' };
const DETAIL_A = { name: 'the bridge', posts: { present: true, overSupports: true, heightM: 3.2, meridian: [[0.3, 0], [0.2, 0.4], [0.12, 2.4], [0.16, 3.2]], heads: { count: 4, armRadiusM: 0.6, atHeightM: 2.8, radiusM: 0.2, lengthM: 0.5 }, colourSrgb: [40, 42, 45] }, rail: { openFraction: 0.1, plinthM: 0.2, copingM: 0.2, copingProjectionM: 0.05, colourSrgb: [150, 140, 130] }, supports: { noseLengthM: 2.4, pointedness: 0.6, capHeightM: 0.5, capProjectionM: 0.25, pilasterProjectionM: 0.3, colourSrgb: [120, 115, 110] }, arches: { ringWidthM: 0.6, ringProjectionM: 0.08 }, structureColourSrgb: [100, 105, 110] };
const DETAIL_B = { ...DETAIL_A, posts: { ...DETAIL_A.posts, heightM: 3.4, meridian: [[0.28, 0], [0.19, 0.5], [0.12, 2.5], [0.15, 3.4]] }, supports: { ...DETAIL_A.supports, noseLengthM: 2.1, pointedness: 0.5 } };
const DETAIL_C = { ...DETAIL_A, posts: { present: true, overSupports: false, spacingM: 10, heightM: 1, meridian: [[0.1, 0], [0.1, 1]] }, supports: { noseLengthM: 8, pointedness: 0 }, arches: null };

describe('the bridges and the water of a procedural district', () => {
    it('builds the bridge GLB from a read elevation and agreed references, cuts the ground under the deck and over the water, lays the water', async () => {
        const dir = tmp();
        const calls: string[] = [];
        const refPng = encodePng(8, 8, new Uint8Array(8 * 8 * 4).fill(120), 4);
        const res = await buildBridgesLayer({
            scan, ground, waterAt, lines: [[[0, -40], [0, 140]]], within, bounds, tile, dir,
            toGeodetic: () => ({ lat: -37.818, lng: 144.968 }),
            read: async (_image, _mime, _prompt, stage) => { calls.push(stage); return JSON.stringify(stage === 'bridge-read' ? READING : calls.filter(c => c === 'bridge-detail').length === 1 ? DETAIL_A : DETAIL_B); },
            references: async () => [{ image: refPng, mimeType: 'image/png', model: 'a' }, { image: refPng, mimeType: 'image/png', model: 'b' }]
        });
        expect(res.waterY).toBeCloseTo(-3, 1);
        expect(res.bridges).toHaveLength(1);
        expect(res.stats.read).toBe(1);
        expect(res.stats.referenced).toBe(2);
        expect(calls.filter(c => c === 'bridge-read')).toHaveLength(2);   // both sides read, the better one kept
        const { bridge, record } = res.bridges[0];
        expect(record.openings).toBeGreaterThanOrEqual(3);
        expect(bridgeSpans(bridge).openings.length).toBeGreaterThanOrEqual(3);
        expect(record.supports).toBeGreaterThanOrEqual(2);
        expect(record.parapetM).toBe(1);
        expect(record.detail?.supports?.noseLengthM).toBeCloseTo(2.25, 2);
        expect(record.detail?.arches).toBeDefined();
        expect(record.detail?.posts?.overSupports).toBe(true);
        // the posts: the scan (a flat deck, nothing standing on it) contradicts every post place, so none is built
        expect(record.posts).toBe(0);
        expect(record.notes.some(n => n.includes('post place'))).toBe(true);
        expect(record.dropped).toEqual([]);
        // the GLB: glTF magic bytes, one labelled node per group
        expect(res.file).toBeDefined();
        const bytes = fs.readFileSync(res.file!);
        expect(bytes.subarray(0, 4).toString('ascii')).toBe('glTF');
        const nodes = readGlbNodes(bytes);
        const names = nodes.map(n => n.name);
        expect(names).toContain('bridge/0/body');
        expect(names).toContain('bridge/0/parapet');
        expect(names).toContain('bridge/0/supports');
        expect(names).toContain('bridge/0/rings');
        for (const n of nodes) {
            const ex = n.extras as { sbBridge: { provenance: { label: string; confidence: number; method: string } } };
            expect(['photo-inferred', 'generated']).toContain(ex.sbBridge.provenance.label);
            expect(ex.sbBridge.provenance.confidence).toBeGreaterThan(0);
        }
        expect(nodes.find(n => n.name === 'bridge/0/body')!.extras).toMatchObject({ sbBridge: { provenance: { label: 'photo-inferred' } } });
        expect(nodes.find(n => n.name === 'bridge/0/rings')!.extras).toMatchObject({ sbBridge: { provenance: { label: 'generated' } } });
        const json = parseGlbBytes(bytes).json;
        const root = json.nodes.find((n: { extras?: { sbBridges?: unknown } }) => n.extras?.sbBridges).extras.sbBridges;
        expect(root.bridges[0].reading.openings).toHaveLength(3);
        expect(root.bridges[0].colourSrgb).toEqual([75, 88, 100]);
        expect(fs.existsSync(path.join(dir, root.bridges[0].elevationPng))).toBe(true);
        // the body: solid supports reach the water, the arches rise to their crowns
        const body = nodes.find(n => n.name === 'bridge/0/body')!;
        let minY = Infinity, maxY = -Infinity;
        for (let i = 1; i < body.positions.length; i += 3) { minY = Math.min(minY, body.positions[i]); maxY = Math.max(maxY, body.positions[i]); }
        expect(minY).toBeLessThan(-3);
        expect(maxY).toBeCloseTo(8, 1);
        expect(record.triangles).toBeGreaterThan(500);
        // the ground is not drawn under the deck nor over the water; the streets ride the deck
        const surf = buildGroundSurface({ ground, within, bounds, skip: (x, z) => res.underDeck(x, z) || waterAt(x, z) });
        expect(surf.stats.triangles).toBeGreaterThan(100);
        const under = underDeck(bridge, 0.5);
        for (let t = 0; t < surf.mesh.indices.length; t += 3) {
            const a = surf.mesh.indices[t] * 3, b = surf.mesh.indices[t + 1] * 3, c = surf.mesh.indices[t + 2] * 3;
            const cx = (surf.mesh.positions[a] + surf.mesh.positions[b] + surf.mesh.positions[c]) / 3, cz = (surf.mesh.positions[a + 2] + surf.mesh.positions[b + 2] + surf.mesh.positions[c + 2]) / 3;
            expect(under(cx, cz)).toBe(false);
            expect(waterAt(cx, cz)).toBe(false);
        }
        expect(res.deckYAt(0, 50)).toBe(8);
        expect(res.deckYAt(30, 50)).toBeUndefined();
        // the water: one sheet at the measured level, the tile photo's colour over it
        const colour = measureWaterColour(tile(), waterAt, within, bounds, 2);
        expect(colour).toBeDefined();
        expect(colour!.colourSrgb[2]).toBeGreaterThan(colour!.colourSrgb[0]);
        const w = writeWaterGlb(path.join(dir, 'water.glb'), { waterAt, within, bounds, levelY: res.waterY!, colourSrgb: colour!.colourSrgb, colourTexels: colour!.texels });
        expect(w.cells).toBeGreaterThan(1000);
        const wb = fs.readFileSync(path.join(dir, 'water.glb'));
        expect(wb.subarray(0, 4).toString('ascii')).toBe('glTF');
        const wj = parseGlbBytes(wb).json;
        expect(wj.nodes.find((n: { name?: string }) => n.name === 'water').extras.sbWater.provenance.label).toBe('generated');
        expect(wj.images).toHaveLength(1);
        for (const n of readGlbNodes(wb)) for (let i = 1; i < n.positions.length; i += 3) expect(n.positions[i]).toBeCloseTo(res.waterY!, 5);
    }, 120_000);

    it('keeps what the scan measured when no model reads and no reference comes, with the reasons', async () => {
        const dir = tmp();
        const res = await buildBridgesLayer({ scan, ground, waterAt, lines: [[[0, -40], [0, 140]]], within, bounds, tile, dir });
        expect(res.bridges).toHaveLength(1);
        const { record } = res.bridges[0];
        expect(record.reading).toBeUndefined();
        expect(record.detail).toBeUndefined();
        expect(record.notes.some(n => n.includes('no vision model'))).toBe(true);
        expect(record.notes.some(n => n.includes('no reference images'))).toBe(true);
        const nodes = readGlbNodes(fs.readFileSync(res.file!));
        expect(nodes.map(n => n.name)).toContain('bridge/0/body');
        const parapet = nodes.find(n => n.name === 'bridge/0/parapet')!.extras as { sbBridge: { provenance: { reason?: string } } };
        expect(parapet.sbBridge.provenance.reason).toContain('no two references agreed');
    }, 120_000);

    it('finds no bridge where nothing crosses the water, and says so', async () => {
        const res = await buildBridgesLayer({ scan, ground, waterAt, lines: [[[30, -40], [30, -20]]], within, bounds, tile, dir: tmp() });
        expect(res.bridges).toEqual([]);
        expect(res.file).toBeUndefined();
        expect(res.notes.join(' ')).toContain('no crossing');
        expect(res.underDeck(0, 50)).toBe(false);
    });

    it('places posts over the supports where the scan does not contradict them, with lanterns on arms', () => {
        const probe = { near: () => false } as unknown as ScanProbe;
        const [b] = measureBridges({ lines: [[[0, -40], [0, 140]]], waterAt, topAt, groundAt, within, waterY: -3, probe });
        const detail = agreeBridgeDetail([parseBridgeDetail(JSON.stringify(DETAIL_A))!, parseBridgeDetail(JSON.stringify(DETAIL_B))!]);
        const p = bridgeProgram(b, { parapetM: 1, detail, bodyColourSrgb: [75, 88, 100], scanRises: () => true });
        expect(p.posts).toBe(0);   // the measured bridge (no reading) is one solid support over the water: no opening to stand a post beside
        const noScan = bridgeProgram(b, { parapetM: 1, detail, scanRises: () => undefined });
        expect(noScan.posts).toBe(p.posts);
        const ids = p.program.elements.map(e => e.id);
        expect(ids).toContain('body');
        expect(ids.filter(i => i.startsWith('parapet')).length).toBe(2);
        expect(p.program.elements.every(e => e.provenance.label === 'photo-inferred' || e.provenance.label === 'generated')).toBe(true);
    });

    it('agrees on detail only where two independent references do, and says why the rest is left out', () => {
        const a = parseBridgeDetail(JSON.stringify(DETAIL_A))!, b = parseBridgeDetail(JSON.stringify(DETAIL_B))!, c = parseBridgeDetail(JSON.stringify(DETAIL_C))!;
        expect(a.posts?.heads?.count).toBe(4);
        const two = agreeBridgeDetail([a, b]);
        expect(two.posts?.heightM).toBeCloseTo(3.3, 5);
        expect(two.posts?.heads?.count).toBe(4);
        expect(two.posts?.meridian).toHaveLength(12);
        expect(two.supports?.capHeightM).toBeCloseTo(0.5, 5);
        expect(two.arches?.ringWidthM).toBeCloseTo(0.6, 5);
        expect(two.rail?.openFraction).toBeCloseTo(0.1, 5);
        expect(two.rejected).toEqual([]);
        const three = agreeBridgeDetail([a, b, c]);
        expect(three.posts?.agreement).toBeCloseTo(2 / 3, 5);
        expect(three.supports?.noseLengthM).toBeCloseTo(2.25, 5);
        const one = agreeBridgeDetail([a]);
        expect(one.posts).toBeUndefined();
        expect(one.rejected.map(r => r.item)).toEqual(expect.arrayContaining(['posts', 'rail', 'supports', 'arch rings']));
        expect(one.rejected[0].reason).toContain('only one reference');
        const split = agreeBridgeDetail([a, c]);
        expect(split.posts).toBeUndefined();
        expect(split.rejected.find(r => r.item === 'posts')?.reason).toContain('disagree');
        expect(numbersAgree(2.4, 2.1)).toBe(true);
        expect(numbersAgree(2.4, 8)).toBe(false);
        expect(meridianDistance(DETAIL_A.posts.meridian as Array<[number, number]>, DETAIL_B.posts.meridian as Array<[number, number]>)).toBeLessThan(0.1);
        expect(parseBridgeDetail('not json')).toBeUndefined();
    });

    it('runs a carrier program natively: sweeps, solids of revolution and replicators built, a bad element dropped with why', async () => {
        const r = await runCarrierProgram({
            elements: [
                { id: 'body', group: 'body', op: 'sweep', carrier: [[0, 0, -5], [0, 0, 5]], ref: [0, 1, 0], profile: { outer: [[-20, 0], [20, 0], [20, 10], [-20, 10]] }, provenance: { label: 'photo-inferred', confidence: 0.7, method: 'test' } },
                { id: 'posts', op: 'revolve', profile: [[0, 0], [0.2, 0], [0.1, 3], [0, 3]], at: [[0, 10, 0], [5, 10, 0]], provenance: { label: 'generated', confidence: 0.4, method: 'test' } },
                { id: 'bal', op: 'replicate', carrier: [[-20, 10, 5], [20, 10, 5]], pitch: 0.5, seed: { op: 'revolve', profile: [[0, 0], [0.06, 0], [0.08, 0.4], [0.05, 0.8], [0, 0.8]], segments: 8 }, provenance: { label: 'generated', confidence: 0.4, method: 'test' } },
                { id: 'bad', op: 'sweep', carrier: [[0, 0, 0]], ref: [0, 1, 0], profile: { outer: [[0, 0], [1, 0], [1, 1]] }, provenance: { label: 'generated', confidence: 0.1, method: 'test' } }
            ]
        }, tmp());
        expect(r.built.map(b => b.id)).toEqual(['body', 'posts', 'bal']);
        expect(r.dropped).toEqual([{ id: 'bad', reason: expect.stringContaining('two points') }]);
        expect(r.built[0].positions.length / 3).toBe(8);
        expect(r.built[1].instances).toBe(2);
        expect(r.built[2].instances).toBe(81);
        expect(r.triangles).toBeGreaterThan(1000);
        const g = mergeGroups(r.built);
        expect(g.map(x => x.group)).toEqual(['body', 'posts', 'bal']);
        expect(g[2].indices.length / 3).toBe(r.built[2].indices.length / 3);
        for (const v of r.built[0].positions) expect(Number.isFinite(v)).toBe(true);
    }, 300_000);

    it('measures the elevation render\'s colour with the background left out', () => {
        const w = 40, h = 20, rgba = new Uint8Array(w * h * 4);
        for (let i = 0; i < w * h; i++) { const dark = i % w < 20; rgba.set(dark ? [60, 70, 80, 255] : [200, 210, 220, 255], i * 4); }
        const c = elevationColour({ rgba, width: w, height: h });
        expect(c).toBeDefined();
        expect(c!.linearRgb[2]).toBeGreaterThan(c!.linearRgb[0]);
        expect(c!.linearRgb[0]).toBeLessThan(0.1);
    });
});
