/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

#ifndef SCRATCHBOX_PBR_TEXTURE_EXPERT_HPP
#define SCRATCHBOX_PBR_TEXTURE_EXPERT_HPP

#include "scratchbox_math.hpp"
#include "scratchbox_texture.hpp"
#include <vector>
#include <cmath>
#include <algorithm>
#include <cstdint>
#include <string>
#include <thread>
#include <future>

namespace scratchbox {
namespace pbr_texture {

using math::Vec2;
using math::Vec3;
using math::Vec4;
using math::FastNoise3D;
using texture::ImageBuffer;
using texture::PbrTextureSet;
using texture::packOrmTexture;
using texture::blendNormalsRNM;

// ============================================================================
// 1. Procedural Noise & Pattern Kernels
// ============================================================================

struct WorleySample {
    float f1{1.0f};
    float f2{1.0f};
    float f2_minus_f1{0.0f};
    int cellX{0};
    int cellY{0};
};

/**
 * 2D Worley / Cellular distance field computing F1, F2, and F2 - F1.
 * F1: Cell centers, hammered metal, stones, pebbles.
 * F2 - F1: Cell boundaries, dried mud cracks, stone mortar lines, ceramic glaze crackle.
 */
inline WorleySample worley2D(float x, float y, float jitter = 1.0f, uint32_t seed = 1337) {
    int xi = static_cast<int>(std::floor(x));
    int yi = static_cast<int>(std::floor(y));

    float d1 = 1e9f;
    float d2 = 1e9f;
    int closestCellX = xi;
    int closestCellY = yi;

    for (int dy = -1; dy <= 1; ++dy) {
        for (int dx = -1; dx <= 1; ++dx) {
            int cx = xi + dx;
            int cy = yi + dy;

            uint32_t h = (seed ^ (static_cast<uint32_t>(cx) * 73856093u ^ static_cast<uint32_t>(cy) * 19349663u));
            h = ((h >> 16) ^ h) * 0x45d9f3b;
            h = ((h >> 16) ^ h) * 0x45d9f3b;
            h = (h >> 16) ^ h;

            float fx = static_cast<float>(cx) + (static_cast<float>(h & 1023) / 1024.0f) * jitter;
            float fy = static_cast<float>(cy) + (static_cast<float>((h >> 10) & 1023) / 1024.0f) * jitter;

            float distSq = (x - fx) * (x - fx) + (y - fy) * (y - fy);

            if (distSq < d1) {
                d2 = d1;
                d1 = distSq;
                closestCellX = cx;
                closestCellY = cy;
            } else if (distSq < d2) {
                d2 = distSq;
            }
        }
    }

    WorleySample sample;
    sample.f1 = std::sqrt(d1);
    sample.f2 = std::sqrt(d2);
    sample.f2_minus_f1 = std::max(0.0f, sample.f2 - sample.f1);
    sample.cellX = closestCellX;
    sample.cellY = closestCellY;
    return sample;
}

/**
 * 2D Fractional Brownian Motion (FBM) with normalized amplitude.
 */
inline float fbm2D(float x, float y, int octaves = 5, float lacunarity = 2.0f, float gain = 0.5f, uint32_t seed = 1337) {
    return FastNoise3D::fbm(x, y, 0.0f, octaves, lacunarity, gain, seed);
}

/**
 * Domain Warping using turbulent vector flow for organic swirls (marble veining, wood burl).
 */
inline Vec2 curlWarp2D(float x, float y, float strength = 0.25f, float frequency = 2.0f, int octaves = 4, uint32_t seed = 777) {
    float dx = FastNoise3D::fbm(x * frequency, y * frequency, 1.23f, octaves, 2.0f, 0.5f, seed) * strength;
    float dy = FastNoise3D::fbm(x * frequency + 15.7f, y * frequency + 31.9f, 2.45f, octaves, 2.0f, 0.5f, seed + 99) * strength;
    return {x + dx, y + dy};
}

/**
 * Anisotropic Gabor noise kernel for brushed metals, turned aluminum, and textile weaves.
 */
inline float gaborAnisotropic2D(float x, float y, float angleRad, float freq = 16.0f, float bandwidth = 1.0f) {
    float cosA = std::cos(angleRad);
    float sinA = std::sin(angleRad);

    float u = x * cosA - y * sinA;
    float v = x * sinA + y * cosA;

    float carrier = std::cos(2.0f * 3.14159265f * freq * v);
    float envelope = std::exp(-3.14159265f * (bandwidth * bandwidth * u * u + v * v * 0.1f));
    return carrier * envelope;
}

// ============================================================================
// 2. Multi-Frequency Tangent Space Normal Derivation
// ============================================================================

/**
 * Computes high-accuracy tangent-space normal vector using 3x3 Scharr operator.
 */
inline Vec3 computeScharrNormal(const ImageBuffer& heightMap, int x, int y, float bumpStrength = 3.5f) {
    float tl = heightMap.getLuminance(x - 1, y - 1);
    float tc = heightMap.getLuminance(x,     y - 1);
    float tr = heightMap.getLuminance(x + 1, y - 1);
    float ml = heightMap.getLuminance(x - 1, y);
    float mr = heightMap.getLuminance(x + 1, y);
    float bl = heightMap.getLuminance(x - 1, y + 1);
    float bc = heightMap.getLuminance(x,     y + 1);
    float br = heightMap.getLuminance(x + 1, y + 1);

    float dx = (tr + (10.0f / 3.0f) * mr + br - (tl + (10.0f / 3.0f) * ml + bl)) / 5.333f;
    float dy = (bl + (10.0f / 3.0f) * bc + br - (tl + (10.0f / 3.0f) * tc + tr)) / 5.333f;

    Vec3 n = {-dx * bumpStrength, -dy * bumpStrength, 1.0f};
    return n.normalized();
}

/**
 * Multi-Frequency Normal Map Synthesis:
 * Decomposes heightfield into Macro (structure), Meso (features), and Micro (grit),
 * combining them using Reoriented Normal Mapping (RNM) to preserve specular highlights.
 */
inline ImageBuffer computeMultiFrequencyNormalMap(
    const ImageBuffer& heightMap,
    float bumpStrength = 3.0f,
    float macroWeight = 0.5f,
    float mesoWeight = 0.35f,
    float microWeight = 0.15f
) {
    int w = heightMap.width;
    int h = heightMap.height;
    ImageBuffer result(w, h, 3);

    for (int y = 0; y < h; ++y) {
        for (int x = 0; x < w; ++x) {
            // Macro: 3x3 kernel spaced by 3 pixels
            float tl_m = heightMap.getLuminance(x - 3, y - 3);
            float tr_m = heightMap.getLuminance(x + 3, y - 3);
            float bl_m = heightMap.getLuminance(x - 3, y + 3);
            float br_m = heightMap.getLuminance(x + 3, y + 3);
            float dx_macro = (tr_m + br_m - (tl_m + bl_m)) * 0.5f;
            float dy_macro = (bl_m + br_m - (tl_m + tr_m)) * 0.5f;
            Vec3 n_macro = Vec3(-dx_macro * bumpStrength * macroWeight, -dy_macro * bumpStrength * macroWeight, 1.0f).normalized();

            // Meso: Standard 1-pixel Scharr kernel
            Vec3 n_meso = computeScharrNormal(heightMap, x, y, bumpStrength * mesoWeight);

            // Micro: High-pass difference
            float center = heightMap.getLuminance(x, y);
            float avg4 = (heightMap.getLuminance(x - 1, y) + heightMap.getLuminance(x + 1, y) +
                          heightMap.getLuminance(x, y - 1) + heightMap.getLuminance(x, y + 1)) * 0.25f;
            float microDelta = (center - avg4);
            Vec3 n_micro = Vec3(-microDelta * bumpStrength * microWeight * 8.0f, -microDelta * bumpStrength * microWeight * 8.0f, 1.0f).normalized();

            // Blend via Reoriented Normal Mapping (RNM)
            Vec3 n_blend = blendNormalsRNM(n_macro, n_meso);
            Vec3 n_final = blendNormalsRNM(n_blend, n_micro);

            Vec3 rgb = {n_final.x * 0.5f + 0.5f, n_final.y * 0.5f + 0.5f, n_final.z * 0.5f + 0.5f};
            result.setPixelRGB(x, y, rgb);
        }
    }

    return result;
}

// ============================================================================
// 3. Biophysical Roughness & Curvature Extraction
// ============================================================================

/**
 * Computes biophysically motivated Cook-Torrance GGX roughness:
 * - Local variance in micro-relief creates natural roughness spread.
 * - Convex edges (positive curvature κ > 0) experience friction and polish (burnishing, lower roughness).
 * - Concave crevices (negative curvature κ < 0) collect dust/dirt (higher roughness).
 */
inline ImageBuffer computeBiophysicalRoughness(
    const ImageBuffer& heightMap,
    float baseRoughness = 0.5f,
    float varianceScale = 2.0f,
    float edgeWearGain = 0.35f,
    float cavityDirtGain = 0.40f
) {
    int w = heightMap.width;
    int h = heightMap.height;
    ImageBuffer roughnessMap(w, h, 3);

    for (int y = 0; y < h; ++y) {
        for (int x = 0; x < w; ++x) {
            float center = heightMap.getLuminance(x, y);
            float n_l = heightMap.getLuminance(x - 1, y);
            float n_r = heightMap.getLuminance(x + 1, y);
            float n_t = heightMap.getLuminance(x, y - 1);
            float n_b = heightMap.getLuminance(x, y + 1);

            float avgNeighbors = (n_l + n_r + n_t + n_b) * 0.25f;
            float variance = std::abs(center - avgNeighbors);

            // Laplacian curvature: κ = 4*center - (sum of 4 neighbors)
            // κ > 0 => Peak / ridge / convex edge
            // κ < 0 => Valleys / cracks / concave cavity
            float laplacian = 4.0f * center - (n_l + n_r + n_t + n_b);

            float burnish = std::max(0.0f, laplacian) * edgeWearGain;
            float dirt = std::max(0.0f, -laplacian) * cavityDirtGain;

            float r = baseRoughness + variance * varianceScale - burnish + dirt;
            float clampedR = std::clamp(r, 0.04f, 0.98f);
            roughnessMap.setPixelRGB(x, y, {clampedR, clampedR, clampedR});
        }
    }

    return roughnessMap;
}

/**
 * Height-blended multi-layer material compositor.
 * Used for chipped paint on rusted iron, mud in cobblestones, moss in rock crevices.
 */
inline PbrTextureSet blendLayersHeightMasked(
    const PbrTextureSet& baseLayer,
    const PbrTextureSet& topLayer,
    const ImageBuffer& blendMask,
    float transitionSharpness = 0.1f
) {
    int w = baseLayer.albedo.width;
    int h = baseLayer.albedo.height;
    PbrTextureSet result;
    result.albedo = ImageBuffer(w, h, 3);
    result.normal = ImageBuffer(w, h, 3);
    result.roughness = ImageBuffer(w, h, 3);
    result.metallic = ImageBuffer(w, h, 3);
    result.ao = ImageBuffer(w, h, 3);
    result.height = ImageBuffer(w, h, 3);

    for (int y = 0; y < h; ++y) {
        for (int x = 0; x < w; ++x) {
            float mask = blendMask.getLuminance(x, y);
            float h_base = !baseLayer.height.empty() ? baseLayer.height.getLuminance(x, y) : 0.0f;
            float h_top = !topLayer.height.empty() ? topLayer.height.getLuminance(x, y) : 0.5f;

            // Height-modulated blend weight
            float heightDiff = (mask + h_top) - (1.0f - mask + h_base);
            float weight = math::smoothstep(-transitionSharpness, transitionSharpness, heightDiff);

            // Lerp Albedo
            Vec3 a1 = baseLayer.albedo.getPixelRGB(x, y);
            Vec3 a2 = topLayer.albedo.getPixelRGB(x, y);
            result.albedo.setPixelRGB(x, y, a1 * (1.0f - weight) + a2 * weight);

            // Blend Normals
            Vec3 n1 = baseLayer.normal.getPixelRGB(x, y) * 2.0f - Vec3(1.0f, 1.0f, 1.0f);
            Vec3 n2 = topLayer.normal.getPixelRGB(x, y) * 2.0f - Vec3(1.0f, 1.0f, 1.0f);
            Vec3 blendedN = (n1 * (1.0f - weight) + n2 * weight).normalized();
            result.normal.setPixelRGB(x, y, blendedN * 0.5f + Vec3(0.5f, 0.5f, 0.5f));

            // Lerp Roughness
            float r1 = baseLayer.roughness.getLuminance(x, y);
            float r2 = topLayer.roughness.getLuminance(x, y);
            float r = r1 * (1.0f - weight) + r2 * weight;
            result.roughness.setPixelRGB(x, y, {r, r, r});

            // Lerp Metallic
            float m1 = baseLayer.metallic.getLuminance(x, y);
            float m2 = topLayer.metallic.getLuminance(x, y);
            float m = m1 * (1.0f - weight) + m2 * weight;
            result.metallic.setPixelRGB(x, y, {m, m, m});

            // Lerp AO
            float ao1 = baseLayer.ao.getLuminance(x, y);
            float ao2 = topLayer.ao.getLuminance(x, y);
            float ao = ao1 * (1.0f - weight) + ao2 * weight;
            result.ao.setPixelRGB(x, y, {ao, ao, ao});

            // Lerp Height
            float ht = h_base * (1.0f - weight) + h_top * weight;
            result.height.setPixelRGB(x, y, {ht, ht, ht});
        }
    }

    result.orm = packOrmTexture(result.ao, result.roughness, result.metallic);
    result.isTileable = true;
    return result;
}

// ============================================================================
// 4. Procedural Real-World PBR Material Archetypes
// ============================================================================

/**
 * Synthesizes Weathered Structural Concrete with hairline shrinkage cracks,
 * aggregate sand specks, and moisture/cavity staining.
 */
inline PbrTextureSet generateWeatheredConcrete(int width = 256, int height = 256, float wear = 0.45f, uint32_t seed = 101) {
    PbrTextureSet set;
    set.albedo = ImageBuffer(width, height, 3);
    set.height = ImageBuffer(width, height, 3);
    set.metallic = ImageBuffer(width, height, 3);

    for (int y = 0; y < height; ++y) {
        for (int x = 0; x < width; ++x) {
            float u = static_cast<float>(x) / static_cast<float>(width);
            float v = static_cast<float>(y) / static_cast<float>(height);

            // Macro concrete unevenness
            float macro = fbm2D(u * 4.0f, v * 4.0f, 4, 2.0f, 0.5f, seed);

            // Aggregate pebble stones via Worley F1
            WorleySample w_pebbles = worley2D(u * 32.0f, v * 32.0f, 0.85f, seed + 1);
            float pebbleMask = math::smoothstep(0.15f, 0.45f, w_pebbles.f1);

            // Hairline shrinkage cracks via Worley F2 - F1
            WorleySample w_cracks = worley2D(u * 12.0f, v * 12.0f, 0.95f, seed + 2);
            float crackMask = 1.0f - math::smoothstep(0.0f, 0.08f * wear, w_cracks.f2_minus_f1);

            // High frequency sand grit
            float grit = FastNoise3D::perlin(u * 128.0f, v * 128.0f, 0.5f, seed + 3) * 0.15f;

            float h = std::clamp(0.5f + macro * 0.15f + pebbleMask * 0.12f - crackMask * 0.35f + grit, 0.0f, 1.0f);
            set.height.setPixelRGB(x, y, {h, h, h});

            // Calibrated concrete albedo (warm cement gray: #9c9994)
            Vec3 baseColor(0.61f, 0.60f, 0.58f);
            Vec3 darkCrevice(0.35f, 0.34f, 0.32f);
            Vec3 pebbleTint(0.72f, 0.70f, 0.66f);

            Vec3 col = baseColor * (0.85f + macro * 0.3f);
            col = col * (1.0f - pebbleMask * 0.2f) + pebbleTint * (pebbleMask * 0.2f);
            col = col * (1.0f - crackMask) + darkCrevice * crackMask;

            set.albedo.setPixelRGB(x, y, col);
            set.metallic.setPixelRGB(x, y, {0.0f, 0.0f, 0.0f}); // Concrete is dielectric
        }
    }

    set.normal = computeMultiFrequencyNormalMap(set.height, 3.2f, 0.5f, 0.35f, 0.15f);
    set.roughness = computeBiophysicalRoughness(set.height, 0.78f, 1.8f, 0.15f, 0.20f);
    set.ao = texture::extractCavityAO(set.height, 1.4f);
    set.orm = packOrmTexture(set.ao, set.roughness, set.metallic);
    set.isTileable = true;
    return set;
}

/**
 * Synthesizes Aerospace-Grade Brushed Titanium / Aluminum with anisotropic micro-scratches.
 */
inline PbrTextureSet generateBrushedTitanium(int width = 256, int height = 256, float scratchDensity = 0.7f, float angleRad = 0.0f, uint32_t seed = 202) {
    PbrTextureSet set;
    set.albedo = ImageBuffer(width, height, 3);
    set.height = ImageBuffer(width, height, 3);
    set.metallic = ImageBuffer(width, height, 3);

    Vec3 titaniumColor(0.76f, 0.77f, 0.82f); // Physical measured reflectance

    for (int y = 0; y < height; ++y) {
        for (int x = 0; x < width; ++x) {
            float u = static_cast<float>(x) / static_cast<float>(width);
            float v = static_cast<float>(y) / static_cast<float>(height);

            // Linear directional brushed scratch grooves via anisotropic Gabor & stretched noise
            float scratch1 = gaborAnisotropic2D(u * 64.0f, v * 64.0f, angleRad, 32.0f * scratchDensity, 2.0f);
            float scratch2 = FastNoise3D::perlin(u * 256.0f, v * 8.0f, 0.0f, seed) * 0.12f;
            float h = std::clamp(0.5f + scratch1 * 0.25f + scratch2, 0.0f, 1.0f);
            set.height.setPixelRGB(x, y, {h, h, h});

            // Albedo micro-variegation
            Vec3 col = titaniumColor * (0.95f + scratch1 * 0.08f);
            set.albedo.setPixelRGB(x, y, col);
            set.metallic.setPixelRGB(x, y, {0.96f, 0.96f, 0.96f}); // Pure conductor
        }
    }

    set.normal = computeMultiFrequencyNormalMap(set.height, 2.5f, 0.2f, 0.5f, 0.3f);
    set.roughness = computeBiophysicalRoughness(set.height, 0.22f, 1.2f, 0.05f, 0.10f);
    set.ao = texture::extractCavityAO(set.height, 0.8f);
    set.orm = packOrmTexture(set.ao, set.roughness, set.metallic);
    set.isTileable = true;
    return set;
}

/**
 * Synthesizes Polished Carrara Veined Marble with domain-warped Curl noise veins.
 */
inline PbrTextureSet generateVeinedMarble(int width = 256, int height = 256, float turbulence = 0.55f, uint32_t seed = 303) {
    PbrTextureSet set;
    set.albedo = ImageBuffer(width, height, 3);
    set.height = ImageBuffer(width, height, 3);
    set.metallic = ImageBuffer(width, height, 3);

    Vec3 marbleWhite(0.94f, 0.93f, 0.91f);
    Vec3 veinDark(0.24f, 0.26f, 0.28f);
    Vec3 veinGold(0.58f, 0.49f, 0.34f);

    for (int y = 0; y < height; ++y) {
        for (int x = 0; x < width; ++x) {
            float u = static_cast<float>(x) / static_cast<float>(width);
            float v = static_cast<float>(y) / static_cast<float>(height);

            // Domain warp coordinates with Curl noise
            Vec2 warped = curlWarp2D(u * 4.0f, v * 4.0f, turbulence * 0.8f, 2.5f, 5, seed);

            // Multi-scale marble veining
            float veinNoise1 = std::abs(FastNoise3D::fbm(warped.x, warped.y, 0.0f, 5, 2.0f, 0.5f, seed));
            float veinNoise2 = std::abs(FastNoise3D::fbm(warped.x * 2.0f + 5.0f, warped.y * 2.0f, 0.5f, 4, 2.0f, 0.5f, seed + 11));

            float veinMask = math::smoothstep(0.12f, 0.01f, veinNoise1) * 0.75f +
                             math::smoothstep(0.08f, 0.01f, veinNoise2) * 0.25f;

            float h = std::clamp(0.5f - veinMask * 0.08f + FastNoise3D::perlin(u * 64.0f, v * 64.0f, 0.0f, seed) * 0.02f, 0.0f, 1.0f);
            set.height.setPixelRGB(x, y, {h, h, h});

            // Vein color interpolation
            Vec3 col = marbleWhite * (1.0f - veinMask) + (veinDark * 0.7f + veinGold * 0.3f) * veinMask;
            set.albedo.setPixelRGB(x, y, col);
            set.metallic.setPixelRGB(x, y, {0.02f, 0.02f, 0.02f}); // Dielectric with trace mineral inclusions
        }
    }

    set.normal = computeMultiFrequencyNormalMap(set.height, 1.5f, 0.6f, 0.3f, 0.1f);
    set.roughness = computeBiophysicalRoughness(set.height, 0.12f, 0.8f, 0.02f, 0.15f); // Polished specular finish
    set.ao = texture::extractCavityAO(set.height, 0.9f);
    set.orm = packOrmTexture(set.ao, set.roughness, set.metallic);
    set.isTileable = true;
    return set;
}

/**
 * Synthesizes Concentric Wood End-Grain with annual growth rings and porous medullary rays.
 */
inline PbrTextureSet generateWoodEndgrain(int width = 256, int height = 256, float ringFrequency = 14.0f, uint32_t seed = 404) {
    PbrTextureSet set;
    set.albedo = ImageBuffer(width, height, 3);
    set.height = ImageBuffer(width, height, 3);
    set.metallic = ImageBuffer(width, height, 3);

    Vec3 earlyWood(0.78f, 0.58f, 0.38f); // Light soft growth ring
    Vec3 lateWood(0.42f, 0.26f, 0.14f);  // Dark dense growth ring

    float cx = static_cast<float>(width) * 0.5f;
    float cy = static_cast<float>(height) * 0.5f;

    for (int y = 0; y < height; ++y) {
        for (int x = 0; x < width; ++x) {
            float dx = (static_cast<float>(x) - cx) / static_cast<float>(width);
            float dy = (static_cast<float>(y) - cy) / static_cast<float>(height);
            float r = std::sqrt(dx * dx + dy * dy);
            float theta = std::atan2(dy, dx);

            // Eccentric ring distortion
            float ringWarp = FastNoise3D::fbm(dx * 4.0f, dy * 4.0f, 0.0f, 4, 2.0f, 0.5f, seed) * 0.04f;
            float ringPhase = (r + ringWarp) * ringFrequency;
            float ringVal = std::sin(ringPhase * 2.0f * 3.14159265f);
            float ringIntensity = (ringVal * 0.5f + 0.5f);

            // Medullary radial rays
            float rayNoise = std::abs(std::sin(theta * 64.0f + FastNoise3D::perlin(dx * 8.0f, dy * 8.0f, 0.0f, seed) * 3.0f));
            float rayMask = math::smoothstep(0.92f, 0.99f, rayNoise) * 0.15f;

            float h = std::clamp(ringIntensity * 0.4f + rayMask + 0.3f, 0.0f, 1.0f);
            set.height.setPixelRGB(x, y, {h, h, h});

            Vec3 col = earlyWood * (1.0f - ringIntensity) + lateWood * ringIntensity;
            col = col * (1.0f - rayMask);
            set.albedo.setPixelRGB(x, y, col);
            set.metallic.setPixelRGB(x, y, {0.0f, 0.0f, 0.0f});
        }
    }

    set.normal = computeMultiFrequencyNormalMap(set.height, 2.8f, 0.4f, 0.4f, 0.2f);
    set.roughness = computeBiophysicalRoughness(set.height, 0.55f, 1.5f, 0.1f, 0.25f);
    set.ao = texture::extractCavityAO(set.height, 1.2f);
    set.orm = packOrmTexture(set.ao, set.roughness, set.metallic);
    set.isTileable = true;
    return set;
}

/**
 * Synthesizes Hammered Copper / Bronze with ball-peen dimples and cavity patina.
 */
inline PbrTextureSet generateHammeredCopper(int width = 256, int height = 256, float dimpleScale = 10.0f, uint32_t seed = 505) {
    PbrTextureSet set;
    set.albedo = ImageBuffer(width, height, 3);
    set.height = ImageBuffer(width, height, 3);
    set.metallic = ImageBuffer(width, height, 3);

    Vec3 copperBase(0.95f, 0.64f, 0.54f);
    Vec3 patinaVerdigris(0.32f, 0.68f, 0.55f);

    for (int y = 0; y < height; ++y) {
        for (int x = 0; x < width; ++x) {
            float u = static_cast<float>(x) / static_cast<float>(width);
            float v = static_cast<float>(y) / static_cast<float>(height);

            WorleySample w = worley2D(u * dimpleScale, v * dimpleScale, 0.9f, seed);
            // Inverted spherical dimple
            float dimple = 1.0f - std::clamp(w.f1 * 1.4f, 0.0f, 1.0f);
            float sphereCap = std::sqrt(std::max(0.0f, 1.0f - dimple * dimple));

            float microGrit = FastNoise3D::perlin(u * 128.0f, v * 128.0f, 0.0f, seed) * 0.04f;
            float h = std::clamp(sphereCap + microGrit, 0.0f, 1.0f);
            set.height.setPixelRGB(x, y, {h, h, h});

            // Patina in recesses
            float cavity = std::clamp(1.0f - sphereCap * 1.5f, 0.0f, 1.0f);
            Vec3 col = copperBase * (1.0f - cavity * 0.6f) + patinaVerdigris * (cavity * 0.6f);
            set.albedo.setPixelRGB(x, y, col);

            float metal = std::clamp(0.95f - cavity * 0.85f, 0.0f, 1.0f); // Patina is non-metallic
            set.metallic.setPixelRGB(x, y, {metal, metal, metal});
        }
    }

    set.normal = computeMultiFrequencyNormalMap(set.height, 3.8f, 0.6f, 0.3f, 0.1f);
    set.roughness = computeBiophysicalRoughness(set.height, 0.28f, 1.4f, 0.12f, 0.35f);
    set.ao = texture::extractCavityAO(set.height, 1.5f);
    set.orm = packOrmTexture(set.ao, set.roughness, set.metallic);
    set.isTileable = true;
    return set;
}

/**
 * Synthesizes Multi-Layer Chipped Enamel Paint over Rusted Iron Substrate.
 */
inline PbrTextureSet generateChippedPaintOnRust(
    int width = 256,
    int height = 256,
    const Vec3& paintColor = Vec3(0.12f, 0.45f, 0.85f),
    float chipAmount = 0.4f,
    uint32_t seed = 606
) {
    // 1. Base Layer: Rough Rusted Iron
    PbrTextureSet rustLayer;
    rustLayer.albedo = ImageBuffer(width, height, 3);
    rustLayer.height = ImageBuffer(width, height, 3);
    rustLayer.metallic = ImageBuffer(width, height, 3);
    rustLayer.roughness = ImageBuffer(width, height, 3);
    rustLayer.ao = ImageBuffer(width, height, 3);

    Vec3 rustBrown(0.38f, 0.18f, 0.11f);
    Vec3 rustOrange(0.65f, 0.32f, 0.12f);

    for (int y = 0; y < height; ++y) {
        for (int x = 0; x < width; ++x) {
            float u = static_cast<float>(x) / static_cast<float>(width);
            float v = static_cast<float>(y) / static_cast<float>(height);

            float rustNoise = fbm2D(u * 16.0f, v * 16.0f, 5, 2.0f, 0.5f, seed);
            Vec3 rCol = rustBrown * (0.8f + rustNoise * 0.4f) + rustOrange * std::max(0.0f, rustNoise);
            rustLayer.albedo.setPixelRGB(x, y, rCol);

            float h = std::clamp(rustNoise * 0.5f + 0.5f, 0.0f, 1.0f);
            rustLayer.height.setPixelRGB(x, y, {h, h, h});
            rustLayer.roughness.setPixelRGB(x, y, {0.88f, 0.88f, 0.88f}); // Rust is rough
            rustLayer.metallic.setPixelRGB(x, y, {0.35f, 0.35f, 0.35f});  // Partially oxidized metal
            rustLayer.ao.setPixelRGB(x, y, {0.85f, 0.85f, 0.85f});
        }
    }
    rustLayer.normal = computeMultiFrequencyNormalMap(rustLayer.height, 3.0f);

    // 2. Top Layer: Smooth Glossy Enamel Paint
    PbrTextureSet paintLayer;
    paintLayer.albedo = ImageBuffer(width, height, 3);
    paintLayer.height = ImageBuffer(width, height, 3);
    paintLayer.metallic = ImageBuffer(width, height, 3);
    paintLayer.roughness = ImageBuffer(width, height, 3);
    paintLayer.ao = ImageBuffer(width, height, 3);

    for (int y = 0; y < height; ++y) {
        for (int x = 0; x < width; ++x) {
            paintLayer.albedo.setPixelRGB(x, y, paintColor);
            paintLayer.height.setPixelRGB(x, y, {0.75f, 0.75f, 0.75f});
            paintLayer.roughness.setPixelRGB(x, y, {0.18f, 0.18f, 0.18f}); // Glossy paint
            paintLayer.metallic.setPixelRGB(x, y, {0.0f, 0.0f, 0.0f});     // Dielectric paint
            paintLayer.ao.setPixelRGB(x, y, {1.0f, 1.0f, 1.0f});
        }
    }
    paintLayer.normal = computeMultiFrequencyNormalMap(paintLayer.height, 0.5f);

    // 3. Peeling / Chipping Mask via Worley cells + turbulent noise
    ImageBuffer mask(width, height, 1);
    for (int y = 0; y < height; ++y) {
        for (int x = 0; x < width; ++x) {
            float u = static_cast<float>(x) / static_cast<float>(width);
            float v = static_cast<float>(y) / static_cast<float>(height);

            WorleySample w = worley2D(u * 8.0f, v * 8.0f, 0.9f, seed + 88);
            float fbmMod = fbm2D(u * 16.0f, v * 16.0f, 4, 2.0f, 0.5f, seed + 99) * 0.25f;
            float chipThreshold = chipAmount + fbmMod;
            float paintPresent = math::smoothstep(chipThreshold - 0.04f, chipThreshold + 0.04f, w.f1);
            mask.setPixelRGB(x, y, {paintPresent, paintPresent, paintPresent});
        }
    }

    // Blend layers
    return blendLayersHeightMasked(rustLayer, paintLayer, mask, 0.05f);
}

// ============================================================================
// 6. Master-Class Texture Application & Physical Shader Systems
// ============================================================================

/**
 * Procedural Stochastic Anti-Tiling Sampler (Inigo Quilez Voronoi / Hex Lattice).
 * Completely eliminates repeating grid artifacts across large surfaces by perturbing
 * UV coordinates through randomized cell rotation, translation, and smooth barycentric blending.
 */
struct StochasticAntiTiling {
    static inline Vec2 hash22(const Vec2& p) {
        float n = std::sin(p.x * 127.1f + p.y * 311.7f) * 43758.5453123f;
        float m = std::sin(p.x * 269.5f + p.y * 183.3f) * 43758.5453123f;
        return {n - std::floor(n), m - std::floor(m)};
    }

