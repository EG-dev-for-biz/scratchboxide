/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * One pipeline K-D chunk built in a Cloud Run job (the job side of cloud-chunk-runner.ts). `KD_JOB=gs://<bucket>/<prefix>`
 * names the chunk's objects: it reads request.json, builds the chunk with the same services a worker thread makes
 * (createStagedLocationDeps) under the run id the runner chose, appends each progress line to progress.jsonl (sent every
 * 5 s), then sends the layer GLBs the orchestrator joins (each cut to what the chunk keeps, placed in the district's frame
 * and compacted, when the request carries the cut and the frame is known: district-chunks.ts cutChunkLayer; the centre
 * job publishes the frame for the others as soon as its tiles are in), the run record and outcome.json, and last the build's caches to the
 * training bucket's cache/v1/ (cache-mirror.ts syncCacheDir, as a laptop build does). A failed build writes error.json.
 * The exit code is 0 only once outcome.json is sent. Cloud Run's cancel (SIGTERM) stops the build.
 *
 * `--warm` builds the native engines the chunk runs, at image build time (deploy/kd-chunk-job/Dockerfile), so a task never
 * waits on clang; it exits non-zero when one does not build.
 *
 * `--serve` runs the same chunk build as a Cloud Run service (the warm worker pool; cloud-chunk-runner.ts
 * CloudRunServiceJobs): POST /chunk with `{ env }` (KD_JOB and the runner's switches, as a job execution's overrides) builds
 * one chunk exactly as a job task does, the instance's workspace put back as the image left it first, so a reused warm
 * instance builds from nothing as a new one would. The answer's headers go at once and a newline every 20 s, the result
 * last (`{ ok, ms }`), and only once the caches are mirrored, so with request-based billing nothing runs unbilled after it.
 * One chunk an instance at a time (the service's concurrency 1; a second request is answered 429), and by default one chunk
 * an instance at all: the worker exits once it has answered (SCRATCHBOX_KD_SERVE_ONCE=0 keeps it), so every chunk builds in
 * a new process on a clean instance, as a job task does. A reused instance gave the same bytes but built the largest
 * building about twice as slowly (its native steps 2x, Penn 2026-11-09), while a new service instance started in about 8 s
 * (a Cloud Run job task took 90 s).
 */

import * as fs from 'fs';
import * as path from 'path';
import type { CloudBucket } from '../../cloud-store/cloud-bucket';
import { CACHE_MIRROR_PARAMS, cacheMirrorRoots, syncCacheDir } from '../../cloud-store/cache-mirror';
import { textureLibraryStatsDir } from '../texture-library';
import { KD_CHUNK_JOB_SCHEMA, kdChunkJobKeys, kdChunkLayerParts, kdLibraryStatsKey, unpackLibraryStats, type KdChunkJobError, type KdChunkJobOutcome, type KdChunkJobSpec, type KdLibraryStats } from './cloud-chunk-runner';
import { cutChunkLayer, kdDistrictFrameKey, type TileFrame } from './pipeline-k/district-chunks';
import { libraryRepoRoot } from './pipeline-k/material-sets';
import type { StagedLocationContext, StagedLocationOutcome } from './orchestrator';
import type { StageCache } from './stage-cache';

export interface KdChunkJobOptions {
    bucket: CloudBucket;
    /** The chunk's prefix in the bucket (kd-jobs/<parentRunId>/<chunk>). */
    prefix: string;
    /** The job's stage cache (its workspace root, models folder and run records). */
    cache: StageCache;
    /** The build: runStagedLocation with the app's services, under `spec.runId`. */
    build: (spec: KdChunkJobSpec, ctx: Pick<StagedLocationContext, 'signal' | 'reportProgress' | 'onFrame'>) => Promise<StagedLocationOutcome>;
    /** Where the caches are mirrored (the training bucket); none, none sent. */
    mirror?: CloudBucket;
    signal?: AbortSignal;
    /** progress.jsonl is sent this often (ms). */
    flushMs?: number;
    commit?: string;
    log?: (message: string) => void;
    now?: () => number;
    /** Where the district's measured texture library statistics go (default the image's, textureLibraryStatsDir). */
    libraryStatsDir?: string;
    /** How long a chunk waits, once built, for the centre job to publish the district's frame before it sends its layers uncut (ms), and how often it looks. */
    frameWaitMs?: number;
    framePollMs?: number;
}

/** A chunk built in the cloud waits at most this long for the district's frame (the centre job has it minutes into its build). */
export const KD_FRAME_WAIT_MS = 10 * 60_000;

/** Builds the chunk and sends what the runner reads. True when outcome.json was sent. */
export async function runKdChunkJob(o: KdChunkJobOptions): Promise<boolean> {
    const log = o.log ?? ((m: string) => console.log(m));
    const now = o.now ?? Date.now;
    const keys = kdChunkJobKeys(o.prefix);
    fs.mkdirSync(o.cache.dir, { recursive: true });
    const work = fs.mkdtempSync(path.join(path.dirname(o.cache.dir), '.kd-job-'));
    const progressFile = path.join(work, 'progress.jsonl');
    fs.writeFileSync(progressFile, '');
    let flushing: Promise<unknown> = Promise.resolve(), dirty = false;
    const flush = () => {
        if (!dirty) return flushing;
        dirty = false;
        return flushing = flushing.then(() => o.bucket.putFile(keys.progress, progressFile, { contentType: 'application/json' })).catch(err => log(`[kd-job] progress not sent: ${err instanceof Error ? err.message : String(err)}`));
    };
    const timer = setInterval(() => { void flush(); }, o.flushMs ?? 5_000);
    timer.unref?.();
    const progress = (message: string) => {
        fs.appendFileSync(progressFile, `${JSON.stringify({ atMs: now(), message })}\n`);
        dirty = true;
    };
    const t0 = now();
    let spec: KdChunkJobSpec | undefined;
    try {
        const specFile = path.join(work, 'request.json');
        if (!(await o.bucket.download(keys.request, specFile))) throw new Error(`${o.bucket.label}/${keys.request} does not exist`);
        spec = JSON.parse(fs.readFileSync(specFile, 'utf8')) as KdChunkJobSpec;
        if (spec.schema !== KD_CHUNK_JOB_SCHEMA || !/^[0-9a-f]{8}$/.test(spec.runId) || !spec.request?.chunk) throw new Error(`${keys.request} is not a K-D chunk job (${KD_CHUNK_JOB_SCHEMA})`);
        log(`[kd-job] chunk ${spec.request.chunk.index} of ${spec.request.chunk.of}, run ${spec.runId}${o.commit ? `, image ${o.commit.slice(0, 12)}` : ''}`);
        // the laptop's measured texture library statistics, so the material regions do not measure the library again; never fails the chunk
        try {
            const statsFile = path.join(work, 'library-stats.json');
            if (await o.bucket.download(kdLibraryStatsKey(spec.request.chunk.of), statsFile)) {
                const n = unpackLibraryStats(JSON.parse(fs.readFileSync(statsFile, 'utf8')) as KdLibraryStats, o.libraryStatsDir ?? textureLibraryStatsDir(libraryRepoRoot()));
                log(`[kd-job] ${n} measured texture library sets from the runner`);
            }
        } catch (err) {
            log(`[kd-job] the texture library statistics were not read: ${err instanceof Error ? err.message : String(err)}`);
        }
        // the centre job publishes the district's frame (its own) as soon as its tiles are in, for the other jobs' cut
        const centre = spec.cut?.plan.chunks.find(c => c.centre)?.index;
        const isCentre = spec.cut !== undefined && centre === spec.request.chunk!.index;
        let framePublished: Promise<unknown> = Promise.resolve();
        const onFrame = isCentre ? (frame: TileFrame) => {
            const file = path.join(work, 'frame.json');
            fs.writeFileSync(file, JSON.stringify(frame));
            framePublished = o.bucket.putFile(kdDistrictFrameKey(spec!.request.chunk!.of), file, { contentType: 'application/json' })
                .then(() => progress('the district\'s frame published for the other chunks'), err => log(`[kd-job] the district's frame was not published: ${err instanceof Error ? err.message : String(err)}`));
        } : undefined;
        const outcome = await o.build(spec, { ...(o.signal ? { signal: o.signal } : {}), reportProgress: m => progress(m), ...(onFrame ? { onFrame } : {}) });
        await framePublished;
        // each layer cut to what the chunk keeps and compacted here, so the laptop downloads only that and only places it
        // (district-chunks.ts cutChunkLayer); a request without the cut sends them as built, and the laptop cuts them
        const cut: NonNullable<KdChunkJobOutcome['cut']> = {};
        const frame = outcome.compat.frame;
        if (spec.cut && !frame) throw new Error('the chunk did not report its frame, so its layers cannot be cut');
        const district = spec.cut && frame ? await districtFrame(o, spec, frame, isCentre, progress, log) : undefined;
        progress(district ? 'cutting the layers to what the chunk keeps and sending them to the runner' : 'sending the layers to the runner');
        for (const { name, whole } of kdChunkLayerParts(outcome)) {
            const file = path.join(o.cache.modelsDir, name);
            if (!fs.existsSync(file)) throw new Error(`the build names the layer ${name}, which is not in ${o.cache.modelsDir}`);
            let send = file;
            if (spec.cut && frame && district) {
                const r = cutChunkLayer(fs.readFileSync(file), { frame, district, plan: spec.cut.plan, bandM: spec.cut.bandM, of: spec.request.chunk!.of, chunk: spec.request.chunk!.index, whole, now });
                send = path.join(work, `cut-${name}`);
                fs.writeFileSync(send, r.glb);
                cut[name] = { keptTriangles: r.stamp.keptTriangles, removedTriangles: r.stamp.removedTriangles, bytesIn: r.stamp.bytesIn, bytesOut: r.glb.byteLength, droppedBytes: r.stamp.droppedBytes, ms: r.stamp.ms };
            }
            await o.bucket.putFile(keys.model(name), send, { contentType: 'model/gltf-binary' });
            if (send !== file) fs.rmSync(send, { force: true });
        }
        if (district) {
            const v = Object.values(cut), mb = (n: number) => (n / 1e6).toFixed(0);
            progress(`${v.length} layers cut and compacted: ${mb(v.reduce((s, x) => s + x.bytesIn, 0))} MB to ${mb(v.reduce((s, x) => s + x.bytesOut, 0))} MB in ${(v.reduce((s, x) => s + x.ms, 0) / 1000).toFixed(1)} s`);
        }
        await sendRunRecord(o, keys, spec.runId);
        const record: KdChunkJobOutcome = {
            schema: KD_CHUNK_JOB_SCHEMA, runId: spec.runId, root: o.cache.workspaceRoot, modelsDir: o.cache.modelsDir, cacheDir: o.cache.dir,
            outcome, ...(o.commit ? { commit: o.commit } : {}), ms: now() - t0, ...(district ? { cut } : {})
        };
        const outFile = path.join(work, 'outcome.json');
        fs.writeFileSync(outFile, JSON.stringify(record));
        await o.bucket.putFile(keys.outcome, outFile, { contentType: 'application/json' });
        progress(`chunk built (${outcome.result.status}) in ${Math.round((now() - t0) / 1000)} s`);
    } catch (err) {
        const e = err instanceof Error ? err : new Error(String(err));
        const record: KdChunkJobError = {
            name: e.name, message: e.message, ...(e.stack ? { stack: e.stack } : {}),
            ...((e as { stage?: string }).stage ? { stage: (e as { stage?: string }).stage } : {}),
            ...((e as { reasonCode?: string }).reasonCode ? { reasonCode: (e as { reasonCode?: string }).reasonCode } : {})
        };
        log(`[kd-job] failed: ${e.message}`);
        progress(`failed: ${e.message}`);
        const errFile = path.join(work, 'error.json');
        fs.writeFileSync(errFile, JSON.stringify(record));
        await o.bucket.putFile(keys.error, errFile, { contentType: 'application/json' }).catch(x => log(`[kd-job] error.json not sent: ${x instanceof Error ? x.message : String(x)}`));
        if (spec) await sendRunRecord(o, keys, spec.runId).catch(() => undefined);
        clearInterval(timer);
        dirty = true;
        await flush();
        fs.rmSync(work, { recursive: true, force: true });
        return false;
    }
    clearInterval(timer);
    dirty = true;
    await flush();
    // the chunk's stage and native caches to cache/v1/, as a laptop build's are; never fails the chunk
    if (o.mirror) {
        for (const r of cacheMirrorRoots(o.cache.workspaceRoot)) {
            try {
                const rep = await syncCacheDir(o.mirror, r.dir, r.prefix, { ...CACHE_MIRROR_PARAMS, settleMs: 0 });
                log(`[kd-job] ${o.mirror.label}/${r.prefix}: ${rep.uploaded} files sent (${(rep.bytes / 1e6).toFixed(0)} MB), ${rep.failed} failed`);
            } catch (err) {
                log(`[kd-job] ${r.prefix} not mirrored: ${err instanceof Error ? err.message : String(err)}`);
            }
        }
    }
    fs.rmSync(work, { recursive: true, force: true });
    return true;
}

/**
 * The district's frame this chunk's layers are cut in, exactly as the laptop will place them: the request's (the centre
 * built on the laptop), this job's own (it is the centre), else the one the centre job publishes, waited for; undefined
 * when it does not come in time (the layers then go uncut, and the laptop joins them).
 */
async function districtFrame(o: KdChunkJobOptions, spec: KdChunkJobSpec, frame: TileFrame, isCentre: boolean, progress: (m: string) => void, log: (m: string) => void): Promise<TileFrame | undefined> {
    const d = spec.cut!.district;
    if (d.originEllipsoidalHeightM !== undefined) return { lat: d.lat, lng: d.lng, originEllipsoidalHeightM: d.originEllipsoidalHeightM };
    if (isCentre) return frame;
    const key = kdDistrictFrameKey(spec.request.chunk!.of), wait = o.frameWaitMs ?? KD_FRAME_WAIT_MS, now = o.now ?? Date.now, t0 = now();
    const file = path.join(path.dirname(o.cache.dir), `.kd-frame-${process.pid}.json`);
    let said = false;
    try {
        for (;;) {
            if (o.signal?.aborted) throw o.signal.reason;
            try {
                if (await o.bucket.download(key, file)) {
                    const f = JSON.parse(fs.readFileSync(file, 'utf8')) as TileFrame;
                    if ([f.lat, f.lng, f.originEllipsoidalHeightM].every(Number.isFinite)) return f;
                }
            } catch (err) {
                log(`[kd-job] reading the district's frame failed: ${err instanceof Error ? err.message : String(err)}`);
            }
            if (now() - t0 >= wait) {
                progress(`the district's frame did not come within ${Math.round(wait / 1000)} s: the layers go uncut, for the laptop to join`);
                return undefined;
            }
            if (!said) { progress('waiting for the centre chunk to publish the district\'s frame'); said = true; }
            await new Promise(r => setTimeout(r, o.framePollMs ?? 10_000));
        }
    } finally {
        fs.rmSync(file, { force: true });
    }
}

async function sendRunRecord(o: KdChunkJobOptions, keys: ReturnType<typeof kdChunkJobKeys>, runId: string): Promise<void> {
    const dir = path.dirname(o.cache.runRecordPath(runId));
    const walk = (rel: string): string[] => {
        let out: string[] = [];
        let entries: fs.Dirent[];
        try { entries = fs.readdirSync(path.join(dir, rel), { withFileTypes: true }); } catch { return out; }
        for (const e of entries) {
            if (e.name.startsWith('.') || e.name.includes('.tmp')) continue;
            const r = rel ? `${rel}/${e.name}` : e.name;
            if (e.isDirectory()) out = out.concat(walk(r));
            else if (e.isFile() && /^[A-Za-z0-9._/-]+$/.test(r)) out.push(r);
        }
        return out;
    };
    for (const rel of walk('')) await o.bucket.putFile(keys.run(rel), path.join(dir, rel), { contentType: /\.jsonl?$/.test(rel) ? 'application/json' : 'application/octet-stream' });
}

/** `gs://bucket/prefix` → its parts. */
export function parseKdJobLocation(value: string | undefined): { bucket: string; prefix: string } {
    const m = /^gs:\/\/([a-z0-9][a-z0-9._-]{1,220}[a-z0-9])\/(kd-jobs\/[0-9a-f]{8}\/\d+)\/?$/.exec(value?.trim() ?? '');
    if (!m) throw new Error(`KD_JOB must be gs://<bucket>/kd-jobs/<parentRunId>/<chunk>, not ${JSON.stringify(value ?? '')}`);
    return { bucket: m[1], prefix: m[2] };
}

/** The native engines a chunk build runs, built once into the image's native build cache. */
async function warm(root: string): Promise<number> {
    const { nativeWarmupSteps, warmNativeEngine } = await import('../native-warmup');
    const { ensureTileSeamWeldBinary } = await import('../tile-seam-weld-service');
    const { ensureReliefBandBinary } = await import('./window-fit');
    const { ensureResidualAuditBinary } = await import('./residual-audit');
    const { ensureRevolutionBinary } = await import('./revolution-fit');
    const { ensureUvAtlasBinary } = await import('./texture-uv');
    // pipeline K's native ports (pipeline-k/native/, remesh-polish-native.ts), built where they run, as they run them
    const { ensureRemeshPolishBinary } = await import('./remesh-polish-native');
    const { ensureOrthoRectifyBinary } = await import('./pipeline-k/native/ortho-rectify-native');
    const { ensureTemplateMatchBinary } = await import('./pipeline-k/native/template-match-native');
    const { ensureMaterialRegionsNativeBinary } = await import('./pipeline-k/native/material-regions-native');
    const { ensureNativeTwinBinary } = await import('./pipeline-k/native/twin-texels-native');
    const steps = [
        // the Python module too: material regions prepare the library maps with it
        ...nativeWarmupSteps(root),
        { name: 'tile_seam_weld', run: async () => { await ensureTileSeamWeldBinary(root); } },
        { name: 'relief_band', run: async () => { await ensureReliefBandBinary(root); } },
        { name: 'residual_audit', run: async () => { await ensureResidualAuditBinary(root); } },
        { name: 'revolution_fit', run: async () => { await ensureRevolutionBinary(root); } },
        { name: 'uv_atlas', run: async () => { await ensureUvAtlasBinary(); } },
        { name: 'remesh_polish_native', run: async () => { await ensureRemeshPolishBinary(); } },
        { name: 'ortho_rectify_native', run: async () => { await ensureOrthoRectifyBinary(); } },
        { name: 'template_match_native', run: async () => { await ensureTemplateMatchBinary(); } },
        { name: 'material_regions_native', run: async () => { await ensureMaterialRegionsNativeBinary(); } },
        { name: 'twin_texels', run: async () => { await ensureNativeTwinBinary(); } }
    ];
    const report = await warmNativeEngine(root, { steps, env: {} });
    const failed = report.steps.filter(s => !s.ok || s.note);
    for (const s of failed) console.error(`[kd-job --warm] ${s.name}: ${s.error ?? s.note}`);
    return failed.length ? 1 : 0;
}

/** Every file under `dir` (relative paths), for putting a reused instance's workspace back as the image left it. */
function filesUnder(dir: string, rel = '', out = new Set<string>()): Set<string> {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(path.join(dir, rel), { withFileTypes: true }); } catch { return out; }
    for (const e of entries) {
        const r = rel ? path.join(rel, e.name) : e.name;
        if (e.isDirectory()) filesUnder(dir, r, out); else out.add(r);
    }
    return out;
}

