/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The district and object training pairs of a finished staged build (training-pair-capture.ts), made from what the scene
 * object store kept (scene-objects.ts):
 * - object: every kept object that the object catalog knows as a real thing other than a building (a tree, a roof object,
 *   street furniture: the scan cut-outs the build replaced), paired with the raw extraction cropped to the object's box;
 * - district: a build that was not an isolate, the raw extraction paired with the scene's live layers and its scene
 *   record, linking the objects it holds.
 * Buildings are paired by the 3D Building capture (building-training-capture.ts). The raw extraction is stored once
 * (its blob is shared by every pair of the run, by sha256).
 */

import * as fs from 'fs-extra';
import type { DurableAssetStore } from '../../asset-store/durable-asset-store';
import { glbWorldBounds } from '../part-connectivity';
import type { TrainingCrop, TrainingPairCaptureInput } from '../../cloud-store/training-pair-capture';
import type { StoreSceneReport } from './scene-objects';

/** The catalog type a building carries: those pairs belong to the building category, not to objects. */
const BUILDING_CATALOG_TYPE = 'FEATURE_TYPE_BUILDING';
/** Margin around an object's box when the scan is cut to it (the scan's melted surface reaches past the clean object). */
export const OBJECT_CROP_MARGIN_M = 0.5;
export const SCENE_TRAINING_VERSION = 'scene-pairs/1';

export interface SceneTrainingInput {
    runId: string;
    place: string;
    anchor: { lat: number; lng: number };
    /** True for a 3D Building (isolate) run: only its objects are paired; the building has its own capture. */
    isolate: boolean;
    /** The raw photo-textured extraction (the "before"). */
    scanGlb: string;
    /** The scene's live (not retired, not superseded) layers by name, as served paths the store knows. */
    liveLayers: Array<{ layer: string; url: string; provenanceLabels: string[] }>;
    report: Pick<StoreSceneReport, 'kept' | 'scenePath' | 'failed'>;
    store: DurableAssetStore;
}

/** The box of a stored object's GLB, grown by the crop margin; undefined when it cannot be read. */
function objectCrop(store: DurableAssetStore, sha256: string, wgs84?: { lat: number; lng: number; altM: number }): TrainingCrop | undefined {
    try {
        const b = glbWorldBounds(fs.readFileSync(store.blobPath(sha256)));
        if (!b) return undefined;
        const m = OBJECT_CROP_MARGIN_M;
        return { role: 'input.scan_textured', min: [b.min[0] - m, b.min[1] - m, b.min[2] - m], max: [b.max[0] + m, b.max[1] + m, b.max[2] + m], ...(wgs84 ? { wgs84 } : {}) };
    } catch {
        return undefined;
    }
}

export function sceneTrainingPairs(input: SceneTrainingInput): TrainingPairCaptureInput[] {
    const base = { runId: input.runId, place: input.place, anchor: input.anchor };
    const pairs: TrainingPairCaptureInput[] = [];
    const objectIds: Array<{ category: string; id: string; role: string }> = [];
    for (const o of input.report.kept) {
        if (!o.catalogType || o.catalogType === BUILDING_CATALOG_TYPE) continue;
        const crop = objectCrop(input.store, o.sha256, o.wgs84);
        objectIds.push({ category: 'object', id: o.objectKey, role: o.kind });
        pairs.push({
            ...base, category: 'object', subject: { kind: o.kind, identity: o.identity }, outcome: 'delivered',
            source: 'pipeline-scene-objects', pipelineVersion: SCENE_TRAINING_VERSION,
            files: { 'input.scan_textured': input.scanGlb }, storedFiles: { 'target.object': { sha256: o.sha256 } },
            ...(crop ? { crops: [crop] } : {}),
            provenanceLabels: o.provenanceLabels,
            notes: { objectKey: o.objectKey, version: o.version, layer: o.layer, catalogType: o.catalogType, ...(o.centre ? { centre: o.centre } : {}), ...(o.inputs ? { inputs: o.inputs } : {}), ...(crop ? {} : { crop: 'the object box could not be read; the whole extraction is the input' }) }
        });
    }
    if (!input.isolate) {
        const storedFiles: Record<string, { sha256: string }> = {};
        const labels: string[] = [];
        for (const l of input.liveLayers) {
            const sha = input.store.lookup(l.url)?.sha256;
            if (!sha) continue;
            storedFiles[`target.layer_${l.layer}`] = { sha256: sha };
            labels.push(...l.provenanceLabels);
        }
        const buildings = input.report.kept.filter(o => o.catalogType === BUILDING_CATALOG_TYPE).map(o => ({ category: 'building', id: o.objectKey, role: 'building' }));
        const delivered = Object.keys(storedFiles).length > 0;
        pairs.push({
            ...base, category: 'district', subject: { kind: 'district' }, outcome: delivered ? 'delivered' : 'failed',
            ...(delivered ? {} : { reason: 'none of the scene\'s live layers was in the asset store' }),
            source: 'pipeline-e', pipelineVersion: SCENE_TRAINING_VERSION,
            files: { 'input.scan_textured': input.scanGlb, ...(input.report.scenePath ? { 'target.scene_record': input.report.scenePath } : {}) },
            storedFiles, links: [...buildings, ...objectIds], provenanceLabels: labels,
            notes: { layers: input.liveLayers.map(l => l.layer), objects: objectIds.length, buildings: buildings.length, ...(input.report.failed.length ? { objectStoreFailures: input.report.failed.length } : {}) }
        });
    }
    return pairs;
}
