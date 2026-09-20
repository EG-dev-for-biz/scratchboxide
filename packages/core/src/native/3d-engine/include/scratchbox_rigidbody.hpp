/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

#ifndef SCRATCHBOX_RIGIDBODY_HPP
#define SCRATCHBOX_RIGIDBODY_HPP

#include "scratchbox_math.hpp"
#include "scratchbox_geometry.hpp"

#include <vector>
#include <string>
#include <cmath>
#include <algorithm>
#include <memory>
#include <array>
#include <limits>

namespace scratchbox {
namespace rigidbody {

using math::Vec2;
using math::Vec3;
using math::Vec4;
using math::Quat;
using math::Mat3;
using math::AABB;
using geometry::ScratchboxMesh;

// ============================================================================
// 1. COLLIDER TYPES & SUPPORT FUNCTIONS
// ============================================================================
enum class ColliderType {
    Sphere,
    Box,
    Capsule,
    Cylinder,
    ConvexMesh
};

struct Collider {
    ColliderType type{ColliderType::Box};
    Vec3 halfExtents{0.5f, 0.5f, 0.5f}; // For Box
    float radius{0.5f};                 // For Sphere / Capsule / Cylinder
    float height{1.0f};                 // For Capsule / Cylinder (total height along Y)
    std::vector<Vec3> vertices;         // For ConvexMesh

    static Collider createBox(const Vec3& size) {
        Collider c;
        c.type = ColliderType::Box;
        c.halfExtents = size * 0.5f;
        return c;
    }

    static Collider createSphere(float r) {
        Collider c;
        c.type = ColliderType::Sphere;
        c.radius = r;
        return c;
    }

    static Collider createCapsule(float r, float h) {
        Collider c;
        c.type = ColliderType::Capsule;
        c.radius = r;
        c.height = h;
        return c;
    }

    static Collider createCylinder(float r, float h) {
        Collider c;
        c.type = ColliderType::Cylinder;
        c.radius = r;
        c.height = h;
        return c;
    }

    static Collider fromMesh(const ScratchboxMesh& mesh) {
        Collider c;
        c.type = ColliderType::ConvexMesh;
        c.vertices.reserve(mesh.vertices.size());
        for (const auto& v : mesh.vertices) {
            c.vertices.push_back(v.position);
        }
        return c;
    }

    // Local-space Support Function
    Vec3 getSupport(const Vec3& dir) const {
        switch (type) {
            case ColliderType::Sphere: {
                float len = dir.length();
                if (len < 1e-6f) return Vec3(0, radius, 0);
                return dir * (radius / len);
            }
            case ColliderType::Box: {
                return Vec3(
                    dir.x >= 0.0f ? halfExtents.x : -halfExtents.x,
                    dir.y >= 0.0f ? halfExtents.y : -halfExtents.y,
                    dir.z >= 0.0f ? halfExtents.z : -halfExtents.z
                );
            }
            case ColliderType::Capsule: {
                float halfSegment = std::max(0.0f, height * 0.5f - radius);
                Vec3 tip(0, dir.y >= 0.0f ? halfSegment : -halfSegment, 0);
                float len = dir.length();
                Vec3 sphereOffset = len > 1e-6f ? dir * (radius / len) : Vec3(0, radius, 0);
                return tip + sphereOffset;
            }
            case ColliderType::Cylinder: {
                float halfH = height * 0.5f;
                float signY = dir.y >= 0.0f ? halfH : -halfH;
                float rLen = std::sqrt(dir.x * dir.x + dir.z * dir.z);
                if (rLen > 1e-6f) {
                    return Vec3(dir.x / rLen * radius, signY, dir.z / rLen * radius);
                }
                return Vec3(0, signY, 0);
            }
            case ColliderType::ConvexMesh: {
                if (vertices.empty()) return Vec3(0, 0, 0);
                float maxDot = -1e9f;
                Vec3 bestVert = vertices[0];
                for (const auto& v : vertices) {
                    float d = v.dot(dir);
                    if (d > maxDot) {
                        maxDot = d;
                        bestVert = v;
                    }
                }
                return bestVert;
            }
        }
        return Vec3(0, 0, 0);
    }
};

// ============================================================================
// 2. INERTIA TENSORS
// ============================================================================
struct InertiaTensor {
    static Mat3 createBox(float mass, const Vec3& size) {
        float factor = (1.0f / 12.0f) * mass;
        float w2 = size.x * size.x;
        float h2 = size.y * size.y;
        float d2 = size.z * size.z;
        return Mat3::diagonal(
            factor * (h2 + d2),
            factor * (w2 + d2),
            factor * (w2 + h2)
        );
    }

    static Mat3 createSphere(float mass, float radius) {
        float i = (2.0f / 5.0f) * mass * radius * radius;
        return Mat3::diagonal(i, i, i);
    }

    static Mat3 createCylinder(float mass, float radius, float height) {
        float r2 = radius * radius;
        float h2 = height * height;
        float iY = 0.5f * mass * r2;
        float iXZ = (1.0f / 12.0f) * mass * (3.0f * r2 + h2);
        return Mat3::diagonal(iXZ, iY, iXZ);
    }

    static Mat3 createCapsule(float mass, float radius, float height) {
        // Approximate as cylinder + sphere caps
        float r2 = radius * radius;
        float h2 = height * height;
        float iY = 0.5f * mass * r2;
        float iXZ = (1.0f / 12.0f) * mass * (3.0f * r2 + h2) + (2.0f / 5.0f) * mass * r2;
        return Mat3::diagonal(iXZ, iY, iXZ);
    }
};

// ============================================================================
// 3. RIGID BODY DEFINITION
// ============================================================================
struct RigidBody {
    std::string name;
    Vec3 position{0.0f, 0.0f, 0.0f};
    Quat orientation{0.0f, 0.0f, 0.0f, 1.0f};
    Vec3 linearVelocity{0.0f, 0.0f, 0.0f};
    Vec3 angularVelocity{0.0f, 0.0f, 0.0f};
    Vec3 force{0.0f, 0.0f, 0.0f};
    Vec3 torque{0.0f, 0.0f, 0.0f};

