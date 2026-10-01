/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

#ifndef SCRATCHBOX_FABRIC_HPP
#define SCRATCHBOX_FABRIC_HPP

#include "scratchbox_math.hpp"
#include "scratchbox_geometry.hpp"
#include "scratchbox_pbr.hpp"
#include "scratchbox_xpbd.hpp"

#include <vector>
#include <unordered_map>
#include <cmath>
#include <algorithm>
#include <cstdint>
#include <string>

namespace scratchbox {
namespace fabric {

using math::Vec2;
using math::Vec3;
using math::Vec4;
using math::PI;
using math::TWO_PI;
using geometry::ScratchboxMesh;
using geometry::Vertex;
using xpbd::XpbdParticle;

// ============================================================================
// 1. FABRIC PROPERTIES & WEAVE SPECIFICATION
// ============================================================================

enum class WeavePattern {
    Plain,  // 1/1 over-under grid (linen, cotton)
    Twill,  // 2/1 or 2/2 diagonal ribbed weave (denim, gabardine)
    Satin,  // 4/1 floating filament weave (silk, glossy satin)
    Knit    // Interlocking looped stitches (wool, jersey)
};

struct FabricProperties {
    WeavePattern pattern{WeavePattern::Twill};
    float warpCompliance{1e-7f};      // Longitudinal thread stretch compliance (m/N)
    float weftCompliance{2e-7f};      // Transversal thread stretch compliance (m/N)
    float shearCompliance{5e-5f};     // Initial diagonal shear compliance
    float shearLockCompliance{1e-7f}; // Stiffened compliance once lock angle exceeded
    float shearLockAngle{0.785f};     // Shear limit angle in radians (~45 deg)
    float bendingCompliance{1e-4f};   // Isometric cross-wing bending compliance
    float thickness{0.0015f};         // Fabric physical thickness in meters (1.5mm)
    float density{0.32f};             // Areal density (kg / m^2)
    float airDragCoeff{1.15f};        // Aerodynamic drag coefficient C_d
    float airLiftCoeff{0.75f};        // Aerodynamic lift coefficient C_l
    float airDensity{1.225f};         // kg / m^3
    float sheenIntensity{0.85f};      // Charlie microfiber edge sheen
    float sheenRoughness{0.35f};      // Charlie sheen roughness
    Vec3 sheenColor{1.0f, 0.95f, 0.90f};
};

// ============================================================================
// 2. ORTHOTROPIC XPBD CONSTRAINTS (WARP, WEFT, SHEAR LOCKING)
// ============================================================================

struct OrthotropicConstraint {
    uint32_t p0{0};
    uint32_t p1{0};
    float restLength{0.0f};
    float compliance{1e-7f};
    float lambda{0.0f};

    void solve(std::vector<XpbdParticle>& particles, float dt) {
        float w0 = particles[p0].invMass;
        float w1 = particles[p1].invMass;
        float wSum = w0 + w1;
        if (wSum < 1e-8f) return;

        Vec3 diff = particles[p0].position - particles[p1].position;
        float len = diff.length();
        if (len < 1e-6f) return;

        float C = len - restLength;
        Vec3 n = diff * (1.0f / len);

        float alphaTilde = compliance / (dt * dt);
        float deltaLambda = (-C - alphaTilde * lambda) / (wSum + alphaTilde);
        lambda += deltaLambda;

        Vec3 deltaP = n * deltaLambda;
        if (w0 > 0.0f) particles[p0].position = particles[p0].position + deltaP * w0;
        if (w1 > 0.0f) particles[p1].position = particles[p1].position - deltaP * w1;
    }
};

/**
 * Non-linear Shear Locking Quad Constraint
 * Prevents woven cloth from collapsing like rubber by stiffening sharply past the lock angle.
 */
struct ShearLockConstraint {
    uint32_t p0{0}; // Top-left
    uint32_t p1{0}; // Top-right
    uint32_t p2{0}; // Bottom-right
    uint32_t p3{0}; // Bottom-left
    float restDiag0{0.0f}; // Distance(p0, p2)
    float restDiag1{0.0f}; // Distance(p1, p3)
    float initialCompliance{5e-5f};
    float lockedCompliance{1e-7f};
    float lockAngle{0.785f};
    float lambda0{0.0f};
    float lambda1{0.0f};

