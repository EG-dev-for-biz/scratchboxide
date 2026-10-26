/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The modelled volume as a roof prior (volume-roof-prior.ts): a gabled volume gives two pitched planes, a flat volume with a
 * setback tower gives two tiers; the prior seeds the roof decisions (roof-infer.ts decideRoof, massing-spec.ts buildMassing)
 * and the scan decides: a scan top that agrees takes the volume's planes (labelled vector-modelled) or outline, a scan top
 * that disagrees keeps the scan's roof with a note. Synthetic volumes and scan tops only: no network, no model.
 */

import { describe, expect, it } from 'vitest';
import { buildMassing, massingSpecText, ringArea, roofAt, type MassingPart } from '../src/node/3d-engine/staged-location/pipeline-e/massing-spec';
import { decideRoof, MIN_ROOF_GAIN, CORROBORATED_ROOF_GAIN, type RoofReading } from '../src/node/3d-engine/staged-location/pipeline-e/roof-infer';
import { massingProvenance } from '../src/node/3d-engine/staged-location/pipeline-e/pipeline-e';
import { roofVectorModelledToken } from '../src/node/3d-engine/staged-location/pipeline-e/inference';
import { azimuthOffRidge, reconcileTiers, volumeRoofPrior, volumePlanesIn } from '../src/node/3d-engine/staged-location/pipeline-e/volume-roof-prior';

type V3 = [number, number, number];

/** A closed box [x0,x1] x [0,h] x [z0,z1] as Google hands volumes over: each triangle twice, both windings. */
function box(x0: number, x1: number, z0: number, z1: number, y0: number, h: number, V: V3[], I: number[]): void {
    const b = V.length;
    V.push([x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1], [x0, h, z0], [x1, h, z0], [x1, h, z1], [x0, h, z1]);
    const quads = [[4, 5, 6, 7], [0, 3, 2, 1], [0, 1, 5, 4], [1, 2, 6, 5], [2, 3, 7, 6], [3, 0, 4, 7]];
    for (const [a, c, d, e] of quads) {
        I.push(b + a, b + c, b + d, b + a, b + d, b + e);
        I.push(b + a, b + d, b + c, b + a, b + e, b + d);
    }
}

/** A 20 x 12 m gabled volume, 8 m to the eaves, ridge along z (north-south) at x = 10, slopes 30 deg. */
function gabledVolume(): { vertices: V3[]; indices: number[] } {
    const rise = 10 * Math.tan(Math.PI / 6);  // half-width 10 m (ridge at x = 10 of 20 m) at 30 deg
    const V: V3[] = [[0, 0, 0], [20, 0, 0], [20, 0, 12], [0, 0, 12], [0, 8, 0], [20, 8, 0], [20, 8, 12], [0, 8, 12]];
    const I: number[] = [];
    // the walls and the floor
    for (const [a, b, c, d] of [[0, 3, 2, 1], [0, 1, 5, 4], [2, 3, 7, 6]]) { I.push(a, b, c, a, c, d); I.push(a, c, b, a, d, c); }
    // the ridge
    const r0 = V.length; V.push([10, 8 + rise, 0], [10, 8 + rise, 12]);
    // two roof planes: west (x 0..10) falls toward -x, east falls toward +x, each as two triangles
    for (const [a, b, c, d] of [[4, 7, r0 + 1, r0], [5, r0, r0 + 1, 6]]) { I.push(a, b, c, a, c, d); I.push(a, c, b, a, d, c); }
    // the gable ends
    for (const [a, b, c] of [[4, r0, 5], [7, 6, r0 + 1]]) { I.push(a, b, c); I.push(a, c, b); }
    return { vertices: V, indices: I };
}

/** A 40 x 40 m flat volume 30 m tall with a 16 x 16 m tower on it up to 45 m (two tiers). */
function steppedVolume(): { vertices: V3[]; indices: number[] } {
    const V: V3[] = [], I: number[] = [];
    box(0, 40, 0, 40, 0, 30, V, I);
    box(12, 28, 12, 28, 30, 45, V, I);
    return { vertices: V, indices: I };
}

const RECT: Array<[number, number]> = [[0, 0], [20, 0], [20, 12], [0, 12]];
const BASE: Array<[number, number]> = [[0, 0], [40, 0], [40, 40], [0, 40]];
const cellsOf = (x0: number, x1: number, z0: number, z1: number) => { const c = new Set<string>(); for (let x = x0; x < x1; x++) for (let z = z0; z < z1; z++) c.add(`${x},${z}`); return c; };
const gableTop = (x: number, z: number) => (x < 0 || x > 20 || z < 0 || z > 12 ? NaN : 8 + (10 - Math.abs(x - 10)) * Math.tan(Math.PI / 6));
const flatReading: RoofReading = { pitchDeg: 0, ridgeAzimuthDeg: 0, hipped: false, parapetM: 0, blocks: [], conf: 70 };