    float mass{1.0f};
    float invMass{1.0f};
    Mat3 invInertiaBody;
    Mat3 invInertiaWorld;

    Collider collider;
    float restitution{0.3f};
    float friction{0.5f};
    bool isStatic{false};

    RigidBody(const std::string& id = "body") : name(id) {
        setMass(1.0f);
        collider = Collider::createBox(Vec3(1.0f, 1.0f, 1.0f));
        invInertiaBody = InertiaTensor::createBox(1.0f, Vec3(1.0f, 1.0f, 1.0f)).inverse();
        updateInertiaWorld();
    }

    void setMass(float m) {
        mass = m;
        if (m <= 0.0f || isStatic) {
            invMass = 0.0f;
            invInertiaBody = Mat3(0,0,0, 0,0,0, 0,0,0);
            invInertiaWorld = Mat3(0,0,0, 0,0,0, 0,0,0);
        } else {
            invMass = 1.0f / m;
        }
    }

    void setStatic(bool st) {
        isStatic = st;
        if (st) {
            invMass = 0.0f;
            invInertiaBody = Mat3(0,0,0, 0,0,0, 0,0,0);
            invInertiaWorld = Mat3(0,0,0, 0,0,0, 0,0,0);
            linearVelocity = Vec3(0, 0, 0);
            angularVelocity = Vec3(0, 0, 0);
        } else {
            setMass(mass > 0.0f ? mass : 1.0f);
            updateInertiaWorld();
        }
    }

    void updateInertiaWorld() {
        if (invMass == 0.0f) {
            invInertiaWorld = Mat3(0,0,0, 0,0,0, 0,0,0);
            return;
        }
        Mat3 r = Mat3::fromQuat(orientation);
        invInertiaWorld = r * invInertiaBody * r.transpose();
    }

    Vec3 getWorldSupport(const Vec3& worldDir) const {
        // Transform direction to local space: q^-1 * dir
        Quat invQ(-orientation.x, -orientation.y, -orientation.z, orientation.w);
        Vec3 localDir = invQ.rotate(worldDir);
        Vec3 localSup = collider.getSupport(localDir);
        return position + orientation.rotate(localSup);
    }

    AABB computeAABB() const {
        Vec3 corners[8] = {
            Vec3(1, 1, 1), Vec3(-1, 1, 1), Vec3(1, -1, 1), Vec3(-1, -1, 1),
            Vec3(1, 1, -1), Vec3(-1, 1, -1), Vec3(1, -1, -1), Vec3(-1, -1, -1)
        };
        AABB aabb;
        for (int i = 0; i < 8; ++i) {
            aabb.expand(getWorldSupport(corners[i]));
        }
        return aabb;
    }
};

// ============================================================================
// 4. GJK & EPA NARROWPHASE COLLISION
// ============================================================================
struct SupportPoint {
    Vec3 p;  // Minkowski difference: pA - pB
    Vec3 pA; // Support on Body A
    Vec3 pB; // Support on Body B
};

inline SupportPoint minkowskiSupport(const RigidBody& a, const RigidBody& b, const Vec3& dir) {
    SupportPoint sp;
    sp.pA = a.getWorldSupport(dir);
    sp.pB = b.getWorldSupport(dir * -1.0f);
    sp.p = sp.pA - sp.pB;
    return sp;
}

struct GjkSimplex {
    std::array<SupportPoint, 4> points;
    int size{0};

    void add(const SupportPoint& p) {
        if (size < 4) {
            points[size++] = p;
        }
    }

