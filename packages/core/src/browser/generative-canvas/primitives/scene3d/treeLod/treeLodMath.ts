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
 * interval of a stable hash is shared between the levels. No three.js here, so it is testable on its own.
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
