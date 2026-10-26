/*
 * WeatheringService: Procedural aging and weathering texture synthesis
 * Maps material type + age + climate → calibrated wear, corrosion, patina textures
 * Returns 4K texture maps (color, normal, roughness, metallic)
 */

import * as fs from 'fs';
import * as path from 'path';

// ============================================================================
// Material Calibration Library
// ============================================================================

export interface MaterialAgeProgression {
  age: number; // years
  albedo: [number, number, number];
  roughness: number;
  metallic?: number;
}

export interface WeatheringModifier {
  rustRate: number; // 0.5-2.0x multiplier
  pittingDepth: number; // geometric micro-relief intensity
  saltBloom?: number; // 0-1, white/grey corrosion products
  uvFading?: number; // 0-1, desaturation from UV
  pollutionStain?: number; // 0-1, dark organic stain
}

export interface MaterialCalibration {
  name: string;
  baseColor: [number, number, number];
  ageColorProgression: MaterialAgeProgression[];
  climateModifiers: {
    marine?: WeatheringModifier;
    urban?: WeatheringModifier;
    alpine?: WeatheringModifier;
    desert?: WeatheringModifier;
    temperate?: WeatheringModifier;
    [key: string]: WeatheringModifier | undefined;
  };
  exposureMultipliers: {
    exposed: number;
    semi_sheltered: number;
    sheltered: number;
  };
  baseRoughness: number;
  baseMetallic: number;
}