    void remove(int index) {
        for (int i = index; i < size - 1; ++i) {
            points[i] = points[i + 1];
        }
        size--;
    }
};

inline bool updateGjkSimplex(GjkSimplex& s, Vec3& dir) {
    if (s.size == 2) {
        // Line segment AB
        Vec3 a = s.points[1].p;
        Vec3 b = s.points[0].p;
        Vec3 ab = b - a;
        Vec3 ao = a * -1.0f;

        if (ab.dot(ao) > 0.0f) {
            dir = ab.cross(ao).cross(ab);
            if (dir.lengthSquared() < 1e-6f) dir = Vec3(ab.y, -ab.x, 0.0f);
        } else {
            s.remove(0);
            dir = ao;
        }
        return false;
    } else if (s.size == 3) {
        // Triangle ABC (A is newest point points[2])
        Vec3 a = s.points[2].p;
        Vec3 b = s.points[1].p;
        Vec3 c = s.points[0].p;
        Vec3 ab = b - a;
        Vec3 ac = c - a;
        Vec3 ao = a * -1.0f;
        Vec3 abc = ab.cross(ac);

        if (abc.cross(ac).dot(ao) > 0.0f) {
            if (ac.dot(ao) > 0.0f) {
                s.points[1] = s.points[2];
                s.size = 2;
                dir = ac.cross(ao).cross(ac);
            } else {
                if (ab.dot(ao) > 0.0f) {
                    s.points[0] = s.points[1];
                    s.points[1] = s.points[2];
                    s.size = 2;
                    dir = ab.cross(ao).cross(ab);
                } else {
                    s.points[0] = s.points[2];
                    s.size = 1;
                    dir = ao;
                }
            }
        } else {
            if (ab.cross(abc).dot(ao) > 0.0f) {
                if (ab.dot(ao) > 0.0f) {
                    s.points[0] = s.points[1];
                    s.points[1] = s.points[2];
                    s.size = 2;
                    dir = ab.cross(ao).cross(ab);
                } else {
                    s.points[0] = s.points[2];
                    s.size = 1;
                    dir = ao;
                }
            } else {
                if (abc.dot(ao) > 0.0f) {
                    dir = abc;
                } else {
                    std::swap(s.points[0], s.points[1]);
                    dir = abc * -1.0f;
                }
            }
        }
        return false;
    } else if (s.size == 4) {
        // Tetrahedron ABCD (A is points[3])
        Vec3 a = s.points[3].p;
        Vec3 b = s.points[2].p;
        Vec3 c = s.points[1].p;
        Vec3 d = s.points[0].p;
        Vec3 ao = a * -1.0f;

        Vec3 abc = (b - a).cross(c - a);
        Vec3 acd = (c - a).cross(d - a);
        Vec3 adb = (d - a).cross(b - a);

        if (abc.dot(ao) > 0.0f) {
            s.remove(0); // Remove D
            return updateGjkSimplex(s, dir);
        }
        if (acd.dot(ao) > 0.0f) {
            s.points[0] = s.points[1];
            s.points[1] = s.points[2];
            s.points[2] = s.points[3];
            s.size = 3;
            return updateGjkSimplex(s, dir);
        }
        if (adb.dot(ao) > 0.0f) {
            s.points[1] = s.points[0];
            s.points[0] = s.points[2];
            s.points[2] = s.points[3];
            s.size = 3;
            return updateGjkSimplex(s, dir);
        }

        // Origin enclosed within tetrahedron!
        return true;
    }
    return false;
}

inline bool gjkIntersect(const RigidBody& a, const RigidBody& b, GjkSimplex& outSimplex) {
    Vec3 dir = b.position - a.position;
    if (dir.lengthSquared() < 1e-6f) dir = Vec3(1, 0, 0);

    outSimplex.size = 0;
    SupportPoint sp = minkowskiSupport(a, b, dir);
    outSimplex.add(sp);
    dir = sp.p * -1.0f;

    for (int iter = 0; iter < 32; ++iter) {
        if (dir.lengthSquared() < 1e-6f) dir = Vec3(1, 0, 0);

        SupportPoint nextSp = minkowskiSupport(a, b, dir);
        if (nextSp.p.dot(dir) < 0.0f) {
            return false; // No intersection
        }

        outSimplex.add(nextSp);
        if (updateGjkSimplex(outSimplex, dir)) {
            return true; // Intersection confirmed
        }
    }
    return false;
}

// Expanding Polytope Algorithm (EPA) for Penetration Depth & Normal
struct EpaFacet {
    SupportPoint a, b, c;
    Vec3 normal;
    float distance{0.0f};

    EpaFacet(const SupportPoint& _a, const SupportPoint& _b, const SupportPoint& _c)
        : a(_a), b(_b), c(_c) {
        Vec3 ab = b.p - a.p;
        Vec3 ac = c.p - a.p;
        normal = ab.cross(ac);
        float len = normal.length();
        if (len > 1e-6f) {
            normal = normal * (1.0f / len);
            distance = normal.dot(a.p);
            if (distance < 0.0f) {
                normal = normal * -1.0f;
                distance = -distance;
                std::swap(b, c);
            }
        } else {
            normal = Vec3(0, 1, 0);
            distance = 0.0f;
        }
    }
};

struct ContactManifold {
    RigidBody* bodyA{nullptr};
    RigidBody* bodyB{nullptr};
    Vec3 normal{0, 1, 0}; // Points from A to B
    Vec3 point{0, 0, 0};  // Contact point in world space
    float penetration{0.0f};
    bool isColliding{false};

