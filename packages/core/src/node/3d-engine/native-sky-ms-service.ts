/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The scene weather's sky (scene-weather.ts applySceneWeather, skyModel 'multiple-scattering'): García Liñán's
 * multiple-scattering clear sky, vendored from Blender (third_party/blender-sky, MIT) and sampled by
 * scratchbox_sky_ms.hpp into the viewer's sky-view table (physical-sky.ts's layout and units), so the dome draws it
 * exactly as it draws the TypeScript spectral sky. One runner binary for every sky, built once through the native
 * build cache; a sky takes a few milliseconds and is kept in memory by its inputs.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { NativeCppCompilerService } from './native-compiler-service';
import { compileNativeCached, defaultNativeFlags } from './native-build-cache';
import { angstromBeta } from '../../browser/generative-canvas/services/atmosphere/sky-photometry';

const execFileAsync = promisify(execFile);

export interface SkyMsOptions {
    sunElevationDeg: number;
    /** Preetham turbidity (>= 1), the viewer's haze control (scene-weather.ts: 2 + 8 x haze). */
    turbidity: number;
    airDensity?: number;
    ozoneDensity?: number;
    observerAltitudeMeters?: number;
    azimuthResolution?: number;
    elevationResolution?: number;
}

export interface SkyMsTable {
    /** RGB radiance, row-major [elevationRow][azimuthCol]; col 0 toward the sun; row 0 at the horizon (physical-sky.ts). */
    data: Float32Array;
    azimuthResolution: number;
    elevationResolution: number;
    horizontalIrradiance: [number, number, number];
    sunTransmittance: [number, number, number];
    /** The aerosol optical depth at 550 nm the turbidity gave, and the model's density multiplier for it. */
    aerosolOpticalDepth550: number;
    aerosolDensity: number;
    model: 'multiple-scattering';
}

/** Aerosol optical depth at 550 nm for a Preetham turbidity: the TypeScript sky's own conversion (physical-sky.ts medium). */
export function aerosolOpticalDepthForTurbidity(turbidity: number): number {
    if (!Number.isFinite(turbidity) || turbidity < 1) throw new RangeError(`sky: turbidity ${turbidity} is outside the physical range (1 = pure Rayleigh)`);
    return Math.max(0, angstromBeta(turbidity)) * Math.pow(0.55, -1.3);
}

const RUNNER_SOURCE = `
#include <cstdint>
#include <cstdlib>
#include <fstream>
#include <iostream>
#include "scratchbox_sky_ms.hpp"

// argv: out sunElevationDeg aod550 airDensity ozoneDensity observerAltitudeM azimuthRes elevationRes
int main(int argc, char** argv) {
    if (argc < 9) return 1;
    auto f = [&](int i) { return std::strtof(argv[i], nullptr); };
    scratchbox::sky_ms::SkyMsParams p;
    p.sunElevationDeg = f(2);
    p.aerosolOpticalDepth550 = f(3);
    p.airDensity = f(4);
    p.ozoneDensity = f(5);
    p.observerAltitudeMeters = f(6);
    p.azimuthResolution = std::atoi(argv[7]);
    p.elevationResolution = std::atoi(argv[8]);
    const scratchbox::sky_ms::SkyMsTable t = scratchbox::sky_ms::computeSkyViewTable(p);
    std::ofstream out(argv[1], std::ios::binary);
    if (!out) return 2;
    const uint32_t dims[2] = {static_cast<uint32_t>(t.azimuthResolution), static_cast<uint32_t>(t.elevationResolution)};
    out.write(reinterpret_cast<const char*>(dims), sizeof(dims));
    const float head[7] = {t.horizontalIrradiance[0], t.horizontalIrradiance[1], t.horizontalIrradiance[2],
                           t.sunTransmittance[0], t.sunTransmittance[1], t.sunTransmittance[2], t.aerosolDensity};
    out.write(reinterpret_cast<const char*>(head), sizeof(head));
    out.write(reinterpret_cast<const char*>(t.rgb.data()), static_cast<std::streamsize>(t.rgb.size() * sizeof(float)));
    if (!out) return 3;
    std::cout << "OK" << std::endl;
    return 0;
}
`;

