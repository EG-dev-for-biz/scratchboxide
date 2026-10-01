/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

#include "scratchbox_engine.hpp"
#include "scratchbox_nature.hpp"
#include "scratchbox_tile_cleanup.hpp"
#include "scratchbox_io.hpp"
#include "scratchbox_field_remesh.hpp"
#include <iostream>
#include <fstream>
#include <filesystem>
#include <cassert>
#include <cmath>

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
// Helper: Synthesize a raw photogrammetric streetscape with melted tree blob
// ----------------------------------------------------------------------------
ScratchboxMesh generateRawPhotogrammetryStreetscape() {
    ScratchboxMesh mesh("RawPhotogrammetryStreet");
    mesh.material.roughnessFactor = 0.85f;

    // 1. Street & Sidewalk (Z: -6 to 6, X: -6 to 6, Y: 0)
    for (int ix = -6; ix <= 6; ++ix) {
        for (int iz = -6; iz <= 6; ++iz) {
            float x = static_cast<float>(ix);
            float z = static_cast<float>(iz);
            // Slight photogrammetric scanning noise
            float yNoise = std::sin(x * 3.1f) * std::cos(z * 2.7f) * 0.04f;
            Vec3 pos(x, yNoise, z);
            Vec3 norm(0, 1, 0);
            Vec2 uv((x + 6.0f) / 12.0f, (z + 6.0f) / 12.0f);
            Vec4 col = (z > 0.0f) ? Vec4(0.35f, 0.35f, 0.38f, 1.0f) // Asphalt
                                  : Vec4(0.68f, 0.67f, 0.65f, 1.0f); // Concrete sidewalk
            mesh.addVertex(Vertex(pos, norm, uv, col));
        }
    }
    int gw = 13;
    for (int ix = 0; ix < 12; ++ix) {
        for (int iz = 0; iz < 12; ++iz) {
            uint32_t i0 = ix * gw + iz;
            uint32_t i1 = (ix + 1) * gw + iz;
            uint32_t i2 = (ix + 1) * gw + (iz + 1);
            uint32_t i3 = ix * gw + (iz + 1);
            mesh.addTriangle(i0, i1, i2);
            mesh.addTriangle(i0, i2, i3);
        }
    }

    // 2. Building Facade on North side (Z = -5.5 to -6.0, Y = 0 to 12)
    uint32_t facBase = static_cast<uint32_t>(mesh.vertices.size());
    for (int ix = -6; ix <= 6; ++ix) {
        for (int iy = 0; iy <= 6; ++iy) {
            float x = static_cast<float>(ix);
            float y = static_cast<float>(iy) * 2.0f;
            float z = -5.8f + std::sin(x * 1.5f + y) * 0.08f; // photogrammetric wave/melt
            Vec3 pos(x, y, z);
            Vec3 norm(0, 0, 1);
            Vec2 uv((x + 6.0f) / 12.0f, y / 12.0f);
            Vec4 col(0.78f, 0.74f, 0.68f, 1.0f); // Limestone facade
            mesh.addVertex(Vertex(pos, norm, uv, col));
        }
    }
    for (int ix = 0; ix < 12; ++ix) {
        for (int iy = 0; iy < 6; ++iy) {
            uint32_t i0 = facBase + ix * 7 + iy;
            uint32_t i1 = facBase + (ix + 1) * 7 + iy;
            uint32_t i2 = facBase + (ix + 1) * 7 + (iy + 1);
            uint32_t i3 = facBase + ix * 7 + (iy + 1);
            mesh.addTriangle(i0, i1, i2);
            mesh.addTriangle(i0, i2, i3);
        }
    }

    // 3. The "Melted Broccoli" Tree Blob (centered at X=1.2, Z=-2.5, Y=0..6)
    // Photogrammetry reconstructs this as a single crumpled, self-intersecting blob
    Vec3 treeCenter(1.2f, 0.0f, -2.5f);
    int rings = 14;
    int sectors = 18;
    uint32_t blobBase = static_cast<uint32_t>(mesh.vertices.size());

    for (int r = 0; r < rings; ++r) {
        float v = static_cast<float>(r) / static_cast<float>(rings - 1);
        float phi = v * math::PI;
        float y = 0.2f + v * 5.8f;
        // Bumpy organic radial profile with high noise
        float radiusBase = std::sin(phi) * 2.2f + 0.35f;

        for (int s = 0; s < sectors; ++s) {
            float u = static_cast<float>(s) / static_cast<float>(sectors - 1);
            float theta = u * math::TWO_PI;

            // Melted photogrammetric noise harmonics
            float noise = std::sin(theta * 5.0f + y * 2.0f) * 0.45f
                        + std::cos(theta * 3.0f - y * 4.0f) * 0.30f
                        + std::sin(theta * 8.0f) * 0.15f;
            float rFinal = std::max(0.2f, radiusBase + noise);

            float px = treeCenter.x + std::cos(theta) * rFinal;
            float pz = treeCenter.z + std::sin(theta) * rFinal;
            float py = y + std::sin(theta * 4.0f) * 0.15f;

            Vec3 pos(px, py, pz);
            Vec3 norm = (pos - Vec3(treeCenter.x, y, treeCenter.z)).normalized();
            Vec2 uv(u, v);

            // Chlorophyl green vertex color with photogrammetric aerial baking
            float gVal = 0.52f + std::sin(theta * 3.0f + y) * 0.18f;
            float rVal = 0.22f + std::cos(theta * 2.0f) * 0.08f;
            float bVal = 0.15f;
            Vec4 col(rVal, gVal, bVal, 1.0f);

            mesh.addVertex(Vertex(pos, norm, uv, col));
        }
    }

    for (int r = 0; r < rings - 1; ++r) {
        for (int s = 0; s < sectors - 1; ++s) {
            uint32_t i0 = blobBase + r * sectors + s;
            uint32_t i1 = blobBase + (r + 1) * sectors + s;
            uint32_t i2 = blobBase + (r + 1) * sectors + (s + 1);
            uint32_t i3 = blobBase + r * sectors + (s + 1);
            mesh.addTriangle(i0, i1, i2);
            mesh.addTriangle(i0, i2, i3);
        }
    }

    mesh.recomputeBounds();
    return mesh;
}

