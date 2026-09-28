/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

#ifndef SCRATCHBOX_INFINIGEN_HPP
#define SCRATCHBOX_INFINIGEN_HPP

#include "scratchbox_math.hpp"
#include "scratchbox_geometry.hpp"
#include <vector>
#include <cmath>
#include <random>
#include <algorithm>
#include <functional>
#include <iostream>

namespace scratchbox {
namespace infinigen {

using namespace scratchbox::math;
using namespace scratchbox::geometry;

// ============================================================================
// 1. Multi-Octave Vector-Domain Warped Geological Terrain Engine
// (Derived from Princeton Infinigen terrain/source/common/elements/warped_rocks.h & ground.h)
// ============================================================================
struct WarpedTerrainConfig {
    float macroSlopeX{-0.016f};
    float macroSlopeZ{-0.024f};
    float warpScale{1.85f};
    float warpFreq{0.075f};
    int warpOctaves{3};
    float contentScale{0.68f};
    float contentFreq{0.14f};
    int contentOctaves{4};
    float strataDuneScale{0.22f};
    float strataDuneFreq{0.38f};
    float slopeScale{0.45f};
    float slopeFreq{0.06f};
    float supressingParam{0.85f};
    uint32_t seed{1337};
};

class DomainWarpedTerrain {
private:
    static inline float hashNoise(int x, int y, int z, uint32_t seed) {
        int n = x * 374761393 + y * 668265263 + z * 127412617 + static_cast<int>(seed);
        n = (n ^ (n >> 13)) * 127412617;
        return 1.0f - static_cast<float>((n * (n * n * 15731 + 789221) + 1376312589) & 0x7fffffff) / 1073741824.0f;
    }

    static inline float perlinInterp(float x, float y, float z, uint32_t seed) {
        int xi = static_cast<int>(std::floor(x));
        int yi = static_cast<int>(std::floor(y));
        int zi = static_cast<int>(std::floor(z));

        float xf = x - std::floor(x);
        float yf = y - std::floor(y);
        float zf = z - std::floor(z);

        // Quintic Hermite interpolant
        float u = xf * xf * xf * (xf * (xf * 6.0f - 15.0f) + 10.0f);
        float v = yf * yf * yf * (yf * (yf * 6.0f - 15.0f) + 10.0f);
        float w = zf * zf * zf * (zf * (zf * 6.0f - 15.0f) + 10.0f);

        float n000 = hashNoise(xi,   yi,   zi,   seed);
        float n100 = hashNoise(xi+1, yi,   zi,   seed);
        float n010 = hashNoise(xi,   yi+1, zi,   seed);
        float n110 = hashNoise(xi+1, yi+1, zi,   seed);
        float n001 = hashNoise(xi,   yi,   zi+1, seed);
        float n101 = hashNoise(xi+1, yi,   zi+1, seed);
        float n011 = hashNoise(xi,   yi+1, zi+1, seed);
        float n111 = hashNoise(xi+1, yi+1, zi+1, seed);

        float nx00 = math::lerp(n000, n100, u);
        float nx10 = math::lerp(n010, n110, u);
        float nx01 = math::lerp(n001, n101, u);
        float nx11 = math::lerp(n011, n111, u);

        float nxy0 = math::lerp(nx00, nx10, v);
        float nxy1 = math::lerp(nx01, nx11, v);

        return math::lerp(nxy0, nxy1, w);
    }

