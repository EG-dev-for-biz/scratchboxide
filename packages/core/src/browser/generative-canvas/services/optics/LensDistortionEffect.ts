/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import * as THREE from 'three';
import type { LensDistortionParams } from '../../../../common/vfx-plate-protocol';
import { VfxPlateMatchmoveService } from '../video/VfxPlateMatchmoveService';

export type LensDistortionMode = 'redistort' | 'undistort' | 'stmap';
export type LensDistortionEdgeMode = 'letterbox' | 'clamp' | 'transparent';
export type LensDistortionFilterQuality = 'bilinear' | 'bicubic';

/**
 * Optical Lens Distortion shader uniform definitions.
 */
export interface LensDistortionUniforms {
    tDiffuse: { value: THREE.Texture | null };
    k1: { value: number };
    k2: { value: number };
    k3: { value: number };
    k4: { value: number };
    p1: { value: number };
    p2: { value: number };
    opticalCenter: { value: THREE.Vector2 };
    aspectRatio: { value: number };
    chromaticAberration: { value: number };
    anamorphicSqueeze: { value: number };
    mode: { value: number }; // 0 = redistort, 1 = undistort, 2 = stmap
    edgeMode: { value: number }; // 0 = letterbox, 1 = clamp, 2 = transparent
    filterQuality: { value: number }; // 0 = bilinear, 1 = bicubic
    enabled: { value: boolean };
    letterboxColor: { value: THREE.Vector4 };
    /** Source uv per unit of output uv about the centre: (1, 1), or 1 / overscan when the source was rendered wider. */
    sourceScale: { value: THREE.Vector2 };
}

/**
 * Configuration options for Brown-Conrady and VFX optical lens distortion.
 */
export interface LensDistortionConfig {
    k1?: number;
    k2?: number;
    k3?: number;
    k4?: number;
    p1?: number;
    p2?: number;
    opticalCenter?: [number, number] | THREE.Vector2;
    aspectRatio?: number;
    chromaticAberration?: number;
    anamorphicSqueeze?: number;
    squeezeFactor?: number;
    mode?: LensDistortionMode;
    edgeMode?: LensDistortionEdgeMode;
    filterQuality?: LensDistortionFilterQuality;
    enabled?: boolean;
    letterboxColor?: [number, number, number, number];
    c20?: number;
    c02?: number;
    c40?: number;
    c22?: number;
    c04?: number;
}

/**
 * Validated real-world camera lens optical profile archetype.
 */
export interface LensOpticalProfile {
    id: string;
    name: string;
    focalLengthMm: number;
    sensorFormat: 'full-frame' | 'aps-c' | 'smartphone' | 'micro-four-thirds' | 'action-cam';
    description: string;
    config: LensDistortionConfig;
}

/**
 * Validated real-world optical presets covering common camera and lens archetypes.
 */
