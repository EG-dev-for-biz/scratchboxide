/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The photo-match evaluator draws a trees GLB (tree LOD contract) as the viewport would from the held-out pose: one level per
 * tree, chosen by TreeLodController's rule (checked against the controller itself on the same file and camera), with the
 * instanced leaf clusters expanded. Synthetic trees GLB (test/helpers/synthetic-trees-lod-glb.ts), no network, no billed call;
 * screenshot under test-results/screenshots/eval_trees/.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { describe, expect, it } from 'vitest';
import type { PinholeCamera } from '../src/common/spatial/texture-pass-contracts';
import { TreeLodController } from '../src/browser/generative-canvas/primitives/scene3d/treeLod/TreeLodController';
import { armLayerTriangles, armMeshesForView, composeGrid, loadArmLayer, renderPng, renderTriangles } from '../src/node/3d-engine/staged-location/photo-match-eval';
import { readTileTriangles } from '../src/node/3d-engine/staged-location/tile-texture-transfer';
import { readTreesLodGlb, treesForView } from '../src/node/3d-engine/staged-location/tree-lod-view';
import { buildTreesLodGltf, writeTreesLodGlb } from './helpers/synthetic-trees-lod-glb';

const SHOTS = path.resolve(__dirname, '../../../test-results/screenshots/eval_trees');
const W = 640, H = 400, VFOV = 45;
/** Leaf, then a colour per level (near green, near-mid yellow, mid orange, far red: the viewport's debug tints), then the far blob. */
const COLOURS = [[0.1, 0.45, 0.1], [0.25, 0.75, 0.29], [0.85, 0.82, 0.23], [0.91, 0.54, 0.17], [0.85, 0.26, 0.23], [0.55, 0.57, 0.6]];

/** Three trees at about 20, 130 and 460 m from the camera (fixture geometry: an 8 m wood fan per level, 0.1 m leaf triangles). */
function fixtureGlb(): Buffer {
    const g = buildTreesLodGltf({ trees: 3, crown: true });
    const { json } = g;
    json.materials = COLOURS.map((c, i) => ({ name: `m${i}`, pbrMetallicRoughness: { baseColorFactor: [...c, 1] } }));
    const placements = [[0, 0, 0], [8, 0, -110], [-120, 0, -420]];
    let t = 0;
    json.nodes.forEach((n: any) => {
        if (n.extras?.sbTree) n.translation = placements[t++];
        if (n.extras?.sbLod) json.meshes[n.mesh].primitives.forEach((p: any, k: number) => { p.material = k === 0 ? 1 + n.extras.sbLod.level : 5; });
        if (n.extras?.sbCluster) json.meshes[n.mesh].primitives.forEach((p: any) => { p.material = 0; });
    });
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sb-eval-trees-')), 'trees.glb');
    writeTreesLodGlb(file, g);
    return fs.readFileSync(file);
}

/** A pinhole camera at (0, 5, 25) looking down -z with a 45 degree vertical field of view. */
function camera(): PinholeCamera {
    const fy = H / 2 / Math.tan((VFOV * Math.PI) / 360);
    return { eye: [0, 5, 25], right: [1, 0, 0], up: [0, 1, 0], fwd: [0, 0, -1], fx: fy, fy, cx: W / 2, cy: H / 2, width: W, height: H };
}

