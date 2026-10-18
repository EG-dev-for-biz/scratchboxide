import { describe, it, expect } from 'vitest';
import {
    PinholeView,
    SunNotFoundError,
    anglesToDirection,
    fitSphericalHarmonics,
    pixelDirection,
    preethamSky,
    segmentSky,
    shBasis,
    xyYToLinearRgb
} from '../src/browser/generative-canvas/services/atmosphere/sky-photometry';
import { AtmosphereImageEstimationService } from '../src/browser/generative-canvas/services/atmosphere/AtmosphereImageEstimationService';
import { InverseLightingEstimatorService } from '../src/node/spatial/InverseLightingEstimatorService';
import { calculateNOAASolarPosition } from '../src/browser/generative-canvas/services/atmosphere/solar-position';

const toSrgb8 = (c: number) => Math.round(255 * Math.max(0, Math.min(1, c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055)));

/**
 * Renders a Preetham sky (sun at the given angles, turbidity T) through a pinhole camera; below the horizon a flat
 * ground of the given sRGB colour. Exposure puts the brightest sky pixel at 0.85 linear.
 */
function renderPreethamScene(view: PinholeView, sunEl: number, sunAz: number, T: number, ground: [number, number, number] = [120, 100, 80]) {
    const sun = anglesToDirection(sunEl, sunAz);
    const lin: ([number, number, number] | undefined)[] = [];
    let maxY = 0;
    for (let y = 0; y < view.height; y++) for (let x = 0; x < view.width; x++) {
        const d = pixelDirection(view, x, y);
        if (d[1] <= 0.02) { lin.push(undefined); continue; }
        const s = preethamSky(d, sun, T);
        maxY = Math.max(maxY, s.Y);
        lin.push(xyYToLinearRgb(s.x, s.y, s.Y));
    }
    const k = 0.85 / maxY;
    const pixels = new Uint8Array(view.width * view.height * 4);
    lin.forEach((rgb, i) => {
        const c = rgb ? rgb.map(v => toSrgb8(v * k)) : ground;
        pixels[i * 4] = c[0]; pixels[i * 4 + 1] = c[1]; pixels[i * 4 + 2] = c[2]; pixels[i * 4 + 3] = 255;
    });
    return pixels;
}

const angleBetween = (a: number[], b: number[]) => Math.acos(Math.max(-1, Math.min(1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2]))) * 180 / Math.PI;

