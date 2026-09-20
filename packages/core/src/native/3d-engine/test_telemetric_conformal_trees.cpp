/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

#include "scratchbox_engine.hpp"
#include "scratchbox_nature.hpp"
#include "scratchbox_tile_cleanup.hpp"
#include "scratchbox_io.hpp"

#include <iostream>
#include <fstream>
#include <filesystem>
#include <cassert>
#include <cmath>
#include <iomanip>

namespace fs = std::filesystem;
using namespace scratchbox;
using namespace scratchbox::math;
using namespace scratchbox::geometry;
using namespace scratchbox::nature;
using namespace scratchbox::cleanup;
using namespace scratchbox::io;

void writeGlb(const std::string& path, const ScratchboxMesh& mesh) {
    fs::create_directories(fs::path(path).parent_path());
    std::vector<uint8_t> bytes = GlbWriter::writeGlb(mesh);
    std::ofstream out(path, std::ios::binary);
    out.write(reinterpret_cast<const char*>(bytes.data()), static_cast<std::streamsize>(bytes.size()));
    out.close();
    std::cout << "  -> Wrote " << bytes.size() << " bytes (" 
              << (mesh.indices.size() / 3) << " tris) to " << path << std::endl;
}

// ----------------------------------------------------------------------------
// Helper: Synthesize Raw Photogrammetric Scan of an Asymmetric Leaning Street Tree
// ----------------------------------------------------------------------------
ScratchboxMesh generateLeaningStreetTreeScan(const Vec3& origin = Vec3(0, 0, 0)) {
    ScratchboxMesh mesh("RawLeaningStreetTreeScan");
    mesh.material.roughnessFactor = 0.90f;

    // 1. Narrow photogrammetric trunk blob from Y=0 to Y=2.3m
    int trunkRings = 8;
    int trunkSectors = 10;
    for (int r = 0; r < trunkRings; ++r) {
        float v = static_cast<float>(r) / static_cast<float>(trunkRings - 1);
        float y = origin.y + v * 2.3f;
        // Lean starts slowly in trunk
        float leanX = origin.x + v * 0.35f;
        float radius = 0.30f - v * 0.08f + std::sin(v * 6.0f) * 0.04f;

        for (int s = 0; s < trunkSectors; ++s) {
            float u = static_cast<float>(s) / static_cast<float>(trunkSectors - 1);
            float theta = u * math::TWO_PI;
            float px = leanX + std::cos(theta) * radius;
            float pz = origin.z + std::sin(theta) * radius;
            Vec3 pos(px, y, pz);
            Vec3 norm = (pos - Vec3(leanX, y, origin.z)).normalized();
            Vec2 uv(u, v);
            // Bark-like photogrammetric color
            Vec4 col(0.38f, 0.30f, 0.22f, 1.0f);
            mesh.addVertex(Vertex(pos, norm, uv, col));
        }
    }
    for (int r = 0; r < trunkRings - 1; ++r) {
        for (int s = 0; s < trunkSectors - 1; ++s) {
            uint32_t i0 = r * trunkSectors + s;
            uint32_t i1 = (r + 1) * trunkSectors + s;
            uint32_t i2 = (r + 1) * trunkSectors + (s + 1);
            uint32_t i3 = r * trunkSectors + (s + 1);
            mesh.addTriangle(i0, i1, i2);
            mesh.addTriangle(i0, i2, i3);
        }
    }

    // 2. Crown: "Melted Broccoli" canopy from Y=2.3m to Y=7.8m
    // Leans strongly toward +X (+1.4m lean at apex)
    uint32_t crownBase = static_cast<uint32_t>(mesh.vertices.size());
    int crownRings = 20;
    int crownSectors = 24;
    float crownTotalH = 5.5f;

    for (int r = 0; r < crownRings; ++r) {
        float v = static_cast<float>(r) / static_cast<float>(crownRings - 1);
        float phi = v * math::PI;
        float y = origin.y + 2.3f + v * crownTotalH;
        // Strong phototropic lean toward +X
        float leanX = origin.x + 0.35f + v * 1.05f;
        // Bulbous canopy profile: wide in middle, tapered top
        float baseRadius = std::sin(phi) * 2.4f + 0.3f;

        for (int s = 0; s < crownSectors; ++s) {
            float u = static_cast<float>(s) / static_cast<float>(crownSectors - 1);
            float theta = u * math::TWO_PI;

            // Melted noisy lobes
            float noise = std::sin(theta * 4.0f + y * 2.0f) * 0.40f
                        + std::cos(theta * 6.0f - y * 3.0f) * 0.25f
                        + std::sin(theta * 9.0f) * 0.15f;
            float rFinal = std::max(0.3f, baseRadius + noise);

            float px = leanX + std::cos(theta) * rFinal;
            float pz = origin.z + std::sin(theta) * (rFinal * 0.88f); // slight asymmetry
            float py = y + std::sin(theta * 5.0f) * 0.18f;

            Vec3 pos(px, py, pz);
            Vec3 norm = (pos - Vec3(leanX, y, origin.z)).normalized();
            Vec2 uv(u, v);

            // Photogrammetric vegetative vertex color (chlorophyll green ExG > 0.12)
            float gVal = 0.54f + std::sin(theta * 3.0f + y) * 0.16f;
            float rVal = 0.22f + std::cos(theta * 2.0f) * 0.06f;
            float bVal = 0.16f;
            Vec4 col(rVal, gVal, bVal, 1.0f);

            mesh.addVertex(Vertex(pos, norm, uv, col));
        }
    }

    for (int r = 0; r < crownRings - 1; ++r) {
        for (int s = 0; s < crownSectors - 1; ++s) {
            uint32_t i0 = crownBase + r * crownSectors + s;
            uint32_t i1 = crownBase + (r + 1) * crownSectors + s;
            uint32_t i2 = crownBase + (r + 1) * crownSectors + (s + 1);
            uint32_t i3 = crownBase + r * crownSectors + (s + 1);
            mesh.addTriangle(i0, i1, i2);
            mesh.addTriangle(i0, i2, i3);
        }
    }

    return mesh;
}

