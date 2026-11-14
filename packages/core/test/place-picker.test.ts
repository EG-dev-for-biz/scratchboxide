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
    PLACE_PICKER_MAX_RADIUS_M,
    PLACE_PICKER_MIN_RADIUS_M,
    formatPlacePick,
    lngLatToViewport,
    lngLatToWorldPx,
    metersPerPixel,
    normalizePlacePickerRequest,
    panView,
    tilesForView,
    viewportToLngLat,
    worldPxToLngLat,
    zoomView
} from '../src/common/spatial/place-picker';
import { canvasHandlers } from '../src/node/gemini/tools/canvas-tools';

// The Plaza Hotel's corner of Central Park, a real place the picker is used on.
const PLAZA = { lat: 40.7645, lng: -73.9744 };

describe('the place picker map arithmetic', () => {
    it('puts a point in Google\'s tile for it and back again', () => {
        // zoom 16: the tile holding the Plaza Hotel is x 19301, y 24627 (Google 2D Tiles numbering)
        const p = lngLatToWorldPx(PLAZA.lng, PLAZA.lat, 16);
        expect(Math.floor(p.x / 256)).toBe(19301);
        expect(Math.floor(p.y / 256)).toBe(24627);
        const back = worldPxToLngLat(p.x, p.y, 16);
        expect(back.lat).toBeCloseTo(PLAZA.lat, 9);
        expect(back.lng).toBeCloseTo(PLAZA.lng, 9);
    });

    it('covers the whole viewport with tiles, the centre tile under the centre', () => {
        const view = { ...PLAZA, zoom: 16 };
        const tiles = tilesForView(view, 520, 300);
        expect(tiles.length).toBeGreaterThanOrEqual(6);
        for (const t of tiles) {
            expect(t.z).toBe(16);
            expect(t.left).toBeLessThan(520);
            expect(t.left + 256).toBeGreaterThan(0);
            expect(t.top).toBeLessThan(300);
            expect(t.top + 256).toBeGreaterThan(0);
        }
        const centre = tiles.find(t => t.left <= 260 && t.left + 256 > 260 && t.top <= 150 && t.top + 256 > 150)!;
        expect([centre.x, centre.y]).toEqual([19301, 24627]);
        // every pixel is covered: the tiles' boxes reach all four edges
        expect(Math.min(...tiles.map(t => t.left))).toBeLessThanOrEqual(0);
        expect(Math.max(...tiles.map(t => t.left + 256))).toBeGreaterThanOrEqual(520);
        expect(Math.min(...tiles.map(t => t.top))).toBeLessThanOrEqual(0);
        expect(Math.max(...tiles.map(t => t.top + 256))).toBeGreaterThanOrEqual(300);
    });

    it('wraps tile columns across the antimeridian and draws no row past the poles', () => {
        const tiles = tilesForView({ lat: 0, lng: 179.9, zoom: 2 }, 600, 2000);
        expect(new Set(tiles.map(t => t.x))).toEqual(new Set([0, 1, 2, 3]));
        expect(tiles.every(t => t.y >= 0 && t.y < 4)).toBe(true);
    });

    it('a click maps to the point drawn there, and a pan moves the map with the pointer', () => {
        const view = { ...PLAZA, zoom: 17 };
        const clicked = viewportToLngLat(view, 520, 300, 400, 80);
        const drawn = lngLatToViewport(view, 520, 300, clicked.lng, clicked.lat);
        expect(drawn.x).toBeCloseTo(400, 6);
        expect(drawn.y).toBeCloseTo(80, 6);
        // drag 100 px right and 40 px down: the point that was at the centre is now at (360, 190)
        const panned = panView(view, 100, 40);
        const centreNow = lngLatToViewport(panned, 520, 300, PLAZA.lng, PLAZA.lat);
        expect(centreNow.x).toBeCloseTo(360, 6);
        expect(centreNow.y).toBeCloseTo(190, 6);
    });

    it('zooming keeps the point under the cursor in place and stops at the limits', () => {
        const view = { ...PLAZA, zoom: 15 };
        const under = viewportToLngLat(view, 520, 300, 430, 60);
        const zoomed = zoomView(view, 1, 520, 300, 430, 60);
        expect(zoomed.zoom).toBe(16);
        const still = lngLatToViewport(zoomed, 520, 300, under.lng, under.lat);
        expect(still.x).toBeCloseTo(430, 6);
        expect(still.y).toBeCloseTo(60, 6);
        expect(zoomView({ ...PLAZA, zoom: 20 }, 3, 520, 300).zoom).toBe(20);
        expect(zoomView({ ...PLAZA, zoom: 2 }, -3, 520, 300).zoom).toBe(2);
    });

    it('measures the ground a pixel covers: about 1.8 m at zoom 16 in Manhattan', () => {
        expect(metersPerPixel(PLAZA.lat, 16)).toBeCloseTo(1.809, 2);
        // a 250 m area is drawn about 138 px in radius there
        expect(250 / metersPerPixel(PLAZA.lat, 16)).toBeCloseTo(138.2, 0);
    });
});

