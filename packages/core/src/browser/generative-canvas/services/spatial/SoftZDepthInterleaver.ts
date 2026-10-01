/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import * as THREE from 'three';

export interface SoftZInterleaverOptions {
  renderer: THREE.WebGLRenderer;
  width?: number;
  height?: number;
  defaultEpsilonMeters?: number;
}

/**
 * GLSL Shader Chunk implementing Soft-Z depth attenuation for 3D Gaussian Splats
 * and volumetric media against Google Photorealistic 3D Tiles.
 */
export const SOFT_Z_SHADER_CHUNK = /* glsl */ `
#ifdef USE_SOFT_Z
  uniform sampler2D uGoogleTileDepth;
  uniform vec2 uViewportSize;
  uniform float uNear;
  uniform float uFar;
  uniform float uSoftDepthEpsilon; // Depth fade softness in meters

  varying float vLinearDepth;

  float linearizeTileDepth(float rawDepth) {
    return (uNear * uFar) / (uFar - rawDepth * (uFar - uNear));
  }

  float computeSoftZFactor(vec2 fragCoord, float splatLinearDepth) {
    vec2 screenUv = fragCoord / uViewportSize;
    float rawTileDepth = texture2D(uGoogleTileDepth, screenUv).r;
    
    // 1.0 in depth buffer means no tile geometry was hit (sky/infinite background)
    if (rawTileDepth >= 0.9999) {
      return 1.0;
    }

    float linearTileDepth = linearizeTileDepth(rawTileDepth);
    float deltaZ = linearTileDepth - splatLinearDepth;

    // Soft fade transition over [-epsilon, +epsilon]
    float softFactor = clamp((deltaZ + uSoftDepthEpsilon) / (2.0 * uSoftDepthEpsilon), 0.0, 1.0);
    return softFactor;
  }
#endif
`;

/**
 * Dual-Pass G-Buffer Depth Interleaver.
 *
 * Pre-renders Google 3D Tiles into an off-screen depth texture, then supplies it
 * to Gaussian Splat shaders to achieve organic, seamless edge-blending without
 * polygonal clipping artifacts or depth fighting.
 */
export class SoftZDepthInterleaver {
  private renderer: THREE.WebGLRenderer;
  private depthRenderTarget: THREE.WebGLRenderTarget | null = null;
  private width: number;
  private height: number;
  private epsilonMeters: number;

  constructor(options: SoftZInterleaverOptions) {
    this.renderer = options.renderer;
    this.width = options.width || 1920;
    this.height = options.height || 1080;
    this.epsilonMeters = options.defaultEpsilonMeters ?? 0.05; // 5 cm default softness

    this.initRenderTarget();
  }

  private initRenderTarget(): void {
    if (this.depthRenderTarget) {
      this.depthRenderTarget.dispose();
    }

    // High-precision depth texture attachment
    const depthTexture = new THREE.DepthTexture(this.width, this.height);
    depthTexture.type = THREE.UnsignedIntType;
    depthTexture.format = THREE.DepthFormat;

    this.depthRenderTarget = new THREE.WebGLRenderTarget(this.width, this.height, {
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      format: THREE.RGBAFormat,
      type: THREE.UnsignedByteType,
      depthTexture
    });
  }

  public resize(width: number, height: number): void {
    if (width <= 0 || height <= 0) return;
    if (this.width === width && this.height === height) return;
    this.width = width;
    this.height = height;
    this.initRenderTarget();
  }

  public setEpsilonMeters(epsilon: number): void {
    this.epsilonMeters = Math.max(0.001, epsilon);
  }

  public getEpsilonMeters(): number {
    return this.epsilonMeters;
  }

  public getDepthTexture(): THREE.DepthTexture | null {
    return this.depthRenderTarget?.depthTexture ?? null;
  }

  /**
   * Pre-Pass 1: Renders the Google 3D Tiles scene hierarchy into the offscreen depth target.
   * Call this before rendering the Gaussian Splat layer.
   */
  public renderTileDepthPrePass(tileScene: THREE.Object3D, camera: THREE.Camera): void {
    if (!this.depthRenderTarget) return;

    const currentRenderTarget = this.renderer.getRenderTarget();
    const currentAutoClear = this.renderer.autoClear;

    this.renderer.setRenderTarget(this.depthRenderTarget);
    this.renderer.clear(true, true, false);

    // Render tile geometry only
    this.renderer.render(tileScene as THREE.Scene, camera);

    // Restore previous renderer state
    this.renderer.setRenderTarget(currentRenderTarget);
    this.renderer.autoClear = currentAutoClear;
  }

  /**
   * Augments a custom ShaderMaterial with Soft-Z uniforms and defines.
   */
  public injectSoftZUniforms(
    material: THREE.ShaderMaterial,
    camera: THREE.PerspectiveCamera,
    epsilonMeters?: number
  ): void {
    material.defines = material.defines || {};
    material.defines.USE_SOFT_Z = 1;

    material.uniforms.uGoogleTileDepth = { value: this.getDepthTexture() };
    material.uniforms.uViewportSize = { value: new THREE.Vector2(this.width, this.height) };
    material.uniforms.uNear = { value: camera.near };
    material.uniforms.uFar = { value: camera.far };
    material.uniforms.uSoftDepthEpsilon = { value: epsilonMeters ?? this.epsilonMeters };
  }

  /**
   * Evaluates the mathematical Soft-Z depth factor analytically on CPU/test-runners.
   */
  public static evaluateSoftZFactor(
    linearTileDepth: number,
    linearSplatDepth: number,
    epsilonMeters: number
  ): number {
    const deltaZ = linearTileDepth - linearSplatDepth;
    return Math.max(0.0, Math.min(1.0, (deltaZ + epsilonMeters) / (2.0 * epsilonMeters)));
  }

  public dispose(): void {
    if (this.depthRenderTarget) {
      this.depthRenderTarget.dispose();
      this.depthRenderTarget = null;
    }
  }
}
