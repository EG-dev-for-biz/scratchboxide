/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/


// Build:
//   clang++ -std=c++20 -O3 -I packages/core/src/native/3d-engine/include scripts/clay_planarity_metric.cpp \
//       -o build/3d-native/clay_planarity_metric -lz
// Run:
//   build/3d-native/clay_planarity_metric <clay.glb> [R metres, default 1]
//
// Planarity metric for a clay GLB: per face, the angle between its normal and the area-weighted mean normal of
// same-orientation faces (within 35 deg) whose centroids lie within R m. Reported area-weighted for walls
// (|ny| < 0.25) and elevated level surfaces (ny > 0.95, 3 m above the 10th-percentile height).
#include "scratchbox_gltf_scene.hpp"
#include <algorithm>
#include <cmath>
#include <cstdio>
#include <unordered_map>
#include <vector>

struct F { float cx, cy, cz, nx, ny, nz, a; };

int main(int argc, char** argv) {
    if (argc < 2) { std::fprintf(stderr, "usage: clay_planarity_metric <glb> [R=1.0]\n"); return 2; }
    const double R = argc > 2 ? std::atof(argv[2]) : 1.0;
    auto scene = scratchbox::gltf::GlbSceneReader::readFile(argv[1]);
    if (!scene.ok) { std::fprintf(stderr, "%s\n", scene.error.c_str()); return 1; }
    const auto& m = scene.mesh;
    std::vector<F> f;
    f.reserve(m.indices.size() / 3);
    for (size_t t = 0; t + 2 < m.indices.size(); t += 3) {
        const auto& p0 = m.vertices[m.indices[t]].position;
        const auto& p1 = m.vertices[m.indices[t + 1]].position;
        const auto& p2 = m.vertices[m.indices[t + 2]].position;
        double ux = p1.x - p0.x, uy = p1.y - p0.y, uz = p1.z - p0.z, vx = p2.x - p0.x, vy = p2.y - p0.y, vz = p2.z - p0.z;
        double nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx, l = std::sqrt(nx * nx + ny * ny + nz * nz);
        if (l < 1e-9) continue;
        f.push_back({float((p0.x + p1.x + p2.x) / 3), float((p0.y + p1.y + p2.y) / 3), float((p0.z + p1.z + p2.z) / 3),
                     float(nx / l), float(ny / l), float(nz / l), float(l / 2)});
    }
    std::vector<float> ys;
    for (auto& x : f) ys.push_back(x.cy);
    std::nth_element(ys.begin(), ys.begin() + ys.size() / 10, ys.end());
    const float groundY = ys[ys.size() / 10];
    auto key = [&](int i, int j, int k) { return (int64_t(i) * 73856093) ^ (int64_t(j) * 19349663) ^ (int64_t(k) * 83492791); };
    std::unordered_map<int64_t, std::vector<uint32_t>> grid;
    for (uint32_t i = 0; i < f.size(); ++i)
        grid[key(int(std::floor(f[i].cx / R)), int(std::floor(f[i].cy / R)), int(std::floor(f[i].cz / R)))].push_back(i);
    const double cosAgree = std::cos(35.0 * M_PI / 180.0);
    struct Acc { double area = 0, dev = 0, under2 = 0, under5 = 0; } wall, roof;
    for (uint32_t i = 0; i < f.size(); ++i) {
        const F& a = f[i];
        const bool isWall = std::fabs(a.ny) < 0.25f, isRoof = a.ny > 0.95f && a.cy > groundY + 3.0f;
        if (!isWall && !isRoof) continue;
        int ci = int(std::floor(a.cx / R)), cj = int(std::floor(a.cy / R)), ck = int(std::floor(a.cz / R));
        double sx = 0, sy = 0, sz = 0;
        for (int di = -1; di <= 1; ++di) for (int dj = -1; dj <= 1; ++dj) for (int dk = -1; dk <= 1; ++dk) {
            auto it = grid.find(key(ci + di, cj + dj, ck + dk));
            if (it == grid.end()) continue;
            for (uint32_t j : it->second) {
                const F& b = f[j];
                double dx = b.cx - a.cx, dy = b.cy - a.cy, dz = b.cz - a.cz;
                if (dx * dx + dy * dy + dz * dz > R * R) continue;
                if (a.nx * b.nx + a.ny * b.ny + a.nz * b.nz < cosAgree) continue;
                sx += b.nx * b.a; sy += b.ny * b.a; sz += b.nz * b.a;
            }
        }
        double l = std::sqrt(sx * sx + sy * sy + sz * sz);
        if (l < 1e-12) continue;
        double d = std::acos(std::clamp((a.nx * sx + a.ny * sy + a.nz * sz) / l, -1.0, 1.0)) * 180.0 / M_PI;
        Acc& acc = isWall ? wall : roof;
        acc.area += a.a; acc.dev += a.a * d;
        if (d < 2) acc.under2 += a.a;
        if (d < 5) acc.under5 += a.a;
    }
    std::printf("{\"faces\": %zu, \"wallArea\": %.0f, \"wallDevDeg\": %.3f, \"wallUnder2\": %.4f, \"wallUnder5\": %.4f, "
                "\"roofArea\": %.0f, \"roofDevDeg\": %.3f, \"roofUnder2\": %.4f, \"roofUnder5\": %.4f}\n",
                f.size(), wall.area, wall.dev / wall.area, wall.under2 / wall.area, wall.under5 / wall.area,
                roof.area, roof.dev / roof.area, roof.under2 / roof.area, roof.under5 / roof.area);
}
