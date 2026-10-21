/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Tree levels chosen by what the camera sees: on-screen size at the current lens, a foveal weight toward the centre of
 * view (or the focus point), depth-of-field demotion, and the budget spent by on-screen importance.
 */

import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { TreeLodController, type TreeLodFrame, type TreeLodViewInput } from '../src/browser/generative-canvas/primitives/scene3d/treeLod/TreeLodController';
import {
    blurDemotionLevels, demoteEdges, fovealWeight, levelRange, pixelThresholds, projectedHeightPx, quantiseRange, screenEquivalentDistance, targetEdges, type LodBand
} from '../src/browser/generative-canvas/primitives/scene3d/treeLod/treeLodMath';
import { circleOfConfusionPx } from '../src/browser/generative-canvas/primitives/scene3d/viewportOptics';
import { buildTreesLodGltf, writeTreesLodGlb } from './helpers/synthetic-trees-lod-glb';

const BANDS4: LodBand[] = [{ minDistM: 0, maxDistM: 60, fadeM: 10 }, { minDistM: 50, maxDistM: 110, fadeM: 20 }, { minDistM: 90, maxDistM: 200, fadeM: 30 }, { minDistM: 170, maxDistM: 1e6, fadeM: 60 }];
const SCREEN = { referenceFovDeg: 45, referenceHeightPx: 1080, resolutionExponent: 0 };
/** Vertical field of view of a lens on a full-frame (24 mm tall) sensor. */
const fovOf = (focalMm: number) => (2 * Math.atan(12 / focalMm) * 180) / Math.PI;

async function loadFixture(trees: number): Promise<THREE.Object3D> {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sb-lods-')), 't.glb');
    writeTreesLodGlb(file, buildTreesLodGltf({ trees, levels: 4 }));
    const buf = fs.readFileSync(file);
    return (await new GLTFLoader().parseAsync(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer, '')).scene;
}
const treeNodes = (root: THREE.Object3D): THREE.Object3D[] => { const out: THREE.Object3D[] = []; root.traverse(o => { if (o.userData?.sbTree) out.push(o); }); return out; };
const sphereOf = (o: THREE.Object3D) => new THREE.Box3().setFromObject(o).getBoundingSphere(new THREE.Sphere());
const clock = () => { let t = 1000; return { now: () => t, tick: (ms = 16.7) => { t += ms; } }; };

/** A camera `d` metres from the nearest point of the tree's sphere, looking at it, with vertical FOV `fov`. */
function cameraAt(tree: THREE.Object3D, d: number, fov = 45, aspect = 16 / 9): THREE.PerspectiveCamera {
    tree.updateMatrixWorld(true);
    const s = sphereOf(tree);
    const cam = new THREE.PerspectiveCamera(fov, aspect, 0.1, 6000);
    cam.position.copy(s.center).add(new THREE.Vector3(0, 0, s.radius + d));
    cam.lookAt(s.center); cam.updateMatrixWorld(true);
    return cam;
}
const settle = (lod: TreeLodController, cam: THREE.Camera, c: ReturnType<typeof clock>, frame?: TreeLodFrame, frames = 80) => { for (let i = 0; i < frames; i++) { c.tick(); lod.update(cam, null, frame); } };
/** The level holding the largest share of a tree's hash. */
const levelOf = (lod: TreeLodController, i: number) => {
    const e = lod.edgesOf(i);
    let best = 0, share = -1;
    for (let k = 0; k <= e.length; k++) { const [lo, hi] = levelRange(e, k); if (hi - lo > share + 1e-9) { share = hi - lo; best = k; } }
    return best;
};

