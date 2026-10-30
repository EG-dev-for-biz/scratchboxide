/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The viewport's colour harmony grade (color-harmony.ts, ColorHarmonyPass, the optics chain, sb_set_color_harmony):
 * - every hue lands inside a template sector, hues near a sector's centre move least, lightness is kept;
 * - neutrals stay neutral, strength 0 changes nothing, chroma 0 greys;
 * - the chain draws the pass only when the scene asks for it, without turning on temporal anti-aliasing;
 * - the operator validates and merges, and the shader repeats the reference maths' constants.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import {
    harmonizeLinearRgb,
    harmonizedHueDeg,
    linearSrgbToOklab,
    oklabToLinearSrgb,
    oklchHueDeg,
    mergeColorHarmony,
    planColorHarmony,
    type ColorHarmonyPlan
} from '../src/browser/generative-canvas/services/postprocessing/color-harmony';
import { ViewportOpticsChain, planViewportOptics } from '../src/browser/generative-canvas/primitives/scene3d/viewportOptics';
import { createOperatorEngine } from '../src/browser/generative-canvas/services/direct-dispatch-operator-engine';
import type { Scene3DData } from '../src/browser/generative-canvas/canvas-types';

const angle = (a: number, b: number) => Math.abs((((a - b) % 360) + 540) % 360 - 180);
const plan = (p: Partial<ColorHarmonyPlan> & { hueDeg: number }): ColorHarmonyPlan =>
    ({ sectors: [{ offsetDeg: 0, widthDeg: 94 }], strength: 1, chroma: 1, tint: 0, includeBackground: false, ...p });

describe('colour harmony maths', () => {
    it('Oklab round-trips linear sRGB, HDR values included', () => {
        for (const rgb of [[0.8, 0.1, 0.05], [0.02, 0.4, 0.9], [3.5, 2.0, 0.4], [0.18, 0.18, 0.18]] as const) {
            const back = oklabToLinearSrgb(...linearSrgbToOklab(...rgb));
            back.forEach((v, i) => expect(v).toBeCloseTo(rgb[i], 6));
        }
    });

    it('every hue lands inside its nearest sector, and the centre stays put', () => {
        const templates: ColorHarmonyPlan['sectors'][] = [
            [{ offsetDeg: 0, widthDeg: 18 }],
            [{ offsetDeg: 0, widthDeg: 18 }, { offsetDeg: 180, widthDeg: 18 }],
            [{ offsetDeg: 0, widthDeg: 18 }, { offsetDeg: 120, widthDeg: 18 }, { offsetDeg: 240, widthDeg: 18 }],
            [{ offsetDeg: 0, widthDeg: 94 }]
        ];
        for (const sectors of templates) {
            const p = plan({ hueDeg: 265, sectors });
            for (let h = 0; h < 360; h += 7) {
                const out = harmonizedHueDeg(h, p);
                const inside = sectors.some(s => angle(out, p.hueDeg + s.offsetDeg) <= s.widthDeg / 2 + 1e-9);
                expect(inside, `hue ${h} -> ${out}`).toBe(true);
            }
            for (const s of sectors) expect(angle(harmonizedHueDeg(p.hueDeg + s.offsetDeg, p), p.hueDeg + s.offsetDeg)).toBeLessThan(1e-9);
        }
    });

    it('is continuous across the opposite hue (no step in a gradient that crosses it)', () => {
        const p = plan({ hueDeg: 145, sectors: [{ offsetDeg: 0, widthDeg: 18 }] });
        for (let h = 300; h < 350; h += 0.25) expect(angle(harmonizedHueDeg(h, p), harmonizedHueDeg(h + 0.25, p))).toBeLessThan(0.5);
    });

    it('a hue near the centre moves less than one far from it, and both keep their side', () => {
        const p = plan({ hueDeg: 100 });
        const near = harmonizedHueDeg(110, p), far = harmonizedHueDeg(200, p);
        expect(angle(near, 110)).toBeLessThan(angle(far, 200));
        expect(near).toBeGreaterThan(100);
        expect(far).toBeGreaterThan(100);
    });

    it('turns a red object toward the template hue, keeping its Oklab lightness', () => {
        const red: [number, number, number] = [0.7, 0.05, 0.04];
        const p = plan({ hueDeg: 265, sectors: [{ offsetDeg: 0, widthDeg: 18 }] });
        const out = harmonizeLinearRgb(red, p);
        expect(angle(oklchHueDeg(...out)!, 265)).toBeLessThanOrEqual(9 + 0.5);
        expect(linearSrgbToOklab(...out)[0]).toBeCloseTo(linearSrgbToOklab(...red)[0], 2);
        // blue: more blue than red now
        expect(out[2]).toBeGreaterThan(out[0]);
    });

    it('neutrals stay neutral, strength 0 changes nothing, chroma 0 greys', () => {
        const grey: [number, number, number] = [0.3, 0.3, 0.3];
        harmonizeLinearRgb(grey, plan({ hueDeg: 40 })).forEach(v => expect(v).toBeCloseTo(0.3, 5));
        const c: [number, number, number] = [0.1, 0.5, 0.2];
        harmonizeLinearRgb(c, plan({ hueDeg: 40, strength: 0 })).forEach((v, i) => expect(v).toBeCloseTo(c[i], 6));
        const g = harmonizeLinearRgb(c, plan({ hueDeg: 40, chroma: 0 }));
        expect(Math.max(...g) - Math.min(...g)).toBeLessThan(1e-6);
    });
});

