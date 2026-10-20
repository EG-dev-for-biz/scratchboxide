/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The physical sky and the sun/sky light split, against known physics: Bird clear-sky irradiance magnitudes, a blue
 * zenith over a whiter horizon with an aureole round the sun, a red sunset horizon, and scene lights whose
 * direct:diffuse ratio follows the model (deep shadows at a high clear sun, soft ones under cloud).
 */

import { describe, it, expect } from 'vitest';
import { solarIrradiance } from '../src/browser/generative-canvas/services/atmosphere/clear-sky-irradiance';
import { buildPhysicalSkyLut, physicalSkyRowElevation } from '../src/browser/generative-canvas/services/atmosphere/physical-sky';
import { computeDiurnalLightingProfile, skyLightColorHex } from '../src/browser/generative-canvas/services/atmosphere/diurnal-lighting';

describe('clear-sky irradiance (Bird & Hulstrom, Kasten & Czeplak)', () => {
    it('gives realistic clear-sky magnitudes', () => {
        const noon = solarIrradiance(60, { turbidity: 2 });
        expect(noon.directNormal).toBeGreaterThan(800);
        expect(noon.directNormal).toBeLessThan(1000);
        expect(noon.diffuseHorizontal).toBeGreaterThan(80);
        expect(noon.diffuseHorizontal).toBeLessThan(160);
        expect(noon.directToDiffuse).toBeGreaterThan(4);
    });

    it('haze and cloud soften the light; altitude sharpens it; no sun, no light', () => {
        const clear = solarIrradiance(40, { turbidity: 2 });
        expect(solarIrradiance(40, { turbidity: 6 }).directToDiffuse).toBeLessThan(clear.directToDiffuse);
        expect(solarIrradiance(40, { turbidity: 2, cloudCover: 0.95 }).directToDiffuse).toBeLessThan(0.2);
        expect(solarIrradiance(40, { turbidity: 2, observerAltitudeMeters: 2000 }).directToDiffuse).toBeGreaterThan(clear.directToDiffuse);
        expect(solarIrradiance(-3, { turbidity: 2 }).directHorizontal).toBe(0);
        expect(() => solarIrradiance(30, { turbidity: 0.5 })).toThrow(RangeError);
    });
});

describe('physical sky', () => {
    const at = (lut: ReturnType<typeof buildPhysicalSkyLut>, elev: number, col: number) => {
        let i = 0;
        while (i < lut.elevationResolution - 1 && physicalSkyRowElevation(i, lut.elevationResolution) < elev) i++;
        const k = (i * lut.azimuthResolution + col) * 3;
        return [lut.data[k], lut.data[k + 1], lut.data[k + 2]];
    };
    const lum = (v: number[]) => 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2];

    it('day: blue zenith, brighter and whiter horizon, aureole round the sun', () => {
        const lut = buildPhysicalSkyLut({ sunElevationDeg: 40, turbidity: 2.2 });
        const zen = at(lut, 89, 48), hor = at(lut, 3, 48);
        expect(zen[2] / zen[0]).toBeGreaterThan(2);
        expect(hor[2] / hor[0]).toBeLessThan(zen[2] / zen[0]);
        expect(lum(hor)).toBeGreaterThan(lum(zen));
        expect(lum(at(lut, 50, 0))).toBeGreaterThan(2 * lum(at(lut, 50, 48)));
        expect(lut.horizontalIrradiance.every(v => v > 0)).toBe(true);
    });

    it('sunset: the horizon toward the sun is red, the zenith stays blue', () => {
        const lut = buildPhysicalSkyLut({ sunElevationDeg: 2, turbidity: 2.2 });
        const toward = at(lut, 3, 0), zen = at(lut, 89, 48);
        expect(toward[0]).toBeGreaterThan(3 * toward[2]);
        expect(zen[2]).toBeGreaterThan(zen[0]);
    });

    it('after sunset the Earth shadow darkens the sky by orders of magnitude', () => {
        const day = buildPhysicalSkyLut({ sunElevationDeg: 10, turbidity: 2.2 });
        const night = buildPhysicalSkyLut({ sunElevationDeg: -8, turbidity: 2.2 });
        expect(lum(night.horizontalIrradiance)).toBeLessThan(lum(day.horizontalIrradiance) * 1e-2);
    });
});

describe('scene lights follow the direct:diffuse split', () => {
    const hexLum = (hex: string) => {
        const v = (i: number) => { const c = parseInt(hex.slice(1 + 2 * i, 3 + 2 * i), 16) / 255; return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
        return 0.2126 * v(0) + 0.7152 * v(1) + 0.0722 * v(2);
    };
    const ratio = (el: number, opts = {}) => {
        const p = computeDiurnalLightingProfile(el, opts);
        return (p.sunIntensity * Math.sin((el * Math.PI) / 180)) / (p.skyLightIntensity * hexLum(skyLightColorHex(p)));
    };

    it('matches the clear-sky model at a high sun, and drops under overcast', () => {
        const p = computeDiurnalLightingProfile(45);
        expect(ratio(45)).toBeCloseTo(solarIrradiance(45, { turbidity: p.turbidity! }).directToDiffuse, 6);
        expect(ratio(45)).toBeGreaterThan(3);
        expect(ratio(45, { cloudCoverage: 0.95 })).toBeLessThan(0.2);
    });

    it('keeps the level-surface brightness of the diurnal curve', () => {
        const before = 1.45 * Math.sin((60 * Math.PI) / 180) + 1.1 * hexLum('#e0f2fe');
        const p = computeDiurnalLightingProfile(60);
        const after = p.sunIntensity * Math.sin((60 * Math.PI) / 180) + p.skyLightIntensity * hexLum(skyLightColorHex(p));
        expect(after).toBeCloseTo(before, 6);
    });
});
