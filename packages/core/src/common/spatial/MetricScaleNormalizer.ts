/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Metric unit taxonomy for incoming 3D models and geographic data sources.
 * Open string literal prevents closed taxonomy restrictions (ADA Pillar 1).
 */
export type MetricUnitType =
  | 'meters'
  | 'centimeters'
  | 'millimeters'
  | 'feet'
  | 'inches'
  | 'unit_box'
  | (string & {});

export interface MetricSanityRule {
  expectedMinMeters: number;
  expectedMaxMeters: number;
  description: string;
}

/**
 * Canonical physical category sanity constraints.
 * Used to detect and auto-correct unit mismatches (e.g. centimeters mistaken for meters).
 */
export const CANONICAL_METRIC_CATEGORY_BOUNDS: Record<string, MetricSanityRule> = {
  humanoid: { expectedMinMeters: 0.5, expectedMaxMeters: 2.5, description: 'Humanoid character' },
  vehicle: { expectedMinMeters: 1.0, expectedMaxMeters: 5.0, description: 'Automobile / ground vehicle' },
  aircraft: { expectedMinMeters: 3.0, expectedMaxMeters: 80.0, description: 'Aircraft / spacecraft' },
  furniture: { expectedMinMeters: 0.2, expectedMaxMeters: 3.0, description: 'Interior furniture / prop' },
  tabletop_prop: { expectedMinMeters: 0.02, expectedMaxMeters: 1.0, description: 'Tabletop object' },
  single_building: { expectedMinMeters: 3.0, expectedMaxMeters: 1000.0, description: 'Architectural edifice' },
  city_block: { expectedMinMeters: 50.0, expectedMaxMeters: 5000.0, description: 'Urban district / parcel' },
  landscape_terrain: { expectedMinMeters: 100.0, expectedMaxMeters: 100000.0, description: 'Geographic terrain' }
};

export interface MetricScaleNormalizationResult {
  /** The multiplicative scale factor required to convert input to standard SI meters */
  scaleFactorToMeters: number;
  /** Detected or explicitly confirmed unit */
  detectedUnit: MetricUnitType;
  /** Normalized bounding dimensions [width, height, depth] in meters */
  normalizedDimensionsMeters: [number, number, number];
  /** True if auto-correction was applied */
  wasCorrected: boolean;
  /** Diagnostic message explaining the transformation */
  auditMessage: string;
}

/**
 * Metric Scale Normalizer & Invariant Enforcer
 *
 * Enforces the primary Layer 1 architectural invariant:
 *   1 SCENE UNIT = 1.0 METER (SI)
 *
 * Guarantees that assets from neural diffusion (unit box [-1, 1]), Maya (centimeters),
 * CAD/BIM (millimeters/feet), and GIS sources are normalized to physical ground truth.
 */
export class MetricScaleNormalizer {
  /**
   * Converts a known metric unit directly to the meter conversion factor.
   */
  public static getUnitScaleFactor(unit: MetricUnitType): number {
    switch (unit.toLowerCase()) {
      case 'm':
      case 'meter':
      case 'meters':
        return 1.0;
      case 'cm':
      case 'centimeter':
      case 'centimeters':
        return 0.01;
      case 'mm':
      case 'millimeter':
      case 'millimeters':
        return 0.001;
      case 'ft':
      case 'foot':
      case 'feet':
      case 'survey_foot':
        return 0.3048;
      case 'in':
      case 'inch':
      case 'inches':
        return 0.0254;
      case 'km':
      case 'kilometer':
      case 'kilometers':
        return 1000.0;
      default:
        return 1.0;
    }
  }

