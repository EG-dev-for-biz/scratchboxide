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
 *
 * Cut-outs: what the viewport draws alpha-tested is cut out here by the same pixels (TileTriangles.cutout, drawn by
 * photo-match-eval.ts renderTriangles):
 * - crown cards (the mid level's cards, `sbTrees.crownCards`): the card atlas baked from the GLB's layout
 *   (common/spatial/tree-crown-card-atlas.ts, as treeCrownCards.ts bakes it): the clay ellipses in clay, and for a textured
 *   tree in textured renders the chosen leaf set's cells at each leaf's pick (as treeTextureMaterials.ts bakes it);
 * - leaf clusters of a textured tree in textured renders: the library leaf set's opacity at the cell each card's pick
 *   chooses, with its level's card zoom and alpha gain and the mip-aware alpha lift (treeTextureMaterials.ts
 *   LEAF_VERTEX_MAIN, LEAF_FRAGMENT_ALPHA); stalks stay opaque. In clay the leaves are their outline geometry, uncut.
 * Wood, twigs and the far level's masses are opaque in both.
 */

import * as fs from 'fs';
import * as path from 'path';

import { treesLodLevelCount, type TreeCrownCardsExtras, type TreeLodExtras, type TreeNodeExtras, type TreesGlbRootExtras } from '../../../common/spatial/staged-location-contracts';
import type { PinholeCamera } from '../../../common/spatial/texture-pass-contracts';
import { crownSlotOf, fovealWeight, resolveTreeLodView, sphereFovealRadius, treeLevelForView, type LodBand, type TreeLodViewInput, type TreeLodViewOptions } from '../../../common/spatial/tree-lod-math';
import { CROWN_CARD_ATLAS_PX, CROWN_CARD_MIP_SCALE, bakeCrownCardAtlas, crownCardMaskPixels, crownCardsOf, texturedLeafPaint, type AtlasPixels } from '../../../common/spatial/tree-crown-card-atlas';
import {
    DEFAULT_TREE_TEXTURE_OPTIONS, MAX_LEAF_CELLS, leafCardFit, leafCellIndex, validateTreeTextureIndex, type TreeLeafTextureEntry, type TreeTextureIndex
} from '../../../common/spatial/tree-texture-library';
import { findTileVegetationRepoRoot, treeTextureIndexPath } from '../tile-vegetation-service';
import { decodeImageInMemory, readGlbChunks, readTileTriangles, selectTriangles, type CutoutAlphaMap, type CutoutKind, type TaggedTileTriangles, type TileTriangles, type TriangleCutouts } from './tile-texture-transfer';

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

export interface ReadTreesLodOptions {
    /**
     * The tree texture library's index.json (textured trees' leaves and cards are cut out by its leaf sets), or false for
     * none (textured renders then cut the cards by the clay mask, as the viewport does before the library has loaded).
     * Default: the checkout's assets/textures/trees/index.json, when present.
     */
    textureIndex?: string | false;
}

