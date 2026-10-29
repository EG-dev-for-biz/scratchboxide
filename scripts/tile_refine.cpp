/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Generic CLI for the single native tile-refine pipeline (scratchbox_tile_refine.hpp):
 * raw photogrammetric tile GLB -> visibility cull (rasterized ID buffers) -> rectifier snapping -> photometric relief
 * inside the region of interest -> textured GLB (original photos) + studio-clay GLB + stats JSON, in one process.
 * Works on any GLB tile scan in a y-up metric frame; nothing here is specific to one scene.
 *
 * Build:
 *   clang++ -std=c++20 -O3 -pthread -I packages/core/src/native/3d-engine/include \
 *       scripts/tile_refine.cpp -o build/3d-native/tile_refine -lz
 */

#include "scratchbox_tile_refine.hpp"

#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <iterator>
#include <sstream>
#include <string>

using scratchbox::tile_refine::TileRefine;
using scratchbox::tile_refine::TileRefineParams;

/**
 * Facade grammars, one block per facade:
 *   facade <id> <nx> <ny> <nz> <cx> <cy> <cz> <confidence> <source>
 *   tier <t0> <t1> <s0> <s1> [<s0> <s1> ...]
 * (plane coordinates of that facade, metres; '#' starts a comment line).
 */
static bool readFacadeGrammars(const std::string& file, std::vector<scratchbox::photometric_relief::FacadeGrammar>& out, std::string& err) {
    std::ifstream in(file);
    if (!in) { err = "cannot read " + file; return false; }
    std::string line;
    int n = 0;
    while (std::getline(in, line)) {
        ++n;
        if (line.empty() || line[0] == '#') continue;
        std::istringstream ls(line);
        std::string kind;
        ls >> kind;
        if (kind == "facade") {
            scratchbox::photometric_relief::FacadeGrammar g;
            ls >> g.facadeId >> g.normal.x >> g.normal.y >> g.normal.z >> g.centroid.x >> g.centroid.y >> g.centroid.z >> g.confidence;
            if (!ls) { err = "line " + std::to_string(n) + ": facade needs id, normal, centroid and confidence"; return false; }
            std::getline(ls >> std::ws, g.source);
            out.push_back(std::move(g));
        } else if (kind == "tier") {
            if (out.empty()) { err = "line " + std::to_string(n) + ": tier before any facade"; return false; }
            scratchbox::photometric_relief::FacadeGrammar::Tier t;
            ls >> t.t0 >> t.t1;
            double a, b;
            while (ls >> a >> b) t.cols.push_back({a, b});
            if (!std::isfinite(t.t0) || !std::isfinite(t.t1) || t.cols.empty()) { err = "line " + std::to_string(n) + ": tier needs t0 t1 and at least one s0 s1"; return false; }
            out.back().tiers.push_back(std::move(t));
        } else {
            err = "line " + std::to_string(n) + ": unknown record '" + kind + "'";
            return false;
        }
    }
    return true;
}

/** Building footprints, one closed ring per line: x z x z ... in the tile frame ('#' starts a comment line). */
static bool readFootprintRings(const std::string& file, std::vector<std::vector<std::pair<double, double>>>& out, std::string& err) {
    std::ifstream in(file);
    if (!in) { err = "cannot read " + file; return false; }
    std::string line;
    while (std::getline(in, line)) {
        if (line.empty() || line[0] == '#') continue;
        std::istringstream ls(line);
        std::vector<double> v;
        double d;
        while (ls >> d) v.push_back(d);
        if (v.size() < 6 || v.size() % 2) continue;
        std::vector<std::pair<double, double>> ring;
        for (size_t k = 0; k + 1 < v.size(); k += 2) ring.emplace_back(v[k], v[k + 1]);
        out.push_back(std::move(ring));
    }
    return true;
}

