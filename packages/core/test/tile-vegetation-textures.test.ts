/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Textured staged trees, end to end (tile_vegetation compiled with clang++, run through TileVegetationService):
 * - strip measures each crown's colour in the tile's photo (linear sRGB, trimmed mean and spread) and its season cues;
 * - plant chooses each tree's leaf set and bark from the tree texture library by appearance, deterministically (the same
 *   bytes on every run and at any thread count); the leaves follow the measured colour, the bark's relief the tree's size;
 * - the choice, its tints and the measured colour are in the trees GLB's extras, which pass the contract;
 * - leaf cards carry blade coordinates and an atlas pick, and map into the leaf cells; the wood carries UVs in the bark's tiles;
 * - in the viewport, textured mode dresses leaves, wood, twigs and masses from the library, leaf materials keep the crown
 *   shading and the level dissolve, and clay mode is unchanged (the one shared tree clay).
 * A swatch sheet of measured colours against the chosen leaves goes to test-results/screenshots/tree_textures/.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { TileVegetationService } from '../src/node/3d-engine/tile-vegetation-service';
import { validateTreesGlbJson, type TreeNodeExtras } from '../src/common/spatial/staged-location-contracts';
import { leafAtlasUv, leafCellIndex, type TreeTextureIndex } from '../src/common/spatial/tree-texture-library';
import { TreeLodController } from '../src/browser/generative-canvas/primitives/scene3d/treeLod/TreeLodController';
import { applyTreeTextures, LEAF_VERTEX_MAIN, LEAF_FRAGMENT_TRANSLUCENCY, TINT_FRAGMENT_COLOR, TreeTextureLibrary } from '../src/browser/generative-canvas/primitives/scene3d/treeLod/treeTextureMaterials';
import { CROWN_VERTEX_MAIN, isCrownVariant, makeCrownVariant } from '../src/browser/generative-canvas/primitives/scene3d/treeLod/treeCrownShading';
import { makeFadeVariant } from '../src/browser/generative-canvas/primitives/scene3d/treeLod/treeLodFade';
import { applyClayRenderMode, sharedTreeClayMaterial } from '../src/browser/generative-canvas/primitives/scene3d/clayRenderMode';
import { buildSyntheticTile, FOLIAGE_RGB, type SyntheticTileSpec } from './helpers/synthetic-textured-tile';
import { parseGlb, readAccessor } from './helpers/clay-glb-render';
import { encodePng } from '../src/node/texture-processing';

