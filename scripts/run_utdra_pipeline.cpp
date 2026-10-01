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
// Benchmark Mesh Generators (for zero-dependency testing & self-validation)
// ============================================================================

static ScratchboxMesh createSkyscraperBenchmark(float width = 40.0f, float depth = 60.0f, float height = 180.0f) {
    ScratchboxMesh mesh("SkyscraperBenchmark");
    float hw = width * 0.5f;
    float hd = depth * 0.5f;

    auto addQuad = [&](Vec3 p0, Vec3 p1, Vec3 p2, Vec3 p3, Vec3 norm, Vec4 col) {
        uint32_t base = static_cast<uint32_t>(mesh.vertices.size());
        mesh.addVertex(Vertex(p0, norm, Vec2(0, 0), col));
        mesh.addVertex(Vertex(p1, norm, Vec2(1, 0), col));
        mesh.addVertex(Vertex(p2, norm, Vec2(1, 1), col));
        mesh.addVertex(Vertex(p3, norm, Vec2(0, 1), col));
        mesh.indices.push_back(base);
        mesh.indices.push_back(base + 1);
        mesh.indices.push_back(base + 2);
        mesh.indices.push_back(base);
        mesh.indices.push_back(base + 2);
        mesh.indices.push_back(base + 3);
    };

    // Tier 1: Base podium (0 to 0.3 * height)
    float h1 = height * 0.3f;
    Vec4 colLimestone(0.82f, 0.80f, 0.76f, 1.0f);
    addQuad(Vec3(-hw, 0, -hd), Vec3(hw, 0, -hd), Vec3(hw, h1, -hd), Vec3(-hw, h1, -hd), Vec3(0, 0, -1), colLimestone);
    addQuad(Vec3(hw, 0, hd), Vec3(-hw, 0, hd), Vec3(-hw, h1, hd), Vec3(hw, h1, hd), Vec3(0, 0, 1), colLimestone);
    addQuad(Vec3(-hw, 0, hd), Vec3(-hw, 0, -hd), Vec3(-hw, h1, -hd), Vec3(-hw, h1, hd), Vec3(-1, 0, 0), colLimestone);
    addQuad(Vec3(hw, 0, -hd), Vec3(hw, 0, hd), Vec3(hw, h1, hd), Vec3(hw, h1, -hd), Vec3(1, 0, 0), colLimestone);
    addQuad(Vec3(-hw, h1, -hd), Vec3(hw, h1, -hd), Vec3(hw, h1, hd), Vec3(-hw, h1, hd), Vec3(0, 1, 0), Vec4(0.3f, 0.3f, 0.35f, 1.0f));

    // Tier 2: Main tower shaft (h1 to 0.8 * height)
    float hw2 = hw * 0.75f;
    float hd2 = hd * 0.75f;
    float h2 = height * 0.8f;
    addQuad(Vec3(-hw2, h1, -hd2), Vec3(hw2, h1, -hd2), Vec3(hw2, h2, -hd2), Vec3(-hw2, h2, -hd2), Vec3(0, 0, -1), colLimestone);
    addQuad(Vec3(hw2, h1, hd2), Vec3(-hw2, h1, hd2), Vec3(-hw2, h2, hd2), Vec3(hw2, h2, hd2), Vec3(0, 0, 1), colLimestone);
    addQuad(Vec3(-hw2, h1, hd2), Vec3(-hw2, h1, -hd2), Vec3(-hw2, h2, -hd2), Vec3(-hw2, h2, hd2), Vec3(-1, 0, 0), colLimestone);
    addQuad(Vec3(hw2, h1, -hd2), Vec3(hw2, h1, hd2), Vec3(hw2, h2, hd2), Vec3(hw2, h2, -hd2), Vec3(1, 0, 0), colLimestone);
    addQuad(Vec3(-hw2, h2, -hd2), Vec3(hw2, h2, -hd2), Vec3(hw2, h2, hd2), Vec3(-hw2, h2, hd2), Vec3(0, 1, 0), Vec4(0.3f, 0.3f, 0.35f, 1.0f));

    // Tier 3: Upper tower shaft (h2 to height)
    float hw3 = hw * 0.5f;
    float hd3 = hd * 0.5f;
    addQuad(Vec3(-hw3, h2, -hd3), Vec3(hw3, h2, -hd3), Vec3(hw3, height, -hd3), Vec3(-hw3, height, -hd3), Vec3(0, 0, -1), colLimestone);
    addQuad(Vec3(hw3, h2, hd3), Vec3(-hw3, h2, hd3), Vec3(-hw3, height, hd3), Vec3(hw3, height, hd3), Vec3(0, 0, 1), colLimestone);
    addQuad(Vec3(-hw3, h2, hd3), Vec3(-hw3, h2, -hd3), Vec3(-hw3, height, -hd3), Vec3(-hw3, height, hd3), Vec3(-1, 0, 0), colLimestone);
    addQuad(Vec3(hw3, h2, -hd3), Vec3(hw3, h2, hd3), Vec3(hw3, height, hd3), Vec3(hw3, height, -hd3), Vec3(1, 0, 0), colLimestone);
    addQuad(Vec3(-hw3, height, -hd3), Vec3(hw3, height, -hd3), Vec3(hw3, height, hd3), Vec3(-hw3, height, hd3), Vec3(0, 1, 0), Vec4(0.25f, 0.25f, 0.28f, 1.0f));

    mesh.recomputeNormals();
    mesh.recomputeBounds();
    return mesh;
}

