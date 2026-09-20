/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

#include "scratchbox_engine.hpp"
#include <cassert>
#include <iostream>
#include <fstream>
#include <filesystem>

namespace fs = std::filesystem;

void writeGlbToFile(const std::string& path, const std::vector<uint8_t>& data) {
    fs::create_directories(fs::path(path).parent_path());
    std::ofstream out(path, std::ios::binary);
    if (!out.is_open()) {
        std::cerr << "Failed to open file for writing: " << path << std::endl;
        return;
    }
    out.write(reinterpret_cast<const char*>(data.data()), static_cast<std::streamsize>(data.size()));
    out.close();
    std::cout << "  -> Wrote " << data.size() << " bytes to " << path << std::endl;
}

// Helper to construct a UV sphere for surface PDE and dual meshing tests
scratchbox::geometry::ScratchboxMesh createUvSphere(float radius, int rings, int sectors) {
    using namespace scratchbox;
    using namespace scratchbox::geometry;
    using namespace scratchbox::math;

    ScratchboxMesh sphere("UvSphere");
    sphere.material.baseColorFactor = Vec4(0.85f, 0.85f, 0.90f, 1.0f);
    sphere.material.roughnessFactor = 0.35f;

    float const R = 1.0f / static_cast<float>(rings - 1);
    float const S = 1.0f / static_cast<float>(sectors - 1);

    for (int r = 0; r < rings; ++r) {
        float phi = PI * static_cast<float>(r) * R;
        float y = std::cos(phi);
        float sinPhi = std::sin(phi);

        for (int s = 0; s < sectors; ++s) {
            float theta = TWO_PI * static_cast<float>(s) * S;
            float x = sinPhi * std::cos(theta);
            float z = sinPhi * std::sin(theta);

            Vec3 norm(x, y, z);
            Vec3 pos = norm * radius;
            Vec2 uv(static_cast<float>(s) * S, static_cast<float>(r) * R);
            sphere.addVertex(Vertex(pos, norm, uv, Vec4(0.2f, 0.2f, 0.25f, 1.0f)));
        }
    }

    for (int r = 0; r < rings - 1; ++r) {
        for (int s = 0; s < sectors - 1; ++s) {
            uint32_t i0 = static_cast<uint32_t>(r * sectors + s);
            uint32_t i1 = static_cast<uint32_t>((r + 1) * sectors + s);
            uint32_t i2 = static_cast<uint32_t>((r + 1) * sectors + (s + 1));
            uint32_t i3 = static_cast<uint32_t>(r * sectors + (s + 1));

            sphere.addTriangle(i0, i1, i2);
            sphere.addTriangle(i0, i2, i3);
        }
    }

    sphere.recomputeBounds();
    return sphere;
}