    void solve(std::vector<XpbdParticle>& particles, float dt) {
        // Evaluate diagonal 0 (p0 to p2)
        solveDiagonal(particles, p0, p2, restDiag0, lambda0, dt);
        // Evaluate diagonal 1 (p1 to p3)
        solveDiagonal(particles, p1, p3, restDiag1, lambda1, dt);
    }

private:
    void solveDiagonal(
        std::vector<XpbdParticle>& particles,
        uint32_t a,
        uint32_t b,
        float restLen,
        float& lambda,
        float dt
    ) {
        float wA = particles[a].invMass;
        float wB = particles[b].invMass;
        float wSum = wA + wB;
        if (wSum < 1e-8f) return;

        Vec3 diff = particles[a].position - particles[b].position;
        float len = diff.length();
        if (len < 1e-6f) return;

        float C = len - restLen;
        float strain = std::abs(C) / std::max(1e-4f, restLen);

        // Non-linear stiffening past lock strain threshold
        float effectiveCompliance = (strain > 0.15f) ? lockedCompliance : initialCompliance;
        Vec3 n = diff * (1.0f / len);

        float alphaTilde = effectiveCompliance / (dt * dt);
        float deltaLambda = (-C - alphaTilde * lambda) / (wSum + alphaTilde);
        lambda += deltaLambda;

        Vec3 deltaP = n * deltaLambda;
        if (wA > 0.0f) particles[a].position = particles[a].position + deltaP * wA;
        if (wB > 0.0f) particles[b].position = particles[b].position - deltaP * wB;
    }
};

// ============================================================================
// 3. SPATIAL HASHING CLOTH SELF-COLLISION
// ============================================================================

class SpatialHashSelfCollision {
public:
    struct HashCellKey {
        int32_t x{0};
        int32_t y{0};
        int32_t z{0};

        bool operator==(const HashCellKey& o) const {
            return x == o.x && y == o.y && z == o.z;
        }
    };

    struct KeyHasher {
        size_t operator()(const HashCellKey& k) const {
            // Large primes for 3D spatial hash
            return static_cast<size_t>(k.x * 73856093 ^ k.y * 19349663 ^ k.z * 83492791);
        }
    };