    float normalImpulse{0.0f};
    float tangentImpulse1{0.0f};
    float tangentImpulse2{0.0f};
    float accumulatedNormalImpulse{0.0f};
    float accumulatedTangentImpulse{0.0f};
};

inline ContactManifold epaPenetration(const RigidBody& a, const RigidBody& b, const GjkSimplex& simplex) {
    ContactManifold manifold;
    manifold.bodyA = const_cast<RigidBody*>(&a);
    manifold.bodyB = const_cast<RigidBody*>(&b);

    if (simplex.size < 4) return manifold;

    std::vector<EpaFacet> facets = {
        EpaFacet(simplex.points[0], simplex.points[1], simplex.points[2]),
        EpaFacet(simplex.points[0], simplex.points[2], simplex.points[3]),
        EpaFacet(simplex.points[0], simplex.points[3], simplex.points[1]),
        EpaFacet(simplex.points[1], simplex.points[3], simplex.points[2])
    };

    float minDistance = 1e9f;
    size_t closestFacetIdx = 0;

    for (int iter = 0; iter < 32; ++iter) {
        minDistance = 1e9f;
        closestFacetIdx = 0;

        for (size_t i = 0; i < facets.size(); ++i) {
            if (facets[i].distance < minDistance) {
                minDistance = facets[i].distance;
                closestFacetIdx = i;
            }
        }

        const auto& closestFacet = facets[closestFacetIdx];
        SupportPoint sp = minkowskiSupport(a, b, closestFacet.normal);
        float d = sp.p.dot(closestFacet.normal);

        if (d - minDistance < 1e-4f) {
            // Converged
            manifold.isColliding = true;
            manifold.normal = closestFacet.normal;
            manifold.penetration = d;

            if (a.isStatic && !b.isStatic) {
                Vec3 pB = b.getWorldSupport(manifold.normal * -1.0f);
                manifold.point = pB + manifold.normal * (manifold.penetration * 0.5f);
            } else if (!a.isStatic && b.isStatic) {
                Vec3 pA = a.getWorldSupport(manifold.normal);
                manifold.point = pA - manifold.normal * (manifold.penetration * 0.5f);
            } else {
                Vec3 pA = a.getWorldSupport(manifold.normal);
                Vec3 pB = b.getWorldSupport(manifold.normal * -1.0f);
                manifold.point = (pA + pB) * 0.5f;
            }
            return manifold;
        }

        // Expand polytope
        std::vector<std::pair<SupportPoint, SupportPoint>> edges;
        for (size_t i = 0; i < facets.size();) {
            if (facets[i].normal.dot(sp.p - facets[i].a.p) > 0.0f) {
                // Face is visible from new point: add edges
                auto addEdge = [&](const SupportPoint& p1, const SupportPoint& p2) {
                    for (auto it = edges.begin(); it != edges.end(); ++it) {
                        if ((it->first.p - p2.p).lengthSquared() < 1e-6f && (it->second.p - p1.p).lengthSquared() < 1e-6f) {
                            edges.erase(it);
                            return;
                        }
                    }
                    edges.push_back({p1, p2});
                };

                addEdge(facets[i].a, facets[i].b);
                addEdge(facets[i].b, facets[i].c);
                addEdge(facets[i].c, facets[i].a);

                facets[i] = facets.back();
                facets.pop_back();
            } else {
                ++i;
            }
        }

        for (const auto& edge : edges) {
            facets.push_back(EpaFacet(edge.first, edge.second, sp));
        }
    }

    if (!facets.empty()) {
        manifold.isColliding = true;
        manifold.normal = facets[closestFacetIdx].normal;
        manifold.penetration = facets[closestFacetIdx].distance;
        if (a.isStatic && !b.isStatic) {
            Vec3 pB = b.getWorldSupport(manifold.normal * -1.0f);
            manifold.point = pB + manifold.normal * (manifold.penetration * 0.5f);
        } else if (!a.isStatic && b.isStatic) {
            Vec3 pA = a.getWorldSupport(manifold.normal);
            manifold.point = pA - manifold.normal * (manifold.penetration * 0.5f);
        } else {
            Vec3 pA = a.getWorldSupport(manifold.normal);
            Vec3 pB = b.getWorldSupport(manifold.normal * -1.0f);
            manifold.point = (pA + pB) * 0.5f;
        }
    }

    return manifold;
}

/// ============================================================================
// 5. ARTICULATED JOINT CONSTRAINTS (BALL-AND-SOCKET, HINGE, SLIDER, FIXED)
// ============================================================================

enum class JointType {
    BallAndSocket, // 3 rotational DOFs, 0 translational DOFs
    Hinge,         // 1 rotational DOF (around localAxis), min/max angle limits
    Slider,        // 1 translational DOF along axis, 0 rotational DOFs
    Fixed,         // 0 DOFs (locked relative transform)
    Distance       // Distance constraint between two anchor points
};

struct JointConstraint {
    RigidBody* bodyA{nullptr};
    RigidBody* bodyB{nullptr};
    JointType type{JointType::BallAndSocket};

    Vec3 localAnchorA{0.0f, 0.0f, 0.0f};
    Vec3 localAnchorB{0.0f, 0.0f, 0.0f};
    Vec3 localAxisA{0.0f, 1.0f, 0.0f}; // Rotation or slide axis in A's space
    Vec3 localAxisB{0.0f, 1.0f, 0.0f}; // Rotation or slide axis in B's space

    float minAngle{-math::PI};
    float maxAngle{math::PI};
    float targetDistance{0.0f};

    // Sequential impulse accumulation
    Vec3 accumulatedImpulsePos{0.0f, 0.0f, 0.0f};
    Vec3 accumulatedImpulseRot{0.0f, 0.0f, 0.0f};

