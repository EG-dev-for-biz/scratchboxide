/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The staged-build reveal scheduler (design §7.1) and the renderer-side build state (§6.4, §7.6): canonical order and
 * the 2 s out-of-order rule, revealAfter holds that never time out, half-speed cached layers, Stop and both
 * interruption signals, reduced motion, crossfade presence (complementary) and supersede, a crossfade source that
 * vanishes mid-way, node windows with no NaN for one or two nodes, StageEvents merged forward only, and the Stop mark.
 */

import { describe, expect, test } from 'vitest';
import { STAGED_SUMMARY_LIMITS, validateContract, type StageEvent, type StagedBuildState, type StagedLayer } from '../src/common/spatial/staged-location-contracts';
import {
    MAX_CONCURRENT_REVEALS,
    OUT_OF_ORDER_WAIT_MS,
    compareLayers,
    currentStage,
    nodeProgress,
    nodeRevealWindow,
    stepRevealSchedule,
    type LayerLoadState,
    type RevealInput,
    type RevealSchedule
} from '../src/browser/generative-canvas/primitives/scene3d/stagedBuild/revealScheduler';
import {
    isInterrupted,
    isRunSettled,
    markStagedRun,
    mergeStageEvent,
    publishStageEvent,
    readStagedBuild,
    settleStagedRunInSession,
    stageEventsFor,
    streamedProgress,
    subscribeStageEvents,
    withStreamedEvents
} from '../src/browser/generative-canvas/primitives/scene3d/stagedBuild/stagedBuildState';
import type { CanvasArtifact, ChatSession } from '../src/browser/generative-canvas/canvas-types';
import { FIXTURE_RUN_ID, fixtureLayer, fixtureState, objectIdOf, type FixtureLayerId } from './helpers/staged-glb-fixture';

const COUNTS = Object.fromEntries((['l1', 'l2', 'l3a', 'l3b', 'l4', 'l5', 'l5x'] as const).map(l => [l, { vertices: 1000, triangles: 1800, nodes: 3 }])) as Record<FixtureLayerId, { vertices: number; triangles: number; nodes: number }>;
const layer = (l: FixtureLayerId, extra: Partial<StagedLayer> = {}) => fixtureLayer(l, COUNTS, '/models', extra);

/** Drives the scheduler like the per-frame guard does. */
class Clock {
    schedule: RevealSchedule | undefined;
    loads: Record<string, LayerLoadState> = {};
    constructor(public state: StagedBuildState, public now = 0, public opts: Partial<RevealInput> = {}) {}
    load(...ids: FixtureLayerId[]) { for (const id of ids) this.loads[objectIdOf(id)] = { ready: true, readyAtMs: this.now }; return this; }
    unload(id: FixtureLayerId) { this.loads[objectIdOf(id)] = { ready: false }; return this; }
    step(dtMs = 0) {
        this.now += dtMs;
        const r = stepRevealSchedule(this.schedule, { state: this.state, loads: this.loads, nowMs: this.now, reducedMotion: false, settled: false, replayEpoch: 0, ...this.opts });
        this.schedule = r.schedule;
        return r.frame;
    }
    of(frame: ReturnType<Clock['step']>, id: FixtureLayerId) { return frame.layers.find(l => l.objectId === objectIdOf(id))!; }
}

