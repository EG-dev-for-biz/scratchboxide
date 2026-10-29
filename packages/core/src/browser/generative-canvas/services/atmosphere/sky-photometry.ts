/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Photometric measurements on a photograph's pixels, shared by the image lighting and atmosphere estimators:
 * pinhole view directions, sky segmentation, the Preetham (1999) analytic daylight sky model and its fit to sky
 * pixels, a least-squares order-2 (9-coefficient) spherical-harmonic fit of the visible radiance, and an Otsu
 * lit/shadow split. Every quantity returned is computed from the pixels; nothing here supplies a default value.
 *
 * World frame: +X east, +Y up, -Z north (the Three.js ENU convention used across the atmosphere services).
 */

import { PipelineError } from '../../../../common/errors/pipeline-errors';
import { sunDirectionFromAngles } from '../../../../common/coordinate/solarPosition';

/** The image shows no sun disc and no sky luminance gradient that pins the sun down. */
export class SunNotFoundError extends PipelineError {
    readonly code = 'sun_not_found';

    constructor(readonly reason: string) {
        super(`The sun could not be located in the image: ${reason}. Give knownCoords and timestampIso to compute it from NOAA ephemeris.`);
        this.name = 'SunNotFoundError';
    }
}

export type Vec3 = [number, number, number];

export interface PinholeView {
    width: number;
    height: number;
    hfovDeg: number;
    vfovDeg: number;
    /** Degrees clockwise from north of the optical axis. */
    headingDeg: number;
    /** Degrees above the horizon of the optical axis. */
    pitchDeg: number;
}

const DEG = Math.PI / 180;

/** Vertical FOV of a square-pixel pinhole camera with the given horizontal FOV. */
export function verticalFovFromHorizontal(hfovDeg: number, width: number, height: number): number {
    return 2 * Math.atan(Math.tan(hfovDeg * DEG / 2) * height / width) / DEG;
}

/** World direction of the ray through pixel centre (x, y). */
export function pixelDirection(view: PinholeView, x: number, y: number): Vec3 {
    const u = ((x + 0.5) / view.width * 2 - 1) * Math.tan(view.hfovDeg * DEG / 2);
    const v = (1 - (y + 0.5) / view.height * 2) * Math.tan(view.vfovDeg * DEG / 2);
    const h = view.headingDeg * DEG, p = view.pitchDeg * DEG;
    const fwd: Vec3 = [Math.cos(p) * Math.sin(h), Math.sin(p), -Math.cos(p) * Math.cos(h)];
    const right: Vec3 = [Math.cos(h), 0, Math.sin(h)];
    const up: Vec3 = [-Math.sin(p) * Math.sin(h), Math.cos(p), Math.sin(p) * Math.cos(h)];
    const d: Vec3 = [fwd[0] + u * right[0] + v * up[0], fwd[1] + u * right[1] + v * up[1], fwd[2] + u * right[2] + v * up[2]];
    const n = Math.hypot(d[0], d[1], d[2]);
    return [d[0] / n, d[1] / n, d[2] / n];
}

export function directionToAngles(d: Vec3): { elevationDeg: number; azimuthDeg: number } {
    return {
        elevationDeg: Math.asin(Math.max(-1, Math.min(1, d[1]))) / DEG,
        azimuthDeg: ((Math.atan2(d[0], -d[2]) / DEG) + 360) % 360
    };
}

/** Unit vector toward a sun at (elevation, azimuth clockwise from north). */
export function anglesToDirection(elevationDeg: number, azimuthDeg: number): Vec3 {
    return sunDirectionFromAngles(elevationDeg, azimuthDeg);
}