    void solveVelocity(float subDt) {
        if (!bodyA || !bodyB) return;
        if (bodyA->isStatic && bodyB->isStatic) return;

        // World-space anchors
        Vec3 rA = bodyA->orientation.rotate(localAnchorA);
        Vec3 rB = bodyB->orientation.rotate(localAnchorB);
        Vec3 pA = bodyA->position + rA;
        Vec3 pB = bodyB->position + rB;

        // Relative velocity at anchors: vB - vA
        Vec3 vA = bodyA->linearVelocity + bodyA->angularVelocity.cross(rA);
        Vec3 vB = bodyB->linearVelocity + bodyB->angularVelocity.cross(rB);
        Vec3 vRel = vB - vA;

        // 1. Positional anchor equality constraint: pA == pB (for all types except pure Slider/Distance)
        if (type == JointType::BallAndSocket || type == JointType::Hinge || type == JointType::Fixed) {
            Vec3 posError = pB - pA;
            Vec3 bias = posError * (0.25f / subDt);

            // Solve 3 linear orthogonal axes
            Vec3 axes[3] = { Vec3(1, 0, 0), Vec3(0, 1, 0), Vec3(0, 0, 1) };
            for (int k = 0; k < 3; ++k) {
                const Vec3& u = axes[k];
                float rAxU_dot = (bodyA->invInertiaWorld * rA.cross(u)).cross(rA).dot(u);
                float rBxU_dot = (bodyB->invInertiaWorld * rB.cross(u)).cross(rB).dot(u);
                float kMass = bodyA->invMass + bodyB->invMass + rAxU_dot + rBxU_dot;
                if (kMass < 1e-8f) continue;

                float deltaV = (vRel.dot(u) + bias.dot(u));
                float impulseMag = -deltaV / kMass;
                Vec3 impulse = u * impulseMag;

                if (!bodyA->isStatic) {
                    bodyA->linearVelocity = bodyA->linearVelocity - impulse * bodyA->invMass;
                    bodyA->angularVelocity = bodyA->angularVelocity - (bodyA->invInertiaWorld * rA.cross(impulse));
                }
                if (!bodyB->isStatic) {
                    bodyB->linearVelocity = bodyB->linearVelocity + impulse * bodyB->invMass;
                    bodyB->angularVelocity = bodyB->angularVelocity + (bodyB->invInertiaWorld * rB.cross(impulse));
                }

                // Update relative velocity for next axis
                vA = bodyA->linearVelocity + bodyA->angularVelocity.cross(rA);
                vB = bodyB->linearVelocity + bodyB->angularVelocity.cross(rB);
                vRel = vB - vA;
            }
        } else if (type == JointType::Distance) {
            Vec3 diff = pB - pA;
            float curDist = diff.length();
            if (curDist > 1e-6f) {
                Vec3 u = diff * (1.0f / curDist);
                float error = curDist - targetDistance;
                float bias = error * (0.25f / subDt);

                float rAxU_dot = (bodyA->invInertiaWorld * rA.cross(u)).cross(rA).dot(u);
                float rBxU_dot = (bodyB->invInertiaWorld * rB.cross(u)).cross(rB).dot(u);
                float kMass = bodyA->invMass + bodyB->invMass + rAxU_dot + rBxU_dot;
                if (kMass > 1e-8f) {
                    float deltaV = vRel.dot(u) + bias;
                    float impulseMag = -deltaV / kMass;
                    Vec3 impulse = u * impulseMag;

                    if (!bodyA->isStatic) {
                        bodyA->linearVelocity = bodyA->linearVelocity - impulse * bodyA->invMass;
                        bodyA->angularVelocity = bodyA->angularVelocity - (bodyA->invInertiaWorld * rA.cross(impulse));
                    }
                    if (!bodyB->isStatic) {
                        bodyB->linearVelocity = bodyB->linearVelocity + impulse * bodyB->invMass;
                        bodyB->angularVelocity = bodyB->angularVelocity + (bodyB->invInertiaWorld * rB.cross(impulse));
                    }
                }
            }
        }

        // 2. Rotational angular constraints
        Vec3 relOmega = bodyB->angularVelocity - bodyA->angularVelocity;

        if (type == JointType::Hinge) {
            // Constrain angular velocity on the 2 axes orthogonal to hinge axis
            Vec3 worldHingeAxis = bodyA->orientation.rotate(localAxisA).normalized();
            Vec3 refDir = std::abs(worldHingeAxis.y) < 0.99f ? Vec3(0, 1, 0) : Vec3(1, 0, 0);
            Vec3 n1 = worldHingeAxis.cross(refDir).normalized();
            Vec3 n2 = worldHingeAxis.cross(n1).normalized();

            Vec3 rotAxes[2] = { n1, n2 };
            for (int k = 0; k < 2; ++k) {
                const Vec3& u = rotAxes[k];
                float kRot = (bodyA->invInertiaWorld * u).dot(u) + (bodyB->invInertiaWorld * u).dot(u);
                if (kRot < 1e-8f) continue;

                float deltaW = relOmega.dot(u);
                float torqueMag = -deltaW / kRot;
                Vec3 torqueImpulse = u * torqueMag;

                if (!bodyA->isStatic) bodyA->angularVelocity = bodyA->angularVelocity - (bodyA->invInertiaWorld * torqueImpulse);
                if (!bodyB->isStatic) bodyB->angularVelocity = bodyB->angularVelocity + (bodyB->invInertiaWorld * torqueImpulse);

                relOmega = bodyB->angularVelocity - bodyA->angularVelocity;
            }

            // Hinge limits along worldHingeAxis
            Vec3 axisB = bodyB->orientation.rotate(localAxisB).normalized();
            float curAngle = std::atan2(worldHingeAxis.cross(axisB).length(), worldHingeAxis.dot(axisB));
            if (curAngle < minAngle || curAngle > maxAngle) {
                float limitError = (curAngle < minAngle) ? (curAngle - minAngle) : (curAngle - maxAngle);
                float bias = limitError * (0.25f / subDt);
                float kRot = (bodyA->invInertiaWorld * worldHingeAxis).dot(worldHingeAxis) +
                             (bodyB->invInertiaWorld * worldHingeAxis).dot(worldHingeAxis);
                if (kRot > 1e-8f) {
                    float deltaW = relOmega.dot(worldHingeAxis) + bias;
                    float torqueMag = -deltaW / kRot;
                    Vec3 torqueImpulse = worldHingeAxis * torqueMag;
                    if (!bodyA->isStatic) bodyA->angularVelocity = bodyA->angularVelocity - (bodyA->invInertiaWorld * torqueImpulse);
                    if (!bodyB->isStatic) bodyB->angularVelocity = bodyB->angularVelocity + (bodyB->invInertiaWorld * torqueImpulse);
                }
            }
        } else if (type == JointType::Fixed) {
            // Lock all 3 rotational degrees of freedom
            Vec3 axes[3] = { Vec3(1, 0, 0), Vec3(0, 1, 0), Vec3(0, 0, 1) };
            for (int k = 0; k < 3; ++k) {
                const Vec3& u = axes[k];
                float kRot = (bodyA->invInertiaWorld * u).dot(u) + (bodyB->invInertiaWorld * u).dot(u);
                if (kRot < 1e-8f) continue;

                float deltaW = relOmega.dot(u);
                float torqueMag = -deltaW / kRot;
                Vec3 torqueImpulse = u * torqueMag;

                if (!bodyA->isStatic) bodyA->angularVelocity = bodyA->angularVelocity - (bodyA->invInertiaWorld * torqueImpulse);
                if (!bodyB->isStatic) bodyB->angularVelocity = bodyB->angularVelocity + (bodyB->invInertiaWorld * torqueImpulse);

                relOmega = bodyB->angularVelocity - bodyA->angularVelocity;
            }
        }
    }
};

// ============================================================================
// 6. SEQUENTIAL IMPULSE SOLVER & WORLD SIMULATOR
// ============================================================================
class RigidBodyWorld {
public:
    std::vector<std::shared_ptr<RigidBody>> bodies;
    std::vector<std::shared_ptr<JointConstraint>> joints;
    Vec3 gravity{0.0f, -9.81f, 0.0f};

