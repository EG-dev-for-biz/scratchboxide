/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Compact edit records for the viewport timeline (see viewport-history.ts):
 *  - SceneDelta: only the scene-data fields / collection items an edit changed (before + after),
 *    patched by item id so an undo never overwrites unrelated concurrent changes.
 *  - ObjectEditCapture: Three.js side effects of an edit as sparse vertex deltas (changed vertices
 *    only, not whole buffers) and local transforms.
 */

import * as THREE from 'three';
import type { Scene3DData } from '../canvas-types';
import { recomputeGeometryNormals } from './mesh-sculpting-engine';
import type { HistoryEntry, HistoryReplayInfo } from './viewport-history';

// ---------------------------------------------------------------------------
// Generic helpers
// ---------------------------------------------------------------------------

/** Deep copy of JSON-like data. Strings are immutable and shared, so a multi-MB base64 field costs nothing. */
export function cloneJsonLike<T>(value: T): T {
    if (value === null || typeof value !== 'object') return value;
    if (ArrayBuffer.isView(value)) return (value as unknown as { slice(): unknown }).slice() as T;
    if (Array.isArray(value)) return value.map(cloneJsonLike) as unknown as T;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>)) {
        const v = (value as Record<string, unknown>)[key];
        if (typeof v === 'function') continue;
        out[key] = cloneJsonLike(v);
    }
    return out as T;
}

export function deepEqual(a: unknown, b: unknown): boolean {
    if (Object.is(a, b)) return true;
    if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
    if (ArrayBuffer.isView(a) || ArrayBuffer.isView(b)) {
        if (!ArrayBuffer.isView(a) || !ArrayBuffer.isView(b)) return false;
        const x = a as unknown as ArrayLike<number>;
        const y = b as unknown as ArrayLike<number>;
        if (x.length !== y.length) return false;
        for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return false;
        return true;
    }
    if (Array.isArray(a) !== Array.isArray(b)) return false;
    if (Array.isArray(a)) {
        const y = b as unknown[];
        if (a.length !== y.length) return false;
        for (let i = 0; i < a.length; i++) if (!deepEqual(a[i], y[i])) return false;
        return true;
    }
    const ka = Object.keys(a as object).filter(k => typeof (a as Record<string, unknown>)[k] !== 'function');
    const kb = Object.keys(b as object).filter(k => typeof (b as Record<string, unknown>)[k] !== 'function');
    if (ka.length !== kb.length) return false;
    for (const k of ka) {
        if (!Object.prototype.hasOwnProperty.call(b, k)) return false;
        if (!deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k])) return false;
    }
    return true;
}

/** Rough retained size of a JSON-like value (strings count 2 bytes/char, typed arrays their byteLength). */
export function estimateBytes(value: unknown, nodeBudget = 50_000): number {
    let bytes = 0;
    let nodes = 0;
    const stack: unknown[] = [value];
    while (stack.length > 0 && nodes < nodeBudget) {
        const v = stack.pop();
        nodes++;
        if (typeof v === 'string') bytes += v.length * 2 + 16;
        else if (typeof v === 'number') bytes += 8;
        else if (typeof v === 'boolean') bytes += 4;
        else if (v && typeof v === 'object') {
            if (ArrayBuffer.isView(v)) { bytes += v.byteLength + 16; continue; }
            if (Array.isArray(v)) { bytes += 16 + v.length * 8; for (const x of v) stack.push(x); continue; }
            bytes += 32;
            for (const k of Object.keys(v)) { bytes += k.length * 2; stack.push((v as Record<string, unknown>)[k]); }
        }
    }
    return bytes;
}

// ---------------------------------------------------------------------------
// Scene-data delta
// ---------------------------------------------------------------------------

export interface ItemChange {
    id: string;
    /** Index in the array the item came from (removed: before array; added: after array). */
    index: number;
    before?: unknown;
    after?: unknown;
}

export interface SceneDelta {
    fields: Record<string, { before: unknown; after: unknown }>;
    collections: Record<string, ItemChange[]>;
}

export interface SceneDeltaOptions {
    /** Top-level keys that are never part of an edit (logs, selection, generated results). */
    ignoreKeys?: ReadonlyArray<string>;
    /** Collection items that are generated results, not user content (e.g. staged-location layers). */
    ignoreItem?: (collectionKey: string, item: any) => boolean;
    /** Deep-copy what the delta retains (needed when the scene is mutated in place). */
    clone?: boolean;
}

