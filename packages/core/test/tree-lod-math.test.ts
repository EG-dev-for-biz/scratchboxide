/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/


import { describe, expect, it } from 'vitest';
import {
    FADE_STEPS, crossfadeInterval, edgesAtLevel, edgesNoFinerThan, finestLevel, hysteresisDistance, levelRange, quantiseRange, smoothstep01, stepEdges, targetEdges, type LodBand
} from '../src/browser/generative-canvas/primitives/scene3d/treeLod/treeLodMath';

/** An old trees-lod/1 file: near, mid, far. */
const BANDS3: LodBand[] = [{ minDistM: 0, maxDistM: 60, fadeM: 10 }, { minDistM: 50, maxDistM: 200, fadeM: 30 }, { minDistM: 170, maxDistM: 1e6, fadeM: 60 }];
/** A trees-lod/2 file: near, near-mid, mid, far. */
const BANDS4: LodBand[] = [{ minDistM: 0, maxDistM: 60, fadeM: 10 }, { minDistM: 50, maxDistM: 110, fadeM: 20 }, { minDistM: 90, maxDistM: 200, fadeM: 30 }, { minDistM: 170, maxDistM: 1e6, fadeM: 60 }];

const tiles = (e: number[]) => {
    const r = Array.from({ length: e.length + 1 }, (_, k) => levelRange(e, k));
    expect(r[0][0]).toBe(0); expect(r[r.length - 1][1]).toBe(1);
    for (let k = 0; k + 1 < r.length; k++) expect(r[k][1]).toBe(r[k + 1][0]);
};

