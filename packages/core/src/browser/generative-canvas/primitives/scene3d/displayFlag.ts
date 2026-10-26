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
