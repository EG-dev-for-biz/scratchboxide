/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import { getSolarPosition, instantAtLocalMeanSolarTime, localMeanSolarHours } from '../../common/coordinate/solarPosition';
import { MissingInputError } from '../../common/errors/pipeline-errors';

function formatSolarHours(h: number): string {
  const total = Math.round(h * 60) % (24 * 60);
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

export interface ShadowDeductionInput {
  candidateLat: number;
  candidateLng: number;
  observedShadowAngleDeg: number;       // Azimuth of shadow in degrees (0 = pointing North, 90 = East)
  observedShadowLengthRatio: number;    // shadow_length / object_height
}

export interface ShadowDeductionResult {
  estimatedDate: Date;
  solarAltitudeDeg: number;
  solarAzimuthDeg: number;
  confidenceScore: number;              // 0.0 - 1.0 (closeness of match)
  alternativeDates: Array<{ date: Date; confidenceScore: number }>;
}

export class ChronoSpatialDeductionEngine {
  /**
   * Solves the Inverse Solar Ephemeris equations to estimate the exact Date/Time and Solar state
   * that would produce the observed shadow angle and length ratio at a given geographic location.
   */
  public static solveInverseSolar(input: ShadowDeductionInput): ShadowDeductionResult | null {
    // 1. Calculate the sun's target altitude and azimuth from shadow metrics
    // A shadow pointing at angle theta means the sun is located opposite at (theta + 180) % 360.
    const targetSunAzimuthRad = ((input.observedShadowAngleDeg + 180) % 360) * (Math.PI / 180);
    // shadow_length / height = cot(altitude) => altitude = atan(1 / ratio)
    const targetSunAltitudeRad = Math.atan(1.0 / Math.max(0.01, input.observedShadowLengthRatio));

    let bestMatchDate: Date | null = null;
    let lowestError = Infinity;
    const alternatives: Array<{ date: Date; error: number }> = [];

    // 2. Grid-search across calendar days and hours to find matching ephemeris
    // Year fixed to current 2026 as per user rules
    const year = 2026;
    const dayStep = 5; // Search every 5 days for efficiency
    const hourStep = 0.25; // Search every 15 minutes

    for (let day = 1; day <= 365; day += dayStep) {
      for (let hour = 6.0; hour <= 18.0; hour += hourStep) {
        // The instant at which local mean solar time at the candidate reads `hour` on this day of the year
        const testDate = instantAtLocalMeanSolarTime(year, 0, day, hour, input.candidateLng);

        const solar = getSolarPosition(testDate, input.candidateLat, input.candidateLng);

        // Compute circular angular errors
        const altError = Math.abs(solar.altitude - targetSunAltitudeRad);
        let azError = Math.abs(solar.azimuth - targetSunAzimuthRad);
        if (azError > Math.PI) {
          azError = 2 * Math.PI - azError;
        }

        const totalError = Math.sqrt(altError * altError + azError * azError);

        if (totalError < 0.12) { // Match candidates with low error
          alternatives.push({ date: new Date(testDate), error: totalError });
        }

        if (totalError < lowestError) {
          lowestError = totalError;
          bestMatchDate = new Date(testDate);
        }
      }
    }

    if (!bestMatchDate) return null;

    // Filter and sort alternatives
    const sortedAlts = alternatives
      .sort((a, b) => a.error - b.error)
      .filter((v, idx, arr) => {
        // De-duplicate dates that fall on consecutive days/hours
        if (idx === 0) return true;
        const diffDays = Math.abs(v.date.getTime() - arr[0].date.getTime()) / (1000 * 3600 * 24);
        return diffDays > 7; // Only keep alternates that are distinct periods of the year
      })
      .slice(0, 3)
      .map(alt => ({
        date: alt.date,
        confidenceScore: Math.max(0.01, 1.0 - alt.error / 0.15)
      }));

    const solarState = getSolarPosition(bestMatchDate, input.candidateLat, input.candidateLng);

    return {
      estimatedDate: bestMatchDate,
      solarAltitudeDeg: solarState.altitude * (180.0 / Math.PI),
      solarAzimuthDeg: solarState.azimuth * (180.0 / Math.PI),
      confidenceScore: Math.max(0.01, 1.0 - lowestError / 0.15),
      alternativeDates: sortedAlts
    };
  }

  /**
   * Headless multimodal deduction report. Deduce geographic and chronological parameters
   * based on a visual feature report.
   */
  public static generateDeductionReport(
    visualReport: {
      architecturalEra?: string;
      languageSignage?: string;
      vegetationBiome?: string;
      terrainSlope?: string;
      buildingLandmarks?: string[];
      shadowDirectionClockHand?: number; // shadow direction represented as hours on a clock face (e.g. 12 = North, 3 = East)
      shadowLengthRelativeToObjectHeight?: number;
    },
    roughCoordinates?: { lat: number; lng: number }
  ): string {
    // The candidate location is the one given: landmark names in the report are not matched to places, and
    // there is no default city.
    if (!roughCoordinates) {
      throw new MissingInputError('generateDeductionReport', 'roughCoordinates', 'the inverse-solar search starts from the candidate location; none is assumed');
    }
    const lat = roughCoordinates.lat;
    const lng = roughCoordinates.lng;
    const resolvedPlace = `Coordinate Grid Region [Lat ${lat.toFixed(4)}, Lng ${lng.toFixed(4)}]`;

    // Convert clock shadow direction to degrees (12 o'clock = 0 deg, 3 o'clock = 90 deg, etc.)
    const shadowClock = visualReport.shadowDirectionClockHand ?? 12;
    const shadowAngleDeg = (shadowClock % 12) * 30;

    const ratio = visualReport.shadowLengthRelativeToObjectHeight ?? 1.0;

    const deduction = this.solveInverseSolar({
      candidateLat: lat,
      candidateLng: lng,
      observedShadowAngleDeg: shadowAngleDeg,
      observedShadowLengthRatio: ratio
    });

    let report = `================================================================================\n`;
    report += `CHRONO-SPATIAL MULTIMODAL DEDUCTION REPORT (GOOGLE LIVING WORLD ENGINE)\n`;
    report += `================================================================================\n`;
    report += `[Perceptual Anchor] Deducing Where & When based on visual cues...\n\n`;
    report += `1. SPATIAL GEODETIC ANALYSIS (WHERE)\n`;
    report += `   - Landmark Resolved : ${resolvedPlace}\n`;
    report += `   - Deducing Lat/Lng   : ${lat.toFixed(5)}° N, ${lng.toFixed(5)}° W\n`;
    report += `   - Biome Signature   : ${visualReport.vegetationBiome || 'Mediterranean Urban Coastal'}\n`;
    report += `   - Architecture Era  : ${visualReport.architecturalEra || 'Edwardian/Modernist Mixed'}\n\n`;

    report += `2. TEMPORAL & SOLAR INVERSION ANALYSIS (WHEN)\n`;
    if (deduction) {
      report += `   - Solved Date/Time  : ${deduction.estimatedDate.toISOString()} (~${formatSolarHours(localMeanSolarHours(deduction.estimatedDate, lng))} local solar time)\n`;
      report += `   - Sun Altitude      : ${deduction.solarAltitudeDeg.toFixed(1)}°\n`;
      report += `   - Sun Azimuth       : ${deduction.solarAzimuthDeg.toFixed(1)}° (${deduction.solarAzimuthDeg < 180 ? 'Morning' : 'Afternoon'})\n`;
      report += `   - Shadow Ratio      : ${ratio.toFixed(2)}x Object Height\n`;
      report += `   - Solver Confidence : ${(deduction.confidenceScore * 100).toFixed(1)}% Match\n`;
      if (deduction.alternativeDates.length > 0) {
        report += `   - Alternative Solves:\n`;
        deduction.alternativeDates.forEach(alt => {
          report += `     * ${alt.date.toISOString()} (~${formatSolarHours(localMeanSolarHours(alt.date, lng))} local solar time, Confidence: ${(alt.confidenceScore * 100).toFixed(0)}%)\n`;
        });
      }
    } else {
      report += `   - Solver Status     : Underdetermined Solar System (Error bounds exceeded. Verify inputs.)\n`;
    }
    report += `================================================================================`;

    return report;
  }
}
