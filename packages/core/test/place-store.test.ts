/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { StagedLayer } from '../src/common/spatial/staged-location-contracts';
import { DurableAssetStore } from '../src/node/asset-store/durable-asset-store';
import { SceneObjectStore, type ObjectMeasures } from '../src/node/asset-store/scene-object-store';
import { DirectoryCloudBucket, NO_GENERATION, type CloudObject, type PutFileOptions, type VersionedCloudBucket } from '../src/node/cloud-store/cloud-bucket';
import type { DistrictChunkPlan } from '../src/node/3d-engine/staged-location/pipeline-k/district-chunks';
import {
    acquirePlaceLease, loadPlaceManifest, loadPlaceObject, openPlaceStore, placeKey, PLACE_STORE_PARAMS, placeStoreEnabled, pullPlace, recordKey, syncPlaceObjects, writeLeasedManifest,
    type PlaceStore, type PlaceSync
} from '../src/node/3d-engine/staged-location/place-store';
import { auditDistrictForPlace, pullPlaceForRun, syncPlaceAfterObjects, type PlaceAuditNote } from '../src/node/3d-engine/staged-location/place-store-district';
import { kdLookCode, showBestVersions } from '../src/node/3d-engine/staged-location/place-store-best';
import type { DistrictFootprint } from '../src/node/3d-engine/staged-location/pipeline-k/district-buildings';
import { parseGlbBytes } from '../src/node/3d-engine/staged-location/glb-bytes';
import { fileReadingStore, readingFileOf, readingKey } from '../src/node/3d-engine/staged-location/pipeline-k/model-readings';
import { storeSceneObjects, type LayerObjectManifest } from '../src/node/3d-engine/staged-location/scene-objects';
import { encodePng } from '../src/node/3d-engine/staged-location/png-encode';
import { box, quad, testGlb, type TestPrim } from './helpers/test-glb';

/** A versioned bucket in memory: each object's bytes and generation; `down` makes every call fail as an unreachable bucket does. */
class MemoryVersionedBucket implements VersionedCloudBucket {
    readonly label = 'mem://training';
    readonly objects = new Map<string, { bytes: Buffer; generation: string; metadata: Record<string, string> }>();
    private gen = 0;
    down = false;
    private check() { if (this.down) throw new Error('getaddrinfo ENOTFOUND storage.googleapis.com'); }
    private store(key: string, file: string, opts?: PutFileOptions) {
        const generation = String(++this.gen);
        this.objects.set(key, { bytes: fs.readFileSync(file), generation, metadata: opts?.metadata ?? {} });
        return generation;
    }
    async putFile(key: string, file: string, opts?: PutFileOptions): Promise<'stored' | 'exists'> {
        this.check();
        if (opts?.onlyIfAbsent && this.objects.has(key)) return 'exists';
        this.store(key, file, opts);
        return 'stored';
    }
    async download(key: string, file: string): Promise<boolean> {
        this.check();
        const o = this.objects.get(key);
        if (!o) return false;
        fs.writeFileSync(file, o.bytes);
        return true;
    }
    async downloadVersioned(key: string, file: string): Promise<string | undefined> {
        this.check();
        const o = this.objects.get(key);
        if (!o) return undefined;
        fs.writeFileSync(file, o.bytes);
        return o.generation;
    }
    async putFileIfGeneration(key: string, file: string, generation: string, opts?: PutFileOptions): Promise<{ generation: string } | 'conflict'> {
        this.check();
        if ((this.objects.get(key)?.generation ?? NO_GENERATION) !== generation) return 'conflict';
        return { generation: this.store(key, file, opts) };
    }
    async list(prefix: string): Promise<CloudObject[]> {
        this.check();
        return [...this.objects.entries()].filter(([k]) => k.startsWith(prefix)).map(([key, o]) => ({ key, bytes: o.bytes.length, updatedMs: 0, metadata: o.metadata }));
    }
    async remove(key: string): Promise<void> { this.check(); this.objects.delete(key); }
}