static void usage() {
    std::cerr <<
        "usage: tile_refine --input <tile.glb> --out-textured <A.glb> --out-clay <B.glb> --stats <S.json> [options]\n"
        "  --anchor X,Z            hero anchor in the tile frame (default 0,0)\n"
        "  --no-seam-weld          skip the tile-chunk seam weld pre-pass (scratchbox_tile_seam_weld.hpp)\n"
        "  --seam-weld-tolerance M seam weld: boundary positions of adjacent pieces within M of each other are welded (default 0.03)\n"
        "  --seam-weld-no-drop     seam weld: keep the strip pieces and the triangles the weld collapses\n"
        "  --isolate               keep only the structure under the anchor (whole: its connected footprint, courtyards and\n"
        "                          everything above it, never cut) plus a ground apron; every stage runs on that subset\n"
        "  --apron M               isolate: ground kept around the footprint (default 4)\n"
        "  --isolate-min-height M  isolate: footprint cells stand at least M above the terrain (default 3)\n"
        "  --isolate-reach M       isolate: connected raised surfaces within M of the footprint join it (default 12)\n"
        "  --isolate-pick PATH     isolate exactly the structure of a shared pick (SBIP: footprint cells and walkable terrain,\n"
        "                          written by the staged-location picker); implies --isolate\n"
        "  --low-attachment-max-height M  isolate: raised areas joined to the footprint that stay below min(M, half the\n"
        "                          structure's height) and lie outside its core are dropped (default 8; <= min height: off)\n"
        "  --keep-scan-apron       isolate: keep the scan's own ground triangles instead of rebuilding the apron\n"
        "  --ground-opening-radius M  isolate: the rebuilt apron follows the scan's street surface with objects narrower than 2M\n"
        "                          removed (default 6)\n"
        "  --below-ground-margin M isolate: clip surfaces more than M below the terrain (default 0.3; < 0: off)\n"
        "  --interior-inset M      isolate: drop upward-facing floors at least M inside the footprint under the top (default 2.5; < 0: off)\n"
        "  --out-raw-clay PATH     also write the (isolated) raw scan, unmodified, as studio clay\n"
        "  --ownership-render DIR  isolate: write registered views around the structure the geometric rules found (views.txt,\n"
        "                          <name>.png: the scan's texture) for segmentation into DIR, and stop\n"
        "  --ownership-masks DIR   isolate: multi-view mask voting from DIR (views.txt + <name>.mask.png, 255 = the requested\n"
        "                          structure): a decisive vote decides a raised triangle's membership; undecided ones keep the\n"
        "                          geometric rules\n"
        "  --ownership-out PATH    with --ownership-masks: the vote of every kept triangle by centroid (SBOV) for scan_fit\n"
        "  --ownership-debug DIR   with --ownership-masks: owner-coloured renders before / after and a vote heat map\n"
        "  --vote-score S          decisive |score| (default 0.5)   --vote-min-weight W (default 0.75)   --vote-min-views N (default 2)\n"
        "  --ownership-holdout K   with --ownership-masks: every K-th view casts no vote and scores both decisions (diagnostic)\n"
        "  --ownership-size WxH    render mode: view size (default 1024x768)\n"
        "  --roi-radius M          relief region of interest: the anchor's footprint grown by M (default 60; <0 = whole tile)\n"
        "  --no-relief             skip the photometric relief (rectified scan only)\n"
        "  --relief-own-regions    relief: grow its own facade regions instead of using the detected wall planes\n"
        "  --relief-orthos DIR     write each analysed facade's orthophoto (facade_<id>.png) and frame (facades.json)\n"
        "  --relief-no-carve       relief: analyse (and write the orthos) but carve nothing\n"
        "  --relief-export-only    relief: write the orthos, neither analyse nor carve (pipeline K reads its own)\n"
        "  --relief-occlusion      relief orthos: an occlusion mask beside each (rays cast against the scan as loaded)\n"
        "  --relief-occluders <glb> relief orthos: an occlusion mask beside each, rays cast against this scene\n"
        "  --facade-grammar FILE   photo-inferred facade grammars (text: 'facade id nx ny nz cx cy cz confidence source'\n"
        "                          then 'tier t0 t1 s0 s1 [s0 s1 ...]' lines); each becomes its facade's window lattice\n"
        "  --flatten-band M        facade flatten: vertices within M of a detected wall plane move onto it (default 0.10)\n"
        "  --no-flatten            skip the facade flatten\n"
        "  --flatten-parallel-deg DEG  facade flatten: a face lies along a plane within DEG (default 30)\n"
        "  --flatten-min-area M2   facade flatten: smallest wall plane flattened onto (default 25)\n"
        "  --flatten-corner-deg DEG  facade flatten: planes at least DEG apart meet in a corner line (default 15)\n"
        "  --thumbs DIR            write raw-vs-output thumbnails (aerial, hero facade, street) into DIR\n"
        "  --threads N             worker threads (default: all cores)\n"
        "  tolerances:\n"
        "  --max-disp M            rectifier displacement budget per vertex (default 0.75)\n"
        "  --relief-max-depth M    |dh| clamp of the relief (default 0.35)\n"
        "  --stitch-tol M          rectifier chunk-seam stitch tolerance (default 0.015; 0 = no stitch)\n"
        "  --plane-turn DEG        rectifier: an in-plane face may not end more than DEG off its plane (default 6; 0 = off)\n"
        "  --melt-range M          rectifier: capture range of melted (tilted-facet) wall vertices (default 0.7; 0 = off)\n"
        "  --dead-band M           rectifier: moves shorter than M are not applied (default 0.05)\n"
        "  --max-rms M             rectifier: a region whose plane fit RMS exceeds M is not snapped (default 0.35)\n"
        "  --foreign-snap          rectifier: also pull vertices of no region onto a nearby plane\n"
        "  --denoise               rectifier: crease-preserving denoise of unclassified steep surfaces\n"
        "  --wall-footprints FILE  rectifier: building footprint rings (one per line: x z x z ...) whose edges are wall-plane\n"
        "                          candidates, taken where the scan's wall regions agree (direction only; offsets measured)\n"
        "  --no-proud-blocks       rectifier and flatten: also snap blocks standing off a wall on their own risers (keystones,\n"
        "                          medallions, deep reveals) instead of keeping their offset\n"
        "  --occluder-tol M        visibility: a surface hides a point only when at least M in front (default 0.02)\n"
        "  --street-sites N        visibility: street-level eyes (default 16)   --roof-sites N (default 4)\n"
        "  --targeted-eyes N       visibility: eyes per round placed on open ground in front of walls the first views missed\n"
        "                          (default 48; 0 = off)   --target-rounds N (default 1)\n"
        "  --aerial-res N          visibility: aerial image size (default 1536) --cube-res N (default 512)\n"
        "  --compare-visibility F  report agreement with an SBRX sidecar's flags (diagnostic)\n";
}

