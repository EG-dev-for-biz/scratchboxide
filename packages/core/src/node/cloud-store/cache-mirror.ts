/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The build caches kept in the training bucket beside the training pairs (user decision, 2026-10-29: train regressors on
 * them): every staged build's stage entries (staged_location/<stage>/<key>/: done.json with each stage's value, inputs and
 * timings, and its files), its run records (staged_location/runs/<runId>/: the request, every stage's key, the timeline,
 * the run notes), and the native caches they reference (tile_refine/<key>/, tile_vegetation/<key>/), as
 * `cache/v1/<root>/<path as on disk>`.
 *
 * Each root is synced file by file against a manifest kept beside it (<root>/.cloud-mirror.json: each file's size and
 * modification time when it was sent), so a file is sent once and again only when it changed (a native entry grows
 * sub-folders after its done.json; a run's notes are rewritten as it goes). Files still being written (temp names, or
 * changed in the last `settleMs`) wait for the next sync. A sync runs on the server's own thread after every staged
 * build, one at a time (a build that ends during one queues one more).
 *
 * Only where a training bucket is configured (training-pair-capture.ts resolveTrainingBucketName), and not with
 * SCRATCHBOX_CACHE_MIRROR=off. Nothing here ever fails a build: a file that could not be sent is tried again next sync.
 *
 * And back (restoreCacheEntry): a stage entry the workspace lacks is read from the bucket before the stage runs
 * (stage-cache.ts `restore`, wired in staged-location-tool.ts; SCRATCHBOX_CACHE_RESTORE=off never), with the native and
 * stage entries it points at, so a wiped cache or another machine rebuilds a scene from what was built before.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { CloudBucket } from './cloud-bucket';
import { defaultTrainingBucket } from './training-pair-capture';

export const CACHE_MIRROR_PREFIX = 'cache/v1';
const MANIFEST = '.cloud-mirror.json';

export const CACHE_MIRROR_PARAMS = {
    /** A file changed this recently may still be being written: it waits for the next sync (ms). */
    settleMs: 60_000,
    /** Uploads at once. */
    concurrency: 6,
    /** The manifest is saved after this many uploads, so an interrupted sync loses little. */
    saveEvery: 25
};

export interface CacheMirrorReport { root: string; files: number; uploaded: number; bytes: number; unchanged: number; waiting: number; skipped: number; failed: number; errors: string[]; ms: number }

/** The bucket the caches go to, or undefined when this instance does not mirror them. */
export function cacheMirrorBucket(): CloudBucket | undefined {
    if (process.env.SCRATCHBOX_CACHE_MIRROR?.trim() === 'off') return undefined;
    return defaultTrainingBucket();
}

const KEY_PART = /^[A-Za-z0-9._-]+$/;

/** Every file under `dir` (relative paths, '/'), leaving out hidden files and anything with a temp name on its way. */
function walk(dir: string, rel = '', out: string[] = []): string[] {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(path.join(dir, rel), { withFileTypes: true }); } catch { return out; }
    for (const e of entries) {
        if (e.name.startsWith('.') || e.name.includes('.tmp')) continue;
        const r = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) walk(dir, r, out);
        else if (e.isFile()) out.push(r);
    }
    return out;
}

/**
 * Sends what changed under `root` to `<prefix>/<path>` in the bucket: each file whose size or modification time differs
 * from the manifest's record, once it has settled. Returns what it did; never throws for a file.
 */
