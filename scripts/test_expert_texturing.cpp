/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * Test Harness for Master-Class Texture Application Systems (C++20).
 ********************************************************************************/

#include "scratchbox_pbr_texture_expert.hpp"
#include <iostream>
#include <cassert>

using namespace scratchbox;
using namespace scratchbox::pbr_texture;
using math::Vec2;
using math::Vec3;

int main() {
    std::cout << "Testing Master-Class Texture Application Systems (C++20)..." << std::endl;

    // 1. Test Reoriented Normal Mapping (RNM)
    std::cout << "-> 1. Testing Reoriented Normal Mapping (RNM)..." << std::endl;
    Vec3 macroN(0.0f, 0.0f, 1.0f);
    Vec3 mesoN(0.2f, 0.1f, 0.97f);
    mesoN = mesoN.normalized();
    Vec3 microN(0.05f, -0.08f, 0.99f);
    microN = microN.normalized();

    Vec3 blendedN = ReorientedNormalHierarchy::blendThreeTier(macroN, mesoN, microN);
    std::cout << "   Blended Normal: (" << blendedN.x << ", " << blendedN.y << ", " << blendedN.z << ")" << std::endl;
    assert(std::abs(blendedN.length() - 1.0f) < 1e-4f);
    assert(blendedN.z > 0.9f);

    // 2. Test Toksvig Specular Anti-Aliasing Filter
    std::cout << "-> 2. Testing Toksvig Specular Filtering..." << std::endl;
    float baseRough = 0.2f;
    float lowVariance = 0.01f;
    float highVariance = 0.45f;
    float filteredLow = ToksvigFilter::filterRoughness(baseRough, lowVariance);
    float filteredHigh = ToksvigFilter::filterRoughness(baseRough, highVariance);
    std::cout << "   Roughness: Base=" << baseRough << " -> LowVar=" << filteredLow << " -> HighVar=" << filteredHigh << std::endl;
    assert(filteredHigh > filteredLow);
    assert(filteredHigh > baseRough);

    // 3. Test Stochastic Anti-Tiling
    std::cout << "-> 3. Testing Stochastic Anti-Tiling..." << std::endl;
    texture::ImageBuffer testTex(64, 64, 3);
    for (int y = 0; y < 64; ++y) {
        for (int x = 0; x < 64; ++x) {
            testTex.setPixelRGB(x, y, {(x % 16 < 8) ? 0.9f : 0.2f, 0.5f, 0.3f});
        }
    }
    Vec3 sampleA = StochasticAntiTiling::sampleStochastic(testTex, {0.15f, 0.25f});
    Vec3 sampleB = StochasticAntiTiling::sampleStochastic(testTex, {10.15f, 10.25f}); // Distant tiled coordinate
    std::cout << "   Sample A: (" << sampleA.x << ", " << sampleA.y << ", " << sampleA.z << ")" << std::endl;
    std::cout << "   Sample B (Tiled): (" << sampleB.x << ", " << sampleB.y << ", " << sampleB.z << ")" << std::endl;
    assert(sampleA.x > 0.0f && sampleA.x <= 1.0f);
    assert(sampleB.x > 0.0f && sampleB.x <= 1.0f);

    // 4. Test Environmental Weathering (Cavity Grime, Edge Wear, Gravity Rain Drips)
    std::cout << "-> 4. Testing Environmental Weathering Simulator..." << std::endl;
    PbrTextureSet testSet;
    testSet.albedo = texture::ImageBuffer(64, 64, 3, 200);
    testSet.height = texture::ImageBuffer(64, 64, 3, 128);
    testSet.roughness = texture::ImageBuffer(64, 64, 3, 100);
    testSet.ao = texture::ImageBuffer(64, 64, 3, 180);

    WeatheringParameters wParams;
    wParams.dirtAmount = 0.5f;
    wParams.rainStreakIntensity = 0.6f;
    WeatheringResult wResult = applyEnvironmentalWeathering(testSet, wParams);
    std::cout << "   Weathered Albedo generated: " << wResult.weatheredAlbedo.width << "x" << wResult.weatheredAlbedo.height << std::endl;
    assert(!wResult.weatheredAlbedo.empty());
    assert(!wResult.grimeMask.empty());

    // 5. Test Parallax Occlusion Evaluator
    std::cout << "-> 5. Testing Parallax Occlusion (POM)..." << std::endl;
    Vec2 baseUV(0.5f, 0.5f);
    Vec3 viewDirTangent(0.4f, 0.3f, 0.86f);
    viewDirTangent = viewDirTangent.normalized();
    Vec2 pomUV = ParallaxOcclusionEvaluator::computeParallaxOffset(testSet.height, baseUV, viewDirTangent, 0.04f);
    std::cout << "   Base UV: (" << baseUV.x << ", " << baseUV.y << ") -> POM Offset UV: (" << pomUV.x << ", " << pomUV.y << ")" << std::endl;
    assert(pomUV.x >= 0.0f && pomUV.y >= 0.0f);

    std::cout << "ALL MASTER-CLASS TEXTURE APPLICATION C++20 TESTS PASSED!" << std::endl;
    return 0;
}
