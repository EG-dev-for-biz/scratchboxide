/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The staged runs this server process is running or has run: their stage events and the latest scene artifact each
 * emitted, kept so a page can re-attach after a reload (GET /gemini/staged-runs/:runId) and a dropped chat stream never
 * stops a build. The chat stream, while connected, is one listener among others.
 *
 * A run is forgotten a while after it ends (`keepFinishedMs`); the run record on disk (stage-cache.ts) outlives it, and
 * a resume (resumeRunId) rebuilds from that.
 */

import type { StageEvent } from '../../../common/spatial/staged-location-contracts';
import type { CanvasArtifact } from '../../../browser/generative-canvas/canvas-types';

export type StagedRunStatus = 'running' | 'finished' | 'failed' | 'stopped';

export interface StagedRunSnapshot {
    runId: string;
    status: StagedRunStatus;
    startedAtMs: number;
    endedAtMs?: number;
    /** Events after `after` (all when omitted), in seq order. */
    events: StageEvent[];
    /** The latest scene artifact the run emitted, when it emitted one since `after`'s event (or ever, when all events are asked for). */
    artifact?: CanvasArtifact;
    /** The highest seq the run has emitted. */
    lastSeq: number;
    /** Why it failed or stopped. */
    error?: string;
}

interface Entry {
    runId: string;
    status: StagedRunStatus;
    startedAtMs: number;
    endedAtMs?: number;
    events: StageEvent[];
    artifact?: CanvasArtifact;
    artifactSeq: number;
    error?: string;
    listeners: Set<(event: StageEvent, artifact?: CanvasArtifact) => void>;
    abort: AbortController;
}

const DEFAULT_KEEP_FINISHED_MS = 30 * 60_000;

export class StagedRunRegistry {
    private readonly runs = new Map<string, Entry>();

    constructor(private readonly keepFinishedMs = DEFAULT_KEEP_FINISHED_MS, private readonly now: () => number = Date.now) {}

    /** Registers a run about to start; `abort` is what stops it (the user's Stop, never a dropped connection). */
    begin(runId: string, abort: AbortController): void {
        this.runs.set(runId, { runId, status: 'running', startedAtMs: this.now(), events: [], artifactSeq: -1, listeners: new Set(), abort });
    }

    /** Records an event (and the artifact it carried) and tells every listener. Unknown runs are ignored. */
    record(runId: string, event: StageEvent, artifact?: CanvasArtifact): void {
        const e = this.runs.get(runId);
        if (!e) return;
        if (!e.events.some(x => x.seq === event.seq)) e.events.push(event);
        if (artifact) {
            e.artifact = artifact;
            e.artifactSeq = event.seq;
        }
        for (const l of e.listeners) {
            try {
                l(event, artifact);
            } catch { /* a listener's failure is its own */ }
        }
    }

    end(runId: string, status: Exclude<StagedRunStatus, 'running'>, artifact?: CanvasArtifact, error?: string): void {
        const e = this.runs.get(runId);
        if (!e) return;
        e.status = status;
        e.endedAtMs = this.now();
        if (artifact) {
            e.artifact = artifact;
            e.artifactSeq = Math.max(e.artifactSeq, e.events.length ? e.events[e.events.length - 1].seq : 0);
        }
        if (error) e.error = error;
        e.listeners.clear();
        const t = setTimeout(() => { if (this.runs.get(runId) === e) this.runs.delete(runId); }, this.keepFinishedMs);
        (t as { unref?: () => void }).unref?.();
    }

    /** A listener for the run's further events; returns the unsubscribe. */
    attach(runId: string, listener: (event: StageEvent, artifact?: CanvasArtifact) => void): () => void {
        const e = this.runs.get(runId);
        if (!e || e.status !== 'running') return () => undefined;
        e.listeners.add(listener);
        return () => { e.listeners.delete(listener); };
    }

    /** Stops a running run (the user asked). */
    stop(runId: string, reason?: Error): boolean {
        const e = this.runs.get(runId);
        if (!e || e.status !== 'running') return false;
        e.abort.abort(reason);
        return true;
    }

    snapshot(runId: string, after?: number): StagedRunSnapshot | undefined {
        const e = this.runs.get(runId);
        if (!e) return undefined;
        const events = after === undefined ? e.events.slice() : e.events.filter(x => x.seq > after);
        const lastSeq = e.events.length ? e.events[e.events.length - 1].seq : -1;
        const artifact = e.artifact && (after === undefined || e.artifactSeq > after || e.status !== 'running') ? e.artifact : undefined;
        return {
            runId, status: e.status, startedAtMs: e.startedAtMs, ...(e.endedAtMs !== undefined ? { endedAtMs: e.endedAtMs } : {}),
            events, ...(artifact ? { artifact } : {}), lastSeq, ...(e.error ? { error: e.error } : {})
        };
    }

    list(): Array<Pick<StagedRunSnapshot, 'runId' | 'status' | 'startedAtMs' | 'endedAtMs' | 'lastSeq'>> {
        return [...this.runs.values()].map(e => ({ runId: e.runId, status: e.status, startedAtMs: e.startedAtMs, ...(e.endedAtMs !== undefined ? { endedAtMs: e.endedAtMs } : {}), lastSeq: e.events.length ? e.events[e.events.length - 1].seq : -1 }));
    }
}

let shared: StagedRunRegistry | undefined;

/** The process-wide registry (the chat's tool and the server's routes share it). */
export function stagedRunRegistry(): StagedRunRegistry {
    return (shared ??= new StagedRunRegistry());
}

/** The abort reason a server puts on a request's signal when the client went away (not a Stop). */
export const CLIENT_DISCONNECTED = 'ClientDisconnected';

export function clientDisconnectedError(): Error {
    const err = new Error('The client disconnected');
    err.name = CLIENT_DISCONNECTED;
    return err;
}

export function isClientDisconnect(reason: unknown): boolean {
    return !!reason && typeof reason === 'object' && (reason as { name?: unknown }).name === CLIENT_DISCONNECTED;
}
