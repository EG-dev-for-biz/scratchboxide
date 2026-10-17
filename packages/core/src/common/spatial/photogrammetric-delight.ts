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