export const LENS_OPTICAL_PRESETS: Record<string, LensOpticalProfile> = {
    smartphone_wide_26mm: {
        id: 'smartphone_wide_26mm',
        name: 'Smartphone Primary Wide (26mm eq.)',
        focalLengthMm: 26.0,
        sensorFormat: 'smartphone',
        description: 'Standard 1/1.3" smartphone primary camera with moderate barrel curvature and subtle chromatic dispersion.',
        config: {
            k1: -0.038,
            k2: 0.008,
            p1: 0.0,
            p2: 0.0,
            chromaticAberration: 0.0018,
            anamorphicSqueeze: 1.0,
            enabled: true
        }
    },
    ultrawide_14mm: {
        id: 'ultrawide_14mm',
        name: 'Ultra-Wide Architecture / Landscape (14mm eq.)',
        focalLengthMm: 14.0,
        sensorFormat: 'full-frame',
        description: 'Pronounced barrel distortion with noticeable peripheral stretching and edge dispersion.',
        config: {
            k1: -0.095,
            k2: 0.024,
            p1: 0.0005,
            p2: -0.0003,
            chromaticAberration: 0.0042,
            anamorphicSqueeze: 1.0,
            enabled: true
        }
    },
    action_cam_fisheye: {
        id: 'action_cam_fisheye',
        name: 'Action Camera Curvilinear Fisheye (16mm FOV)',
        focalLengthMm: 16.0,
        sensorFormat: 'action-cam',
        description: 'Heavy hemispherical barrel distortion with strong edge curvature and dispersion.',
        config: {
            k1: -0.220,
            k2: 0.065,
            p1: 0.0,
            p2: 0.0,
            chromaticAberration: 0.0075,
            anamorphicSqueeze: 1.0,
            enabled: true
        }
    },
    cinema_anamorphic_2x: {
        id: 'cinema_anamorphic_2x',
        name: 'Cinema Anamorphic (2.0x Squeeze)',
        focalLengthMm: 40.0,
        sensorFormat: 'full-frame',
        description: 'Horizontal cylindrical squeeze with horizontal-dominant barrel distortion and streak chromatic flare.',
        config: {
            k1: -0.028,
            k2: 0.005,
            p1: 0.0,
            p2: 0.0,
            chromaticAberration: 0.0028,
            anamorphicSqueeze: 2.0,
            squeezeFactor: 2.0,
            enabled: true
        }
    },
    standard_prime_50mm: {
        id: 'standard_prime_50mm',
        name: 'Standard Prime (50mm Rectilinear)',
        focalLengthMm: 50.0,
        sensorFormat: 'full-frame',
        description: 'Nearly distortion-free reference prime lens with negligible chromatic aberration.',
        config: {
            k1: -0.004,
            k2: 0.0005,
            p1: 0.0,
            p2: 0.0,
            chromaticAberration: 0.0003,
            anamorphicSqueeze: 1.0,
            enabled: true
        }
    },
    cooke_s4_wide_18mm: {
        id: 'cooke_s4_wide_18mm',
        name: 'Cooke S4/i Prime (18mm T2.0)',
        focalLengthMm: 18.0,
        sensorFormat: 'full-frame',
        description: 'Warm cine characteristic with subtle higher-order mustache barrel distortion.',
        config: {
            k1: -0.042,
            k2: 0.009,
            k3: -0.0012,
            p1: 0.0,
            p2: 0.0,
            chromaticAberration: 0.0015,
            anamorphicSqueeze: 1.0,
            enabled: true
        }
    },
    arri_ultra_prime_24mm: {
        id: 'arri_ultra_prime_24mm',
        name: 'ARRI Zeiss Ultra Prime (24mm T1.9)',
        focalLengthMm: 24.0,
        sensorFormat: 'full-frame',
        description: 'High optical resolution prime with tightly controlled uniform barrel distortion.',
        config: {
            k1: -0.019,
            k2: 0.0028,
            p1: 0.0,
            p2: 0.0,
            chromaticAberration: 0.0008,
            anamorphicSqueeze: 1.0,
            enabled: true
        }
    },
    panavision_c_series_anamorphic_50mm: {
        id: 'panavision_c_series_anamorphic_50mm',
        name: 'Panavision C-Series Anamorphic (50mm 2.0x)',
        focalLengthMm: 50.0,
        sensorFormat: 'full-frame',
        description: 'Classic Hollywood 2x anamorphic with pronounced horizontal cylindrical compression and organic falloff.',
        config: {
            k1: -0.034,
            k2: 0.006,
            p1: 0.0,
            p2: 0.0,
            chromaticAberration: 0.0035,
            anamorphicSqueeze: 2.0,
            squeezeFactor: 2.0,
            c20: -0.034,
            c02: -0.012,
            enabled: true
        }
    },
    telephoto_portrait_85mm: {
        id: 'telephoto_portrait_85mm',
        name: 'Telephoto Portrait (85mm Pincushion)',
        focalLengthMm: 85.0,
        sensorFormat: 'full-frame',
        description: 'Subtle pincushion distortion characteristic of multi-element telephoto portrait optics.',
        config: {
            k1: 0.006,
            k2: 0.001,
            p1: 0.0,
            p2: 0.0,
            chromaticAberration: 0.0001,
            anamorphicSqueeze: 1.0,
            enabled: true
        }
    },
    drone_surveying_lens: {
        id: 'drone_surveying_lens',
        name: 'Drone Photogrammetry Surveying Lens (24mm calibrated)',
        focalLengthMm: 24.0,
        sensorFormat: 'micro-four-thirds',
        description: 'Calibrated photogrammetric lens with slight radial barrel and minute tangential tilt coefficients.',
        config: {
            k1: -0.018,
            k2: 0.003,
            p1: 0.0002,
            p2: -0.0001,
            chromaticAberration: 0.0008,
            anamorphicSqueeze: 1.0,
            enabled: true
        }
    }
};

