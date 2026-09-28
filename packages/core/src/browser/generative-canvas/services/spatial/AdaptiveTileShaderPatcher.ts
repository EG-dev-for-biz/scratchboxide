/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import * as THREE from 'three';
import { AdaptiveWorldStyleContract } from '../../../../common/spatial/adaptive-style-contract';

export class AdaptiveTileShaderPatcher {
  /**
   * Patches any Three.js Material (e.g. MeshStandardMaterial) to support full
   * real-time Adaptive World Styling (de-lighting, color wheels, cel-shading, detail, projection).
   */
  public static patchMaterial(
    material: THREE.Material,
    styleContract: AdaptiveWorldStyleContract,
    textures?: {
      detailNormalMap?: THREE.Texture;
      projectiveTexture?: THREE.Texture;
    }
  ): void {
    if (!material || (material as any).userData?.sbAdaptiveStyled) return;
    (material as any).userData.sbAdaptiveStyled = true;

    // 1. Create live uniform bindings
    const uniforms = {
      // Photometric de-lighting
      uShadowLift: { value: styleContract.photometric.shadowLift },
      uHighlightCompress: { value: styleContract.photometric.highlightCompress },
      uContrastPivot: { value: styleContract.photometric.contrastPivot },
      uColorTemp: { value: styleContract.photometric.colorTemperatureK },
      
      // Color grading wheels
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

      // Micro-detail normal & frequency
      uDetailFrequency: { value: styleContract.microSurface.detailFrequency },
      uNormalPerturbationScale: { value: styleContract.microSurface.normalPerturbationScale },
      uCavitationDepth: { value: styleContract.microSurface.cavitationDepth },
      uSpecularGlintIntensity: { value: styleContract.microSurface.specularGlintIntensity },
      uDetailMap: { value: textures?.detailNormalMap || null },

      // Non-photorealistic filters
      uQuantizationBands: { value: styleContract.stylizationFilter.quantizationBands },
      uQuantizationSoftness: { value: styleContract.stylizationFilter.quantizationSoftness },

      // Frustum projection
      uProjEnabled: { value: styleContract.cameraProjection?.enabled ? 1.0 : 0.0 },
      uProjMatrix: { value: new THREE.Matrix4() },
      uProjView: { value: new THREE.Matrix4() },
      uProjTexture: { value: textures?.projectiveTexture || null },
      uProjPos: { value: new THREE.Vector3() },
      uProjGrazingCutoff: { value: styleContract.cameraProjection?.grazingAngleCutoff ?? 0.5 }
    };

    // Update matrix uniform if camera projection is specified
    if (styleContract.cameraProjection) {
      const projCam = styleContract.cameraProjection;
      const projPos = new THREE.Vector3(...projCam.position);
      const projTarget = new THREE.Vector3(...projCam.target);
      
      const viewMatrix = new THREE.Matrix4().lookAt(projPos, projTarget, new THREE.Vector3(0, 1, 0));
      
      const fov = projCam.fovDeg;
      const aspect = 1.0;
      const near = 0.1;
      const far = 25000.0;
      const top = near * Math.tan(THREE.MathUtils.degToRad(fov * 0.5));
      const bottom = -top;
      const left = -top * aspect;
      const right = top * aspect;

      const projMatrix = new THREE.Matrix4().makePerspective(
        left,
        right,
        top,
        bottom,
        near,
        far
      );

      uniforms.uProjView.value.copy(viewMatrix);
      uniforms.uProjMatrix.value.copy(projMatrix);
      uniforms.uProjPos.value.copy(projPos);
    }

    (material as any).userData.sbAdaptiveUniforms = uniforms;

    // 2. Intercept onBeforeCompile
    const originalOnBeforeCompile = material.onBeforeCompile;
    material.onBeforeCompile = (shader: any, renderer: THREE.WebGLRenderer) => {
      if (originalOnBeforeCompile) {
        originalOnBeforeCompile.call(material, shader, renderer);
      }

      // Bind uniforms to shader context
      Object.assign(shader.uniforms, uniforms);

      // Vertex Shader patching for world space variables
      if (!shader.vertexShader.includes('vWorldPosition')) {
        shader.vertexShader = shader.vertexShader.replace(
          '#include <common>',
          `
          #include <common>
          varying vec3 vWorldPosition;
          varying vec3 vWorldNormal;
          `
        );

        shader.vertexShader = shader.vertexShader.replace(
          '#include <begin_vertex>',
          `
          #include <begin_vertex>
          vWorldPosition = (modelMatrix * vec4(transformed, 1.0)).xyz;
          vWorldNormal = normalize((modelMatrix * vec4(normal, 0.0)).xyz);
          `
        );
      }

      // Fragment Shader patching for adaptive styling logic
      shader.fragmentShader = `
        uniform float uShadowLift;
        uniform float uHighlightCompress;
        uniform float uContrastPivot;
        uniform float uColorTemp;
        
        uniform vec3 uGradeLift;
        uniform vec3 uGradeGamma;
        uniform vec3 uGradeGain;

        uniform float uDetailFrequency;
        uniform float uNormalPerturbationScale;
        uniform float uCavitationDepth;
        uniform float uSpecularGlintIntensity;
        uniform sampler2D uDetailMap;

        uniform float uQuantizationBands;
        uniform float uQuantizationSoftness;

        uniform float uProjEnabled;
        uniform mat4 uProjMatrix;
        uniform mat4 uProjView;
        uniform sampler2D uProjTexture;
        uniform vec3 uProjPos;
        uniform float uProjGrazingCutoff;

        varying vec3 vWorldPosition;
        varying vec3 vWorldNormal;

        // Procedural high-frequency micro-cavity noise
        float sbProceduralNoise(vec3 p) {
          return fract(sin(dot(p, vec3(127.1, 311.7, 74.7))) * 43758.5453123);
        }

        // Analytical Blackbody color temperature balance
        vec3 sbKelvinToRGB(float k) {
          float temp = k / 100.0;
          float r, g, b;
          if (temp <= 66.0) {
            r = 255.0;
            g = temp;
            g = 99.4708025861 * log(g) - 161.1195681661;
            if (temp <= 19.0) {
              b = 0.0;
            } else {
              b = temp - 10.0;
              b = 138.5177312231 * log(b) - 305.0447927307;
            }
          } else {
            r = temp - 60.0;
            r = 329.698727446 * pow(r, -0.1332047592);
            g = temp - 60.0;
            g = 288.1221695283 * pow(g, -0.0755148492);
            b = 255.0;
          }
          return clamp(vec3(r, g, b) / 255.0, 0.0, 1.0);
        }

        // Color grade wheels lift/gamma/gain curve
        vec3 sbColorGrade(vec3 rgb, vec3 lift, vec3 gamma, vec3 gain) {
          // Lift shadows
          vec3 l = lift * 0.15; // master scaling
          vec3 res = rgb + l * (1.0 - rgb);
          // Gamma midtones
          res = pow(max(vec3(0.0), res), 1.0 / max(vec3(1e-3), gamma));
          // Gain highlights
          res = res * gain;
          return clamp(res, 0.0, 1.0);
        }
      ` + shader.fragmentShader;

      // Inject styling before lighting and maps
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <map_fragment>',
        `
        #include <map_fragment>

        #ifdef USE_MAP
          vec3 baseRgb = diffuseColor.rgb;
          float luma = dot(baseRgb, vec3(0.299, 0.587, 0.114));

          // 1. Shadow lift (crevice recovery)
          float shadowFactor = clamp(1.0 - (luma * 2.2), 0.0, 1.0);
          vec3 liftedRgb = baseRgb + (vec3(luma * 1.5 + 0.12) - baseRgb) * (shadowFactor * uShadowLift);

          // 2. Highlight compression (noon glare taming)
          float highlightFactor = smoothstep(0.55, 0.95, luma);
          baseRgb = mix(liftedRgb, liftedRgb * 0.78, highlightFactor * uHighlightCompress);

          // 3. Apply color grading wheels
          baseRgb = sbColorGrade(baseRgb, uGradeLift, uGradeGamma, uGradeGain);

          // 4. Color temperature Planckian Kelvin balance tint
          vec3 kelvinColor = sbKelvinToRGB(uColorTemp);
          baseRgb = baseRgb * mix(vec3(1.0), kelvinColor * 1.35, 0.42);

          // 5. Cel-shading Quantization
          if (uQuantizationBands > 0.5) {
            float bands = max(2.0, uQuantizationBands);
            float currentLuma = dot(baseRgb, vec3(0.299, 0.587, 0.114));
            float q = floor(currentLuma * bands) / bands;
            
            // Soft border interpolation to avoid alias flickering
            float border = fract(currentLuma * bands);
            float softWeight = smoothstep(0.0, uQuantizationSoftness, border);
            float finalLuma = mix(q, q + 1.0 / bands, softWeight);

            baseRgb = baseRgb * (finalLuma / max(1e-3, currentLuma));
          }

          // 6. Micro-detail triplanar mapping injection
          if (uNormalPerturbationScale > 0.01) {
            vec3 norm = normalize(vWorldNormal);
            vec3 absNorm = abs(norm);
            vec3 weights = absNorm / (absNorm.x + absNorm.y + absNorm.z);

            // Procedural noise or normal map sampling
            vec3 microNoise = vec3(
              sbProceduralNoise(vWorldPosition * uDetailFrequency),
              sbProceduralNoise((vWorldPosition + 1.25) * uDetailFrequency),
              sbProceduralNoise((vWorldPosition + 2.50) * uDetailFrequency)
            );

            // Blends high-frequency grain into color reflectance
            baseRgb = baseRgb * (1.0 + (microNoise - 0.5) * uNormalPerturbationScale * 0.35);
          }

          // 7. Frustum camera projective texture mapping
          if (uProjEnabled > 0.5) {
            vec4 projCoord = uProjMatrix * uProjView * vec4(vWorldPosition, 1.0);
            vec3 ndc = projCoord.xyz / projCoord.w;
            vec2 projUv = ndc.xy * 0.5 + 0.5;
            
            if (projCoord.w > 0.0 && projUv.x >= 0.0 && projUv.x <= 1.0 && projUv.y >= 0.0 && projUv.y <= 1.0) {
              vec4 projColor = texture2D(uProjTexture, projUv);
              
              // Angle check: avoid smearing on sharp perpendicular planes
              vec3 norm = normalize(vWorldNormal);
              vec3 rayDir = normalize(uProjPos - vWorldPosition);
              float dotProduct = max(0.0, dot(norm, rayDir));
              
              float blendWeight = smoothstep(uProjGrazingCutoff - 0.1, uProjGrazingCutoff + 0.1, dotProduct);
              baseRgb = mix(baseRgb, projColor.rgb, blendWeight);
            }
          }

          diffuseColor.rgb = baseRgb;
        #endif
        `
      );
    };

