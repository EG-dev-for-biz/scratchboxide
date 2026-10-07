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
