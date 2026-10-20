/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/


/**
 * The tree level of detail in a real WebGL viewport (headless Chrome, the real controller and clay pass, 1,000 trees from
 * the contract's fixture builder at ~90k / ~11k / ~1.5k triangles per tree for levels 0 / 1 / 2): frame times and drawn
 * triangles for overview, mid and eye-level cameras, and screenshots of the three levels and of the two handovers.
 * Screenshots and the report go to test-results/ (git-ignored). Skipped when Chrome is not installed.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { chromeAvailable, openHarness, type Harness } from './tree-lod-harness/runHarness';
import { DEFAULT_TREE_TRIANGLE_BUDGET } from '../src/common/spatial/tree-lod-math';

/** What a frame may draw: the default budget, plus the dissolves in flight (both levels of a dissolving tree) over it. */
const DRAWN_MAX = DEFAULT_TREE_TRIANGLE_BUDGET * 1.25;

const OUT = path.resolve(__dirname, '../../../test-results');
const SHOTS = path.join(OUT, 'screenshots');
const run = chromeAvailable();

interface Perf { camera: string; frames: number; frameMs: { median: number; p95: number; max: number }; updateMs: { median: number; max: number };
    drawnTriangles: { median: number; p95: number; max: number }; drawCalls: { median: number; max: number }; estimatedTriangles: { median: number; max: number };
    atMidpoint: { level0: number; level1: number; level2: number; fading: number; visibleTrees: number; culledTrees: number; demotedTrees: number }; trees: number }
interface Shot { nonBackground: number; meanLuma: number; hash: number[]; triangles: number; calls: number; stats: { atLevel: number[]; fading: number } }
const diff = (a: number[], b: number[]): number => a.reduce((s, v, i) => s + Math.abs(v - b[i]), 0) / a.length;

describe.skipIf(!run)('tree LOD in the viewport (1,000 trees)', () => {
    let h: Harness;
    const report: Record<string, unknown> = {};
    beforeAll(async () => {
        fs.mkdirSync(SHOTS, { recursive: true });
        const o = await openHarness({ trees: 1000 });
        h = o.h;
        report.initMs = o.init.ms; report.trees = o.init.trees;
    }, 180_000);
    afterAll(() => {
        h?.close();
        if (Object.keys(report).length) fs.writeFileSync(path.join(OUT, 'tree-lod-perf.json'), JSON.stringify(report, null, 2));
    });

    for (const cam of ['overview', 'mid', 'eye'] as const) {
        it(`${cam} camera: within the triangle target and smooth`, async () => {
            const r = await h.eval<Perf>(`window.H.perf('${cam}', 240)`);
            report[cam] = r;
            expect(r.trees).toBe(1000);
            expect(r.drawnTriangles.max).toBeLessThanOrEqual(DRAWN_MAX);           // the budget, and the dissolves in flight
            expect(r.drawnTriangles.median).toBeGreaterThan(100_000);              // something was drawn
            expect(r.frameMs.median).toBeLessThan(33); expect(r.frameMs.p95).toBeLessThan(50); expect(r.frameMs.max).toBeLessThan(250);
            expect(r.updateMs.median).toBeLessThan(2);                              // the per-frame JS of the controller itself
            expect(r.estimatedTriangles.median / r.drawnTriangles.median).toBeGreaterThan(0.85);   // the controller's estimate tracks what the GPU is given
            expect(r.estimatedTriangles.median / r.drawnTriangles.median).toBeLessThan(1.2);
            if (cam !== 'overview') expect(r.atMidpoint.culledTrees).toBeGreaterThan(0);   // trees behind the camera cost nothing
            if (cam === 'overview') expect(r.atMidpoint.level2).toBeGreaterThan(500);
            else expect(r.atMidpoint.level0 + r.atMidpoint.level1 + r.atMidpoint.fading).toBeGreaterThan(0);
        }, 240_000);
    }

    it('a dense grove at eye level stays inside the budget by stretching distances (and shows what everything at level 0 would cost)', async () => {
        const dense = await openHarness({ trees: 1000, areaM: 260 });
        try {
            const r = await dense.h.eval<Perf>(`window.H.perf('eye', 240)`);
            report.denseEye = r;
            expect(r.estimatedTriangles.median).toBeLessThanOrEqual(DEFAULT_TREE_TRIANGLE_BUDGET * 1.1);   // the destinations fit; dissolves in flight may add up to 10 %
            expect(r.drawnTriangles.max).toBeLessThanOrEqual(DRAWN_MAX);
            expect(r.frameMs.p95).toBeLessThan(60);
            const all0 = await dense.h.eval<Perf>(`window.H.perf('eye', 4, 0)`);
            report.denseEyeAllLevel0 = all0;
            expect(all0.drawnTriangles.median).toBeGreaterThan(5 * r.drawnTriangles.median);   // what the levels save
            await dense.h.screenshot(path.join(SHOTS, 'tree-lod_dense_grove_eye.png'));
        } finally { dense.h.close(); }
    }, 300_000);

    it('renders the three levels of the same tree and the two handovers, none blank, each different', async () => {
        const args = (level: number | null, d: number) => `window.H.shot({level:${level},distM:${d},lift:9,fov:40})`;
        const L: Shot[] = [];
        for (const k of [0, 1, 2]) {
            L.push(await h.eval<Shot>(args(k, 28)));
            await h.screenshot(path.join(SHOTS, `tree-lod_level${k}.png`));
        }
        for (const s of L) { expect(s.nonBackground).toBeGreaterThan(0.05); expect(s.meanLuma).toBeGreaterThan(40); expect(s.meanLuma).toBeLessThan(250); }
        expect(L[0].triangles).toBeGreaterThan(L[1].triangles * 4); expect(L[1].triangles).toBeGreaterThan(L[2].triangles * 3);
        expect(diff(L[0].hash, L[1].hash)).toBeGreaterThan(0.2); expect(diff(L[1].hash, L[2].hash)).toBeGreaterThan(0.2);
        report.levelShots = L.map(s => ({ triangles: s.triangles, nonBackground: s.nonBackground }));

        // a close eye-level look at level 0 and 1 leaves
        const close0 = await h.eval<Shot>(`window.H.shot({level:0,distM:3,lift:3,fov:55})`);
        await h.screenshot(path.join(SHOTS, 'tree-lod_level0_leaves_close.png'));
        expect(close0.nonBackground).toBeGreaterThan(0.05);

        // handovers: the camera does not move; only the shares change (everything at one level, then distance decides)
        for (const [name, d, a, b] of [['0to1', 55, 0, 1], ['1to2', 185, 1, 2]] as const) {
            const A = await h.eval<Shot>(args(a, d)); await h.screenshot(path.join(SHOTS, `tree-lod_handover_${name}_a.png`));
            const B = await h.eval<Shot>(args(b, d)); await h.screenshot(path.join(SHOTS, `tree-lod_handover_${name}_b.png`));
            const M = await h.eval<Shot>(`window.H.transitionShot(${d},9,40)`); await h.screenshot(path.join(SHOTS, `tree-lod_handover_${name}_mix.png`));
            expect(M.nonBackground).toBeGreaterThan(0.02);
            expect(M.stats.fading).toBeGreaterThan(0);                                       // the hero is in a crossfade
            expect(diff(M.hash, A.hash)).toBeGreaterThan(0); expect(diff(M.hash, B.hash)).toBeGreaterThan(0);
            report[`handover${name}`] = { a: A.triangles, b: B.triangles, mix: M.triangles };
        }
    }, 300_000);
});
