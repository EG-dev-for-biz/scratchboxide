/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Opening detail in pipeline G: a reading's divided glazing, sills and surrounds. The native tool stands a frame, mullions
 * and transoms proud of the glass at the back of the recess (their front faces' area is the frame band plus the bars, all
 * inside the outline, an arch's too); the reading becomes paned openings and sill and surround sweeps (read and continued
 * kept apart); the paint gives the bars their own colour; the check counts sills and jambs as members.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { massingSpecText, type Massing, type OpeningItem } from '../src/node/3d-engine/staged-location/pipeline-e/massing-spec';
import { runMassing, type MassingFace, type MassingNode } from '../src/node/3d-engine/staged-location/pipeline-e/native-massing';
import { programItems } from '../src/node/3d-engine/staged-location/pipeline-g/read';
import { inOpening, onPaneBar, paintFaces } from '../src/node/3d-engine/staged-location/pipeline-g/pipeline-g';
import { programShapes } from '../src/node/3d-engine/staged-location/pipeline-g/check';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'g-openings-'));
const PARAMS = { bake: 0, sections: 0, topdown: 0, residual: 0 };

/** Area of a node's triangles facing along `n` whose vertices lie `off` metres along `n` from `origin`. */
function frontArea(node: MassingNode, origin: number[], n: number[], off: number): number {
    let a = 0;
    for (let i = 0; i < node.indices.length; i += 3) {
        const v = [0, 1, 2].map(k => node.indices[i + k] * 3);
        if (v.some(j => Math.abs(node.normals[j] - n[0]) + Math.abs(node.normals[j + 1] - n[1]) + Math.abs(node.normals[j + 2] - n[2]) > 1e-6)) continue;
        const P = v.map(j => [node.positions[j], node.positions[j + 1], node.positions[j + 2]]);
        if (P.some(p => Math.abs((p[0] - origin[0]) * n[0] + (p[1] - origin[1]) * n[1] + (p[2] - origin[2]) * n[2] - off) > 1e-5)) continue;
        const e1 = [0, 1, 2].map(k => P[1][k] - P[0][k]), e2 = [0, 1, 2].map(k => P[2][k] - P[0][k]);
        a += Math.hypot(e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]) / 2;
    }
    return a;
}

describe('divided glazing in the native build', () => {
    it('stands the frame, mullions and transoms proud of the glass, inside the outline', async () => {
        const dir = tmp();
        const m: Pick<Massing, 'parts' | 'meshes'> = { parts: [{ id: 'g', baseY: 0, topY: 10, loops: [[[0, 0], [10, 0], [10, -6], [0, -6]]], planes: [], heightSource: 'vector', heights: {} }], meshes: [] };
        const probe = await runMassing(massingSpecText(m, { outDir: dir, params: PARAMS }), dir);
        const wall = probe.report.faces.find(f => f.kind === 'wall' && Math.abs(f.sMax - f.sMin - 10) < 1e-6)!;
        const panes = { cols: 2, rows: 3, barM: 0.1, frameM: 0.08, depthM: 0.05 };
        const openings: OpeningItem[] = [
            { id: 'rect', face: wall.key, s0: wall.sMin + 1, s1: wall.sMin + 3, t0: 2, t1: 5, depth: 0.3, scanned: false, confidence: 0.5, provenance: 'photo-inferred', panes },
            { id: 'arch', face: wall.key, s0: wall.sMin + 5, s1: wall.sMin + 7, t0: 2, t1: 6, depth: 0.3, scanned: false, confidence: 0.5, provenance: 'photo-inferred', archRiseM: 1, panes },
            { id: 'plain', face: wall.key, s0: wall.sMin + 8, s1: wall.sMin + 9, t0: 2, t1: 5, depth: 0.3, scanned: false, confidence: 0.5, provenance: 'photo-inferred' }
        ];
        const spec = massingSpecText(m, { outDir: dir, params: PARAMS, openings });
        expect(spec).toContain(' panes 2 3 0.1 0.08 0.05');
        const r = await runMassing(spec, dir);
        expect(r.report.rejectedOpenings).toEqual([]);
        const node = (id: string) => r.nodes.find(n => n.name === `opening:${id}`)!;
        // the rectangle: the frame band along four edges (corners overlap) 2 * (2 + 3) * 0.08, one mullion between the frame's
        // inner edges 0.1 x (3 - 0.16), two transoms across the frame's inner width (2 - 0.16) x 0.1
        const expected = 2 * (2 + 3) * 0.08 + 0.1 * (3 - 0.16) + 2 * (2 - 0.16) * 0.1;
        expect(frontArea(node('rect'), wall.origin, wall.normal, -0.25)).toBeCloseTo(expected, 2);
        // the plain opening keeps its 10 triangles: no panes
        expect(node('plain').indices.length / 3).toBe(10);
        // every bar of the arched opening lies inside the arch
        const a = node('arch');
        const o = openings[1];
        let inside = 0, total = 0;
        for (let i = 0; i < a.positions.length; i += 3) {
            const d = [a.positions[i] - wall.origin[0], a.positions[i + 1] - wall.origin[1], a.positions[i + 2] - wall.origin[2]];
            const off = d[0] * wall.normal[0] + d[1] * wall.normal[1] + d[2] * wall.normal[2];
            if (Math.abs(off + 0.25) > 1e-5) continue;
            const s = d[0] * wall.axisS[0] + d[1] * wall.axisS[1] + d[2] * wall.axisS[2], t = d[0] * wall.axisT[0] + d[1] * wall.axisT[1] + d[2] * wall.axisT[2];
            total++;
            // within a few mm of the outline (the arch is a polygon of 16 segments)
            if (inOpening({ s0: o.s0 - 0.01, s1: o.s1 + 0.01, t0: o.t0 - 0.01, t1: o.t1 + 0.01, archRiseM: 1.01 }, s, t)) inside++;
        }
        expect(total).toBeGreaterThan(40);
        expect(inside).toBe(total);
    });
});

