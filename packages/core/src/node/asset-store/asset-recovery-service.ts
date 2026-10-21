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
    (request: unknown, ctx: { workspaceRoot: string; signal: AbortSignal; reportProgress: (message: string, fraction?: number) => void; activeArtifact?: { id: string; type: string; data?: unknown } }):
        Promise<{ runId: string; layers: Array<{ url: string }> }>;
}

export interface RecoveryStartOptions {
    /**
     * A staged request to rebuild from when a lost file has no recipe (files made before the store existed): the scene
     * still knows its place, so the viewport offers to rebuild the location from it.
     */
    fallbackStaged?: { request: unknown };
    /**
     * The scene the files belong to (a CanvasArtifact). A district rebuilt with it is staged into it as the original
     * was, which is what makes the district remesh carved around the scene's kept structure.
     */
    activeArtifact?: { id: string; type: string; data?: unknown };
}

export interface AssetRecoveryOptions {
    workspaceRoot: string;
    rebuildStaged?: StagedRebuilder;
    /** Jobs are forgotten this long after they end (default 10 minutes). */
    keepFinishedMs?: number;
    now?: () => number;
}

/**
 * The part of a published file name that names its layer: a staged file is <slug>_<layer>_<key8><rest> (the slug is
 * the query's words, the key the stage cache key's first 8 hex digits), so two files of the same layer from different
 * runs share layer and rest even when the runs were asked for with different words for the place. A textured twin
 * keeps its "tex" token with the layer (l2_tex, massing_tex).
 */
export function layerNameKey(servedPath: string): string | undefined {
    const name = path.posix.basename(servedPath);
    const ext = name.endsWith('.order.json') ? '.order.json' : path.posix.extname(name);
    const stem = name.slice(0, name.length - ext.length);
    const m = /^(.*)_([0-9a-f]{8})(.*)$/.exec(stem);
    if (!m) return undefined;
    const tokens = m[1].split('_');
    const last = tokens[tokens.length - 1];
    const layer = last === 'tex' && tokens.length >= 2 ? `${tokens[tokens.length - 2]}_tex` : last;
    return `${layer}|${m[3]}${ext}`;
}

export class AssetRecoveryService {
    private readonly jobs = new Map<string, { job: RecoveryJob; abort: AbortController }>();
    private readonly now: () => number;

    constructor(private readonly store: DurableAssetStore, private readonly options: AssetRecoveryOptions) {
        this.now = options.now ?? Date.now;
    }

