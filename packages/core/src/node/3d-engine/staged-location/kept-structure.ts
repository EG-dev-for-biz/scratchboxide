/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Staging a place into a scene that already holds a staged structure rebuild (a hero): the rebuild is kept, and the
 * district goes around it.
 *
 * - The active scene's objects are split three ways (partitionActiveScene): the structure layers an earlier staged
 *   build committed (metadata source 'scan_fit': the fitted body, the pass-through scan, the figures, the detail, and
 *   the textured twins the viewport derives from their layer records), the earlier location layers (its tiles, remesh
 *   and trees, which the new district replaces), and everything else (kept as it is).
 * - A structure is replaced only by a new rebuild of a structure at the same place (an isolated build within
 *   SAME_PLACE_M of it); a district never replaces one.
 * - The kept structure is moved into the new extraction's frame: both frames are east-north-up at their anchor, so the
 *   offset is the anchors' ENU difference (the extraction's ground height can differ between radii).
 * - The district's own scan of the structure would stand in the same place: its triangles inside the structure's
 *   footprint and above the structure's base are removed from the district layers (hideFootprintInGlb), and the result
 *   says how many and from which layers.
 */

import type { Media4DObject } from '../../../browser/generative-canvas/canvas-types';
import type { StagedBuildState, StagedLayer } from '../../../common/spatial/staged-location-contracts';
import { assembleGlb, nodeWorldMatrices, parseGlbBytes, readAccessor, transformPoint } from './glb-bytes';

export type Vec3 = [number, number, number];

/** Two anchors closer than this are the same place (a rebuild there replaces the earlier rebuild). */
export const SAME_PLACE_M = 30;
/** The footprint grid: cells this wide, dilated by one cell around every cell the structure covers. */
export const FOOTPRINT_CELL_M = 0.5;
/** District triangles whose centroid is less than this above the structure's base stay (the ground under it). */
export const FOOTPRINT_GROUND_CLEARANCE_M = 0.3;

function sourceOf(o: any): string {
    return String(o?.content?.metadata?.source || '').toLowerCase();
}

/** A layer of a staged structure rebuild (fitted body, pass-through scan, figures, detail): it stands for the structure itself. */
export function isStructureLayerObject(o: any): boolean {
    return sourceOf(o) === 'scan_fit';
}

/** Previous environment layers of a scene the tiles are staged into: replaced, never stacked (as spatial-tools). */
export function isLocationLayer(o: any): boolean {
    const s = sourceOf(o);
    const role = String(o?.content?.metadata?.role || '').toLowerCase();
    return s === 'google3dtilesclay' || s === 'google_3d_tiles_clay' || s === 'google3dtilesfulltexture' || s === 'google_3d_tiles_full_texture'
        || s === 'googlevectortileservice' || s === 'google_vector_tile_service' || s === 'sb-veggie' || role === 'environment' || role === 'vegetation';
}

export interface KeptLayerReport { objectId: string; layer?: string; source: string; textured: boolean; provenance?: string }

export interface ActiveScenePartition {
    /** Objects that are neither location nor structure layers: kept untouched. */
    other: Media4DObject[];
    /** The structure rebuild's objects, kept (before the offset). */
    structure: Media4DObject[];
    /** Their layer records from the earlier build's state (the viewport derives twins and reveals from them). */
    structureLayers: StagedLayer[];
    /** Earlier location layers (and a replaced structure) that the new build takes out of the scene. */
    removed: Array<{ objectId: string; source: string; why: string }>;
    /** The earlier build's anchor, which the kept structure's coordinates are relative to. */
    anchor?: { lat: number; lng: number; elevation?: number };
    /** The earlier build's material mode (textured stays textured). */
    materialMode?: string;
    /** The earlier build's run. */
    runId?: string;
    place?: string;
}

function metresBetween(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
    const north = (a.lat - b.lat) * 110_540;
    const east = (a.lng - b.lng) * 111_320 * Math.cos((((a.lat + b.lat) / 2) * Math.PI) / 180);
    return Math.hypot(north, east);
}

/**
 * Splits the active scene. `rebuildAt` is the new build's place when it rebuilds a structure itself (an isolated build):
 * an earlier structure there is replaced; otherwise every earlier structure is kept.
 */
