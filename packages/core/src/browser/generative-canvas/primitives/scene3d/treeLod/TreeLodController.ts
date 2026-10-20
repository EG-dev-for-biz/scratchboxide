/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/


import * as THREE from 'three';
import { treesLodLevelCount, type TreeLodExtras, type TreeNodeExtras, type TreesGlbRootExtras } from '../../../../../common/spatial/staged-location-contracts';
import { isStagedMaterial } from '../stagedBuild/revealMaterial';
import { makeFadeVariant } from './treeLodFade';
import { crownCardClayMaterial, crownCardMaskedMaterial, crownCardsOf } from './treeCrownCards';
import { sharedTreeClayMaterial } from '../clayRenderMode';
import {
    allocateCrownLobes, attachCrownAttributes, attachCrownInstanceField, breakupDepthMaterial, breakupDistanceMaterial, crownLobesInMeshFrame, crownQuadricInMeshFrame, isBreakupDepthMaterial,
    makeCrownVariant, releaseCrownLobeAtlas, resolveCrownShading, retainCrownLobeAtlas,
    setCrownShadingUniforms, supportsCrownShading, type CrownShadingInput, type CrownShadingOptions
} from './treeCrownShading';
import {
    DEFAULT_TREE_LOD_VIEW, DEFAULT_TREE_TRIANGLE_BUDGET, FADE_STEPS, crownSlotOf, blurDemotionLevels, demoteEdges, dominantLevel, edgesAtLevel, edgesNoFinerThan, finestLevel, fovealWeight, hysteresisDistanceRelative,
    levelRange, pixelThresholds, projectedHeightPx, quantiseRange, resolveTreeLodView, screenEquivalentDistance, sphereFovealRadius, stepEdges, targetEdges,
    type LodBand, type LodEdges, type TreeLodViewInput, type TreeLodViewOptions
} from './treeLodMath';
import { circleOfConfusionPx } from '../viewportOptics';

/**
 * Per-tree level of detail for a trees GLB that follows the tree LOD contract (staged-location-contracts.ts): every
 * node with extras `sbTree` has one child `sbLod` per level, four in a trees-lod/2 file (0 near, 1 near-mid, 2 mid, 3 far)
 * and three in a trees-lod/1 file (0 near, 1 mid, 2 far), every level but the far one holding instanced leaf clusters
 * (EXT_mesh_gpu_instancing, which GLTFLoader turns into THREE.InstancedMesh). Everything below works on a tree's own
 * number of levels; the crown shading maps a level to its detail slot (near, near-mid, mid, far), so an old file's mid
 * level is shaded as mid.
 *
 * Every frame, before the render: each tree is tested against the camera frustum (a tree outside it is hidden with one
 * write and costs nothing else); a tree inside gets its distance (to the nearest point of its bounding sphere),
 * filtered by a hysteresis dead band, mapped to the cut edges that share the stable hash between the levels
 * (treeLodMath.ts), and the edges move toward that target at a bounded rate, so a level crossfades in over
 * `fadeSeconds` even when the camera jumps. A level whose share is empty is hidden; a level that has the whole share
 * wears the plain material; a level in a crossfade wears a quantised dither variant of it (treeLodFade.ts).
 *
 * Work is bounded per frame: at most `maxCommitsPerFrame` trees change their drawn state (most important first, the rest
 * keep their previous state one more frame) and `maxNewVariantsPerFrame` material variants are made; when the triangles the
 * trees are heading for (main pass and shadow pass) exceed `triangleBudget` the least important trees give up a level first,
 * and while dissolves in flight would overshoot it the least important trees wait to start theirs.
 *
 * A still camera finishes its dissolves: once it has not moved for `settleAfterStillSeconds`, every tree inside a band overlap
 * crossfades to its dominant level and holds it (with a dead band), so a still frame shows no dither.
 *
 * What the camera sees decides the level (TreeLodViewOptions, on by default; `screen.enabled: false` goes back to metre
 * bands for comparison):
 *   - on-screen size: the tree's distance is mapped to the reference-lens distance with the same projected height
 *     (treeLodMath.ts screenEquivalentDistance), so the file's metre bands become pixel thresholds; a long lens keeps
 *     leaves on distant trees, a wide one drops them sooner, and at the reference lens nothing changes;
 *   - foveal weight: the projected height is weighted by the tree's place in the frame (an ellipse around the view centre,
 *     or the focus point when depth of field is on), so trees toward the centre keep detail farther than trees at the edges,
 *     whatever the budget;
 *   - depth of field: a tree whose nearest point to the plane of focus blurs by more than `blur.startPx` (radius, the same
 *     thin-lens circle of confusion the viewport draws, viewportOptics.ts) is demoted by up to `blur.maxLevels` levels,
 *     continuously, so a rack focus crossfades; the focus object and trees spanning the plane of focus are never demoted;
 *   - budget: importance = projected height x foveal weight; trees only the shadow camera sees go first.
 * `explain(i)` gives each tree's reasons for its level in the last frame.
 *
 * Wood and leaves share whatever material the mesh's base says: `mesh.userData.sbLodBase` (set by clayRenderMode to
 * the one shared studio-clay material), else the material the loader gave it. A mesh the staged-build hook has
 * dressed (reveal, provenance) is left to the hook, and its tree switches level without a dissolve meanwhile.
 * Shadows: the depth pass has no dither, so every level of a tree that is drawn into the shadow map is drawn in full. Each
 * tree therefore lets only the level with the largest share cast (the others have castShadow off), a tree that only the
 * shadow camera sees stays drawable at the mid or far level (never the leaf-heavy near or near-mid level) so its shadow still falls into
 * view, and the triangle budget counts the shadow pass beside the main pass when a shadow camera is given.
 * Trees are labelled by the layer ("grown to the measured crown") at every level; nothing here names a species.
 *
 * Crown shading (treeCrownShading.ts): a tree whose extras carry its crown ellipsoid has its leaf meshes (the leaf-cluster
 * instances of every level but the far one, named by the root's cluster library, and the far primitives its extras list as foliage;
 * never wood or twigs) wear a crown variant of their base, and the dither variants of a leaf mesh are made from that
 * variant. On by default; `setCrownShading` turns it off for comparison or changes its factors. A mesh whose material was
 * swapped behind the controller's back (the clay pass, a material override) is dressed again at the next frame.
 * The crown's breakup (treeCrownShading.ts CrownBreakupOptions: holes toward the rim, pockets, clump value) lives in the
 * same variant, and every leaf mesh with a crown draws its shadow with the breakup's depth materials, so the shadow pass
 * discards the same holes. `setCrownShading({ breakup: { enabled: false } })` turns it off for comparison.
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
    /** Drawn triangles per frame the estimate may reach before levels are pushed farther away (default DEFAULT_TREE_TRIANGLE_BUDGET). */
    triangleBudget?: number;
    /**
     * Seconds the camera must hold still before every tree in a distance crossfade settles on its dominant level (a short timed
     * crossfade), so a still frame shows no dither; the tree keeps that level while the camera moves until its own share of the
     * distance crossfade falls below `settleReleaseShare`. 0 turns settling off (trees stay mid-dissolve inside a band overlap).
     */
    settleAfterStillSeconds?: number;
    /** Share of the distance crossfade a settled level must keep to be held (dead band against flicker). */
    settleReleaseShare?: number;
    /**
     * How far (share of the trees' budget) the triangles drawn while crossfades are in flight (both levels of a dissolving tree)
     * may exceed the budget before the least important trees wait to start a dissolve to a finer level (demotions never wait). With
     * no dissolve running, the most important one always starts.
     */
    inFlightOvershoot?: number;
    /** Clock in ms, replaceable in tests. */
    now?: () => number;
    /** Crown shading of the leaves (defaults in treeCrownShading.ts DEFAULT_CROWN_SHADING, per detail slot near / near-mid / mid / far). */
    crownShading?: CrownShadingInput;
    /** How the camera's view chooses the levels (defaults DEFAULT_TREE_LOD_VIEW). */
    view?: TreeLodViewInput;
}

