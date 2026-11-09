/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The cloud chunk runner and its job, end to end with no network: the bucket is a directory (DirectoryCloudBucket), the
 * Cloud Run job a fake whose execution runs kd-chunk-job.ts's runKdChunkJob in this process, in a workspace of its own,
 * with a build that writes layer GLBs and a run record as a real chunk build does.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DirectoryCloudBucket } from '../src/node/cloud-store/cloud-bucket';
import { GeminiClient } from '../src/node/gemini/gemini-client';
import {
    checkImageSkew, cloudChunkConfig, CloudRunServiceJobs, HybridJobs, kdVmKeys, RoundRobinJobs, VmPoolJobs, type ComputeVms, cloudRunTaskCostUsd, createCloudChunkRunner, forwardedJobEnv, parseServiceAnswer, imageCommit, KD_CHUNK_BUILT_LINE, kdChunkJobPrefix, kdChunkLayerFiles,
    localiseJobPaths, newProgressLines, parseExecution, type CloudExecution, type CloudRunJobs, type KdChunkJobSpec
} from '../src/node/3d-engine/staged-location/cloud-chunk-runner';
import { parseKdJobLocation, requestEnv, restoreWorkspace, runKdChunkJob } from '../src/node/3d-engine/staged-location/kd-chunk-job';
import { chunkCpuShare, chunkParallel, DISTRICT_CHUNKS_PARAMS, kdChunkRunner, machineCores } from '../src/node/3d-engine/staged-location/pipeline-k/district-chunks';
import { StagedLocationHardFailure, type StagedLocationOutcome, type StagedLocationRequest } from '../src/node/3d-engine/staged-location/orchestrator';
import { StageCache } from '../src/node/3d-engine/staged-location/stage-cache';

const tmp = (name: string) => fs.mkdtempSync(path.join(os.tmpdir(), `kd-cloud-${name}-`));
const SHA = '86ec852f0123456789abcdef0123456789abcdef';

const request = (index = 7): StagedLocationRequest => ({
    query: 'Shibuya Crossing', isolate: false, radiusM: 140, stageIntoActiveScene: false, district: 'kd',
    place: { lat: 35.6595, lng: 139.7005, formattedAddress: `Shibuya (chunk ${index})` },
    chunk: { of: 'c527da43', index, rect: { x0: -70, z0: -70, x1: 70, z1: 70 } }
} as StagedLocationRequest);

/** A layer as the staged build commits it (only the fields the join reads matter here). */
const layer = (objectId: string, stage: string, url: string, extra: Record<string, unknown> = {}) => ({ objectId, stage, url, supersedes: [], retired: false, ...extra });

/** What a chunk build leaves: three layers (one textured, one vector first paint, one superseded), the raw extraction, a run record. */
function fakeBuild(cache: StageCache, opts: { progress?: string[]; fail?: Error } = {}) {
    return async (spec: KdChunkJobSpec, ctx: { reportProgress?: (m: string, f?: number) => void }) => {
        for (const m of opts.progress ?? []) ctx.reportProgress?.(m);
        const runDir = path.dirname(cache.runRecordPath(spec.runId));
        fs.mkdirSync(path.join(runDir, 'notes'), { recursive: true });
        fs.writeFileSync(path.join(runDir, 'stages.json'), JSON.stringify({ runId: spec.runId, request: spec.request }));
        fs.writeFileSync(path.join(runDir, 'notes', 'remesh.md'), 'remesh took 36 min');
        if (opts.fail) throw opts.fail;
        fs.mkdirSync(cache.modelsDir, { recursive: true });
        const files: Record<string, string> = { 'ground_c7.glb': 'glTF-ground', 'ground_c7_tex.glb': 'glTF-ground-textured', 'trees_c7.glb': 'glTF-trees', 'vector_c7.glb': 'glTF-vector', 'old_c7.glb': 'glTF-old', 'raw_c7.glb': 'glTF-raw' };
        for (const [n, text] of Object.entries(files)) fs.writeFileSync(path.join(cache.modelsDir, n), text);
        return {
            result: {
                status: 'complete', stages: [{ stage: 'tiles', status: 'complete' }],
                artifact: { data: { stagedBuild: { layers: [
                    layer('ground', 'remesh', '/models/ground_c7.glb', { textured: { url: '/models/ground_c7_tex.glb' }, supersedes: ['old'] }),
                    layer('old', 'remesh', '/models/old_c7.glb'),
                    layer('trees', 'trees', '/models/trees_c7.glb'),
                    layer('vector', 'vector', '/models/vector_c7.glb')
                ] } } }
            },
            compat: {
                frame: { lat: 35.6595, lng: 139.7005, originEllipsoidalHeightM: 40 },
                glbPath: path.join(cache.modelsDir, 'raw_c7.glb'), resolvedAddress: 'Shibuya (chunk 7)',
                remesh: { ok: true, url: '/models/ground_c7.glb' }
            }
        } as unknown as StagedLocationOutcome;
    };
}

