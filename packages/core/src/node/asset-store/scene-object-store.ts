/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Per-object versioned GLB assets (user decision: "we store the scene data after we are done with a scene"). When a
 * staged build finishes, every rebuilt object it can separate (a building from its Google vector footprint, a tree
 * grown to a measured crown, the procedural ground and streets) is kept as its own GLB in the durable asset store,
 * beside a `scratchbox.object/1` record, and the scene's own data is kept as a `scratchbox.scene/1` record listing
 * the object versions it used. A later build of the same place, or a reopened project, finds them here.
 *
 * Keys. An object is `<kind>/<identity>@<locationHash>`: `kind` an open label ('building', 'tree', 'ground', ...),
 * `identity` the producer's stable id (a Google vector feature id, an object catalog id), `locationHash` the build's
 * ENU frame (its coordinates are in that frame, so the same building in another frame is another object). Each
 * version carries the `inputHash` of everything that determined its geometry; one version per (object, inputHash).
 *
 * Versions are never rewritten: a changed input adds a version and moves the object's current pointer; storing an
 * input seen before points back at its version (no new one); old versions stay readable. Every GLB passes
 * checkGlbBytes before it is kept, and is stored under a path named by its input hash, so two processes storing the
 * same object race to the same bytes.
 *
 * Records are additive-only JSON: a reader ignores fields it does not know, a writer never removes or renames one.
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import type { ObjectVersionRow } from './asset-db';
import type { DurableAssetStore } from './durable-asset-store';
import { checkGlbBytes } from '../3d-engine/staged-location/glb-integrity';

export const OBJECT_RECORD_SCHEMA = 'scratchbox.object/1';
export const SCENE_RECORD_SCHEMA = 'scratchbox.scene/1';
/** Bumped when the way objects are cut or recorded changes what a stored GLB holds; part of every input hash. */
export const SCENE_OBJECT_STORE_VERSION = 'scene-object-store/1';
export const OBJECT_ORIGIN = 'scene-object-store';

export interface ObjectFrame {
    /** The ENU frame origin (the build's geoAnchor): WGS-84 degrees, ellipsoidal height in metres. */
    lat: number;
    lng: number;
    ellipsoidalHeightM?: number;
    /** Axis convention of the GLB coordinates. */
    axes?: string;
}

/** The frame's hash: the origin rounded to ~1 cm (1e-7 degrees) and 1 cm height. */
export function locationHashOf(frame: ObjectFrame): string {
    const r = (v: number, d: number) => (Number.isFinite(v) ? v.toFixed(d) : 'na');
    return crypto.createHash('sha256').update(`${r(frame.lat, 7)},${r(frame.lng, 7)},${r(frame.ellipsoidalHeightM ?? NaN, 2)}`).digest('hex').slice(0, 16);
}

export function objectKeyOf(kind: string, identity: string, locationHash: string): string {
    if (!kind || /[@\s]/.test(kind)) throw new Error(`scene object store: bad kind ${JSON.stringify(kind)}`);
    if (!identity) throw new Error('scene object store: empty identity');
    return `${kind}/${identity}@${locationHash}`;
}

/** sha256 over the JSON of the parts, in order, with the store's version first: an object's input hash. */
export function objectInputHash(...parts: unknown[]): string {
    const h = crypto.createHash('sha256').update(SCENE_OBJECT_STORE_VERSION);
    for (const p of parts) h.update('\0').update(typeof p === 'string' ? p : JSON.stringify(p) ?? 'undefined');
    return h.digest('hex');
}

export interface ObjectRecord {
    schema: typeof OBJECT_RECORD_SCHEMA;
    objectKey: string;
    kind: string;
    identity: string;
    location: {
        /** The object's centre (its bounding box's), WGS-84 degrees and ellipsoidal metres; absent when the producer had no geodetic origin. */
        wgs84?: { lat: number; lng: number; altM: number };
        /** Bounding box in the frame (metres). */
        bboxEnu: { min: [number, number, number]; max: [number, number, number] };
        frame: ObjectFrame & { locationHash: string };
    };
    provenance: { labels: string[]; confidence: number | null; note?: string; sources?: Array<{ kind: string; id: string }> };
    /** Materials the GLB carries; `surface` when one names a surface library entry (/models/surfaces/<id>). */
    materials: Array<{ name?: string; images: number; surface?: string }>;
    inputHash: string;
    /** What went into the input hash, readably (never image bytes). */
    inputs?: Record<string, unknown>;
    producer: { stage: string; stageKey?: string; layer?: string; version: string };
    catalogId?: string;
    runId?: string;
    workspace?: string;
    createdAtMs: number;
    glb: { path: string; sha256: string; bytes: number; triangles: number; vertices: number; nodes: number };
}

