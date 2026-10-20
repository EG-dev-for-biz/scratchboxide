/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * A trees GLB (SB-Veggie, the tree LOD contract of staged-location-contracts.ts) as the viewport shows it from one still camera.
 *
 * The file holds every level of every tree (near, near-mid, mid, far; three levels in a trees-lod/1 file) and leaf clusters
 * as EXT_mesh_gpu_instancing nodes; the viewport's TreeLodController draws one level per tree, chosen by the tree's on-screen
 * size and its place in the frame. Drawn whole, the file stacks all four levels (the far level's blob masses over the near
 * level's leaves). This module reads the file once (instances expanded, every triangle tagged with its node) and, per camera,
 * keeps each tree's one level by the controller's rule (common/spatial/tree-lod-math.ts treeLevelForView): the range to the
 * nearest point of the tree's bounding sphere, the foveal weight of its place in the frame, the reference-lens distance with
 * the same projected height, the target edges there and the level with the largest share. A camera that holds still settles
 * on those edges; the still frame draws the dominant level whole (no dither). Depth of field and the triangle budget are not
 * applied (the evaluator draws no blur, and its frames stay far below the viewport's budget).
 */

import { treesLodLevelCount, type TreeLodExtras, type TreeNodeExtras, type TreesGlbRootExtras } from '../../../common/spatial/staged-location-contracts';
import type { PinholeCamera } from '../../../common/spatial/texture-pass-contracts';
import { fovealWeight, resolveTreeLodView, sphereFovealRadius, treeLevelForView, type LodBand, type TreeLodViewInput, type TreeLodViewOptions } from '../../../common/spatial/tree-lod-math';
import { readGlbChunks, readTileTriangles, selectTriangles, type TaggedTileTriangles, type TileTriangles } from './tile-texture-transfer';

interface TreeEntry {
    id: number;
    node: number;
    bands: LodBand[];
    /** Triangle count drawn at each level (wood, leaves, expanded instances). */
    levelTriangles: number[];
    /** Bounding sphere of the whole tree (every level), tile frame. */
    centre: [number, number, number];
    radius: number;
}

/** A trees GLB read once: every level's triangles tagged by tree and level, and each tree's bands and bounds. */
export interface TreesLodGlb {
    schema: string;
    levels: number;
    all: TaggedTileTriangles;
    /** Per triangle: index into `trees` (-1 for geometry outside any tree) and its level (-1 likewise). */
    treeOf: Int32Array;
    levelOf: Int8Array;
    trees: TreeEntry[];
}

/** Why one tree drew the level it drew in a view. */
export interface TreeViewChoice {
    id: number;
    level: number;
    rangeM: number;
    equivalentDistM: number;
    fovealWeight: number;
    inFrame: boolean;
    triangles: number;
}

export interface TreesForView {
    triangles: TileTriangles;
    trees: TreeViewChoice[];
    /** Trees at each level (index = level). */
    atLevel: number[];
    /** Triangles drawn, and what drawing every level would have drawn. */
    drawnTriangles: number;
    allLevelTriangles: number;
}

/** Whether a parsed glTF JSON is a trees GLB of the LOD contract (root extras sbTrees and at least one sbTree node). */
export function isTreesLodJson(json: any): boolean {
    return !!json?.extras?.sbTrees && Array.isArray(json.nodes) && json.nodes.some((n: any) => n?.extras?.sbTree);
}

/** Reads a trees GLB for per-view level selection; undefined when the file is not a trees GLB of the LOD contract. */
export function readTreesLodGlb(glb: Uint8Array): TreesLodGlb | undefined {
    const { json } = readGlbChunks(glb);
    if (!isTreesLodJson(json)) return undefined;
    const root = json.extras.sbTrees as TreesGlbRootExtras;
    const levels = treesLodLevelCount(root.schema);
    const nodes: any[] = json.nodes;
    // each node's tree and level: a tree node's sbLod children and everything below them
    const nodeTree = new Int32Array(nodes.length).fill(-1), nodeLevel = new Int8Array(nodes.length).fill(-1);
    const trees: TreeEntry[] = [];
    nodes.forEach((n, i) => {
        const tree = n?.extras?.sbTree as TreeNodeExtras | undefined;
        if (!tree) return;
        const bands: LodBand[] = new Array(levels);
        const levelNodes: Array<[number, number]> = [];
        for (const c of n.children ?? []) {
            const lod = nodes[c]?.extras?.sbLod as TreeLodExtras | undefined;
            if (!lod || lod.level < 0 || lod.level >= levels) continue;
            bands[lod.level] = { minDistM: lod.minDistM, maxDistM: lod.maxDistM, fadeM: lod.fadeM };
            levelNodes.push([c, lod.level]);
        }
        if (Array.from({ length: levels }, (_, k) => bands[k]).some(b => !b)) return; // not every level: the controller does not adopt it either
        const ti = trees.length;
        const mark = (k: number, level: number): void => { nodeTree[k] = ti; nodeLevel[k] = level; for (const g of nodes[k]?.children ?? []) mark(g, level); };
        for (const [c, level] of levelNodes) mark(c, level);
        trees.push({ id: tree.id, node: i, bands, levelTriangles: new Array(levels).fill(0), centre: [0, 0, 0], radius: 0 });
    });
    const all = readTileTriangles(glb, { nodeTags: true });
    const n = all.texture.length;
    const treeOf = new Int32Array(n), levelOf = new Int8Array(n);
    const lo = trees.map(() => [Infinity, Infinity, Infinity]), hi = trees.map(() => [-Infinity, -Infinity, -Infinity]);
    for (let t = 0; t < n; t++) {
        const ti = nodeTree[all.node[t]];
        treeOf[t] = ti; levelOf[t] = nodeLevel[all.node[t]];
        if (ti < 0 || ti >= trees.length) continue;
        trees[ti].levelTriangles[levelOf[t]]++;
        for (let v = 0; v < 3; v++) for (let k = 0; k < 3; k++) {
            const x = all.positions[t * 9 + v * 3 + k];
            if (x < lo[ti][k]) lo[ti][k] = x;
            if (x > hi[ti][k]) hi[ti][k] = x;
        }
    }
    // the bounding sphere of the tree's box over every level, as the controller takes it (Box3.setFromObject, getBoundingSphere)
    trees.forEach((tr, i) => {
        if (!Number.isFinite(lo[i][0])) return;
        tr.centre = [0, 1, 2].map(k => (lo[i][k] + hi[i][k]) / 2) as [number, number, number];
        tr.radius = Math.hypot(hi[i][0] - lo[i][0], hi[i][1] - lo[i][1], hi[i][2] - lo[i][2]) / 2;
    });
    return { schema: root.schema, levels, all, treeOf, levelOf, trees };
}

/** The trees as the viewport draws them from `camera`: one level per tree (TreeLodController's rule for a still camera). */
export function treesForView(g: TreesLodGlb, camera: PinholeCamera, view?: TreeLodViewInput | TreeLodViewOptions | null): TreesForView {
    const v = resolveTreeLodView(view as TreeLodViewInput);
    const { eye, right, up, fwd } = camera;
    const verticalFovDeg = (2 * Math.atan(camera.height / (2 * camera.fy)) * 180) / Math.PI;
    const aspect = (camera.width / camera.fx) / (camera.height / camera.fy);
    const choices: TreeViewChoice[] = g.trees.map(tr => {
        const d = [tr.centre[0] - eye[0], tr.centre[1] - eye[1], tr.centre[2] - eye[2]];
        const rangeM = Math.max(0, Math.hypot(d[0], d[1], d[2]) - tr.radius);
        const xc = d[0] * right[0] + d[1] * right[1] + d[2] * right[2];
        const yc = d[0] * up[0] + d[1] * up[1] + d[2] * up[2];
        const zc = d[0] * fwd[0] + d[1] * fwd[1] + d[2] * fwd[2];
        // normalised device coordinates of the centre (the principal point's offset included), as the projection matrix gives them
        const ndcX = zc > 1e-6 ? ((camera.cx + (camera.fx * xc) / zc) / camera.width) * 2 - 1 : 0;
        const ndcY = zc > 1e-6 ? 1 - ((camera.cy - (camera.fy * yc) / zc) / camera.height) * 2 : 0;
        const w = v.screen.enabled && v.foveal.enabled
            ? fovealWeight(sphereFovealRadius(ndcX, ndcY, zc, tr.radius, verticalFovDeg, aspect, [0, 0], v.foveal.verticalWeight, v.foveal.edgeRadius), v.foveal)
            : 1;
        const lv = treeLevelForView(rangeM, tr.bands, v, { verticalFovDeg, heightPx: camera.height, fovealWeight: w });
        // in the frame: the sphere reaches in front of the camera and inside the frustum's side planes (projected extent overlaps)
        const halfX = camera.width / (2 * camera.fx), halfY = camera.height / (2 * camera.fy);
        const inFrame = zc + tr.radius > 0 && Math.abs(xc) - tr.radius <= halfX * Math.max(zc, 0) && Math.abs(yc) - tr.radius <= halfY * Math.max(zc, 0);
        return { id: tr.id, level: lv.level, rangeM, equivalentDistM: lv.equivalentDistM, fovealWeight: w, inFrame, triangles: tr.levelTriangles[lv.level] };
    });
    const keep = new Uint8Array(g.all.texture.length);
    for (let t = 0; t < keep.length; t++) {
        const ti = g.treeOf[t];
        keep[t] = ti < 0 || ti >= choices.length ? 1 : g.levelOf[t] === choices[ti].level ? 1 : 0;
    }
    const atLevel = new Array(g.levels).fill(0);
    for (const c of choices) atLevel[c.level]++;
    const triangles = selectTriangles(g.all, keep);
    return { triangles, trees: choices, atLevel, drawnTriangles: triangles.texture.length, allLevelTriangles: g.all.texture.length };
}
