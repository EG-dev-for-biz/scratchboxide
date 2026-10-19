/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Soft crown normals for the leaves of staged trees:
 * - the native crown fit (tree_lod::fitCrownEllipsoid, compiled with clang++) recovers a leaning, elongated, turned crown
 *   from points on its leaves, and ignores a few stray ones;
 * - the crown quadric a leaf mesh carries, in the mesh's own frame, has the ellipsoid's normal as its gradient;
 * - factors per level (defaults: normal blend 0 / 0.9 / 1.0, occlusion 0.6 / 0.45 / 0.35), adjustable, clamped;
 * - leaf meshes (clusters of levels 0 and 1, the level-2 foliage primitive) wear the crown variant; wood and twigs never;
 * - the dither variants of a leaf mesh carry the crown chunk (so a crossfade keeps it), the wood's do not;
 * - the leaf fragment stage keeps three's back-face flip where the level does not blend (near), drops it where it does;
 * - the crown and dither variants keep everything that defines a leaf's silhouette (maps, alpha test, transparency, side);
 * - off by toggle, and a material swapped behind the controller (clay pass) is dressed again.
 */

import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { TreeLodController } from '../src/browser/generative-canvas/primitives/scene3d/treeLod/TreeLodController';
import {
    CROWN_VERTEX_MAIN, crownLevelFactors, makeCrownVariant, crownQuadricInMeshFrame, crownShadingUniforms, isCrownVariant, resolveCrownShading, setCrownShadingUniforms, DEFAULT_CROWN_SHADING
} from '../src/browser/generative-canvas/primitives/scene3d/treeLod/treeCrownShading';
import { isFadeVariant, makeFadeVariant } from '../src/browser/generative-canvas/primitives/scene3d/treeLod/treeLodFade';
import { applyClayRenderMode, sharedTreeClayMaterial } from '../src/browser/generative-canvas/primitives/scene3d/clayRenderMode';
import { buildTreesLodGltf, writeTreesLodGlb } from './helpers/synthetic-trees-lod-glb';
import { validateTreesGlbJson, type TreeCrownExtras } from '../src/common/spatial/staged-location-contracts';

const REPO = fs.realpathSync(path.resolve(__dirname, '../../..'));
const INCLUDE = path.join(REPO, 'packages/core/src/native/3d-engine/include');

async function loadFixture(trees: number, crown = true): Promise<THREE.Object3D> {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sb-crown-')), 't.glb');
    writeTreesLodGlb(file, buildTreesLodGltf({ trees, crown }));
    const buf = fs.readFileSync(file);
    const gltf = await new GLTFLoader().parseAsync(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer, '');
    fs.rmSync(path.dirname(file), { recursive: true, force: true });
    return gltf.scene;
}

const treeNodes = (root: THREE.Object3D): THREE.Object3D[] => { const out: THREE.Object3D[] = []; root.traverse(o => { if (o.userData?.sbTree) out.push(o); }); return out; };
const lodMeshes = (root: THREE.Object3D): THREE.Mesh[] => { const out: THREE.Mesh[] = []; root.traverse(o => { const m = o as THREE.Mesh; if (m.isMesh && m.userData.sbTreeLodMesh) out.push(m); }); return out; };
const levelOf = (m: THREE.Object3D): number => { for (let o: THREE.Object3D | null = m; o; o = o.parent) if (o.userData?.sbLod) return o.userData.sbLod.level; return -1; };

function cameraAt(tree: THREE.Object3D, d: number): THREE.PerspectiveCamera {
    tree.updateMatrixWorld(true);
    const s = new THREE.Box3().setFromObject(tree).getBoundingSphere(new THREE.Sphere());
    const cam = new THREE.PerspectiveCamera(60, 1, 0.1, 6000);
    cam.position.copy(s.center).add(new THREE.Vector3(0, 0, s.radius + d));
    cam.lookAt(s.center); cam.updateMatrixWorld(true);
    return cam;
}
const clock = (): { now: () => number; tick: (ms?: number) => void } => { let t = 1000; return { now: () => t, tick: (ms = 16.7) => { t += ms; } }; };

/** Runs a material's onBeforeCompile on the standard shader source, as the renderer would. */
function compiled(mat: THREE.Material): { vertexShader: string; fragmentShader: string } {
    const lib = THREE.ShaderLib.standard;
    const shader = { uniforms: THREE.UniformsUtils.clone(lib.uniforms), vertexShader: lib.vertexShader, fragmentShader: lib.fragmentShader } as any;
    mat.onBeforeCompile(shader, {} as THREE.WebGLRenderer);
    return shader;
}

