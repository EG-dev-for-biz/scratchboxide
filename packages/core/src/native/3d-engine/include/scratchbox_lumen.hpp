/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

#ifndef SCRATCHBOX_LUMEN_HPP
#define SCRATCHBOX_LUMEN_HPP

#include "scratchbox_math.hpp"
#include "scratchbox_geometry.hpp"
#include "scratchbox_sdf.hpp"
#include "scratchbox_lighting.hpp"
#include "scratchbox_pbr.hpp"

#include <vector>
#include <string>
#include <cmath>
#include <algorithm>
#include <array>
#include <memory>

namespace scratchbox {
namespace lumen {

using math::Vec2;
using math::Vec3;
using math::Vec4;
using geometry::Vertex;
using geometry::ScratchboxMesh;

/**
 * 2nd-Order Spherical Harmonics (L2 SH)
 * 9 basis functions for physically accurate diffuse irradiance convolution.
 * Based on Ramamoorthi & Hanrahan (2001).
 */
struct SphericalHarmonicsL2 {
    // 9 coefficients for each of the 3 color channels (R, G, B) = 27 floats
    float c[9][3]{};

    void clear() {
        for (int i = 0; i < 9; ++i) {
            c[i][0] = c[i][1] = c[i][2] = 0.0f;
        }
    }

    // Projects a directional radiance sample L in direction d with solid angle weight
    void addDirectionalRadiance(const Vec3& dir, const Vec3& radiance, float weight) {
        Vec3 d = dir.normalized();
        float x = d.x, y = d.y, z = d.z;
        
        // Spherical Harmonic basis functions Y_lm(dir)
        float Y[9];
        Y[0] = 0.282095f;                          // l=0, m=0
        Y[1] = 0.488603f * y;                      // l=1, m=-1
        Y[2] = 0.488603f * z;                      // l=1, m=0
        Y[3] = 0.488603f * x;                      // l=1, m=1
        Y[4] = 1.092548f * x * y;                  // l=2, m=-2
        Y[5] = 1.092548f * y * z;                  // l=2, m=-1
        Y[6] = 0.315392f * (3.0f * z * z - 1.0f);  // l=2, m=0
        Y[7] = 1.092548f * x * z;                  // l=2, m=1
        Y[8] = 0.546274f * (x * x - y * y);        // l=2, m=2
        
        for (int i = 0; i < 9; ++i) {
            float factor = Y[i] * weight;
            c[i][0] += radiance.x * factor;
            c[i][1] += radiance.y * factor;
            c[i][2] += radiance.z * factor;
        }
    }

    // Evaluates diffuse irradiance in normal direction n via analytic cosine convolution
    Vec3 evaluateIrradiance(const Vec3& normal) const {
        Vec3 n = normal.normalized();
        float x = n.x, y = n.y, z = n.z;
        
        // Analytic A_l convolution constants (Lambertian diffuse kernel)
        const float C1 = 0.429043f;
        const float C2 = 0.511664f;
        const float C3 = 0.743125f;
        const float C4 = 0.886227f;
        const float C5 = 0.247708f;
        
        Vec3 irradiance{0.0f, 0.0f, 0.0f};
        for (int ch = 0; ch < 3; ++ch) {
            float val = C4 * c[0][ch] -
                        C2 * (c[1][ch] * y + c[2][ch] * z + c[3][ch] * x) +
                        C1 * (c[4][ch] * x * y + c[5][ch] * y * z + c[7][ch] * x * z) +
                        C3 * c[6][ch] * z * z - C5 * c[6][ch] +
                        C1 * c[8][ch] * (x * x - y * y);
            
            float* dest = (ch == 0) ? &irradiance.x : ((ch == 1) ? &irradiance.y : &irradiance.z);
            *dest = std::max(0.0f, val);
        }
        return irradiance;
    }
};

/**
 * RadianceProbe stores localized multi-bounce spatial irradiance.
 */
struct RadianceProbe {
    Vec3 position{0.0f, 0.0f, 0.0f};
    SphericalHarmonicsL2 sh;
    Vec3 directRadiance{0.0f, 0.0f, 0.0f};
    Vec3 bounceRadiance{0.0f, 0.0f, 0.0f};
    float validityWeight{1.0f};
};

/**
 * SurfaceCacheCard represents an unmapped planar patch of geometry,
 * capturing direct lighting and storing secondary bounce radiance.
 */
struct SurfaceCacheCard {
    uint32_t cardId{0};
    Vec3 position{0.0f, 0.0f, 0.0f};
    Vec3 normal{0.0f, 1.0f, 0.0f};
    float area{1.0f};
    Vec3 albedo{0.8f, 0.8f, 0.8f};
    Vec3 directIrradiance{0.0f, 0.0f, 0.0f};
    Vec3 bounceIrradiance{0.0f, 0.0f, 0.0f};
    
