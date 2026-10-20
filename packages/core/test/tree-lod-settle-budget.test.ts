/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * TreeLodController at a still camera and under the triangle budget (docs/processes/tree_budget_tune.md), on the contract
 * fixture (levels of 18 / 13 / 10 / 4 triangles; bands near 0-60, near-mid 50-110, mid 90-200, far 170+ m):
 *  - a still camera finishes its dissolves: a tree inside a band overlap settles on its dominant level with a short timed
 *    crossfade, holds it while the camera shakes inside the dead band, and leaves it without a pop when the camera moves on;
 *  - the budget fits the destinations, most important first: a near tree held at near-mid while the budget had room for it
 *    (the in-flight cost of its promotion counted both of its levels) now reaches near, and when it needs room the least
 *    important trees give it up; no demoted tree is more important than a tree that kept a finer-than-far level;
 *  - dissolves in flight stay near the budget, and the choice does not churn at a still camera.
 */

import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { TreeLodController, formatTreeLodStats } from '../src/browser/generative-canvas/primitives/scene3d/treeLod/TreeLodController';
import { dominantLevel } from '../src/browser/generative-canvas/primitives/scene3d/treeLod/treeLodMath';
import { buildTreesLodGltf, writeTreesLodGlb } from './helpers/synthetic-trees-lod-glb';

async function loadTrees(trees: number): Promise<THREE.Object3D> {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sb-lod-settle-')), 't.glb');
    writeTreesLodGlb(file, buildTreesLodGltf({ trees, levels: 4 }));
    const buf = fs.readFileSync(file);
    return (await new GLTFLoader().parseAsync(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer, '')).scene;
}

const treeNodes = (root: THREE.Object3D): THREE.Object3D[] => { const out: THREE.Object3D[] = []; root.traverse(o => { if (o.userData?.sbTree) out.push(o); }); return out; };
const clock = (): { now: () => number; tick: (ms?: number) => void } => { let t = 1000; return { now: () => t, tick: (ms = 16.7) => { t += ms; } }; };
const METRES = { foveal: { enabled: false } };
const FRAME_MS = 16.7, FADE_S = 0.35;
const MAX_STEP = FRAME_MS / 1000 / FADE_S + 1e-9;

/** The level a tree draws whole, or -1 while it is in a dissolve. */
const wholeLevel = (lod: TreeLodController, i: number): number => lod.stateOf(i).indexOf('full');

/** Places tree nodes so their nearest sphere point is `d[i]` metres down -z from a camera at the origin, spread across the view. */
function placeTrees(root: THREE.Object3D, d: number[]): void {
    const trees = treeNodes(root);
    root.updateMatrixWorld(true);
    trees.forEach((t, i) => {
        const s = new THREE.Box3().setFromObject(t).getBoundingSphere(new THREE.Sphere());
        const local = s.center.clone().sub(t.getWorldPosition(new THREE.Vector3()));
        const ang = trees.length > 1 ? -0.5 + i / (trees.length - 1) : 0;    // within +-0.5 rad of the view axis
        const r = d[i] + s.radius;
        t.position.set(r * Math.sin(ang) - local.x, -local.y + 3, -r * Math.cos(ang) - local.z);
    });
    root.updateMatrixWorld(true);
}

function camera(): THREE.PerspectiveCamera {
    const cam = new THREE.PerspectiveCamera(45, 2.2, 0.1, 6000);           // the reference lens: distances read as metres
    cam.position.set(0, 3, 0); cam.lookAt(0, 3, -1); cam.updateMatrixWorld(true);
    return cam;
}

