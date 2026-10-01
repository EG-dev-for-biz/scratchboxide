/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import * as THREE from 'three';
import { AdaptiveWorldStyleContract } from '../../../../common/spatial/adaptive-style-contract';

export class AdaptiveStyleComposer {
  private material: THREE.ShaderMaterial;
  private quadScene: THREE.Scene;
  private quadCamera: THREE.OrthographicCamera;
  private quadMesh: THREE.Mesh;
  private currentContract: AdaptiveWorldStyleContract;

  constructor(styleContract: AdaptiveWorldStyleContract) {
    this.currentContract = JSON.parse(JSON.stringify(styleContract));

    // Simple fullscreen quad setup
    this.quadScene = new THREE.Scene();
    this.quadCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    const quadGeo = new THREE.PlaneGeometry(2, 2);

    this.material = new THREE.ShaderMaterial({
      uniforms: {
        tDiffuse: { value: null },
        uResolution: { value: new THREE.Vector2(1024, 768) },

        // Photometric & Grading
        uGradeLift: {
          value: new THREE.Vector3(
            styleContract.photometric.colorGradingWheel.lift.r,
            styleContract.photometric.colorGradingWheel.lift.g,
            styleContract.photometric.colorGradingWheel.lift.b
          )
        },
        uGradeGamma: {
          value: new THREE.Vector3(
            styleContract.photometric.colorGradingWheel.gamma.r,
            styleContract.photometric.colorGradingWheel.gamma.g,
            styleContract.photometric.colorGradingWheel.gamma.b
          )
        },
        uGradeGain: {
          value: new THREE.Vector3(
            styleContract.photometric.colorGradingWheel.gain.r,
            styleContract.photometric.colorGradingWheel.gain.g,
            styleContract.photometric.colorGradingWheel.gain.b
          )
        },

        // Outlines
        uContoursEnabled: { value: styleContract.geometricContours.enabled ? 1.0 : 0.0 },
        uLineWidth: { value: styleContract.geometricContours.lineWidth },
        uDepthThreshold: { value: styleContract.geometricContours.depthThreshold },
        uInkColor: { value: new THREE.Vector3(...styleContract.geometricContours.inkColor) },
        uJitter: { value: styleContract.geometricContours.jitter },

        // Filters
        uKuwaharaRadius: { value: styleContract.stylizationFilter.kuwaharaRadius },
        uHalftoneDensity: { value: styleContract.stylizationFilter.halftoneDensity },
        uDitherSize: { value: styleContract.stylizationFilter.ditherMatrixSize },
        uTime: { value: 0.0 }
      },
      vertexShader: `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        uniform sampler2D tDiffuse;
        uniform vec2 uResolution;
        
        uniform vec3 uGradeLift;
        uniform vec3 uGradeGamma;
        uniform vec3 uGradeGain;

        uniform float uContoursEnabled;
        uniform float uLineWidth;
        uniform float uDepthThreshold;
        uniform vec3 uInkColor;
        uniform float uJitter;

        uniform float uKuwaharaRadius;
        uniform float uHalftoneDensity;
        uniform float uDitherSize;
        uniform float uTime;

        varying vec2 vUv;

        // 4x4 Bayer Ordered Dither Matrix
        float getBayerThreshold(int x, int y) {
          int index = x + y * 4;
          if (index == 0) return 0.0625;
          if (index == 1) return 0.5625;
          if (index == 2) return 0.1875;
          if (index == 3) return 0.6875;
          if (index == 4) return 0.8125;
          if (index == 5) return 0.3125;
          if (index == 6) return 0.9375;
          if (index == 7) return 0.4375;
          if (index == 8) return 0.25;
          if (index == 9) return 0.75;
          if (index == 10) return 0.125;
          if (index == 11) return 0.625;
          if (index == 12) return 0.999;
          if (index == 13) return 0.499;
          if (index == 14) return 0.875;
          return 0.375;
        }

        // Color grade lift/gamma/gain curve
        vec3 sbPostColorGrade(vec3 rgb, vec3 lift, vec3 gamma, vec3 gain) {
          vec3 l = lift * 0.15;
          vec3 res = rgb + l * (1.0 - rgb);
          res = pow(max(vec3(0.0), res), 1.0 / max(vec3(1e-3), gamma));
          return clamp(res * gain, 0.0, 1.0);
        }

        // Sobel Edge Detection
        float getLuma(vec2 uv) {
          return dot(texture2D(tDiffuse, uv).rgb, vec3(0.299, 0.587, 0.114));
        }

        float getSobelOutline(vec2 uv) {
          vec2 texel = 1.0 / uResolution;
          float w = uLineWidth;

          float t00 = getLuma(uv + vec2(-w, -w) * texel);
          float t10 = getLuma(uv + vec2(0.0, -w) * texel);
          float t20 = getLuma(uv + vec2(w, -w) * texel);
          float t01 = getLuma(uv + vec2(-w, 0.0) * texel);
          float t21 = getLuma(uv + vec2(w, 0.0) * texel);
          float t02 = getLuma(uv + vec2(-w, w) * texel);
          float t12 = getLuma(uv + vec2(0.0, w) * texel);
          float t22 = getLuma(uv + vec2(w, w) * texel);

          float gx = (t20 + 2.0 * t21 + t22) - (t00 + 2.0 * t01 + t02);
          float gy = (t02 + 2.0 * t12 + t22) - (t00 + 2.0 * t10 + t20);
          float g = sqrt(gx * gx + gy * gy);

          return smoothstep(uDepthThreshold - 0.02, uDepthThreshold + 0.08, g);
        }

        void main() {
          vec2 uv = vUv;

          // Introduce subtle hand-drawn wobble if jitter is enabled
          if (uJitter > 0.01) {
            float wobble = sin(uv.y * 120.0 + uTime * 4.0) * cos(uv.x * 90.0 + uTime * 3.5) * 0.0015 * uJitter;
            uv += vec2(wobble);
          }

          vec4 col = texture2D(tDiffuse, uv);
          vec3 finalRgb = col.rgb;

          // 1. Anisotropic Kuwahara-like Painterly Pass
          if (uKuwaharaRadius > 0.5) {
            int r = int(uKuwaharaRadius);
            vec2 texel = 1.0 / uResolution;

            vec3 m0 = vec3(0.0); vec3 m1 = vec3(0.0); vec3 m2 = vec3(0.0); vec3 m3 = vec3(0.0);
            vec3 s0 = vec3(0.0); vec3 s1 = vec3(0.0); vec3 s2 = vec3(0.0); vec3 s3 = vec3(0.0);

            float n = float((r + 1) * (r + 1));

            // Quadrant 1
            for (int j = -8; j <= 0; ++j) {
              if (j < -r) continue;
              for (int i = -8; i <= 0; ++i) {
                if (i < -r) continue;
                vec3 c = texture2D(tDiffuse, uv + vec2(float(i), float(j)) * texel).rgb;
                m0 += c;
                s0 += c * c;
              }
            }
            // Quadrant 2
            for (int j = -8; j <= 0; ++j) {
              if (j < -r) continue;
              for (int i = 0; i <= 8; ++i) {
                if (i > r) break;
                vec3 c = texture2D(tDiffuse, uv + vec2(float(i), float(j)) * texel).rgb;
                m1 += c;
                s1 += c * c;
              }
            }
            // Quadrant 3
            for (int j = 0; j <= 8; ++j) {
              if (j > r) break;
              for (int i = 0; i <= 8; ++i) {
                if (i > r) break;
                vec3 c = texture2D(tDiffuse, uv + vec2(float(i), float(j)) * texel).rgb;
                m2 += c;
                s2 += c * c;
              }
            }
            // Quadrant 4
            for (int j = 0; j <= 8; ++j) {
              if (j > r) break;
              for (int i = -8; i <= 0; ++i) {
                if (i < -r) continue;
                vec3 c = texture2D(tDiffuse, uv + vec2(float(i), float(j)) * texel).rgb;
                m3 += c;
                s3 += c * c;
              }
            }

            m0 /= n; s0 = abs(s0 / n - m0 * m0); float var0 = s0.r + s0.g + s0.b;
            m1 /= n; s1 = abs(s1 / n - m1 * m1); float var1 = s1.r + s1.g + s1.b;
            m2 /= n; s2 = abs(s2 / n - m2 * m2); float var2 = s2.r + s2.g + s2.b;
            m3 /= n; s3 = abs(s3 / n - m3 * m3); float var3 = s3.r + s3.g + s3.b;

            float minVar = var0;
            finalRgb = m0;
            if (var1 < minVar) { minVar = var1; finalRgb = m1; }
            if (var2 < minVar) { minVar = var2; finalRgb = m2; }
            if (var3 < minVar) { minVar = var3; finalRgb = m3; }
          }

          // 2. Halftone Screen Pass
          if (uHalftoneDensity > 0.5) {
            float size = uHalftoneDensity;
            vec2 center = floor(gl_FragCoord.xy / size) * size + vec2(size * 0.5);
            vec3 cellColor = texture2D(tDiffuse, center / uResolution).rgb;
            float luma = dot(cellColor, vec3(0.299, 0.587, 0.114));

            float dist = distance(gl_FragCoord.xy, center);
            float maxRadius = size * 0.5;
            float dotRadius = maxRadius * (1.0 - luma);
            float dotFactor = smoothstep(dotRadius - 0.5, dotRadius + 0.5, dist);

            finalRgb = mix(finalRgb * 0.25, finalRgb, dotFactor);
          }

          // 3. Ordered Bayer Dithering
          if (uDitherSize > 0.5) {
            int px = int(mod(gl_FragCoord.x, 4.0));
            int py = int(mod(gl_FragCoord.y, 4.0));
            float threshold = getBayerThreshold(px, py);

            float currentLuma = dot(finalRgb, vec3(0.299, 0.587, 0.114));
            float ditherFactor = currentLuma > threshold ? 1.12 : 0.65;
            finalRgb = finalRgb * ditherFactor;
          }

          // 4. Color Grading Wheels
          finalRgb = sbPostColorGrade(finalRgb, uGradeLift, uGradeGamma, uGradeGain);

          // 5. Outline / Ink Border Overlays
          if (uContoursEnabled > 0.5) {
            float edge = getSobelOutline(uv);
            finalRgb = mix(finalRgb, uInkColor, edge * 0.85);
          }

          gl_FragColor = vec4(finalRgb, col.a);
        }
      `
    });

    this.quadMesh = new THREE.Mesh(quadGeo, this.material);
    this.quadScene.add(this.quadMesh);
  }

