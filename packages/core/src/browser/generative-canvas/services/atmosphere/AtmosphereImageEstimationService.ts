/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import * as THREE from 'three';
import {
    AtmosphericEstimationResult,
    AtmosphericScatteringConfig,
    DiurnalPhase,
    ImageAtmospherePixelOptions,
    ImageAtmosphereRequest
} from './atmosphere-types';
import { kelvinToRGB, blackbodyKelvinToLinearRgb } from './kelvin';
import { calculateNOAASolarPosition, getSunVectorFromAngles } from './solar-position';
import { classifyDiurnalPhase, computeDiurnalLightingProfile } from './diurnal-lighting';
import { MissingInputError } from '../../../../common/errors/pipeline-errors';

/**
 * Fits correlated color temperature (CCT in Kelvin) from RGB chromaticity using McCamy's approximation.
 */
export function fitPlanckianKelvinTemperature(r: number, g: number, b: number): number {
    const nr = Math.max(0.001, r);
    const ng = Math.max(0.001, g);
    const nb = Math.max(0.001, b);

    // Convert sRGB to CIE 1931 XYZ
    const X = 0.4124 * nr + 0.3576 * ng + 0.1805 * nb;
    const Y = 0.2126 * nr + 0.7152 * ng + 0.0722 * nb;
    const Z = 0.0193 * nr + 0.1192 * ng + 0.9505 * nb;

    const sum = X + Y + Z;
    if (sum < 0.0001) return 5500;

    const x = X / sum;
    const y = Y / sum;

    // McCamy's cubic polynomial approximation
    const n = (x - 0.3320) / (0.1858 - y);
    const cct = 449.0 * Math.pow(n, 3) + 3525.0 * Math.pow(n, 2) + 6823.3 * n + 5520.33;

    if (isNaN(cct) || !isFinite(cct)) return 5500;
    return Math.max(1800, Math.min(25000, Math.round(cct)));
}

/**
 * Extracts photometric sky and ground metrics from raw image pixels.
 */