    void addBody(std::shared_ptr<RigidBody> body) {
        bodies.push_back(body);
    }

    void addJoint(std::shared_ptr<JointConstraint> joint) {
        joints.push_back(joint);
    }

    void step(float dt, int velocityIterations = 10, int positionSubsteps = 2) {
        if (bodies.empty() || dt <= 0.0f) return;

        float subDt = dt / static_cast<float>(positionSubsteps);

        for (int substep = 0; substep < positionSubsteps; ++substep) {
            // 1. Integrate Forces -> Velocities
            for (auto& body : bodies) {
                if (body->isStatic) continue;

                body->linearVelocity = body->linearVelocity + (gravity + body->force * body->invMass) * subDt;
                body->angularVelocity = body->angularVelocity + (body->invInertiaWorld * body->torque) * subDt;

                // Simple drag
                body->linearVelocity = body->linearVelocity * 0.999f;
                body->angularVelocity = body->angularVelocity * 0.995f;
            }

            // 2. Broadphase & Narrowphase Collision Detection
            std::vector<ContactManifold> manifolds;
            for (size_t i = 0; i < bodies.size(); ++i) {
                for (size_t j = i + 1; j < bodies.size(); ++j) {
                    if (bodies[i]->isStatic && bodies[j]->isStatic) continue;

                    // Broadphase AABB Check
                    AABB aabbA = bodies[i]->computeAABB();
                    AABB aabbB = bodies[j]->computeAABB();
                    if (!aabbA.intersects(aabbB)) continue;

                    // Narrowphase GJK + EPA
                    GjkSimplex simplex;
                    if (gjkIntersect(*bodies[i], *bodies[j], simplex)) {
                        ContactManifold m = epaPenetration(*bodies[i], *bodies[j], simplex);
                        if (m.isColliding && m.penetration > 1e-4f) {
                            manifolds.push_back(m);
                        }
                    }
                }
            }

            // 3. Sequential Impulse Resolution (Contacts & Joint Equality Constraints)
            for (int iter = 0; iter < velocityIterations; ++iter) {
                // Solve Articulated Joint Constraints
                for (auto& joint : joints) {
                    joint->solveVelocity(subDt);
                }

                // Solve Contact Manifolds
                for (auto& m : manifolds) {
                    RigidBody* a = m.bodyA;
                    RigidBody* b = m.bodyB;

                    Vec3 rA = m.point - a->position;
                    Vec3 rB = m.point - b->position;

                    Vec3 vA = a->linearVelocity + a->angularVelocity.cross(rA);
                    Vec3 vB = b->linearVelocity + b->angularVelocity.cross(rB);
                    Vec3 vRel = vB - vA;

                    // Normal impulse
                    float vn = vRel.dot(m.normal);
                    float restitution = std::min(a->restitution, b->restitution);
                    float baumgarte = 0.2f * std::max(0.0f, m.penetration - 0.002f) / subDt;
                    float targetVn = 0.0f;
                    if (vn < -0.1f) {
                        targetVn = -restitution * vn;
                    }
                    targetVn += baumgarte;

                    Vec3 rAxN = rA.cross(m.normal);
                    Vec3 rBxN = rB.cross(m.normal);
                    float kNormal = a->invMass + b->invMass +
                                    (a->invInertiaWorld * rAxN).cross(rA).dot(m.normal) +
                                    (b->invInertiaWorld * rBxN).cross(rB).dot(m.normal);

                    if (kNormal > 1e-6f) {
                        float deltaVn = targetVn - vn;
                        float impulse = deltaVn / kNormal;

                        float oldAccum = m.accumulatedNormalImpulse;
                        m.accumulatedNormalImpulse = std::max(0.0f, oldAccum + impulse);
                        float actualImpulse = m.accumulatedNormalImpulse - oldAccum;

                        Vec3 P = m.normal * actualImpulse;
                        if (!a->isStatic) {
                            a->linearVelocity = a->linearVelocity - P * a->invMass;
                            a->angularVelocity = a->angularVelocity - (a->invInertiaWorld * rA.cross(P));
                        }
                        if (!b->isStatic) {
                            b->linearVelocity = b->linearVelocity + P * b->invMass;
                            b->angularVelocity = b->angularVelocity + (b->invInertiaWorld * rB.cross(P));
                        }
                    }

                    // Friction impulse along tangent
                    Vec3 vRelAfter = (b->linearVelocity + b->angularVelocity.cross(rB)) -
                                     (a->linearVelocity + a->angularVelocity.cross(rA));
                    Vec3 tangent = vRelAfter - m.normal * vRelAfter.dot(m.normal);
                    float tangentSpeed = tangent.length();
                    if (tangentSpeed > 1e-4f) {
                        tangent = tangent * (1.0f / tangentSpeed);
                        Vec3 rAxT = rA.cross(tangent);
                        Vec3 rBxT = rB.cross(tangent);
                        float kTangent = a->invMass + b->invMass +
                                         (a->invInertiaWorld * rAxT).cross(rA).dot(tangent) +
                                         (b->invInertiaWorld * rBxT).cross(rB).dot(tangent);

                        if (kTangent > 1e-6f) {
                            float vt = vRelAfter.dot(tangent);
                            float frictionImpulse = -vt / kTangent;
                            float maxFriction = (a->friction * b->friction) * m.accumulatedNormalImpulse;

                            float oldFrictionAccum = m.accumulatedTangentImpulse;
                            m.accumulatedTangentImpulse = std::clamp(oldFrictionAccum + frictionImpulse, -maxFriction, maxFriction);
                            float actualFriction = m.accumulatedTangentImpulse - oldFrictionAccum;

                            Vec3 Pt = tangent * actualFriction;
                            if (!a->isStatic) {
                                a->linearVelocity = a->linearVelocity - Pt * a->invMass;
                                a->angularVelocity = a->angularVelocity - (a->invInertiaWorld * rA.cross(Pt));
                            }
                            if (!b->isStatic) {
                                b->linearVelocity = b->linearVelocity + Pt * b->invMass;
                                b->angularVelocity = b->angularVelocity + (b->invInertiaWorld * rB.cross(Pt));
                            }
                        }
                    }
                }
            }

            // 4. Integrate Velocities -> Positions & Orientations
            for (auto& body : bodies) {
                if (body->isStatic) continue;

                body->position = body->position + body->linearVelocity * subDt;

                // Quat orientation integration: q_new = (q + 0.5 * [0, omega] * q * dt).normalized()
                Quat wQuat(body->angularVelocity.x, body->angularVelocity.y, body->angularVelocity.z, 0.0f);
                Quat qDot = wQuat * body->orientation;
                body->orientation.x += qDot.x * 0.5f * subDt;
                body->orientation.y += qDot.y * 0.5f * subDt;
                body->orientation.z += qDot.z * 0.5f * subDt;
                body->orientation.w += qDot.w * 0.5f * subDt;

                float qLen = std::sqrt(
                    body->orientation.x * body->orientation.x +
                    body->orientation.y * body->orientation.y +
                    body->orientation.z * body->orientation.z +
                    body->orientation.w * body->orientation.w
                );
                if (qLen > 1e-6f) {
                    body->orientation.x /= qLen;
                    body->orientation.y /= qLen;
                    body->orientation.z /= qLen;
                    body->orientation.w /= qLen;
                }

                body->updateInertiaWorld();

                // Clear accumulated forces
                body->force = Vec3(0, 0, 0);
                body->torque = Vec3(0, 0, 0);
            }
        }
    }
};

// ============================================================================
// 7. CHARACTER RAGDOLL HIERARCHY
// ============================================================================

struct RagdollBone {
    std::string name;
    std::shared_ptr<RigidBody> body;
    int parentIndex{-1};
    std::shared_ptr<JointConstraint> joint;
};

class Ragdoll {
public:
    std::vector<RagdollBone> bones;