describe('colour harmony tint', () => {
    it('colours a grey at the template hue, keeping its lightness; black stays black', () => {
        const clay: [number, number, number] = [0.45, 0.45, 0.45];
        const out = harmonizeLinearRgb(clay, plan({ hueDeg: 145, tint: 1 }));
        expect(angle(oklchHueDeg(...out)!, 145)).toBeLessThan(0.5);
        expect(Math.max(...out) - Math.min(...out)).toBeGreaterThan(0.05);
        expect(linearSrgbToOklab(...out)[0]).toBeCloseTo(linearSrgbToOklab(...clay)[0], 2);
        harmonizeLinearRgb([0, 0, 0], plan({ hueDeg: 145, tint: 1 })).forEach(v => expect(v).toBe(0));
    });

    it('a tint alone is a pass to draw', () => {
        expect(planColorHarmony({ hueDeg: 145, strength: 0, tint: 0.3 }).harmony?.tint).toBe(0.3);
        expect(() => mergeColorHarmony({ hueDeg: 10 }, { tint: 2 })).toThrow(/tint/);
    });
});

describe('colour harmony plan and chain', () => {
    it('plans nothing without a hue, or when nothing would move', () => {
        expect(planColorHarmony(undefined).harmony).toBeNull();
        expect(planColorHarmony({ hueDeg: NaN }).issues[0]).toMatch(/hueDeg/);
        expect(planColorHarmony({ hueDeg: 40, strength: 0 }).harmony).toBeNull();
        expect(planColorHarmony({ hueDeg: 40, strength: 0, chroma: 0.5 }).harmony?.chroma).toBe(0.5);
        expect(planColorHarmony({ hueDeg: -30 }).harmony).toEqual({ hueDeg: 330, sectors: [{ offsetDeg: 0, widthDeg: 94 }], strength: 1, chroma: 1, tint: 0, includeBackground: false });
    });

    it('draws before the lens passes, and alone needs no temporal anti-aliasing', () => {
        expect(planViewportOptics(undefined, { hueDeg: 200 }).passes).toEqual(['color-harmony', 'output']);
        expect(planViewportOptics({ distortion: { k1: -0.15 } }, { hueDeg: 200 }).passes).toEqual(['color-harmony', 'lens-distortion', 'output']);
        expect(planViewportOptics({ distortion: { k1: -0.15 } }).passes).toEqual(['lens-distortion', 'output']);

        const chain = new ViewportOpticsChain();
        chain.configure(undefined, { hueDeg: 200 });
        expect(chain.active).toBe(true);
        expect((chain as any).harmonyPass).not.toBeNull();
        expect((chain as any).taaPass).toBeNull();
        chain.configure({ distortion: { k1: -0.15 } }, { hueDeg: 200 });
        expect((chain as any).taaPass).not.toBeNull();
        chain.configure(undefined, undefined);
        expect(chain.active).toBe(false);
        expect((chain as any).harmonyPass).toBeNull();
        chain.dispose();
    });

    it('the shader repeats the reference maths (same Oklab constants, same sector rule)', () => {
        const dir = path.join(__dirname, '../src/browser/generative-canvas/services/postprocessing');
        const glsl = fs.readFileSync(path.join(dir, 'ColorHarmonyPass.ts'), 'utf8');
        const ts = fs.readFileSync(path.join(dir, 'color-harmony.ts'), 'utf8');
        const constants = (src: string) => new Set(src.match(/\d\.\d{10}/g));
        const fromTs = constants(ts);
        // the two 3 x 3 matrices each way, less the inverse's three unit L terms
        expect(fromTs.size).toBe(33);
        for (const c of fromTs) expect(glsl).toContain(c);
        expect(glsl).toMatch(/max\(d - 0\.5 \* uSectors\[i\]\.y, 0\.0\)/);
        expect(glsl).toMatch(/exp\(-\(diff \* diff\) \/ \(2\.0 \* halfW \* halfW\)\)/);
        expect(glsl).toMatch(/uTint \* TINT_CHROMA \* clamp\(lab\.x, 0\.0, 1\.0\) \* vec2\(cos\(uHue\), sin\(uHue\)\)/);
        expect(glsl).toMatch(/smoothstep\(0\.0, 1\.0, \(PI - abs\(diff\)\) \/ OPPOSITE_EASE\)/);
    });
});

