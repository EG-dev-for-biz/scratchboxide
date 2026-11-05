/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Pipeline K's outside closure (pipeline-k/outside-closure.ts, inner-core.ts, corner-join.ts) on small textured buildings:
 *  - the inner core is closed (every edge of it used by exactly two of its triangles, each pair facing apart), stays at
 *    least insetM behind every surface, lies inside the building, follows a notch (an L-shaped plan), and is never what an
 *    outside view meets first except through the hole;
 *  - a hole in a wall is seen less once the core stands behind it, and the gate reports it before and after;
 *  - two rebuilt facades stopping short of their corner are joined on the corner line, both strips on the same points, and
 *    their near corners welded; no strip where one overshoots the corner, or where a surface facing out already stands behind;
 *  - the scan is put back only behind a rebuilt wall;
 *  - a scan piece floating free (touching no surface nor the ground) is dropped; one hanging from a wall is kept; a larger
 *    scan sheet sticking out of the building into the air (outside on both sides) is dropped, the building's own walls kept.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { assembleGlb, parseGlbBytes } from '../src/node/3d-engine/staged-location/glb-bytes';
import { ensureRemeshPolishBinary } from '../src/node/3d-engine/staged-location/remesh-polish-native';
import { addInnerCore, INNER_CORE_PARAMS, readSoup } from '../src/node/3d-engine/staged-location/pipeline-k/inner-core';
import { joinFacadeCorners } from '../src/node/3d-engine/staged-location/pipeline-k/corner-join';
import { closeOutside, dropTriangles, findShards, restoreScan } from '../src/node/3d-engine/staged-location/pipeline-k/outside-closure';
import { measureVisibleDefects, VISIBLE_DEFECTS_PARAMS } from '../src/node/3d-engine/staged-location/pipeline-k/visible-defects';

type V = [number, number, number];

/** A rectangle as two triangles (corner o, edges a and b), counter-clockwise seen from the side a x b points to. */
const quad = (o: V, a: V, b: V): V[] => {
    const p = (i: number, j: number): V => [o[0] + a[0] * i + b[0] * j, o[1] + a[1] * i + b[1] * j, o[2] + a[2] * i + b[2] * j];
    return [p(0, 0), p(1, 0), p(1, 1), p(0, 0), p(1, 1), p(0, 1)];
};
/** A face of n x m cells (corner o, cell edges a and b), cells skipped by `hole`. */
const grid = (o: V, a: V, b: V, n: number, m: number, hole: (i: number, j: number) => boolean = () => false): V[] => {
    const out: V[] = [];
    for (let j = 0; j < m; j++) for (let i = 0; i < n; i++) if (!hole(i, j)) out.push(...quad([o[0] + a[0] * i + b[0] * j, o[1] + a[1] * i + b[1] * j, o[2] + a[2] * i + b[2] * j], a, b));
    return out;
};
/** A box [x0, x1] x [0, h] x [z0, z1] in 2 m cells, every face wound outward; its +z face with an optional hole (cell i, j). */
function box(x0: number, x1: number, z0: number, z1: number, h: number, hole?: (i: number, j: number) => boolean): V[] {
    const nx = Math.round((x1 - x0) / 2), nz = Math.round((z1 - z0) / 2), ny = Math.round(h / 2);
    return [
        ...grid([x0, 0, z1], [2, 0, 0], [0, 2, 0], nx, ny, hole),
        ...grid([x1, 0, z0], [-2, 0, 0], [0, 2, 0], nx, ny),
        ...grid([x0, 0, z0], [0, 0, 2], [0, 2, 0], nz, ny),
        ...grid([x1, 0, z1], [0, 0, -2], [0, 2, 0], nz, ny),
        ...grid([x0, h, z1], [2, 0, 0], [0, 0, -2], nx, nz),
        ...grid([x0, 0, z0], [2, 0, 0], [0, 0, 2], nx, nz)
    ];
}