    static inline float fbm(float x, float y, float z, int octaves, float freq, uint32_t seed) {
        float total = 0.0f;
        float amp = 1.0f;
        float maxAmp = 0.0f;
        float curFreq = freq;

        for (int i = 0; i < octaves; ++i) {
            total += perlinInterp(x * curFreq, y * curFreq, z * curFreq, seed + i * 17) * amp;
            maxAmp += amp;
            amp *= 0.5f;
            curFreq *= 2.05f;
        }
        return total / maxAmp;
    }

public:
    /**
     * Evaluates domain-warped 3D terrain height at coordinate (x, z).
     * Implements Infinigen's warped coordinate evaluation: P_warped = P + Warp(P).
     */
    static float sampleHeight(float x, float z, const WarpedTerrainConfig& cfg = {}) {
        // 1. Vector-domain warping (Infinigen warped_rocks.h)
        float warpX = fbm(x + 2.3f, 0.0f, z + 5.7f, cfg.warpOctaves, cfg.warpFreq, cfg.seed + 101) * cfg.warpScale;
        float warpZ = fbm(x + 19.1f, 0.0f, z + 31.3f, cfg.warpOctaves, cfg.warpFreq, cfg.seed + 202) * cfg.warpScale;

        float warpedX = x + warpX;
        float warpedZ = z + warpZ;

        // 2. High-frequency geological content evaluated on warped domain
        float content = fbm(warpedX, 0.0f, warpedZ, cfg.contentOctaves, cfg.contentFreq, cfg.seed + 303) * cfg.contentScale;

        // 3. Warped geological strata shelves / dune ridges (Infinigen ground.h)
        float strataPattern = std::sin(warpedX * cfg.strataDuneFreq * 1.5f + warpedZ * cfg.strataDuneFreq * 0.85f);
        float strata = (strataPattern * strataPattern * 0.5f + 0.5f * std::cos(warpedZ * cfg.strataDuneFreq * 2.2f)) * cfg.strataDuneScale;

        // 4. Macro slope & drainage relief
        float slope = fbm(x, 0.0f, z, 2, cfg.slopeFreq, cfg.seed + 404) * cfg.slopeScale;
        float macro = cfg.macroSlopeX * x + cfg.macroSlopeZ * z;

        return (macro + slope) * cfg.supressingParam + content + strata;
    }

    /**
     * Analytical finite-difference surface normal vector.
     */
    static Vec3 sampleNormal(float x, float z, const WarpedTerrainConfig& cfg = {}) {
        const float eps = 0.08f;
        float hL = sampleHeight(x - eps, z, cfg);
        float hR = sampleHeight(x + eps, z, cfg);
        float hD = sampleHeight(x, z - eps, cfg);
        float hU = sampleHeight(x, z + eps, cfg);

        Vec3 normal(-(hR - hL) / (2.0f * eps), 1.0f, -(hU - hD) / (2.0f * eps));
        return normal.normalized();
    }
};

// ============================================================================
// 2. Soil Machine Hydrological Sediment & Moisture Deposition Tracker
// (Derived from Princeton Infinigen terrain/source/cpu/soil_machine/SoilMachine.cpp)
// ============================================================================
struct SoilSimulationConfig {
    int numParticles{800};
    int maxSteps{30};
    float sedimentCapacityFactor{0.35f};
    float erosionRate{0.22f};
    float depositionRate{0.25f};
    float friction{0.08f};
    float gravity{4.0f};
    uint32_t seed{777};
};

struct SoilSimulationResult {
    std::vector<float> sedimentMap;
    std::vector<float> waterTrackMap;
    int cols{0};
    int rows{0};
    float minX{0.0f};
    float minZ{0.0f};
    float step{1.0f};

    float sampleMoisture(float x, float z, float minXVal, float minZVal, float stepVal, int colsVal, int rowsVal) const {
        if (waterTrackMap.empty() || colsVal <= 1 || rowsVal <= 1) return 0.0f;
        float u = (x - minXVal) / stepVal;
        float v = (z - minZVal) / stepVal;

        int x0 = std::clamp(static_cast<int>(std::floor(u)), 0, colsVal - 2);
        int z0 = std::clamp(static_cast<int>(std::floor(v)), 0, rowsVal - 2);
        float fx = u - std::floor(u);
        float fz = v - std::floor(v);

        float w00 = waterTrackMap[z0 * colsVal + x0];
        float w10 = waterTrackMap[z0 * colsVal + (x0 + 1)];
        float w01 = waterTrackMap[(z0 + 1) * colsVal + x0];
        float w11 = waterTrackMap[(z0 + 1) * colsVal + (x0 + 1)];

        return math::lerp(math::lerp(w00, w10, fx), math::lerp(w01, w11, fx), fz);
    }