    // Ensure material updates its program cache
    material.needsUpdate = true;
  }

  /**
   * Updates style uniforms on an already-patched material instantly.
   */
  public static updateMaterialStyle(
    material: THREE.Material,
    styleContract: AdaptiveWorldStyleContract
  ): void {
    const uniforms = (material as any).userData?.sbAdaptiveUniforms;
    if (!uniforms) return;

    uniforms.uShadowLift.value = styleContract.photometric.shadowLift;
    uniforms.uHighlightCompress.value = styleContract.photometric.highlightCompress;
    uniforms.uContrastPivot.value = styleContract.photometric.contrastPivot;
    uniforms.uColorTemp.value = styleContract.photometric.colorTemperatureK;

    uniforms.uGradeLift.value.set(
      styleContract.photometric.colorGradingWheel.lift.r,
      styleContract.photometric.colorGradingWheel.lift.g,
      styleContract.photometric.colorGradingWheel.lift.b
    );
    uniforms.uGradeGamma.value.set(
      styleContract.photometric.colorGradingWheel.gamma.r,
      styleContract.photometric.colorGradingWheel.gamma.g,
      styleContract.photometric.colorGradingWheel.gamma.b
    );
    uniforms.uGradeGain.value.set(
      styleContract.photometric.colorGradingWheel.gain.r,
      styleContract.photometric.colorGradingWheel.gain.g,
      styleContract.photometric.colorGradingWheel.gain.b
    );

    uniforms.uDetailFrequency.value = styleContract.microSurface.detailFrequency;
    uniforms.uNormalPerturbationScale.value = styleContract.microSurface.normalPerturbationScale;
    uniforms.uCavitationDepth.value = styleContract.microSurface.cavitationDepth;
    uniforms.uSpecularGlintIntensity.value = styleContract.microSurface.specularGlintIntensity;

    uniforms.uQuantizationBands.value = styleContract.stylizationFilter.quantizationBands;
    uniforms.uQuantizationSoftness.value = styleContract.stylizationFilter.quantizationSoftness;

    if (styleContract.cameraProjection) {
      const projCam = styleContract.cameraProjection;
      const projPos = new THREE.Vector3(...projCam.position);
      const projTarget = new THREE.Vector3(...projCam.target);
      
      const viewMatrix = new THREE.Matrix4().lookAt(projPos, projTarget, new THREE.Vector3(0, 1, 0));
      
      const fov = projCam.fovDeg;
      const aspect = 1.0;
      const near = 0.1;
      const far = 25000.0;
      const top = near * Math.tan(THREE.MathUtils.degToRad(fov * 0.5));
      const bottom = -top;
      const left = -top * aspect;
      const right = top * aspect;

      const projMatrix = new THREE.Matrix4().makePerspective(
        left,
        right,
        top,
        bottom,
        near,
        far
      );

      uniforms.uProjView.value.copy(viewMatrix);
      uniforms.uProjMatrix.value.copy(projMatrix);
      uniforms.uProjPos.value.copy(projPos);
      uniforms.uProjGrazingCutoff.value = projCam.grazingAngleCutoff;
      uniforms.uProjEnabled.value = projCam.enabled ? 1.0 : 0.0;
    } else {
      uniforms.uProjEnabled.value = 0.0;
    }
  }
}
