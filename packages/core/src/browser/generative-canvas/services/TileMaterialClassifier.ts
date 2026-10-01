/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import * as THREE from 'three';

export interface TileMaterialUniforms {
  uWeatherRain: { value: number };
  uBumpStrength: { value: number };
  uWetRoughness: { value: number };
  uAlbedoDelight: { value: number };
}

export interface MaterialClassification {
  isWater: boolean;
  isFoliage: boolean;
  isRoad: boolean;
  isBuilding: boolean;
  roughness: number;
  metalness: number;
}

export interface PerFaceMaterialAttributes {
  materialIds: Float32Array | number[];
  roughnesses: Float32Array | number[];
  metalnesses: Float32Array | number[];
  speculars?: Float32Array | number[];
}

/**
 * Attaches C++ per-face physical PBR attributes directly into a Three.js BufferGeometry.
 */
export function applyPerFacePbrAttributes(
  geometry: THREE.BufferGeometry,
  attrs: PerFaceMaterialAttributes
): void {
  const vertCount = geometry.attributes.position ? geometry.attributes.position.count : 0;
  if (vertCount === 0) return;

  const matIdArr = new Float32Array(vertCount);
  const roughArr = new Float32Array(vertCount);
  const metalArr = new Float32Array(vertCount);
  const specArr = new Float32Array(vertCount);

  // If attributes are per-face and geometry is indexed, expand to per-vertex
  const indexAttr = geometry.index;
  if (indexAttr) {
    const indices = indexAttr.array;
    const triCount = Math.floor(indices.length / 3);
    for (let t = 0; t < triCount; t++) {
      const mId = attrs.materialIds[t] ?? 0;
      const r = attrs.roughnesses[t] ?? 0.85;
      const m = attrs.metalnesses[t] ?? 0.0;
      const s = attrs.speculars ? (attrs.speculars[t] ?? 0.5) : 0.5;

      for (let k = 0; k < 3; k++) {
        const vIdx = indices[t * 3 + k];
        matIdArr[vIdx] = mId;
        roughArr[vIdx] = r;
        metalArr[vIdx] = m;
        specArr[vIdx] = s;
      }
    }
  } else {
    // Non-indexed: 3 vertices per face
    const triCount = Math.floor(vertCount / 3);
    for (let t = 0; t < triCount; t++) {
      const mId = attrs.materialIds[t] ?? 0;
      const r = attrs.roughnesses[t] ?? 0.85;
      const m = attrs.metalnesses[t] ?? 0.0;
      const s = attrs.speculars ? (attrs.speculars[t] ?? 0.5) : 0.5;

      for (let k = 0; k < 3; k++) {
        const vIdx = t * 3 + k;
        matIdArr[vIdx] = mId;
        roughArr[vIdx] = r;
        metalArr[vIdx] = m;
        specArr[vIdx] = s;
      }
    }
  }

  geometry.setAttribute('aMaterialId', new THREE.BufferAttribute(matIdArr, 1));
  geometry.setAttribute('aRoughness', new THREE.BufferAttribute(roughArr, 1));
  geometry.setAttribute('aMetalness', new THREE.BufferAttribute(metalArr, 1));
  geometry.setAttribute('aSpecular', new THREE.BufferAttribute(specArr, 1));
}

/**
 * GLSL chunk for classifying material types based on aerial tile texel color and world normal.
 */
export const CLASSIFIER_SHADER_CHUNK = /* glsl */ `
struct MaterialClass {
  int type; // 0=default, 1=foliage, 2=water, 3=road, 4=building facade, 5=building roof, 6=pavement
  float roughness;
  float metalness;
  float specular;
};

#ifdef USE_PER_FACE_MATERIAL
varying float vMaterialId;
varying float vRoughness;
varying float vMetalness;
varying float vSpecular;
#endif

MaterialClass classifyTileMaterial(vec3 albedo, vec3 worldNormal, float rain) {
  MaterialClass mat;
  mat.type = 0;
  mat.roughness = 0.85;
  mat.metalness = 0.0;
  mat.specular = 0.5;

#ifdef USE_PER_FACE_MATERIAL
  mat.type = int(vMaterialId + 0.5);
  mat.roughness = vRoughness;
  mat.metalness = vMetalness;
  mat.specular = vSpecular;
  if (mat.type == 3) {
    // Wet road reflection modifier
    mat.roughness = mix(mat.roughness, 0.25, rain);
    mat.metalness = mix(mat.metalness, 0.04, rain);
  }
  return mat;
#else
  float isHorizontal = step(0.65, abs(worldNormal.y));
  float isVertical = 1.0 - isHorizontal;

  // Foliage: green channel exceeds red and blue
  float greenRatio = albedo.g / max(max(albedo.r, albedo.b), 0.01);
  if (greenRatio > 1.15 && albedo.g > 0.12 && albedo.r < 0.5) {
    mat.type = 1; // Foliage
    mat.roughness = 0.95;
    mat.metalness = 0.0;
    mat.specular = 0.40;
    return mat;
  }

  // Water: low red, dominant blue/cyan, flat surface
  if (isHorizontal > 0.5 && albedo.r < 0.25 && albedo.b > albedo.r * 1.3 && albedo.g > albedo.r) {
    mat.type = 2; // Water
    mat.roughness = 0.05;
    mat.metalness = 0.02;
    mat.specular = 0.25;
    return mat;
  }

  // Road/Asphalt: low saturation, flat surface, dark/medium luminance
  float maxC = max(max(albedo.r, albedo.g), albedo.b);
  float minC = min(min(albedo.r, albedo.g), albedo.b);
  float sat = (maxC - minC) / max(maxC, 0.01);
  float luma = dot(albedo, vec3(0.2126, 0.7152, 0.0722));

  if (isHorizontal > 0.5 && sat < 0.18 && luma > 0.08 && luma < 0.65) {
    mat.type = 3; // Road
    // When dry, asphalt is matte. Only with rain does it get specular sheen.
    mat.roughness = mix(0.85, 0.35, rain);
    mat.metalness = mix(0.0, 0.02, rain);
    mat.specular = 0.45;
    return mat;
  }

  // Building Facades: vertical surfaces (stone, masonry, concrete)
  if (isVertical > 0.5) {
    mat.type = 4; // Building
    mat.roughness = 0.85;
    mat.metalness = 0.0;
    mat.specular = 0.50;
    return mat;
  }

  return mat;
#endif
}
`;

