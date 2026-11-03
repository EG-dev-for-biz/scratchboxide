/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The precomputed atmosphere (scratchbox_atmosphere_lut.hpp behind scripts/atmosphere_lut.cpp, run through
 * atmosphere-lut-service.ts):
 *
 *   1. Bruneton's own function tests (atmosphere/reference/functions_test.cc), ported case for case to
 *      test/native/atmosphere_lut_functions_test.cpp: every check passes at his tolerance;
 *   2. our Earth tables against the tables three-geospatial ships (same medium, three wavelengths, binary16), table
 *      by table and channel by channel, and the sky radiance both give through the same runtime functions;
 *   3. the sky at sun elevations 90, 30, 5 and -3 degrees from five models: the native single-scattering sky
 *      (scratchbox_sky.hpp), our tables and three-geospatial's for the same three-wavelength medium, the viewer's
 *      spectral sky (physical-sky.ts, Hillaire's multiple-scattering approximation) and our tables for the viewer's
 *      own spectral medium; rendered into a labelled sheet in docs/screenshots/sky_bruneton_<date>/.
 *
 * The precompute timing is printed once. The three-geospatial fixture is fetched by
 * scripts/fetch_three_geospatial_atmosphere.mjs; without it the comparisons with it skip with that reason.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { compileNativeCached, defaultNativeFlags } from '../src/node/3d-engine/native-build-cache';
import {
    precomputeAtmosphereLut, evaluateAtmosphereLut, hillaireEarthMedium, viewerSkyMedium, radianceBatch, srgbBatches,
    AtmosphereLutError, type AtmosphereLutResult, type SkyQuery, type SkyQueryResult
} from '../src/node/3d-engine/atmosphere-lut-service';
import { buildPhysicalSkyLut } from '../src/browser/generative-canvas/services/atmosphere/physical-sky';
import { cieColorMatching } from '../src/browser/generative-canvas/services/atmosphere/spectral-sun';
import { encodePng } from './helpers/synthetic-scan-glb';
import { saveHtmlScreenshot, htmlScreenshotChrome } from './helpers/html-screenshot';
import { requireFiles, withReason } from './helpers/requirements';

const REPO = path.resolve(__dirname, '../../..');
const INCLUDE = path.join(REPO, 'packages/core/src/native/3d-engine/include');
const WORK = path.join(REPO, 'test-results', 'atmosphere_lut');
const DATE = '2026-11-03';
const SHEET_DIR = path.join(REPO, 'docs', 'screenshots', `sky_bruneton_${DATE}`);
const TG_REF = 'eac103980f20c0956f2d3215833e73514be08462';
const TG_DIR = process.env.SCRATCHBOX_THREE_GEOSPATIAL_ATMOSPHERE_DIR ?? path.join(REPO, '.model-cache', 'three-geospatial-atmosphere', TG_REF);
const TABLES = ['transmittance', 'scattering', 'single_mie_scattering', 'higher_order_scattering', 'irradiance'] as const;
const tgFixture = requireFiles(TABLES.map(t => path.join(TG_DIR, `${t}.bin`)), 'run `node scripts/fetch_three_geospatial_atmosphere.mjs` (three-geospatial MIT tables, 34 MB, into .model-cache/)');

const SUN_ELEVATIONS = [90, 30, 5, -3];
const TURBIDITY = 2;
const VIEWER_ALBEDO = 0.2;
const IMG = 128;
type V3 = [number, number, number];
const lum = (c: ArrayLike<number>) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];

// ---------------------------------------------------------------------------------------------------------------------
// 1. Bruneton's function tests

const FUNCTION_TESTS = [
    'DistanceToTopAtmosphereBoundary', 'RayIntersectsGround', 'GetProfileDensity', 'ComputeOpticalLengthToTopAtmosphereBoundary',
    'ComputeTransmittanceToTopAtmosphereBoundary', 'GetTextureCoordFromUnitRange', 'GetTransmittanceTextureUvFromRMu', 'GetRMuFromTransmittanceTextureUv',
    'GetTransmittanceToTopAtmosphereBoundary', 'ComputeAndGetTransmittance', 'ComputeSingleScatteringIntegrand', 'DistanceToNearestAtmosphereBoundary',
    'ComputeSingleScattering', 'PhaseFunctions', 'GetScatteringTextureUvwzFromRMuMuSNu', 'GetRMuMuSNuFromScatteringTextureUvwz',
    'ComputeAndGetSingleScattering', 'ComputeScatteringDensity', 'ComputeMultipleScattering', 'ComputeAndGetScatteringDensity',
    'ComputeAndGetMultipleScattering', 'ComputeIndirectIrradiance', 'GetIrradianceTextureUvFromRMuS', 'GetRMuSFromIrradianceTextureUv', 'GetComputeAndGetIrradiance'
];

