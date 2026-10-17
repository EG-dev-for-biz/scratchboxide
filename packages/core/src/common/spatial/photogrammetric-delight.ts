/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Photogrammetric de-lighting as a pure function: the shadow lift and highlight compression of the browser shader
 * (LocationObjectLightingService.applyPhotogrammetricDelightShader, LOCATION_DELIGHT_FRAGMENT_CHUNK heuristic path),
 * so a node bake and the runtime shader read the same numbers and cannot drift. The GLSL chunk interpolates these
 * constants. Only the albedo part is here (lift, compress); the stone tint, sky catch-light, ground bounce and
 * de-wash are viewing-atmosphere choices of the runtime, not properties of the surface, so a bake leaves them out.
 *
 * Works in linear RGB 0..1 (the shader runs on linear fragment colour). No solar geometry: a texel with a known sun
 * direction and capture date is de-lit by SurveyTextureUnprojector.solarDelighting instead.
 */

export interface PhotogrammetricDelightParams {
    /** Pull of baked shadow crevices toward the neutral luma baseline, 0..1. Shader uniform uShadowLift. */
    shadowLift: number;
    /** Compression of baked sun highlights, 0..1. Shader uniform uHighlightCompress. */
    highlightCompress: number;
}

/** The constants of the heuristic (shared with the GLSL chunk). */
export const PHOTOGRAMMETRIC_DELIGHT = {
    defaults: { shadowLift: 0.60, highlightCompress: 0.45 } as PhotogrammetricDelightParams,
    /** shadowFactor = clamp(1 - luma * shadowSlope, 0, 1). */
    shadowSlope: 2.2,
    /** The lift target is luma * liftGain + liftOffset (grey). */
    liftGain: 1.6,
    liftOffset: 0.14,
    /** highlightFactor = smoothstep(highlightLo, highlightHi, luma). */
    highlightLo: 0.60,
    highlightHi: 0.98,
    /** A full highlight is scaled by this. */
    highlightScale: 0.76,
    /** Rec. 601 luma weights of the shader. */
    luma: [0.299, 0.587, 0.114] as const
};

const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);
function smoothstep(lo: number, hi: number, x: number): number {
    const t = clamp01((x - lo) / (hi - lo));
    return t * t * (3 - 2 * t);
}

/** De-lights one linear-RGB colour (0..1); returns a new triple. */
export function delightLinearRgb(r: number, g: number, b: number, params: PhotogrammetricDelightParams = PHOTOGRAMMETRIC_DELIGHT.defaults): [number, number, number] {
    const k = PHOTOGRAMMETRIC_DELIGHT;
    const luma = k.luma[0] * r + k.luma[1] * g + k.luma[2] * b;
    const shadowFactor = clamp01(1 - luma * k.shadowSlope) * params.shadowLift;
    const target = luma * k.liftGain + k.liftOffset;
    const lr = r + (target - r) * shadowFactor, lg = g + (target - g) * shadowFactor, lb = b + (target - b) * shadowFactor;
    const h = smoothstep(k.highlightLo, k.highlightHi, luma) * params.highlightCompress;
    const s = 1 + (k.highlightScale - 1) * h;
    return [lr * s, lg * s, lb * s];
}

/** sRGB 8-bit to linear 0..1 lookup. */
export const SRGB8_TO_LINEAR: Float32Array = (() => {
    const t = new Float32Array(256);
    for (let i = 0; i < 256; i++) { const c = i / 255; t[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); }
    return t;
})();

/** Linear 0..1 to sRGB 0..255 (float, unrounded, clamped). */
export function linearToSrgb255(c: number): number {
    const x = clamp01(c);
    return 255 * (x <= 0.0031308 ? x * 12.92 : 1.055 * Math.pow(x, 1 / 2.4) - 0.055);
}

/**
 * Lift cap of the texture tiers (bakes only; the browser shader keeps the uncapped per-fragment heuristic).
 *
 * The shadow lift pulls every dark colour toward grey, which is right for a baked cast shadow but wrong for a surface
 * that is genuinely dark: a window opening, a dark door, a recess. What tells them apart in a texture is the
 * neighbourhood. A cast shadow over a face, or a face in shade, darkens a whole region, so a texel in it is about as
 * dark as its surroundings; a window opening is a dark patch inside a lit wall. The cap scales each texel's lift by
 *   keep = clamp(1 - contrastGain * darkness, 0, 1),  darkness = clamp((meanLuma(window) - luma) / meanLuma(window), 0, 1)
 * over a box window of `radiusTexels` around the texel (texels the bake produced only). Continuous: no threshold, no
 * class. Highlight compression is not capped (a highlight is never a property of the surface).
 */
