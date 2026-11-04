/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * District massing (district-massing.ts): every building massed from its vector footprint and the scan's surface, and checked
 * building by building. A building the scan shows standing whole is rebuilt at the scanned height; one over flat street is
 * not (vector and scan disagree); one running past the extraction is rebuilt over the part the scan holds when that is nearly
 * all of it, and kept as scanned otherwise; one whose scan spills well past its footprint is not (the footprint is too
 * small), unless what spills is a structure of its own the vector data does not map; each says why.
 */

import { describe, expect, it } from 'vitest';
import { clipRingToHalfPlane, clipToScanned, DISTRICT_MASSING_PARAMS, districtFootprint, districtUnmappedStructures, footprintCellsByBuilding, massDistrict, unmappedCells } from '../src/node/3d-engine/staged-location/district-massing';
import { evidenceLookup, type VectorEvidence } from '../src/node/3d-engine/staged-location/vector-footprints';
import type { Vec2 } from '../src/common/spatial/staged-location-contracts';

const rect = (x0: number, z0: number, x1: number, z1: number): Vec2[] => [[x0, z0], [x1, z0], [x1, z1], [x0, z1]];
const building = (id: string, ring: Vec2[], heightM: number) => ({ id, parts: [[ring]], heightM, extruded: [{ loops: [ring], heightM }] });

describe('massDistrict', () => {
    it('rebuilds the building the scan shows whole, and says why it leaves the others as scanned', () => {
        const ev: VectorEvidence = {
            buildings: [
                building('whole', rect(-20, -20, -5, -5), 18),
                building('flat', rect(5, -20, 20, -5), 12),           // the scan shows street here
                building('edge', rect(35, -5, 55, 5), 15),            // runs past a 45 m extraction
                building('small', rect(-20, 10, -14, 16), 9)          // the scan stands 9 m over a 12 x 12 m block here
            ], water: [], roads: [], tiles: 1, zoom: 17
        };
        const look = evidenceLookup(ev, 60);
        const top = (x: number, z: number) => {
            if (x >= -20 && x <= -5 && z >= -20 && z <= -5) return 2 + 18;
            if (x >= 35 && x <= 55 && z >= -5 && z <= 5) return 2 + 15;
            if (x >= -23 && x <= -11 && z >= 7 && z <= 19) return 2 + 9;
            return 2;
        };
        const rows = massDistrict({ buildings: ev.buildings, look, ground: { groundAt: () => 2, topAt: top }, within: (x, z) => Math.hypot(x, z) <= 45 });
        const by = (id: string) => rows.find(r => r.id === id)!;
        expect(rows).toHaveLength(4);
        const whole = by('whole');
        expect(whole.ok).toBe(true);
        expect(whole.raisedShare).toBe(1);
        expect(whole.groundY).toBe(2);
        expect(whole.massing!.parts.length).toBeGreaterThanOrEqual(1);
        expect(whole.massing!.parts[whole.massing!.parts.length - 1].topY).toBeCloseTo(20, 0);
        expect(by('flat')).toMatchObject({ ok: false, raisedShare: 0 });
        expect(by('flat').reason).toMatch(/disagree that a building stands here/);
        expect(by('edge').ok).toBe(false);
        expect(by('edge').reason).toMatch(/runs past the extraction/);
        expect(by('small').ok).toBe(false);
        expect(by('small').overhangShare).toBeGreaterThan(0.35);
        expect(by('small').reason).toMatch(/smaller than what was scanned/);
    });
});

