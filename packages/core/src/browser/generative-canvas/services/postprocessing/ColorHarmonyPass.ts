/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The colour harmony grade (color-harmony.ts, whose maths this shader repeats) as a full-screen pass in the viewport's
 * optics chain, on the scene draw before depth of field and the overlays. Colour is the chain's linear,
 * coverage-premultiplied RGBA: each pixel is un-premultiplied, harmonised in OKLCH and premultiplied again. Only the
 * scene's objects are graded, never the sky, which is its own component: objects are what wrote depth (a sky texture,
 * cube map or dome writes none), and content that writes no depth either (Gaussian splats) by its drawn coverage.
 */

import * as THREE from 'three';
import { MAX_HARMONY_SECTORS, OPPOSITE_HUE_EASE_DEG, TINT_CHROMA, type ColorHarmonyPlan } from './color-harmony';

const QUAD_VERTEX = /* glsl */ `
varying vec2 vUv;
void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
}`;

const HARMONY_FRAGMENT = /* glsl */ `
#define MAX_SECTORS ${MAX_HARMONY_SECTORS}
#define OPPOSITE_EASE ${((OPPOSITE_HUE_EASE_DEG * Math.PI) / 180).toFixed(8)}
#define TINT_CHROMA ${TINT_CHROMA.toFixed(6)}
uniform sampler2D tColor;
uniform sampler2D tDepth;
uniform sampler2D tCoverage;         // alpha: coverage of content that writes no depth (splats)
uniform bool uUseCoverage;
uniform sampler2D tDisplay;          // alpha: coverage of content that writes display (sRGB) values, not linear light (splats)
uniform bool uUseDisplay;
uniform float uHue;                  // radians
uniform int uSectorCount;
uniform vec2 uSectors[MAX_SECTORS];  // (centre offset, width), radians
uniform float uStrength;
uniform float uChroma;
uniform float uTint;
varying vec2 vUv;

const float PI = 3.14159265358979;
const float TAU = 6.28318530717959;

float wrapPi(float a) { return a - TAU * floor((a + PI) / TAU); }
vec3 cbrt3(vec3 v) { return sign(v) * pow(abs(v), vec3(1.0 / 3.0)); }

vec3 linearSrgbToOklab(vec3 c) {
    vec3 lms = cbrt3(vec3(
        dot(c, vec3(0.4122214708, 0.5363325363, 0.0514459929)),
        dot(c, vec3(0.2119034982, 0.6806995451, 0.1073969566)),
        dot(c, vec3(0.0883024619, 0.2817188376, 0.6299787005))));
    return vec3(
        dot(lms, vec3(0.2104542553, 0.7936177850, -0.0040720468)),
        dot(lms, vec3(1.9779984951, -2.4285922050, 0.4505937099)),
        dot(lms, vec3(0.0259040371, 0.7827717662, -0.8086757660)));
}
vec3 oklabToLinearSrgb(vec3 lab) {
    vec3 lms = vec3(
        dot(lab, vec3(1.0, 0.3963377774, 0.2158037573)),
        dot(lab, vec3(1.0, -0.1055613458, -0.0638541728)),
        dot(lab, vec3(1.0, -0.0894841775, -1.2914855480)));
    lms = lms * lms * lms;
    return vec3(
        dot(lms, vec3(4.0767416621, -3.3077115913, 0.2309699292)),
        dot(lms, vec3(-1.2684380046, 2.6097574011, -0.3413193965)),
        dot(lms, vec3(-0.0041960863, -0.7034186147, 1.7076147010)));
}

// the hue moved toward the centre of its nearest sector (Cohen-Or 2006): every hue lands inside a sector
float harmonizedHue(float h) {
    float centre = 0.0, halfW = 0.0, best = 1e9, bestD = 1e9;
    for (int i = 0; i < MAX_SECTORS; i++) {
        if (i >= uSectorCount) break;
        float c = uHue + uSectors[i].x;
        float d = abs(wrapPi(h - c));
        float outside = max(d - 0.5 * uSectors[i].y, 0.0);
        if (outside < best || (outside == best && d < bestD)) {
            best = outside; bestD = d; centre = c; halfW = 0.5 * uSectors[i].y;
        }
    }
    float diff = wrapPi(h - centre);
    float g = exp(-(diff * diff) / (2.0 * halfW * halfW));
    // near the sector's opposite hue, ease to its centre: no step where the two sides would go to opposite edges
    float ease = smoothstep(0.0, 1.0, (PI - abs(diff)) / OPPOSITE_EASE);
    return centre + sign(diff) * halfW * (1.0 - g) * ease;
}

vec3 grade(vec3 linear) {
    vec3 lab = linearSrgbToOklab(max(linear, vec3(0.0)));
    float chroma = length(lab.yz);
    float h = atan(lab.z, lab.y);
    float hNew = h + uStrength * wrapPi(harmonizedHue(h) - h);
    float cNew = chroma * uChroma;
    // the tint: chroma added at the template hue, so a neutral (which has no hue to move) takes the colour too
    vec2 ab = cNew * vec2(cos(hNew), sin(hNew)) + uTint * TINT_CHROMA * clamp(lab.x, 0.0, 1.0) * vec2(cos(uHue), sin(uHue));
    return max(oklabToLinearSrgb(vec3(lab.x, ab)), vec3(0.0));
}
vec3 srgbToLinear(vec3 c) { return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(vec3(0.04045), c)); }
vec3 linearToSrgb(vec3 c) { return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(vec3(0.0031308), c)); }

void main() {
    vec4 c = texture2D(tColor, vUv);
    // the share of the pixel that is the scene's content, never the sky: geometry that wrote depth, else the coverage of
    // content that writes none (a splat over the sky grades by its own alpha)
    float w = texture2D(tDepth, vUv).x < 1.0 ? 1.0 : 0.0;
    if (uUseCoverage) w = max(w, clamp(texture2D(tCoverage, vUv).a, 0.0, 1.0));
    if (c.a <= 1e-4 || w <= 0.0) { gl_FragColor = c; return; }
    vec3 src = max(c.rgb / c.a, vec3(0.0));
    vec3 rgb = grade(src);
    // display-valued content (the output leaves it as drawn) is graded in linear light and written back as display values
    if (uUseDisplay) rgb = mix(rgb, linearToSrgb(grade(srgbToLinear(min(src, vec3(1.0))))), clamp(texture2D(tDisplay, vUv).a, 0.0, 1.0));
    gl_FragColor = mix(c, vec4(rgb * c.a, c.a), w);
}`;

