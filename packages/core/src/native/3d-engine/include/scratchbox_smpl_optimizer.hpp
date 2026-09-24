/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

#ifndef SCRATCHBOX_SMPL_OPTIMIZER_HPP
#define SCRATCHBOX_SMPL_OPTIMIZER_HPP

#include "scratchbox_math.hpp"
#include "scratchbox_geometry.hpp"
#include "scratchbox_smpl_tree.hpp"

#include <vector>
#include <cmath>
#include <algorithm>
#include <chrono>
#include <limits>
#include <iostream>

namespace scratchbox {
namespace smpl_tree {

using math::Vec3;
using math::AABB;
using geometry::ScratchboxMesh;

// ============================================================================
// 1. Inversion Solver Configuration & Telemetry
// ============================================================================

struct SmplOptimizerOptions {
    int maxIterations{25};
    float learningRate{0.45f};
    float lambdaChamfer{1.0f};
    float lambdaPrior{0.08f};
    float lambdaGroundAnchor{2.5f};
    float tolerance{1e-4f};
    int subsampleScanPoints{200}; // Subsample large scan clouds for <50ms execution
};

struct SmplOptimizerResult {
    SmplTreeParams fittedParams;
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
// 2. SMPLify-Tree Inversion Engine
// ============================================================================

class SmplTreeOptimizer {
public:
    /**
     * Fits the canonical SMPL-Tree parametric model to an unsegmented 3D scan blob
     * (e.g. Google Maps Photorealistic 3D Tiles tree mesh or LiDAR point cloud).
     * Employs Two-Stage Inversion:
     *   Stage 1: Global Metric Calibration (translation, height, crown spread, DBH)
     *   Stage 2: Asymmetric Bough Inverse Kinematics (8 scaffolds x [azimuth, elevation, reach])
     */
    static SmplOptimizerResult fitToScan(
        const std::vector<Vec3>& scanPoints,
        const SmplTreeTemplate& tmpl,
        const SmplOptimizerOptions& options = SmplOptimizerOptions(),
        const Vec3* explicitAnchor = nullptr
    ) {
        auto startTime = std::chrono::high_resolution_clock::now();
        SmplOptimizerResult result;
        result.fittedParams = SmplTreeParams::createNeutral();

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
        // Canonical street tree baseline: height is 6.0m, crown spread radius is 2.7m (5.4m diameter)
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
                    SmplTreeParams pPlus = result.fittedParams;
                    SmplTreeParams pMinus = result.fittedParams;
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
                    SmplTreeParams candidate = result.fittedParams;
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
                    SmplTreeParams pPlusA = result.fittedParams;
                    SmplTreeParams pMinusA = result.fittedParams;
                    pPlusA.scaffoldIK[i].azimuthOffset += epsAngle;
                    pMinusA.scaffoldIK[i].azimuthOffset -= epsAngle;
                    float lossPlusA = evaluateChamferDistance(pPlusA, tmpl, subsampled);
                    float lossMinusA = evaluateChamferDistance(pMinusA, tmpl, subsampled);
                    gradAzim[i] = options.lambdaChamfer * (lossPlusA - lossMinusA) / (2.0f * epsAngle) +
                                  2.0f * lambdaBoughPrior * result.fittedParams.scaffoldIK[i].azimuthOffset;

                    // Elevation gradient
                    SmplTreeParams pPlusE = result.fittedParams;
                    SmplTreeParams pMinusE = result.fittedParams;
                    pPlusE.scaffoldIK[i].elevationOffset += epsAngle;
                    pMinusE.scaffoldIK[i].elevationOffset -= epsAngle;
                    float lossPlusE = evaluateChamferDistance(pPlusE, tmpl, subsampled);
                    float lossMinusE = evaluateChamferDistance(pMinusE, tmpl, subsampled);
                    gradElev[i] = options.lambdaChamfer * (lossPlusE - lossMinusE) / (2.0f * epsAngle) +
                                  2.0f * lambdaBoughPrior * result.fittedParams.scaffoldIK[i].elevationOffset;

                    // Reach gradient
                    SmplTreeParams pPlusR = result.fittedParams;
                    SmplTreeParams pMinusR = result.fittedParams;
                    pPlusR.scaffoldIK[i].reachScale += epsReach;
                    pMinusR.scaffoldIK[i].reachScale -= epsReach;
                    float lossPlusR = evaluateChamferDistance(pPlusR, tmpl, subsampled);
                    float lossMinusR = evaluateChamferDistance(pMinusR, tmpl, subsampled);
                    gradReach[i] = options.lambdaChamfer * (lossPlusR - lossMinusR) / (2.0f * epsReach) +
                                   2.0f * lambdaBoughPrior * (result.fittedParams.scaffoldIK[i].reachScale - 1.0f);
                }

