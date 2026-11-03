/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Which objects a staged layer holds, and keeping them when the build finishes (asset-store/scene-object-store.ts).
 *
 * A layer's producer says what is in it with a manifest (`scratchbox.layer-objects/1`), written beside the layer GLB
 * it describes (node indices are that file's, its sha256 is in the manifest):
 *   - the district massing (district-massing.ts): one `building/<Google vector feature id>` per rebuilt building, its
 *     own nodes (walls, roofs, bases and modelled volumes, found by the building id their names carry) plus the
 *     triangles of the scanned residual standing on its footprint (cut per triangle by the footprint cell its centroid
 *     falls in); residual on no footprint is `scan-residual/unattributed`;
 *   - the SB-Veggie trees: one `tree/<object catalog id>` per grown crown (the catalog's own 3 m proximity match makes
 *     the id stable across builds; a crown id is an index into one strip result and is renumbered when the scan
 *     changes: of 404 crowns in one Federation Square strip, none kept its id's stem in the next);
 *   - the procedural ground and streets: the whole layer as one object (`ground/surface`, `road/network`): their
 *     meshes join every street and every patch of ground, so nothing smaller is separable.
 *
 * Each object's input hash covers what determined its geometry. For a building that is its own vector entry, its
 * massing spec (the parts and modelled volumes the native tool extrudes), its ground level and a digest of the scan
 * triangles over its footprint, so a building whose own inputs are unchanged keeps its hash when a neighbour or the
 * extraction radius changes, and the massing stage can reuse its stored GLB instead of massing it again.
 */

import * as fs from 'fs';
import * as path from 'path';
import { parseGlbBytes, readAccessor, type ParsedGlb } from './glb-bytes';
import { composeGlb, mergeGlbs, type ComposeSelection } from './glb-subset';
import { checkGlbBytes } from './glb-integrity';
import { DecodedImageCache, repackTextures } from './glb-texture-repack';
import { footprintCellsByBuilding, type DistrictBuildingMassing } from './district-massing';
import type { EvidenceLookup, VectorBuilding } from './vector-footprints';
import { scanToGeodetic, type ScanMesh } from '../../spatial/StreetViewSurveyPlanner';
import { sha256File } from './stage-cache';
import type { DurableAssetStore } from '../../asset-store/durable-asset-store';
import { locationHashOf, objectInputHash, objectKeyOf, SceneObjectStore, type ObjectFrame, type PutObjectResult, type SceneLayerRef, type SceneObjectRef } from '../../asset-store/scene-object-store';
import { recordDiscoveredObjectIn } from '../../asset-store/object-catalog';
import type { StagedLayer } from '../../../common/spatial/staged-location-contracts';

/* eslint-disable @typescript-eslint/no-explicit-any -- glTF JSON is untyped */

export const LAYER_OBJECTS_SCHEMA = 'scratchbox.layer-objects/1';
/** The objects.json written beside a layer GLB. */
export const LAYER_OBJECTS_FILE = 'objects.json';

/**
 * The scene object store is on by default (user decision 2026-11-03, "Yes, turn it on": districts are built on from run to
 * run; it supersedes 2026-10-22's "every build seen new"). A build takes a stored object instead of generating it when its
 * inputs are unchanged; SCRATCHBOX_OBJECT_REUSE=0 generates every object again (each is still stored).
 */
export function objectReuseEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
    return env.SCRATCHBOX_OBJECT_REUSE !== '0';
}

/** Finished builds keep per-object versions (the layers are in the asset store either way); SCRATCHBOX_OBJECT_STORE=0 keeps none. On by default, as above. */
export function objectStoreEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
    return env.SCRATCHBOX_OBJECT_STORE !== '0';
}

export interface LayerObject {
    /** Open label. */
    kind: string;
    /** The producer's stable id; empty for a tree, whose id is the object catalog's (resolved when stored). */
    identity: string;
    inputHash: string;
    /** What went into the hash, readably. */
    inputs?: Record<string, unknown>;
    /** Whole node subtrees (indices in the layer GLB). */
    nodes?: number[];
    /** Triangle subsets of nodes. */
    cuts?: Array<{ node: number; triangles: number[] }>;
    /** The layer GLB as it is. */
    whole?: boolean;
    provenance: { labels: string[]; confidence: number | null; note?: string };
    /** Centre in the frame (metres), for its WGS-84 position and the catalog link. */
    centre?: [number, number, number];
    /** The object catalog type to link it to (an SB_FEATURE_TYPE_* / FEATURE_TYPE_* code). */
    catalogType?: string;
}