/** Keys no edit owns: the operator logs record edits, selection is not an edit, brush settings are tool state. */
export const SCENE_BOOKKEEPING_KEYS: ReadonlyArray<string> = ['operatorStack', 'actionLog', 'selectedMeshId', 'sculptSettings'];

function isCollection(v: unknown): v is Array<{ id: string }> {
    if (!Array.isArray(v)) return false;
    const seen = new Set<string>();
    for (const item of v) {
        if (!item || typeof item !== 'object' || typeof (item as any).id !== 'string' || seen.has((item as any).id)) return false;
        seen.add((item as any).id);
    }
    return true;
}

export function computeSceneDelta(prev: Scene3DData, next: Scene3DData, options: SceneDeltaOptions = {}): SceneDelta | null {
    const ignore = new Set(options.ignoreKeys ?? SCENE_BOOKKEEPING_KEYS);
    const keep = <T,>(v: T): T => (options.clone ? cloneJsonLike(v) : v);
    const delta: SceneDelta = { fields: {}, collections: {} };
    const a = prev as unknown as Record<string, unknown>;
    const b = next as unknown as Record<string, unknown>;

    for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
        if (ignore.has(key)) continue;
        const av = a[key];
        const bv = b[key];
        if (av === bv) continue;
        const asList = (v: unknown) => (v === undefined ? [] : v);
        if (isCollection(asList(av)) && isCollection(asList(bv))) {
            const before = asList(av) as Array<{ id: string }>;
            const after = asList(bv) as Array<{ id: string }>;
            const skip = (item: any) => !!options.ignoreItem?.(key, item);
            const beforeById = new Map(before.map((item, index) => [item.id, { item, index }]));
            const afterIds = new Set(after.map(item => item.id));
            const changes: ItemChange[] = [];
            after.forEach((item, index) => {
                const old = beforeById.get(item.id);
                if (!old) {
                    if (!skip(item)) changes.push({ id: item.id, index, after: keep(item) });
                } else if (old.item !== item && !skip(item) && !deepEqual(old.item, item)) {
                    changes.push({ id: item.id, index, before: keep(old.item), after: keep(item) });
                }
            });
            before.forEach((item, index) => {
                if (!afterIds.has(item.id) && !skip(item)) changes.push({ id: item.id, index, before: keep(item) });
            });
            if (changes.length > 0) delta.collections[key] = changes;
        } else if (!deepEqual(av, bv)) {
            delta.fields[key] = { before: keep(av), after: keep(bv) };
        }
    }
    return Object.keys(delta.fields).length === 0 && Object.keys(delta.collections).length === 0 ? null : delta;
}

/** Applies (`apply`: before -> after) or reverses (`revert`) a delta, returning new scene data. */
export function applySceneDelta(data: Scene3DData, delta: SceneDelta, direction: 'apply' | 'revert', clone = false): Scene3DData {
    const out: Record<string, unknown> = { ...(data as unknown as Record<string, unknown>) };
    const pick = <T,>(v: T): T => (clone ? cloneJsonLike(v) : v);

    for (const [key, f] of Object.entries(delta.fields)) {
        const v = direction === 'revert' ? f.before : f.after;
        if (v === undefined) delete out[key];
        else out[key] = pick(v);
    }

    for (const [key, changes] of Object.entries(delta.collections)) {
        let list = [...((out[key] as Array<{ id: string }> | undefined) ?? [])];
        const removeIds = new Set<string>();
        const insert: ItemChange[] = [];
        for (const c of changes) {
            const hadBefore = c.before !== undefined;
            const hasAfter = c.after !== undefined;
            if (hadBefore && hasAfter) {
                const target = direction === 'revert' ? c.before : c.after;
                const at = list.findIndex(item => item.id === c.id);
                if (at >= 0) list[at] = pick(target) as { id: string };
            } else if (direction === 'revert') {
                if (hasAfter) removeIds.add(c.id);
                else insert.push(c);
            } else if (hadBefore) removeIds.add(c.id);
            else insert.push(c);
        }
        if (removeIds.size > 0) list = list.filter(item => !removeIds.has(item.id));
        insert.sort((x, y) => x.index - y.index);
        for (const c of insert) {
            if (list.some(item => item.id === c.id)) continue;
            const item = pick(direction === 'revert' ? c.before : c.after) as { id: string };
            list.splice(Math.min(c.index, list.length), 0, item);
        }
        out[key] = list;
    }
    return out as unknown as Scene3DData;
}

