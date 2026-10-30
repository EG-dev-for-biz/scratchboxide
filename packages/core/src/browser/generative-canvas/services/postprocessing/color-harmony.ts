/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Colour harmonisation (Cohen-Or, Sorkine, Gal, Leyvand and Xu, "Color Harmonization", SIGGRAPH 2006) in OKLCH: a
 * template of hue sectors is turned to a hue, and every colour's hue moves toward the centre of its nearest sector,
 * h' = C + (w / 2) (1 - G(|h - C|)) sign(h - C), G a Gaussian of sigma w / 2, so every hue lands inside a sector and
 * hues near the centre move least. Lightness is kept (shading and texture stay); chroma is scaled on its own.
 *
 * The maths here is the reference for ColorHarmonyPass's shader (kept in step with it) and grades the flat background,
 * which the viewport composites after the scene. Pure: no GPU objects.
 */

import type { SceneColorHarmony, SceneColorHarmonySector } from '../../canvas-types';

/** Sectors the shader holds. */
export const MAX_HARMONY_SECTORS = 8;
/** The template when a harmony names no sectors: one 94 degree sector round its hue (Cohen-Or's V). */
export const DEFAULT_HARMONY_SECTORS: SceneColorHarmonySector[] = [{ offsetDeg: 0, widthDeg: 94 }];
/** Narrowest sector drawn, degrees: a zero-width sector would map every hue to one point and divide by zero. */
export const MIN_SECTOR_WIDTH_DEG = 1;
/**
 * Hues within this many degrees of a sector's opposite hue ease to its centre instead of its edge: Cohen-Or's map sends
 * the two sides of the opposite hue to opposite edges, a visible step across a gradient (a sky) that crosses it.
 */
export const OPPOSITE_HUE_EASE_DEG = 30;
/**
 * Oklab chroma a tint of 1 adds at the template hue, at a lightness of 1 (scaled down with lightness, so blacks stay
 * black): about a pastel's colourfulness, enough to colour a clay or white surface without clipping most of sRGB.
 */
export const TINT_CHROMA = 0.12;

export interface ColorHarmonyPlan {
    hueDeg: number;
    sectors: SceneColorHarmonySector[];
    strength: number;
    chroma: number;
    tint: number;
    includeBackground: boolean;
}

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const wrapDeg = (d: number): number => ((d % 360) + 360) % 360;
/** Signed angle a - b on the circle, in (-180, 180]. */
const deltaDeg = (a: number, b: number): number => {
    const d = wrapDeg(a - b);
    return d > 180 ? d - 360 : d;
};

/** What a scene's harmony draws, or null (with the reason in issues when it is malformed). */
export function planColorHarmony(h: SceneColorHarmony | undefined | null): { harmony: ColorHarmonyPlan | null; issues: string[] } {
    const issues: string[] = [];
    if (!h) return { harmony: null, issues };
    if (!finite(h.hueDeg)) return { harmony: null, issues: ['colour harmony needs hueDeg as a finite number'] };
    const given = Array.isArray(h.sectors) && h.sectors.length > 0 ? h.sectors : DEFAULT_HARMONY_SECTORS;
    const sectors = given
        .filter(s => s && finite(s.offsetDeg) && finite(s.widthDeg) && s.widthDeg > 0)
        .slice(0, MAX_HARMONY_SECTORS)
        .map(s => ({ offsetDeg: wrapDeg(s.offsetDeg), widthDeg: Math.min(360, Math.max(MIN_SECTOR_WIDTH_DEG, s.widthDeg)) }));
    if (sectors.length < given.length) issues.push(`colour harmony draws ${sectors.length} of its ${given.length} sectors (each needs a finite offsetDeg and a positive widthDeg; at most ${MAX_HARMONY_SECTORS})`);
    if (sectors.length === 0) return { harmony: null, issues };
    const strength = finite(h.strength) ? Math.min(1, Math.max(0, h.strength)) : 1;
    const chroma = finite(h.chroma) ? Math.min(2, Math.max(0, h.chroma)) : 1;
    const tint = finite(h.tint) ? Math.min(1, Math.max(0, h.tint)) : 0;
    // nothing moves: no pass
    if (strength === 0 && chroma === 1 && tint === 0) return { harmony: null, issues };
    return { harmony: { hueDeg: wrapDeg(h.hueDeg), sectors, strength, chroma, tint, includeBackground: h.includeBackground === true }, issues };
}

/** The harmonised hue (degrees) of hue `hDeg`, before the strength mix. */
export function harmonizedHueDeg(hDeg: number, plan: Pick<ColorHarmonyPlan, 'hueDeg' | 'sectors'>): number {
    // nearest sector: distance to its edge (0 inside), ties to the nearer centre
    let centre = 0, half = 0, best = Infinity, bestD = Infinity;
    for (const s of plan.sectors) {
        const c = plan.hueDeg + s.offsetDeg;
        const d = Math.abs(deltaDeg(hDeg, c));
        const outside = Math.max(d - s.widthDeg / 2, 0);
        if (outside < best || (outside === best && d < bestD)) {
            best = outside; bestD = d; centre = c; half = s.widthDeg / 2;
        }
    }
    const diff = deltaDeg(hDeg, centre);
    const g = Math.exp(-(diff * diff) / (2 * half * half));
    const t = Math.min(1, Math.max(0, (180 - Math.abs(diff)) / OPPOSITE_HUE_EASE_DEG));
    return wrapDeg(centre + Math.sign(diff) * half * (1 - g) * t * t * (3 - 2 * t));
}

