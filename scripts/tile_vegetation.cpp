/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * CLI for the tile vegetation pipeline (scratchbox_tile_vegetation.hpp). Two subcommands:
 *
 *   strip  photo-textured tile GLB -> devegetated tile GLB (trees removed, holes closed) + crowns.json + stats JSON
 *   plant  crowns.json -> SB-Veggie trees GLB (one node per measured crown, studio clay, within a triangle budget)
 *
 * Every flag is a continuous metric quantity. Errors exit non-zero with "ERROR <code>: <message>" on stderr.
 *
 * Build:
 *   clang++ -std=c++20 -O3 -pthread -I packages/core/src/native/3d-engine/include \
 *       scripts/tile_vegetation.cpp -o build/3d-native/tile_vegetation -lz
 */

#include "scratchbox_tile_vegetation.hpp"

#include <cstdlib>
#include <cstring>
#include <fstream>
#include <iostream>
#include <map>
#include <string>

using namespace scratchbox;
using namespace scratchbox::tile_vegetation;

static void usage() {
    std::cerr <<
        "usage:\n"
        "  tile_vegetation strip --input <tile.glb> --out <devegetated.glb> --crowns <crowns.json> --stats <stats.json> [options]\n"
        "    --topdown PATH            write a top-down PNG (green canopy, yellow crown borders, red tree apexes,\n"
        "                              orange low roof vegetation, magenta crowns cut by the boundary,\n"
        "                              blue cut crowns removed with the trees they join, violet removed)\n"
        "    --topdown-points CSV      diagnostic: also mark these x,z points (tile frame, one per line) in cyan\n"
        "    --cell M (0.5) --terrain-cell M (4) --terrain-radius M (40)\n"
        "    --exg-min V (0.06) --exgr-min V (-0.2) --dark-guard V (0.06)\n"
        "    --roughness-radius M (1) --roughness-min V (0.015) --planar-angle DEG (10) --planar-offset M (0.12) --planar-area M2 (6)\n"
        "    --canopy-min-height M (2) --min-tree-height M (3) --min-crown-area M2 (4)\n"
        "    --window-base M (0.6) --window-slope V (0.11) --window-min M (1.5) --window-max M (4.5) --climb-limit M (1)\n"
        "    --support-step M (1) --support-search M (25) --footprint-dilation M (1) --drape-reach M (10) --clearance M (0.3) --support-band M (1.5)\n"
        "    --skirt-min M (0.3) --fragment-max-area M2 (300) --cap-grid M (1.5) --seam-gap M (1) --sample-spacing M (0.7) --threads N\n"
        "  tile_vegetation plant --crowns <crowns.json> --out <trees.glb> --stats <stats.json> --triangle-budget N [options]\n"
        "    --seed HEX                seed (hex, up to 16 digits) mixed with each crown id\n"
        "    --support-mesh PATH       keep only crowns whose trunk base lies on this mesh (isolate requests)\n"
        "    --support-tolerance M (0.3) --min-triangles-per-tree N (120)\n"
        "    --crown-base-ratio V (0.35) --trunk-radius-per-height V (0.016) --wood-share V (0.4) --shell-depth V (0.8)\n"
        "    --threads N\n";
}

static int fail(const std::string& code, const std::string& message) {
    std::cerr << "ERROR " << code << ": " << message << "\n";
    return code == "bad_request" ? 2 : 1;
}

static bool writeFile(const std::string& path, const void* data, size_t size) {
    std::ofstream out(path, std::ios::binary);
    if (!out) return false;
    out.write(static_cast<const char*>(data), static_cast<std::streamsize>(size));
    return static_cast<bool>(out);
}