/**
 * GLSL chunk for generating screen-space micro-relief normal from texture luminance derivatives.
 */
export const BUMP_NORMAL_SHADER_CHUNK = /* glsl */ `
vec3 perturbNormalFromLuminance(vec3 surfPos, vec3 surfNorm, vec2 uv, sampler2D tex, float bumpScale) {
  vec2 dSTdx = dFdx(uv);
  vec2 dSTdy = dFdy(uv);

  float Hll = dot(texture2D(tex, uv).rgb, vec3(0.299, 0.587, 0.114));
  float dHdx = dot(texture2D(tex, uv + dSTdx).rgb, vec3(0.299, 0.587, 0.114)) - Hll;
  float dHdy = dot(texture2D(tex, uv + dSTdy).rgb, vec3(0.299, 0.587, 0.114)) - Hll;

  vec3 dPdx = dFdx(surfPos);
  vec3 dPdy = dFdy(surfPos);

  vec3 sigmaX = dPdx - dot(dPdx, surfNorm) * surfNorm;
  vec3 sigmaY = dPdy - dot(dPdy, surfNorm) * surfNorm;

  vec3 surfGrad = sign(dPdx.x * dPdy.y - dPdx.y * dPdy.x) * (dHdx * sigmaY - dHdy * sigmaX);
  return normalize(surfNorm - bumpScale * surfGrad);
}
`;

/**
 * Injects material classification and screen-space relief shaders into a Three.js material.
 */
export function injectTileMaterialClassifier(
  material: THREE.Material & { onBeforeCompile?: (shader: any) => void; userData?: any },
  customUniforms?: Partial<TileMaterialUniforms>
): TileMaterialUniforms {
  const uniforms: TileMaterialUniforms = {
    uWeatherRain: customUniforms?.uWeatherRain || { value: 0.0 },
    uBumpStrength: customUniforms?.uBumpStrength || { value: 0.8 },
    uWetRoughness: customUniforms?.uWetRoughness || { value: 0.15 },
    uAlbedoDelight: customUniforms?.uAlbedoDelight || { value: 1.0 }
  };

  const prevOnBeforeCompile = material.onBeforeCompile;

  material.onBeforeCompile = (shader: any) => {
    if (prevOnBeforeCompile) {
      prevOnBeforeCompile(shader);
    }

    shader.uniforms.uWeatherRain = uniforms.uWeatherRain;
    shader.uniforms.uBumpStrength = uniforms.uBumpStrength;
    shader.uniforms.uWetRoughness = uniforms.uWetRoughness;
    shader.uniforms.uAlbedoDelight = uniforms.uAlbedoDelight;

    // Inject vertex shader attribute forwarding
    shader.vertexShader = `
      attribute float aMaterialId;
      attribute float aRoughness;
      attribute float aMetalness;
      attribute float aSpecular;
      varying float vMaterialId;
      varying float vRoughness;
      varying float vMetalness;
      varying float vSpecular;
      ${shader.vertexShader}
    `;

    shader.vertexShader = shader.vertexShader.replace(
      '#include <begin_vertex>',
      /* glsl */ `
      #include <begin_vertex>
      vMaterialId = aMaterialId;
      vRoughness = aRoughness;
      vMetalness = aMetalness;
      vSpecular = aSpecular;
      `
    );

    // Inject custom uniform declarations and functions
    shader.fragmentShader = `
      #define USE_PER_FACE_MATERIAL 1
      uniform float uWeatherRain;
      uniform float uBumpStrength;
      uniform float uWetRoughness;
      uniform float uAlbedoDelight;
      ${CLASSIFIER_SHADER_CHUNK}
      ${shader.fragmentShader}
    `;

    // Replace roughnessmap_fragment to inject dynamic classification
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <roughnessmap_fragment>',
      /* glsl */ `
      #include <roughnessmap_fragment>
      
      #if defined(USE_MAP) && defined(USE_NORMAL)
        MaterialClass classified = classifyTileMaterial(diffuseColor.rgb, vNormal, uWeatherRain);
        roughnessFactor = classified.roughness;
      #endif
      `
    );

    // Replace metalnessmap_fragment to adjust wet reflections
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <metalnessmap_fragment>',
      /* glsl */ `
      #include <metalnessmap_fragment>
      
      #if defined(USE_MAP) && defined(USE_NORMAL)
        metalnessFactor = classified.metalness;
        
        // Wet pavement albedo darkening
        if (classified.type == 3) {
          diffuseColor.rgb *= mix(1.0, 0.35, uWeatherRain);
        }
      #endif
      `
    );
  };

  material.needsUpdate = true;
  return uniforms;
}
