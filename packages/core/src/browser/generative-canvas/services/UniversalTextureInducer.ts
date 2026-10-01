/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import * as THREE from 'three';

// ============================================================================
// 1. Architectural Semantic Zones
// ============================================================================

export enum ArchitecturalZone {
  GroundPlinth = 'GroundPlinth',       // Street level rusticated limestone/granite base
  MainShaft = 'MainShaft',             // Vertical facade body (Roman brick, curtain wall, ashlar)
  Spandrel = 'Spandrel',               // Horizontal bands between window registers
  CorniceMolding = 'CorniceMolding',   // Cantilevered entablatures and belt courses
  SlopedRoof = 'SlopedRoof',           // Mansards, gables, copper/slate shingles
  HorizontalDeck = 'HorizontalDeck',   // Flat roofs, penthouse terraces, sidewalks
  WindowAperture = 'WindowAperture',   // Glass fenestration and mullions
  MetalCrown = 'MetalCrown',           // Cresting, spires, finials
}

export interface TextureSpatialProfile {
  isPeriodic: boolean;
  dominantPeriodX: number; // in pixels
  dominantPeriodY: number;
  aspectRatio: number;
  physicalModuleWidthMeters: number;
  physicalModuleHeightMeters: number;
  recommendedRepeatU: number;
  recommendedRepeatV: number;
}

export interface NormalScaleCalibration {
  gradientVariance: number;
  stepEdgeEnergy: number;
  recommendedNormalScale: number;
  recommendedAoIntensity: number;
}

export interface MaterialInductionProfile {
  zone: ArchitecturalZone;
  repeatU: number;
  repeatV: number;
  normalScale: number;
  roughness: number;
  metalness: number;
  aoIntensity: number;
  recommendedArchetype: string;
}

// ============================================================================
// 2. Universal Spatial Autocorrelation & Module Sizing
// ============================================================================

/**
 * Evaluates the 2D spatial autocorrelation of an image buffer to detect
 * repeating unit cells (brick courses, stone blocks, tiles, shingles).
 */
export function analyzeTextureAutocorrelation(
  width: number,
  height: number,
  rgba: Uint8Array | Uint8ClampedArray,
  targetPhysicalSpanMeters = 2.0
): TextureSpatialProfile {
  const maxLagX = Math.min(Math.floor(width / 2), 128);
  const maxLagY = Math.min(Math.floor(height / 2), 128);

  // Compute mean luminance and variance
  let sumL = 0;
  let sumL2 = 0;
  const count = width * height;

  const luma = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    const idx = i * 4;
    const l = 0.299 * (rgba[idx] / 255) + 0.587 * (rgba[idx + 1] / 255) + 0.114 * (rgba[idx + 2] / 255);
    luma[i] = l;
    sumL += l;
    sumL2 += l * l;
  }

  const mean = sumL / count;
  const variance = Math.max(1e-6, sumL2 / count - mean * mean);

  // Autocorrelation X
  const autocorrX = new Float32Array(maxLagX);
  for (let lag = 0; lag < maxLagX; lag++) {
    let cov = 0;
    let n = 0;
    for (let y = 0; y < height; y += 4) {
      const yOffset = y * width;
      for (let x = 0; x < width - lag; x += 2) {
        cov += (luma[yOffset + x] - mean) * (luma[yOffset + x + lag] - mean);
        n++;
      }
    }
    autocorrX[lag] = cov / (n * variance);
  }

  // Autocorrelation Y
  const autocorrY = new Float32Array(maxLagY);
  for (let lag = 0; lag < maxLagY; lag++) {
    let cov = 0;
    let n = 0;
    for (let y = 0; y < height - lag; y += 2) {
      const y1 = y * width;
      const y2 = (y + lag) * width;
      for (let x = 0; x < width; x += 4) {
        cov += (luma[y1 + x] - mean) * (luma[y2 + x] - mean);
        n++;
      }
    }
    autocorrY[lag] = cov / (n * variance);
  }

  // Peak detector
  const findPeak = (ac: Float32Array): number => {
    let passedValley = false;
    let valley = 1.0;
    for (let lag = 2; lag < ac.length - 2; lag++) {
      if (!passedValley) {
        if (ac[lag] < ac[lag - 1] && ac[lag] <= ac[lag + 1]) {
          passedValley = true;
          valley = ac[lag];
        }
      } else {
        if (ac[lag] > ac[lag - 1] && ac[lag] >= ac[lag + 1]) {
          if (ac[lag] - valley > 0.08) {
            return lag;
          }
        }
      }
    }
    return 0;
  };

  const periodX = findPeak(autocorrX);
  const periodY = findPeak(autocorrY);

  if (periodX > 0 && periodY > 0) {
    const aspect = periodX / periodY;
    let modW = 0.30;
    let modH = 0.30;

    if (aspect > 2.8) {
      // Roman brick / modular brick stretcher course
      modW = 0.25;
      modH = 0.065;
    } else if (aspect > 1.4) {
      // Ashlar stone block
      modW = 0.60;
      modH = 0.35;
    } else if (aspect < 0.6) {
      // Standing seam metal strips
      modW = 0.40;
      modH = 1.20;
    } else {
      // Square ceramic / slate tile
      modW = 0.30;
      modH = 0.30;
    }

    return {
      isPeriodic: true,
      dominantPeriodX: periodX,
      dominantPeriodY: periodY,
      aspectRatio: aspect,
      physicalModuleWidthMeters: modW,
      physicalModuleHeightMeters: modH,
      recommendedRepeatU: targetPhysicalSpanMeters / modW,
      recommendedRepeatV: targetPhysicalSpanMeters / modH,
    };
  }

  // Stochastic non-repeating grain (marble, concrete, granite)
  return {
    isPeriodic: false,
    dominantPeriodX: 0,
    dominantPeriodY: 0,
    aspectRatio: 1.0,
    physicalModuleWidthMeters: targetPhysicalSpanMeters,
    physicalModuleHeightMeters: targetPhysicalSpanMeters,
    recommendedRepeatU: 1.0,
    recommendedRepeatV: 1.0,
  };
}

