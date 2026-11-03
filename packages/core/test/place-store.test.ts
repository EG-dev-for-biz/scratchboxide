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
import { DirectoryCloudBucket, NO_GENERATION, type CloudObject, type PutFileOptions, type VersionedCloudBucket } from '../src/node/cloud-store/cloud-bucket';
import type { DistrictChunkPlan } from '../src/node/3d-engine/staged-location/pipeline-k/district-chunks';
import {
    acquirePlaceLease, commitPlaceRun, decideVersion, loadPlaceManifest, loadPlaceRecord, openPlaceStore, PLACE_RECORD_SCHEMA, placeKey, recordKey,
    type PlaceMeasures, type PlaceRecord, type PlaceRunCommit, type PlaceStore
} from '../src/node/3d-engine/staged-location/place-store';
import { recordDistrictInPlaceStore } from '../src/node/3d-engine/staged-location/place-store-district';
import { box, testGlb } from './helpers/test-glb';

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
    json<T>(key: string): T { return JSON.parse(this.objects.get(key)!.bytes.toString('utf8')) as T; }
}

let tmp: string;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-place-store-test-')); });
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

const KEY = placeKey({ lat: 40.750568, lng: -73.993519 });
const measures = (holes: number, black: number): PlaceMeasures => ({ holes: { value: holes, better: 'lower' }, blackShare: { value: black, better: 'lower', tol: 0.001 } });

/** A workspace file standing for a GLB of one version. */
function file(name: string, text: string): string {
    const f = path.join(tmp, 'ws', 'public', 'models', name);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, text);
    return f;
}

function run(runId: string, offers: PlaceRunCommit['offers'], at = 1_000): PlaceRunCommit {
    return {
        runId, anchor: { lat: 40.750568, lng: -73.993519, address: 'Penn Station' }, radiusM: 250, edge: { radiusM: 250, grownBy: ['b1'] },
        codeVersion: { commit: 'abc1234', modules: { audit: 'district-audit/1' } }, switches: { 'request.district': 'kd' }, offers,
        workspaceRoot: path.join(tmp, 'ws'), now: () => at
    };
}

const offer = (id: string, files: string[], m: PlaceMeasures): PlaceRunCommit['offers'][number] => ({
    id, idSource: 'google-vector-feature', files: files.map(p => ({ role: 'textured', path: p })), provenance: { remeshed: 1 }, measures: m, defects: []
});

async function cloudStore(bucket: MemoryVersionedBucket): Promise<PlaceStore> {
    return openPlaceStore({ key: KEY, bucket, fallbackRoot: path.join(tmp, 'no-volume', 'scratchbox-places'), tmpDir: path.join(tmp, 'scratch') });
}

