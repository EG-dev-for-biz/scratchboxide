/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

#ifndef SCRATCHBOX_PBR_MANIFOLD_HPP
#define SCRATCHBOX_PBR_MANIFOLD_HPP

#include "scratchbox_math.hpp"
#include "scratchbox_texture.hpp"
#include "scratchbox_pbr_texture_expert.hpp"
#include "scratchbox_pbr_50_library.hpp"
#include <vector>
#include <string>
#include <cmath>
#include <algorithm>
#include <cstdint>
#include <thread>
#include <future>
#include <functional>

namespace scratchbox {
namespace pbr_manifold {

using math::Vec2;
using math::Vec3;
using math::Vec4;
using math::FastNoise3D;
using texture::ImageBuffer;
using texture::PbrTextureSet;
using texture::packOrmTexture;

/**
 * Continuous Biophysical Material Descriptor.
 *
 * In accordance with the Adaptive Domain Architecture (ADA) & Open-Domain Directive:
 * Material properties are continuous dimensional vectors \mathbf{m} \in \mathbb{R}^k,
 * NEVER restricted to closed enum taxonomies or switch-case classifiers.
 *
 * Any earthly stone, metal, timber, glass, or novel alien metamaterial
 * (e.g. bioluminescent xenolithic basalt with vitrified methane bubbles)
 * can be represented directly as continuous physical quantities.
 */
struct ContinuousMaterialDescriptor {
    // Radiometric & Colorimetric base
    Vec3 albedoLinear{0.55f, 0.57f, 0.60f}; // Linear albedo RGB [0..1]
    Vec3 secondaryAlbedo{0.30f, 0.32f, 0.35f}; // Secondary vein / grain / inclusion color
    float secondaryWeight{0.25f};           // Blend weight of secondary component [0..1]

    // Conduction & Specular
    float conduction{0.0f};                 // 0.0 = dielectric, 1.0 = metallic conductor
    float roughnessBaseline{0.50f};         // Baseline surface roughness [0.02..0.98]
    float microPorosity{0.20f};             // High-frequency surface tooth / micro-roughness [0..1]
    float normalStrength{1.50f};            // Tangent relief normal multiplier [0.1..5.0]

    // Surface morphology & noise synthesis
    float fissureScale{8.0f};               // Spatial frequency of fissures / veins / pores [1..64]
    float fissureDepth{0.25f};              // Relief displacement depth of fissures [0..1]
    float fbmOctaves{4.0f};                 // Octaves of fractional Brownian motion [1..8]
    float fbmGain{0.50f};                   // Fractal persistence gain [0.1..0.9]
    float cellularWeight{0.30f};            // Voronoi / crystal / aggregate grain weight [0..1]
    float graininess{0.15f};                // High-frequency mineral speckling [0..1]

    // Tangent anisotropy
    float anisotropyStrength{0.0f};         // Directional elongation [0..1] (0 = isotropic)
    float anisotropyAngleRad{0.0f};         // Angle of grain in radians [-\pi..\pi]