// ============================================================================
// 3. Adaptive Normal Scale Calibration
// ============================================================================

/**
 * Analyzes normal map gradient variance to compute the optimal Three.js normalScale multiplier.
 * Prevents flat-looking mortar lines while safeguarding deep textures against normal inversion.
 */
export function calibrateNormalScaleFromRgba(
  width: number,
  height: number,
  normalRgba: Uint8Array | Uint8ClampedArray
): NormalScaleCalibration {
  let sumGradSq = 0;
  let sumStep = 0;
  let count = 0;

  for (let y = 1; y < height - 1; y += 2) {
    const yOffset = y * width;
    for (let x = 1; x < width - 1; x += 2) {
      const idx = (yOffset + x) * 4;
      const nx = (normalRgba[idx] / 255) * 2.0 - 1.0;
      const ny = (normalRgba[idx + 1] / 255) * 2.0 - 1.0;

      sumGradSq += nx * nx + ny * ny;

      const idxRight = (yOffset + x + 1) * 4;
      const nxRight = (normalRgba[idxRight] / 255) * 2.0 - 1.0;
      sumStep += Math.abs(nxRight - nx);

      count++;
    }
  }

  const gradVar = sumGradSq / Math.max(1, count);
  const stepEnergy = sumStep / Math.max(1, count);

  const kappa = 0.65; // Architectural relief index
  const rmsGrad = Math.sqrt(gradVar + 1e-5);
  const rawScale = (kappa / rmsGrad) * (1.0 + 0.45 * Math.min(1.0, Math.max(0.0, stepEnergy * 4.0)));
  const normalScale = Math.min(3.2, Math.max(1.0, rawScale));
  const aoIntensity = Math.min(1.0, Math.max(0.60, 0.65 + 0.45 * rmsGrad));

  return {
    gradientVariance: gradVar,
    stepEdgeEnergy: stepEnergy,
    recommendedNormalScale: normalScale,
    recommendedAoIntensity: aoIntensity,
  };
}

// ============================================================================
// 4. Semantic Surface Classification for Three.js Geometries
// ============================================================================

/**
 * Classifies the faces of a BufferGeometry into architectural zones and induces
 * optimal PBR parameters for each zone.
 */
