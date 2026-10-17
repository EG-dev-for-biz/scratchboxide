/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The photogrammetric shadow-lift / highlight-compress step of LocationObjectLightingService's de-light shader
 * (LOCATION_DELIGHT_FRAGMENT_CHUNK, heuristic branch), as one pure function so node-side texture baking and the browser
 * shader use the same numbers and cannot drift. The GLSL keeps its own copy of the formula (a shader cannot call
 * TypeScript); its default uniforms read the constants below.
 */

/** Default shadow lift of applyPhotogrammetricDelightShader (uShadowLift). */
export const PHOTOGRAMMETRIC_DELIGHT_SHADOW_LIFT = 0.60;
/** Default highlight compression of applyPhotogrammetricDelightShader (uHighlightCompress). */
export const PHOTOGRAMMETRIC_DELIGHT_HIGHLIGHT_COMPRESS = 0.45;

const smoothstep = (e0: number, e1: number, x: number): number => {
    const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
    return t * t * (3 - 2 * t);
};

/**
 * Lifts baked shadow crevices toward the stone luminance baseline and compresses burnt highlights; rgb in 0..1 (the
 * shader's working space). Mirrors the GLSL exactly:
 *   luma = dot(rgb, (0.299, 0.587, 0.114)); shadow = clamp(1 - 2.2 luma); lifted = rgb + (luma*1.6 + 0.14 - rgb) * shadow * lift;
 *   out = mix(lifted, lifted * 0.76, smoothstep(0.60, 0.98, luma) * compress).
 */
export function liftShadowsCompressHighlights(
    rgb: readonly [number, number, number],
    shadowLift = PHOTOGRAMMETRIC_DELIGHT_SHADOW_LIFT,
    highlightCompress = PHOTOGRAMMETRIC_DELIGHT_HIGHLIGHT_COMPRESS
): [number, number, number] {
    const luma = 0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2];
    const shadowFactor = Math.min(1, Math.max(0, 1 - luma * 2.2));
    const target = luma * 1.6 + 0.14;
    const k = shadowFactor * shadowLift;
    const h = smoothstep(0.60, 0.98, luma) * highlightCompress;
    const out: [number, number, number] = [0, 0, 0];
    for (let c = 0; c < 3; c++) {
        const lifted = rgb[c] + (target - rgb[c]) * k;
        out[c] = lifted + (lifted * 0.76 - lifted) * h;
    }
    return out;
}
