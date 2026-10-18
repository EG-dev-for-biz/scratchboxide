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
#include <vector>
#include <string>
#include <cmath>
#include <algorithm>
#include <cstdint>
#include <thread>
#include <future>
#include <functional>
#include <stdexcept>

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

/** A named example point in the continuous material space: data that synthesis never branches on. */
struct ManifoldExample {
    uint32_t id;
    const char* name;
    ContinuousMaterialDescriptor descriptor;
};

/**
 * The named example descriptors. Eight are written out in full; the other ids of the 50-entry
 * pbr_texture catalogue take that entry's albedo, metallic, roughness and normal strength (secondary colour
 * 0.75 x albedo, micro-porosity 0.45 x roughness, the rest the descriptor defaults). Synthesis reads only the
 * descriptor; the ids and names are a lookup convenience.
 */
inline const std::vector<ManifoldExample>& manifoldExamples() {
    static const std::vector<ManifoldExample> table = [] {
        using D = ContinuousMaterialDescriptor;
        std::vector<ManifoldExample> t = {
            {0, "Indiana Limestone", D{.albedoLinear = Vec3(0.78f, 0.74f, 0.67f), .secondaryAlbedo = Vec3(0.68f, 0.64f, 0.58f), .secondaryWeight = 0.20f,
                .conduction = 0.0f, .roughnessBaseline = 0.86f, .microPorosity = 0.42f, .normalStrength = 1.6f, .fissureScale = 12.0f, .fissureDepth = 0.18f,
                .cellularWeight = 0.15f, .graininess = 0.35f}},
            {2, "Roman Travertine", D{.albedoLinear = Vec3(0.85f, 0.81f, 0.72f), .secondaryAlbedo = Vec3(0.55f, 0.48f, 0.38f), .secondaryWeight = 0.35f,
                .conduction = 0.0f, .roughnessBaseline = 0.48f, .microPorosity = 0.55f, .normalStrength = 2.4f, .fissureScale = 6.0f, .fissureDepth = 0.45f,
                .cellularWeight = 0.40f, .anisotropyStrength = 0.65f, .anisotropyAngleRad = 0.0f}},
            {4, "Carrara Statuario Marble", D{.albedoLinear = Vec3(0.92f, 0.92f, 0.93f), .secondaryAlbedo = Vec3(0.38f, 0.40f, 0.44f), .secondaryWeight = 0.18f,
                .conduction = 0.0f, .roughnessBaseline = 0.12f, .microPorosity = 0.08f, .normalStrength = 0.65f, .fissureScale = 4.0f, .fissureDepth = 0.12f,
                .cellularWeight = 0.20f, .graininess = 0.05f}},
            {10, "Weathered Concrete", D{.albedoLinear = Vec3(0.52f, 0.51f, 0.50f), .secondaryAlbedo = Vec3(0.38f, 0.36f, 0.34f), .secondaryWeight = 0.30f,
                .conduction = 0.0f, .roughnessBaseline = 0.88f, .microPorosity = 0.60f, .normalStrength = 2.2f, .fissureScale = 14.0f, .fissureDepth = 0.35f,
                .cellularWeight = 0.50f, .graininess = 0.45f}},
            {18, "Statuary Bronze", D{.albedoLinear = Vec3(0.70f, 0.52f, 0.33f), .secondaryAlbedo = Vec3(0.35f, 0.25f, 0.15f), .secondaryWeight = 0.20f,
                .conduction = 0.95f, .roughnessBaseline = 0.32f, .microPorosity = 0.22f, .normalStrength = 1.4f, .fissureScale = 8.0f, .fissureDepth = 0.20f,
                .cellularWeight = 0.10f, .graininess = 0.15f}},
            {20, "Brushed Titanium", D{.albedoLinear = Vec3(0.72f, 0.74f, 0.76f), .secondaryAlbedo = Vec3(0.55f, 0.58f, 0.62f), .secondaryWeight = 0.15f,
                .conduction = 0.98f, .roughnessBaseline = 0.30f, .microPorosity = 0.15f, .normalStrength = 1.2f, .fissureScale = 32.0f, .fissureDepth = 0.10f,
                .cellularWeight = 0.05f, .graininess = 0.08f, .anisotropyStrength = 0.90f, .anisotropyAngleRad = 0.0f}},
            {23, "Cor-Ten Weathering Steel", D{.albedoLinear = Vec3(0.58f, 0.28f, 0.15f), .secondaryAlbedo = Vec3(0.35f, 0.16f, 0.08f), .secondaryWeight = 0.40f,
                .conduction = 0.70f, .roughnessBaseline = 0.85f, .microPorosity = 0.65f, .normalStrength = 2.5f, .fissureScale = 16.0f, .fissureDepth = 0.38f,
                .cellularWeight = 0.45f, .graininess = 0.50f}},
            {30, "Low-E Glazing", D{.albedoLinear = Vec3(0.88f, 0.92f, 0.95f), .secondaryAlbedo = Vec3(0.70f, 0.82f, 0.88f), .secondaryWeight = 0.05f,
                .conduction = 0.10f, .roughnessBaseline = 0.04f, .microPorosity = 0.02f, .normalStrength = 0.3f, .fissureScale = 2.0f, .fissureDepth = 0.02f,
                .cellularWeight = 0.02f, .graininess = 0.01f}}
        };
        const auto& cat = pbr_texture::get50PbrMaterialCatalog();
        for (uint32_t id = 0; id < cat.size(); ++id) {
            bool written = false;
            for (const auto& e : t) written = written || e.id == id;
            if (written) continue;
            const auto& entry = cat[id];
            D d;
            d.albedoLinear = entry.baseAlbedo;
            d.conduction = entry.baseMetallic;
            d.roughnessBaseline = entry.baseRoughness;
            d.normalStrength = entry.defaultNormalStrength;
            d.secondaryAlbedo = entry.baseAlbedo * 0.75f;
            d.microPorosity = entry.baseRoughness * 0.45f;
            t.push_back({id, entry.displayName.c_str(), d});
        }
        return t;
    }();
    return table;
}