/** The view options (common/spatial/tree-lod-math.ts, shared with the photo-match evaluator's still-frame tree render). */
export { DEFAULT_TREE_LOD_VIEW, resolveTreeLodView, type TreeLodViewInput, type TreeLodViewOptions };

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** What the viewport knows about the frame beyond the camera. */
export interface TreeLodFrame {
    /** Height of the drawn frame in pixels (the reference height when omitted). */
    heightPx?: number;
    /** Overscan the lens distortion renders (>= 1): trees in the widened margin are pulled into view, so they are kept. */
    overscan?: number;
    /** Depth of field as drawn (null/undefined: none). */
    dof?: { focalLengthMm: number; apertureFStop: number; focusM: number; focusPoint?: THREE.Vector3 | null; focusObject?: THREE.Object3D | null; maxBlurRadiusPx?: number } | null;
    /**
     * Triangles the rest of the frame draws (buildings, context, the hero, other trees GLBs; main pass plus shadow pass),
     * taken off `triangleBudget` before the trees are fitted to it: the scene shares one budget, so trees give up levels
     * when the city is heavy. Nothing else is ever demoted for it (the hero and the focus object keep full detail).
     */
    reservedTriangles?: number;
    /**
     * Share (0..1] of `triangleBudget` in force this frame: the viewport lowers it when the GPU frame time stays over its target
     * (adaptiveTreeBudget.ts) and raises it back slowly. 1 when omitted.
     */
    budgetScale?: number;
}

/** Why a tree has its level in the last frame. */
export interface TreeLodReason {
    inView: boolean; culled: boolean;
    rangeM: number; sizeM: number;
    /** Projected height (px) on the frame, and times the foveal weight. */
    projectedPx: number; fovealWeight: number; importance: number;
    /** Reference-lens distance the bands were read at (after hysteresis). */
    equivalentDistM: number;
    /** The tree's pixel thresholds at the reference lens: [enter, leave] per level. */
    thresholdsPx: Array<[number, number]>;
    /** The blur radius (px), the continuous demotion it calls for, and the whole levels applied (held with a dead band). */
    blurRadiusPx: number; blurDemotion: number; blurLevelsApplied: number; focusProtected: boolean;
    budgetDemotions: number;
    /** Level with the largest share of the hash now. */
    level: number;
}

export interface TreeLodStats {
    trees: number;
    /** Trees inside the frustum this frame. */
    visibleTrees: number;
    culledTrees: number;
    /** Visible trees whose share is wholly one level (by the tree's own level number: 0..3, or 0..2 in a trees-lod/1 file), and those in a crossfade. */
    atLevel: [number, number, number, number];
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
    /** Trees the budget held at least one level below where their distance puts them. */
    demotedTrees: number;
    /** Trees whose dissolve the budget let wait this frame, so the levels drawn in flight stay near the budget. */
    budgetDeferredStarts: number;
    /** The camera has held still for `settleAfterStillSeconds`, and the trees holding a settled whole level. */
    still: boolean;
    settledTrees: number;
    /** The one triangle budget of the frame, what the rest of the scene took of it, and what was left for these trees. */
    triangleBudget: number;
    /** The share of the configured budget in force (below 1 when the viewport lowered it for GPU time). */
    budgetScale: number;
    reservedTriangles: number;
    treeBudget: number;
    /** Levels chosen by on-screen size (false: metre bands). */
    screenSpace: boolean;
    /** Trees demoted for depth-of-field blur, and trees kept from it as the focus (or spanning the plane of focus). */
    blurDemotedTrees: number;
    focusProtectedTrees: number;
    /** Where the foveal weight is centred (NDC), the frame height and vertical FOV used. */
    fovealCentreNdc: [number, number];
    frameHeightPx: number;
    fovDeg: number;
    /** JS time spent in update() (ms). */
    updateMs: number;
    /** Trees whose leaves carry a crown (crown shading applies to them when it is on). */
    crownTrees: number;
    /** Leaf meshes that carry crown attributes. */
    crownLeafMeshes: number;
    /** Trees whose crown has lobes, and their leaf meshes shaded by them. */
    crownLobeTrees: number;
    crownLobeMeshes: number;
    /** Leaf meshes of a lobed crown that keep the ellipsoid because their frame is not a similarity of the tree's. */
    crownLobeFallbackMeshes: number;
}

interface LevelState { index: number; gate: THREE.Object3D; meshes: THREE.Mesh[]; triangles: number; applied: string }
interface TreeState {
    node: THREE.Object3D;
    id: number;
    bands: LodBand[];
    levels: LevelState[];
    centerLocal: THREE.Vector3;
    radiusLocal: number;
    /** Crown height (or bounding diameter) in the node's frame. */
    sizeLocal: number;
    reason: TreeLodReason;
    filteredD: number | undefined;
    edges: LodEdges;
    snap: boolean;
    culled: boolean;
    target: LodEdges;
    /** This frame's target before the budget. */
    base: LodEdges;
    /** The whole level a still camera settled this tree on (undefined: follows the distance crossfade). */
    held: number | undefined;
    /** Budget demotions of the previous frame (the budget's hysteresis), and whether this frame's dissolve waits. */
    prevDemotions: number;
    deferStart: boolean;
    inMain: boolean;
    inShadow: boolean;
    castLevel: number;
    // per-frame scratch
    dist: number;
    importance: number;
    blurLevels: number;
    want: string[];
}

const triangleCountOf = (m: THREE.Mesh): number => {
    const g = m.geometry as THREE.BufferGeometry | undefined;
    if (!g) return 0;
    const per = g.index ? g.index.count / 3 : (g.getAttribute('position')?.count ?? 0) / 3;
    return per * ((m as THREE.InstancedMesh).isInstancedMesh ? (m as THREE.InstancedMesh).count : 1);
};

/** Debug tints per detail slot: near, near-mid, mid, far. */
const TINTS = [0x3fbf4a, 0xd9d23a, 0xe8892c, 0xd8433b];

/** The level that casts a tree's shadow: the one with the largest share of the hash (the farther level on a tie). */
const castingLevel = dominantLevel;

