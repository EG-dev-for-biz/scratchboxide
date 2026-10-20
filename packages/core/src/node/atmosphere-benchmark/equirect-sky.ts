/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Measurements of a sky held as a linear-light equirectangular panorama (a reference HDR photograph, or a render of
 * the sky dome in the same projection). Everything is relative: azimuths are measured from the sun (or, with the sun
 * set, from the brightest stretch of horizon), and luminances are ratios to the sky's own reference patch, so a
 * photograph in arbitrary units and a display-referred render can be compared.
 *
 * Projection: row 0 is the zenith, the middle row the horizon (a levelled panorama), column u spans 360° of azimuth.
 */

import * as fs from 'fs';
import { HDRLoader } from 'three/examples/jsm/loaders/HDRLoader.js';
import * as THREE from 'three';

export interface EquirectImage {
    width: number;
    height: number;
    /** Linear RGB, 3 floats per pixel, row 0 at the zenith. */
    rgb: Float32Array;
}

const DEG = Math.PI / 180;

/** Reads a Radiance .hdr (RGBE) panorama as linear float RGB. */
export function readHdrEquirect(file: string): EquirectImage {
    const buf = fs.readFileSync(file);
    const loader = new HDRLoader();
    loader.setDataType(THREE.FloatType);
    const tex = loader.parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)) as { width: number; height: number; data: Float32Array };
    const n = tex.width * tex.height;
    const stride = tex.data.length / n;
    const rgb = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
        rgb[i * 3] = tex.data[i * stride];
        rgb[i * 3 + 1] = tex.data[i * stride + 1];
        rgb[i * 3 + 2] = tex.data[i * stride + 2];
    }
    return { width: tex.width, height: tex.height, rgb };
}

export const luminance = (r: number, g: number, b: number) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

/** Linear sRGB to CIE xy. */
export function rgbToXy(r: number, g: number, b: number): { x: number; y: number } {
    const X = 0.4124 * r + 0.3576 * g + 0.1805 * b;
    const Y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    const Z = 0.0193 * r + 0.1192 * g + 0.9505 * b;
    const s = X + Y + Z;
    return s > 0 ? { x: X / s, y: Y / s } : { x: 1 / 3, y: 1 / 3 };
}

export const pixelElevation = (img: EquirectImage, row: number) => 90 - (180 * (row + 0.5)) / img.height;
export const pixelAzimuth = (img: EquirectImage, col: number) => (360 * (col + 0.5)) / img.width;
const wrap180 = (a: number) => ((a + 540) % 360) - 180;

function angularDistanceDeg(el1: number, az1: number, el2: number, az2: number): number {
    const c = Math.sin(el1 * DEG) * Math.sin(el2 * DEG) + Math.cos(el1 * DEG) * Math.cos(el2 * DEG) * Math.cos((az1 - az2) * DEG);
    return Math.acos(Math.min(1, Math.max(-1, c))) / DEG;
}

export interface SunMeasurement {
    elevationDeg: number;
    /** Panorama azimuth of the disc (not compass: panoramas are not north-aligned). */
    imageAzimuthDeg: number;
    /** Disc luminance integrated over its solid angle, over the sky's reference patch luminance (∝ irradiance ratio). */
    discToSkyRatio: number;
    discChromaticity: { x: number; y: number };
}

export interface SkySample {
    elevationDeg: number;
    /** Azimuth from the sun (or the horizon glow), folded to 0-180. */
    relAzimuthDeg: number;
    /** Luminance over the reference patch luminance. */
    relLuminance: number;
    x: number;
    y: number;
}

export interface SkyMeasurement {
    sun?: SunMeasurement;
    /** Panorama azimuth everything is measured from: the sun's, or the brightest horizon's when it has set. */
    anchorAzimuthDeg: number;
    anchor: 'sun-disc' | 'known-sun' | 'horizon-glow';
    /** Absolute luminance of the reference patch (35° up, 90° from the anchor), in the image's own units. */
    referenceLuminance: number;
    samples: SkySample[];
    /** Horizon (3°) over zenith (85°+) luminance, averaged around the sky. */
    horizonToZenithLuminance: number;
    /** Fraction of the sky above 10° whose colour is near-neutral and bright (clouds or haze); daytime only. */
    neutralBrightFraction?: number;
    /** Diffuse sky irradiance on a level surface over the reference patch luminance. */
    skyIrradianceRatio: number;
}

