/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Three-way primary color balance wheel channel.
 */
export interface AdaptiveColorChannel {
  r: number;
  g: number;
  b: number;
  master: number;
}

/**
 * CIELAB Color Representation
 */
export interface AdaptiveLabColor {
  L: number; // 0 to 100
  a: number; // -128 to 127 (Green to Red)
  b: number; // -128 to 127 (Blue to Yellow)
}

/**
 * Universal style representation extracted dynamically from any reference image.
 * No closed style enums are used, ensuring infinite semantic range.
 */
export interface AdaptiveWorldStyleContract {
  // Photometric, Lighting & Color Grading Domain
  photometric: {
    shadowLift: number;              // 0.0 to 1.0 (crevice recovery)
    highlightCompress: number;       // 0.0 to 1.0 (burn reduction)
    contrastPivot: number;           // Midpoint pivot (default 0.435)
    colorTemperatureK: number;       // 1000K to 40000K
    colorGradingWheel: {
      lift: AdaptiveColorChannel;
      gamma: AdaptiveColorChannel;
      gain: AdaptiveColorChannel;
    };
    lutStrength: number;             // 0.0 to 1.0
  };
  // Surface Micro-Detail & Frequency Induction
  microSurface: {
    detailFrequency: number;         // Spatial tiling frequency
    normalPerturbationScale: number; // 0.0 (smooth) to 1.0 (heavily textured)
    cavitationDepth: number;         // Porous depth for stone/concrete
    roughnessBias: number;           // PBR roughness modifier
    specularGlintIntensity: number;  // Micro-facet specular highlights
  };
  // Geometric & Edge Outline Modulation
  geometricContours: {
    enabled: boolean;
    depthThreshold: number;          // Silhouette sensitivity
    normalThreshold: number;         // Surface crease sensitivity
    lineWidth: number;               // Pixel width of ink outlines
    inkColor: [number, number, number]; // RGB ink outline color
    jitter: number;                  // Hand-drawn line waviness
  };
  // Quantization & Non-Photorealistic Stylization
  stylizationFilter: {
    quantizationBands: number;       // 0 = continuous photoreal, 2-8 = cel bands
    quantizationSoftness: number;    // Ramp transition steepness
    kuwaharaRadius: number;          // 0 = off, 1-8 = painterly filter radius
    halftoneDensity: number;         // 0 = off, >0 = Ben-Day dot frequency
    ditherMatrixSize: number;        // 0 = off, 4 = 4x4 Bayer, 8 = 8x8 Bayer
  };
  // View-Dependent Projection Anchor
  cameraProjection?: {
    enabled: boolean;
    position: [number, number, number];
    target: [number, number, number];
    fovDeg: number;
    grazingAngleCutoff: number;      // Prevent texture stretching (dot-product limit)
    referenceImageUri: string;
  };
}

/**
 * Default style contract representing clean, neutral de-lighted photorealism.
 */
export const DEFAULT_ADAPTIVE_STYLE_CONTRACT: AdaptiveWorldStyleContract = {
  photometric: {
    shadowLift: 0.45,
    highlightCompress: 0.35,
    contrastPivot: 0.435,
    colorTemperatureK: 6500,
    colorGradingWheel: {
      lift: { r: 1.0, g: 1.0, b: 1.0, master: 1.0 },
      gamma: { r: 1.0, g: 1.0, b: 1.0, master: 1.0 },
      gain: { r: 1.0, g: 1.0, b: 1.0, master: 1.0 }
    },
    lutStrength: 1.0
  },
  microSurface: {
    detailFrequency: 12.0,
    normalPerturbationScale: 0.15,
    cavitationDepth: 0.1,
    roughnessBias: 0.0,
    specularGlintIntensity: 0.2
  },
  geometricContours: {
    enabled: false,
    depthThreshold: 0.1,
    normalThreshold: 0.1,
    lineWidth: 1.5,
    inkColor: [0.05, 0.05, 0.05],
    jitter: 0.0
  },
  stylizationFilter: {
    quantizationBands: 0,
    quantizationSoftness: 0.15,
    kuwaharaRadius: 0,
    halftoneDensity: 0,
    ditherMatrixSize: 0
  }
};
