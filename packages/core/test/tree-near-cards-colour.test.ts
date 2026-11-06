/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Dense crowns for few triangles, their colour from each tree's own crown photo, and light through the leaves:
 *
 * - the near-mid level as clumped leaf cards (scratchbox_tree_lod.hpp nearMidCards*): the crown covered to its target for a
 *   few percent of the near-mid clusters' triangles;
 * - the near level's core cards (coreCards*): cards beneath the leaves where the crown still shows through them, on the
 *   atlas's open cells, the near level's every leaf kept;
 * - every card set aimed at the crown's Beer-Lambert target, the mid cards included;
 * - the leaves' colour variation from the spread of the tree's own crown colour in the tile's photo, labelled
 *   photo-inferred; a crown with no measured colour takes its neighbours', labelled generated;
 * - the viewer: core cards shaded, the tree's variation on its leaves and cards, and the translucency term (gathered toward
 *   the sun, tinted, on leaves, cards and the far masses).
 *
 * Runs the real tile_vegetation binary on synthetic crowns; nothing is mocked.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { TileVegetationService } from '../src/node/3d-engine/tile-vegetation-service';
import { validateTreesGlbJson, type TreeNodeExtras, type TreesGlbRootExtras } from '../src/common/spatial/staged-location-contracts';
import { DEFAULT_TREE_TEXTURE_OPTIONS, type TreeTextureIndex } from '../src/common/spatial/tree-texture-library';
import { TreeLodController } from '../src/browser/generative-canvas/primitives/scene3d/treeLod/TreeLodController';
import {
    CARD_FRAGMENT_TRANSLUCENCY, LEAF_FRAGMENT_TRANSLUCENCY, TREE_CARD_ATTRIBUTE, TreeTextureLibrary, applyTreeTextures, translucencyFragment
} from '../src/browser/generative-canvas/primitives/scene3d/treeLod/treeTextureMaterials';
import { DEFAULT_CROWN_SHADING } from '../src/browser/generative-canvas/primitives/scene3d/treeLod/treeCrownShading';
import { parseGlb } from './helpers/clay-glb-render';

const REPO = fs.realpathSync(path.resolve(__dirname, '../../..'));
const INDEX = JSON.parse(fs.readFileSync(path.join(REPO, 'assets/textures/trees/index.json'), 'utf8')) as TreeTextureIndex;

type Vec3 = [number, number, number];
/** A summer crown; `spread` is the standard deviation of its colour in the photo, per channel (undefined: no measured colour). */
function crown(id: number, stem: [number, number], apexY: number, radius: number, spread?: Vec3) {
    const samples: Vec3[] = [];
    const n = Math.ceil(radius / 0.7);
    for (let i = -n; i <= n; i++) for (let k = -n; k <= n; k++) {
        const dx = i * 0.7, dz = k * 0.7, d = Math.hypot(dx, dz);
        if (d <= radius) samples.push([stem[0] + dx, apexY - 0.45 * apexY * (d / radius) ** 2, stem[1] + dz]);
    }
    return {
        id, status: 'tree', reachesBoundary: false, apex: [stem[0], apexY, stem[1]], stem, supportY: 0, supportSource: 'given', terrainY: 0,
        apexAboveSupport: apexY, areaM2: Math.PI * radius * radius, sectorRadii: new Array(16).fill(radius), samples,
        ...(spread ? { colour: { meanLinearRgb: [0.08, 0.09, 0.045], spreadLinearRgb: spread, samples: 100, cells: 50, greenShare: 1, hueDeg: 70, chroma: 0.5 } } : {})
    };
}
// two crowns measured with a narrow and a wide colour spread, and one with no measured colour
const CROWNS = [crown(0, [0, 0], 14, 4.5, [0.004, 0.0045, 0.002]), crown(1, [16, 3], 14, 4.5, [0.016, 0.018, 0.009]), crown(2, [4, -16], 20, 5.5)];