export function srgbToLinear(c: number): number {
    return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

/** Linear sRGB (D65) to CIE xyY. */
export function linearRgbToXyY(r: number, g: number, b: number): { x: number; y: number; Y: number } {
    const X = 0.4124564 * r + 0.3575761 * g + 0.1804375 * b;
    const Y = 0.2126729 * r + 0.7151522 * g + 0.0721750 * b;
    const Z = 0.0193339 * r + 0.1191920 * g + 0.9503041 * b;
    const s = X + Y + Z;
    return s > 1e-9 ? { x: X / s, y: Y / s, Y } : { x: 0.3127, y: 0.3290, Y: 0 };
}

/** CIE xyY to linear sRGB. */
export function xyYToLinearRgb(x: number, y: number, Y: number): Vec3 {
    const X = y > 1e-9 ? x * Y / y : 0;
    const Z = y > 1e-9 ? (1 - x - y) * Y / y : 0;
    return [
        3.2404542 * X - 1.5371385 * Y - 0.4985314 * Z,
        -0.9692660 * X + 1.8760108 * Y + 0.0415560 * Z,
        0.0556434 * X - 0.2040259 * Y + 1.0572252 * Z
    ];
}

/** Normalised RGBA/RGB reader for Uint8 (0..255) or Float32 (0..1) buffers. */
export function pixelReader(pixels: Uint8Array | Uint8ClampedArray | Float32Array, width: number, height: number) {
    const stride = Math.floor(pixels.length / (width * height)) >= 4 ? 4 : 3;
    const norm = pixels instanceof Float32Array ? 1 : 1 / 255;
    return (i: number): Vec3 => [pixels[i * stride] * norm, pixels[i * stride + 1] * norm, pixels[i * stride + 2] * norm];
}

// ---------------------------------------------------------------------------------------------------------------
// Sky segmentation
// ---------------------------------------------------------------------------------------------------------------

export interface SkySegmentation {
    mask: Uint8Array;
    count: number;
    /** Gamma-encoded luma per pixel (0..1). */
    luma: Float32Array;
}

/**
 * Sky = smooth (low local gradient), blue-dominant or bright-achromatic pixels connected to the top edge of the
 * frame through neighbours of similar luma and chromaticity. Region growing from the top border, not a fixed band.
 */
export function segmentSky(pixels: Uint8Array | Uint8ClampedArray | Float32Array, width: number, height: number): SkySegmentation {
    const read = pixelReader(pixels, width, height);
    const n = width * height;
    const luma = new Float32Array(n);
    const sat = new Float32Array(n);
    const blueRatio = new Float32Array(n);
    for (let i = 0; i < n; i++) {
        const [r, g, b] = read(i);
        luma[i] = 0.2126 * r + 0.7152 * g + 0.0722 * b;
        const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
        sat[i] = mx > 1e-3 ? (mx - mn) / mx : 0;
        blueRatio[i] = b / Math.max(1e-3, r + g + b);
    }
    const grad = (x: number, y: number) => {
        const xl = Math.max(0, x - 1), xr = Math.min(width - 1, x + 1);
        const yu = Math.max(0, y - 1), yd = Math.min(height - 1, y + 1);
        return Math.hypot(luma[y * width + xr] - luma[y * width + xl], luma[yd * width + x] - luma[yu * width + x]) / 2;
    };
    const candidate = new Uint8Array(n);
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const i = y * width + x;
            const [r, g, b] = read(i);
            const blueSky = b >= r && b >= 0.9 * g && blueRatio[i] > 0.34;
            const brightAchromatic = luma[i] > 0.55 && sat[i] < 0.18;
            const smooth = grad(x, y) < 0.05;
            if ((blueSky || brightAchromatic) && smooth) candidate[i] = 1;
            else if (smooth) candidate[i] = 2; // joins only as a close continuation of sky (warm or hazy sky near the sun or horizon)
        }
    }
    const mask = new Uint8Array(n);
    const stack: number[] = [];
    for (let x = 0; x < width; x++) if (candidate[x] === 1) { mask[x] = 1; stack.push(x); }
    let count = stack.length;
    while (stack.length) {
        const i = stack.pop()!;
        const x = i % width, y = (i - x) / width;
        const nbrs = [x > 0 ? i - 1 : -1, x < width - 1 ? i + 1 : -1, y > 0 ? i - width : -1, y < height - 1 ? i + width : -1];
        for (const j of nbrs) {
            if (j < 0 || mask[j] || !candidate[j]) continue;
            const strict = candidate[j] === 2;
            if (Math.abs(luma[j] - luma[i]) > (strict ? 0.03 : 0.08) || Math.abs(blueRatio[j] - blueRatio[i]) > (strict ? 0.015 : 0.04)) continue;
            mask[j] = 1; count++; stack.push(j);
        }
    }
    return { mask, count, luma };
}

// ---------------------------------------------------------------------------------------------------------------
// Preetham, Shirley & Smits (1999) analytic daylight sky
// ---------------------------------------------------------------------------------------------------------------

type Perez = [number, number, number, number, number];