let tmp: string;
const stores: DurableAssetStore[] = [];
beforeEach(() => { tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sb-place-store-test-'))); });
afterEach(() => { for (const s of stores.splice(0)) s.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

const FRAME = { lat: 40.750568, lng: -73.993519, ellipsoidalHeightM: -12.3 };
const KEY = placeKey(FRAME);
const measures = (holes: number, black: number): ObjectMeasures => ({ holes: { value: holes, better: 'lower' }, blackShare: { value: black, better: 'lower', tol: 0.001 } });

function objectStore(name = 'home'): SceneObjectStore {
    const store = new DurableAssetStore(path.join(tmp, name));
    stores.push(store);
    return new SceneObjectStore(store);
}

/** A small closed GLB, different for each `seed`, standing for one version of an object. */
const glbOf = (seed: number) => Buffer.from(testGlb([{ prims: [box(0, 0, 0, 1 + seed, 2, 1)] }]));

function putVersion(objects: SceneObjectStore, identity: string, seed: number, m?: ObjectMeasures) {
    return objects.put({
        kind: 'building', identity, frame: FRAME, inputHash: `hash-${identity}-${seed}`, glb: () => glbOf(seed),
        provenance: { labels: ['remeshed'], confidence: null }, producer: { stage: 'test', version: '1' }, runId: `run-${seed}`,
        ...(m ? { measures: m, defects: m.holes.value ? [{ kind: 'holes', detail: `${m.holes.value} holes`, source: 'test' }] : [] } : {})
    });
}

const sync = (objects: SceneObjectStore, runId: string, objectKeys: string[], at = 1_000): PlaceSync => ({
    runId, objects, objectKeys, anchor: { lat: FRAME.lat, lng: FRAME.lng, address: 'Penn Station' }, radiusM: 250, edge: { radiusM: 250, grownBy: ['b1'] },
    codeVersion: { commit: 'abc1234', modules: { audit: 'district-audit/1' } }, switches: { 'request.district': 'kd' }, workspaceRoot: path.join(tmp, 'ws'), now: () => at
});

async function cloudStore(bucket: MemoryVersionedBucket): Promise<PlaceStore> {
    return openPlaceStore({ key: KEY, bucket, fallbackRoot: path.join(tmp, 'no-volume', 'scratchbox-places'), tmpDir: path.join(tmp, 'scratch') });
}

describe('measured object versions', () => {
    it('makes a measured version current only when no measure of the current one gets worse', () => {
        const objects = objectStore();
        const first = putVersion(objects, 'b1', 1, measures(3, 0.02));
        expect(first.decision).toEqual({ kept: true, reason: 'the first version of this object' });
        const better = putVersion(objects, 'b1', 2, measures(1, 0.0205));
        expect(better.decision?.kept).toBe(true);
        expect(better.pointerMoved).toBe(true);
        const worse = putVersion(objects, 'b1', 3, measures(0, 0.03));
        expect(worse.decision).toMatchObject({ kept: false, comparedTo: better.version, worse: ['blackShare 0.0205 -> 0.0300 (lower is better)'] });
        expect(worse.pointerMoved).toBe(false);
        expect(objects.current(first.objectKey)!.version).toBe(better.version);
        // the rejected version is history: stored, readable, its record saying why it is not current
        const rec = objects.recordOf(objects.versions(first.objectKey).find(v => v.version === worse.version)!)!;
        expect(rec.decision?.reason).toContain(`version ${better.version} stays current: blackShare`);
        expect(rec.measures?.holes.value).toBe(0);
        expect(objects.store.events({ subject: first.objectKey }).some(e => e.kind === 'object.rejected')).toBe(true);
        // its input again does not bring it back either
        const again = putVersion(objects, 'b1', 3, measures(0, 0.03));
        expect(again.reused).toBe(true);
        expect(again.pointerMoved).toBe(false);
        expect(again.decision?.kept).toBe(false);
    });

    it('rejects a version that stops measuring something, and leaves unmeasured objects as they were', () => {
        const objects = objectStore();
        putVersion(objects, 'b1', 1, measures(1, 0));
        const lost = objects.put({ kind: 'building', identity: 'b1', frame: FRAME, inputHash: 'h-lost', glb: () => glbOf(5), provenance: { labels: [], confidence: null }, producer: { stage: 't', version: '1' }, measures: { holes: { value: 0, better: 'lower' } } });
        expect(lost.decision?.worse).toEqual(['blackShare not measured (was 0)']);
        // no measures: the pointer moves as it always has
        putVersion(objects, 'tree-1', 1);
        const next = putVersion(objects, 'tree-1', 2);
        expect(next.decision).toBeUndefined();
        expect(next.pointerMoved).toBe(true);
    });
});

describe('place store', () => {
    it('copies the objects to the place, never replacing the place\'s current version with a worse one from another machine', async () => {
        const bucket = new MemoryVersionedBucket();
        const store = await cloudStore(bucket);
        expect(store.where).toEqual({ kind: 'cloud', label: `mem://training/places/v1/${KEY}` });

        const here = objectStore('here');
        const a = putVersion(here, 'b1', 1, measures(2, 0.01));
        const r1 = await syncPlaceObjects(store, sync(here, 'run-1', [a.objectKey], 1_000));
        expect(r1.errors).toEqual([]);
        expect(r1.objects).toEqual({ added: 1, promoted: 0, rejected: 0, unchanged: 0 });
        expect(r1.blobs.stored).toBe(1);

        const b = putVersion(here, 'b1', 2, measures(1, 0.01));
        const r2 = await syncPlaceObjects(store, sync(here, 'run-2', [b.objectKey], 2_000));
        expect(r2.objects.promoted).toBe(1);

        // another machine that never saw versions 1 and 2 builds a worse one: the place keeps its own
        const there = objectStore('there');
        const c = putVersion(there, 'b1', 9, measures(4, 0.01));
        expect(c.decision?.kept).toBe(true); // the first version on that machine
        const r3 = await syncPlaceObjects(store, sync(there, 'run-3', [c.objectKey], 3_000));
        expect(r3.objects.rejected).toBe(1);
        expect(r3.decisions[0].reason).toContain('holes 1 -> 4 (lower is better)');

        const record = (await loadPlaceObject(store, a.objectKey))!;
        expect(record.current).toBe('hash-b1-2');
        // every machine's versions, union-merged by input hash; only versions current here carry a blob
        expect(record.versions.map(v => v.inputHash)).toEqual(['hash-b1-1', 'hash-b1-2', 'hash-b1-9']);
        expect(record.versions.find(v => v.inputHash === 'hash-b1-9')!.blob).toBeUndefined();
        const blob = record.versions.find(v => v.inputHash === 'hash-b1-2')!.blob!;
        expect(blob).toMatch(new RegExp(`^places/v1/${KEY}/blobs/[0-9a-f]{2}/[0-9a-f]{64}\\.glb$`));
        expect(bucket.objects.get(blob)!.bytes.equals(glbOf(2))).toBe(true);
        expect(record.decisions.map(d => [d.inputHash, d.kept])).toEqual([['hash-b1-1', true], ['hash-b1-2', true], ['hash-b1-9', false]]);
        expect(bucket.objects.has(`places/v1/${KEY}/objects/${recordKey(a.objectKey)}.json`)).toBe(true);

        const { manifest } = (await loadPlaceManifest(store))!;
        expect(manifest.lease).toBeUndefined();
        expect(manifest.anchor).toEqual({ lat: FRAME.lat, lng: FRAME.lng, address: 'Penn Station' });
        expect(manifest.objects[a.objectKey]).toMatchObject({ kind: 'building', current: 'hash-b1-2', defects: 1 });
        expect(manifest.runs.map(r => r.runId)).toEqual(['run-1', 'run-2', 'run-3']);
        // this machine keeps the place's manifest too
        expect((here.store.recipe(`place:${KEY}`)!.body as { radiusM: number }).radiusM).toBe(250);
    });

    it('lets one writer at a time hold the lease, and refuses a lapsed holder\'s write once another has taken it', async () => {
        for (const bucket of [new MemoryVersionedBucket(), new DirectoryCloudBucket(path.join(tmp, 'dir-bucket'))]) {
            const store: PlaceStore = { key: KEY, where: { kind: 'cloud', label: bucket.label }, bucket, prefix: `places/v1/${KEY}`, tmpDir: path.join(tmp, 'scratch') };
            const P = { ...PLACE_STORE_PARAMS, leaseMs: 60_000, concurrency: 2 };
            const a = await acquirePlaceLease(store, { holder: 'a', runId: 'run-a' }, 1_000, P);
            expect(a.ok).toBe(true);
            expect(await acquirePlaceLease(store, { holder: 'b', runId: 'run-b' }, 2_000, P)).toMatchObject({ ok: false, heldBy: { holder: 'a' } });
            // the lease lapsed: b takes the place over, and a's write over the generation it holds is refused
            expect((await acquirePlaceLease(store, { holder: 'b', runId: 'run-b' }, 100_000, P)).ok).toBe(true);
            if (!a.ok) throw new Error('unreachable');
            expect(await writeLeasedManifest(store, a.manifest, a.generation, false)).toBe('conflict');
            expect((await loadPlaceManifest(store))!.manifest.lease?.holder).toBe('b');
        }
    });

    it('lets only one of two writers who read the same manifest take the lease', async () => {
        for (const bucket of [new MemoryVersionedBucket(), new DirectoryCloudBucket(path.join(tmp, 'dir-race'))]) {
            const store: PlaceStore = { key: KEY, where: { kind: 'cloud', label: bucket.label }, bucket, prefix: `places/v1/${KEY}`, tmpDir: path.join(tmp, 'scratch') };
            const both = await Promise.all([acquirePlaceLease(store, { holder: 'a' }, 1_000), acquirePlaceLease(store, { holder: 'b' }, 1_000)]);
            expect(both.filter(r => r.ok)).toHaveLength(1);
        }
    });

    it('falls back to the G-RAID folder when the bucket cannot be reached, and says so', async () => {
        const bucket = new MemoryVersionedBucket();
        bucket.down = true;
        const volume = path.join(tmp, 'G-RAID MIRROR');
        fs.mkdirSync(volume);
        const root = path.join(volume, 'scratchbox-places');
        const store = await openPlaceStore({ key: KEY, bucket, fallbackRoot: root, tmpDir: path.join(tmp, 'scratch') });
        expect(store.where.kind).toBe('fallback');
        expect(store.where.label).toBe(`dir://${root}/${KEY}`);
        expect(store.where.reason).toContain('mem://training could not be reached (getaddrinfo ENOTFOUND');
        const objects = objectStore();
        const a = putVersion(objects, 'b1', 1, measures(0, 0));
        const r = await syncPlaceObjects(store, sync(objects, 'run-1', [a.objectKey]));
        expect(r.where.kind).toBe('fallback');
        expect(r.objects.added).toBe(1);
        expect(JSON.parse(fs.readFileSync(path.join(root, KEY, 'manifest.json'), 'utf8')).objects[a.objectKey].current).toBe('hash-b1-1');
        expect(fs.existsSync(path.join(root, KEY, 'objects', `${recordKey(a.objectKey)}.json`))).toBe(true);
        expect(fs.readdirSync(path.join(root, KEY, 'blobs')).length).toBe(1);
    });

    it('is none when neither the bucket nor the volume is there, and never throws', async () => {
        const store = await openPlaceStore({ key: KEY, bucket: null, fallbackRoot: path.join(tmp, 'not-mounted', 'scratchbox-places') });
        expect(store.where.kind).toBe('none');
        expect(store.where.reason).toContain('no cloud bucket is configured');
        expect(store.where.reason).toContain('is not available');
        // the missing mount point is not made
        expect(fs.existsSync(path.join(tmp, 'not-mounted'))).toBe(false);
        const objects = objectStore();
        const r = await syncPlaceObjects(store, sync(objects, 'run-1', [putVersion(objects, 'b1', 1, measures(0, 0)).objectKey]));
        expect(r.skipped).toContain('is not available');
        expect(r.objects.added).toBe(0);
    });
});

describe('a district run reads its place first', () => {
    it('is on unless SCRATCHBOX_PLACE_STORE=0', () => {
        expect(placeStoreEnabled({})).toBe(true);
        expect(placeStoreEnabled({ SCRATCHBOX_PLACE_STORE: '1' })).toBe(true);
        expect(placeStoreEnabled({ SCRATCHBOX_PLACE_STORE: '0' })).toBe(false);
    });

    it("brings the place's current versions and readings to another machine, where a better version stays current", async () => {
        const bucket = new MemoryVersionedBucket();
        const store = await cloudStore(bucket);
        // machine A: two buildings and two readings, synced to the place
        const a = objectStore('a'), readingsA = path.join(tmp, 'a-readings');
        const b1 = putVersion(a, 'b1', 1, measures(1, 0.01)), b2 = putVersion(a, 'b2', 2, measures(2, 0.01));
        const ra = fileReadingStore(readingsA), kUsed = readingKey('facade-reading', ['used']), kWritten = readingKey('material-choice', ['written']);
        ra.put(kUsed, { text: 'kept from before' }); ra.put(kWritten, { classes: [1] });
        const synced = await syncPlaceObjects(store, { ...sync(a, 'run-a', [b1.objectKey, b2.objectKey]), readings: { dir: readingsA, used: [kUsed], written: [kWritten] } });
        expect(synced.errors).toEqual([]);
        expect(synced.readings).toEqual({ stored: 2, existing: 0, missing: 0 });
        expect(bucket.objects.has(`places/v1/${KEY}/readings/${readingFileOf(kUsed)}`)).toBe(true);
        // machine B has b2 already, at a better version than the place's
        const b = objectStore('b'), readingsB = path.join(tmp, 'b-readings');
        const better = putVersion(b, 'b2', 7, measures(0, 0));
        const pulled = await pullPlace(store, { objects: b, readingsDir: readingsB });
        expect(pulled.errors).toEqual([]);
        expect(pulled.objects).toEqual({ adopted: 1, keptLocal: 1, alreadyHere: 0, failed: 0 });
        expect(b.current(b2.objectKey)!.inputHash).toBe(better.objectKey === b2.objectKey ? 'hash-b2-7' : '');
        expect(pulled.readings).toEqual({ pulled: 2, present: 0, failed: 0 });
        // the place's b1 is current on B, its measures, defects, labels and source run as the place holds them, its GLB byte for byte
        const cur = b.read(b1.objectKey)!;
        expect(cur.row.inputHash).toBe('hash-b1-1');
        expect(cur.record.measures).toEqual(measures(1, 0.01));
        expect(cur.record.provenance.labels).toEqual(['remeshed']);
        expect(cur.record.runId).toBe('run-1');
        expect(fs.readFileSync(cur.glbFile).equals(glbOf(1))).toBe(true);
        expect(fileReadingStore(readingsB).get(kUsed)).toEqual({ text: 'kept from before' });
        // again: nothing new to bring
        const again = await pullPlace(store, { objects: b, readingsDir: readingsB });
        expect(again.objects).toMatchObject({ adopted: 0, alreadyHere: 2 });
        expect(again.readings).toEqual({ pulled: 0, present: 2, failed: 0 });
    });

    it("keeps this machine's version current when the place's is worse, and takes nothing with reuse or restore off", async () => {
        const bucket = new MemoryVersionedBucket();
        const store = await cloudStore(bucket);
        const a = objectStore('a');
        const worse = putVersion(a, 'b1', 1, measures(3, 0.02));
        const rk = readingKey('facade-reading', ['x']), dirA = path.join(tmp, 'a-readings');
        fileReadingStore(dirA).put(rk, { text: 't' });
        await syncPlaceObjects(store, { ...sync(a, 'run-a', [worse.objectKey]), readings: { dir: dirA, used: [], written: [rk] } });
        const b = objectStore('b');
        const mine = putVersion(b, 'b1', 2, measures(0, 0.01));
        const pulled = await pullPlace(store, { objects: b });
        expect(pulled.objects).toMatchObject({ adopted: 0, keptLocal: 1 });
        expect(b.current(mine.objectKey)!.inputHash).toBe('hash-b1-2');
        // the place's version is history here, its record saying why it is not current
        const theirs = b.versions(mine.objectKey).find(v => v.inputHash === 'hash-b1-1')!;
        expect(b.recordOf(theirs)!.decision?.reason).toContain('holes 0 -> 3 (lower is better)');
        // the switches: SCRATCHBOX_OBJECT_REUSE=0 brings no object, SCRATCHBOX_CACHE_RESTORE=off no reading
        const c = objectStore('c'), dirC = path.join(tmp, 'c-readings');
        const off = await pullPlaceForRun({ place: FRAME, store: c.store, readingsDir: dirC, placeStore: { bucket, fallbackRoot: path.join(tmp, 'no-volume', 'x'), tmpDir: path.join(tmp, 'scratch') }, env: { SCRATCHBOX_OBJECT_REUSE: '0', SCRATCHBOX_CACHE_RESTORE: 'off' } });
        expect(off.objects).toMatchObject({ adopted: 0, skipped: 'SCRATCHBOX_OBJECT_REUSE=0: no stored object is taken' });
        expect(off.readings).toMatchObject({ pulled: 0, skipped: 'SCRATCHBOX_CACHE_RESTORE=off: nothing is read back' });
        expect(c.current(mine.objectKey)).toBeUndefined();
        expect(fs.existsSync(dirC)).toBe(false);
        const on = await pullPlaceForRun({ place: FRAME, store: c.store, readingsDir: dirC, placeStore: { bucket, fallbackRoot: path.join(tmp, 'no-volume', 'x'), tmpDir: path.join(tmp, 'scratch') }, env: {} });
        expect(on.objects.adopted).toBe(1);
        expect(on.readings.pulled).toBe(1);
    });

    it('reports a place store that cannot be reached, or a place with none yet, and takes nothing', async () => {
        const bucket = new MemoryVersionedBucket();
        bucket.down = true;
        const objects = objectStore();
        const unreachable = await pullPlaceForRun({ place: FRAME, store: objects.store, readingsDir: path.join(tmp, 'r'), placeStore: { bucket, fallbackRoot: path.join(tmp, 'not-mounted', 'x'), tmpDir: path.join(tmp, 'scratch') }, env: {} });
        expect(unreachable.where.kind).toBe('none');
        expect(unreachable.skipped).toContain('mem://training could not be reached');
        bucket.down = false;
        const empty = await pullPlace(await cloudStore(bucket), { objects, readingsDir: path.join(tmp, 'r') });
        expect(empty.skipped).toBe('the place has no store yet');
    });

    it("copies the readings a run used or wrote: a written one replaces the place's, a used one only fills a gap, one this workspace lacks is read back first", async () => {
        const bucket = new MemoryVersionedBucket();
        const store = await cloudStore(bucket);
        const objects = objectStore(), dir = path.join(tmp, 'readings'), rs = fileReadingStore(dir);
        const b1 = putVersion(objects, 'b1', 1, measures(0, 0));
        const used = readingKey('facade-reading', ['u']), grown = readingKey('material-choice', ['g']), chunk = readingKey('facade-reading', ['chunk']), gone = readingKey('facade-reading', ['gone']);
        rs.put(used, { text: 'v1' }); rs.put(grown, { classes: [1] });
        await syncPlaceObjects(store, { ...sync(objects, 'run-1', [b1.objectKey]), readings: { dir, used: [used], written: [grown] } });
        // the next run: the used reading changed here (it may not replace the place's), the choice grew, a chunk's reading is in the cache mirror only
        rs.put(used, { text: 'v2' }); rs.put(grown, { classes: [1, 2] });
        const restored: string[] = [];
        const restore = async (k: string) => { restored.push(k); if (k !== chunk) return false; fileReadingStore(dir).put(chunk, { text: 'from the chunk' }); return true; };
        const r = await syncPlaceObjects(store, { ...sync(objects, 'run-2', [b1.objectKey], 2_000), readings: { dir, used: [used, chunk, gone], written: [grown], restore } });
        expect(r.readings).toEqual({ stored: 2, existing: 1, missing: 1 });
        expect(restored.sort()).toEqual([chunk, gone].sort());
        const at = (k: string) => JSON.parse(bucket.objects.get(`places/v1/${KEY}/readings/${readingFileOf(k)}`)!.bytes.toString('utf8'));
        expect(at(used)).toEqual({ text: 'v1' });
        expect(at(grown)).toEqual({ classes: [1, 2] });
        expect(at(chunk)).toEqual({ text: 'from the chunk' });
    });
});

describe('a chunked district into the object store and the place store', () => {
    it('lists each joined building with its audit, keeps it as an object, and copies it to the place; a worse rebuild stays history and is shown from the stored version', async () => {
        const bucket = new MemoryVersionedBucket();
        const ws = path.join(tmp, 'ws'), modelsDir = path.join(ws, 'public', 'models');
        fs.mkdirSync(modelsDir, { recursive: true });
        const write = (name: string, bytes: Uint8Array) => { fs.writeFileSync(path.join(modelsDir, name), bytes); return `/models/${name}`; };
        const square = (cx: number, half: number) => [[[cx - half, -half], [cx + half, -half], [cx + half, half], [cx - half, half]]] as Array<Array<[number, number]>>;
        const plan: DistrictChunkPlan = {
            version: 'district-chunks/2', radiusM: 150, cellM: 120,
            chunks: [{ index: 0, cx: 0, cz: 0, half: 60, rect: { x0: -68, z0: -68, x1: 68, z1: 68 }, radiusM: 97, buildings: ['b-whole', 'b-roofless'], centre: true }],
            footprints: [{ id: 'b-whole', loops: square(0, 5), chunk: 0 }, { id: 'b-roofless', loops: square(30, 5), chunk: 0 }]
        };
        const layerOf = (objectId: string, stage: string, url: string, label: string) => ({
            objectId, stage, layer: stage === 'trees' ? 'l5' : 'l2', url, supersedes: [], provenance: { label, measuredGeometry: true, method: 'test', sources: [] }
        }) as unknown as StagedLayer;
        // the scan as a K twin draws it: textured, its buildings standing on the ground
        const white = encodePng(1, 1, Uint8Array.from([240, 240, 240, 255]), 4);
        const textured = (p: TestPrim): TestPrim => ({ ...p, uvs: new Array((p.positions.length / 3) * 2).fill(0.5), png: white });
        const scan = (run: number, roofless: boolean) => write(`scan_${run}.glb`, testGlb([{ prims: [quad(-100, -100, 100, 100, 0, white), textured(box(-5, 0, -5, 5, 10, 5, ['bottom'])), textured(box(25, 0, -5, 35, 10, 5, roofless ? ['bottom', 'top'] : ['bottom']))] }]));
        const durable = new DurableAssetStore(path.join(tmp, 'home'));
        stores.push(durable);
        const objects = new SceneObjectStore(durable);
        const notes = new Map<string, unknown>();
        const cache = { workspaceRoot: ws, readRunNote: <T,>(runId: string, name: string) => notes.get(`${runId}/${name}`) as T | undefined };
        const env = { SCRATCHBOX_OBJECT_STORE: '1', SCRATCHBOX_PLACE_STORE: '1' };
        const build = async (runId: string, roofless: boolean) => {
            const layers = [layerOf(`stg-${runId}-l2`, 'remesh', scan(Number(runId.slice(-1)), roofless), 'remeshed')];
            const manifests = new Map<string, LayerObjectManifest>();
            const footprints: DistrictFootprint[] = [];
            const note: PlaceAuditNote = await auditDistrictForPlace({
                runId, place: { lat: FRAME.lat, lng: FRAME.lng, formattedAddress: 'Penn Station' }, originEllipsoidalHeightM: FRAME.ellipsoidalHeightM, plan, layers, manifests,
                modelsDir, workspaceRoot: ws, request: { query: 'Penn Station', district: 'kd', radiusM: 150 }, env, footprintsOut: footprints
            });
            notes.set(`${runId}/place_audit`, note);
            // as the orchestrator does after the audit: each building shown at its best, the superseding layer carrying the manifest
            const best = showBestVersions({
                runId, frame: FRAME, layers, manifests, footprints, store: durable, look: kdLookCode(env), modelsDir, outDir: path.join(tmp, 'best'), env,
                publish: (file, name) => { fs.copyFileSync(file, path.join(modelsDir, name)); return { url: `/models/${name}`, bytes: fs.statSync(file).size }; }
            });
            for (const b of best.layers) { layers.push(b.layer); manifests.set(b.layer.objectId, b.manifest); }
            const kept = await storeSceneObjects({ store: durable, runId, sceneId: 'scene', frame: FRAME, layers, manifests, modelsDir, scene: null, workspace: ws });
            const synced = await syncPlaceAfterObjects({ runId, cache, store: durable, kept: kept.kept, placeStore: { bucket, fallbackRoot: path.join(tmp, 'no-volume', 'x'), tmpDir: path.join(tmp, 'scratch') }, env });
            return { note, manifests, kept, synced: synced!, best, layers };
        };

        const first = await build('run-1', false);
        expect(first.note.error).toBeUndefined();
        expect(first.note.objectsKept).toBe(true);
        expect(first.note.audit).toMatchObject({ buildings: 2, failing: [], neighbours: 'no vector data' });
        const manifest = [...first.manifests.values()][0];
        expect(manifest.objects.map(o => `${o.kind}/${o.identity}`).sort()).toEqual(['building/b-roofless', 'building/b-whole', 'ground/chunk-0/l2']);
        expect(manifest.objects.find(o => o.identity === 'b-whole')!.measures!.holes.value).toBe(0);
        expect(first.kept.failed).toEqual([]);
        expect(first.kept.stored).toBe(3);
        const whole = first.kept.kept.find(k => k.identity === 'b-whole')!;
        // the object is the building's own triangles, cut from the joined layer: its box less the bottom
        expect(objects.read(whole.objectKey)!.record.glb.triangles).toBe(10);
        expect(objects.read(whole.objectKey)!.record.measures!.areaM2.value).toBeCloseTo(4 * 10 * 10 + 100, 3);
        expect(first.synced.where.kind).toBe('cloud');
        expect(first.synced.objects.added).toBe(3);
        expect(first.best.report.substituted).toEqual([]);
        // each building records the footprint and the look code it was drawn with
        expect(manifest.objects.find(o => o.identity === 'b-whole')!.inputs).toMatchObject({ layer: 'l2', look: kdLookCode(env), footprintSha256: expect.stringMatching(/^[0-9a-f]{64}$/) });
        expect((await loadPlaceManifest(await cloudStore(bucket)))!.manifest.audit).toMatchObject({ buildings: 2 });

        // the next run loses a roof: that building's new version stays history, here and in the place
        const second = await build('run-2', true);
        expect(second.note.audit!.failing).toEqual([{ id: 'b-roofless', checks: ['holes'] }]);
        const roofless = second.kept.kept.find(k => k.identity === 'b-roofless')!;
        expect(roofless.decision).toMatchObject({ kept: false });
        expect(roofless.decision!.reason).toContain('holes 0 -> 1');
        expect(second.kept.rejected).toBe(1);
        expect(objects.current(roofless.objectKey)!.runId).toBe('run-1');
        expect(second.synced.objects).toMatchObject({ unchanged: 1, promoted: 2, rejected: 0 });
        expect((await loadPlaceObject(await cloudStore(bucket), roofless.objectKey))!.current).toBe(first.kept.kept.find(k => k.identity === 'b-roofless')!.inputHash);
        // and the district shows the roofed version run 1 kept, labelled, in a layer superseding the one built
        expect(second.best.report.substituted).toEqual([expect.objectContaining({ id: 'b-roofless', version: 1, runId: 'run-1' })]);
        expect(second.best.report.substituted[0].reason).toContain('holes 0 -> 1');
        const shown = second.layers.find(l => l.objectId === 'stg-run-2-l2-best')!;
        expect(shown.supersedes).toEqual(['stg-run-2-l2']);
        const glb = parseGlbBytes(fs.readFileSync(path.join(modelsDir, path.basename(shown.url))));
        const stored = (glb.json.nodes as Array<{ extras?: { sb?: { storedVersion?: { runId: string } } } }>).filter(n => n.extras?.sb?.storedVersion);
        expect(stored.map(n => n.extras!.sb!.storedVersion!.runId)).toEqual(['run-1']);
    });

    it('audits without listing objects when the object store is switched off, and says why', async () => {
        const ws = path.join(tmp, 'ws'), modelsDir = path.join(ws, 'public', 'models');
        fs.mkdirSync(modelsDir, { recursive: true });
        fs.writeFileSync(path.join(modelsDir, 'scan.glb'), testGlb([{ prims: [box(-5, 0, -5, 5, 10, 5, ['bottom'])] }]));
        const plan: DistrictChunkPlan = { version: 'district-chunks/2', radiusM: 150, cellM: 120, chunks: [{ index: 0, cx: 0, cz: 0, half: 60, rect: { x0: -68, z0: -68, x1: 68, z1: 68 }, radiusM: 97, buildings: ['b'], centre: true }], footprints: [{ id: 'b', loops: [[[-5, -5], [5, -5], [5, 5], [-5, 5]]], chunk: 0 }] };
        const manifests = new Map<string, LayerObjectManifest>();
        const note = await auditDistrictForPlace({
            runId: 'run-1', place: { lat: FRAME.lat, lng: FRAME.lng }, plan, manifests, modelsDir, workspaceRoot: ws, request: {}, env: { SCRATCHBOX_OBJECT_STORE: '0' },
            layers: [{ objectId: 'stg-l2', stage: 'remesh', layer: 'l2', url: '/models/scan.glb', supersedes: [], provenance: { label: 'remeshed' } } as unknown as StagedLayer]
        });
        expect(note.objectsKept).toBe(false);
        expect(note.notes[0]).toContain('SCRATCHBOX_OBJECT_STORE is off');
        expect(note.audit!.buildings).toBe(1);
        expect(manifests.size).toBe(0);
    });
});