export interface PutObjectInput {
    kind: string;
    identity: string;
    frame: ObjectFrame;
    inputHash: string;
    /** The GLB, made only when no stored version has this input hash (a reused object is never cut again). */
    glb: () => Buffer;
    provenance: ObjectRecord['provenance'];
    producer: ObjectRecord['producer'];
    inputs?: Record<string, unknown>;
    /** Centre in WGS-84, when the caller can convert. */
    wgs84?: { lat: number; lng: number; altM: number };
    catalogId?: string;
    runId?: string;
    workspace?: string;
}

export interface PutObjectResult {
    objectKey: string;
    version: number;
    /** A stored version had this input hash: nothing was cut or written. */
    reused: boolean;
    /** The current pointer moved (a new version, or back to an older one). */
    pointerMoved: boolean;
    glbPath: string;
    recordPath: string;
    sha256: string;
    bytes: number;
}

export interface StoredObject {
    row: ObjectVersionRow;
    record: ObjectRecord;
    /** The GLB's blob in the store. */
    glbFile: string;
}

/** One path segment of a served path: safe characters only, never "." or "..". */
function segment(raw: string): string {
    const s = raw.replace(/[^A-Za-z0-9._-]/g, '_');
    return s === '' || s === '.' || s === '..' ? '_' : s;
}

/** The served directory of an object: kind, the identity's own segments (plus a short hash so two identities never share it), the frame. */
export function objectDirOf(kind: string, identity: string, locationHash: string): string {
    const parts = identity.split('/').map(segment);
    parts[parts.length - 1] = `${parts[parts.length - 1]}~${crypto.createHash('sha256').update(identity).digest('hex').slice(0, 8)}`;
    return `/models/objects/${segment(kind)}/${parts.join('/')}/${locationHash}`;
}

/** Surface library references anywhere in a material (strings naming /models/surfaces/<id>). */
function surfaceOf(material: unknown): string | undefined {
    let found: string | undefined;
    const walk = (o: unknown) => {
        if (found) return;
        if (typeof o === 'string') { const m = /\/models\/surfaces\/[A-Za-z0-9._\-/]+/.exec(o); if (m) found = m[0]; return; }
        if (o && typeof o === 'object') for (const v of Object.values(o)) walk(v);
    };
    walk(material);
    return found;
}

/** Bounding box (frame metres) of every POSITION in the GLB, node transforms applied only through min/max of translated accessors' corners. */
function glbFacts(glbBytes: Buffer): { json: any; bbox: { min: [number, number, number]; max: [number, number, number] } } { // eslint-disable-line @typescript-eslint/no-explicit-any
    const len = glbBytes.readUInt32LE(12);
    const json = JSON.parse(glbBytes.subarray(20, 20 + len).toString('utf8'));
    const min: [number, number, number] = [Infinity, Infinity, Infinity], max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
    const nodes: any[] = json.nodes ?? []; // eslint-disable-line @typescript-eslint/no-explicit-any
    const mul = (a: number[], b: number[]) => { const o = new Array(16).fill(0); for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) for (let k = 0; k < 4; k++) o[c * 4 + r] += a[k * 4 + r] * b[c * 4 + k]; return o; };
    const local = (n: any): number[] => { // eslint-disable-line @typescript-eslint/no-explicit-any
        if (Array.isArray(n.matrix)) return n.matrix;
        const t = n.translation ?? [0, 0, 0], q = n.rotation ?? [0, 0, 0, 1], s = n.scale ?? [1, 1, 1];
        const [x, y, z, w] = q;
        return [
            (1 - 2 * (y * y + z * z)) * s[0], 2 * (x * y + z * w) * s[0], 2 * (x * z - y * w) * s[0], 0,
            2 * (x * y - z * w) * s[1], (1 - 2 * (x * x + z * z)) * s[1], 2 * (y * z + x * w) * s[1], 0,
            2 * (x * z + y * w) * s[2], 2 * (y * z - x * w) * s[2], (1 - 2 * (x * x + y * y)) * s[2], 0,
            t[0], t[1], t[2], 1
        ];
    };
    const visit = (i: number, parent: number[]) => {
        const n = nodes[i];
        const world = mul(parent, local(n));
        if (n.mesh !== undefined) for (const p of json.meshes?.[n.mesh]?.primitives ?? []) {
            const a = json.accessors?.[p.attributes?.POSITION];
            if (!a?.min || !a?.max || a.normalized) continue;
            for (let corner = 0; corner < 8; corner++) {
                const c = [corner & 1 ? a.max[0] : a.min[0], corner & 2 ? a.max[1] : a.min[1], corner & 4 ? a.max[2] : a.min[2]];
                for (let k = 0; k < 3; k++) {
                    const v = world[k] * c[0] + world[4 + k] * c[1] + world[8 + k] * c[2] + world[12 + k];
                    if (v < min[k]) min[k] = v;
                    if (v > max[k]) max[k] = v;
                }
            }
        }
        for (const c of n.children ?? []) visit(c, world);
    };
    const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    for (const r of json.scenes?.[json.scene ?? 0]?.nodes ?? []) visit(r, identity);
    return { json, bbox: { min, max } };
}

