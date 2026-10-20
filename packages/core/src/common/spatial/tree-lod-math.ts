/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/


/**
 * Pure arithmetic of the tree level of detail: where the levels crossfade, how far a tree has faded, and how the unit
 * interval of a stable hash is shared between the levels. No three.js here, so it is testable on its own, and shared by the
 * viewport's TreeLodController (browser) and the photo-match evaluator's still-frame tree render (node, tree-lod-view.ts), so
 * both choose a tree's level by the same rule.
 *
 * A tree carries one distance band per level (metres from the camera, with overlap; four levels in a trees-lod/2 file,
 * three in a trees-lod/1 one). Across an overlap two neighbouring levels show at once, each on its own share of the hash:
 * level k shows items whose hash falls in [edge(k-1), edge(k)), where edge(-1) = 0 and edge(last) = 1. The cut edges (one
 * fewer than the levels) are the whole state of a tree; they always keep 0 <= edge0 <= edge1 <= ... <= 1, so every hash
 * value is drawn by exactly one level (no hole, no double draw).
 */

export interface LodBand { minDistM: number; maxDistM: number; fadeM: number }

/** The cut edges of a tree: level 0 shows hash < e[0], level k shows e[k-1] <= hash < e[k], the last level hash >= e[last]. */
export type LodEdges = number[];

export const smoothstep01 = (t: number): number => { const x = Math.min(1, Math.max(0, t)); return x * x * (3 - 2 * x); };

/** The distance interval across which level `k` hands over to level `k + 1`. A gap or a touching pair gets a short band centred on it. */
export function crossfadeInterval(bands: readonly LodBand[], k: number): [number, number] {
    const lo = bands[k + 1].minDistM, hi = bands[k].maxDistM;
    if (hi - lo >= 0.5) return [lo, hi];
    const c = (lo + hi) / 2, half = Math.max(0.25, bands[k].fadeM / 2);
    return [c - half, c + half];
}

/**
 * The edges a tree at distance `d` should have. Continuous in d, so a moving camera never makes a level appear at once.
 * With s_k the progress of handover k (0 before its interval, 1 after), level 0 weighs 1 - s_0, level k s_0..s_{k-1} (1 - s_k)
 * and the last level the product of all; edge k is the sum of the weights of levels 0..k, 1 - s_0 s_1 .. s_k.
 */
export function targetEdges(d: number, bands: readonly LodBand[]): LodEdges {
    const out: number[] = [];
    let prod = 1;
    for (let k = 0; k + 1 < bands.length; k++) {
        const [a, b] = crossfadeInterval(bands, k);
        prod *= smoothstep01((d - a) / Math.max(1e-6, b - a));
        out.push(Math.max(out.length ? out[out.length - 1] : 0, 1 - prod));
    }
    return out;
}

/** Moves `cur` toward `target` by at most `maxStep` per edge, and keeps the edges ordered. */
export function stepEdges(cur: LodEdges, target: LodEdges, maxStep: number): LodEdges {
    const mv = (c: number, t: number) => (t > c ? Math.min(t, c + maxStep) : Math.max(t, c - maxStep));
    const out: number[] = [];
    for (let k = 0; k < target.length; k++) out.push(Math.max(k ? out[k - 1] : 0, mv(cur[k] ?? target[k], target[k])));
    return out;
}

/** The share of the hash interval a level draws: [lo, hi). Empty when lo >= hi. */
export function levelRange(edges: LodEdges, level: number): [number, number] {
    return [level === 0 ? 0 : edges[level - 1], level >= edges.length ? 1 : edges[level]];
}

/** Edges that put a tree wholly at one level of `levels`. */
export function edgesAtLevel(level: number, levels: number): LodEdges {
    return Array.from({ length: levels - 1 }, (_, k) => (k >= level ? 1 : 0));
}

/** Edges with every level finer than `level` removed (their shares go to `level`). */
export function edgesNoFinerThan(e: LodEdges, level: number): LodEdges {
    return e.map((x, k) => (k < level ? 0 : x));
}

/** The finest level with a share, or the last level when all edges are 0. */
export function finestLevel(e: LodEdges): number {
    const k = e.findIndex(x => x > 0);
    return k < 0 ? e.length : k;
}

/** Number of equal steps the fade is quantised to (one material variant per distinct step range). */
export const FADE_STEPS = 16;

/** Quantises a range to FADE_STEPS; returns null when the range is empty, 'full' when it covers [0, 1). */
export function quantiseRange(r: [number, number]): [number, number] | 'full' | null {
    const lo = Math.round(r[0] * FADE_STEPS), hi = Math.round(r[1] * FADE_STEPS);
    if (hi <= lo) return null;
    return lo <= 0 && hi >= FADE_STEPS ? 'full' : [lo, hi];
}

