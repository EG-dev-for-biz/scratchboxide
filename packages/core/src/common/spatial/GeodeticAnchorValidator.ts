/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import { GeodeticAnchor } from './colmap-vector-reference-types';

export class GeospatialAssertionError extends Error {
  constructor(message: string) {
    super(`[GeospatialAssertionError] ${message}`);
    this.name = 'GeospatialAssertionError';
  }
}

export interface GeodeticValidationOptions {
  /**
   * If true, suppresses the Null Island guard for explicit test fixtures
   * located at (0.0, 0.0) in the Gulf of Guinea.
   */
  allowNullIsland?: boolean;
  /** Maximum allowable elevation in meters above MSL (default 9000m ~ Everest) */
  maxElevationMeters?: number;
  /** Minimum allowable elevation in meters (default -12000m ~ Mariana Trench) */
  minElevationMeters?: number;
}

/**
 * Geodetic Anchor Validator & Hardening Guard
 *
 * Validates real-world geographic anchors, enforces WGS-84 coordinate bounds,
 * verifies vertical datums, and strictly prevents synthetic/un-anchored assets
 * from being silently assigned dummy (0.0, 0.0) "Null Island" coordinates.
 */
export class GeodeticAnchorValidator {
  /**
   * Validates that an anchor strictly satisfies WGS-84 physical boundaries.
   * Throws GeospatialAssertionError on failure.
   */
  public static validate(
    anchor: unknown,
    options: GeodeticValidationOptions = {}
  ): asserts anchor is GeodeticAnchor {
    if (!anchor || typeof anchor !== 'object') {
      throw new GeospatialAssertionError(
        'GeodeticAnchor cannot be null, undefined, or non-object. ' +
        'If this asset is not geolocated, leave spatialAnchor as undefined.'
      );
    }

    const candidate = anchor as Record<string, any>;

    // 1. Latitude validation: [-90, +90] degrees
    if (typeof candidate.lat !== 'number' || !isFinite(candidate.lat)) {
      throw new GeospatialAssertionError(`Latitude must be a finite number. Received: ${candidate.lat}`);
    }
    if (candidate.lat < -90 || candidate.lat > 90) {
      throw new GeospatialAssertionError(
        `Latitude out of WGS-84 bounds [-90, +90]. Received: ${candidate.lat}`
      );
    }

    // 2. Longitude validation: [-180, +180] degrees
    if (typeof candidate.lng !== 'number' || !isFinite(candidate.lng)) {
      throw new GeospatialAssertionError(`Longitude must be a finite number. Received: ${candidate.lng}`);
    }
    if (candidate.lng < -180 || candidate.lng > 180) {
      throw new GeospatialAssertionError(
        `Longitude out of WGS-84 bounds [-180, +180]. Received: ${candidate.lng}`
      );
    }

    // 3. Elevation validation
    const minElev = options.minElevationMeters ?? -12000;
    const maxElev = options.maxElevationMeters ?? 9000;
    if (typeof candidate.elevationMeters !== 'number' || !isFinite(candidate.elevationMeters)) {
      throw new GeospatialAssertionError(
        `Elevation must be a finite number in meters. Received: ${candidate.elevationMeters}`
      );
    }
    if (candidate.elevationMeters < minElev || candidate.elevationMeters > maxElev) {
      throw new GeospatialAssertionError(
        `Elevation out of terrestrial physical limits [${minElev}m, ${maxElev}m]. Received: ${candidate.elevationMeters}m`
      );
    }

    // 4. NULL ISLAND ANTI-POISONING GUARD
    // Catches lazy/accidental assignment of (0.0, 0.0) to non-geolocated assets
    const isAtNullIsland = Math.abs(candidate.lat) < 0.0001 && Math.abs(candidate.lng) < 0.0001;
    if (isAtNullIsland && !options.allowNullIsland && !(candidate as any).allowNullIsland) {
      throw new GeospatialAssertionError(
        'Detected ungrounded "Null Island" coordinate (0.0, 0.0). ' +
        'Non-geolocated hero assets, isolated props, and CAD scenes must leave ' +
        'spatialAnchor as undefined rather than poisoning downstream solar ephemeris ' +
        'and GIS layers with dummy coordinates off the coast of Ghana.'
      );
    }

    // 5. Compass Heading validation (if present)
    if (candidate.headingDeg !== undefined) {
      if (typeof candidate.headingDeg !== 'number' || !isFinite(candidate.headingDeg)) {
        throw new GeospatialAssertionError(
          `Compass headingDeg must be a finite number. Received: ${candidate.headingDeg}`
        );
      }
    }

    // 6. Geoid Height validation (if present)
    if (candidate.geoidHeightMeters !== undefined) {
      if (typeof candidate.geoidHeightMeters !== 'number' || !isFinite(candidate.geoidHeightMeters)) {
        throw new GeospatialAssertionError(
          `geoidHeightMeters must be a finite number. Received: ${candidate.geoidHeightMeters}`
        );
      }
      // Terrestrial geoid undulation ranges between -107m (Indian Ocean low) and +86m (Iceland/Papua high)
      if (candidate.geoidHeightMeters < -150 || candidate.geoidHeightMeters > 150) {
        throw new GeospatialAssertionError(
          `geoidHeightMeters out of terrestrial Earth limits [-150m, +150m]. Received: ${candidate.geoidHeightMeters}m`
        );
      }
    }
  }

  /**
   * Returns true if the object is a valid GeodeticAnchor, without throwing.
   */
  public static isValid(anchor: unknown, options: GeodeticValidationOptions = {}): anchor is GeodeticAnchor {
    try {
      this.validate(anchor, options);
      return true;
    } catch {
      return false;
    }
  }
}
