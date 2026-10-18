/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * SB-Archi (Scratchbox Classical Architecture Inversion Optimizer)
 * Native C++20 Analysis-by-Synthesis Architectural Inversion Solver.
 *
 * Inverts classical Roman Vitruvian structural priors against raw photogrammetric
 * scans (Google Maps 3D Tiles, aerial meshes):
 * - Fits elliptical semi-major/minor axes (a, b), height, and yaw orientation
 * - Chamfer distance residual minimization
 * - Telemetry reporting for pipeline auditing and visual criticism
 ********************************************************************************/

#ifndef SCRATCHBOX_SB_ARCHI_OPTIMIZER_HPP
#define SCRATCHBOX_SB_ARCHI_OPTIMIZER_HPP

#include "scratchbox_math.hpp"
#include "scratchbox_geometry.hpp"
#include "scratchbox_sb_archi.hpp"

#include <vector>
#include <string>
#include <cmath>
#include <algorithm>
#include <chrono>
#include <iostream>
#include <sstream>

namespace scratchbox {
namespace sb_archi {

using math::Vec3;
using geometry::Vertex;
using geometry::ScratchboxMesh;

struct SbArchiInversionMetrics {
    float initialChamferMeters = 0.0f;
    float fittedChamferMeters = 0.0f;
    float chamferReductionPct = 0.0f;
    int scanPointsEvaluated = 0;
    int synthesizedVertices = 0;
    int synthesizedTriangles = 0;
    float optimizerRuntimeMs = 0.0f;
    bool converged = false;      // true only when a full descent pass found no further improvement
    int iterationsRun = 0;