export interface LayerObjectManifest {
    schema: typeof LAYER_OBJECTS_SCHEMA;
    /**
     * In memory only (never written): the file the manifest was made for (a stage cache entry's own GLB), tried when
     * the published copy is not where the store looks first.
     */
    sourceFile?: string;
    /** sha256 of the GLB this manifest's node indices refer to. */
    glbSha256: string;
    producer: { stage: string; stageKey?: string; layer?: string; version: string };
    objects: LayerObject[];
    notes: string[];
}

/** Writes the manifests of a stage entry's layer files (keyed by the file's name in `dir`) to `dir`/objects.json. */
export function writeLayerManifests(dir: string, manifests: Record<string, LayerObjectManifest>): string {
    const file = path.join(dir, LAYER_OBJECTS_FILE);
    fs.writeFileSync(file, JSON.stringify(Object.fromEntries(Object.entries(manifests).map(([k, { sourceFile, ...m }]) => (void sourceFile, [k, m])))));
    return file;
}

/** The manifests of a stage entry's layer files, by file name; empty when none were written. */
export function readLayerManifests(dir: string): Record<string, LayerObjectManifest> {
    const file = path.join(dir, LAYER_OBJECTS_FILE);
    if (!fs.existsSync(file)) return {};
    try {
        const all = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, LayerObjectManifest>;
        return Object.fromEntries(Object.entries(all).filter(([, m]) => m?.schema === LAYER_OBJECTS_SCHEMA).map(([k, m]) => [k, { ...m, sourceFile: path.join(dir, k) }]));
    } catch {
        return {};
    }
}

/** The ENU frame a staged build's coordinates are in. */
export function objectFrameOf(extraction: { geoAnchor: { lat: number; lng: number }; originEllipsoidalHeightM: number }): ObjectFrame {
    return { lat: extraction.geoAnchor.lat, lng: extraction.geoAnchor.lng, ellipsoidalHeightM: extraction.originEllipsoidalHeightM, axes: 'x east, y up, z south (metres)' };
}

// ----------------------------------------------------------------------------------------------------------------
// the district massing's buildings
// ----------------------------------------------------------------------------------------------------------------

/** Which rebuilt building (index into `rows`) owns each 1 m plan cell: its footprint grown by `marginM`, never into another footprint. */
export interface FootprintOwners {
    at(x: number, z: number): number;
    cells: number;
}

export function footprintOwners(rows: DistrictBuildingMassing[], look: EvidenceLookup, within: (x: number, z: number) => boolean, marginM = 2): FootprintOwners {
    const fps = footprintCellsByBuilding(look, within);
    const owner = new Map<number, number>();
    const OFF = 1 << 15, key = (x: number, z: number) => (x + OFF) * (1 << 16) + (z + OFF);
    const R = Math.ceil(marginM);
    rows.forEach((r, ri) => {
        for (const [x, z] of fps.get(r.index)?.cells ?? []) for (let dz = -R; dz <= R; dz++) for (let dx = -R; dx <= R; dx++) {
            if (dx * dx + dz * dz > marginM * marginM + 0.5) continue;
            const b = look.buildingAt(x + dx + 0.5, z + dz + 0.5);
            if (b > 0 && b - 1 !== r.index) continue;
            const k = key(x + dx, z + dz);
            // a cell of the building's own footprint is its own; a margin cell goes to the first building reaching it
            if (!owner.has(k) || b - 1 === r.index) owner.set(k, ri);
        }
    });
    return { at: (x, z) => owner.get(key(Math.floor(x), Math.floor(z))) ?? -1, cells: owner.size };
}

/** 32-bit FNV-1a over a run of uint32 words. */
function fnv(words: Uint32Array, start: number, n: number, basis: number): number {
    let h = basis >>> 0;
    for (let i = start; i < start + n; i++) {
        const w = words[i];
        h = Math.imul(h ^ (w & 0xff), 16777619); h = Math.imul(h ^ ((w >>> 8) & 0xff), 16777619);
        h = Math.imul(h ^ ((w >>> 16) & 0xff), 16777619); h = Math.imul(h ^ (w >>> 24), 16777619);
    }
    return h >>> 0;
}

/**
 * A digest of the scan triangles over each building's owned cells (the region the native tool reads for its walls and
 * texture): every triangle's three vertices bit for bit and its texel size, combined order-free (two 32-bit FNV sums and
 * an xor of their product), so the same leaves in another download order give the same digest. The photo's pixels are
 * not read: the same leaf geometry comes with the same leaf photo.
 */
