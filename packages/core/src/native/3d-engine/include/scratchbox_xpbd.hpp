/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

#ifndef SCRATCHBOX_XPBD_HPP
#define SCRATCHBOX_XPBD_HPP

#include "scratchbox_math.hpp"
#include "scratchbox_geometry.hpp"

#include <vector>
#include <unordered_map>
#include <cmath>
#include <algorithm>
#include <cstdint>

namespace scratchbox {
namespace xpbd {

using math::Vec2;
using math::Vec3;
using math::Vec4;
using geometry::ScratchboxMesh;
using geometry::Vertex;

// ============================================================================
// 1. XPBD PARTICLE
// ============================================================================
struct XpbdParticle {
    Vec3 position{0.0f, 0.0f, 0.0f};
    Vec3 prevPosition{0.0f, 0.0f, 0.0f};
    Vec3 velocity{0.0f, 0.0f, 0.0f};
    float invMass{1.0f}; // 0.0f indicates pinned / fixed vertex

    XpbdParticle() = default;
    XpbdParticle(const Vec3& p, float mass = 1.0f)
        : position(p), prevPosition(p), velocity(0, 0, 0) {
        invMass = mass > 0.0f ? 1.0f / mass : 0.0f;
    }
};

// ============================================================================
// 2. CONSTRAINTS (STRETCH, SHEAR, ISOMETRIC DIHEDRAL BENDING)
// ============================================================================
struct DistanceConstraint {
    uint32_t p0{0};
    uint32_t p1{0};
    float restLength{0.0f};
    float compliance{1e-6f}; // m / N (stretching compliance)
    float lambda{0.0f};      // Accumulated Lagrange multiplier

    DistanceConstraint(uint32_t a, uint32_t b, float len, float comp = 1e-6f)
        : p0(a), p1(b), restLength(len), compliance(comp), lambda(0.0f) {}

    void solve(std::vector<XpbdParticle>& particles, float dt) {
        float w0 = particles[p0].invMass;
        float w1 = particles[p1].invMass;
        float wSum = w0 + w1;
        if (wSum < 1e-8f) return;

        Vec3 diff = particles[p0].position - particles[p1].position;
        float currentLen = diff.length();
        if (currentLen < 1e-6f) return;

        float C = currentLen - restLength;
        Vec3 n = diff * (1.0f / currentLen);

        float alphaTilde = compliance / (dt * dt);
        float deltaLambda = (-C - alphaTilde * lambda) / (wSum + alphaTilde);
        lambda += deltaLambda;

        Vec3 deltaP = n * deltaLambda;
        if (w0 > 0.0f) particles[p0].position = particles[p0].position + deltaP * w0;
        if (w1 > 0.0f) particles[p1].position = particles[p1].position - deltaP * w1;
    }
};

struct DihedralBendingConstraint {
    uint32_t p0{0}; // Shared edge vertex 0
    uint32_t p1{0}; // Shared edge vertex 1
    uint32_t p2{0}; // Wing vertex on triangle 1
    uint32_t p3{0}; // Wing vertex on triangle 2
    float restDistance{0.0f};
    float compliance{1e-4f}; // rad / N
    float lambda{0.0f};

    DihedralBendingConstraint(uint32_t e0, uint32_t e1, uint32_t w0, uint32_t w1, float dist, float comp = 1e-4f)
        : p0(e0), p1(e1), p2(w0), p3(w1), restDistance(dist), compliance(comp), lambda(0.0f) {}

