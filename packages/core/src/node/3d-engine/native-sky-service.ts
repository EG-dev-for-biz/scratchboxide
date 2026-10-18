/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { NativeCppCompilerService } from './native-compiler-service';
import { compileNativeCached, defaultNativeFlags } from './native-build-cache';

const execFileAsync = promisify(execFile);

export interface AtmosphereParameters {
    observerAltitudeMeters?: number;
    airDensity?: number;
    dustDensity?: number;
    ozoneDensity?: number;
    sunAngularDiameterDeg?: number;
    sunIntensity?: number;
}

export interface PhysicalSkyOptions {
    sunDirection: [number, number, number];
    params?: AtmosphereParameters;
    width?: number;
    height?: number;
    azimuthResolution?: number;
    elevationResolution?: number;
}

export interface PhysicalSkyResult {
    success: boolean;
    width: number;
    height: number;
    rgbFloats: Float32Array;
    sunIrradiance: [number, number, number];
    skyIrradianceHorizontal: [number, number, number];
    hazeExtinction: [number, number, number];
    sunDirection: [number, number, number];
    compilationTimeMs?: number;
    executionTimeMs?: number;
    error?: string;
}

/** The sky runner: one binary for every sky (parameters come on the command line), built once through the native build cache. */
const SKY_RUNNER_SOURCE = `
#include <cstdlib>
#include <iostream>
#include <fstream>
#include <vector>
#include <cmath>
#include <algorithm>
#include "scratchbox_sky.hpp"

using namespace scratchbox;

// argv: out sunX sunY sunZ observerAltitude airDensity dustDensity ozoneDensity sunAngularDiameterDeg sunIntensity
//       azimuthResolution elevationResolution width height (floats are decimal text, parsed like a C++ literal)
int main(int argc, char** argv) {
    if (argc < 15) return 1;
    const char* outPath = argv[1];
    auto f = [&](int i) { return std::strtof(argv[i], nullptr); };
    auto n = [&](int i) { return std::atoi(argv[i]); };

    math::Vec3 sunDir(f(2), f(3), f(4));
    sky::AtmosphereParams params;
    params.observerAltitudeMeters = f(5);
    params.airDensity = f(6);
    params.dustDensity = f(7);
    params.ozoneDensity = f(8);
    params.sunAngularDiameterDeg = f(9);
    params.sunIntensity = f(10);

    sky::PhysicalSky sky(sunDir, params, n(11), n(12));

    int width = n(13);
    int height = n(14);
    std::vector<float> rgbData(static_cast<size_t>(width) * height * 3, 0.0f);

    const float kPi = 3.14159265358979323846f;
    const float kTwoPi = 6.28318530717958647692f;

    for (int y = 0; y < height; ++y) {
        float v = (static_cast<float>(y) + 0.5f) / static_cast<float>(height);
        float elevation = (0.5f - v) * kPi; // +pi/2 (zenith) to -pi/2 (nadir)
        float cosElev = std::cos(elevation);
        float sinElev = std::sin(elevation);

        for (int x = 0; x < width; ++x) {
            float u = (static_cast<float>(x) + 0.5f) / static_cast<float>(width);
            float azimuth = u * kTwoPi; // 0 to 2*pi

            math::Vec3 dir(
                cosElev * std::sin(azimuth),
                sinElev,
                cosElev * std::cos(azimuth)
            );
            dir = dir.normalized();

            math::Vec3 color(0.0f, 0.0f, 0.0f);
            if (dir.y >= 0.0f) {
                math::Vec3 skyRad = sky.skyRadiance(dir);
                math::Vec3 sunRad = sky.sunDiscRadiance(dir);
                color = skyRad + sunRad;
            } else {
                // Below horizon: diffuse ground bounce blending with horizon haze
                math::Vec3 horizon = sky.horizonRadiance(dir);
                math::Vec3 ground = sky.skyIrradianceHorizontal() * 0.15f;
                float blend = std::clamp(1.0f + dir.y * 3.0f, 0.0f, 1.0f);
                color = horizon * blend + ground * (1.0f - blend);
            }

            size_t idx = (static_cast<size_t>(y) * width + x) * 3;
            rgbData[idx + 0] = std::max(0.0f, color.x);
            rgbData[idx + 1] = std::max(0.0f, color.y);
            rgbData[idx + 2] = std::max(0.0f, color.z);
        }
    }

    std::ofstream out(outPath, std::ios::binary);
    if (!out) return 2;

    math::Vec3 sIrr = sky.sunIrradiance();
    math::Vec3 hIrr = sky.skyIrradianceHorizontal();
    math::Vec3 haze = sky.hazeExtinction();
    math::Vec3 sDir = sky.sunDirection();

    // Write header: 4 bytes width, 4 bytes height, then 12 floats (sIrr, hIrr, haze, sDir)
    uint32_t w = width, h = height;
    out.write(reinterpret_cast<const char*>(&w), sizeof(uint32_t));
    out.write(reinterpret_cast<const char*>(&h), sizeof(uint32_t));

    float headerMetrics[12] = {
        sIrr.x, sIrr.y, sIrr.z,
        hIrr.x, hIrr.y, hIrr.z,
        haze.x, haze.y, haze.z,
        sDir.x, sDir.y, sDir.z
    };
    out.write(reinterpret_cast<const char*>(headerMetrics), sizeof(headerMetrics));

    // Write raw float pixel data
    out.write(reinterpret_cast<const char*>(rgbData.data()), rgbData.size() * sizeof(float));
    out.close();

    std::cout << "SUCCESS" << std::endl;
    return 0;
}
`;

