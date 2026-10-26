/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import { describe, it, expect, afterAll, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DirectoryCloudBucket, type CloudBucket } from '../src/node/cloud-store/cloud-bucket';
import { DurableAssetStore, sha256OfFile } from '../src/node/asset-store/durable-asset-store';
import {
    BUILDING_TRAINING_PREFIX, captureBuildingTraining, pendingBuildingTraining, resolveTrainingBucketName, type BuildingTrainingCaptureInput, type BuildingTrainingRecord
} from '../src/node/cloud-store/building-training-capture';

const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sbx-training-capture-')));
afterAll(() => fs.rmSync(TMP, { recursive: true, force: true }));

let n = 0;
function fresh(name: string): string {
    const dir = path.join(TMP, `${name}-${n++}`);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
}

/** A file with distinct bytes standing for a GLB or PNG (the capture never parses them). */
function file(dir: string, name: string, body: string): string {
    const f = path.join(dir, name);
    fs.writeFileSync(f, body);
    return f;
}

function input(dir: string, over: Partial<BuildingTrainingCaptureInput> = {}): BuildingTrainingCaptureInput {
    return {
        runId: 'run-1', place: '488 Broadway, New York', anchor: { lat: 40.7213, lng: -73.9993 }, outcome: 'delivered',
        source: 'fal-ai/meshy/v7.1/multi-image-to-3d', pipelineVersion: 'pipeline-i/1',
        files: {
            'input.scan_textured': file(dir, 'scan.glb', 'glTF-scan-textured'), 'input.scan_clay': file(dir, 'scan_clay.glb', 'glTF-scan-clay'),
            'input.view_1': file(dir, 'view_1.png', 'png-view-1'), 'target.textured': file(dir, 'target.glb', 'glTF-target'), 'target.clay': file(dir, 'target_clay.glb', 'glTF-target-clay')
        },
        footprint: { cells: new Set(['1,2', '0,0', '1,1']), groundY: 3.5, heightM: 24 },
        fit: { planIoU: 0.91, coverage: 0.95, overflowShare: 0.04 }, provenanceLabels: ['generated', 'generated'],
        notes: { meshy: { model: 'fal-ai/meshy/v7.1/multi-image-to-3d' } }, now: 1_000,
        ...over
    };
}

async function readRecord(bucket: CloudBucket, id: string, dir: string): Promise<BuildingTrainingRecord> {
    const out = path.join(dir, `${id}.json`);
    expect(await bucket.download(`${BUILDING_TRAINING_PREFIX}/records/${id}.json`, out)).toBe(true);
    return JSON.parse(fs.readFileSync(out, 'utf8'));
}

