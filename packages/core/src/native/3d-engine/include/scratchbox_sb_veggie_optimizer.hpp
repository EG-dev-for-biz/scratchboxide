/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

#ifndef SCRATCHBOX_SB_VEGGIE_OPTIMIZER_HPP
#define SCRATCHBOX_SB_VEGGIE_OPTIMIZER_HPP

#include "scratchbox_math.hpp"
#include "scratchbox_geometry.hpp"
#include "scratchbox_sb_veggie.hpp"

#include <vector>
#include <cmath>
#include <algorithm>
#include <chrono>
#include <limits>
#include <iostream>


namespace scratchbox {
namespace sb_veggie {

using math::Vec3;
using math::AABB;
using geometry::ScratchboxMesh;

// ============================================================================
// 1. Inversion Solver Configuration & Telemetry
// ============================================================================

struct SbVeggieOptimizerOptions {
    int maxIterations{25};
    float learningRate{0.45f};
    float lambdaChamfer{1.0f};
    float lambdaPrior{0.08f};
    float lambdaGroundAnchor{2.5f};
    float tolerance{1e-4f};
    int subsampleScanPoints{200}; // Subsample large scan clouds for <50ms execution
};

struct SbVeggieOptimizerResult {
    SbVeggieParams fittedParams;
    float initialChamferMeters{0.0f};
    float finalChamferMeters{0.0f};
    float chamferReductionPercent{0.0f};
    int iterationsRun{0};
    bool converged{false};
    double solveTimeMs{0.0};
    float scaffoldAzimuthDeg[8]{0.0f};
    float scaffoldElevationDeg[8]{0.0f};
    float scaffoldReachScale[8]{1.0f, 1.0f, 1.0f, 1.0f, 1.0f, 1.0f, 1.0f, 1.0f};
};

// ============================================================================
// 2. SB-Veggie Inversion Optimizer Inversion Engine
// ============================================================================

class SbVeggieOptimizer {
public:
    /**
     * Fits the canonical SB-Veggie parametric model to an unsegmented 3D scan blob
     * (e.g. Google Maps Photorealistic 3D Tiles tree mesh or LiDAR point cloud).
     * Employs Two-Stage Inversion:
     *   Stage 1: Global Metric Calibration (translation, height, crown spread, DBH)
     *   Stage 2: Asymmetric Bough Inverse Kinematics (8 scaffolds x [azimuth, elevation, reach])
     */
    static SbVeggieOptimizerResult fitToScan(
        const std::vector<Vec3>& scanPoints,
        const SbVeggieTemplate& tmpl,
        const SbVeggieOptimizerOptions& options = SbVeggieOptimizerOptions(),
        const Vec3* explicitAnchor = nullptr
    ) {
        auto startTime = std::chrono::high_resolution_clock::now();
        SbVeggieOptimizerResult result;
        result.fittedParams = SbVeggieParams::createNeutral();

        if (scanPoints.empty()) {
            result.converged = false;
            return result;
        }

        // 1. Subsample Scan Points for Real-Time Execution
        std::vector<Vec3> subsampled;
        subsampled.reserve(options.subsampleScanPoints);
        size_t step = std::max<size_t>(1, scanPoints.size() / options.subsampleScanPoints);
        for (size_t i = 0; i < scanPoints.size() && subsampled.size() < static_cast<size_t>(options.subsampleScanPoints); i += step) {
            subsampled.push_back(scanPoints[i]);
        }

        // 2. Scan Spatial Bounding Box & Centroid Analysis
        AABB scanBounds;
        for (const auto& p : subsampled) {
            scanBounds.expand(p);
        }

        if (explicitAnchor != nullptr) {
            result.fittedParams.translation = *explicitAnchor;
        } else {
            result.fittedParams.translation = Vec3((scanBounds.min.x + scanBounds.max.x) * 0.5f, scanBounds.min.y, (scanBounds.min.z + scanBounds.max.z) * 0.5f);
        }

        float scanHeight = std::max(1.0f, scanBounds.max.y - result.fittedParams.translation.y);
        float scanRadius = 0.5f * std::max(scanBounds.max.x - scanBounds.min.x, scanBounds.max.z - scanBounds.min.z);

        // 3. Analytical Heuristic Parameter Initialization (Cold Start)
        // Canonical street tree baseline: height is 6.0m, crown spread radius is 2.7m (5.4m diameter).
        // The template has no global scale: height only scales through beta[1] (x(1 + 0.35*beta1), clamped at +-3),
        // so crowns taller than ~12.3 m cannot be represented and fit with residual height error.
        float canonicalHeight = 6.0f;
        float canonicalRadius = 2.7f;

        // Initialize Mode 1 (Height): beta[1] in [-2.5, 2.5]
        result.fittedParams.beta[1] = std::clamp((scanHeight - canonicalHeight) / (canonicalHeight * 0.35f), -2.5f, 2.5f);

        // Initialize Mode 2 (Crown Spread): beta[2] in [-2.5, 2.5]
        result.fittedParams.beta[2] = std::clamp((scanRadius - canonicalRadius) / (canonicalRadius * 0.40f), -2.5f, 2.5f);

        // Mode 3: Crown base clearance
        result.fittedParams.beta[3] = std::clamp((scanHeight * 0.30f - 1.8f) * 0.6f, -1.5f, 1.5f);

        // Initial Chamfer Evaluation
        float initialLoss = evaluateChamferDistance(result.fittedParams, tmpl, subsampled);
        result.initialChamferMeters = std::sqrt(initialLoss);

        float currentLoss = initialLoss;
        float lrGlobal = options.learningRate;
        float lrBough = 0.35f;

        const std::vector<int> activeGlobalModes = {0, 1, 2, 3, 4, 6, 7};
        const float epsGlobal = 0.05f;
        const float epsAngle = 0.04f;
        const float epsReach = 0.04f;
        const float lambdaBoughPrior = 0.04f;

        int stage1Iters = std::min(10, options.maxIterations / 2);

        // 4. Hierarchical Two-Stage Numerical Optimization Loop
        for (int iter = 0; iter < options.maxIterations; ++iter) {
            result.iterationsRun++;

            if (iter < stage1Iters) {
                // ============================================================
                // STAGE 1: Global Metric Calibration (beta[0..7])
                // ============================================================
                std::vector<float> grad(16, 0.0f);
                for (int mode : activeGlobalModes) {
                    SbVeggieParams pPlus = result.fittedParams;
                    SbVeggieParams pMinus = result.fittedParams;
                    pPlus.beta[mode] += epsGlobal;
                    pMinus.beta[mode] -= epsGlobal;

                    float lossPlus = evaluateChamferDistance(pPlus, tmpl, subsampled);
                    float lossMinus = evaluateChamferDistance(pMinus, tmpl, subsampled);

                    float dChamfer = (lossPlus - lossMinus) / (2.0f * epsGlobal);
                    float dPrior = 2.0f * options.lambdaPrior * result.fittedParams.beta[mode];
                    grad[mode] = options.lambdaChamfer * dChamfer + dPrior;
                }

                // Backtracking line search on global parameters
                bool improved = false;
                float stepLr = lrGlobal;
                for (int lineStep = 0; lineStep < 4; ++lineStep) {
                    SbVeggieParams candidate = result.fittedParams;
                    for (int mode : activeGlobalModes) {
                        candidate.beta[mode] = std::clamp(candidate.beta[mode] - stepLr * grad[mode], -3.0f, 3.0f);
                    }
                    float candidateLoss = evaluateChamferDistance(candidate, tmpl, subsampled);
                    if (candidateLoss < currentLoss) {
                        result.fittedParams = candidate;
                        currentLoss = candidateLoss;
                        lrGlobal = std::min(stepLr * 1.15f, 1.5f);
                        improved = true;
                        break;
                    }
                    stepLr *= 0.5f;
                }
                if (!improved) lrGlobal *= 0.5f;

            } else {
                // ============================================================
                // STAGE 2: Asymmetric Bough IK Inversion (24 DOFs: 8 boughs x [azim, elev, reach])
                // ============================================================
                float gradAzim[8]{0.0f};
                float gradElev[8]{0.0f};
                float gradReach[8]{0.0f};

                for (int i = 0; i < 8; ++i) {
                    // Azimuth gradient
                    SbVeggieParams pPlusA = result.fittedParams;
                    SbVeggieParams pMinusA = result.fittedParams;
                    pPlusA.scaffoldIK[i].azimuthOffset += epsAngle;
                    pMinusA.scaffoldIK[i].azimuthOffset -= epsAngle;
                    float lossPlusA = evaluateChamferDistance(pPlusA, tmpl, subsampled);
                    float lossMinusA = evaluateChamferDistance(pMinusA, tmpl, subsampled);
                    gradAzim[i] = options.lambdaChamfer * (lossPlusA - lossMinusA) / (2.0f * epsAngle) +
                                  2.0f * lambdaBoughPrior * result.fittedParams.scaffoldIK[i].azimuthOffset;

                    // Elevation gradient
                    SbVeggieParams pPlusE = result.fittedParams;
                    SbVeggieParams pMinusE = result.fittedParams;
                    pPlusE.scaffoldIK[i].elevationOffset += epsAngle;
                    pMinusE.scaffoldIK[i].elevationOffset -= epsAngle;
                    float lossPlusE = evaluateChamferDistance(pPlusE, tmpl, subsampled);
                    float lossMinusE = evaluateChamferDistance(pMinusE, tmpl, subsampled);
                    gradElev[i] = options.lambdaChamfer * (lossPlusE - lossMinusE) / (2.0f * epsAngle) +
                                  2.0f * lambdaBoughPrior * result.fittedParams.scaffoldIK[i].elevationOffset;

                    // Reach gradient
                    SbVeggieParams pPlusR = result.fittedParams;
                    SbVeggieParams pMinusR = result.fittedParams;
                    pPlusR.scaffoldIK[i].reachScale += epsReach;
                    pMinusR.scaffoldIK[i].reachScale -= epsReach;
                    float lossPlusR = evaluateChamferDistance(pPlusR, tmpl, subsampled);
                    float lossMinusR = evaluateChamferDistance(pMinusR, tmpl, subsampled);
                    gradReach[i] = options.lambdaChamfer * (lossPlusR - lossMinusR) / (2.0f * epsReach) +
                                   2.0f * lambdaBoughPrior * (result.fittedParams.scaffoldIK[i].reachScale - 1.0f);
                }

                // Fine-tuning Height (beta[1]) and Spread (beta[2]) in Stage 2
                SbVeggieParams pPlusH = result.fittedParams;
                SbVeggieParams pMinusH = result.fittedParams;
                pPlusH.beta[1] += epsGlobal; pMinusH.beta[1] -= epsGlobal;
                float gradH = options.lambdaChamfer * (evaluateChamferDistance(pPlusH, tmpl, subsampled) - evaluateChamferDistance(pMinusH, tmpl, subsampled)) / (2.0f * epsGlobal);

                SbVeggieParams pPlusS = result.fittedParams;
                SbVeggieParams pMinusS = result.fittedParams;
                pPlusS.beta[2] += epsGlobal; pMinusS.beta[2] -= epsGlobal;
                float gradS = options.lambdaChamfer * (evaluateChamferDistance(pPlusS, tmpl, subsampled) - evaluateChamferDistance(pMinusS, tmpl, subsampled)) / (2.0f * epsGlobal);

                // Backtracking line search on Bough IK DOFs
                bool improved = false;
                float stepLr = lrBough;
                for (int lineStep = 0; lineStep < 4; ++lineStep) {
                    SbVeggieParams candidate = result.fittedParams;
                    for (int i = 0; i < 8; ++i) {
                        candidate.scaffoldIK[i].azimuthOffset = std::clamp(
                            candidate.scaffoldIK[i].azimuthOffset - stepLr * gradAzim[i], -0.45f, 0.45f);
                        candidate.scaffoldIK[i].elevationOffset = std::clamp(
                            candidate.scaffoldIK[i].elevationOffset - stepLr * gradElev[i], -0.35f, 0.35f);
                        candidate.scaffoldIK[i].reachScale = std::clamp(
                            candidate.scaffoldIK[i].reachScale - stepLr * gradReach[i], 0.65f, 1.45f);
                    }
                    candidate.beta[1] = std::clamp(candidate.beta[1] - stepLr * 0.4f * gradH, -3.0f, 3.0f);
                    candidate.beta[2] = std::clamp(candidate.beta[2] - stepLr * 0.4f * gradS, -3.0f, 3.0f);

                    float candidateLoss = evaluateChamferDistance(candidate, tmpl, subsampled);
                    if (candidateLoss < currentLoss) {
                        result.fittedParams = candidate;
                        if (std::abs(currentLoss - candidateLoss) < options.tolerance) {
                            result.converged = true;
                        }
                        currentLoss = candidateLoss;
                        lrBough = std::min(stepLr * 1.15f, 1.0f);
                        improved = true;
                        break;
                    }
                    stepLr *= 0.5f;
                }
                if (!improved) lrBough *= 0.5f;
            }

            if (result.converged) break;
        }

        // 5. Final Evaluation & Telemetry
        float finalLoss = evaluateChamferDistance(result.fittedParams, tmpl, subsampled);
        result.finalChamferMeters = std::sqrt(finalLoss);
        if (result.initialChamferMeters > 1e-4f) {
            result.chamferReductionPercent = (1.0f - result.finalChamferMeters / result.initialChamferMeters) * 100.0f;
        } else {
            result.chamferReductionPercent = 0.0f;
        }

        for (int i = 0; i < 8; ++i) {
            result.scaffoldAzimuthDeg[i] = result.fittedParams.scaffoldIK[i].azimuthOffset * (180.0f / 3.14159265f);
            result.scaffoldElevationDeg[i] = result.fittedParams.scaffoldIK[i].elevationOffset * (180.0f / 3.14159265f);
            result.scaffoldReachScale[i] = result.fittedParams.scaffoldIK[i].reachScale;
        }

        auto endTime = std::chrono::high_resolution_clock::now();
        result.solveTimeMs = std::chrono::duration<double, std::milli>(endTime - startTime).count();
        return result;
    }

private:
    // The fit compares the scan with where the tree's real surface is: the evaluated wood mesh (triangle centroids;
    // its topology is fixed, so they move continuously with the parameters) and the stations along each leaf
    // cluster's shootlets where the leaf cards are placed (SbVeggieEvaluator::foliageStations). Sampling the leaf
    // cards themselves would not do: their number changes with the parameters, which makes finite differences jump.
    static constexpr int kObjectiveWoodSamples = 160;
    static constexpr int kObjectiveStationsPerShootlet = 1;

