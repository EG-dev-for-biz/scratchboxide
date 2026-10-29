/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Light the lens itself spreads, from the finished linear frame (premultiplied by coverage, as the optics chain draws it):
 *  - lens flare: the light above a threshold, reflected back through the frame's centre as ghosts, a halo ring round the
 *    centre and an optional horizontal streak. Built from the frame's own bright light, so anything bright flares
 *    (the sun, a lamp, a glint), with no knowledge of what it is;
 *  - diffusion (a Black Pro-Mist): a share of all light scattered into a soft, wide glow.
 * Both are drawn at half and quarter resolution, every step continuous in the frame: the half-resolution copy is
 * Gaussian-blurred before any mip level of it is read (a box mip chain read bilinearly is not steady under sub-pixel
 * motion: a small bright light gained and lost energy as it crossed the texel grid, and the flare jittered), the threshold
 * is a soft knee, and the wide blurs' taps read the mip level matching their spacing. A bright point moving by a fraction of
 * a pixel moves its flare smoothly and never pops: nothing here can flicker unless the frame does. The output pass adds
 * them before tone mapping: c * (1 - strength) + strength * glow + flare.
 */

import * as THREE from 'three';

const QUAD_VERTEX = /* glsl */ `
varying vec2 vUv;
void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
}`;

/** A 4 x 4 box down to half resolution; a non-finite texel is held (as the depth of field prefilter does). */
const DOWNSAMPLE_FRAGMENT = /* glsl */ `
uniform sampler2D tSrc;
uniform vec2 uSrcTexel;
varying vec2 vUv;
vec4 sbFiniteColor(vec4 c) {
            for (int k = 0; k < 4; k++) if (!(c[k] == c[k])) c[k] = 0.0;
            c = clamp(c, vec4(-6.0e4), vec4(6.0e4));
            // soft ceiling: above 2e4 (far brighter than any sun the scene draws) luminance rolls off toward 4e4, smoothly
            float l = dot(c.rgb, vec3(0.2126, 0.7152, 0.0722));
            if (l > 2.0e4) { float e = l - 2.0e4; c.rgb *= (2.0e4 + e / (1.0 + e / 2.0e4)) / l; }
            return c;
        }
void main() {
    vec4 acc = vec4(0.0);
    acc += sbFiniteColor(texture2D(tSrc, vUv + vec2(-1.0, -1.0) * uSrcTexel));
    acc += sbFiniteColor(texture2D(tSrc, vUv + vec2(1.0, -1.0) * uSrcTexel));
    acc += sbFiniteColor(texture2D(tSrc, vUv + vec2(-1.0, 1.0) * uSrcTexel));
    acc += sbFiniteColor(texture2D(tSrc, vUv + vec2(1.0, 1.0) * uSrcTexel));
    gl_FragColor = acc * 0.25;
}`;

/** The light above the threshold, by a soft knee: each colour keeps its hue, scaled by its luminance's excess. */
const BRIGHT_FRAGMENT = /* glsl */ `
uniform sampler2D tSrc;
uniform float uThreshold;
varying vec2 vUv;
void main() {
    vec3 c = textureLod(tSrc, vUv, 0.0).rgb;
    float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
    float knee = 0.5 * uThreshold;
    // quadratic knee from threshold - knee to threshold + knee, then linear: continuous with its first derivative
    float x = clamp(l - uThreshold + knee, 0.0, 2.0 * knee);
    float excess = max(l - uThreshold, x * x / max(4.0 * knee, 1e-4));
    gl_FragColor = vec4(c * excess / max(l, 1e-4), 1.0);
}`;

/**
 * One axis of a Gaussian: 15 taps sigma / 2.5 apart, each reading the source's mip level for that spacing (an area
 * average, so a wide blur from few taps is still smooth).
 */