interface Part { name: string; tris: V[]; extras?: Record<string, unknown>; textured?: boolean }
/** A GLB of named nodes; textured parts use a planar map with width on every face, single-sided. */
function glb(parts: Part[]): Buffer {
    const chunks: Buffer[] = [], views: any[] = [], accessors: any[] = [];
    let len = 0;
    const add = (data: Float32Array | Uint32Array, type: string, n: number, ct = 5126) => {
        const b = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
        views.push({ buffer: 0, byteOffset: len, byteLength: b.length }); chunks.push(b); len += b.length;
        accessors.push({ bufferView: views.length - 1, componentType: ct, count: n, type });
        return accessors.length - 1;
    };
    const meshes = parts.map(p => {
        const attributes: Record<string, number> = { POSITION: add(Float32Array.from(p.tris.flat()), 'VEC3', p.tris.length) };
        if (p.textured !== false) attributes.TEXCOORD_0 = add(Float32Array.from(p.tris.flatMap(([x, y, z]) => [(x + z) / 40, (y + 0.5 * z) / 40])), 'VEC2', p.tris.length);
        return { primitives: [{ attributes, indices: add(Uint32Array.from(p.tris.map((_, i) => i)), 'SCALAR', p.tris.length, 5125), material: p.textured === false ? 1 : 0 }] };
    });
    const nodes = parts.map((p, i) => ({ name: p.name, mesh: i, ...(p.extras ? { extras: p.extras } : {}) }));
    const json = {
        asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: nodes.map((_, i) => i) }], nodes, meshes,
        materials: [{ pbrMetallicRoughness: { baseColorTexture: { index: 0 } } }, { pbrMetallicRoughness: { baseColorFactor: [0.5, 0.5, 0.5, 1] } }],
        textures: [{ source: 0 }], images: [{ uri: 'data:image/png;base64,' }],
        buffers: [{ byteLength: len }], bufferViews: views, accessors
    };
    return assembleGlb(json, Buffer.concat(chunks));
}

/** A node's triangles in world space (the fixtures have no transforms). */
function nodeTris(bytes: Uint8Array, name: string): number[][][] {
    const g = parseGlbBytes(bytes), s = readSoup(g), ni = g.json.nodes.findIndex((n: any) => n.name === name), out: number[][][] = [];
    for (let t = 0; t < s.node.length; t++) if (s.node[t] === ni) out.push([0, 1, 2].map(k => [s.pos[t * 9 + k * 3], s.pos[t * 9 + k * 3 + 1], s.pos[t * 9 + k * 3 + 2]]));
    return out;
}
const sub = (a: number[], b: number[]) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a: number[], b: number[]) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a: number[], b: number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
/** Point-to-triangle distance by sampling the triangle densely (enough for these planar 2 m cells). */
function distToTris(p: number[], tris: number[][][]): number {
    let best = Infinity;
    for (const [a, b, c] of tris) {
        const n = cross(sub(b, a), sub(c, a)), nl = Math.hypot(n[0], n[1], n[2]);
        if (!(nl > 0)) continue;
        const u = n.map(x => x / nl), d = dot(sub(p, a), u), q = sub(p, u.map(x => x * d));
        // inside the triangle: the plane distance; else the nearest edge
        const inside = [[a, b], [b, c], [c, a]].every(([x, y]) => dot(cross(sub(y, x), sub(q, x)), u) >= -1e-9);
        if (inside) { best = Math.min(best, Math.abs(d)); continue; }
        for (const [x, y] of [[a, b], [b, c], [c, a]]) {
            const e = sub(y, x), t = Math.max(0, Math.min(1, dot(sub(p, x), e) / dot(e, e)));
            best = Math.min(best, Math.hypot(...sub(p, [x[0] + e[0] * t, x[1] + e[1] * t, x[2] + e[2] * t])));
        }
    }
    return best;
}
/** The first triangle a ray meets (index), or -1. */
function firstHit(o: number[], d: number[], tris: number[][][]): number {
    let best = Infinity, hit = -1;
    tris.forEach(([a, b, c], i) => {
        const e1 = sub(b, a), e2 = sub(c, a), p = cross(d, e2), det = dot(e1, p);
        if (Math.abs(det) < 1e-12) return;
        const s = sub(o, a), u = dot(s, p) / det;
        if (u < 0 || u > 1) return;
        const q = cross(s, e1), v = dot(d, q) / det;
        if (v < 0 || u + v > 1) return;
        const t = dot(e2, q) / det;
        if (t > 1e-6 && t < best) { best = t; hit = i; }
    });
    return hit;
}

