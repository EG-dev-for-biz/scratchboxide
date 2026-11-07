/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The Map data view's contracts and projection (common/spatial/map-data-view.ts, node/spatial/map-data-service.ts):
 * the blob groups body round-trips and indexes the scan's triangles in the split's order, groups are open labels
 * coloured in area order, Google vector data lands in the scan frame where LocalTangentPlane puts it (x east, z south),
 * the carriageway widths are the scan's own (a kerb 5 m off the centreline reads 5 m), roadmap tiles tile the place, and
 * the overlay drapes on the measured ground.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
    assignColours, blobGroupsHeaderOf, carriagewayStrip, codeWords, decodeBlobGroups, densify, encodeBlobGroups, encodeFloat32B64,
    featureKey, geoToScan, groundSampler, groupIndexLists, layerOn, MAP_PALETTE, roadmapTilesFor, tileXY,
    type BlobGraphFile, type BlobGroupsPayload, type MapGroundGrid
} from '../src/common/spatial/map-data-view';
import { LocalTangentPlane } from '../src/common/coordinate/LocalTangentPlane';
import { discoverBlobGraph, footprintLoops, loadBlobGroups, overlayFromEvidence, planUnionOutline } from '../src/node/spatial/map-data-service';
import { fetchVectorEvidence } from '../src/node/3d-engine/staged-location/vector-footprints';
import { writeStagedGlbFile } from '../src/node/3d-engine/staged-location/staged-glb-writer';

const ORIGIN = { lat: 40.75032, lng: -73.99172 };

const perimeter = (loop: Array<[number, number]>) => loop.reduce((n, p, i) => { const q = loop[(i + 1) % loop.length]; return n + Math.hypot(q[0] - p[0], q[1] - p[1]); }, 0);

/** Three blobs over four triangles: one triangle unassigned; groups named as nobody anticipated. */
function tinyGraph(): { graph: BlobGraphFile; triBlob: Int32Array; positions: Float32Array; indices: Uint32Array } {
    const positions = new Float32Array([0, 0, 0, 1, 0, 0, 1, 0, 1, 0, 0, 1, 2, 0, 0, 2, 0, 1]);
    const indices = new Uint32Array([0, 1, 2, 0, 2, 3, 1, 4, 5, 1, 5, 2]);
    const triBlob = new Int32Array([0, 0, 2, -1]);
    const graph: BlobGraphFile = {
        schema: 'scratchbox.blob-graph-prototype/1',
        source: { anchor: ORIGIN },
        blobs: [
            { index: 0, id: 'blob/a', group: 'bioluminescent-mycelium', measures: { areaM2: 1 }, reading: { description: 'a glowing mat', confidence: 0.8 } },
            { index: 1, id: 'blob/b', group: 'methane-geyser', measures: { areaM2: 9 } },
            { index: 2, id: 'blob/c', group: 'methane-geyser', measures: { areaM2: 0.5 }, featureId: '17/1/2/f3' }
        ]
    };
    return { graph, triBlob, positions, indices };
}

