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
//   build/3d-native/clay_planarity_metric <clay.glb> [R metres, default 1] [footprints.txt]
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
                "\"roofArea\": %.0f, \"roofDevDeg\": %.3f, \"roofUnder2\": %.4f, \"roofUnder5\": %.4f",
                f.size(), wall.area, wall.dev / wall.area, wall.under2 / wall.area, wall.under5 / wall.area,
                roof.area, roof.dev / roof.area, roof.under2 / roof.area, roof.under5 / roof.area);
    // facade straightness (optional footprints file, one ring per line: x z x z ...): per footprint edge of at least 4 m,
    // the wall faces facing along the edge's normal (within 30 deg) within 2 m of its line and beside it; one vertical plane
    // is fitted to those faces themselves (area-weighted, trimmed at 1 m), so the footprint only selects the facade and
    // never sets the reference. Reported: area-weighted rms distance of the faces' centroids from their plane, and the
    // area share within 5 cm.
    if (argc > 3) {
        std::FILE* fp = std::fopen(argv[3], "r");
        if (!fp) { std::printf("}\n"); std::fprintf(stderr, "cannot read %s\n", argv[3]); return 1; }
        std::vector<std::vector<std::pair<double, double>>> rings;
        char line[1 << 16];
        while (std::fgets(line, sizeof line, fp)) {
            std::vector<double> v;
            char* c = line;
            char* end = nullptr;
            for (double d = std::strtod(c, &end); end != c; d = std::strtod(c, &end)) { v.push_back(d); c = end; }
            if (v.size() < 6 || v.size() % 2) continue;
            std::vector<std::pair<double, double>> r;
            for (size_t k = 0; k + 1 < v.size(); k += 2) r.emplace_back(v[k], v[k + 1]);
            rings.push_back(std::move(r));
        }
        std::fclose(fp);
        const double cos30 = std::cos(30.0 * M_PI / 180.0);
        double sumA = 0, sumR2 = 0, sumIn = 0;
        int edges = 0;
        for (const auto& r : rings)
            for (size_t i = 0; i < r.size(); ++i) {
                const auto& a = r[i];
                const auto& b = r[(i + 1) % r.size()];
                const double dx = b.first - a.first, dz = b.second - a.second, len = std::sqrt(dx * dx + dz * dz);
                if (len < 4) continue;
                const double ux = dx / len, uz = dz / len, nx = -uz, nz = ux;
                std::vector<uint32_t> sel;
                const int ci0 = int(std::floor((std::min(a.first, b.first) - 2) / R)), ci1 = int(std::floor((std::max(a.first, b.first) + 2) / R));
                const int ck0 = int(std::floor((std::min(a.second, b.second) - 2) / R)), ck1 = int(std::floor((std::max(a.second, b.second) + 2) / R));
                if ((int64_t(ci1 - ci0 + 1) * (ck1 - ck0 + 1)) > 4000000) continue;
                for (uint32_t q = 0; q < f.size(); ++q) {
                    const F& t = f[q];
                    if (std::fabs(t.ny) >= 0.25f || std::fabs(t.nx * nx + t.nz * nz) < cos30) continue;
                    const double px = t.cx - a.first, pz = t.cz - a.second, s = px * ux + pz * uz, o = px * nx + pz * nz;
                    if (s < 0 || s > len || std::fabs(o) > 2.0) continue;
                    sel.push_back(q);
                }
                if (sel.size() < 10) continue;
                // vertical plane through the faces: direction from their area-weighted normals, offset trimmed median-ish mean
                double mx = 0, mz = 0;
                for (uint32_t q : sel) { const double sg = f[q].nx * nx + f[q].nz * nz >= 0 ? 1 : -1; mx += sg * f[q].nx * f[q].a; mz += sg * f[q].nz * f[q].a; }
                const double ml = std::sqrt(mx * mx + mz * mz);
                if (ml < 1e-9) continue;
                mx /= ml; mz /= ml;
                double off = 0, w = 0;
                for (uint32_t q : sel) { off += (f[q].cx * mx + f[q].cz * mz) * f[q].a; w += f[q].a; }
                off /= w;
                for (int it = 0; it < 3; ++it) {
                    double o2 = 0, w2 = 0;
                    for (uint32_t q : sel) { const double rr = f[q].cx * mx + f[q].cz * mz - off; if (std::fabs(rr) <= 1.0) { o2 += (off + rr) * f[q].a; w2 += f[q].a; } }
                    if (w2 > 0) off = o2 / w2;
                }
                for (uint32_t q : sel) {
                    const double rr = f[q].cx * mx + f[q].cz * mz - off;
                    sumA += f[q].a; sumR2 += f[q].a * rr * rr;
                    if (std::fabs(rr) <= 0.05) sumIn += f[q].a;
                }
                ++edges;
            }
        std::printf(", \"facadeEdges\": %d, \"facadeArea\": %.0f, \"facadeRms_m\": %.4f, \"facadeWithin5cm\": %.4f", edges, sumA,
                    sumA > 0 ? std::sqrt(sumR2 / sumA) : 0.0, sumA > 0 ? sumIn / sumA : 0.0);
    }
    std::printf("}\n");
}
