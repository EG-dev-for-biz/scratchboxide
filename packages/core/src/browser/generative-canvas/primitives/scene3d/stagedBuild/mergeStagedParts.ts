/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Merges a staged layer's many small parts into one mesh per material at load (viewport side). A pipeline E hero is
 * ~94 nodes of a few triangles each (vector massing, measured relief, photo-inferred and generated openings, scan
 * residual): ~99 draw calls for ~3.6 k triangles. Merged, it is one call per material (clay: 1; textured: one per atlas
 * page and tile photo).
 *
 * Provenance survives: every merged vertex carries its part index (`_sb_part`) and the mesh keeps a range table
 * (`userData.sbMergedParts`): per part, its node's name, its staged-node extras (provenance, ids, build order) and its
 * triangle and vertex ranges. The staged-build hook builds one node per part from the table, and the staged materials
 * take per-part looks (reveal fade, presence, degradation mark, provenance colour and pattern) from uniform arrays indexed
 * by `_sb_part` (revealMaterial.ts), so the reveal, the provenance view and the highlights draw part by part as before.
 * Picking resolves a hit to its part by triangle index (`stagedPartOfHit`), and a part the hook hides is not hit.
 *
 * Merged only when every mesh is a plain triangle mesh of a staged node (extras.sb, scratchbox.staged-node/2), none
 * carries per-vertex reveal timing (`_reveal`, `_disp`: their items stagger within the node) and there are at least
 * MIN_PARTS of them. Positions and normals are baked into the parent's frame, so the pixels are the same. Opt out with
 * `?sbMergeParts=0` or `localStorage['sb.mergeStagedParts'] = '0'` (before/after comparisons).
 */

import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { StagedNodeExtras } from '../../../../../common/spatial/staged-location-contracts';

/** The per-vertex part index (float; the shader rounds it). */
export const PART_ATTRIBUTE = '_sb_part';
/** Fewer parts than this are left as they are (nothing to gain). */
export const MIN_PARTS = 8;
/** Parts per merged mesh at most: the staged material keeps two vec4 uniforms per part (vertex-shader uniform room). */
export const MAX_PARTS_PER_MESH = 128;

const REVEAL_ATTRIBUTES = ['_reveal', '_disp'];

export interface MergedPart {
    /** Index in the merged mesh (the value of `_sb_part`). */
    index: number;
    /** The node's name (a surface or element id). */
    name: string;
    /** The node's staged-node extras: provenance, ids, build order. */
    sb: StagedNodeExtras['sb'];
    /** Triangles [triStart, triStart + triCount) of the merged index. */
    triStart: number;
    triCount: number;
    vertStart: number;
    vertCount: number;
}

export interface MergedPartTable {
    parts: MergedPart[];
    /** 1 where the part is drawn, 0 where the staged build hides it (it is then not picked either). */
    visible: Uint8Array;
    /** The merged index as built, kept once a part has been hidden (setPartVisibility collapses hidden parts' triangles). */
    fullIndex?: Uint16Array | Uint32Array;
}

/**
 * Shows or hides parts of a merged mesh with no shader work: a hidden part's triangles are collapsed in the index to
 * zero-area ones (the GPU rasterises nothing for them, they cast no shadow and a ray cannot hit them), and are written
 * back from the index as built when the part shows again. Triangle numbering is unchanged, so the range table still maps
 * a hit to its part. Returns how many parts changed.
 */
export function setPartVisibility(mesh: THREE.Mesh, visible: (index: number) => boolean): number {
    const table = mergedPartsOf(mesh);
    const index = (mesh.geometry as THREE.BufferGeometry).index;
    if (!table || !index) return 0;
    let changed = 0;
    const arr = index.array as Uint16Array | Uint32Array;
    for (const p of table.parts) {
        const want = visible(p.index) ? 1 : 0;
        if (table.visible[p.index] === want) continue;
        table.fullIndex ??= arr.slice();
        const from = p.triStart * 3, to = (p.triStart + p.triCount) * 3;
        if (want) arr.set(table.fullIndex.subarray(from, to), from);
        else for (let k = from; k < to; k += 3) { const a = arr[k]; arr[k + 1] = a; arr[k + 2] = a; }
        index.addUpdateRange(from, to - from);
        table.visible[p.index] = want;
        changed++;
    }
    if (changed > 0) index.needsUpdate = true;
    return changed;
}

export interface MergeReport { meshesBefore: number; meshesAfter: number; parts: number }

export function mergeStagedPartsEnabled(): boolean {
    try {
        if (typeof window === 'undefined') return true;
        if (/[?&]sbMergeParts=0\b/.test(window.location?.search ?? '')) return false;
        return window.localStorage?.getItem('sb.mergeStagedParts') !== '0';
    } catch {
        return true;
    }
}

