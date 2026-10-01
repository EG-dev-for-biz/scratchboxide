/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import {
    DiurnalLightingProfile,
    DiurnalPhase,
    TimeOfDayPreset
} from './atmosphere-types';
import { calculateNOAASolarPosition } from './solar-position';
import { blackbodyKelvinToLinearRgb } from './kelvin';

function clamp(x: number, min: number, max: number): number {
    return Math.min(Math.max(x, min), max);
}

function smoothstep(edge0: number, edge1: number, x: number): number {
    const t = clamp((x - edge0) / (edge1 - edge0), 0.0, 1.0);
    return t * t * (3.0 - 2.0 * t);
}

function lerp(a: number, b: number, t: number): number {
    return a + (b - a) * t;
}

/**
 * Classifies the solar altitude into a canonical diurnal phase.
 */
export function classifyDiurnalPhase(altitudeDeg: number): DiurnalPhase {
    if (altitudeDeg <= -12.0) return 'Deep Night';
    if (altitudeDeg <= -6.0) return 'Astronomical Twilight';
    if (altitudeDeg <= -3.0) return 'Nautical Twilight';
    if (altitudeDeg <= 0.0) return 'Civil Twilight';
    if (altitudeDeg <= 2.0) return 'Blue Hour';
    if (altitudeDeg <= 8.0) return 'Golden Hour';
    if (altitudeDeg <= 25.0) return 'Morning';
    if (altitudeDeg < 55.0) return 'Afternoon';
    return 'Midday';
}

/**
 * Computes physically continuous diurnal lighting parameters based on solar elevation angle.
 */