describe('reveal order', () => {
    test('layers reveal in canonical order; a later layer waits for an earlier one still revealing', () => {
        const c = new Clock(fixtureState([layer('l1'), layer('l2')])).load('l1', 'l2');
        let f = c.step();
        expect(c.of(f, 'l1').phase).toBe('revealing');
        expect(c.of(f, 'l2').phase).toBe('queued');
        f = c.step(400);
        expect(c.of(f, 'l1').progress).toBeCloseTo(0.5, 5);
        expect(c.of(f, 'l2').phase).toBe('queued');
        f = c.step(400);
        expect(c.of(f, 'l1').phase).toBe('revealed');
        expect(c.of(f, 'l2').phase).toBe('revealing');
        expect(c.of(f, 'l2').outOfOrder).toBeUndefined();
    });

    test('a layer loaded before an earlier one starts after 2 s and is marked out of order', () => {
        const c = new Clock(fixtureState([layer('l1'), layer('l2'), layer('l5')])).load('l1', 'l2');
        let f = c.step();
        f = c.step(800);            // l1 done
        f = c.step(600);            // l2 done: the trees' data dependency is met
        c.load('l5');
        const state = fixtureState([layer('l1'), layer('l2'), layer('l3b'), layer('l5')]);
        c.state = state;            // the fitted body is committed but not loaded yet
        f = c.step();
        expect(c.of(f, 'l3b').phase).toBe('loading');
        expect(c.of(f, 'l5').phase).toBe('revealing');
        expect(c.of(f, 'l5').outOfOrder).toBe('Trees ready before Scan-fitted rebuild');
    });

    test('an earlier layer still revealing holds a later independent one for 2 s, then it starts anyway', () => {
        const slow = layer('l1', { reveal: { durationMs: 10_000, stagger: 1, crossfadeFrom: [] } });
        const trees = layer('l5', { revealAfter: [] });
        const c = new Clock(fixtureState([slow, trees])).load('l1', 'l5');
        let f = c.step();
        expect(c.of(f, 'l5').phase).toBe('queued');
        f = c.step(OUT_OF_ORDER_WAIT_MS - 1);
        expect(c.of(f, 'l5').phase).toBe('queued');
        f = c.step(1);
        expect(c.of(f, 'l5').phase).toBe('revealing');
        expect(c.of(f, 'l5').outOfOrder).toBeUndefined();   // the earlier layer has started, it just has not finished
    });

    test('at most two layers reveal at once', () => {
        const long = (l: FixtureLayerId) => layer(l, { revealAfter: [], reveal: { durationMs: 10_000, stagger: 0, crossfadeFrom: [] } });
        const c = new Clock(fixtureState([long('l1'), long('l3a'), long('l5')])).load('l1', 'l3a', 'l5');
        const f = c.step(OUT_OF_ORDER_WAIT_MS);
        const g = c.step(OUT_OF_ORDER_WAIT_MS);
        expect(MAX_CONCURRENT_REVEALS).toBe(2);
        expect(g.layers.filter(l => l.phase === 'revealing').length).toBe(2);
        expect(f.layers.filter(l => l.phase === 'revealing').length).toBeLessThanOrEqual(2);
    });

    test('canonical order sorts by order, then by layer id within a stage', () => {
        const sorted = [layer('l5'), layer('l3b'), layer('l1'), layer('l3a')].sort(compareLayers).map(l => l.layer);
        expect(sorted).toEqual(['l1', 'l3a', 'l3b', 'l5']);
    });
});

describe('revealAfter is a real data dependency', () => {
    test('trees never reveal over the scanned canopy: they wait for the remesh however long it takes', () => {
        const c = new Clock(fixtureState([layer('l1'), layer('l2'), layer('l5')], { running: [] })).load('l1', 'l5');
        let f = c.step();
        f = c.step(60_000);
        expect(c.of(f, 'l5').phase).toBe('held');
        expect(c.of(f, 'l5').heldBy).toEqual([objectIdOf('l2')]);
        c.load('l2');
        f = c.step(1);
        f = c.step(600);
        expect(c.of(f, 'l2').phase).toBe('revealed');
        f = c.step(1);
        expect(c.of(f, 'l5').phase).toBe('revealing');
    });

    test('a dependency whose stage ended without committing its layer releases the hold', () => {
        // The remesh degraded: its layer was never committed (the raw-scan rung lives in another layer).
        const trees = layer('l5');
        const st = fixtureState([layer('l1'), trees], { stageStatus: { remesh: 'degraded' } });
        st.stages.find(s => s.stage === 'remesh')!.layerIds = [objectIdOf('l2')];
        const c = new Clock(st).load('l1', 'l5');
        let f = c.step();
        f = c.step(800);
        expect(c.of(f, 'l5').phase).toBe('revealing');
        // While the remesh is still running, the same layer is held.
        const running = fixtureState([layer('l1'), layer('l5')], { running: ['remesh'] });
        running.stages.find(s => s.stage === 'remesh')!.layerIds = [objectIdOf('l2')];
        const d = new Clock(running).load('l1', 'l5');
        d.step();
        expect(d.of(d.step(5_000), 'l5').phase).toBe('held');
    });
});

