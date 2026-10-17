/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Viewport pacing of the first reveals (fake clock): each of the first PACED_REVEAL_COUNT reveals stays on screen for at
 * least the dwell, one after another; once the run has finished the queue flushes within the flush budget; Stop and
 * reduced motion skip pacing; slow stages are unaffected; and pacing never makes a stage look done before it committed.
 */

import { describe, expect, test } from 'vitest';
import type { StagedBuildState, StagedLayer } from '../src/common/spatial/staged-location-contracts';
import {
    PACED_FLUSH_BUDGET_MS, PACED_REVEAL_COUNT, PACED_REVEAL_DWELL_MS, stepRevealSchedule,
    type LayerLoadState, type RevealInput, type RevealSchedule
} from '../src/browser/generative-canvas/primitives/scene3d/stagedBuild/revealScheduler';
import { fixtureLayer, fixtureState, objectIdOf, type FixtureLayerId } from './helpers/staged-glb-fixture';

const COUNTS = Object.fromEntries((['l1', 'l2', 'l3a', 'l3b', 'l4', 'l5', 'l5x'] as const).map(l => [l, { vertices: 1000, triangles: 1800, nodes: 3 }])) as Record<FixtureLayerId, { vertices: number; triangles: number; nodes: number }>;
const fast = (l: FixtureLayerId, extra: Partial<StagedLayer> = {}) => fixtureLayer(l, COUNTS, '/models', { revealAfter: [], reveal: { durationMs: 300, stagger: 0, crossfadeFrom: [] }, ...extra });
const IDS: FixtureLayerId[] = ['l1', 'l2', 'l3a', 'l3b', 'l4'];

class Clock {
    schedule: RevealSchedule | undefined;
    loads: Record<string, LayerLoadState> = {};
    constructor(public state: StagedBuildState, public now = 0, public opts: Partial<RevealInput> = {}) {}
    load(...ids: FixtureLayerId[]) { for (const id of ids) this.loads[objectIdOf(id)] = { ready: true, readyAtMs: this.now }; return this; }
    step(dtMs = 0) {
        this.now += dtMs;
        const r = stepRevealSchedule(this.schedule, { state: this.state, loads: this.loads, nowMs: this.now, reducedMotion: false, settled: false, replayEpoch: 0, pace: true, ...this.opts });
        this.schedule = r.schedule;
        return r.frame;
    }
    start(id: FixtureLayerId) { return this.schedule!.layers[objectIdOf(id)]; }
}
const layers = () => IDS.map(l => fast(l));

/** Steps in 50 ms frames until `endMs`; returns when each layer was first seen revealing and last seen revealing. */
function run(c: Clock, endMs: number) {
    const seen: Record<string, { from: number; to: number }> = {};
    while (c.now < endMs) {
        const f = c.step(50);
        for (const l of f.layers) if (l.phase === 'revealing') seen[l.objectId] = { from: seen[l.objectId]?.from ?? c.now, to: c.now };
    }
    return seen;
}

describe('paced early reveals', () => {
    test('each of the first reveals plays for at least the dwell, in order, none overlapping', () => {
        const c = new Clock(fixtureState(layers())).load(...IDS);
        const seen = run(c, 20_000);
        const spans = IDS.map(l => seen[objectIdOf(l)]);
        for (const s of spans) expect(s).toBeDefined();
        for (let i = 0; i < spans.length; i++) {
            expect(spans[i].to - spans[i].from, `reveal ${i}`).toBeGreaterThanOrEqual(PACED_REVEAL_DWELL_MS - 100);
            if (i > 0) expect(spans[i].from, `reveal ${i} starts after ${i - 1}`).toBeGreaterThanOrEqual(spans[i - 1].to);
        }
        expect(PACED_REVEAL_COUNT).toBeGreaterThanOrEqual(5);
    });

    test('reveals after the first N are not paced', () => {
        const extra = [...IDS, 'l5'] as FixtureLayerId[];
        const c = new Clock(fixtureState(extra.map(l => fast(l)))).load(...extra);
        for (let i = 0; i < 400; i++) c.step(50);
        const trees = c.start('l5');
        expect(Object.keys(c.schedule!.layers).length).toBe(6);
        expect(c.schedule!.layers[objectIdOf('l5')].paced).toBeUndefined();
        expect(trees.durationMs).toBe(300);
    });

    test('a stage that is slow anyway keeps its own duration', () => {
        const slow = fast('l1', { reveal: { durationMs: 6000, stagger: 0, crossfadeFrom: [] } });
        const c = new Clock(fixtureState([slow])).load('l1');
        c.step();
        expect(c.start('l1').durationMs).toBe(6000);
    });

    test('once the run has finished, everything still queued plays within the flush budget', () => {
        const c = new Clock(fixtureState(layers(), { runState: 'running' })).load(...IDS);
        c.step(); c.step(100);                    // the first reveal is under way, four are queued
        c.state = { ...c.state, runState: 'finished' };
        const doneAt = c.now;
        let lastEnd = doneAt;
        for (let i = 0; i < 400; i++) {
            const f = c.step(25);
            if (f.layers.some(l => l.phase === 'revealing')) lastEnd = c.now;
            if (!f.animating && !f.pending) break;
        }
        expect(lastEnd - doneAt).toBeLessThanOrEqual(PACED_FLUSH_BUDGET_MS + 150);
        const f = c.step(25);
        expect(f.layers.every(l => l.phase === 'revealed')).toBe(true);
    });

    test('Stop skips pacing at once', () => {
        const c = new Clock(fixtureState(layers(), { runState: 'stopped' }), 0, { settled: true }).load(...IDS);
        const f = c.step();
        expect(f.layers.every(l => l.phase === 'revealed')).toBe(true);
        expect(f.animating).toBe(false);
    });

    test('Stop during a paced reveal ends the queue at once', () => {
        const c = new Clock(fixtureState(layers())).load(...IDS);
        c.step(); c.step(500);
        c.state = { ...c.state, runState: 'stopped' };
        c.opts = { settled: true };
        const f = c.step(16);
        expect(f.layers.every(l => l.phase === 'revealed')).toBe(true);
    });

    test('reduced motion disables pacing', () => {
        const c = new Clock(fixtureState(layers()), 0, { reducedMotion: true }).load(...IDS);
        const f = c.step();
        expect(f.layers.every(l => l.phase === 'revealed')).toBe(true);
        expect(Object.values(c.schedule!.layers).every(t => !t.paced)).toBe(true);
    });

    test('pacing never shows an uncommitted stage as done, and queued layers are reported as pending', () => {
        // l2 is not committed (no layer yet): only l1 reveals; the frame has no entry for l2.
        const c = new Clock(fixtureState([fast('l1')], { running: ['remesh'] })).load('l1');
        let f = c.step(); f = c.step(PACED_REVEAL_DWELL_MS + 100);
        expect(f.layers.map(l => l.objectId)).toEqual([objectIdOf('l1')]);
        const stage2 = c.state.stages.find(s => s.stage === 'remesh')!;
        expect(stage2.status).toBe('running');
        // Committed but waiting its turn: queued, so the viewport still reads it as pending, and its stage status is untouched.
        const c2 = new Clock(fixtureState(layers())).load(...IDS);
        f = c2.step(); f = c2.step(200);
        expect(f.layers.find(l => l.objectId === objectIdOf('l2'))!.phase).toBe('queued');
        expect(f.pending).toBe(true);
        expect(c2.state.stages.filter(s => s.layerIds.length > 0).every(s => s.status === 'committed')).toBe(true);
    });
});
