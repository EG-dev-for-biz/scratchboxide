/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import { execFile } from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { compileNativeCached, defaultNativeFlags } from '../../3d-engine/native-build-cache';
import { NativeCppCompilerService } from '../../3d-engine/native-compiler-service';
import { AdaptiveMaterialPbrService } from '../../3d-engine/adaptive-material-pbr-service';
import type { ToolContext, ToolDeclaration, ToolHandler, ToolHandlerOutcome } from './types';

/**
 * Spherical-harmonic ambient lighting estimation from a real captured panorama.
 * Decodes the image in TypeScript (no vendored image/JSON library is reachable from a throwaway
 * C++ translation unit), hands the raw float RGB buffer to the native
 * `scratchbox::ibl::SphericalHarmonics9::projectEquirectangular` (scratchbox_ibl.hpp) compiled and
 * run via the same compile-once/execFile pattern as the BVH query tools, and reports both the 9
 * coefficients and sample irradiance values for quick sanity-checking.
 */

const FLAGS = defaultNativeFlags();
const compiler = NativeCppCompilerService.getInstance();

function sdkIncludeDir(): string {
    return compiler.getSdkIncludePath();
}

async function compileAndRun(name: string, source: string, args: string[], timeoutMs = 2 * 60_000): Promise<string> {
    const result = await compileNativeCached({
        sourceCode: source,
        includeDirs: [sdkIncludeDir()],
        flags: FLAGS,
        name
    });
    return new Promise<string>((resolve, reject) => {
        execFile(result.binaryPath, args, { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
            if (err) {
                (err as Error & { stderr?: string }).stderr = stderr;
                reject(err);
            } else {
                resolve(stdout);
            }
        });
    });
}

function lastJsonLine(stdout: string): unknown {
    const lines = stdout.trim().split('\n');
    return JSON.parse(lines[lines.length - 1] || '{}');
}

function tempPath(prefix: string, ext: string): string {
    return path.join(os.tmpdir(), `${prefix}-${process.pid}-${crypto.randomBytes(6).toString('hex')}.${ext}`);
}

export const SH9_LIGHTING_TOOL_DECLARATIONS: ToolDeclaration[] = [
    {
        name: 'lighting_estimate_sh9_from_panorama',
        description:
            'Projects a real equirectangular panorama/HDRI photo into 9 spherical-harmonic coefficients ' +
            '(Ramamoorthi & Hanrahan basis, scratchbox_ibl.hpp SphericalHarmonics9::projectEquirectangular) ' +
            'representing its ambient diffuse lighting — a cheap, physically-grounded way to match a scene\'s ' +
            'ambient light to a real captured environment instead of hand-picking a lighting preset. Also returns ' +
            'the irradiance the environment would produce on a few sample surface normals (up/down/+X/-X/+Z/-Z) ' +
            'so the caller can sanity-check brightness/color without writing its own evaluateIrradiance call.',
        parameters: {
            type: 'OBJECT',
            properties: {
                panoramaImagePath: {
                    type: 'STRING',
                    description: 'Path to an equirectangular JPEG/PNG panorama or HDRI photo (2:1 aspect typical) to derive ambient SH9 lighting from.'
                }
            },
            required: ['panoramaImagePath']
        }
    }
];

const SH9_PROJECT_SOURCE = `
#include "scratchbox_ibl.hpp"
#include <cstdio>
#include <cstdlib>
#include <fstream>
#include <vector>

using scratchbox::ibl::SphericalHarmonics9;
using scratchbox::math::Vec3;

static void printVec3(const Vec3& v) {
    std::printf("[%.6f,%.6f,%.6f]", v.x, v.y, v.z);
}

int main(int argc, char** argv) {
    if (argc < 4) { std::fprintf(stderr, "usage: binFile width height\\n"); return 1; }
    const char* binPath = argv[1];
    int width = std::atoi(argv[2]);
    int height = std::atoi(argv[3]);
    if (width <= 0 || height <= 0) { std::fprintf(stderr, "invalid dimensions\\n"); return 1; }

    std::ifstream file(binPath, std::ios::binary);
    if (!file) { std::fprintf(stderr, "failed to open %s\\n", binPath); return 1; }

    size_t count = static_cast<size_t>(width) * static_cast<size_t>(height) * 3;
    std::vector<float> rgbData(count);
    file.read(reinterpret_cast<char*>(rgbData.data()), count * sizeof(float));
    if (!file) { std::fprintf(stderr, "failed to read expected float data (%zu floats)\\n", count); return 1; }

    SphericalHarmonics9 sh = SphericalHarmonics9::projectEquirectangular(rgbData.data(), width, height, 3);

    std::printf("{\\"coefficients\\":[");
    for (int i = 0; i < 9; ++i) {
        if (i > 0) std::printf(",");
        printVec3(sh.L[i]);
    }
    std::printf("],\\"sampleIrradiance\\":{");

    struct NamedNormal { const char* name; Vec3 n; };
    NamedNormal normals[6] = {
        {"up", Vec3(0.0f, 1.0f, 0.0f)},
        {"down", Vec3(0.0f, -1.0f, 0.0f)},
        {"plusX", Vec3(1.0f, 0.0f, 0.0f)},
        {"minusX", Vec3(-1.0f, 0.0f, 0.0f)},
        {"plusZ", Vec3(0.0f, 0.0f, 1.0f)},
        {"minusZ", Vec3(0.0f, 0.0f, -1.0f)}
    };
    for (int i = 0; i < 6; ++i) {
        if (i > 0) std::printf(",");
        std::printf("\\"%s\\":", normals[i].name);
        printVec3(sh.evaluateIrradiance(normals[i].n));
    }
    std::printf("}}\\n");
    return 0;
}
`;