export const SAMPLE_ELEVATIONS = [3, 8, 15, 25, 40, 60, 80];
export const SAMPLE_REL_AZIMUTHS = [15, 45, 90, 135, 180];

/**
 * Finds the sun disc: the brightest pixel when it stands well above the sky around it (unclipped HDR), refined to the
 * luminance-weighted centroid of the pixels above half that peak within 2°.
 */
function findSun(img: EquirectImage, skyMedian: number): SunMeasurement | undefined {
    const { width: W, height: H, rgb } = img;
    let best = -1, bestY = 0;
    for (let j = 0; j < H / 2 + Math.ceil(H / 180); j++) {
        for (let i = 0; i < W; i++) {
            const k = (j * W + i) * 3;
            const Y = luminance(rgb[k], rgb[k + 1], rgb[k + 2]);
            if (Y > bestY) { bestY = Y; best = j * W + i; }
        }
    }
    if (best < 0 || bestY < 200 * skyMedian) return undefined;
    const bj = Math.floor(best / W), bi = best % W;
    const pe = pixelElevation(img, bj), pa = pixelAzimuth(img, bi);
    let sw = 0, se = 0, sx = 0, sy = 0;
    const win = Math.ceil((2 * W) / 360);
    for (let dj = -win; dj <= win; dj++) for (let di = -win * 4; di <= win * 4; di++) {
        const j = bj + dj; if (j < 0 || j >= H) continue;
        const i = (bi + di + W) % W;
        const k = (j * W + i) * 3;
        const Y = luminance(rgb[k], rgb[k + 1], rgb[k + 2]);
        if (Y < bestY * 0.5) continue;
        const e = pixelElevation(img, j), a = pixelAzimuth(img, i);
        if (angularDistanceDeg(pe, pa, e, a) > 2) continue;
        sw += Y; se += Y * e; sx += Y * Math.cos(a * DEG); sy += Y * Math.sin(a * DEG);
    }
    const el = se / sw, az = ((Math.atan2(sy, sx) / DEG) + 360) % 360;
    // Disc irradiance: (Y - local sky) dΩ within 1.5° of the centre.
    let E = 0, R = 0, G = 0, B = 0;
    for (let dj = -win; dj <= win; dj++) for (let di = -win * 4; di <= win * 4; di++) {
        const j = bj + dj; if (j < 0 || j >= H) continue;
        const i = (bi + di + W) % W;
        const e = pixelElevation(img, j), a = pixelAzimuth(img, i);
        if (angularDistanceDeg(el, az, e, a) > 1.5) continue;
        const dOmega = (2 * Math.PI / W) * (Math.PI / H) * Math.cos(e * DEG);
        const k = (j * W + i) * 3;
        const Y = luminance(rgb[k], rgb[k + 1], rgb[k + 2]);
        if (Y < 20 * skyMedian) continue;
        E += Y * dOmega; R += rgb[k] * dOmega; G += rgb[k + 1] * dOmega; B += rgb[k + 2] * dOmega;
    }
    return { elevationDeg: el, imageAzimuthDeg: az, discToSkyRatio: E, discChromaticity: rgbToXy(R, G, B) };
}

/** The disc's irradiance and colour at a known position: everything above 20x the sky median within 1.5°. */
function measureDiscAt(img: EquirectImage, el: number, az: number, skyMedian: number): SunMeasurement {
    const { width: W, height: H, rgb } = img;
    let E = 0, R = 0, G = 0, B = 0;
    for (let j = 0; j < H; j++) {
        const e = pixelElevation(img, j);
        if (Math.abs(e - el) > 2) continue;
        for (let i = 0; i < W; i++) {
            const a = pixelAzimuth(img, i);
            if (angularDistanceDeg(el, az, e, a) > 1.5) continue;
            const k = (j * W + i) * 3;
            const Y = luminance(rgb[k], rgb[k + 1], rgb[k + 2]);
            if (Y < 20 * skyMedian) continue;
            const dOmega = (2 * Math.PI / W) * (Math.PI / H) * Math.cos(e * DEG);
            E += Y * dOmega; R += rgb[k] * dOmega; G += rgb[k + 1] * dOmega; B += rgb[k + 2] * dOmega;
        }
    }
    return { elevationDeg: el, imageAzimuthDeg: az, discToSkyRatio: E, discChromaticity: E > 0 ? rgbToXy(R, G, B) : { x: NaN, y: NaN } };
}

