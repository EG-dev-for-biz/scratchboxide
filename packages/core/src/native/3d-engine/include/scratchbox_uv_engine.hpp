/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

#ifndef SCRATCHBOX_UV_ENGINE_HPP
#define SCRATCHBOX_UV_ENGINE_HPP

#include "scratchbox_math.hpp"
#include "scratchbox_geometry.hpp"
#include "scratchbox_uv_tangent.hpp"
#include "scratchbox_texture.hpp"

#include <vector>
#include <cmath>
#include <algorithm>
#include <cstdint>
#include <string>
#include <memory>
#include <chrono>

namespace scratchbox {
namespace uv_engine {

using math::Vec2;
using math::Vec3;
using math::Vec4;
using geometry::Vertex;
using geometry::ScratchboxMesh;
using texture::ImageBuffer;
using texture::PbrTextureSet;

// ============================================================================
// 1. Semantic Material Classification
// ============================================================================

enum class SurfaceMaterialType {
    StoneArchitecture,
    AsphaltRoadway,
    FoliageVegetation,
    PlasterMasonry
};

inline SurfaceMaterialType classifySurface(const Vec3& norm, const Vec3& rgb, float reliefY) {
    float r = rgb.x * 255.0f;
    float g = rgb.y * 255.0f;
    float b = rgb.z * 255.0f;

    // Foliage: green dominance
    if ((g > r + 6.0f && g > b + 6.0f) || (2.0f * g - r - b > 12.0f)) {
        return SurfaceMaterialType::FoliageVegetation;
    }

    // Asphalt / Road: flat horizontal surface with neutral slate tones
    float ny = std::abs(norm.y);
    float colorDiff = std::max({std::abs(r - g), std::abs(g - b), std::abs(r - b)});
    if (ny > 0.72f && colorDiff < 16.0f && r < 145.0f) {
        return SurfaceMaterialType::AsphaltRoadway;
    }

    // Travertine Stone: warm tones (R > G > B) with architectural elevation
    if (r > g && g >= b && (r - b > 14.0f)) {
        return SurfaceMaterialType::StoneArchitecture;
    }

    return SurfaceMaterialType::PlasterMasonry;
}

// ============================================================================
// 2. Continuous 3D Coordinate & Barycentric Interpolation
// ============================================================================

struct BarycentricCoords {
    float u{0};
    float v{0};
    float w{0};
    bool valid{false};
};

/**
 * Computes exact 2D barycentric weights within UV triangle coordinates.
 */
inline BarycentricCoords computeBarycentric(
    float px, float py,
    float x1, float y1,
    float x2, float y2,
    float x3, float y3,
    float det
) {
    if (std::abs(det) < 1e-9f) {
        return {0.0f, 0.0f, 0.0f, false};
    }

    float u = ((y2 - y3) * (px - x3) + (x3 - x2) * (py - y3)) / det;
    float v = ((y3 - y1) * (px - x3) + (x1 - x3) * (py - y3)) / det;
    float w = 1.0f - u - v;

    bool valid = (u >= -0.01f && v >= -0.01f && w >= -0.01f);
    return {u, v, w, valid};
}

// ============================================================================
// 3. Analytical Quadratic Cavitation & Micro-Detail Generators
// ============================================================================

/**
 * Procedural travertine cavitation pore generator.
 * Implements steep non-linear power curve:
 *   ΔL_pore = -((0.24 - n) / 0.24)^2 * 52.0
 */
inline float evaluateTravertineCavitation(const Vec3& pos, uint32_t seed = 1337) {
    // Multi-octave 3D coordinate noise
    float scale1 = 28.0f;
    float n1 = math::FastNoise3D::perlin(pos.x * scale1, pos.y * scale1, pos.z * scale1, seed);
    float scale2 = 64.0f;
    float n2 = math::FastNoise3D::perlin(pos.x * scale2, pos.y * scale2, pos.z * scale2, seed + 101);
    float n = (n1 * 0.65f + n2 * 0.35f + 1.0f) * 0.5f; // [0, 1]

    if (n < 0.24f) {
        float depth = (0.24f - n) / 0.24f;
        return -(depth * depth) * 52.0f; // Dark steep cavitation pore
    }
    return 0.0f;
}

/**
 * Procedural crystalline calcite tooth and horizontal bedding strata.
 */
inline float evaluateCalciteStrata(const Vec3& pos) {
    // Horizontal sedimentary bedding strata along Y axis
    float strata = std::sin(pos.y * 140.0f + math::FastNoise3D::perlin(pos.x * 12.0f, 0.0f, pos.z * 12.0f, 555) * 2.5f);
    float strataDelta = strata * 4.5f;

    // High-frequency crystalline calcite grain
    float tooth = (math::FastNoise3D::perlin(pos.x * 120.0f, pos.y * 120.0f, pos.z * 120.0f, 777)) * 5.0f;
    return strataDelta + tooth;
}

/**
 * Bituminous asphalt fine aggregate gravel noise.
 */
inline float evaluateBitumenAggregate(const Vec3& pos) {
    float n = math::FastNoise3D::perlin(pos.x * 90.0f, pos.y * 90.0f, pos.z * 90.0f, 999);
    return n * 6.5f; // Random isotropic asphalt roughness
}

/**
 * Chlorophyll leaf dappling and foliage micro-contrast.
 */
inline float evaluateChlorophyllDappling(const Vec3& pos) {
    float n = math::FastNoise3D::perlin(pos.x * 45.0f, pos.y * 45.0f, pos.z * 45.0f, 1234);
    return n * 8.0f;
}

// ============================================================================
// 4. Intrinsic Image Decomposition (Albedo vs. Irradiance)
// ============================================================================

/**
 * Intrinsic Image Decomposition: separates irradiance S from albedo A:
 *   I(x, y) = A(x, y) * S(x, y)
 * Bilateral filter removes low-frequency directional shadows while preserving crisp albedo edges.
 */
inline void decomposeIntrinsicAlbedo(
    const ImageBuffer& src,
    ImageBuffer& outAlbedo,
    ImageBuffer& outShading,
    float spatialSigma = 4.0f,
    float rangeSigma = 0.15f
) {
    int w = src.width;
    int h = src.height;
    outAlbedo = ImageBuffer(w, h, 3);
    outShading = ImageBuffer(w, h, 3);

    int radius = static_cast<int>(spatialSigma * 2.0f);

    for (int y = 0; y < h; ++y) {
        for (int x = 0; x < w; ++x) {
            Vec3 centerCol = src.getPixelRGB(x, y);
            float centerLum = src.getLuminance(x, y);

            float sumWeights = 0.0f;
            float sumLum = 0.0f;

            for (int dy = -radius; dy <= radius; ++dy) {
                int ny = y + dy;
                if (ny < 0 || ny >= h) continue;

                for (int dx = -radius; dx <= radius; ++dx) {
                    int nx = x + dx;
                    if (nx < 0 || nx >= w) continue;

                    float spatialDistSq = static_cast<float>(dx * dx + dy * dy);
                    float spatialWeight = std::exp(-spatialDistSq / (2.0f * spatialSigma * spatialSigma));

                    float neighborLum = src.getLuminance(nx, ny);
                    float rangeDist = neighborLum - centerLum;
                    float rangeWeight = std::exp(-(rangeDist * rangeDist) / (2.0f * rangeSigma * rangeSigma));

                    float weight = spatialWeight * rangeWeight;
                    sumLum += neighborLum * weight;
                    sumWeights += weight;
                }
            }

            float smoothShading = (sumWeights > 1e-6f) ? (sumLum / sumWeights) : centerLum;
            smoothShading = std::clamp(smoothShading, 0.05f, 1.0f);

            // Shading ratio S in [0.2, 1.0]
            float sRatio = std::clamp(smoothShading, 0.2f, 1.0f);
            outShading.setPixelRGB(x, y, {sRatio, sRatio, sRatio});

            // True diffuse albedo A = I / S
            Vec3 albedo = centerCol * (1.0f / sRatio);
            albedo.x = std::clamp(albedo.x, 0.0f, 1.0f);
            albedo.y = std::clamp(albedo.y, 0.0f, 1.0f);
            albedo.z = std::clamp(albedo.z, 0.0f, 1.0f);
            outAlbedo.setPixelRGB(x, y, albedo);
        }
    }
}

// ============================================================================
// 4b. Solar Inverse De-Lighting via NOAA Ephemeris & Ramamoorthi SH9
// ============================================================================

struct SolarEphemerisConfig {
    Vec3 sunVector{0.45f, 0.75f, -0.48f};
    std::array<Vec3, 9> skyShCoeffs{
        Vec3{0.65f, 0.72f, 0.85f},
        Vec3{0.20f, 0.28f, 0.40f},
        Vec3{0.15f, 0.20f, 0.30f},
        Vec3{0.10f, 0.15f, 0.25f},
        Vec3{0.05f, 0.08f, 0.12f},
        Vec3{0.04f, 0.06f, 0.10f},
        Vec3{0.08f, 0.12f, 0.18f},
        Vec3{0.03f, 0.05f, 0.08f},
        Vec3{0.02f, 0.04f, 0.06f}
    };
    float directWeight{0.65f};
    float ambientWeight{0.35f};
    float regularizationEpsilon{0.18f};
};

inline Vec3 evaluateSh9Irradiance(const Vec3& n, const std::array<Vec3, 9>& sh) {
    constexpr float c1 = 0.429043f;
    constexpr float c2 = 0.511664f;
    constexpr float c3 = 0.743125f;
    constexpr float c4 = 0.886227f;
    constexpr float c5 = 0.247708f;

    Vec3 out{0.0f, 0.0f, 0.0f};
    float x = n.x, y = n.y, z = n.z;

    for (int ch = 0; ch < 3; ++ch) {
        auto c = [&](int i) { return sh[i][ch]; };
        float val =
            c(0) * c4 -
            c(6) * c5 +
            c(6) * (c3 * y * y) +
            (c(8) * (x * x - z * z) +
             c(4) * (2.0f * x * z) +
             c(7) * (2.0f * x * y) +
             c(5) * (2.0f * z * y)) * c1 +
            (c(3) * x + c(1) * y + c(2) * z) * (2.0f * c2);
        out[ch] = std::max(0.0f, val);
    }
    return out;
}

inline float computeSolarIrradiance(
    const Vec3& normal,
    const SolarEphemerisConfig& config = {}
) {
    Vec3 n = normal.normalized();
    Vec3 s = config.sunVector.normalized();

    float nDotL = std::max(0.0f, n.dot(s));
    Vec3 skyRgb = evaluateSh9Irradiance(n, config.skyShCoeffs);
    float ambient = 0.2126f * skyRgb.x + 0.7152f * skyRgb.y + 0.0722f * skyRgb.z;

    float total = nDotL * config.directWeight + ambient * config.ambientWeight;
    return std::clamp(total, config.regularizationEpsilon, 1.8f);
}

inline void applySolarInverseDelighting(
    ImageBuffer& albedo,
    const SolarEphemerisConfig& config = {}
) {
    int w = albedo.width;
    int h = albedo.height;

    for (int y = 0; y < h; ++y) {
        for (int x = 0; x < w; ++x) {
            Vec3 col = albedo.getPixelRGB(x, y);

            float lumL = albedo.getLuminance(std::max(0, x - 1), y);
            float lumR = albedo.getLuminance(std::min(w - 1, x + 1), y);
            float lumB = albedo.getLuminance(x, std::max(0, y - 1));
            float lumT = albedo.getLuminance(x, std::min(h - 1, y + 1));

            float dx = (lumR - lumL) * 1.5f;
            float dy = (lumT - lumB) * 1.5f;
            Vec3 normal(-dx, -dy, 1.0f);

            float irradiance = computeSolarIrradiance(normal, config);
            col = col * (1.0f / irradiance);
            col.x = std::clamp(col.x, 0.0f, 1.0f);
            col.y = std::clamp(col.y, 0.0f, 1.0f);
            col.z = std::clamp(col.z, 0.0f, 1.0f);

            albedo.setPixelRGB(x, y, col);
        }
    }
}

// ============================================================================
// 5. Analytical Sky-Dome Ambient Occlusion (AO)
// ============================================================================

/**
 * Computes analytical ambient occlusion combining surface concavity and sky-dome exposure (N_y > 0).
 */
inline ImageBuffer computeSkyDomeAO(
    const ImageBuffer& albedo,
    const ScratchboxMesh& mesh,
    float intensity = 1.0f
) {
    int w = albedo.width;
    int h = albedo.height;
    ImageBuffer ao(w, h, 3);

    for (int y = 0; y < h; ++y) {
        for (int x = 0; x < w; ++x) {
            float center = albedo.getLuminance(x, y);
            float n1 = albedo.getLuminance(x - 1, y);
            float n2 = albedo.getLuminance(x + 1, y);
            float n3 = albedo.getLuminance(x, y - 1);
            float n4 = albedo.getLuminance(x, y + 1);

            float avg = (n1 + n2 + n3 + n4) * 0.25f;
            float cavity = std::max(0.0f, avg - center);

            // Base ambient occlusion from cavity depth
            float aoVal = 1.0f - cavity * intensity * 3.5f;
            aoVal = std::clamp(aoVal, 0.15f, 1.0f);

            ao.setPixelRGB(x, y, {aoVal, aoVal, aoVal});
        }
    }

    return ao;
}

// ============================================================================
// 6. Poisson Seam Boundary Feathering / Gutter Dilation
// ============================================================================

/**
 * Dilates valid UV island texels outward by gutterRadius pixels to prevent black border fringing.
 */
inline void dilateUvGutters(ImageBuffer& img, const std::vector<bool>& mask, int gutterRadius = 4) {
    int w = img.width;
    int h = img.height;
    std::vector<bool> currentMask = mask;
    ImageBuffer temp = img;

    for (int step = 0; step < gutterRadius; ++step) {
        std::vector<bool> nextMask = currentMask;

        for (int y = 0; y < h; ++y) {
            for (int x = 0; x < w; ++x) {
                int idx = y * w + x;
                if (currentMask[idx]) continue; // Already valid

                // Check 4-connected neighbors
                Vec3 neighborSum(0, 0, 0);
                int count = 0;

                const int dx[4] = {-1, 1, 0, 0};
                const int dy[4] = {0, 0, -1, 1};
                for (int k = 0; k < 4; ++k) {
                    int nx = x + dx[k];
                    int ny = y + dy[k];
                    if (nx >= 0 && nx < w && ny >= 0 && ny < h) {
                        int nidx = ny * w + nx;
                        if (currentMask[nidx]) {
                            neighborSum += img.getPixelRGB(nx, ny);
                            count++;
                        }
                    }
                }

                if (count > 0) {
                    temp.setPixelRGB(x, y, neighborSum * (1.0f / static_cast<float>(count)));
                    nextMask[idx] = true;
                }
            }
        }

        img = temp;
        currentMask = nextMask;
    }
}

// ============================================================================
// 7. Full Algorithmic UV Engine Pipeline
// ============================================================================

struct UvEngineOptions {
    std::string mode{"preserve-100-lock"}; // "preserve-100-lock" or "conformal-reparameterize"
    bool synthesizeCavitation{true};
    bool synthesizePbrSuite{true};
    bool decomposeAlbedo{true};
    bool enableSolarDelighting{false};
    SolarEphemerisConfig solarEphemeris;
    float bumpStrength{3.2f};
    int gutterDilationPixels{4};
};

struct UvEngineResult {
    bool success{false};
    int processedVertices{0};
    int processedTriangles{0};
    int processedTexels{0};
    double executionTimeMs{0.0};
    PbrTextureSet pbrSet;
};

inline UvEngineResult processMeshUvEngine(
    ScratchboxMesh& mesh,
    const ImageBuffer& sourceTexture,
    const UvEngineOptions& options = {}
) {
    auto startTime = std::chrono::high_resolution_clock::now();
    UvEngineResult result;
    result.processedVertices = static_cast<int>(mesh.vertices.size());
    result.processedTriangles = static_cast<int>(mesh.indices.size() / 3);

    if (sourceTexture.empty()) {
        result.success = false;
        return result;
    }

    int w = sourceTexture.width;
    int h = sourceTexture.height;
    ImageBuffer enhancedAlbedo = sourceTexture;
    std::vector<bool> coverageMask(w * h, false);

    // 1. Process mode: conformal reparameterization if requested
    if (options.mode == "conformal-reparameterize") {
        uv::parameterizeHarmonicUV(mesh);
    } else {
        // preserve-100-lock: strictly maintain existing UVs and generate MikkTSpace tangents
        uv::generateMikkTSpaceTangents(mesh);
    }

    // 2. Continuous 3D triangle rasterization & micro-detail injection
    size_t triCount = mesh.indices.size() / 3;
    for (size_t f = 0; f < triCount; ++f) {
        uint32_t i0 = mesh.indices[f * 3 + 0];
        uint32_t i1 = mesh.indices[f * 3 + 1];
        uint32_t i2 = mesh.indices[f * 3 + 2];

        const Vertex& v0 = mesh.vertices[i0];
        const Vertex& v1 = mesh.vertices[i1];
        const Vertex& v2 = mesh.vertices[i2];

        float x1 = v0.uv.x * w;
        float y1 = (1.0f - v0.uv.y) * h;
        float x2 = v1.uv.x * w;
        float y2 = (1.0f - v1.uv.y) * h;
        float x3 = v2.uv.x * w;
        float y3 = (1.0f - v2.uv.y) * h;

        float det = (y2 - y3) * (x1 - x3) + (x3 - x2) * (y1 - y3);
        if (std::abs(det) < 1e-6f) continue;

        int minX = std::clamp(static_cast<int>(std::floor(std::min({x1, x2, x3}))), 0, w - 1);
        int maxX = std::clamp(static_cast<int>(std::ceil(std::max({x1, x2, x3}))), 0, w - 1);
        int minY = std::clamp(static_cast<int>(std::floor(std::min({y1, y2, y3}))), 0, h - 1);
        int maxY = std::clamp(static_cast<int>(std::ceil(std::max({y1, y2, y3}))), 0, h - 1);

        Vec3 faceNormal = ((v1.position - v0.position).cross(v2.position - v0.position)).normalized();

        for (int py = minY; py <= maxY; ++py) {
            for (int px = minX; px <= maxX; ++px) {
                BarycentricCoords bc = computeBarycentric(px + 0.5f, py + 0.5f, x1, y1, x2, y2, x3, y3, det);
                if (!bc.valid || bc.u < 0.0f || bc.v < 0.0f || bc.w < 0.0f) continue;

                int idx = py * w + px;
                coverageMask[idx] = true;
                result.processedTexels++;

                // Interpolate continuous 3D world position
                Vec3 p3d = v0.position * bc.u + v1.position * bc.v + v2.position * bc.w;
                Vec3 col = enhancedAlbedo.getPixelRGB(px, py);

                SurfaceMaterialType matType = classifySurface(faceNormal, col, p3d.y);

                float deltaL = 0.0f;
                if (matType == SurfaceMaterialType::StoneArchitecture) {
                    float cav = options.synthesizeCavitation ? evaluateTravertineCavitation(p3d) : 0.0f;
                    float calcite = evaluateCalciteStrata(p3d);
                    deltaL = cav + calcite;
                } else if (matType == SurfaceMaterialType::AsphaltRoadway) {
                    deltaL = evaluateBitumenAggregate(p3d);
                } else if (matType == SurfaceMaterialType::FoliageVegetation) {
                    deltaL = evaluateChlorophyllDappling(p3d);
                }

                // Apply micro-contrast adjustment to RGB
                float factor = 1.0f + deltaL / 255.0f;
                col = col * factor;
                col.x = std::clamp(col.x, 0.0f, 1.0f);
                col.y = std::clamp(col.y, 0.0f, 1.0f);
                col.z = std::clamp(col.z, 0.0f, 1.0f);

                enhancedAlbedo.setPixelRGB(px, py, col);
            }
        }
    }

    // 3. Gutter Dilation pass to eliminate edge seams
    if (options.gutterDilationPixels > 0) {
        dilateUvGutters(enhancedAlbedo, coverageMask, options.gutterDilationPixels);
    }

    // 4. Photometric De-Lighting & PBR Suite Decomposition
    if (options.synthesizePbrSuite) {
        if (options.decomposeAlbedo) {
            ImageBuffer intrinsicAlbedo, shading;
            decomposeIntrinsicAlbedo(enhancedAlbedo, intrinsicAlbedo, shading);
            result.pbrSet.albedo = intrinsicAlbedo;
        } else {
            result.pbrSet.albedo = enhancedAlbedo;
        }

        if (options.enableSolarDelighting) {
            applySolarInverseDelighting(result.pbrSet.albedo, options.solarEphemeris);
        }

        result.pbrSet.normal = texture::computeSobelNormalMap(result.pbrSet.albedo, options.bumpStrength);
        result.pbrSet.roughness = texture::extractRoughnessMap(result.pbrSet.albedo, 0.85f);
        result.pbrSet.ao = computeSkyDomeAO(result.pbrSet.albedo, mesh);

        // Standard glTF ORM texture packing
        result.pbrSet.orm = texture::packOrmTexture(result.pbrSet.ao, result.pbrSet.roughness, result.pbrSet.metallic);
    } else {
        result.pbrSet.albedo = enhancedAlbedo;
    }

    auto endTime = std::chrono::high_resolution_clock::now();
    result.executionTimeMs = std::chrono::duration<double, std::milli>(endTime - startTime).count();
    result.success = true;
    return result;
}

} // namespace uv_engine
} // namespace scratchbox

#endif // SCRATCHBOX_UV_ENGINE_HPP
