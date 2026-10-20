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
 * Radiance is per unit of top-of-atmosphere solar irradiance, in linear RGB sampled at 680/550/440 nm.
 * Frame: observer on +Y, sun in the X-Y plane (x = cos(elevation), y = sin(elevation)); azimuth is measured from the sun.
 */

import { angstromBeta } from './sky-photometry';

type V3 = [number, number, number];

const EARTH_RADIUS = 6360e3;
const TOP_RADIUS = 6420e3;
const RAYLEIGH_SCALE = 8000;
const MIE_SCALE = 1200;
const OZONE_CENTER = 25000;
const OZONE_HALF_WIDTH = 15000;
const RAYLEIGH_SCATTERING: V3 = [5.802e-6, 13.558e-6, 33.1e-6];
const OZONE_ABSORPTION: V3 = [0.650e-6, 1.881e-6, 0.085e-6];
/** Mie extinction per unit of reference dust density (the native sky's 4.440e-6 /m) and its single-scattering albedo. */
const MIE_EXTINCTION_REF = 4.440e-6;
const MIE_ALBEDO = 3.996 / 4.440;
/** Angstrom spectral shape of the aerosol, relative to 550 nm, at 680/550/440 nm. */
const MIE_SPECTRAL: V3 = [Math.pow(680 / 550, -1.3), 1, Math.pow(440 / 550, -1.3)];
/** Asymmetry of continental aerosol (d'Almeida et al. 1991: ~0.65-0.75 in the visible). */
const MIE_G = 0.7;

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

interface Medium { mieExtinction: V3; mieScattering: V3 }

function medium(turbidity: number): Medium {
    if (!Number.isFinite(turbidity) || turbidity < 1) throw new RangeError(`physical sky: turbidity ${turbidity} is outside the physical range (1 = pure Rayleigh)`);
    const tau550 = Math.max(0, angstromBeta(turbidity)) * Math.pow(0.55, -1.3);
    const ext550 = tau550 / MIE_SCALE;
    const mieExtinction = MIE_SPECTRAL.map(s => ext550 * s) as V3;
    return { mieExtinction, mieScattering: mieExtinction.map(e => e * MIE_ALBEDO) as V3 };
}

function densities(r: number): [number, number, number] {
    const h = Math.max(0, r - EARTH_RADIUS);
    return [Math.exp(-h / RAYLEIGH_SCALE), Math.exp(-h / MIE_SCALE), Math.max(0, 1 - Math.abs(h - OZONE_CENTER) / OZONE_HALF_WIDTH)];
}

function extinction(r: number, m: Medium): V3 {
    const [dr, dm, dO] = densities(r);
    return [0, 1, 2].map(c => RAYLEIGH_SCATTERING[c] * dr + m.mieExtinction[c] * dm + OZONE_ABSORPTION[c] * dO) as V3;
}

/** Distance along a ray from radius r with zenith cosine mu to the top of the atmosphere, and whether it hits the ground first. */
function rayLength(r: number, mu: number): { length: number; ground: boolean } {
    const disc = r * r * (mu * mu - 1) + EARTH_RADIUS * EARTH_RADIUS;
    if (mu < 0 && disc >= 0) return { length: -r * mu - Math.sqrt(disc), ground: true };
    return { length: -r * mu + Math.sqrt(Math.max(0, r * r * (mu * mu - 1) + TOP_RADIUS * TOP_RADIUS)), ground: false };
}

/** Transmittance table over (radius, mu), mu spanning -1..1; 0 where the ray meets the ground. */
class Transmittance {
    private readonly nr = 48;
    private readonly nmu = 192;
    private readonly table: Float32Array;

    constructor(private readonly m: Medium) {
        this.table = new Float32Array(this.nr * this.nmu * 3);
        for (let i = 0; i < this.nr; i++) {
            const r = this.radius(i);
            for (let j = 0; j < this.nmu; j++) {
                const mu = -1 + (2 * j) / (this.nmu - 1);
                const { length, ground } = rayLength(r, mu);
                const k = (i * this.nmu + j) * 3;
                if (ground) continue;
                const steps = 40, dt = length / steps;
                const od: V3 = [0, 0, 0];
                for (let s = 0; s < steps; s++) {
                    const t = (s + 0.5) * dt;
                    const rr = Math.sqrt(r * r + t * t + 2 * r * mu * t);
                    const e = extinction(rr, m);
                    od[0] += e[0] * dt; od[1] += e[1] * dt; od[2] += e[2] * dt;
                }
                this.table[k] = Math.exp(-od[0]); this.table[k + 1] = Math.exp(-od[1]); this.table[k + 2] = Math.exp(-od[2]);
            }
        }
    }

