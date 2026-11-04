/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The place store (docs/research/2026-11-03-district-run-over-run-plan.md, section 4): the scene object store's
 * (asset-store/scene-object-store.ts) cloud side for one real place, so each run at a place starts from what the last
 * one left, on any machine, and a run never makes an object worse or loses one.
 *
 * The working copy is the scene object store under the user's Scratchbox home: per-object versioned GLBs
 * (`building/<Google vector feature id>`, `tree/<catalog id>`, the ground), each version measured by the completeness
 * audit and made current only when no measure gets worse. This module copies a run's objects to the place's store and
 * keeps the place's own record:
 *
 * **Where.** `gs://<training bucket>/places/v1/<place key>/` (the bucket the cache mirror already writes, through the
 * same service-account credentials: training-pair-capture.ts defaultTrainingBucket). When that bucket is not configured
 * or cannot be reached, `/Volumes/G-RAID MIRROR/scratchbox-places/<place key>/` on macOS (SCRATCHBOX_PLACE_STORE_FALLBACK
 * names another, and is the only fallback elsewhere), only when that volume is mounted: a missing mount is never created on
 * the system disk. With neither, the store is `none` and every call reports why and changes nothing. Which one is in use is
 * always reported (PlaceStore.where); opening the store never throws.
 *
 * **What.**
 *   - `manifest.json`: the place's ENU anchor, radius, grown edge and chunk grid, the code version and switches of the
 *     last sync, the audit's summary (its trees among it), an index of the objects, the runs that synced, and the
 *     writer's lease;
 *   - `objects/<object key>.json`: one per object (`<kind>/<identity>@<frame>`), every version any machine synced (the
 *     object store's record of it: measures, defects, decision, inputs, provenance), and the version current here;
 *   - `blobs/<sha256[0:2]>/<sha256>.glb`: the GLB of every version that has been current here, content-addressed.
 *
 * **One writer at a time.** The manifest carries a lease, taken and released with a generation precondition on the
 * manifest (VersionedCloudBucket.putFileIfGeneration): of two writers that read the same manifest only one write lands.
 * A lease that outlives PLACE_STORE_PARAMS.leaseMs is taken for a crashed writer's and may be taken over; its holder then
 * finds its own manifest write refused and reports that it lost the lease. Readers never need the lease.
 *
 * **Never worse here either.** The version current on this machine is offered; it becomes current in the place store
 * only when no measure of the place's current version gets worse (the object store's own rule, worseMeasures), so a
 * machine that never saw the place's best version cannot replace it with a worse one.
 *
 * **The run ledger's sync rules** (run-ledger-sync.ts on the ledger's branch): records are union-merged with what the
 * bucket already holds, by the version's input hash, so a writer that missed a version cannot drop it; and every path
 * under the workspace leaves workspace-relative, since an absolute path is meaningless on another machine.
 */

import { execFileSync } from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { worseMeasures, type ObjectRecord, type SceneObjectStore } from '../../asset-store/scene-object-store';
import { DirectoryCloudBucket, isVersionedBucket, NO_GENERATION, type CloudBucket, type VersionedCloudBucket } from '../../cloud-store/cloud-bucket';
import { defaultTrainingBucket } from '../../cloud-store/training-pair-capture';

export const PLACE_STORE_SCHEMA = 'scratchbox.place-store/1';
export const PLACE_OBJECT_SCHEMA = 'scratchbox.place-object/1';
export const PLACE_STORE_PREFIX = 'places/v1';
/** The fallback on macOS: the Mac's G-RAID volume. Elsewhere there is none unless SCRATCHBOX_PLACE_STORE_FALLBACK names one. */
export const PLACE_STORE_FALLBACK_ROOT = '/Volumes/G-RAID MIRROR/scratchbox-places';

export const PLACE_STORE_PARAMS = {
    /** A lease not released by then is taken for a crashed writer's and may be taken over (ms). */
    leaseMs: 20 * 60_000,
    /** Objects and blobs written at once. */
    concurrency: 6
};

/**
 * SCRATCHBOX_PLACE_STORE=1 audits a chunked district and copies its objects to the place store. Off by default. It keeps
 * the scene object store's versions, so that store must be on too (scene-objects.ts objectStoreEnabled; SCRATCHBOX_OBJECT_STORE).
 */
export function placeStoreEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
    return env.SCRATCHBOX_PLACE_STORE?.trim() === '1';
}