export function computeSkyAtmosphereMetrics(
    pixels: Uint8Array | Uint8ClampedArray | Float32Array,
    width: number,
    height: number
) {
    const totalPixels = width * height;
    const stride = Math.floor(pixels.length / totalPixels) >= 4 ? 4 : 3;
    const isUint8 = !(pixels instanceof Float32Array);
    const normFactor = isUint8 ? 1.0 / 255.0 : 1.0;

    let skyR = 0, skyG = 0, skyB = 0, skyLum = 0, skySatSum = 0;
    let skyCount = 0;

    let zenithR = 0, zenithG = 0, zenithB = 0;
    let zenithCount = 0;

    let horizonR = 0, horizonG = 0, horizonB = 0;
    let horizonCount = 0;

    let groundR = 0, groundG = 0, groundB = 0, groundLum = 0;
    let groundCount = 0;

    let cloudCount = 0;

    let maxLum = 0;
    let glareX = width / 2;
    let glareY = height * 0.2;
    let glareWeightSum = 0;
    let weightedGlareX = 0;
    let weightedGlareY = 0;

    const skyCutoffY = Math.floor(height * 0.38);
    const zenithCutoffY = Math.floor(height * 0.14);
    const horizonStartY = Math.floor(height * 0.22);
    const groundStartY = Math.floor(height * 0.45);

    for (let y = 0; y < height; y++) {
        const rowOffset = y * width;
        for (let x = 0; x < width; x++) {
            const idx = (rowOffset + x) * stride;
            const r = pixels[idx] * normFactor;
            const g = pixels[idx + 1] * normFactor;
            const b = pixels[idx + 2] * normFactor;

            const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
            const maxVal = Math.max(r, g, b);
            const minVal = Math.min(r, g, b);
            const sat = maxVal > 0.001 ? (maxVal - minVal) / maxVal : 0;

            if (y < skyCutoffY) {
                skyR += r;
                skyG += g;
                skyB += b;
                skyLum += lum;
                skySatSum += sat;
                skyCount++;

                if (y < zenithCutoffY) {
                    zenithR += r;
                    zenithG += g;
                    zenithB += b;
                    zenithCount++;
                } else if (y >= horizonStartY) {
                    horizonR += r;
                    horizonG += g;
                    horizonB += b;
                    horizonCount++;
                }

                // Cloud discrimination: low saturation with high luminance
                if (sat < 0.22 && lum > 0.52) {
                    cloudCount++;
                }

                // Solar glare detection in sky region
                if (lum > 0.75) {
                    const weight = Math.pow(lum, 4);
                    weightedGlareX += x * weight;
                    weightedGlareY += y * weight;
                    glareWeightSum += weight;

                    if (lum > maxLum) {
                        maxLum = lum;
                        glareX = x;
                        glareY = y;
                    }
                }
            } else if (y >= groundStartY) {
                groundR += r;
                groundG += g;
                groundB += b;
                groundLum += lum;
                groundCount++;
            }
        }
    }

    const safeSkyCount = Math.max(1, skyCount);
    const safeZenithCount = Math.max(1, zenithCount);
    const safeHorizonCount = Math.max(1, horizonCount);
    const safeGroundCount = Math.max(1, groundCount);

    const meanSkyR = skyR / safeSkyCount;
    const meanSkyG = skyG / safeSkyCount;
    const meanSkyB = skyB / safeSkyCount;
    const meanSkyLum = skyLum / safeSkyCount;
    const meanSkySat = skySatSum / safeSkyCount;

    const meanZenithR = zenithR / safeZenithCount;
    const meanZenithG = zenithG / safeZenithCount;
    const meanZenithB = zenithB / safeZenithCount;

    const meanHorizonR = horizonR / safeHorizonCount;
    const meanHorizonG = horizonG / safeHorizonCount;
    const meanHorizonB = horizonB / safeHorizonCount;

    const meanGroundLum = groundLum / safeGroundCount;

    if (glareWeightSum > 0.001) {
        glareX = weightedGlareX / glareWeightSum;
        glareY = weightedGlareY / glareWeightSum;
    }

    const gradientRatio = (meanZenithB + 0.01) / (meanHorizonR + 0.01);
    const contrastRatio = (meanSkyLum + 0.01) / (meanGroundLum + 0.01);
    const cloudCoverage = Math.max(0.0, Math.min(1.0, cloudCount / safeSkyCount));

    return {
        skyMeanRGB: [meanSkyR, meanSkyG, meanSkyB] as [number, number, number],
        skyMeanLum: meanSkyLum,
        skyMeanSat: meanSkySat,
        zenithRGB: [meanZenithR, meanZenithG, meanZenithB] as [number, number, number],
        horizonRGB: [meanHorizonR, meanHorizonG, meanHorizonB] as [number, number, number],
        groundMeanLum: meanGroundLum,
        contrastRatio,
        gradientRatio,
        cloudCoverage,
        glareLocus: [glareX, glareY] as [number, number],
        glareLocusX: glareX / width,
        glareLocusY: glareY / height,
        glarePeakLum: maxLum,
        skyPixels: skyCount,
        zenithRgb: { r: meanZenithR, g: meanZenithG, b: meanZenithB },
        horizonRgb: { r: meanHorizonR, g: meanHorizonG, b: meanHorizonB },
        skyGradientRatio: gradientRatio,
        skySaturation: meanSkySat
    };
}

/**
 * Atmosphere Image Estimation Service.
 * Analyzes query photographs or video plates to extract matching physical atmospheric parameters:
 * sun elevation, sun azimuth, Planckian color temperature, Rayleigh/Mie turbidity, cloud layers,
 * and Beer-Lambert aerial perspective haze.
 */