    private radius(i: number): number {
        const u = i / (this.nr - 1);
        return EARTH_RADIUS + (TOP_RADIUS - EARTH_RADIUS) * u * u;
    }

    /** Transmittance from radius r toward zenith cosine mu, out of the atmosphere (0 if the ground is in the way). */
    at(r: number, mu: number): V3 {
        if (rayLength(r, mu).ground) return [0, 0, 0];
        const u = Math.sqrt(Math.min(1, Math.max(0, (r - EARTH_RADIUS) / (TOP_RADIUS - EARTH_RADIUS))));
        const fi = u * (this.nr - 1), fj = ((Math.min(1, Math.max(-1, mu)) + 1) / 2) * (this.nmu - 1);
        const i0 = Math.min(this.nr - 2, Math.floor(fi)), j0 = Math.min(this.nmu - 2, Math.floor(fj));
        const a = fi - i0, b = fj - j0;
        const out: V3 = [0, 0, 0];
        for (let c = 0; c < 3; c++) {
            const v = (ii: number, jj: number) => this.table[(ii * this.nmu + jj) * 3 + c];
            out[c] = (v(i0, j0) * (1 - b) + v(i0, j0 + 1) * b) * (1 - a) + (v(i0 + 1, j0) * (1 - b) + v(i0 + 1, j0 + 1) * b) * a;
        }
        return out;
    }
}

/**
 * Hillaire (2020) multiple scattering: for each (radius, sun zenith cosine), the second-order isotropic luminance
 * L2 and the transfer fraction f over the sphere of directions; psi = L2 / (1 - f) sums every further order.
 */
class MultipleScattering {
    private readonly nr = 24;
    private readonly nmu = 24;
    private readonly table: Float32Array;

    constructor(m: Medium, tr: Transmittance, albedo: number) {
        this.table = new Float32Array(this.nr * this.nmu * 3);
        const dirs: Array<[number, number, number]> = [];
        const N = 64;
        for (let k = 0; k < N; k++) {
            // Fibonacci sphere: near-uniform directions.
            const y = 1 - (2 * (k + 0.5)) / N, rad = Math.sqrt(1 - y * y), phi = k * Math.PI * (3 - Math.sqrt(5));
            dirs.push([rad * Math.cos(phi), y, rad * Math.sin(phi)]);
        }
        for (let i = 0; i < this.nr; i++) {
            const r = EARTH_RADIUS + ((TOP_RADIUS - EARTH_RADIUS) * i) / (this.nr - 1) + 1;
            for (let j = 0; j < this.nmu; j++) {
                const muS = -1 + (2 * j) / (this.nmu - 1);
                const sun: V3 = [Math.sqrt(Math.max(0, 1 - muS * muS)), muS, 0];
                const L2: V3 = [0, 0, 0], F: V3 = [0, 0, 0];
                for (const d of dirs) {
                    const mu = d[1];
                    const { length, ground } = rayLength(r, mu);
                    const steps = 16, dt = length / steps;
                    const T: V3 = [1, 1, 1];
                    for (let s = 0; s < steps; s++) {
                        const t = (s + 0.5) * dt;
                        const px = d[0] * t, py = r + d[1] * t, pz = d[2] * t;
                        const rr = Math.sqrt(px * px + py * py + pz * pz);
                        const [dr, dm] = densities(rr);
                        const e = extinction(rr, m);
                        const muSun = (px * sun[0] + py * sun[1] + pz * sun[2]) / rr;
                        const ts = tr.at(rr, muSun);
                        for (let c = 0; c < 3; c++) {
                            const sc = RAYLEIGH_SCATTERING[c] * dr + m.mieScattering[c] * dm;
                            const stepT = Math.exp(-e[c] * dt);
                            // Analytic integration over the step (Hillaire's energy-conserving form).
                            const integral = e[c] > 0 ? (1 - stepT) / e[c] : dt;
                            L2[c] += T[c] * sc * ts[c] * integral / (4 * Math.PI);
                            F[c] += T[c] * sc * integral;
                            T[c] *= stepT;
                        }
                    }
                    if (ground) {
                        const gx = d[0] * length, gy = r + d[1] * length, gz = d[2] * length;
                        const gr = Math.sqrt(gx * gx + gy * gy + gz * gz);
                        const muG = (gx * sun[0] + gy * sun[1] + gz * sun[2]) / gr;
                        const ts = tr.at(EARTH_RADIUS + 1, muG);
                        for (let c = 0; c < 3; c++) L2[c] += T[c] * ts[c] * Math.max(0, muG) * albedo / Math.PI;
                    }
                }
                const k = (i * this.nmu + j) * 3;
                for (let c = 0; c < 3; c++) {
                    // Uniform directions: integrals against the isotropic phase 1/(4 pi) are plain averages.
                    const l2 = L2[c] / N, f = F[c] / N;
                    this.table[k + c] = l2 / Math.max(1e-6, 1 - f);
                }
            }
        }
    }

