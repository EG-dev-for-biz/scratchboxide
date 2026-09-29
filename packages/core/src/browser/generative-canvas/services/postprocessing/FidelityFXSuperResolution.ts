/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import * as THREE from 'three';

/**
 * Standard AMD FidelityFX Super Resolution 1.0 Quality Presets.
 */
export enum FSRQualityPreset {
    UltraQuality = 'ultra_quality',
    Quality = 'quality',
    Balanced = 'balanced',
    Performance = 'performance',
    Custom = 'custom'
}

/**
 * Scale factors (input resolution multiplier relative to target output resolution)
 * per AMD FSR 1.0 specifications.
 */
export const FSR_PRESET_SCALES: Record<FSRQualityPreset, number> = {
    [FSRQualityPreset.UltraQuality]: 0.77, // ~1.3x upscaling
    [FSRQualityPreset.Quality]: 0.67,      // ~1.5x upscaling
    [FSRQualityPreset.Balanced]: 0.59,     // ~1.7x upscaling
    [FSRQualityPreset.Performance]: 0.50,  // ~2.0x upscaling
    [FSRQualityPreset.Custom]: 1.0
};

/**
 * Computes integer input render dimensions for a given output dimension and preset.
 * Enforces even dimensions for optimal GPU texture alignment.
 */
export function computeInputDimensionsForPreset(
    outputWidth: number,
    outputHeight: number,
    preset: FSRQualityPreset,
    customScale: number = 1.0
): { width: number; height: number; scale: number } {
    const scale = preset === FSRQualityPreset.Custom ? Math.max(0.25, Math.min(1.0, customScale)) : (FSR_PRESET_SCALES[preset] || 0.67);
    let width = Math.round(outputWidth * scale);
    let height = Math.round(outputHeight * scale);
    if (width % 2 !== 0) width += 1;
    if (height % 2 !== 0) height += 1;
    return { width, height, scale };
}

/**
 * Common vertex shader for full-screen post-processing quads.
 */
export const FSR_QUAD_VERT = /* glsl */ `
varying vec2 vUv;
void main() {
    vUv = uv;
    gl_Position = vec4(position, 1.0);
}
`;

/**
 * Pass 1: EASU (Edge-Adaptive Spatial Upsampling)
 *
 * Samples a 12-tap neighborhood to determine local edge orientation and curvature,
 * interpolating along the gradient rather than across it to preserve architectural facades,
 * road markings, and fine geometry contours without stair-stepping or blur.
 */