    Vec3 totalRadiance() const {
        return (directIrradiance + bounceIrradiance) * albedo * (1.0f / 3.1415926535f);
    }
};

/**
 * SurfaceCacheAtlas organizes the surface cards covering scene geometry.
 */
class SurfaceCacheAtlas {
public:
    std::vector<SurfaceCacheCard> cards;

    void appendFromMesh(const ScratchboxMesh& mesh, size_t stride = 1) {
        size_t triCount = mesh.indices.size() / 3;
        stride = std::max<size_t>(1, stride);
        
        for (size_t t = 0; t < triCount; t += stride) {
            uint32_t i0 = mesh.indices[t * 3 + 0];
            uint32_t i1 = mesh.indices[t * 3 + 1];
            uint32_t i2 = mesh.indices[t * 3 + 2];
            
            const auto& v0 = mesh.vertices[i0];
            const auto& v1 = mesh.vertices[i1];
            const auto& v2 = mesh.vertices[i2];
            
            Vec3 edgeA = v1.position - v0.position;
            Vec3 edgeB = v2.position - v0.position;
            Vec3 cross = edgeA.cross(edgeB);
            float triArea = cross.length() * 0.5f;
            if (triArea < 1e-4f) continue;
            
            Vec3 center = (v0.position + v1.position + v2.position) / 3.0f;
            Vec3 normal = (v0.normal + v1.normal + v2.normal).normalized();
            Vec3 col = Vec3(v0.color.x + v1.color.x + v2.color.x,
                            v0.color.y + v1.color.y + v2.color.y,
                            v0.color.z + v1.color.z + v2.color.z) * (1.0f / 3.0f);
            
            SurfaceCacheCard card;
            card.cardId = static_cast<uint32_t>(cards.size());
            card.position = center;
            card.normal = normal;
            card.area = triArea * static_cast<float>(stride);
            card.albedo = col;
            cards.push_back(card);
        }
    }

    void buildFromMesh(const ScratchboxMesh& mesh, float sampleSpacing = 3.0f) {
        cards.clear();
        appendFromMesh(mesh, 1);
    }

    // Samples total radiosity from the closest surface card
    Vec3 sampleRadiosity(const Vec3& p, const Vec3& n) const {
        if (cards.empty()) return Vec3{0.0f, 0.0f, 0.0f};
        
        float bestDistSq = 1e9f;
        const SurfaceCacheCard* bestCard = nullptr;
        
        for (const auto& card : cards) {
            if (card.normal.dot(n) < 0.0f) continue; // Face back-to-back
            float dSq = (card.position - p).lengthSquared();
            if (dSq < bestDistSq) {
                bestDistSq = dSq;
                bestCard = &card;
            }
        }
        
        if (bestCard) {
            return bestCard->totalRadiance();
        }
        return Vec3{0.0f, 0.0f, 0.0f};
    }
};

/**
 * LumenSdfConeTracer executes diffuse wide-cone marching against signed distance fields
 * with O(1) step acceleration.
 */
class LumenSdfConeTracer {
public:
    /**
     * Traces a diffuse cone through an SDF scene function.
     * Aperture angle of ~60 degrees (1.05 rad) corresponds to a standard diffuse lobe.
     */
    static Vec3 traceDiffuseCone(
        const Vec3& origin,
        const Vec3& direction,
        float apertureRad,
        const std::function<float(const Vec3&)>& sceneSdf,
        const SurfaceCacheAtlas& surfaceCache,
        float maxDist = 50.0f
    ) {
        float t = 0.1f; // Initial offset past surface self-intersection
        float tanHalfAperture = std::tan(apertureRad * 0.5f);
        Vec3 accumulatedRadiance{0.0f, 0.0f, 0.0f};
        float occlusion = 0.0f;
        
        while (t < maxDist && occlusion < 0.95f) {
            Vec3 p = origin + direction * t;
            float coneRadius = t * tanHalfAperture;
            float dist = sceneSdf(p);
            
            if (dist < coneRadius) {
                // Cone volume intersects geometry!
                float alpha = (1.0f - occlusion) * std::clamp((coneRadius - dist) / coneRadius, 0.0f, 1.0f);
                
                // Sample surface radiosity at intersection
                Vec3 surfRadiance = surfaceCache.sampleRadiosity(p, -direction);
                accumulatedRadiance += surfRadiance * alpha;
                occlusion += alpha;
            }
            
            // Advance by maximum safe distance step
            float step = std::max(dist, coneRadius * 0.5f);
            step = std::max(step, 0.05f);
            t += step;
        }
        
        return accumulatedRadiance;
    }
};

/**
 * LumenGlobalIllumination coordinates the dynamic 3D irradiance probe grid
 * and computes infinite-bounce radiosity through iterative temporal feedback.
 */
class LumenGlobalIllumination {
public:
    SurfaceCacheAtlas surfaceCache;
    std::vector<RadianceProbe> probes;
    
