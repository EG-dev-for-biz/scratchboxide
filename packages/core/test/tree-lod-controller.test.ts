/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/


import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { TreeLodController } from '../src/browser/generative-canvas/primitives/scene3d/treeLod/TreeLodController';
import { levelRange, quantiseRange, targetEdges } from '../src/browser/generative-canvas/primitives/scene3d/treeLod/treeLodMath';
import { applyClayRenderMode, sharedTreeClayMaterial } from '../src/browser/generative-canvas/primitives/scene3d/clayRenderMode';
import { buildRootInfo } from '../src/browser/generative-canvas/primitives/scene3d/stagedBuild/useStagedBuild';
import { buildTreesLodGltf, writeTreesLodGlb } from './helpers/synthetic-trees-lod-glb';
import type { StagedLayer } from '../src/common/spatial/staged-location-contracts';

async function loadFixture(trees: number, stack?: boolean): Promise<THREE.Object3D> {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sb-lod-')), 't.glb');
    writeTreesLodGlb(file, buildTreesLodGltf({ trees }));
    const buf = fs.readFileSync(file);
    const gltf = await new GLTFLoader().parseAsync(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer, '');
    if (stack) gltf.scene.children.forEach(c => c.position.set(0.01 * c.id % 0.5, 0, 0));   // all trees at one distance
    return gltf.scene;
}

const treeNodes = (root: THREE.Object3D): THREE.Object3D[] => { const out: THREE.Object3D[] = []; root.traverse(o => { if (o.userData?.sbTree) out.push(o); }); return out; };

function sphereOf(o: THREE.Object3D): THREE.Sphere { return new THREE.Box3().setFromObject(o).getBoundingSphere(new THREE.Sphere()); }

/** A camera `d` metres from the nearest point of the tree's sphere, looking at it. */
function cameraAt(tree: THREE.Object3D, d: number, cam = new THREE.PerspectiveCamera(60, 1, 0.1, 6000)): THREE.PerspectiveCamera {
    tree.updateMatrixWorld(true);
    const s = sphereOf(tree);
    cam.position.copy(s.center).add(new THREE.Vector3(0, 0, s.radius + d));
    cam.lookAt(s.center); cam.updateMatrixWorld(true);
    return cam;
}

const clock = (): { now: () => number; tick: (ms?: number) => void } => { let t = 1000; return { now: () => t, tick: (ms = 16.7) => { t += ms; } }; };