export const EASU_SHADER = {
    uniforms: {
        tInput: { value: null as THREE.Texture | null },
        uInputResolution: { value: new THREE.Vector2(1280, 720) },
        uOutputResolution: { value: new THREE.Vector2(1920, 1080) }
    },
    vertexShader: FSR_QUAD_VERT,
    fragmentShader: /* glsl */ `
precision highp float;

uniform sampler2D tInput;
uniform vec2 uInputResolution;
uniform vec2 uOutputResolution;

varying vec2 vUv;

// Perceptual luminance calculation (ITU-R BT.709)
float getLuma(vec3 c) {
    return dot(c, vec3(0.2126, 0.7152, 0.0722));
}

// Windowed Sinc / Lanczos2 weight function
float lanczos2Weight(float x) {
    if (x == 0.0) return 1.0;
    if (abs(x) >= 2.0) return 0.0;
    float pi_x = 3.14159265359 * x;
    return (sin(pi_x) / pi_x) * (sin(0.5 * pi_x) / (0.5 * pi_x));
}

void main() {
    vec2 outCoord = floor(vUv * uOutputResolution);
    vec2 pp = (outCoord + vec2(0.5)) * (uInputResolution / uOutputResolution) - vec2(0.5);
    vec2 fp = floor(pp);
    vec2 f = pp - fp;

    vec2 invInputRes = 1.0 / uInputResolution;

    // 12-tap sampling pattern around 2x2 core:
    //       [a] [d]
    //   [e] [b] [c] [h]
    //   [i] [f] [g] [l]
    //       [j] [k]
    vec3 c_b = texture2D(tInput, (fp + vec2(0.0, 0.0) + 0.5) * invInputRes).rgb;
    vec3 c_c = texture2D(tInput, (fp + vec2(1.0, 0.0) + 0.5) * invInputRes).rgb;
    vec3 c_f = texture2D(tInput, (fp + vec2(0.0, 1.0) + 0.5) * invInputRes).rgb;
    vec3 c_g = texture2D(tInput, (fp + vec2(1.0, 1.0) + 0.5) * invInputRes).rgb;

    vec3 c_a = texture2D(tInput, (fp + vec2(0.0, -1.0) + 0.5) * invInputRes).rgb;
    vec3 c_d = texture2D(tInput, (fp + vec2(1.0, -1.0) + 0.5) * invInputRes).rgb;
    vec3 c_e = texture2D(tInput, (fp + vec2(-1.0, 0.0) + 0.5) * invInputRes).rgb;
    vec3 c_h = texture2D(tInput, (fp + vec2(2.0, 0.0) + 0.5) * invInputRes).rgb;
    vec3 c_i = texture2D(tInput, (fp + vec2(-1.0, 1.0) + 0.5) * invInputRes).rgb;
    vec3 c_l = texture2D(tInput, (fp + vec2(2.0, 1.0) + 0.5) * invInputRes).rgb;
    vec3 c_j = texture2D(tInput, (fp + vec2(0.0, 2.0) + 0.5) * invInputRes).rgb;
    vec3 c_k = texture2D(tInput, (fp + vec2(1.0, 2.0) + 0.5) * invInputRes).rgb;

    float l_b = getLuma(c_b);
    float l_c = getLuma(c_c);
    float l_f = getLuma(c_f);
    float l_g = getLuma(c_g);

    float l_a = getLuma(c_a);
    float l_d = getLuma(c_d);
    float l_e = getLuma(c_e);
    float l_h = getLuma(c_h);
    float l_i = getLuma(c_i);
    float l_l = getLuma(c_l);
    float l_j = getLuma(c_j);
    float l_k = getLuma(c_k);

    // Compute edge gradient direction vector
    // Horizontal and vertical gradient components
    float dirX = (l_b - l_c) + (l_f - l_g);
    float dirY = (l_b - l_f) + (l_c - l_g);
    dirX += ((l_a - l_d) + (l_j - l_k)) * 0.5;
    dirY += ((l_e - l_i) + (l_h - l_l)) * 0.5;

    float len = length(vec2(dirX, dirY));
    vec2 dir = len > 0.0001 ? vec2(dirX, dirY) / len : vec2(1.0, 0.0);

    // Edge-aligned anisotropic scaling:
    // Stretch kernel along the edge, compress perpendicular to it
    float stretch = clamp(1.0 + len * 2.0, 1.0, 3.0);
    mat2 rot = mat2(dir.x, -dir.y, dir.y, dir.x);

    // Evaluate anisotropic kernel weights for the 4 primary center taps
    vec2 d_b = (rot * (f - vec2(0.0, 0.0))) * vec2(1.0 / stretch, stretch);
    vec2 d_c = (rot * (f - vec2(1.0, 0.0))) * vec2(1.0 / stretch, stretch);
    vec2 d_f = (rot * (f - vec2(0.0, 1.0))) * vec2(1.0 / stretch, stretch);
    vec2 d_g = (rot * (f - vec2(1.0, 1.0))) * vec2(1.0 / stretch, stretch);

    float w_b = lanczos2Weight(length(d_b));
    float w_c = lanczos2Weight(length(d_c));
    float w_f = lanczos2Weight(length(d_f));
    float w_g = lanczos2Weight(length(d_g));

    // Also include subtle guidance from outer taps along edge direction
    vec2 d_a = (rot * (f - vec2(0.0, -1.0))) * vec2(1.0 / stretch, stretch);
    vec2 d_d = (rot * (f - vec2(1.0, -1.0))) * vec2(1.0 / stretch, stretch);
    vec2 d_e = (rot * (f - vec2(-1.0, 0.0))) * vec2(1.0 / stretch, stretch);
    vec2 d_h = (rot * (f - vec2(2.0, 0.0))) * vec2(1.0 / stretch, stretch);
    vec2 d_i = (rot * (f - vec2(-1.0, 1.0))) * vec2(1.0 / stretch, stretch);
    vec2 d_l = (rot * (f - vec2(2.0, 1.0))) * vec2(1.0 / stretch, stretch);
    vec2 d_j = (rot * (f - vec2(0.0, 2.0))) * vec2(1.0 / stretch, stretch);
    vec2 d_k = (rot * (f - vec2(1.0, 2.0))) * vec2(1.0 / stretch, stretch);

    float w_a = lanczos2Weight(length(d_a)) * 0.25;
    float w_d = lanczos2Weight(length(d_d)) * 0.25;
    float w_e = lanczos2Weight(length(d_e)) * 0.25;
    float w_h = lanczos2Weight(length(d_h)) * 0.25;
    float w_i = lanczos2Weight(length(d_i)) * 0.25;
    float w_l = lanczos2Weight(length(d_l)) * 0.25;
    float w_j = lanczos2Weight(length(d_j)) * 0.25;
    float w_k = lanczos2Weight(length(d_k)) * 0.25;

    vec3 sumColor = c_b * w_b + c_c * w_c + c_f * w_f + c_g * w_g +
                    c_a * w_a + c_d * w_d + c_e * w_e + c_h * w_h +
                    c_i * w_i + c_l * w_l + c_j * w_j + c_k * w_k;

    float sumWeight = w_b + w_c + w_f + w_g +
                      w_a + w_d + w_e + w_h +
                      w_i + w_l + w_j + w_k;

    vec3 finalColor = sumColor / max(sumWeight, 0.0001);

    // Clamp against neighborhood extrema to guarantee stability
    vec3 minC = min(c_b, min(c_c, min(c_f, c_g)));
    vec3 maxC = max(c_b, max(c_c, max(c_f, c_g)));
    finalColor = clamp(finalColor, minC, maxC);

    gl_FragColor = vec4(finalColor, 1.0);
}
`
};

