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
    FADE_STEPS, crossfadeInterval, hysteresisDistance, levelRange, quantiseRange, smoothstep01, stepEdges, targetEdges, type LodBand
} from '../src/browser/generative-canvas/primitives/scene3d/treeLod/treeLodMath';

const BANDS: [LodBand, LodBand, LodBand] = [{ minDistM: 0, maxDistM: 60, fadeM: 10 }, { minDistM: 50, maxDistM: 200, fadeM: 30 }, { minDistM: 170, maxDistM: 1e6, fadeM: 60 }];

describe('tree LOD arithmetic', () => {
    it('crossfades where the bands overlap, and around a gap or a touching pair', () => {
        expect(crossfadeInterval(BANDS, 0)).toEqual([50, 60]);
        expect(crossfadeInterval(BANDS, 1)).toEqual([170, 200]);
        const touching: [LodBand, LodBand, LodBand] = [{ minDistM: 0, maxDistM: 60, fadeM: 10 }, { minDistM: 60, maxDistM: 200, fadeM: 30 }, { minDistM: 200, maxDistM: 1e6, fadeM: 60 }];
        const [a, b] = crossfadeInterval(touching, 0);
        expect(a).toBeLessThan(60); expect(b).toBeGreaterThan(60);
        const gap: [LodBand, LodBand, LodBand] = [{ minDistM: 0, maxDistM: 40, fadeM: 10 }, { minDistM: 50, maxDistM: 200, fadeM: 30 }, { minDistM: 200, maxDistM: 1e6, fadeM: 60 }];
        const [ga, gb] = crossfadeInterval(gap, 0);
        expect(ga).toBeLessThan(45); expect(gb).toBeGreaterThan(45);
    });

    it('target edges are 0 <= e0 <= e1 <= 1, continuous and monotone in distance, and settle to a pure level inside each band', () => {
        let prev = targetEdges(0, BANDS);
        expect(prev).toEqual({ e0: 1, e1: 1 });                       // level 0 alone
        let maxJump = 0;
        for (let d = 0.1; d <= 400; d += 0.1) {
            const e = targetEdges(d, BANDS);
            expect(e.e0).toBeGreaterThanOrEqual(0); expect(e.e1).toBeLessThanOrEqual(1 + 1e-9); expect(e.e1).toBeGreaterThanOrEqual(e.e0 - 1e-9);
            expect(e.e0).toBeLessThanOrEqual(prev.e0 + 1e-9);          // level 0's share only shrinks with distance
            expect(e.e1).toBeLessThanOrEqual(prev.e1 + 1e-9);
            maxJump = Math.max(maxJump, Math.abs(e.e0 - prev.e0), Math.abs(e.e1 - prev.e1));
            prev = e;
        }
        expect(maxJump).toBeLessThan(0.08);                           // a 0.1 m step never changes a share by more than 8 %
        expect(targetEdges(100, BANDS)).toEqual({ e0: 0, e1: 1 });    // level 1 alone
        expect(targetEdges(500, BANDS)).toEqual({ e0: 0, e1: 0 });    // level 2 alone
        const mid = targetEdges(55, BANDS);
        expect(mid.e0).toBeCloseTo(0.5, 5); expect(mid.e1).toBe(1);   // half and half across the first overlap
    });

    it('every hash value is drawn by exactly one level: the three ranges tile [0, 1)', () => {
        for (const e of [{ e0: 0.3, e1: 0.8 }, { e0: 1, e1: 1 }, { e0: 0, e1: 0 }, { e0: 0.5, e1: 0.5 }]) {
            const r = [0, 1, 2].map(k => levelRange(e, k as 0 | 1 | 2));
            expect(r[0][0]).toBe(0); expect(r[2][1]).toBe(1);
            expect(r[0][1]).toBe(r[1][0]); expect(r[1][1]).toBe(r[2][0]);
        }
    });

    it('moves the edges at a bounded rate and keeps them ordered', () => {
        let cur = { e0: 1, e1: 1 };
        const target = { e0: 0, e1: 0 };
        let frames = 0;
        while ((cur.e0 > 0 || cur.e1 > 0) && frames < 100) {
            const next = stepEdges(cur, target, 0.1);
            expect(Math.abs(next.e0 - cur.e0)).toBeLessThanOrEqual(0.1 + 1e-12); expect(Math.abs(next.e1 - cur.e1)).toBeLessThanOrEqual(0.1 + 1e-12);
            expect(next.e1).toBeGreaterThanOrEqual(next.e0);
            cur = next; frames++;
        }
        expect(frames).toBeGreaterThanOrEqual(10); expect(frames).toBeLessThanOrEqual(11);
        const inverted = stepEdges({ e0: 0.9, e1: 0.9 }, { e0: 0.9, e1: 0.2 }, 0.5);
        expect(inverted.e1).toBeGreaterThanOrEqual(inverted.e0);
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