    static std::vector<Vec3> surfacePoints(const SbVeggieParams& params, const SbVeggieTemplate& tmpl) {
        auto decomposed = SbVeggieEvaluator::evaluateDecomposed(tmpl, params, false);
        std::vector<Vec3> pts = SbVeggieEvaluator::foliageStations(tmpl, decomposed.posedJoints, params, kObjectiveStationsPerShootlet);
        const auto& v = decomposed.woodMesh.vertices;
        const auto& idx = decomposed.woodMesh.indices;
        size_t tris = idx.size() / 3;
        size_t stride = std::max<size_t>(1, tris / kObjectiveWoodSamples);
        for (size_t t = 0; t < tris; t += stride) {
            pts.push_back((v[idx[3 * t]].position + v[idx[3 * t + 1]].position + v[idx[3 * t + 2]].position) * (1.0f / 3.0f));
        }
        return pts;
    }

    static float meanNearestSq(const std::vector<Vec3>& from, const std::vector<Vec3>& to) {
        double acc = 0.0;
        for (const auto& p : from) {
            float best = std::numeric_limits<float>::max();
            for (const auto& q : to) best = std::min(best, (p - q).lengthSquared());
            acc += best;
        }
        return static_cast<float>(acc / from.size());
    }

public:
    // Symmetric Chamfer (mean squared nearest distance, both directions) between the scan and the real surface.
    static float evaluateChamferDistance(
        const SbVeggieParams& params,
        const SbVeggieTemplate& tmpl,
        const std::vector<Vec3>& scanPoints
    ) {
        std::vector<Vec3> treePoints = surfacePoints(params, tmpl);
        if (treePoints.empty() || scanPoints.empty()) return 100.0f;
        return 0.5f * (meanNearestSq(scanPoints, treePoints) + meanNearestSq(treePoints, scanPoints));
    }
};


} // namespace sb_veggie

// Backward-compatible type aliases for legacy code
namespace smpl_tree {
    using SmplOptimizerOptions = sb_veggie::SbVeggieOptimizerOptions;
    using SmplOptimizerResult = sb_veggie::SbVeggieOptimizerResult;
    using SmplTreeOptimizer = sb_veggie::SbVeggieOptimizer;
} // namespace smpl_tree

} // namespace scratchbox

#endif // SCRATCHBOX_SB_VEGGIE_OPTIMIZER_HPP