/** True when `later` only re-edits things `earlier` already edited (a slider drag), never adds or removes. */
export function canMergeSceneDeltas(earlier: SceneDelta, later: SceneDelta): boolean {
    for (const key of Object.keys(later.fields)) if (!(key in earlier.fields)) return false;
    for (const [key, changes] of Object.entries(later.collections)) {
        const mine = earlier.collections[key];
        if (!mine) return false;
        for (const c of changes) {
            if (c.before === undefined || c.after === undefined) return false;
            if (!mine.some(x => x.id === c.id)) return false;
        }
    }
    for (const changes of Object.values(earlier.collections)) {
        for (const c of changes) if (c.before === undefined || c.after === undefined) return false;
    }
    return true;
}

/** Composition of two deltas where `later` follows `earlier` (only valid when canMergeSceneDeltas). */
export function mergeSceneDeltas(earlier: SceneDelta, later: SceneDelta): SceneDelta {
    const fields = { ...earlier.fields };
    for (const [key, f] of Object.entries(later.fields)) fields[key] = { before: earlier.fields[key].before, after: f.after };
    const collections: Record<string, ItemChange[]> = {};
    for (const [key, changes] of Object.entries(earlier.collections)) {
        const lateById = new Map((later.collections[key] ?? []).map(c => [c.id, c]));
        collections[key] = changes.map(c => (lateById.has(c.id) ? { ...c, after: lateById.get(c.id)!.after } : c));
    }
    return { fields, collections };
}

export function sceneDeltaBytes(delta: SceneDelta): number {
    return estimateBytes(delta);
}

// ---------------------------------------------------------------------------
// Three.js side effects: sparse vertex deltas + local transforms
// ---------------------------------------------------------------------------

export interface LiveEdit {
    bytes: number;
    apply(): boolean;
    revert(): boolean;
    /** Releases anything held (replaced GPU geometry). */
    dispose?(): void;
}

interface TransformSnap { p: [number, number, number]; q: [number, number, number, number]; s: [number, number, number] }

export function readTransform(o: THREE.Object3D): TransformSnap {
    return { p: [o.position.x, o.position.y, o.position.z], q: [o.quaternion.x, o.quaternion.y, o.quaternion.z, o.quaternion.w], s: [o.scale.x, o.scale.y, o.scale.z] };
}

export function writeTransform(o: THREE.Object3D, t: TransformSnap): void {
    o.position.set(t.p[0], t.p[1], t.p[2]);
    o.quaternion.set(t.q[0], t.q[1], t.q[2], t.q[3]);
    o.scale.set(t.s[0], t.s[1], t.s[2]);
    o.updateMatrix();
}

function transformsDiffer(a: TransformSnap, b: TransformSnap): boolean {
    return a.p.some((v, i) => v !== b.p[i]) || a.q.some((v, i) => v !== b.q[i]) || a.s.some((v, i) => v !== b.s[i]);
}

function meshesOf(root: THREE.Object3D): THREE.Mesh[] {
    const out: THREE.Mesh[] = [];
    root.traverse(c => { if ((c as THREE.Mesh).isMesh && (c as THREE.Mesh).geometry?.attributes?.position) out.push(c as THREE.Mesh); });
    return out;
}

interface VertexDelta { mesh: THREE.Mesh; count: number; indices: Uint32Array; before: Float32Array; after: Float32Array }
interface TransformDelta { obj: THREE.Object3D; before: TransformSnap; after: TransformSnap }

function writeVertices(d: VertexDelta, values: Float32Array): boolean {
    const pos = d.mesh.geometry?.attributes?.position as THREE.BufferAttribute | undefined;
    if (!pos || pos.count !== d.count) return false;
    const arr = pos.array as Float32Array;
    for (let i = 0; i < d.indices.length; i++) {
        const v = d.indices[i] * 3;
        arr[v] = values[i * 3];
        arr[v + 1] = values[i * 3 + 1];
        arr[v + 2] = values[i * 3 + 2];
    }
    recomputeGeometryNormals(d.mesh.geometry);
    return true;
}

/** An object removed from its scene (rebuilt content) has no parent; an edit on it can no longer be shown. */
const isDetached = (o: THREE.Object3D): boolean => !o.parent && !(o as THREE.Scene).isScene;

/** A mesh whose geometry or material object was replaced by the edit (subdivision, recomputed normals, new material). */
interface SwapDelta {
    mesh: THREE.Mesh;
    geometry?: { before: THREE.BufferGeometry; after: THREE.BufferGeometry };
    material?: { before: THREE.Material | THREE.Material[]; after: THREE.Material | THREE.Material[] };
}

