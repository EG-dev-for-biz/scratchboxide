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
 * Double-sided surfaces of a loaded model cast shadows from their back faces only, as single-sided ones do (three's
 * default for a FrontSide material). Drawn from both sides into the sun's shadow map, a lit facade shadows itself and
 * the layers stacked a few centimetres to metres in front of it (pipeline K's wall sheets, lattice cells and restored
 * scan pieces), in window-sized dark blocks the shadow map's texels (about 15 cm over a 600 m building) cannot resolve:
 * the "z-fighting" seen on the Empire State Building as soon as the sky's sun casts (2026-11-03). A closed building
 * still casts its full shadow from its far walls.
 *
 * Trees keep both sides: a leaf card is one sheet, and the tree level-of-detail controller gives its meshes their own
 * shadow materials (anything under a node carrying `sbTree`). A material given a shadowSide of its own is left as it is.
 * Returns how many materials it set.
 */
export function castShadowsFromBackFaces(root: THREE.Object3D): number {
    const set = new Set<THREE.Material>();
    const visit = (o: THREE.Object3D) => {
        if ((o.userData as { sbTree?: unknown }).sbTree) return;
        const mesh = o as THREE.Mesh;
        if (mesh.isMesh) {
            for (const m of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
                if (m && m.side === THREE.DoubleSide && m.shadowSide == null) { m.shadowSide = THREE.BackSide; set.add(m); }
            }
        }
        for (const c of o.children) visit(c);
    };
    visit(root);
    return set.size;
}
