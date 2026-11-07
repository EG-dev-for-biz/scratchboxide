/**
 * Believability first (AGENTS.md §4, 2026-10-21): a vector footprint with no measured height still gets drawn, at
 * PLAUSIBLE_DEFAULT_HEIGHT_M, instead of being skipped. Covers `selectPaintBuildings`'s decision only (pure, no native
 * compile); `writePaintGlb`'s per-node provenance split is a direct Set-lookup over the same `heightGuessed` flags this
 * proves correct, not re-exercised here.
 */
import { describe, expect, it } from 'vitest';
import {
    GENERATED_HEIGHT_LABEL, PLAUSIBLE_DEFAULT_HEIGHT_M, VECTOR_MODELLED_LABEL, paintGeneratedHeightProvenance, paintProvenance,
    selectPaintBuildings
} from '../src/node/3d-engine/staged-location/vector-first-paint';
import type { VectorBuilding, VectorEvidence } from '../src/node/3d-engine/staged-location/vector-footprints';

const SQUARE: Array<[number, number]> = [[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]];
function ev(buildings: VectorBuilding[]): VectorEvidence { return { buildings, water: [], roads: [], tiles: 1, zoom: 17 }; }

describe('believability first: a vector footprint with no measured height is drawn, not skipped', () => {
    it('a building with a real height is measured, vector-modelled, and no guess is recorded', () => {
        const b: VectorBuilding = { id: 'a', parts: [[SQUARE]], extruded: [{ loops: [SQUARE], heightM: 15, minHeightM: 0 }] };
        const sel = selectPaintBuildings(ev([b]), 100);
        expect(sel.buildings).toHaveLength(1);
        expect(sel.buildings[0].heightGuessed).toBeFalsy();
        expect(sel.buildings[0].parts[0].topH).toBe(15);
        expect(sel.partsGivenDefaultHeight).toBe(0);
        expect(sel.buildingsGivenDefaultHeight).toBe(0);
    });

    it('a building with NO height anywhere is still drawn, at the plausible default, and flagged as a guess', () => {
        const b: VectorBuilding = { id: 'b', parts: [[SQUARE]], extruded: [{ loops: [SQUARE], minHeightM: 0 }] }; // no heightM
        const sel = selectPaintBuildings(ev([b]), 100);
        expect(sel.buildings).toHaveLength(1); // drawn, not skipped
        expect(sel.buildings[0].heightGuessed).toBe(true);
        expect(sel.buildings[0].parts[0].heightGuessed).toBe(true);
        expect(sel.buildings[0].parts[0].topH).toBe(PLAUSIBLE_DEFAULT_HEIGHT_M);
        expect(sel.partsGivenDefaultHeight).toBe(1);
        expect(sel.buildingsGivenDefaultHeight).toBe(1);
    });

    it('a part with no height above a non-zero minHeightM is guessed from that base, not from 0', () => {
        const b: VectorBuilding = { id: 'c', parts: [[SQUARE]], extruded: [{ loops: [SQUARE], minHeightM: 20 }] }; // a plinth, no top height
        const sel = selectPaintBuildings(ev([b]), 100);
        expect(sel.buildings[0].parts[0].minH).toBe(20);
        expect(sel.buildings[0].parts[0].topH).toBe(20 + PLAUSIBLE_DEFAULT_HEIGHT_M);
    });

    it('a building with one measured part and one unmeasured part keeps the building vector-modelled (not fully a guess)', () => {
        const b: VectorBuilding = {
            id: 'd', parts: [[SQUARE]],
            extruded: [{ loops: [SQUARE], heightM: 30, minHeightM: 0 }, { loops: [[[20, 0], [30, 0], [30, 10], [20, 10], [20, 0]]], minHeightM: 0 }]
        };
        const sel = selectPaintBuildings(ev([b]), 100);
        expect(sel.buildings[0].heightGuessed).toBeFalsy(); // not every part needed a guess
        expect(sel.buildings[0].parts[0].heightGuessed).toBeFalsy();
        expect(sel.buildings[0].parts[1].heightGuessed).toBe(true);
        expect(sel.partsGivenDefaultHeight).toBe(1);
        expect(sel.buildingsGivenDefaultHeight).toBe(0); // the building overall is still measured
    });

    it('a building with a real Google modelled volume is never treated as a guess, even with no extruded height', () => {
        const b: VectorBuilding = {
            id: 'e', parts: [[SQUARE]],
            volumes: [{ vertices: [[0, 0, 0], [10, 0, 0], [10, 0, 10], [0, 20, 0]], indices: [0, 1, 2, 0, 2, 3, 0, 3, 1, 1, 2, 3] }]
        };
        const sel = selectPaintBuildings(ev([b]), 100);
        expect(sel.buildings[0].heightGuessed).toBeFalsy();
        expect(sel.buildings[0].volumes).toHaveLength(1);
    });

    it('a building whose location is known but has no extrusion and no volume has no evidence to draw a guess from: left out, not guessed', () => {
        // a real outer ring (so the centroid is known), but nothing extrudable and no modelled volume
        const b: VectorBuilding = { id: 'f', parts: [[SQUARE]], extruded: [] };
        const sel = selectPaintBuildings(ev([b]), 100);
        expect(sel.buildings).toHaveLength(0);
        expect(sel.buildingsWithNoFootprint).toBe(1);
        expect(sel.buildingsGivenDefaultHeight).toBe(0); // distinct from "drawn with a guessed height"
    });

    it('a building with no footprint shape and no volume at all (no known location) is silently left out, matching unchanged prior behaviour', () => {
        const b: VectorBuilding = { id: 'g', parts: [], extruded: [] };
        const sel = selectPaintBuildings(ev([b]), 100);
        expect(sel.buildings).toHaveLength(0);
    });

    it('the generated-height provenance record is honestly labelled, never measured, with its real reason', () => {
        const p = paintGeneratedHeightProvenance('vectortiles:abcd1234');
        expect(p.label).toBe(GENERATED_HEIGHT_LABEL);
        expect(p.label).not.toBe(VECTOR_MODELLED_LABEL);
        expect(p.measuredGeometry).toBe(false);
        expect(p.confidence).toBeLessThan(1);
        expect(p.note).toContain('not measured');
        expect(paintProvenance('x', 'vectortiles:abcd1234').label).toBe(VECTOR_MODELLED_LABEL);
    });
});

