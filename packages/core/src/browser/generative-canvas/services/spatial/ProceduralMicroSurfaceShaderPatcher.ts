/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import * as THREE from 'three';

export type MicroSurfacePreset =
  | 'mudbrick_masonry'
  | 'stone_cavitation'
  | 'lapis_glaze'
  | 'hammered_metal'
  | 'alluvial_sand'
  | 'custom';

export interface MortarDeepeningConfig {
  enabled?: boolean;
  brickFrequencyY?: number;       // Horizontal course frequency (courses per meter, default 1.4)
  brickAspect?: number;           // Brick length to height aspect ratio (default 2.4)
  mortarWidth?: number;           // Mortar line thickness in normalized course unit (default 0.08)
  mortarDepth?: number;           // Luminance crevice darkening factor (default 0.45)
  mortarRoughness?: number;       // Roughness inside mortar joints (default 0.96)
  jointNormalBevel?: number;      // Normal beveling inward toward crevice (default 0.35)
}

export interface CavitationPoresConfig {
  enabled?: boolean;
  frequency?: number;             // 3D pore noise frequency (default 9.0)
  threshold?: number;             // Pore pit threshold (default 0.24)
  depth?: number;                 // Pore pit darkening factor (default 0.55)
  normalStrength?: number;        // Radial normal deflection into pit (default 0.40)
  roughnessBoost?: number;        // Increase in pore roughness (default 0.35)
}

export interface GlazeCrackleConfig {
  enabled?: boolean;
  crackleFrequency?: number;      // Voronoi crackle cell frequency (default 6.5)
  crackWidth?: number;            // Hairline crack width (default 0.045)
  crackDarkening?: number;        // Crack line darkening factor (default 0.70)
  glazeGlossRoughness?: number;   // Vitreous glass roughness inside cells (default 0.14)
  crackRoughness?: number;        // Roughness at crack boundaries (default 0.78)
  microCurvature?: number;        // Convex tile pillowed curvature (default 0.22)
}

export interface ProceduralMicroSurfaceConfig {
  preset?: MicroSurfacePreset;
  triplanarSharpness?: number;     // Blend exponent between X, Y, Z planes (default 4.0)
  mortarDeepening?: MortarDeepeningConfig;
  cavitationPores?: CavitationPoresConfig;
  glazeCrackle?: GlazeCrackleConfig;
  hammeredMetal?: {
    enabled?: boolean;
    frequency?: number;           // Peening hammer impact frequency (default 7.5)
    dentDepth?: number;           // Hammer depression depth (default 0.30)
    anisotropicSheen?: number;    // Specular highlight stretch (default 0.40)
  };
  sandRipples?: {
    enabled?: boolean;
    frequency?: number;           // Eolian ripple frequency (default 4.0)
    amplitude?: number;           // Normal modulation amplitude (default 0.25)
  };
}

/**
 * Resolves standard preset configurations into fully populated configs.
 */
