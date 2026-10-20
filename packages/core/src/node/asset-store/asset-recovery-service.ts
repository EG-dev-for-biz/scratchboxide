/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Recovery of served files that are missing: the viewport asks for the paths that failed to load, and each is
 *   1. found in the durable store (the server then serves it from there), or
 *   2. rebuilt from its recipe: a staged location run is re-run with its recorded request, and every lost path is
 *      pointed at the new run's file for the same layer, marked as rebuilt, or
 *   3. reported as unrecoverable, with why (never recorded; a recipe this service cannot re-run).
 *
 * A recovery is a job: it reports progress, can be cancelled, and never throws out of its own run.
 */

import * as crypto from 'crypto';
import * as path from 'path';
import { DurableAssetStore, normalizeServedPath } from './durable-asset-store';

export type RecoveryOutcome = 'pending' | 'present' | 'restored' | 'rebuilt' | 'failed' | 'unrecoverable';

export interface RecoveryItem {
    path: string;
    outcome: RecoveryOutcome;
    /** Why it failed or cannot be recovered; what it was rebuilt from. */
    detail?: string;
}

export interface RecoveryJob {
    id: string;
    status: 'running' | 'done' | 'cancelled';
    items: RecoveryItem[];
    /** The current step, for the viewport. */
    message: string;
    /** 0..1 of the current rebuild when known. */
    fraction?: number;
    startedAtMs: number;
    endedAtMs?: number;
}

/** Re-runs a staged location build from its recorded request and reports the files it published. */
export interface StagedRebuilder {
    (request: unknown, ctx: { workspaceRoot: string; signal: AbortSignal; reportProgress: (message: string, fraction?: number) => void }):
        Promise<{ runId: string; layers: Array<{ url: string }> }>;
}

export interface AssetRecoveryOptions {
    workspaceRoot: string;
    rebuildStaged?: StagedRebuilder;
    /** Jobs are forgotten this long after they end (default 10 minutes). */
    keepFinishedMs?: number;
    now?: () => number;
}

/**
 * The part of a published file name that is the same across runs: a staged file is <base>_<key8><rest> (the key is the
 * stage cache key's first 8 hex digits), so two files of the same layer from different runs share base and rest.
 */
export function layerNameKey(servedPath: string): string | undefined {
    const name = path.posix.basename(servedPath);
    const ext = name.endsWith('.order.json') ? '.order.json' : path.posix.extname(name);
    const stem = name.slice(0, name.length - ext.length);
    const m = /^(.*)_([0-9a-f]{8})(.*)$/.exec(stem);
    if (!m) return undefined;
    return `${m[1]}|${m[3]}${ext}`;
}

export class AssetRecoveryService {
    private readonly jobs = new Map<string, { job: RecoveryJob; abort: AbortController }>();
    private readonly now: () => number;

    constructor(private readonly store: DurableAssetStore, private readonly options: AssetRecoveryOptions) {
        this.now = options.now ?? Date.now;
    }

    /** Starts a recovery of `paths` and returns the job at once; its items settle as it runs. */
    start(paths: string[]): RecoveryJob {
        const items: RecoveryItem[] = [];
        for (const raw of paths) {
            let normalized: string;
            try {
                normalized = normalizeServedPath(raw);
            } catch (err) {
                items.push({ path: raw, outcome: 'unrecoverable', detail: (err as Error).message });
                continue;
            }
            if (!items.some(i => i.path === normalized)) items.push({ path: normalized, outcome: 'pending' });
        }
        const job: RecoveryJob = { id: crypto.randomBytes(6).toString('hex'), status: 'running', items, message: 'Looking for the files', startedAtMs: this.now() };
        const abort = new AbortController();
        this.jobs.set(job.id, { job, abort });
        this.run(job, abort.signal).catch(err => {
            for (const item of job.items) if (item.outcome === 'pending') { item.outcome = 'failed'; item.detail = (err as Error).message; }
            job.message = `Recovery failed: ${(err as Error).message}`;
        }).finally(() => {
            if (job.status === 'running') job.status = abort.signal.aborted ? 'cancelled' : 'done';
            job.endedAtMs = this.now();
            this.forgetLater(job.id);
        });
        return job;
    }

    get(id: string): RecoveryJob | undefined {
        return this.jobs.get(id)?.job;
    }

    cancel(id: string): RecoveryJob | undefined {
        const entry = this.jobs.get(id);
        if (!entry) return undefined;
        if (entry.job.status === 'running') {
            entry.abort.abort();
            entry.job.status = 'cancelled';
            entry.job.message = 'Cancelled';
            for (const item of entry.job.items) if (item.outcome === 'pending') { item.outcome = 'failed'; item.detail = 'cancelled'; }
        }
        return entry.job;
    }

