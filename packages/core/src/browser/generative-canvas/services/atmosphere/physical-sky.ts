/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Physically based clear sky for the sky dome: Rayleigh, Mie and ozone over a spherical planet (the native sky's
 * constants, scratchbox_sky.hpp), with aerosol set by the Preetham turbidity and multiple scattering by Hillaire's
 * (2020) isotropic approximation, so the horizon whitens and twilight colours come from the Earth's shadow rather than
 * a palette. Evaluated on the CPU into a sky-view table (relative azimuth x elevation) the dome shader samples.
 *
 * Spectral: computed at 12 wavelengths across 385-745 nm under the 5778 K solar spectrum and projected onto the CIE
 * 1931 observer, so neither the sun's own colour nor the reddening of long paths is approximated by three RGB samples
 * (that over-blued the high-sun zenith, which a white sun lit, and over-reddened the low-sun sky).
 *
 * Radiance is linear sRGB (D65) per unit of top-of-atmosphere solar illuminance.
 * Frame: observer on +Y, sun in the X-Y plane (x = cos(elevation), y = sin(elevation)); azimuth is measured from the sun.
 */

import { angstromBeta } from './sky-photometry';
import { cieColorMatching, extraterrestrialSolarIrradiance, ozoneAbsorption, xyzToLinearSrgb } from './spectral-sun';

type V3 = [number, number, number];

const EARTH_RADIUS = 6360e3;
const TOP_RADIUS = 6420e3;
const RAYLEIGH_SCALE = 8000;
const MIE_SCALE = 1200;
const OZONE_CENTER = 25000;
const OZONE_HALF_WIDTH = 15000;
const MIE_ALBEDO = 3.996 / 4.440;
/** Asymmetry of continental aerosol (d'Almeida et al. 1991: ~0.65-0.75 in the visible). */
const MIE_G = 0.7;

/** Wavelength bins (nm): 12 centres 30 nm apart covering 385-745 nm. */
const LAMBDAS = Array.from({ length: 12 }, (_, i) => 400 + 30 * i);
const BIN_NM = 30;
const NL = LAMBDAS.length;
/** Rayleigh scattering at sea level (1/m): the native sky's 33.1e-6 at 440 nm, scaled by lambda^-4. */
const RAYLEIGH_SCATTERING = LAMBDAS.map(l => 33.1e-6 * Math.pow(440 / l, 4));
/** Ozone absorption at the reference density (1/m): the same Chappuis fit as the spectral sun. */
const OZONE_ABSORPTION = LAMBDAS.map(l => ozoneAbsorption(l));
/** Angstrom spectral shape of the aerosol, relative to 550 nm. */
const MIE_SPECTRAL = LAMBDAS.map(l => Math.pow(l / 550, -1.3));
/** Per bin: solar irradiance times the colour-matching functions times the bin width, over the sun's own luminance. */
const SPECTRAL_TO_XYZ = (() => {
    const w = LAMBDAS.map(l => { const [x, y, z] = cieColorMatching(l); const e = extraterrestrialSolarIrradiance(l) * BIN_NM; return [x * e, y * e, z * e]; });
    const Ysun = w.reduce((s, v) => s + v[1], 0);
    return w.map(v => v.map(c => c / Ysun) as V3);
})();

/** Spectral values (one per wavelength bin) to linear sRGB. */
function spectrumToRgb(spec: ArrayLike<number>): V3 {
    let X = 0, Y = 0, Z = 0;
    for (let c = 0; c < NL; c++) {
        const w = SPECTRAL_TO_XYZ[c];
        X += spec[c] * w[0]; Y += spec[c] * w[1]; Z += spec[c] * w[2];
    }
    return xyzToLinearSrgb([X, Y, Z]);
}

export interface PhysicalSkyOptions {
    sunElevationDeg: number;
    /** Preetham turbidity: the aerosol optical depth at 550 nm is beta * 0.55^-1.3. */
    turbidity: number;
    observerAltitudeMeters?: number;
    groundAlbedo?: number;
    /** Sky-view table size; elevation rows are spaced by sqrt(elevation) to resolve the horizon. */
    azimuthResolution?: number;
    elevationResolution?: number;
}

export interface PhysicalSkyLut {
    /** RGB radiance, row-major [elevationRow][azimuthCol]; col 0 = toward the sun, last = away; row 0 = horizon. */
    data: Float32Array;
    azimuthResolution: number;
    elevationResolution: number;
    /** Irradiance on a level surface from the sky alone (sun disc excluded), RGB. */
    horizontalIrradiance: V3;
    /** Direct-beam transmittance from the observer to the sun, RGB (0 below the horizon). */
    sunTransmittance: V3;
}

interface Medium { mieExtinction: number[]; mieScattering: number[] }