describe('durations, stop, interruption, reduced motion', () => {
    test('a cached layer plays at half duration', () => {
        const c = new Clock(fixtureState([layer('l1', { cached: true })])).load('l1');
        c.step();
        const f = c.step(400);
        expect(c.of(f, 'l1').durationMs).toBe(400);
        expect(c.of(f, 'l1').phase).toBe('revealed');
    });

    test('a stopped run shows every committed layer at its end state at once, nothing animating', () => {
        const st = fixtureState([layer('l1'), layer('l2')], { runState: 'stopped' });
        const c = new Clock(st, 0, { settled: true }).load('l1', 'l2');
        const f = c.step();
        expect(f.layers.map(l => l.phase)).toEqual(['revealed', 'revealed']);
        expect(f.animating).toBe(false);
        expect(c.of(f, 'l1').hidden).toBe(true);   // superseded by the remesh, which revealed
    });

    test('stopping mid-reveal ends the running reveal on the next frame', () => {
        const c = new Clock(fixtureState([layer('l1')])).load('l1');
        c.step();
        expect(c.of(c.step(200), 'l1').phase).toBe('revealing');
        c.opts = { settled: true };
        const f = c.step(1);
        expect(c.of(f, 'l1').phase).toBe('revealed');
        expect(c.of(f, 'l1').progress).toBe(1);
    });

    test('interruption: marked by the turn end, or a running state saved before this page loaded', () => {
        const st = fixtureState([layer('l1')], { runState: 'running', updatedAtMs: 1_000 });
        expect(isInterrupted(st, 2_000)).toBe(true);
        expect(isInterrupted({ ...st, updatedAtMs: 3_000 }, 2_000)).toBe(false);
        expect(isInterrupted({ ...st, runState: 'interrupted', updatedAtMs: 3_000 }, 2_000)).toBe(true);
        expect(isInterrupted({ ...st, runState: 'finished', updatedAtMs: 1_000 }, 2_000)).toBe(false);
    });

    test('a finished run saved before this page loaded is shown at its end state, not replayed', () => {
        const st = fixtureState([layer('l1')], { runState: 'finished', updatedAtMs: 1_000 });
        expect(isRunSettled(st, 2_000)).toBe(true);
        expect(isRunSettled({ ...st, updatedAtMs: 3_000 }, 2_000)).toBe(false);
        expect(isRunSettled({ ...st, runState: 'stopped', updatedAtMs: 3_000 }, 2_000)).toBe(true);
    });

    test('reduced motion shows the end state at once and says why', () => {
        const c = new Clock(fixtureState([layer('l1')]), 0, { reducedMotion: true }).load('l1');
        const f = c.step();
        expect(c.of(f, 'l1').phase).toBe('revealed');
        expect(c.of(f, 'l1').skipped).toBe('reduced motion');
    });

    test('a layer the guard skips (too many vertices) reveals at once with its reason', () => {
        const c = new Clock(fixtureState([layer('l5', { revealAfter: [] })]), 0, { skipLayer: () => 'over 3 M vertices' }).load('l5');
        const f = c.step();
        expect(c.of(f, 'l5').phase).toBe('revealed');
        expect(c.of(f, 'l5').skipped).toBe('over 3 M vertices');
    });

    test('replay reveals every loaded layer again from 0', () => {
        const c = new Clock(fixtureState([layer('l1')])).load('l1');
        c.step();
        expect(c.of(c.step(800), 'l1').phase).toBe('revealed');
        c.opts = { replayEpoch: 1 };
        const f = c.step(1);
        expect(c.of(f, 'l1').phase).toBe('revealing');
        expect(c.of(f, 'l1').progress).toBe(0);
    });
});

describe('crossfade and supersede', () => {
    test('the source fades out exactly as the replacing layer fades in, then is hidden', () => {
        const c = new Clock(fixtureState([layer('l1'), layer('l2')])).load('l1', 'l2');
        c.step();
        c.step(800);
        let f = c.step(1);
        f = c.step(300);
        expect(c.of(f, 'l2').progress).toBeCloseTo(301 / 600, 3);
        expect(c.of(f, 'l1').presence).toBeCloseTo(1 - c.of(f, 'l2').progress, 6);
        expect(c.of(f, 'l1').hidden).toBe(false);
        f = c.step(300);
        expect(c.of(f, 'l2').phase).toBe('revealed');
        expect(c.of(f, 'l1').hidden).toBe(true);
        expect(c.of(f, 'l1').presence).toBe(0);
    });

    test('under a staggered replacement the source stays whole until the replacement has revealed', () => {
        const c = new Clock(fixtureState([layer('l1'), layer('l2'), layer('l3a'), layer('l3b')])).load('l1', 'l2', 'l3a', 'l3b');
        let f = c.step();
        for (let i = 0; i < 200 && c.of(f, 'l3b').phase !== 'revealing'; i++) f = c.step(50);
        expect(c.of(f, 'l3b').phase).toBe('revealing');
        expect(c.of(f, 'l3b').overSource).toBe(true);
        f = c.step(400);
        expect(c.of(f, 'l3b').progress).toBeGreaterThan(0.3);
        expect(c.of(f, 'l2').presence).toBe(1);
        expect(c.of(f, 'l2').hidden).toBe(false);
        f = c.step(900);
        expect(c.of(f, 'l3b').phase).toBe('revealed');
        expect(c.of(f, 'l3b').overSource).toBe(false);
        expect(c.of(f, 'l2').hidden).toBe(true);
    });

    test('a crossfade source that disappears mid-crossfade ends that crossfade at once', () => {
        const c = new Clock(fixtureState([layer('l1'), layer('l2')])).load('l1', 'l2');
        c.step();
        c.step(800);
        c.step(1);
        expect(c.of(c.step(200), 'l2').phase).toBe('revealing');
        c.unload('l1');                     // retired and released by the loader
        const f = c.step(1);
        expect(c.of(f, 'l2').phase).toBe('revealed');
        expect(c.of(f, 'l2').cutShort).toBe(true);
    });
});

