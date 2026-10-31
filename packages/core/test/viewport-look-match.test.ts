/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * A reference photo's look matched onto the viewport's objects (look-match.ts, the output pass, sb_set_look_match):
 * - a look is measured by lightness band on the masked pixels only;
 * - a view matched to itself is unchanged; a grey render matched to a warm, contrasty photo then measures as the photo;
 * - a colourless (clay) render takes the photo's colour from the mean shift, never from amplified noise, and a band with
 *   little colour is not scaled by a ratio of two small spreads;
 * - a flat colour (a studio background) goes to the reference's middle; the sky is matched only when asked;
 * - the tone curve's slope is bounded, the chain draws the match in the output pass before the grain, and the shader
 *   repeats the reference maths' constants.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import {
    applyLookMatch,
    CHROMA_GAIN_RANGE,
    chromaGainOf,
    displayToOklab,
    fitLookMatch,
    LOOK_BANDS,
    measureLook,
    mergeLookMatch,
    oklabToDisplay,
    planLookMatch,
    TONE_SLOPE_RANGE,
    type LookMatchPlan,
    type LookPixels
} from '../src/browser/generative-canvas/services/postprocessing/look-match';
import { planViewportOptics } from '../src/browser/generative-canvas/primitives/scene3d/viewportOptics';
import { createOperatorEngine } from '../src/browser/generative-canvas/services/direct-dispatch-operator-engine';
import type { Scene3DData, SceneLookMatch } from '../src/browser/generative-canvas/canvas-types';

/** An image of `n` pixels from a colour per pixel (display, 0-1), with an optional per-pixel mask. */
function image(n: number, colour: (i: number) => [number, number, number], mask?: (i: number) => boolean): LookPixels {
    const rgba = new Uint8Array(n * 4);
    const m = mask ? new Uint8Array(n) : undefined;
    for (let i = 0; i < n; i++) {
        const c = colour(i);
        rgba[i * 4] = Math.round(c[0] * 255); rgba[i * 4 + 1] = Math.round(c[1] * 255); rgba[i * 4 + 2] = Math.round(c[2] * 255); rgba[i * 4 + 3] = 255;
        if (m) m[i] = mask!(i) ? 255 : 0;
    }
    return { rgba, mask: m, maskStride: 1 };
}
/** A display grey ramp from lo to hi, with a little hue noise of amplitude `noise` on it. */
const ramp = (n: number, lo: number, hi: number, noise = 0) => (i: number): [number, number, number] => {
    const v = lo + ((hi - lo) * i) / (n - 1);
    const d = noise * Math.sin(i * 12.9898);
    return [Math.min(1, Math.max(0, v + d)), v, Math.min(1, Math.max(0, v - d))];
};
/** The display colour of a pixel of an image, through a match. */
const through = (px: LookPixels, plan: LookMatchPlan): LookPixels => {
    const rgba = new Uint8Array(px.rgba.length);
    for (let i = 0; i < px.rgba.length; i += 4) {
        const c = applyLookMatch([px.rgba[i] / 255, px.rgba[i + 1] / 255, px.rgba[i + 2] / 255], plan);
        rgba[i] = Math.round(c[0] * 255); rgba[i + 1] = Math.round(c[1] * 255); rgba[i + 2] = Math.round(c[2] * 255); rgba[i + 3] = 255;
    }
    return { rgba, mask: px.mask, maskStride: px.maskStride };
};

