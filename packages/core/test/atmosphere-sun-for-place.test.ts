/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * A geo-anchored scene's sun is the real sun of its place: a wanted height becomes the time of day it is reached there, on
 * the wanted side of the sky, and a height the sun never reaches that day takes solar noon.
 */

import { describe, expect, it } from 'vitest';
import { sceneGeoAnchor, sunForPlace } from '../src/node/gemini/tools/atmosphere-tools';
import { calculateNOAASolarPosition } from '../src/browser/generative-canvas/services/atmosphere';

const ESB = { lat: 40.748545, lng: -73.985763 };
const day = new Date(Date.UTC(2026, 9, 28));

describe('the sun of a geo-anchored scene', () => {
    it('finds the afternoon time the sun stands at the wanted height there, its azimuth the real one', () => {
        const s = sunForPlace(ESB.lat, ESB.lng, day, { elevationDeg: 20, azimuthDeg: 215 });
        expect(s.reached).toBe(true);
        expect(s.elevation).toBeCloseTo(20, 0);
        // west of south in the afternoon
        expect(s.azimuth).toBeGreaterThan(180);
        const p = calculateNOAASolarPosition(s.date, ESB.lat, ESB.lng);
        expect(s.azimuth).toBeCloseTo(p.azimuthDeg, 6);
        // the morning side for an eastern azimuth
        expect(sunForPlace(ESB.lat, ESB.lng, day, { elevationDeg: 20, azimuthDeg: 120 }).azimuth).toBeLessThan(180);
    });

    it('takes solar noon when the sun never stands that high that day, and says so', () => {
        // late October in New York: the sun peaks near 36 degrees
        const s = sunForPlace(ESB.lat, ESB.lng, day, { elevationDeg: 48, azimuthDeg: 215 });
        expect(s.reached).toBe(false);
        expect(s.elevation).toBeLessThan(40);
        expect(s.elevation).toBeGreaterThan(30);
        expect(Math.abs(s.azimuth - 180)).toBeLessThan(3);
    });

    it("reads the scene's geoAnchor, else an object's, and none when switched off", () => {
        expect(sceneGeoAnchor({ geoAnchor: { lat: 1, lng: 2 } } as any)).toEqual({ lat: 1, lng: 2 });
        expect(sceneGeoAnchor({ objects: [{ space: { geoAnchor: { lat: 3, lng: 4 } } }] } as any)).toEqual({ lat: 3, lng: 4 });
        expect(sceneGeoAnchor({ geoAnchor: { lat: 1, lng: 2, active: false } } as any)).toBeUndefined();
        expect(sceneGeoAnchor(undefined)).toBeUndefined();
    });
});
