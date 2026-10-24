/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * scratchbox_scan_massing.hpp on scans with a known answer:
 *  (a) a plain 20 x 10 x 30 m block whose +x side is a party wall against a 40 m neighbour: the extruded block explains
 *      it once the hidden wall is known unseen, and is chosen over the loft;
 *  (b) a 6 m shaft 60 m tall under a 30 m deck: the block of the deck's plan fails, the loft is chosen, and its widest
 *      ring is the deck and its narrowest the shaft;
 *  (c) a leg leaning 10 m over 40 m beside a core: the loft keeps it as one run;
 *  (d) a stepped tower (30 m square to 20 m, 20 m square to 40 m, 10 m square to 60 m): three tiers of the right size
 *      and heights, and the tiers explain it where one block does not.
 *
 *   clang++ -std=c++20 -O1 -I include test_scan_massing.cpp -o test_scan_massing && ./test_scan_massing
 */

#include "scratchbox_scan_massing.hpp"

#include <cstdio>
#include <cstdlib>

using namespace scratchbox::scan_massing;

static int failures = 0;
#define CHECK(cond, ...) do { if (!(cond)) { std::printf("  FAIL %s:%d: ", __FILE__, __LINE__); std::printf(__VA_ARGS__); std::printf("\n"); failures++; } } while (0)

struct Soup { std::vector<Vec3> pos; std::vector<uint32_t> idx; };
static void quad(Soup& s, Vec3 a, Vec3 b, Vec3 c, Vec3 d) {
    const uint32_t v = static_cast<uint32_t>(s.pos.size());
    s.pos.insert(s.pos.end(), {a, b, c, d});
    s.idx.insert(s.idx.end(), {v, v + 1, v + 2, v, v + 2, v + 3});
}
static void box(Soup& s, float x0, float x1, float y0, float y1, float z0, float z1, bool px = true, bool bottom = true) {
    quad(s, {x0, y0, z0}, {x0, y1, z0}, {x0, y1, z1}, {x0, y0, z1});
    if (px) quad(s, {x1, y0, z0}, {x1, y0, z1}, {x1, y1, z1}, {x1, y1, z0});
    quad(s, {x0, y0, z0}, {x1, y0, z0}, {x1, y1, z0}, {x0, y1, z0});
    quad(s, {x0, y0, z1}, {x0, y1, z1}, {x1, y1, z1}, {x1, y0, z1});
    quad(s, {x0, y1, z0}, {x1, y1, z0}, {x1, y1, z1}, {x0, y1, z1});
    if (bottom) quad(s, {x0, y0, z0}, {x0, y0, z1}, {x1, y0, z1}, {x1, y0, z0});
}

static void testPartyWallBlock() {
    std::printf("[scan_massing] (a) a block beside a taller neighbour stays a block\n");
    Soup s;
    box(s, 0, 20, 0, 30, 0, 10, false, false);
    const auto scan = sampleSurface(s.pos, s.idx, 0.5);
    TopGrid neighbours;
    for (float x = 20.2f; x < 30; x += 0.5f) for (float z = -5; z <= 15; z += 0.5f) neighbours.add(Vec3(x, 40, z));
    AgreementOptions o;
    o.groundY = 0;
    o.neighbours = &neighbours;
    o.ownPlan = [](double x, double z) { return x >= 0 && x <= 20 && z >= 0 && z <= 10; };
    const auto blockMesh = extrudeBlock({{0, 0}, {20, 0}, {20, 10}, {0, 10}}, 0, 30);
    const auto blockSamples = sampleMesh(blockMesh, 0.5);
    AgreementOptions blindO; blindO.groundY = 0;
    const Agreement blind = agreement(scan, blockSamples, blindO), seen = agreement(scan, blockSamples, o);
    std::printf("  block precision blind %.3f, with the hidden wall unseen %.3f; coverage %.3f\n", blind.bandedPrecision, seen.bandedPrecision, seen.bandedCoverage);
    CHECK(seen.bandedPrecision > 0.95 && seen.bandedPrecision - blind.bandedPrecision > 0.08, "hidden wall still counted");
    CHECK(seen.bandedCoverage > 0.95, "coverage %.3f", seen.bandedCoverage);
    const auto sl = slices(scan, 0);
    const auto loft = loftSolids(loftRuns(sl, 0.5));
    const Agreement la = agreement(scan, sampleMesh(loft, 0.5), o);
    const Choice c = choose({{"block", {blockMesh.indices.size() / 3, seen}}, {"loft", {loft.indices.size() / 3, la}}});
    std::printf("  chosen: %s\n", c.why.c_str());
    CHECK(c.chosen == 0 && c.explains, "the block was not chosen");
}

