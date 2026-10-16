/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * CLI for the tile vegetation pipeline (scratchbox_tile_vegetation.hpp). Three subcommands:
 *
 *   strip  photo-textured tile GLB -> devegetated tile GLB (trees removed, holes closed) + crowns.json + stats JSON.
 *          Every tree crown is regrown first (with --seed and the growth ratios); one the regrown tree does not fill is
 *          kept as scanned (status not_regrowable, with the reason) instead of being removed.
 *   plant  crowns.json -> SB-Veggie trees GLB (one node per measured crown, studio clay, with its growth order in
 *          `_REVEAL` and staged-build node extras; LINES rings over crowns kept as scanned; KHR_mesh_quantization unless
 *          --quantize 0), within the caller's
 *          --triangle-budget, or sized from the crowns under --scene-triangle-cap. Every tree's delivered leaf masses are
 *          measured against its crown; one that does not fill it within its budget is reported (shortOfCrown), and with
 *          --ground-mesh every trunk base is measured against the model the trees are mounted on (offGround).
 *
 *   canopy photo-textured tile GLB -> the cells strip's own classifier calls canopy (scratchbox.canopy-mask/1 JSON), with
 *          no regrowth or removal: the same classifier, so a probe's idea of "tree" matches what strip later removes.
 *
 * Every flag is a continuous metric quantity. Errors exit non-zero with "ERROR <code>: <message>" on stderr.
 *
 * Build:
 *   clang++ -std=c++20 -O3 -pthread -I packages/core/src/native/3d-engine/include \
 *       scripts/tile_vegetation.cpp -o build/3d-native/tile_vegetation -lz
 */

#include "scratchbox_tile_vegetation.hpp"

#include <array>
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
        "    --support-step M (1) --support-search M (25) --max-crown-below-support V (0.1) --ground-terrain-band M (2)\n"
        "    --min-support-evidence V (0.2: share of the footprint's vertical lines that must show a surface for a trunk to stand on it)\n"
        "    --ground-tolerance M (0.5: a trunk base further than this from the ground rebuilt under its stem is re-stood or kept)\n"
        "    --ground-passes N (6: removal passes at most while trees are kept as scanned)\n"
        "    --footprint-dilation M (1) --drape-reach M (10) --clearance M (0.3) --support-band M (1.5)\n"
        "    --skirt-min M (0.3) --fragment-max-area M2 (300) --cap-grid M (1.5) --seam-gap M (1) --sample-spacing M (0.7) --threads N\n"
        "    regrowth (white apex: a tree the regrown tree does not fill, kept as scanned):\n"
        "    --seed HEX (0) --crown-base-ratio V (0.35) --trunk-radius-per-height V (0.016) --shell-depth V (0.8) --min-surface-reached V (0.9)\n"
        "    --removed-out PATH        also write what the removal took, as scanned, one node per crown (put back when the\n"
        "                              tree stage fails)\n"
        "    --roi-json PATH           a scratchbox.strip-roi/1 polygon: trees whose stem lies outside it are neither regrown nor\n"
        "                              removed (status outside_roi, kept as scanned)\n"
        "  tile_vegetation canopy --tile <tile.glb> --out <mask.json> [--cell M (0.5)] [strip classifier options]\n"
        "    the cells strip's own classifier calls canopy, as a scratchbox.canopy-mask/1 run-length mask; nothing is regrown or removed\n"
        "  tile_vegetation plant --crowns <crowns.json> --out <trees.glb> --stats <stats.json> (--triangle-budget N | --scene-triangle-cap N) [options]\n"
        "    --triangle-budget N       total triangles all trees may use (the caller's own budget)\n"
        "    --scene-triangle-cap N    no budget given: each tree gets a target from its crown, all within this cap\n"
        "    --seed HEX                seed (hex, up to 16 digits) mixed with each crown id\n"
        "    --support-mesh PATH       keep only crowns whose trunk base lies on this mesh (isolate requests)\n"
        "    --ground-mesh PATH        measure every trunk base against this mesh (the model the trees are mounted on)\n"
        "    --support-tolerance M (0.3) --ground-tolerance M (0.5) --min-triangles-per-tree N (120) --triangles-per-crown-m2 V (4) --wood-share V (0.4)\n"
        "    --quantize 0|1 (1: KHR_mesh_quantization, positions within --max-quantization-error M (0.01) measured on the file)\n"
        "    --stage-key KEY           the staged build's stage key for the root extras (the caller's cache key)\n"
        "    --reveal 0|1 (1: each tree's growth order on its vertices as _REVEAL; 0: the same meshes without it)\n"
        "    --crown-base-ratio V --trunk-radius-per-height V --shell-depth V --min-surface-reached V\n"
        "                              (default: what crowns.json recorded as its growth, else 0.35, 0.016, 0.8, 0.9;\n"
        "                              a value other than the recorded one is refused)\n"
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

