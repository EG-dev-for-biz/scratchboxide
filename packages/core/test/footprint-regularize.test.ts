/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import { describe, expect, it } from 'vitest';
import { findMainDirection, regularizeFootprint } from '../src/common/spatial/footprint-regularize';
import type { Vec2 } from '../src/common/spatial/staged-location-contracts';
import esbTier0Footprint from './fixtures/esb-tier0-footprint.json';

function ringArea(r: Vec2[]): number {
    let a = 0;
    for (let i = 0, j = r.length - 1; i < r.length; j = i++) a += r[j][0] * r[i][1] - r[i][0] * r[j][1];
    return a / 2;
}

function maxAngleErrorFromRightAngles(r: Vec2[]): number {
    const n = r.length;
    let worst = 0;
    for (let i = 0; i < n; i++) {
        const p = r[(i + n - 1) % n], q = r[i], s = r[(i + 1) % n];
        const u = [q[0] - p[0], q[1] - p[1]], v = [s[0] - q[0], s[1] - q[1]];
        const ang = Math.atan2(u[0] * v[1] - u[1] * v[0], u[0] * v[0] + u[1] * v[1]) * 180 / Math.PI;
        const nearestRight = Math.round(ang / 90) * 90;
        worst = Math.max(worst, Math.abs(ang - nearestRight));
    }
    return worst;
}

describe('findMainDirection', () => {
    it('reads a near-axis-aligned rectangle as 0 degrees', () => {
        const ring: Vec2[] = [[0, 0], [10, 0.3], [10.1, 5.2], [-0.1, 5]];
        expect(findMainDirection(ring)).toBeGreaterThanOrEqual(0);
        expect(findMainDirection(ring)).toBeLessThan(5);
    });

    it('reads a rectangle rotated 30 degrees as close to 30', () => {
        const rad = 30 * Math.PI / 180, c = Math.cos(rad), s = Math.sin(rad);
        const rot = (p: Vec2): Vec2 => [p[0] * c - p[1] * s, p[0] * s + p[1] * c];
        const ring: Vec2[] = [[0, 0], [20, 0], [20, 8], [0, 8]].map(p => rot(p as Vec2));
        const dir = findMainDirection(ring);
        expect(Math.min(Math.abs(dir - 30), Math.abs(dir - 30 - 90), Math.abs(dir - 30 + 90))).toBeLessThan(2);
    });
});

describe('regularizeFootprint', () => {
    it('straightens a noisy near-rectangle into near-perfect right angles without changing which way it winds', () => {
        const ring: Vec2[] = [[0, 0], [10.2, 0.4], [10.5, 5.1], [-0.3, 4.8]];
        const before = ringArea(ring);
        const { ring: out } = regularizeFootprint(ring);
        expect(out.length).toBeGreaterThanOrEqual(3);
        expect(maxAngleErrorFromRightAngles(out)).toBeLessThan(1);
        // winding direction preserved (sign of area unchanged)
        expect(Math.sign(ringArea(out))).toBe(Math.sign(before));
        // still roughly the same building (not collapsed or wildly displaced)
        expect(Math.abs(ringArea(out))).toBeGreaterThan(Math.abs(before) * 0.5);
        expect(Math.abs(ringArea(out))).toBeLessThan(Math.abs(before) * 2);
    });

    it('merges a wall captured as two adjacent near-collinear segments (double-wall scan noise) into one straight run', () => {
        // (0,0)-(5,0.05)-(10,0): the middle vertex is scan noise on an otherwise straight wall, only 0.05m off
        // the chord -- well under the 1m threshold. After merging, that vertex must sit exactly on the line
        // through its two ring-neighbours (a collinear, droppable corner), not be left as a real corner.
        const ring: Vec2[] = [[0, 0], [5, 0.05], [10, 0], [10, 5], [0, 5]];
        const { ring: out } = regularizeFootprint(ring, { parallelThresholdM: 1.0 });
        const i = out.findIndex(p => p[0] > 0 && p[0] < 10 && Math.abs(p[1]) < 1);
        expect(i).toBeGreaterThanOrEqual(0);
        const prev = out[(i + out.length - 1) % out.length], cur = out[i], next = out[(i + 1) % out.length];
        const u: Vec2 = [cur[0] - prev[0], cur[1] - prev[1]], v: Vec2 = [next[0] - cur[0], next[1] - cur[1]];
        // collinear (merged away, whether the path keeps going or doubles back on itself): the cross product of
        // the two edges either side of the old noisy corner vanishes relative to their lengths.
        const cross = Math.abs(u[0] * v[1] - u[1] * v[0]);
        expect(cross / (Math.hypot(...u) * Math.hypot(...v))).toBeLessThan(0.01);
    });

    it('bridges two parallel edges with a real gap between them instead of merging, unlike a threshold above the gap', () => {
        // two genuinely different wall heights (0 and 2) three horizontal-ish rungs apart; a threshold below the
        // 2m gap must keep them as distinct geometry (one extra vertex over the merge case), not collapse them.
        const ring: Vec2[] = [[0, 0], [10, 0.05], [0, 3.95], [10, 4], [10.05, 9]];
        const merged = regularizeFootprint(ring, { parallelThresholdM: 3.0 });
        const bridged = regularizeFootprint(ring, { parallelThresholdM: 0.5 });
        expect(bridged.ring.length).toBe(merged.ring.length + 1);
    });

    it('is a no-op-safe fallback on a degenerate ring (fewer than 3 usable points)', () => {
        const ring: Vec2[] = [[0, 0], [0, 0]];
        const result = regularizeFootprint(ring);
        expect(result.ring).toBe(ring);
        expect(result.mainDirectionDeg).toBe(0);
    });

    it('optionally snaps to 45 degrees when allow45 is set', () => {
        const rad = 45 * Math.PI / 180, c = Math.cos(rad), s = Math.sin(rad);
        const rot = (p: Vec2): Vec2 => [p[0] * c - p[1] * s, p[0] * s + p[1] * c];
        const ring: Vec2[] = [[0, 0], [10.3, 0.2], [10, 10.4], [-0.2, 10]].map(p => rot(p as Vec2));
        const { ring: out } = regularizeFootprint(ring, { allow45: true });
        expect(maxAngleErrorFromRightAngles(out)).toBeLessThan(1);
    });

    it('does not slice a stray long edge across a dense stairstep outline (Empire State Building tier-0, 2026-10-25)', () => {
        // On the ESB's raw scan footprint (341 vertices, a dense stairstep with many short alternating edges), a
        // near-parallel pair misclassified as perpendicular gave a poorly-conditioned line-line intersection that
        // landed ~57m from the real corner -- a stray diagonal slicing clean across the ~60x130m building. Every
        // edge must stay within the building's own scale, not jump to a distant, badly-conditioned intersection.
        const ring = esbTier0Footprint as unknown as Vec2[];
        const { ring: out } = regularizeFootprint(ring, { parallelThresholdM: 1.5 });
        let maxEdge = 0;
        for (let i = 0; i < out.length; i++) {
            const a = out[i], b = out[(i + 1) % out.length];
            maxEdge = Math.max(maxEdge, Math.hypot(b[0] - a[0], b[1] - a[1]));
        }
        // the building's own longest real wall run is on the order of 60m; a mis-bridged corner showed up as ~57m
        // where the local edges around it were only a couple of metres -- cap well under that failure's scale
        expect(maxEdge).toBeLessThan(20);
    });
});
