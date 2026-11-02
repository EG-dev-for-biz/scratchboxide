/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import { describe, it, expect } from 'vitest';
import { SplatEditIndex, applySplatStroke, replaySplatEdits, type SplatEditStroke } from '../src/common/spatial/splat-edits';

/** A 10 m x 10 m wall at z = 0, a splat every 5 cm, grey and opaque. */
function wall() {
    const n = 200;
    const count = n * n;
    const positions = new Float32Array(count * 3);
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
        const k = i * n + j;
        positions[k * 3] = -5 + i * 0.05; positions[k * 3 + 1] = j * 0.05; positions[k * 3 + 2] = 0;
    }
    const base = new Uint8Array(count * 4);
    for (let k = 0; k < count; k++) { base[k * 4] = 120; base[k * 4 + 1] = 120; base[k * 4 + 2] = 120; base[k * 4 + 3] = 255; }
    return { positions, count, base, index: new SplatEditIndex(positions, count) };
}

const near = (positions: Float32Array, k: number, x: number, y: number, r: number) =>
    Math.hypot(positions[k * 3] - x, positions[k * 3 + 1] - y) <= r;

describe('splat edits', () => {
    it('erases exactly the splats within the brush along the stroke, filling between its points', () => {
        const { positions, count, base, index } = wall();
        const rgba = base.slice();
        const stroke: SplatEditStroke = { op: 'erase', points: [-2, 5, 0, 2, 5, 0], radius: 0.3 };
        const changed = applySplatStroke(index, base, rgba, stroke);
        let erased = 0, wrong = 0;
        for (let k = 0; k < count; k++) {
            const inBand = Math.abs(positions[k * 3 + 1] - 5) <= 0.3001 && positions[k * 3] >= -2.3001 && positions[k * 3] <= 2.3001;
            if (rgba[k * 4 + 3] === 0) { erased++; if (!inBand) wrong++; }
        }
        expect(changed).toBe(erased);
        expect(wrong).toBe(0);
        // the middle of the stroke, far from both points, is erased too (no beads)
        const mid = 100 * 200 + 100;   // x = 0, y = 5
        expect(rgba[mid * 4 + 3]).toBe(0);
        // the capsule: every splat clear of its edge between the points is erased (rows at |y - 5| = 0.3 fall a float
        // rounding hair outside), and the rounded ends add more
        let between = 0;
        for (let k = 0; k < count; k++) if (Math.abs(positions[k * 3 + 1] - 5) <= 0.2999 && Math.abs(positions[k * 3]) <= 1.9999 && rgba[k * 4 + 3] === 0) between++;
        expect(between).toBe(11 * 79);
        expect(erased).toBeGreaterThan(11 * 81);
    });

    it('restores what was erased from the build, and paints toward a colour by the brush weight', () => {
        const { positions, count, base, index } = wall();
        const rgba = base.slice();
        applySplatStroke(index, base, rgba, { op: 'erase', points: [0, 5, 0], radius: 1 });
        applySplatStroke(index, base, rgba, { op: 'restore', points: [0, 5, 0], radius: 0.5 });
        for (let k = 0; k < count; k++) {
            // clear of the brushes' edges, where float rounding decides
            if (near(positions, k, 0, 5, 0.48)) expect(rgba[k * 4 + 3]).toBe(255);
            else if (!near(positions, k, 0, 5, 0.52) && near(positions, k, 0, 5, 0.95)) expect(rgba[k * 4 + 3]).toBe(0);
        }
        const painted = base.slice();
        applySplatStroke(index, base, painted, { op: 'paint', points: [0, 5, 0], radius: 1, color: [1, 0, 0], strength: 1 });
        const centre = 100 * 200 + 100, edge = 100 * 200 + 118;   // 0 m and 0.9 m from the brush centre
        expect(painted[centre * 4]).toBe(255);
        expect(painted[centre * 4 + 1]).toBe(0);
        expect(painted[edge * 4]).toBeGreaterThan(120);
        expect(painted[edge * 4]).toBeLessThan(200);
        expect(painted[centre * 4 + 3]).toBe(255);
    });

    it('replays strokes over the build: the same strokes give the same splats, and none gives the build', () => {
        const { base, index } = wall();
        const strokes: SplatEditStroke[] = [
            { op: 'paint', points: [1, 2, 0, 1, 3, 0], radius: 0.4, color: [0, 0.5, 1], strength: 0.7 },
            { op: 'erase', points: [-1, 6, 0], radius: 0.6 },
            { op: 'restore', points: [-1, 6, 0], radius: 0.2 }
        ];
        const a = base.slice(), b = base.slice();
        replaySplatEdits(index, base, a, strokes);
        for (const s of strokes) applySplatStroke(index, base, b, s);
        expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
        replaySplatEdits(index, base, a, []);
        expect(Buffer.from(a).equals(Buffer.from(base))).toBe(true);
    });

    it('picks the nearest drawn splat along a ray, and skips erased ones', () => {
        const { positions, count, base } = wall();
        // a second wall 2 m behind the first
        const back = new Float32Array(count * 3);
        for (let k = 0; k < count; k++) { back[k * 3] = positions[k * 3]; back[k * 3 + 1] = positions[k * 3 + 1]; back[k * 3 + 2] = -2; }
        const both = new Float32Array([...positions, ...back]);
        const rgba = new Uint8Array([...base, ...base]);
        const idx = new SplatEditIndex(both, count * 2);
        const tol = (t: number) => Math.max(0.03, 0.002 * t);
        const hit = idx.pick([0.01, 5.01, 10], [0, 0, -1], rgba, 100, tol);
        expect(hit).toBeDefined();
        expect(both[hit!.index * 3 + 2]).toBe(0);
        expect(hit!.t).toBeCloseTo(10, 1);
        applySplatStroke(idx, rgba, rgba, { op: 'erase', points: [0, 5, 0], radius: 0.5 });
        const through = idx.pick([0.01, 5.01, 10], [0, 0, -1], rgba, 100, tol);
        expect(both[through!.index * 3 + 2]).toBe(-2);
        expect(idx.pick([0, 50, 10], [0, 0, -1], rgba, 100, tol)).toBeUndefined();
    });
});
