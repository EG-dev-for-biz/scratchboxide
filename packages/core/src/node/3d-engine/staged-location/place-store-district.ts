/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * A district (pipeline K-D) and the place store (place-store.ts; on by default, SCRATCHBOX_PLACE_STORE=0 off):
 *
 *  0. **Before the build** (pullPlaceForRun, as the place resolves): the place's store read without its lease, its
 *     objects' current versions into this machine's object store and its readings into the reading store (none of the
 *     objects with SCRATCHBOX_OBJECT_REUSE=0, none of the readings with SCRATCHBOX_CACHE_RESTORE=off); the report is the
 *     run note `place_pull`.
 *  1. **At the join** (a chunked district) (auditDistrictForPlace, once the chunks' seams are closed): the joined district is audited
 *     (district-completeness-audit.ts) and each surface layer it draws (the chunks' K twins, the centre's own) gets a
 *     layer-objects manifest (scene-objects.ts) in the run's manifests: one `building/<Google vector feature id>` per
 *     building, its triangles cut by its footprint, from the layer holding most of it (`<id>/<layer>` for the rest of
 *     it elsewhere); one `scan-component/<where>` per separate piece standing in no footprint; one
 *     `ground/chunk-<i>/<layer>` for the rest of each layer. Each object carries the audit's measures and failures, so
 *     the object store makes its new version current only when no measure is worse. The district's own facts (anchor,
 *     radius, grown edge, chunk grid, code, switches, the audit's summary with its trees) go in the run note
 *     `place_audit`. The joined layers have no stage-cache entry, so no objects.json is written beside them: their
 *     manifests live in the run.
 *  2. **After the objects are kept** (syncPlaceAfterObjects, from the scene object store's pass at the build's end): the
 *     run's objects are copied to the place store (place-store.ts) under its lease, with the readings the run and its
 *     chunks used or wrote (their `model_readings` notes); the report is the run note `place_store`.
 *
 * The objects are kept only while the scene object store is on (scene-objects.ts objectStoreEnabled; SCRATCHBOX_OBJECT_STORE);
 * with it off the audit still runs and its note says so. Neither step ever fails the build (a stopped build's stop passes through).
 */

import * as fs from 'fs';
import * as path from 'path';
import type { StagedLayer } from '../../../common/spatial/staged-location-contracts';
import type { DurableAssetStore } from '../../asset-store/durable-asset-store';
import { objectInputHash, SceneObjectStore, type ObjectMeasures } from '../../asset-store/scene-object-store';
import type { CloudBucket } from '../../cloud-store/cloud-bucket';
import { auditDistrict, DISTRICT_AUDIT_VERSION, type AuditLayer, type DistrictAudit, type SurfaceAudit } from './district-completeness-audit';
import { districtFootprints, type DistrictFootprint } from './pipeline-k/district-buildings';
import { chunkOwner, type DistrictChunkPlan } from './pipeline-k/district-chunks';
import { DISTRICT_SEAMS_VERSION } from './pipeline-k/district-seams';
import { MODEL_READINGS_DIR, readingFileOf, type ModelReadingReport } from './pipeline-k/model-readings';
import {
    openPlaceStore, placeCodeVersion, placeKey, PLACE_STORE_SCHEMA, pullPlace, syncPlaceObjects,
    type PlaceChunkGrid, type PlaceCodeVersion, type PlaceManifest, type PlacePullReport, type PlaceSyncReport
} from './place-store';
import { LAYER_OBJECTS_SCHEMA, objectReuseEnabled, objectStoreEnabled, type LayerObject, type LayerObjectManifest } from './scene-objects';
import { sha256File } from './stage-cache';
import type { VectorEvidence } from './vector-footprints';
import { selectPaintBuildings } from './vector-first-paint';

export { placeStoreEnabled } from './place-store';

export const PLACE_AUDIT_SCHEMA = 'scratchbox.place-audit/1';

/** How far past the district's radius neighbours' footprints are read (m): as far as an extraction may grow to keep a building whole (orchestrator.ts DISTRICT_CONTAINMENT_MAX_GROWTH_M). */
const NEIGHBOUR_REACH_M = 100;

/** Environment switches that never go into a record: anything that may hold a secret. */
const SECRET_NAME = /KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTH/i;

/** The district's facts and the audit's summary, kept as the run note `place_audit` for the sync after the objects are kept. */
export interface PlaceAuditNote {
    schema: typeof PLACE_AUDIT_SCHEMA;
    key: string;
    anchor: NonNullable<PlaceManifest['anchor']>;
    radiusM: number;
    edge: NonNullable<PlaceManifest['edge']>;
    chunks: PlaceChunkGrid;
    codeVersion: PlaceCodeVersion;
    switches: Record<string, string>;
    audit?: {
        version: string; ms: number; buildings: number; neighbours: number | string;
        /** The buildings failing a check, with the checks. */
        failing: Array<{ id: string; checks: string[] }>;
        trees: DistrictAudit['trees'];
        layers: DistrictAudit['layers'];
    };
    /** The layers given a manifest, and how many objects each lists. */
    manifests: Array<{ layer: string; objectId: string; objects: number; file: string }>;
    /** Whether the objects will be kept (SCRATCHBOX_OBJECT_STORE). */
    objectsKept: boolean;
    notes: string[];
    error?: string;
    ms: number;
}

export interface DistrictAuditInput {
    runId: string;
    place: { lat: number; lng: number; formattedAddress?: string };
    /** The district frame's ellipsoidal height at the anchor (the tiles' origin). */
    originEllipsoidalHeightM?: number;
    plan: DistrictChunkPlan;
    /** The run's layers as committed (retired and superseded ones are left out here). */
    layers: StagedLayer[];
    /** The run's layer-objects manifests (StagedRun.objectManifests), which the joined layers' manifests are added to. */
    manifests: Map<string, LayerObjectManifest>;
    modelsDir: string;
    workspaceRoot: string;
    /** The request's own switches (pipeline, district, model service, ...): string, number and boolean fields are kept. */
    request: object;
    vectorEvidence?: (req: { lat: number; lng: number; radiusM: number }) => Promise<VectorEvidence>;
    signal?: AbortSignal;
    progress?: (message: string) => void;
    env?: NodeJS.ProcessEnv;
}

/** The measures of an object from its audit: each with the way that is better and the change within which it is noise. */
export function auditMeasures(s: SurfaceAudit): ObjectMeasures {
    const lower = (value: number, tol = 0) => ({ value, better: 'lower' as const, tol });
    return {
        // a version that loses part of the surface is worse, whatever else it improves
        areaM2: { value: s.areaM2, better: 'higher', tol: s.areaM2 * 0.05 },
        ...(s.edge ? { straddlesEdge: lower(s.edge.state === 'straddles' ? 1 : 0) } : {}),
        ...(s.kind !== 'ground' ? { cutAtEdgeM: lower(s.cutAtEdgeM, 0.1) } : {}),
        openEdgeM: lower(s.openEdgeM, Math.max(0.5, s.openEdgeM * 0.02)),
        nonManifoldEdges: lower(s.nonManifoldEdges, Math.max(2, s.nonManifoldEdges * 0.02)),
        holes: lower(s.holes),
        holePerimeterM: lower(s.holePerimeterM, 0.5),
        blackShare: lower(s.blackShare, 0.001),
        untexturedShare: lower(s.untexturedShare, 0.002),
        overlapAreaM2: lower(s.overlapAreaM2, 0.1),
        floatingPieces: lower(s.floatingPieces),
        floatingAreaM2: lower(s.floatingAreaM2, 0.05),
        auditFailures: lower(s.failures.length)
    };
}

/** The switches that built the run: the request's own fields and every SCRATCHBOX_ setting that cannot hold a secret. */
export function buildSwitches(request: object, env: NodeJS.ProcessEnv = process.env): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(request)) if (k !== 'query' && (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean')) out[`request.${k}`] = String(v);
    for (const [k, v] of Object.entries(env)) if (k.startsWith('SCRATCHBOX_') && v !== undefined && !SECRET_NAME.test(k)) out[k] = v;
    return out;
}

/**
 * Step 1 (see the module doc): the joined district audited, and its surface layers' objects listed in `manifests`.
 * Returns the run note `place_audit`. Throws only when the build is stopped.
 */
export async function auditDistrictForPlace(input: DistrictAuditInput): Promise<PlaceAuditNote> {
    const t0 = Date.now();
    const env = input.env ?? process.env;
    const plan = input.plan;
    const planned = new Map<string, DistrictFootprint>(plan.footprints.map(f => [f.id, { id: f.id, loops: f.loops }]));
    const note: PlaceAuditNote = {
        schema: PLACE_AUDIT_SCHEMA, key: placeKey(input.place),
        anchor: { lat: input.place.lat, lng: input.place.lng, ...(input.originEllipsoidalHeightM !== undefined ? { originEllipsoidalHeightM: input.originEllipsoidalHeightM } : {}), ...(input.place.formattedAddress ? { address: input.place.formattedAddress } : {}) },
        radiusM: plan.radiusM, edge: { radiusM: plan.radiusM, grownBy: [...planned.keys()] },
        chunks: { version: plan.version, cellM: plan.cellM, cells: plan.chunks.map(c => ({ index: c.index, cx: c.cx, cz: c.cz, half: c.half, rect: c.rect, centre: c.centre, buildings: c.buildings })) },
        codeVersion: placeCodeVersion(input.workspaceRoot, { 'district-chunks': plan.version, 'district-seams': DISTRICT_SEAMS_VERSION, audit: DISTRICT_AUDIT_VERSION, store: PLACE_STORE_SCHEMA }, env),
        switches: buildSwitches(input.request, env), manifests: [], objectsKept: objectStoreEnabled(env), notes: [], ms: 0
    };
    const done = () => ({ ...note, ms: Date.now() - t0 });
    if (!note.objectsKept) note.notes.push('the objects are not kept: SCRATCHBOX_OBJECT_STORE is off, so the place store has no versions to keep (the audit still runs)');
    try {
        // the layers as drawn: neither retired nor hidden by another, each its textured twin where it has one
        const shown = input.layers.filter(l => !l.retired);
        const hidden = new Set(shown.flatMap(l => l.supersedes));
        const fileOf = (url: string) => path.join(input.modelsDir, path.basename(url));
        const drawnFile = new Map<string, string>();
        const byId = new Map<string, StagedLayer>();
        const layers: AuditLayer[] = [];
        for (const l of shown) {
            if (hidden.has(l.objectId)) continue;
            const textured = l.textured ? fileOf(l.textured.url) : undefined;
            const drawn = textured && fs.existsSync(textured) ? textured : fileOf(l.url);
            if (!fs.existsSync(drawn)) continue;
            drawnFile.set(l.objectId, drawn);
            byId.set(l.objectId, l);
            // the trees stage's pieces are kept whole by the chunks' join (district-chunks.ts joinChunkGlb), so they are audited as trees
            layers.push({ id: l.objectId, read: () => fs.readFileSync(drawn), label: l.provenance.label, wholePieces: l.stage === 'trees' });
        }
        // the neighbours' footprints: a building past the radius that reaches into it is one the edge cuts
        let neighbours: number | string = 'no vector data';
        const buildings: DistrictFootprint[] = [...planned.values()];
        if (input.vectorEvidence) {
            try {
                const reach = plan.radiusM + NEIGHBOUR_REACH_M;
                const ev = await input.vectorEvidence({ lat: input.place.lat, lng: input.place.lng, radiusM: reach });
                const extra = districtFootprints(selectPaintBuildings(ev, reach).buildings).filter(f => !planned.has(f.id));
                buildings.push(...extra);
                neighbours = extra.length;
            } catch (err) {
                if (input.signal?.aborted) throw err;
                neighbours = `the neighbours' footprints could not be read (${errorMessage(err)})`;
            }
        }
        const audit = await auditDistrict({
            layers, buildings, edge: { radiusM: plan.radiusM, grownBy: [...planned.values()] }, cuts: note.objectsKept,
            ...(input.signal ? { signal: input.signal } : {}), ...(input.progress ? { progress: input.progress } : {})
        });
        const inDistrict = (s: SurfaceAudit) => s.kind !== 'building' || planned.has(s.id) || s.triangles > 0;
        const surfaceOf = new Map(audit.surfaces.map(s => [s.id, s]));
        note.audit = {
            version: audit.version, ms: audit.ms, buildings: audit.surfaces.filter(s => s.kind === 'building' && inDistrict(s)).length, neighbours,
            failing: audit.surfaces.filter(s => s.kind === 'building' && inDistrict(s) && s.failures.length).map(s => ({ id: s.id, checks: s.failures.map(f => f.check) })),
            trees: audit.trees, layers: audit.layers
        };
        if (note.objectsKept && audit.cuts) addManifests(input, note, audit, byId, drawnFile, surfaceOf, inDistrict);
        return done();
    } catch (err) {
        if (input.signal?.aborted) throw err;
        note.error = errorMessage(err);
        return done();
    }
}

/** Each surface layer's objects, as the scene object store cuts and keeps them (scene-objects.ts), with the audit's measures. */
function addManifests(input: DistrictAuditInput, note: PlaceAuditNote, audit: DistrictAudit, byId: Map<string, StagedLayer>, drawnFile: Map<string, string>,
    surfaceOf: Map<string, SurfaceAudit>, inDistrict: (s: SurfaceAudit) => boolean): void {
    const chunkAt = chunkOwner(input.plan);
    // the layer holding most of each owner carries its id and its measures; the rest of it elsewhere is a part
    const main = new Map<string, { layer: string; area: number }>();
    for (const [layer, owners] of Object.entries(audit.cuts!)) for (const o of owners) if (!main.has(o.id) || main.get(o.id)!.area < o.areaM2) main.set(o.id, { layer, area: o.areaM2 });
    const partsSeen = new Map<string, number>();
    for (const [layerId, owners] of Object.entries(audit.cuts!)) {
        const layer = byId.get(layerId), file = drawnFile.get(layerId);
        if (!layer || !file || !owners.length) continue;
        // a manifest a producer already wrote for this layer stands
        if (input.manifests.has(layerId)) { note.notes.push(`${layerId}: already listed by its producer`); continue; }
        const glbSha256 = sha256File(file);
        const objects: LayerObject[] = [];
        for (const o of owners) {
            const s = surfaceOf.get(o.id);
            if (!s || !inDistrict(s)) continue;
            const isMain = main.get(o.id)?.layer === layerId;
            let kind: string, identity: string;
            if (o.kind === 'ground') {
                const c = chunkAt(o.centre[0], o.centre[2]);
                kind = 'ground'; identity = `chunk-${c >= 0 ? c : 'outside'}/${layer.layer}`;
            } else {
                kind = o.kind; identity = o.id;
                if (!isMain) {
                    const base = `${o.id}/${layer.layer}`, n = (partsSeen.get(base) ?? 0) + 1;
                    partsSeen.set(base, n);
                    identity = n > 1 ? `${base}-${n}` : base;
                }
            }
            objects.push({
                kind, identity, inputHash: objectInputHash('kd-object', DISTRICT_AUDIT_VERSION, glbSha256, kind, identity),
                inputs: { layer: layer.layer, layerSha256: glbSha256, areaM2: o.areaM2 }, cuts: o.cuts,
                provenance: { labels: [String(layer.provenance.label)], confidence: null, note: `pipeline K-D: cut from the joined ${layer.layer} layer ${kind === 'building' ? 'by its Google vector footprint' : kind === 'ground' ? 'where no footprint or separate piece stands' : 'as a separate piece in no footprint'}` },
                centre: o.centre, ...(kind === 'building' ? { catalogType: 'FEATURE_TYPE_BUILDING' } : {}),
                // the measures are the whole owner's (a ground's is its layer's): they ride on its main part only
                ...(isMain ? {
                    measures: auditMeasures(s),
                    defects: s.failures.map(f => ({ kind: f.check, detail: f.detail, source: DISTRICT_AUDIT_VERSION, at: o.centre })),
                    audit: s
                } : {})
            });
        }
        if (!objects.length) continue;
        input.manifests.set(layerId, {
            schema: LAYER_OBJECTS_SCHEMA, sourceFile: file, glbSha256, producer: { stage: layer.stage, layer: layer.layer, version: `${DISTRICT_AUDIT_VERSION} (pipeline K-D join)` }, objects,
            notes: [`${objects.filter(o => o.kind === 'building').length} buildings, ${objects.filter(o => o.kind === 'scan-component').length} scan components and ${objects.filter(o => o.kind === 'ground').length} ground from the joined district`]
        });
        note.manifests.push({ layer: layer.layer, objectId: layerId, objects: objects.length, file });
    }
}

/** Where the place store is (tests): a bucket (null: none), the fallback root and a scratch directory. */
export interface PlaceStoreOptions { bucket?: CloudBucket | null; fallbackRoot?: string; tmpDir?: string }

/**
 * Step 0 (see the module doc): the place's store read before a district run builds. `store` is the object store's asset
 * store (none, no objects); `readingsDir` the run's reading store. Never throws.
 */
export async function pullPlaceForRun(input: {
    place: { lat: number; lng: number };
    store?: DurableAssetStore;
    readingsDir?: string;
    workspace?: string;
    placeStore?: PlaceStoreOptions;
    env?: NodeJS.ProcessEnv;
}): Promise<PlacePullReport> {
    const env = input.env ?? process.env, key = placeKey(input.place);
    const store = await openPlaceStore({ key, ...(input.placeStore ?? {}), env });
    const objectsOff = !objectStoreEnabled(env) ? 'the scene object store is off (SCRATCHBOX_OBJECT_STORE=0)'
        : !objectReuseEnabled(env) ? 'SCRATCHBOX_OBJECT_REUSE=0: no stored object is taken' : !input.store ? 'this machine has no object store' : undefined;
    return pullPlace(store, {
        ...(input.store && !objectsOff ? { objects: new SceneObjectStore(input.store) } : {}), ...(objectsOff ? { objectsOff } : {}),
        ...(input.readingsDir ? { readingsDir: input.readingsDir } : {}),
        ...(env.SCRATCHBOX_CACHE_RESTORE?.trim() === 'off' ? { readingsOff: 'SCRATCHBOX_CACHE_RESTORE=off: nothing is read back' } : {}),
        ...(input.workspace ? { workspace: input.workspace } : {})
    });
}

/** The keys the run and its chunks' reading stores used and wrote (their `model_readings` notes; a chunk is named in `district_chunks_joined`). */
function runReadings(cache: { readRunNote<T>(runId: string, name: string): T | undefined }, runId: string): { used: string[]; written: string[] } {
    const read = <T>(id: string, name: string): T | undefined => { try { return cache.readRunNote<T>(id, name); } catch { return undefined; } };
    const chunks = read<{ chunks?: Array<{ runId?: string }> }>(runId, 'district_chunks_joined')?.chunks ?? [];
    const used = new Set<string>(), written = new Set<string>();
    for (const id of [runId, ...chunks.map(c => c.runId).filter((x): x is string => !!x)]) {
        const n = read<Partial<ModelReadingReport>>(id, 'model_readings');
        for (const k of n?.used ?? []) used.add(k);
        for (const k of n?.writtenKeys ?? []) written.add(k);
    }
    return { used: [...used], written: [...written] };
}

/**
 * Step 2 (see the module doc): the run's kept objects copied to the place store. Undefined when the run left no
 * `place_audit` note (not a chunked district, or the place store was off). Never throws.
 */
export async function syncPlaceAfterObjects(input: {
    runId: string;
    cache: { readRunNote<T>(runId: string, name: string): T | undefined; workspaceRoot: string; dir?: string; restoreFile?(rel: string): Promise<boolean> };
    store: DurableAssetStore;
    kept: Array<{ objectKey: string }>;
    placeStore?: PlaceStoreOptions;
    env?: NodeJS.ProcessEnv;
}): Promise<PlaceSyncReport | undefined> {
    let note: PlaceAuditNote | undefined;
    try { note = input.cache.readRunNote<PlaceAuditNote>(input.runId, 'place_audit'); } catch { note = undefined; }
    if (note?.schema !== PLACE_AUDIT_SCHEMA) return undefined;
    try {
        const store = await openPlaceStore({ key: note.key, ...(input.placeStore ?? {}), ...(input.env ? { env: input.env } : {}) });
        const cache = input.cache, readings = cache.dir ? { dir: path.join(cache.dir, MODEL_READINGS_DIR), ...runReadings(cache, input.runId) } : undefined;
        return await syncPlaceObjects(store, {
            ...(readings && (readings.used.length || readings.written.length) ? { readings: { ...readings, ...(cache.restoreFile ? { restore: (k: string) => cache.restoreFile!(`${MODEL_READINGS_DIR}/${readingFileOf(k)}`) } : {}) } } : {}),
            runId: input.runId, objects: new SceneObjectStore(input.store), objectKeys: input.kept.map(k => k.objectKey),
            anchor: note.anchor, radiusM: note.radiusM, edge: note.edge, chunks: note.chunks, codeVersion: note.codeVersion, switches: note.switches,
            ...(note.audit ? { audit: note.audit } : {}), workspaceRoot: input.cache.workspaceRoot
        });
    } catch (err) {
        const reason = errorMessage(err);
        return { where: { kind: 'none', label: '', reason }, key: note.key, skipped: reason, objects: { added: 0, promoted: 0, rejected: 0, unchanged: 0 }, decisions: [], blobs: { stored: 0, existing: 0, bytes: 0, missing: [] }, readings: { stored: 0, existing: 0, missing: 0 }, errors: [reason], ms: 0 };
    }
}

function errorMessage(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}