struct Args {
    std::map<std::string, std::string> kv;
    bool has(const std::string& k) const { return kv.count(k) > 0; }
    std::string str(const std::string& k) const { auto it = kv.find(k); return it == kv.end() ? "" : it->second; }
    double num(const std::string& k, double def) const {
        auto it = kv.find(k);
        if (it == kv.end()) return def;
        char* end = nullptr;
        const double v = std::strtod(it->second.c_str(), &end);
        if (!end || *end != '\0' || !std::isfinite(v)) throw VegetationError("bad_request", "--" + k + " must be a number, got '" + it->second + "'");
        return v;
    }
};

static Args parseArgs(int argc, char** argv, int from) {
    Args a;
    for (int i = from; i < argc; ++i) {
        std::string k = argv[i];
        if (k.rfind("--", 0) != 0) throw VegetationError("bad_request", "unexpected argument '" + k + "'");
        k = k.substr(2);
        if (i + 1 >= argc) throw VegetationError("bad_request", "--" + k + " needs a value");
        a.kv[k] = argv[++i];
    }
    return a;
}

static int runStrip(const Args& a) {
    for (const char* req : {"input", "out", "crowns", "stats"}) {
        if (!a.has(req)) throw VegetationError("bad_request", std::string("strip needs --") + req);
    }
    StripParams P;
    P.cell = a.num("cell", P.cell);
    P.terrainCell = a.num("terrain-cell", P.terrainCell);
    P.terrainRadius = a.num("terrain-radius", P.terrainRadius);
    P.exgMin = a.num("exg-min", P.exgMin);
    P.exgrMin = a.num("exgr-min", P.exgrMin);
    P.darkGuard = a.num("dark-guard", P.darkGuard);
    P.roughnessRadius = a.num("roughness-radius", P.roughnessRadius);
    P.roughnessMin = a.num("roughness-min", P.roughnessMin);
    P.planarAngleDeg = a.num("planar-angle", P.planarAngleDeg);
    P.planarOffset = a.num("planar-offset", P.planarOffset);
    P.planarArea = a.num("planar-area", P.planarArea);
    P.canopyMinHeight = a.num("canopy-min-height", P.canopyMinHeight);
    P.minTreeHeight = a.num("min-tree-height", P.minTreeHeight);
    P.minCrownArea = a.num("min-crown-area", P.minCrownArea);
    P.windowBase = a.num("window-base", P.windowBase);
    P.windowSlope = a.num("window-slope", P.windowSlope);
    P.windowMin = a.num("window-min", P.windowMin);
    P.windowMax = a.num("window-max", P.windowMax);
    P.climbLimit = a.num("climb-limit", P.climbLimit);
    P.supportStep = a.num("support-step", P.supportStep);
    P.supportSearch = a.num("support-search", P.supportSearch);
    P.footprintDilation = a.num("footprint-dilation", P.footprintDilation);
    P.drapeReach = a.num("drape-reach", P.drapeReach);
    P.clearance = a.num("clearance", P.clearance);
    P.supportBand = a.num("support-band", P.supportBand);
    P.skirtMin = a.num("skirt-min", P.skirtMin);
    P.fragmentMaxArea = a.num("fragment-max-area", P.fragmentMaxArea);
    P.capGrid = a.num("cap-grid", P.capGrid);
    P.seamGap = a.num("seam-gap", P.seamGap);
    P.sampleSpacing = a.num("sample-spacing", P.sampleSpacing);
    P.threads = static_cast<int>(a.num("threads", 0));
    if (P.cell <= 0 || P.terrainCell <= 0 || P.sampleSpacing <= 0 || P.capGrid <= 0) throw VegetationError("bad_request", "cell sizes and spacings must be > 0");

    const auto glb = readFileBytes(a.str("input"));
    const bool topDown = a.has("topdown");
    StripResult r = TileVegetation::strip(glb, P, topDown);
    if (!writeFile(a.str("out"), r.devegetatedGlb.data(), r.devegetatedGlb.size())) throw VegetationError("io", "cannot write " + a.str("out"));
    const std::string crowns = crownsJson(r, P);
    if (!writeFile(a.str("crowns"), crowns.data(), crowns.size())) throw VegetationError("io", "cannot write " + a.str("crowns"));
    const std::string stats = stripStatsJson(r);
    if (!writeFile(a.str("stats"), stats.data(), stats.size())) throw VegetationError("io", "cannot write " + a.str("stats"));
    if (topDown) {
        if (a.has("topdown-points")) {
            std::ifstream pts(a.str("topdown-points"));
            if (!pts) throw VegetationError("not_found", "cannot open " + a.str("topdown-points"));
            double px, pz;
            char comma;
            auto& img = r.topDown;
            while (pts >> px >> comma >> pz) {
                const int i0 = static_cast<int>(std::floor((px - r.topDownX0) / r.topDownCell));
                const int k0 = static_cast<int>(std::floor((pz - r.topDownZ0) / r.topDownCell));
                for (int dk = -1; dk <= 1; ++dk) {
                    for (int di = -1; di <= 1; ++di) {
                        const int i = i0 + di, k = k0 + dk;
                        if (i < 0 || k < 0 || i >= img.width || k >= img.height) continue;
                        const size_t o = img.getIndex(i, k);
                        img.data[o] = 0; img.data[o + 1] = 255; img.data[o + 2] = 255;
                    }
                }
            }
        }
        const auto png = texture::encodePng(r.topDown);
        if (!writeFile(a.str("topdown"), png.data(), png.size())) throw VegetationError("io", "cannot write " + a.str("topdown"));
    }
    std::cout << stats;
    return 0;
}

