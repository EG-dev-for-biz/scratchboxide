/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The vector evidence carries the tiles' context, not only the buildings: land-use areas with their type codes, named
 * points of interest and the type codes of each road, all in the scan frame, with a land-use point lookup. The tile
 * stand-in answers in the decoder's own shape (google-feature-tile-decoder.ts: `properties.types`, a POI's
 * `properties.name`), as the live featuretiles did at the Flatiron and Fallingwater on 2026-10-23.
 */

import { describe, expect, it } from 'vitest';
import { evidenceLookup, fetchVectorEvidence } from '../src/node/3d-engine/staged-location/vector-footprints';

const LAT = 40.7411, LNG = -73.9897;
/** A square about `m` metres on a side, `ex` metres east and `sz` metres south of the origin, as [lng, lat] ring. */
const square = (ex: number, sz: number, m: number): Array<[number, number]> => {
    const dLat = 1 / 111_320, dLng = 1 / (111_320 * Math.cos((LAT * Math.PI) / 180));
    const x0 = LNG + (ex - m / 2) * dLng, x1 = LNG + (ex + m / 2) * dLng, y0 = LAT - (sz + m / 2) * dLat, y1 = LAT - (sz - m / 2) * dLat;
    return [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
};

describe('vector evidence context', () => {
    it('carries land-use areas, named POIs and road types into the scan frame, with a land-use lookup', async () => {
        const ev = await fetchVectorEvidence({
            lat: LAT, lng: LNG, radiusM: 10,
            fetchTile: async () => ({
                buildings: [{ id: '17/1/1/f1', ring: square(-40, 0, 20), properties: { heightMeters: 12 } }],
                water: [],
                roads: [{ points: [[LNG - 0.001, LAT], [LNG + 0.001, LAT]], properties: { types: ['FEATURE_TYPE_INFRASTRUCTURE', 'FEATURE_TYPE_ROAD'] } }],
                landuse: [{ ring: square(40, 40, 30), properties: { types: ['FEATURE_TYPE_POI', 'FEATURE_TYPE_OUTDOOR_AREA', 'FEATURE_TYPE_PARK'] } }],
                pois: [
                    { point: [LNG, LAT], properties: { types: ['FEATURE_TYPE_POI', 'FEATURE_TYPE_ENTERTAINMENT', 'FEATURE_TYPE_HISTORIC'], name: 'Flatiron Building' } },
                    { point: [LNG, LAT], properties: { types: ['FEATURE_TYPE_POI'], name: '   ' } }
                ]
            })
        });
        expect(ev.buildings).toHaveLength(1);
        // the 10 m square straddles a tile edge here, so the stand-in answers for each tile: one set of types per road line
        expect(ev.roadTypes).toHaveLength(ev.roads.length);
        expect(ev.roadTypes!.every(t => t.join() === 'FEATURE_TYPE_INFRASTRUCTURE,FEATURE_TYPE_ROAD')).toBe(true);
        expect(ev.landuse!.length).toBe(ev.tiles);
        expect(ev.landuse![0].types).toContain('FEATURE_TYPE_PARK');
        // the park's loop is in metres east / south of the origin
        const [xs, zs] = [ev.landuse![0].loops[0].map(p => p[0]), ev.landuse![0].loops[0].map(p => p[1])];
        expect(Math.min(...xs)).toBeCloseTo(25, 0); expect(Math.max(...xs)).toBeCloseTo(55, 0);
        expect(Math.min(...zs)).toBeCloseTo(25, 0); expect(Math.max(...zs)).toBeCloseTo(55, 0);
        // a POI keeps its name; a blank name is dropped, the point kept
        expect(ev.pois).toHaveLength(2 * ev.tiles);
        expect(ev.pois![0]).toMatchObject({ name: 'Flatiron Building', types: ['FEATURE_TYPE_POI', 'FEATURE_TYPE_ENTERTAINMENT', 'FEATURE_TYPE_HISTORIC'] });
        expect(Math.hypot(ev.pois![0].x, ev.pois![0].z)).toBeLessThan(0.5);
        expect(ev.pois![1].name).toBeUndefined();
        // the lookup answers the area's codes inside it and nothing outside; buildings and roads are unchanged by it
        const look = evidenceLookup(ev, 60);
        expect(look.landuseAt(40, 40)).toContain('FEATURE_TYPE_PARK');
        expect(look.landuseAt(0, 0)).toBeUndefined();
        expect(look.landuseAt(-40, 0)).toBeUndefined();
        expect(look.buildingAt(-40, 0)).toBe(1);
        expect(look.roadAt(0, 0)).toBe(true);
    });

    it('answers no context when a tile carries none (older stand-ins and tiles without the layers)', async () => {
        const ev = await fetchVectorEvidence({ lat: LAT, lng: LNG, radiusM: 10, fetchTile: async () => ({ buildings: [], water: [], roads: [{ points: [[LNG, LAT], [LNG + 0.001, LAT]] }] }) });
        expect(ev.landuse).toEqual([]);
        expect(ev.pois).toEqual([]);
        expect(ev.roadTypes).toEqual(ev.roads.map(() => []));
        expect(evidenceLookup(ev, 30).landuseAt(0, 0)).toBeUndefined();
    });
});