/** A 10 m x 8 m wall facing +z at z = 0. */
const WALL: MassingFace = {
    index: 0, key: 'w:p:0:0', kind: 'wall', part: 'p', loop: 0, edge: 0, wall: true,
    normal: [0, 0, 1], axisS: [1, 0, 0], axisT: [0, 1, 0], origin: [0, 0, 0],
    sMin: 0, sMax: 10, tMin: 0, tMax: 8, tBottom: 0, area: 80, pixel: 0.05, orthoSMin: 0, orthoTMax: 8, width: 200, height: 160, coverage: 1, openings: [], top: []
};

describe('opening detail from a reading', () => {
    const items = programItems({
        wallColour: '#c0b0a0',
        openings: [
            { h0: 1, h1: 3, depth: 0.25, cols: [[1, 2], [4, 5]], filledCols: [[7, 8]], panes: { cols: 2, rows: 2, bar: 0.08, frame: 0.06, colour: '#ffffff' }, sill: { out: 0.12, height: 0.1, overhang: 0.05, colour: '#e0e0e0' }, surround: { width: 0.2, out: 0.06 } },
            { h0: 4, h1: 7, archRise: 0.5, cols: [[1, 2]], surround: { width: 0.15, out: 0.05 } }
        ]
    }, WALL, 'g0_');

    it('gives every opening of a paned row its panes, and a sill and surround per row', () => {
        expect(items.counts).toMatchObject({ openings: 4, filledOpenings: 1, paned: 3, sills: 3, surrounds: 4 });
        const first = items.openings.find(o => o.id === 'g0_o0_0')!;
        expect(first.panes).toEqual({ cols: 2, rows: 2, barM: 0.08, frameM: 0.06, depthM: 0.06 });
        expect(items.colours.get('g0_o0_0:frame')).toEqual([255, 255, 255]);
        expect(items.openings.find(o => o.id === 'g0_o1_0')!.panes).toBeUndefined();
        // the sill: seen and continued openings in separate sweeps, its top at the opening's bottom, overhanging each side
        const sill = items.faceSweeps.find(w => w.id === 'g0_o0s')!;
        expect(sill.provenance).toBe('photo-inferred');
        expect(sill.placements).toEqual([[0.95, 2.05, 1], [3.95, 5.05, 1]]);
        expect(Math.max(...sill.profile.map(([out]) => out))).toBeCloseTo(0.12, 9);
        expect(items.faceSweeps.find(w => w.id === 'g0_o0sf')!.provenance).toBe('generated');
        // the surround: jambs on both sides up to the springing line, a head only over a flat-headed opening
        const archJambs = items.faceSweeps.find(w => w.id === 'g0_o1jl')!;
        expect(archJambs.placements).toEqual([[4, 6.5, 1]]);
        expect(items.faceSweeps.some(w => w.id === 'g0_o1hd')).toBe(false);
        expect(items.faceSweeps.find(w => w.id === 'g0_o0hd')!.placements).toEqual([[0.8, 2.2, 3], [3.8, 5.2, 3]]);
    });

    it('paints the bars and frame in their colour, the glass between them in the glazing colour', () => {
        const o = items.openings.find(x => x.id === 'g0_o0_0')!;
        expect(onPaneBar(o, 1.5, 2)).toBe(true);     // the mullion and transom cross at the centre
        expect(onPaneBar(o, 1.03, 1.5)).toBe(true);  // the frame
        expect(onPaneBar(o, 1.25, 1.5)).toBe(false); // a pane
        const tex = paintFaces([WALL], new Map([[WALL.key, items]]), [0, 0, 0]).get(0)!;
        const px = (s: number, t: number) => (Math.floor((WALL.orthoTMax - t) / WALL.pixel) * WALL.width + Math.floor((s - WALL.orthoSMin) / WALL.pixel)) * 4;
        expect([...tex.rgba.subarray(px(1.5, 2.01), px(1.5, 2.01) + 3)]).toEqual([255, 255, 255]);
        expect([...tex.rgba.subarray(px(1.25, 1.5), px(1.25, 1.5) + 3)]).toEqual([40, 44, 50]);
    });

    it('counts sills and surround jambs as members in the check', () => {
        const shapes = programShapes({ openings: [{ h0: 1, h1: 3, cols: [[1, 2]], sill: { out: 0.1, height: 0.1 }, surround: { width: 0.2, out: 0.05 } }] });
        expect(shapes.filter(s => s.kind === 'opening')).toHaveLength(1);
        expect(shapes.filter(s => s.kind === 'member').map(s => [s.u0, s.u1, s.h0, s.h1])).toEqual([[0.95, 2.05, 0.9, 1], [0.8, 1, 1, 3], [2, 2.2, 1, 3]]);
    });
});

