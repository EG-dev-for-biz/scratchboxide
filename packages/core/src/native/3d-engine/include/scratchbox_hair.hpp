/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

#ifndef SCRATCHBOX_HAIR_HPP
#define SCRATCHBOX_HAIR_HPP

#include "scratchbox_math.hpp"
#include "scratchbox_geometry.hpp"
#include "scratchbox_pbr.hpp"
#include "scratchbox_spz.hpp"

#include <vector>
#include <cmath>
#include <algorithm>
#include <cstdint>
#include <string>
#include <random>

namespace scratchbox {
namespace hair {

using math::Vec2;
using math::Vec3;
using math::Vec4;
using math::Quat;
using math::PI;
using math::TWO_PI;
using geometry::ScratchboxMesh;
using geometry::Vertex;

// ============================================================================
// 1. DATA STRUCTURES: GUIDES, STRANDS, AND GROOM CONFIGURATION
// ============================================================================

/**
 * Single hair vertex along a strand
 */
struct HairVertex {
    Vec3 position{0.0f, 0.0f, 0.0f};
    Vec3 prevPosition{0.0f, 0.0f, 0.0f};
    Vec3 velocity{0.0f, 0.0f, 0.0f};
    Vec3 tangent{0.0f, 1.0f, 0.0f};
    float u{0.0f};         // Root-to-tip parameter [0.0 = root, 1.0 = tip]
    float width{0.002f};   // Fiber diameter in meters
    float invMass{1.0f};   // 0.0 for fixed root
};

/**
 * Hair guide spline (Cubic Bézier control points)
 */
struct HairGuide {
    Vec3 root{0.0f, 0.0f, 0.0f};
    Vec3 normal{0.0f, 1.0f, 0.0f};
    Vec3 p1{0.0f, 0.0f, 0.0f};
    Vec3 p2{0.0f, 0.0f, 0.0f};
    Vec3 tip{0.0f, 0.0f, 0.0f};
    float length{0.25f};

    Vec3 evaluate(float t) const {
        t = std::clamp(t, 0.0f, 1.0f);
        float u = 1.0f - t;
        float tt = t * t;
        float uu = u * u;
        float uuu = uu * u;
        float ttt = tt * t;

        return root * uuu +
               p1 * (3.0f * uu * t) +
               p2 * (3.0f * u * tt) +
               tip * ttt;
    }

