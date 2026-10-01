/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

#ifndef SCRATCHBOX_FRACTURE_HPP
#define SCRATCHBOX_FRACTURE_HPP

#include "scratchbox_math.hpp"
#include "scratchbox_geometry.hpp"
#include "scratchbox_lighting.hpp"

#include <vector>
#include <string>
#include <cmath>
#include <algorithm>
#include <memory>
#include <random>

namespace scratchbox {
namespace fracture {

using math::Vec2;
using math::Vec3;
using math::Vec4;
using math::Quat;
using math::Mat4;
using math::AABB;
using math::PI;
using math::TWO_PI;
using geometry::ScratchboxMesh;
using geometry::Vertex;
using geometry::PbrMaterial;

// ============================================================================
// 1. CONFIGURATIONS
// ============================================================================

struct GlassPaneConfig {
    float width{4.0f};                  // Total width in meters
    float height{3.0f};                 // Total height in meters
    float thickness{0.06f};             // Glass plate thickness in meters
    float frameThickness{0.18f};        // Border frame thickness
    float frameDepth{0.22f};            // Border frame depth
    int radialCrackCount{28};           // Number of radial fracture rays
    int concentricRings{5};             // Number of concentric fracture rings
    float innerCoreRadius{0.14f};       // Pulverized impact core hole
    float outerFractureRadius{1.45f};   // Boundary radius where glass remains anchored
};

struct BulletConfig {
    float caliber{0.12f};               // Projectile diameter (scaled for macro cinematic impact)
    float length{0.46f};                // Projectile length from tip to boat-tail base
    float speed{820.0f};                // Muzzle / impact velocity (m/s)
    Vec3 trajectoryDir{0.0f, 0.0f, 1.0f};
    Vec3 initialPosition{0.0f, 0.0f, -2.5f};
    float machNumber{2.4f};             // Supersonic Mach number
};

// ============================================================================
// 2. VORONOI GLASS SHARD WITH PHYSICAL DYNAMICS
// ============================================================================

struct VoronoiShard {
    int id{0};
    int ringIndex{0};
    int sectorIndex{0};
    Vec3 initialCentroid{0.0f, 0.0f, 0.0f};
    Vec3 currentCentroid{0.0f, 0.0f, 0.0f};
    Vec3 linearVelocity{0.0f, 0.0f, 0.0f};
    Vec3 angularVelocity{0.0f, 0.0f, 0.0f};
    Quat rotation{0.0f, 0.0f, 0.0f, 1.0f};
    float mass{0.05f};
    float thickness{0.06f};
    std::vector<Vec2> polygon2D;
    ScratchboxMesh localMesh;

    void update(float dt, const Vec3& gravity = {0.0f, -9.81f, 0.0f}) {
        linearVelocity = linearVelocity + gravity * dt;
        currentCentroid = currentCentroid + linearVelocity * dt;

        // Quaternion angular integration
        float spinSpeed = angularVelocity.length();
        if (spinSpeed > 1e-5f) {
            Vec3 axis = angularVelocity / spinSpeed;
            Quat dq = Quat::fromAxisAngle(axis, spinSpeed * dt);
            rotation = (dq * rotation).normalized();
        }
    }

