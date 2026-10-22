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
 * not (vector and scan disagree); one running past the extraction is not (the scan holds part of it); one whose scan spills
 * well past its footprint is not (the footprint is too small); each says why.
 */

import { describe, expect, it } from 'vitest';
import { massDistrict } from '../src/node/3d-engine/staged-location/district-massing';
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
