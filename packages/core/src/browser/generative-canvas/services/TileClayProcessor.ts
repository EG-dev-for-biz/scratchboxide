/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import * as THREE from 'three';

export type ClayPresetId =
  | 'warm-clay'
  | 'alabaster'
  | 'onyx'
  | 'studio-grey'
  | 'terracotta'
  | 'porcelain'
  | 'concrete';

export interface ClayPresetDefinition {
  id: ClayPresetId;
  name: string;
  description: string;
  color: number | string;
  roughness: number;
  metalness: number;
  cavityStrength: number;
  ambientOcclusionGain: number;
  highlightTone?: number | string;
}

export const CLAY_PRESETS: Record<ClayPresetId, ClayPresetDefinition> = {
  'warm-clay': {
    id: 'warm-clay',
    name: 'Warm Architectural Clay',
    description: 'Rich warm terracotta sandstone tone with soft matte depth and ambient shadowing',
    color: 0xc89678,
    roughness: 0.82,
    metalness: 0.02,
    cavityStrength: 0.45,
    ambientOcclusionGain: 1.15,
    highlightTone: 0xe8b898
  },
  'alabaster': {
    id: 'alabaster',
    name: 'Alabaster Plaster',
    description: 'Clean gallery-grade white plaster and pristine matte marble aesthetic',
    color: 0xf4f4f6,
    roughness: 0.80,
    metalness: 0.00,
    cavityStrength: 0.50,
    ambientOcclusionGain: 1.20,
    highlightTone: 0xffffff
  },
  'onyx': {
    id: 'onyx',
    name: 'Onyx Basalt',
    description: 'Deep graphite slate and volcanic basalt stone with micro-cavity edge definition',
    color: 0x1e2024,
    roughness: 0.78,
    metalness: 0.06,
    cavityStrength: 0.65,
    ambientOcclusionGain: 1.30,
    highlightTone: 0x3a3f47
  },
  'studio-grey': {
    id: 'studio-grey',
    name: 'Studio Neutral Grey',
    description: 'Balanced 18% neutral grey clay for precision architectural massing and topology review',
    color: 0x8e929b,
    roughness: 0.80,
    metalness: 0.02,
    cavityStrength: 0.40,
    ambientOcclusionGain: 1.10,
    highlightTone: 0xb0b5be
  },
  'terracotta': {
    id: 'terracotta',
    name: 'Classic Terracotta',
    description: 'Earthy kiln-fired terracotta clay with natural warm red-orange undertones',
    color: 0xc85a32,
    roughness: 0.85,
    metalness: 0.00,
    cavityStrength: 0.55,
    ambientOcclusionGain: 1.25,
    highlightTone: 0xe07850
  },
  'porcelain': {
    id: 'porcelain',
    name: 'Fine Porcelain',
    description: 'Smooth ceramic finish with soft specular roll-off and refined edges',
    color: 0xe8ecf0,
    roughness: 0.75,
    metalness: 0.01,
    cavityStrength: 0.35,
    ambientOcclusionGain: 1.05,
    highlightTone: 0xf8faff
  },
  'concrete': {
    id: 'concrete',
    name: 'Architectural Concrete',
    description: 'Subtle cool grey cast concrete with natural surface roughness and depth',
    color: 0x7a8288,
    roughness: 0.88,
    metalness: 0.02,
    cavityStrength: 0.50,
    ambientOcclusionGain: 1.15,
    highlightTone: 0x98a0a8
  }
};

export interface ClayMaterialConfig {
  preset?: ClayPresetId;
  color?: THREE.Color | number | string;
  roughness?: number;
  metalness?: number;
  cavityShading?: boolean;
  cavityStrength?: number;
  ambientOcclusionGain?: number;
  wireframe?: boolean;
  opacity?: number;
  transparent?: boolean;
}