static uint64_t parseSeed(const Args& a) {
    if (!a.has("seed")) return 0;
    const std::string s = a.str("seed");
    if (s.empty() || s.size() > 16 || s.find_first_not_of("0123456789abcdefABCDEF") != std::string::npos) {
        throw VegetationError("bad_request", "--seed must be 1-16 hex digits");
    }
    return std::stoull(s, nullptr, 16);
}

/** Growth ratios from flags over `G`; each must be a share in its range. */
static void readGrowthFlags(const Args& a, GrowthParams& G) {
    G.crownBaseRatio = a.num("crown-base-ratio", G.crownBaseRatio);
    G.trunkRadiusPerHeight = a.num("trunk-radius-per-height", G.trunkRadiusPerHeight);
    G.shellDepth = a.num("shell-depth", G.shellDepth);
    G.minSurfaceReached = a.num("min-surface-reached", G.minSurfaceReached);
    G.crownBaseSpread = a.num("crown-base-spread", G.crownBaseSpread);
    G.morphology.branchAngleSpreadRad = static_cast<float>(a.num("branch-angle-spread", G.morphology.branchAngleSpreadRad));
    G.morphology.branchAngleMeanRad = static_cast<float>(a.num("branch-angle", G.morphology.branchAngleMeanRad));
    G.morphology.apicalDominance = static_cast<float>(a.num("apical-dominance", G.morphology.apicalDominance));
    G.morphology.internodeLengthM = static_cast<float>(a.num("internode", G.morphology.internodeLengthM));
    G.morphology.leafDistributionExponent = static_cast<float>(a.num("leaf-distribution", G.morphology.leafDistributionExponent));
    G.morphology.divergenceAngleRad = static_cast<float>(a.num("divergence-angle", G.morphology.divergenceAngleRad));
    G.morphology.blade.widthRatio = static_cast<float>(a.num("blade-width-ratio", G.morphology.blade.widthRatio));
    G.morphology.blade.outlineA = static_cast<float>(a.num("blade-outline-a", G.morphology.blade.outlineA));
    G.morphology.blade.outlineB = static_cast<float>(a.num("blade-outline-b", G.morphology.blade.outlineB));
    G.morphology.blade.lobeCount = static_cast<float>(a.num("blade-lobes", G.morphology.blade.lobeCount));
    G.morphology.blade.lobeDepth = static_cast<float>(a.num("blade-lobe-depth", G.morphology.blade.lobeDepth));
    G.morphology.blade.serrationCount = static_cast<float>(a.num("blade-serrations", G.morphology.blade.serrationCount));
    G.morphology.blade.serrationDepth = static_cast<float>(a.num("blade-serration-depth", G.morphology.blade.serrationDepth));
    G.trunkLeanShare = a.num("trunk-lean", G.trunkLeanShare);
    if (G.crownBaseRatio < 0 || G.crownBaseRatio >= 1) throw VegetationError("bad_request", "--crown-base-ratio must be in [0, 1)");
    if (!(G.trunkRadiusPerHeight > 0)) throw VegetationError("bad_request", "--trunk-radius-per-height must be > 0");
    if (G.shellDepth < 0 || G.shellDepth > 1) throw VegetationError("bad_request", "--shell-depth must be in [0, 1]");
    if (G.minSurfaceReached < 0 || G.minSurfaceReached > 1) throw VegetationError("bad_request", "--min-surface-reached must be in [0, 1]");
    if (G.crownBaseSpread < 0 || G.crownBaseSpread > 0.3) throw VegetationError("bad_request", "--crown-base-spread must be in [0, 0.3]");
    if (G.morphology.branchAngleSpreadRad < 0 || G.morphology.branchAngleSpreadRad > 0.6) throw VegetationError("bad_request", "--branch-angle-spread must be in [0, 0.6] radians");
    if (G.trunkLeanShare < 0 || G.trunkLeanShare > 1) throw VegetationError("bad_request", "--trunk-lean must be in [0, 1]");
}

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