function perezCoefficients(T: number): { Y: Perez; x: Perez; y: Perez } {
    return {
        Y: [0.1787 * T - 1.4630, -0.3554 * T + 0.4275, -0.0227 * T + 5.3251, 0.1206 * T - 2.5771, -0.0670 * T + 0.3703],
        x: [-0.0193 * T - 0.2592, -0.0665 * T + 0.0008, -0.0004 * T + 0.2125, -0.0641 * T - 0.8989, -0.0033 * T + 0.0452],
        y: [-0.0167 * T - 0.2608, -0.0950 * T + 0.0092, -0.0079 * T + 0.2102, -0.0441 * T - 1.6537, -0.0109 * T + 0.0529]
    };
}

function perez(c: Perez, cosTheta: number, gamma: number, cosGamma: number): number {
    return (1 + c[0] * Math.exp(c[1] / Math.max(0.01, cosTheta))) * (1 + c[2] * Math.exp(c[3] * gamma) + c[4] * cosGamma * cosGamma);
}

/** Zenith luminance (kcd/m^2) and chromaticity for turbidity T and sun zenith angle thetaS (radians). */
export function preethamZenith(T: number, thetaS: number): { Y: number; x: number; y: number } {
    const chi = (4 / 9 - T / 120) * (Math.PI - 2 * thetaS);
    const Y = (4.0453 * T - 4.9710) * Math.tan(chi) - 0.2155 * T + 2.4192;
    const t3 = thetaS ** 3, t2 = thetaS ** 2, t1 = thetaS;
    const x = T * T * (0.00166 * t3 - 0.00375 * t2 + 0.00209 * t1)
        + T * (-0.02903 * t3 + 0.06377 * t2 - 0.03202 * t1 + 0.00394)
        + (0.11693 * t3 - 0.21196 * t2 + 0.06052 * t1 + 0.25886);
    const y = T * T * (0.00275 * t3 - 0.00610 * t2 + 0.00317 * t1)
        + T * (-0.04214 * t3 + 0.08970 * t2 - 0.04153 * t1 + 0.00516)
        + (0.15346 * t3 - 0.26756 * t2 + 0.06670 * t1 + 0.26688);
    return { Y, x, y };
}

/** Preetham sky xyY (Y relative to the zenith luminance in kcd/m^2) in direction `dir` for a sun at `sun`. */
export function preethamSky(dir: Vec3, sun: Vec3, T: number): { x: number; y: number; Y: number } {
    const c = perezCoefficients(T);
    const thetaS = Math.acos(Math.max(-1, Math.min(1, sun[1])));
    const z = preethamZenith(T, thetaS);
    const cosG = Math.max(-1, Math.min(1, dir[0] * sun[0] + dir[1] * sun[1] + dir[2] * sun[2]));
    const g = Math.acos(cosG);
    const cosT = Math.max(0.01, dir[1]);
    const cosS = Math.cos(thetaS);
    return {
        Y: z.Y * perez(c.Y, cosT, g, cosG) / perez(c.Y, 1, thetaS, cosS),
        x: z.x * perez(c.x, cosT, g, cosG) / perez(c.x, 1, thetaS, cosS),
        y: z.y * perez(c.y, cosT, g, cosG) / perez(c.y, 1, thetaS, cosS)
    };
}

export interface SkySample {
    dir: Vec3;
    /** Linear relative luminance (any exposure scale). */
    Y: number;
    x: number;
    y: number;
}

export interface SkyFit {
    sun: Vec3;
    elevationDeg: number;
    azimuthDeg: number;
    turbidity: number;
    /** Coefficient of determination of the log-luminance fit (exposure scale solved in closed form). */
    luminanceR2: number;
    /** RMS chromaticity residual (CIE xy). */
    chromaRms: number;
    /** Best cost at least 30 degrees from the fitted sun divided by the fitted cost (identifiability). */
    separation: number;
    cost: number;
    samples: number;
}

/** Relative weight of chromaticity vs log-luminance residuals (sigma_logY 0.05 vs sigma_xy 0.025). */
const CHROMA_WEIGHT = 4;

