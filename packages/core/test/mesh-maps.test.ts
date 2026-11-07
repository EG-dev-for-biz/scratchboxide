/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Mesh-measured maps (mesh-maps.ts over the native scratchbox_mesh_maps.hpp) on shapes whose answers are known:
 * - a sphere of radius R reads mean curvature 1/R (the map H r = r / R) everywhere, and AO 1 (nothing occludes it);
 * - a closed box is convex: no cavity anywhere, curvature 0 mid-face and positive at its edges; a box with a step cut
 *   into it reads cavity in the step's concave corner and none on its faces or convex edges;
 * - a slab of thickness t reads t inward wherever it is measured from (thicker than the cap reads the cap), and its
 *   faces next to a wall read AO below 1 while open ones read 1.
 */

import { describe, expect, it } from 'vitest';
import { bakeMeshMaps, type MeshMapsParams } from '../src/node/3d-engine/mesh-maps';

type V3 = [number, number, number];
const TIMEOUT = 900_000;

/** A UV sphere, `rings` x `segs`, as a triangle soup, with the exact outward normal at any point. */
function sphereSoup(R: number, rings = 96, segs = 192): Float32Array {
    const out: number[] = [];
    const at = (i: number, j: number): V3 => {
        const th = (Math.PI * i) / rings, ph = (2 * Math.PI * j) / segs;
        return [R * Math.sin(th) * Math.cos(ph), R * Math.cos(th), R * Math.sin(th) * Math.sin(ph)];
    };
    for (let i = 0; i < rings; i++) for (let j = 0; j < segs; j++) {
        const a = at(i, j), b = at(i + 1, j), c = at(i + 1, j + 1), d = at(i, j + 1);
        out.push(...a, ...c, ...b, ...a, ...d, ...c);
    }
    return Float32Array.from(out);
}

/** An axis-aligned box from lo to hi, each face split into n x n quads, outward wound. */
function boxSoup(lo: V3, hi: V3, n = 8): number[] {
    const out: number[] = [];
    for (let axis = 0; axis < 3; axis++) for (const side of [0, 1]) {
        const u = (axis + 1) % 3, v = (axis + 2) % 3;
        const pt = (a: number, b: number): V3 => {
            const p: V3 = [0, 0, 0];
            p[axis] = side ? hi[axis] : lo[axis];
            p[u] = lo[u] + (hi[u] - lo[u]) * a;
            p[v] = lo[v] + (hi[v] - lo[v]) * b;
            return p;
        };
        for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
            const a = pt(i / n, j / n), b = pt((i + 1) / n, j / n), c = pt((i + 1) / n, (j + 1) / n), d = pt(i / n, (j + 1) / n);
            // u x v points along +axis: keep it for the hi side, flip for the lo side
            if (side) out.push(...a, ...b, ...c, ...a, ...c, ...d); else out.push(...a, ...c, ...b, ...a, ...d, ...c);
        }
    }
    return out;
}

/** An axis-aligned quad at height y (normal +y), x and z from lo to hi, split n x n. */
function floorSoup(y: number, lo: [number, number], hi: [number, number], n = 8, up = true): number[] {
    const out: number[] = [];
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
        const x0 = lo[0] + ((hi[0] - lo[0]) * i) / n, x1 = lo[0] + ((hi[0] - lo[0]) * (i + 1)) / n;
        const z0 = lo[1] + ((hi[1] - lo[1]) * j) / n, z1 = lo[1] + ((hi[1] - lo[1]) * (j + 1)) / n;
        const a: V3 = [x0, y, z0], b: V3 = [x1, y, z0], c: V3 = [x1, y, z1], d: V3 = [x0, y, z1];
        if (up) out.push(...a, ...c, ...b, ...a, ...d, ...c); else out.push(...a, ...b, ...c, ...a, ...c, ...d);
    }
    return out;
}

const PARAMS: MeshMapsParams = { curvatureRadiusM: 0.05, cavityRadiusM: 0.03, aoRadiusM: 0.2, thicknessMaxM: 0.5, samplesPerDisk: 96 };
const pts = (list: Array<[V3, V3]>) => Float32Array.from(list.flatMap(([p, n]) => [...p, ...n]));
const read = (maps: Float32Array, i: number) => ({ curvature: maps[i * 4], cavity: maps[i * 4 + 1], thicknessM: maps[i * 4 + 2], ao: maps[i * 4 + 3] });