    // Optimized parameters (meaningful only when scanPointsEvaluated > 0)
    float fittedSemiMajorAxisA = 0.0f;
    float fittedSemiMinorAxisB = 0.0f;
    float fittedTotalHeight = 0.0f;
    Vec3 fittedCenter{ 0.0f, 0.0f, 0.0f };
    float fittedYawRad = 0.0f;
};

class SbArchiOptimizer {
public:
    static SbArchiInversionMetrics invertScanToArchi(
        const std::vector<Vec3>& scanPoints,
        const SbArchiParams& nominalParams,
        SbArchiParams& outOptimizedParams,
        int maxIterations = 25)
    {
        auto tStart = std::chrono::high_resolution_clock::now();
        SbArchiInversionMetrics metrics;
        metrics.scanPointsEvaluated = static_cast<int>(scanPoints.size());

        outOptimizedParams = nominalParams;

        if (scanPoints.empty()) {
            // Nothing to fit against: not converged, parameters left at nominal.
            return metrics;
        }

        // 1. Compute empirical spatial bounding box & centroid of scan points
        Vec3 scanMin(1e9f, 1e9f, 1e9f);
        Vec3 scanMax(-1e9f, -1e9f, -1e9f);
        Vec3 scanSum(0.0f, 0.0f, 0.0f);

        for (const auto& p : scanPoints) {
            scanMin.x = std::min(scanMin.x, p.x);
            scanMin.y = std::min(scanMin.y, p.y);
            scanMin.z = std::min(scanMin.z, p.z);

            scanMax.x = std::max(scanMax.x, p.x);
            scanMax.y = std::max(scanMax.y, p.y);
            scanMax.z = std::max(scanMax.z, p.z);

            scanSum += p;
        }

        Vec3 scanCentroid = scanSum * (1.0f / scanPoints.size());
        float scanHeight = scanMax.y - scanMin.y;

        // 2. Initial Chamfer distance computation against nominal elliptical envelope
        metrics.initialChamferMeters = computePointToArcadeDistance(scanPoints, nominalParams);

        // 3. Coordinate Descent Optimization on (a, b, Height, Center, Yaw)
        float bestA = nominalParams.semiMajorAxisA;
        float bestB = nominalParams.semiMinorAxisB;
        float bestH = std::max(nominalParams.totalHeightMeters, scanHeight);
        Vec3 bestCenter = nominalParams.worldCenter;
        float bestYaw = nominalParams.worldYawRad;
        float bestError = metrics.initialChamferMeters;

        // Subsample for fast Chamfer evaluation
        int stride = std::max(1, static_cast<int>(scanPoints.size()) / 1200);
        std::vector<Vec3> subsampled;
        subsampled.reserve(scanPoints.size() / stride + 1);
        for (size_t i = 0; i < scanPoints.size(); i += stride) {
            subsampled.push_back(scanPoints[i]);
        }

        // Search steps
        float stepA = 0.5f;
        float stepB = 0.5f;
        float stepYaw = 0.005f;

        bool settled = false;
        for (int iter = 0; iter < maxIterations; ++iter) {
            metrics.iterationsRun = iter + 1;
            bool improved = false;

            // Perturb semi-major axis A
            for (float dA : { -stepA, stepA }) {
                SbArchiParams testParams = outOptimizedParams;
                testParams.semiMajorAxisA = bestA + dA;
                float err = computePointToArcadeDistance(subsampled, testParams);
                if (err < bestError) {
                    bestError = err;
                    bestA += dA;
                    improved = true;
                }
            }

            // Perturb semi-minor axis B
            for (float dB : { -stepB, stepB }) {
                SbArchiParams testParams = outOptimizedParams;
                testParams.semiMinorAxisB = bestB + dB;
                float err = computePointToArcadeDistance(subsampled, testParams);
                if (err < bestError) {
                    bestError = err;
                    bestB += dB;
                    improved = true;
                }
            }

            // Perturb Yaw
            for (float dY : { -stepYaw, stepYaw }) {
                SbArchiParams testParams = outOptimizedParams;
                testParams.worldYawRad = bestYaw + dY;
                float err = computePointToArcadeDistance(subsampled, testParams);
                if (err < bestError) {
                    bestError = err;
                    bestYaw += dY;
                    improved = true;
                }
            }

            outOptimizedParams.semiMajorAxisA = bestA;
            outOptimizedParams.semiMinorAxisB = bestB;
            outOptimizedParams.totalHeightMeters = bestH;
            outOptimizedParams.worldCenter = bestCenter;
            outOptimizedParams.worldYawRad = bestYaw;

            stepA *= 0.85f;
            stepB *= 0.85f;
            stepYaw *= 0.85f;

            if (!improved && iter > 5) { settled = true; break; }
        }

        // 4. Compute final fitted Chamfer distance
        metrics.fittedChamferMeters = computePointToArcadeDistance(scanPoints, outOptimizedParams);
        metrics.chamferReductionPct = ((metrics.initialChamferMeters - metrics.fittedChamferMeters) /
                                       std::max(0.001f, metrics.initialChamferMeters)) * 100.0f;

        metrics.fittedSemiMajorAxisA = bestA;
        metrics.fittedSemiMinorAxisB = bestB;
        metrics.fittedTotalHeight = bestH;
        metrics.fittedCenter = bestCenter;
        metrics.fittedYawRad = bestYaw;
        metrics.converged = settled;

        auto tEnd = std::chrono::high_resolution_clock::now();
        metrics.optimizerRuntimeMs = std::chrono::duration<float, std::milli>(tEnd - tStart).count();

        return metrics;
    }

private:
    static float computePointToArcadeDistance(const std::vector<Vec3>& points, const SbArchiParams& params) {
        if (points.empty()) return 0.0f;

        float cosY = std::cos(-params.worldYawRad);
        float sinY = std::sin(-params.worldYawRad);

        float a = params.semiMajorAxisA;
        float b = params.semiMinorAxisB;
        float totalDist = 0.0f;

        for (const auto& p : points) {
            // Transform point into Colosseum local elliptical coordinates
            Vec3 local = p - params.worldCenter;
            float rx = cosY * local.x - sinY * local.z;
            float rz = sinY * local.x + cosY * local.z;
            float ry = local.y;

            // Distance to ellipse in XZ plane
            float angle = std::atan2(rz / b, rx / a);
            float ex = a * std::cos(angle);
            float ez = b * std::sin(angle);

            float dx = rx - ex;
            float dz = rz - ez;
            float planarDist = std::sqrt(dx * dx + dz * dz);

            // Distance to vertical height envelope [0, H]
            float dy = 0.0f;
            if (ry < 0.0f) dy = -ry;
            else if (ry > params.totalHeightMeters) dy = ry - params.totalHeightMeters;

            totalDist += std::sqrt(planarDist * planarDist + dy * dy);
        }

        return totalDist / points.size();
    }
};

} // namespace sb_archi
} // namespace scratchbox

#endif // SCRATCHBOX_SB_ARCHI_OPTIMIZER_HPP
