/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Training pairs of every category (user decision, 2026-10-24): the Google 3D Tiles scan a build started from, paired
 * with the refined output it delivered, kept apart by category: a building (one isolated structure and its rebuild), a
 * district (the raw extraction and the finished scene), an object (a part cut out of the scan, such as a tree crown, a
 * roof object or street furniture, and what replaced it). `category` is an open label: a new kind of pair needs no code
 * change. Buildings keep their own record (building-training-capture.ts, schema scratchbox.building-training/1); every
 * other category is recorded here as scratchbox.training-pair/1.
 *
 * Same rules as the building capture: only where a training bucket is configured; the record and its files go into the
 * durable asset store first, then to `training/<category>/v1/{blobs,records}` in the bucket (blobs once, by sha256); a
 * record whose upload failed is sent again by the next capture's sweep; a failed run is kept with its reason; nothing
 * here ever fails a build.
 */

import * as crypto from 'crypto';
import * as fs from 'fs-extra';
import * as os from 'os';
import * as path from 'path';
import type { DurableAssetStore } from '../asset-store/durable-asset-store';
import { defaultDurableAssetStore } from '../asset-store/durable-asset-store';
import { scratchboxHome } from '../asset-store/scratchbox-home';
import { GcsCloudBucket, type CloudBucket } from './cloud-bucket';
import { GoogleMediaCredentialsService } from '../google-media-credentials-service';

export const TRAINING_PAIR_SCHEMA = 'scratchbox.training-pair/1';
export const TRAINING_PAIR_RECIPE_KIND = 'training-pair-record';
export const TRAINING_UPLOADED_EVENT = 'training.uploaded';

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

/** What the pair is of (an open label: categories grow). */
export type TrainingCategory = 'building' | 'district' | 'object' | (string & {});

/** The bucket prefix of a category's pairs. */
export function trainingPrefix(category: TrainingCategory): string {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(category)) throw new Error(`training category "${category}" is not a plain lowercase label`);
    return `training/${category}/v1`;
}

export interface TrainingPairFile {
    /** What the file is in the pair, e.g. "input.scan_textured", "target.object". */
    role: string;
    sha256: string;
    bytes: number;
    mime: string | null;
}

/**
 * The part of an input file the pair is about, when the input holds more than the subject (an object's own region of the
 * district extraction): an axis-aligned box in the input's frame (metres; tile frame: x east, y up, z south), and the
 * same place on Earth. The sharding job cuts the input to it.
 */
export interface TrainingCrop {
    role: string;
    min: [number, number, number];
    max: [number, number, number];
    wgs84?: { lat: number; lng: number; altM?: number };
}

export interface TrainingPairRecord {
    schema: typeof TRAINING_PAIR_SCHEMA;
    id: string;
    category: TrainingCategory;
    /** What the pair is of: its kind (an object's kind, e.g. "tree") and its identity where it has one. */
    subject: { kind: string; identity?: string };
    runId: string;
    createdAtMs: number;
    place: string;
    anchor: { lat: number; lng: number };
    /** "delivered": the target is what the run showed; "failed": no target, `reason` says why. */
    outcome: 'delivered' | 'failed';
    reason?: string;
    /** Which builder made the target (an open label), and its version. */
    source: string;
    pipelineVersion: string;
    /** "model-output" when a neural 3D model drew the target, "pipeline-rebuild" when our own pipelines built it. */
    targetKind: 'model-output' | 'pipeline-rebuild';
    /** Whether the target may be trained on (its licence; failed runs have no target). */
    trainAllowed: boolean;
    /** The target shows parts no scan saw (sides, backs, roofs drawn by a model): trainers weigh these apart. */
    targetBeyondScan?: { note: string };
    files: TrainingPairFile[];
    crops?: TrainingCrop[];
    /** Other pairs this one is made of or belongs to (a district's objects), by category and record id or object key. */
    links?: Array<{ category: TrainingCategory; id: string; role?: string }>;
    provenanceLabels: string[];
    notes?: unknown;
}