beforeAll(async () => { await ensureRemeshPolishBinary(); }, 900_000);

// the front face's hole: cells 3..5 x 2..4 of 2 m (6 m x 6 m, from x 6 to 12, y 4 to 10)
const hole = (i: number, j: number) => i >= 3 && i < 6 && j >= 2 && j < 5;

describe('inner core', () => {
    it('is closed, at least insetM behind every surface, inside the building and seen only through the hole', () => {
        const building = box(0, 20, 0, 16, 20, hole);
        const bytes = glb([{ name: 'Building', tris: building }]);
        const r = addInnerCore(bytes, [bytes]);
        expect(r.report.keptVoxels).toBeGreaterThan(100);
        expect(r.report.minClearanceM).toBeGreaterThanOrEqual(INNER_CORE_PARAMS.insetM - 1e-6);
        const core = nodeTris(r.others[0], 'InnerCore');
        expect(core.length).toBe(r.report.triangles);
        // closed: every edge (by its corners' positions) used by exactly two triangles, once each way
        const edges = new Map<string, number>();
        const k = (p: number[]) => p.map(x => x.toFixed(4)).join(',');
        for (const t of core) for (let i = 0; i < 3; i++) { const e = `${k(t[i])}>${k(t[(i + 1) % 3])}`; edges.set(e, (edges.get(e) ?? 0) + 1); }
        for (const [e, n] of edges) { expect(n).toBe(1); const [a, b] = e.split('>'); expect(edges.get(`${b}>${a}`)).toBe(1); }
        // behind every surface: each core corner at least insetM from the building, and inside it
        const walls = nodeTris(bytes, 'Building');
        for (const t of core) for (const p of t) {
            expect(distToTris(p, walls)).toBeGreaterThanOrEqual(INNER_CORE_PARAMS.insetM - 1e-3);
            expect(p[0]).toBeGreaterThan(0); expect(p[0]).toBeLessThan(20); expect(p[1]).toBeGreaterThan(0); expect(p[1]).toBeLessThan(20); expect(p[2]).toBeGreaterThan(0); expect(p[2]).toBeLessThan(16);
        }
        // never met first from outside except through the hole: rays from four sides and above
        const all = [...walls, ...core];
        let throughHole = 0;
        for (const [o0, d, step] of [[[-5, 0, -5], [0, 0, 1], [[1, 0, 0], [0, 1, 0]]], [[-5, 0, 30], [0, 0, -1], [[1, 0, 0], [0, 1, 0]]], [[-10, 0, -5], [1, 0, 0], [[0, 0, 1], [0, 1, 0]]], [[30, 0, -5], [-1, 0, 0], [[0, 0, 1], [0, 1, 0]]]] as Array<[number[], number[], number[][]]>) {
            for (let i = 0; i <= 30; i++) for (let j = 0; j <= 24; j++) {
                const o = [o0[0] + step[0][0] * (i + 0.37) + step[1][0] * (j + 0.29), o0[1] + step[0][1] * (i + 0.37) + step[1][1] * (j + 0.29), o0[2] + step[0][2] * (i + 0.37) + step[1][2] * (j + 0.29)];
                const h = firstHit(o, d, all);
                if (h < walls.length) continue;
                // a core triangle met first: the ray must have come in through the hole (the +z face at x 6..12, y 4..10)
                expect(d[2]).toBe(-1);
                expect(o[0] > 6 && o[0] < 12 && o[1] > 4 && o[1] < 10).toBe(true);
                throughHole++;
            }
        }
        expect(throughHole).toBeGreaterThan(0);
        // labelled generated, with its reason
        const node = parseGlbBytes(r.others[0]).json.nodes.find((n: any) => n.name === 'InnerCore');
        expect(node.extras.sbInnerCore.provenance.label).toBe('generated');
    });

    it('follows a notch: an L-shaped building keeps its core out of the notch', () => {
        // an L: [0, 20] x [0, 10] and [0, 10] x [10, 20], walls wound outward, closed
        const h = 12, L: V[] = [];
        const wall = (a: [number, number], b: [number, number]) => { const len = Math.hypot(b[0] - a[0], b[1] - a[1]), n = Math.round(len / 2); L.push(...grid([a[0], 0, a[1]], [(b[0] - a[0]) / n, 0, (b[1] - a[1]) / n], [0, 2, 0], n, h / 2)); };
        const outline: Array<[number, number]> = [[0, 0], [0, 20], [10, 20], [10, 10], [20, 10], [20, 0]];
        for (let i = 0; i < outline.length; i++) wall(outline[i], outline[(i + 1) % outline.length]);
        // top and bottom as 2 m cells over the L
        for (let x = 0; x < 20; x += 2) for (let z = 0; z < 20; z += 2) { if (x >= 10 && z >= 10) continue; L.push(...quad([x, h, z], [0, 0, 2], [2, 0, 0]), ...quad([x, 0, z], [2, 0, 0], [0, 0, 2])); }
        const bytes = glb([{ name: 'Building', tris: L }]);
        const r = addInnerCore(bytes, [bytes]);
        expect(r.report.keptVoxels).toBeGreaterThan(50);
        const walls = nodeTris(bytes, 'Building');
        for (const t of nodeTris(r.others[0], 'InnerCore')) for (const p of t) {
            expect(p[0] >= 10 && p[2] >= 10).toBe(false);
            expect(distToTris(p, walls)).toBeGreaterThanOrEqual(INNER_CORE_PARAMS.insetM - 1e-3);
        }
    });

    it('lowers the holes the outside check sees, and the gate reports before and after', () => {
        const bytes = glb([{ name: 'Building', tris: box(0, 20, 0, 16, 20, hole) }]);
        const P = { ...VISIBLE_DEFECTS_PARAMS, pixelM: 0.25 };
        const before = measureVisibleDefects(bytes, P), r = addInnerCore(bytes, [bytes]), after = measureVisibleDefects(r.others[0], P);
        expect(before.holeShare).toBeGreaterThan(0.005);
        expect(after.holeShare).toBeLessThan(before.holeShare / 3);
        const c = closeOutside({ clay: bytes, tex: bytes, joins: false });
        expect(c.report.before!.holeShare).toBeGreaterThan(c.report.after!.holeShare);
        expect(c.report.core!.keptVoxels).toBeGreaterThan(0);
    });
});

