/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

#ifndef SCRATCHBOX_TEXTURE_INDUCER_HPP
#define SCRATCHBOX_TEXTURE_INDUCER_HPP

#include "scratchbox_math.hpp"
#include "scratchbox_texture.hpp"
#include "scratchbox_geometry.hpp"
#include <vector>
#include <cmath>
#include <algorithm>
#include <cstdint>
#include <string>
#include <iostream>

namespace scratchbox {
namespace inducer {

using math::Vec2;
using math::Vec3;
using math::Vec4;
using texture::ImageBuffer;
using texture::PbrTextureSet;
using geometry::ScratchboxMesh;

// ============================================================================
// 1. Architectural Semantic Classification
// ============================================================================

enum class SemanticSurfaceZone {
    GroundPlinth,        // Bottom 5-10% of building, rusticated stone, heavy plinth
    MainShaft,           // Vertical facade walls, masonry, brick, limestone, curtain glass
    Spandrel,            // Horizontal bands between window registers
    CorniceMolding,      // Cantilevered horizontal trims, entablatures, belt courses
    SlopedRoof,          // Mansards, gables, pitched copper/tile shingles (30-75 deg incline)
    HorizontalDeck,      // Flat roofs, penthouse terraces, sidewalks, plazas
    WindowAperture,      // Recessed glass glazing and architectural bronze frames
    MetalFinial          // Spires, crestings, weather vanes, decorative crowns
};

inline const char* getSemanticZoneName(SemanticSurfaceZone zone) {
    switch (zone) {
        case SemanticSurfaceZone::GroundPlinth:    return "GroundPlinth";
        case SemanticSurfaceZone::MainShaft:       return "MainShaft";
        case SemanticSurfaceZone::Spandrel:        return "Spandrel";
        case SemanticSurfaceZone::CorniceMolding:  return "CorniceMolding";
        case SemanticSurfaceZone::SlopedRoof:      return "SlopedRoof";
        case SemanticSurfaceZone::HorizontalDeck:  return "HorizontalDeck";
        case SemanticSurfaceZone::WindowAperture:  return "WindowAperture";
        case SemanticSurfaceZone::MetalFinial:     return "MetalFinial";
        default: return "Unknown";
    }
}

// ============================================================================
// 2. Spatial Autocorrelation & Frequency Induction
// ============================================================================

struct TextureSpatialProfile {
    float dominantPeriodPxX{0.0f};      // Fundamental periodicity (e.g. brick width)
    float dominantPeriodPxY{0.0f};      // Fundamental periodicity (e.g. course height)
    float correlationLengthPxX{16.0f};  // Distance where autocorrelation drops to 1/e
    float correlationLengthPxY{16.0f};
    float aspectRatio{1.0f};            // λx / λy
    bool isPeriodic{false};             // True for brick, tile, ashlar; false for stone/concrete
    float physicalModuleWidthMeters{1.0f};
    float physicalModuleHeightMeters{1.0f};
    float recommendedRepeatX{1.0f};
    float recommendedRepeatY{1.0f};
};

/**
 * Computes 1D spatial autocorrelation along horizontal and vertical scanlines
 * to identify the fundamental unit cell periodicity of any texture map.
 */
inline TextureSpatialProfile analyzeTextureSpatialProfile(const ImageBuffer& img, float targetResolutionMeters = 2.0f) {
    TextureSpatialProfile profile;
    if (img.empty()) return profile;

    const int W = img.width;
    const int H = img.height;
    const int maxLagX = std::min(W / 2, 256);
    const int maxLagY = std::min(H / 2, 256);

    // Compute mean luminance and variance
    double sumL = 0.0;
    double sumL2 = 0.0;
    const int totalPixels = W * H;

    for (int y = 0; y < H; ++y) {
        for (int x = 0; x < W; ++x) {
            float lum = img.getLuminance(x, y);
            sumL += lum;
            sumL2 += lum * lum;
        }
    }

    const double meanL = sumL / totalPixels;
    const double varL = std::max(1e-7, (sumL2 / totalPixels) - (meanL * meanL));

    // Autocorrelation along X
    std::vector<float> autocorrX(maxLagX, 0.0f);
    for (int lag = 0; lag < maxLagX; ++lag) {
        double cov = 0.0;
        int count = 0;
        for (int y = 0; y < H; y += 4) { // Subsample scanlines for high throughput
            for (int x = 0; x < W - lag; x += 2) {
                float l1 = img.getLuminance(x, y) - static_cast<float>(meanL);
                float l2 = img.getLuminance(x + lag, y) - static_cast<float>(meanL);
                cov += l1 * l2;
                count++;
            }
        }
        autocorrX[lag] = static_cast<float>(cov / (count * varL));
    }

    // Autocorrelation along Y
    std::vector<float> autocorrY(maxLagY, 0.0f);
    for (int lag = 0; lag < maxLagY; ++lag) {
        double cov = 0.0;
        int count = 0;
        for (int y = 0; y < H - lag; y += 2) {
            for (int x = 0; x < W; x += 4) {
                float l1 = img.getLuminance(x, y) - static_cast<float>(meanL);
                float l2 = img.getLuminance(x, y + lag) - static_cast<float>(meanL);
                cov += l1 * l2;
                count++;
            }
        }
        autocorrY[lag] = static_cast<float>(cov / (count * varL));
    }

    // Find correlation lengths (where autocorr drops below 1/e ≈ 0.368)
    const float oneOverE = 1.0f / std::exp(1.0f);
    for (int lag = 1; lag < maxLagX; ++lag) {
        if (autocorrX[lag] < oneOverE) {
            profile.correlationLengthPxX = static_cast<float>(lag);
            break;
        }
    }
    for (int lag = 1; lag < maxLagY; ++lag) {
        if (autocorrY[lag] < oneOverE) {
            profile.correlationLengthPxY = static_cast<float>(lag);
            break;
        }
    }

    // Find periodic peaks after local minima
    auto findPeriodicPeak = [](const std::vector<float>& ac) -> float {
        bool passedValley = false;
        float valleyVal = 1.0f;
        for (size_t lag = 2; lag < ac.size() - 2; ++lag) {
            if (!passedValley) {
                if (ac[lag] < ac[lag - 1] && ac[lag] <= ac[lag + 1]) {
                    passedValley = true;
                    valleyVal = ac[lag];
                }
            } else {
                if (ac[lag] > ac[lag - 1] && ac[lag] >= ac[lag + 1]) {
                    if (ac[lag] - valleyVal > 0.08f) { // Distinct periodic peak
                        return static_cast<float>(lag);
                    }
                }
            }
        }
        return 0.0f;
    };

    profile.dominantPeriodPxX = findPeriodicPeak(autocorrX);
    profile.dominantPeriodPxY = findPeriodicPeak(autocorrY);

    if (profile.dominantPeriodPxX > 0.0f && profile.dominantPeriodPxY > 0.0f) {
        profile.isPeriodic = true;
        profile.aspectRatio = profile.dominantPeriodPxX / profile.dominantPeriodPxY;

        // Architectural module induction based on aspect ratio
        if (profile.aspectRatio > 2.8f) {
            // Elongated Roman brick or modular brick stretcher course (~1.5" x 8-12")
            profile.physicalModuleWidthMeters = 0.25f;
            profile.physicalModuleHeightMeters = 0.065f;
        } else if (profile.aspectRatio > 1.4f) {
            // Ashlar masonry block (~12" x 24")
            profile.physicalModuleWidthMeters = 0.60f;
            profile.physicalModuleHeightMeters = 0.35f;
        } else if (profile.aspectRatio < 0.6f) {
            // Vertical standing seams or ribbed siding
            profile.physicalModuleWidthMeters = 0.40f;
            profile.physicalModuleHeightMeters = 1.20f;
        } else {
            // Square ceramic tile, paver, or terracotta shingle (~10" x 10")
            profile.physicalModuleWidthMeters = 0.30f;
            profile.physicalModuleHeightMeters = 0.30f;
        }

        // Calibrate texture repeats: how many repeats per target 2.0m span
        profile.recommendedRepeatX = targetResolutionMeters / profile.physicalModuleWidthMeters;
        profile.recommendedRepeatY = targetResolutionMeters / profile.physicalModuleHeightMeters;
    } else {
        // Stochastic / continuous organic texture (granite, marble, concrete, gravel)
        profile.isPeriodic = false;
        profile.aspectRatio = 1.0f;
        profile.physicalModuleWidthMeters = targetResolutionMeters;
        profile.physicalModuleHeightMeters = targetResolutionMeters;
        profile.recommendedRepeatX = 1.0f;
        profile.recommendedRepeatY = 1.0f;
    }

    return profile;
}

// ============================================================================
// 3. Adaptive Normal Scale Multiplier Calibration
// ============================================================================

struct NormalScaleAnalysis {
    float gradientVariance{0.0f};
    float stepEdgeEnergy{0.0f};
    float recommendedNormalScale{1.0f};
    float recommendedAoIntensity{0.85f};
};

/**
 * Evaluates normal map gradient energy and step edge sharpness to calculate
 * the ideal Three.js normalScale multiplier (1.0 to 3.2).
 */
inline NormalScaleAnalysis calibrateNormalScale(const ImageBuffer& normMap) {
    NormalScaleAnalysis analysis;
    if (normMap.empty()) return analysis;

    const int W = normMap.width;
    const int H = normMap.height;
    double sumGradSq = 0.0;
    double sumStep = 0.0;
    int count = 0;

    for (int y = 1; y < H - 1; y += 2) {
        for (int x = 1; x < W - 1; x += 2) {
            Vec3 n = normMap.getPixelRGB(x, y);
            // Remap [0, 1] to tangent vector [-1, 1]
            float nx = n.x * 2.0f - 1.0f;
            float ny = n.y * 2.0f - 1.0f;

            float gradSq = nx * nx + ny * ny;
            sumGradSq += gradSq;

            // Step difference with neighbor
            Vec3 nRight = normMap.getPixelRGB(x + 1, y);
            float diffX = std::abs((nRight.x * 2.0f - 1.0f) - nx);
            sumStep += diffX;

            count++;
        }
    }

    analysis.gradientVariance = static_cast<float>(sumGradSq / std::max(1, count));
    analysis.stepEdgeEnergy = static_cast<float>(sumStep / std::max(1, count));

    // Target architectural relief depth index (empirical constant κ ≈ 0.65 for architectural sunlight depth)
    const float kappa = 0.65f;
    const float rmsGrad = std::sqrt(analysis.gradientVariance + 1e-5f);

    // Dynamic scale formula: shallow micro-textures are boosted; already-rugged normals stay near 1.0
    float rawScale = (kappa / rmsGrad) * (1.0f + 0.45f * std::clamp(analysis.stepEdgeEnergy * 4.0f, 0.0f, 1.0f));
    analysis.recommendedNormalScale = std::clamp(rawScale, 1.0f, 3.2f);

    // AO intensity is inversely correlated with base specular to maintain contrast
    analysis.recommendedAoIntensity = std::clamp(0.65f + 0.45f * rmsGrad, 0.60f, 1.0f);

    return analysis;
}

// ============================================================================
// 4. Image-Space Horizon-Based Micro-Cavity Ambient Occlusion (HBAO)
// ============================================================================

/**
 * Synthesizes a 2K micro-cavity ambient occlusion map from any normal or height map
 * using 8-directional radial horizon raymarching in image space.
 */
inline ImageBuffer generateMicroCavityAo(const ImageBuffer& normMap, int radiusPixels = 12) {
    if (normMap.empty()) return ImageBuffer();

    const int W = normMap.width;
    const int H = normMap.height;
    ImageBuffer aoMap(W, H, 1);

    // Reconstruct virtual heightfield by integrating normal slopes
    std::vector<float> virtualHeight(W * H, 0.0f);
    for (int y = 0; y < H; ++y) {
        for (int x = 0; x < W; ++x) {
            Vec3 n = normMap.getPixelRGB(x, y);
            float nx = n.x * 2.0f - 1.0f;
            float ny = n.y * 2.0f - 1.0f;
            // Height gradient approximation
            virtualHeight[y * W + x] = 0.5f - (nx * 0.5f + ny * 0.5f);
        }
    }

    const int dirs = 8;
    const float angleStep = 2.0f * 3.14159265f / dirs;

    for (int y = 0; y < H; ++y) {
        for (int x = 0; x < W; ++x) {
            float centerH = virtualHeight[y * W + x];
            float totalOcclusion = 0.0f;

            for (int d = 0; d < dirs; ++d) {
                float phi = d * angleStep;
                float dirX = std::cos(phi);
                float dirY = std::sin(phi);

                float maxSinHorizon = 0.0f;

                for (int r = 2; r <= radiusPixels; r += 2) {
                    int sx = static_cast<int>(x + dirX * r + 0.5f);
                    int sy = static_cast<int>(y + dirY * r + 0.5f);

                    if (sx < 0 || sx >= W || sy < 0 || sy >= H) break;

                    float sampleH = virtualHeight[sy * W + sx];
                    float deltaH = sampleH - centerH;
                    float dist = static_cast<float>(r);

                    float tanAngle = deltaH / dist;
                    float sinAngle = tanAngle / std::sqrt(1.0f + tanAngle * tanAngle);
                    if (sinAngle > maxSinHorizon) {
                        maxSinHorizon = sinAngle;
                    }
                }
                totalOcclusion += maxSinHorizon;
            }

            float aoVal = std::clamp(1.0f - (totalOcclusion / dirs) * 1.35f, 0.05f, 1.0f);
            uint8_t byteVal = static_cast<uint8_t>(aoVal * 255.0f);
            aoMap.data[y * W + x] = byteVal;
        }
    }

    return aoMap;
}

// ============================================================================
// 5. Semantic Surface Zone Classifier for Arbitrary 3D Meshes
// ============================================================================

struct SemanticMeshPartition {
    std::vector<SemanticSurfaceZone> faceZones;
    std::vector<float> metricUvRepeatsU;
    std::vector<float> metricUvRepeatsV;
    std::vector<float> normalScaleMultipliers;
    size_t groundPlinthFaces{0};
    size_t mainShaftFaces{0};
    size_t slopedRoofFaces{0};
    size_t horizontalDeckFaces{0};
    size_t corniceFaces{0};
};

/**
 * Classifies every triangle of an arbitrary building mesh into architectural semantic
 * zones and computes the corresponding metric UV repeat and normal scale parameters.
 * Supports patternDensityMultiplier to apply textures in smaller, finer patterns.
 */
inline SemanticMeshPartition classifyMeshAndInduceParameters(
    const ScratchboxMesh& mesh,
    float groundDatumY = 0.0f,
    float plinthThresholdMeters = 3.8f,
    float patternDensityMultiplier = 3.0f // Multiplier for smaller, tighter texture patterns
) {
    SemanticMeshPartition partition;
    const size_t numTriangles = mesh.indices.size() / 3;
    partition.faceZones.resize(numTriangles);
    partition.metricUvRepeatsU.resize(numTriangles);
    partition.metricUvRepeatsV.resize(numTriangles);
    partition.normalScaleMultipliers.resize(numTriangles);

    // Compute bounding box
    float minY = 1e9f, maxY = -1e9f;
    for (const auto& v : mesh.vertices) {
        minY = std::min(minY, v.position.y);
        maxY = std::max(maxY, v.position.y);
    }
    const float totalHeight = std::max(1.0f, maxY - minY);

    const float densityFactor = std::max(0.2f, patternDensityMultiplier / 3.0f);

    for (size_t t = 0; t < numTriangles; ++t) {
        uint32_t i0 = mesh.indices[t * 3];
        uint32_t i1 = mesh.indices[t * 3 + 1];
        uint32_t i2 = mesh.indices[t * 3 + 2];

        const Vec3& p0 = mesh.vertices[i0].position;
        const Vec3& p1 = mesh.vertices[i1].position;
        const Vec3& p2 = mesh.vertices[i2].position;

        // Centroid & normal
        Vec3 centroid = (p0 + p1 + p2) * (1.0f / 3.0f);
        Vec3 edge1 = p1 - p0;
        Vec3 edge2 = p2 - p0;
        Vec3 faceNorm = edge1.cross(edge2);
        if (faceNorm.lengthSquared() > 1e-6f) faceNorm = faceNorm.normalized();

        Vec3 avgNorm = mesh.vertices[i0].normal + mesh.vertices[i1].normal + mesh.vertices[i2].normal;
        if (avgNorm.lengthSquared() > 1e-6f) avgNorm = avgNorm.normalized();
        else avgNorm = faceNorm;

        float ny = avgNorm.y;
        float normHeight = (centroid.y - minY) / totalHeight;
        float triMinY = std::min({p0.y, p1.y, p2.y});

        SemanticSurfaceZone zone;
        float repU = 1.0f;
        float repV = 1.0f;
        float nScale = 2.0f;

        if (triMinY <= minY + plinthThresholdMeters && std::abs(ny) < 0.40f && centroid.y <= minY + plinthThresholdMeters * 2.0f) {
            // Heavy rusticated stone plinth: smaller, tighter ashlar blocks (~0.22m courses)
            zone = SemanticSurfaceZone::GroundPlinth;
            repU = 4.5f * densityFactor;
            repV = 4.5f * densityFactor;
            nScale = 3.0f; // High normal scale for deep horizontal rustication
            partition.groundPlinthFaces++;
        } else if (std::abs(ny) > 0.70f) {
            // Horizontal upper roof deck, penthouse terrace, or sidewalk pavers (~0.25m tiles)
            zone = SemanticSurfaceZone::HorizontalDeck;
            repU = 4.0f * densityFactor;
            repV = 4.0f * densityFactor;
            nScale = 1.8f;
            partition.horizontalDeckFaces++;
        } else if (ny > 0.30f && ny <= 0.70f && normHeight > 0.65f) {
            // Sloped French Mansard roof: fine copper shingles & standing seams (~0.35m x 0.31m)
            zone = SemanticSurfaceZone::SlopedRoof;
            repU = 2.8f * densityFactor;
            repV = 3.2f * densityFactor;
            nScale = 2.6f; // Standing seam specular highlight relief
            partition.slopedRoofFaces++;
        } else if (std::abs(ny) < 0.35f) {
            // Main vertical architectural facade: fine Roman brick courses (~0.21m x 0.044m)
            zone = SemanticSurfaceZone::MainShaft;
            repU = 4.8f * densityFactor;
            repV = 22.5f * densityFactor; // Authentic dense brick coursing (smaller pattern)
            nScale = 2.8f; // Aggressive normal scale for raked mortar shadows
            partition.mainShaftFaces++;
        } else {
            // Cornices, moldings, entablatures, belt courses: fine dentil relief
            zone = SemanticSurfaceZone::CorniceMolding;
            repU = 5.0f * densityFactor;
            repV = 5.0f * densityFactor;
            nScale = 2.2f;
            partition.corniceFaces++;
        }

        partition.faceZones[t] = zone;
        partition.metricUvRepeatsU[t] = repU;
        partition.metricUvRepeatsV[t] = repV;
        partition.normalScaleMultipliers[t] = nScale;
    }

    return partition;
}

} // namespace inducer
} // namespace scratchbox

#endif // SCRATCHBOX_TEXTURE_INDUCER_HPP
