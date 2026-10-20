/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * One triangle budget for the frame (cheap form): countSceneTriangles counts what everything but the trees draws, and
 * TreeLodController takes it off its triangleBudget before fitting the trees (TreeLodFrame.reservedTriangles). Checked on
 * real geometry: exact counts (visible, culled, hidden, instanced, shadow pass, tree subtrees skipped); the trees give up
 * levels exactly when the reserved share pushes them over; the focus tree never does; the stats overlay names the split.
 */

import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { TreeLodController, formatTreeLodStats } from '../src/browser/generative-canvas/primitives/scene3d/treeLod/TreeLodController';
import { countSceneTriangles } from '../src/browser/generative-canvas/primitives/scene3d/treeLod/sceneTriangleShare';
import { buildTreesLodGltf, writeTreesLodGlb } from './helpers/synthetic-trees-lod-glb';

/** A flat grid of n x n quads (2 n^2 indexed triangles) in the XY plane, centred at the origin, `size` metres across. */
function grid(n: number, size: number): THREE.BufferGeometry {
    const pos: number[] = [], idx: number[] = [];
    for (let j = 0; j <= n; j++) for (let i = 0; i <= n; i++) pos.push((i / n - 0.5) * size, (j / n - 0.5) * size, 0);
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
        const a = j * (n + 1) + i, b = a + 1, c = a + n + 1, d = c + 1;
        idx.push(a, b, d, a, d, c);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setIndex(idx);
    return g;
}

async function loadTrees(trees: number): Promise<THREE.Object3D> {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sb-lod-budget-')), 't.glb');
    writeTreesLodGlb(file, buildTreesLodGltf({ trees, levels: 4 }));
    const buf = fs.readFileSync(file);
    const gltf = await new GLTFLoader().parseAsync(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer, '');
    return gltf.scene;
}

const treeNodes = (root: THREE.Object3D): THREE.Object3D[] => { const out: THREE.Object3D[] = []; root.traverse(o => { if (o.userData?.sbTree) out.push(o); }); return out; };
const clock = (): { now: () => number; tick: (ms?: number) => void } => { let t = 1000; return { now: () => t, tick: (ms = 16.7) => { t += ms; } }; };
const CENTRE_AS_METRES = { foveal: { enabled: false } };

describe('countSceneTriangles: what the rest of the scene draws', () => {
    it('counts visible meshes in the frustum (instances included), skips hidden, culled and tree subtrees, and counts the shadow pass of casters', () => {
        const scene = new THREE.Scene();
        const mat = new THREE.MeshBasicMaterial();
        const building = new THREE.Mesh(grid(50, 20), mat);                  // 5,000 triangles in front of the camera
        building.castShadow = true;
        scene.add(building);
        const hero = new THREE.InstancedMesh(grid(10, 1), mat, 4);           // 200 x 4 = 800, not a caster
        hero.position.set(3, 0, 1);
        scene.add(hero);
        const hiddenParent = new THREE.Group(); hiddenParent.visible = false;
        hiddenParent.add(new THREE.Mesh(grid(30, 5), mat));                  // 1,800 hidden by its parent
        scene.add(hiddenParent);
        const behind = new THREE.Mesh(grid(20, 2), mat);                    // 800 behind the camera
        behind.position.set(0, 0, 200);
        behind.castShadow = true;
        scene.add(behind);
        const trees = new THREE.Group(); trees.userData.sbTreeLod = {};
        trees.add(new THREE.Mesh(grid(40, 5), mat));                        // 3,200, counted by the tree controllers
        scene.add(trees);
        scene.updateMatrixWorld(true);
        const cam = new THREE.PerspectiveCamera(45, 1, 0.1, 1000);
        cam.position.set(0, 0, 50); cam.lookAt(0, 0, 0); cam.updateMatrixWorld(true);
        const skip = (o: THREE.Object3D) => !!o.userData?.sbTreeLod;
        expect(countSceneTriangles(scene, cam, { skip })).toEqual({ main: 5000 + 800, shadow: 0, meshes: 2 });
        // a shadow camera looking down at everything: the casters it sees (the building and the mesh behind the main camera)
        const sun = new THREE.OrthographicCamera(-300, 300, 300, -300, 0.1, 2000);
        sun.position.set(0, 500, 0); sun.lookAt(0, 0, 0); sun.updateMatrixWorld(true);
        expect(countSceneTriangles(scene, cam, { skip, shadowCamera: sun })).toEqual({ main: 5800, shadow: 5000 + 800, meshes: 2 });
        // without the skip, the tree subtree counts too
        expect(countSceneTriangles(scene, cam).main).toBe(5800 + 3200);
    });
});

