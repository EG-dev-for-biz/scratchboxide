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

async function loadFixture(trees: number, stack?: boolean, levels: 3 | 4 = 4): Promise<THREE.Object3D> {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sb-lod-')), 't.glb');
    writeTreesLodGlb(file, buildTreesLodGltf({ trees, levels }));
    const buf = fs.readFileSync(file);
    const gltf = await new GLTFLoader().parseAsync(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer, '');
    if (stack) gltf.scene.children.forEach(c => c.position.set(0.01 * c.id % 0.5, 0, 0));   // all trees at one distance
    return gltf.scene;
}

const treeNodes = (root: THREE.Object3D): THREE.Object3D[] => { const out: THREE.Object3D[] = []; root.traverse(o => { if (o.userData?.sbTree) out.push(o); }); return out; };

function sphereOf(o: THREE.Object3D): THREE.Sphere { return new THREE.Box3().setFromObject(o).getBoundingSphere(new THREE.Sphere()); }

/** A camera `d` metres from the nearest point of the tree's sphere, looking at it. */
function cameraAt(tree: THREE.Object3D, d: number, cam = new THREE.PerspectiveCamera(45, 1, 0.1, 6000)): THREE.PerspectiveCamera {
    tree.updateMatrixWorld(true);
    const s = sphereOf(tree);
    cam.position.copy(s.center).add(new THREE.Vector3(0, 0, s.radius + d));
    cam.lookAt(s.center); cam.updateMatrixWorld(true);
    return cam;
}

/** The foveal weight off: a tree in the centre of a 45° view is read at its own distance, as the metre bands did (tree-lod-screen.test.ts covers the weight). */
const CENTRE_AS_METRES = { foveal: { enabled: false } };

const clock = (): { now: () => number; tick: (ms?: number) => void } => { let t = 1000; return { now: () => t, tick: (ms = 16.7) => { t += ms; } }; };

/** The distance crossfade as it stands (a still camera would settle each tree on one level: tree-lod-settle-budget.test.ts). */
const CONTINUOUS = { settleAfterStillSeconds: 0 };