describe('near-level cards, crown-photo colour and translucency', () => {
    let work: string;
    let on: Awaited<ReturnType<TileVegetationService['plant']>>;
    let off: Awaited<ReturnType<TileVegetationService['plant']>>;
    beforeAll(async () => {
        work = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tree-near-cards-')));
        const svc = new TileVegetationService({ workspaceRoot: work, repoRoot: REPO });
        await svc.ensureBinary();
        const growth = { excurrentApicalLo: 2, excurrentApicalHi: 3 };
        fs.writeFileSync(path.join(work, 'crowns.json'), JSON.stringify({ version: 1, frame: { frame: 'x = east, y = up, z = south (metres)' }, params: { sampleSpacing: 0.7 },
            growth, species: { index: 'assets/vegetation/species/index.json' }, crowns: CROWNS }));
        on = await svc.plant({ crownsPath: 'crowns.json', triangleBudget: 14000, seed: 'abc' });
        off = await svc.plant({ crownsPath: 'crowns.json', triangleBudget: 14000, seed: 'abc', params: { nearMidCards: 0, coreCards: 0, cardTargetShare: 0 } });
    }, 900_000);
    afterAll(() => { if (work) fs.rmSync(work, { recursive: true, force: true }); });

    const byId = (p: typeof on) => new Map<number, any>(p.stats.perTree.map((t: any) => [t.crownId, t]));

    it('draws the near-mid level as cards that cover the crown to its target for a few percent of the clusters\' triangles', () => {
        const a = byId(on), b = byId(off);
        for (const [id, t] of a) {
            const o = b.get(id), c = t.lod.coverage;
            expect(t.lod.nearMidCards.cards).toBeGreaterThan(0);
            expect(o.lod.nearMidCards).toBeUndefined();
            // two triangles a card and the shared wood, against the clusters' tens of thousands
            expect(t.lod.nearMid.drawnTriangles).toBe(t.lod.woodTriangles + 2 * t.lod.nearMidCards.cards);
            expect(t.lod.nearMid.drawnTriangles).toBeLessThan(0.1 * o.lod.nearMid.drawnTriangles);
            // the clusters' cover is what the run without cards draws; the cards reach the larger of it and the crown's target
            expect(c.nearMidClusters.mean).toBeCloseTo(o.lod.coverage.nearMid.mean, 6);
            expect(c.nearMidCardTarget).toBeCloseTo(Math.max(c.nearMidClusters.mean, c.target), 6);
            expect(c.nearMid.mean).toBeGreaterThan(c.nearMidCardTarget - 0.05);
            expect(c.nearMid.mean).toBeGreaterThan(o.lod.coverage.nearMid.mean);
            expect(c.drawn.nearMid.mean).toBeGreaterThanOrEqual(c.nearMid.mean - 1e-9);
        }
        expect(on.stats.lodFrames.allNearMid).toBeLessThan(0.1 * off.stats.lodFrames.allNearMid);
    });

    it('keeps every leaf of the near level and adds core cards where the crown showed through them', () => {
        const a = byId(on), b = byId(off);
        for (const [id, t] of a) {
            const o = b.get(id), c = t.lod.coverage;
            // the same leaves, clusters and wood: only the cards are added
            expect(t.lod.level0.leaves).toBe(o.lod.level0.leaves);
            expect(t.lod.level0.leafTriangles).toBe(o.lod.level0.leafTriangles);
            expect(c.level0.mean).toBeCloseTo(o.lod.coverage.level0.mean, 9);
            expect(t.lod.coreCards.cards).toBeGreaterThan(0);
            expect(t.lod.level0.drawnTriangles).toBe(o.lod.level0.drawnTriangles + 2 * t.lod.coreCards.cards);
            // they cost under 2% of the near level and close a good part of the gap to the crown's target
            expect(2 * t.lod.coreCards.cards).toBeLessThan(0.02 * o.lod.level0.drawnTriangles);
            expect(c.coreCardTarget).toBeCloseTo(c.target, 6);
            expect(c.level0Core.mean).toBeGreaterThan(c.level0.mean + 0.5 * (c.target - c.level0.mean));
            expect(c.level0Core.mean).toBeLessThanOrEqual(c.target + 0.03);
        }
    });

    it('aims the mid cards at the crown\'s target too, and without the target share at the clusters\' cover as before', () => {
        const a = byId(on), b = byId(off);
        for (const [id, t] of a) {
            const c = t.lod.coverage, oc = b.get(id).lod.coverage;
            expect(oc.cardTarget).toBeCloseTo(oc.midClusters.mean, 6);
            expect(c.cardTarget).toBeCloseTo(Math.max(c.midClusters.mean, c.target), 6);
            expect(c.mid.mean).toBeGreaterThan(c.cardTarget - 0.03);
            // the far masses follow the near level's larger cover (the same triangles)
            expect(t.lod.level2Triangles).toBe(b.get(id).lod.level2Triangles);
        }
    });

    it('writes a contract GLB: open cells for the near cards, dense cells for the mid cards, and the colour\'s provenance', () => {
        const { json } = parseGlb(fs.readFileSync(on.treesGlb));
        expect(validateTreesGlbJson(json)).toEqual([]);
        const root = (json.nodes.find((n: any) => n.extras?.sbTrees)?.extras?.sbTrees ?? json.scenes?.[0]?.extras?.sbTrees) as TreesGlbRootExtras;
        const cc = root.crownCards!;
        expect(cc.cells.length).toBe(cc.cols * cc.rows);
        expect(cc.denseCells).toBeGreaterThan(0);
        expect(cc.denseCells!).toBeLessThan(cc.cells.length);
        // an open cell holds fewer leaves than a dense one
        expect(cc.cells[cc.cells.length - 1].length).toBeLessThan(0.5 * cc.cells[0].length);
        const cellOf = (n: any) => cc.meshes.indexOf(n.extras.sbCluster.clusterMesh);
        const level = (l: number) => json.nodes.filter((n: any) => n.extras?.sbLod?.level === l);
        for (const n of level(1)) for (const ci of n.children ?? []) expect(cellOf(json.nodes[ci])).toBeGreaterThanOrEqual(cc.denseCells!);
        for (const n of level(2)) for (const ci of n.children ?? []) { expect(cellOf(json.nodes[ci])).toBeGreaterThanOrEqual(0); expect(cellOf(json.nodes[ci])).toBeLessThan(cc.denseCells!); }
        for (const n of level(0)) {
            const kids = (n.children ?? []).map((ci: number) => json.nodes[ci]);
            const core = kids.filter((k: any) => cellOf(k) >= 0);
            expect(core.length).toBeGreaterThan(0);
            for (const k of core) expect(cellOf(k)).toBeGreaterThanOrEqual(cc.denseCells!);
            expect(kids.some((k: any) => /leaf_cluster/.test(k.extras.sbCluster.clusterMesh))).toBe(true);
        }
        // the colour: a measured crown's tint and variation are photo-inferred, the variation following its spread; a crown
        // with no measured colour is a fill, labelled generated with its reason, and carries no variation of its own
        const trees = new Map<number, TreeNodeExtras>(json.nodes.filter((n: any) => n.extras?.sbTree).map((n: any) => [n.extras.sbTree.id, n.extras.sbTree]));
        const narrow = trees.get(0)!.texture!, wide = trees.get(1)!.texture!, none = trees.get(2)!.texture!;
        expect(narrow.colourProvenance).toBe('measured');
        expect(narrow.tintProvenance!.label).toBe('photo-inferred');
        expect(wide.tintProvenance!.label).toBe('photo-inferred');
        expect(narrow.leaves.variation!).toBeGreaterThanOrEqual(0.08);
        expect(wide.leaves.variation!).toBeLessThanOrEqual(0.45);
        expect(wide.leaves.variation!).toBeGreaterThan(narrow.leaves.variation! + 0.05);
        // relative spread 0.2 of the mean: a quarter of it as the leaves' own, as the viewer's uniform factor (x sqrt(12))
        expect(wide.leaves.variation!).toBeCloseTo(0.25 * 0.2 * Math.sqrt(12), 2);
        expect(none.colourProvenance).toBe('neighbours');
        expect(none.tintProvenance!.label).toBe('generated');
        expect(none.tintProvenance!.reason).toMatch(/no measured colour/);
        expect(none.leaves.variation).toBeUndefined();
        // the tinted leaf set's mean is the crown's own measured colour
        const e = INDEX.leaves.find(l => l.id === narrow.leaves.entry)!;
        for (let k = 0; k < 3; k++) expect(e.colour.meanLinearRgb[k] * narrow.leaves.tint[k]).toBeCloseTo([0.08, 0.09, 0.045][k], 4);
    });

    it('dresses the cards in the viewport: core cards shaded, the tree\'s own variation on leaves and cards, light through leaves, cards and masses', async () => {
        const buf = fs.readFileSync(on.treesGlb);
        const root = (await new GLTFLoader().parseAsync(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer, '')).scene;
        const lod = new TreeLodController(root);
        expect(lod.treeCount).toBe(CROWNS.length);
        const lib = new TreeTextureLibrary(INDEX, '/assets/textures/trees/', () => new THREE.Texture());
        const stats = applyTreeTextures(root, lib);
        expect(stats.unknownEntries).toBe(0);
        const treeOf = (m: THREE.Object3D): TreeNodeExtras => { let o: THREE.Object3D | null = m; while (o && !o.userData.sbTree) o = o.parent; return o!.userData.sbTree; };
        const levelOf = (m: THREE.Object3D): number => { let o: THREE.Object3D | null = m; while (o && !o.userData.sbLod) o = o.parent; return o!.userData.sbLod.level; };
        const tintOf = (m: THREE.Mesh) => Array.from((m.geometry.getAttribute('sbTreeTint') as THREE.BufferAttribute).array as Float32Array).slice(0, 4);
        const cards: THREE.Mesh[] = [], leaves: THREE.Mesh[] = [];
        root.traverse(o => {
            const m = o as THREE.Mesh;
            if (!m.isMesh || !m.userData.sbTreeLodMesh) return;
            const s = (m.userData.sbLodBase as THREE.Material).userData.sbTreeSurface;
            if (s === 'crown-cards') cards.push(m); else if (s === 'leaves') leaves.push(m);
        });
        const core = cards.filter(m => levelOf(m) === 0), nearMid = cards.filter(m => levelOf(m) === 1), mid = cards.filter(m => levelOf(m) === 2);
        expect(core.length).toBeGreaterThan(0); expect(nearMid.length).toBeGreaterThan(0); expect(mid.length).toBeGreaterThan(0);
        const shade = DEFAULT_TREE_TEXTURE_OPTIONS.coreCardShade;
        expect(shade).toBeGreaterThan(0.3); expect(shade).toBeLessThan(1);
        for (const m of cards) {
            const tex = treeOf(m).texture!, t = tintOf(m), k = levelOf(m) === 0 ? shade : 1;
            for (let c = 0; c < 3; c++) expect(t[c]).toBeCloseTo(tex.leaves.tint[c] * k, 5);
            expect(t[3]).toBeCloseTo(tex.leaves.variation ?? 0, 5);
            expect(!!m.userData.sbCoreCard).toBe(levelOf(m) === 0);
            // every card is a crown leaf (the inner darkening and the occlusion reach it)
            expect(m.userData.sbCrownLeaf).toBe(true);
        }
        for (const m of leaves) {
            const a = (m.geometry.getAttribute(TREE_CARD_ATTRIBUTE) as THREE.BufferAttribute).array as Float32Array;
            expect(a[2]).toBeCloseTo(treeOf(m).texture!.leaves.variation ?? 0, 5);
        }
        // the shaders: every surface that carries leaves compiles with the translucency term, gathered toward the sun and tinted
        const compile = (mat: THREE.Material) => {
            const l = THREE.ShaderLib.standard;
            const shader = { uniforms: THREE.UniformsUtils.clone(l.uniforms), vertexShader: l.vertexShader, fragmentShader: l.fragmentShader } as any;
            mat.onBeforeCompile(shader, {} as THREE.WebGLRenderer);
            return shader;
        };
        expect(LEAF_FRAGMENT_TRANSLUCENCY).toBe(translucencyFragment('vSbBlade'));
        expect(CARD_FRAGMENT_TRANSLUCENCY).toBe(translucencyFragment('1.0'));
        expect(translucencyFragment('1.0')).toContain('dot( - normalize( vViewPosition ), SB_SUN_DIR )');
        expect(translucencyFragment('1.0')).toContain('diffuseColor.rgb * uSbTransShape.rgb * SB_SUN_COLOR');
        const o = DEFAULT_TREE_TEXTURE_OPTIONS;
        for (const [mat, strength] of [[leaves[0].userData.sbLodBase, o.translucency], [cards[0].userData.sbLodBase, o.translucency], [lib.masses, o.massTranslucency]] as Array<[THREE.Material, number]>) {
            const s = compile(mat);
            expect(s.fragmentShader).toContain('uniform vec4 uSbTransShape;');
            expect(s.fragmentShader).toContain('sbToward');
            expect(s.uniforms.uSbTranslucency.value).toBe(strength);
            expect(s.uniforms.uSbTransShape.value.toArray()).toEqual([...o.translucencyTint, o.translucencyFocus]);
        }
        // what passes through a leaf is yellower than what it reflects (green over blue), and the masses pass less than a leaf
        expect(o.translucencyTint[1]).toBeGreaterThan(o.translucencyTint[2]);
        expect(o.massTranslucency).toBeLessThan(o.translucency);
        // bark passes no light
        const bark = lib.barkMaterial(treeOf(leaves[0]).texture!.bark.entry)!;
        expect(compile(bark).fragmentShader).not.toContain('sbToward');
        // the core is darker than it was, never black
        expect(DEFAULT_CROWN_SHADING.innerDarkening).toBeGreaterThan(0.4);
        expect(DEFAULT_CROWN_SHADING.innerDarkening).toBeLessThanOrEqual(0.7);
    });
});
