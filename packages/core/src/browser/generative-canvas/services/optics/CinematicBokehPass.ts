/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import * as THREE from 'three';
import {
    PhysicalCameraConfig,
    PHYSICAL_SENSOR_PRESETS
} from '../../../../common/optics/physical-camera-protocol';
import { PhysicalCameraModel } from '../../../../common/optics/PhysicalCameraModel';

export interface BokehPassParams {
    focusDistanceMeters: number;
    focalLengthMm: number;
    apertureFStop: number;
    sensorHeightMm: number;
    maxBlurRadiusPx: number;
    anamorphicRatio: number;
    bokehScale: number;
    cameraNear: number;
    cameraFar: number;
    isLinearDepth: boolean;
    enabled: boolean;
}

export interface CinematicBokehPassOptions extends Partial<BokehPassParams> {
    width?: number;
    height?: number;
    camera?: THREE.PerspectiveCamera | THREE.Camera;
    maxBlurRadiusPixels?: number;
}

export type CinematicBokehPassConfig = CinematicBokehPassOptions;
export type CinematicBokehUniforms = Record<string, { value: any }>;

/**
 * Generates an analytical 24-tap Golden Angle Poisson disk kernel distribution on the unit disk.
 */
export function generatePoissonDiskKernel(numSamples: number = 24): Float32Array {
    const kernel = new Float32Array(numSamples * 2);
    const goldenAngle = 2.39996323; // Golden angle in radians
    for (let i = 0; i < numSamples; i++) {
        const fi = i + 1;
        const theta = fi * goldenAngle;
        const r = Math.sqrt(fi / numSamples);
        kernel[i * 2] = Math.cos(theta) * r;
        kernel[i * 2 + 1] = Math.sin(theta) * r;
    }
    return kernel;
}

/** Shared GLSL: uniforms, metric depth and the signed thin-lens circle of confusion (diameter, full-resolution pixels). */
const COC_GLSL = `
        uniform sampler2D tDepth;
        uniform vec2 uResolution;
        uniform float uCameraNear;
        uniform float uCameraFar;
        uniform float uFocusDistance;
        uniform float uFocalLengthMm;
        uniform float uApertureFStop;
        uniform float uSensorHeightMm;
        uniform float uMaxBlurRadiusPx;
        uniform float uAnamorphicRatio;
        uniform float uBokehScale;
        uniform bool uIsLinearDepth;
        uniform bool uEnabled;

        // Reads depth in meters
        float getMetricDepth(vec2 uv) {
            float rawDepth = texture2D(tDepth, uv).r;
            if (uIsLinearDepth) {
                return max(rawDepth, 0.001);
            }
            // Linearize perspective hardware depth buffer
            float z_ndc = 2.0 * rawDepth - 1.0;
            float metricZ = (2.0 * uCameraNear * uCameraFar) / (uCameraFar + uCameraNear - z_ndc * (uCameraFar - uCameraNear));
            return max(metricZ, 0.001);
        }

        // Computes signed Circle of Confusion (CoC) in pixels (positive behind the plane of focus)
        float computeCoCPixels(float depthMeters) {
            float d = max(depthMeters, 0.01);
            float df = max(uFocusDistance, 0.01);
            float f = max(uFocalLengthMm, 1.0) * 0.001; // mm to meters
            float N = max(uApertureFStop, 0.5);

            if (abs(df - f) < 0.0001) return 0.0;

            // Aperture entrance pupil diameter: A = f / N
            float aperture = f / N;

            // Signed blur diameter at sensor plane in meters
            float cocSensorM = aperture * (f / (df - f)) * ((d - df) / d);

            // Convert sensor meters to pixels
            float sensorHeightM = max(uSensorHeightMm, 1.0) * 0.001;
            float cocPx = (cocSensorM / sensorHeightM) * uResolution.y * uBokehScale;

            return clamp(cocPx, -uMaxBlurRadiusPx, uMaxBlurRadiusPx);
        }
`;

