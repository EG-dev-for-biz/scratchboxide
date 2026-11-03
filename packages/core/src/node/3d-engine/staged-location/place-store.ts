/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The place store (docs/research/2026-11-03-district-run-over-run-plan.md, section 4): a real place kept between runs,
 * so each run at a place starts from what the last one left and a run never makes a building worse or loses one. A
 * stage cache only replays identical inputs; this keeps the place itself.
 *
 * **Where.** `gs://<training bucket>/places/v1/<place key>/` (the bucket the cache mirror already writes, through the
 * same service-account credentials: training-pair-capture.ts defaultTrainingBucket). When that bucket is not configured
 * or cannot be reached, `/Volumes/G-RAID MIRROR/scratchbox-places/<place key>/` (SCRATCHBOX_PLACE_STORE_FALLBACK names
 * another), only when that volume is mounted: a missing mount is never created on the system disk. With neither, the
 * store is `none` and every call reports why and changes nothing. Which one is in use is always reported
 * (PlaceStore.where); opening the store never throws.
 *
 * **What.**
 *   - `manifest.json`: the place's ENU anchor, radius, grown edge and chunk grid, the code version of the last commit,
 *     an index of the records, the runs that committed, and the writer's lease;
 *   - `records/<record key>.json`: one record per building (keyed by its Google vector feature id, else its scan
 *     component), and one each for the ground and the trees. A record holds every version a run offered, kept or
 *     not, each with its files, provenance shares, measures, defects, the switches and code version that built it, and
 *     the decision with its reason; `current` names the version kept;
 *   - `blobs/<sha256[0:2]>/<sha256>.glb`: the files of kept versions, content-addressed (written once, never rewritten).
 *
 * **One writer at a time.** The manifest carries a lease, taken and released with a generation precondition on the
 * manifest (VersionedCloudBucket.putFileIfGeneration): of two writers that read the same manifest only one write lands.
 * A lease that outlives PLACE_STORE_PARAMS.leaseMs is taken for a crashed writer's and may be taken over; its holder then
 * finds its own commit refused and reports that it lost the lease. Readers never need the lease.
 *
 * **Promote or reject.** A new version is kept only when no measure of the current one gets worse (each measure says
 * which way is better, and a tolerance within which a change is noise) and none goes unmeasured; otherwise the current
 * version stays and the new one is recorded beside it with the reason. A version whose files are byte-identical to the
 * current one's adds nothing.
 *
 * **The run ledger's sync rules** (run-ledger-sync.ts on the ledger's branch): records are union-merged with what the
 * bucket already holds, by version identity, so a writer that missed a version cannot drop it; and every path under the
 * workspace leaves workspace-relative, since an absolute path is meaningless on another machine.
 */

import { execFileSync } from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { Vec2 } from '../../../common/spatial/staged-location-contracts';
import { DirectoryCloudBucket, isVersionedBucket, NO_GENERATION, type CloudBucket, type VersionedCloudBucket } from '../../cloud-store/cloud-bucket';
import { defaultTrainingBucket } from '../../cloud-store/training-pair-capture';

export const PLACE_STORE_SCHEMA = 'scratchbox.place-store/1';
export const PLACE_RECORD_SCHEMA = 'scratchbox.place-record/1';
export const PLACE_STORE_PREFIX = 'places/v1';
export const PLACE_STORE_FALLBACK_ROOT = '/Volumes/G-RAID MIRROR/scratchbox-places';

export const PLACE_STORE_PARAMS = {
    /** A lease not released by then is taken for a crashed writer's and may be taken over (ms). */
    leaseMs: 20 * 60_000,
    /** Records and blobs written at once. */
    concurrency: 6
};

/** SCRATCHBOX_PLACE_STORE=1 turns the store on for staged districts; off by default. */
export function placeStoreEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
    return env.SCRATCHBOX_PLACE_STORE?.trim() === '1';
}