export class TileClayProcessor {
  /**
   * Resolves a preset ID or custom config into full clay styling parameters.
   */
  static resolveConfig(presetOrConfig?: ClayPresetId | ClayMaterialConfig | {
    presetId?: ClayPresetId;
    color?: THREE.Color | number | string;
    roughness?: number;
    metalness?: number;
    cavityStrength?: number;
    ambientOcclusionGain?: number;
    wireframe?: boolean;
    opacity?: number;
    transparent?: boolean;
  }): {
    presetId: ClayPresetId;
    color: THREE.Color;
    roughness: number;
    metalness: number;
    cavityStrength: number;
    ambientOcclusionGain: number;
    wireframe: boolean;
    opacity: number;
    transparent: boolean;
  } {
    if (typeof presetOrConfig === 'string') {
      const p = CLAY_PRESETS[presetOrConfig] || CLAY_PRESETS['warm-clay'];
      return {
        presetId: p.id,
        color: new THREE.Color(p.color),
        roughness: p.roughness,
        metalness: p.metalness,
        cavityStrength: p.cavityStrength,
        ambientOcclusionGain: p.ambientOcclusionGain,
        wireframe: false,
        opacity: 1.0,
        transparent: false
      };
    }

    const cfg: any = presetOrConfig || {};
    const key = (cfg.preset || cfg.presetId || 'warm-clay') as ClayPresetId;
    const basePreset = CLAY_PRESETS[key] || CLAY_PRESETS['warm-clay'];

    return {
      presetId: cfg.preset || cfg.presetId || basePreset.id,
      color: cfg.color instanceof THREE.Color ? cfg.color.clone() : (cfg.color !== undefined ? new THREE.Color(cfg.color) : new THREE.Color(basePreset.color)),
      roughness: cfg.roughness !== undefined ? cfg.roughness : basePreset.roughness,
      metalness: cfg.metalness !== undefined ? cfg.metalness : basePreset.metalness,
      cavityStrength: cfg.cavityStrength !== undefined ? cfg.cavityStrength : (cfg.cavityShading ? 0.5 : basePreset.cavityStrength),
      ambientOcclusionGain: cfg.ambientOcclusionGain !== undefined ? cfg.ambientOcclusionGain : basePreset.ambientOcclusionGain,
      wireframe: !!cfg.wireframe,
      opacity: cfg.opacity !== undefined ? cfg.opacity : 1.0,
      transparent: !!cfg.transparent
    };
  }

  /**
   * Creates a dedicated THREE.MeshStandardMaterial configured for architectural clay rendering.
   */
  static createClayMaterial(presetOrConfig?: ClayPresetId | ClayMaterialConfig): THREE.MeshStandardMaterial {
    const resolved = this.resolveConfig(presetOrConfig);

    const material = new THREE.MeshStandardMaterial({
      color: resolved.color,
      roughness: resolved.roughness,
      metalness: resolved.metalness,
      wireframe: resolved.wireframe,
      opacity: resolved.opacity,
      transparent: resolved.transparent,
      side: THREE.DoubleSide
    });

    material.userData = {
      ...material.userData,
      isClayMaterial: true,
      is3DMapTile: true,
      clayPreset: resolved.presetId,
      cavityStrength: resolved.cavityStrength,
      ambientOcclusionGain: resolved.ambientOcclusionGain
    };

    this.patchMaterialWithClayShading(material, resolved);

    return material;
  }