describe('on-screen size arithmetic', () => {
    it('at the reference lens the equivalent distance is the distance itself, at any frame height (no change at 45°)', () => {
        for (const r of [0, 3, 17.5, 55, 140, 600]) for (const h of [480, 846, 1080, 2160]) expect(screenEquivalentDistance(r, 45, h, 1, SCREEN)).toBeCloseTo(r, 9);
    });

    it('pixel thresholds are the metre bands seen through the reference lens, and give the same edges', () => {
        const sizeM = 12;
        const th = pixelThresholds(BANDS4, sizeM, SCREEN);
        // band edge D <-> projected height S H / (2 D tan 22.5°)
        expect(th[1][1]).toBeCloseTo((sizeM * 1080) / (2 * 110 * Math.tan(Math.PI / 8)), 9);
        expect(th[0][0]).toBe(Infinity);
        // reading the bands at the reference distance of a tree whose projected height equals a threshold puts it at that band edge
        for (const [k, edge] of [[0, 'leave'], [1, 'enter'], [2, 'leave'], [3, 'enter']] as const) {
            const px = th[k][edge === 'leave' ? 1 : 0];
            const d = (sizeM * 1080) / (2 * px * Math.tan(Math.PI / 8));
            expect(d).toBeCloseTo(edge === 'leave' ? BANDS4[k].maxDistM : BANDS4[k].minDistM, 6);
        }
        for (let r = 0; r < 400; r += 2.5) expect(targetEdges(screenEquivalentDistance(r, 45, 900, 1, SCREEN), BANDS4)).toEqual(targetEdges(r, BANDS4));
    });

    it('a longer lens reads a tree as nearer, a wider one as farther; actual pixels count only with resolutionExponent', () => {
        expect(screenEquivalentDistance(120, fovOf(85), 1080, 1, SCREEN)).toBeCloseTo(120 * Math.tan(Math.atan(12 / 85)) / Math.tan(Math.PI / 8), 6);
        expect(screenEquivalentDistance(120, fovOf(85), 1080, 1, SCREEN)).toBeLessThan(50);
        expect(screenEquivalentDistance(120, fovOf(14), 1080, 1, SCREEN)).toBeGreaterThan(200);
        expect(screenEquivalentDistance(100, 45, 2160, 1, { ...SCREEN, resolutionExponent: 1 })).toBeCloseTo(50, 9);
        expect(projectedHeightPx(10, 100, 45, 1080)).toBeCloseTo(10 * 1080 / (200 * Math.tan(Math.PI / 8)), 9);
    });

    it('foveal weight: centre weight inside the centre radius, edge weight past the edge radius, smooth and monotone between', () => {
        const p = { centreWeight: 1, edgeWeight: 0.5, centreRadius: 0.2, edgeRadius: 1, curve: 1, verticalWeight: 0.5 };
        expect(fovealWeight(0, p)).toBe(1); expect(fovealWeight(0.2, p)).toBe(1); expect(fovealWeight(1, p)).toBe(0.5); expect(fovealWeight(3, p)).toBe(0.5);
        let prev = 1;
        for (let r = 0; r <= 1.2; r += 0.01) { const w = fovealWeight(r, p); expect(w).toBeLessThanOrEqual(prev + 1e-12); expect(prev - w).toBeLessThan(0.02); prev = w; }
    });

    it('demotion by a continuous number of levels keeps the shares tiling the hash and is whole-level at integers', () => {
        const e = targetEdges(20, BANDS4);                                // wholly near: [1, 1, 1]
        expect(demoteEdges(e, 1)).toEqual([0, 1, 1]);                     // wholly near-mid
        expect(demoteEdges(e, 2)).toEqual([0, 0, 1]);                     // wholly mid
        for (let a = 0; a <= 3; a += 0.05) {
            const d = demoteEdges(targetEdges(55, BANDS4), a);
            let covered = 0;
            for (let k = 0; k < 4; k++) { const q = quantiseRange(levelRange(d, k)); covered += q === null ? 0 : q === 'full' ? 16 : q[1] - q[0]; }
            expect(covered).toBe(16);
            for (let k = 1; k < d.length; k++) expect(d[k]).toBeGreaterThanOrEqual(d[k - 1]);
        }
        expect(blurDemotionLevels(1.9, { startPx: 2, fullPx: 10, maxLevels: 2 })).toBe(0);
        expect(blurDemotionLevels(10, { startPx: 2, fullPx: 10, maxLevels: 2 })).toBe(2);
        expect(blurDemotionLevels(6, { startPx: 2, fullPx: 10, maxLevels: 2 })).toBeCloseTo(1, 9);
    });
});