describe('sky photometry: real fits on rendered skies', () => {
    const view: PinholeView = { width: 96, height: 72, hfovDeg: 100, vfovDeg: 0, headingDeg: 150, pitchDeg: 25 };
    view.vfovDeg = 2 * Math.atan(Math.tan(view.hfovDeg * Math.PI / 360) * view.height / view.width) * 180 / Math.PI;

    it('fits the Preetham sun position and turbidity from sky pixels alone (sun outside the frame)', () => {
        const pixels = renderPreethamScene(view, 35, 215, 4);
        const result = AtmosphereImageEstimationService.estimateFromPixels({
            pixels, width: view.width, height: view.height,
            hfovDeg: view.hfovDeg, vfovDeg: view.vfovDeg, cameraHeadingDeg: view.headingDeg, cameraPitchDeg: view.pitchDeg
        });
        expect(result.sunSource).toBe('preetham-sky-fit');
        expect(result.azimuthReference).toBe('true-north');
        const err = angleBetween(result.solarVector, anglesToDirection(35, 215));
        expect(err).toBeLessThan(6);
        expect(result.turbidity!).toBeGreaterThan(3);
        expect(result.turbidity!).toBeLessThan(5);
        expect(result.confidenceScore!).toBeGreaterThan(0.8);
        expect(result.skyFit!.luminanceR2).toBeGreaterThan(0.95);
        // No canned shader constants are emitted as if measured.
        expect(result.rayleigh).toBeUndefined();
        expect(result.mie).toBeUndefined();
        expect(result.unmeasured.rayleigh).toBeDefined();
        expect(result.suggestedAtmosphereConfig.cloudAltitude).toBeUndefined();
    });

    it('a different true sun gives a different fit (the answer follows the pixels)', () => {
        const pixels = renderPreethamScene(view, 15, 100, 6);
        const result = AtmosphereImageEstimationService.estimateFromPixels({
            pixels, width: view.width, height: view.height,
            hfovDeg: view.hfovDeg, vfovDeg: view.vfovDeg, cameraHeadingDeg: view.headingDeg, cameraPitchDeg: view.pitchDeg
        });
        expect(angleBetween(result.solarVector, anglesToDirection(15, 100))).toBeLessThan(8);
    });

    it('a flat sky with no sun is a SunNotFoundError, not a default 45/180 sun', () => {
        const w = 64, h = 48;
        const pixels = new Uint8Array(w * h * 4);
        for (let i = 0; i < w * h; i++) {
            const sky = i < w * h / 2;
            const c = sky ? [120, 170, 230] : [120, 100, 80];
            pixels.set([c[0], c[1], c[2], 255], i * 4);
        }
        expect(() => AtmosphereImageEstimationService.estimateFromPixels({ pixels, width: w, height: h })).toThrow(SunNotFoundError);
    });

    it('segments the sky by region growing, not a fixed top band', () => {
        // Sky occupies the top 70% on the left half and only the top 10% on the right half (a building).
        const w = 60, h = 50;
        const pixels = new Uint8Array(w * h * 4);
        for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
            const isSky = x < 30 ? y < 35 : y < 5;
            const c = isSky ? [110 + y, 160 + y, 235] : [150, 140, 125];
            pixels.set([c[0], c[1], c[2], 255], (y * w + x) * 4);
        }
        const seg = segmentSky(pixels, w, h);
        expect(seg.mask[30 * w + 10]).toBe(1); // y=30 on the left is sky (a top-40% band would miss it)
        expect(seg.mask[20 * w + 45]).toBe(0); // the building face is not sky
        expect(seg.mask[2 * w + 45]).toBe(1); // the strip above the building is sky
        // Every pixel except the high-gradient rows along the sky/building edges.
        expect(seg.count).toBeLessThanOrEqual(30 * 35 + 30 * 5);
        expect(seg.count).toBeGreaterThan(30 * 33 + 30 * 3);
    });

    it('fits SH coefficients that reproduce a known radiance field', () => {
        const v: PinholeView = { width: 64, height: 64, hfovDeg: 120, vfovDeg: 120, headingDeg: 0, pitchDeg: 30 };
        const truth = [[0.4, 0.4, 0.4], [0.2, 0.15, 0.1], [0, 0, 0], [-0.1, -0.1, -0.1], [0, 0, 0], [0, 0, 0], [0, 0, 0], [0, 0, 0], [0, 0, 0]];
        const pixels = new Uint8Array(64 * 64 * 4);
        for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) {
            const b = shBasis(pixelDirection(v, x, y));
            const rgb = [0, 1, 2].map(c => truth.reduce((a, t, i) => a + t[c] * b[i], 0));
            pixels.set([...rgb.map(toSrgb8), 255], (y * 64 + x) * 4);
        }
        const fit = fitSphericalHarmonics(pixels, v);
        expect(fit.rmsResidual).toBeLessThan(0.01);
        expect(fit.coefficients[1][0]).toBeCloseTo(0.2, 1);
        expect(fit.coefficients[3][2]).toBeCloseTo(-0.1, 1);
        expect(fit.sphereCoverage).toBeGreaterThan(0.1);
        expect(fit.sphereCoverage).toBeLessThan(0.5);
    });
});

describe('direction conventions (+X east, +Y up, -Z north)', () => {
    it('a sun due east at the horizon is +X; due north is -Z; a sun in the south-west lights toward the north-east', () => {
        const east = anglesToDirection(0, 90), north = anglesToDirection(0, 0);
        expect(east[0]).toBeCloseTo(1, 9);
        expect(north[2]).toBeCloseTo(-1, 9);
        const sw = anglesToDirection(30, 225);
        expect(sw[0]).toBeLessThan(0);
        expect(sw[2]).toBeGreaterThan(0);
    });
});

