/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * One building two feature tiles carry is one building in the vector evidence. Google's featuretiles name features by
 * the tile (z/x/y/f<i>) and carry a modelled volume whole into every tile it reaches, so a building on a tile edge
 * arrived twice; the copy rasterised last took the cells they shared and left the other a sliver. At the Ferry Building
 * (2026-11-02) that made the footprint under the place a 376 m² strip and put the clock tower under "another building",
 * so the pick, tile_refine's isolate and the footprint clip all cut through the tower.
 */

import { describe, expect, it } from 'vitest';
import { evidenceLookup, fetchVectorEvidence, mergeTileCopies, type VectorBuilding } from '../src/node/3d-engine/staged-location/vector-footprints';

const LAT = 40.7411, LNG = -73.9897;
const dLat = 1 / 111_320, dLng = 1 / (111_320 * Math.cos((LAT * Math.PI) / 180));
/** A rectangle `w` x `d` metres centred `ex` metres east and `sz` metres south of the origin, as a [lng, lat] ring. */
const rect = (ex: number, sz: number, w: number, d: number): Array<[number, number]> => {
    const x0 = LNG + (ex - w / 2) * dLng, x1 = LNG + (ex + w / 2) * dLng, y0 = LAT - (sz + d / 2) * dLat, y1 = LAT - (sz - d / 2) * dLat;
    return [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
};
/** The rectangle as a flat modelled volume of two triangles at height h (the decoder's [lng, lat, h] vertices). */
const volume = (id: string, ring: Array<[number, number]>, h: number) => ({ id, vertices: ring.map(([x, y]): [number, number, number] => [x, y, h]), indices: [0, 1, 2, 0, 2, 3], heightMeters: h });
/** A square building in the scan frame (x east, z south), metres. */
const square = (id: string, x: number, z: number, m: number): VectorBuilding => ({ id, parts: [[[[x - m / 2, z - m / 2], [x + m / 2, z - m / 2], [x + m / 2, z + m / 2], [x - m / 2, z + m / 2]]]] });

describe('vector building copies across feature tiles', () => {
    it('merges the copies of one building that every tile names by itself, so its whole plan is one footprint', async () => {
        const ev = await fetchVectorEvidence({
            lat: LAT, lng: LNG, radiusM: 10,
            // every tile carries the building whole, under its own tile-scoped id; one tile carries it at a coarser detail
            fetchTile: async (x, y, z) => ({
                buildings: [], water: [], roads: [],
                modeledVolumes: [volume(`${z}/${x}/${y}/f${x % 2 ? 3 : 7}/m0`, x % 2 ? rect(0, 0, 40, 30) : rect(-2, 0, 36, 30), 20)]
            })
        });
        expect(ev.tiles).toBeGreaterThanOrEqual(2);
        expect(ev.buildings).toHaveLength(1);
        // every copy's geometry is kept on the one building
        expect(ev.buildings[0].volumes).toHaveLength(ev.tiles);
        // the raster gives the whole plan, both copies' cells, the one index (before: the copy drawn last took them)
        const look = evidenceLookup(ev, 40);
        const at = [[-19, 0], [0, 0], [19, 0], [0, -14], [0, 14]].map(([x, z]) => look.buildingAt(x, z));
        expect(new Set(at)).toEqual(new Set([1]));
        expect(look.buildingAt(25, 0)).toBe(0);
    });

    it('keeps apart neighbours that only touch, buildings of one tile, and a small overlap', () => {
        const out = mergeTileCopies([
            square('17/1/1/f1', 0, 0, 20),
            // the neighbour in the next tile, wall to wall
            square('17/2/1/f4', 20, 0, 20),
            // a second building in the first tile overlapping the first: the tile draws them apart, they stay apart
            square('17/1/1/f2', 5, 0, 10),
            // a building in another tile overlapping the first by 10% of its plan: not a copy
            square('17/3/1/f9', -18, 0, 20)
        ]);
        expect(out.map(b => b.id)).toEqual(['17/1/1/f1', '17/2/1/f4', '17/1/1/f2', '17/3/1/f9']);
    });

    it('merges a copy that holds the other copy, its parts and its height', () => {
        const a: VectorBuilding = { ...square('17/1/1/f1', 0, 0, 30), heightM: 20, extruded: [{ loops: square('x', 0, 0, 30).parts[0], heightM: 20 }] };
        const b: VectorBuilding = { ...square('17/2/1/f5', 2, 0, 20), heightM: 71 };
        const [m, ...rest] = mergeTileCopies([a, b]);
        expect(rest).toHaveLength(0);
        expect(m.id).toBe('17/1/1/f1');
        expect(m.parts).toHaveLength(2);
        expect(m.heightM).toBe(71);
        expect(m.extruded).toHaveLength(1);
        // the inputs are not changed
        expect(a.parts).toHaveLength(1);
    });
});