const geometryBytes = (g: THREE.BufferGeometry) => Object.values(g.attributes).reduce((n, a) => n + (a as THREE.BufferAttribute).array.byteLength, 0) + (g.index?.array.byteLength ?? 0);

class ObjectLiveEdit implements LiveEdit {
    readonly bytes: number;
    private showing: 'before' | 'after' = 'after';
    constructor(private readonly verts: VertexDelta[], private readonly transforms: TransformDelta[], private readonly swaps: SwapDelta[] = []) {
        let b = 64;
        for (const v of verts) b += v.indices.byteLength + v.before.byteLength + v.after.byteLength;
        for (const w of swaps) if (w.geometry) b += geometryBytes(w.geometry.before) + geometryBytes(w.geometry.after);
        this.bytes = b + transforms.length * 160 + swaps.length * 64;
    }
    private run(which: 'before' | 'after'): boolean {
        let ok = false;
        for (const v of this.verts) if (!isDetached(v.mesh)) ok = writeVertices(v, v[which]) || ok;
        for (const t of this.transforms) if (!isDetached(t.obj)) { writeTransform(t.obj, t[which]); ok = true; }
        for (const w of this.swaps) {
            if (isDetached(w.mesh)) continue;
            if (w.geometry) w.mesh.geometry = w.geometry[which];
            if (w.material) w.mesh.material = w.material[which];
            ok = true;
        }
        this.showing = which;
        return ok;
    }
    revert(): boolean { return this.run('before'); }
    apply(): boolean { return this.run('after'); }
    /** Frees the replaced geometry that can no longer be shown. */
    dispose(): void {
        for (const w of this.swaps) {
            const hidden = w.geometry?.[this.showing === 'after' ? 'before' : 'after'];
            if (hidden && hidden !== w.mesh.geometry) hidden.dispose();
        }
    }
}

/**
 * Snapshots the objects an edit is about to change (position buffers + local transforms) and, once
 * the edit ran, reduces the difference to a compact LiveEdit: changed vertices only. The snapshot is
 * transient; only the sparse delta stays in history.
 */
export class ObjectEditCapture {
    private readonly vertexSnaps: Array<{ mesh: THREE.Mesh; positions: Float32Array }> = [];
    private readonly transformSnaps: Array<{ obj: THREE.Object3D; before: TransformSnap }> = [];
    private readonly objectSnaps: Array<{ mesh: THREE.Mesh; geometry: THREE.BufferGeometry; material: THREE.Material | THREE.Material[] }> = [];

    constructor(objects: THREE.Object3D[], options: { geometry?: boolean; transform?: boolean } = {}) {
        const geometry = options.geometry !== false;
        const transform = options.transform !== false;
        const seenMesh = new Set<THREE.Mesh>();
        for (const root of objects) {
            if (transform) this.transformSnaps.push({ obj: root, before: readTransform(root) });
            if (!geometry) continue;
            for (const mesh of meshesOf(root)) {
                if (seenMesh.has(mesh)) continue;
                seenMesh.add(mesh);
                this.objectSnaps.push({ mesh, geometry: mesh.geometry, material: mesh.material });
                this.vertexSnaps.push({ mesh, positions: (mesh.geometry.attributes.position.array as Float32Array).slice() });
            }
        }
    }

    /** The compact edit, or null when nothing changed. */
    finish(): LiveEdit | null {
        const verts: VertexDelta[] = [];
        const swaps: SwapDelta[] = [];
        for (const snap of this.objectSnaps) {
            const swap: SwapDelta = { mesh: snap.mesh };
            if (snap.mesh.geometry !== snap.geometry) swap.geometry = { before: snap.geometry, after: snap.mesh.geometry };
            if (snap.mesh.material !== snap.material) swap.material = { before: snap.material, after: snap.mesh.material };
            if (swap.geometry || swap.material) swaps.push(swap);
        }
        const swapped = new Set(swaps.filter(w => w.geometry).map(w => w.mesh));
        for (const { mesh, positions } of this.vertexSnaps) {
            if (swapped.has(mesh)) continue;
            const pos = mesh.geometry?.attributes?.position as THREE.BufferAttribute | undefined;
            if (!pos || pos.array.length !== positions.length) continue;
            const now = pos.array as Float32Array;
            const idx: number[] = [];
            for (let v = 0; v < pos.count; v++) {
                const o = v * 3;
                if (now[o] !== positions[o] || now[o + 1] !== positions[o + 1] || now[o + 2] !== positions[o + 2]) idx.push(v);
            }
            if (idx.length === 0) continue;
            const before = new Float32Array(idx.length * 3);
            const after = new Float32Array(idx.length * 3);
            idx.forEach((v, i) => {
                before.set(positions.subarray(v * 3, v * 3 + 3), i * 3);
                after.set(now.subarray(v * 3, v * 3 + 3), i * 3);
            });
            verts.push({ mesh, count: pos.count, indices: Uint32Array.from(idx), before, after });
        }
        const transforms: TransformDelta[] = [];
        for (const { obj, before } of this.transformSnaps) {
            const after = readTransform(obj);
            if (transformsDiffer(before, after)) transforms.push({ obj, before, after });
        }
        return verts.length === 0 && transforms.length === 0 && swaps.length === 0 ? null : new ObjectLiveEdit(verts, transforms, swaps);
    }
}