export class SceneObjectStore {
    private readonly tmpDir: string;

    constructor(readonly store: DurableAssetStore) {
        this.tmpDir = path.join(store.home, 'tmp');
    }

    /** The stored version of `objectKey` with this input hash, when its GLB bytes are present. */
    find(objectKey: string, inputHash: string): ObjectVersionRow | undefined {
        const row = this.store.db.objectVersionByInput(objectKey, inputHash);
        return row && this.store.lookup(row.glbPath)?.sha256 === row.glbSha256 ? row : undefined;
    }

    current(objectKey: string): ObjectVersionRow | undefined {
        return this.store.db.currentObjectVersion(objectKey);
    }

    versions(objectKey: string): ObjectVersionRow[] {
        return this.store.db.objectVersions(objectKey);
    }

    /** A version (the current one when `version` is omitted): its row, parsed record and GLB blob. */
    read(objectKey: string, version?: number): StoredObject | undefined {
        const row = version === undefined ? this.current(objectKey) : this.store.db.objectVersion(objectKey, version);
        if (!row) return undefined;
        const glb = this.store.lookup(row.glbPath);
        const rec = this.store.lookup(row.recordPath);
        if (!glb || !rec || glb.sha256 !== row.glbSha256) return undefined;
        const record = JSON.parse(fs.readFileSync(rec.file, 'utf8')) as ObjectRecord;
        if (record.schema !== OBJECT_RECORD_SCHEMA) throw new Error(`scene object store: ${row.recordPath} is ${JSON.stringify(record.schema)}, not ${OBJECT_RECORD_SCHEMA}`);
        return { row, record, glbFile: glb.file };
    }