describe('node windows', () => {
    test('one node spans the whole reveal; n = 1 and n = 2 give finite windows', () => {
        for (const perVertex of [true, false]) {
            const one = nodeRevealWindow({ order: 0, count: 1, stagger: 1, perVertex });
            expect(one.start).toBe(0);
            expect(Number.isFinite(one.span)).toBe(true);
            expect(nodeProgress(1, one)).toBe(1);
            const two = [0, 1].map(order => nodeRevealWindow({ order, count: 2, stagger: 0.5, perVertex }));
            for (const w of two) { expect(Number.isFinite(w.start)).toBe(true); expect(Number.isFinite(w.span)).toBe(true); }
        }
    });

    test('per-node fades spread over the stagger and the last node ends at 1', () => {
        const n = 9;
        const windows = Array.from({ length: n }, (_, i) => nodeRevealWindow({ order: i, count: n, stagger: 1, perVertex: false, durationShare: 1 }));
        expect(windows[0].start).toBe(0);
        expect(windows[n - 1].start + windows[n - 1].span).toBeCloseTo(1, 9);
        for (let i = 1; i < n; i++) expect(windows[i].start).toBeGreaterThan(windows[i - 1].start);
        // stagger 0: every node fades in together over the whole reveal
        const together = nodeRevealWindow({ order: 5, count: n, stagger: 0, perVertex: false });
        expect(together).toEqual({ start: 0, span: 1 });
        // at a layer progress of 0.5 about half the leaves have appeared
        const shown = windows.filter(w => nodeProgress(0.5, w) > 0).length;
        expect(shown).toBeGreaterThanOrEqual(4);
        expect(shown).toBeLessThanOrEqual(6);
    });

    test('a node with _REVEAL spans its generator share', () => {
        expect(nodeRevealWindow({ order: 2, count: 3, stagger: 0.5, perVertex: true, durationShare: 0.6 })).toEqual({ start: 0.4, span: 0.6 });
        expect(nodeRevealWindow({ order: 0, count: 940, stagger: 0.3, perVertex: true, durationShare: 1 })).toEqual({ start: 0, span: 1 });
    });
});