  /**
   * Inspects raw bounding box dimensions, detects common unit mismatches, and normalizes
   * to SI meters.
   */
  public static normalizeDimensions(
    rawDimensions: [number, number, number],
    categoryHint?: string,
    declaredUnit?: MetricUnitType
  ): MetricScaleNormalizationResult {
    // If unit is explicitly declared and recognized, respect it
    if (declaredUnit && declaredUnit !== 'meters' && declaredUnit !== 'unit_box') {
      const factor = this.getUnitScaleFactor(declaredUnit);
      const normalizedDims: [number, number, number] = [
        rawDimensions[0] * factor,
        rawDimensions[1] * factor,
        rawDimensions[2] * factor
      ];
      return {
        scaleFactorToMeters: factor,
        detectedUnit: declaredUnit,
        normalizedDimensionsMeters: normalizedDims,
        wasCorrected: factor !== 1.0,
        auditMessage: `Explicitly scaled by factor ${factor} from declared unit '${declaredUnit}'.`
      };
    }

    const primaryDimension = Math.max(...rawDimensions);
    const height = rawDimensions[1];

    if (!categoryHint || !CANONICAL_METRIC_CATEGORY_BOUNDS[categoryHint]) {
      // Default: Assume SI meters unless it looks like an AI unit box [-1, 1] for an edifice/vehicle
      if (primaryDimension <= 1.5 && primaryDimension > 0.001 && categoryHint && /building|vehicle|district/i.test(categoryHint)) {
        // Suspected normalized unit box
        const targetPrimary = 10.0;
        const factor = targetPrimary / primaryDimension;
        return {
          scaleFactorToMeters: factor,
          detectedUnit: 'unit_box',
          normalizedDimensionsMeters: [rawDimensions[0] * factor, rawDimensions[1] * factor, rawDimensions[2] * factor],
          wasCorrected: true,
          auditMessage: `Detected unit-box asset scaled to typical ${categoryHint} primary dimension (${targetPrimary}m).`
        };
      }

      return {
        scaleFactorToMeters: 1.0,
        detectedUnit: 'meters',
        normalizedDimensionsMeters: [...rawDimensions],
        wasCorrected: false,
        auditMessage: 'Preserved native 1.0 meter scale (no category mismatch detected).'
      };
    }

    const bounds = CANONICAL_METRIC_CATEGORY_BOUNDS[categoryHint];

    // Case 1: Millimeters (e.g. human is 1800 units tall, car is 4500 units long)
    if (height > bounds.expectedMaxMeters * 400 || primaryDimension > bounds.expectedMaxMeters * 400) {
      const factor = 0.001;
      return {
        scaleFactorToMeters: factor,
        detectedUnit: 'millimeters',
        normalizedDimensionsMeters: [rawDimensions[0] * factor, rawDimensions[1] * factor, rawDimensions[2] * factor],
        wasCorrected: true,
        auditMessage: `Detected millimeters for '${categoryHint}' (height ${height.toFixed(1)} > expected max ${bounds.expectedMaxMeters}m). Scaled by 0.001.`
      };
    }

    // Case 2: Centimeters (e.g. human is 180 units tall, table is 90 units tall)
    if (height > bounds.expectedMaxMeters * 40 || primaryDimension > bounds.expectedMaxMeters * 40) {
      const factor = 0.01;
      return {
        scaleFactorToMeters: factor,
        detectedUnit: 'centimeters',
        normalizedDimensionsMeters: [rawDimensions[0] * factor, rawDimensions[1] * factor, rawDimensions[2] * factor],
        wasCorrected: true,
        auditMessage: `Detected centimeters for '${categoryHint}' (height ${height.toFixed(1)} > expected max ${bounds.expectedMaxMeters}m). Scaled by 0.01.`
      };
    }

    // Case 3: Inches / Feet (e.g. human is 70 inches tall)
    if (categoryHint === 'humanoid' && height >= 55 && height <= 85) {
      const factor = 0.0254; // inches to meters
      return {
        scaleFactorToMeters: factor,
        detectedUnit: 'inches',
        normalizedDimensionsMeters: [rawDimensions[0] * factor, rawDimensions[1] * factor, rawDimensions[2] * factor],
        wasCorrected: true,
        auditMessage: `Detected inches for humanoid (height ${height.toFixed(1)} in [55, 85]). Scaled by 0.0254 to ${(height * factor).toFixed(2)}m.`
      };
    }

    // Case 4: Neural unit box [-1, 1] (e.g. car or building with height <= 1.0 or significantly below category min)
    if ((height <= 1.0 && bounds.expectedMinMeters >= 0.8) || (height < bounds.expectedMinMeters * 0.6 && primaryDimension <= 1.5)) {
      const targetHeight = (bounds.expectedMinMeters + bounds.expectedMaxMeters) * 0.5;
      const factor = height > 0 ? targetHeight / height : 1.0;
      return {
        scaleFactorToMeters: factor,
        detectedUnit: 'unit_box',
        normalizedDimensionsMeters: [rawDimensions[0] * factor, rawDimensions[1] * factor, rawDimensions[2] * factor],
        wasCorrected: true,
        auditMessage: `Detected normalized unit-box for '${categoryHint}'. Rescaled height to ${targetHeight.toFixed(2)}m.`
      };
    }

    // Native meters confirmed
    return {
      scaleFactorToMeters: 1.0,
      detectedUnit: 'meters',
      normalizedDimensionsMeters: [...rawDimensions],
      wasCorrected: false,
      auditMessage: `Validated native metric bounds for '${categoryHint}'.`
    };
  }
}