    Vec3 evaluateTangent(float t) const {
        t = std::clamp(t, 0.0f, 1.0f);
        float u = 1.0f - t;
        Vec3 d = (p1 - root) * (3.0f * u * u) +
                 (p2 - p1) * (6.0f * u * t) +
                 (tip - p2) * (3.0f * t * t);
        float len = d.length();
        return len > 1e-6f ? d * (1.0f / len) : Vec3(0, 1, 0);
    }
};

/**
 * Dense synthesized or simulated hair strand
 */
struct HairStrand {
    std::vector<HairVertex> vertices;
    uint32_t guideIndex{0};
    Vec3 rootOffset{0.0f, 0.0f, 0.0f};
    float curlPhase{0.0f};
    Vec3 baseColor{0.65f, 0.45f, 0.25f}; // Default chestnut / hazel
};

/**
 * Hair Grooming & Material Configuration
 */
struct HairGroomConfig {
    uint32_t guideCount{64};
    uint32_t strandCount{4096};
    uint32_t segmentsPerStrand{12};
    float length{0.25f};
    float rootWidth{0.003f};
    float tipWidth{0.0006f};
    float clumping{0.75f};       // 0 = random scatter, 1 = tight clumps to guides
    float curlRadius{0.012f};
    float curlFrequency{3.5f};
    float waveFrequency{2.0f};
    float waveAmplitude{0.008f};
    float eumelanin{0.6f};       // Brown / black pigment [0..1]
    float pheomelanin{0.2f};     // Red / blonde pigment [0..1]
    float cuticleTilt{-0.052f};  // Cuticle scale inclination in radians (-3 deg)
    float longitudinalRoughness{0.18f};
    float azimuthalRoughness{0.32f};
};

// ============================================================================
// 2. PROCEDURAL GROOMING & DENSE STRAND SYNTHESIS
// ============================================================================

class HairGroomer {
public:
    /**
     * Generate guide curves distributed across scalp surface
     */
    static std::vector<HairGuide> generateScalpGuides(
        const Vec3& scalpCenter,
        float scalpRadius,
        const HairGroomConfig& config,
        const Vec3& flowDirection = Vec3(0.0f, -0.6f, 0.8f)
    ) {
        std::vector<HairGuide> guides;
        guides.reserve(config.guideCount);

        std::mt19937 rng(1337);
        std::uniform_real_distribution<float> distTheta(0.1f, PI * 0.48f);
        std::uniform_real_distribution<float> distPhi(0.0f, TWO_PI);
        std::uniform_real_distribution<float> distJitter(-0.08f, 0.08f);

        for (uint32_t i = 0; i < config.guideCount; ++i) {
            float theta = distTheta(rng);
            float phi = distPhi(rng);

            // Scalp hemisphere point
            Vec3 norm(
                std::sin(theta) * std::cos(phi),
                std::cos(theta),
                std::sin(theta) * std::sin(phi)
            );
            Vec3 root = scalpCenter + norm * scalpRadius;

            // Compute flow tangent based on scalp orientation and flow vector
            Vec3 flow = (flowDirection - norm * flowDirection.dot(norm)).normalized();
            if (flow.length() < 1e-4f) flow = Vec3(0, 0, 1);

            float L = config.length * (1.0f + distJitter(rng));

            HairGuide g;
            g.root = root;
            g.normal = norm;
            g.length = L;
            // Cubic control points with natural gravity droop
            g.p1 = root + norm * (L * 0.28f) + flow * (L * 0.12f);
            g.p2 = root + norm * (L * 0.20f) + flow * (L * 0.55f) + Vec3(0, -L * 0.35f, 0);
            g.tip = root + flow * (L * 0.85f) + Vec3(0, -L * 0.65f, 0);

            guides.push_back(g);
        }

        return guides;
    }

    /**
     * Generate guide curves conformal to arbitrary surface positions and normals.
     * Fully ADA-compliant: accepts any arbitrary topology or mesh vertices/normals.
     */
    static std::vector<HairGuide> generateSurfaceGuides(
        const std::vector<Vec3>& surfacePositions,
        const std::vector<Vec3>& surfaceNormals,
        const HairGroomConfig& config,
        const Vec3& flowDirection = Vec3(0.0f, 0.0f, 0.0f)
    ) {
        std::vector<HairGuide> guides;
        if (surfacePositions.empty() || surfacePositions.size() != surfaceNormals.size()) {
            return guides;
        }

        uint32_t targetCount = std::min<uint32_t>(config.guideCount, static_cast<uint32_t>(surfacePositions.size()));
        guides.reserve(targetCount);

        std::mt19937 rng(1337);
        std::uniform_real_distribution<float> distJitter(-0.08f, 0.08f);

        float step = static_cast<float>(surfacePositions.size()) / static_cast<float>(targetCount);
        bool hasFlow = flowDirection.length() > 1e-4f;

        for (uint32_t i = 0; i < targetCount; ++i) {
            size_t idx = static_cast<size_t>(i * step);
            if (idx >= surfacePositions.size()) idx = surfacePositions.size() - 1;

            Vec3 root = surfacePositions[idx];
            Vec3 norm = surfaceNormals[idx].normalized();
            if (norm.length() < 1e-4f) norm = Vec3(0, 1, 0);

            Vec3 flow;
            if (hasFlow) {
                flow = (flowDirection - norm * flowDirection.dot(norm)).normalized();
                if (flow.length() < 1e-4f) flow = norm;
            } else {
                flow = norm; // Pure outward normal
            }

            float L = config.length * (1.0f + distJitter(rng));

            HairGuide g;
            g.root = root;
            g.normal = norm;
            g.length = L;

            if (hasFlow) {
                g.p1 = root + norm * (L * 0.28f) + flow * (L * 0.12f);
                g.p2 = root + norm * (L * 0.20f) + flow * (L * 0.55f) + Vec3(0, -L * 0.35f, 0);
                g.tip = root + flow * (L * 0.85f) + Vec3(0, -L * 0.65f, 0);
            } else {
                // Conformal outward bristling
                g.p1 = root + norm * (L * 0.33f);
                g.p2 = root + norm * (L * 0.66f);
                g.tip = root + norm * L;
            }

            guides.push_back(g);
        }

        return guides;
    }