export function partitionActiveScene(scene: { data?: unknown } | undefined, rebuildAt?: { lat: number; lng: number }): ActiveScenePartition {
    const data = (scene?.data as any) || {};
    const objects: Media4DObject[] = Array.isArray(data.objects) ? data.objects : [];
    const state: StagedBuildState | undefined = data.stagedBuild && Array.isArray(data.stagedBuild.layers) ? data.stagedBuild : undefined;
    const anchor = data.geoAnchor && Number.isFinite(Number(data.geoAnchor.lat)) && Number.isFinite(Number(data.geoAnchor.lng))
        ? { lat: Number(data.geoAnchor.lat), lng: Number(data.geoAnchor.lng), ...(Number.isFinite(Number(data.geoAnchor.elevation)) && data.geoAnchor.elevation !== null ? { elevation: Number(data.geoAnchor.elevation) } : {}) }
        : undefined;
    const replaceStructure = !!rebuildAt && !!anchor && metresBetween(anchor, rebuildAt) < SAME_PLACE_M;
    const out: ActiveScenePartition = { other: [], structure: [], structureLayers: [], removed: [], ...(anchor ? { anchor } : {}) };
    if (state?.materialMode) out.materialMode = String(state.materialMode);
    if (state?.runId) out.runId = state.runId;
    if (state?.place) out.place = state.place.resolvedAddress || state.place.query;
    for (const o of objects) {
        if (isStructureLayerObject(o)) {
            if (replaceStructure) out.removed.push({ objectId: o.id, source: sourceOf(o), why: 'a new rebuild of the structure at the same place replaces it' });
            else out.structure.push(o);
        } else if (isLocationLayer(o)) {
            out.removed.push({ objectId: o.id, source: sourceOf(o), why: 'the new location layers replace it' });
        } else {
            out.other.push(o);
        }
    }
    if (state) {
        const ids = new Set(out.structure.map(o => o.id));
        const keep = (list: string[]) => list.filter(id => ids.has(id));
        // only references inside the kept set survive (what they superseded is gone); they show at once, they are not rebuilt
        out.structureLayers = state.layers.filter(l => ids.has(l.objectId) && !l.retired).map(l => ({
            ...l,
            supersedes: keep(l.supersedes),
            revealAfter: [],
            reveal: { ...l.reveal, durationMs: 0, crossfadeFrom: keep(l.reveal.crossfadeFrom) },
            keptFrom: l.keptFrom ?? { runId: state.runId, place: state.place?.resolvedAddress || state.place?.query || '' }
        }));
    }
    return out;
}

/** Where the earlier anchor's origin lies in the new frame (x east, y up, z south), metres. Unknown heights count as equal. */
export function anchorOffset(from: { lat: number; lng: number; elevation?: number } | undefined, to: { lat: number; lng: number; elevation?: number }): Vec3 {
    if (!from) return [0, 0, 0];
    const east = (from.lng - to.lng) * 111_320 * Math.cos((((from.lat + to.lat) / 2) * Math.PI) / 180);
    const north = (from.lat - to.lat) * 110_540;
    const up = typeof from.elevation === 'number' && typeof to.elevation === 'number' ? from.elevation - to.elevation : 0;
    const r = (v: number) => Math.round(v * 1000) / 1000 + 0;
    return [r(east), r(up), r(-north)];
}

/** The kept structure objects moved by `offset` (their own position plus the offset). */
export function offsetObjects(objects: Media4DObject[], offset: Vec3): Media4DObject[] {
    if (offset.every(v => v === 0)) return objects;
    return objects.map(o => {
        const p = (o.space as any)?.spatial3d ?? {};
        return { ...o, space: { ...(o.space as any), spatial3d: { ...p, x: (p.x ?? 0) + offset[0], y: (p.y ?? 0) + offset[1], z: (p.z ?? 0) + offset[2] } } } as Media4DObject;
    });
}

// ----------------------------------------------------------------------------------------------------------------
// the footprint, and the district without the structure's own scan
// ----------------------------------------------------------------------------------------------------------------

export interface StructureFootprint {
    cellM: number;
    /** "i,k" of cells floor(x / cellM), floor(z / cellM), in the new frame. */
    cells: Set<string>;
    /** The structure's lowest point, new frame. */
    baseY: number;
    topY: number;
}

interface TriangleVisitor { (a: Vec3, b: Vec3, c: Vec3): void }

