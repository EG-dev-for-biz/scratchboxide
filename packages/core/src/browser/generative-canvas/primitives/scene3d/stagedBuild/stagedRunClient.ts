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
    const tick = async () => {
        if (stopped) return;
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
        timer = setTimeout(tick, opts.pollMs ?? STAGED_RUN_POLL_MS);
    };
    void tick();
    return { stop: () => { stopped = true; if (timer) clearTimeout(timer); } };
}