describe('measuring a look', () => {
    it('bands of equal count by lightness, rising, each with its mean colour', () => {
        const n = 9000;
        // a warm (orange-ish) ramp: every band's mean colour is warm, a > 0 and b > 0
        const bands = measureLook(image(n, i => { const v = 0.1 + (0.8 * i) / (n - 1); return [v, v * 0.85, v * 0.65]; }), 'test');
        expect(bands).toHaveLength(LOOK_BANDS);
        for (let k = 1; k < bands.length; k++) expect(bands[k].L).toBeGreaterThan(bands[k - 1].L);
        for (const b of bands) { expect(b.a).toBeGreaterThan(0); expect(b.b).toBeGreaterThan(0); }
    });

    it('measures only the masked pixels', () => {
        const n = 10000;
        // left half saturated blue (masked out), right half a grey ramp (counted)
        const px = image(n, i => (i < n / 2 ? [0.1, 0.2, 0.9] : ramp(n / 2, 0.2, 0.8)(i - n / 2)), i => i >= n / 2);
        for (const b of measureLook(px, 'test')) {
            expect(Math.abs(b.a)).toBeLessThan(0.005);
            expect(Math.abs(b.b)).toBeLessThan(0.005);
        }
    });

    it('refuses a side with too few pixels', () => {
        expect(() => measureLook(image(100, () => [0.5, 0.5, 0.5]), 'the photo')).toThrow(/the photo: only 100 pixels/);
    });
});