/** What built a sync: the commit, and the versions of the modules that matter to it. */
export interface PlaceCodeVersion { commit?: string; modules: Record<string, string> }

export interface PlaceLease { holder: string; host: string; runId?: string; takenAtMs: number; expiresAtMs: number }

export interface PlaceChunkGrid {
    version: string;
    cellM: number;
    cells: Array<{ index: number; cx: number; cz: number; half: number; rect: { x0: number; z0: number; x1: number; z1: number }; centre: boolean; buildings: string[] }>;
}

/** One version of an object as the place store holds it: the object store's record, where it came from, and its blob once stored. */
export interface PlaceObjectVersion { inputHash: string; record: ObjectRecord; host: string; runId?: string; syncedAtMs: number; blob?: string }

export interface PlaceObjectRecord {
    schema: typeof PLACE_OBJECT_SCHEMA;
    objectKey: string;
    kind: string;
    identity: string;
    /** The input hash of the version current in the place store. */
    current?: string;
    /** Every version any machine synced, oldest first. */
    versions: PlaceObjectVersion[];
    /** Each time a machine offered a version other than the current one: whether it became current here, and why. */
    decisions: Array<{ inputHash: string; atMs: number; runId?: string; host: string; kept: boolean; reason: string }>;
}

export interface PlaceManifest {
    schema: typeof PLACE_STORE_SCHEMA;
    key: string;
    /** The place's ENU anchor (the district frame's origin). */
    anchor?: { lat: number; lng: number; originEllipsoidalHeightM?: number; address?: string };
    radiusM?: number;
    /** The district's grown edge: the disc of radiusM, grown by these buildings' whole footprints. */
    edge?: { radiusM: number; grownBy: string[] };
    chunks?: PlaceChunkGrid;
    codeVersion?: PlaceCodeVersion;
    switches?: Record<string, string>;
    /** The last audit's summary (district-completeness-audit.ts), its trees among it. */
    audit?: unknown;
    /** Index of the objects: their record's key, the version current here, and the defects it carries. */
    objects: Record<string, { key: string; kind: string; current?: string; defects: number; updatedAtMs: number }>;
    runs: Array<{ runId: string; atMs: number; host: string; added: number; promoted: number; rejected: number; unchanged: number }>;
    lease?: PlaceLease;
    createdAtMs: number;
    updatedAtMs: number;
}

/** Which store is in use: the cloud bucket, the local fallback volume, or none, with why when it is not the cloud. */
export interface PlaceStoreLocation { kind: 'cloud' | 'fallback' | 'none'; label: string; reason?: string }

export interface PlaceStore {
    key: string;
    where: PlaceStoreLocation;
    bucket?: VersionedCloudBucket;
    /** Object keys of this place start with it. */
    prefix: string;
    tmpDir: string;
}

const KEY_PART = /^[A-Za-z0-9._-]+$/;

/** The place's key: its anchor to five decimals (about a metre), so the same geocode reaches the same store. */
export function placeKey(place: { lat: number; lng: number }): string {
    return `${place.lat.toFixed(5)}_${place.lng.toFixed(5)}`;
}

/** A record's object key: the id itself when it is a key already, else its characters made safe and its hash added (object keys hold '/' and '@'). */
export function recordKey(id: string): string {
    if (KEY_PART.test(id) && id.length <= 120 && id !== '.' && id !== '..') return id;
    const safe = id.replace(/[^A-Za-z0-9._-]+/g, '.').replace(/^\.+|\.+$/g, '').slice(0, 100);
    return `${safe || 'record'}-${crypto.createHash('sha256').update(id).digest('hex').slice(0, 10)}`;
}

/**
 * Opens the place's store: the cloud bucket when it answers, else the fallback volume when it is mounted, else none.
 * `bucket` undefined uses the training bucket; null means no cloud bucket. Never throws.
 */