static ScratchboxMesh createSuburbanBenchmark(float width = 12.0f, float depth = 16.0f, float wallHeight = 4.5f, float ridgeHeight = 7.5f) {
    ScratchboxMesh mesh("SuburbanHouseBenchmark");
    float hw = width * 0.5f;
    float hd = depth * 0.5f;

    auto addQuad = [&](Vec3 p0, Vec3 p1, Vec3 p2, Vec3 p3, Vec3 norm, Vec4 col) {
        uint32_t base = static_cast<uint32_t>(mesh.vertices.size());
        mesh.addVertex(Vertex(p0, norm, Vec2(0, 0), col));
        mesh.addVertex(Vertex(p1, norm, Vec2(1, 0), col));
        mesh.addVertex(Vertex(p2, norm, Vec2(1, 1), col));
        mesh.addVertex(Vertex(p3, norm, Vec2(0, 1), col));
        mesh.indices.push_back(base);
        mesh.indices.push_back(base + 1);
        mesh.indices.push_back(base + 2);
        mesh.indices.push_back(base);
        mesh.indices.push_back(base + 2);
        mesh.indices.push_back(base + 3);
    };

    Vec4 sidingCol(0.88f, 0.85f, 0.80f, 1.0f);
    Vec4 roofCol(0.28f, 0.29f, 0.32f, 1.0f);
    Vec4 lawnCol(0.22f, 0.55f, 0.18f, 1.0f);

    addQuad(Vec3(-hw * 1.8f, 0, -hd * 1.8f), Vec3(hw * 1.8f, 0, -hd * 1.8f),
            Vec3(hw * 1.8f, 0, hd * 1.8f), Vec3(-hw * 1.8f, 0, hd * 1.8f), Vec3(0, 1, 0), lawnCol);

    addQuad(Vec3(-hw, 0, -hd), Vec3(hw, 0, -hd), Vec3(hw, wallHeight, -hd), Vec3(-hw, wallHeight, -hd), Vec3(0, 0, -1), sidingCol);
    addQuad(Vec3(hw, 0, hd), Vec3(-hw, 0, hd), Vec3(-hw, wallHeight, hd), Vec3(hw, wallHeight, hd), Vec3(0, 0, 1), sidingCol);
    addQuad(Vec3(-hw, 0, hd), Vec3(-hw, 0, -hd), Vec3(-hw, wallHeight, -hd), Vec3(-hw, wallHeight, hd), Vec3(-1, 0, 0), sidingCol);
    addQuad(Vec3(hw, 0, -hd), Vec3(hw, 0, hd), Vec3(hw, wallHeight, hd), Vec3(hw, wallHeight, -hd), Vec3(1, 0, 0), sidingCol);

    auto addTri = [&](Vec3 p0, Vec3 p1, Vec3 p2, Vec3 norm, Vec4 col) {
        uint32_t b = static_cast<uint32_t>(mesh.vertices.size());
        mesh.addVertex(Vertex(p0, norm, Vec2(0, 0), col));
        mesh.addVertex(Vertex(p1, norm, Vec2(1, 0), col));
        mesh.addVertex(Vertex(p2, norm, Vec2(0.5f, 1.0f), col));
        mesh.indices.push_back(b); mesh.indices.push_back(b + 1); mesh.indices.push_back(b + 2);
    };

    addTri(Vec3(-hw, wallHeight, -hd), Vec3(hw, wallHeight, -hd), Vec3(0, ridgeHeight, -hd), Vec3(0, 0, -1), sidingCol);
    addTri(Vec3(hw, wallHeight, hd), Vec3(-hw, wallHeight, hd), Vec3(0, ridgeHeight, hd), Vec3(0, 0, 1), sidingCol);

    Vec3 nSlope1 = Vec3(0, hw, ridgeHeight - wallHeight).cross(Vec3(1, 0, 0)).normalized();
    Vec3 nSlope2 = Vec3(0, -hw, ridgeHeight - wallHeight).cross(Vec3(-1, 0, 0)).normalized();

    addQuad(Vec3(-hw - 0.4f, wallHeight, -hd - 0.4f), Vec3(0, ridgeHeight + 0.2f, -hd - 0.4f),
            Vec3(0, ridgeHeight + 0.2f, hd + 0.4f), Vec3(-hw - 0.4f, wallHeight, hd + 0.4f), nSlope1, roofCol);
    addQuad(Vec3(0, ridgeHeight + 0.2f, -hd - 0.4f), Vec3(hw + 0.4f, wallHeight, -hd - 0.4f),
            Vec3(hw + 0.4f, wallHeight, hd + 0.4f), Vec3(0, ridgeHeight + 0.2f, hd + 0.4f), nSlope2, roofCol);

    mesh.recomputeNormals();
    mesh.recomputeBounds();
    return mesh;
}

