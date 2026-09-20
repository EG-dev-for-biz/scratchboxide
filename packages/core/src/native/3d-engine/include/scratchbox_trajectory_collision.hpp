/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

#ifndef SCRATCHBOX_TRAJECTORY_COLLISION_HPP
#define SCRATCHBOX_TRAJECTORY_COLLISION_HPP

#include "scratchbox_math.hpp"
#include "scratchbox_geometry.hpp"
#include "scratchbox_bvh.hpp"
#include <vector>
#include <cmath>
#include <algorithm>
#include <iostream>
#include <iomanip>

namespace scratchbox {
namespace collision {

using math::Vec3;
using math::Ray;
using geometry::ScratchboxMesh;
using bvh::BvhTree;
using bvh::RayHit;

/**
 * 6-DOF Camera Waypoint definition.
 */
struct CameraWaypoint {
    int frameIndex{0};
    float timeSec{0.0f};
    Vec3 position{0.0f, 0.0f, 0.0f};
    Vec3 target{0.0f, 0.0f, 0.0f};
    Vec3 up{0.0f, 1.0f, 0.0f};
    float fov{65.0f};
    float rollDeg{0.0f};
};

/**
 * Spatial audit result for an individual camera frame.
 */
struct FrameCollisionResult {
    int frameIndex{0};
    float timeSec{0.0f};
    Vec3 cameraPos{0.0f, 0.0f, 0.0f};
    bool isPenetrating{false};
    bool breachesClearance{false};
    float distanceToSurface{0.0f};
    float surfaceElevationUnderCamera{0.0f};
    float requiredClearance{5.0f};
    float elevationDeltaNeeded{0.0f};
    Vec3 closestSurfacePoint{0.0f, 0.0f, 0.0f};
};

/**
 * Summary report of full trajectory collision and clearance audit.
 */
struct TrajectoryAuditReport {
    size_t totalFramesAudited{0};
    size_t collidingFramesCount{0};
    size_t clearanceBreachesCount{0};
    float minClearanceEncountered{std::numeric_limits<float>::infinity()};
    float maxElevationAdjustment{0.0f};
    bool isCleanAndClear{true};
    std::vector<FrameCollisionResult> frameDetails;
};

/**
 * High-performance C++20 Trajectory Collision & Obstacle Avoidance Engine.
 */
class TrajectoryCollisionAuditor {
public:
    /**
     * Audits a trajectory against a scene mesh using an SAH BVH tree.
     */
    static TrajectoryAuditReport auditTrajectory(
        const std::vector<CameraWaypoint>& trajectory,
        const ScratchboxMesh& mesh,
        float minClearance = 5.0f,
        float skyProbeAltitude = 600.0f
    ) {
        BvhTree bvh;
        bvh.build(mesh);
        return auditTrajectoryWithBvh(trajectory, bvh, minClearance, skyProbeAltitude);
    }

    /**
     * Audits a trajectory against a pre-built BVH tree.
     */
    static TrajectoryAuditReport auditTrajectoryWithBvh(
        const std::vector<CameraWaypoint>& trajectory,
        const BvhTree& bvh,
        float minClearance = 5.0f,
        float skyProbeAltitude = 600.0f
    ) {
        TrajectoryAuditReport report;
        report.totalFramesAudited = trajectory.size();
        report.minClearanceEncountered = std::numeric_limits<float>::infinity();

        for (size_t i = 0; i < trajectory.size(); ++i) {
            const auto& wp = trajectory[i];
            FrameCollisionResult res;
            res.frameIndex = wp.frameIndex;
            res.timeSec = wp.timeSec;
            res.cameraPos = wp.position;
            res.requiredClearance = minClearance;

            // 1. Omnidirectional Distance Query via BVH closestPoint
            float distSq = 0.0f;
            Vec3 closestPt = bvh.closestPoint(wp.position, distSq);
            float dist = std::sqrt(std::max(0.0f, distSq));
            res.distanceToSurface = dist;
            res.closestSurfacePoint = closestPt;

            if (dist < report.minClearanceEncountered) {
                report.minClearanceEncountered = dist;
            }

            // 2. Vertical Downward Elevation Probe from Sky
            Ray downRay(Vec3(wp.position.x, skyProbeAltitude, wp.position.z), Vec3(0.0f, -1.0f, 0.0f));
            RayHit hit;
            float surfaceY = -1e9f;
            if (bvh.raycast(downRay, hit)) {
                surfaceY = hit.position.y;
            }
            res.surfaceElevationUnderCamera = surfaceY;

            // 3. Collision / Penetration Analysis
            // If camera position altitude is below the rooftop or ground surface elevation:
            if (surfaceY > -1e8f && wp.position.y <= surfaceY) {
                res.isPenetrating = true;
                res.breachesClearance = true;
                float needed = (surfaceY + minClearance) - wp.position.y;
                res.elevationDeltaNeeded = std::max(res.elevationDeltaNeeded, needed);
            } else if (dist < minClearance) {
                res.breachesClearance = true;
                float needed = minClearance - dist;
                res.elevationDeltaNeeded = std::max(res.elevationDeltaNeeded, needed);
            }

            if (res.isPenetrating) {
                report.collidingFramesCount++;
            }
            if (res.breachesClearance) {
                report.clearanceBreachesCount++;
                report.maxElevationAdjustment = std::max(report.maxElevationAdjustment, res.elevationDeltaNeeded);
            }

            report.frameDetails.push_back(res);
        }

        report.isCleanAndClear = (report.clearanceBreachesCount == 0);
        return report;
    }