/**
 * Distance hysteresis: the filtered distance follows the real one only once the real one has moved more than
 * `hysteresisM` away from it, so a camera shaking at a band edge does not retarget the tree every frame.
 */
export function hysteresisDistance(filtered: number | undefined, d: number, hysteresisM: number): number {
    if (filtered === undefined || Math.abs(d - filtered) > hysteresisM) return filtered === undefined ? d : d - Math.sign(d - filtered) * hysteresisM;
    return filtered;
}

// ---------------------------------------------------------------------------------------------------------------
// On-screen size
// ---------------------------------------------------------------------------------------------------------------

/**
 * Screen-space levels. A tree's bands are metres from the camera at a reference lens (vertical field of view
 * `referenceFovDeg`) on a frame `referenceHeightPx` tall; at that lens a band edge D is the on-screen height
 * P = S H_ref / (2 D tan(fov_ref / 2)) of a tree S metres tall, so the bands are pixel thresholds. A tree's projected height
 * at the current lens, P = S H / (2 r tan(fov / 2)) times its view weight w, is mapped back to the reference distance that
 * gives the same height, and the bands are read there:
 *
 *     d_ref = r (tan(fov / 2) / tan(fov_ref / 2)) (H_ref / H)^e / w
 *
 * where `e` (resolutionExponent) says how much the frame's pixel count counts: 0 = the share of the frame height decides
 * (a larger window does not change levels), 1 = actual pixels (a taller window keeps detail farther). At the reference lens
 * with w = 1 the result is r: the metre bands unchanged. The tree height S cancels out of the level, and only orders trees
 * by importance under the budget.
 */
export interface ScreenSizeParams { referenceFovDeg: number; referenceHeightPx: number; resolutionExponent: number }

const tanHalf = (fovDeg: number): number => Math.tan((Math.min(179, Math.max(1e-3, fovDeg)) * Math.PI) / 360);

/** Projected height in pixels of an object `sizeM` tall at range `rangeM` (clamped to 0.5 m) on a frame `heightPx` tall. */
export function projectedHeightPx(sizeM: number, rangeM: number, verticalFovDeg: number, heightPx: number): number {
    return (sizeM * heightPx) / (2 * Math.max(0.5, rangeM) * tanHalf(verticalFovDeg));
}

/** The reference-lens distance whose bands apply to a tree at `rangeM` seen with this lens and frame, at view weight `weight`. */
export function screenEquivalentDistance(rangeM: number, verticalFovDeg: number, heightPx: number, weight: number, p: ScreenSizeParams): number {
    const res = Math.pow(p.referenceHeightPx / Math.max(1, heightPx), p.resolutionExponent);
    return (rangeM * (tanHalf(verticalFovDeg) / tanHalf(p.referenceFovDeg)) * res) / Math.max(1e-3, weight);
}

/** The on-screen heights (px, at the reference lens and frame) a tree `sizeM` tall crosses at its band edges: [enter, leave] per level. */
export function pixelThresholds(bands: readonly LodBand[], sizeM: number, p: Pick<ScreenSizeParams, 'referenceFovDeg' | 'referenceHeightPx'>): Array<[number, number]> {
    const px = (d: number) => (d <= 0 ? Infinity : projectedHeightPx(sizeM, d, p.referenceFovDeg, p.referenceHeightPx));
    return bands.map(b => [px(b.minDistM), px(b.maxDistM)]);
}

/**
 * Distance hysteresis with a dead band that grows with distance (a log-space band): the filtered distance moves only once
 * the real one is more than max(hysteresisM, share x filtered) away, so a turning camera or a small dolly does not retarget a tree.
 */
export function hysteresisDistanceRelative(filtered: number | undefined, d: number, hysteresisM: number, share: number): number {
    return hysteresisDistance(filtered, d, filtered === undefined ? hysteresisM : Math.max(hysteresisM, share * filtered));
}

// ---------------------------------------------------------------------------------------------------------------
// Foveal weight: detail toward the centre of view
// ---------------------------------------------------------------------------------------------------------------

/**
 * Weight of a tree's on-screen size by where it is in the frame. `r` is its radial distance from the view centre (or the focus
 * point) in frame half-widths: r = sqrt(dx^2 + (verticalWeight dy)^2) with dx, dy in normalised device coordinates (each axis
 * normalised by its own half field of view, so the falloff is an ellipse matching the frame's aspect, squashed toward
 * horizontal bands by verticalWeight < 1). Inside `centreRadius` the weight is `centreWeight`; past `edgeRadius` it is
 * `edgeWeight`; between, a smoothstep of ((r - centreRadius) / (edgeRadius - centreRadius))^curve.
 */