    ScratchboxMesh getTransformedMesh() const {
        ScratchboxMesh result = localMesh;
        for (auto& v : result.vertices) {
            // Rotate local vertex relative to centroid
            Vec3 p = rotation.rotate(v.position);
            v.position = currentCentroid + p;
            v.normal = rotation.rotate(v.normal).normalized();
        }
        result.recomputeBounds();
        return result;
    }
};

// ============================================================================
// 3. FRACTURE GENERATOR & SIMULATOR
// ============================================================================

class GlassFractureGenerator {
public:
    /**
     * Constructs the heavy architectural perimeter frame with beveled steel clamps.
     */
    static ScratchboxMesh generateFrame(const GlassPaneConfig& cfg) {
        ScratchboxMesh frame;
        frame.name = "architectural_frame";
        frame.material = PbrMaterial::titanium();
        frame.material.roughnessFactor = 0.35f;
        frame.material.metallicFactor = 0.85f;
        frame.material.baseColorFactor = Vec4(0.22f, 0.24f, 0.28f, 1.0f);

        float hw = cfg.width * 0.5f;
        float hh = cfg.height * 0.5f;
        float ft = cfg.frameThickness;
        float fd = cfg.frameDepth;
        float zBack = -fd * 0.5f;
        float zFront = fd * 0.5f;

        // Outer bounds: [-hw-ft, hw+ft] x [-hh-ft, hh+ft]
        // Inner bounds: [-hw, hw] x [-hh, hh]
        auto addBeam = [&](const Vec3& minP, const Vec3& maxP) {
            // 8 Box corners
            std::vector<Vec3> corners = {
                {minP.x, minP.y, minP.z}, {maxP.x, minP.y, minP.z},
                {maxP.x, maxP.y, minP.z}, {minP.x, maxP.y, minP.z},
                {minP.x, minP.y, maxP.z}, {maxP.x, minP.y, maxP.z},
                {maxP.x, maxP.y, maxP.z}, {minP.x, maxP.y, maxP.z}
            };
            // 6 Faces
            static const int faceIndices[6][4] = {
                {0, 3, 2, 1}, // Back (-Z)
                {4, 5, 6, 7}, // Front (+Z)
                {0, 1, 5, 4}, // Bottom (-Y)
                {2, 3, 7, 6}, // Top (+Y)
                {0, 4, 7, 3}, // Left (-X)
                {1, 2, 6, 5}  // Right (+X)
            };
            static const Vec3 faceNormals[6] = {
                {0, 0, -1}, {0, 0, 1}, {0, -1, 0}, {0, 1, 0}, {-1, 0, 0}, {1, 0, 0}
            };

            for (int f = 0; f < 6; ++f) {
                uint32_t fStart = static_cast<uint32_t>(frame.vertices.size());
                for (int i = 0; i < 4; ++i) {
                    Vertex v;
                    v.position = corners[faceIndices[f][i]];
                    v.normal = faceNormals[f];
                    v.uv = Vec2(i == 1 || i == 2 ? 1.0f : 0.0f, i >= 2 ? 1.0f : 0.0f);
                    v.color = Vec4(0.28f, 0.30f, 0.35f, 1.0f);
                    frame.vertices.push_back(v);
                }
                frame.indices.push_back(fStart);
                frame.indices.push_back(fStart + 1);
                frame.indices.push_back(fStart + 2);
                frame.indices.push_back(fStart);
                frame.indices.push_back(fStart + 2);
                frame.indices.push_back(fStart + 3);
            }
        };

        // Top, Bottom, Left, Right Beams
        addBeam({-hw - ft, hh, zBack}, {hw + ft, hh + ft, zFront});         // Top
        addBeam({-hw - ft, -hh - ft, zBack}, {hw + ft, -hh, zFront});       // Bottom
        addBeam({-hw - ft, -hh, zBack}, {-hw, hh, zFront});                 // Left
        addBeam({hw, -hh, zBack}, {hw + ft, hh, zFront});                  // Right

        frame.recomputeBounds();
        return frame;
    }