describe('volumeRoofPrior', () => {
    it('reads a gabled volume as two planes at 30 deg falling east and west, and no tier', () => {
        const prior = volumeRoofPrior([gabledVolume()], 0)!;
        expect(prior).toBeDefined();
        expect(prior.triangles).toBe(12);  // 3 quads + 2 roof quads, 2 gables; each once (the double-sided copies folded)
        const pitched = prior.planes.filter(p => p.pitchDeg >= 10);
        expect(pitched).toHaveLength(2);
        for (const p of pitched) {
            expect(p.pitchDeg).toBeCloseTo(30, 1);
            expect(p.planAreaM2).toBeCloseTo(120, 1);  // 10 x 12 m each
            expect(p.loops[0]).toHaveLength(4);
            // the plane through the eave at 8 m and the ridge at 8 + 6 tan 30
            expect(p.a + p.b * 10 + p.c * 6).toBeCloseTo(8 + 10 * Math.tan(Math.PI / 6), 3);
        }
        const az = pitched.map(p => p.azimuthDeg).sort((u, v) => u - v);
        expect(az[0]).toBeCloseTo(90, 1);   // falls east
        expect(az[1]).toBeCloseTo(270, 1);  // falls west
        expect(prior.tiers).toHaveLength(0);
        // both eave planes fall perpendicular to a north-south ridge
        expect(azimuthOffRidge(90, 0)).toBeCloseTo(0, 6);
        expect(azimuthOffRidge(270, 0)).toBeCloseTo(0, 6);
        expect(azimuthOffRidge(90, 90)).toBeCloseTo(90, 6);
        expect(volumePlanesIn(prior, [RECT], 8)).toHaveLength(2);
        expect(volumePlanesIn(prior, [[[30, 0], [50, 0], [50, 12], [30, 12]]], 8)).toHaveLength(0);
    });

    it('reads a flat volume with a setback tower as two flat planes and two tiers with clean outlines', () => {
        const prior = volumeRoofPrior([steppedVolume()], 0)!;
        expect(prior.planes.filter(p => p.pitchDeg < 10)).toHaveLength(2);
        expect(prior.tiers).toHaveLength(2);
        const [lower, upper] = prior.tiers;
        expect(lower.topY).toBeCloseTo(30, 3);
        expect(upper.topY).toBeCloseTo(45, 3);
        // the lower tier's outline is the whole 40 x 40 plan (what rises above it included); the tower's is 16 x 16
        expect(Math.abs(ringArea(lower.loop!))).toBeCloseTo(1600, 1);
        expect(lower.loop).toHaveLength(4);
        expect(Math.abs(ringArea(upper.loop!))).toBeCloseTo(256, 1);
        expect(upper.loop).toHaveLength(4);
        expect(upper.cells).toHaveLength(256);
        expect(lower.cells).toHaveLength(1600);
        // the lower roof's two big triangles stay the top surface (most of each lies clear of the tower); the tower's floor at
        // the same height and the box floors are under a roof and go
        const lowerPlane = prior.planes.find(p => Math.abs(p.centreY - 30) < 0.01)!;
        expect(lowerPlane.planAreaM2).toBeCloseTo(1600, 1);
        expect(lowerPlane.loops).toHaveLength(1);
        expect(lowerPlane.triangles).toBe(2);
        expect(prior.topTriangles).toBe(4);
    });

    it('is undefined for a volume with no upward surface', () => {
        const V: V3[] = [[0, 0, 0], [10, 0, 0], [10, 10, 0], [0, 10, 0]];
        expect(volumeRoofPrior([{ vertices: V, indices: [0, 1, 2, 0, 2, 3] }], 0)).toBeUndefined();
    });
});

