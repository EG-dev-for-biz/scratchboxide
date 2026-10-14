/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import * as THREE from 'three';

/**
 * Root groups of models loaded from `Scene3DData.objects[]` are named `${prefix}${object.id}`.
 * They are containers (like the procedural collection groups below), so picking resolves to the
 * named parts inside them rather than to the whole file.
 */
export const EXTERNAL_OBJECT_ROOT_PREFIX = 'external-object-';

/** Group names that only bundle independent entities and are therefore never selected as a whole. */
const COLLECTION_GROUP_NAMES = new Set([
    'historical-battlefield', 'procedural-city', 'procedural-scene', 'solar-system', 'molecular-physics',
    'architectural-room', 'procedural-worldbuilder', 'procedural-spatial'
]);

const isCollectionGroupName = (name: string): boolean =>
    COLLECTION_GROUP_NAMES.has(name) || name.startsWith(EXTERNAL_OBJECT_ROOT_PREFIX);

export interface SceneOutlinerItem { id: string; name: string; type: string; object: THREE.Object3D; visible: boolean }

/**
 * Resolves the selectable entity for a raycast hit: the top-most named ancestor below the scene root,
 * skipping collection groups (procedural bundles and loaded-model roots).
 */
export function resolveSelectableObject(hitObject: THREE.Object3D, sceneRoot: THREE.Object3D): THREE.Object3D {
    let current: THREE.Object3D = hitObject;
    let selectable: THREE.Object3D = hitObject;

    while (current && current.parent && current.parent !== sceneRoot) {
        const pName = current.parent.name || '';
        if (pName && !pName.startsWith('sb-') && pName !== 'scene' && !isCollectionGroupName(pName)) {
            selectable = current.parent;
        }
        current = current.parent;
    }

    return selectable;
}

/**
 * Extracts all selectable objects in the Three.js scene for the Outliner: direct scene children plus
 * the direct children of collection groups (including the parts of loaded models).
 */
export function extractSceneOutlinerItems(scene: THREE.Scene): SceneOutlinerItem[] {
    const items: SceneOutlinerItem[] = [];
    const seenUuids = new Set<string>();

    const isExcluded = (obj: THREE.Object3D): boolean => {
        if (obj === scene) return true;
        const oName = obj.name || '';
        if (oName.startsWith('sb-') || COLLECTION_GROUP_NAMES.has(oName)) return true;
        if (oName === 'AtmosphericSkyDome' || oName === 'PhysicalSunDisc' || oName === 'volumetric-god-rays' || oName.includes('SkyDome') || oName.includes('SunDisc') || oName.includes('god-rays')) return true;
        if (obj.userData?.isGizmo || obj.userData?.handleType) return true;
        if ((obj as any).isLight || (obj as any).isCamera) return true;
        if ((obj as any).isGridHelper || oName.includes('Grid Floor') || oName.includes('GridHelper')) return true;
        return false;
    };

    scene.traverse((obj) => {
        if (isExcluded(obj)) return;

        const p = obj.parent;
        const isRootChild = p === scene;
        const isProceduralCollectionChild = !!(p && (isCollectionGroupName(p.name) || p.name === 'scene'));
        const isNamedSemanticGroup = (obj instanceof THREE.Group || (obj as any).isMesh) && !seenUuids.has(obj.uuid);

        if ((isRootChild || isProceduralCollectionChild) && isNamedSemanticGroup) {
            seenUuids.add(obj.uuid);
            const oName = obj.name || ((obj as any).isMesh ? `Mesh ${(obj as any).geometry?.type || 'Object'}` : `Group Object`);
            let itemType = 'mesh';
            const nameLower = oName.toLowerCase();
            if (nameLower.includes('tavern') || nameLower.includes('house') || nameLower.includes('meeting') || nameLower.includes('tower') || nameLower.includes('skyscraper') || nameLower.includes('building') || nameLower.includes('desk') || nameLower.includes('chair') || nameLower.includes('wall') || nameLower.includes('room')) {
                itemType = 'building';
            } else if (nameLower.includes('minuteman') || nameLower.includes('soldier') || nameLower.includes('redcoat') || nameLower.includes('regiment') || nameLower.includes('line') || nameLower.includes('militia')) {
                itemType = 'unit';
            } else if (nameLower.includes('tree') || nameLower.includes('elm') || nameLower.includes('flora')) {
                itemType = 'tree';
            } else if (nameLower.includes('ground') || nameLower.includes('terrain') || nameLower.includes('floor') || nameLower.includes('green')) {
                itemType = 'terrain';
            } else if (nameLower.includes('smoke') || nameLower.includes('emitter') || nameLower.includes('particle') || nameLower.includes('cloud')) {
                itemType = 'emitter';
            } else if (nameLower.includes('wall') || nameLower.includes('fence') || nameLower.includes('pillar') || nameLower.includes('plinth')) {
                itemType = 'prop';
            } else if (nameLower.includes('sun') || nameLower.includes('planet') || nameLower.includes('orbit') || nameLower.includes('prism') || nameLower.includes('ring')) {
                itemType = 'celestial';
            } else if (nameLower.includes('vehicle') || nameLower.includes('hover') || nameLower.includes('car') || nameLower.includes('airplane') || nameLower.includes('aircraft') || nameLower.includes('drone')) {
                itemType = 'vehicle';
            }

            items.push({
                id: obj.uuid,
                name: oName,
                type: itemType,
                object: obj,
                visible: obj.visible
            });
        }
    });

    return items;
}

/** The loaded-model root that `obj` belongs to (or is), or null for anything else. */
export function findExternalObjectRoot(obj: THREE.Object3D | null | undefined): THREE.Object3D | null {
    let cur: THREE.Object3D | null | undefined = obj;
    while (cur) {
        if (cur.name && cur.name.startsWith(EXTERNAL_OBJECT_ROOT_PREFIX)) return cur;
        cur = cur.parent;
    }
    return null;
}

/** The `objects[]` id encoded in a loaded-model root name. */
export function externalObjectIdOf(root: THREE.Object3D): string {
    return root.name.slice(EXTERNAL_OBJECT_ROOT_PREFIX.length);
}

/** True when `obj` (or one of its ancestors) is currently attached under `root`. */
export function isAttachedTo(obj: THREE.Object3D | null | undefined, root: THREE.Object3D): boolean {
    let cur: THREE.Object3D | null | undefined = obj;
    while (cur) {
        if (cur === root) return true;
        cur = cur.parent;
    }
    return false;
}

export interface ObjectGeometrySummary { meshes: number; vertices: number; triangles: number }

/** Mesh / vertex / triangle totals under `obj`, for the selection readout. */
export function summarizeObjectGeometry(obj: THREE.Object3D | null | undefined): ObjectGeometrySummary | null {
    if (!obj) return null;
    let meshes = 0;
    let vertices = 0;
    let triangles = 0;
    obj.traverse(child => {
        const mesh = child as THREE.Mesh;
        if (!mesh.isMesh || !mesh.geometry) return;
        const position = mesh.geometry.getAttribute('position');
        if (!position) return;
        meshes++;
        vertices += position.count;
        triangles += Math.floor((mesh.geometry.index ? mesh.geometry.index.count : position.count) / 3);
    });
    return { meshes, vertices, triangles };
}