// ----------------------------------------------------------------------------
// Helper: Synthesize Raw Photogrammetric Scan of a Dense Boxwood Shrub / Hedge
// ----------------------------------------------------------------------------
ScratchboxMesh generateDenseShrubScan(const Vec3& origin = Vec3(0, 0, 0)) {
    ScratchboxMesh mesh("RawDenseShrubScan");
    mesh.material.roughnessFactor = 0.88f;

    // Shrub is low (1.55m total height) and wide (width 2.8m, depth 1.9m)
    // Starts right from ground level (Y=0.05m)
    int rings = 16;
    int sectors = 22;
    float shrubH = 1.55f;

    for (int r = 0; r < rings; ++r) {
        float v = static_cast<float>(r) / static_cast<float>(rings - 1);
        float phi = v * (math::PI * 0.55f); // hemisphere / dome
        float y = origin.y + 0.05f + v * shrubH;
        float rxBase = std::cos(phi) * 1.4f + 0.2f;
        float rzBase = std::cos(phi) * 0.95f + 0.15f;

        for (int s = 0; s < sectors; ++s) {
            float u = static_cast<float>(s) / static_cast<float>(sectors - 1);
            float theta = u * math::TWO_PI;

            // Dense clipped hedge bumps
            float bump = std::sin(theta * 7.0f + y * 5.0f) * 0.18f
                       + std::cos(theta * 5.0f) * 0.12f;
            float rxFinal = std::max(0.2f, rxBase + bump);
            float rzFinal = std::max(0.2f, rzBase + bump * 0.8f);

            float px = origin.x + std::cos(theta) * rxFinal;
            float pz = origin.z + std::sin(theta) * rzFinal;
            float py = y + std::sin(theta * 6.0f) * 0.08f;

            Vec3 pos(px, py, pz);
            Vec3 norm = (pos - Vec3(origin.x, y, origin.z)).normalized();
            Vec2 uv(u, v);

            // Deep boxwood evergreen color
            float gVal = 0.48f + std::sin(theta * 4.0f) * 0.12f;
            float rVal = 0.18f;
            float bVal = 0.14f;
            Vec4 col(rVal, gVal, bVal, 1.0f);

            mesh.addVertex(Vertex(pos, norm, uv, col));
        }
    }

    for (int r = 0; r < rings - 1; ++r) {
        for (int s = 0; s < sectors - 1; ++s) {
            uint32_t i0 = r * sectors + s;
            uint32_t i1 = (r + 1) * sectors + s;
            uint32_t i2 = (r + 1) * sectors + (s + 1);
            uint32_t i3 = r * sectors + (s + 1);
            mesh.addTriangle(i0, i1, i2);
            mesh.addTriangle(i0, i2, i3);
        }
    }

    return mesh;
}

