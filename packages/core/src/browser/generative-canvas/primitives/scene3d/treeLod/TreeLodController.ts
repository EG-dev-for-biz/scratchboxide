/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/


import * as THREE from 'three';
import type { TreeLodExtras, TreeNodeExtras, TreesGlbRootExtras } from '../../../../../common/spatial/staged-location-contracts';
import { isStagedMaterial } from '../stagedBuild/revealMaterial';
import { makeFadeVariant } from './treeLodFade';
import { FADE_STEPS, hysteresisDistance, levelRange, quantiseRange, stepEdges, targetEdges, type LodBand, type LodEdges } from './treeLodMath';

/**
 * Per-tree level of detail for a trees GLB that follows the tree LOD contract (staged-location-contracts.ts): every
 * node with extras `sbTree` has three children `sbLod` (0 near, 1 mid, 2 far), levels 0 and 1 holding instanced leaf
 * clusters (EXT_mesh_gpu_instancing, which GLTFLoader turns into THREE.InstancedMesh).
 *
 * Every frame, before the render: each tree is tested against the camera frustum (a tree outside it is hidden with one
 * write and costs nothing else); a tree inside gets its distance (to the nearest point of its bounding sphere),
 * filtered by a hysteresis dead band, mapped to the two cut edges that share the stable hash between the levels
 * (treeLodMath.ts), and the edges move toward that target at a bounded rate, so a level crossfades in over
 * `fadeSeconds` even when the camera jumps. A level whose share is empty is hidden; a level that has the whole share
 * wears the plain material; a level in a crossfade wears a quantised dither variant of it (treeLodFade.ts).
 *
 * Work is bounded per frame: at most `maxCommitsPerFrame` trees change their drawn state (nearest first, the rest keep
 * their previous state one more frame) and `maxNewVariantsPerFrame` material variants are made; when the estimated
 * triangles exceed `triangleBudget` every distance is stretched (a bias that eases back when there is headroom).
 *
 * Wood and leaves share whatever material the mesh's base says: `mesh.userData.sbLodBase` (set by clayRenderMode to
 * the one shared studio-clay material), else the material the loader gave it. A mesh the staged-build hook has
 * dressed (reveal, provenance) is left to the hook, and its tree switches level without a dissolve meanwhile.
 * Trees are labelled by the layer ("grown to the measured crown") at every level; nothing here names a species.
 */

export interface TreeLodOptions {
    /** Dead band (m) of the distance filter. */
    hysteresisM?: number;
    /** Seconds a level takes to dissolve into the next. */
    fadeSeconds?: number;
    /** Trees whose drawn state may change in one frame. */
    maxCommitsPerFrame?: number;
    /** Material variants that may be created in one frame (each compiles a program the first time). */
    maxNewVariantsPerFrame?: number;
    /** Drawn triangles per frame the estimate may reach before levels are pushed farther away. */
    triangleBudget?: number;
    /** Smallest distance scale the budget may force (1 = none). */
    minBias?: number;
    /** Clock in ms, replaceable in tests. */
    now?: () => number;
}

export interface TreeLodStats {
    trees: number;
    /** Trees inside the frustum this frame. */
    visibleTrees: number;
    culledTrees: number;
    /** Visible trees whose share is wholly level 0 / 1 / 2, and those in a crossfade. */
    atLevel: [number, number, number];
    fading: number;
    /** Estimated triangles the visible trees draw, counting each level by the share of the hash it draws. */
    estimatedTriangles: number;
    commits: number;
    deferredCommits: number;
    newVariants: number;
    bias: number;
    /** JS time spent in update() (ms). */
    updateMs: number;
}

interface LevelState { gate: THREE.Object3D; meshes: THREE.Mesh[]; triangles: number; applied: string }
interface TreeState {
    node: THREE.Object3D;
    id: number;
    bands: [LodBand, LodBand, LodBand];
    levels: [LevelState, LevelState, LevelState];
    centerLocal: THREE.Vector3;
    radiusLocal: number;
    filteredD: number | undefined;
    edges: LodEdges;
    snap: boolean;
    culled: boolean;
    // per-frame scratch
    dist: number;
    want: [string, string, string];
}

