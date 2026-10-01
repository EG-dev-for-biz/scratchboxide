/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import { describe, it, expect, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { inflateSync } from 'zlib';
import { NativeCppCompilerService } from '../src/node/3d-engine/native-compiler-service';
import { NativeTilePathTracerService } from '../src/node/3d-engine/native-tile-path-tracer-service';
import { resolveBinary } from '../src/node/video/HeadlessVideoEditorService';
import { decodePng } from '../src/node/texture-processing';

const REPO_ROOT = process.cwd();
const TILE_GLB = path.resolve(REPO_ROOT, 'public/models/nyc_grand_army_plaza_raw.glb');
const ARCH_GLB = path.resolve(REPO_ROOT, 'public/models/washington_square_arch_nyc_raw.glb');

const RESULT_JSON_HARNESS = String.raw`
#include <iostream>
#include <sstream>
#include <fstream>
#include <string>
#include <vector>
#include <cmath>
#include <algorithm>
struct ResultJson {
    std::ostringstream out;
    bool first = true;
    ResultJson() { out.precision(9); out << '{'; }
    void key(const char* k) { if (!first) out << ','; first = false; out << '"' << k << '"' << ':'; }
    ResultJson& num(const char* k, double v) { key(k); if (std::isfinite(v)) out << v; else out << "null"; return *this; }
    ResultJson& flag(const char* k, bool v) { key(k); out << (v ? "true" : "false"); return *this; }
    ResultJson& text(const char* k, const std::string& v) {
        key(k); out << '"';
        for (char c : v) { if (c == '"' || c == '\\') out << '\\'; out << c; }
        out << '"'; return *this;
    }
    ResultJson& vec(const char* k, double x, double y, double z) { key(k); out << '[' << x << ',' << y << ',' << z << ']'; return *this; }
    void emit() { out << '}'; std::cout << "RESULT " << out.str() << std::endl; }
};
`;

function readGlb(glbPath: string): { json: any; bin: Buffer } {
    const buf = fs.readFileSync(glbPath);
    const jsonLength = buf.readUInt32LE(12);
    const json = JSON.parse(buf.subarray(20, 20 + jsonLength).toString('utf8'));
    const binStart = 20 + jsonLength + 8;
    const binLength = buf.readUInt32LE(20 + jsonLength);
    return { json, bin: buf.subarray(binStart, binStart + binLength) };
}

function extractGlbImage(glbPath: string, imageIndex: number): Buffer {
    const { json, bin } = readGlb(glbPath);
    const view = json.bufferViews[json.images[imageIndex].bufferView];
    const offset = view.byteOffset ?? 0;
    return Buffer.from(bin.subarray(offset, offset + view.byteLength));
}

function readPngSize(pngPath: string): { width: number; height: number } {
    const buf = fs.readFileSync(pngPath);
    expect(buf.subarray(1, 4).toString('ascii')).toBe('PNG');
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

// Decodes an 8-bit grayscale, non-interlaced PNG whose scanlines all use filter type 0.
function readGrayPng(pngPath: string): { width: number; height: number; pixels: Uint8Array } {
    const buf = fs.readFileSync(pngPath);
    const { width, height } = readPngSize(pngPath);
    expect(buf[24]).toBe(8);
    expect(buf[25]).toBe(0);
    const idat: Buffer[] = [];
    for (let offset = 8; offset < buf.length;) {
        const length = buf.readUInt32BE(offset);
        if (buf.subarray(offset + 4, offset + 8).toString('ascii') === 'IDAT') {
            idat.push(buf.subarray(offset + 8, offset + 8 + length));
        }
        offset += 12 + length;
    }
    const raw = inflateSync(Buffer.concat(idat));
    const pixels = new Uint8Array(width * height);
    for (let y = 0; y < height; y++) {
        expect(raw[y * (width + 1)]).toBe(0);
        pixels.set(raw.subarray(y * (width + 1) + 1, (y + 1) * (width + 1)), y * width);
    }
    return { width, height, pixels };
}

function psnr(a: Buffer, b: Buffer): number {
    let sq = 0;
    for (let i = 0; i < a.length; i++) {
        const d = a[i] - b[i];
        sq += d * d;
    }
    const mse = sq / a.length;
    return mse === 0 ? Infinity : 10 * Math.log10((255 * 255) / mse);
}

describe('Native tile path tracer (Blender-referenced, no Blender dependency)', () => {
    const compiler = new NativeCppCompilerService();
    let workDir = '';

    beforeAll(() => {
        workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-pathtracer-'));
    });

    async function runProgram(name: string, body: string, args: string[] = []): Promise<any> {
        const compiled = await compiler.compileSource(RESULT_JSON_HARNESS + body, {
            outputDir: workDir,
            outputBinaryName: name,
            optimization: '-O2'
        });
        if (!compiled.success || !compiled.binaryPath) {
            throw new Error(`Compilation of ${name} failed:\n${compiled.compilerOutput}`);
        }
        const exec = await compiler.executeBinary(compiled.binaryPath, args, workDir);
        if (exec.exitCode !== 0) {
            throw new Error(`${name} exited with ${exec.exitCode}:\n${exec.stderr}`);
        }
        const line = exec.stdout.split('\n').find(l => l.startsWith('RESULT '));
        if (!line) {
            throw new Error(`${name} printed no RESULT line:\n${exec.stdout}`);
        }
        return JSON.parse(line.slice('RESULT '.length));
    }

    it('decodes baseline 4:2:0 tile JPEGs to match ffmpeg', async () => {
        const jpgPath = path.join(workDir, 'tile_texture_0.jpg');
        const rgbPath = path.join(workDir, 'tile_texture_0.rgb');
        const lumaPath = path.join(workDir, 'tile_texture_0.luma');
        fs.writeFileSync(jpgPath, extractGlbImage(TILE_GLB, 0));

        const res = await runProgram('jpeg_decode_check', String.raw`
#include "scratchbox_jpeg.hpp"
int main(int argc, char** argv) {
    using namespace scratchbox;
    auto rgb = jpeg::decodeFile(argv[1], jpeg::OutputFormat::Rgb);
    auto luma = jpeg::decodeFile(argv[1], jpeg::OutputFormat::Luma);
    ResultJson r;
    r.flag("ok", rgb.ok && luma.ok).text("error", rgb.error + luma.error);
    if (rgb.ok && luma.ok) {
        std::ofstream(argv[2], std::ios::binary).write(reinterpret_cast<const char*>(rgb.image.data.data()), rgb.image.data.size());
        std::ofstream(argv[3], std::ios::binary).write(reinterpret_cast<const char*>(luma.image.data.data()), luma.image.data.size());
        r.num("width", rgb.image.width).num("height", rgb.image.height)
         .num("channels", rgb.image.channels).num("lumaChannels", luma.image.channels);
    }
    r.emit();
    return 0;
}
`, [jpgPath, rgbPath, lumaPath]);

        expect(res.ok).toBe(true);
        expect(res.width).toBe(512);
        expect(res.height).toBe(512);
        expect(res.channels).toBe(3);
        expect(res.lumaChannels).toBe(1);

        const ffmpeg = resolveBinary('ffmpeg');
        const refLuma = execFileSync(ffmpeg, ['-v', 'error', '-i', jpgPath, '-f', 'rawvideo', '-pix_fmt', 'gray', '-']);
        const refRgb = execFileSync(ffmpeg, ['-v', 'error', '-i', jpgPath, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-']);
        const luma = fs.readFileSync(lumaPath);
        const rgb = fs.readFileSync(rgbPath);
        expect(luma.length).toBe(refLuma.length);
        expect(rgb.length).toBe(refRgb.length);

        let maxLumaDiff = 0;
        let sumLumaDiff = 0;
        for (let i = 0; i < luma.length; i++) {
            const d = Math.abs(luma[i] - refLuma[i]);
            maxLumaDiff = Math.max(maxLumaDiff, d);
            sumLumaDiff += d;
        }
        // Luma involves only entropy decoding, dequantization and the IDCT.
        expect(maxLumaDiff).toBeLessThanOrEqual(2);
        expect(sumLumaDiff / luma.length).toBeLessThan(0.25);
        // RGB additionally depends on each decoder's chroma upsampling filter.
        expect(psnr(rgb, refRgb)).toBeGreaterThan(30);
    });

    it('reads GLB scenes with node transforms, materials and decoded textures', async () => {
        const program = String.raw`
#include "scratchbox_gltf_scene.hpp"
int main(int argc, char** argv) {
    using namespace scratchbox;
    auto scene = gltf::GlbSceneReader::readFile(argv[1]);
    size_t decoded = 0;
    for (const auto& image : scene.images) decoded += image.decoded ? 1 : 0;
    double maxNormalError = 0.0;
    for (const auto& v : scene.mesh.vertices) {
        maxNormalError = std::max(maxNormalError, std::abs(static_cast<double>(v.normal.length()) - 1.0));
    }
    ResultJson r;
    r.flag("ok", scene.ok).text("error", scene.error)
     .num("primitives", scene.primitiveCount)
     .num("triangles", scene.mesh.indices.size() / 3)
     .num("triangleMaterials", scene.triangleMaterial.size())
     .num("materials", scene.materials.size())
     .num("images", scene.images.size())
     .num("imagesDecoded", decoded)
     .vec("boundsMin", scene.bounds.min.x, scene.bounds.min.y, scene.bounds.min.z)
     .vec("boundsMax", scene.bounds.max.x, scene.bounds.max.y, scene.bounds.max.z)
     .num("maxNormalLengthError", maxNormalError);
    if (!scene.materials.empty()) {
        r.num("firstMetallic", scene.materials[0].metallicFactor)
         .num("firstRoughness", scene.materials[0].roughnessFactor)
         .num("firstBaseColorImage", scene.materials[0].baseColorImage)
         .flag("firstUnlit", scene.materials[0].unlit);
    }
    r.emit();
    return 0;
}
`;
        const tile = await runProgram('gltf_scene_tile_check', program, [TILE_GLB]);
        expect(tile.ok).toBe(true);
        expect(tile.primitives).toBe(83);
        expect(tile.images).toBe(83);
        expect(tile.imagesDecoded).toBe(83);
        expect(tile.triangleMaterials).toBe(tile.triangles);
        expect(tile.firstMetallic).toBeCloseTo(0.1, 5);
        expect(tile.firstRoughness).toBeCloseTo(0.8, 5);
        expect(tile.firstBaseColorImage).toBe(0);
        // World-space bounds after applying each node's matrix (measured independently with numpy).
        const expectedMin = [-116.9, -936.9, -115.0];
        const expectedMax = [290.0, -709.3, 266.3];
        for (let k = 0; k < 3; k++) {
            expect(Math.abs(tile.boundsMin[k] - expectedMin[k])).toBeLessThan(0.2);
            expect(Math.abs(tile.boundsMax[k] - expectedMax[k])).toBeLessThan(0.2);
        }

        // This tile has no NORMAL attribute and uses KHR_materials_unlit.
        const arch = await runProgram('gltf_scene_arch_check', program, [ARCH_GLB]);
        expect(arch.ok).toBe(true);
        expect(arch.imagesDecoded).toBe(arch.images);
        expect(arch.triangles).toBeGreaterThan(1000);
        expect(arch.maxNormalLengthError).toBeLessThan(1e-3);
        expect(arch.firstUnlit).toBe(true);
    });

    it('computes a single-scattering sky with physically ordered colors', async () => {
        const res = await runProgram('sky_check', String.raw`
#include "scratchbox_sky.hpp"
int main() {
    using namespace scratchbox;
    using math::Vec3;
    auto dirFrom = [](float elevationDeg, float azimuthDeg) {
        float e = elevationDeg * math::DEG_TO_RAD;
        float a = azimuthDeg * math::DEG_TO_RAD;
        return Vec3(std::cos(e) * std::sin(a), std::sin(e), -std::cos(e) * std::cos(a));
    };
    auto lum = [](const Vec3& c) { return 0.2126 * c.x + 0.7152 * c.y + 0.0722 * c.z; };
    sky::PhysicalSky noon(dirFrom(60.0f, 180.0f));
    sky::PhysicalSky sunset(dirFrom(2.0f, 270.0f));
    ResultJson r;
    Vec3 nz = noon.skyRadiance(Vec3(0, 1, 0));
    Vec3 sz = sunset.skyRadiance(Vec3(0, 1, 0));
    Vec3 sh = sunset.skyRadiance(dirFrom(2.0f, 280.0f));
    Vec3 tn = noon.sunTransmittance();
    Vec3 ts = sunset.sunTransmittance();
    r.vec("noonZenith", nz.x, nz.y, nz.z).vec("sunsetZenith", sz.x, sz.y, sz.z)
     .vec("sunsetHorizonTowardSun", sh.x, sh.y, sh.z)
     .vec("noonSunTransmittance", tn.x, tn.y, tn.z).vec("sunsetSunTransmittance", ts.x, ts.y, ts.z);

    double maxRelative = 0.0;
    for (float e : {5.0f, 30.0f, 80.0f}) {
        for (float a : {180.0f, 270.0f, 0.0f}) {
            Vec3 d = dirFrom(e, a);
            double lut = lum(noon.skyRadiance(d));
            double direct = lum(noon.skyRadianceDirect(d));
            maxRelative = std::max(maxRelative, std::abs(lut - direct) / direct);
        }
    }
    r.num("maxLutRelativeError", maxRelative);

    Vec3 center = noon.sunDiscRadiance(noon.sunDirection());
    Vec3 outside = noon.sunDiscRadiance(dirFrom(60.0f, 185.0f));
    double sum = 0.0;
    const int n = 64;
    for (int i = 0; i < n; ++i) {
        for (int j = 0; j < n; ++j) {
            sum += lum(noon.sunDiscRadiance(noon.sampleSunDirection((i + 0.5f) / n, (j + 0.5f) / n)));
        }
    }
    double integral = sum / (n * n) * noon.sunSolidAngle();
    Vec3 e = noon.sunIrradiance();
    Vec3 haze = noon.hazeExtinction();
    Vec3 skyE = noon.skyIrradianceHorizontal();
    r.num("discCenterLuminance", lum(center)).num("discOutsideLuminance", lum(outside))
     .num("discIntegralOverIrradiance", integral / lum(e))
     .vec("hazeExtinction", haze.x, haze.y, haze.z)
     .vec("skyIrradianceHorizontal", skyE.x, skyE.y, skyE.z)
     .num("skyToSunHorizontalRatio", lum(skyE) / (lum(e) * std::sin(60.0 * math::DEG_TO_RAD)));
    r.emit();
    return 0;
}
`);
        const all = [...res.noonZenith, ...res.sunsetZenith, ...res.sunsetHorizonTowardSun];
        for (const v of all) {
            expect(Number.isFinite(v)).toBe(true);
            expect(v).toBeGreaterThanOrEqual(0);
        }
        const [nr, , nb] = res.noonZenith;
        expect(nb).toBeGreaterThan(1.3 * nr);
        expect(res.sunsetZenith[2]).toBeGreaterThan(res.sunsetZenith[0]);
        expect(res.sunsetHorizonTowardSun[0]).toBeGreaterThan(res.sunsetHorizonTowardSun[2]);
        const noonRatio = res.noonSunTransmittance[0] / res.noonSunTransmittance[2];
        const sunsetRatio = res.sunsetSunTransmittance[0] / res.sunsetSunTransmittance[2];
        expect(sunsetRatio).toBeGreaterThan(3 * noonRatio);
        expect(res.maxLutRelativeError).toBeLessThan(0.05);
        expect(res.discCenterLuminance).toBeGreaterThan(0);
        expect(res.discOutsideLuminance).toBe(0);
        expect(res.discIntegralOverIrradiance).toBeGreaterThan(0.97);
        expect(res.discIntegralOverIrradiance).toBeLessThan(1.03);
        const [hr, hg, hb] = res.hazeExtinction;
        expect(hb).toBeGreaterThan(hg);
        expect(hg).toBeGreaterThan(hr);
        expect(hr).toBeGreaterThan(0);
        expect(res.skyIrradianceHorizontal[2]).toBeGreaterThan(res.skyIrradianceHorizontal[0]);
        expect(res.skyToSunHorizontalRatio).toBeGreaterThan(0.03);
        expect(res.skyToSunHorizontalRatio).toBeLessThan(0.5);
    });

    it('applies the AgX view transform and exposure', async () => {
        const res = await runProgram('agx_check', String.raw`
#include "scratchbox_view_transform.hpp"
int main() {
    using namespace scratchbox;
    using math::Vec3;
    ResultJson r;
    bool monotonic = true;
    float previous = -1.0f;
    for (int i = 0; i <= 200; ++i) {
        float v = std::pow(2.0f, -14.0f + 0.1f * static_cast<float>(i));
        float d = view::agxDisplay(Vec3(v, v, v)).y;
        if (d + 1e-6f < previous) monotonic = false;
        previous = d;
    }
    Vec3 grey = view::agxDisplay(Vec3(0.18f, 0.18f, 0.18f));
    Vec3 red = view::agxDisplay(Vec3(100.0f, 0.0f, 0.0f));
    std::vector<Vec3> flat(64, Vec3(0.045f, 0.045f, 0.045f));
    r.flag("monotonic", monotonic)
     .num("grey18", grey.y)
     .num("greyChroma", std::max({grey.x, grey.y, grey.z}) - std::min({grey.x, grey.y, grey.z}))
     .num("black", view::agxDisplay(Vec3(0.0f, 0.0f, 0.0f)).y)
     .num("bright16", view::agxDisplay(Vec3(16.0f, 16.0f, 16.0f)).y)
     .vec("brightRed", red.x, red.y, red.z)
     .num("srgbHalf", view::srgbEncode(0.5f))
     .num("autoEv", view::autoExposureEv(flat));
    r.emit();
    return 0;
}
`);
        expect(res.monotonic).toBe(true);
        expect(res.grey18).toBeGreaterThan(0.45);
        expect(res.grey18).toBeLessThan(0.55);
        expect(res.greyChroma).toBeLessThan(0.01);
        expect(res.black).toBeLessThanOrEqual(0.02);
        expect(res.bright16).toBeGreaterThan(0.95);
        expect(res.bright16).toBeLessThanOrEqual(1.0);
        // Very bright saturated light desaturates toward white instead of clipping to pure red.
        expect(res.brightRed[0]).toBeGreaterThan(0.95);
        expect(res.brightRed[1]).toBeGreaterThan(0.8);
        expect(res.srgbHalf).toBeCloseTo(0.7354, 3);
        expect(res.autoEv).toBeCloseTo(2.0, 2);
    });

    it('denoises lighting while preserving albedo and geometry edges', async () => {
        const res = await runProgram('denoise_check', String.raw`
#include "scratchbox_denoise.hpp"
#include <random>
int main() {
    using namespace scratchbox;
    using math::Vec3;
    const int W = 64, H = 64;
    std::mt19937 rng(7);
    std::uniform_real_distribution<float> noise(-0.5f, 0.5f);

    auto makeGuides = [&]() {
        denoise::GuideBuffers g;
        g.width = W; g.height = H;
        g.albedo.assign(W * H, Vec3(1, 1, 1));
        g.normal.assign(W * H, Vec3(0, 1, 0));
        g.depth.assign(W * H, 10.0f);
        g.variance.assign(W * H, 0.0f);
        g.geometryMask.assign(W * H, 1);
        return g;
    };
    auto columnMean = [&](const std::vector<Vec3>& img, int x) {
        double s = 0.0;
        for (int y = 8; y < H - 8; ++y) s += img[y * W + x].y;
        return s / (H - 16);
    };

    // Albedo edge under constant, noisy illumination.
    denoise::GuideBuffers ga = makeGuides();
    std::vector<Vec3> colorA(W * H);
    for (int y = 0; y < H; ++y) {
        for (int x = 0; x < W; ++x) {
            float albedo = x < 32 ? 0.2f : 0.8f;
            float v = albedo * (1.0f + noise(rng));
            ga.albedo[y * W + x] = Vec3(albedo, albedo, albedo);
            ga.variance[y * W + x] = albedo * albedo / 12.0f;
            colorA[y * W + x] = Vec3(v, v, v);
        }
    }
    ga.geometryMask[5 * W + 5] = 0;
    auto outA = denoise::denoiseATrous(colorA, ga);

    auto illumStd = [&](const std::vector<Vec3>& img) {
        double s = 0.0, s2 = 0.0; int n = 0;
        for (int y = 8; y < H - 8; ++y) {
            for (int x = 4; x < 28; ++x) {
                double v = img[y * W + x].y / 0.2;
                s += v; s2 += v * v; ++n;
            }
        }
        double m = s / n;
        return std::sqrt(std::max(0.0, s2 / n - m * m));
    };

    // Geometry edge: same albedo, different normals and lighting.
    denoise::GuideBuffers gb = makeGuides();
    std::vector<Vec3> colorB(W * H);
    for (int y = 0; y < H; ++y) {
        for (int x = 0; x < W; ++x) {
            float illum = x < 32 ? 0.3f : 1.0f;
            float v = illum * (1.0f + noise(rng));
            gb.normal[y * W + x] = x < 32 ? Vec3(0, 1, 0) : Vec3(1, 0, 0);
            gb.variance[y * W + x] = illum * illum / 12.0f;
            colorB[y * W + x] = Vec3(v, v, v);
        }
    }
    auto outB = denoise::denoiseATrous(colorB, gb);

    ResultJson r;
    r.num("noiseStdBefore", illumStd(colorA)).num("noiseStdAfter", illumStd(outA))
     .num("edgeLeftMean", columnMean(outA, 31)).num("edgeRightMean", columnMean(outA, 32))
     .num("normalEdgeLeftMean", columnMean(outB, 31)).num("normalEdgeRightMean", columnMean(outB, 32))
     .flag("backgroundPassThrough", outA[5 * W + 5].y == colorA[5 * W + 5].y);
    r.emit();
    return 0;
}
`);
        expect(res.noiseStdAfter).toBeLessThan(res.noiseStdBefore / 3);
        expect(Math.abs(res.edgeLeftMean - 0.2)).toBeLessThan(0.04);
        expect(Math.abs(res.edgeRightMean - 0.8)).toBeLessThan(0.08);
        expect(Math.abs(res.normalEdgeLeftMean - 0.3)).toBeLessThan(0.06);
        expect(Math.abs(res.normalEdgeRightMean - 1.0)).toBeLessThan(0.1);
        expect(res.backgroundPassThrough).toBe(true);
    });

    it('rejects a render request without an explicit sun', async () => {
        const service = new NativeTilePathTracerService();
        await expect(service.render({ glbPath: ARCH_GLB, outputDir: path.join(workDir, 'no_sun') } as any))
            .rejects.toThrow(/sun/i);
    });

    it('keeps contrast in the depth pass when the ground plane reaches the horizon', async () => {
        const service = new NativeTilePathTracerService();
        const result = await service.render({
            glbPath: ARCH_GLB,
            outputDir: path.join(workDir, 'depth_horizon'),
            width: 96,
            height: 64,
            samplesPerPixel: 2,
            maxBounces: 0,
            camera: { auto: { pitchDeg: 4, headingDeg: 20 } },
            sun: { elevationDeg: 40, azimuthDeg: 200 }
        });
        const { width, height, pixels } = readGrayPng(result.depthPngPath);
        const covered = Array.from(pixels).filter(v => v > 0).sort((a, b) => a - b);
        expect(covered.length).toBeGreaterThan(width * height * 0.2);
        const p10 = covered[Math.floor(covered.length * 0.1)];
        const p90 = covered[Math.floor(covered.length * 0.9)];
        expect(p90 - p10).toBeGreaterThanOrEqual(40);
    });

    it('renders a tile end-to-end in relit and baked modes with the sun from the native ephemeris', async () => {
        const service = new NativeTilePathTracerService();
        for (const mode of ['relit', 'baked'] as const) {
            const result = await service.render({
                glbPath: ARCH_GLB,
                outputDir: path.join(workDir, `e2e_${mode}`),
                width: 96,
                height: 64,
                samplesPerPixel: 8,
                maxBounces: 3,
                shadingMode: mode,
                // Washington Square Park at local solar noon on the June solstice.
                sun: { latitude: 40.7308, longitude: -73.9973, isoDate: '2026-06-21T16:58:00Z' }
            });
            expect(result.success).toBe(true);
            for (const png of [result.beautyPngPath, result.noisyPngPath, result.albedoPngPath, result.normalPngPath, result.depthPngPath]) {
                expect(fs.existsSync(png)).toBe(true);
                expect(readPngSize(png)).toEqual({ width: 96, height: 64 });
            }
            expect(result.stats.shadingMode).toBe(mode);
            expect(result.stats.nanSamples).toBe(0);
            expect(result.stats.triangles).toBeGreaterThan(1000);
            expect(result.stats.imagesDecoded).toBe(result.stats.images);
            expect(result.stats.geometryCoverage).toBeGreaterThan(0.2);
            expect(result.stats.meanDisplayLuminance).toBeGreaterThan(0.05);
            expect(result.stats.meanDisplayLuminance).toBeLessThan(0.95);
            // Maximum solar elevation at 40.73°N on the solstice is 90 - 40.73 + 23.44 = 72.71°.
            expect(Math.abs(result.stats.sun.elevationDeg - 72.7)).toBeLessThan(0.6);
            expect(Math.abs(result.stats.sun.azimuthDeg - 180)).toBeLessThan(4);
            // +Z is south in the tile frame, so a southern noon sun has z > 0 and almost no x.
            expect(result.stats.sun.direction[2]).toBeGreaterThan(0);
            expect(Math.abs(result.stats.sun.direction[0])).toBeLessThan(0.1);
        }
    });

    it('renders a geometry-only clay blockout with one uniform albedo in place of the captured textures', async () => {
        const service = new NativeTilePathTracerService();
        const common = {
            glbPath: ARCH_GLB, width: 96, height: 64, samplesPerPixel: 4, maxBounces: 1, groundPlane: false,
            shadingMode: 'relit' as const, sun: { elevationDeg: 50, azimuthDeg: 200 }
        };
        const textured = await service.render({ ...common, outputDir: path.join(workDir, 'clay_off') });
        const clay = await service.render({ ...common, outputDir: path.join(workDir, 'clay_on'), clay: { albedo: [0.716, 0.672, 0.61] } });

        // Fraction of geometry pixels whose albedo is within 4 levels of the most common albedo colour.
        const dominantShare = (pngPath: string) => {
            const { width, height, rgba } = decodePng(fs.readFileSync(pngPath));
            const counts = new Map<number, number>();
            const colours: number[][] = [];
            for (let i = 0; i < width * height; i++) {
                const c = [rgba[i * 4], rgba[i * 4 + 1], rgba[i * 4 + 2]];
                if (Math.max(...c) <= 8) continue;
                colours.push(c);
                const key = (c[0] << 16) | (c[1] << 8) | c[2];
                counts.set(key, (counts.get(key) ?? 0) + 1);
            }
            const mode = [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
            const m = [(mode >> 16) & 255, (mode >> 8) & 255, mode & 255];
            return colours.filter(c => c.every((v, k) => Math.abs(v - m[k]) <= 4)).length / colours.length;
        };
        expect(clay.stats.nanSamples).toBe(0);
        expect(clay.stats.geometryCoverage).toBeCloseTo(textured.stats.geometryCoverage, 2);
        expect(dominantShare(clay.albedoPngPath)).toBeGreaterThan(0.9);
        expect(dominantShare(textured.albedoPngPath)).toBeLessThan(0.5);
    });
});
