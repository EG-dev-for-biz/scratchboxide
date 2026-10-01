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

export const CINEMATIC_BOKEH_SHADER = {
    vertexShader: `
        varying vec2 vUv;
        void main() {
            vUv = uv;
            gl_Position = vec4(position, 1.0);
        }
    `,
    fragmentShader: `
        uniform sampler2D tColor;
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

        varying vec2 vUv;

        // Golden Angle constant in radians (approx 137.507764 degrees)
        const float GOLDEN_ANGLE = 2.39996323;
        const int NUM_SAMPLES = 24;

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

        // Computes signed Circle of Confusion (CoC) in pixels
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

        void main() {
            vec4 centerColor = texture2D(tColor, vUv);

            if (!uEnabled) {
                gl_FragColor = centerColor;
                return;
            }

            float centerDepth = getMetricDepth(vUv);
            float centerCoC = computeCoCPixels(centerDepth);
            float centerRadius = abs(centerCoC);

            // Fast exit for sharp in-focus fragments
            if (centerRadius < 0.5) {
                gl_FragColor = centerColor;
                return;
            }

            vec4 colorAccum = centerColor;
            float weightAccum = 1.0;

            vec2 invRes = 1.0 / uResolution;
            vec2 aspectCorrection = vec2(1.0 / max(uAnamorphicRatio, 0.5), 1.0);

            // Multi-tap Golden Spiral Poisson distribution
            for (int i = 1; i <= NUM_SAMPLES; i++) {
                float fi = float(i);
                float theta = fi * GOLDEN_ANGLE;
                float r = sqrt(fi / float(NUM_SAMPLES));

                vec2 dir = vec2(cos(theta), sin(theta)) * aspectCorrection;
                vec2 sampleUv = vUv + dir * (r * centerRadius) * invRes;

                // Clamp to edge
                sampleUv = clamp(sampleUv, vec2(0.0), vec2(1.0));

                float sampleDepth = getMetricDepth(sampleUv);
                float sampleCoC = computeCoCPixels(sampleDepth);
                float sampleRadius = abs(sampleCoC);

                // Depth weighting: avoid foreground bleeding over background,
                // but allow background to blur smoothly behind foreground edges.
                float weight = 1.0;
                if (sampleDepth > centerDepth) {
                    // Sample is in background: weight by whether sample itself is blurred
                    weight = clamp((sampleRadius - r * centerRadius + 1.0) / 2.0, 0.0, 1.0);
                } else {
                    // Sample is in foreground: full weight to blend over background
                    weight = clamp((sampleRadius - r * centerRadius + 1.0) / 2.0, 0.0, 1.0);
                }

                vec4 sampleColor = texture2D(tColor, sampleUv);
                colorAccum += sampleColor * weight;
                weightAccum += weight;
            }

            gl_FragColor = colorAccum / max(weightAccum, 0.0001);
        }
    `
};

/**
 * Professional real-time Cinematic Depth-of-Field and Bokeh post-processing pass.
 */
export class CinematicBokehPass {
    private material: THREE.ShaderMaterial;
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

    /**
     * Executes the bokeh render pass.
     */
    public render(
        renderer: THREE.WebGLRenderer,
        colorTexture: THREE.Texture,
        depthTexture: THREE.Texture,
        width: number,
        height: number,
        target?: THREE.WebGLRenderTarget | null
    ): void {
        this.material.uniforms.tColor.value = colorTexture;
        this.material.uniforms.tDepth.value = depthTexture;
        this.material.uniforms.uResolution.value.set(width, height);

        const prevTarget = renderer.getRenderTarget();
        if (target !== undefined) {
            renderer.setRenderTarget(target);
        }

        renderer.render(this.quadScene, this.quadCamera);

        if (target !== undefined) {
            renderer.setRenderTarget(prevTarget);
        }
    }

    /**
     * Cleanly disposes GPU resources.
     */
    public dispose(): void {
        this.material.dispose();
        this.quadMesh.geometry.dispose();
    }
}
