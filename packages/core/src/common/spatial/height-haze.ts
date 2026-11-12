/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Haze that thins with height: the density at height h above the layer's base is exp(-h / scaleHeight), and 1 at
 * and below the base. `hazeColumnFactor` is the mean of that density along a straight sight line between two
 * heights, so the optical depth of the line is (ground-level extinction) x (its length) x (this factor). It is 1 for
 * a line lying in the base, falls as either end rises, and is the same whichever end is the camera. The viewport's
 * aerial perspective pass evaluates the same expression per pixel (AerialPerspectiveEffect.ts, hazeColumnFactor).
 */
export function hazeColumnFactor(cameraHeightM: number, pointHeightM: number, scaleHeightM: number, baseAltitudeM = 0): number {
    if (!(scaleHeightM > 0)) return 1;
    const a = (cameraHeightM - baseAltitudeM) / scaleHeightM, b = (pointHeightM - baseAltitudeM) / scaleHeightM;
    // the integral of the density from height 0 up to t (in scale heights): t below the base, 1 - exp(-t) above it
    const column = (t: number) => (t <= 0 ? t : 1 - Math.exp(-t));
    const span = b - a;
    if (Math.abs(span) < 1e-4) return a <= 0 ? 1 : Math.exp(-a);
    return (column(b) - column(a)) / span;
}

/** Ground-level extinction, per metre, of a haze with this visibility (Koschmieder: 2% contrast at the visibility); 0 for none. */
export function hazeExtinctionPerM(visibilityM: number | undefined): number {
    return typeof visibilityM === 'number' && Number.isFinite(visibilityM) && visibilityM > 0 ? 3.912 / visibilityM : 0;
}

/** The same expression in GLSL, for the aerial perspective pass. */
export const HAZE_COLUMN_FACTOR_GLSL = /* glsl */`
float hazeColumn(float t) { return t <= 0.0 ? t : 1.0 - exp(-t); }
float hazeColumnFactor(float cameraHeight, float pointHeight, float scaleHeight, float baseAltitude) {
    if (scaleHeight <= 0.0) return 1.0;
    float a = (cameraHeight - baseAltitude) / scaleHeight;
    float b = (pointHeight - baseAltitude) / scaleHeight;
    float span = b - a;
    if (abs(span) < 1e-4) return a <= 0.0 ? 1.0 : exp(-a);
    return (hazeColumn(b) - hazeColumn(a)) / span;
}
`;
