/**
 * scratchbox_uv_engine.hpp solar de-lighting, compiled with the real clang++: each texel is divided by E(N) of the
 * mesh normal interpolated over the triangle that covers it (never a normal estimated from the image gradient), with the
 * ambient-to-sun ratio measured from the texture and the sun given by the caller (none is assumed).
 * The engine writes no roughness or ORM map (it has nothing that measures roughness) and lists its image heuristics.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import * as path from 'path';
import { compileNativeCached, defaultNativeFlags } from '../src/node/3d-engine/native-build-cache';

const INCLUDE = path.resolve(__dirname, '../src/native/3d-engine/include');

const SOURCE = String.raw`
#include "scratchbox_uv_engine.hpp"
#include <cstdio>
using namespace scratchbox;
using namespace scratchbox::uv_engine;
static float toSrgb(float c) { return c <= 0.0031308f ? 12.92f * c : 1.055f * std::pow(c, 1.0f / 2.4f) - 0.055f; }
int main() {
    // A roof (+Y), a south wall (+Z) and a north wall (-Z) on the left, middle and right thirds of one texture, one
    // albedo, baked in linear light with E = max(0, N.L) + 0.3: the engine is told the sun, not the 0.3.
    geometry::ScratchboxMesh mesh("roof_and_walls");
    auto add = [&](math::Vec3 p, math::Vec3 n, math::Vec2 uv) { mesh.addVertex(geometry::Vertex(p, n, uv)); };
    math::Vec3 up(0, 1, 0), south(0, 0, 1), north(0, 0, -1);
    const float t = 1.0f / 3.0f, u = 2.0f / 3.0f;
    add({0, 0, 0}, up, {0.0f, 1.0f}); add({1, 0, 0}, up, {t, 1.0f}); add({1, 0, 1}, up, {t, 0.0f}); add({0, 0, 1}, up, {0.0f, 0.0f});
    add({0, 0, 0}, south, {t, 1.0f}); add({1, 0, 0}, south, {u, 1.0f}); add({1, 1, 0}, south, {u, 0.0f}); add({0, 1, 0}, south, {t, 0.0f});
    add({0, 0, 1}, north, {u, 1.0f}); add({1, 0, 1}, north, {1.0f, 1.0f}); add({1, 1, 1}, north, {1.0f, 0.0f}); add({0, 1, 1}, north, {u, 0.0f});
    for (uint32_t i : {0u, 1u, 2u, 0u, 2u, 3u, 4u, 5u, 6u, 4u, 6u, 7u, 8u, 9u, 10u, 8u, 10u, 11u}) mesh.indices.push_back(i);

    math::Vec3 sunDir(0.3f, 0.8f, 0.52f);
    float eUp = computeSolarIrradiance(up, sunDir, 0.3f), eSouth = computeSolarIrradiance(south, sunDir, 0.3f), eNorth = computeSolarIrradiance(north, sunDir, 0.3f);
    texture::ImageBuffer img(96, 32, 3);
    for (int y = 0; y < 32; ++y) for (int x = 0; x < 96; ++x) {
        float v = toSrgb(0.4f * (x < 32 ? eUp : x < 64 ? eSouth : eNorth) / eUp);
        img.setPixelRGB(x, y, {v, v, v});
    }
    UvEngineOptions opt;
    opt.synthesizeCavitation = false;
    opt.decomposeAlbedo = false;
    opt.enableSolarDelighting = true;
    opt.gutterDilationPixels = 0;

    // No sun given: nothing is de-lit, and the reason says so.
    auto nosun = processMeshUvEngine(mesh, img, opt);
    std::printf("nosun_delit %d skipped %s\n", nosun.solarDelitTexels, nosun.solarDelightingSkippedReason.c_str());

    opt.solarEphemeris.sunVector = sunDir;
    auto res = processMeshUvEngine(mesh, img, opt);
    const auto& a = res.pbrSet.albedo;
    std::printf("in_roof %.4f in_south %.4f in_north %.4f\n", img.getPixelRGB(8, 16).x, img.getPixelRGB(48, 16).x, img.getPixelRGB(88, 16).x);
    std::printf("out_roof %.4f out_south %.4f out_north %.4f\n", a.getPixelRGB(8, 16).x, a.getPixelRGB(48, 16).x, a.getPixelRGB(88, 16).x);
    std::printf("fitted %d k %.4f clipped %d\n", (int)res.solarFit.fitted, res.solarFit.ambientToSun, res.solarClippedTexels);
    std::printf("delit %d roughness_empty %d orm_empty %d heuristics %zu\n", res.solarDelitTexels, (int)res.pbrSet.roughness.empty(), (int)res.pbrSet.orm.empty(), res.heuristicMaps.size());
    std::printf("reason %s\n", res.roughnessUnmeasuredReason.c_str());

    // A mesh whose vertex normals are all zero has no geometry normal: nothing is de-lit, and the result says why.
    for (auto& v : mesh.vertices) v.normal = math::Vec3(0, 0, 0);
    auto none = processMeshUvEngine(mesh, img, opt);
    std::printf("none_delit %d skipped %s\n", none.solarDelitTexels, none.solarDelightingSkippedReason.c_str());
    return 0;
}
`;

describe('scratchbox_uv_engine.hpp solar de-lighting (native)', () => {
    it('equalises three faces with the measured ambient, writes no roughness/ORM, and skips without a sun or normals', async () => {
        const built = await compileNativeCached({ sourceCode: SOURCE, includeDirs: [INCLUDE], flags: defaultNativeFlags([]), name: 'uv_engine_solar_delight_measured' });
        const out = execFileSync(built.binaryPath, { encoding: 'utf8' });
        const num = (key: string) => Number(new RegExp(`(?:^|\\s)${key} (-?[\\d.]+)`, 'm').exec(out)![1]);

        expect(num('nosun_delit')).toBe(0);
        expect(out).toMatch(/nosun_delit 0 skipped no sun vector was given/);
        expect(num('in_roof') - num('in_north')).toBeGreaterThan(0.2);
        expect(num('fitted')).toBe(1);
        expect(Math.abs(num('k') - 0.3)).toBeLessThan(0.03);
        expect(num('clipped')).toBe(0);
        expect(Math.abs(num('out_roof') - num('out_south'))).toBeLessThan(0.02);
        expect(Math.abs(num('out_roof') - num('out_north'))).toBeLessThan(0.02);
        expect(num('delit')).toBeGreaterThan(96 * 32 * 0.9);
        expect(num('roughness_empty')).toBe(1);
        expect(num('orm_empty')).toBe(1);
        expect(num('heuristics')).toBe(2);
        expect(out).toMatch(/reason roughness is not measured/);
        expect(num('none_delit')).toBe(0);
        expect(out).toMatch(/skipped no texel is covered by a mesh triangle with a non-zero normal/);
    }, 120_000);
});