    void solve(std::vector<XpbdParticle>& particles, float dt) {
        float w2 = particles[p2].invMass;
        float w3 = particles[p3].invMass;
        float wSum = w2 + w3;
        if (wSum < 1e-8f) return;

        Vec3 diff = particles[p2].position - particles[p3].position;
        float currentDist = diff.length();
        if (currentDist < 1e-6f) return;

        float C = currentDist - restDistance;
        Vec3 n = diff * (1.0f / currentDist);

        float alphaTilde = compliance / (dt * dt);
        float deltaLambda = (-C - alphaTilde * lambda) / (wSum + alphaTilde);
        lambda += deltaLambda;

        Vec3 deltaP = n * deltaLambda;
        if (w2 > 0.0f) particles[p2].position = particles[p2].position + deltaP * w2;
        if (w3 > 0.0f) particles[p3].position = particles[p3].position - deltaP * w3;
    }
};

// ============================================================================
// 3. COLLISION OBSTACLES
// ============================================================================
struct SphereObstacle {
    Vec3 center{0, 0, 0};
    float radius{1.0f};

    void resolve(XpbdParticle& p, float thickness = 0.02f) const {
        if (p.invMass == 0.0f) return;
        Vec3 diff = p.position - center;
        float d = diff.length();
        float targetR = radius + thickness;
        if (d < targetR) {
            Vec3 normal = d > 1e-6f ? diff * (1.0f / d) : Vec3(0, 1, 0);
            p.position = center + normal * targetR;
        }
    }
};

struct GroundPlaneObstacle {
    float yLevel{0.0f};
    float friction{0.4f};

    void resolve(XpbdParticle& p, float thickness = 0.01f) const {
        if (p.invMass == 0.0f) return;
        if (p.position.y < yLevel + thickness) {
            p.position.y = yLevel + thickness;

            // Apply ground contact friction to prevent lateral sliding
            Vec3 disp = p.position - p.prevPosition;
            disp.x *= (1.0f - friction);
            disp.z *= (1.0f - friction);
            p.position.x = p.prevPosition.x + disp.x;
            p.position.z = p.prevPosition.z + disp.z;
        }
    }
};

// ============================================================================
// 4. XPBD CLOTH SIMULATOR
// ============================================================================
class XpbdClothSimulator {
public:
    std::vector<XpbdParticle> particles;
    std::vector<DistanceConstraint> stretchConstraints;
    std::vector<DihedralBendingConstraint> bendingConstraints;

    std::vector<SphereObstacle> sphereObstacles;
    std::vector<GroundPlaneObstacle> groundObstacles;

    Vec3 gravity{0.0f, -9.81f, 0.0f};
    Vec3 windForce{0.0f, 0.0f, 0.0f};
    float damping{0.992f};

    XpbdClothSimulator() = default;