/** The Cloud Run job: run() starts the job function in this process; get() reports it done once it has ended. */
class FakeJobs implements CloudRunJobs {
    readonly label = 'fake://kd-chunk-job';
    runs: Array<Record<string, string>> = [];
    cancelled: string[] = [];
    private ended = new Map<string, { ok: boolean; startMs: number; endMs: number }>();
    constructor(private readonly image: string, private readonly execute: (env: Record<string, string>) => Promise<boolean>, private readonly hang = false) {}
    async jobImage() { return this.image; }
    async run(env: Record<string, string>) {
        const name = `projects/scoutscan/locations/us-central1/jobs/kd-chunk-job/executions/kd-chunk-job-${this.runs.length}`;
        this.runs.push(env);
        if (!this.hang) void this.execute(env).then(ok => this.ended.set(name, { ok, startMs: 1_000, endMs: 601_000 }));
        return name;
    }
    async get(name: string): Promise<CloudExecution> {
        const e = this.ended.get(name);
        return e ? { name, done: true, succeeded: e.ok, ...(e.ok ? {} : { message: 'Task kd-chunk-job-0 failed with exit code 1' }), startMs: e.startMs, endMs: e.endMs } : { name, done: false, succeeded: false };
    }
    async cancel(name: string) { this.cancelled.push(name); }
}

function setup(opts: { progress?: string[]; fail?: Error; hang?: boolean; image?: string; withMirror?: boolean; env?: NodeJS.ProcessEnv } = {}) {
    const bucketDir = tmp('bucket'), laptopRoot = tmp('laptop'), jobRoot = tmp('job');
    const laptopStats = path.join(laptopRoot, 'build', 'texture-library', 'stats'), jobStats = path.join(jobRoot, 'build', 'texture-library', 'stats');
    const bucket = new DirectoryCloudBucket(bucketDir);
    const mirror = opts.withMirror ? new DirectoryCloudBucket(tmp('training')) : undefined;
    const laptop = new StageCache({ workspaceRoot: laptopRoot });
    const jobCache = new StageCache({ workspaceRoot: jobRoot });
    const jobs = new FakeJobs(opts.image ?? `us-central1-docker.pkg.dev/scoutscan/depthbox3-repo/kd-chunk-job:${SHA}`, async env => {
        const where = parseKdJobLocation(env.KD_JOB);
        return runKdChunkJob({ bucket, prefix: where.prefix, cache: jobCache, build: fakeBuild(jobCache, opts), flushMs: 5, log: () => undefined, libraryStatsDir: jobStats, ...(mirror ? { mirror } : {}) });
    }, opts.hang);
    const config = { ...cloudChunkConfig({}), bucket: 'scoutscan-kd-jobs', pollMs: 5 };
    const runChunk = createCloudChunkRunner({ cache: laptop, bucket, jobs, config, head: () => SHA, newRunId: () => 'a1b2c3d4', env: opts.env ?? {}, log: () => undefined, libraryStatsDir: laptopStats });
    return { bucket, bucketDir, laptop, jobCache, jobs, runChunk, mirror, laptopRoot, jobRoot, laptopStats, jobStats };
}