/** Every triangle of every triangle primitive of a GLB, in world space (node matrices applied). */
function forEachTriangle(bytes: Uint8Array, visit: TriangleVisitor): void {
    const glb = parseGlbBytes(bytes);
    const world = nodeWorldMatrices(glb.json);
    (glb.json.nodes ?? []).forEach((node: any, ni: number) => {
        if (node.mesh === undefined) return;
        for (const prim of glb.json.meshes?.[node.mesh]?.primitives ?? []) {
            if ((prim.mode ?? 4) !== 4 || prim.attributes?.POSITION === undefined) continue;
            const pos = readAccessor(glb, prim.attributes.POSITION).data;
            const m = world[ni];
            const n = pos.length / 3;
            const p = new Float64Array(n * 3);
            for (let i = 0; i < n; i++) { const q = transformPoint(m, pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]); p[i * 3] = q[0]; p[i * 3 + 1] = q[1]; p[i * 3 + 2] = q[2]; }
            const idx = prim.indices !== undefined ? readAccessor(glb, prim.indices).data : undefined;
            const count = idx ? idx.length : n;
            const at = (k: number): Vec3 => { const v = idx ? idx[k] : k; return [p[v * 3], p[v * 3 + 1], p[v * 3 + 2]]; };
            for (let t = 0; t + 2 < count; t += 3) visit(at(t), at(t + 1), at(t + 2));
        }
    });
}

/** The structure's plan footprint: every grid cell a triangle's plan projection covers, dilated by one cell. */
export function structureFootprint(glbs: Uint8Array[], offset: Vec3, cellM = FOOTPRINT_CELL_M): StructureFootprint {
    const core = new Set<string>();
    let baseY = Infinity, topY = -Infinity;
    const mark = (i: number, k: number) => core.add(`${i},${k}`);
    for (const bytes of glbs) {
        forEachTriangle(bytes, (a0, b0, c0) => {
            const a: Vec3 = [a0[0] + offset[0], a0[1] + offset[1], a0[2] + offset[2]];
            const b: Vec3 = [b0[0] + offset[0], b0[1] + offset[1], b0[2] + offset[2]];
            const c: Vec3 = [c0[0] + offset[0], c0[1] + offset[1], c0[2] + offset[2]];
            for (const v of [a, b, c]) { baseY = Math.min(baseY, v[1]); topY = Math.max(topY, v[1]); mark(Math.floor(v[0] / cellM), Math.floor(v[2] / cellM)); }
            // the cells whose centre the plan projection covers (a large fitted face covers many cells and has few vertices)
            const i0 = Math.floor(Math.min(a[0], b[0], c[0]) / cellM), i1 = Math.floor(Math.max(a[0], b[0], c[0]) / cellM);
            const k0 = Math.floor(Math.min(a[2], b[2], c[2]) / cellM), k1 = Math.floor(Math.max(a[2], b[2], c[2]) / cellM);
            if ((i1 - i0 + 1) * (k1 - k0 + 1) > 400_000) return;
            const area = (b[0] - a[0]) * (c[2] - a[2]) - (c[0] - a[0]) * (b[2] - a[2]);
            if (Math.abs(area) < 1e-9) {
                // a vertical face: its plan is a segment, marked along its length
                const pts: Array<[number, number]> = [[a[0], a[2]], [b[0], b[2]], [c[0], c[2]]];
                for (let s = 0; s < 3; s++) {
                    const [x0, z0] = pts[s], [x1, z1] = pts[(s + 1) % 3];
                    const steps = Math.ceil(Math.hypot(x1 - x0, z1 - z0) / (cellM / 2));
                    for (let j = 0; j <= steps; j++) mark(Math.floor((x0 + ((x1 - x0) * j) / Math.max(1, steps)) / cellM), Math.floor((z0 + ((z1 - z0) * j) / Math.max(1, steps)) / cellM));
                }
                return;
            }
            for (let k = k0; k <= k1; k++) for (let i = i0; i <= i1; i++) {
                const x = (i + 0.5) * cellM, z = (k + 0.5) * cellM;
                const w0 = (b[0] - x) * (c[2] - z) - (c[0] - x) * (b[2] - z);
                const w1 = (c[0] - x) * (a[2] - z) - (a[0] - x) * (c[2] - z);
                const w2 = (a[0] - x) * (b[2] - z) - (b[0] - x) * (a[2] - z);
                if ((w0 >= 0 && w1 >= 0 && w2 >= 0) || (w0 <= 0 && w1 <= 0 && w2 <= 0)) mark(i, k);
            }
            // the triangle's edges, so thin slivers between cell centres still mark their cells
            for (const [p, q] of [[a, b], [b, c], [c, a]] as Array<[Vec3, Vec3]>) {
                const steps = Math.ceil(Math.hypot(q[0] - p[0], q[2] - p[2]) / (cellM / 2));
                for (let j = 0; j <= steps; j++) mark(Math.floor((p[0] + ((q[0] - p[0]) * j) / Math.max(1, steps)) / cellM), Math.floor((p[2] + ((q[2] - p[2]) * j) / Math.max(1, steps)) / cellM));
            }
        });
    }
    const cells = new Set<string>();
    for (const key of core) {
        const [i, k] = key.split(',').map(Number);
        for (let dk = -1; dk <= 1; dk++) for (let di = -1; di <= 1; di++) cells.add(`${i + di},${k + dk}`);
    }
    return { cellM, cells, baseY: Number.isFinite(baseY) ? baseY : 0, topY: Number.isFinite(topY) ? topY : 0 };
}