describe('the place picker request and answer', () => {
    it('keeps a checked request and holds the radius to the build\'s limits', () => {
        expect(normalizePlacePickerRequest(undefined)).toBeUndefined();
        expect(normalizePlacePickerRequest({})).toEqual({});
        expect(normalizePlacePickerRequest({ query: '  The Plaza Hotel  ', radiusMeters: 250 })).toEqual({ query: 'The Plaza Hotel', radiusMeters: 250 });
        expect(normalizePlacePickerRequest({ lat: 40.7645, lng: -73.9744 })).toEqual({ lat: 40.7645, lng: -73.9744 });
        expect(normalizePlacePickerRequest({ lat: 400, lng: 0 })).toEqual({});
        expect(normalizePlacePickerRequest({ message: ' Click the building. ' })).toEqual({ message: 'Click the building.' });
        expect(normalizePlacePickerRequest({ radiusMeters: 5 })!.radiusMeters).toBe(PLACE_PICKER_MIN_RADIUS_M);
        expect(normalizePlacePickerRequest({ radiusMeters: 9000 })!.radiusMeters).toBe(PLACE_PICKER_MAX_RADIUS_M);
    });

    it('writes the pick as coordinates a build tool takes as its query', () => {
        expect(formatPlacePick(PLAZA)).toBe('[Place picked on the map]: 40.764500, -73.974400. Use these coordinates as the place.');
        expect(formatPlacePick({ ...PLAZA, radiusMeters: 250, address: 'The Plaza, 768 5th Ave, New York, NY 10019, USA' }))
            .toBe('[Place picked on the map]: 40.764500, -73.974400, an area of 250 m radius around it (searched for: The Plaza, 768 5th Ave, New York, NY 10019, USA). Use these coordinates as the place.');
    });

    it('ask_user_question carries the map into its card, with no options asked', () => {
        const out = (canvasHandlers as any).ask_user_question({ questions: [], placePicker: { query: 'Flatiron District, New York', radiusMeters: 250 } }, {} as any);
        expect(out.resultPayload.status).toBe('pending_user_answer');
        expect(out.resultPayload.questionCard).toEqual({ title: 'Where?', questions: [], placePicker: { query: 'Flatiron District, New York', radiusMeters: 250 } });
        expect(out.summaryResult).toMatch(/map to pick the place on, centred on "Flatiron District, New York"/);
        // without it the card is unchanged
        const plain = (canvasHandlers as any).ask_user_question({ questions: [{ id: 'q', prompt: 'Which?', options: [{ id: 'a', label: 'A' }] }] }, {} as any);
        expect(plain.resultPayload.questionCard.placePicker).toBeUndefined();
        expect(plain.resultPayload.questionCard.title).toBe('Clarification & Configuration Required');
    });
});
