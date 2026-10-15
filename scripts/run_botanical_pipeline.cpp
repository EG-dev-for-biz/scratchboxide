/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * Standalone Headless Botanical & Vegetation Synthesis Pipeline CLI
 * Suitable for In-App Native Execution, Service Pipelines, and Cloud Run.
 *
 * Implements Unified Stages 11 through 15:
 * - Stage 11: Excess Green (ExG) Separation, Ground Anchor Pinning, Envelope
 *             Normal Transfer, Facade Clinging Ivy (IvyGen), Streetscape Replacement
 * - Stage 12: Anatomical 3D Leaves (OvateSimple, SerratedBirch, LobedOakMaple)
 *             with Midrib Furrow, Cupping, Margin Serration & Fibonacci Twig Sprays
 * - Stage 13: Strategy B: Direct Mesh-Conformal Attractor Seeding, Allometric
 *             Caliper Laws (Leonardo da Vinci), and Tree vs. Shrub Arborescent Bifurcation
 * - Stage 14: Blob-Informed Foliage Density & Multi-Tier Leaf Architecture
 *             (Apical, Distal Lateral, and Bilateral Opposing Sprays)
 * - Stage 15: Outward-Arching Branch Architecture: Runions Forward Perception Cone,
 *             Centrifugal Outward Radial Momentum, 120-deg Scaffold Limbs, Cantilever Droop,
 *             and Basal Flare Fluting Isolation
 *
 * Streams binary glTF 2.0 (.glb) chunks over stdout or writes to disk.
 *
 * --input <scan.glb> is required. The built-in synthetic benchmark scan runs only when asked for by name
 * (--input benchmark); a missing or unreadable scan, or one without vegetation, is an error (non-zero exit, ERROR: on
 * stderr), never a benchmark or a guessed canopy.
 ********************************************************************************/

#include "scratchbox_engine.hpp"
#include "scratchbox_nature.hpp"
#include "scratchbox_tile_cleanup.hpp"
#include "scratchbox_botanical_pipeline.hpp"
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
using namespace scratchbox::nature;
using namespace scratchbox::io;

// Helper: Generates a realistic photogrammetric streetscape with roadway, sidewalk,
// limestone facade, and a raw melted vegetation blob with high ExG vertex colors.
static ScratchboxMesh createBenchmarkStreetscapeScan() {
    ScratchboxMesh scan("benchmark_streetscape_with_tree_blob");

    // 1. Asphalt Roadway
    ScratchboxMesh road = GeometryBuilder::createPlane(16.0f, 6.0f, 8, 4);
    for (auto& v : road.vertices) {
        v.position.z += 3.0f; // in front of curb
        v.color = Vec4(0.24f, 0.24f, 0.26f, 1.0f); // dark asphalt
    }
    uint32_t roadOffset = static_cast<uint32_t>(scan.vertices.size());
    for (const auto& v : road.vertices) scan.addVertex(v);
    for (uint32_t idx : road.indices) scan.indices.push_back(roadOffset + idx);

    // 2. Concrete Sidewalk
    ScratchboxMesh walk = GeometryBuilder::createPlane(16.0f, 4.0f, 8, 4);
    for (auto& v : walk.vertices) {
        v.position.y += 0.15f; // curb height
        v.position.z -= 2.0f;  // between road and facade
        v.color = Vec4(0.70f, 0.70f, 0.72f, 1.0f); // concrete
    }
    uint32_t walkOffset = static_cast<uint32_t>(scan.vertices.size());
    for (const auto& v : walk.vertices) scan.addVertex(v);
    for (uint32_t idx : walk.indices) scan.indices.push_back(walkOffset + idx);

    // 3. Limestone Building Facade
    ScratchboxMesh facade = GeometryBuilder::createPlane(16.0f, 12.0f, 8, 6);
    for (auto& v : facade.vertices) {
        // Rotate to vertical wall at z = -4.0m
        float oldY = v.position.y;
        v.position.y = v.position.z + 6.0f;
        v.position.z = -4.0f;
        v.normal = Vec3(0, 0, 1);
        v.color = Vec4(0.82f, 0.80f, 0.78f, 1.0f); // limestone
    }
    uint32_t facadeOffset = static_cast<uint32_t>(scan.vertices.size());
    for (const auto& v : facade.vertices) scan.addVertex(v);
    for (uint32_t idx : facade.indices) scan.indices.push_back(facadeOffset + idx);

    // 4. Melted Photogrammetric Tree Blob (ExG > 0.12)
    // Centered on sidewalk at (0, 0.15, -2.0)
    Vec3 crownCenter(0.0f, 5.0f, -2.0f);
    Vec3 crownRadii(2.4f, 3.2f, 2.2f);
    const int stacks = 18;
    const int slices = 24;

    uint32_t blobBase = static_cast<uint32_t>(scan.vertices.size());
    for (int i = 0; i <= stacks; ++i) {
        float phi = (i / static_cast<float>(stacks)) * math::PI;
        for (int j = 0; j <= slices; ++j) {
            float theta = (j / static_cast<float>(slices)) * math::TWO_PI;
            float nx = std::sin(phi) * std::cos(theta);
            float ny = std::cos(phi);
            float nz = std::sin(phi) * std::sin(theta);

            // Jitter to simulate photogrammetric scan surface noise
            float noise = std::sin(nx * 4.0f) * std::cos(ny * 3.0f) * 0.18f;
            Vec3 pos(
                crownCenter.x + nx * (crownRadii.x + noise),
                crownCenter.y + ny * (crownRadii.y + noise),
                crownCenter.z + nz * (crownRadii.z + noise)
            );

            // ExG > 0.12 vegetative color
            Vec4 vegColor(0.18f, 0.58f, 0.14f, 1.0f);
            scan.addVertex(Vertex(pos, Vec3(nx, ny, nz), Vec2(j / (float)slices, i / (float)stacks), vegColor));
        }
    }

    for (int i = 0; i < stacks; ++i) {
        for (int j = 0; j < slices; ++j) {
            uint32_t p0 = blobBase + i * (slices + 1) + j;
            uint32_t p1 = blobBase + (i + 1) * (slices + 1) + j;
            uint32_t p2 = blobBase + (i + 1) * (slices + 1) + (j + 1);
            uint32_t p3 = blobBase + i * (slices + 1) + (j + 1);

            scan.addTriangle(p0, p1, p2);
            scan.addTriangle(p0, p2, p3);
        }
    }

    scan.recomputeBounds();
    return scan;
}