const triangleCountOf = (m: THREE.Mesh): number => {
    const g = m.geometry as THREE.BufferGeometry | undefined;
    if (!g) return 0;
    const per = g.index ? g.index.count / 3 : (g.getAttribute('position')?.count ?? 0) / 3;
    return per * ((m as THREE.InstancedMesh).isInstancedMesh ? (m as THREE.InstancedMesh).count : 1);
};

const keyOf = (r: [number, number]): string => {
    const q = quantiseRange(r);
    return q === null ? 'off' : q === 'full' ? 'full' : `${q[0]}-${q[1]}`;
};

export class TreeLodController {
    readonly psiSeason: number | undefined;
    private readonly trees: TreeState[] = [];
    private readonly opts: Required<Omit<TreeLodOptions, 'now'>> & { now: () => number };
    private readonly variants = new Map<THREE.Material, Map<string, THREE.Material>>();
    private bias = 1;
    private lastMs: number | undefined;
    private readonly frustum = new THREE.Frustum();
    private readonly pv = new THREE.Matrix4();
    private readonly tmp = new THREE.Vector3();
    readonly stats: TreeLodStats = { trees: 0, visibleTrees: 0, culledTrees: 0, atLevel: [0, 0, 0], fading: 0, estimatedTriangles: 0, commits: 0, deferredCommits: 0, newVariants: 0, bias: 1, updateMs: 0 };

    /** Finds the trees under `root` (a loaded trees GLB scene) and puts a gate above each level node. Returns nothing to do when there are none. */
    constructor(readonly root: THREE.Object3D, options: TreeLodOptions = {}) {
        this.opts = {
            hysteresisM: options.hysteresisM ?? 2, fadeSeconds: options.fadeSeconds ?? 0.35,
            maxCommitsPerFrame: options.maxCommitsPerFrame ?? 400, maxNewVariantsPerFrame: options.maxNewVariantsPerFrame ?? 6,
            triangleBudget: options.triangleBudget ?? 8_000_000, minBias: options.minBias ?? 0.25,
            now: options.now ?? (() => performance.now())
        };
        this.psiSeason = (root.userData?.sbTrees as TreesGlbRootExtras | undefined)?.psiSeason;
        root.updateMatrixWorld(true);
        const found: THREE.Object3D[] = [];
        root.traverse(o => { if ((o.userData as { sbTree?: TreeNodeExtras })?.sbTree) found.push(o); });
        for (const node of found) {
            const s = this.adopt(node);
            if (s) this.trees.push(s);
        }
        this.stats.trees = this.trees.length;
    }

    get treeCount(): number { return this.trees.length; }
    get hasTrees(): boolean { return this.trees.length > 0; }

    private adopt(node: THREE.Object3D): TreeState | undefined {
        const byLevel: Array<{ obj: THREE.Object3D; lod: TreeLodExtras } | undefined> = [undefined, undefined, undefined];
        for (const c of node.children) {
            const lod = (c.userData as { sbLod?: TreeLodExtras })?.sbLod;
            if (lod && lod.level >= 0 && lod.level <= 2) byLevel[lod.level] = { obj: c, lod };
        }
        if (!byLevel[0] || !byLevel[1] || !byLevel[2]) return undefined;
        const bands = byLevel.map(l => ({ minDistM: l!.lod.minDistM, maxDistM: l!.lod.maxDistM, fadeM: l!.lod.fadeM })) as [LodBand, LodBand, LodBand];
        const levels = byLevel.map(l => {
            const gate = new THREE.Object3D();
            gate.name = `sb-lod-gate-${l!.lod.level}`;
            node.add(gate);
            gate.add(l!.obj);                         // re-parents out of the tree node
            gate.visible = false;
            const meshes: THREE.Mesh[] = [];
            l!.obj.traverse(o => {
                const m = o as THREE.Mesh;
                if (!m.isMesh) return;
                m.userData.sbTreeLodMesh = true;
                if (m.userData.sbLodBase === undefined && !Array.isArray(m.material)) m.userData.sbLodBase = m.material;
                meshes.push(m);
            });
            return { gate, meshes, triangles: meshes.reduce((a, m) => a + triangleCountOf(m), 0), applied: 'off' };
        }) as [LevelState, LevelState, LevelState];
        const box = new THREE.Box3().setFromObject(node);
        const sphere = box.isEmpty() ? new THREE.Sphere(node.getWorldPosition(new THREE.Vector3()), 1) : box.getBoundingSphere(new THREE.Sphere());
        const scale = Math.max(1e-6, node.matrixWorld.getMaxScaleOnAxis());
        return {
            node, id: (node.userData.sbTree as TreeNodeExtras).id, bands, levels,
            centerLocal: node.worldToLocal(sphere.center.clone()), radiusLocal: sphere.radius / scale,
            filteredD: undefined, edges: { e0: 0, e1: 0 }, snap: true, culled: false, dist: 0, want: ['off', 'off', 'off']
        };
    }