function skyCost(samples: SkySample[], sun: Vec3, T: number): { cost: number; lumSS: number; chromaSS: number } {
    const c = perezCoefficients(T);
    const thetaS = Math.acos(Math.max(-1, Math.min(1, sun[1])));
    const z = preethamZenith(T, thetaS);
    const cosS = Math.cos(thetaS);
    const nY = perez(c.Y, 1, thetaS, cosS), nx = perez(c.x, 1, thetaS, cosS), ny = perez(c.y, 1, thetaS, cosS);
    const logRes = new Float64Array(samples.length);
    let mean = 0, chromaSS = 0;
    for (let i = 0; i < samples.length; i++) {
        const s = samples[i];
        const cosG = Math.max(-1, Math.min(1, s.dir[0] * sun[0] + s.dir[1] * sun[1] + s.dir[2] * sun[2]));
        const g = Math.acos(cosG);
        const cosT = Math.max(0.01, s.dir[1]);
        const fY = perez(c.Y, cosT, g, cosG) / nY;
        logRes[i] = Math.log(Math.max(1e-6, s.Y)) - Math.log(Math.max(1e-6, fY));
        mean += logRes[i];
        const mx = z.x * perez(c.x, cosT, g, cosG) / nx;
        const my = z.y * perez(c.y, cosT, g, cosG) / ny;
        chromaSS += (s.x - mx) ** 2 + (s.y - my) ** 2;
    }
    mean /= Math.max(1, samples.length);
    let lumSS = 0;
    for (let i = 0; i < samples.length; i++) lumSS += (logRes[i] - mean) ** 2;
    return { cost: lumSS + CHROMA_WEIGHT * chromaSS, lumSS, chromaSS };
}

function logLuminanceSST(samples: SkySample[]): number {
    let mean = 0;
    for (const s of samples) mean += Math.log(Math.max(1e-6, s.Y));
    mean /= Math.max(1, samples.length);
    let ss = 0;
    for (const s of samples) ss += (Math.log(Math.max(1e-6, s.Y)) - mean) ** 2;
    return ss;
}

const TURBIDITY_GRID = [2, 2.5, 3, 4, 5, 6, 8, 10];
const T_MIN = 1.7, T_MAX = 12;

/**
 * Fits sun direction and turbidity of the Preetham sky to sky samples: a grid search (10 deg azimuth, 5 deg
 * elevation, 8 turbidities) then coordinate descent with step halving. Exposure is solved in closed form, so only
 * the luminance distribution and the chromaticity constrain the fit. Throws SunNotFoundError when the samples carry
 * no usable gradient, the fit explains little of it, or another sun position 30+ degrees away fits nearly as well.
 */
export function fitPreethamSky(samples: SkySample[]): SkyFit {
    if (samples.length < 40) throw new SunNotFoundError(`only ${samples.length} unclipped sky pixels were found (need 40)`);
    const sst = logLuminanceSST(samples);
    if (sst / samples.length < 1e-3) throw new SunNotFoundError('the visible sky has no luminance gradient to fit');

    interface Cand { el: number; az: number; T: number; cost: number }
    const grid: Cand[] = [];
    for (let el = 2.5; el < 90; el += 5) {
        for (let az = 0; az < 360; az += 10) {
            const sun = anglesToDirection(el, az);
            let best: Cand | undefined;
            for (const T of TURBIDITY_GRID) {
                const { cost } = skyCost(samples, sun, T);
                if (!best || cost < best.cost) best = { el, az, T, cost };
            }
            grid.push(best!);
        }
    }
    grid.sort((a, b) => a.cost - b.cost);
    let cur = { ...grid[0] };
    let steps = { el: 2.5, az: 5, T: 0.5 };
    for (let iter = 0; iter < 60 && (steps.el > 0.05 || steps.T > 0.01); iter++) {
        let improved = false;
        for (const key of ['el', 'az', 'T'] as const) {
            for (const sgn of [-1, 1]) {
                const trial = { ...cur, [key]: cur[key] + sgn * steps[key] };
                trial.el = Math.max(0.5, Math.min(89.5, trial.el));
                trial.az = (trial.az + 360) % 360;
                trial.T = Math.max(T_MIN, Math.min(T_MAX, trial.T));
                const { cost } = skyCost(samples, anglesToDirection(trial.el, trial.az), trial.T);
                if (cost < cur.cost) { cur = { ...trial, cost }; improved = true; }
            }
        }
        if (!improved) steps = { el: steps.el / 2, az: steps.az / 2, T: steps.T / 2 };
    }
    const sun = anglesToDirection(cur.el, cur.az);
    const final = skyCost(samples, sun, cur.T);
    const far = grid.find(g => {
        const d = anglesToDirection(g.el, g.az);
        return Math.acos(Math.max(-1, Math.min(1, d[0] * sun[0] + d[1] * sun[1] + d[2] * sun[2]))) > 30 * DEG;
    });
    const separation = far ? far.cost / Math.max(1e-12, final.cost) : Infinity;
    const luminanceR2 = 1 - final.lumSS / sst;
    if (luminanceR2 < 0.5) throw new SunNotFoundError(`the analytic sky model explains only ${(luminanceR2 * 100).toFixed(0)}% of the sky luminance variation`);
    if (separation < 1.25) throw new SunNotFoundError(`sun positions more than 30 degrees apart fit the sky almost equally well (cost ratio ${separation.toFixed(2)})`);
    return {
        sun,
        elevationDeg: cur.el,
        azimuthDeg: cur.az,
        turbidity: cur.T,
        luminanceR2,
        chromaRms: Math.sqrt(final.chromaSS / (2 * samples.length)),
        separation,
        cost: final.cost,
        samples: samples.length
    };
}