    /**
     * Samples an ImageBuffer using stochastic procedural anti-tiling.
     * Evaluates 3 weighted sample points across a triangular lattice.
     */
    static Vec3 sampleStochastic(const ImageBuffer& tex, const Vec2& uv) {
        if (tex.empty()) return {1.0f, 1.0f, 1.0f};

        // Skew to triangular simplex grid
        const float K1 = 0.366025404f; // (sqrt(3)-1)/2
        const float K2 = 0.211324865f; // (3-sqrt(3))/6

        Vec2 i = {std::floor(uv.x + (uv.x + uv.y) * K1),
                  std::floor(uv.y + (uv.x + uv.y) * K1)};
        Vec2 a = {uv.x - (i.x - (i.x + i.y) * K2),
                  uv.y - (i.y - (i.x + i.y) * K2)};

        Vec2 o = (a.x > a.y) ? Vec2(1.0f, 0.0f) : Vec2(0.0f, 1.0f);
        Vec2 b = {a.x - o.x + K2, a.y - o.y + K2};
        Vec2 c = {a.x - 1.0f + 2.0f * K2, a.y - 1.0f + 2.0f * K2};

        // Weights based on distance to cell vertices
        Vec3 w = {
            std::max(0.0f, 0.5f - (a.x * a.x + a.y * a.y)),
            std::max(0.0f, 0.5f - (b.x * b.x + b.y * b.y)),
            std::max(0.0f, 0.5f - (c.x * c.x + c.y * c.y))
        };
        w = {w.x * w.x * w.x, w.y * w.y * w.y, w.z * w.z * w.z};
        float sumW = w.x + w.y + w.z;
        if (sumW > 1e-6f) w = w * (1.0f / sumW);
        else w = {0.333f, 0.333f, 0.334f};

        // Randomized per-cell rotation and offset
        auto sampleCell = [&](const Vec2& cellCoord, const Vec2& uvCoord) -> Vec3 {
            Vec2 h = hash22(cellCoord);
            float angle = h.x * math::TWO_PI;
            float cosA = std::cos(angle);
            float sinA = std::sin(angle);
            Vec2 rotUV = {
                (uvCoord.x * cosA - uvCoord.y * sinA) + h.x,
                (uvCoord.x * sinA + uvCoord.y * cosA) + h.y
            };
            return tex.sampleBilinear(rotUV.x, rotUV.y);
        };

        Vec3 colA = sampleCell(i, uv);
        Vec3 colB = sampleCell({i.x + o.x, i.y + o.y}, uv);
        Vec3 colC = sampleCell({i.x + 1.0f, i.y + 1.0f}, uv);

        return colA * w.x + colB * w.y + colC * w.z;
    }
};

/**
 * Reoriented Normal Mapping (RNM) Multi-Scale Hierarchy.
 * Enables combining geometric macro-bevels, architectural tile normals, and micro-pore grit
 * without flattening slopes or violating tangent-space unit lengths.
 */
struct ReorientedNormalHierarchy {
    /**
     * Core RNM operator combining base normal n1 with detail normal n2 in tangent space.
     * Formula: t = n1 + (0, 0, 1), u = (-n2.x, -n2.y, n2.z), N = t * dot(t, u) - u * t.z
     */
    static inline Vec3 rnm(const Vec3& n1, const Vec3& n2) {
        Vec3 t = {n1.x, n1.y, n1.z + 1.0f};
        Vec3 u = {-n2.x, -n2.y, n2.z};
        float dotTU = t.dot(u);
        Vec3 res = t * dotTU - u * t.z;
        float lenSq = res.dot(res);
        if (lenSq > 1e-8f) return res * (1.0f / std::sqrt(lenSq));
        return {0.0f, 0.0f, 1.0f};
    }

