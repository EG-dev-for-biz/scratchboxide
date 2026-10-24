/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Training data from every 3D Building run (docs/research/2026-10-24-building-training-capture-plan.md): the melted
 * scan a build started from, paired with the finished building it delivered (pipeline I's fitted Trellis model, or a
 * pipeline's rebuild), with the fit, the footprint and the provenance that say how good the pair is. A failed build is kept too,
 * with no target and its reason, for evaluation.
 *
 * Capture runs only where a training bucket is configured: SCRATCHBOX_TRAINING_BUCKET (`off` disables), else
 * `trainingBucket` in `<scratchbox home>/cloud-store.json`. Isolated SCRATCHBOX_HOME instances and tests have no such
 * config, so they write nothing. The record and its files go into the durable asset store first (they outlive the
 * stage cache), then to the bucket: `training/building/v1/blobs/<aa>/<sha256>` written once, and
 * `training/building/v1/records/<id>.json`. A record whose upload failed is sent again by the next capture's sweep.
 * Nothing here ever fails a build: callers start it and forget it.
 */

import * as crypto from 'crypto';
import * as fs from 'fs-extra';
import * as os from 'os';
import * as path from 'path';
import { DurableAssetStore, defaultDurableAssetStore } from '../asset-store/durable-asset-store';
import { scratchboxHome } from '../asset-store/scratchbox-home';
import { GcsCloudBucket, type CloudBucket } from './cloud-bucket';
import { GoogleMediaCredentialsService } from '../google-media-credentials-service';

export const BUILDING_TRAINING_SCHEMA = 'scratchbox.building-training/1';
export const BUILDING_TRAINING_RECIPE_KIND = 'building-training-record';
export const BUILDING_TRAINING_PREFIX = 'training/building/v1';
const UPLOADED_EVENT = 'training.uploaded';

/** Which builder made the target (an open label: pipeline names grow). */
export type BuildingTrainingSource = 'fal-ai/trellis/multi' | 'pipeline-e' | 'pipeline-g' | 'pipeline-h' | 'pipeline-i' | (string & {});

/**
 * What made the target: "model-output" when a neural 3D model drew it (pipeline I's Trellis), "pipeline-rebuild" when our
 * own pipelines built it. A Trellis fine-tune trained on Trellis outputs mostly relearns itself, so the sharding job weighs
 * the two apart.
 */
export type BuildingTrainingTargetKind = 'model-output' | 'pipeline-rebuild';

export interface BuildingTrainingFile {
    /** What the file is in the pair, e.g. "input.scan_textured", "input.view_1", "target.textured". */
    role: string;
    sha256: string;
    bytes: number;
    mime: string | null;
}

export interface BuildingTrainingRecord {
    schema: typeof BUILDING_TRAINING_SCHEMA;
    id: string;
    runId: string;
    createdAtMs: number;
    place: string;
    anchor: { lat: number; lng: number };
    /** "delivered": the target is the building the run showed; "failed": no target, `reason` says why. */
    outcome: 'delivered' | 'failed';
    reason?: string;
    source: BuildingTrainingSource;
    targetKind: BuildingTrainingTargetKind;
    pipelineVersion: string;
    /**
     * Whether the target may be trained on. Trellis (MIT) and our own pipelines' targets may; Meshy outputs from runs
     * before pipeline I moved to Trellis (2026-10-24) stay evaluation-only; failed runs have no target to train on.
     */
    trainAllowed: boolean;
    files: BuildingTrainingFile[];
    /** The scan's footprint (1 m cells "x,z" in the tile frame, x east, z south) and height envelope. */
    footprint: { cells: string[]; groundY: number; heightM: number };
    /** The target's fit to the scan (register.ts for pipeline I), when measured. */
    fit?: { planIoU: number; coverage: number; overflowShare: number; heightRatio?: number; yawDeg?: number; scale?: number; mirrored?: boolean };
    provenanceLabels: string[];
    /** Builder-specific notes (steps, sheet QC, the model job), kept as they were reported. */
    notes?: unknown;
}

export interface BuildingTrainingCaptureInput {
    runId: string;
    place: string;
    anchor: { lat: number; lng: number };
    outcome: 'delivered' | 'failed';
    reason?: string;
    source: BuildingTrainingSource;
    pipelineVersion: string;
    /** Files by role; missing files are left out of the record (and named in `missing`). */
    files: Record<string, string | undefined>;
    footprint: { cells: Iterable<string>; groundY: number; heightM: number };
    fit?: BuildingTrainingRecord['fit'];
    provenanceLabels: string[];
    notes?: unknown;
    now?: number;
}

/** The training bucket's name, or undefined when this instance does not capture. */
export function resolveTrainingBucketName(): string | undefined {
    const fromEnv = process.env.SCRATCHBOX_TRAINING_BUCKET?.trim();
    if (fromEnv) return fromEnv === 'off' ? undefined : fromEnv;
    try {
        const bucket = fs.readJsonSync(path.join(scratchboxHome(), 'cloud-store.json'))?.trainingBucket;
        return typeof bucket === 'string' && bucket.trim() ? bucket.trim() : undefined;
    } catch {
        return undefined;
    }
}

let shared: { name: string; bucket: CloudBucket } | undefined;

/** The process-wide training bucket, or undefined when none is configured. */
export function defaultTrainingBucket(): CloudBucket | undefined {
    const name = resolveTrainingBucketName();
    if (!name) return undefined;
    if (shared?.name !== name) {
        const storage = new GoogleMediaCredentialsService().createStorageClient();
        shared = { name, bucket: new GcsCloudBucket(storage.bucket(name)) };
    }
    return shared.bucket;
}

function isMeshy(source: string, notes: unknown): boolean {
    if (/meshy/i.test(source)) return true;
    const model = (notes as { meshy?: { model?: unknown } } | undefined)?.meshy?.model;
    return typeof model === 'string' && /meshy/i.test(model);
}

/**
 * Keeps one run's pair in the store and returns its record (not yet uploaded). The record id is fixed by the run and
 * the target, so capturing the same run twice gives one record.
 */
export function recordBuildingTraining(store: DurableAssetStore, input: BuildingTrainingCaptureInput): BuildingTrainingRecord & { missing: string[] } {
    const files: BuildingTrainingFile[] = [];
    const missing: string[] = [];
    const id = crypto.createHash('sha256').update(input.runId).update(input.source).update(input.pipelineVersion).update(input.outcome).digest('hex').slice(0, 20);
    for (const [role, file] of Object.entries(input.files)) {
        if (!file || !fs.existsSync(file) || !fs.statSync(file).isFile()) { missing.push(role); continue; }
        const stored = store.putFile(file, { servedPath: `/training/building/${id}/${role}${path.extname(file).toLowerCase()}`, origin: 'training-capture', recipeId: id });
        files.push({ role, sha256: stored.sha256, bytes: stored.bytes, mime: stored.mime });
    }
    const delivered = input.outcome === 'delivered' && files.some(f => f.role.startsWith('target.'));
    const record: BuildingTrainingRecord = {
        schema: BUILDING_TRAINING_SCHEMA, id, runId: input.runId, createdAtMs: input.now ?? Date.now(), place: input.place, anchor: input.anchor,
        outcome: delivered ? 'delivered' : 'failed',
        ...(input.reason ? { reason: input.reason } : !delivered && input.outcome === 'delivered' ? { reason: `the target files were missing: ${missing.join(', ')}` } : {}),
        source: input.source, targetKind: /^pipeline-/.test(input.source) ? 'pipeline-rebuild' : 'model-output', pipelineVersion: input.pipelineVersion,
        trainAllowed: delivered && !isMeshy(input.source, input.notes),
        files, footprint: { cells: [...input.footprint.cells].sort(), groundY: input.footprint.groundY, heightM: input.footprint.heightM },
        ...(input.fit ? { fit: input.fit } : {}), provenanceLabels: [...new Set(input.provenanceLabels)],
        ...(input.notes !== undefined ? { notes: input.notes } : {})
    };
    store.putRecipe({ id, kind: BUILDING_TRAINING_RECIPE_KIND, body: record });
    return { ...record, missing };
}

/** Sends one record and its blobs to the bucket (blobs first, so a record in the bucket never names a missing blob). */
export async function uploadBuildingTraining(store: DurableAssetStore, bucket: CloudBucket, record: BuildingTrainingRecord): Promise<void> {
    for (const f of record.files) {
        await bucket.putFile(`${BUILDING_TRAINING_PREFIX}/blobs/${f.sha256.slice(0, 2)}/${f.sha256}`, store.blobPath(f.sha256), { onlyIfAbsent: true, ...(f.mime ? { contentType: f.mime } : {}) });
    }
    const tmp = path.join(os.tmpdir(), `sb-training-${record.id}-${crypto.randomBytes(4).toString('hex')}.json`);
    try {
        await fs.writeJson(tmp, record);
        await bucket.putFile(`${BUILDING_TRAINING_PREFIX}/records/${record.id}.json`, tmp, {
            contentType: 'application/json',
            metadata: { schema: record.schema, source: record.source, outcome: record.outcome, trainAllowed: String(record.trainAllowed) }
        });
    } finally {
        await fs.remove(tmp);
    }
    store.db.addEvent(UPLOADED_EVENT, record.id, null, { bucket: bucket.label });
}

/** Records in the store whose upload has not been confirmed. */
export function pendingBuildingTraining(store: DurableAssetStore): BuildingTrainingRecord[] {
    return store.db.recipesOfKind(BUILDING_TRAINING_RECIPE_KIND)
        .filter(r => !store.events({ subject: r.id, limit: 50 }).some(e => e.kind === UPLOADED_EVENT))
        .map(r => r.body as BuildingTrainingRecord);
}

/**
 * Records one run's pair and uploads it with every earlier record still waiting. Returns undefined when this
 * instance does not capture (no training bucket, or no asset store). Throws only on its own failures; the
 * orchestrator calls it through `captureBuildingTrainingInBackground`.
 */
export async function captureBuildingTraining(input: BuildingTrainingCaptureInput, deps: { store?: DurableAssetStore; bucket?: CloudBucket } = {}): Promise<BuildingTrainingRecord | undefined> {
    const bucket = deps.bucket ?? defaultTrainingBucket();
    if (!bucket) return undefined;
    const store = deps.store ?? defaultDurableAssetStore();
    if (!store) return undefined;
    // hashing the files is synchronous: it waits for the stage that called it to finish its turn first
    await new Promise(resolve => setImmediate(resolve));
    const { missing: _missing, ...record } = recordBuildingTraining(store, input);
    for (const pending of pendingBuildingTraining(store)) await uploadBuildingTraining(store, bucket, pending);
    return record;
}

/** captureBuildingTraining started and forgotten: the build never waits on it and its failure is only logged. */
export function captureBuildingTrainingInBackground(input: BuildingTrainingCaptureInput): void {
    if (!resolveTrainingBucketName()) return;
    void captureBuildingTraining(input)
        .then(r => { if (r) console.log(`[training-capture] ${r.source} ${r.outcome} pair ${r.id} for run ${r.runId} (${r.files.length} files${r.trainAllowed ? '' : ', evaluation only'})`); })
        .catch(err => console.warn(`[training-capture] run ${input.runId} was not captured (sent again with the next capture): ${(err as Error).message}`));
}