    /**
     * Constructs the outer intact plate glass bordering the frame up to outerFractureRadius.
     */
    static ScratchboxMesh generateIntactGlassPerimeter(const GlassPaneConfig& cfg, float innerFractureRadius) {
        ScratchboxMesh intact;
        intact.name = "intact_glass_perimeter";
        intact.material = PbrMaterial::opticalGlass();

        float hw = cfg.width * 0.5f;
        float hh = cfg.height * 0.5f;
        float hz = cfg.thickness * 0.5f;
        int radialSegs = cfg.radialCrackCount;

        std::vector<Vec2> innerCrackLoop;
        innerCrackLoop.reserve(radialSegs);
        for (int i = 0; i < radialSegs; ++i) {
            float angle = (static_cast<float>(i) / radialSegs) * TWO_PI;
            // Add crack edge perturbation
            float jitter = 1.0f + 0.12f * std::sin(angle * 7.0f) + 0.08f * std::cos(angle * 13.0f);
            float r = innerFractureRadius * jitter;
            innerCrackLoop.push_back(Vec2(std::cos(angle) * r, std::sin(angle) * r));
        }

        // Extrude perimeter rim from front (+hz) to back (-hz)
        for (int zSign : {1, -1}) {
            float z = zSign * hz;
            Vec3 norm = {0.0f, 0.0f, static_cast<float>(zSign)};
            uint32_t startV = static_cast<uint32_t>(intact.vertices.size());

            // Add inner crack boundary vertices
            for (size_t i = 0; i < innerCrackLoop.size(); ++i) {
                Vertex v;
                v.position = Vec3(innerCrackLoop[i].x, innerCrackLoop[i].y, z);
                v.normal = norm;
                v.uv = Vec2(innerCrackLoop[i].x / cfg.width + 0.5f, innerCrackLoop[i].y / cfg.height + 0.5f);
                v.color = Vec4(0.92f, 0.96f, 1.0f, 0.35f);
                intact.vertices.push_back(v);
            }

            // Add outer boundary vertices (approximate rectangle with radial projection)
            for (size_t i = 0; i < innerCrackLoop.size(); ++i) {
                float angle = (static_cast<float>(i) / radialSegs) * TWO_PI;
                float cosA = std::cos(angle);
                float sinA = std::sin(angle);
                float tX = (cosA > 1e-4f ? hw / cosA : (cosA < -1e-4f ? -hw / cosA : 1e6f));
                float tY = (sinA > 1e-4f ? hh / sinA : (sinA < -1e-4f ? -hh / sinA : 1e6f));
                float t = std::min(std::abs(tX), std::abs(tY));
                Vec2 outerP = Vec2(cosA * t, sinA * t);

                Vertex v;
                v.position = Vec3(outerP.x, outerP.y, z);
                v.normal = norm;
                v.uv = Vec2(outerP.x / cfg.width + 0.5f, outerP.y / cfg.height + 0.5f);
                v.color = Vec4(0.92f, 0.96f, 1.0f, 0.35f);
                intact.vertices.push_back(v);
            }

            // Stitch quads between inner crack loop and outer boundary
            size_t n = innerCrackLoop.size();
            for (size_t i = 0; i < n; ++i) {
                uint32_t in0 = startV + static_cast<uint32_t>(i);
                uint32_t in1 = startV + static_cast<uint32_t>((i + 1) % n);
                uint32_t out0 = startV + static_cast<uint32_t>(n + i);
                uint32_t out1 = startV + static_cast<uint32_t>(n + (i + 1) % n);

                if (zSign > 0) {
                    intact.indices.push_back(in0);
                    intact.indices.push_back(out0);
                    intact.indices.push_back(out1);
                    intact.indices.push_back(in0);
                    intact.indices.push_back(out1);
                    intact.indices.push_back(in1);
                } else {
                    intact.indices.push_back(in0);
                    intact.indices.push_back(out1);
                    intact.indices.push_back(out0);
                    intact.indices.push_back(in0);
                    intact.indices.push_back(in1);
                    intact.indices.push_back(out1);
                }
            }
        }

        // Inner jagged crack rim side-walls
        size_t n = innerCrackLoop.size();
        for (size_t i = 0; i < n; ++i) {
            Vec2 p0 = innerCrackLoop[i];
            Vec2 p1 = innerCrackLoop[(i + 1) % n];
            Vec2 edgeDir = (p1 - p0).normalized();
            Vec2 wallNorm2D = Vec2(-edgeDir.y, edgeDir.x);
            Vec3 wallNorm = Vec3(wallNorm2D.x, wallNorm2D.y, 0.0f);

            uint32_t startIdx = static_cast<uint32_t>(intact.vertices.size());
            Vertex v0({p0.x, p0.y, hz}, wallNorm, {0, 0}, {0.96f, 0.98f, 1.0f, 0.7f});
            Vertex v1({p1.x, p1.y, hz}, wallNorm, {1, 0}, {0.96f, 0.98f, 1.0f, 0.7f});
            Vertex v2({p1.x, p1.y, -hz}, wallNorm, {1, 1}, {0.96f, 0.98f, 1.0f, 0.7f});
            Vertex v3({p0.x, p0.y, -hz}, wallNorm, {0, 1}, {0.96f, 0.98f, 1.0f, 0.7f});

            intact.vertices.push_back(v0);
            intact.vertices.push_back(v1);
            intact.vertices.push_back(v2);
            intact.vertices.push_back(v3);

            intact.indices.push_back(startIdx);
            intact.indices.push_back(startIdx + 1);
            intact.indices.push_back(startIdx + 2);
            intact.indices.push_back(startIdx);
            intact.indices.push_back(startIdx + 2);
            intact.indices.push_back(startIdx + 3);
        }

        intact.recomputeBounds();
        return intact;
    }