describe('native crown fit (tree_lod::fitCrownEllipsoid)', () => {
    it('recovers a leaning, elongated, turned crown from points on its leaves and ignores stray ones', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-crownfit-'));
        try {
            const src = path.join(dir, 'fit.cpp');
            fs.writeFileSync(src, `#include "scratchbox_tree_lod.hpp"
#include <cstdio>
#include <iostream>
using namespace scratchbox;
int main() {
    size_t n; std::cin >> n;
    std::vector<math::Vec3> p(n);
    for (auto& v : p) { float x, y, z; std::cin >> x >> y >> z; v = math::Vec3(x, y, z); }
    const auto e = tree_lod::fitCrownEllipsoid(p);
    std::printf("{\\"c\\":[%.6f,%.6f,%.6f],\\"r\\":[%.6f,%.6f,%.6f],\\"yaw\\":%.6f,\\"n\\":%zu}\\n", e.centre.x, e.centre.y, e.centre.z, e.radii[0], e.radii[1], e.radii[2], e.yawRad, e.points);
}
`);
            const bin = path.join(dir, 'fit');
            const cc = spawnSync(process.env.CXX || 'clang++', ['-std=c++20', '-O1', '-I', INCLUDE, src, '-o', bin], { encoding: 'utf8' });
            expect(cc.status, cc.stderr).toBe(0);
            // points on an ellipsoid surface and inside it: centre leans 0.9 m east and 0.4 m south of a stem at the origin
            const centre = [0.9, 9, 0.4], radii = [4.2, 2.6, 2.4], yaw = 0.6;
            let seed = 7;
            const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
            const pts: number[][] = [];
            for (let i = 0; i < 4000; i++) {
                const u = 2 * rnd() - 1, th = 2 * Math.PI * rnd(), s = Math.sqrt(1 - u * u), shell = 0.85 + 0.15 * Math.cbrt(rnd());
                const a = radii[0] * s * Math.cos(th) * shell, b = radii[1] * u * shell, c = radii[2] * s * Math.sin(th) * shell;
                pts.push([centre[0] + a * Math.cos(yaw) - c * Math.sin(yaw), centre[1] + b, centre[2] + a * Math.sin(yaw) + c * Math.cos(yaw)]);
            }
            for (let i = 0; i < 30; i++) pts.push([centre[0] + 25 + i, centre[1] + 12, centre[2] - 20]);   // stray points far off the crown
            const run = spawnSync(bin, [], { input: `${pts.length}\n${pts.map(p => p.join(' ')).join('\n')}\n`, encoding: 'utf8' });
            expect(run.status, run.stderr).toBe(0);
            const fit = JSON.parse(run.stdout);
            expect(fit.n).toBe(pts.length);
            for (let k = 0; k < 3; k++) expect(Math.abs(fit.c[k] - centre[k])).toBeLessThan(0.25);
            expect(Math.abs(fit.r[0] - radii[0]) / radii[0]).toBeLessThan(0.08);
            expect(Math.abs(fit.r[1] - radii[1]) / radii[1]).toBeLessThan(0.08);
            expect(Math.abs(fit.r[2] - radii[2]) / radii[2]).toBeLessThan(0.08);
            const dy = Math.abs(((fit.yaw - yaw) % Math.PI + 1.5 * Math.PI) % Math.PI - 0.5 * Math.PI);
            expect(dy).toBeLessThan(0.05);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    }, 120_000);
});

