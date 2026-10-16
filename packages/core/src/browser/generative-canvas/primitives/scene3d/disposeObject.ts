/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import * as THREE from 'three';

/** Mirrors ORIGINAL_KEY in clayRenderMode.ts: the authored material stashed while clay is shown. */
const CLAY_ORIGINAL_MATERIAL_KEY = 'sbClayOriginalMaterial';

function disposeTexture(tex: THREE.Texture, seen: Set<object>): void {
    if (seen.has(tex)) return;
    seen.add(tex);
    tex.dispose();
    // GLTFLoader decodes embedded images to ImageBitmaps on Chromium; those hold decoded pixels
    // outside the GL context until explicitly closed.
    const data = (tex as any).source?.data;
    if (typeof ImageBitmap !== 'undefined' && data instanceof ImageBitmap) data.close();
}

function disposeMaterial(mat: THREE.Material | THREE.Material[] | null | undefined, seen: Set<object>): void {
    if (!mat) return;
    if (Array.isArray(mat)) {
        mat.forEach(m => disposeMaterial(m, seen));
        return;
    }
    if (seen.has(mat)) return;
    seen.add(mat);
    for (const [key, value] of Object.entries(mat)) {
        // Environment maps are scene-level resources shared across models; never free them here.
        if (key === 'envMap') continue;
        if (value && (value as THREE.Texture).isTexture) disposeTexture(value as THREE.Texture, seen);
    }
    const uniforms = (mat as THREE.ShaderMaterial).uniforms;
    if (uniforms) {
        for (const uniform of Object.values(uniforms)) {
            if (uniform?.value && (uniform.value as THREE.Texture).isTexture) disposeTexture(uniform.value, seen);
        }
    }
    mat.dispose();
}

/**
 * Frees everything a loaded model owns: geometries, materials, every texture referenced by those
 * materials, and the authored materials stashed by the clay render mode. `disposeObject3D`
 * (types.ts) only frees geometries and materials, which leaks the textures of photo-textured models.
 */
export function disposeObject3DDeep(root: THREE.Object3D | null | undefined): void {
    if (!root) return;
    const seen = new Set<object>();
    root.traverse(obj => {
        const mesh = obj as THREE.Mesh;
        if (mesh.geometry && !seen.has(mesh.geometry) && typeof mesh.geometry.dispose === 'function') {
            seen.add(mesh.geometry);
            mesh.geometry.dispose();
        }
        disposeMaterial((mesh as any).material, seen);
        disposeMaterial(mesh.userData?.[CLAY_ORIGINAL_MATERIAL_KEY], seen);
        // Fires the node's 'dispose' event, which the renderer needs to free per-object GPU state
        // (e.g. the instance buffers of InstancedMeshes from EXT_mesh_gpu_instancing).
        obj.dispose();
    });
}

/** True when `obj`'s class replaces Object3D.dispose() with cleanup of the resources it owns. */
function ownsItsDisposal(obj: THREE.Object3D): boolean {
    return typeof obj.dispose === 'function' && obj.dispose !== THREE.Object3D.prototype.dispose;
}

/**
 * Detaches a loaded external object (glTF root or Gaussian splat) and frees it.
 *
 * "Has a dispose() method" cannot pick the strategy: in three r186 every Object3D (Group included)
 * inherits one that only fires an event and frees nothing. Only a class that overrides it, such
 * as PhotorealGaussianSplatMesh (radix sorter, splat buffers, and uniforms that may point at
 * scene-level textures that must survive), is trusted to release itself. Everything else, glTF
 * scene roots in particular, is deep-disposed.
 */
export function releaseObject3D(root: THREE.Object3D | null | undefined): void {
    if (!root) return;
    (root.userData?.sbTreeLod as { dispose(): void } | undefined)?.dispose();
    root.parent?.remove(root);
    if (ownsItsDisposal(root)) root.dispose();
    else disposeObject3DDeep(root);
}
