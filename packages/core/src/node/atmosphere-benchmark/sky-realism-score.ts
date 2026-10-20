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

import type { SkyMeasurement, CloudMeasurement } from './equirect-sky';
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
    directDiffuseLogError: 0.4,
    /**
     * |ln| of the error in how bright the sky backdrop is next to the sun: the reference patch's radiance over the
     * direct-normal irradiance (photo disc; scene sun light). Catches a backdrop too dark or too bright for the scene.
     */
    skyBrightnessLogError: 0.35,
    /** |render - photo| cloud fraction, with the render asked for the photo's fraction (does coverage mean coverage). */
    cloudFractionError: 0.1,
    /**
     * RMS of ln(render/photo) over the 10th/50th/90th percentile cloud luminance per unit of direct-normal sun
     * (clouds lit right whatever the clear sky does; the sky has its own measure).
     */
    cloudBrightnessLogRms: 0.35,
    /** |ln| of the error in how much brighter clouds are within 30° of the sun than elsewhere. */
    cloudTowardSunLogError: 0.4
};

export type SkyRealismMetric = keyof typeof SKY_REALISM_TOLERANCES;

export interface SkyRealismScore {
    metrics: Partial<Record<SkyRealismMetric, number>>;
    passed: SkyRealismMetric[];
    failed: SkyRealismMetric[];
    /** Measured on the photo but not on the render, or vice versa. */
    notComparable: Array<{ metric: SkyRealismMetric; reason: string }>;
    /** Direct:diffuse horizontal irradiance on each side, for the sign of the error. */
    directDiffuse?: { photo: number; render: number };
    /** Direct-normal sun luminance on each side, in each image's units (scales the cloud luminances). */
    cloudSun?: { photo?: number; render?: number };
    /** Cloud measurements on each side (when compared). */
    clouds?: { photo: CloudMeasurement; render: CloudMeasurement };
    /** Sky reference radiance per unit direct-normal irradiance (1/sr) on each side. */
    skyBrightness?: { photo: number; render: number };
    /** Per-sample detail for diagnosis: ln(render/photo) and Δuv. */
    samples: Array<{ elevationDeg: number; relAzimuthDeg: number; logLuminanceError: number; deltaUv: number; du: number; dv: number }>;
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
    let directDiffuse: SkyRealismScore['directDiffuse'];
    let skyBrightness: SkyRealismScore['skyBrightness'];
    const notComparable: SkyRealismScore['notComparable'] = [];
    const samples: SkyRealismScore['samples'] = [];
    for (const p of photo.samples) {
        const r = render.samples.find(s => s.elevationDeg === p.elevationDeg && s.relAzimuthDeg === p.relAzimuthDeg);
        if (!r || !(p.relLuminance > 0) || !(r.relLuminance > 0)) continue;
        const [pu, pv] = uv(p.x, p.y), [ru, rv] = uv(r.x, r.y);
        samples.push({ elevationDeg: p.elevationDeg, relAzimuthDeg: p.relAzimuthDeg, logLuminanceError: Math.log(r.relLuminance / p.relLuminance), deltaUv: deltaUv(p, r), du: ru - pu, dv: rv - pv });
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
            directDiffuse = { photo: photoRatio, render: renderRatio };
            // Photo: reference patch over disc irradiance (both in the photo's units: refY / (ratio * refY)).
            const photoSky = 1 / photo.sun.discToSkyRatio;
            const renderSky = render.referenceLuminance / Math.max(1e-9, lights.sunIntensity * 0.2126 * lights.sunColor[0] + lights.sunIntensity * 0.7152 * lights.sunColor[1] + lights.sunIntensity * 0.0722 * lights.sunColor[2]);
            metrics.skyBrightnessLogError = Math.abs(Math.log(renderSky / photoSky));
            skyBrightness = { photo: photoSky, render: renderSky };
        } else {
            notComparable.push({ metric: 'sunColorDeltaUv', reason: 'the photo shows a sun disc but the scene has no sun light' });
        }
    } else {
        notComparable.push({ metric: 'sunColorDeltaUv', reason: 'no sun disc in the photograph' });
        notComparable.push({ metric: 'directDiffuseLogError', reason: 'no sun disc in the photograph' });
    }

    const passed: SkyRealismMetric[] = [], failed: SkyRealismMetric[] = [];
    for (const [k, v] of Object.entries(metrics) as Array<[SkyRealismMetric, number]>) (v <= SKY_REALISM_TOLERANCES[k] ? passed : failed).push(k);
    return { metrics, passed, failed, notComparable, samples, directDiffuse, skyBrightness };
}

/** Adds the cloud measures to a score, when the photo has enough cloud (>= 5% of the sky) to compare. */
export function scoreClouds(score: SkyRealismScore, photo: CloudMeasurement, render: CloudMeasurement, photoSun?: number, renderSun?: number): void {
    if (photo.fraction < 0.05) return;
    const add = (k: SkyRealismMetric, v: number | undefined, why: string) => {
        if (v === undefined || !Number.isFinite(v)) { score.notComparable.push({ metric: k, reason: why }); return; }
        score.metrics[k] = v;
        (v <= SKY_REALISM_TOLERANCES[k] ? score.passed : score.failed).push(k);
    };
    add('cloudFractionError', Math.abs(render.fraction - photo.fraction), 'no cloud measurement');
    // Per unit sun: luminance relative to the clear sky, times clear sky, over the direct-normal irradiance.
    const perSun = (c: CloudMeasurement, sun: number | undefined) => c.cloudLuminance && sun ? c.cloudLuminance.map(v => (v * c.clearSkyLuminance) / sun) : undefined;
    const pc = perSun(photo, photoSun), rc = perSun(render, renderSun);
    add('cloudBrightnessLogRms', pc && rc ? Math.sqrt(pc.reduce((s, p, i) => s + Math.log(rc[i] / p) ** 2, 0) / 3) : undefined,
        !photoSun ? 'the photo\'s sun is dimmed by cloud (direct below diffuse), so brightness per unit sun is undefined' : render.cloudLuminance ? 'the photo has too little cloud to rank' : 'the render has no cloud');
    add('cloudTowardSunLogError', photo.towardSunRatio && render.towardSunRatio ? Math.abs(Math.log(render.towardSunRatio / photo.towardSunRatio)) : undefined, 'too little cloud near or away from the sun');
    score.clouds = { photo, render };
}