/** Fits only turbidity with the sun direction known (disc or ephemeris). Undefined when the sky does not constrain it. */
export function fitPreethamTurbidity(samples: SkySample[], sun: Vec3): { turbidity: number; luminanceR2: number; chromaRms: number } | undefined {
    if (samples.length < 40) return undefined;
    const sst = logLuminanceSST(samples);
    if (sst / samples.length < 1e-3) return undefined;
    let lo = T_MIN, hi = T_MAX;
    const f = (T: number) => skyCost(samples, sun, T).cost;
    // Golden-section search after a coarse scan picks the bracket.
    let bestT = TURBIDITY_GRID[0], bestC = Infinity;
    for (const T of TURBIDITY_GRID) { const c = f(T); if (c < bestC) { bestC = c; bestT = T; } }
    lo = Math.max(T_MIN, bestT - 1.5); hi = Math.min(T_MAX, bestT + 2);
    const phi = (Math.sqrt(5) - 1) / 2;
    let a = hi - phi * (hi - lo), b = lo + phi * (hi - lo), fa = f(a), fb = f(b);
    for (let i = 0; i < 40; i++) {
        if (fa < fb) { hi = b; b = a; fb = fa; a = hi - phi * (hi - lo); fa = f(a); }
        else { lo = a; a = b; fa = fb; b = lo + phi * (hi - lo); fb = f(b); }
    }
    const T = (lo + hi) / 2;
    const r = skyCost(samples, sun, T);
    const luminanceR2 = 1 - r.lumSS / sst;
    if (luminanceR2 < 0.5) return undefined;
    return { turbidity: T, luminanceR2, chromaRms: Math.sqrt(r.chromaSS / (2 * samples.length)) };
}

/** Preetham's Angstrom turbidity coefficient beta for turbidity T. */
export function angstromBeta(T: number): number {
    return 0.04608 * T - 0.04586;
}

/**
 * Transmittance of the direct solar beam at 680/550/440 nm through Rayleigh and aerosol (Angstrom, alpha 1.3)
 * extinction (Preetham et al. 1999, appendix), air mass from Kasten & Young (1989).
 */
export function directSunTransmittance(T: number, elevationDeg: number): Vec3 {
    const zen = 90 - Math.max(-0.5, elevationDeg);
    const m = 1 / (Math.cos(zen * DEG) + 0.50572 * Math.pow(96.07995 - zen, -1.6364));
    const beta = angstromBeta(T);
    const tau = (lambdaUm: number) => Math.exp(-0.008735 * Math.pow(lambdaUm, -4.08) * m) * Math.exp(-beta * Math.pow(lambdaUm, -1.3) * m);
    return [tau(0.68), tau(0.55), tau(0.44)];
}

/**
 * Meteorological visibility (Koschmieder, 2% contrast) at 550 nm from turbidity: Rayleigh sea-level extinction
 * 0.0116 /km plus the Angstrom aerosol optical depth spread over an aerosol scale height (assumed 1.2 km).
 */
export function visibilityMetersFromTurbidity(T: number, aerosolScaleHeightKm = 1.2): number {
    const tauA = Math.max(0, angstromBeta(T)) * Math.pow(0.55, -1.3);
    const sigmaPerKm = 0.0116 + tauA / aerosolScaleHeightKm;
    return 3.912 / sigmaPerKm * 1000;
}

/** Collects up to `max` unclipped sky samples (evenly strided) with their view directions. */
export function collectSkySamples(
    pixels: Uint8Array | Uint8ClampedArray | Float32Array,
    view: PinholeView,
    mask: Uint8Array,
    max = 600
): SkySample[] {
    const read = pixelReader(pixels, view.width, view.height);
    const idx: number[] = [];
    for (let i = 0; i < mask.length; i++) {
        if (!mask[i]) continue;
        const [r, g, b] = read(i);
        if (Math.max(r, g, b) >= 0.98 || Math.min(r, g, b) <= 0.01) continue; // clipped
        idx.push(i);
    }
    const step = Math.max(1, Math.floor(idx.length / max));
    const out: SkySample[] = [];
    for (let k = 0; k < idx.length; k += step) {
        const i = idx[k];
        const x = i % view.width, y = (i - x) / view.width;
        const dir = pixelDirection(view, x, y);
        if (dir[1] <= 0.01) continue; // the model is defined above the horizon
        const [r, g, b] = read(i);
        const lin = linearRgbToXyY(srgbToLinear(r), srgbToLinear(g), srgbToLinear(b));
        out.push({ dir, Y: lin.Y, x: lin.x, y: lin.y });
    }
    return out;
}