/** Removes every file under `dir` the snapshot did not hold (and the folders left empty). */
export function restoreWorkspace(dir: string, snapshot: Set<string>): number {
    let removed = 0;
    for (const f of filesUnder(dir)) if (!snapshot.has(f)) { fs.rmSync(path.join(dir, f), { force: true }); removed++; }
    const prune = (rel: string): boolean => {
        const abs = path.join(dir, rel);
        let entries: fs.Dirent[];
        try { entries = fs.readdirSync(abs, { withFileTypes: true }); } catch { return false; }
        let empty = true;
        for (const e of entries) if (!(e.isDirectory() && prune(path.join(rel, e.name)))) empty = false;
        if (empty && rel) fs.rmdirSync(abs);
        return empty;
    };
    prune('');
    return removed;
}

/** The env a request asks for, set for one chunk and put back after (KD_JOB and SCRATCHBOX_ switches only). */
export function requestEnv(asked: Record<string, unknown> | undefined): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(asked ?? {})) if ((k === 'KD_JOB' || /^SCRATCHBOX_[A-Z0-9_]+$/.test(k)) && typeof v === 'string') out[k] = v;
    if (!out.KD_JOB) throw new Error('the request names no KD_JOB');
    return out;
}

/** One chunk as a job task builds it, from KD_JOB in the environment; true when its outcome was sent. */
async function buildChunkFromEnv(root: string, signal: AbortSignal): Promise<boolean> {
    const { StageCache } = await import('./stage-cache');
    const where = parseKdJobLocation(process.env.KD_JOB);
    const { GcsCloudBucket } = await import('../../cloud-store/cloud-bucket');
    const { GoogleMediaCredentialsService } = await import('../../google-media-credentials-service');
    const { cacheMirrorBucket } = await import('../../cloud-store/cache-mirror');
    const { runStagedLocation } = await import('./orchestrator');
    const { createStagedLocationDeps } = await import('./staged-location-tool');
    const bucket = new GcsCloudBucket(new GoogleMediaCredentialsService().createStorageClient().bucket(where.bucket));
    const mirror = cacheMirrorBucket();
    return runKdChunkJob({
        bucket, prefix: where.prefix, cache: new StageCache({ workspaceRoot: root }), signal,
        ...(mirror ? { mirror } : {}), ...(process.env.KD_IMAGE_COMMIT ? { commit: process.env.KD_IMAGE_COMMIT } : {}),
        build: async (spec, ctx) => {
            const deps = await createStagedLocationDeps(root, { signal });
            // the cloud task fetches its own leaves; it never builds chunks of its own
            const { prefetchTiles: _p, runChunk: _r, ...rest } = deps;
            return runStagedLocation(spec.request, { ...rest, newRunId: () => spec.runId }, ctx);
        }
    });
}