describe('fitting and applying a look match', () => {
    it('a view matched to itself is unchanged', () => {
        const px = image(8000, ramp(8000, 0.05, 0.95, 0.04));
        const bands = measureLook(px, 'test');
        const plan: LookMatchPlan = { knots: fitLookMatch(bands, bands), strength: 1 };
        for (const c of [[0.2, 0.3, 0.25], [0.7, 0.6, 0.5], [0.5, 0.5, 0.5], [0.95, 0.9, 0.92]] as const) {
            const out = applyLookMatch(c, plan);
            for (let j = 0; j < 3; j++) expect(out[j]).toBeCloseTo(c[j], 2);
        }
    });

    it('a flat grey render matched to a warm, contrasty photo then measures as the photo', () => {
        const n = 12000;
        const render = image(n, ramp(n, 0.35, 0.65, 0.01));
        // the photo: deep shadows to bright highlights, warm highlights and cool shadows
        const photo = image(n, i => {
            const t = i / (n - 1), v = 0.08 + 0.86 * t;
            return [Math.min(1, v * (0.85 + 0.25 * t)), v * 0.95, Math.min(1, v * (1.15 - 0.4 * t))];
        });
        const ref = measureLook(photo, 'photo');
        const plan: LookMatchPlan = { knots: fitLookMatch(measureLook(render, 'render'), ref), strength: 1 };
        const after = measureLook(through(render, plan), 'matched');
        for (let k = 0; k < LOOK_BANDS; k++) {
            expect(after[k].L).toBeCloseTo(ref[k].L, 1);
            expect(Math.abs(after[k].a - ref[k].a)).toBeLessThan(0.01);
            expect(Math.abs(after[k].b - ref[k].b)).toBeLessThan(0.01);
        }
        // shadows cool (b < 0, blue) and highlights warm (b > 0, yellow), as in the photo
        expect(after[0].b).toBeLessThan(0);
        expect(after[LOOK_BANDS - 1].b).toBeGreaterThan(0);
    });

    it('a colourless render takes the colour from the mean shift, its gain near 1', () => {
        const n = 6000;
        const clay = measureLook(image(n, ramp(n, 0.3, 0.8)), 'clay');
        const stone = measureLook(image(n, i => { const v = 0.3 + (0.5 * i) / (n - 1); return [v, v * 0.92, v * 0.8]; }), 'stone');
        const knots = fitLookMatch(clay, stone);
        for (const k of knots) expect(k.chromaGain).toBeCloseTo(1, 1);
        const out = applyLookMatch([0.55, 0.55, 0.55], { knots, strength: 1 });
        const lab = displayToOklab(...out);
        expect(Math.hypot(lab[1], lab[2])).toBeGreaterThan(0.02);
        expect(out[0]).toBeGreaterThan(out[2]);
    });

    it('bounds the tone curve slope and the colour gain, and strength 0.5 lands half way', () => {
        const flat = measureLook(image(6000, ramp(6000, 0.5, 0.52, 0.05)), 'flat');
        const wide = measureLook(image(6000, ramp(6000, 0.0, 1.0, 0.0)), 'wide');
        const knots = fitLookMatch(flat, wide);
        for (let k = 1; k < knots.length; k++) {
            const slope = (knots[k].targetL - knots[k - 1].targetL) / (knots[k].sourceL - knots[k - 1].sourceL);
            expect(slope).toBeGreaterThanOrEqual(TONE_SLOPE_RANGE[0] - 1e-9);
            expect(slope).toBeLessThanOrEqual(TONE_SLOPE_RANGE[1] + 1e-9);
            expect(knots[k].chromaGain).toBeGreaterThanOrEqual(CHROMA_GAIN_RANGE[0]);
        }
        const full = displayToOklab(...applyLookMatch([0.6, 0.6, 0.6], { knots, strength: 1 }))[0];
        const half = displayToOklab(...applyLookMatch([0.6, 0.6, 0.6], { knots, strength: 0.5 }))[0];
        const none = displayToOklab(0.6, 0.6, 0.6)[0];
        expect(half).toBeCloseTo((full + none) / 2, 2);
    });

    it('a band with little colour is not amplified: the gain takes the spreads with a floor', () => {
        // the ESB refit that went pink: the view's mid band had a spread of 0.004, the photo's 0.013 (a raw ratio of 3)
        expect(chromaGainOf(0.004, 0.013)).toBeLessThan(1.3);
        expect(chromaGainOf(0.004, 0.013)).toBeGreaterThan(1);
        // a colourful band still scales by about the ratio, within the range
        expect(chromaGainOf(0.05, 0.08)).toBeCloseTo(1.55, 1);
        expect(chromaGainOf(0.01, 0.5)).toBe(CHROMA_GAIN_RANGE[1]);
        expect(chromaGainOf(0.5, 0.01)).toBe(CHROMA_GAIN_RANGE[0]);
    });

    it('a flat colour (a studio background) goes to the reference\'s middle, not its darkest band', () => {
        const flat = measureLook(image(5000, () => [0.7, 0.74, 0.8]), 'flat sky');
        // a photo's sky: a gradient from blue-grey to near white
        const sky = measureLook(image(5000, i => { const t = i / 4999; return [0.55 + 0.4 * t, 0.62 + 0.34 * t, 0.75 + 0.22 * t]; }), 'photo sky');
        const knots = fitLookMatch(flat, sky);
        expect(knots).toHaveLength(2);
        const out = displayToOklab(...applyLookMatch([0.7, 0.74, 0.8], { knots, strength: 1 }));
        const meanL = sky.reduce((t, b) => t + b.L, 0) / sky.length;
        expect(out[0]).toBeCloseTo(meanL, 2);
    });

    it('Oklab display round trip', () => {
        for (const c of [[0.1, 0.5, 0.9], [0.9, 0.2, 0.1], [0.5, 0.5, 0.5]] as const) {
            const back = oklabToDisplay(...displayToOklab(...c));
            for (let j = 0; j < 3; j++) expect(back[j]).toBeCloseTo(c[j], 6);
        }
    });
});

