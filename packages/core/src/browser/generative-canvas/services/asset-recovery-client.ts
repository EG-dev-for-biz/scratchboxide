/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The viewport's side of asset recovery (/api/assets/recover): paths that failed to load are sent in one batch, the
 * job is polled while it runs, and listeners get every change so the viewport can show progress, offer Cancel, and
 * load the files again when they are restored or rebuilt. A path is recovered once per page: a file that fails again
 * after its recovery is a real failure and stays one.
 */

import { getApiBase, withApiHeaders } from '../../../common/api-client-config';

export type RecoveryOutcome = 'pending' | 'present' | 'restored' | 'rebuilt' | 'failed' | 'unrecoverable';

export interface RecoveryItem {
    path: string;
    outcome: RecoveryOutcome;
    detail?: string;
}

export interface RecoveryJob {
    id: string;
    status: 'running' | 'done' | 'cancelled';
    items: RecoveryItem[];
    message: string;
    fraction?: number;
    startedAtMs: number;
    endedAtMs?: number;
}

export interface AssetRecoveryState {
    job?: RecoveryJob;
    /** The request itself failed (no job was started). */
    error?: string;
}

/** Served paths the store can answer for: the same prefixes the server looks up (app.ts). */
const RECOVERABLE_PREFIXES = ['/models/', '/build/3d-python/', '/build/generated-images/', '/renders/', '/datasets/', '/splats/'];

/** The served path of a model URL when the asset store may hold it; undefined for anything else (absolute URLs, blobs, data). */
export function recoverableAssetPath(url: string): string | undefined {
    let pathname = url;
    try {
        const base = getApiBase();
        if (/^[a-z]+:/i.test(url)) {
            const u = new URL(url);
            if (base && !url.startsWith(base) && u.origin !== window.location.origin) return undefined;
            pathname = u.pathname;
        } else {
            pathname = url.split('?')[0].split('#')[0];
        }
    } catch {
        return undefined;
    }
    return RECOVERABLE_PREFIXES.some(p => pathname.startsWith(p)) ? pathname : undefined;
}

const BATCH_MS = 250;
const POLL_MS = 1500;

export class AssetRecoveryClient {
    private state: AssetRecoveryState = {};
    private readonly listeners = new Set<(state: AssetRecoveryState) => void>();
    /** Paths waiting to be sent, each with whether only a restore from the store was asked for (a chat opened to look at it). */
    private queued = new Map<string, boolean>();
    private batchTimer: ReturnType<typeof setTimeout> | undefined;
    private pollTimer: ReturnType<typeof setTimeout> | undefined;
    /** Paths recovered (or found unrecoverable) already: not sent again. */
    private readonly settled = new Map<string, RecoveryItem>();

    constructor(private readonly fetchImpl: typeof fetch = (...args) => fetch(...args)) {}

    getState(): AssetRecoveryState {
        return this.state;
    }

    /** What a path's last recovery concluded, when one ran. */
    outcomeOf(servedPath: string): RecoveryItem | undefined {
        return this.settled.get(servedPath);
    }

    subscribe(listener: (state: AssetRecoveryState) => void): () => void {
        this.listeners.add(listener);
        return () => { this.listeners.delete(listener); };
    }

    /**
     * Asks for `servedPaths` to be recovered; calls within a short window go as one request. `restoreOnly`: only what the
     * store holds is restored and nothing is rebuilt (the viewport offers the rebuild instead).
     */
    request(servedPaths: string[], opts: { restoreOnly?: boolean } = {}): void {
        for (const p of servedPaths) {
            if (!this.settled.has(p) && !this.state.job?.items.some(i => i.path === p && this.state.job?.status === 'running')) {
                this.queued.set(p, (this.queued.get(p) ?? true) && !!opts.restoreOnly);
            }
        }
        if (this.queued.size === 0 || this.batchTimer) return;
        this.batchTimer = setTimeout(() => { this.batchTimer = undefined; void this.flush(); }, BATCH_MS);
    }