/** Reads a trees GLB for per-view level selection; undefined when the file is not a trees GLB of the LOD contract. */
export function readTreesLodGlb(glb: Uint8Array, options: ReadTreesLodOptions = {}): TreesLodGlb | undefined {
    const { json } = readGlbChunks(glb);
    if (!isTreesLodJson(json)) return undefined;
    const root = json.extras.sbTrees as TreesGlbRootExtras;
    const levels = treesLodLevelCount(root.schema);
    const nodes: any[] = json.nodes;
    // each node's tree and level: a tree node's sbLod children and everything below them
    const nodeTree = new Int32Array(nodes.length).fill(-1), nodeLevel = new Int8Array(nodes.length).fill(-1);
    const nodeCluster: Array<string | undefined> = new Array(nodes.length);
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
        // a node's leaf-cluster library mesh is its own or its nearest ancestor's within the level (as the viewport's clusterOf)
        const mark = (k: number, level: number, cluster: string | undefined): void => {
            const own = nodes[k]?.extras?.sbCluster?.clusterMesh as string | undefined;
            nodeTree[k] = ti; nodeLevel[k] = level; nodeCluster[k] = own ?? cluster;
            for (const g of nodes[k]?.children ?? []) mark(g, level, own ?? cluster);
        };
        for (const [c, level] of levelNodes) mark(c, level, undefined);
        trees.push({ id: tree.id, node: i, bands, levelTriangles: new Array(levels).fill(0), centre: [0, 0, 0], radius: 0 });
    });
    // the leaf cards' attribute: its name leads the extras' description ("_LEAF: x atlas pick ..., y 1 on a blade ...")
    const leafAttribute = root.clusterLibrary?.leafCard ? (/^\s*([A-Za-z_][A-Za-z0-9_]*)/.exec(root.clusterLibrary.leafCard.leafAttribute ?? '')?.[1] ?? '_LEAF') : undefined;
    const all = readTileTriangles(glb, { nodeTags: true, ...(leafAttribute ? { vertexAttribute: leafAttribute } : {}) });
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
    const cutout = treeCutouts(root, all, levels, treeOf, levelOf, trees.map(t => (nodes[t.node].extras.sbTree as TreeNodeExtras).texture?.leaves?.entry),
        (i: number) => nodeCluster[all.node[i]], options);
    if (cutout) all.cutout = cutout;
    delete all.attribute; // read for the cut-outs only
    return { schema: root.schema, levels, all, treeOf, levelOf, trees };
}

// =============================================================================
// Cut-outs (the viewport's alpha tests)
// =============================================================================

/** An RGBA8 image's channel (row 0 at v = 0) as an alpha map with its box mips, as the GPU's generateMipmap builds them. */
function alphaMap(width: number, height: number, alphaAt: (i: number) => number, maxAnisotropy: number): CutoutAlphaMap {
    const level0 = new Float32Array(width * height);
    for (let i = 0; i < level0.length; i++) level0[i] = alphaAt(i) / 255;
    const mips = [{ width, height, alpha: level0 }];
    while (mips[mips.length - 1].width > 1 || mips[mips.length - 1].height > 1) {
        const p = mips[mips.length - 1];
        const w = Math.max(1, p.width >> 1), h = Math.max(1, p.height >> 1), a = new Float32Array(w * h);
        for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
            const x0 = Math.min(p.width - 1, 2 * x), x1 = Math.min(p.width - 1, 2 * x + 1), y0 = Math.min(p.height - 1, 2 * y), y1 = Math.min(p.height - 1, 2 * y + 1);
            a[y * w + x] = 0.25 * (p.alpha[y0 * p.width + x0] + p.alpha[y0 * p.width + x1] + p.alpha[y1 * p.width + x0] + p.alpha[y1 * p.width + x1]);
        }
        mips.push({ width: w, height: h, alpha: a });
    }
    return { mips, maxAnisotropy };
}

/**
 * A leaf set's opacity as the viewport uploads it (treeTextureMaterials.ts defaultTextureLoad): scaled to at most leafAtlasPx
 * on its longer side (box filter), rows flipped so row 0 is the image's bottom (v = 0), in the alpha of an RGBA atlas.
 */
function leafAtlasPixels(file: string, maxPx: number): AtlasPixels {
    const img = decodeImageInMemory(fs.readFileSync(file));
    const scale = Math.min(1, maxPx / Math.max(img.width, img.height));
    const w = Math.max(1, Math.round(img.width * scale)), h = Math.max(1, Math.round(img.height * scale));
    const data = new Uint8Array(w * h * 4);
    for (let y = 0; y < h; y++) {
        const sy0 = Math.floor((y * img.height) / h), sy1 = Math.max(sy0 + 1, Math.floor(((y + 1) * img.height) / h));
        for (let x = 0; x < w; x++) {
            const sx0 = Math.floor((x * img.width) / w), sx1 = Math.max(sx0 + 1, Math.floor(((x + 1) * img.width) / w));
            let sum = 0;
            for (let yy = sy0; yy < sy1; yy++) for (let xx = sx0; xx < sx1; xx++) sum += img.rgba[(yy * img.width + xx) * 4];
            data[((h - 1 - y) * w + x) * 4 + 3] = Math.round(sum / ((sy1 - sy0) * (sx1 - sx0)));
        }
    }
    return { data, width: w, height: h };
}