export function computeDiurnalLightingProfile(altitudeDeg: number): DiurnalLightingProfile {
    const phase = classifyDiurnalPhase(altitudeDeg);
    let sunIntensity = 1.45;
    let skyLightIntensity = 1.1;
    let castShadows = true;
    let toneMappingExposure = 0.65;
    let bloomIntensityScale = 1.0;
    let cloudSkyLightScale = 1.2;
    let cloudGroundBounceScale = 1.1;
    let aerialAlbedoBoost = 1.1;
    let inscatter = true;

    if (altitudeDeg <= -12.0) {
        sunIntensity = 0.0;
        skyLightIntensity = 0.06;
        castShadows = false;
        toneMappingExposure = 0.28;
        bloomIntensityScale = 0.55;
        cloudSkyLightScale = 0.15;
        cloudGroundBounceScale = 0.05;
        aerialAlbedoBoost = 0.7;
        inscatter = false;
    } else if (altitudeDeg <= -6.0) {
        const t = smoothstep(-12.0, -6.0, altitudeDeg);
        sunIntensity = 0.0;
        skyLightIntensity = lerp(0.06, 0.10, t);
        castShadows = false;
        toneMappingExposure = lerp(0.28, 0.32, t);
        bloomIntensityScale = lerp(0.55, 0.60, t);
        cloudSkyLightScale = lerp(0.15, 0.25, t);
        cloudGroundBounceScale = 0.05;
        aerialAlbedoBoost = 0.7;
        inscatter = false;
    } else if (altitudeDeg <= -3.0) {
        const t = smoothstep(-6.0, -3.0, altitudeDeg);
        sunIntensity = 0.0;
        skyLightIntensity = lerp(0.10, 0.18, t);
        castShadows = false;
        toneMappingExposure = lerp(0.32, 0.38, t);
        bloomIntensityScale = 0.65;
        cloudSkyLightScale = lerp(0.25, 0.35, t);
        cloudGroundBounceScale = lerp(0.05, 0.10, t);
        aerialAlbedoBoost = 0.8;
        inscatter = true;
    } else if (altitudeDeg <= 0.0) {
        const t = smoothstep(-3.0, 0.0, altitudeDeg);
        sunIntensity = lerp(0.0, 0.06, t);
        skyLightIntensity = lerp(0.18, 0.32, t);
        castShadows = false;
        toneMappingExposure = lerp(0.38, 0.45, t);
        bloomIntensityScale = lerp(0.65, 0.75, t);
        cloudSkyLightScale = lerp(0.35, 0.55, t);
        cloudGroundBounceScale = lerp(0.10, 0.20, t);
        aerialAlbedoBoost = lerp(0.8, 1.0, t);
        inscatter = true;
    } else if (altitudeDeg <= 2.0) {
        const t = smoothstep(0.0, 2.0, altitudeDeg);
        sunIntensity = lerp(0.06, 0.35, t);
        skyLightIntensity = lerp(0.32, 0.45, t);
        castShadows = false;
        toneMappingExposure = lerp(0.45, 0.48, t);
        bloomIntensityScale = lerp(0.75, 0.85, t);
        cloudSkyLightScale = lerp(0.55, 0.75, t);
        cloudGroundBounceScale = lerp(0.20, 0.40, t);
        aerialAlbedoBoost = lerp(1.0, 1.2, t);
        inscatter = true;
    } else if (altitudeDeg <= 8.0) {
        const t = smoothstep(2.0, 8.0, altitudeDeg);
        sunIntensity = lerp(0.35, 1.55, t);
        skyLightIntensity = lerp(0.45, 0.95, t);
        castShadows = altitudeDeg > 1.5;
        toneMappingExposure = lerp(0.48, 0.62, t);
        bloomIntensityScale = lerp(0.85, 1.1, t);
        cloudSkyLightScale = lerp(0.75, 1.35, t);
        cloudGroundBounceScale = lerp(0.40, 0.95, t);
        aerialAlbedoBoost = lerp(1.2, 1.6, t);
        inscatter = true;
    } else if (altitudeDeg <= 25.0) {
        const t = smoothstep(8.0, 25.0, altitudeDeg);
        sunIntensity = lerp(1.55, 1.35, t);
        skyLightIntensity = lerp(0.95, 1.05, t);
        castShadows = true;
        toneMappingExposure = lerp(0.62, 0.60, t);
        bloomIntensityScale = 1.0;
        cloudSkyLightScale = lerp(1.35, 1.15, t);
        cloudGroundBounceScale = lerp(0.95, 1.0, t);
        aerialAlbedoBoost = lerp(1.6, 1.2, t);
        inscatter = true;
    } else if (altitudeDeg <= 55.0) {
        const t = smoothstep(25.0, 55.0, altitudeDeg);
        sunIntensity = lerp(1.35, 1.45, t);
        skyLightIntensity = lerp(1.05, 1.1, t);
        castShadows = true;
        toneMappingExposure = lerp(0.60, 0.65, t);
        bloomIntensityScale = 1.0;
        cloudSkyLightScale = 1.15;
        cloudGroundBounceScale = 1.05;
        aerialAlbedoBoost = 1.15;
        inscatter = true;
    } else {
        sunIntensity = 1.45;
        skyLightIntensity = 1.1;
        castShadows = true;
        toneMappingExposure = 0.65;
        bloomIntensityScale = 1.0;
        cloudSkyLightScale = 1.2;
        cloudGroundBounceScale = 1.1;
        aerialAlbedoBoost = 1.1;
        inscatter = true;
    }

    const isNight = altitudeDeg <= -1.0;
    const isGoldenHour = altitudeDeg > 0.5 && altitudeDeg <= 8.0;
    const isTwilight = altitudeDeg > -6.0 && altitudeDeg <= 0.5;

    let kelvinTemperature = 6500;
    let turbidity = 2.0;

    if (altitudeDeg <= -6.0) {
        kelvinTemperature = 15000;
        turbidity = 1.2;
    } else if (altitudeDeg <= -3.0) {
        kelvinTemperature = 12000;
        turbidity = 1.5;
    } else if (altitudeDeg <= 0.0) {
        kelvinTemperature = 8500;
        turbidity = 2.0;
    } else if (altitudeDeg <= 2.0) {
        kelvinTemperature = 6000;
        turbidity = 2.2;
    } else if (altitudeDeg <= 8.0) {
        const t = (altitudeDeg - 2.0) / 6.0;
        kelvinTemperature = Math.round(lerp(3000, 4200, t));
        turbidity = 2.8;
    } else if (altitudeDeg <= 25.0) {
        const t = (altitudeDeg - 8.0) / 17.0;
        kelvinTemperature = Math.round(lerp(4200, 5400, t));
        turbidity = 2.4;
    } else if (altitudeDeg <= 55.0) {
        const t = (altitudeDeg - 25.0) / 30.0;
        kelvinTemperature = Math.round(lerp(5400, 6200, t));
        turbidity = 2.2;
    } else {
        kelvinTemperature = 6500;
        turbidity = 2.0;
    }

    const sunLinearRgb = blackbodyKelvinToLinearRgb(kelvinTemperature);
    const ambientLinearRgb: [number, number, number] = [
        sunLinearRgb[0] * 0.7 + 0.1,
        sunLinearRgb[1] * 0.75 + 0.15,
        sunLinearRgb[2] * 0.9 + 0.2
    ];
    const skyColorLinear: [number, number, number] = [
        sunLinearRgb[0] * 0.35,
        sunLinearRgb[1] * 0.55,
        sunLinearRgb[2] * 0.95
    ];
    const groundAlbedoLinear: [number, number, number] = [0.18, 0.18, 0.18];
    const shadowSoftness = isGoldenHour ? 1.8 : 1.0;
    const ambientIntensity = skyLightIntensity;

    return {
        phase,
        sunIntensity,
        skyLightIntensity,
        castShadows,
        toneMappingExposure,
        bloomIntensityScale,
        cloudSkyLightScale,
        cloudGroundBounceScale,
        aerialAlbedoBoost,
        inscatter,
        isNight,
        isGoldenHour,
        isTwilight,
        sunAltitudeDeg: altitudeDeg,
        kelvinTemperature,
        turbidity,
        ambientIntensity,
        shadowSoftness,
        sunLinearRgb,
        ambientLinearRgb,
        skyColorLinear,
        groundAlbedoLinear
    };
}

