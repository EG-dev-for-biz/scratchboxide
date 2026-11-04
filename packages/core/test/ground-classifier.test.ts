/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The ground classifier (ground-classifier.ts) and its area priors (ground-area-priors.ts) on a district with known truth:
 * a fresh green lawn and an olive lawn inside a Google park outline, a mint-green panel (a footbridge roof's colour, the
 * same CIELAB as the lawn) on open ground off every planted area, green paint in a parking lot, a carriageway, a building
 * footprint, a water area, a tree crown and a grey raised structure. The lawns must be grass (the olive one too, which
 * the old a* test missed), the panel and the paint held back and reported, and every cell labelled by its scores.
 */

import { describe, expect, it } from 'vitest';
import { classifyGround, vegetationColourScore, GROUND_LABELS } from '../src/node/3d-engine/staged-location/ground-classifier';
import { areaPriorOf, areaPriorRasters, GOOGLE_AREA_PRIORS } from '../src/node/3d-engine/staged-location/ground-area-priors';
import { detectGrass, grassOverlay } from '../src/node/3d-engine/staged-location/grass-detect';
import type { GroundModel } from '../src/node/spatial/StreetViewSurveyPlanner';
import type { TopDownPhoto } from '../src/node/3d-engine/staged-location/top-down-photo';
import type { VectorEvidence } from '../src/node/3d-engine/staged-location/vector-footprints';

const N = 60, TEXEL = 0.25;
type Rect = [number, number, number, number];
const inR = (x: number, z: number, [x0, z0, x1, z1]: Rect) => x >= x0 && x < x1 && z >= z0 && z < z1;
const PARK: Rect = [2, 2, 30, 26], LAWN: Rect = [4, 4, 14, 24], OLIVE: Rect = [16, 4, 28, 24];
const PANEL: Rect = [34, 4, 44, 12], LOT: Rect = [34, 16, 56, 26], PAINT: Rect = [40, 18, 48, 24];
const BUILDING: Rect = [4, 32, 16, 44], POND: Rect = [20, 32, 30, 42], CROWN: Rect = [34, 32, 42, 40], STRUCTURE: Rect = [46, 32, 54, 40];
const ROAD_Z = 50;
const loop = ([x0, z0, x1, z1]: Rect): Array<[number, number]> => [[x0, z0], [x1, z0], [x1, z1], [x0, z1]];

// sRGB colours: fresh lawn, olive lawn (CIELAB about a* -4, b* +20: an NYC park lawn in the tiles), mint panel, grey
const FRESH = [70, 130, 45], OLIVE_RGB = [86, 86, 50], MINT = [120, 175, 125], GREY = [140, 138, 132];

function scene() {
    const M = N * N, top = new Float32Array(M), gh = new Float32Array(M).fill(5);
    for (let k = 0; k < N; k++) for (let i = 0; i < N; i++) {
        const x = i + 0.5, z = k + 0.5, c = k * N + i;
        top[c] = inR(x, z, BUILDING) ? 25 : inR(x, z, CROWN) ? 14 : inR(x, z, STRUCTURE) ? 9 : 5.05;
    }
    const px = N / TEXEL, rgba = new Uint8Array(px * px * 4);
    for (let y = 0; y < px; y++) for (let x = 0; x < px; x++) {
        const wx = (x + 0.5) * TEXEL, wz = (y + 0.5) * TEXEL, n = ((x * 7 + y * 13) % 9) - 4;
        const c = inR(wx, wz, LAWN) || inR(wx, wz, CROWN) || inR(wx, wz, POND) ? FRESH : inR(wx, wz, OLIVE) ? OLIVE_RGB : inR(wx, wz, PANEL) || inR(wx, wz, PAINT) ? MINT : GREY;
        rgba.set([c[0] + n, c[1] + n, c[2] + n, 255], (y * px + x) * 4);
    }
    const ground = {
        cellMeters: 1, x0: 0, z0: 0, nx: N, nz: N, top, ground: gh,
        cellIndex: (x: number, z: number) => Math.floor(z) * N + Math.floor(x), groundAt: () => 5, topAt: (x: number, z: number) => top[Math.floor(z) * N + Math.floor(x)]
    } as unknown as GroundModel;
    const ev: VectorEvidence = {
        buildings: [], water: [[loop(POND)]], roads: [[[0, ROAD_Z], [N, ROAD_Z]]], tiles: 1, zoom: 17,
        landuse: [
            { loops: [loop([0, 0, N, N])], types: ['FEATURE_TYPE_NATURAL', 'FEATURE_TYPE_LAND_COVER', 'FEATURE_TYPE_LANDSAT_VEGETATION'] },
            { loops: [loop(PARK)], types: ['FEATURE_TYPE_POI', 'FEATURE_TYPE_OUTDOOR_AREA', 'FEATURE_TYPE_PARK'] },
            { loops: [loop(LOT)], types: ['FEATURE_TYPE_POI', 'FEATURE_TYPE_SERVICES', 'FEATURE_TYPE_PARKING_LOT'] }
        ]
    };
    const building = new Int32Array(M), water = new Uint8Array(M), road = new Uint8Array(M);
    for (let k = 0; k < N; k++) for (let i = 0; i < N; i++) {
        const c = k * N + i;
        if (inR(i + 0.5, k + 0.5, BUILDING)) building[c] = 1;
        if (inR(i + 0.5, k + 0.5, POND)) water[c] = 1;
        if (Math.abs(k + 0.5 - ROAD_Z) <= 3) road[c] = 1;
    }
    return { photo: { width: px, height: px, rgba, texelM: TEXEL, triangles: 0 } as TopDownPhoto, ground, ev, raster: { building, water, road } };
}

