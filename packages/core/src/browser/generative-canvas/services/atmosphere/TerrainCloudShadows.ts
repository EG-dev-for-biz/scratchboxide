/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import * as THREE from 'three';
import { CloudShadowConfig } from './atmosphere-types';

export class TerrainCloudShadows {
    public time: number = 0;
    private readonly config: CloudShadowConfig;
    private readonly materials: Set<THREE.Material> = new Set();
    private readonly uniforms: {
        uSunDirection: { value: THREE.Vector3 };
        uCloudShadowsEnabled: { value: boolean };
        uCloudShadowIntensity: { value: number };
        uCloudShadowScale: { value: number };
        uAtmosphereShadowLength: { value: number };
        uCloudAltitude: { value: number };
        uCloudCoverage: { value: number };
        uCloudDensity: { value: number };
        uWindVector: { value: THREE.Vector2 };
        uTime: { value: number };
    };

    constructor(config: CloudShadowConfig = {}) {
        this.config = {
            cloudShadowsEnabled: config.cloudShadowsEnabled ?? true,
            cloudShadowIntensity: config.cloudShadowIntensity ?? 0.65,
            cloudShadowScale: config.cloudShadowScale ?? 0.015,
            atmosphereShadowLength: config.atmosphereShadowLength ?? 1.0,
            cloudAltitude: config.cloudAltitude ?? 2200.0,
            cloudCoverage: config.cloudCoverage ?? 0.35,
            cloudDensity: config.cloudDensity ?? 0.45,
            windVector: config.windVector ?? [0.05, 0.02]
        };

        this.uniforms = {
            uSunDirection: { value: new THREE.Vector3(0.5, 0.8, 0.3).normalize() },
            uCloudShadowsEnabled: { value: this.config.cloudShadowsEnabled ?? true },
            uCloudShadowIntensity: { value: this.config.cloudShadowIntensity ?? 0.65 },
            uCloudShadowScale: { value: this.config.cloudShadowScale ?? 0.015 },
            uAtmosphereShadowLength: { value: this.config.atmosphereShadowLength ?? 1.0 },
            uCloudAltitude: { value: this.config.cloudAltitude ?? 2200.0 },
            uCloudCoverage: { value: this.config.cloudCoverage ?? 0.35 },
            uCloudDensity: { value: this.config.cloudDensity ?? 0.45 },
            uWindVector: { value: new THREE.Vector2(this.config.windVector?.[0] ?? 0.05, this.config.windVector?.[1] ?? 0.02) },
            uTime: { value: 0.0 }
        };
    }