    /**
     * Generate guide curves on a continuous radial harmonic surface.
     * Fully ADA-compliant: continuous parameters (radius, frequency m, amplitude A, axial taper)
     * smoothly morph across spheres (A=0), stars (m=5, A=0.45), lobed creatures, and teardrops.
     */
    static std::vector<HairGuide> generateHarmonicGuides(
        const Vec3& center,
        float baseRadius,
        int harmonicFrequency,
        float harmonicAmplitude,
        const HairGroomConfig& config,
        float axialTaper = 0.0f
    ) {
        std::vector<HairGuide> guides;
        guides.reserve(config.guideCount);

        std::mt19937 rng(1337);
        std::uniform_real_distribution<float> distTheta(0.05f, PI - 0.05f);
        std::uniform_real_distribution<float> distPhi(0.0f, TWO_PI);
        std::uniform_real_distribution<float> distJitter(-0.08f, 0.08f);

        for (uint32_t i = 0; i < config.guideCount; ++i) {
            float theta = distTheta(rng);
            float phi = distPhi(rng);

            // Continuous radial harmonic equation: r = R * (1 + A * cos(m * phi) * sin(theta)) * (1 - taper * cos(theta))
            float harmonicFactor = (harmonicFrequency > 0 && std::abs(harmonicAmplitude) > 1e-5f)
                ? (harmonicAmplitude * std::cos(static_cast<float>(harmonicFrequency) * phi) * std::sin(theta))
                : 0.0f;
            float taperFactor = 1.0f - axialTaper * std::cos(theta);
            float r = baseRadius * (1.0f + harmonicFactor) * taperFactor;

            Vec3 unitDir(
                std::sin(theta) * std::cos(phi),
                std::cos(theta),
                std::sin(theta) * std::sin(phi)
            );

            Vec3 root = center + unitDir * r;

            // Finite-difference surface normal to account for harmonic modulation
            float dTheta = 0.01f;
            float dPhi = 0.01f;

            auto sampleSurface = [&](float th, float ph) -> Vec3 {
                float hf = (harmonicFrequency > 0 && std::abs(harmonicAmplitude) > 1e-5f)
                    ? (harmonicAmplitude * std::cos(static_cast<float>(harmonicFrequency) * ph) * std::sin(th))
                    : 0.0f;
                float tf = 1.0f - axialTaper * std::cos(th);
                float rad = baseRadius * (1.0f + hf) * tf;
                return center + Vec3(
                    std::sin(th) * std::cos(ph),
                    std::cos(th),
                    std::sin(th) * std::sin(ph)
                ) * rad;
            };

            Vec3 pTheta = sampleSurface(theta + dTheta, phi);
            Vec3 pPhi = sampleSurface(theta, phi + dPhi);
            Vec3 tanTheta = pTheta - root;
            Vec3 tanPhi = pPhi - root;
            Vec3 norm = tanPhi.cross(tanTheta).normalized();
            if (norm.length() < 1e-4f || norm.dot(unitDir) < 0.0f) {
                norm = unitDir;
            }

            float L = config.length * (1.0f + distJitter(rng));

            HairGuide g;
            g.root = root;
            g.normal = norm;
            g.length = L;
            g.p1 = root + norm * (L * 0.33f);
            g.p2 = root + norm * (L * 0.66f);
            g.tip = root + norm * L;

            guides.push_back(g);
        }

        return guides;
    }

