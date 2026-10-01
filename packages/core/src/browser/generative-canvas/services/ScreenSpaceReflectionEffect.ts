/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import * as THREE from 'three';

export interface ScreenSpaceReflectionOptions {
  intensity?: number;
  wetness?: number;
  roughness?: number;
  horizonLine?: number;
  rippleSpeed?: number;
  highlightBoost?: number;
}

/**
 * GLSL Shader definition for Screen-Space Planar Reflection approximating wet surfaces and rain puddles.
 */
export const ScreenSpaceReflectionShader = {
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    uIntensity: { value: 0.85 },
    uWetness: { value: 0.8 },
    uRoughness: { value: 0.25 },
    uTime: { value: 0.0 },
    uHorizonLine: { value: 0.55 },
    uRippleSpeed: { value: 1.0 },
    uHighlightBoost: { value: 1.4 },
    uGroundFadeBottom: { value: 0.05 }
  },

  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = vec4(position, 1.0);
    }
  `,

  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float uIntensity;
    uniform float uWetness;
    uniform float uRoughness;
    uniform float uTime;
    uniform float uHorizonLine;
    uniform float uRippleSpeed;
    uniform float uHighlightBoost;
    uniform float uGroundFadeBottom;

    varying vec2 vUv;

    float hash(vec2 p) {
      return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
    }

    float noise(vec2 p) {
      vec2 i = floor(p);
      vec2 f = fract(p);
      vec2 u = f * f * (3.0 - 2.0 * f);
      return mix(mix(hash(i + vec2(0.0, 0.0)), hash(i + vec2(1.0, 0.0)), u.x),
                 mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);
    }

    void main() {
      vec4 inputColor = texture2D(tDiffuse, vUv);
      vec3 col = inputColor.rgb;

      if (uIntensity <= 0.001 || uWetness <= 0.001) {
        gl_FragColor = inputColor;
        return;
      }

      float horizon = uHorizonLine;
      if (vUv.y < horizon) {
        float groundWeight = smoothstep(horizon, uGroundFadeBottom, vUv.y);

        // Animated multi-frequency ripple noise
        vec2 noiseUV1 = vUv * vec2(30.0, 120.0);
        noiseUV1.y += uTime * 0.9 * uRippleSpeed;
        vec2 noiseUV2 = vUv * vec2(50.0, 180.0);
        noiseUV2.y -= uTime * 1.3 * uRippleSpeed;

        float waveNoise = mix(noise(noiseUV1), noise(noiseUV2), 0.5);

        float distortStrength = 0.015 * uWetness * (1.0 - uRoughness * 0.5);
        float distort = (waveNoise - 0.5) * distortStrength;

        // Planar reflection mirroring across horizon
        float mirrorDist = horizon - vUv.y;
        float mirrorY = clamp(horizon + mirrorDist * 1.15, 0.0, 1.0);

        vec2 reflectUV = vec2(clamp(vUv.x + distort, 0.0, 1.0), mirrorY);

        // 5-tap glossy roughness blur
        vec3 reflectedColor = vec3(0.0);
        float totalWeight = 0.0;
        float blurSize = 0.02 * uRoughness * (1.0 - vUv.y * 0.35);

        for (int i = -2; i <= 2; ++i) {
          float offset = float(i) * blurSize;
          vec2 sampleUV = clamp(reflectUV + vec2(offset * 0.3, offset), 0.0, 1.0);
          float w = 1.0 - abs(float(i)) * 0.22;
          reflectedColor += texture2D(tDiffuse, sampleUV).rgb * w;
          totalWeight += w;
        }
        reflectedColor /= max(totalWeight, 0.001);

        // Darken wet pavement albedo
        vec3 wetBaseColor = col * mix(1.0, 0.28, uWetness);

        // Specular highlight boost for reflections (streetlights, bright sky)
        float reflectionStrength = uIntensity * groundWeight * uWetness;
        vec3 finalCol = mix(wetBaseColor, reflectedColor, reflectionStrength);

        float luma = dot(reflectedColor, vec3(0.2126, 0.7152, 0.0722));
        if (luma > 0.5) {
          finalCol += reflectedColor * uHighlightBoost * reflectionStrength * smoothstep(0.5, 1.0, luma);
        }

        col = finalCol;
      }

      gl_FragColor = vec4(col, inputColor.a);
    }
  `
};

/**
 * Self-contained Screen-Space Reflection composite pass.
 */
export class ScreenSpaceReflectionPass {
  private material: THREE.ShaderMaterial;
  private quadScene: THREE.Scene;
  private quadCamera: THREE.OrthographicCamera;
  private renderTarget: THREE.WebGLRenderTarget | null = null;

  constructor(options: ScreenSpaceReflectionOptions = {}) {
    this.material = new THREE.ShaderMaterial({
      uniforms: THREE.UniformsUtils.clone(ScreenSpaceReflectionShader.uniforms),
      vertexShader: ScreenSpaceReflectionShader.vertexShader,
      fragmentShader: ScreenSpaceReflectionShader.fragmentShader,
      depthTest: false,
      depthWrite: false
    });

    if (options.intensity !== undefined) this.material.uniforms.uIntensity.value = options.intensity;
    if (options.wetness !== undefined) this.material.uniforms.uWetness.value = options.wetness;
    if (options.roughness !== undefined) this.material.uniforms.uRoughness.value = options.roughness;
    if (options.horizonLine !== undefined) this.material.uniforms.uHorizonLine.value = options.horizonLine;
    if (options.rippleSpeed !== undefined) this.material.uniforms.uRippleSpeed.value = options.rippleSpeed;
    if (options.highlightBoost !== undefined) this.material.uniforms.uHighlightBoost.value = options.highlightBoost;

    this.quadScene = new THREE.Scene();
    this.quadCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.material);
    this.quadScene.add(quad);
  }

  setWetness(wetness: number): void {
    this.material.uniforms.uWetness.value = wetness;
  }

  updateTime(deltaSec: number): void {
    this.material.uniforms.uTime.value += deltaSec;
  }

  getMaterial(): THREE.ShaderMaterial {
    return this.material;
  }

  dispose(): void {
    this.material.dispose();
    if (this.renderTarget) {
      this.renderTarget.dispose();
    }
  }
}
