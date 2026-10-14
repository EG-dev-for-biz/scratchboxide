/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Photometric relief CLI (scratchbox_photometric_relief.hpp).
 *
 * Reads a textured photogrammetric GLB (rectified or raw), recovers facade relief from its own
 * photos (periodic dark cells / strips, shadowed structural lines) and writes:
 *   --out-textured  the re-tessellated scan with the original photos and UVs (plain glTF 2.0)
 *   --out-clay      the same geometry as one studio-clay mesh (POSITION + NORMAL)
 *   --stats         JSON statistics (printed to stdout when omitted)
 *
 * Build:
 *   clang++ -std=c++20 -O3 -pthread -I packages/core/src/native/3d-engine/include \
 *       scripts/run_photometric_relief.cpp -o build/3d-native/run_photometric_relief -lz
 */

#include "scratchbox_photometric_relief.hpp"

#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <string>

using namespace scratchbox;
using photometric_relief::PhotometricRelief;
using photometric_relief::ReliefParams;

static void usage() {
    std::cerr << "usage: run_photometric_relief --input <scan.glb> [--out-textured <out.glb>] [--out-clay <clay.glb>] [--stats <stats.json>]\n"
                 "         [--max-depth M] [--min-region-area M2] [--pixel M] [--min-pitch M] [--max-pitch M]\n"
                 "         [--recess-min M] [--recess-max M] [--contrast-lo X] [--contrast-hi X] [--shadow-slope X]\n"
                 "         [--max-band-height M] [--jamb-width M] [--wall-max-abs-ny X] [--plane-angle-deg D] [--plane-offset M]\n"
                 "         [--min-cell-coverage X] [--line-min-consistency X] [--line-min-step X] [--crease-deg D]\n"
                 "         [--threads N] [--debug-dir DIR] [--debug-max N]\n";
}

static bool writeFile(const std::string& path, const std::vector<uint8_t>& bytes) {
    if (path.empty()) return true;
    std::filesystem::path p(path);
    if (p.has_parent_path()) std::filesystem::create_directories(p.parent_path());
    std::ofstream f(path, std::ios::binary);
    if (!f.is_open()) return false;
    f.write(reinterpret_cast<const char*>(bytes.data()), static_cast<std::streamsize>(bytes.size()));
    return static_cast<bool>(f);
}

int main(int argc, char** argv) {
    ReliefParams p;
    std::string input, outTextured, outClay, statsPath, debugDir;
    int debugMax = 8;
    for (int i = 1; i < argc; ++i) {
        std::string a = argv[i];
        auto next = [&]() -> std::string {
            if (i + 1 >= argc) { std::cerr << "missing value for " << a << "\n"; std::exit(2); }
            return argv[++i];
        };
        auto num = [&]() { return std::stod(next()); };
        if (a == "--input") input = next();
        else if (a == "--out-textured") outTextured = next();
        else if (a == "--out-clay") outClay = next();
        else if (a == "--stats") statsPath = next();
        else if (a == "--max-depth") p.maxDepth = num();
        else if (a == "--min-region-area") p.minRegionArea = num();
        else if (a == "--pixel") p.pixel = num();
        else if (a == "--min-pitch") p.minPitch = num();
        else if (a == "--max-pitch") p.maxPitch = num();
        else if (a == "--recess-min") p.recessMin = num();
        else if (a == "--recess-max") p.recessMax = num();
        else if (a == "--contrast-lo") p.contrastLo = num();
        else if (a == "--contrast-hi") p.contrastHi = num();
        else if (a == "--shadow-slope") p.shadowSlope = num();
        else if (a == "--max-band-height") p.maxBandHeight = num();
        else if (a == "--jamb-width") p.jambWidth = num();
        else if (a == "--wall-max-abs-ny") p.wallMaxAbsNy = num();
        else if (a == "--plane-angle-deg") p.planeAngleDeg = num();
        else if (a == "--plane-offset") p.planeOffset = num();
        else if (a == "--min-cell-coverage") p.minCellCoverage = num();
        else if (a == "--line-min-consistency") p.lineMinConsistency = num();
        else if (a == "--line-min-step") p.lineMinStep = num();
        else if (a == "--crease-deg") p.creaseAngleDeg = num();
        else if (a == "--threads") p.threads = static_cast<int>(num());
        else if (a == "--debug-dir") debugDir = next();
        else if (a == "--debug-max") debugMax = static_cast<int>(num());
        else if (a == "--help" || a == "-h") { usage(); return 0; }
        else { std::cerr << "unknown argument " << a << "\n"; usage(); return 2; }
    }
    if (input.empty()) { usage(); return 2; }
    if (!(p.maxDepth >= 0)) { std::cerr << "--max-depth must be >= 0\n"; return 2; }
    p.recessMin = std::min(p.recessMin, p.maxDepth);
    p.recessMax = std::min(p.recessMax, p.maxDepth);

    auto t0 = std::chrono::steady_clock::now();
    gltf::GltfScene scene = gltf::GlbSceneReader::readFile(input);
    if (!scene.ok) { std::cerr << "failed to read " << input << ": " << scene.error << "\n"; return 1; }
    if (!debugDir.empty()) std::filesystem::create_directories(debugDir);

    auto result = PhotometricRelief::run(scene, p, debugDir, debugMax);
    if (!result.ok) { std::cerr << "relief failed: " << result.error << "\n"; return 1; }

    size_t texturedBytes = 0, clayBytes = 0;
    if (!outTextured.empty()) {
        auto glb = PhotometricRelief::writeTexturedGlb(scene, result.mesh, p.creaseAngleDeg);
        texturedBytes = glb.size();
        if (!writeFile(outTextured, glb)) { std::cerr << "cannot write " << outTextured << "\n"; return 1; }
    }
    if (!outClay.empty()) {
        auto glb = PhotometricRelief::writeClayGlb(result.mesh, p.creaseAngleDeg);
        clayBytes = glb.size();
        if (!writeFile(outClay, glb)) { std::cerr << "cannot write " << outClay << "\n"; return 1; }
    }
    double totalMs = std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - t0).count();

    std::string json = PhotometricRelief::statsJson(result, p);
    std::ostringstream files;
    files << "  \"input\": \"" << input << "\",\n  \"files\": {\"textured\": \"" << outTextured << "\", \"texturedBytes\": " << texturedBytes
          << ", \"clay\": \"" << outClay << "\", \"clayBytes\": " << clayBytes << ", \"inputImages\": " << scene.images.size()
          << ", \"inputMaterials\": " << scene.materials.size() << ", \"totalMs\": " << totalMs << "},\n";
    json.insert(2, files.str());
    if (!statsPath.empty()) {
        std::vector<uint8_t> bytes(json.begin(), json.end());
        if (!writeFile(statsPath, bytes)) { std::cerr << "cannot write " << statsPath << "\n"; return 1; }
        std::cout << "{\"ok\": true, \"stats\": \"" << statsPath << "\", \"regionsTreated\": " << result.regionsTreated << ", \"trianglesIn\": " << result.inputTriangles
                  << ", \"trianglesOut\": " << result.mesh.triangles.size() << ", \"minHeight\": " << result.minHeight << ", \"maxHeight\": " << result.maxHeight
                  << ", \"texturedBytes\": " << texturedBytes << ", \"clayBytes\": " << clayBytes << ", \"totalMs\": " << totalMs << "}" << std::endl;
    } else {
        std::cout << json;
    }
    return 0;
}