describe('TreeLodController shares one budget with the rest of the scene', () => {
    async function setup() {
        const root = await loadTrees(4);
        const trees = treeNodes(root);
        trees.forEach((t, i) => { t.position.set(i * 8 - 12, 0, -i * 6); });
        root.updateMatrixWorld(true);
        const cam = new THREE.PerspectiveCamera(60, 16 / 9, 0.1, 6000);
        cam.position.set(0, 3, 12); cam.lookAt(0, 3, -6); cam.updateMatrixWorld(true);
        return { root, trees, cam };
    }

    it('with room for the trees nothing is demoted; a reserved share that leaves less makes them give up levels until they fit', async () => {
        const { root, cam } = await setup();
        const c = clock();
        const free = new TreeLodController(root, { view: CENTRE_AS_METRES, now: c.now, triangleBudget: 1e9 });
        for (let i = 0; i < 60; i++) { c.tick(); free.update(cam); }
        const want = free.stats.estimatedTriangles;
        expect(want).toBeGreaterThan(0);
        expect(free.stats.atLevel[3], `levels ${JSON.stringify(free.stats.atLevel)}: some tree is finer than far`).toBeLessThan(free.stats.visibleTrees);
        expect(free.stats.demotedTrees).toBe(0);
        free.dispose();

        // budget = exactly what the trees want plus a scene of 10,000 triangles: nothing to give up
        const root2 = (await setup()).root;
        const fits = new TreeLodController(root2, { view: CENTRE_AS_METRES, now: c.now, triangleBudget: want + 10_000 });
        for (let i = 0; i < 60; i++) { c.tick(); fits.update(cam, null, { reservedTriangles: 10_000 }); }
        expect(fits.stats.demotedTrees).toBe(0);
        expect(fits.stats).toMatchObject({ triangleBudget: want + 10_000, reservedTriangles: 10_000, treeBudget: want });
        expect(fits.stats.estimatedTriangles).toBe(want);

        // the scene grows to 10,000 + half of the trees: the trees give up levels and end inside what is left (or all at the far level)
        const heavy = 10_000 + Math.round(want / 2);
        for (let i = 0; i < 120; i++) { c.tick(); fits.update(cam, null, { reservedTriangles: heavy }); }
        expect(fits.stats.treeBudget).toBe(want + 10_000 - heavy);
        expect(fits.stats.demotedTrees).toBeGreaterThan(0);
        expect(fits.stats.estimatedTriangles).toBeLessThan(want);
        const allFar = fits.stats.atLevel[3] === fits.stats.visibleTrees;
        expect(allFar || fits.stats.estimatedTriangles <= fits.stats.treeBudget, `trees ${fits.stats.estimatedTriangles} within ${fits.stats.treeBudget}`).toBe(true);
        expect(fits.stats.estimatedTriangles + heavy).toBeLessThanOrEqual(want + 10_000);

        // the scene shrinks again: the levels come back
        for (let i = 0; i < 120; i++) { c.tick(); fits.update(cam, null, { reservedTriangles: 0 }); }
        expect(fits.stats.demotedTrees).toBe(0);
        expect(fits.stats.estimatedTriangles).toBe(want);
        expect(formatTreeLodStats([fits.stats], { main: 0, shadow: 0 })).toContain(`budget ${((want + 10_000) / 1e3).toFixed(1)}k = scene 0 + shadow 0 + trees`);
    });

    it('never demotes the focus tree for the budget, however heavy the rest of the scene', async () => {
        const { root, trees, cam } = await setup();
        const c = clock();
        const lod = new TreeLodController(root, { view: CENTRE_AS_METRES, now: c.now, triangleBudget: 2_000_000 });
        const focus = trees[1];
        const s = new THREE.Box3().setFromObject(focus).getBoundingSphere(new THREE.Sphere());
        const focusM = s.center.clone().applyMatrix4(cam.matrixWorldInverse).z * -1;
        const frame = { reservedTriangles: 1e9, dof: { focalLengthMm: 50, apertureFStop: 8, focusM, focusPoint: s.center, focusObject: focus } };
        for (let i = 0; i < 120; i++) { c.tick(); lod.update(cam, null, frame); }
        const i = trees.indexOf(focus);
        expect(lod.explain(i).focusProtected).toBe(true);
        expect(lod.explain(i).budgetDemotions).toBe(0);
        expect(lod.stats.treeBudget).toBe(0);
        // every other tree in view went as far as it can
        expect(lod.stats.demotedTrees).toBeGreaterThan(0);
    });

    it('the stats overlay names the split: the one budget, the scene and its shadow, the trees and what they may use', () => {
        const stats = { trees: 2, visibleTrees: 2, culledTrees: 0, atLevel: [0, 1, 1, 0] as [number, number, number, number], fading: 0, estimatedTriangles: 2_500_000, estimatedShadowTriangles: 500_000, shadowOnlyTrees: 0,
            commits: 0, deferredCommits: 0, newVariants: 0, demotedTrees: 3, triangleBudget: 8_000_000, reservedTriangles: 1_550_000, treeBudget: 6_450_000, screenSpace: true, blurDemotedTrees: 0, focusProtectedTrees: 0,
            fovealCentreNdc: [0, 0] as [number, number], frameHeightPx: 943, fovDeg: 53.1, updateMs: 0.4, crownTrees: 0, crownLeafMeshes: 0, crownLobeTrees: 0, crownLobeMeshes: 0, crownLobeFallbackMeshes: 0 };
        const line = formatTreeLodStats([stats], { main: 1_250_000, shadow: 300_000 });
        expect(line).toContain('budget 8.00M = scene 1.25M + shadow 300.0k + trees 3.00M (trees may use 6.45M)');
    });
});