const MAX_CACHED = 128;

export class NativeSkyMsService {
    private readonly compiler: NativeCppCompilerService;
    private readonly cache = new Map<string, Promise<SkyMsTable>>();

    constructor(customIncludePath?: string) {
        this.compiler = new NativeCppCompilerService(customIncludePath);
    }

    /** Builds the runner into the native build cache (the server's warm-up), so the first weather sky does not wait on clang. */
    async warm(): Promise<void> {
        await this.skyViewTable({ sunElevationDeg: 20, turbidity: 3.6, azimuthResolution: 8, elevationResolution: 8 });
    }

    /** The sky-view table for one sun and haze. Throws (with the compiler's or runner's message) when the native sky fails. */
    skyViewTable(opts: SkyMsOptions): Promise<SkyMsTable> {
        if (!Number.isFinite(opts.sunElevationDeg) || opts.sunElevationDeg < -90 || opts.sunElevationDeg > 90) {
            return Promise.reject(new RangeError(`sky: sun elevation ${opts.sunElevationDeg} is outside -90..90 degrees`));
        }
        let aod: number;
        try { aod = aerosolOpticalDepthForTurbidity(opts.turbidity); } catch (err) { return Promise.reject(err); }
        const W = Math.max(4, Math.min(512, Math.trunc(opts.azimuthResolution ?? 64)));
        const H = Math.max(4, Math.min(512, Math.trunc(opts.elevationResolution ?? 48)));
        const args = [opts.sunElevationDeg, aod, opts.airDensity ?? 1, opts.ozoneDensity ?? 1, opts.observerAltitudeMeters ?? 1].map(v => String(v));
        const key = [...args, W, H].join('|');
        let hit = this.cache.get(key);
        if (!hit) {
            hit = this.run(args, W, H, aod);
            hit.catch(() => this.cache.delete(key));
            if (this.cache.size >= MAX_CACHED) this.cache.delete(this.cache.keys().next().value as string);
            this.cache.set(key, hit);
        }
        return hit;
    }

    private async run(args: string[], W: number, H: number, aod: number): Promise<SkyMsTable> {
        const compiled = await compileNativeCached({
            sourceCode: RUNNER_SOURCE,
            includeDirs: [this.compiler.getSdkIncludePath()],
            flags: defaultNativeFlags(),
            name: 'sky_ms_runner'
        });
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sbox_sky_ms_'));
        try {
            const outPath = path.join(dir, 'sky.bin');
            await execFileAsync(compiled.binaryPath, [outPath, ...args, String(W), String(H)], { timeout: 60_000 });
            const buf = fs.readFileSync(outPath);
            const w = buf.readUInt32LE(0), h = buf.readUInt32LE(4);
            const head = Array.from({ length: 7 }, (_, i) => buf.readFloatLE(8 + 4 * i));
            const offset = 8 + 7 * 4;
            if (w !== W || h !== H || buf.length !== offset + w * h * 3 * 4) throw new Error(`sky: the native sky wrote a ${w}x${h} table of ${buf.length} bytes, expected ${W}x${H}`);
            const data = new Float32Array(w * h * 3);
            for (let i = 0; i < data.length; i++) data[i] = buf.readFloatLE(offset + 4 * i);
            return {
                data,
                azimuthResolution: w,
                elevationResolution: h,
                horizontalIrradiance: [head[0], head[1], head[2]],
                sunTransmittance: [head[3], head[4], head[5]],
                aerosolOpticalDepth550: aod,
                aerosolDensity: head[6],
                model: 'multiple-scattering'
            };
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    }
}

let shared: NativeSkyMsService | undefined;
/** The server's one instance (its in-memory skies shared by the route and the warm-up). */
export function getNativeSkyMsService(): NativeSkyMsService {
    return (shared ??= new NativeSkyMsService());
}
