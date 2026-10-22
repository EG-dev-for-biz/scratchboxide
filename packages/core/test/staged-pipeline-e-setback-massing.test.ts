/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * A stepped/setback building (one flat Google vector footprint + one vector height - the common case, no modelled
 * volume) must not be flattened to a single box when the scan's own heightfield already shows the real setback.
 * Synthetic scanTop only: no network, no model.
 */

import { describe, expect, it } from 'vitest';
import { buildMassing, detectHeightTiers, insetRing, ringArea } from '../src/node/3d-engine/staged-location/pipeline-e/massing-spec';

/** A 40x40 m base, stepped back to a 16x16 m tower above 30 m, up to 45 m: two real tiers. */
const BASE: Array<[number, number]> = [[0, 0], [40, 0], [40, 40], [0, 40]];
const TOWER_LO = 12, TOWER_HI = 28;
function scanTop(x: number, z: number): number {
    if (x >= TOWER_LO && x <= TOWER_HI && z >= TOWER_LO && z <= TOWER_HI) return 45;
    return 30;
}

describe('insetRing', () => {
    it('moves a square ring inward on every edge, keeping its shape and corner count', () => {
        const square: Array<[number, number]> = [[0, 0], [40, 0], [40, 40], [0, 40]];
        const inset = insetRing(square, 5)!;
        expect(inset).toBeDefined();
        expect(inset.length).toBe(4); // still a clean rectangle, not a stairstepped trace
        expect(Math.abs(ringArea(inset))).toBeCloseTo(30 * 30, 3); // 40-2*5 per side
    });

    it('refuses to collapse the ring when the inset is too large for its own footprint', () => {
        const square: Array<[number, number]> = [[0, 0], [10, 0], [10, 10], [0, 10]];
        expect(insetRing(square, 8)).toBeUndefined();
    });
});

describe('detectHeightTiers', () => {
    it('finds the setback tower nested inside the wider base, not noise on a flat roof', () => {
        const tiers = detectHeightTiers([BASE], scanTop, 0);
        expect(tiers).toBeDefined();
        expect(tiers!.length).toBe(2);
        expect(tiers![0].baseY).toBe(0);
        expect(Math.abs(tiers![0].topY - 30)).toBeLessThanOrEqual(1); // within the 1 m T-stepping grid
        expect(tiers![1].topY).toBeGreaterThan(40);
        // the upper tier's footprint must sit inside the lower tier's, and be the smaller one
        const area0 = Math.abs(ringArea(tiers![0].loop)), area1 = Math.abs(ringArea(tiers![1].loop));
        expect(area1).toBeLessThan(area0);
        expect(area1).toBeGreaterThan(200); // ~16x16
        expect(area1).toBeLessThan(320);
        // the tier's shape is the base ring's own rectangle, inset - not a traced, stairstepped scan outline
        expect(tiers![1].loop.length).toBe(4);
    });

    it('returns undefined for a flat roof (no real step, just scan noise)', () => {
        const flat = detectHeightTiers([BASE], () => 20 + Math.random() * 0.1, 0);
        expect(flat).toBeUndefined();
    });
});

describe('buildMassing with a stepped scan under one flat vector footprint', () => {
    it('emits two nested parts instead of flattening the tower into the base', () => {
        const building = { id: 'tower', parts: [], extruded: [{ loops: [BASE], heightM: 30 }] };
        const cells = new Set<string>();
        for (let x = 0; x < 40; x++) for (let z = 0; z < 40; z++) cells.add(`${x},${z}`);
        const massing = buildMassing({ buildings: [building], groundY: 0, scanTop, cells });
        expect(massing.parts.length).toBe(2);
        const tallest = Math.max(...massing.parts.map(p => p.topY));
        expect(tallest).toBeGreaterThan(40); // the real tower height, not the vector's flat 30 m
        expect(massing.notes.some(n => /stepped tiers detected/.test(n))).toBe(true);
    });

    it('still emits one flat part when the vector height already agrees with a flat scan', () => {
        const building = { id: 'box', parts: [], extruded: [{ loops: [BASE], heightM: 20 }] };
        const cells = new Set<string>();
        for (let x = 0; x < 40; x++) for (let z = 0; z < 40; z++) cells.add(`${x},${z}`);
        const massing = buildMassing({ buildings: [building], groundY: 0, scanTop: () => 20, cells });
        expect(massing.parts.length).toBe(1);
        expect(massing.parts[0].topY).toBeCloseTo(20, 0);
    });
});