describe('TreeLodController on the contract fixture', () => {
    it('adopts every tree, gates its three levels and keeps the loader\'s wood and cluster meshes', async () => {
        const root = await loadFixture(3);
        const lod = new TreeLodController(root);
        expect(lod.treeCount).toBe(3);
        for (const tree of treeNodes(root)) {
            const gates = tree.children.filter(c => c.name.startsWith('sb-lod-gate-'));
            expect(gates).toHaveLength(3);
            gates.forEach((g, k) => { expect(g.visible).toBe(false); expect(g.children).toHaveLength(1); expect(g.children[0].userData.sbLod.level).toBe(k); });
        }
        const clusters: THREE.InstancedMesh[] = [];
        root.traverse(o => { if ((o as THREE.InstancedMesh).isInstancedMesh) clusters.push(o as THREE.InstancedMesh); });
        expect(clusters).toHaveLength(3 * 2 * 2);                     // 3 trees x levels 0 and 1 x 2 cluster nodes
        expect(clusters.every(c => c.count >= 2 && c.userData.sbTreeLodMesh)).toBe(true);
        expect(new TreeLodController(new THREE.Group()).hasTrees).toBe(false);
    });

    it('shows one pure level inside each band and splits the hash between two levels across an overlap', async () => {
        const root = await loadFixture(1);
        const c = clock();
        const lod = new TreeLodController(root, { now: c.now });
        const tree = treeNodes(root)[0];
        lod.update(cameraAt(tree, 20)); expect(lod.stateOf(0)).toEqual(['full', 'off', 'off']);
        lod.forceLevel(null); c.tick(5000);
        lod.update(cameraAt(tree, 120)); lod.update(cameraAt(tree, 120));
        // the dissolve is rate limited, so let it finish
        for (let i = 0; i < 40; i++) { c.tick(); lod.update(cameraAt(tree, 120)); }
        expect(lod.stateOf(0)).toEqual(['off', 'full', 'off']);
        for (let i = 0; i < 80; i++) { c.tick(); lod.update(cameraAt(tree, 600)); }
        expect(lod.stateOf(0)).toEqual(['off', 'off', 'full']);
        // inside the 0|1 overlap (50-60 m): two levels, ranges that meet at one step
        for (let i = 0; i < 80; i++) { c.tick(); lod.update(cameraAt(tree, 55)); }
        const [a, b, z] = lod.stateOf(0);
        expect(z).toBe('off');
        const [aLo, aHi] = a.split('-').map(Number), [bLo, bHi] = b.split('-').map(Number);
        expect(aLo).toBe(0); expect(bHi).toBe(16); expect(aHi).toBe(bLo);
        expect(aHi).toBeGreaterThan(0); expect(aHi).toBeLessThan(16);
    });

    it('changes the draw ranges only at a bounded rate, with the ranges always tiling the hash (no pop, no hole)', async () => {
        const root = await loadFixture(1);
        const c = clock();
        const lod = new TreeLodController(root, { now: c.now, fadeSeconds: 0.35 });
        const tree = treeNodes(root)[0];
        lod.update(cameraAt(tree, 20));
        const e0 = lod.edgesOf(0); expect(e0).toEqual({ e0: 1, e1: 1 });
        let frames = 0, prev = e0;
        for (; frames < 200; frames++) {
            c.tick(16.7);
            lod.update(cameraAt(tree, 600));                           // a jump straight to the far level
            const e = lod.edgesOf(0);
            expect(Math.abs(e.e0 - prev.e0)).toBeLessThanOrEqual(16.7 / 350 + 1e-9);
            expect(Math.abs(e.e1 - prev.e1)).toBeLessThanOrEqual(16.7 / 350 + 1e-9);
            const r = [0, 1, 2].map(k => levelRange(e, k as 0 | 1 | 2));
            expect(r[0][1]).toBe(r[1][0]); expect(r[1][1]).toBe(r[2][0]);
            prev = e;
            if (e.e0 === 0 && e.e1 === 0) break;
        }
        expect(frames).toBeGreaterThanOrEqual(19); expect(frames).toBeLessThanOrEqual(25);   // about fadeSeconds
    });

    it('does not retarget when the camera shakes inside the dead band', async () => {
        const root = await loadFixture(1);
        const c = clock();
        const lod = new TreeLodController(root, { now: c.now, hysteresisM: 2 });
        const tree = treeNodes(root)[0];
        for (let i = 0; i < 40; i++) { c.tick(); lod.update(cameraAt(tree, 55)); }
        const settled = lod.edgesOf(0);
        let commits = 0;
        for (let i = 0; i < 30; i++) { c.tick(); lod.update(cameraAt(tree, 55 + (i % 2 ? 0.9 : -0.9))); commits += lod.stats.commits; }
        expect(lod.edgesOf(0)).toEqual(settled);
        expect(commits).toBe(0);
        // a real move beyond the band does retarget
        for (let i = 0; i < 40; i++) { c.tick(); lod.update(cameraAt(tree, 70)); }
        expect(lod.edgesOf(0).e0).toBeLessThan(settled.e0);
    });

    it('culls trees outside the frustum with one write and does no other work for them', async () => {
        const root = await loadFixture(5);
        const lod = new TreeLodController(root);
        const cam = new THREE.PerspectiveCamera(60, 1, 0.1, 6000);
        cam.position.set(0, 0, 100); cam.lookAt(0, 0, 200); cam.updateMatrixWorld(true);   // looking away from every tree
        lod.update(cam);
        expect(lod.stats.culledTrees).toBe(5); expect(lod.stats.visibleTrees).toBe(0);
        expect(treeNodes(root).every(t => !t.visible)).toBe(true);
        expect(lod.stats.commits).toBe(0); expect(lod.stats.estimatedTriangles).toBe(0);
        lod.update(cameraAt(treeNodes(root)[0], 30));
        expect(treeNodes(root)[0].visible).toBe(true);
        expect(lod.stats.culledTrees).toBeGreaterThan(0);
    });

    it('keeps to its per-frame work budgets, nearest tree first, and finishes over the next frames', async () => {
        const root = await loadFixture(40);
        const c = clock();
        const lod = new TreeLodController(root, { now: c.now, maxCommitsPerFrame: 10 });
        const cam = new THREE.PerspectiveCamera(60, 1, 0.1, 6000);
        cam.position.set(200, 10, 700); cam.lookAt(200, 0, 0); cam.updateMatrixWorld(true);
        lod.update(cam);
        expect(lod.stats.visibleTrees).toBe(40);
        expect(lod.stats.commits).toBe(10); expect(lod.stats.deferredCommits).toBe(30);
        const done = treeNodes(root).filter((_, i) => lod.stateOf(i)[2] === 'full').length;
        expect(done).toBe(10);
        for (let f = 0; f < 3; f++) { c.tick(); lod.update(cam); }
        expect(treeNodes(root).every((_, i) => lod.stateOf(i)[2] === 'full')).toBe(true);
    });

    it('limits new dither variants per frame and shares them between trees', async () => {
        const root = await loadFixture(12, true);
        const c = clock();
        const lod = new TreeLodController(root, { now: c.now, maxNewVariantsPerFrame: 2 });
        const t0 = treeNodes(root)[0];
        const cam = cameraAt(t0, 55);
        lod.update(cam);                                              // snapped straight into the overlap: 4 variants needed (2 levels x wood/leaves)
        expect(lod.stats.newVariants).toBe(2);
        c.tick(); lod.update(cam); c.tick(); lod.update(cam);
        const mats = new Set<THREE.Material>();
        root.traverse(o => { const m = o as THREE.Mesh; if (m.isMesh && m.userData.sbTreeLodMesh && m.material !== m.userData.sbLodBase) mats.add(m.material as THREE.Material); });
        expect(mats.size).toBe(4);                                    // 12 trees share 4 variants
    });

    it('holds the farthest trees a level down first when the estimate is over the triangle budget, and none when there is room', async () => {
        const root = await loadFixture(3);
        const trees = treeNodes(root);
        trees.forEach((t, i) => t.position.x += i * 40);              // three trees, 40 m apart along x
        root.updateMatrixWorld(true);
        const cam = cameraAt(trees[0], 8);
        cam.position.x -= 30; cam.lookAt(trees[1].position); cam.updateMatrixWorld(true);
        const c = clock();
        const tight = new TreeLodController(root, { now: c.now, triangleBudget: 1 });
        tight.update(cam);
        expect(tight.stats.demotedTrees).toBeGreaterThan(0);
        // the nearest tree is the last to give anything up
        const nearest = [0, 1, 2].reduce((a, k) => (trees[k].position.distanceTo(cam.position) < trees[a].position.distanceTo(cam.position) ? k : a), 0);
        const farthest = [0, 1, 2].reduce((a, k) => (trees[k].position.distanceTo(cam.position) > trees[a].position.distanceTo(cam.position) ? k : a), 0);
        for (let i = 0; i < 120; i++) { c.tick(); tight.update(cam); }
        const level = (k: number) => { const e = tight.edgesOf(k); return e.e0 > 0.5 ? 0 : e.e1 > 0.5 ? 1 : 2; };
        expect(level(farthest)).toBeGreaterThanOrEqual(level(nearest));
        const roomy = new TreeLodController(await loadFixture(1), { now: c.now, triangleBudget: 1e9 });
        for (let i = 0; i < 20; i++) { c.tick(); roomy.update(cameraAt(treeNodes(roomy.root)[0], 30)); }
        expect(roomy.stats.demotedTrees).toBe(0);
    });

    it('gives wood and leaves, at every level and in every dissolve state, one shared clay grey', async () => {
        const root = await loadFixture(2);
        const decoy = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshStandardMaterial({ color: 0x123456 }));
        root.add(decoy);
        const c = clock();
        const lod = new TreeLodController(root, { now: c.now });
        applyClayRenderMode([root], true);
        const shared = sharedTreeClayMaterial();
        const meshes: THREE.Mesh[] = [];
        root.traverse(o => { const m = o as THREE.Mesh; if (m.isMesh && m.userData.sbTreeLodMesh) meshes.push(m); });
        expect(meshes.length).toBeGreaterThan(10);
        expect(meshes.every(m => m.material === shared)).toBe(true);
        expect(decoy.material).not.toBe(shared);                      // other meshes keep their own clay
        const tree = treeNodes(root)[0];
        for (let i = 0; i < 6; i++) { c.tick(); lod.update(cameraAt(tree, 55)); }
        const worn = new Set(meshes.filter(m => m.material !== shared).map(m => m.material as THREE.MeshStandardMaterial));
        expect(worn.size).toBeGreaterThan(0);
        for (const m of worn) { expect(m.color.getHex()).toBe(shared.color.getHex()); expect(m.roughness).toBe(shared.roughness); expect(m.userData.sbLodVariant).toBe(true); }
        // leaving clay puts the loader's materials back as the base
        applyClayRenderMode([root], false);
        expect(meshes.every(m => m.userData.sbLodBase !== shared && m.material === m.userData.sbLodBase)).toBe(true);
        lod.dispose();
        expect(treeNodes(root)[0].children.some(ch => ch.name.startsWith('sb-lod-gate-'))).toBe(false);
    });

    it('is labelled by its layer at every level: one node per tree, wood and clusters of all three levels in it', async () => {
        const root = await loadFixture(3);
        new TreeLodController(root);
        const layer = {
            objectId: 'stg-x-l5', stage: 'trees', layer: 'l5', order: 5, url: 'x', bytes: 1,
            provenance: { label: 'grown to the measured crown' }, provenanceLabels: ['grown to the measured crown'], supersedes: [], revealAfter: [],
            reveal: { durationMs: 1000, stagger: 0.5, crossfadeFrom: [] }
        } as unknown as StagedLayer;
        const info = buildRootInfo(layer, root, undefined);
        expect(info.nodes).toHaveLength(3);
        for (const n of info.nodes) {
            expect(n.provenance.label).toBe('grown to the measured crown');
            const levels = new Set<number>();
            for (const m of n.meshes) for (let o: THREE.Object3D | null = m; o; o = o.parent) if (o.userData?.sbLod) { levels.add(o.userData.sbLod.level); break; }
            expect([...levels].sort()).toEqual([0, 1, 2]);
            expect(n.meshes.some(m => (m as THREE.InstancedMesh).isInstancedMesh)).toBe(true);
        }
        const json = JSON.stringify(info.nodes.map(n => n.provenance));
        expect(json).not.toMatch(/species|oak|maple|elm/i);
    });

    it('draws the same hash exactly once across a crossfade: quantised ranges of the three levels tile 0..FADE_STEPS', () => {
        for (let d = 0; d <= 300; d += 3) {
            const e = targetEdges(d, [{ minDistM: 0, maxDistM: 60, fadeM: 10 }, { minDistM: 50, maxDistM: 200, fadeM: 30 }, { minDistM: 170, maxDistM: 1e6, fadeM: 60 }]);
            let covered = 0;
            for (const k of [0, 1, 2] as const) {
                const q = quantiseRange(levelRange(e, k));
                covered += q === null ? 0 : q === 'full' ? 16 : q[1] - q[0];
            }
            expect(covered).toBe(16);
        }
    });
});

