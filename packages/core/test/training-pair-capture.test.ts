/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import { describe, it, expect, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DirectoryCloudBucket } from '../src/node/cloud-store/cloud-bucket';
import { DurableAssetStore } from '../src/node/asset-store/durable-asset-store';
import { captureTrainingPairs, pendingTrainingPairs, recordTrainingPair, trainingPrefix, type TrainingPairCaptureInput, type TrainingPairRecord } from '../src/node/cloud-store/training-pair-capture';
import { BUILDING_TRAINING_PREFIX, captureBuildingTraining, pendingBuildingTraining, recordBuildingTraining, sweepPendingBuildingTraining } from '../src/node/cloud-store/building-training-capture';
import { OBJECT_CROP_MARGIN_M, sceneTrainingPairs } from '../src/node/3d-engine/staged-location/scene-training-pairs';
import { backfillTrainingPairs } from '../src/node/cloud-store/training-pair-backfill';
import type { StoreSceneReport } from '../src/node/3d-engine/staged-location/scene-objects';
import { writeBoxGroundGlb } from './helpers/box-ground-glb';

const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sbx-training-pairs-')));
afterAll(() => fs.rmSync(TMP, { recursive: true, force: true }));
let n = 0;
const fresh = (name: string) => { const d = path.join(TMP, `${name}-${n++}`); fs.mkdirSync(d, { recursive: true }); return d; };
const file = (dir: string, name: string, body: string) => { const f = path.join(dir, name); fs.writeFileSync(f, body); return f; };
/** A real GLB: a 2 x 3 x 2 m box at the origin (the ground grid is shrunk to nothing). */
const boxGlb = (dir: string, name: string) => { const f = path.join(dir, name); writeBoxGroundGlb(f, [-1, 0, -1], [1, 3, 1], 0.001); return f; };

const base = (dir: string, over: Partial<TrainingPairCaptureInput> = {}): TrainingPairCaptureInput => ({
    category: 'object', subject: { kind: 'tree', identity: 'cat-1' }, runId: 'run-1', place: 'Fed Square, Melbourne', anchor: { lat: -37.818, lng: 144.969 },
    outcome: 'delivered', source: 'pipeline-scene-objects', pipelineVersion: 'scene-pairs/1',
    files: { 'input.scan_textured': file(dir, 'scan.glb', 'glTF-scan'), 'target.object': file(dir, 'tree.glb', 'glTF-tree') },
    provenanceLabels: ['grown-to-measured-crown', 'grown-to-measured-crown'], now: 5, ...over
});

