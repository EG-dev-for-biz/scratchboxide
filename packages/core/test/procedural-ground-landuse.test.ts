/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The ground program reads Google's land-use areas as regions and decides each region's material from measurements (the
 * scan's roughness, the canopy, the carriageways, the photo's colour), never from the type code: the code rides along as a
 * label, and an unknown code works unchanged (AGENTS.md §1, the Alien Planet Test). No model, no network, no credentials.
 */

import { describe, expect, it } from 'vitest';
import { buildGroundProgram, buildGroundSurface, crownCanopyAt, groundCoverRegions, groundProgramNotes, landuseAreaAt, photoGreenness } from '../src/node/3d-engine/staged-location/procedural-ground';
import { evidenceLookup, type VectorEvidence } from '../src/node/3d-engine/staged-location/vector-footprints';
import type { TopDownPhoto } from '../src/node/3d-engine/staged-location/top-down-photo';

// a 80 x 40 m ground, z south: the west half (x < 40) a rough, planted area; the east half (x >= 40) flat and grey
const BOUNDS = { x0: 0, z0: 0, x1: 80, z1: 40 };
const WEST: Array<[number, number]> = [[0, 0], [40, 0], [40, 40], [0, 40]];
const EAST: Array<[number, number]> = [[40, 0], [80, 0], [80, 40], [40, 40]];

/** A deterministic height wobble (no Math.random): a pseudo-random field in [-a, a) from the cell indices. */
function wobble(x: number, z: number, a: number): number {
    const h = Math.sin(x * 12.9898 + z * 78.233) * 43758.5453;
    return (h - Math.floor(h)) * 2 * a - a;
}

const ground = {
    cellMeters: 1,
    groundAt: () => 0,
    // the west half's open surface is rough (±0.3 m), the east half's flat (±0.01 m); nothing stands anywhere
    topAt: (x: number, z: number) => (x < 40 ? wobble(Math.floor(x), Math.floor(z), 0.3) : wobble(Math.floor(x), Math.floor(z), 0.01))
};

function photoOf(texelM: number): TopDownPhoto {
    const width = Math.round(80 / texelM), height = Math.round(40 / texelM);
    const rgba = new Uint8Array(width * height * 4);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
        const o = (y * width + x) * 4;
        const west = x * texelM < 40;
        // a lawn (green) in the west, grey paving in the east
        rgba.set(west ? [70, 120, 50, 255] : [125, 125, 128, 255], o);
    }
    return { width, height, rgba, texelM, triangles: 0, ms: 0 };
}

function evidence(types: { west: string[]; east: string[] }): VectorEvidence {
    return { buildings: [], water: [], roads: [[[60, -10], [60, 50]]], landuse: [{ loops: [WEST], types: types.west }, { loops: [EAST], types: types.east }], tiles: 1, zoom: 17 };
}