export async function openPlaceStore(opts: { key: string; bucket?: CloudBucket | null; fallbackRoot?: string; tmpDir?: string; env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform }): Promise<PlaceStore> {
    const env = opts.env ?? process.env;
    const tmpDir = opts.tmpDir ?? path.join(os.tmpdir(), `sb-place-store-${process.pid}`);
    const base = { key: opts.key, tmpDir };
    let why: string;
    let bucket: CloudBucket | undefined;
    try {
        bucket = opts.bucket === undefined ? defaultTrainingBucket() : opts.bucket ?? undefined;
        why = bucket ? '' : 'no cloud bucket is configured (SCRATCHBOX_TRAINING_BUCKET, or trainingBucket in cloud-store.json)';
    } catch (err) {
        why = `the cloud bucket could not be opened (${errorMessage(err)})`;
    }
    if (bucket && !isVersionedBucket(bucket)) why = `${bucket.label} cannot hold a lease (it has no generation preconditions)`;
    else if (bucket) {
        const prefix = `${PLACE_STORE_PREFIX}/${opts.key}`;
        try {
            await bucket.list(`${prefix}/manifest.json`);
            return { ...base, where: { kind: 'cloud', label: `${bucket.label}/${prefix}` }, bucket, prefix };
        } catch (err) {
            why = `${bucket.label} could not be reached (${errorMessage(err)})`;
        }
    }
    const root = opts.fallbackRoot ?? (env.SCRATCHBOX_PLACE_STORE_FALLBACK?.trim() || ((opts.platform ?? process.platform) === 'darwin' ? PLACE_STORE_FALLBACK_ROOT : undefined));
    if (!root) return { ...base, where: { kind: 'none', label: '', reason: `${why}; no fallback volume on this machine (SCRATCHBOX_PLACE_STORE_FALLBACK names one)` }, prefix: opts.key };
    // the volume must already be there: a missing mount point is never made on the system disk
    const volume = path.dirname(root);
    try {
        fs.accessSync(volume, fs.constants.W_OK);
        fs.mkdirSync(path.join(root, opts.key), { recursive: true });
        const dir = new DirectoryCloudBucket(root);
        return { ...base, where: { kind: 'fallback', label: `${dir.label}/${opts.key}`, reason: why }, bucket: dir, prefix: opts.key };
    } catch (err) {
        return { ...base, where: { kind: 'none', label: '', reason: `${why}; the fallback ${root} is not available (${errorMessage(err)})` }, prefix: opts.key };
    }
}

const manifestKey = (store: PlaceStore) => `${store.prefix}/manifest.json`;
const objectRecordKey = (store: PlaceStore, objectKey: string) => `${store.prefix}/objects/${recordKey(objectKey)}.json`;
const blobKey = (store: PlaceStore, sha256: string) => `${store.prefix}/blobs/${sha256.slice(0, 2)}/${sha256}.glb`;

function scratchFile(store: PlaceStore, name: string): string {
    fs.mkdirSync(store.tmpDir, { recursive: true });
    return path.join(store.tmpDir, `${name}-${crypto.randomBytes(6).toString('hex')}.json`);
}

async function readJson<T>(store: PlaceStore, key: string): Promise<{ value: T; generation: string } | undefined> {
    const file = scratchFile(store, 'read');
    try {
        const generation = await store.bucket!.downloadVersioned(key, file);
        if (generation === undefined) return undefined;
        return { value: JSON.parse(fs.readFileSync(file, 'utf8')) as T, generation };
    } finally {
        fs.rmSync(file, { force: true });
    }
}

/** Writes `value` as the object, only over `generation` when one is given. */
async function writeJson(store: PlaceStore, key: string, value: unknown, generation?: string): Promise<{ generation: string } | 'conflict'> {
    const file = scratchFile(store, 'write');
    try {
        fs.writeFileSync(file, JSON.stringify(value));
        const opts = { contentType: 'application/json', metadata: { place: store.key } };
        if (generation !== undefined) return await store.bucket!.putFileIfGeneration(key, file, generation, opts);
        await store.bucket!.putFile(key, file, opts);
        return { generation: '' };
    } finally {
        fs.rmSync(file, { force: true });
    }
}

/** The manifest and the generation it was read at; undefined when the place has none yet. */
export async function loadPlaceManifest(store: PlaceStore): Promise<{ manifest: PlaceManifest; generation: string } | undefined> {
    if (!store.bucket) return undefined;
    const r = await readJson<PlaceManifest>(store, manifestKey(store));
    return r ? { manifest: r.value, generation: r.generation } : undefined;
}

export async function loadPlaceObject(store: PlaceStore, objectKey: string): Promise<PlaceObjectRecord | undefined> {
    if (!store.bucket) return undefined;
    return (await readJson<PlaceObjectRecord>(store, objectRecordKey(store, objectKey)))?.value;
}