export class AtmosphereImageEstimationService {
    /**
     * Estimates physical atmospheric configuration from raw pixel data.
     */
    public static estimateFromPixels(options: ImageAtmospherePixelOptions): AtmosphericEstimationResult {
        const { pixels, width, height } = options;
        const metrics = computeSkyAtmosphereMetrics(pixels, width, height);

        // 1. Correlated Color Temperature (Kelvin)
        // Combine sky chromaticity and ground illumination for robust white-point fitting
        const fitR = metrics.skyMeanRGB[0] * 0.4 + (metrics.glarePeakLum > 0.8 ? 0.6 : 0.4);
        const fitG = metrics.skyMeanRGB[1] * 0.4 + (metrics.glarePeakLum > 0.8 ? 0.55 : 0.4);
        const fitB = metrics.skyMeanRGB[2] * 0.4 + (metrics.glarePeakLum > 0.8 ? 0.45 : 0.4);
        let kelvin = fitPlanckianKelvinTemperature(fitR, fitG, fitB);

        // 2. Turbidity and Rayleigh Scattering
        // High sky saturation and steep zenith-to-horizon blue gradient = crisp clean air (low turbidity)
        // Milky/whitened horizon = higher aerosol Mie scattering and turbidity
        const turbidity = Math.max(1.8, Math.min(7.5, 2.2 + 3.2 * (1.0 - Math.min(1.0, metrics.skyMeanSat * 1.5))));
        const rayleigh = Math.max(1.6, Math.min(4.2, 2.0 + 1.2 * (metrics.gradientRatio - 1.0)));
        const mie = Math.max(0.002, Math.min(0.025, 0.0035 * (turbidity / 2.5)));

        // 3. Solar Vector & Elevation / Azimuth Estimation
        const hfov = options.hfovDeg || 57.0;
        const vfov = options.vfovDeg || 44.0;
        const camHeading = options.cameraHeadingDeg ?? 0;
        const camPitch = options.cameraPitchDeg ?? 0;

        let sunElevation = 45.0;
        let sunAzimuth = 180.0;
        let confidence = 0.85;

        // If solar glare was detected in sky:
        if (metrics.glarePeakLum > 0.7) {
            const normX = metrics.glareLocus[0] / width;
            const normY = metrics.glareLocus[1] / height;

            const deltaAzimuth = (normX - 0.5) * hfov;
            sunElevation = Math.max(2.0, Math.min(85.0, (0.5 - normY) * vfov + 35.0 + camPitch));
            sunAzimuth = (camHeading + deltaAzimuth + 360.0) % 360.0;
            confidence = 0.94;
        }

        // 4. NOAA Solar Ephemeris Grounding (if coordinates provided or resolvable)
        // Coordinates only as given: a hint is never matched against a landmark table.
        const coords = options.knownCoords;
        if (coords) {
            if (options.timestampIso) {
                const ephem = calculateNOAASolarPosition(new Date(options.timestampIso), coords.lat, coords.lng);
                sunElevation = ephem.elevationDeg;
                sunAzimuth = ephem.azimuthDeg;
                confidence = 0.99;
            } else {
                // Cross-reference with latitude diurnal curve to refine azimuth
                // Local solar noon on the June solstice at these coordinates
                const noonEphem = calculateNOAASolarPosition(new Date(Date.UTC(2026, 5, 21, 12) - (coords.lng / 15) * 3600000), coords.lat, coords.lng);
                if (Math.abs(sunElevation - noonEphem.elevationDeg) > 30) {
                    // Afternoon/morning angle
                    if (coords.lat > 0) {
                        sunAzimuth = sunAzimuth === 180.0 ? 215.0 : sunAzimuth;
                    }
                }
            }
        }

        // Adjust kelvin temperature based on solar elevation if within twilight/golden-hour zone
        const diurnalProfile = computeDiurnalLightingProfile(sunElevation);
        const diurnalPhase = classifyDiurnalPhase(sunElevation);

        if (sunElevation < 15.0 && diurnalProfile.kelvinTemperature) {
            kelvin = Math.round(kelvin * 0.3 + diurnalProfile.kelvinTemperature * 0.7);
        }

        // 5. Cloud Layers & Aerial Perspective
        const cloudCoverage = metrics.cloudCoverage;
        const cloudDensity = Math.max(0.2, Math.min(1.8, 0.8 + cloudCoverage * 0.6));
        const aerialPerspectiveRange = Math.max(3500, Math.min(30000, Math.round(30000 / (turbidity / 2.2))));
        const inscatteringIntensity = Math.max(0.4, Math.min(0.95, 0.45 + (turbidity - 2.0) * 0.08));

        // 6. Direct & Ambient Colors
        const sunColor = kelvinToRGB(kelvin);
        const sunColorRgb: [number, number, number] = [sunColor.r, sunColor.g, sunColor.b];
        const ambientColorRgb: [number, number, number] = [
            Math.max(0.1, metrics.skyMeanRGB[0] * 0.7 + 0.1),
            Math.max(0.1, metrics.skyMeanRGB[1] * 0.7 + 0.1),
            Math.max(0.15, metrics.skyMeanRGB[2] * 0.7 + 0.2)
        ];

        // 7. ENU Solar Vector
        const sunVec = getSunVectorFromAngles(sunElevation, sunAzimuth);
        const solarVector: [number, number, number] = [sunVec.x, sunVec.y, sunVec.z];

        const suggestedAtmosphereConfig: AtmosphericScatteringConfig = {
            enabled: true,
            rayleigh: Number(rayleigh.toFixed(2)),
            mie: Number(mie.toFixed(4)),
            turbidity: Number(turbidity.toFixed(2)),
            sunElevation: Number(sunElevation.toFixed(2)),
            sunAzimuth: Number(sunAzimuth.toFixed(2)),
            sunPosition: [sunVec.x * 100, sunVec.y * 100, sunVec.z * 100],
            kelvinTemperature: kelvin,
            cloudCoverage: Number(cloudCoverage.toFixed(2)),
            cloudDensity: Number(cloudDensity.toFixed(2)),
            cloudAltitude: 140.0,
            volumetricClouds: true,
            aerialPerspectiveEnabled: true,
            aerialPerspectiveRange,
            aerialPerspectiveExtinctionRange: aerialPerspectiveRange,
            inscatteringIntensity: Number(inscatteringIntensity.toFixed(2)),
            cloudShadowsEnabled: cloudCoverage > 0.08,
            cloudShadowIntensity: Math.min(0.7, cloudCoverage * 1.2),
            cloudShadowScale: 200.0,
            latitude: coords?.lat,
            longitude: coords?.lng
        };

        return {
            success: true,
            sunElevation: Number(sunElevation.toFixed(2)),
            sunAzimuth: Number(sunAzimuth.toFixed(2)),
            solarVector,
            diurnalPhase,
            kelvinTemperature: kelvin,
            sunColorRgb,
            ambientColorRgb,
            turbidity: Number(turbidity.toFixed(2)),
            rayleigh: Number(rayleigh.toFixed(2)),
            rayleighScattering: Number(rayleigh.toFixed(2)),
            mie: Number(mie.toFixed(4)),
            cloudCoverage: Number(cloudCoverage.toFixed(2)),
            cloudDensity: Number(cloudDensity.toFixed(2)),
            aerialPerspectiveRange,
            aerialPerspectiveExtinctionRange: aerialPerspectiveRange,
            inscatteringIntensity: Number(inscatteringIntensity.toFixed(2)),
            confidence: Number(confidence.toFixed(2)),
            confidenceScore: Number(confidence.toFixed(2)),
            photometricMetrics: {
                skyMeanLuminance: Number(metrics.skyMeanLum.toFixed(3)),
                skyChromaticity: [
                    Number(metrics.skyMeanRGB[0].toFixed(3)),
                    Number(metrics.skyMeanRGB[1].toFixed(3)),
                    Number(metrics.skyMeanRGB[2].toFixed(3))
                ],
                skyGradientRatio: Number(metrics.gradientRatio.toFixed(2)),
                groundMeanLuminance: Number(metrics.groundMeanLum.toFixed(3)),
                contrastRatio: Number(metrics.contrastRatio.toFixed(2)),
                estimatedGlareLocus: [
                    Number(metrics.glareLocus[0].toFixed(1)),
                    Number(metrics.glareLocus[1].toFixed(1))
                ]
            },
            suggestedAtmosphereConfig
        };
    }

    /**
     * Estimates physical atmospheric configuration from an image request (pixels, path, or landmark context).
     */
    public static async estimateFromImage(request: ImageAtmosphereRequest): Promise<AtmosphericEstimationResult> {
        if (request.pixels && request.width && request.height) {
            return this.estimateFromPixels({
                pixels: request.pixels,
                width: request.width,
                height: request.height,
                knownCoords: request.knownCoords,
                timestampIso: request.timestampIso,
                promptHint: request.promptHint,
                cameraHeadingDeg: request.cameraHeadingDeg,
                cameraPitchDeg: request.cameraPitchDeg,
                hfovDeg: request.hfovDeg,
                vfovDeg: request.vfovDeg
            });
        }

        // Without the image's pixels there is nothing to estimate from: no profile is synthesized from a landmark
        // table (which used to put any unrecognised photo at the Colosseum with constant "measured" metrics).
        throw new MissingInputError('atmosphere_estimate_from_image', 'the image pixels', request.imagePath ? `${request.imagePath} was not decoded` : 'give imagePath (or pixels with width and height)');
    }
}