describe('cutting a district\'s scan to the rebuilt footprints', () => {
    it('keeps only triangles wholly over the footprint and above each cell\'s own ground, and the residual guard drops what lies off it', async () => {
        const fs = await import('fs'), os = await import('os'), path = await import('path');
        const { hideFootprintInGlb } = await import('../src/node/3d-engine/staged-location/kept-structure');
        const { keepResidualOver } = await import('../src/node/3d-engine/staged-location/district-massing');
        const { building, groundGrid, writeTris } = await import('./helpers/staged-synthetic-world');
        const { readGlbTriangles } = await import('./helpers/clay-glb-render');
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'district-cut-'));
        // two buildings on ground at different levels (y 0 and y 5), and one big flat triangle whose middle is over the
        // first footprint but which reaches 30 m past it (a riverbank triangle)
        const lowBlock = building(0, 10, 0, 10, 12), highBlock = building(20, 30, 0, 10, 12).map(t => t.map((v, i) => (i % 3 === 1 ? v + 5 : v))) as never;
        const big: number[][] = [[1, 0.5, 1], [9, 0.5, 9], [-25, 0.5, 5]];
        const file = writeTris(path.join(dir, 'scan.glb'), [...groundGrid(40), ...lowBlock, ...highBlock, big as never]);
        const cells = new Set<string>(), cellGroundY = new Map<string, number>();
        for (let x = 0; x < 10; x++) for (let z = 0; z < 10; z++) { cells.add(`${x},${z}`); cellGroundY.set(`${x},${z}`, 0); }
        for (let x = 20; x < 30; x++) for (let z = 0; z < 10; z++) { cells.add(`${x},${z}`); cellGroundY.set(`${x},${z}`, 5); }
        const out = hideFootprintInGlb(fs.readFileSync(file), { cellM: 1, cells, baseY: 0, topY: 17, cellGroundY }, { keep: 'inside' });
        const kept = readGlbTriangles(out.glb);
        let low = 0, high = 0, ground = 0, wide = 0;
        for (let t = 0; t < kept.indices.length; t += 3) {
            const vs = [0, 1, 2].map(j => [0, 1, 2].map(k => kept.positions[kept.indices[t + j] * 3 + k]));
            const c = [0, 1, 2].map(k => (vs[0][k] + vs[1][k] + vs[2][k]) / 3);
            if (Math.max(...vs.map(v => v[0])) - Math.min(...vs.map(v => v[0])) > 20) wide++;
            else if (c[1] < 0.3 || (c[0] >= 20 && c[1] < 5.3)) ground++;
            else if (c[0] < 15) low++; else high++;
        }
        expect(wide).toBe(0);          // the triangle reaching past the footprint is not kept
        expect(ground).toBe(0);        // the street under both buildings stays in the layer it was cut from
        expect(low).toBeGreaterThan(0);
        expect(high).toBeGreaterThan(0);
        // the residual guard: a residual node's triangles off the cells go, those over them stay
        const node = (pts: number[][]) => ({ name: 'residual:1', kind: 'residual', provenance: 'as-scanned', confidence: null, positions: Float32Array.from(pts.flat()), normals: new Float32Array(pts.length * 3), ref: new Int32Array(pts.length).fill(-2), st: new Float32Array(pts.length * 2), indices: Uint32Array.from(pts.map((_, i) => i)) });
        const run = { nodes: [node([[1, 13, 1], [2, 13, 1], [1, 13, 2], [40, 0, 40], [41, 0, 40], [40, 0, 41]]), { ...node([[2, 0, 2], [3, 0, 2], [2, 0, 3]]), name: 'w:1', kind: 'wall' }] } as never;
        expect(keepResidualOver(run, cells)).toBe(1);
        expect((run as { nodes: Array<{ kind: string; indices: Uint32Array }> }).nodes.find(n => n.kind === 'residual')!.indices.length).toBe(3);
        expect((run as { nodes: Array<{ kind: string }> }).nodes.some(n => n.kind === 'wall')).toBe(true);
    });
});