describe('place store', () => {
    it('keeps the first version, promotes one no measure of which is worse, and rejects a worse one with its reason', async () => {
        const bucket = new MemoryVersionedBucket();
        const store = await cloudStore(bucket);
        expect(store.where.kind).toBe('cloud');
        expect(store.where.label).toBe(`mem://training/places/v1/${KEY}`);

        const r1 = await commitPlaceRun(store, run('run-1', [offer('16/19300/24630/f12', [file('a1.glb', 'first')], measures(3, 0.02))], 1_000));
        expect(r1.records).toEqual({ added: 1, promoted: 0, rejected: 0, unchanged: 0 });
        expect(r1.errors).toEqual([]);
        expect(r1.blobs.stored).toBe(1);

        const r2 = await commitPlaceRun(store, run('run-2', [offer('16/19300/24630/f12', [file('a2.glb', 'better')], measures(1, 0.0205))], 2_000));
        expect(r2.records.promoted).toBe(1);

        const r3 = await commitPlaceRun(store, run('run-3', [offer('16/19300/24630/f12', [file('a3.glb', 'worse')], measures(0, 0.03))], 3_000));
        expect(r3.records.rejected).toBe(1);
        expect(r3.decisions[0].reason).toContain('blackShare 0.0205 -> 0.0300 (lower is better)');

        const record = (await loadPlaceRecord(store, '16/19300/24630/f12'))!;
        expect(record.schema).toBe(PLACE_RECORD_SCHEMA);
        expect(record.current).toBe('run-2');
        expect(record.versions.map(v => [v.version, v.decision.kept])).toEqual([['run-1', true], ['run-2', true], ['run-3', false]]);
        expect(record.versions[2].decision.worse).toEqual(['blackShare 0.0205 -> 0.0300 (lower is better)']);
        // a rejected version's files are recorded, not stored
        expect(record.versions[2].files[0].blob).toBeUndefined();
        expect(record.versions[1].files[0].blob).toMatch(new RegExp(`^places/v1/${KEY}/blobs/[0-9a-f]{2}/[0-9a-f]{64}\\.glb$`));
        expect(bucket.objects.has(record.versions[1].files[0].blob!)).toBe(true);
        // the record's object key is made safe from Google's id, and its paths are workspace-relative
        expect(bucket.objects.has(`places/v1/${KEY}/records/${recordKey('16/19300/24630/f12')}.json`)).toBe(true);
        expect(record.versions[0].files[0].path).toBe('public/models/a1.glb');

        const { manifest } = (await loadPlaceManifest(store))!;
        expect(manifest.lease).toBeUndefined();
        expect(manifest.anchor).toEqual({ lat: 40.750568, lng: -73.993519, address: 'Penn Station' });
        expect(manifest.records['16/19300/24630/f12'].current).toBe('run-2');
        expect(manifest.runs.map(r => r.runId)).toEqual(['run-1', 'run-2', 'run-3']);
    });

    it('adds nothing for a version whose files are the current one\'s, and rejects one that stops measuring something', async () => {
        const store = await cloudStore(new MemoryVersionedBucket());
        const same = file('same.glb', 'same bytes');
        await commitPlaceRun(store, run('run-1', [offer('b1', [same], measures(1, 0))]));
        const again = await commitPlaceRun(store, run('run-2', [offer('b1', [same], measures(9, 0.5))]));
        expect(again.records.unchanged).toBe(1);
        expect((await loadPlaceRecord(store, 'b1'))!.versions).toHaveLength(1);
        const record: PlaceRecord = (await loadPlaceRecord(store, 'b1'))!;
        const decision = decideVersion(record, { ...record.versions[0], version: 'run-3', runId: 'run-3', files: [{ role: 'textured', path: 'x', sha256: 'f'.repeat(64), bytes: 1 }], measures: { holes: { value: 0, better: 'lower' } } });
        expect(decision).toMatchObject({ kept: false });
        expect(decision !== 'unchanged' && decision.worse).toEqual(['blackShare not measured (was 0)']);
    });

    it('lets one writer at a time hold the lease, and refuses a lapsed holder\'s commit once another has taken it', async () => {
        for (const bucket of [new MemoryVersionedBucket(), new DirectoryCloudBucket(path.join(tmp, 'dir-bucket'))]) {
            const store: PlaceStore = { key: KEY, where: { kind: 'cloud', label: bucket.label }, bucket, prefix: `places/v1/${KEY}`, tmpDir: path.join(tmp, 'scratch') };
            const a = await acquirePlaceLease(store, { holder: 'a', runId: 'run-a' }, 1_000, { leaseMs: 60_000, concurrency: 2 });
            expect(a.ok).toBe(true);
            const b = await acquirePlaceLease(store, { holder: 'b', runId: 'run-b' }, 2_000, { leaseMs: 60_000, concurrency: 2 });
            expect(b).toMatchObject({ ok: false, heldBy: { holder: 'a' } });
            // the lease lapsed: b takes the place over, and a's write over the generation it holds is refused
            const late = await acquirePlaceLease(store, { holder: 'b', runId: 'run-b' }, 100_000, { leaseMs: 60_000, concurrency: 2 });
            expect(late.ok).toBe(true);
            if (!a.ok) throw new Error('unreachable');
            const { writeLeasedManifest } = await import('../src/node/3d-engine/staged-location/place-store');
            expect(await writeLeasedManifest(store, a.manifest, a.generation, false)).toBe('conflict');
            expect((await loadPlaceManifest(store))!.manifest.lease?.holder).toBe('b');
        }
    });

    it('lets only one of two writers who read the same manifest take the lease', async () => {
        for (const bucket of [new MemoryVersionedBucket(), new DirectoryCloudBucket(path.join(tmp, 'dir-race'))]) {
            const store: PlaceStore = { key: KEY, where: { kind: 'cloud', label: bucket.label }, bucket, prefix: `places/v1/${KEY}`, tmpDir: path.join(tmp, 'scratch') };
            const both = await Promise.all([acquirePlaceLease(store, { holder: 'a' }, 1_000), acquirePlaceLease(store, { holder: 'b' }, 1_000)]);
            expect(both.filter(r => r.ok)).toHaveLength(1);
            expect(both.find(r => !r.ok)).toBeDefined();
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
        const r = await commitPlaceRun(store, run('run-1', [offer('b1', [file('b1.glb', 'bytes')], measures(0, 0))]));
        expect(r.where.kind).toBe('fallback');
        expect(r.records.added).toBe(1);
        expect(JSON.parse(fs.readFileSync(path.join(root, KEY, 'manifest.json'), 'utf8')).records.b1.current).toBe('run-1');
        expect(fs.existsSync(path.join(root, KEY, 'records', 'b1.json'))).toBe(true);
        expect(fs.readdirSync(path.join(root, KEY, 'blobs')).length).toBe(1);
    });

    it('is none when neither the bucket nor the volume is there, and never throws', async () => {
        const store = await openPlaceStore({ key: KEY, bucket: null, fallbackRoot: path.join(tmp, 'not-mounted', 'scratchbox-places') });
        expect(store.where.kind).toBe('none');
        expect(store.where.reason).toContain('no cloud bucket is configured');
        expect(store.where.reason).toContain('is not available');
        // the missing mount point is not made
        expect(fs.existsSync(path.join(tmp, 'not-mounted'))).toBe(false);
        const r = await commitPlaceRun(store, run('run-1', [offer('b1', [file('b1.glb', 'bytes')], measures(0, 0))]));
        expect(r.skipped).toContain('is not available');
        expect(r.records.added).toBe(0);
    });

    it('union-merges a record with the versions the bucket already holds', async () => {
        const bucket = new MemoryVersionedBucket();
        const store = await cloudStore(bucket);
        await commitPlaceRun(store, run('run-1', [offer('b1', [file('one.glb', 'one')], measures(2, 0))], 1_000));
        // another machine's version, written while this one did not know it
        const key = `places/v1/${KEY}/records/b1.json`;
        const theirs = bucket.json<PlaceRecord>(key);
        theirs.versions.push({ ...theirs.versions[0], version: 'run-elsewhere', runId: 'run-elsewhere', atMs: 1_500, decision: { kept: false, reason: 'theirs' } });
        const f = path.join(tmp, 'theirs.json');
        fs.writeFileSync(f, JSON.stringify(theirs));
        await bucket.putFile(key, f);
        await commitPlaceRun(store, run('run-2', [offer('b1', [file('two.glb', 'two')], measures(1, 0))], 2_000));
        const record = (await loadPlaceRecord(store, 'b1'))!;
        expect(record.versions.map(v => v.version)).toEqual(['run-1', 'run-elsewhere', 'run-2']);
        expect(record.current).toBe('run-2');
    });

    it('audits a joined district and offers each building, the ground and the trees to the store', async () => {
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
        const scan = (roofless: boolean) => write(`scan_${roofless ? 1 : 0}.glb`, testGlb([{ prims: [box(-5, 0, -5, 5, 10, 5, ['bottom']), box(25, 0, -5, 35, 10, 5, roofless ? ['bottom', 'top'] : ['bottom'])] }]));
        const trees = write('trees.glb', testGlb([{ prims: [box(-2, 0, 40, 2, 6, 44)], translation: [0, 0, 0], extras: { sbTree: { id: 1, hashSeed: 1, label: 'tree' } } }]));
        const input = (runId: string, roofless: boolean) => ({
            runId, place: { lat: 40.750568, lng: -73.993519, formattedAddress: 'Penn Station' }, plan, modelsDir, workspaceRoot: ws,
            layers: [layerOf('stg-scan', 'remesh', scan(roofless), 'remeshed'), layerOf('stg-trees', 'trees', trees, 'grown to the measured crown')],
            request: { query: 'Penn Station', district: 'kd', radiusM: 150 }, env: {},
            store: { bucket, fallbackRoot: path.join(tmp, 'no-volume', 'scratchbox-places'), tmpDir: path.join(tmp, 'scratch') }
        });
        const first = await recordDistrictInPlaceStore(input('run-1', false));
        expect(first.error).toBeUndefined();
        expect(first.where.kind).toBe('cloud');
        expect(first.audit).toMatchObject({ buildings: 2, trees: 1, treesCut: 0, neighbours: 'no vector data' });
        expect(first.commit!.records.added).toBe(4); // two buildings, the ground (none here but its record), the trees
        const whole = (await loadPlaceRecord(await cloudStore(bucket), 'b-whole'))!;
        expect(whole.idSource).toBe('google-vector-feature');
        expect(whole.versions[0].provenance).toEqual({ remeshed: 1 });
        expect(whole.versions[0].measures.holes.value).toBe(0);
        expect(whole.versions[0].switches).toEqual({ 'request.district': 'kd', 'request.radiusM': '150' });
        expect(whole.versions[0].files.map(f => [f.role, f.path])).toEqual([['clay', 'public/models/scan_0.glb']]);

        // the next run loses a roof: that building keeps its first version, with the reason
        const second = await recordDistrictInPlaceStore(input('run-2', true));
        const roofless = (await loadPlaceRecord(await cloudStore(bucket), 'b-roofless'))!;
        expect(roofless.current).toBe('run-1');
        expect(roofless.versions[1].decision.kept).toBe(false);
        expect(roofless.versions[1].decision.reason).toContain('holes 0 -> 1');
        expect(second.commit!.decisions.find(d => d.id === 'b-roofless')!.kept).toBe(false);
    });
});