const MATERIAL_LIBRARY: Record<string, MaterialCalibration> = {
  // Cast iron: oxidizes from reddish-orange → dark rust → stabilized brown
  cast_iron: {
    name: 'Cast Iron',
    baseColor: [0.85, 0.58, 0.40], // Fresh reddish-orange
    ageColorProgression: [
      { age: 0, albedo: [0.85, 0.58, 0.40], roughness: 0.65 },
      { age: 10, albedo: [0.78, 0.52, 0.36], roughness: 0.68 },
      { age: 20, albedo: [0.72, 0.48, 0.35], roughness: 0.70 },
      { age: 40, albedo: [0.60, 0.38, 0.28], roughness: 0.74 },
      { age: 60, albedo: [0.45, 0.28, 0.20], roughness: 0.76 }, // Heavy rust
      { age: 100, albedo: [0.42, 0.26, 0.19], roughness: 0.77 },
      { age: 200, albedo: [0.38, 0.25, 0.18], roughness: 0.76 } // Stabilized
    ],
    climateModifiers: {
      marine: { rustRate: 1.8, pittingDepth: 2.0, saltBloom: 0.4 },
      urban: { rustRate: 1.3, pittingDepth: 1.2, pollutionStain: 0.25 },
      alpine: { rustRate: 0.9, pittingDepth: 1.0, uvFading: 0.15 },
      temperate: { rustRate: 1.0, pittingDepth: 1.0 },
      desert: { rustRate: 0.6, pittingDepth: 0.5, uvFading: 0.35 }
    },
    exposureMultipliers: {
      exposed: 1.0,
      semi_sheltered: 0.65,
      sheltered: 0.35
    },
    baseRoughness: 0.65,
    baseMetallic: 0.2
  },

  // Copper: oxidizes from bright orange → green patina (verdigris)
  copper: {
    name: 'Copper',
    baseColor: [0.95, 0.73, 0.48], // Bright copper
    ageColorProgression: [
      { age: 0, albedo: [0.95, 0.73, 0.48], roughness: 0.40 },
      { age: 5, albedo: [0.88, 0.65, 0.42], roughness: 0.45 },
      { age: 15, albedo: [0.70, 0.55, 0.38], roughness: 0.50 },
      { age: 30, albedo: [0.48, 0.52, 0.45], roughness: 0.55 }, // Patina starting
      { age: 60, albedo: [0.38, 0.55, 0.48], roughness: 0.60 }, // Green patina
      { age: 150, albedo: [0.35, 0.50, 0.45], roughness: 0.65 } // Deep verdigris
    ],
    climateModifiers: {
      marine: { rustRate: 2.0, pittingDepth: 1.8, saltBloom: 0.3 },
      urban: { rustRate: 1.5, pittingDepth: 1.2, pollutionStain: 0.2 },
      temperate: { rustRate: 1.0, pittingDepth: 0.8 },
      alpine: { rustRate: 0.8, pittingDepth: 0.7 },
      desert: { rustRate: 0.5, pittingDepth: 0.4, uvFading: 0.25 }
    },
    exposureMultipliers: {
      exposed: 1.0,
      semi_sheltered: 0.7,
      sheltered: 0.4
    },
    baseRoughness: 0.40,
    baseMetallic: 0.6
  },

  // Weathering steel: develops stable rust layer, minimal further change
  weathering_steel: {
    name: 'Weathering Steel',
    baseColor: [0.65, 0.40, 0.25], // Raw steel
    ageColorProgression: [
      { age: 0, albedo: [0.65, 0.40, 0.25], roughness: 0.60 },
      { age: 3, albedo: [0.55, 0.35, 0.22], roughness: 0.68 },
      { age: 10, albedo: [0.50, 0.32, 0.20], roughness: 0.70 }, // Stable rust
      { age: 50, albedo: [0.48, 0.30, 0.19], roughness: 0.70 }, // No further change
      { age: 200, albedo: [0.48, 0.30, 0.19], roughness: 0.70 }
    ],
    climateModifiers: {
      marine: { rustRate: 0.8, pittingDepth: 1.2, saltBloom: 0.2 },
      urban: { rustRate: 0.9, pittingDepth: 1.0, pollutionStain: 0.15 },
      temperate: { rustRate: 1.0, pittingDepth: 1.0 },
      alpine: { rustRate: 0.9, pittingDepth: 0.9 },
      desert: { rustRate: 0.7, pittingDepth: 0.6, uvFading: 0.2 }
    },
    exposureMultipliers: {
      exposed: 1.0,
      semi_sheltered: 0.8,
      sheltered: 0.5
    },
    baseRoughness: 0.60,
    baseMetallic: 0.3
  },

  // Stone: develops lichen/moss staining and micro-erosion
  limestone: {
    name: 'Limestone',
    baseColor: [0.92, 0.90, 0.85], // Pale cream
    ageColorProgression: [
      { age: 0, albedo: [0.92, 0.90, 0.85], roughness: 0.55 },
      { age: 20, albedo: [0.85, 0.82, 0.75], roughness: 0.58 },
      { age: 50, albedo: [0.78, 0.75, 0.68], roughness: 0.62 },
      { age: 100, albedo: [0.72, 0.68, 0.60], roughness: 0.65 },
      { age: 200, albedo: [0.68, 0.63, 0.55], roughness: 0.68 } // Deep weathering
    ],
    climateModifiers: {
      marine: { rustRate: 1.5, pittingDepth: 1.6, saltBloom: 0.25 },
      urban: { rustRate: 1.4, pittingDepth: 1.2, pollutionStain: 0.4 },
      alpine: { rustRate: 0.8, pittingDepth: 1.4 }, // Frost damage
      temperate: { rustRate: 1.0, pittingDepth: 1.0 },
      desert: { rustRate: 0.4, pittingDepth: 0.5, uvFading: 0.3 }
    },
    exposureMultipliers: {
      exposed: 1.0,
      semi_sheltered: 0.7,
      sheltered: 0.4
    },
    baseRoughness: 0.55,
    baseMetallic: 0.0
  },

  // Fallback: generic aged metal
  metal_generic: {
    name: 'Metal (Generic)',
    baseColor: [0.75, 0.60, 0.45],
    ageColorProgression: [
      { age: 0, albedo: [0.75, 0.60, 0.45], roughness: 0.60 },
      { age: 30, albedo: [0.60, 0.42, 0.30], roughness: 0.70 },
      { age: 100, albedo: [0.50, 0.35, 0.25], roughness: 0.75 }
    ],
    climateModifiers: {
      marine: { rustRate: 1.5, pittingDepth: 1.5 },
      urban: { rustRate: 1.2, pittingDepth: 1.0 },
      temperate: { rustRate: 1.0, pittingDepth: 1.0 },
      alpine: { rustRate: 0.8, pittingDepth: 0.8 },
      desert: { rustRate: 0.6, pittingDepth: 0.5 }
    },
    exposureMultipliers: {
      exposed: 1.0,
      semi_sheltered: 0.7,
      sheltered: 0.4
    },
    baseRoughness: 0.60,
    baseMetallic: 0.2
  }
};

