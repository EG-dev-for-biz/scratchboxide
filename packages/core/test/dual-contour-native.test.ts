/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Dual contouring (scratchbox_dual_contour.hpp through contourSparseField) on fields of shapes with known answers:
 *   1. a box at a voxel that does not divide it: a closed, oriented 2-manifold of genus 0 (one component, Euler
 *      characteristic 2), every corner reproduced to a millimetre with the mesh's normals, enclosed volume within 1%;
 *      at the crossings' mass points the corners are cut off by about half a voxel;
 *   2. two boxes meeting along one edge (the configuration a single vertex per cell makes non-manifold): still no open,
 *      non-manifold or misoriented edge;
 *   3. adaptive simplification: far fewer vertices on the flat faces, still closed and manifold, corners still sharp;
 *   4. bad requests are refused.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { buildSparseField, ensureSparseFieldBinary } from '../src/node/3d-engine/sparse-field-native';
import { contourSparseField, ensureDualContourBinary, DualContourError } from '../src/node/3d-engine/dual-contour-native';

function box(lo: number[], hi: number[]): { positions: number[]; indices: number[] } {
    const positions: number[] = [];
    const indices: number[] = [];
    for (let axis = 0; axis < 3; axis++)
        for (const side of [0, 1]) {
            const u = (axis + 1) % 3, v = (axis + 2) % 3;
            const base = positions.length / 3;
            for (const [a, b] of [[0, 0], [1, 0], [1, 1], [0, 1]]) {
                const p = [0, 0, 0];
                p[axis] = side ? hi[axis] : lo[axis];
                p[u] = a ? hi[u] : lo[u];
                p[v] = b ? hi[v] : lo[v];
                positions.push(...p);
            }
            if (side) indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
            else indices.push(base, base + 2, base + 1, base, base + 3, base + 2);
        }
    return { positions, indices };
}

function merge(...ms: Array<{ positions: number[]; indices: number[] }>) {
    const positions: number[] = [];
    const indices: number[] = [];
    for (const m of ms) {
        const o = positions.length / 3;
        positions.push(...m.positions);
        indices.push(...m.indices.map(i => i + o));
    }
    return { positions: new Float32Array(positions), indices: new Uint32Array(indices) };
}

function volume(pos: Float32Array, tri: Uint32Array): number {
    let v = 0;
    for (let t = 0; t < tri.length; t += 3) {
        const a = tri[t] * 3, b = tri[t + 1] * 3, c = tri[t + 2] * 3;
        v += (pos[a] * (pos[b + 1] * pos[c + 2] - pos[b + 2] * pos[c + 1]) - pos[a + 1] * (pos[b] * pos[c + 2] - pos[b + 2] * pos[c]) + pos[a + 2] * (pos[b] * pos[c + 1] - pos[b + 1] * pos[c])) / 6;
    }
    return v;
}

function nearestVertex(pos: Float32Array, p: number[]): number {
    let best = Infinity;
    for (let i = 0; i < pos.length; i += 3) best = Math.min(best, Math.hypot(pos[i] - p[0], pos[i + 1] - p[1], pos[i + 2] - p[2]));
    return best;
}

describe('dual contouring of a sparse field', () => {
    let dir = '';
    beforeAll(async () => {
        await ensureSparseFieldBinary();
        await ensureDualContourBinary();
        dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'dc-test-'));
    }, 900_000);

    const lo = [-0.93, -0.61, -0.47], hi = [0.87, 0.71, 0.53];
    const corners = [0, 1, 2, 3, 4, 5, 6, 7].map(c => [c & 1 ? hi[0] : lo[0], c & 2 ? hi[1] : lo[1], c & 4 ? hi[2] : lo[2]]);

    it('meshes a box as a closed genus-0 manifold with sharp corners', async () => {
        const m = merge(box(lo, hi));
        const fieldPath = path.join(dir, 'box.sbsf');
        await buildSparseField({ ...m, voxelM: 0.1, fieldPath });
        const sharp = await contourSparseField({ fieldPath, ...m });
        const a = sharp.report.audit;
        expect(a.openEdges).toBe(0);
        expect(a.nonManifoldEdges).toBe(0);
        expect(a.misorientedEdges).toBe(0);
        expect(a.components).toBe(1);
        expect(a.euler).toBe(2);
        for (const c of corners) expect(nearestVertex(sharp.positions, c)).toBeLessThan(1e-3);
        const exact = (hi[0] - lo[0]) * (hi[1] - lo[1]) * (hi[2] - lo[2]);
        expect(Math.abs(volume(sharp.positions, sharp.triangles) - exact) / exact).toBeLessThan(0.01);
        expect(sharp.report.stats.meshNormals).toBeGreaterThan(0);

        const blunt = await contourSparseField({ fieldPath, sharp: false });
        expect(blunt.report.audit.openEdges).toBe(0);
        expect(blunt.report.audit.euler).toBe(2);
        let cut = 0;
        for (const c of corners) cut += nearestVertex(blunt.positions, c);
        expect(cut / 8).toBeGreaterThan(0.02);
    }, 120_000);

    it('keeps two boxes meeting along an edge manifold', async () => {
        const m = merge(box([-1, -1, -1], [0, 0, 1]), box([0, 0, -1], [1, 1, 1]));
        const fieldPath = path.join(dir, 'edge.sbsf');
        await buildSparseField({ ...m, voxelM: 0.1, fieldPath });
        const r = await contourSparseField({ fieldPath, ...m });
        expect(r.report.audit.openEdges).toBe(0);
        expect(r.report.audit.nonManifoldEdges).toBe(0);
        expect(r.report.audit.misorientedEdges).toBe(0);
        expect(r.report.stats.multiPatchCells).toBeGreaterThan(0);
    }, 120_000);

    it('simplifies flat faces and stays a closed manifold with sharp corners', async () => {
        const m = merge(box(lo, hi));
        const fieldPath = path.join(dir, 'box2.sbsf');
        await buildSparseField({ ...m, voxelM: 0.05, fieldPath });
        const full = await contourSparseField({ fieldPath, ...m });
        const simp = await contourSparseField({ fieldPath, ...m, simplifyToleranceM: 0.002 });
        expect(simp.report.stats.clusters).toBeGreaterThan(0);
        expect(simp.report.stats.vertices).toBeLessThan(full.report.stats.vertices * 0.5);
        const a = simp.report.audit;
        expect(a.openEdges).toBe(0);
        expect(a.nonManifoldEdges).toBe(0);
        expect(a.misorientedEdges).toBe(0);
        expect(a.euler).toBe(2);
        for (const c of corners) expect(nearestVertex(simp.positions, c)).toBeLessThan(2e-3);
    }, 120_000);

    it('refuses bad requests', async () => {
        await expect(contourSparseField({ fieldPath: path.join(dir, 'missing.sbsf') })).rejects.toBeInstanceOf(DualContourError);
        const m = merge(box(lo, hi));
        const fieldPath = path.join(dir, 'box3.sbsf');
        await buildSparseField({ ...m, voxelM: 0.2, fieldPath });
        await expect(contourSparseField({ fieldPath, positions: m.positions, indices: new Uint32Array([0, 1, 999]) })).rejects.toThrow(/past the/);
        await expect(contourSparseField({ fieldPath, simplifyToleranceM: -1 })).rejects.toThrow(/negative/);
    }, 120_000);
});