/** The crown-shading detail slot of a level (treeLodMath.ts crownSlotOf). */
export { crownSlotOf };

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

/** The number of `sbLod` children of the first tree node under `root` (undefined when there is none). */
function levelsOfFirstTree(root: THREE.Object3D): number | undefined {
    let n: number | undefined;
    root.traverse(o => {
        if (n === undefined && (o.userData as { sbTree?: TreeNodeExtras })?.sbTree) n = o.children.filter(c => (c.userData as { sbLod?: TreeLodExtras })?.sbLod).length || undefined;
    });
    return n;
}

const keyOf = (r: [number, number]): string => {
    const q = quantiseRange(r);
    return q === null ? 'off' : q === 'full' ? 'full' : `${q[0]}-${q[1]}`;
};

/** Whether the camera moved between two frames' signatures (world matrix 16, projection 16, frame height). */
function cameraMoved(a: readonly number[], b: readonly number[]): boolean {
    for (let i = 0; i < 16; i++) {
        const tol = i >= 12 && i <= 14 ? 1e-3 : 1e-5;                  // translation (m), rotation and scale
        if (Math.abs(a[i] - b[i]) > tol) return true;
    }
    for (let i = 16; i < 32; i++) if (Math.abs(a[i] - b[i]) > 1e-6 * Math.max(1, Math.abs(a[i]))) return true;
    return a[32] !== b[32];
}

/** Whether edges put the tree wholly at one level. */
const isWhole = (e: LodEdges): boolean => e.every(x => x <= 1e-9 || x >= 1 - 1e-9);
/** Edges with the finest level given up `k` times (each time its share goes to the next coarser level). */
function coarserBy(e: LodEdges, k: number): LodEdges {
    let out = e;
    for (let i = 0; i < k && finestLevel(out) < out.length; i++) out = edgesNoFinerThan(out, finestLevel(out) + 1);
    return out;
}
const sameEdges = (a: LodEdges, b: LodEdges): boolean => a.every((x, k) => Math.abs(x - b[k]) <= 1e-9);

/** Share of the hash a level draws. */
const shareOf = (e: LodEdges, level: number): number => { const [lo, hi] = levelRange(e, level); return Math.max(0, hi - lo); };

/** How near a tie (share either side of a half) a held level may be and still be kept when the camera comes to rest. */
const SETTLE_TIE_SHARE = 0.1;

/** Held-down trees the order step (3) may consider per frame. */
const MAX_BUDGET_SWAPS = 32;

/** Importance ratio a tree the budget left whole keeps over one it held down (so two trees of near-equal importance do not swap every frame). */
const BUDGET_STICKINESS = 0.1;
/** Room (share of the budget) that must be left before a tree the budget held down takes a level back. */
const BUDGET_RELEASE_MARGIN = 0.02;

export class TreeLodController {
    readonly psiSeason: number | undefined;
    private readonly trees: TreeState[] = [];
    private readonly opts: Required<Omit<TreeLodOptions, 'now' | 'crownShading' | 'view'>> & { now: () => number };
    private readonly variants = new Map<THREE.Material, Map<string, THREE.Material>>();
    private forced: number | undefined;
    private readonly levelCount: number;
    private lastMs: number | undefined;
    private readonly frustum = new THREE.Frustum();
    private readonly pv = new THREE.Matrix4();
    private readonly pvShadow = new THREE.Matrix4();
    private readonly shadowFrustum = new THREE.Frustum();
    private readonly tmp = new THREE.Vector3();
    readonly stats: TreeLodStats = {
        trees: 0, visibleTrees: 0, culledTrees: 0, atLevel: [0, 0, 0, 0], fading: 0, estimatedTriangles: 0, estimatedShadowTriangles: 0, shadowOnlyTrees: 0, commits: 0, deferredCommits: 0, newVariants: 0,
        demotedTrees: 0, budgetDeferredStarts: 0, still: false, settledTrees: 0, triangleBudget: 0, budgetScale: 1, reservedTriangles: 0, treeBudget: 0, screenSpace: true, blurDemotedTrees: 0, focusProtectedTrees: 0, fovealCentreNdc: [0, 0], frameHeightPx: 0, fovDeg: 0,
        updateMs: 0, crownTrees: 0, crownLeafMeshes: 0, crownLobeTrees: 0, crownLobeMeshes: 0, crownLobeFallbackMeshes: 0
    };
    private view: TreeLodViewOptions;
    private viewKey = '';
    private readonly tintVariants = new Map<THREE.Material, THREE.Material[]>();
    private readonly pvWide = new THREE.Matrix4();
    private readonly projWide = new THREE.Matrix4();
    private readonly ndc = new THREE.Vector4();
    private crown: CrownShadingOptions;
    private crownKey = '';
    private readonly crownVariants = new Map<THREE.Material, THREE.Material>();
    private readonly leafVariantNames: Set<string>;
    /** The root's crown cards (the mid level drawn as cut-out cards) and their library meshes. */
    private readonly crownCards: ReturnType<typeof crownCardsOf>;
    private readonly cardMeshNames: Set<string>;
    /** The camera of the last frame (world matrix, projection, frame height) and when it last moved, for settling at a still camera. */
    private camSig: number[] | null = null;
    private movedAtMs = -Infinity;
    private wasStill = false;

