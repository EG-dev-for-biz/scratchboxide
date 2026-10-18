/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import * as fs from 'fs';
import { decodeImageToRgba } from '../image-codec-ffmpeg';

/** Point-samples an RGBA8 image down so its longer side is at most maxSide (analysis only). */
export function downsampleRgba(rgba: Uint8Array, width: number, height: number, maxSide: number): { pixels: Uint8Array; width: number; height: number } {
    const factor = Math.max(1, Math.ceil(Math.max(width, height) / maxSide));
    if (factor === 1) return { pixels: new Uint8Array(rgba.buffer, rgba.byteOffset, rgba.byteLength), width, height };
    const w = Math.max(1, Math.floor(width / factor));
    const h = Math.max(1, Math.floor(height / factor));
    const out = new Uint8Array(w * h * 4);
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            const src = ((y * factor) * width + x * factor) * 4;
            const dst = (y * w + x) * 4;
            out[dst] = rgba[src]; out[dst + 1] = rgba[src + 1]; out[dst + 2] = rgba[src + 2]; out[dst + 3] = rgba[src + 3];
        }
    }
    return { pixels: out, width: w, height: h };
}
import {
    PhotometricLightConfig,
    PhotometricLightingRigData,
    planckianKelvinToRgb,
    ratioToStops,
    rgbToPlanckianKelvin
} from '../../common/spatial/photometric-units';
import { calculateNOAASolarPosition } from '../../browser/generative-canvas/services/atmosphere/solar-position';
import {
    SunNotFoundError,
    PinholeView,
    Vec3,
    anglesToDirection,
    collectSkySamples,
    detectSunDisc,
    directionToAngles,
    fitPreethamSky,
    fitPreethamTurbidity,
    fitSphericalHarmonics,
    pixelDirection,
    segmentSky,
    splitLitShadow,
    verticalFovFromHorizontal
} from '../../browser/generative-canvas/services/atmosphere/sky-photometry';

export { SunNotFoundError };

export interface InverseLightingOptions {
    imagePath?: string;
    /** Horizontal field of view. Without it the view directions use an assumed 60 deg (listed in `assumptions`). */
    hfovDeg?: number;
    /** Vertical field of view. Derived from hfov and the aspect ratio (square pixels) when omitted. */
    vfovDeg?: number;
    /** Optical-axis heading, degrees clockwise from north. Without it azimuths are relative to the camera forward axis. */
    cameraHeadingDeg?: number;
    /** Optical-axis pitch above the horizon. Without it the camera is assumed level (listed in `assumptions`). */
    cameraPitchDeg?: number;
    knownCoords?: { lat: number; lng: number };
    timestampIso?: string;
}

/** How the sun direction was obtained. Diagnostic label only. */
export type SunSource = 'noaa-ephemeris' | 'sun-disc' | 'preetham-sky-fit' | (string & {});

export interface InverseLightingResult {
    success: true;
    keyLight: {
        /** Unit vector along the light rays (from the sun toward the scene), +X east, +Y up, -Z north. */
        direction: Vec3;
        elevationDeg: number;
        azimuthDeg: number;
        /** 'true-north' when the camera heading (or ephemeris) fixes north; otherwise 'camera-forward'. */
        azimuthReference: 'true-north' | 'camera-forward';
        source: SunSource;
        /** Chromaticity CCT of the lit (sunlit) surfaces; confounded by their albedo. */
        cctKelvin?: number;
    };
    fillLight: {
        /** Chromaticity CCT of the shadowed surfaces (sky-lit); confounded by their albedo. */
        cctKelvin?: number;
    };
    /** Sun + sky over sky-only illuminance, from the lit/shadow luminance ratio (assumes equal albedo across the split). */
    keyToFillRatio?: number;
    litToShadowLuminanceRatio?: number;
    /** Preetham turbidity fitted to the sky pixels. */
    turbidity?: number;
    /** Least-squares order-2 SH (9 x 3, linear RGB, relative exposure) of the radiance visible in the frame. */
    sphericalHarmonics: number[][];
    shFit: { rmsResidual: number; sphereCoverage: number; samples: number };
    /** Lit/shadow boundary sharpness (1 = hard step at this resolution). */
    shadowSharpness?: number;
    skyPixelFraction: number;
    /** Built only when the key-to-fill ratio was measured. */
    rig?: PhotometricLightingRigData;
    /** Confidence of an image-derived sun direction (fit R^2 x identifiability, or disc circularity). */
    confidence?: number;
    /** Inputs that were not given and had to be assumed. */
    assumptions: string[];
    /** Quantities left out, with the reason. */
    unmeasured: Record<string, string>;
}

