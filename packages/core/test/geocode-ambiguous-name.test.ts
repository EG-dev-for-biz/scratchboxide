/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * A place name shared by several places resolves to the most prominent one, and the others are reported.
 * The responses below are replays of what Places API (New) Text Search returned for "central park" (probe, 2026-10-16):
 * the list is ordered nearest-the-caller first, so Pasadena leads and New York, with 303216 ratings, is last.
 * No live call is made.
 */
import { describe, expect, it } from 'vitest';
import { GoogleMapsService, PLACES_TEXT_SEARCH_FIELD_MASK } from '../src/browser/generative-canvas/services/google-maps-service';
import { mountedSentence } from '../src/node/3d-engine/staged-location/staged-summary';

const loc = (latitude: number, longitude: number) => ({ latitude, longitude });
const CENTRAL_PARK_REPLAY = {
    places: [
        { id: 'p1', displayName: { text: 'Central Park' }, formattedAddress: '275 S Raymond Ave, Pasadena, CA 91105, USA', location: loc(34.1396, -118.1485), userRatingCount: 1123 },
        { id: 'p2', displayName: { text: 'Central Park' }, formattedAddress: '12405 E Waterfront Dr, Los Angeles, CA 90045, USA', location: loc(33.9650, -118.4350), userRatingCount: 421 },
        { id: 'p3', displayName: { text: 'Central Park' }, formattedAddress: '27150 Bouquet Canyon Rd, Santa Clarita, CA 91350, USA', location: loc(34.4300, -118.5200), userRatingCount: 2414 },
        { id: 'p4', displayName: { text: 'Central Park Recreation Center' }, formattedAddress: '1357 E 22nd St, Los Angeles, CA 90011, USA', location: loc(34.0270, -118.2500), userRatingCount: 123 },
        { id: 'p5', displayName: { text: 'Central Park' }, formattedAddress: 'New York, NY, USA', location: loc(40.7829, -73.9654), userRatingCount: 303216 }
    ]
};

function replay(places: unknown[]) {
    const bodies: any[] = [];
    const fetchImpl = (async (_url: any, init?: any) => {
        bodies.push(JSON.parse(init.body));
        // Text Search returns as many as pageSize allows, in Google's order
        const n = JSON.parse(init.body).pageSize ?? 20;
        return new Response(JSON.stringify({ places: places.slice(0, n) }), { status: 200 });
    }) as typeof fetch;
    return { fetchImpl, bodies };
}

describe('geocode of a name shared by several places', () => {
    it('resolves "central park" to New York, not the first (nearest the caller) result', async () => {
        const { fetchImpl, bodies } = replay(CENTRAL_PARK_REPLAY.places);
        const r = await GoogleMapsService.getInstance().geocode('central park', { apiKey: 'test-key', fetchImpl });
        expect(r.formattedAddress).toContain('New York');
        expect(r.lat).toBeCloseTo(40.7829, 3);
        expect(bodies[0].pageSize).toBeGreaterThan(1);
        expect(PLACES_TEXT_SEARCH_FIELD_MASK).toContain('places.userRatingCount');
    });

    it('reports the other distinct places, most prominent first, without repeating the chosen one', async () => {
        const { fetchImpl } = replay(CENTRAL_PARK_REPLAY.places);
        const r = await GoogleMapsService.getInstance().geocode('central park', { apiKey: 'test-key', fetchImpl });
        expect(r.alternatives?.map(a => a.formattedAddress.split(',')[1]?.trim() ?? a.formattedAddress)).toEqual(['Santa Clarita', 'Pasadena', 'Los Angeles', 'Los Angeles']);
        expect(r.alternatives!.some(a => a.formattedAddress === 'New York, NY, USA')).toBe(false);
        expect(r.alternatives![0].userRatingCount).toBe(2414);
    });

    it('treats a result within 1 km of one already kept as the same place', async () => {
        const dup = { ...CENTRAL_PARK_REPLAY.places[0], id: 'dup', location: loc(34.1399, -118.1488), userRatingCount: 10 };
        const { fetchImpl } = replay([...CENTRAL_PARK_REPLAY.places.slice(0, 1), dup, CENTRAL_PARK_REPLAY.places[4]]);
        const r = await GoogleMapsService.getInstance().geocode('central park', { apiKey: 'test-key', fetchImpl });
        expect(r.alternatives).toHaveLength(1);
        expect(r.alternatives![0].formattedAddress).toContain('Pasadena');
    });

    it('a single unambiguous result has no alternatives', async () => {
        const { fetchImpl } = replay([{ id: 'x', displayName: { text: 'Times Square' }, formattedAddress: 'Manhattan, NY 10036, USA', location: loc(40.758, -73.9855), userRatingCount: 249464 }]);
        const r = await GoogleMapsService.getInstance().geocode('times square', { apiKey: 'test-key', fetchImpl });
        expect(r.alternatives).toBeUndefined();
    });

    it('a result without ratings is never preferred over a rated one, and with none the first stands', async () => {
        const unrated = [
            { displayName: { text: 'Main Street' }, formattedAddress: 'Main St, California, USA', location: loc(36, -119) },
            { displayName: { text: 'Main Street' }, formattedAddress: 'Main St, Ohio, USA', location: loc(40, -83) }
        ];
        const { fetchImpl } = replay(unrated);
        const r = await GoogleMapsService.getInstance().geocode('main street', { apiKey: 'test-key', fetchImpl });
        expect(r.formattedAddress).toContain('California');
        expect(r.alternatives).toHaveLength(1);
    });

    it('the staged summary names the alternatives', () => {
        const s = mountedSentence({
            place: { query: 'central park', resolvedAddress: 'Central Park, New York, NY, USA', lat: 40.78, lng: -73.96, alternatives: [{ formattedAddress: 'Pasadena, CA, USA', lat: 34.14, lng: -118.15 }] },
            extraction: { radiusM: 300, sizedTo: 'request' }, stages: [], layers: []
        } as never);
        expect(s).toContain('also found: Pasadena, CA, USA');
    });
});