const QUAD_VERTEX = `
        varying vec2 vUv;
        void main() {
            vUv = uv;
            gl_Position = vec4(position, 1.0);
        }
    `;

/**
 * Pass 1, at half resolution: the colour (4 bilinear taps = a 4 x 4 box) with each tap weighted 1 / (1 + luma) (Karis),
 * so a sub-pixel highlight (a sun glint) is averaged in at the weight of its area instead of popping the whole texel;
 * and, into a second target, the signed blur radius in half-resolution pixels (r; computeCoCPixels gives the radius in
 * full-resolution pixels when uBokehScale is 0.5, as the viewport sets it) and the largest of the taps' (g). Both are
 * mip-mapped, so the gather can read any footprint as one stable area average.
 */
export const CINEMATIC_BOKEH_PREFILTER_SHADER = {
    vertexShader: QUAD_VERTEX,
    fragmentShader: `
        uniform sampler2D tColor;
        uniform bool uWriteCoc;
        ${COC_GLSL}
        varying vec2 vUv;
        void main() {
            vec2 px = 1.0 / uResolution;
            vec2 o[4];
            o[0] = vec2(-1.0, -1.0); o[1] = vec2(1.0, -1.0); o[2] = vec2(-1.0, 1.0); o[3] = vec2(1.0, 1.0);
            if (uWriteCoc) {
                float sum = 0.0, far = 0.0;
                for (int i = 0; i < 4; i++) {
                    float c = computeCoCPixels(getMetricDepth(vUv + o[i] * 0.5 * px)) * 0.5;
                    sum += c; far = max(far, abs(c));
                }
                gl_FragColor = vec4(sum * 0.25, far, 0.0, 1.0);
                return;
            }
            vec4 acc = vec4(0.0); float wsum = 0.0;
            for (int i = 0; i < 4; i++) {
                vec4 c = texture2D(tColor, vUv + o[i] * px);
                // the colour is premultiplied by coverage: weigh by the luma of what is drawn there
                vec3 rgb = c.a > 1e-4 ? c.rgb / c.a : vec3(0.0);
                float w = 1.0 / (1.0 + max(rgb.r, max(rgb.g, rgb.b)));
                acc += c * w; wsum += w;
            }
            gl_FragColor = acc / max(wsum, 1e-6);
        }
    `
};

/**
 * Pass 2, at half resolution: the gather. A golden-angle spiral of taps over the blur circle, as many as its area needs
 * (8 to 64), each reading the prefiltered colour and blur radius at the mip level whose texel matches the spacing between
 * taps, so nothing the taps skip over can flicker in and out as the view moves. A tap counts where its own blur reaches
 * the centre (scatter as gather), so a sharp foreground never smears over the background behind it.
 */