// ============================================================================
// Weathering Service Interface & Implementation
// ============================================================================

export interface WeatheringParams {
  material: string; // 'cast_iron', 'copper', 'limestone', etc.
  ageYears: number; // 0–200+
  climateZone: string; // 'marine', 'urban', 'alpine', 'desert', 'temperate'
  exposureType: string; // 'exposed', 'semi_sheltered', 'sheltered'
  textureWidth?: number; // default 4096
  textureHeight?: number; // default 4096
  baseColor?: [number, number, number]; // override
}

export interface WeatheringOutput {
  colorMap: Uint8Array; // RGB sRGB [width, height, 3]
  normalMap: Uint8Array; // OpenGL normal [width, height, 3]
  roughnessMap: Uint8Array; // Single-channel [width, height, 1]
  metallicMap?: Uint8Array; // Single-channel [width, height, 1]
  metadata: {
    material: string;
    ageYears: number;
    climate: string;
    exposure: string;
    confidence: number; // 0-1
    notes: string;
  };
}

export class WeatheringService {
  private library: Record<string, MaterialCalibration> = MATERIAL_LIBRARY;

  /**
   * Generate weathering textures for a material based on age and climate.
   */
  async synthesizeWeathering(params: WeatheringParams): Promise<WeatheringOutput> {
    const {
      material,
      ageYears,
      climateZone,
      exposureType,
      textureWidth = 4096,
      textureHeight = 4096,
      baseColor
    } = params;

    // Get material calibration
    const calib = this.library[material] || this.library.metal_generic;

    // Interpolate age-based color and roughness
    const ageState = this.interpolateAgeProgression(calib.ageColorProgression, ageYears);
    const baseAlbedo = baseColor || ageState.albedo;

    // Get climate modifier
    const climateModifier = calib.climateModifiers[climateZone] || calib.climateModifiers.temperate || {
      rustRate: 1.0,
      pittingDepth: 1.0
    };

    // Get exposure multiplier
    const exposureMult = calib.exposureMultipliers[exposureType as keyof typeof calib.exposureMultipliers] ?? 1.0;

    // Synthesize texture maps
    const maps = this.generateTextureMaps(
      textureWidth,
      textureHeight,
      baseAlbedo,
      ageState.roughness,
      climateModifier,
      exposureMult,
      calib.baseMetallic
    );

    return {
      colorMap: maps.colorMap,
      normalMap: maps.normalMap,
      roughnessMap: maps.roughnessMap,
      metallicMap: maps.metallicMap,
      metadata: {
        material: calib.name,
        ageYears,
        climate: climateZone,
        exposure: exposureType,
        confidence: this.estimateConfidence(material, climateZone),
        notes: `${calib.name}, aged ${ageYears} years in ${climateZone} climate (${exposureType}). Rust rate: ${(climateModifier.rustRate * 100).toFixed(0)}%, pitting: ${(climateModifier.pittingDepth * 100).toFixed(0)}%.`
      }
    };
  }

