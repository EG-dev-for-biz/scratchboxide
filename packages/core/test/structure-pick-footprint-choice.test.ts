/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The structure pick took a footprint a fraction of the building's size at three landmarks (2026-11-04: the Flatiron
 * 116 m² of 375 m² isolated, the Dakota 266 m² of 621 m², the Helmsley Building 1,285 m² of 3,120 m²), each for a
 * different reason, reproduced here on synthetic scans and vector data:
 *
 * - a building over a vector tile edge came as one feature per tile, overlapping along the edge; the last drawn took the
 *   cells they share and the pick stopped at the other piece as at a neighbour's party wall (the Flatiron);
 * - a road running under a building (through its portals) cut its raised cells apart (the Helmsley Building);
 * - a place geocoded into its own courtyard had no footprint under it, and a hotel whose long name shared only the city
 *   with the request won the POI match over the place's own POI (the Dakota).
 */

import { describe, it, expect, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { chooseFootprint, pickStructure, PICK_STRUCTURE } from '../src/node/3d-engine/staged-location/extraction-sizing';
import { evidenceLookup, fetchVectorEvidence, mergeTilePieces, type VectorBuilding, type VectorEvidence } from '../src/node/3d-engine/staged-location/vector-footprints';
import { writeStagedGlbFile } from '../src/node/3d-engine/staged-location/staged-glb-writer';
import { buildGroundModel, loadScanMesh } from '../src/node/spatial/StreetViewSurveyPlanner';
import type { Vec2 } from '../src/common/spatial/staged-location-contracts';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'sbx-pick-choice-'));
afterAll(() => fs.rmSync(TMP, { recursive: true, force: true }));

type Tri = number[];
const quad = (a: number[], b: number[], c: number[], d: number[]): Tri[] => [[...a, ...b, ...c], [...a, ...c, ...d]];
/** A closed box from the ground to `h`, walls in 2 m panels, the roof in 2 m quads. */
function box(x0: number, x1: number, z0: number, z1: number, h: number): Tri[] {
    const out: Tri[] = [];
    const wall = (ax: number, az: number, bx: number, bz: number) => {
        const n = Math.max(1, Math.ceil(Math.hypot(bx - ax, bz - az) / 2));
        for (let i = 0; i < n; i++) {
            const p = ax + ((bx - ax) * i) / n, q = az + ((bz - az) * i) / n, r = ax + ((bx - ax) * (i + 1)) / n, s = az + ((bz - az) * (i + 1)) / n;
            for (let y = 0; y < h; y += 2) out.push(...quad([p, y, q], [r, y, s], [r, Math.min(h, y + 2), s], [p, Math.min(h, y + 2), q]));
        }
    };
    wall(x0, z0, x1, z0); wall(x1, z0, x1, z1); wall(x1, z1, x0, z1); wall(x0, z1, x0, z0);
    for (let x = x0; x < x1; x += 2) for (let z = z0; z < z1; z += 2) out.push(...quad([x, h, z], [Math.min(x1, x + 2), h, z], [Math.min(x1, x + 2), h, Math.min(z1, z + 2)], [x, h, Math.min(z1, z + 2)]));
    return out;
}
function plane(x0: number, x1: number, z0: number, z1: number): Tri[] {
    const out: Tri[] = [];
    for (let x = x0; x < x1; x += 4) for (let z = z0; z < z1; z += 4) out.push(...quad([x, 0, z], [x + 4, 0, z], [x + 4, 0, z + 4], [x, 0, z + 4]));
    return out;
}
function scanOf(name: string, tris: Tri[]) {
    const file = path.join(TMP, name);
    writeStagedGlbFile(file, [{ positions: Float32Array.from(tris.flat()) }]);
    const scan = loadScanMesh(file);
    return { scan, ground: buildGroundModel(scan, { cellMeters: 1 }) };
}
const rect = (x0: number, z0: number, x1: number, z1: number): Vec2[] => [[x0, z0], [x1, z0], [x1, z1], [x0, z1]];