/**
 * GLSL Shader definition for GPU-accelerated Brown-Conrady Optical Lens Distortion.
 */
export const LENS_DISTORTION_SHADER = {
    uniforms: {
        tDiffuse: { value: null as THREE.Texture | null },
        k1: { value: -0.038 },
        k2: { value: 0.008 },
        k3: { value: 0.0 },
        k4: { value: 0.0 },
        p1: { value: 0.0 },
        p2: { value: 0.0 },
        opticalCenter: { value: new THREE.Vector2(0.5, 0.5) },
        aspectRatio: { value: 16 / 9 },
        chromaticAberration: { value: 0.0018 },
        anamorphicSqueeze: { value: 1.0 },
        mode: { value: 0 }, // 0 = redistort, 1 = undistort, 2 = stmap
        edgeMode: { value: 0 }, // 0 = letterbox, 1 = clamp, 2 = transparent
        filterQuality: { value: 0 }, // 0 = bilinear, 1 = bicubic
        enabled: { value: true },
        letterboxColor: { value: new THREE.Vector4(0.02, 0.04, 0.08, 1.0) },
        sourceScale: { value: new THREE.Vector2(1, 1) }
    },

    vertexShader: /* glsl */ `
        varying vec2 vUv;
        void main() {
            vUv = uv;
            gl_Position = vec4(position.xy, 0.0, 1.0);
        }
    `,

    fragmentShader: /* glsl */ `
        precision highp float;

        uniform sampler2D tDiffuse;
        uniform float k1;
        uniform float k2;
        uniform float k3;
        uniform float k4;
        uniform float p1;
        uniform float p2;
        uniform vec2 opticalCenter;
        uniform float aspectRatio;
        uniform float chromaticAberration;
        uniform float anamorphicSqueeze;
        uniform int mode;          // 0 = redistort, 1 = undistort, 2 = stmap
        uniform int edgeMode;      // 0 = letterbox, 1 = clamp, 2 = transparent
        uniform int filterQuality; // 0 = bilinear, 1 = bicubic
        uniform bool enabled;
        uniform vec4 letterboxColor;
        uniform vec2 sourceScale;

        varying vec2 vUv;

        vec2 distortCoords(vec2 coord) {
            float r2 = dot(coord, coord);
            float r4 = r2 * r2;
            float r6 = r4 * r2;
            float r8 = r4 * r4;

            float radial = 1.0 + k1 * r2 + k2 * r4 + k3 * r6 + k4 * r8;
            vec2 tang = vec2(
                2.0 * p1 * coord.x * coord.y + p2 * (r2 + 2.0 * coord.x * coord.x),
                p1 * (r2 + 2.0 * coord.y * coord.y) + 2.0 * p2 * coord.x * coord.y
            );
            return coord * radial + tang;
        }

        vec2 undistortCoords(vec2 targetCoord) {
            vec2 p = targetCoord;
            for (int i = 0; i < 5; i++) {
                float r2 = dot(p, p);
                float r4 = r2 * r2;
                float r6 = r4 * r2;
                float r8 = r4 * r4;

                float radial = 1.0 + k1 * r2 + k2 * r4 + k3 * r6 + k4 * r8;
                vec2 tang = vec2(
                    2.0 * p1 * p.x * p.y + p2 * (r2 + 2.0 * p.x * p.x),
                    p1 * (r2 + 2.0 * p.y * p.y) + 2.0 * p2 * p.x * p.y
                );
                vec2 f = p * radial + tang;
                vec2 res = f - targetCoord;

                float dRad = 2.0 * (k1 + 2.0 * k2 * r2 + 3.0 * k3 * r4 + 4.0 * k4 * r6);
                float j00 = radial + p.x * p.x * dRad + 2.0 * p1 * p.y + 6.0 * p2 * p.x;
                float j01 = p.x * p.y * dRad + 2.0 * p1 * p.x + 2.0 * p2 * p.y;
                float j10 = p.y * p.x * dRad + 2.0 * p1 * p.x + 2.0 * p2 * p.y;
                float j11 = radial + p.y * p.y * dRad + 6.0 * p1 * p.y + 2.0 * p2 * p.x;

                float det = j00 * j11 - j01 * j10;
                if (abs(det) < 1e-7) break;

                vec2 step = vec2(
                    (j11 * res.x - j01 * res.y) / det,
                    (-j10 * res.x + j00 * res.y) / det
                );
                p -= step;
            }
            return p;
        }

        void main() {
            if (!enabled) {
                if (mode == 2) {
                    gl_FragColor = vec4(vUv.x, vUv.y, 0.0, 1.0);
                } else {
                    gl_FragColor = texture2D(tDiffuse, vUv);
                }
                return;
            }

            vec2 coord = vUv - opticalCenter;
            coord.x *= aspectRatio;
            coord.x /= max(anamorphicSqueeze, 0.001);

            vec2 mappedCoord;
            if (mode == 1) {
                // Undistort mode: destination is rectilinear, sample distorted source
                mappedCoord = distortCoords(coord);
            } else {
                // Redistort mode (default): destination is distorted, sample rectilinear source
                mappedCoord = undistortCoords(coord);
            }

            mappedCoord.x *= anamorphicSqueeze;
            mappedCoord.x /= aspectRatio;

            // the source may cover more than the output frame (overscan): map output-frame uv into it
            vec2 finalUv = 0.5 + (opticalCenter + mappedCoord - 0.5) * sourceScale;

            // STMap output
            if (mode == 2) {
                gl_FragColor = vec4(finalUv.x, finalUv.y, 0.0, 1.0);
                return;
            }

            // Edge handling
            bool outOfBounds = (finalUv.x < 0.0 || finalUv.x > 1.0 || finalUv.y < 0.0 || finalUv.y > 1.0);
            if (outOfBounds) {
                if (edgeMode == 1) {
                    finalUv = clamp(finalUv, 0.0, 1.0);
                } else if (edgeMode == 2) {
                    gl_FragColor = vec4(0.0);
                    return;
                } else {
                    gl_FragColor = letterboxColor;
                    return;
                }
            }

            float r2 = dot(coord, coord);
            if (chromaticAberration > 0.00001) {
                vec2 redUv = clamp(0.5 + (opticalCenter + mappedCoord * (1.0 + chromaticAberration * r2) - 0.5) * sourceScale, 0.0, 1.0);
                vec2 blueUv = clamp(0.5 + (opticalCenter + mappedCoord * (1.0 - chromaticAberration * r2) - 0.5) * sourceScale, 0.0, 1.0);

                float r = texture2D(tDiffuse, redUv).r;
                float g = texture2D(tDiffuse, finalUv).g;
                float b = texture2D(tDiffuse, blueUv).b;
                float a = texture2D(tDiffuse, finalUv).a;

                gl_FragColor = vec4(r, g, b, a);
            } else {
                gl_FragColor = texture2D(tDiffuse, finalUv);
            }
        }
    `
};