    // 3D Grid Parameters
    Vec3 gridOrigin{-50.0f, 0.0f, -50.0f};
    Vec3 gridExtent{100.0f, 150.0f, 100.0f};
    int dimX{10};
    int dimY{15};
    int dimZ{10};
    float spacing{10.0f};
    
    uint32_t currentBounceIteration{0};

    void initializeGrid(const Vec3& minBound, const Vec3& maxBound, float probeSpacing = 10.0f) {
        gridOrigin = minBound;
        gridExtent = maxBound - minBound;
        spacing = probeSpacing;
        
        dimX = std::max(2, static_cast<int>(std::ceil(gridExtent.x / spacing)));
        dimY = std::max(2, static_cast<int>(std::ceil(gridExtent.y / spacing)));
        dimZ = std::max(2, static_cast<int>(std::ceil(gridExtent.z / spacing)));
        
        probes.resize(dimX * dimY * dimZ);
        
        for (int z = 0; z < dimZ; ++z) {
            for (int y = 0; y < dimY; ++y) {
                for (int x = 0; x < dimX; ++x) {
                    int idx = z * (dimX * dimY) + y * dimX + x;
                    probes[idx].position = gridOrigin + Vec3(x * spacing, y * spacing, z * spacing);
                    probes[idx].sh.clear();
                    probes[idx].directRadiance = Vec3{0.0f, 0.0f, 0.0f};
                    probes[idx].bounceRadiance = Vec3{0.0f, 0.0f, 0.0f};
                }
            }
        }
        currentBounceIteration = 0;
    }

    /**
     * Pass 1: Evaluates direct sunlight & skylight across all surface cards.
     */
    void updateDirectLighting(const Vec3& sunDirection, const Vec3& sunColor, const Vec3& skyAmbient) {
        Vec3 L_sun = sunDirection.normalized();
        
        for (auto& card : surfaceCache.cards) {
            float NdotL = std::max(0.0f, card.normal.dot(L_sun));
            float skyFactor = std::max(0.0f, card.normal.y * 0.5f + 0.5f);
            
            card.directIrradiance = sunColor * NdotL + skyAmbient * skyFactor;
            card.bounceIrradiance = Vec3{0.0f, 0.0f, 0.0f}; // Reset bounce
        }
    }