export interface FovealParams { centreWeight: number; edgeWeight: number; centreRadius: number; edgeRadius: number; curve: number; verticalWeight: number }

export function fovealRadius(dxNdc: number, dyNdc: number, verticalWeight: number): number {
    return Math.hypot(dxNdc, verticalWeight * dyNdc);
}

export function fovealWeight(r: number, p: FovealParams): number {
    const span = Math.max(1e-6, p.edgeRadius - p.centreRadius);
    const t = Math.min(1, Math.max(0, (r - p.centreRadius) / span));
    const s = smoothstep01(Math.pow(t, Math.max(1e-3, p.curve)));
    return p.centreWeight + (p.edgeWeight - p.centreWeight) * s;
}

// ---------------------------------------------------------------------------------------------------------------
// Demotion by a continuous number of levels (depth-of-field blur)
// ---------------------------------------------------------------------------------------------------------------

/** Edges with every hash item one level coarser (level k's share goes to k + 1; the last level keeps its own and gains the one before). */
function shiftCoarser(e: LodEdges): LodEdges {
    return e.map((_, k) => (k === 0 ? 0 : e[k - 1]));
}

/**
 * Edges demoted by `amount` levels, continuous in `amount`: between whole numbers the edges are the linear blend of the two
 * whole demotions (a blend of ordered edges is ordered, so the shares still tile the hash). Changing `amount` slowly therefore
 * dissolves a tree from one level into the next with the same crossfade as a distance change.
 */
export function demoteEdges(e: LodEdges, amount: number): LodEdges {
    const a = Math.min(e.length, Math.max(0, amount));
    if (a <= 0) return e;
    const whole = Math.floor(a), frac = a - whole;
    let lo = e;
    for (let i = 0; i < whole; i++) lo = shiftCoarser(lo);
    if (frac <= 0) return lo;
    const hi = shiftCoarser(lo);
    return lo.map((x, k) => x + (hi[k] - x) * frac);
}

/** Levels a tree is demoted by for a blur radius (px): 0 up to `startPx`, `maxLevels` from `fullPx`, a smoothstep between. */
export interface BlurDemotionParams { startPx: number; fullPx: number; maxLevels: number }

export function blurDemotionLevels(blurRadiusPx: number, p: BlurDemotionParams): number {
    if (!(blurRadiusPx > p.startPx)) return 0;
    return p.maxLevels * smoothstep01((blurRadiusPx - p.startPx) / Math.max(1e-6, p.fullPx - p.startPx));
}

/** The crown-shading detail slot (0 near, 1 near-mid, 2 mid, 3 far) of a level of a tree with `levels` levels. */
export const crownSlotOf = (level: number, levels: number): number => (levels >= 4 ? Math.min(3, level) : [0, 2, 3][Math.min(2, level)]);

/** The level with the largest share of the hash (the farther level on a tie): the level that casts a tree's shadow, and the one a still frame draws. */
export function dominantLevel(e: LodEdges): number {
    let best = e.length, bestShare = -1;
    for (let k = e.length; k >= 0; k--) {
        const [lo, hi] = levelRange(e, k);
        if (hi - lo > bestShare + 1e-9) { best = k; bestShare = hi - lo; }
    }
    return best;
}

// ---------------------------------------------------------------------------------------------------------------
// The view options and the level a view gives a tree
// ---------------------------------------------------------------------------------------------------------------

/**
 * Triangles a viewport frame may draw (main pass plus shadow pass) before trees give up levels, the rest of the scene
 * (buildings, context, hero) taken off it first. The viewport's TreeLodController default; a scene's `treeLod.triangleBudget`
 * overrides it, and the viewport lowers it at run time while the GPU frame time stays over its target (adaptiveTreeBudget.ts).
 * 14 M: on Washington Square (591 trees, four levels) on an Apple M1 Ultra the worst measured view stays near 9 ms of GPU time
 * (p95 under 13 ms) at 8, 10, 12 and 14 M alike, while at 8 M the street views lose most mid-distance crowns to far blobs
 * (docs/processes/tree_budget_tune.md).
 */
export const DEFAULT_TREE_TRIANGLE_BUDGET = 14_000_000;

