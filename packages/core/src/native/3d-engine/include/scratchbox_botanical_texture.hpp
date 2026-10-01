/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

#ifndef SCRATCHBOX_BOTANICAL_TEXTURE_HPP
#define SCRATCHBOX_BOTANICAL_TEXTURE_HPP

#include "scratchbox_math.hpp"
#include "scratchbox_texture.hpp"
#include "scratchbox_pbr_texture_expert.hpp"
#include "scratchbox_io.hpp"
#include <vector>
#include <cmath>
#include <algorithm>
#include <cstdint>
#include <string>

namespace scratchbox {
namespace botanical {

using math::Vec2;
using math::Vec3;
using math::Vec4;
using math::PI;
using math::TWO_PI;
using math::FastNoise3D;
using texture::ImageBuffer;
using texture::PbrTextureSet;
using texture::encodePng;
using io::EmbeddedTexture;
using io::TextureUsage;

// Periodic Worley F1/F2 cell generator with seamless horizontal wrapping
// dv from -3 to +3 prevents metric clipping when cells are strongly elongated vertically
inline void periodicWorleyF1F2(
    float u, float v,
    int cellsU, int cellsV,
    float aspectV,
    uint32_t seed,
    float& outF1, float& outF2, int& outCellId
) {
    u = u - std::floor(u);
    v = v - std::floor(v);

    float fu = u * static_cast<float>(cellsU);
    float fv = v * static_cast<float>(cellsV);
    int iu = static_cast<int>(std::floor(fu));
    int iv = static_cast<int>(std::floor(fv));

    float minD1 = 1e9f;
    float minD2 = 1e9f;
    int bestId = 0;

    auto cellHash = [](int cx, int cy, uint32_t s) -> uint32_t {
        uint32_t x = static_cast<uint32_t>(cx);
        uint32_t y = static_cast<uint32_t>(cy);
        uint32_t h = s ^ (x * 73856093u ^ y * 19349663u);
        h = ((h >> 16) ^ h) * 0x45d9f3b;
        h = ((h >> 16) ^ h) * 0x45d9f3b;
        h = (h >> 16) ^ h;
        return h;
    };

    for (int dv = -3; dv <= 3; ++dv) {
        int cy = (iv + dv) % cellsV;
        if (cy < 0) cy += cellsV;

        for (int du = -1; du <= 1; ++du) {
            int cx = (iu + du) % cellsU;
            if (cx < 0) cx += cellsU;

            uint32_t h = cellHash(cx, cy, seed);
            float jitterU = 0.15f + 0.70f * (static_cast<float>(h & 1023) / 1024.0f);
            float jitterV = 0.15f + 0.70f * (static_cast<float>((h >> 10) & 1023) / 1024.0f);

            float dx = (static_cast<float>(du) + jitterU) - (fu - static_cast<float>(iu));
            float dy = ((static_cast<float>(dv) + jitterV) - (fv - static_cast<float>(iv))) * aspectV;

            float distSq = dx * dx + dy * dy;
            if (distSq < minD1) {
                minD2 = minD1;
                minD1 = distSq;
                bestId = cx + cy * cellsU;
            } else if (distSq < minD2) {
                minD2 = distSq;
            }
        }
    }

    outF1 = std::sqrt(minD1);
    outF2 = std::sqrt(minD2);
    outCellId = bestId;
}

/**
 * High-performance procedural PBR botanical texture synthesizer.
 * Generates weathered hardwood oak bark and anatomical foliage PBR texture maps
 * (Albedo, Tangent-Space Normal, packed ORM) with zero external dependencies.
 */
class BotanicalPbrTextureSynthesizer {
public:
    /**
     * Synthesizes a tileable PBR texture set for complex desaturated weathered hardwood oak bark.
     * Uses seamless periodic Worley F1/F2 rhytidome plates, vertical domain warping,
     * longitudinal woodgrain fibers, and transverse drying micro-checks.
     */
    static PbrTextureSet synthesizeBarkPbrSet(int width = 512, int height = 512, uint32_t seed = 42, bool neutralAlbedo = false) {
        PbrTextureSet set;
        set.albedo = ImageBuffer(width, height, 4);
        set.normal = ImageBuffer(width, height, 3);
        set.roughness = ImageBuffer(width, height, 1);
        set.ao = ImageBuffer(width, height, 1);
        set.metallic = ImageBuffer(width, height, 1);
        set.orm = ImageBuffer(width, height, 3);
        set.height = ImageBuffer(width, height, 1);

        // 1. Synthesize Multi-Layered Bark Height Relief Field
        for (int y = 0; y < height; ++y) {
            float v = static_cast<float>(y) / height;
            for (int x = 0; x < width; ++x) {
                float u = static_cast<float>(x) / width;

                // Seamless cylindrical coordinates (offset to guarantee strictly positive evaluation)
                float angle = u * TWO_PI;
                float xWrap = std::cos(angle) + 100.0f;
                float zWrap = std::sin(angle) + 100.0f;
                float angleV = v * TWO_PI;
                float yWrap = std::cos(angleV) + 100.0f;

                // Organic domain warping (wavy grain flow)
                float warpU = 0.055f * FastNoise3D::perlin(xWrap * 1.2f, yWrap * 0.8f, zWrap * 1.2f, seed)
                            + 0.020f * FastNoise3D::perlin(xWrap * 2.8f, yWrap * 2.0f, zWrap * 2.8f, seed + 1);
                float warpV = 0.040f * FastNoise3D::perlin(xWrap * 1.2f + 7.0f, yWrap * 0.8f, zWrap * 1.2f + 3.0f, seed + 2);

                float uWarped = u + warpU;
                float vWarped = v + warpV;

                // A. Macro-Rhytidome Voronoi Cork Plates:
                // 14 major plates around perimeter, 16 plates vertically, aspectV = 0.22 (4.5x vertical elongation)
                float f1_macro, f2_macro;
                int cellId_macro;
                periodicWorleyF1F2(uWarped, vWarped, 14, 16, 0.22f, seed + 3, f1_macro, f2_macro, cellId_macro);

                // Fissure Cleft metric: F2 - F1
                float fissureMetric = f2_macro - f1_macro;
                // Canyon profile: steep cliff edge into fissure
                float canyon = std::clamp((fissureMetric - 0.02f) / 0.14f, 0.0f, 1.0f);
                canyon = canyon * canyon * (3.0f - 2.0f * canyon); // Smoothstep

                // Domed cork plate plateau with subtle inter-plate elevation variance
                float plateVariance = 0.90f + 0.10f * static_cast<float>((cellId_macro * 1337) & 255) / 255.0f;
                float plateHeight = canyon * (0.75f + 0.15f * (1.0f - std::min(f1_macro, 1.0f))) * plateVariance;

                // B. Secondary Meso-Scales: higher frequency Voronoi
                float f1_meso, f2_meso;
                int cellId_meso;
                periodicWorleyF1F2(uWarped, vWarped, 28, 36, 0.25f, seed + 4, f1_meso, f2_meso, cellId_meso);
                float mesoMetric = f2_meso - f1_meso;
                float mesoFissure = std::clamp((mesoMetric - 0.03f) / 0.14f, 0.0f, 1.0f);
                float hMeso = (mesoFissure * 2.0f - 1.0f) * 0.06f * canyon;

                // C. Longitudinal woodgrain fibrous striations along the plates
                float fiberNoise = FastNoise3D::fbm(xWrap * 16.0f, yWrap * 90.0f, zWrap * 16.0f, 3, 2.0f, 0.5f, seed + 5);
                float hFiber = (fiberNoise - 0.5f) * 0.07f * canyon;

                // D. Transverse drying micro-checks (horizontal tension cracks)
                float checkNoise = FastNoise3D::perlin(xWrap * 8.0f, yWrap * 40.0f, zWrap * 8.0f, seed + 6);
                float hCheck = (checkNoise > 0.44f && canyon > 0.4f) ? (checkNoise - 0.44f) * 0.25f : 0.0f;

                // E. Porous lenticels and weathering pits
                float pitNoise = FastNoise3D::perlin(xWrap * 24.0f, yWrap * 80.0f, zWrap * 24.0f, seed + 7);
                float hPit = (pitNoise > 0.42f && canyon > 0.3f) ? (pitNoise - 0.42f) * 0.14f : 0.0f;

                // Composite Height Field
                float hVal = std::clamp(plateHeight + hMeso + hFiber - hCheck - hPit + 0.05f, 0.02f, 1.0f);
                set.height.setPixelLuminance(x, y, hVal);
            }
        }

        // 2. Synthesize Desaturated Weathered Oak Albedo, Tangent-Space Normal, and Packed ORM
        // Stops calibrated for authentic weathered ash-oak cork reflectance:
        Vec3 cleftCol     = neutralAlbedo ? Vec3(0.35f, 0.35f, 0.35f) : Vec3(0.32f, 0.31f, 0.30f);  // Deep charcoal fissure clefts
        Vec3 riftWallCol  = neutralAlbedo ? Vec3(0.42f, 0.41f, 0.40f) : Vec3(0.40f, 0.39f, 0.38f);  // Weathered shadow wall
        Vec3 lowerPlateCol= neutralAlbedo ? Vec3(0.50f, 0.49f, 0.47f) : Vec3(0.48f, 0.47f, 0.45f);  // Darker weathered cork
        Vec3 midPlateCol  = neutralAlbedo ? Vec3(0.58f, 0.56f, 0.55f) : Vec3(0.56f, 0.54f, 0.53f);  // Neutral grey-brown cork plate
        Vec3 upperPlateCol= neutralAlbedo ? Vec3(0.64f, 0.63f, 0.61f) : Vec3(0.62f, 0.61f, 0.59f);  // Weathered silver-ash cork plateau
        Vec3 crestCol     = neutralAlbedo ? Vec3(0.70f, 0.69f, 0.67f) : Vec3(0.68f, 0.67f, 0.65f);  // Sun-bleached cork ridge crest
        Vec3 dustCol      = neutralAlbedo ? Vec3(0.54f, 0.54f, 0.52f) : Vec3(0.52f, 0.52f, 0.50f);  // Subtle dry mineral dust in recesses

        for (int y = 0; y < height; ++y) {
            float v = static_cast<float>(y) / height;
            for (int x = 0; x < width; ++x) {
                float u = static_cast<float>(x) / width;
                float hVal = set.height.getLuminance(x, y);

                float angle = u * TWO_PI;
                float xWrap = std::cos(angle) + 100.0f;
                float zWrap = std::sin(angle) + 100.0f;

                Vec3 col;
                if (hVal < 0.22f) {
                    float t = hVal / 0.22f;
                    col = cleftCol * (1.0f - t) + riftWallCol * t;
                } else if (hVal < 0.45f) {
                    float t = (hVal - 0.22f) / 0.23f;
                    col = riftWallCol * (1.0f - t) + lowerPlateCol * t;
                } else if (hVal < 0.68f) {
                    float t = (hVal - 0.45f) / 0.23f;
                    col = lowerPlateCol * (1.0f - t) + midPlateCol * t;
                } else if (hVal < 0.84f) {
                    float t = (hVal - 0.68f) / 0.16f;
                    col = midPlateCol * (1.0f - t) + upperPlateCol * t;
                } else {
                    float t = (hVal - 0.84f) / 0.16f;
                    col = upperPlateCol * (1.0f - t) + crestCol * t;
                }

                // Mineral silica patina in sheltered recesses (strictly desaturated)
                float dustNoise = FastNoise3D::perlin(xWrap * 6.0f, v * 12.0f, zWrap * 6.0f, seed + 8);
                if (dustNoise > 0.28f && hVal > 0.25f && hVal < 0.65f) {
                    float pAlpha = std::clamp((dustNoise - 0.28f) * 2.2f, 0.0f, 0.25f);
                    col = col * (1.0f - pAlpha) + dustCol * pAlpha;
                }

                // Sun-bleached woodgrain fiber streaks along crests
                float streakNoise = FastNoise3D::perlin(xWrap * 24.0f, v * 180.0f, zWrap * 24.0f, seed + 9);
                if (hVal > 0.70f && streakNoise > 0.22f) {
                    float sAlpha = std::clamp((streakNoise - 0.22f) * 2.5f, 0.0f, 0.35f);
                    col = col * (1.0f - sAlpha) + crestCol * sAlpha;
                }

                set.albedo.setPixelRGB(x, y, col);
                // Alpha is 1.0 (fully opaque wood)
                size_t albIdx = static_cast<size_t>((y * width + x) * 4);
                set.albedo.data[albIdx + 3] = 255;

                // Tangent Space Normal using 3x3 Scharr filter with bump factor 4.5
                Vec3 norm = pbr_texture::computeScharrNormal(set.height, x, y, 4.5f);
                Vec3 normRgb = (norm * 0.5f + Vec3(0.5f, 0.5f, 0.5f));
                set.normal.setPixelRGB(x, y, normRgb);

                // Packed ORM:
                // Red = Cavity Ambient Occlusion (canyons down to 0.18, crests 1.0)
                float ao = std::clamp(std::pow(hVal, 0.68f) * 1.25f, 0.18f, 1.0f);
                // Green = Roughness (coarse dry cork 0.85 - 0.98)
                float roughness = std::clamp(0.86f + (1.0f - hVal) * 0.12f, 0.82f, 0.98f);
                // Blue = Metallic (0.0 strict dielectric wood)
                float metallic = 0.0f;

                set.ao.setPixelLuminance(x, y, ao);
                set.roughness.setPixelLuminance(x, y, roughness);
                set.metallic.setPixelLuminance(x, y, metallic);
                set.orm.setPixelRGB(x, y, Vec3(ao, roughness, metallic));
            }
        }

        return set;
    }