    /** Finds the trees under `root` (a loaded trees GLB scene) and puts a gate above each level node. Returns nothing to do when there are none. */
    constructor(readonly root: THREE.Object3D, options: TreeLodOptions = {}) {
        this.opts = {
            hysteresisM: options.hysteresisM ?? 2, fadeSeconds: options.fadeSeconds ?? 0.35,
            maxCommitsPerFrame: options.maxCommitsPerFrame ?? 400, maxNewVariantsPerFrame: options.maxNewVariantsPerFrame ?? 6,
            triangleBudget: options.triangleBudget ?? DEFAULT_TREE_TRIANGLE_BUDGET,
            settleAfterStillSeconds: options.settleAfterStillSeconds ?? 0.5, settleReleaseShare: options.settleReleaseShare ?? 0.25,
            inFlightOvershoot: options.inFlightOvershoot ?? 0.1,
            now: options.now ?? (() => performance.now())
        };
        this.view = resolveTreeLodView(options.view);
        if (finite(options.view?.triangleBudget) && options.view!.triangleBudget! > 0) this.opts.triangleBudget = options.view!.triangleBudget!;
        this.viewKey = JSON.stringify(options.view ?? null);
        this.psiSeason = (root.userData?.sbTrees as TreesGlbRootExtras | undefined)?.psiSeason;
        const rootExtras = root.userData?.sbTrees as TreesGlbRootExtras | undefined;
        // the schema names the level count; a root without it (extras the loader did not carry to the scene) counts a tree's levels
        this.levelCount = rootExtras?.schema ? treesLodLevelCount(rootExtras.schema) : levelsOfFirstTree(root) ?? treesLodLevelCount(undefined);
        this.leafVariantNames = new Set((rootExtras?.clusterLibrary?.variants ?? []).filter(v => v.leavesLevel0 > 0 || (v.leavesNearMid ?? 0) > 0 || v.leavesLevel1 > 0).map(v => v.mesh));
        this.crownCards = crownCardsOf(rootExtras);
        this.cardMeshNames = new Set(this.crownCards?.meshes ?? []);
        this.crown = resolveCrownShading(options.crownShading);
        this.crownKey = JSON.stringify(this.crown);
        setCrownShadingUniforms(this.crown);
        retainCrownLobeAtlas();
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
    setCrownShading(options: CrownShadingInput | undefined | null): void {
        const next = resolveCrownShading(options);
        const key = JSON.stringify(next);
        if (key === this.crownKey) return;
        const toggled = next.enabled !== this.crown.enabled;
        this.crown = next;
        this.crownKey = key;
        setCrownShadingUniforms(next);
        if (toggled) for (const t of this.trees) for (const l of t.levels) if (l.applied !== 'off') l.applied = 'redress';
    }

    /** The view options in force. */
    get viewOptions(): Readonly<TreeLodViewOptions> { return this.view; }

    /**
     * Changes how the camera's view chooses the levels (a partial override of DEFAULT_TREE_LOD_VIEW; null = the defaults).
     * Cheap when nothing changed, so it can be called every frame; a changed lens or weight retargets through the usual crossfade.
     */
    setView(input: TreeLodViewInput | undefined | null): void {
        const key = JSON.stringify(input ?? null);
        if (key === this.viewKey) return;
        this.viewKey = key;
        const next = resolveTreeLodView(input);
        const tintToggled = next.debugTint !== this.view.debugTint;
        this.view = next;
        if (finite(input?.triangleBudget) && input!.triangleBudget! > 0) this.opts.triangleBudget = input!.triangleBudget!;
        if (tintToggled) for (const t of this.trees) for (const l of t.levels) if (l.applied !== 'off') l.applied = 'redress';
    }

    /** The material a mesh wears in full: its base, or for a leaf mesh with a crown (when crown shading is on) the base's crown variant; with the debug tint, the level's tint of the base. */
    private fullMaterialOf(m: THREE.Mesh, base: THREE.Material, level: number): THREE.Material {
        if (this.view.debugTint) return this.tintOf(base, level);
        if (!this.crown.enabled || !m.userData.sbCrownLeaf || !supportsCrownShading(base)) return base;
        let v = this.crownVariants.get(base);
        if (!v) this.crownVariants.set(base, v = makeCrownVariant(base));
        return v;
    }

    private tintOf(base: THREE.Material, level: number): THREE.Material {
        let per = this.tintVariants.get(base);
        if (!per) this.tintVariants.set(base, per = []);
        let v = per[level];
        if (!v) {
            v = base.clone();
            const slot = crownSlotOf(level, this.levelCount);
            const c = (v as THREE.MeshStandardMaterial).color;
            if (c?.isColor) c.setHex(TINTS[slot]);
            v.userData = { ...v.userData, sbLodTint: slot };
            per[level] = v;
        }
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
        const n = this.levelCount;
        const byLevel: Array<{ obj: THREE.Object3D; lod: TreeLodExtras } | undefined> = new Array(n).fill(undefined);
        for (const c of node.children) {
            const lod = (c.userData as { sbLod?: TreeLodExtras })?.sbLod;
            if (lod && lod.level >= 0 && lod.level < n) byLevel[lod.level] = { obj: c, lod };
        }
        if (byLevel.some(l => !l)) return undefined;
        const bands: LodBand[] = byLevel.map(l => ({ minDistM: l!.lod.minDistM, maxDistM: l!.lod.maxDistM, fadeM: l!.lod.fadeM }));
        const levels: LevelState[] = byLevel.map(l => {
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
                // a crown card: cut out by the card atlas's leaves whatever it wears (its own clay; its base masked until textured)
                const card = (m.userData as { sbCluster?: { clusterMesh?: string } }).sbCluster?.clusterMesh;
                if (this.crownCards && card && this.cardMeshNames.has(card) && !m.userData.sbCrownCard) {
                    const clay = crownCardClayMaterial(this.crownCards);
                    m.userData.sbCrownCard = true;
                    m.userData.sbTreeClay = clay;
                    const base = m.userData.sbLodBase as THREE.Material | undefined;
                    if (base) {
                        const cut = base === sharedTreeClayMaterial() ? clay : crownCardMaskedMaterial(base, this.crownCards);
                        m.userData.sbLodBase = cut;
                        m.material = cut;
                    }
                    // what clay mode will restore (clayRenderMode's sbClayOriginalMaterial) is cut out too
                    const original = m.userData.sbClayOriginalMaterial as THREE.Material | undefined;
                    if (original && original !== clay) m.userData.sbClayOriginalMaterial = crownCardMaskedMaterial(original, this.crownCards);
                }
                if (m.userData.sbLodCast === undefined) m.userData.sbLodCast = m.castShadow;
                meshes.push(m);
            });
            return { index: l!.lod.level, gate, meshes, triangles: meshes.reduce((a, m) => a + triangleCountOf(m), 0), applied: 'off' };
        });
        const crown = (node.userData.sbTree as TreeNodeExtras).crown;
        if (crown && crown.radii?.length === 3 && crown.centre?.length === 3) {
            node.updateMatrixWorld(true);
            const nodeInv = node.matrixWorld.clone().invert();
            // the breakup's metric: the crown's mean radius in the tree frame's metres, and the world units a metre is
            const scale = { crownRadiusM: (crown.radii[0] + crown.radii[1] + crown.radii[2]) / 3, worldPerMetre: Math.max(1e-9, node.matrixWorld.getMaxScaleOnAxis()) };
            let leaves = 0, lobed = 0;
            byLevel.forEach(l => {
                for (const m of this.leafMeshesOf(l!.obj, l!.lod)) {
                    const meshToTree = nodeInv.clone().multiply(m.matrixWorld);
                    // the lobes in this mesh's frame, written once per mesh into the shared atlas
                    const lb = crownLobesInMeshFrame(crown, meshToTree);
                    let block: [number, number, number, number] = [0, 0, 0, 0];
                    if (lb) { block = [allocateCrownLobes(lb.lobes), lb.lobes.length, lb.blend, lb.meanRadius]; lobed++; }
                    else if (crown.lobes?.length) this.stats.crownLobeFallbackMeshes++;
                    attachCrownAttributes(m, crownQuadricInMeshFrame(crown, meshToTree, crownSlotOf(l!.lod.level, n)), block, scale);
                    // the shadow pass draws the same holes (dappled shadows): the renderer's depth materials plus the breakup
                    if (m.customDepthMaterial === undefined) m.customDepthMaterial = breakupDepthMaterial();
                    if (m.customDistanceMaterial === undefined) m.customDistanceMaterial = breakupDistanceMaterial();
                    if (lb && (m as THREE.InstancedMesh).isInstancedMesh) attachCrownInstanceField(m as THREE.InstancedMesh, lb.lobes, lb.blend, lb.meanRadius);
                    m.userData.sbCrownLeaf = true;
                    leaves++;
                }
            });
            if (leaves > 0) { this.stats.crownTrees++; this.stats.crownLeafMeshes += leaves; }
            if (lobed > 0) { this.stats.crownLobeTrees++; this.stats.crownLobeMeshes += lobed; }
        }
        const box = new THREE.Box3().setFromObject(node);
        const sphere = box.isEmpty() ? new THREE.Sphere(node.getWorldPosition(new THREE.Vector3()), 1) : box.getBoundingSphere(new THREE.Sphere());
        const scale = Math.max(1e-6, node.matrixWorld.getMaxScaleOnAxis());
        const radiusLocal = sphere.radius / scale;
        // the crown's height in the node's frame (its radii are metres of that frame), else the bounding diameter
        const sizeLocal = crown?.radii?.length === 3 && crown.radii[1] > 0 ? 2 * crown.radii[1] : 2 * radiusLocal;
        return {
            node, id: (node.userData.sbTree as TreeNodeExtras).id, bands, levels,
            centerLocal: node.worldToLocal(sphere.center.clone()), radiusLocal, sizeLocal,
            reason: {
                inView: false, culled: true, rangeM: 0, sizeM: sizeLocal, projectedPx: 0, fovealWeight: 1, importance: 0, equivalentDistM: 0,
                thresholdsPx: [], blurRadiusPx: 0, blurDemotion: 0, blurLevelsApplied: 0, focusProtected: false, budgetDemotions: 0, level: n - 1
            },
            importance: 0, blurLevels: 0,
            filteredD: undefined, edges: edgesAtLevel(n - 1, n), snap: true, culled: false, target: edgesAtLevel(n - 1, n), base: edgesAtLevel(n - 1, n), held: undefined, prevDemotions: 0, deferStart: false, inMain: true, inShadow: false, castLevel: -1, dist: 0, want: new Array(n).fill('off')
        };
    }

    /**
     * Shows every tree wholly at one level whatever its distance (QA, comparison shots), in the file's level numbering (a
     * level past a tree's last is its last); null returns to distance-driven levels.
     */
    forceLevel(level: number | null): void {
        this.forced = level ?? undefined;
        for (const t of this.trees) t.snap = true;
    }

    /** Why a tree has its level in the last frame (size, foveal weight, blur, budget), for the stats overlay, diagnostics and tests. */
    explain(index: number): TreeLodReason {
        const t = this.trees[index];
        const r = t.reason;
        return { ...r, thresholdsPx: pixelThresholds(t.bands, r.sizeM, this.view.screen) };
    }

    /** The distance edges a given tree currently has, for diagnostics and tests. */
    edgesOf(index: number): LodEdges { return [...this.trees[index].edges]; }
    /** Draw state of each level of a tree ('off', 'full' or a quantised range), for diagnostics and tests. */
    stateOf(index: number): string[] { return this.trees[index].levels.map(l => l.applied); }
    /** Number of levels each tree has (4 for a trees-lod/2 file, 3 for trees-lod/1). */
    get levelsPerTree(): number { return this.levelCount; }

    /**
     * `shadowCamera`: the camera of the light that casts the shadows (its matrices as the last shadow pass left them),
     * or null/undefined when no shadow map is rendered. `frame`: the drawn frame's height, the distortion overscan and the
     * depth of field, when the viewport has them.
     */
    update(camera: THREE.Camera, shadowCamera?: THREE.Camera | null, frame?: TreeLodFrame): TreeLodStats {
        const t0 = this.opts.now();
        const dt = this.lastMs === undefined ? 1 : Math.min(0.1, Math.max(0, (t0 - this.lastMs) / 1000));
        this.lastMs = t0;
        const maxStep = dt / Math.max(1e-3, this.opts.fadeSeconds);
        camera.updateMatrixWorld();
        const persp = (camera as THREE.PerspectiveCamera).isPerspectiveCamera ? camera as THREE.PerspectiveCamera : null;
        const proj = (camera as THREE.PerspectiveCamera).projectionMatrix;
        this.pv.multiplyMatrices(proj, camera.matrixWorldInverse);
        // with lens distortion the scene is drawn into a frustum widened by the overscan, and barrel distortion pulls that margin
        // into the frame: a tree there is drawn, so it is not culled
        const overscan = finite(frame?.overscan) && frame!.overscan! > 1 ? frame!.overscan! : 1;
        if (overscan > 1) {
            this.projWide.copy(proj);
            this.projWide.elements[0] /= overscan; this.projWide.elements[5] /= overscan;
            this.frustum.setFromProjectionMatrix(this.pvWide.multiplyMatrices(this.projWide, camera.matrixWorldInverse));
        } else {
            this.frustum.setFromProjectionMatrix(this.pv);
        }
        const camPos = camera.getWorldPosition(this.tmp.set(0, 0, 0)).clone();
        let shadowFrustum: THREE.Frustum | undefined;
        if (shadowCamera) {
            shadowCamera.updateMatrixWorld();
            shadowFrustum = this.shadowFrustum;
            shadowFrustum.setFromProjectionMatrix(this.pvShadow.multiplyMatrices((shadowCamera as THREE.OrthographicCamera).projectionMatrix, shadowCamera.matrixWorldInverse));
        }
        const v = this.view;
        const screen = v.screen.enabled && !!persp && this.forced === undefined;
        const heightPx = finite(frame?.heightPx) && frame!.heightPx! > 0 ? frame!.heightPx! : v.screen.referenceHeightPx;
        // the lens's vertical field of view, narrowed by the camera's zoom
        const fovDeg = persp ? (2 * Math.atan(Math.tan(THREE.MathUtils.degToRad(persp.fov) / 2) / Math.max(1e-6, persp.zoom || 1)) * 180) / Math.PI : v.screen.referenceFovDeg;
        const dof = v.blur.enabled && persp && frame?.dof && finite(frame.dof.focusM) && frame.dof.focusM > 0 ? frame.dof : null;
        // the foveal centre: the view centre, or the focus point when depth of field is drawn and it is in front of the camera
        let cx = 0, cy = 0;
        if (v.foveal.followFocus && dof?.focusPoint) {
            this.ndc.set(dof.focusPoint.x, dof.focusPoint.y, dof.focusPoint.z, 1).applyMatrix4(this.pv);
            if (this.ndc.w > 1e-6) { cx = Math.max(-1, Math.min(1, this.ndc.x / this.ndc.w)); cy = Math.max(-1, Math.min(1, this.ndc.y / this.ndc.w)); }
        }
        // Still camera: nothing in the view moved since the last frame (1 mm, about 0.0006 degrees, the lens and the frame height).
        const sig = [...camera.matrixWorld.elements, ...proj.elements, heightPx];
        if (!this.camSig || cameraMoved(this.camSig, sig)) this.movedAtMs = t0;
        this.camSig = sig;
        const settleMs = this.opts.settleAfterStillSeconds * 1000;
        const still = settleMs > 0 && this.forced === undefined && t0 - this.movedAtMs >= settleMs;
        // the frame the camera comes to rest: every settled level is checked against the new view (a level held through a move
        // may no longer be the tree's dominant one)
        const stillOnset = still && !this.wasStill;
        this.wasStill = still;
        const s = this.stats;
        s.still = still; s.settledTrees = 0; s.budgetDeferredStarts = 0;
        s.visibleTrees = 0; s.culledTrees = 0; s.shadowOnlyTrees = 0; s.estimatedShadowTriangles = 0; s.atLevel = [0, 0, 0, 0]; s.fading = 0; s.estimatedTriangles = 0; s.commits = 0; s.deferredCommits = 0; s.newVariants = 0;
        s.screenSpace = screen; s.blurDemotedTrees = 0; s.focusProtectedTrees = 0; s.fovealCentreNdc = [cx, cy]; s.frameHeightPx = heightPx; s.fovDeg = fovDeg;
        const dirty: TreeState[] = [];
        const sphere = new THREE.Sphere();
        const visible: TreeState[] = [];
        const viewCentre = new THREE.Vector3();
        for (const t of this.trees) {
            t.node.updateWorldMatrix(true, false);
            sphere.center.copy(t.centerLocal).applyMatrix4(t.node.matrixWorld);
            const worldScale = Math.max(1e-6, t.node.matrixWorld.getMaxScaleOnAxis());
            sphere.radius = t.radiusLocal * worldScale;
            t.inMain = this.frustum.intersectsSphere(sphere);
            t.inShadow = !!shadowFrustum && shadowFrustum.intersectsSphere(sphere);
            const r = t.reason;
            t.prevDemotions = r.budgetDemotions;
            r.budgetDemotions = 0;
            t.deferStart = false;
            if (!t.inMain && !t.inShadow) {
                t.culled = true; t.snap = true; t.held = undefined; t.prevDemotions = 0;
                if (t.node.visible) t.node.visible = false;
                r.inView = false; r.culled = true; r.importance = 0; r.blurRadiusPx = 0; r.blurDemotion = 0; r.blurLevelsApplied = 0; r.focusProtected = false;
                s.culledTrees++;
                continue;
            }
            if (!t.node.visible) t.node.visible = true;
            t.dist = Math.max(0, sphere.center.distanceTo(camPos) - sphere.radius);
            const sizeM = t.sizeLocal * worldScale;
            // foveal weight from the tree centre's place in the (unwidened) frame; one behind the camera counts as at the edge
            let w = 1;
            if (screen && v.foveal.enabled) {
                this.ndc.set(sphere.center.x, sphere.center.y, sphere.center.z, 1).applyMatrix4(this.pv);
                // the part of the tree nearest the foveal centre counts: its sphere's projected half-size is taken off each axis, so a
                // large near tree reaching toward the centre is not treated as an edge tree
                const nw = this.ndc.w;
                const rad = sphereFovealRadius(nw > 1e-6 ? this.ndc.x / nw : 0, nw > 1e-6 ? this.ndc.y / nw : 0, nw, sphere.radius, fovDeg, persp!.aspect, [cx, cy], v.foveal.verticalWeight, v.foveal.edgeRadius);
                w = fovealWeight(t.inMain ? rad : Math.max(rad, v.foveal.edgeRadius), v.foveal);
            }
            const dEq = screen ? screenEquivalentDistance(t.dist, fovDeg, heightPx, w, v.screen) : t.dist;
            t.filteredD = hysteresisDistanceRelative(t.snap ? undefined : t.filteredD, dEq, this.opts.hysteresisM, screen ? v.screen.hysteresisShare : 0);
            const px = projectedHeightPx(sizeM, t.dist, fovDeg, heightPx);
            // importance under the budget: the weighted on-screen height, read from the filtered distance (so the order does not churn
            // frame to frame while the camera moves): the tree's height in px at the reference lens and frame at that distance
            t.importance = t.inMain ? projectedHeightPx(sizeM, t.filteredD, v.screen.referenceFovDeg, v.screen.referenceHeightPx) : -1;
            // depth of field: the blur radius (px) of the tree's point nearest the plane of focus, as the viewport draws it
            let blur = 0, protectedByFocus = false;
            if (dof && t.inMain) {
                viewCentre.copy(sphere.center).applyMatrix4(camera.matrixWorldInverse);
                const zc = -viewCentre.z;
                const focusObj = dof.focusObject;
                let isFocusTree = false;
                for (let o: THREE.Object3D | null = focusObj ?? null; o && !isFocusTree; o = o.parent) if (o === t.node) isFocusTree = true;
                if (!isFocusTree && dof.focusPoint && dof.focusPoint.distanceTo(sphere.center) <= sphere.radius) isFocusTree = true;
                if (isFocusTree || (dof.focusM >= zc - sphere.radius && dof.focusM <= zc + sphere.radius)) protectedByFocus = true;
                else {
                    const nearest = dof.focusM < zc - sphere.radius ? zc - sphere.radius : zc + sphere.radius;
                    blur = 0.5 * circleOfConfusionPx(dof.focalLengthMm, dof.apertureFStop, dof.focusM, Math.max(1e-3, nearest), fovDeg, heightPx);
                    if (finite(dof.maxBlurRadiusPx)) blur = Math.min(blur, dof.maxBlurRadiusPx);
                }
            }
            const blurWant = protectedByFocus ? 0 : blurDemotionLevels(blur, v.blur);
            if (t.snap || protectedByFocus || Math.abs(blurWant - t.blurLevels) >= 0.5 + Math.max(0, v.blur.levelHysteresis)) t.blurLevels = Math.round(blurWant);
            if (protectedByFocus) s.focusProtectedTrees++;
            if (t.blurLevels > 0) s.blurDemotedTrees++;
            r.inView = t.inMain; r.culled = false; r.rangeM = t.dist; r.sizeM = sizeM; r.projectedPx = px; r.fovealWeight = w; r.importance = t.importance;
            r.equivalentDistM = t.filteredD; r.blurRadiusPx = blur; r.blurDemotion = blurWant; r.blurLevelsApplied = t.blurLevels; r.focusProtected = protectedByFocus;
            t.culled = false;
            visible.push(t);
        }
        s.visibleTrees = visible.reduce((n, t) => n + (t.inMain ? 1 : 0), 0);
        s.shadowOnlyTrees = visible.length - s.visibleTrees;
        s.culledTrees = this.trees.length - visible.length;
        // Levels: each tree's target from its (filtered) distance, blur and shadow-only role, settled on a whole level once the camera
        // holds still; then the budget on where the trees are heading (see below).
        const n = this.levelCount;
        const settle = settleMs > 0 && this.forced === undefined;
        const baseTarget = (t: TreeState): LodEdges => {
            let e: LodEdges = this.forced === undefined ? targetEdges(t.filteredD!, t.bands) : edgesAtLevel(Math.min(this.forced, n - 1), n);
            if (this.forced === undefined && t.blurLevels > 0) e = demoteEdges(e, t.blurLevels);
            // a tree only the shadow camera sees never wears a leaf-heavy level (near, near-mid): its shadow does not need the small leaves
            if (!t.inMain) e = edgesNoFinerThan(e, Math.max(0, n - 2));
            if (!settle) { t.held = undefined; return e; }
            // Settling: a tree inside a band overlap shares the hash between two levels for as long as it stays there (continuous in
            // distance, so a moving camera never pops). Once the camera has held still, each such tree crossfades to its dominant
            // level and keeps it, moving or not, until that level's own share of the distance crossfade drops below the release
            // share: a dead band, so a level a still camera settled on does not flicker back and forth. When the camera comes to rest
            // again, a held level that has fallen below the dominant one (by more than a near tie) gives way to it.
            if (t.held !== undefined && shareOf(e, t.held) < this.opts.settleReleaseShare) t.held = undefined;
            // at rest again: a held level that is no longer the dominant one gives way to it, unless the two are near a tie
            if (t.held !== undefined && stillOnset && shareOf(e, t.held) < 0.5 - SETTLE_TIE_SHARE) t.held = undefined;
            if (t.held === undefined && still) t.held = dominantLevel(e);
            return t.held === undefined ? e : edgesAtLevel(t.held, n);
        };
        const submitted = (e: LodEdges, t: TreeState): number => {
            let tri = 0;
            for (let k = 0; k < n; k++) if (quantiseRange(levelRange(e, k)) !== null) tri += t.levels[k].triangles;
            return tri;
        };
        // what the shadow pass draws of a tree: its casting level, in full (the depth pass has no dither)
        const shadowCost = (e: LodEdges, t: TreeState): number => (t.inShadow ? t.levels[castingLevel(e)].triangles : 0);
        // what a target costs once the tree is there: its levels with a share, and its casting level in the shadow pass
        const headingCost = (target: LodEdges, t: TreeState): number => (t.inMain ? submitted(target, t) : 0) + shadowCost(target, t);
        // what this frame draws on the way there (a crossfade in flight draws both of its levels)
        const inFlightCost = (target: LodEdges, t: TreeState): number => headingCost(t.snap ? target : stepEdges(t.edges, target, maxStep), t);
        for (const t of visible) { t.base = baseTarget(t); if (t.held !== undefined && t.inMain) s.settledTrees++; }
        // one budget for the whole frame: what the rest of the scene draws comes off it first
        const reserved = finite(frame?.reservedTriangles) && frame!.reservedTriangles! > 0 ? frame!.reservedTriangles! : 0;
        const scale = finite(frame?.budgetScale) && frame!.budgetScale! > 0 ? Math.min(1, frame!.budgetScale!) : 1;
        const frameBudget = this.opts.triangleBudget * scale;
        const budget = Math.max(0, frameBudget - reserved);
        s.triangleBudget = frameBudget; s.budgetScale = scale; s.reservedTriangles = reserved; s.treeBudget = budget;
        // Budget on the destinations, not on this frame's in-flight cost: judged by the in-flight cost a tree's promotion counted
        // both of its levels and a settled tree's demotion looked like a loss, so the nearest trees were held back while less
        // important ones kept their levels. Importance is the projected height x foveal weight; a tree only the shadow camera sees
        // ranks below any the camera sees. The fit starts from where each tree was held last frame and changes only what it must:
        //  1. over the budget: the least important trees give up a level first (near to near-mid, near-mid to mid, mid to far), one
        //     level a pass, until the levels fit;
        //  2. room under the budget less a release margin: held-down trees take levels back, most important first, wherever the
        //     level still fits (the last demotion of a pass can free far more than was missing);
        //  3. order: a held-down tree more important than a tree keeping a finer level (beyond the stickiness ratio) takes a level
        //     back from the least important such trees when that fits within the release margin.
        // The margin and the stickiness are the hysteresis: at a still camera the fit is the same every frame, and a turning camera
        // moves a tree only once its need or its importance has really changed.
        const budgetOn = this.forced === undefined;
        const limit = budgetOn ? budget : Infinity;
        const release = limit * (1 - BUDGET_RELEASE_MARGIN);
        const demotable = (t: TreeState): boolean => !t.reason.focusProtected && finestLevel(t.target) < n - 1;
        const demoteGain = (t: TreeState): number => headingCost(t.target, t) - headingCost(edgesNoFinerThan(t.target, finestLevel(t.target) + 1), t);
        const demoteOnce = (t: TreeState): number => {
            const coarser = edgesNoFinerThan(t.target, finestLevel(t.target) + 1);
            const gain = headingCost(t.target, t) - headingCost(coarser, t);
            t.target = coarser; t.reason.budgetDemotions++;
            return gain;
        };
        const promoteExtra = (t: TreeState): number => headingCost(coarserBy(t.base, t.reason.budgetDemotions - 1), t) - headingCost(t.target, t);
        const promoteOnce = (t: TreeState): void => { t.target = coarserBy(t.base, t.reason.budgetDemotions - 1); t.reason.budgetDemotions--; };
        let total = 0;
        for (const t of visible) {
            t.target = t.base; t.reason.budgetDemotions = 0;
            // where the budget held it last frame (the focus tree is never held)
            if (budgetOn) for (let k = 0; k < t.prevDemotions && demotable(t); k++) demoteOnce(t);
            total += headingCost(t.target, t);
        }
        if (budgetOn && (total > limit || visible.some(t => t.reason.budgetDemotions > 0))) {
            const rank = (t: TreeState): number => t.importance * (t.prevDemotions > 0 ? 1 : 1 + BUDGET_STICKINESS);
            const asc = [...visible].sort((a, b) => rank(a) - rank(b));
            // 1. over: the least important give up a level a pass
            for (let pass = 0; pass < n - 1 && total > limit; pass++) {
                for (const t of asc) {
                    if (!demotable(t) || demoteGain(t) <= 0) continue;
                    total -= demoteOnce(t);
                    if (total <= limit) break;
                }
            }
            // 2. room: levels back, most important first, within the release margin
            for (let changed = total < release; changed;) {
                changed = false;
                for (let k = asc.length - 1; k >= 0; k--) {
                    const t = asc[k];
                    if (t.reason.budgetDemotions <= 0) continue;
                    const extra = promoteExtra(t);
                    if (total + extra > release) continue;
                    promoteOnce(t); total += extra; changed = true;
                }
            }
            // 3. order: the most important held-down trees take a level from clearly less important ones when that fits
            const held = visible.filter(t => t.reason.budgetDemotions > 0).sort((a, b) => b.importance - a.importance);
            for (let h = 0; h < Math.min(held.length, MAX_BUDGET_SWAPS); h++) {
                const a = held[h];
                if (a.reason.budgetDemotions <= 0) continue;
                const extra = promoteExtra(a);
                const picks: TreeState[] = [];
                let freed = 0;
                for (const b of asc) {
                    if (b.importance * (1 + BUDGET_STICKINESS) >= a.importance) break;
                    if (b === a || !demotable(b)) continue;
                    const g = demoteGain(b);
                    if (g <= 0) continue;
                    picks.push(b); freed += g;
                    if (total - freed + extra <= release) break;
                }
                if (total - freed + extra > release) break;                    // no room for this one; less important ones have fewer donors
                if (!picks.length) continue;                                   // room without a donor is step 2's, within the release margin
                for (const b of picks) total -= demoteOnce(b);
                promoteOnce(a); total += extra;
            }
        }
        s.demotedTrees = visible.reduce((a, t) => a + (t.reason.budgetDemotions > 0 ? 1 : 0), 0);
        // In flight: a dissolve draws both of its levels. When what this frame draws would exceed the budget by more than the
        // overshoot share, the least important trees still wholly at one level wait to start a dissolve to a finer level (they
        // keep what they draw now). When no dissolve is running the most important one starts whatever it costs, so the levels always get there,
        // one dissolve after another.
        if (budgetOn) {
            let inFlight = visible.reduce((a, t) => a + inFlightCost(t.target, t), 0);
            const cap = budget * (1 + Math.max(0, this.opts.inFlightOvershoot));
            if (inFlight > cap) {
                // promotions only: a demotion lowers what the tree heads for, so it never waits
                const starts = visible.filter(t => !t.snap && isWhole(t.edges) && !sameEdges(t.edges, t.target) && headingCost(t.target, t) > headingCost(t.edges, t)).sort((a, b) => a.importance - b.importance);
                const running = visible.some(t => !isWhole(t.edges));
                for (let k = 0; k < starts.length && inFlight > cap; k++) {
                    if (k === starts.length - 1 && !running) break;
                    const t = starts[k];
                    const saved = inFlightCost(t.target, t) - headingCost(t.edges, t);
                    if (saved > 0) { t.deferStart = true; inFlight -= saved; s.budgetDeferredStarts++; }
                }
            }
        }
        for (const t of visible) {
            const target = t.deferStart ? t.edges : t.target;
            t.edges = t.snap ? target : stepEdges(t.edges, target, maxStep);
            t.snap = false;
            let changed = false;
            for (let k = 0; k < n; k++) {
                const lvl = t.levels[k];
                // a mesh whose material was swapped behind our back (the clay pass, an override) wears its new base plain: dress it again
                if (lvl.applied !== 'off' && lvl.applied !== 'redress') {
                    for (const m of lvl.meshes) if (m.userData.sbLodWorn !== undefined && m.material !== m.userData.sbLodWorn && !isStagedMaterial(m.material as THREE.Material)) { lvl.applied = 'redress'; break; }
                }
                const w = keyOf(levelRange(t.edges, k));
                t.want[k] = w;
                if (w !== t.levels[k].applied) changed = true;
            }
            s.estimatedShadowTriangles += shadowCost(t.edges, t);
            const cast = castingLevel(t.edges);
            if (cast !== t.castLevel) {
                t.castLevel = cast;
                for (let k = 0; k < n; k++) for (const m of t.levels[k].meshes) m.castShadow = k === cast && m.userData.sbLodCast !== false;
            }
            if (t.inMain) s.estimatedTriangles += submitted(t.edges, t);     // what is submitted: a level in a dissolve still draws all of its triangles (the dither drops them in the shader)
            if (!t.inMain) { if (changed) dirty.push(t); continue; }
            let whole = -1;
            for (let k = 0; k < n && whole < 0; k++) { const [lo, hi] = levelRange(t.edges, k); if (lo <= 1e-6 && hi >= 1 - 1e-6) whole = k; }
            if (whole >= 0) s.atLevel[whole]++; else s.fading++;
            t.reason.level = cast;
            if (changed) dirty.push(t);
        }
        if (dirty.length > this.opts.maxCommitsPerFrame) {
            dirty.sort((a, b) => b.importance - a.importance);
            s.deferredCommits = dirty.length - this.opts.maxCommitsPerFrame;
            dirty.length = this.opts.maxCommitsPerFrame;
        }
        let variantBudget = this.opts.maxNewVariantsPerFrame;
        for (const t of dirty) {
            let done = true;
            for (let k = 0; k < n; k++) {
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
            const full = this.fullMaterialOf(m, base, lvl.index);
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
                    if (isBreakupDepthMaterial(m.customDepthMaterial)) m.customDepthMaterial = undefined;
                    if (isBreakupDepthMaterial(m.customDistanceMaterial)) m.customDistanceMaterial = undefined;
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
        for (const per of this.tintVariants.values()) for (const v of per) v?.dispose();
        this.tintVariants.clear();
        if (this.trees.length || this.stats.trees) releaseCrownLobeAtlas();
        this.trees.length = 0;
        this.stats.trees = 0;
    }
}

/** One stats line for the viewport overlay: what the controllers drew in the last frame and why trees left their size's level. */
export function formatTreeLodStats(all: readonly TreeLodStats[], scene?: { main: number; shadow: number }): string {
    const sum = (f: (s: TreeLodStats) => number) => all.reduce((a, s) => a + f(s), 0);
    const m = (x: number) => (x >= 1e6 ? `${(x / 1e6).toFixed(2)}M` : x >= 1e3 ? `${(x / 1e3).toFixed(1)}k` : `${Math.round(x)}`);
    const s0 = all[0];
    const mode = s0.screenSpace ? `screen ${s0.fovDeg.toFixed(1)}° ${Math.round(s0.frameHeightPx)}px` : 'metre bands';
    return [
        `trees ${sum(s => s.trees)}  seen ${sum(s => s.visibleTrees)}  shadow-only ${sum(s => s.shadowOnlyTrees)}  culled ${sum(s => s.culledTrees)}`,
        `near ${sum(s => s.atLevel[0])}  near-mid ${sum(s => s.atLevel[1])}  mid ${sum(s => s.atLevel[2])}  far ${sum(s => s.atLevel[3])}  fading ${sum(s => s.fading)}${s0.still ? `  still: settled ${sum(s => s.settledTrees)}` : ''}`,
        `tri ${m(sum(s => s.estimatedTriangles))} + shadow ${m(sum(s => s.estimatedShadowTriangles))}  budget-demoted ${sum(s => s.demotedTrees)}${sum(s => s.budgetDeferredStarts) ? ` (waiting ${sum(s => s.budgetDeferredStarts)})` : ''}  blur-demoted ${sum(s => s.blurDemotedTrees)}  in focus ${sum(s => s.focusProtectedTrees)}`,
        // the one budget split: the rest of the scene (buildings, context, hero) first, the trees in what is left
        `budget ${m(s0.triangleBudget)}${s0.budgetScale < 1 ? ` (GPU-adapted x${s0.budgetScale.toFixed(2)})` : ''} = scene ${m(scene ? scene.main : 0)} + shadow ${m(scene ? scene.shadow : 0)} + trees ${m(sum(s => s.estimatedTriangles + s.estimatedShadowTriangles))} (trees may use ${m(Math.max(0, s0.triangleBudget - (scene ? scene.main + scene.shadow : 0)))})`,
        `${mode}  fovea (${s0.fovealCentreNdc[0].toFixed(2)}, ${s0.fovealCentreNdc[1].toFixed(2)})  update ${sum(s => s.updateMs).toFixed(2)} ms`
    ].join('\n');
}