// ---------------------------------------------------------------------------------------------------------------
// Sun disc
// ---------------------------------------------------------------------------------------------------------------

export interface SunDisc {
    x: number;
    y: number;
    pixels: number;
    /** Area of the cluster over the area of the circle reaching its farthest pixel (1 for a disc). */
    circularity: number;
}

/**
 * The largest cluster of near-white saturated pixels (luma >= 0.95) that touches the segmented sky. Undefined when
 * there is none, or when it is not compact enough to be a disc or glare core.
 */
export function detectSunDisc(sky: SkySegmentation, width: number, height: number): SunDisc | undefined {
    const n = width * height;
    // Sky within three pixels: the disc rim is a steep gradient, so the sky mask itself stops short of it.
    const nearSky = new Uint8Array(sky.mask);
    for (let pass = 0; pass < 3; pass++) {
        const prev = nearSky.slice();
        for (let i = 0; i < n; i++) {
            if (prev[i]) continue;
            const x = i % width;
            if ((x > 0 && prev[i - 1]) || (x < width - 1 && prev[i + 1]) || (i >= width && prev[i - width]) || (i + width < n && prev[i + width])) nearSky[i] = 1;
        }
    }
    const skyLumas: number[] = [];
    for (let i = 0; i < n; i++) if (sky.mask[i]) skyLumas.push(sky.luma[i]);
    if (!skyLumas.length) return undefined;
    skyLumas.sort((a, b) => a - b);
    const skyMedianLuma = skyLumas[Math.floor(skyLumas.length / 2)];
    const seen = new Uint8Array(n);
    let best: SunDisc | undefined;
    for (let s = 0; s < n; s++) {
        if (seen[s] || sky.luma[s] < 0.95) continue;
        const members: number[] = [];
        const stack = [s];
        seen[s] = 1;
        let boundary = 0, skyBoundary = 0, touchesBorder = false;
        while (stack.length) {
            const i = stack.pop()!;
            members.push(i);
            const x = i % width, y = (i - x) / width;
            for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
                const nx = x + dx, ny = y + dy;
                if (nx < 0 || ny < 0 || nx >= width || ny >= height) { touchesBorder = true; continue; }
                const j = ny * width + nx;
                if (sky.luma[j] >= 0.95) {
                    if (!seen[j]) { seen[j] = 1; stack.push(j); }
                    continue;
                }
                boundary++;
                if (nearSky[j]) skyBoundary++;
            }
        }
        // A sun core: small, not cut by the frame edge, ringed mostly by sky, in a sky clearly darker than it (a clipped
        // patch of bright overcast or a white surface does not stand out from its surroundings this way).
        if (touchesBorder || members.length < 3 || members.length > 0.02 * n) continue;
        if (boundary === 0 || skyBoundary / boundary < 0.6 || skyMedianLuma > 0.85) continue;
        let cx = 0, cy = 0;
        for (const i of members) { cx += i % width; cy += Math.floor(i / width); }
        cx /= members.length; cy /= members.length;
        let rMax = 0;
        for (const i of members) rMax = Math.max(rMax, Math.hypot(i % width - cx, Math.floor(i / width) - cy));
        const circularity = members.length / (Math.PI * (rMax + 0.5) ** 2);
        if (circularity < 0.5) continue;
        if (!best || members.length > best.pixels) best = { x: cx, y: cy, pixels: members.length, circularity: Math.min(1, circularity) };
    }
    return best;
}

// ---------------------------------------------------------------------------------------------------------------
// Spherical harmonics (real, order 2: 9 coefficients) by least squares
// ---------------------------------------------------------------------------------------------------------------

/** Real SH basis in the Three.js SphericalHarmonics3 order: (0,0), (1,-1) y, (1,0) z, (1,1) x, (2,-2) xy, (2,-1) yz, (2,0), (2,1) xz, (2,2). */
export function shBasis(d: Vec3): number[] {
    const [x, y, z] = d;
    return [
        0.282095,
        0.488603 * y,
        0.488603 * z,
        0.488603 * x,
        1.092548 * x * y,
        1.092548 * y * z,
        0.315392 * (3 * z * z - 1),
        1.092548 * x * z,
        0.546274 * (x * x - y * y)
    ];
}

