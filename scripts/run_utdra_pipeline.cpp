/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * Standalone headless UTDRA tile runner (C++20).
 *
 * Modes, each on a given tile (--input is required; no stand-in mesh is ever built):
 *   probe   measures the tile (bounds, relief, area by slope band, wall orientation, vertex-colour green index);
 *           it classifies nothing and writes no GLB.
 *   slicer  keeps the part of the tile above --sliceY, clipping straddling triangles (Sutherland-Hodgman).
 *   bridge  removes the near-vertical triangles inside the span box given with
 *           --span minX,maxX,minZ,maxZ,groundY,deckY (it does not decide what is a bridge).
 *
 * Telemetry is one machine-readable [TELEMETRY] line measuring the written mesh (the input for probe).
 * Exit code 2 is an invalid input or argument; 1 is a failure while running.
 ********************************************************************************/

#include "scratchbox_engine.hpp"
#include "scratchbox_utdra.hpp"
#include "scratchbox_io.hpp"

#include <iostream>
#include <fstream>
#include <sstream>
#include <string>
#include <vector>
#include <chrono>
#include <cmath>
#include <filesystem>

namespace fs = std::filesystem;
using namespace scratchbox;
using namespace scratchbox::math;
using namespace scratchbox::geometry;
using namespace scratchbox::utdra;
using namespace scratchbox::io;

static bool parseFloat(const std::string& text, float& out) {
    try {
        size_t used = 0;
        out = std::stof(text, &used);
        return used == text.size() && std::isfinite(out);
    } catch (...) {
        return false;
    }
}

static bool parseSpan(const std::string& text, SpanBox& box) {
    std::vector<float> values;
    std::stringstream ss(text);
    std::string part;
    while (std::getline(ss, part, ',')) {
        float v = 0.0f;
        if (!parseFloat(part, v)) return false;
        values.push_back(v);
    }
    if (values.size() != 6) return false;
    box = SpanBox{values[0], values[1], values[2], values[3], values[4], values[5]};
    return true;
}