describe('TreeLodController shadows', () => {
    const castingLevels = (tree: THREE.Object3D): number[] => {
        const out: number[] = [];
        for (const g of tree.children.filter(c => c.name.startsWith('sb-lod-gate-'))) {
            let any = false;
            g.traverse(o => { const m = o as THREE.Mesh; if (m.isMesh && m.castShadow) any = true; });
            if (any) out.push(Number(g.name.replace('sb-lod-gate-', '')));
        }
        return out;
    };

    it('lets only the dominant level of a tree in a crossfade cast, and counts the shadow pass in the budget', async () => {
        const root = await loadFixture(1);
        root.traverse(o => { if ((o as THREE.Mesh).isMesh) (o as THREE.Mesh).castShadow = true; });
        const c = clock();
        const lod = new TreeLodController(root, { now: c.now });
        const tree = treeNodes(root)[0];
        const cam = cameraAt(tree, 20);
        const shadowCam = new THREE.OrthographicCamera(-500, 500, 500, -500, 0.1, 2000);
        shadowCam.position.copy(cam.position).add(new THREE.Vector3(0, 400, 0)); shadowCam.lookAt(cam.position); shadowCam.updateMatrixWorld(true);
        lod.update(cam, shadowCam);
        expect(castingLevels(tree)).toEqual([0]);
        expect(lod.stats.estimatedShadowTriangles).toBeGreaterThan(0);
        expect(lod.stats.estimatedShadowTriangles).toBeLessThanOrEqual(lod.stats.estimatedTriangles);
        for (const d of [120, 400]) {
            lod.forceLevel(null);
            for (let i = 0; i < 60; i++) { c.tick(); lod.update(cameraAt(tree, d), shadowCam); }
            expect(castingLevels(tree)).toHaveLength(1);
        }
        lod.dispose();
        let all = true; tree.traverse(o => { const m = o as THREE.Mesh; if (m.isMesh && !m.castShadow) all = false; });
        expect(all).toBe(true);
    });

    it('keeps a tree that only the shadow camera sees drawable, never at the near level', async () => {
        const root = await loadFixture(1);
        root.traverse(o => { if ((o as THREE.Mesh).isMesh) (o as THREE.Mesh).castShadow = true; });
        const lod = new TreeLodController(root, { now: clock().now });
        const tree = treeNodes(root)[0];
        const cam = cameraAt(tree, 20);
        cam.lookAt(cam.position.clone().add(new THREE.Vector3(0, 0, 100))); cam.updateMatrixWorld(true);   // turn away from the tree
        const shadowCam = new THREE.OrthographicCamera(-500, 500, 500, -500, 0.1, 2000);
        shadowCam.position.copy(sphereOf(tree).center).add(new THREE.Vector3(0, 400, 0)); shadowCam.lookAt(sphereOf(tree).center); shadowCam.updateMatrixWorld(true);
        lod.update(cam, shadowCam);
        expect(lod.stats.shadowOnlyTrees).toBe(1);
        expect(tree.visible).toBe(true);
        expect(castingLevels(tree)).toHaveLength(1);
        expect(castingLevels(tree)[0]).toBeGreaterThanOrEqual(1);
        lod.update(cam, null);
        expect(tree.visible).toBe(false);
    });
});