describe('a 2D-only footprint under another feature\'s modelled volume is that volume again', () => {
    const rect = (x: number, z: number, w: number, d: number): Array<[number, number]> => [[x, z], [x + w, z], [x + w, z + d], [x, z + d]];
    const vol = {
        vertices: [[0, 0, 0], [40, 0, 0], [40, 0, 40], [0, 0, 40], [0, 80, 0], [40, 80, 0], [40, 80, 40], [0, 80, 40]] as Array<[number, number, number]>,
        indices: [0, 1, 2, 0, 2, 3, 4, 6, 5, 4, 7, 6], heightM: 80
    };

    it('is left out and counted; one beside the volume, and the volume itself, are drawn', () => {
        const sel = selectPaintBuildings(ev([
            { id: 'tower', parts: [], volumes: [vol] },
            { id: 'dup', parts: [[rect(5, 5, 30, 30)]], extruded: [{ loops: [rect(5, 5, 30, 30)], planOnly: true }] },
            { id: 'beside', parts: [[rect(60, 5, 10, 10)]], extruded: [{ loops: [rect(60, 5, 10, 10)], planOnly: true }] }
        ]), 1000);
        expect(sel.buildings.map(b => b.id).sort()).toEqual(['beside', 'tower']);
        expect(sel.buildingsUnderOtherVolume).toBe(1);
        expect(sel.buildingsGivenDefaultHeight).toBe(1);
        expect(sel.partsGivenDefaultHeight).toBe(1);
    });

    it('keeps a footprint with a measured height even under another volume (real data is never dropped)', () => {
        const sel = selectPaintBuildings(ev([
            { id: 'tower', parts: [], volumes: [vol] },
            { id: 'podium', parts: [[rect(5, 5, 30, 30)]], extruded: [{ loops: [rect(5, 5, 30, 30)], heightM: 12 }] }
        ]), 1000);
        expect(sel.buildings.map(b => b.id).sort()).toEqual(['podium', 'tower']);
        expect(sel.buildingsUnderOtherVolume).toBe(0);
    });
});