export function buildingScanDigests(scan: ScanMesh, owners: FootprintOwners, count: number): Array<{ triangles: number; digest: string }> {
    const V = scan.mesh.vertices as Float32Array, I = scan.mesh.indices as Uint32Array;
    const words = new Uint32Array(V.buffer, V.byteOffset, V.length);
    const tri = new Uint32Array(10);
    const triF = new Float32Array(tri.buffer);
    const n = new Array(count).fill(0), a = new Uint32Array(count), b = new Uint32Array(count), c = new Uint32Array(count);
    for (let t = 0; t < scan.triCount; t++) {
        const o = owners.at(scan.triCentroid[t * 3], scan.triCentroid[t * 3 + 2]);
        if (o < 0) continue;
        for (let k = 0; k < 3; k++) { const v = I[t * 3 + k] * 3; tri[k * 3] = words[v]; tri[k * 3 + 1] = words[v + 1]; tri[k * 3 + 2] = words[v + 2]; }
        const texel = scan.triTexelMeters[t];
        triF[9] = Number.isFinite(texel) ? Math.round(texel * 1e4) / 1e4 : -1;
        const h1 = fnv(tri, 0, 10, 2166136261), h2 = fnv(tri, 0, 10, 0x9747b28c);
        n[o]++;
        a[o] = (a[o] + h1) >>> 0;
        b[o] = (b[o] + h2) >>> 0;
        c[o] = (c[o] ^ Math.imul(h1, h2 | 1)) >>> 0;
    }
    return n.map((triangles, i) => ({ triangles, digest: `${triangles}:${a[i].toString(16)}:${b[i].toString(16)}:${c[i].toString(16)}` }));
}

/** A rebuilt building's input hash (see the module doc); `versions` are the producer's code version constants. */
export function buildingInputHash(row: DistrictBuildingMassing, building: VectorBuilding, scanDigest: string, versions: Record<string, unknown>): { hash: string; inputs: Record<string, unknown> } {
    const inputs = {
        versions, buildingId: building.id, groundY: row.groundY, scanDigest,
        vector: { parts: building.parts.length, heightM: building.heightM ?? null, extruded: building.extruded?.length ?? 0, volumes: building.volumes?.length ?? 0 },
        massing: { parts: row.massing?.parts.length ?? 0, meshes: row.massing?.meshes.length ?? 0 }
    };
    const hash = objectInputHash('building', versions, building.id, building.parts, building.heightM ?? null, building.extruded ?? null, building.volumes ?? null,
        row.groundY, row.massing?.parts ?? null, row.massing?.meshes ?? null, (row as { planeFirst?: unknown }).planeFirst ?? null, scanDigest);
    return { hash, inputs };
}

/** The scene roots of a layer GLB, a plain group root (a staged layer's "staged" node) unwrapped to its children. */
function layerItems(json: any): number[] {
    const scene = json.scenes?.[json.scene ?? 0];
    const roots: number[] = scene?.nodes ?? [];
    return roots.flatMap(r => {
        const n = json.nodes[r];
        return n.mesh === undefined && n.children?.length && !n.matrix && !n.translation && !n.rotation && !n.scale ? n.children : [r];
    });
}

/** The building id a massing node's name carries ("w:<id>/e0:0:0", "r:<id>/e0:0", "b:<id>/e0", "<kind>:<id>/v1"), found among `ids`. */
function buildingOfNode(name: string, ids: ReadonlySet<string>): string | undefined {
    const rest = name.replace(/^[^:/]*:/, '');
    const segs = rest.split('/');
    for (let k = segs.length - 1; k >= 1; k--) {
        const id = segs.slice(0, k).join('/');
        if (ids.has(id)) return id;
    }
    return undefined;
}

/** Bounds of nodes' meshes from their POSITION min/max (layer items carry no transforms). */
function boundsOfNodes(json: any, nodes: number[]): { min: number[]; max: number[] } | undefined {
    const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    for (const i of nodes) {
        const mesh = json.nodes[i]?.mesh;
        if (mesh === undefined) continue;
        for (const p of json.meshes[mesh].primitives ?? []) {
            const a = json.accessors?.[p.attributes?.POSITION];
            if (!a?.min || !a?.max || a.normalized) continue;
            for (let k = 0; k < 3; k++) { min[k] = Math.min(min[k], a.min[k]); max[k] = Math.max(max[k], a.max[k]); }
        }
    }
    return Number.isFinite(min[0]) ? { min, max } : undefined;
}