    static void solveSelfCollision(
        std::vector<XpbdParticle>& particles,
        float thickness = 0.002f,
        float stiffness = 0.85f
    ) {
        if (particles.empty()) return;
        float cellSize = std::max(0.005f, thickness * 2.5f);
        float invCellSize = 1.0f / cellSize;
        float minDist = thickness * 2.0f;
        float minDistSq = minDist * minDist;

        std::unordered_map<HashCellKey, std::vector<uint32_t>, KeyHasher> grid;
        grid.reserve(particles.size());

        // 1. Bin all particles into spatial hash cells
        for (uint32_t i = 0; i < particles.size(); ++i) {
            const auto& p = particles[i].position;
            HashCellKey key{
                static_cast<int32_t>(std::floor(p.x * invCellSize)),
                static_cast<int32_t>(std::floor(p.y * invCellSize)),
                static_cast<int32_t>(std::floor(p.z * invCellSize))
            };
            grid[key].push_back(i);
        }

        // 2. Query 27 neighboring cells for collisions
        for (const auto& entry : grid) {
            const auto& key = entry.first;
            const auto& indices = entry.second;

            for (int32_t dx = -1; dx <= 1; ++dx) {
                for (int32_t dy = -1; dy <= 1; ++dy) {
                    for (int32_t dz = -1; dz <= 1; ++dz) {
                        HashCellKey neighborKey{key.x + dx, key.y + dy, key.z + dz};
                        auto it = grid.find(neighborKey);
                        if (it == grid.end()) continue;

                        const auto& neighborIndices = it->second;
                        for (uint32_t i : indices) {
                            for (uint32_t j : neighborIndices) {
                                // Only process unique pairs and skip immediate mesh neighbors
                                if (i >= j || std::abs(static_cast<int>(i) - static_cast<int>(j)) <= 2) continue;

                                auto& pA = particles[i];
                                auto& pB = particles[j];

                                Vec3 diff = pA.position - pB.position;
                                float distSq = diff.lengthSq();

                                if (distSq < minDistSq && distSq > 1e-10f) {
                                    float dist = std::sqrt(distSq);
                                    float overlap = (minDist - dist);
                                    Vec3 dir = diff * (1.0f / dist);

                                    float wA = pA.invMass;
                                    float wB = pB.invMass;
                                    float wSum = wA + wB;
                                    if (wSum < 1e-8f) continue;

                                    Vec3 impulse = dir * (overlap * (stiffness / wSum));
                                    if (wA > 0.0f) pA.position = pA.position + impulse * wA;
                                    if (wB > 0.0f) pB.position = pB.position - impulse * wB;
                                }
                            }
                        }
                    }
                }
            }
        }
    }
};

// ============================================================================
// 4. AERODYNAMIC WIND, DRAG & LIFT FORCE COUPLING
// ============================================================================

class AerodynamicCoupler {
public:
    static void applyAerodynamics(
        std::vector<XpbdParticle>& particles,
        const std::vector<uint32_t>& indices,
        const Vec3& windVelocity,
        const FabricProperties& props,
        float dt
    ) {
        if (particles.empty() || indices.size() < 3) return;

        for (size_t t = 0; t + 2 < indices.size(); t += 3) {
            uint32_t i0 = indices[t];
            uint32_t i1 = indices[t + 1];
            uint32_t i2 = indices[t + 2];

            auto& p0 = particles[i0];
            auto& p1 = particles[i1];
            auto& p2 = particles[i2];

            Vec3 e01 = p1.position - p0.position;
            Vec3 e02 = p2.position - p0.position;
            Vec3 crossN = e01.cross(e02);
            float crossLen = crossN.length();
            if (crossLen < 1e-6f) continue;

            float area = crossLen * 0.5f;
            Vec3 normal = crossN * (1.0f / crossLen);

            // Average face velocity
            Vec3 vFace = (p0.velocity + p1.velocity + p2.velocity) * (1.0f / 3.0f);
            Vec3 vRel = windVelocity - vFace;
            float speedRel = vRel.length();
            if (speedRel < 1e-4f) continue;

            // Normal component of relative velocity
            float vn = vRel.dot(normal);
            Vec3 vTangential = vRel - normal * vn;

            // Aerodynamic drag force along surface normal
            float dynPressure = 0.5f * props.airDensity * speedRel;
            Vec3 fDrag = normal * (dynPressure * props.airDragCoeff * area * vn);

            // Aerodynamic lift force along orthogonal tangent
            Vec3 fLift = vTangential.normalized() * (dynPressure * props.airLiftCoeff * area * std::abs(vn));

            Vec3 fTotal = fDrag + fLift;
            Vec3 vertexImpulse = fTotal * (dt / 3.0f);

            if (p0.invMass > 0.0f) p0.velocity = p0.velocity + vertexImpulse * p0.invMass;
            if (p1.invMass > 0.0f) p1.velocity = p1.velocity + vertexImpulse * p1.invMass;
            if (p2.invMass > 0.0f) p2.velocity = p2.velocity + vertexImpulse * p2.invMass;
        }
    }
};

// ============================================================================
// 5. PROCEDURAL YARN WEAVE NORMAL SYNTHESIS
// ============================================================================

class WeaveNormalSynthesizer {
public:
    /**
     * Synthesizes procedural weave normal vector for a single UV coordinate
     */
    static Vec3 evaluateWeaveNormal(
        const Vec2& uv,
        WeavePattern pattern = WeavePattern::Twill,
        float bumpDepth = 1.6f
    ) {
        float u = uv.x;
        float v = uv.y;
        float du = 0.0f;
        float dv = 0.0f;

        switch (pattern) {
            case WeavePattern::Plain: {
                float su = std::sin(u * TWO_PI);
                float sv = std::sin(v * TWO_PI);
                du = std::cos(u * TWO_PI) * sv * bumpDepth;
                dv = su * std::cos(v * TWO_PI) * bumpDepth;
                break;
            }
            case WeavePattern::Twill: {
                float diag = (u + v * 0.5f) * TWO_PI;
                du = (std::cos(diag) * 0.7f + std::cos(u * TWO_PI) * 0.3f) * bumpDepth;
                dv = (std::cos(diag) * 0.7f + std::cos(v * TWO_PI) * 0.3f) * bumpDepth;
                break;
            }
            case WeavePattern::Satin: {
                float weftTie = std::sin((v + std::floor(u * 0.25f) * 1.6f) * TWO_PI);
                du = std::cos(u * TWO_PI) * 0.3f * bumpDepth;
                dv = weftTie * bumpDepth * 1.8f;
                break;
            }
            case WeavePattern::Knit: {
                float loopX = std::sin(u * TWO_PI);
                float loopY = std::cos((v + loopX * 0.25f) * TWO_PI);
                du = std::cos(u * TWO_PI) * bumpDepth;
                dv = loopY * bumpDepth * 1.5f;
                break;
            }
        }
        return Vec3(-du, -dv, 1.0f).normalized();
    }