/** Median of the pixels in an elevation/azimuth window (both sides of the anchor), ignoring the sun's 8°. */
function windowStats(img: EquirectImage, el: number, relAz: number, anchorAz: number, sun: SunMeasurement | undefined) {
    const { width: W, height: H, rgb } = img;
    const Ys: number[] = [], Rs: number[] = [], Gs: number[] = [], Bs: number[] = [];
    for (const side of relAz === 0 || relAz === 180 ? [1] : [1, -1]) {
        const az = anchorAz + side * relAz;
        for (let de = -2; de <= 2; de += 0.5) for (let da = -6; da <= 6; da += 1) {
            const e = el + de, a = az + da;
            if (e <= 0.5 || e > 89.9) continue;
            if (sun && angularDistanceDeg(e, a, sun.elevationDeg, sun.imageAzimuthDeg) < 8) continue;
            const j = Math.min(H - 1, Math.max(0, Math.floor(((90 - e) / 180) * H)));
            const i = ((Math.floor((((a % 360) + 360) % 360) / 360 * W)) % W + W) % W;
            const k = (j * W + i) * 3;
            Rs.push(rgb[k]); Gs.push(rgb[k + 1]); Bs.push(rgb[k + 2]); Ys.push(luminance(rgb[k], rgb[k + 1], rgb[k + 2]));
        }
    }
    if (!Ys.length) return undefined;
    const order = Ys.map((y, i) => i).sort((a, b) => Ys[a] - Ys[b]);
    // Median by luminance, and the mean colour of the middle half (rejects obstacles and stray clouds at the edges).
    const mid = order.slice(Math.floor(order.length / 4), Math.ceil((order.length * 3) / 4));
    const r = mid.reduce((s, i) => s + Rs[i], 0) / mid.length, g = mid.reduce((s, i) => s + Gs[i], 0) / mid.length, b = mid.reduce((s, i) => s + Bs[i], 0) / mid.length;
    return { Y: Ys[order[Math.floor(order.length / 2)]], ...rgbToXy(r, g, b) };
}

export interface MeasureOptions {
    /** False when the sky is known to be after dark: bright points are then lamps or the moon, not the sun. */
    sunMayBeUp?: boolean;
    /** Lowest elevation sampled; raise it for panoramas with buildings or terrain along the horizon. Default 3. */
    minSampleElevationDeg?: number;
    /**
     * Where the sun is when it is known rather than found (a render's configured sun, or the ephemeris for a sun that
     * has set). Below the horizon it only anchors the azimuth. The disc is still measured where one is drawn.
     */
    knownSun?: { elevationDeg: number; imageAzimuthDeg: number };
}