function medium(turbidity: number): Medium {
    if (!Number.isFinite(turbidity) || turbidity < 1) throw new RangeError(`physical sky: turbidity ${turbidity} is outside the physical range (1 = pure Rayleigh)`);
    const tau550 = Math.max(0, angstromBeta(turbidity)) * Math.pow(0.55, -1.3);
    const ext550 = tau550 / MIE_SCALE;
    const mieExtinction = MIE_SPECTRAL.map(s => ext550 * s);
    return { mieExtinction, mieScattering: mieExtinction.map(e => e * MIE_ALBEDO) };
}

/** Distance along a ray from radius r with zenith cosine mu to the top of the atmosphere, and whether it hits the ground first. */
function rayLength(r: number, mu: number): { length: number; ground: boolean } {
    const disc = r * r * (mu * mu - 1) + EARTH_RADIUS * EARTH_RADIUS;
    if (mu < 0 && disc >= 0) return { length: -r * mu - Math.sqrt(disc), ground: true };
    return { length: -r * mu + Math.sqrt(Math.max(0, r * r * (mu * mu - 1) + TOP_RADIUS * TOP_RADIUS)), ground: false };
}

const hits = (r: number, mu: number) => mu < 0 && r * r * (mu * mu - 1) + EARTH_RADIUS * EARTH_RADIUS >= 0;

/** Bilinear lookup into an [nr][nmu][NL] table, written into `out`. */
function lookup(table: Float32Array, nr: number, nmu: number, fi: number, fj: number, out: Float64Array): void {
    const i0 = Math.min(nr - 2, Math.max(0, Math.floor(fi))), j0 = Math.min(nmu - 2, Math.max(0, Math.floor(fj)));
    const a = Math.min(1, Math.max(0, fi - i0)), b = Math.min(1, Math.max(0, fj - j0));
    const k00 = (i0 * nmu + j0) * NL, k01 = k00 + NL, k10 = k00 + nmu * NL, k11 = k10 + NL;
    const w00 = (1 - a) * (1 - b), w01 = (1 - a) * b, w10 = a * (1 - b), w11 = a * b;
    for (let c = 0; c < NL; c++) out[c] = table[k00 + c] * w00 + table[k01 + c] * w01 + table[k10 + c] * w10 + table[k11 + c] * w11;
}

/** Transmittance table over (radius, mu), mu spanning -1..1, per wavelength; 0 where the ray meets the ground. */
class Transmittance {
    readonly nr = 48;
    readonly nmu = 192;
    private readonly table: Float32Array;

    constructor(m: Medium) {
        this.table = new Float32Array(this.nr * this.nmu * NL);
        const od = new Float64Array(NL);
        for (let i = 0; i < this.nr; i++) {
            const u = i / (this.nr - 1);
            const r = EARTH_RADIUS + (TOP_RADIUS - EARTH_RADIUS) * u * u;
            for (let j = 0; j < this.nmu; j++) {
                const mu = -1 + (2 * j) / (this.nmu - 1);
                const { length, ground } = rayLength(r, mu);
                if (ground) continue;
                const steps = 40, dt = length / steps;
                od.fill(0);
                for (let s = 0; s < steps; s++) {
                    const t = (s + 0.5) * dt;
                    const h = Math.sqrt(r * r + t * t + 2 * r * mu * t) - EARTH_RADIUS;
                    const dr = Math.exp(-h / RAYLEIGH_SCALE) * dt, dm = Math.exp(-h / MIE_SCALE) * dt;
                    const dO = Math.max(0, 1 - Math.abs(h - OZONE_CENTER) / OZONE_HALF_WIDTH) * dt;
                    for (let c = 0; c < NL; c++) od[c] += RAYLEIGH_SCATTERING[c] * dr + m.mieExtinction[c] * dm + OZONE_ABSORPTION[c] * dO;
                }
                const k = (i * this.nmu + j) * NL;
                for (let c = 0; c < NL; c++) this.table[k + c] = Math.exp(-od[c]);
            }
        }
    }

    /** Transmittance from radius r toward zenith cosine mu, out of the atmosphere (0 if the ground is in the way). */
    atInto(r: number, mu: number, out: Float64Array): void {
        if (hits(r, mu)) { out.fill(0); return; }
        const u = Math.sqrt(Math.min(1, Math.max(0, (r - EARTH_RADIUS) / (TOP_RADIUS - EARTH_RADIUS))));
        lookup(this.table, this.nr, this.nmu, u * (this.nr - 1), ((Math.min(1, Math.max(-1, mu)) + 1) / 2) * (this.nmu - 1), out);
    }
}

