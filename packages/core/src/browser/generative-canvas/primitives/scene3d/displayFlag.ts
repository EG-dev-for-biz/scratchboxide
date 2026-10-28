/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The viewport side of the node graph's display flag (Scene3DData.displayFlag): while a node holds the flag only what
 * it made is drawn; the rest is hidden, not removed, and comes back as it was when the flag is cleared. Hiding is on
 * object roots, custom meshes and the compiled model's parts, never on the meshes the staged reveal drives, so the
 * two never fight over a mesh's visibility.
 */

import * as THREE from 'three';
import type { SceneDisplayFlag } from '../../canvas-types';

const HIDDEN_BY_FLAG = 'sbHiddenByDisplayFlag';

function hide(o: THREE.Object3D): void {
    if (o.visible) { o.visible = false; o.userData[HIDDEN_BY_FLAG] = true; }
}

function restore(o: THREE.Object3D): void {
    if (o.userData[HIDDEN_BY_FLAG]) { o.visible = true; delete o.userData[HIDDEN_BY_FLAG]; }
}

/** Within the compiled model: the named parts and what they contain stay, every other mesh is hidden. */
function showParts(root: THREE.Object3D, names: ReadonlySet<string>): void {
    const keep = new Set<THREE.Object3D>();
    root.traverse(o => {
        if (!names.has(o.name)) return;
        o.traverse(c => keep.add(c));
        // and the path down to it: a group the flag hid before (the whole model, under another flag) shows again
        for (let p = o.parent; p; p = p === root ? null : p.parent) keep.add(p);
    });
    root.traverse(o => {
        if (keep.has(o)) { restore(o); return; }
        if ((o as THREE.Mesh).isMesh) hide(o);
    });
}

export interface DisplayFlagTargets {
    /** Scene objects by id (staged layers, placed models). */
    objectRoots: ReadonlyMap<string, THREE.Object3D>;
    /** customMeshes by id. */
    meshes: ReadonlyMap<string, { mesh: THREE.Object3D }>;
    /** The compiled model's root, when the scene has one. */
    compiledRoot?: THREE.Object3D;
}

/**
 * Applies the flag (or its absence) to what is loaded now; cheap enough to run every frame, so objects that load
 * after the flag was set follow it too. Returns how many objects the flag hides, for the viewport badge.
 */
export function applyDisplayFlag(flag: SceneDisplayFlag | undefined, t: DisplayFlagTargets): number {
    let hidden = 0;
    const objectSet = flag?.objectIds ? new Set(flag.objectIds) : undefined;
    const meshSet = flag?.meshIds ? new Set(flag.meshIds) : undefined;
    const partSet = flag?.partNames ? new Set(flag.partNames) : undefined;
    for (const [id, root] of t.objectRoots) {
        if (flag && !objectSet?.has(id)) { hide(root); hidden++; } else restore(root);
    }
    for (const [id, entry] of t.meshes) {
        if (flag && !meshSet?.has(id)) { hide(entry.mesh); hidden++; } else restore(entry.mesh);
    }
    if (t.compiledRoot) {
        if (partSet) showParts(t.compiledRoot, partSet);
        else if (flag) { hide(t.compiledRoot); hidden++; }
        else { restore(t.compiledRoot); t.compiledRoot.traverse(restore); }
    }
    return hidden;
}

/**
 * A build step's snapshot (SceneDisplayFlag.snapshot): loaded while the flag holds it, drawn in the frame of the first
 * loaded layer it shares a scan frame with, and released when the flag moves on.
 */
export class StepSnapshotView {
    private url?: string;
    private root?: THREE.Object3D;
    private loading?: string;

    constructor(private readonly load: (url: string) => Promise<THREE.Object3D>) {}

    /** Every frame: follows the flag, and keeps the snapshot on its frame's layer (which may move or load late). */
    sync(flag: SceneDisplayFlag | undefined, scene: THREE.Scene | undefined, objectRoots: ReadonlyMap<string, THREE.Object3D>): void {
        const want = flag?.snapshot?.url;
        if (want !== this.url) {
            this.release();
            this.url = want;
            if (want) {
                this.loading = want;
                this.load(want).then(root => {
                    if (this.loading !== want || this.url !== want) { disposeTree(root); return; }
                    this.loading = undefined;
                    root.matrixAutoUpdate = false;
                    root.name = 'sbStepSnapshot';
                    this.root = root;
                    scene?.add(root);
                }).catch(err => {
                    if (this.loading === want) this.loading = undefined;
                    console.warn(`[display flag] the step snapshot ${want} did not load:`, err);
                });
            }
        }
        if (!this.root || !flag?.snapshot) return;
        const frame = flag.snapshot.frameOf.map(id => objectRoots.get(id)).find(Boolean);
        if (frame) { frame.updateWorldMatrix(true, false); this.root.matrix.copy(frame.matrixWorld); this.root.matrixWorldNeedsUpdate = true; }
    }

    release(): void {
        this.loading = undefined;
        if (this.root) { this.root.parent?.remove(this.root); disposeTree(this.root); this.root = undefined; }
        this.url = undefined;
    }
}

function disposeTree(root: THREE.Object3D): void {
    root.traverse(o => {
        const m = o as THREE.Mesh;
        if (!m.isMesh) return;
        m.geometry?.dispose();
        for (const mat of Array.isArray(m.material) ? m.material : [m.material]) {
            if (!mat) continue;
            for (const v of Object.values(mat)) if (v instanceof THREE.Texture) v.dispose();
            mat.dispose();
        }
    });
}
