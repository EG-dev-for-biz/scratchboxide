/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * A reference photo's look matched onto the viewport's objects. Both sides are measured in Oklab on display colours (the
 * photo as stored, the viewport as shown), split into bands of equal pixel count by lightness. Each band's lightness maps
 * to the reference's at the same rank (a tone curve: contrast, shadow lift, highlight roll-off), its mean colour to the
 * reference's (white balance and the cast of each tone: warm light, cool shade), and the spread of colour about the mean
 * by the ratio of spreads (saturation per tone). Between knots the map is interpolated by lightness, so it is smooth.
 *
 * The maths here is the reference for the output pass's shader (viewportOptics.ts, kept in step with it). Pure: no GPU
 * objects.
 */

import type { SceneLookBand, SceneLookMatch, SceneLookMatchKnot } from '../../canvas-types';
import { linearSrgbToOklab, oklabToLinearSrgb } from './color-harmony';

/** Lightness bands measured on each side (the shader holds this many knots). */
export const LOOK_BANDS = 9;
/** Fewest pixels a side needs: fewer and a band's mean is a handful of pixels. */
export const MIN_LOOK_PIXELS = 400;
/** A side is measured on at most this many pixels (taken evenly across the image). */
export const MAX_LOOK_PIXELS = 200_000;
/** Pixels whose mask weight is under this are left out. */
export const LOOK_MASK_THRESHOLD = 0.5;
/**
 * Spread ratio bounds. Below MIN_SOURCE_SPREAD the objects have no colour to scale (clay, grey): their gain is 1 and the
 * band's colour comes from the mean shift alone, so noise is never amplified into colour.
 */
export const CHROMA_GAIN_RANGE: [number, number] = [0.25, 3];
export const MIN_SOURCE_SPREAD = 0.004;
/** The tone curve's slope between knots is kept within this range, so a step in the photo's histogram is not a step on screen. */
export const TONE_SLOPE_RANGE: [number, number] = [0.25, 4];

export interface LookPixels {
    /** RGBA, 8 bits a channel, display (sRGB-encoded) colours. */
    rgba: Uint8Array | Uint8ClampedArray;
    /** One weight per pixel (0-255), absent = every pixel counts. Same pixel order as rgba. */
    mask?: Uint8Array | Uint8ClampedArray;
    /** Bytes between one pixel's mask weight and the next (4 for an RGBA mask read from its red channel, 1 for a plain one). */
    maskStride?: number;
}

export interface LookMatchPlan {
    knots: SceneLookMatchKnot[];
    strength: number;
}

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

export const srgbDecode = (c: number): number => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
export const srgbEncode = (c: number): number => (c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055);

const DECODE_8BIT = Float64Array.from({ length: 256 }, (_, i) => srgbDecode(i / 255));

/** Oklab of a display colour (each channel 0-1, sRGB-encoded). */
export function displayToOklab(r: number, g: number, b: number): [number, number, number] {
    return linearSrgbToOklab(srgbDecode(r), srgbDecode(g), srgbDecode(b));
}

/** Display colour (each channel 0-1, sRGB-encoded, clipped) of an Oklab colour. */
export function oklabToDisplay(L: number, a: number, b: number): [number, number, number] {
    const lin = oklabToLinearSrgb(L, a, b);
    return [srgbEncode(clamp(lin[0], 0, 1)), srgbEncode(clamp(lin[1], 0, 1)), srgbEncode(clamp(lin[2], 0, 1))];
}

/** The masked pixels as Oklab triples (taken evenly, at most MAX_LOOK_PIXELS). */
function sampleOklab(px: LookPixels): Float64Array {
    const n = Math.floor(px.rgba.length / 4);
    const stride = px.maskStride ?? 1;
    const counted = (i: number) => !px.mask || px.mask[i * stride] >= LOOK_MASK_THRESHOLD * 255;
    let total = 0;
    for (let i = 0; i < n; i++) if (counted(i)) total++;
    const step = Math.max(1, total / MAX_LOOK_PIXELS);
    const out = new Float64Array(Math.min(total, MAX_LOOK_PIXELS) * 3);
    let k = 0, seen = 0, next = 0;
    for (let i = 0; i < n && k < out.length; i++) {
        if (!counted(i)) continue;
        if (seen++ < next) continue;
        next += step;
        const lab = linearSrgbToOklab(DECODE_8BIT[px.rgba[i * 4]], DECODE_8BIT[px.rgba[i * 4 + 1]], DECODE_8BIT[px.rgba[i * 4 + 2]]);
        out[k++] = lab[0]; out[k++] = lab[1]; out[k++] = lab[2];
    }
    return out.subarray(0, k);
}

/**
 * The look of what `px` shows: LOOK_BANDS bands of equal pixel count by lightness, each its median lightness, mean colour
 * and spread. Throws when fewer than MIN_LOOK_PIXELS pixels are counted.
 */
export function measureLook(px: LookPixels, side: string): SceneLookBand[] {
    const lab = sampleOklab(px);
    const count = lab.length / 3;
    if (count < MIN_LOOK_PIXELS) throw new Error(`${side}: only ${count} pixels to measure (at least ${MIN_LOOK_PIXELS} are needed)`);
    const order = Array.from({ length: count }, (_, i) => i).sort((p, q) => lab[p * 3] - lab[q * 3]);
    const bands: SceneLookBand[] = [];
    for (let k = 0; k < LOOK_BANDS; k++) {
        const from = Math.floor((k * count) / LOOK_BANDS), to = Math.max(from + 1, Math.floor(((k + 1) * count) / LOOK_BANDS));
        let a = 0, b = 0;
        for (let j = from; j < to; j++) { a += lab[order[j] * 3 + 1]; b += lab[order[j] * 3 + 2]; }
        const n = to - from;
        a /= n; b /= n;
        let s = 0;
        for (let j = from; j < to; j++) {
            const da = lab[order[j] * 3 + 1] - a, db = lab[order[j] * 3 + 2] - b;
            s += da * da + db * db;
        }
        bands.push({ L: lab[order[Math.floor((from + to - 1) / 2)] * 3], a, b, spread: Math.sqrt(s / n) });
    }
    return bands;
}

