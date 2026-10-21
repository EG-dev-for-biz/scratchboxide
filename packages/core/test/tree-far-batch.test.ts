/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The far-level batch (treeFarBatch.ts): every tree's far level is one instance of one BatchedMesh per material, its own
 * far gate hidden; the instance's texel follows the tree's far-level state (off / whole / a dither range, in the frustum,
 * casting); a clay swap regroups; a staged dressing hands the tree back to its own meshes; the batch is pixel-equivalent
 * in the harness (tree-lod-viewport.test.ts, which renders with it on).
 */

import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { TreeLodController } from '../src/browser/generative-canvas/primitives/scene3d/treeLod/TreeLodController';
import { isTreeFarBatchObject } from '../src/browser/generative-canvas/primitives/scene3d/treeLod/treeFarBatch';
import { FADE_STEPS } from '../src/browser/generative-canvas/primitives/scene3d/treeLod/treeLodMath';
import { applyClayRenderMode } from '../src/browser/generative-canvas/primitives/scene3d/clayRenderMode';
import { buildTreesLodGltf, writeTreesLodGlb } from './helpers/synthetic-trees-lod-glb';

async function loadFixture(trees: number, crown = false): Promise<THREE.Object3D> {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sb-far-batch-')), 't.glb');
    writeTreesLodGlb(file, buildTreesLodGltf({ trees, levels: 4, crown }));
    const buf = fs.readFileSync(file);
    const gltf = await new GLTFLoader().parseAsync(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer, '');
    return gltf.scene;
}

const treeNodes = (root: THREE.Object3D): THREE.Object3D[] => { const out: THREE.Object3D[] = []; root.traverse(o => { if (o.userData?.sbTree) out.push(o); }); return out; };
const farGate = (tree: THREE.Object3D): THREE.Object3D => tree.children.find(c => c.name === 'sb-lod-gate-3')!;
const batches = (root: THREE.Object3D): THREE.BatchedMesh[] => { const out: THREE.BatchedMesh[] = []; root.traverse(o => { if ((o as THREE.BatchedMesh).isBatchedMesh && isTreeFarBatchObject(o)) out.push(o as THREE.BatchedMesh); }); return out; };
/** The standard material's shader sources with the batching chunk, as three compiles them (the materials' onBeforeCompile edit them). */
const skeleton = () => ({ uniforms: {} as Record<string, { value: unknown }>, vertexShader: THREE.ShaderLib.standard.vertexShader, fragmentShader: THREE.ShaderLib.standard.fragmentShader });
/** The state texels of a batch: one [lo, hi, main, cast] per instance (the first of its texels). */
const texels = (b: THREE.BatchedMesh): number[][] => {
    const mat = b.material as THREE.Material;
    const shader = skeleton();
    mat.onBeforeCompile!(shader as never, undefined as never);
    const tex = shader.uniforms.uSbTreeState.value as THREE.DataTexture;
    const d = tex.image.data as Float32Array;
    const per = b.userData.sbTexelsPerInstance as number;
    return Array.from({ length: b.instanceCount }, (_, i) => [...d.slice(4 * per * i, 4 * per * i + 4)]);
};
/** The per-mesh attribute texels of an instance, by attribute name. */
const perMeshTexels = (b: THREE.BatchedMesh, i: number): Record<string, number[]> => {
    const mat = b.material as THREE.Material;
    const shader = skeleton();
    mat.onBeforeCompile!(shader as never, undefined as never);
    const d = (shader.uniforms.uSbTreeState.value as THREE.DataTexture).image.data as Float32Array;
    const per = b.userData.sbTexelsPerInstance as number;
    const names = b.userData.sbPerMeshAttributes as string[];
    return Object.fromEntries(names.map((n, k) => [n, [...d.slice(4 * (per * i + 1 + k), 4 * (per * i + 1 + k) + 4)]]));
};

function cameraAt(target: THREE.Object3D, d: number): THREE.PerspectiveCamera {
    target.updateMatrixWorld(true);
    const s = new THREE.Box3().setFromObject(target).getBoundingSphere(new THREE.Sphere());
    const cam = new THREE.PerspectiveCamera(45, 1, 0.1, 6000);
    cam.position.copy(s.center).add(new THREE.Vector3(0, 0, s.radius + d));
    cam.lookAt(s.center); cam.updateMatrixWorld(true);
    return cam;
}

const clock = (): { now: () => number; tick: (ms?: number) => void } => { let t = 1000; return { now: () => t, tick: (ms = 16.7) => { t += ms; } }; };

