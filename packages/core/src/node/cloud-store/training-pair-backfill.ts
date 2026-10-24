/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * District and object training pairs for builds finished before the capture existed (training-pair-capture.ts), made
 * from what the durable asset store kept of them: each scene record (scene-object-store.ts), its staged run's request
 * and place, the scene's tiles layer (the raw scan as it was published), and its objects' versions with their catalog
 * rows. The same pairs a live build records now (scene-training-pairs.ts); a scene whose scan the store no longer holds
 * is reported, not guessed.
 */

import * as fs from 'fs-extra';
import type { DurableAssetStore } from '../asset-store/durable-asset-store';
import { sceneTrainingPairs } from '../3d-engine/staged-location/scene-training-pairs';
import type { StoreSceneReport } from '../3d-engine/staged-location/scene-objects';
import { recordTrainingPair, type TrainingPairRecord } from './training-pair-capture';

interface SceneRecordBody {
    schema: string;
    runId: string;
    path?: string;
    objects: Array<{ objectKey: string; version: number }>;
    layers?: Array<{ layer: string; stage: string; url: string; sha256?: string; provenance?: string }>;
}

interface StagedRunBody { runId: string; request?: { query?: string; isolate?: boolean }; place?: { lat: number; lng: number; formattedAddress?: string }; keys?: { tiles?: string } }

export interface BackfillReport {
    scenes: number;
    pairs: Array<Pick<TrainingPairRecord, 'id' | 'category' | 'runId' | 'outcome'> & { kind: string }>;
    skipped: Array<{ runId: string; reason: string }>;
}

function readJsonBlob(store: DurableAssetStore, servedPath: string | undefined): any {
    const hit = servedPath ? store.lookup(servedPath) : undefined;
    if (!hit) return undefined;
    try { return fs.readJsonSync(store.blobPath(hit.sha256)); } catch { return undefined; }
}

/** Records the pairs of every scene the store holds; returns what it recorded and what it could not. Uploads nothing. */
export function backfillTrainingPairs(store: DurableAssetStore): BackfillReport {
    const report: BackfillReport = { scenes: 0, pairs: [], skipped: [] };
    const runs = new Map<string, StagedRunBody>();
    for (const r of store.db.recipesOfKind('staged-location')) {
        const b = r.body as StagedRunBody;
        if (b?.runId) runs.set(b.runId, b);
    }
    for (const r of store.db.recipesOfKind('scene-record')) {
        const scene = r.body as SceneRecordBody;
        if (!scene?.runId || !Array.isArray(scene.objects)) continue;
        report.scenes++;
        const run = runs.get(scene.runId);
        if (!run?.place) { report.skipped.push({ runId: scene.runId, reason: 'no staged-run record with its place' }); continue; }
        // the summary row names its full record (with the layers) by path; read it when the row has no layers
        const full = scene.layers ? scene : (readJsonBlob(store, scene.path) as SceneRecordBody | undefined);
        const layers = full?.layers ?? [];
        const tiles = layers.find(l => l.stage === 'tiles');
        // without the full record, the run's own published tiles layer (recorded under the run's recipe, named by its tiles key)
        const tilesKey = run.keys?.tiles?.slice(0, 8);
        const runTiles = !tiles && tilesKey ? store.db.servedByRecipe(`staged:${scene.runId}`).find(r => r.path.endsWith(`_tiles_${tilesKey}.glb`)) : undefined;
        const scanSha = tiles ? (store.lookup(tiles.url)?.sha256 ?? tiles.sha256) : runTiles?.sha256;
        if (!scanSha || !fs.existsSync(store.blobPath(scanSha))) { report.skipped.push({ runId: scene.runId, reason: 'the scene\'s raw tiles layer is no longer in the store' }); continue; }
        const kept: StoreSceneReport['kept'] = [];
        for (const ref of scene.objects) {
            const v = store.db.objectVersion(ref.objectKey, ref.version);
            if (!v) continue;
            const row = v.catalogId ? store.db.object(v.catalogId) : undefined;
            const rec = readJsonBlob(store, v.recordPath);
            kept.push({
                objectKey: v.objectKey, version: v.version, kind: v.kind, identity: v.identity, layer: rec?.producer?.layer ?? '', glbPath: v.glbPath, sha256: v.glbSha256,
                ...(row ? { catalogType: row.type, wgs84: { lat: row.lat, lng: row.lng, altM: (row.bboxLoAlt + row.bboxHiAlt) / 2 } } : {}),
                provenanceLabels: Array.isArray(rec?.provenance?.labels) ? rec.provenance.labels : [], ...(rec?.inputs ? { inputs: rec.inputs } : {})
            });
        }
        const pairs = sceneTrainingPairs({
            runId: scene.runId, place: run.place.formattedAddress || run.request?.query || scene.runId, anchor: { lat: run.place.lat, lng: run.place.lng },
            isolate: !!run.request?.isolate, scanGlb: store.blobPath(scanSha), store,
            liveLayers: layers.filter(l => l.stage !== 'tiles').map(l => ({ layer: l.layer, url: l.url, provenanceLabels: l.provenance ? [l.provenance] : [] })),
            report: { kept, failed: [], ...(scene.path && store.lookup(scene.path) ? { scenePath: store.blobPath(store.lookup(scene.path)!.sha256) } : {}) }
        });
        for (const p of pairs) {
            const { missing: _m, ...rec } = recordTrainingPair(store, p);
            report.pairs.push({ id: rec.id, category: rec.category, runId: rec.runId, outcome: rec.outcome, kind: rec.subject.kind });
        }
    }
    return report;
}
