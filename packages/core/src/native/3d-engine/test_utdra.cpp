/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

#include "scratchbox_engine.hpp"
#include <cassert>
#include <iostream>
#include <fstream>
#include <filesystem>
#include <vector>
#include <cmath>

namespace fs = std::filesystem;

using namespace scratchbox;
using namespace scratchbox::geometry;
using namespace scratchbox::math;
using namespace scratchbox::utdra;

// Helper to write GLB to file
void writeGlbFile(const std::string& path, const ScratchboxMesh& mesh) {
    fs::create_directories(fs::path(path).parent_path());
    std::vector<uint8_t> bytes = io::GlbWriter::writeGlb(mesh);
    std::ofstream out(path, std::ios::binary);
    if (out.is_open()) {
        out.write(reinterpret_cast<const char*>(bytes.data()), static_cast<std::streamsize>(bytes.size()));
        out.close();
        std::cout << "  [GLB Export] Wrote " << bytes.size() << " bytes to " << path << std::endl;
    } else {
        std::cerr << "  [GLB Export] Failed to open " << path << std::endl;
    }
}

// Helper to create a vertical skyscraper box with setback tiers
ScratchboxMesh createSkyscraperMesh(float width, float depth, float height) {
    ScratchboxMesh mesh("Skyscraper");
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
    // Setback terrace 1
    addQuad(Vec3(-hw, h1, -hd), Vec3(hw, h1, -hd), Vec3(hw, h1, hd), Vec3(-hw, h1, hd), Vec3(0, 1, 0), Vec4(0.3f, 0.3f, 0.35f, 1.0f));

    // Tier 2: Main tower shaft (h1 to 0.8 * height)
    float hw2 = hw * 0.75f;
    float hd2 = hd * 0.75f;
    float h2 = height * 0.8f;
    addQuad(Vec3(-hw2, h1, -hd2), Vec3(hw2, h1, -hd2), Vec3(hw2, h2, -hd2), Vec3(-hw2, h2, -hd2), Vec3(0, 0, -1), colLimestone);
    addQuad(Vec3(hw2, h1, hd2), Vec3(-hw2, h1, hd2), Vec3(-hw2, h2, hd2), Vec3(hw2, h2, hd2), Vec3(0, 0, 1), colLimestone);
    addQuad(Vec3(-hw2, h1, hd2), Vec3(-hw2, h1, -hd2), Vec3(-hw2, h2, -hd2), Vec3(-hw2, h2, hd2), Vec3(-1, 0, 0), colLimestone);
    addQuad(Vec3(hw2, h1, -hd2), Vec3(hw2, h1, hd2), Vec3(hw2, h2, hd2), Vec3(hw2, h2, -hd2), Vec3(1, 0, 0), colLimestone);
    // Setback terrace 2
    addQuad(Vec3(-hw2, h2, -hd2), Vec3(hw2, h2, -hd2), Vec3(hw2, h2, hd2), Vec3(-hw2, h2, hd2), Vec3(0, 1, 0), Vec4(0.3f, 0.3f, 0.35f, 1.0f));

    // Tier 3: Upper tower shaft (h2 to height)
    float hw3 = hw * 0.5f;
    float hd3 = hd * 0.5f;
    addQuad(Vec3(-hw3, h2, -hd3), Vec3(hw3, h2, -hd3), Vec3(hw3, height, -hd3), Vec3(-hw3, height, -hd3), Vec3(0, 0, -1), colLimestone);
    addQuad(Vec3(hw3, h2, hd3), Vec3(-hw3, h2, hd3), Vec3(-hw3, height, hd3), Vec3(hw3, height, hd3), Vec3(0, 0, 1), colLimestone);
    addQuad(Vec3(-hw3, h2, hd3), Vec3(-hw3, h2, -hd3), Vec3(-hw3, height, -hd3), Vec3(-hw3, height, hd3), Vec3(-1, 0, 0), colLimestone);
    addQuad(Vec3(hw3, h2, -hd3), Vec3(hw3, h2, hd3), Vec3(hw3, height, hd3), Vec3(hw3, height, -hd3), Vec3(1, 0, 0), colLimestone);
    // Roof deck
    addQuad(Vec3(-hw3, height, -hd3), Vec3(hw3, height, -hd3), Vec3(hw3, height, hd3), Vec3(-hw3, height, hd3), Vec3(0, 1, 0), Vec4(0.25f, 0.25f, 0.28f, 1.0f));

    return mesh;
}

