/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { createAtmosphericSkyDome, daylightWhiteBalance } from '../src/browser/generative-canvas/services/atmosphere/AtmosphericSkyDome';

/** The light on a level grey surface: the sun at its elevation and the sky from above. */
function levelLight(dome: ReturnType<typeof createAtmosphericSkyDome>, elevationDeg: number): number[] {
    const s = Math.sin((elevationDeg * Math.PI) / 180) * dome.sunLight.intensity, k = dome.hemiLight.intensity;
    return [dome.sunLight.color.r * s + dome.hemiLight.color.r * k, dome.sunLight.color.g * s + dome.hemiLight.color.g * k, dome.sunLight.color.b * s + dome.hemiLight.color.b * k];
}
const spread = (c: number[]) => (Math.max(...c) - Math.min(...c)) / Math.max(...c);

describe('daylight white balance (user decision 2026-11-04: the light does not wash the textures warm)', () => {
    it('makes the light on a level grey surface neutral at the same luminance', () => {
        const sun = new THREE.Color(1, 0.67, 0.35), sky = new THREE.Color(0.97, 1, 1.11);
        const g = daylightWhiteBalance(sun, 1.85, 20, sky, 0.73)!;
        const s = Math.sin((20 * Math.PI) / 180) * 1.85;
        const e = [sun.r * s + sky.r * 0.73, sun.g * s + sky.g * 0.73, sun.b * s + sky.b * 0.73];
        const after = [e[0] * g.r, e[1] * g.g, e[2] * g.b];
        expect(spread(after)).toBeLessThan(1e-6);
        const y = (c: number[]) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
        expect(y(after)).toBeCloseTo(y(e), 6);
        // the sun alone stays a little warm and the sky a little blue, as a photograph balanced for daylight shows them
        expect(sun.r * g.r).toBeGreaterThan(sun.b * g.b);
        expect(sky.b * g.b).toBeGreaterThan(sky.r * g.r);
        expect(daylightWhiteBalance(sun, 0, -5, new THREE.Color(0, 0, 0), 0)).toBeUndefined();
    });

    it('balances a district\'s afternoon sun 20 degrees up through light haze, which lit everything orange', () => {
        const raw = createAtmosphericSkyDome(new THREE.Scene(), false, { sunElevation: 20, sunAzimuth: 226, turbidity: 3.6, whiteBalance: false });
        const balanced = createAtmosphericSkyDome(new THREE.Scene(), false, { sunElevation: 20, sunAzimuth: 226, turbidity: 3.6 });
        expect(spread(levelLight(raw, 20))).toBeGreaterThan(0.25);
        expect(spread(levelLight(balanced, 20))).toBeLessThan(0.01);
        // and stays balanced as the sun moves
        balanced.setSunCoordinates(35, 200);
        expect(spread(levelLight(balanced, 35))).toBeLessThan(0.01);
    });

    it('keeps golden hour warm, and a chosen colour temperature as chosen', () => {
        const golden = createAtmosphericSkyDome(new THREE.Scene(), false, { sunElevation: 4, sunAzimuth: 250 });
        expect(golden.sunLight.color.r).toBeGreaterThan(golden.sunLight.color.b * 1.5);
        const chosen = createAtmosphericSkyDome(new THREE.Scene(), false, { sunElevation: 45, sunAzimuth: 180, kelvinTemperature: 3000 });
        expect(spread(levelLight(chosen, 45))).toBeGreaterThan(0.2);
    });
});
