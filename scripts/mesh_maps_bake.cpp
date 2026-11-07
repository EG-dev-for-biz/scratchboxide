/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

// Pipe CLI for scratchbox_mesh_maps.hpp: curvature, cavity, thickness and AO at query points on a mesh ('SBMM'). One
// request on stdin, one reply on stdout. Built and run by packages/core/src/node/3d-engine/mesh-maps.ts.
//
// Build:  clang++ -std=c++20 -O3 -I packages/core/src/native/3d-engine/include scripts/mesh_maps_bake.cpp -o build/3d-native/mesh_maps_bake -pthread
//
// SBMM (little endian): u32 version=1, T (triangles), G (grouped triangles, 0: curvature reads the soup), Q (queries),
//        flags (1 ground, 2 query groups), threads; f64[11] curvatureRadiusM, cavityRadiusM, aoRadiusM, aoSamples,
//        thicknessMaxM, thicknessSamples, thicknessConeDeg, samplesPerDisk, maxSamples, rayEpsM, groundY;
//        f32[9T] soup; f32[9G] grouped; u32[G] group ids; f32[6Q] position + normal; u32[Q] query groups (flag 2)
//   -> 'SBMR' u32 version, Q; f64 curvatureRadiusM, cavityRadiusM (as used), curvaturePoints, cavityPoints, msBuild, msBake;
//        f32[4Q] curvature (H r), cavity, thicknessM, ao

#include "scratchbox_mesh_maps.hpp"

#include <chrono>
#include <cstdio>
#include <cstring>
#include <iostream>
#include <stdexcept>
#include <string>
#include <vector>

namespace {

template <typename T> void readN(std::vector<T>& v, size_t n, const char* what) {
    v.resize(n);
    if (n && std::fread(v.data(), sizeof(T), n, stdin) != n) throw std::runtime_error(std::string("truncated input reading ") + what);
}
template <typename T> T readOne(const char* what) {
    T v;
    if (std::fread(&v, sizeof(T), 1, stdin) != 1) throw std::runtime_error(std::string("truncated input reading ") + what);
    return v;
}
void checkFinite(const std::vector<float>& a, const char* what) {
    for (float f : a) if (!std::isfinite(f)) throw std::runtime_error(std::string(what) + ": non-finite value");
}

int run() {
    using namespace scratchbox::mesh_maps;
    using clock = std::chrono::steady_clock;
    if (readOne<uint32_t>("version") != 1) throw std::runtime_error("unsupported SBMM version");
    const uint32_t T = readOne<uint32_t>("T"), G = readOne<uint32_t>("G"), Q = readOne<uint32_t>("Q"), flags = readOne<uint32_t>("flags"), threads = readOne<uint32_t>("threads");
    std::vector<double> w;
    readN(w, 11, "params");
    for (double x : w) if (!std::isfinite(x)) throw std::runtime_error("params: non-finite value");
    Params P;
    P.curvatureRadiusM = float(w[0]); P.cavityRadiusM = float(w[1]); P.aoRadiusM = float(w[2]); P.aoSamples = int(std::clamp(w[3], 0.0, 256.0));
    P.thicknessMaxM = float(w[4]); P.thicknessSamples = int(std::clamp(w[5], 0.0, 256.0)); P.thicknessConeDeg = float(w[6]);
    P.samplesPerDisk = int(std::clamp(w[7], 4.0, 4096.0)); P.maxSamples = size_t(std::clamp(w[8], 1000.0, 1e9)); P.rayEpsM = float(w[9]); P.groundY = float(w[10]);
    P.ground = (flags & 1u) != 0;
    if (!(P.curvatureRadiusM > 0) || !(P.cavityRadiusM > 0) || !(P.aoRadiusM > 0) || !(P.thicknessMaxM > 0) || !(P.rayEpsM > 0)) throw std::runtime_error("radii must be positive");
    std::vector<float> soup, grouped, points;
    std::vector<uint32_t> groups, qgroups;
    readN(soup, size_t(T) * 9, "soup");
    readN(grouped, size_t(G) * 9, "grouped");
    readN(groups, G, "groups");
    readN(points, size_t(Q) * 6, "queries");
    if (flags & 2u) readN(qgroups, Q, "query groups");
    checkFinite(soup, "soup"); checkFinite(grouped, "grouped"); checkFinite(points, "queries");

    auto t0 = clock::now();
    MeshMaps maps;
    maps.build(soup, grouped, groups, P);
    const double msBuild = std::chrono::duration<double, std::milli>(clock::now() - t0).count();
    t0 = clock::now();
    const std::vector<Sample> s = maps.bakePoints(points, qgroups, threads);
    const double msBake = std::chrono::duration<double, std::milli>(clock::now() - t0).count();

    std::fwrite("SBMR", 1, 4, stdout);
    const uint32_t head[2] = {1, Q};
    std::fwrite(head, 4, 2, stdout);
    const double info[6] = {maps.curvatureRadius(), maps.cavityRadius(), double(maps.curvaturePoints()), double(maps.cavityPoints()), msBuild, msBake};
    std::fwrite(info, 8, 6, stdout);
    std::vector<float> outv(size_t(Q) * 4);
    for (size_t i = 0; i < Q; ++i) { outv[i * 4] = s[i].curvature; outv[i * 4 + 1] = s[i].cavity; outv[i * 4 + 2] = s[i].thicknessM; outv[i * 4 + 3] = s[i].ao; }
    if (Q) std::fwrite(outv.data(), 4, outv.size(), stdout);
    std::fflush(stdout);
    return 0;
}

}  // namespace

int main() {
    try {
        char magic[4];
        if (std::fread(magic, 1, 4, stdin) != 4) throw std::runtime_error("no request");
        if (std::memcmp(magic, "SBMM", 4) != 0) throw std::runtime_error("unknown request magic");
        return run();
    } catch (const std::exception& e) {
        std::cerr << "mesh_maps_bake: " << e.what() << "\n";
        return 2;
    }
}