    /**
     * Generates dynamic 3D Voronoi shards inside the fracture zone with initial ejection momentum.
     */
    static std::vector<VoronoiShard> generateVoronoiShards(const GlassPaneConfig& pane, const BulletConfig& bullet) {
        std::vector<VoronoiShard> shards;
        int rings = pane.concentricRings;
        int sectors = pane.radialCrackCount;
        float rCore = pane.innerCoreRadius;
        float rMax = pane.outerFractureRadius;
        float hz = pane.thickness * 0.5f;

        // Generate logarithmic radius boundaries: rCore -> rMax
        std::vector<float> ringRadii;
        ringRadii.reserve(rings + 1);
        for (int r = 0; r <= rings; ++r) {
            float t = static_cast<float>(r) / rings;
            float radius = rCore + (rMax - rCore) * std::pow(t, 1.6f);
            ringRadii.push_back(radius);
        }

        int shardCount = 0;
        for (int r = 0; r < rings; ++r) {
            float r0 = ringRadii[r];
            float r1 = ringRadii[r + 1];
            int currentSectors = std::max(8, sectors - r * 3);

            for (int s = 0; s < currentSectors; ++s) {
                float a0 = (static_cast<float>(s) / currentSectors) * TWO_PI;
                float a1 = (static_cast<float>(s + 1) / currentSectors) * TWO_PI;

                auto jitterPt = [&](float rad, float ang) -> Vec2 {
                    float jRad = rad * (1.0f + 0.08f * std::sin(ang * 11.0f + r * 3.1f));
                    float jAng = ang + (0.04f * std::cos(rad * 9.0f + s * 2.3f));
                    return Vec2(std::cos(jAng) * jRad, std::sin(jAng) * jRad);
                };

                Vec2 p0 = jitterPt(r0, a0); // Inner-Start
                Vec2 p1 = jitterPt(r0, a1); // Inner-End
                Vec2 p2 = jitterPt(r1, a1); // Outer-End
                Vec2 p3 = jitterPt(r1, a0); // Outer-Start

                Vec2 centroid2D = (p0 + p1 + p2 + p3) * 0.25f;
                float distFromCenter = centroid2D.length();

                VoronoiShard shard;
                shard.id = shardCount++;
                shard.ringIndex = r;
                shard.sectorIndex = s;
                shard.initialCentroid = Vec3(centroid2D.x, centroid2D.y, 0.0f);
                shard.currentCentroid = shard.initialCentroid;
                shard.thickness = pane.thickness;
                shard.polygon2D = {p0, p1, p2, p3};

                // Ballistic momentum transfer:
                float forwardDecay = std::exp(-distFromCenter / 0.55f);
                float fwdSpeed = bullet.speed * 0.045f * forwardDecay + 8.0f * (1.0f - distFromCenter / rMax);

                Vec2 radDir = distFromCenter > 1e-4f ? (centroid2D / distFromCenter) : Vec2(1, 0);
                float radSpeed = 16.0f * (1.0f / (1.0f + distFromCenter * 2.2f));

                float turbX = 2.5f * std::sin(static_cast<float>(shard.id) * 4.7f);
                float turbY = 2.5f * std::cos(static_cast<float>(shard.id) * 3.9f);

                shard.linearVelocity = Vec3(
                    radDir.x * radSpeed + turbX,
                    radDir.y * radSpeed + turbY,
                    fwdSpeed
                );

                Vec3 rArm(radDir.x, radDir.y, 0.0f);
                Vec3 spinAxis = rArm.cross({0, 0, 1}).normalized();
                float spinRate = (35.0f / (0.2f + distFromCenter)) + (shard.id % 5) * 4.0f;
                shard.angularVelocity = spinAxis * spinRate;

                // Build local 3D extruded prism mesh relative to centroid2D
                ScratchboxMesh mesh;
                mesh.name = "shard_" + std::to_string(shard.id);
                mesh.material = PbrMaterial::opticalGlass();

                std::vector<Vec2> localPoly = {
                    p0 - centroid2D, p1 - centroid2D, p2 - centroid2D, p3 - centroid2D
                };

                // Front face (+hz)
                uint32_t fStart = static_cast<uint32_t>(mesh.vertices.size());
                for (int i = 0; i < 4; ++i) {
                    mesh.vertices.push_back(Vertex(
                        Vec3(localPoly[i].x, localPoly[i].y, hz),
                        Vec3(0, 0, 1),
                        Vec2(i == 1 || i == 2 ? 1.0f : 0.0f, i >= 2 ? 1.0f : 0.0f),
                        Vec4(0.95f, 0.98f, 1.0f, 0.25f)
                    ));
                }
                mesh.indices.push_back(fStart);
                mesh.indices.push_back(fStart + 1);
                mesh.indices.push_back(fStart + 2);
                mesh.indices.push_back(fStart);
                mesh.indices.push_back(fStart + 2);
                mesh.indices.push_back(fStart + 3);

                // Back face (-hz)
                uint32_t bStart = static_cast<uint32_t>(mesh.vertices.size());
                for (int i = 0; i < 4; ++i) {
                    mesh.vertices.push_back(Vertex(
                        Vec3(localPoly[i].x, localPoly[i].y, -hz),
                        Vec3(0, 0, -1),
                        Vec2(i == 1 || i == 2 ? 1.0f : 0.0f, i >= 2 ? 1.0f : 0.0f),
                        Vec4(0.95f, 0.98f, 1.0f, 0.25f)
                    ));
                }
                mesh.indices.push_back(bStart);
                mesh.indices.push_back(bStart + 2);
                mesh.indices.push_back(bStart + 1);
                mesh.indices.push_back(bStart);
                mesh.indices.push_back(bStart + 3);
                mesh.indices.push_back(bStart + 2);

                // 4 Side wall facets with razor-sharp planar normals
                for (int i = 0; i < 4; ++i) {
                    int next = (i + 1) % 4;
                    Vec2 edge = localPoly[next] - localPoly[i];
                    Vec2 n2D = Vec2(-edge.y, edge.x).normalized();
                    Vec3 wallNorm(n2D.x, n2D.y, 0.0f);

                    uint32_t wStart = static_cast<uint32_t>(mesh.vertices.size());
                    mesh.vertices.push_back(Vertex({localPoly[i].x, localPoly[i].y, hz}, wallNorm, {0, 0}, {0.96f, 0.99f, 1.0f, 0.85f}));
                    mesh.vertices.push_back(Vertex({localPoly[next].x, localPoly[next].y, hz}, wallNorm, {1, 0}, {0.96f, 0.99f, 1.0f, 0.85f}));
                    mesh.vertices.push_back(Vertex({localPoly[next].x, localPoly[next].y, -hz}, wallNorm, {1, 1}, {0.96f, 0.99f, 1.0f, 0.85f}));
                    mesh.vertices.push_back(Vertex({localPoly[i].x, localPoly[i].y, -hz}, wallNorm, {0, 1}, {0.96f, 0.99f, 1.0f, 0.85f}));

                    mesh.indices.push_back(wStart);
                    mesh.indices.push_back(wStart + 1);
                    mesh.indices.push_back(wStart + 2);
                    mesh.indices.push_back(wStart);
                    mesh.indices.push_back(wStart + 2);
                    mesh.indices.push_back(wStart + 3);
                }

                mesh.recomputeBounds();
                shard.localMesh = mesh;
                shards.push_back(shard);
            }
        }

        return shards;
    }