    /**
     * Pass 2: Evaluates multi-bounce radiosity.
     * Can be invoked iteratively to compute bounce 1, bounce 2, bounce N (Neumann series).
     */
    void evaluateBouncePass(const std::function<float(const Vec3&)>& sceneSdf) {
        currentBounceIteration++;
        
        // 14 canonical Fibonacci sphere directions for diffuse probe sampling
        const std::array<Vec3, 14> sampleDirs = {
            Vec3{0.0f, 1.0f, 0.0f}, Vec3{0.0f, -1.0f, 0.0f},
            Vec3{1.0f, 0.0f, 0.0f}, Vec3{-1.0f, 0.0f, 0.0f},
            Vec3{0.0f, 0.0f, 1.0f}, Vec3{0.0f, 0.0f, -1.0f},
            Vec3{0.577f, 0.577f, 0.577f}, Vec3{-0.577f, 0.577f, 0.577f},
            Vec3{0.577f, -0.577f, 0.577f}, Vec3{-0.577f, -0.577f, 0.577f},
            Vec3{0.577f, 0.577f, -0.577f}, Vec3{-0.577f, 0.577f, -0.577f},
            Vec3{0.577f, -0.577f, -0.577f}, Vec3{-0.577f, -0.577f, -0.577f}
        };
        float weightPerDir = 4.0f * 3.1415926535f / static_cast<float>(sampleDirs.size());
        
        // 1. Update Probes by tracing cones into the scene
        for (auto& probe : probes) {
            probe.sh.clear();
            Vec3 totalProbeBounce{0.0f, 0.0f, 0.0f};
            
            for (const auto& dir : sampleDirs) {
                Vec3 incomingRadiance = LumenSdfConeTracer::traceDiffuseCone(
                    probe.position,
                    dir,
                    1.05f, // ~60 degree cone
                    sceneSdf,
                    surfaceCache,
                    spacing * 3.0f
                );
                
                probe.sh.addDirectionalRadiance(dir, incomingRadiance, weightPerDir);
                totalProbeBounce += incomingRadiance;
            }
            probe.bounceRadiance = totalProbeBounce / static_cast<float>(sampleDirs.size());
        }
        
        // 2. Feed probe radiance back into Surface Cards for next bounce iteration
        for (auto& card : surfaceCache.cards) {
            Vec3 probeIrradiance = sampleProbeVolume(card.position, card.normal);
            // Temporal accumulation factor
            card.bounceIrradiance = card.bounceIrradiance * 0.5f + probeIrradiance * 0.5f;
        }
    }

    /**
     * Trilinearly samples the 3D probe volume to get diffuse bounce irradiance at any point.
     */
    Vec3 sampleProbeVolume(const Vec3& p, const Vec3& normal) const {
        Vec3 local = (p - gridOrigin) / spacing;
        
        int x0 = std::clamp(static_cast<int>(std::floor(local.x)), 0, dimX - 2);
        int y0 = std::clamp(static_cast<int>(std::floor(local.y)), 0, dimY - 2);
        int z0 = std::clamp(static_cast<int>(std::floor(local.z)), 0, dimZ - 2);
        
        float fx = std::clamp(local.x - x0, 0.0f, 1.0f);
        float fy = std::clamp(local.y - y0, 0.0f, 1.0f);
        float fz = std::clamp(local.z - z0, 0.0f, 1.0f);
        
        auto getProbe = [&](int x, int y, int z) -> const RadianceProbe& {
            int idx = z * (dimX * dimY) + y * dimX + x;
            return probes[idx];
        };
        
        // Trilinear interpolation of SH evaluated irradiance
        Vec3 irr000 = getProbe(x0, y0, z0).sh.evaluateIrradiance(normal);
        Vec3 irr100 = getProbe(x0 + 1, y0, z0).sh.evaluateIrradiance(normal);
        Vec3 irr010 = getProbe(x0, y0 + 1, z0).sh.evaluateIrradiance(normal);
        Vec3 irr110 = getProbe(x0 + 1, y0 + 1, z0).sh.evaluateIrradiance(normal);
        Vec3 irr001 = getProbe(x0, y0, z0 + 1).sh.evaluateIrradiance(normal);
        Vec3 irr101 = getProbe(x0 + 1, y0, z0 + 1).sh.evaluateIrradiance(normal);
        Vec3 irr011 = getProbe(x0, y0 + 1, z0 + 1).sh.evaluateIrradiance(normal);
        Vec3 irr111 = getProbe(x0 + 1, y0 + 1, z0 + 1).sh.evaluateIrradiance(normal);
        
        Vec3 i00 = math::lerp(irr000, irr100, fx);
        Vec3 i10 = math::lerp(irr010, irr110, fx);
        Vec3 i01 = math::lerp(irr001, irr101, fx);
        Vec3 i11 = math::lerp(irr011, irr111, fx);
        
        Vec3 i0 = math::lerp(i00, i10, fy);
        Vec3 i1 = math::lerp(i01, i11, fy);
        
        return math::lerp(i0, i1, fz);
    }
};

} // namespace lumen
} // namespace scratchbox

#endif // SCRATCHBOX_LUMEN_HPP
