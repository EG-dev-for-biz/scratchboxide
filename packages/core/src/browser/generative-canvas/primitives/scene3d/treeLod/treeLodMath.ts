/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/


/**
 * Pure arithmetic of the tree level of detail: where the three levels crossfade, how far a tree has faded, and how
 * the unit interval of a stable hash is shared between the levels. No three.js here, so it is testable on its own.
 *
 * A tree carries three level bands (distance from the camera, in metres, with overlap). Across the overlap two levels
 * show at once, each on its own share of the hash: level k shows items whose hash falls in [edge(k-1), edge(k)),
 * where edge(-1) = 0 and edge(2) = 1. The two cut edges are the whole state of a tree; they always keep
 * 0 <= edge0 <= edge1 <= 1, so every hash value is drawn by exactly one level (no hole, no double draw).
 */

export interface LodBand { minDistM: number; maxDistM: number; fadeM: number }

/** The two cut edges of a tree: level 0 shows hash < e0, level 1 shows e0 <= hash < e1, level 2 shows hash >= e1. */
export interface LodEdges { e0: number; e1: number }

export const smoothstep01 = (t: number): number => { const x = Math.min(1, Math.max(0, t)); return x * x * (3 - 2 * x); };

/** The distance interval across which level `k` hands over to level `k + 1` (k = 0 or 1). A gap or a touching pair gets a short band centred on it. */
export function crossfadeInterval(bands: readonly [LodBand, LodBand, LodBand], k: 0 | 1): [number, number] {
    const lo = bands[k + 1].minDistM, hi = bands[k].maxDistM;
    if (hi - lo >= 0.5) return [lo, hi];
    const c = (lo + hi) / 2, half = Math.max(0.25, bands[k].fadeM / 2);
    return [c - half, c + half];
}

/** The edges a tree at distance `d` should have. Continuous in d, so a moving camera never makes a level appear at once. */
export function targetEdges(d: number, bands: readonly [LodBand, LodBand, LodBand]): LodEdges {
    const [a0, b0] = crossfadeInterval(bands, 0), [a1, b1] = crossfadeInterval(bands, 1);
    const s0 = smoothstep01((d - a0) / Math.max(1e-6, b0 - a0));
    const s1 = smoothstep01((d - a1) / Math.max(1e-6, b1 - a1));
    // weights: level 0 = 1 - s0, level 1 = s0 (1 - s1), level 2 = s0 s1 (sum 1)
    const e0 = 1 - s0;
    return { e0, e1: Math.max(e0, e0 + s0 * (1 - s1)) };
}

/** Moves `cur` toward `target` by at most `maxStep` per edge, and keeps the edges ordered. */
export function stepEdges(cur: LodEdges, target: LodEdges, maxStep: number): LodEdges {
    const mv = (c: number, t: number) => (t > c ? Math.min(t, c + maxStep) : Math.max(t, c - maxStep));
    const e0 = mv(cur.e0, target.e0);
    return { e0, e1: Math.max(e0, mv(cur.e1, target.e1)) };
}

/** The share of the hash interval a level draws: [lo, hi). Empty when lo >= hi. */
export function levelRange(edges: LodEdges, level: 0 | 1 | 2): [number, number] {
    return level === 0 ? [0, edges.e0] : level === 1 ? [edges.e0, edges.e1] : [edges.e1, 1];
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