int main() {
    std::cout << "=================================================================" << std::endl;
    std::cout << "  SCRATCHBOX 3D ENGINE - TELEMETRIC CONFORMAL TREE TEST SUITE" << std::endl;
    std::cout << "  Strategy B: Direct Mesh-Conformal Attractor Seeding & Scaling" << std::endl;
    std::cout << "=================================================================" << std::endl;

    // ------------------------------------------------------------------------
    // STAGE 1: Synthesize Raw Photogrammetric Scan Blobs
    // ------------------------------------------------------------------------
    std::cout << "\n[Stage 1] Synthesizing Photogrammetric Scans..." << std::endl;
    ScratchboxMesh streetTreeScan = generateLeaningStreetTreeScan(Vec3(0, 0, 0));
    ScratchboxMesh shrubScan = generateDenseShrubScan(Vec3(0, 0, 0));

    std::cout << "  Street Tree Scan: " << streetTreeScan.vertices.size() << " verts, "
              << (streetTreeScan.indices.size() / 3) << " tris" << std::endl;
    std::cout << "  Dense Shrub Scan: " << shrubScan.vertices.size() << " verts, "
              << (shrubScan.indices.size() / 3) << " tris" << std::endl;

    // ------------------------------------------------------------------------
    // STAGE 2: Extract Telemetry via BotanicalTelemetryExtractor
    // ------------------------------------------------------------------------
    std::cout << "\n[Stage 2] Extracting Botanical Telemetry..." << std::endl;

    // 2A: Street Tree Telemetry
    std::vector<bool> streetVeg = TileTextureDeLighter::detectVegetationVertices(streetTreeScan);
    BotanicalBlobTelemetry streetTel = BotanicalTelemetryExtractor::extractTelemetry(
        streetTreeScan, streetVeg, 0.28f
    );

    std::cout << "\n  --- Street Tree Telemetry ---" << std::endl;
    std::cout << "  Total Height:       " << std::fixed << std::setprecision(2) << streetTel.totalHeight << " m" << std::endl;
    std::cout << "  Clear Trunk Height: " << streetTel.clearTrunkHeight << " m" << std::endl;
    std::cout << "  Crown Base Height:  " << streetTel.crownBaseHeight << " m" << std::endl;
    std::cout << "  Crown Height:       " << streetTel.crownHeight << " m" << std::endl;
    std::cout << "  Crown Centroid:     (" << streetTel.crownCentroid.x << ", " 
              << streetTel.crownCentroid.y << ", " << streetTel.crownCentroid.z << ")" << std::endl;
    std::cout << "  Crown Extents:      (" << streetTel.crownExtents.x << ", " 
              << streetTel.crownExtents.y << ", " << streetTel.crownExtents.z << ")" << std::endl;
    std::cout << "  Volumetric Density: " << streetTel.volumetricDensity << std::endl;
    std::cout << "  Is Shrub:           " << (streetTel.isShrub ? "YES" : "NO") << std::endl;
    std::cout << "  Suggested Caliper:  " << streetTel.suggestedBaseRadius << " m" << std::endl;
    std::cout << "  Suggested Foliage:  " << streetTel.suggestedLeavesPerTip << " leaves/tip" << std::endl;
    std::cout << "  Conformal Attractors: " << streetTel.conformalAttractors.size() << " points" << std::endl;

    // Verification asserts for street tree
    assert(!streetTel.isShrub);
    assert(streetTel.totalHeight >= 7.0f && streetTel.totalHeight <= 8.5f);
    assert(streetTel.clearTrunkHeight >= 1.8f && streetTel.clearTrunkHeight <= 2.8f);
    assert(streetTel.crownCentroid.x > 0.6f); // Detected phototropic lean!
    assert(!streetTel.conformalAttractors.empty());

    // 2B: Dense Shrub Telemetry
    std::vector<bool> shrubVeg = TileTextureDeLighter::detectVegetationVertices(shrubScan);
    BotanicalBlobTelemetry shrubTel = BotanicalTelemetryExtractor::extractTelemetry(
        shrubScan, shrubVeg, 0.22f
    );

    std::cout << "\n  --- Dense Shrub Telemetry ---" << std::endl;
    std::cout << "  Total Height:       " << shrubTel.totalHeight << " m" << std::endl;
    std::cout << "  Clear Trunk Height: " << shrubTel.clearTrunkHeight << " m" << std::endl;
    std::cout << "  Crown Centroid:     (" << shrubTel.crownCentroid.x << ", " 
              << shrubTel.crownCentroid.y << ", " << shrubTel.crownCentroid.z << ")" << std::endl;
    std::cout << "  Crown Extents:      (" << shrubTel.crownExtents.x << ", " 
              << shrubTel.crownExtents.y << ", " << shrubTel.crownExtents.z << ")" << std::endl;
    std::cout << "  Volumetric Density: " << shrubTel.volumetricDensity << std::endl;
    std::cout << "  Is Shrub:           " << (shrubTel.isShrub ? "YES" : "NO") << std::endl;
    std::cout << "  Suggested Caliper:  " << shrubTel.suggestedBaseRadius << " m" << std::endl;
    std::cout << "  Suggested Foliage:  " << shrubTel.suggestedLeavesPerTip << " leaves/tip" << std::endl;
    std::cout << "  Conformal Attractors: " << shrubTel.conformalAttractors.size() << " points" << std::endl;

    // Verification asserts for shrub
    assert(shrubTel.isShrub);
    assert(shrubTel.totalHeight < 2.0f);
    assert(shrubTel.clearTrunkHeight <= 0.25f);
    assert(shrubTel.suggestedBaseRadius < 0.12f);
    assert(!shrubTel.conformalAttractors.empty());

    // ------------------------------------------------------------------------
    // STAGE 3: Procedural Generation via Conformal Space Colonization
    // ------------------------------------------------------------------------
    std::cout << "\n[Stage 3] Generating Conformal Botanical Models..." << std::endl;

    // 3A: Generate Asymmetric Street Tree
    SpaceColonizationConfig treeCfg = SpaceColonizationConfig::fromBlobTelemetry(streetTel);
    treeCfg.seed = 2026;
    treeCfg.useDetailedLeaves = true;
    treeCfg.useTwigSprays = true;
    treeCfg.leafMorphology = LeafMorphology::LobedOakMaple;
    treeCfg.leafSize = 0.36f;
    treeCfg.leafColor = Vec4(0.20f, 0.46f, 0.14f, 1.0f);
    treeCfg.woodColor = Vec4(0.32f, 0.22f, 0.15f, 1.0f);

    geometry::Mesh treeMesh = SpaceColonizationTreeGenerator::generateTree(treeCfg);
    treeMesh.name = "ConformalStreetTree";
    treeMesh.material.roughnessFactor = 0.55f;
    treeMesh.material.metallicFactor = 0.02f;
    treeMesh.material.doubleSided = true;
    ScratchboxMesh treeGlb = treeMesh.toScratchboxMesh();
    writeGlb("public/models/test_conformal1_asymmetric_street_tree.glb", treeGlb);

    // 3B: Generate Multi-Stem Dense Shrub
    SpaceColonizationConfig shrubCfg = SpaceColonizationConfig::fromBlobTelemetry(shrubTel);
    shrubCfg.seed = 7788;
    shrubCfg.useDetailedLeaves = true;
    shrubCfg.useTwigSprays = true;
    shrubCfg.leafMorphology = LeafMorphology::OvateSimple;
    shrubCfg.leafSize = 0.20f;
    shrubCfg.leafColor = Vec4(0.14f, 0.40f, 0.12f, 1.0f);
    shrubCfg.woodColor = Vec4(0.25f, 0.18f, 0.12f, 1.0f);

    geometry::Mesh shrubMesh = SpaceColonizationTreeGenerator::generateTree(shrubCfg);
    shrubMesh.name = "ConformalDenseShrub";
    shrubMesh.material.roughnessFactor = 0.55f;
    shrubMesh.material.metallicFactor = 0.02f;
    shrubMesh.material.doubleSided = true;
    ScratchboxMesh shrubGlb = shrubMesh.toScratchboxMesh();
    writeGlb("public/models/test_conformal2_dense_shrub.glb", shrubGlb);

    // 3C: Overlay Model: Generated Tree + Ghost Raw Scan Wireframe for Alignment Proof
    ScratchboxMesh overlayGlb("ConformalOverlayAlignment");
    overlayGlb.material.metallicFactor = 0.05f;
    overlayGlb.material.roughnessFactor = 0.85f;
    for (size_t i = 0; i < treeGlb.vertices.size(); ++i) {
        overlayGlb.addVertex(treeGlb.vertices[i]);
    }
    for (uint32_t idx : treeGlb.indices) {
        overlayGlb.indices.push_back(idx);
    }
    // Append ghost scan silhouette with a high-contrast magenta-gold contour color
    uint32_t ghostBase = static_cast<uint32_t>(overlayGlb.vertices.size());
    for (size_t i = 0; i < streetTreeScan.vertices.size(); ++i) {
        Vertex v = streetTreeScan.vertices[i];
        v.color = Vec4(0.88f, 0.22f, 0.45f, 0.45f); // Ghost scan contour
        overlayGlb.addVertex(v);
    }
    for (uint32_t idx : streetTreeScan.indices) {
        overlayGlb.indices.push_back(ghostBase + idx);
    }
    writeGlb("public/models/test_conformal3_envelope_alignment.glb", overlayGlb);

    // 3D: Both Raw Scans side-by-side for before/after comparison
    ScratchboxMesh rawScansGlb("RawPhotogrammetryScans");
    rawScansGlb.material.roughnessFactor = 0.90f;
    for (size_t i = 0; i < streetTreeScan.vertices.size(); ++i) {
        rawScansGlb.addVertex(streetTreeScan.vertices[i]);
    }
    for (uint32_t idx : streetTreeScan.indices) {
        rawScansGlb.indices.push_back(idx);
    }
    uint32_t shrubBaseOffset = static_cast<uint32_t>(rawScansGlb.vertices.size());
    for (size_t i = 0; i < shrubScan.vertices.size(); ++i) {
        Vertex v = shrubScan.vertices[i];
        v.position.x += 4.5f; // Place shrub 4.5m to the right
        rawScansGlb.addVertex(v);
    }
    for (uint32_t idx : shrubScan.indices) {
        rawScansGlb.indices.push_back(shrubBaseOffset + idx);
    }
    writeGlb("public/models/test_conformal4_raw_scans.glb", rawScansGlb);

    std::cout << "\n=================================================================" << std::endl;
    std::cout << "  ALL TELEMETRIC CONFORMAL TESTS COMPLETED SUCCESSFULLY!" << std::endl;
    std::cout << "=================================================================" << std::endl;

    return 0;
}