/**
 * Pass 2: RCAS (Robust Contrast-Adaptive Sharpening)
 *
 * Samples a 5-tap cross neighborhood, checking the local contrast bounds to apply
 * high-frequency sharpening while strictly clamping negative lobe weights to prevent
 * ringing artifacts and glowing edge halos.
 */
export const RCAS_SHADER = {
    uniforms: {
        tInput: { value: null as THREE.Texture | null },
        uResolution: { value: new THREE.Vector2(1920, 1080) },
        uSharpness: { value: 0.8 }
    },
    vertexShader: FSR_QUAD_VERT,
    fragmentShader: /* glsl */ `
precision highp float;

uniform sampler2D tInput;
uniform vec2 uResolution;
uniform float uSharpness;

varying vec2 vUv;

float getLuma(vec3 c) {
    return dot(c, vec3(0.2126, 0.7152, 0.0722));
}

void main() {
    vec2 texel = 1.0 / uResolution;

    // 5-tap cross pattern: M (center), N, S, W, E
    vec3 c_m = texture2D(tInput, vUv).rgb;
    vec3 c_n = texture2D(tInput, vUv + vec2(0.0, -texel.y)).rgb;
    vec3 c_s = texture2D(tInput, vUv + vec2(0.0, texel.y)).rgb;
    vec3 c_w = texture2D(tInput, vUv + vec2(-texel.x, 0.0)).rgb;
    vec3 c_e = texture2D(tInput, vUv + vec2(texel.x, 0.0)).rgb;

    float l_m = getLuma(c_m);
    float l_n = getLuma(c_n);
    float l_s = getLuma(c_s);
    float l_w = getLuma(c_w);
    float l_e = getLuma(c_e);

    // Compute local contrast min and max
    float minL = min(l_m, min(min(l_n, l_s), min(l_w, l_e)));
    float maxL = max(l_m, max(max(l_n, l_s), max(l_w, l_e)));

    // Anti-ringing sharpening lobe calculation:
    // Limit sharpening weight based on proximity to luminance boundaries
    float contrast = maxL - minL;
    float amp = clamp(min(minL, 1.0 - maxL) / max(contrast, 0.0001), 0.0, 1.0);
    
    // Negative lobe weight (maximum sharpness controlled by user parameter)
    float w = -amp * (clamp(uSharpness, 0.0, 1.0) * 0.20);

    // Apply adaptive sharpening filter
    vec3 sharpened = (c_m + w * (c_n + c_s + c_w + c_e)) / (1.0 + 4.0 * w);

    // Clamp against neighborhood color bounds to strictly prevent halos/ringing
    vec3 minC = min(c_m, min(min(c_n, c_s), min(c_w, c_e)));
    vec3 maxC = max(c_m, max(max(c_n, c_s), max(c_w, c_e)));
    sharpened = clamp(sharpened, minC, maxC);

    gl_FragColor = vec4(sharpened, 1.0);
}
`
};