describe('the ground program over two land-use areas', () => {
    const ev = evidence({ west: ['FEATURE_TYPE_PARK'], east: ['FEATURE_TYPE_PARKING_LOT'] });
    // evidenceLookup centres its grid on the origin; the areas here lie in the positive quadrant, inside radius 100
    const look = evidenceLookup(ev, 100);
    const within = () => true;
    const surf = buildGroundSurface({ ground, within, bounds: BOUNDS });
    const crowns = crownCanopyAt([{ x: 10, z: 10, radiusM: 6 }, { x: 25, z: 25, radiusM: 7 }]);
    const program = buildGroundProgram({
        ground, within, bounds: BOUNDS, surface: surf, areas: ev.landuse!, areaAt: landuseAreaAt(look), roadAt: look.roadAt, canopyAt: crowns,
        photo: { photo: photoOf(0.5), frame: surf.uvFrame }
    });
    const west = program.regions.find(r => r.area === 0)!, east = program.regions.find(r => r.area === 1)!;

    it('measures each area: extent, share, roughness, canopy, carriageway and photo colour', () => {
        expect(program.regions.length).toBe(2);  // every cell is on one of the two areas: no "off every area" region
        expect(west.labels).toEqual(['FEATURE_TYPE_PARK']);
        expect(east.labels).toEqual(['FEATURE_TYPE_PARKING_LOT']);
        expect(west.measure.areaM2).toBe(1600); expect(east.measure.areaM2).toBe(1600);
        expect(west.measure.shareOfExtraction).toBeCloseTo(0.5, 5);
        expect(west.measure.openShare).toBe(1); expect(east.measure.openShare).toBe(1);
        // the scan's own roughness: a ±0.3 m wobble reads as an RMS around 0.17 m; the flat half near 0
        expect(west.measure.roughnessM).toBeGreaterThan(0.1); expect(west.measure.roughnessM).toBeLessThan(0.3);
        expect(east.measure.roughnessM).toBeLessThan(0.01);
        // two crown discs (113 + 154 m²) of the west's 1600 m²; none in the east
        expect(west.measure.canopyShare).toBeGreaterThan(0.12); expect(west.measure.canopyShare).toBeLessThan(0.22);
        expect(east.measure.canopyShare).toBe(0);
        // the road centreline at x = 60 (±3 m) runs through the east only
        expect(east.measure.roadShare).toBeGreaterThan(0.1); expect(east.measure.roadShare).toBeLessThanOrEqual(0.25);
        expect(west.measure.roadShare).toBe(0);
        expect(west.measure.photo!.greenness).toBeGreaterThan(0.08);
        expect(Math.abs(east.measure.photo!.greenness)).toBeLessThan(0.01);
        expect(west.measure.photo!.texels).toBeGreaterThan(0);
    });

    it('decides the material from the measurements: vegetated and rough reads planted, flat and grey reads paved', () => {
        expect(west.material.planted).toBe(true);
        expect(west.material.vegetationScore).toBeGreaterThanOrEqual(0.5);
        expect(west.material.vegetationDensity).toBe(west.material.vegetationScore);
        expect(west.material.roughness).toBe(0.9);
        expect(east.material.planted).toBe(false);
        expect(east.material.vegetationScore).toBeLessThan(0.2);
        expect(east.material.vegetationDensity).toBe(0);
        expect(east.material.roughness).toBeGreaterThanOrEqual(0.55); expect(east.material.roughness).toBeLessThan(0.6);
        // the tint is the photo's own mean lit colour, labelled so
        expect(west.material.tintSource).toBe('photo'); expect(east.material.tintSource).toBe('photo');
        expect(west.material.tint[1]).toBeGreaterThan(west.material.tint[0]);
        expect(Math.abs(east.material.tint[0] - east.material.tint[1])).toBeLessThan(0.01);
        for (const r of program.regions) {
            expect(r.material.provenance).toBe('generated');
            expect(r.material.why).toContain('photo greenness');
            expect(r.material.why).toContain('canopy');
            expect(r.material.why).toContain('carriageway');
        }
    });

    it('gives every ground vertex its region and lists the type codes as labels', () => {
        expect(program.vertexRegion.length).toBe(surf.stats.vertices);
        const pos = surf.mesh.positions;
        let checked = 0;
        for (let v = 0; v < program.vertexRegion.length; v++) {
            const x = pos[v * 3], z = pos[v * 3 + 2];
            if (x === 40) continue;  // the shared edge: either area
            if (x === 80 || z === 40) { expect(program.vertexRegion[v]).toBe(-1); continue; }  // the outer rim lies past every area's filled cells
            expect(program.regions[program.vertexRegion[v]].area).toBe(x < 40 ? 0 : 1);
            checked++;
        }
        expect(checked).toBeGreaterThan(500);
        expect(program.landuse).toEqual({ areas: 2, typeCodes: ['FEATURE_TYPE_PARK', 'FEATURE_TYPE_PARKING_LOT'], outsideExtraction: 0 });
    });

    it('asks SB-Veggie to plant the planted regions only, with their loops and density', () => {
        const cover = groundCoverRegions(program, ev.landuse!);
        expect(cover.length).toBe(1);
        expect(cover[0].loops).toEqual([WEST]);
        expect(cover[0].density).toBe(west.material.vegetationDensity);
        expect(cover[0].areaM2).toBe(1600);
        expect(cover[0].labels).toEqual(['FEATURE_TYPE_PARK']);
    });

    it('notes each region honestly: area, labels, measurements, the material and why', () => {
        const notes = groundProgramNotes(program);
        expect(notes.length).toBe(2);
        expect(notes[0]).toMatch(/^land-use area 0 \[FEATURE_TYPE_PARK\]: 1,600 m² \(50% of the ground\)/);
        expect(notes[0]).toContain('planted: vegetation score');
        expect(notes[1]).toMatch(/^land-use area 1 \[FEATURE_TYPE_PARKING_LOT\]/);
        expect(notes[1]).toContain('paved: vegetation score');
        expect(notes[1]).toContain("tint the photo's mean lit colour");
    });
});

