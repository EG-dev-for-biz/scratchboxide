/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Pass-through scan pieces redundant with the fitted surface (redundant-scan.ts): a fitted wall, a noisy scan copy of it
 * 5 cm in front, a statue-sized lump 1 m proud, a fragment past the wall's edge and one straddling it. The copy is hidden,
 * the lump and the uncovered fragment kept, the straddling fragment clipped at the wall's edge; everything hidden has the
 * wall behind it (no holes).
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { hideRedundantScan } from '../src/node/3d-engine/staged-location/redundant-scan';
import type { GlbNode } from '../src/node/3d-engine/staged-location/glb-nodes';
import { renderClayPng } from './helpers/clay-glb-render';
import { area, lump, noise, patch } from './helpers/redundant-scan-fixtures';

const SHOTS = path.resolve(__dirname, '../../../test-results/screenshots/hide_redundant_scan');

describe('pass-through pieces redundant with the fitted surface', () => {
    // the fitted wall: x 0..10, y 0..8 in z = 0, one surface "s00" with a 3 cm scan rms
    const wall = patch('s00', 0, 10, 0, 8, 1, () => 0);
    const surfaces = [{ id: 's00', fit: { rmsM: 0.03, p50M: 0.02, p95M: 0.06, maxM: 0.1, samples: 100, areaM2: 80 } }];
    const copy = patch('r0', 1, 9, 1, 7, 0.25, (x, y) => -0.05 + noise(x, y));
    const statue = lump('r1', [5, 4, -1.3], 0.6);
    const uncovered = patch('r2', 11, 12.5, 2, 4, 0.25, (x, y) => -0.05 + noise(x, y));
    const straddle = patch('r3', 9, 11, 5, 6, 0.5, () => -0.04);
    const result = hideRedundantScan([copy, statue, uncovered, straddle], [wall], surfaces);
    const region = (name: string) => result.report.regions.find(r => r.name === name)!;

    it('hides the copy on the wall, keeps the proud lump and the fragment with no wall behind it', () => {
        expect(region('r0')).toMatchObject({ trianglesIn: copy.indices!.length / 3, trianglesHidden: copy.indices!.length / 3, trianglesSplit: 0 });
        expect(region('r0').areaHiddenM2).toBeCloseTo(area(copy), 1);
        expect(result.visible.find(n => n.name === 'r0')).toBeUndefined();
        expect(region('r0').offsetMedianM!).toBeGreaterThan(0.03);
        expect(region('r0').offsetMaxM!).toBeLessThanOrEqual(0.1);
        expect(region('r0').surfaceIds).toEqual(['s00']);
        for (const name of ['r1', 'r2']) {
            expect(region(name)).toMatchObject({ trianglesHidden: 0, trianglesSplit: 0, areaHiddenM2: 0 });
            expect(result.hidden.find(n => n.name === name)).toBeUndefined();
        }
        expect(area(result.visible.find(n => n.name === 'r1')!)).toBeCloseTo(area(statue), 6);
        expect(area(result.visible.find(n => n.name === 'r2')!)).toBeCloseTo(area(uncovered), 6);
        // the tolerance comes from the surface's own residual (3 x 3 cm, inside [0.10, 0.15])
        expect(result.report.toleranceM).toMatchObject({ min: 0.1, max: 0.1, bySurface: { s00: 0.1 } });
    });

    it('clips a fragment at the wall edge: the part over the wall hidden, the part past it kept, nothing lost', () => {
        const r = region('r3');
        expect(r.trianglesSplit + r.trianglesHidden).toBeGreaterThan(0);
        const hid = result.hidden.find(n => n.name === 'r3')!, kept = result.visible.find(n => n.name === 'r3')!;
        expect(area(hid) + area(kept)).toBeCloseTo(area(straddle), 6);
        // the wall ends at x = 10: the hidden part is exactly the 1 m² over it (clipped with straight edges; the prisms reach 1 mm past each face edge, up to 2.6 mm at a 45-degree corner)
        for (let i = 0; i < hid.positions.length; i += 3) expect(hid.positions[i]).toBeLessThanOrEqual(10 + 2.6e-3);
        expect(area(hid)).toBeCloseTo(1, 2);
        for (let i = 0; i < kept.positions.length; i += 3) expect(kept.positions[i]).toBeGreaterThanOrEqual(10 + -2.6e-3);
    });

    it('clips a large tilted piece exactly where it leaves the tolerance slab (a straight edge, no staircase)', () => {
        // one 6 m² triangle leaning out of the wall: z from 0 at y = 1 to -0.6 at y = 5
        const lean = (y: number) => -0.15 * (y - 1);
        const piece: GlbNode = { name: 'r4', positions: Float32Array.from([2, 1, lean(1), 5, 1, lean(1), 2, 5, lean(5)]), indices: Uint32Array.from([0, 1, 2]) };
        const r = hideRedundantScan([piece], [wall], surfaces);
        expect(r.report.regions[0]).toMatchObject({ trianglesIn: 1, trianglesSplit: 1, trianglesHidden: 0 });
        // |z| <= 0.1 for y <= 1 + 0.1 / 0.15: the strip of the triangle below that line (a trapezoid)
        const yCut = 1 + 0.1 / 0.15, w = (y: number) => 3 * (1 - (y - 1) / 4);
        expect(area(r.hidden[0])).toBeCloseTo((w(1) + w(yCut)) / 2 * (yCut - 1) * Math.hypot(1, 0.15), 4); // the strip leans 0.15 m per m
        const H = r.hidden[0].positions;
        for (let i = 0; i < H.length; i += 3) expect(H[i + 1]).toBeLessThanOrEqual(yCut + 1e-4);
        expect(area(r.hidden[0]) + area(r.visible[0])).toBeCloseTo(area(piece), 6);
    });

    it('opens no hole: every hidden piece has the wall within the tolerance behind every point of it', () => {
        for (const n of result.hidden) {
            const P = n.positions, I = n.indices!;
            for (let t = 0; t < I.length; t += 3) {
                const v = [0, 1, 2].map(k => [P[I[t + k] * 3], P[I[t + k] * 3 + 1], P[I[t + k] * 3 + 2]]);
                for (let s = 0; s <= 6; s++) for (let q = 0; q <= 6 - s; q++) {
                    const w = [s / 6, q / 6, 1 - s / 6 - q / 6];
                    const p = [0, 1, 2].map(k => w[0] * v[0][k] + w[1] * v[1][k] + w[2] * v[2][k]);
                    expect(p[0]).toBeGreaterThanOrEqual(-2.6e-3); expect(p[0]).toBeLessThanOrEqual(10 + 2.6e-3);
                    expect(p[1]).toBeGreaterThanOrEqual(-2.6e-3); expect(p[1]).toBeLessThanOrEqual(8 + 2.6e-3);
                    expect(Math.abs(p[2])).toBeLessThanOrEqual(0.1 + 1e-5);
                }
            }
        }
        expect(result.report.areaHiddenM2 + result.report.areaKeptM2).toBeCloseTo(result.report.areaInM2, 1);
    });

    it('screenshot: kept (grey) and hidden (orange) over the fitted wall (blue)', () => {
        fs.mkdirSync(SHOTS, { recursive: true });
        const mesh = (n: GlbNode, color?: [number, number, number]) => ({ positions: n.positions, indices: n.indices!, ...(color ? { color } : {}) });
        const png = renderClayPng([
            mesh({ ...wall, positions: wall.positions.map((v, i) => (i % 3 === 2 ? v + 0.3 : v)) }, [0.35, 0.5, 0.8]),
            ...result.visible.map(n => mesh(n)), ...result.hidden.map(n => mesh(n, [0.95, 0.55, 0.1]))
        ], { kind: 'aerial', width: 900, height: 600, region: [-1, -2, 13, 1], bearingDeg: 180, elevationDeg: 20 });
        fs.writeFileSync(path.join(SHOTS, 'synthetic_wall_copy_statue_fragments.png'), png);
        expect(png.length).toBeGreaterThan(1000);
    });
});