static void testShaftAndDeck() {
    std::printf("[scan_massing] (b) a shaft under a wide deck gets the loft\n");
    Soup s;
    box(s, -3, 3, 0, 60, -3, 3, true, false);
    box(s, -15, 15, 60, 66, -15, 15);
    const auto scan = sampleSurface(s.pos, s.idx, 0.5);
    AgreementOptions o; o.groundY = 0;
    const auto blockMesh = extrudeBlock({{-15, -15}, {15, -15}, {15, 15}, {-15, 15}}, 0, 66);
    const Agreement ba = agreement(scan, sampleMesh(blockMesh, 0.5), o);
    const auto runs = loftRuns(slices(scan, 0), 0.5);
    const auto loft = loftSolids(runs);
    const Agreement la = agreement(scan, sampleMesh(loft, 0.5), o);
    const Choice c = choose({{"block", {12, ba}}, {"loft", {loft.indices.size() / 3, la}}});
    std::printf("  block cov %.3f prec %.3f; loft cov %.3f prec %.3f (%zu runs, %zu triangles); %s\n", ba.bandedCoverage, ba.bandedPrecision, la.bandedCoverage, la.bandedPrecision, runs.size(), loft.indices.size() / 3, c.why.c_str());
    CHECK(!c.rows[0].accepted, "the block of the deck's plan was accepted");
    CHECK(c.chosen == 1 && c.explains, "the loft was not chosen");
    double wMax = 0, wMin = 1e9;
    for (const auto& r : runs) for (const auto& ring : r.rings) {
        double x0 = 1e9, x1 = -1e9;
        for (const auto& p : ring.pts) { x0 = std::min(x0, p.x); x1 = std::max(x1, p.x); }
        wMax = std::max(wMax, x1 - x0); wMin = std::min(wMin, x1 - x0);
    }
    CHECK(wMax > 28 && wMin < 8, "ring widths %.1f .. %.1f", wMin, wMax);
}

static void testLeaningLeg() {
    std::printf("[scan_massing] (c) a leaning leg stays one run\n");
    Soup s;
    box(s, -2, 2, 0, 40, -2, 2, true, false);
    // a 1.5 m square leg leaning from x = 12 at the ground to x = 6 at 40 m, as stacked 1 m boxes
    for (int k = 0; k < 40; ++k) { const float x = 12.0f - 6.0f * k / 40.0f; box(s, x - 0.75f, x + 0.75f, static_cast<float>(k), static_cast<float>(k + 1), -0.75f, 0.75f, true, false); }
    const auto scan = sampleSurface(s.pos, s.idx, 0.25);
    const auto runs = loftRuns(slices(scan, 0), 0.5);
    size_t legRuns = 0, longest = 0;
    for (const auto& r : runs) {
        double cx = 0; for (const auto& p : r.rings.front().pts) cx += p.x; cx /= r.rings.front().pts.size();
        if (cx > 4) { legRuns++; longest = std::max(longest, static_cast<size_t>(r.y1 - r.y0)); }
    }
    std::printf("  %zu runs in all, %zu on the leg, the longest %zu m\n", runs.size(), legRuns, longest);
    CHECK(longest >= 35, "the leg broke into pieces (longest run %zu m)", longest);
}


static void testSteppedTower() {
    std::printf("[scan_massing] (d) a stepped tower comes out as its three tiers\n");
    Soup s;
    box(s, -15, 15, 0, 20, -15, 15, true, false);
    box(s, -10, 10, 20, 40, -10, 10, true, false);
    box(s, -5, 5, 40, 60, -5, 5, true, false);
    const auto scan = sampleSurface(s.pos, s.idx, 0.5);
    const auto ts = tiers(scan, 0);
    for (const auto& t : ts) std::printf("  tier %.1f..%.1f m, %.0f m2\n", t.y0, t.y1, t.areaM2);
    CHECK(ts.size() == 3, "%zu tiers", ts.size());
    if (ts.size() == 3) {
        CHECK(std::abs(ts[0].areaM2 - 900) < 90 && std::abs(ts[1].areaM2 - 400) < 50 && std::abs(ts[2].areaM2 - 100) < 20, "tier areas %.0f %.0f %.0f", ts[0].areaM2, ts[1].areaM2, ts[2].areaM2);
        CHECK(std::abs(ts[0].y1 - 20) <= 1.5 && std::abs(ts[1].y1 - 40) <= 1.5 && std::abs(ts[2].y1 - 60) <= 1.5, "tier tops %.1f %.1f %.1f", ts[0].y1, ts[1].y1, ts[2].y1);
    }
    AgreementOptions o; o.groundY = 0; o.coverageTauM = 2.5;
    const Agreement ta = agreement(scan, sampleMesh(tierSolids(ts), 0.5), o);
    const Agreement ba = agreement(scan, sampleMesh(extrudeBlock({{-15, -15}, {15, -15}, {15, 15}, {-15, 15}}, 0, 60), 0.5), o);
    std::printf("  tiers cov %.3f prec %.3f; one block cov %.3f prec %.3f\n", ta.bandedCoverage, ta.bandedPrecision, ba.bandedCoverage, ba.bandedPrecision);
    CHECK(ta.bandedCoverage > 0.95 && ta.bandedPrecision > 0.9, "the tiers do not explain the tower");
    CHECK(ba.bandedPrecision < 0.7, "one block explains a stepped tower");
}

int main() {
    testPartyWallBlock();
    testShaftAndDeck();
    testLeaningLeg();
    testSteppedTower();
    if (failures) { std::printf("[scan_massing] %d check(s) failed\n", failures); return 1; }
    std::printf("[scan_massing] all checks passed\n");
    return 0;
}