export interface TrainingPairCaptureInput {
    category: TrainingCategory;
    subject: { kind: string; identity?: string };
    runId: string;
    place: string;
    anchor: { lat: number; lng: number };
    outcome: 'delivered' | 'failed';
    reason?: string;
    source: string;
    pipelineVersion: string;
    /** Files by role; missing files are left out (and named in `missing`). */
    files: Record<string, string | undefined>;
    /** Store each file under this one instead of hashing it again (a blob the store already holds, by sha256). */
    storedFiles?: Record<string, { sha256: string }>;
    crops?: TrainingCrop[];
    links?: TrainingPairRecord['links'];
    targetBeyondScan?: { note: string };
    /** False for targets whose licence forbids training (default: delivered pairs may be trained on). */
    trainAllowed?: boolean;
    provenanceLabels: string[];
    notes?: unknown;
    now?: number;
}

/**
 * Keeps one pair in the store and returns its record (not yet uploaded). The id is fixed by the run, the category, the
 * subject and the builder, so capturing the same pair twice gives one record.
 */
export function recordTrainingPair(store: DurableAssetStore, input: TrainingPairCaptureInput): TrainingPairRecord & { missing: string[] } {
    const prefix = trainingPrefix(input.category);
    const id = crypto.createHash('sha256').update(input.category).update(input.subject.kind).update(input.subject.identity ?? '')
        .update(input.runId).update(input.source).update(input.pipelineVersion).update(input.outcome).digest('hex').slice(0, 20);
    const files: TrainingPairFile[] = [];
    const missing: string[] = [];
    for (const [role, ref] of Object.entries(input.storedFiles ?? {})) {
        const meta = store.db.blob(ref.sha256);
        if (!meta || !fs.existsSync(store.blobPath(ref.sha256))) { missing.push(role); continue; }
        files.push({ role, sha256: ref.sha256, bytes: meta.bytes, mime: meta.mime });
    }
    for (const [role, file] of Object.entries(input.files)) {
        if (!file || !fs.existsSync(file) || !fs.statSync(file).isFile()) { missing.push(role); continue; }
        const stored = store.putFile(file, { servedPath: `/${prefix}/${id}/${role}${path.extname(file).toLowerCase()}`, origin: 'training-capture', recipeId: id });
        files.push({ role, sha256: stored.sha256, bytes: stored.bytes, mime: stored.mime });
    }
    const delivered = input.outcome === 'delivered' && files.some(f => f.role.startsWith('target.'));
    const record: TrainingPairRecord = {
        schema: TRAINING_PAIR_SCHEMA, id, category: input.category, subject: input.subject, runId: input.runId, createdAtMs: input.now ?? Date.now(),
        place: input.place, anchor: input.anchor, outcome: delivered ? 'delivered' : 'failed',
        ...(input.reason ? { reason: input.reason } : !delivered && input.outcome === 'delivered'
            ? { reason: missing.some(r => r.startsWith('target.')) ? `the target files were missing: ${missing.filter(r => r.startsWith('target.')).join(', ')}` : 'no target file was given' } : {}),
        source: input.source, pipelineVersion: input.pipelineVersion, targetKind: /^pipeline-/.test(input.source) ? 'pipeline-rebuild' : 'model-output',
        trainAllowed: delivered && input.trainAllowed !== false,
        ...(input.targetBeyondScan ? { targetBeyondScan: input.targetBeyondScan } : {}),
        files, ...(input.crops?.length ? { crops: input.crops } : {}), ...(input.links?.length ? { links: input.links } : {}),
        provenanceLabels: [...new Set(input.provenanceLabels)], ...(input.notes !== undefined ? { notes: input.notes } : {})
    };
    store.putRecipe({ id, kind: TRAINING_PAIR_RECIPE_KIND, body: record });
    return { ...record, missing };
}

/** What an upload needs of a record: where it goes, its files, and the bucket metadata it carries. */
export interface UploadableTrainingRecord {
    id: string;
    prefix: string;
    files: Array<{ sha256: string; mime: string | null }>;
    body: unknown;
    metadata: Record<string, string>;
}