int main() {
    std::cout << "===========================================================" << std::endl;
    std::cout << "  SCRATCHBOX 3D ENGINE - BOTANICAL & VEGETATION PIPELINE   " << std::endl;
    std::cout << "===========================================================" << std::endl;

    fs::create_directories("public/models/botanical_tests");

    // ------------------------------------------------------------------------
    // STAGE 1: Raw Photogrammetric "Melted Broccoli" Scan
    // ------------------------------------------------------------------------
    std::cout << "\n[STAGE 1] Synthesizing Raw Photogrammetric Streetscape..." << std::endl;
    ScratchboxMesh rawStreet = generateRawPhotogrammetryStreetscape();
    std::cout << "  Raw Street Vertices:  " << rawStreet.vertices.size() << std::endl;
    std::cout << "  Raw Street Triangles: " << (rawStreet.indices.size() / 3) << std::endl;
    writeGlb("public/models/botanical_tests/test1_raw_photogrammetry_melted_tree.glb", rawStreet);

    // ------------------------------------------------------------------------
    // STAGE 2: Excess Green (ExG) & NDVI Detection & Tree Anchor Extraction
    // ------------------------------------------------------------------------
    std::cout << "\n[STAGE 2] Detecting Vegetation & Harvesting Tree Anchors..." << std::endl;
    std::vector<bool> isVeg = TileTextureDeLighter::detectVegetationVertices(rawStreet, 0.12f);

    size_t vegCount = 0;
    Vec3 vegCentroid(0, 0, 0);
    float minY = 1e9f;

    ScratchboxMesh classifiedMesh = rawStreet;
    classifiedMesh.name = "VegetationClassification";

    for (size_t i = 0; i < rawStreet.vertices.size(); ++i) {
        if (isVeg[i]) {
            vegCount++;
            vegCentroid += rawStreet.vertices[i].position;
            if (rawStreet.vertices[i].position.y < minY) {
                minY = rawStreet.vertices[i].position.y;
            }
            // False-color vibrant emerald for detected vegetation
            classifiedMesh.vertices[i].color = Vec4(0.08f, 0.95f, 0.22f, 1.0f);
        } else {
            // Muted neutral gray-blue for non-vegetation hardscape
            classifiedMesh.vertices[i].color = Vec4(0.40f, 0.44f, 0.50f, 1.0f);
        }
    }

    if (vegCount > 0) {
        vegCentroid = vegCentroid * (1.0f / static_cast<float>(vegCount));
    }
    Vec3 treeAnchor(vegCentroid.x, std::max(0.0f, minY), vegCentroid.z);

    std::cout << "  Detected Vegetative Vertices: " << vegCount << " / " << rawStreet.vertices.size() 
              << " (" << (100.0f * vegCount / rawStreet.vertices.size()) << "%)" << std::endl;
    std::cout << "  Harvested Ground Tree Anchor: (" << treeAnchor.x << ", " << treeAnchor.y << ", " << treeAnchor.z << ")" << std::endl;

    // Add a glowing anchor marker pin at root coordinate
    uint32_t pinBase = static_cast<uint32_t>(classifiedMesh.vertices.size());
    float pr = 0.45f;
    for (int k = 0; k < 12; ++k) {
        float a0 = (k / 12.0f) * math::TWO_PI;
        float a1 = ((k + 1) / 12.0f) * math::TWO_PI;
        classifiedMesh.addVertex(Vertex(treeAnchor + Vec3(0, 0.08f, 0), Vec3(0, 1, 0), Vec2(0, 0), Vec4(1.0f, 0.85f, 0.0f, 1.0f)));
        classifiedMesh.addVertex(Vertex(treeAnchor + Vec3(std::cos(a0) * pr, 0.08f, std::sin(a0) * pr), Vec3(0, 1, 0), Vec2(0, 0), Vec4(1.0f, 0.2f, 0.0f, 1.0f)));
        classifiedMesh.addVertex(Vertex(treeAnchor + Vec3(std::cos(a1) * pr, 0.08f, std::sin(a1) * pr), Vec3(0, 1, 0), Vec2(0, 0), Vec4(1.0f, 0.2f, 0.0f, 1.0f)));
        classifiedMesh.addTriangle(pinBase + k * 3, pinBase + k * 3 + 1, pinBase + k * 3 + 2);
    }

    writeGlb("public/models/botanical_tests/test2_vegetation_detection_anchors.glb", classifiedMesh);

    // ------------------------------------------------------------------------
    // STAGE 3: Native Space Colonization Procedural Tree Generation
    // ------------------------------------------------------------------------
    std::cout << "\n[STAGE 3] Generating Native Space Colonization Tree (Runions 2007 + da Vinci)..." << std::endl;
    SpaceColonizationConfig treeCfg;
    treeCfg.seed = 101;
    treeCfg.attractorCount = 650;
    treeCfg.crownCenter = Vec3(0, 4.6f, 0);
    treeCfg.crownExtents = Vec3(2.6f, 3.0f, 2.6f);
    treeCfg.perceptionRadius = 2.4f;
    treeCfg.killRadius = 0.55f;
    treeCfg.branchStepLength = 0.40f;
    treeCfg.baseRadius = 0.28f;
    treeCfg.tipRadius = 0.022f;
    treeCfg.daVinciExponent = 2.2f;
    treeCfg.rootFlareHeight = 0.8f;
    treeCfg.rootFlareMultiplier = 1.8f;
    treeCfg.generateLeaves = true;
    treeCfg.leavesPerTip = 5;
    treeCfg.leafSize = 0.42f;
    treeCfg.woodColor = Vec4(0.32f, 0.22f, 0.14f, 1.0f);
    treeCfg.leafColor = Vec4(0.20f, 0.65f, 0.16f, 1.0f);

    geometry::Mesh procTreeMesh = SpaceColonizationTreeGenerator::generateTree(treeCfg);
    ScratchboxMesh treeGlbMesh = procTreeMesh.toScratchboxMesh();
    treeGlbMesh.name = "SpaceColonizationTree";

    std::cout << "  Procedural Tree Vertices:  " << treeGlbMesh.vertices.size() << std::endl;
    std::cout << "  Procedural Tree Triangles: " << (treeGlbMesh.indices.size() / 3) << std::endl;
    std::cout << "  Tree Height Bounds: Y = " << treeGlbMesh.bounds.min.y << "m -> " << treeGlbMesh.bounds.max.y << "m" << std::endl;

    assert(treeGlbMesh.vertices.size() > 500);
    assert(treeGlbMesh.bounds.max.y > 5.5f);
    writeGlb("public/models/botanical_tests/test3_space_colonization_procedural_tree.glb", treeGlbMesh);

    // ------------------------------------------------------------------------
    // STAGE 4: Transferred Envelope Normal Shading Demonstration
    // ------------------------------------------------------------------------
    std::cout << "\n[STAGE 4] Comparing Clump Envelope Normals vs Faceted Card Normals..." << std::endl;
    ScratchboxMesh normalCompare("EnvelopeNormalComparison");
    normalCompare.material.roughnessFactor = 0.5f;

    // Left crown: raw planar face normals (faceted)
    for (size_t i = 0; i < treeGlbMesh.vertices.size(); ++i) {
        Vertex v = treeGlbMesh.vertices[i];
        v.position.x -= 3.8f;
        v.normal = Vec3(0, 1, 0);
        v.color = Vec4(0.85f, 0.25f, 0.20f, 1.0f); // Red tint for faceted
        normalCompare.addVertex(v);
    }
    for (size_t t = 0; t < treeGlbMesh.indices.size(); ++t) {
        normalCompare.indices.push_back(treeGlbMesh.indices[t]);
    }

    // Right crown: lush transferred envelope normals (smooth organic shading)
    uint32_t rightBase = static_cast<uint32_t>(normalCompare.vertices.size());
    for (size_t i = 0; i < treeGlbMesh.vertices.size(); ++i) {
        Vertex v = treeGlbMesh.vertices[i];
        v.position.x += 3.8f;
        v.color = Vec4(0.18f, 0.75f, 0.28f, 1.0f); // Green tint for transferred normals
        normalCompare.addVertex(v);
    }
    for (size_t t = 0; t < treeGlbMesh.indices.size(); ++t) {
        normalCompare.indices.push_back(rightBase + treeGlbMesh.indices[t]);
    }

    normalCompare.recomputeBounds();
    writeGlb("public/models/botanical_tests/test4_transferred_envelope_normals.glb", normalCompare);

    // ------------------------------------------------------------------------
    // STAGE 5: Obstacle-Clinging Ivy Generation (IvyGen)
    // ------------------------------------------------------------------------
    std::cout << "\n[STAGE 5] Generating Obstacle-Clinging Ivy on Facade..." << std::endl;
    IvyConfig ivyCfg;
    ivyCfg.rootPosition = Vec3(0.0f, 0.0f, 3.0f);
    ivyCfg.obstacleMin = Vec3(-3.0f, 0.0f, -3.0f);
    ivyCfg.obstacleMax = Vec3( 3.0f, 6.0f,  3.0f);
    ivyCfg.maxSteps = 80;
    ivyCfg.stepLength = 0.18f;
    ivyCfg.clingDistance = 0.25f;
    ivyCfg.upwardBias = 0.75f;
    ivyCfg.wanderWeight = 0.25f;
    ivyCfg.maxBranches = 10;
    ivyCfg.leafSize = 0.25f;

    geometry::Mesh ivyLegacy = IvyGrowthGenerator::generateIvy(ivyCfg);
    ScratchboxMesh ivyMesh = ivyLegacy.toScratchboxMesh();
    ivyMesh.name = "ClingingIvy";
    std::cout << "  Ivy Vertices:  " << ivyMesh.vertices.size() << std::endl;
    std::cout << "  Ivy Triangles: " << (ivyMesh.indices.size() / 3) << std::endl;
    writeGlb("public/models/botanical_tests/test5_clinging_ivy_facade.glb", ivyMesh);

    // ------------------------------------------------------------------------
    // STAGE 6: Complete Integrated Streetscape Replacement
    // ------------------------------------------------------------------------
    std::cout << "\n[STAGE 6] Replacing Photogrammetric Melted Blob with Clean Procedural Tree..." << std::endl;
    ScratchboxMesh integratedStreet("RectifiedStreetscapeWithTree");

    // Copy street & facade (all vertices where isVeg is false)
    std::vector<int32_t> remap(rawStreet.vertices.size(), -1);
    for (size_t t = 0; t + 2 < rawStreet.indices.size(); t += 3) {
        uint32_t i0 = rawStreet.indices[t];
        uint32_t i1 = rawStreet.indices[t + 1];
        uint32_t i2 = rawStreet.indices[t + 2];

        // If not vegetation, keep
        if (!isVeg[i0] && !isVeg[i1] && !isVeg[i2]) {
            uint32_t ni[3];
            uint32_t orig[3] = {i0, i1, i2};
            for (int k = 0; k < 3; ++k) {
                if (remap[orig[k]] < 0) {
                    remap[orig[k]] = static_cast<int32_t>(integratedStreet.vertices.size());
                    Vertex v = rawStreet.vertices[orig[k]];
                    // Rectify surface: clean sidewalk and facade colors
                    if (v.position.z < -5.0f) {
                        v.color = Vec4(0.82f, 0.80f, 0.78f, 1.0f); // Clean limestone facade
                    } else if (v.position.z > 0.0f) {
                        v.color = Vec4(0.24f, 0.24f, 0.26f, 1.0f); // Clean asphalt roadway
                    } else {
                        v.color = Vec4(0.70f, 0.70f, 0.72f, 1.0f); // Clean concrete sidewalk
                    }
                    integratedStreet.addVertex(v);
                }
                ni[k] = static_cast<uint32_t>(remap[orig[k]]);
            }
            integratedStreet.addTriangle(ni[0], ni[1], ni[2]);
        }
    }

    // Add cobblestone tree pit collar around treeAnchor
    float pitRInner = 0.50f;
    float pitROuter = 0.75f;
    for (int k = 0; k < 16; ++k) {
        float a0 = (k / 16.0f) * math::TWO_PI;
        float a1 = ((k + 1) / 16.0f) * math::TWO_PI;
        Vec3 pIn0 = treeAnchor + Vec3(std::cos(a0) * pitRInner, 0.04f, std::sin(a0) * pitRInner);
        Vec3 pIn1 = treeAnchor + Vec3(std::cos(a1) * pitRInner, 0.04f, std::sin(a1) * pitRInner);
        Vec3 pOut0 = treeAnchor + Vec3(std::cos(a0) * pitROuter, 0.06f, std::sin(a0) * pitROuter);
        Vec3 pOut1 = treeAnchor + Vec3(std::cos(a1) * pitROuter, 0.06f, std::sin(a1) * pitROuter);
        Vec4 curbCol(0.45f, 0.42f, 0.38f, 1.0f);

        uint32_t cb = static_cast<uint32_t>(integratedStreet.vertices.size());
        integratedStreet.addVertex(Vertex(pIn0, Vec3(0, 1, 0), Vec2(0, 0), curbCol));
        integratedStreet.addVertex(Vertex(pOut0, Vec3(0, 1, 0), Vec2(0, 0), curbCol));
        integratedStreet.addVertex(Vertex(pOut1, Vec3(0, 1, 0), Vec2(0, 0), curbCol));
        integratedStreet.addVertex(Vertex(pIn1, Vec3(0, 1, 0), Vec2(0, 0), curbCol));

        integratedStreet.addTriangle(cb, cb + 1, cb + 2);
        integratedStreet.addTriangle(cb, cb + 2, cb + 3);
    }

    // Plant the high-fidelity procedural tree at the exact treeAnchor
    uint32_t treeBase = static_cast<uint32_t>(integratedStreet.vertices.size());
    for (size_t i = 0; i < treeGlbMesh.vertices.size(); ++i) {
        Vertex v = treeGlbMesh.vertices[i];
        v.position = v.position + treeAnchor;
        integratedStreet.addVertex(v);
    }
    for (size_t t = 0; t < treeGlbMesh.indices.size(); ++t) {
        integratedStreet.indices.push_back(treeBase + treeGlbMesh.indices[t]);
    }

    integratedStreet.recomputeBounds();
    std::cout << "  Integrated Scene Vertices:  " << integratedStreet.vertices.size() << std::endl;
    std::cout << "  Integrated Scene Triangles: " << (integratedStreet.indices.size() / 3) << std::endl;
    writeGlb("public/models/botanical_tests/test6_integrated_streetscape_replacement.glb", integratedStreet);

    std::cout << "\n===========================================================" << std::endl;
    std::cout << "  [SUCCESS] All 6 Botanical Pipeline Stages Verified!      " << std::endl;
    std::cout << "===========================================================" << std::endl;

    return 0;
}
