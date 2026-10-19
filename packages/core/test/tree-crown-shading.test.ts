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
    BREAKUP_FRAGMENT_DISCARD, CROWN_FIELD_VERTEX_PARS, CROWN_FRAGMENT_COLOR, CROWN_VERTEX_MAIN, crownLevelFactors, makeCrownVariant, crownLobesInMeshFrame, crownLobeField, crownLobesAt, crownQuadricInMeshFrame, crownShadingUniforms, isCrownVariant, resolveCrownShading, setCrownShadingUniforms, DEFAULT_CROWN_SHADING
} from '../src/browser/generative-canvas/primitives/scene3d/treeLod/treeCrownShading';
import { isFadeVariant, makeFadeVariant } from '../src/browser/generative-canvas/primitives/scene3d/treeLod/treeLodFade';
import { applyClayRenderMode, sharedTreeClayMaterial } from '../src/browser/generative-canvas/primitives/scene3d/clayRenderMode';
import { buildTreesLodGltf, writeTreesLodGlb } from './helpers/synthetic-trees-lod-glb';
import { validateTreesGlbJson, type TreeCrownExtras } from '../src/common/spatial/staged-location-contracts';

const REPO = fs.realpathSync(path.resolve(__dirname, '../../..'));
const INCLUDE = path.join(REPO, 'packages/core/src/native/3d-engine/include');

