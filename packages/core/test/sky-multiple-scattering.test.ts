/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The scene weather's multiple-scattering sky (vendored from Blender, scratchbox_sky_ms.hpp), compiled and run: its
 * radiance at known sun angles against physics (energy, the sun's reddening, the blue zenith, twilight past sunset),
 * the haze mapping, and the TypeScript spectral sky it replaces in the weather.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { aerosolOpticalDepthForTurbidity, NativeSkyMsService, SkyMsTable } from '../src/node/3d-engine/native-sky-ms-service';
import { buildPhysicalSkyLut } from '../src/browser/generative-canvas/services/atmosphere/physical-sky';
import { NativeCppCompilerService } from '../src/node/3d-engine/native-compiler-service';

const lum = (c: ArrayLike<number>) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
const px = (t: { data: Float32Array; azimuthResolution: number }, row: number, col: number): [number, number, number] => {
    const k = (row * t.azimuthResolution + col) * 3;
    return [t.data[k], t.data[k + 1], t.data[k + 2]];
};
/** Turbidity of the location sky's haze 0.2 (scene-weather.ts: 2 + 8 x haze). */
const LOCATION_TURBIDITY = 3.6;

describe('multiple-scattering sky (vendored Blender model)', () => {
    const service = new NativeSkyMsService();
    const sky: Record<number, SkyMsTable> = {};

    beforeAll(async () => {
        for (const el of [60, 20, 5, 0, -4]) sky[el] = await service.skyViewTable({ sunElevationDeg: el, turbidity: LOCATION_TURBIDITY });
    }, 300_000);

    it('vendors only the MIT file, with its licence and record, and none of Blender\'s GPL headers', () => {
        const dir = path.join(new NativeCppCompilerService().getSdkIncludePath(), '..', 'third_party', 'blender-sky');
        const cpp = fs.readFileSync(path.join(dir, 'sky_multiple_scattering.cpp'), 'utf8');
        expect(cpp).toMatch(/SPDX-License-Identifier: MIT/);
        expect(cpp).toMatch(/Modified by Scratchbox LLC, 2026/);
        expect(cpp).not.toMatch(/#include "sky_math\.h"|#include "sky_nishita\.h"/);
        expect(fs.readFileSync(path.join(dir, 'LICENSE'), 'utf8')).toMatch(/Fernando García Liñán[\s\S]*Permission is hereby granted/);
        expect(fs.readFileSync(path.join(dir, 'VENDORED.md'), 'utf8')).toMatch(/8be38b821855731aaa3a981110870101962fbb52/);
        for (const f of fs.readdirSync(dir)) expect(fs.readFileSync(path.join(dir, f), 'utf8')).not.toMatch(/SPDX-License-Identifier: GPL/);
    });

    it('maps the haze to the aerosol optical depth the spectral sky uses', () => {
        expect(aerosolOpticalDepthForTurbidity(3.6)).toBeCloseTo((0.04608 * 3.6 - 0.04586) * Math.pow(0.55, -1.3), 6);
        expect(sky[20].aerosolOpticalDepth550).toBeCloseTo(0.2611, 3);
        // the model's own urban layer has an optical depth of ~0.018 at density 1; this haze is ~14x it
        expect(sky[20].aerosolDensity).toBeGreaterThan(10);
        expect(sky[20].aerosolDensity).toBeLessThan(20);
        expect(() => aerosolOpticalDepthForTurbidity(0.5)).toThrow(RangeError);
    });

    it('returns a full, finite, non-negative table in the viewer\'s layout', () => {
        for (const t of Object.values(sky)) {
            expect(t.azimuthResolution).toBe(64);
            expect(t.elevationResolution).toBe(48);
            expect(t.data.length).toBe(64 * 48 * 3);
            expect(t.data.every(v => Number.isFinite(v) && v >= 0)).toBe(true);
        }
    });

    it('conserves energy: the sky and the direct beam together never put more on the ground than the sun at the top of the air', () => {
        for (const el of [60, 20, 5]) {
            const t = sky[el];
            const toa = Math.sin((el * Math.PI) / 180);
            const direct = lum(t.sunTransmittance) * toa;
            const diffuse = lum(t.horizontalIrradiance);
            expect(diffuse).toBeGreaterThan(0);
            expect(direct + diffuse).toBeLessThan(toa);
        }
        // a clear high sun: the sky alone gives ~10-30% of the top-of-air light on a level surface (measured diffuse
        // fractions of global horizontal irradiance under a clear urban sky are 15-25%)
        const e60 = lum(sky[60].horizontalIrradiance) / Math.sin(Math.PI / 3);
        expect(e60).toBeGreaterThan(0.1);
        expect(e60).toBeLessThan(0.3);
        const diffuseFraction60 = lum(sky[60].horizontalIrradiance) / (lum(sky[60].horizontalIrradiance) + lum(sky[60].sunTransmittance) * Math.sin(Math.PI / 3));
        expect(diffuseFraction60).toBeGreaterThan(0.12);
        expect(diffuseFraction60).toBeLessThan(0.35);
    });

    it('dims steadily as the sun sinks, and keeps a twilight past sunset (the higher orders)', () => {
        const e = (el: number) => lum(sky[el].horizontalIrradiance);
        expect(e(60)).toBeGreaterThan(e(20));
        expect(e(20)).toBeGreaterThan(e(5));
        expect(e(5)).toBeGreaterThan(e(0));
        expect(e(0)).toBeGreaterThan(e(-4));
        // 4 degrees below the horizon: no direct sun, the sky still lit, a few percent of the sunset sky or less
        expect(lum(sky[-4].sunTransmittance)).toBe(0);
        expect(e(-4)).toBeGreaterThan(0);
        expect(e(-4) / e(0)).toBeLessThan(0.3);
        expect(e(-4) / e(0)).toBeGreaterThan(0.01);
    });

    it('reddens the sun with its path and blues the zenith', () => {
        for (const el of [60, 20, 5]) {
            const [r, g, b] = sky[el].sunTransmittance;
            expect(r).toBeGreaterThan(g);
            expect(g).toBeGreaterThan(b);
        }
        // Beer-Lambert at 20 degrees: air mass ~2.9 through Rayleigh 0.098 + aerosol 0.26 + ozone at 550 nm -> ~0.36-0.45
        expect(sky[20].sunTransmittance[1]).toBeGreaterThan(0.33);
        expect(sky[20].sunTransmittance[1]).toBeLessThan(0.48);
        const blueOverRed = (el: number) => sky[el].sunTransmittance[2] / sky[el].sunTransmittance[0];
        expect(blueOverRed(5)).toBeLessThan(blueOverRed(20));
        expect(blueOverRed(20)).toBeLessThan(blueOverRed(60));
        // the zenith is blue at every sun, and bluer at twilight (ozone's Chappuis band and the long path's reddening go)
        const zenith = (el: number) => px(sky[el], 47, 32);
        for (const el of [60, 20, 5, 0, -4]) expect(zenith(el)[2] / zenith(el)[0]).toBeGreaterThan(1.3);
        expect(zenith(-4)[2] / zenith(-4)[0]).toBeGreaterThan(zenith(20)[2] / zenith(20)[0]);
    });

    it('glows warm toward a low sun and stays cool opposite it', () => {
        const toward = px(sky[5], 0, 0), away = px(sky[5], 0, 63);
        expect(toward[0] / toward[2]).toBeGreaterThan(4);
        expect(away[2] / away[0]).toBeGreaterThan(1.5);
        expect(lum(toward)).toBeGreaterThan(5 * lum(away));
        // 20 degrees: the circumsolar horizon is still the brightest and warmest part of the horizon
        const t20 = px(sky[20], 0, 0), a20 = px(sky[20], 0, 63);
        expect(lum(t20)).toBeGreaterThan(lum(a20));
        expect(t20[0] / t20[2]).toBeGreaterThan(a20[0] / a20[2]);
    });

    it('thickens with the haze: a dimmer, redder sun and a whiter zenith', async () => {
        const hazy = await service.skyViewTable({ sunElevationDeg: 20, turbidity: 10 });
        expect(hazy.sunTransmittance[1]).toBeLessThan(sky[20].sunTransmittance[1]);
        const z = (t: SkyMsTable) => px(t, 47, 32);
        expect(z(hazy)[2] / z(hazy)[0]).toBeLessThan(z(sky[20])[2] / z(sky[20])[0]);
    });

    it('agrees in level with the spectral sky it replaces in the weather, within a factor of two by day', () => {
        for (const el of [60, 20]) {
            const ts = buildPhysicalSkyLut({ sunElevationDeg: el, turbidity: LOCATION_TURBIDITY });
            const ratio = lum(sky[el].horizontalIrradiance) / lum(ts.horizontalIrradiance);
            expect(ratio).toBeGreaterThan(0.5);
            expect(ratio).toBeLessThan(2);
            expect(lum(sky[el].sunTransmittance) / lum(ts.sunTransmittance)).toBeGreaterThan(0.75);
            expect(lum(sky[el].sunTransmittance) / lum(ts.sunTransmittance)).toBeLessThan(1.33);
        }
    });

    it('refuses an impossible sun or haze', async () => {
        await expect(service.skyViewTable({ sunElevationDeg: 120, turbidity: 3 })).rejects.toThrow(RangeError);
        await expect(service.skyViewTable({ sunElevationDeg: 20, turbidity: 0 })).rejects.toThrow(RangeError);
    });
});