/**
 * Calculates diurnal lighting state from geographic latitude, longitude and time of day in hours [0.0, 24.0].
 */
export function getDiurnalLightingState(latitude: number, longitude: number, timeOfDay: number): DiurnalLightingProfile & { sunElevation: number; sunAzimuth: number } {
    const date = new Date();
    const hours = Math.floor(timeOfDay);
    const minutes = Math.floor((timeOfDay - hours) * 60);
    date.setHours(hours, minutes, 0, 0);

    const sol = calculateNOAASolarPosition(date, latitude, longitude);
    const profile = computeDiurnalLightingProfile(sol.elevationDeg);

    return {
        ...profile,
        sunElevation: sol.elevationDeg,
        sunAzimuth: sol.azimuthDeg
    };
}

/**
 * Convenience presets mapping semantic time-of-day names to sun angles and color temperatures.
 */
export function getPresetLightingState(preset: TimeOfDayPreset | string): DiurnalLightingProfile & {
    elevationDeg: number;
    azimuthDeg: number;
    colorHex: string;
    kelvin: number;
    skyboxName: string;
} {
    const p = (preset || 'midday').toLowerCase();

    let elevationDeg = 62.0;
    let azimuthDeg = 180.0;
    let colorHex = '#fffdf0';
    let kelvin = 6500;
    let skyboxName = 'realistic-sky';

    switch (p) {
        case 'dawn':
            elevationDeg = 1.5;
            azimuthDeg = 82.0;
            colorHex = '#ff8f4d';
            kelvin = 2800;
            skyboxName = 'golden_hour';
            break;
        case 'golden_hour':
        case 'golden':
        case 'sunset':
            elevationDeg = 5.2;
            azimuthDeg = 265.0;
            colorHex = '#ffaa44';
            kelvin = 3200;
            skyboxName = 'golden_hour';
            break;
        case 'morning':
            elevationDeg = 24.0;
            azimuthDeg = 115.0;
            colorHex = '#fff4e0';
            kelvin = 5200;
            skyboxName = 'realistic-sky';
            break;
        case 'afternoon':
            elevationDeg = 48.0;
            azimuthDeg = 215.0;
            colorHex = '#fffdf5';
            kelvin = 6000;
            skyboxName = 'realistic-sky';
            break;
        case 'dusk':
        case 'twilight':
        case 'blue_hour':
            elevationDeg = -2.5;
            azimuthDeg = 280.0;
            colorHex = '#5c7ab3';
            kelvin = 8500;
            skyboxName = 'twilight';
            break;
        case 'night':
            elevationDeg = -18.0;
            azimuthDeg = 0.0;
            colorHex = '#1a243d';
            kelvin = 12000;
            skyboxName = 'night';
            break;
        case 'deep_night':
            elevationDeg = -45.0;
            azimuthDeg = 0.0;
            colorHex = '#080d1a';
            kelvin = 15000;
            skyboxName = 'space';
            break;
        case 'deep-space':
        case 'deep_space':
        case 'space':
            // Off-world presets: no sun-lit sky, keep the starfield skybox (solar systems, orreries).
            elevationDeg = -90.0;
            azimuthDeg = 0.0;
            colorHex = '#0a0f1e';
            kelvin = 15000;
            skyboxName = 'space-stars';
            break;
        case 'overcast':
            elevationDeg = 35.0;
            azimuthDeg = 180.0;
            colorHex = '#d0d7de';
            kelvin = 7000;
            skyboxName = 'overcast';
            break;
        case 'cinematic':
            elevationDeg = 12.0;
            azimuthDeg = 230.0;
            colorHex = '#ffc078';
            kelvin = 3800;
            skyboxName = 'golden_hour';
            break;
        case 'studio':
        case 'midday':
        default:
            elevationDeg = 65.0;
            azimuthDeg = 180.0;
            colorHex = '#fffdf0';
            kelvin = 6500;
            skyboxName = 'realistic-sky';
            break;
    }

    const profile = computeDiurnalLightingProfile(elevationDeg);
    return {
        ...profile,
        elevationDeg,
        azimuthDeg,
        colorHex,
        kelvin,
        skyboxName
    };
}
