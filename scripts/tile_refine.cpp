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
#include <cstdlib>
#include <cstring>
#include <fstream>
#include <iostream>
#include <iterator>
#include <string>

using scratchbox::tile_refine::TileRefine;
using scratchbox::tile_refine::TileRefineParams;

static void usage() {
    std::cerr <<
        "usage: tile_refine --input <tile.glb> --out-textured <A.glb> --out-clay <B.glb> --stats <S.json> [options]\n"
        "  --anchor X,Z            hero anchor in the tile frame (default 0,0)\n"
        "  --isolate               keep only the structure under the anchor (whole: its connected footprint, courtyards and\n"
        "                          everything above it, never cut) plus a ground apron; every stage runs on that subset\n"
        "  --apron M               isolate: ground kept around the footprint (default 4)\n"
        "  --isolate-min-height M  isolate: footprint cells stand at least M above the terrain (default 3)\n"
        "  --isolate-reach M       isolate: connected raised surfaces within M of the footprint join it (default 12)\n"
        "  --low-attachment-max-height M  isolate: raised areas joined to the footprint that stay below min(M, half the\n"
        "                          structure's height) and lie outside its core are dropped (default 8; <= min height: off)\n"
        "  --keep-scan-apron       isolate: keep the scan's own ground triangles instead of rebuilding the apron\n"
        "  --ground-opening-radius M  isolate: the rebuilt apron follows the scan's street surface with objects narrower than 2M\n"
        "                          removed (default 6)\n"
        "  --below-ground-margin M isolate: clip surfaces more than M below the terrain (default 0.3; < 0: off)\n"
        "  --interior-inset M      isolate: drop upward-facing floors at least M inside the footprint under the top (default 2.5; < 0: off)\n"
        "  --out-raw-clay PATH     also write the (isolated) raw scan, unmodified, as studio clay"
        "  --roi-radius M          relief region of interest: the anchor's footprint grown by M (default 60; <0 = whole tile)\n"
        "  --no-relief             skip the photometric relief (rectified scan only)\n"
        "  --thumbs DIR            write raw-vs-output thumbnails (aerial, hero facade, street) into DIR\n"
        "  --threads N             worker threads (default: all cores)\n"
        "  tolerances:\n"
        "  --max-disp M            rectifier displacement budget per vertex (default 0.75)\n"
        "  --relief-max-depth M    |dh| clamp of the relief (default 0.35)\n"
        "  --stitch-tol M          rectifier chunk-seam stitch tolerance (default 0.015; 0 = no stitch)\n"
        "  --plane-turn DEG        rectifier: an in-plane face may not end more than DEG off its plane (default 6; 0 = off)\n"
        "  --melt-range M          rectifier: capture range of melted (tilted-facet) wall vertices (default 0.7; 0 = off)\n"
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
    std::string input, outTextured, outClay, statsPath, compare;
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
        else if (a == "--low-attachment-max-height") p.isolateLowAttachmentMaxHeight = num();
        else if (a == "--keep-scan-apron") p.isolateRebuildGround = false;
        else if (a == "--ground-opening-radius") p.isolateGroundOpeningRadius = num();
        else if (a == "--below-ground-margin") p.isolateBelowGroundMargin = num();
        else if (a == "--interior-inset") p.isolateInteriorInset = num();
        else if (a == "--out-raw-clay") p.rawClayPath = next();
        else if (a == "--no-relief") p.relief = false;
        else if (a == "--thumbs") p.thumbsDir = next();
        else if (a == "--threads") p.threads = static_cast<int>(num());
        else if (a == "--max-disp") p.rect.maxDisplacement = num();
        else if (a == "--relief-max-depth") p.reliefParams.maxDepth = num();
        else if (a == "--stitch-tol") p.rect.seamStitchTolerance = num();
        else if (a == "--plane-turn") p.rect.guardPlaneMaxTurnDeg = num();
        else if (a == "--melt-range") p.rect.meltCaptureRange = num();
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
    if (input.empty() || (outTextured.empty() && outClay.empty())) { usage(); return 2; }
    if (!(p.reliefParams.maxDepth >= 0)) { std::cerr << "--relief-max-depth must be >= 0\n"; return 2; }
    if (!(p.isolateApron >= 0) || !(p.isolateReach >= 0) || !std::isfinite(p.isolateMinHeight)) {
        std::cerr << "--apron and --isolate-reach must be >= 0, --isolate-min-height finite\n";
        return 2;
    }
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
