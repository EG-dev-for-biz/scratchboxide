/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * Standard photographic and cinematic correlated color temperatures (CCT in Kelvin).
 */
export const KELVIN_CANDLE = 1850;
export const KELVIN_TUNGSTEN = 2800;
export const KELVIN_STUDIO_HALOGEN = 3200;
export const KELVIN_MOONLIGHT = 4100;
export const KELVIN_HORIZON_DAYLIGHT = 5000;
export const KELVIN_FILM_DAYLIGHT = 5600;
export const KELVIN_D65_NOON = 6500;
export const KELVIN_OVERCAST = 7000;
export const KELVIN_COOL_SKY = 7500;
export const KELVIN_ARCTIC_HAZE = 9500;

export interface PhotometricLightConfig {
    id: string;
    name: string;
    type: 'directional' | 'point' | 'spot' | 'area_rect';
    role: 'key' | 'fill' | 'rim' | 'kicker' | 'practical' | 'ambient' | 'bounce';
    position: [number, number, number];
    direction?: [number, number, number];
    target?: [number, number, number];
    cctKelvin: number;
    colorLinearRgb: [number, number, number];
    intensityLux?: number;
    intensityLumens?: number;
    intensityCandelas?: number;
    exposureStopsDelta?: number; // relative to key (0.0 for key, -2.0 for 4:1 fill, etc.)
    distanceMeters?: number;
    beamInnerConeRad?: number;
    beamOuterConeRad?: number;
    penumbraSoftness?: number; // 0.0 (laser hard) to 1.0 (ultra softbox)
    sourceRadiusMeters?: number; // physical radius of emitter
    castShadow: boolean;
    shadowBias?: number;
    barnDoors?: {
        topDeg: number;
        bottomDeg: number;
        leftDeg: number;
        rightDeg: number;
    };
    goboCookieTexture?: string; // e.g. 'venetian_blinds', 'window_mullions', 'tree_canopy'
    motivatedBy?: {
        entityId?: string;
        description: string;
    };
}

export interface PhotometricLightingRigData {
    rigId: string;
    name: string;
    style: 'daylight' | 'rembrandt' | 'butterfly' | 'split' | 'loop' | 'noir' | 'custom';
    keyToFillRatio: number; // e.g. 1.0 (1:1), 2.0 (2:1), 4.0 (4:1), 8.0 (8:1)
    keyToFillStops: number; // e.g. 0 (1:1), 1.0 (2:1), 2.0 (4:1), 3.0 (8:1)
    ambientSphericalHarmonics?: number[][]; // 9 coefficients x 3 channels
    lights: PhotometricLightConfig[];
    environmentHdriUri?: string;
    deLightApplied?: boolean;
}

/**
 * Converts photographic exposure stop difference to linear illuminance ratio.
 * Ratio = 2^stops. (e.g. 2 stops -> 4.0 ratio)
 */
export function stopsToRatio(stops: number): number {
    return Math.pow(2.0, stops);
}

/**
 * Converts linear illuminance ratio to photographic exposure stops.
 * Stops = log2(ratio). (e.g. 4.0 ratio -> 2.0 stops)
 */
export function ratioToStops(ratio: number): number {
    if (ratio <= 0) return 0;
    return Math.log2(ratio);
}

/**
 * Converts Exposure Value at ISO 100 (EV100) to incident illuminance in Lux.
 * Standard calibration constant C = 2.5: Lux = 2.5 * 2^EV * (100 / ISO).
 */
export function evToLux(ev: number, iso: number = 100): number {
    return 2.5 * Math.pow(2.0, ev) * (100.0 / Math.max(1, iso));
}

/**
 * Converts Lux to Exposure Value at given ISO (EV100 by default).
 * EV = log2(Lux / 2.5) - log2(100 / ISO).
 */
export function luxToEv(lux: number, iso: number = 100): number {
    if (lux <= 0) return -10.0;
    return Math.log2(lux / 2.5) - Math.log2(100.0 / Math.max(1, iso));
}

/**
 * Calculates illuminance (Lux) at distance (meters) given luminous intensity in Candelas.
 * Inverse-square law: E = I / d^2.
 */
export function candelasToLux(candelas: number, distanceMeters: number): number {
    const d = Math.max(0.001, distanceMeters);
    return candelas / (d * d);
}

/**
 * Calculates required source luminous intensity (Candelas) to produce desired Lux at distance.
 * I = E * d^2.
 */