describe('blob groups contract', () => {
    it('sums groups by area, labels every blob, and counts the unassigned triangles', () => {
        const { graph, triBlob } = tinyGraph();
        const h = blobGroupsHeaderOf(graph, triBlob, { path: 'welded.glb', vertices: 6, triangles: 4 }, 'blob_graph.json');
        expect(h.groups.map(g => g.label)).toEqual(['methane-geyser', 'bioluminescent-mycelium']);
        expect(h.groups[0]).toMatchObject({ blobs: 2, triangles: 1, areaM2: 9.5 });
        expect(h.groups[1]).toMatchObject({ blobs: 1, triangles: 2 });
        expect(h.blobs[0]).toMatchObject({ id: 'blob/a', confidence: 0.8, description: 'a glowing mat', triangles: 2 });
        expect(h.blobs[2]).toMatchObject({ featureId: '17/1/2/f3', triangles: 1 });
        expect(h.unassignedTriangles).toBe(1);
        expect(h.source.anchor).toEqual(ORIGIN);
    });

    it('round-trips the binary body and splits the index buffer into one list per group', () => {
        const { graph, triBlob, positions, indices } = tinyGraph();
        const header = blobGroupsHeaderOf(graph, triBlob, { path: 'welded.glb', vertices: 6, triangles: 4 }, 'blob_graph.json');
        const payload: BlobGroupsPayload = { header, positions, indices, triBlob };
        const body = encodeBlobGroups(payload);
        expect(new DataView(body.buffer).getUint32(0, true)).toBe(0x47425342);
        // an odd offset in a larger buffer still decodes
        const shifted = new Uint8Array(body.length + 3); shifted.set(body, 3);
        const back = decodeBlobGroups(shifted.subarray(3));
        expect(Array.from(back.positions)).toEqual(Array.from(positions));
        expect(Array.from(back.indices)).toEqual(Array.from(indices));
        expect(Array.from(back.triBlob)).toEqual([0, 0, 2, -1]);
        const lists = groupIndexLists(back);
        expect(Array.from(lists.get('bioluminescent-mycelium')!)).toEqual([0, 1, 2, 0, 2, 3]);
        expect(Array.from(lists.get('methane-geyser')!)).toEqual([1, 4, 5]);
        expect(() => decodeBlobGroups(body.subarray(0, body.length - 4))).toThrow(/header says/);
    });

    it('hands palette colours out in the given order, for any label', () => {
        const c = assignColours(['x', 'y', 'x', 'an entirely new kind']);
        expect([...c.keys()]).toEqual(['x', 'y', 'an entirely new kind']);
        expect(c.get('x')).toBe(MAP_PALETTE[0]);
        expect(c.get('an entirely new kind')).toBe(MAP_PALETTE[2]);
        expect(assignColours(Array.from({ length: MAP_PALETTE.length + 1 }, (_, i) => `g${i}`)).get(`g${MAP_PALETTE.length}`)).toBe(MAP_PALETTE[0]);
    });

    it('reads codes as labels: most specific code, words for the legend, unknown codes kept', () => {
        expect(featureKey(['FEATURE_TYPE_POI', 'FEATURE_TYPE_SERVICES', 'FEATURE_TYPE_PARKING_LOT'])).toBe('FEATURE_TYPE_PARKING_LOT');
        expect(featureKey([])).toBe('SB_FEATURE_TYPE_OBJECT');
        expect(codeWords('FEATURE_TYPE_PARKING_LOT')).toBe('parking lot');
        expect(codeWords('SB_FEATURE_TYPE_LIQUID_METHANE_POOL')).toBe('liquid methane pool');
        expect(codeWords('something-else')).toBe('something-else');
    });

    it('layer switches default on except the roadmap, and nothing shows while the view is off', () => {
        expect(layerOn({ on: true }, 'blobs')).toBe(true);
        expect(layerOn({ on: true }, 'roadmap')).toBe(false);
        expect(layerOn({ on: true, layers: { roadmap: true, roads: false } }, 'roads')).toBe(false);
        expect(layerOn({ on: false, layers: { roadmap: true } }, 'roadmap')).toBe(false);
        expect(layerOn(undefined, 'blobs')).toBe(false);
    });
});

describe('blob graph files on disk', () => {
    let dir: string;
    beforeAll(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-map-blobs-'));
        const { graph, triBlob, positions, indices } = tinyGraph();
        writeStagedGlbFile(path.join(dir, 'welded.glb'), [{ name: 'scan', positions, indices }]);
        fs.mkdirSync(path.join(dir, 'split'));
        fs.writeFileSync(path.join(dir, 'split', 'labels.bin'), Buffer.from(triBlob.buffer));
        fs.writeFileSync(path.join(dir, 'blob_graph.json'), JSON.stringify({ ...graph, source: { ...graph.source, welded: '/nowhere/else/welded.glb' } }));
    });
    afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

    it('loads the scan mesh in the split\'s triangle order with its labels', () => {
        const p = loadBlobGroups(path.join(dir, 'blob_graph.json'));
        expect(p.header.source.triangles).toBe(4);
        expect(p.header.source.mesh).toBe(path.join(dir, 'welded.glb'));
        expect(Array.from(p.triBlob)).toEqual([0, 0, 2, -1]);
        // triangle 2 of the mesh is the methane-geyser blob's: its three vertices are the ones the glb wrote
        const t = 2, a = p.indices[t * 3], b = p.indices[t * 3 + 1], c = p.indices[t * 3 + 2];
        const xs = [a, b, c].map(i => p.positions[i * 3]).sort();
        expect(xs).toEqual([1, 2, 2]);
        expect(decodeBlobGroups(encodeBlobGroups(p)).header.groups[0].label).toBe('methane-geyser');
    });

    it('finds the graph beside its own mesh only', () => {
        expect(discoverBlobGraph(path.join(dir, 'welded.glb'))).toBe(path.join(dir, 'blob_graph.json'));
        expect(discoverBlobGraph(path.join(dir, 'other.glb'))).toBeUndefined();
    });

    it('refuses labels written for another extraction', () => {
        const other = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-map-blobs-bad-'));
        try {
            const { graph, positions, indices } = tinyGraph();
            writeStagedGlbFile(path.join(other, 'welded.glb'), [{ name: 'scan', positions, indices }]);
            fs.writeFileSync(path.join(other, 'labels.bin'), Buffer.from(new Int32Array([0, 0, 0]).buffer));
            fs.writeFileSync(path.join(other, 'blob_graph.json'), JSON.stringify(graph));
            expect(() => loadBlobGroups(path.join(other, 'blob_graph.json'))).toThrow(/do not match/);
        } finally {
            fs.rmSync(other, { recursive: true, force: true });
        }
    });
});