int main() {
    using namespace scratchbox;
    using namespace scratchbox::nature;
    using namespace scratchbox::architecture;
    using namespace scratchbox::halfedge;
    using namespace scratchbox::io;

    std::cout << "===========================================================" << std::endl;
    std::cout << "  SCRATCHBOX 3D ENGINE - BLENDER ALGORITHMS TEST SUITE     " << std::endl;
    std::cout << "===========================================================" << std::endl;

    // ------------------------------------------------------------------------
    // TEST 1: Runions Space Colonization Tree & Leonardo da Vinci Pipe Model
    // ------------------------------------------------------------------------
    std::cout << "\n[TEST 1] Space Colonization Tree Generator (Runions 2007 / Mtree)..." << std::endl;
    {
        SpaceColonizationConfig treeCfg;
        treeCfg.attractorCount = 400;
        treeCfg.crownCenter = math::Vec3(0, 5.0f, 0);
        treeCfg.crownExtents = math::Vec3(2.8f, 3.2f, 2.8f);
        treeCfg.perceptionRadius = 2.5f;
        treeCfg.killRadius = 0.6f;
        treeCfg.branchStepLength = 0.45f;
        treeCfg.baseRadius = 0.35f;
        treeCfg.tipRadius = 0.025f;
        treeCfg.daVinciExponent = 2.2f;
        treeCfg.generateLeaves = true;

        geometry::Mesh treeLegacy = SpaceColonizationTreeGenerator::generateTree(treeCfg);
        geometry::ScratchboxMesh treeMesh = treeLegacy.toScratchboxMesh();

        std::cout << "  Tree Generated: " << treeMesh.vertices.size() << " vertices, "
                  << treeMesh.indices.size() / 3 << " triangles." << std::endl;
        assert(treeMesh.vertices.size() > 500 && "Tree vertex count must exceed 500");
        assert(treeMesh.indices.size() > 500 && "Tree index count must exceed 500");

        // Verify bounding box height spans trunk to crown
        assert(treeMesh.bounds.max.y > 6.0f && "Tree crown top should reach above 6.0m");
        assert(treeMesh.bounds.min.y <= 0.05f && "Tree root should start at ground level");

        std::vector<uint8_t> glbTree = GlbWriter::writeGlb(treeMesh);
        assert(glbTree.size() > 1000 && "Generated GLB must be a valid non-empty container");
        writeGlbToFile("build/test_space_colonization_tree.glb", glbTree);
        std::cout << "  [PASS] Space Colonization Tree algorithm verified!" << std::endl;
    }

    // ------------------------------------------------------------------------
    // TEST 2: Obstacle-Clinging Ivy Growth Generator (Thomas Luft / IvyGen)
    // ------------------------------------------------------------------------
    std::cout << "\n[TEST 2] Obstacle-Clinging Ivy Growth Generator (IvyGen)..." << std::endl;
    {
        IvyConfig ivyCfg;
        ivyCfg.rootPosition = math::Vec3(0, 0, 3.0f);
        ivyCfg.obstacleMin = math::Vec3(-3.0f, 0.0f, -3.0f);
        ivyCfg.obstacleMax = math::Vec3( 3.0f, 5.0f,  3.0f);
        ivyCfg.maxSteps = 60;
        ivyCfg.clingDistance = 0.15f;

        geometry::Mesh ivyLegacy = IvyGrowthGenerator::generateIvy(ivyCfg);
        geometry::ScratchboxMesh ivyMesh = ivyLegacy.toScratchboxMesh();

        std::cout << "  Ivy Generated: " << ivyMesh.vertices.size() << " vertices, "
                  << ivyMesh.indices.size() / 3 << " triangles." << std::endl;
        assert(ivyMesh.vertices.size() > 100 && "Ivy vertex count must exceed 100");
        assert(ivyMesh.indices.size() > 100 && "Ivy index count must exceed 100");

        // Verify vertical ascent
        assert(ivyMesh.bounds.max.y > 1.5f && "Ivy must climb vertically up obstacle");

        std::vector<uint8_t> glbIvy = GlbWriter::writeGlb(ivyMesh);
        assert(glbIvy.size() > 1000 && "Generated GLB must be valid");
        writeGlbToFile("build/test_clinging_ivy.glb", glbIvy);
        std::cout << "  [PASS] Obstacle-Clinging Ivy algorithm verified!" << std::endl;
    }

    // ------------------------------------------------------------------------
    // TEST 3: Procedural Building Grammar & Roof Insets (Building Tools / OSM)
    // ------------------------------------------------------------------------
    std::cout << "\n[TEST 3] Procedural Building Grammar & Roof Generator (Building Tools)..." << std::endl;
    {
        BuildingConfig bldgCfg;
        bldgCfg.width = 14.0f;
        bldgCfg.depth = 10.0f;
        bldgCfg.floorCount = 3;
        bldgCfg.floorHeight = 3.2f;
        bldgCfg.groundFloorHeight = 4.0f;
        bldgCfg.bayWidth = 2.8f;
        bldgCfg.windowWidth = 1.6f;
        bldgCfg.windowHeight = 1.8f;
        bldgCfg.windowRecessDepth = 0.20f;

        // 3a. Hip Roof
        bldgCfg.roofType = RoofType::Hip;
        geometry::ScratchboxMesh bldgHip = ProceduralBuildingGenerator::generateBuilding(bldgCfg, "Building_Hip");
        std::cout << "  Building (Hip Roof): " << bldgHip.vertices.size() << " vertices, "
                  << bldgHip.indices.size() / 3 << " triangles." << std::endl;
        assert(bldgHip.vertices.size() > 300 && "Building mesh should have complete facade and roof");
        assert(bldgHip.indices.size() > 300);

        std::vector<uint8_t> glbHip = GlbWriter::writeGlb(bldgHip);
        assert(glbHip.size() > 1000);
        writeGlbToFile("build/test_procedural_building_hip.glb", glbHip);

        // 3b. Gable Roof
        bldgCfg.roofType = RoofType::Gable;
        geometry::ScratchboxMesh bldgGable = ProceduralBuildingGenerator::generateBuilding(bldgCfg, "Building_Gable");
        assert(bldgGable.vertices.size() > 300);
        std::vector<uint8_t> glbGable = GlbWriter::writeGlb(bldgGable);
        writeGlbToFile("build/test_procedural_building_gable.glb", glbGable);

        // 3c. Flat Parapet Roof
        bldgCfg.roofType = RoofType::FlatParapet;
        geometry::ScratchboxMesh bldgFlat = ProceduralBuildingGenerator::generateBuilding(bldgCfg, "Building_Flat");
        assert(bldgFlat.vertices.size() > 300);
        std::vector<uint8_t> glbFlat = GlbWriter::writeGlb(bldgFlat);
        writeGlbToFile("build/test_procedural_building_flat.glb", glbFlat);

        // 3d. Mansard Roof
        bldgCfg.roofType = RoofType::Mansard;
        geometry::ScratchboxMesh bldgMansard = ProceduralBuildingGenerator::generateBuilding(bldgCfg, "Building_Mansard");
        assert(bldgMansard.vertices.size() > 300);
        std::vector<uint8_t> glbMansard = GlbWriter::writeGlb(bldgMansard);
        writeGlbToFile("build/test_procedural_building_mansard.glb", glbMansard);

        std::cout << "  [PASS] Procedural Building & all 4 Roof Types verified!" << std::endl;
    }

    // ------------------------------------------------------------------------
    // TEST 4: Gray-Scott Reaction-Diffusion PDE (Turing Morphogenesis / Tissue)
    // ------------------------------------------------------------------------
    std::cout << "\n[TEST 4] Gray-Scott Reaction-Diffusion PDE on 3D Surface (Tissue)..." << std::endl;
    {
        geometry::ScratchboxMesh sphere = createUvSphere(2.0f, 32, 32);
        size_t initialVerts = sphere.vertices.size();

        ReactionDiffusionConfig rdCfg;
        rdCfg.feedRate = 0.0545f;
        rdCfg.killRate = 0.0620f;
        rdCfg.diffusionU = 0.16f;
        rdCfg.diffusionV = 0.08f;
        rdCfg.dt = 1.0f;
        rdCfg.iterations = 100;
        rdCfg.displacementScale = 0.06f;

        GrayScottReactionDiffusion::simulate(sphere, rdCfg);

        std::cout << "  Reaction-Diffusion Simulated on " << sphere.vertices.size() << " vertices." << std::endl;
        assert(sphere.vertices.size() == initialVerts);

        // Verify that vertex colors have differentiated into Turing spots (variance > 0)
        float minColorR = 1.0f, maxColorR = 0.0f;
        for (const auto& v : sphere.vertices) {
            minColorR = std::min(minColorR, v.color.x);
            maxColorR = std::max(maxColorR, v.color.x);
        }
        std::cout << "  Vertex Color.R dynamic range: [" << minColorR << ", " << maxColorR << "]" << std::endl;
        assert(maxColorR > minColorR + 0.1f && "Turing patterns must produce color differentiation");

        std::vector<uint8_t> glbRD = GlbWriter::writeGlb(sphere);
        assert(glbRD.size() > 1000);
        writeGlbToFile("build/test_reaction_diffusion.glb", glbRD);
        std::cout << "  [PASS] Gray-Scott Reaction-Diffusion algorithm verified!" << std::endl;
    }

    // ------------------------------------------------------------------------
    // TEST 5: Topological Dual Mesh & Wireframe Lattice (Tissue / Sverchok)
    // ------------------------------------------------------------------------
    std::cout << "\n[TEST 5] Topological Dual Mesh & Honeycomb Wireframe (Tissue)..." << std::endl;
    {
        geometry::ScratchboxMesh baseSphere = createUvSphere(1.8f, 16, 16);
        size_t primalFaces = baseSphere.indices.size() / 3;

        // 5a. Dual Mesh Generation
        geometry::ScratchboxMesh dualMesh = DualMeshOperator::computeDualMesh(baseSphere, "DualSphere");
        std::cout << "  Primal faces: " << primalFaces << " -> Dual vertices: " << dualMesh.vertices.size() << std::endl;
        assert(dualMesh.vertices.size() == primalFaces && "Every primal face must correspond to one dual vertex");
        assert(dualMesh.indices.size() > 0 && "Dual mesh must contain triangulated dual polygons");

        std::vector<uint8_t> glbDual = GlbWriter::writeGlb(dualMesh);
        assert(glbDual.size() > 1000);
        writeGlbToFile("build/test_topological_dual.glb", glbDual);

        // 5b. Wireframe Lattice Generation
        geometry::ScratchboxMesh lattice = DualMeshOperator::generateWireframeLattice(dualMesh, 0.035f);
        std::cout << "  Lattice generated: " << lattice.vertices.size() << " vertices, "
                  << lattice.indices.size() / 3 << " triangles." << std::endl;
        assert(lattice.vertices.size() > 200 && "Lattice struts must be extruded");
        assert(lattice.indices.size() > 200);

        std::vector<uint8_t> glbLattice = GlbWriter::writeGlb(lattice);
        assert(glbLattice.size() > 1000);
        writeGlbToFile("build/test_dual_lattice.glb", glbLattice);

        std::cout << "  [PASS] Topological Dual Mesh & Lattice verified!" << std::endl;
    }

    // ------------------------------------------------------------------------
    // TEST 6: Grass Clump Generator (V-Keel Fold + Bézier Droop + Radial Splay)
    // ------------------------------------------------------------------------
    std::cout << "\n[TEST 6] Procedural Grass Clump & Field Generator (V-Keel / Splay / Senescence)..." << std::endl;
    {
        GrassClumpConfig clumpCfg;
        clumpCfg.bladeCount = 48;
        clumpCfg.clumpRadius = 0.35f;
        clumpCfg.bladeHeightMin = 0.50f;
        clumpCfg.bladeHeightMax = 0.90f;
        clumpCfg.bladeWidthBase = 0.035f;
        clumpCfg.bladeWidthMid = 0.042f;
        clumpCfg.keelDepth = 0.016f;
        clumpCfg.segmentsPerBlade = 7;
        clumpCfg.gravityDroop = 0.45f;
        clumpCfg.radialSplay = 0.70f;
        clumpCfg.curlStochasticity = 0.25f;
        clumpCfg.centerHeightBias = 0.40f;
        clumpCfg.clumpNormalBlend = 0.30f;

        geometry::Mesh clumpRaw = GrassClumpGenerator::generateClump(clumpCfg);
        geometry::ScratchboxMesh clumpMesh = clumpRaw.toScratchboxMesh();

        std::cout << "  Grass Clump Generated: " << clumpMesh.vertices.size() << " vertices, "
                  << clumpMesh.indices.size() / 3 << " triangles." << std::endl;

        // Verify minimum geometry constraints
        assert(clumpMesh.vertices.size() >= 48 * (7 * 3 + 1) && "Clump must have all blades generated");
        assert(clumpMesh.indices.size() > 2000 && "Indices must cover triangulated V-keels");

        // Verify bounds & height
        assert(clumpMesh.bounds.max.y > 0.45f && "Clump must have vertical height");
        assert(clumpMesh.bounds.min.y <= 0.05f && "Clump roots must be at ground level");

        // Verify 3D V-keel fold depth: check non-coplanarity between left, center, and right vertices
        bool foundVKeelCrease = false;
        for (size_t i = 0; i + 2 < clumpMesh.vertices.size(); i += 3) {
            const auto& pL = clumpMesh.vertices[i].position;
            const auto& pC = clumpMesh.vertices[i + 1].position;
            const auto& pR = clumpMesh.vertices[i + 2].position;

            math::Vec3 midLR = (pL + pR) * 0.5f;
            float creaseDist = (pC - midLR).length();
            if (creaseDist > 0.005f) {
                foundVKeelCrease = true;
                break;
            }
        }
        assert(foundVKeelCrease && "Grass blades must possess folded 3D V-keel cross-section crease");
        std::cout << "  [PASS] 3D V-keel fold crease verified!" << std::endl;

        // Verify senescence color gradient across vertices
        float minGreen = 1.0f, maxGreen = 0.0f;
        float minRed = 1.0f, maxRed = 0.0f;
        for (const auto& v : clumpMesh.vertices) {
            minGreen = std::min(minGreen, v.color.y);
            maxGreen = std::max(maxGreen, v.color.y);
            minRed = std::min(minRed, v.color.x);
            maxRed = std::max(maxRed, v.color.x);
        }
        std::cout << "  Color Channels - Red: [" << minRed << ", " << maxRed << "], Green: ["
                  << minGreen << ", " << maxGreen << "]" << std::endl;
        assert(maxGreen - minGreen > 0.15f && "Biological senescence color gradient must differentiate along blade");
        assert(maxRed - minRed > 0.15f && "Senescent tips / basal sheath must have red channel variation");

        // Serialize single clump to GLB
        std::vector<uint8_t> glbClump = GlbWriter::writeGlb(clumpMesh);
        assert(glbClump.size() > 5000 && "Clump GLB must be valid binary container");
        writeGlbToFile("build/test_grass_clump.glb", glbClump);

        // 6b. Grass Field Generation (Multi-Clump Scatter)
        GrassFieldConfig fieldCfg;
        fieldCfg.clumpCount = 20;
        fieldCfg.areaMin = math::Vec2(-2.5f, -2.5f);
        fieldCfg.areaMax = math::Vec2(2.5f, 2.5f);
        fieldCfg.minClumpDistance = 0.50f;

        geometry::Mesh fieldRaw = GrassClumpGenerator::generateField(fieldCfg, clumpCfg);
        geometry::ScratchboxMesh fieldMesh = fieldRaw.toScratchboxMesh();

        std::cout << "  Grass Field Generated: " << fieldMesh.vertices.size() << " vertices, "
                  << fieldMesh.indices.size() / 3 << " triangles." << std::endl;
        assert(fieldMesh.vertices.size() > clumpMesh.vertices.size() * 10 && "Field must contain multiple dispersed clumps");

        std::vector<uint8_t> glbField = GlbWriter::writeGlb(fieldMesh);
        assert(glbField.size() > 50000 && "Field GLB must be valid");
        writeGlbToFile("build/test_grass_field.glb", glbField);

        std::cout << "  [PASS] Grass Clump & Field Generator verified!" << std::endl;
    }

    std::cout << "\n===========================================================" << std::endl;
    std::cout << "  ALL 6 BLENDER ALGORITHMIC ABSTRACTION TESTS PASSED!      " << std::endl;
    std::cout << "===========================================================" << std::endl;
    return 0;
}
