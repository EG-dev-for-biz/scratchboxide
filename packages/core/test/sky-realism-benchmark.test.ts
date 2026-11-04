/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The sky realism benchmark's measurements on synthetic panoramas with known answers: the sun disc is found where it
 * was drawn, scores ignore exposure, a changed gradient or colour is caught, and a lamp at night is not a sun.
 */

import { describe, it, expect } from 'vitest';
import { measureEquirectSky, EquirectImage, pixelElevation, pixelAzimuth } from '../src/node/atmosphere-benchmark/equirect-sky';
import { scoreSkyRealism, SKY_REALISM_TOLERANCES } from '../src/node/atmosphere-benchmark/sky-realism-score';

const DEG = Math.PI / 180;

/** A clear-sky-like panorama: brighter toward the horizon and the sun, a 0.53° disc 1e5x the sky. */
function synthSky(opts: { sunEl: number; sunAz: number; exposure?: number; horizonGain?: number; tint?: [number, number, number]; disc?: number }): EquirectImage {
    const W = 1024, H = 512, rgb = new Float32Array(W * H * 3);
    const [tr, tg, tb] = opts.tint ?? [0.55, 0.75, 1.0];
    const k = opts.exposure ?? 1, hg = opts.horizonGain ?? 2.5;
    for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
        const e = pixelElevation({ width: W, height: H, rgb }, j), a = pixelAzimuth({ width: W, height: H, rgb }, i);
        const cosG = Math.sin(e * DEG) * Math.sin(opts.sunEl * DEG) + Math.cos(e * DEG) * Math.cos(opts.sunEl * DEG) * Math.cos((a - opts.sunAz) * DEG);
        const gamma = Math.acos(Math.max(-1, Math.min(1, cosG))) / DEG;
        let Y = e < 0 ? 0.05 : (1 + (hg - 1) * Math.exp(-Math.max(0, e) / 12)) * (1 + 3 * Math.exp(-gamma / 10));
        let c: [number, number, number] = [tr, tg, tb];
        if (gamma < 0.27) { Y = opts.disc ?? 1e5; c = [1, 0.95, 0.88]; }
        const d = (j * W + i) * 3;
        rgb[d] = k * Y * c[0]; rgb[d + 1] = k * Y * c[1]; rgb[d + 2] = k * Y * c[2];
    }
    return { width: W, height: H, rgb };
}

const lights = { sunIntensity: 3, sunColor: [1, 0.95, 0.88] as [number, number, number], hemiIntensity: 1, hemiSkyLuminance: 0.8, hemiGroundLuminance: 0.2, castShadow: true };

describe('sky realism benchmark measurements', () => {
    it('finds the drawn sun disc to a fraction of a degree', () => {
        const m = measureEquirectSky(synthSky({ sunEl: 32, sunAz: 140 }));
        expect(m.anchor).toBe('sun-disc');
        expect(m.sun!.elevationDeg).toBeCloseTo(32, 0);
        expect(Math.abs(m.sun!.imageAzimuthDeg - 140)).toBeLessThan(0.6);
        expect(m.samples.length).toBe(35);
    });

    it('a bright point after dark is not taken for the sun', () => {
        const m = measureEquirectSky(synthSky({ sunEl: 8, sunAz: 40 }), { sunMayBeUp: false });
        expect(m.sun).toBeUndefined();
        expect(m.anchor).toBe('horizon-glow');
    });

    it('scores do not depend on exposure; the same sky scores zero error', () => {
        const a = measureEquirectSky(synthSky({ sunEl: 30, sunAz: 100 }));
        const b = measureEquirectSky(synthSky({ sunEl: 30, sunAz: 250, exposure: 37 }));
        const s = scoreSkyRealism(a, b, lights, 30);
        expect(s.metrics.gradientLogRms!).toBeLessThan(0.02);
        expect(s.metrics.skyChromaDeltaUv!).toBeLessThan(0.001);
        expect(s.metrics.horizonZenithLogError!).toBeLessThan(0.02);
    });

    it('catches a flatter gradient and a different sky colour', () => {
        const photo = measureEquirectSky(synthSky({ sunEl: 30, sunAz: 100 }));
        const flat = measureEquirectSky(synthSky({ sunEl: 30, sunAz: 100, horizonGain: 1.1, tint: [0.35, 0.7, 1.0] }));
        const s = scoreSkyRealism(photo, flat, lights, 30);
        expect(s.metrics.horizonZenithLogError!).toBeGreaterThan(SKY_REALISM_TOLERANCES.horizonZenithLogError);
        expect(s.metrics.skyChromaDeltaUv!).toBeGreaterThan(SKY_REALISM_TOLERANCES.skyChromaDeltaUv);
        expect(s.failed).toEqual(expect.arrayContaining(['horizonZenithLogError', 'skyChromaDeltaUv']));
    });

    it('the direct-to-diffuse ratio follows the scene lights', () => {
        const photo = measureEquirectSky(synthSky({ sunEl: 40, sunAz: 100 }));
        const render = measureEquirectSky(synthSky({ sunEl: 40, sunAz: 100 }));
        const a = scoreSkyRealism(photo, render, lights, 40).metrics.directDiffuseLogError!;
        const b = scoreSkyRealism(photo, render, { ...lights, sunIntensity: lights.sunIntensity * Math.E }, 40).metrics.directDiffuseLogError!;
        expect(Math.abs(Math.abs(b - a) - 1)).toBeLessThan(1e-9);
    });
});

