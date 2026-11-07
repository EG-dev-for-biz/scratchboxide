/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The parts of the loaded models, read from what each model carries (see common/spatial/model-parts-view.ts), grouped by
 * the extras that identify them: a mesh under a node with `sbFacadeLattice` is a rebuilt facade, one under a staged
 * node (`sb`, scratchbox.staged-node/2) a staged part grouped by its provenance label, one whose material names an
 * object build's part (`scratchbox.partId`) a part of the object, a merged staged mesh (mergeStagedParts.ts) one part
 * per row of its table, and a mesh with none of these a mesh, grouped by any other `sb*` key it carries. The vocabulary
 * is open: a key this file does not know still makes a group, named from the key.
 *
 * The overlay (ModelPartsOverlay) draws each part in its own flat colour over the model and brightens the highlighted
 * one; visibility goes to the meshes themselves (a merged part's triangles collapsed, setPartVisibility), so a hidden
 * part casts no shadow and is not picked.
 */

import * as THREE from 'three';
import { mergedPartsOf, setPartVisibility, type MergedPart } from './stagedBuild/mergeStagedParts';
import { partShown, type ModelPartsViewConfig } from '../../../../common/spatial/model-parts-view';

export interface ModelPartProvenance { label: string; confidence?: number; method?: string }

export interface ModelPart {
    /** Stable within a load: the root's name, the node's uuid and, in a merged mesh, the part's index. */
    key: string;
    label: string;
    /** The group key: the extras key that identified the part (`sbFacadeLattice`, `staged:measured`, `objectPart`, `mesh`, ...). */
    group: string;
    colour: string;
    triangles: number;
    provenance?: ModelPartProvenance;
    /** A line about the part from its extras (a facade's measured share and windows, a seal's routes, a part's material). */
    detail?: string;
    node: THREE.Object3D;
    mesh: THREE.Mesh;
    /** A row of a merged staged mesh: its triangles are the table's range, not a mesh of its own. */
    merged?: { mesh: THREE.Mesh; index: number; triStart: number; triCount: number };
    /** The extras the part was read from, for the readout. */
    extras?: Record<string, unknown>;
}

export interface ModelPartGroup { key: string; label: string; colour: string; parts: ModelPart[]; triangles: number }

/** Names for the extras keys the pipelines write; any other key is named from itself (humanise). */
const GROUP_LABELS: Record<string, string> = {
    sbFacadeLattice: 'Rebuilt facades',
    sbBaseSkirt: 'Base skirt',
    sbSeal: 'Seal and infill',
    sbTree: 'Trees',
    sbLatticeCut: 'Scan, cut at the facades',
    sbFootprintClip: 'Scan, clipped to the footprint',
    objectPart: 'Object parts',
    decal: 'Decals',
    mesh: 'Meshes'
};

/** A group key from an extras key or a staged provenance label. */
export function groupLabel(key: string): string {
    if (GROUP_LABELS[key]) return GROUP_LABELS[key];
    if (key.startsWith('staged:')) return `Staged, ${key.slice(7)}`;
    return humanise(key.replace(/^sb(?=[A-Z])/, ''));
}

function humanise(s: string): string {
    const words = s.replace(/[_-]+/g, ' ').replace(/([a-z0-9])([A-Z])/g, '$1 $2').trim();
    return words ? words[0].toUpperCase() + words.slice(1).toLowerCase() : s;
}

/** Twelve hues around the wheel; a group takes one by its order, its parts shades of it. */
export const PART_HUES = [205, 30, 140, 280, 60, 350, 175, 100, 320, 20, 240, 80] as const;

function hsl(h: number, s: number, l: number): string {
    return `hsl(${Math.round(h)}, ${Math.round(s)}%, ${Math.round(l)}%)`;
}

function hash(s: string): number {
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
    return h >>> 0;
}

function trianglesOf(g: THREE.BufferGeometry | undefined): number {
    if (!g) return 0;
    const pos = g.getAttribute('position');
    return g.index ? Math.floor(g.index.count / 3) : pos ? Math.floor(pos.count / 3) : 0;
}

const r2 = (v: number) => Math.round(v * 100) / 100;

interface Identity { group: string; node: THREE.Object3D; extras?: Record<string, unknown>; provenance?: ModelPartProvenance; detail?: string; label?: string }

/** A provenance record from the shapes the pipelines write ({label, confidence?, method?} or a label string). */
function provenanceOf(v: unknown): ModelPartProvenance | undefined {
    if (typeof v === 'string') return { label: v };
    if (v && typeof v === 'object') {
        const p = v as { label?: unknown; confidence?: unknown; method?: unknown; lines?: unknown; texture?: unknown; depth?: unknown };
        if (typeof p.label === 'string') return { label: p.label, ...(typeof p.confidence === 'number' ? { confidence: p.confidence } : {}), ...(typeof p.method === 'string' ? { method: p.method } : {}) };
        // a facade's provenance per aspect: lines, depth, texture
        const parts = (['lines', 'depth', 'texture'] as const).map(k => (typeof p[k] === 'string' ? `${k} ${p[k]}` : typeof (p[k] as { label?: unknown })?.label === 'string' ? `${k} ${(p[k] as { label: string }).label}` : undefined)).filter((x): x is string => !!x);
        if (parts.length) return { label: parts.join(', ') };
    }
    return undefined;
}

/** What a mesh is, from its own, its ancestors' (up to the root), its geometry's and its material's extras. */
function identify(mesh: THREE.Mesh, root: THREE.Object3D): Identity {
    const geo = mesh.geometry?.userData as Record<string, unknown> | undefined;
    const mats = Array.isArray(mesh.material) ? mesh.material : mesh.material ? [mesh.material] : [];
    const matData = mats[0]?.userData as Record<string, unknown> | undefined;
    const chain: THREE.Object3D[] = [];
    for (let o: THREE.Object3D | null = mesh; o && o !== root; o = o.parent) chain.push(o);
    // the nearest ancestor with a known extras key wins; among its keys the pipelines' first
    for (const o of chain) {
        const u = o.userData as Record<string, unknown>;
        if (u.sbFacadeLattice && typeof u.sbFacadeLattice === 'object') {
            const f = u.sbFacadeLattice as { facadeId?: unknown; measuredShare?: unknown; windows?: { uv?: number[]; panes?: number[] }; provenance?: unknown; cells?: unknown };
            const windows = Array.isArray(f.windows?.uv) ? Math.floor(f.windows!.uv!.length / 4) : 0;
            const parts = [typeof f.measuredShare === 'number' ? `${Math.round(f.measuredShare * 100)}% measured` : undefined, windows ? `${windows} windows` : undefined, Array.isArray(f.windows?.panes) && f.windows!.panes!.length ? `${Math.floor(f.windows!.panes!.length / 4)} panes` : undefined].filter(Boolean);
            return { group: 'sbFacadeLattice', node: o, extras: f as Record<string, unknown>, provenance: provenanceOf(f.provenance), detail: parts.join(' · ') || undefined, label: f.facadeId !== undefined ? `Facade ${f.facadeId}` : undefined };
        }
        if (u.sbBaseSkirt && typeof u.sbBaseSkirt === 'object') {
            const b = u.sbBaseSkirt as { provenance?: unknown };
            return { group: 'sbBaseSkirt', node: o, extras: b as Record<string, unknown>, provenance: provenanceOf(b.provenance) };
        }
        if (u.sbSeal && typeof u.sbSeal === 'object') {
            const s = u.sbSeal as { provenance?: unknown; routes?: Array<{ label?: string; pieces?: number }>; wallInfill?: unknown };
            const routes = Array.isArray(s.routes) ? s.routes.map(r => `${r.label ?? '?'}${typeof r.pieces === 'number' ? ` ×${r.pieces}` : ''}`).join(', ') : undefined;
            return { group: 'sbSeal', node: o, extras: s as Record<string, unknown>, provenance: provenanceOf(s.provenance), detail: routes };
        }
        if (u.sbTree) return { group: 'sbTree', node: o, extras: typeof u.sbTree === 'object' ? (u.sbTree as Record<string, unknown>) : undefined };
        const sb = u.sb as { schema?: unknown; provenance?: unknown; ids?: Record<string, unknown>; stage?: unknown } | undefined;
        if (sb && sb.schema === 'scratchbox.staged-node/2') {
            const p = provenanceOf(sb.provenance);
            return { group: `staged:${p?.label ?? 'unlabelled'}`, node: o, extras: sb as Record<string, unknown>, provenance: p, detail: typeof sb.stage === 'string' ? sb.stage : undefined };
        }
    }
    if (geo?.sbLatticeCut) return { group: 'sbLatticeCut', node: mesh, extras: geo.sbLatticeCut as Record<string, unknown>, provenance: provenanceOf((geo.sbLatticeCut as { provenance?: unknown }).provenance) };
    if (geo?.sbFootprintClip) return { group: 'sbFootprintClip', node: mesh, extras: geo.sbFootprintClip as Record<string, unknown>, provenance: provenanceOf((geo.sbFootprintClip as { provenance?: unknown }).provenance) };
    const obj = matData?.scratchbox as { partId?: unknown; provenance?: unknown; description?: unknown } | undefined;
    if (obj && typeof obj.partId === 'string') {
        const mat = mats[0] as THREE.MeshStandardMaterial;
        const look = mat && 'roughness' in mat ? `roughness ${r2(mat.roughness)}, metalness ${r2(mat.metalness)}` : undefined;
        return { group: 'objectPart', node: mesh, extras: obj as Record<string, unknown>, provenance: provenanceOf(obj.provenance), detail: [typeof obj.description === 'string' ? obj.description : undefined, look].filter(Boolean).join(' · ') || undefined, label: obj.partId };
    }
    for (const o of chain) if ((o.userData as { decal?: unknown }).decal === true) return { group: 'decal', node: o };
    // any other extras a pipeline wrote (an `sb*` key holding a record with a provenance, version or schema) names the
    // group; the viewer's own hooks on userData (meshes, functions, flags) do not
    for (const o of chain) {
        const k = Object.keys(o.userData).filter(key => /^sb[A-Z]/.test(key) && isPipelineExtras(o.userData[key])).sort()[0];
        if (k) { const x = o.userData[k] as Record<string, unknown>; return { group: k, node: o, extras: x, provenance: provenanceOf(x.provenance) }; }
    }
    return { group: 'mesh', node: mesh };
}

/** A record a pipeline wrote into the file (its extras carry a provenance, a version or a schema), not a viewer hook. */
function isPipelineExtras(v: unknown): v is Record<string, unknown> {
    if (!v || typeof v !== 'object' || Array.isArray(v) || (v as { isObject3D?: unknown }).isObject3D) return false;
    const r = v as Record<string, unknown>;
    return 'provenance' in r || 'version' in r || 'schema' in r;
}

function rootName(root: THREE.Object3D): string {
    return root.name || root.uuid;
}

/** The parts of the given roots (the loaded models), grouped; groups in first-seen order, parts in traversal order. */
export function collectModelParts(roots: THREE.Object3D[]): ModelPartGroup[] {
    const groups = new Map<string, ModelPartGroup>();
    const groupOf = (key: string): ModelPartGroup => {
        let g = groups.get(key);
        if (!g) { g = { key, label: groupLabel(key), colour: hsl(PART_HUES[groups.size % PART_HUES.length], 70, 55), parts: [], triangles: 0 }; groups.set(key, g); }
        return g;
    };
    const add = (part: Omit<ModelPart, 'colour'>) => {
        const g = groupOf(part.group);
        const hue = PART_HUES[[...groups.keys()].indexOf(part.group) % PART_HUES.length];
        const n = g.parts.length;
        // shades of the group's hue, spread by the part's key so neighbours differ
        const colour = hsl(hue + ((hash(part.key) % 25) - 12), 55 + (n % 3) * 12, 42 + ((hash(part.key) >> 8) % 28));
        g.parts.push({ ...part, colour });
        g.triangles += part.triangles;
    };
    for (const root of roots) {
        const rn = rootName(root);
        root.traverse(o => {
            const mesh = o as THREE.Mesh;
            if (!mesh.isMesh || !mesh.geometry) return;
            if ((o.userData as { sbOverlay?: unknown }).sbOverlay) return;
            const table = mergedPartsOf(mesh);
            if (table) {
                for (const p of table.parts) {
                    const prov = provenanceOf(p.sb?.provenance);
                    add({ key: `${rn}/${mesh.uuid}#${p.index}`, label: p.name, group: `staged:${prov?.label ?? 'unlabelled'}`, triangles: p.triCount, provenance: prov, detail: typeof p.sb?.stage === 'string' ? p.sb.stage : undefined, node: mesh, mesh, merged: { mesh, index: p.index, triStart: p.triStart, triCount: p.triCount }, extras: p.sb as unknown as Record<string, unknown> });
                }
                return;
            }
            const id = identify(mesh, root);
            add({ key: `${rn}/${mesh.uuid}`, label: id.label ?? id.node.name ?? mesh.name ?? 'mesh', group: id.group, triangles: trianglesOf(mesh.geometry as THREE.BufferGeometry), provenance: id.provenance, detail: id.detail, node: id.node, mesh, extras: id.extras });
        });
    }
    return [...groups.values()];
}

export function partByKey(groups: ModelPartGroup[], key: string | undefined): ModelPart | undefined {
    if (!key) return undefined;
    for (const g of groups) for (const p of g.parts) if (p.key === key) return p;
    return undefined;
}

/**
 * Shows and hides the parts as the config says, and returns the keys it hid (restored by applyModelPartsView with a
 * config that shows them, or by restoreModelParts). A merged part's triangles are collapsed in its mesh's index.
 */
export function applyModelPartsView(groups: ModelPartGroup[], cfg: Pick<ModelPartsViewConfig, 'hidden' | 'solo'> | undefined): string[] {
    const hidden: string[] = [];
    const merged = new Map<THREE.Mesh, Map<number, boolean>>();
    for (const g of groups) for (const p of g.parts) {
        const shown = partShown(cfg, p.key);
        if (!shown) hidden.push(p.key);
        if (p.merged) (merged.get(p.merged.mesh) ?? merged.set(p.merged.mesh, new Map()).get(p.merged.mesh)!).set(p.merged.index, shown);
        else p.mesh.visible = shown;
    }
    for (const [mesh, want] of merged) setPartVisibility(mesh, i => want.get(i) ?? true);
    return hidden;
}

/** Every part shown again (the view turned off). */
export function restoreModelParts(groups: ModelPartGroup[]): void {
    applyModelPartsView(groups, undefined);
}

/** The part a ray hits first, among the parts' meshes (a merged mesh's hit names its part through partAwareRaycast). */
export function pickModelPart(raycaster: THREE.Raycaster, groups: ModelPartGroup[]): ModelPart | undefined {
    const meshes = new Set<THREE.Mesh>();
    for (const g of groups) for (const p of g.parts) if (p.mesh.visible) meshes.add(p.mesh);
    const hits = raycaster.intersectObjects([...meshes], false);
    for (const h of hits) {
        const sbPart = (h as THREE.Intersection & { sbPart?: { partIndex?: number } }).sbPart;
        const table = mergedPartsOf(h.object);
        if (table) {
            const index = sbPart?.partIndex ?? partIndexAt(table.parts, h.faceIndex ?? -1);
            if (index === undefined) continue;
            for (const g of groups) for (const p of g.parts) if (p.merged && p.merged.mesh === h.object && p.merged.index === index) return p;
            continue;
        }
        for (const g of groups) for (const p of g.parts) if (!p.merged && p.mesh === h.object) return p;
    }
    return undefined;
}

function partIndexAt(parts: MergedPart[], tri: number): number | undefined {
    for (const p of parts) if (tri >= p.triStart && tri < p.triStart + p.triCount) return p.index;
    return undefined;
}

export const PARTS_OVERLAY_ROOT = 'sb-parts-overlay';
const TINT_OPACITY = 0.45, HIGHLIGHT_OPACITY = 0.85, DIMMED_OPACITY = 0.2;

/**
 * The flat-colour overlay: one mesh per part sharing the part's geometry (a merged part: its triangles' index over the
 * mesh's attributes), drawn over the model with a polygon offset. Overlays never dispose a geometry: the attributes are
 * the model's own.
 */
export class ModelPartsOverlay {
    readonly root = new THREE.Group();
    private readonly meshes = new Map<string, { mesh: THREE.Mesh; part: ModelPart }>();

    constructor(private readonly scene: THREE.Scene) {
        this.root.name = PARTS_OVERLAY_ROOT;
        this.root.userData.sbOverlay = true;
        this.root.renderOrder = 10;
        scene.add(this.root);
    }

    /** The overlay meshes for the parts (new ones made, gone ones dropped), then every one's visibility and opacity. */
    sync(groups: ModelPartGroup[], view: { tint: boolean; cfg: Pick<ModelPartsViewConfig, 'hidden' | 'solo'> | undefined; highlight?: string }): void {
        const wanted = new Map<string, ModelPart>();
        for (const g of groups) for (const p of g.parts) wanted.set(p.key, p);
        for (const [key, e] of this.meshes) if (!wanted.has(key)) { this.root.remove(e.mesh); (e.mesh.material as THREE.Material).dispose(); this.meshes.delete(key); }
        for (const [key, part] of wanted) {
            let e = this.meshes.get(key);
            if (!e) {
                const mat = new THREE.MeshBasicMaterial({ color: new THREE.Color(part.colour), transparent: true, opacity: TINT_OPACITY, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2, side: THREE.DoubleSide, toneMapped: false });
                const mesh = new THREE.Mesh(part.merged ? subGeometry(part.merged) : part.mesh.geometry, mat);
                mesh.name = `sb-parts-overlay:${part.label}`;
                mesh.userData.sbOverlay = true;
                mesh.matrixAutoUpdate = false;
                mesh.raycast = () => undefined;
                mesh.castShadow = false; mesh.receiveShadow = false; mesh.frustumCulled = false;
                e = { mesh, part };
                this.meshes.set(key, e);
                this.root.add(mesh);
            }
            e.mesh.matrix.copy(part.mesh.matrixWorld);
            const shown = partShown(view.cfg, key);
            const lit = view.highlight === key;
            e.mesh.visible = shown && (view.tint || lit);
            (e.mesh.material as THREE.MeshBasicMaterial).opacity = lit ? HIGHLIGHT_OPACITY : view.highlight ? DIMMED_OPACITY : TINT_OPACITY;
        }
    }

    dispose(): void {
        for (const e of this.meshes.values()) { this.root.remove(e.mesh); (e.mesh.material as THREE.Material).dispose(); }
        this.meshes.clear();
        this.scene.remove(this.root);
    }
}

/** A merged part's triangles as a geometry over the mesh's own attributes (shared, never disposed here). */
function subGeometry(m: NonNullable<ModelPart['merged']>): THREE.BufferGeometry {
    const src = m.mesh.geometry as THREE.BufferGeometry;
    const g = new THREE.BufferGeometry();
    for (const [name, attr] of Object.entries(src.attributes)) g.setAttribute(name, attr as THREE.BufferAttribute);
    const table = mergedPartsOf(m.mesh);
    const full = table?.fullIndex ?? (src.index?.array as Uint16Array | Uint32Array | undefined);
    if (full) g.setIndex(new THREE.BufferAttribute(full.slice(m.triStart * 3, (m.triStart + m.triCount) * 3), 1));
    g.boundingSphere = src.boundingSphere;
    return g;
}