describe('crown quadric and blend factors', () => {
    it('gives, in a mesh\'s own frame, a gradient along the ellipsoid normal', () => {
        const crown: TreeCrownExtras = { centre: [3, 9, -2], radii: [4, 2.5, 3], yawRad: 0.7, leanM: [0, 0], points: 1, fittedTo: 'test' };
        // a quantised level frame: translation and a uniform scale, under a tree node that is turned
        const meshToTree = new THREE.Matrix4().compose(new THREE.Vector3(2, 7, -1), new THREE.Quaternion().setFromEuler(new THREE.Euler(0, 0.4, 0)), new THREE.Vector3(5, 5, 5));
        const q = crownQuadricInMeshFrame(crown, meshToTree, 1);
        expect(q.c[3]).toBe(1);
        const S = new THREE.Matrix3().set(q.s0[0], q.s1[0], q.s1[1], q.s1[0], q.s0[1], q.s1[2], q.s1[1], q.s1[2], q.s0[2]);
        const normalMat = new THREE.Matrix3().getNormalMatrix(meshToTree);     // mesh frame -> tree frame, for normals
        for (const dir of [[1, 0, 0], [0, 1, 0], [0.3, -0.5, 0.8], [-0.7, 0.2, -0.4]]) {
            // a point on the ellipsoid, in the tree frame, and its true normal
            const cy = Math.cos(crown.yawRad), sy = Math.sin(crown.yawRad);
            const d = new THREE.Vector3(...dir).normalize();
            const local = new THREE.Vector3(d.x * crown.radii[0], d.y * crown.radii[1], d.z * crown.radii[2]);
            const pTree = new THREE.Vector3(crown.centre[0] + local.x * cy - local.z * sy, crown.centre[1] + local.y, crown.centre[2] + local.x * sy + local.z * cy);
            const nLocal = new THREE.Vector3(local.x / crown.radii[0] ** 2, local.y / crown.radii[1] ** 2, local.z / crown.radii[2] ** 2);
            const nTree = new THREE.Vector3(nLocal.x * cy - nLocal.z * sy, nLocal.y, nLocal.x * sy + nLocal.z * cy).normalize();
            // the shader's way: gradient S (x - c) in the mesh frame, carried by the normal matrix
            const pMesh = pTree.clone().applyMatrix4(meshToTree.clone().invert());
            const g = pMesh.clone().sub(new THREE.Vector3(q.c[0], q.c[1], q.c[2])).applyMatrix3(S);
            // the quadric's value is 1 on the ellipsoid (the occlusion reads it as the depth inside the crown)
            const dMesh = pMesh.clone().sub(new THREE.Vector3(q.c[0], q.c[1], q.c[2]));
            expect(dMesh.dot(dMesh.clone().applyMatrix3(S))).toBeCloseTo(1, 4);
            const back = g.applyMatrix3(normalMat).normalize();
            expect(back.dot(nTree)).toBeGreaterThan(0.9999);
        }
    });

    it('keeps the near leaves\' own normals (blend 0, occlusion only), blends 0.9 mid and 1.0 far, and the factors are adjustable and clamped', () => {
        expect(DEFAULT_CROWN_SHADING.blend).toEqual([0, 0.9, 1.0]);
        expect(DEFAULT_CROWN_SHADING.occlusion).toEqual([0.6, 0.45, 0.35]);
        setCrownShadingUniforms(resolveCrownShading(undefined));
        expect([0, 1, 2].map(l => crownLevelFactors(l).blend)).toEqual([0, 0.9, 1.0].map(x => Math.fround(x) === x ? x : expect.closeTo(x, 6)));
        expect([0, 1, 2].map(l => crownLevelFactors(l).occlusion)).toEqual([0.6, 0.45, 0.35].map(x => expect.closeTo(x, 6)));
        expect(crownLevelFactors(0).noise).toBe(0);
        expect(crownLevelFactors(2).noise).toBe(0);
        setCrownShadingUniforms(resolveCrownShading({ blend: [0.5, 1.4, -2], skyBias: 0.3 }));
        expect([0, 1, 2].map(l => crownLevelFactors(l).blend)).toEqual([0.5, 1, 0]);
        expect(crownShadingUniforms().uSbCrownSky.value).toBeCloseTo(0.3);
        expect(resolveCrownShading({ blend: [1, 2] as any }).blend).toEqual([0, 0.9, 1.0]);   // malformed: the default
        setCrownShadingUniforms(resolveCrownShading({ occlusion: [2, -1, 0.5] }));
        expect([0, 1, 2].map(l => crownLevelFactors(l).occlusion)).toEqual([1, 0, 0.5]);
        setCrownShadingUniforms(resolveCrownShading(undefined));
    });
});

