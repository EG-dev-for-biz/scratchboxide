/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import * as THREE from 'three';
import type { ObjectMaterialOverride } from '../../canvas-types';
import { resolveOverrideColor } from './overrideColor';
import { applyClayRenderMode } from './clayRenderMode';
import { baseMaterialOf, isStagedMaterial } from './stagedBuild/revealMaterial';

/**
 * An explicit material on a loaded model (sb_set_material_pbr on an object). The scene's clay look is the default for a model
 * that carries none; an override replaces it for that object's surfaces, and removing the override brings the earlier look back.
 */

const FLAG = 'sbMaterialOverride';
const BASE_KEY = 'sbOverrideBase';
const SIG_KEY = 'sbOverrideSig';

function fill(mat: THREE.MeshPhysicalMaterial, base: THREE.Material | undefined, o: ObjectMaterialOverride): void {
    const b = base as Partial<THREE.MeshStandardMaterial> | undefined;
    if (b?.color) mat.color.copy(b.color);
    mat.roughness = typeof b?.roughness === 'number' ? b.roughness : 0.6;
    mat.metalness = typeof b?.metalness === 'number' ? b.metalness : 0;
    mat.map = b?.map ?? null;
    mat.vertexColors = !!b?.vertexColors;
    mat.side = base?.side ?? THREE.FrontSide;
    const color = resolveOverrideColor(o.color);
    if (color) {
        // An explicit colour replaces the texture and the baked vertex colours it would be multiplied with.
        mat.color.copy(color);
        mat.map = null;
        mat.vertexColors = false;
    }
    if (typeof o.roughness === 'number') mat.roughness = o.roughness;
    if (typeof o.metalness === 'number') mat.metalness = o.metalness;
    const emissive = resolveOverrideColor(o.emissive);
    if (emissive) mat.emissive.copy(emissive); else mat.emissive.setHex(0);
    if (typeof o.emissiveIntensity === 'number') mat.emissiveIntensity = o.emissiveIntensity;
    if (typeof o.clearcoat === 'number') mat.clearcoat = o.clearcoat;
    if (typeof o.clearcoatRoughness === 'number') mat.clearcoatRoughness = o.clearcoatRoughness;
    if (typeof o.transmission === 'number') mat.transmission = o.transmission;
    if (typeof o.ior === 'number') mat.ior = o.ior;
    if (typeof o.thickness === 'number') mat.thickness = o.thickness;
    mat.wireframe = o.wireframe === true;
    mat.needsUpdate = true;
}

/** The material under a staged reveal/provenance copy: never a half-revealed copy. */
function unwrap<T extends THREE.Material | THREE.Material[]>(m: T): T {
    if (!Array.isArray(m) && isStagedMaterial(m)) return (baseMaterialOf(m) ?? m) as T;
    return m;
}
const authoredMaterial = (mesh: THREE.Mesh): THREE.Material | THREE.Material[] => unwrap(mesh.material);
const isOverrideMaterial = (m: THREE.Material | undefined): boolean => m?.userData?.[FLAG] === 'material';

/**
 * Draws every mesh under `root` with `override`, or (undefined) puts back what each wore before. Returns the meshes changed.
 */
export function applyObjectMaterialOverride(root: THREE.Object3D, override: ObjectMaterialOverride | undefined): number {
    let touched = 0;
    const made = new Map<THREE.Material, THREE.MeshPhysicalMaterial>();
    const refilled = new Set<THREE.Material>();
    root.traverse(obj => {
        const mesh = obj as THREE.Mesh;
        if (!mesh.isMesh) return;
        const lod = !!mesh.userData.sbTreeLodMesh;
        const flagged = !!mesh.userData[FLAG];
        if (!override) {
            if (!flagged) return;
            const base = mesh.userData[BASE_KEY] as THREE.Material | THREE.Material[];
            const wearing = unwrap((lod ? mesh.userData.sbLodBase : mesh.material) as THREE.Material | THREE.Material[]);
            for (const m of Array.isArray(wearing) ? wearing : [wearing]) if (isOverrideMaterial(m)) m.dispose();
            if (lod) mesh.userData.sbLodBase = base;
            mesh.material = base;
            delete mesh.userData[FLAG];
            delete mesh.userData[BASE_KEY];
            touched++;
            return;
        }
        if (!flagged) {
            mesh.userData[BASE_KEY] = lod ? mesh.userData.sbLodBase ?? authoredMaterial(mesh) : authoredMaterial(mesh);
            mesh.userData[FLAG] = true;
        }
        const base = mesh.userData[BASE_KEY] as THREE.Material | THREE.Material[];
        const build = (b: THREE.Material | undefined): THREE.Material => {
            let mat = made.get(b as THREE.Material);
            if (!mat) { mat = new THREE.MeshPhysicalMaterial(); made.set(b as THREE.Material, mat); fill(mat, b, override); }
            return mat;
        };
        const wearing = unwrap((lod ? mesh.userData.sbLodBase : mesh.material) as THREE.Material | THREE.Material[]);
        let next: THREE.Material | THREE.Material[];
        if (flagged && !Array.isArray(wearing) && isOverrideMaterial(wearing as THREE.Material)) {
            // Already an override material: refill it once, whichever meshes share it.
            if (!refilled.has(wearing)) {
                refilled.add(wearing);
                const baseOf = Array.isArray(base) ? base[0] : base;
                fill(wearing as THREE.MeshPhysicalMaterial, baseOf, override);
            }
            next = wearing;
        } else {
            next = Array.isArray(base) ? base.map(b => build(b)) : build(base);
            for (const m of Array.isArray(next) ? next : [next]) m.userData[FLAG] = 'material';
            // The mesh may now wear a staged copy of the old look; the staged guard rebuilds its own over this material.
            if (flagged) for (const m of Array.isArray(wearing) ? wearing : [wearing]) if (isOverrideMaterial(m)) m.dispose();
        }
        if (lod) mesh.userData.sbLodBase = next;
        mesh.material = next;
        touched++;
    });
    return touched;
}

/**
 * Brings `root` in line with the object's declared material and the scene's clay mode, once per change. Returns whether anything was redrawn.
 */
export function syncObjectMaterial(root: THREE.Object3D, override: ObjectMaterialOverride | undefined, clay: boolean): boolean {
    const sig = override ? JSON.stringify(override) : 'null';
    if ((root.userData[SIG_KEY] ?? 'null') === sig) return false;
    root.userData[SIG_KEY] = sig;
    const touched = applyObjectMaterialOverride(root, override);
    // An override that was removed leaves the look the scene's mode asks for.
    if (!override) applyClayRenderMode([root], clay);
    return touched > 0;
}

export { resolveOverrideColor };

export function hasMaterialOverride(mesh: THREE.Object3D): boolean {
    return !!mesh.userData[FLAG];
}
