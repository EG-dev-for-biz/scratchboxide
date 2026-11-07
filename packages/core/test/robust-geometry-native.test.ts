/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The engine's constrained Delaunay triangulation (scratchbox_cdt.hpp) through remesh_polish_native: areas, kept
 * segments, orientation and angles are measured on what comes back.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { ensureRemeshPolishBinary, runNativeCdt } from '../src/node/3d-engine/staged-location/remesh-polish-native';

beforeAll(async () => { await ensureRemeshPolishBinary(); }, 900_000);

type P2 = [number, number];

const triArea2 = (p: P2[], t: number[]) => ((p[t[1]][0] - p[t[0]][0]) * (p[t[2]][1] - p[t[0]][1]) - (p[t[1]][1] - p[t[0]][1]) * (p[t[2]][0] - p[t[0]][0])) / 2;
const minAngle2 = (a: P2, b: P2, c: P2) => {
    const ang = (p: P2, q: P2, r: P2) => { const u = [q[0] - p[0], q[1] - p[1]], v = [r[0] - p[0], r[1] - p[1]]; return (Math.atan2(Math.abs(u[0] * v[1] - u[1] * v[0]), u[0] * v[0] + u[1] * v[1]) * 180) / Math.PI; };
    return Math.min(ang(a, b, c), ang(b, c, a), ang(c, a, b));
};
const loopSegs = (loops: number[][]): Array<[number, number]> => loops.flatMap(l => l.map((v, i) => [v, l[(i + 1) % l.length]] as [number, number]));

describe('the constrained Delaunay triangulation', () => {
    it('triangulates a square with a hole over its own vertices, every segment kept, collinear and repeated points included', () => {
        const pts: P2[] = [[0, 0], [5, 0], [10, 0], [10, 10], [0, 10], [3, 3], [3, 7], [7, 7], [7, 3], [10, 0]];
        const loops = [[0, 1, 2, 3, 4], [5, 6, 7, 8]];
        const r = runNativeCdt(pts, loopSegs(loops));
        expect(r.report).toMatchObject({ crossingPoints: 0, lostSegments: 0 });
        expect(r.tris.reduce((a, t) => a + triArea2(r.points, t), 0)).toBeCloseTo(84, 9);
        // 9 distinct vertices, one hole: 9 + 2 - 2 triangles, every one counter-clockwise
        expect(r.tris.length).toBe(9);
        for (const t of r.tris) expect(triArea2(r.points, t)).toBeGreaterThan(0);
        const edges = new Set(r.tris.flatMap(t => [0, 1, 2].map(k => { const a = t[k], b = t[(k + 1) % 3]; return a < b ? `${a},${b}` : `${b},${a}`; })));
        for (const [a, b] of loopSegs(loops)) { const x = Math.min(a, b), y = Math.max(a, b); expect(edges.has(`${x},${y}`)).toBe(true); }
    });

    it('stays valid on a fan of 200 exactly collinear points under one apex (earcut-style clipping folds here)', () => {
        const pts: P2[] = Array.from({ length: 200 }, (_, i) => [i * 0.1, 0] as P2);
        pts.push([10, 3]);
        const loop = Array.from({ length: 201 }, (_, i) => i);
        const r = runNativeCdt(pts, loopSegs([loop]));
        expect(r.report.lostSegments).toBe(0);
        expect(r.tris.length).toBe(199);
        for (const t of r.tris) expect(triArea2(r.points, t)).toBeGreaterThan(0);
        expect(r.tris.reduce((a, t) => a + triArea2(r.points, t), 0)).toBeCloseTo((19.9 * 3) / 2, 9);
    });

    it('unions overlapping loops by the non-zero rule, splitting crossing segments where they meet', () => {
        const pts: P2[] = [[0, 0], [4, 0], [4, 4], [0, 4], [2, 2], [6, 2], [6, 6], [2, 6]];
        const r = runNativeCdt(pts, loopSegs([[0, 1, 2, 3], [4, 5, 6, 7]]), { fill: 'non-zero' });
        expect(r.report.crossingPoints).toBe(2);
        expect(r.tris.reduce((a, t) => a + triArea2(r.points, t), 0)).toBeCloseTo(28, 9);
    });

    it('refines an L-shaped plan until every triangle reaches 25 degrees, the area unchanged', () => {
        const pts: P2[] = [[0, 0], [30, 0], [30, 8], [8, 8], [8, 25], [0, 25]];
        const plain = runNativeCdt(pts, loopSegs([[0, 1, 2, 3, 4, 5]]));
        const fine = runNativeCdt(pts, loopSegs([[0, 1, 2, 3, 4, 5]]), { refine: true, minAngleDeg: 25 });
        const minOf = (r: ReturnType<typeof runNativeCdt>) => Math.min(...r.tris.map(t => minAngle2(r.points[t[0]], r.points[t[1]], r.points[t[2]])));
        expect(minOf(plain)).toBeLessThan(25);
        expect(minOf(fine)).toBeGreaterThanOrEqual(25 - 1e-9);
        expect(fine.tris.reduce((a, t) => a + triArea2(fine.points, t), 0)).toBeCloseTo(30 * 8 + 8 * 17, 9);
        // with the rim locked no segment is split: the outline's vertices stay exactly the input's
        const locked = runNativeCdt(pts, loopSegs([[0, 1, 2, 3, 4, 5]]), { refine: true, minAngleDeg: 25, splitSegments: false });
        expect(locked.report.segmentSplits).toBe(0);
    });
});
