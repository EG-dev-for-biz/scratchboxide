/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * Standalone Headless Universal Tile Decomposition & Rectification Pipeline CLI
 * (UTDRA / ULDRA)
 * Suitable for In-App Native Execution, Service Pipelines, and Cloud Run.
 *
 * Implements:
 * 1. Macro-Domain Classifier (9 Canonical Geographic Domains)
 * 2. Non-Destructive Triangle-Plane Slicer (Sutherland-Hodgman)
 * 3. Multi-Level Void Carver (Bridges, Viaducts, Flyovers)
 * 4. Slope-Stratified Natural Terrain Biomes (Alpine, Bedrock, Talus Scree)
 * 5. Full Universal Tile Decomposed Hybrid Assembly (Rectified Shafts & Sculptural Crowns)
 *
 * Streams binary glTF 2.0 (.glb) chunks over stdout or writes to disk.
 ********************************************************************************/

#include "scratchbox_engine.hpp"
#include "scratchbox_utdra.hpp"
#include "scratchbox_io.hpp"

#include <iostream>
#include <fstream>
#include <string>
#include <vector>
#include <chrono>
#include <filesystem>

namespace fs = std::filesystem;
using namespace scratchbox;
using namespace scratchbox::math;
using namespace scratchbox::geometry;
using namespace scratchbox::utdra;
using namespace scratchbox::io;

// ============================================================================
// CLI Main Entry Point
// ============================================================================