function provenanceOfNodes(json: any, nodes: number[]): LayerObject['provenance'] {
    const labels = new Set<string>();
    let confidence: number | null = null;
    for (const i of nodes) {
        const p = json.nodes[i]?.extras?.sb?.provenance;
        if (!p?.label) continue;
        labels.add(String(p.label));
        if (typeof p.confidence === 'number') confidence = confidence === null ? p.confidence : Math.min(confidence, p.confidence);
    }
    return { labels: [...labels], confidence };
}

/**
 * The massing layer's objects: each building's own nodes and the residual triangles over its footprint (see the
 * module doc). `rows` are the rebuilt rows the layer holds, `owners` their footprint cells, `hashes` their input hashes.
 */
export function districtMassingManifest(glb: ParsedGlb, glbSha256: string, rows: DistrictBuildingMassing[], owners: FootprintOwners,
    hashes: Map<string, { hash: string; inputs: Record<string, unknown> }>, producer: LayerObjectManifest['producer']): LayerObjectManifest {
    const json = glb.json;
    const ids = new Set(rows.map(r => r.id));
    const own = new Map<string, number[]>();
    const cuts = new Map<number, Array<{ node: number; triangles: number[] }>>();
    const unattributed: Array<{ node: number; triangles: number[] }> = [];
    let residualTriangles = 0, attributedTriangles = 0;
    for (const i of layerItems(json)) {
        const node = json.nodes[i];
        const id = buildingOfNode(String(node.name ?? ''), ids);
        if (id) { let list = own.get(id); if (!list) own.set(id, list = []); list.push(i); continue; }
        if (node.mesh === undefined) continue;
        // residual: each triangle to the building whose footprint cell its centroid stands in
        const per = new Map<number, number[]>();
        let first = 0;
        for (const p of json.meshes[node.mesh].primitives ?? []) {
            if ((p.mode ?? 4) !== 4 || p.attributes?.POSITION === undefined) continue;
            const pos = readAccessor(glb, p.attributes.POSITION).data;
            const idx = p.indices !== undefined ? readAccessor(glb, p.indices).data : Float64Array.from({ length: pos.length / 3 }, (_, k) => k);
            for (let t = 0; t < idx.length / 3; t++) {
                const a = idx[t * 3] * 3, b = idx[t * 3 + 1] * 3, c = idx[t * 3 + 2] * 3;
                const o = owners.at((pos[a] + pos[b] + pos[c]) / 3, (pos[a + 2] + pos[b + 2] + pos[c + 2]) / 3);
                let list = per.get(o);
                if (!list) per.set(o, list = []);
                list.push(first + t);
            }
            first += idx.length / 3;
        }
        for (const [o, tris] of per) {
            residualTriangles += tris.length;
            if (o < 0) { unattributed.push({ node: i, triangles: tris }); continue; }
            attributedTriangles += tris.length;
            let list = cuts.get(o);
            if (!list) cuts.set(o, list = []);
            list.push({ node: i, triangles: tris });
        }
    }
    const objects: LayerObject[] = [];
    const notes: string[] = [];
    rows.forEach((r, ri) => {
        const nodes = own.get(r.id) ?? [];
        const rowCuts = cuts.get(ri) ?? [];
        const h = hashes.get(r.id);
        if (!nodes.length) { notes.push(`building ${r.id}: no node in the layer carries its id`); return; }
        if (!h) { notes.push(`building ${r.id}: no input hash`); return; }
        const prov = provenanceOfNodes(json, [...nodes, ...rowCuts.map(c => c.node)]);
        const box = boundsOfNodes(json, nodes);
        objects.push({
            kind: 'building', identity: r.id, inputHash: h.hash, inputs: h.inputs, nodes, ...(rowCuts.length ? { cuts: rowCuts } : {}),
            provenance: { ...prov, ...(r.caveat ? { note: r.caveat } : {}) }, catalogType: 'FEATURE_TYPE_BUILDING',
            ...(box ? { centre: [(box.min[0] + box.max[0]) / 2, (box.min[1] + box.max[1]) / 2, (box.min[2] + box.max[2]) / 2] as [number, number, number] } : {})
        });
    });
    if (unattributed.length) {
        objects.push({
            kind: 'scan-residual', identity: 'unattributed', inputHash: objectInputHash('scan-residual', producer.version, producer.stageKey ?? glbSha256),
            cuts: unattributed, provenance: { ...provenanceOfNodes(json, unattributed.map(c => c.node)), note: 'scanned residual standing on no rebuilt footprint' }
        });
    }
    notes.push(`${objects.filter(o => o.kind === 'building').length} buildings; ${residualTriangles} residual triangles, ${attributedTriangles} on a building's footprint`);
    return { schema: LAYER_OBJECTS_SCHEMA, glbSha256, producer, objects, notes };
}