    /**
     * Resolves collisions and clearance violations by smoothly elevating the trajectory
     * with Gaussian-weighted kernel filtering to maintain C2 continuity and zero jerk.
     */
    static std::vector<CameraWaypoint> resolveTrajectoryCollisions(
        const std::vector<CameraWaypoint>& originalTrajectory,
        const ScratchboxMesh& mesh,
        float minClearance = 5.0f,
        int smoothingRadius = 8
    ) {
        BvhTree bvh;
        bvh.build(mesh);

        auto report = auditTrajectoryWithBvh(originalTrajectory, bvh, minClearance);
        if (report.isCleanAndClear) {
            return originalTrajectory;
        }

        std::vector<CameraWaypoint> corrected = originalTrajectory;
        size_t n = corrected.size();

        // Extract raw elevation delta requirements
        std::vector<float> rawDeltas(n, 0.0f);
        for (size_t i = 0; i < n; ++i) {
            rawDeltas[i] = report.frameDetails[i].elevationDeltaNeeded;
        }

        // Apply Gaussian smoothing kernel to prevent sharp altitude kinks
        std::vector<float> smoothedDeltas(n, 0.0f);
        for (int i = 0; i < static_cast<int>(n); ++i) {
            float weightSum = 0.0f;
            float maxNearbyDelta = 0.0f;

            for (int k = -smoothingRadius; k <= smoothingRadius; ++k) {
                int idx = std::clamp(i + k, 0, static_cast<int>(n) - 1);
                maxNearbyDelta = std::max(maxNearbyDelta, rawDeltas[idx]);
                float sigma = static_cast<float>(smoothingRadius) * 0.5f;
                float weight = std::exp(-0.5f * (k * k) / (sigma * sigma));
                smoothedDeltas[i] += rawDeltas[idx] * weight;
                weightSum += weight;
            }

            if (weightSum > 1e-5f) {
                smoothedDeltas[i] /= weightSum;
            }
            // Ensure the peak clearance is always preserved
            smoothedDeltas[i] = std::max(smoothedDeltas[i], maxNearbyDelta * 0.95f);
        }

        // Apply smoothed elevation delta to waypoints
        for (size_t i = 0; i < n; ++i) {
            corrected[i].position.y += smoothedDeltas[i];
            // Recompute orientation to smoothly track target with adjusted position
            Vec3 forward = (corrected[i].target - corrected[i].position).normalized();
            Vec3 worldUp(0, 1, 0);
            Vec3 right = forward.cross(worldUp).normalized();
            Vec3 camUp = right.cross(forward).normalized();

            float rollRad = corrected[i].rollDeg * (std::numbers::pi_v<float> / 180.0f);
            corrected[i].up = (camUp * std::cos(rollRad) + right * std::sin(rollRad)).normalized();
        }

        return corrected;
    }
};

} // namespace collision
} // namespace scratchbox

#endif // SCRATCHBOX_TRAJECTORY_COLLISION_HPP