/** A facade (FacadeLattice) from (a) to (b) in plan, 0..h, its face toward `out`, in 2 m columns. */
function facade(id: number, a: [number, number], b: [number, number], h: number, out: [number, number]): Part {
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]), n = Math.max(1, Math.round(len / 2)), dx = (b[0] - a[0]) / n, dz = (b[1] - a[1]) / n;
    let tris = grid([a[0], 0, a[1]], [dx, 0, dz], [0, 2, 0], n, h / 2);
    // wind toward `out`
    const t = tris.slice(0, 3), nrm = cross(sub(t[1], t[0]), sub(t[2], t[0]));
    if (nrm[0] * out[0] + nrm[2] * out[1] < 0) tris = tris.map((_, i) => tris[i - (i % 3) + [0, 2, 1][i % 3]]);
    return { name: `FacadeLattice_${id}`, tris, extras: { sbFacadeLattice: { facadeId: id } } };
}

describe('corner joins', () => {
    it('joins two facades stopping short of their corner on the corner line, and welds near corners', () => {
        // the corner at (20, 10): facade 1 along z = 10 facing +z stops at x = 19.7; facade 2 along x = 20 facing +x starts at z = 9.7
        const f1 = facade(1, [0.7, 10], [19.7, 10], 12, [0, 1]), f2 = facade(2, [20, 9.7], [20, 0.7], 12, [1, 0]);
        const bytes = glb([f1, f2]);
        const j = joinFacadeCorners(bytes, [bytes]);
        expect(j.report.corners).toBe(1);
        const strips = nodeTris(j.others[0], 'CornerJoin');
        expect(strips.length).toBeGreaterThan(0);
        // every strip corner is on a facade's edge or on the corner line x = 20, z = 10; both facades' strips share the line's points
        const onLine = strips.flat().filter(p => Math.abs(p[0] - 20) < 1e-4 && Math.abs(p[2] - 10) < 1e-4);
        expect(onLine.length).toBeGreaterThan(0);
        for (const p of strips.flat()) expect((Math.abs(p[2] - 10) < 1e-4 && p[0] >= 19.7 - 1e-4) || (Math.abs(p[0] - 20) < 1e-4 && p[2] >= 9.7 - 1e-4)).toBe(true);
        // the strips face out like their facades
        for (const t of strips) { const n = cross(sub(t[1], t[0]), sub(t[2], t[0])); expect(n[0] + n[2]).toBeGreaterThan(0); }
        // closed along the corner: the strips cover the 0.3 m on each side over the whole height
        const area = strips.reduce((a, t) => a + Math.hypot(...cross(sub(t[1], t[0]), sub(t[2], t[0]))) / 2, 0);
        expect(area).toBeCloseTo(2 * 0.3 * 12, 3);
        expect(parseGlbBytes(j.others[0]).json.nodes.find((n: any) => n.name === 'CornerJoin').extras.sbCornerJoin.provenance.label).toBe('generated');
        // the clay gets the same strips
        expect(nodeTris(j.clay, 'CornerJoin').length).toBe(strips.length);
    });

    it('welds outline corners closer than weldM instead of drawing a strip', () => {
        const f1 = facade(1, [0.7, 10], [19.98, 10], 12, [0, 1]), f2 = facade(2, [20, 9.98], [20, 0.7], 12, [1, 0]);
        // bring the two outlines' corners within 2 cm of each other: facade 2's edge at (20, 9.98) and facade 1's at (19.98, 10)
        const bytes = glb([f1, f2]);
        const j = joinFacadeCorners(bytes, [bytes]);
        expect(j.report.welded).toBeGreaterThan(0);
        // welded corners now coincide
        const a = nodeTris(j.others[0], 'FacadeLattice_1').flat().filter(p => p[0] > 19.9), b = nodeTris(j.others[0], 'FacadeLattice_2').flat().filter(p => p[2] > 9.9);
        const ka = new Set(a.map(p => p.map(x => x.toFixed(4)).join(','))), shared = b.filter(p => ka.has(p.map(x => x.toFixed(4)).join(',')));
        expect(shared.length).toBeGreaterThan(0);
    });

    it('draws nothing where a facade overshoots the corner, or where a surface facing out already stands behind the gap', () => {
        // facade 1 runs past the corner line (to x = 20.4): it does not stop short, so it gets no strip
        const over = glb([facade(1, [0.7, 10], [20.4, 10], 12, [0, 1]), facade(2, [20, 9.7], [20, 0.7], 12, [1, 0])]);
        const jo = joinFacadeCorners(over, [over]);
        for (const t of nodeTris(jo.others[0], 'CornerJoin')) for (const p of t) expect(Math.abs(p[0] - 20) < 1e-4).toBe(true);
        // a scan wall facing out 1 m behind the gap (a chamfered corner): the gap is closed already, no strip in front of it
        // its two faces wound outward (+z and +x)
        const fix = (p: Part, out: number[]): Part => { const t = p.tris.slice(0, 3), n = cross(sub(t[1], t[0]), sub(t[2], t[0])); return dot(n, out) < 0 ? { ...p, tris: p.tris.map((_, i) => p.tris[i - (i % 3) + [0, 2, 1][i % 3]]) } : p; };
        const sc1 = fix({ name: 'scan1', tris: grid([19.7, 0, 9], [0.3, 0, 0], [0, 2, 0], 1, 6) }, [0, 0, 1]), sc2 = fix({ name: 'scan2', tris: grid([19, 0, 10], [0, 0, -0.3], [0, 2, 0], 1, 6) }, [1, 0, 0]);
        const covered = glb([facade(1, [0.7, 10], [19.7, 10], 12, [0, 1]), facade(2, [20, 9.7], [20, 0.7], 12, [1, 0]), sc1, sc2]);
        const jc = joinFacadeCorners(covered, [covered]);
        expect(nodeTris(jc.others[0], 'CornerJoin').length).toBe(0);
        expect(jc.report.coveredSegments).toBeGreaterThan(0);
    });
});

