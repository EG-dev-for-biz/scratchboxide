/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The staged build's per-stage cache, negative cache, run records and atomic publishing
 * (<workspace>/.scratchbox/cache/staged_location/).
 *
 * - An entry is <stage>/<key>/: its files are written into a temp dir that is renamed into place, and done.json records
 *   the value, the inputs, the timings, builtAtMs and every published file with its size and sha256.
 * - Publishing is atomic: public/models/.<name>.tmp-<pid>-<rand>, then a rename. A cache hit re-checks each published
 *   file's size and sha256 against done.json before reusing its URL; on a mismatch (a copy interrupted by Stop or a
 *   crash) it publishes again from the recorded source. A truncated file is never served as a hit.
 * - Two requests for the same key share one run (in-flight dedupe).
 * - A negative entry records a deterministic failure (with the engine's binary sha), so a repeat fails fast with the
 *   same record; transient failures are never stored. A retry of that stage bypasses it.
 * - Run records (runs/<runId>/stages.json) hold the normalized request and every stage key, never image bytes, so a
 *   retry rebuilds the request exactly.
 *
 * Street View image bytes are never given to this cache: nothing here takes a Buffer of image data.
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { resolveWithinRoot } from '../../security/path-guard';

export const STAGE_CACHE_VERSION = 'staged_location/v1';

export interface PublishedFile {
    /** File name under public/models. */
    name: string;
    /** Absolute path of the published file. */
    path: string;
    /** Viewer URL (/models/<name>). */
    url: string;
    bytes: number;
    sha256: string;
    /** Where it was copied from (the entry's own file, or another service's cache entry). */
    source: string;
}

export interface StageCacheRecord<T> {
    schema: 'scratchbox.stage-cache/1';
    stage: string;
    key: string;
    value: T;
    builtAtMs: number;
    ms: number;
    inputs?: Record<string, unknown>;
    published: PublishedFile[];
}

export interface CachedStage<T> {
    key: string;
    /** The entry directory (its files live here). */
    dir: string;
    value: T;
    builtAtMs: number;
    ms: number;
    published: PublishedFile[];
    /** True when the entry already existed (no run). */
    cached: boolean;
}

export interface NegativeRecord {
    schema: 'scratchbox.stage-negative/1';
    stage: string;
    key: string;
    code: string;
    message: string;
    /** The engine binary the failure came from: a rebuilt engine makes the entry stale. */
    binarySha256?: string;
    atMs: number;
}

export interface PublishRequest {
    /** File inside the entry dir (relative), or an absolute path elsewhere (another service's cache). */
    from: string;
    /** Name under public/models ([A-Za-z0-9_.-], ends .glb or .json). */
    as: string;
}

const PUBLISH_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,159}\.(glb|json)$/;
const STAGE_NAME = /^[a-z0-9][a-z0-9-]{0,47}$/;
const KEY = /^[0-9a-f]{64}$/;
const RUN_ID = /^[0-9a-f]{8}$/;