interface CheckRecord { test: string; check: string; expected: number; actual: number; tolerance: number; pass: boolean }

describe('Bruneton functions_test.cc, ported', () => {
    let records: CheckRecord[] = [];
    beforeAll(async () => {
        const built = await compileNativeCached({
            sourcePath: path.join(REPO, 'packages/core/test/native/atmosphere_lut_functions_test.cpp'), includeDirs: [INCLUDE],
            flags: defaultNativeFlags(['-pthread']), name: 'atmosphere_lut_functions_test', timeoutMs: 300_000
        });
        records = JSON.parse(execFileSync(built.binaryPath, { encoding: 'utf8', timeout: 120_000 }));
    }, 400_000);

    it('runs every case of the original', () => {
        expect(new Set(records.map(r => r.test))).toEqual(new Set(FUNCTION_TESTS));
        expect(records.length).toBeGreaterThanOrEqual(120);
    });

    for (const name of FUNCTION_TESTS) {
        it(name, () => {
            const mine = records.filter(r => r.test === name);
            expect(mine.length).toBeGreaterThan(0);
            for (const r of mine) expect(r, `${r.check}: expected ${r.expected}, got ${r.actual} (tolerance ${r.tolerance})`).toMatchObject({ pass: true });
        });
    }
});

// ---------------------------------------------------------------------------------------------------------------------
// Shared: decode tables, query grids, the native sky.

function halfToFloat(h: number): number {
    const s = h & 0x8000 ? -1 : 1, e = (h >> 10) & 31, m = h & 1023;
    return e === 0 ? s * m * 2 ** -24 : e === 31 ? (m ? NaN : s * Infinity) : s * (1 + m / 1024) * 2 ** (e - 15);
}
function readHalf(file: string): Float32Array {
    const buf = fs.readFileSync(file);
    const u = new Uint16Array(buf.buffer, buf.byteOffset, buf.length / 2);
    const out = new Float32Array(u.length);
    for (let i = 0; i < u.length; i++) out[i] = halfToFloat(u[i]);
    return out;
}

interface ChannelError { channel: number; peak: number; maxAbs: number; meanRel: number; p99Rel: number; maxRel: number }
/** Relative error per texel, against max(|reference|, 1e-3 x the channel's peak) so near-zero texels count absolutely. */
function compareChannel(ours: Float32Array, ref: Float32Array, channel: number): ChannelError {
    let peak = 0;
    for (let i = channel; i < ref.length; i += 4) peak = Math.max(peak, Math.abs(ref[i]));
    const rel: number[] = [];
    let maxAbs = 0;
    for (let i = channel; i < ref.length; i += 4) {
        const d = Math.abs(ours[i] - ref[i]);
        maxAbs = Math.max(maxAbs, d);
        rel.push(d / Math.max(Math.abs(ref[i]), 1e-3 * peak, 1e-30));
    }
    rel.sort((a, b) => a - b);
    return { channel, peak, maxAbs, meanRel: rel.reduce((s, v) => s + v, 0) / rel.length, p99Rel: rel[Math.floor(rel.length * 0.99)], maxRel: rel[rel.length - 1] };
}

/** An upper-hemisphere fisheye (equidistant, the sun to the right) in a +z-up frame, plus the solar vertical. */
function skyQueries(sunElevationDeg: number): { queries: SkyQuery[]; pixels: number; vertical: number[] } {
    const e = (sunElevationDeg * Math.PI) / 180;
    const sun: V3 = [Math.cos(e), 0, Math.sin(e)];
    const queries: SkyQuery[] = [];
    for (let y = 0; y < IMG; y++) {
        for (let x = 0; x < IMG; x++) {
            const u = ((x + 0.5) / IMG) * 2 - 1, v = 1 - ((y + 0.5) / IMG) * 2;
            const rho = Math.hypot(u, v);
            const theta = Math.min(rho, 1) * (Math.PI / 2), phi = Math.atan2(v, u);
            queries.push({ altitudeM: 1, view: [Math.sin(theta) * Math.cos(phi), Math.sin(theta) * Math.sin(phi), Math.max(Math.cos(theta), 1e-4)], sun });
        }
    }
    // The solar vertical: from the horizon under the sun, over the zenith, to the opposite horizon (elevation 0..180).
    const vertical: number[] = [];
    for (let a = 0; a <= 180; a += 2) {
        const el = Math.min(a, 180 - a) * (Math.PI / 180), toward = a <= 90 ? 1 : -1;
        vertical.push(a);
        queries.push({ altitudeM: 1, view: [toward * Math.cos(el), 0, Math.max(Math.sin(el), 1e-4)], sun });
    }
    return { queries, pixels: IMG * IMG, vertical };
}