describe('mesh maps: curvature', () => {
    it('reads a sphere of radius R as mean curvature 1/R everywhere, and leaves it unoccluded', async () => {
        const R = 0.25;
        const soup = sphereSoup(R);
        const dirs: V3[] = [[1, 0, 0], [0, 1, 0], [0, 0, -1], [0.6, 0.48, 0.64], [-0.36, -0.8, 0.48], [0.8, -0.6, 0]];
        const r = await bakeMeshMaps({ soup, points: pts(dirs.map(d => [[d[0] * R, d[1] * R, d[2] * R], d])), params: PARAMS });
        for (let i = 0; i < dirs.length; i++) {
            const m = read(r.maps, i);
            expect(m.curvature / r.curvatureRadiusM).toBeCloseTo(1 / R, -0.3);          // within about 1/R +- 1
            expect(Math.abs(m.curvature - r.curvatureRadiusM / R)).toBeLessThan(0.04);  // H r = r / R = 0.2
            expect(m.cavity).toBe(0);
            expect(m.ao).toBeGreaterThan(0.999);
        }
        // a smaller sphere reads more curved by the ratio of the radii
        const small = await bakeMeshMaps({ soup: sphereSoup(R / 2), points: pts([[[R / 2, 0, 0], [1, 0, 0]]]), params: PARAMS });
        expect(read(small.maps, 0).curvature / read(r.maps, 0).curvature).toBeGreaterThan(1.8);
        expect(read(small.maps, 0).curvature / read(r.maps, 0).curvature).toBeLessThan(2.2);
    }, TIMEOUT);
});

describe('mesh maps: cavity', () => {
    it('finds no cavity on a closed box, flat mid-face and convex at its edges', async () => {
        const soup = Float32Array.from(boxSoup([-0.5, 0, -0.5], [0.5, 1, 0.5]));
        const q: Array<[V3, V3]> = [
            [[0, 1, 0], [0, 1, 0]],                 // mid top
            [[0.5, 0.5, 0], [1, 0, 0]],             // mid side
            [[0, 1, 0.49], [0, 1, 0]],              // top, 1 cm from an edge
            [[0.49, 1, 0.49], [0, 1, 0]],           // top, by a corner
            [[0.5, 0.98, 0.1], [1, 0, 0]]           // side, 2 cm below the top edge
        ];
        const r = await bakeMeshMaps({ soup, points: pts(q), params: PARAMS });
        for (let i = 0; i < q.length; i++) expect(read(r.maps, i).cavity).toBe(0);
        expect(Math.abs(read(r.maps, 0).curvature)).toBeLessThan(0.01);
        expect(Math.abs(read(r.maps, 1).curvature)).toBeLessThan(0.01);
        for (const i of [2, 3, 4]) expect(read(r.maps, i).curvature).toBeGreaterThan(0.3);
    }, TIMEOUT);

    it('reads cavity in the concave corner of a step and nowhere else', async () => {
        // a lower block (x -0.5..0.5, y 0..0.5) and an upper one standing on its back half (x -0.5..0, y 0.5..1): the
        // tread at y 0.5, x 0..0.5 meets the riser at x 0 in a concave corner
        // (the two blocks' shared face at y 0.5, x < 0, is inside the solid and left out)
        const inside = (t: number[]) => t.every((v, k) => (k % 3 === 1 ? Math.abs(v - 0.5) < 1e-9 : k % 3 === 0 ? v <= 1e-9 : true));
        const tris = (s: number[]) => Array.from({ length: s.length / 9 }, (_, k) => s.slice(k * 9, k * 9 + 9));
        const soup = Float32Array.from([...tris(boxSoup([-0.5, 0, -0.5], [0.5, 0.5, 0.5], 16)), ...tris(boxSoup([-0.5, 0.5, -0.5], [0, 1, 0.5], 16))].filter(t => !inside(t)).flat());
        const q: Array<[V3, V3]> = [
            [[0.01, 0.5, 0], [0, 1, 0]],            // tread, 1 cm from the riser
            [[0, 0.51, 0], [1, 0, 0]],              // riser, 1 cm above the tread
            [[0.3, 0.5, 0], [0, 1, 0]],             // mid tread
            [[0.49, 0.5, 0], [0, 1, 0]],            // tread at its convex nose
            [[-0.25, 1, 0], [0, 1, 0]]              // top
        ];
        const r = await bakeMeshMaps({ soup, points: pts(q), params: PARAMS });
        expect(read(r.maps, 0).cavity).toBeGreaterThan(0.5);
        expect(read(r.maps, 1).cavity).toBeGreaterThan(0.5);
        expect(read(r.maps, 0).curvature).toBeLessThan(-0.3);
        for (const i of [2, 3, 4]) expect(read(r.maps, i).cavity).toBe(0);
        // the corner is occluded, the open top is not
        expect(read(r.maps, 0).ao).toBeLessThan(0.8);
        expect(read(r.maps, 4).ao).toBeGreaterThan(0.999);
    }, TIMEOUT);
});

