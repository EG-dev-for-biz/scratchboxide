/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

// Pipe CLI for the twin's island unwrapper: the chart stage of scratchbox_uv_rewrap.hpp (grown charts flattened by LSCM,
// ABF++ and SLIM), reported as islands. Reads one mesh on stdin, writes the islands on stdout;
// no files. Built and run by texture-uv.ts (packages/core/src/node/3d-engine/staged-location/texture-uv.ts).
//
// Build:  clang++ -std=c++20 -O3 -I packages/core/src/native/3d-engine/include scripts/uv_atlas.cpp -o build/3d-native/uv_atlas
//
// stdin (little endian):  'SBUV' u32 version=2, u32 V, u32 T, f32 normalToleranceDeg (where splits start),
//                         f32 minIslandAreaM2, f32[3V] positions, u32[3T] indices, u32[T] group per triangle
// stdout:                 'SBUA' u32 version=1, u32 outV, u32 T, u32 I, u32 evictionRounds, u32 evicted, u32 singletons, u32 merged,
//                         u32[outV] sourceVertex, f32[2 outV] uv (metres), u32[3T] indices, u32[T] island,
//                         f32[7 I] (widthM, heightM, area3D, area2D, nx, ny, nz), u32[I] group

#include "scratchbox_uv_atlas.hpp"
#include "scratchbox_uv_rewrap.hpp"

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
    if (std::fread(hdr, 4, 3, stdin) != 3 || hdr[0] != 2) { std::cerr << "uv_atlas: bad header\n"; return 2; }
    if (std::fread(prm, 4, 2, stdin) != 2) { std::cerr << "uv_atlas: bad params\n"; return 2; }
    const uint32_t V = hdr[1], T = hdr[2];
    std::vector<float> pos;
    std::vector<uint32_t> idx, grp;
    if (!readAll(pos, size_t(V) * 3) || !readAll(idx, size_t(T) * 3) || !readAll(grp, T)) { std::cerr << "uv_atlas: truncated input\n"; return 2; }
    for (uint32_t i : idx) if (i >= V) { std::cerr << "uv_atlas: index " << i << " out of range\n"; return 2; }
    for (float f : pos) if (!std::isfinite(f)) { std::cerr << "uv_atlas: non-finite position\n"; return 2; }

    scratchbox::uv_atlas::Result r;
    {
        // the unwrap's charts, reported as islands (local metres, origin at the min corner)
        namespace rw = scratchbox::uv_rewrap;
        rw::UnwrapParams up;
        up.chartNormalToleranceDeg = prm[0];
        up.minIslandAreaM2 = prm[1];
        rw::UnwrapResult stats;
        auto set = rw::unwrapCharts(pos.data(), V, idx.data(), T, grp.data(), up, stats);
        r.indices.resize(size_t(T) * 3);
        r.triangleIsland.resize(T);
        r.islands.resize(set.tris.size());
        std::unordered_map<uint64_t, uint32_t> outVertex;
        for (size_t c = 0; c < set.tris.size(); ++c) {
            auto& isl = r.islands[c];
            isl.widthM = set.reports[c].widthM; isl.heightM = set.reports[c].heightM;
            isl.area3DM2 = set.reports[c].distortion.area3D;
            std::array<double, 3> n{0, 0, 0};
            for (size_t k = 0; k < set.tris[c].size(); ++k) {
                const uint32_t t = set.tris[c][k];
                r.triangleIsland[t] = static_cast<uint32_t>(c);
                isl.group = grp[t];
                const float* a = &pos[idx[t * 3] * 3]; const float* b = &pos[idx[t * 3 + 1] * 3]; const float* cc = &pos[idx[t * 3 + 2] * 3];
                const double e1[3] = {b[0] - a[0], b[1] - a[1], b[2] - a[2]}, e2[3] = {cc[0] - a[0], cc[1] - a[1], cc[2] - a[2]};
                n[0] += e1[1] * e2[2] - e1[2] * e2[1]; n[1] += e1[2] * e2[0] - e1[0] * e2[2]; n[2] += e1[0] * e2[1] - e1[1] * e2[0];
                const double* q = &set.cornerUv[c][k * 6];
                isl.area2DM2 += 0.5 * std::fabs((q[2] - q[0]) * (q[5] - q[1]) - (q[3] - q[1]) * (q[4] - q[0]));
                for (int j = 0; j < 3; ++j) {
                    const uint32_t v = idx[t * 3 + j];
                    const uint64_t key = (uint64_t(v) << 32) | uint32_t(c);
                    auto it = outVertex.find(key);
                    if (it == outVertex.end()) {
                        it = outVertex.emplace(key, static_cast<uint32_t>(r.sourceVertex.size())).first;
                        r.sourceVertex.push_back(v);
                        r.uv.push_back(static_cast<float>(q[j * 2]));
                        r.uv.push_back(static_cast<float>(q[j * 2 + 1]));
                    }
                    r.indices[size_t(t) * 3 + j] = it->second;
                }
            }
            const double l = std::sqrt(n[0] * n[0] + n[1] * n[1] + n[2] * n[2]);
            isl.normal = l > 0 ? std::array<double, 3>{n[0] / l, n[1] / l, n[2] / l} : std::array<double, 3>{0, 1, 0};
        }
        (void)stats;
    }

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