describe('pipeline K-D cloud chunk runner', () => {
    it('builds a chunk in the job and hands the orchestrator the outcome as if it had run here', async () => {
        const s = setup({ progress: ['remesh: 12 facades', 'textures: 3 photos'] });
        const seen: string[] = [];
        const out = await s.runChunk(request(), { onProgress: m => seen.push(m) });
        expect(s.jobs.runs).toEqual([{ KD_JOB: 'gs://scoutscan-kd-jobs/kd-jobs/c527da43/7' }]);
        // the request reached the job with the runner's run id
        const spec = JSON.parse(fs.readFileSync(path.join(s.bucketDir, 'kd-jobs', 'c527da43', '7', 'request.json'), 'utf8'));
        expect(spec).toMatchObject({ schema: 'scratchbox.kd-chunk-job/1', runId: 'a1b2c3d4', request: { chunk: { of: 'c527da43', index: 7 } } });
        // the layers the join opens, byte for byte, under their names; not the vector paint, the superseded layer or the raw scan
        for (const [n, text] of [['ground_c7.glb', 'glTF-ground'], ['ground_c7_tex.glb', 'glTF-ground-textured'], ['trees_c7.glb', 'glTF-trees']]) {
            expect(fs.readFileSync(path.join(s.laptop.modelsDir, n), 'utf8')).toBe(text);
        }
        for (const n of ['vector_c7.glb', 'old_c7.glb', 'raw_c7.glb']) expect(fs.existsSync(path.join(s.laptop.modelsDir, n))).toBe(false);
        // the job's paths moved onto this workspace
        expect(out.compat.glbPath).toBe(path.join(s.laptop.modelsDir, 'raw_c7.glb'));
        expect(out.compat.frame).toEqual({ lat: 35.6595, lng: 139.7005, originEllipsoidalHeightM: 40 });
        expect(out.result.status).toBe('complete');
        // the run record, with what the cloud did beside it
        const runDir = path.dirname(s.laptop.runRecordPath('a1b2c3d4'));
        expect(JSON.parse(fs.readFileSync(path.join(runDir, 'stages.json'), 'utf8')).runId).toBe('a1b2c3d4');
        expect(fs.readFileSync(path.join(runDir, 'notes', 'remesh.md'), 'utf8')).toBe('remesh took 36 min');
        const job = JSON.parse(fs.readFileSync(path.join(runDir, 'cloud-job.json'), 'utf8'));
        expect(job).toMatchObject({ runId: 'a1b2c3d4', succeeded: true, seconds: 600 });
        expect(job.costUsd).toBeCloseTo(600 * (8 * 0.000018 + 32 * 0.000002), 6);
        // the job's progress forwarded in order, then the runner's own lines
        expect(seen.indexOf('remesh: 12 facades')).toBeGreaterThan(0);
        expect(seen.indexOf('textures: 3 photos')).toBeGreaterThan(seen.indexOf('remesh: 12 facades'));
        expect(seen[0]).toMatch(/^started in the cloud \(kd-chunk-job-0, run a1b2c3d4\)$/);
        expect(seen.at(-1)).toMatch(/^built in the cloud in 600 s \(about \$0\.12\)/);
        // nothing left in the stage cache's working dirs
        expect(fs.readdirSync(s.laptop.dir).filter(n => n.startsWith('.kd-cloud-'))).toEqual([]);
    });

    it('hands the jobs the measured texture library once a district, and a job keeps what it already measured', async () => {
        const s = setup();
        fs.mkdirSync(s.laptopStats, { recursive: true });
        fs.writeFileSync(path.join(s.laptopStats, 'Concrete015.json'), JSON.stringify({ version: 2, lab: [38, 0, 0] }));
        fs.writeFileSync(path.join(s.laptopStats, 'Plaster005.json'), JSON.stringify({ version: 2, lab: [67, 2, 2] }));
        fs.writeFileSync(path.join(s.laptopStats, 'half-written.json'), '{"version"');
        fs.mkdirSync(s.jobStats, { recursive: true });
        fs.writeFileSync(path.join(s.jobStats, 'Plaster005.json'), JSON.stringify({ version: 2, lab: [70, 0, 0] }));
        const puts: string[] = [];
        const putFile = s.bucket.putFile.bind(s.bucket);
        s.bucket.putFile = (key, file, o) => { puts.push(key); return putFile(key, file, o); };
        await s.runChunk(request(7), {});
        await s.runChunk(request(8), {});
        expect(puts.filter(k => k.endsWith('library-stats.json'))).toEqual(['kd-jobs/c527da43/library-stats.json']);
        // the set the job had not measured is written as the laptop measured it; its own measurement and the half-written file are not touched
        expect(JSON.parse(fs.readFileSync(path.join(s.jobStats, 'Concrete015.json'), 'utf8'))).toEqual({ version: 2, lab: [38, 0, 0] });
        expect(JSON.parse(fs.readFileSync(path.join(s.jobStats, 'Plaster005.json'), 'utf8'))).toEqual({ version: 2, lab: [70, 0, 0] });
        expect(fs.readdirSync(s.jobStats).sort()).toEqual(['Concrete015.json', 'Plaster005.json']);
    });

    it("gives each execution its share of this process's model-call budget: the chunks at once and the centre", async () => {
        const s = setup({ env: { SCRATCHBOX_MODEL_CALLS_IN_FLIGHT: '64', SCRATCHBOX_MODEL_CALLS_PER_MINUTE: '1000', SCRATCHBOX_MODEL_CALL_BUDGET: 'gemini-3.8-flash=/300,imagen=5/' } });
        const seen: string[] = [];
        await s.runChunk(request(), { atOnce: 7, onProgress: m => seen.push(m) });
        expect(s.jobs.runs).toEqual([{
            KD_JOB: 'gs://scoutscan-kd-jobs/kd-jobs/c527da43/7',
            SCRATCHBOX_MODEL_CALLS_IN_FLIGHT: '8', SCRATCHBOX_MODEL_CALLS_PER_MINUTE: '125', SCRATCHBOX_MODEL_CALL_BUDGET: 'gemini-3.8-flash=/37,imagen=1/'
        }]);
        expect(seen.find(m => m.startsWith('started in the cloud'))).toContain('1/8 of the budget');
        // the width the cloud runner sets when the orchestrator names none
        const t = setup({ env: { SCRATCHBOX_KD_CHUNK_RUNNER: 'cloud', SCRATCHBOX_KD_CLOUD_PARALLEL: '3', SCRATCHBOX_MODEL_CALLS_PER_MINUTE: '100' } });
        await t.runChunk(request(), {});
        expect(t.jobs.runs[0].SCRATCHBOX_MODEL_CALLS_PER_MINUTE).toBe('25');
    });

    it('reads the chunk once its outcome is in, while the job still mirrors its caches, and hands the job only the forwarded switches', async () => {
        const s = setup();
        // the same chunk, its execution never ending (a job still sending its caches): the outcome is read all the same
        const jobs = new FakeJobs(`us-central1-docker.pkg.dev/scoutscan/depthbox3-repo/kd-chunk-job:${SHA}`, async env => {
            const where = parseKdJobLocation(env.KD_JOB);
            await runKdChunkJob({ bucket: s.bucket, prefix: where.prefix, cache: s.jobCache, build: fakeBuild(s.jobCache), flushMs: 5, log: () => undefined, libraryStatsDir: s.jobStats });
            return new Promise<boolean>(() => undefined);
        });
        const runChunk = createCloudChunkRunner({
            cache: s.laptop, bucket: s.bucket, jobs, config: { ...cloudChunkConfig({}), bucket: 'scoutscan-kd-jobs', pollMs: 5 }, head: () => SHA, newRunId: () => 'a1b2c3d4',
            env: { SCRATCHBOX_CACHE_RESTORE: 'off', GOOGLE_MAPS_API_KEY: 'never-sent', SCRATCHBOX_KD_CHUNK_UNIT: 'building' }, log: () => undefined, libraryStatsDir: s.laptopStats
        });
        const out = await runChunk(request(), {});
        expect(out.result.status).toBe('complete');
        expect(fs.readFileSync(path.join(s.laptop.modelsDir, 'ground_c7.glb'), 'utf8')).toBe('glTF-ground');
        expect(jobs.runs).toEqual([{ KD_JOB: 'gs://scoutscan-kd-jobs/kd-jobs/c527da43/7', SCRATCHBOX_CACHE_RESTORE: 'off' }]);
        expect(forwardedJobEnv({ SCRATCHBOX_CACHE_MIRROR: ' off ', SCRATCHBOX_CPUS: '8' })).toEqual({ SCRATCHBOX_CACHE_MIRROR: 'off' });
        expect(KD_CHUNK_BUILT_LINE.test('chunk built (degraded) in 478 s')).toBe(true);
        expect(KD_CHUNK_BUILT_LINE.test('chunk 3: chunk built (degraded) in 478 s')).toBe(false);
    });

    it('sends the chunks to the warm worker pool (a Cloud Run service) as it would start job executions, the build the same', async () => {
        const s = setup();
        const posted: Array<{ url: string; env: Record<string, string> }> = [];
        let release!: () => void;
        const mirrorDone = new Promise<void>(r => { release = r; });
        const svc = new CloudRunServiceJobs({ ...cloudChunkConfig({ SCRATCHBOX_KD_CLOUD_SERVICE: 'kd-chunk-worker' }), bucket: 'scoutscan-kd-jobs', pollMs: 5 },
            async <T>() => ({ uri: 'https://kd-chunk-worker-x.a.run.app', template: { containers: [{ image: `us-central1-docker.pkg.dev/scoutscan/depthbox3-repo/kd-chunk-job:${SHA}` }] } }) as T,
            async (url, body) => {
                const env = (body as { env: Record<string, string> }).env;
                posted.push({ url, env });
                const where = parseKdJobLocation(env.KD_JOB);
                const ok = await runKdChunkJob({ bucket: s.bucket, prefix: where.prefix, cache: s.jobCache, build: fakeBuild(s.jobCache), flushMs: 5, log: () => undefined, libraryStatsDir: s.jobStats });
                // the worker answers only after its caches are mirrored; the runner does not wait for that
                await mirrorDone;
                return { ok };
            });
        expect(svc.label).toBe('run.googleapis.com/projects/scoutscan/locations/us-central1/services/kd-chunk-worker');
        const runChunk = createCloudChunkRunner({ cache: s.laptop, bucket: s.bucket, jobs: svc, config: { ...cloudChunkConfig({}), bucket: 'scoutscan-kd-jobs', pollMs: 5 }, head: () => SHA, newRunId: () => 'a1b2c3d4', env: { SCRATCHBOX_CACHE_RESTORE: 'off' }, log: () => undefined, libraryStatsDir: s.laptopStats });
        const out = await runChunk(request(), {});
        expect(out.result.status).toBe('complete');
        expect(fs.readFileSync(path.join(s.laptop.modelsDir, 'ground_c7.glb'), 'utf8')).toBe('glTF-ground');
        expect(posted).toEqual([{ url: 'https://kd-chunk-worker-x.a.run.app/chunk', env: { KD_JOB: 'gs://scoutscan-kd-jobs/kd-jobs/c527da43/7', SCRATCHBOX_CACHE_RESTORE: 'off' } }]);
        // the execution as the runner reads it: running until the worker answers, then done
        const name = (await svc.run({ KD_JOB: 'gs://scoutscan-kd-jobs/kd-jobs/c527da43/8' }));
        expect(await svc.get(name)).toMatchObject({ done: false, succeeded: false });
        release();
        await new Promise(r => setTimeout(r, 50));
        expect(await svc.get(name)).toMatchObject({ done: true });
        // the answer: heartbeats, then one JSON line
        expect(parseServiceAnswer('\n\n{"ok":true,"ms":12}')).toEqual({ ok: true });
        expect(parseServiceAnswer('\n{"ok":false,"error":"no KD_JOB"}')).toEqual({ ok: false, error: 'no KD_JOB' });
        expect(parseServiceAnswer('\n\n')).toMatchObject({ ok: false });
    });

    it('a worker instance builds each chunk from the workspace the image left, and takes only KD_JOB and SCRATCHBOX_ switches', () => {
        const dir = tmp('scratch');
        fs.mkdirSync(path.join(dir, 'cache', 'native'), { recursive: true });
        fs.writeFileSync(path.join(dir, 'cache', 'native', 'engine.bin'), 'compiled at image build');
        const snapshot = new Set(['cache/native/engine.bin'.split('/').join(path.sep)]);
        fs.mkdirSync(path.join(dir, 'cache', 'staged_location', 'remesh', 'k1'), { recursive: true });
        fs.writeFileSync(path.join(dir, 'cache', 'staged_location', 'remesh', 'k1', 'done.json'), '{}');
        fs.writeFileSync(path.join(dir, 'cache', 'native', 'other.bin'), 'built by the last chunk');
        expect(restoreWorkspace(dir, snapshot)).toBe(2);
        expect(fs.readFileSync(path.join(dir, 'cache', 'native', 'engine.bin'), 'utf8')).toBe('compiled at image build');
        expect(fs.existsSync(path.join(dir, 'cache', 'staged_location'))).toBe(false);
        expect(requestEnv({ KD_JOB: 'gs://b/kd-jobs/c527da43/7', SCRATCHBOX_CACHE_RESTORE: 'off', GOOGLE_MAPS_API_KEY: 'x', PATH: '/evil', SCRATCHBOX_N: 3 })).toEqual({ KD_JOB: 'gs://b/kd-jobs/c527da43/7', SCRATCHBOX_CACHE_RESTORE: 'off' });
        expect(() => requestEnv({})).toThrow(/KD_JOB/);
    });

    it('deals the chunks to the pool in each region in turn, reads each where it went, and refuses regions on different images', async () => {
        const img = `us-central1-docker.pkg.dev/scoutscan/depthbox3-repo/kd-chunk-job:${SHA}`;
        const a = new FakeJobs(img, async () => true), b = new FakeJobs(img, async () => true);
        const rr = new RoundRobinJobs([a, b]);
        expect(await rr.jobImage()).toBe(img);
        const names = [];
        for (let k = 0; k < 5; k++) names.push(await rr.run({ KD_JOB: `gs://scoutscan-kd-jobs/kd-jobs/c527da43/${k}` }));
        expect(a.runs.map(r => r.KD_JOB.split('/').pop())).toEqual(['0', '2', '4']);
        expect(b.runs.map(r => r.KD_JOB.split('/').pop())).toEqual(['1', '3']);
        await new Promise(r => setTimeout(r, 20));
        expect(await rr.get(names[1])).toMatchObject({ done: true, succeeded: true });
        await rr.cancel(names[3]);
        expect(b.cancelled).toEqual([names[3]]);
        await expect(rr.get('nowhere')).rejects.toThrow(/no chunk nowhere/);
        await expect(new RoundRobinJobs([a, new FakeJobs(img.replace(SHA, 'b'.repeat(40)), async () => true)]).jobImage()).rejects.toThrow(/deploy one image to every region/);
        expect(cloudChunkConfig({ SCRATCHBOX_KD_CLOUD_SERVICE_REGIONS: 'us-central1, us-east4,bad region,' }).serviceRegions).toEqual(['us-central1', 'us-east4']);
        expect(cloudChunkConfig({}).serviceRegions).toBeUndefined();
    });

    it('builds the largest chunks on the suspended VMs, resuming one for each and suspending it after, the rest on the pool', async () => {
        const img = `us-central1-docker.pkg.dev/scoutscan/depthbox3-repo/kd-chunk-job:${SHA}`;
        const bucketDir = tmp('vm-bucket'), bucket = new DirectoryCloudBucket(bucketDir);
        const status = new Map([['kd-fast-1', 'SUSPENDED'], ['kd-fast-2', 'SUSPENDED']]);
        const calls: string[] = [];
        const compute: ComputeVms = {
            status: async vm => status.get(vm)!,
            resume: async vm => { calls.push(`resume ${vm}`); status.set(vm, 'RUNNING'); },
            suspend: async vm => { calls.push(`suspend ${vm}`); status.set(vm, 'SUSPENDED'); },
            image: async () => img
        };
        const vms = new VmPoolJobs(['kd-fast-1', 'kd-fast-2'], compute, bucket, tmp('vm-work'), () => undefined, Date.now, 1);
        const pool = new FakeJobs(img, async () => true);
        const jobs = new HybridJobs(vms, pool);
        expect(await jobs.jobImage()).toBe(img);
        // the VM's side (kd-chunk-job.ts --poll): it takes its assignment and answers for that chunk
        const vmAnswers = async (vm: string, ok = true) => {
            const keys = kdVmKeys(vm), f = path.join(tmp('vm-side'), 'a.json');
            expect(await bucket.download(keys.assign, f)).toBe(true);
            const job = JSON.parse(fs.readFileSync(f, 'utf8')).env.KD_JOB as string;
            await bucket.remove(keys.assign);
            fs.writeFileSync(f, JSON.stringify({ ok, ms: 1, job }));
            await bucket.putFile(keys.done, f);
            return job;
        };
        const a = await jobs.run({ KD_JOB: 'gs://scoutscan-kd-jobs/kd-jobs/c527da43/25', KD_FAST: '1' });
        const b = await jobs.run({ KD_JOB: 'gs://scoutscan-kd-jobs/kd-jobs/c527da43/26', KD_FAST: '1' });
        // a third marked chunk, no VM free: the pool; an unmarked one: the pool, with the mark never passed on
        const c = await jobs.run({ KD_JOB: 'gs://scoutscan-kd-jobs/kd-jobs/c527da43/28', KD_FAST: '1' });
        await jobs.run({ KD_JOB: 'gs://scoutscan-kd-jobs/kd-jobs/c527da43/3' });
        expect([a, b].every(n => n.startsWith('vm/'))).toBe(true);
        expect(pool.runs).toEqual([{ KD_JOB: 'gs://scoutscan-kd-jobs/kd-jobs/c527da43/28' }, { KD_JOB: 'gs://scoutscan-kd-jobs/kd-jobs/c527da43/3' }]);
        expect(c.includes('kd-chunk-job-')).toBe(true);
        expect(calls).toEqual(['resume kd-fast-1', 'resume kd-fast-2']);
        // running until the VM answers; then done, and the VM suspended again and free
        expect(await jobs.get(a)).toMatchObject({ done: false });
        expect(await vmAnswers('kd-fast-1')).toBe('gs://scoutscan-kd-jobs/kd-jobs/c527da43/25');
        expect(await jobs.get(a)).toMatchObject({ done: true, succeeded: true });
        await new Promise(r => setTimeout(r, 5));
        expect(calls).toContain('suspend kd-fast-1');
        expect(vms.free()).toBe(1);
        // an answer for another chunk is not this one's; a failed build fails the chunk
        await vmAnswers('kd-fast-2', false);
        expect(await jobs.get(b)).toMatchObject({ done: true, succeeded: false, message: expect.stringMatching(/outcome/) });
        // a VM still suspending is waited for, then resumed
        status.set('kd-fast-1', 'SUSPENDING');
        setTimeout(() => status.set('kd-fast-1', 'SUSPENDED'), 20);
        const d = await vms.run({ KD_JOB: 'gs://scoutscan-kd-jobs/kd-jobs/c527da43/31' });
        expect(d.startsWith('vm/kd-fast-1/')).toBe(true);
        expect(status.get('kd-fast-1')).toBe('RUNNING');
        // VMs created from different images are refused; the config
        const mixed = new VmPoolJobs(['x', 'y'], { ...compute, image: async vm => (vm === 'x' ? img : img.replace(SHA, 'c'.repeat(40))) }, bucket, tmp('vm-work2'));
        await expect(mixed.jobImage()).rejects.toThrow(/one image/);
        expect(cloudChunkConfig({ SCRATCHBOX_KD_CLOUD_VMS: 'kd-fast-1,kd-fast-2, Bad_Name' })).toMatchObject({ vms: ['kd-fast-1', 'kd-fast-2'], vmZone: 'us-central1-a' });
        expect(() => kdVmKeys('../x')).toThrow();
    });

    it('sets no budget on an execution when this process has none', async () => {
        const s = setup();
        const seen: string[] = [];
        await s.runChunk(request(), { atOnce: 20, onProgress: m => seen.push(m) });
        expect(s.jobs.runs).toEqual([{ KD_JOB: 'gs://scoutscan-kd-jobs/kd-jobs/c527da43/7' }]);
        expect(seen.find(m => m.startsWith('started in the cloud'))).not.toContain('budget');
    });

    it('starts the chunks without library statistics when this checkout has measured none', async () => {
        const s = setup();
        const out = await s.runChunk(request(), {});
        expect(out.result.status).toBe('complete');
        expect(fs.existsSync(path.join(s.bucketDir, 'kd-jobs', 'c527da43', 'library-stats.json'))).toBe(false);
        expect(fs.existsSync(s.jobStats)).toBe(false);
    });

    it('mirrors the job\'s caches to cache/v1/ once the outcome is sent', async () => {
        const s = setup({ withMirror: true });
        const entry = path.join(s.jobRoot, '.scratchbox', 'cache', 'tile_refine', 'abc123', 'done.json');
        fs.mkdirSync(path.dirname(entry), { recursive: true });
        fs.writeFileSync(entry, '{"ok":true}');
        await s.runChunk(request(), {});
        expect((await s.mirror!.list('cache/v1/tile_refine/')).map(o => o.key)).toContain('cache/v1/tile_refine/abc123/done.json');
        expect((await s.mirror!.list('cache/v1/staged_location/runs/a1b2c3d4/')).map(o => o.key)).toContain('cache/v1/staged_location/runs/a1b2c3d4/stages.json');
    });

    it('rethrows the job\'s own error, a hard failure keeping its stage, with the run record kept', async () => {
        const s = setup({ fail: new StagedLocationHardFailure('tiles', 'no_tiles', 'the tiles do not cover chunk 7') });
        const err = await s.runChunk(request(), {}).catch(e => e);
        expect(err).toBeInstanceOf(StagedLocationHardFailure);
        expect(err).toMatchObject({ stage: 'tiles', reasonCode: 'no_tiles', message: 'the tiles do not cover chunk 7' });
        const runDir = path.dirname(s.laptop.runRecordPath('a1b2c3d4'));
        expect(JSON.parse(fs.readFileSync(path.join(runDir, 'cloud-job.json'), 'utf8'))).toMatchObject({ succeeded: false, message: /exit code 1/ });
        expect(fs.existsSync(path.join(runDir, 'stages.json'))).toBe(true);
    });

    it('a retried chunk starts from none of the earlier attempt\'s objects', async () => {
        const s = setup();
        const stale = path.join(s.bucketDir, 'kd-jobs', 'c527da43', '7', 'error.json');
        fs.mkdirSync(path.dirname(stale), { recursive: true });
        fs.writeFileSync(stale, JSON.stringify({ name: 'Error', message: 'the earlier attempt' }));
        await expect(s.runChunk(request(), {})).resolves.toMatchObject({ result: { status: 'complete' } });
        expect(fs.existsSync(stale)).toBe(false);
    });

    it('asks for the execution again when a poll fails, and fails the chunk (its execution cancelled) after too many in a row', async () => {
        const s = setup();
        const real = s.jobs.get.bind(s.jobs);
        let fails = 3;
        s.jobs.get = async (name: string) => { if (fails-- > 0) throw new Error('read ETIMEDOUT'); return real(name); };
        const out = await s.runChunk(request(), {});
        expect(out.result.status).toBe('complete');
        expect(s.jobs.cancelled).toEqual([]);

        const t = setup();
        t.jobs.get = async () => { throw new Error('read ETIMEDOUT'); };
        await expect(t.runChunk(request(), {})).rejects.toThrow(/ETIMEDOUT/);
        expect(t.jobs.cancelled).toEqual([expect.stringMatching(/kd-chunk-job-0$/)]);
    });

    it("tries a cut-off download of the job's layers again before failing the chunk", async () => {
        const s = setup();
        const real = s.bucket.download.bind(s.bucket);
        let cuts = 2;
        s.bucket.download = async (key: string, file: string) => { if (key.includes('/models/') && cuts-- > 0) throw new Error('aborted'); return real(key, file); };
        const out = await s.runChunk(request(), {});
        expect(out.result.status).toBe('complete');
        expect(fs.readFileSync(path.join(s.laptop.modelsDir, 'ground_c7.glb'), 'utf8')).toBe('glTF-ground');

        const t = setup();
        const realT = t.bucket.download.bind(t.bucket);
        let tries = 0;
        t.bucket.download = async (key: string, file: string) => { if (key.includes('/models/')) { tries++; throw new Error('aborted'); } return realT(key, file); };
        await expect(t.runChunk(request(), {})).rejects.toThrow(/aborted/);
        expect(tries).toBe(4);
        // asked for again (the orchestrator's retry), the chunk its job built is downloaded again, never built again
        t.bucket.download = realT;
        const again = await t.runChunk(request(), {});
        expect(again.result.status).toBe('complete');
        expect(t.jobs.runs).toHaveLength(1);
        expect(fs.readFileSync(path.join(t.laptop.modelsDir, 'ground_c7.glb'), 'utf8')).toBe('glTF-ground');
    });

    it('a stop cancels the execution and rejects with the stop', async () => {
        const s = setup({ hang: true });
        const ac = new AbortController();
        const p = s.runChunk(request(), { signal: ac.signal });
        await new Promise(r => setTimeout(r, 30));
        ac.abort(Object.assign(new Error('stopped by the user'), { name: 'AbortError' }));
        await expect(p).rejects.toMatchObject({ name: 'AbortError', message: 'stopped by the user' });
        expect(s.jobs.cancelled).toEqual(['projects/scoutscan/locations/us-central1/jobs/kd-chunk-job/executions/kd-chunk-job-0']);
    });

    it('refuses a job image built from another commit, before any chunk starts', async () => {
        const s = setup({ image: 'us-central1-docker.pkg.dev/scoutscan/depthbox3-repo/kd-chunk-job:0123456789ab' });
        await expect(s.runChunk(request(), {})).rejects.toThrow(/not this checkout's commit 86ec852f0123/);
        expect(s.jobs.runs).toEqual([]);
        expect(() => checkImageSkew('x/kd-chunk-job:0123456789ab', SHA, { SCRATCHBOX_KD_CLOUD_ALLOW_SKEW: '1' })).not.toThrow();
        expect(() => checkImageSkew('x/kd-chunk-job:86ec852f', SHA, {})).not.toThrow();
        expect(() => checkImageSkew('x/kd-chunk-job@sha256:ffff', SHA, {})).toThrow();
        expect(imageCommit('x/kd-chunk-job:latest')).toBeUndefined();
    });

    it('asks for the job image again after the API could not be reached', async () => {
        const s = setup();
        const real = s.jobs.jobImage.bind(s.jobs);
        let calls = 0;
        s.jobs.jobImage = async () => { if (++calls === 1) throw new Error('socket hang up'); return real(); };
        await expect(s.runChunk(request(), {})).rejects.toThrow(/socket hang up/);
        expect(s.jobs.runs).toEqual([]);
        await s.runChunk(request(), {});
        expect(calls).toBe(2);
        expect(s.jobs.runs).toHaveLength(1);
    });

    it('builds only district chunks', () => {
        expect(() => kdChunkJobPrefix({ ...request(), chunk: undefined } as StagedLocationRequest)).toThrow(/only district chunks/);
        expect(() => kdChunkJobPrefix({ ...request(), chunk: { of: '../x', index: 1 } } as StagedLocationRequest)).toThrow();
        expect(kdChunkJobPrefix(request(12))).toBe('kd-jobs/c527da43/12');
        expect(parseKdJobLocation('gs://scoutscan-kd-jobs/kd-jobs/c527da43/12')).toEqual({ bucket: 'scoutscan-kd-jobs', prefix: 'kd-jobs/c527da43/12' });
        expect(() => parseKdJobLocation('gs://scoutscan-kd-jobs/cache/v1/x')).toThrow(/KD_JOB must be/);
    });
});

describe('pipeline K-D cloud chunk runner: pieces', () => {
    it('forwards only whole new progress lines', () => {
        const a = newProgressLines('{"message":"one"}\n{"message":"two"}\n{"mess', 0);
        expect(a).toEqual({ lines: ['one', 'two'], seen: 2 });
        expect(newProgressLines('{"message":"one"}\n{"message":"two"}\n{"message":"three"}\n', a.seen)).toEqual({ lines: ['three'], seen: 3 });
    });

    it('moves only the job\'s own paths', () => {
        const from = { root: '/app', modelsDir: '/app/public/models', cacheDir: '/app/.scratchbox/cache/staged_location' };
        const to = { root: '/Users/me/ws', modelsDir: '/Users/me/ws/public/models', cacheDir: '/Users/me/ws/.scratchbox/cache/staged_location' };
        expect(localiseJobPaths({ a: '/app/public/models/x.glb', b: ['/app/.scratchbox/cache/staged_location/runs/x'], c: '/application/y', d: '/models/x.glb', e: 3 }, from, to))
            .toEqual({ a: '/Users/me/ws/public/models/x.glb', b: ['/Users/me/ws/.scratchbox/cache/staged_location/runs/x'], c: '/application/y', d: '/models/x.glb', e: 3 });
    });

    it('lists the layer files the join opens', () => {
        const outcome = { result: { artifact: { data: { stagedBuild: { layers: [
            layer('a', 'remesh', '/models/a.glb', { textured: { url: '/models/a_t.glb' } }), layer('b', 'remesh', '/models/b.glb', { retired: true }),
            layer('v', 'vector', '/models/v.glb'), layer('c', 'trees', '/models/../c.glb')
        ] } } } } } as unknown as StagedLocationOutcome;
        expect(kdChunkLayerFiles(outcome).sort()).toEqual(['a.glb', 'a_t.glb', 'c.glb']);
    });

    it('reads a Cloud Run execution', () => {
        expect(parseExecution({ name: 'e', startTime: '2026-10-30T10:00:00Z' })).toMatchObject({ done: false, succeeded: false, startMs: Date.parse('2026-10-30T10:00:00Z') });
        expect(parseExecution({ name: 'e', startTime: '2026-10-30T10:00:00Z', completionTime: '2026-10-30T10:10:00Z', succeededCount: 1 })).toMatchObject({ done: true, succeeded: true });
        expect(parseExecution({ name: 'e', completionTime: '2026-10-30T10:10:00Z', failedCount: 1, conditions: [{ type: 'Completed', state: 'CONDITION_FAILED', message: 'Task failed: exit 1' }] }))
            .toMatchObject({ done: true, succeeded: false, message: 'Task failed: exit 1' });
        expect(parseExecution({ name: 'e', completionTime: '2026-10-30T10:10:00Z', cancelledCount: 1 })).toMatchObject({ succeeded: false, message: 'cancelled' });
        expect(cloudRunTaskCostUsd(3600)).toBeCloseTo(0.7488, 4);
    });

    it('sets the chunks\' width and the builds sharing a machine by where the chunks run', () => {
        const big = 128 * 1024 ** 3;
        expect(kdChunkRunner({})).toBe('local');
        expect(chunkParallel(DISTRICT_CHUNKS_PARAMS, big, {})).toBe(3);
        expect(chunkParallel(DISTRICT_CHUNKS_PARAMS, 8 * 1024 ** 3, { SCRATCHBOX_KD_CHUNK_RUNNER: 'cloud' })).toBe(48);
        expect(chunkParallel(DISTRICT_CHUNKS_PARAMS, big, { SCRATCHBOX_KD_CHUNK_RUNNER: 'cloud', SCRATCHBOX_KD_CLOUD_PARALLEL: '8' })).toBe(8);
        // the centre build alone on the laptop, and a chunk alone in its task: every core its own
        expect(chunkCpuShare(16, DISTRICT_CHUNKS_PARAMS, { SCRATCHBOX_KD_CHUNK_RUNNER: 'cloud' })).toEqual({ builds: 1, threads: 16, slowdown: 1 });
        expect(chunkCpuShare(8, DISTRICT_CHUNKS_PARAMS, { SCRATCHBOX_KD_CHUNK_JOB: '1' })).toEqual({ builds: 1, threads: 8, slowdown: 1 });
        expect(machineCores({ SCRATCHBOX_CPUS: '8' })).toBe(8);
    });
});

describe('pipeline K-D chunk job: the task\'s own Google account', () => {
    afterEach(() => { vi.unstubAllEnvs(); });

    it('is used only when asked (SCRATCHBOX_GOOGLE_ADC=1 with a project), never in place of a key file', () => {
        vi.stubEnv('GOOGLE_SERVICE_ACCOUNT_JSON', '');
        vi.stubEnv('GOOGLE_CLOUD_PROJECT', 'scoutscan');
        vi.stubEnv('SCRATCHBOX_GOOGLE_ADC', '');
        expect(new GeminiClient({ serviceAccountCandidatePaths: [] }).ensureAuth()).toBe(false);
        vi.stubEnv('SCRATCHBOX_GOOGLE_ADC', '1');
        const client = new GeminiClient({ serviceAccountCandidatePaths: [] });
        expect(client.ensureAuth()).toBe(true);
        expect(client.cachedProjectId).toBe('scoutscan');
        expect(client.cachedServiceAccountPath).toBeUndefined();
        vi.stubEnv('GOOGLE_CLOUD_PROJECT', '');
        expect(new GeminiClient({ serviceAccountCandidatePaths: [] }).ensureAuth()).toBe(false);
    });
});