export interface DelightLiftCap {
    /** Half-size of the neighbourhood box, texels (callers convert from metres with the atlas's texel size). */
    radiusTexels: number;
    /** How fast local darkness removes the lift: at darkness 1 / contrastGain the lift is gone. */
    contrastGain: number;
}

/** Defaults: a 1.5 m neighbourhood (larger than a window bay, smaller than a facade) and full removal at 50 percent local darkness. */
export const TEXTURE_LIFT_CAP = { radiusM: 1.5, contrastGain: 2 } as const;

export interface DelightPlaneReport {
    /** Texels de-lit. */
    texels: number;
    /** Mean of keep over the texels the uncapped lift would have touched (shadowFactor > 0). */
    meanLiftKept: number;
    /** Texels whose lift was cut by more than half. */
    liftHalvedTexels: number;
}

/**
 * De-lights a plane of linear RGB (3 floats per texel, 0..1) in place, with the shadow lift capped by local contrast.
 * `has` marks the texels to de-light (and the only ones that count as neighbours). Without `cap` it is exactly
 * delightLinearRgb per texel.
 */
export function delightLinearPlane(
    rgb: Float32Array | Float64Array, has: Uint8Array, width: number, height: number,
    params: PhotogrammetricDelightParams = PHOTOGRAMMETRIC_DELIGHT.defaults, cap?: DelightLiftCap
): DelightPlaneReport {
    const k = PHOTOGRAMMETRIC_DELIGHT;
    const n = width * height;
    const L = new Float64Array(n);
    for (let i = 0; i < n; i++) if (has[i]) L[i] = k.luma[0] * rgb[i * 3] + k.luma[1] * rgb[i * 3 + 1] + k.luma[2] * rgb[i * 3 + 2];
    // summed-area tables of luma and count over produced texels
    let satL: Float64Array | undefined, satN: Float64Array | undefined;
    const r = cap ? Math.max(1, Math.round(cap.radiusTexels)) : 0;
    if (cap) {
        const W1 = width + 1;
        satL = new Float64Array(W1 * (height + 1));
        satN = new Float64Array(W1 * (height + 1));
        for (let y = 0; y < height; y++) {
            let rowL = 0, rowN = 0;
            for (let x = 0; x < width; x++) {
                const i = y * width + x;
                if (has[i]) { rowL += L[i]; rowN++; }
                satL[(y + 1) * W1 + x + 1] = satL[y * W1 + x + 1] + rowL;
                satN[(y + 1) * W1 + x + 1] = satN[y * W1 + x + 1] + rowN;
            }
        }
    }
    let texels = 0, touched = 0, keptSum = 0, halved = 0;
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
        const i = y * width + x;
        if (!has[i]) continue;
        texels++;
        let keep = 1;
        if (cap && satL && satN) {
            const W1 = width + 1;
            const x0 = Math.max(0, x - r), x1 = Math.min(width, x + r + 1), y0 = Math.max(0, y - r), y1 = Math.min(height, y + r + 1);
            const sL = satL[y1 * W1 + x1] - satL[y0 * W1 + x1] - satL[y1 * W1 + x0] + satL[y0 * W1 + x0];
            const sN = satN[y1 * W1 + x1] - satN[y0 * W1 + x1] - satN[y1 * W1 + x0] + satN[y0 * W1 + x0];
            const mean = sN > 0 ? sL / sN : L[i];
            const darkness = mean > 1e-6 ? clamp01((mean - L[i]) / mean) : 0;
            keep = clamp01(1 - cap.contrastGain * darkness);
        }
        if (clamp01(1 - L[i] * k.shadowSlope) > 0) { touched++; keptSum += keep; if (keep < 0.5) halved++; }
        const out = delightLinearRgb(rgb[i * 3], rgb[i * 3 + 1], rgb[i * 3 + 2], { shadowLift: params.shadowLift * keep, highlightCompress: params.highlightCompress });
        rgb[i * 3] = out[0]; rgb[i * 3 + 1] = out[1]; rgb[i * 3 + 2] = out[2];
    }
    return { texels, meanLiftKept: touched ? keptSum / touched : 1, liftHalvedTexels: halved };
}