    /**
     * Synthesizes an anatomical PBR foliage texture set (lobed leaf blade, midrib, venation,
     * waxy cuticle roughness, and zero-drift alpha cavity perforation).
     */
    static PbrTextureSet synthesizeLeafPbrSet(
        int width = 256,
        int height = 256,
        float season = 1.0f,
        uint32_t seed = 101,
        bool neutralAlbedo = false
    ) {
        PbrTextureSet set;
        set.albedo = ImageBuffer(width, height, 4);
        set.normal = ImageBuffer(width, height, 3);
        set.roughness = ImageBuffer(width, height, 1);
        set.ao = ImageBuffer(width, height, 1);
        set.metallic = ImageBuffer(width, height, 1);
        set.orm = ImageBuffer(width, height, 3);
        set.height = ImageBuffer(width, height, 1);

        // Color definitions
        Vec3 veinCol, laminaCol, marginCol, petioleWoodCol;
        if (neutralAlbedo) {
            // Botanical chlorophyll base matching aerial photogrammetry tile albedo:
            // Prevents specular washout and desaturation under runtime sun lighting,
            // with tastefully muted saturation for natural outdoor organic realism.
            veinCol = Vec3(0.74f, 0.79f, 0.73f);        // Translucent midrib / secondary chevrons (muted)
            laminaCol = Vec3(0.72f, 0.78f, 0.72f);      // Deep chlorophyll base matching map tile (muted)
            marginCol = Vec3(0.68f, 0.74f, 0.68f);      // Subtle edge falloff
            petioleWoodCol = Vec3(0.50f, 0.46f, 0.42f); // Woody petiole attachment
        } else {
            // Summer Chlorophyll - muted a tad
            Vec3 veinColSummer(0.50f, 0.68f, 0.28f);
            Vec3 laminaColSummer(0.22f, 0.48f, 0.18f);
            Vec3 marginColSummer(0.34f, 0.58f, 0.22f);

            // Autumn Carotenoids - natural amber
            Vec3 veinColAutumn(0.85f, 0.68f, 0.22f);
            Vec3 laminaColAutumn(0.75f, 0.35f, 0.14f);
            Vec3 marginColAutumn(0.82f, 0.50f, 0.16f);

            // Blend colors based on season
            float sBlend = std::clamp((season - 0.25f) / 0.50f, 0.0f, 1.0f);
            veinCol = veinColAutumn * (1.0f - sBlend) + veinColSummer * sBlend;
            laminaCol = laminaColAutumn * (1.0f - sBlend) + laminaColSummer * sBlend;
            marginCol = marginColAutumn * (1.0f - sBlend) + marginColSummer * sBlend;
            petioleWoodCol = Vec3(0.32f, 0.24f, 0.18f);
        }

        for (int y = 0; y < height; ++y) {
            float v = static_cast<float>(y) / height;
            for (int x = 0; x < width; ++x) {
                float u = static_cast<float>(x) / width;

                float dMidrib = std::abs(u - 0.5f);

                // Leaf margin envelope:
                // Base petiole at v=0..0.06, wide lobed body at v=0.08..0.85, pointed apex at v=0.98
                float baseEnv = std::sin(PI * std::clamp(v, 0.0f, 1.0f));
                baseEnv = std::pow(baseEnv, 0.62f);

                // Sinusoidal lobes along margins (4 distinct oak lobes per side)
                float lobeMod = 0.36f + 0.11f * std::sin(v * 24.0f) + 0.035f * std::sin(v * 48.0f);
                float halfWidth = baseEnv * lobeMod;

                // Petiole stem section (v < 0.06)
                bool isPetioleStem = (v < 0.06f && dMidrib < 0.022f);

                // Inside leaf blade boundary
                bool isLamina = (v >= 0.05f && v <= 0.98f && dMidrib <= halfWidth);

                if (!isPetioleStem && !isLamina) {
                    // Margin gutter padding: bleed edge chlorophyll albedo and waxy cuticle roughness
                    // to prevent dark seam fringing or specular blowout across GPU mip levels
                    size_t idx4 = static_cast<size_t>((y * width + x) * 4);
                    Vec3 bleedCol = marginCol * 0.90f;
                    set.albedo.setPixelRGB(x, y, bleedCol);
                    set.albedo.data[idx4 + 3] = 0; // Transparent cutout for planar cards

                    set.normal.setPixelRGB(x, y, Vec3(0.5f, 0.5f, 1.0f));
                    set.orm.setPixelRGB(x, y, Vec3(0.65f, 0.58f, 0.0f));
                    continue;
                }

                // If petiole stem:
                if (isPetioleStem) {
                    size_t idx4 = static_cast<size_t>((y * width + x) * 4);
                    set.albedo.setPixelRGB(x, y, petioleWoodCol);
                    set.albedo.data[idx4 + 3] = 255;

                    set.normal.setPixelRGB(x, y, Vec3(0.5f, 0.5f, 1.0f));
                    set.orm.setPixelRGB(x, y, Vec3(0.6f, 0.85f, 0.0f));
                    continue;
                }

                // Primary central midrib vein
                float midribThick = 0.016f * (1.1f - v * 0.65f);
                bool isMidrib = (dMidrib < midribThick);

                // Secondary lateral veins (pinnate chevrons emerging at 42 degrees)
                float chevronV = v - dMidrib * 0.82f;
                float veinPhase = std::fmod(chevronV * 9.5f, 1.0f);
                if (veinPhase < 0.0f) veinPhase += 1.0f;
                float veinDist = std::abs(veinPhase - 0.5f) * 2.0f;
                bool isSecVein = (veinDist < 0.14f && dMidrib < halfWidth * 0.88f);

                // Mesophyll spongy cell noise (Worley / Voronoi cell network)
                auto worley = pbr_texture::worley2D(u * 28.0f, v * 28.0f, 0.75f, seed);
                float cellPores = worley.f1;

                // Color assignment
                Vec3 col;
                float heightRelief = 0.5f;

                if (isMidrib) {
                    col = veinCol;
                    heightRelief = 0.85f;
                } else if (isSecVein) {
                    float veinFade = 1.0f - (dMidrib / (halfWidth * 0.90f));
                    col = veinCol * veinFade + laminaCol * (1.0f - veinFade);
                    heightRelief = 0.70f;
                } else {
                    float edgeProximity = dMidrib / std::max(1e-4f, halfWidth);
                    if (edgeProximity > 0.85f) {
                        float t = (edgeProximity - 0.85f) / 0.15f;
                        col = laminaCol * (1.0f - t) + marginCol * t;
                    } else {
                        col = laminaCol;
                    }
                    col = col * (0.92f + cellPores * 0.16f);
                    // Slight paraboloid cupping relief across leaf blade
                    float cup = (1.0f - (dMidrib / halfWidth) * (dMidrib / halfWidth));
                    heightRelief = 0.45f + cup * 0.15f;
                }

                // Write Albedo with full Alpha
                set.albedo.setPixelRGB(x, y, col);
                size_t idx4 = static_cast<size_t>((y * width + x) * 4);
                set.albedo.data[idx4 + 3] = 255;

                // Tangent Space Normal with raised midrib and cupped lamina
                float normX = 0.0f;
                float normY = 0.0f;
                if (isMidrib) {
                    normX = (u > 0.5f ? 0.35f : -0.35f);
                } else {
                    // Paraboloid blade curvature
                    normX = (u - 0.5f) / halfWidth * 0.30f;
                    if (isSecVein) {
                        normY = 0.22f; // Raised chevron vein angle
                    }
                }
                Vec3 norm(normX, normY, 1.0f);
                norm = norm.normalized();
                Vec3 normRgb = norm * 0.5f + Vec3(0.5f, 0.5f, 0.5f);
                set.normal.setPixelRGB(x, y, normRgb);

                // Packed ORM:
                // Red = Cavity AO (darker at petiole attachment, bright on leaf blade)
                float ao = std::clamp(0.40f + v * 0.60f, 0.30f, 1.0f);
                // Green = Roughness (waxy adaxial cuticle 0.80 - 0.84, veins 0.88)
                float roughness = isMidrib ? 0.88f : (isSecVein ? 0.84f : 0.80f);
                // Blue = Metallic (0.0)
                float metallic = 0.0f;

                set.ao.setPixelLuminance(x, y, ao);
                set.roughness.setPixelLuminance(x, y, roughness);
                set.metallic.setPixelLuminance(x, y, metallic);
                set.orm.setPixelRGB(x, y, Vec3(ao, roughness, metallic));
            }
        }

        return set;
    }

