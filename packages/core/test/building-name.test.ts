/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * A staged building's names (staged-location/building-name.ts): Google's named POIs inside the footprint or within 5 m
 * of it, inside first then by distance, each carrying its type codes as labels; the request's own phrase (the query minus
 * the address) as a candidate and the fallback primary; blank names ignored; a POI far from the footprint never a name.
 * Pure: no model, no network.
 */

import { describe, expect, it } from 'vitest';
import { decideBuildingNames, footprintDistanceM, localityOf, POI_NEAR_M, requestPhrase } from '../src/node/3d-engine/staged-location/building-name';
import type { Vec2 } from '../src/common/spatial/staged-location-contracts';

// a 20 x 12 m footprint (scan frame), one part, one outer ring
const RING: Vec2[] = [[0, 0], [20, 0], [20, -12], [0, -12]];
const PARTS: Vec2[][][] = [[RING]];
const ADDRESS = '175 5th Ave, New York, NY 10010, USA';

describe('footprintDistanceM', () => {
    it('is 0 inside a part, the distance to the nearest edge outside, and respects a hole', () => {
        expect(footprintDistanceM(10, -6, PARTS)).toBe(0);
        expect(footprintDistanceM(23, -6, PARTS)).toBeCloseTo(3, 6);
        expect(footprintDistanceM(-4, 3, PARTS)).toBeCloseTo(5, 6);
        const hole: Vec2[] = [[8, -4], [12, -4], [12, -8], [8, -8]];
        expect(footprintDistanceM(10, -6, [[RING, hole]])).toBeCloseTo(2, 6);
    });
});

describe('decideBuildingNames', () => {
    it('names the building by the POI inside its footprint, orders the rest by distance, and carries type codes as labels', () => {
        const out = decideBuildingNames({
            parts: PARTS,
            pois: [
                { x: 21, z: -6, types: ['FEATURE_TYPE_POI', 'FEATURE_TYPE_FOOD_AND_DRINK'], name: 'Eataly' },
                { x: 10, z: -6, types: ['FEATURE_TYPE_POI', 'FEATURE_TYPE_HISTORIC'], name: 'Flatiron Building' },
                { x: 10, z: -24, types: ['FEATURE_TYPE_POI', 'FEATURE_TYPE_PARK'], name: 'Worth Square' },
                { x: 12, z: -7, types: ['FEATURE_TYPE_POI'], name: '   ' },
                { x: 11, z: -5, types: ['FEATURE_TYPE_POI'] }
            ],
            query: 'Flatiron Building, 175 5th Ave, New York', address: ADDRESS
        });
        expect(out.primary).toBe('Flatiron Building');
        // inside first, then the pavement POI 1 m out; the park 12 m away is no name; blank and nameless POIs are ignored
        expect(out.names.map(n => [n.name, n.source, n.distanceM])).toEqual([['Flatiron Building', 'poi', 0], ['Eataly', 'poi', 1]]);
        expect(out.names[0].types).toEqual(['FEATURE_TYPE_POI', 'FEATURE_TYPE_HISTORIC']);
        expect(out.names[1].types).toEqual(['FEATURE_TYPE_POI', 'FEATURE_TYPE_FOOD_AND_DRINK']);
        // the request's phrase repeats the POI name: not listed twice
        expect(out.names.filter(n => n.source === 'request')).toEqual([]);
    });

    it('falls back to the request phrase when no POI lies inside, keeping a near POI as a candidate', () => {
        const out = decideBuildingNames({
            parts: PARTS,
            pois: [{ x: 22, z: -6, types: ['FEATURE_TYPE_POI', 'FEATURE_TYPE_SHOPPING'], name: 'Corner Shop' }, { x: 60, z: 0, types: ['FEATURE_TYPE_POI'], name: 'Far Away' }],
            query: 'The Old Mill, Mill Run', address: '1491 Mill Run Rd, Mill Run, PA 15464, USA'
        });
        expect(out.primary).toBe('The Old Mill');
        expect(out.names.map(n => [n.name, n.source, n.distanceM])).toEqual([['Corner Shop', 'poi', 2], ['The Old Mill', 'request', 0]]);
        expect(out.names[1].types).toEqual([]);
    });

    it('has no primary and no names when the POIs are far and the query is only the address', () => {
        const out = decideBuildingNames({ parts: PARTS, pois: [{ x: 10, z: -6 - 12 - POI_NEAR_M - 1, name: 'Worth Square', types: ['FEATURE_TYPE_PARK'] }], query: '175 5th Ave, New York', address: ADDRESS });
        expect(out.primary).toBeUndefined();
        expect(out.names).toEqual([]);
        expect(decideBuildingNames({ parts: PARTS }).names).toEqual([]);
    });
});

describe('requestPhrase / localityOf', () => {
    it('keeps the words of the query that are not the address', () => {
        expect(requestPhrase('Flatiron Building, 175 5th Ave, New York', ADDRESS)).toBe('Flatiron Building');
        expect(requestPhrase('Flatiron Building in New York', ADDRESS)).toBe('Flatiron Building');
        expect(requestPhrase('175 5th Ave New York', ADDRESS)).toBeUndefined();
        expect(requestPhrase('   ', ADDRESS)).toBeUndefined();
        expect(requestPhrase('Fallingwater', undefined)).toBe('Fallingwater');
    });

    it('reads the locality off a formatted address', () => {
        expect(localityOf(ADDRESS)).toBe('New York');
        expect(localityOf('1491 Mill Run Rd, Mill Run, PA 15464, USA')).toBe('Mill Run');
        expect(localityOf('Flinders St, Melbourne VIC 3000, Australia')).toBe('Melbourne');
        expect(localityOf('Paris')).toBe('Paris');
        expect(localityOf('')).toBeUndefined();
    });
});
