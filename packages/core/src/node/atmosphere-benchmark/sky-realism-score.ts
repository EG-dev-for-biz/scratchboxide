/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Measured realism scores: a rendered sky against a photographed one taken under the same sun. Every score is a
 * ratio or a chromaticity difference, so neither image's exposure matters. Tolerances are the benchmark's pass marks.
 */

import type { SkyMeasurement } from './equirect-sky';
import type { DomeLights } from './sky-dome-equirect-renderer';

export const SKY_REALISM_TOLERANCES = {
    /** RMS of ln(render / photo) over the sky samples' luminance relative to the reference patch. */
    gradientLogRms: 0.25,
    /** Mean CIE 1960 Δuv of the sky samples' colour. */
    skyChromaDeltaUv: 0.012,
    /** |ln| of the horizon-to-zenith luminance ratio's error. */
    horizonZenithLogError: 0.3,
    /** CIE 1960 Δuv between the photographed sun disc and the scene's sun light colour. */
    sunColorDeltaUv: 0.012,
    /** |ln| of the direct-to-diffuse horizontal irradiance ratio's error (photo disc vs sky; scene sun vs hemisphere). */
    directDiffuseLogError: 0.4
};

export type SkyRealismMetric = keyof typeof SKY_REALISM_TOLERANCES;

export interface SkyRealismScore {
    metrics: Partial<Record<SkyRealismMetric, number>>;
    passed: SkyRealismMetric[];
    failed: SkyRealismMetric[];
    /** Measured on the photo but not on the render, or vice versa. */
    notComparable: Array<{ metric: SkyRealismMetric; reason: string }>;
    /** Per-sample detail for diagnosis: ln(render/photo) and Δuv. */
    samples: Array<{ elevationDeg: number; relAzimuthDeg: number; logLuminanceError: number; deltaUv: number }>;
}

function uv(x: number, y: number): [number, number] {
    const d = -2 * x + 12 * y + 3;
    return [(4 * x) / d, (6 * y) / d];
}

export function deltaUv(a: { x: number; y: number }, b: { x: number; y: number }): number {
    const [ua, va] = uv(a.x, a.y), [ub, vb] = uv(b.x, b.y);
    return Math.hypot(ua - ub, va - vb);
}

function linearRgbToXy(r: number, g: number, b: number) {
    const X = 0.4124 * r + 0.3576 * g + 0.1805 * b, Y = 0.2126 * r + 0.7152 * g + 0.0722 * b, Z = 0.0193 * r + 0.1192 * g + 0.9505 * b;
    const s = X + Y + Z;
    return { x: X / s, y: Y / s };
}

/** Scores a render (its panorama measurement and scene lights) against a photo's measurement. */
export function scoreSkyRealism(photo: SkyMeasurement, render: SkyMeasurement, lights: DomeLights, sunElevationDeg: number | undefined): SkyRealismScore {
    const metrics: Partial<Record<SkyRealismMetric, number>> = {};
    const notComparable: SkyRealismScore['notComparable'] = [];
    const samples: SkyRealismScore['samples'] = [];
    for (const p of photo.samples) {
        const r = render.samples.find(s => s.elevationDeg === p.elevationDeg && s.relAzimuthDeg === p.relAzimuthDeg);
        if (!r || !(p.relLuminance > 0) || !(r.relLuminance > 0)) continue;
        samples.push({ elevationDeg: p.elevationDeg, relAzimuthDeg: p.relAzimuthDeg, logLuminanceError: Math.log(r.relLuminance / p.relLuminance), deltaUv: deltaUv(p, r) });
    }
    if (samples.length >= 5) {
        metrics.gradientLogRms = Math.sqrt(samples.reduce((s, x) => s + x.logLuminanceError ** 2, 0) / samples.length);
        metrics.skyChromaDeltaUv = samples.reduce((s, x) => s + x.deltaUv, 0) / samples.length;
    } else {
        notComparable.push({ metric: 'gradientLogRms', reason: `only ${samples.length} sky samples in common` });
    }
    metrics.horizonZenithLogError = Math.abs(Math.log(render.horizonToZenithLuminance / photo.horizonToZenithLuminance));

    if (photo.sun && Number.isFinite(photo.sun.discChromaticity.x) && photo.sun.discToSkyRatio > 0 && sunElevationDeg !== undefined && sunElevationDeg > 0) {
        if (lights.sunIntensity > 0) {
            metrics.sunColorDeltaUv = deltaUv(photo.sun.discChromaticity, linearRgbToXy(...lights.sunColor));
            const sinEl = Math.sin((sunElevationDeg * Math.PI) / 180);
            const photoRatio = (photo.sun.discToSkyRatio * sinEl) / photo.skyIrradianceRatio;
            const renderRatio = (lights.sunIntensity * sinEl) / Math.max(1e-6, lights.hemiIntensity * lights.hemiSkyLuminance);
            metrics.directDiffuseLogError = Math.abs(Math.log(renderRatio / photoRatio));
        } else {
            notComparable.push({ metric: 'sunColorDeltaUv', reason: 'the photo shows a sun disc but the scene has no sun light' });
        }
    } else {
        notComparable.push({ metric: 'sunColorDeltaUv', reason: 'no sun disc in the photograph' });
        notComparable.push({ metric: 'directDiffuseLogError', reason: 'no sun disc in the photograph' });
    }

    const passed: SkyRealismMetric[] = [], failed: SkyRealismMetric[] = [];
    for (const [k, v] of Object.entries(metrics) as Array<[SkyRealismMetric, number]>) (v <= SKY_REALISM_TOLERANCES[k] ? passed : failed).push(k);
    return { metrics, passed, failed, notComparable, samples };
}
