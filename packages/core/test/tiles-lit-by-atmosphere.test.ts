/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Google's photorealistic tiles arrive unlit (KHR_materials_unlit, no normals), so a scene sun neither lights them nor
 * casts shadows on them. setLit swaps each tile's unlit material for a lit one with the same photo and flat shading,
 * turns on the shade lift, and setLit(false) gives the original materials back.
 */

import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { GooglePhotorealistic3DTilesLayer } from '../src/browser/generative-canvas/services/GooglePhotorealistic3DTilesLayer';
import { TILES_SUN_SHADOW_RADIUS_M } from '../src/browser/generative-canvas/primitives/scene3d/syncAtmosphere';

function tileMesh(): { mesh: THREE.Mesh; basic: THREE.MeshBasicMaterial; map: THREE.Texture } {
    const map = new THREE.Texture();
    const basic = new THREE.MeshBasicMaterial({ map, side: THREE.DoubleSide });
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, 1, 0, 0, 0, 1, 0], 3));
    return { mesh: new THREE.Mesh(geo, basic), basic, map };
}

describe('Google 3D Tiles lit by the atmosphere sun', () => {
    it('setLit(true) gives every tile a lit, flat-shaded material with the same photo; setLit(false) restores it', () => {
        const layer = new GooglePhotorealistic3DTilesLayer();
        const a = tileMesh();
        const b = tileMesh();
        layer.tilesRenderer.group.add(a.mesh, b.mesh);
        const uniforms = (layer as any).styleUniforms;
        expect(uniforms.uTileDelight.value).toBe(0);

        layer.setLit(true);
        expect(layer.isLit()).toBe(true);
        expect(uniforms.uTileDelight.value).toBe(1);
        for (const t of [a, b]) {
            const lit = t.mesh.material as THREE.MeshStandardMaterial;
            expect(lit.isMeshStandardMaterial).toBe(true);
            expect(lit.map).toBe(t.map);
            expect(lit.flatShading).toBe(true); // the tiles carry no normals
            expect(lit.side).toBe(THREE.DoubleSide);
            expect(lit.metalness).toBe(0);
            expect(lit.userData.sbUnlitOriginal).toBe(t.basic);
            expect(lit.userData.sbTilesPatched).toBe(true); // the clay / classification / flatten patch applies to it too
        }

        // a second call is a no-op, and the twin is reused rather than rebuilt
        const twin = a.mesh.material;
        layer.setLit(true);
        expect(a.mesh.material).toBe(twin);

        layer.setLit(false);
        expect(uniforms.uTileDelight.value).toBe(0);
        expect(a.mesh.material).toBe(a.basic);
        expect(b.mesh.material).toBe(b.basic);
        layer.setLit(true);
        expect(a.mesh.material).toBe(twin);
    });

    it('a tile that streams in while lit is lit on arrival, and materials that are already lit are left alone', () => {
        const layer = new GooglePhotorealistic3DTilesLayer();
        layer.setLit(true);
        const late = tileMesh();
        const scene = new THREE.Group();
        scene.add(late.mesh);
        (layer.tilesRenderer as any).onLoadModel(scene);
        expect((late.mesh.material as THREE.Material as any).isMeshStandardMaterial).toBe(true);

        const own = new THREE.MeshStandardMaterial({ color: 0x808080 });
        const m = new THREE.Mesh(new THREE.BufferGeometry(), own);
        layer.tilesRenderer.group.add(m);
        layer.setLit(false);
        layer.setLit(true);
        expect(m.material).toBe(own);
    });

    it('over live tiles the sun shadows reach a street and the buildings on both sides', () => {
        expect(TILES_SUN_SHADOW_RADIUS_M).toBeGreaterThanOrEqual(100);
    });
});