int main(int argc, char* argv[]) {
    std::string inputPath;
    std::string outputPath;
    std::string mode;
    float sliceY = 0.0f;
    bool hasSliceY = false;
    SpanBox span;
    bool hasSpan = false;
    float minVoidHeight = 0.0f;
    bool hasMinVoidHeight = false;

    for (int i = 1; i < argc; ++i) {
        std::string arg = argv[i];
        auto next = [&](const char* name) -> std::string {
            if (i + 1 >= argc) {
                std::cerr << "Error: " << name << " needs a value\n";
                std::exit(2);
            }
            return argv[++i];
        };
        if (arg == "--input") inputPath = next("--input");
        else if (arg == "--output") outputPath = next("--output");
        else if (arg == "--mode") mode = next("--mode");
        else if (arg == "--sliceY") {
            if (!parseFloat(next("--sliceY"), sliceY)) { std::cerr << "Error: --sliceY must be a number\n"; return 2; }
            hasSliceY = true;
        } else if (arg == "--span") {
            if (!parseSpan(next("--span"), span)) { std::cerr << "Error: --span must be six numbers minX,maxX,minZ,maxZ,groundY,deckY\n"; return 2; }
            hasSpan = true;
        } else if (arg == "--minVoidHeight") {
            if (!parseFloat(next("--minVoidHeight"), minVoidHeight) || minVoidHeight < 0.0f) { std::cerr << "Error: --minVoidHeight must be a number >= 0\n"; return 2; }
            hasMinVoidHeight = true;
        } else {
            std::cerr << "Error: unknown argument " << arg << "\n";
            return 2;
        }
    }

    // The tile to process is required: no stand-in mesh is ever built in its place.
    if (inputPath.empty()) {
        std::cerr << "Error: --input <tile.glb> is required; the pipeline processes a given tile and builds none of its own\n";
        return 2;
    }
    if (!fs::exists(inputPath)) {
        std::cerr << "Error: --input " << inputPath << " does not exist\n";
        return 2;
    }
    if (mode != "probe" && mode != "slicer" && mode != "bridge") {
        std::cerr << "Error: --mode must be probe, slicer or bridge (got \"" << mode << "\")\n";
        return 2;
    }
    if (mode != "probe" && outputPath.empty()) {
        std::cerr << "Error: --output <path.glb> is required for --mode " << mode << "\n";
        return 2;
    }
    if (mode == "slicer" && !hasSliceY) {
        std::cerr << "Error: --mode slicer needs --sliceY <elevation>\n";
        return 2;
    }
    if (mode == "bridge") {
        if (!hasSpan) {
            std::cerr << "Error: --mode bridge needs --span minX,maxX,minZ,maxZ,groundY,deckY (the deck's footprint and the ground and deck heights); the carver does not find bridges itself\n";
            return 2;
        }
        if (!(span.maxX > span.minX && span.maxZ > span.minZ && span.deckY > span.groundY)) {
            std::cerr << "Error: --span needs maxX > minX, maxZ > minZ and deckY > groundY\n";
            return 2;
        }
        if (hasMinVoidHeight && span.deckY - span.groundY < minVoidHeight) {
            std::cerr << "Error: the span's clearance (deckY - groundY = " << (span.deckY - span.groundY)
                      << " m) is below --minVoidHeight " << minVoidHeight << " m\n";
            return 2;
        }
    }

    auto startTime = std::chrono::high_resolution_clock::now();

    ScratchboxMesh inputMesh = GlbReader::readGlb(inputPath);
    if (inputMesh.vertices.empty() || inputMesh.indices.size() < 3) {
        std::cerr << "Error: --input " << inputPath << " has no triangles\n";
        return 2;
    }

    ScratchboxMesh outputMesh("UtdraOutputMesh");
    size_t removedTris = 0;
    if (mode == "probe") {
        outputMesh = inputMesh;
    } else if (mode == "slicer") {
        std::vector<SutherlandHodgmanSlicer::Triangle> clipped;
        for (size_t t = 0; t + 2 < inputMesh.indices.size(); t += 3) {
            const auto& v0 = inputMesh.vertices[inputMesh.indices[t + 0]];
            const auto& v1 = inputMesh.vertices[inputMesh.indices[t + 1]];
            const auto& v2 = inputMesh.vertices[inputMesh.indices[t + 2]];
            SutherlandHodgmanSlicer::clipTriangleAboveElevation(v0, v1, v2, sliceY, clipped);
        }
        for (const auto& tri : clipped) {
            uint32_t bIdx = static_cast<uint32_t>(outputMesh.vertices.size());
            outputMesh.addVertex(tri.v0);
            outputMesh.addVertex(tri.v1);
            outputMesh.addVertex(tri.v2);
            outputMesh.indices.push_back(bIdx);
            outputMesh.indices.push_back(bIdx + 1);
            outputMesh.indices.push_back(bIdx + 2);
        }
        if (outputMesh.indices.empty()) {
            std::cerr << "Error: nothing of " << inputPath << " lies above y=" << sliceY << "\n";
            return 1;
        }
    } else {
        SpanCarveResult carved = SpanCurtainCarver::carve(inputMesh, span);
        removedTris = carved.removedTriangles;
        outputMesh = std::move(carved.mesh);
        if (outputMesh.indices.empty()) {
            std::cerr << "Error: carving the span removed every triangle of " << inputPath << "\n";
            return 1;
        }
    }

    const TileMeasurements m = TileMeasurer::measure(outputMesh);
    double elapsedMs = std::chrono::duration<double, std::milli>(std::chrono::high_resolution_clock::now() - startTime).count();

    if (mode != "probe") {
        std::vector<uint8_t> glbData = GlbWriter::writeGlb(outputMesh);
        if (fs::path(outputPath).has_parent_path()) fs::create_directories(fs::path(outputPath).parent_path());
        std::ofstream outFile(outputPath, std::ios::binary);
        if (!outFile.is_open()) {
            std::cerr << "Error: failed to open output file " << outputPath << "\n";
            return 1;
        }
        outFile.write(reinterpret_cast<const char*>(glbData.data()), static_cast<std::streamsize>(glbData.size()));
        outFile.close();
        std::cout << "[Output] Wrote " << glbData.size() << " bytes to " << outputPath << "\n";
    }

    std::cout << "[TELEMETRY] "
              << "MODE=" << mode << " "
              << "BOUNDS_MIN=" << m.bounds.min.x << "," << m.bounds.min.y << "," << m.bounds.min.z << " "
              << "BOUNDS_MAX=" << m.bounds.max.x << "," << m.bounds.max.y << "," << m.bounds.max.z << " "
              << "RELIEF=" << m.reliefMeters << " "
              << "AREA=" << m.surfaceArea << " "
              << "HORIZONTAL=" << m.horizontalFraction << " "
              << "INCLINED=" << m.inclinedFraction << " "
              << "STEEP=" << m.steepFraction << " "
              << "VERTICAL=" << m.verticalFraction << " "
              << "GREEN_INDEX=" << m.greenIndex << " "
              << "WALL_YAW=" << (m.hasWalls ? std::to_string(m.dominantWallYawDeg) : std::string("none")) << " "
              << "DEGENERATE_TRIS=" << m.degenerateTriangles << " "
              << "INPUT_TRIS=" << (inputMesh.indices.size() / 3) << " "
              << "OUTPUT_TRIS=" << (outputMesh.indices.size() / 3) << " "
              << "REMOVED_TRIS=" << removedTris << " "
              << "RUNTIME_MS=" << elapsedMs << "\n";
    return 0;
}
