/**
 * scratchbox_uv_engine.hpp solar de-lighting, compiled with the real clang++: each texel is divided by E(N) of the
 * mesh normal interpolated over the triangle that covers it, never by a normal estimated from the image gradient.
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
int main() {
    // A roof (+Y) on the left half of the texture and a south wall (+Z) on the right half, one albedo (0.6),
    // baked with the light the engine's E(N) model gives each face.
    geometry::ScratchboxMesh mesh("roof_and_wall");
    auto add = [&](math::Vec3 p, math::Vec3 n, math::Vec2 uv) { mesh.addVertex(geometry::Vertex(p, n, uv)); };
    math::Vec3 up(0, 1, 0), south(0, 0, 1);
    add({0, 0, 0}, up, {0.0f, 1.0f}); add({1, 0, 0}, up, {0.5f, 1.0f}); add({1, 0, 1}, up, {0.5f, 0.0f}); add({0, 0, 1}, up, {0.0f, 0.0f});
    add({0, 0, 0}, south, {0.5f, 1.0f}); add({1, 0, 0}, south, {1.0f, 1.0f}); add({1, 1, 0}, south, {1.0f, 0.0f}); add({0, 1, 0}, south, {0.5f, 0.0f});
    for (uint32_t i : {0u, 1u, 2u, 0u, 2u, 3u, 4u, 5u, 6u, 4u, 6u, 7u}) mesh.indices.push_back(i);

    SolarEphemerisConfig sun;
    sun.sunVector = math::Vec3(0.3f, 0.8f, 0.52f);
    float eUp = computeSolarIrradiance(up, sun), eSouth = computeSolarIrradiance(south, sun);
    float eMax = std::max(eUp, eSouth);
    texture::ImageBuffer img(64, 32, 3);
    for (int y = 0; y < 32; ++y) for (int x = 0; x < 64; ++x) {
        float v = 0.6f * (x < 32 ? eUp : eSouth) / eMax;
        img.setPixelRGB(x, y, {v, v, v});
    }
    UvEngineOptions opt;
    opt.synthesizeCavitation = false;
    opt.decomposeAlbedo = false;
    opt.enableSolarDelighting = true;
    opt.solarEphemeris = sun;
    opt.gutterDilationPixels = 0;
    auto res = processMeshUvEngine(mesh, img, opt);
    const auto& a = res.pbrSet.albedo;
    std::printf("in_roof %.4f in_wall %.4f\n", img.getPixelRGB(8, 16).x, img.getPixelRGB(56, 16).x);
    std::printf("out_roof %.4f out_wall %.4f\n", a.getPixelRGB(8, 16).x, a.getPixelRGB(56, 16).x);
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
    it('equalises two faces lit differently using the mesh normals, writes no roughness/ORM, and skips without normals', async () => {
        const built = await compileNativeCached({ sourceCode: SOURCE, includeDirs: [INCLUDE], flags: defaultNativeFlags([]), name: 'uv_engine_solar_delight' });
        const out = execFileSync(built.binaryPath, { encoding: 'utf8' });
        const num = (key: string) => Number(new RegExp(`${key} (-?[\\d.]+)`).exec(out)![1]);

        expect(num('in_roof') - num('in_wall')).toBeGreaterThan(0.1);
        expect(Math.abs(num('out_roof') - num('out_wall'))).toBeLessThan(0.03);
        expect(num('delit')).toBeGreaterThan(64 * 32 * 0.9);
        expect(num('roughness_empty')).toBe(1);
        expect(num('orm_empty')).toBe(1);
        expect(num('heuristics')).toBe(2);
        expect(out).toMatch(/reason roughness is not measured/);
        expect(num('none_delit')).toBe(0);
        expect(out).toMatch(/skipped no texel is covered by a mesh triangle with a non-zero normal/);
    }, 120_000);
});
