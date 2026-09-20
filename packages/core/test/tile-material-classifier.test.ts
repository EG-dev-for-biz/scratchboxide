/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import {
  injectTileMaterialClassifier,
  CLASSIFIER_SHADER_CHUNK,
  BUMP_NORMAL_SHADER_CHUNK
} from '../src/browser/generative-canvas/services/TileMaterialClassifier';
import {
  ScreenSpaceReflectionPass,
  ScreenSpaceReflectionShader
} from '../src/browser/generative-canvas/services/ScreenSpaceReflectionEffect';

describe('TileMaterialClassifier & ScreenSpaceReflectionEffect', () => {
  it('should export valid GLSL shader chunks for classification and normal perturbation', () => {
    expect(CLASSIFIER_SHADER_CHUNK).toContain('classifyTileMaterial');
    expect(CLASSIFIER_SHADER_CHUNK).toContain('MaterialClass');
    expect(BUMP_NORMAL_SHADER_CHUNK).toContain('perturbNormalFromLuminance');
    expect(BUMP_NORMAL_SHADER_CHUNK).toContain('dFdx');
  });

  it('should inject classification uniforms and fragment hooks into Three.js MeshStandardMaterial', () => {
    const mat = new THREE.MeshStandardMaterial({
      color: 0x888888,
      roughness: 0.8,
      metalness: 0.1
    });

    const uniforms = injectTileMaterialClassifier(mat, {
      uWeatherRain: { value: 0.75 }
    });

    expect(uniforms.uWeatherRain.value).toBe(0.75);
    expect(uniforms.uBumpStrength.value).toBe(0.8);
    expect(mat.onBeforeCompile).toBeDefined();

    // Simulate Three.js shader compilation
    const mockShader = {
      uniforms: {} as any,
      fragmentShader: `
        #include <roughnessmap_fragment>
        #include <metalnessmap_fragment>
      `
    };

    mat.onBeforeCompile(mockShader);

    expect(mockShader.uniforms.uWeatherRain).toBeDefined();
    expect(mockShader.uniforms.uWeatherRain.value).toBe(0.75);
    expect(mockShader.fragmentShader).toContain('classifyTileMaterial');
    expect(mockShader.fragmentShader).toContain('uWeatherRain');
    expect(mockShader.fragmentShader).toContain('metalnessFactor = classified.metalness');
  });

  it('should initialize ScreenSpaceReflectionPass and manage dynamic wetness parameters', () => {
    const pass = new ScreenSpaceReflectionPass({
      intensity: 0.9,
      wetness: 0.85,
      horizonLine: 0.52
    });

    const mat = pass.getMaterial();
    expect(mat).toBeInstanceOf(THREE.ShaderMaterial);
    expect(mat.uniforms.uIntensity.value).toBe(0.9);
    expect(mat.uniforms.uWetness.value).toBe(0.85);
    expect(mat.uniforms.uHorizonLine.value).toBe(0.52);

    pass.setWetness(0.2);
    expect(mat.uniforms.uWetness.value).toBe(0.2);

    pass.updateTime(0.016);
    expect(mat.uniforms.uTime.value).toBeCloseTo(0.016, 3);

    expect(() => pass.dispose()).not.toThrow();
  });

  it('should contain complete SSR shader definitions with ripple distortion and blur kernel', () => {
    expect(ScreenSpaceReflectionShader.vertexShader).toContain('gl_Position');
    expect(ScreenSpaceReflectionShader.fragmentShader).toContain('noise(');
    expect(ScreenSpaceReflectionShader.fragmentShader).toContain('uRippleSpeed');
    expect(ScreenSpaceReflectionShader.fragmentShader).toContain('uHighlightBoost');
  });
});
