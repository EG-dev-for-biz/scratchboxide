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
import { CONFIDENCE_MAP_KEY } from './revealMaterial';

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

/**
 * Marks the textured surfaces of a just-loaded model (synchronously, before the loader's clay pass) and loads their
 * confidence textures. Resolves with the number of materials that got one; a model without texture-pass extras is left
 * untouched. A confidence texture that fails to load leaves its material without one (the rung shading then draws that
 * surface in the clay rung's colour) and is reported on the console.
 */
export function prepareTexturedTwinModel(gltf: GltfLike): Promise<number> {
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
        if (textured) mesh.userData[KEEP_AUTHORED_MATERIAL_KEY] = true;
    });
    const parser = gltf.parser;
    if (byIndex.size === 0 || !parser) return Promise.resolve(0);
    return Promise.all([...byIndex].map(async ([idx, mats]) => {
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
    })).then(counts => counts.reduce((a, b) => a + b, 0));
}