/**
 * The map from the objects' look onto the reference's: one knot per band, at the same rank. Source lightness is made
 * strictly rising (a flat render has equal medians), and the tone curve's slope kept within TONE_SLOPE_RANGE.
 */
export function fitLookMatch(source: SceneLookBand[], reference: SceneLookBand[]): SceneLookMatchKnot[] {
    if (source.length !== reference.length || source.length < 2) throw new Error(`a look match needs the same number of bands on both sides (got ${source.length} and ${reference.length})`);
    const knots: SceneLookMatchKnot[] = [];
    let lastS = -Infinity, lastT = -Infinity;
    for (let k = 0; k < source.length; k++) {
        const s = source[k], r = reference[k];
        const sourceL = Math.max(s.L, lastS + 1e-3);
        let targetL = r.L;
        if (k > 0) {
            const dS = sourceL - lastS;
            targetL = clamp(targetL, lastT + dS * TONE_SLOPE_RANGE[0], lastT + dS * TONE_SLOPE_RANGE[1]);
        }
        const chromaGain = s.spread < MIN_SOURCE_SPREAD ? 1 : clamp(r.spread / s.spread, CHROMA_GAIN_RANGE[0], CHROMA_GAIN_RANGE[1]);
        knots.push({ sourceL, targetL, sourceA: s.a, sourceB: s.b, targetA: r.a, targetB: r.b, chromaGain });
        lastS = sourceL; lastT = targetL;
    }
    return knots;
}

/** What a scene's look match draws, or null (with the reason in issues when it is malformed). */
export function planLookMatch(m: SceneLookMatch | undefined | null): { lookMatch: LookMatchPlan | null; issues: string[] } {
    if (!m) return { lookMatch: null, issues: [] };
    const knots = Array.isArray(m.knots) ? m.knots : [];
    const keys: Array<keyof SceneLookMatchKnot> = ['sourceL', 'targetL', 'sourceA', 'sourceB', 'targetA', 'targetB', 'chromaGain'];
    const ok = knots.length >= 2 && knots.length <= LOOK_BANDS && knots.every((k, i) => k && keys.every(key => finite(k[key])) && (i === 0 || k.sourceL > knots[i - 1].sourceL));
    if (!ok) return { lookMatch: null, issues: [`look match not drawn: it needs 2 to ${LOOK_BANDS} knots of finite numbers, by rising sourceL`] };
    const strength = finite(m.strength) ? clamp(m.strength, 0, 1) : 1;
    if (strength === 0) return { lookMatch: null, issues: [] };
    return { lookMatch: { knots: knots.map(k => ({ ...k })), strength }, issues: [] };
}

/** One display colour (each channel 0-1) through the match, as the shader does it. */
export function applyLookMatch(rgb: readonly [number, number, number], plan: LookMatchPlan): [number, number, number] {
    const [L, a, b] = displayToOklab(rgb[0], rgb[1], rgb[2]);
    const ks = plan.knots;
    // the segment holding L; past either end, the end knot's offsets carry on
    let i = 0;
    while (i < ks.length - 2 && L > ks[i + 1].sourceL) i++;
    const k0 = ks[i], k1 = ks[i + 1];
    const t = clamp((L - k0.sourceL) / (k1.sourceL - k0.sourceL), 0, 1);
    const mix = (p: number, q: number) => p + (q - p) * t;
    const below = L < k0.sourceL, above = L > k1.sourceL;
    const L2 = below ? L + (k0.targetL - k0.sourceL) : above ? L + (k1.targetL - k1.sourceL) : mix(k0.targetL, k1.targetL);
    const gain = mix(k0.chromaGain, k1.chromaGain);
    const a2 = (a - mix(k0.sourceA, k1.sourceA)) * gain + mix(k0.targetA, k1.targetA);
    const b2 = (b - mix(k0.sourceB, k1.sourceB)) * gain + mix(k0.targetB, k1.targetB);
    const s = plan.strength;
    return oklabToDisplay(L + (L2 - L) * s, a + (a2 - a) * s, b + (b2 - b) * s);
}

/** Parameters of sb_set_look_match: strength (null resets it), or clear. The fit itself is made from a reference photo. */
export interface SetLookMatchParams {
    strength?: number | null;
    clear?: boolean;
}

/** Validates and merges sb_set_look_match parameters; throws (nothing written) on a bad value. */
export function mergeLookMatch(previous: SceneLookMatch | undefined, params: SetLookMatchParams): SceneLookMatch | undefined {
    if (params.clear) return undefined;
    const fail = (why: string): never => { throw new Error(`sb_set_look_match: ${why}. Nothing was changed.`); };
    if (!previous) fail('the scene has no look match yet; match one from a reference photo in the Colour harmony panel first');
    const next: SceneLookMatch = { ...previous! };
    if (params.strength === null) delete next.strength;
    else if (params.strength !== undefined) {
        if (!finite(params.strength) || params.strength < 0 || params.strength > 1) fail(`strength must be in [0, 1] (got ${String(params.strength)})`);
        next.strength = params.strength;
    }
    return next;
}