const NATIVE_SKY_SOURCE = `
#include "scratchbox_sky.hpp"
#include <cstdio>
#include <cmath>
using scratchbox::math::Vec3;
int main() {
    double el; int n;
    while (std::scanf("%lf %d", &el, &n) == 2) {
        double e = el * 3.14159265358979323846 / 180.0;
        scratchbox::sky::PhysicalSky sky(Vec3(static_cast<float>(std::cos(e)), static_cast<float>(std::sin(e)), 0.0f));
        Vec3 eh = sky.skyIrradianceHorizontal();
        std::printf("%.9g %.9g %.9g\\n", eh.x, eh.y, eh.z);
        for (int i = 0; i < n; ++i) {
            double x, y, z;
            if (std::scanf("%lf %lf %lf", &x, &y, &z) != 3) return 1;
            Vec3 L = sky.skyRadiance(Vec3(static_cast<float>(x), static_cast<float>(y), static_cast<float>(z)));
            std::printf("%.9g %.9g %.9g\\n", L.x, L.y, L.z);
        }
    }
    return 0;
}
`;

/** The native sky (radiance per unit top-of-atmosphere irradiance per channel); +y up there, so z and y swap. */
async function nativeSky(elevations: number[], perElevation: SkyQuery[][]): Promise<{ radiance: V3[]; skyIrradiance: V3 }[]> {
    const built = await compileNativeCached({ sourceCode: NATIVE_SKY_SOURCE, includeDirs: [INCLUDE], flags: defaultNativeFlags(), name: 'native_sky_probe', timeoutMs: 300_000 });
    const input = elevations.map((el, k) => `${el} ${perElevation[k].length}\n` + perElevation[k].map(q => `${q.view[0]} ${q.view[2]} ${q.view[1]}`).join('\n')).join('\n') + '\n';
    const lines = execFileSync(built.binaryPath, { input, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, timeout: 300_000 }).trim().split('\n');
    let at = 0;
    return perElevation.map(qs => {
        const row = () => lines[at++].split(' ').map(Number) as V3;
        const skyIrradiance = row();
        return { skyIrradiance, radiance: qs.map(row) };
    });
}

/** The viewer's sky-view table, sampled the way its dome samples it (relative azimuth x sqrt-spaced elevation). */
function viewerSky(sunElevationDeg: number, queries: SkyQuery[]): { radiance: V3[]; skyIrradiance: V3 } {
    const lut = buildPhysicalSkyLut({ sunElevationDeg, turbidity: TURBIDITY, groundAlbedo: VIEWER_ALBEDO });
    const W = lut.azimuthResolution, H = lut.elevationResolution;
    const at = (i: number, j: number, c: number) => lut.data[(i * W + j) * 3 + c];
    const radiance = queries.map(q => {
        const elDeg = (Math.asin(Math.min(1, q.view[2])) * 180) / Math.PI;
        const az = Math.abs(Math.atan2(q.view[1], q.view[0]));
        const fi = Math.min(H - 1, Math.max(0, Math.sqrt(Math.max(0, elDeg) / 90) * H - 0.5));
        const fj = Math.min(W - 1, Math.max(0, (az / Math.PI) * W - 0.5));
        const i0 = Math.floor(fi), j0 = Math.floor(fj), i1 = Math.min(H - 1, i0 + 1), j1 = Math.min(W - 1, j0 + 1);
        const a = fi - i0, b = fj - j0;
        return [0, 1, 2].map(c => (at(i0, j0, c) * (1 - b) + at(i0, j1, c) * b) * (1 - a) + (at(i1, j0, c) * (1 - b) + at(i1, j1, c) * b) * a) as V3;
    });
    return { radiance, skyIrradiance: lut.horizontalIrradiance };
}