export function luxToCandelas(lux: number, distanceMeters: number): number {
    const d = Math.max(0.001, distanceMeters);
    return lux * (d * d);
}

/**
 * Converts total luminous flux in Lumens into peak on-axis Candelas
 * for a cone with apex angle theta (in radians).
 * Solid angle Omega = 2 * pi * (1 - cos(theta / 2)).
 * I = Lumens / Omega.
 */
export function lumensToCandelas(lumens: number, apexAngleRad: number): number {
    const halfAngle = Math.min(Math.PI, Math.max(0.01, apexAngleRad * 0.5));
    const solidAngle = 2.0 * Math.PI * (1.0 - Math.cos(halfAngle));
    return lumens / Math.max(0.0001, solidAngle);
}

/**
 * Calculates the geometric shadow penumbra width (blur spread) cast by an area light.
 * Penumbra width w = 2 * r_light * (d_subject_to_floor / d_light_to_subject).
 */
export function calculatePenumbraSoftness(
    lightRadiusMeters: number,
    distanceToSubjectMeters: number,
    distanceSubjectToFloorMeters: number
): number {
    const dLight = Math.max(0.05, distanceToSubjectMeters);
    const dFloor = Math.max(0.01, distanceSubjectToFloorMeters);
    const r = Math.max(0.001, lightRadiusMeters);
    return (2.0 * r * dFloor) / dLight;
}

/**
 * Converts correlated color temperature in Kelvin (1000K to 15000K) to linear RGB.
 * Analytic Planckian locus polynomial approximation (Kang et al. / Tanner Helland).
 */
export function planckianKelvinToRgb(kelvin: number): { r: number; g: number; b: number } {
    const k = Math.min(Math.max(kelvin, 1000), 15000) / 100.0;

    let r = 0.0;
    let g = 0.0;
    let b = 0.0;

    // Red
    if (k <= 66.0) {
        r = 1.0;
    } else {
        r = (329.698727446 * Math.pow(k - 60.0, -0.1332047592)) / 255.0;
    }

    // Green
    if (k <= 66.0) {
        g = (99.4708025861 * Math.log(k) - 161.1195681661) / 255.0;
    } else {
        g = (288.1221695283 * Math.pow(k - 60.0, -0.0755148492)) / 255.0;
    }

    // Blue
    if (k >= 66.0) {
        b = 1.0;
    } else if (k <= 19.0) {
        b = 0.0;
    } else {
        b = (138.5177312231 * Math.log(k - 10.0) - 305.0447927307) / 255.0;
    }

    r = Math.min(Math.max(r, 0.0), 1.0);
    g = Math.min(Math.max(g, 0.0), 1.0);
    b = Math.min(Math.max(b, 0.0), 1.0);

    // sRGB to Linear conversion
    const toLinear = (c: number) => c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);

    return {
        r: toLinear(r),
        g: toLinear(g),
        b: toLinear(b)
    };
}

/**
 * Fits Correlated Color Temperature (CCT in Kelvin) from sRGB chromaticity
 * using McCamy's cubic approximation formula on CIE 1931 xy coordinates.
 */
export function rgbToPlanckianKelvin(r: number, g: number, b: number): number {
    const rNorm = r > 1 ? r / 255.0 : r;
    const gNorm = g > 1 ? g / 255.0 : g;
    const bNorm = b > 1 ? b / 255.0 : b;

    // Linearize sRGB
    const toLinear = (c: number) => c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
    const rLin = toLinear(rNorm);
    const gLin = toLinear(gNorm);
    const bLin = toLinear(bNorm);

    // sRGB to CIE XYZ matrix (standard D65 white point)
    const X = rLin * 0.4124564 + gLin * 0.3575761 + bLin * 0.1804375;
    const Y = rLin * 0.2126729 + gLin * 0.7151522 + bLin * 0.0721750;
    const Z = rLin * 0.0193339 + gLin * 0.1191920 + bLin * 0.9503041;

    const sum = X + Y + Z;
    if (sum <= 0.0001) return 6500;

    const x = X / sum;
    const y = Y / sum;

    // McCamy's cubic approximation formula:
    // n = (x - x_e) / (y_e - y) where chromaticity epicenter (x_e, y_e) = (0.3320, 0.1858)
    const n = (x - 0.3320) / (0.1858 - y);
    const cct = 449.0 * Math.pow(n, 3) + 3525.0 * Math.pow(n, 2) + 6823.3 * n + 5520.33;

    return Math.max(1000, Math.min(25000, Math.round(cct)));
}
