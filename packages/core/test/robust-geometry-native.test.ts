/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The engine's robust geometry, on real geometry: the constrained Delaunay triangulation (scratchbox_cdt.hpp), the
 * mesh boolean (scratchbox_boolean.hpp), pipeline K's footprint clip by that boolean (scratchbox_footprint_clip.hpp), each through
 * remesh_polish_native. Areas, volumes, open and
 * non-manifold edges, angles and corner counts are measured on what comes back.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { beforeAll, describe, expect, it } from 'vitest';
import { ensureRemeshPolishBinary, runNativeBoolean, runNativeCdt, type NativeMesh } from '../src/node/3d-engine/staged-location/remesh-polish-native';
import { clipToFootprint, fillOpenLoops } from '../src/node/3d-engine/staged-location/pipeline-k/lattice-stitch';
import { writeStagedGlbFile } from '../src/node/3d-engine/staged-location/staged-glb-writer';
import { readGlbTriangles } from './helpers/clay-glb-render';

beforeAll(async () => { await ensureRemeshPolishBinary(); }, 900_000);

type P2 = [number, number];
type V = [number, number, number];

const triArea2 = (p: P2[], t: number[]) => ((p[t[1]][0] - p[t[0]][0]) * (p[t[2]][1] - p[t[0]][1]) - (p[t[1]][1] - p[t[0]][1]) * (p[t[2]][0] - p[t[0]][0])) / 2;
const minAngle2 = (a: P2, b: P2, c: P2) => {
    const ang = (p: P2, q: P2, r: P2) => { const u = [q[0] - p[0], q[1] - p[1]], v = [r[0] - p[0], r[1] - p[1]]; return (Math.atan2(Math.abs(u[0] * v[1] - u[1] * v[0]), u[0] * v[0] + u[1] * v[1]) * 180) / Math.PI; };
    return Math.min(ang(a, b, c), ang(b, c, a), ang(c, a, b));
};
const loopSegs = (loops: number[][]): Array<[number, number]> => loops.flatMap(l => l.map((v, i) => [v, l[(i + 1) % l.length]] as [number, number]));

/** A box as a closed outward mesh. */
function box(lo: V, hi: V): NativeMesh {
    const P: number[] = [];
    for (let i = 0; i < 8; i++) P.push(i & 1 ? hi[0] : lo[0], i & 2 ? hi[1] : lo[1], i & 4 ? hi[2] : lo[2]);
    const f = [[0, 2, 3, 1], [4, 5, 7, 6], [0, 1, 5, 4], [2, 6, 7, 3], [0, 4, 6, 2], [1, 3, 7, 5]];
    return { positions: P, indices: f.flatMap(q => [q[0], q[1], q[2], q[0], q[2], q[3]]) };
}
/** An icosphere (subdivided twice) as a closed outward mesh. */
function sphere(r: number, c: V, subdivisions = 2): NativeMesh {
    const t = (1 + Math.sqrt(5)) / 2;
    let P: V[] = [[-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0], [0, -1, t], [0, 1, t], [0, -1, -t], [0, 1, -t], [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1]];
    let F = [[0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11], [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8], [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9], [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1]];
    for (let s = 0; s < subdivisions; s++) {
        const mid = new Map<string, number>(), nf: number[][] = [];
        const m = (a: number, b: number) => { const k = a < b ? `${a},${b}` : `${b},${a}`; let v = mid.get(k); if (v === undefined) { v = P.length; P.push([(P[a][0] + P[b][0]) / 2, (P[a][1] + P[b][1]) / 2, (P[a][2] + P[b][2]) / 2]); mid.set(k, v); } return v; };
        for (const [a, b, c2] of F) { const x = m(a, b), y = m(b, c2), z = m(c2, a); nf.push([a, x, z], [b, y, x], [c2, z, y], [x, y, z]); }
        F = nf;
    }
    P = P.map(p => { const l = Math.hypot(...p); return [(p[0] / l) * r + c[0], (p[1] / l) * r + c[1], (p[2] / l) * r + c[2]]; });
    return { positions: P.flat(), indices: F.flat() };
}
function volume(m: { positions: ArrayLike<number>; indices: ArrayLike<number> }): number {
    let v = 0;
    const p = (i: number) => [m.positions[i * 3], m.positions[i * 3 + 1], m.positions[i * 3 + 2]];
    for (let t = 0; t + 2 < m.indices.length; t += 3) {
        const a = p(m.indices[t]), b = p(m.indices[t + 1]), c = p(m.indices[t + 2]);
        v += (a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0]) + a[2] * (b[0] * c[1] - b[1] * c[0])) / 6;
    }
    return v;
}
/** Edges of one triangle and of more than two, by vertex index. */
function edgeCounts(indices: ArrayLike<number>): { open: number; nonManifold: number } {
    const c = new Map<string, number>();
    for (let t = 0; t + 2 < indices.length; t += 3) for (let k = 0; k < 3; k++) { const a = indices[t + k], b = indices[t + ((k + 1) % 3)]; const key = a < b ? `${a},${b}` : `${b},${a}`; c.set(key, (c.get(key) ?? 0) + 1); }
    let open = 0, nonManifold = 0;
    for (const n of c.values()) { if (n === 1) open++; else if (n > 2) nonManifold++; }
    return { open, nonManifold };
}

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

