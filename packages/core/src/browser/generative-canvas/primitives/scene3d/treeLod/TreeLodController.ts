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
import { attachCrownAttributes, crownQuadricInMeshFrame, makeCrownVariant, resolveCrownShading, setCrownShadingUniforms, supportsCrownShading, type CrownShadingOptions } from './treeCrownShading';
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
 * triangles (main pass and shadow pass) exceed `triangleBudget` the farthest trees give up a level first.
 *
 * Wood and leaves share whatever material the mesh's base says: `mesh.userData.sbLodBase` (set by clayRenderMode to
 * the one shared studio-clay material), else the material the loader gave it. A mesh the staged-build hook has
 * dressed (reveal, provenance) is left to the hook, and its tree switches level without a dissolve meanwhile.
 * Shadows: the depth pass has no dither, so every level of a tree that is drawn into the shadow map is drawn in full. Each
 * tree therefore lets only the level with the largest share cast (the others have castShadow off), a tree that only the
 * shadow camera sees stays drawable at level 1 or 2 (never the leaf-bearing near level) so its shadow still falls into
 * view, and the triangle budget counts the shadow pass beside the main pass when a shadow camera is given.
 * Trees are labelled by the layer ("grown to the measured crown") at every level; nothing here names a species.
 *
 * Crown shading (treeCrownShading.ts): a tree whose extras carry its crown ellipsoid has its leaf meshes (the leaf-cluster
 * instances of levels 0 and 1, named by the root's cluster library, and the level-2 primitives its extras list as foliage;
 * never wood or twigs) wear a crown variant of their base, and the dither variants of a leaf mesh are made from that
 * variant. On by default; `setCrownShading` turns it off for comparison or changes its factors. A mesh whose material was
 * swapped behind the controller's back (the clay pass, a material override) is dressed again at the next frame.
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
    /** Clock in ms, replaceable in tests. */
    now?: () => number;
    /** Crown shading of the leaves (defaults: on, blend 0.7 / 0.9 / 1.0). */
    crownShading?: Partial<CrownShadingOptions>;
}

export interface TreeLodStats {
    trees: number;
    /** Trees inside the frustum this frame. */
    visibleTrees: number;
    culledTrees: number;
    /** Visible trees whose share is wholly level 0 / 1 / 2, and those in a crossfade. */
    atLevel: [number, number, number];
    fading: number;
    /** Triangles submitted for the visible trees: every level that shows any share of the hash counts in full. */
    estimatedTriangles: number;
    /** Triangles the shadow pass draws for the trees in the shadow camera's frustum (0 without a shadow camera): the casting level of each, in full. */
    estimatedShadowTriangles: number;
    /** Trees that only the shadow camera sees (drawn for their shadow, culled by the main camera). */
    shadowOnlyTrees: number;
    commits: number;
    deferredCommits: number;
    newVariants: number;
    /** Trees the budget held a level below where their distance puts them. */
    demotedTrees: number;
    /** JS time spent in update() (ms). */
    updateMs: number;
    /** Trees whose leaves carry a crown (crown shading applies to them when it is on). */
    crownTrees: number;
    /** Leaf meshes that carry crown attributes. */
    crownLeafMeshes: number;
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
    target: LodEdges;
    inMain: boolean;
    inShadow: boolean;
    castLevel: number;
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

/** The level that casts a tree's shadow: the one with the largest share of the hash (the farther level on a tie). */
const castingLevel = (e: LodEdges): number => {
    const share = [e.e0, e.e1 - e.e0, 1 - e.e1];
    let best = 2;
    if (share[1] > share[best]) best = 1;
    if (share[0] > share[best]) best = 0;
    return best;
};

/** The shadow camera of the first light under `scene` that casts shadows, or null when no shadow map is rendered. */
export function findShadowCamera(scene: THREE.Object3D, shadowMapEnabled: boolean): THREE.Camera | null {
    if (!shadowMapEnabled) return null;
    let found: THREE.Camera | null = null;
    scene.traverseVisible(o => {
        const l = o as THREE.Light & { shadow?: THREE.LightShadow };
        if (!found && l.isLight && l.castShadow && l.shadow?.camera) found = l.shadow.camera;
    });
    return found;
}

const keyOf = (r: [number, number]): string => {
    const q = quantiseRange(r);
    return q === null ? 'off' : q === 'full' ? 'full' : `${q[0]}-${q[1]}`;
};

export class TreeLodController {
    readonly psiSeason: number | undefined;
    private readonly trees: TreeState[] = [];
    private readonly opts: Required<Omit<TreeLodOptions, 'now' | 'crownShading'>> & { now: () => number };
    private readonly variants = new Map<THREE.Material, Map<string, THREE.Material>>();
    private forced: 0 | 1 | 2 | undefined;
    private lastMs: number | undefined;
    private readonly frustum = new THREE.Frustum();
    private readonly pv = new THREE.Matrix4();
    private readonly pvShadow = new THREE.Matrix4();
    private readonly shadowFrustum = new THREE.Frustum();
    private readonly tmp = new THREE.Vector3();
    readonly stats: TreeLodStats = { trees: 0, visibleTrees: 0, culledTrees: 0, atLevel: [0, 0, 0], fading: 0, estimatedTriangles: 0, estimatedShadowTriangles: 0, shadowOnlyTrees: 0, commits: 0, deferredCommits: 0, newVariants: 0, demotedTrees: 0, updateMs: 0, crownTrees: 0, crownLeafMeshes: 0 };
    private crown: CrownShadingOptions;
    private crownKey = '';
    private readonly crownVariants = new Map<THREE.Material, THREE.Material>();
    private readonly leafVariantNames: Set<string>;