describe('TriangleRayIndex (orientOutward\'s ray test)', () => {
    it('answers every ray exactly as testing each triangle with rayHit does, and orientOutward is unchanged', async () => {
        const { TriangleRayIndex, rayHit, orientOutward } = await import('../src/node/3d-engine/staged-location/pipeline-e/massing-spec');
        // a closed, non-convex volume: a 20 x 30 x 12 m block with a 6 x 6 x 25 m tower standing out of its roof, each face
        // split into a grid of triangles, some wound the wrong way
        const V: Array<[number, number, number]> = [], I: number[] = [];
        const box = (lo: number[], hi: number[], n: number) => {
            const faces: Array<(u: number, v: number) => number[]> = [
                (u, v) => [lo[0] + u * (hi[0] - lo[0]), hi[1], lo[2] + v * (hi[2] - lo[2])], (u, v) => [lo[0] + v * (hi[0] - lo[0]), lo[1], lo[2] + u * (hi[2] - lo[2])],
                (u, v) => [lo[0] + u * (hi[0] - lo[0]), lo[1] + v * (hi[1] - lo[1]), lo[2]], (u, v) => [lo[0] + v * (hi[0] - lo[0]), lo[1] + u * (hi[1] - lo[1]), hi[2]],
                (u, v) => [lo[0], lo[1] + u * (hi[1] - lo[1]), lo[2] + v * (hi[2] - lo[2])], (u, v) => [hi[0], lo[1] + v * (hi[1] - lo[1]), lo[2] + u * (hi[2] - lo[2])]
            ];
            for (const f of faces) for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
                const b = V.length;
                V.push(f(i / n, j / n) as [number, number, number], f((i + 1) / n, j / n) as [number, number, number], f((i + 1) / n, (j + 1) / n) as [number, number, number], f(i / n, (j + 1) / n) as [number, number, number]);
                const flip = (i + j) % 3 === 0;
                I.push(...(flip ? [b, b + 2, b + 1, b, b + 3, b + 2] : [b, b + 1, b + 2, b, b + 2, b + 3]));
            }
        };
        box([0, 0, 0], [20, 12, 30], 4);
        box([7, 12, 12], [13, 37, 18], 3);
        const index = new TriangleRayIndex(V, I);
        const T = I.length / 3;
        let rng = 7;
        const rand = () => ((rng = (rng * 1103515245 + 12345) % 2147483648) / 2147483648);
        let hits = 0;
        for (let r = 0; r < 3000; r++) {
            const o = [rand() * 40 - 10, rand() * 45 - 4, rand() * 50 - 10];
            const d0 = [rand() - 0.5, rand() - 0.5, rand() - 0.5], l = Math.hypot(...d0), d = d0.map(x => x / l);
            const skip = Math.floor(rand() * T);
            let brute = false;
            for (let t = 0; t < T && !brute; t++) if (t !== skip && rayHit(o, d, V[I[t * 3]], V[I[t * 3 + 1]], V[I[t * 3 + 2]]) > 0) brute = true;
            expect(index.anyHit(o, d, skip)).toBe(brute);
            if (brute) hits++;
        }
        expect(hits).toBeGreaterThan(300);
        // orientOutward with the index gives exactly the triangles the all-pairs test gave (the algorithm before the index)
        const { mesh, flipped } = orientOutward({ id: 'v', vertices: V, indices: I });
        const dirs: number[][] = [];
        for (let i = 0, g = Math.PI * (3 - Math.sqrt(5)); i < 32; i++) { const y = 1 - (2 * (i + 0.5)) / 32, rr = Math.sqrt(1 - y * y), a = g * i; dirs.push([Math.cos(a) * rr, y, Math.sin(a) * rr]); }
        const BARY = [[1 / 3, 1 / 3], [0.7, 0.15], [0.15, 0.7], [0.15, 0.15], [0.45, 0.45], [0.45, 0.1], [0.1, 0.45]];
        const out = I.slice();
        let brutelyFlipped = 0;
        const escapes = (o: number[], side: number[], self: number) => {
            let n = 0;
            for (const d of dirs) {
                if (d[0] * side[0] + d[1] * side[1] + d[2] * side[2] < 0.05) continue;
                let blocked = false;
                for (let q = 0; q < T && !blocked; q++) if (q !== self && rayHit(o, d, V[out[q * 3]], V[out[q * 3 + 1]], V[out[q * 3 + 2]]) > 0) blocked = true;
                if (!blocked) n++;
            }
            return n;
        };
        for (let t = 0; t < T; t++) {
            const a = V[out[t * 3]], b = V[out[t * 3 + 1]], c = V[out[t * 3 + 2]];
            const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], w = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
            const nv = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]];
            const len = Math.hypot(nv[0], nv[1], nv[2]);
            if (len < 1e-12) continue;
            const nn = nv.map(x => x / len), back = nn.map(x => -x);
            let front = 0, behind = 0;
            for (const [l1, l2] of BARY) {
                const l3 = 1 - l1 - l2;
                const p = [0, 1, 2].map(k => l1 * a[k] + l2 * b[k] + l3 * c[k]);
                front += escapes(p.map((x, k) => x + nn[k] * 1e-3), nn, t);
                behind += escapes(p.map((x, k) => x - nn[k] * 1e-3), back, t);
            }
            if (behind > front) { const tmp = out[t * 3 + 1]; out[t * 3 + 1] = out[t * 3 + 2]; out[t * 3 + 2] = tmp; brutelyFlipped++; }
        }
        expect(mesh.indices).toEqual(out);
        expect(flipped).toBe(brutelyFlipped);
        expect(flipped).toBeGreaterThan(20);
    });
});

describe('detectHeightTiers: a tier must stand where it is put', () => {
    it('does not read a neighbour\'s wall scanned along a shared edge as an upper tier, and still finds a real setback', async () => {
        const { detectHeightTiers } = await import('../src/node/3d-engine/staged-location/pipeline-e/massing-spec');
        const ring: Array<[number, number]> = [[0, 0], [10, 0], [10, 20], [0, 20]];
        // a row building with a 24 m roof; its last 1.5 m along x = 10 is the next building's 55 m wall, as the scan's top shows it
        const strip = (x: number, z: number) => (x >= 8.5 ? 55 : 24);
        const t = detectHeightTiers([ring], strip, 0);
        expect(t === undefined || t.every(tier => tier.topY < 30)).toBe(true);
        // a real setback: the middle 6 x 14 m rises to 40 m
        const setback = (x: number, z: number) => (x >= 2 && x <= 8 && z >= 3 && z <= 17 ? 40 : 24);
        const s = detectHeightTiers([ring], setback, 0)!;
        expect(s).toBeDefined();
        expect(s.length).toBe(2);
        expect(s[1].topY).toBeGreaterThan(38);
        expect(s[0].topY).toBeGreaterThan(22);
        expect(s[0].topY).toBeLessThan(26);
    });
});
