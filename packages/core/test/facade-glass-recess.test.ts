/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The glass's recess for its specular occlusion (facadeMaterialLook.ts recessOf): the structure's relief over the median
 * bay's width in metres, the bays read in the photo's UVs and scaled by the facade mesh's own UV extent.
 */

import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { recessOf } from '../src/browser/generative-canvas/primitives/scene3d/stagedBuild/facadeMaterialLook';

function facade(widthM: number, extras: unknown): { root: THREE.Group; mat: THREE.MeshStandardMaterial } {
    // a 20 m tall wall in the plane z = 0, its u running 0..1 across its width
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, widthM, 0, 0, widthM, 20, 0, 0, 20, 0], 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 1, 0, 1, 1, 0, 1], 2));
    g.setIndex([0, 1, 2, 0, 2, 3]);
    const mat = new THREE.MeshStandardMaterial();
    const mesh = new THREE.Mesh(g, mat);
    mesh.userData.sbFacadeLattice = extras;
    const root = new THREE.Group();
    root.add(mesh);
    root.updateMatrixWorld(true);
    return { root, mat };
}

describe('the glass recess for specular occlusion', () => {
    it('is the relief over the median bay width in metres', () => {
        // a 40 m facade; bays 0.05, 0.05 and 0.08 of its width (2, 2 and 3.2 m); relief 0.3 m -> 0.3 / 2 = 0.15
        const { root, mat } = facade(40, { structure: { reliefM: 0.3, bays: [0.1, 0.9, 0.15, 0.1, 0.3, 0.9, 0.35, 0.1, 0.5, 0.9, 0.58, 0.1] } });
        const r = recessOf(root, mat);
        expect(r.x).toBeCloseTo(0.15, 3);
        expect(r.y).toBe(0);
    });

    it('draws no occlusion on a surface without a structure (a scan piece) or without bays', () => {
        const a = facade(40, undefined), b = facade(40, { structure: { reliefM: 0.3, bays: [] } }), c = facade(40, { structure: { reliefM: 0, bays: [0.1, 0.9, 0.15, 0.1] } });
        for (const f of [a, b, c]) expect(recessOf(f.root, f.mat).x).toBe(0);
    });
});