export function resolveMicroSurfaceConfig(
  presetOrConfig?: MicroSurfacePreset | ProceduralMicroSurfaceConfig
): ProceduralMicroSurfaceConfig {
  const preset: MicroSurfacePreset = typeof presetOrConfig === 'string'
    ? presetOrConfig
    : presetOrConfig?.preset || 'custom';

  const base: ProceduralMicroSurfaceConfig = typeof presetOrConfig === 'object'
    ? { ...presetOrConfig }
    : { preset };

  base.triplanarSharpness = base.triplanarSharpness ?? 4.0;

  switch (preset) {
    case 'mudbrick_masonry':
      base.mortarDeepening = {
        enabled: true,
        brickFrequencyY: 1.25,
        brickAspect: 2.2,
        mortarWidth: 0.085,
        mortarDepth: 0.50,
        mortarRoughness: 0.95,
        jointNormalBevel: 0.35,
        ...base.mortarDeepening
      };
      base.cavitationPores = {
        enabled: true,
        frequency: 8.0,
        threshold: 0.22,
        depth: 0.35,
        normalStrength: 0.25,
        roughnessBoost: 0.20,
        ...base.cavitationPores
      };
      break;

    case 'stone_cavitation':
      base.mortarDeepening = {
        enabled: false,
        ...base.mortarDeepening
      };
      base.cavitationPores = {
        enabled: true,
        frequency: 11.0,
        threshold: 0.26,
        depth: 0.60,
        normalStrength: 0.45,
        roughnessBoost: 0.35,
        ...base.cavitationPores
      };
      break;

    case 'lapis_glaze':
      base.glazeCrackle = {
        enabled: true,
        crackleFrequency: 7.0,
        crackWidth: 0.05,
        crackDarkening: 0.65,
        glazeGlossRoughness: 0.12,
        crackRoughness: 0.72,
        microCurvature: 0.25,
        ...base.glazeCrackle
      };
      break;

    case 'hammered_metal':
      base.hammeredMetal = {
        enabled: true,
        frequency: 8.0,
        dentDepth: 0.32,
        anisotropicSheen: 0.45,
        ...base.hammeredMetal
      };
      break;

    case 'alluvial_sand':
      base.sandRipples = {
        enabled: true,
        frequency: 3.5,
        amplitude: 0.28,
        ...base.sandRipples
      };
      base.cavitationPores = {
        enabled: true,
        frequency: 18.0,
        threshold: 0.15,
        depth: 0.20,
        normalStrength: 0.15,
        roughnessBoost: 0.10,
        ...base.cavitationPores
      };
      break;

    case 'custom':
    default:
      break;
  }

  return base;
}

/**
 * High-performance, zero-download procedural shader patcher for Three.js PBR materials.
 * Dynamically injects analytical Sobel mortar deepening, stone cavitation pores,
 * lapis glaze crazing, and triplanar normal/roughness modulation directly into the WebGL pipeline.
 */