    /**
     * Injects cloud shadow shader calculation into standard materials (MeshStandardMaterial / MeshLambertMaterial / MeshBasicMaterial).
     */
    public attachToMaterial(material: THREE.Material): void {
        this.materials.add(material);
        (material as any).userData = (material as any).userData || {};
        (material as any).userData.hasCloudShadows = true;

        const uniforms = this.uniforms;

        const prevOnBeforeCompile = material.onBeforeCompile;
        material.onBeforeCompile = (shader, renderer) => {
            if (prevOnBeforeCompile) {
                prevOnBeforeCompile(shader, renderer);
            }

            Object.assign(shader.uniforms, uniforms);

            shader.vertexShader = shader.vertexShader.replace(
                '#include <common>',
                `#include <common>
                varying vec3 vCloudWorldPos;`
            );

            shader.vertexShader = shader.vertexShader.replace(
                '#include <worldpos_vertex>',
                `#include <worldpos_vertex>
                vCloudWorldPos = (modelMatrix * vec4(transformed, 1.0)).xyz;`
            );

            shader.fragmentShader = shader.fragmentShader.replace(
                '#include <common>',
                `#include <common>
                varying vec3 vCloudWorldPos;
                uniform vec3 uSunDirection;
                uniform bool uCloudShadowsEnabled;
                uniform float uCloudShadowIntensity;
                uniform float uCloudShadowScale;
                uniform float uAtmosphereShadowLength;
                uniform float uCloudAltitude;
                uniform float uCloudCoverage;
                uniform float uCloudDensity;
                uniform vec2 uWindVector;
                uniform float uTime;

                vec3 sb_mod289(vec3 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
                vec2 sb_mod289(vec2 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
                vec3 sb_permute(vec3 x) { return sb_mod289(((x * 34.0) + 1.0) * x); }

                float sb_snoise2D(vec2 v) {
                    const vec4 C = vec4(0.211324865405187, 0.366025403784439, -0.577350269189626, 0.024390243902439);
                    vec2 i = floor(v + dot(v, C.yy));
                    vec2 x0 = v - i + dot(i, C.xx);
                    vec2 i1 = (x0.x > x0.y) ? vec2(1.0, 0.0) : vec2(0.0, 1.0);
                    vec4 x12 = x0.xyxy + C.xxzz;
                    x12.xy -= i1;
                    i = sb_mod289(i);
                    vec3 p = sb_permute(sb_permute(i.y + vec3(0.0, i1.y, 1.0)) + i.x + vec3(0.0, i1.x, 1.0));
                    vec3 m = max(0.5 - vec3(dot(x0, x0), dot(x12.xy, x12.xy), dot(x12.zw, x12.zw)), 0.0);
                    m = m * m; m = m * m;
                    vec3 x = 2.0 * fract(p * C.www) - 1.0;
                    vec3 h = abs(x) - 0.5;
                    vec3 ox = floor(x + 0.5);
                    vec3 a0 = x - ox;
                    m *= 1.79284291400159 - 0.85373472095314 * (a0 * a0 + h * h);
                    vec3 g;
                    g.x = a0.x * x0.x + h.x * x0.y;
                    g.yz = a0.yz * x12.xz + h.yz * x12.yw;
                    return 130.0 * dot(m, g);
                }

                float sb_cloudFbm(vec2 p) {
                    float val = 0.0;
                    float amp = 0.5;
                    float freq = 1.0;
                    for (int i = 0; i < 3; i++) {
                        val += amp * sb_snoise2D(p * freq);
                        freq *= 2.05;
                        amp *= 0.5;
                    }
                    return val * 0.5 + 0.5;
                }
                `
            );

            shader.fragmentShader = shader.fragmentShader.replace(
                '#include <dithering_fragment>',
                `#include <dithering_fragment>
                if (uCloudShadowsEnabled && uCloudCoverage > 0.02) {
                    float sunH = max(0.08, uSunDirection.y);
                    float tCloud = max(0.0, uCloudAltitude - vCloudWorldPos.y) / sunH;
                    vec2 shadowCoord = (vCloudWorldPos.xz + uSunDirection.xz * tCloud) * uCloudShadowScale;
                    shadowCoord += uWindVector * uTime;

                    float noiseVal = sb_cloudFbm(shadowCoord);
                    float threshold = 1.0 - clamp(uCloudCoverage, 0.0, 0.98) * 0.85;
                    float rawDensity = smoothstep(threshold - 0.22, threshold + 0.22, noiseVal) * uCloudDensity;
                    float shadowFactor = clamp(rawDensity * uCloudShadowIntensity * uAtmosphereShadowLength, 0.0, 0.88);

                    gl_FragColor.rgb *= (1.0 - shadowFactor);
                }`
            );
        };

        material.needsUpdate = true;
    }

    public update(time: number, sunDirection?: THREE.Vector3): void {
        this.time = time;
        this.uniforms.uTime.value = time;
        if (sunDirection) {
            this.uniforms.uSunDirection.value.copy(sunDirection);
        }
    }

    public updateConfig(config: Partial<CloudShadowConfig>): void {
        if (config.cloudShadowsEnabled !== undefined) this.uniforms.uCloudShadowsEnabled.value = config.cloudShadowsEnabled;
        if (config.cloudShadowIntensity !== undefined) this.uniforms.uCloudShadowIntensity.value = config.cloudShadowIntensity;
        if (config.cloudShadowScale !== undefined) this.uniforms.uCloudShadowScale.value = config.cloudShadowScale;
        if (config.atmosphereShadowLength !== undefined) this.uniforms.uAtmosphereShadowLength.value = config.atmosphereShadowLength;
        if (config.cloudAltitude !== undefined) this.uniforms.uCloudAltitude.value = config.cloudAltitude;
        if (config.cloudCoverage !== undefined) this.uniforms.uCloudCoverage.value = config.cloudCoverage;
        if (config.cloudDensity !== undefined) this.uniforms.uCloudDensity.value = config.cloudDensity;
        if (config.windVector !== undefined) this.uniforms.uWindVector.value.set(config.windVector[0], config.windVector[1]);
    }

    public dispose(): void {
        this.materials.clear();
    }
}

export function createTerrainCloudShadows(config: CloudShadowConfig = {}): TerrainCloudShadows {
    return new TerrainCloudShadows(config);
}