/** Linear sRGB -> Oklab (Ottosson 2020). Takes HDR values: the cube root is odd, so negatives stay negative. */
export function linearSrgbToOklab(r: number, g: number, b: number): [number, number, number] {
    const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
    const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
    const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
    return [
        0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s,
        1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s,
        0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s
    ];
}

export function oklabToLinearSrgb(L: number, a: number, b: number): [number, number, number] {
    const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
    const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
    const s = (L - 0.0894841775 * a - 1.2914855480 * b) ** 3;
    return [
        4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
        -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
        -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s
    ];
}

/** OKLCH hue of a linear sRGB colour, degrees, or null for a neutral (no hue). */
export function oklchHueDeg(r: number, g: number, b: number): number | null {
    const [, A, B] = linearSrgbToOklab(r, g, b);
    if (Math.hypot(A, B) < 1e-6) return null;
    return wrapDeg((Math.atan2(B, A) * 180) / Math.PI);
}

/** One linear sRGB colour harmonised, as the shader does it (negative channels clipped to 0 after). */
export function harmonizeLinearRgb(rgb: readonly [number, number, number], plan: ColorHarmonyPlan): [number, number, number] {
    const [L, A, B] = linearSrgbToOklab(rgb[0], rgb[1], rgb[2]);
    const c = Math.hypot(A, B);
    const h = (Math.atan2(B, A) * 180) / Math.PI;
    const target = harmonizedHueDeg(h, plan);
    const hNew = ((h + plan.strength * deltaDeg(target, h)) * Math.PI) / 180;
    const cNew = c * plan.chroma;
    // the tint: chroma added at the template hue, so a neutral (which has no hue to move) takes the colour too
    const tint = plan.tint * TINT_CHROMA * Math.min(Math.max(L, 0), 1);
    const hT = (plan.hueDeg * Math.PI) / 180;
    const out = oklabToLinearSrgb(L, cNew * Math.cos(hNew) + tint * Math.cos(hT), cNew * Math.sin(hNew) + tint * Math.sin(hT));
    return [Math.max(0, out[0]), Math.max(0, out[1]), Math.max(0, out[2])];
}

/** Parameters of sb_set_color_harmony: a field given replaces it, null resets it to its default; clear removes the grade. */
export interface SetColorHarmonyParams {
    hueDeg?: number;
    sectors?: SceneColorHarmonySector[] | null;
    strength?: number | null;
    chroma?: number | null;
    tint?: number | null;
    includeBackground?: boolean | null;
    clear?: boolean;
}

/** Validates and merges sb_set_color_harmony parameters; throws (nothing written) on a bad value. */
export function mergeColorHarmony(previous: SceneColorHarmony | undefined, params: SetColorHarmonyParams): SceneColorHarmony | undefined {
    if (params.clear) return undefined;
    const fail = (why: string): never => { throw new Error(`sb_set_color_harmony: ${why}. Nothing was changed.`); };
    const next: SceneColorHarmony = previous ? { ...previous } : { hueDeg: NaN };
    if (params.hueDeg !== undefined) {
        if (!finite(params.hueDeg)) fail(`hueDeg must be a finite number of degrees (got ${String(params.hueDeg)})`);
        next.hueDeg = wrapDeg(params.hueDeg);
    }
    if (!finite(next.hueDeg)) fail('give hueDeg, the hue (degrees on the OKLCH circle) the template is turned to');
    if (params.sectors === null) delete next.sectors;
    else if (params.sectors !== undefined) {
        if (!Array.isArray(params.sectors) || params.sectors.length < 1 || params.sectors.length > MAX_HARMONY_SECTORS) fail(`sectors must be a list of 1 to ${MAX_HARMONY_SECTORS} { offsetDeg, widthDeg }`);
        for (const s of params.sectors) {
            if (!s || !finite(s.offsetDeg) || !finite(s.widthDeg) || s.widthDeg < MIN_SECTOR_WIDTH_DEG || s.widthDeg > 360) fail(`each sector needs a finite offsetDeg and a widthDeg from ${MIN_SECTOR_WIDTH_DEG} to 360 (got ${JSON.stringify(s)})`);
        }
        next.sectors = params.sectors.map(s => ({ offsetDeg: wrapDeg(s.offsetDeg), widthDeg: s.widthDeg }));
    }
    const unit = (key: 'strength' | 'chroma' | 'tint', max: number) => {
        const v = params[key];
        if (v === null) delete next[key];
        else if (v !== undefined) {
            if (!finite(v) || v < 0 || v > max) fail(`${key} must be in [0, ${max}] (got ${String(v)})`);
            next[key] = v;
        }
    };
    unit('strength', 1);
    unit('chroma', 2);
    unit('tint', 1);
    if (params.includeBackground === null) delete next.includeBackground;
    else if (params.includeBackground !== undefined) next.includeBackground = params.includeBackground === true;
    return next;
}