// ------------------------------------------------------------------------------------------------ projection

/** lng/lat of a scan-frame point (x east, z south) through LocalTangentPlane. */
function lngLatOf(x: number, z: number): [number, number] {
    const g = new LocalTangentPlane({ lat: ORIGIN.lat, lng: ORIGIN.lng, alt: 0 }).toLatLng([x, 0, z]);
    return [g.lng, g.lat];
}

/** A stand-in for GoogleVectorTileService.fetchVectorTile: the features only in the origin's tile. */
function standInTiles() {
    const home = tileXY(ORIGIN.lat, ORIGIN.lng, 17);
    const square = [[-40, -40], [-20, -40], [-20, -20], [-40, -20]].map(([x, z]) => lngLatOf(x, z)) as Array<[number, number]>;
    const tri1 = [[20, 20], [30, 20], [30, 30]].map(([x, z]) => lngLatOf(x, z)), tri2 = [[20, 20], [30, 30], [20, 30]].map(([x, z]) => lngLatOf(x, z));
    const features = {
        buildings: [{ id: '17/1/1/f0/e0', ring: square, properties: { heightMeters: 30, types: ['FEATURE_TYPE_BUILDING'] } }],
        buildingFootprints2D: [],
        water: [{ ring: [[35, -45], [45, -45], [45, -35], [35, -35]].map(([x, z]) => lngLatOf(x, z)) as Array<[number, number]> }],
        roads: [{ points: [lngLatOf(0, 60), lngLatOf(0, -60)] as Array<[number, number]>, properties: { types: ['FEATURE_TYPE_INFRASTRUCTURE', 'FEATURE_TYPE_ROAD'] } }],
        rails: [{ points: [lngLatOf(-45, 0), lngLatOf(-45, 40)] as Array<[number, number]> }],
        landuse: [{ ring: [[10, -40], [25, -40], [25, -30], [10, -30]].map(([x, z]) => lngLatOf(x, z)) as Array<[number, number]>, properties: { types: ['FEATURE_TYPE_POI', 'FEATURE_TYPE_OUTDOOR_AREA', 'FEATURE_TYPE_PARK'] } }],
        pois: [{ point: [ORIGIN.lng, ORIGIN.lat + 0.001] as [number, number], properties: { types: ['FEATURE_TYPE_POI', 'FEATURE_TYPE_LODGING'], name: 'A Hotel' } }],
        modeledVolumes: [{ id: '17/1/1/f9/m0', vertices: [...tri1, ...tri2].map(([lng, lat]) => [lng, lat, 12] as [number, number, number]), indices: [0, 1, 2, 3, 4, 5], heightMeters: 12 }]
    };
    const empty = { buildings: [], buildingFootprints2D: [], water: [], roads: [], rails: [], landuse: [], pois: [], modeledVolumes: [] };
    return async (x: number, y: number) => (x === home.x && y === home.y ? features : empty) as never;
}