export class ProceduralMicroSurfaceShaderPatcher {
  /**
   * Patches any Three.js MeshStandardMaterial or MeshPhysicalMaterial with procedural micro-surface shaders.
   */
  public static patchMaterial(
    material: THREE.Material,
    presetOrConfig: MicroSurfacePreset | ProceduralMicroSurfaceConfig
  ): void {
    if (!material) return;

    const config = resolveMicroSurfaceConfig(presetOrConfig);
    const userData = (material as any).userData || {};
    (material as any).userData = userData;
    userData.sbMicroSurfaceConfig = config;

    // Cache key to differentiate program compilations in Three.js
    const prevCacheKey = material.customProgramCacheKey ? material.customProgramCacheKey.bind(material) : null;
    material.customProgramCacheKey = () => {
      const baseKey = prevCacheKey ? prevCacheKey() : '';
      const presetName = config.preset || 'custom';
      return `${baseKey}_sb_micro_${presetName}_${config.triplanarSharpness}`;
    };

    const prevOnBeforeCompile = material.onBeforeCompile;

    material.onBeforeCompile = (shader: any, renderer: any) => {
      if (prevOnBeforeCompile) {
        prevOnBeforeCompile.call(material, shader, renderer);
      }

      // 1. Inject uniforms
      shader.uniforms.uSbTriplanarSharpness = { value: config.triplanarSharpness || 4.0 };
      
      // Mortar
      shader.uniforms.uSbMortarEnabled = { value: config.mortarDeepening?.enabled ? 1.0 : 0.0 };
      shader.uniforms.uSbBrickFreqY = { value: config.mortarDeepening?.brickFrequencyY || 1.25 };
      shader.uniforms.uSbBrickAspect = { value: config.mortarDeepening?.brickAspect || 2.2 };
      shader.uniforms.uSbMortarWidth = { value: config.mortarDeepening?.mortarWidth || 0.085 };
      shader.uniforms.uSbMortarDepth = { value: config.mortarDeepening?.mortarDepth || 0.50 };
      shader.uniforms.uSbMortarRoughness = { value: config.mortarDeepening?.mortarRoughness || 0.95 };
      shader.uniforms.uSbJointBevel = { value: config.mortarDeepening?.jointNormalBevel || 0.35 };

      // Cavitation pores
      shader.uniforms.uSbPoresEnabled = { value: config.cavitationPores?.enabled ? 1.0 : 0.0 };
      shader.uniforms.uSbPoreFreq = { value: config.cavitationPores?.frequency || 9.0 };
      shader.uniforms.uSbPoreThreshold = { value: config.cavitationPores?.threshold || 0.24 };
      shader.uniforms.uSbPoreDepth = { value: config.cavitationPores?.depth || 0.55 };
      shader.uniforms.uSbPoreNormalStrength = { value: config.cavitationPores?.normalStrength || 0.40 };
      shader.uniforms.uSbPoreRoughnessBoost = { value: config.cavitationPores?.roughnessBoost || 0.35 };

      // Glaze crackle
      shader.uniforms.uSbGlazeEnabled = { value: config.glazeCrackle?.enabled ? 1.0 : 0.0 };
      shader.uniforms.uSbCrackleFreq = { value: config.glazeCrackle?.crackleFrequency || 6.5 };
      shader.uniforms.uSbCrackWidth = { value: config.glazeCrackle?.crackWidth || 0.045 };
      shader.uniforms.uSbCrackDarkening = { value: config.glazeCrackle?.crackDarkening || 0.70 };
      shader.uniforms.uSbGlazeRoughness = { value: config.glazeCrackle?.glazeGlossRoughness || 0.14 };
      shader.uniforms.uSbCrackRoughness = { value: config.glazeCrackle?.crackRoughness || 0.78 };
      shader.uniforms.uSbGlazeCurvature = { value: config.glazeCrackle?.microCurvature || 0.22 };

      // Hammered metal
      shader.uniforms.uSbHammerEnabled = { value: config.hammeredMetal?.enabled ? 1.0 : 0.0 };
      shader.uniforms.uSbHammerFreq = { value: config.hammeredMetal?.frequency || 8.0 };
      shader.uniforms.uSbHammerDepth = { value: config.hammeredMetal?.dentDepth || 0.32 };

      // Sand ripples
      shader.uniforms.uSbSandEnabled = { value: config.sandRipples?.enabled ? 1.0 : 0.0 };
      shader.uniforms.uSbSandFreq = { value: config.sandRipples?.frequency || 3.5 };
      shader.uniforms.uSbSandAmp = { value: config.sandRipples?.amplitude || 0.28 };

      userData.sbUniforms = shader.uniforms;

      // 2. Vertex Shader Injection: export world-space position & normal
      shader.vertexShader = `
        varying vec3 vSbWorldPos;
        varying vec3 vSbWorldNorm;
      ` + shader.vertexShader;

      shader.vertexShader = shader.vertexShader.replace(
        '#include <worldpos_vertex>',
        `
        #include <worldpos_vertex>
        vSbWorldPos = (modelMatrix * vec4(transformed, 1.0)).xyz;
        vSbWorldNorm = normalize((modelMatrix * vec4(objectNormal, 0.0)).xyz);
        `
      );

      // 3. Fragment Shader Header Injection: Analytical math & micro-surface functions
      shader.fragmentShader = `
        varying vec3 vSbWorldPos;
        varying vec3 vSbWorldNorm;

        uniform float uSbTriplanarSharpness;

        uniform float uSbMortarEnabled;
        uniform float uSbBrickFreqY;
        uniform float uSbBrickAspect;
        uniform float uSbMortarWidth;
        uniform float uSbMortarDepth;
        uniform float uSbMortarRoughness;
        uniform float uSbJointBevel;

        uniform float uSbPoresEnabled;
        uniform float uSbPoreFreq;
        uniform float uSbPoreThreshold;
        uniform float uSbPoreDepth;
        uniform float uSbPoreNormalStrength;
        uniform float uSbPoreRoughnessBoost;

        uniform float uSbGlazeEnabled;
        uniform float uSbCrackleFreq;
        uniform float uSbCrackWidth;
        uniform float uSbCrackDarkening;
        uniform float uSbGlazeRoughness;
        uniform float uSbCrackRoughness;
        uniform float uSbGlazeCurvature;

        uniform float uSbHammerEnabled;
        uniform float uSbHammerFreq;
        uniform float uSbHammerDepth;

        uniform float uSbSandEnabled;
        uniform float uSbSandFreq;
        uniform float uSbSandAmp;

        // Fast analytical 3D hash & noise
        float sbHash31(vec3 p) {
          p = fract(p * 0.1031);
          p += dot(p, p.yzx + 33.33);
          return fract((p.x + p.y) * p.z);
        }

        vec3 sbHash33(vec3 p) {
          p = fract(p * vec3(0.1031, 0.1030, 0.0973));
          p += dot(p, p.yxz + 33.33);
          return fract((p.xxy + p.yxx) * p.zyx);
        }

        float sbNoise3D(vec3 p) {
          vec3 i = floor(p);
          vec3 f = fract(p);
          vec3 u = f * f * (3.0 - 2.0 * f);
          return mix(
            mix(
              mix(sbHash31(i + vec3(0.0,0.0,0.0)), sbHash31(i + vec3(1.0,0.0,0.0)), u.x),
              mix(sbHash31(i + vec3(0.0,1.0,0.0)), sbHash31(i + vec3(1.0,1.0,0.0)), u.x),
              u.y
            ),
            mix(
              mix(sbHash31(i + vec3(0.0,0.0,1.0)), sbHash31(i + vec3(1.0,0.0,1.0)), u.x),
              mix(sbHash31(i + vec3(0.0,1.0,1.0)), sbHash31(i + vec3(1.0,1.0,1.0)), u.x),
              u.y
            ),
            u.z
          );
        }

        // Voronoi F1 / F2 cell boundary distance for glaze crackle
        vec2 sbVoronoiF1F2(vec3 p) {
          vec3 n = floor(p);
          vec3 f = fract(p);
          float f1 = 8.0;
          float f2 = 8.0;
          for (int k = -1; k <= 1; k++) {
            for (int j = -1; j <= 1; j++) {
              for (int i = -1; i <= 1; i++) {
                vec3 g = vec3(float(i), float(j), float(k));
                vec3 o = sbHash33(n + g);
                vec3 r = g - f + o;
                float d = dot(r, r);
                if (d < f1) {
                  f2 = f1;
                  f1 = d;
                } else if (d < f2) {
                  f2 = d;
                }
              }
            }
          }
          return vec2(sqrt(f1), sqrt(f2));
        }

        // Triplanar weights
        vec3 sbTriplanarWeights(vec3 norm, float sharpness) {
          vec3 n = abs(norm);
          vec3 w = pow(max(n, vec3(1e-4)), vec3(sharpness));
          return w / (w.x + w.y + w.z);
        }
      ` + shader.fragmentShader;

      // 4. Inject Micro-Surface Modifications into Roughness
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <roughnessmap_fragment>',
        `
        #include <roughnessmap_fragment>

        vec3 sbNorm = normalize(vSbWorldNorm);
        vec3 sbWeights = sbTriplanarWeights(sbNorm, uSbTriplanarSharpness);

        // --- A. Sobel Mortar Joint Deepening & Roughness ---
        float sbMortarFactor = 0.0;
        if (uSbMortarEnabled > 0.5) {
          // Project vertical masonry along dominant lateral axis
          float uCoord = (sbWeights.x > sbWeights.z) ? vSbWorldPos.z : vSbWorldPos.x;
          float vCoord = vSbWorldPos.y;

          float yCourse = vCoord * uSbBrickFreqY;
          float row = floor(yCourse);
          float yFrac = fract(yCourse);

          // Stagger alternate courses
          float rowStagger = (mod(row, 2.0) > 0.5) ? 0.5 : 0.0;
          float xBrick = (uCoord * (uSbBrickFreqY * uSbBrickAspect)) + rowStagger;
          float xFrac = fract(xBrick);

          // Distances to horizontal bed joint and vertical head joint
          float dBed = min(yFrac, 1.0 - yFrac);
          float dHead = min(xFrac, 1.0 - xFrac);
          float dJoint = min(dBed, dHead);

          sbMortarFactor = smoothstep(uSbMortarWidth, 0.0, dJoint);
          roughnessFactor = mix(roughnessFactor, uSbMortarRoughness, sbMortarFactor * 0.85);
        }

        // --- B. Analytical Cavitation Pores ---
        float sbPorePit = 0.0;
        if (uSbPoresEnabled > 0.5) {
          float pNoise = sbNoise3D(vSbWorldPos * uSbPoreFreq);
          if (pNoise < uSbPoreThreshold) {
            float normP = (uSbPoreThreshold - pNoise) / uSbPoreThreshold;
            sbPorePit = normP * normP;
            roughnessFactor = clamp(roughnessFactor + sbPorePit * uSbPoreRoughnessBoost, 0.04, 1.0);
          }
        }

        // --- C. Lapis Glaze Crazing Crackle ---
        float sbGlazeCrack = 0.0;
        if (uSbGlazeEnabled > 0.5) {
          vec2 f12 = sbVoronoiF1F2(vSbWorldPos * uSbCrackleFreq);
          float crackMetric = f12.y - f12.x; // boundary distance
          sbGlazeCrack = smoothstep(uSbCrackWidth, 0.0, crackMetric);

          // Inside glaze cell: vitreous high gloss; on crack edge: high roughness
          roughnessFactor = mix(uSbGlazeRoughness, uSbCrackRoughness, sbGlazeCrack);
        }

        // --- D. Hammered Metal Pits ---
        if (uSbHammerEnabled > 0.5) {
          float hNoise = sbNoise3D(vSbWorldPos * uSbHammerFreq);
          roughnessFactor = clamp(roughnessFactor + (hNoise - 0.5) * 0.15, 0.05, 0.98);
        }
        `
      );

      // 5. Inject Normal Perturbations into Normal Fragment
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <normal_fragment_maps>',
        `
        #include <normal_fragment_maps>

        // Reconstruct analytical normal perturbations in view space
        vec3 sbWorldPerturbation = vec3(0.0);

        // Mortar joint normal beveling
        if (uSbMortarEnabled > 0.5 && sbMortarFactor > 0.01) {
          float eps = 0.02;
          float uCoord = (sbWeights.x > sbWeights.z) ? vSbWorldPos.z : vSbWorldPos.x;
          float vCoord = vSbWorldPos.y;
          float yCourse = vCoord * uSbBrickFreqY;
          float row = floor(yCourse);
          float rowStagger = (mod(row, 2.0) > 0.5) ? 0.5 : 0.0;
          float xBrick = (uCoord * (uSbBrickFreqY * uSbBrickAspect)) + rowStagger;

          // Gradient toward brick center
          float dBed = (fract(yCourse) > 0.5) ? -1.0 : 1.0;
          float dHead = (fract(xBrick) > 0.5) ? -1.0 : 1.0;

          if (sbWeights.x > sbWeights.z) {
            sbWorldPerturbation.z += dHead * sbMortarFactor * uSbJointBevel;
          } else {
            sbWorldPerturbation.x += dHead * sbMortarFactor * uSbJointBevel;
          }
          sbWorldPerturbation.y += dBed * sbMortarFactor * uSbJointBevel;
        }

        // Cavitation pore indentation
        if (uSbPoresEnabled > 0.5 && sbPorePit > 0.01) {
          float eps = 0.04;
          float nX = sbNoise3D((vSbWorldPos + vec3(eps, 0.0, 0.0)) * uSbPoreFreq) - sbNoise3D((vSbWorldPos - vec3(eps, 0.0, 0.0)) * uSbPoreFreq);
          float nY = sbNoise3D((vSbWorldPos + vec3(0.0, eps, 0.0)) * uSbPoreFreq) - sbNoise3D((vSbWorldPos - vec3(0.0, eps, 0.0)) * uSbPoreFreq);
          float nZ = sbNoise3D((vSbWorldPos + vec3(0.0, 0.0, eps)) * uSbPoreFreq) - sbNoise3D((vSbWorldPos - vec3(0.0, 0.0, eps)) * uSbPoreFreq);
          sbWorldPerturbation += vec3(nX, nY, nZ) * uSbPoreNormalStrength * sbPorePit;
        }

        // Glaze pillowed cell curvature
        if (uSbGlazeEnabled > 0.5) {
          float eps = 0.05;
          vec2 fX = sbVoronoiF1F2((vSbWorldPos + vec3(eps, 0.0, 0.0)) * uSbCrackleFreq);
          vec2 fY = sbVoronoiF1F2((vSbWorldPos + vec3(0.0, eps, 0.0)) * uSbCrackleFreq);
          vec2 fZ = sbVoronoiF1F2((vSbWorldPos + vec3(0.0, 0.0, eps)) * uSbCrackleFreq);
          vec3 glazeGrad = vec3(fX.x, fY.x, fZ.x) - vec3(f12.x);
          sbWorldPerturbation += glazeGrad * uSbGlazeCurvature;
        }

        // Sand ripples
        if (uSbSandEnabled > 0.5) {
          float sandWave = sin(vSbWorldPos.x * uSbSandFreq + vSbWorldPos.z * 0.4);
          sbWorldPerturbation.y += sandWave * uSbSandAmp;
        }

        // Transform world perturbation into view-space normal
        vec3 sbViewPerturbation = (viewMatrix * vec4(sbWorldPerturbation, 0.0)).xyz;
        normal = normalize(normal + sbViewPerturbation);
        `
      );

