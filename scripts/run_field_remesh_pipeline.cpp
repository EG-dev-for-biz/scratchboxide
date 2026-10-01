/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * Standalone Headless Instant Meshes Field-Aligned Quad Remesher CLI
 * Suitable for In-App Native Execution, Service Pipelines, and Cloud Run.
 *
 * Implements:
 * 1. DCEL Half-Edge Topology Construction
 * 2. Dihedral Angle Crease & Sharp Feature Detection
 * 3. 4-RoSy (4-Fold Rotational Symmetry) Orientation Field Solver
 * 4. Manhattan Orthogonal Priors & Street Canyon Alignment
 * 5. Position Field Integration & Target Edge Spacing (h = sqrt(A / N))
 * 6. Integer-Grid Quad Extraction & Quad Wireframe Generation
 * 7. BVH Surface Snapping & Tangential Laplacian Relaxation
 *
 * Streams binary glTF 2.0 (.glb) chunks over stdout or writes to disk.
 ********************************************************************************/

#include "scratchbox_engine.hpp"
#include "scratchbox_field_remesh.hpp"
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
using namespace scratchbox::remesh;
using namespace scratchbox::io;

// Generates the Empire State Building photogrammetric scan benchmark
static ScratchboxMesh createBenchmarkScan() {
    ScratchboxMesh rawScan("empire_state_building_photogrammetry_raw");
    rawScan.material = PbrMaterial::stoneLimestone();

    auto addTier = [&](const Vec3& center, float width, float depth, float height, int uDivs, int vDivs) {
        ScratchboxMesh bBox = ScratchboxMesh::createBox(Vec3(width, height, depth));
        for (auto& v : bBox.vertices) {
            float jitter = std::sin(v.position.x * 0.6f) * std::cos(v.position.z * 0.6f) * 0.08f;
            v.position = v.position + center + v.normal * jitter;
            v.color = Vec4(0.82f, 0.79f, 0.74f, 1.0f);
        }
        uint32_t bOffset = static_cast<uint32_t>(rawScan.vertices.size());
        for (const auto& v : bBox.vertices) rawScan.addVertex(v);
        for (uint32_t idx : bBox.indices) rawScan.indices.push_back(bOffset + idx);
    };

    addTier(Vec3(0, 10, 0), 60.0f, 40.0f, 20.0f, 12, 6);
    addTier(Vec3(0, 40, 0), 46.0f, 30.0f, 40.0f, 10, 8);
    addTier(Vec3(0, 90, 0), 36.0f, 24.0f, 60.0f, 8, 12);
    addTier(Vec3(0, 132.5f, 0), 16.0f, 12.0f, 25.0f, 6, 6);

    rawScan.recomputeNormals();
    rawScan.recomputeBounds();
    return rawScan;
}

