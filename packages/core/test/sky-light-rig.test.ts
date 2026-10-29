/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The sky's photometry bench (gaffer skill, section 1): the scene's sun, sky light, dome and exposure at fixed sun
 * elevations, checked against clear-day reference ratios. The numbers are the ones the viewport draws: the dome is the
 * physical table scaled to the sky light's level (AtmosphericSkyDome.ts applyPhysicalSky), the exposure the metered one.
 */

import { describe, it, expect } from 'vitest';
import { buildPhysicalSkyLut, PhysicalSkyLut } from '../src/browser/generative-canvas/services/atmosphere/physical-sky';
import { computeDiurnalLightingProfile, skyLightColorHex } from '../src/browser/generative-canvas/services/atmosphere/diurnal-lighting';
import {
    calibratedExposure, EXPOSURE_MAX, luminance, NIGHT_MOON_INTENSITY, NIGHT_SKY_LIGHT_FLOOR, nightFillWeight, physicalSkyLevel, skyIrradianceChroma
} from '../src/browser/generative-canvas/services/atmosphere/sky-light-rig';

const DEG = Math.PI / 180;
const hexLum = (hex: string) => luminance([0, 1, 2].map(i => { const c = parseInt(hex.slice(1 + 2 * i, 3 + 2 * i), 16) / 255; return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); }));

/** What the viewport sets up for one sun: the lights, the dome's scale and the exposure. */
function rig(el: number, turbidity = 2.4) {
    const p = computeDiurnalLightingProfile(el, { turbidity });
    const lut = buildPhysicalSkyLut({ sunElevationDeg: el, turbidity });
    const sky = p.skyLightIntensity * hexLum(skyLightColorHex(p));
    const sunH = p.sunIntensity * Math.sin(el * DEG);
    const scale = sky / luminance(lut.horizontalIrradiance);
    const radiance = (row: number) => { const W = lut.azimuthResolution; let y = 0; for (let j = 0; j < W; j++) y += luminance(lut.data.subarray((row * W + j) * 3, (row * W + j) * 3 + 3)) / W; return y * scale; };
    return { p, lut, sky, sunH, exposure: calibratedExposure(sunH + sky), horizon: radiance(1), zenith: radiance(lut.elevationResolution - 1) };
}

describe('sky photometry bench', () => {
    it('high clear sun: the sky gives 10-20% of the sun\'s horizontal irradiance', () => {
        for (const t of [2, 2.4]) {
            const r = rig(60, t);
            expect(r.sky / r.sunH).toBeGreaterThan(0.10);
            expect(r.sky / r.sunH).toBeLessThan(0.20);
        }
    });

    it('late afternoon (36°): the horizon is brighter than the zenith, by 1.5-4x', () => {
        const r = rig(36);
        expect(r.horizon / r.zenith).toBeGreaterThan(1.5);
        expect(r.horizon / r.zenith).toBeLessThan(4);
    });

    it('late afternoon (36°): a sunlit wall reads 5-8x its shaded side, and lit wall > sky > shaded wall on screen', () => {
        const r = rig(36), albedo = 0.3, ground = 0.18 * (r.sunH + r.sky);
        // a vertical wall sees half sky, half ground; the lit one faces the sun's azimuth
        const shadedE = (r.sky + ground) / 2, litE = shadedE + r.p.sunIntensity * Math.cos(36 * DEG);
        expect(litE / shadedE).toBeGreaterThan(5);
        expect(litE / shadedE).toBeLessThan(8);
        const lit = (albedo * litE / Math.PI) * r.exposure, shaded = (albedo * shadedE / Math.PI) * r.exposure;
        const skyMid = ((r.horizon + r.zenith) / 2) * r.exposure;
        expect(lit).toBeGreaterThan(skyMid);
        expect(skyMid).toBeGreaterThan(shaded);
        // a grey card under the metered light sits near the middle of the filmic curve, not at its shoulder
        expect((0.18 * (r.sunH + r.sky) / Math.PI) * r.exposure).toBeGreaterThan(0.1);
        expect((0.18 * (r.sunH + r.sky) / Math.PI) * r.exposure).toBeLessThan(0.18);
    });

    it('the hemisphere light takes the physical sky\'s colour: blue by day, its luminance 1', () => {
        const c = skyIrradianceChroma(buildPhysicalSkyLut({ sunElevationDeg: 36, turbidity: 2.4 }));
        expect(luminance(c)).toBeCloseTo(1, 6);
        expect(c[2]).toBeGreaterThan(c[0]);
    });

    it('twilight to -18°: the sky light falls continuously from sunset through the Earth\'s shadow, with no hand-over', () => {
        const turbidity = 2.4;
        const sunset = rig(0, turbidity);
        const level = (el: number, lut: PhysicalSkyLut) => physicalSkyLevel(el, lut, NaN, sunset.sky, sunset.lut);
        expect(level(0, sunset.lut)).toBeCloseTo(sunset.sky, 9);
        let prev = Infinity;
        for (const el of [-1, -3, -6, -9, -12, -15, -18]) {
            const l = level(el, buildPhysicalSkyLut({ sunElevationDeg: el, turbidity }));
            expect(l).toBeLessThan(prev);
            expect(l).toBeGreaterThan(0);
            prev = l;
        }
        // civil twilight's end (-6°): a few percent of the sunset light or less
        const civil = level(-6, buildPhysicalSkyLut({ sunElevationDeg: -6, turbidity }));
        expect(civil / sunset.sky).toBeLessThan(0.05);
    });

    it('exposure: metered by day, partly adapted at dusk, capped at night, so night stays darker than day', () => {
        const day = rig(60), dusk = rig(2);
        expect(day.exposure).toBeLessThan(dusk.exposure);
        expect(calibratedExposure(1e-9)).toBe(EXPOSURE_MAX);
        const nightE = NIGHT_SKY_LIGHT_FLOOR + NIGHT_MOON_INTENSITY * 0.6;
        expect(nightFillWeight(-12)).toBe(1);
        // a grey card at night shows at a fraction of what it shows by day
        const card = (E: number) => (0.18 * E / Math.PI) * calibratedExposure(E);
        expect(card(nightE)).toBeLessThan(card(day.sunH + day.sky) * 0.6);
        expect(card(nightE)).toBeGreaterThan(card(day.sunH + day.sky) * 0.1);
    });
});