describe('TreeLodController: a still camera finishes its dissolves', () => {
    it('settles a tree inside a band overlap on its dominant level with a short crossfade, holds it in the dead band, and leaves it without a pop', async () => {
        const root = await loadTrees(1);
        placeTrees(root, [56]);                                     // inside the near | near-mid overlap (50-60 m), near-mid dominant
        const c = clock();
        const lod = new TreeLodController(root, { view: METRES, now: c.now, fadeSeconds: FADE_S });
        const cam = camera();
        let prev: number[] | undefined;
        const step = (cm: THREE.PerspectiveCamera) => {
            c.tick(FRAME_MS); lod.update(cm);
            const e = lod.edgesOf(0);
            if (prev) e.forEach((x, k) => expect(Math.abs(x - prev![k])).toBeLessThanOrEqual(MAX_STEP));   // never faster than the crossfade
            prev = e;
        };
        // the camera holds still: for under half a second the tree shares the hash between near and near-mid
        for (let i = 0; i < 20; i++) step(cam);
        expect(lod.stats.still).toBe(false);
        expect(wholeLevel(lod, 0)).toBe(-1);
        expect(lod.stats.fading).toBe(1);
        // past half a second it settles on near-mid (its dominant level), within a fade
        let settledAt = -1;
        for (let i = 20; i < 80; i++) { step(cam); if (settledAt < 0 && wholeLevel(lod, 0) >= 0) settledAt = i; }
        expect(lod.stats.still).toBe(true);
        expect(wholeLevel(lod, 0)).toBe(1);
        expect(lod.stats.fading).toBe(0);
        expect(lod.stats.settledTrees).toBe(1);
        expect(settledAt * FRAME_MS).toBeGreaterThanOrEqual(500);
        expect(settledAt * FRAME_MS).toBeLessThanOrEqual(500 + FADE_S * 1000 + 2 * FRAME_MS);
        expect(formatTreeLodStats([lod.stats])).toContain('still: settled 1');
        // it stays settled: no flicker over five more seconds
        let commits = 0;
        for (let i = 0; i < 300; i++) { step(cam); commits += lod.stats.commits; }
        expect(commits).toBe(0);
        // the camera shakes inside the distance dead band: it moves, but the tree keeps its settled level and nothing is redrawn
        for (let i = 0; i < 40; i++) {
            const shaken = cam.clone(); shaken.position.z += i % 2 ? 0.9 : -0.9; shaken.updateMatrixWorld(true);
            step(shaken); commits += lod.stats.commits;
            expect(lod.stats.still).toBe(false);
        }
        expect(commits).toBe(0);
        expect(wholeLevel(lod, 0)).toBe(1);
        // a slow dolly in through the overlap: the tree leaves the held level for the distance crossfade, then reaches near, never
        // jumping from one whole level straight to another between two frames
        let last = wholeLevel(lod, 0), pops = 0;
        for (let i = 0; i < 400; i++) {
            const moved = cam.clone(); moved.position.z -= Math.min(20, i * 0.05); moved.updateMatrixWorld(true);
            step(moved);
            const w = wholeLevel(lod, 0);
            if (last >= 0 && w >= 0 && w !== last) pops++;
            last = w;
        }
        expect(pops).toBe(0);
        expect(wholeLevel(lod, 0)).toBe(0);
    });

    it('re-checks a level held through a camera jump when the camera comes to rest: the dominant level wins unless near a tie', async () => {
        const root = await loadTrees(1);
        placeTrees(root, [600]);
        const c = clock();
        const lod = new TreeLodController(root, { view: METRES, now: c.now });
        const cam = camera();
        for (let i = 0; i < 60; i++) { c.tick(); lod.update(cam); }
        expect(wholeLevel(lod, 0)).toBe(3);                         // settled far
        // jump to 163 m, read at 181 m after the distance dead band (3 % of the 600 m it came from): inside the mid | far overlap
        // (170-200 m) with far at about 0.3 of the hash, mid dominant. Held far through the move (its share is above the release
        // share), then at rest the tree goes to mid.
        const near = camera(); near.position.z -= 437; near.updateMatrixWorld(true);
        c.tick(); lod.update(near);
        expect(lod.explain(0).equivalentDistM).toBeCloseTo(181, 0);
        expect(wholeLevel(lod, 0)).toBe(3);
        for (let i = 0; i < 80; i++) { c.tick(); lod.update(near); }
        expect(wholeLevel(lod, 0)).toBe(2);
        expect(lod.stats.fading).toBe(0);
    });

    it('turns off with settleAfterStillSeconds 0 (the distance crossfade stands at a still camera)', async () => {
        const root = await loadTrees(1);
        placeTrees(root, [56]);
        const c = clock();
        const lod = new TreeLodController(root, { view: METRES, now: c.now, settleAfterStillSeconds: 0 });
        for (let i = 0; i < 120; i++) { c.tick(); lod.update(camera()); }
        expect(lod.stats.still).toBe(false);
        expect(lod.stats.fading).toBe(1);
    });

    it('settles a grove of trees in overlaps: a still frame ends with no tree in a dissolve, and the total stays as the levels say', async () => {
        const d = Array.from({ length: 24 }, (_, i) => 40 + i * 7);  // 40-201 m: many inside the three overlaps
        const root = await loadTrees(d.length);
        placeTrees(root, d);
        const c = clock();
        const cont = new TreeLodController(await (async () => { const r = await loadTrees(d.length); placeTrees(r, d); return r; })(), { view: METRES, now: c.now, settleAfterStillSeconds: 0, triangleBudget: 1e9 });
        const lod = new TreeLodController(root, { view: METRES, now: c.now, triangleBudget: 1e9 });
        for (let i = 0; i < 120; i++) { c.tick(); cont.update(camera()); lod.update(camera()); }
        expect(cont.stats.fading).toBeGreaterThan(5);              // the old still frame: every overlap tree dithered
        expect(lod.stats.fading).toBe(0);
        expect(lod.stats.visibleTrees).toBe(d.length);
        // each settled tree is at one of the two levels it was sharing, the one with the larger share
        for (let i = 0; i < d.length; i++) {
            expect(wholeLevel(lod, i)).toBe(dominantLevel(cont.edgesOf(i)));
        }
    });
});

