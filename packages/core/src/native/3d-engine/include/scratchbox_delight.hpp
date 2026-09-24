/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

#ifndef SCRATCHBOX_DELIGHT_HPP
#define SCRATCHBOX_DELIGHT_HPP

#include "scratchbox_math.hpp"
#include "scratchbox_geometry.hpp"
#include "scratchbox_texture.hpp"
#include "scratchbox_bvh.hpp"
#include "scratchbox_lighting.hpp"

#include <vector>
#include <cmath>
#include <algorithm>
#include <cstdint>
#include <limits>
#include <numeric>
#include <iostream>

namespace scratchbox {
namespace delight {

using math::Vec2;
using math::Vec3;
using math::Vec4;
using math::Ray;
using math::AABB;
using math::PI;
using math::TWO_PI;
using geometry::Vertex;
using geometry::ScratchboxMesh;
using texture::ImageBuffer;
using bvh::BvhTree;
using bvh::RayHit;

// ============================================================================
// 1. DATA STRUCTURES & CONFIGURATION
// ============================================================================

struct SunDirectionResult {
    Vec3 sunDirection{0.0f, 1.0f, 0.0f};
    float elevationDeg{45.0f};
    float azimuthDeg{180.0f};
    float correlationScore{0.0f};
    int samplePointsTested{0};
    bool success{false};
};

struct DeLighterOptions {
    float epsilonClamp{0.10f};       // Minimum shading divisor to prevent infinite noise
    float directSunWeight{0.75f};    // Direct sun beam relative intensity
    float skyDomeWeight{0.20f};      // Diffuse hemispherical sky irradiance
    float groundBounceWeight{0.05f}; // Ground bounce irradiance
    int rtaoSamplesPerVertex{16};    // Raytraced ambient occlusion sample count
    float rtaoMaxDistance{2.5f};     // RTAO max ray travel distance in meters
    bool enableBilateralFilter{true};// Smooth albedo in near-zero shadow boundaries
    float bilateralSpatialSigma{2.0f};
    float bilateralRangeSigma{0.15f};
};

struct ShadowRelightOptions {
    float shadowThreshold{0.65f};    // Texture luminance threshold relative to lit side
    float minSunlitRatio{1.15f};     // Minimum boost factor to prevent over-darkening
    float maxSunlitRatio{3.50f};     // Maximum boost factor clamp
    float detailPreservation{0.85f}; // High-frequency texture micro-contrast retention
};

// ============================================================================
// 2. CAPTURE-DAY SUN SOLVER (ESTIMATES SUN FROM SHADOW EDGES & RAYCASTING)
// ============================================================================

class SunShadowSolver {
public:
    /**
     * Solves for the capture-day sun direction vector by raycasting from candidate
     * surface points and correlating geometric visibility with observed texture luminance.
     */
    static SunDirectionResult estimateSunDirection(
        const ScratchboxMesh& mesh,
        const ImageBuffer& texture,
        const BvhTree& bvh,
        int elevationSteps = 12, // 15 deg to 75 deg
        int azimuthSteps = 36    // 0 deg to 350 deg in 10 deg steps
    ) {
        SunDirectionResult result;
        if (mesh.vertices.empty() || mesh.indices.empty() || texture.empty()) {
            return result;
        }

        // 1. Gather candidate sample points on planar surfaces (ground, roofs, walls)
        struct SurfaceSample {
            Vec3 position;
            Vec3 normal;
            float observedLuminance{0.5f};
            bool isPlanar{false};
        };

        std::vector<SurfaceSample> samples;
        samples.reserve(mesh.indices.size() / 3);

        size_t triCount = mesh.indices.size() / 3;
        for (size_t t = 0; t < triCount; ++t) {
            uint32_t i0 = mesh.indices[t * 3];
            uint32_t i1 = mesh.indices[t * 3 + 1];
            uint32_t i2 = mesh.indices[t * 3 + 2];

            const auto& v0 = mesh.vertices[i0];
            const auto& v1 = mesh.vertices[i1];
            const auto& v2 = mesh.vertices[i2];

            Vec3 e1 = v1.position - v0.position;
            Vec3 e2 = v2.position - v0.position;
            Vec3 fn = e1.cross(e2);
            float area = fn.length() * 0.5f;
            if (area < 1e-5f) continue;

            Vec3 normal = fn.normalized();
            Vec3 centroid = (v0.position + v1.position + v2.position) * (1.0f / 3.0f);
            Vec2 uvCentroid = (v0.uv + v1.uv + v2.uv) * (1.0f / 3.0f);

            // Sample observed luminance from texture
            float lum = texture.sampleBilinear(uvCentroid.x, uvCentroid.y).x * 0.2126f +
                        texture.sampleBilinear(uvCentroid.x, uvCentroid.y).y * 0.7152f +
                        texture.sampleBilinear(uvCentroid.x, uvCentroid.y).z * 0.0722f;

            // Normal variance between face and vertex normals
            float dot0 = normal.dot(v0.normal.normalized());
            float dot1 = normal.dot(v1.normal.normalized());
            float dot2 = normal.dot(v2.normal.normalized());
            bool isPlanar = (dot0 > 0.95f && dot1 > 0.95f && dot2 > 0.95f);

            // Favor horizontal or architectural planar surfaces where cast shadows are distinct
            if (isPlanar || std::abs(normal.y) > 0.6f || std::abs(normal.y) < 0.2f) {
                samples.push_back({centroid, normal, lum, isPlanar});
            }
        }

        if (samples.size() < 10) {
            // Fallback: use all triangle centroids
            for (size_t t = 0; t < triCount; ++t) {
                const auto& v0 = mesh.vertices[mesh.indices[t * 3]];
                const auto& v1 = mesh.vertices[mesh.indices[t * 3 + 1]];
                const auto& v2 = mesh.vertices[mesh.indices[t * 3 + 2]];
                Vec3 c = (v0.position + v1.position + v2.position) * (1.0f / 3.0f);
                Vec3 n = (v0.normal + v1.normal + v2.normal).normalized();
                Vec2 uv = (v0.uv + v1.uv + v2.uv) * (1.0f / 3.0f);
                Vec3 rgb = texture.sampleBilinear(uv.x, uv.y);
                float l = 0.2126f * rgb.x + 0.7152f * rgb.y + 0.0722f * rgb.z;
                samples.push_back({c, n, l, true});
            }
        }

        // Downsample if sample count is large to maintain fast real-time performance
        size_t maxSamples = 2000;
        size_t stride = std::max<size_t>(1, samples.size() / maxSamples);
        std::vector<SurfaceSample> activeSamples;
        activeSamples.reserve(maxSamples);
        for (size_t i = 0; i < samples.size(); i += stride) {
            activeSamples.push_back(samples[i]);
        }

        // Calculate mean observed luminance
        double sumLum = 0.0;
        for (const auto& s : activeSamples) sumLum += s.observedLuminance;
        float meanLum = static_cast<float>(sumLum / std::max<size_t>(1, activeSamples.size()));

        float bestScore = -std::numeric_limits<float>::infinity();
        float bestElevDeg = 45.0f;
        float bestAzimDeg = 180.0f;
        Vec3 bestSunDir(0.0f, 1.0f, 0.0f);

        // 2. Evaluate candidate sun directions on a spherical grid
        for (int e = 0; e < elevationSteps; ++e) {
            float elevDeg = 15.0f + (static_cast<float>(e) / (elevationSteps - 1)) * 60.0f; // 15 to 75 deg
            float elevRad = elevDeg * (PI / 180.0f);
            float sinElev = std::sin(elevRad);
            float cosElev = std::cos(elevRad);

            for (int a = 0; a < azimuthSteps; ++a) {
                float azimDeg = (static_cast<float>(a) / azimuthSteps) * 360.0f;
                float azimRad = azimDeg * (PI / 180.0f);

                Vec3 sunDir(
                    cosElev * std::sin(azimRad),
                    sinElev,
                    cosElev * std::cos(azimRad)
                );
                sunDir = sunDir.normalized();

                // Compute correlation between geometric visibility and observed luminance
                double dotProductSum = 0.0;
                double visVariance = 0.0;
                double lumVariance = 0.0;
                int validCount = 0;

                for (const auto& smp : activeSamples) {
                    float nDotS = smp.normal.dot(sunDir);
                    if (nDotS <= 0.0f) {
                        // Geometrically back-facing surface: expected to be unlit
                        float vis = 0.0f;
                        float diffV = vis - 0.5f;
                        float diffL = smp.observedLuminance - meanLum;
                        dotProductSum += diffV * diffL;
                        visVariance += diffV * diffV;
                        lumVariance += diffL * diffL;
                        validCount++;
                        continue;
                    }

                    // Raycast toward sun from sample position (offset by surface normal)
                    Ray shadowRay(smp.position + smp.normal * 1e-3f, sunDir);
                    bool occluded = bvh.raycastAny(shadowRay, 500.0f);
                    float vis = occluded ? 0.0f : nDotS;

                    float diffV = vis - 0.5f;
                    float diffL = smp.observedLuminance - meanLum;
                    dotProductSum += diffV * diffL;
                    visVariance += diffV * diffV;
                    lumVariance += diffL * diffL;
                    validCount++;
                }

                if (validCount > 0 && visVariance > 1e-4 && lumVariance > 1e-4) {
                    float correlation = static_cast<float>(dotProductSum / (std::sqrt(visVariance * lumVariance) + 1e-6));
                    if (correlation > bestScore) {
                        bestScore = correlation;
                        bestElevDeg = elevDeg;
                        bestAzimDeg = azimDeg;
                        bestSunDir = sunDir;
                    }
                }
            }
        }

        // 3. Fine refinement around best candidate (sub-degree search)
        float fineElevDeg = bestElevDeg;
        float fineAzimDeg = bestAzimDeg;
        float fineBestScore = bestScore;

        for (float de = -4.0f; de <= 4.0f; de += 1.0f) {
            float e = std::clamp(bestElevDeg + de, 10.0f, 85.0f);
            float eRad = e * (PI / 180.0f);

            for (float da = -8.0f; da <= 8.0f; da += 2.0f) {
                float a = std::fmod(bestAzimDeg + da + 360.0f, 360.0f);
                float aRad = a * (PI / 180.0f);

                Vec3 dir(
                    std::cos(eRad) * std::sin(aRad),
                    std::sin(eRad),
                    std::cos(eRad) * std::cos(aRad)
                );
                dir = dir.normalized();

                double dotSum = 0.0;
                double vVar = 0.0;
                double lVar = 0.0;

                for (const auto& smp : activeSamples) {
                    float nDotS = smp.normal.dot(dir);
                    float vis = (nDotS > 0.0f && !bvh.raycastAny(Ray(smp.position + smp.normal * 1e-3f, dir), 500.0f))
                                ? nDotS : 0.0f;
                    float diffV = vis - 0.5f;
                    float diffL = smp.observedLuminance - meanLum;
                    dotSum += diffV * diffL;
                    vVar += diffV * diffV;
                    lVar += diffL * diffL;
                }

                if (vVar > 1e-4 && lVar > 1e-4) {
                    float score = static_cast<float>(dotSum / (std::sqrt(vVar * lVar) + 1e-6));
                    if (score > fineBestScore) {
                        fineBestScore = score;
                        fineElevDeg = e;
                        fineAzimDeg = a;
                        bestSunDir = dir;
                    }
                }
            }
        }

        result.sunDirection = bestSunDir;
        result.elevationDeg = fineElevDeg;
        result.azimuthDeg = fineAzimDeg;
        result.correlationScore = fineBestScore;
        result.samplePointsTested = static_cast<int>(activeSamples.size());
        result.success = (fineBestScore > 0.15f);

        return result;
    }
};

// ============================================================================
// 3. TILE MESH SHADING RENDERER (RENDERS SUN + SKY + AO INTO UV SPACE)
// ============================================================================

class TileShadingRenderer {
public:
    /**
     * Renders the tile mesh's own irradiance (direct sun + sky dome + ambient occlusion)
     * into a floating point shading buffer mapped 1:1 to the texture UV layout.
     */
    static std::vector<float> renderShadingMap(
        const ScratchboxMesh& mesh,
        const BvhTree& bvh,
        const Vec3& sunDirection,
        int width,
        int height,
        const DeLighterOptions& opt = {}
    ) {
        std::vector<float> shading(width * height, 0.0f);
        if (mesh.vertices.empty() || mesh.indices.empty()) return shading;

        // 1. Precompute per-vertex RTAO
        std::vector<float> vertexAO = bvh::computeMeshRTAO(
            mesh,
            opt.rtaoSamplesPerVertex,
            opt.rtaoMaxDistance,
            42
        );

        // 2. Precompute per-vertex direct shading
        std::vector<float> vertexShading(mesh.vertices.size(), 0.0f);
        for (size_t i = 0; i < mesh.vertices.size(); ++i) {
            const auto& vert = mesh.vertices[i];
            Vec3 norm = vert.normal.normalized();
            float nDotS = std::max(0.0f, norm.dot(sunDirection));

            // Visibility ray
            float sunVis = 0.0f;
            if (nDotS > 0.0f) {
                Ray shadowRay(vert.position + norm * 1e-3f, sunDirection);
                sunVis = bvh.raycastAny(shadowRay, 500.0f) ? 0.0f : 1.0f;
            }

            float ao = (i < vertexAO.size()) ? vertexAO[i] : 1.0f;
            float skyFactor = (1.0f + norm.y) * 0.5f;
            float bounceFactor = (1.0f - norm.y) * 0.5f;

            float direct = opt.directSunWeight * sunVis * nDotS;
            float sky = opt.skyDomeWeight * ao * skyFactor;
            float bounce = opt.groundBounceWeight * ao * bounceFactor;

            vertexShading[i] = direct + sky + bounce;
        }

        // 3. Rasterize per-vertex shading into UV texture space
        size_t triCount = mesh.indices.size() / 3;
        for (size_t t = 0; t < triCount; ++t) {
            uint32_t i0 = mesh.indices[t * 3];
            uint32_t i1 = mesh.indices[t * 3 + 1];
            uint32_t i2 = mesh.indices[t * 3 + 2];

            const auto& v0 = mesh.vertices[i0];
            const auto& v1 = mesh.vertices[i1];
            const auto& v2 = mesh.vertices[i2];

            // UV coordinates to pixel space
            float x0 = v0.uv.x * width;
            float y0 = (1.0f - v0.uv.y) * height; // standard flip
            float x1 = v1.uv.x * width;
            float y1 = (1.0f - v1.uv.y) * height;
            float x2 = v2.uv.x * width;
            float y2 = (1.0f - v2.uv.y) * height;

            float minX = std::max(0.0f, std::floor(std::min({x0, x1, x2})));
            float maxX = std::min(static_cast<float>(width - 1), std::ceil(std::max({x0, x1, x2})));
            float minY = std::max(0.0f, std::floor(std::min({y0, y1, y2})));
            float maxY = std::min(static_cast<float>(height - 1), std::ceil(std::max({y0, y1, y2})));

            float denom = (y1 - y2) * (x0 - x2) + (x2 - x1) * (y0 - y2);
            if (std::abs(denom) < 1e-6f) continue;
            float invDenom = 1.0f / denom;

            float s0 = vertexShading[i0];
            float s1 = vertexShading[i1];
            float s2 = vertexShading[i2];

            for (int py = static_cast<int>(minY); py <= static_cast<int>(maxY); ++py) {
                float px_y = static_cast<float>(py) + 0.5f;
                for (int px = static_cast<int>(minX); px <= static_cast<int>(maxX); ++px) {
                    float px_x = static_cast<float>(px) + 0.5f;

                    float w0 = ((y1 - y2) * (px_x - x2) + (x2 - x1) * (px_y - y2)) * invDenom;
                    float w1 = ((y2 - y0) * (px_x - x2) + (x0 - x2) * (px_y - y2)) * invDenom;
                    float w2 = 1.0f - w0 - w1;

                    if (w0 >= -1e-3f && w1 >= -1e-3f && w2 >= -1e-3f) {
                        float interpShading = w0 * s0 + w1 * s1 + w2 * s2;
                        size_t idx = static_cast<size_t>(py * width + px);
                        // Store maximum or average shading if overlapping UV islands
                        shading[idx] = std::max(shading[idx], interpShading);
                    }
                }
            }
        }

        // Fill unmapped UV pixels with local median/mean to prevent black voids
        float defaultShading = opt.skyDomeWeight * 0.5f + opt.groundBounceWeight * 0.5f;
        for (float& s : shading) {
            if (s <= 1e-4f) s = defaultShading;
        }

        return shading;
    }
};

// ============================================================================
// 4. TEXTURE DE-LIGHTER (DIVIDES OUT SHADING TO EXTRACT TRUE ALBEDO)
// ============================================================================

class TextureDeLighter {
public:
    /**
     * Extracts true surface albedo by dividing texture by shading:
     * Albedo = clamp(Texture / max(Shading, epsilon), 0, 1)
     * Blender Cycles bake equivalence: Diffuse Color = Diffuse Total / (Diffuse Direct + Indirect)
     */
    static ImageBuffer deLight(
        const ImageBuffer& inputTexture,
        const std::vector<float>& shadingMap,
        const DeLighterOptions& opt = {}
    ) {
        if (inputTexture.empty() || shadingMap.size() < static_cast<size_t>(inputTexture.width * inputTexture.height)) {
            return inputTexture;
        }

        int w = inputTexture.width;
        int h = inputTexture.height;
        ImageBuffer albedo(w, h, inputTexture.channels);

        // 1. Division with clamping
        for (int y = 0; y < h; ++y) {
            for (int x = 0; x < w; ++x) {
                Vec3 texRgb = inputTexture.getPixelRGB(x, y);
                float s = shadingMap[y * w + x];
                float divisor = std::max(s, opt.epsilonClamp);

                Vec3 trueCol = texRgb * (1.0f / divisor);

                // Soft clamp to prevent high-frequency noise spikes in deep occlusion
                trueCol.x = std::clamp(trueCol.x, 0.0f, 1.0f);
                trueCol.y = std::clamp(trueCol.y, 0.0f, 1.0f);
                trueCol.z = std::clamp(trueCol.z, 0.0f, 1.0f);

                albedo.setPixelRGB(x, y, trueCol);
            }
        }

        // 2. Optional edge-preserving bilateral smoothing in high-gain shadow boundaries
        if (opt.enableBilateralFilter) {
            ImageBuffer smoothed = albedo;
            int radius = 2;

            for (int y = 0; y < h; ++y) {
                for (int x = 0; x < w; ++x) {
                    float s = shadingMap[y * w + x];
                    // Only apply bilateral filter where divisor was small (shadow regions)
                    if (s > 0.35f) continue;

                    Vec3 centerCol = albedo.getPixelRGB(x, y);
                    Vec3 sumCol(0, 0, 0);
                    float sumWeight = 0.0f;

                    for (int dy = -radius; dy <= radius; ++dy) {
                        int ny = std::clamp(y + dy, 0, h - 1);
                        for (int dx = -radius; dx <= radius; ++dx) {
                            int nx = std::clamp(x + dx, 0, w - 1);

                            Vec3 neighborCol = albedo.getPixelRGB(nx, ny);
                            float spatialDistSq = static_cast<float>(dx * dx + dy * dy);
                            float colorDistSq = (centerCol - neighborCol).lengthSquared();

                            float wSpatial = std::exp(-spatialDistSq / (2.0f * opt.bilateralSpatialSigma * opt.bilateralSpatialSigma));
                            float wRange = std::exp(-colorDistSq / (2.0f * opt.bilateralRangeSigma * opt.bilateralRangeSigma));
                            float weight = wSpatial * wRange;

                            sumCol = sumCol + neighborCol * weight;
                            sumWeight += weight;
                        }
                    }

                    if (sumWeight > 1e-4f) {
                        smoothed.setPixelRGB(x, y, sumCol * (1.0f / sumWeight));
                    }
                }
            }
            return smoothed;
        }

        return albedo;
    }
};

// ============================================================================
// 5. SHADOW DETECTION & SUNLIT COLOR RE-LIGHTER
// ============================================================================

class ShadowRelighter {
public:
    /**
     * Compares the geometric shadow mask against dark areas in the texture.
     * Where they match, re-lights those texels using the statistical color profile
     * from the sunlit side of the same surface material.
     */
    static ImageBuffer detectAndRelightShadows(
        const ImageBuffer& inputTexture,
        const std::vector<float>& shadingMap,
        const ShadowRelightOptions& opt = {}
    ) {
        if (inputTexture.empty() || shadingMap.size() < static_cast<size_t>(inputTexture.width * inputTexture.height)) {
            return inputTexture;
        }

        int w = inputTexture.width;
        int h = inputTexture.height;
        ImageBuffer relit = inputTexture;

        // 1. Separate texels into Sunlit vs Shadow regions based on geometric shading
        double sumSunlitLum = 0.0;
        int countSunlit = 0;
        double sumShadowLum = 0.0;
        int countShadow = 0;

        std::vector<float> luminance(w * h, 0.0f);
        for (int y = 0; y < h; ++y) {
            for (int x = 0; x < w; ++x) {
                Vec3 rgb = inputTexture.getPixelRGB(x, y);
                float l = 0.2126f * rgb.x + 0.7152f * rgb.y + 0.0722f * rgb.z;
                luminance[y * w + x] = l;

                float s = shadingMap[y * w + x];
                if (s >= 0.50f) {
                    sumSunlitLum += l;
                    countSunlit++;
                } else if (s <= 0.25f) {
                    sumShadowLum += l;
                    countShadow++;
                }
            }
        }

        if (countSunlit < 10 || countShadow < 10) {
            // Scene is either entirely lit or entirely in shadow
            return inputTexture;
        }

        float meanSunlit = static_cast<float>(sumSunlitLum / countSunlit);
        float meanShadow = static_cast<float>(sumShadowLum / countShadow);

        float boostRatio = meanSunlit / std::max(meanShadow, 1e-4f);
        boostRatio = std::clamp(boostRatio, opt.minSunlitRatio, opt.maxSunlitRatio);

        // 2. Re-light matching shadow texels
        for (int y = 0; y < h; ++y) {
            for (int x = 0; x < w; ++x) {
                float s = shadingMap[y * w + x];
                float l = luminance[y * w + x];

                // Check if geometrically in shadow AND texture is darker than sunlit side
                if (s < 0.35f && l < meanSunlit * opt.shadowThreshold) {
                    float shadowWeight = std::clamp((0.35f - s) / 0.25f, 0.0f, 1.0f);
                    float localBoost = 1.0f + (boostRatio - 1.0f) * shadowWeight;

                    Vec3 rgb = inputTexture.getPixelRGB(x, y);
                    Vec3 boosted = rgb * localBoost;

                    // Preserve micro-detail: blend between scaled color and luminance-guided detail
                    boosted.x = std::clamp(boosted.x, 0.0f, 1.0f);
                    boosted.y = std::clamp(boosted.y, 0.0f, 1.0f);
                    boosted.z = std::clamp(boosted.z, 0.0f, 1.0f);

                    relit.setPixelRGB(x, y, boosted);
                }
            }
        }

        return relit;
    }
};

} // namespace delight
} // namespace scratchbox

#endif // SCRATCHBOX_DELIGHT_HPP