    private async run(job: RecoveryJob, signal: AbortSignal): Promise<void> {
        // 1. the store
        for (const item of job.items) {
            if (item.outcome !== 'pending') continue;
            if (this.store.lookup(item.path)) {
                item.outcome = 'restored';
                item.detail = 'served from the asset store';
            }
        }
        // 2. recipes, grouped so one lost run is rebuilt once
        const groups = new Map<string, { recipe: { id: string; kind: string; body: unknown }; items: RecoveryItem[] }>();
        for (const item of job.items) {
            if (item.outcome !== 'pending') continue;
            const record = this.store.record(item.path);
            if (!record) {
                item.outcome = 'unrecoverable';
                item.detail = 'this file was never recorded in the asset store, so there is no recipe to rebuild it from';
                continue;
            }
            const recipe = record.recipeId ? this.store.recipe(record.recipeId) : undefined;
            if (!recipe) {
                item.outcome = 'unrecoverable';
                item.detail = `recorded from ${record.origin} without a recipe; ask the chat to make it again`;
                continue;
            }
            if (recipe.kind !== 'staged-location' || !this.options.rebuildStaged) {
                item.outcome = 'unrecoverable';
                item.detail = `its recipe is a ${recipe.kind} result, which is not rebuilt automatically; ask the chat to make it again`;
                continue;
            }
            const group = groups.get(recipe.id) ?? { recipe, items: [] };
            group.items.push(item);
            groups.set(recipe.id, group);
        }
        let index = 0;
        for (const group of groups.values()) {
            if (signal.aborted) return;
            index++;
            const body = group.recipe.body as { request?: unknown; runId?: string };
            const request = body?.request;
            if (!request) {
                for (const item of group.items) { item.outcome = 'failed'; item.detail = `the recorded run ${group.recipe.id} has no request to re-run`; }
                continue;
            }
            const label = groups.size > 1 ? ` (${index} of ${groups.size})` : '';
            job.message = `Rebuilding ${group.items.length} file${group.items.length === 1 ? '' : 's'} from the recorded request${label}`;
            job.fraction = undefined;
            try {
                const result = await this.options.rebuildStaged!(request, {
                    workspaceRoot: this.options.workspaceRoot, signal,
                    reportProgress: (message, fraction) => { job.message = `${message}${label}`; job.fraction = fraction; }
                });
                const produced = new Map<string, string>();
                const urls = new Set<string>([...result.layers.map(l => l.url), ...(result.runId ? this.store.servedByRecipe(`staged:${result.runId}`).map(s => s.path) : [])]);
                for (const url of urls) {
                    const key = layerNameKey(url);
                    if (key && !produced.has(key)) produced.set(key, url);
                }
                for (const item of group.items) {
                    if (this.store.lookup(item.path)) {
                        // the rebuild published the very same name (same cache keys)
                        item.outcome = 'restored';
                        item.detail = `published again by run ${result.runId}`;
                        continue;
                    }
                    const key = layerNameKey(item.path);
                    const replacement = key ? produced.get(key) : undefined;
                    if (!replacement || !this.store.lookup(replacement)) {
                        item.outcome = 'failed';
                        item.detail = `run ${result.runId} published no file for this layer (${[...urls].map(u => path.posix.basename(u)).join(', ') || 'nothing'})`;
                        continue;
                    }
                    this.store.alias(item.path, replacement, { origin: 'recovery', rebuilt: true, workspace: this.options.workspaceRoot });
                    item.outcome = 'rebuilt';
                    item.detail = `rebuilt by run ${result.runId} as ${path.posix.basename(replacement)}`;
                }
            } catch (err) {
                const reason = signal.aborted ? 'cancelled' : (err as Error).message;
                for (const item of group.items) { item.outcome = 'failed'; item.detail = reason; }
                if (signal.aborted) return;
            }
        }
        const counts = { restored: 0, rebuilt: 0, failed: 0, unrecoverable: 0 };
        for (const item of job.items) if (item.outcome in counts) counts[item.outcome as keyof typeof counts]++;
        job.message = [
            counts.restored ? `${counts.restored} restored` : '', counts.rebuilt ? `${counts.rebuilt} rebuilt` : '',
            counts.failed ? `${counts.failed} failed` : '', counts.unrecoverable ? `${counts.unrecoverable} not recoverable` : ''
        ].filter(Boolean).join(', ') || 'Nothing to recover';
        job.fraction = 1;
    }

    private forgetLater(id: string): void {
        const t = setTimeout(() => this.jobs.delete(id), this.options.keepFinishedMs ?? 10 * 60_000);
        (t as { unref?: () => void }).unref?.();
    }
}