interface Sh9Request {
    panoramaImagePath: string;
}

type Triple = [number, number, number];

interface Sh9ProjectOutput {
    coefficients: Triple[];
    sampleIrradiance: {
        up: Triple;
        down: Triple;
        plusX: Triple;
        minusX: Triple;
        plusZ: Triple;
        minusZ: Triple;
    };
}

async function estimateSh9FromPanoramaHandler(args: Record<string, unknown>, _ctx: ToolContext): Promise<ToolHandlerOutcome> {
    const request = args as unknown as Sh9Request;
    const { panoramaImagePath } = request;

    if (!panoramaImagePath || !fs.existsSync(panoramaImagePath)) {
        return { status: 'failed', resultPayload: { error: `Panorama image not found: ${panoramaImagePath}` } };
    }

    let binFile: string | undefined;
    try {
        const imageBuf = fs.readFileSync(panoramaImagePath);
        const dims = AdaptiveMaterialPbrService.parseImageDimensions(imageBuf);
        if (!dims) {
            return { status: 'failed', resultPayload: { error: `Could not read JPEG/PNG dimensions from: ${panoramaImagePath}` } };
        }
        const { width, height } = dims;

        const rgba = await AdaptiveMaterialPbrService.decodeToRgba(imageBuf);
        if (!rgba || rgba.length !== width * height * 4) {
            return {
                status: 'failed',
                resultPayload: { error: `Image decode failed or size mismatch for ${panoramaImagePath} (expected ${width}x${height} RGBA, got ${rgba?.length ?? 0} bytes)` }
            };
        }

        const pixelCount = width * height;
        const rgbFloats = new Float32Array(pixelCount * 3);
        for (let p = 0; p < pixelCount; p++) {
            rgbFloats[p * 3 + 0] = rgba[p * 4 + 0] / 255;
            rgbFloats[p * 3 + 1] = rgba[p * 4 + 1] / 255;
            rgbFloats[p * 3 + 2] = rgba[p * 4 + 2] / 255;
        }

        binFile = tempPath('sh9-panorama', 'bin');
        fs.writeFileSync(binFile, Buffer.from(rgbFloats.buffer, rgbFloats.byteOffset, rgbFloats.byteLength));

        const stdout = await compileAndRun('sh9_project_equirectangular', SH9_PROJECT_SOURCE, [binFile, String(width), String(height)]);
        const parsed = lastJsonLine(stdout) as Sh9ProjectOutput;

        const [upR, upG, upB] = parsed.sampleIrradiance.up;
        const upLuminance = 0.2126 * upR + 0.7152 * upG + 0.0722 * upB;
        // Rough, honestly-approximate warm/cool heuristic: compare red vs blue channel of the "up" sky sample.
        const tempBias = upR - upB;
        const warmCool = Math.abs(tempBias) < 0.02 ? 'neutral' : tempBias > 0 ? 'warm' : 'cool';

        return {
            status: 'completed',
            resultPayload: {
                panoramaImagePath,
                sourceWidth: width,
                sourceHeight: height,
                coefficients: parsed.coefficients,
                sampleIrradiance: parsed.sampleIrradiance
            },
            summaryResult:
                `SH9 ambient lighting from ${width}x${height} panorama: ` +
                `avg "up" luminance ${upLuminance.toFixed(3)}, reads ${warmCool} ` +
                `(R-B ${tempBias.toFixed(3)} on the up sample; a rough heuristic, not a measured color temperature).`
        };
    } catch (e) {
        const stderr = (e as Error & { stderr?: string }).stderr;
        return { status: 'failed', resultPayload: { error: `SH9 projection failed: ${stderr || String(e)}` } };
    } finally {
        if (binFile) fs.rmSync(binFile, { force: true });
    }
}

export const sh9LightingHandlers: Array<[ToolDeclaration, ToolHandler]> = [
    [SH9_LIGHTING_TOOL_DECLARATIONS[0], estimateSh9FromPanoramaHandler]
];