describe('openings across a split wall', () => {
    it('splits an opening straddling the cut of a split edge onto each piece instead of rejecting it', async () => {
        const dir = tmp();
        // a low part against the front edge splits it in pieces w:a:0:0:0 (0-4 m), :1 (4-6 m, above the low part), :2 (6-10 m)
        const m: Pick<Massing, 'parts' | 'meshes'> = { parts: [
            { id: 'a', baseY: 0, topY: 10, loops: [[[0, 0], [10, 0], [10, -6], [0, -6]]], planes: [], heightSource: 'vector', heights: {} },
            { id: 'b', baseY: 0, topY: 4, loops: [[[4, 2], [6, 2], [6, 0], [4, 0]]], planes: [], heightSource: 'vector', heights: {} }], meshes: [] };
        const opening = (id: string, s0: number, s1: number): OpeningItem => ({ id, face: 'w:a:0:0', s0, s1, t0: 6, t1: 8, depth: 0.3, scanned: false, confidence: 0.5, provenance: 'photo-inferred' });
        const r = await runMassing(massingSpecText(m, { outDir: dir, params: PARAMS, openings: [opening('across', 3, 5), opening('inside', 1, 2)] }), dir);
        expect(r.report.faces.filter(f => f.key.startsWith('w:a:0:0:'))).toHaveLength(3);
        expect(r.report.rejectedOpenings).toEqual([]);
        const names = r.nodes.filter(n => n.name.startsWith('opening:')).map(n => n.name).sort();
        expect(names).toEqual(['opening:across:0', 'opening:across:1', 'opening:inside']);
        // each copy stays on its own piece: the halves span x 3-4 and 4-5 (less the 3 cm margin at the cut)
        const xs = (name: string) => { const n = r.nodes.find(q => q.name === name)!; const x = n.positions.filter((_, i) => i % 3 === 0); return [Math.min(...x), Math.max(...x)]; };
        const [a0, a1] = xs('opening:across:0'), [b0, b1] = xs('opening:across:1');
        expect(a0).toBeLessThan(3.1); expect(a1).toBeLessThanOrEqual(4.0); expect(b0).toBeGreaterThanOrEqual(4.0); expect(b1).toBeGreaterThan(4.9);
    });

    it('clipOpenings keeps sill sweeps placed above a neighbour part, clamping each placement on its own height', async () => {
        const dir = tmp();
        const m: Pick<Massing, 'parts' | 'meshes'> = { parts: [
            { id: 'a', baseY: 0, topY: 10, loops: [[[0, 0], [10, 0], [10, -6], [0, -6]]], planes: [], heightSource: 'vector', heights: {} },
            { id: 'b', baseY: 0, topY: 4, loops: [[[4, 2], [6, 2], [6, 0], [4, 0]]], planes: [], heightSource: 'vector', heights: {} }], meshes: [] };
        // a 12 cm sill profile (cross values relative to each placement's height): one at 6 m across the cut, one at 2 m
        // straddling the part b (which covers piece :1 below 4 m), one at 3 m on piece :0 alone
        const sill = { id: 'sill', confidence: 0.5, provenance: 'photo-inferred', face: 'w:a:0:0', axis: 0 as const,
            profile: [[0, 0], [0.08, 0], [0.08, 0.12], [0, 0.12]] as Array<[number, number]>, placements: [[3, 5, 6], [1, 3, 3]] as Array<[number, number, number]> };
        const r = await runMassing(massingSpecText(m, { outDir: dir, params: { ...PARAMS, clipOpenings: 1 }, faceSweeps: [sill] }), dir);
        expect(r.report.rejectedSweeps).toEqual([]);
        const nodes = r.nodes.filter(n => n.name.startsWith('facesweep:sill'));
        const ys = nodes.flatMap(n => Array.from(n.positions).filter((_, i) => i % 3 === 1));
        // the sills stand at their own heights: 3-3.12 m and 6-6.12 m, none clamped up to the raised bottom (4 m)
        expect(Math.min(...ys)).toBeCloseTo(3, 3);
        expect(Math.max(...ys)).toBeCloseTo(6.12, 3);
        expect(ys.every(y => (y > 2.999 && y < 3.121) || (y > 5.999 && y < 6.121))).toBe(true);
    });

    it('clipOpenings drops a profile the raised bottom hides but for a sliver, and clamps one it only cuts into', async () => {
        const dir = tmp();
        const m: Pick<Massing, 'parts' | 'meshes'> = { parts: [
            { id: 'a', baseY: 0, topY: 10, loops: [[[0, 0], [10, 0], [10, -6], [0, -6]]], planes: [], heightSource: 'vector', heights: {} },
            { id: 'b', baseY: 0, topY: 4, loops: [[[4, 2], [6, 2], [6, 0], [4, 0]]], planes: [], heightSource: 'vector', heights: {} }], meshes: [] };
        // piece w:a:0:0:1 (x 4-6) stands above the low part: its bottom is 4 m
        const band = (id: string, t0: number, t1: number) => ({ id, confidence: 0.5, provenance: 'photo-inferred', face: 'w:a:0:0:1', axis: 0 as const,
            profile: [[0, t0], [0.2, t0], [0.2, t1], [0, t1]] as Array<[number, number]>, placements: [[0.3, 1.7, 0]] as Array<[number, number, number]> });
        const r = await runMassing(massingSpecText(m, { outDir: dir, params: { ...PARAMS, clipOpenings: 1 }, faceSweeps: [band('hidden', 2.2, 4.2), band('half', 3, 5)] }), dir);
        expect(r.report.rejectedSweeps).toEqual(['hidden']);      // 0.2 m of 2 m left: a sliver, dropped
        const ys = r.nodes.filter(n => n.name.startsWith('facesweep:half')).flatMap(n => Array.from(n.positions).filter((_, i) => i % 3 === 1));
        expect(Math.min(...ys)).toBeCloseTo(4, 3);                 // clamped to the raised bottom
        expect(Math.max(...ys)).toBeCloseTo(5, 3);
    });
});