async function loadFixture(trees: number, crown = true, extra: { lobes?: boolean; levels?: 3 | 4 } = {}): Promise<THREE.Object3D> {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sb-crown-')), 't.glb');
    writeTreesLodGlb(file, buildTreesLodGltf({ trees, crown, ...extra }));
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

describe('native crown lobes (tree_lod::fitCrownLobes)', () => {
    it('recovers the lobes of synthetic leaf clusters: their number from the crown\'s size, centres, covering radii and the blend radius', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-lobefit-'));
        try {
            const src = path.join(dir, 'lobes.cpp');
            fs.writeFileSync(src, `#include "scratchbox_tree_lod.hpp"
#include <cstdio>
#include <iostream>
using namespace scratchbox;
int main() {
    int maxLobes; double target, cover, blend; size_t n; std::cin >> maxLobes >> target >> cover >> blend >> n;
    std::vector<tree_lod::LobeSeed> seeds(n);
    for (auto& s : seeds) {
        size_t m; float x, y, z; std::cin >> x >> y >> z >> m; s.centre = math::Vec3(x, y, z);
        s.points.resize(m);
        for (auto& p : s.points) { std::cin >> x >> y >> z; p = math::Vec3(x, y, z); }
    }
    const auto L = tree_lod::fitCrownLobes(seeds, maxLobes, target, cover, blend);
    std::printf("{\\"blend\\":%.6f,\\"lobes\\":[", L.blendM);
    for (size_t i = 0; i < L.lobes.size(); ++i) std::printf("%s[%.6f,%.6f,%.6f,%.6f]", i ? "," : "", L.lobes[i][0], L.lobes[i][1], L.lobes[i][2], L.lobes[i][3]);
    std::printf("]}\\n");
}
`);
            const bin = path.join(dir, 'lobes');
            const cc = spawnSync(process.env.CXX || 'clang++', ['-std=c++20', '-O1', '-I', INCLUDE, src, '-o', bin], { encoding: 'utf8' });
            expect(cc.status, cc.stderr).toBe(0);
            let seed = 11;
            const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
            // clusters (0.35 m hull) scattered through three lobes of a crown: 2.6, 2.0 and 1.6 m spheres
            const truth = [[-3.2, 9, 0.5, 2.6], [2.4, 10, -1.0, 2.0], [0.2, 12.6, 1.4, 1.6]];
            const cluster = (c: number[]) => {
                const u = 2 * rnd() - 1, th = 2 * Math.PI * rnd(), rr = (c[3] - 0.35) * Math.cbrt(rnd()), sq = Math.sqrt(1 - u * u);
                const ctr = [c[0] + rr * sq * Math.cos(th), c[1] + rr * u, c[2] + rr * sq * Math.sin(th)];
                const pts = Array.from({ length: 6 }, (_, k) => { const a = (k / 6) * 2 * Math.PI; return [ctr[0] + 0.35 * Math.cos(a), ctr[1] + 0.35 * Math.sin(a) * (k % 2 ? 1 : -1), ctr[2] + 0.35 * Math.sin(a)]; });
                return { ctr, pts };
            };
            const run = (seeds: Array<{ ctr: number[]; pts: number[][] }>, maxLobes: number, target: number) => {
                const input = `${maxLobes} ${target} 0.9 0.5 ${seeds.length}\n` + seeds.map(s => `${s.ctr.join(' ')} ${s.pts.length} ${s.pts.map(p => p.join(' ')).join(' ')}`).join('\n') + '\n';
                const r = spawnSync(bin, [], { input, encoding: 'utf8' });
                expect(r.status, r.stderr).toBe(0);
                return JSON.parse(r.stdout) as { blend: number; lobes: number[][] };
            };
            const seeds = truth.flatMap(c => Array.from({ length: Math.round(40 * (c[3] / 2) ** 3) }, () => cluster(c)));
            // the crown's ellipsoid holds about three lobes of 2.1 m (the count follows its volume: 7 of 1.6 m, 1 of 3 m)
            const fit = run(seeds, 8, 2.1);
            expect(fit.lobes).toHaveLength(3);
            for (const t of truth) {
                const best = fit.lobes.reduce((a, l) => (Math.hypot(l[0] - t[0], l[1] - t[1], l[2] - t[2]) < Math.hypot(a[0] - t[0], a[1] - t[1], a[2] - t[2]) ? l : a));
                expect(Math.hypot(best[0] - t[0], best[1] - t[1], best[2] - t[2])).toBeLessThan(0.6);
                expect(best[3]).toBeGreaterThan(0.75 * t[3]); expect(best[3]).toBeLessThan(1.25 * t[3]);
            }
            const mean = fit.lobes.reduce((a, l) => a + l[3], 0) / fit.lobes.length;
            expect(fit.blend).toBeCloseTo(0.5 * mean, 5);
            // the smooth union covers the clusters: every cluster centre lies inside the field (f < 0)
            for (const sd of seeds) expect(crownLobeField(fit.lobes as any, fit.blend, sd.ctr as [number, number, number]).f).toBeLessThan(0);
            // fewer allowed lobes, or a larger target lobe, give fewer lobes; one compact blob gives one
            expect(run(seeds, 2, 2.1).lobes).toHaveLength(2);
            expect(run(seeds, 8, 1.6).lobes.length).toBeGreaterThan(3);
            expect(run(seeds, 8, 6).lobes).toHaveLength(1);
            expect(run(Array.from({ length: 30 }, () => cluster([0, 5, 0, 1.2])), 8, 2.5).lobes).toHaveLength(1);
            // deterministic
            expect(run(seeds, 8, 2.1)).toEqual(fit);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    }, 120_000);
});

describe('crown lobes in a mesh frame and in the shader', () => {
    const crown: TreeCrownExtras = { centre: [0, 6, 0], radii: [3, 2, 3], yawRad: 0, leanM: [0, 0], points: 1, fittedTo: 'test', lobes: [[-1, 6, 0, 1.5], [1.2, 6.4, 0.3, 1.2], [0, 7.2, -0.4, 1.0]], lobeBlendM: 0.6 };

    it('has the smooth-min gradient the shader evaluates, and keeps it under a similarity frame', () => {
        const lobes = crown.lobes!;
        const h = 1e-4;
        for (const p of [[2.5, 6, 0.2], [-0.4, 8.5, 1], [0.3, 4.1, -2]] as Array<[number, number, number]>) {
            const { gradient } = crownLobeField(lobes, 0.6, p);
            const num = [0, 1, 2].map(k => { const a = [...p] as [number, number, number], b = [...p] as [number, number, number]; a[k] += h; b[k] -= h; return (crownLobeField(lobes, 0.6, a).f - crownLobeField(lobes, 0.6, b).f) / (2 * h); });
            for (let k = 0; k < 3; k++) expect(gradient[k]).toBeCloseTo(num[k], 4);
        }
        // a quantised level frame (translation, rotation, one scale): lobes map in, and the field's normal maps back out
        const meshToTree = new THREE.Matrix4().compose(new THREE.Vector3(2, 7, -1), new THREE.Quaternion().setFromEuler(new THREE.Euler(0, 0.4, 0)), new THREE.Vector3(5, 5, 5));
        const local = crownLobesInMeshFrame(crown, meshToTree)!;
        expect(local.lobes).toHaveLength(3);
        expect(local.blend).toBeCloseTo(0.6 / 5, 9);
        const pTree = new THREE.Vector3(2.5, 6, 0.2);
        const pMesh = pTree.clone().applyMatrix4(meshToTree.clone().invert());
        const gMesh = new THREE.Vector3(...crownLobeField(local.lobes, local.blend, [pMesh.x, pMesh.y, pMesh.z]).gradient);
        const back = gMesh.applyMatrix3(new THREE.Matrix3().getNormalMatrix(meshToTree)).normalize();
        const truth = new THREE.Vector3(...crownLobeField(crown.lobes!, 0.6, [pTree.x, pTree.y, pTree.z]).gradient).normalize();
        expect(back.dot(truth)).toBeGreaterThan(0.99999);
        // spheres are not spheres under an unequal scale: that mesh keeps the ellipsoid
        expect(crownLobesInMeshFrame(crown, new THREE.Matrix4().makeScale(1, 2, 1))).toBeNull();
        expect(crownLobesInMeshFrame({ ...crown, lobes: undefined }, meshToTree)).toBeNull();
    });

    it('writes each leaf mesh\'s lobes into the shared atlas in its own frame and points the shader at them', async () => {
        const root = await loadFixture(2, true, { lobes: true });
        const lod = new TreeLodController(root, { now: clock().now });
        expect(lod.stats.crownLobeTrees).toBe(2);
        expect(lod.stats.crownLobeMeshes).toBe(2 * 7);
        expect(lod.stats.crownLobeFallbackMeshes).toBe(0);
        const tree = treeNodes(root)[0];
        tree.updateMatrixWorld(true);
        const leaves = lodMeshes(root).filter(m => m.userData.sbCrownLeaf);
        for (const m of leaves.filter(x => tree.getObjectById(x.id))) {
            const L = m.geometry.getAttribute('sbCrownL');
            expect(L.getY(0)).toBe(3);
            const atlas = crownLobesAt(L.getX(0), 3);
            const meshToTree = tree.matrixWorld.clone().invert().multiply(m.matrixWorld);
            const expected = crownLobesInMeshFrame(crown, meshToTree)!;
            atlas.forEach((l, i) => l.forEach((v, k) => expect(v).toBeCloseTo(expected.lobes[i][k], 4)));
            expect(L.getZ(0)).toBeCloseTo(expected.blend, 6);
            // instanced leaf clusters carry the field at each instance's origin (gradient, depth), so the shader loops over no lobes
            if ((m as THREE.InstancedMesh).isInstancedMesh) {
                const im = m as THREE.InstancedMesh, I = m.geometry.getAttribute('sbCrownI') as THREE.InstancedBufferAttribute;
                expect(I.count).toBe(im.count);
                for (let i = 0; i < im.count; i++) {
                    const e = im.instanceMatrix.array;
                    const fld = crownLobeField(expected.lobes, expected.blend, [e[16 * i + 12], e[16 * i + 13], e[16 * i + 14]]);
                    expect(I.getX(i)).toBeCloseTo(fld.gradient[0], 5); expect(I.getY(i)).toBeCloseTo(fld.gradient[1], 5); expect(I.getZ(i)).toBeCloseTo(fld.gradient[2], 5);
                    expect(I.getW(i)).toBeCloseTo(-fld.f / expected.meanRadius, 5);      // signed: the occlusion clamps it, the breakup extends it
                }
            }
        }
        expect(CROWN_FIELD_VERTEX_PARS).toMatch(/#ifdef USE_INSTANCING\s+\/\/[^\n]*\n\s+sbG = sbCrownI\.xyz;/);
        lod.forceLevel(3); lod.update(cameraAt(tree, 20));
        const far = leaves.find(m => levelOf(m) === 3)!;
        const sh = compiled(far.material as THREE.Material);
        expect(sh.vertexShader).toContain('texelFetch( uSbCrownLobes');
        expect(sh.uniforms.uSbCrownLobes.value).toBe(crownShadingUniforms().uSbCrownLobes.value);
        lod.dispose();
        // without lobes in the file every leaf mesh keeps the ellipsoid (lobe count 0)
        const plain = await loadFixture(1);
        const lod2 = new TreeLodController(plain, { now: clock().now });
        expect(lod2.stats.crownLobeTrees).toBe(0);
        expect(lodMeshes(plain).filter(m => m.userData.sbCrownLeaf).every(m => m.geometry.getAttribute('sbCrownL').getY(0) === 0)).toBe(true);
        lod2.dispose();
    });

    it('shades every level\'s leaves by its detail slot in the dither variants too (four-level and old three-level files)', async () => {
        for (const levels of [4, 3] as const) {
            const root = await loadFixture(1, true, { lobes: true, levels });
            const c = clock();
            const lod = new TreeLodController(root, { now: c.now });
            const tree = treeNodes(root)[0];
            const seen = new Set<number>();
            // dolly from close to far: every handover dithers, and every dithering leaf mesh carries the crown chunk
            for (let d = 20; d <= 600; d += 4) {
                c.tick(); lod.update(cameraAt(tree, d));
                for (const m of lodMeshes(root)) {
                    if (!m.userData.sbCrownLeaf || !isFadeVariant(m.material as THREE.Material)) continue;
                    const sh = compiled(m.material as THREE.Material);
                    expect(sh.vertexShader).toContain(CROWN_VERTEX_MAIN);
                    expect(sh.vertexShader + sh.fragmentShader).toContain('uSbRange');
                    seen.add(levelOf(m));
                }
            }
            expect([...seen].sort()).toEqual(levels === 4 ? [0, 1, 2, 3] : [0, 1, 2]);
            lod.dispose();
        }
    });
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

    it('keeps the near leaves\' own normals (blend 0, occlusion only), blends more at each coarser slot, and the factors are adjustable and clamped', () => {
        const near = (x: number) => (Math.fround(x) === x ? x : expect.closeTo(x, 6));
        expect(DEFAULT_CROWN_SHADING.blend).toEqual([0, 0.45, 0.9, 0.75]);
        expect(DEFAULT_CROWN_SHADING.occlusion).toEqual([0.6, 0.55, 0.45, 0.4]);
        setCrownShadingUniforms(resolveCrownShading(undefined));
        expect([0, 1, 2, 3].map(l => crownLevelFactors(l).blend)).toEqual([0, 0.45, 0.9, 0.75].map(near));
        expect([0, 1, 2, 3].map(l => crownLevelFactors(l).occlusion)).toEqual([0.6, 0.55, 0.45, 0.4].map(near));
        // the near-mid slot sits between near and mid
        expect(crownLevelFactors(1).blend).toBeGreaterThan(crownLevelFactors(0).blend);
        expect(crownLevelFactors(1).blend).toBeLessThan(crownLevelFactors(2).blend);
        expect(crownLevelFactors(0).noise).toBe(0);
        setCrownShadingUniforms(resolveCrownShading({ blend: [0.5, 1.4, -2, 0.3], skyBias: 0.3 }));
        expect([0, 1, 2, 3].map(l => crownLevelFactors(l).blend)).toEqual([0.5, 1, 0, near(0.3)]);
        expect(crownShadingUniforms().uSbCrownSky.value).toBeCloseTo(0.3);
        // three values are the old order (near, mid, far): near-mid is halfway between near and mid
        expect(resolveCrownShading({ blend: [0.2, 0.8, 1] }).blend).toEqual([0.2, 0.5, 0.8, 1]);
        expect(resolveCrownShading({ blend: [1, 2] }).blend).toEqual([0, 0.45, 0.9, 0.75]);   // malformed: the default
        setCrownShadingUniforms(resolveCrownShading({ occlusion: [2, -1, 0.5, 0.25] }));
        expect([0, 1, 2, 3].map(l => crownLevelFactors(l).occlusion)).toEqual([1, 0, 0.5, 0.25]);
        setCrownShadingUniforms(resolveCrownShading({ lobes: false }));
        expect(crownShadingUniforms().uSbCrownUseLobes.value).toBe(0);
        setCrownShadingUniforms(resolveCrownShading(undefined));
        expect(crownShadingUniforms().uSbCrownUseLobes.value).toBe(1);
    });
});

describe('TreeLodController with crown shading', () => {
    it('passes the contract with the crown and the far level\'s foliage index', () => {
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
        lod.forceLevel(3); lod.update(cameraAt(treeNodes(root)[0], 20));
        const meshes = lodMeshes(root);
        const leaves = meshes.filter(m => m.userData.sbCrownLeaf), wood = meshes.filter(m => !m.userData.sbCrownLeaf);
        // per tree: 2 clusters at each of levels 0, 1 and 2, the far level's foliage primitive
        expect(leaves).toHaveLength(2 * 7);
        expect(leaves.filter(m => (m as THREE.InstancedMesh).isInstancedMesh)).toHaveLength(12);
        expect(leaves.filter(m => levelOf(m) === 3)).toHaveLength(2);
        expect(wood.length).toBeGreaterThanOrEqual(2 * 4);
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
            expect(s.fragmentShader).toContain(CROWN_FRAGMENT_COLOR);
            expect(s.fragmentShader).toContain(BREAKUP_FRAGMENT_DISCARD);
            expect((m.material as THREE.Material).customProgramCacheKey()).toMatch(/sbcrown.*sbfade/);
        }
        for (const m of wood) {
            const s = compiled(m.material as THREE.Material);
            expect(s.vertexShader).not.toContain('sbCrownC');
            expect(s.fragmentShader).toContain('#include <normal_fragment_begin>');      // three's own chunk, with its flip
        }
        // the vertex stage turns a card's own normal to the crown's side before blending, so its back side is lit like its front,
        // and only where the level blends: with blend 0 the normal varying is left as the plain material writes it
        expect(CROWN_VERTEX_MAIN).toMatch(/if \( sbBlend > 0\.0 \) \{[\s\S]*if \( dot\( sbOwn, sbC \) < 0\.0 \) sbOwn = - sbOwn;[\s\S]*vSbCrownFlip = 0\.0;/);
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
        // the two levels of the 0|1 crossfade (the others are hidden and keep their base until they show)
        const leaves = lodMeshes(root).filter(m => m.userData.sbCrownLeaf && (m as THREE.InstancedMesh).isInstancedMesh && levelOf(m) <= 1);
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