export type LeaseResult = { ok: true; generation: string; manifest: PlaceManifest; lease: PlaceLease } | { ok: false; reason: string; heldBy?: PlaceLease };

/**
 * Takes the place's lease: the manifest rewritten with this holder's lease, only over the generation it was read at. Fails
 * while another holder's lease runs, or when another writer's write landed first.
 */
export async function acquirePlaceLease(store: PlaceStore, who: { holder: string; runId?: string }, now = Date.now(), P = PLACE_STORE_PARAMS): Promise<LeaseResult> {
    if (!store.bucket) return { ok: false, reason: store.where.reason ?? 'no place store' };
    const read = await loadPlaceManifest(store);
    const held = read?.manifest.lease;
    if (held && held.holder !== who.holder && held.expiresAtMs > now) {
        return { ok: false, reason: `the place is being written by ${held.holder} until ${new Date(held.expiresAtMs).toISOString()}`, heldBy: held };
    }
    const lease: PlaceLease = { holder: who.holder, host: os.hostname(), ...(who.runId ? { runId: who.runId } : {}), takenAtMs: now, expiresAtMs: now + P.leaseMs };
    const manifest: PlaceManifest = read?.manifest
        ? { ...read.manifest, lease }
        : { schema: PLACE_STORE_SCHEMA, key: store.key, objects: {}, runs: [], lease, createdAtMs: now, updatedAtMs: now };
    const w = await writeJson(store, manifestKey(store), manifest, read?.generation ?? NO_GENERATION);
    if (w === 'conflict') return { ok: false, reason: 'another writer changed the manifest first' };
    return { ok: true, generation: w.generation, manifest, lease };
}

/** Writes the manifest over the generation this holder last wrote, with its lease (`keep`) or without it (released). */
export async function writeLeasedManifest(store: PlaceStore, manifest: PlaceManifest, generation: string, keep: boolean): Promise<{ generation: string } | 'conflict'> {
    const { lease, ...rest } = manifest;
    return writeJson(store, manifestKey(store), keep && lease ? { ...rest, lease } : rest, generation);
}

/** Releases the lease without other changes; false when another writer holds the manifest now. */
export async function releasePlaceLease(store: PlaceStore, held: { generation: string; manifest: PlaceManifest }): Promise<boolean> {
    if (!store.bucket) return false;
    return (await writeLeasedManifest(store, held.manifest, held.generation, false)) !== 'conflict';
}

/** The union of two copies of an object's record: every version either holds (by input hash), every decision, and the current version the newer copy names. */
export function mergePlaceObjects(remote: PlaceObjectRecord | undefined, local: PlaceObjectRecord): PlaceObjectRecord {
    if (!remote) return local;
    // a version is immutable under its input hash: the copy first synced stands, gaining a blob once one is stored
    const byHash = new Map<string, PlaceObjectVersion>();
    for (const v of remote.versions) byHash.set(v.inputHash, v);
    for (const v of local.versions) {
        const had = byHash.get(v.inputHash);
        byHash.set(v.inputHash, had ? { ...had, ...(v.blob && !had.blob ? { blob: v.blob } : {}) } : v);
    }
    const seen = new Set<string>();
    const decisions = [...remote.decisions, ...local.decisions].filter(d => { const k = `${d.inputHash}:${d.atMs}:${d.host}`; if (seen.has(k)) return false; seen.add(k); return true; }).sort((a, b) => a.atMs - b.atMs);
    return { ...remote, ...local, versions: [...byHash.values()].sort((a, b) => a.syncedAtMs - b.syncedAtMs), decisions };
}

/**
 * Every string under `root` rewritten relative to it, through the whole value (the run ledger's rule): a path is
 * absolute on the machine that wrote it and dead anywhere else. The root itself becomes '.'; paths outside it are left alone.
 */
export function relativisePaths<T>(value: T, root: string): T {
    const prefix = root.endsWith(path.sep) ? root : root + path.sep;
    const walk = (v: unknown): unknown => {
        if (typeof v === 'string') return v === root ? '.' : v.startsWith(prefix) ? v.slice(prefix.length) : v;
        if (Array.isArray(v)) return v.map(walk);
        if (v && typeof v === 'object') {
            const out: Record<string, unknown> = {};
            for (const [k, x] of Object.entries(v as Record<string, unknown>)) out[k] = walk(x);
            return out;
        }
        return v;
    };
    return walk(value) as T;
}