describe('a building over a vector tile edge is one building (the Flatiron)', () => {
    // a 40 x 20 m, 80 m tower across the edge x = 0 between tile W (x < 0) and tile E (x > 0); each tile draws its piece
    // 12 m past its edge, and E's is drawn last
    const tileW = rect(-200, -200, 0, 200), tileE = rect(0, -200, 200, 200);
    const west: VectorBuilding = { id: '17/1/1/f63', parts: [[rect(-20, -10, 12, 10)]], heightM: 80 };
    const east: VectorBuilding = { id: '17/2/1/f70', parts: [[rect(-12, -10, 20, 10)]], heightM: 80 };
    // neighbours: one wholly in W against the tower's west wall, and two meeting at a party wall on the tile edge
    const nextDoor: VectorBuilding = { id: '17/1/1/f10', parts: [[rect(-40, -10, -20, 10)]] };
    const partyW: VectorBuilding = { id: '17/1/1/f11', parts: [[rect(-10, 20, 0, 40)]] };
    const partyE: VectorBuilding = { id: '17/2/1/f12', parts: [[rect(0, 20, 10, 40)]] };
    const { scan, ground } = scanOf('tile_edge.glb', [...plane(-60, 60, -60, 60), ...box(-20, 20, -10, 10, 80), ...box(-40, -20, -10, 10, 20)]);

    it('reproduces the sliver: the chosen piece keeps only what the other piece did not draw over', () => {
        const ev: VectorEvidence = { buildings: [nextDoor, west, east], water: [], roads: [], tiles: 2, zoom: 17 };
        const L = evidenceLookup(ev, 60);
        const choice = chooseFootprint({ buildings: ev.buildings, anchor: { x: -16, z: 0 } })!;
        expect(choice).toMatchObject({ by: 'under-place', featureId: '17/1/1/f63' });
        const pick = pickStructure(scan, ground, { anchor: { x: -16, z: 0 }, footprints: { buildingAt: L.buildingAt, buildings: ev.buildings, choice } })!;
        expect(pick.areaM2).toBeLessThan(0.4 * 40 * 20);
    });

    it('puts the pieces together, keeps neighbours apart, and the pick takes the whole tower', () => {
        const merged = mergeTilePieces([nextDoor, west, east, partyW, partyE].map(b => ({ building: b, tile: b.id.startsWith('17/1/') ? tileW : tileE })));
        expect(merged.map(b => b.id).sort()).toEqual(['17/1/1/f10', '17/1/1/f11', '17/1/1/f63', '17/2/1/f12']);
        const tower = merged.find(b => b.id === '17/1/1/f63')!;
        expect(tower.pieces).toEqual(['17/1/1/f63', '17/2/1/f70']);
        expect(tower.parts).toHaveLength(2);
        expect(tower.heightM).toBe(80);
        const ev: VectorEvidence = { buildings: merged, water: [], roads: [], tiles: 2, zoom: 17 };
        const L = evidenceLookup(ev, 60);
        const choice = chooseFootprint({ buildings: ev.buildings, anchor: { x: -16, z: 0 } })!;
        const pick = pickStructure(scan, ground, { anchor: { x: -16, z: 0 }, footprints: { buildingAt: L.buildingAt, buildings: ev.buildings, choice } })!;
        expect(pick.vectorFootprint).toMatchObject({ used: true, featureIds: ['17/1/1/f63'] });
        expect(pick.areaM2).toBeGreaterThan(0.95 * 40 * 20);
        expect(pick.bounds.minX).toBeGreaterThanOrEqual(-21);     // not the building next door
        expect(pick.bounds.maxX).toBeGreaterThanOrEqual(19);
    });

    it('puts them together in fetchVectorEvidence, from the tiles as Google serves them', async () => {
        const lat = 40.74106, lng = -73.989699, z = 17, n = 2 ** z;
        const tx = Math.floor(((lng + 180) / 360) * n), r = (lat * Math.PI) / 180;
        const ty = Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n);
        const edgeLng = ((tx + 1) / n) * 360 - 180, mPerLng = 111_320 * Math.cos(r);
        // [lng, lat] of a point `east` metres east of the tile edge and `north` metres north of the place
        const at = (east: number, north: number): [number, number] => [edgeLng + east / mPerLng, lat + north / 111_320];
        const ring = (e0: number, n0: number, e1: number, n1: number) => [at(e0, n0), at(e1, n0), at(e1, n1), at(e0, n1)];
        const tiles = new Map<string, any>([
            [`${tx}/${ty}`, { buildings: [{ id: `${z}/${tx}/${ty}/f3/e0`, ring: ring(-20, -10, 12, 10) }, { id: `${z}/${tx}/${ty}/f4/e0`, ring: ring(-10, 20, 0, 40) }], water: [], roads: [] }],
            [`${tx + 1}/${ty}`, { buildings: [{ id: `${z}/${tx + 1}/${ty}/f8/e0`, ring: ring(-12, -10, 20, 10) }, { id: `${z}/${tx + 1}/${ty}/f9/e0`, ring: ring(0, 20, 10, 40) }], water: [], roads: [] }]
        ]);
        const ev = await fetchVectorEvidence({ lat, lng: edgeLng, radiusM: 30, fetchTile: async (x, y) => tiles.get(`${x}/${y}`) ?? { buildings: [], water: [], roads: [] } });
        expect(ev.buildings).toHaveLength(3);
        const tower = ev.buildings.find(b => b.pieces)!;
        expect(tower.pieces!.sort()).toEqual([`${z}/${tx + 1}/${ty}/f8`, `${z}/${tx}/${ty}/f3`].sort());
    });
});

