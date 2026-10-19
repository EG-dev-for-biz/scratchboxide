/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The shared plausibility check (common/spatial/plausibility.ts) on synthetic values in and out of range, and where it is
 * wired: location_building_shape's heights, the facade grammar's storeys, bays and openings. Flags only: the values given
 * come back unchanged.
 */

import { describe, it, expect } from 'vitest';
import {
    checkDimension, checkDimensions, checkHeightForStoreys, plausibilitySummary, DIMENSION_RANGES
} from '../src/common/spatial/plausibility';
import { buildingPlausibility } from '../src/node/gemini/tools/location-evidence/building-shape';
import { grammarPlausibility, type FacadeGrammar } from '../src/node/3d-engine/staged-location/facade-grammar';

describe('plausibility: one value against its dimension', () => {
    it('says nothing about values inside the typical span', () => {
        for (const [dim, v] of [['storeyHeight', 3.2], ['groundStoreyHeight', 6.5], ['doorHeight', 2.1], ['stepRiser', 0.17], ['windowHeight', 1.6],
            ['windowWidth', 1.1], ['parapetHeight', 0.9], ['bayWidth', 3.4], ['buildingHeight', 21]] as const) {
            expect(checkDimension(dim, v)).toBeUndefined();
        }
    });

    it('flags a storey of 9.1 m as implausible, with the range and the cause, and keeps the value', () => {
        const f = checkDimension('storeyHeight', 9.1, { cause: 'fit or grammar' })!;
        expect(f.severity).toBe('implausible');
        expect(f.valueM).toBe(9.1);
        expect(f.typicalRangeM).toEqual([2.6, 5]);
        expect(f.message).toBe('storey height 9.1 m is outside 2.6–5 m: probable fit or grammar error');
    });

    it('flags values between the typical and the possible span as unusual, not as errors', () => {
        const f = checkDimension('storeyHeight', 6.2)!;
        expect(f.severity).toBe('unusual');
        expect(f.message).toContain('unusual');
        // a tall ground storey is typical where an upper storey of that height is not
        expect(checkDimension('groundStoreyHeight', 6.2)).toBeUndefined();
        expect(checkDimension('doorHeight', 1.5)!.severity).toBe('implausible');
        expect(checkDimension('stepRiser', 0.25)!.severity).toBe('unusual');
        expect(checkDimension('stepRiser', 0.4)!.severity).toBe('implausible');
        expect(checkDimension('stepRiser', 0.05)!.severity).toBe('implausible');
        expect(checkDimension('parapetHeight', 5)!.severity).toBe('implausible');
        expect(checkDimension('windowWidth', 0.1)!.severity).toBe('implausible');
        expect(checkDimension('buildingHeight', 1.2)!.severity).toBe('implausible');
        expect(checkDimension('buildingHeight', 900)!.severity).toBe('implausible');
    });

    it('labels the measurement and ignores non-finite values and unknown dimensions', () => {
        expect(checkDimension('windowHeight', 0.3, { label: 'facade 2, tier 1 opening height' })!.message).toMatch(/^facade 2, tier 1 opening height \(window height\) 0\.3 m is outside 0\.6–3 m/);
        expect(checkDimension('storeyHeight', NaN)).toBeUndefined();
        expect(checkDimension('a dimension nobody gave a range for', 99)).toBeUndefined();
        // a caller's own range, for a dimension the table does not hold (no code change needed)
        const own = checkDimension('kerbHeight', 0.6, { range: { noun: 'kerb height', typical: [0.08, 0.2], possible: [0.03, 0.4] } })!;
        expect(own.severity).toBe('implausible');
        expect(own.message).toContain('kerb height 0.6 m is outside 0.08–0.2 m');
    });

    it('lists only the flagged values, in order, and summarises them', () => {
        const flags = checkDimensions([
            { dimension: 'storeyHeight', valueM: 3.1 }, { dimension: 'storeyHeight', valueM: 9.1, label: 'storey 2' },
            { dimension: 'bayWidth', valueM: undefined }, { dimension: 'stepRiser', valueM: 0.4 }
        ]);
        expect(flags.map(f => f.label)).toEqual(['storey 2', 'step riser']);
        expect(plausibilitySummary(flags)).toMatch(/^plausibility: 2 warnings \(storey 2 \(storey height\) 9\.1 m/);
        expect(plausibilitySummary([])).toBe('');
    });

    it('every range nests its typical span inside its possible one', () => {
        for (const r of Object.values(DIMENSION_RANGES)) {
            expect(r.possible[0]).toBeLessThanOrEqual(r.typical[0]);
            expect(r.typical[0]).toBeLessThan(r.typical[1]);
            expect(r.typical[1]).toBeLessThanOrEqual(r.possible[1]);
        }
    });
});

describe('plausibility: building height against its storeys', () => {
    it('accepts a height the storeys can make, and flags one they cannot', () => {
        expect(checkHeightForStoreys(21, 6)).toBeUndefined();            // 3.5 m a storey
        expect(checkHeightForStoreys(9.5, 2)).toBeUndefined();           // a tall ground floor and a parapet
        const low = checkHeightForStoreys(8, 6)!;                        // 1.3 m a storey
        expect(low.severity).toBe('implausible');
        expect(low.message).toContain('8 m for 6 storeys (1.3 m a storey)');
        const high = checkHeightForStoreys(40, 3)!;                      // 13 m a storey
        expect(high.severity).toBe('implausible');
        expect(checkHeightForStoreys(20, 0)).toBeUndefined();
    });
});

describe('plausibility where it is wired', () => {
    it('location_building_shape flags its vector and DSM heights, and checks them against a storey count', () => {
        expect(buildingPlausibility(18, 19.5)).toEqual([]);
        const f = buildingPlausibility(1.1, 19.5, 6);
        expect(f.map(x => x.label)).toEqual(['vector height', 'vector height for 6 storeys']);
        expect(f[0].message).toContain('probable vector data error');
        expect(buildingPlausibility(19, 60, 6).map(x => x.label)).toEqual(['Solar DSM main roof height for 6 storeys']);
    });

    it('the facade grammar flags a storey, an opening and a bay out of range, and nothing in range', () => {
        const g: Pick<FacadeGrammar, 'facadeId' | 'storeyHeightsM' | 'openings'> = {
            facadeId: 7,
            storeyHeightsM: [4.6, 3.4, 9.1],
            openings: [
                { widthM: 1.2, heightM: 2.0, sillM: 0, bayPitchM: 3.1, count: 5 },
                { widthM: 1.1, heightM: 1.7, sillM: 4.6, bayPitchM: 3.1, count: 5 },
                { widthM: 0.1, heightM: 1.7, sillM: 8, bayPitchM: 22, count: 5 },
                { widthM: 1.1, heightM: 1.7, sillM: 17, bayPitchM: 0, count: 1 }
            ]
        };
        const flags = grammarPlausibility(g);
        expect(flags.map(f => f.label)).toEqual(['facade 7, storey 3', 'facade 7, tier 3 opening width', 'facade 7, tier 3 bay width']);
        expect(flags[0].message).toBe('facade 7, storey 3 (storey height) 9.1 m is outside 2.6–5 m: probable fit or grammar error');
        // the grammar is unchanged
        expect(g.storeyHeightsM).toEqual([4.6, 3.4, 9.1]);
        expect(grammarPlausibility({ facadeId: 1, storeyHeightsM: [4.2, 3.3], openings: [{ widthM: 1.2, heightM: 1.8, sillM: 1, bayPitchM: 3, count: 4 }] })).toEqual([]);
    });
});