describe('the look match in the chain', () => {
    const n = 4000;
    const bands = measureLook(image(n, ramp(n, 0.1, 0.9, 0.03)), 'test');
    const look: SceneLookMatch = { reference: { label: 'esb.jpg', target: 'the building', bands }, knots: fitLookMatch(bands, bands) };

    it('plans the match after the lens passes and before the grain and the output', () => {
        expect(planViewportOptics(undefined, undefined, look).passes).toEqual(['look-match', 'output']);
        expect(planViewportOptics({ filmGrain: { amount: 0.3 } } as any, undefined, look).passes).toEqual(['look-match', 'film-grain', 'output']);
        expect(planViewportOptics(undefined, undefined, { ...look, strength: 0 }).passes).toEqual([]);
        expect(planLookMatch({ ...look, knots: [look.knots[1], look.knots[0]] }).lookMatch).toBeNull();
        expect(planLookMatch(look).lookMatch?.sky).toBeNull();
        expect(planLookMatch({ ...look, sky: { bands, knots: look.knots } }).lookMatch?.sky).toHaveLength(LOOK_BANDS);
        const badSky = planLookMatch({ ...look, sky: { bands, knots: [] } });
        expect(badSky.lookMatch?.sky).toBeNull();
        expect(badSky.issues[0]).toMatch(/sky not drawn/);
    });

    it('the output matches the objects where the mask marks them and the sky elsewhere, after the background is composited', () => {
        const optics = fs.readFileSync(path.join(__dirname, '../src/browser/generative-canvas/primitives/scene3d/viewportOptics.ts'), 'utf8');
        expect(optics).toMatch(/if \(uSkyKnotCount >= 2 && w < 1\.0\) outRgb = mix\(outRgb, sbLookSky\(shown\), 1\.0 - w\);/);
        expect(optics).toMatch(/sbApplyGrain\(sbMatched\(mix\(uBackground, gl_FragColor\.rgb, a\)\)\)/);
    });

    it('the shader repeats the reference maths (Oklab constants, segment rule, gain about the mean) and weights by the object mask', () => {
        const dir = path.join(__dirname, '../src/browser/generative-canvas');
        const optics = fs.readFileSync(path.join(dir, 'primitives/scene3d/viewportOptics.ts'), 'utf8');
        const ts = fs.readFileSync(path.join(dir, 'services/postprocessing/color-harmony.ts'), 'utf8');
        const constants = new Set(ts.match(/\d\.\d{10}/g));
        expect(constants.size).toBe(33);
        for (const c of constants) expect(optics).toContain(c);
        expect(optics).toMatch(/vec2 moved = \(lab\.yz - ab\.xy\) \* gain \+ ab\.zw;/);
        expect(optics).toMatch(/lab\.x < l0\.x \? lab\.x \+ \(l0\.y - l0\.x\) : lab\.x > l1\.x \? lab\.x \+ \(l1\.y - l1\.x\) : mix\(l0\.y, l1\.y, t\)/);
        expect(optics).toMatch(/float w = clamp\(texture2D\(tObjects, vUv\)\.r, 0\.0, 1\.0\);/);
        const mask = fs.readFileSync(path.join(dir, 'services/postprocessing/depthless-coverage.ts'), 'utf8');
        expect(mask).toMatch(/float w = texture2D\(tDepth, vUv\)\.x < 1\.0 \? 1\.0 : 0\.0;\s*if \(uUseCoverage\) w = max\(w, clamp\(texture2D\(tCoverage, vUv\)\.a, 0\.0, 1\.0\)\);/);
    });

    it('sb_set_look_match sets the strength and clears; it cannot make a match without the panel', () => {
        expect(() => mergeLookMatch(undefined, { strength: 0.5 })).toThrow(/no look match yet/);
        expect(() => mergeLookMatch(look, { strength: 2 })).toThrow(/strength/);
        const engine = createOperatorEngine();
        engine.loadScene({ title: 't', lookMatch: look } as Scene3DData);
        const res = engine.dispatch('sb_set_look_match', { strength: 0.6 });
        expect(res.success).toBe(true);
        expect(res.data).toMatchObject({ drawn: true, lookMatch: { reference: { label: 'esb.jpg', target: 'the building' }, strength: 0.6, knots: LOOK_BANDS } });
        expect(engine.getSceneData().lookMatch?.strength).toBe(0.6);
        engine.dispatch('sb_set_look_match', { clearSky: true });
        expect(engine.getSceneData().lookMatch?.sky).toBeUndefined();
        engine.dispatch('sb_set_look_match', { clear: true });
        expect(engine.getSceneData().lookMatch).toBeUndefined();
    });
});
