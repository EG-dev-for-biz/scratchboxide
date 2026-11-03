/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * One lighting model for every photo surface. A staged layer's photo twin arrives with unlit materials (glTF
 * KHR_materials_unlit, three's MeshBasicMaterial with the photo as its map), which take no light and so no shadow from
 * the sun: next to a twin whose material regions draw it lit, one building took the sun's shadow and the next did not.
 * Each such surface is drawn lit instead: a MeshStandardMaterial with the (de-lit) photo as its albedo, fully rough and
 * not metallic, flat-shaded where the mesh carries no normals, so it is lit and shadowed like everything else and
 * nothing is shadowed twice.
 *
 * The lit material shares the unlit one's userData (the confidence texture prepareTexturedTwinModel loads later lands on
 * both) and keeps its side, shadow side (castShadowsFromBackFaces), depth bias (biasRebuiltFacades), transparency and any
 * shader patch, so the staged reveal (revealMaterial.ts), which clones a mesh's material and chains its shader patch, and
 * the clay pass, which stashes it, carry it as they carried the unlit one. Two meshes sharing an unlit material share
 * its lit one.
 */

import * as THREE from 'three';
import { KEEP_AUTHORED_MATERIAL_KEY } from './texturedTwinModel';

/** Lit stand-ins made so far: unlit material -> (flat-shaded?) -> lit material. Not in userData, which three's clone serialises. */
const LIT = new WeakMap<THREE.Material, Map<boolean, THREE.MeshStandardMaterial>>();
const UNLIT = new WeakMap<THREE.Material, THREE.MeshBasicMaterial>();

/** The unlit photo material a lit twin material stands in for (diagnostics and tests). */
export function unlitPhotoMaterialOf(m: THREE.Material): THREE.MeshBasicMaterial | undefined {
    return UNLIT.get(m);
}

/** An unlit photo surface: MeshBasicMaterial with a map. */
export function isUnlitPhotoMaterial(m: THREE.Material | null | undefined): m is THREE.MeshBasicMaterial {
    return !!(m as THREE.MeshBasicMaterial | null)?.isMeshBasicMaterial && !!(m as THREE.MeshBasicMaterial).map;
}

function litFor(basic: THREE.MeshBasicMaterial, flat: boolean): THREE.MeshStandardMaterial {
    let byFlat = LIT.get(basic);
    if (!byFlat) LIT.set(basic, byFlat = new Map());
    let lit = byFlat.get(flat);
    if (lit) return lit;
    // the photo's own colour: compensateUnlitForExposure may have scaled `color` for the camera's exposure
    const base = (basic.userData.sbUnlitBaseColor as THREE.Color | undefined) ?? basic.color;
    lit = new THREE.MeshStandardMaterial({
        name: basic.name,
        map: basic.map,
        color: base.clone(),
        alphaMap: basic.alphaMap,
        aoMap: basic.aoMap,
        aoMapIntensity: basic.aoMapIntensity,
        lightMap: basic.lightMap,
        lightMapIntensity: basic.lightMapIntensity,
        vertexColors: basic.vertexColors,
        roughness: 1,
        metalness: 0,
        flatShading: flat,
        side: basic.side,
        transparent: basic.transparent,
        opacity: basic.opacity,
        alphaTest: basic.alphaTest,
        depthTest: basic.depthTest,
        depthWrite: basic.depthWrite,
        polygonOffset: basic.polygonOffset,
        polygonOffsetFactor: basic.polygonOffsetFactor,
        polygonOffsetUnits: basic.polygonOffsetUnits,
        visible: basic.visible
    });
    lit.shadowSide = basic.shadowSide;
    const envMapIntensity = (basic as unknown as { envMapIntensity?: number }).envMapIntensity;
    if (typeof envMapIntensity === 'number') lit.envMapIntensity = envMapIntensity;
    lit.userData = basic.userData;
    if (basic.onBeforeCompile !== THREE.Material.prototype.onBeforeCompile) {
        const patch = basic.onBeforeCompile;
        lit.onBeforeCompile = (shader, renderer) => patch.call(lit, shader, renderer);
        const key = basic.customProgramCacheKey;
        lit.customProgramCacheKey = () => key.call(basic);
    }
    byFlat.set(flat, lit);
    UNLIT.set(lit, basic);
    return lit;
}

/**
 * Draws the photo twin surfaces under `root` lit (meshes prepareTexturedTwinModel marked as keeping their authored
 * material). Returns how many meshes changed material.
 */
export function drawPhotoTwinsLit(root: THREE.Object3D): number {
    let changed = 0;
    root.traverse(o => {
        const mesh = o as THREE.Mesh;
        if (!mesh.isMesh || !mesh.userData[KEEP_AUTHORED_MATERIAL_KEY]) return;
        const geometry = mesh.geometry as THREE.BufferGeometry;
        const flat = !geometry.getAttribute('normal');
        let swapped = false;
        const swap = (m: THREE.Material): THREE.Material => {
            if (!isUnlitPhotoMaterial(m)) return m;
            swapped = true;
            return litFor(m, flat || (m as unknown as { flatShading?: boolean }).flatShading === true);
        };
        mesh.material = Array.isArray(mesh.material) ? mesh.material.map(swap) : swap(mesh.material);
        if (swapped) changed++;
    });
    return changed;
}