export interface FidelityFXSuperResolutionOptions {
    outputWidth: number;
    outputHeight: number;
    preset?: FSRQualityPreset;
    customScale?: number;
    sharpness?: number; // 0.0 to 1.0
}

/**
 * High-performance 2-pass AMD FidelityFX Super Resolution (FSR 1.0) pipeline.
 * Pass 1: EASU (Edge-Adaptive Spatial Upsampling) -> intermediate render target.
 * Pass 2: RCAS (Robust Contrast-Adaptive Sharpening) -> final destination.
 */
export class FidelityFXSuperResolution {
    private outputWidth: number;
    private outputHeight: number;
    private inputWidth: number;
    private inputHeight: number;
    private preset: FSRQualityPreset;
    private customScale: number;
    private sharpness: number;

    // WebGL resources
    private easuRenderTarget: THREE.WebGLRenderTarget;
    private easuMaterial: THREE.ShaderMaterial;
    private rcasMaterial: THREE.ShaderMaterial;
    private quadGeometry: THREE.PlaneGeometry;
    private easuScene: THREE.Scene;
    private rcasScene: THREE.Scene;
    private quadCamera: THREE.OrthographicCamera;

    constructor(options: FidelityFXSuperResolutionOptions) {
        this.outputWidth = Math.max(2, options.outputWidth);
        this.outputHeight = Math.max(2, options.outputHeight);
        this.preset = options.preset || FSRQualityPreset.Quality;
        this.customScale = options.customScale || 1.0;
        this.sharpness = Math.max(0.0, Math.min(1.0, options.sharpness ?? 0.8));

        const dims = computeInputDimensionsForPreset(
            this.outputWidth,
            this.outputHeight,
            this.preset,
            this.customScale
        );
        this.inputWidth = dims.width;
        this.inputHeight = dims.height;

        // Orthographic camera for full-screen quad rendering
        this.quadCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
        this.quadGeometry = new THREE.PlaneGeometry(2, 2);

        // Intermediate render target for EASU output
        this.easuRenderTarget = new THREE.WebGLRenderTarget(this.outputWidth, this.outputHeight, {
            minFilter: THREE.LinearFilter,
            magFilter: THREE.LinearFilter,
            format: THREE.RGBAFormat,
            type: THREE.HalfFloatType || THREE.UnsignedByteType,
            depthBuffer: false,
            stencilBuffer: false
        });

        // EASU Material and Scene
        this.easuMaterial = new THREE.ShaderMaterial({
            uniforms: {
                tInput: { value: null },
                uInputResolution: { value: new THREE.Vector2(this.inputWidth, this.inputHeight) },
                uOutputResolution: { value: new THREE.Vector2(this.outputWidth, this.outputHeight) }
            },
            vertexShader: EASU_SHADER.vertexShader,
            fragmentShader: EASU_SHADER.fragmentShader,
            depthWrite: false,
            depthTest: false
        });

        this.easuScene = new THREE.Scene();
        this.easuScene.add(new THREE.Mesh(this.quadGeometry, this.easuMaterial));

        // RCAS Material and Scene
        this.rcasMaterial = new THREE.ShaderMaterial({
            uniforms: {
                tInput: { value: this.easuRenderTarget.texture },
                uResolution: { value: new THREE.Vector2(this.outputWidth, this.outputHeight) },
                uSharpness: { value: this.sharpness }
            },
            vertexShader: RCAS_SHADER.vertexShader,
            fragmentShader: RCAS_SHADER.fragmentShader,
            depthWrite: false,
            depthTest: false
        });

        this.rcasScene = new THREE.Scene();
        this.rcasScene.add(new THREE.Mesh(this.quadGeometry, this.rcasMaterial));
    }