export function classifyGeometrySurfaces(
  geometry: THREE.BufferGeometry,
  options?: {
    groundDatumY?: number;
    plinthHeightMeters?: number;
    /** Density multiplier for smaller, tighter texture patterns. Default: 3.0 */
    patternDensityMultiplier?: number;
  }
): {
  zoneCounts: Record<ArchitecturalZone, number>;
  faceZones: ArchitecturalZone[];
  zoneProfiles: Record<ArchitecturalZone, MaterialInductionProfile>;
} {
  const groundDatumY = options?.groundDatumY ?? 0.0;
  const plinthThreshold = options?.plinthHeightMeters ?? 4.0;
  const densityMultiplier = options?.patternDensityMultiplier ?? 3.0;
  const densityFactor = Math.max(0.2, densityMultiplier / 3.0);

  const pos = geometry.getAttribute('position');
  const norm = geometry.getAttribute('normal');
  const index = geometry.getIndex();

  let minY = 1e9;
  let maxY = -1e9;
  for (let i = 0; i < pos.count; i++) {
    const y = pos.getY(i);
    minY = Math.min(minY, y);
    maxY = Math.max(maxY, y);
  }
  const totalHeight = Math.max(1.0, maxY - minY);

  const zoneCounts: Record<ArchitecturalZone, number> = {
    [ArchitecturalZone.GroundPlinth]: 0,
    [ArchitecturalZone.MainShaft]: 0,
    [ArchitecturalZone.Spandrel]: 0,
    [ArchitecturalZone.CorniceMolding]: 0,
    [ArchitecturalZone.SlopedRoof]: 0,
    [ArchitecturalZone.HorizontalDeck]: 0,
    [ArchitecturalZone.WindowAperture]: 0,
    [ArchitecturalZone.MetalCrown]: 0,
  };

  const numFaces = index ? index.count / 3 : pos.count / 3;
  const faceZones: ArchitecturalZone[] = new Array(numFaces);

  for (let f = 0; f < numFaces; f++) {
    const i0 = index ? index.getX(f * 3) : f * 3;
    const i1 = index ? index.getX(f * 3 + 1) : f * 3 + 1;
    const i2 = index ? index.getX(f * 3 + 2) : f * 3 + 2;

    const y0 = pos.getY(i0);
    const y1 = pos.getY(i1);
    const y2 = pos.getY(i2);
    const triMinY = Math.min(y0, y1, y2);
    const centroidY = (y0 + y1 + y2) / 3.0;

    let ny = 1.0;
    if (norm) {
      ny = (norm.getY(i0) + norm.getY(i1) + norm.getY(i2)) / 3.0;
    }

    const normHeight = (centroidY - minY) / totalHeight;

    let zone: ArchitecturalZone;

    if (triMinY <= minY + plinthThreshold && Math.abs(ny) < 0.40 && centroidY <= minY + plinthThreshold * 2.0) {
      zone = ArchitecturalZone.GroundPlinth;
    } else if (Math.abs(ny) > 0.70) {
      zone = ArchitecturalZone.HorizontalDeck;
    } else if (ny > 0.30 && ny <= 0.70 && normHeight > 0.65) {
      zone = ArchitecturalZone.SlopedRoof;
    } else if (Math.abs(ny) < 0.35) {
      zone = ArchitecturalZone.MainShaft;
    } else {
      zone = ArchitecturalZone.CorniceMolding;
    }

    faceZones[f] = zone;
    zoneCounts[zone]++;
  }

  // Pre-calibrated architectural profiles per zone with smaller pattern sizing
  const zoneProfiles: Record<ArchitecturalZone, MaterialInductionProfile> = {
    [ArchitecturalZone.GroundPlinth]: {
      zone: ArchitecturalZone.GroundPlinth,
      repeatU: 4.5 * densityFactor,
      repeatV: 4.5 * densityFactor,
      normalScale: 3.0,
      roughness: 0.88,
      metalness: 0.0,
      aoIntensity: 0.95,
      recommendedArchetype: 'rusticated_limestone',
    },
    [ArchitecturalZone.MainShaft]: {
      zone: ArchitecturalZone.MainShaft,
      repeatU: 4.8 * densityFactor,
      repeatV: 22.5 * densityFactor, // Smaller patterns: tight brick courses
      normalScale: 2.8,
      roughness: 0.82,
      metalness: 0.0,
      aoIntensity: 0.90,
      recommendedArchetype: 'roman_brick',
    },
    [ArchitecturalZone.SlopedRoof]: {
      zone: ArchitecturalZone.SlopedRoof,
      repeatU: 2.8 * densityFactor,
      repeatV: 3.2 * densityFactor, // Smaller patterns: fine copper standing seams
      normalScale: 2.6,
      roughness: 0.65,
      metalness: 0.15,
      aoIntensity: 0.85,
      recommendedArchetype: 'copper_shingle',
    },
    [ArchitecturalZone.HorizontalDeck]: {
      zone: ArchitecturalZone.HorizontalDeck,
      repeatU: 4.0 * densityFactor,
      repeatV: 4.0 * densityFactor, // Smaller patterns: ~0.25m terrace pavers
      normalScale: 1.8,
      roughness: 0.90,
      metalness: 0.0,
      aoIntensity: 0.75,
      recommendedArchetype: 'roof_terrace_paver',
    },
    [ArchitecturalZone.CorniceMolding]: {
      zone: ArchitecturalZone.CorniceMolding,
      repeatU: 5.0 * densityFactor,
      repeatV: 5.0 * densityFactor, // Smaller patterns: fine dentil friezes
      normalScale: 2.2,
      roughness: 0.75,
      metalness: 0.05,
      aoIntensity: 0.90,
      recommendedArchetype: 'carved_terracotta',
    },
    [ArchitecturalZone.Spandrel]: {
      zone: ArchitecturalZone.Spandrel,
      repeatU: 4.0 * densityFactor,
      repeatV: 3.0 * densityFactor,
      normalScale: 2.0,
      roughness: 0.60,
      metalness: 0.35,
      aoIntensity: 0.80,
      recommendedArchetype: 'cast_bronze',
    },
    [ArchitecturalZone.WindowAperture]: {
      zone: ArchitecturalZone.WindowAperture,
      repeatU: 2.0 * densityFactor,
      repeatV: 2.0 * densityFactor,
      normalScale: 0.0,
      roughness: 0.05,
      metalness: 0.90,
      aoIntensity: 0.50,
      recommendedArchetype: 'reflective_glazing',
    },
    [ArchitecturalZone.MetalCrown]: {
      zone: ArchitecturalZone.MetalCrown,
      repeatU: 2.5 * densityFactor,
      repeatV: 2.5 * densityFactor,
      normalScale: 2.0,
      roughness: 0.35,
      metalness: 0.85,
      aoIntensity: 0.80,
      recommendedArchetype: 'gilded_cresting',
    },
  };

  return { zoneCounts, faceZones, zoneProfiles };
}