export interface DistrictObjectPlan {
    owners: FootprintOwners;
    /** Input hash per rebuilt building id. */
    hashes: Map<string, { hash: string; inputs: Record<string, unknown> }>;
    /** Rebuilt buildings whose stored GLB has their input hash: id -> the stored blob. */
    reusable: Map<string, { objectKey: string; version: number; file: string }>;
    ms: number;
}

/**
 * Before the district is massed: each rebuilt building's input hash, and which of them the object store already holds
 * for that hash (`reuse` false, or no store: none). `rows` are the rows that passed their check.
 */
export function planDistrictObjects(input: { rows: DistrictBuildingMassing[]; buildings: VectorBuilding[]; scan: ScanMesh; look: EvidenceLookup; within: (x: number, z: number) => boolean; frame: ObjectFrame; versions: Record<string, unknown>; store?: DurableAssetStore; reuse: boolean }): DistrictObjectPlan {
    const t0 = Date.now();
    const owners = footprintOwners(input.rows, input.look, input.within, 2);
    const digests = buildingScanDigests(input.scan, owners, input.rows.length);
    const hashes = new Map<string, { hash: string; inputs: Record<string, unknown> }>();
    input.rows.forEach((r, i) => hashes.set(r.id, buildingInputHash(r, input.buildings[r.index], digests[i].digest, input.versions)));
    const reusable = new Map<string, { objectKey: string; version: number; file: string }>();
    if (input.reuse && input.store) {
        const objects = new SceneObjectStore(input.store);
        const loc = locationHashOf(input.frame);
        for (const r of input.rows) {
            const key = objectKeyOf('building', r.id, loc);
            const row = objects.find(key, hashes.get(r.id)!.hash);
            const file = row && input.store.lookup(row.glbPath)?.file;
            if (row && file) reusable.set(r.id, { objectKey: key, version: row.version, file });
        }
    }
    return { owners, hashes, reusable, ms: Date.now() - t0 };
}

/**
 * The district massing layer put together from the buildings massed now (`freshGlb`, the native run's layer; absent
 * when every building was reused) and the stored GLBs of the reused ones, written to `out`.
 */
export function assembleDistrictLayer(freshGlb: string | undefined, reused: string[], out: string, rootExtras: Record<string, unknown>): void {
    const parts = [...(freshGlb ? [freshGlb] : []), ...reused].map(f => parseGlbBytes(fs.readFileSync(f)));
    const merged = mergeGlbs(parts, { name: 'staged', rootExtras, generator: 'scratchbox-staged-location pipeline E (district massing; stored buildings reused)' });
    const check = checkGlbBytes(merged);
    if (!check.ok) throw new Error(`the district layer assembled from stored buildings is not a valid GLB (${check.errors.slice(0, 3).join('; ')})`);
    fs.writeFileSync(out, merged);
}

/** A stored whole-layer object (the ground, the streets) for this input hash, when the store has it and reuse is on. */
export function findStoredLayer(store: DurableAssetStore | undefined, reuse: boolean, kind: string, identity: string, frame: ObjectFrame, inputHash: string): string | undefined {
    if (!reuse || !store) return undefined;
    const row = new SceneObjectStore(store).find(objectKeyOf(kind, identity, locationHashOf(frame)), inputHash);
    return row ? store.lookup(row.glbPath)?.file : undefined;
}

// ----------------------------------------------------------------------------------------------------------------
// the trees and whole layers
// ----------------------------------------------------------------------------------------------------------------

/** The SB-Veggie layer's trees: every root item whose extras carry a grown crown (a crown kept as scanned is an outline, not an object). */
export function treesManifest(glb: ParsedGlb, glbSha256: string, producer: LayerObjectManifest['producer']): LayerObjectManifest {
    const json = glb.json;
    const objects: LayerObject[] = [];
    let outlines = 0, other = 0;
    for (const i of layerItems(json)) {
        const e = json.nodes[i].extras;
        if (e?.keptAsScanned) { outlines++; continue; }
        if (!e || typeof e.crownId !== 'number' || !Array.isArray(e.stem) || !Array.isArray(e.apex)) { other++; continue; }
        const { crownId, ...crown } = e;
        void crownId;
        const support = typeof e.supportY === 'number' ? e.supportY : e.apex[1];
        objects.push({
            kind: 'tree', identity: '', inputHash: objectInputHash('tree', producer.version, producer.stageKey ?? glbSha256, crown),
            inputs: { stageKey: producer.stageKey, stem: e.stem, apex: e.apex, crownAreaM2: e.crownAreaM2 ?? null, heightAboveSupportM: e.heightAboveSupportM ?? null },
            nodes: [i], provenance: { labels: ['grown-to-measured-crown'], confidence: null, note: 'stem, extent and height measured; the branching grown' },
            centre: [e.stem[0], (support + e.apex[1]) / 2, e.stem[1]], catalogType: 'SB_FEATURE_TYPE_TREE'
        });
    }
    const notes = [`${objects.length} grown trees`, ...(outlines ? [`${outlines} crowns kept as scanned (outlines only, not stored as objects)`] : []), ...(other ? [`${other} other root nodes not stored`] : [])];
    return { schema: LAYER_OBJECTS_SCHEMA, glbSha256, producer, objects, notes };
}