    /**
     * Synthesize dense strands from guides with Voronoi clumping and curl noise
     */
    static std::vector<HairStrand> synthesizeDenseStrands(
        const std::vector<HairGuide>& guides,
        const HairGroomConfig& config
    ) {
        std::vector<HairStrand> strands;
        strands.reserve(config.strandCount);
        if (guides.empty()) return strands;

        std::mt19937 rng(4242);
        std::uniform_real_distribution<float> distAngle(0.0f, TWO_PI);
        std::uniform_real_distribution<float> distRad(0.0f, 1.0f);
        std::uniform_real_distribution<float> distGuide(0.0f, static_cast<float>(guides.size() - 1));

        for (uint32_t i = 0; i < config.strandCount; ++i) {
            // Pick guide curve (or cluster Voronoi)
            uint32_t gIdx = static_cast<uint32_t>(distGuide(rng) + 0.5f);
            if (gIdx >= guides.size()) gIdx = static_cast<uint32_t>(guides.size() - 1);
            const auto& guide = guides[gIdx];

            // Local tangent frame at root
            Vec3 up = std::abs(guide.normal.y) < 0.99f ? Vec3(0, 1, 0) : Vec3(1, 0, 0);
            Vec3 tangentU = guide.normal.cross(up).normalized();
            Vec3 tangentV = guide.normal.cross(tangentU).normalized();

            float r = std::sqrt(distRad(rng)) * 0.045f;
            float a = distAngle(rng);
            Vec3 offset = tangentU * (std::cos(a) * r) + tangentV * (std::sin(a) * r);

            HairStrand strand;
            strand.guideIndex = gIdx;
            strand.rootOffset = offset;
            strand.curlPhase = distAngle(rng);

            // Compute melanin-based hair base albedo
            // Higher eumelanin = dark brown/black; higher pheomelanin = auburn/red; low = blonde
            float eum = config.eumelanin;
            float pheo = config.pheomelanin;
            float melR = std::exp(- (0.419f * eum + 0.187f * pheo) * 4.0f);
            float melG = std::exp(- (0.697f * eum + 0.403f * pheo) * 4.0f);
            float melB = std::exp(- (1.370f * eum + 1.049f * pheo) * 4.0f);
            strand.baseColor = Vec3(
                std::clamp(melR, 0.05f, 0.95f),
                std::clamp(melG, 0.04f, 0.90f),
                std::clamp(melB, 0.02f, 0.85f)
            );

            // Generate polyline vertices
            uint32_t numVerts = std::max(4u, config.segmentsPerStrand);
            strand.vertices.resize(numVerts);

            for (uint32_t v = 0; v < numVerts; ++v) {
                float u = static_cast<float>(v) / static_cast<float>(numVerts - 1);
                Vec3 guideP = guide.evaluate(u);
                Vec3 guideT = guide.evaluateTangent(u);

                // Orthogonal frame along guide tangent
                Vec3 refUp = std::abs(guideT.y) < 0.99f ? Vec3(0, 1, 0) : Vec3(1, 0, 0);
                Vec3 binorm = guideT.cross(refUp).normalized();
                Vec3 norm = binorm.cross(guideT).normalized();

                // Clump convergence towards guide tip
                float clumpFactor = std::pow(u, 1.2f) * config.clumping;
                Vec3 clumpOffset = offset * (1.0f - clumpFactor);

                // Procedural curl & wave displacement
                float curlAngle = u * config.curlFrequency * TWO_PI + strand.curlPhase;
                float curlR = config.curlRadius * u; // Curl grows from root to tip
                Vec3 curlDisp = binorm * (std::cos(curlAngle) * curlR) + norm * (std::sin(curlAngle) * curlR);

                float waveAngle = u * config.waveFrequency * TWO_PI;
                Vec3 waveDisp = binorm * (std::sin(waveAngle) * config.waveAmplitude * u);

                Vec3 pos = guideP + clumpOffset + curlDisp + waveDisp;

                HairVertex& hv = strand.vertices[v];
                hv.position = pos;
                hv.prevPosition = pos;
                hv.velocity = Vec3(0, 0, 0);
                hv.tangent = guideT;
                hv.u = u;
                hv.width = config.rootWidth * (1.0f - u) + config.tipWidth * u;
                hv.invMass = (v == 0) ? 0.0f : 1.0f; // Root vertex is pinned
            }

            // Update smooth finite-difference tangents
            for (size_t v = 0; v < numVerts; ++v) {
                if (v == 0) {
                    strand.vertices[v].tangent = (strand.vertices[1].position - strand.vertices[0].position).normalized();
                } else if (v + 1 == numVerts) {
                    strand.vertices[v].tangent = (strand.vertices[v].position - strand.vertices[v - 1].position).normalized();
                } else {
                    strand.vertices[v].tangent = (strand.vertices[v + 1].position - strand.vertices[v - 1].position).normalized();
                }
            }

            strands.push_back(strand);
        }

        return strands;
    }
};

// ============================================================================
// 3. XPBD STRAND DYNAMICS (STRETCH, BENDING, OBSTACLE COLLISION)
// ============================================================================

class HairXpbdSimulator {
public:
    struct HeadCollider {
        Vec3 center;
        float radius;
        HeadCollider() : center(0.0f, 0.0f, 0.0f), radius(0.12f) {}
        HeadCollider(const Vec3& c, float r) : center(c), radius(r) {}
    };