    /**
     * Constructs aerodynamic copper-jacketed spitzer bullet projectile.
     */
    static ScratchboxMesh generateBulletMesh(const BulletConfig& cfg, const Vec3& pos) {
        ScratchboxMesh bullet;
        bullet.name = "spitzer_bullet_projectile";
        bullet.material = PbrMaterial::copperBullet();

        const int slices = 20;
        const int rings = 14;
        float r = cfg.caliber * 0.5f;
        float l = cfg.length;

        std::vector<float> zOffsets;
        std::vector<float> radii;

        for (int i = 0; i <= rings; ++i) {
            float t = static_cast<float>(i) / rings;
            float z = (t - 0.5f) * l;
            float currentRadius = 0.0f;

            if (t > 0.45f) {
                float ot = (t - 0.45f) / 0.55f;
                currentRadius = r * std::sqrt(std::max(0.0f, 1.0f - ot * ot));
            } else if (t > 0.15f) {
                currentRadius = r;
            } else {
                float bt = t / 0.15f;
                currentRadius = r * (0.75f + 0.25f * bt);
            }

            zOffsets.push_back(z);
            radii.push_back(currentRadius);
        }

        for (int i = 0; i <= rings; ++i) {
            float z = zOffsets[i];
            float currR = radii[i];
            for (int j = 0; j <= slices; ++j) {
                float phi = (static_cast<float>(j) / slices) * TWO_PI;
                float cosP = std::cos(phi);
                float sinP = std::sin(phi);

                Vec3 localP(cosP * currR, sinP * currR, z);
                Vec3 norm = Vec3(cosP, sinP, (i == rings ? 1.0f : (i == 0 ? -1.0f : 0.1f))).normalized();

                Vertex v;
                v.position = pos + localP;
                v.normal = norm;
                v.uv = Vec2(static_cast<float>(j) / slices, static_cast<float>(i) / rings);
                v.color = Vec4(0.96f, 0.68f, 0.52f, 1.0f);
                bullet.vertices.push_back(v);
            }
        }

        for (int i = 0; i < rings; ++i) {
            for (int j = 0; j < slices; ++j) {
                uint32_t a = static_cast<uint32_t>(i * (slices + 1) + j);
                uint32_t b = static_cast<uint32_t>((i + 1) * (slices + 1) + j);
                uint32_t c = static_cast<uint32_t>((i + 1) * (slices + 1) + (j + 1));
                uint32_t d = static_cast<uint32_t>(i * (slices + 1) + (j + 1));

                bullet.indices.push_back(a);
                bullet.indices.push_back(b);
                bullet.indices.push_back(c);
                bullet.indices.push_back(a);
                bullet.indices.push_back(c);
                bullet.indices.push_back(d);
            }
        }

        bullet.recomputeBounds();
        return bullet;
    }