/** A layer kept whole as one object. */
export function wholeLayerManifest(kind: string, identity: string, inputHash: string, glbSha256: string, producer: LayerObjectManifest['producer'], provenance: LayerObject['provenance'], inputs?: Record<string, unknown>): LayerObjectManifest {
    return { schema: LAYER_OBJECTS_SCHEMA, glbSha256, producer, objects: [{ kind, identity, inputHash, whole: true, provenance, ...(inputs ? { inputs } : {}) }], notes: [`the whole layer is one ${kind}`] };
}

// ----------------------------------------------------------------------------------------------------------------
// cutting and storing
// ----------------------------------------------------------------------------------------------------------------

/** One object's GLB cut from its layer: its nodes and triangle cuts under one root, shared atlas pages cut to what it samples. */
export function cutObjectGlb(layer: ParsedGlb, obj: LayerObject, name: string, images: DecodedImageCache, rootExtras?: Record<string, unknown>): { glb: Buffer; imageBytesBefore: number; imageBytesAfter: number } {
    const select: ComposeSelection[] = [...(obj.nodes ?? []).map(node => ({ node })), ...(obj.cuts ?? []).map(c => ({ node: c.node, triangles: c.triangles }))];
    const opts = { name, generator: 'Scratchbox scene object store', ...(rootExtras ? { rootExtras } : {}) };
    const firstBytes = composeGlb([{ glb: layer, select }], opts);
    const first = parseGlbBytes(firstBytes);
    const repacked = repackTextures(first, images);
    if (!repacked.report.repacked) return { glb: firstBytes, imageBytesBefore: repacked.report.imageBytesBefore, imageBytesAfter: repacked.report.imageBytesBefore };
    // composed once more: the pages the atlas replaced drop out of the binary
    const glb = composeGlb([{ glb: repacked.glb, select: (repacked.glb.json.nodes[0].children ?? []).map((node: number) => ({ node })) }], opts);
    return { glb, imageBytesBefore: repacked.report.imageBytesBefore, imageBytesAfter: repacked.report.imageBytesAfter };
}

/**
 * Each object that names a catalog type, matched one to one with the object catalog's rows of that type within 3 m of
 * its centre, nearest pairs first: two trees whose crowns stand closer than the catalog's own 3 m match can never share
 * a row (and so an object key), and the same positions match the same rows on every build.
 */
function linkCatalog(input: StoreSceneInput, origin: { lat: number; lng: number; heightMeters: number }): Map<LayerObject, string> {
    const pairs: Array<{ obj: LayerObject; id: string; d: number }> = [];
    for (const [, manifest] of input.manifests) for (const obj of manifest.objects) {
        if (!obj.catalogType || !obj.centre) continue;
        const w = scanToGeodetic(origin, obj.centre[0], obj.centre[1], obj.centre[2]);
        const degLat = 3 / 111_320, degLng = 3 / (111_320 * Math.max(0.01, Math.cos((w.lat * Math.PI) / 180)));
        for (const row of input.store.db.objectsNear(w.lat, w.lng, Math.max(degLat, degLng), obj.catalogType)) {
            const d = Math.hypot((row.lat - w.lat) * 111_320, (row.lng - w.lng) * 111_320 * Math.cos((w.lat * Math.PI) / 180));
            if (d <= 3) pairs.push({ obj, id: row.id, d });
        }
    }
    pairs.sort((a, b) => a.d - b.d || (a.id < b.id ? -1 : 1));
    const links = new Map<LayerObject, string>();
    const taken = new Set<string>();
    for (const p of pairs) if (!links.has(p.obj) && !taken.has(p.id)) { links.set(p.obj, p.id); taken.add(p.id); }
    return links;
}

const pending = new Set<Promise<unknown>>();

