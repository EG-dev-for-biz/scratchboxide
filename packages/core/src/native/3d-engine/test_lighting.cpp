#include "scratchbox_engine.hpp"
#include <cassert>
#include <iostream>
#include <cmath>

using scratchbox::math::Vec2;
using scratchbox::math::Vec3;
using scratchbox::math::Vec4;

int main() {
    std::cout << "[TEST] Starting Scratchbox 3D Lighting & Scene Budget Verification...\n";

    // 1. Color Science Kelvin verification
    Vec3 candleRgb = lgt::kelvinToLinearRgb(lgt::KELVIN_CANDLE);
    std::cout << "  - Candle 1850K Linear RGB: (" << candleRgb.x << ", " << candleRgb.y << ", " << candleRgb.z << ")\n";
    assert(candleRgb.x > candleRgb.z); // Candle must be warm (red > blue)

    Vec3 daylightLinearRgb = lgt::kelvinToLinearRgb(lgt::KELVIN_FILM_DAYLIGHT);
    std::cout << "  - Daylight 5600K Linear RGB: (" << daylightLinearRgb.x << ", " << daylightLinearRgb.y << ", " << daylightLinearRgb.z << ")\n";

    Vec3 skyRgb = lgt::kelvinToLinearRgb(lgt::KELVIN_COOL_SKY);
    std::cout << "  - Cool Sky 7500K Linear RGB: (" << skyRgb.x << ", " << skyRgb.y << ", " << skyRgb.z << ")\n";
    assert(skyRgb.z > skyRgb.x); // Cool sky must be blue-shifted (blue > red)

    // 2. Attenuation Verification
    float attNear = lgt::evaluateDistanceAttenuation(1.0f, 20.0f);
    float attFar = lgt::evaluateDistanceAttenuation(19.5f, 20.0f);
    float attBeyond = lgt::evaluateDistanceAttenuation(21.0f, 20.0f);
    std::cout << "  - Attenuation d=1.0: " << attNear << ", d=19.5: " << attFar << ", d=21.0: " << attBeyond << "\n";
    assert(attNear > attFar);
    assert(attBeyond == 0.0f);

    // 3. Cinematic Rigs Verification
    auto rig3P = lgt::LightingRigFactory::createThreePointStudioRig();
    assert(rig3P.lights.size() == 4);
    std::cout << "  - 3-Point Studio Rig lights: " << rig3P.lights.size() << "\n";

    auto rigRembrandt = lgt::LightingRigFactory::createRembrandtRig();
    assert(rigRembrandt.lights.size() == 3);
    assert(rigRembrandt.lights[0].type == lgt::LightType::SPOT);
    std::cout << "  - Rembrandt Rig key light type: SPOT, count: " << rigRembrandt.lights.size() << "\n";

    auto rigGlamour = lgt::LightingRigFactory::createParamountGlamourRig();
    assert(rigGlamour.lights.size() == 4);
    std::cout << "  - Paramount Glamour Rig lights: " << rigGlamour.lights.size() << "\n";

    auto rigNoir = lgt::LightingRigFactory::createFilmNoirSplitRig();
    assert(rigNoir.lights.size() == 2);
    std::cout << "  - Film Noir Split Rig lights: " << rigNoir.lights.size() << "\n";

    auto rigSunset = lgt::LightingRigFactory::createGoldenHourSunsetRig();
    assert(rigSunset.lights.size() == 3);
    std::cout << "  - Golden Hour Sunset Rig lights: " << rigSunset.lights.size() << "\n";

    auto rigCyber = lgt::LightingRigFactory::createCyberpunkDualRimRig();
    assert(rigCyber.lights.size() == 3);
    std::cout << "  - Cyberpunk Dual-Rim Rig lights: " << rigCyber.lights.size() << "\n";

    auto rigTorch = lgt::LightingRigFactory::createTorchlightCampfireRig();
    assert(rigTorch.lights.size() == 2);
    std::cout << "  - Torchlight Campfire Rig lights: " << rigTorch.lights.size() << "\n";

    auto rigProduct = lgt::LightingRigFactory::createHighKeyProductRig();
    assert(rigProduct.lights.size() == 3);
    std::cout << "  - High-Key Product Rig lights: " << rigProduct.lights.size() << "\n";

    // 4. Multi-Light PBR Direct Illumination Evaluation
    geo::PbrMaterial goldMat;
    goldMat.baseColorFactor = Vec4(1.0f, 0.766f, 0.336f, 1.0f);
    goldMat.metallicFactor = 1.0f;
    goldMat.roughnessFactor = 0.25f;

    auto pbrResult = lgt::evaluateRigPbrIllumination(
        rigCyber,
        goldMat,
        Vec3(0, 0, 0),
        Vec3(0, 1, 0),
        Vec3(0, 2, 5)
    );
    std::cout << "  - PBR Total Radiance: (" << pbrResult.totalRadiance.x << ", "
              << pbrResult.totalRadiance.y << ", " << pbrResult.totalRadiance.z << ")\n";
    assert(pbrResult.totalRadiance.lengthSq() > 0.0f);

    // 5. Scene Budget Analyzer Verification
    auto metrics = lgt::SceneBudgetAnalyzer::analyze(45000, 75000, rig3P.lights, 1, 3);
    std::cout << "  - Budget Analysis: vertices=" << metrics.totalVertices
              << ", tris=" << metrics.totalTriangles
              << ", shadowLights=" << metrics.shadowCastingLights
              << ", estimatedDrawCalls=" << metrics.estimatedDrawCalls
              << ", frameTime=" << metrics.estimatedFrameTimeMs << "ms\n";
    assert(metrics.optimizationRecommendations.size() > 0);

    // 6. glTF 2.0 KHR_lights_punctual Serialization Verification
    auto sphere = geo::ScratchboxMesh::createSphere(1.0f, 16, 16);
    auto glbBytes = io::GlbWriter::writeGlb(sphere, {}, rigRembrandt.lights);
    assert(!glbBytes.empty());
    std::cout << "  - Serialized glTF .glb with Rembrandt lights: " << glbBytes.size() << " bytes\n";

    // Check for "KHR_lights_punctual" string in the glb header
    std::string glbHeaderStr(reinterpret_cast<const char*>(glbBytes.data()), std::min(glbBytes.size(), size_t{2048}));
    assert(glbHeaderStr.find("KHR_lights_punctual") != std::string::npos);
    assert(glbHeaderStr.find("Rembrandt_Key_Spot") != std::string::npos);
    std::cout << "  - Verified 'KHR_lights_punctual' and 'Rembrandt_Key_Spot' in binary glTF container!\n";

    std::cout << "[TEST SUCCESS] All 3D Lighting & Lightweight Scene Engine features verified!\n";
    return 0;
}
