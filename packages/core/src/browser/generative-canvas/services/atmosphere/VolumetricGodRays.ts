/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import * as THREE from 'three';
import { VolumetricGodRaysConfig, VolumetricGodRaysModule } from './atmosphere-types';

/**
 * Volumetric God Rays & Light Shafts Generator.
 * Creates view-dependent tapered cylindrical light shafts with Fresnel rim fade,
 * vertical falloff, and atmospheric shimmer animation.
 */
export class VolumetricGodRays implements VolumetricGodRaysModule {
    public readonly group: THREE.Group;
    public readonly rayMaterial: THREE.ShaderMaterial;
    public readonly rayGeometry: THREE.CylinderGeometry;
    private readonly scene: THREE.Scene;
    private sunPos: THREE.Vector3;
    private spreadRadius: number;
    private rayCount: number;

    constructor(
        scene: THREE.Scene,
        sunPosition: THREE.Vector3 = new THREE.Vector3(40, 60, 40),
        isSunset: boolean = false,
        config: VolumetricGodRaysConfig = {}
    ) {
        this.scene = scene;
        this.sunPos = sunPosition.clone();
        this.group = new THREE.Group();
        this.group.name = 'volumetric-god-rays';

        this.rayCount = config.rayCount ?? 8;
        this.spreadRadius = config.spreadRadius ?? 5.0;

        const topRadius = config.taperTopRadius ?? 0.6;
        const bottomRadius = config.taperBottomRadius ?? 9.5;
        const rayLength = config.rayLength ?? 110.0;
        const defaultColorHex = isSunset ? 0xffaa55 : 0xfffae0;

        this.rayGeometry = new THREE.CylinderGeometry(topRadius, bottomRadius, rayLength, 24, 1, true);

        const initialColor = config.color
            ? (typeof config.color === 'string' ? new THREE.Color(config.color) : new THREE.Color(config.color))
            : new THREE.Color(defaultColorHex);

        this.rayMaterial = new THREE.ShaderMaterial({
            uniforms: {
                uTime: { value: 0 },
                uColor: { value: initialColor },
                uIntensity: { value: config.intensity !== undefined ? config.intensity : 0.28 },
                uShimmerSpeed: { value: config.shimmerSpeed ?? 1.5 }
            },
            vertexShader: `
                varying vec2 vUv;
                varying vec3 vNormal;
                varying vec3 vViewPosition;
                void main() {
                    vUv = uv;
                    vNormal = normalize(normalMatrix * normal);
                    vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
                    vViewPosition = -mvPosition.xyz;
                    gl_Position = projectionMatrix * mvPosition;
                }
            `,
            fragmentShader: `
                uniform float uTime;
                uniform vec3 uColor;
                uniform float uIntensity;
                uniform float uShimmerSpeed;
                varying vec2 vUv;
                varying vec3 vNormal;
                varying vec3 vViewPosition;
                void main() {
                    // View-dependent rim / Fresnel falloff to eliminate hard geometric mesh edges
                    vec3 viewDir = normalize(vViewPosition);
                    float rim = abs(dot(vNormal, viewDir));
                    float edgeFade = smoothstep(0.0, 0.45, rim);

                    // Smooth vertical falloff from sun source (vUv.y = 0) towards ground
                    float vFade = smoothstep(0.0, 0.12, vUv.y) * pow(1.0 - vUv.y, 1.3);

                    // Atmospheric shimmer
                    float shimmer = 0.88 + 0.12 * sin(uTime * uShimmerSpeed + vUv.x * 12.56 + vUv.y * 6.28);

                    // Ethereal, balanced per-shaft opacity
                    float alpha = vFade * edgeFade * shimmer * (uIntensity * 0.22);
                    gl_FragColor = vec4(uColor, alpha);
                }
            `,
            transparent: true,
            blending: THREE.AdditiveBlending,
            side: THREE.FrontSide,
            depthWrite: false,
            depthTest: config.depthTest ?? true
        });

        this.buildRays();
        this.scene.add(this.group);
    }

    private buildRays(): void {
        while (this.group.children.length > 0) {
            this.group.remove(this.group.children[0]);
        }

        for (let i = 0; i < this.rayCount; i++) {
            const ray = new THREE.Mesh(this.rayGeometry, this.rayMaterial);
            const angle = (i / this.rayCount) * Math.PI * 2 + (i % 2 === 0 ? 0.15 : -0.15);
            const radialOffset = this.spreadRadius * (0.6 + (i % 3) * 0.25);

            ray.position.set(
                this.sunPos.x * 0.75 + Math.cos(angle) * radialOffset,
                this.sunPos.y * 0.75 + Math.sin(angle * 2.0) * 1.5,
                this.sunPos.z * 0.75 + Math.sin(angle) * radialOffset
            );

            const targetX = (Math.cos(angle) - 0.5) * 12.0;
            const targetZ = (Math.sin(angle) - 0.5) * 12.0;
            ray.lookAt(targetX, 0, targetZ);
            ray.rotateX(Math.PI / 2);

            ray.rotation.z += (i % 2 === 0 ? 0.08 : -0.08);
            this.group.add(ray);
        }
    }

    public update(time: number, _delta?: number): void {
        this.rayMaterial.uniforms.uTime.value = time;
    }

    public setSunPosition(sunPosition: THREE.Vector3): void {
        this.sunPos.copy(sunPosition);
        this.buildRays();
    }

    public setColor(color: number | string): void {
        if (typeof color === 'string') {
            this.rayMaterial.uniforms.uColor.value.set(color);
        } else {
            this.rayMaterial.uniforms.uColor.value.setHex(color);
        }
    }

    public setIntensity(intensity: number): void {
        this.rayMaterial.uniforms.uIntensity.value = intensity;
    }

    public dispose(): void {
        this.scene.remove(this.group);
        this.rayGeometry.dispose();
        this.rayMaterial.dispose();
    }
}

/**
 * Functional factory conforming to the legacy createVolumetricGodRays signature.
 */
export const createVolumetricGodRays = (
    scene: THREE.Scene,
    sunPosition: THREE.Vector3 = new THREE.Vector3(40, 60, 40),
    isSunset: boolean = false,
    config: VolumetricGodRaysConfig = {}
): VolumetricGodRaysModule => {
    return new VolumetricGodRays(scene, sunPosition, isSunset, config);
};