    /**
     * Synthesize procedural tangent-space normal map for textile weave
     */
    static std::vector<uint8_t> generateWeaveNormalMap(
        uint32_t width = 256,
        uint32_t height = 256,
        WeavePattern pattern = WeavePattern::Twill,
        float threadDensity = 32.0f,
        float bumpDepth = 1.6f
    ) {
        std::vector<uint8_t> normalMap(width * height * 4, 255);

        for (uint32_t y = 0; y < height; ++y) {
            float v = static_cast<float>(y) / static_cast<float>(height) * threadDensity;
            for (uint32_t x = 0; x < width; ++x) {
                float u = static_cast<float>(x) / static_cast<float>(width) * threadDensity;

                float du = 0.0f;
                float dv = 0.0f;

                switch (pattern) {
                    case WeavePattern::Plain: {
                        // 1/1 checkerboard over/under
                        float su = std::sin(u * TWO_PI);
                        float sv = std::sin(v * TWO_PI);
                        du = std::cos(u * TWO_PI) * sv * bumpDepth;
                        dv = su * std::cos(v * TWO_PI) * bumpDepth;
                        break;
                    }
                    case WeavePattern::Twill: {
                        // 2/1 diagonal ribbed denim weave (u + v shift)
                        float diag = (u + v * 0.5f) * TWO_PI;
                        float threadU = std::sin(u * TWO_PI);
                        float threadV = std::sin(v * TWO_PI);
                        du = (std::cos(diag) * 0.7f + std::cos(u * TWO_PI) * 0.3f) * bumpDepth;
                        dv = (std::cos(diag) * 0.7f + std::cos(v * TWO_PI) * 0.3f) * bumpDepth;
                        break;
                    }
                    case WeavePattern::Satin: {
                        // Long floating warp threads with staggered ties
                        float warpFloat = std::sin(u * TWO_PI);
                        float weftTie = std::sin((v + std::floor(u * 0.25f) * 1.6f) * TWO_PI);
                        du = std::cos(u * TWO_PI) * 0.3f * bumpDepth;
                        dv = weftTie * bumpDepth * 1.8f;
                        break;
                    }
                    case WeavePattern::Knit: {
                        // Interlocking stitch loops (curved V shape)
                        float loopX = std::sin(u * TWO_PI);
                        float loopY = std::cos((v + loopX * 0.25f) * TWO_PI);
                        du = std::cos(u * TWO_PI) * bumpDepth;
                        dv = loopY * bumpDepth * 1.5f;
                        break;
                    }
                }

                Vec3 norm = Vec3(-du, -dv, 1.0f).normalized();

                uint32_t idx = (y * width + x) * 4;
                normalMap[idx + 0] = static_cast<uint8_t>(std::clamp((norm.x * 0.5f + 0.5f) * 255.0f, 0.0f, 255.0f));
                normalMap[idx + 1] = static_cast<uint8_t>(std::clamp((norm.y * 0.5f + 0.5f) * 255.0f, 0.0f, 255.0f));
                normalMap[idx + 2] = static_cast<uint8_t>(std::clamp((norm.z * 0.5f + 0.5f) * 255.0f, 0.0f, 255.0f));
                normalMap[idx + 3] = 255;
            }
        }

        return normalMap;
    }
};

// ============================================================================
// 6. DUAL-LOBE FABRIC PBR SHADING (CHARLIE SHEEN + ANISOTROPY)
// ============================================================================

class FabricShading {
public:
    static Vec3 evaluateFabricPbr(
        const Vec3& wi,            // Light vector
        const Vec3& wo,            // View vector
        const Vec3& normal,        // Surface normal
        const Vec3& tangent,       // Warp thread direction
        const Vec3& albedo,        // Fabric base dye color
        const FabricProperties& props
    ) {
        Vec3 h = (wi + wo).normalized();
        float ndotl = std::clamp(normal.dot(wi), 0.0f, 1.0f);
        float ndotv = std::clamp(normal.dot(wo), 0.001f, 1.0f);
        float ndoth = std::clamp(normal.dot(h), 0.0f, 1.0f);

        // 1. Charlie Sheen NDF (Micro-fiber edge bloom)
        float dSheen = pbr::ndfCharlieSheen(ndoth, props.sheenRoughness);
        // Ashikhmin cloth shadowing
        float vSheen = 1.0f / (4.0f * (ndotl + ndotv - ndotl * ndotv));
        Vec3 sheenLobe = props.sheenColor * (dSheen * vSheen * props.sheenIntensity);

        // 2. Anisotropic Specular Highlight (Thread direction)
        Vec3 binormal = normal.cross(tangent).normalized();
        float tdotl = tangent.dot(wi);
        float tdotv = tangent.dot(wo);
        float bdotl = binormal.dot(wi);
        float bdotv = binormal.dot(wo);

        float dAniso = pbr::ndfAnisotropicGGX(ndoth, tangent.dot(h), binormal.dot(h), 0.15f, 0.45f);
        Vec3 anisoSpec = Vec3(1.0f, 1.0f, 1.0f) * (dAniso * 0.04f);

        // 3. Rough Diffuse (Oren-Nayar approximation for fibrous light trap)
        float diffuseRoughness = 0.5f;
        float diffuseTerm = ndotl * (1.0f - 0.5f * (diffuseRoughness / (diffuseRoughness + 0.33f)));
        Vec3 diffuseLobe = albedo * (diffuseTerm * (1.0f / PI));

        return (diffuseLobe + sheenLobe + anisoSpec) * ndotl;
    }
};

} // namespace fabric
} // namespace scratchbox

#endif // SCRATCHBOX_FABRIC_HPP