/**
 * Analytical CPU projection of Brown-Conrady UV coordinate displacement.
 * Matches GPU shader output with mathematical precision for offline tests and coordinate mapping.
 */
export function computeBrownConradyUV(
    uv: [number, number],
    params: LensDistortionParams & {
        opticalCenter?: [number, number];
        anamorphicSqueeze?: number;
    },
    aspectRatio: number = 1.0
): [number, number] {
    const { k1, k2, k3 = 0, k4 = 0, p1 = 0, p2 = 0, anamorphicSqueeze = 1.0, squeezeFactor } = params;
    const squeeze = squeezeFactor ?? anamorphicSqueeze;
    const oc = params.opticalCenter || [0.5, 0.5];

    let x = (uv[0] - oc[0]) * aspectRatio;
    let y = uv[1] - oc[1];
    x /= Math.max(squeeze, 0.001);

    const r2 = x * x + y * y;
    const r4 = r2 * r2;
    const r6 = r4 * r2;
    const r8 = r4 * r4;

    const radial = 1.0 + k1 * r2 + k2 * r4 + k3 * r6 + k4 * r8;
    const xTang = 2.0 * p1 * x * y + p2 * (r2 + 2.0 * x * x);
    const yTang = p1 * (r2 + 2.0 * y * y) + 2.0 * p2 * x * y;

    let distCoordX = x * radial + xTang;
    const distCoordY = y * radial + yTang;

    distCoordX = (distCoordX * squeeze) / aspectRatio;

    return [oc[0] + distCoordX, oc[1] + distCoordY];
}

