/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The staged run registry: a run's events and artifacts are kept for a page to re-attach after the seq it has; a
 * dropped connection is told from a Stop; the follower on the page applies new events and ends on the run's end or
 * when the server does not know the run.
 */

import { describe, it, expect } from 'vitest';
import { StagedRunRegistry, clientDisconnectedError, isClientDisconnect } from '../src/node/3d-engine/staged-location/staged-run-registry';
import { followStagedRun, followStagedRunShared } from '../src/browser/generative-canvas/primitives/scene3d/stagedBuild/stagedRunClient';
import type { StageEvent } from '../src/common/spatial/staged-location-contracts';

const ev = (seq: number, status: StageEvent['status'] = 'running'): StageEvent => ({
    schema: 'scratchbox.stage-event/2', runId: 'abcd1234', seq, stage: 'remesh', order: 2, status, title: 'Remeshed scan', source: 'tile_refine',
    degradations: [], timings: { startedAtMs: 1 } as never
});
const art = (n: number) => ({ id: 'scene-stg-abcd1234', type: '3d-scene', data: { objects: [], n } } as never);

describe('StagedRunRegistry', () => {
    it('keeps events and the latest artifact, serves them after a seq, and tells a disconnect from a Stop', () => {
        const reg = new StagedRunRegistry(60_000, () => 1000);
        const abort = new AbortController();
        reg.begin('abcd1234', abort);
        const seen: number[] = [];
        const off = reg.attach('abcd1234', e => seen.push(e.seq));
        reg.record('abcd1234', ev(1));
        reg.record('abcd1234', ev(2, 'committed'), art(2));
        reg.record('abcd1234', ev(3));
        reg.record('abcd1234', ev(3)); // delivered twice: kept once
        expect(seen).toEqual([1, 2, 3, 3]);
        off();
        reg.record('abcd1234', ev(4));
        expect(seen).toEqual([1, 2, 3, 3]);

        const all = reg.snapshot('abcd1234')!;
        expect(all.events.map(e => e.seq)).toEqual([1, 2, 3, 4]);
        expect(all.artifact).toMatchObject({ data: { n: 2 } });
        expect(all.lastSeq).toBe(4);
        // after seq 2: only later events, and no artifact (the one it has came with seq 2)
        const later = reg.snapshot('abcd1234', 2)!;
        expect(later.events.map(e => e.seq)).toEqual([3, 4]);
        expect(later.artifact).toBeUndefined();
        expect(reg.snapshot('abcd1234', 1)!.artifact).toMatchObject({ data: { n: 2 } });

        expect(isClientDisconnect(clientDisconnectedError())).toBe(true);
        expect(isClientDisconnect(new Error('x'))).toBe(false);
        expect(reg.stop('abcd1234')).toBe(true);
        expect(abort.signal.aborted).toBe(true);
        reg.end('abcd1234', 'stopped', art(9));
        expect(reg.snapshot('abcd1234', 4)).toMatchObject({ status: 'stopped', artifact: { data: { n: 9 } } });
        expect(reg.stop('abcd1234')).toBe(false);
        expect(reg.snapshot('nope')).toBeUndefined();
    });
});

describe('followStagedRun', () => {
    const server = (snapshots: Array<{ status: number; body?: unknown }>) => {
        const calls: string[] = [];
        const fetchImpl = (async (input: RequestInfo | URL) => {
            calls.push(String(input));
            const next = snapshots.shift() ?? { status: 404 };
            return { status: next.status, ok: next.status < 400, statusText: '', json: async () => next.body ?? {} } as Response;
        }) as typeof fetch;
        return { fetchImpl, calls };
    };
    const snap = (events: StageEvent[], status: 'running' | 'finished', artifact?: unknown) => ({ run: { runId: 'abcd1234', status, startedAtMs: 1, events, lastSeq: events.length ? events[events.length - 1].seq : -1, ...(artifact ? { artifact } : {}) } });

    it('applies new events and artifacts after the seq it has, then ends with the run', async () => {
        const { fetchImpl, calls } = server([
            { status: 200, body: snap([ev(3), ev(4, 'committed')], 'running', art(4)) },
            { status: 200, body: snap([], 'running') },
            { status: 200, body: snap([ev(5, 'committed')], 'finished', art(5)) }
        ]);
        const got: Array<{ seqs: number[]; n?: number }> = [];
        const ended = await new Promise<string>(resolve => {
            followStagedRun('abcd1234', {
                after: 2, pollMs: 1, fetchImpl,
                onEvents: (events, artifact) => got.push({ seqs: events.map(e => e.seq), n: (artifact as { data?: { n?: number } } | undefined)?.data?.n }),
                onEnd: status => resolve(status)
            });
        });
        expect(ended).toBe('finished');
        expect(got).toEqual([{ seqs: [3, 4], n: 4 }, { seqs: [5], n: 5 }]);
        expect(calls[0]).toContain('/gemini/staged-runs/abcd1234?after=2');
        expect(calls[1]).toContain('?after=4');
    });

    it('ends as unknown when the server has no such run', async () => {
        const { fetchImpl } = server([{ status: 404 }]);
        const ended = await new Promise<string>(resolve => { followStagedRun('abcd1234', { pollMs: 1, fetchImpl, onEvents: () => undefined, onEnd: s => resolve(s) }); });
        expect(ended).toBe('unknown');
    });

    it('shares one poll per run between every caller on the page', async () => {
        const { fetchImpl, calls } = server([
            { status: 200, body: snap([ev(1)], 'running') },
            { status: 200, body: snap([ev(2, 'committed')], 'finished', art(2)) }
        ]);
        const a: number[] = [], b: number[] = [];
        const ends: string[] = [];
        const done = new Promise<void>(resolve => {
            const stopA = followStagedRunShared('abcd1234', { onEvents: e => a.push(...e.map(x => x.seq)), onEnd: s => { ends.push(`a:${s}`); } }, { pollMs: 1, fetchImpl });
            followStagedRunShared('abcd1234', { onEvents: e => b.push(...e.map(x => x.seq)), onEnd: s => { ends.push(`b:${s}`); resolve(); } }, { pollMs: 1, fetchImpl });
            void stopA;
        });
        await done;
        expect(a).toEqual([1, 2]);
        expect(b).toEqual([1, 2]);
        expect(ends.sort()).toEqual(['a:finished', 'b:finished']);
        expect(calls.length).toBe(2);
        // a caller arriving after the end hears the end at once, with no new poll
        const late: string[] = [];
        followStagedRunShared('abcd1234', { onEvents: () => undefined, onEnd: s => late.push(s) }, { pollMs: 1, fetchImpl });
        expect(late).toEqual(['finished']);
        expect(calls.length).toBe(2);
    });

    it('keeps one poll at its interval when a caller leaves and comes back on every event (an effect re-run)', async () => {
        let n = 0;
        const fetchImpl = (async () => { n++; return { status: 200, ok: true, statusText: '', json: async () => snap([], 'running') } as Response; }) as typeof fetch;
        // 20 leave-and-return cycles within ~40 ms, the poll at 100 ms
        let stop = followStagedRunShared('rerun0001', { onEvents: () => undefined, onEnd: () => undefined }, { pollMs: 100, fetchImpl });
        for (let i = 0; i < 20; i++) {
            await new Promise(r => setTimeout(r, 2));
            stop();
            stop = followStagedRunShared('rerun0001', { onEvents: () => undefined, onEnd: () => undefined }, { pollMs: 100, fetchImpl });
        }
        expect(n).toBeLessThanOrEqual(2);
        stop();
    });
});