export async function syncCacheDir(bucket: CloudBucket, root: string, prefix: string, P = CACHE_MIRROR_PARAMS, now = Date.now): Promise<CacheMirrorReport> {
    const t0 = now();
    const report: CacheMirrorReport = { root, files: 0, uploaded: 0, bytes: 0, unchanged: 0, waiting: 0, skipped: 0, failed: 0, errors: [], ms: 0 };
    if (!fs.existsSync(root)) return { ...report, ms: now() - t0 };
    const manifestFile = path.join(root, MANIFEST);
    let manifest: { bucket: string; files: Record<string, string> } = { bucket: bucket.label, files: {} };
    try {
        const m = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
        // another bucket's manifest says nothing about this one
        if (m?.bucket === bucket.label && m.files && typeof m.files === 'object') manifest = m;
    } catch { /* none yet */ }
    const save = () => { const tmp = `${manifestFile}.tmp-${process.pid}`; fs.writeFileSync(tmp, JSON.stringify(manifest)); fs.renameSync(tmp, manifestFile); };
    const todo: Array<{ rel: string; stamp: string; bytes: number }> = [];
    for (const rel of walk(root)) {
        report.files++;
        if (!rel.split('/').every(p => KEY_PART.test(p))) { report.skipped++; continue; }
        let st: fs.Stats;
        try { st = fs.statSync(path.join(root, rel)); } catch { continue; }
        const stamp = `${st.size}:${Math.round(st.mtimeMs)}`;
        if (manifest.files[rel] === stamp) { report.unchanged++; continue; }
        // settleMs 0 sends everything: a file just written can carry an mtime a fraction of a millisecond past now()
        if (P.settleMs > 0 && now() - st.mtimeMs < P.settleMs) { report.waiting++; continue; }
        todo.push({ rel, stamp, bytes: st.size });
    }
    let next = 0, sinceSave = 0;
    const host = os.hostname();
    await Promise.all(Array.from({ length: Math.min(P.concurrency, todo.length) }, async () => {
        while (next < todo.length) {
            const f = todo[next++];
            try {
                await bucket.putFile(`${prefix}/${f.rel}`, path.join(root, f.rel), {
                    contentType: f.rel.endsWith('.json') || f.rel.endsWith('.jsonl') ? 'application/json' : f.rel.endsWith('.glb') ? 'model/gltf-binary' : f.rel.endsWith('.png') ? 'image/png' : f.rel.endsWith('.jpg') ? 'image/jpeg' : 'application/octet-stream',
                    metadata: { host, root: path.basename(root), mtimeMs: f.stamp.split(':')[1] }
                });
                manifest.files[f.rel] = f.stamp;
                report.uploaded++; report.bytes += f.bytes;
                if (++sinceSave >= P.saveEvery) { sinceSave = 0; save(); }
            } catch (err) {
                report.failed++;
                if (report.errors.length < 5) report.errors.push(`${f.rel}: ${err instanceof Error ? err.message : String(err)}`);
            }
        }
    }));
    save();
    return { ...report, ms: now() - t0 };
}

/** The cache roots of a workspace that are mirrored, with their bucket prefixes. */
export function cacheMirrorRoots(workspaceRoot: string): Array<{ dir: string; prefix: string }> {
    const cache = path.join(workspaceRoot, '.scratchbox', 'cache');
    return ['staged_location', 'tile_refine', 'tile_vegetation'].map(name => ({ dir: path.join(cache, name), prefix: `${CACHE_MIRROR_PREFIX}/${name}` }));
}

let running: Promise<void> | undefined, again = false;

/**
 * Syncs every cache root of the workspace to the bucket in the background, one sync at a time (asked during one, one more
 * follows). Does nothing where no bucket is configured. Never throws.
 */
export function mirrorCachesInBackground(workspaceRoot: string, opts: { bucket?: CloudBucket; log?: (m: string) => void } = {}): void {
    const bucket = opts.bucket ?? cacheMirrorBucket();
    if (!bucket) return;
    const log = opts.log ?? ((m: string) => console.log(m));
    if (running) { again = true; return; }
    running = (async () => {
        let waiting = 0;
        do {
            again = false;
            waiting = 0;
            for (const r of cacheMirrorRoots(workspaceRoot)) {
                try {
                    const rep = await syncCacheDir(bucket, r.dir, r.prefix);
                    waiting += rep.waiting;
                    if (rep.uploaded || rep.failed) log(`[cache-mirror] ${bucket.label}/${r.prefix}: ${rep.uploaded} files sent (${(rep.bytes / 1e6).toFixed(0)} MB), ${rep.unchanged} unchanged, ${rep.waiting} still settling, ${rep.failed} failed${rep.errors.length ? ` (${rep.errors[0]})` : ''} in ${(rep.ms / 1000).toFixed(0)} s`);
                } catch (err) {
                    log(`[cache-mirror] ${r.prefix}: ${err instanceof Error ? err.message : String(err)}`);
                }
            }
        } while (again);
        // files written in the build's last minute are sent once they have settled
        if (waiting) setTimeout(() => mirrorCachesInBackground(workspaceRoot, opts), CACHE_MIRROR_PARAMS.settleMs + 5_000).unref();
    })().finally(() => { running = undefined; });
}

const RESTORE_ROOTS = ['staged_location', 'tile_refine', 'tile_vegetation'];
const SAFE_PART = (p: string) => KEY_PART.test(p) && p !== '.' && p !== '..';