/**
 * The district GLB without its triangles inside the structure's footprint and above its base (the district's own scan
 * of the structure, which the kept rebuild stands in for). Positions and every other attribute are untouched: only the
 * index lists change (each trimmed primitive gets a new uint32 index accessor at the end of the binary chunk).
 */
export function hideFootprintInGlb(bytes: Uint8Array, footprint: StructureFootprint): { glb: Buffer; removedTriangles: number; keptTriangles: number } {
    const glb = parseGlbBytes(bytes);
    const json = glb.json;
    const world = nodeWorldMatrices(json);
    const minY = footprint.baseY + FOOTPRINT_GROUND_CLEARANCE_M;
    const extra: Uint8Array[] = [];
    let binLength = glb.bin.byteLength + ((4 - (glb.bin.byteLength % 4)) % 4);
    let removed = 0, kept = 0;
    // a mesh used by several nodes is trimmed once, by the first node that draws it
    const done = new Set<number>();
    (json.nodes ?? []).forEach((node: any, ni: number) => {
        if (node.mesh === undefined || done.has(node.mesh)) return;
        done.add(node.mesh);
        for (const prim of json.meshes?.[node.mesh]?.primitives ?? []) {
            if ((prim.mode ?? 4) !== 4 || prim.attributes?.POSITION === undefined) continue;
            const pos = readAccessor(glb, prim.attributes.POSITION).data;
            const idx = prim.indices !== undefined ? readAccessor(glb, prim.indices).data : undefined;
            const count = idx ? idx.length : pos.length / 3;
            const m = world[ni];
            const keep: number[] = [];
            let cut = 0;
            for (let t = 0; t + 2 < count; t += 3) {
                const v = [idx ? idx[t] : t, idx ? idx[t + 1] : t + 1, idx ? idx[t + 2] : t + 2];
                const cx = (pos[v[0] * 3] + pos[v[1] * 3] + pos[v[2] * 3]) / 3;
                const cy = (pos[v[0] * 3 + 1] + pos[v[1] * 3 + 1] + pos[v[2] * 3 + 1]) / 3;
                const cz = (pos[v[0] * 3 + 2] + pos[v[1] * 3 + 2] + pos[v[2] * 3 + 2]) / 3;
                const w = transformPoint(m, cx, cy, cz);
                if (w[1] > minY && footprint.cells.has(`${Math.floor(w[0] / footprint.cellM)},${Math.floor(w[2] / footprint.cellM)}`)) { cut++; continue; }
                keep.push(v[0], v[1], v[2]);
            }
            removed += cut;
            kept += keep.length / 3;
            if (!cut) continue;
            const data = new Uint8Array(new Uint32Array(keep).buffer);
            json.bufferViews.push({ buffer: 0, byteOffset: binLength, byteLength: data.byteLength, target: 34963 });
            json.accessors.push({ bufferView: json.bufferViews.length - 1, componentType: 5125, count: keep.length, type: 'SCALAR' });
            prim.indices = json.accessors.length - 1;
            extra.push(data);
            binLength += data.byteLength;
        }
    });
    if (!removed) return { glb: Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength), removedTriangles: 0, keptTriangles: kept };
    const bin = new Uint8Array(binLength);
    bin.set(glb.bin, 0);
    let o = glb.bin.byteLength + ((4 - (glb.bin.byteLength % 4)) % 4);
    for (const e of extra) { bin.set(e, o); o += e.byteLength; }
    if (json.buffers?.[0]) json.buffers[0].byteLength = binLength;
    return { glb: assembleGlb(json, bin), removedTriangles: removed, keptTriangles: kept };
}