describe('TreeLodController: the budget fits destinations, most important first', () => {
    const LEVEL_TRI = [18, 13, 10, 4];

    it('lets a near tree reach the near level when the budget has room, though its dissolve draws both levels for a moment', async () => {
        const root = await loadTrees(4);
        placeTrees(root, [70, 72, 74, 76]);                         // all four wholly near-mid (13 each = 52)
        const c = clock();
        const lod = new TreeLodController(root, { view: METRES, now: c.now, fadeSeconds: FADE_S, triangleBudget: 60 });
        const cam = camera();
        for (let i = 0; i < 60; i++) { c.tick(); lod.update(cam); }
        expect(lod.stats.atLevel).toEqual([0, 4, 0, 0]);
        expect(lod.stats.estimatedTriangles).toBe(52);
        // tree 0 comes to 20 m: it wants near. There: 18 + 39 = 57 <= 60; while it dissolves it draws 18 + 13 more (70 > 60).
        // Judged by that in-flight cost, the old budget held it at near-mid for good.
        const t0 = treeNodes(root)[0];
        const dir = t0.position.clone().setY(0).normalize();
        t0.position.addScaledVector(dir, -50); root.updateMatrixWorld(true);
        let peak = 0;
        for (let i = 0; i < 90; i++) { c.tick(); lod.update(cam); peak = Math.max(peak, lod.stats.estimatedTriangles); }
        expect(lod.explain(0).rangeM).toBeLessThan(25);
        expect(wholeLevel(lod, 0)).toBe(0);
        expect(lod.stats.demotedTrees).toBe(0);
        expect(lod.stats.estimatedTriangles).toBe(57);
        expect(peak).toBeLessThanOrEqual(LEVEL_TRI[0] + LEVEL_TRI[1] + 3 * LEVEL_TRI[1]);   // the one dissolve, nothing else
    });

    it('when the near tree needs room, the least important trees give it up, and no demoted tree outranks one that kept detail', async () => {
        const root = await loadTrees(4);
        placeTrees(root, [20, 72, 80, 88]);                         // near, then three near-mid trees, less important with distance
        const c = clock();
        const lod = new TreeLodController(root, { view: METRES, now: c.now, triangleBudget: 1e9 });
        const cam = camera();
        for (let i = 0; i < 60; i++) { c.tick(); lod.update(cam, null, { reservedTriangles: 0 }); }
        expect([0, 1, 2, 3].map(i => wholeLevel(lod, i))).toEqual([0, 1, 1, 1]);
        // the scene grows: the trees may use 55 of the 57 they want; the farthest near-mid tree drops to mid (-3), the near tree keeps near
        for (let i = 0; i < 90; i++) { c.tick(); lod.update(cam, null, { reservedTriangles: 1e9 - 55 }); }
        expect(lod.stats.treeBudget).toBe(55);
        expect([0, 1, 2, 3].map(i => wholeLevel(lod, i))).toEqual([0, 1, 1, 2]);
        expect(lod.stats.estimatedTriangles).toBe(54);
        expect(lod.stats.demotedTrees).toBe(1);
        expect(lod.explain(3).budgetDemotions).toBe(1);
        // tighter (45): from there, the least important tree gives its next level (mid to far, -6 = 48), then the next one
        // (near-mid to mid, -3 = 45); the near tree keeps near
        for (let i = 0; i < 90; i++) { c.tick(); lod.update(cam, null, { reservedTriangles: 1e9 - 45 }); }
        expect([0, 1, 2, 3].map(i => wholeLevel(lod, i))).toEqual([0, 1, 2, 3]);
        expect(lod.stats.estimatedTriangles).toBe(45);
        // room again: everything comes back
        for (let i = 0; i < 90; i++) { c.tick(); lod.update(cam, null, { reservedTriangles: 0 }); }
        expect([0, 1, 2, 3].map(i => wholeLevel(lod, i))).toEqual([0, 1, 1, 1]);
        expect(lod.stats.demotedTrees).toBe(0);
    });

    it('in a grove under a tight budget: importance order holds, the destinations fit, in-flight stays near the budget, and a still camera does not churn', async () => {
        const n = 40;
        const rnd = (() => { let s = 7; return () => ((s = (s * 16807) % 2147483647) / 2147483647); })();
        const d = Array.from({ length: n }, () => 5 + rnd() * 220);
        const root = await loadTrees(n);
        placeTrees(root, d);
        const c = clock();
        const cam = camera();
        const free = new TreeLodController(await (async () => { const r = await loadTrees(n); placeTrees(r, d); return r; })(), { view: METRES, now: c.now, triangleBudget: 1e9 });
        for (let i = 0; i < 120; i++) { c.tick(); free.update(cam); }
        const want = free.stats.estimatedTriangles;
        const budget = Math.round(want * 0.6);
        const lod = new TreeLodController(root, { view: METRES, now: c.now, fadeSeconds: FADE_S, triangleBudget: budget });
        let peak = 0;
        for (let i = 0; i < 180; i++) { c.tick(); lod.update(cam); peak = Math.max(peak, lod.stats.estimatedTriangles); }
        expect(lod.stats.demotedTrees).toBeGreaterThan(0);
        expect(lod.stats.fading).toBe(0);
        expect(lod.stats.estimatedTriangles).toBeLessThanOrEqual(budget);
        expect(lod.stats.estimatedTriangles).toBeGreaterThan(budget * 0.98 - 6);   // the room left is filled (6: the largest one-level step back)
        // in flight: the budget plus the overshoot share plus the one dissolve that always starts (the near level and its neighbour)
        expect(peak).toBeLessThanOrEqual(budget * 1.1 + LEVEL_TRI[0] + LEVEL_TRI[1]);
        // importance order: a tree held down by the budget while a clearly less important one (beyond the 10 % stickiness) keeps
        // a finer-than-far level is one whose next level up fits neither in what is left of the budget nor with that tree's level
        const r = Array.from({ length: n }, (_, i) => ({ i, ...lod.explain(i) }));
        const slack = budget - lod.stats.estimatedTriangles;
        let checked = 0;
        for (const a of r.filter(t => t.budgetDemotions > 0)) {
            const back = LEVEL_TRI[a.level - 1] - LEVEL_TRI[a.level];
            expect(back, `tree ${a.i} held at level ${a.level} with ${slack} free`).toBeGreaterThan(budget * 0.98 - lod.stats.estimatedTriangles);   // room comes back within the release margin
            for (const b of r.filter(t => t.budgetDemotions === 0 && t.level < 3 && t.importance * 1.1 < a.importance)) {
                checked++;
                const gain = LEVEL_TRI[b.level] - LEVEL_TRI[b.level + 1];
                expect(back, `tree ${a.i} (importance ${a.importance.toFixed(0)}) held while ${b.i} (${b.importance.toFixed(0)}) keeps level ${b.level}`).toBeGreaterThan(budget * 0.98 - lod.stats.estimatedTriangles + gain);
            }
        }
        expect(r.some(t => t.budgetDemotions > 0)).toBe(true);
        void checked;
        // a still camera: nothing changes over the next five seconds
        let commits = 0;
        for (let i = 0; i < 300; i++) { c.tick(); lod.update(cam); commits += lod.stats.commits; }
        expect(commits).toBe(0);
    });

    it('keeps a budget at the line from churning: a reserved share jittering inside the release margin settles after one demotion and then moves no tree', async () => {
        const d = Array.from({ length: 12 }, (_, i) => 15 + i * 9);
        const root = await loadTrees(d.length);
        placeTrees(root, d);
        const c = clock();
        const cam = camera();
        const lod = new TreeLodController(root, { view: METRES, now: c.now, triangleBudget: 1e6 });
        for (let i = 0; i < 60; i++) { c.tick(); lod.update(cam); }
        const want = lod.stats.estimatedTriangles;
        const tight = 1e6 - Math.round(want * 0.75);                    // reserved: the trees may use 75 % of what they want
        for (let i = 0; i < 120; i++) { c.tick(); lod.update(cam, null, { reservedTriangles: tight }); }
        const jitter = (i: number) => tight + (i % 2 ? 1 : -1) * 0.004 * want;
        // the lower of the two budgets may take one level more (a demotion is made at once); after that nothing moves, because a
        // tree held down comes back only when the budget less its margin holds it
        for (let i = 0; i < 40; i++) { c.tick(); lod.update(cam, null, { reservedTriangles: jitter(i) }); }
        const levels = d.map((_, i) => wholeLevel(lod, i));
        expect(levels.every(l => l >= 0)).toBe(true);
        let commits = 0;
        for (let i = 0; i < 300; i++) { c.tick(); lod.update(cam, null, { reservedTriangles: jitter(i) }); commits += lod.stats.commits; }
        expect(commits).toBe(0);
        expect(d.map((_, i) => wholeLevel(lod, i))).toEqual(levels);
        expect(lod.stats.estimatedTriangles).toBeLessThanOrEqual(lod.stats.treeBudget);
    });
});