    /**
     * Synthesizes and packs all 6 botanical PBR texture maps into glTF EmbeddedTexture objects
     * ready for binary GLB embedding.
     */
    static std::vector<EmbeddedTexture> createBotanicalEmbeddedTextures(
        int width = 512,
        int height = 512,
        float season = 1.0f,
        uint32_t seed = 42,
        bool neutralAlbedo = false
    ) {
        std::vector<EmbeddedTexture> textures;

        // 1. Synthesize Bark PBR Set (Material Index 0: Wood / Branches)
        PbrTextureSet barkSet = synthesizeBarkPbrSet(width, height, seed, neutralAlbedo);
        std::vector<uint8_t> barkAlbedoPng = encodePng(barkSet.albedo);
        std::vector<uint8_t> barkNormalPng = encodePng(barkSet.normal);
        std::vector<uint8_t> barkOrmPng = encodePng(barkSet.orm);

        if (!barkAlbedoPng.empty()) {
            EmbeddedTexture t;
            t.data = barkAlbedoPng;
            t.mimeType = "image/png";
            t.usage = TextureUsage::BASE_COLOR;
            t.materialIndex = 0;
            textures.push_back(t);
        }
        if (!barkNormalPng.empty()) {
            EmbeddedTexture t;
            t.data = barkNormalPng;
            t.mimeType = "image/png";
            t.usage = TextureUsage::NORMAL;
            t.materialIndex = 0;
            textures.push_back(t);
        }
        if (!barkOrmPng.empty()) {
            EmbeddedTexture t;
            t.data = barkOrmPng;
            t.mimeType = "image/png";
            t.usage = TextureUsage::ORM;
            t.materialIndex = 0;
            textures.push_back(t);
        }

        // 2. Synthesize Foliage PBR Set (Material Index 1: Canopy Leaf Blades)
        PbrTextureSet leafSet = synthesizeLeafPbrSet(width, height, season, seed + 100, neutralAlbedo);
        std::vector<uint8_t> leafAlbedoPng = encodePng(leafSet.albedo);
        std::vector<uint8_t> leafNormalPng = encodePng(leafSet.normal);
        std::vector<uint8_t> leafOrmPng = encodePng(leafSet.orm);

        if (!leafAlbedoPng.empty()) {
            EmbeddedTexture t;
            t.data = leafAlbedoPng;
            t.mimeType = "image/png";
            t.usage = TextureUsage::BASE_COLOR;
            t.materialIndex = 1;
            textures.push_back(t);
        }
        if (!leafNormalPng.empty()) {
            EmbeddedTexture t;
            t.data = leafNormalPng;
            t.mimeType = "image/png";
            t.usage = TextureUsage::NORMAL;
            t.materialIndex = 1;
            textures.push_back(t);
        }
        if (!leafOrmPng.empty()) {
            EmbeddedTexture t;
            t.data = leafOrmPng;
            t.mimeType = "image/png";
            t.usage = TextureUsage::ORM;
            t.materialIndex = 1;
            textures.push_back(t);
        }

        return textures;
    }
};

} // namespace botanical
} // namespace scratchbox

#endif // SCRATCHBOX_BOTANICAL_TEXTURE_HPP