describe('the build state on the renderer side', () => {
    test('a streamed StageEvent moves a stage forward, never back, and carries progress', () => {
        const st = fixtureState([layer('l1')], { running: ['remesh'] });
        const ev = (seq: number, status: StageEvent['status'], extra: Partial<StageEvent> = {}): StageEvent => ({
            schema: 'scratchbox.stage-event/2', runId: FIXTURE_RUN_ID, seq, stage: 'remesh', order: 2, status, title: 'Remeshed scan',
            source: 'tile_refine: 3,107 vertices', degradations: [], timings: { startedAtMs: 1, cached: false }, ...extra
        });
        expect(validateContract('StageEvent', ev(1, 'running', { progress: 0.4, message: 'flattening facades' }))).toEqual([]);
        const committed = mergeStageEvent(st, ev(2, 'committed', { layers: [layer('l2')], patch: { upsertObjects: [objectIdOf('l2')], removeObjects: [], supersede: [] } }));
        expect(committed.stages.find(s => s.stage === 'remesh')!.status).toBe('committed');
        expect(committed.layers.map(l => l.objectId)).toContain(objectIdOf('l2'));
        const stale = mergeStageEvent(committed, ev(1, 'running', { progress: 0.4 }));
        expect(stale.stages.find(s => s.stage === 'remesh')!.status).toBe('committed');
        const progress = streamedProgress([ev(1, 'running', { progress: 0.4, message: 'flattening facades' })]);
        expect(progress.get('remesh')).toMatchObject({ progress: 0.4, message: 'flattening facades' });
        expect(streamedProgress([ev(1, 'running', { progress: 0.4 }), ev(2, 'committed')]).has('remesh')).toBe(false);
        // another run's event is ignored
        expect(mergeStageEvent(st, { ...ev(3, 'failed'), runId: 'ffffffff' })).toBe(st);
    });

    test('published events reach subscribers once per seq and replay for a viewport that mounts later', () => {
        const runId = 'abcdef01';
        const seen: number[] = [];
        const off = subscribeStageEvents(e => { if (e.runId === runId) seen.push(e.seq); });
        const ev = (seq: number): StageEvent => ({ schema: 'scratchbox.stage-event/2', runId, seq, stage: 'tiles', order: 1, status: 'running', title: 'Google 3D Tiles', source: '', degradations: [], timings: { startedAtMs: seq, cached: false } });
        publishStageEvent(ev(1));
        publishStageEvent(ev(2));
        publishStageEvent(ev(2));
        publishStageEvent(undefined);
        off();
        expect(seen).toEqual([1, 2]);
        expect(stageEventsFor(runId).map(e => e.seq)).toEqual([1, 2]);
        const st = { ...fixtureState([]), runId };
        expect(withStreamedEvents(st, stageEventsFor(runId)).stages.find(s => s.stage === 'tiles')!.status).toBe('running');
    });

    test('markStagedRun stops running and pending stages, copies objects, and leaves other artifacts alone', () => {
        const st = fixtureState([layer('l1'), layer('l2')], { running: ['fit'] });
        const art: CanvasArtifact = { id: st.artifactId, type: '3d-scene', title: 't', summary: '', createdAt: '', version: 1, data: { title: 't', objects: [], stagedBuild: st } as unknown as CanvasArtifact['data'] };
        const stopped = markStagedRun(art, 'stopped', 42);
        const s = readStagedBuild(stopped.data as never)!;
        expect(s.runState).toBe('stopped');
        expect(s.updatedAtMs).toBe(42);
        expect(s.stages.find(x => x.stage === 'fit')!.status).toBe('stopped');
        expect(s.stages.find(x => x.stage === 'trees')!.status).toBe('stopped');
        expect(s.stages.find(x => x.stage === 'tiles')!.status).toBe('committed');
        expect((stopped.data as { objects: unknown[] }).objects).not.toBe((art.data as { objects: unknown[] }).objects);
        expect(validateContract('StagedBuildState', s)).toEqual([]);
        expect(markStagedRun(stopped, 'interrupted')).toBe(stopped);   // already over
        const other: CanvasArtifact = { ...art, type: 'markdown-document' };
        expect(markStagedRun(other, 'stopped')).toBe(other);
        expect(currentStage(s)?.stage).toBeDefined();
    });

    test('settleStagedRunInSession marks only a still-running run, wherever the scene is held', () => {
        const st = fixtureState([layer('l1')], { running: ['remesh'] });
        const art: CanvasArtifact = { id: st.artifactId, type: '3d-scene', title: 't', summary: '', createdAt: '', version: 1, data: { title: 't', objects: [], stagedBuild: st } as unknown as CanvasArtifact['data'] };
        let active: CanvasArtifact | undefined = art;
        let history: CanvasArtifact[] = [art];
        let sessions: ChatSession[] = [{ id: 'A', title: 'A', dateCategory: 'Today', updatedAt: '', messages: [{ id: 'm', sender: 'assistant', text: '', timestamp: '', artifacts: [art] }], activeArtifact: art, artifactHistory: [art] }];
        const setters = {
            setActiveArtifact: (v: any) => { active = typeof v === 'function' ? v(active) : v; },
            setArtifactHistory: (v: any) => { history = typeof v === 'function' ? v(history) : v; },
            setSessions: (v: any) => { sessions = typeof v === 'function' ? v(sessions) : v; }
        };
        settleStagedRunInSession(setters, art, 'interrupted', 7);
        expect(readStagedBuild(active!.data as never)!.runState).toBe('interrupted');
        expect(readStagedBuild(history[0].data as never)!.runState).toBe('interrupted');
        expect(readStagedBuild(sessions[0].activeArtifact!.data as never)!.runState).toBe('interrupted');
        expect(readStagedBuild(sessions[0].messages[0].artifacts![0].data as never)!.runState).toBe('interrupted');
        const before = sessions;
        settleStagedRunInSession(setters, art, 'interrupted', 8);   // nothing still running: no change
        expect(sessions).toBe(before);
        expect(STAGED_SUMMARY_LIMITS.digestMaxChars).toBe(200);
    });
});