// Helper: Generates a single standalone tree blob scan
static ScratchboxMesh createBenchmarkTreeBlobScan() {
    ScratchboxMesh scan("benchmark_tree_blob");
    Vec3 crownCenter(0.0f, 4.5f, 0.0f);
    Vec3 crownRadii(2.2f, 3.0f, 2.0f);
    const int stacks = 16;
    const int slices = 20;

    for (int i = 0; i <= stacks; ++i) {
        float phi = (i / static_cast<float>(stacks)) * math::PI;
        for (int j = 0; j <= slices; ++j) {
            float theta = (j / static_cast<float>(slices)) * math::TWO_PI;
            float nx = std::sin(phi) * std::cos(theta);
            float ny = std::cos(phi);
            float nz = std::sin(phi) * std::sin(theta);

            float noise = std::sin(nx * 3.0f) * std::cos(ny * 3.0f) * 0.15f;
            Vec3 pos(
                crownCenter.x + nx * (crownRadii.x + noise),
                crownCenter.y + ny * (crownRadii.y + noise),
                crownCenter.z + nz * (crownRadii.z + noise)
            );

            Vec4 vegColor(0.20f, 0.55f, 0.15f, 1.0f);
            scan.addVertex(Vertex(pos, Vec3(nx, ny, nz), Vec2(0, 0), vegColor));
        }
    }

    for (int i = 0; i < stacks; ++i) {
        for (int j = 0; j < slices; ++j) {
            uint32_t p0 = i * (slices + 1) + j;
            uint32_t p1 = (i + 1) * (slices + 1) + j;
            uint32_t p2 = (i + 1) * (slices + 1) + (j + 1);
            uint32_t p3 = i * (slices + 1) + (j + 1);

            scan.addTriangle(p0, p1, p2);
            scan.addTriangle(p0, p2, p3);
        }
    }

    scan.recomputeBounds();
    return scan;
}

