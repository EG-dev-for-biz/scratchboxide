#include "scratchbox_engine.hpp"
#include <iostream>
#include <cassert>

int main() {
    using namespace scratchbox;
    using namespace scratchbox::inducer;
    using namespace scratchbox::texture;
    using namespace scratchbox::geometry;

    std::cout << "Testing Universal Architectural Texture & PBR Inducer (C++20)..." << std::endl;

    // 1. Synthesize a synthetic 512x512 brick pattern with mortar rakes
    ImageBuffer syntheticBrick(512, 512, 3);
    for (int y = 0; y < 512; ++y) {
        int courseIdx = y / 24; // course height 24px
        int yInCourse = y % 24;
        bool isHorizMortar = (yInCourse < 3);

        for (int x = 0; x < 512; ++x) {
            int xOffset = (courseIdx % 2 == 0) ? 0 : 48;
            int xInBrick = (x + xOffset) % 96; // brick width 96px
            bool isVertMortar = (xInBrick < 3);

            if (isHorizMortar || isVertMortar) {
                // Dark recessed mortar
                syntheticBrick.setPixelRGB(x, y, Vec3(0.35f, 0.35f, 0.38f));
            } else {
                // Buff Roman clay brick
                float noise = (std::sin(x * 0.1f) + std::cos(y * 0.1f)) * 0.05f;
                syntheticBrick.setPixelRGB(x, y, Vec3(0.82f + noise, 0.68f + noise, 0.52f + noise));
            }
        }
    }

    // 2. Test Spatial Autocorrelation & Frequency Induction
    auto profile = analyzeTextureSpatialProfile(syntheticBrick, 2.0f);
    std::cout << "-> Spatial Profile Detected: "
              << "Periodic=" << (profile.isPeriodic ? "YES" : "NO")
              << ", AspectRatio=" << profile.aspectRatio
              << ", PeriodX=" << profile.dominantPeriodPxX << "px"
              << ", PeriodY=" << profile.dominantPeriodPxY << "px"
              << ", Module=" << profile.physicalModuleWidthMeters << "m x " << profile.physicalModuleHeightMeters << "m"
              << ", Recommended Repeats=(" << profile.recommendedRepeatX << ", " << profile.recommendedRepeatY << ")"
              << std::endl;

    assert(profile.isPeriodic);
    assert(profile.dominantPeriodPxY > 0.0f);

    // 3. Synthesize Normal Map for the brick
    ImageBuffer normalMap(512, 512, 3);
    for (int y = 0; y < 512; ++y) {
        for (int x = 0; x < 512; ++x) {
            float lumL = syntheticBrick.getLuminance(x - 1, y);
            float lumR = syntheticBrick.getLuminance(x + 1, y);
            float lumD = syntheticBrick.getLuminance(x, y - 1);
            float lumU = syntheticBrick.getLuminance(x, y + 1);

            float dx = (lumR - lumL) * 2.5f;
            float dy = (lumU - lumD) * 2.5f;
            Vec3 norm(-dx, -dy, 1.0f);
            norm = norm.normalized();
            // Encode to [0, 1]
            normalMap.setPixelRGB(x, y, Vec3(norm.x * 0.5f + 0.5f, norm.y * 0.5f + 0.5f, norm.z * 0.5f + 0.5f));
        }
    }

    // 4. Test Adaptive Normal Scale Multiplier Calibration
    auto normAnalysis = calibrateNormalScale(normalMap);
    std::cout << "-> Normal Scale Calibrated: "
              << "GradientVariance=" << normAnalysis.gradientVariance
              << ", RecommendedNormalScale=" << normAnalysis.recommendedNormalScale
              << ", AOIntensity=" << normAnalysis.recommendedAoIntensity
              << std::endl;

    assert(normAnalysis.recommendedNormalScale >= 1.5f);

    // 5. Test Image Space HBAO Generation
    ImageBuffer hbao = generateMicroCavityAo(normalMap, 8);
    std::cout << "-> Micro-Cavity HBAO Generated: Size=" << hbao.width << "x" << hbao.height
              << ", Channels=" << hbao.channels << std::endl;
    assert(!hbao.empty());

    // 6. Test Semantic Mesh Partitioning on a compound architectural building (Plinth + Shaft + Roof)
    ScratchboxMesh testBuilding("test_building");
    // Plinth: 20m x 4m x 20m at Y = 2m
    ScratchboxMesh plinth = ScratchboxMesh::createBox(Vec3(22.0f, 4.0f, 22.0f));
    for (auto& v : plinth.vertices) v.position += Vec3(0.0f, 2.0f, 0.0f);
    // Shaft: 18m x 50m x 18m at Y = 29m
    ScratchboxMesh shaft = ScratchboxMesh::createBox(Vec3(18.0f, 50.0f, 18.0f));
    for (auto& v : shaft.vertices) v.position += Vec3(0.0f, 29.0f, 0.0f);

    testBuilding.merge(plinth);
    testBuilding.merge(shaft);

    auto partition = classifyMeshAndInduceParameters(testBuilding, 0.0f, 4.0f);
    std::cout << "-> Semantic Mesh Partitioned: "
              << "TotalFaces=" << partition.faceZones.size()
              << ", PlinthFaces=" << partition.groundPlinthFaces
              << ", ShaftFaces=" << partition.mainShaftFaces
              << ", RoofFaces=" << partition.horizontalDeckFaces
              << ", CorniceFaces=" << partition.corniceFaces
              << std::endl;
    for (size_t i = 0; i < partition.faceZones.size(); ++i) {
        std::cout << "Face " << i << ": Zone=" << getSemanticZoneName(partition.faceZones[i]) << std::endl;
    }

    assert(partition.groundPlinthFaces > 0);
    assert(partition.mainShaftFaces > 0);
    assert(partition.horizontalDeckFaces > 0);

    std::cout << "ALL UNIVERSAL TEXTURE INDUCER TESTS PASSED!" << std::endl;
    return 0;
}