/** The library index and its leaf sets' atlases, read once per process. */
const libraries = new Map<string, { index: TreeTextureIndex; atlases: Map<string, AtlasPixels> }>();

function libraryAt(indexFile: string): { index: TreeTextureIndex; atlas(e: TreeLeafTextureEntry): AtlasPixels } | undefined {
    let lib = libraries.get(indexFile);
    if (!lib) {
        const index = JSON.parse(fs.readFileSync(indexFile, 'utf8')) as TreeTextureIndex;
        if (validateTreeTextureIndex(index).length) return undefined;
        libraries.set(indexFile, lib = { index, atlases: new Map() });
    }
    const { index, atlases } = lib;
    return {
        index,
        atlas: e => {
            let a = atlases.get(e.id);
            if (!a) atlases.set(e.id, a = leafAtlasPixels(path.join(path.dirname(indexFile), e.maps.opacity), DEFAULT_TREE_TEXTURE_OPTIONS.leafAtlasPx));
            return a;
        }
    };
}

/** Card atlases as alpha maps, per layout (and leaf set), shared by every file read in the process. */
const cardMaps = new Map<string, CutoutAlphaMap>();
function cardMap(key: string, make: () => Uint8Array): CutoutAlphaMap {
    let m = cardMaps.get(key);
    // the card textures are clamped and 4x anisotropic (treeCrownCards.ts crownCardTexture)
    if (!m) { const px = make(); cardMaps.set(key, m = alphaMap(CROWN_CARD_ATLAS_PX, CROWN_CARD_ATLAS_PX, i => px[i * 4 + 3], 4)); }
    return m;
}

/**
 * Each triangle's cut-out in clay and in textured renders (see the file comment); undefined when nothing in the file is
 * alpha-tested. `entryOf[tree]` is the tree's chosen leaf set (sbTree.texture.leaves.entry), `clusterOf(t)` the leaf-cluster
 * library mesh triangle t was instanced from.
 */