describe('TreeLodController with crown shading', () => {
    it('passes the contract with the crown and the level-2 foliage index', () => {
        expect(validateTreesGlbJson(buildTreesLodGltf({ trees: 2, crown: true }).json)).toEqual([]);
        const bad = buildTreesLodGltf({ trees: 1, crown: true }).json;
        bad.nodes.find((n: any) => n.extras?.sbTree).extras.sbTree.crown.radii = [1, 0, 1];
        expect(validateTreesGlbJson(bad).join('\n')).toMatch(/crown/);
    });

    it('dresses leaf meshes with the crown variant and leaves wood untouched', async () => {
        const root = await loadFixture(2);
        const lod = new TreeLodController(root, { now: clock().now });
        expect(lod.stats.crownTrees).toBe(2);
        lod.forceLevel(0); lod.update(cameraAt(treeNodes(root)[0], 20));
        lod.forceLevel(1); lod.update(cameraAt(treeNodes(root)[0], 20));
        lod.forceLevel(2); lod.update(cameraAt(treeNodes(root)[0], 20));
        const meshes = lodMeshes(root);
        const leaves = meshes.filter(m => m.userData.sbCrownLeaf), wood = meshes.filter(m => !m.userData.sbCrownLeaf);
        // per tree: 2 clusters at level 0, 2 at level 1, the level-2 foliage primitive
        expect(leaves).toHaveLength(2 * 5);
        expect(leaves.filter(m => (m as THREE.InstancedMesh).isInstancedMesh)).toHaveLength(8);
        expect(leaves.filter(m => levelOf(m) === 2)).toHaveLength(2);
        expect(wood.length).toBeGreaterThanOrEqual(2 * 3);
        for (const m of leaves) {
            expect(m.geometry.getAttribute('sbCrownC')).toBeTruthy();
            expect((m.geometry.getAttribute('sbCrownC') as THREE.InstancedBufferAttribute).isInstancedBufferAttribute).toBe(true);
            expect(m.geometry.getAttribute('sbCrownC').getW(0)).toBe(levelOf(m));
        }
        // the cluster geometry stays shared: the per-mesh geometries reuse its buffers
        const l0 = leaves.filter(m => levelOf(m) === 0);
        expect(l0[0].geometry).not.toBe(l0[1].geometry);
        expect(l0[0].geometry.getAttribute('position')).toBe(l0[1].geometry.getAttribute('position'));
        // levels shown in full: leaves wear the crown variant of their base, wood its base
        lod.forceLevel(0); lod.update(cameraAt(treeNodes(root)[0], 20));
        for (const m of meshes.filter(x => levelOf(x) === 0)) {
            if (m.userData.sbCrownLeaf) { expect(isCrownVariant(m.material as THREE.Material)).toBe(true); expect(compiled(m.material as THREE.Material).vertexShader).toContain(CROWN_VERTEX_MAIN); }
            else { expect(m.material).toBe(m.userData.sbLodBase); expect(m.geometry.getAttribute('sbCrownC')).toBeUndefined(); }
        }
    });

    it('keeps the crown chunk in the dither variants of a crossfade (leaves only), with the back-face flip only where the level does not blend', async () => {
        const root = await loadFixture(1);
        const c = clock();
        const lod = new TreeLodController(root, { now: c.now });
        const tree = treeNodes(root)[0];
        for (let i = 0; i < 80; i++) { c.tick(); lod.update(cameraAt(tree, 55)); }          // inside the 0|1 overlap
        const fading = lodMeshes(root).filter(m => isFadeVariant(m.material as THREE.Material));
        const leaf = fading.filter(m => m.userData.sbCrownLeaf), wood = fading.filter(m => !m.userData.sbCrownLeaf);
        expect(leaf.length).toBeGreaterThan(0); expect(wood.length).toBeGreaterThan(0);
        for (const m of leaf) {
            const s = compiled(m.material as THREE.Material);
            expect(s.vertexShader).toContain(CROWN_VERTEX_MAIN);
            expect(s.vertexShader).toContain('uSbRange');                                    // the dither is still there
            // the flip is kept for a level that does not blend (vSbCrownFlip = 1, the near level) and dropped where it blends
            expect(s.fragmentShader).toContain('float faceDirection = vSbCrownFlip > 0.5 ? ( gl_FrontFacing ? 1.0 : - 1.0 ) : 1.0;');
            expect(s.fragmentShader).toContain('diffuseColor.rgb *= vSbCrownOcc;');
            expect((m.material as THREE.Material).customProgramCacheKey()).toMatch(/sbcrown.*sbfade/);
        }
        for (const m of wood) {
            const s = compiled(m.material as THREE.Material);
            expect(s.vertexShader).not.toContain('sbCrownC');
            expect(s.fragmentShader).toContain('#include <normal_fragment_begin>');      // three's own chunk, with its flip
        }
        // the vertex stage turns a card's own normal to the crown's side before blending, so its back side is lit like its front,
        // and only where the level blends: with blend 0 the normal varying is left as the plain material writes it
        expect(CROWN_VERTEX_MAIN).toMatch(/if \( sbW > 0\.0 \) \{[\s\S]*if \( dot\( sbOwn, sbC \) < 0\.0 \) sbOwn = - sbOwn;[\s\S]*vSbCrownFlip = 0\.0;/);
    });

    it('turns off for comparison and back on, and dresses again a mesh the clay pass swapped', async () => {
        const root = await loadFixture(1);
        const c = clock();
        const lod = new TreeLodController(root, { now: c.now });
        const tree = treeNodes(root)[0];
        lod.forceLevel(0);
        lod.update(cameraAt(tree, 20));
        const leaves = lodMeshes(root).filter(m => m.userData.sbCrownLeaf && levelOf(m) === 0);
        expect(leaves.every(m => isCrownVariant(m.material as THREE.Material))).toBe(true);
        lod.setCrownShading({ enabled: false }); c.tick(); lod.update(cameraAt(tree, 20));
        expect(leaves.every(m => m.material === m.userData.sbLodBase)).toBe(true);
        lod.setCrownShading({ enabled: true }); c.tick(); lod.update(cameraAt(tree, 20));
        expect(leaves.every(m => isCrownVariant(m.material as THREE.Material))).toBe(true);
        // clay: the shared grey is the base, the leaves wear its crown variant (same colour), the wood the grey itself
        applyClayRenderMode([root], true);
        expect(leaves.every(m => m.material === sharedTreeClayMaterial())).toBe(true);
        c.tick(); lod.update(cameraAt(tree, 20));
        const shared = sharedTreeClayMaterial();
        for (const m of leaves) {
            const mat = m.material as THREE.MeshStandardMaterial;
            expect(isCrownVariant(mat)).toBe(true);
            expect(mat.color.getHex()).toBe(shared.color.getHex()); expect(mat.roughness).toBe(shared.roughness);
        }
        const woodL0 = lodMeshes(root).filter(m => !m.userData.sbCrownLeaf && levelOf(m) === 0);
        expect(woodL0.every(m => m.material === shared)).toBe(true);
        applyClayRenderMode([root], false);
        lod.dispose();
        expect(lodMeshes(root)).toHaveLength(0);
    });

    it('keeps every property that defines a leaf\'s silhouette in the crown variant and in its dither variants', async () => {
        const tex = (v: number) => { const t = new THREE.DataTexture(new Uint8Array([v, v, v, 255]), 1, 1); t.needsUpdate = true; return t; };
        const leafMat = new THREE.MeshStandardMaterial({ color: 0x6a8f4e, map: tex(200), alphaMap: tex(128), alphaTest: 0.5, transparent: true, opacity: 0.9, side: THREE.DoubleSide, roughness: 0.7 });
        const props = (m: THREE.Material) => { const x = m as THREE.MeshStandardMaterial; return { map: x.map, alphaMap: x.alphaMap, alphaTest: x.alphaTest, transparent: x.transparent, opacity: x.opacity, side: x.side, alphaToCoverage: x.alphaToCoverage, color: x.color.getHex(), roughness: x.roughness }; };
        const crown = makeCrownVariant(leafMat);
        expect(props(crown)).toEqual(props(leafMat));
        for (const instanced of [true, false]) expect(props(makeFadeVariant(crown, 4, 12, instanced))).toEqual(props(leafMat));
        // the compiled leaf shader still tests alpha and samples both maps (the define-driven chunks stay in place)
        const sh = compiled(crown);
        for (const chunk of ['#include <alphamap_fragment>', '#include <alphatest_fragment>', '#include <map_fragment>']) expect(sh.fragmentShader).toContain(chunk);
        // through the controller: leaf meshes whose loader material has a cutout wear crown and dither variants that keep it
        const root = await loadFixture(1);
        root.traverse(o => { const m = o as THREE.Mesh; if ((m as THREE.InstancedMesh).isInstancedMesh) m.material = leafMat; });
        const c = clock();
        const lod = new TreeLodController(root, { now: c.now });
        const tree = treeNodes(root)[0];
        lod.forceLevel(0); lod.update(cameraAt(tree, 20));
        lod.forceLevel(null);
        for (let i = 0; i < 80; i++) { c.tick(); lod.update(cameraAt(tree, 55)); }
        const leaves = lodMeshes(root).filter(m => m.userData.sbCrownLeaf && (m as THREE.InstancedMesh).isInstancedMesh);
        expect(leaves.length).toBeGreaterThan(0);
        expect(leaves.some(m => isFadeVariant(m.material as THREE.Material))).toBe(true);
        for (const m of leaves) {
            expect(isCrownVariant(m.material as THREE.Material) || isFadeVariant(m.material as THREE.Material)).toBe(true);
            expect(props(m.material as THREE.Material)).toEqual(props(leafMat));
        }
    });

    it('leaves a trees file without crowns as it was', async () => {
        const root = await loadFixture(1, false);
        const lod = new TreeLodController(root, { now: clock().now });
        lod.update(cameraAt(treeNodes(root)[0], 20));
        expect(lod.stats.crownTrees).toBe(0);
        expect(lodMeshes(root).some(m => isCrownVariant(m.material as THREE.Material) || m.geometry.getAttribute('sbCrownC'))).toBe(false);
    });
});