describe('the robust mesh boolean', () => {
    const closed = (r: ReturnType<typeof runNativeBoolean>) => { const e = edgeCounts(r.indices); expect(e).toEqual({ open: 0, nonManifold: 0 }); expect(r.report).toMatchObject({ unpairedSegments: 0, chainFailures: 0, windingConflicts: 0 }); };

    it('gives exact volumes and a closed manifold for overlapping boxes', () => {
        const a = box([0, 0, 0], [1, 1, 1]), b = box([0.5, 0.5, 0.5], [1.5, 1.5, 1.5]);
        const u = runNativeBoolean(a, b, 'union'), n = runNativeBoolean(a, b, 'intersection'), d = runNativeBoolean(a, b, 'difference');
        for (const r of [u, n, d]) closed(r);
        expect(volume(u)).toBeCloseTo(1.875, 12);
        expect(volume(n)).toBeCloseTo(0.125, 12);
        expect(volume(d)).toBeCloseTo(0.875, 12);
    });

    it('resolves coplanar and touching solids consistently: touching boxes merge, a shared skin is cut away, identical solids cancel', () => {
        const a = box([0, 0, 0], [1, 1, 1]);
        const touch = runNativeBoolean(a, box([1, 0, 0], [2, 1, 1]), 'union');
        closed(touch);
        expect(volume(touch)).toBeCloseTo(2, 12);
        expect(runNativeBoolean(a, box([1, 0, 0], [2, 1, 1]), 'intersection').indices.length).toBe(0);
        const half = runNativeBoolean(a, box([0, 0, 0], [0.5, 1, 1]), 'difference');
        closed(half);
        expect(volume(half)).toBeCloseTo(0.5, 12);
        expect(runNativeBoolean(a, a, 'difference').indices.length).toBe(0);
        const same = runNativeBoolean(a, a, 'union');
        closed(same);
        expect(volume(same)).toBeCloseTo(1, 12);
        // a drill through: a closed solid of genus one
        const drilled = runNativeBoolean(a, box([0.25, 0.25, -1], [0.75, 0.75, 2]), 'difference');
        closed(drilled);
        expect(volume(drilled)).toBeCloseTo(0.75, 12);
    });

    it('keeps inclusion-exclusion exact on curved solids: V(A u B) + V(A n B) = V(A) + V(B)', () => {
        for (const c of [[0.3, 0.2, 0.1], [0.8, -0.1, 0.4], [-0.5, 0.5, -0.2]] as V[]) {
            const a = sphere(1, [0, 0, 0]), b = sphere(0.9, c);
            const u = runNativeBoolean(a, b, 'union'), n = runNativeBoolean(a, b, 'intersection'), d = runNativeBoolean(a, b, 'difference');
            for (const r of [u, n, d]) closed(r);
            expect(volume(u) + volume(n)).toBeCloseTo(volume(a) + volume(b), 9);
            expect(volume(d)).toBeCloseTo(volume(a) - volume(n), 9);
        }
    });

    it('trims an open sheet to the inside of a closed solid: the area exact, only the cut curve left open', () => {
        // a 20 x 20 m sheet of 1 m cells at y = 5, a 9.5 m box over part of it
        const P: number[] = [], I: number[] = [];
        for (let z = 0; z <= 20; z++) for (let x = 0; x <= 20; x++) P.push(x, 5, z);
        for (let z = 0; z < 20; z++) for (let x = 0; x < 20; x++) { const a = z * 21 + x; I.push(a, a + 21, a + 1, a + 1, a + 21, a + 22); }
        const r = runNativeBoolean({ positions: P, indices: I }, box([3.25, 0, 2.5], [12.75, 10, 12]), 'trim-inside');
        let area = 0;
        for (let t = 0; t < r.indices.length; t += 3) {
            const q = (k: number) => [r.positions[r.indices[t + k] * 3], r.positions[r.indices[t + k] * 3 + 2]];
            const [a, b, c] = [q(0), q(1), q(2)];
            area += Math.abs((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])) / 2;
        }
        expect(area).toBeCloseTo(9.5 * 9.5, 9);
        const e = edgeCounts(r.indices);
        expect(e.nonManifold).toBe(0);
        // the open edges run round the cut, and nowhere else
        for (let t = 0; t < r.indices.length; t++) {
            const x = r.positions[r.indices[t] * 3], z = r.positions[r.indices[t] * 3 + 2];
            expect(x).toBeGreaterThanOrEqual(3.25 - 1e-9);
            expect(x).toBeLessThanOrEqual(12.75 + 1e-9);
            expect(z).toBeGreaterThanOrEqual(2.5 - 1e-9);
            expect(z).toBeLessThanOrEqual(12 + 1e-9);
        }
        expect(e.open).toBeGreaterThan(0);
    });
});

