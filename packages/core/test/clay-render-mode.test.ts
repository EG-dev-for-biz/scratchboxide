/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { applyClayRenderMode, CLAY_SURFACE } from '../src/browser/generative-canvas/primitives/scene3d/clayRenderMode';

const buildRoot = () => {
    const root = new THREE.Group();
    const texture = new THREE.Texture();
    const original = new THREE.MeshPhysicalMaterial({ color: 0xdc143c, roughness: 0.12, metalness: 0.25, map: texture });
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), original);
    root.add(mesh);
    return { root, mesh, original };
};

describe('applyClayRenderMode', () => {
    it('replaces every mesh surface under the roots with untextured grey clay', () => {
        const { root, mesh } = buildRoot();
        expect(applyClayRenderMode([root], true)).toBe(1);
        const mat = mesh.material as THREE.MeshStandardMaterial;
        expect(mat.color.getHex()).toBe(CLAY_SURFACE.color);
        expect(mat.roughness).toBeCloseTo(CLAY_SURFACE.roughness);
        expect(mat.metalness).toBeCloseTo(CLAY_SURFACE.metalness);
        expect(mat.map).toBeNull();
        expect(mat.vertexColors).toBe(false);
    });

    it('re-asserts clay after an in-place material sync and restores the original when disabled', () => {
        const { root, mesh, original } = buildRoot();
        applyClayRenderMode([root], true);
        (mesh.material as THREE.MeshStandardMaterial).color.set(0x00ff00);
        applyClayRenderMode([root], true);
        expect((mesh.material as THREE.MeshStandardMaterial).color.getHex()).toBe(CLAY_SURFACE.color);

        applyClayRenderMode([root], false);
        expect(mesh.material).toBe(original);
        expect(original.color.getHex()).toBe(0xdc143c);
    });

    it('the trees of a staged place follow their own switch: textured under the clay render mode unless asked for clay', () => {
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, 1, 0, 0, 0, 1, 0], 3));
        const leaf = new THREE.MeshStandardMaterial({ map: new THREE.DataTexture(new Uint8Array([40, 120, 40, 255]), 1, 1) });
        const tree = new THREE.Mesh(geometry, leaf);
        tree.userData.sbTreeLodMesh = true;
        tree.userData.sbLodBase = leaf;
        const wall = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial());
        const root = new THREE.Group();
        root.add(tree, wall);
        // clay render mode, trees textured: the wall is clayed, the tree keeps its leaf texture as its LOD base
        applyClayRenderMode([root], true, { trees: false });
        expect(tree.material).toBe(leaf);
        expect(tree.userData.sbLodBase).toBe(leaf);
        expect((wall.material as THREE.MeshStandardMaterial).userData[CLAY_SURFACE] ?? (wall.material !== undefined)).toBeTruthy();
        expect(wall.material).not.toBe(tree.material);
        // the user asks for clay: the tree goes to its tree clay, and back when textured again
        applyClayRenderMode([root], true, { trees: true });
        expect(tree.material).not.toBe(leaf);
        expect(tree.userData.sbLodBase).not.toBe(leaf);
        applyClayRenderMode([root], true, { trees: false });
        expect(tree.material).toBe(leaf);
        expect(tree.userData.sbLodBase).toBe(leaf);
    });
});