/** Measures a linear equirectangular sky. */
export function measureEquirectSky(img: EquirectImage, opts: MeasureOptions = {}): SkyMeasurement {
    const { width: W, height: H, rgb } = img;
    const skyY: number[] = [];
    for (let j = 0; j < H / 2; j += 2) for (let i = 0; i < W; i += 2) {
        const k = (j * W + i) * 3;
        skyY.push(luminance(rgb[k], rgb[k + 1], rgb[k + 2]));
    }
    skyY.sort((a, b) => a - b);
    const skyMedian = Math.max(1e-9, skyY[Math.floor(skyY.length / 2)]);
    let sun = opts.sunMayBeUp === false || opts.knownSun ? undefined : findSun(img, skyMedian);
    if (opts.knownSun && opts.knownSun.elevationDeg > -0.5) sun = measureDiscAt(img, opts.knownSun.elevationDeg, opts.knownSun.imageAzimuthDeg, skyMedian);

    let anchorAz: number;
    if (opts.knownSun) anchorAz = opts.knownSun.imageAzimuthDeg;
    else if (sun) anchorAz = sun.imageAzimuthDeg;
    else {
        // Brightest 20° stretch of the 2-6° horizon band.
        const bins = new Array(72).fill(0);
        for (let j = Math.floor(((90 - 6) / 180) * H); j <= Math.floor(((90 - 2) / 180) * H); j++) for (let i = 0; i < W; i++) {
            const k = (j * W + i) * 3;
            bins[Math.floor((i / W) * 72)] += luminance(rgb[k], rgb[k + 1], rgb[k + 2]);
        }
        let bi = 0, bv = -1;
        for (let b = 0; b < 72; b++) { const v = bins[b] + bins[(b + 1) % 72] + bins[(b + 71) % 72] + bins[(b + 2) % 72]; if (v > bv) { bv = v; bi = b; } }
        anchorAz = (bi + 0.5) * 5;
    }

    const ref = windowStats(img, 35, 90, anchorAz, sun);
    const refY = Math.max(1e-12, ref?.Y ?? skyMedian);
    if (sun) sun = { ...sun, discToSkyRatio: sun.discToSkyRatio / refY };
    const samples: SkySample[] = [];
    for (const el of SAMPLE_ELEVATIONS.filter(e => e >= (opts.minSampleElevationDeg ?? 3))) for (const relAz of SAMPLE_REL_AZIMUTHS) {
        const s = windowStats(img, el, relAz, anchorAz, sun);
        if (s) samples.push({ elevationDeg: el, relAzimuthDeg: relAz, relLuminance: s.Y / refY, x: s.x, y: s.y });
    }

    let horizon = 0, nh = 0, zenith = 0, nz = 0, E = 0, cloud = 0, nsky = 0;
    for (let j = 0; j < H / 2; j++) {
        const e = pixelElevation(img, j);
        const dOmega = (2 * Math.PI / W) * (Math.PI / H) * Math.cos(e * DEG);
        for (let i = 0; i < W; i++) {
            const k = (j * W + i) * 3;
            const Y = luminance(rgb[k], rgb[k + 1], rgb[k + 2]);
            const sunDist = sun ? angularDistanceDeg(e, pixelAzimuth(img, i), sun.elevationDeg, sun.imageAzimuthDeg) : 180;
            const nearSun = sunDist < 1.5;
            if (!nearSun) E += Y * Math.sin(e * DEG) * dOmega;
            if (sunDist > 5 && e > 2 && e < 4) { horizon += Y; nh++; }
            if (sunDist > 5 && e > 85) { zenith += Y; nz++; }
            if (e > 10 && !nearSun) {
                const mx = Math.max(rgb[k], rgb[k + 1], rgb[k + 2]), mn = Math.min(rgb[k], rgb[k + 1], rgb[k + 2]);
                nsky++;
                if (mx > 0 && (mx - mn) / mx < 0.22 && Y > 1.1 * refY) cloud++;
            }
        }
    }
    return {
        sun,
        anchorAzimuthDeg: anchorAz,
        anchor: opts.knownSun ? 'known-sun' : sun ? 'sun-disc' : 'horizon-glow',
        referenceLuminance: refY,
        samples,
        horizonToZenithLuminance: (horizon / Math.max(1, nh)) / Math.max(1e-12, zenith / Math.max(1, nz)),
        neutralBrightFraction: sun && sun.elevationDeg > 10 ? cloud / Math.max(1, nsky) : undefined,
        skyIrradianceRatio: E / refY
    };
}

const SRGB_TO_XYZ = [[0.4124, 0.3576, 0.1805], [0.2126, 0.7152, 0.0722], [0.0193, 0.1192, 0.9505]];
const XYZ_TO_SRGB = [[3.2404542, -1.5371385, -0.4985314], [-0.9692660, 1.8760108, 0.0415560], [0.0556434, -0.2040259, 1.0572252]];
const BRADFORD = [[0.8951, 0.2664, -0.1614], [-0.7502, 1.7135, 0.0367], [0.0389, -0.0685, 1.0296]];
const BRADFORD_INV = [[0.9869929, -0.1470543, 0.1599627], [0.4323053, 0.5183603, 0.0492912], [-0.0085287, 0.0400428, 0.9684867]];
const mul = (m: number[][], v: number[]) => [0, 1, 2].map(r => m[r][0] * v[0] + m[r][1] * v[1] + m[r][2] * v[2]);
const mm = (a: number[][], b: number[][]) => [0, 1, 2].map(r => [0, 1, 2].map(c => a[r][0] * b[0][c] + a[r][1] * b[1][c] + a[r][2] * b[2][c]));

/**
 * The linear-sRGB matrix a camera white-balanced to `kelvin` applies: Bradford adaptation that maps a blackbody at
 * that temperature to the D65 white of sRGB. `whiteXyz` is that blackbody's XYZ (any scale).
 */