describe('a building the scan holds only part of', () => {
    const area = (r: Vec2[]) => Math.abs(r.reduce((a, p, i) => { const q = r[(i + 1) % r.length]; return a + p[0] * q[1] - q[0] * p[1]; }, 0) / 2);

    it('cuts a concave ring into one simple ring per piece on the kept side', () => {
        // a U opening to +z, cut at z = 5: the two arms are kept as two rectangles, never one ring doubling back along the cut
        const u: Vec2[] = [[0, 0], [10, 0], [10, 10], [7, 10], [7, 3], [3, 3], [3, 10], [0, 10]];
        const pieces = clipRingToHalfPlane(u, [0, 1], 5);
        expect(pieces).toHaveLength(1);
        expect(area(pieces[0])).toBeCloseTo(10 * 5 - 4 * 2, 6);
        const arms = clipRingToHalfPlane(u, [0, -1], -5);
        expect(arms).toHaveLength(2);
        expect(arms.map(area)).toEqual([15, 15]);
        expect(clipRingToHalfPlane(u, [1, 0], 20)).toEqual([u]);
        expect(clipRingToHalfPlane(u, [1, 0], -1)).toEqual([]);
    });

    it('places the cut at the nearest unscanned cell, keeping none of them', () => {
        const cells: Array<[number, number]> = [], outsideCells: Array<[number, number]> = [];
        for (let x = 0; x < 20; x++) for (let z = 0; z < 10; z++) (x < 19 ? cells : outsideCells).push([x, z]);
        const clip = clipToScanned({ cells, outsideCells })!;
        expect(clip.normal).toEqual([1, 0]);
        expect(clip.offset).toBe(19);
        expect(clip.scannedShare).toBe(0.95);
        expect(clip.keptShare).toBe(0.95);
    });

    it('rebuilds nearly all of it over the part the scan holds, draws nothing past the scan, and leaves a mostly unscanned one as scanned', () => {
        const ev: VectorEvidence = {
            buildings: [
                building('mostly', rect(0, -10, 40, 10), 20),     // 38 of its 40 m lie inside the scan (x < 38)
                building('half', rect(0, 20, 76, 30), 20)          // only half of it does
            ], water: [], roads: [], tiles: 1, zoom: 17
        };
        const look = evidenceLookup(ev, 90);
        const top = (x: number, z: number) => (x >= 38 ? NaN : (x >= 0 && x <= 40 && z >= -10 && z <= 10) || (x >= 0 && x <= 76 && z >= 20 && z <= 30) ? 22 : 2);
        const within = (x: number) => x < 38;
        const rows = massDistrict({ buildings: ev.buildings, look, ground: { groundAt: (x: number) => (x >= 38 ? NaN : 2), topAt: top }, within });
        const mostly = rows.find(r => r.id === 'mostly')!, half = rows.find(r => r.id === 'half')!;
        expect(mostly.ok).toBe(true);
        expect(mostly.clip).toMatchObject({ normal: [1, 0], offset: 38 });
        expect(mostly.clip!.keptShare).toBeGreaterThanOrEqual(0.9);
        expect(mostly.caveat).toMatch(/rebuilt over the 95% of its footprint the scan holds/);
        // every corner of the massing stands where the scan reaches
        const xs = mostly.massing!.parts.flatMap(p => p.loops.flat().map(q => q[0]));
        expect(Math.max(...xs)).toBeLessThanOrEqual(38 + 1e-9);
        expect(Math.max(...xs)).toBeGreaterThan(37);
        expect(mostly.massing!.meshes).toHaveLength(0);
        expect(half.ok).toBe(false);
        expect(half.reason).toMatch(/runs past the extraction .* keeps 50% \(at least 90% needed/);
        // the scan is cut only under the kept part
        const fp = districtFootprint(rows, look, within, 1);
        expect([...fp.cells].every(k => Number(k.split(',')[0]) < 38)).toBe(true);
        expect(fp.cells.has('20,0')).toBe(true);
        expect(fp.cells.has('20,25')).toBe(false);
        expect(footprintCellsByBuilding(look, within).get(0)!.outsideCells).toHaveLength(40);
    });

    it('takes a raised mass standing clear of every footprint as its own structure, not a building\'s overhang, and keeps the cut out of it', () => {
        // a 10 x 10 footprint with an unmapped 8 m-deep annex against its east wall; one with a 1 m sliver of facade; and a
        // long one with a 4 m band of facade along its whole south side (the footprint drawn too small, not a structure)
        const ev: VectorEvidence = { buildings: [building('annexed', rect(0, 0, 10, 10), 15), building('sliver', rect(30, 0, 40, 10), 15), building('banded', rect(-60, 30, 0, 40), 15)], water: [], roads: [], tiles: 1, zoom: 17 };
        const look = evidenceLookup(ev, 70);
        const top = (x: number, z: number) => (x >= 0 && x < 18 && z >= 0 && z < 10) || (x >= 30 && x < 41 && z >= 0 && z < 10) || (x >= -60 && x < 0 && z >= 30 && z < 44) ? 17 : 2;
        const ground = { groundAt: () => 2, topAt: top }, within = () => true;
        // a strict overhang check, so the one-cell ring the scan raises past each footprint fails it
        const P = { ...DISTRICT_MASSING_PARAMS, maxOverhangShare: 0.05 };
        const unmapped = districtUnmappedStructures({ buildings: ev.buildings, look, ground, within });
        expect(unmapped).toHaveLength(1);
        expect(unmapped[0]).toMatchObject({ label: 'photo-inferred', areaM2: 80, touches: ['annexed'] });
        expect(unmapped[0].outline.length).toBeGreaterThanOrEqual(4);
        const rows = massDistrict({ buildings: ev.buildings, look, ground, within, unmapped }, P);
        const annexed = rows.find(r => r.id === 'annexed')!;
        expect(annexed.ok).toBe(true);
        expect(annexed.overhangShare).toBe(0);
        expect(annexed.unmappedShare).toBeGreaterThan(0);
        const without = massDistrict({ buildings: ev.buildings, look, ground, within, unmapped: [] }, P).find(r => r.id === 'annexed')!;
        expect(without.ok).toBe(false);
        expect(without.reason).toMatch(/smaller than what was scanned/);
        // the facade a little past a footprint is no structure of its own
        expect(rows.find(r => r.id === 'sliver')!.unmappedShare).toBeUndefined();
        expect(rows.find(r => r.id === 'sliver')!.reason).toMatch(/smaller than what was scanned/);
        expect(rows.find(r => r.id === 'banded')!.unmappedShare).toBeUndefined();
        expect(rows.find(r => r.id === 'banded')!.reason).toMatch(/smaller than what was scanned/);
        const fp = districtFootprint(rows, look, within, 2, unmappedCells(unmapped));
        expect(fp.cells.has('11,5')).toBe(false);
        expect(districtFootprint(rows, look, within, 2).cells.has('11,5')).toBe(true);
    });
});