/** Replaced geometry (reset / switch shape): holds both sides, frees whichever can never be shown again. */
export function createGeometrySwapEdit(mesh: THREE.Mesh, before: THREE.BufferGeometry, after: THREE.BufferGeometry): LiveEdit {
    const bytesOf = (g: THREE.BufferGeometry) => Object.values(g.attributes).reduce((n, a) => n + (a as THREE.BufferAttribute).array.byteLength, 0) + (g.index?.array.byteLength ?? 0);
    let current: 'before' | 'after' = 'after';
    return {
        bytes: bytesOf(before) + bytesOf(after),
        revert() { mesh.geometry = before; current = 'before'; return true; },
        apply() { mesh.geometry = after; current = 'after'; return true; },
        dispose() { (current === 'after' ? before : after).dispose(); }
    };
}

// ---------------------------------------------------------------------------
// The generic entry: scene delta + live edit
// ---------------------------------------------------------------------------

export interface SceneEditTarget {
    /** Writes the (re)applied or reversed delta into the live scene data. */
    applyDelta(delta: SceneDelta, direction: 'apply' | 'revert', info: HistoryReplayInfo): void;
}

export interface SceneEditEntryInit {
    label: string;
    delta: SceneDelta | null;
    live?: LiveEdit | null;
    target: SceneEditTarget;
    selection?: HistoryEntry['selection'];
    /** Repeated tweaks of the same properties may fold into one entry. */
    mergeable?: boolean;
    /**
     * The live edit is what the step is (a sculpt stroke): when its objects are gone the whole entry is
     * dropped rather than half-applied. Otherwise the scene-data part still runs (a moved object whose
     * Three.js node was rebuilt is placed from the data).
     */
    requireLive?: boolean;
}

export class SceneEditEntry implements HistoryEntry {
    readonly label: string;
    readonly bytes: number;
    selection?: HistoryEntry['selection'];
    at?: number;
    readonly delta: SceneDelta | null;
    readonly live: LiveEdit | null;
    private readonly target: SceneEditTarget;
    private readonly mergeable: boolean;
    private readonly requireLive: boolean;

    constructor(init: SceneEditEntryInit) {
        this.label = init.label;
        this.delta = init.delta;
        this.live = init.live ?? null;
        this.target = init.target;
        this.selection = init.selection;
        this.mergeable = !!init.mergeable && !init.live;
        this.requireLive = !!init.requireLive;
        this.bytes = 96 + (init.delta ? sceneDeltaBytes(init.delta) : 0) + (this.live?.bytes ?? 0);
    }

    revert(info: HistoryReplayInfo): boolean {
        const liveOk = this.live ? this.live.revert() : true;
        if (this.requireLive && !liveOk) return false;
        if (this.delta) this.target.applyDelta(this.delta, 'revert', info);
        return this.delta ? true : liveOk;
    }

    apply(info: HistoryReplayInfo): boolean {
        const liveOk = this.live ? this.live.apply() : true;
        if (this.requireLive && !liveOk) return false;
        if (this.delta) this.target.applyDelta(this.delta, 'apply', info);
        return this.delta ? true : liveOk;
    }

    merge(later: HistoryEntry): HistoryEntry | null {
        if (!this.mergeable || !(later instanceof SceneEditEntry) || !later.mergeable || !this.delta || !later.delta) return null;
        if (!canMergeSceneDeltas(this.delta, later.delta)) return null;
        return new SceneEditEntry({
            label: this.label,
            delta: mergeSceneDeltas(this.delta, later.delta),
            target: this.target,
            selection: this.selection,
            mergeable: true
        });
    }

    dispose(): void {
        this.live?.dispose?.();
    }
}