    /** Finds the trees under `root` (a loaded trees GLB scene) and puts a gate above each level node. Returns nothing to do when there are none. */
    constructor(readonly root: THREE.Object3D, options: TreeLodOptions = {}) {
        this.opts = {
            hysteresisM: options.hysteresisM ?? 2, fadeSeconds: options.fadeSeconds ?? 0.35,
            maxCommitsPerFrame: options.maxCommitsPerFrame ?? 400, maxNewVariantsPerFrame: options.maxNewVariantsPerFrame ?? 6,
            triangleBudget: options.triangleBudget ?? 8_000_000,
            now: options.now ?? (() => performance.now())
        };
        this.psiSeason = (root.userData?.sbTrees as TreesGlbRootExtras | undefined)?.psiSeason;
        this.leafVariantNames = new Set(((root.userData?.sbTrees as TreesGlbRootExtras | undefined)?.clusterLibrary?.variants ?? []).filter(v => v.leavesLevel0 > 0 || v.leavesLevel1 > 0).map(v => v.mesh));
        this.crown = resolveCrownShading(options.crownShading);
        this.crownKey = JSON.stringify(this.crown);
        setCrownShadingUniforms(this.crown);
        root.updateMatrixWorld(true);
        const found: THREE.Object3D[] = [];
        root.traverse(o => { if ((o.userData as { sbTree?: TreeNodeExtras })?.sbTree) found.push(o); });
        for (const node of found) {
            const s = this.adopt(node);
            if (s) this.trees.push(s);
        }
        this.stats.trees = this.trees.length;
    }

    /** The crown shading in force. */
    get crownShading(): Readonly<CrownShadingOptions> { return this.crown; }

    /**
     * Turns the crown shading of the leaves on or off, or changes its factors (a partial override of the defaults). The
     * factors live in uniforms every crown variant shares, so they apply at once; switching it on or off redresses every
     * tree over the next frames. Cheap when nothing changed, so it can be called every frame.
     */
    setCrownShading(options: Partial<CrownShadingOptions> | undefined | null): void {
        const next = resolveCrownShading(options);
        const key = JSON.stringify(next);
        if (key === this.crownKey) return;
        const toggled = next.enabled !== this.crown.enabled;
        this.crown = next;
        this.crownKey = key;
        setCrownShadingUniforms(next);
        if (toggled) for (const t of this.trees) for (const l of t.levels) if (l.applied !== 'off') l.applied = 'redress';
    }