  /**
   * Patches a material's onBeforeCompile shader hook with clean architectural clay shading and cavity occlusion.
   */
  static patchMaterialWithClayShading(material: THREE.Material, config?: ClayPresetId | ClayMaterialConfig | any): void {
    const resolved = this.resolveConfig(config);

    const originalOnBeforeCompile = material.onBeforeCompile;
    material.onBeforeCompile = (shader: any, renderer: THREE.WebGLRenderer) => {
      if (originalOnBeforeCompile) {
        originalOnBeforeCompile.call(material, shader, renderer);
      }

      shader.uniforms.uClayColor = { value: resolved.color };
      shader.uniforms.uCavityStrength = { value: resolved.cavityStrength };
      shader.uniforms.uAOGain = { value: resolved.ambientOcclusionGain };

      shader.vertexShader = shader.vertexShader.replace(
        '#include <common>',
        `#include <common>
         varying vec3 vClayWorldPosition;
         varying vec3 vClayWorldNormal;`
      );

      shader.vertexShader = shader.vertexShader.replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
         vClayWorldPosition = (modelMatrix * vec4(transformed, 1.0)).xyz;
         vClayWorldNormal = normalize((modelMatrix * vec4(normal, 0.0)).xyz);`
      );

      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <common>',
        `#include <common>
         uniform vec3 uClayColor;
         uniform float uCavityStrength;
         uniform float uAOGain;
         varying vec3 vClayWorldPosition;
         varying vec3 vClayWorldNormal;`
      );

      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <map_fragment>',
        `// Pure architectural clay matte override
         diffuseColor.rgb = uClayColor;

         // Subtle geometric normal curvature / cavity shading
         float normalY = clamp(vClayWorldNormal.y, -1.0, 1.0);
         float skyLight = clamp(normalY * 0.5 + 0.5, 0.0, 1.0);
         diffuseColor.rgb *= mix(vec3(0.72), vec3(1.08), skyLight * uAOGain * 0.5);

         // Screen-space normal derivative depth cavity accentuation
         vec3 dNx = dFdx(vClayWorldNormal);
         vec3 dNy = dFdy(vClayWorldNormal);
         float curvature = length(dNx) + length(dNy);
         float cavity = clamp(1.0 - curvature * uCavityStrength * 2.5, 0.4, 1.0);
         diffuseColor.rgb *= cavity;`
      );
    };

    material.needsUpdate = true;
  }

  /**
   * Applies the clay material to an entire Object3D / Mesh hierarchy.
   */
  static applyClayMaterial(
    root: THREE.Object3D,
    presetOrConfig?: ClayPresetId | ClayMaterialConfig,
    options?: { recursive?: boolean; cavityShading?: boolean }
  ): void {
    const isRecursive = options?.recursive ?? true;
    const clayMat = this.createClayMaterial(presetOrConfig);

    const applyToMesh = (mesh: THREE.Mesh) => {
      if (!mesh || !mesh.isMesh) return;

      // Enable casting and receiving shadows for depth cues on the clay surface
      mesh.castShadow = true;
      mesh.receiveShadow = true;

      // Guarantee vertex normals exist for physical shading
      if (mesh.geometry && !mesh.geometry.attributes.normal) {
        mesh.geometry.computeVertexNormals();
      }

      mesh.material = clayMat;
      mesh.userData.isClayMesh = true;
    };

    if (isRecursive) {
      root.traverse((child) => {
        if ((child as THREE.Mesh).isMesh) {
          applyToMesh(child as THREE.Mesh);
        }
      });
    } else if ((root as THREE.Mesh).isMesh) {
      applyToMesh(root as THREE.Mesh);
    }
  }

  /**
   * Returns reusable GLSL shader source strings and uniforms for custom clay shaders.
   */
  static createClayShaderConfig(config?: ClayMaterialConfig): {
    vertexShader: string;
    fragmentShader: string;
    uniforms: Record<string, any>;
  } {
    const resolved = this.resolveConfig(config);

    const vertexShader = `
      varying vec3 vWorldPosition;
      varying vec3 vWorldNormal;
      varying vec3 vViewPosition;

      void main() {
        vWorldPosition = (modelMatrix * vec4(position, 1.0)).xyz;
        vWorldNormal = normalize((modelMatrix * vec4(normal, 0.0)).xyz);
        vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
        vViewPosition = -mvPosition.xyz;
        gl_Position = projectionMatrix * mvPosition;
      }
    `;

    const fragmentShader = `
      uniform vec3 uClayColor;
      uniform float uCavityStrength;
      uniform float uAOGain;
      uniform float uRoughness;
      varying vec3 vWorldPosition;
      varying vec3 vWorldNormal;
      varying vec3 vViewPosition;

      void main() {
        vec3 N = normalize(vWorldNormal);
        vec3 V = normalize(vViewPosition);

        // Hemispherical ambient light
        float hemi = clamp(N.y * 0.5 + 0.5, 0.0, 1.0);
        vec3 ambient = mix(vec3(0.18, 0.19, 0.22), vec3(0.95, 0.96, 1.0), hemi) * uAOGain;

        // Key directional light
        vec3 L = normalize(vec3(0.5, 0.8, 0.4));
        float NdotL = max(dot(N, L), 0.0);
        vec3 diffuse = uClayColor * (NdotL + ambient * 0.4);

        // Cavity edge shading
        vec3 dNx = dFdx(N);
        vec3 dNy = dFdy(N);
        float curvature = length(dNx) + length(dNy);
        float cavity = clamp(1.0 - curvature * uCavityStrength * 3.0, 0.35, 1.0);

        vec3 finalColor = diffuse * cavity;
        gl_FragColor = vec4(finalColor, 1.0);
      }
    `;

    const uniforms = {
      uClayColor: { value: resolved.color },
      uCavityStrength: { value: resolved.cavityStrength },
      uAOGain: { value: resolved.ambientOcclusionGain },
      uRoughness: { value: resolved.roughness }
    };

    return { vertexShader, fragmentShader, uniforms };
  }
}