/**
 * Derives realistic Brown-Conrady lens distortion coefficients from optical focal length.
 * Shorter focal lengths produce negative (barrel) distortion; longer produce positive (pincushion).
 */
export function calculateBrownConradyFromFocalLength(
    focalLengthMm: number,
    sensorWidthMm: number = 36.0
): LensDistortionConfig {
    const f = Math.max(focalLengthMm, 8.0);

    if (f < 18.0) {
        // Ultra-wide
        return {
            k1: -0.095 * (18.0 / f),
            k2: 0.024 * (18.0 / f),
            p1: 0.0004,
            p2: -0.0002,
            chromaticAberration: 0.0045 * (18.0 / f),
            anamorphicSqueeze: 1.0,
            enabled: true
        };
    } else if (f < 35.0) {
        // Wide-angle (smartphone primary range)
        const factor = (35.0 - f) / 17.0; // 0 at 35mm, 1 at 18mm
        return {
            k1: -0.015 - 0.035 * factor,
            k2: 0.002 + 0.008 * factor,
            p1: 0.0,
            p2: 0.0,
            chromaticAberration: 0.0008 + 0.0018 * factor,
            anamorphicSqueeze: 1.0,
            enabled: true
        };
    } else if (f <= 60.0) {
        // Standard normal
        return {
            k1: -0.004,
            k2: 0.0005,
            p1: 0.0,
            p2: 0.0,
            chromaticAberration: 0.0003,
            anamorphicSqueeze: 1.0,
            enabled: true
        };
    } else {
        // Telephoto (pincushion)
        const factor = Math.min((f - 60.0) / 140.0, 1.5);
        return {
            k1: 0.004 + 0.008 * factor,
            k2: 0.0008 + 0.0015 * factor,
            p1: 0.0,
            p2: 0.0,
            chromaticAberration: 0.0002,
            anamorphicSqueeze: 1.0,
            enabled: true
        };
    }
}

/**
 * Self-contained Three.js post-processing pass and effect controller for
 * Brown-Conrady Optical Lens Distortion and Chromatic Dispersion.
 */
export class LensDistortionEffect {
    private material: THREE.ShaderMaterial;
    private quadScene: THREE.Scene;
    private quadCamera: THREE.OrthographicCamera;
    private quadMesh: THREE.Mesh;
    private currentConfig: Required<LensDistortionConfig>;