    /** The distance edges a given tree currently has, for diagnostics and tests. */
    edgesOf(index: number): LodEdges { return { ...this.trees[index].edges }; }
    /** Draw state of each level of a tree ('off', 'full' or a quantised range), for diagnostics and tests. */
    stateOf(index: number): [string, string, string] { return this.trees[index].levels.map(l => l.applied) as [string, string, string]; }

    update(camera: THREE.Camera): TreeLodStats {
        const t0 = this.opts.now();
        const dt = this.lastMs === undefined ? 1 : Math.min(0.1, Math.max(0, (t0 - this.lastMs) / 1000));
        this.lastMs = t0;
        const maxStep = dt / Math.max(1e-3, this.opts.fadeSeconds);
        camera.updateMatrixWorld();
        this.pv.multiplyMatrices((camera as THREE.PerspectiveCamera).projectionMatrix, camera.matrixWorldInverse);
        this.frustum.setFromProjectionMatrix(this.pv);
        const camPos = camera.getWorldPosition(this.tmp.set(0, 0, 0)).clone();
        const s = this.stats;
        s.visibleTrees = 0; s.culledTrees = 0; s.atLevel = [0, 0, 0]; s.fading = 0; s.estimatedTriangles = 0; s.commits = 0; s.deferredCommits = 0; s.newVariants = 0;
        const dirty: TreeState[] = [];
        const sphere = new THREE.Sphere();
        for (const t of this.trees) {
            t.node.updateWorldMatrix(true, false);
            sphere.center.copy(t.centerLocal).applyMatrix4(t.node.matrixWorld);
            sphere.radius = t.radiusLocal * Math.max(1e-6, t.node.matrixWorld.getMaxScaleOnAxis());
            const inView = this.frustum.intersectsSphere(sphere);
            if (!inView) {
                t.culled = true; t.snap = true;
                if (t.node.visible) t.node.visible = false;
                s.culledTrees++;
                continue;
            }
            if (!t.node.visible) t.node.visible = true;
            t.dist = Math.max(0, sphere.center.distanceTo(camPos) - sphere.radius);
            t.filteredD = hysteresisDistance(t.snap ? undefined : t.filteredD, t.dist, this.opts.hysteresisM);
            const target = targetEdges(t.filteredD / this.bias, t.bands);
            t.edges = t.snap ? target : stepEdges(t.edges, target, maxStep);
            t.snap = false; t.culled = false;
            s.visibleTrees++;
            let changed = false;
            for (let k = 0; k < 3; k++) {
                const w = keyOf(levelRange(t.edges, k as 0 | 1 | 2));
                t.want[k] = w;
                if (w !== t.levels[k].applied) changed = true;
                const [lo, hi] = levelRange(t.edges, k as 0 | 1 | 2);
                s.estimatedTriangles += t.levels[k].triangles * Math.max(0, hi - lo);
            }
            if (t.edges.e0 >= 1 - 1e-6) s.atLevel[0]++; else if (t.edges.e0 <= 1e-6 && t.edges.e1 >= 1 - 1e-6) s.atLevel[1]++; else if (t.edges.e0 <= 1e-6 && t.edges.e1 <= 1e-6) s.atLevel[2]++; else s.fading++;
            if (changed) dirty.push(t);
        }
        if (dirty.length > this.opts.maxCommitsPerFrame) {
            dirty.sort((a, b) => a.dist - b.dist);
            s.deferredCommits = dirty.length - this.opts.maxCommitsPerFrame;
            dirty.length = this.opts.maxCommitsPerFrame;
        }
        let variantBudget = this.opts.maxNewVariantsPerFrame;
        for (const t of dirty) {
            let done = true;
            for (let k = 0; k < 3; k++) {
                const lvl = t.levels[k];
                if (lvl.applied === t.want[k]) continue;
                const r = this.commit(lvl, t.want[k], variantBudget);
                variantBudget -= r.made;
                s.newVariants += r.made;
                if (!r.ok) done = false;
            }
            if (!done) s.deferredCommits++;
            s.commits++;
        }
        // Budget: stretch the distances while the estimate is over, ease back when there is headroom.
        if (s.estimatedTriangles > this.opts.triangleBudget) this.bias = Math.max(this.opts.minBias, this.bias * 0.96);
        else if (s.estimatedTriangles < 0.8 * this.opts.triangleBudget && this.bias < 1) this.bias = Math.min(1, this.bias * 1.01);
        s.bias = this.bias;
        s.updateMs = this.opts.now() - t0;
        return s;
    }