/**
 * The other way: a cache entry this workspace lacks, read back from the bucket (`cache/v1/<root>/<path>/`), so a build on a
 * wiped cache or another machine reuses what was built before. `rel` is the entry as it lies in the cache
 * (`staged_location/<stage>/<key>`, `tile_refine/<key>`). Restored only when the bucket holds the entry whole (its
 * done.json); its files land in a temp dir that is renamed into place. The record's absolute paths are moved onto this
 * workspace (`…/.scratchbox/cache/…`, `…/public/models/…`; on the machine that built it they are the same), and the native
 * and stage entries it points at are restored first, so its published models can be published again from their sources.
 * The restored files are recorded in the mirror's manifest, not sent back. True when the entry is now here.
 */
export async function restoreCacheEntry(bucket: CloudBucket, workspaceRoot: string, rel: string, opts: { modelsDir?: string; seen?: Set<string> } = {}): Promise<boolean> {
    const parts = rel.split('/');
    if (!RESTORE_ROOTS.includes(parts[0]) || parts.length < 2 || !parts.every(SAFE_PART)) return false;
    const seen = opts.seen ?? new Set<string>();
    if (seen.has(rel)) return false;
    seen.add(rel);
    const cacheRoot = path.join(workspaceRoot, '.scratchbox', 'cache'), modelsDir = opts.modelsDir ?? path.join(workspaceRoot, 'public', 'models');
    const dir = path.join(cacheRoot, ...parts);
    if (fs.existsSync(path.join(dir, 'done.json'))) return true;
    const prefix = `${CACHE_MIRROR_PREFIX}/${rel}/`;
    const objects = (await bucket.list(prefix)).filter(o => o.key.startsWith(prefix) && o.key.slice(prefix.length).split('/').every(SAFE_PART));
    if (!objects.some(o => o.key === `${prefix}done.json`)) return false;
    const tmp = `${dir}.tmp-restore-${process.pid}-${Date.now()}`;
    try {
        for (const o of objects) {
            const file = path.join(tmp, ...o.key.slice(prefix.length).split('/'));
            fs.mkdirSync(path.dirname(file), { recursive: true });
            if (!(await bucket.download(o.key, file))) throw new Error(`${bucket.label}/${o.key} could not be read`);
        }
        // the record's paths onto this workspace
        const doneFile = path.join(tmp, 'done.json');
        const text = fs.readFileSync(doneFile, 'utf8')
            .replace(/"[^"]*?\/\.scratchbox\/cache\//g, () => JSON.stringify(`${cacheRoot}/`).slice(0, -1))
            .replace(/"[^"]*?\/public\/models\//g, () => JSON.stringify(`${modelsDir}/`).slice(0, -1));
        fs.writeFileSync(doneFile, text);
        // the entries it points at, restored first, so its sources are here when it is read
        const at = cacheRoot.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const refs = new Set<string>();
        for (const m of text.matchAll(new RegExp(`${at}/(tile_refine|tile_vegetation)/([A-Za-z0-9._-]+)`, 'g'))) refs.add(`${m[1]}/${m[2]}`);
        for (const m of text.matchAll(new RegExp(`${at}/staged_location/([a-z0-9][a-z0-9-]*)/([0-9a-f]{64})`, 'g'))) refs.add(`staged_location/${m[1]}/${m[2]}`);
        for (const r of refs) await restoreCacheEntry(bucket, workspaceRoot, r, { modelsDir, seen });
        if (fs.existsSync(path.join(dir, 'done.json'))) { fs.rmSync(tmp, { recursive: true, force: true }); return true; }
        fs.mkdirSync(path.dirname(dir), { recursive: true });
        fs.rmSync(dir, { recursive: true, force: true });
        fs.renameSync(tmp, dir);
    } catch (err) {
        fs.rmSync(tmp, { recursive: true, force: true });
        throw err;
    }
    // what came from the bucket is not sent back to it
    const manifestFile = path.join(cacheRoot, parts[0], MANIFEST);
    try {
        let manifest: { bucket: string; files: Record<string, string> } = { bucket: bucket.label, files: {} };
        try { const m = JSON.parse(fs.readFileSync(manifestFile, 'utf8')); if (m?.bucket === bucket.label && m.files) manifest = m; } catch { /* none yet */ }
        for (const f of walk(dir)) {
            const st = fs.statSync(path.join(dir, f));
            manifest.files[[...parts.slice(1), f].join('/')] = `${st.size}:${Math.round(st.mtimeMs)}`;
        }
        const t = `${manifestFile}.tmp-${process.pid}`;
        fs.writeFileSync(t, JSON.stringify(manifest));
        fs.renameSync(t, manifestFile);
    } catch { /* at worst the files are sent again */ }
    return true;
}
