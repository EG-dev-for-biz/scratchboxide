/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The tree budget adapted to the GPU (adaptiveTreeBudget.ts): sustained slow frames lower the budget's scale step by step,
 * sustained fast ones raise it back slowly, a frame time between the two thresholds moves nothing, and a short spike does
 * nothing. The frame timer reads one query per frame and drops disjoint results. TreeLodController fits the trees to the
 * scaled budget (TreeLodFrame.budgetScale) and says so in the overlay.
 */

import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { AdaptiveTreeBudget, DEFAULT_ADAPTIVE_TREE_BUDGET, GpuFrameTimer } from '../src/browser/generative-canvas/primitives/scene3d/treeLod/adaptiveTreeBudget';
import { TreeLodController, formatTreeLodStats } from '../src/browser/generative-canvas/primitives/scene3d/treeLod/TreeLodController';
import { buildTreesLodGltf, writeTreesLodGlb } from './helpers/synthetic-trees-lod-glb';

/** Feeds `ms` once a frame (16.7 ms apart) for `seconds`, from `t0`; returns the time after. */
function feed(a: AdaptiveTreeBudget, ms: number | ((i: number) => number), seconds: number, t0: number): number {
    const frames = Math.round((seconds * 1000) / 16.7);
    let t = t0;
    for (let i = 0; i < frames; i++) { t += 16.7; a.sample(typeof ms === 'number' ? ms : ms(i), t); }
    return t;
}

describe('AdaptiveTreeBudget', () => {
    it('lowers the scale while frames stay over the target, one step a second, down to its floor', () => {
        const a = new AdaptiveTreeBudget();
        let t = feed(a, 12, 5, 0);
        expect(a.scale).toBe(1);                                         // under the target: nothing to do
        t = feed(a, 20, 0.6, t);
        expect(a.scale).toBe(1);                                         // the average has not been over for a second yet
        t = feed(a, 20, 1.2, t);
        expect(a.scale).toBeCloseTo(DEFAULT_ADAPTIVE_TREE_BUDGET.downFactor, 6);
        t = feed(a, 20, 3, t);
        expect(a.scale).toBeLessThan(DEFAULT_ADAPTIVE_TREE_BUDGET.downFactor ** 3 + 1e-9);
        feed(a, 40, 60, t);
        expect(a.scale).toBe(DEFAULT_ADAPTIVE_TREE_BUDGET.minScale);
        expect(a.smoothedMs).toBeGreaterThan(30);
    });

    it('raises a lowered scale slowly once frames are fast, never above 1, and holds it between the thresholds', () => {
        const a = new AdaptiveTreeBudget();
        let t = feed(a, 20, 3.5, 0);
        const low = a.scale;
        expect(low).toBeLessThan(1);
        t = feed(a, 12, 20, t);                                          // between raiseBelowMs (10) and the target (14): holds
        expect(a.scale).toBe(low);
        t = feed(a, 6, 4.5, t);                                          // fast: one step after upAfterMs
        expect(a.scale).toBeCloseTo(low * DEFAULT_ADAPTIVE_TREE_BUDGET.upFactor, 6);
        feed(a, 6, 120, t);
        expect(a.scale).toBe(1);
    });

    it('ignores a short spike and bad samples', () => {
        const a = new AdaptiveTreeBudget();
        let t = feed(a, 8, 2, 0);
        t = feed(a, i => (i < 10 ? 60 : 8), 3, t);                        // a 10-frame hitch: the average dips back under within the second
        expect(a.scale).toBe(1);
        a.sample(Number.NaN, t + 1); a.sample(-3, t + 2); a.sample(Infinity, t + 3);
        expect(a.scale).toBe(1);
    });
});