static int runPlant(const Args& a) {
    for (const char* req : {"crowns", "out", "stats", "triangle-budget"}) {
        if (!a.has(req)) throw VegetationError("bad_request", std::string("plant needs --") + req);
    }
    PlantParams P;
    P.triangleBudget = a.num("triangle-budget", 0);
    P.minTrianglesPerTree = a.num("min-triangles-per-tree", P.minTrianglesPerTree);
    P.crownBaseRatio = a.num("crown-base-ratio", P.crownBaseRatio);
    P.trunkRadiusPerHeight = a.num("trunk-radius-per-height", P.trunkRadiusPerHeight);
    P.woodShare = a.num("wood-share", P.woodShare);
    P.shellDepth = a.num("shell-depth", P.shellDepth);
    P.supportTolerance = a.num("support-tolerance", P.supportTolerance);
    P.threads = static_cast<int>(a.num("threads", 0));
    if (a.has("seed")) {
        const std::string s = a.str("seed");
        if (s.empty() || s.size() > 16 || s.find_first_not_of("0123456789abcdefABCDEF") != std::string::npos) {
            throw VegetationError("bad_request", "--seed must be 1-16 hex digits");
        }
        P.seed = std::stoull(s, nullptr, 16);
    }
    if (P.crownBaseRatio < 0 || P.crownBaseRatio >= 1) throw VegetationError("bad_request", "--crown-base-ratio must be in [0, 1)");
    if (P.woodShare < 0 || P.woodShare > 1) throw VegetationError("bad_request", "--wood-share must be in [0, 1]");

    const auto bytes = readFileBytes(a.str("crowns"));
    const std::string text(bytes.begin(), bytes.end());
    const io::GlbJsonValue doc = json::parse(text);
    if (doc.type != io::GlbJsonValue::Object) throw VegetationError("bad_input", "crowns.json is not a JSON object");

    std::vector<Vec3> supportPos;
    std::vector<uint32_t> supportIdx;
    const bool withSupport = a.has("support-mesh");
    if (withSupport) {
        const auto glb = readFileBytes(a.str("support-mesh"));
        auto scene = gltf::GlbSceneReader::parse(glb.data(), glb.size());
        if (!scene.ok) throw VegetationError("bad_input", "cannot read the support mesh: " + scene.error);
        supportPos.reserve(scene.mesh.vertices.size());
        for (const auto& v : scene.mesh.vertices) supportPos.push_back(v.position);
        supportIdx = scene.mesh.indices;
    }
    PlantResult r = plant(doc, P, withSupport ? &supportPos : nullptr, withSupport ? &supportIdx : nullptr);
    const auto glb = writeTreesGlb(r, doc, P);
    if (!writeFile(a.str("out"), glb.data(), glb.size())) throw VegetationError("io", "cannot write " + a.str("out"));

    std::ostringstream s;
    size_t wood = 0, foliage = 0;
    for (const auto& t : r.trees) { wood += t.report.woodTriangles; foliage += t.report.foliageTriangles; }
    s << "{\n  \"ok\": true,\n  \"trees\": " << r.trees.size() << ",\n  \"triangles\": " << r.triangles << ",\n  \"triangleBudget\": "
      << static_cast<size_t>(P.triangleBudget) << ",\n  \"woodTriangles\": " << wood << ",\n  \"foliageTriangles\": " << foliage
      << ",\n  \"skipped\": [";
    for (size_t i = 0; i < r.skipped.size(); ++i) s << (i ? ", " : "") << "{\"crownId\": " << r.skipped[i].first << ", \"reason\": " << json::str(r.skipped[i].second) << "}";
    s << "],\n  \"inferred\": {\"crownBaseRatio\": " << json::num(P.crownBaseRatio) << ", \"trunkRadiusPerHeight\": " << json::num(P.trunkRadiusPerHeight)
      << ", \"shellDepth\": " << json::num(P.shellDepth) << "},\n  \"perTree\": [";
    for (size_t i = 0; i < r.trees.size(); ++i) {
        const auto& t = r.trees[i];
        // bounds of what was grown (measured from the meshes, not echoed from the crown)
        Vec3 lo(1e30f, 1e30f, 1e30f), hi(-1e30f, -1e30f, -1e30f);
        for (const geometry::Mesh* m : {&t.wood, &t.foliage}) {
            for (const auto& v : m->vertices) {
                lo.x = std::min(lo.x, v.x); lo.y = std::min(lo.y, v.y); lo.z = std::min(lo.z, v.z);
                hi.x = std::max(hi.x, v.x); hi.y = std::max(hi.y, v.y); hi.z = std::max(hi.z, v.z);
            }
        }
        s << (i ? ",\n    " : "\n    ") << "{\"crownId\": " << t.crownId << ", \"heightAboveSupportM\": " << json::num(t.heightAboveSupport)
          << ", \"budget\": " << t.budget << ", \"triangles\": " << (t.wood.indices.size() + t.foliage.indices.size()) / 3
          << ", \"wood\": " << t.report.woodTriangles << ", \"foliage\": " << t.report.foliageTriangles << ", \"clumps\": " << t.report.foliageClumps
          << ", \"bounds\": [[" << json::num(lo.x) << "," << json::num(lo.y) << "," << json::num(lo.z) << "],[" << json::num(hi.x) << "," << json::num(hi.y) << "," << json::num(hi.z) << "]]"
          << ", \"seed\": " << t.seed << "}";
    }
    s << "\n  ],\n  \"totalMs\": " << json::num(r.ms) << "\n}\n";
    const std::string stats = s.str();
    if (!writeFile(a.str("stats"), stats.data(), stats.size())) throw VegetationError("io", "cannot write " + a.str("stats"));
    std::cout << stats;
    return 0;
}

int main(int argc, char** argv) {
    if (argc < 2 || std::strcmp(argv[1], "--help") == 0 || std::strcmp(argv[1], "-h") == 0) {
        usage();
        return argc < 2 ? 2 : 0;
    }
    const std::string cmd = argv[1];
    try {
        const Args a = parseArgs(argc, argv, 2);
        if (cmd == "strip") return runStrip(a);
        if (cmd == "plant") return runPlant(a);
        usage();
        return fail("bad_request", "unknown subcommand '" + cmd + "'");
    } catch (const VegetationError& e) {
        return fail(e.code(), e.what());
    } catch (const std::exception& e) {
        return fail("failed", e.what());
    }
}