function treeCutouts(root: TreesGlbRootExtras, all: TaggedTileTriangles, levels: number, treeOf: Int32Array, levelOf: Int8Array, entryOf: Array<string | undefined>,
    clusterOf: (t: number) => string | undefined, options: ReadTreesLodOptions): TriangleCutouts | undefined {
    const cards = crownCardsOf(root);
    const cardMeshes = new Set(cards?.meshes ?? []);
    const cardWidth = root.clusterLibrary?.leafCard?.widthRatio;
    // textured trees: as applyTreeTextures, a file with textures and a leaf card width, and a library holding the tree's entry
    const indexFile = options.textureIndex === false ? undefined : options.textureIndex ?? treeTextureIndexPath(findTileVegetationRepoRoot());
    const lib = root.textures && typeof cardWidth === 'number' && cardWidth > 0 && all.attribute && indexFile && fs.existsSync(indexFile) ? libraryAt(indexFile) : undefined;
    const leafVariants = new Set((root.clusterLibrary?.variants ?? []).filter(v => v.leavesLevel0 > 0 || (v.leavesNearMid ?? 0) > 0 || v.leavesLevel1 > 0).map(v => v.mesh));
    if (!cards && !lib) return undefined;
    const o = DEFAULT_TREE_TEXTURE_OPTIONS;
    const maps: CutoutAlphaMap[] = [], kinds: CutoutKind[] = [];
    const mapIndex = new Map<CutoutAlphaMap, number>(), kindIndex = new Map<string, number>();
    const kind = (key: string, make: () => CutoutKind & { alpha: CutoutAlphaMap }): number => {
        let k = kindIndex.get(key);
        if (k === undefined) {
            const { alpha, ...rest } = make();
            let mi = mapIndex.get(alpha);
            if (mi === undefined) { mi = maps.push(alpha) - 1; mapIndex.set(alpha, mi); }
            k = kinds.push({ ...rest, map: mi }) - 1;
            kindIndex.set(key, k);
        }
        return k;
    };
    const layoutKey = cards ? JSON.stringify([cards.cols, cards.rows, cards.clayLeafAspect, cards.cells]) : '';
    const clayCard = (c: TreeCrownCardsExtras) => kind('card:clay', () => ({ map: -1, mipScale: CROWN_CARD_MIP_SCALE, gain: 1, alpha: cardMap(layoutKey, () => crownCardMaskPixels(c)) }));
    const entries = new Map<string, TreeLeafTextureEntry | undefined>();
    const entryFor = (id: string | undefined): TreeLeafTextureEntry | undefined => {
        if (!lib || !id) return undefined;
        if (!entries.has(id)) entries.set(id, lib.index.leaves.find(e => e.id === id));
        return entries.get(id);
    };
    const n = all.texture.length;
    const clay = new Int32Array(n).fill(-1), textured = new Int32Array(n).fill(-1);
    const A = all.attribute;
    const entryNumber = new Map<TreeLeafTextureEntry, number>(), leafKinds = new Map<number, number>();
    for (let t = 0; t < n; t++) {
        const ti = treeOf[t];
        if (ti < 0) continue;
        const mesh = clusterOf(t);
        if (!mesh) continue;
        const e = entryFor(entryOf[ti]);
        if (cards && cardMeshes.has(mesh)) {
            clay[t] = clayCard(cards);
            // a textured tree's cards wear its leaf set's card atlas; any other tree's are masked by the clay cut-out
            textured[t] = e
                ? kind(`card:${e.id}`, () => ({ map: -1, mipScale: CROWN_CARD_MIP_SCALE, gain: 1,
                    alpha: cardMap(`${layoutKey}|${e.id}`, () => bakeCrownCardAtlas(cards, CROWN_CARD_ATLAS_PX, texturedLeafPaint(e, lib!.atlas(e), cards.clayLeafAspect))) }))
                : clay[t];
            continue;
        }
        if (!e || !A || !leafVariants.has(mesh)) continue;
        // a stalk (blade flag under one half) is opaque; a blade is cut out of its pick's cell
        if ((A[t * 6 + 1] + A[t * 6 + 3] + A[t * 6 + 5]) / 3 < 0.5) continue;
        const cells = e.atlas.cells.slice(0, MAX_LEAF_CELLS);
        const ci = leafCellIndex(A[t * 6], cells.length);
        const slot = crownSlotOf(levelOf[t], levels);
        // the kinds of a leaf set by cell and slot, keyed by number (this runs for every leaf triangle of the file)
        const leafKey = ((entryNumber.get(e) ?? entryNumber.set(e, entryNumber.size).get(e)!) * MAX_LEAF_CELLS + ci) * 4 + slot;
        const known = leafKinds.get(leafKey);
        if (known !== undefined) { textured[t] = known; continue; }
        textured[t] = kind(`leaf:${e.id}:${ci}:${slot}`, () => {
            const cell = cells[ci], zoom = o.cardZoom[slot] ?? 1;
            const { drawn, f } = leafCardFit(cell, cardWidth as number, o.leafStretch);
            const px = lib!.atlas(e);
            // the leaf atlas is clamped and 8x anisotropic (treeTextureMaterials.ts)
            const alpha = cardMaps.get(`leaf:${e.id}`) ?? alphaMap(px.width, px.height, i => px.data[i * 4 + 3], 8);
            cardMaps.set(`leaf:${e.id}`, alpha);
            return { map: -1, mipScale: o.alphaMipScale, gain: o.alphaGain[slot] ?? 1, alpha, leaf: { origin: cell.origin, along: cell.along, across: cell.across, ks: 1 / (f * drawn * zoom), kt: 1 / f, zoom } };
        });
        leafKinds.set(leafKey, textured[t]);
    }
    return { clay, textured, kinds, maps };
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