describe('decideRoof with the volume prior', () => {
    const part: MassingPart = { id: 'b/e0', baseY: 0, topY: 8, loops: [RECT], planes: [], heightSource: 'vector', heights: { vectorY: 8 } };
    const toPlan = (px: number, py: number): [number, number] => [(px / 1000) * 20, (py / 1000) * 12];

    it('takes the volume\'s planes as a candidate where the reading left the roof flat and the scan is gabled: vector-modelled, with the residual', () => {
        const prior = volumeRoofPrior([gabledVolume()], 0)!;
        const d = decideRoof(part, flatReading, gableTop, [], toPlan, prior);
        expect(d.pitch.proposed).toBe(true);
        expect(d.pitch.accepted).toBe(true);
        expect(d.pitch.source).toBe('vector-modelled');
        expect(d.pitch.planes).toHaveLength(2);
        expect(d.pitch.planes!.every(p => p.tag.startsWith('volume:30.0deg'))).toBe(true);
        expect(d.pitch.residualM).toBeLessThan(0.05);
        // topY is the roof's highest sampled cell, a fraction of a cell below the ridge line itself
        expect(d.pitch.topY).toBeCloseTo(8 + 10 * Math.tan(Math.PI / 6), 0);
        // the roof the planes shape is the gable itself
        const shaped = { ...part, planes: d.pitch.planes!, topY: d.pitch.topY! };
        expect(roofAt(shaped, 9, 6)).toBeCloseTo(gableTop(9, 6), 1);  // on the slope (the ridge line itself is capped at topY)
        expect(roofAt(shaped, 1, 6)).toBeCloseTo(gableTop(1, 6), 1);
        // without the prior the same flat reading proposes nothing
        const bare = decideRoof(part, flatReading, gableTop, [], toPlan);
        expect(bare.pitch.proposed).toBe(false);
        // the provenance record the token carries: vector-modelled, confidence from the residual
        const token = roofVectorModelledToken(d.pitch.residualM!);
        const rec = massingProvenance({ kind: 'roof', provenance: token, confidence: null }, { check: { iou: 0.9, heightErrMedianM: 0.1, heightErrP90M: 0.3, massingCells: 240, scanCells: 240, ok: true } });
        expect(rec.label).toBe('vector-modelled');
        expect(rec.confidence).toBeGreaterThan(0.9);
        const wall = massingProvenance({ kind: 'wall', provenance: token, confidence: null }, { check: { iou: 0.9, heightErrMedianM: 0.1, heightErrP90M: 0.3, massingCells: 240, scanCells: 240, ok: true } });
        expect(wall.label).toBe('vector-massing');
    });

    it('keeps the scan\'s flat roof when the volume is gabled and the scan is flat, and says so', () => {
        const prior = volumeRoofPrior([gabledVolume()], 0)!;
        const d = decideRoof(part, flatReading, () => 8, [], toPlan, prior);
        expect(d.pitch.proposed).toBe(true);
        expect(d.pitch.accepted).toBe(false);
        expect(d.pitch.source).toBeUndefined();
        expect(d.pitch.why).toMatch(/modelled volume's 2 pitched planes/);
        expect(d.pitch.why).toMatch(/roof error against the scan 0\.00 -> /);
    });

    it('corroborates a reading the volume agrees with (half the gain needed), and says when it disagrees', () => {
        const prior = volumeRoofPrior([gabledVolume()], 0)!;
        const reading: RoofReading = { ...flatReading, pitchDeg: 32, ridgeAzimuthDeg: 0 };
        const d = decideRoof(part, reading, gableTop, [], toPlan, prior);
        expect(d.pitch.accepted).toBe(true);
        expect(d.pitch.source).toBe('photo-inferred');
        expect(d.pitch.corroborated).toBeDefined();
        expect(d.pitch.corroborated!.pitchDeg).toBeCloseTo(30, 1);
        expect(d.pitch.corroborated!.planes).toBe(2);
        expect(d.pitch.planes!.every(p => p.tag.startsWith('eave:32.0deg'))).toBe(true);
        expect(CORROBORATED_ROOF_GAIN).toBeCloseTo(MIN_ROOF_GAIN / 2, 9);
        // a reading with the ridge across the volume's (east-west): not corroborated
        const across = decideRoof(part, { ...reading, ridgeAzimuthDeg: 90 }, gableTop, [], toPlan, prior);
        expect(across.pitch.corroborated).toBeUndefined();
        expect(across.pitch.why).toMatch(/disagrees/);
    });
});

describe('buildMassing with the footprint over a modelled volume', () => {
    it('carries the roof prior, takes the volume\'s tower outline for a tier the scan agrees with, and keeps the scan\'s height', () => {
        const scanTop = (x: number, z: number) => (x >= 12 && x <= 28 && z >= 12 && z <= 28 ? 46 : 30);
        const building = { id: 'tower', parts: [], volumes: [steppedVolume()], extruded: [{ loops: [BASE], heightM: 30, planOnly: true }] };
        const m = buildMassing({ buildings: [building], groundY: 0, scanTop, cells: cellsOf(0, 40, 0, 40), preferExtrusion: true });
        expect(m.meshes).toHaveLength(0);  // the volume never places a wall
        expect(m.roofPrior).toBeDefined();
        expect(m.roofPrior!.tiers).toHaveLength(2);
        expect(m.parts).toHaveLength(2);
        const tower = m.parts[1];
        // the tower's plan is the volume's own clean 16 x 16 m outline, not the scan's area-matched inset
        expect(tower.loops[0]).toHaveLength(4);
        expect(Math.abs(ringArea(tower.loops[0]))).toBeCloseTo(256, 3);
        const xs = tower.loops[0].map(q => q[0]), zs = tower.loops[0].map(q => q[1]);
        expect(Math.min(...xs)).toBeCloseTo(12, 3); expect(Math.max(...xs)).toBeCloseTo(28, 3);
        expect(Math.min(...zs)).toBeCloseTo(12, 3); expect(Math.max(...zs)).toBeCloseTo(28, 3);
        // the height is the scan's (46 m), not the volume's 45 m
        expect(tower.topY).toBeGreaterThanOrEqual(45.5);
        expect(tower.heightSource).toBe('scan');
        expect(tower.roof?.note).toMatch(/plan from the modelled volume's outline at 45\.0 m/);
        expect(m.notes.some(n => /tier 1: plan from the modelled volume's outline/.test(n))).toBe(true);
        // the spec text says per part which source decided the roof
        const spec = massingSpecText(m, { outDir: '/tmp/x' });
        expect(spec).toMatch(/^# roof tower\/e0\/t0 flat top at the scan height$/m);
        expect(spec).toMatch(/^# roof tower\/e0\/t1 scan: plan from the modelled volume's outline/m);
        expect(spec.split('\n').filter(l => l.startsWith('part ')).length).toBe(2);
    });

    it('keeps the scan\'s inset plan when the volume\'s tower stands elsewhere, with a note; the scan wins over a volume the scan shows flat', () => {
        // the scan's tower is 24 x 24 m, the volume's 16 x 16 m: heights agree, plans do not (IoU 0.44)
        const scanTop = (x: number, z: number) => (x >= 8 && x <= 32 && z >= 8 && z <= 32 ? 45 : 30);
        const building = { id: 'tower', parts: [], volumes: [steppedVolume()], extruded: [{ loops: [BASE], heightM: 30, planOnly: true }] };
        const m = buildMassing({ buildings: [building], groundY: 0, scanTop, cells: cellsOf(0, 40, 0, 40), preferExtrusion: true });
        expect(m.parts).toHaveLength(2);
        const tower = m.parts[1];
        expect(tower.roof).toBeUndefined();
        // the inset ring (centred, area-matched), not the volume's outline
        expect(Math.abs(ringArea(tower.loops[0]))).toBeGreaterThan(500);
        expect(Math.abs(ringArea(tower.loops[0]))).toBeLessThan(650);
        expect(m.notes.some(n => /the modelled volume's tier at 45\.0 m \(256 m2\) is not the scan's \(nearest scan tier 45\.0 m, plan IoU 0\.4\d\); the scan wins/.test(n))).toBe(true);
        // a flat scan: no tiers, and the note says the volume's tiers were not seen
        const flat = buildMassing({ buildings: [building], groundY: 0, scanTop: () => 30, cells: cellsOf(0, 40, 0, 40), preferExtrusion: true });
        expect(flat.parts).toHaveLength(1);
        expect(flat.notes.some(n => /the modelled volume shows 2 tiers \(tops at 30\.0, 45\.0 m\) but the scan's heightfield gives no tier stack .*; the scan wins/.test(n))).toBe(true);
        // reconcileTiers alone: nothing to do without a prior
        expect(reconcileTiers(undefined, undefined, 0)).toEqual({ tiers: undefined, notes: [] });
    });

    it('still masses from the volume itself when the footprint is not asked for (no prior)', () => {
        const building = { id: 'tower', parts: [], volumes: [steppedVolume()], extruded: [{ loops: [BASE], heightM: 30, planOnly: true }] };
        const m = buildMassing({ buildings: [building], groundY: 0, scanTop: () => 30, cells: cellsOf(0, 40, 0, 40) });
        expect(m.meshes).toHaveLength(1);
        expect(m.roofPrior).toBeUndefined();
    });
});