    /** Applies one level's wanted state. A level wanting a dither variant it cannot afford yet keeps its previous state. */
    private commit(lvl: LevelState, want: string, variantBudget: number): { ok: boolean; made: number } {
        let made = 0;
        if (want === 'off') { lvl.gate.visible = false; lvl.applied = want; return { ok: true, made }; }
        const dressed: Array<[THREE.Mesh, THREE.Material]> = [];
        let handDressed = false;
        for (const m of lvl.meshes) {
            const base = m.userData.sbLodBase as THREE.Material | undefined;
            if (!base) continue;
            if (isStagedMaterial(m.material as THREE.Material)) { handDressed = true; continue; }
            if (want === 'full') { dressed.push([m, base]); continue; }
            const inst = !!(m as THREE.InstancedMesh).isInstancedMesh;
            const key = `${want}|${inst ? 'I' : 'P'}`;
            let perBase = this.variants.get(base);
            if (!perBase) this.variants.set(base, perBase = new Map());
            let v = perBase.get(key);
            if (!v) {
                if (variantBudget - made <= 0) return { ok: false, made };
                const [lo, hi] = want.split('-').map(Number);
                v = makeFadeVariant(base, lo, hi, inst);
                perBase.set(key, v);
                made++;
            }
            dressed.push([m, v]);
        }
        for (const [m, mat] of dressed) if (m.material !== mat) m.material = mat;
        // A level the staged-build hook has dressed cannot dither: it shows when it has the larger share, else it is off.
        lvl.gate.visible = !handDressed || want === 'full' || (() => { const [lo, hi] = want.split('-').map(Number); return hi - lo >= FADE_STEPS / 2; })();
        lvl.applied = want;
        return { ok: true, made };
    }

    /** Puts the trees back as loaded (levels shown by the loader's own structure) and frees the dither variants. */
    dispose(): void {
        for (const t of this.trees) {
            for (const l of t.levels) {
                for (const m of l.meshes) {
                    const base = m.userData.sbLodBase as THREE.Material | undefined;
                    if (base && !isStagedMaterial(m.material as THREE.Material)) m.material = base;
                    delete m.userData.sbTreeLodMesh;
                }
                const child = l.gate.children[0];
                if (child) t.node.add(child);
                t.node.remove(l.gate);
            }
            t.node.visible = true;
        }
        for (const per of this.variants.values()) for (const v of per.values()) v.dispose();
        this.variants.clear();
        this.trees.length = 0;
    }
}