export function mergedPartsOf(o: THREE.Object3D | null | undefined): MergedPartTable | undefined {
    const t = (o?.userData as { sbMergedParts?: MergedPartTable } | undefined)?.sbMergedParts;
    return t && Array.isArray(t.parts) ? t : undefined;
}

function stagedExtrasOf(o: THREE.Object3D): StagedNodeExtras['sb'] | undefined {
    const sb = (o.userData as { sb?: StagedNodeExtras['sb'] })?.sb;
    return sb && sb.schema === 'scratchbox.staged-node/2' ? sb : undefined;
}

function attributeSignature(g: THREE.BufferGeometry): string {
    return Object.keys(g.attributes).sort().map(k => {
        const a = g.attributes[k] as THREE.BufferAttribute;
        return `${k}:${a.itemSize}:${a.normalized ? 1 : 0}:${(a.array as { constructor: { name: string } }).constructor.name}:${(a as unknown as THREE.InterleavedBufferAttribute).isInterleavedBufferAttribute ? 'i' : ''}`;
    }).join('|');
}

/** The part a triangle of a merged mesh belongs to (binary search on the ranges). */
export function partAtTriangle(table: MergedPartTable, tri: number): MergedPart | undefined {
    let lo = 0, hi = table.parts.length - 1;
    while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        const p = table.parts[mid];
        if (tri < p.triStart) hi = mid - 1;
        else if (tri >= p.triStart + p.triCount) lo = mid + 1;
        else return p;
    }
    return undefined;
}

export interface StagedPartHit {
    /** The node's name. */
    name: string;
    /** The provenance label it is shaded by. */
    label?: string;
    ids?: StagedNodeExtras['sb']['ids'];
    sb?: StagedNodeExtras['sb'];
    /** Part index inside a merged mesh (undefined for a node drawn by its own mesh). */
    partIndex?: number;
}

/**
 * The staged part a raycast hit is on: by triangle index in a merged mesh, else the nearest ancestor with staged-node
 * extras. Undefined for anything that is not part of a staged layer.
 */
export function stagedPartOfHit(hit: Pick<THREE.Intersection, 'object' | 'faceIndex'>): StagedPartHit | undefined {
    const table = mergedPartsOf(hit.object);
    if (table) {
        const p = hit.faceIndex !== undefined && hit.faceIndex !== null ? partAtTriangle(table, hit.faceIndex) : undefined;
        return p ? { name: p.name, label: p.sb.provenance?.label, ids: p.sb.ids, sb: p.sb, partIndex: p.index } : undefined;
    }
    for (let o: THREE.Object3D | null = hit.object; o; o = o.parent) {
        const sb = stagedExtrasOf(o);
        if (sb) return { name: o.name, label: sb.provenance?.label, ids: sb.ids, sb };
    }
    return undefined;
}

/** Hits on parts the staged build hides are dropped; each kept hit names its part (`sbPart`). */
function partAwareRaycast(this: THREE.Mesh, raycaster: THREE.Raycaster, intersects: THREE.Intersection[]): void {
    const start = intersects.length;
    THREE.Mesh.prototype.raycast.call(this, raycaster, intersects);
    const table = mergedPartsOf(this);
    if (!table) return;
    for (let i = intersects.length - 1; i >= start; i--) {
        const h = intersects[i];
        const p = h.faceIndex !== undefined && h.faceIndex !== null ? partAtTriangle(table, h.faceIndex) : undefined;
        if (!p || !table.visible[p.index]) { intersects.splice(i, 1); continue; }
        (h as THREE.Intersection & { sbPart?: StagedPartHit }).sbPart = { name: p.name, label: p.sb.provenance?.label, ids: p.sb.ids, sb: p.sb, partIndex: p.index };
    }
}

interface Candidate { mesh: THREE.Mesh; node: THREE.Object3D; sb: StagedNodeExtras['sb'] }

/**
 * Merges the staged parts under `root` per material (in place). Returns what it did, or undefined when the model is not
 * eligible (see the header) and was left untouched.
 */