static bool parsePair(const std::string& s, double& a, double& b) {
    const size_t c = s.find(',');
    if (c == std::string::npos) return false;
    a = std::stod(s.substr(0, c));
    b = std::stod(s.substr(c + 1));
    return true;
}

int main(int argc, char** argv) {
    TileRefineParams p;
    std::string input, outTextured, outClay, statsPath, compare, grammarPath;
    for (int i = 1; i < argc; ++i) {
        const std::string a = argv[i];
        auto next = [&]() -> std::string {
            if (i + 1 >= argc) { std::cerr << "missing value for " << a << "\n"; std::exit(2); }
            return argv[++i];
        };
        auto num = [&]() { return std::stod(next()); };
        if (a == "--input") input = next();
        else if (a == "--out-textured") outTextured = next();
        else if (a == "--out-clay") outClay = next();
        else if (a == "--stats") statsPath = next();
        else if (a == "--anchor") { if (!parsePair(next(), p.anchorX, p.anchorZ)) { std::cerr << "--anchor expects X,Z\n"; return 2; } }
        else if (a == "--roi-radius") p.roiRadius = num();
        else if (a == "--isolate") p.isolate = true;
        else if (a == "--apron") p.isolateApron = num();
        else if (a == "--isolate-min-height") p.isolateMinHeight = num();
        else if (a == "--isolate-reach") p.isolateReach = num();
        else if (a == "--isolate-pick") { p.isolatePickPath = next(); p.isolate = true; }
        else if (a == "--low-attachment-max-height") p.isolateLowAttachmentMaxHeight = num();
        else if (a == "--keep-scan-apron") p.isolateRebuildGround = false;
        else if (a == "--ground-opening-radius") p.isolateGroundOpeningRadius = num();
        else if (a == "--below-ground-margin") p.isolateBelowGroundMargin = num();
        else if (a == "--interior-inset") p.isolateInteriorInset = num();
        else if (a == "--out-raw-clay") p.rawClayPath = next();
        else if (a == "--ownership-render") p.ownershipRenderDir = next();
        else if (a == "--ownership-masks") p.ownershipMasksDir = next();
        else if (a == "--ownership-out") p.ownershipOutPath = next();
        else if (a == "--ownership-debug") p.ownershipDebugDir = next();
        else if (a == "--vote-score") p.vote.decisiveScore = num();
        else if (a == "--vote-min-weight") p.vote.minWeight = num();
        else if (a == "--vote-min-views") p.vote.minViews = static_cast<int>(num());
        else if (a == "--ownership-holdout") p.ownershipHoldout = static_cast<int>(num());
        else if (a == "--ownership-size") {
            const std::string v = next();
            if (std::sscanf(v.c_str(), "%dx%d", &p.ownershipViewWidth, &p.ownershipViewHeight) != 2 || p.ownershipViewWidth < 16 || p.ownershipViewHeight < 16) {
                std::cerr << "--ownership-size expects WxH\n";
                return 2;
            }
        }
        else if (a == "--no-seam-weld") p.seamWeldEnabled = false;
        else if (a == "--seam-weld-tolerance") p.seamWeld.weldToleranceM = num();
        else if (a == "--seam-weld-no-drop") { p.seamWeld.sliverAspectMin = 1e9; p.seamWeld.dropStripPieces = false; }
        else if (a == "--no-relief") p.relief = false;
        else if (a == "--relief-own-regions") p.reliefOnWallPlanes = false;
        else if (a == "--relief-orthos") p.reliefParams.orthoExportDir = next();
        else if (a == "--relief-no-carve") p.reliefParams.carve = false;
        else if (a == "--relief-export-only") { p.reliefParams.carve = false; p.reliefParams.analyse = false; }
        else if (a == "--relief-occlusion") p.reliefOcclusion = true;
        else if (a == "--relief-occluders") { p.reliefOcclusion = true; p.reliefOccludersPath = next(); }
        else if (a == "--facade-grammar") grammarPath = next();
        else if (a == "--flatten-band") p.flatten.band = num();
        else if (a == "--no-flatten") p.flatten.band = 0;
        else if (a == "--flatten-parallel-deg") p.flatten.parallelDeg = num();
        else if (a == "--flatten-min-area") p.flatten.minPlaneArea = num();
        else if (a == "--flatten-corner-deg") p.flatten.cornerMinDeg = num();
        else if (a == "--thumbs") p.thumbsDir = next();
        else if (a == "--threads") p.threads = static_cast<int>(num());
        else if (a == "--max-disp") p.rect.maxDisplacement = num();
        else if (a == "--relief-max-depth") p.reliefParams.maxDepth = num();
        else if (a == "--stitch-tol") p.rect.seamStitchTolerance = num();
        else if (a == "--plane-turn") p.rect.guardPlaneMaxTurnDeg = num();
        else if (a == "--melt-range") p.rect.meltCaptureRange = num();
        else if (a == "--no-proud-blocks") p.rect.proudBlockMinRelief = 0;
        else if (a == "--dead-band") p.rect.snapDeadBand = num();
        else if (a == "--max-rms") p.rect.maxRegionRms = num();
        else if (a == "--foreign-snap") p.rect.foreignPlaneSnap = true;
        else if (a == "--denoise") p.rect.denoise = true;
        else if (a == "--footprint-match-dist") p.rect.footprintMatchDist = num();
        else if (a == "--footprint-match-deg") p.rect.footprintMatchDeg = num();
        else if (a == "--footprint-merge-offset") p.rect.footprintMergeOffset = num();
        else if (a == "--footprint-claim-tau") p.rect.footprintClaimTau = num();
        else if (a == "--footprint-claim-deg") p.rect.footprintClaimDeg = num();
        else if (a == "--max-snap-induced") p.rect.maxSnapInducedDisplacement = num();
        else if (a == "--wall-footprints") {
            std::string err;
            if (!readFootprintRings(next(), p.rect.wallFootprintsXZ, err)) { std::cerr << "--wall-footprints: " << err << "\n"; return 2; }
        }
        else if (a == "--occluder-tol") p.vis.occluderTolerance = num();
        else if (a == "--street-sites") p.vis.streetSites = static_cast<int>(num());
        else if (a == "--roof-sites") p.vis.roofSites = static_cast<int>(num());
        else if (a == "--targeted-eyes") p.vis.targetedEyes = static_cast<int>(num());
        else if (a == "--target-rounds") p.vis.targetRounds = static_cast<int>(num());
        else if (a == "--aerial-res") p.vis.aerialResolution = static_cast<int>(num());
        else if (a == "--cube-res") p.vis.cubeResolution = static_cast<int>(num());
        else if (a == "--compare-visibility") compare = next();
        else if (a == "--help" || a == "-h") { usage(); return 0; }
        else { std::cerr << "unknown argument " << a << "\n"; usage(); return 2; }
    }
    if (input.empty() || (outTextured.empty() && outClay.empty() && p.ownershipRenderDir.empty())) { usage(); return 2; }
    if ((!p.ownershipRenderDir.empty() || !p.ownershipMasksDir.empty()) && !p.isolate) { std::cerr << "--ownership-render / --ownership-masks need --isolate\n"; return 2; }
    if (!(p.reliefParams.maxDepth >= 0)) { std::cerr << "--relief-max-depth must be >= 0\n"; return 2; }
    if (!(p.isolateApron >= 0) || !(p.isolateReach >= 0) || !std::isfinite(p.isolateMinHeight)) {
        std::cerr << "--apron and --isolate-reach must be >= 0, --isolate-min-height finite\n";
        return 2;
    }
    if (!grammarPath.empty()) {
        std::string err;
        if (!readFacadeGrammars(grammarPath, p.reliefParams.grammars, err)) { std::cerr << "--facade-grammar: " << err << "\n"; return 2; }
    }
    if (!p.reliefParams.orthoExportDir.empty()) std::filesystem::create_directories(p.reliefParams.orthoExportDir);
    p.reliefParams.recessMin = std::min(p.reliefParams.recessMin, p.reliefParams.maxDepth);
    p.reliefParams.recessMax = std::min(p.reliefParams.recessMax, p.reliefParams.maxDepth);
    if (!compare.empty()) {
        // SBRX: magic, version, V, T, float32[3V], uint8[T]
        std::ifstream f(compare, std::ios::binary);
        std::vector<uint8_t> bytes((std::istreambuf_iterator<char>(f)), std::istreambuf_iterator<char>());
        if (bytes.size() >= 16 && std::memcmp(bytes.data(), "SBRX", 4) == 0) {
            uint32_t V = 0, T = 0;
            std::memcpy(&V, bytes.data() + 8, 4);
            std::memcpy(&T, bytes.data() + 12, 4);
            const size_t off = 16 + static_cast<size_t>(V) * 12;
            if (bytes.size() >= off + T) p.referenceVisibility.assign(bytes.begin() + static_cast<std::ptrdiff_t>(off), bytes.begin() + static_cast<std::ptrdiff_t>(off + T));
        }
        if (p.referenceVisibility.empty()) std::cerr << "warning: could not read visibility flags from " << compare << "\n";
    }

    const auto r = TileRefine::runFile(input, outTextured, outClay, statsPath, p);
    if (!r.ok) { std::cerr << "tile_refine failed: " << r.error << "\n"; return 1; }
    if (statsPath.empty()) std::cout << r.statsJson;
    else std::cout << "{\"ok\": true, \"stats\": \"" << statsPath << "\", \"triangles\": " << r.outputTriangles << ", \"totalMs\": " << r.totalMs << "}" << std::endl;
    return 0;
}