describe('InverseLightingEstimatorService on measured pixels', () => {
    it('returns the sun, the measured key-to-fill ratio and no lux literals', async () => {
        const view: PinholeView = { width: 96, height: 72, hfovDeg: 100, vfovDeg: 0, headingDeg: 150, pitchDeg: 25 };
        view.vfovDeg = 2 * Math.atan(Math.tan(view.hfovDeg * Math.PI / 360) * view.height / view.width) * 180 / Math.PI;
        const pixels = renderPreethamScene(view, 35, 215, 4);
        // Paint a cast shadow on half of the ground: lit (200,180,150) vs shadow at a quarter of the linear luminance.
        for (let i = 0; i < view.width * view.height; i++) {
            const x = i % view.width;
            const y = Math.floor(i / view.width);
            if (pixelDirection(view, x, y)[1] > 0.02) continue;
            const c = x < view.width / 2 ? [200, 180, 150] : [104, 94, 78];
            pixels.set([c[0], c[1], c[2], 255], i * 4);
        }
        const est = await InverseLightingEstimatorService.decomposePixels(pixels, view.width, view.height, {
            hfovDeg: view.hfovDeg, vfovDeg: view.vfovDeg, cameraHeadingDeg: view.headingDeg, cameraPitchDeg: view.pitchDeg
        });
        expect(est.keyLight.source).toBe('preetham-sky-fit');
        // The key light travels away from the sun: its direction is minus the sun vector.
        const sun = anglesToDirection(35, 215);
        expect(angleBetween(est.keyLight.direction.map(v => -v), sun)).toBeLessThan(6);
        expect(est.keyLight.azimuthDeg).toBeGreaterThan(205);
        expect(est.keyLight.azimuthDeg).toBeLessThan(225);
        const linLum = (c: number[]) => {
            const l = c.map(v => { const n = v / 255; return n <= 0.04045 ? n / 12.92 : Math.pow((n + 0.055) / 1.055, 2.4); });
            return 0.2126 * l[0] + 0.7152 * l[1] + 0.0722 * l[2];
        };
        const truthRatio = linLum([200, 180, 150]) / linLum([104, 94, 78]);
        expect(est.litToShadowLuminanceRatio!).toBeCloseTo(truthRatio, 2);
        expect(est.keyToFillRatio!).toBeCloseTo(est.litToShadowLuminanceRatio! - 1, 2);
        expect(est.rig!.keyToFillRatio).toBe(est.keyToFillRatio);
        expect(est.rig!.lights.every(l => l.intensityLux === undefined)).toBe(true);
        expect(est.unmeasured.intensityLux).toMatch(/exposure metadata/);
        expect(est.shadowSharpness).toBeGreaterThan(0.8); // a hard step
        expect(est.assumptions).toEqual([]);
    });

    it('uses NOAA ephemeris when coordinates and time are given, with a north-referenced direction', async () => {
        const w = 32, h = 24;
        const pixels = new Uint8Array(w * h * 4).fill(128);
        const est = await InverseLightingEstimatorService.decomposePixels(pixels, w, h, {
            knownCoords: { lat: 40.7646, lng: -73.9743 }, timestampIso: '2026-06-21T20:00:00Z'
        });
        expect(est.keyLight.source).toBe('noaa-ephemeris');
        expect(est.keyLight.azimuthReference).toBe('true-north');
        // Whatever the ephemeris helper returns is what is used, and the light travels away from that sun.
        const ephem = calculateNOAASolarPosition(new Date('2026-06-21T20:00:00Z'), 40.7646, -73.9743);
        expect(est.keyLight.azimuthDeg).toBeCloseTo(ephem.azimuthDeg, 1);
        expect(est.keyLight.elevationDeg).toBeCloseTo(ephem.elevationDeg, 1);
        const towardSun = anglesToDirection(ephem.elevationDeg, ephem.azimuthDeg);
        expect(angleBetween(est.keyLight.direction.map(v => -v), towardSun)).toBeLessThan(0.01);
        expect(est.confidence).toBeUndefined();
        expect(est.assumptions).toContain('hfovDeg=60 (not given)');
    });
});