function solveSymmetric(A: number[][], b: number[]): number[] {
    const n = b.length;
    const M = A.map((row, i) => [...row, b[i]]);
    for (let c = 0; c < n; c++) {
        let p = c;
        for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
        [M[c], M[p]] = [M[p], M[c]];
        const piv = M[c][c] || 1e-12;
        for (let r = c + 1; r < n; r++) {
            const f = M[r][c] / piv;
            for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
        }
    }
    const out = new Array(n).fill(0);
    for (let r = n - 1; r >= 0; r--) {
        let s = M[r][n];
        for (let k = r + 1; k < n; k++) s -= M[r][k] * out[k];
        out[r] = s / (M[r][r] || 1e-12);
    }
    return out;
}

export interface ShFit {
    /** 9 x 3 coefficients (linear RGB radiance, relative exposure). */
    coefficients: number[][];
    /** RMS residual of the fit over the samples (linear RGB, averaged over channels). */
    rmsResidual: number;
    /** Solid angle of the camera frustum over 4 pi: the part of the sphere the fit actually saw. */
    sphereCoverage: number;
    samples: number;
}

/**
 * Least-squares order-2 SH fit of the linear radiance seen in the frame. Ridge-damped (lambda = 1e-3 of the mean
 * diagonal) because a single frame covers only part of the sphere; the coverage is reported with the fit.
 */
export function fitSphericalHarmonics(
    pixels: Uint8Array | Uint8ClampedArray | Float32Array,
    view: PinholeView,
    maxSamples = 4000
): ShFit {
    const read = pixelReader(pixels, view.width, view.height);
    const n = view.width * view.height;
    const step = Math.max(1, Math.floor(Math.sqrt(n / maxSamples)));
    const AtA = Array.from({ length: 9 }, () => new Array(9).fill(0));
    const Atb = [new Array(9).fill(0), new Array(9).fill(0), new Array(9).fill(0)];
    const rows: { basis: number[]; rgb: Vec3 }[] = [];
    for (let y = 0; y < view.height; y += step) {
        for (let x = 0; x < view.width; x += step) {
            const basis = shBasis(pixelDirection(view, x, y));
            const [r, g, b] = read(y * view.width + x);
            const rgb: Vec3 = [srgbToLinear(r), srgbToLinear(g), srgbToLinear(b)];
            rows.push({ basis, rgb });
            for (let i = 0; i < 9; i++) {
                for (let j = 0; j < 9; j++) AtA[i][j] += basis[i] * basis[j];
                for (let c = 0; c < 3; c++) Atb[c][i] += basis[i] * rgb[c];
            }
        }
    }
    let trace = 0;
    for (let i = 0; i < 9; i++) trace += AtA[i][i];
    const lambda = 1e-3 * trace / 9;
    for (let i = 0; i < 9; i++) AtA[i][i] += lambda;
    const perChannel = [0, 1, 2].map(c => solveSymmetric(AtA, Atb[c]));
    let ss = 0;
    for (const row of rows) {
        for (let c = 0; c < 3; c++) {
            let pred = 0;
            for (let i = 0; i < 9; i++) pred += perChannel[c][i] * row.basis[i];
            ss += (pred - row.rgb[c]) ** 2;
        }
    }
    const a = view.hfovDeg * DEG / 2, b = view.vfovDeg * DEG / 2;
    const solidAngle = 4 * Math.asin(Math.sin(a) * Math.sin(b));
    return {
        coefficients: Array.from({ length: 9 }, (_, i) => [perChannel[0][i], perChannel[1][i], perChannel[2][i]]),
        rmsResidual: Math.sqrt(ss / Math.max(1, rows.length * 3)),
        sphereCoverage: solidAngle / (4 * Math.PI),
        samples: rows.length
    };
}

// ---------------------------------------------------------------------------------------------------------------
// Lit / shadow split (Otsu on linear luminance of the non-sky pixels)
// ---------------------------------------------------------------------------------------------------------------

export interface LitShadowSplit {
    litMeanSrgb: Vec3;
    shadowMeanSrgb: Vec3;
    /** Mean linear luminance ratio lit / shadow. */
    luminanceRatio: number;
    /** Between-class variance over total variance (0..1): how bimodal the luminance is. */
    separability: number;
    litFraction: number;
    /** Mean luma gradient across lit/shadow boundaries over the class luma difference (1 = hard step). */
    edgeSharpness?: number;
}