    /**
     * Rebuilds `servedPaths` from the scene's own place when they have no recipe (files made before the store): the
     * user asked for it, so their earlier "unrecoverable" verdicts are forgotten and the job starts at once.
     */
    rebuild(servedPaths: string[], stagedRequest: { query: string; isolate?: boolean; trees?: boolean; place?: { lat: number; lng: number; formattedAddress: string } }, activeArtifact?: { id: string; type: string; data?: unknown }): void {
        for (const p of servedPaths) {
            this.settled.delete(p);
            this.queued.set(p, false);
        }
        if (this.batchTimer) clearTimeout(this.batchTimer);
        this.batchTimer = undefined;
        void this.flush(stagedRequest, activeArtifact);
    }

    async cancel(): Promise<void> {
        const job = this.state.job;
        if (!job || job.status !== 'running') return;
        try {
            const res = await this.fetchImpl(this.url(`/api/assets/recover/${job.id}/cancel`), withApiHeaders({ method: 'POST' }));
            const body = await res.json();
            if (body?.job) this.update({ job: body.job });
        } catch (err) {
            this.update({ ...this.state, error: (err as Error).message });
        }
    }

    private url(p: string): string {
        const base = getApiBase();
        return base ? `${base.replace(/\/+$/, '')}${p}` : p;
    }

    private async flush(fallbackStagedRequest?: unknown, activeArtifact?: unknown): Promise<void> {
        // one job at a time: paths that arrive during a run go in the next one
        if (this.state.job?.status === 'running') {
            this.batchTimer = setTimeout(() => { this.batchTimer = undefined; void this.flush(fallbackStagedRequest, activeArtifact); }, POLL_MS);
            return;
        }
        // paths that may be rebuilt go first and alone: a restore-only path never rides in a job that rebuilds
        const rebuildable = [...this.queued].filter(([, restoreOnly]) => !restoreOnly).map(([p]) => p);
        const paths = rebuildable.length ? rebuildable : [...this.queued.keys()];
        const restoreOnly = rebuildable.length === 0 && !fallbackStagedRequest;
        for (const p of paths) this.queued.delete(p);
        if (this.queued.size && !this.batchTimer) this.batchTimer = setTimeout(() => { this.batchTimer = undefined; void this.flush(); }, BATCH_MS);
        if (paths.length === 0) return;
        try {
            const res = await this.fetchImpl(this.url('/api/assets/recover'), withApiHeaders({
                method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ paths, ...(restoreOnly ? { restoreOnly } : {}), ...(fallbackStagedRequest ? { fallbackStagedRequest } : {}), ...(activeArtifact ? { activeArtifact } : {}) })
            }));
            const body = await res.json().catch(() => ({}));
            if (!res.ok || !body?.job) throw new Error(body?.error || `${res.status} ${res.statusText}`);
            this.update({ job: body.job });
            this.poll();
        } catch (err) {
            for (const p of paths) this.settled.set(p, { path: p, outcome: 'failed', detail: (err as Error).message });
            this.update({ error: `Recovery could not start: ${(err as Error).message}` });
        }
    }

    private poll(): void {
        const job = this.state.job;
        if (!job || job.status !== 'running') return;
        if (this.pollTimer) clearTimeout(this.pollTimer);
        this.pollTimer = setTimeout(async () => {
            this.pollTimer = undefined;
            try {
                const res = await this.fetchImpl(this.url(`/api/assets/recover/${job.id}`), withApiHeaders({}));
                const body = await res.json().catch(() => ({}));
                if (!res.ok || !body?.job) throw new Error(body?.error || `${res.status} ${res.statusText}`);
                this.update({ job: body.job });
            } catch (err) {
                this.update({ job: { ...job, status: 'done', message: `Lost track of the recovery: ${(err as Error).message}` }, error: (err as Error).message });
            }
            this.poll();
        }, POLL_MS);
    }

    private update(state: AssetRecoveryState): void {
        this.state = state;
        if (state.job && state.job.status !== 'running') {
            for (const item of state.job.items) if (item.outcome !== 'pending') this.settled.set(item.path, item);
        }
        for (const l of this.listeners) l(state);
    }
}

export const assetRecoveryClient = new AssetRecoveryClient();