describe('TreeLodController on the contract fixture', () => {
    it('adopts every tree, gates its four levels and keeps the loader\'s wood and cluster meshes', async () => {
        const root = await loadFixture(3);
        const lod = new TreeLodController(root);
        expect(lod.treeCount).toBe(3);
        expect(lod.levelsPerTree).toBe(4);
        for (const tree of treeNodes(root)) {
            const gates = tree.children.filter(c => c.name.startsWith('sb-lod-gate-'));
            expect(gates).toHaveLength(4);
            gates.forEach((g, k) => { expect(g.visible).toBe(false); expect(g.children).toHaveLength(1); expect(g.children[0].userData.sbLod.level).toBe(k); });
        }
        const clusters: THREE.InstancedMesh[] = [];
        root.traverse(o => { if ((o as THREE.InstancedMesh).isInstancedMesh) clusters.push(o as THREE.InstancedMesh); });
        expect(clusters).toHaveLength(3 * 3 * 2);                     // 3 trees x levels 0, 1 and 2 x 2 cluster nodes
        expect(clusters.every(c => c.count >= 2 && c.userData.sbTreeLodMesh)).toBe(true);
        expect(new TreeLodController(new THREE.Group()).hasTrees).toBe(false);
    });

    it('shows one pure level inside each band and splits the hash between two levels across an overlap', async () => {
        const root = await loadFixture(1);
        const c = clock();
        const lod = new TreeLodController(root, { view: CENTRE_AS_METRES, now: c.now, ...CONTINUOUS });
        const tree = treeNodes(root)[0];
        lod.update(cameraAt(tree, 20)); expect(lod.stateOf(0)).toEqual(['full', 'off', 'off', 'off']);
        lod.forceLevel(null); c.tick(5000);
        // the dissolve is rate limited, so let each one finish
        for (let i = 0; i < 40; i++) { c.tick(); lod.update(cameraAt(tree, 80)); }
        expect(lod.stateOf(0)).toEqual(['off', 'full', 'off', 'off']);
        for (let i = 0; i < 40; i++) { c.tick(); lod.update(cameraAt(tree, 140)); }
        expect(lod.stateOf(0)).toEqual(['off', 'off', 'full', 'off']);
        for (let i = 0; i < 80; i++) { c.tick(); lod.update(cameraAt(tree, 600)); }
        expect(lod.stateOf(0)).toEqual(['off', 'off', 'off', 'full']);
        // inside the 1|2 overlap (90-110 m): near-mid and mid, ranges that meet at one step
        for (let i = 0; i < 80; i++) { c.tick(); lod.update(cameraAt(tree, 100)); }
        const [n0, n1, n2, n3] = lod.stateOf(0);
        expect(n0).toBe('off'); expect(n3).toBe('off');
        expect(Number(n1.split('-')[1])).toBe(Number(n2.split('-')[0]));
        // inside the 0|1 overlap (50-60 m): two levels, ranges that meet at one step
        for (let i = 0; i < 80; i++) { c.tick(); lod.update(cameraAt(tree, 55)); }
        const [a, b, y, z] = lod.stateOf(0);
        expect(y).toBe('off'); expect(z).toBe('off');
        const [aLo, aHi] = a.split('-').map(Number), [bLo, bHi] = b.split('-').map(Number);
        expect(aLo).toBe(0); expect(bHi).toBe(16); expect(aHi).toBe(bLo);
        expect(aHi).toBeGreaterThan(0); expect(aHi).toBeLessThan(16);
    });

    it('changes the draw ranges only at a bounded rate, with the ranges always tiling the hash (no pop, no hole)', async () => {
        const root = await loadFixture(1);
        const c = clock();
        const lod = new TreeLodController(root, { view: CENTRE_AS_METRES, now: c.now, fadeSeconds: 0.35 });
        const tree = treeNodes(root)[0];
        lod.update(cameraAt(tree, 20));
        const e0 = lod.edgesOf(0); expect(e0).toEqual([1, 1, 1]);
        let frames = 0, prev = e0;
        for (; frames < 200; frames++) {
            c.tick(16.7);
            lod.update(cameraAt(tree, 600));                           // a jump straight to the far level
            const e = lod.edgesOf(0);
            e.forEach((x, k) => expect(Math.abs(x - prev[k])).toBeLessThanOrEqual(16.7 / 350 + 1e-9));
            const r = [0, 1, 2, 3].map(k => levelRange(e, k));
            for (let k = 0; k < 3; k++) expect(r[k][1]).toBe(r[k + 1][0]);
            prev = e;
            if (e.every(x => x === 0)) break;
        }
        expect(frames).toBeGreaterThanOrEqual(19); expect(frames).toBeLessThanOrEqual(25);   // about fadeSeconds
    });

    it('does not retarget when the camera shakes inside the dead band', async () => {
        const root = await loadFixture(1);
        const c = clock();
        const lod = new TreeLodController(root, { view: CENTRE_AS_METRES, now: c.now, hysteresisM: 2, ...CONTINUOUS });
        const tree = treeNodes(root)[0];
        for (let i = 0; i < 40; i++) { c.tick(); lod.update(cameraAt(tree, 55)); }
        const settled = lod.edgesOf(0);
        let commits = 0;
        for (let i = 0; i < 30; i++) { c.tick(); lod.update(cameraAt(tree, 55 + (i % 2 ? 0.9 : -0.9))); commits += lod.stats.commits; }
        expect(lod.edgesOf(0)).toEqual(settled);
        expect(commits).toBe(0);
        // a real move beyond the band does retarget
        for (let i = 0; i < 40; i++) { c.tick(); lod.update(cameraAt(tree, 70)); }
        expect(lod.edgesOf(0)[0]).toBeLessThan(settled[0]);
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
        const lod = new TreeLodController(root, { view: CENTRE_AS_METRES, now: c.now, maxCommitsPerFrame: 10 });
        const cam = new THREE.PerspectiveCamera(60, 1, 0.1, 6000);
        cam.position.set(200, 10, 700); cam.lookAt(200, 0, 0); cam.updateMatrixWorld(true);
        lod.update(cam);
        expect(lod.stats.visibleTrees).toBe(40);
        expect(lod.stats.commits).toBe(10); expect(lod.stats.deferredCommits).toBe(30);
        const done = treeNodes(root).filter((_, i) => lod.stateOf(i)[3] === 'full').length;
        expect(done).toBe(10);
        for (let f = 0; f < 3; f++) { c.tick(); lod.update(cam); }
        expect(treeNodes(root).every((_, i) => lod.stateOf(i)[3] === 'full')).toBe(true);
    });

    it('limits new dither variants per frame and shares them between trees', async () => {
        const root = await loadFixture(12, true);
        const c = clock();
        const lod = new TreeLodController(root, { view: CENTRE_AS_METRES, now: c.now, maxNewVariantsPerFrame: 2 });
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
        const tight = new TreeLodController(root, { view: CENTRE_AS_METRES, now: c.now, triangleBudget: 1 });
        tight.update(cam);
        expect(tight.stats.demotedTrees).toBeGreaterThan(0);
        // the nearest tree is the last to give anything up
        const nearest = [0, 1, 2].reduce((a, k) => (trees[k].position.distanceTo(cam.position) < trees[a].position.distanceTo(cam.position) ? k : a), 0);
        const farthest = [0, 1, 2].reduce((a, k) => (trees[k].position.distanceTo(cam.position) > trees[a].position.distanceTo(cam.position) ? k : a), 0);
        for (let i = 0; i < 120; i++) { c.tick(); tight.update(cam); }
        const level = (k: number) => { const e = tight.edgesOf(k); const i = e.findIndex(x => x > 0.5); return i < 0 ? e.length : i; };
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
        const lod = new TreeLodController(root, { view: CENTRE_AS_METRES, now: c.now });
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

    it('is labelled by its layer at every level: one node per tree, wood and clusters of all four levels in it', async () => {
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
            expect([...levels].sort()).toEqual([0, 1, 2, 3]);
            expect(n.meshes.some(m => (m as THREE.InstancedMesh).isInstancedMesh)).toBe(true);
        }
        const json = JSON.stringify(info.nodes.map(n => n.provenance));
        expect(json).not.toMatch(/species|oak|maple|elm/i);
    });

    it('draws the same hash exactly once across a crossfade: quantised ranges of the four levels tile 0..FADE_STEPS', () => {
        for (let d = 0; d <= 300; d += 3) {
            const e = targetEdges(d, [{ minDistM: 0, maxDistM: 60, fadeM: 10 }, { minDistM: 50, maxDistM: 110, fadeM: 20 }, { minDistM: 90, maxDistM: 200, fadeM: 30 }, { minDistM: 170, maxDistM: 1e6, fadeM: 60 }]);
            let covered = 0;
            for (const k of [0, 1, 2, 3]) {
                const q = quantiseRange(levelRange(e, k));
                covered += q === null ? 0 : q === 'full' ? 16 : q[1] - q[0];
            }
            expect(covered).toBe(16);
        }
    });
});

describe('TreeLodController: triangle estimates and old three-level files', () => {
    it('estimates what it submits: every level with a share counts in full, and a pure level its own triangles', async () => {
        const root = await loadFixture(1);
        const c = clock();
        const lod = new TreeLodController(root, { view: CENTRE_AS_METRES, now: c.now, ...CONTINUOUS });
        const tree = treeNodes(root)[0];
        // the fixture's levels: 12, 9, 6, 4 wood triangles, plus 2 cluster nodes x instances x 1 triangle at levels 0-2 (3, 2, 2 instances)
        const expected = [12 + 2 * 3, 9 + 2 * 2, 6 + 2 * 2, 4];
        for (const [d, level] of [[20, 0], [80, 1], [140, 2], [600, 3]] as const) {
            for (let i = 0; i < 80; i++) { c.tick(); lod.update(cameraAt(tree, d)); }
            expect(lod.stats.atLevel[level]).toBe(1);
            expect(lod.stats.estimatedTriangles).toBe(expected[level]);
        }
        for (let i = 0; i < 80; i++) { c.tick(); lod.update(cameraAt(tree, 100)); }   // near-mid and mid in a crossfade
        expect(lod.stats.fading).toBe(1);
        expect(lod.stats.estimatedTriangles).toBe(expected[1] + expected[2]);
    });

    it('counts a tree\'s levels when the root carries no schema (extras only at the glTF top level, which the loader does not put on the scene)', async () => {
        for (const levels of [3, 4] as const) {
            const gltf = buildTreesLodGltf({ trees: 2, levels });
            for (const sc of gltf.json.scenes) delete sc.extras;
            const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sb-lodnx-')), 't.glb');
            writeTreesLodGlb(file, gltf);
            const buf = fs.readFileSync(file);
            const root = (await new GLTFLoader().parseAsync(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer, '')).scene;
            expect(root.userData.sbTrees).toBeUndefined();
            const lod = new TreeLodController(root);
            expect(lod.levelsPerTree).toBe(levels);
            expect(lod.treeCount).toBe(2);
            lod.dispose();
        }
    });

    it('loads and renders an old trees-lod/1 file: three levels, the same bands, its mid level shaded as mid', async () => {
        const gltf = buildTreesLodGltf({ trees: 2, levels: 3, crown: true });
        expect(gltf.json.extras.sbTrees.schema).toBe('scratchbox.trees-lod/1');
        const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sb-lod3-')), 't.glb');
        writeTreesLodGlb(file, gltf);
        const buf = fs.readFileSync(file);
        const root = (await new GLTFLoader().parseAsync(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer, '')).scene;
        const c = clock();
        const lod = new TreeLodController(root, { view: CENTRE_AS_METRES, now: c.now });
        expect(lod.treeCount).toBe(2); expect(lod.levelsPerTree).toBe(3);
        const tree = treeNodes(root)[0];
        expect(tree.children.filter(ch => ch.name.startsWith('sb-lod-gate-'))).toHaveLength(3);
        for (const [d, want] of [[20, ['full', 'off', 'off']], [120, ['off', 'full', 'off']], [600, ['off', 'off', 'full']]] as const) {
            for (let i = 0; i < 80; i++) { c.tick(); lod.update(cameraAt(tree, d)); }
            expect(lod.stateOf(0)).toEqual(want);
        }
        // crown slots: near 0, mid 2, far 3
        const slots = new Map<number, number>();
        root.traverse(o => { const m = o as THREE.Mesh; if (m.isMesh && m.userData.sbCrownLeaf) for (let p: THREE.Object3D | null = m; p; p = p.parent) if (p.userData?.sbLod) { slots.set(p.userData.sbLod.level, Math.floor(m.geometry.getAttribute('sbCrownC').getW(0))); break; } });
        expect([...slots.entries()].sort((a, b) => a[0] - b[0])).toEqual([[0, 0], [1, 2], [2, 3]]);
        // a jump to the far level still crossfades through mid without a gap in the hash
        for (let i = 0; i < 80; i++) { c.tick(); lod.update(cameraAt(tree, 20)); }
        for (let i = 0; i < 30; i++) {
            c.tick(); lod.update(cameraAt(tree, 600));
            const e = lod.edgesOf(0);
            expect(e).toHaveLength(2);
            expect(e[1]).toBeGreaterThanOrEqual(e[0]);
        }
        lod.dispose();
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
        const lod = new TreeLodController(root, { view: CENTRE_AS_METRES, now: c.now });
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
        expect(castingLevels(tree)[0]).toBeGreaterThanOrEqual(2);       // mid or far: never a leaf-heavy level
        lod.update(cam, null);
        expect(tree.visible).toBe(false);
    });
});