import { measureClouds } from '../src/node/atmosphere-benchmark/equirect-sky';
import { layerCoverageForSkyCover } from '../src/browser/generative-canvas/services/atmosphere/AtmosphericSkyDome';

describe('cloud measurement and coverage mapping', () => {
    it('a clear blue sky has no cloud; white (or warm-lit) patches count as cloud by solid angle', () => {
        const sky = synthSky({ sunEl: 40, sunAz: 100 });
        expect(measureClouds(sky, { elevationDeg: 40, imageAzimuthDeg: 100 }).fraction).toBeLessThan(0.01);
        // Paint the band 30-50° up, azimuth 200-290°, white (half of it) and orange (the other half).
        const W = sky.width, H = sky.height;
        for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
            const e = pixelElevation(sky, j), a = pixelAzimuth(sky, i);
            if (e < 30 || e > 50 || a < 200 || a > 290) continue;
            const k = (j * W + i) * 3, warm = a > 245;
            sky.rgb[k] = 4; sky.rgb[k + 1] = warm ? 3 : 4; sky.rgb[k + 2] = warm ? 1.8 : 4;
        }
        const c = measureClouds(sky, { elevationDeg: 40, imageAzimuthDeg: 100 });
        // Solid-angle share of that patch within 15-85° (cos-weighted), about 0.08.
        expect(c.fraction).toBeGreaterThan(0.06);
        expect(c.fraction).toBeLessThan(0.11);
        expect(c.cloudLuminance![1]).toBeGreaterThan(1);
    });

    it('sky cover maps to a monotone plan coverage of the cumulus layer, from none to overcast', () => {
        let prev = -1;
        for (let f = 0; f <= 1.0001; f += 0.05) {
            const l = layerCoverageForSkyCover(f);
            expect(l).toBeGreaterThanOrEqual(prev);
            expect(l).toBeGreaterThanOrEqual(0);
            expect(l).toBeLessThanOrEqual(1);
            prev = l;
        }
        expect(layerCoverageForSkyCover(0)).toBe(0);
        expect(layerCoverageForSkyCover(1)).toBe(1);
        // the sparsest skies: cloud sides fill sky, so a little of the layer shows as more of the sky
        expect(layerCoverageForSkyCover(0.032)).toBeCloseTo(0.01, 6);
        // the location sky's partly cloudy 0.4: see-through edges show the sky, so about half the layer is cloud
        expect(layerCoverageForSkyCover(0.392)).toBeCloseTo(0.497, 6);
        expect(layerCoverageForSkyCover(0.512)).toBeCloseTo(0.673, 6);
    });
});
