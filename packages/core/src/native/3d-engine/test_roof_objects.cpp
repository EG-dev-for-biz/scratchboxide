/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * scratchbox_roof_objects.hpp on a roof with a known answer: a 30 x 20 m roof at 20 m carrying a round tank (radius 2 m,
 * 5 m tall) and a 3 x 3 x 3 m box. Both are found; the tank is fitted as a solid of revolution with its radius within
 * 0.4 m, the box as its outline raised to within 0.4 m of 23 m. A photo straight down whose box is painted red but whose
 * scan is blurred one cell wider is not needed for the scan-only case; the photo case checks the bare roof's colour.
 *
 *   clang++ -std=c++20 -O1 -I include test_roof_objects.cpp -o test_roof_objects && ./test_roof_objects
 */

#include "scratchbox_roof_objects.hpp"

#include <cstdio>

using namespace scratchbox;
using namespace scratchbox::roof_objects;
using scratchbox::geometry::Vec3;

static int failures = 0;
#define CHECK(cond, ...) do { if (!(cond)) { std::printf("  FAIL %s:%d: ", __FILE__, __LINE__); std::printf(__VA_ARGS__); std::printf("\n"); failures++; } } while (0)

int main() {
    std::vector<Vec3> pos; std::vector<uint32_t> idx;
    auto quad = [&](Vec3 a, Vec3 b, Vec3 c, Vec3 d) { const uint32_t v = static_cast<uint32_t>(pos.size()); pos.insert(pos.end(), {a, b, c, d}); idx.insert(idx.end(), {v, v + 1, v + 2, v, v + 2, v + 3}); };
    // the roof plane
    quad({0, 20, 0}, {30, 20, 0}, {30, 20, 20}, {0, 20, 20});
    // a box 3 x 3 x 3 at (5..8, 5..8)
    auto box = [&](float x0, float x1, float y0, float y1, float z0, float z1) {
        quad({x0, y0, z0}, {x0, y1, z0}, {x0, y1, z1}, {x0, y0, z1}); quad({x1, y0, z0}, {x1, y0, z1}, {x1, y1, z1}, {x1, y1, z0});
        quad({x0, y0, z0}, {x1, y0, z0}, {x1, y1, z0}, {x0, y1, z0}); quad({x0, y0, z1}, {x0, y1, z1}, {x1, y1, z1}, {x1, y0, z1});
        quad({x0, y1, z0}, {x1, y1, z0}, {x1, y1, z1}, {x0, y1, z1});
    };
    box(5, 8, 20, 23, 5, 8);
    // a round tank radius 2, 20..25 m, centred (20, 10): side wall and top
    const int S = 48;
    for (int k = 0; k < S; ++k) {
        const float a = 2 * M_PI * k / S, b = 2 * M_PI * (k + 1) / S;
        const Vec3 p0(20 + 2 * std::cos(a), 20, 10 + 2 * std::sin(a)), p1(20 + 2 * std::cos(b), 20, 10 + 2 * std::sin(b));
        quad(p0, p1, Vec3(p1.x, 25, p1.z), Vec3(p0.x, 25, p0.z));
        const uint32_t v = static_cast<uint32_t>(pos.size());
        pos.insert(pos.end(), {Vec3(20, 25, 10), Vec3(p0.x, 25, p0.z), Vec3(p1.x, 25, p1.z)});
        idx.insert(idx.end(), {v, v + 1, v + 2});
    }
    const auto samples = scan_massing::sampleSurface(pos, idx, 0.2);
    const std::vector<scan_massing::P2> plan{{0, 0}, {30, 0}, {30, 20}, {0, 20}};
    const RoofReport rep = roofObjects(samples, plan, 20.0);
    std::printf("[roof_objects] %zu objects on the roof at %.1f m\n", rep.objects.size(), rep.roofY);
    const RoofObject *tank = nullptr, *boxo = nullptr;
    for (const auto& o : rep.objects) {
        std::printf("  at (%.1f, %.1f) %.1f m2, %.2f..%.2f m: %s\n", o.centre.x, o.centre.z, o.areaM2, o.baseY, o.topY, o.why.c_str());
        if (std::hypot(o.centre.x - 20, o.centre.z - 10) < 1.5) tank = &o;
        if (std::hypot(o.centre.x - 6.5, o.centre.z - 6.5) < 1.5) boxo = &o;
    }
    CHECK(rep.objects.size() == 2, "found %zu objects", rep.objects.size());
    CHECK(tank && tank->chosen == "solid of revolution", "the tank was not fitted as a solid of revolution (%s)", tank ? tank->chosen.c_str() : "not found");
    if (tank) {
        double rMax = 0;
        for (const auto& v : tank->mesh.vertices) rMax = std::max(rMax, std::hypot(v.position.x - 20.0, v.position.z - 10.0));
        CHECK(std::abs(rMax - 2.0) < 0.4 && std::abs(tank->topY - 25) < 0.4, "tank radius %.2f, top %.2f", rMax, tank->topY);
    }
    CHECK(boxo && boxo->chosen == "outline raised" && std::abs(boxo->topY - 23) < 0.4, "the box: %s, top %.2f", boxo ? boxo->chosen.c_str() : "not found", boxo ? boxo->topY : 0.0);
    if (failures) { std::printf("[roof_objects] %d check(s) failed\n", failures); return 1; }
    std::printf("[roof_objects] all checks passed\n");
    return 0;
}