// Helper to create a suburban pitched roof house
ScratchboxMesh createSuburbanHouseMesh(float width, float depth, float wallHeight, float ridgeHeight) {
    ScratchboxMesh mesh("SuburbanHouse");
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
    Vec4 roofCol(0.28f, 0.29f, 0.32f, 1.0f); // Slate grey shingle
    Vec4 lawnCol(0.22f, 0.55f, 0.18f, 1.0f); // Suburban lawn

    // Green yard base
    addQuad(Vec3(-hw * 1.8f, 0, -hd * 1.8f), Vec3(hw * 1.8f, 0, -hd * 1.8f),
            Vec3(hw * 1.8f, 0, hd * 1.8f), Vec3(-hw * 1.8f, 0, hd * 1.8f), Vec3(0, 1, 0), lawnCol);

    // 4 vertical walls
    addQuad(Vec3(-hw, 0, -hd), Vec3(hw, 0, -hd), Vec3(hw, wallHeight, -hd), Vec3(-hw, wallHeight, -hd), Vec3(0, 0, -1), sidingCol);
    addQuad(Vec3(hw, 0, hd), Vec3(-hw, 0, hd), Vec3(-hw, wallHeight, hd), Vec3(hw, wallHeight, hd), Vec3(0, 0, 1), sidingCol);
    addQuad(Vec3(-hw, 0, hd), Vec3(-hw, 0, -hd), Vec3(-hw, wallHeight, -hd), Vec3(-hw, wallHeight, hd), Vec3(-1, 0, 0), sidingCol);
    addQuad(Vec3(hw, 0, -hd), Vec3(hw, 0, hd), Vec3(hw, wallHeight, hd), Vec3(hw, wallHeight, -hd), Vec3(1, 0, 0), sidingCol);

    // Gable roof triangles (front and back gables)
    auto addTri = [&](Vec3 p0, Vec3 p1, Vec3 p2, Vec3 norm, Vec4 col) {
        uint32_t b = static_cast<uint32_t>(mesh.vertices.size());
        mesh.addVertex(Vertex(p0, norm, Vec2(0, 0), col));
        mesh.addVertex(Vertex(p1, norm, Vec2(1, 0), col));
        mesh.addVertex(Vertex(p2, norm, Vec2(0.5f, 1.0f), col));
        mesh.indices.push_back(b); mesh.indices.push_back(b + 1); mesh.indices.push_back(b + 2);
    };

    addTri(Vec3(-hw, wallHeight, -hd), Vec3(hw, wallHeight, -hd), Vec3(0, ridgeHeight, -hd), Vec3(0, 0, -1), sidingCol);
    addTri(Vec3(hw, wallHeight, hd), Vec3(-hw, wallHeight, hd), Vec3(0, ridgeHeight, hd), Vec3(0, 0, 1), sidingCol);

    // Gable pitched roof slopes (35 deg incline)
    Vec3 nSlope1 = Vec3(0, hw, ridgeHeight - wallHeight).cross(Vec3(1, 0, 0)).normalized();
    Vec3 nSlope2 = Vec3(0, -hw, ridgeHeight - wallHeight).cross(Vec3(-1, 0, 0)).normalized();

    addQuad(Vec3(-hw - 0.4f, wallHeight, -hd - 0.4f), Vec3(0, ridgeHeight + 0.2f, -hd - 0.4f),
            Vec3(0, ridgeHeight + 0.2f, hd + 0.4f), Vec3(-hw - 0.4f, wallHeight, hd + 0.4f), nSlope1, roofCol);
    addQuad(Vec3(0, ridgeHeight + 0.2f, -hd - 0.4f), Vec3(hw + 0.4f, wallHeight, -hd - 0.4f),
            Vec3(hw + 0.4f, wallHeight, hd + 0.4f), Vec3(0, ridgeHeight + 0.2f, hd + 0.4f), nSlope2, roofCol);

    return mesh;
}

