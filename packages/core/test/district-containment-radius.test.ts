/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Atomic building integrity for a district build (orchestrator.ts districtContainmentRadiusM): a building the base
 * radius already reaches at least one vertex of, but whose own footprint extends past it, grows the extraction
 * radius to include it whole - the fix for a tower split at its own tile seam, user report 2026-10-21 with a
 * screenshot (its top jogged sideways from its base).
 */

import { describe, expect, it } from 'vitest';
import { districtContainmentRadiusM } from '../src/node/3d-engine/staged-location/orchestrator';
import type { VectorEvidence } from '../src/node/3d-engine/staged-location/vector-footprints';
import type { Vec2 } from '../src/common/spatial/staged-location-contracts';

const square = (cx: number, cz: number, half: number): Vec2[] => [[cx - half, cz - half], [cx + half, cz - half], [cx + half, cz + half], [cx - half, cz + half]];
const ev = (buildings: Array<{ id: string; ring: Vec2[] }>): VectorEvidence =>
    ({ buildings: buildings.map(b => ({ id: b.id, parts: [[b.ring]] })), water: [], roads: [], tiles: 1, zoom: 18 });

describe('districtContainmentRadiusM', () => {
    it('leaves the base radius unchanged when every building the base radius reaches is already whole inside it', () => {
        const r = districtContainmentRadiusM(ev([{ id: 'a', ring: square(10, 10, 5) }]), 60);
        expect(r).toBe(60);
    });

    it('grows to include a building the base radius only partly reaches (its footprint extends past it)', () => {
        // centred 55 m out, a 20 m-wide footprint: its near corner is inside a 60 m radius, its far corner at ~75 m is not
        const r = districtContainmentRadiusM(ev([{ id: 'tower', ring: square(55, 0, 10) }]), 60);
        expect(r).toBeCloseTo(Math.hypot(65, 10), 6); // the building's own farthest corner
        expect(r).toBeGreaterThan(60);
    });

    it('ignores a building the base radius never reaches at all (outside a fixed-radius request, not what this fixes)', () => {
        const r = districtContainmentRadiusM(ev([{ id: 'far', ring: square(200, 0, 10) }]), 60);
        expect(r).toBe(60);
    });

    it('caps the growth so one oversized building near the edge cannot balloon the whole extraction', () => {
        // a long thin footprint (a row of connected buildings, say) with a near corner at ~50 m and a far corner at ~250 m
        const longRow: Vec2[] = [[50, -5], [250, -5], [250, 5], [50, 5]];
        const r = districtContainmentRadiusM(ev([{ id: 'huge', ring: longRow }]), 60);
        expect(r).toBe(160); // 60 + the 100 m cap, not the building's real ~250 m extent
    });

    it('grows to the farthest building that needs it among several, not just the first', () => {
        const r = districtContainmentRadiusM(ev([
            { id: 'small', ring: square(55, 0, 10) },   // reaches to ~65 m
            { id: 'big', ring: square(55, 30, 20) }     // reaches further: hypot(75, 50) ~= 90 m
        ]), 60);
        expect(r).toBeGreaterThan(80);
    });
});

describe('districtContainment', () => {
    it('grows round after round until no building it reaches runs past it', async () => {
        const { districtContainment } = await import('../src/node/3d-engine/staged-location/orchestrator');
        // a chain: the first reaches past 60 to 75, the next starts at 72 and reaches 90
        const e = ev([{ id: 'a', ring: [[50, -2], [75, -2], [75, 2], [50, 2]] }, { id: 'b', ring: [[72, 10], [90, 10], [90, 14], [72, 14]] }]);
        const r = await districtContainment(async () => e, 60);
        expect(r.capped).toBeUndefined();
        expect(r.radiusM).toBeCloseTo(Math.hypot(90, 14), 6);
        expect(r.rounds).toBe(3);
    });

    it('says what the cap still cuts', async () => {
        const { districtContainment } = await import('../src/node/3d-engine/staged-location/orchestrator');
        const r = await districtContainment(async () => ev([{ id: 'huge', ring: [[50, -5], [250, -5], [250, 5], [50, 5]] }]), 60);
        expect(r.radiusM).toBe(160);
        expect(r.capped).toEqual({ capM: 160, cut: 1, neededM: 250 });
    });
});