describe('tree LOD arithmetic', () => {
    it('crossfades where the bands overlap, and around a gap or a touching pair', () => {
        expect(crossfadeInterval(BANDS3, 0)).toEqual([50, 60]);
        expect(crossfadeInterval(BANDS3, 1)).toEqual([170, 200]);
        expect(crossfadeInterval(BANDS4, 1)).toEqual([90, 110]);
        expect(crossfadeInterval(BANDS4, 2)).toEqual([170, 200]);
        const touching: LodBand[] = [{ minDistM: 0, maxDistM: 60, fadeM: 10 }, { minDistM: 60, maxDistM: 200, fadeM: 30 }, { minDistM: 200, maxDistM: 1e6, fadeM: 60 }];
        const [a, b] = crossfadeInterval(touching, 0);
        expect(a).toBeLessThan(60); expect(b).toBeGreaterThan(60);
        const gap: LodBand[] = [{ minDistM: 0, maxDistM: 40, fadeM: 10 }, { minDistM: 50, maxDistM: 200, fadeM: 30 }, { minDistM: 200, maxDistM: 1e6, fadeM: 60 }];
        const [ga, gb] = crossfadeInterval(gap, 0);
        expect(ga).toBeLessThan(45); expect(gb).toBeGreaterThan(45);
    });

    for (const [name, bands] of [['three levels', BANDS3], ['four levels', BANDS4]] as const) {
        it(`target edges are ordered in [0, 1], continuous and monotone in distance, and settle to a pure level inside each band (${name})`, () => {
            const n = bands.length;
            let prev = targetEdges(0, bands);
            expect(prev).toEqual(edgesAtLevel(0, n));                   // level 0 alone
            let maxJump = 0;
            for (let d = 0.1; d <= 400; d += 0.1) {
                const e = targetEdges(d, bands);
                expect(e).toHaveLength(n - 1);
                for (let k = 0; k < e.length; k++) {
                    expect(e[k]).toBeGreaterThanOrEqual(k ? e[k - 1] - 1e-12 : 0); expect(e[k]).toBeLessThanOrEqual(1 + 1e-9);
                    expect(e[k]).toBeLessThanOrEqual(prev[k] + 1e-9);   // a finer level's share only shrinks with distance
                    maxJump = Math.max(maxJump, Math.abs(e[k] - prev[k]));
                }
                prev = e;
            }
            expect(maxJump).toBeLessThan(0.08);                         // a 0.1 m step never changes a share by more than 8 %
            expect(targetEdges(500, bands)).toEqual(edgesAtLevel(n - 1, n));
            expect(targetEdges(55, bands)[0]).toBeCloseTo(0.5, 5);      // half and half across the first overlap
        });
    }

    it('settles to the near-mid level between its handovers, and to the mid level after them', () => {
        expect(targetEdges(80, BANDS4)).toEqual(edgesAtLevel(1, 4));
        expect(targetEdges(140, BANDS4)).toEqual(edgesAtLevel(2, 4));
        expect(targetEdges(100, BANDS3)).toEqual(edgesAtLevel(1, 3));
        const half = targetEdges(100, BANDS4);
        expect(half[0]).toBe(0); expect(half[1]).toBeCloseTo(0.5, 5); expect(half[2]).toBe(1);
    });

    it('every hash value is drawn by exactly one level: the ranges tile [0, 1)', () => {
        for (const e of [[0.3, 0.8], [1, 1], [0, 0], [0.5, 0.5], [0.2, 0.4, 0.9], [0, 0, 0], [1, 1, 1], [0, 0.5, 0.5]]) tiles(e);
    });

    it('moves the edges at a bounded rate and keeps them ordered', () => {
        for (const n of [3, 4]) {
            let cur = edgesAtLevel(0, n);
            const target = edgesAtLevel(n - 1, n);
            let frames = 0;
            while (cur.some(x => x > 0) && frames < 100) {
                const next = stepEdges(cur, target, 0.1);
                next.forEach((x, k) => { expect(Math.abs(x - cur[k])).toBeLessThanOrEqual(0.1 + 1e-12); if (k) expect(x).toBeGreaterThanOrEqual(next[k - 1]); });
                cur = next; frames++;
            }
            expect(frames).toBeGreaterThanOrEqual(10); expect(frames).toBeLessThanOrEqual(11);
        }
        const inverted = stepEdges([0.9, 0.9], [0.9, 0.2], 0.5);
        expect(inverted[1]).toBeGreaterThanOrEqual(inverted[0]);
    });

    it('gives up the finest level first (the triangle budget) and keeps a level coarse enough for a shadow', () => {
        expect(finestLevel([0.4, 0.7, 1])).toBe(0);
        expect(finestLevel([0, 0.7, 1])).toBe(1);
        expect(finestLevel([0, 0, 0])).toBe(3);
        expect(edgesNoFinerThan([0.4, 0.7, 1], 1)).toEqual([0, 0.7, 1]);   // the near share goes to near-mid
        expect(edgesNoFinerThan([0.4, 0.7, 1], 2)).toEqual([0, 0, 1]);     // ... and near-mid's to mid
        tiles(edgesNoFinerThan([0.4, 0.7, 1], 2));
    });

    it('quantises a range to FADE_STEPS: empty, full, or a step range', () => {
        expect(quantiseRange([0.3, 0.3])).toBeNull();
        expect(quantiseRange([0, 1])).toBe('full');
        expect(quantiseRange([0, 0.999])).toBe('full');
        expect(quantiseRange([0.5, 1])).toEqual([FADE_STEPS / 2, FADE_STEPS]);
        expect(quantiseRange([0.01, 0.02])).toBeNull();
    });

    it('ignores distance changes smaller than the dead band and follows larger ones', () => {
        let f = hysteresisDistance(undefined, 55, 2);
        expect(f).toBe(55);
        for (const d of [54, 56, 54.5, 56.9, 53.1]) f = hysteresisDistance(f, d, 2);
        expect(f).toBe(55);
        f = hysteresisDistance(f, 60, 2);
        expect(f).toBe(58);                                           // moved only far enough that the real distance sits on the band edge
        f = hysteresisDistance(f, 50, 2);
        expect(f).toBe(52);
        expect(smoothstep01(-1)).toBe(0); expect(smoothstep01(2)).toBe(1); expect(smoothstep01(0.5)).toBe(0.5);
    });
});