  /**
   * Main render call: executes the composed screen-space passes.
   */
  public render(
    renderer: THREE.WebGLRenderer,
    readBuffer: THREE.WebGLRenderTarget,
    writeBuffer: THREE.WebGLRenderTarget | null,
    deltaTime: number = 0.016
  ): void {
    this.material.uniforms.tDiffuse.value = readBuffer.texture;
    this.material.uniforms.uTime.value += deltaTime;

    const size = new THREE.Vector2();
    renderer.getSize(size);
    this.material.uniforms.uResolution.value.copy(size);

    renderer.setRenderTarget(writeBuffer);
    renderer.render(this.quadScene, this.quadCamera);
  }

  /**
   * Instantly re-configures style uniforms on the composer.
   */
  public updateStyle(styleContract: AdaptiveWorldStyleContract): void {
    this.currentContract = JSON.parse(JSON.stringify(styleContract));

    this.material.uniforms.uGradeLift.value.set(
      styleContract.photometric.colorGradingWheel.lift.r,
      styleContract.photometric.colorGradingWheel.lift.g,
      styleContract.photometric.colorGradingWheel.lift.b
    );
    this.material.uniforms.uGradeGamma.value.set(
      styleContract.photometric.colorGradingWheel.gamma.r,
      styleContract.photometric.colorGradingWheel.gamma.g,
      styleContract.photometric.colorGradingWheel.gamma.b
    );
    this.material.uniforms.uGradeGain.value.set(
      styleContract.photometric.colorGradingWheel.gain.r,
      styleContract.photometric.colorGradingWheel.gain.g,
      styleContract.photometric.colorGradingWheel.gain.b
    );

    this.material.uniforms.uContoursEnabled.value = styleContract.geometricContours.enabled ? 1.0 : 0.0;
    this.material.uniforms.uLineWidth.value = styleContract.geometricContours.lineWidth;
    this.material.uniforms.uDepthThreshold.value = styleContract.geometricContours.depthThreshold;
    this.material.uniforms.uInkColor.value.set(...styleContract.geometricContours.inkColor);
    this.material.uniforms.uJitter.value = styleContract.geometricContours.jitter;

    this.material.uniforms.uKuwaharaRadius.value = styleContract.stylizationFilter.kuwaharaRadius;
    this.material.uniforms.uHalftoneDensity.value = styleContract.stylizationFilter.halftoneDensity;
    this.material.uniforms.uDitherSize.value = styleContract.stylizationFilter.ditherMatrixSize;
  }

  public dispose(): void {
    this.material.dispose();
    this.quadMesh.geometry.dispose();
  }
}
