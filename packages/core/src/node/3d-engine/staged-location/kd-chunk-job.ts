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
 * 5 s), then sends the layer GLBs the orchestrator joins, the run record and outcome.json, and last the build's caches to the
 * training bucket's cache/v1/ (cache-mirror.ts syncCacheDir, as a laptop build does). A failed build writes error.json.
 * The exit code is 0 only once outcome.json is sent. Cloud Run's cancel (SIGTERM) stops the build.
 *
 * `--warm` builds the native engines the chunk runs, at image build time (deploy/kd-chunk-job/Dockerfile), so a task never
 * waits on clang; it exits non-zero when one does not build.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { CloudBucket } from '../../cloud-store/cloud-bucket';
import { CACHE_MIRROR_PARAMS, cacheMirrorRoots, syncCacheDir } from '../../cloud-store/cache-mirror';
import { textureLibraryStatsDir } from '../texture-library';
import { KD_CHUNK_JOB_SCHEMA, kdChunkJobKeys, kdChunkLayerFiles, kdLibraryStatsKey, unpackLibraryStats, type KdChunkJobError, type KdChunkJobOutcome, type KdChunkJobSpec, type KdLibraryStats } from './cloud-chunk-runner';
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
    build: (spec: KdChunkJobSpec, ctx: Pick<StagedLocationContext, 'signal' | 'reportProgress'>) => Promise<StagedLocationOutcome>;
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
}

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
        const outcome = await o.build(spec, { ...(o.signal ? { signal: o.signal } : {}), reportProgress: m => progress(m) });
        progress('sending the layers to the runner');
        for (const name of kdChunkLayerFiles(outcome)) {
            const file = path.join(o.cache.modelsDir, name);
            if (!fs.existsSync(file)) throw new Error(`the build names the layer ${name}, which is not in ${o.cache.modelsDir}`);
            await o.bucket.putFile(keys.model(name), file, { contentType: 'model/gltf-binary' });
        }
        await sendRunRecord(o, keys, spec.runId);
        const record: KdChunkJobOutcome = {
            schema: KD_CHUNK_JOB_SCHEMA, runId: spec.runId, root: o.cache.workspaceRoot, modelsDir: o.cache.modelsDir, cacheDir: o.cache.dir,
            outcome, ...(o.commit ? { commit: o.commit } : {}), ms: now() - t0
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

async function main(): Promise<number> {
    const { stagedWorkspaceRoot, StageCache } = await import('./stage-cache');
    const root = stagedWorkspaceRoot();
    if (process.argv.includes('--warm')) return warm(root);
    const where = parseKdJobLocation(process.env.KD_JOB);
    const { GcsCloudBucket } = await import('../../cloud-store/cloud-bucket');
    const { GoogleMediaCredentialsService } = await import('../../google-media-credentials-service');
    const { cacheMirrorBucket } = await import('../../cloud-store/cache-mirror');
    const { runStagedLocation } = await import('./orchestrator');
    const { createStagedLocationDeps } = await import('./staged-location-tool');
    const bucket = new GcsCloudBucket(new GoogleMediaCredentialsService().createStorageClient().bucket(where.bucket));
    const own = new AbortController();
    process.once('SIGTERM', () => own.abort(Object.assign(new Error('the cloud job was cancelled'), { name: 'AbortError' })));
    const mirror = cacheMirrorBucket();
    const ok = await runKdChunkJob({
        bucket, prefix: where.prefix, cache: new StageCache({ workspaceRoot: root }), signal: own.signal,
        ...(mirror ? { mirror } : {}), ...(process.env.KD_IMAGE_COMMIT ? { commit: process.env.KD_IMAGE_COMMIT } : {}),
        build: async (spec, ctx) => {
            const deps = await createStagedLocationDeps(root, { signal: own.signal });
            // the cloud task fetches its own leaves; it never builds chunks of its own
            const { prefetchTiles: _p, runChunk: _r, ...rest } = deps;
            return runStagedLocation(spec.request, { ...rest, newRunId: () => spec.runId }, ctx);
        }
    });
    return ok ? 0 : 1;
}

if (require.main === module) {
    main().then(code => process.exit(code), err => { console.error(err); process.exit(1); });
}
