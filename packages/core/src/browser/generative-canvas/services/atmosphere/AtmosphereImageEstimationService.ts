/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import {
    AtmosphericEstimationResult,
    AtmosphericScatteringConfig,
    ImageAtmospherePixelOptions,
    ImageAtmosphereRequest
} from './atmosphere-types';
import { calculateNOAASolarPosition } from './solar-position';
import { classifyDiurnalPhase } from './diurnal-lighting';
import { MissingInputError } from '../../../../common/errors/pipeline-errors';
import {
    PinholeView,
    anglesToDirection,
    angstromBeta,
    collectSkySamples,
    detectSunDisc,
    directSunTransmittance,
    directionToAngles,
    fitPreethamSky,
    fitPreethamTurbidity,
    pixelDirection,
    pixelReader,
    segmentSky,
    srgbToLinear,
    verticalFovFromHorizontal,
    visibilityMetersFromTurbidity
} from './sky-photometry';

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
 * Photometric sky and ground metrics. The sky is the region grown from the top edge by `segmentSky` (smooth, blue or
 * bright-achromatic pixels), not a fixed band; zenith and horizon are the top and bottom quarters of the rows that
 * sky occupies. Returns undefined means for a region that has no pixels.
 */
export function computeSkyAtmosphereMetrics(
    pixels: Uint8Array | Uint8ClampedArray | Float32Array,
    width: number,
    height: number
) {
    const read = pixelReader(pixels, width, height);
    const sky = segmentSky(pixels, width, height);
    let top = height, bottom = -1;
    for (let i = 0; i < sky.mask.length; i++) {
        if (!sky.mask[i]) continue;
        const y = Math.floor(i / width);
        if (y < top) top = y;
        if (y > bottom) bottom = y;
    }
    const span = Math.max(1, bottom - top + 1);
    const zenithMaxY = top + span * 0.25, horizonMinY = bottom - span * 0.25;

    const acc = () => ({ r: 0, g: 0, b: 0, lum: 0, sat: 0, n: 0 });
    const skyA = acc(), zen = acc(), hor = acc(), gnd = acc();
    let cloudCount = 0, glareW = 0, glareX = 0, glareY = 0, maxLum = 0;
    for (let i = 0; i < width * height; i++) {
        const [r, g, b] = read(i);
        const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
        const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
        const sat = mx > 1e-3 ? (mx - mn) / mx : 0;
        const add = (a: ReturnType<typeof acc>) => { a.r += r; a.g += g; a.b += b; a.lum += lum; a.sat += sat; a.n++; };
        if (!sky.mask[i]) { add(gnd); continue; }
        const x = i % width, y = (i - x) / width;
        add(skyA);
        if (y <= zenithMaxY) add(zen);
        if (y >= horizonMinY) add(hor);
        if (sat < 0.15 && lum > 0.5) cloudCount++;
        if (lum > 0.75) {
            const w = lum ** 4;
            glareX += x * w; glareY += y * w; glareW += w;
            maxLum = Math.max(maxLum, lum);
        }
    }
    const mean = (a: ReturnType<typeof acc>) => a.n ? { r: a.r / a.n, g: a.g / a.n, b: a.b / a.n, lum: a.lum / a.n, sat: a.sat / a.n } : undefined;
    const skyM = mean(skyA), zenM = mean(zen), horM = mean(hor), gndM = mean(gnd);
    const disc = detectSunDisc(sky, width, height);
    const glareLocus: [number, number] | undefined = disc ? [disc.x, disc.y] : glareW > 0 ? [glareX / glareW, glareY / glareW] : undefined;
    return {
        skyPixels: skyA.n,
        skyPixelFraction: skyA.n / (width * height),
        skyMask: sky.mask,
        skyMeanRGB: skyM ? [skyM.r, skyM.g, skyM.b] as [number, number, number] : undefined,
        skyMeanLum: skyM?.lum,
        skyMeanSat: skyM?.sat,
        zenithRgb: zenM ? { r: zenM.r, g: zenM.g, b: zenM.b } : undefined,
        horizonRgb: horM ? { r: horM.r, g: horM.g, b: horM.b } : undefined,
        groundMeanLum: gndM?.lum,
        contrastRatio: skyM && gndM ? (skyM.lum + 0.01) / (gndM.lum + 0.01) : undefined,
        skyGradientRatio: zenM && horM ? (zenM.b + 0.01) / (horM.r + 0.01) : undefined,
        cloudCoverage: skyA.n ? cloudCount / skyA.n : undefined,
        glareLocus,
        glareLocusX: glareLocus ? glareLocus[0] / width : undefined,
        glareLocusY: glareLocus ? glareLocus[1] / height : undefined,
        glarePeakLum: maxLum
    };
}