/**
 * Service orchestrating native C++20 physical atmospheric single-scattering
 * (Rayleigh/Mie/Ozone) sky generation from scratchbox_sky.hpp.
 *
 * Replaces client-side Three.js GLSL heuristic sky shaders with physically-grounded
 * precomputed equirectangular radiance environments.
 */
export class NativeSkyService {
    private compiler: NativeCppCompilerService;

    constructor(customIncludePath?: string) {
        this.compiler = new NativeCppCompilerService(customIncludePath);
    }

    /**
     * Generates a physical equirectangular sky map (Float32Array RGB) and radiometric
     * atmospheric values using the native C++20 scratchbox_sky.hpp PhysicalSky engine.
     */
    public async generatePhysicalSkyEquirectangular(
        options: PhysicalSkyOptions
    ): Promise<PhysicalSkyResult> {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sbox_sky_'));
        const outBinPath = path.join(tmpDir, 'sky_output.bin');

        const width = options.width || 256;
        const height = options.height || 128;
        const azimRes = options.azimuthResolution || Math.min(width, 128);
        const elevRes = options.elevationResolution || Math.min(height, 64);

        const sunX = options.sunDirection[0];
        const sunY = options.sunDirection[1];
        const sunZ = options.sunDirection[2];

        const obsAlt = options.params?.observerAltitudeMeters ?? 0.0;
        const airDen = options.params?.airDensity ?? 1.0;
        const dustDen = options.params?.dustDensity ?? 1.0;
        const ozoneDen = options.params?.ozoneDensity ?? 1.0;
        const sunAng = options.params?.sunAngularDiameterDeg ?? 0.545;
        const sunInt = options.params?.sunIntensity ?? 1.0;

        try {
            const compiled = await compileNativeCached({
                sourceCode: SKY_RUNNER_SOURCE,
                includeDirs: [this.compiler.getSdkIncludePath()],
                flags: defaultNativeFlags(),
                name: 'sky_runner'
            });
            const compilationTimeMs = compiled.cacheHit ? 0 : compiled.compileMs;

            // Plain decimal text, parsed with strtof: the same float a C++ literal of that text would be.
            const num = (v: number) => String(v);
            const args = [outBinPath, num(sunX), num(sunY), num(sunZ), num(obsAlt), num(airDen), num(dustDen), num(ozoneDen),
                num(sunAng), num(sunInt), String(Math.trunc(azimRes)), String(Math.trunc(elevRes)), String(Math.trunc(width)), String(Math.trunc(height))];
            const execStart = Date.now();
            await execFileAsync(compiled.binaryPath, args, { cwd: tmpDir });
            const executionTimeMs = Date.now() - execStart;

            if (!fs.existsSync(outBinPath)) {
                throw new Error('Native C++ sky runner failed to create output binary file');
            }

            const binBuffer = fs.readFileSync(outBinPath);
            let offset = 0;
            const resW = binBuffer.readUInt32LE(offset); offset += 4;
            const resH = binBuffer.readUInt32LE(offset); offset += 4;

            const sunIrradiance: [number, number, number] = [
                binBuffer.readFloatLE(offset),
                binBuffer.readFloatLE(offset + 4),
                binBuffer.readFloatLE(offset + 8)
            ];
            offset += 12;

            const skyIrradianceHorizontal: [number, number, number] = [
                binBuffer.readFloatLE(offset),
                binBuffer.readFloatLE(offset + 4),
                binBuffer.readFloatLE(offset + 8)
            ];
            offset += 12;

            const hazeExtinction: [number, number, number] = [
                binBuffer.readFloatLE(offset),
                binBuffer.readFloatLE(offset + 4),
                binBuffer.readFloatLE(offset + 8)
            ];
            offset += 12;

            const sunDirection: [number, number, number] = [
                binBuffer.readFloatLE(offset),
                binBuffer.readFloatLE(offset + 4),
                binBuffer.readFloatLE(offset + 8)
            ];
            offset += 12;

            const floatCount = resW * resH * 3;
            const rgbFloats = new Float32Array(
                binBuffer.buffer.slice(binBuffer.byteOffset + offset, binBuffer.byteOffset + offset + floatCount * 4)
            );

            return {
                success: true,
                width: resW,
                height: resH,
                rgbFloats,
                sunIrradiance,
                skyIrradianceHorizontal,
                hazeExtinction,
                sunDirection,
                compilationTimeMs,
                executionTimeMs
            };
        } catch (err: any) {
            return {
                success: false,
                width,
                height,
                rgbFloats: new Float32Array(0),
                sunIrradiance: [0, 0, 0],
                skyIrradianceHorizontal: [0, 0, 0],
                hazeExtinction: [0, 0, 0],
                sunDirection: options.sunDirection,
                error: err?.message || String(err)
            };
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    }
}
