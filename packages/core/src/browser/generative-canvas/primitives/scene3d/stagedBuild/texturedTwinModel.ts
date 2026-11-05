/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * A loaded glTF whose materials carry texture-pass extras (`extras.sbTexture.confidenceTexture`: a textured twin of a
 * staged layer): its surfaces keep their photo material under the viewport's clay pass, and each such material gets its
 * confidence texture (R provenance index, G weight, B ladder rung, A produced) for the per-texel rung shading. The
 * texture is read raw: nearest sampling, no mipmaps, no colour conversion, so a rung index is never blended.
 */

import * as THREE from 'three';
import { CONFIDENCE_MAP_KEY, FRONT_BIAS_KEY } from './revealMaterial';
import { prepareFacadeMaterials } from './facadeMaterialLook';
import { applyStochasticTiling } from './stochasticTiling';

/** Mirrors the flag applyClayRenderMode (clayRenderMode.ts) skips: the surface keeps its authored material. */
export const KEEP_AUTHORED_MATERIAL_KEY = 'sbKeepAuthoredMaterial';

interface GltfLike {
    scene: THREE.Object3D;
    parser?: { getDependency: (type: string, index: number) => Promise<unknown> };
}

function confidenceIndexOf(m: THREE.Material): number | undefined {
    const i = (m.userData as { sbTexture?: { confidenceTexture?: unknown } } | undefined)?.sbTexture?.confidenceTexture;
    return typeof i === 'number' && Number.isInteger(i) && i >= 0 ? i : undefined;
}

/** A node the remesh polish rebuilt on a facade plane (pipeline K's lattice, node extras `sbFacadeLattice`). */
const isRebuiltFacade = (o: THREE.Object3D): boolean => !!(o.userData?.sbFacadeLattice ?? o.parent?.userData?.sbFacadeLattice);

/**
 * The rebuilt facades in front of the scan they replace (FRONT_BIAS_KEY): each rebuilt mesh gets its own copy of a material
 * it shares with scan pieces (the copy shares its textures), flagged for the depth bias. Returns the meshes flagged.
 */
export function biasRebuiltFacades(scene: THREE.Object3D): number {
    const scanMats = new Set<THREE.Material>(), rebuilt: THREE.Mesh[] = [];
    scene.traverse(o => {
        const mesh = o as THREE.Mesh;
        if (!mesh.isMesh) return;
        if (isRebuiltFacade(mesh)) rebuilt.push(mesh);
        else for (const m of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) if (m) scanMats.add(m);
    });
    const copies = new Map<THREE.Material, THREE.Material>();
    const own = (m: THREE.Material): THREE.Material => {
        if (!scanMats.has(m)) return m;
        let c = copies.get(m);
        if (!c) { c = m.clone(); copies.set(m, c); }
        return c;
    };
    for (const mesh of rebuilt) {
        mesh.material = Array.isArray(mesh.material) ? mesh.material.map(own) : own(mesh.material);
        for (const m of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
            m.userData[FRONT_BIAS_KEY] = true;
            m.polygonOffset = true; m.polygonOffsetFactor = -1; m.polygonOffsetUnits = -2;
        }
    }
    return rebuilt.length;
}

/**
 * Marks the textured surfaces of a just-loaded model (synchronously, before the loader's clay pass) and loads their
 * confidence textures. Resolves with the number of materials that got one; a model without texture-pass extras is left
 * untouched. A confidence texture that fails to load leaves its material without one (the rung shading then draws that
 * surface in the clay rung's colour) and is reported on the console.
 */
export function prepareTexturedTwinModel(gltf: GltfLike, opts: { twin?: boolean } = {}): Promise<number> {
    // first, so the copies are prepared like the rest (confidence textures, the facade material reading)
    biasRebuiltFacades(gltf.scene);
    const byIndex = new Map<number, THREE.Material[]>();
    gltf.scene.traverse(o => {
        const mesh = o as THREE.Mesh;
        if (!mesh.isMesh) return;
        const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
        let textured = false;
        for (const m of mats) {
            const idx = m ? confidenceIndexOf(m) : undefined;
            if (idx === undefined) continue;
            textured = true;
            const list = byIndex.get(idx) ?? [];
            if (!list.includes(m)) list.push(m);
            byIndex.set(idx, list);
        }
        // a twin's textured surfaces are the point of it: a photogrammetric twin (the scan's own textures, no confidence
        // texture) keeps its photo materials under the clay pass as much as a texture-pass twin does
        if (textured || (opts.twin && mats.some(m => !!(m as THREE.MeshStandardMaterial | null)?.map))) mesh.userData[KEEP_AUTHORED_MATERIAL_KEY] = true;
    });
    // library materials (procedural surfaces) flagged for hex-tiling: their repeat broken up in the shader
    applyStochasticTiling(gltf.scene);
    const parser = gltf.parser;
    // the material extras (the facade probe, a texture pass's glass and coursing) on the same surfaces, when the twin carries them
    const facade = prepareFacadeMaterials(gltf).catch(() => 0);
    if (byIndex.size === 0 || !parser) return facade.then(() => 0);
    return facade.then(() => Promise.all([...byIndex].map(async ([idx, mats]) => {
        try {
            const tex = await parser.getDependency('texture', idx) as THREE.Texture;
            tex.colorSpace = THREE.NoColorSpace;
            tex.magFilter = THREE.NearestFilter;
            tex.minFilter = THREE.NearestFilter;
            tex.generateMipmaps = false;
            tex.needsUpdate = true;
            for (const m of mats) m.userData[CONFIDENCE_MAP_KEY] = tex;
            return mats.length;
        } catch (err) {
            console.warn(`[staged textures] confidence texture ${idx} did not load:`, err);
            return 0;
        }
    }))).then(counts => counts.reduce((a, b) => a + b, 0));
}
