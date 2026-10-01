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
#include "scratchbox_io.hpp"
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
using namespace scratchbox::io;

void writeGlb(const std::string& path, const ScratchboxMesh& mesh) {
    fs::create_directories(fs::path(path).parent_path());
    std::vector<uint8_t> bytes = GlbWriter::writeGlb(mesh);
    std::ofstream out(path, std::ios::binary);
    out.write(reinterpret_cast<const char*>(bytes.data()), static_cast<std::streamsize>(bytes.size()));
    out.close();
    std::cout << "  -> Wrote " << bytes.size() << " bytes (" 
              << (mesh.indices.size() / 3) << " tris, "
              << mesh.vertices.size() << " verts) to " << path << std::endl;
}

int main() {
    std::cout << "=================================================================" << std::endl;
    std::cout << " Scratchbox 3D Engine: Detailed Leaf & Twig Generation Test Suite" << std::endl;
    std::cout << "=================================================================" << std::endl;

    std::string outDir = "public/models/leaf_tests/";
    fs::create_directories(outDir);

    // -------------------------------------------------------------------------
    // Test 1: Single Ovate Simple Leaf (Beech / Magnolia)
    // -------------------------------------------------------------------------
    std::cout << "\n[Test 1] Generating Single Ovate Simple Leaf..." << std::endl;
    DetailedLeafConfig ovateCfg;
    ovateCfg.morphology = LeafMorphology::OvateSimple;
    ovateCfg.length = 0.35f;
    ovateCfg.widthRatio = 0.58f;
    ovateCfg.petioleLength = 0.08f;
    ovateCfg.petioleRadius = 0.005f;
    ovateCfg.midribDepth = 0.016f;
    ovateCfg.laminaCupping = 0.035f;
    ovateCfg.droopCurvature = 0.045f;
    ovateCfg.lengthSubdivs = 14;
    ovateCfg.widthSubdivs = 10;
    ovateCfg.veinColor = Vec4(0.48f, 0.78f, 0.22f, 1.0f);
    ovateCfg.laminaColor = Vec4(0.12f, 0.45f, 0.09f, 1.0f);
    ovateCfg.marginColor = Vec4(0.24f, 0.65f, 0.18f, 1.0f);

    geometry::Mesh ovateMesh = DetailedLeafGenerator::generateLeafMesh(ovateCfg);
    ovateMesh.name = "OvateSimpleLeaf";
    ovateMesh.material.roughnessFactor = 0.38f;
    ovateMesh.material.metallicFactor = 0.02f;
    ovateMesh.material.doubleSided = true;
    ScratchboxMesh ovateSm = ovateMesh.toScratchboxMesh();
    writeGlb(outDir + "leaf_test1_ovate_simple.glb", ovateSm);

    // -------------------------------------------------------------------------
    // Test 2: Single Serrated Leaf (Birch / Cherry)
    // -------------------------------------------------------------------------
    std::cout << "\n[Test 2] Generating Single Serrated Leaf (Birch/Cherry)..." << std::endl;
    DetailedLeafConfig serratedCfg;
    serratedCfg.morphology = LeafMorphology::SerratedBirch;
    serratedCfg.length = 0.32f;
    serratedCfg.widthRatio = 0.62f;
    serratedCfg.petioleLength = 0.07f;
    serratedCfg.petioleRadius = 0.0045f;
    serratedCfg.midribDepth = 0.014f;
    serratedCfg.laminaCupping = 0.030f;
    serratedCfg.droopCurvature = 0.040f;
    serratedCfg.serrationFrequency = 16.0f;
    serratedCfg.serrationAmplitude = 0.12f;
    serratedCfg.lengthSubdivs = 18;
    serratedCfg.widthSubdivs = 10;
    serratedCfg.veinColor = Vec4(0.52f, 0.82f, 0.25f, 1.0f);
    serratedCfg.laminaColor = Vec4(0.15f, 0.48f, 0.11f, 1.0f);
    serratedCfg.marginColor = Vec4(0.28f, 0.70f, 0.20f, 1.0f);

    geometry::Mesh serratedMesh = DetailedLeafGenerator::generateLeafMesh(serratedCfg);
    serratedMesh.name = "SerratedBirchLeaf";
    serratedMesh.material.roughnessFactor = 0.42f;
    serratedMesh.material.metallicFactor = 0.02f;
    serratedMesh.material.doubleSided = true;
    ScratchboxMesh serratedSm = serratedMesh.toScratchboxMesh();
    writeGlb(outDir + "leaf_test2_serrated.glb", serratedSm);

    // -------------------------------------------------------------------------
    // Test 3: Single Lobed Leaf (Oak / Maple)
    // -------------------------------------------------------------------------
    std::cout << "\n[Test 3] Generating Single Lobed Leaf (Oak/Maple)..." << std::endl;
    DetailedLeafConfig lobedCfg;
    lobedCfg.morphology = LeafMorphology::LobedOakMaple;
    lobedCfg.length = 0.36f;
    lobedCfg.widthRatio = 0.70f;
    lobedCfg.petioleLength = 0.09f;
    lobedCfg.petioleRadius = 0.0055f;
    lobedCfg.midribDepth = 0.018f;
    lobedCfg.laminaCupping = 0.038f;
    lobedCfg.droopCurvature = 0.042f;
    lobedCfg.lengthSubdivs = 20;
    lobedCfg.widthSubdivs = 12;
    lobedCfg.veinColor = Vec4(0.55f, 0.80f, 0.24f, 1.0f);
    lobedCfg.laminaColor = Vec4(0.18f, 0.44f, 0.12f, 1.0f);
    lobedCfg.marginColor = Vec4(0.32f, 0.68f, 0.22f, 1.0f);

    geometry::Mesh lobedMesh = DetailedLeafGenerator::generateLeafMesh(lobedCfg);
    lobedMesh.name = "LobedOakMapleLeaf";
    lobedMesh.material.roughnessFactor = 0.45f;
    lobedMesh.material.metallicFactor = 0.02f;
    lobedMesh.material.doubleSided = true;
    ScratchboxMesh lobedSm = lobedMesh.toScratchboxMesh();
    writeGlb(outDir + "leaf_test3_lobed_oak_maple.glb", lobedSm);

    // -------------------------------------------------------------------------
    // Test 4: MTree Twig Cluster (Golden Spiral Phyllotaxis Spray)
    // -------------------------------------------------------------------------
    std::cout << "\n[Test 4] Generating MTree Twig Cluster Spray..." << std::endl;
    TwigClusterConfig twigCfg;
    twigCfg.twigLength = 0.55f;
    twigCfg.twigRadiusStart = 0.012f;
    twigCfg.twigRadiusEnd = 0.0035f;
    twigCfg.leafCount = 12;
    twigCfg.phyllotaxis = PhyllotaxisPattern::GoldenSpiral137;
    twigCfg.leafScale = 1.0f;
    twigCfg.insertionAngle = 44.0f * math::DEG_TO_RAD;
    twigCfg.twigColor = Vec4(0.35f, 0.25f, 0.16f, 1.0f);
    
    // Leaf parameters for twig spray
    twigCfg.leafConfig.morphology = LeafMorphology::OvateSimple;
    twigCfg.leafConfig.length = 0.24f;
    twigCfg.leafConfig.widthRatio = 0.56f;
    twigCfg.leafConfig.petioleLength = 0.045f;
    twigCfg.leafConfig.petioleRadius = 0.0035f;
    twigCfg.leafConfig.midribDepth = 0.012f;
    twigCfg.leafConfig.laminaCupping = 0.026f;
    twigCfg.leafConfig.droopCurvature = 0.032f;
    twigCfg.leafConfig.lengthSubdivs = 10;
    twigCfg.leafConfig.widthSubdivs = 8;
    twigCfg.leafConfig.veinColor = Vec4(0.46f, 0.76f, 0.22f, 1.0f);
    twigCfg.leafConfig.laminaColor = Vec4(0.14f, 0.46f, 0.10f, 1.0f);
    twigCfg.leafConfig.marginColor = Vec4(0.24f, 0.62f, 0.18f, 1.0f);

    geometry::Mesh twigMesh = TwigClusterGenerator::generateTwigCluster(twigCfg);
    twigMesh.name = "MTreeTwigSpray";
    twigMesh.material.roughnessFactor = 0.40f;
    twigMesh.material.metallicFactor = 0.02f;
    twigMesh.material.doubleSided = true;
    ScratchboxMesh twigSm = twigMesh.toScratchboxMesh();
    writeGlb(outDir + "leaf_test4_mtree_twig_cluster.glb", twigSm);

    // -------------------------------------------------------------------------
    // Test 5: Full Space Colonization Tree with Detailed Foliage & Normal Transfer
    // -------------------------------------------------------------------------
    std::cout << "\n[Test 5] Generating Full Space Colonization Tree with Detailed Leaves..." << std::endl;
    SpaceColonizationConfig treeCfg;
    treeCfg.crownCenter = Vec3(0, 4.8f, 0);
    treeCfg.crownExtents = Vec3(2.4f, 2.8f, 2.4f);
    treeCfg.attractorCount = 280;
    treeCfg.branchStepLength = 0.42f;
    treeCfg.baseRadius = 0.24f;
    treeCfg.tipRadius = 0.022f;
    treeCfg.rootFlareMultiplier = 1.6f;
    treeCfg.rootFlareHeight = 0.7f;
    treeCfg.generateLeaves = true;
    treeCfg.useDetailedLeaves = true;
    treeCfg.useTwigSprays = true;
    treeCfg.leafMorphology = LeafMorphology::OvateSimple;
    treeCfg.leafSize = 0.32f;
    treeCfg.woodColor = Vec4(0.28f, 0.20f, 0.14f, 1.0f);
    treeCfg.leafColor = Vec4(0.16f, 0.46f, 0.11f, 1.0f);
    treeCfg.seed = 2026;

    geometry::Mesh treeMesh = SpaceColonizationTreeGenerator::generateTree(treeCfg);
    treeMesh.name = "SpaceColonizationDetailedTree";
    treeMesh.material.roughnessFactor = 0.55f;
    treeMesh.material.metallicFactor = 0.02f;
    treeMesh.material.doubleSided = true;
    ScratchboxMesh treeSm = treeMesh.toScratchboxMesh();
    writeGlb(outDir + "leaf_test5_space_colonization_detailed_tree.glb", treeSm);

    std::cout << "\nAll 5 Detailed Leaf & Twig test models successfully generated and exported!" << std::endl;
    return 0;
}