describe('ground classifier (scan + photo + Google vector priors)', () => {
    const { photo, ground, ev, raster } = scene();
    const frame = { x0: 0, z0: 0, widthM: N, heightM: N };
    const priors = areaPriorRasters(ev, ground);
    const cls = classifyGround(photo, frame, ground, { raster, priors });
    const lab = (x: number, z: number) => GROUND_LABELS[cls.label[z * N + x]];

    it('scores olive and fresh lawn colours as vegetation, mint less so only by the area, grey and brown not at all', () => {
        expect(vegetationColourScore(49, -32, 37)).toBe(1);        // fresh lawn
        expect(vegetationColourScore(34, -3.5, 21)).toBe(1);       // olive NYC lawn (missed by a* <= -5)
        expect(vegetationColourScore(65, -12.7, 10)).toBe(1);      // mint footbridge roof: colour alone cannot tell
        expect(vegetationColourScore(58, 0.5, 2)).toBe(0);         // grey
        expect(vegetationColourScore(50, 6, 18)).toBe(0);          // brown path
    });

    it('reads Google area codes as priors: most specific code with an entry, overlaps take the highest, coarse cover no opinion', () => {
        expect(areaPriorOf(['FEATURE_TYPE_POI', 'FEATURE_TYPE_OUTDOOR_AREA', 'FEATURE_TYPE_PARK'])).toBe(GOOGLE_AREA_PRIORS.FEATURE_TYPE_PARK);
        expect(areaPriorOf(['FEATURE_TYPE_NATURAL', 'FEATURE_TYPE_LAND_COVER', 'FEATURE_TYPE_LANDSAT_VEGETATION'])).toBeUndefined();
        expect(areaPriorOf(['SOMETHING_NEW'])).toBeUndefined();
        expect(priors.vegetation[10 * N + 10]).toBe(1);             // park over the land cover
        expect(Number.isNaN(priors.vegetation[8 * N + 38])).toBe(true); // the panel: no area with an opinion
        expect(priors.paved[20 * N + 44]).toBe(1);                  // parking lot
        expect(priors.used.map(u => u.code).sort()).toEqual(['FEATURE_TYPE_PARK', 'FEATURE_TYPE_PARKING_LOT']);
    });

    it('labels every kind of cell by its scores', () => {
        expect(lab(8, 10)).toBe('low-vegetation');
        expect(lab(20, 10)).toBe('low-vegetation');
        expect(lab(10, 38)).toBe('building');
        expect(lab(25, 36)).toBe('water');
        expect(lab(38, 36)).toBe('tree-canopy');
        expect(lab(50, 36)).toBe('raised-structure');
        expect(lab(10, ROAD_Z)).toBe('paved');
        expect(lab(44, 20)).toBe('paved');                          // green paint in the parking lot
        expect(lab(38, 8)).toBe('raised-structure');                // green panel off every planted area
        expect(cls.stats.greenOffPlantedM2).toBeGreaterThanOrEqual(10 * 8);
        expect(cls.prior.source).toBe('google-vector');
        const total = Object.values(cls.stats.areaM2).reduce((a, b) => a + b, 0);
        expect(total).toBe(N * N);
    });

    it('gives detectGrass both lawns and holds back the panel and the paint, which the photo alone would take', () => {
        const g = detectGrass(photo, frame, ground, undefined, { water: raster.water, building: raster.building, classification: cls });
        const m = (x: number, z: number) => g.mask[z * N + x];
        expect(m(8, 10)).toBe(1);
        expect(m(20, 10)).toBe(1);
        expect(m(38, 8)).toBe(0);
        expect(m(44, 20)).toBe(0);
        expect(g.heldBack[8 * N + 38]).toBe(1);
        expect(g.heldBack[20 * N + 44]).toBe(2);
        expect(g.stats.offPlanted).toBeGreaterThanOrEqual(10 * 8 - 4);
        expect(g.stats.paved).toBeGreaterThanOrEqual(8 * 6 - 4);
        expect(g.provenance.method).toContain('Google land-use priors');
        // the photo and the scan alone take all of it, the panel and the paint too
        const blind = detectGrass(photo, frame, ground);
        expect(blind.mask[8 * N + 38]).toBe(1);
        expect(blind.mask[20 * N + 44]).toBe(1);
        expect(blind.mask[10 * N + 20]).toBe(1);
        // the overlay paints the held-back cells orange
        const ov = grassOverlay(photo, frame, g);
        const o = (Math.floor(8 / TEXEL) * photo.width + Math.floor(38 / TEXEL)) * 4;
        expect(ov[o]).toBeGreaterThan(ov[o + 2] + 100);
    });

    it('takes open ground at the terrain inside a footprint (a lawn over an underground structure) as ground, a standing one as building', () => {
        // the vector footprint grows over the olive lawn; the scan shows nothing standing there
        const wide = { ...raster, building: Int32Array.from(raster.building) };
        for (let k = 4; k < 24; k++) for (let i = 16; i < 28; i++) wide.building[k * N + i] = 2;
        const c2 = classifyGround(photo, frame, ground, { raster: wide, priors });
        expect(GROUND_LABELS[c2.label[10 * N + 20]]).toBe('low-vegetation');
        expect(GROUND_LABELS[c2.label[38 * N + 10]]).toBe('building');
        expect(c2.stats.openInFootprintM2).toBe(12 * 20);
        const g = detectGrass(photo, frame, ground, undefined, { water: raster.water, building: wide.building, classification: c2 });
        expect(g.mask[10 * N + 20]).toBe(1);
    });
});