/** The code a sync was built with: SCRATCHBOX_CODE_VERSION (a container has no .git), else the workspace's commit. */
export function placeCodeVersion(workspaceRoot: string, modules: Record<string, string>, env: NodeJS.ProcessEnv = process.env): PlaceCodeVersion {
    const asked = env.SCRATCHBOX_CODE_VERSION?.trim();
    if (asked) return { commit: asked, modules };
    try {
        const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: workspaceRoot, encoding: 'utf8', timeout: 5_000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
        return /^[0-9a-f]{7,64}$/.test(commit) ? { commit, modules } : { modules };
    } catch {
        return { modules };
    }
}

/** A run's objects to copy to the place, and the place's own fields. */
export interface PlaceSync {
    runId: string;
    holder?: string;
    /** The object store holding the run's versions (the working copy). */
    objects: SceneObjectStore;
    /** The objects the run kept (scene-objects.ts storeSceneObjects report.kept), by object key. */
    objectKeys: string[];
    anchor: NonNullable<PlaceManifest['anchor']>;
    radiusM: number;
    edge: NonNullable<PlaceManifest['edge']>;
    chunks?: PlaceChunkGrid;
    codeVersion: PlaceCodeVersion;
    switches: Record<string, string>;
    audit?: unknown;
    workspaceRoot: string;
    now?: () => number;
}

export interface PlaceSyncReport {
    where: PlaceStoreLocation;
    key: string;
    /** Set when nothing was synced, with why. */
    skipped?: string;
    objects: { added: number; promoted: number; rejected: number; unchanged: number };
    /** Each object whose current version here is not the one this machine offered, or that changed here, with why. */
    decisions: Array<{ objectKey: string; kept: boolean | 'unchanged'; reason: string }>;
    blobs: { stored: number; existing: number; bytes: number; missing: string[] };
    errors: string[];
    ms: number;
}

async function eachLimited<T>(items: T[], limit: number, run: (item: T) => Promise<void>): Promise<void> {
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => { while (next < items.length) await run(items[next++]); }));
}

/**
 * A run's objects copied to the place store under its lease: for each object, every version the object store holds is
 * added to the place's record (union by input hash), the version current on this machine is offered and becomes current
 * here unless it would make the place's current version worse, its GLB is stored as a blob, and the record is written
 * with workspace-relative paths; then the manifest is written and the lease released in one generation-matched write.
 * Never throws: what went wrong is in the report.
 */
