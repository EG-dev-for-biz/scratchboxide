/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * tree_form_probe: the tree grower (nature::SpaceColonizationTreeGenerator) on a synthetic crown, with its growth-form
 * parameters set from flags, printing the skeleton it grew and what the budgeted meshing drew of it as JSON. For tests
 * and for looking at one parameter at a time; a build never runs it.
 *
 *   tree_form_probe [--height M] [--radius M] [--crown-base-ratio R] [--top-exponent N] [--widest-at S] [--crown-starts-at S]
 *                   [--apical A] [--branch-angle RAD] [--scaffold N] [--leader-hold H] [--excurrence E] [--seed N] [--budget N]
 *                   [--momentum-release R] [--trunk-seek-along-stem S] [--whorl-branches N --whorl-spacing M]
 *                   [--lateral-angle-hold H] [--lateral-angle-order-gain RAD] [--shoot-droop D] [--tail-share S]
 *                   [--rosette-leaves N] [--rosette-arch A] [--leaflets-per-side N] [--leaflet-span S] [--crown-openness O]
 *                   [--nodes 1]
 *
 * The crown: a surface of revolution of the given height and radius above crown-base-ratio x height, widest at widest-at
 * of its depth, its upper profile (1 - u^n)^(1/n) (1 a cone, 2 a dome), sampled every 0.5 m, with attractors under each
 * sample down to crown-starts-at of the way from the crown base to that sample (0: to the base). Everything not given
 * a flag is the generator's default, so with no form flag the tree is the one the generator grew before it had them.
 */

#include "scratchbox_nature.hpp"

#include <cstdio>
#include <cstdlib>
#include <iostream>
#include <map>
#include <random>
#include <string>

using namespace scratchbox;

static std::string num(double v) {
    char b[40];
    std::snprintf(b, sizeof b, "%.9g", v);
    return b;
}

/** FNV-1a over the bytes of the floats it is fed: the same number for the same bits. */
struct Hash {
    uint64_t h{1469598103934665603ull};
    void add(float f) {
        unsigned char b[sizeof f];
        std::memcpy(b, &f, sizeof f);
        for (unsigned char c : b) { h ^= c; h *= 1099511628211ull; }
    }
    void add(const math::Vec3& v) { add(v.x); add(v.y); add(v.z); }
};