export function sha256File(file: string): string {
    const hash = crypto.createHash('sha256');
    const fd = fs.openSync(file, 'r');
    try {
        const buf = Buffer.allocUnsafe(1 << 20);
        let n: number;
        while ((n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) hash.update(buf.subarray(0, n));
    } finally {
        fs.closeSync(fd);
    }
    return hash.digest('hex');
}

/** sha256 over the JSON of the parts, in order: a stage key. */
export function stageKey(...parts: unknown[]): string {
    const h = crypto.createHash('sha256').update(STAGE_CACHE_VERSION);
    for (const p of parts) h.update('\0').update(typeof p === 'string' ? p : JSON.stringify(p) ?? 'undefined');
    return h.digest('hex');
}

export interface StageCacheOptions {
    workspaceRoot: string;
    /** Default <workspaceRoot>/.scratchbox/cache/staged_location. */
    cacheDir?: string;
    /** Default <workspaceRoot>/public/models. */
    modelsDir?: string;
    now?: () => number;
}

export class StageCache {
    readonly workspaceRoot: string;
    readonly dir: string;
    readonly modelsDir: string;
    private readonly now: () => number;
    private readonly inFlight = new Map<string, Promise<CachedStage<unknown>>>();

    constructor(options: StageCacheOptions) {
        this.workspaceRoot = resolveWithinRoot(options.workspaceRoot, '.');
        this.dir = options.cacheDir ? resolveWithinRoot(this.workspaceRoot, options.cacheDir) : resolveWithinRoot(this.workspaceRoot, path.join('.scratchbox', 'cache', 'staged_location'));
        this.modelsDir = options.modelsDir ? path.resolve(options.modelsDir) : resolveWithinRoot(this.workspaceRoot, path.join('public', 'models'));
        this.now = options.now ?? Date.now;
    }

    entryDir(stage: string, key: string): string {
        if (!STAGE_NAME.test(stage)) throw new Error(`stage cache: bad stage name "${stage}"`);
        if (!KEY.test(key)) throw new Error(`stage cache: bad key "${key}"`);
        return path.join(this.dir, stage, key);
    }

    /**
     * The entry for (stage, key), or undefined. Each published file is checked against its recorded size and sha256 and
     * republished from its source when it does not match; an entry whose source is gone or changed is a miss.
     */
    get<T>(stage: string, key: string): CachedStage<T> | undefined {
        const dir = this.entryDir(stage, key);
        const done = path.join(dir, 'done.json');
        if (!fs.existsSync(done)) return undefined;
        let rec: StageCacheRecord<T>;
        try {
            rec = JSON.parse(fs.readFileSync(done, 'utf8'));
        } catch {
            return undefined;
        }
        const published: PublishedFile[] = [];
        for (const p of rec.published ?? []) {
            const fresh = this.verifyPublished(p);
            if (!fresh) return undefined;
            published.push(fresh);
        }
        return { key, dir, value: rec.value, builtAtMs: rec.builtAtMs, ms: rec.ms, published, cached: true };
    }

    /**
     * Runs `produce` into a fresh temp dir and renames it into the entry, then publishes. With `bypass`, an existing
     * entry is ignored and replaced. Concurrent identical requests share one run.
     */
    run<T>(stage: string, key: string, produce: (dir: string) => Promise<{ value: T; inputs?: Record<string, unknown> }>,
        opts: { publish?: (dir: string, value: T) => PublishRequest[]; bypass?: boolean } = {}): Promise<CachedStage<T>> {
        if (!opts.bypass) {
            const hit = this.get<T>(stage, key);
            if (hit) return Promise.resolve(hit);
        }
        const id = `${stage}/${key}`;
        const pending = this.inFlight.get(id);
        if (pending) return pending as Promise<CachedStage<T>>;
        const work = this.produceEntry(stage, key, produce, opts.publish).finally(() => this.inFlight.delete(id));
        this.inFlight.set(id, work as Promise<CachedStage<unknown>>);
        return work;
    }

    private async produceEntry<T>(stage: string, key: string, produce: (dir: string) => Promise<{ value: T; inputs?: Record<string, unknown> }>,
        publish?: (dir: string, value: T) => PublishRequest[]): Promise<CachedStage<T>> {
        const dir = this.entryDir(stage, key);
        fs.mkdirSync(path.dirname(dir), { recursive: true });
        const tmp = `${dir}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
        fs.mkdirSync(tmp);
        const started = this.now();
        try {
            const { value, inputs } = await produce(tmp);
            const builtAtMs = this.now();
            const rec: StageCacheRecord<T> = {
                schema: 'scratchbox.stage-cache/1', stage, key, value, builtAtMs, ms: builtAtMs - started,
                ...(inputs ? { inputs } : {}), published: []
            };
            fs.writeFileSync(path.join(tmp, 'done.json'), JSON.stringify(rec));
            fs.rmSync(dir, { recursive: true, force: true });
            fs.renameSync(tmp, dir);
            // publish from the final entry (sources inside it are given relative to it)
            const requests = publish ? publish(dir, value) : [];
            rec.published = requests.map(r => this.publishFile(path.isAbsolute(r.from) ? r.from : path.join(dir, r.from), r.as));
            this.writeRecord(dir, rec);
            return { key, dir, value, builtAtMs, ms: rec.ms, published: rec.published, cached: false };
        } catch (err) {
            fs.rmSync(tmp, { recursive: true, force: true });
            throw err;
        }
    }

    /**
     * Records a result whose files live in another service's cache (tile_refine, tile_vegetation): no files are copied
     * into the entry, only the value and the published copies (atomic, sha-checked).
     */
    remember<T>(stage: string, key: string, value: T, publish: PublishRequest[], extra: { ms?: number; builtAtMs?: number; inputs?: Record<string, unknown> } = {}): CachedStage<T> {
        const dir = this.entryDir(stage, key);
        fs.mkdirSync(dir, { recursive: true });
        const builtAtMs = extra.builtAtMs ?? this.now();
        const rec: StageCacheRecord<T> = {
            schema: 'scratchbox.stage-cache/1', stage, key, value, builtAtMs, ms: extra.ms ?? 0,
            ...(extra.inputs ? { inputs: extra.inputs } : {}),
            published: publish.map(r => this.publishFile(r.from, r.as))
        };
        this.writeRecord(dir, rec);
        return { key, dir, value, builtAtMs, ms: rec.ms, published: rec.published, cached: false };
    }

    private writeRecord(dir: string, rec: StageCacheRecord<unknown>): void {
        const file = path.join(dir, 'done.json');
        const tmp = `${file}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
        fs.writeFileSync(tmp, JSON.stringify(rec));
        fs.renameSync(tmp, file);
    }

    /** Copies `source` to public/models/<name> through a temp file and a rename; an identical file is kept as it is. */
    publishFile(source: string, name: string): PublishedFile {
        if (!PUBLISH_NAME.test(name)) throw new Error(`stage cache: bad publish name "${name}"`);
        if (!fs.existsSync(source)) throw new Error(`stage cache: nothing to publish at ${source}`);
        const bytes = fs.statSync(source).size;
        const sha256 = sha256File(source);
        fs.mkdirSync(this.modelsDir, { recursive: true });
        const target = path.join(this.modelsDir, name);
        const same = fs.existsSync(target) && fs.statSync(target).size === bytes && sha256File(target) === sha256;
        if (!same) {
            const tmp = path.join(this.modelsDir, `.${name}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`);
            try {
                fs.copyFileSync(source, tmp);
                fs.renameSync(tmp, target);
            } catch (err) {
                fs.rmSync(tmp, { force: true });
                throw err;
            }
        }
        return { name, path: target, url: `/models/${name}`, bytes, sha256, source };
    }

    /** The published file as recorded, republished from its source when it is missing or differs; undefined when it cannot be. */
    private verifyPublished(p: PublishedFile): PublishedFile | undefined {
        const ok = fs.existsSync(p.path) && fs.statSync(p.path).size === p.bytes && sha256File(p.path) === p.sha256;
        if (ok) return p;
        if (!fs.existsSync(p.source) || fs.statSync(p.source).size !== p.bytes || sha256File(p.source) !== p.sha256) return undefined;
        return this.publishFile(p.source, p.name);
    }

    negative(stage: string, key: string, binarySha256?: string): NegativeRecord | undefined {
        const file = path.join(this.entryDir(stage, key) + '.negative.json');
        if (!fs.existsSync(file)) return undefined;
        try {
            const rec = JSON.parse(fs.readFileSync(file, 'utf8')) as NegativeRecord;
            // a failure of another engine build says nothing about this one
            if (binarySha256 && rec.binarySha256 && rec.binarySha256 !== binarySha256) return undefined;
            return rec;
        } catch {
            return undefined;
        }
    }

    putNegative(stage: string, key: string, rec: Omit<NegativeRecord, 'schema' | 'stage' | 'key' | 'atMs'>): NegativeRecord {
        const full: NegativeRecord = { schema: 'scratchbox.stage-negative/1', stage, key, ...rec, atMs: this.now() };
        const file = this.entryDir(stage, key) + '.negative.json';
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, JSON.stringify(full));
        return full;
    }

    clearNegative(stage: string, key: string): void {
        fs.rmSync(this.entryDir(stage, key) + '.negative.json', { force: true });
    }

    runRecordPath(runId: string): string {
        if (!RUN_ID.test(runId)) throw new Error(`stage cache: bad run id "${runId}" (8 hex digits)`);
        return path.join(this.dir, 'runs', runId, 'stages.json');
    }

    writeRunRecord(runId: string, record: unknown): void {
        const file = this.runRecordPath(runId);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        const tmp = `${file}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
        fs.writeFileSync(tmp, JSON.stringify(record, null, 1));
        fs.renameSync(tmp, file);
    }

    readRunRecord<T>(runId: string): T | undefined {
        const file = this.runRecordPath(runId);
        if (!fs.existsSync(file)) return undefined;
        return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
    }
}