int main(int argc, char* argv[]) {
    std::string inputPath = "";
    std::string outputPath = "";
    std::string mode = "full"; // full | probe | slicer | bridge | terrain
    float sliceY = 0.0f;
    bool hasSliceY = false;
    float minVoidHeight = 3.5f;
    double anchorLat = 0.0;
    double anchorLon = 0.0;
    bool hasAnchor = false;
    bool streamStdout = false;

    for (int i = 1; i < argc; ++i) {
        std::string arg = argv[i];
        if (arg == "--input" && i + 1 < argc) {
            inputPath = argv[++i];
        } else if (arg == "--output" && i + 1 < argc) {
            outputPath = argv[++i];
        } else if (arg == "--mode" && i + 1 < argc) {
            mode = argv[++i];
        } else if (arg == "--sliceY" && i + 1 < argc) {
            sliceY = std::stof(argv[++i]);
            hasSliceY = true;
        } else if (arg == "--minVoidHeight" && i + 1 < argc) {
            minVoidHeight = std::stof(argv[++i]);
        } else if (arg == "--lat" && i + 1 < argc) {
            anchorLat = std::stod(argv[++i]);
            hasAnchor = true;
        } else if (arg == "--lon" && i + 1 < argc) {
            anchorLon = std::stod(argv[++i]);
            hasAnchor = true;
        } else if (arg == "--stream") {
            streamStdout = true;
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
    if (outputPath.empty() && !streamStdout) {
        std::cerr << "Error: --output <path.glb> (or --stream) is required\n";
        return 2;
    }
    if (mode != "full" && mode != "probe" && mode != "slicer" && mode != "bridge" && mode != "terrain") {
        std::cerr << "Error: unknown --mode " << mode << " (full, probe, slicer, bridge or terrain)\n";
        return 2;
    }
    if (mode == "slicer" && !hasSliceY) {
        std::cerr << "Error: --mode slicer needs --sliceY <elevation>\n";
        return 2;
    }

    if (!streamStdout) {
        std::cout << "======================================================================\n";
        std::cout << "  SCRATCHBOX 3D ENGINE: UTDRA / ULDRA PIPELINE RUNNER (C++20)\n";
        std::cout << "======================================================================\n";
    }

    auto startTime = std::chrono::high_resolution_clock::now();

    // 1. Read the input tile
    if (!streamStdout) std::cout << "  [Input] Ingesting GLB: " << inputPath << "\n";
    ScratchboxMesh inputMesh = GlbReader::readGlb(inputPath);
    if (inputMesh.vertices.empty() || inputMesh.indices.size() < 3) {
        std::cerr << "Error: --input " << inputPath << " has no triangles\n";
        return 2;
    }

    GeodeticCoord anchor;
    if (hasAnchor) {
        anchor.latDeg = anchorLat;
        anchor.lngDeg = anchorLon;
    }

    ScratchboxMesh outputMesh("UtdraOutputMesh");
    GeographicDomainProbe probe;

    // 2. Execute Requested Pipeline Mode
    if (mode == "probe") {
        probe = DomainClassifier::probeTile(inputMesh, anchor);
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
            outputMesh.vertices.push_back(tri.v0);
            outputMesh.vertices.push_back(tri.v1);
            outputMesh.vertices.push_back(tri.v2);
            outputMesh.indices.push_back(bIdx);
            outputMesh.indices.push_back(bIdx + 1);
            outputMesh.indices.push_back(bIdx + 2);
        }
        probe = DomainClassifier::probeTile(outputMesh, anchor);
    } else if (mode == "bridge") {
        outputMesh = MultiLevelVoidCarver::carveUnderpassVoids(inputMesh, minVoidHeight);
        probe = DomainClassifier::probeTile(outputMesh, anchor);
    } else if (mode == "terrain") {
        outputMesh = inputMesh;
        NaturalTerrainProcessor::applySlopeStratifiedBiomes(outputMesh);
        probe = DomainClassifier::probeTile(outputMesh, anchor);
    } else {
        // Full Universal Tile Pipeline Mode
        UniversalDecomposedTile decomposed = UniversalTilePipeline::processRawTile(inputMesh, anchor);
        probe = decomposed.probe;

        // Combine decomposed components into single cohesive mesh
        uint32_t baseIdx = 0;
        for (const auto& bldg : decomposed.rectifiedBuildings) {
            baseIdx = static_cast<uint32_t>(outputMesh.vertices.size());
            for (const auto& v : bldg.vertices) outputMesh.vertices.push_back(v);
            for (uint32_t idx : bldg.indices) outputMesh.indices.push_back(baseIdx + idx);
        }
        for (const auto& crown : decomposed.preservedSculpturalCrowns) {
            baseIdx = static_cast<uint32_t>(outputMesh.vertices.size());
            for (const auto& v : crown.vertices) outputMesh.vertices.push_back(v);
            for (uint32_t idx : crown.indices) outputMesh.indices.push_back(baseIdx + idx);
        }
        if (!decomposed.clearedUnderpassBridges.vertices.empty()) {
            baseIdx = static_cast<uint32_t>(outputMesh.vertices.size());
            for (const auto& v : decomposed.clearedUnderpassBridges.vertices) outputMesh.vertices.push_back(v);
            for (uint32_t idx : decomposed.clearedUnderpassBridges.indices) outputMesh.indices.push_back(baseIdx + idx);
        }
        if (!decomposed.conformedTerrainSurface.vertices.empty()) {
            baseIdx = static_cast<uint32_t>(outputMesh.vertices.size());
            for (const auto& v : decomposed.conformedTerrainSurface.vertices) outputMesh.vertices.push_back(v);
            for (uint32_t idx : decomposed.conformedTerrainSurface.indices) outputMesh.indices.push_back(baseIdx + idx);
        }
        if (outputMesh.vertices.empty()) {
            // Nothing came out of the decomposition: report it instead of passing the input off as the result.
            std::cerr << "Error: the full decomposition produced no geometry for " << inputPath << "\n";
            return 1;
        }
    }

    auto endTime = std::chrono::high_resolution_clock::now();
    double elapsedMs = std::chrono::duration<double, std::milli>(endTime - startTime).count();

    size_t inputTris = inputMesh.indices.size() / 3;
    size_t outputTris = outputMesh.indices.size() / 3;

    // 3. Serialize and Write Binary GLB
    std::vector<uint8_t> glbData = GlbWriter::writeGlb(outputMesh);

    if (streamStdout) {
        std::cout.write(reinterpret_cast<const char*>(glbData.data()), glbData.size());
    } else {
        if (fs::path(outputPath).has_parent_path()) fs::create_directories(fs::path(outputPath).parent_path());
        std::ofstream outFile(outputPath, std::ios::binary);
        if (!outFile.is_open()) {
            std::cerr << "Error: failed to open output file " << outputPath << "\n";
            return 1;
        }
        outFile.write(reinterpret_cast<const char*>(glbData.data()), glbData.size());
        outFile.close();
        std::cout << "  [Output] Wrote " << glbData.size() << " bytes to " << outputPath << "\n";
    }

    // 4. Emit Machine-Readable Telemetry Tag
    std::cout << "\n[TELEMETRY] "
              << "DOMAIN=" << getGeographicDomainName(probe.dominantDomain) << " "
              << "CONFIDENCE=" << probe.confidence << " "
              << "RELIEF=" << probe.totalReliefDeltaY << " "
              << "PLANARITY=" << probe.planarityScore << " "
              << "VERTICALITY=" << probe.verticalityScore << " "
              << "VEG_NDVI=" << probe.vegetationIndexNDVI << " "
              << "PITCHED_ROOF=" << probe.pitchedRoofRatio << " "
              << "WATER=" << probe.waterSurfaceRatio << " "
              << "VOID=" << probe.underpassVoidRatio << " "
              << "YAW=" << probe.dominantStreetYawDeg << " "
              << "INPUT_TRIS=" << inputTris << " "
              << "OUTPUT_TRIS=" << outputTris << " "
              << "RUNTIME_MS=" << elapsedMs << "\n";

    if (!streamStdout) {
        probe.printSummary();
        std::cout << "  Input Triangles:      " << inputTris << "\n";
        std::cout << "  Output Triangles:     " << outputTris << "\n";
        std::cout << "  Execution Time:       " << elapsedMs << " ms\n";
        std::cout << "======================================================================\n";
    }

    return 0;
}