export function whiteBalanceMatrix(whiteXyz: [number, number, number]): number[][] {
    const d65 = [0.95047, 1, 1.08883];
    const src = mul(BRADFORD, whiteXyz.map(v => v / whiteXyz[1]));
    const dst = mul(BRADFORD, d65);
    const diag = [[dst[0] / src[0], 0, 0], [0, dst[1] / src[1], 0], [0, 0, dst[2] / src[2]]];
    return mm(XYZ_TO_SRGB, mm(BRADFORD_INV, mm(diag, mm(BRADFORD, SRGB_TO_XYZ))));
}

/** Applies a linear-sRGB 3x3 matrix to every pixel (a new image). */
export function applyColorMatrix(img: EquirectImage, m: number[][]): EquirectImage {
    const rgb = new Float32Array(img.rgb.length);
    for (let i = 0; i < rgb.length; i += 3) {
        const r = img.rgb[i], g = img.rgb[i + 1], b = img.rgb[i + 2];
        rgb[i] = m[0][0] * r + m[0][1] * g + m[0][2] * b;
        rgb[i + 1] = m[1][0] * r + m[1][1] * g + m[1][2] * b;
        rgb[i + 2] = m[2][0] * r + m[2][1] * g + m[2][2] * b;
    }
    return { width: img.width, height: img.height, rgb };
}

export interface CloudMeasurement {
    /** Solid-angle fraction of the sky between 15° and 85° (beyond 6° of the sun) that is cloud. */
    fraction: number;
    /** Median luminance of the clear sky in that band, the scale the cloud luminances are given in. */
    clearSkyLuminance: number;
    /** 10th / 50th / 90th percentile cloud luminance over the clear-sky median (bases, bodies, lit tops). */
    cloudLuminance?: [number, number, number];
    /** Median cloud luminance within 30° of the sun over the median elsewhere (bright edges toward the sun). */
    towardSunRatio?: number;
}

function uvOf(r: number, g: number, b: number): [number, number] {
    const { x, y } = rgbToXy(r, g, b);
    const d = -2 * x + 12 * y + 3;
    return [(4 * x) / d, (6 * y) / d];
}
const D65_UV = (() => { const x = 0.3127, y = 0.329, d = -2 * x + 12 * y + 3; return [(4 * x) / d, (6 * y) / d] as [number, number]; })();

/**
 * Clouds in a daytime sky: pixels no bluer than white (u, v within 0.008 / 0.016 below D65; clear sky lies well below),
 * weighted by solid angle. Compare a photo and a render only after both share a white balance.
 */
export function measureClouds(img: EquirectImage, sun?: { elevationDeg: number; imageAzimuthDeg: number }): CloudMeasurement {
    const { width: W, height: H, rgb } = img;
    const cloudY: number[] = [], clearY: number[] = [], nearSun: number[] = [], awaySun: number[] = [];
    let cloudW = 0, totalW = 0;
    for (let j = 0; j < H / 2; j++) {
        const e = pixelElevation(img, j);
        if (e < 15 || e > 85) continue;
        const w = Math.cos(e * DEG);
        for (let i = 0; i < W; i++) {
            const dSun = sun ? angularDistanceDeg(e, pixelAzimuth(img, i), sun.elevationDeg, sun.imageAzimuthDeg) : 180;
            if (dSun < 6) continue;
            const k = (j * W + i) * 3;
            const Y = luminance(rgb[k], rgb[k + 1], rgb[k + 2]);
            if (!(Y > 0)) continue;
            const [u, v] = uvOf(rgb[k], rgb[k + 1], rgb[k + 2]);
            // Cloud is white or warmer (sunlit at a low sun it turns orange); clear sky is distinctly bluer than white.
            const neutral = u > D65_UV[0] - 0.008 && v > D65_UV[1] - 0.016;
            totalW += w;
            if (neutral) { cloudW += w; cloudY.push(Y); (dSun < 30 ? nearSun : awaySun).push(Y); }
            else clearY.push(Y);
        }
    }
    const median = (a: number[]) => { if (!a.length) return NaN; const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
    const clear = median(clearY);
    const out: CloudMeasurement = { fraction: totalW ? cloudW / totalW : 0, clearSkyLuminance: clear };
    if (cloudY.length > 50 && Number.isFinite(clear)) {
        const s = [...cloudY].sort((x, y) => x - y);
        out.cloudLuminance = [s[Math.floor(s.length * 0.1)] / clear, s[Math.floor(s.length * 0.5)] / clear, s[Math.floor(s.length * 0.9)] / clear];
        if (nearSun.length > 30 && awaySun.length > 30) out.towardSunRatio = median(nearSun) / median(awaySun);
    }
    return out;
}