describe('photo-match evaluator: trees as the viewport draws them', () => {
    const glb = fixtureGlb();

    it('expands EXT_mesh_gpu_instancing: each leaf-cluster node draws its mesh once per instance, at the instance', () => {
        const all = readTileTriangles(glb, { nodeTags: true });
        const { json } = { json: JSON.parse(glb.subarray(20, 20 + glb.readUInt32LE(12)).toString('utf8')) };
        const clusterNodes = json.nodes.map((n: any, i: number) => [n, i]).filter(([n]: any) => n.extras?.sbCluster);
        for (const [n, i] of clusterNodes) {
            const tris = [...all.node].filter(x => x === i).length;
            const instances = json.accessors[n.extensions.EXT_mesh_gpu_instancing.attributes.TRANSLATION].count;
            expect(tris).toBe(instances);                                   // the cluster mesh is one triangle
        }
        // tree 0 level 0's first cluster: instances at (0, 6, 0.5), (0.4, 7, 0), (-0.4, 5, 0.2) inside the tree's frame
        const first = clusterNodes[0][1];
        const at = [...all.node].map((x, t) => (x === first ? t : -1)).filter(t => t >= 0).map(t => [all.positions[t * 9], all.positions[t * 9 + 1], all.positions[t * 9 + 2]]);
        expect(at.map(p => p.map(v => Math.round(v * 100) / 100))).toEqual([[0, 6, 0.5], [0.4, 7, 0], [-0.4, 5, 0.2]]);
    });

    it('draws one level per tree, the level TreeLodController settles on for the same camera, with its leaves', async () => {
        const g = readTreesLodGlb(glb)!;
        expect(g.levels).toBe(4);
        expect(g.trees.length).toBe(3);
        const v = treesForView(g, camera());
        // the controller on the same GLB, the same camera and frame height
        const scene = (await new GLTFLoader().parseAsync(glb.buffer.slice(glb.byteOffset, glb.byteOffset + glb.byteLength) as ArrayBuffer, '')).scene;
        const lod = new TreeLodController(scene, { now: () => 1000 });
        const cam = new THREE.PerspectiveCamera(VFOV, W / H, 0.1, 5000);
        cam.position.set(0, 5, 25); cam.lookAt(0, 5, -100); cam.updateMatrixWorld(true);
        lod.update(cam, null, { heightPx: H });
        const controllerLevels = v.trees.map((_, i) => lod.explain(i).level);
        expect(v.trees.map(t => t.level)).toEqual(controllerLevels);
        for (let i = 0; i < 3; i++) expect(v.trees[i].equivalentDistM).toBeCloseTo(lod.explain(i).equivalentDistM, 3);
        // three trees, three different levels: near, near-mid / mid, far
        expect(new Set(v.trees.map(t => t.level)).size).toBe(3);
        expect(v.trees[0].level).toBe(0);
        expect(v.trees[2].level).toBe(3);
        // exactly one level per tree: every drawn tree triangle belongs to its tree's chosen level, and the counts add up
        const perTree = g.trees.map((tr, i) => tr.levelTriangles[v.trees[i].level]);
        expect(v.drawnTriangles).toBe(perTree.reduce((a, b) => a + b, 0));
        expect(v.allLevelTriangles).toBe(g.trees.reduce((s, tr) => s + tr.levelTriangles.reduce((a, b) => a + b, 0), 0));
        expect(v.drawnTriangles).toBeLessThan(v.allLevelTriangles / 2);
        // leaves appear: the near tree's level is its wood fan (12) plus 2 clusters x 3 instances; the far one its fan (4) and blob (8)
        expect(g.trees[0].levelTriangles[0]).toBe(12 + 6);
        expect(v.trees[0].triangles).toBe(18);
        const leafTris = [...v.triangles.flatLinear].filter((_, k) => k % 3 === 0 && Math.abs(v.triangles.flatLinear[k] - COLOURS[0][0]) < 1e-6 && Math.abs(v.triangles.flatLinear[k + 1] - COLOURS[0][1]) < 1e-6).length;
        expect(leafTris).toBe(6 + (v.trees[1].level < 3 ? 4 : 0));          // near tree: 6 leaves; a near-mid or mid tree: 2 clusters x 2
        expect(v.atLevel.reduce((a, b) => a + b, 0)).toBe(3);
    });

    it('treeLod on by default in the arm loader; off draws every level at once; renders differ where the levels stacked', () => {
        const on = loadArmLayer(glb), off = loadArmLayer(glb, { treeLod: false });
        expect(on.trees).toBeDefined(); expect(off.fixed).toBeDefined();
        expect(armLayerTriangles(on)).toBe(armLayerTriangles(off));        // the same file, every level read
        const cam = camera();
        const viewOn = armMeshesForView([on], cam), viewOff = armMeshesForView([off], cam);
        expect(viewOn.trees.length).toBe(1);
        expect(viewOn.meshes[0].texture.length).toBe(viewOn.trees[0].drawnTriangles);
        expect(viewOff.meshes[0].texture.length).toBe(armLayerTriangles(off));
        const rOn = renderTriangles(viewOn.meshes, cam, { supersample: 2 }), rOff = renderTriangles(viewOff.meshes, cam, { supersample: 2 });
        // the far level's grey blob (the stacked hull) shows in front of the near tree only when every level is drawn
        const greyPixels = (r: typeof rOn) => {
            let n = 0;
            for (let i = 0; i < r.width * r.height; i++) { const R = r.rgba[i * 4], G = r.rgba[i * 4 + 1], B = r.rgba[i * 4 + 2]; if (B > R + 4 && B > 150 && Math.abs(R - G) < 8) n++; }
            return n;
        };
        expect(greyPixels(rOff)).toBeGreaterThan(500);
        expect(greyPixels(rOn)).toBeLessThan(greyPixels(rOff) / 4);
        fs.mkdirSync(SHOTS, { recursive: true });
        const label = viewOn.trees[0].trees.map(t => `tree ${t.id}: ${t.rangeM.toFixed(0)} m -> level ${t.level}`).join(', ');
        const grid = composeGrid([
            { image: rOff, label: 'BEFORE: EVERY LEVEL DRAWN', sublabel: `${viewOff.meshes[0].texture.length} triangles` },
            { image: rOn, label: 'AFTER: ONE LEVEL PER TREE', sublabel: `${viewOn.trees[0].drawnTriangles} triangles; ${label}` }
        ], { tileWidth: 640, columns: 2, title: 'EVALUATOR TREES: ONE LEVEL PER TREE BY THE VIEWPORT RULE' });
        fs.writeFileSync(path.join(SHOTS, 'eval_trees_one_level_per_tree.png'), grid);
        fs.writeFileSync(path.join(SHOTS, 'eval_trees_after.png'), renderPng(rOn));
    });
});