const REPO = fs.realpathSync(path.resolve(__dirname, '../../..'));
const SHOTS = path.join(REPO, 'test-results/screenshots/tree_textures');
const INDEX = JSON.parse(fs.readFileSync(path.join(REPO, 'assets/textures/trees/index.json'), 'utf8')) as TreeTextureIndex;
type Vec3 = [number, number, number];
const lin = (c: number) => { const v = c / 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
const chroma = (c: number[]) => { const s = c[0] + c[1] + c[2]; return c.map(x => x / s); };
const dist = (a: number[], b: number[]) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

function crown(id: number, stem: [number, number], supportY: number, apexY: number, radius: number, colour?: Vec3) {
    const samples: Vec3[] = [];
    const n = Math.ceil(radius / 0.7);
    for (let i = -n; i <= n; i++) for (let k = -n; k <= n; k++) {
        const dx = i * 0.7, dz = k * 0.7, d = Math.hypot(dx, dz);
        if (d <= radius) samples.push([stem[0] + dx, apexY - 0.45 * (apexY - supportY) * (d / radius) ** 2, stem[1] + dz]);
    }
    return {
        id, status: 'tree', reachesBoundary: false, apex: [stem[0], apexY, stem[1]], stem, supportY, supportSource: 'given', terrainY: supportY,
        apexAboveSupport: apexY - supportY, areaM2: Math.PI * radius * radius, sectorRadii: new Array(16).fill(radius), samples,
        ...(colour ? { colour: { meanLinearRgb: colour, spreadLinearRgb: [0.01, 0.01, 0.01], samples: 40, cells: 50, greenShare: 0.9, hueDeg: 100, chroma: 0.6 } } : {})
    };
}

// measured colours a tile photo gives: summer green, autumn yellow, autumn red-brown, a dark conifer-like green; a young
// small tree and an old large one of the same colour
const GREEN: Vec3 = [0.045, 0.075, 0.025], YELLOW: Vec3 = [0.30, 0.20, 0.025], RUST: Vec3 = [0.20, 0.07, 0.03], DARK: Vec3 = [0.02, 0.04, 0.03];
const CROWNS = [
    crown(0, [0, 0], 0, 14, 4.5, GREEN), crown(1, [16, 3], 0.4, 12, 4, YELLOW), crown(2, [-14, 8], -0.2, 12, 4, RUST),
    crown(3, [4, -16], 0, 13, 4, DARK), crown(4, [-20, -14], 0, 6, 2, GREEN), crown(5, [22, -18], 0, 26, 7, GREEN), crown(6, [-4, 20], 0, 11, 3.5)
];

let work: string;
let svc: TileVegetationService;

function writeCrowns(name: string, crowns: any[]): string {
    fs.writeFileSync(path.join(work, name), JSON.stringify({ version: 1, frame: { frame: 'x = east, y = up, z = south (metres)' }, params: { sampleSpacing: 0.7 }, crowns }));
    return name;
}
const sha = (f: string) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const treesOf = (json: any): Array<{ node: any; tree: TreeNodeExtras }> => json.nodes.filter((n: any) => n.extras?.sbTree).map((n: any) => ({ node: n, tree: n.extras.sbTree }));

beforeAll(async () => {
    work = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tree-textures-')));
    svc = new TileVegetationService({ workspaceRoot: work, repoRoot: REPO });
    await svc.ensureBinary();
}, 900_000);

afterAll(() => {
    if (work) fs.rmSync(work, { recursive: true, force: true });
});

describe('crown colour measured in the tile photo (strip)', () => {
    it('records each crown\'s colour (linear sRGB) and its season cues', async () => {
        const spec: SyntheticTileSpec = { halfSize: 24, spacing: 0.75, trees: [{ x: -8, z: -6, height: 11, radius: 4.5 }, { x: 9, z: 8, height: 9, radius: 3.5 }] };
        fs.writeFileSync(path.join(work, 'tile.glb'), buildSyntheticTile(spec));
        const strip = await svc.strip({ tilePath: 'tile.glb' });
        const crowns = JSON.parse(fs.readFileSync(strip.crownsJson, 'utf8')).crowns.filter((c: any) => c.status === 'tree');
        expect(crowns.length).toBe(2);
        const want = FOLIAGE_RGB.map(lin);
        for (const c of crowns) {
            expect(c.colour).toBeDefined();
            // the synthetic canopy is FOLIAGE_RGB with +-8 of noise: the trimmed mean is that colour in linear light
            c.colour.meanLinearRgb.forEach((v: number, k: number) => expect(Math.abs(v - want[k]) / want[k]).toBeLessThan(0.12));
            for (const s of c.colour.spreadLinearRgb) expect(s).toBeLessThan(0.02);
            expect(c.colour.samples).toBeGreaterThan(20);
            expect(c.colour.greenShare).toBeGreaterThan(0.8);
            expect(c.colour.hueDeg).toBeGreaterThan(80);
            expect(c.colour.hueDeg).toBeLessThan(130);
        }
        // and plant carries it into the tree's extras, labelled measured
        const planted = await svc.plant({ crownsPath: path.relative(work, strip.crownsJson), triangleBudget: 12000, seed: 'abc' });
        const { json } = parseGlb(fs.readFileSync(planted.treesGlb));
        expect(validateTreesGlbJson(json)).toEqual([]);
        for (const { tree } of treesOf(json)) {
            expect(tree.colour?.provenance).toBe('measured');
            expect(tree.texture?.colourProvenance).toBe('measured');
        }
    }, 600_000);
});

describe('textures chosen per tree (plant)', () => {
    let json: any, bin: Buffer, file: string;
    beforeAll(async () => {
        const planted = await svc.plant({ crownsPath: writeCrowns('crowns.json', CROWNS), triangleBudget: 40000, seed: 'abc' });
        file = planted.treesGlb;
        ({ json, bin } = parseGlb(fs.readFileSync(file)));
    }, 600_000);

    it('passes the contract, with each tree\'s choice, tints and measured colour in its extras', () => {
        expect(validateTreesGlbJson(json)).toEqual([]);
        expect(json.extras.sbTrees.textures.index).toBe('assets/textures/trees/index.json');
        expect(json.extras.sbTrees.clusterLibrary.leafCard.widthRatio).toBeGreaterThan(0);
        const trees = treesOf(json);
        expect(trees.length).toBe(CROWNS.length);
        for (const { tree } of trees) {
            const t = tree.texture!;
            expect(INDEX.leaves.some(e => e.id === t.leaves.entry)).toBe(true);
            expect(INDEX.bark.some(e => e.id === t.bark.entry)).toBe(true);
            expect(t.leaves.provenance).toBe('library');
            expect(t.bark.provenance).toBe('library');
            const measured = CROWNS.find(c => c.id === tree.id)!.colour;
            // a crown without a measured colour is chosen by its neighbours' (the median of the measured crowns)
            expect(t.colourProvenance).toBe(measured ? 'measured' : 'neighbours');
            if (measured) expect(tree.colour!.meanLinearRgb).toEqual(measured.meanLinearRgb);
            else expect(tree.colour).toBeUndefined();
        }
    });

    it('chooses leaves by measured colour and bark by size', () => {
        const byId = new Map(treesOf(json).map(({ tree }) => [tree.id, tree.texture!]));
        // the chosen leaf set is among the three nearest the measured chromaticity
        for (const c of CROWNS.filter(c => c.colour)) {
            const want = chroma(c.colour!.meanLinearRgb);
            const ranked = [...INDEX.leaves].sort((a, b) => dist(chroma(a.colour.meanLinearRgb), want) - dist(chroma(b.colour.meanLinearRgb), want)).map(e => e.id);
            expect(ranked.slice(0, 3), `crown ${c.id}`).toContain(byId.get(c.id)!.leaves.entry);
        }
        // the crown without a colour of its own is chosen by the neighbours' median, which is green here (4 of 6 green)
        const medianWant = chroma([0, 1, 2].map(k => [...CROWNS.filter(c => c.colour).map(c => c.colour!.meanLinearRgb[k])].sort((a, b) => a - b)[3]));
        const rankedForNone = [...INDEX.leaves].sort((a, b) => dist(chroma(a.colour.meanLinearRgb), medianWant) - dist(chroma(b.colour.meanLinearRgb), medianWant)).map(e => e.id);
        expect(rankedForNone.slice(0, 3)).toContain(byId.get(6)!.leaves.entry);
        // a yellow crown gets a yellower set than a green one (red over green of the chosen set's mean)
        const ratio = (id: string) => { const e = INDEX.leaves.find(x => x.id === id)!.colour.meanLinearRgb; return e[0] / e[1]; };
        expect(ratio(byId.get(1)!.leaves.entry)).toBeGreaterThan(ratio(byId.get(0)!.leaves.entry) + 0.3);
        // the tint takes the chosen set's mean most of the way to the measured chromaticity
        for (const c of CROWNS.filter(c => c.colour)) {
            const t = byId.get(c.id)!;
            const e = INDEX.leaves.find(x => x.id === t.leaves.entry)!.colour.meanLinearRgb;
            const tinted = e.map((v, k) => v * t.leaves.tint[k]);
            expect(dist(chroma(tinted), chroma(c.colour!.meanLinearRgb))).toBeLessThan(dist(chroma(e), chroma(c.colour!.meanLinearRgb)) + 1e-9);
        }
        // bark: the old large tree's target relief and chosen relief exceed the young small tree's
        const young = byId.get(4)!.bark, old = byId.get(5)!.bark;
        expect(old.sizeShare).toBeGreaterThan(young.sizeShare + 0.3);
        expect(old.targetReliefIndex).toBeGreaterThan(young.targetReliefIndex);
        expect(old.reliefIndex).toBeGreaterThan(young.reliefIndex);
        // the chosen bark's tile is its real size
        for (const t of byId.values()) expect(t.bark.tileM).toEqual(INDEX.bark.find(e => e.id === t.bark.entry)!.realSizeM);

        // swatches: per tree, the measured colour (left; grey when none), the chosen set's own mean (middle) and tinted (right)
        const enc = (v: number) => Math.round(255 * (v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055));
        const S = 64, W = 3 * S, H = S * CROWNS.length, px = Buffer.alloc(W * H * 4);
        CROWNS.forEach((c, row) => {
            const t = byId.get(c.id)!;
            const e = INDEX.leaves.find(x => x.id === t.leaves.entry)!.colour.meanLinearRgb;
            const cols = [c.colour?.meanLinearRgb ?? [0.2, 0.2, 0.2], e, e.map((v, k) => v * t.leaves.tint[k])];
            cols.forEach((col, k) => { for (let y = 2; y < S - 2; y++) for (let x = 2; x < S - 2; x++) px.set([...col.map(v => enc(Math.min(1, v))), 255], ((row * S + y) * W + k * S + x) * 4); });
        });
        fs.mkdirSync(SHOTS, { recursive: true });
        fs.writeFileSync(path.join(SHOTS, 'choice_swatches.png'), encodePng(W, H, px));
    });

    it('is deterministic: the same bytes at any thread count and on a rebuild', async () => {
        // a fresh cache, so the plant really runs again (one thread this time)
        const fresh = new TileVegetationService({ workspaceRoot: work, repoRoot: REPO, cacheDir: 'cache-rebuild' });
        const again = await fresh.plant({ crownsPath: writeCrowns('crowns-again.json', CROWNS), triangleBudget: 40000, seed: 'abc', threads: 1 });
        expect(again.cached).toBe(false);
        expect(sha(again.treesGlb)).toBe(sha(file));
        // another seed may choose differently among near-equal entries, and is as stable
        const other = await svc.plant({ crownsPath: writeCrowns('crowns-other.json', CROWNS), triangleBudget: 40000, seed: 'abd' });
        const other2 = await fresh.plant({ crownsPath: writeCrowns('crowns-other2.json', CROWNS), triangleBudget: 40000, seed: 'abd', threads: 2 });
        expect(other2.cached).toBe(false);
        expect(sha(other2.treesGlb)).toBe(sha(other.treesGlb));
    }, 600_000);

    it('gives leaf cards blade coordinates and an atlas pick that map into the leaf cells, and wood UVs in bark tiles', () => {
        const widthRatio = json.extras.sbTrees.clusterLibrary.leafCard.widthRatio as number;
        const clusters = json.meshes.filter((m: any) => /^sb_veggie_leaf_cluster_\d+(_mid|_nearmid)?$/.test(m.name));
        expect(clusters.length).toBeGreaterThan(0);
        const cells = INDEX.leaves.find(e => e.id === 'leaves_04')!.atlas.cells;
        let blades = 0, inside = 0;
        const usedCells = new Set<number>();
        for (const m of clusters) {
            const at = m.primitives[0].attributes;
            expect(at.TEXCOORD_0).toBeDefined();
            expect(at._LEAF).toBeDefined();
            const uv = readAccessor(json, bin, at.TEXCOORD_0).data, leaf = readAccessor(json, bin, at._LEAF).data;
            for (let v = 0; v < uv.length / 2; v++) {
                const kind = leaf[2 * v + 1];
                expect(kind === 0 || kind === 1).toBe(true);
                if (kind !== 1) continue;
                blades++;
                // a blade's own coordinates: within its outline's box (a little past it where the blade cups and droops)
                expect(Math.abs(uv[2 * v] - 0.5)).toBeLessThanOrEqual(0.5 * widthRatio + 0.02);
                expect(uv[2 * v + 1]).toBeGreaterThanOrEqual(-0.02);
                expect(uv[2 * v + 1]).toBeLessThanOrEqual(1.02);
                const k = leafCellIndex(leaf[2 * v], cells.length);
                usedCells.add(k);
                const r = leafAtlasUv([uv[2 * v], uv[2 * v + 1]], cells[k], widthRatio);
                if (r.inside) {
                    inside++;
                    expect(r.uv[0]).toBeGreaterThanOrEqual(-0.01); expect(r.uv[0]).toBeLessThanOrEqual(1.01);
                    expect(r.uv[1]).toBeGreaterThanOrEqual(-0.01); expect(r.uv[1]).toBeLessThanOrEqual(1.01);
                }
            }
        }
        expect(blades).toBeGreaterThan(1000);
        expect(inside / blades).toBeGreaterThan(0.6);
        expect(usedCells.size).toBe(cells.length);
        // wood: TEXCOORD_0 in whole tiles around (u from 0 to an integer), v along the path from the root
        const wood = json.meshes.filter((m: any) => /_lod0$/.test(m.name));
        expect(wood.length).toBe(CROWNS.length);
        for (const m of wood) {
            const uv = readAccessor(json, bin, m.primitives[0].attributes.TEXCOORD_0).data;
            let maxV = 0, minU = Infinity;
            for (let v = 0; v < uv.length / 2; v++) { minU = Math.min(minU, uv[2 * v]); maxV = Math.max(maxV, uv[2 * v + 1]); expect(uv[2 * v + 1]).toBeGreaterThanOrEqual(-1e-6); }
            expect(minU).toBeCloseTo(0, 6);
            expect(maxV).toBeGreaterThan(5);   // trunk and limbs of a 6-26 m tree in 0.5-1 m tiles
        }
    });

    it('dresses the trees in the viewport in textured mode, keeps crown shading and the dissolve, and leaves clay unchanged', async () => {
        const buf = fs.readFileSync(file);
        const root = (await new GLTFLoader().parseAsync(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer, '')).scene;
        const lod = new TreeLodController(root);
        expect(lod.treeCount).toBe(CROWNS.length);
        const lib = new TreeTextureLibrary(INDEX, '/assets/textures/trees/', () => new THREE.Texture());
        const stats = applyTreeTextures(root, lib);
        expect(stats.trees).toBe(CROWNS.length);
        expect(stats.leafMeshes).toBeGreaterThan(CROWNS.length * 3);
        expect(stats.woodMeshes).toBe(CROWNS.length * 4);    // the wood of every level
        expect(stats.twigMeshes).toBeGreaterThan(0);
        expect(stats.massMeshes).toBe(CROWNS.length);
        expect(stats.unknownEntries).toBe(0);
        const meshes: THREE.Mesh[] = [];
        root.traverse(o => { if ((o as THREE.Mesh).isMesh && o.userData.sbTreeLodMesh) meshes.push(o as THREE.Mesh); });
        // every tree mesh wears a library surface outside clay, with its tint as a per-mesh attribute
        for (const m of meshes) {
            const base = m.userData.sbLodBase as THREE.Material;
            expect(base.userData.sbTreeSurface).toMatch(/leaves|bark|masses/);
            expect((m.geometry as THREE.BufferGeometry).getAttribute('sbTreeTint')).toBeDefined();
        }
        const leafMesh = meshes.find(m => (m.userData.sbLodBase as THREE.Material).userData.sbTreeSurface === 'leaves')!;
        // the textures are shared: one material per entry, whatever the tree
        const leafBases = new Set(meshes.filter(m => (m.userData.sbLodBase as THREE.Material).userData.sbTreeSurface === 'leaves').map(m => m.userData.sbLodBase));
        expect(leafBases.size).toBeLessThanOrEqual(new Set(treesOf(json).map(t => t.tree.texture!.leaves.entry)).size);
        // the controller dresses it (crown variant of the textured leaf), and its dither variants keep both chunks
        const cam = new THREE.PerspectiveCamera(60, 1, 0.1, 5000);
        cam.position.set(0, 10, 25); cam.lookAt(0, 6, 0); cam.updateMatrixWorld(true);
        for (let i = 0; i < 4; i++) lod.update(cam);
        const compiled = (mat: THREE.Material) => {
            const lib3 = THREE.ShaderLib.standard;
            const shader = { uniforms: THREE.UniformsUtils.clone(lib3.uniforms), vertexShader: lib3.vertexShader, fragmentShader: lib3.fragmentShader } as any;
            mat.onBeforeCompile(shader, {} as THREE.WebGLRenderer);
            return shader;
        };
        const leafBase = leafMesh.userData.sbLodBase as THREE.Material;
        const crownVariant = makeCrownVariant(leafBase);
        expect(isCrownVariant(crownVariant)).toBe(true);
        for (const mat of [crownVariant, makeFadeVariant(crownVariant, 2, 6, true)]) {
            const s = compiled(mat);
            expect(s.vertexShader).toContain(CROWN_VERTEX_MAIN.trim().slice(0, 60));
            expect(s.vertexShader).toContain(LEAF_VERTEX_MAIN.trim().slice(0, 60));
            expect(s.fragmentShader).toContain(LEAF_FRAGMENT_TRANSLUCENCY.trim().slice(0, 40));
            expect(s.uniforms.uSbCellA.value.length).toBe(24);
            expect((mat as THREE.MeshStandardMaterial).alphaTest).toBe(0.5);
            expect((mat as THREE.MeshStandardMaterial).alphaToCoverage).toBe(true);
            expect((mat as THREE.MeshStandardMaterial).alphaMap).toBeTruthy();
        }
        // the mesh the controller dressed wears a crown variant of the textured leaf
        expect(isCrownVariant(leafMesh.material as THREE.Material) || (leafMesh.material as THREE.Material).userData.sbTreeSurface === 'leaves').toBe(true);
        const mass = meshes.find(m => (m.userData.sbLodBase as THREE.Material).userData.sbTreeSurface === 'masses')!;
        expect(compiled(mass.userData.sbLodBase).fragmentShader).toContain(TINT_FRAGMENT_COLOR.trim().slice(0, 30));
        // clay: every tree mesh wears the one shared tree clay; back to textured, each its library surface again
        applyClayRenderMode([root], true);
        for (const m of meshes) { expect(m.material).toBe(sharedTreeClayMaterial()); expect(m.userData.sbLodBase).toBe(sharedTreeClayMaterial()); }
        applyClayRenderMode([root], false);
        for (const m of meshes) expect((m.userData.sbLodBase as THREE.Material).userData.sbTreeSurface).toMatch(/leaves|bark|masses/);
        // textures applied while clay is on wait for clay to be turned off
        const root2 = (await new GLTFLoader().parseAsync(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer, '')).scene;
        new TreeLodController(root2);
        applyClayRenderMode([root2], true);
        applyTreeTextures(root2, lib);
        const meshes2: THREE.Mesh[] = [];
        root2.traverse(o => { if ((o as THREE.Mesh).isMesh && o.userData.sbTreeLodMesh) meshes2.push(o as THREE.Mesh); });
        for (const m of meshes2) expect(m.material).toBe(sharedTreeClayMaterial());
        applyClayRenderMode([root2], false);
        for (const m of meshes2) expect((m.userData.sbLodBase as THREE.Material).userData.sbTreeSurface).toMatch(/leaves|bark|masses/);
    }, 120_000);
});