describe('TreeLodController by what the camera sees', () => {
    it('chooses the same level as the metre bands at the default 45° lens with the foveal weight off; the centre weight then reads a centre tree nearer', async () => {
        const root = await loadFixture(1);
        const tree = treeNodes(root)[0];
        const root2 = await loadFixture(1);
        const c = clock();
        // the default dead band also grows with distance (3 %, a log-space band); with it at 0 both filter alike
        const screen = new TreeLodController(root, { now: c.now, view: { screen: { hysteresisShare: 0 }, foveal: { enabled: false } } });
        const metres = new TreeLodController(root2, { now: c.now, view: { screen: { enabled: false } } });
        const tree2 = treeNodes(root2)[0];
        for (const d of [10, 30, 55, 75, 100, 140, 185, 260, 600, 120, 52, 20]) {
            for (let i = 0; i < 80; i++) { c.tick(); screen.update(cameraAt(tree, d), null, { heightPx: 846 }); metres.update(cameraAt(tree2, d), null, { heightPx: 846 }); }
            expect(screen.edgesOf(0)).toEqual(metres.edgesOf(0));
            expect(screen.stateOf(0)).toEqual(metres.stateOf(0));
            expect(screen.explain(0).fovealWeight).toBe(1);
            expect(screen.explain(0).equivalentDistM).toBeCloseTo(metres.explain(0).equivalentDistM, 6);
        }
        expect(metres.stats.screenSpace).toBe(false); expect(screen.stats.screenSpace).toBe(true);
        // the default foveal weight: a tree in the centre of view is read at its distance / centreWeight
        screen.setView({ screen: { hysteresisShare: 0 } });
        settle(screen, cameraAt(tree, 90), c, { heightPx: 846 });
        expect(screen.explain(0).fovealWeight).toBe(2);
        expect(Math.abs(screen.explain(0).equivalentDistM - 45)).toBeLessThanOrEqual(2 + 1e-9);   // 90 m / 2, within the 2 m dead band
    });

    it('an 85 mm lens keeps leaves on a tree 120 m away; 14 mm drops it to the far masses; metre bands ignore the lens', async () => {
        const root = await loadFixture(1);
        const tree = treeNodes(root)[0];
        const c = clock();
        const lod = new TreeLodController(root, { now: c.now, view: { foveal: { enabled: false } } });
        settle(lod, cameraAt(tree, 120, 45), c);
        expect(levelOf(lod, 0)).toBe(2);                                  // mid at 45°
        settle(lod, cameraAt(tree, 120, fovOf(85)), c);
        expect(levelOf(lod, 0)).toBe(0);                                  // near: the leaves
        expect(lod.explain(0).projectedPx).toBeGreaterThan(projectedHeightPx(lod.explain(0).sizeM, 120, 45, 1080) * 2.5);
        settle(lod, cameraAt(tree, 120, fovOf(14)), c);
        expect(levelOf(lod, 0)).toBe(3);                                  // far: solid masses
        lod.setView({ screen: { enabled: false }, foveal: { enabled: false } });
        settle(lod, cameraAt(tree, 120, fovOf(85)), c);
        expect(levelOf(lod, 0)).toBe(2);                                  // the old metre behaviour
        expect(lod.stats.screenSpace).toBe(false);
    });

    /** Five trees at one distance across the frame, the camera looking at the middle one. */
    async function rowAcrossFrame(): Promise<{ root: THREE.Object3D; cam: THREE.PerspectiveCamera; order: number[] }> {
        const root = await loadFixture(5);
        const cam = new THREE.PerspectiveCamera(45, 16 / 9, 0.1, 6000);
        cam.position.set(0, 4, 0); cam.lookAt(0, 4, -1); cam.updateMatrixWorld(true);
        const hfov = 2 * Math.atan(Math.tan(Math.PI / 8) * 16 / 9);
        const angles = [-0.85, -0.45, 0, 0.45, 0.85].map(f => f * hfov / 2);
        treeNodes(root).forEach((t, i) => { t.position.set(70 * Math.sin(angles[i]), 0, -70 * Math.cos(angles[i])); });
        root.updateMatrixWorld(true);
        return { root, cam, order: [2, 1, 3, 0, 4] };
    }

    it('foveal weight: at one distance, the tree in the centre keeps a finer level than those at the left and right edges, with room in the budget', async () => {
        const { root, cam } = await rowAcrossFrame();
        const c = clock();
        const lod = new TreeLodController(root, { now: c.now, triangleBudget: 1e9 });
        settle(lod, cam, c);
        expect(lod.stats.demotedTrees).toBe(0);
        const w = [0, 1, 2, 3, 4].map(i => lod.explain(i).fovealWeight);
        expect(w[2]).toBe(lod.viewOptions.foveal.centreWeight); expect(w[0]).toBeLessThan(0.6 * w[2]); expect(w[4]).toBeLessThan(0.6 * w[2]);
        expect(w[1]).toBeGreaterThan(w[0]); expect(w[3]).toBeGreaterThan(w[4]);
        const lv = [0, 1, 2, 3, 4].map(i => levelOf(lod, i));
        expect(lv[2]).toBeLessThan(lv[0]); expect(lv[2]).toBeLessThan(lv[4]);
        expect(lv[2]).toBeLessThanOrEqual(lv[1]); expect(lv[2]).toBeLessThanOrEqual(lv[3]);
        // the falloff off: every tree at one level
        lod.setView({ foveal: { enabled: false } });
        settle(lod, cam, c);
        expect(new Set([0, 1, 2, 3, 4].map(i => levelOf(lod, i))).size).toBe(1);
    });

    it('spends the budget on the centre of view: under a tight budget the edge trees give up their levels first', async () => {
        const { root, cam } = await rowAcrossFrame();
        const c = clock();
        // same distance and equal weights: only the place in the frame differs
        const roomy = new TreeLodController(root, { now: c.now, view: { foveal: { centreWeight: 1, edgeWeight: 1 } }, triangleBudget: 1e9 });
        settle(roomy, cam, c);
        const full = roomy.stats.estimatedTriangles;
        expect(new Set([0, 1, 2, 3, 4].map(i => levelOf(roomy, i))).size).toBe(1);
        roomy.dispose();
        const tight = new TreeLodController(root, { now: c.now, view: { foveal: { centreWeight: 1, edgeWeight: 0.999 } }, triangleBudget: full - 1 });
        settle(tight, cam, c);
        expect(tight.stats.demotedTrees).toBeGreaterThan(0);
        const demoted = [0, 1, 2, 3, 4].filter(i => tight.explain(i).budgetDemotions > 0);
        expect(demoted.length).toBeGreaterThan(0);
        expect(demoted).not.toContain(2);                                  // the centre tree keeps its level
        expect(demoted.every(i => i === 0 || i === 4)).toBe(true);         // the edges pay first
        expect(tight.explain(2).importance).toBeGreaterThan(tight.explain(0).importance);
    });

    it('keeps trees outside the frustum at the minimum: hidden, or (shadow only) never a leaf-heavy level', async () => {
        const root = await loadFixture(3);
        root.traverse(o => { if ((o as THREE.Mesh).isMesh) (o as THREE.Mesh).castShadow = true; });
        const c = clock();
        const lod = new TreeLodController(root, { now: c.now, triangleBudget: 1e9 });
        const cam = cameraAt(treeNodes(root)[0], 15, fovOf(85));         // a long lens: the tree would be near if seen
        cam.lookAt(cam.position.clone().add(new THREE.Vector3(0, 0, 100))); cam.updateMatrixWorld(true);
        for (let i = 0; i < 40; i++) { c.tick(); lod.update(cam, null, { heightPx: 1080 }); }
        expect(lod.stats.visibleTrees).toBe(0); expect(lod.stats.culledTrees).toBe(3);
        expect(treeNodes(root).every(t => !t.visible)).toBe(true);
        expect(lod.explain(0).culled).toBe(true);
        const shadowCam = new THREE.OrthographicCamera(-500, 500, 500, -500, 0.1, 2000);
        shadowCam.position.copy(sphereOf(treeNodes(root)[0]).center).add(new THREE.Vector3(0, 400, 0)); shadowCam.lookAt(sphereOf(treeNodes(root)[0]).center); shadowCam.updateMatrixWorld(true);
        for (let i = 0; i < 40; i++) { c.tick(); lod.update(cam, shadowCam, { heightPx: 1080 }); }
        expect(lod.stats.shadowOnlyTrees).toBe(3);
        for (let i = 0; i < 3; i++) { expect(levelOf(lod, i)).toBeGreaterThanOrEqual(2); expect(lod.explain(i).importance).toBe(-1); }
    });

    it('keeps trees in the distortion overscan margin: they are drawn and pulled into the frame', async () => {
        const root = await loadFixture(1);
        const tree = treeNodes(root)[0];
        const c = clock();
        const lod = new TreeLodController(root, { now: c.now });
        const cam = cameraAt(tree, 40, 45, 1);
        // turn until the tree's sphere is just outside the pinhole frame
        const s = sphereOf(tree);
        const half = Math.PI / 8;
        const dist = s.center.distanceTo(cam.position);
        const yaw = half + Math.asin(s.radius / dist) + 0.03;
        cam.rotateY(yaw); cam.updateMatrixWorld(true);
        lod.update(cam, null, { heightPx: 1080 });
        expect(lod.stats.culledTrees).toBe(1);
        lod.update(cam, null, { heightPx: 1080, overscan: 1.4 });
        expect(lod.stats.culledTrees).toBe(0); expect(tree.visible).toBe(true);
    });
});