/** One measure of a version: its value, which way is better, and the change within which it is not worse. */
export interface PlaceMeasure { value: number; better: 'lower' | 'higher'; tol?: number }
export type PlaceMeasures = Record<string, PlaceMeasure>;

/** A defect found in a version: what kind (a label), in words, and where when known (district frame, m; a view and a screen box from a critic). */
export interface PlaceDefect { kind: string; detail: string; source: string; at?: [number, number, number]; view?: string; box?: [number, number, number, number] }

/** A file of a version: its role (a label: 'clay', 'textured'), where it was written, its content hash, and its blob key once stored. */
export interface PlaceFile { role: string; path: string; sha256: string; bytes: number; blob?: string }

/** What built a version: the commit, and the versions of the modules that matter to it. */
export interface PlaceCodeVersion { commit?: string; modules: Record<string, string> }

export interface PlaceDecision {
    kept: boolean;
    reason: string;
    /** The version it was compared with. */
    comparedTo?: string;
    /** Measures that got worse, or went unmeasured, in words. */
    worse?: string[];
}

export interface PlaceVersion {
    /** The run that offered it: one version per record per run, so a retried run's version is the same one. */
    version: string;
    runId: string;
    atMs: number;
    files: PlaceFile[];
    /** Share of the record's surface area per provenance label. */
    provenance: Record<string, number>;
    measures: PlaceMeasures;
    defects: PlaceDefect[];
    switches: Record<string, string>;
    codeVersion: PlaceCodeVersion;
    /** The deterministic audit's own detail for this record (district-completeness-audit.ts). */
    audit?: unknown;
    decision: PlaceDecision;
}

export interface PlaceRecord {
    schema: typeof PLACE_RECORD_SCHEMA;
    id: string;
    /** What the id is (a label: a Google vector feature id, a scan component, the ground, the trees). */
    idSource: string;
    /** Plan outline (m, the place's frame: x east, z south), when the record has one. */
    footprint?: Vec2[][];
    /** The version kept. */
    current?: string;
    /** Every version offered, oldest first, kept or not. */
    versions: PlaceVersion[];
}

export interface PlaceLease { holder: string; host: string; runId?: string; takenAtMs: number; expiresAtMs: number }

export interface PlaceChunkGrid {
    version: string;
    cellM: number;
    cells: Array<{ index: number; cx: number; cz: number; half: number; rect: { x0: number; z0: number; x1: number; z1: number }; centre: boolean; buildings: string[] }>;
}