describe('an unknown type code', () => {
    it('flows through unchanged and the material still comes from the measurements', () => {
        const ev = evidence({ west: ['FEATURE_TYPE_SOMETHING_NEW'], east: ['FEATURE_TYPE_SOMETHING_NEW', 'FEATURE_TYPE_ALSO_NEW'] });
        const look = evidenceLookup(ev, 100);
        const surf = buildGroundSurface({ ground, within: () => true, bounds: BOUNDS });
        const known = buildGroundProgram({ ground, within: () => true, bounds: BOUNDS, surface: surf, areas: [{ loops: [WEST], types: ['FEATURE_TYPE_PARK'] }, { loops: [EAST], types: ['FEATURE_TYPE_PARKING_LOT'] }], areaAt: landuseAreaAt(look), roadAt: look.roadAt, photo: { photo: photoOf(0.5), frame: surf.uvFrame } });
        const unknown = buildGroundProgram({ ground, within: () => true, bounds: BOUNDS, surface: surf, areas: ev.landuse!, areaAt: landuseAreaAt(look), roadAt: look.roadAt, photo: { photo: photoOf(0.5), frame: surf.uvFrame } });
        expect(unknown.regions.map(r => r.labels)).toEqual([['FEATURE_TYPE_SOMETHING_NEW'], ['FEATURE_TYPE_SOMETHING_NEW', 'FEATURE_TYPE_ALSO_NEW']]);
        expect(unknown.landuse.typeCodes).toEqual(['FEATURE_TYPE_ALSO_NEW', 'FEATURE_TYPE_SOMETHING_NEW']);
        // the same measurements, the same decision: the code never entered it
        expect(unknown.regions.map(r => r.material)).toEqual(known.regions.map(r => r.material));
        expect(unknown.regions[0].material.planted).toBe(true);
        expect(unknown.regions[1].material.planted).toBe(false);
        expect(groundProgramNotes(unknown)[0]).toContain('[FEATURE_TYPE_SOMETHING_NEW]');
    });
});

describe('without the photo', () => {
    const ev = evidence({ west: ['FEATURE_TYPE_SOMETHING_NEW'], east: ['FEATURE_TYPE_PARKING_LOT'] });
    const look = evidenceLookup(ev, 100);
    const surf = buildGroundSurface({ ground, within: () => true, bounds: BOUNDS });

    it("takes the caller's label prior for the greenness term and labels the tint an estimate", () => {
        const program = buildGroundProgram({ ground, within: () => true, bounds: BOUNDS, surface: surf, areas: ev.landuse!, areaAt: landuseAreaAt(look), roadAt: look.roadAt, canopyAt: crownCanopyAt([{ x: 10, z: 10, radiusM: 6 }, { x: 25, z: 25, radiusM: 7 }]), labelPrior: types => (types.includes('FEATURE_TYPE_SOMETHING_NEW') ? 1 : 0) });
        const [west, east] = program.regions;
        expect(west.measure.photo).toBeUndefined();
        expect(west.material.planted).toBe(true);
        expect(west.material.tintSource).toBe('estimate');
        expect(west.material.why).toContain("the caller's prior for the labels FEATURE_TYPE_SOMETHING_NEW = 1.00");
        expect(west.material.why).toContain('an estimate (no photo), labelled');
        expect(east.material.planted).toBe(false);
        expect(east.material.tintSource).toBe('estimate');
        expect(east.material.tint).toEqual([0.26, 0.26, 0.26]);
    });

    it('with no prior either, lets the canopy share stand in and says so', () => {
        const program = buildGroundProgram({ ground, within: () => true, bounds: BOUNDS, surface: surf, areas: ev.landuse!, areaAt: landuseAreaAt(look) });
        for (const r of program.regions) {
            expect(r.material.why).toContain('no photo and no label prior: the canopy share stands in for the greenness');
            expect(r.material.planted).toBe(false);
        }
    });
});

describe('greenness', () => {
    it('is zero for grey, positive for green, negative for magenta', () => {
        expect(photoGreenness([0.3, 0.3, 0.3])).toBe(0);
        expect(photoGreenness([0.1, 0.3, 0.05])).toBeGreaterThan(0.3);
        expect(photoGreenness([0.3, 0.05, 0.3])).toBeLessThan(0);
        expect(photoGreenness([0, 0, 0])).toBe(0);
    });
});
