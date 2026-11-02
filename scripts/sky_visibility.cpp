/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/
/**
 * sky_visibility: cosine-weighted sky visibility at points against a mesh (scratchbox_bvh.hpp skyVisibility), as a small
 * CLI driver. Its caller is pipeline K's sky de-light (SkyVisibilityService,
 * packages/core/src/node/3d-engine/sky-visibility-service.ts); any stage that needs to know how much sky a point sees can
 * use it.
 *
 * usage: sky_visibility --positions <p.f32> --indices <i.u32> --samples <s.f32> --out <v.f32>
 *                       [--rays N] [--max-ray M] [--origin-offset M] [--min-hit M] [--min-dir-y Y] [--threads N]
 *   p.f32   float32 x 3 per vertex (x y z)
 *   i.u32   uint32 x 3 per triangle
 *   s.f32   float32 x 6 per sample: the point, then the unit normal of the side it looks from
 *   v.f32   float32 per sample, written: the share of its counted rays that reach max-ray unblocked
 * Prints one JSON line on stdout: {"ok":true,"vertices":..,"triangles":..,"samples":..,"rays":..,"ms":{..}}.
 */
#include "scratchbox_bvh.hpp"
#include <chrono>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <fstream>
#include <iostream>
#include <string>
#include <vector>

using scratchbox::bvh::BvhTree;
using scratchbox::bvh::SkyVisibilityParams;
using scratchbox::geometry::ScratchboxMesh;
using scratchbox::geometry::Vertex;
using scratchbox::math::Vec3;

static void usage() {
    std::cerr <<
        "usage: sky_visibility --positions <p.f32> --indices <i.u32> --samples <s.f32> --out <v.f32> [options]\n"
        "  --rays N           rays per sample over its hemisphere (default 48)\n"
        "  --max-ray M        a ray unblocked this far sees sky (default 300)\n"
        "  --origin-offset M  rays start this far off the surface along the normal (default 0.05)\n"
        "  --min-hit M        hits nearer than this along a ray are ignored (default 0.05)\n"
        "  --min-dir-y Y      rays pointing lower than this are not counted (default -0.02)\n"
        "  --threads N        worker threads (default: all cores)\n";
}

template <typename T>
static bool readAll(const std::string& file, std::vector<T>& out) {
    std::ifstream in(file, std::ios::binary | std::ios::ate);
    if (!in) return false;
    const std::streamsize bytes = in.tellg();
    if (bytes < 0 || bytes % static_cast<std::streamsize>(sizeof(T)) != 0) return false;
    out.resize(static_cast<size_t>(bytes) / sizeof(T));
    in.seekg(0);
    return static_cast<bool>(in.read(reinterpret_cast<char*>(out.data()), bytes));
}

int main(int argc, char** argv) {
    std::string positionsFile, indicesFile, samplesFile, outFile;
    SkyVisibilityParams P;
    unsigned threads = 0;
    for (int i = 1; i < argc; ++i) {
        const std::string a = argv[i];
        auto next = [&]() -> const char* {
            if (i + 1 >= argc) { std::cerr << "missing value for " << a << "\n"; std::exit(2); }
            return argv[++i];
        };
        if (a == "--positions") positionsFile = next();
        else if (a == "--indices") indicesFile = next();
        else if (a == "--samples") samplesFile = next();
        else if (a == "--out") outFile = next();
        else if (a == "--rays") P.rays = std::atoi(next());
        else if (a == "--max-ray") P.maxDistance = std::strtof(next(), nullptr);
        else if (a == "--origin-offset") P.originOffset = std::strtof(next(), nullptr);
        else if (a == "--min-hit") P.minHit = std::strtof(next(), nullptr);
        else if (a == "--min-dir-y") P.minDirY = std::strtof(next(), nullptr);
        else if (a == "--threads") threads = static_cast<unsigned>(std::atoi(next()));
        else if (a == "--help" || a == "-h") { usage(); return 0; }
        else { std::cerr << "unknown argument " << a << "\n"; usage(); return 2; }
    }
    if (positionsFile.empty() || indicesFile.empty() || samplesFile.empty() || outFile.empty()) { usage(); return 2; }
    if (P.rays < 1 || P.rays > 4096 || !(P.maxDistance > P.minHit) || P.minHit < 0 || P.originOffset < 0) {
        std::cerr << "rays must be in 1..4096, max-ray above min-hit, min-hit and origin-offset not negative\n";
        return 2;
    }

    const auto t0 = std::chrono::steady_clock::now();
    std::vector<float> positions, samples;
    std::vector<uint32_t> indices;
    if (!readAll(positionsFile, positions) || positions.size() % 3) { std::cerr << "cannot read float32 x 3 positions from " << positionsFile << "\n"; return 1; }
    if (!readAll(indicesFile, indices) || indices.size() % 3) { std::cerr << "cannot read uint32 x 3 indices from " << indicesFile << "\n"; return 1; }
    if (!readAll(samplesFile, samples) || samples.size() % 6) { std::cerr << "cannot read float32 x 6 samples from " << samplesFile << "\n"; return 1; }
    const size_t nv = positions.size() / 3;
    for (uint32_t ix : indices) if (ix >= nv) { std::cerr << "index " << ix << " is past the " << nv << " vertices\n"; return 1; }

    ScratchboxMesh mesh;
    mesh.vertices.resize(nv);
    for (size_t v = 0; v < nv; ++v) mesh.vertices[v] = Vertex(Vec3(positions[v * 3], positions[v * 3 + 1], positions[v * 3 + 2]));
    mesh.indices = std::move(indices);
    const size_t ns = samples.size() / 6;
    std::vector<Vec3> points(ns), normals(ns);
    for (size_t s = 0; s < ns; ++s) {
        points[s] = Vec3(samples[s * 6], samples[s * 6 + 1], samples[s * 6 + 2]);
        normals[s] = Vec3(samples[s * 6 + 3], samples[s * 6 + 4], samples[s * 6 + 5]).normalized();
    }
    const auto t1 = std::chrono::steady_clock::now();

    BvhTree bvh;
    // an empty mesh builds no tree and occludes nothing: every counted ray sees sky
    if (!mesh.indices.empty()) bvh.build(mesh);
    const auto t2 = std::chrono::steady_clock::now();
    const std::vector<float> v = scratchbox::bvh::skyVisibility(bvh, points, normals, P, threads);
    const auto t3 = std::chrono::steady_clock::now();

    std::ofstream out(outFile, std::ios::binary);
    if (!out.write(reinterpret_cast<const char*>(v.data()), static_cast<std::streamsize>(v.size() * sizeof(float)))) {
        std::cerr << "cannot write " << outFile << "\n";
        return 1;
    }
    out.close();
    const auto ms = [](auto a, auto b) { return std::chrono::duration<double, std::milli>(b - a).count(); };
    std::printf("{\"ok\":true,\"vertices\":%zu,\"triangles\":%zu,\"samples\":%zu,\"rays\":%d,\"ms\":{\"load\":%.1f,\"build\":%.1f,\"cast\":%.1f}}\n",
                nv, mesh.indices.size() / 3, ns, P.rays, ms(t0, t1), ms(t1, t2), ms(t2, t3));
    return 0;
}