// ============================================================================
// 5. Universal Material Applicator & Induction Pipeline
// ============================================================================

export class UniversalTextureInducer {
  /**
   * Applies the universal texturing algorithm to any Three.js mesh:
   * 1. Detects architectural zone semantics
   * 2. Calibrates UV repeats to real-world metric dimensions
   * 3. Sets adaptive normal scales and physical PBR roughness/metalness
   */
  public static applyUniversalPbrToMesh(
    mesh: THREE.Mesh,
    textureSuite: {
      diffuse?: THREE.Texture;
      normal?: THREE.Texture;
      roughness?: THREE.Texture;
      metalness?: THREE.Texture;
      ao?: THREE.Texture;
    },
    options?: {
      overrideZone?: ArchitecturalZone;
      targetTexelDensityPerMeter?: number;
      patternDensityMultiplier?: number;
    }
  ): void {
    const geometry = mesh.geometry;
    geometry.computeBoundingBox();
    const bbox = geometry.boundingBox || new THREE.Box3();
    const size = new THREE.Vector3();
    bbox.getSize(size);

    // Classify surface
    const classification = classifyGeometrySurfaces(geometry, {
      patternDensityMultiplier: options?.patternDensityMultiplier
    });
    const dominantZone = options?.overrideZone ?? (
      classification.zoneCounts[ArchitecturalZone.MainShaft] > classification.zoneCounts[ArchitecturalZone.SlopedRoof]
        ? ArchitecturalZone.MainShaft
        : ArchitecturalZone.SlopedRoof
    );

    const profile = classification.zoneProfiles[dominantZone];

    // Configure PBR material
    const mat = mesh.material instanceof THREE.MeshStandardMaterial
      ? mesh.material
      : new THREE.MeshStandardMaterial();

    if (textureSuite.diffuse) {
      mat.map = textureSuite.diffuse;
      mat.map.wrapS = THREE.RepeatWrapping;
      mat.map.wrapT = THREE.RepeatWrapping;
      mat.map.repeat.set(profile.repeatU, profile.repeatV);
      mat.map.needsUpdate = true;
    }

    if (textureSuite.normal) {
      mat.normalMap = textureSuite.normal;
      mat.normalMap.wrapS = THREE.RepeatWrapping;
      mat.normalMap.wrapT = THREE.RepeatWrapping;
      mat.normalMap.repeat.set(profile.repeatU, profile.repeatV);
      mat.normalScale.set(profile.normalScale, profile.normalScale);
      mat.normalMap.needsUpdate = true;
    }

    if (textureSuite.roughness) {
      mat.roughnessMap = textureSuite.roughness;
      mat.roughnessMap.wrapS = THREE.RepeatWrapping;
      mat.roughnessMap.wrapT = THREE.RepeatWrapping;
      mat.roughnessMap.repeat.set(profile.repeatU, profile.repeatV);
      mat.roughness = profile.roughness;
      mat.roughnessMap.needsUpdate = true;
    }

    if (textureSuite.ao) {
      mat.aoMap = textureSuite.ao;
      mat.aoMapIntensity = profile.aoIntensity;
    }

    mat.metalness = profile.metalness;
    mat.needsUpdate = true;
    mesh.material = mat;
  }
}