    at(r: number, muS: number): V3 {
        const fi = Math.min(1, Math.max(0, (r - EARTH_RADIUS) / (TOP_RADIUS - EARTH_RADIUS))) * (this.nr - 1);
        const fj = ((Math.min(1, Math.max(-1, muS)) + 1) / 2) * (this.nmu - 1);
        const i0 = Math.min(this.nr - 2, Math.floor(fi)), j0 = Math.min(this.nmu - 2, Math.floor(fj));
        const a = fi - i0, b = fj - j0;
        const out: V3 = [0, 0, 0];
        for (let c = 0; c < 3; c++) {
            const v = (ii: number, jj: number) => this.table[(ii * this.nmu + jj) * 3 + c];
            out[c] = (v(i0, j0) * (1 - b) + v(i0, j0 + 1) * b) * (1 - a) + (v(i0 + 1, j0) * (1 - b) + v(i0 + 1, j0 + 1) * b) * a;
        }
        return out;
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
    const W = opts.azimuthResolution ?? 96, H = opts.elevationResolution ?? 64;
    const { m, tr, ms } = atmosphere(opts.turbidity, opts.groundAlbedo ?? 0.2);
    const r0 = EARTH_RADIUS + Math.max(1, opts.observerAltitudeMeters ?? 1);
    const se = (opts.sunElevationDeg * Math.PI) / 180;
    const sun: V3 = [Math.cos(se), Math.sin(se), 0];
    const data = new Float32Array(W * H * 3);
    const E: V3 = [0, 0, 0];
    for (let i = 0; i < H; i++) {
        const el = (physicalSkyRowElevation(i, H) * Math.PI) / 180;
        for (let j = 0; j < W; j++) {
            const az = (Math.PI * (j + 0.5)) / W;
            const d: V3 = [Math.cos(el) * Math.cos(az), Math.sin(el), Math.cos(el) * Math.sin(az)];
            const cosTheta = d[0] * sun[0] + d[1] * sun[1] + d[2] * sun[2];
            const pR = rayleighPhase(cosTheta), pM = miePhase(cosTheta);
            const { length } = rayLength(r0, d[1]);
            const steps = 28;
            const L: V3 = [0, 0, 0], T: V3 = [1, 1, 1];
            // Steps grow with distance (quadratic), resolving the dense air near the observer.
            let tPrev = 0;
            for (let s = 0; s < steps; s++) {
                const t1 = length * Math.pow((s + 1) / steps, 2);
                const dt = t1 - tPrev, t = (tPrev + t1) / 2;
                tPrev = t1;
                const px = d[0] * t, py = r0 + d[1] * t, pz = d[2] * t;
                const rr = Math.sqrt(px * px + py * py + pz * pz);
                const [dr, dm] = densities(rr);
                const e = extinction(rr, m);
                const muSun = (px * sun[0] + py * sun[1] + pz * sun[2]) / rr;
                const ts = tr.at(rr, muSun);
                const psi = ms.at(rr, muSun);
                for (let c = 0; c < 3; c++) {
                    const sR = RAYLEIGH_SCATTERING[c] * dr, sM = m.mieScattering[c] * dm;
                    const source = ts[c] * (sR * pR + sM * pM) + (sR + sM) * psi[c];
                    const stepT = Math.exp(-e[c] * dt);
                    const integral = e[c] > 0 ? (1 - stepT) / e[c] : dt;
                    L[c] += T[c] * source * integral;
                    T[c] *= stepT;
                }
            }
            const k = (i * W + j) * 3;
            data[k] = L[0]; data[k + 1] = L[1]; data[k + 2] = L[2];
            // Both halves of the sky (azimuth ±): solid angle of the cell times cos(zenith).
            const u0 = i / H, u1 = (i + 1) / H;
            const sin0 = Math.sin((u0 * u0 * Math.PI) / 2), sin1 = Math.sin((u1 * u1 * Math.PI) / 2);
            const dOmega = (sin1 - sin0) * (Math.PI / W) * 2;
            const w = dOmega * Math.sin(el);
            E[0] += L[0] * w; E[1] += L[1] * w; E[2] += L[2] * w;
        }
    }
    return { data, azimuthResolution: W, elevationResolution: H, horizontalIrradiance: E, sunTransmittance: tr.at(r0, sun[1]) };
}