describe('sb_set_color_harmony', () => {
    it('validates and merges; null resets a field, clear removes the grade', () => {
        expect(() => mergeColorHarmony(undefined, { strength: 0.5 })).toThrow(/hueDeg/);
        expect(() => mergeColorHarmony(undefined, { hueDeg: 10, chroma: 3 })).toThrow(/chroma/);
        expect(() => mergeColorHarmony(undefined, { hueDeg: 10, sectors: [] })).toThrow(/sectors/);
        const a = mergeColorHarmony(undefined, { hueDeg: 370, strength: 0.4 })!;
        expect(a).toEqual({ hueDeg: 10, strength: 0.4 });
        expect(mergeColorHarmony(a, { strength: null, includeBackground: true })).toEqual({ hueDeg: 10, includeBackground: true });
        expect(mergeColorHarmony(a, { clear: true })).toBeUndefined();
    });

    it('writes the scene data the viewport draws', () => {
        const engine = createOperatorEngine();
        engine.loadScene({ title: 't' } as Scene3DData);
        const res = engine.dispatch('sb_set_color_harmony', { hueDeg: 145, sectors: [{ offsetDeg: 0, widthDeg: 18 }, { offsetDeg: 180, widthDeg: 18 }] });
        expect(res.success).toBe(true);
        expect(res.data).toMatchObject({ drawn: true });
        expect(engine.getSceneData().colorHarmony).toEqual({ hueDeg: 145, sectors: [{ offsetDeg: 0, widthDeg: 18 }, { offsetDeg: 180, widthDeg: 18 }] });
        const bad = engine.dispatch('sb_set_color_harmony', { strength: 4 });
        expect(bad.success).toBe(false);
        expect(engine.getSceneData().colorHarmony?.strength).toBeUndefined();
        engine.dispatch('sb_set_color_harmony', { clear: true });
        expect(engine.getSceneData().colorHarmony).toBeUndefined();
    });
});