export function splitLitShadow(
    pixels: Uint8Array | Uint8ClampedArray | Float32Array,
    width: number,
    height: number,
    skyMask: Uint8Array
): LitShadowSplit | undefined {
    const read = pixelReader(pixels, width, height);
    const n = width * height;
    // Exclude the sky and a two-pixel band around it: pixels on the skyline mix sky and surface.
    const excluded = new Uint8Array(skyMask);
    for (let pass = 0; pass < 2; pass++) {
        const prev = excluded.slice();
        for (let i = 0; i < n; i++) {
            if (prev[i]) continue;
            const x = i % width;
            if ((x > 0 && prev[i - 1]) || (x < width - 1 && prev[i + 1]) || (i >= width && prev[i - width]) || (i + width < n && prev[i + width])) excluded[i] = 1;
        }
    }
    skyMask = excluded;
    const lum = new Float32Array(n);
    const bins = 256;
    const hist = new Float64Array(bins);
    let total = 0;
    for (let i = 0; i < n; i++) {
        if (skyMask[i]) continue;
        const [r, g, b] = read(i);
        lum[i] = 0.2126 * srgbToLinear(r) + 0.7152 * srgbToLinear(g) + 0.0722 * srgbToLinear(b);
        hist[Math.min(bins - 1, Math.floor(lum[i] * bins))]++;
        total++;
    }
    if (total < 50) return undefined;
    let sumAll = 0;
    for (let k = 0; k < bins; k++) sumAll += k * hist[k];
    let wB = 0, sumB = 0, bestVar = -1, thr = 0;
    for (let k = 0; k < bins; k++) {
        wB += hist[k]; if (wB === 0) continue;
        const wF = total - wB; if (wF === 0) break;
        sumB += k * hist[k];
        const mB = sumB / wB, mF = (sumAll - sumB) / wF;
        const v = wB * wF * (mB - mF) ** 2;
        if (v > bestVar) { bestVar = v; thr = k; }
    }
    const mean = sumAll / total;
    let totVar = 0;
    for (let k = 0; k < bins; k++) totVar += hist[k] * (k - mean) ** 2;
    const separability = totVar > 0 ? (bestVar / total) / totVar : 0;
    const t = (thr + 1) / bins;
    const lit: Vec3 = [0, 0, 0], sh: Vec3 = [0, 0, 0];
    let nL = 0, nS = 0, lumL = 0, lumS = 0;
    for (let i = 0; i < n; i++) {
        if (skyMask[i]) continue;
        const rgb = read(i);
        if (lum[i] >= t) { lit[0] += rgb[0]; lit[1] += rgb[1]; lit[2] += rgb[2]; nL++; lumL += lum[i]; }
        else { sh[0] += rgb[0]; sh[1] += rgb[1]; sh[2] += rgb[2]; nS++; lumS += lum[i]; }
    }
    if (nL === 0 || nS === 0) return undefined;
    const litMean: Vec3 = [lit[0] / nL, lit[1] / nL, lit[2] / nL];
    const shMean: Vec3 = [sh[0] / nS, sh[1] / nS, sh[2] / nS];
    const lumLit = lumL / nL, lumSh = lumS / nS;
    // Boundary sharpness on gamma luma (what the eye and the gradient see).
    const gl = (rgb: Vec3) => 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
    const delta = gl(litMean) - gl(shMean);
    let gSum = 0, gCount = 0;
    for (let y = 1; y < height - 1; y++) {
        for (let x = 1; x < width - 1; x++) {
            const i = y * width + x;
            if (skyMask[i] || skyMask[i + 1] || skyMask[i + width]) continue;
            const a = lum[i] >= t, right = lum[i + 1] >= t, down = lum[i + width] >= t;
            if (a === right && a === down) continue;
            const gx = gl(read(i + 1)) - gl(read(i - 1));
            const gy = gl(read(i + width)) - gl(read(i - width));
            gSum += Math.hypot(gx, gy) / 2;
            gCount++;
        }
    }
    return {
        litMeanSrgb: litMean,
        shadowMeanSrgb: shMean,
        luminanceRatio: lumLit / Math.max(1e-6, lumSh),
        separability,
        litFraction: nL / total,
        edgeSharpness: gCount > 0 && delta > 1e-3 ? Math.min(1, (gSum / gCount) / delta * 2) : undefined
    };
}