/**
 * Hillaire (2020) multiple scattering: for each (radius, sun zenith cosine), the second-order isotropic luminance
 * L2 and the transfer fraction f over the sphere of directions; psi = L2 / (1 - f) sums every further order.
 */
class MultipleScattering {
    readonly nr = 24;
    readonly nmu = 24;
    private readonly table: Float32Array;

    constructor(m: Medium, tr: Transmittance, albedo: number) {
        this.table = new Float32Array(this.nr * this.nmu * NL);
        const N = 64;
        const dirs: V3[] = [];
        for (let k = 0; k < N; k++) {
            // Fibonacci sphere: near-uniform directions.
            const y = 1 - (2 * (k + 0.5)) / N, rad = Math.sqrt(1 - y * y), phi = k * Math.PI * (3 - Math.sqrt(5));
            dirs.push([rad * Math.cos(phi), y, rad * Math.sin(phi)]);
        }
        const L2 = new Float64Array(NL), F = new Float64Array(NL), T = new Float64Array(NL), ts = new Float64Array(NL);
        for (let i = 0; i < this.nr; i++) {
            const r = EARTH_RADIUS + ((TOP_RADIUS - EARTH_RADIUS) * i) / (this.nr - 1) + 1;
            for (let j = 0; j < this.nmu; j++) {
                const muS = -1 + (2 * j) / (this.nmu - 1);
                const sun: V3 = [Math.sqrt(Math.max(0, 1 - muS * muS)), muS, 0];
                L2.fill(0); F.fill(0);
                for (const d of dirs) {
                    const { length, ground } = rayLength(r, d[1]);
                    const steps = 16, dt = length / steps;
                    T.fill(1);
                    for (let s = 0; s < steps; s++) {
                        const t = (s + 0.5) * dt;
                        const px = d[0] * t, py = r + d[1] * t, pz = d[2] * t;
                        const rr = Math.sqrt(px * px + py * py + pz * pz);
                        const h = rr - EARTH_RADIUS;
                        const dr = Math.exp(-h / RAYLEIGH_SCALE), dm = Math.exp(-h / MIE_SCALE), dO = Math.max(0, 1 - Math.abs(h - OZONE_CENTER) / OZONE_HALF_WIDTH);
                        tr.atInto(rr, (px * sun[0] + py * sun[1] + pz * sun[2]) / rr, ts);
                        for (let c = 0; c < NL; c++) {
                            const sc = RAYLEIGH_SCATTERING[c] * dr + m.mieScattering[c] * dm;
                            const e = RAYLEIGH_SCATTERING[c] * dr + m.mieExtinction[c] * dm + OZONE_ABSORPTION[c] * dO;
                            const stepT = Math.exp(-e * dt);
                            // Analytic integration over the step (Hillaire's energy-conserving form).
                            const integral = e > 0 ? (1 - stepT) / e : dt;
                            L2[c] += (T[c] * sc * ts[c] * integral) / (4 * Math.PI);
                            F[c] += T[c] * sc * integral;
                            T[c] *= stepT;
                        }
                    }
                    if (ground) {
                        const gx = d[0] * length, gy = r + d[1] * length, gz = d[2] * length;
                        const gr = Math.sqrt(gx * gx + gy * gy + gz * gz);
                        const muG = (gx * sun[0] + gy * sun[1] + gz * sun[2]) / gr;
                        tr.atInto(EARTH_RADIUS + 1, muG, ts);
                        for (let c = 0; c < NL; c++) L2[c] += (T[c] * ts[c] * Math.max(0, muG) * albedo) / Math.PI;
                    }
                }
                const k = (i * this.nmu + j) * NL;
                // Uniform directions: integrals against the isotropic phase 1/(4 pi) are plain averages.
                for (let c = 0; c < NL; c++) this.table[k + c] = L2[c] / N / Math.max(1e-6, 1 - F[c] / N);
            }
        }
    }

    atInto(r: number, muS: number, out: Float64Array): void {
        lookup(this.table, this.nr, this.nmu,
            Math.min(1, Math.max(0, (r - EARTH_RADIUS) / (TOP_RADIUS - EARTH_RADIUS))) * (this.nr - 1),
            ((Math.min(1, Math.max(-1, muS)) + 1) / 2) * (this.nmu - 1), out);
    }
}

const atmosphereCache = new Map<string, { tr: Transmittance; ms: MultipleScattering; m: Medium }>();

function atmosphere(turbidity: number, albedo: number) {
    const key = `${turbidity.toFixed(3)}|${albedo.toFixed(3)}`;
    let a = atmosphereCache.get(key);
    if (!a) {
        const m = medium(turbidity);
        const tr = new Transmittance(m);
        a = { m, tr, ms: new MultipleScattering(m, tr, albedo) };
        if (atmosphereCache.size > 16) atmosphereCache.clear();
        atmosphereCache.set(key, a);
    }
    return a;
}