/** A StripRoi file ({"schema":"scratchbox.strip-roi/1","polygon":[[x, z], ...]}, tile frame metres). */
static std::vector<std::array<double, 2>> readRoi(const std::string& path) {
    const auto bytes = readFileBytes(path);
    const io::GlbJsonValue doc = json::parse(std::string(bytes.begin(), bytes.end()));
    if (doc.type != io::GlbJsonValue::Object || doc["schema"].asString() != "scratchbox.strip-roi/1") throw VegetationError("bad_request", "--roi-json must hold a scratchbox.strip-roi/1 object");
    const auto& poly = doc["polygon"];
    if (poly.type != io::GlbJsonValue::Array || poly.arr.size() < 3) throw VegetationError("bad_request", "the region of interest needs a polygon of at least 3 points");
    std::vector<std::array<double, 2>> out;
    for (const auto& p : poly.arr) {
        if (p.type != io::GlbJsonValue::Array || p.arr.size() != 2 || p[0].type != io::GlbJsonValue::Number || p[1].type != io::GlbJsonValue::Number ||
            !std::isfinite(p[0].num) || !std::isfinite(p[1].num)) {
            throw VegetationError("bad_request", "every region-of-interest point must be [x, z] in metres");
        }
        out.push_back({p[0].num, p[1].num});
    }
    return out;
}

static StripParams readStripParams(const Args& a);

static StripParams readStripParams(const Args& a) {
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
    P.maxCrownBelowSupport = a.num("max-crown-below-support", P.maxCrownBelowSupport);
    P.groundTerrainBand = a.num("ground-terrain-band", P.groundTerrainBand);
    if (P.maxCrownBelowSupport < 0 || P.maxCrownBelowSupport > 1) throw VegetationError("bad_request", "--max-crown-below-support must be in [0, 1]");
    P.minSupportEvidence = a.num("min-support-evidence", P.minSupportEvidence);
    if (P.minSupportEvidence < 0 || P.minSupportEvidence > 1) throw VegetationError("bad_request", "--min-support-evidence must be in [0, 1]");
    P.groundTolerance = a.num("ground-tolerance", P.groundTolerance);
    if (!(P.groundTolerance >= 0)) throw VegetationError("bad_request", "--ground-tolerance must be >= 0");
    P.groundPasses = static_cast<int>(a.num("ground-passes", P.groundPasses));
    if (P.groundPasses < 1 || P.groundPasses > 32) throw VegetationError("bad_request", "--ground-passes must be in [1, 32]");
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
    readGrowthFlags(a, P.growth);
    P.growth.seed = parseSeed(a);
    if (P.cell <= 0 || P.terrainCell <= 0 || P.sampleSpacing <= 0 || P.capGrid <= 0) throw VegetationError("bad_request", "cell sizes and spacings must be > 0");

    if (a.has("roi-json")) P.roi = readRoi(a.str("roi-json"));
    return P;
}