// Helper to create an alpine mountain cliff mesh with multi-resolution terrain
ScratchboxMesh createAlpineCliffMesh(float baseSpan, float height) {
    ScratchboxMesh mesh("AlpineCliff");

    // Grid of mountain elevation with varied slopes
    int resX = 8;
    int resZ = 8;
    for (int z = 0; z <= resZ; ++z) {
        float fz = static_cast<float>(z) / static_cast<float>(resZ);
        float pz = (fz - 0.5f) * baseSpan;

        for (int x = 0; x <= resX; ++x) {
            float fx = static_cast<float>(x) / static_cast<float>(resX);
            float px = (fx - 0.5f) * baseSpan;

            // Height profile: steep central cliff, talus fan, and valley bottom
            float py = 0.0f;
            if (fz > 0.4f) {
                float cliffT = (fz - 0.4f) / 0.6f;
                py = std::pow(cliffT, 1.8f) * height; // Steep non-linear cliff
            }

            // Normal approximation
            Vec3 norm(0, 1, 0);
            if (fz > 0.4f) {
                norm = Vec3(0, 0.45f, -0.89f).normalized();
            }

            // Initial neutral color, to be colored by slope-stratified biomes
            mesh.addVertex(Vertex(Vec3(px, py, pz), norm, Vec2(fx, fz), Vec4(0.5f, 0.5f, 0.5f, 1.0f)));
        }
    }

    for (int z = 0; z < resZ; ++z) {
        for (int x = 0; x < resX; ++x) {
            uint32_t i0 = z * (resX + 1) + x;
            uint32_t i1 = i0 + 1;
            uint32_t i2 = (z + 1) * (resX + 1) + x;
            uint32_t i3 = i2 + 1;

            mesh.indices.push_back(i0);
            mesh.indices.push_back(i2);
            mesh.indices.push_back(i1);

            mesh.indices.push_back(i1);
            mesh.indices.push_back(i2);
            mesh.indices.push_back(i3);
        }
    }

    // Recompute accurate smooth normals
    mesh.recomputeNormals();
    return mesh;
}

