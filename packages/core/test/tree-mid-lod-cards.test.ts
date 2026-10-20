/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The mid level as crown cards (scratchbox_tree_lod.hpp placeCrownCards, treeCrownCards.ts):
 *
 * - planted with and without crown cards, a summer crown's mid level keeps the projected coverage the mid clusters give
 *   (clay and the textured cut-out) for a small share of the triangles, and a larger crown gets more cards;
 * - the GLB keeps the tree LOD contract and carries the card layout; the viewer's baked cut-out covers what the writer
 *   measured;
 * - in the viewer the cards are leaf meshes of the mid level: crown attributes, crown variant, dither (crossfade) variants
 *   that keep the crown chunk and the cut-out; in clay they wear the trees' one grey, cut out.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { TileVegetationService } from '../src/node/3d-engine/tile-vegetation-service';
import { validateTreesGlbJson, type TreesGlbRootExtras } from '../src/common/spatial/staged-location-contracts';
import { TreeLodController } from '../src/browser/generative-canvas/primitives/scene3d/treeLod/TreeLodController';
import { CROWN_VERTEX_MAIN, isCrownVariant, makeCrownVariant } from '../src/browser/generative-canvas/primitives/scene3d/treeLod/treeCrownShading';
import { makeFadeVariant } from '../src/browser/generative-canvas/primitives/scene3d/treeLod/treeLodFade';
import { CARD_ALPHA_MIP, CROWN_CARD_ATLAS_PX, bakeCrownCardAtlas, clayLeafPaint } from '../src/browser/generative-canvas/primitives/scene3d/treeLod/treeCrownCards';
import { applyClayRenderMode, sharedTreeClayMaterial } from '../src/browser/generative-canvas/primitives/scene3d/clayRenderMode';
import { parseGlb } from './helpers/clay-glb-render';
import { encodePng } from '../src/node/texture-processing';

const REPO = fs.realpathSync(path.resolve(__dirname, '../../..'));
const INCLUDE = path.join(REPO, 'packages/core/src/native/3d-engine/include');
const SHOTS = path.join(REPO, 'test-results/screenshots/tree_mid_lod');

type Vec3 = [number, number, number];
function crown(id: number, stem: [number, number], supportY: number, apexY: number, radius: number) {
    const samples: Vec3[] = [];
    const n = Math.ceil(radius / 0.7);
    for (let i = -n; i <= n; i++) for (let k = -n; k <= n; k++) {
        const dx = i * 0.7, dz = k * 0.7, d = Math.hypot(dx, dz);
        if (d <= radius) samples.push([stem[0] + dx, apexY - 0.45 * (apexY - supportY) * (d / radius) ** 2, stem[1] + dz]);
    }
    return {
        id, status: 'tree', reachesBoundary: false, apex: [stem[0], apexY, stem[1]], stem, supportY, supportSource: 'given', terrainY: supportY,
        apexAboveSupport: apexY - supportY, areaM2: Math.PI * radius * radius, sectorRadii: new Array(16).fill(radius), samples,
        colour: { meanLinearRgb: [0.08, 0.09, 0.045], spreadLinearRgb: [0.02, 0.02, 0.01], samples: 100, cells: 50, greenShare: 1, hueDeg: 70, chroma: 0.5 }
    };
}
const CROWNS = [crown(0, [0, 0], 0, 14, 4.5), crown(1, [16, 3], 0.4, 14, 4.5), crown(2, [4, -16], 0, 22, 6)];