// ---------------------------------------------------------------------------------------------------------------------
// 2 and 3: the tables against three-geospatial's, and the skies.

interface Model { key: string; label: string; detail: string; medium: string; perElevation: { radiance: V3[]; skyIrradiance: V3 }[] }

describe('Bruneton tables for Earth', () => {
    const rgbMedium = hillaireEarthMedium();
    const rgbPrecompute = { batches: [radianceBatch()], scatteringOrders: 4 };
    const specMedium = viewerSkyMedium({ turbidity: TURBIDITY, groundAlbedo: VIEWER_ALBEDO });
    const specPrecompute = { batches: srgbBatches(specMedium.wavelengthsNm, 30), scatteringOrders: 4 };
    const grids = SUN_ELEVATIONS.map(skyQueries);
    const allQueries = grids.flatMap(g => g.queries);
    const split = <T,>(rows: T[]): T[][] => { const out: T[][] = []; let at = 0; for (const g of grids) { out.push(rows.slice(at, at + g.queries.length)); at += g.queries.length; } return out; };
    let rgb: AtmosphereLutResult;
    let spec: AtmosphereLutResult;

    beforeAll(async () => {
        fs.rmSync(WORK, { recursive: true, force: true });
        rgb = await precomputeAtmosphereLut({ medium: rgbMedium, precompute: rgbPrecompute, outDir: path.join(WORK, 'earth_rgb'), format: 'float16', queries: allQueries });
        spec = await precomputeAtmosphereLut({ medium: specMedium, precompute: specPrecompute, outDir: path.join(WORK, 'earth_viewer_spectral'), format: 'float32', queries: allQueries });
        console.log(`[atmosphere_lut] precompute, ${rgb.threads} threads, 4 orders: 3 wavelengths ${(rgb.ms.total / 1000).toFixed(1)} s ` +
            `(scattering density ${(rgb.ms.scatteringDensity / 1000).toFixed(1)} s); ${specMedium.wavelengthsNm.length} wavelengths in ${spec.batches} batches ${(spec.ms.total / 1000).toFixed(1)} s`);
    }, 1_800_000);

    it('refuses an atmosphere that is not physical, before anything runs', async () => {
        await expect(precomputeAtmosphereLut({ medium: { ...rgbMedium, topRadiusM: rgbMedium.bottomRadiusM }, precompute: rgbPrecompute, outDir: path.join(WORK, 'bad') }))
            .rejects.toMatchObject({ code: 'bad_request' });
        await expect(precomputeAtmosphereLut({ medium: { ...rgbMedium, mieScattering: [1e-6] }, precompute: rgbPrecompute, outDir: path.join(WORK, 'bad') }))
            .rejects.toBeInstanceOf(AtmosphereLutError);
        await expect(precomputeAtmosphereLut({ medium: rgbMedium, precompute: { batches: [] }, outDir: path.join(WORK, 'bad') })).rejects.toMatchObject({ code: 'bad_request' });
    });

    it('writes every table in Bruneton\'s layout with its description', () => {
        const sizes = { transmittance: 256 * 64, scattering: 256 * 128 * 32, single_mie_scattering: 256 * 128 * 32, higher_order_scattering: 256 * 128 * 32, irradiance: 64 * 16 };
        for (const [t, texels] of Object.entries(sizes)) {
            expect(fs.statSync(path.join(rgb.outDir, `${t}.bin`)).size).toBe(texels * 4 * 2);
            expect(fs.statSync(path.join(spec.outDir, `${t}.bin`)).size).toBe(texels * 4 * 4);
        }
        const desc = JSON.parse(fs.readFileSync(rgb.files.description, 'utf8'));
        expect(desc.layout.scatteringNuMuSMuR).toEqual([8, 32, 128, 32]);
        expect(desc.atmosphere.wavelengths).toEqual([440, 550, 680]);
        expect(spec.batches).toBe(4);
        // transmittance falls to the horizon; the scattering tables hold light, not zeros
        const t = readHalf(rgb.files.transmittance);
        expect(t[0]).toBeGreaterThan(0.9);
        expect(t[(0 * 256 + 255) * 4 + 2]).toBeLessThan(0.05);
        expect(readHalf(rgb.files.higherOrderScattering).some(v => v > 0.1)).toBe(true);
    });

    describe.skipIf(!tgFixture.ok)(withReason('against the tables three-geospatial ships', tgFixture), () => {
        const report: Record<string, ChannelError[]> = {};
        beforeAll(() => {
            for (const t of TABLES) {
                const ours = readHalf(path.join(rgb.outDir, `${t}.bin`)), ref = readHalf(path.join(TG_DIR, `${t}.bin`));
                // Alpha holds data only in scattering (single Mie red); elsewhere it is a constant (three-geospatial's
                // irradiance alpha is its blend count).
                report[t] = (t === 'scattering' ? [0, 1, 2, 3] : [0, 1, 2]).map(c => compareChannel(ours, ref, c));
            }
            fs.mkdirSync(WORK, { recursive: true });
            fs.writeFileSync(path.join(WORK, 'three_geospatial_table_errors.json'), JSON.stringify(report, null, 2));
            console.log('[atmosphere_lut] vs three-geospatial (relative error per channel, mean / p99 / max):\n' + Object.entries(report)
                .map(([t, cs]) => `  ${t}: ` + cs.map(c => `${(100 * c.meanRel).toFixed(3)}% / ${(100 * c.p99Rel).toFixed(2)}% / ${(100 * c.maxRel).toFixed(1)}%`).join('  ')).join('\n'));
        });

        // Tolerance: mean relative error 0.3 %, 99th percentile 2.5 %, worst texel 15 % (binary16 storage, and the GPU's
        // float32 arithmetic at the table edges: straight up and down, and horizon transmittance near 1e-3).
        for (const t of TABLES) {
            it(`${t} matches within mean 0.3 %, p99 2.5 %, max 15 %`, () => {
                for (const c of report[t]) {
                    expect(c.meanRel, `${t} ch${c.channel} mean`).toBeLessThan(0.003);
                    expect(c.p99Rel, `${t} ch${c.channel} p99`).toBeLessThan(0.025);
                    expect(c.maxRel, `${t} ch${c.channel} max`).toBeLessThan(0.15);
                }
            });
        }

        // The ground slice of the 4D table (R row 0, r = bottom radius) is the one place the two disagree, by about 1 %
        // (every slice above it agrees within 0.1 %): likely three-geospatial's GPU float32, where r^2 - R^2 cancels at
        // ground level, against our double precision. A camera at 1 km reads slices 3-4 and must agree within 0.3 %.
        it('gives the same sky through the same runtime functions (mean 1.5 % at the ground, 0.3 % at 1 km)', async () => {
            const meanRel = (ours: SkyQueryResult[], theirs: SkyQueryResult[]) => {
                let sum = 0, n = 0;
                theirs.forEach((r, i) => { const a = lum(ours[i].radiance), b = lum(r.radiance); if (b > 0) { sum += Math.abs(a - b) / b; n++; } });
                return sum / n;
            };
            const ground = meanRel(rgb.queries!, await evaluateAtmosphereLut({ medium: rgbMedium, precompute: rgbPrecompute, tablesDir: TG_DIR, format: 'float16', queries: allQueries }));
            const high = allQueries.map(q => ({ ...q, altitudeM: 1000 }));
            const highRel = meanRel(
                await evaluateAtmosphereLut({ medium: rgbMedium, precompute: rgbPrecompute, tablesDir: rgb.outDir, format: 'float16', queries: high }),
                await evaluateAtmosphereLut({ medium: rgbMedium, precompute: rgbPrecompute, tablesDir: TG_DIR, format: 'float16', queries: high })
            );
            console.log(`[atmosphere_lut] sky luminance vs three-geospatial: mean ${(100 * ground).toFixed(2)} % at 1 m, ${(100 * highRel).toFixed(2)} % at 1 km`);
            fs.writeFileSync(path.join(WORK, 'three_geospatial_sky_errors.json'), JSON.stringify({ meanRelAt1m: ground, meanRelAt1km: highRel }, null, 2));
            expect(ground).toBeLessThan(0.015);
            expect(highRel).toBeLessThan(0.003);
        });
    });

    it('renders the four sun elevations against the native and viewer skies', async () => {
        const solar = rgbMedium.solarIrradiance.slice().reverse() as V3; // red, green, blue = 680, 550, 440 nm
        const perChannel = (r: SkyQueryResult[]) => r.map(q => q.radiance.map((v, c) => v / solar[c]) as V3);
        // The viewer's normalisation: per unit of top-of-atmosphere solar luminance over the same bins.
        const ySun = specMedium.wavelengthsNm.reduce((s, l, i) => s + specMedium.solarIrradiance[i] * cieColorMatching(l)[1] * 30, 0);
        const native = await nativeSky(SUN_ELEVATIONS, grids.map(g => g.queries));
        const rgbRows = split(rgb.queries!), specRows = split(spec.queries!);
        const tgRows = tgFixture.ok ? split(await evaluateAtmosphereLut({ medium: rgbMedium, precompute: rgbPrecompute, tablesDir: TG_DIR, format: 'float16', queries: allQueries })) : undefined;
        const models: Model[] = [
            { key: 'native', label: 'Native sky (today)', detail: 'scratchbox_sky.hpp: single scattering, RGB', medium: 'A', perElevation: native },
            {
                key: 'ours_rgb', label: 'Bruneton, ours', detail: 'this PR: 4 orders, 680/550/440 nm', medium: 'A',
                perElevation: rgbRows.map(rows => ({ radiance: perChannel(rows), skyIrradiance: rows[0].skyIrradiance.map((v, c) => v / solar[c]) as V3 }))
            },
            ...(tgRows ? [{
                key: 'tg', label: 'three-geospatial', detail: 'its shipped tables, same runtime', medium: 'A',
                perElevation: tgRows.map(rows => ({ radiance: perChannel(rows), skyIrradiance: rows[0].skyIrradiance.map((v, c) => v / solar[c]) as V3 }))
            }] : []),
            { key: 'viewer', label: 'Viewer sky (today)', detail: 'physical-sky.ts: Hillaire 2020 MS approx., 12 bins', medium: 'B', perElevation: SUN_ELEVATIONS.map((el, k) => viewerSky(el, grids[k].queries)) },
            {
                key: 'ours_spec', label: 'Bruneton, ours, spectral', detail: 'this PR: 12 bins in 4 batches to sRGB, 4 orders', medium: 'B',
                perElevation: specRows.map(rows => ({ radiance: rows.map(q => q.radiance.map(v => v / ySun) as V3), skyIrradiance: rows[0].skyIrradiance.map(v => v / ySun) as V3 }))
            }
        ];

        // Every model gives a finite, non-negative sky; multiple scattering only adds light to the same medium.
        for (const m of models) for (const pe of m.perElevation) expect(pe.radiance.every(c => c.every(v => Number.isFinite(v) && v >= -1e-6))).toBe(true);
        const meanY = (m: Model, k: number) => { let s = 0; for (let i = 0; i < IMG * IMG; i++) s += lum(m.perElevation[k].radiance[i]); return s / (IMG * IMG); };
        const byKey = Object.fromEntries(models.map(m => [m.key, m]));
        for (let k = 0; k < SUN_ELEVATIONS.length; k++) expect(meanY(byKey.ours_rgb, k)).toBeGreaterThan(meanY(byKey.native, k));
        // a sun 3 degrees below the horizon still lights the sky (twilight), and less than a sun 5 degrees above it
        expect(meanY(byKey.ours_spec, 3)).toBeGreaterThan(0);
        expect(meanY(byKey.ours_spec, 3)).toBeLessThan(meanY(byKey.ours_spec, 2) * 0.5);

        // ---- the sheet
        fs.mkdirSync(SHEET_DIR, { recursive: true });
        const tile = (m: Model, k: number, exposure: number) => {
            const rgbBytes = new Uint8Array(IMG * IMG * 3);
            for (let i = 0; i < IMG * IMG; i++) {
                const x = i % IMG, y = Math.floor(i / IMG);
                const inside = Math.hypot(((x + 0.5) / IMG) * 2 - 1, 1 - ((y + 0.5) / IMG) * 2) <= 1;
                for (let c = 0; c < 3; c++) {
                    const v = inside ? 1 - Math.exp(-Math.max(0, m.perElevation[k].radiance[i][c]) * exposure) : 0.09;
                    rgbBytes[i * 3 + c] = Math.round(255 * Math.min(1, v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(v, 1 / 2.4) - 0.055));
                }
            }
            const file = `${m.key}_sun${SUN_ELEVATIONS[k] < 0 ? 'm' : ''}${Math.abs(SUN_ELEVATIONS[k])}.png`;
            fs.writeFileSync(path.join(SHEET_DIR, file), encodePng(IMG, IMG, rgbBytes));
            return `data:image/png;base64,${fs.readFileSync(path.join(SHEET_DIR, file)).toString('base64')}`;
        };
        const fmt = (v: number) => (v === 0 ? '0' : Math.abs(v) >= 0.01 ? v.toFixed(3) : v.toExponential(1));
        const colors: Record<string, string> = { native: '#9ca3af', ours_rgb: '#f59e0b', tg: '#22d3ee', viewer: '#a78bfa', ours_spec: '#f43f5e' };
        const chart = (k: number) => {
            const g = grids[k], W = 300, H = 120, pad = 26;
            const series = models.map(m => m.perElevation[k].radiance.slice(g.pixels).map(lum));
            const all = series.flat().filter(v => v > 0);
            const lo = Math.log10(Math.min(...all)), hi = Math.log10(Math.max(...all));
            const X = (a: number) => pad + (a / 180) * (W - pad - 4), Y = (v: number) => H - 14 - ((Math.log10(Math.max(v, 10 ** lo)) - lo) / Math.max(hi - lo, 1e-6)) * (H - 24);
            const lines = series.map((s, i) => `<polyline fill="none" stroke="${colors[models[i].key]}" stroke-width="1.6" points="${s.map((v, j) => `${X(g.vertical[j]).toFixed(1)},${Y(v).toFixed(1)}`).join(' ')}"/>`).join('');
            return `<svg width="${W}" height="${H}" style="background:#111827;border-radius:4px">${lines}
                <line x1="${X(90)}" y1="6" x2="${X(90)}" y2="${H - 14}" stroke="#374151" stroke-dasharray="2,3"/>
                <text x="${pad}" y="${H - 3}" font-size="9" fill="#9ca3af">horizon, sun side</text><text x="${X(90) - 14}" y="${H - 3}" font-size="9" fill="#9ca3af">zenith</text>
                <text x="${W - 76}" y="${H - 3}" font-size="9" fill="#9ca3af">opposite horizon</text>
                <text x="2" y="12" font-size="9" fill="#9ca3af">${(10 ** hi).toExponential(0)}</text><text x="2" y="${H - 16}" font-size="9" fill="#9ca3af">${(10 ** lo).toExponential(0)}</text></svg>`;
        };
        const rowsHtml = SUN_ELEVATIONS.map((el, k) => {
            // One exposure per row and medium (A: Hillaire 3-wavelength; B: the viewer's spectral medium), from its Bruneton tile.
            const expo = (med: string) => 0.6 / Math.max(1e-12, meanY(med === 'A' ? byKey.ours_rgb : byKey.ours_spec, k));
            const cells = models.map(m => {
                const pe = m.perElevation[k], R = pe.radiance;
                const zen = lum(R[(IMG / 2) * IMG + IMG / 2]);
                const ref = m.medium === 'A' ? byKey.ours_rgb : byKey.ours_spec;
                const ratio = meanY(m, k) / Math.max(1e-12, meanY(ref, k));
                return `<td><img src="${tile(m, k, expo(m.medium))}" width="${IMG}" height="${IMG}"/><div class="m">zenith Y ${fmt(zen)} · mean ${fmt(meanY(m, k))}<br/>
                    sky E<sub>h</sub> ${fmt(lum(pe.skyIrradiance))} · ${m.key === ref.key ? 'reference' : `${(100 * ratio).toFixed(0)}% of Bruneton`}</div></td>`;
            }).join('');
            return `<tr><th>sun ${el}&deg;</th>${cells}<td>${chart(k)}</td></tr>`;
        }).join('');
        const tgErr = fs.existsSync(path.join(WORK, 'three_geospatial_table_errors.json')) ? JSON.parse(fs.readFileSync(path.join(WORK, 'three_geospatial_table_errors.json'), 'utf8')) as Record<string, ChannelError[]> : undefined;
        const errHtml = tgErr ? Object.entries(tgErr).map(([t, cs]) => `<tr><td>${t}</td><td>${cs.map(c => (100 * c.meanRel).toFixed(3)).join(' / ')}</td><td>${cs.map(c => (100 * c.p99Rel).toFixed(2)).join(' / ')}</td><td>${cs.map(c => (100 * c.maxRel).toFixed(1)).join(' / ')}</td></tr>`).join('') : '<tr><td colspan="4">three-geospatial fixture missing: not compared</td></tr>';
        const html = `<style>
            .wrap { padding: 18px 22px; background:#0b0f17; height:100%; box-sizing:border-box }
            h1 { font-size: 19px; margin: 0 0 4px } h2 { font-size: 13px; margin: 14px 0 6px; color:#cbd5e1 }
            p { margin: 2px 0; font-size: 11.5px; color: #9ca3af }
            table.g { border-collapse: collapse } table.g th { font-size: 12px; text-align:left; padding: 4px 8px 4px 0; color:#e5e7eb; vertical-align: top }
            table.g td { vertical-align: top; padding: 3px 6px 8px 0 } .m { font-size: 9.5px; color:#9ca3af; line-height: 1.3; margin-top: 2px; width: ${IMG + 8}px }
            .h { font-size: 11px; color:#e5e7eb; width:${IMG + 8}px } .h small { display:block; color:#9ca3af; font-size: 9.5px }
            .tag { display:inline-block; font-size:9px; padding:0 4px; border-radius:3px; margin-left:3px; background:#1f2937 }
            table.e { border-collapse: collapse; font-size: 10.5px; color:#d1d5db } table.e td, table.e th { padding: 2px 10px 2px 0; text-align:left }
        </style><div class="wrap">
        <h1>Bruneton precomputed atmosphere (native C++) vs the skies Scratchbox draws today</h1>
        <p>Upper-hemisphere fisheye per sun elevation, sun to the right; radiance per unit of top-of-atmosphere solar illuminance, linear sRGB, one exposure per row and medium.
        Medium A: Hillaire 2020 Earth at 680/550/440 nm (the native sky's and three-geospatial's constants, Mie g 0.8). Medium B: the viewer's spectral medium (turbidity ${TURBIDITY}, Mie g 0.7, ground albedo ${VIEWER_ALBEDO}, 5778 K sun, 12 bins).
        Chart: log luminance along the solar vertical, coloured as the column swatches.</p>
        <table class="g"><tr><th></th>${models.map(m => `<th><div class="h"><span style="color:${colors[m.key]}">&#9632;</span> ${m.label}<span class="tag">${m.medium}</span><small>${m.detail}</small></div></th>`).join('')}<th><div class="h">Solar vertical</div></th></tr>${rowsHtml}</table>
        <h2>Our Earth tables vs three-geospatial's shipped tables (medium A, binary16), relative error per channel R / G / B (/ alpha = single Mie R), %</h2>
        <table class="e"><tr><th>table</th><th>mean</th><th>p99</th><th>max</th></tr>${errHtml}</table>
        <p>${fs.existsSync(path.join(WORK, 'three_geospatial_sky_errors.json')) ? (() => { const e = JSON.parse(fs.readFileSync(path.join(WORK, 'three_geospatial_sky_errors.json'), 'utf8')); return `Sky luminance through the same runtime functions, mean relative difference: ${(100 * e.meanRelAt1m).toFixed(2)} % for a camera at 1 m (the ground slice: our double vs their GPU float32), ${(100 * e.meanRelAt1km).toFixed(2)} % at 1 km. `; })() : ''}Tolerance: mean &lt; 0.3 %, p99 &lt; 2.5 %, max &lt; 15 % per channel. Precompute on ${rgb.threads} threads, 4 orders: 3 wavelengths ${(rgb.ms.total / 1000).toFixed(1)} s;
        12 wavelengths in 4 batches ${(spec.ms.total / 1000).toFixed(1)} s. Generated by packages/core/test/atmosphere-lut.test.ts, ${DATE}.</p>
        </div>`;
        const width = 150 + models.length * (IMG + 14) + 320;
        if (htmlScreenshotChrome.ok) {
            const shot = await saveHtmlScreenshot('sky_bruneton_comparison', html, { width, height: 1060, background: '#0b0f17' });
            fs.copyFileSync(shot.path, path.join(SHEET_DIR, 'sky_bruneton_comparison.png'));
        }
        fs.writeFileSync(path.join(SHEET_DIR, 'sky_bruneton_comparison.html'), `<!doctype html><meta charset="utf-8"><body style="margin:0;background:#0b0f17;font-family:sans-serif;color:#e4e4e7">${html}</body>`);
        const summary = Object.fromEntries(models.map(m => [m.key, SUN_ELEVATIONS.map((el, k) => ({ sunElevationDeg: el, meanY: meanY(m, k), zenithY: lum(m.perElevation[k].radiance[(IMG / 2) * IMG + IMG / 2]), skyIrradianceY: lum(m.perElevation[k].skyIrradiance) }))]));
        fs.writeFileSync(path.join(SHEET_DIR, 'summary.json'), JSON.stringify({ timingsMs: { rgb: rgb.ms, spectral: spec.ms, threads: rgb.threads }, models: summary }, null, 2));
    }, 600_000);
});