    static void stepSimulation(
        std::vector<HairStrand>& strands,
        float dt,
        uint32_t substeps = 4,
        const HeadCollider& head = HeadCollider(),
        const Vec3& wind = Vec3(0.0f, 0.0f, 0.0f),
        const Vec3& gravity = Vec3(0.0f, -9.81f, 0.0f),
        float stretchCompliance = 1e-7f,
        float bendingCompliance = 5e-5f
    ) {
        if (strands.empty() || substeps == 0) return;
        float subDt = dt / static_cast<float>(substeps);
        float subDtSq = subDt * subDt;

        for (uint32_t step = 0; step < substeps; ++step) {
            for (auto& strand : strands) {
                size_t n = strand.vertices.size();
                if (n < 2) continue;

                // 1. Predict unconstrained positions (Verlet + forces)
                for (size_t i = 1; i < n; ++i) {
                    auto& v = strand.vertices[i];
                    v.velocity = v.velocity + (gravity + wind) * subDt;
                    v.velocity = v.velocity * 0.985f; // Viscous air damping
                    v.prevPosition = v.position;
                    v.position = v.position + v.velocity * subDt;
                }

                // 2. Solve Distance Constraints (Stretch resistance)
                float alphaStretch = stretchCompliance / subDtSq;
                for (size_t i = 0; i < n - 1; ++i) {
                    auto& p0 = strand.vertices[i];
                    auto& p1 = strand.vertices[i + 1];

                    Vec3 diff = p0.position - p1.position;
                    float curLen = diff.length();
                    if (curLen < 1e-6f) continue;

                    float restLen = (p0.prevPosition - p1.prevPosition).length();
                    if (restLen < 1e-5f) restLen = 0.02f;

                    float C = curLen - restLen;
                    Vec3 dir = diff * (1.0f / curLen);

                    float w0 = p0.invMass;
                    float w1 = p1.invMass;
                    float wSum = w0 + w1;
                    if (wSum < 1e-8f) continue;

                    float dLambda = -C / (wSum + alphaStretch);
                    Vec3 corr = dir * dLambda;

                    if (w0 > 0.0f) p0.position = p0.position + corr * w0;
                    if (w1 > 0.0f) p1.position = p1.position - corr * w1;
                }

                // 3. Solve Bending Constraints (Triplet curvature resistance)
                float alphaBend = bendingCompliance / subDtSq;
                for (size_t i = 1; i < n - 1; ++i) {
                    auto& pPrev = strand.vertices[i - 1];
                    auto& pCurr = strand.vertices[i];
                    auto& pNext = strand.vertices[i + 1];

                    Vec3 e1 = (pCurr.position - pPrev.position);
                    Vec3 e2 = (pNext.position - pCurr.position);
                    float l1 = e1.length();
                    float l2 = e2.length();
                    if (l1 < 1e-5f || l2 < 1e-5f) continue;

                    Vec3 targetNext = pCurr.position + e1 * (l2 / l1);
                    Vec3 bendCorr = targetNext - pNext.position;
                    float bendDist = bendCorr.length();
                    if (bendDist > 1e-6f) {
                        float dLambda = -bendDist / (pNext.invMass + alphaBend);
                        if (pNext.invMass > 0.0f) {
                            pNext.position = pNext.position + (bendCorr * (1.0f / bendDist)) * (-dLambda * 0.4f);
                        }
                    }
                }

                // 4. Head Collision (Sphere obstacle projection)
                for (size_t i = 1; i < n; ++i) {
                    auto& v = strand.vertices[i];
                    Vec3 diff = v.position - head.center;
                    float dist = diff.length();
                    float safeR = head.radius + v.width * 2.0f;
                    if (dist < safeR && dist > 1e-5f) {
                        v.position = head.center + diff * (safeR / dist);
                    }
                }

                // 5. Update derived velocities and tangent orientations
                for (size_t i = 1; i < n; ++i) {
                    auto& v = strand.vertices[i];
                    v.velocity = (v.position - v.prevPosition) * (1.0f / subDt);
                }

                for (size_t i = 0; i < n; ++i) {
                    if (i == 0) {
                        strand.vertices[i].tangent = (strand.vertices[1].position - strand.vertices[0].position).normalized();
                    } else if (i + 1 == n) {
                        strand.vertices[i].tangent = (strand.vertices[i].position - strand.vertices[i - 1].position).normalized();
                    } else {
                        strand.vertices[i].tangent = (strand.vertices[i + 1].position - strand.vertices[i - 1].position).normalized();
                    }
                }
            }
        }
    }
};

// ============================================================================
// 4. MARSCHNER PHYSICAL HAIR SCATTERING BSDF
// ============================================================================

class MarschnerBSDF {
public:
    /**
     * Evaluate Marschner BSDF given incident light vector, view vector, and strand tangent
     */
    static Vec3 evaluate(
        const Vec3& wi,            // Direction to light source (normalized, pointing away from surface)
        const Vec3& wo,            // Direction to viewer (normalized, pointing away from surface)
        const Vec3& tangent,       // Strand tangent pointing from root to tip
        const Vec3& baseColor,     // Pigment albedo
        float longitudinalRoughness = 0.20f,
        float azimuthalRoughness = 0.35f,
        float cuticleTilt = -0.052f // -3 degrees in radians
    ) {
        float sinThetaI = std::clamp(wi.dot(tangent), -0.999f, 0.999f);
        float sinThetaO = std::clamp(wo.dot(tangent), -0.999f, 0.999f);
        float thetaI = std::asin(sinThetaI);
        float thetaO = std::asin(sinThetaO);

        float thetaH = (thetaI + thetaO) * 0.5f;
        float thetaD = (thetaI - thetaO) * 0.5f;

        Vec3 wiPerp = (wi - tangent * sinThetaI).normalized();
        Vec3 woPerp = (wo - tangent * sinThetaO).normalized();
        float cosPhi = std::clamp(wiPerp.dot(woPerp), -1.0f, 1.0f);
        float phi = std::acos(cosPhi);

        float alphaR = 2.0f * cuticleTilt;
        float alphaTT = -cuticleTilt;
        float alphaTRT = -4.0f * cuticleTilt;

        float betaR = longitudinalRoughness;
        float betaTT = longitudinalRoughness * 0.5f;
        float betaTRT = longitudinalRoughness * 2.0f;

        float mR = evalGaussian(thetaH - alphaR, betaR);
        float mTT = evalGaussian(thetaH - alphaTT, betaTT);
        float mTRT = evalGaussian(thetaH - alphaTRT, betaTRT);

        float nR = evalGaussian(PI - phi, azimuthalRoughness);
        float nTT = evalGaussian(phi, azimuthalRoughness * 0.7f);
        float nTRT = evalGaussian(PI - phi, azimuthalRoughness * 1.5f);

        float cosThetaD = std::cos(thetaD);
        float f0 = 0.0465f; // ((1.55 - 1) / (1.55 + 1))^2
        float f = f0 + (1.0f - f0) * std::pow(1.0f - cosThetaD, 5.0f);

        Vec3 colorR = Vec3(1.0f, 1.0f, 1.0f) * (f * mR * nR);
        Vec3 colorTT = baseColor * ((1.0f - f) * (1.0f - f) * mTT * nTT);
        Vec3 colorTRT = (baseColor * baseColor) * ((1.0f - f) * (1.0f - f) * f * mTRT * nTRT);

        float cosThetaI_abs = std::max(0.05f, std::cos(thetaI));
        Vec3 bsdf = (colorR + colorTT + colorTRT) * (1.0f / (cosThetaI_abs * cosThetaI_abs));

        return bsdf;
    }

private:
    static float evalGaussian(float x, float beta) {
        float b = std::max(0.01f, beta);
        float invB = 1.0f / (b * std::sqrt(TWO_PI));
        return invB * std::exp(- (x * x) / (2.0f * b * b));
    }
};

// ============================================================================
// 5. CAMERA-FACING HAIR RIBBON MESH GENERATOR
// ============================================================================

class HairRibbonMeshBuilder {
public:
    static ScratchboxMesh buildRibbonMesh(
        const std::vector<HairStrand>& strands,
        const Vec3& cameraPos = Vec3(0.0f, 0.0f, 5.0f),
        const std::string& meshName = "hair_ribbons"
    ) {
        ScratchboxMesh mesh(meshName);
        if (strands.empty()) return mesh;

        size_t totalVertices = 0;
        size_t totalIndices = 0;
        for (const auto& s : strands) {
            size_t segs = s.vertices.size();
            if (segs >= 2) {
                totalVertices += segs * 2;
                totalIndices += (segs - 1) * 6;
            }
        }
        mesh.vertices.reserve(totalVertices);
        mesh.indices.reserve(totalIndices);

        for (const auto& strand : strands) {
            size_t n = strand.vertices.size();
            if (n < 2) continue;

            uint32_t strandBaseIdx = static_cast<uint32_t>(mesh.vertices.size());

            for (size_t i = 0; i < n; ++i) {
                const auto& v = strand.vertices[i];
                Vec3 toCam = (cameraPos - v.position).normalized();
                Vec3 side = v.tangent.cross(toCam).normalized();
                if (side.length() < 1e-4f) {
                    side = Vec3(1, 0, 0);
                }

                float halfW = v.width * 0.5f;
                Vec3 pLeft = v.position - side * halfW;
                Vec3 pRight = v.position + side * halfW;

                Vec3 norm = side.cross(v.tangent).normalized();

                Vertex vl;
                vl.position = pLeft;
                vl.normal = norm;
                vl.uv = Vec2(0.0f, v.u);
                vl.color = Vec4(strand.baseColor.x, strand.baseColor.y, strand.baseColor.z, 1.0f);
                vl.tangent = Vec4(v.tangent.x, v.tangent.y, v.tangent.z, 1.0f);

                Vertex vr;
                vr.position = pRight;
                vr.normal = norm;
                vr.uv = Vec2(1.0f, v.u);
                vr.color = Vec4(strand.baseColor.x, strand.baseColor.y, strand.baseColor.z, 1.0f);
                vr.tangent = Vec4(v.tangent.x, v.tangent.y, v.tangent.z, 1.0f);

                mesh.vertices.push_back(vl);
                mesh.vertices.push_back(vr);
            }

            for (size_t i = 0; i < n - 1; ++i) {
                uint32_t i0 = strandBaseIdx + static_cast<uint32_t>(i * 2);
                uint32_t i1 = i0 + 1;
                uint32_t i2 = i0 + 2;
                uint32_t i3 = i0 + 3;

                mesh.indices.push_back(i0);
                mesh.indices.push_back(i1);
                mesh.indices.push_back(i2);

                mesh.indices.push_back(i2);
                mesh.indices.push_back(i1);
                mesh.indices.push_back(i3);
            }
        }

        mesh.material.name = "hair_ribbon_marschner";
        mesh.material.baseColorFactor = Vec4(0.55f, 0.35f, 0.20f, 1.0f);
        mesh.material.roughnessFactor = 0.3f;
        mesh.material.metallicFactor = 0.0f;
        mesh.material.anisotropyStrength = 0.85f;
        mesh.material.doubleSided = true;

        return mesh;
    }
};

// ============================================================================
// 6. ANALYTICAL FORWARD GAUSSIAN SPLAT GENERATOR & SPZ EXPORTER
// ============================================================================

class HairSplatBuilder {
public:
    /**
     * Analytically project hair strands into anisotropic 3D Gaussian Splats.
     * Maps strand segments directly into 3D Gaussians oriented along strand tangents,
     * with anisotropic scale matching strand diameter and segment length.
     * Closed-form, zero neural training, zero 2D rendering.
     */
    static std::vector<spz::GaussianSplat> buildStrandSplats(
        const std::vector<HairStrand>& strands,
        float splatScaleMultiplier = 1.0f,
        float baseOpacity = 0.92f,
        const Vec3& customBaseColor = Vec3(-1.0f, -1.0f, -1.0f),
        const Vec3& customTipColor = Vec3(-1.0f, -1.0f, -1.0f)
    ) {
        std::vector<spz::GaussianSplat> splats;
        size_t totalSplats = 0;
        for (const auto& s : strands) {
            if (s.vertices.size() >= 2) {
                totalSplats += s.vertices.size() - 1;
            }
        }
        splats.reserve(totalSplats);

        const Vec3 canonicalAxis(0.0f, 0.0f, 1.0f);

        for (const auto& strand : strands) {
            size_t n = strand.vertices.size();
            if (n < 2) continue;

            for (size_t i = 0; i < n - 1; ++i) {
                const auto& v0 = strand.vertices[i];
                const auto& v1 = strand.vertices[i + 1];

                Vec3 midPos = (v0.position + v1.position) * 0.5f;
                Vec3 dir = v1.position - v0.position;
                float segLen = dir.length();
                if (segLen < 1e-6f) continue;
                Vec3 unitDir = dir * (1.0f / segLen);

                // Closed-form quaternion rotating canonical +Z (0, 0, 1) to unitDir
                float dot = canonicalAxis.dot(unitDir);
                Quat rot;
                if (dot > 0.999999f) {
                    rot = Quat::identity();
                } else if (dot < -0.999999f) {
                    rot = Quat(1.0f, 0.0f, 0.0f, 0.0f);
                } else {
                    Vec3 cross = canonicalAxis.cross(unitDir);
                    rot = Quat(cross.x, cross.y, cross.z, 1.0f + dot).normalized();
                }

                float avgWidth = (v0.width + v1.width) * 0.5f * splatScaleMultiplier;
                // Anisotropic covariance: elongated along tangent Z, slender on X/Y
                float scaleZ = std::max(segLen * 0.58f, 0.0005f);
                float scaleXY = std::max(avgWidth * 0.65f, 0.0003f);

                // Color interpolation along strand (melanin or custom gradient)
                float tMid = (v0.u + v1.u) * 0.5f;
                Vec3 color;
                if (customBaseColor.x >= 0.0f && customTipColor.x >= 0.0f) {
                    color = customBaseColor * (1.0f - tMid) + customTipColor * tMid;
                } else {
                    color = strand.baseColor;
                }

                spz::GaussianSplat gs;
                gs.position = midPos;
                gs.scale = Vec3(scaleXY, scaleXY, scaleZ);
                gs.rotation = rot;
                gs.color = color;
                gs.opacity = baseOpacity;

                splats.push_back(gs);
            }
        }
        return splats;
    }