    float sampleSediment(float x, float z, float minXVal, float minZVal, float stepVal, int colsVal, int rowsVal) const {
        if (sedimentMap.empty() || colsVal <= 1 || rowsVal <= 1) return 0.0f;
        float u = (x - minXVal) / stepVal;
        float v = (z - minZVal) / stepVal;

        int x0 = std::clamp(static_cast<int>(std::floor(u)), 0, colsVal - 2);
        int z0 = std::clamp(static_cast<int>(std::floor(v)), 0, rowsVal - 2);
        float fx = u - std::floor(u);
        float fz = v - std::floor(v);

        float s00 = sedimentMap[z0 * colsVal + x0];
        float s10 = sedimentMap[z0 * colsVal + (x0 + 1)];
        float s01 = sedimentMap[(z0 + 1) * colsVal + x0];
        float s11 = sedimentMap[(z0 + 1) * colsVal + (x0 + 1)];

        return math::lerp(math::lerp(s00, s10, fx), math::lerp(s01, s11, fx), fz);
    }
};

class SoilMachineSedimentTracker {
public:
    static SoilSimulationResult runSimulation(
        int cols, int rows, float minX, float minZ, float step,
        const std::function<float(float, float)>& heightFn,
        const SoilSimulationConfig& cfg = {}
    ) {
        SoilSimulationResult res;
        res.cols = cols;
        res.rows = rows;
        res.minX = minX;
        res.minZ = minZ;
        res.step = step;
        res.sedimentMap.assign(cols * rows, 0.0f);
        res.waterTrackMap.assign(cols * rows, 0.0f);

        std::mt19937 rng(cfg.seed);
        std::uniform_real_distribution<float> distX(minX + step, minX + (cols - 2) * step);
        std::uniform_real_distribution<float> distZ(minZ + step, minZ + (rows - 2) * step);

        for (int p = 0; p < cfg.numParticles; ++p) {
            float px = distX(rng);
            float pz = distZ(rng);
            float vx = 0.0f, vz = 0.0f;
            float sediment = 0.0f;
            float water = 1.0f;

            for (int s = 0; s < cfg.maxSteps; ++s) {
                int cx = static_cast<int>((px - minX) / step);
                int cz = static_cast<int>((pz - minZ) / step);
                if (cx < 1 || cx >= cols - 1 || cz < 1 || cz >= rows - 1) break;

                // Accumulate water track intensity for humus tinting
                res.waterTrackMap[cz * cols + cx] += 0.045f * water;

                // Finite difference gradient
                float hL = heightFn(px - 0.2f, pz);
                float hR = heightFn(px + 0.2f, pz);
                float hD = heightFn(px, pz - 0.2f);
                float hU = heightFn(px, pz + 0.2f);

                float gx = (hR - hL) * 2.5f;
                float gz = (hU - hD) * 2.5f;

                vx = vx * (1.0f - cfg.friction) - gx * cfg.gravity * 0.016f;
                vz = vz * (1.0f - cfg.friction) - gz * cfg.gravity * 0.016f;

                float speed = std::sqrt(vx * vx + vz * vz);
                if (speed < 0.001f) break;

                px += (vx / speed) * step * 0.5f;
                pz += (vz / speed) * step * 0.5f;

                float capacity = std::max(0.01f, speed * cfg.sedimentCapacityFactor);
                if (sediment > capacity) {
                    float deposit = (sediment - capacity) * cfg.depositionRate;
                    sediment -= deposit;
                    res.sedimentMap[cz * cols + cx] += deposit;
                } else {
                    float erode = (capacity - sediment) * cfg.erosionRate;
                    sediment += erode;
                }

                water *= 0.96f; // Evaporation
            }
        }

        // Normalize maps to [0, 1] range
        float maxWater = 0.001f, maxSed = 0.001f;
        for (size_t i = 0; i < res.waterTrackMap.size(); ++i) {
            maxWater = std::max(maxWater, res.waterTrackMap[i]);
            maxSed = std::max(maxSed, res.sedimentMap[i]);
        }
        for (size_t i = 0; i < res.waterTrackMap.size(); ++i) {
            res.waterTrackMap[i] /= maxWater;
            res.sedimentMap[i] /= maxSed;
        }

        return res;
    }
};

// ============================================================================
// 3. Two-Stage Keypoint Proximity Clustered Scatter Engine
// (Derived from Princeton Infinigen assets/scatters/utils/cluster.py & density.py)
// ============================================================================
struct ClusterScatterConfig {
    int numKeypoints{16};
    float clusterRadius{3.5f};
    int instancesPerCluster{12};
    float minInstanceDistance{0.28f};
    float minSlopeAngleRad{0.0f};
    float maxSlopeAngleRad{0.68f}; // Face upward mask (N . Up >= cos(maxAngle))
    float minAltitude{-100.0f};
    float maxAltitude{100.0f};
    float normalPerturbRad{0.14f};
    uint32_t seed{42};
};

struct ScatterPoint {
    Vec3 position;
    Vec3 normal;
    Vec3 up;
    Vec3 tangent;
    float scale{1.0f};
    float clusterDistance{0.0f};
};

class KeypointClusterScatterEngine {
public:
    static std::vector<ScatterPoint> generateClusters(
        float minX, float maxX, float minZ, float maxZ,
        const std::function<float(float, float)>& heightFn,
        const std::function<Vec3(float, float)>& normalFn,
        const ClusterScatterConfig& cfg
    ) {
        std::vector<ScatterPoint> result;
        std::mt19937 rng(cfg.seed);

        // Pass 1: Sparse Keypoint Seeds (Colony Centers)
        std::uniform_real_distribution<float> distKpX(minX + cfg.clusterRadius, maxX - cfg.clusterRadius);
        std::uniform_real_distribution<float> distKpZ(minZ + cfg.clusterRadius, maxZ - cfg.clusterRadius);
        std::vector<Vec3> keypoints;

        for (int k = 0; k < cfg.numKeypoints; ++k) {
            float kx = distKpX(rng);
            float kz = distKpZ(rng);
            float ky = heightFn(kx, kz);
            Vec3 kn = normalFn(kx, kz);

            // Verify upward normal
            if (kn.dot(Vec3(0, 1, 0)) >= std::cos(cfg.maxSlopeAngleRad)) {
                keypoints.push_back(Vec3(kx, ky, kz));
            }
        }

        // Pass 2: Proximity-Based Instance Distribution around Keypoints
        std::uniform_real_distribution<float> distAngle(0.0f, math::TWO_PI);
        std::uniform_real_distribution<float> distJitter(-cfg.normalPerturbRad, cfg.normalPerturbRad);

        for (const auto& kp : keypoints) {
            for (int i = 0; i < cfg.instancesPerCluster; ++i) {
                // Sqrt distribution for uniform area disc sampling
                float rNorm = std::sqrt(static_cast<float>(i + 1) / static_cast<float>(cfg.instancesPerCluster));
                float r = rNorm * cfg.clusterRadius;
                float theta = distAngle(rng);

                float px = kp.x + r * std::cos(theta);
                float pz = kp.z + r * std::sin(theta);
                float py = heightFn(px, pz);

                // Altitude check
                if (py < cfg.minAltitude || py > cfg.maxAltitude) continue;

                Vec3 surfNorm = normalFn(px, pz);
                float slopeCos = surfNorm.dot(Vec3(0, 1, 0));
                if (slopeCos < std::cos(cfg.maxSlopeAngleRad)) continue;

                // Minimum distance Poisson rejection check
                bool tooClose = false;
                for (const auto& existing : result) {
                    if ((existing.position - Vec3(px, py, pz)).lengthSquared() < cfg.minInstanceDistance * cfg.minInstanceDistance) {
                        tooClose = true;
                        break;
                    }
                }
                if (tooClose) continue;

                // Pass 3: Perturbed Normal & Tangent Basis
                Vec3 pNorm = (surfNorm + Vec3(distJitter(rng), distJitter(rng), distJitter(rng))).normalized();
                Vec3 refUp = std::abs(pNorm.y) > 0.95f ? Vec3(0, 0, 1) : Vec3(0, 1, 0);
                Vec3 tangent = pNorm.cross(refUp).normalized();
                Vec3 bitangent = pNorm.cross(tangent).normalized();

                // Fractal azimuthal twist based on position (Infinigen z_rotation='musgrave')
                float azim = std::sin(px * 1.7f + pz * 2.3f) * math::PI;
                Vec3 rotatedTangent = tangent * std::cos(azim) + bitangent * std::sin(azim);

                ScatterPoint sp;
                sp.position = Vec3(px, py, pz);
                sp.normal = pNorm;
                sp.up = pNorm;
                sp.tangent = rotatedTangent;
                // Radial scale tapering (Infinigen scaling=eval_argument(distance))
                sp.scale = math::lerp(1.15f, 0.70f, r / cfg.clusterRadius);
                sp.clusterDistance = r;

                result.push_back(sp);
            }
        }

        return result;
    }
};

// ============================================================================
// 4. Volumetric 4-Sided Micro-Cone Conifer Needle Generator
// (Derived from Princeton Infinigen assets/leaves/leaf_pine.py)
// ============================================================================
class InfinigenNeedleConeGenerator {
public:
    /**
     * Constructs a physical, volumetric 4-sided tapered conifer needle micro-cone.
     * Replaces flat 2D cards with authentic 3D geometry possessing surface normals,
     * thickness, and dual-tone SSS base-to-tip gradient.
     */
    static ScratchboxMesh generateVolumetricNeedle(
        const Vec3& origin,
        const Vec3& direction,
        float length = 0.045f,
        float baseRadius = 0.0032f,
        float tipRadius = 0.0006f,
        const Vec4& baseColor = Vec4(0.18f, 0.44f, 0.12f, 1.0f),
        const Vec4& tipColor = Vec4(0.50f, 0.82f, 0.20f, 1.0f)
    ) {
        ScratchboxMesh mesh("InfinigenVolumetricNeedle");
        Vec3 dir = direction.normalized();
        Vec3 refUp = std::abs(dir.y) > 0.92f ? Vec3(1, 0, 0) : Vec3(0, 1, 0);
        Vec3 side = dir.cross(refUp).normalized();
        Vec3 up = side.cross(dir).normalized();

        Vec3 baseCenter = origin;
        Vec3 tipCenter = origin + dir * length;
        Vec3 apex = tipCenter + dir * (length * 0.08f);

        const int segs = 4; // 4-sided prismatic conifer needle cross-section
        uint32_t baseIdx = static_cast<uint32_t>(mesh.vertices.size());

        // Base ring vertices
        for (int i = 0; i < segs; ++i) {
            float angle = (static_cast<float>(i) / static_cast<float>(segs)) * math::TWO_PI;
            Vec3 radial = side * std::cos(angle) + up * std::sin(angle);
            mesh.addVertex(Vertex(baseCenter + radial * baseRadius, radial, Vec2(0, static_cast<float>(i) / segs), baseColor));
        }

        // Tip ring vertices
        uint32_t tipIdx = static_cast<uint32_t>(mesh.vertices.size());
        for (int i = 0; i < segs; ++i) {
            float angle = (static_cast<float>(i) / static_cast<float>(segs)) * math::TWO_PI;
            Vec3 radial = side * std::cos(angle) + up * std::sin(angle);
            mesh.addVertex(Vertex(tipCenter + radial * tipRadius, radial, Vec2(1, static_cast<float>(i) / segs), tipColor));
        }

        // Apex vertex
        uint32_t apexIdx = static_cast<uint32_t>(mesh.vertices.size());
        mesh.addVertex(Vertex(apex, dir, Vec2(1, 0.5f), tipColor));

        // Side faces
        for (int i = 0; i < segs; ++i) {
            int next = (i + 1) % segs;
            uint32_t b0 = baseIdx + i;
            uint32_t b1 = baseIdx + next;
            uint32_t t0 = tipIdx + i;
            uint32_t t1 = tipIdx + next;

            mesh.addTriangle(b0, t0, b1);
            mesh.addTriangle(b1, t0, t1);
            mesh.addTriangle(t0, apexIdx, t1); // Tip cap
        }

        return mesh;
    }
};

// ============================================================================
// 5. Curved Fern Pinnae Generator with Gravity Quadratic Sag
// (Derived from Princeton Infinigen assets/small_plants/fern.py)
// ============================================================================
class InfinigenFernPinnaeGenerator {
public:
    /**
     * Constructs an individual arching fern pinnae leaflet using Infinigen's
     * multi-point gravity rotation curve: [(0, 0), (0.2, 0.256), (0.48, 0.409), (0.78, 0.344), (1, 0)].
     */
    static ScratchboxMesh generateCurvedPinna(
        const Vec3& origin,
        const Vec3& forwardDir,
        const Vec3& surfaceNormal,
        float pinnaLength = 0.32f,
        float maxWidth = 0.075f,
        int segments = 6
    ) {
        ScratchboxMesh mesh("InfinigenFernPinna");
        Vec3 dir = forwardDir.normalized();
        Vec3 up = surfaceNormal.normalized();
        Vec3 side = dir.cross(up).normalized();

        const float curvePoints[5][2] = {
            {0.000f, 0.000f},
            {0.200f, 0.256f},
            {0.484f, 0.409f},
            {0.788f, 0.344f},
            {1.000f, 0.000f}
        };

        auto evaluateCurve = [&](float t) -> float {
            for (int i = 0; i < 4; ++i) {
                if (t >= curvePoints[i][0] && t <= curvePoints[i+1][0]) {
                    float f = (t - curvePoints[i][0]) / (curvePoints[i+1][0] - curvePoints[i][0]);
                    return math::lerp(curvePoints[i][1], curvePoints[i+1][1], f);
                }
            }
            return 0.0f;
        };

        for (int i = 0; i < segments; ++i) {
            float t0 = static_cast<float>(i) / static_cast<float>(segments);
            float t1 = static_cast<float>(i + 1) / static_cast<float>(segments);

            float sag0 = evaluateCurve(t0) * (pinnaLength * 0.22f);
            float sag1 = evaluateCurve(t1) * (pinnaLength * 0.22f);

            Vec3 p0Center = origin + dir * (pinnaLength * t0) - up * sag0;
            Vec3 p1Center = origin + dir * (pinnaLength * t1) - up * sag1;

            float w0 = maxWidth * (1.0f - std::pow(2.0f * t0 - 1.0f, 2.0f));
            float w1 = maxWidth * (1.0f - std::pow(2.0f * t1 - 1.0f, 2.0f));

            // Transferred normal for foliage translucency
            Vec3 n0 = (up + dir * 0.25f).normalized();
            Vec3 n1 = (up + dir * 0.25f).normalized();

            Vec4 col0(0.24f, 0.52f, 0.14f, 1.0f);
            Vec4 col1(0.42f, 0.76f, 0.18f, 1.0f);

            uint32_t idx = static_cast<uint32_t>(mesh.vertices.size());
            mesh.addVertex(Vertex(p0Center - side * w0, n0, Vec2(0, t0), col0));
            mesh.addVertex(Vertex(p0Center + side * w0, n0, Vec2(1, t0), col0));
            mesh.addVertex(Vertex(p1Center + side * w1, n1, Vec2(1, t1), col1));
            mesh.addVertex(Vertex(p1Center - side * w1, n1, Vec2(0, t1), col1));

            mesh.addTriangle(idx, idx + 1, idx + 2);
            mesh.addTriangle(idx, idx + 2, idx + 3);
        }

        return mesh;
    }
};

// ============================================================================
// 6. Procedural Dual-Tone Rhytidome / Bark Shader Kernel
// (Derived from Princeton Infinigen assets/materials/bark.py)
// ============================================================================
struct BarkShaderResult {
    Vec4 albedo;
    float roughness{0.90f};
    float metallic{0.01f};
    float heightDisplacement{0.0f};
};

class ProceduralRhytidomeShaderKernel {
public:
    static BarkShaderResult evaluate(const Vec3& objectPos, const Vec3& surfaceNormal) {
        BarkShaderResult res;
        // Directional anisotropic noise coordinates (scaled vertically Y x 5.0)
        float noiseY = objectPos.y * 5.0f;
        float noiseX = objectPos.x * 2.2f;
        float noiseZ = objectPos.z * 2.2f;

        float n1 = std::sin(noiseY * 1.5f + noiseX * 0.8f) * std::cos(noiseZ * 0.9f);
        float n2 = std::sin(noiseY * 3.8f) * std::cos(noiseX * 2.1f);
        float combinedNoise = (n1 * 0.65f + n2 * 0.35f) * 0.5f + 0.5f;

        // ColorRamp splitting: deep fissure crevice (Fac < 0.627) vs outer plateaus (Fac >= 0.63)
        if (combinedNoise < 0.627f) {
            // Deep damp fissure albedo (Infinigen: 0.02, 0.0091, 0.0016)
            res.albedo = Vec4(0.045f, 0.022f, 0.012f, 1.0f);
            res.roughness = 0.96f;
            res.heightDisplacement = -0.015f;
        } else {
            // Outer oxidized cork & bark plateau albedo (Infinigen: 0.224, 0.134, 0.100)
            float t = (combinedNoise - 0.627f) / (1.0f - 0.627f);
            res.albedo = math::lerp(Vec4(0.18f, 0.11f, 0.08f, 1.0f), Vec4(0.32f, 0.22f, 0.16f, 1.0f), t);
            res.roughness = math::lerp(0.90f, 0.72f, t);
            res.heightDisplacement = 0.008f * t;
        }

        return res;
    }
};

} // namespace infinigen
} // namespace scratchbox

#endif // SCRATCHBOX_INFINIGEN_HPP