export interface PlaceManifest {
    schema: typeof PLACE_STORE_SCHEMA;
    key: string;
    /** The place's ENU anchor (the district frame's origin). */
    anchor?: { lat: number; lng: number; originEllipsoidalHeightM?: number; address?: string };
    radiusM?: number;
    /** The district's grown edge: the disc of radiusM, grown by these records' whole footprints. */
    edge?: { radiusM: number; grownBy: string[] };
    chunks?: PlaceChunkGrid;
    codeVersion?: PlaceCodeVersion;
    /** Index of the records: their object key, the version kept, and how many audit checks it fails. */
    records: Record<string, { key: string; current?: string; failures: number; updatedAtMs: number }>;
    runs: Array<{ runId: string; atMs: number; added: number; promoted: number; rejected: number; unchanged: number }>;
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

/** A record's object key: the id itself when it is a key already, else its characters made safe and its hash added (Google's ids hold '/'). */
export function recordKey(id: string): string {
    if (KEY_PART.test(id) && id.length <= 120 && id !== '.' && id !== '..') return id;
    const safe = id.replace(/[^A-Za-z0-9._-]+/g, '.').replace(/^\.+|\.+$/g, '').slice(0, 100);
    return `${safe || 'record'}-${crypto.createHash('sha256').update(id).digest('hex').slice(0, 10)}`;
}

/**
 * Opens the place's store: the cloud bucket when it answers, else the fallback volume when it is mounted, else none.
 * `bucket` undefined uses the training bucket; null means no cloud bucket. Never throws.
 */
export async function openPlaceStore(opts: { key: string; bucket?: CloudBucket | null; fallbackRoot?: string; tmpDir?: string; env?: NodeJS.ProcessEnv }): Promise<PlaceStore> {
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
    const root = opts.fallbackRoot ?? (env.SCRATCHBOX_PLACE_STORE_FALLBACK?.trim() || PLACE_STORE_FALLBACK_ROOT);
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
const recordObjectKey = (store: PlaceStore, id: string) => `${store.prefix}/records/${recordKey(id)}.json`;
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

export async function loadPlaceRecord(store: PlaceStore, id: string): Promise<PlaceRecord | undefined> {
    if (!store.bucket) return undefined;
    return (await readJson<PlaceRecord>(store, recordObjectKey(store, id)))?.value;
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
        : { schema: PLACE_STORE_SCHEMA, key: store.key, records: {}, runs: [], lease, createdAtMs: now, updatedAtMs: now };
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

/** Measures of `current` that `next` makes worse beyond their tolerance, or does not measure, in words. */
export function worseMeasures(current: PlaceMeasures, next: PlaceMeasures): string[] {
    const out: string[] = [];
    for (const [name, c] of Object.entries(current)) {
        const n = next[name];
        if (!n || !Number.isFinite(n.value)) { out.push(`${name} not measured (was ${fmt(c.value)})`); continue; }
        const tol = c.tol ?? 0;
        const worse = c.better === 'lower' ? n.value > c.value + tol : n.value < c.value - tol;
        if (worse) out.push(`${name} ${fmt(c.value)} -> ${fmt(n.value)} (${c.better} is better)`);
    }
    return out;
}

function fmt(v: number): string {
    return Math.abs(v) >= 100 || Number.isInteger(v) ? String(Math.round(v * 10) / 10) : v.toPrecision(3);
}

const sameFiles = (a: PlaceFile[], b: PlaceFile[]) => a.length === b.length && a.map(f => f.sha256).sort().join() === b.map(f => f.sha256).sort().join();

/**
 * Whether a version offered for `record` is kept: always when the record has none, never when its files are the current
 * version's ('unchanged'), else when no measure of the current version gets worse.
 */
export function decideVersion(record: PlaceRecord | undefined, offered: Omit<PlaceVersion, 'decision'>): PlaceDecision | 'unchanged' {
    const current = record?.current ? record.versions.find(v => v.version === record.current) : undefined;
    if (!current) return { kept: true, reason: 'the first version of this record' };
    if (current.version === offered.version || sameFiles(current.files, offered.files)) return 'unchanged';
    const worse = worseMeasures(current.measures, offered.measures);
    if (worse.length) return { kept: false, reason: `the current version ${current.version} stays: ${worse.join('; ')}`, comparedTo: current.version, worse };
    return { kept: true, reason: `no measure is worse than the current version ${current.version}`, comparedTo: current.version };
}

/** The union of two copies of a record: every version either holds (by version), and the kept version the newer copy names. */
export function mergeRecords(remote: PlaceRecord | undefined, local: PlaceRecord): PlaceRecord {
    if (!remote) return local;
    const byVersion = new Map<string, PlaceVersion>();
    for (const v of remote.versions) byVersion.set(v.version, v);
    for (const v of local.versions) byVersion.set(v.version, v);
    const versions = [...byVersion.values()].sort((a, b) => a.atMs - b.atMs);
    const atOf = (r: PlaceRecord) => r.versions.find(v => v.version === r.current)?.atMs ?? -Infinity;
    const current = atOf(local) >= atOf(remote) ? local.current : remote.current;
    return { ...remote, ...local, versions, ...(current ? { current } : {}) };
}

/**
 * Every string under `root` rewritten relative to it, through the whole value (the run ledger's rule): a path is
 * absolute on the machine that wrote it and dead anywhere else. Paths outside the workspace are left alone.
 */
export function relativisePaths<T>(value: T, root: string): T {
    const prefix = root.endsWith(path.sep) ? root : root + path.sep;
    const walk = (v: unknown): unknown => {
        if (typeof v === 'string') return v.startsWith(prefix) ? v.slice(prefix.length) : v;
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

/** The code a version was built with: SCRATCHBOX_CODE_VERSION (a container has no .git), else the workspace's commit. */
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

/** One record's offer from a run: what it is, and its version without the parts the store fills. */
export interface PlaceOffer {
    id: string;
    idSource: string;
    footprint?: Vec2[][];
    files: Array<{ role: string; path: string }>;
    provenance: Record<string, number>;
    measures: PlaceMeasures;
    defects: PlaceDefect[];
    audit?: unknown;
}

export interface PlaceRunCommit {
    runId: string;
    holder?: string;
    anchor: NonNullable<PlaceManifest['anchor']>;
    radiusM: number;
    edge: NonNullable<PlaceManifest['edge']>;
    chunks?: PlaceChunkGrid;
    codeVersion: PlaceCodeVersion;
    switches: Record<string, string>;
    offers: PlaceOffer[];
    workspaceRoot: string;
    now?: () => number;
}

export interface PlaceCommitReport {
    where: PlaceStoreLocation;
    key: string;
    /** Set when nothing was committed, with why. */
    skipped?: string;
    records: { added: number; promoted: number; rejected: number; unchanged: number };
    decisions: Array<{ id: string; kept: boolean | 'unchanged'; reason: string }>;
    blobs: { stored: number; existing: number; bytes: number; missing: string[] };
    errors: string[];
    ms: number;
}

async function sha256File(file: string): Promise<{ sha256: string; bytes: number }> {
    const hash = crypto.createHash('sha256');
    let bytes = 0;
    for await (const chunk of fs.createReadStream(file)) { hash.update(chunk as Buffer); bytes += (chunk as Buffer).length; }
    return { sha256: hash.digest('hex'), bytes };
}

async function eachLimited<T>(items: T[], limit: number, run: (item: T) => Promise<void>): Promise<void> {
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => { while (next < items.length) await run(items[next++]); }));
}

/**
 * A run's offers committed to the place under its lease: each record read back, its offered version decided, the files of
 * kept versions stored as blobs, the record written as the union of the bucket's copy and this one (paths made
 * workspace-relative), then the manifest written and the lease released in one generation-matched write. Never throws:
 * what went wrong is in the report.
 */
export async function commitPlaceRun(store: PlaceStore, run: PlaceRunCommit, P = PLACE_STORE_PARAMS): Promise<PlaceCommitReport> {
    const now = run.now ?? Date.now;
    const t0 = now();
    const report: PlaceCommitReport = { where: store.where, key: store.key, records: { added: 0, promoted: 0, rejected: 0, unchanged: 0 }, decisions: [], blobs: { stored: 0, existing: 0, bytes: 0, missing: [] }, errors: [], ms: 0 };
    const done = (skipped?: string) => ({ ...report, ...(skipped ? { skipped } : {}), ms: now() - t0 });
    if (!store.bucket) return done(store.where.reason ?? 'no place store');
    const holder = run.holder ?? `${os.hostname()}:${process.pid}:${run.runId}`;
    let held: LeaseResult;
    try {
        held = await acquirePlaceLease(store, { holder, runId: run.runId }, now(), P);
    } catch (err) {
        return done(`the lease could not be taken (${errorMessage(err)})`);
    }
    if (!held.ok) return done(held.reason);
    const leased = held;
    const manifest: PlaceManifest = { ...leased.manifest, records: { ...leased.manifest.records }, runs: [...leased.manifest.runs] };
    try {
        const hashes = new Map<string, Promise<{ sha256: string; bytes: number } | undefined>>();
        const hashOf = (file: string) => {
            let h = hashes.get(file);
            if (!h) hashes.set(file, h = sha256File(file).catch(() => undefined));
            return h;
        };
        const stored = new Map<string, Promise<string>>();
        const storeBlob = (file: string, sha256: string, bytes: number) => {
            let s = stored.get(sha256);
            if (!s) {
                const key = blobKey(store, sha256);
                stored.set(sha256, s = store.bucket!.putFile(key, file, { onlyIfAbsent: true, contentType: 'model/gltf-binary', metadata: { place: store.key, sha256 } }).then(state => {
                    if (state === 'stored') { report.blobs.stored++; report.blobs.bytes += bytes; } else report.blobs.existing++;
                    return key;
                }));
            }
            return s;
        };
        await eachLimited(run.offers, P.concurrency, async offer => {
            try {
                const files: PlaceFile[] = [];
                for (const f of offer.files) {
                    const h = await hashOf(f.path);
                    if (!h) { if (!report.blobs.missing.includes(f.path)) report.blobs.missing.push(f.path); continue; }
                    files.push({ role: f.role, path: f.path, ...h });
                }
                const remote = await loadPlaceRecord(store, offer.id);
                const offered: Omit<PlaceVersion, 'decision'> = {
                    version: run.runId, runId: run.runId, atMs: now(), files, provenance: offer.provenance, measures: offer.measures,
                    defects: offer.defects, switches: run.switches, codeVersion: run.codeVersion, ...(offer.audit !== undefined ? { audit: offer.audit } : {})
                };
                const decision = decideVersion(remote, offered);
                if (decision === 'unchanged') {
                    report.records.unchanged++;
                    report.decisions.push({ id: offer.id, kept: 'unchanged', reason: 'the same files as the current version' });
                    return;
                }
                if (decision.kept) for (const f of files) f.blob = await storeBlob(f.path, f.sha256, f.bytes);
                const local: PlaceRecord = {
                    schema: PLACE_RECORD_SCHEMA, id: offer.id, idSource: offer.idSource, ...(offer.footprint ? { footprint: offer.footprint } : {}),
                    ...(decision.kept ? { current: offered.version } : remote?.current ? { current: remote.current } : {}),
                    versions: [{ ...offered, decision }]
                };
                const merged = relativisePaths(mergeRecords(remote, local), run.workspaceRoot);
                await writeJson(store, recordObjectKey(store, offer.id), merged);
                if (!remote?.current) report.records.added++;
                else if (decision.kept) report.records.promoted++;
                else report.records.rejected++;
                report.decisions.push({ id: offer.id, kept: decision.kept, reason: decision.reason });
                const kept = merged.versions.find(v => v.version === merged.current);
                manifest.records[offer.id] = { key: recordKey(offer.id), ...(merged.current ? { current: merged.current } : {}), failures: kept?.defects.length ?? 0, updatedAtMs: now() };
            } catch (err) {
                report.errors.push(`${offer.id}: ${errorMessage(err)}`);
            }
        });
        const atMs = now();
        const entry = { runId: run.runId, atMs, ...report.records };
        const next: PlaceManifest = {
            ...manifest, anchor: run.anchor, radiusM: run.radiusM, edge: run.edge, ...(run.chunks ? { chunks: run.chunks } : {}), codeVersion: run.codeVersion,
            runs: [...manifest.runs.filter(r => r.runId !== run.runId), entry].sort((a, b) => a.atMs - b.atMs), updatedAtMs: atMs
        };
        // the manifest and the release in one write, over the generation the lease was taken at
        const w = await writeLeasedManifest(store, relativisePaths(next, run.workspaceRoot), leased.generation, false);
        if (w === 'conflict') report.errors.push('the lease ran out and another writer took the place before the manifest was written: the records written stand (union-merged), the manifest index does not list this run');
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