    /**
     * Constructs supersonic Mach cone shockwave mesh trailing behind the bullet.
     */
    static ScratchboxMesh generateSupersonicMachCone(const BulletConfig& cfg, const Vec3& bulletPos) {
        ScratchboxMesh cone;
        cone.name = "supersonic_mach_shockwave";
        cone.material = PbrMaterial::emissiveGlow({0.45f, 0.85f, 1.0f}, 2.5f);
        cone.material.transmissionFactor = 0.92f;
        cone.material.roughnessFactor = 0.05f;

        float machAngle = std::asin(1.0f / cfg.machNumber);
        float coneLength = 1.8f;
        float baseRadius = coneLength * std::tan(machAngle);
        int slices = 24;

        Vec3 tipPos = bulletPos + Vec3(0, 0, cfg.length * 0.5f);
        Vec3 baseCenter = tipPos - Vec3(0, 0, coneLength);

        uint32_t tipIdx = static_cast<uint32_t>(cone.vertices.size());
        cone.vertices.push_back(Vertex(tipPos, {0, 0, 1}, {0.5f, 1.0f}, {0.7f, 0.92f, 1.0f, 0.75f}));

        uint32_t baseStart = static_cast<uint32_t>(cone.vertices.size());
        for (int i = 0; i <= slices; ++i) {
            float phi = (static_cast<float>(i) / slices) * TWO_PI;
            float cosP = std::cos(phi);
            float sinP = std::sin(phi);
            Vec3 p = baseCenter + Vec3(cosP * baseRadius, sinP * baseRadius, 0.0f);
            Vec3 norm = Vec3(cosP, sinP, std::sin(machAngle)).normalized();

            cone.vertices.push_back(Vertex(p, norm, {static_cast<float>(i) / slices, 0.0f}, {0.4f, 0.75f, 1.0f, 0.12f}));
        }

        for (int i = 0; i < slices; ++i) {
            cone.indices.push_back(tipIdx);
            cone.indices.push_back(baseStart + i);
            cone.indices.push_back(baseStart + i + 1);
        }

        cone.recomputeBounds();
        return cone;
    }