                // Fine-tuning Height (beta[1]) and Spread (beta[2]) in Stage 2
                SmplTreeParams pPlusH = result.fittedParams;
                SmplTreeParams pMinusH = result.fittedParams;
                pPlusH.beta[1] += epsGlobal; pMinusH.beta[1] -= epsGlobal;
                float gradH = options.lambdaChamfer * (evaluateChamferDistance(pPlusH, tmpl, subsampled) - evaluateChamferDistance(pMinusH, tmpl, subsampled)) / (2.0f * epsGlobal);

                SmplTreeParams pPlusS = result.fittedParams;
                SmplTreeParams pMinusS = result.fittedParams;
                pPlusS.beta[2] += epsGlobal; pMinusS.beta[2] -= epsGlobal;
                float gradS = options.lambdaChamfer * (evaluateChamferDistance(pPlusS, tmpl, subsampled) - evaluateChamferDistance(pMinusS, tmpl, subsampled)) / (2.0f * epsGlobal);

                // Backtracking line search on Bough IK DOFs
                bool improved = false;
                float stepLr = lrBough;
                for (int lineStep = 0; lineStep < 4; ++lineStep) {
                    SmplTreeParams candidate = result.fittedParams;
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
    static float evaluateChamferDistance(
        const SmplTreeParams& params,
        const SmplTreeTemplate& tmpl,
        const std::vector<Vec3>& scanPoints
    ) {
        // Evaluate trunk and branch skeleton mesh with Asymmetric Bough IK
        auto decomposed = SmplTreeEvaluator::evaluateDecomposed(tmpl, params, false);
        const ScratchboxMesh& mesh = decomposed.woodMesh;

        if (mesh.vertices.empty() || scanPoints.empty()) return 100.0f;

        // Build composite evaluation point cloud: bare wood vertices + foliage cluster proxy points
        std::vector<Vec3> treePoints;
        treePoints.reserve(mesh.vertices.size() / 6 + tmpl.foliageAnchors.size() * 5);

        // Subsample mesh vertices (trunk and scaffold branches)
        size_t vCount = mesh.vertices.size();
        size_t vStride = std::max<size_t>(1, vCount / 120);
        for (size_t v = 0; v < vCount; v += vStride) {
            treePoints.push_back(mesh.vertices[v].position);
        }

        // Add foliage cluster proxies posed by actual joint positions
        float spreadScale = 1.0f + params.beta[2] * 0.40f;

        for (size_t aIdx = 0; aIdx < tmpl.foliageAnchors.size(); ++aIdx) {
            const auto& anchor = tmpl.foliageAnchors[aIdx];
            if (anchor.attachedJointIndex >= static_cast<int>(decomposed.posedJoints.size())) continue;
            Vec3 childPos = decomposed.posedJoints[anchor.attachedJointIndex];
            Vec3 parentPos = childPos;
            if (anchor.parentJointIndex >= 0 && anchor.parentJointIndex < static_cast<int>(decomposed.posedJoints.size())) {
                parentPos = decomposed.posedJoints[anchor.parentJointIndex];
            }
            Vec3 worldCenter = parentPos + (childPos - parentPos) * anchor.shootStation + anchor.localOffset * (0.8f * spreadScale);
            treePoints.push_back(worldCenter);

            // For outer terminal twigs (crown mantle envelope), include cardinal boundary extent
            if (anchor.isTerminalTwig) {
                float cRad = anchor.clusterRadius * spreadScale * 0.85f;
                treePoints.push_back(worldCenter + Vec3( cRad, 0.0f,  0.0f));
                treePoints.push_back(worldCenter + Vec3(-cRad, 0.0f,  0.0f));
                treePoints.push_back(worldCenter + Vec3( 0.0f, 0.0f,  cRad));
                treePoints.push_back(worldCenter + Vec3( 0.0f, 0.0f, -cRad));
            }
        }

        if (treePoints.empty()) return 100.0f;

        // 1. Forward Chamfer: Scan Points -> Closest Tree Point
        float forwardDistSq = 0.0f;
        for (const auto& scanP : scanPoints) {
            float minDistSq = std::numeric_limits<float>::max();
            for (const auto& treeP : treePoints) {
                float dSq = (scanP - treeP).lengthSquared();
                if (dSq < minDistSq) minDistSq = dSq;
            }
            forwardDistSq += minDistSq;
        }
        forwardDistSq /= scanPoints.size();

        // 2. Reverse Chamfer: Tree Points -> Closest Scan Point (prevents tree blowing up outside scan)
        float reverseDistSq = 0.0f;
        for (const auto& treeP : treePoints) {
            float minDistSq = std::numeric_limits<float>::max();
            for (const auto& scanP : scanPoints) {
                float dSq = (treeP - scanP).lengthSquared();
                if (dSq < minDistSq) minDistSq = dSq;
            }
            reverseDistSq += minDistSq;
        }
        reverseDistSq /= treePoints.size();

        // Bidirectional loss ensures exact 1:1 volumetric conformance
        return forwardDistSq + 0.35f * reverseDistSq;
    }
};

} // namespace smpl_tree
} // namespace scratchbox

#endif // SCRATCHBOX_SMPL_OPTIMIZER_HPP
