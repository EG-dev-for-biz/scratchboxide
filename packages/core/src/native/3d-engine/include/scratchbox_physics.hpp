/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

#ifndef SCRATCHBOX_PHYSICS_HPP
#define SCRATCHBOX_PHYSICS_HPP

#include "scratchbox_math.hpp"
#include <vector>
#include <cmath>

namespace scratchbox {
namespace physics {

using math::Vec3;

struct Particle {
    Vec3 position{0.0f, 0.0f, 0.0f};
    Vec3 oldPosition{0.0f, 0.0f, 0.0f};
    Vec3 acceleration{0.0f, 0.0f, 0.0f};
    float invMass{1.0f}; // 0 = pinned / immovable

    Particle() = default;
    Particle(const Vec3& p, float mass = 1.0f)
        : position(p), oldPosition(p), acceleration(0, 0, 0), invMass(mass > 0.0f ? 1.0f / mass : 0.0f) {}

    void stepVerlet(float dt, float damping = 0.99f) {
        if (invMass == 0.0f) return;
        Vec3 velocity = (position - oldPosition) * damping;
        oldPosition = position;
        position = position + velocity + acceleration * (dt * dt);
        acceleration = Vec3(0, 0, 0); // reset after step
    }

    void applyForce(const Vec3& f) {
        if (invMass == 0.0f) return;
        acceleration += f * invMass;
    }
};

struct DistanceConstraint {
    size_t p1{0};
    size_t p2{0};
    float targetDistance{1.0f};
    float stiffness{1.0f};

    void solve(std::vector<Particle>& particles) const {
        Particle& a = particles[p1];
        Particle& b = particles[p2];

        float wA = a.invMass;
        float wB = b.invMass;
        float wSum = wA + wB;
        if (wSum == 0.0f) return;

        Vec3 delta = b.position - a.position;
        float currentDist = delta.length();
        if (currentDist < 1e-6f) return;

        float diff = (currentDist - targetDistance) / (currentDist * wSum);
        Vec3 correction = delta * (diff * stiffness);

        if (wA > 0.0f) a.position += correction * wA;
        if (wB > 0.0f) b.position -= correction * wB;
    }
};

class AerodynamicsSolver {
public:
    static Vec3 calculateLiftAndDrag(
        const Vec3& airVelocity,
        const Vec3& wingNormal,
        float wingArea = 10.0f,
        float airDensity = 1.225f
    ) {
        float speed = airVelocity.length();
        if (speed < 1e-4f) return Vec3(0, 0, 0);

        Vec3 streamDir = airVelocity.normalized();
        float angleOfAttack = -streamDir.dot(wingNormal); // approx sin of alpha

        // Thin airfoil theory approximations
        float cl = 2.0f * math::PI * angleOfAttack;
        cl = std::clamp(cl, -1.4f, 1.4f); // stall bounds

        float cd0 = 0.02f; // parasitic drag
        float cd = cd0 + (cl * cl) / (math::PI * 6.0f); // induced drag

        float dynamicPressure = 0.5f * airDensity * speed * speed * wingArea;

        Vec3 liftDir = streamDir.cross(streamDir.cross(wingNormal)).normalized();
        Vec3 dragDir = streamDir;

        Vec3 liftForce = liftDir * (cl * dynamicPressure);
        Vec3 dragForce = dragDir * (cd * dynamicPressure);

        return liftForce + dragForce;
    }
};

/**
 * High-performance sliding-plane collision solver for complex 3D photogrammetry tile meshes.
 */
class TileCollisionSolver {
public:
    /**
     * Resolve velocity against a collision plane normal to prevent sticking or penetrating into walls/terrain.
     * v_slide = v_original - (v_original . normal) * normal
     */
    static Vec3 resolveSlideVelocity(
        const Vec3& currentVelocity,
        const Vec3& surfaceNormal,
        float friction = 0.1f,
        float restitution = 0.0f
    ) {
        float dot = currentVelocity.dot(surfaceNormal);
        if (dot >= 0.0f) {
            // Moving away from surface
            return currentVelocity;
        }

        Vec3 normalComponent = surfaceNormal * dot;
        Vec3 tangentComponent = currentVelocity - normalComponent;

        // Apply friction along tangent and restitution along normal
        Vec3 resolvedTangent = tangentComponent * std::clamp(1.0f - friction, 0.0f, 1.0f);
        Vec3 resolvedNormal = normalComponent * (-restitution);

        return resolvedTangent + resolvedNormal;
    }

    /**
     * Resolve ground snapping and step-up logic.
     */
    static float resolveGroundSnap(
        float currentY,
        float groundElevation,
        float maxStepClimb = 0.45f
    ) {
        float heightDiff = groundElevation - currentY;
        if (heightDiff <= maxStepClimb && heightDiff >= -0.1f) {
            return groundElevation;
        }
        return currentY;
    }
};

/**
 * Water buoyancy and viscous fluid drag physics solver.
 */
class WaterBuoyancySolver {
public:
    struct BuoyancyResult {
        Vec3 buoyantForce{0.0f, 0.0f, 0.0f};
        Vec3 fluidDragForce{0.0f, 0.0f, 0.0f};
        float submersionRatio{0.0f}; // 0.0 = dry, 1.0 = fully submerged
    };

    /**
     * Calculate upward buoyancy force and fluid resistance on an entity in water.
     *
     * @param entityPos Position of entity (usually center of mass or feet)
     * @param velocity Velocity vector of entity
     * @param waterSurfaceY Y-coordinate of water plane
     * @param entityHeight Total height of entity (meters)
     * @param entityVolume Displaced volume (m^3)
     * @param fluidDensity Density of water (kg/m^3, default 1000)
     * @param gravity Gravitational acceleration (default 9.81 m/s^2)
     */
    static BuoyancyResult computeForces(
        const Vec3& entityPos,
        const Vec3& velocity,
        float waterSurfaceY,
        float entityHeight = 1.8f,
        float entityVolume = 0.075f,
        float fluidDensity = 1000.0f,
        float gravity = 9.81f
    ) {
        BuoyancyResult result;
        float bottomY = entityPos.y;
        float topY = bottomY + entityHeight;

        if (bottomY >= waterSurfaceY) {
            // Completely above water
            return result;
        }

        // Submerged fraction
        float submergedHeight = std::clamp(waterSurfaceY - bottomY, 0.0f, entityHeight);
        result.submersionRatio = submergedHeight / entityHeight;

        // Archimedes Principle: F_buoyant = rho * V_submerged * g
        float displacedVolume = entityVolume * result.submersionRatio;
        float upwardForceMagnitude = fluidDensity * displacedVolume * gravity;
        result.buoyantForce = Vec3(0.0f, upwardForceMagnitude, 0.0f);

        // Fluid drag force: F_drag = -0.5 * rho * v^2 * Cd * Area
        float speed = velocity.length();
        if (speed > 1e-4f) {
            float dragCoeff = 1.05f; // cylinder/human form
            float frontalArea = 0.5f * result.submersionRatio;
            float dragMag = 0.5f * fluidDensity * speed * speed * dragCoeff * frontalArea;
            result.fluidDragForce = velocity.normalized() * (-dragMag);
        }

        return result;
    }
};

} // namespace physics
} // namespace scratchbox

#endif // SCRATCHBOX_PHYSICS_HPP