export function mergeStagedParts(root: THREE.Object3D): MergeReport | undefined {
    const candidates: Candidate[] = [];
    let eligible = true;
    root.updateMatrixWorld(true);
    root.traverse(o => {
        if (!eligible) return;
        if ((o.userData as { sbTree?: unknown })?.sbTree) { eligible = false; return; }
        const m = o as THREE.Mesh;
        if ((o as THREE.Line).isLine || (o as THREE.Points).isPoints) { eligible = false; return; }
        if (!m.isMesh) return;
        if ((m as THREE.InstancedMesh).isInstancedMesh || (m as THREE.SkinnedMesh).isSkinnedMesh || Array.isArray(m.material) || !m.geometry) { eligible = false; return; }
        const g = m.geometry as THREE.BufferGeometry;
        if (Object.keys(g.morphAttributes).length > 0 || REVEAL_ATTRIBUTES.some(a => g.getAttribute(a)) || g.groups.length > 1 || !g.getAttribute('position')) { eligible = false; return; }
        if ((m as THREE.Mesh & { drawMode?: number }).drawMode !== undefined && (m as THREE.Mesh & { drawMode?: number }).drawMode !== THREE.TrianglesDrawMode) { eligible = false; return; }
        let node: THREE.Object3D | undefined;
        for (let p: THREE.Object3D | null = m; p && p !== root; p = p.parent) if (stagedExtrasOf(p)) { node = p; break; }
        if (!node || !m.parent) { eligible = false; return; }
        candidates.push({ mesh: m, node, sb: stagedExtrasOf(node)! });
    });
    if (!eligible || candidates.length < MIN_PARTS) return undefined;

    // Groups: one material and attribute layout, under the nearest common container (the meshes' parent above their node).
    const containerOf = (c: Candidate): THREE.Object3D => (c.node === c.mesh ? c.mesh.parent! : c.node.parent ?? root);
    const groups = new Map<string, Candidate[]>();
    for (const c of candidates) {
        const key = [(c.mesh.material as THREE.Material).uuid, attributeSignature(c.mesh.geometry as THREE.BufferGeometry), !!(c.mesh.geometry as THREE.BufferGeometry).index,
            c.mesh.castShadow, c.mesh.receiveShadow, c.mesh.frustumCulled, c.mesh.renderOrder, !!c.mesh.userData.sbKeepAuthoredMaterial, containerOf(c).uuid].join('#');
        (groups.get(key) ?? groups.set(key, []).get(key)!).push(c);
    }
    // First every merged geometry (nothing in the scene changes if one cannot be made), then the swap.
    const built: Array<{ geometry: THREE.BufferGeometry; first: THREE.Mesh; container: THREE.Object3D; table: MergedPartTable }> = [];
    const inverse = new THREE.Matrix4();
    const local = new THREE.Matrix4();
    for (const list of groups.values()) {
        const container = containerOf(list[0]);
        inverse.copy(container.matrixWorld).invert();
        for (let start = 0; start < list.length; start += MAX_PARTS_PER_MESH) {
            const chunk = list.slice(start, start + MAX_PARTS_PER_MESH);
            const geoms: THREE.BufferGeometry[] = [];
            const parts: MergedPart[] = [];
            let tri = 0, vert = 0;
            chunk.forEach((c, k) => {
                // a copy in the container's frame (a geometry two nodes share is baked once per node)
                const baked = (c.mesh.geometry as THREE.BufferGeometry).clone();
                local.multiplyMatrices(inverse, c.mesh.matrixWorld);
                if (!isIdentity(local)) baked.applyMatrix4(local);
                const count = baked.getAttribute('position').count;
                baked.setAttribute(PART_ATTRIBUTE, new THREE.BufferAttribute(new Float32Array(count).fill(k), 1));
                const triCount = Math.floor((baked.index ? baked.index.count : count) / 3);
                parts.push({ index: k, name: c.node.name, sb: c.sb, triStart: tri, triCount, vertStart: vert, vertCount: count });
                tri += triCount; vert += count;
                geoms.push(baked);
            });
            const merged = mergeGeometries(geoms, false);
            geoms.forEach(g => g.dispose());
            if (!merged) {
                built.forEach(b => b.geometry.dispose());
                return undefined;
            }
            merged.computeBoundingSphere();
            merged.computeBoundingBox();
            built.push({ geometry: merged, first: chunk[0].mesh, container, table: { parts, visible: new Uint8Array(parts.length).fill(1) } });
        }
    }
    built.forEach((b, i) => {
        const mesh = new THREE.Mesh(b.geometry, b.first.material);
        mesh.name = `sb-merged-parts-${i}`;
        mesh.castShadow = b.first.castShadow;
        mesh.receiveShadow = b.first.receiveShadow;
        mesh.frustumCulled = b.first.frustumCulled;
        mesh.renderOrder = b.first.renderOrder;
        mesh.userData = { ...(b.first.userData.sbKeepAuthoredMaterial ? { sbKeepAuthoredMaterial: true } : {}), sbMergedParts: b.table };
        mesh.raycast = partAwareRaycast;
        b.container.add(mesh);
    });
    const meshesAfter = built.length;
    // The originals go: their nodes' meshes (a node that is only a mesh goes whole; a node that is a group keeps its empty frame).
    for (const c of candidates) {
        c.mesh.parent?.remove(c.mesh);
        (c.mesh.geometry as THREE.BufferGeometry).dispose();
    }
    return { meshesBefore: candidates.length, meshesAfter, parts: candidates.length };
}

function isIdentity(m: THREE.Matrix4): boolean {
    const e = m.elements;
    const id = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    for (let i = 0; i < 16; i++) if (Math.abs(e[i] - id[i]) > 1e-12) return false;
    return true;
}