    /**
     * Encode strands directly into Niantic SPZ v2 compressed buffer.
     */
    static std::vector<uint8_t> buildSpz(
        const std::vector<HairStrand>& strands,
        float splatScaleMultiplier = 1.0f,
        float baseOpacity = 0.92f,
        const Vec3& customBaseColor = Vec3(-1.0f, -1.0f, -1.0f),
        const Vec3& customTipColor = Vec3(-1.0f, -1.0f, -1.0f)
    ) {
        auto splats = buildStrandSplats(strands, splatScaleMultiplier, baseOpacity, customBaseColor, customTipColor);
        return spz::SpzCodec::encode(splats);
    }

    /**
     * Save splats directly to an SPZ file on disk.
     */
    static bool saveToSpzFile(
        const std::string& filepath,
        const std::vector<spz::GaussianSplat>& splats
    ) {
        auto bytes = spz::SpzCodec::encode(splats);
        if (bytes.empty()) return false;
        std::ofstream out(filepath, std::ios::binary);
        if (!out.is_open()) return false;
        out.write(reinterpret_cast<const char*>(bytes.data()), bytes.size());
        return out.good();
    }

    /**
     * Save splats directly to standard binary PLY format.
     */
    static bool saveToPlyFile(
        const std::string& filepath,
        const std::vector<spz::GaussianSplat>& splats
    ) {
        return spz::PlyCodec::saveToPlyFile(filepath, splats);
    }
};

} // namespace hair
} // namespace scratchbox

#endif // SCRATCHBOX_HAIR_HPP