    public getInputWidth(): number {
        return this.inputWidth;
    }

    public getInputHeight(): number {
        return this.inputHeight;
    }

    public getOutputWidth(): number {
        return this.outputWidth;
    }

    public getOutputHeight(): number {
        return this.outputHeight;
    }

    public getPreset(): FSRQualityPreset {
        return this.preset;
    }

    public getSharpness(): number {
        return this.sharpness;
    }

    public setSharpness(val: number): void {
        this.sharpness = Math.max(0.0, Math.min(1.0, val));
        this.rcasMaterial.uniforms.uSharpness.value = this.sharpness;
    }

    public getIntermediateRenderTarget(): THREE.WebGLRenderTarget {
        return this.easuRenderTarget;
    }

    /**
     * Resizes internal buffers when viewport or scale changes.
     */
    public resize(
        outputWidth: number,
        outputHeight: number,
        preset?: FSRQualityPreset,
        customScale?: number
    ): void {
        this.outputWidth = Math.max(2, outputWidth);
        this.outputHeight = Math.max(2, outputHeight);
        if (preset) this.preset = preset;
        if (customScale !== undefined) this.customScale = customScale;

        const dims = computeInputDimensionsForPreset(
            this.outputWidth,
            this.outputHeight,
            this.preset,
            this.customScale
        );
        this.inputWidth = dims.width;
        this.inputHeight = dims.height;

        this.easuRenderTarget.setSize(this.outputWidth, this.outputHeight);

        this.easuMaterial.uniforms.uInputResolution.value.set(this.inputWidth, this.inputHeight);
        this.easuMaterial.uniforms.uOutputResolution.value.set(this.outputWidth, this.outputHeight);
        this.rcasMaterial.uniforms.uResolution.value.set(this.outputWidth, this.outputHeight);
    }

    /**
     * Executes the 2-pass FSR 1.0 pipeline:
     * 1. EASU pass: Upsample inputTexture to intermediate render target.
     * 2. RCAS pass: Sharpen intermediate texture to destination render target or screen.
     */
    public render(
        renderer: THREE.WebGLRenderer,
        inputTexture: THREE.Texture,
        destinationTarget: THREE.WebGLRenderTarget | null = null
    ): void {
        const previousTarget = renderer.getRenderTarget();

        // Pass 1: EASU
        this.easuMaterial.uniforms.tInput.value = inputTexture;
        renderer.setRenderTarget(this.easuRenderTarget);
        renderer.render(this.easuScene, this.quadCamera);

        // Pass 2: RCAS
        this.rcasMaterial.uniforms.tInput.value = this.easuRenderTarget.texture;
        renderer.setRenderTarget(destinationTarget);
        renderer.render(this.rcasScene, this.quadCamera);

        // Restore previous target
        renderer.setRenderTarget(previousTarget);
    }

    public dispose(): void {
        this.easuRenderTarget.dispose();
        this.easuMaterial.dispose();
        this.rcasMaterial.dispose();
        this.quadGeometry.dispose();
    }
}

export function createFidelityFXSuperResolution(
    options: FidelityFXSuperResolutionOptions
): FidelityFXSuperResolution {
    return new FidelityFXSuperResolution(options);
}