    // Cavity occlusion
    float aoStrength{1.0f};                 // Ambient occlusion intensity multiplier [0..2]
};

/**
 * Linearly interpolates two continuous material descriptors (\operatorname{lerp}).
 * Any two materials in the manifold can be smoothly blended without discrete jumps.
 */
inline ContinuousMaterialDescriptor lerp(
    const ContinuousMaterialDescriptor& a,
    const ContinuousMaterialDescriptor& b,
    float t
) {
    float clampedT = std::clamp(t, 0.0f, 1.0f);
    float invT = 1.0f - clampedT;

    ContinuousMaterialDescriptor res;
    res.albedoLinear = a.albedoLinear * invT + b.albedoLinear * clampedT;
    res.secondaryAlbedo = a.secondaryAlbedo * invT + b.secondaryAlbedo * clampedT;
    res.secondaryWeight = a.secondaryWeight * invT + b.secondaryWeight * clampedT;

    res.conduction = a.conduction * invT + b.conduction * clampedT;
    res.roughnessBaseline = a.roughnessBaseline * invT + b.roughnessBaseline * clampedT;
    res.microPorosity = a.microPorosity * invT + b.microPorosity * clampedT;
    res.normalStrength = a.normalStrength * invT + b.normalStrength * clampedT;

    res.fissureScale = a.fissureScale * invT + b.fissureScale * clampedT;
    res.fissureDepth = a.fissureDepth * invT + b.fissureDepth * clampedT;
    res.fbmOctaves = a.fbmOctaves * invT + b.fbmOctaves * clampedT;
    res.fbmGain = a.fbmGain * invT + b.fbmGain * clampedT;
    res.cellularWeight = a.cellularWeight * invT + b.cellularWeight * clampedT;
    res.graininess = a.graininess * invT + b.graininess * clampedT;

    res.anisotropyStrength = a.anisotropyStrength * invT + b.anisotropyStrength * clampedT;
    res.anisotropyAngleRad = a.anisotropyAngleRad * invT + b.anisotropyAngleRad * clampedT;
    res.aoStrength = a.aoStrength * invT + b.aoStrength * clampedT;

    return res;
}

/**
 * Computes an N-way weighted convex blend of multiple material descriptors.
 */
inline ContinuousMaterialDescriptor blend(
    const std::vector<std::pair<ContinuousMaterialDescriptor, float>>& weightedDescriptors
) {
    if (weightedDescriptors.empty()) {
        return ContinuousMaterialDescriptor{};
    }

    float totalWeight = 0.0f;
    for (const auto& wd : weightedDescriptors) {
        totalWeight += std::max(0.0f, wd.second);
    }
    if (totalWeight <= 1e-6f) {
        return weightedDescriptors.front().first;
    }

    ContinuousMaterialDescriptor res;
    res.albedoLinear = Vec3(0.0f, 0.0f, 0.0f);
    res.secondaryAlbedo = Vec3(0.0f, 0.0f, 0.0f);
    res.secondaryWeight = 0.0f;
    res.conduction = 0.0f;
    res.roughnessBaseline = 0.0f;
    res.microPorosity = 0.0f;
    res.normalStrength = 0.0f;
    res.fissureScale = 0.0f;
    res.fissureDepth = 0.0f;
    res.fbmOctaves = 0.0f;
    res.fbmGain = 0.0f;
    res.cellularWeight = 0.0f;
    res.graininess = 0.0f;
    res.anisotropyStrength = 0.0f;
    res.anisotropyAngleRad = 0.0f;
    res.aoStrength = 0.0f;

    for (const auto& wd : weightedDescriptors) {
        float w = std::max(0.0f, wd.second) / totalWeight;
        const auto& d = wd.first;

        res.albedoLinear = res.albedoLinear + d.albedoLinear * w;
        res.secondaryAlbedo = res.secondaryAlbedo + d.secondaryAlbedo * w;
        res.secondaryWeight += d.secondaryWeight * w;
        res.conduction += d.conduction * w;
        res.roughnessBaseline += d.roughnessBaseline * w;
        res.microPorosity += d.microPorosity * w;
        res.normalStrength += d.normalStrength * w;
        res.fissureScale += d.fissureScale * w;
        res.fissureDepth += d.fissureDepth * w;
        res.fbmOctaves += d.fbmOctaves * w;
        res.fbmGain += d.fbmGain * w;
        res.cellularWeight += d.cellularWeight * w;
        res.graininess += d.graininess * w;
        res.anisotropyStrength += d.anisotropyStrength * w;
        res.anisotropyAngleRad += d.anisotropyAngleRad * w;
        res.aoStrength += d.aoStrength * w;
    }

    return res;
}

/**
 * Returns pre-calibrated landmark anchor points in the continuous manifold.
 * These represent standardized reference points (e.g. Indiana Limestone, Carrara Marble,
 * Brushed Titanium), but remain continuous points that can be morphed or perturbed.
 */
inline ContinuousMaterialDescriptor getAnchorManifoldPoint(uint32_t anchorId) {
    ContinuousMaterialDescriptor d;
    switch (anchorId % 50) {
        case 0: // Indiana Limestone
            d.albedoLinear = Vec3(0.78f, 0.74f, 0.67f);
            d.secondaryAlbedo = Vec3(0.68f, 0.64f, 0.58f);
            d.secondaryWeight = 0.20f;
            d.conduction = 0.0f;
            d.roughnessBaseline = 0.86f;
            d.microPorosity = 0.42f;
            d.normalStrength = 1.6f;
            d.fissureScale = 12.0f;
            d.fissureDepth = 0.18f;
            d.cellularWeight = 0.15f;
            d.graininess = 0.35f;
            break;
        case 2: // Roman Travertine
            d.albedoLinear = Vec3(0.85f, 0.81f, 0.72f);
            d.secondaryAlbedo = Vec3(0.55f, 0.48f, 0.38f);
            d.secondaryWeight = 0.35f;
            d.conduction = 0.0f;
            d.roughnessBaseline = 0.48f;
            d.microPorosity = 0.55f;
            d.normalStrength = 2.4f;
            d.fissureScale = 6.0f;
            d.fissureDepth = 0.45f;
            d.anisotropyStrength = 0.65f; // Horizontal bedding elongation
            d.anisotropyAngleRad = 0.0f;
            d.cellularWeight = 0.40f;
            break;
        case 4: // Carrara Statuario Marble
            d.albedoLinear = Vec3(0.92f, 0.92f, 0.93f);
            d.secondaryAlbedo = Vec3(0.38f, 0.40f, 0.44f);
            d.secondaryWeight = 0.18f;
            d.conduction = 0.0f;
            d.roughnessBaseline = 0.12f;
            d.microPorosity = 0.08f;
            d.normalStrength = 0.65f;
            d.fissureScale = 4.0f;
            d.fissureDepth = 0.12f;
            d.cellularWeight = 0.20f;
            d.graininess = 0.05f;
            break;
        case 10: // Weathered Concrete
            d.albedoLinear = Vec3(0.52f, 0.51f, 0.50f);
            d.secondaryAlbedo = Vec3(0.38f, 0.36f, 0.34f);
            d.secondaryWeight = 0.30f;
            d.conduction = 0.0f;
            d.roughnessBaseline = 0.88f;
            d.microPorosity = 0.60f;
            d.normalStrength = 2.2f;
            d.fissureScale = 14.0f;
            d.fissureDepth = 0.35f;
            d.cellularWeight = 0.50f;
            d.graininess = 0.45f;
            break;
        case 18: // Statuary Bronze
            d.albedoLinear = Vec3(0.70f, 0.52f, 0.33f);
            d.secondaryAlbedo = Vec3(0.35f, 0.25f, 0.15f);
            d.secondaryWeight = 0.20f;
            d.conduction = 0.95f;
            d.roughnessBaseline = 0.32f;
            d.microPorosity = 0.22f;
            d.normalStrength = 1.4f;
            d.fissureScale = 8.0f;
            d.fissureDepth = 0.20f;
            d.cellularWeight = 0.10f;
            d.graininess = 0.15f;
            break;
        case 20: // Brushed Titanium
            d.albedoLinear = Vec3(0.72f, 0.74f, 0.76f);
            d.secondaryAlbedo = Vec3(0.55f, 0.58f, 0.62f);
            d.secondaryWeight = 0.15f;
            d.conduction = 0.98f;
            d.roughnessBaseline = 0.30f;
            d.microPorosity = 0.15f;
            d.normalStrength = 1.2f;
            d.fissureScale = 32.0f;
            d.fissureDepth = 0.10f;
            d.anisotropyStrength = 0.90f; // Fine directional brush lines
            d.anisotropyAngleRad = 0.0f;
            d.cellularWeight = 0.05f;
            d.graininess = 0.08f;
            break;
        case 23: // Cor-Ten Weathering Steel
            d.albedoLinear = Vec3(0.58f, 0.28f, 0.15f);
            d.secondaryAlbedo = Vec3(0.35f, 0.16f, 0.08f);
            d.secondaryWeight = 0.40f;
            d.conduction = 0.70f;
            d.roughnessBaseline = 0.85f;
            d.microPorosity = 0.65f;
            d.normalStrength = 2.5f;
            d.fissureScale = 16.0f;
            d.fissureDepth = 0.38f;
            d.cellularWeight = 0.45f;
            d.graininess = 0.50f;
            break;
        case 30: // Low-E Glazing
            d.albedoLinear = Vec3(0.88f, 0.92f, 0.95f);
            d.secondaryAlbedo = Vec3(0.70f, 0.82f, 0.88f);
            d.secondaryWeight = 0.05f;
            d.conduction = 0.10f;
            d.roughnessBaseline = 0.04f;
            d.microPorosity = 0.02f;
            d.normalStrength = 0.3f;
            d.fissureScale = 2.0f;
            d.fissureDepth = 0.02f;
            d.cellularWeight = 0.02f;
            d.graininess = 0.01f;
            break;
        default:
            // Continuous fallback anchor populated from pbr_texture::get50PbrMaterialCatalog
            auto cat = pbr_texture::get50PbrMaterialCatalog();
            if (anchorId < cat.size()) {
                const auto& entry = cat[anchorId];
                d.albedoLinear = entry.baseAlbedo;
                d.conduction = entry.baseMetallic;
                d.roughnessBaseline = entry.baseRoughness;
                d.normalStrength = entry.defaultNormalStrength;
                d.secondaryAlbedo = entry.baseAlbedo * 0.75f;
                d.microPorosity = entry.baseRoughness * 0.45f;
            }
            break;
    }
    return d;
}

/**
 * Parallel procedural synthesis of complete PBR texture pack directly from
 * a ContinuousMaterialDescriptor. Executes on native C++20 worker threads.
 */
inline PbrTextureSet synthesizeManifoldPbrParallel(
    const ContinuousMaterialDescriptor& desc,
    int width,
    int height,
    uint32_t seed = 42
) {
    PbrTextureSet set;
    set.albedo = ImageBuffer(width, height, 3);
    set.height = ImageBuffer(width, height, 3);
    set.metallic = ImageBuffer(width, height, 3);
    set.roughness = ImageBuffer(width, height, 3);

    int numThreads = std::max(1, static_cast<int>(std::thread::hardware_concurrency()));
    int rowsPerThread = (height + numThreads - 1) / numThreads;
    std::vector<std::future<void>> futures;

    const float cosAngle = std::cos(desc.anisotropyAngleRad);
    const float sinAngle = std::sin(desc.anisotropyAngleRad);
    const float anisoStretch = 1.0f + desc.anisotropyStrength * 8.0f;

    for (int t = 0; t < numThreads; ++t) {
        int y0 = t * rowsPerThread;
        int y1 = std::min(height, y0 + rowsPerThread);
        if (y0 >= height) break;

        futures.push_back(std::async(std::launch::async, [&set, desc, width, height, y0, y1, seed, cosAngle, sinAngle, anisoStretch]() {
            for (int y = y0; y < y1; ++y) {
                float v = static_cast<float>(y) / static_cast<float>(height);
                for (int x = 0; x < width; ++x) {
                    float u = static_cast<float>(x) / static_cast<float>(width);

                    // Anisotropic UV coordinate transformation
                    float uRot = u * cosAngle - v * sinAngle;
                    float vRot = (u * sinAngle + v * cosAngle) * anisoStretch;

                    // Multi-scale procedural fields
                    float fbm = FastNoise3D::fbm(
                        uRot * desc.fissureScale,
                        vRot * desc.fissureScale,
                        static_cast<float>(seed),
                        static_cast<int>(std::clamp(desc.fbmOctaves, 1.0f, 8.0f)),
                        desc.fbmGain
                    );

                    float worley = FastNoise3D::worley(
                        u * desc.fissureScale * 1.5f,
                        v * desc.fissureScale * 1.5f,
                        static_cast<float>(seed + 101)
                    );

                    float grain = FastNoise3D::perlin(
                        u * 64.0f,
                        v * 64.0f,
                        static_cast<float>(seed + 202)
                    );

                    // Continuous heightfield synthesis
                    float baseH = (1.0f - desc.cellularWeight) * fbm + desc.cellularWeight * (1.0f - worley);
                    float fissureCrevice = std::pow(std::abs(fbm - 0.5f) * 2.0f, 1.8f);
                    float hVal = baseH - desc.fissureDepth * (1.0f - fissureCrevice) + desc.microPorosity * 0.12f * (grain - 0.5f);
                    hVal = std::clamp(hVal, 0.0f, 1.0f);

                    // Albedo synthesis
                    float blendFactor = std::clamp(
                        desc.secondaryWeight * (1.0f - fissureCrevice + desc.graininess * (grain - 0.5f)),
                        0.0f, 1.0f
                    );
                    Vec3 pixelAlbedo = desc.albedoLinear * (1.0f - blendFactor) + desc.secondaryAlbedo * blendFactor;
                    pixelAlbedo.x = std::clamp(pixelAlbedo.x, 0.0f, 1.0f);
                    pixelAlbedo.y = std::clamp(pixelAlbedo.y, 0.0f, 1.0f);
                    pixelAlbedo.z = std::clamp(pixelAlbedo.z, 0.0f, 1.0f);

                    // Metallic synthesis
                    float conductionAtten = (desc.conduction > 0.7f) ? 0.05f : 0.4f;
                    float pixelMetallic = desc.conduction * (1.0f - blendFactor * conductionAtten);
                    pixelMetallic = std::clamp(pixelMetallic, 0.0f, 1.0f);

                    // Roughness modulation
                    float pixelRoughness = desc.roughnessBaseline
                        + desc.microPorosity * 0.25f * (grain - 0.5f)
                        + desc.fissureDepth * 0.20f * (1.0f - fissureCrevice);
                    pixelRoughness = std::clamp(pixelRoughness, 0.02f, 0.98f);

                    set.albedo.setPixelRGB(x, y, pixelAlbedo);
                    set.height.setPixelRGB(x, y, {hVal, hVal, hVal});
                    set.metallic.setPixelRGB(x, y, {pixelMetallic, pixelMetallic, pixelMetallic});
                    set.roughness.setPixelRGB(x, y, {pixelRoughness, pixelRoughness, pixelRoughness});
                }
            }
        }));
    }

    for (auto& f : futures) {
        f.get();
    }

    // Compute Scharr tangent normal map
    set.normal = pbr_texture::computeMultiFrequencyNormalMap(set.height, desc.normalStrength);

    // Compute biophysical curvature refinement on roughness
    ImageBuffer bioRoughness = pbr_texture::computeBiophysicalRoughness(
        set.height, desc.roughnessBaseline, 1.0f, 0.02f, 0.98f
    );

    for (int y = 0; y < height; ++y) {
        for (int x = 0; x < width; ++x) {
            float baseR = bioRoughness.getPixelRGB(x, y).x;
            float modR = set.roughness.getPixelRGB(x, y).x;
            float finalR = std::clamp(baseR * 0.65f + modR * 0.35f, 0.02f, 0.98f);
            set.roughness.setPixelRGB(x, y, {finalR, finalR, finalR});
        }
    }

    // Cavity AO & packed ORM
    set.ao = texture::extractCavityAO(set.height, desc.aoStrength);
    set.orm = packOrmTexture(set.ao, set.roughness, set.metallic);
    set.isTileable = true;

    return set;
}

} // namespace pbr_manifold
} // namespace scratchbox

#endif // SCRATCHBOX_PBR_MANIFOLD_HPP