/** How the camera's view chooses the levels. Every field is continuous except the on/off switches. */
export interface TreeLodViewOptions {
    /** On-screen size: bands as pixel thresholds at the reference lens. `enabled: false` = metre bands (the old behaviour). */
    screen: ScreenSizeParams & { enabled: boolean; hysteresisShare: number };
    /** Detail toward the centre of the view. */
    foveal: FovealParams & { enabled: boolean; followFocus: boolean };
    /**
     * Depth-of-field demotion (radius in px of the drawn blur). The continuous demotion is held at whole levels with a dead band
     * of `levelHysteresis` levels, so a blurred tree settles on one level instead of dithering between two (which draws both);
     * a change of whole level still crossfades at the usual rate.
     */
    blur: BlurDemotionParams & { enabled: boolean; levelHysteresis: number };
    /** Tint each level (near green, near-mid yellow, mid orange, far red) to see the levels in the viewport. */
    debugTint: boolean;
}

export type TreeLodViewInput = {
    screen?: Partial<TreeLodViewOptions['screen']>; foveal?: Partial<TreeLodViewOptions['foveal']>; blur?: Partial<TreeLodViewOptions['blur']>;
    debugTint?: boolean; triangleBudget?: number;
};

export const DEFAULT_TREE_LOD_VIEW: Readonly<TreeLodViewOptions> = {
    screen: { enabled: true, referenceFovDeg: 45, referenceHeightPx: 1080, resolutionExponent: 0, hysteresisShare: 0.03 },
    foveal: { enabled: true, centreWeight: 2, edgeWeight: 0.55, centreRadius: 0.2, edgeRadius: 1, curve: 1, verticalWeight: 0.5, followFocus: true },
    blur: { enabled: true, startPx: 1.5, fullPx: 6, maxLevels: 2, levelHysteresis: 0.15 },
    debugTint: false
};

const finiteNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
function mergeFinite<T extends object>(base: T, over: Partial<T> | undefined): T {
    const out = { ...base } as Record<string, unknown>;
    if (over) for (const [k, v] of Object.entries(over)) if (k in out && (typeof out[k] === 'boolean' ? typeof v === 'boolean' : finiteNumber(v))) out[k] = v;
    return out as T;
}

/** The view options from a partial override of the defaults (values of the wrong type are ignored). */
export function resolveTreeLodView(input: TreeLodViewInput | undefined | null): TreeLodViewOptions {
    const d = DEFAULT_TREE_LOD_VIEW;
    return {
        screen: mergeFinite(d.screen, input?.screen), foveal: mergeFinite(d.foveal, input?.foveal), blur: mergeFinite(d.blur, input?.blur),
        debugTint: typeof input?.debugTint === 'boolean' ? input.debugTint : d.debugTint
    };
}

/**
 * The foveal radius of a tree's bounding sphere: its centre's place in normalised device coordinates (`ndcX`, `ndcY`, with
 * `viewDepth` its depth in front of the camera) relative to the foveal centre, with the sphere's projected half-size taken off
 * each axis, so a large near tree reaching toward the centre is not treated as an edge tree. A centre behind the camera is at
 * the edge (`edgeRadius`). `aspect` is the frame's width over height.
 */
export function sphereFovealRadius(
    ndcX: number, ndcY: number, viewDepth: number, sphereRadius: number, verticalFovDeg: number, aspect: number,
    centre: readonly [number, number], verticalWeight: number, edgeRadius: number
): number {
    if (!(viewDepth > 1e-6)) return edgeRadius;
    const halfY = sphereRadius / (Math.max(viewDepth, sphereRadius) * Math.tan((verticalFovDeg * Math.PI) / 360));
    const halfX = halfY / Math.max(1e-6, aspect);
    return fovealRadius(Math.max(0, Math.abs(ndcX - centre[0]) - halfX), Math.max(0, Math.abs(ndcY - centre[1]) - halfY), verticalWeight);
}

/** What a still view of one tree gives: the reference-lens distance its bands are read at, its settled edges and the level drawn. */
export interface TreeViewLevel { equivalentDistM: number; edges: LodEdges; level: number }

/**
 * The level a tree settles at for a camera that holds still (no depth of field, no budget): its range to the nearest point of
 * its bounding sphere mapped to the reference lens by on-screen size and foveal weight (when `view.screen.enabled`), the target
 * edges of its bands there, and the level with the largest share. TreeLodController reaches the same edges after its crossfade;
 * a still frame draws the dominant level whole.
 */
export function treeLevelForView(
    rangeM: number, bands: readonly LodBand[], view: Pick<TreeLodViewOptions, 'screen'>,
    lens: { verticalFovDeg: number; heightPx: number; fovealWeight: number }
): TreeViewLevel {
    const d = view.screen.enabled ? screenEquivalentDistance(rangeM, lens.verticalFovDeg, lens.heightPx, lens.fovealWeight, view.screen) : rangeM;
    const edges = targetEdges(d, bands);
    return { equivalentDistM: d, edges, level: dominantLevel(edges) };
}