      // 6. Inject Albedo / Diffuse Color Modifications (Joint darkening, cavitation shade, glaze crackle)
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <color_fragment>',
        `
        #include <color_fragment>

        // Mortar joint darkening
        if (uSbMortarEnabled > 0.5 && sbMortarFactor > 0.01) {
          diffuseColor.rgb *= (1.0 - sbMortarFactor * uSbMortarDepth);
        }

        // Cavitation pit darkening
        if (uSbPoresEnabled > 0.5 && sbPorePit > 0.01) {
          diffuseColor.rgb *= (1.0 - sbPorePit * uSbPoreDepth);
        }

        // Glaze crack line darkening
        if (uSbGlazeEnabled > 0.5 && sbGlazeCrack > 0.01) {
          diffuseColor.rgb *= (1.0 - sbGlazeCrack * uSbCrackDarkening);
        }
        `
      );
    };

    material.needsUpdate = true;
  }

  /**
   * Helper factory creating a MeshStandardMaterial pre-patched with micro-surface procedural shaders.
   */
  public static createMaterial(
    preset: MicroSurfacePreset,
    baseParams?: THREE.MeshStandardMaterialParameters,
    customConfig?: ProceduralMicroSurfaceConfig
  ): THREE.MeshStandardMaterial {
    const material = new THREE.MeshStandardMaterial(baseParams);
    const config = customConfig ? { ...customConfig, preset } : preset;
    this.patchMaterial(material, config);
    return material;
  }
}
