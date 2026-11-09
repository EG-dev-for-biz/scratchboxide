/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Pipeline K-D's chunks built in the cloud (SCRATCHBOX_KD_CHUNK_RUNNER=cloud; plan:
 * docs/research/2026-10-29-kd-cloud-chunk-runner-plan.md): the second implementation of the orchestrator's `runChunk`,
 * beside the local worker thread, and by default the centre cell's too (district-chunks.ts kdCentreRunner: the laptop then only
 * plans, paints, joins and publishes). Each chunk is one Cloud Run job execution (8 vCPU / 32 GiB) running kd-chunk-job.ts:
 *
 *  1. the chunk's request goes to `gs://<bucket>/kd-jobs/<parentRunId>/<chunk>/request.json`, with the run id the chunk
 *     builds under (made here, so its run record is known before it starts);
 *  2. one execution of the job starts with `KD_JOB` pointing at it, and with its share of the model-call budget: this
 *     process's limits (SCRATCHBOX_MODEL_CALLS_*, SCRATCHBOX_MODEL_CALL_BUDGET; model-call-budget.ts) read as the project's
 *     quota and split evenly between the chunks building at once and the centre build;
 *  3. the job's `progress.jsonl` is read every 10 s and its new lines forwarded; a stop cancels the execution;
 *  4. when the execution succeeds, `outcome.json`, every layer GLB the orchestrator joins (kdChunkLayerFiles, already cut to
 *     what the chunk keeps and compacted by the job when the request carried the cut) and the run record are downloaded into this workspace's models folder and run records, the job's paths moved onto this
 *     workspace, so the chunk reads as if it had run here;
 *  5. when it fails, the job's own error (error.json, else the execution's message) is thrown: the orchestrator's
 *     retry-once-then-degrade path takes it. There is no fallback to a local build.
 *
 * A district's chunks run the same code as the laptop's centre build: the job's image is tagged with the commit it was
 * built from, and a run is refused when that is not this checkout's HEAD (SCRATCHBOX_KD_CLOUD_ALLOW_SKEW=1 allows it).
 */

import * as crypto from 'crypto';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import type { StagedLayer } from '../../../common/spatial/staged-location-contracts';
import type { CloudBucket } from '../../cloud-store/cloud-bucket';
import { modelCallLimitsFromEnv, modelCallShareEnv } from '../../gemini/model-call-budget';
import { textureLibraryStatsDir } from '../texture-library';
import { chunkParallel, type KdChunkCutSpec } from './pipeline-k/district-chunks';
import { libraryRepoRoot } from './pipeline-k/material-sets';
import { StagedLocationHardFailure, type StagedLocationOutcome, type StagedLocationRequest, type StageId } from './orchestrator';
import type { StageCache } from './stage-cache';

export const KD_CHUNK_JOB_SCHEMA = 'scratchbox.kd-chunk-job/1';

/** What the runner writes for the job (request.json). */
export interface KdChunkJobSpec {
    schema: typeof KD_CHUNK_JOB_SCHEMA;
    /** The run id the chunk builds under (8 hex digits). */
    runId: string;
    request: StagedLocationRequest;
    /** What the chunk keeps of its layers: the job cuts and compacts them before it sends them (district-chunks.ts cutChunkLayer). */
    cut?: KdChunkCutSpec;
    /** The commit the laptop runs, for the job's record. */
    commit?: string;
    /**
     * The district's later bands (district-chunks.ts kdBandSteps), built by the same task after the first, each in the
     * workspace the one before left, so only the stages their switches change run again: each band's outcome and layers go
     * under `<prefix>/band-<name>/` (kdChunkJobKeys) and its progress line is KD_CHUNK_BAND_LINE.
     */
    bands?: KdChunkBandSpec[];
}

/** One later band of a chunk: its name (B, C, ...), the run id it builds under and its steps. */
export interface KdChunkBandSpec { name: string; runId: string; steps: Record<string, boolean> }

/** What the job writes when the build ends (outcome.json): the outcome and the workspace it was built in. */
export interface KdChunkJobOutcome {
    schema: typeof KD_CHUNK_JOB_SCHEMA;
    runId: string;
    /** The job's workspace root and models folder: their paths in the outcome are moved onto the laptop's. */
    root: string;
    modelsDir: string;
    cacheDir: string;
    outcome: StagedLocationOutcome;
    /** The image's commit (KD_IMAGE_COMMIT). */
    commit?: string;
    ms: number;
    /** The layers as cut by the job, by file name (none when the request asked for no cut). */
    cut?: Record<string, { keptTriangles: number; removedTriangles: number; bytesIn: number; bytesOut: number; droppedBytes: number; ms: number }>;
}

/** What the job writes when the build fails (error.json). */
export interface KdChunkJobError {
    name: string;
    message: string;
    stack?: string;
    stage?: string;
    reasonCode?: string;
}

/** The job's objects, under one prefix a chunk. */
export function kdChunkJobKeys(prefix: string) {
    return {
        request: `${prefix}/request.json`,
        progress: `${prefix}/progress.jsonl`,
        outcome: `${prefix}/outcome.json`,
        error: `${prefix}/error.json`,
        model: (name: string) => `${prefix}/models/${name}`,
        runDir: `${prefix}/run`,
        run: (rel: string) => `${prefix}/run/${rel}`
    };
}

/** A chunk's prefix: `kd-jobs/<parentRunId>/<chunk>`. */
export function kdChunkJobPrefix(request: StagedLocationRequest): string {
    const chunk = request.chunk;
    if (!chunk || !/^[0-9a-f]{8}$/.test(chunk.of) || !Number.isInteger(chunk.index) || chunk.index < 0) {
        throw new Error('the cloud chunk runner builds only district chunks (a request with chunk.of and chunk.index)');
    }
    return `kd-jobs/${chunk.of}/${chunk.index}`;
}

/**
 * The layer GLBs the orchestrator's join opens (orchestrator.ts, the chunks stage): every shown layer except the vector
 * first paint, clay and textured, by file name in the models folder. The job uploads these and the runner downloads them.
 */
export function kdChunkLayerFiles(outcome: StagedLocationOutcome): string[] {
    return kdChunkLayerParts(outcome).map(p => p.name);
}

/** The same files, each with how the join cuts it: trees whole, by connected piece; the rest triangle by triangle. */
export function kdChunkLayerParts(outcome: StagedLocationOutcome): Array<{ name: string; whole: boolean }> {
    const layers = ((outcome.result.artifact as { data?: { stagedBuild?: { layers?: StagedLayer[] } } } | undefined)?.data?.stagedBuild?.layers ?? []);
    const hidden = new Set(layers.filter(l => !l.retired).flatMap(l => l.supersedes));
    const parts = new Map<string, boolean>();
    for (const l of layers) {
        if (l.retired || hidden.has(l.objectId) || l.stage === 'vector') continue;
        parts.set(path.basename(l.url), l.stage === 'trees');
        if (l.textured) parts.set(path.basename(l.textured.url), l.stage === 'trees');
    }
    return [...parts].filter(([n]) => /^[A-Za-z0-9._-]+$/.test(n)).map(([name, whole]) => ({ name, whole }));
}

/** The job's absolute paths in a JSON value moved onto this workspace (its root, models folder and stage cache). */
export function localiseJobPaths<T>(value: T, from: { root: string; modelsDir: string; cacheDir: string }, to: { root: string; modelsDir: string; cacheDir: string }): T {
    const swaps: Array<[string, string]> = ([[from.modelsDir, to.modelsDir], [from.cacheDir, to.cacheDir], [from.root, to.root]] as Array<[string, string]>)
        .filter(([a]) => a && a !== '/')
        .map(([a, b]) => [a.replace(/\/+$/, ''), b.replace(/\/+$/, '')]);
    const swap = (s: string) => {
        for (const [a, b] of swaps) if (s === a || s.startsWith(`${a}/`)) return b + s.slice(a.length);
        return s;
    };
    const walk = (v: unknown): unknown => {
        if (typeof v === 'string') return swap(v);
        if (Array.isArray(v)) return v.map(walk);
        if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
        return v;
    };
    return walk(value) as T;
}