/**
 * The example descriptor with this id. An id that is not in the table throws std::out_of_range: no other
 * example is substituted (ids do not wrap).
 */
inline ContinuousMaterialDescriptor getAnchorManifoldPoint(uint32_t anchorId) {
    for (const auto& e : manifoldExamples()) {
        if (e.id == anchorId) return e.descriptor;
    }
    throw std::out_of_range("getAnchorManifoldPoint: no example descriptor with id " + std::to_string(anchorId));
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

                    // Multi-scale procedural fields using high-performance 2D noise kernels
                    float fbm = FastNoise3D::fbm2D(
                        uRot * desc.fissureScale,
                        vRot * desc.fissureScale,
                        seed,
                        static_cast<int>(std::clamp(desc.fbmOctaves, 1.0f, 6.0f)),
                        2.0f,
                        desc.fbmGain
                    );

                    float worley = FastNoise3D::worley2D(
                        u * desc.fissureScale * 1.5f,
                        v * desc.fissureScale * 1.5f,
                        seed + 101
                    );

                    float grain = FastNoise3D::perlin2D(
                        u * 64.0f,
                        v * 64.0f,
                        seed + 202
                    );

                    // Continuous heightfield synthesis
                    float baseH = (1.0f - desc.cellularWeight) * fbm + desc.cellularWeight * (1.0f - worley);
                    float creviceRaw = std::clamp(std::abs(fbm - 0.5f) * 2.0f, 0.0f, 1.0f);
                    float fissureCrevice = (creviceRaw * creviceRaw) * (1.0f + 0.2f * (1.0f - creviceRaw));
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

    {
        int numThreads = (height >= 512) ? std::max(1, static_cast<int>(std::thread::hardware_concurrency())) : 1;
        if (numThreads <= 1) {
            for (int y = 0; y < height; ++y) {
                for (int x = 0; x < width; ++x) {
                    float baseR = bioRoughness.getPixelRGB(x, y).x;
                    float modR = set.roughness.getPixelRGB(x, y).x;
                    float finalR = std::clamp(baseR * 0.65f + modR * 0.35f, 0.02f, 0.98f);
                    set.roughness.setPixelRGB(x, y, {finalR, finalR, finalR});
                }
            }
        } else {
            int rowsPerThread = (height + numThreads - 1) / numThreads;
            std::vector<std::future<void>> blendFutures;

            for (int t = 0; t < numThreads; ++t) {
                int y0 = t * rowsPerThread;
                int y1 = std::min(height, y0 + rowsPerThread);
                if (y0 >= height) break;

                blendFutures.push_back(std::async(std::launch::async, [&set, &bioRoughness, width, y0, y1]() {
                    for (int y = y0; y < y1; ++y) {
                        for (int x = 0; x < width; ++x) {
                            float baseR = bioRoughness.getPixelRGB(x, y).x;
                            float modR = set.roughness.getPixelRGB(x, y).x;
                            float finalR = std::clamp(baseR * 0.65f + modR * 0.35f, 0.02f, 0.98f);
                            set.roughness.setPixelRGB(x, y, {finalR, finalR, finalR});
                        }
                    }
                }));
            }

            for (auto& f : blendFutures) {
                f.get();
            }
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
