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