describe('scan put back', () => {
    it('puts back only removed scan triangles that lie behind a rebuilt wall', () => {
        const wall = facade(1, [0, 10], [10, 10], 10, [0, 1]);
        // removed scan: one piece 0.5 m behind the wall (z = 9.5, facing +z) and one 0.5 m in front of it (z = 10.5)
        const behind: Part = { name: 'scan', tris: quad([2, 2, 9.5], [2, 0, 0], [0, 2, 0]) }, front: Part = { name: 'scan2', tris: quad([6, 2, 10.5], [2, 0, 0], [0, 2, 0]) };
        const pre = glb([behind, front]), cur = glb([wall]);
        const r = restoreScan({ clay: cur, tex: cur }, { clay: pre, tex: pre }, [{ c: [5, 3, 10], r: 10 }], undefined);
        expect(r.triangles).toBe(2);
        const put = nodeTris(r.tex!, 'ScanRestored');
        for (const t of put) for (const p of t) expect(p[2]).toBeCloseTo(9.5, 4);
        expect(parseGlbBytes(r.tex!).json.nodes.find((n: any) => n.name === 'ScanRestored').extras.sbScanRestored.provenance.label).toBe('measured');
        // outside every region: nothing
        expect(restoreScan({ clay: cur, tex: cur }, { clay: pre, tex: pre }, [{ c: [100, 0, 0], r: 1 }], undefined).triangles).toBe(0);
    });
});