/** Runs a store pass in the background (a finished build does not wait for it); `awaitSceneObjectStores` waits for all. */
export function inBackground<T>(work: Promise<T>): void {
    const p = work.finally(() => pending.delete(p));
    pending.add(p);
}

/** Resolves when every background store pass has ended (scripts and tests that read the store right after a build). */
export async function awaitSceneObjectStores(): Promise<void> {
    while (pending.size) await Promise.allSettled([...pending]);
}

export interface StoreSceneInput {
    store: DurableAssetStore;
    runId: string;
    sceneId: string;
    query?: string;
    frame: ObjectFrame;
    /** Every layer of the finished build (retired and superseded ones are listed in the scene record but not cut). */
    layers: StagedLayer[];
    /** Manifests by layer object id. */
    manifests: ReadonlyMap<string, LayerObjectManifest>;
    /** Where the layers' served files are on disk (public/models). */
    modelsDir: string;
    /** The final scene (Scene3DData). */
    scene: unknown;
    workspace?: string;
}

export interface StoreSceneReport {
    objects: number;
    stored: number;
    reused: number;
    pointerMoved: number;
    bytesWritten: number;
    /** Image bytes the objects would have carried uncut, and what they carry. */
    imageBytes: { uncut: number; cut: number };
    failed: Array<{ layer: string; object?: string; error: string }>;
    perLayer: Array<{ layer: string; objects: number; stored: number; reused: number; notes: string[] }>;
    scenePath?: string;
    /** Every object kept (stored or reused), with what it is: what the training capture pairs with the scan. */
    kept: Array<{ objectKey: string; version: number; kind: string; identity: string; layer: string; glbPath: string; sha256: string; catalogType?: string; centre?: [number, number, number]; wgs84?: { lat: number; lng: number; altM: number }; provenanceLabels: string[]; inputs?: Record<string, unknown> }>;
    ms: number;
}

/**
 * Keeps the finished build's separable objects and its scene record (see the module doc). Never throws for one object.
 * Yields to the event loop between objects: the first store of a district cuts and re-encodes for tens of seconds, and
 * the server keeps answering meanwhile.
 */