    /**
     * Blends 3 tiers of detail: Macro (structural shape), Meso (courses/joints), Micro (grit/pores).
     */
    static inline Vec3 blendThreeTier(const Vec3& macroN, const Vec3& mesoN, const Vec3& microN) {
        Vec3 mm = rnm(macroN, mesoN);
        return rnm(mm, microN);
    }
};

/**
 * Toksvig Specular Anti-Aliasing Filter.
 * Converts high-frequency normal map variance into effective microfacet roughness
 * to eliminate distracting specular shimmer and sparkling fireflies at distance.
 */
struct ToksvigFilter {
    /**
     * Given base roughness alpha and local normal variance sigmaSq,
     * computes the effective Toksvig roughness alpha_eff.
     * Formula: alpha_eff = sqrt(alpha^2 + clamp(sigmaSq * weight, 0, 1))
     */
    static inline float filterRoughness(float baseRoughness, float normalVariance, float weight = 1.0f) {
        float a2 = baseRoughness * baseRoughness;
        float v = std::clamp(normalVariance * weight, 0.0f, 0.95f);
        return std::clamp(std::sqrt(a2 + v), 0.04f, 1.0f);
    }

    /**
     * Derives normal variance from an ImageBuffer normal map in a neighborhood.
     */
    static float computeLocalNormalVariance(const ImageBuffer& normalMap, int cx, int cy, int radius = 2) {
        if (normalMap.empty()) return 0.0f;
        Vec3 meanN(0.0f, 0.0f, 0.0f);
        int count = 0;

        for (int dy = -radius; dy <= radius; ++dy) {
            for (int dx = -radius; dx <= radius; ++dx) {
                Vec3 n = normalMap.getPixelRGB(cx + dx, cy + dy) * 2.0f - Vec3(1.0f, 1.0f, 1.0f);
                meanN += n.normalized();
                count++;
            }
        }
        if (count == 0) return 0.0f;
        meanN = meanN * (1.0f / static_cast<float>(count));
        float len = meanN.length(); // In [0, 1], where 1 = perfectly uniform, <1 = high variance
        return std::clamp(1.0f - len, 0.0f, 1.0f);
    }
};

/**
 * Curvature & Gravitational Weathering Simulator.
 * Simulates real-world environmental patina:
 * 1. Cavity / Crevice dirt deposition in recessed joints and concave corners.
 * 2. Convex edge wear exposing raw underlying substrate or buffed highlights.
 * 3. Directional gravitational rain streaks descending from sills and overhangs.
 */
struct WeatheringParameters {
    float dirtAmount{0.35f};         // 0.0 = clean, 1.0 = heavy grime
    Vec3 dirtColor{0.18f, 0.15f, 0.12f}; // Urban soot / road dust
    float edgeWearAmount{0.25f};     // 0.0 = pristine, 1.0 = heavily scuffed
    float rainStreakIntensity{0.40f}; // Gravity water drip trails
    float streakFrequency{8.0f};     // Frequency of vertical water drips
};

struct WeatheringResult {
    ImageBuffer weatheredAlbedo;
    ImageBuffer weatheredRoughness;
    ImageBuffer grimeMask;
    ImageBuffer edgeWearMask;
};

inline WeatheringResult applyEnvironmentalWeathering(
    const PbrTextureSet& baseSet,
    const WeatheringParameters& params = {},
    uint32_t seed = 4242
) {
    int w = baseSet.albedo.width;
    int h = baseSet.albedo.height;

    WeatheringResult result;
    result.weatheredAlbedo = baseSet.albedo;
    result.weatheredRoughness = baseSet.roughness;
    result.grimeMask = ImageBuffer(w, h, 1);
    result.edgeWearMask = ImageBuffer(w, h, 1);

    if (w <= 0 || h <= 0) return result;

    for (int y = 0; y < h; ++y) {
        for (int x = 0; x < w; ++x) {
            float u = static_cast<float>(x) / static_cast<float>(w);
            float v = static_cast<float>(y) / static_cast<float>(h);

            // 1. Cavity grime from AO and height recess
            float aoVal = baseSet.ao.empty() ? 1.0f : baseSet.ao.getLuminance(x, y);
            float heightVal = baseSet.height.empty() ? 0.5f : baseSet.height.getLuminance(x, y);
            float cavity = std::clamp(1.0f - aoVal + (1.0f - heightVal) * 0.4f, 0.0f, 1.0f);

            // 2. Gravitational rain run-off streaks along vertical axis (v)
            float rainNoise = FastNoise3D::fbm(u * params.streakFrequency * 4.0f, v * 1.5f, 0.0f, 4, 2.0f, 0.5f, seed);
            float streakMod = math::smoothstep(0.45f, 0.75f, rainNoise) * std::clamp(v * 1.2f, 0.0f, 1.0f);
            float totalGrime = std::clamp(cavity * params.dirtAmount + streakMod * params.rainStreakIntensity, 0.0f, 1.0f);
            result.grimeMask.setPixelRGB(x, y, {totalGrime, totalGrime, totalGrime});

            // 3. Convex edge wear (protruding ridges get polished / stripped)
            float edgeProtrusion = std::clamp(heightVal - 0.75f, 0.0f, 1.0f) * 4.0f;
            float edgeWear = edgeProtrusion * params.edgeWearAmount;
            result.edgeWearMask.setPixelRGB(x, y, {edgeWear, edgeWear, edgeWear});

            // Apply grime & wear to albedo and roughness
            Vec3 baseCol = baseSet.albedo.getPixelRGB(x, y);
            Vec3 grimedCol = math::lerp(baseCol, params.dirtColor, totalGrime * 0.75f);
            Vec3 finalCol = math::lerp(grimedCol, baseCol * 1.15f, edgeWear); // Edge wear brightens/buffs
            result.weatheredAlbedo.setPixelRGB(x, y, finalCol);

            float baseRough = baseSet.roughness.empty() ? 0.5f : baseSet.roughness.getLuminance(x, y);
            float finalRough = std::clamp(baseRough + totalGrime * 0.35f - edgeWear * 0.25f, 0.08f, 1.0f);
            result.weatheredRoughness.setPixelRGB(x, y, {finalRough, finalRough, finalRough});
        }
    }

    return result;
}

/**
 * Parallax Occlusion Mapping (POM) Depth Evaluator.
 * Calculates apparent UV displacement and self-shadowing along the view/light vectors.
 */
struct ParallaxOcclusionEvaluator {
    /**
     * Evaluates POM offset using linear search followed by secant root finding.
     */
    static Vec2 computeParallaxOffset(
        const ImageBuffer& heightMap,
        const Vec2& uv,
        const Vec3& viewDirTangent,
        float depthScale = 0.05f,
        int minLayers = 8,
        int maxLayers = 32
    ) {
        if (heightMap.empty() || std::abs(viewDirTangent.z) < 1e-4f) return uv;

        // Dynamic layer count based on viewing angle
        float numLayers = math::lerp(static_cast<float>(maxLayers), static_cast<float>(minLayers),
                                     std::clamp(std::abs(viewDirTangent.z), 0.0f, 1.0f));
        float layerDepth = 1.0f / numLayers;
        float currentLayerDepth = 0.0f;

        // P = V.xy / V.z * depthScale
        Vec2 p = Vec2(viewDirTangent.x, viewDirTangent.y) * (depthScale / viewDirTangent.z);
        Vec2 deltaUV = p * layerDepth;

        Vec2 currentUV = uv;
        float currentDepthMapValue = 1.0f - heightMap.sampleBilinear(currentUV.x, currentUV.y).x;

        // Linear raymarching search
        while (currentLayerDepth < currentDepthMapValue) {
            currentUV = currentUV - deltaUV;
            currentDepthMapValue = 1.0f - heightMap.sampleBilinear(currentUV.x, currentUV.y).x;
            currentLayerDepth += layerDepth;
        }

        // Secant refinement
        Vec2 prevUV = currentUV + deltaUV;
        float nextDepth = currentDepthMapValue - currentLayerDepth;
        float prevDepth = (1.0f - heightMap.sampleBilinear(prevUV.x, prevUV.y).x) - currentLayerDepth + layerDepth;

        float weight = nextDepth / (nextDepth - prevDepth + 1e-6f);
        return prevUV * weight + currentUV * (1.0f - weight);
    }
};

} // namespace pbr_texture
} // namespace scratchbox

#include "scratchbox_pbr_50_library.hpp"

#endif // SCRATCHBOX_PBR_TEXTURE_EXPERT_HPP