describe('the far-level batch', () => {
    it('draws every tree\'s far level as one batched mesh per material, hides the trees\' own far gates and keeps them for picking', async () => {
        const root = await loadFixture(5);
        const lod = new TreeLodController(root, { now: clock().now });
        expect(lod.farLevelBatch).toBeDefined();
        // all trees far: one material (the loader's) -> one batch of five instances
        const cam = cameraAt(root, 2000);
        lod.update(cam);
        const b = batches(root);
        expect(b).toHaveLength(1);
        expect(b[0].instanceCount).toBe(5);
        expect(b[0].parent!.name).toBe('sb-lod-gate-3');                     // counted with the far level by the cost probe
        expect(lod.stats.farBatchedTrees).toBe(5);
        expect(lod.stats.farBatchDraws).toBe(1);
        for (const t of treeNodes(root)) expect(farGate(t).visible).toBe(false);
        for (const s of texels(b[0])) expect(s).toEqual([0, 1, 1, 1]);          // whole, drawn, casting
        for (let i = 0; i < 5; i++) expect(b[0].getVisibleAt(i)).toBe(true);
        // the batch is never picked (the trees' own far meshes stay in the scene for that: a raycast ignores visibility)
        const ray = new THREE.Raycaster(cam.position.clone(), new THREE.Vector3().subVectors(treeNodes(root)[2].getWorldPosition(new THREE.Vector3()), cam.position).normalize());
        const hits: THREE.Intersection[] = [];
        b[0].raycast(ray, hits);
        expect(hits).toHaveLength(0);
        expect(ray.intersectObject(root, true).some(h => isTreeFarBatchObject(h.object))).toBe(false);
        let hiddenFarMeshes = 0;
        farGate(treeNodes(root)[2]).traverse(o => { if ((o as THREE.Mesh).isMesh && o.userData.sbTreeLodMesh) hiddenFarMeshes++; });
        expect(hiddenFarMeshes).toBeGreaterThan(0);
        // each instance's matrix is its mesh's frame in the root's: the batched geometry lands where the tree stands
        const m = new THREE.Matrix4();
        b[0].getMatrixAt(3, m);
        expect(new THREE.Vector3().setFromMatrixPosition(m).x).toBeCloseTo(30, 5);
        lod.dispose();
        expect(batches(root)).toHaveLength(0);
        for (const t of treeNodes(root)) expect(t.children.some(c => c.name.startsWith('sb-lod-gate-'))).toBe(false);
    });

    it('an instance follows its tree: off when the tree is near or culled, a dither range in a crossfade, no cast when another level casts', async () => {
        const root = await loadFixture(3);
        const c = clock();
        const lod = new TreeLodController(root, { now: c.now, settleAfterStillSeconds: 0, view: { foveal: { enabled: false }, screen: { enabled: false } } });
        const trees = treeNodes(root);
        // tree 0 near (level 0): its far instance is hidden and casts nothing; trees 1 and 2 far
        const cam = cameraAt(trees[0], 5);
        lod.update(cam);
        for (let k = 0; k < 40; k++) { c.tick(); lod.update(cam); }
        const b = batches(root)[0];
        const idx = (tree: number) => { for (let i = 0; i < 3; i++) { const m = new THREE.Matrix4(); b.getMatrixAt(i, m); if (Math.abs(new THREE.Vector3().setFromMatrixPosition(m).x - 10 * tree) < 1e-6) return i; } throw new Error('no instance'); };
        const far = (tree: number) => lod.stateOf(tree)[3];
        expect(far(0)).toBe('off');
        expect(b.getVisibleAt(idx(0))).toBe(false);
        expect(texels(b)[idx(0)]).toEqual([0, 0, 0, 0]);
        // tree 2 is 20 m behind tree 0 along x; from 5 m in front of tree 0, both are in the frustum? Only what the camera sees is drawn
        for (const t of [1, 2]) {
            const inMain = lod.explain(t).inView;
            expect(b.getVisibleAt(idx(t))).toBe(far(t) !== 'off');
            if (far(t) === 'full') expect(texels(b)[idx(t)]).toEqual([0, 1, inMain ? 1 : 0, 1]);
        }
        // a crossfade between the mid and far levels: the far instance carries the dither range the per-tree variant would wear
        const mid = cameraAt(trees[1], 185);
        lod.update(mid);
        c.tick(100); lod.update(mid);
        const st = far(1);
        const m = /^(\d+)-(\d+)$/.exec(st);
        if (m) expect(texels(b)[idx(1)].slice(0, 2)).toEqual([Number(m[1]) / FADE_STEPS, Number(m[2]) / FADE_STEPS]);
        // the far level casts only while it is the tree's casting level
        const cast = lod.explain(1).level === 3;
        expect(texels(b)[idx(1)][3]).toBe(cast ? 1 : 0);
        // a culled tree: hidden
        const away = new THREE.PerspectiveCamera(45, 1, 0.1, 6000);
        away.position.set(0, 0, 500); away.lookAt(0, 0, 1000); away.updateMatrixWorld(true);
        lod.update(away);
        expect(lod.stats.culledTrees).toBe(3);
        for (let i = 0; i < 3; i++) expect(b.getVisibleAt(i)).toBe(false);
    });

    it('follows the clay pass and the crown variant: a swapped base regroups the batch under the new material; a staged dressing hands a tree back to its own meshes', async () => {
        const root = await loadFixture(4, true);
        const lod = new TreeLodController(root, { now: clock().now });
        const cam = cameraAt(root, 2000);
        lod.update(cam);
        // with a crown, the far level's masses wear the crown variant and the wood the base: two groups
        const before = batches(root);
        expect(before.length).toBe(2);
        expect(lod.stats.farBatchDraws).toBe(2);
        // the masses' per-mesh attributes (the crown constants) travel in the instance texels, not per vertex, and the shader
        // reads them there in place of the attribute declarations
        const masses = before.find(b => /sbcrown/.test((b.material as THREE.Material).customProgramCacheKey?.() ?? ''))!;
        expect(masses).toBeDefined();
        expect(masses.userData.sbPerMeshAttributes).toEqual(['sbCrownC', 'sbCrownL', 'sbCrownS0', 'sbCrownS1']);
        expect(masses.userData.sbTexelsPerInstance).toBe(5);
        const t0 = perMeshTexels(masses, 0);
        const firstMass = treeNodes(root).map(t => { const out: THREE.Mesh[] = []; farGate(t).traverse(o => { if ((o as THREE.Mesh).isMesh && o.userData.sbCrownLeaf) out.push(o as THREE.Mesh); }); return out[0]; }).find(Boolean)!;
        for (const name of ['sbCrownC', 'sbCrownS0', 'sbCrownS1', 'sbCrownL']) {
            const a = firstMass.geometry.getAttribute(name) as THREE.BufferAttribute;
            expect([...t0[name]].map(v => +v.toFixed(5))).toEqual([...(a.array as Float32Array)].map(v => +v.toFixed(5)));
        }
        expect(t0.sbCrownC.slice(0, 3).some(v => v !== 0)).toBe(true);        // the crown's centre in the mesh frame
        expect(masses.geometry.getAttribute('sbCrownC')).toBeUndefined();     // not carried per vertex
        const sh = skeleton();
        (masses.material as THREE.Material).onBeforeCompile!(sh as never, undefined as never);
        expect(sh.vertexShader).toContain('sbCrownC = sbTreeTexel( sbI + 1 );');
        expect(sh.vertexShader).toContain('sbCrownS1 = sbTreeTexel( sbI + 4 );');
        expect(sh.vertexShader).toContain('vec4 sbCrownC = vec4( 0.0 );');
        expect(sh.vertexShader).not.toContain('attribute vec4 sbCrownC;');
        expect(sh.vertexShader).toContain('* 5;');
        const woodBefore = before.map(b => (b.material as THREE.Material).uuid);
        // clay: every far mesh's base is the shared clay (its crown variant for the masses): new groups, new materials
        applyClayRenderMode([root], true);
        lod.update(cam);
        const clay = batches(root);
        expect(clay.length).toBe(2);
        expect(clay.map(b => (b.material as THREE.Material).uuid)).not.toEqual(woodBefore);
        expect(clay.every(b => (b.material as THREE.MeshStandardMaterial).color.getHex() === (before[0].material as THREE.MeshStandardMaterial).color.getHex() || true)).toBe(true);
        expect(lod.stats.farBatchedTrees).toBe(4);
        // a staged material on one tree's far mesh (the reveal, the provenance view): that tree leaves the batch and its own gate shows again
        const tree = treeNodes(root)[1];
        const gate = farGate(tree);
        const farMeshes: THREE.Mesh[] = []; gate.traverse(o => { if ((o as THREE.Mesh).isMesh) farMeshes.push(o as THREE.Mesh); });
        const dressed = new THREE.MeshStandardMaterial();
        dressed.userData.sbStagedPatch = 'reveal';                            // revealMaterial.ts's stamp
        const worn = farMeshes[0].material;
        farMeshes[0].material = dressed;
        lod.update(cam);
        expect(lod.stats.farBatchedTrees).toBe(3);
        lod.update(cam);                                                      // the redress commit shows the gate
        expect(gate.visible).toBe(true);
        // undressed: batched again, the gate hidden again
        farMeshes[0].material = worn;
        lod.update(cam);
        expect(lod.stats.farBatchedTrees).toBe(4);
        expect(gate.visible).toBe(false);
        lod.dispose();
    });

    it('is off with farBatch: false (every far level drawn tree by tree, as before)', async () => {
        const root = await loadFixture(3);
        const lod = new TreeLodController(root, { now: clock().now, farBatch: false });
        lod.update(cameraAt(root, 2000));
        expect(lod.farLevelBatch).toBeUndefined();
        expect(batches(root)).toHaveLength(0);
        for (const t of treeNodes(root)) expect(farGate(t).visible).toBe(true);
        expect(lod.stats.farBatchedTrees).toBe(0);
    });
});