describe('training pairs of every category', () => {
    it('records a pair by category with a stable id, stored files, a beyond-scan flag and the licence', () => {
        const dir = fresh('run'), store = new DurableAssetStore(fresh('home'));
        const a = recordTrainingPair(store, base(dir, { targetBeyondScan: { note: 'the back is drawn' } }));
        expect(a.schema).toBe('scratchbox.training-pair/1');
        expect(a.category).toBe('object');
        expect(a.files.map(f => f.role).sort()).toEqual(['input.scan_textured', 'target.object']);
        expect(a.outcome).toBe('delivered');
        expect(a.trainAllowed).toBe(true);
        expect(a.targetKind).toBe('pipeline-rebuild');
        expect(a.targetBeyondScan?.note).toBe('the back is drawn');
        expect(a.provenanceLabels).toEqual(['grown-to-measured-crown']);
        // capturing the same pair again gives the same record
        expect(recordTrainingPair(store, base(dir)).id).toBe(a.id);
        // a blob the store already holds is named by sha256 instead of hashed again
        const reuse = recordTrainingPair(store, base(dir, { subject: { kind: 'tree', identity: 'cat-2' }, files: { 'input.scan_textured': undefined }, storedFiles: { 'target.object': { sha256: a.files.find(f => f.role === 'target.object')!.sha256 } } }));
        expect(reuse.files.find(f => f.role === 'target.object')!.bytes).toBe('glTF-tree'.length);
        expect(reuse.missing).toEqual(['input.scan_textured']);
        // no target, or a licence that forbids training: not trainable
        const noTarget = recordTrainingPair(store, base(dir, { runId: 'run-2', files: { 'input.scan_textured': file(dir, 's2.glb', 'x') } }));
        expect(noTarget.outcome).toBe('failed');
        expect(noTarget.reason).toBe('no target file was given');
        expect(recordTrainingPair(store, base(dir, { runId: 'run-3', trainAllowed: false })).trainAllowed).toBe(false);
        expect(() => trainingPrefix('Bad Label')).toThrow(/plain lowercase/);
        expect(trainingPrefix('district')).toBe('training/district/v1');
    });

    it('uploads blobs and records under training/<category>/v1 and sweeps building records still waiting', async () => {
        const dir = fresh('run'), store = new DurableAssetStore(fresh('home'));
        const bucket = new DirectoryCloudBucket(fresh('bucket'));
        // a building record left waiting by an earlier failed upload
        recordBuildingTraining(store, {
            runId: 'b-1', place: 'x', anchor: { lat: 0, lng: 0 }, outcome: 'delivered', source: 'pipeline-h', pipelineVersion: 'h/1',
            files: { 'input.scan_textured': file(dir, 'b.glb', 'b'), 'target.textured': file(dir, 'bt.glb', 'bt') }, footprint: { cells: ['0,0'], groundY: 0, heightM: 10 }, provenanceLabels: []
        });
        expect(pendingBuildingTraining(store)).toHaveLength(1);
        const out = (await captureTrainingPairs([base(dir), base(dir, { category: 'district', subject: { kind: 'district' }, files: { 'input.scan_textured': file(dir, 'd.glb', 'd'), 'target.layer_l2': file(dir, 'l2.glb', 'l2') } })],
            { store, bucket, sweepOthers: sweepPendingBuildingTraining }))!;
        expect(out.map(r => r.category)).toEqual(['object', 'district']);
        for (const r of out) {
            const local = path.join(dir, `${r.id}.json`);
            expect(await bucket.download(`${trainingPrefix(r.category)}/records/${r.id}.json`, local)).toBe(true);
            const rec = JSON.parse(fs.readFileSync(local, 'utf8')) as TrainingPairRecord;
            expect(rec.category).toBe(r.category);
            for (const f of rec.files) expect((await bucket.list(`${trainingPrefix(r.category)}/blobs/${f.sha256.slice(0, 2)}/`)).some(o => o.key.endsWith(f.sha256))).toBe(true);
        }
        expect(pendingTrainingPairs(store)).toHaveLength(0);
        expect(pendingBuildingTraining(store)).toHaveLength(0);
        expect(await bucket.list(`${BUILDING_TRAINING_PREFIX}/records/`)).toHaveLength(1);
        // no bucket: nothing is captured
        expect(await captureTrainingPairs([base(dir)], { store: new DurableAssetStore(fresh('home')) })).toBeUndefined();
    });

    it('a finished scene gives one object pair per catalog object that is not a building, cropped to its box, and a district pair for a district', () => {
        const dir = fresh('scene'), store = new DurableAssetStore(fresh('home'));
        const tree = store.putFile(boxGlb(dir, 'tree.glb'), { servedPath: '/models/objects/tree/t.glb', origin: 'test' });
        const bldg = store.putFile(file(dir, 'b.glb', 'glTF-building'), { servedPath: '/models/objects/building/b.glb', origin: 'test' });
        const ground = store.putFile(file(dir, 'g.glb', 'glTF-ground'), { servedPath: '/models/objects/ground/g.glb', origin: 'test' });
        const layer = store.putFile(file(dir, 'massing.glb', 'glTF-massing'), { servedPath: '/models/fed_massing_1.glb', origin: 'test' });
        const kept: StoreSceneReport['kept'] = [
            { objectKey: 'tree/cat-1@h', version: 1, kind: 'tree', identity: 'cat-1', layer: 'l2t', glbPath: tree.path, sha256: tree.sha256, catalogType: 'SB_FEATURE_TYPE_TREE', wgs84: { lat: 1, lng: 2, altM: 3 }, provenanceLabels: ['grown-to-measured-crown'], inputs: { stem: [0, 0] } },
            { objectKey: 'building/f1@h', version: 1, kind: 'building', identity: 'f1', layer: 'l2v', glbPath: bldg.path, sha256: bldg.sha256, catalogType: 'FEATURE_TYPE_BUILDING', provenanceLabels: ['vector-massing'] },
            { objectKey: 'ground/g@h', version: 1, kind: 'ground', identity: 'g', layer: 'l1', glbPath: ground.path, sha256: ground.sha256, provenanceLabels: ['measured'] }
        ];
        const scan = file(dir, 'scan.glb', 'glTF-raw-extraction');
        const common = { runId: 'run-s', place: 'Fed Square', anchor: { lat: -37.8, lng: 144.9 }, scanGlb: scan, store, report: { kept, failed: [] },
            liveLayers: [{ layer: 'l2v', url: layer.path, provenanceLabels: ['vector-massing'] }, { layer: 'gone', url: '/models/not-stored.glb', provenanceLabels: [] }] };

        const district = sceneTrainingPairs({ ...common, isolate: false });
        expect(district.map(p => `${p.category}/${p.subject.kind}`)).toEqual(['object/tree', 'district/district']);
        const obj = district[0];
        expect(obj.storedFiles!['target.object'].sha256).toBe(tree.sha256);
        expect(obj.crops![0].min).toEqual([-1 - OBJECT_CROP_MARGIN_M, -OBJECT_CROP_MARGIN_M, -1 - OBJECT_CROP_MARGIN_M]);
        expect(obj.crops![0].max).toEqual([1 + OBJECT_CROP_MARGIN_M, 3 + OBJECT_CROP_MARGIN_M, 1 + OBJECT_CROP_MARGIN_M]);
        expect(obj.crops![0].wgs84).toEqual({ lat: 1, lng: 2, altM: 3 });
        const d = district[1];
        expect(Object.keys(d.storedFiles!)).toEqual(['target.layer_l2v']);
        expect(d.links!.map(l => `${l.category}:${l.id}`)).toEqual(['building:building/f1@h', 'object:tree/cat-1@h']);
        expect(d.outcome).toBe('delivered');
        // an isolate run's building has its own capture: only its objects are paired
        expect(sceneTrainingPairs({ ...common, isolate: true }).map(p => p.category)).toEqual(['object']);
        // the pairs record: the district's targets are the stored layer blobs
        const rec = recordTrainingPair(store, d);
        expect(rec.files.map(f => f.role).sort()).toEqual(['input.scan_textured', 'target.layer_l2v']);
    });

    it('backfills district and object pairs from the scenes the store kept, and reports a scene whose scan is gone', () => {
        const dir = fresh('backfill'), store = new DurableAssetStore(fresh('home'));
        const tiles = store.putFile(file(dir, 'tiles.glb', 'glTF-raw-tiles'), { servedPath: '/models/fed_tiles_1.glb', origin: 'staged-location' });
        const massing = store.putFile(file(dir, 'massing.glb', 'glTF-massing'), { servedPath: '/models/fed_massing_1.glb', origin: 'staged-location' });
        const tree = store.putFile(boxGlb(dir, 'tree.glb'), { servedPath: '/models/objects/tree/t1.glb', origin: 'scene-object-store' });
        const treeRec = store.putFile(file(dir, 'tree.json', JSON.stringify({ provenance: { labels: ['grown-to-measured-crown'] }, producer: { layer: 'l2t' } })), { servedPath: '/models/objects/tree/t1.json', origin: 'scene-object-store' });
        store.db.upsertObject({ id: 'cat-1', type: 'SB_FEATURE_TYPE_TREE', label: null, confidence: null, lat: -37.81, lng: 144.96, bboxLoLat: -37.81, bboxLoLng: 144.96, bboxLoAlt: 10, bboxHiLat: -37.81, bboxHiLng: 144.96, bboxHiAlt: 20, source: 'test', runId: 'run-a', workspace: null } as never);
        store.db.insertObjectVersion({ objectKey: 'tree/cat-1@h', kind: 'tree', identity: 'cat-1', locationHash: 'h', inputHash: 'i', glbPath: tree.path, glbSha256: tree.sha256, recordPath: treeRec.path, catalogId: 'cat-1', runId: 'run-a', workspace: null });
        store.putRecipe({ id: 'run-a', kind: 'staged-location', body: { runId: 'run-a', request: { query: 'Fed Square', isolate: false }, place: { lat: -37.8, lng: 144.9, formattedAddress: 'Fed Square, Melbourne' } } });
        store.putRecipe({ id: 'scene-a', kind: 'scene-record', body: { schema: 'scratchbox.scene/1', runId: 'run-a', objects: [{ objectKey: 'tree/cat-1@h', version: 1 }],
            layers: [{ layer: 'l1t', stage: 'tiles', url: tiles.path, sha256: tiles.sha256 }, { layer: 'l2v', stage: 'massing', url: massing.path, sha256: massing.sha256, provenance: 'vector-massing' }] } });
        store.putRecipe({ id: 'scene-b', kind: 'scene-record', body: { schema: 'scratchbox.scene/1', runId: 'run-b', objects: [], layers: [{ layer: 'l1t', stage: 'tiles', url: '/models/gone.glb' }] } });
        store.putRecipe({ id: 'run-b', kind: 'staged-location', body: { runId: 'run-b', place: { lat: 0, lng: 0 } } });

        const report = backfillTrainingPairs(store);
        expect(report.scenes).toBe(2);
        expect(report.pairs.map(p => `${p.category}/${p.kind}/${p.outcome}`)).toEqual(['object/tree/delivered', 'district/district/delivered']);
        expect(report.skipped).toEqual([{ runId: 'run-b', reason: 'the scene\'s raw tiles layer is no longer in the store' }]);
        const pairs = pendingTrainingPairs(store);
        const obj = pairs.find(p => p.category === 'object')!;
        expect(obj.files.find(f => f.role === 'input.scan_textured')!.sha256).toBe(tiles.sha256);
        expect(obj.provenanceLabels).toEqual(['grown-to-measured-crown']);
        expect(obj.crops![0].wgs84).toEqual({ lat: -37.81, lng: 144.96, altM: 15 });
        const dist = pairs.find(p => p.category === 'district')!;
        expect(dist.files.map(f => f.role).sort()).toEqual(['input.scan_textured', 'target.layer_l2v']);
        // running it again records the same pairs, not new ones
        backfillTrainingPairs(store);
        expect(pendingTrainingPairs(store)).toHaveLength(2);

        // a scene whose full record is gone: the run's own published tiles layer is the scan; its layers are unknown, so
        // the district pair is kept as failed with that reason while its objects still pair
        const tiles2 = store.putFile(file(dir, 'tiles2.glb', 'glTF-raw-tiles-2'), { servedPath: '/models/mel_tiles_4b35ebef.glb', origin: 'staged-location', recipeId: 'staged:run-c' });
        store.db.insertObjectVersion({ objectKey: 'tree/cat-1@h2', kind: 'tree', identity: 'cat-1', locationHash: 'h2', inputHash: 'i2', glbPath: tree.path, glbSha256: tree.sha256, recordPath: treeRec.path, catalogId: 'cat-1', runId: 'run-c', workspace: null });
        store.putRecipe({ id: 'run-c', kind: 'staged-location', body: { runId: 'run-c', request: { isolate: false }, place: { lat: 1, lng: 2, formattedAddress: 'Mel' }, keys: { tiles: '4b35ebef00' } } });
        store.putRecipe({ id: 'scene-c', kind: 'scene-record', body: { schema: 'scratchbox.scene/1', runId: 'run-c', path: '/models/scenes/gone.json', objects: [{ objectKey: 'tree/cat-1@h2', version: 1 }] } });
        const r2 = backfillTrainingPairs(store);
        const c = r2.pairs.filter(p => p.runId === 'run-c').map(p => `${p.category}/${p.outcome}`);
        expect(c).toEqual(['object/delivered', 'district/failed']);
        const failed = pendingTrainingPairs(store).find(p => p.runId === 'run-c' && p.category === 'district')!;
        expect(failed.reason).toContain('live layers');
        expect(failed.files.find(f => f.role === 'input.scan_textured')!.sha256).toBe(tiles2.sha256);
    });

    it('a building record now says its category and can carry the beyond-scan flag; old fields unchanged', async () => {
        const dir = fresh('run'), store = new DurableAssetStore(fresh('home'));
        const rec = (await captureBuildingTraining({
            runId: 'i-1', place: 'x', anchor: { lat: 0, lng: 0 }, outcome: 'delivered', source: 'fal-ai/trellis/multi', pipelineVersion: 'pipeline-i/2',
            files: { 'input.scan_textured': file(dir, 's.glb', 's'), 'target.textured': file(dir, 't.glb', 't') }, footprint: { cells: ['0,0'], groundY: 0, heightM: 5 },
            provenanceLabels: ['generated'], targetBeyondScan: { note: 'sides the scan did not see are generated' }
        }, { store, bucket: new DirectoryCloudBucket(fresh('bucket')) }))!;
        expect(rec.schema).toBe('scratchbox.building-training/1');
        expect(rec.category).toBe('building');
        expect(rec.targetBeyondScan?.note).toContain('generated');
        expect(rec.trainAllowed).toBe(true);
    });
});