int main(int argc, char** argv) {
    std::map<std::string, std::string> a;
    for (int i = 1; i + 1 < argc; i += 2) a[std::string(argv[i]).substr(2)] = argv[i + 1];
    auto real = [&](const char* k, double d) { return a.count(k) ? std::strtod(a[k].c_str(), nullptr) : d; };
    const double H = real("height", 16), R = real("radius", 5), baseRatio = real("crown-base-ratio", 0.3), n = real("top-exponent", 2), widestAt = real("widest-at", 0.5);
    const double startsAt = real("crown-starts-at", 0.0);
    const double base = baseRatio * H, widest = base + widestAt * (H - base);

    nature::SpaceColonizationConfig cfg;
    const double spacing = 0.5;
    math::Vec3 lo(1e9f, 1e9f, 1e9f), hi(-1e9f, -1e9f, -1e9f);
    for (double x = -R; x <= R + 1e-9; x += spacing) {
        for (double z = -R; z <= R + 1e-9; z += spacing) {
            const double u = std::sqrt(x * x + z * z) / R;
            if (u > 1.0) continue;
            const double top = widest + (H - widest) * std::pow(std::max(0.0, 1.0 - std::pow(u, n)), 1.0 / n);
            cfg.foliageSurface.push_back(math::Vec3(static_cast<float>(x), static_cast<float>(top), static_cast<float>(z)));
            const double bottom = base + startsAt * (top - base);
            for (double y = top; y >= bottom - 1e-9; y -= spacing) cfg.customAttractors.push_back(math::Vec3(static_cast<float>(x), static_cast<float>(y), static_cast<float>(z)));
        }
    }
    for (const auto& p : cfg.customAttractors) {
        lo.x = std::min(lo.x, p.x); lo.y = std::min(lo.y, p.y); lo.z = std::min(lo.z, p.z);
        hi.x = std::max(hi.x, p.x); hi.y = std::max(hi.y, p.y); hi.z = std::max(hi.z, p.z);
    }
    // as the tile regrowth sets a crown up (scratchbox_tile_vegetation.hpp growCrownAttempt), without a species entry
    const double step = std::max(0.12, std::min(0.6, std::max(0.2, H / 40.0)));
    cfg.attractorCount = static_cast<int>(cfg.customAttractors.size());
    cfg.rootAnchor = math::Vec3(0, 0, 0);
    cfg.crownCenter = (lo + hi) * 0.5f;
    cfg.crownExtents = math::Vec3(std::max(0.5f, (hi.x - lo.x) * 0.5f), std::max(0.5f, (hi.y - lo.y) * 0.5f), std::max(0.5f, (hi.z - lo.z) * 0.5f));
    cfg.clearTrunkHeight = static_cast<float>(base);
    cfg.baseRadius = static_cast<float>(0.02 * H);
    cfg.branchStepLength = static_cast<float>(step);
    cfg.trunkLeanToward = math::Vec3(0, static_cast<float>(H), 0);
    cfg.scaffoldBranchCount = static_cast<int>(real("scaffold", 3));
    cfg.scaffoldAngleFromLeaderRad = static_cast<float>(real("branch-angle", 0.8));
    cfg.growthMomentumFactor = static_cast<float>(0.76 * real("apical", 0.45));
    cfg.leaderHold = static_cast<float>(real("leader-hold", 0));
    cfg.excurrence = static_cast<float>(real("excurrence", 0));
    cfg.leaderTopY = static_cast<float>(H);
    cfg.killRadius = static_cast<float>(std::max(1.6 * step, 0.9 * spacing));
    cfg.perceptionRadius = static_cast<float>(std::max(5.5 * step, 3.0 * spacing) + 1.25 * cfg.killRadius);
    cfg.maxIterations = static_cast<int>(std::ceil(3.0 * (H + R) / step));
    cfg.stallIterations = static_cast<int>(std::ceil(2.0 * cfg.perceptionRadius / step)) + 2;
    cfg.trunkSeeksCrown = true;
    cfg.leavesOnCrownBranches = true;
    cfg.rootFlareHeight = static_cast<float>(std::min(0.8, 0.06 * H));
    cfg.seed = static_cast<uint32_t>(real("seed", 1234));
    cfg.foliageSurfaceReach = static_cast<float>(1.25 * cfg.killRadius + spacing);
    cfg.foliageTop = static_cast<float>(H);
    cfg.triangleBudget = static_cast<float>(real("budget", 20000));
#ifndef SB_PROBE_BEFORE_FORMS
    cfg.momentumRelease = static_cast<float>(real("momentum-release", cfg.momentumRelease));
    cfg.trunkSeekAlongStem = static_cast<float>(real("trunk-seek-along-stem", cfg.trunkSeekAlongStem));
    cfg.whorlBranches = static_cast<int>(real("whorl-branches", cfg.whorlBranches));
    cfg.whorlSpacing = static_cast<float>(real("whorl-spacing", cfg.whorlSpacing));
    cfg.lateralAngleHold = static_cast<float>(real("lateral-angle-hold", cfg.lateralAngleHold));
    cfg.lateralAngleOrderGainRad = static_cast<float>(real("lateral-angle-order-gain", cfg.lateralAngleOrderGainRad));
    cfg.shootDroop = static_cast<float>(real("shoot-droop", cfg.shootDroop));
    cfg.shootDroopLength = static_cast<float>(real("shoot-droop-length", cfg.shootDroopLength));
    cfg.pendulousTailShare = static_cast<float>(real("tail-share", cfg.pendulousTailShare));
    cfg.rosetteLeaves = static_cast<int>(real("rosette-leaves", cfg.rosetteLeaves));
    cfg.rosetteArch = static_cast<float>(real("rosette-arch", cfg.rosetteArch));
    cfg.leafletsPerSide = static_cast<int>(real("leaflets-per-side", cfg.leafletsPerSide));
    cfg.leafletSpanShare = static_cast<float>(real("leaflet-span", cfg.leafletSpanShare));
    cfg.crownOpenness = static_cast<float>(real("crown-openness", cfg.crownOpenness));
#endif

    std::mt19937 rng(cfg.seed);
    nature::ColonizationReport rep;
    const std::vector<nature::ColonizationNode> nodes = nature::SpaceColonizationTreeGenerator::growSkeleton(cfg, rng, &rep);
    nature::TreeBudgetReport budget;
    const auto meshes = nature::SpaceColonizationTreeGenerator::meshGrownSkeleton(cfg, nodes, &budget);

    Hash skeleton, mesh;
    for (const auto& nd : nodes) { skeleton.add(nd.position); skeleton.add(nd.radius); }
    for (const auto& v : meshes.first.vertices) mesh.add(v);
    for (const auto& v : meshes.second.vertices) mesh.add(v);
    float foliageLowest = 1e30f;
    for (const auto& v : meshes.second.vertices) foliageLowest = std::min(foliageLowest, v.y);

    std::string out = "{\"crown\":{\"heightM\":" + num(H) + ",\"radiusM\":" + num(R) + ",\"crownBaseY\":" + num(base) + ",\"stepM\":" + num(step) + ",\"attractors\":" + std::to_string(cfg.customAttractors.size()) + "}";
    out += ",\"colonisation\":{\"stop\":\"" + rep.stop + "\",\"iterations\":" + std::to_string(rep.iterations) + ",\"attractorsReached\":" + std::to_string(rep.attractorsReached) +
           ",\"trunkNodes\":" + std::to_string(rep.trunkNodes) + ",\"leaderNodes\":" + std::to_string(rep.leaderNodes) + ",\"trunkSeekSteps\":" + std::to_string(rep.trunkSeekSteps) + "}";
    out += ",\"skeletonHash\":\"" + std::to_string(skeleton.h) + "\",\"meshHash\":\"" + std::to_string(mesh.h) + "\"";
    out += ",\"mesh\":{\"woodTriangles\":" + std::to_string(meshes.first.indices.size() / 3) + ",\"foliageTriangles\":" + std::to_string(meshes.second.indices.size() / 3) +
           ",\"foliagePieces\":" + std::to_string(budget.foliageClumps) + ",\"trianglesPerPiece\":" + std::to_string(budget.trianglesPerClump) +
           ",\"foliageLowestY\":" + (meshes.second.vertices.empty() ? std::string("null") : num(foliageLowest)) + "}";
    out += ",\"nodeCount\":" + std::to_string(nodes.size());
    if (a.count("nodes") && a["nodes"] == "1") {
        out += ",\"nodes\":[";
        for (size_t i = 0; i < nodes.size(); ++i) {
            const auto& nd = nodes[i];
            out += std::string(i ? "," : "") + "[" + std::to_string(nd.parentId) + "," + num(nd.position.x) + "," + num(nd.position.y) + "," + num(nd.position.z) + "," + std::to_string(nd.children.size());
#ifndef SB_PROBE_BEFORE_FORMS
            out += "," + std::to_string(nd.order) + "," + std::to_string(nd.rosetteLeaf) + "," + std::to_string(nd.tail);
#endif
            out += "]";
        }
        out += "]";
        if (a.count("foliage") && a["foliage"] == "1") {
            out += ",\"foliageVertices\":[";
            for (size_t i = 0; i < meshes.second.vertices.size(); ++i) {
                const auto& v = meshes.second.vertices[i];
                out += std::string(i ? "," : "") + "[" + num(v.x) + "," + num(v.y) + "," + num(v.z) + "]";
            }
            out += "]";
        }
    }
    std::cout << out << "}\n";
    return 0;
}