/**
 * Atmosphere Image Estimation Service: the sun (NOAA ephemeris when coordinates and time are given, else a sun disc,
 * else a Preetham sky fitted to the sky pixels), Preetham turbidity, derived Angstrom beta, sun colour and visibility,
 * and the measured cloud fraction. Anything the pixels do not determine is left out and listed in `unmeasured`.
 */
export class AtmosphereImageEstimationService {
    public static estimateFromPixels(options: ImageAtmospherePixelOptions): AtmosphericEstimationResult {
        const { pixels, width, height } = options;
        const assumptions: string[] = [];
        const unmeasured: Record<string, string> = {};
        const metrics = computeSkyAtmosphereMetrics(pixels, width, height);

        const hfov = options.hfovDeg ?? (assumptions.push('hfovDeg=60 (not given)'), 60);
        const vfov = options.vfovDeg ?? verticalFovFromHorizontal(hfov, width, height);
        const headingKnown = typeof options.cameraHeadingDeg === 'number';
        const pitch = options.cameraPitchDeg ?? (assumptions.push('cameraPitchDeg=0, level camera (not given)'), 0);
        const view: PinholeView = { width, height, hfovDeg: hfov, vfovDeg: vfov, headingDeg: options.cameraHeadingDeg ?? 0, pitchDeg: pitch };
        const sky = segmentSky(pixels, width, height);
        const samples = collectSkySamples(pixels, view, sky.mask);

        // 1. Sun.
        let sunElevation: number, sunAzimuth: number, sunSource: string;
        let azimuthReference: 'true-north' | 'camera-forward' = headingKnown ? 'true-north' : 'camera-forward';
        let confidence: number | undefined;
        let turbidity: number | undefined;
        let skyFit: AtmosphericEstimationResult['skyFit'];
        const coords = options.knownCoords;
        if (coords && options.timestampIso) {
            const when = new Date(options.timestampIso);
            if (isNaN(when.getTime())) throw new MissingInputError('atmosphere_estimate_from_image', 'a valid isoDate', `'${options.timestampIso}' is not a date`);
            const ephem = calculateNOAASolarPosition(when, coords.lat, coords.lng);
            sunElevation = ephem.elevationDeg;
            sunAzimuth = ephem.azimuthDeg;
            sunSource = 'noaa-ephemeris';
            azimuthReference = 'true-north';
            if (headingKnown) {
                const t = fitPreethamTurbidity(samples, anglesToDirection(sunElevation, sunAzimuth));
                if (t) { turbidity = t.turbidity; skyFit = { luminanceR2: t.luminanceR2, chromaRms: t.chromaRms, samples: samples.length }; }
                else unmeasured.turbidity = 'the visible sky does not constrain the Preetham model';
            } else {
                unmeasured.turbidity = 'cameraHeadingDeg not given, so the sky pixels cannot be placed relative to the ephemeris sun';
            }
        } else {
            if (coords && !options.timestampIso) unmeasured.ephemeris = 'coordinates given without timestampIso, so the sun was located from the image instead';
            const disc = detectSunDisc(sky, width, height);
            if (disc) {
                const d = pixelDirection(view, disc.x, disc.y);
                ({ elevationDeg: sunElevation, azimuthDeg: sunAzimuth } = directionToAngles(d));
                sunSource = 'sun-disc';
                confidence = disc.circularity;
                const t = fitPreethamTurbidity(samples, d);
                if (t) { turbidity = t.turbidity; skyFit = { luminanceR2: t.luminanceR2, chromaRms: t.chromaRms, samples: samples.length }; }
                else unmeasured.turbidity = 'the visible sky does not constrain the Preetham model';
            } else {
                const fit = fitPreethamSky(samples); // throws SunNotFoundError
                sunElevation = fit.elevationDeg;
                sunAzimuth = fit.azimuthDeg;
                sunSource = 'preetham-sky-fit';
                confidence = fit.luminanceR2 * Math.min(1, 1 - 1 / fit.separation);
                turbidity = fit.turbidity;
                skyFit = { luminanceR2: fit.luminanceR2, chromaRms: fit.chromaRms, samples: fit.samples };
            }
        }
        const diurnalPhase = classifyDiurnalPhase(sunElevation);
        const sunVec = anglesToDirection(sunElevation, sunAzimuth);

        // 2. Quantities derived from the fitted turbidity (Preetham 1999 relations).
        let kelvin: number | undefined, sunColorRgb: [number, number, number] | undefined, beta: number | undefined, visibility: number | undefined;
        if (turbidity !== undefined) {
            beta = angstromBeta(turbidity);
            visibility = Math.round(visibilityMetersFromTurbidity(turbidity));
            const tr = directSunTransmittance(turbidity, sunElevation);
            const m = Math.max(tr[0], tr[1], tr[2]);
            sunColorRgb = [tr[0] / m, tr[1] / m, tr[2] / m];
            kelvin = fitPlanckianKelvinTemperature(tr[0], tr[1], tr[2]);
        } else {
            const why = unmeasured.turbidity ?? 'turbidity not fitted';
            unmeasured.kelvinTemperature = why;
            unmeasured.aerialPerspectiveRange = why;
        }
        unmeasured.rayleigh = 'the Preetham model holds the molecular atmosphere fixed; only turbidity is fitted';
        unmeasured.mie = 'a renderer scale, not observable separately from turbidity';

        const ambientColorRgb = metrics.skyMeanRGB
            ? metrics.skyMeanRGB.map(c => srgbToLinear(c)) as [number, number, number]
            : undefined;
        const cloudCoverage = metrics.cloudCoverage;

        const r2 = (v: number | undefined, d: number) => v === undefined ? undefined : Number(v.toFixed(d));
        const defined = <T extends object>(o: T): T => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
        const suggestedAtmosphereConfig: AtmosphericScatteringConfig = defined({
            enabled: true,
            turbidity: r2(turbidity, 2),
            sunElevation: Number(sunElevation.toFixed(2)),
            sunAzimuth: Number(sunAzimuth.toFixed(2)),
            sunPosition: [sunVec[0] * 100, sunVec[1] * 100, sunVec[2] * 100] as [number, number, number],
            kelvinTemperature: kelvin,
            cloudCoverage: r2(cloudCoverage, 2),
            volumetricClouds: cloudCoverage !== undefined && cloudCoverage >= 0.05,
            aerialPerspectiveEnabled: visibility !== undefined,
            aerialPerspectiveRange: visibility,
            aerialPerspectiveExtinctionRange: visibility,
            latitude: coords?.lat,
            longitude: coords?.lng
        });

        return defined({
            success: true,
            sunElevation: Number(sunElevation.toFixed(2)),
            sunAzimuth: Number(sunAzimuth.toFixed(2)),
            azimuthReference,
            sunSource,
            solarVector: sunVec,
            diurnalPhase,
            kelvinTemperature: kelvin,
            sunColorRgb,
            ambientColorRgb,
            turbidity: r2(turbidity, 2),
            angstromBeta: r2(beta, 4),
            cloudCoverage: r2(cloudCoverage, 2),
            aerialPerspectiveRange: visibility,
            aerialPerspectiveExtinctionRange: visibility,
            confidence: r2(confidence, 3),
            confidenceScore: r2(confidence, 3),
            skyFit,
            assumptions,
            unmeasured,
            photometricMetrics: defined({
                skyPixelFraction: Number(metrics.skyPixelFraction.toFixed(3)),
                skyMeanLuminance: r2(metrics.skyMeanLum, 3),
                skyChromaticity: metrics.skyMeanRGB?.map(c => Number(c.toFixed(3))) as [number, number, number] | undefined,
                skyGradientRatio: r2(metrics.skyGradientRatio, 2),
                groundMeanLuminance: r2(metrics.groundMeanLum, 3),
                contrastRatio: r2(metrics.contrastRatio, 2),
                estimatedGlareLocus: metrics.glareLocus?.map(v => Number(v.toFixed(1))) as [number, number] | undefined
            }),
            suggestedAtmosphereConfig
        }) as AtmosphericEstimationResult;
    }

    /**
     * Estimates the atmosphere from an image request's decoded pixels.
     */
    public static async estimateFromImage(request: ImageAtmosphereRequest): Promise<AtmosphericEstimationResult> {
        if (request.pixels && request.width && request.height) {
            return this.estimateFromPixels({
                pixels: request.pixels,
                width: request.width,
                height: request.height,
                knownCoords: request.knownCoords,
                timestampIso: request.timestampIso,
                cameraHeadingDeg: request.cameraHeadingDeg,
                cameraPitchDeg: request.cameraPitchDeg,
                hfovDeg: request.hfovDeg,
                vfovDeg: request.vfovDeg
            });
        }

        // Without the image's pixels there is nothing to estimate from.
        throw new MissingInputError('atmosphere_estimate_from_image', 'the image pixels', request.imagePath ? `${request.imagePath} was not decoded` : 'give imagePath (or pixels with width and height)');
    }
}
