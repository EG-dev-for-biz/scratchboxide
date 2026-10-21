/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The staged material registry's per-frame restore budget (design §7.7). Putting a mesh's own material back disposes
 * the staged one, which the renderer pays for in the frame it happens: on Central Park's 2,087 tree meshes that was a
 * 44-55 ms frame at the end of every reveal. Over the budget a mesh stays on its staged material, drawn fully revealed,
 * and gets its original a frame later; the registry says how many are waiting so the guard stays up.
 */

import { describe, expect, test } from 'vitest';
import * as THREE from 'three';
import { StagedMaterialRegistry, isStagedMaterial, stagedMaterialUniforms } from '../src/browser/generative-canvas/primitives/scene3d/stagedBuild/revealMaterial';

function meshes(n: number): Array<{ mesh: THREE.Mesh; base: THREE.Material }> {
    return Array.from({ length: n }, () => {
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(9), 3));
        const base = new THREE.MeshStandardMaterial({ color: 0xb0b8c4 });
        return { mesh: new THREE.Mesh(geometry, base), base };
    });
}

const OPTS = { allowCreate: true, pxScale: 1, classCount: 1 };

describe('StagedMaterialRegistry restore budget', () => {
    test('a reveal ending on 600 meshes puts at most the budget of originals back per frame, the rest drawn fully revealed meanwhile', () => {
        const registry = new StagedMaterialRegistry();
        const set = meshes(600);
        // Mid-reveal: each mesh wears its own staged material at 40%.
        for (const { mesh } of set) registry.apply(mesh, { reveal: { progress: 0.4, stagger: 0.3, fade: 1, presence: 1 } }, OPTS);
        expect(set.every(({ mesh }) => isStagedMaterial(mesh.material as THREE.Material))).toBe(true);
        expect(registry.size).toBe(600);

        const frames: number[] = [];
        const BUDGET = 256;
        for (let frame = 0; frame < 5 && registry.size > 0; frame++) {
            registry.beginFrame();
            const restores = { left: BUDGET };
            for (const { mesh } of set) registry.apply(mesh, null, { ...OPTS, restores });
            frames.push(BUDGET - restores.left);
            // What was not restored is shown at its end state, never at 40%.
            for (const { mesh } of set) {
                const u = isStagedMaterial(mesh.material as THREE.Material) ? stagedMaterialUniforms(mesh.material as THREE.Material) : undefined;
                if (u) expect([u.progress, u.fade, u.presence], 'a deferred mesh is drawn fully revealed').toEqual([1, 1, 1]);
            }
            expect(registry.deferredRestores, `frame ${frame}`).toBe(registry.size);
        }
        expect(frames, 'restored per frame').toEqual([256, 256, 88]);
        expect(registry.size).toBe(0);
        expect(registry.deferredRestores, 'nothing waits once all are back').toBe(0);
        for (const { mesh, base } of set) expect(mesh.material, 'the original material is back').toBe(base);
    });

    test('without a budget a mesh is restored at once (the unbudgeted callers: provenance off, unmount)', () => {
        const registry = new StagedMaterialRegistry();
        const set = meshes(10);
        for (const { mesh } of set) registry.apply(mesh, { reveal: { progress: 0.5, stagger: 0, fade: 0.5, presence: 1 } }, OPTS);
        for (const { mesh } of set) registry.apply(mesh, null, OPTS);
        expect(registry.size).toBe(0);
        for (const { mesh, base } of set) expect(mesh.material).toBe(base);
    });
});

describe('work sweep', () => {
    test('a staged material takes the sweep from the look and drops it when the stage ends', () => {
        const registry = new StagedMaterialRegistry();
        const geometry = new THREE.BoxGeometry(1, 1, 1);
        const mesh = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial());
        const sweep = { phase: 0.4, fill: 0.25, minY: -2, maxY: 30, color: new THREE.Vector3(0.65, 0.71, 0.99) };
        registry.apply(mesh, { work: sweep }, { allowCreate: true, pxScale: 1, classCount: 1, restores: { left: 10 } });
        const m = mesh.material as THREE.Material;
        expect(isStagedMaterial(m)).toBe(true);
        expect(stagedMaterialUniforms(m)?.work).toEqual({ phase: 0.4, fill: 0.25, minY: -2, maxY: 30 });
        registry.beginFrame();
        registry.apply(mesh, { mark: true }, { allowCreate: true, pxScale: 1, classCount: 1, restores: { left: 10 } });
        expect(stagedMaterialUniforms(mesh.material as THREE.Material)?.work).toBeUndefined();
    });
});