const rayleighPhase = (c: number) => (3 / (16 * Math.PI)) * (1 + c * c);
function miePhase(c: number): number {
    // Cornette-Shanks: Henyey-Greenstein with Rayleigh-like symmetric correction.
    const g = MIE_G, g2 = g * g;
    return ((3 / (8 * Math.PI)) * ((1 - g2) * (1 + c * c))) / ((2 + g2) * Math.pow(1 + g2 - 2 * g * c, 1.5));
}

/** Elevation of sky-view row `i` (row 0 at the horizon), degrees. */
export function physicalSkyRowElevation(i: number, rows: number): number {
    const u = (i + 0.5) / rows;
    return u * u * 90;
}

/** Builds the sky-view table for one sun. */
export function buildPhysicalSkyLut(opts: PhysicalSkyOptions): PhysicalSkyLut {
    const W = opts.azimuthResolution ?? 64, H = opts.elevationResolution ?? 48;
    const { m, tr, ms } = atmosphere(opts.turbidity, opts.groundAlbedo ?? 0.2);
    const r0 = EARTH_RADIUS + Math.max(1, opts.observerAltitudeMeters ?? 1);
    const se = (opts.sunElevationDeg * Math.PI) / 180;
    const sun: V3 = [Math.cos(se), Math.sin(se), 0];
    const data = new Float32Array(W * H * 3);
    const E: V3 = [0, 0, 0];
    const ts = new Float64Array(NL), psi = new Float64Array(NL), L = new Float64Array(NL), T = new Float64Array(NL);
    for (let i = 0; i < H; i++) {
        const el = (physicalSkyRowElevation(i, H) * Math.PI) / 180;
        for (let j = 0; j < W; j++) {
            const az = (Math.PI * (j + 0.5)) / W;
            const d: V3 = [Math.cos(el) * Math.cos(az), Math.sin(el), Math.cos(el) * Math.sin(az)];
            const cosTheta = d[0] * sun[0] + d[1] * sun[1] + d[2] * sun[2];
            const pR = rayleighPhase(cosTheta), pM = miePhase(cosTheta);
            const { length } = rayLength(r0, d[1]);
            const steps = 24;
            L.fill(0); T.fill(1);
            // Steps grow with distance (quadratic), resolving the dense air near the observer.
            let tPrev = 0;
            for (let s = 0; s < steps; s++) {
                const t1 = length * ((s + 1) / steps) * ((s + 1) / steps);
                const dt = t1 - tPrev, t = (tPrev + t1) / 2;
                tPrev = t1;
                const px = d[0] * t, py = r0 + d[1] * t, pz = d[2] * t;
                const rr = Math.sqrt(px * px + py * py + pz * pz);
                const h = rr - EARTH_RADIUS;
                const dr = Math.exp(-h / RAYLEIGH_SCALE), dm = Math.exp(-h / MIE_SCALE), dO = Math.max(0, 1 - Math.abs(h - OZONE_CENTER) / OZONE_HALF_WIDTH);
                const muSun = (px * sun[0] + py * sun[1] + pz * sun[2]) / rr;
                tr.atInto(rr, muSun, ts);
                ms.atInto(rr, muSun, psi);
                for (let c = 0; c < NL; c++) {
                    const sR = RAYLEIGH_SCATTERING[c] * dr, sM = m.mieScattering[c] * dm;
                    const e = sR + m.mieExtinction[c] * dm + OZONE_ABSORPTION[c] * dO;
                    const source = ts[c] * (sR * pR + sM * pM) + (sR + sM) * psi[c];
                    const stepT = Math.exp(-e * dt);
                    L[c] += T[c] * source * (e > 0 ? (1 - stepT) / e : dt);
                    T[c] *= stepT;
                }
            }
            const rgb = spectrumToRgb(L);
            const k = (i * W + j) * 3;
            data[k] = rgb[0]; data[k + 1] = rgb[1]; data[k + 2] = rgb[2];
            // Both halves of the sky (azimuth ±): solid angle of the cell times cos(zenith).
            const u0 = i / H, u1 = (i + 1) / H;
            const sin0 = Math.sin((u0 * u0 * Math.PI) / 2), sin1 = Math.sin((u1 * u1 * Math.PI) / 2);
            const w = (sin1 - sin0) * (Math.PI / W) * 2 * Math.sin(el);
            E[0] += rgb[0] * w; E[1] += rgb[1] * w; E[2] += rgb[2] * w;
        }
    }
    tr.atInto(r0, sun[1], ts);
    return { data, azimuthResolution: W, elevationResolution: H, horizontalIrradiance: E, sunTransmittance: spectrumToRgb(ts) };
}