    /**
     * Constructs pulverized micro-glass crystals and fiery friction sparks at impact zone.
     */
    static ScratchboxMesh generateGlassDustAndSparks(const Vec3& impactCenter, int count = 96) {
        ScratchboxMesh sparks;
        sparks.name = "impact_micro_sparks";
        sparks.material = PbrMaterial::emissiveGlow({1.0f, 0.78f, 0.35f}, 5.0f);

        for (int i = 0; i < count; ++i) {
            float u = static_cast<float>(i) / count;
            float phi = u * 47.3f;
            float costheta = 1.0f - 2.0f * (static_cast<float>((i * 17) % count) / count);
            float sintheta = std::sqrt(std::max(0.0f, 1.0f - costheta * costheta));

            float dist = 0.08f + 0.65f * (static_cast<float>((i * 31) % 100) / 100.0f);
            Vec3 dir(sintheta * std::cos(phi), sintheta * std::sin(phi), std::abs(costheta) * 0.8f + 0.2f);
            Vec3 pt = impactCenter + dir * dist;

            float sz = 0.015f + 0.02f * (i % 3);
            uint32_t sIdx = static_cast<uint32_t>(sparks.vertices.size());

            sparks.vertices.push_back(Vertex(pt + Vec3(0, sz, 0), {0, 1, 0}, {0.5f, 1.0f}, {1.0f, 0.85f, 0.4f, 1.0f}));
            sparks.vertices.push_back(Vertex(pt + Vec3(-sz, -sz, sz), {-1, -1, 1}, {0, 0}, {1.0f, 0.7f, 0.2f, 1.0f}));
            sparks.vertices.push_back(Vertex(pt + Vec3(sz, -sz, sz), {1, -1, 1}, {1, 0}, {1.0f, 0.7f, 0.2f, 1.0f}));
            sparks.vertices.push_back(Vertex(pt + Vec3(0, -sz, -sz), {0, -1, -1}, {0.5f, 0}, {1.0f, 0.9f, 0.5f, 1.0f}));

            sparks.indices.push_back(sIdx); sparks.indices.push_back(sIdx + 1); sparks.indices.push_back(sIdx + 2);
            sparks.indices.push_back(sIdx); sparks.indices.push_back(sIdx + 2); sparks.indices.push_back(sIdx + 3);
            sparks.indices.push_back(sIdx); sparks.indices.push_back(sIdx + 3); sparks.indices.push_back(sIdx + 1);
            sparks.indices.push_back(sIdx + 1); sparks.indices.push_back(sIdx + 3); sparks.indices.push_back(sIdx + 2);
        }

        sparks.recomputeBounds();
        return sparks;
    }

    /**
     * Builds the complete assembled scene at simulation time t (e.g. t = 0.08s peak blowout).
     */
    static ScratchboxMesh buildCompleteScene(const GlassPaneConfig& pane, const BulletConfig& bullet, float simulationTime = 0.08f) {
        ScratchboxMesh scene;
        scene.name = "bullet_glass_shatter_scene";
        scene.material = PbrMaterial::opticalGlass();

        // 1. Frame
        ScratchboxMesh frame = generateFrame(pane);
        scene.append(frame);

        // 2. Intact Glass Perimeter
        ScratchboxMesh intact = generateIntactGlassPerimeter(pane, pane.outerFractureRadius);
        scene.append(intact);

        // 3. Voronoi Shards evaluated at simulationTime
        std::vector<VoronoiShard> shards = generateVoronoiShards(pane, bullet);
        for (auto& shard : shards) {
            shard.update(simulationTime);
            ScratchboxMesh transformedShard = shard.getTransformedMesh();
            scene.append(transformedShard);
        }

        // 4. Bullet Projectile Position at simulationTime
        Vec3 bulletPos = Vec3(0.0f, 0.0f, bullet.speed * 0.0035f * simulationTime + 0.12f);
        ScratchboxMesh bulletMesh = generateBulletMesh(bullet, bulletPos);
        scene.append(bulletMesh);

        // 5. Supersonic Mach Shockwave Cone
        ScratchboxMesh shockwave = generateSupersonicMachCone(bullet, bulletPos);
        scene.append(shockwave);

        // 6. Impact Dust & Sparks
        ScratchboxMesh sparks = generateGlassDustAndSparks({0, 0, 0.05f}, 80);
        scene.append(sparks);

        scene.recomputeBounds();
        return scene;
    }
};

} // namespace fracture
} // namespace scratchbox

#endif // SCRATCHBOX_FRACTURE_HPP