int main(int argc, char* argv[]) {
    std::string inputPath = "";
    std::string outputPath = "public/models/botanical_synthesized_output.glb";
    std::string modeStr = "auto";
    std::string leafStr = "lobed";
    float leafSize = 0.32f;
    float densityScale = 1.0f;
    bool enableIvy = false;
    bool includeGhost = false;
    bool streamStdout = false;

    for (int i = 1; i < argc; ++i) {
        std::string arg = argv[i];
        if (arg == "--input" && i + 1 < argc) {
            inputPath = argv[++i];
        } else if (arg == "--output" && i + 1 < argc) {
            outputPath = argv[++i];
        } else if (arg == "--mode" && i + 1 < argc) {
            modeStr = argv[++i];
        } else if (arg == "--leaf" && i + 1 < argc) {
            leafStr = argv[++i];
        } else if (arg == "--leaf-size" && i + 1 < argc) {
            leafSize = std::stof(argv[++i]);
        } else if (arg == "--density" && i + 1 < argc) {
            densityScale = std::stof(argv[++i]);
        } else if (arg == "--ivy" && i + 1 < argc) {
            enableIvy = (std::stoi(argv[++i]) != 0);
        } else if (arg == "--ghost" && i + 1 < argc) {
            includeGhost = (std::stoi(argv[++i]) != 0);
        } else if (arg == "--stream") {
            streamStdout = true;
        }
    }

    if (!streamStdout) {
        std::cout << "======================================================================\n";
        std::cout << "  SCRATCHBOX 3D ENGINE: UNIFIED BOTANICAL & VEGETATION PIPELINE CLI\n";
        std::cout << "======================================================================\n";
    }

    BotanicalPipelineOptions options;
    if (modeStr == "tree") options.mode = BotanicalPipelineMode::Tree;
    else if (modeStr == "shrub") options.mode = BotanicalPipelineMode::Shrub;
    else if (modeStr == "streetscape") options.mode = BotanicalPipelineMode::IntegratedStreetscape;
    else options.mode = BotanicalPipelineMode::AutoDetect;

    if (leafStr == "ovate") options.leafMorphology = LeafMorphology::OvateSimple;
    else if (leafStr == "serrated") options.leafMorphology = LeafMorphology::SerratedBirch;
    else options.leafMorphology = LeafMorphology::LobedOakMaple;

    options.leafSize = leafSize;
    options.leafDensityScale = densityScale;
    options.enableIvy = enableIvy;
    options.includeGhostOverlay = includeGhost;

    if (enableIvy) {
        options.ivyConfig.rootPosition = Vec3(0.0f, 0.15f, -3.8f);
        options.ivyConfig.obstacleMin = Vec3(-8.0f, 0.0f, -4.2f);
        options.ivyConfig.obstacleMax = Vec3( 8.0f, 12.0f, -3.8f);
        options.ivyConfig.maxSteps = 90;
        options.ivyConfig.stepLength = 0.16f;
        options.ivyConfig.clingDistance = 0.25f;
        options.ivyConfig.maxBranches = 12;
    }

    ScratchboxMesh inputMesh;
    if (inputPath.empty()) {
        std::cerr << "ERROR: --input <scan.glb> is required (or --input benchmark for the built-in synthetic benchmark scan)\n";
        return 2;
    }
    if (inputPath == "benchmark") {
        if (!streamStdout) std::cout << "Input: built-in synthetic benchmark scan (asked for by name)\n";
        inputMesh = (options.mode == BotanicalPipelineMode::IntegratedStreetscape) ?
                    createBenchmarkStreetscapeScan() : createBenchmarkTreeBlobScan();
    } else {
        if (!fs::exists(inputPath)) {
            std::cerr << "ERROR: scan not found: " << inputPath << "\n";
            return 2;
        }
        if (!streamStdout) std::cout << "Loading input mesh from: " << inputPath << "...\n";
        inputMesh = GlbReader::readGlb(inputPath);
        if (inputMesh.vertices.empty()) {
            std::cerr << "ERROR: could not read any geometry from " << inputPath << "\n";
            return 3;
        }
    }

    BotanicalPipelineResult result;
    try {
        if (options.mode == BotanicalPipelineMode::IntegratedStreetscape) {
            result = BotanicalSynthesisPipeline::synthesizeStreetscape(inputMesh, options);
        } else {
            result = BotanicalSynthesisPipeline::runPipeline(inputMesh, options);
        }
    } catch (const std::exception& e) {
        std::cerr << "ERROR: " << e.what() << "\n";
        return 4;
    }

    if (!fs::path(outputPath).parent_path().empty()) fs::create_directories(fs::path(outputPath).parent_path());
    std::vector<uint8_t> glbBytes = GlbWriter::writeGlb(result.combinedMesh);

    {
        std::ofstream outFile(outputPath, std::ios::binary);
        if (!outFile.is_open()) {
            std::cerr << "ERROR: could not write " << outputPath << "\n";
            return 5;
        }
        outFile.write(reinterpret_cast<const char*>(glbBytes.data()), static_cast<std::streamsize>(glbBytes.size()));
        outFile.close();
        if (!outFile) {
            std::cerr << "ERROR: could not write " << outputPath << "\n";
            return 5;
        }
    }

    if (!streamStdout) {
        result.telemetry.printSummary();
        std::cout << "\n[Botanical Pipeline Output & Telemetry]\n";
        std::cout << "  Vegetation Mode:         " << modeStr << "\n";
        std::cout << "  Leaf Morphology:         " << leafStr << "\n";
        std::cout << "  Total Height:            " << result.telemetry.totalHeight << " m\n";
        std::cout << "  Clear Trunk Height:      " << result.telemetry.clearTrunkHeight << " m\n";
        std::cout << "  Crown Base Height:       " << result.telemetry.crownBaseHeight << " m\n";
        std::cout << "  Crown Height:            " << result.telemetry.crownHeight << " m\n";
        std::cout << "  Volumetric Density:      " << result.telemetry.volumetricDensity << "\n";
        std::cout << "  Base Caliper:            " << (result.telemetry.suggestedBaseCaliper * 2.0f * 100.0f) << " cm dia\n";
        std::cout << "  Leaves Per Tip:          " << result.telemetry.suggestedLeavesPerTip << "\n";
        std::cout << "  Output Vertices:         " << result.combinedMesh.vertices.size() << "\n";
        std::cout << "  Output Triangles:        " << (result.combinedMesh.indices.size() / 3) << "\n";
        std::cout << "  Processing Runtime:      " << result.telemetry.elapsedMs << " ms\n";
        std::cout << "  Output File:             " << outputPath << " (" << glbBytes.size() << " bytes)\n";
        std::cout << "STATUS: SUCCESS\n";
    } else {
        GlbWriter::streamChunk("botanical_synthesized_chunk", glbBytes);
    }

    return 0;
}