  private interpolateAgeProgression(
    progression: MaterialAgeProgression[],
    targetAge: number
  ): { albedo: [number, number, number]; roughness: number } {
    if (progression.length === 0) {
      return { albedo: [0.5, 0.5, 0.5], roughness: 0.65 };
    }

    // Find bracketing ages
    let lower = progression[0];
    let upper = progression[progression.length - 1];

    for (let i = 0; i < progression.length - 1; i++) {
      if (progression[i].age <= targetAge && progression[i + 1].age > targetAge) {
        lower = progression[i];
        upper = progression[i + 1];
        break;
      }
    }

    // Clamp if out of range
    if (targetAge <= progression[0].age) {
      return { albedo: progression[0].albedo, roughness: progression[0].roughness };
    }
    if (targetAge >= progression[progression.length - 1].age) {
      const last = progression[progression.length - 1];
      return { albedo: last.albedo, roughness: last.roughness };
    }

    // Linear interpolation
    const t = (targetAge - lower.age) / (upper.age - lower.age);
    const albedo: [number, number, number] = [
      lower.albedo[0] + (upper.albedo[0] - lower.albedo[0]) * t,
      lower.albedo[1] + (upper.albedo[1] - lower.albedo[1]) * t,
      lower.albedo[2] + (upper.albedo[2] - lower.albedo[2]) * t
    ];
    const roughness = lower.roughness + (upper.roughness - lower.roughness) * t;

    return { albedo, roughness };
  }