export async function storeSceneObjects(input: StoreSceneInput): Promise<StoreSceneReport> {
    const t0 = Date.now();
    const objectsStore = new SceneObjectStore(input.store);
    const report: StoreSceneReport = { objects: 0, stored: 0, reused: 0, pointerMoved: 0, bytesWritten: 0, imageBytes: { uncut: 0, cut: 0 }, failed: [], perLayer: [], kept: [], ms: 0 };
    const superseded = new Set(input.layers.flatMap(l => l.supersedes));
    const refs: SceneObjectRef[] = [];
    const layerRefs: SceneLayerRef[] = [];
    const images = new DecodedImageCache();
    const origin = { lat: input.frame.lat, lng: input.frame.lng, heightMeters: input.frame.ellipsoidalHeightM ?? 0 };
    const links = linkCatalog(input, origin);
    for (const layer of input.layers) {
        const manifest = input.manifests.get(layer.objectId);
        const stored = input.store.lookup(layer.url);
        let cutHere = 0;
        if (manifest && !layer.retired && !superseded.has(layer.objectId)) {
            const lr = { layer: layer.layer, objects: manifest.objects.length, stored: 0, reused: 0, notes: [...manifest.notes] };
            report.perLayer.push(lr);
            // the published copy, else the file the manifest was made for, else the asset store's blob: the first with the manifest's bytes
            const candidates = [path.join(input.modelsDir, path.posix.basename(layer.url)), manifest.sourceFile, stored?.file].filter((f): f is string => !!f);
            let file = '';
            let bytes: Buffer | undefined;
            let parsed: ParsedGlb | undefined;
            try {
                const seen: string[] = [];
                for (const f of candidates) {
                    if (!fs.existsSync(f)) { seen.push(`${f}: missing`); continue; }
                    const sha = sha256File(f);
                    if (sha === manifest.glbSha256) { file = f; break; }
                    seen.push(`${f}: sha ${sha.slice(0, 12)}`);
                }
                if (!file) throw new Error(`no copy of the layer has the bytes its manifest describes (sha ${manifest.glbSha256.slice(0, 12)}; ${seen.join('; ')})`);
            } catch (err) {
                report.failed.push({ layer: layer.layer, error: (err as Error).message });
                layerRefs.push({ objectId: layer.objectId, layer: layer.layer, stage: layer.stage, url: layer.url, ...(stored ? { sha256: stored.sha256 } : {}), provenance: String(layer.provenance.label), objects: 0 });
                continue;
            }
            const load = () => { bytes ??= fs.readFileSync(file); return bytes; };
            const parse = () => { parsed ??= parseGlbBytes(load()); return parsed; };
            for (const obj of manifest.objects) {
                await new Promise<void>(resolve => setImmediate(resolve));
                report.objects++;
                let identity = obj.identity;
                let catalogId: string | undefined;
                const wgs = obj.centre ? scanToGeodetic(origin, obj.centre[0], obj.centre[1], obj.centre[2]) : undefined;
                try {
                    if (obj.catalogType && wgs) {
                        catalogId = links.get(obj);
                        if (!identity) {
                            // a tree's identity is its catalog row: matched one to one (below), or recorded now as a new row
                            catalogId ??= recordDiscoveredObjectIn(input.store.db, {
                                type: obj.catalogType, label: obj.provenance.note, lat: wgs.lat, lng: wgs.lng,
                                bboxLo: { lat: wgs.lat, lng: wgs.lng, alt: wgs.alt }, bboxHi: { lat: wgs.lat, lng: wgs.lng, alt: wgs.alt },
                                source: 'scene-object-store', runId: input.runId, dedupRadiusM: 0
                            }).id;
                            identity = catalogId;
                        }
                    }
                    if (!identity) throw new Error('no identity (no geodetic centre to find it in the object catalog)');
                    const rootExtras = { sbObject: { schema: 'scratchbox.object/1', kind: obj.kind, identity, inputHash: obj.inputHash, layer: layer.layer } };
                    let cut: { uncut: number; cut: number } | undefined;
                    const put: PutObjectResult = objectsStore.put({
                        kind: obj.kind, identity, frame: input.frame, inputHash: obj.inputHash,
                        glb: () => {
                            if (obj.whole) return load();
                            const c = cutObjectGlb(parse(), obj, `${obj.kind}/${identity}`, images, rootExtras);
                            cut = { uncut: c.imageBytesBefore, cut: c.imageBytesAfter };
                            return c.glb;
                        },
                        provenance: obj.provenance, producer: { ...manifest.producer, layer: layer.layer }, ...(obj.inputs ? { inputs: obj.inputs } : {}),
                        ...(wgs ? { wgs84: { lat: wgs.lat, lng: wgs.lng, altM: wgs.alt } } : {}), ...(catalogId ? { catalogId } : {}),
                        runId: input.runId, ...(input.workspace ? { workspace: input.workspace } : {})
                    });
                    if (cut) { report.imageBytes.uncut += cut.uncut; report.imageBytes.cut += cut.cut; }
                    if (put.reused) { report.reused++; lr.reused++; } else { report.stored++; lr.stored++; report.bytesWritten += put.bytes; }
                    if (put.pointerMoved) report.pointerMoved++;
                    cutHere++;
                    refs.push({ objectKey: put.objectKey, version: put.version, kind: obj.kind, layer: layer.layer, glbPath: put.glbPath, sha256: put.sha256, reused: put.reused });
                    report.kept.push({
                        objectKey: put.objectKey, version: put.version, kind: obj.kind, identity, layer: layer.layer, glbPath: put.glbPath, sha256: put.sha256,
                        ...(obj.catalogType ? { catalogType: obj.catalogType } : {}), ...(obj.centre ? { centre: obj.centre } : {}), ...(wgs ? { wgs84: { lat: wgs.lat, lng: wgs.lng, altM: wgs.alt } } : {}),
                        provenanceLabels: obj.provenance.labels, ...(obj.inputs ? { inputs: obj.inputs } : {})
                    });
                } catch (err) {
                    report.failed.push({ layer: layer.layer, object: `${obj.kind}/${identity || '?'}`, error: (err as Error).message });
                }
            }
        }
        layerRefs.push({ objectId: layer.objectId, layer: layer.layer, stage: layer.stage, url: layer.url, ...(stored ? { sha256: stored.sha256 } : {}), provenance: String(layer.provenance.label), objects: cutHere });
    }
    images.clear();
    try {
        const scene = objectsStore.putScene({
            sceneId: input.sceneId, runId: input.runId, ...(input.query ? { query: input.query } : {}), frame: input.frame, objects: refs, layers: layerRefs, scene: input.scene,
            notes: report.perLayer.flatMap(l => l.notes.map(n => `${l.layer}: ${n}`)), ...(input.workspace ? { workspace: input.workspace } : {})
        });
        report.scenePath = scene.path;
    } catch (err) {
        report.failed.push({ layer: 'scene', error: (err as Error).message });
    }
    report.ms = Date.now() - t0;
    return report;
}