describe('GpuFrameTimer', () => {
    /** A WebGL2 stand-in with a timer extension: query results arrive `lag` polls after they end. */
    function fakeGl(lag: number, ns: number[], disjointAt: number[] = []) {
        let next = 0, polls = 0;
        const queries = new Map<object, { endedAtPoll: number; ns: number }>();
        const ext = { TIME_ELAPSED_EXT: 0x88bf, GPU_DISJOINT_EXT: 0x8fbb };
        let active: object | null = null, deleted = 0;
        const gl = {
            QUERY_RESULT_AVAILABLE: 0x8867, QUERY_RESULT: 0x8866,
            getExtension: (n: string) => (n === 'EXT_disjoint_timer_query_webgl2' ? ext : null),
            createQuery: () => ({}),
            beginQuery: (_t: number, q: object) => { expect(active).toBeNull(); active = q; },
            endQuery: () => { queries.set(active!, { endedAtPoll: polls, ns: ns[next++] ?? 1e6 }); active = null; },
            getParameter: (p: number) => (p === ext.GPU_DISJOINT_EXT ? disjointAt.includes(polls) : 0),
            getQueryParameter: (q: object, p: number) => { const r = queries.get(q)!; return p === gl.QUERY_RESULT_AVAILABLE ? polls - r.endedAtPoll >= lag : r.ns; },
            deleteQuery: (q: object) => { queries.delete(q); deleted++; }
        };
        return { gl: gl as unknown as WebGL2RenderingContext, tickPoll: () => { polls++; }, deleted: () => deleted };
    }

    it('times frames one query each, reads them back in order a few frames later, and drops disjoint ones', () => {
        const f = fakeGl(2, [5e6, 6e6, 7e6, 8e6, 9e6, 9e6, 9e6, 9e6], [3]);
        const timer = new GpuFrameTimer(f.gl);
        expect(timer.available).toBe(true);
        const got: number[] = [];
        for (let i = 0; i < 8; i++) { timer.begin(); timer.end(); got.push(...timer.poll()); f.tickPoll(); }
        // results 2 polls late; the poll where the GPU reported a disjoint period drops what it read
        expect(got.length).toBeGreaterThanOrEqual(3);
        expect(got.every(ms => ms >= 5 && ms <= 9)).toBe(true);
        expect([...got].sort((a, b) => a - b)).toEqual(got);
        timer.dispose();
    });

    it('keeps at most maxPending queries in flight, and does nothing without the extension', () => {
        const f = fakeGl(1000, []);
        const timer = new GpuFrameTimer(f.gl, 3);
        for (let i = 0; i < 10; i++) { timer.begin(); timer.end(); timer.poll(); }
        timer.dispose();
        expect(f.deleted()).toBe(3);
        const none = new GpuFrameTimer({ getExtension: () => null } as unknown as WebGL2RenderingContext);
        expect(none.available).toBe(false);
        none.begin(); none.end();
        expect(none.poll()).toEqual([]);
    });
});

describe('TreeLodController under a scaled budget', () => {
    it('fits the trees to the scaled budget and names the scale in the overlay', async () => {
        const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sb-lod-adapt-')), 't.glb');
        writeTreesLodGlb(file, buildTreesLodGltf({ trees: 6, levels: 4 }));
        const buf = fs.readFileSync(file);
        const root = (await new GLTFLoader().parseAsync(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer, '')).scene;
        const cam = new THREE.PerspectiveCamera(45, 2, 0.1, 6000);
        cam.position.set(25, 3, 30); cam.lookAt(25, 3, 0); cam.updateMatrixWorld(true);
        let t = 1000;
        const free = new TreeLodController(root, { view: { foveal: { enabled: false } }, now: () => t, triangleBudget: 1e6 });
        for (let i = 0; i < 60; i++) { t += 16.7; free.update(cam); }
        const want = free.stats.estimatedTriangles;
        const lod = free;
        // the configured budget holds what the trees want (with the 2 % dead band to spare); scaled by 0.5 they give up levels to fit half of it
        const budget = Math.ceil(want / 0.97);
        lod.setView({ foveal: { enabled: false }, triangleBudget: budget });
        for (let i = 0; i < 90; i++) { t += 16.7; lod.update(cam, null, { budgetScale: 0.5 }); }
        expect(lod.stats.budgetScale).toBe(0.5);
        expect(lod.stats.triangleBudget).toBe(budget * 0.5);
        expect(lod.stats.demotedTrees).toBeGreaterThan(0);
        expect(lod.stats.estimatedTriangles).toBeLessThanOrEqual(budget * 0.5);
        expect(formatTreeLodStats([lod.stats])).toContain('(GPU-adapted x0.50)');
        // back to 1: the levels come back
        for (let i = 0; i < 90; i++) { t += 16.7; lod.update(cam, null, { budgetScale: 1 }); }
        expect(lod.stats.demotedTrees).toBe(0);
        expect(lod.stats.estimatedTriangles).toBe(want);
    });
});
