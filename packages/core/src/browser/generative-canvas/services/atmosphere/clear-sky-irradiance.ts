/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Broadband direct and diffuse solar irradiance on the ground: Bird & Hulstrom's (1981) simplified clear-sky model,
 * with cloud cover by Kasten & Czeplak (1980). It sets how much of the light on a scene comes straight from the sun
 * and how much from the sky, which decides how deep shadows are. Aerosol comes from the Preetham turbidity (Angstrom
 * beta, alpha 1.3) used by the rest of the atmosphere code.
 */

import { angstromBeta } from './sky-photometry';

const SOLAR_CONSTANT = 1361;
const DEG = Math.PI / 180;

export interface ClearSkyOptions {
    /** Preetham turbidity (1 = pure Rayleigh). */
    turbidity: number;
    /** Observer height above sea level; lowers the pressure and so the Rayleigh column. Default 0. */
    observerAltitudeMeters?: number;
    /** Ozone column, cm at STP. Default 0.3. */
    ozoneCm?: number;
    /** Precipitable water, cm. Default 1.5. */
    waterCm?: number;
    /** Ground albedo, for the sky's back-scatter of ground-reflected light. Default 0.2. */
    groundAlbedo?: number;
    /** Fraction of the sky covered by cloud, 0-1 (Kasten & Czeplak). Default 0. */
    cloudCover?: number;
}

export interface SolarIrradiance {
    /** Direct normal irradiance, W/m². */
    directNormal: number;
    /** Direct irradiance on a level surface, W/m². */
    directHorizontal: number;
    /** Diffuse sky irradiance on a level surface, W/m². */
    diffuseHorizontal: number;
    /** directHorizontal / diffuseHorizontal: high is crisp, deep shadows; low is soft, filled ones. */
    directToDiffuse: number;
}

/** Ground irradiance for a sun `elevationDeg` above the horizon (0 below it). */
export function solarIrradiance(elevationDeg: number, opts: ClearSkyOptions): SolarIrradiance {
    if (!Number.isFinite(opts.turbidity) || opts.turbidity < 1) throw new RangeError(`solarIrradiance: turbidity ${opts.turbidity} is outside the physical range (1 = pure Rayleigh)`);
    const cover = opts.cloudCover ?? 0;
    if (!(cover >= 0 && cover <= 1)) throw new RangeError(`solarIrradiance: cloudCover ${cover} is outside 0-1`);
    if (elevationDeg <= 0) return { directNormal: 0, directHorizontal: 0, diffuseHorizontal: 0, directToDiffuse: 0 };

    const zen = 90 - elevationDeg, cz = Math.cos(zen * DEG);
    const P = 1013.25 * Math.exp(-(opts.observerAltitudeMeters ?? 0) / 8434.5);
    const M = 1 / (cz + 0.50572 * Math.pow(96.07995 - zen, -1.6364));
    const Mp = (M * P) / 1013.25;
    const Tr = Math.exp(-0.0903 * Math.pow(Mp, 0.84) * (1 + Mp - Math.pow(Mp, 1.01)));
    const Oz = (opts.ozoneCm ?? 0.3) * M;
    const To = 1 - 0.1611 * Oz * Math.pow(1 + 139.48 * Oz, -0.3035) - (0.002715 * Oz) / (1 + 0.044 * Oz + 0.0003 * Oz * Oz);
    const Tum = Math.exp(-0.0127 * Math.pow(Mp, 0.26));
    const Wm = (opts.waterCm ?? 1.5) * M;
    const Tw = 1 - (2.4959 * Wm) / (Math.pow(1 + 79.034 * Wm, 0.6828) + 6.385 * Wm);
    const beta = Math.max(0, angstromBeta(opts.turbidity));
    const taua = 0.2758 * beta * Math.pow(0.38, -1.3) + 0.35 * beta * Math.pow(0.5, -1.3);
    const Ta = Math.exp(-Math.pow(taua, 0.873) * (1 + taua - Math.pow(taua, 0.7088)) * Math.pow(M, 0.9108));
    const Taa = 1 - 0.1 * (1 - M + Math.pow(M, 1.06)) * (1 - Ta);
    const Tas = Ta / Taa;
    const Ba = 0.84;
    const directNormal = 0.9662 * SOLAR_CONSTANT * Tr * To * Tum * Tw * Ta;
    const skyScatter = (0.79 * SOLAR_CONSTANT * cz * To * Tw * Tum * Taa * (0.5 * (1 - Tr) + Ba * (1 - Tas))) / (1 - M + Math.pow(M, 1.02));
    const rs = 0.0685 + (1 - Ba) * (1 - Tas);
    const global = (directNormal * cz + skyScatter) / (1 - (opts.groundAlbedo ?? 0.2) * rs);
    const clearDiffuse = global - directNormal * cz;

    // Kasten & Czeplak: cloud cover N/8 = c scales the global irradiance by 1 - 0.75 c^3.4 and raises the diffuse
    // fraction toward 1 as c^2 (their clear-sky 0.3 replaced by this model's own clear fraction).
    const g = global * (1 - 0.75 * Math.pow(cover, 3.4));
    const clearFraction = clearDiffuse / global;
    const diffuseFraction = clearFraction + (1 - clearFraction) * cover * cover;
    const diffuseHorizontal = g * diffuseFraction;
    const directHorizontal = g - diffuseHorizontal;
    return {
        directNormal: directHorizontal / cz,
        directHorizontal,
        diffuseHorizontal,
        directToDiffuse: directHorizontal / Math.max(1e-9, diffuseHorizontal)
    };
}
