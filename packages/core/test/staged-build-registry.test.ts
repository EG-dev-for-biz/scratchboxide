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
import * as fs from 'fs';
import * as path from 'path';
import { StagedMaterialRegistry, createStagedMaterial, isStagedMaterial, stagedMaterialUniforms } from '../src/browser/generative-canvas/primitives/scene3d/stagedBuild/revealMaterial';
import { makeFadeVariant } from '../src/browser/generative-canvas/primitives/scene3d/treeLod/treeLodFade';
import { LEAF_FRAGMENT_TRANSLUCENCY, LEAF_VERTEX_MAIN, TINT_FRAGMENT_COLOR, TreeTextureLibrary } from '../src/browser/generative-canvas/primitives/scene3d/treeLod/treeTextureMaterials';
import type { TreeTextureIndex } from '../src/common/spatial/tree-texture-library';

const TREE_INDEX = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../../assets/textures/trees/index.json'), 'utf8')) as TreeTextureIndex;

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

describe('a reveal keeps the base shader', () => {
    // the shader three would compile for a material: the standard source, through its onBeforeCompile
    const compiled = (mat: THREE.Material) => {
        const std = THREE.ShaderLib.standard;
        const shader = { uniforms: THREE.UniformsUtils.clone(std.uniforms), vertexShader: std.vertexShader, fragmentShader: std.fragmentShader } as unknown as THREE.WebGLProgramParametersWithUniforms;
        mat.onBeforeCompile(shader, {} as THREE.WebGLRenderer);
        return shader;
    };
    const lib = new TreeTextureLibrary(TREE_INDEX, '/assets/textures/trees/', () => new THREE.Texture());
    const sweep = { phase: 0.4, fill: 0.25, minY: -2, maxY: 30, color: new THREE.Vector3(0.65, 0.71, 0.99) };
    const dressed = (base: THREE.Material, look: Parameters<StagedMaterialRegistry['apply']>[1]) => {
        const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), base);
        new StagedMaterialRegistry().apply(mesh, look, { ...OPTS, restores: { left: 10 } });
        expect(isStagedMaterial(mesh.material as THREE.Material)).toBe(true);
        return mesh.material as THREE.Material;
    };

    test('the trees\' far masses keep their tint under the work sweep (they drew white while a stage ran)', () => {
        expect(lib.masses.color.getHex(), 'the masses take their whole colour from the tint').toBe(0xffffff);
        const s = compiled(dressed(lib.masses, { work: sweep }));
        expect(s.fragmentShader).toContain(TINT_FRAGMENT_COLOR.trim().slice(0, 30));
        expect(s.vertexShader).toContain('attribute vec4 sbTreeTint;');
        expect(s.uniforms.uSbNoise, 'the masses\' noise uniform').toBeDefined();
        expect(s.fragmentShader).toContain('if (uSbWork > 0.5)');
        expect(s.uniforms.uSbWork, 'the sweep\'s uniform').toBeDefined();
    });

    test('revealing leaves keep their atlas mapping, tint and translucency beside the reveal\'s discard', () => {
        const leaves = lib.leafMaterial('leaves_01')!;
        const s = compiled(dressed(leaves, { reveal: { progress: 0.4, stagger: 0.3, fade: 1, presence: 1 } }));
        expect(s.vertexShader).toContain(LEAF_VERTEX_MAIN.trim().slice(0, 60));
        expect(s.fragmentShader).toContain(LEAF_FRAGMENT_TRANSLUCENCY.trim().slice(0, 40));
        expect(s.uniforms.uSbCellA).toBeDefined();
        expect(s.vertexShader).toContain('uniform float uSbProgress;');
        expect(s.uniforms.uSbProgress).toBeDefined();
    });

    test('a reveal shares a program only with reveals of bases patched the same way', () => {
        const key = (m: THREE.Material) => m.customProgramCacheKey();
        const plainA = dressed(new THREE.MeshStandardMaterial({ color: 0xb0b8c4 }), { work: sweep });
        const plainB = dressed(new THREE.MeshStandardMaterial({ color: 0x808080 }), { work: sweep });
        const masses = dressed(lib.masses, { work: sweep });
        const leaves = dressed(lib.leafMaterial('leaves_01')!, { work: sweep });
        expect(key(plainA)).toBe(key(plainB));
        expect(new Set([key(plainA), key(masses), key(leaves)]).size).toBe(3);
        // a provenance look draws the legend colours, not the base: nothing of the base's shader goes with it
        const prov = dressed(lib.masses, { provenance: { nodeColor: '#ff0000', nodePattern: 0, nodeCoverage: 0, classCount: 1, classColors: [new THREE.Color(0xff0000)], classPatterns: [new THREE.Vector2(0, 0)] } });
        expect(compiled(prov).fragmentShader).not.toContain(TINT_FRAGMENT_COLOR.trim().slice(0, 30));
    });

    test('a tree level dressed mid-dissolve is drawn whole: the dither is not frozen into the held reveal', () => {
        const fading = makeFadeVariant(lib.masses, 2, 5, false);
        expect(compiled(fading).fragmentShader, 'the variant drops fragments outside its range').toContain('uSbRange');
        const staged = dressed(fading, { work: sweep });
        const s = compiled(staged);
        expect(s.fragmentShader).not.toContain('uSbRange');
        expect(s.fragmentShader).toContain(TINT_FRAGMENT_COLOR.trim().slice(0, 30));
        expect(staged.customProgramCacheKey()).toBe(dressed(lib.masses, { work: sweep }).customProgramCacheKey());
        expect(staged.userData.sbLodVariant, 'not marked as a dissolve either').toBeUndefined();
    });

    test('a staged material handed in as the base (another copy of the module across a hot reload) is not patched twice', () => {
        const first = dressed(lib.masses, { work: sweep });
        const second = compiled(createStagedMaterial(new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), first), first, 'reveal', 1));
        expect(second.fragmentShader.split('uniform float uSbProgress;').length - 1, 'one declaration, or GLSL refuses the program').toBe(1);
    });
});