static int runStrip(const Args& a) {
    for (const char* req : {"input", "out", "crowns", "stats"}) {
        if (!a.has(req)) throw VegetationError("bad_request", std::string("strip needs --") + req);
    }
    const StripParams P = readStripParams(a);

    const auto glb = readFileBytes(a.str("input"));
    const bool topDown = a.has("topdown");
    StripResult r = TileVegetation::strip(glb, P, topDown);
    if (!writeFile(a.str("out"), r.devegetatedGlb.data(), r.devegetatedGlb.size())) throw VegetationError("io", "cannot write " + a.str("out"));
    if (a.has("removed-out") && !writeFile(a.str("removed-out"), r.removedGlb.data(), r.removedGlb.size())) throw VegetationError("io", "cannot write " + a.str("removed-out"));
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

static int runCanopy(const Args& a) {
    for (const char* req : {"tile", "out"}) {
        if (!a.has(req)) throw VegetationError("bad_request", std::string("canopy needs --") + req);
    }
    StripParams P = readStripParams(a);
    if (a.has("cell") && !(P.cell > 0)) throw VegetationError("bad_request", "--cell must be > 0");
    const auto glb = readFileBytes(a.str("tile"));
    const CanopyMaskResult m = TileVegetation::canopyMask(glb, P);
    const std::string text = canopyMaskJson(m);
    if (!writeFile(a.str("out"), text.data(), text.size())) throw VegetationError("io", "cannot write " + a.str("out"));
    std::cout << "{\"ok\":true,\"canopyCells\":" << m.canopyCells << ",\"nx\":" << m.nx << ",\"nz\":" << m.nz << ",\"ms\":" << json::num(m.ms) << "}\n";
    return 0;
}

static int runPlant(const Args& a) {
    for (const char* req : {"crowns", "out", "stats"}) {
        if (!a.has(req)) throw VegetationError("bad_request", std::string("plant needs --") + req);
    }
    if (a.has("triangle-budget") == a.has("scene-triangle-cap")) throw VegetationError("bad_request", "plant needs exactly one of --triangle-budget and --scene-triangle-cap");
    PlantParams P;
    P.triangleBudget = a.num("triangle-budget", 0);
    P.sceneTriangleCap = a.num("scene-triangle-cap", 0);
    if (a.has("triangle-budget") && !(P.triangleBudget > 0)) throw VegetationError("bad_request", "--triangle-budget must be > 0");
    if (a.has("scene-triangle-cap") && !(P.sceneTriangleCap > 0)) throw VegetationError("bad_request", "--scene-triangle-cap must be > 0");
    P.minTrianglesPerTree = a.num("min-triangles-per-tree", P.minTrianglesPerTree);
    P.trianglesPerCrownM2 = a.num("triangles-per-crown-m2", P.trianglesPerCrownM2);
    P.woodShare = a.num("wood-share", P.woodShare);
    P.supportTolerance = a.num("support-tolerance", P.supportTolerance);
    P.groundTolerance = a.num("ground-tolerance", P.groundTolerance);
    if (!(P.groundTolerance >= 0)) throw VegetationError("bad_request", "--ground-tolerance must be >= 0");
    P.threads = static_cast<int>(a.num("threads", 0));
    if (a.has("quantize")) {
        const std::string q = a.str("quantize");
        if (q != "0" && q != "1") throw VegetationError("bad_request", "--quantize must be 0 or 1");
        P.quantize = q == "1";
    }
    P.maxQuantizationErrorM = a.num("max-quantization-error", P.maxQuantizationErrorM);
    if (!(P.maxQuantizationErrorM > 0)) throw VegetationError("bad_request", "--max-quantization-error must be > 0");
    P.stageKey = a.str("stage-key");
    if (a.has("reveal")) {
        const std::string r = a.str("reveal");
        if (r != "0" && r != "1") throw VegetationError("bad_request", "--reveal must be 0 or 1");
        P.reveal = r == "1";
    }
    if (a.has("lod")) {
        const std::string l = a.str("lod");
        if (l != "0" && l != "1") throw VegetationError("bad_request", "--lod must be 0 or 1");
        P.lod = l == "1";
    }
    P.psiSeason = a.num("psi-season", P.psiSeason);
    if (P.psiSeason < 0 || P.psiSeason > 1) throw VegetationError("bad_request", "--psi-season must be in [0, 1]");
    P.treeLod.leafSizeRatioToCrownHeight = a.num("leaf-size-ratio", P.treeLod.leafSizeRatioToCrownHeight);
    P.treeLod.leafMinM = a.num("leaf-min", P.treeLod.leafMinM);
    P.treeLod.leafMaxM = a.num("leaf-max", P.treeLod.leafMaxM);
    P.treeLod.leavesPerCluster = a.num("leaves-per-cluster", P.treeLod.leavesPerCluster);
    P.treeLod.clusterRadiusPerLeaf = a.num("cluster-radius-per-leaf", P.treeLod.clusterRadiusPerLeaf);
    P.treeLod.shellDepthPerHeight = a.num("shell-depth-per-height", P.treeLod.shellDepthPerHeight);
    P.treeLod.spacingRatio = a.num("station-spacing", P.treeLod.spacingRatio);
    P.lodNearPerHeight = a.num("lod-near-per-height", P.lodNearPerHeight);
    P.lodFarPerHeight = a.num("lod-far-per-height", P.lodFarPerHeight);
    P.lodNearMaxM = a.num("lod-near-max", P.lodNearMaxM);
    P.lodFarMaxM = a.num("lod-far-max", P.lodFarMaxM);
    P.lodFadeM = a.num("lod-fade", P.lodFadeM);
    if (!(P.treeLod.leafMinM > 0) || P.treeLod.leafMaxM < P.treeLod.leafMinM) throw VegetationError("bad_request", "--leaf-min must be > 0 and --leaf-max at least --leaf-min");
    if (P.woodShare < 0 || P.woodShare > 1) throw VegetationError("bad_request", "--wood-share must be in [0, 1]");
    if (!(P.minTrianglesPerTree >= 1)) throw VegetationError("bad_request", "--min-triangles-per-tree must be at least 1");
    if (P.trianglesPerCrownM2 < 0) throw VegetationError("bad_request", "--triangles-per-crown-m2 must be >= 0");

    const auto bytes = readFileBytes(a.str("crowns"));
    const std::string text(bytes.begin(), bytes.end());
    const io::GlbJsonValue doc = json::parse(text);
    if (doc.type != io::GlbJsonValue::Object) throw VegetationError("bad_input", "crowns.json is not a JSON object");

    // The growth ratios the measurement regrew its trees with (crowns.json "growth") decided which crowns it removed;
    // planting with others could leave a removed tree unrebuilt, so another value is refused.
    const auto& recorded = doc["growth"];
    if (recorded.type == io::GlbJsonValue::Object) {
        const std::pair<const char*, double*> fields[] = {{"crownBaseRatio", &P.growth.crownBaseRatio}, {"trunkRadiusPerHeight", &P.growth.trunkRadiusPerHeight},
                                                          {"shellDepth", &P.growth.shellDepth}, {"minSurfaceReached", &P.growth.minSurfaceReached},
                                                          {"crownBaseSpread", &P.growth.crownBaseSpread}, {"trunkLeanShare", &P.growth.trunkLeanShare}};
        const std::pair<const char*, float*> floatFields[] = {{"branchAngleSpreadRad", &P.growth.morphology.branchAngleSpreadRad}, {"apicalDominance", &P.growth.morphology.apicalDominance},
                                                              {"branchAngleMeanRad", &P.growth.morphology.branchAngleMeanRad}, {"internodeLengthM", &P.growth.morphology.internodeLengthM}};
        for (const auto& [name, field] : floatFields) {
            if (recorded[name].type == io::GlbJsonValue::Number) *field = static_cast<float>(recorded[name].num);
        }
        for (const auto& [name, field] : fields) {
            if (recorded[name].type == io::GlbJsonValue::Number) *field = recorded[name].num;
        }
        const std::pair<const char*, const char*> flags[] = {{"crown-base-ratio", "crownBaseRatio"}, {"trunk-radius-per-height", "trunkRadiusPerHeight"},
                                                             {"shell-depth", "shellDepth"}, {"min-surface-reached", "minSurfaceReached"},
                                                             {"crown-base-spread", "crownBaseSpread"}, {"trunk-lean", "trunkLeanShare"}};
        for (const auto& [flag, name] : flags) {
            if (a.has(flag) && recorded[name].type == io::GlbJsonValue::Number && a.num(flag, 0) != recorded[name].num) {
                throw VegetationError("bad_request", std::string("--") + flag + " " + a.str(flag) + " differs from the " + json::num(recorded[name].num) +
                                      " the measurement regrew its trees with to decide which to remove; plant with that value, or measure again with this one");
            }
        }
    }
    readGrowthFlags(a, P.growth);
    P.growth.seed = parseSeed(a);

    auto readMesh = [](const std::string& path, const char* what, std::vector<Vec3>& positions, std::vector<uint32_t>& indices) {
        const auto glb = readFileBytes(path);
        auto scene = gltf::GlbSceneReader::parse(glb.data(), glb.size());
        if (!scene.ok) throw VegetationError("bad_input", std::string("cannot read the ") + what + ": " + scene.error);
        positions.reserve(scene.mesh.vertices.size());
        for (const auto& v : scene.mesh.vertices) positions.push_back(v.position);
        indices = scene.mesh.indices;
    };
    std::vector<Vec3> supportPos, groundPos;
    std::vector<uint32_t> supportIdx, groundIdx;
    const bool withSupport = a.has("support-mesh"), withGround = a.has("ground-mesh");
    if (withSupport) readMesh(a.str("support-mesh"), "support mesh", supportPos, supportIdx);
    if (withGround) readMesh(a.str("ground-mesh"), "ground mesh", groundPos, groundIdx);
    PlantResult r = plant(doc, P, withSupport ? &supportPos : nullptr, withSupport ? &supportIdx : nullptr, withGround ? &groundPos : nullptr, withGround ? &groundIdx : nullptr);
    TreesGlbReport glbReport;
    const auto glb = writeTreesGlb(r, doc, P, &glbReport);
    if (!writeFile(a.str("out"), glb.data(), glb.size())) throw VegetationError("io", "cannot write " + a.str("out"));

    std::ostringstream s;
    size_t wood = 0, foliage = 0;
    for (const auto& t : r.trees) { wood += t.report.woodTriangles; foliage += t.report.foliageTriangles; }
    s << "{\n  \"ok\": true,\n  \"trees\": " << r.trees.size() << ",\n  \"triangles\": " << r.triangles << ",\n  \"triangleBudget\": "
      << static_cast<size_t>(r.triangleBudget) << ",\n  \"triangleBudgetSource\": " << json::str(r.budgetSource) << ",\n  \"targetTriangles\": " << r.targetTriangles
      << ",\n  \"sceneTriangleCap\": " << static_cast<size_t>(P.sceneTriangleCap) << ",\n  \"minTrianglesPerTree\": " << json::num(P.minTrianglesPerTree)
      << ",\n  \"neededTriangles\": " << r.neededTriangles << ",\n  \"woodTriangles\": " << wood << ",\n  \"foliageTriangles\": " << foliage << ",\n  \"skipped\": [";
    for (size_t i = 0; i < r.skipped.size(); ++i) s << (i ? ", " : "") << "{\"crownId\": " << r.skipped[i].first << ", \"reason\": " << json::str(r.skipped[i].second) << "}";
    s << "]";
    if (withSupport) {
        // trees kept as scanned (not_regrowable), by whether they stand on the support mesh
        auto ids = [](const std::vector<int>& v) { std::string o; for (size_t i = 0; i < v.size(); ++i) o += (i ? ", " : "") + std::to_string(v[i]); return o; };
        s << ",\n  \"keptOnSupportMesh\": [" << ids(r.keptOnSupport) << "],\n  \"keptNotOnSupportMesh\": [" << ids(r.keptNotOnSupport) << "]";
    }
    s << ",\n  \"inferred\": {\"crownBaseRatio\": " << json::num(P.growth.crownBaseRatio) << ", \"trunkRadiusPerHeight\": " << json::num(P.growth.trunkRadiusPerHeight)
      << ", \"shellDepth\": " << json::num(P.growth.shellDepth) << "},\n  \"minSurfaceReached\": " << json::num(P.growth.minSurfaceReached);
    // trees whose delivered leaves do not fill their crown within their budget, each with why (they are planted as grown)
    s << ",\n  \"shortOfCrown\": [";
    {
        size_t k = 0;
        for (const auto& t : r.trees) {
            if (t.shortOfCrown.empty()) continue;
            s << (k++ ? ", " : "") << "{\"crownId\": " << t.crownId << ", \"budget\": " << t.budget << ", \"ownBudget\": " << t.ownBudget << ", \"neededTriangles\": " << t.needed
              << ", \"crownSurfaceReached\": " << json::num(t.leaves.share()) << ", \"reason\": " << json::str(t.shortOfCrown) << "}";
        }
    }
    s << "]";
    // with a ground mesh: trunk bases further than groundTolerance from it at their stem (gapM: base minus the nearest
    // surface there, null when it has none there)
    if (r.groundChecked) {
        s << ",\n  \"groundTolerance\": " << json::num(P.groundTolerance) << ",\n  \"offGround\": [";
        size_t k = 0;
        for (const auto& t : r.trees) {
            if (!t.offGround) continue;
            s << (k++ ? ", " : "") << "{\"crownId\": " << t.crownId << ", \"gapM\": " << (std::isfinite(t.groundGapM) ? json::num(t.groundGapM) : std::string("null")) << "}";
        }
        s << "]";
    }
    s << ",\n  \"perTree\": [";
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
          << ", \"target\": " << t.target << ", \"neededTriangles\": " << t.needed << ", \"ownBudget\": " << t.ownBudget << ", \"budget\": " << t.budget
          << ", \"triangles\": " << (t.wood.indices.size() + t.foliage.indices.size()) / 3
          << ", \"wood\": " << t.report.woodTriangles << ", \"foliage\": " << t.report.foliageTriangles << ", \"clumps\": " << t.report.foliageClumps
          << ", \"surfaceMasses\": " << t.report.surfaceMasses << ", \"surfaceMassesNeeded\": " << t.report.surfaceMassesNeeded
          << ", \"crownSurfaceReached\": " << json::num(t.leaves.share()) << ", \"within1mShare\": " << json::num(t.leavesStrict.share()) << ", \"grownSurfaceReached\": " << json::num(t.grownShare)
          << ", \"leavesBelowApexM\": " << json::num(static_cast<double>((*t.crown)["apex"][1].num) - t.leaves.topY) << ", \"reachM\": " << json::num(t.reachRadius);
        if (t.groundChecked) s << ", \"groundGapM\": " << (std::isfinite(t.groundGapM) ? json::num(t.groundGapM) : std::string("null"));
        s << ", \"colonisation\": {\"iterations\": " << t.colonisation.iterations
          << ", \"stop\": " << json::str(t.colonisation.stop) << ", \"trunkSeekSteps\": " << t.colonisation.trunkSeekSteps << "}"
          << ", \"bounds\": [[" << json::num(lo.x) << "," << json::num(lo.y) << "," << json::num(lo.z) << "],[" << json::num(hi.x) << "," << json::num(hi.y) << "," << json::num(hi.z) << "]]"
          << ", \"seed\": " << t.seed << ", \"crownBaseRatio\": " << json::num(t.crownBaseRatio);
        if (t.hasLod) {
            const auto& L = t.lod;
            auto lvl = [&](const tree_lod::LeafLevelMeasure& m, size_t drawn) {
                double sMax = 0, sMin = 1e9;
                size_t over = 0;
                for (int k = 0; k < 16; ++k) {
                    const double rr = (*t.crown)["sectorRadii"][static_cast<size_t>(k)].num;
                    if (rr <= 0) continue;
                    const double ratio = m.spread[static_cast<size_t>(k)] / rr;
                    sMax = std::max(sMax, ratio); sMin = std::min(sMin, ratio);
                    if (ratio > 1.5) ++over;
                }
                std::ostringstream o;
                o << "{\"leaves\": " << m.leaves << ", \"leafTriangles\": " << m.leafTriangles << ", \"drawnTriangles\": " << drawn << ", \"samples\": " << m.samples
                  << ", \"reached\": " << m.reached << ", \"within1m\": " << m.reachedStrict << ", \"crownSurfaceReached\": " << json::num(m.share()) << ", \"within1mShare\": " << json::num(m.strictShare())
                  << ", \"leavesBelowApexM\": " << json::num(static_cast<double>((*t.crown)["apex"][1].num) - m.topY) << ", \"spreadMaxRatio\": " << json::num(sMax)
                  << ", \"spreadMinRatio\": " << json::num(sMin == 1e9 ? 0.0 : sMin) << ", \"sectorsOver1p5\": " << over << "}";
                return o.str();
            };
            s << ", \"lod\": {\"leafLengthM\": " << json::num(L.leafLengthM) << ", \"stations\": " << L.stations << ", \"repairStations\": " << L.repairStations << ", \"fitShrunk\": " << L.fitShrunk
              << ", \"unfit\": " << L.unfit << ", \"inset\": " << L.inset << ", \"outsideCrown\": " << L.outsideCrown << ", \"prunedBelowRadiusM\": " << json::num(L.prunedBelowRadiusM) << ", \"skeletonNodes\": " << t.report.skeletonNodes << ", \"twigs\": " << L.twigCount() << ", \"twigRadiusMinM\": " << json::num(L.twigRadiusMinM) << ", \"twigRadiusMedianM\": " << json::num(L.twigRadiusMedianM) << ", \"twigRadiusMaxM\": " << json::num(L.twigRadiusMaxM) << ", \"woodTriangles\": " << L.woodTriangles
              << ", \"level0\": " << lvl(L.level0, L.drawnLevel0()) << ", \"level1\": " << lvl(L.level1, L.drawnLevel1()) << ", \"level2Triangles\": " << (t.wood.indices.size() + t.foliage.indices.size()) / 3
              << ", \"ms\": " << json::num(t.lodMs) << ", \"msWood\": " << json::num(L.msWood) << ", \"msTwigs\": " << json::num(L.msTwigs) << ", \"msStations\": " << json::num(L.msStations)
              << ", \"msRepair\": " << json::num(L.msRepair) << ", \"msMeasure\": " << json::num(L.msMeasure) << "}";
        }
        s << "}";
    }
    s << "\n  ],\n";
    // the trees GLB as written: its size, and with KHR_mesh_quantization the largest position and normal error measured on
    // the written values, with the size the same nodes take unquantised
    s << "  \"glb\": {\"bytes\": " << glbReport.glb.bytes << ", \"quantized\": " << (glbReport.glb.quantized ? "true" : "false")
      << ", \"unquantizedBytes\": " << glbReport.unquantizedBytes << ", \"positionMaxErrorM\": " << json::num(glbReport.glb.maxPositionErrorM)
      << ", \"normalMaxErrorDeg\": " << json::num(glbReport.glb.maxNormalErrorDeg) << ", \"vertices\": " << glbReport.glb.vertices
      << ", \"triangles\": " << glbReport.glb.triangles << ", \"u16IndexPrimitives\": " << glbReport.glb.u16IndexPrimitives
      << ", \"u32IndexPrimitives\": " << glbReport.glb.u32IndexPrimitives << ", \"keptAsScannedRings\": " << glbReport.rings
      << ", \"instances\": " << glbReport.glb.instances << ", \"instancedTriangles\": " << glbReport.glb.instancedTriangles << ", \"jsonBytes\": " << glbReport.glb.jsonBytes
      << ", \"binBytes\": " << glbReport.glb.binBytes << "},\n";
    {
        const LodFrameEstimate f = estimateLodFrames(r, P);
        s << "  \"psiSeason\": " << json::num(P.psiSeason) << ",\n  \"lod\": " << (P.lod ? "true" : "false") << ",\n";
        if (P.lod) {
            s << "  \"lodFrames\": {\"poses\": " << f.poses << ", \"median\": " << json::num(f.median) << ", \"p95\": " << json::num(f.p95) << ", \"max\": " << json::num(f.max)
              << ", \"allAroundMedian\": " << json::num(f.allAroundMedian) << ", \"allAroundMax\": " << json::num(f.allAroundMax) << ", \"allLevel0\": " << json::num(f.allLevel0)
              << ", \"allLevel1\": " << json::num(f.allLevel1) << ", \"allLevel2\": " << json::num(f.allLevel2) << ", \"worstTreesPerLevel\": [" << f.worstTreesPerLevel[0] << ", " << f.worstTreesPerLevel[1] << ", "
              << f.worstTreesPerLevel[2] << "]},\n";
        }
    }
    s << "  \"totalMs\": " << json::num(r.ms) << "\n}\n";
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
        if (cmd == "canopy") return runCanopy(a);
        usage();
        return fail("bad_request", "unknown subcommand '" + cmd + "'");
    } catch (const VegetationError& e) {
        return fail(e.code(), e.what());
    } catch (const std::exception& e) {
        return fail("failed", e.what());
    }
}