describe('building training capture', () => {
    const env = { ...process.env };
    afterEach(() => { process.env = { ...env }; });

    it('keeps the pair in the store and uploads blobs and record; targets from runs on Meshy stay evaluation-only', async () => {
        const dir = fresh('run');
        const store = new DurableAssetStore(fresh('home'));
        const bucketDir = fresh('bucket');
        const bucket = new DirectoryCloudBucket(bucketDir);
        const scan = path.join(dir, 'scan.glb');
        const rec = (await captureBuildingTraining(input(dir), { store, bucket }))!;

        expect(rec.outcome).toBe('delivered');
        expect(rec.trainAllowed).toBe(false);
        expect(rec.targetKind).toBe('model-output');
        expect(rec.files.map(f => f.role).sort()).toEqual(['input.scan_clay', 'input.scan_textured', 'input.view_1', 'target.clay', 'target.textured']);
        expect(rec.footprint.cells).toEqual(['0,0', '1,1', '1,2']);
        expect(rec.provenanceLabels).toEqual(['generated']);

        // every blob in the bucket under its hash, byte-identical to the source
        const scanSha = sha256OfFile(scan);
        expect(rec.files.find(f => f.role === 'input.scan_textured')!.sha256).toBe(scanSha);
        const blobs = await bucket.list(`${BUILDING_TRAINING_PREFIX}/blobs/`);
        expect(blobs).toHaveLength(5);
        const blobFile = path.join(bucketDir, ...`${BUILDING_TRAINING_PREFIX}/blobs/${scanSha.slice(0, 2)}/${scanSha}`.split('/'));
        expect(fs.readFileSync(blobFile, 'utf8')).toBe('glTF-scan-textured');

        const uploaded = await readRecord(bucket, rec.id, dir);
        expect(uploaded).toEqual(rec);
        const [meta] = await bucket.list(`${BUILDING_TRAINING_PREFIX}/records/`);
        expect(meta.metadata).toMatchObject({ outcome: 'delivered', trainAllowed: 'false' });
        expect(pendingBuildingTraining(store)).toHaveLength(0);
    });

    it('allows training on our own pipelines and on Trellis, and keeps failures without a target', async () => {
        const dir = fresh('run');
        const store = new DurableAssetStore(fresh('home'));
        const bucket = new DirectoryCloudBucket(fresh('bucket'));
        const ours = (await captureBuildingTraining(input(dir, { source: 'pipeline-h', pipelineVersion: 'pipeline-h/3', notes: { steps: [] } }), { store, bucket }))!;
        expect(ours.trainAllowed).toBe(true);
        expect(ours.targetKind).toBe('pipeline-rebuild');
        const trellis = (await captureBuildingTraining(input(dir, { runId: 'run-t', source: 'fal-ai/trellis/multi', notes: { model: { model: 'fal-ai/trellis/multi', seed: 3 } } }), { store, bucket }))!;
        expect(trellis).toMatchObject({ trainAllowed: true, targetKind: 'model-output' });

        const failed = (await captureBuildingTraining(input(dir, {
            runId: 'run-2', source: 'pipeline-i', outcome: 'failed', reason: 'the character sheet did not hold to the scan',
            files: { 'input.scan_textured': path.join(dir, 'scan.glb') }
        }), { store, bucket }))!;
        expect(failed).toMatchObject({ outcome: 'failed', trainAllowed: false, reason: 'the character sheet did not hold to the scan' });
        expect(failed.files.map(f => f.role)).toEqual(['input.scan_textured']);
        expect(await bucket.list(`${BUILDING_TRAINING_PREFIX}/records/`)).toHaveLength(3);
    });

    it('a delivered run whose target files are gone is recorded as failed, with why', async () => {
        const dir = fresh('run');
        const store = new DurableAssetStore(fresh('home'));
        const rec = (await captureBuildingTraining(input(dir, { source: 'pipeline-g', files: { 'input.scan_textured': file(dir, 's.glb', 'x'), 'target.textured': path.join(dir, 'gone.glb') } }), { store, bucket: new DirectoryCloudBucket(fresh('bucket')) }))!;
        expect(rec.outcome).toBe('failed');
        expect(rec.trainAllowed).toBe(false);
        expect(rec.reason).toContain('target.textured');
    });

    it('a failed upload stays pending and goes with the next capture', async () => {
        const dir = fresh('run');
        const store = new DurableAssetStore(fresh('home'));
        const good = new DirectoryCloudBucket(fresh('bucket'));
        const broken: CloudBucket = { ...good, label: 'broken', putFile: async () => { throw new Error('network down'); }, download: good.download.bind(good), list: good.list.bind(good), remove: good.remove.bind(good) };
        await expect(captureBuildingTraining(input(dir), { store, bucket: broken })).rejects.toThrow('network down');
        expect(pendingBuildingTraining(store)).toHaveLength(1);

        await captureBuildingTraining(input(dir, { runId: 'run-3', source: 'pipeline-h' }), { store, bucket: good });
        expect(pendingBuildingTraining(store)).toHaveLength(0);
        expect(await good.list(`${BUILDING_TRAINING_PREFIX}/records/`)).toHaveLength(2);
    });

    it('captures nothing without a training bucket: only an instance whose home config names one', async () => {
        const home = fresh('home');
        process.env.SCRATCHBOX_HOME = home;
        delete process.env.SCRATCHBOX_TRAINING_BUCKET;
        expect(resolveTrainingBucketName()).toBeUndefined();
        expect(await captureBuildingTraining(input(fresh('run')), { store: new DurableAssetStore(fresh('home')) })).toBeUndefined();

        // the store bucket alone does not turn capture on
        fs.writeFileSync(path.join(home, 'cloud-store.json'), JSON.stringify({ bucket: 'store-only' }));
        expect(resolveTrainingBucketName()).toBeUndefined();
        fs.writeFileSync(path.join(home, 'cloud-store.json'), JSON.stringify({ bucket: 'store-only', trainingBucket: 'train-here' }));
        expect(resolveTrainingBucketName()).toBe('train-here');
        process.env.SCRATCHBOX_TRAINING_BUCKET = 'off';
        expect(resolveTrainingBucketName()).toBeUndefined();
    });
});