/** Sends one record and its blobs to the bucket (blobs first, so a record in the bucket never names a missing blob). */
export async function uploadTrainingRecord(store: DurableAssetStore, bucket: CloudBucket, r: UploadableTrainingRecord): Promise<void> {
    for (const f of r.files) {
        await bucket.putFile(`${r.prefix}/blobs/${f.sha256.slice(0, 2)}/${f.sha256}`, store.blobPath(f.sha256), { onlyIfAbsent: true, ...(f.mime ? { contentType: f.mime } : {}) });
    }
    const tmp = path.join(os.tmpdir(), `sb-training-${r.id}-${crypto.randomBytes(4).toString('hex')}.json`);
    try {
        await fs.writeJson(tmp, r.body);
        await bucket.putFile(`${r.prefix}/records/${r.id}.json`, tmp, { contentType: 'application/json', metadata: r.metadata });
    } finally {
        await fs.remove(tmp);
    }
    store.db.addEvent(TRAINING_UPLOADED_EVENT, r.id, null, { bucket: bucket.label });
}

export function uploadableTrainingPair(record: TrainingPairRecord): UploadableTrainingRecord {
    return {
        id: record.id, prefix: trainingPrefix(record.category), files: record.files, body: record,
        metadata: { schema: record.schema, category: record.category, kind: record.subject.kind, source: record.source, outcome: record.outcome, trainAllowed: String(record.trainAllowed) }
    };
}

function isUploaded(store: DurableAssetStore, id: string): boolean {
    return store.events({ subject: id, limit: 50 }).some(e => e.kind === TRAINING_UPLOADED_EVENT);
}

/** Pairs of every non-building category in the store whose upload has not been confirmed. */
export function pendingTrainingPairs(store: DurableAssetStore): TrainingPairRecord[] {
    return store.db.recipesOfKind(TRAINING_PAIR_RECIPE_KIND).filter(r => !isUploaded(store, r.id)).map(r => r.body as TrainingPairRecord);
}

/**
 * Records pairs and uploads them with every earlier record still waiting (of any category, buildings included through
 * `sweepOthers`). Returns undefined when this instance does not capture (no bucket, or no asset store).
 */
export async function captureTrainingPairs(
    inputs: TrainingPairCaptureInput[],
    deps: { store?: DurableAssetStore; bucket?: CloudBucket; sweepOthers?: (store: DurableAssetStore, bucket: CloudBucket) => Promise<void> } = {}
): Promise<TrainingPairRecord[] | undefined> {
    const bucket = deps.bucket ?? defaultTrainingBucket();
    if (!bucket) return undefined;
    const store = deps.store ?? defaultDurableAssetStore();
    if (!store) return undefined;
    // hashing the files is synchronous: it waits for the stage that called it to finish its turn first
    await new Promise(resolve => setImmediate(resolve));
    const out: TrainingPairRecord[] = [];
    for (const input of inputs) {
        await new Promise(resolve => setImmediate(resolve));
        const { missing: _missing, ...record } = recordTrainingPair(store, input);
        out.push(record);
    }
    for (const pending of pendingTrainingPairs(store)) await uploadTrainingRecord(store, bucket, uploadableTrainingPair(pending));
    if (deps.sweepOthers) await deps.sweepOthers(store, bucket);
    return out;
}

/** captureTrainingPairs started and forgotten: the build never waits on it and its failure is only logged. */
export function captureTrainingPairsInBackground(inputs: TrainingPairCaptureInput[], sweepOthers?: (store: DurableAssetStore, bucket: CloudBucket) => Promise<void>): void {
    if (!inputs.length || !resolveTrainingBucketName()) return;
    void captureTrainingPairs(inputs, sweepOthers ? { sweepOthers } : {})
        .then(rs => {
            if (!rs) return;
            const by = new Map<string, number>();
            for (const r of rs) by.set(`${r.category}/${r.subject.kind}`, (by.get(`${r.category}/${r.subject.kind}`) ?? 0) + 1);
            console.log(`[training-capture] run ${inputs[0].runId}: ${[...by].map(([k, n]) => `${n} ${k}`).join(', ')} pair(s) kept`);
        })
        .catch(err => console.warn(`[training-capture] run ${inputs[0].runId}: pairs were not all captured (sent again with the next capture): ${(err as Error).message}`));
}