/** The chunk build as a Cloud Run service (see the file comment). */
async function serve(root: string): Promise<void> {
    const http = await import('http');
    const scratch = path.join(root, '.scratchbox');
    const snapshot = filesUnder(scratch);
    let busy = false;
    const server = http.createServer((req, res) => {
        if (req.method === 'GET' && req.url === '/healthz') { res.writeHead(200).end('ok'); return; }
        if (req.method !== 'POST' || req.url !== '/chunk') { res.writeHead(404).end(); return; }
        if (busy) { res.writeHead(429, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: false, error: 'this instance is building a chunk' })); return; }
        busy = true;
        let body = '';
        req.on('data', d => { body += d; });
        req.on('end', () => {
            const t0 = Date.now(), own = new AbortController();
            res.on('close', () => { if (!res.writableEnded) own.abort(Object.assign(new Error('the runner went away'), { name: 'AbortError' })); });
            res.writeHead(200, { 'content-type': 'application/json' });
            const beat = setInterval(() => res.write('\n'), 20_000);
            const saved = new Map<string, string | undefined>();
            void (async () => {
                let ok = false, error: string | undefined;
                try {
                    const env = requestEnv(JSON.parse(body || '{}').env);
                    for (const [k, v] of Object.entries(env)) { saved.set(k, process.env[k]); process.env[k] = v; }
                    const removed = restoreWorkspace(scratch, snapshot);
                    console.log(`[kd-serve] ${env.KD_JOB}${removed ? ` (${removed} files of the last chunk removed first)` : ''}`);
                    ok = await buildChunkFromEnv(root, own.signal);
                } catch (err) {
                    error = err instanceof Error ? err.message : String(err);
                    console.error(`[kd-serve] failed: ${error}`);
                } finally {
                    for (const [k, v] of saved) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
                    clearInterval(beat);
                    busy = false;
                    res.end(JSON.stringify({ ok, ms: Date.now() - t0, ...(error ? { error } : {}) }), () => {
                        // one chunk an instance: Cloud Run starts a clean one for the next
                        if (process.env.SCRATCHBOX_KD_SERVE_ONCE?.trim() !== '0') setTimeout(() => process.exit(0), 200).unref();
                    });
                }
            })();
        });
    });
    await new Promise<void>(resolve => server.listen(Number(process.env.PORT) || 8080, resolve));
    console.log(`[kd-serve] listening on ${Number(process.env.PORT) || 8080}`);
    // the build's modules loaded while the instance waits for its first chunk
    void import('./orchestrator').then(() => import('./staged-location-tool')).catch(err => console.error(`[kd-serve] preload: ${err}`));
}

async function main(): Promise<number> {
    const { stagedWorkspaceRoot } = await import('./stage-cache');
    const root = stagedWorkspaceRoot();
    if (process.argv.includes('--warm')) return warm(root);
    if (process.argv.includes('--serve')) { await serve(root); return new Promise<number>(() => undefined); }
    const own = new AbortController();
    process.once('SIGTERM', () => own.abort(Object.assign(new Error('the cloud job was cancelled'), { name: 'AbortError' })));
    return (await buildChunkFromEnv(root, own.signal)) ? 0 : 1;
}

if (require.main === module) {
    main().then(code => process.exit(code), err => { console.error(err); process.exit(1); });
}
