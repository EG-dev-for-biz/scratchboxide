/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * One set of light numbers for an atmospheric scene: the sky dome, the hemisphere fill and the aerial perspective's haze
 * all come from the same physical sky table (physical-sky.ts) and sun, and the camera's exposure is metered from them.
 *
 * Scene units: the sun light's intensity is the diurnal profile's (the Bird clear-sky split); the sky's level (the
 * luminance of its irradiance on a level surface) is the profile's while the sun is up, and below the horizon follows
 * the physical table down from the sunset value, so twilight darkens as the Earth's shadow rises instead of handing over
 * to a palette.
 */

import type { PhysicalSkyLut } from './physical-sky';

type V3 = [number, number, number];

export const luminance = (c: ArrayLike<number>): number => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];

/** The colour of the sky's light on a level surface, scaled to luminance 1 (the hemisphere light's colour). */
export function skyIrradianceChroma(lut: PhysicalSkyLut): V3 {
    const e = lut.horizontalIrradiance, y = luminance(e);
    if (!(y > 0)) return [1, 1, 1];
    return [e[0] / y, e[1] / y, e[2] / y];
}

/**
 * The night's generated fill, as level-surface luminance in scene units: moonlit air and airglow under the sky, and a
 * stand-in moon (no lunar ephemeris). The moon is set so an 18% grey card it lights shows above the night sky beside it,
 * as under a real moon (measured with a grey orb by the ESB at -12°: at 0.063 the card read 0.001 against a sky of
 * 0.027, a black disc; at 0.27 the lit side sits above the sky and the dark side well under it).
 */
export const NIGHT_SKY_LIGHT_FLOOR = 0.037;
export const NIGHT_MOON_INTENSITY = 0.27;

/** How far the night fill has come in: 0 with the sun 2° below the horizon, 1 at 12° below (smoothstep). */
export function nightFillWeight(sunElevationDeg: number): number {
    const n = Math.min(1, Math.max(0, (-2 - sunElevationDeg) / 10));
    return n * n * (3 - 2 * n);
}

/**
 * The level of the sky's light (luminance of its irradiance on a level surface, scene units).
 * `dayLevel` is the profile's while the sun is up; `sunsetLevel` and `sunsetLut` anchor the twilight to it.
 */
export function physicalSkyLevel(sunElevationDeg: number, lut: PhysicalSkyLut, dayLevel: number, sunsetLevel: number, sunsetLut: PhysicalSkyLut): number {
    if (sunElevationDeg > 0) return dayLevel;
    return sunsetLevel * luminance(lut.horizontalIrradiance) / Math.max(1e-30, luminance(sunsetLut.horizontalIrradiance));
}

/** Level-surface illuminance (scene units) above which the camera meters fully; below it adapts only partly. */
export const EXPOSURE_FULL_ADAPTATION_LEVEL = 1;
/** The meter's key: an 18% grey card under the metered light shows at about 0.13 before the filmic curve. */
export const EXPOSURE_KEY = 0.75;
/** How much of a drop below full adaptation the camera makes up (0 none, 1 all): 0.3 keeps dusk and night dark. */
export const EXPOSURE_ADAPTATION = 0.3;
/** The exposure's ceiling (a camera's slowest auto setting): night stays night. */
export const EXPOSURE_MAX = 8;

/**
 * The camera's exposure for a scene whose level surfaces receive `levelIlluminance` (sun on a level surface plus the
 * sky and any night fill, scene units): an incident-light meter (exposure = key x pi / E) in daylight, and above
 * `EXPOSURE_FULL_ADAPTATION_LEVEL` of darkness only a small power of the drop (`EXPOSURE_ADAPTATION`) is made up, as an
 * eye or an auto camera at dusk does, so twilight reads darker than day and night darker still. (Measured on the ESB: a
 * square root left the sky at -6° and -12° as bright as day.)
 */
export function calibratedExposure(levelIlluminance: number): number {
    const e = Math.max(1e-9, levelIlluminance);
    const full = (EXPOSURE_KEY * Math.PI) / EXPOSURE_FULL_ADAPTATION_LEVEL;
    const exposure = e >= EXPOSURE_FULL_ADAPTATION_LEVEL ? (EXPOSURE_KEY * Math.PI) / e : full * Math.pow(EXPOSURE_FULL_ADAPTATION_LEVEL / e, EXPOSURE_ADAPTATION);
    return Math.min(EXPOSURE_MAX, exposure);
}