const BLUR_FRAGMENT = /* glsl */ `
uniform sampler2D tSrc;
uniform vec2 uDir;        // one tap's step, in uv
uniform float uLod;       // mip level matching the step
varying vec2 vUv;
void main() {
    vec4 acc = vec4(0.0);
    float wsum = 0.0;
    for (int i = -7; i <= 7; i++) {
        float t = float(i) / 2.5;
        float w = exp(-0.5 * t * t);
        acc += textureLod(tSrc, vUv + uDir * float(i), uLod) * w;
        wsum += w;
    }
    gl_FragColor = acc / wsum;
}`;

/** Ghosts and the halo from the bright light, mirrored through the centre (after Chapman's screen-space flare). */
const GHOST_FRAGMENT = /* glsl */ `
uniform sampler2D tBright;
uniform int uGhosts;
uniform float uDispersal;
uniform float uHalo;
uniform float uHaloRadius;
uniform float uAspect;
uniform float uChroma;
varying vec2 vUv;
vec3 sampleChroma(vec2 uv, vec2 dir) {
    return vec3(
        textureLod(tBright, uv + dir * uChroma, 1.0).r,
        textureLod(tBright, uv, 1.0).g,
        textureLod(tBright, uv - dir * uChroma, 1.0).b);
}
void main() {
    vec2 uv = vec2(1.0) - vUv;                 // mirrored through the centre
    vec2 ghostVec = (vec2(0.5) - uv) * uDispersal;
    vec2 dir = normalize(ghostVec + vec2(1e-6));
    vec3 acc = vec3(0.0);
    for (int i = 0; i < 8; i++) {
        if (i >= uGhosts) break;
        vec2 suv = uv + ghostVec * float(i);
        // stronger near the centre, gone at the corners; nothing sampled past the frame
        float d = length((vec2(0.5) - suv) * vec2(uAspect, 1.0)) / length(vec2(0.5 * uAspect, 0.5));
        float w = pow(max(1.0 - d, 0.0), 6.0);
        if (any(lessThan(suv, vec2(0.0))) || any(greaterThan(suv, vec2(1.0)))) w = 0.0;
        acc += sampleChroma(suv, dir) * w * 0.35;
    }
    if (uHalo > 0.0) {
        // a ring of radius uHaloRadius (frame heights) round the centre, round on screen whatever the aspect
        vec2 hv = normalize((vec2(0.5) - uv) * vec2(uAspect, 1.0) + vec2(1e-6)) * uHaloRadius / vec2(uAspect, 1.0);
        vec2 suv = uv + hv;
        float d = length((vec2(0.5) - suv) * vec2(uAspect, 1.0)) / length(vec2(0.5 * uAspect, 0.5));
        float w = pow(max(1.0 - d, 0.0), 5.0);
        if (any(lessThan(suv, vec2(0.0))) || any(greaterThan(suv, vec2(1.0)))) w = 0.0;
        acc += sampleChroma(suv, dir) * w * uHalo;
    }
    gl_FragColor = vec4(acc, 1.0);
}`;

export interface LensGlowSettings {
    flare: { amount: number; ghosts: number; halo: number; streak: number; threshold: number } | null;
    diffusion: { strength: number; spread: number } | null;
}

/** The textures the output pass adds (null when that part is off), and the gains it adds them with. */
export interface LensGlowResult {
    /** The diffusion glow (premultiplied linear, the frame blurred by the filter's spread). */
    diffusion: THREE.Texture | null;
    diffusionStrength: number;
    /** Ghosts and halo, and the streak, already scaled by the flare's settings except `amount`. */
    ghosts: THREE.Texture | null;
    streak: THREE.Texture | null;
    flareAmount: number;
    streakGain: number;
}