    /** Starts a recovery of `paths` and returns the job at once; its items settle as it runs. */
    start(paths: string[], opts: RecoveryStartOptions = {}): RecoveryJob {
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
        this.run(job, abort.signal, opts).catch(err => {
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

    private async run(job: RecoveryJob, signal: AbortSignal, opts: RecoveryStartOptions): Promise<void> {
        // 1. the store
        for (const item of job.items) {
            if (item.outcome !== 'pending') continue;
            if (this.store.lookup(item.path)) {
                item.outcome = 'restored';
                item.detail = 'served from the asset store';
                this.materialize(item);
            }
        }
        // 2. recipes, grouped so one lost run is rebuilt once
        const groups = new Map<string, { recipe: { id: string; kind: string; body: unknown }; items: RecoveryItem[] }>();
        // a staged file with no recipe of its own is rebuilt from the scene's place when the caller gives it
        // an isolated structure and its district are two runs: a file name with "_iso" came from the isolated one
        const fallbackRequest = opts.fallbackStaged && this.options.rebuildStaged ? opts.fallbackStaged.request as Record<string, unknown> : undefined;
        // the district is staged into the scene when the scene is given: that carves its remesh around the kept structure
        const fallbackGroup = (isolate: boolean) => ({
            recipe: { id: `fallback:staged:${isolate ? 'isolated' : 'district'}`, kind: 'staged-location', body: { request: { ...fallbackRequest, isolate, ...(!isolate && opts.activeArtifact ? { stageIntoActiveScene: true } : {}) } } },
            items: [] as RecoveryItem[]
        });
        const fallbacks = fallbackRequest ? { isolated: fallbackGroup(true), district: fallbackGroup(false) } : undefined;
        const withoutRecipe = (item: RecoveryItem, detail: string) => {
            if (fallbacks && layerNameKey(item.path)) {
                (/_iso_/.test(path.posix.basename(item.path)) ? fallbacks.isolated : fallbacks.district).items.push(item);
                return;
            }
            item.outcome = 'unrecoverable';
            item.detail = detail;
        };
        for (const item of job.items) {
            if (item.outcome !== 'pending') continue;
            const record = this.store.record(item.path);
            if (!record) {
                withoutRecipe(item, 'this file was never recorded in the asset store, so there is no recipe to rebuild it from');
                continue;
            }
            const recipe = record.recipeId ? this.store.recipe(record.recipeId) : undefined;
            if (!recipe) {
                withoutRecipe(item, `recorded from ${record.origin} without a recipe; ask the chat to make it again`);
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
        for (const group of fallbacks ? [fallbacks.isolated, fallbacks.district] : []) {
            if (group.items.length) groups.set(group.recipe.id, group);
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
                    reportProgress: (message, fraction) => { job.message = `${message}${label}`; job.fraction = fraction; },
                    ...(opts.activeArtifact ? { activeArtifact: opts.activeArtifact } : {})
                });
                const produced = new Map<string, string>();
                const urls = new Set<string>([...result.layers.map(l => l.url), ...(result.runId ? this.store.servedByRecipe(`staged:${result.runId}`).map(s => s.path) : [])]);
                // the run's own files first; then files other runs published at the same place (a twin the background
                // texture pass published after an earlier run ended), newest first
                for (const url of [...urls, ...this.publishedAtSamePlace(request, result.runId)]) {
                    const key = layerNameKey(url);
                    if (key && !produced.has(key)) produced.set(key, url);
                }
                for (const item of group.items) {
                    const key = layerNameKey(item.path);
                    const replacement = key ? produced.get(key) : undefined;
                    if (this.store.lookup(item.path)) {
                        item.outcome = 'restored';
                        item.detail = `published again by run ${result.runId}`;
                        this.materialize(item);
                        continue;
                    }
                    if (!replacement || !this.store.lookup(replacement)) {
                        item.outcome = 'failed';
                        item.detail = `run ${result.runId} published no file for this layer (${[...urls].map(u => path.posix.basename(u)).join(', ') || 'nothing'})`;
                        continue;
                    }
                    this.store.alias(item.path, replacement, { origin: 'recovery', rebuilt: true, workspace: this.options.workspaceRoot, recipeId: `staged:${result.runId}` });
                    item.outcome = 'rebuilt';
                    item.detail = `rebuilt by run ${result.runId} as ${path.posix.basename(replacement)}`;
                    this.materialize(item);
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

    /** The recovered file written back to <workspace>/public/models, where the staged build reads kept structure files from. */
    private materialize(item: RecoveryItem): void {
        if (!item.path.startsWith('/models/')) return;
        try {
            this.store.materialize(item.path, path.join(this.options.workspaceRoot, 'public', 'models'));
        } catch (err) {
            item.detail = `${item.detail ?? ''}; not written back to public/models: ${(err as Error).message}`;
        }
    }

    /**
     * Served paths of every staged run recorded at the same place as `request` (within 60 m; or the same query text when
     * neither has coordinates), newest run first, excluding `runId`. Only paths whose bytes are present.
     */
    private publishedAtSamePlace(request: unknown, runId: string): string[] {
        const want = placeOf(request);
        const out: string[] = [];
        for (const recipe of this.store.db.recipesOfKind('staged-location')) {
            if (recipe.id === `staged:${runId}` || recipe.id.startsWith('fallback:')) continue;
            const body = recipe.body as { request?: unknown; place?: unknown } | undefined;
            const theirs = placeOf(body?.place) ?? placeOf(body?.request);
            if (!samePlace(want, theirs)) continue;
            for (const row of this.store.servedByRecipe(recipe.id)) {
                if (this.store.lookup(row.path)) out.push(row.path);
            }
        }
        return out;
    }

    private forgetLater(id: string): void {
        const t = setTimeout(() => this.jobs.delete(id), this.options.keepFinishedMs ?? 10 * 60_000);
        (t as { unref?: () => void }).unref?.();
    }
}

interface PlaceKey { lat?: number; lng?: number; query?: string }

function placeOf(value: unknown): PlaceKey | undefined {
    if (!value || typeof value !== 'object') return undefined;
    const v = value as { lat?: unknown; lng?: unknown; query?: unknown; place?: { lat?: unknown; lng?: unknown } };
    const lat = Number(v.place?.lat ?? v.lat), lng = Number(v.place?.lng ?? v.lng);
    const query = typeof v.query === 'string' ? v.query.trim().toLowerCase() : undefined;
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || (lat === 0 && lng === 0)) return query ? { query } : undefined;
    return { lat, lng, ...(query ? { query } : {}) };
}

function samePlace(a: PlaceKey | undefined, b: PlaceKey | undefined): boolean {
    if (!a || !b) return false;
    if (a.lat !== undefined && b.lat !== undefined && a.lng !== undefined && b.lng !== undefined) {
        const dLat = (a.lat - b.lat) * 111_320;
        const dLng = (a.lng - b.lng) * 111_320 * Math.cos((a.lat * Math.PI) / 180);
        return Math.hypot(dLat, dLng) <= 60;
    }
    return !!a.query && a.query === b.query;
}
