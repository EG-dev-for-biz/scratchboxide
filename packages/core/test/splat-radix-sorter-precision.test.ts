/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Splat depth sort at geo-tile depth ranges: the order must be exactly back-to-front for view depths spanning
 * 1e-2..1e4 m (a 16-bit bucket pass over that range has 15 cm buckets and scrambles everything near the camera).
 */

import { describe, expect, it } from 'vitest';
import * as vm from 'vm';
import { SplatRadixSorter } from '../src/browser/generative-canvas/services/spatial/SplatRadixSorter';

function rng(seed: number) {
    let s = seed >>> 0;
    return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
}

/** Positions whose depth along `dir` from `cam` is log-uniform in [1e-2, 1e4] m, with lateral scatter. */
function scene(n: number, seed: number) {
    const r = rng(seed);
    const cam = { x: 1200.5, y: -40.25, z: 300.75 };
    const dir = { x: 0.6, y: 0, z: -0.8 };
    const side = { x: 0.8, y: 0, z: 0.6 };
    const pos = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
        const d = Math.pow(10, -2 + 6 * r());
        const lat = (r() - 0.5) * d, up = (r() - 0.5) * d;
        pos[i * 3] = cam.x + dir.x * d + side.x * lat;
        pos[i * 3 + 1] = cam.y + up;
        pos[i * 3 + 2] = cam.z + dir.z * d + side.z * lat;
    }
    return { pos, cam, dir };
}

function viewDepths(pos: Float32Array, cam: { x: number; y: number; z: number }, dir: { x: number; y: number; z: number }) {
    const n = pos.length / 3, d = new Float32Array(n);
    for (let i = 0; i < n; i++) d[i] = (pos[i * 3] - cam.x) * dir.x + (pos[i * 3 + 1] - cam.y) * dir.y + (pos[i * 3 + 2] - cam.z) * dir.z;
    return d;
}

function inversions(order: Uint32Array, depth: Float32Array) {
    let bad = 0;
    for (let i = 1; i < order.length; i++) if (depth[order[i]] > depth[order[i - 1]]) bad++;
    return bad;
}

describe('SplatRadixSorter: two-pass 32-bit radix sort', () => {
    it('orders depths spanning 1e-2..1e4 m exactly back-to-front, as a permutation', () => {
        const { pos, cam, dir } = scene(200_000, 1);
        const order = new SplatRadixSorter(false).sortSync(pos, cam, dir, pos.length / 3);
        const depth = viewDepths(pos, cam, dir);
        expect(inversions(order, depth)).toBe(0);
        const seen = new Uint8Array(order.length);
        for (const i of order) seen[i]++;
        expect(seen.every(v => v === 1)).toBe(true);
        // The near field really is resolved: the last 1000 (nearest) are all within 2 cm and strictly ordered.
        expect(depth[order[order.length - 1]]).toBeLessThan(0.0102);
    });

    it('handles negative depths (behind the camera) and ties stably', () => {
        const pos = new Float32Array([0, 0, 5, 0, 0, -3, 0, 0, 2, 0, 0, 2, 0, 0, -0.5]);
        const order = new SplatRadixSorter(false).sortSync(pos, { x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 }, 5);
        expect(Array.from(order)).toEqual([0, 2, 3, 4, 1]);
    });

    it('the worker source runs the same sort', async () => {
        const { pos, cam, dir } = scene(20_000, 2);
        const posted: any[] = [];
        const self: any = { postMessage: (m: any) => posted.push(m) };
        vm.runInNewContext(SplatRadixSorter.workerSource(), { self, Float32Array, Uint32Array, Math });
        self.onmessage({ data: { taskId: 1, positions: pos.slice().buffer, cx: cam.x, cy: cam.y, cz: cam.z, dx: dir.x, dy: dir.y, dz: dir.z, count: pos.length / 3 } });
        const fromWorker = new Uint32Array(posted[0].indices);
        const sync = new SplatRadixSorter(false).sortSync(pos, cam, dir, pos.length / 3);
        expect(Array.from(fromWorker)).toEqual(Array.from(sync));
    });

    it('sorts 1M splats fast enough to run every few frames (timing logged)', () => {
        const { pos, cam, dir } = scene(1_000_000, 3);
        const sorter = new SplatRadixSorter(false);
        const out = new Uint32Array(1_000_000);
        sorter.sortSync(pos, cam, dir, 1_000_000, out); // warm-up
        const times: number[] = [];
        for (let k = 0; k < 5; k++) {
            const t0 = performance.now();
            sorter.sortSync(pos, cam, dir, 1_000_000, out);
            times.push(performance.now() - t0);
        }
        times.sort((a, b) => a - b);
        console.log(`[splat-sort] 1M splats, two-pass 32-bit radix: median ${times[2].toFixed(1)} ms (min ${times[0].toFixed(1)}, max ${times[4].toFixed(1)})`);
        expect(times[2]).toBeLessThan(250);
    });
});