static ScratchboxMesh createBridgeBenchmark() {
    ScratchboxMesh mesh("BridgeBenchmark");
    // Horizontal deck at y = 12.0m
    uint32_t b0 = static_cast<uint32_t>(mesh.vertices.size());
    mesh.addVertex(Vertex(Vec3(-10, 12, -2), Vec3(0, 1, 0), Vec2(0, 0), Vec4(0.35f, 0.35f, 0.38f, 1.0f)));
    mesh.addVertex(Vertex(Vec3( 10, 12, -2), Vec3(0, 1, 0), Vec2(1, 0), Vec4(0.35f, 0.35f, 0.38f, 1.0f)));
    mesh.addVertex(Vertex(Vec3( 10, 12,  2), Vec3(0, 1, 0), Vec2(1, 1), Vec4(0.35f, 0.35f, 0.38f, 1.0f)));
    mesh.indices.push_back(b0); mesh.indices.push_back(b0 + 1); mesh.indices.push_back(b0 + 2);

    // False photogrammetric vertical curtain wall from y = 0 to y = 12m
    uint32_t b1 = static_cast<uint32_t>(mesh.vertices.size());
    mesh.addVertex(Vertex(Vec3(-10, 0, 0), Vec3(0, 0, 1), Vec2(0, 0), Vec4(0.6f, 0.4f, 0.3f, 1.0f)));
    mesh.addVertex(Vertex(Vec3( 10, 0, 0), Vec3(0, 0, 1), Vec2(1, 0), Vec4(0.6f, 0.4f, 0.3f, 1.0f)));
    mesh.addVertex(Vertex(Vec3( 10, 12, 0), Vec3(0, 0, 1), Vec2(1, 1), Vec4(0.6f, 0.4f, 0.3f, 1.0f)));
    mesh.indices.push_back(b1); mesh.indices.push_back(b1 + 1); mesh.indices.push_back(b1 + 2);

    mesh.recomputeBounds();
    return mesh;
}