export const KD_LIBRARY_STATS_SCHEMA = 'scratchbox.kd-library-stats/1';

/**
 * The texture library's measured statistics (texture-library.ts, one file a set), sent once a district beside its chunks:
 * a job's image has none, and the material regions would measure every set again in every chunk (about 25 min a build).
 */
export interface KdLibraryStats {
    schema: typeof KD_LIBRARY_STATS_SCHEMA;
    /** The set id and its file, as measured. */
    stats: Record<string, unknown>;
}

/** Where a district's library statistics go: `kd-jobs/<parentRunId>/library-stats.json`. */
export function kdLibraryStatsKey(of: string): string {
    if (!/^[0-9a-f]{8}$/.test(of)) throw new Error(`not a district run id: ${of}`);
    return `kd-jobs/${of}/library-stats.json`;
}

/** The statistics measured in `dir`; undefined when none are (a half-written file is left out). */
export function packLibraryStats(dir: string): KdLibraryStats | undefined {
    let names: string[];
    try { names = fs.readdirSync(dir).filter(n => n.endsWith('.json')); } catch { return undefined; }
    const stats: Record<string, unknown> = {};
    for (const n of names) {
        try { stats[n.slice(0, -5)] = JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8')); } catch { /* measured again where needed */ }
    }
    return Object.keys(stats).length ? { schema: KD_LIBRARY_STATS_SCHEMA, stats } : undefined;
}

/** Writes the statistics into `dir`, each set not already measured there; how many it wrote. */
export function unpackLibraryStats(bundle: KdLibraryStats, dir: string): number {
    if (bundle.schema !== KD_LIBRARY_STATS_SCHEMA) throw new Error(`library statistics this job cannot read (${String(bundle.schema)})`);
    fs.mkdirSync(dir, { recursive: true });
    let written = 0;
    for (const [id, st] of Object.entries(bundle.stats)) {
        if (!/^[A-Za-z0-9._-]+$/.test(id)) continue;
        const file = path.join(dir, `${id}.json`);
        if (fs.existsSync(file)) continue;
        fs.writeFileSync(file, JSON.stringify(st));
        written++;
    }
    return written;
}

/** The lines of a progress log past the first `seen`, and how many lines it now holds (a partial last line waits). */
export function newProgressLines(text: string, seen: number): { lines: string[]; seen: number } {
    const complete = text.endsWith('\n') ? text : text.slice(0, text.lastIndexOf('\n') + 1);
    const all = complete.split('\n').filter(l => l.length);
    const lines: string[] = [];
    for (const raw of all.slice(seen)) {
        try { const m = JSON.parse(raw)?.message; if (typeof m === 'string') lines.push(m); } catch { lines.push(raw); }
    }
    return { lines, seen: Math.max(seen, all.length) };
}

/** Cloud Run's list price in us-central1 (CPU always allocated, tier 1): what an execution of `seconds` costs. */
export const CLOUD_RUN_PRICE = { vcpuSecondUsd: 0.000018, gibSecondUsd: 0.000002 };
export function cloudRunTaskCostUsd(seconds: number, vcpu = 8, memGiB = 32, price = CLOUD_RUN_PRICE): number {
    return Math.max(0, seconds) * (vcpu * price.vcpuSecondUsd + memGiB * price.gibSecondUsd);
}

/** One execution as the runner sees it. */
export interface CloudExecution {
    name: string;
    done: boolean;
    succeeded: boolean;
    /** Why it failed or was cancelled (the execution's condition message). */
    message?: string;
    startMs?: number;
    endMs?: number;
}

/** The Cloud Run job's operations the runner uses (CloudRunJobsRest; a fake under test). */
export interface CloudRunJobs {
    readonly label: string;
    /** The image the job runs (`…/kd-chunk-job:<commit>`). */
    jobImage(): Promise<string>;
    /** Starts one execution with these env overrides; the execution's full name. */
    run(env: Record<string, string>): Promise<string>;
    get(execution: string): Promise<CloudExecution>;
    cancel(execution: string): Promise<void>;
    /**
     * The chunk's outcome is in (its "chunk built" line, or the execution done): a backend holding a machine for it lets
     * the machine go now (VmPoolJobs suspends its VM), so nothing on the machine itself has to.
     */
    finished?(execution: string): Promise<void>;
}

export interface CloudChunkConfig {
    project: string;
    region: string;
    job: string;
    bucket: string;
    /** vCPU and memory of a task (for the cost record; the job's own settings are deploy.sh's). */
    vcpu: number;
    memGiB: number;
    pollMs: number;
    /**
     * How often the job's progress is read between polls of its state (ms; default 2 s, never more than pollMs): its
     * "chunk built" line is seen within this of being sent, not within a whole state poll (10 s a chunk at Penn).
     */
    progressPollMs?: number;
    /** Polls of the execution's state that may fail in a row (the API out of reach a moment) before the chunk is failed. */
    pollMisses: number;
    /** Tries of each download of the job's outcome and layers before the chunk is failed. */
    downloadAttempts: number;
    /** SCRATCHBOX_KD_CLOUD_SERVICE: the chunks go to this Cloud Run service (the warm worker pool, kd-chunk-job.ts --serve), not the job. */
    service?: string;
    /**
     * SCRATCHBOX_KD_CLOUD_SERVICE_REGIONS (comma list): the service in each of these regions, the chunks dealt to them in
     * turn (RoundRobinJobs): 34 chunks building at once in one region built the largest building ~35% slower than alone.
     */
    serviceRegions?: string[];
    /**
     * SCRATCHBOX_KD_CLOUD_VMS (comma list, each `name` or `name@zone`; the zone default SCRATCHBOX_KD_CLOUD_VM_ZONE, else
     * us-central1-a): Compute Engine VMs kept suspended, the fast VMs (VmPoolJobs) the largest chunks are built on (the
     * orchestrator marks them, kdFastChunks). One zone ran out of C3s at 16 (2026-11-09): spread them over several.
     */
    vms?: string[];
    vmZone?: string;
}

/** The runner's settings: SCRATCHBOX_KD_CLOUD_{PROJECT,REGION,JOB,BUCKET}, defaults scoutscan / us-central1 / kd-chunk-job / scoutscan-kd-jobs. */
export function cloudChunkConfig(env: NodeJS.ProcessEnv = process.env): CloudChunkConfig {
    const v = (k: string, d: string) => env[k]?.trim() || d;
    return {
        project: v('SCRATCHBOX_KD_CLOUD_PROJECT', 'scoutscan'),
        region: v('SCRATCHBOX_KD_CLOUD_REGION', 'us-central1'),
        job: v('SCRATCHBOX_KD_CLOUD_JOB', 'kd-chunk-job'),
        bucket: v('SCRATCHBOX_KD_JOB_BUCKET', 'scoutscan-kd-jobs'),
        vcpu: Number(env.SCRATCHBOX_KD_CLOUD_VCPU) > 0 ? Number(env.SCRATCHBOX_KD_CLOUD_VCPU) : 8,
        memGiB: Number(env.SCRATCHBOX_KD_CLOUD_MEM_GIB) > 0 ? Number(env.SCRATCHBOX_KD_CLOUD_MEM_GIB) : 32,
        pollMs: 10_000,
        pollMisses: 12,
        downloadAttempts: 4,
        ...(env.SCRATCHBOX_KD_CLOUD_SERVICE?.trim() ? { service: env.SCRATCHBOX_KD_CLOUD_SERVICE.trim() } : {}),
        ...((r => r.length ? { serviceRegions: r } : {})((env.SCRATCHBOX_KD_CLOUD_SERVICE_REGIONS ?? '').split(',').map(x => x.trim()).filter(x => /^[a-z]+-[a-z]+\d+$/.test(x)))),
        ...((v => v.length ? { vms: v, vmZone: env.SCRATCHBOX_KD_CLOUD_VM_ZONE?.trim() || 'us-central1-a' } : {})((env.SCRATCHBOX_KD_CLOUD_VMS ?? '').split(',').map(x => x.trim()).filter(x => /^[a-z]([-a-z0-9]{0,61}[a-z0-9])?(@[a-z]+-[a-z]+\d+-[a-z])?$/.test(x))))
    };
}

/**
 * The switches a district's runner hands each of its jobs when set here (a measured run: SCRATCHBOX_CACHE_RESTORE=off
 * builds every chunk from nothing, as a fresh district would; SCRATCHBOX_CACHE_MIRROR=off keeps its caches out of the
 * bucket). Nothing else of this machine's environment reaches a job: the job's own settings are deploy.sh's.
 */
export const KD_JOB_FORWARDED_ENV = ['SCRATCHBOX_CACHE_RESTORE', 'SCRATCHBOX_CACHE_MIRROR', 'SCRATCHBOX_MODEL_POOL_URL'] as const;

export function forwardedJobEnv(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
    const out: Record<string, string> = {};
    for (const k of KD_JOB_FORWARDED_ENV) { const v = env[k]?.trim(); if (v) out[k] = v; }
    return out;
}

/** The progress line a job writes once its outcome is in the bucket (kd-chunk-job.ts), before it mirrors its caches. */
export const KD_CHUNK_BUILT_LINE = /^chunk built \(\w+\) in \d+ s$/;
/** How long the runner waits, after a chunk's last band, for its task to say it is done (it mirrors its caches) before letting it go. */
export const KD_TASK_DONE_WAIT_MS = 15 * 60_000;
/** A later band's outcome is in the bucket (`<prefix>/band-<name>/outcome.json`): the band's name is the first group. */
export const KD_CHUNK_BAND_LINE = /^chunk band ([A-Z]) built \(\w+\) in \d+ s$/;
/** A later band failed: the chunk stays at the band before it (the first group names the band). */
export const KD_CHUNK_BAND_FAILED_LINE = /^chunk band ([A-Z]) failed: /;


/** The image tag's commit (`…/kd-chunk-job:<sha>`, or `…@sha256:` which names none). */
export function imageCommit(image: string): string | undefined {
    const m = /:([0-9a-f]{7,40})$/.exec(image);
    return m?.[1];
}

/** Refuses a district whose chunks would run other code than the centre build (unless SCRATCHBOX_KD_CLOUD_ALLOW_SKEW=1). */
export function checkImageSkew(image: string, head: string | undefined, env: NodeJS.ProcessEnv = process.env): void {
    if (env.SCRATCHBOX_KD_CLOUD_ALLOW_SKEW === '1') return;
    const tag = imageCommit(image);
    if (!head) throw new Error('the cloud chunk runner could not read this checkout\'s commit (git rev-parse HEAD); set SCRATCHBOX_KD_CLOUD_ALLOW_SKEW=1 to run anyway');
    if (!tag || !(head.startsWith(tag) || tag.startsWith(head))) {
        throw new Error(`the cloud chunk job runs ${image}, not this checkout's commit ${head.slice(0, 12)}: deploy the image for this commit (deploy/kd-chunk-job/deploy.sh build) or set SCRATCHBOX_KD_CLOUD_ALLOW_SKEW=1`);
    }
}

function gitHead(root: string): string | undefined {
    try { return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return undefined; }
}

const sleep = (ms: number, signal?: AbortSignal) => new Promise<void>((resolve, reject) => {
    if (signal?.aborted) { reject(signal.reason); return; }
    const t = setTimeout(() => { signal?.removeEventListener('abort', stop); resolve(); }, ms);
    const stop = () => { clearTimeout(t); reject(signal!.reason); };
    signal?.addEventListener('abort', stop, { once: true });
});

function abortReason(signal: AbortSignal): Error {
    const r = signal.reason;
    return r instanceof Error ? r : Object.assign(new Error(String(r ?? 'stopped')), { name: 'AbortError' });
}

/** The job's error as the worker thread would have thrown it (a hard failure keeps its stage and reason). */
export function jobError(e: KdChunkJobError | undefined, fallback: string): Error {
    if (!e) return new Error(fallback);
    if (e.name === 'StagedLocationHardFailure') return new StagedLocationHardFailure((e.stage ?? 'resolve') as StageId, e.reasonCode ?? 'failed', e.message);
    return Object.assign(new Error(e.message), { name: e.name });
}

export interface CloudChunkRunnerOptions {
    cache: StageCache;
    bucket: CloudBucket;
    jobs: CloudRunJobs;
    config?: CloudChunkConfig;
    /** This checkout's commit (default `git rev-parse HEAD` where this code lives: the code that runs is what the image must match, wherever the workspace is). */
    head?: () => string | undefined;
    newRunId?: () => string;
    env?: NodeJS.ProcessEnv;
    log?: (message: string) => void;
    /** The texture library's measured statistics sent with each district (default this checkout's, textureLibraryStatsDir). */
    libraryStatsDir?: string;
}

/** `atOnce`: the chunks the orchestrator builds at the same time (default chunkParallel()), for each one's share of the model-call budget. */
export type RunChunk = (request: StagedLocationRequest, opts: { signal?: AbortSignal; onProgress?: (message: string) => void; atOnce?: number; cut?: KdChunkCutSpec; /** One of the district's largest chunks: built on a fast VM when one is free (HybridJobs). */ fast?: boolean; bands?: ChunkBands }) => Promise<StagedLocationOutcome>;

/**
 * The later bands a chunk builds after the first (district-chunks.ts kdBandSteps), and where their outcomes go. The run
 * resolves with the first band's outcome as before; each later band's outcome, its layers already downloaded, is handed to
 * `onBand` as it lands, a band that fails (or never came: the job ended first) to `onFailed`, and `onSettled` is called
 * once, after every band, whatever happened. The task is let go (a fast VM suspended) only then.
 */
export interface ChunkBands {
    specs: Array<{ name: string; steps: Record<string, boolean> }>;
    onBand: (name: string, outcome: StagedLocationOutcome) => Promise<void>;
    onFailed: (name: string, reason: string) => void;
    onSettled: () => void;
}

/** The cloud `runChunk`. The image check runs once, on the first chunk; every chunk fails with its reason when it fails. */
export function createCloudChunkRunner(o: CloudChunkRunnerOptions): RunChunk {
    const config = o.config ?? cloudChunkConfig(o.env);
    const env = o.env ?? process.env;
    const log = o.log ?? ((m: string) => console.log(m));
    let checked: Promise<string> | undefined;
    // a failure to read the image (the API out of reach) is asked again by the next chunk; a skewed image stays refused
    const imageChecked = () => checked ??= o.jobs.jobImage().then(image => {
        checkImageSkew(image, (o.head ?? (() => gitHead(__dirname)))(), env);
        return image;
    }, err => { checked = undefined; throw err; });
    // once a district, before its first chunk starts; a chunk without them measures what it needs itself
    const statsSent = new Map<string, Promise<void>>();
    const libraryStatsSent = (of: string) => {
        let sent = statsSent.get(of);
        if (!sent) {
            sent = (async () => {
                const bundle = packLibraryStats(o.libraryStatsDir ?? textureLibraryStatsDir(libraryRepoRoot()));
                if (!bundle) return;
                fs.mkdirSync(o.cache.dir, { recursive: true });
                const work = fs.mkdtempSync(path.join(o.cache.dir, '.kd-cloud-'));
                try {
                    const file = path.join(work, 'library-stats.json');
                    fs.writeFileSync(file, JSON.stringify(bundle));
                    await o.bucket.putFile(kdLibraryStatsKey(of), file, { contentType: 'application/json' });
                    log(`[kd-cloud] district ${of}: ${Object.keys(bundle.stats).length} measured texture library sets sent`);
                } finally {
                    fs.rmSync(work, { recursive: true, force: true });
                }
            })().catch(err => log(`[kd-cloud] district ${of}: the texture library statistics were not sent (${err instanceof Error ? err.message : String(err)})`));
            statsSent.set(of, sent);
        }
        return sent;
    };

    // the executions that built their chunk, by job prefix: a chunk asked for again after its download failed is not built again
    const built = new Map<string, { execution: string; runId: string; state: CloudExecution }>();
    // a download cut off (the network out of reach a moment, this machine too loaded to keep up) is tried again, after a
    // wait growing with each try, before the chunk fails: the job built it, and building it again costs a whole job
    const download = async (key: string, file: string, signal?: AbortSignal): Promise<boolean> => {
        for (let attempt = 1; ; attempt++) {
            try { return await o.bucket.download(key, file); } catch (err) {
                if (signal?.aborted || attempt >= config.downloadAttempts) throw err;
                log(`[kd-cloud] downloading ${key} failed (${err instanceof Error ? err.message : String(err)}); tried again (${attempt} of ${config.downloadAttempts})`);
                await sleep(config.pollMs * attempt, signal);
            }
        }
    };

    return async (request, opts) => {
        const signal = opts.signal;
        const progress = (m: string) => opts.onProgress?.(m);
        const image = await imageChecked();
        if (signal?.aborted) throw abortReason(signal);
        const prefix = kdChunkJobPrefix(request);
        await libraryStatsSent(request.chunk!.of);
        const keys = kdChunkJobKeys(prefix);
        const newRunId = o.newRunId ?? (() => crypto.randomBytes(4).toString('hex'));
        const runId = built.get(prefix)?.runId ?? newRunId();
        const bandSpecs: KdChunkBandSpec[] | undefined = opts.bands?.specs.length ? opts.bands.specs.map(b => ({ name: b.name, runId: newRunId(), steps: b.steps })) : undefined;
        fs.mkdirSync(o.cache.dir, { recursive: true });
        const work = fs.mkdtempSync(path.join(o.cache.dir, '.kd-cloud-'));
        // the chunk's progress lines, read on from where the first band left them by the follower of the later bands
        const tracker = { dir: fs.mkdtempSync(path.join(o.cache.dir, '.kd-progress-')), seen: 0, builtAtMs: undefined as number | undefined, bandLines: [] as Array<{ name: string; ok: boolean; line: string }> };
        const readProgress = async () => {
            try {
                const file = path.join(tracker.dir, 'progress.jsonl');
                if (!(await o.bucket.download(keys.progress, file))) return;
                const r = newProgressLines(fs.readFileSync(file, 'utf8'), tracker.seen);
                tracker.seen = r.seen;
                for (const l of r.lines) {
                    progress(l);
                    // the outcome is in the bucket: the chunk is read now, while the job mirrors its caches
                    if (tracker.builtAtMs === undefined && KD_CHUNK_BUILT_LINE.test(l)) tracker.builtAtMs = Date.now();
                    const ok = KD_CHUNK_BAND_LINE.exec(l), bad = KD_CHUNK_BAND_FAILED_LINE.exec(l);
                    if (ok) tracker.bandLines.push({ name: ok[1], ok: true, line: l });
                    else if (bad) tracker.bandLines.push({ name: bad[1], ok: false, line: l });
                }
            } catch { /* the next poll reads it */ }
        };
        const tick = Math.min(config.progressPollMs ?? 2_000, config.pollMs);
        // a band's outcome and its layers into this workspace (the first band's and every later one's)
        const fetchOutcome = async (k: ReturnType<typeof kdChunkJobKeys>, short: string | undefined, record: Record<string, unknown>, runIdOf: string, dir: string): Promise<{ outcome: StagedLocationOutcome; bytes: number; downloadMs: number; job: KdChunkJobOutcome }> => {
            const outFile = path.join(dir, 'outcome.json');
            if (!(await download(k.outcome, outFile, signal))) throw new Error(`the cloud chunk job ${short} ended without its outcome (${k.outcome})`);
            const job = JSON.parse(fs.readFileSync(outFile, 'utf8')) as KdChunkJobOutcome;
            if (job.schema !== KD_CHUNK_JOB_SCHEMA || !job.outcome) throw new Error(`the cloud chunk job ${short} wrote an outcome this runner cannot read`);
            const outcome = localiseJobPaths(job.outcome, job, { root: o.cache.workspaceRoot, modelsDir: o.cache.modelsDir, cacheDir: o.cache.dir });
            fs.mkdirSync(o.cache.modelsDir, { recursive: true });
            let bytes = 0;
            const t0 = Date.now();
            for (const name of kdChunkLayerFiles(outcome)) {
                const target = path.join(o.cache.modelsDir, name), tmp = path.join(dir, `model-${name}`);
                if (!(await download(k.model(name), tmp, signal))) throw new Error(`the cloud chunk job ${short} did not upload its layer ${name}`);
                bytes += fs.statSync(tmp).size;
                fs.renameSync(tmp, target);
            }
            const downloadMs = Date.now() - t0;
            await downloadRunRecord(o, k, runIdOf, { ...record, runId: runIdOf, buildMs: job.ms, downloadedBytes: bytes, downloadMs, ...(job.cut ? { cut: job.cut } : {}) });
            return { outcome, bytes, downloadMs, job };
        };
        let following = false;
        try {
            // a chunk whose job already built it (only its download failed) is downloaded again, never built again
            const launch = async (): Promise<{ execution: string; state: CloudExecution }> => {
                // a chunk built again (the orchestrator's retry) starts from no objects of the earlier attempt
                for (const obj of await o.bucket.list(`${prefix}/`)) await o.bucket.remove(obj.key);
                const spec: KdChunkJobSpec = { schema: KD_CHUNK_JOB_SCHEMA, runId, request, ...(opts.cut ? { cut: opts.cut } : {}), ...(imageCommit(image) ? { commit: imageCommit(image) } : {}), ...(bandSpecs ? { bands: bandSpecs } : {}) };
                const specFile = path.join(work, 'request.json');
                fs.writeFileSync(specFile, JSON.stringify(spec));
                await o.bucket.putFile(keys.request, specFile, { contentType: 'application/json' });
                // its share of the project's model calls: one of the chunks at once and the centre beside them; with the district
                // model pool (SCRATCHBOX_MODEL_POOL_URL, model-call-pool.ts) every task takes its turns from the district's one budget
                const pooled = !!env.SCRATCHBOX_MODEL_POOL_URL?.trim();
                const shares = (opts.atOnce ?? chunkParallel(undefined, undefined, env)) + 1;
                const budget: Record<string, string> = pooled ? { SCRATCHBOX_MODEL_POOL_DISTRICT: request.chunk!.of } : modelCallShareEnv(modelCallLimitsFromEnv(env), shares);
                const execution = await o.jobs.run({ KD_JOB: `gs://${config.bucket}/${prefix}`, ...forwardedJobEnv(env), ...budget, ...(opts.fast ? { [KD_FAST_ENV]: '1' } : {}) });
                const short = execution.split('/').pop();
                const kept = Object.entries(budget).map(([k, v]) => `${k}=${v}`).join(' ');
                progress(`started in the cloud (${short}, run ${runId})${pooled ? ', model calls from the district model pool' : kept ? `, model calls kept to 1/${shares} of the budget (${kept})` : ''}`);
                log(`[kd-cloud] chunk ${request.chunk!.index}: execution ${execution}, run ${runId}`);

                let state: CloudExecution | undefined;
                const cancel = () => o.jobs.cancel(execution).catch(e => log(`[kd-cloud] cancelling ${execution} failed: ${e instanceof Error ? e.message : String(e)}`));
                try {
                    // a poll that fails is asked again (a moment's timeout must not fail a job that is still building); after
                    // pollMisses in a row the chunk fails, its execution cancelled so a retry does not run beside it
                    let misses = 0, lastGet = Date.now();
                    while (true) {
                        await sleep(tick, signal);
                        await readProgress();
                        // the state every pollMs, or at once when the outcome is in (its start time is the record's)
                        if (tracker.builtAtMs === undefined && Date.now() - lastGet < config.pollMs) continue;
                        lastGet = Date.now();
                        try {
                            state = await o.jobs.get(execution);
                            misses = 0;
                        } catch (err) {
                            if (signal?.aborted) throw err;
                            if (++misses >= config.pollMisses) { await cancel(); throw err; }
                            log(`[kd-cloud] chunk ${request.chunk!.index}: reading ${short} failed (${err instanceof Error ? err.message : String(err)}); asked again (${misses} of ${config.pollMisses})`);
                            continue;
                        }
                        if (state.done) break;
                        if (tracker.builtAtMs !== undefined) { state = { ...state, done: true, succeeded: true, endMs: tracker.builtAtMs }; break; }
                    }
                    // with later bands to come the task is let go once they are in (the follower below)
                    if (!bandSpecs) await o.jobs.finished?.(execution).catch(e => log(`[kd-cloud] letting ${short} go failed: ${e instanceof Error ? e.message : String(e)}`));
                } catch (err) {
                    if (signal?.aborted) {
                        await cancel();
                        throw abortReason(signal);
                    }
                    throw err;
                }
                await readProgress();
                return { execution, state: state! };
            };
            const earlier = built.get(prefix);
            if (earlier) progress(`its job ${earlier.execution.split('/').pop()} built it already: downloading its layers again`);
            const { execution, state } = earlier ?? await launch();
            const short = execution.split('/').pop();
            const seconds = state.startMs !== undefined && state.endMs !== undefined ? (state.endMs - state.startMs) / 1000 : undefined;
            const cost = seconds !== undefined ? cloudRunTaskCostUsd(seconds, config.vcpu, config.memGiB) : undefined;
            const record = { execution, image, runId, prefix: `gs://${config.bucket}/${prefix}`, succeeded: state.succeeded, ...(state.message ? { message: state.message } : {}), ...(seconds !== undefined ? { seconds, costUsd: cost } : {}) };

            if (!state.succeeded) {
                const errFile = path.join(work, 'error.json');
                let e: KdChunkJobError | undefined;
                try { if (await o.bucket.download(keys.error, errFile)) e = JSON.parse(fs.readFileSync(errFile, 'utf8')); } catch { /* the execution's message stands */ }
                await downloadRunRecord(o, keys, runId, record).catch(() => undefined);
                throw jobError(e, `the cloud chunk job ${short} failed: ${state.message ?? 'no message'}`);
            }

            built.set(prefix, { execution, runId, state });
            const got = await fetchOutcome(keys, short, record, runId, work);
            progress(`built in the cloud in ${seconds !== undefined ? `${Math.round(seconds)} s` : 'an unknown time'}${cost !== undefined ? ` (about $${cost.toFixed(2)})` : ''}, ${(got.bytes / 1e6).toFixed(0)} MB of layers downloaded in ${(got.downloadMs / 1000).toFixed(1)} s${got.job.cut ? ', cut and compacted by the job' : ''}`);
            // the later bands, read as their lines come; the first band's outcome goes back now
            if (bandSpecs && opts.bands && !earlier) {
                following = true;
                const bands = opts.bands;
                void (async () => {
                    const pending = new Set(bandSpecs.map(b => b.name));
                    const dir = fs.mkdtempSync(path.join(o.cache.dir, '.kd-band-'));
                    try {
                        let lastGet = Date.now();
                        while (pending.size) {
                            if (signal?.aborted) { for (const n of pending) bands.onFailed(n, 'the build was stopped'); return; }
                            await sleep(tick, signal).catch(() => undefined);
                            await readProgress();
                            for (const ev of tracker.bandLines.splice(0)) {
                                if (!pending.has(ev.name)) continue;
                                pending.delete(ev.name);
                                if (!ev.ok) { bands.onFailed(ev.name, ev.line.replace(/^chunk band [A-Z] failed: /, '')); for (const n of pending) bands.onFailed(n, `band ${ev.name} failed before it`); pending.clear(); break; }
                                const spec = bandSpecs.find(b => b.name === ev.name)!;
                                try {
                                    const b = await fetchOutcome(kdChunkJobKeys(`${prefix}/band-${ev.name}`), short, { ...record, band: ev.name }, spec.runId, dir);
                                    progress(`band ${ev.name}: ${(b.bytes / 1e6).toFixed(0)} MB of layers downloaded in ${(b.downloadMs / 1000).toFixed(1)} s`);
                                    await bands.onBand(ev.name, b.outcome);
                                } catch (err) {
                                    bands.onFailed(ev.name, err instanceof Error ? err.message : String(err));
                                }
                            }
                            if (pending.size && Date.now() - lastGet >= config.pollMs) {
                                lastGet = Date.now();
                                const st = await o.jobs.get(execution).catch(() => undefined);
                                // the task ended: read its last lines once more, then whatever never came failed
                                if (st?.done && !st.succeeded) {
                                    await readProgress();
                                    if (!tracker.bandLines.length) { for (const n of pending) bands.onFailed(n, `the task ended before band ${n} (${st.message ?? 'no message'})`); pending.clear(); }
                                }
                            }
                        }
                    } finally {
                        // the task mirrors its caches (the model readings among them) after its last band: it is let go once it says
                        // it is done (a fast VM's done.json releases it), or after KD_TASK_DONE_WAIT_MS
                        const until = Date.now() + KD_TASK_DONE_WAIT_MS;
                        while (!signal?.aborted && Date.now() < until) {
                            const st = await o.jobs.get(execution).catch(() => undefined);
                            if (st?.done) break;
                            await sleep(config.pollMs, signal).catch(() => undefined);
                        }
                        await o.jobs.finished?.(execution).catch(e => log(`[kd-cloud] letting ${short} go failed: ${e instanceof Error ? e.message : String(e)}`));
                        fs.rmSync(dir, { recursive: true, force: true });
                        fs.rmSync(tracker.dir, { recursive: true, force: true });
                        bands.onSettled();
                    }
                })();
            } else if (opts.bands) {
                for (const b of opts.bands.specs) opts.bands.onFailed(b.name, 'the chunk was downloaded again from an earlier task, with no later bands');
                opts.bands.onSettled();
            }
            return got.outcome;
        } finally {
            fs.rmSync(work, { recursive: true, force: true });
            if (!following) fs.rmSync(tracker.dir, { recursive: true, force: true });
        }
    };
}

/** The chunk's run record into this workspace's run records (runs/<runId>/), with what the cloud did beside it (cloud-job.json). */
async function downloadRunRecord(o: CloudChunkRunnerOptions, keys: ReturnType<typeof kdChunkJobKeys>, runId: string, record: Record<string, unknown>): Promise<void> {
    const dir = path.dirname(o.cache.runRecordPath(runId));
    fs.mkdirSync(dir, { recursive: true });
    const base = `${keys.runDir}/`;
    for (const obj of await o.bucket.list(base)) {
        const rel = obj.key.slice(base.length);
        if (!rel || rel.split('/').some(p => !p || p === '.' || p === '..')) continue;
        const file = path.join(dir, ...rel.split('/'));
        fs.mkdirSync(path.dirname(file), { recursive: true });
        await o.bucket.download(obj.key, file);
    }
    fs.writeFileSync(path.join(dir, 'cloud-job.json'), JSON.stringify(record, null, 1));
}

/**
 * The Cloud Run Admin API (v2) on the app's service account: the job's image, an execution started with env overrides,
 * its state, its cancel. The account needs roles/run.developer on the job and iam.serviceAccountUser on the job's account.
 */
export class CloudRunJobsRest implements CloudRunJobs {
    readonly label: string;
    private readonly jobName: string;

    constructor(private readonly config: CloudChunkConfig, private readonly request: <T>(opts: { url: string; method: 'GET' | 'POST'; data?: unknown }) => Promise<T>) {
        this.jobName = `projects/${config.project}/locations/${config.region}/jobs/${config.job}`;
        this.label = `run.googleapis.com/${this.jobName}`;
    }

    /** With the service account the app finds (GoogleMediaCredentialsService), as the rest of the build authenticates. */
    static async create(config: CloudChunkConfig): Promise<CloudRunJobsRest> {
        const { GoogleAuth } = await import('google-auth-library');
        const { GoogleMediaCredentialsService } = await import('../../google-media-credentials-service');
        let authOptions: Record<string, unknown> = {};
        try { authOptions = ((await new GoogleMediaCredentialsService().getVertexAuth()).googleAuthOptions ?? {}) as Record<string, unknown>; } catch { /* application default credentials */ }
        const auth = new GoogleAuth({ ...authOptions, scopes: ['https://www.googleapis.com/auth/cloud-platform'] });
        const client = await auth.getClient();
        return new CloudRunJobsRest(config, async <T>(opts: { url: string; method: 'GET' | 'POST'; data?: unknown }) => (await client.request<T>({ ...opts, ...(opts.data !== undefined ? { data: opts.data } : {}) })).data);
    }

    async jobImage(): Promise<string> {
        const job = await this.request<{ template?: { template?: { containers?: Array<{ image?: string }> } } }>({ url: `https://run.googleapis.com/v2/${this.jobName}`, method: 'GET' });
        const image = job.template?.template?.containers?.[0]?.image;
        if (!image) throw new Error(`${this.label} has no container image`);
        return image;
    }

    async run(env: Record<string, string>): Promise<string> {
        const op = await this.request<{ metadata?: { name?: string } }>({
            url: `https://run.googleapis.com/v2/${this.jobName}:run`, method: 'POST',
            data: { overrides: { containerOverrides: [{ env: Object.entries(env).map(([name, value]) => ({ name, value })) }], taskCount: 1 } }
        });
        const name = op.metadata?.name;
        if (!name) throw new Error(`${this.label}: the run answered no execution`);
        return name;
    }

    async get(execution: string): Promise<CloudExecution> {
        return parseExecution(await this.request<CloudRunExecutionJson>({ url: `https://run.googleapis.com/v2/${execution}`, method: 'GET' }));
    }

    async cancel(execution: string): Promise<void> {
        await this.request({ url: `https://run.googleapis.com/v2/${execution}:cancel`, method: 'POST', data: {} });
    }
}

/**
 * The same operations on a Cloud Run service running the chunk build (kd-chunk-job.ts --serve): the warm worker pool, kept
 * at zero instances between districts. `run` sends one chunk (the env a job execution would take as overrides) and returns
 * at once; the chunk is done when the service answers (its result comes last, after the caches are mirrored; the runner
 * itself moves on at the job's "chunk built" line, as with a job). `cancel` drops the request, which stops the build.
 * startMs is when the chunk was sent: a service instance's start is part of the chunk's time here, as a task's is not.
 */
export class CloudRunServiceJobs implements CloudRunJobs {
    readonly label: string;
    private readonly serviceName: string;
    private readonly sent = new Map<string, { abort: AbortController; startMs: number; endMs?: number; ok?: boolean; message?: string }>();
    private n = 0;

    constructor(private readonly config: CloudChunkConfig, private readonly request: <T>(opts: { url: string; method: 'GET' | 'POST'; data?: unknown }) => Promise<T>,
        private readonly post: (url: string, body: unknown, signal: AbortSignal) => Promise<{ ok: boolean; error?: string }>, private readonly now: () => number = Date.now) {
        this.serviceName = `projects/${config.project}/locations/${config.region}/services/${config.service}`;
        this.label = `run.googleapis.com/${this.serviceName}`;
    }

    /** With the app's service account: the Admin API as CloudRunJobsRest has it, the service called with an ID token for its URL. */
    static async create(config: CloudChunkConfig): Promise<CloudRunServiceJobs> {
        const { GoogleAuth } = await import('google-auth-library');
        const { GoogleMediaCredentialsService } = await import('../../google-media-credentials-service');
        let authOptions: Record<string, unknown> = {};
        try { authOptions = ((await new GoogleMediaCredentialsService().getVertexAuth()).googleAuthOptions ?? {}) as Record<string, unknown>; } catch { /* application default credentials */ }
        const auth = new GoogleAuth({ ...authOptions, scopes: ['https://www.googleapis.com/auth/cloud-platform'] });
        const client = await auth.getClient();
        const request = async <T>(opts: { url: string; method: 'GET' | 'POST'; data?: unknown }) => (await client.request<T>({ ...opts, ...(opts.data !== undefined ? { data: opts.data } : {}) })).data;
        let idClient: Awaited<ReturnType<typeof auth.getIdTokenClient>> | undefined;
        const post = async (url: string, body: unknown, signal: AbortSignal) => {
            idClient ??= await auth.getIdTokenClient(new URL(url).origin);
            const h = await idClient.getRequestHeaders() as unknown as { get?: (k: string) => string | null } & Record<string, string>;
            const authorization = typeof h.get === 'function' ? h.get('authorization') ?? '' : h.Authorization ?? h.authorization ?? '';
            return postChunk(() => fetch(url, { method: 'POST', headers: { authorization, 'content-type': 'application/json' }, body: JSON.stringify(body), signal }), signal);
        };
        return new CloudRunServiceJobs(config, request, post);
    }

    private async service(): Promise<{ uri?: string; template?: { containers?: Array<{ image?: string }> } }> {
        return this.request({ url: `https://run.googleapis.com/v2/${this.serviceName}`, method: 'GET' });
    }

    async jobImage(): Promise<string> {
        const image = (await this.service()).template?.containers?.[0]?.image;
        if (!image) throw new Error(`${this.label} has no container image`);
        return image;
    }

    async run(env: Record<string, string>): Promise<string> {
        const uri = (await this.service()).uri;
        if (!uri) throw new Error(`${this.label} has no URL`);
        const name = `${this.serviceName}/chunks/${++this.n}-${env.KD_JOB?.split('/').slice(-2).join('-') ?? 'chunk'}`;
        const entry = { abort: new AbortController(), startMs: this.now() } as { abort: AbortController; startMs: number; endMs?: number; ok?: boolean; message?: string };
        this.sent.set(name, entry);
        this.post(`${uri}/chunk`, { env }, entry.abort.signal).then(
            r => { entry.ok = r.ok; entry.endMs = this.now(); if (!r.ok) entry.message = r.error ?? 'the worker did not send the chunk\'s outcome'; },
            err => { entry.ok = false; entry.endMs = this.now(); entry.message = entry.abort.signal.aborted ? 'cancelled' : (err instanceof Error ? err.message : String(err)); }
        );
        return name;
    }

    async get(execution: string): Promise<CloudExecution> {
        const e = this.sent.get(execution);
        if (!e) throw new Error(`${this.label}: no chunk ${execution} was sent from here`);
        const done = e.endMs !== undefined;
        return { name: execution, done, succeeded: done && !!e.ok, ...(e.message ? { message: e.message } : {}), startMs: e.startMs, ...(done ? { endMs: e.endMs } : {}) };
    }

    async cancel(execution: string): Promise<void> {
        this.sent.get(execution)?.abort.abort();
    }
}

/** The keys of a VM's assignment and its answer in the job bucket (kd-chunk-job.ts --poll reads and writes them). */
export function kdVmKeys(vmIn: string): { assign: string; done: string } {
    const vm = vmIn.split('@')[0];
    if (!/^[a-z]([-a-z0-9]{0,61}[a-z0-9])?$/.test(vm)) throw new Error(`not a VM name: ${vmIn}`);
    return { assign: `kd-vm/${vm}/assign.json`, done: `kd-vm/${vm}/done.json` };
}

/** The mark run() reads to send a chunk to the fast VMs (HybridJobs); never passed on to a build. */
export const KD_FAST_ENV = 'KD_FAST';

/** The Compute Engine API calls VmPoolJobs makes (a fake under test). */
export interface ComputeVms {
    status(vm: string): Promise<string>;
    resume(vm: string): Promise<void>;
    suspend(vm: string): Promise<void>;
    /** The image the VM's worker runs (its `kd-image` metadata). */
    image(vm: string): Promise<string | undefined>;
}

/**
 * The fast VMs (kd-chunk-job.ts --poll): Compute Engine VMs kept suspended between districts, each building one chunk at
 * a time. `tryRun` writes a free VM's assignment, resumes it (about 14 s) and returns undefined when every VM is busy; a
 * chunk is done when its VM writes done.json, and the VM is then suspended again. A C3 built Penn's largest building in
 * 149 s, as fast as a Cloud Run job task, where a Cloud Run service instance took 193-211 s (2026-11-09).
 */
export class VmPoolJobs implements CloudRunJobs {
    readonly label: string;
    private readonly busy = new Map<string, string>();
    private readonly sent = new Map<string, { vm: string; job: string; startMs: number; endMs?: number; ok?: boolean; message?: string }>();
    private n = 0;

    constructor(private readonly vms: string[], private readonly compute: ComputeVms, private readonly bucket: CloudBucket, private readonly workDir: string,
        private readonly log: (m: string) => void = () => undefined, private readonly now: () => number = Date.now, private readonly settleMs = 5_000) {
        this.label = `compute VMs ${vms.join(', ')}`;
    }

    /** With the app's service account, as CloudRunJobsRest has it. */
    static async create(config: CloudChunkConfig, bucket: CloudBucket, workDir: string, log?: (m: string) => void): Promise<VmPoolJobs> {
        const { GoogleAuth } = await import('google-auth-library');
        const { GoogleMediaCredentialsService } = await import('../../google-media-credentials-service');
        let authOptions: Record<string, unknown> = {};
        try { authOptions = ((await new GoogleMediaCredentialsService().getVertexAuth()).googleAuthOptions ?? {}) as Record<string, unknown>; } catch { /* application default credentials */ }
        const client = await new GoogleAuth({ ...authOptions, scopes: ['https://www.googleapis.com/auth/cloud-platform'] }).getClient();
        // a VM is `name` (in the default zone) or `name@zone`
        const at = (vm: string) => { const [name, zone] = vm.split('@'); return `https://compute.googleapis.com/compute/v1/projects/${config.project}/zones/${zone || config.vmZone || 'us-central1-a'}/instances/${name}`; };
        const get = async (vm: string) => (await client.request<{ status?: string; metadata?: { items?: Array<{ key: string; value?: string }> } }>({ url: at(vm), method: 'GET' })).data;
        const compute: ComputeVms = {
            status: async vm => (await get(vm)).status ?? 'UNKNOWN',
            resume: async vm => { await client.request({ url: `${at(vm)}/resume`, method: 'POST' }); },
            suspend: async vm => { await client.request({ url: `${at(vm)}/suspend`, method: 'POST' }); },
            image: async vm => (await get(vm)).metadata?.items?.find(i => i.key === 'kd-image')?.value
        };
        return new VmPoolJobs(config.vms ?? [], compute, bucket, workDir, log);
    }

    async jobImage(): Promise<string> {
        const images = await Promise.all(this.vms.map(vm => this.compute.image(vm)));
        if (images.some(i => !i)) throw new Error(`${this.label}: a VM names no kd-image (deploy.sh vms sets it)`);
        const other = images.findIndex(i => i !== images[0]);
        if (other > 0) throw new Error(`${this.vms[other]} runs ${images[other]}, not ${images[0]}: create the VMs again from one image`);
        return images[0]!;
    }

    /** Free VMs. */
    free(): number { return this.vms.filter(v => !this.busy.has(v)).length; }

    async tryRun(env: Record<string, string>): Promise<string | undefined> {
        const vm = this.vms.find(v => !this.busy.has(v));
        if (!vm) return undefined;
        const name = `vm/${vm}/${++this.n}`;
        this.busy.set(vm, name);
        const keys = kdVmKeys(vm);
        try {
            await this.bucket.remove(keys.done);
            const file = path.join(this.workDir, `assign-${vm}-${this.n}.json`);
            fs.mkdirSync(this.workDir, { recursive: true });
            fs.writeFileSync(file, JSON.stringify({ env }));
            await this.bucket.putFile(keys.assign, file, { contentType: 'application/json' });
            fs.rmSync(file, { force: true });
            this.sent.set(name, { vm, job: env.KD_JOB, startMs: this.now() });
            await this.wake(vm);
        } catch (err) {
            this.busy.delete(vm);
            this.sent.delete(name);
            throw err;
        }
        return name;
    }

    /** A suspended VM resumed; one still suspending waited for first; one running left as it is. */
    private async wake(vm: string): Promise<void> {
        for (let tries = 0; ; tries++) {
            const st = await this.compute.status(vm);
            if (st === 'RUNNING') return;
            if (st === 'SUSPENDED') { await this.compute.resume(vm); this.log(`[kd-vm] ${vm} resumed`); return; }
            if (tries > 120) throw new Error(`${vm} is ${st}: it could not be resumed`);
            await new Promise(r => setTimeout(r, this.settleMs));
        }
    }

    async run(env: Record<string, string>): Promise<string> {
        const name = await this.tryRun(env);
        if (!name) throw new Error(`${this.label}: every VM is building`);
        return name;
    }

    async get(execution: string): Promise<CloudExecution> {
        const e = this.sent.get(execution);
        if (!e) throw new Error(`${this.label}: no chunk ${execution} was sent from here`);
        if (e.endMs === undefined) {
            // a VM found suspended with its chunk unfinished (a suspend that reached it late) is resumed: the build goes on
            try {
                if (await this.compute.status(e.vm) === 'SUSPENDED') { this.log(`[kd-vm] ${e.vm} was suspended mid-chunk: resumed`); await this.compute.resume(e.vm); }
            } catch (err) {
                this.log(`[kd-vm] reading ${e.vm}: ${err instanceof Error ? err.message : String(err)}`);
            }
            const file = path.join(this.workDir, `done-${e.vm}.json`);
            if (await this.bucket.download(kdVmKeys(e.vm).done, file)) {
                const d = JSON.parse(fs.readFileSync(file, 'utf8')) as { ok?: boolean; job?: string; error?: string };
                fs.rmSync(file, { force: true });
                if (d.job === e.job) {
                    e.endMs = this.now(); e.ok = d.ok === true;
                    if (!e.ok) e.message = d.error ?? 'the VM did not send the chunk\'s outcome';
                    await this.release(e.vm, execution);
                }
            }
        }
        const done = e.endMs !== undefined;
        return { name: execution, done, succeeded: done && !!e.ok, ...(e.message ? { message: e.message } : {}), startMs: e.startMs, ...(done ? { endMs: e.endMs } : {}) };
    }

    /**
     * The VM's suspend asked (awaited: the call returns once Compute Engine has the operation, the suspend itself takes
     * minutes; a driver that exited before an unawaited call went out left 32 VMs running, 2026-11-09) and the VM free.
     */
    private async release(vm: string, execution: string): Promise<void> {
        if (this.busy.get(vm) !== execution) return;
        this.busy.delete(vm);
        try { await this.compute.suspend(vm); this.log(`[kd-vm] ${vm} suspending`); } catch (err) { this.log(`[kd-vm] suspending ${vm} failed: ${err instanceof Error ? err.message : String(err)}`); }
    }

    /**
     * The chunk's outcome is read: its VM suspended now, by this runner alone. The worker no longer suspends itself after a
     * chunk: its request could reach Compute Engine after the next district had resumed the VM (a resume at 10:09:02, the
     * old worker's suspend at 10:09:43, the new worker frozen at its start and its chunk never built, 2026-11-09).
     */
    async finished(execution: string): Promise<void> {
        const e = this.sent.get(execution);
        if (!e) return;
        if (e.endMs === undefined) { e.endMs = this.now(); e.ok = true; }
        await this.release(e.vm, execution);
    }

    async cancel(execution: string): Promise<void> {
        const e = this.sent.get(execution);
        if (!e) return;
        await this.bucket.remove(kdVmKeys(e.vm).assign).catch(() => undefined);
        e.endMs = this.now(); e.ok = false; e.message = 'cancelled';
        await this.release(e.vm, execution);
    }
}

/**
 * The largest chunks (marked KD_FAST by the runner, from the orchestrator's kdFastChunks) on the fast VMs while one is
 * free, every other chunk, and a marked one with no VM free, on `rest` (the Cloud Run pool).
 */
export class HybridJobs implements CloudRunJobs {
    readonly label: string;
    private readonly owner = new Map<string, CloudRunJobs>();

    constructor(private readonly fast: VmPoolJobs, private readonly rest: CloudRunJobs) {
        this.label = `${fast.label} + ${rest.label}`;
    }

    async jobImage(): Promise<string> {
        const [a, b] = await Promise.all([this.fast.jobImage(), this.rest.jobImage()]);
        if (a !== b) throw new Error(`the fast VMs run ${a} and ${this.rest.label} ${b}: deploy one image to both`);
        return a;
    }

    async run(envIn: Record<string, string>): Promise<string> {
        const { [KD_FAST_ENV]: fast, ...env } = envIn;
        const onVm = fast === '1' ? await this.fast.tryRun(env) : undefined;
        if (onVm) { this.owner.set(onVm, this.fast); return onVm; }
        const name = await this.rest.run(env);
        this.owner.set(name, this.rest);
        return name;
    }

    async get(execution: string): Promise<CloudExecution> {
        const b = this.owner.get(execution);
        if (!b) throw new Error(`${this.label}: no chunk ${execution} was sent from here`);
        return b.get(execution);
    }

    async cancel(execution: string): Promise<void> {
        await this.owner.get(execution)?.cancel(execution);
    }

    async finished(execution: string): Promise<void> {
        await this.owner.get(execution)?.finished?.(execution);
    }
}

/**
 * Several backends (the pool's service in several regions) as one: each chunk goes to the next in turn, in the order the
 * chunks are started (the largest first, orchestrator.ts), and is read and cancelled where it went. Every backend must run
 * the same image, or none is used.
 */
export class RoundRobinJobs implements CloudRunJobs {
    readonly label: string;
    private next = 0;
    private readonly owner = new Map<string, CloudRunJobs>();

    constructor(private readonly backends: CloudRunJobs[]) {
        if (!backends.length) throw new Error('RoundRobinJobs needs at least one backend');
        this.label = backends.map(b => b.label).join(' + ');
    }

    async jobImage(): Promise<string> {
        const images = await Promise.all(this.backends.map(b => b.jobImage()));
        const other = images.findIndex(i => i !== images[0]);
        if (other > 0) throw new Error(`${this.backends[other].label} runs ${images[other]}, not ${images[0]}: deploy one image to every region`);
        return images[0];
    }

    async run(env: Record<string, string>): Promise<string> {
        const b = this.backends[this.next++ % this.backends.length];
        const name = await b.run(env);
        this.owner.set(name, b);
        return name;
    }

    async get(execution: string): Promise<CloudExecution> {
        const b = this.owner.get(execution);
        if (!b) throw new Error(`${this.label}: no chunk ${execution} was sent from here`);
        return b.get(execution);
    }

    async cancel(execution: string): Promise<void> {
        await this.owner.get(execution)?.cancel(execution);
    }

    async finished(execution: string): Promise<void> {
        await this.owner.get(execution)?.finished?.(execution);
    }
}

/** Statuses the pool answers while it scales (no instance yet, or one already busy): the chunk is sent again. */
export const SERVICE_RETRY_STATUS = new Set([429, 500, 502, 503, 504]);
/** Tries of each chunk's request to the pool (backing off 2, 4, 8, ... s). */
export const SERVICE_POST_ATTEMPTS = 6;

/**
 * One chunk's request to the pool: the pool scaling from zero under a burst can answer 503 (no instance yet), 429, or drop
 * the connection before answering; each is asked again after 2, 4, 8, ... s (SERVICE_POST_ATTEMPTS in all), never taken
 * for a failed chunk (a 503 at Penn's burst left a chunk to the retry after every other, 2026-11-09).
 */
export async function postChunk(send: () => Promise<{ ok: boolean; status: number; text(): Promise<string> }>, signal: AbortSignal, sleep: (ms: number) => Promise<void> = ms => new Promise(r => setTimeout(r, ms))): Promise<{ ok: boolean; error?: string }> {
    for (let attempt = 1; ; attempt++) {
        let res: { ok: boolean; status: number; text(): Promise<string> };
        try {
            res = await send();
        } catch (err) {
            if (signal.aborted || attempt >= SERVICE_POST_ATTEMPTS) throw err;
            await sleep(1_000 * 2 ** attempt);
            continue;
        }
        if (SERVICE_RETRY_STATUS.has(res.status) && attempt < SERVICE_POST_ATTEMPTS) {
            await res.text().catch(() => '');
            await sleep(1_000 * 2 ** attempt);
            continue;
        }
        const text = await res.text();
        if (!res.ok) return { ok: false, error: `the worker answered ${res.status}: ${text.slice(0, 300)}` };
        return parseServiceAnswer(text);
    }
}

/** The worker's answer: heartbeat newlines, then one JSON line `{ ok, ms, error? }`. */
export function parseServiceAnswer(text: string): { ok: boolean; error?: string } {
    const last = text.split('\n').map(l => l.trim()).filter(Boolean).pop();
    if (!last) return { ok: false, error: 'the worker answered nothing' };
    try {
        const r = JSON.parse(last) as { ok?: boolean; error?: string };
        return { ok: r.ok === true, ...(r.error ? { error: r.error } : {}) };
    } catch {
        return { ok: false, error: `the worker's answer is not JSON: ${last.slice(0, 200)}` };
    }
}

/** The fields of a v2 Execution the runner reads. */
export interface CloudRunExecutionJson {
    name: string;
    startTime?: string;
    completionTime?: string;
    succeededCount?: number;
    failedCount?: number;
    cancelledCount?: number;
    conditions?: Array<{ type?: string; state?: string; message?: string; reason?: string }>;
}

/** An execution is done once it has a completion time; it succeeded when its one task did. */
export function parseExecution(e: CloudRunExecutionJson): CloudExecution {
    const done = !!e.completionTime;
    const succeeded = done && (e.succeededCount ?? 0) >= 1 && !(e.failedCount ?? 0) && !(e.cancelledCount ?? 0);
    const completed = e.conditions?.find(c => c.type === 'Completed');
    const message = !succeeded ? (completed?.message || e.conditions?.find(c => c.state === 'CONDITION_FAILED')?.message || ((e.cancelledCount ?? 0) ? 'cancelled' : undefined)) : undefined;
    const t = (s?: string) => { const v = s ? Date.parse(s) : NaN; return Number.isFinite(v) ? v : undefined; };
    const startMs = t(e.startTime), endMs = t(e.completionTime);
    return { name: e.name, done, succeeded, ...(message ? { message } : {}), ...(startMs !== undefined ? { startMs } : {}), ...(endMs !== undefined ? { endMs } : {}) };
}