describe('a road under a building does not cut it (the Helmsley Building)', () => {
    it('keeps a building whole over the road through its portals, and still cuts at a road in the open', () => {
        // a 60 x 30 m block with a road along x = 0 running through its base; a second block across an open road at x = 50
        const { scan, ground } = scanOf('portal.glb', [...plane(-80, 80, -60, 60), ...box(-30, 30, -15, 15, 40), ...box(40, 60, -15, 15, 40), ...box(30, 40, -6, 6, 12)]);
        const ev: VectorEvidence = {
            buildings: [{ id: 'block', parts: [[rect(-30, -15, 30, 15)]] }, { id: 'across', parts: [[rect(40, -15, 60, 15)]] }],
            water: [], roads: [[[0, -60], [0, 60]], [[35, -60], [35, 60]]], tiles: 1, zoom: 17
        };
        const L = evidenceLookup(ev, 80);
        const choice = chooseFootprint({ buildings: ev.buildings, anchor: { x: -20, z: 0 } })!;
        const pick = pickStructure(scan, ground, { anchor: { x: -20, z: 0 }, footprints: { buildingAt: L.buildingAt, buildings: ev.buildings, choice }, roadAt: L.roadAt })!;
        expect(pick.footprintMask[ground.cellIndex(0.5, 0.5)]).toBe(PICK_STRUCTURE);
        expect(pick.bounds.minX).toBeLessThanOrEqual(-29);
        expect(pick.bounds.maxX).toBeGreaterThanOrEqual(29);
        expect(pick.areaM2).toBeGreaterThan(0.95 * 60 * 30);
        // the raised band over the open road at x = 35 stays out, and the block across it with it
        expect(pick.bounds.maxX).toBeLessThanOrEqual(33);
    });
});

describe('a place geocoded into its own courtyard (the Dakota)', () => {
    // a 60 x 60 m block round a 30 x 30 m courtyard; a hotel 100 m east whose POI name shares the city with the request
    const courtyardBlock: VectorBuilding = { id: 'block', parts: [[rect(-30, -30, 30, 30), rect(-15, -15, 15, 15)]] };
    const hotel: VectorBuilding = { id: 'hotel', parts: [[rect(90, -10, 110, 10)]] };
    const pois = [
        { x: 0, z: 0, types: ['FEATURE_TYPE_POI'], name: 'The Dakota' },
        { x: 100, z: 0, types: ['FEATURE_TYPE_POI'], name: 'La Quinta Inn & Suites by Wyndham New York City Central Park' }
    ];
    const placeName = 'The Dakota, 1 West 72nd Street, New York';

    it('chooses the block that surrounds the place, and the pick takes the whole ring', () => {
        const choice = chooseFootprint({ buildings: [courtyardBlock, hotel], pois, placeName })!;
        expect(choice).toMatchObject({ by: 'around-place', featureId: 'block' });
        const { scan, ground } = scanOf('courtyard.glb', [...plane(-60, 120, -60, 60), ...box(-30, 30, -30, -15, 25), ...box(-30, 30, 15, 30, 25), ...box(-30, -15, -15, 15, 25), ...box(15, 30, -15, 15, 25), ...box(90, 110, -10, 10, 30)]);
        const ev: VectorEvidence = { buildings: [courtyardBlock, hotel], water: [], roads: [], tiles: 1, zoom: 17, pois };
        const L = evidenceLookup(ev, 120);
        const pick = pickStructure(scan, ground, { footprints: { buildingAt: L.buildingAt, buildings: ev.buildings, choice } })!;
        expect(pick.vectorFootprint).toMatchObject({ used: true, featureIds: ['block'] });
        expect(pick.areaM2).toBeGreaterThan(0.95 * (60 * 60 - 30 * 30));
        expect(pick.bounds.maxX).toBeLessThanOrEqual(33);
    });

    it('matches the POI the request names, not one sharing only the city, when the place is in the street', () => {
        // the geocoded point in the street north of the block: under nothing, surrounded by nothing
        const choice = chooseFootprint({ buildings: [courtyardBlock, hotel], pois, placeName, anchor: { x: 0, z: -40 } })!;
        expect(choice).toMatchObject({ by: 'poi-name', featureId: 'block', poiName: 'The Dakota' });
        expect(choice.note).toMatch(/holds the POI named 'The Dakota', 2 of whose 2 name words/);
        // a request naming neither: the hotel's two city words of eleven do not name the place
        expect(chooseFootprint({ buildings: [courtyardBlock, hotel], pois, placeName: '1 West 72nd Street, New York', anchor: { x: 0, z: -40 } })).toMatchObject({ by: 'nearest', featureId: 'block' });
    });

    it('does not take a street canyon between two buildings for a courtyard', () => {
        const a: VectorBuilding = { id: 'a', parts: [[rect(-30, -30, -5, 30)]] }, b: VectorBuilding = { id: 'b', parts: [[rect(5, -30, 30, 30)]] };
        expect(chooseFootprint({ buildings: [a, b] })).toMatchObject({ by: 'nearest' });
    });
});