export class ColorHarmonyPass {
    private readonly material: THREE.ShaderMaterial;
    private readonly quad: THREE.Mesh;
    private readonly scene = new THREE.Scene();
    private readonly ortho = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

    constructor() {
        this.material = new THREE.ShaderMaterial({
            uniforms: {
                tColor: { value: null }, tDepth: { value: null }, tCoverage: { value: null }, uUseCoverage: { value: false }, tDisplay: { value: null }, uUseDisplay: { value: false },
                uHue: { value: 0 }, uSectorCount: { value: 0 },
                uSectors: { value: Array.from({ length: MAX_HARMONY_SECTORS }, () => new THREE.Vector2()) },
                uStrength: { value: 1 }, uChroma: { value: 1 }, uTint: { value: 0 }
            },
            vertexShader: QUAD_VERTEX,
            fragmentShader: HARMONY_FRAGMENT,
            depthTest: false,
            depthWrite: false
        });
        this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.material);
        this.quad.frustumCulled = false;
        this.scene.add(this.quad);
    }

    /**
     * Grades the scene's objects in `color` into `target`: where `depth` has geometry, and where `coverage`
     * (depthless-coverage.ts: splats) covers; the sky and background are left as drawn. Where `display` covers (content
     * whose shader writes display values), the grade is done in linear light and written back as display values.
     */
    render(renderer: THREE.WebGLRenderer, color: THREE.Texture, depth: THREE.Texture, plan: ColorHarmonyPlan, target: THREE.WebGLRenderTarget, coverage: THREE.Texture | null = null, display: THREE.Texture | null = null): void {
        const u = this.material.uniforms;
        const rad = Math.PI / 180;
        u.tColor.value = color;
        u.tDepth.value = depth;
        u.tCoverage.value = coverage;
        u.uUseCoverage.value = !!coverage;
        u.tDisplay.value = display;
        u.uUseDisplay.value = !!display;
        u.uHue.value = plan.hueDeg * rad;
        u.uSectorCount.value = Math.min(plan.sectors.length, MAX_HARMONY_SECTORS);
        (u.uSectors.value as THREE.Vector2[]).forEach((v, i) => {
            const s = plan.sectors[i];
            v.set(s ? s.offsetDeg * rad : 0, s ? s.widthDeg * rad : 0);
        });
        u.uStrength.value = plan.strength;
        u.uChroma.value = plan.chroma;
        u.uTint.value = plan.tint;
        renderer.setRenderTarget(target);
        renderer.render(this.scene, this.ortho);
    }

    dispose(): void {
        this.material.dispose();
        this.quad.geometry.dispose();
    }
}