describe('vector overlay projection', () => {
    it('places Google features in the scan frame (x east, z south) where LocalTangentPlane puts them', async () => {
        const ev = await fetchVectorEvidence({ ...ORIGIN, radiusM: 60, fetchTile: standInTiles() });
        const o = overlayFromEvidence(ev, { ...ORIGIN, radiusM: 60 });
        // 0.001 degrees north is about 111 m north: negative z
        const poi = o.pois[0];
        const expected = geoToScan(ORIGIN, ORIGIN.lat + 0.001, ORIGIN.lng);
        expect(poi.name).toBe('A Hotel');
        expect(poi.x).toBeCloseTo(expected[0], 6);
        expect(poi.z).toBeCloseTo(expected[1], 6);
        expect(poi.z).toBeLessThan(-110);
        expect(poi.z).toBeGreaterThan(-112);
        expect(Math.abs(poi.x)).toBeLessThan(0.01);
        // the road runs from z = 60 (south) to z = -60 (north) at x = 0
        expect(o.roads[0].points[0][0]).toBeCloseTo(0, 3);
        expect(o.roads[0].points[0][1]).toBeCloseTo(60, 3);
        expect(o.roads[0].types).toContain('FEATURE_TYPE_ROAD');
        // the extruded footprint keeps its square, metres for metres
        const fp = o.footprints.find(f => f.id.endsWith('f0'))!;
        expect(fp.heightM).toBe(30);
        const xs = fp.loops[0].map(p => p[0]), zs = fp.loops[0].map(p => p[1]);
        expect(Math.min(...xs)).toBeCloseTo(-40, 3); expect(Math.max(...xs)).toBeCloseTo(-20, 3);
        expect(Math.min(...zs)).toBeCloseTo(-40, 3); expect(Math.max(...zs)).toBeCloseTo(-20, 3);
        // areas carry their codes; water is an area like any other
        expect(o.areas.map(a => featureKey(a.types)).sort()).toEqual(['FEATURE_TYPE_PARK', 'FEATURE_TYPE_WATER']);
        expect(o.rails).toHaveLength(1);
        expect(o.carriageways).toEqual([]);
        expect(o.ground).toBeUndefined();
    });

    it('outlines a volume-only building by its plan triangles\' outer edges', async () => {
        const ev = await fetchVectorEvidence({ ...ORIGIN, radiusM: 60, fetchTile: standInTiles() });
        const vol = ev.buildings.find(b => b.id.endsWith('f9'))!;
        const loops = footprintLoops(vol);
        // one closed loop round the square, traced on the 0.5 m grid: the shared diagonal is inside and gives no edge
        expect(loops).toHaveLength(1);
        expect(loops[0]).toHaveLength(4);
        expect(perimeter(loops[0])).toBeGreaterThan(38);
        expect(perimeter(loops[0])).toBeLessThan(42);
        const xs = loops[0].map(p => p[0]);
        expect(Math.min(...xs)).toBeGreaterThan(19); expect(Math.max(...xs)).toBeLessThan(31);
    });

    it('traces overlapping plan pieces as one outline (roofs at several levels), a slanted wall as one edge', () => {
        const a: Array<[number, number]> = [[0, 0], [10, 0], [10, 10], [0, 10]], b: Array<[number, number]> = [[5, 5], [15, 5], [15, 15], [5, 15]];
        const union = planUnionOutline([[a], [b]], 0.5);
        expect(union).toHaveLength(1);
        expect(union[0]).toHaveLength(8);
        expect(perimeter(union[0])).toBeGreaterThan(58); // the union's perimeter is 60 m; the overlap's inner edges are not drawn
        expect(perimeter(union[0])).toBeLessThan(62);
        // a square turned 30 degrees: its staircase on the grid simplifies back to about four sides
        const c = 30 * Math.PI / 180, sq = [[-10, -10], [10, -10], [10, 10], [-10, 10]].map(([x, z]) => [x * Math.cos(c) - z * Math.sin(c), x * Math.sin(c) + z * Math.cos(c)] as [number, number]);
        const turned = planUnionOutline([[sq]], 0.5);
        // a courtyard (a part's inner loop) stays open: two loops
        const ring = planUnionOutline([[[[0, 0], [20, 0], [20, 20], [0, 20]], [[5, 5], [15, 5], [15, 15], [5, 15]]]], 0.5);
        expect(ring).toHaveLength(2);
        // a speck beside it (a wall sliver seen from above) is not an outline
        expect(planUnionOutline([[[[0, 0], [20, 0], [20, 20], [0, 20]]], [[[30, 0], [32, 0], [32, 2]]]], 0.5)).toHaveLength(1);
        expect(turned).toHaveLength(1);
        expect(turned[0].length).toBeLessThanOrEqual(8);
        expect(perimeter(turned[0])).toBeGreaterThan(78);
        expect(perimeter(turned[0])).toBeLessThan(84);
    });

    it('measures the carriageway on the scan: kerbs 5 m either side of the centreline, ground at the street', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-map-scan-'));
        try {
            // a 120 m street along z, 10 m kerb to kerb, sidewalks 0.15 m up, ground at y = 3
            const step = 0.5, n = 241, pos: number[] = [], idx: number[] = [];
            for (let k = 0; k < n; k++) for (let i = 0; i < n; i++) {
                const x = -60 + i * step, z = -60 + k * step;
                pos.push(x, 3 + (Math.abs(x) > 5 ? 0.15 : 0), z);
            }
            for (let k = 0; k + 1 < n; k++) for (let i = 0; i + 1 < n; i++) { const a = k * n + i; idx.push(a, a + n, a + 1, a + 1, a + n, a + n + 1); }
            const scan = path.join(dir, 'scan.glb');
            writeStagedGlbFile(scan, [{ name: 'scan', positions: new Float32Array(pos), indices: new Uint32Array(idx) }]);
            const ev = await fetchVectorEvidence({ ...ORIGIN, radiusM: 60, fetchTile: standInTiles() });
            const o = overlayFromEvidence(ev, { ...ORIGIN, radiusM: 60, scanPath: scan });
            expect(o.carriageways.length).toBeGreaterThan(0);
            const st = o.carriageways.flatMap(c => c.stations).filter(s => s.leftMeasured && s.rightMeasured);
            expect(st.length).toBeGreaterThan(10);
            const widths = st.map(s => s.left + s.right).sort((a, b) => a - b);
            expect(widths[Math.floor(widths.length / 2)]).toBeGreaterThan(9);
            expect(widths[Math.floor(widths.length / 2)]).toBeLessThan(11);
            for (const s of st) expect(s.y).toBeGreaterThan(2.9);
            // the ground the overlay drapes on is the street's level
            const at = groundSampler(o.ground);
            expect(at(0, 0)).toBeGreaterThan(2.9);
            expect(at(0, 0)).toBeLessThan(3.3);
            expect(o.provenance.widths).toMatch(/measured kerb to kerb/);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
});

describe('roadmap tiles and draping', () => {
    it('covers the place with whole tiles whose corners meet', () => {
        const tiles = roadmapTilesFor(ORIGIN, 200, 18);
        expect(tiles.length).toBeGreaterThanOrEqual(9);
        expect(tiles.length).toBeLessThanOrEqual(36);
        const xs = tiles.flatMap(t => t.corners.map(c => c[0])), zs = tiles.flatMap(t => t.corners.map(c => c[1]));
        expect(Math.min(...xs)).toBeLessThanOrEqual(-200); expect(Math.max(...xs)).toBeGreaterThanOrEqual(200);
        expect(Math.min(...zs)).toBeLessThanOrEqual(-200); expect(Math.max(...zs)).toBeGreaterThanOrEqual(200);
        // a tile is about 2 * pi * R * cos(lat) / 2^18 wide (~115 m here), its north-west corner north-west of its south-east
        const t = tiles[0];
        expect(t.corners[1][0] - t.corners[0][0]).toBeGreaterThan(110);
        expect(t.corners[1][0] - t.corners[0][0]).toBeLessThan(120);
        expect(t.corners[3][1]).toBeGreaterThan(t.corners[0][1]);
        // neighbours share an edge
        const right = tiles.find(u => u.x === t.x + 1 && u.y === t.y)!;
        expect(right.corners[0][0]).toBeCloseTo(t.corners[1][0], 6);
        expect(right.corners[0][1]).toBeCloseTo(t.corners[1][1], 6);
    });

    it('samples the ground bilinearly and fills unmeasured cells from the nearest measured one', () => {
        const h = new Float32Array([0, 2, 4, 6, 8, NaN, 10, 12, 14]);
        const g: MapGroundGrid = { x0: 0, z0: 0, nx: 3, nz: 3, cellM: 2, heightsB64: encodeFloat32B64(h), method: 'test' };
        const at = groundSampler(g);
        expect(at(1, 1)).toBeCloseTo(0, 6); // a cell centre
        expect(at(2, 1)).toBeCloseTo(1, 6); // halfway between 0 and 2
        expect(Number.isFinite(at(5, 3))).toBe(true); // on the hole: never NaN
        expect(at(5, 3)).toBeGreaterThan(3);
        expect(at(-50, -50)).toBe(8); // far outside: the measured median, never 0
        expect(groundSampler(undefined, 7)(1, 1)).toBe(7);
    });

    it('densifies lines and builds the carriageway strip at the measured half-widths', () => {
        const d = densify([[0, 0], [10, 0]], 3);
        expect(d).toHaveLength(5);
        expect(d[4]).toEqual([10, 0]);
        const strip = carriagewayStrip([
            { x: 0, z: 0, nx: -1, nz: 0, y: 2, left: 4, right: 6, leftMeasured: true, rightMeasured: false },
            { x: 0, z: -10, nx: -1, nz: 0, y: 2, left: 4, right: 6, leftMeasured: true, rightMeasured: true }
        ], 0.3);
        [-4, 2.3, 0, 6, 2.3, 0].forEach((v, i) => expect(strip.positions[i]).toBeCloseTo(v, 5));
        expect(strip.indices).toHaveLength(6);
    });
});
