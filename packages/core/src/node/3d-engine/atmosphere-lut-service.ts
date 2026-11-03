/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The precomputed atmosphere: Bruneton's multiple-scattering tables (scratchbox_atmosphere_lut.hpp) behind their CLI
 * driver (scripts/atmosphere_lut.cpp), built through the native build cache.
 *
 * An atmosphere is continuous physical quantities only: radii, two-layer density profiles, per-wavelength scattering
 * and absorption spectra, the Mie asymmetry, the solar spectrum and the ground albedo. The precompute runs in batches
 * of three wavelengths, each with the matrix taking its radiances to the output channels: one identity batch stores
 * radiance at three wavelengths (as three-geospatial ships its tables), several colour-matching batches integrate a
 * spectrum into linear sRGB (as the viewer's spectral sky does).
 *
 * Tables are written in Bruneton's layout (RGBA, float32 or binary16): transmittance 256 x 64, scattering, single Mie
 * and higher-order scattering 256 x 128 x 32 (NU 8 x MU_S 32 by MU 128 by R 32), irradiance 64 x 16; atmosphere.json
 * beside them describes the medium and the timings. The same driver loads tables (ours or any in that layout) and
 * evaluates sky radiance, transmittance and irradiance for a list of view and sun directions.
 */

import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { compileNativeCached, defaultNativeFlags, NativeBuildError, placeCachedBinary } from './native-build-cache';
import { findTileRefineRepoRoot } from './tile-refine-service';
import { cieColorMatching, extraterrestrialSolarIrradiance, ozoneAbsorption, xyzToLinearSrgb } from '../../browser/generative-canvas/services/atmosphere/spectral-sun';
import { angstromBeta } from '../../browser/generative-canvas/services/atmosphere/sky-photometry';

export type AtmosphereLutErrorCode = 'bad_request' | 'build_failed' | 'run_failed' | 'invalid_output';

export class AtmosphereLutError extends Error {
    constructor(public readonly code: AtmosphereLutErrorCode, message: string) {
        super(message);
        this.name = 'AtmosphereLutError';
    }
}

/** density(h) = expTerm * exp(expScale * h) + linearTerm * h + constantTerm, clamped to [0, 1]; h in metres. */
export interface DensityProfileLayer { width: number; expTerm: number; expScale: number; linearTerm: number; constantTerm: number }
/** Bottom layer (up to its width), then the top layer to the top of the atmosphere. */
export type DensityProfile = [DensityProfileLayer, DensityProfileLayer];

/** A planet's atmosphere, every spectrum sampled at `wavelengthsNm` (increasing); coefficients in 1/m at density 1. */
export interface AtmosphereMedium {
    wavelengthsNm: number[];
    /** Top-of-atmosphere solar spectral irradiance (any unit; the tables carry it). */
    solarIrradiance: number[];
    rayleighScattering: number[];
    mieScattering: number[];
    mieExtinction: number[];
    absorptionExtinction: number[];
    groundAlbedo: number[];
    sunAngularRadiusRad: number;
    bottomRadiusM: number;
    topRadiusM: number;
    rayleighDensity: DensityProfile;
    mieDensity: DensityProfile;
    absorptionDensity: DensityProfile;
    miePhaseG: number;
    /** Cosine of the largest sun zenith angle the tables resolve. */
    muSMin: number;
}

/** Three precomputed wavelengths and the row-major 3 x 3 matrix from their radiances to the output channels. */
export interface WavelengthBatch { lambdasNm: [number, number, number]; toOutput: number[] }

export interface AtmosphereLutPrecompute {
    batches: WavelengthBatch[];
    /** The transmittance table's wavelengths (default 680, 550, 440 nm, Bruneton's R, G, B). */
    transmittanceLambdasNm?: [number, number, number];
    /** Orders of scattering summed (default 4; 1 is single scattering). */
    scatteringOrders?: number;
    /** Worker threads (default: all cores). */
    threads?: number;
}

export type AtmosphereLutFormat = 'float32' | 'float16';

/** Query: camera altitude above the ground, view and sun directions in a frame with +z up at the camera. */
export interface SkyQuery { altitudeM: number; view: [number, number, number]; sun: [number, number, number] }
export interface SkyQueryResult {
    radiance: [number, number, number];
    transmittance: [number, number, number];
    /** Direct sun irradiance on a level surface at the camera. */
    sunIrradiance: [number, number, number];
    /** Sky irradiance on a level surface at the camera. */
    skyIrradiance: [number, number, number];
}

export interface AtmosphereLutTimings {
    transmittance: number; directIrradiance: number; singleScattering: number; scatteringDensity: number;
    indirectIrradiance: number; multipleScattering: number; total: number;
}

export interface AtmosphereLutResult {
    outDir: string;
    format: AtmosphereLutFormat;
    files: { transmittance: string; scattering: string; singleMieScattering: string; higherOrderScattering: string; irradiance: string; description: string };
    batches: number;
    scatteringOrders: number;
    threads: number;
    ms: AtmosphereLutTimings;
    /** Wall time of the driver run, ms (the precompute plus writing the tables). */
    wallMs: number;
    queries?: SkyQueryResult[];
    binaryPath: string;
}

const CLI_SOURCE = path.join('scripts', 'atmosphere_lut.cpp');
const INCLUDE_DIR = path.join('packages', 'core', 'src', 'native', '3d-engine', 'include');
const BINARY = path.join('build', '3d-native', 'atmosphere_lut');
let building: Promise<string> | undefined;

/** Builds build/3d-native/atmosphere_lut through the native build cache when its sources changed. */
export function ensureAtmosphereLutBinary(repoRoot = findTileRefineRepoRoot()): Promise<string> {
    if (process.env.SCRATCHBOX_ATMOSPHERE_LUT_BIN) return Promise.resolve(process.env.SCRATCHBOX_ATMOSPHERE_LUT_BIN);
    if (building) return building;
    building = (async () => {
        const bin = path.join(repoRoot, BINARY);
        try {
            const built = await compileNativeCached({ sourcePath: path.join(repoRoot, CLI_SOURCE), includeDirs: [path.join(repoRoot, INCLUDE_DIR)], flags: defaultNativeFlags(['-pthread']), name: 'atmosphere_lut', timeoutMs: 300_000 });
            placeCachedBinary(built.binaryPath, bin);
            return bin;
        } catch (err) {
            throw new AtmosphereLutError('build_failed', `could not build atmosphere_lut: ${err instanceof NativeBuildError ? err.compilerOutput.slice(-1500) : String(err)}`);
        }
    })().finally(() => { building = undefined; });
    return building;
}

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

function checkMedium(m: AtmosphereMedium): void {
    const n = m.wavelengthsNm?.length ?? 0;
    if (n === 0) throw new AtmosphereLutError('bad_request', 'wavelengthsNm is empty');
    for (let i = 0; i < n; i++) {
        if (!finite(m.wavelengthsNm[i]) || (i > 0 && !(m.wavelengthsNm[i] > m.wavelengthsNm[i - 1]))) throw new AtmosphereLutError('bad_request', 'wavelengthsNm must be finite and increasing');
    }
    for (const key of ['solarIrradiance', 'rayleighScattering', 'mieScattering', 'mieExtinction', 'absorptionExtinction', 'groundAlbedo'] as const) {
        const v = m[key];
        if (!Array.isArray(v) || v.length !== n || !v.every(x => finite(x) && x >= 0)) throw new AtmosphereLutError('bad_request', `${key} needs ${n} finite non-negative values, one per wavelength`);
    }
    for (const key of ['rayleighDensity', 'mieDensity', 'absorptionDensity'] as const) {
        const p = m[key];
        if (!Array.isArray(p) || p.length !== 2 || !p.every(l => [l.width, l.expTerm, l.expScale, l.linearTerm, l.constantTerm].every(finite))) {
            throw new AtmosphereLutError('bad_request', `${key} needs two layers of finite width, expTerm, expScale, linearTerm, constantTerm`);
        }
    }
    if (!finite(m.bottomRadiusM) || !finite(m.topRadiusM) || !(m.bottomRadiusM > 0 && m.topRadiusM > m.bottomRadiusM)) throw new AtmosphereLutError('bad_request', 'need 0 < bottomRadiusM < topRadiusM');
    if (!finite(m.miePhaseG) || Math.abs(m.miePhaseG) >= 1) throw new AtmosphereLutError('bad_request', 'miePhaseG must be in (-1, 1)');
    if (!finite(m.muSMin) || m.muSMin < -1 || m.muSMin >= 1) throw new AtmosphereLutError('bad_request', 'muSMin must be in [-1, 1)');
    if (!finite(m.sunAngularRadiusRad) || m.sunAngularRadiusRad <= 0 || m.sunAngularRadiusRad >= 0.1) throw new AtmosphereLutError('bad_request', 'sunAngularRadiusRad must be in (0, 0.1)');
}

function checkPrecompute(p: AtmosphereLutPrecompute): void {
    if (!Array.isArray(p.batches) || p.batches.length === 0) throw new AtmosphereLutError('bad_request', 'batches is empty');
    for (const b of p.batches) {
        if (!Array.isArray(b.lambdasNm) || b.lambdasNm.length !== 3 || !b.lambdasNm.every(finite)) throw new AtmosphereLutError('bad_request', 'each batch needs three wavelengths');
        if (!Array.isArray(b.toOutput) || b.toOutput.length !== 9 || !b.toOutput.every(finite)) throw new AtmosphereLutError('bad_request', 'each batch needs a 3 x 3 toOutput matrix (9 numbers, row-major)');
    }
    const orders = p.scatteringOrders ?? 4;
    if (!Number.isInteger(orders) || orders < 1 || orders > 16) throw new AtmosphereLutError('bad_request', 'scatteringOrders must be an integer in 1..16');
    if (p.threads !== undefined && (!Number.isInteger(p.threads) || p.threads < 0 || p.threads > 1024)) throw new AtmosphereLutError('bad_request', 'threads must be an integer in 0..1024');
}

const num = (v: number) => (Object.is(v, -0) ? '0' : String(v));
const profileLine = (p: DensityProfile) => p.flatMap(l => [l.width, l.expTerm, l.expScale, l.linearTerm, l.constantTerm]).map(num).join(' ');

/** The driver's params file. */
export function atmosphereParamsText(m: AtmosphereMedium, p: AtmosphereLutPrecompute): string {
    const lines = [
        `wavelengths ${m.wavelengthsNm.map(num).join(' ')}`,
        `solar_irradiance ${m.solarIrradiance.map(num).join(' ')}`,
        `rayleigh_scattering ${m.rayleighScattering.map(num).join(' ')}`,
        `mie_scattering ${m.mieScattering.map(num).join(' ')}`,
        `mie_extinction ${m.mieExtinction.map(num).join(' ')}`,
        `absorption_extinction ${m.absorptionExtinction.map(num).join(' ')}`,
        `ground_albedo ${m.groundAlbedo.map(num).join(' ')}`,
        `sun_angular_radius ${num(m.sunAngularRadiusRad)}`,
        `bottom_radius ${num(m.bottomRadiusM)}`,
        `top_radius ${num(m.topRadiusM)}`,
        `mie_phase_function_g ${num(m.miePhaseG)}`,
        `mu_s_min ${num(m.muSMin)}`,
        `rayleigh_density ${profileLine(m.rayleighDensity)}`,
        `mie_density ${profileLine(m.mieDensity)}`,
        `absorption_density ${profileLine(m.absorptionDensity)}`,
        `transmittance_lambdas ${(p.transmittanceLambdasNm ?? [680, 550, 440]).map(num).join(' ')}`,
        `scattering_orders ${p.scatteringOrders ?? 4}`,
        ...(p.threads !== undefined ? [`threads ${p.threads}`] : []),
        ...p.batches.map(b => `batch ${[...b.lambdasNm, ...b.toOutput].map(num).join(' ')}`)
    ];
    return lines.join('\n') + '\n';
}

function queriesText(queries: SkyQuery[]): string {
    for (const q of queries) {
        if (!finite(q.altitudeM) || q.altitudeM < 0 || ![...q.view, ...q.sun].every(finite)) throw new AtmosphereLutError('bad_request', 'each query needs a finite altitudeM >= 0, view and sun');
    }
    return queries.map(q => [q.altitudeM, ...q.view, ...q.sun].map(num).join(' ')).join('\n') + '\n';
}

function run(bin: string, args: string[], timeoutMs: number): Promise<void> {
    return new Promise((resolve, reject) => {
        execFile(bin, args, { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, windowsHide: true }, (err, _stdout, stderr) => {
            if (err) reject(new AtmosphereLutError('run_failed', `atmosphere_lut failed: ${String(stderr || err.message).trim().slice(-1500)}`));
            else resolve();
        });
    });
}

function readQueryResults(file: string, expected: number): SkyQueryResult[] {
    let raw: any;
    try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (err) { throw new AtmosphereLutError('invalid_output', `atmosphere_lut wrote no query results: ${(err as Error).message}`); }
    if (!raw?.ok || !Array.isArray(raw.results) || raw.results.length !== expected) throw new AtmosphereLutError('invalid_output', `atmosphere_lut wrote ${raw?.results?.length ?? 0} query results, not ${expected}`);
    return raw.results;
}

const TABLE_FILES = { transmittance: 'transmittance.bin', scattering: 'scattering.bin', singleMieScattering: 'single_mie_scattering.bin', higherOrderScattering: 'higher_order_scattering.bin', irradiance: 'irradiance.bin', description: 'atmosphere.json' } as const;

export interface AtmosphereLutRequest {
    medium: AtmosphereMedium;
    precompute: AtmosphereLutPrecompute;
    outDir: string;
    format?: AtmosphereLutFormat;
    queries?: SkyQuery[];
    /** Longest the run may take, not counting a first-use build (default 30 min). */
    timeoutMs?: number;
    repoRoot?: string;
}

/** Precomputes the tables of one atmosphere into `outDir`, and evaluates `queries` from them. */
export async function precomputeAtmosphereLut(req: AtmosphereLutRequest): Promise<AtmosphereLutResult> {
    checkMedium(req.medium);
    checkPrecompute(req.precompute);
    const format = req.format ?? 'float32';
    if (format !== 'float32' && format !== 'float16') throw new AtmosphereLutError('bad_request', 'format is float32 or float16');
    const bin = await ensureAtmosphereLutBinary(req.repoRoot);
    fs.mkdirSync(req.outDir, { recursive: true });
    const tag = `${process.pid}_${Date.now()}`;
    const paramsPath = path.join(req.outDir, `.atmosphere_${tag}.txt`);
    const queriesPath = path.join(req.outDir, `.queries_${tag}.txt`);
    const resultsPath = path.join(req.outDir, `.results_${tag}.json`);
    fs.writeFileSync(paramsPath, atmosphereParamsText(req.medium, req.precompute));
    const args = ['--params', paramsPath, '--out', req.outDir, '--format', format];
    if (req.queries?.length) { fs.writeFileSync(queriesPath, queriesText(req.queries)); args.push('--queries', queriesPath, '--results', resultsPath); }
    try {
        const t0 = Date.now();
        await run(bin, args, req.timeoutMs ?? 30 * 60_000);
        const wallMs = Date.now() - t0;
        const files = Object.fromEntries(Object.entries(TABLE_FILES).map(([k, f]) => [k, path.join(req.outDir, f)])) as AtmosphereLutResult['files'];
        for (const f of Object.values(files)) if (!fs.existsSync(f)) throw new AtmosphereLutError('invalid_output', `atmosphere_lut exited 0 but did not write ${f}`);
        let desc: any;
        try { desc = JSON.parse(fs.readFileSync(files.description, 'utf8')); } catch (err) { throw new AtmosphereLutError('invalid_output', `atmosphere.json is not JSON: ${(err as Error).message}`); }
        if (!desc?.ok || !desc.ms || !finite(desc.ms.total)) throw new AtmosphereLutError('invalid_output', 'atmosphere.json lacks ok or its timings');
        return {
            outDir: req.outDir, format, files, batches: desc.batches, scatteringOrders: desc.scatteringOrders, threads: desc.threads, ms: desc.ms as AtmosphereLutTimings, wallMs,
            ...(req.queries?.length ? { queries: readQueryResults(resultsPath, req.queries.length) } : {}),
            binaryPath: bin
        };
    } finally {
        for (const f of [paramsPath, queriesPath, resultsPath]) fs.rmSync(f, { force: true });
    }
}

export interface AtmosphereLutEvaluateRequest {
    /** The medium the tables were computed for: its radii, Mie g and output-wavelength solar irradiance and coefficients. */
    medium: AtmosphereMedium;
    precompute: AtmosphereLutPrecompute;
    tablesDir: string;
    format: AtmosphereLutFormat;
    queries: SkyQuery[];
    timeoutMs?: number;
    repoRoot?: string;
}

/** Evaluates `queries` from tables already in `tablesDir` (ours, or any in Bruneton's layout and units). */
export async function evaluateAtmosphereLut(req: AtmosphereLutEvaluateRequest): Promise<SkyQueryResult[]> {
    checkMedium(req.medium);
    checkPrecompute(req.precompute);
    if (!fs.existsSync(req.tablesDir)) throw new AtmosphereLutError('bad_request', `tablesDir does not exist (${req.tablesDir})`);
    if (!req.queries.length) return [];
    const bin = await ensureAtmosphereLutBinary(req.repoRoot);
    const dir = fs.mkdtempSync(path.join(path.dirname(req.tablesDir), '.atmosphere_eval_'));
    try {
        const paramsPath = path.join(dir, 'atmosphere.txt'), queriesPath = path.join(dir, 'queries.txt'), resultsPath = path.join(dir, 'results.json');
        fs.writeFileSync(paramsPath, atmosphereParamsText(req.medium, req.precompute));
        fs.writeFileSync(queriesPath, queriesText(req.queries));
        await run(bin, ['--params', paramsPath, '--load', req.tablesDir, '--load-format', req.format, '--queries', queriesPath, '--results', resultsPath], req.timeoutMs ?? 120_000);
        return readQueryResults(resultsPath, req.queries.length);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

// ---------------------------------------------------------------------------------------------------------------------
// Batches and media built from measured constants.

const IDENTITY = [1, 0, 0, 0, 1, 0, 0, 0, 1];

/** One batch storing radiance at three wavelengths (red, green, blue order). */
export function radianceBatch(lambdasNm: [number, number, number] = [680, 550, 440]): WavelengthBatch {
    return { lambdasNm, toOutput: [...IDENTITY] };
}

/**
 * Batches of three across `wavelengthsNm` (bins of width `binWidthNm`), each integrating its radiances against the CIE
 * 1931 observer (the viewer's spectral sky's fit, spectral-sun.ts) into linear sRGB (D65). A count not divisible by
 * three is padded with zero-weight copies of the last wavelength.
 */
export function srgbBatches(wavelengthsNm: number[], binWidthNm: number): WavelengthBatch[] {
    if (!wavelengthsNm.length || !(binWidthNm > 0)) throw new AtmosphereLutError('bad_request', 'srgbBatches needs wavelengths and a positive bin width');
    const batches: WavelengthBatch[] = [];
    for (let i = 0; i < wavelengthsNm.length; i += 3) {
        const lambdas: number[] = [], cols: number[][] = [];
        for (let k = 0; k < 3; k++) {
            const l = wavelengthsNm[Math.min(i + k, wavelengthsNm.length - 1)];
            lambdas.push(l);
            cols.push(i + k < wavelengthsNm.length ? xyzToLinearSrgb(cieColorMatching(l)).map(c => c * binWidthNm) : [0, 0, 0]);
        }
        batches.push({ lambdasNm: lambdas as [number, number, number], toOutput: [0, 1, 2].flatMap(row => cols.map(col => col[row])) });
    }
    return batches;
}

const layer = (width: number, expTerm: number, expScale: number, linearTerm: number, constantTerm: number): DensityProfileLayer => ({ width, expTerm, expScale, linearTerm, constantTerm });
const EMPTY = layer(0, 0, 0, 0, 0);
/** Exponential fall-off with scale height `h` (m). */
export const exponentialProfile = (h: number): DensityProfile => [EMPTY, layer(0, 1, -1 / h, 0, 0)];
/** A tent: 0 at centre ± halfWidth, 1 at the centre (m). */
export const tentProfile = (centre: number, halfWidth: number): DensityProfile => [
    layer(centre, 0, 0, 1 / halfWidth, 1 - centre / halfWidth),
    layer(0, 0, 0, -1 / halfWidth, 1 + centre / halfWidth)
];

/**
 * Earth at 680, 550 and 440 nm with Hillaire's (2020) coefficients: the native sky's constants (scratchbox_sky.hpp), the
 * values three-geospatial ships its tables for (Mie g 0.8, mu_s_min cos 120 degrees, ground albedo 0.1) and Bruneton's
 * demo solar irradiance at those wavelengths.
 */
export function hillaireEarthMedium(overrides: Partial<AtmosphereMedium> = {}): AtmosphereMedium {
    return {
        wavelengthsNm: [440, 550, 680],
        solarIrradiance: [1.91198, 1.8504, 1.474],
        rayleighScattering: [33.1e-6, 13.558e-6, 5.802e-6],
        mieScattering: [3.996e-6, 3.996e-6, 3.996e-6],
        mieExtinction: [4.44e-6, 4.44e-6, 4.44e-6],
        absorptionExtinction: [0.085e-6, 1.881e-6, 0.65e-6],
        groundAlbedo: [0.1, 0.1, 0.1],
        sunAngularRadiusRad: 0.004675,
        bottomRadiusM: 6360e3,
        topRadiusM: 6420e3,
        rayleighDensity: exponentialProfile(8000),
        mieDensity: exponentialProfile(1200),
        absorptionDensity: tentProfile(25000, 15000),
        miePhaseG: 0.8,
        muSMin: -0.5,
        ...overrides
    };
}

export interface ViewerSkyMediumOptions {
    /** Preetham turbidity (>= 1): the aerosol optical depth at 550 nm is beta * 0.55^-1.3. */
    turbidity: number;
    groundAlbedo?: number;
    /** Bin centres (nm); default the viewer's 12 bins, 400-730 nm, 30 nm apart. */
    wavelengthsNm?: number[];
}

/**
 * The medium the viewer's spectral sky integrates (physical-sky.ts): Rayleigh 33.1e-6 at 440 nm scaled by lambda^-4,
 * Angstrom aerosol (alpha 1.3) set by the turbidity with single-scattering albedo 3.996 / 4.440 and g 0.7, the Chappuis
 * ozone fit in the native sky's tent, and the 5778 K solar spectrum at 1 AU (W/m^2/nm). Same constants, so the two skies
 * differ only in how they scatter.
 */
export function viewerSkyMedium(opts: ViewerSkyMediumOptions): AtmosphereMedium {
    if (!finite(opts.turbidity) || opts.turbidity < 1) throw new AtmosphereLutError('bad_request', `turbidity ${opts.turbidity} is outside the physical range (1 = pure Rayleigh)`);
    const wavelengthsNm = opts.wavelengthsNm ?? Array.from({ length: 12 }, (_, i) => 400 + 30 * i);
    const tau550 = Math.max(0, angstromBeta(opts.turbidity)) * Math.pow(0.55, -1.3);
    const mieExtinction = wavelengthsNm.map(l => (tau550 / 1200) * Math.pow(l / 550, -1.3));
    return {
        wavelengthsNm,
        solarIrradiance: wavelengthsNm.map(extraterrestrialSolarIrradiance),
        rayleighScattering: wavelengthsNm.map(l => 33.1e-6 * Math.pow(440 / l, 4)),
        mieScattering: mieExtinction.map(e => e * (3.996 / 4.44)),
        mieExtinction,
        absorptionExtinction: wavelengthsNm.map(ozoneAbsorption),
        groundAlbedo: wavelengthsNm.map(() => opts.groundAlbedo ?? 0.2),
        sunAngularRadiusRad: 0.004675,
        bottomRadiusM: 6360e3,
        topRadiusM: 6420e3,
        rayleighDensity: exponentialProfile(8000),
        mieDensity: exponentialProfile(1200),
        absorptionDensity: tentProfile(25000, 15000),
        miePhaseG: 0.7,
        muSMin: -0.5
    };
}