    /**
     * Stores an object's geometry for `inputHash`, or reuses the version that already has it (see the module doc).
     * Throws when the GLB fails the structural check: nothing malformed is ever kept.
     */
    put(input: PutObjectInput): PutObjectResult {
        const locationHash = locationHashOf(input.frame);
        const objectKey = objectKeyOf(input.kind, input.identity, locationHash);
        const reuse = this.find(objectKey, input.inputHash);
        if (reuse) {
            const moved = this.store.db.currentObjectVersion(objectKey)?.version !== reuse.version;
            if (moved) this.store.db.transaction(() => {
                this.store.db.setCurrentObjectVersion(objectKey, reuse.version);
                this.store.db.addEvent('object.current', objectKey, reuse.glbSha256, { version: reuse.version, inputHash: input.inputHash, reason: 'an earlier input again' });
            });
            const bytes = this.store.lookup(reuse.glbPath)?.bytes ?? 0;
            return { objectKey, version: reuse.version, reused: true, pointerMoved: moved, glbPath: reuse.glbPath, recordPath: reuse.recordPath, sha256: reuse.glbSha256, bytes };
        }
        const glb = input.glb();
        const check = checkGlbBytes(glb);
        if (!check.ok) throw new Error(`scene object store: ${objectKey} is not a valid GLB (${check.errors.slice(0, 3).join('; ')}${check.errors.length > 3 ? `; ${check.errors.length - 3} more` : ''})`);
        const dir = objectDirOf(input.kind, input.identity, locationHash);
        const stem = input.inputHash.slice(0, 16);
        const glbPath = `${dir}/${stem}.glb`, recordPath = `${dir}/${stem}.json`;
        const sha256 = crypto.createHash('sha256').update(glb).digest('hex');
        const facts = glbFacts(glb);
        const materials = ((facts.json.materials ?? []) as any[]).map(m => { // eslint-disable-line @typescript-eslint/no-explicit-any
            const surface = surfaceOf(m);
            const images = new Set<number>();
            const walk = (o: any) => { if (!o || typeof o !== 'object') return; for (const [k, v] of Object.entries(o)) { if (/Texture$/.test(k) && typeof (v as any)?.index === 'number') { const src = facts.json.textures?.[(v as any).index]?.source; if (typeof src === 'number') images.add(src); } else walk(v); } }; // eslint-disable-line @typescript-eslint/no-explicit-any
            walk(m);
            return { ...(m.name ? { name: String(m.name) } : {}), images: images.size, ...(surface ? { surface } : {}) };
        });
        const record: ObjectRecord = {
            schema: OBJECT_RECORD_SCHEMA, objectKey, kind: input.kind, identity: input.identity,
            location: {
                ...(input.wgs84 ? { wgs84: input.wgs84 } : {}),
                bboxEnu: facts.bbox,
                frame: { lat: input.frame.lat, lng: input.frame.lng, ...(input.frame.ellipsoidalHeightM !== undefined ? { ellipsoidalHeightM: input.frame.ellipsoidalHeightM } : {}), axes: input.frame.axes ?? 'x east, y up, z south (metres)', locationHash }
            },
            provenance: input.provenance, materials, inputHash: input.inputHash, ...(input.inputs ? { inputs: input.inputs } : {}),
            producer: input.producer, ...(input.catalogId ? { catalogId: input.catalogId } : {}), ...(input.runId ? { runId: input.runId } : {}), ...(input.workspace ? { workspace: input.workspace } : {}),
            createdAtMs: Date.now(),
            glb: { path: glbPath, sha256, bytes: glb.length, triangles: check.counts.triangles, vertices: check.counts.vertices, nodes: check.counts.nodes }
        };
        fs.mkdirSync(this.tmpDir, { recursive: true });
        const tag = `${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
        const tmpGlb = path.join(this.tmpDir, `${stem}-${tag}.glb`), tmpRec = path.join(this.tmpDir, `${stem}-${tag}.json`);
        try {
            fs.writeFileSync(tmpGlb, glb);
            fs.writeFileSync(tmpRec, JSON.stringify(record, null, 1));
            this.store.putFile(tmpGlb, { servedPath: glbPath, origin: OBJECT_ORIGIN, mime: 'model/gltf-binary', ...(input.workspace ? { workspace: input.workspace } : {}) });
            this.store.putFile(tmpRec, { servedPath: recordPath, origin: OBJECT_ORIGIN, mime: 'application/json', ...(input.workspace ? { workspace: input.workspace } : {}) });
        } finally {
            fs.rmSync(tmpGlb, { force: true });
            fs.rmSync(tmpRec, { force: true });
        }
        const out = this.store.db.transaction(() => {
            // the same input already has a version: another process stored it meanwhile, or its bytes were lost and are
            // put back now (same served path, named by the input hash); the version stands and its row follows the bytes
            const known = this.store.db.objectVersionByInput(objectKey, input.inputHash);
            let version: number;
            if (known) {
                version = known.version;
                if (known.glbSha256 !== sha256) {
                    this.store.db.repairObjectVersion(objectKey, version, sha256);
                    this.store.db.addEvent('object.repaired', objectKey, sha256, { version, previousSha256: known.glbSha256 });
                }
            } else {
                version = this.store.db.insertObjectVersion({
                    objectKey, kind: input.kind, identity: input.identity, locationHash, inputHash: input.inputHash, glbPath, glbSha256: sha256, recordPath,
                    catalogId: input.catalogId ?? null, runId: input.runId ?? null, workspace: input.workspace ?? null
                });
                this.store.db.addEvent('object.version', objectKey, sha256, { version, inputHash: input.inputHash, glbPath, bytes: glb.length, triangles: check.counts.triangles });
            }
            const moved = this.store.db.currentObjectVersion(objectKey)?.version !== version;
            if (moved) this.store.db.setCurrentObjectVersion(objectKey, version);
            return { version, moved, raced: !!known };
        });
        return { objectKey, version: out.version, reused: out.raced, pointerMoved: out.moved, glbPath, recordPath, sha256, bytes: glb.length };
    }

    /** Keeps a finished scene: its data and the object versions it used, under its own served path, with a recipe. */
    putScene(input: SceneRecordInput): { path: string; sha256: string; recipeId: string } {
        const locationHash = locationHashOf(input.frame);
        const servedPath = `/models/scenes/${locationHash}/${segment(input.runId)}.json`;
        const record: SceneRecord = {
            schema: SCENE_RECORD_SCHEMA, sceneId: input.sceneId, runId: input.runId, ...(input.query ? { query: input.query } : {}),
            frame: { ...input.frame, locationHash }, createdAtMs: Date.now(),
            objects: input.objects, layers: input.layers, scene: input.scene, ...(input.notes?.length ? { notes: input.notes } : {}), ...(input.workspace ? { workspace: input.workspace } : {})
        };
        const recipeId = `scene:${input.runId}`;
        this.store.putRecipe({
            id: recipeId, kind: 'scene-record', ...(input.workspace ? { workspace: input.workspace } : {}),
            body: { schema: SCENE_RECORD_SCHEMA, runId: input.runId, sceneId: input.sceneId, path: servedPath, locationHash, objects: input.objects.map(o => ({ objectKey: o.objectKey, version: o.version })) }
        });
        fs.mkdirSync(this.tmpDir, { recursive: true });
        const tmp = path.join(this.tmpDir, `scene-${process.pid}-${crypto.randomBytes(4).toString('hex')}.json`);
        try {
            fs.writeFileSync(tmp, JSON.stringify(record));
            const stored = this.store.putFile(tmp, { servedPath, origin: OBJECT_ORIGIN, recipeId, mime: 'application/json', ...(input.workspace ? { workspace: input.workspace } : {}) });
            return { path: servedPath, sha256: stored.sha256, recipeId };
        } finally {
            fs.rmSync(tmp, { force: true });
        }
    }

    readScene(servedPath: string): SceneRecord | undefined {
        const found = this.store.lookup(servedPath);
        if (!found) return undefined;
        const record = JSON.parse(fs.readFileSync(found.file, 'utf8')) as SceneRecord;
        if (record.schema !== SCENE_RECORD_SCHEMA) throw new Error(`scene object store: ${servedPath} is ${JSON.stringify(record.schema)}, not ${SCENE_RECORD_SCHEMA}`);
        return record;
    }

    /** The newest scene record kept for a frame (a reopened project of the same place), if any. */
    latestSceneAt(frame: ObjectFrame): SceneRecord | undefined {
        const locationHash = locationHashOf(frame);
        for (const r of this.store.db.recipesOfKind('scene-record')) {
            const body = r.body as { locationHash?: string; path?: string };
            if (body.locationHash !== locationHash || !body.path) continue;
            const rec = this.readScene(body.path);
            if (rec) return rec;
        }
        return undefined;
    }
}

export interface SceneObjectRef {
    objectKey: string;
    version: number;
    kind: string;
    /** The scene layer it was cut from. */
    layer?: string;
    glbPath: string;
    sha256: string;
    reused: boolean;
}

export interface SceneLayerRef {
    objectId: string;
    layer: string;
    stage: string;
    url: string;
    /** The blob the served path pointed at when the scene was kept, when the store has it. */
    sha256?: string;
    provenance: string;
    /** Objects cut from it (none: the layer is kept whole under its own served path). */
    objects: number;
}

export interface SceneRecordInput {
    sceneId: string;
    runId: string;
    query?: string;
    frame: ObjectFrame;
    objects: SceneObjectRef[];
    layers: SceneLayerRef[];
    /** The final scene (Scene3DData). */
    scene: unknown;
    notes?: string[];
    workspace?: string;
}

export interface SceneRecord {
    schema: typeof SCENE_RECORD_SCHEMA;
    sceneId: string;
    runId: string;
    query?: string;
    frame: ObjectFrame & { locationHash: string };
    createdAtMs: number;
    objects: SceneObjectRef[];
    layers: SceneLayerRef[];
    scene: unknown;
    notes?: string[];
    workspace?: string;
}