export class LensGlowPass {
    private readonly quadScene = new THREE.Scene();
    private readonly quadCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    private readonly quad: THREE.Mesh;
    private readonly downsample: THREE.ShaderMaterial;
    private readonly bright: THREE.ShaderMaterial;
    private readonly blur: THREE.ShaderMaterial;
    private readonly ghost: THREE.ShaderMaterial;
    private half: THREE.WebGLRenderTarget | null = null;
    private halfTmp: THREE.WebGLRenderTarget | null = null;
    private halfBlur: THREE.WebGLRenderTarget | null = null;
    private brightHalf: THREE.WebGLRenderTarget | null = null;
    private brightQ: THREE.WebGLRenderTarget | null = null;
    private ghostQ: THREE.WebGLRenderTarget | null = null;
    private streakQ: THREE.WebGLRenderTarget | null = null;
    private mistA: THREE.WebGLRenderTarget | null = null;
    private mistB: THREE.WebGLRenderTarget | null = null;

    constructor() {
        const make = (fragmentShader: string, uniforms: Record<string, { value: unknown }>) =>
            new THREE.ShaderMaterial({ vertexShader: QUAD_VERTEX, fragmentShader, uniforms, depthTest: false, depthWrite: false });
        this.downsample = make(DOWNSAMPLE_FRAGMENT, { tSrc: { value: null }, uSrcTexel: { value: new THREE.Vector2() } });
        this.bright = make(BRIGHT_FRAGMENT, { tSrc: { value: null }, uThreshold: { value: 1.5 } });
        this.blur = make(BLUR_FRAGMENT, { tSrc: { value: null }, uDir: { value: new THREE.Vector2() }, uLod: { value: 0 } });
        this.ghost = make(GHOST_FRAGMENT, {
            tBright: { value: null }, uGhosts: { value: 4 }, uDispersal: { value: 0.35 }, uHalo: { value: 0.3 }, uHaloRadius: { value: 0.32 },
            uAspect: { value: 1 }, uChroma: { value: 0.006 }
        });
        this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.downsample);
        this.quad.frustumCulled = false;
        this.quadScene.add(this.quad);
    }

    private target(t: THREE.WebGLRenderTarget | null, w: number, h: number, mips: boolean): THREE.WebGLRenderTarget {
        if (t && t.width === w && t.height === h) return t;
        t?.dispose();
        return new THREE.WebGLRenderTarget(w, h, {
            type: THREE.HalfFloatType, format: THREE.RGBAFormat, depthBuffer: false, magFilter: THREE.LinearFilter,
            minFilter: mips ? THREE.LinearMipmapLinearFilter : THREE.LinearFilter, generateMipmaps: mips
        });
    }

    private draw(renderer: THREE.WebGLRenderer, material: THREE.ShaderMaterial, target: THREE.WebGLRenderTarget): void {
        this.quad.material = material;
        renderer.setRenderTarget(target);
        renderer.render(this.quadScene, this.quadCamera);
    }

    /**
     * A Gaussian of `sigmaPx` (pixels of `dst`) along one axis, from `src` (read at the mip level for the tap spacing; a
     * step under a destination pixel reads the base level, so a small blur is exact).
     */
    private gaussian(renderer: THREE.WebGLRenderer, src: THREE.WebGLRenderTarget, dst: THREE.WebGLRenderTarget, sigmaPx: number, horizontal: boolean): void {
        const step = Math.max(sigmaPx / 2.5, 1e-3);
        // the source is `scale` times the destination's size; a step of `step` destination pixels spans step * scale texels
        const scale = (horizontal ? src.width / dst.width : src.height / dst.height);
        const u = this.blur.uniforms;
        u.tSrc.value = src.texture;
        (u.uDir.value as THREE.Vector2).set(horizontal ? step / dst.width : 0, horizontal ? 0 : step / dst.height);
        u.uLod.value = Math.max(0, Math.log2(step * scale));
        this.draw(renderer, this.blur, dst);
    }

    /** Draws the glow and flare images from the frame `color` (width x height); the caller adds them in its output. */
    render(renderer: THREE.WebGLRenderer, color: THREE.Texture, width: number, height: number, s: LensGlowSettings): LensGlowResult {
        const result: LensGlowResult = { diffusion: null, diffusionStrength: 0, ghosts: null, streak: null, flareAmount: 0, streakGain: 0 };
        if (!s.flare && !s.diffusion) return result;
        const previous = renderer.getRenderTarget();
        const hw = Math.max(1, Math.ceil(width / 2)), hh = Math.max(1, Math.ceil(height / 2));
        const qw = Math.max(1, Math.ceil(width / 4)), qh = Math.max(1, Math.ceil(height / 4));
        this.half = this.target(this.half, hw, hh, true);
        this.downsample.uniforms.tSrc.value = color;
        (this.downsample.uniforms.uSrcTexel.value as THREE.Vector2).set(1 / width, 1 / height);
        this.draw(renderer, this.downsample, this.half);
        // a small Gaussian (sigma 1.5 half-resolution pixels) before any mip level is read: what the mips then average is
        // already smooth, so a light moving by a fraction of a pixel neither gains nor loses energy in them
        this.halfTmp = this.target(this.halfTmp, hw, hh, false);
        this.halfBlur = this.target(this.halfBlur, hw, hh, true);
        this.gaussian(renderer, this.half, this.halfTmp, 1.5, true);
        this.gaussian(renderer, this.halfTmp, this.halfBlur, 1.5, false);

        if (s.diffusion && s.diffusion.strength > 0) {
            this.mistA = this.target(this.mistA, qw, qh, true);
            this.mistB = this.target(this.mistB, qw, qh, false);
            // spread is the Gaussian's sigma as a fraction of the frame height, in quarter-resolution pixels
            const sigma = Math.max(1, s.diffusion.spread * qh);
            this.gaussian(renderer, this.halfBlur, this.mistA, sigma, true);
            this.gaussian(renderer, this.mistA, this.mistB, sigma, false);
            result.diffusion = this.mistB.texture;
            result.diffusionStrength = s.diffusion.strength;
        }

        if (s.flare && s.flare.amount > 0) {
            // the light above the threshold at half resolution, blurred again (sigma 2 half pixels) down to quarter
            // resolution with mips: the ghosts and the streak read it smooth
            this.brightHalf = this.target(this.brightHalf, hw, hh, false);
            this.bright.uniforms.tSrc.value = this.halfBlur.texture;
            this.bright.uniforms.uThreshold.value = s.flare.threshold;
            this.draw(renderer, this.bright, this.brightHalf);
            this.brightQ = this.target(this.brightQ, qw, qh, true);
            this.gaussian(renderer, this.brightHalf, this.halfTmp, 2, true);
            this.gaussian(renderer, this.halfTmp, this.brightQ, 1, false);
            this.ghostQ = this.target(this.ghostQ, qw, qh, false);
            const g = this.ghost.uniforms;
            g.tBright.value = this.brightQ.texture;
            g.uGhosts.value = Math.round(s.flare.ghosts);
            g.uHalo.value = s.flare.halo;
            g.uAspect.value = width / height;
            this.draw(renderer, this.ghost, this.ghostQ);
            result.ghosts = this.ghostQ.texture;
            if (s.flare.streak > 0) {
                // a long horizontal Gaussian (sigma a tenth of the frame width), the anamorphic streak
                this.streakQ = this.target(this.streakQ, qw, qh, false);
                this.gaussian(renderer, this.brightQ, this.streakQ, Math.max(1, 0.1 * qw), true);
                result.streak = this.streakQ.texture;
                result.streakGain = s.flare.streak;
            }
            result.flareAmount = s.flare.amount;
        }
        renderer.setRenderTarget(previous);
        return result;
    }

    dispose(): void {
        for (const t of [this.half, this.halfTmp, this.halfBlur, this.brightHalf, this.brightQ, this.ghostQ, this.streakQ, this.mistA, this.mistB]) t?.dispose();
        this.half = this.halfTmp = this.halfBlur = this.brightHalf = this.brightQ = this.ghostQ = this.streakQ = this.mistA = this.mistB = null;
        for (const m of [this.downsample, this.bright, this.blur, this.ghost]) m.dispose();
        this.quad.geometry.dispose();
    }
}
