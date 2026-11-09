/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The sparse narrow-band distance field (scratchbox_sparse_field.hpp through buildSparseField), on shapes whose
 * distances are known in closed form:
 *   1. a 2 m box: the signed distance at points in and out matches the exact distance to its faces, edges and corner;
 *   2. the same box with its top face missing (an open scan): the winding number still signs its inside;
 *   3. closing: two boxes 0.4 m apart are joined by a 0.5 m closing (the gap's middle goes inside), on the coarse and
 *      the direct grid, while a 0.1 m closing leaves the gap open; the far faces do not move;
 *   4. opening: a 0.1 m thick fin on a box goes with a 0.2 m opening, the box's own faces stay;
 *   5. the saved field carries the SBSF header and its blocks;
 *   6. bad requests are refused before anything runs.
 * With SCRATCHBOX_SPARSE_FIELD_SCAN set to a cached scan GLB (a tile extraction's welded geometry, one node without a
 * transform), a closing runs on that real scan too: the field's sign must agree with the scan's own winding number at
 * every query, and the closing may only add solid.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { buildSparseField, ensureSparseFieldBinary, SparseFieldError } from '../src/node/3d-engine/sparse-field-native';
import { readGlbNodes } from '../src/node/3d-engine/staged-location/glb-nodes';

/** An axis-aligned box, faces wound outward; `skip` names faces to leave out (e.g. '+y'). */
function box(lo: [number, number, number], hi: [number, number, number], skip: string[] = []): { positions: number[]; indices: number[] } {
    const positions: number[] = [];
    const indices: number[] = [];
    const faces: Array<{ name: string; axis: number; side: 0 | 1 }> = [
        { name: '-x', axis: 0, side: 0 }, { name: '+x', axis: 0, side: 1 },
        { name: '-y', axis: 1, side: 0 }, { name: '+y', axis: 1, side: 1 },
        { name: '-z', axis: 2, side: 0 }, { name: '+z', axis: 2, side: 1 }
    ];
    for (const f of faces) {
        if (skip.includes(f.name)) continue;
        const u = (f.axis + 1) % 3, v = (f.axis + 2) % 3;
        const base = positions.length / 3;
        for (const [a, b] of [[0, 0], [1, 0], [1, 1], [0, 1]]) {
            const p = [0, 0, 0];
            p[f.axis] = f.side ? hi[f.axis] : lo[f.axis];
            p[u] = a ? hi[u] : lo[u];
            p[v] = b ? hi[v] : lo[v];
            positions.push(...p);
        }
        // (u, v) counter-clockwise faces +axis; flip for the low side
        if (f.side) indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
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

/** Exact signed distance to the box [lo, hi]. */
function boxSdf(p: number[], lo: number[], hi: number[]): number {
    const c = [0, 1, 2].map(k => (lo[k] + hi[k]) / 2), e = [0, 1, 2].map(k => (hi[k] - lo[k]) / 2);
    const q = [0, 1, 2].map(k => Math.abs(p[k] - c[k]) - e[k]);
    const out = Math.hypot(...q.map(x => Math.max(x, 0)));
    return out + Math.min(Math.max(q[0], q[1], q[2]), 0);
}

describe('sparse narrow-band distance field', () => {
    beforeAll(async () => { await ensureSparseFieldBinary(); }, 300_000);

    it('matches the exact distance of a box in and out of it', async () => {
        const m = merge(box([-1, -1, -1], [1, 1, 1]));
        const pts = [[0.9, 0, 0], [1.1, 0, 0], [0, 0.95, 0.3], [1.05, 1.05, 0], [1.06, 1.06, 1.06], [0, 0, 0], [3, 0, 0], [-0.97, 0.2, -0.1]];
        const r = await buildSparseField({ ...m, voxelM: 0.05, bandVoxels: 3, queries: new Float32Array(pts.flat()) });
        const band = r.report.bandM;
        expect(band).toBeCloseTo(0.15, 6);
        pts.forEach((p, i) => {
            const exact = Math.max(-band, Math.min(band, boxSdf(p, [-1, -1, -1], [1, 1, 1])));
            // trilinear between exact voxel values: off by a small share of a voxel near the corner
            expect(Math.abs(r.values[i] - exact)).toBeLessThan(0.012);
        });
        expect(r.values[5]).toBeLessThan(0);   // 1 m in: past the band and its shell of tiles,
        expect(r.known[5]).toBe(0);            // so the sign is the winding number's
        expect(r.known[0]).toBe(1);
        expect(r.values[6]).toBeGreaterThan(0);
        expect(r.report.build.blocks).toBeGreaterThan(0);
        expect(r.report.activeVoxels).toBeGreaterThan(0);
    }, 120_000);

    it('signs the inside of an open box by its winding number', async () => {
        const m = merge(box([-1, -1, -1], [1, 1, 1], ['+y']));
        const r = await buildSparseField({ ...m, voxelM: 0.05, queries: new Float32Array([0, 0.5, 0, 0, -0.9, 0, 0, 1.5, 0, 0.9, 0.2, 0.9]) });
        expect(r.values[0]).toBeLessThan(0);
        expect(r.values[1]).toBeLessThan(0);
        expect(r.values[2]).toBeGreaterThan(0);
        expect(r.values[3]).toBeLessThan(0);
    }, 120_000);

    it('closes a gap narrower than twice the radius and leaves wider ones', async () => {
        const m = merge(box([-1.2, -1, -1], [-0.2, 1, 1]), box([0.2, -1, -1], [1.2, 1, 1]));
        const q = new Float32Array([0, 0, 0, 0, 0.5, 0.5, -1.3, 0, 0, 1.25, 0, 0]);
        const none = await buildSparseField({ ...m, voxelM: 0.05, queries: q });
        expect(none.values[0]).toBeGreaterThan(0);
        for (const morphVoxelM of [undefined, 0.05]) {
            const closed = await buildSparseField({ ...m, voxelM: 0.05, ops: [{ op: 'close', radiusM: 0.5, morphVoxelM }], queries: q });
            expect(closed.values[0]).toBeLessThan(0);
            expect(closed.values[1]).toBeLessThan(0);
            // the outer faces stay where they were: 0.1 m outside x = -1.2 and 0.05 m outside x = 1.2
            expect(closed.values[2]).toBeCloseTo(0.1, 1);
            expect(closed.values[3]).toBeCloseTo(0.05, 1);
            expect(closed.report.ops).toHaveLength(1);
        }
        const small = await buildSparseField({ ...m, voxelM: 0.05, ops: [{ op: 'close', radiusM: 0.1 }], queries: q });
        expect(small.values[0]).toBeGreaterThan(0);
    }, 240_000);

    it('opens away a fin thinner than twice the radius', async () => {
        const m = merge(box([-1, -1, -1], [1, 1, 1]), box([1, -0.05, -0.5], [1.6, 0.05, 0.5]));
        const q = new Float32Array([1.4, 0, 0, 0.9, 0.5, 0, 0, 0, 0]);
        const before = await buildSparseField({ ...m, voxelM: 0.025, queries: q });
        expect(before.values[0]).toBeLessThan(0);
        for (const morphVoxelM of [undefined, 0.025]) {
            const opened = await buildSparseField({ ...m, voxelM: 0.025, ops: [{ op: 'open', radiusM: 0.2, morphVoxelM }], queries: q });
            expect(opened.values[0]).toBeGreaterThan(0);
            expect(opened.values[1]).toBeCloseTo(-0.075, 1);  // the box face at x = 1 stays (0.1 m inside, clamped to the band)
            expect(opened.values[2]).toBeLessThan(0);
        }
    }, 240_000);

    it('saves the field with its header and blocks', async () => {
        const m = merge(box([-1, -1, -1], [1, 1, 1]));
        const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'sf-test-'));
        try {
            const fieldPath = path.join(dir, 'box.sbsf');
            const r = await buildSparseField({ ...m, voxelM: 0.1, fieldPath });
            const buf = await fs.promises.readFile(fieldPath);
            expect(buf.readUInt32LE(0)).toBe(0x46534253);
            expect(buf.readUInt32LE(4)).toBe(1);
            expect(buf.readDoubleLE(8)).toBeCloseTo(0.1, 9);
            expect(Number(buf.readBigUInt64LE(8 + 8 + 24 + 4))).toBe(r.report.blocks);
            expect(buf.length).toBeGreaterThan(r.report.blocks * (12 + 512 * 4));
        } finally {
            await fs.promises.rm(dir, { recursive: true, force: true });
        }
    }, 120_000);

    it('refuses bad requests before running', async () => {
        const m = merge(box([-1, -1, -1], [1, 1, 1]));
        await expect(buildSparseField({ ...m, voxelM: 0 })).rejects.toBeInstanceOf(SparseFieldError);
        await expect(buildSparseField({ ...m, voxelM: 0.1, ops: [{ op: 'close', radiusM: -1 }] })).rejects.toThrow(/positive radiusM/);
        await expect(buildSparseField({ positions: m.positions, indices: new Uint32Array([0, 1, 99]), voxelM: 0.1 })).rejects.toThrow(/past the/);
        await expect(buildSparseField({ ...m, voxelM: 0.1, bandVoxels: 1 })).rejects.toThrow(/at least 2/);
    });

    const scan = process.env.SCRATCHBOX_SPARSE_FIELD_SCAN;
    it.skipIf(!scan)('closes a real cached scan (SCRATCHBOX_SPARSE_FIELD_SCAN)', async () => {
        const node = readGlbNodes(scan!)[0];
        const positions = node.positions, indices = node.indices ?? Uint32Array.from({ length: positions.length / 3 }, (_, i) => i);
        // queries: a line of points through the scan's bounding box centre, along its widest horizontal axis
        const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
        for (let i = 0; i < positions.length; i += 3) for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], positions[i + k]); hi[k] = Math.max(hi[k], positions[i + k]); }
        const q: number[] = [];
        for (let t = 0; t <= 1; t += 0.02) q.push(lo[0] + t * (hi[0] - lo[0]), lo[1] + 0.3 * (hi[1] - lo[1]), (lo[2] + hi[2]) / 2);
        const queries = new Float32Array(q);
        const plain = await buildSparseField({ positions, indices, voxelM: 0.25, queries });
        const closed = await buildSparseField({ positions, indices, voxelM: 0.25, ops: [{ op: 'close', radiusM: 1 }], queries });
        expect(plain.report.build.inputTriangles).toBeGreaterThan(1000);
        expect(plain.report.blocks).toBeGreaterThan(100);
        let inside = 0;
        for (let i = 0; i < plain.values.length; i++) {
            if (plain.values[i] < 0) { inside++; expect(closed.values[i]).toBeLessThan(0.05); }
            expect(closed.values[i]).toBeLessThanOrEqual(plain.values[i] + 0.13);
        }
        expect(inside).toBeGreaterThan(0);
    }, 600_000);
});