static ScratchboxMesh createAlpineBenchmark(float baseSpan = 150.0f, float height = 220.0f) {
    ScratchboxMesh mesh("AlpineCliffBenchmark");
    int resX = 8, resZ = 8;
    for (int z = 0; z <= resZ; ++z) {
        float fz = static_cast<float>(z) / static_cast<float>(resZ);
        float pz = (fz - 0.5f) * baseSpan;
        for (int x = 0; x <= resX; ++x) {
            float fx = static_cast<float>(x) / static_cast<float>(resX);
            float px = (fx - 0.5f) * baseSpan;
            float py = 0.0f;
            if (fz > 0.4f) {
                float cliffT = (fz - 0.4f) / 0.6f;
                py = std::pow(cliffT, 1.8f) * height;
            }
            Vec3 norm(0, 1, 0);
            if (fz > 0.4f) norm = Vec3(0, 0.45f, -0.89f).normalized();
            mesh.addVertex(Vertex(Vec3(px, py, pz), norm, Vec2(fx, fz), Vec4(0.5f, 0.5f, 0.5f, 1.0f)));
        }
    }
    for (int z = 0; z < resZ; ++z) {
        for (int x = 0; x < resX; ++x) {
            uint32_t i0 = z * (resX + 1) + x;
            uint32_t i1 = i0 + 1;
            uint32_t i2 = (z + 1) * (resX + 1) + x;
            uint32_t i3 = i2 + 1;
            mesh.indices.push_back(i0); mesh.indices.push_back(i2); mesh.indices.push_back(i1);
            mesh.indices.push_back(i1); mesh.indices.push_back(i2); mesh.indices.push_back(i3);
        }
    }
    mesh.recomputeNormals();
    mesh.recomputeBounds();
    return mesh;
}

static ScratchboxMesh createForestBenchmark() {
    ScratchboxMesh mesh("ForestBenchmark");
    for (int cluster = 0; cluster < 6; ++cluster) {
        float cx = (cluster % 3 - 1) * 12.0f;
        float cz = (cluster / 3 - 0.5f) * 12.0f;
        float trunkH = 10.0f + (cluster % 2) * 3.0f;

        uint32_t tBase = static_cast<uint32_t>(mesh.vertices.size());
        mesh.addVertex(Vertex(Vec3(cx - 0.4f, 0, cz), Vec3(1, 0, 0), Vec2(0, 0), Vec4(0.38f, 0.25f, 0.15f, 1.0f)));
        mesh.addVertex(Vertex(Vec3(cx + 0.4f, 0, cz), Vec3(1, 0, 0), Vec2(1, 0), Vec4(0.38f, 0.25f, 0.15f, 1.0f)));
        mesh.addVertex(Vertex(Vec3(cx + 0.3f, trunkH, cz), Vec3(1, 0, 0), Vec2(1, 1), Vec4(0.38f, 0.25f, 0.15f, 1.0f)));
        mesh.addVertex(Vertex(Vec3(cx - 0.3f, trunkH, cz), Vec3(1, 0, 0), Vec2(0, 1), Vec4(0.38f, 0.25f, 0.15f, 1.0f)));
        mesh.indices.push_back(tBase); mesh.indices.push_back(tBase + 1); mesh.indices.push_back(tBase + 2);
        mesh.indices.push_back(tBase); mesh.indices.push_back(tBase + 2); mesh.indices.push_back(tBase + 3);

        for (int i = 0; i < 16; ++i) {
            float phi = (i / 16.0f) * TWO_PI;
            float r = 4.5f + std::sin(phi * 3.0f) * 0.8f;
            uint32_t fBase = static_cast<uint32_t>(mesh.vertices.size());
            Vec3 p0(cx, trunkH + 4.0f, cz);
            Vec3 p1(cx + std::cos(phi) * r, trunkH + 1.0f, cz + std::sin(phi) * r);
            float nextPhi = ((i + 1) / 16.0f) * TWO_PI;
            Vec3 p2(cx + std::cos(nextPhi) * r, trunkH + 1.0f, cz + std::sin(nextPhi) * r);
            Vec4 folCol(0.12f, 0.68f, 0.18f, 1.0f);
            mesh.addVertex(Vertex(p0, Vec3(0, 1, 0), Vec2(0.5f, 1), folCol));
            mesh.addVertex(Vertex(p1, (p1 - Vec3(cx, trunkH, cz)).normalized(), Vec2(0, 0), folCol));
            mesh.addVertex(Vertex(p2, (p2 - Vec3(cx, trunkH, cz)).normalized(), Vec2(1, 0), folCol));
            mesh.indices.push_back(fBase); mesh.indices.push_back(fBase + 1); mesh.indices.push_back(fBase + 2);
        }
    }
    mesh.recomputeBounds();
    return mesh;
}