    /** The material a mesh wears in full: its base, or for a leaf mesh with a crown (when crown shading is on) the base's crown variant. */
    private fullMaterialOf(m: THREE.Mesh, base: THREE.Material): THREE.Material {
        if (!this.crown.enabled || !m.userData.sbCrownLeaf || !supportsCrownShading(base)) return base;
        let v = this.crownVariants.get(base);
        if (!v) this.crownVariants.set(base, v = makeCrownVariant(base));
        return v;
    }

    /**
     * Leaf meshes of a level: the leaf-cluster instances (their cluster mesh is a variant of the root's cluster library;
     * twigs are wood) and the node's own primitives its extras list as foliage.
     */
    private leafMeshesOf(obj: THREE.Object3D, lod: TreeLodExtras): THREE.Mesh[] {
        const out: THREE.Mesh[] = [];
        obj.traverse(o => {
            const m = o as THREE.Mesh;
            const cl = (o.userData as { sbCluster?: { clusterMesh?: string } }).sbCluster;
            if (m.isMesh && (m as THREE.InstancedMesh).isInstancedMesh && cl?.clusterMesh && this.leafVariantNames.has(cl.clusterMesh)) out.push(m);
        });
        if (lod.foliagePrimitives?.length) {
            // the node's own primitives: the node itself when it has one, else the loader's group of them (child nodes excluded)
            const prims = (obj as THREE.Mesh).isMesh ? [obj as THREE.Mesh] : obj.children.filter(c => (c as THREE.Mesh).isMesh && !c.userData?.sbCluster && !c.userData?.sbLod) as THREE.Mesh[];
            for (const i of lod.foliagePrimitives) if (prims[i] && !(prims[i] as THREE.InstancedMesh).isInstancedMesh) out.push(prims[i]);
        }
        return out;
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
                if (m.userData.sbLodCast === undefined) m.userData.sbLodCast = m.castShadow;
                meshes.push(m);
            });
            return { gate, meshes, triangles: meshes.reduce((a, m) => a + triangleCountOf(m), 0), applied: 'off' };
        }) as [LevelState, LevelState, LevelState];
        const crown = (node.userData.sbTree as TreeNodeExtras).crown;
        if (crown && crown.radii?.length === 3 && crown.centre?.length === 3) {
            node.updateMatrixWorld(true);
            const nodeInv = node.matrixWorld.clone().invert();
            let leaves = 0;
            byLevel.forEach(l => {
                for (const m of this.leafMeshesOf(l!.obj, l!.lod)) {
                    const meshToTree = nodeInv.clone().multiply(m.matrixWorld);
                    attachCrownAttributes(m, crownQuadricInMeshFrame(crown, meshToTree, l!.lod.level));
                    m.userData.sbCrownLeaf = true;
                    leaves++;
                }
            });
            if (leaves > 0) { this.stats.crownTrees++; this.stats.crownLeafMeshes += leaves; }
        }
        const box = new THREE.Box3().setFromObject(node);
        const sphere = box.isEmpty() ? new THREE.Sphere(node.getWorldPosition(new THREE.Vector3()), 1) : box.getBoundingSphere(new THREE.Sphere());
        const scale = Math.max(1e-6, node.matrixWorld.getMaxScaleOnAxis());
        return {
            node, id: (node.userData.sbTree as TreeNodeExtras).id, bands, levels,
            centerLocal: node.worldToLocal(sphere.center.clone()), radiusLocal: sphere.radius / scale,
            filteredD: undefined, edges: { e0: 0, e1: 0 }, snap: true, culled: false, target: { e0: 0, e1: 0 }, inMain: true, inShadow: false, castLevel: -1, dist: 0, want: ['off', 'off', 'off']
        };
    }

    /** Shows every tree wholly at one level whatever its distance (QA, comparison shots); null returns to distance-driven levels. */
    forceLevel(level: 0 | 1 | 2 | null): void {
        this.forced = level ?? undefined;
        for (const t of this.trees) t.snap = true;
    }

    /** The distance edges a given tree currently has, for diagnostics and tests. */
    edgesOf(index: number): LodEdges { return { ...this.trees[index].edges }; }
    /** Draw state of each level of a tree ('off', 'full' or a quantised range), for diagnostics and tests. */
    stateOf(index: number): [string, string, string] { return this.trees[index].levels.map(l => l.applied) as [string, string, string]; }

    /**
     * `shadowCamera`: the camera of the light that casts the shadows (its matrices as the last shadow pass left them),
     * or null/undefined when no shadow map is rendered.
     */
    update(camera: THREE.Camera, shadowCamera?: THREE.Camera | null): TreeLodStats {
        const t0 = this.opts.now();
        const dt = this.lastMs === undefined ? 1 : Math.min(0.1, Math.max(0, (t0 - this.lastMs) / 1000));
        this.lastMs = t0;
        const maxStep = dt / Math.max(1e-3, this.opts.fadeSeconds);
        camera.updateMatrixWorld();
        this.pv.multiplyMatrices((camera as THREE.PerspectiveCamera).projectionMatrix, camera.matrixWorldInverse);
        this.frustum.setFromProjectionMatrix(this.pv);
        const camPos = camera.getWorldPosition(this.tmp.set(0, 0, 0)).clone();
        let shadowFrustum: THREE.Frustum | undefined;
        if (shadowCamera) {
            shadowCamera.updateMatrixWorld();
            shadowFrustum = this.shadowFrustum;
            shadowFrustum.setFromProjectionMatrix(this.pvShadow.multiplyMatrices((shadowCamera as THREE.OrthographicCamera).projectionMatrix, shadowCamera.matrixWorldInverse));
        }
        const s = this.stats;
        s.visibleTrees = 0; s.culledTrees = 0; s.shadowOnlyTrees = 0; s.estimatedShadowTriangles = 0; s.atLevel = [0, 0, 0]; s.fading = 0; s.estimatedTriangles = 0; s.commits = 0; s.deferredCommits = 0; s.newVariants = 0;
        const dirty: TreeState[] = [];
        const sphere = new THREE.Sphere();
        const visible: TreeState[] = [];
        for (const t of this.trees) {
            t.node.updateWorldMatrix(true, false);
            sphere.center.copy(t.centerLocal).applyMatrix4(t.node.matrixWorld);
            sphere.radius = t.radiusLocal * Math.max(1e-6, t.node.matrixWorld.getMaxScaleOnAxis());
            t.inMain = this.frustum.intersectsSphere(sphere);
            t.inShadow = !!shadowFrustum && shadowFrustum.intersectsSphere(sphere);
            if (!t.inMain && !t.inShadow) {
                t.culled = true; t.snap = true;
                if (t.node.visible) t.node.visible = false;
                s.culledTrees++;
                continue;
            }
            if (!t.node.visible) t.node.visible = true;
            t.dist = Math.max(0, sphere.center.distanceTo(camPos) - sphere.radius);
            t.filteredD = hysteresisDistance(t.snap ? undefined : t.filteredD, t.dist, this.opts.hysteresisM);
            t.culled = false;
            visible.push(t);
        }
        s.visibleTrees = visible.reduce((n, t) => n + (t.inMain ? 1 : 0), 0);
        s.shadowOnlyTrees = visible.length - s.visibleTrees;
        s.culledTrees = this.trees.length - visible.length;
        // Budget, on where the trees are heading (not where the dissolves have got to): when the levels the targets submit (and cast
        // into the shadow map) exceed `triangleBudget`, the trees farthest from the camera give up a level first (leaf clusters to
        // mid, mid to far), one level a pass over at most two passes, until they fit. The near trees keep their detail; a tree
        // only the shadow camera sees goes before any the camera sees.
        const baseTarget = (t: TreeState): LodEdges => {
            const e: LodEdges = this.forced === undefined ? targetEdges(t.filteredD!, t.bands) : { e0: this.forced === 0 ? 1 : 0, e1: this.forced === 2 ? 0 : 1 };
            // a tree only the shadow camera sees never wears the near level: its shadow does not need the small leaves
            return t.inMain ? e : { e0: 0, e1: Math.max(0, e.e1) };
        };
        const submitted = (e: LodEdges, t: TreeState): number => {
            let n = 0;
            for (let k = 0; k < 3; k++) if (quantiseRange(levelRange(e, k as 0 | 1 | 2)) !== null) n += t.levels[k].triangles;
            return n;
        };
        // what the shadow pass draws of a tree: its casting level, in full (the depth pass has no dither)
        const shadowCost = (e: LodEdges, t: TreeState): number => (t.inShadow ? t.levels[castingLevel(e)].triangles : 0);
        const costOf = (e: LodEdges, t: TreeState): number => (t.inMain ? submitted(e, t) : 0) + shadowCost(e, t);
        let total = 0;
        for (const t of visible) { t.target = baseTarget(t); total += costOf(t.target, t); }
        s.demotedTrees = 0;
        if (this.forced === undefined && total > this.opts.triangleBudget) {
            const order = [...visible].sort((a, b) => (b.filteredD! + (b.inMain ? 0 : 1e6)) - (a.filteredD! + (a.inMain ? 0 : 1e6)));
            for (let pass = 0; pass < 2 && total > this.opts.triangleBudget; pass++) {
                for (const t of order) {
                    const e = t.target;
                    if (e.e0 <= 0 && e.e1 <= 0) continue;                       // already wholly the far level
                    const coarser: LodEdges = { e0: 0, e1: e.e0 > 0 ? e.e1 : 0 };
                    const gain = costOf(e, t) - costOf(coarser, t);
                    if (gain <= 0) continue;
                    t.target = coarser; total -= gain; s.demotedTrees++;
                    if (total <= this.opts.triangleBudget) break;
                }
            }
        }
        for (const t of visible) {
            const target = t.target;
            t.edges = t.snap ? target : stepEdges(t.edges, target, maxStep);
            t.snap = false;
            let changed = false;
            for (let k = 0; k < 3; k++) {
                const lvl = t.levels[k];
                // a mesh whose material was swapped behind our back (the clay pass, an override) wears its new base plain: dress it again
                if (lvl.applied !== 'off' && lvl.applied !== 'redress') {
                    for (const m of lvl.meshes) if (m.userData.sbLodWorn !== undefined && m.material !== m.userData.sbLodWorn && !isStagedMaterial(m.material as THREE.Material)) { lvl.applied = 'redress'; break; }
                }
                const w = keyOf(levelRange(t.edges, k as 0 | 1 | 2));
                t.want[k] = w;
                if (w !== t.levels[k].applied) changed = true;
            }
            s.estimatedShadowTriangles += shadowCost(t.edges, t);
            const cast = castingLevel(t.edges);
            if (cast !== t.castLevel) {
                t.castLevel = cast;
                for (let k = 0; k < 3; k++) for (const m of t.levels[k].meshes) m.castShadow = k === cast && m.userData.sbLodCast !== false;
            }
            if (t.inMain) s.estimatedTriangles += submitted(t.edges, t);     // what is submitted: a level in a dissolve still draws all of its triangles (the dither drops them in the shader)
            if (!t.inMain) { if (changed) dirty.push(t); continue; }
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
            const full = this.fullMaterialOf(m, base);
            if (want === 'full') { dressed.push([m, full]); continue; }
            const inst = !!(m as THREE.InstancedMesh).isInstancedMesh;
            const key = `${want}|${inst ? 'I' : 'P'}`;
            let perBase = this.variants.get(full);
            if (!perBase) this.variants.set(full, perBase = new Map());
            let v = perBase.get(key);
            if (!v) {
                if (variantBudget - made <= 0) return { ok: false, made };
                const [lo, hi] = want.split('-').map(Number);
                v = makeFadeVariant(full, lo, hi, inst);
                perBase.set(key, v);
                made++;
            }
            dressed.push([m, v]);
        }
        for (const [m, mat] of dressed) { if (m.material !== mat) m.material = mat; m.userData.sbLodWorn = mat; }
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
                    delete m.userData.sbLodWorn;
                    if (m.userData.sbLodCast !== undefined) { m.castShadow = m.userData.sbLodCast as boolean; delete m.userData.sbLodCast; }
                }
                const child = l.gate.children[0];
                if (child) t.node.add(child);
                t.node.remove(l.gate);
            }
            t.node.visible = true;
        }
        for (const per of this.variants.values()) for (const v of per.values()) v.dispose();
        this.variants.clear();
        for (const v of this.crownVariants.values()) v.dispose();
        this.crownVariants.clear();
        this.trees.length = 0;
    }
}
