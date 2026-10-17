/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

// Pipe CLI for the island unwrapper (scratchbox_uv_atlas.hpp). Reads one mesh on stdin, writes the islands on stdout;
// no files. Built and run by texture-uv.ts (packages/core/src/node/3d-engine/staged-location/texture-uv.ts).
//
// Build:  clang++ -std=c++20 -O3 -I packages/core/src/native/3d-engine/include scripts/uv_atlas.cpp -o build/3d-native/uv_atlas
//
// stdin (little endian):  'SBUV' u32 version=1, u32 V, u32 T, f32 normalToleranceDeg, f32 minIslandAreaM2,
//                         f32[3V] positions, u32[3T] indices, u32[T] group per triangle
// stdout:                 'SBUA' u32 version=1, u32 outV, u32 T, u32 I, u32 evictionRounds, u32 evicted, u32 singletons, u32 merged,
//                         u32[outV] sourceVertex, f32[2 outV] uv (metres), u32[3T] indices, u32[T] island,
//                         f32[7 I] (widthM, heightM, area3D, area2D, nx, ny, nz), u32[I] group

#include "scratchbox_uv_atlas.hpp"

#include <cstdio>
#include <iostream>
#include <vector>

template <typename T> static bool readAll(std::vector<T>& v, size_t n) {
    v.resize(n);
    return n == 0 || std::fread(v.data(), sizeof(T), n, stdin) == n;
}
template <typename T> static void writeAll(const T* p, size_t n) { if (n) std::fwrite(p, sizeof(T), n, stdout); }

int main() {
    char magic[4];
    uint32_t hdr[3];
    float prm[2];
    if (std::fread(magic, 1, 4, stdin) != 4 || std::memcmp(magic, "SBUV", 4) != 0) { std::cerr << "uv_atlas: bad magic\n"; return 2; }
    if (std::fread(hdr, 4, 3, stdin) != 3 || hdr[0] != 1) { std::cerr << "uv_atlas: bad header\n"; return 2; }
    if (std::fread(prm, 4, 2, stdin) != 2) { std::cerr << "uv_atlas: bad params\n"; return 2; }
    const uint32_t V = hdr[1], T = hdr[2];
    std::vector<float> pos;
    std::vector<uint32_t> idx, grp;
    if (!readAll(pos, size_t(V) * 3) || !readAll(idx, size_t(T) * 3) || !readAll(grp, T)) { std::cerr << "uv_atlas: truncated input\n"; return 2; }
    for (uint32_t i : idx) if (i >= V) { std::cerr << "uv_atlas: index " << i << " out of range\n"; return 2; }
    for (float f : pos) if (!std::isfinite(f)) { std::cerr << "uv_atlas: non-finite position\n"; return 2; }

    scratchbox::uv_atlas::Params params;
    params.normalToleranceDeg = prm[0];
    params.minIslandAreaM2 = prm[1];
    auto r = scratchbox::uv_atlas::buildIslands(pos.data(), V, idx.data(), T, grp.data(), params);

    std::fwrite("SBUA", 1, 4, stdout);
    const uint32_t I = static_cast<uint32_t>(r.islands.size());
    const uint32_t head[8] = {1, static_cast<uint32_t>(r.sourceVertex.size()), T, I, r.evictionRounds, r.evictedTriangles, r.forcedSingletons, r.mergedIslands};
    writeAll(head, 8);
    writeAll(r.sourceVertex.data(), r.sourceVertex.size());
    writeAll(r.uv.data(), r.uv.size());
    writeAll(r.indices.data(), r.indices.size());
    writeAll(r.triangleIsland.data(), r.triangleIsland.size());
    std::vector<float> isl(size_t(I) * 7);
    std::vector<uint32_t> ig(I);
    for (uint32_t i = 0; i < I; ++i) {
        const auto& s = r.islands[i];
        const float v[7] = {float(s.widthM), float(s.heightM), float(s.area3DM2), float(s.area2DM2), float(s.normal[0]), float(s.normal[1]), float(s.normal[2])};
        std::copy(v, v + 7, isl.begin() + size_t(i) * 7);
        ig[i] = s.group;
    }
    writeAll(isl.data(), isl.size());
    writeAll(ig.data(), ig.size());
    std::fflush(stdout);
    return 0;
}
