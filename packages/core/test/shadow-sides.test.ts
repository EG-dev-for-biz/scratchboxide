/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * A loaded model's double-sided surfaces cast shadows from their back faces only (shadowSides.ts): the Empire State
 * Building's K facades shadowed themselves in window-sized blocks once the sky's sun cast (2026-11-03). Trees keep
 * both sides, a material's own shadowSide is kept, and the copies a staged layer makes later (the twin's facade bias,
 * a reveal) carry the setting.
 */

import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { castShadowsFromBackFaces } from '../src/browser/generative-canvas/primitives/scene3d/shadowSides';
import { createStagedMaterial } from '../src/browser/generative-canvas/primitives/scene3d/stagedBuild/revealMaterial';

const mesh = (side: THREE.Side, name: string) => new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial({ side, name }));

describe('shadow sides of a loaded model', () => {
    it('double-sided surfaces cast from their back faces; single-sided, tree and already-set ones are left alone', () => {
        const root = new THREE.Group();
        const facade = mesh(THREE.DoubleSide, 'facade'), sheet = mesh(THREE.DoubleSide, 'sheet'), roof = mesh(THREE.FrontSide, 'roof');
        const own = mesh(THREE.DoubleSide, 'own');
        (own.material as THREE.Material).shadowSide = THREE.FrontSide;
        const tree = new THREE.Group(); tree.userData.sbTree = { id: 1 };
        const leaves = mesh(THREE.DoubleSide, 'leaves');
        tree.add(new THREE.Group().add(leaves));
        // two meshes sharing one material count it once
        const shared = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), sheet.material);
        root.add(facade, sheet, shared, roof, own, tree);

        expect(castShadowsFromBackFaces(root)).toBe(2);
        expect((facade.material as THREE.Material).shadowSide).toBe(THREE.BackSide);
        expect((sheet.material as THREE.Material).shadowSide).toBe(THREE.BackSide);
        expect((roof.material as THREE.Material).shadowSide).toBeNull();
        expect((own.material as THREE.Material).shadowSide).toBe(THREE.FrontSide);
        expect((leaves.material as THREE.Material).shadowSide).toBeNull();
        // a second pass changes nothing
        expect(castShadowsFromBackFaces(root)).toBe(0);
    });

    it('copies made after loading carry it: the twin\'s per-mesh clones and a staged reveal', () => {
        const facade = mesh(THREE.DoubleSide, 'facade');
        castShadowsFromBackFaces(facade);
        const base = facade.material as THREE.Material;
        expect(base.clone().shadowSide).toBe(THREE.BackSide);
        expect(createStagedMaterial(facade, base, 'reveal', 1).shadowSide).toBe(THREE.BackSide);
    });
});