  private generateTextureMaps(
    width: number,
    height: number,
    baseAlbedo: [number, number, number],
    baseRoughness: number,
    climateModifier: WeatheringModifier,
    exposureMult: number,
    baseMetallic: number
  ) {
    const colorMap = new Uint8Array(width * height * 3);
    const normalMap = new Uint8Array(width * height * 3);
    const roughnessMap = new Uint8Array(width * height);
    const metallicMap = new Uint8Array(width * height);

    // Procedurally fill maps with Perlin-like noise simulation
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const idx = (y * width + x) * 3;
        const roughIdx = y * width + x;

        // Simulate multi-scale noise for weathering variation
        // Normalize noise to [0, 1]
        const noise = (this.simplexNoise(x, y, width, height) + 1) * 0.5;
        const weatheringIntensity = noise * climateModifier.rustRate * exposureMult;

        // Color variation based on rust/patina
        const darkenFactor = Math.min(1.0, weatheringIntensity);
        const colorVar = this.generateColorVariation(baseAlbedo, climateModifier, darkenFactor);

        colorMap[idx] = Math.round(colorVar[0] * 255);
        colorMap[idx + 1] = Math.round(colorVar[1] * 255);
        colorMap[idx + 2] = Math.round(colorVar[2] * 255);

        // Roughness: increases significantly with weathering (aggressive scaling)
        const roughVar = Math.min(1.0, baseRoughness + weatheringIntensity * 0.25);
        roughnessMap[roughIdx] = Math.round(roughVar * 255);

        // Metallic: decreases with oxidation
        const metalVar = Math.max(0.0, baseMetallic - weatheringIntensity * 0.5);
        metallicMap[roughIdx] = Math.round(metalVar * 255);

        // Normal map: add subtle micro-relief from pitting
        const pittingNoise = this.simplexNoise(x * 2, y * 2, width, height);
        const normalScale = climateModifier.pittingDepth * exposureMult * 0.3;
        normalMap[idx] = Math.round((0.5 + pittingNoise * normalScale) * 255);
        normalMap[idx + 1] = Math.round((0.5 + pittingNoise * normalScale) * 255);
        normalMap[idx + 2] = 255; // Neutral Z
      }
    }

    return { colorMap, normalMap, roughnessMap, metallicMap };
  }

  private generateColorVariation(
    baseAlbedo: [number, number, number],
    climateModifier: WeatheringModifier,
    darkenFactor: number
  ): [number, number, number] {
    // Simulate rust bloom and patina
    const rustColor: [number, number, number] = [0.45, 0.28, 0.20]; // Dark rust brown
    const bloomColor: [number, number, number] = [0.70, 0.65, 0.60]; // Light bloom

    let color: [number, number, number] = [...baseAlbedo] as [number, number, number];

    // Add rust coloration (apply rust rate as multiplier)
    if (climateModifier.rustRate > 0) {
      // Rust factor is scaled by rust rate: higher rate = more rust effect
      const rustFactor = Math.min(1.0, darkenFactor * climateModifier.rustRate / 2);
      color[0] = color[0] * (1 - rustFactor) + rustColor[0] * rustFactor;
      color[1] = color[1] * (1 - rustFactor) + rustColor[1] * rustFactor;
      color[2] = color[2] * (1 - rustFactor) + rustColor[2] * rustFactor;
    }

    // Add salt bloom if coastal (marine environments)
    if (climateModifier.saltBloom && climateModifier.saltBloom > 0) {
      const bloomFactor = Math.min(1.0, darkenFactor * climateModifier.saltBloom);
      color[0] = color[0] * (1 - bloomFactor) + bloomColor[0] * bloomFactor;
      color[1] = color[1] * (1 - bloomFactor) + bloomColor[1] * bloomFactor;
      color[2] = color[2] * (1 - bloomFactor) + bloomColor[2] * bloomFactor;
    }

    // Add pollution stain (urban environments)
    if (climateModifier.pollutionStain && climateModifier.pollutionStain > 0) {
      const stainColor: [number, number, number] = [0.35, 0.35, 0.35]; // Dark grey
      const stainFactor = Math.min(1.0, darkenFactor * climateModifier.pollutionStain);
      color[0] = color[0] * (1 - stainFactor) + stainColor[0] * stainFactor;
      color[1] = color[1] * (1 - stainFactor) + stainColor[1] * stainFactor;
      color[2] = color[2] * (1 - stainFactor) + stainColor[2] * stainFactor;
    }

    // Add UV fading (desaturation)
    if (climateModifier.uvFading && climateModifier.uvFading > 0) {
      const grey = (color[0] + color[1] + color[2]) / 3;
      const fadeFactor = darkenFactor * climateModifier.uvFading;
      color[0] = color[0] * (1 - fadeFactor) + grey * fadeFactor;
      color[1] = color[1] * (1 - fadeFactor) + grey * fadeFactor;
      color[2] = color[2] * (1 - fadeFactor) + grey * fadeFactor;
    }

    return color;
  }

  private simplexNoise(x: number, y: number, w: number, h: number): number {
    // Simplified Perlin-like noise for demo (in production, use a proper noise library)
    const xf = (x / w) * 8;
    const yf = (y / h) * 8;

    const xi = Math.floor(xf);
    const yi = Math.floor(yf);
    const xn = xf - xi;
    const yn = yf - yi;

    // Hash-based pseudo-random
    const hash = (a: number, b: number) => {
      const x = Math.sin((a + b * 9.898) * 23.14) * 43758.5453;
      return x - Math.floor(x);
    };

    const n00 = hash(xi, yi);
    const n10 = hash(xi + 1, yi);
    const n01 = hash(xi, yi + 1);
    const n11 = hash(xi + 1, yi + 1);

    // Smoothstep interpolation
    const sx = 3 * xn * xn - 2 * xn * xn * xn;
    const sy = 3 * yn * yn - 2 * yn * yn * yn;

    const nx0 = n00 * (1 - sx) + n10 * sx;
    const nx1 = n01 * (1 - sx) + n11 * sx;
    const result = nx0 * (1 - sy) + nx1 * sy;

    return (result - 0.5) * 2; // Center around 0
  }

  private estimateConfidence(material: string, climateZone: string): number {
    // Higher confidence for well-calibrated combinations
    const hasMaterial = !!this.library[material];
    const wellKnownClimate = ['marine', 'urban', 'alpine', 'desert', 'temperate'].includes(climateZone);

    if (hasMaterial && wellKnownClimate) return 0.95;
    if (hasMaterial) return 0.85;
    if (wellKnownClimate) return 0.70;
    return 0.60;
  }

  /**
   * Get available materials
   */
  getAvailableMaterials(): string[] {
    return Object.keys(this.library);
  }

  /**
   * Get material details
   */
  getMaterialCalibration(material: string): MaterialCalibration | undefined {
    return this.library[material];
  }
}

export const weatheringService = new WeatheringService();