describe('mesh maps: thickness and AO', () => {
    it('reads a slab of thickness t as t from either face, and a thick block as the cap', async () => {
        for (const t of [0.01, 0.04, 0.12]) {
            const soup = Float32Array.from(boxSoup([-0.5, 0, -0.5], [0.5, t, 0.5]));
            const q: Array<[V3, V3]> = [[[0, t, 0], [0, 1, 0]], [[0.2, 0, -0.3], [0, -1, 0]], [[0.4, t, 0.4], [0, 1, 0]]];
            const r = await bakeMeshMaps({ soup, points: pts(q), params: PARAMS });
            for (let i = 0; i < q.length; i++) expect(read(r.maps, i).thicknessM).toBeCloseTo(t, 3);
        }
        const block = await bakeMeshMaps({ soup: Float32Array.from(boxSoup([-0.5, 0, -0.5], [0.5, 1, 0.5])), points: pts([[[0, 1, 0], [0, 1, 0]]]), params: PARAMS });
        expect(read(block.maps, 0).thicknessM).toBeCloseTo(PARAMS.thicknessMaxM, 5);
    }, TIMEOUT);

    it('darkens AO beside a wall and not in the open', async () => {
        const soup = Float32Array.from([...floorSoup(0, [-1, -1], [1, 1]), ...boxSoup([0.2, 0, -1], [0.3, 1, 1])]);
        const q: Array<[V3, V3]> = [[[0.18, 0, 0], [0, 1, 0]], [[0.1, 0, 0], [0, 1, 0]], [[-0.6, 0, 0], [0, 1, 0]]];
        const r = await bakeMeshMaps({ soup, points: pts(q), params: PARAMS });
        expect(read(r.maps, 0).ao).toBeLessThan(read(r.maps, 1).ao);
        expect(read(r.maps, 1).ao).toBeLessThan(0.99);
        expect(read(r.maps, 2).ao).toBeGreaterThan(0.999);
    }, TIMEOUT);

    it('reads curvature per group: a part is not curved by another part touching it', async () => {
        // a plate with a cube standing on it: read as one surface the plate bends up into the cube (concave); read per
        // part the plate stays flat (cavity, which reads every surface, still finds the crease)
        const plate = floorSoup(0, [-0.5, -0.5], [0.5, 0.5]), cube = boxSoup([-0.1, 0, -0.1], [0.1, 0.2, 0.1]);
        const soup = Float32Array.from([...plate, ...cube]);
        const groups = Uint32Array.from([...new Array(plate.length / 9).fill(0), ...new Array(cube.length / 9).fill(1)]);
        const q = pts([[[0.11, 0, 0], [0, 1, 0]]]);
        const one = await bakeMeshMaps({ soup, points: q, params: PARAMS });
        const parts = await bakeMeshMaps({ soup, grouped: { soup, groups }, points: q, pointGroups: Uint32Array.of(0), params: PARAMS });
        expect(read(one.maps, 0).curvature).toBeLessThan(-0.2);
        expect(Math.abs(read(parts.maps, 0).curvature)).toBeLessThan(0.02);
        expect(read(parts.maps, 0).cavity).toBeGreaterThan(0.3);
    }, TIMEOUT);
});