describe('the mid level as crown cards', () => {
    let work: string;
    let svc: TileVegetationService;
    let cards: Awaited<ReturnType<TileVegetationService['plant']>>;
    let clusters: Awaited<ReturnType<TileVegetationService['plant']>>;
    beforeAll(async () => {
        work = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tree-mid-lod-')));
        svc = new TileVegetationService({ workspaceRoot: work, repoRoot: REPO });
        await svc.ensureBinary();
        fs.writeFileSync(path.join(work, 'crowns.json'), JSON.stringify({ version: 1, frame: { frame: 'x = east, y = up, z = south (metres)' }, params: { sampleSpacing: 0.7 }, crowns: CROWNS }));
        cards = await svc.plant({ crownsPath: 'crowns.json', triangleBudget: 14000, seed: 'abc' });
        clusters = await svc.plant({ crownsPath: 'crowns.json', triangleBudget: 14000, seed: 'abc', params: { crownCards: 0 } });
    }, 900_000);
    afterAll(() => { if (work) fs.rmSync(work, { recursive: true, force: true }); });

    it('keeps the mid clusters\' projected coverage for far fewer triangles, more cards on a larger crown', () => {
        const byId = (p: typeof cards) => new Map(p.stats.perTree.map((t: any) => [t.crownId, t]));
        const on = byId(cards), off = byId(clusters);
        expect(on.size).toBe(CROWNS.length);
        for (const [id, t] of on as Map<number, any>) {
            const o = (off as Map<number, any>).get(id);
            const c = t.lod.coverage;
            // the cards were placed toward the clusters' cover and reached it (clay), and the clusters' cover is what the
            // run without cards draws
            expect(t.lod.crownCards.cards).toBeGreaterThan(0);
            expect(c.cardTarget).toBeCloseTo(c.midClusters.mean, 6);
            expect(c.midClusters.mean).toBeCloseTo(o.lod.coverage.mid.mean, 6);
            expect(Math.abs(c.mid.mean - o.lod.coverage.mid.mean)).toBeLessThan(0.03);
            expect(c.mid.min).toBeGreaterThan(o.lod.coverage.mid.min - 0.1);
            // textured: the cards' cut-out covers at least what the clusters' did
            expect(c.cutout.mid.mean).toBeGreaterThan(c.cutout.midClusters.mean - 0.03);
            // triangles: two a card, plus the shared wood
            expect(t.lod.level1.drawnTriangles).toBe(t.lod.woodTriangles + 2 * t.lod.crownCards.cards);
            expect(t.lod.level1.drawnTriangles).toBeLessThan(0.1 * o.lod.level1.drawnTriangles);
            // the near and near-mid levels are untouched
            expect(t.lod.level0.drawnTriangles).toBe(o.lod.level0.drawnTriangles);
            expect(t.lod.nearMid.drawnTriangles).toBe(o.lod.nearMid.drawnTriangles);
        }
        // the 6 m crown has more cards than a 4.5 m one (the count follows the crown's area)
        expect((on as Map<number, any>).get(2).lod.crownCards.cards).toBeGreaterThan((on as Map<number, any>).get(0).lod.crownCards.cards);
        expect(cards.stats.lodFrames.allLevel1).toBeLessThan(0.1 * clusters.stats.lodFrames.allLevel1);
    });

    it('writes a contract GLB with the card layout, and the viewer\'s baked cut-out covers what the writer measured', () => {
        const { json } = parseGlb(fs.readFileSync(cards.treesGlb));
        expect(validateTreesGlbJson(json)).toEqual([]);
        const root = (json.nodes.find((n: any) => n.extras?.sbTrees)?.extras?.sbTrees ?? json.scenes?.[0]?.extras?.sbTrees) as TreesGlbRootExtras;
        const cc = root.crownCards!;
        expect(cc.schema).toBe('scratchbox.crown-cards/1');
        expect(cc.cells.length).toBe(cc.cols * cc.rows);
        expect(cc.meshes.every(m => root.clusterLibrary.variants.some(v => v.mesh === m && v.leavesLevel1 > 0))).toBe(true);
        // every tree's level 2 instances card meshes only
        const lvl2 = json.nodes.filter((n: any) => n.extras?.sbLod?.level === 2);
        expect(lvl2.length).toBe(CROWNS.length);
        for (const n of lvl2) for (const ci of n.children ?? []) expect(cc.meshes).toContain(json.nodes[ci].extras.sbCluster.clusterMesh);
        // the native mask's fill per cell, against the viewer's bake of the same layout
        const src = path.join(work, 'probe.cpp'), bin = path.join(work, 'probe');
        fs.writeFileSync(src, `#include "scratchbox_tree_lod.hpp"
#include <cstdio>
int main() { auto lib = scratchbox::tree_lod::buildClusterLibrary(scratchbox::tree_lod::LodParams{});
  for (int c = 0; c < lib.cardLayout.cellCount(); ++c) std::printf("%.4f\\n", lib.cardMask.fill(c)); }`);
        const r = spawnSync(process.env.CXX || 'clang++', ['-std=c++20', '-O2', '-I' + INCLUDE, src, '-o', bin], { encoding: 'utf8' });
        expect(r.status, r.stderr).toBe(0);
        const native = spawnSync(bin, [], { encoding: 'utf8' }).stdout.trim().split('\n').map(Number);
        const px = CROWN_CARD_ATLAS_PX, atlas = bakeCrownCardAtlas(cc, px, clayLeafPaint(cc));
        const cw = px / cc.cols;
        native.forEach((fill, cell) => {
            const col = cell % cc.cols, row = Math.floor(cell / cc.cols);
            let n = 0;
            for (let y = row * cw; y < (row + 1) * cw; y++) for (let x = col * cw; x < (col + 1) * cw; x++) if (atlas[(y * px + x) * 4 + 3] >= 128) n++;
            expect(Math.abs(n / (cw * cw) - fill)).toBeLessThan(0.01);
            // a dense spray: most of the card's disc is leaf
            expect(fill).toBeGreaterThan(0.3);
        });
        fs.mkdirSync(SHOTS, { recursive: true });
        const rgba = Buffer.alloc(px * px * 4);
        for (let y = 0; y < px; y++) for (let x = 0; x < px; x++) {
            const a = atlas[((px - 1 - y) * px + x) * 4 + 3], o = (y * px + x) * 4;
            rgba[o] = rgba[o + 1] = rgba[o + 2] = a ? 176 : 24; rgba[o + 3] = 255;
        }
        fs.writeFileSync(path.join(SHOTS, 'test_card_atlas_clay_mask.png'), encodePng(px, px, rgba));
    });

    it('dresses the cards as mid-level leaf meshes: crown shading, crossfade variants with the crown chunk, one clay grey', async () => {
        const buf = fs.readFileSync(cards.treesGlb);
        const root = (await new GLTFLoader().parseAsync(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer, '')).scene;
        const lod = new TreeLodController(root);
        expect(lod.treeCount).toBe(CROWNS.length);
        const cardMeshes: THREE.InstancedMesh[] = [];
        root.traverse(o => { if (o.userData.sbCrownCard) cardMeshes.push(o as THREE.InstancedMesh); });
        expect(cardMeshes.length).toBeGreaterThan(0);
        for (const m of cardMeshes) {
            expect(m.isInstancedMesh).toBe(true);
            expect(m.userData.sbCrownLeaf).toBe(true);
            expect(m.geometry.getAttribute('sbCrownC')).toBeDefined();
            const base = m.userData.sbLodBase as THREE.MeshStandardMaterial;
            expect(base.alphaMap).toBeTruthy();
            expect(base.alphaTest).toBe(0.5);
        }
        const compile = (mat: THREE.Material) => {
            const lib = THREE.ShaderLib.standard;
            const shader = { uniforms: THREE.UniformsUtils.clone(lib.uniforms), vertexShader: lib.vertexShader, fragmentShader: lib.fragmentShader } as any;
            mat.onBeforeCompile(shader, {} as THREE.WebGLRenderer);
            return shader;
        };
        // clay: the cards wear the trees' clay surface cut out by their leaves; wood and other leaves the one shared clay
        applyClayRenderMode([root], true);
        const shared = sharedTreeClayMaterial();
        for (const m of cardMeshes) {
            const clay = m.userData.sbLodBase as THREE.MeshStandardMaterial;
            expect(clay).toBe(m.userData.sbTreeClay);
            expect(clay.color.getHex()).toBe(shared.color.getHex());
            expect(clay.roughness).toBe(shared.roughness);
            expect(clay.metalness).toBe(shared.metalness);
            expect(clay.vertexColors).toBe(false);
            expect(clay.map).toBeNull();
        }
        // a crossfade: near-mid and mid dither; the card's variants keep the crown chunk, the cut-out and its mip lift
        const cardClay = cardMeshes[0].userData.sbLodBase as THREE.Material;
        expect((cardClay as THREE.MeshStandardMaterial).alphaMap).toBeTruthy();
        const crown = makeCrownVariant(cardClay);
        expect(isCrownVariant(crown)).toBe(true);
        for (const mat of [crown, makeFadeVariant(crown, 3, 9, true)]) {
            const s = compile(mat);
            expect(s.vertexShader).toContain(CROWN_VERTEX_MAIN.trim().slice(0, 60));
            expect(s.fragmentShader).toContain(CARD_ALPHA_MIP.trim().slice(0, 40));
            expect((mat as THREE.MeshStandardMaterial).alphaMap).toBe((cardClay as THREE.MeshStandardMaterial).alphaMap);
            expect((mat as THREE.MeshStandardMaterial).color.getHex()).toBe(shared.color.getHex());
        }
        // the controller crossfades near-mid into the cards with those variants: put the camera inside a tree's handover band
        const tree = (lod as any).trees[2];
        const band = tree.bands[2];
        const cam = new THREE.PerspectiveCamera(50, 1, 0.1, 5000);
        const centre = new THREE.Vector3().copy(tree.centerLocal).applyMatrix4(tree.node.matrixWorld);
        const d = band.minDistM + 0.5 * (tree.bands[1].maxDistM - band.minDistM) + tree.radiusLocal;
        lod.setView({ screen: { enabled: false } });
        cam.position.copy(centre).add(new THREE.Vector3(0, 0, d)); cam.lookAt(centre); cam.updateMatrixWorld(true);
        for (let i = 0; i < 3; i++) lod.update(cam);
        const state = lod.stateOf(2);
        expect(state[1]).toMatch(/^\d+-\d+$/);
        expect(state[2]).toMatch(/^\d+-\d+$/);
        const worn = cardMeshes.filter(m => (m.parent && tree.levels[2].meshes.includes(m))).map(m => m.material as THREE.Material);
        expect(worn.length).toBeGreaterThan(0);
        for (const mat of worn) {
            expect(isCrownVariant(mat)).toBe(true);
            const s = compile(mat);
            expect(s.vertexShader).toContain(CROWN_VERTEX_MAIN.trim().slice(0, 60));
            expect(s.vertexShader).toContain('uSbRange');
            expect((mat as THREE.MeshStandardMaterial).alphaMap).toBeTruthy();
        }
        lod.dispose();
    }, 120_000);
});