describe('floating scan pieces', () => {
    it('drops a small scan piece touching nothing, keeps one touching a wall or the ground', () => {
        const wall = facade(1, [0, 10], [10, 10], 10, [0, 1]);
        const floating: Part = { name: 'scan_a', tris: quad([3, 5, 12], [1, 0, 0], [0, 1, 0]) };
        const hanging: Part = { name: 'scan_b', tris: quad([6, 5, 10], [0, 0, 1], [0, 1, 0]) };
        const grounded: Part = { name: 'scan_c', tris: quad([3, 0, 14], [1, 0, 0], [0, 1, 0]) };
        const bytes = glb([wall, floating, hanging, grounded]);
        const s = findShards(bytes, 0);
        expect(s.pieces).toBe(1);
        expect(s.areaM2).toBeCloseTo(1, 4);
        const out = dropTriangles(bytes, s.keys);
        const area = (name: string) => nodeTris(out, name).reduce((a, t) => a + Math.hypot(...cross(sub(t[1], t[0]), sub(t[2], t[0]))) / 2, 0);
        expect(area('scan_a')).toBe(0);
        expect(area('scan_b')).toBeCloseTo(1, 4);
        expect(area('scan_c')).toBeCloseTo(1, 4);
        expect(area('FacadeLattice_1')).toBeCloseTo(100, 3);
    });

    it('drops a scan sheet sticking out of the building into the air, and keeps the building', () => {
        // a closed scan box with a 10 m x 10 m sheet hung off its +x face's top edge, sticking out sideways
        const b = box(0, 20, 0, 16, 20);
        const sheet = quad([20, 20, 3], [10, 0, 0], [0, -10, 0]);
        const bytes = glb([{ name: 'scan', tris: b }, { name: 'scan_sheet', tris: sheet }]);
        const s = findShards(bytes, 0);
        expect(s.sheets).toBe(1);
        expect(s.sheetAreaM2).toBeCloseTo(100, 3);
        const out = dropTriangles(bytes, s.keys);
        expect(nodeTris(out, 'scan_sheet').every(t => Math.hypot(...cross(sub(t[1], t[0]), sub(t[2], t[0]))) === 0)).toBe(true);
        expect(nodeTris(out, 'scan').filter(t => Math.hypot(...cross(sub(t[1], t[0]), sub(t[2], t[0]))) > 0).length).toBe(b.length / 3);
    });
});