    static std::shared_ptr<Ragdoll> createHumanoid(
        RigidBodyWorld& world,
        const Vec3& rootPosition = Vec3(0.0f, 1.0f, 0.0f),
        float scale = 1.0f
    ) {
        auto ragdoll = std::make_shared<Ragdoll>();

        // 1. Pelvis (Root Body)
        auto pelvis = std::make_shared<RigidBody>("Pelvis");
        pelvis->collider = Collider::createBox(Vec3(0.32f, 0.20f, 0.24f) * scale);
        pelvis->position = rootPosition;
        pelvis->setMass(12.0f);
        pelvis->invInertiaBody = InertiaTensor::createBox(12.0f, Vec3(0.32f, 0.20f, 0.24f) * scale).inverse();
        pelvis->updateInertiaWorld();
        world.addBody(pelvis);
        ragdoll->bones.push_back({ "Pelvis", pelvis, -1, nullptr });

        // 2. Spine / Torso
        auto torso = std::make_shared<RigidBody>("Torso");
        torso->collider = Collider::createBox(Vec3(0.36f, 0.40f, 0.28f) * scale);
        torso->position = rootPosition + Vec3(0.0f, 0.32f, 0.0f) * scale;
        torso->setMass(20.0f);
        torso->invInertiaBody = InertiaTensor::createBox(20.0f, Vec3(0.36f, 0.40f, 0.28f) * scale).inverse();
        torso->updateInertiaWorld();
        world.addBody(torso);

        auto spineJoint = std::make_shared<JointConstraint>();
        spineJoint->bodyA = pelvis.get();
        spineJoint->bodyB = torso.get();
        spineJoint->type = JointType::BallAndSocket;
        spineJoint->localAnchorA = Vec3(0.0f, 0.10f, 0.0f) * scale;
        spineJoint->localAnchorB = Vec3(0.0f, -0.20f, 0.0f) * scale;
        world.addJoint(spineJoint);
        ragdoll->bones.push_back({ "Torso", torso, 0, spineJoint });

        // 3. Head
        auto head = std::make_shared<RigidBody>("Head");
        head->collider = Collider::createSphere(0.12f * scale);
        head->position = torso->position + Vec3(0.0f, 0.35f, 0.0f) * scale;
        head->setMass(5.0f);
        head->invInertiaBody = InertiaTensor::createSphere(5.0f, 0.12f * scale).inverse();
        head->updateInertiaWorld();
        world.addBody(head);

        auto neckJoint = std::make_shared<JointConstraint>();
        neckJoint->bodyA = torso.get();
        neckJoint->bodyB = head.get();
        neckJoint->type = JointType::BallAndSocket;
        neckJoint->localAnchorA = Vec3(0.0f, 0.20f, 0.0f) * scale;
        neckJoint->localAnchorB = Vec3(0.0f, -0.12f, 0.0f) * scale;
        world.addJoint(neckJoint);
        ragdoll->bones.push_back({ "Head", head, 1, neckJoint });

        // 4. Left Thigh & Calf
        auto leftThigh = std::make_shared<RigidBody>("LeftThigh");
        leftThigh->collider = Collider::createCapsule(0.07f * scale, 0.40f * scale);
        leftThigh->position = rootPosition + Vec3(-0.12f, -0.30f, 0.0f) * scale;
        leftThigh->setMass(8.0f);
        leftThigh->invInertiaBody = InertiaTensor::createCylinder(8.0f, 0.07f * scale, 0.40f * scale).inverse();
        leftThigh->updateInertiaWorld();
        world.addBody(leftThigh);

        auto leftHip = std::make_shared<JointConstraint>();
        leftHip->bodyA = pelvis.get();
        leftHip->bodyB = leftThigh.get();
        leftHip->type = JointType::BallAndSocket;
        leftHip->localAnchorA = Vec3(-0.12f, -0.08f, 0.0f) * scale;
        leftHip->localAnchorB = Vec3(0.0f, 0.18f, 0.0f) * scale;
        world.addJoint(leftHip);
        ragdoll->bones.push_back({ "LeftThigh", leftThigh, 0, leftHip });

        auto leftCalf = std::make_shared<RigidBody>("LeftCalf");
        leftCalf->collider = Collider::createCapsule(0.06f * scale, 0.36f * scale);
        leftCalf->position = leftThigh->position + Vec3(0.0f, -0.40f, 0.0f) * scale;
        leftCalf->setMass(5.0f);
        leftCalf->invInertiaBody = InertiaTensor::createCylinder(5.0f, 0.06f * scale, 0.36f * scale).inverse();
        leftCalf->updateInertiaWorld();
        world.addBody(leftCalf);

        auto leftKnee = std::make_shared<JointConstraint>();
        leftKnee->bodyA = leftThigh.get();
        leftKnee->bodyB = leftCalf.get();
        leftKnee->type = JointType::Hinge;
        leftKnee->localAnchorA = Vec3(0.0f, -0.18f, 0.0f) * scale;
        leftKnee->localAnchorB = Vec3(0.0f, 0.18f, 0.0f) * scale;
        leftKnee->localAxisA = Vec3(1.0f, 0.0f, 0.0f);
        leftKnee->localAxisB = Vec3(1.0f, 0.0f, 0.0f);
        leftKnee->minAngle = 0.0f;
        leftKnee->maxAngle = 2.4f; // Knee bends backwards
        world.addJoint(leftKnee);
        ragdoll->bones.push_back({ "LeftCalf", leftCalf, 3, leftKnee });

        // 5. Right Thigh & Calf
        auto rightThigh = std::make_shared<RigidBody>("RightThigh");
        rightThigh->collider = Collider::createCapsule(0.07f * scale, 0.40f * scale);
        rightThigh->position = rootPosition + Vec3(0.12f, -0.30f, 0.0f) * scale;
        rightThigh->setMass(8.0f);
        rightThigh->invInertiaBody = InertiaTensor::createCylinder(8.0f, 0.07f * scale, 0.40f * scale).inverse();
        rightThigh->updateInertiaWorld();
        world.addBody(rightThigh);

        auto rightHip = std::make_shared<JointConstraint>();
        rightHip->bodyA = pelvis.get();
        rightHip->bodyB = rightThigh.get();
        rightHip->type = JointType::BallAndSocket;
        rightHip->localAnchorA = Vec3(0.12f, -0.08f, 0.0f) * scale;
        rightHip->localAnchorB = Vec3(0.0f, 0.18f, 0.0f) * scale;
        world.addJoint(rightHip);
        ragdoll->bones.push_back({ "RightThigh", rightThigh, 0, rightHip });

        auto rightCalf = std::make_shared<RigidBody>("RightCalf");
        rightCalf->collider = Collider::createCapsule(0.06f * scale, 0.36f * scale);
        rightCalf->position = rightThigh->position + Vec3(0.0f, -0.40f, 0.0f) * scale;
        rightCalf->setMass(5.0f);
        rightCalf->invInertiaBody = InertiaTensor::createCylinder(5.0f, 0.06f * scale, 0.36f * scale).inverse();
        rightCalf->updateInertiaWorld();
        world.addBody(rightCalf);

        auto rightKnee = std::make_shared<JointConstraint>();
        rightKnee->bodyA = rightThigh.get();
        rightKnee->bodyB = rightCalf.get();
        rightKnee->type = JointType::Hinge;
        rightKnee->localAnchorA = Vec3(0.0f, -0.18f, 0.0f) * scale;
        rightKnee->localAnchorB = Vec3(0.0f, 0.18f, 0.0f) * scale;
        rightKnee->localAxisA = Vec3(1.0f, 0.0f, 0.0f);
        rightKnee->localAxisB = Vec3(1.0f, 0.0f, 0.0f);
        rightKnee->minAngle = 0.0f;
        rightKnee->maxAngle = 2.4f;
        world.addJoint(rightKnee);
        ragdoll->bones.push_back({ "RightCalf", rightCalf, 5, rightKnee });

        return ragdoll;
    }
};

} // namespace rigidbody
} // namespace scratchbox

#endif // SCRATCHBOX_RIGIDBODY_HPP