int main(int argc, char* argv[]) {
    std::string inputPath = "";
    std::string outputPath = "public/models/field_remeshed_output.glb";
    size_t targetQuads = 2000;
    float creaseAngle = 35.0f;
    bool alignManhattan = true;
    float dominantYaw = 0.0f;
    bool includeWireframe = true;
    bool streamStdout = false;

    for (int i = 1; i < argc; ++i) {
        std::string arg = argv[i];
        if (arg == "--input" && i + 1 < argc) {
            inputPath = argv[++i];
        } else if (arg == "--output" && i + 1 < argc) {
            outputPath = argv[++i];
        } else if (arg == "--quads" && i + 1 < argc) {
            targetQuads = static_cast<size_t>(std::stoul(argv[++i]));
        } else if (arg == "--crease" && i + 1 < argc) {
            creaseAngle = std::stof(argv[++i]);
        } else if (arg == "--manhattan" && i + 1 < argc) {
            alignManhattan = (std::stoi(argv[++i]) != 0);
        } else if (arg == "--yaw" && i + 1 < argc) {
            dominantYaw = std::stof(argv[++i]);
        } else if (arg == "--wireframe" && i + 1 < argc) {
            includeWireframe = (std::stoi(argv[++i]) != 0);
        } else if (arg == "--stream") {
            streamStdout = true;
        }
    }

    if (!streamStdout) {
        std::cout << "======================================================================\n";
        std::cout << "  SCRATCHBOX 3D ENGINE: FIELD-ALIGNED QUAD REMESHER CLI\n";
        std::cout << "======================================================================\n";
    }

    ScratchboxMesh inputMesh;
    if (!inputPath.empty() && inputPath != "benchmark" && fs::exists(inputPath)) {
        if (!streamStdout) std::cout << "Loading input mesh from: " << inputPath << "...\n";
        inputMesh = GlbReader::readGlb(inputPath);
        if (inputMesh.vertices.empty()) {
            std::cerr << "ERROR: Failed to read GLB from " << inputPath << ", falling back to benchmark scan.\n";
            inputMesh = createBenchmarkScan();
        }
    } else {
        if (!streamStdout) std::cout << "No input GLB provided; generating photogrammetric skyscraper benchmark scan...\n";
        inputMesh = createBenchmarkScan();
    }

    QuadRemeshOptions options;
    options.targetQuadCount = targetQuads;
    options.creaseAngleDeg = creaseAngle;
    options.alignToManhattanAxes = alignManhattan;
    options.dominantYawDeg = dominantYaw;
    options.preserveBoundaryEdges = true;
    options.smoothingIterations = 25;
    options.tangentRelaxationPasses = 3;

    RemeshTelemetry telemetry;
    auto tStart = std::chrono::high_resolution_clock::now();

    ScratchboxMesh remeshedMesh = FieldAlignedQuadRemesher::remesh(inputMesh, options, &telemetry);

    ScratchboxMesh combinedOutput;
    combinedOutput.name = remeshedMesh.name;
    combinedOutput.material = remeshedMesh.material;
    for (const auto& v : remeshedMesh.vertices) combinedOutput.addVertex(v);
    for (uint32_t idx : remeshedMesh.indices) combinedOutput.indices.push_back(idx);

    if (includeWireframe) {
        ScratchboxMesh wireMesh = FieldAlignedQuadRemesher::buildQuadWireframe(remeshedMesh, 0.08f);
        uint32_t wireBase = static_cast<uint32_t>(combinedOutput.vertices.size());
        for (const auto& v : wireMesh.vertices) combinedOutput.addVertex(v);
        for (uint32_t idx : wireMesh.indices) combinedOutput.indices.push_back(wireBase + idx);
    }

    auto tEnd = std::chrono::high_resolution_clock::now();
    double totalElapsedMs = std::chrono::duration<double, std::milli>(tEnd - tStart).count();
    telemetry.elapsedMs = totalElapsedMs;

    fs::create_directories(fs::path(outputPath).parent_path());
    std::vector<uint8_t> glbBytes = GlbWriter::writeGlb(combinedOutput);

    std::ofstream outFile(outputPath, std::ios::binary);
    if (outFile.is_open()) {
        outFile.write(reinterpret_cast<const char*>(glbBytes.data()), static_cast<std::streamsize>(glbBytes.size()));
        outFile.close();
    }

    if (!streamStdout) {
        telemetry.printSummary();
        std::cout << "\n[Remesh Output & Telemetry]\n";
        std::cout << "  Input Triangles:         " << telemetry.inputTriangleCount << "\n";
        std::cout << "  Output Quads:            " << telemetry.outputQuadCount << "\n";
        std::cout << "  Output Triangles:        " << (combinedOutput.indices.size() / 3) << "\n";
        std::cout << "  Pure Quad Ratio:         " << (telemetry.pureQuadRatio * 100.0f) << "%\n";
        std::cout << "  Singularities:           " << telemetry.singularityCount << "\n";
        std::cout << "  Mean Aspect Ratio:       " << telemetry.meanQuadAspect << "\n";
        std::cout << "  Mean Corner Orthogonality:" << telemetry.meanOrthogonalityDeg << " deg\n";
        std::cout << "  Max Angle Deviation:     " << telemetry.maxOrthogonalityDeviationDeg << " deg\n";
        std::cout << "  Mean Surface Deviation:  " << (telemetry.meanSurfaceErrorMeters * 1000.0f) << " mm\n";
        std::cout << "  Sharp Crease Edges:      " << telemetry.sharpCreaseEdges << "\n";
        std::cout << "  Remesh Processing Time:  " << telemetry.elapsedMs << " ms\n";
        std::cout << "  Output File:             " << outputPath << " (" << glbBytes.size() << " bytes)\n";
        std::cout << "STATUS: SUCCESS\n";
    } else {
        GlbWriter::streamChunk("field_remeshed_chunk", glbBytes);
    }

    return 0;
}