    constructor(config: LensDistortionConfig = {}) {
        const oc = config.opticalCenter
            ? (config.opticalCenter instanceof THREE.Vector2
                ? config.opticalCenter.clone()
                : new THREE.Vector2(config.opticalCenter[0], config.opticalCenter[1]))
            : new THREE.Vector2(0.5, 0.5);

        const lbColor = config.letterboxColor
            ? new THREE.Vector4(...config.letterboxColor)
            : new THREE.Vector4(0.02, 0.04, 0.08, 1.0);

        const modeMap: Record<LensDistortionMode, number> = {
            redistort: 0,
            undistort: 1,
            stmap: 2
        };
        const edgeMap: Record<LensDistortionEdgeMode, number> = {
            letterbox: 0,
            clamp: 1,
            transparent: 2
        };
        const filterMap: Record<LensDistortionFilterQuality, number> = {
            bilinear: 0,
            bicubic: 1
        };

        const mode = config.mode ?? 'redistort';
        const edgeMode = config.edgeMode ?? 'letterbox';
        const filterQuality = config.filterQuality ?? 'bilinear';

        this.currentConfig = {
            k1: config.k1 ?? -0.038,
            k2: config.k2 ?? 0.008,
            k3: config.k3 ?? 0.0,
            k4: config.k4 ?? 0.0,
            p1: config.p1 ?? 0.0,
            p2: config.p2 ?? 0.0,
            opticalCenter: [oc.x, oc.y],
            aspectRatio: config.aspectRatio ?? (16 / 9),
            chromaticAberration: config.chromaticAberration ?? 0.0018,
            anamorphicSqueeze: config.anamorphicSqueeze ?? config.squeezeFactor ?? 1.0,
            squeezeFactor: config.squeezeFactor ?? config.anamorphicSqueeze ?? 1.0,
            mode,
            edgeMode,
            filterQuality,
            enabled: config.enabled ?? true,
            letterboxColor: [lbColor.x, lbColor.y, lbColor.z, lbColor.w],
            c20: config.c20 ?? 0.0,
            c02: config.c02 ?? 0.0,
            c40: config.c40 ?? 0.0,
            c22: config.c22 ?? 0.0,
            c04: config.c04 ?? 0.0
        };

        this.material = new THREE.ShaderMaterial({
            uniforms: {
                tDiffuse: { value: null },
                k1: { value: this.currentConfig.k1 },
                k2: { value: this.currentConfig.k2 },
                k3: { value: this.currentConfig.k3 },
                k4: { value: this.currentConfig.k4 },
                p1: { value: this.currentConfig.p1 },
                p2: { value: this.currentConfig.p2 },
                opticalCenter: { value: oc },
                aspectRatio: { value: this.currentConfig.aspectRatio },
                chromaticAberration: { value: this.currentConfig.chromaticAberration },
                anamorphicSqueeze: { value: this.currentConfig.anamorphicSqueeze },
                mode: { value: modeMap[mode] },
                edgeMode: { value: edgeMap[edgeMode] },
                filterQuality: { value: filterMap[filterQuality] },
                enabled: { value: this.currentConfig.enabled },
                letterboxColor: { value: lbColor },
                sourceScale: { value: new THREE.Vector2(1, 1) }
            },
            vertexShader: LENS_DISTORTION_SHADER.vertexShader,
            fragmentShader: LENS_DISTORTION_SHADER.fragmentShader,
            depthTest: false,
            depthWrite: false
        });

        this.quadCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
        this.quadScene = new THREE.Scene();
        this.quadMesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.material);
        this.quadScene.add(this.quadMesh);
    }

    /**
     * Executes the post-processing render pass onto the target (or default framebuffer).
     */
    public render(
        renderer: THREE.WebGLRenderer,
        inputTexture: THREE.Texture,
        target?: THREE.WebGLRenderTarget | null
    ): void {
        this.material.uniforms.tDiffuse.value = inputTexture;

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
     * Sets radial and tangential distortion parameters.
     */
    public setDistortion(k1: number, k2: number, p1: number = 0, p2: number = 0, k3: number = 0, k4: number = 0): this {
        this.currentConfig.k1 = k1;
        this.currentConfig.k2 = k2;
        this.currentConfig.k3 = k3;
        this.currentConfig.k4 = k4;
        this.currentConfig.p1 = p1;
        this.currentConfig.p2 = p2;
        this.material.uniforms.k1.value = k1;
        this.material.uniforms.k2.value = k2;
        this.material.uniforms.k3.value = k3;
        this.material.uniforms.k4.value = k4;
        this.material.uniforms.p1.value = p1;
        this.material.uniforms.p2.value = p2;
        return this;
    }

    /**
     * Sets how much of the source texture one unit of output uv spans about the centre: 1 / overscan on each axis
     * when the source was rendered with a wider frustum than the output frame (so barrel edges have pixels to pull in).
     */
    public setSourceScale(sx: number, sy: number): this {
        (this.material.uniforms.sourceScale.value as THREE.Vector2).set(sx, sy);
        return this;
    }

    /**
     * Sets optical center principal point (normalized [0, 1]).
     */
    public setOpticalCenter(cx: number, cy: number): this {
        this.currentConfig.opticalCenter = [cx, cy];
        (this.material.uniforms.opticalCenter.value as THREE.Vector2).set(cx, cy);
        return this;
    }

    /**
     * Sets peripheral chromatic dispersion intensity.
     */
    public setChromaticAberration(amount: number): this {
        this.currentConfig.chromaticAberration = Math.max(0, amount);
        this.material.uniforms.chromaticAberration.value = this.currentConfig.chromaticAberration;
        return this;
    }

    /**
     * Sets viewport aspect ratio (width / height) to maintain circular radial symmetry.
     */
    public setAspectRatio(aspect: number): this {
        this.currentConfig.aspectRatio = Math.max(0.01, aspect);
        this.material.uniforms.aspectRatio.value = this.currentConfig.aspectRatio;
        return this;
    }

    /**
     * Sets anamorphic horizontal squeeze factor (e.g. 1.33 or 2.0).
     */
    public setAnamorphicSqueeze(squeeze: number): this {
        const val = Math.max(0.1, squeeze);
        this.currentConfig.anamorphicSqueeze = val;
        this.currentConfig.squeezeFactor = val;
        this.material.uniforms.anamorphicSqueeze.value = val;
        return this;
    }

    /**
     * Sets distortion processing mode ('redistort' | 'undistort' | 'stmap').
     */
    public setMode(mode: LensDistortionMode): this {
        this.currentConfig.mode = mode;
        const modeMap: Record<LensDistortionMode, number> = {
            redistort: 0,
            undistort: 1,
            stmap: 2
        };
        this.material.uniforms.mode.value = modeMap[mode];
        return this;
    }

    /**
     * Sets edge handling mode ('letterbox' | 'clamp' | 'transparent').
     */
    public setEdgeMode(edgeMode: LensDistortionEdgeMode): this {
        this.currentConfig.edgeMode = edgeMode;
        const edgeMap: Record<LensDistortionEdgeMode, number> = {
            letterbox: 0,
            clamp: 1,
            transparent: 2
        };
        this.material.uniforms.edgeMode.value = edgeMap[edgeMode];
        return this;
    }

    /**
     * Sets filtering quality ('bilinear' | 'bicubic').
     */
    public setFilterQuality(quality: LensDistortionFilterQuality): this {
        this.currentConfig.filterQuality = quality;
        this.material.uniforms.filterQuality.value = quality === 'bicubic' ? 1 : 0;
        return this;
    }

    /**
     * Enables or disables shader post-processing bypass.
     */
    public setEnabled(enabled: boolean): this {
        this.currentConfig.enabled = enabled;
        this.material.uniforms.enabled.value = enabled;
        return this;
    }

    /**
     * Sets letterbox color for out-of-bounds distorted pixels.
     */
    public setLetterboxColor(r: number, g: number, b: number, a: number = 1.0): this {
        this.currentConfig.letterboxColor = [r, g, b, a];
        (this.material.uniforms.letterboxColor.value as THREE.Vector4).set(r, g, b, a);
        return this;
    }

    /**
     * Applies an optical profile preset by object or ID.
     */
    public applyProfile(profileOrId: LensOpticalProfile | string): this {
        const profile = typeof profileOrId === 'string'
            ? LENS_OPTICAL_PRESETS[profileOrId]
            : profileOrId;

        if (!profile) {
            throw new Error(`Unknown lens optical profile: ${profileOrId}`);
        }

        const { config } = profile;
        if (config.k1 !== undefined && config.k2 !== undefined) {
            this.setDistortion(
                config.k1,
                config.k2,
                config.p1 ?? 0,
                config.p2 ?? 0,
                config.k3 ?? 0,
                config.k4 ?? 0
            );
        }
        if (config.chromaticAberration !== undefined) {
            this.setChromaticAberration(config.chromaticAberration);
        }
        if (config.anamorphicSqueeze !== undefined || config.squeezeFactor !== undefined) {
            this.setAnamorphicSqueeze(config.squeezeFactor ?? config.anamorphicSqueeze ?? 1.0);
        }
        if (config.opticalCenter !== undefined) {
            const oc = config.opticalCenter instanceof THREE.Vector2
                ? [config.opticalCenter.x, config.opticalCenter.y]
                : config.opticalCenter;
            this.setOpticalCenter(oc[0], oc[1]);
        }
        if (config.mode !== undefined) {
            this.setMode(config.mode);
        }
        if (config.edgeMode !== undefined) {
            this.setEdgeMode(config.edgeMode);
        }
        if (config.filterQuality !== undefined) {
            this.setFilterQuality(config.filterQuality);
        }
        if (config.enabled !== undefined) {
            this.setEnabled(config.enabled);
        }

        return this;
    }

    /**
     * Generates an industry-standard 32-bit float STMap (UV distortion map)
     * as a Float32Array [width * height * 4] (RGBA float32).
     * R = U coordinate in [0, 1]
     * G = V coordinate in [0, 1]
     * B = 0.0
     * A = 1.0
     * Compatible with Foundry Nuke STMap node, Blackmagic Fusion, and Unreal Engine.
     */
    public static generateSTMap(
        width: number,
        height: number,
        options: {
            mode?: 'undistort' | 'redistort';
            params?: LensDistortionParams;
            aspectRatio?: number;
        } = {}
    ): Float32Array {
        const {
            mode = 'undistort',
            params = { k1: 0, k2: 0 },
            aspectRatio = width / height
        } = options;

        const buffer = new Float32Array(width * height * 4);
        const oc = params.opticalCenter ?? [0.5, 0.5];
        const squeeze = params.anamorphicSqueeze ?? params.squeezeFactor ?? 1.0;

        for (let y = 0; y < height; y++) {
            const v = (y + 0.5) / height;
            for (let x = 0; x < width; x++) {
                const u = (x + 0.5) / width;
                const index = (y * width + x) * 4;

                const relX = (u - oc[0]) * aspectRatio / squeeze;
                const relY = (v - oc[1]);

                let sampleU: number;
                let sampleV: number;

                if (mode === 'undistort') {
                    // Output pixel is rectilinear -> fetch distorted source
                    const [distX, distY] = VfxPlateMatchmoveService.distortPoint(relX * squeeze, relY, params);
                    sampleU = oc[0] + (distX / squeeze) * squeeze / aspectRatio;
                    sampleV = oc[1] + distY;
                } else {
                    // Output pixel is distorted -> fetch rectilinear source
                    const [undistX, undistY] = VfxPlateMatchmoveService.undistortPoint(relX * squeeze, relY, params);
                    sampleU = oc[0] + (undistX / squeeze) * squeeze / aspectRatio;
                    sampleV = oc[1] + undistY;
                }

                buffer[index] = sampleU;
                buffer[index + 1] = sampleV;
                buffer[index + 2] = 0.0;
                buffer[index + 3] = 1.0;
            }
        }

        return buffer;
    }

    /**
     * Analytically computes the optimal overscan margin factor (e.g. 0.12 = 12% extra canvas bounds)
     * required to prevent curved edge clipping during rectilinear undistortion or redistortion.
     * Evaluates the 4 filmback corners and 4 edge midpoints.
     */
    public static calculateOverscanMargin(
        params: LensDistortionParams,
        aspectRatio: number = 16 / 9,
        mode: 'undistort' | 'redistort' = 'undistort'
    ): number {
        const oc = params.opticalCenter ?? [0.5, 0.5];
        const squeeze = params.anamorphicSqueeze ?? params.squeezeFactor ?? 1.0;
        const testPoints: [number, number][] = [
            [0.0, 0.0], [1.0, 0.0], [0.0, 1.0], [1.0, 1.0],
            [0.5, 0.0], [0.5, 1.0], [0.0, 0.5], [1.0, 0.5]
        ];

        let maxOverscan = 0.0;

        for (const [u, v] of testPoints) {
            const relX = (u - oc[0]) * aspectRatio / squeeze;
            const relY = (v - oc[1]);

            // Test both forward and inverse mappings to find maximum bounding expansion
            const [dX, dY] = VfxPlateMatchmoveService.distortPoint(relX * squeeze, relY, params);
            const [uX, uY] = VfxPlateMatchmoveService.undistortPoint(relX * squeeze, relY, params);

            for (const [x, y] of [[dX, dY], [uX, uY]]) {
                const mappedU = oc[0] + (x / squeeze) * squeeze / aspectRatio;
                const mappedV = oc[1] + y;

                const delta = Math.max(
                    -mappedU,
                    mappedU - 1.0,
                    -mappedV,
                    mappedV - 1.0
                );

                if (delta > maxOverscan) {
                    maxOverscan = delta;
                }
            }
        }

        return Math.min(0.5, maxOverscan > 0.001 ? Math.ceil((maxOverscan + 0.02) * 100) / 100 : 0.0);
    }

    /**
     * Returns the current optical distortion configuration snapshot.
     */
    public getConfig(): LensDistortionConfig {
        return { ...this.currentConfig };
    }

    /**
     * Returns the underlying Three.js ShaderMaterial.
     */
    public getMaterial(): THREE.ShaderMaterial {
        return this.material;
    }

    /**
     * Disposes WebGL geometry and material memory.
     */
    public dispose(): void {
        this.material.dispose();
        this.quadMesh.geometry.dispose();
        this.quadScene.clear();
    }
}

/**
 * Alias conforming to Three.js post-processing pass conventions.
 */
export const BrownConradyLensDistortionPass = LensDistortionEffect;