describe('TreeLodController depth-of-field demotion', () => {
    /** Three trees on the view axis at 15 m, 60 m and 160 m from the camera (to their centres). */
    async function depthRow(): Promise<{ root: THREE.Object3D; cam: THREE.PerspectiveCamera; depths: number[] }> {
        const root = await loadFixture(3);
        const depths = [15, 60, 160];
        treeNodes(root).forEach((t, i) => t.position.set(i === 0 ? 0 : (i === 1 ? -3 : 4), 0, -depths[i]));
        root.updateMatrixWorld(true);
        const cam = new THREE.PerspectiveCamera(fovOf(85), 16 / 9, 0.1, 6000);
        const centre0 = sphereOf(treeNodes(root)[0]).center;
        cam.position.set(0, centre0.y, 0); cam.lookAt(0, centre0.y, -1); cam.updateMatrixWorld(true);
        return { root, cam, depths: treeNodes(root).map(t => -sphereOf(t).center.clone().applyMatrix4(cam.matrixWorldInverse).z) };
    }
    const dofAt = (focusM: number, focusPoint?: THREE.Vector3, focusObject?: THREE.Object3D): TreeLodFrame => ({ heightPx: 1080, dof: { focalLengthMm: 85, apertureFStop: 1.4, focusM, focusPoint, focusObject, maxBlurRadiusPx: 27 } });

    it('demotes the blurred trees by up to two levels, with the shared thin-lens blur, and never the focus tree or one spanning the plane of focus', async () => {
        const { root, cam, depths } = await depthRow();
        const trees = treeNodes(root);
        const c = clock();
        const view: TreeLodViewInput = { foveal: { enabled: false } };
        const lod = new TreeLodController(root, { now: c.now, triangleBudget: 1e9, view });
        settle(lod, cam, c, { heightPx: 1080 });
        const sharp = [0, 1, 2].map(i => levelOf(lod, i));
        expect(lod.stats.blurDemotedTrees).toBe(0);
        // focused on the near tree (the focus object): the far ones blur
        const focus = sphereOf(trees[0]).center;
        settle(lod, cam, c, dofAt(depths[0], focus, trees[0]));
        const r = [0, 1, 2].map(i => lod.explain(i));
        expect(r[0].focusProtected).toBe(true); expect(r[0].blurDemotion).toBe(0); expect(levelOf(lod, 0)).toBe(sharp[0]);
        const R1 = sphereOf(trees[1]).radius;
        expect(r[1].blurRadiusPx).toBeCloseTo(Math.min(27, 0.5 * circleOfConfusionPx(85, 1.4, depths[0], depths[1] - R1, fovOf(85), 1080)), 6);
        expect(r[1].blurRadiusPx).toBeGreaterThan(5); expect(r[2].blurRadiusPx).toBeGreaterThan(r[1].blurRadiusPx);
        const defaults = lod.viewOptions.blur;
        expect(r[1].blurDemotion).toBeCloseTo(blurDemotionLevels(r[1].blurRadiusPx, defaults), 9);
        expect(r[1].blurDemotion).toBeGreaterThan(1.5); expect(r[2].blurDemotion).toBeGreaterThan(1.5);
        expect(levelOf(lod, 1)).toBe(Math.min(3, sharp[1] + 2)); expect(levelOf(lod, 2)).toBe(Math.min(3, sharp[2] + 2));
        expect(lod.stats.blurDemotedTrees).toBe(2); expect(lod.stats.focusProtectedTrees).toBe(1);
        // a focus distance inside the middle tree's depth span (the in-focus band): that tree is kept, even with no focus object
        settle(lod, cam, c, dofAt(depths[1] + 0.5 * R1));
        expect(lod.explain(1).focusProtected).toBe(true); expect(levelOf(lod, 1)).toBe(sharp[1]);
        // a small blur (deep focus at f/16) below the threshold demotes nothing
        settle(lod, cam, c, { heightPx: 1080, dof: { focalLengthMm: 85, apertureFStop: 16, focusM: depths[1] } });
        expect(lod.explain(2).blurRadiusPx).toBeLessThan(2); expect(lod.stats.blurDemotedTrees).toBe(0);
        // blur off: the levels come back
        lod.setView({ ...view, blur: { enabled: false } });
        settle(lod, cam, c, dofAt(depths[0], focus, trees[0]));
        expect([0, 1, 2].map(i => levelOf(lod, i))).toEqual(sharp);
    });

    it('focus-plane protection does not flicker at the sphere edge when the measured focus distance jitters a little', async () => {
        const { root, cam, depths } = await depthRow();
        const trees = treeNodes(root);
        const c = clock();
        const lod = new TreeLodController(root, { now: c.now, triangleBudget: 1e9, view: { foveal: { enabled: false } } });
        const R1 = sphereOf(trees[1]).radius;
        // focused well inside the middle tree: establishes protection
        c.tick(); lod.update(cam, null, dofAt(depths[1]));
        expect(lod.explain(1).focusProtected).toBe(true);
        // autofocus jitter: the measured focus distance ticks back and forth a couple of cm either side of the sphere's
        // edge (what a 100 ms-resampled, quantised depth read produces) - without hysteresis on the membership test
        // itself this flips protection, and the blur demotion it holds at 0, on every single frame
        const edge = depths[1] + R1;
        let flips = 0, was = true;
        for (let i = 0; i < 20; i++) {
            c.tick();
            lod.update(cam, null, dofAt(i % 2 === 0 ? edge - 0.02 : edge + 0.02));
            const now = lod.explain(1).focusProtected;
            if (now !== was) flips++;
            was = now;
        }
        expect(flips).toBe(0);
        // a real, sustained change (focus pulled well clear of the tree) still lifts protection
        for (let i = 0; i < 10; i++) { c.tick(); lod.update(cam, null, dofAt(depths[2])); }
        expect(lod.explain(1).focusProtected).toBe(false);
    });

    it('a rack focus crossfades: the edges move at the bounded rate and the shares tile the hash in every frame', async () => {
        const { root, cam, depths } = await depthRow();
        const c = clock();
        const lod = new TreeLodController(root, { now: c.now, fadeSeconds: 0.35, triangleBudget: 1e9, view: { foveal: { enabled: false } } });
        settle(lod, cam, c, dofAt(depths[0]));
        const before = [0, 1, 2].map(i => levelOf(lod, i));
        const prev = [0, 1, 2].map(i => lod.edgesOf(i));
        // rack from the near tree to the far one over half a second, then hold
        for (let f = 0; f < 120; f++) {
            c.tick(16.7);
            const t = Math.min(1, f / 30);
            lod.update(cam, null, dofAt(depths[0] + (depths[2] - depths[0]) * t * t * (3 - 2 * t)));
            for (let i = 0; i < 3; i++) {
                const e = lod.edgesOf(i);
                e.forEach((x, k) => expect(Math.abs(x - prev[i][k])).toBeLessThanOrEqual(16.7 / 350 + 1e-9));
                let covered = 0;
                for (let k = 0; k < 4; k++) { const q = quantiseRange(levelRange(e, k)); covered += q === null ? 0 : q === 'full' ? 16 : q[1] - q[0]; }
                expect(covered).toBe(16);
                prev[i] = e;
            }
        }
        const after = [0, 1, 2].map(i => levelOf(lod, i));
        expect(after[0]).toBeGreaterThan(before[0]);                      // the near tree went soft and coarse
        expect(after[2]).toBeLessThan(before[2]);                         // the far one came into focus and gained detail
    });

    it('turning the camera crossfades the foveal levels without a jump', async () => {
        const root = await loadFixture(5);
        treeNodes(root).forEach((t, i) => t.position.set((i - 2) * 25, 0, -75));
        root.updateMatrixWorld(true);
        const c = clock();
        const lod = new TreeLodController(root, { now: c.now, fadeSeconds: 0.35, triangleBudget: 1e9 });
        const cam = new THREE.PerspectiveCamera(45, 16 / 9, 0.1, 6000);
        cam.position.set(0, 4, 0);
        const aim = (yaw: number) => { cam.rotation.set(0, yaw, 0); cam.updateMatrixWorld(true); };
        aim(-0.35); settle(lod, cam, c);
        const start = [0, 1, 2, 3, 4].map(i => levelOf(lod, i));
        const prev = [0, 1, 2, 3, 4].map(i => lod.edgesOf(i));
        const wasCulled = [0, 1, 2, 3, 4].map(i => lod.explain(i).culled);
        let moved = 0;
        for (let f = 0; f <= 240; f++) {                                  // a slow pan across the row (0.7 rad over 4 s)
            c.tick(16.7); aim(-0.35 + 0.7 * f / 240); lod.update(cam, null, { heightPx: 1080 });
            for (let i = 0; i < 5; i++) {
                const e = lod.edgesOf(i);
                // a tree that was culled last frame enters at its target (nothing of it was drawn to fade from)
                if (!wasCulled[i]) e.forEach((x, k) => { expect(Math.abs(x - prev[i][k])).toBeLessThanOrEqual(16.7 / 350 + 1e-9); moved += Math.abs(x - prev[i][k]); });
                prev[i] = e; wasCulled[i] = lod.explain(i).culled;
            }
        }
        settle(lod, cam, c, { heightPx: 1080 });
        const end = [0, 1, 2, 3, 4].map(i => levelOf(lod, i));
        expect(moved).toBeGreaterThan(0);
        expect(end).not.toEqual(start);                                   // detail followed the view
        // the pan runs from the +x end of the row (yaw -0.35, looking right) to the -x end: detail moves from tree 4 to tree 0
        expect(end[4]).toBeGreaterThanOrEqual(start[4]); expect(end[0]).toBeLessThanOrEqual(start[0]);
        expect(end[0]).toBeLessThan(end[4]);
    });
});
