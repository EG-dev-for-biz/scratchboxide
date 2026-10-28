/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Re-attaching to a staged run the server is still running (GET /gemini/staged-runs/:runId): a page that reloaded, or
 * whose chat stream ended, polls the run's events after the last seq it has and applies the artifacts it emits, so a
 * build never depends on the page that started it staying open.
 */

import { getApiBase, withApiHeaders } from '../../../../../common/api-client-config';
import type { StageEvent } from '../../../../../common/spatial/staged-location-contracts';
import type { CanvasArtifact } from '../../../canvas-types';

export interface StagedRunSnapshot {
    runId: string;
    status: 'running' | 'finished' | 'failed' | 'stopped';
    startedAtMs: number;
    endedAtMs?: number;
    events: StageEvent[];
    artifact?: CanvasArtifact;
    lastSeq: number;
    error?: string;
}

export type StagedRunLookup = StagedRunSnapshot | 'unknown';

export const STAGED_RUN_POLL_MS = 2000;

function url(p: string): string {
    const base = getApiBase();
    return base ? `${base.replace(/\/+$/, '')}${p}` : p;
}

/** The run's events after `after` and its latest artifact, or 'unknown' when this server has no such run. */
export async function fetchStagedRun(runId: string, after: number | undefined, fetchImpl: typeof fetch = (...a) => fetch(...a)): Promise<StagedRunLookup> {
    const res = await fetchImpl(url(`/gemini/staged-runs/${encodeURIComponent(runId)}${after !== undefined ? `?after=${after}` : ''}`), withApiHeaders({}));
    if (res.status === 404) return 'unknown';
    const body = await res.json().catch(() => ({}));
    if (!res.ok || !body?.run) throw new Error(body?.error || `${res.status} ${res.statusText}`);
    return body.run as StagedRunSnapshot;
}

export async function stopStagedRun(runId: string, fetchImpl: typeof fetch = (...a) => fetch(...a)): Promise<boolean> {
    const res = await fetchImpl(url(`/gemini/staged-runs/${encodeURIComponent(runId)}/stop`), withApiHeaders({ method: 'POST' }));
    const body = await res.json().catch(() => ({}));
    return !!body?.stopped;
}

export interface StagedRunFollower {
    stop: () => void;
}

/**
 * Polls a run until it ends or the server does not know it. `onEvents` gets each batch of new events with the artifact
 * that came with them; `onEnd` the final status ('unknown' when the server has no such run: it restarted, or the run was
 * forgotten; the page then shows the run as interrupted and offers Resume).
 */
export function followStagedRun(runId: string, opts: {
    after?: number;
    onEvents: (events: StageEvent[], artifact: CanvasArtifact | undefined, snapshot: StagedRunSnapshot) => void;
    onEnd: (status: StagedRunSnapshot['status'] | 'unknown', snapshot?: StagedRunSnapshot) => void;
    pollMs?: number;
    fetchImpl?: typeof fetch;
}): StagedRunFollower {
    let after = opts.after;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const pollMs = opts.pollMs ?? STAGED_RUN_POLL_MS;
    const tick = async () => {
        if (stopped) return;
        lastPollAt.set(runId, Date.now());
        try {
            const r = await fetchStagedRun(runId, after, opts.fetchImpl);
            if (stopped) return;
            if (r === 'unknown') {
                opts.onEnd('unknown');
                return;
            }
            if (r.events.length || r.artifact) opts.onEvents(r.events, r.artifact, r);
            after = Math.max(after ?? -1, r.lastSeq);
            if (r.status !== 'running') {
                opts.onEnd(r.status, r);
                return;
            }
        } catch {
            // the server is away for a moment: try again on the next tick
        }
        timer = setTimeout(tick, pollMs);
    };
    // never sooner than the poll interval after this run's last poll, however often followers come and go
    const wait = Math.max(0, (lastPollAt.get(runId) ?? 0) + pollMs - Date.now());
    if (wait > 0) timer = setTimeout(tick, wait); else void tick();
    return { stop: () => { stopped = true; if (timer) clearTimeout(timer); } };
}

/** When each run was last polled (ms), so a follower started again right after another stopped waits out the interval. */
const lastPollAt = new Map<string, number>();

type SharedListener = { onEvents: Parameters<typeof followStagedRun>[1]['onEvents']; onEnd: Parameters<typeof followStagedRun>[1]['onEnd'] };
interface SharedEntry {
    follower: StagedRunFollower;
    listeners: Set<SharedListener>;
    ended?: { status: StagedRunSnapshot['status'] | 'unknown'; snapshot?: StagedRunSnapshot };
    /** The stop pending after the last listener left (a listener that comes back within the grace keeps the poll). */
    stopTimer?: ReturnType<typeof setTimeout>;
}

/** How long a run's poll outlives its last listener (ms): an effect that unsubscribes and subscribes again keeps one poll. */
const SHARED_STOP_GRACE_MS = 1000;
const shared = new Map<string, SharedEntry>();

/**
 * One follower per run for the whole page, however many viewports or effect re-runs ask for it: each caller gets the
 * run's events from its own subscription on; the poll stops when the run ends, or SHARED_STOP_GRACE_MS after the last
 * caller leaves (an effect that re-subscribes on every event it applies keeps the one poll instead of starting a new one,
 * which polled the server back to back until the browser ran out of connections).
 */
export function followStagedRunShared(runId: string, listener: SharedListener, opts: { after?: number; pollMs?: number; fetchImpl?: typeof fetch } = {}): () => void {
    let entry: SharedEntry | undefined = shared.get(runId);
    if (entry?.ended) {
        listener.onEnd(entry.ended.status, entry.ended.snapshot);
        return () => undefined;
    }
    if (!entry) {
        const listeners = new Set<SharedListener>();
        const e: SharedEntry = { listeners, follower: { stop: () => undefined } };
        e.follower = followStagedRun(runId, {
            after: opts.after, pollMs: opts.pollMs, fetchImpl: opts.fetchImpl,
            onEvents: (events, artifact, snapshot) => { for (const l of [...listeners]) l.onEvents(events, artifact, snapshot); },
            onEnd: (status, snapshot) => {
                e.ended = { status, snapshot };
                for (const l of [...listeners]) l.onEnd(status, snapshot);
                // a finished run is forgotten after a while, so a later page state can ask again
                const t = setTimeout(() => { if (shared.get(runId) === e) shared.delete(runId); }, 60_000);
                (t as { unref?: () => void }).unref?.();
            }
        });
        shared.set(runId, e);
        entry = e;
    }
    if (entry.stopTimer) { clearTimeout(entry.stopTimer); entry.stopTimer = undefined; }
    entry.listeners.add(listener);
    const e = entry;
    return () => {
        e.listeners.delete(listener);
        if (e.listeners.size === 0 && !e.ended && !e.stopTimer) {
            e.stopTimer = setTimeout(() => {
                e.stopTimer = undefined;
                if (e.listeners.size) return;
                e.follower.stop();
                if (shared.get(runId) === e) shared.delete(runId);
            }, SHARED_STOP_GRACE_MS);
            (e.stopTimer as { unref?: () => void }).unref?.();
        }
    };
}