export async function syncPlaceObjects(store: PlaceStore, sync: PlaceSync, P = PLACE_STORE_PARAMS): Promise<PlaceSyncReport> {
    const now = sync.now ?? Date.now;
    const t0 = now();
    const host = os.hostname();
    const report: PlaceSyncReport = { where: store.where, key: store.key, objects: { added: 0, promoted: 0, rejected: 0, unchanged: 0 }, decisions: [], blobs: { stored: 0, existing: 0, bytes: 0, missing: [] }, errors: [], ms: 0 };
    const done = (skipped?: string) => ({ ...report, ...(skipped ? { skipped } : {}), ms: now() - t0 });
    if (!store.bucket) return done(store.where.reason ?? 'no place store');
    let held: LeaseResult;
    try {
        held = await acquirePlaceLease(store, { holder: sync.holder ?? `${host}:${process.pid}:${sync.runId}`, runId: sync.runId }, now(), P);
    } catch (err) {
        return done(`the lease could not be taken (${errorMessage(err)})`);
    }
    if (!held.ok) return done(held.reason);
    const leased = held;
    const manifest: PlaceManifest = { ...leased.manifest, objects: { ...leased.manifest.objects }, runs: [...leased.manifest.runs] };
    try {
        await eachLimited([...new Set(sync.objectKeys)], P.concurrency, async objectKey => {
            try {
                const rows = sync.objects.versions(objectKey);
                const cur = sync.objects.current(objectKey);
                if (!rows.length || !cur) throw new Error('the object store holds no version of it');
                const atMs = now();
                const versions: PlaceObjectVersion[] = [];
                for (const row of rows) {
                    const record = sync.objects.recordOf(row);
                    if (record) versions.push({ inputHash: row.inputHash, record, host, ...(row.runId ? { runId: row.runId } : {}), syncedAtMs: atMs });
                }
                const offered = versions.find(v => v.inputHash === cur.inputHash);
                if (!offered) throw new Error(`the record of its current version ${cur.version} is missing`);
                const remote = await loadPlaceObject(store, objectKey);
                const remoteCurrent = remote?.current ? remote.versions.find(v => v.inputHash === remote.current) : undefined;
                // the place's current version stays unless the offered one is no worse by every measure it carries
                let kept: boolean | 'unchanged', reason: string;
                if (!remoteCurrent) { kept = true; reason = 'the first version of this object in the place store'; }
                else if (remoteCurrent.inputHash === offered.inputHash) { kept = 'unchanged'; reason = 'already the current version here'; }
                else {
                    const worse = worseMeasures(remoteCurrent.record.measures ?? {}, offered.record.measures ?? {});
                    kept = !worse.length;
                    reason = worse.length ? `the place's current version stays: ${worse.join('; ')}` : 'no measure is worse than the place\'s current version';
                }
                const current = kept === false ? remoteCurrent!.inputHash : offered.inputHash;
                // the GLB of the version current here, once
                if (kept === true || (kept === 'unchanged' && !remoteCurrent?.blob)) {
                    const glb = sync.objects.store.lookup(cur.glbPath);
                    if (!glb) report.blobs.missing.push(objectKey);
                    else {
                        const state = await store.bucket!.putFile(blobKey(store, cur.glbSha256), glb.file, { onlyIfAbsent: true, contentType: 'model/gltf-binary', metadata: { place: store.key, objectKey, sha256: cur.glbSha256 } });
                        if (state === 'stored') { report.blobs.stored++; report.blobs.bytes += glb.bytes; } else report.blobs.existing++;
                        offered.blob = blobKey(store, cur.glbSha256);
                    }
                }
                const local: PlaceObjectRecord = {
                    schema: PLACE_OBJECT_SCHEMA, objectKey, kind: cur.kind, identity: cur.identity, current, versions,
                    decisions: kept === 'unchanged' ? [] : [{ inputHash: offered.inputHash, atMs, runId: sync.runId, host, kept, reason }]
                };
                const merged = relativisePaths(mergePlaceObjects(remote, local), sync.workspaceRoot);
                await writeJson(store, objectRecordKey(store, objectKey), merged);
                if (!remoteCurrent) report.objects.added++;
                else if (kept === 'unchanged') report.objects.unchanged++;
                else if (kept) report.objects.promoted++;
                else report.objects.rejected++;
                if (kept !== 'unchanged') report.decisions.push({ objectKey, kept, reason });
                const here = merged.versions.find(v => v.inputHash === merged.current);
                manifest.objects[objectKey] = { key: recordKey(objectKey), kind: cur.kind, ...(merged.current ? { current: merged.current } : {}), defects: here?.record.defects?.length ?? 0, updatedAtMs: atMs };
            } catch (err) {
                report.errors.push(`${objectKey}: ${errorMessage(err)}`);
            }
        });
        const atMs = now();
        const next: PlaceManifest = {
            ...manifest, anchor: sync.anchor, radiusM: sync.radiusM, edge: sync.edge, ...(sync.chunks ? { chunks: sync.chunks } : {}), codeVersion: sync.codeVersion,
            switches: sync.switches, ...(sync.audit !== undefined ? { audit: sync.audit } : {}),
            runs: [...manifest.runs.filter(r => r.runId !== sync.runId), { runId: sync.runId, atMs, host, ...report.objects }].sort((a, b) => a.atMs - b.atMs), updatedAtMs: atMs
        };
        // the manifest and the release in one write, over the generation the lease was taken at
        const w = await writeLeasedManifest(store, relativisePaths(next, sync.workspaceRoot), leased.generation, false);
        if (w === 'conflict') report.errors.push('the lease ran out and another writer took the place before the manifest was written: the object records written stand (union-merged), the manifest does not list this run');
        else {
            // this machine keeps the place's manifest too, beside the objects (the asset store's recipes)
            const { lease, ...body } = next;
            void lease;
            try { sync.objects.store.putRecipe({ id: `place:${store.key}`, kind: 'place-manifest', body: relativisePaths(body, sync.workspaceRoot) }); } catch (err) { report.errors.push(`the local copy of the manifest: ${errorMessage(err)}`); }
        }
        return done();
    } catch (err) {
        report.errors.push(errorMessage(err));
        await releasePlaceLease(store, leased).catch(() => false);
        return done();
    }
}

function errorMessage(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}