// ============================================================================
// CLI Main Entry Point
// ============================================================================

int main(int argc, char* argv[]) {
    std::string inputPath = "";
    std::string outputPath = "public/models/utdra_output.glb";
    std::string mode = "full"; // full | probe | slicer | bridge | terrain
    std::string benchmark = ""; // urban | suburban | bridge | mountain | forest | slicer | hybrid
    float sliceY = 5.0f;
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
        } else if (arg == "--benchmark" && i + 1 < argc) {
            benchmark = argv[++i];
        } else if (arg == "--sliceY" && i + 1 < argc) {
            sliceY = std::stof(argv[++i]);
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
        }
    }

    if (!streamStdout) {
        std::cout << "======================================================================\n";
        std::cout << "  SCRATCHBOX 3D ENGINE: UTDRA / ULDRA PIPELINE RUNNER (C++20)\n";
        std::cout << "======================================================================\n";
    }

    auto startTime = std::chrono::high_resolution_clock::now();

    // 1. Resolve or Generate Input Mesh
    ScratchboxMesh inputMesh;
    if (!inputPath.empty() && fs::exists(inputPath)) {
        if (!streamStdout) std::cout << "  [Input] Ingesting GLB: " << inputPath << "\n";
        inputMesh = GlbReader::readGlb(inputPath);
    } else if (!benchmark.empty()) {
        if (!streamStdout) std::cout << "  [Input] Synthesizing Benchmark: " << benchmark << "\n";
        if (benchmark == "urban") inputMesh = createSkyscraperBenchmark();
        else if (benchmark == "suburban") inputMesh = createSuburbanBenchmark();
        else if (benchmark == "bridge") inputMesh = createBridgeBenchmark();
        else if (benchmark == "mountain") inputMesh = createAlpineBenchmark();
        else if (benchmark == "forest") inputMesh = createForestBenchmark();
        else if (benchmark == "hybrid") inputMesh = createSkyscraperBenchmark(50.0f, 70.0f, 220.0f);
        else inputMesh = createSkyscraperBenchmark();
    } else {
        // Default to Skyscraper benchmark
        inputMesh = createSkyscraperBenchmark();
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
            outputMesh = inputMesh;
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
        fs::create_directories(fs::path(outputPath).parent_path());
        std::ofstream outFile(outputPath, std::ios::binary);
        if (outFile.is_open()) {
            outFile.write(reinterpret_cast<const char*>(glbData.data()), glbData.size());
            outFile.close();
            std::cout << "  [Output] Wrote " << glbData.size() << " bytes to " << outputPath << "\n";
        }
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