export const CINEMATIC_BOKEH_SHADER = {
    vertexShader: QUAD_VERTEX,
    fragmentShader: `
        uniform sampler2D tColorHalf;
        uniform sampler2D tCocHalf;
        uniform vec2 uHalfResolution;
        ${COC_GLSL}
        varying vec2 vUv;

        // Golden Angle constant in radians (approx 137.507764 degrees)
        const float GOLDEN_ANGLE = 2.39996323;
        const int MAX_SAMPLES = 64;

        void main() {
            vec4 centerColor = texture2D(tColorHalf, vUv);
            vec2 centerCoc = texture2D(tCocHalf, vUv).rg;
            // blur radius in half-resolution pixels (the prefilter stored it so)
            float R = abs(centerCoc.r);
            if (!uEnabled || R < 0.5) {
                gl_FragColor = centerColor;
                return;
            }
            float n = clamp(ceil(3.14159265 * R * R / 4.0), 8.0, float(MAX_SAMPLES));
            float spacing = R * sqrt(3.14159265 / n);
            float lod = log2(max(spacing, 1.0));
            vec2 invRes = 1.0 / uHalfResolution;
            vec2 aspectCorrection = vec2(1.0 / max(uAnamorphicRatio, 0.5), 1.0);
            vec4 acc = centerColor;
            float wsum = 1.0;
            for (int i = 0; i < MAX_SAMPLES; i++) {
                float fi = float(i);
                if (fi >= n) break;
                float r = R * sqrt((fi + 0.5) / n);
                float theta = fi * GOLDEN_ANGLE;
                vec2 uv = clamp(vUv + vec2(cos(theta), sin(theta)) * aspectCorrection * r * invRes, vec2(0.0), vec2(1.0));
                vec2 sc = textureLod(tCocHalf, uv, lod).rg;
                // the tap's own blur radius (half px) must reach the centre
                float sampleR = abs(sc.r);
                float w = clamp((sampleR - r) / spacing + 1.0, 0.0, 1.0);
                vec4 c = textureLod(tColorHalf, uv, lod);
                vec3 rgb = c.a > 1e-4 ? c.rgb / c.a : vec3(0.0);
                w /= 1.0 + max(rgb.r, max(rgb.g, rgb.b));
                acc += c * w; wsum += w;
            }
            // the centre tap was not Karis-weighted when it was added: weigh it like the rest
            vec3 crgb = centerColor.a > 1e-4 ? centerColor.rgb / centerColor.a : vec3(0.0);
            float cw = 1.0 / (1.0 + max(crgb.r, max(crgb.g, crgb.b)));
            acc += centerColor * (cw - 1.0); wsum += cw - 1.0;
            gl_FragColor = acc / max(wsum, 1e-6);
        }
    `
};

/**
 * Pass 3, at full resolution: the sharp frame where the blur is under a pixel, the gathered blur (bilinear from half
 * resolution) where it is larger, blended smoothly between (0.5 to 2 px radius), so a pixel near the plane of focus
 * never snaps between sharp and soft as the focus or the view moves.
 */
export const CINEMATIC_BOKEH_COMPOSITE_SHADER = {
    vertexShader: QUAD_VERTEX,
    fragmentShader: `
        uniform sampler2D tColor;
        uniform sampler2D tBlurHalf;
        uniform sampler2D tCocHalf;
        ${COC_GLSL}
        varying vec2 vUv;
        void main() {
            vec4 sharp = texture2D(tColor, vUv);
            if (!uEnabled) { gl_FragColor = sharp; return; }
            float radius = abs(computeCoCPixels(getMetricDepth(vUv)));
            // a blurred foreground spreads over sharp pixels beside it: the half-res neighbourhood's largest blur, in full px
            float spread = textureLod(tCocHalf, vUv, 1.0).g * 2.0;
            float t = smoothstep(0.5, 2.0, max(radius, spread));
            gl_FragColor = mix(sharp, texture2D(tBlurHalf, vUv), t);
        }
    `
};

/**
 * Professional real-time Cinematic Depth-of-Field and Bokeh post-processing pass.
 */
export class CinematicBokehPass {
    /** The gather; its uniforms are shared by the prefilter and composite materials (one set of lens values). */
    private material: THREE.ShaderMaterial;
    private prefilter: THREE.ShaderMaterial;
    private composite: THREE.ShaderMaterial;
    private colorHalf: THREE.WebGLRenderTarget | null = null;
    private cocHalf: THREE.WebGLRenderTarget | null = null;
    private blurHalf: THREE.WebGLRenderTarget | null = null;
    private quadCamera: THREE.OrthographicCamera;
    private quadScene: THREE.Scene;
    private quadMesh: THREE.Mesh;
    private params: BokehPassParams;