function glbOf(soup: number[]): Uint8Array {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'robust-')), 'm.glb');
    const positions = Float32Array.from(soup);
    writeStagedGlbFile(file, [{ name: 'scan', positions, indices: Uint32Array.from({ length: positions.length / 3 }, (_, i) => i) }], {});
    return fs.readFileSync(file);
}
function live(bytes: Uint8Array): V[][] {
    const t = readGlbTriangles(bytes), out: V[][] = [];
    for (let i = 0; i + 2 < t.indices.length; i += 3) {
        const ids = [t.indices[i], t.indices[i + 1], t.indices[i + 2]];
        if (ids[0] === ids[1] || ids[1] === ids[2] || ids[0] === ids[2]) continue;
        out.push(ids.map(k => [t.positions[k * 3], t.positions[k * 3 + 1], t.positions[k * 3 + 2]] as V));
    }
    return out;
}
const area3 = (t: V[]) => { const u = [t[1][0] - t[0][0], t[1][1] - t[0][1], t[1][2] - t[0][2]], v = [t[2][0] - t[0][0], t[2][1] - t[0][1], t[2][2] - t[0][2]]; return Math.hypot(u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]) / 2; };

describe("pipeline K's footprint clip by the boolean", () => {
    // an L-shaped footprint: its inner edges' lines run on through the far walls
    const L: Array<Array<[number, number]>> = [[[0, 0], [20, 0], [20, 8], [8, 8], [8, 20], [0, 20]]];
    /** A closed box of walls over [x0, x1] x [z0, z1], 1 m cells, from y 0 to h. */
    function walls(x0: number, x1: number, z0: number, z1: number, h: number): number[] {
        const soup: number[] = [];
        const quad = (a: V, b: V, c: V, d: V) => soup.push(...a, ...b, ...c, ...a, ...c, ...d);
        for (let y = 0; y < h; y++) {
            for (let x = x0; x < x1; x++) { quad([x, y, z0], [x + 1, y, z0], [x + 1, y + 1, z0], [x, y + 1, z0]); quad([x + 1, y, z1], [x, y, z1], [x, y + 1, z1], [x + 1, y + 1, z1]); }
            for (let z = z0; z < z1; z++) { quad([x0, y, z + 1], [x0, y, z], [x0, y + 1, z], [x0, y + 1, z + 1]); quad([x1, y, z], [x1, y, z + 1], [x1, y + 1, z + 1], [x1, y + 1, z]); }
        }
        for (let x = x0; x < x1; x++) for (let z = z0; z < z1; z++) { quad([x, h, z], [x, h, z + 1], [x + 1, h, z + 1], [x + 1, h, z]); quad([x, 0, z], [x + 1, 0, z], [x + 1, 0, z + 1], [x, 0, z + 1]); }
        return soup;
    }

    it('cuts only where the prism wall crosses the building, leaves no sliver, and agrees with the outline plus the margin', () => {
        // the scan: a 24 x 24 m box over the L, 6 m high; everything past the L plus 0.3 m goes
        const scan = glbOf(walls(-2, 22, -2, 22, 6));
        const m = 0.3;
        const robust = clipToFootprint(scan, L, m);
        expect(robust.report.method).toBe('robust boolean');
        const b = robust.report.boolean!;
        expect(b).toMatchObject({ unpairedSegments: 0, chainFailures: 0, windingConflicts: 0, nonManifoldAfter: 0, slivers: 0 });
        // the roof kept is exactly the L pushed out by the margin (mitred): (20.6 x 8.6) + (8.6 x 12)
        const roof = live(robust.glb).filter(t => t.every(p => Math.abs(p[1] - 6) < 1e-4));
        expect(roof.reduce((a, t) => a + area3(t), 0)).toBeCloseTo(20.6 * 8.6 + 8.6 * 12, 2);
        for (const t of live(robust.glb)) for (const p of t) {
            const inLeg1 = p[0] >= -m - 1e-4 && p[0] <= 20 + m + 1e-4 && p[2] >= -m - 1e-4 && p[2] <= 8 + m + 1e-4;
            const inLeg2 = p[0] >= -m - 1e-4 && p[0] <= 8 + m + 1e-4 && p[2] >= -m - 1e-4 && p[2] <= 20 + m + 1e-4;
            expect(inLeg1 || inLeg2).toBe(true);
        }
    });

    it('closes completely with the infill after the clip: no open or non-manifold edge left', () => {
        // a block across the L's long leg: its walls cut at x = -0.3 and 20.3, the cut sections capped by the infill
        const clipped = clipToFootprint(glbOf(walls(-2, 22, 2, 6, 6)), L, 0.3).glb;
        const filled = fillOpenLoops(clipped, [], { footprint: L });
        expect(filled.report.openAfter).toBe(0);
        expect(filled.report.nonManifoldAfter).toBe(0);
        expect(filled.report.unclosedLoops).toBe(0);
    });
});
