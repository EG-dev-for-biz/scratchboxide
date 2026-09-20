/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * GLSL Shaders for the hardware-accelerated WebGL NLE Compositor.
 */

export const QUAD_VERT = /* glsl */ `
varying vec2 vUv;

void main() {
    vUv = uv;
    gl_Position = vec4(position, 1.0);
}
`;

export const COMPOSITOR_FRAG = /* glsl */ `
precision highp float;
precision highp sampler3D;

uniform sampler2D uTexture;
uniform sampler2D uBackground;
uniform bool uHasBackground;

// Dedicated Alpha Mask
uniform sampler2D uMaskTexture;
uniform bool uUseMask;
uniform bool uInvertMask;

// 2D Spatial Affine Transform
uniform vec2 uLayerPosition;  // normalized [-1.0, 1.0] offset
uniform vec2 uLayerScale;     // default vec2(1.0, 1.0)
uniform float uLayerRotation; // in radians
uniform vec2 uLayerAnchor;    // default vec2(0.5, 0.5)

// Chroma Keying & Despill
uniform bool uKeyingEnabled;
uniform vec3 uKeyColor;       // default vec3(0.0, 1.0, 0.0)
uniform float uKeyTolerance;  // 0.0 to 1.0
uniform float uKeySoftness;   // 0.0 to 1.0
uniform float uKeyDespill;    // 0.0 to 1.0
uniform bool uKeyInvert;

// Optical Light Wrap
uniform float uLightWrapIntensity; // 0.0 to 1.0
uniform float uLightWrapSpread;    // 0.0 to 1.0

// Color Grading
uniform float uExposure;   // -1.0 to 1.0
uniform float uContrast;   // 0.0 to 2.0 (1.0 default)
uniform float uSaturation; // 0.0 to 2.0 (1.0 default)
uniform vec3 uColorBalance; // Lift / Gamma / Gain tint
uniform vec3 uLift;
uniform vec3 uGamma;
uniform vec3 uGain;
uniform vec3 uOffset;

// 3D LUT
uniform sampler3D uLut3D;
uniform bool uUseLut3D;

// Blend & Opacity
uniform int uBlendMode;    // 0: Normal, 1: Multiply, 2: Screen, 3: Overlay, 4: Add, 5: Difference, 6: Lighten, 7: Darken
uniform float uOpacity;

// VFX
uniform float uVignette;
uniform float uChromatic;
uniform float uOldFilm;
uniform float uTime;

varying vec2 vUv;

// RGB <-> HSL conversions
vec3 rgb2hsl(vec3 c) {
    float cMin = min(min(c.r, c.g), c.b);
    float cMax = max(max(c.r, c.g), c.b);
    float delta = cMax - cMin;
    float l = (cMax + cMin) * 0.5;
    float s = 0.0;
    float h = 0.0;
    if (delta > 0.0001) {
        s = l < 0.5 ? delta / (cMax + cMin) : delta / (2.0 - cMax - cMin);
        if (c.r >= cMax) h = (c.g - c.b) / delta;
        else if (c.g >= cMax) h = 2.0 + (c.b - c.r) / delta;
        else h = 4.0 + (c.r - c.g) / delta;
        h /= 6.0;
        if (h < 0.0) h += 1.0;
    }
    return vec3(h, s, l);
}

// Convert RGB to YCbCr for illumination-invariant chroma distance
vec2 rgb2cbcr(vec3 c) {
    float cb = -0.168736 * c.r - 0.331264 * c.g + 0.5 * c.b;
    float cr =  0.5 * c.r - 0.418688 * c.g - 0.081312 * c.b;
    return vec2(cb, cr);
}

vec3 applyBlend(int mode, vec3 base, vec3 blend) {
    if (mode == 1) return base * blend; // Multiply
    if (mode == 2) return 1.0 - (1.0 - base) * (1.0 - blend); // Screen
    if (mode == 3) { // Overlay
        vec3 result;
        for (int i = 0; i < 3; i++) {
            result[i] = base[i] < 0.5 ? 2.0 * base[i] * blend[i] : 1.0 - 2.0 * (1.0 - base[i]) * (1.0 - blend[i]);
        }
        return result;
    }
    if (mode == 4) return min(base + blend, vec3(1.0)); // Add
    if (mode == 5) return abs(base - blend); // Difference
    if (mode == 6) return max(base, blend); // Lighten
    if (mode == 7) return min(base, blend); // Darken
    return blend; // Normal
}

float hash(vec2 p) {
    vec3 p3 = fract(vec3(p.xyx) * 0.1031);
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
}

// Map screen UV to layer local UV using affine 2D transform
vec2 getLayerUv(vec2 screenUv) {
    vec2 p = screenUv - uLayerAnchor - uLayerPosition;
    float c = cos(-uLayerRotation);
    float s = sin(-uLayerRotation);
    p = vec2(c * p.x - s * p.y, s * p.x + c * p.y);
    vec2 scaleSafe = max(abs(uLayerScale), vec2(0.0001));
    p = p / scaleSafe;
    return p + uLayerAnchor;
}

void main() {
    vec2 screenUv = vUv;
    vec2 layerUv = getLayerUv(screenUv);

    // Boundary check for transformed layer
    bool isInside = layerUv.x >= 0.0 && layerUv.x <= 1.0 && layerUv.y >= 0.0 && layerUv.y <= 1.0;

    vec4 col = vec4(0.0);
    if (isInside) {
        // Chromatic Aberration
        if (uChromatic > 0.001) {
            float dist = length(layerUv - 0.5);
            vec2 shift = normalize(layerUv - 0.5) * dist * (uChromatic * 0.015);
            col.r = texture2D(uTexture, layerUv + shift).r;
            col.g = texture2D(uTexture, layerUv).g;
            col.b = texture2D(uTexture, layerUv - shift).b;
            col.a = texture2D(uTexture, layerUv).a;
        } else {
            col = texture2D(uTexture, layerUv);
        }

        // Dedicated Alpha Mask
        if (uUseMask) {
            float maskVal = texture2D(uMaskTexture, layerUv).r;
            if (uInvertMask) maskVal = 1.0 - maskVal;
            col.a *= maskVal;
        }

        // Chroma Keying (YCbCr distance & despill)
        if (uKeyingEnabled) {
            vec2 keyCbCr = rgb2cbcr(uKeyColor);
            vec2 pixelCbCr = rgb2cbcr(col.rgb);
            float chromaDist = length(pixelCbCr - keyCbCr);
            float softness = max(uKeySoftness, 0.001);
            float keyAlpha = smoothstep(uKeyTolerance, uKeyTolerance + softness, chromaDist);
            if (uKeyInvert) keyAlpha = 1.0 - keyAlpha;
            col.a *= keyAlpha;

            // Despill suppression
            if (uKeyDespill > 0.001) {
                if (uKeyColor.g > uKeyColor.r && uKeyColor.g > uKeyColor.b) {
                    float maxRb = max(col.r, col.b);
                    if (col.g > maxRb) {
                        col.g = mix(col.g, maxRb, uKeyDespill);
                    }
                } else if (uKeyColor.b > uKeyColor.r && uKeyColor.b > uKeyColor.g) {
                    float maxRg = max(col.r, col.g);
                    if (col.b > maxRg) {
                        col.b = mix(col.b, maxRg, uKeyDespill);
                    }
                }
            }
        }
    }

    vec3 rgb = col.rgb;

    // Exposure
    rgb = rgb * pow(2.0, uExposure);

    // Lift, Gamma, Gain, Offset (CDL / ASC style)
    rgb = rgb * (uGain + vec3(1.0)) + uOffset;
    rgb = pow(max(rgb, vec3(0.0)), 1.0 / max(uGamma + vec3(1.0), vec3(0.01)));
    rgb = rgb + uLift * (1.0 - rgb);

    // Contrast
    rgb = (rgb - 0.5) * uContrast + 0.5;

    // Saturation
    float luma = dot(rgb, vec3(0.2126, 0.7152, 0.0722));
    rgb = mix(vec3(luma), rgb, uSaturation);

    // 3D LUT Grading
    if (uUseLut3D) {
        vec3 lutRgb = clamp(rgb, 0.0, 1.0);
        rgb = texture(uLut3D, lutRgb).rgb;
    }

    // Vignette
    if (uVignette > 0.001) {
        float d = distance(screenUv, vec2(0.5));
        float vig = smoothstep(0.8, 0.25, d * (1.0 + uVignette * 0.8));
        rgb *= vig;
    }

    // Old Film Grain & Jitter
    if (uOldFilm > 0.001) {
        float noise = hash(screenUv * 1000.0 + fract(uTime * 43.12));
        rgb += (noise - 0.5) * (uOldFilm * 0.15);
    }

    rgb = clamp(rgb, 0.0, 1.0);

    // Optical Light Wrap (bleed background radiance onto keyed foreground edges)
    if (uHasBackground && uLightWrapIntensity > 0.001 && isInside) {
        vec4 bgSample = texture2D(uBackground, screenUv);
        float edgeMatte = smoothstep(0.0, 1.0, col.a) * (1.0 - smoothstep(0.7, 1.0, col.a));
        float bgLuma = dot(bgSample.rgb, vec3(0.299, 0.587, 0.114));
        rgb += bgSample.rgb * (bgLuma * edgeMatte * uLightWrapIntensity * 0.5);
        rgb = clamp(rgb, 0.0, 1.0);
    }

    // Final Composite with Background
    float finalAlpha = col.a * uOpacity;
    if (uHasBackground) {
        vec4 bg = texture2D(uBackground, screenUv);
        vec3 blended = applyBlend(uBlendMode, bg.rgb, rgb);
        gl_FragColor = vec4(mix(bg.rgb, blended, finalAlpha), max(bg.a, finalAlpha));
    } else {
        gl_FragColor = vec4(rgb, finalAlpha);
    }
}
`;
