/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The crown breakup of staged trees (treeCrownShading.ts CrownBreakupOptions): holes toward the crown's rim, interior
 * pockets and clump value variation, in world space.
 *
 * - the breakup's chunks are in the crown variant of every leaf mesh (instanced clusters and the far masses), in every
 *   dither variant of a crossfade, and in the depth and distance materials every leaf mesh with a crown draws its shadow
 *   with (wood keeps the renderer's own); dispose takes them off again;
 * - the decision is a function of the world point: every level of a tree (each in its own mesh frame, the tree scaled in
 *   the world) gives the same crown depth, scale and per-tree value at the same world point, so the same discard;
 * - it turns off (and with the crown shading), takes three or four per-slot values, and clamps what it is given;
 * - in a real WebGL viewport (headless Chrome, trees grown by the native plant with their far trunk and limbs), the GLSL
 *   decides as the TypeScript mirror does, every program compiles, holes open at the mid and far levels, and the shadow
 *   pass draws them (dappled shadows). Screenshots go to test-results/screenshots/tree_breakup/ (git-ignored).
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { TreeLodController } from '../src/browser/generative-canvas/primitives/scene3d/treeLod/TreeLodController';
import {
    BREAKUP_FRAGMENT_DISCARD, BREAKUP_FRAGMENT_PARS, CROWN_FIELD_VERTEX_PARS, breakupDepthMaterial, breakupDistanceMaterial, breakupKeepAt, crownShadingUniforms, crownSignedDepthAt,
    isBreakupDepthMaterial, resolveCrownShading, setCrownShadingUniforms, DEFAULT_CROWN_BREAKUP, DEFAULT_CROWN_SHADING
} from '../src/browser/generative-canvas/primitives/scene3d/treeLod/treeCrownShading';
import { isFadeVariant, makeFadeVariant } from '../src/browser/generative-canvas/primitives/scene3d/treeLod/treeLodFade';
import { TileVegetationService } from '../src/node/3d-engine/tile-vegetation-service';
import { buildTreesLodGltf, writeTreesLodGlb } from './helpers/synthetic-trees-lod-glb';
import { chromeAvailable, openHarness, type Harness } from './tree-lod-harness/runHarness';

const REPO = fs.realpathSync(path.resolve(__dirname, '../../..'));
const SHOTS = path.join(REPO, 'test-results', 'screenshots', 'tree_breakup');

async function loadFixture(trees: number, lobes = false): Promise<THREE.Object3D> {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sb-breakup-')), 't.glb');
    writeTreesLodGlb(file, buildTreesLodGltf({ trees, crown: true, lobes }));
    const buf = fs.readFileSync(file);
    const gltf = await new GLTFLoader().parseAsync(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer, '');
    fs.rmSync(path.dirname(file), { recursive: true, force: true });
    return gltf.scene;
}

const lodMeshes = (root: THREE.Object3D): THREE.Mesh[] => { const out: THREE.Mesh[] = []; root.traverse(o => { const m = o as THREE.Mesh; if (m.isMesh && m.userData.sbTreeLodMesh) out.push(m); }); return out; };
const levelOf = (m: THREE.Object3D): number => { for (let o: THREE.Object3D | null = m; o; o = o.parent) if (o.userData?.sbLod) return o.userData.sbLod.level; return -1; };
const treeNodes = (root: THREE.Object3D): THREE.Object3D[] => { const out: THREE.Object3D[] = []; root.traverse(o => { if (o.userData?.sbTree) out.push(o); }); return out; };
const clock = (): { now: () => number; tick: (ms?: number) => void } => { let t = 1000; return { now: () => t, tick: (ms = 16.7) => { t += ms; } }; };

function cameraAt(tree: THREE.Object3D, d: number): THREE.PerspectiveCamera {
    tree.updateMatrixWorld(true);
    const s = new THREE.Box3().setFromObject(tree).getBoundingSphere(new THREE.Sphere());
    const cam = new THREE.PerspectiveCamera(60, 1, 0.1, 6000);
    cam.position.copy(s.center).add(new THREE.Vector3(0, 0, s.radius + d));
    cam.lookAt(s.center); cam.updateMatrixWorld(true);
    return cam;
}

/** Runs a material's onBeforeCompile on a ShaderLib source, as the renderer would. */
function compiled(mat: THREE.Material, lib: keyof typeof THREE.ShaderLib = 'standard'): { vertexShader: string; fragmentShader: string; uniforms: Record<string, THREE.IUniform> } {
    const src = THREE.ShaderLib[lib];
    const shader = { uniforms: THREE.UniformsUtils.clone(src.uniforms), vertexShader: src.vertexShader, fragmentShader: src.fragmentShader } as any;
    mat.onBeforeCompile(shader, {} as THREE.WebGLRenderer);
    return shader;
}

describe('crown breakup: shader chunks', () => {
    it('is in every leaf variant, every dither variant and the shadow materials; wood keeps the renderer\'s own', async () => {
        const root = await loadFixture(1, true);
        const c = clock();
        const lod = new TreeLodController(root, { now: c.now });
        const tree = treeNodes(root)[0];
        const leaves = lodMeshes(root).filter(m => m.userData.sbCrownLeaf), wood = lodMeshes(root).filter(m => !m.userData.sbCrownLeaf);
        expect(leaves.some(m => (m as THREE.InstancedMesh).isInstancedMesh)).toBe(true);
        expect(leaves.some(m => !(m as THREE.InstancedMesh).isInstancedMesh && levelOf(m) === 3)).toBe(true);
        for (const m of leaves) { expect(m.customDepthMaterial).toBe(breakupDepthMaterial()); expect(m.customDistanceMaterial).toBe(breakupDistanceMaterial()); }
        for (const m of wood) { expect(m.customDepthMaterial).toBeUndefined(); expect(m.customDistanceMaterial).toBeUndefined(); }
        // full: the crown variant of every level
        for (const level of [0, 1, 2, 3]) {
            lod.forceLevel(level); c.tick(5000); lod.update(cameraAt(tree, 20));
            for (const m of leaves.filter(x => levelOf(x) === level)) {
                const s = compiled(m.material as THREE.Material);
                expect(s.vertexShader).toContain(CROWN_FIELD_VERTEX_PARS); expect(s.vertexShader).toContain('sbBreakupVertex( sbLocal, sbS );');
                expect(s.fragmentShader).toContain(BREAKUP_FRAGMENT_PARS); expect(s.fragmentShader).toContain(BREAKUP_FRAGMENT_DISCARD);
                expect(s.uniforms.uSbBkHoles).toBe(crownShadingUniforms().uSbBkHoles);
            }
        }
        // every crossfade: the dither variants of the leaves keep the breakup (instanced and plain), the wood's have none
        lod.forceLevel(null);
        let seen = 0;
        for (const d of [55, 100, 185]) {
            for (let i = 0; i < 80; i++) { c.tick(); lod.update(cameraAt(tree, d)); }
            for (const m of lodMeshes(root).filter(x => isFadeVariant(x.material as THREE.Material))) {
                const s = compiled(m.material as THREE.Material);
                expect(s.fragmentShader.includes(BREAKUP_FRAGMENT_DISCARD)).toBe(!!m.userData.sbCrownLeaf);
                if (m.userData.sbCrownLeaf) seen++;
            }
        }
        expect(seen).toBeGreaterThan(0);
        // a dither variant made directly from a crown variant, for an instanced and a plain mesh
        const crownMat = leaves[0].material as THREE.Material;
        for (const inst of [true, false]) {
            const s = compiled(makeFadeVariant(crownMat, 2, 6, inst));
            expect(s.fragmentShader).toContain(BREAKUP_FRAGMENT_DISCARD); expect(s.vertexShader).toContain('uSbRange');
        }
        // the shadow materials: the renderer's depth and distance shaders with the crown field and the same hole test
        for (const [mat, lib] of [[breakupDepthMaterial(), 'depth'], [breakupDistanceMaterial(), 'distance']] as const) {
            expect(isBreakupDepthMaterial(mat)).toBe(true);
            const s = compiled(mat, lib);
            expect(s.vertexShader).toContain(CROWN_FIELD_VERTEX_PARS);
            expect(s.vertexShader).toMatch(/#include <project_vertex>\s*\{[\s\S]*sbBreakupVertex\( sbLocal, sbCrownField\( sbLocal\.xyz, sbG, sbDepth \) \);/);
            expect(s.fragmentShader).toContain(BREAKUP_FRAGMENT_DISCARD);
            expect(s.uniforms.uSbBkOn).toBe(crownShadingUniforms().uSbBkOn);
        }
        lod.dispose();
        for (const m of leaves) { expect(m.customDepthMaterial).toBeUndefined(); expect(m.customDistanceMaterial).toBeUndefined(); }
    });
});

describe('crown breakup: world space', () => {
    it('decides the same at the same world point at every level, whatever each level\'s mesh frame', async () => {
        const root = await loadFixture(1);
        const tree = treeNodes(root)[0];
        // each level in a frame of its own (a similarity), and the tree scaled in the world: the crown attributes follow
        tree.scale.setScalar(1.7); tree.position.set(31, -2, 12); tree.rotation.y = 0.4;
        tree.children.forEach((lv, k) => { lv.position.set(0.3 * k, -0.2 * k, 0.1 * k); lv.rotation.set(0, 0.25 * k, 0); lv.scale.setScalar(1 + 0.15 * k); });
        root.updateMatrixWorld(true);
        // the same factors at every slot, so only the inputs could differ between levels
        setCrownShadingUniforms(resolveCrownShading({ breakup: { holes: [0.5, 0.5, 0.5, 0.5], pockets: [0.15, 0.15, 0.15, 0.15] } }));
        const lod = new TreeLodController(root);
        const leaves = lodMeshes(root).filter(m => m.userData.sbCrownLeaf);
        expect(new Set(leaves.map(levelOf))).toEqual(new Set([0, 1, 2, 3]));
        // the crown's centre and size in the world, the points around and through it
        const crown = tree.userData.sbTree.crown;
        const centre = new THREE.Vector3(...crown.centre).applyMatrix4(tree.matrixWorld);
        let decisions = 0, dropped = 0;
        for (let i = 0; i < 400; i++) {
            const a = i * 2.39996, r = 1.7 * 2.6 * Math.sqrt((i + 0.5) / 400);
            const P = centre.clone().add(new THREE.Vector3(r * Math.cos(a), 1.7 * 1.8 * Math.sin(0.7 * i), r * Math.sin(a)));
            const perLevel = leaves.map(m => {
                const g = m.geometry as THREE.BufferGeometry;
                const local = P.clone().applyMatrix4(m.matrixWorld.clone().invert());
                const depth = crownSignedDepthAt(m, local);
                const perM = g.getAttribute('sbCrownS1').getW(0), radius = g.getAttribute('sbCrownS0').getW(0);
                return { depth, perM, radius, keep: breakupKeepAt([P.x / perM, P.y / perM, P.z / perM], depth, 2, 0.01, 0.37, radius) };
            });
            for (const p of perLevel) {
                expect(p.depth).toBeCloseTo(perLevel[0].depth, 4);
                expect(p.perM).toBeCloseTo(1.7, 5);
                expect(p.radius).toBeCloseTo((2.5 + 2 + 1.5) / 3, 5);
                expect(p.keep).toBe(perLevel[0].keep);
            }
            decisions++; if (!perLevel[0].keep) dropped++;
        }
        // it is not a constant: some points drop and most stay
        expect(dropped).toBeGreaterThan(0.05 * decisions); expect(dropped).toBeLessThan(0.7 * decisions);
        lod.dispose();
        setCrownShadingUniforms(DEFAULT_CROWN_SHADING);
    });

    it('gives a leaf cluster the far mass\'s lobe depth near its origin (the first-order extension of the instance\'s field)', async () => {
        const root = await loadFixture(1, true);
        const lod = new TreeLodController(root);
        const leaves = lodMeshes(root).filter(m => m.userData.sbCrownLeaf);
        const far = leaves.find(m => levelOf(m) === 3)!, cluster = leaves.find(m => (m as THREE.InstancedMesh).isInstancedMesh)! as THREE.InstancedMesh;
        for (let k = 0; k < cluster.count; k++) {
            const o = new THREE.Vector3().setFromMatrixPosition(new THREE.Matrix4().fromArray(cluster.instanceMatrix.array as Float32Array, 16 * k));
            for (const off of [[0, 0, 0], [0.1, 0, 0], [0, 0.1, 0], [0, 0, -0.1]]) {
                const pLocal = o.clone().add(new THREE.Vector3(...off));
                const world = pLocal.clone().applyMatrix4(cluster.matrixWorld);
                const viaCluster = crownSignedDepthAt(cluster, pLocal, k);
                const viaFar = crownSignedDepthAt(far, world.clone().applyMatrix4(far.matrixWorld.clone().invert()));
                expect(Math.abs(viaCluster - viaFar)).toBeLessThan(0.05);
            }
        }
        lod.dispose();
    });
});

describe('crown breakup: options', () => {
    it('turns off by toggle and with the crown shading, takes three or four per-slot values, and clamps', () => {
        const u = crownShadingUniforms();
        setCrownShadingUniforms(resolveCrownShading(null));
        expect(u.uSbBkOn.value).toBe(1);
        expect(u.uSbBkHoles.value.toArray()).toEqual([...DEFAULT_CROWN_BREAKUP.holes]);
        setCrownShadingUniforms(resolveCrownShading({ breakup: { enabled: false } }));
        expect(u.uSbBkOn.value).toBe(0);
        expect(breakupKeepAt([1, 2, 3], -1, 3, 0.01, 0, 3)).toBe(true);        // off: nothing is dropped, even outside the crown
        setCrownShadingUniforms(resolveCrownShading({ enabled: false }));
        expect(u.uSbBkOn.value).toBe(0);
        const r = resolveCrownShading({ breakup: { holes: [0.1, 0.5, 0.9], clumpMinM: -3, clumpMaxM: 0.2, gapDarkening: 4, filterStart: 0.5, filterEnd: 0.1 } });
        expect(r.breakup.holes).toEqual([0.1, 0.3, 0.5, 0.9]);
        setCrownShadingUniforms(r);
        expect(u.uSbBkShape.value.y).toBeGreaterThan(0); expect(u.uSbBkShape.value.z).toBeGreaterThanOrEqual(u.uSbBkShape.value.y);
        expect(u.uSbBkFilter.value.w).toBe(1); expect(u.uSbBkFilter.value.z).toBeGreaterThan(u.uSbBkFilter.value.y);
        // a crown seen from far enough loses its holes (each octave fades as the footprint reaches its period)
        setCrownShadingUniforms(resolveCrownShading({ breakup: { holes: [1, 1, 1, 1], pockets: [0, 0, 0, 0] } }));
        let near = 0, far = 0;
        for (let i = 0; i < 200; i++) { const p: [number, number, number] = [i * 0.37, 1.3 * i, 0.71 * i]; if (!breakupKeepAt(p, -0.1, 3, 0.01, 0.5, 4)) near++; if (!breakupKeepAt(p, -0.1, 3, 50, 0.5, 4)) far++; }
        expect(near).toBeGreaterThan(50); expect(far).toBe(0);
        setCrownShadingUniforms(DEFAULT_CROWN_SHADING);
    });
});

describe.skipIf(!chromeAvailable())('crown breakup in a WebGL viewport (trees grown by the native plant)', () => {
    let h: Harness;
    let work: string;
    beforeAll(async () => {
        fs.mkdirSync(SHOTS, { recursive: true });
        work = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tree-breakup-')));
        const svc = new TileVegetationService({ workspaceRoot: work, repoRoot: REPO });
        await svc.ensureBinary();
        const crown = (id: number, stem: [number, number], apexY: number, radius: number) => {
            const samples: number[][] = [];
            const n = Math.ceil(radius / 0.7);
            for (let i = -n; i <= n; i++) for (let k = -n; k <= n; k++) {
                const dx = i * 0.7, dz = k * 0.7, d = Math.hypot(dx, dz);
                if (d <= radius) samples.push([stem[0] + dx, apexY - 0.45 * apexY * (d / radius) ** 2, stem[1] + dz]);
            }
            return { id, status: 'tree', reachesBoundary: false, apex: [stem[0], apexY, stem[1]], stem, supportY: 0, supportSource: 'given', terrainY: 0, apexAboveSupport: apexY, areaM2: Math.PI * radius * radius, sectorRadii: new Array(16).fill(radius), samples };
        };
        fs.writeFileSync(path.join(work, 'crowns.json'), JSON.stringify({ version: 1, frame: { frame: 'x = east, y = up, z = south (metres)' }, params: { sampleSpacing: 0.7 }, crowns: [crown(0, [0, 0], 14, 5), crown(1, [13, 4], 12, 4.5), crown(2, [-12, 6], 16, 5.5)] }));
        const planted = await svc.plant({ crownsPath: 'crowns.json', triangleBudget: 30000, seed: 'b7ea' });
        const o = await openHarness({ glbFile: planted.treesGlb });
        h = o.h;
    }, 900_000);
    afterAll(() => { h?.close(); if (work) fs.rmSync(work, { recursive: true, force: true }); });

    it('decides in GLSL as the TypeScript mirror does', async () => {
        const configs = [
            { n: 96, origin: [3.1, 6.2, -4.4] as [number, number, number], span: 9, depthS: -0.1, slot: 3, footprintM: 0.02, dither: 0.31, crownRadiusM: 4.5 },
            { n: 96, origin: [-20.5, 2.0, 7.3] as [number, number, number], span: 14, depthS: 0.2, slot: 2, footprintM: 0.3, dither: 0.77, crownRadiusM: 3.0 },
            { n: 64, origin: [100.2, 12.0, -55.1] as [number, number, number], span: 6, depthS: 0.6, slot: 1, footprintM: 0.05, dither: 0.5, crownRadiusM: 6.0 }
        ];
        for (const cfg of configs) {
            const gpu = await h.eval<number[]>(`window.H.glslKeepGrid(${JSON.stringify(cfg)})`);
            let agree = 0, kept = 0;
            for (let j = 0; j < cfg.n; j++) for (let i = 0; i < cfg.n; i++) {
                const p: [number, number, number] = [cfg.origin[0] + ((i + 0.5) / cfg.n) * cfg.span, cfg.origin[1], cfg.origin[2] + ((j + 0.5) / cfg.n) * cfg.span];
                const k = breakupKeepAt(p, cfg.depthS, cfg.slot, cfg.footprintM, cfg.dither, cfg.crownRadiusM) ? 1 : 0;
                if (k === gpu[j * cfg.n + i]) agree++;
                kept += gpu[j * cfg.n + i];
            }
            const N = cfg.n * cfg.n;
            expect(agree / N).toBeGreaterThan(0.98);
            expect(kept).toBeGreaterThan(0.1 * N);
            if (cfg.depthS < 0) expect(kept).toBeLessThan(0.95 * N);              // on the rim some are dropped
        }
    }, 120_000);

    it('compiles every program, opens holes at the mid and far levels, and the shadow pass draws them', async () => {
        const view = { distM: 18, lift: 9, fov: 40 };
        const results: Record<string, { nonBackground: number; meanLuma: number }> = {};
        for (const level of [3, 2, 1, 0] as const) {
            for (const on of [false, true]) {
                const s = await h.eval<{ nonBackground: number; meanLuma: number }>(`window.H.breakupShot(${JSON.stringify({ level, ...view, breakup: on })})`);
                results[`l${level}_${on ? 'on' : 'off'}`] = { nonBackground: s.nonBackground, meanLuma: s.meanLuma };
                await h.screenshot(path.join(SHOTS, `webgl_level${level}_${on ? 'on' : 'off'}.png`));
            }
        }
        for (const level of [3, 2]) {
            const off = results[`l${level}_off`].nonBackground, on = results[`l${level}_on`].nonBackground;
            expect(on).toBeLessThan(off * 0.995);                                     // holes open
            expect(on).toBeGreaterThan(off * 0.6);                                    // but the crown stays a crown
        }
        // shadows: the same breakup with the breakup's depth material and with the renderer's plain one
        await h.eval(`window.H.setBreakup({ enabled: true })`);
        const sunView = { level: 3, distM: 26, lift: 20, fov: 50, breakup: true };
        await h.eval(`window.H.shadows(true, false)`);
        const plain = await h.eval<{ meanLuma: number; hash: number[] }>(`window.H.breakupShot(${JSON.stringify(sunView)})`);
        await h.screenshot(path.join(SHOTS, 'webgl_shadow_plain_depth.png'));
        await h.eval(`window.H.shadows(true, true)`);
        const dappled = await h.eval<{ meanLuma: number; hash: number[] }>(`window.H.breakupShot(${JSON.stringify(sunView)})`);
        await h.screenshot(path.join(SHOTS, 'webgl_shadow_dappled.png'));
        expect(dappled.meanLuma).toBeGreaterThan(plain.meanLuma + 0.05);            // light through the holes reaches the ground
        await h.eval(`window.H.shadows(false)`);
        expect(await h.eval<string[]>(`window.H.shaderErrors()`)).toEqual([]);
        fs.writeFileSync(path.join(REPO, 'test-results', 'tree-breakup-webgl.json'), JSON.stringify({ results, shadow: { plain: plain.meanLuma, dappled: dappled.meanLuma } }, null, 2));
    }, 300_000);
});