int main() {
    std::cout << "======================================================================\n";
    std::cout << "  RUNNING SCRATCHBOX UTDRA ENGINE VERIFICATION SUITE (C++20)\n";
    std::cout << "======================================================================\n";

    // ------------------------------------------------------------------------
    // Test 1: Sutherland-Hodgman Non-Destructive Triangle Slicing
    // ------------------------------------------------------------------------
    std::cout << "\n[TEST 1] Sutherland-Hodgman Triangle Plane Slicer...\n";
    {
        Vertex vTop(Vec3(0, 10.0f, 0), Vec3(0, 1, 0), Vec2(0.5f, 1.0f), Vec4(1, 1, 1, 1));
        Vertex vBot1(Vec3(-5.0f, 0.0f, 0), Vec3(0, 1, 0), Vec2(0.0f, 0.0f), Vec4(1, 1, 1, 1));
        Vertex vBot2(Vec3(5.0f, 0.0f, 0), Vec3(0, 1, 0), Vec2(1.0f, 0.0f), Vec4(1, 1, 1, 1));

        std::vector<SutherlandHodgmanSlicer::Triangle> clipped;
        SutherlandHodgmanSlicer::clipTriangleAboveElevation(vTop, vBot1, vBot2, 5.0f, clipped);

        assert(clipped.size() == 1);
        assert(std::abs(clipped[0].v0.position.y - 10.0f) < 1e-4f);
        assert(std::abs(clipped[0].v1.position.y - 5.0f) < 1e-4f);
        assert(std::abs(clipped[0].v2.position.y - 5.0f) < 1e-4f);
        std::cout << "  -> PASS: 1-above case sliced into 1 triangle with exact boundary interpolation at y = 5.0m\n";

        Vertex vTop1(Vec3(-5.0f, 10.0f, 0), Vec3(0, 1, 0), Vec2(0.0f, 1.0f), Vec4(1, 1, 1, 1));
        Vertex vTop2(Vec3(5.0f, 10.0f, 0), Vec3(0, 1, 0), Vec2(1.0f, 1.0f), Vec4(1, 1, 1, 1));
        Vertex vBot(Vec3(0.0f, 0.0f, 0), Vec3(0, 1, 0), Vec2(0.5f, 0.0f), Vec4(1, 1, 1, 1));

        clipped.clear();
        SutherlandHodgmanSlicer::clipTriangleAboveElevation(vTop1, vTop2, vBot, 5.0f, clipped);
        assert(clipped.size() == 2);
        assert(std::abs(clipped[0].v0.position.y - 10.0f) < 1e-4f);
        assert(std::abs(clipped[0].v1.position.y - 10.0f) < 1e-4f);
        std::cout << "  -> PASS: 2-above case sliced into 2 triangles (quad) above plane y = 5.0m without triangle loss\n";

        // Export Visual Comparison Mesh:
        // Left (-8m): Raw uncut triangle crossing y=5m with red indicator
        // Right (+8m): Perfectly sliced triangles above y=5m with golden boundary
        ScratchboxMesh visualSlicerMesh("Test1_SutherlandHodgmanSlicer");
        
        // Left: Original triangle with red lower section
        uint32_t bLeft = static_cast<uint32_t>(visualSlicerMesh.vertices.size());
        visualSlicerMesh.addVertex(Vertex(Vec3(-8.0f, 10.0f, 0), Vec3(0, 0, 1), Vec2(0.5f, 1), Vec4(0.2f, 0.7f, 1.0f, 1.0f)));
        visualSlicerMesh.addVertex(Vertex(Vec3(-13.0f, 0.0f, 0), Vec3(0, 0, 1), Vec2(0, 0), Vec4(0.9f, 0.2f, 0.2f, 1.0f)));
        visualSlicerMesh.addVertex(Vertex(Vec3(-3.0f, 0.0f, 0), Vec3(0, 0, 1), Vec2(1, 0), Vec4(0.9f, 0.2f, 0.2f, 1.0f)));
        visualSlicerMesh.indices.push_back(bLeft); visualSlicerMesh.indices.push_back(bLeft + 1); visualSlicerMesh.indices.push_back(bLeft + 2);

        // Reference cutting plane at y = 5.0m
        uint32_t bPlane = static_cast<uint32_t>(visualSlicerMesh.vertices.size());
        Vec4 planeCol(1.0f, 0.85f, 0.1f, 0.8f);
        visualSlicerMesh.addVertex(Vertex(Vec3(-15.0f, 5.0f, -2.0f), Vec3(0, 1, 0), Vec2(0, 0), planeCol));
        visualSlicerMesh.addVertex(Vertex(Vec3( 15.0f, 5.0f, -2.0f), Vec3(0, 1, 0), Vec2(1, 0), planeCol));
        visualSlicerMesh.addVertex(Vertex(Vec3( 15.0f, 5.0f,  2.0f), Vec3(0, 1, 0), Vec2(1, 1), planeCol));
        visualSlicerMesh.addVertex(Vertex(Vec3(-15.0f, 5.0f,  2.0f), Vec3(0, 1, 0), Vec2(0, 1), planeCol));
        visualSlicerMesh.indices.push_back(bPlane); visualSlicerMesh.indices.push_back(bPlane + 1); visualSlicerMesh.indices.push_back(bPlane + 2);
        visualSlicerMesh.indices.push_back(bPlane); visualSlicerMesh.indices.push_back(bPlane + 2); visualSlicerMesh.indices.push_back(bPlane + 3);

        // Right: Sliced result
        for (const auto& tri : clipped) {
            uint32_t bClipped = static_cast<uint32_t>(visualSlicerMesh.vertices.size());
            visualSlicerMesh.addVertex(Vertex(tri.v0.position + Vec3(8.0f, 0, 0), Vec3(0, 0, 1), tri.v0.uv, Vec4(0.1f, 0.9f, 0.4f, 1.0f)));
            visualSlicerMesh.addVertex(Vertex(tri.v1.position + Vec3(8.0f, 0, 0), Vec3(0, 0, 1), tri.v1.uv, Vec4(0.1f, 0.9f, 0.4f, 1.0f)));
            visualSlicerMesh.addVertex(Vertex(tri.v2.position + Vec3(8.0f, 0, 0), Vec3(0, 0, 1), tri.v2.uv, Vec4(0.1f, 0.9f, 0.4f, 1.0f)));
            visualSlicerMesh.indices.push_back(bClipped); visualSlicerMesh.indices.push_back(bClipped + 1); visualSlicerMesh.indices.push_back(bClipped + 2);
        }

        writeGlbFile("public/models/utdra_tests/test1_sutherland_hodgman.glb", visualSlicerMesh);
    }

    // ------------------------------------------------------------------------
    // Test 2: Multi-Level Void Carving (Bridge Underpass)
    // ------------------------------------------------------------------------
    std::cout << "\n[TEST 2] Multi-Level Bridge Underpass Void Carver...\n";
    {
        ScratchboxMesh bridgeMesh("BridgeUnderpass");
        // Horizontal bridge deck at y = 12.0m
        uint32_t b0 = static_cast<uint32_t>(bridgeMesh.vertices.size());
        bridgeMesh.addVertex(Vertex(Vec3(-10, 12, -2), Vec3(0, 1, 0), Vec2(0, 0), Vec4(0.35f, 0.35f, 0.38f, 1.0f)));
        bridgeMesh.addVertex(Vertex(Vec3( 10, 12, -2), Vec3(0, 1, 0), Vec2(1, 0), Vec4(0.35f, 0.35f, 0.38f, 1.0f)));
        bridgeMesh.addVertex(Vertex(Vec3( 10, 12,  2), Vec3(0, 1, 0), Vec2(1, 1), Vec4(0.35f, 0.35f, 0.38f, 1.0f)));
        bridgeMesh.indices.push_back(b0); bridgeMesh.indices.push_back(b0 + 1); bridgeMesh.indices.push_back(b0 + 2);

        // False photogrammetric vertical curtain wall from y = 0 to y = 12m
        uint32_t b1 = static_cast<uint32_t>(bridgeMesh.vertices.size());
        bridgeMesh.addVertex(Vertex(Vec3(-10, 0, 0), Vec3(0, 0, 1), Vec2(0, 0), Vec4(0.6f, 0.4f, 0.3f, 1.0f)));
        bridgeMesh.addVertex(Vertex(Vec3( 10, 0, 0), Vec3(0, 0, 1), Vec2(1, 0), Vec4(0.6f, 0.4f, 0.3f, 1.0f)));
        bridgeMesh.addVertex(Vertex(Vec3( 10, 12, 0), Vec3(0, 0, 1), Vec2(1, 1), Vec4(0.6f, 0.4f, 0.3f, 1.0f)));
        bridgeMesh.indices.push_back(b1); bridgeMesh.indices.push_back(b1 + 1); bridgeMesh.indices.push_back(b1 + 2);

        assert(bridgeMesh.indices.size() == 6); // 2 triangles

        ScratchboxMesh cleared = MultiLevelVoidCarver::carveUnderpassVoids(bridgeMesh, 4.0f);
        assert(cleared.indices.size() == 3); // False curtain wall excised, deck preserved!
        assert(std::abs(cleared.vertices[0].position.y - 12.0f) < 1e-4f);
        std::cout << "  -> PASS: Underpass curtain wall excised; elevated bridge deck preserved intact\n";

        // Export Visual Comparison:
        // Left (-15m): Raw bridge with false curtain wall
        // Right (+15m): Cleared underpass void with slender support piers
        ScratchboxMesh visualBridgeMesh("Test2_BridgeUnderpassCarver");
        for (size_t i = 0; i < bridgeMesh.indices.size(); i += 3) {
            uint32_t idx = static_cast<uint32_t>(visualBridgeMesh.vertices.size());
            visualBridgeMesh.addVertex(Vertex(bridgeMesh.vertices[bridgeMesh.indices[i]].position + Vec3(0, 0, -12), Vec3(0, 1, 0), Vec2(0, 0), bridgeMesh.vertices[bridgeMesh.indices[i]].color));
            visualBridgeMesh.addVertex(Vertex(bridgeMesh.vertices[bridgeMesh.indices[i+1]].position + Vec3(0, 0, -12), Vec3(0, 1, 0), Vec2(1, 0), bridgeMesh.vertices[bridgeMesh.indices[i+1]].color));
            visualBridgeMesh.addVertex(Vertex(bridgeMesh.vertices[bridgeMesh.indices[i+2]].position + Vec3(0, 0, -12), Vec3(0, 1, 0), Vec2(1, 1), bridgeMesh.vertices[bridgeMesh.indices[i+2]].color));
            visualBridgeMesh.indices.push_back(idx); visualBridgeMesh.indices.push_back(idx + 1); visualBridgeMesh.indices.push_back(idx + 2);
        }

        // Right side: Cleared bridge deck + structural concrete columns
        for (size_t i = 0; i < cleared.indices.size(); i += 3) {
            uint32_t idx = static_cast<uint32_t>(visualBridgeMesh.vertices.size());
            visualBridgeMesh.addVertex(Vertex(cleared.vertices[cleared.indices[i]].position + Vec3(0, 0, 12), Vec3(0, 1, 0), Vec2(0, 0), Vec4(0.2f, 0.8f, 0.9f, 1.0f)));
            visualBridgeMesh.addVertex(Vertex(cleared.vertices[cleared.indices[i+1]].position + Vec3(0, 0, 12), Vec3(0, 1, 0), Vec2(1, 0), Vec4(0.2f, 0.8f, 0.9f, 1.0f)));
            visualBridgeMesh.addVertex(Vertex(cleared.vertices[cleared.indices[i+2]].position + Vec3(0, 0, 12), Vec3(0, 1, 0), Vec2(1, 1), Vec4(0.2f, 0.8f, 0.9f, 1.0f)));
            visualBridgeMesh.indices.push_back(idx); visualBridgeMesh.indices.push_back(idx + 1); visualBridgeMesh.indices.push_back(idx + 2);
        }

        // Add 2 concrete structural piers under the cleared bridge
        auto addPier = [&](Vec3 center) {
            float r = 0.6f;
            float h = 12.0f;
            uint32_t pBase = static_cast<uint32_t>(visualBridgeMesh.vertices.size());
            visualBridgeMesh.addVertex(Vertex(center + Vec3(-r, 0, -r), Vec3(-1, 0, 0), Vec2(0, 0), Vec4(0.7f, 0.7f, 0.75f, 1.0f)));
            visualBridgeMesh.addVertex(Vertex(center + Vec3( r, 0, -r), Vec3(1, 0, 0), Vec2(1, 0), Vec4(0.7f, 0.7f, 0.75f, 1.0f)));
            visualBridgeMesh.addVertex(Vertex(center + Vec3( r, h, -r), Vec3(1, 0, 0), Vec2(1, 1), Vec4(0.7f, 0.7f, 0.75f, 1.0f)));
            visualBridgeMesh.addVertex(Vertex(center + Vec3(-r, h, -r), Vec3(-1, 0, 0), Vec2(0, 1), Vec4(0.7f, 0.7f, 0.75f, 1.0f)));
            visualBridgeMesh.indices.push_back(pBase); visualBridgeMesh.indices.push_back(pBase + 1); visualBridgeMesh.indices.push_back(pBase + 2);
            visualBridgeMesh.indices.push_back(pBase); visualBridgeMesh.indices.push_back(pBase + 2); visualBridgeMesh.indices.push_back(pBase + 3);
        };
        addPier(Vec3(-6.0f, 0, 12.0f));
        addPier(Vec3( 6.0f, 0, 12.0f));

        writeGlbFile("public/models/utdra_tests/test2_bridge_underpass.glb", visualBridgeMesh);
    }

    // ------------------------------------------------------------------------
    // Test 3: Macro-Domain Classification (Urban High-Rise)
    // ------------------------------------------------------------------------
    std::cout << "\n[TEST 3] Macro-Domain Probe: High-Rise Urban Core...\n";
    {
        ScratchboxMesh esbLike = createSkyscraperMesh(40.0f, 60.0f, 180.0f);
        GeographicDomainProbe probe = DomainClassifier::probeTile(esbLike);
        probe.printSummary();

        assert(probe.dominantDomain == GeographicDomain::UrbanHighRiseCore);
        assert(probe.verticalityScore > 0.40f);
        assert(probe.totalReliefDeltaY >= 180.0f);
        std::cout << "  -> PASS: Skyscraper correctly classified as UrbanHighRiseCore\n";

        writeGlbFile("public/models/utdra_tests/test3_urban_highrise.glb", esbLike);
    }

    // ------------------------------------------------------------------------
    // Test 4: Macro-Domain Classification (Suburban Residential)
    // ------------------------------------------------------------------------
    std::cout << "\n[TEST 4] Macro-Domain Probe: Suburban Residential...\n";
    {
        ScratchboxMesh suburb = createSuburbanHouseMesh(12.0f, 16.0f, 4.5f, 7.5f);
        GeographicDomainProbe probe = DomainClassifier::probeTile(suburb);
        probe.printSummary();

        assert(probe.dominantDomain == GeographicDomain::SuburbanResidential);
        assert(probe.pitchedRoofRatio > 0.20f);
        assert(probe.totalReliefDeltaY <= 15.0f);
        std::cout << "  -> PASS: Pitched-roof house correctly classified as SuburbanResidential\n";

        writeGlbFile("public/models/utdra_tests/test4_suburban_residential.glb", suburb);
    }

    // ------------------------------------------------------------------------
    // Test 5: Macro-Domain Classification (Mountain / Alpine)
    // ------------------------------------------------------------------------
    std::cout << "\n[TEST 5] Macro-Domain Probe: Mountain / Alpine...\n";
    {
        ScratchboxMesh mountain = createAlpineCliffMesh(150.0f, 220.0f);
        GeographicDomainProbe probe = DomainClassifier::probeTile(mountain);
        probe.printSummary();

        assert(probe.dominantDomain == GeographicDomain::MountainAlpineCanyon);
        assert(probe.totalReliefDeltaY >= 200.0f);

        NaturalTerrainProcessor::applySlopeStratifiedBiomes(mountain);
        std::cout << "  [Test 5 Debug] v0 normal: (" << mountain.vertices[0].normal.x << ", "
                  << mountain.vertices[0].normal.y << ", " << mountain.vertices[0].normal.z << ") color: ("
                  << mountain.vertices[0].color.x << ", " << mountain.vertices[0].color.y << ", "
                  << mountain.vertices[0].color.z << ")\n";
        std::cout << "  [Test 5 Debug] vBack normal: (" << mountain.vertices.back().normal.x << ", "
                  << mountain.vertices.back().normal.y << ", " << mountain.vertices.back().normal.z << ") color: ("
                  << mountain.vertices.back().color.x << ", " << mountain.vertices.back().color.y << ", "
                  << mountain.vertices.back().color.z << ")\n";
        // On valley floor (vertex 0), turf/grass factor should dominate (Color.y >= 0.85f)
        assert(mountain.vertices[0].color.y >= 0.85f);
        // On steep cliff face (last vertex), rock factor should dominate (Color.x > 0.90f)
        assert(mountain.vertices.back().color.x > 0.90f);
        std::cout << "  -> PASS: Alpine terrain correctly classified with slope-stratified biomes (valley turf + cliff rock)\n";

        writeGlbFile("public/models/utdra_tests/test5_alpine_mountain.glb", mountain);
    }

    // ------------------------------------------------------------------------
    // Test 6: Macro-Domain Classification (Dense Forest Canopy)
    // ------------------------------------------------------------------------
    std::cout << "\n[TEST 6] Macro-Domain Probe: Dense Forest Canopy...\n";
    {
        ScratchboxMesh forest("DenseForest");
        // Create organic canopy clusters with high green NDVI
        for (int cluster = 0; cluster < 6; ++cluster) {
            float cx = (cluster % 3 - 1) * 12.0f;
            float cz = (cluster / 3 - 0.5f) * 12.0f;
            float trunkH = 10.0f + (cluster % 2) * 3.0f;

            // Tree trunk
            uint32_t tBase = static_cast<uint32_t>(forest.vertices.size());
            forest.addVertex(Vertex(Vec3(cx - 0.4f, 0, cz), Vec3(1, 0, 0), Vec2(0, 0), Vec4(0.38f, 0.25f, 0.15f, 1.0f)));
            forest.addVertex(Vertex(Vec3(cx + 0.4f, 0, cz), Vec3(1, 0, 0), Vec2(1, 0), Vec4(0.38f, 0.25f, 0.15f, 1.0f)));
            forest.addVertex(Vertex(Vec3(cx + 0.3f, trunkH, cz), Vec3(1, 0, 0), Vec2(1, 1), Vec4(0.38f, 0.25f, 0.15f, 1.0f)));
            forest.addVertex(Vertex(Vec3(cx - 0.3f, trunkH, cz), Vec3(1, 0, 0), Vec2(0, 1), Vec4(0.38f, 0.25f, 0.15f, 1.0f)));
            forest.indices.push_back(tBase); forest.indices.push_back(tBase + 1); forest.indices.push_back(tBase + 2);
            forest.indices.push_back(tBase); forest.indices.push_back(tBase + 2); forest.indices.push_back(tBase + 3);

            // Foliage dome
            for (int i = 0; i < 16; ++i) {
                float phi = (i / 16.0f) * TWO_PI;
                float r = 4.5f + std::sin(phi * 3.0f) * 0.8f;
                uint32_t fBase = static_cast<uint32_t>(forest.vertices.size());
                Vec3 p0(cx, trunkH + 4.0f, cz);
                Vec3 p1(cx + std::cos(phi) * r, trunkH + 1.0f, cz + std::sin(phi) * r);
                float nextPhi = ((i + 1) / 16.0f) * TWO_PI;
                Vec3 p2(cx + std::cos(nextPhi) * r, trunkH + 1.0f, cz + std::sin(nextPhi) * r);
                Vec4 folCol(0.12f, 0.68f, 0.18f, 1.0f); // High NDVI green
                forest.addVertex(Vertex(p0, Vec3(0, 1, 0), Vec2(0.5f, 1), folCol));
                forest.addVertex(Vertex(p1, (p1 - Vec3(cx, trunkH, cz)).normalized(), Vec2(0, 0), folCol));
                forest.addVertex(Vertex(p2, (p2 - Vec3(cx, trunkH, cz)).normalized(), Vec2(1, 0), folCol));
                forest.indices.push_back(fBase); forest.indices.push_back(fBase + 1); forest.indices.push_back(fBase + 2);
            }
        }

        GeographicDomainProbe probe = DomainClassifier::probeTile(forest);
        probe.printSummary();

        assert(probe.dominantDomain == GeographicDomain::ForestWoodlandCanopy);
        assert(probe.vegetationIndexNDVI > 0.25f);
        std::cout << "  -> PASS: Dense forest correctly classified as ForestWoodlandCanopy\n";

        writeGlbFile("public/models/utdra_tests/test6_forest_canopy.glb", forest);
    }

    // ------------------------------------------------------------------------
    // Test 7: Universal Tile Pipeline End-to-End
    // ------------------------------------------------------------------------
    std::cout << "\n[TEST 7] UniversalTilePipeline End-to-End Integration...\n";
    {
        ScratchboxMesh rawTile = createSkyscraperMesh(50.0f, 70.0f, 220.0f);
        UniversalDecomposedTile decomposed = UniversalTilePipeline::processRawTile(rawTile);

        assert(decomposed.probe.dominantDomain == GeographicDomain::UrbanHighRiseCore);
        assert(!decomposed.preservedSculpturalCrowns.empty());
        assert(decomposed.totalOutputTriangles > 0);
        std::cout << "  -> PASS: UniversalTilePipeline successfully decomposed raw tile into rectified building and preserved sculptural crown!\n";

        // Combine rectified building and preserved crown for full visualization
        ScratchboxMesh fullHybrid("UniversalDecomposedHybrid");
        for (const auto& bldg : decomposed.rectifiedBuildings) {
            uint32_t baseIdx = static_cast<uint32_t>(fullHybrid.vertices.size());
            for (const auto& v : bldg.vertices) fullHybrid.vertices.push_back(v);
            for (uint32_t idx : bldg.indices) fullHybrid.indices.push_back(baseIdx + idx);
        }
        for (const auto& crown : decomposed.preservedSculpturalCrowns) {
            uint32_t baseIdx = static_cast<uint32_t>(fullHybrid.vertices.size());
            for (const auto& v : crown.vertices) {
                fullHybrid.vertices.push_back(v);
            }
            for (uint32_t idx : crown.indices) {
                fullHybrid.indices.push_back(baseIdx + idx);
            }
        }
        writeGlbFile("public/models/utdra_tests/test7_universal_hybrid.glb", fullHybrid);
    }

    std::cout << "\n======================================================================\n";
    std::cout << "  ALL 7 UTDRA VERIFICATION TESTS PASSED PERFECTLY!\n";
    std::cout << "======================================================================\n";
    return 0;
}
