/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Synthetic scans for the revolution fit's tests (revolution-fit.test.ts) with a known truth: a ribbed dome on a drum with
 * a cornice ring and a lantern, standing on a flat roof beside a plain box building, its surface dented by smooth blobs
 * and per-vertex noise as a coarse scan is.
 */

/** A small deterministic generator (mulberry32). */
function rng(seed: number): () => number {
    let a = seed >>> 0;
    return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

export const AXIS = { x: 3.0, z: -2.0 };
export const ROOF_Y = 10;
export const DRUM = { y0: ROOF_Y, y1: 14, r: 6.3 };
export const RING = { y0: 14, y1: 14.6, r: 6.9 };
export const DOME = { y0: 14.6, R0: 6.0, H: 6.5 };
export const LANTERN = { y0: 20.2, y1: 22.6, r: 1.25, capH: 1.3 };
export const RIBS = { K: 12, ampRel: 0.035, sharp: 6 };

/** A thin mast on the lantern's cap: radius and top (m). */
export const MAST = { r: 0.12, y1: 26.4 };

/** Flat facets of a K-gon, corners at theta = 0 (mod 2 pi / K), relative to the polygon's mean radius over angle. */
export function facetFactor(th: number, K: number): number {
    let phi = (K * th) % (2 * Math.PI);
    if (phi >= Math.PI) phi -= 2 * Math.PI;
    if (phi < -Math.PI) phi += 2 * Math.PI;
    const a = Math.PI / K, mean = (K / Math.PI) * Math.log(1 / Math.cos(a) + Math.tan(a));
    return 1 / Math.cos((Math.PI - Math.abs(phi)) / K) / mean;
}

/** The true (noise-free) radius of the dome's own surface at (y, theta), ribs (or flat facets of a `facets`-gon) included. */
export function domeR(y: number, th: number, ribs: boolean, facets = 0): number {
    const t = Math.min(1, Math.max(0, (y - DOME.y0) / DOME.H));
    const base = DOME.R0 * Math.sqrt(Math.max(0, 1 - t * t));
    const rib = ribs ? RIBS.ampRel * Math.pow(Math.max(0, Math.cos(RIBS.K * th)), RIBS.sharp) : 0;
    return base * (1 + rib) * (facets ? facetFactor(th, facets) : 1);
}

/**
 * A meridian (r, y) list revolved into triangles with radius r * (1 + mod(theta, y)), every vertex pushed radially by
 * `noise(x, y, z)`. Returns flat positions and indices.
 */
function revolve(meridian: Array<[number, number, boolean]>, seg: number, mod: (th: number, y: number, onDome: boolean) => number, noise: (x: number, y: number, z: number) => number, out: { p: number[]; i: number[] }): void {
    const base = out.p.length / 3;
    for (const [r, y, onDome] of meridian) for (let a = 0; a < seg; a++) {
        const th = -Math.PI + (2 * Math.PI * a) / seg;
        const rr = r * (1 + mod(th, y, onDome));
        const x = AXIS.x + rr * Math.cos(th), z = AXIS.z + rr * Math.sin(th);
        const n = rr > 0.05 ? noise(x, y, z) : 0;
        out.p.push(x + n * Math.cos(th), y, z + n * Math.sin(th));
    }
    for (let j = 0; j + 1 < meridian.length; j++) for (let a = 0; a < seg; a++) {
        const a1 = (a + 1) % seg;
        const v00 = base + j * seg + a, v01 = base + j * seg + a1, v10 = base + (j + 1) * seg + a, v11 = base + (j + 1) * seg + a1;
        out.i.push(v00, v01, v11, v00, v11, v10);
    }
}

function box(x0: number, z0: number, x1: number, z1: number, y0: number, y1: number, out: { p: number[]; i: number[] }, step = 1): void {
    // a closed box gridded at `step` (so it rasterises like a scan), walls and top
    const quad = (o: number[], u: number[], v: number[], nu: number, nv: number) => {
        const b = out.p.length / 3;
        for (let j = 0; j <= nv; j++) for (let i = 0; i <= nu; i++) out.p.push(o[0] + u[0] * i / nu + v[0] * j / nv, o[1] + u[1] * i / nu + v[1] * j / nv, o[2] + u[2] * i / nu + v[2] * j / nv);
        for (let j = 0; j < nv; j++) for (let i = 0; i < nu; i++) { const a = b + j * (nu + 1) + i; out.i.push(a, a + 1, a + nu + 2, a, a + nu + 2, a + nu + 1); }
    };
    const nx = Math.ceil((x1 - x0) / step), nz = Math.ceil((z1 - z0) / step), ny = Math.ceil((y1 - y0) / step);
    quad([x0, y1, z0], [x1 - x0, 0, 0], [0, 0, z1 - z0], nx, nz);
    quad([x0, y0, z0], [x1 - x0, 0, 0], [0, y1 - y0, 0], nx, ny);
    quad([x0, y0, z1], [x1 - x0, 0, 0], [0, y1 - y0, 0], nx, ny);
    quad([x0, y0, z0], [0, 0, z1 - z0], [0, y1 - y0, 0], nz, ny);
    quad([x1, y0, z0], [0, 0, z1 - z0], [0, y1 - y0, 0], nz, ny);
}

/** The synthetic scan: roof block, ribbed dome on a drum with a ring and a lantern, a plain box beside it. */
export function syntheticScan(opts: { ribs: boolean; lantern: boolean; seed: number; facets?: number; mast?: boolean }): { positions: Float32Array; indices: Uint32Array; noiseRms: number } {
    const R = rng(opts.seed);
    // smooth dents: 10 Gaussian blobs of 0.25-0.5 m over 0.8-1.4 m (seven pushing in, three out: a coarse scan's lumps),
    // about a sixth of the surface, plus 6 cm per-vertex noise
    const blobs = Array.from({ length: 10 }, (_, k) => {
        const th = R() * 2 * Math.PI, y = DRUM.y0 + R() * (DOME.y0 + DOME.H * 0.8 - DRUM.y0);
        return { x: AXIS.x + 6 * Math.cos(th), y, z: AXIS.z + 6 * Math.sin(th), a: (k < 7 ? -1 : 1) * (0.25 + 0.25 * R()), s: 0.8 + 0.6 * R() };
    });
    const gauss = () => { let u = 0; for (let k = 0; k < 6; k++) u += R(); return (u - 3) / Math.sqrt(0.5); };
    let ss = 0, n = 0;
    const noise = (x: number, y: number, z: number) => {
        let d = 0;
        for (const b of blobs) d += b.a * Math.exp(-((x - b.x) ** 2 + (y - b.y) ** 2 + (z - b.z) ** 2) / (2 * b.s * b.s));
        d += 0.06 * gauss();
        ss += d * d; n++;
        return d;
    };
    const out = { p: [] as number[], i: [] as number[] };
    // the roof block the dome stands on, and a plain box building beside it (a summit that is not round)
    box(AXIS.x - 16, AXIS.z - 16, AXIS.x + 16, AXIS.z + 16, 0, ROOF_Y, out);
    box(AXIS.x + 26, AXIS.z - 8, AXIS.x + 40, AXIS.z + 4, 0, 19, out);
    const mer: Array<[number, number, boolean]> = [];
    for (let y = DRUM.y0; y <= DRUM.y1 + 1e-9; y += 0.5) mer.push([DRUM.r, y, false]);
    mer.push([RING.r, RING.y0, false]);
    for (let y = RING.y0 + 0.3; y <= RING.y1 + 1e-9; y += 0.3) mer.push([RING.r, y, false]);
    mer.push([DOME.R0, DOME.y0, true]);
    const topT = opts.lantern ? 0.97 : 1;
    for (let k = 1; k <= 40; k++) {
        const phi = (Math.PI / 2) * (k / 40) * topT;
        const t = Math.sin(phi);
        mer.push([DOME.R0 * Math.cos(phi), DOME.y0 + t * DOME.H, true]);
    }
    revolve(mer, 240, (th, y, onDome) => onDome ? domeR(y, th, opts.ribs, opts.facets ?? 0) / Math.max(1e-6, domeR(y, th, false)) - 1 : 0, noise, out);
    if (opts.lantern) {
        const lm: Array<[number, number, boolean]> = [];
        for (let y = LANTERN.y0; y <= LANTERN.y1 + 1e-9; y += 0.3) lm.push([LANTERN.r, y, false]);
        for (let k = 1; k <= 12; k++) { const phi = (Math.PI / 2) * (k / 12); lm.push([LANTERN.r * Math.cos(phi), LANTERN.y1 + Math.sin(phi) * LANTERN.capH, false]); }
        revolve(lm, 64, () => 0, (x, y, z) => 0.04 * gauss() + 0 * (x + y + z), out);
    }
    if (opts.mast) {
        // a thin pole standing on the lantern's cap: the scan's thin spike (few, coarse triangles)
        const mm: Array<[number, number, boolean]> = [];
        for (let y = LANTERN.y1 + LANTERN.capH - 0.3; y <= MAST.y1 + 1e-9; y += 0.4) mm.push([MAST.r, y, false]);
        mm.push([0, MAST.y1 + 0.05, false]);
        revolve(mm, 8, () => 0, () => 0.02 * gauss(), out);
    }
    return { positions: Float32Array.from(out.p), indices: Uint32Array.from(out.i), noiseRms: Math.sqrt(ss / Math.max(1, n)) };
}

