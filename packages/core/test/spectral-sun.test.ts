import { describe, it, expect } from 'vitest';
import {
    spectralSun,
    correlatedColorTemperature,
    blackbodyLinearRgbSpectral,
    integrateSpectrum,
    planckRadiance,
    extraterrestrialSolarIrradiance
} from '../src/browser/generative-canvas/services/atmosphere/spectral-sun';
import { computeDiurnalLightingProfile } from '../src/browser/generative-canvas/services/atmosphere/diurnal-lighting';
import { directSunColor } from '../src/browser/generative-canvas/services/atmosphere/AtmosphericSkyDome';

const xyOf = (xyz: [number, number, number]) => {
    const s = xyz[0] + xyz[1] + xyz[2];
    return { x: xyz[0] / s, y: xyz[1] / s };
};

describe('spectral sun: CIE integration', () => {
    it('an equal-energy spectrum lands on the E white point (x = y = 1/3)', () => {
        const { x, y } = xyOf(integrateSpectrum(() => 1));
        expect(x).toBeCloseTo(1 / 3, 2);
        expect(y).toBeCloseTo(1 / 3, 2);
    });

    it('recovers the temperature of a blackbody from its chromaticity', () => {
        for (const k of [1800, 2700, 4000, 5500, 6500, 9000, 15000]) {
            const { x, y } = xyOf(integrateSpectrum(l => planckRadiance(l, k)));
            const cct = correlatedColorTemperature(x, y);
            expect(Math.abs(cct.kelvin - k) / k).toBeLessThan(0.002);
            expect(cct.deltaUv).toBeLessThan(1e-4);
        }
    });

    it('warm blackbodies are red-heavy, hot ones blue-heavy', () => {
        const warm = blackbodyLinearRgbSpectral(2700);
        const hot = blackbodyLinearRgbSpectral(12000);
        expect(warm[0]).toBe(1);
        expect(warm[2]).toBeLessThan(0.15);
        expect(hot[2]).toBe(1);
        expect(hot[0]).toBeLessThan(0.6);
    });
});

describe('spectral sun: the direct beam', () => {
    it('top-of-atmosphere sun is the solar constant and ~128 klx', () => {
        let w = 0;
        for (let l = 200; l <= 4000; l += 1) w += extraterrestrialSolarIrradiance(l);
        expect(w).toBeGreaterThan(1300); // most of the 1361 W/m² lies in 200-4000 nm
        expect(w).toBeLessThan(1400);
        const space = spectralSun(90, { turbidity: 1, ozoneColumnScale: 0, observerAltitudeMeters: 1e6 });
        expect(space.illuminanceLux).toBeGreaterThan(120000);
        expect(space.illuminanceLux).toBeLessThan(135000);
    });

    it('clear noon sun at sea level: ~100 klx at about 5000-5500 K', () => {
        const noon = spectralSun(90, { turbidity: 2 });
        expect(noon.illuminanceLux).toBeGreaterThan(85000);
        expect(noon.illuminanceLux).toBeLessThan(112000);
        expect(noon.cctKelvin).toBeGreaterThan(4800);
        expect(noon.cctKelvin).toBeLessThan(5600);
    });

    it('reddens and dims monotonically toward the horizon', () => {
        let prev = spectralSun(90, { turbidity: 2.5 });
        for (const e of [60, 30, 15, 8, 4, 1]) {
            const s = spectralSun(e, { turbidity: 2.5 });
            expect(s.cctKelvin).toBeLessThan(prev.cctKelvin);
            expect(s.illuminanceLux).toBeLessThan(prev.illuminanceLux);
            expect(s.linearRgb[2]).toBeLessThanOrEqual(prev.linearRgb[2]);
            prev = s;
        }
        expect(prev.linearRgb[0]).toBe(1);
        expect(prev.linearRgb[2]).toBeLessThan(0.02);
    });

    it('haze warms the beam; altitude thins the air and whitens it', () => {
        const clear = spectralSun(10, { turbidity: 2 });
        const hazy = spectralSun(10, { turbidity: 8 });
        expect(hazy.cctKelvin).toBeLessThan(clear.cctKelvin);
        expect(hazy.illuminanceLux).toBeLessThan(clear.illuminanceLux);
        const peak = spectralSun(10, { turbidity: 2, observerAltitudeMeters: 3500 });
        expect(peak.cctKelvin).toBeGreaterThan(clear.cctKelvin);
        expect(peak.illuminanceLux).toBeGreaterThan(clear.illuminanceLux);
    });

    it('ozone absorbs part of the low sun and shifts its colour', () => {
        const withO3 = spectralSun(2, { turbidity: 2 });
        const without = spectralSun(2, { turbidity: 2, ozoneColumnScale: 0 });
        expect(withO3.luminousTransmittance).toBeLessThan(without.luminousTransmittance);
        expect(Math.hypot(withO3.chromaticity.x - without.chromaticity.x, withO3.chromaticity.y - without.chromaticity.y)).toBeGreaterThan(0.002);
    });

    it('a turbidity below pure Rayleigh is refused', () => {
        expect(() => spectralSun(30, { turbidity: 0.5 })).toThrow(RangeError);
    });
});

describe('spectral sun in the lighting profile and the sky dome', () => {
    it('the profile uses the spectral beam while the disc is up', () => {
        const p = computeDiurnalLightingProfile(30);
        const beam = spectralSun(30, { turbidity: p.turbidity! });
        expect(p.sunLinearRgb).toEqual(beam.linearRgb);
        expect(p.kelvinTemperature).toBe(Math.round(beam.cctKelvin));
        expect(p.sunIlluminanceLux).toBeCloseTo(beam.illuminanceLux, 6);
        const given = computeDiurnalLightingProfile(30, { turbidity: 6 });
        expect(given.turbidity).toBe(6);
        expect(given.kelvinTemperature!).toBeLessThan(p.kelvinTemperature!);
    });

    it('after sunset there is no beam and the diurnal table colours the light', () => {
        const p = computeDiurnalLightingProfile(-4);
        expect(p.sunIlluminanceLux).toBeUndefined();
        expect(p.kelvinTemperature).toBe(12000);
    });

    it('the dome draws the spectral sun unless a colour temperature was chosen', () => {
        const p = computeDiurnalLightingProfile(5);
        const spectral = directSunColor(p, {}, false);
        expect(spectral.r).toBeCloseTo(p.sunLinearRgb![0], 6);
        expect(spectral.g).toBeCloseTo(p.sunLinearRgb![1], 6);
        expect(spectral.b).toBeCloseTo(p.sunLinearRgb![2], 6);
        const chosen = directSunColor(p, { kelvinTemperature: 6500 }, false);
        expect(chosen.b).toBeGreaterThan(spectral.b);
    });
});