    // Initialize cloth mesh directly from ScratchboxMesh
    void initFromMesh(const ScratchboxMesh& mesh, float particleMass = 0.1f, float stretchComp = 1e-6f, float bendComp = 1e-4f) {
        particles.clear();
        stretchConstraints.clear();
        bendingConstraints.clear();

        particles.reserve(mesh.vertices.size());
        for (const auto& v : mesh.vertices) {
            particles.push_back(XpbdParticle(v.position, particleMass));
        }

        // Map edges to avoid duplicates and detect adjacent triangles for bending
        struct Edge {
            uint32_t a, b;
            bool operator==(const Edge& o) const {
                return (a == o.a && b == o.b) || (a == o.b && b == o.a);
            }
        };

        struct EdgeHash {
            size_t operator()(const Edge& e) const {
                uint32_t minV = std::min(e.a, e.b);
                uint32_t maxV = std::max(e.a, e.b);
                return (static_cast<size_t>(minV) << 32) | maxV;
            }
        };

        struct EdgeData {
            uint32_t tri0{0xFFFFFFFF};
            uint32_t tri1{0xFFFFFFFF};
            uint32_t opp0{0xFFFFFFFF};
            uint32_t opp1{0xFFFFFFFF};
        };

        std::unordered_map<Edge, EdgeData, EdgeHash> edgeMap;

        size_t triCount = mesh.indices.size() / 3;
        for (size_t t = 0; t < triCount; ++t) {
            uint32_t i0 = mesh.indices[t * 3];
            uint32_t i1 = mesh.indices[t * 3 + 1];
            uint32_t i2 = mesh.indices[t * 3 + 2];

            uint32_t triEdges[3][3] = {
                {i0, i1, i2},
                {i1, i2, i0},
                {i2, i0, i1}
            };

            for (int e = 0; e < 3; ++e) {
                Edge edge{triEdges[e][0], triEdges[e][1]};
                auto it = edgeMap.find(edge);
                if (it == edgeMap.end()) {
                    EdgeData data;
                    data.tri0 = static_cast<uint32_t>(t);
                    data.opp0 = triEdges[e][2];
                    edgeMap[edge] = data;
                } else {
                    it->second.tri1 = static_cast<uint32_t>(t);
                    it->second.opp1 = triEdges[e][2];
                }
            }
        }

        // Generate Stretch & Bending Constraints
        for (const auto& pair : edgeMap) {
            const Edge& edge = pair.first;
            const EdgeData& data = pair.second;

            float len = (particles[edge.a].position - particles[edge.b].position).length();
            stretchConstraints.emplace_back(edge.a, edge.b, len, stretchComp);

            // If edge is shared by two triangles, construct dihedral bending constraint
            if (data.tri0 != 0xFFFFFFFF && data.tri1 != 0xFFFFFFFF) {
                const auto& x0 = particles[edge.a].position;
                const auto& x1 = particles[edge.b].position;
                const auto& x2 = particles[data.opp0].position;
                const auto& x3 = particles[data.opp1].position;

                float restDist = (particles[data.opp0].position - particles[data.opp1].position).length();
                bendingConstraints.emplace_back(edge.a, edge.b, data.opp0, data.opp1, restDist, bendComp);
            }
        }
    }

    void pinParticle(size_t index) {
        if (index < particles.size()) {
            particles[index].invMass = 0.0f;
        }
    }

    void step(float dt, int substeps = 10) {
        if (particles.empty() || dt <= 0.0f || substeps <= 0) return;

        float subDt = dt / static_cast<float>(substeps);

        for (int step = 0; step < substeps; ++step) {
            // 1. Predict unconstrained positions
            for (auto& p : particles) {
                if (p.invMass == 0.0f) continue;

                p.prevPosition = p.position;
                p.velocity = p.velocity + (gravity + windForce) * subDt;
                p.velocity = p.velocity * damping;
                p.position = p.position + p.velocity * subDt;
            }

            // 2. Reset Lagrange multipliers for sub-step
            for (auto& sc : stretchConstraints) sc.lambda = 0.0f;
            for (auto& bc : bendingConstraints) bc.lambda = 0.0f;

            // 3. Solve Stretch & Bending Constraints
            for (auto& sc : stretchConstraints) {
                sc.solve(particles, subDt);
            }
            for (auto& bc : bendingConstraints) {
                bc.solve(particles, subDt);
            }

            // 4. Resolve Obstacle Collisions
            for (auto& p : particles) {
                for (const auto& sphere : sphereObstacles) {
                    sphere.resolve(p);
                }
                for (const auto& ground : groundObstacles) {
                    ground.resolve(p);
                }
            }

            // 5. Update Velocities from position delta
            float invSubDt = 1.0f / subDt;
            for (auto& p : particles) {
                if (p.invMass == 0.0f) continue;
                p.velocity = (p.position - p.prevPosition) * invSubDt;
            }
        }
    }

    // Sync simulated particle positions back into ScratchboxMesh and recalculate normals
    void syncToMesh(ScratchboxMesh& mesh) const {
        size_t count = std::min(mesh.vertices.size(), particles.size());
        for (size_t i = 0; i < count; ++i) {
            mesh.vertices[i].position = particles[i].position;
        }
        mesh.recomputeNormals();
    }
};

} // namespace xpbd
} // namespace scratchbox

#endif // SCRATCHBOX_XPBD_HPP
