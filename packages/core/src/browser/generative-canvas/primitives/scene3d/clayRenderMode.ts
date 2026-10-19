/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import * as THREE from 'three';

export const CLAY_SURFACE = { color: 0xb0b8c4, roughness: 0.82, metalness: 0.02 } as const;

const ORIGINAL_KEY = 'sbClayOriginalMaterial';
const CLAY_FLAG = 'sbClay';

function makeClay(): THREE.MeshStandardMaterial {
    const mat = new THREE.MeshStandardMaterial({ ...CLAY_SURFACE });
    mat.userData[CLAY_FLAG] = true;
    return mat;
}

/**
 * Wood and leaves of the trees (meshes the tree level-of-detail controller owns) share this one material at every level:
 * the same grey, with no value difference between wood and leaves. The controller reads it from `userData.sbLodBase`.
 */
let sharedTreeClay: THREE.MeshStandardMaterial | undefined;
export function sharedTreeClayMaterial(): THREE.MeshStandardMaterial {
    if (!sharedTreeClay) {
        sharedTreeClay = makeClay();
        sharedTreeClay.userData.sbSharedClay = true;
    }
    return sharedTreeClay;
}

/**
 * Gives a tree level-of-detail mesh the material it wears outside clay mode (its textured surface). In clay mode the mesh
 * keeps the shared clay and the material waits to be restored when clay is turned off; otherwise it is the mesh's base at
 * once (the controller redresses the mesh, dither and crown variants included, at its next frame).
 */
export function setTreeLodTexturedMaterial(mesh: THREE.Mesh, material: THREE.Material): void {
    if (mesh.userData[ORIGINAL_KEY]) {
        mesh.userData[ORIGINAL_KEY] = material;
        return;
    }
    mesh.userData.sbLodBase = material;
    mesh.material = material;
}

function resetClay(mat: THREE.MeshStandardMaterial): void {
    mat.color.setHex(CLAY_SURFACE.color);
    mat.roughness = CLAY_SURFACE.roughness;
    mat.metalness = CLAY_SURFACE.metalness;
    mat.map = null;
    mat.vertexColors = false;
    mat.emissive.setHex(0x000000);
    mat.needsUpdate = true;
}

/**
 * Swap (or restore) every mesh surface under `roots` for untextured grey clay. Each mesh gets its
 * own clay material because custom-mesh sync mutates materials in place; re-applying resets it.
 * Returns the number of meshes touched.
 */
export function applyClayRenderMode(roots: Array<THREE.Object3D | null | undefined>, enabled: boolean): number {
    let touched = 0;
    for (const root of roots) {
        root?.traverse(obj => {
            const mesh = obj as THREE.Mesh;
            if (!mesh.isMesh) return;
            // An explicit material (sb_set_material_pbr) wins over the clay default.
            if (mesh.userData.sbMaterialOverride) return;
            // A textured twin of a staged layer (texturedTwinModel.ts) is shown only to show its photo texture; clay is its clay layer.
            if (mesh.userData.sbKeepAuthoredMaterial) return;
            if (mesh.userData.sbTreeLodMesh) {
                // base only: the controller puts it (or its dither variant) on the mesh at the next frame
                if (enabled) {
                    if (mesh.userData.sbLodBase !== sharedTreeClayMaterial()) { mesh.userData[ORIGINAL_KEY] = mesh.userData.sbLodBase; mesh.userData.sbLodBase = sharedTreeClayMaterial(); }
                    mesh.material = sharedTreeClayMaterial();
                    touched++;
                } else if (mesh.userData[ORIGINAL_KEY]) {
                    mesh.userData.sbLodBase = mesh.userData[ORIGINAL_KEY];
                    mesh.material = mesh.userData.sbLodBase;
                    delete mesh.userData[ORIGINAL_KEY];
                    touched++;
                }
                return;
            }
            const current = mesh.material as THREE.Material;
            const isClay = !Array.isArray(current) && !!current?.userData?.[CLAY_FLAG];
            if (enabled) {
                if (isClay) {
                    resetClay(current as THREE.MeshStandardMaterial);
                } else {
                    mesh.userData[ORIGINAL_KEY] = current;
                    mesh.material = makeClay();
                }
                touched++;
            } else if (isClay && mesh.userData[ORIGINAL_KEY]) {
                (current as THREE.Material).dispose();
                mesh.material = mesh.userData[ORIGINAL_KEY];
                delete mesh.userData[ORIGINAL_KEY];
                touched++;
            }
        });
    }
    return touched;
}