/** Light-travel direction for a sun at the given angles. */
function lightTravelDirection(elevationDeg: number, azimuthDeg: number): Vec3 {
    const s = anglesToDirection(elevationDeg, azimuthDeg);
    return [-s[0], -s[1], -s[2]];
}

export class InverseLightingEstimatorService {
    /**
     * Inversely estimates physical scene lighting from an image file path.
     */
    public static async estimateFromImage(options: InverseLightingOptions): Promise<InverseLightingResult> {
        if (!options.imagePath || !fs.existsSync(options.imagePath)) {
            throw new Error(`InverseLightingEstimatorService: Image file not found at '${options.imagePath}'.`);
        }

        // The photo's own pixels (decoded JPEG / PNG / WebP; a file that does not decode is an error).
        const decoded = await decodeImageToRgba(fs.readFileSync(options.imagePath));
        const { pixels, width, height } = downsampleRgba(decoded.rgba, decoded.width, decoded.height, 512);
        return this.decomposePixels(pixels, width, height, options);
    }

    /**
     * Photometric decomposition of an RGBA8 buffer. The sun comes from NOAA ephemeris (coords + time), else a sun
     * disc in the sky, else a Preetham sky fit to the sky pixels; with none of these it throws SunNotFoundError.
     */
    public static async decomposePixels(
        pixels: Uint8Array,
        width: number,
        height: number,
        options: InverseLightingOptions = {}
    ): Promise<InverseLightingResult> {
        const assumptions: string[] = [];
        const unmeasured: Record<string, string> = {};
        const hfov = options.hfovDeg ?? (assumptions.push('hfovDeg=60 (not given)'), 60);
        const vfov = options.vfovDeg ?? verticalFovFromHorizontal(hfov, width, height);
        const headingKnown = typeof options.cameraHeadingDeg === 'number';
        const pitch = options.cameraPitchDeg ?? (assumptions.push('cameraPitchDeg=0, level camera (not given)'), 0);
        const view: PinholeView = { width, height, hfovDeg: hfov, vfovDeg: vfov, headingDeg: options.cameraHeadingDeg ?? 0, pitchDeg: pitch };

        const sky = segmentSky(pixels, width, height);

        // 1. Sun direction.
        let elevationDeg: number, azimuthDeg: number, source: SunSource;
        let azimuthReference: 'true-north' | 'camera-forward' = headingKnown ? 'true-north' : 'camera-forward';
        let confidence: number | undefined;
        let turbidity: number | undefined;
        const skySamples = collectSkySamples(pixels, view, sky.mask);

        if (options.knownCoords && options.timestampIso) {
            const when = new Date(options.timestampIso);
            if (isNaN(when.getTime())) throw new Error(`InverseLightingEstimatorService: timestampIso '${options.timestampIso}' is not a valid date.`);
            const ephem = calculateNOAASolarPosition(when, options.knownCoords.lat, options.knownCoords.lng);
            elevationDeg = ephem.elevationDeg;
            azimuthDeg = ephem.azimuthDeg;
            azimuthReference = 'true-north';
            source = 'noaa-ephemeris';
            if (headingKnown) {
                const t = fitPreethamTurbidity(skySamples, anglesToDirection(elevationDeg, azimuthDeg));
                if (t) turbidity = t.turbidity; else unmeasured.turbidity = 'the visible sky does not constrain the Preetham model';
            } else {
                unmeasured.turbidity = 'cameraHeadingDeg not given, so the sky pixels cannot be placed relative to the ephemeris sun';
            }
        } else {
            const disc = detectSunDisc(sky, width, height);
            if (disc) {
                const d = pixelDirection(view, disc.x, disc.y);
                ({ elevationDeg, azimuthDeg } = directionToAngles(d));
                source = 'sun-disc';
                confidence = disc.circularity;
                const t = fitPreethamTurbidity(skySamples, d);
                if (t) turbidity = t.turbidity; else unmeasured.turbidity = 'the visible sky does not constrain the Preetham model';
            } else {
                const fit = fitPreethamSky(skySamples); // throws SunNotFoundError
                elevationDeg = fit.elevationDeg;
                azimuthDeg = fit.azimuthDeg;
                source = 'preetham-sky-fit';
                confidence = fit.luminanceR2 * Math.min(1, 1 - 1 / fit.separation);
                turbidity = fit.turbidity;
            }
        }
        const dir = lightTravelDirection(elevationDeg, azimuthDeg);

        // 2. Lit / shadow split: colour temperatures, key-to-fill ratio, boundary sharpness.
        const split = splitLitShadow(pixels, width, height, sky.mask);
        let keyKelvin: number | undefined, fillKelvin: number | undefined, keyToFillRatio: number | undefined, litToShadow: number | undefined, shadowSharpness: number | undefined;
        if (split && split.separability >= 0.6 && split.litFraction >= 0.05 && split.litFraction <= 0.95) {
            keyKelvin = rgbToPlanckianKelvin(split.litMeanSrgb[0], split.litMeanSrgb[1], split.litMeanSrgb[2]);
            fillKelvin = rgbToPlanckianKelvin(split.shadowMeanSrgb[0], split.shadowMeanSrgb[1], split.shadowMeanSrgb[2]);
            litToShadow = split.luminanceRatio;
            if (litToShadow > 1) keyToFillRatio = Number((litToShadow - 1).toFixed(3));
            else unmeasured.keyToFillRatio = 'lit and shadowed surfaces are equally bright';
            shadowSharpness = split.edgeSharpness;
            if (shadowSharpness === undefined) unmeasured.shadowSharpness = 'no lit/shadow boundary inside the frame';
        } else {
            const why = split ? `the ground luminance is not bimodal (separability ${split.separability.toFixed(2)}, lit fraction ${split.litFraction.toFixed(2)})` : 'too few non-sky pixels';
            unmeasured.keyLightCct = why;
            unmeasured.fillLightCct = why;
            unmeasured.keyToFillRatio = why;
            unmeasured.shadowSharpness = why;
        }

        // 3. SH of the visible radiance.
        const sh = fitSphericalHarmonics(pixels, view);

        // 4. Rig, only from measured ratios (no lux literals: absolute illuminance is not observable without exposure metadata).
        unmeasured.intensityLux = 'absolute illuminance needs exposure metadata (EV, ISO) the pixels do not carry';
        let rig: PhotometricLightingRigData | undefined;
        if (keyToFillRatio !== undefined && keyKelvin !== undefined && fillKelvin !== undefined) {
            const keyRgb = planckianKelvinToRgb(keyKelvin);
            const fillRgb = planckianKelvinToRgb(fillKelvin);
            const stops = ratioToStops(keyToFillRatio);
            const lights: PhotometricLightConfig[] = [
                {
                    id: 'resected_key_sun',
                    name: 'Resected_Key_Sun',
                    type: 'directional',
                    role: 'key',
                    position: [-dir[0] * 50.0, -dir[1] * 50.0, -dir[2] * 50.0],
                    direction: dir,
                    cctKelvin: keyKelvin,
                    colorLinearRgb: [keyRgb.r, keyRgb.g, keyRgb.b],
                    exposureStopsDelta: 0.0,
                    ...(shadowSharpness !== undefined ? { penumbraSoftness: 1.0 - shadowSharpness } : {}),
                    castShadow: true
                },
                {
                    id: 'resected_sky_fill',
                    name: 'Resected_Sky_Fill',
                    type: 'directional',
                    role: 'fill',
                    position: [0, 50.0, 0],
                    direction: [0, -1.0, 0],
                    cctKelvin: fillKelvin,
                    colorLinearRgb: [fillRgb.r, fillRgb.g, fillRgb.b],
                    exposureStopsDelta: -stops,
                    penumbraSoftness: 1.0,
                    castShadow: false
                }
            ];
            rig = {
                rigId: `resected_rig_${Date.now()}`,
                name: 'Inversely Resected Photometric Rig',
                style: 'daylight',
                keyToFillRatio,
                keyToFillStops: stops,
                ambientSphericalHarmonics: sh.coefficients,
                lights
            };
        } else {
            unmeasured.rig = 'needs the measured key-to-fill ratio and both colour temperatures';
        }

        return {
            success: true,
            keyLight: {
                direction: dir,
                elevationDeg: Number(elevationDeg.toFixed(2)),
                azimuthDeg: Number(azimuthDeg.toFixed(2)),
                azimuthReference,
                source,
                ...(keyKelvin !== undefined ? { cctKelvin: keyKelvin } : {})
            },
            fillLight: fillKelvin !== undefined ? { cctKelvin: fillKelvin } : {},
            ...(keyToFillRatio !== undefined ? { keyToFillRatio } : {}),
            ...(litToShadow !== undefined ? { litToShadowLuminanceRatio: Number(litToShadow.toFixed(3)) } : {}),
            ...(turbidity !== undefined ? { turbidity: Number(turbidity.toFixed(2)) } : {}),
            sphericalHarmonics: sh.coefficients,
            shFit: { rmsResidual: sh.rmsResidual, sphereCoverage: sh.sphereCoverage, samples: sh.samples },
            ...(shadowSharpness !== undefined ? { shadowSharpness: Number(shadowSharpness.toFixed(3)) } : {}),
            skyPixelFraction: sky.count / (width * height),
            ...(rig ? { rig } : {}),
            ...(confidence !== undefined ? { confidence: Number(confidence.toFixed(3)) } : {}),
            assumptions,
            unmeasured
        };
    }
}
