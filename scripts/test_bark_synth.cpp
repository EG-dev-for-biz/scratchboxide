#include <iostream>
#include <fstream>
#include <vector>
#include <cmath>
#include <algorithm>
#include "scratchbox_math.hpp"
#include "scratchbox_texture.hpp"
#include "scratchbox_pbr_texture_expert.hpp"

using namespace scratchbox;
using namespace scratchbox::math;
using namespace scratchbox::texture;

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

int main() {
    int width = 512;
    int height = 512;
    uint32_t seed = 42;

    ImageBuffer heightMap(width, height, 1);
    ImageBuffer albedoMap(width, height, 4);
    ImageBuffer normalMap(width, height, 3);
    ImageBuffer ormMap(width, height, 3);

    std::cout << "[test_bark_synth] Synthesizing continuous oak rhytidome plates (wide dv search)..." << std::endl;

    for (int y = 0; y < height; ++y) {
        float v = static_cast<float>(y) / height;
        for (int x = 0; x < width; ++x) {
            float u = static_cast<float>(x) / width;

            // Seamless cylindrical coordinates
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

            // Macro-Rhytidome Voronoi Cork Plates:
            // 14 plates around perimeter, 16 plates vertically, aspectV = 0.22
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

            // Secondary Meso-Scales: higher frequency Voronoi
            float f1_meso, f2_meso;
            int cellId_meso;
            periodicWorleyF1F2(uWarped, vWarped, 28, 36, 0.25f, seed + 4, f1_meso, f2_meso, cellId_meso);
            float mesoMetric = f2_meso - f1_meso;
            float mesoFissure = std::clamp((mesoMetric - 0.03f) / 0.14f, 0.0f, 1.0f);
            float hMeso = (mesoFissure * 2.0f - 1.0f) * 0.06f * canyon;

            // Longitudinal woodgrain fibrous striations along the plates
            float fiberNoise = FastNoise3D::fbm(xWrap * 16.0f, yWrap * 90.0f, zWrap * 16.0f, 3, 2.0f, 0.5f, seed + 5);
            float hFiber = (fiberNoise - 0.5f) * 0.07f * canyon;

            // Transverse drying micro-checks
            float checkNoise = FastNoise3D::perlin(xWrap * 8.0f, yWrap * 40.0f, zWrap * 8.0f, seed + 6);
            float hCheck = (checkNoise > 0.44f && canyon > 0.4f) ? (checkNoise - 0.44f) * 0.25f : 0.0f;

            // Porous lenticels and weathering pits
            float pitNoise = FastNoise3D::perlin(xWrap * 24.0f, yWrap * 80.0f, zWrap * 24.0f, seed + 7);
            float hPit = (pitNoise > 0.42f && canyon > 0.3f) ? (pitNoise - 0.42f) * 0.14f : 0.0f;

            // Composite Height Field
            float hVal = std::clamp(plateHeight + hMeso + hFiber - hCheck - hPit + 0.05f, 0.02f, 1.0f);
            heightMap.setPixelLuminance(x, y, hVal);
        }
    }

    // Synthesize Desaturated Weathered Oak Albedo, Normal, and ORM
    // Ash-grey oak palette stops: calibrated to real mature Quercus bark reflectance
    Vec3 cleftCol(0.32f, 0.31f, 0.30f);      // Deep charcoal/slate fissure abyss
    Vec3 riftWallCol(0.40f, 0.39f, 0.38f);   // Weathered shadow wall
    Vec3 lowerPlateCol(0.48f, 0.47f, 0.45f); // Darker weathered cork
    Vec3 midPlateCol(0.56f, 0.54f, 0.53f);   // Neutral grey-brown cork plate
    Vec3 upperPlateCol(0.62f, 0.61f, 0.59f); // Weathered silver-ash cork plateau
    Vec3 crestCol(0.68f, 0.67f, 0.65f);      // Sun-bleached cork ridge crest
    Vec3 lichenDustCol(0.52f, 0.52f, 0.50f); // Subtle muted dry lichen patina in recesses

    for (int y = 0; y < height; ++y) {
        float v = static_cast<float>(y) / height;
        for (int x = 0; x < width; ++x) {
            float u = static_cast<float>(x) / width;
            float hVal = heightMap.getLuminance(x, y);

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

            // Mineral patina in sheltered recesses
            float patinaNoise = FastNoise3D::perlin(xWrap * 6.0f, v * 12.0f, zWrap * 6.0f, seed + 8);
            if (patinaNoise > 0.28f && hVal > 0.25f && hVal < 0.65f) {
                float pAlpha = std::clamp((patinaNoise - 0.28f) * 2.2f, 0.0f, 0.25f);
                col = col * (1.0f - pAlpha) + lichenDustCol * pAlpha;
            }

            // Sun-bleached woodgrain fiber streaks along crests
            float streakNoise = FastNoise3D::perlin(xWrap * 24.0f, v * 180.0f, zWrap * 24.0f, seed + 9);
            if (hVal > 0.70f && streakNoise > 0.22f) {
                float sAlpha = std::clamp((streakNoise - 0.22f) * 2.5f, 0.0f, 0.35f);
                col = col * (1.0f - sAlpha) + crestCol * sAlpha;
            }

            albedoMap.setPixelRGB(x, y, col);
            size_t aIdx = static_cast<size_t>((y * width + x) * 4);
            albedoMap.data[aIdx + 3] = 255;

            // Scharr Normal Map (tangent space) with bump strength 4.5
            Vec3 norm = pbr_texture::computeScharrNormal(heightMap, x, y, 4.5f);
            Vec3 normRgb = (norm * 0.5f + Vec3(0.5f, 0.5f, 0.5f));
            normalMap.setPixelRGB(x, y, normRgb);

            // Packed ORM:
            float ao = std::clamp(std::pow(hVal, 0.68f) * 1.25f, 0.18f, 1.0f);
            float roughness = std::clamp(0.86f + (1.0f - hVal) * 0.12f, 0.82f, 0.98f);
            float metallic = 0.0f;
            ormMap.setPixelRGB(x, y, Vec3(ao, roughness, metallic));
        }
    }

    std::vector<uint8_t> albPng = encodePng(albedoMap);
    std::vector<uint8_t> nrmPng = encodePng(normalMap);
    std::vector<uint8_t> ormPng = encodePng(ormMap);
    std::vector<uint8_t> hgtPng = encodePng(heightMap);

    std::ofstream("public/test_bark_albedo.png", std::ios::binary).write(reinterpret_cast<char*>(albPng.data()), albPng.size());
    std::ofstream("public/test_bark_normal.png", std::ios::binary).write(reinterpret_cast<char*>(nrmPng.data()), nrmPng.size());
    std::ofstream("public/test_bark_orm.png", std::ios::binary).write(reinterpret_cast<char*>(ormPng.data()), ormPng.size());
    std::ofstream("public/test_bark_height.png", std::ios::binary).write(reinterpret_cast<char*>(hgtPng.data()), hgtPng.size());

    std::cout << "[test_bark_synth] Successfully generated updated Voronoi rhytidome maps!" << std::endl;
    return 0;
}
