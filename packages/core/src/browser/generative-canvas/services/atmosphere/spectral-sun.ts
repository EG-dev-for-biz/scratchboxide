/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The colour and illuminance of the direct solar beam, integrated over the visible spectrum instead of sampled at three
 * wavelengths. The top-of-atmosphere sun is a 5778 K blackbody scaled to 1 AU (its integral is the ~1361 W/m² solar
 * constant; the real spectrum's Fraunhofer lines are ignored). It is attenuated per wavelength by Rayleigh scattering
 * (scaled by the pressure at the observer's altitude), Angstrom aerosol extinction (Preetham's turbidity, the same as
 * `directSunTransmittance`) and Chappuis-band ozone absorption, then projected onto the CIE 1931 2° observer
 * (Wyman, Sloan & Shirley 2013 multi-lobe fit) and converted to XYZ, linear sRGB (D65) and a correlated colour temperature.
 *
 * Near the horizon the three-sample estimate drifts from the integral because the beam's spectrum is no longer smooth
 * across each sRGB primary's band; the integral is what a camera or eye actually sees.
 */

import { angstromBeta } from './sky-photometry';

const H = 6.62607015e-34;
const C = 2.99792458e8;
const KB = 1.380649e-23;
const SUN_TEMPERATURE_K = 5778;
/** (solar radius / 1 AU)², the solid-angle factor from the sun's surface radiance to irradiance at Earth. */
const SUN_DILUTION = Math.pow(6.957e8 / 1.495978707e11, 2);
const LUMENS_PER_WATT = 683;
const EARTH_RADIUS_M = 6.371e6;
const RAYLEIGH_SCALE_HEIGHT_M = 8434.5;
const AEROSOL_SCALE_HEIGHT_M = 1200;
const ANGSTROM_ALPHA = 1.3;
/** Height of the ozone layer's peak, for its own (flatter) slant path (Iqbal 1983). */
const OZONE_LAYER_HEIGHT_M = 22000;
/** Column of the native sky's ozone tent profile (scratchbox_sky.hpp: half-width 15 km), so both skies hold the same ozone. */
const OZONE_COLUMN_M = 15000;

const LAMBDA_MIN_NM = 380;
const LAMBDA_MAX_NM = 780;
const LAMBDA_STEP_NM = 5;
const DEG = Math.PI / 180;

export type Vec3 = [number, number, number];

/** Piecewise Gaussian with separate widths below and above the centre (Wyman et al. 2013). */
function lobe(lambda: number, mu: number, sigmaBelow: number, sigmaAbove: number): number {
    const t = (lambda - mu) / (lambda < mu ? sigmaBelow : sigmaAbove);
    return Math.exp(-0.5 * t * t);
}

/** CIE 1931 2° colour-matching functions x̄, ȳ, z̄ at `lambdaNm` (multi-lobe fit, Wyman, Sloan & Shirley 2013). */
export function cieColorMatching(lambdaNm: number): Vec3 {
    const x = 1.056 * lobe(lambdaNm, 599.8, 37.9, 31.0) + 0.362 * lobe(lambdaNm, 442.0, 16.0, 26.7) - 0.065 * lobe(lambdaNm, 501.1, 20.4, 26.2);
    const y = 0.821 * lobe(lambdaNm, 568.8, 46.9, 40.5) + 0.286 * lobe(lambdaNm, 530.9, 16.3, 31.1);
    const z = 1.217 * lobe(lambdaNm, 437.0, 11.8, 36.0) + 0.681 * lobe(lambdaNm, 459.0, 26.0, 13.8);
    return [x, y, z];
}

/** Planck spectral radiance in W/(m²·sr·nm). */
export function planckRadiance(lambdaNm: number, kelvin: number): number {
    const l = lambdaNm * 1e-9;
    return (2 * H * C * C) / (Math.pow(l, 5) * (Math.exp((H * C) / (l * KB * kelvin)) - 1)) * 1e-9;
}

/**
 * Ozone absorption (1/m at the reference density) at `lambdaNm`: the Gaussian (log-quadratic) through the three
 * Hillaire (2020) coefficients the native sky uses at 680, 550 and 440 nm. It peaks near 588 nm with ~57 nm width,
 * close to the measured Chappuis band (peak ~602 nm); the Huggins band below 380 nm is outside the visible range.
 */
const OZONE_SAMPLES: Array<[number, number]> = [[440, 0.085e-6], [550, 1.881e-6], [680, 0.650e-6]];
const OZONE_FIT = (() => {
    const [[l0, k0], [l1, k1], [l2, k2]] = OZONE_SAMPLES;
    const y0 = Math.log(k0), y1 = Math.log(k1), y2 = Math.log(k2);
    const s01 = (y1 - y0) / (l1 - l0), s12 = (y2 - y1) / (l2 - l1);
    const c = (s12 - s01) / (l2 - l0);
    const b = s01 - c * (l0 + l1);
    const a = y0 - b * l0 - c * l0 * l0;
    return { a, b, c };
})();
export function ozoneAbsorption(lambdaNm: number): number {
    return Math.exp(OZONE_FIT.a + OZONE_FIT.b * lambdaNm + OZONE_FIT.c * lambdaNm * lambdaNm);
}

/** Relative optical air mass (Kasten & Young 1989) at a solar elevation in degrees, clamped at the horizon. */
export function kastenYoungAirMass(elevationDeg: number): number {
    const zen = 90 - Math.max(0, elevationDeg);
    return 1 / (Math.cos(zen * DEG) + 0.50572 * Math.pow(96.07995 - zen, -1.6364));
}

/** Slant factor through a thin layer at `heightM` (Iqbal 1983): the ozone path saturates near 12 at the horizon, not 38. */
function layerAirMass(elevationDeg: number, heightM: number): number {
    const cz = Math.sin(Math.max(0, elevationDeg) * DEG);
    const r = heightM / EARTH_RADIUS_M;
    return (1 + r) / Math.sqrt(cz * cz + 2 * r);
}

const XYZ_TO_LINEAR_SRGB = [
    [3.2404542, -1.5371385, -0.4985314],
    [-0.9692660, 1.8760108, 0.0415560],
    [0.0556434, -0.2040259, 1.0572252]
];

/** CIE XYZ to linear sRGB (D65 white). Out-of-gamut channels come back negative. */
export function xyzToLinearSrgb(xyz: Vec3): Vec3 {
    const m = XYZ_TO_LINEAR_SRGB;
    return [
        m[0][0] * xyz[0] + m[0][1] * xyz[1] + m[0][2] * xyz[2],
        m[1][0] * xyz[0] + m[1][1] * xyz[1] + m[1][2] * xyz[2],
        m[2][0] * xyz[0] + m[2][1] * xyz[1] + m[2][2] * xyz[2]
    ];
}

/** ∫ S(λ)·{x̄,ȳ,z̄}(λ) dλ over 380–780 nm for a spectral density S in units per nm. */
export function integrateSpectrum(spectrum: (lambdaNm: number) => number): Vec3 {
    const xyz: Vec3 = [0, 0, 0];
    for (let l = LAMBDA_MIN_NM; l <= LAMBDA_MAX_NM; l += LAMBDA_STEP_NM) {
        const s = spectrum(l) * LAMBDA_STEP_NM;
        const cmf = cieColorMatching(l);
        xyz[0] += s * cmf[0];
        xyz[1] += s * cmf[1];
        xyz[2] += s * cmf[2];
    }
    return xyz;
}

function chromaticity(xyz: Vec3): { x: number; y: number } {
    const sum = xyz[0] + xyz[1] + xyz[2];
    return { x: xyz[0] / sum, y: xyz[1] / sum };
}

function uv1960(x: number, y: number): [number, number] {
    const d = -2 * x + 12 * y + 3;
    return [(4 * x) / d, (6 * y) / d];
}

function planckChromaticity(kelvin: number): { x: number; y: number } {
    return chromaticity(integrateSpectrum(l => planckRadiance(l, kelvin)));
}

/** Linear sRGB of a blackbody at `kelvin`, integrated over the CIE observer and scaled so the largest channel is 1. */
export function blackbodyLinearRgbSpectral(kelvin: number): Vec3 {
    return normaliseRgb(xyzToLinearSrgb(integrateSpectrum(l => planckRadiance(l, kelvin))));
}

const LOCUS_MIN_K = 1000;
const LOCUS_MAX_K = 40000;
const LOCUS_STEPS = 400;
let planckLocus: Array<{ logK: number; u: number; v: number }> | undefined;

/** The Planckian locus in CIE 1960 (u, v), log-spaced over 1000–40000 K, built once with the same colour-matching functions. */
function locus(): Array<{ logK: number; u: number; v: number }> {
    if (!planckLocus) {
        const lo = Math.log(LOCUS_MIN_K), hi = Math.log(LOCUS_MAX_K);
        planckLocus = [];
        for (let i = 0; i <= LOCUS_STEPS; i++) {
            const logK = lo + ((hi - lo) * i) / LOCUS_STEPS;
            const p = planckChromaticity(Math.exp(logK));
            const [u, v] = uv1960(p.x, p.y);
            planckLocus.push({ logK, u, v });
        }
    }
    return planckLocus;
}

/**
 * Correlated colour temperature: the point on the Planckian locus nearest the chromaticity in CIE 1960 (u, v), found
 * by projecting onto the locus polyline (0.9% temperature spacing), and that nearest distance (Δuv; above ~0.005 the
 * light is visibly off the locus). Chromaticities beyond the 1000–40000 K ends report the end temperature.
 */
export function correlatedColorTemperature(x: number, y: number): { kelvin: number; deltaUv: number } {
    const [u, v] = uv1960(x, y);
    const pts = locus();
    let best = { logK: pts[0].logK, d: Infinity };
    for (let i = 0; i < pts.length - 1; i++) {
        const a = pts[i], b = pts[i + 1];
        const du = b.u - a.u, dv = b.v - a.v;
        const t = Math.min(1, Math.max(0, ((u - a.u) * du + (v - a.v) * dv) / (du * du + dv * dv)));
        const d = Math.hypot(u - (a.u + t * du), v - (a.v + t * dv));
        if (d < best.d) best = { logK: a.logK + t * (b.logK - a.logK), d };
    }
    return { kelvin: Math.exp(best.logK), deltaUv: best.d };
}

function normaliseRgb(rgb: Vec3): Vec3 {
    const c: Vec3 = [Math.max(0, rgb[0]), Math.max(0, rgb[1]), Math.max(0, rgb[2])];
    const m = Math.max(c[0], c[1], c[2]);
    return m > 0 ? [c[0] / m, c[1] / m, c[2] / m] : [0, 0, 0];
}

export interface SpectralSunOptions {
    /** Preetham turbidity (1 = pure Rayleigh); sets the Angstrom aerosol beta as in `directSunTransmittance`. */
    turbidity: number;
    /** Observer height above sea level; thins the Rayleigh and aerosol columns above the observer. Default 0. */
    observerAltitudeMeters?: number;
    /** Multiplier on the ozone column of the native sky (1 ≈ a typical ~300 DU column). Default 1. */
    ozoneColumnScale?: number;
}

export interface SpectralSun {
    /** Beam colour in linear sRGB, largest channel 1 (out-of-gamut channels clamped to 0 first). */
    linearRgb: Vec3;
    /** Beam XYZ in W/m²-weighted CIE units (Y·683 is the illuminance). */
    xyz: Vec3;
    chromaticity: { x: number; y: number };
    cctKelvin: number;
    /** Distance of the beam's chromaticity from the Planckian locus in CIE 1960 (u, v). */
    deltaUv: number;
    /** Illuminance on a surface facing the sun (direct normal), lux, at a 1 AU sun distance. */
    illuminanceLux: number;
    /** Fraction of the top-of-atmosphere illuminance that arrives. */
    luminousTransmittance: number;
    airMass: number;
}

/** Spectral transmittance of the direct beam at `lambdaNm` for a sun at `elevationDeg`. */
export function spectralBeamTransmittance(lambdaNm: number, elevationDeg: number, opts: SpectralSunOptions): number {
    const h = opts.observerAltitudeMeters ?? 0;
    const m = kastenYoungAirMass(elevationDeg);
    const um = lambdaNm / 1000;
    const tauRayleigh = 0.008735 * Math.pow(um, -4.08) * Math.exp(-h / RAYLEIGH_SCALE_HEIGHT_M);
    const tauAerosol = Math.max(0, angstromBeta(opts.turbidity)) * Math.pow(um, -ANGSTROM_ALPHA) * Math.exp(-h / AEROSOL_SCALE_HEIGHT_M);
    const tauOzone = ozoneAbsorption(lambdaNm) * OZONE_COLUMN_M * (opts.ozoneColumnScale ?? 1);
    return Math.exp(-(tauRayleigh + tauAerosol) * m - tauOzone * layerAirMass(elevationDeg, OZONE_LAYER_HEIGHT_M));
}

/** Top-of-atmosphere solar spectral irradiance at 1 AU, W/(m²·nm). */
export function extraterrestrialSolarIrradiance(lambdaNm: number): number {
    return Math.PI * planckRadiance(lambdaNm, SUN_TEMPERATURE_K) * SUN_DILUTION;
}

/**
 * The direct solar beam for a sun `elevationDeg` above the horizon. Elevations below 0 are evaluated at the horizon
 * (the refracted disc is still partly visible to about -0.83°); callers decide when the beam is gone.
 */
export function spectralSun(elevationDeg: number, opts: SpectralSunOptions): SpectralSun {
    if (!Number.isFinite(opts.turbidity) || opts.turbidity < 1) {
        throw new RangeError(`spectralSun: turbidity ${opts.turbidity} is outside the physical range (1 = pure Rayleigh)`);
    }
    const xyz = integrateSpectrum(l => extraterrestrialSolarIrradiance(l) * spectralBeamTransmittance(l, elevationDeg, opts));
    const top = integrateSpectrum(extraterrestrialSolarIrradiance);
    const xy = chromaticity(xyz);
    const cct = correlatedColorTemperature(xy.x, xy.y);
    return {
        linearRgb: normaliseRgb(xyzToLinearSrgb(xyz)),
        xyz,
        chromaticity: xy,
        cctKelvin: cct.kelvin,
        deltaUv: cct.deltaUv,
        illuminanceLux: xyz[1] * LUMENS_PER_WATT,
        luminousTransmittance: xyz[1] / top[1],
        airMass: kastenYoungAirMass(elevationDeg)
    };
}