    constructor(initialParams: CinematicBokehPassOptions = {}) {
        const camNear = initialParams.camera instanceof THREE.PerspectiveCamera
            ? initialParams.camera.near
            : (initialParams.cameraNear ?? 0.1);
        const camFar = initialParams.camera instanceof THREE.PerspectiveCamera
            ? initialParams.camera.far
            : (initialParams.cameraFar ?? 1000.0);

        this.params = {
            focusDistanceMeters: initialParams.focusDistanceMeters ?? 5.0,
            focalLengthMm: initialParams.focalLengthMm ?? 50.0,
            apertureFStop: initialParams.apertureFStop ?? 2.8,
            sensorHeightMm: initialParams.sensorHeightMm ?? PHYSICAL_SENSOR_PRESETS.full_frame_35mm.heightMm,
            maxBlurRadiusPx: initialParams.maxBlurRadiusPx ?? initialParams.maxBlurRadiusPixels ?? 24.0,
            anamorphicRatio: initialParams.anamorphicRatio ?? 1.0,
            bokehScale: initialParams.bokehScale ?? 1.0,
            cameraNear: camNear,
            cameraFar: camFar,
            isLinearDepth: initialParams.isLinearDepth ?? false,
            enabled: initialParams.enabled ?? true
        };

        const resWidth = initialParams.width ?? 1920;
        const resHeight = initialParams.height ?? 1080;

        this.material = new THREE.ShaderMaterial({
            uniforms: {
                tColor: { value: null },
                tDepth: { value: null },
                uResolution: { value: new THREE.Vector2(resWidth, resHeight) },
                uCameraNear: { value: this.params.cameraNear },
                uCameraFar: { value: this.params.cameraFar },
                uFocusDistance: { value: this.params.focusDistanceMeters },
                uFocalLengthMm: { value: this.params.focalLengthMm },
                uApertureFStop: { value: this.params.apertureFStop },
                uSensorHeightMm: { value: this.params.sensorHeightMm },
                uMaxBlurRadiusPx: { value: this.params.maxBlurRadiusPx },
                uAnamorphicRatio: { value: this.params.anamorphicRatio },
                uBokehScale: { value: this.params.bokehScale },
                uIsLinearDepth: { value: this.params.isLinearDepth },
                uEnabled: { value: this.params.enabled }
            },
            vertexShader: CINEMATIC_BOKEH_SHADER.vertexShader,
            fragmentShader: CINEMATIC_BOKEH_SHADER.fragmentShader,
            depthTest: false,
            depthWrite: false
        });
        const shared = this.material.uniforms;
        Object.assign(shared, { tColorHalf: { value: null }, tCocHalf: { value: null }, tBlurHalf: { value: null }, uHalfResolution: { value: new THREE.Vector2(Math.ceil(resWidth / 2), Math.ceil(resHeight / 2)) }, uWriteCoc: { value: false } });
        this.prefilter = new THREE.ShaderMaterial({ uniforms: shared, vertexShader: CINEMATIC_BOKEH_PREFILTER_SHADER.vertexShader, fragmentShader: CINEMATIC_BOKEH_PREFILTER_SHADER.fragmentShader, depthTest: false, depthWrite: false });
        this.composite = new THREE.ShaderMaterial({ uniforms: shared, vertexShader: CINEMATIC_BOKEH_COMPOSITE_SHADER.vertexShader, fragmentShader: CINEMATIC_BOKEH_COMPOSITE_SHADER.fragmentShader, depthTest: false, depthWrite: false });

        this.quadCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
        this.quadScene = new THREE.Scene();
        this.quadMesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.material);
        this.quadScene.add(this.quadMesh);
    }

    /**
     * Uniforms proxy providing convenient metric and millimeter parameter access.
     */
    public get uniforms(): Record<string, { value: any }> {
        const matUniforms = this.material.uniforms;
        return {
            ...matUniforms,
            focusDistance: matUniforms.uFocusDistance,
            focalLength: {
                get value() { return matUniforms.uFocalLengthMm.value * 0.001; },
                set value(v: number) { matUniforms.uFocalLengthMm.value = v * 1000.0; }
            },
            focalLengthMm: matUniforms.uFocalLengthMm,
            fStop: matUniforms.uApertureFStop,
            apertureFStop: matUniforms.uApertureFStop,
            sensorHeight: {
                get value() { return matUniforms.uSensorHeightMm.value * 0.001; },
                set value(v: number) { matUniforms.uSensorHeightMm.value = v * 1000.0; }
            },
            sensorHeightMm: matUniforms.uSensorHeightMm,
            anamorphicRatio: matUniforms.uAnamorphicRatio,
            cameraNear: matUniforms.uCameraNear,
            cameraFar: matUniforms.uCameraFar,
            maxBlurRadius: matUniforms.uMaxBlurRadiusPx,
            maxBlurRadiusPx: matUniforms.uMaxBlurRadiusPx,
            maxBlurRadiusPixels: matUniforms.uMaxBlurRadiusPx,
            resolution: matUniforms.uResolution,
            bokehScale: matUniforms.uBokehScale,
            enabled: matUniforms.uEnabled
        };
    }

    /**
     * Resizes resolution uniform.
     */
    public setSize(width: number, height: number): this {
        this.material.uniforms.uResolution.value.set(width, height);
        return this;
    }

    /**
     * Updates near and far planes from camera.
     */
    public setCamera(camera: THREE.PerspectiveCamera): this {
        this.params.cameraNear = camera.near;
        this.params.cameraFar = camera.far;
        this.material.uniforms.uCameraNear.value = camera.near;
        this.material.uniforms.uCameraFar.value = camera.far;
        return this;
    }

    /**
     * Updates focus distance in meters dynamically (for rack focus and target tracking).
     */
    public setFocusDistance(distanceMeters: number): this {
        this.params.focusDistanceMeters = Math.max(distanceMeters, 0.05);
        this.material.uniforms.uFocusDistance.value = this.params.focusDistanceMeters;
        return this;
    }

    /**
     * Updates optical parameters (focal length, f-stop, and sensor format).
     */
    public setOpticalParameters(
        focalLengthMm: number,
        apertureFStop: number,
        anamorphicRatioOrSensorHeight?: number
    ): this {
        this.params.focalLengthMm = Math.max(focalLengthMm, 1.0);
        this.params.apertureFStop = Math.max(apertureFStop, 0.5);
        if (typeof anamorphicRatioOrSensorHeight === 'number') {
            if (anamorphicRatioOrSensorHeight >= 5.0) {
                this.params.sensorHeightMm = anamorphicRatioOrSensorHeight;
                this.material.uniforms.uSensorHeightMm.value = this.params.sensorHeightMm;
            } else {
                this.params.anamorphicRatio = anamorphicRatioOrSensorHeight;
                this.material.uniforms.uAnamorphicRatio.value = this.params.anamorphicRatio;
            }
        }
        this.material.uniforms.uFocalLengthMm.value = this.params.focalLengthMm;
        this.material.uniforms.uApertureFStop.value = this.params.apertureFStop;
        return this;
    }

    /**
     * Synchronizes parameters from a physical camera config and Three.js camera.
     */
    public updateFromConfig(
        config: PhysicalCameraConfig,
        cameraOrFocus?: THREE.PerspectiveCamera | number,
        focusDistanceMeters?: number
    ): this {
        let camera: THREE.PerspectiveCamera | undefined;
        let focus = focusDistanceMeters;

        if (cameraOrFocus instanceof THREE.PerspectiveCamera) {
            camera = cameraOrFocus;
        } else if (typeof cameraOrFocus === 'number') {
            focus = cameraOrFocus;
        }

        const sensor = PhysicalCameraModel.resolveSensorFormat(config);
        const focal = config.focalLengthMm ?? 50.0;
        const fStop = config.apertureFStop ?? 2.8;
        const resolvedFocus = focus ?? config.focusDistanceMeters ?? 5.0;

        this.setOpticalParameters(focal, fStop, sensor.heightMm);
        this.setFocusDistance(resolvedFocus);

        this.params.anamorphicRatio = config.anamorphicSqueeze ?? config.anamorphicRatio ?? 1.0;
        this.material.uniforms.uAnamorphicRatio.value = this.params.anamorphicRatio;

        if (typeof (config as any).maxBlurRadiusPixels === 'number') {
            this.params.maxBlurRadiusPx = (config as any).maxBlurRadiusPixels;
            this.material.uniforms.uMaxBlurRadiusPx.value = this.params.maxBlurRadiusPx;
        }

        this.params.bokehScale = config.bokehScale ?? 1.0;
        this.material.uniforms.uBokehScale.value = this.params.bokehScale;

        if (typeof config.enableDepthOfField === 'boolean') {
            this.params.enabled = config.enableDepthOfField;
            this.material.uniforms.uEnabled.value = this.params.enabled;
        }

        if (camera) {
            this.params.cameraNear = camera.near;
            this.params.cameraFar = camera.far;
            this.material.uniforms.uCameraNear.value = camera.near;
            this.material.uniforms.uCameraFar.value = camera.far;
        }

        return this;
    }

    /**
     * Sets whether depth of field is enabled.
     */
    public setEnabled(enabled: boolean): this {
        this.params.enabled = enabled;
        this.material.uniforms.uEnabled.value = enabled;
        return this;
    }

    /**
     * Returns current parameters copy.
     */
    public getParams(): Readonly<BokehPassParams> {
        return { ...this.params };
    }

    /** A half-resolution target (half float); mip-mapped for the gather's footprints when `mips`. */
    private half(current: THREE.WebGLRenderTarget | null, w: number, h: number, mips: boolean): THREE.WebGLRenderTarget {
        if (current && current.width === w && current.height === h) return current;
        current?.dispose();
        const t = new THREE.WebGLRenderTarget(w, h, { type: THREE.HalfFloatType, format: THREE.RGBAFormat, depthBuffer: false, magFilter: THREE.LinearFilter, minFilter: mips ? THREE.LinearMipmapLinearFilter : THREE.LinearFilter, generateMipmaps: mips });
        return t;
    }

    private draw(renderer: THREE.WebGLRenderer, material: THREE.ShaderMaterial, target: THREE.WebGLRenderTarget | null): void {
        this.quadMesh.material = material;
        renderer.setRenderTarget(target);
        renderer.render(this.quadScene, this.quadCamera);
    }

    /**
     * Executes the bokeh render pass: prefilter (colour and blur radius at half resolution, mip-mapped), gather at half
     * resolution, composite at full resolution into `target` (the canvas when null; the current target when undefined).
     */
    public render(
        renderer: THREE.WebGLRenderer,
        colorTexture: THREE.Texture,
        depthTexture: THREE.Texture,
        width: number,
        height: number,
        target?: THREE.WebGLRenderTarget | null
    ): void {
        const u = this.material.uniforms;
        u.tColor.value = colorTexture;
        u.tDepth.value = depthTexture;
        u.uResolution.value.set(width, height);
        const hw = Math.max(1, Math.ceil(width / 2)), hh = Math.max(1, Math.ceil(height / 2));
        u.uHalfResolution.value.set(hw, hh);
        this.colorHalf = this.half(this.colorHalf, hw, hh, true);
        this.cocHalf = this.half(this.cocHalf, hw, hh, true);
        this.blurHalf = this.half(this.blurHalf, hw, hh, false);

        const prevTarget = renderer.getRenderTarget();
        const out = target !== undefined ? target : prevTarget;
        try {
            u.uWriteCoc.value = false;
            this.draw(renderer, this.prefilter, this.colorHalf);
            u.uWriteCoc.value = true;
            this.draw(renderer, this.prefilter, this.cocHalf);
            u.tColorHalf.value = this.colorHalf.texture;
            u.tCocHalf.value = this.cocHalf.texture;
            this.draw(renderer, this.material, this.blurHalf);
            u.tBlurHalf.value = this.blurHalf.texture;
            this.draw(renderer, this.composite, out);
        } finally {
            this.quadMesh.material = this.material;
            renderer.setRenderTarget(prevTarget);
        }
    }

    /**
     * Cleanly disposes GPU resources.
     */
    public dispose(): void {
        this.material.dispose();
        this.prefilter.dispose();
        this.composite.dispose();
        this.colorHalf?.dispose(); this.cocHalf?.dispose(); this.blurHalf?.dispose();
        this.colorHalf = this.cocHalf = this.blurHalf = null;
        this.quadMesh.geometry.dispose();
    }
}
