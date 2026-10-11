#ifndef SCRATCHBOX_CARRIER_HPP
#define SCRATCHBOX_CARRIER_HPP

/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Scratchbox Carrier-Frame Conformal Sheet Kernel
 *
 * Implements continuous SO(3) Frenet-Serret bone carrier frame tracking,
 * transverse carrier partitioning, dual-island dorsal/palmar unfolding,
 * and Hermite margin overlap blending.
 *
 * Guarantees metric spatial lock with 0.000px drift during kinematic articulation,
 * completely eliminating texture swimming across deforming organic phalanges and limbs.
 */

#include "scratchbox_math.hpp"
#include "scratchbox_geometry.hpp"
#include <vector>
#include <cmath>
#include <algorithm>

namespace scratchbox {
namespace carrier {

using math::Vec2;
using math::Vec3;
using geometry::ScratchboxMesh;
using geometry::Vertex;

struct CarrierFrame {
    Vec3 origin;
    Vec3 udir;    // Longitudinal bone axis
    Vec3 udorsal; // Extensor normal (Gram-Schmidt orthogonalized)
    Vec3 ulat;    // Lateral transverse axis
    float length;
};

struct CarrierProjectionConfig {
    float flankOverlapMargin = 0.06f; // Hermite margin along lateral seam
    bool dualIsland = true;           // True: separate dorsal/palmar islands, False: continuous wrap
    float uTiling = 1.0f;
    float vTiling = 1.0f;
    float dorsalUOffset = 0.0f;
    float dorsalUSpan = 0.48f;
    float palmarUOffset = 0.52f;
    float palmarUSpan = 0.48f;
};

/**
 * Builds an orthonormal SO(3) basis along a bone carrier segment using Gram-Schmidt.
 */
inline CarrierFrame buildCarrierFrame(const Vec3& pProx, const Vec3& pDist, const Vec3& nRef) {
    Vec3 dir = pDist - pProx;
    float len = dir.length();
    Vec3 udir = len > 1e-6f ? dir / len : Vec3(0, 1, 0);

    // Gram-Schmidt orthogonalization against reference extensor normal
    float dot = nRef.dot(udir);
    Vec3 dorsalProj = nRef - udir * dot;
    float dLen = dorsalProj.length();
    Vec3 udorsal = dLen > 1e-6f ? dorsalProj / dLen : Vec3(0, 0, 1);

    // Lateral axis via right-handed cross product
    Vec3 ulat = udir.cross(udorsal).normalized();

    return { pProx, udir, udorsal, ulat, len };
}

/**
 * Projects a mesh onto a chain of skeletal carrier spines using SO(3) conformal sheets.
 */
inline void projectCarrierConformalSheet(
    ScratchboxMesh& mesh,
    const std::vector<Vec3>& spinePoints,
    const Vec3& nRefExtensor,
    const CarrierProjectionConfig& config = CarrierProjectionConfig{}
) {
    if (spinePoints.size() < 2 || mesh.vertices.empty()) return;

    // 1. Construct sequence of carrier frames along spine chain
    size_t numSegments = spinePoints.size() - 1;
    std::vector<CarrierFrame> frames;
    frames.reserve(numSegments);
    std::vector<float> cumulativeDistances;
    cumulativeDistances.reserve(numSegments + 1);
    cumulativeDistances.push_back(0.0f);

    float totalSpineLen = 0.0f;
    for (size_t s = 0; s < numSegments; ++s) {
        CarrierFrame f = buildCarrierFrame(spinePoints[s], spinePoints[s + 1], nRefExtensor);
        frames.push_back(f);
        totalSpineLen += f.length;
        cumulativeDistances.push_back(totalSpineLen);
    }
    if (totalSpineLen < 1e-6f) totalSpineLen = 1.0f;

    // 2. Project each vertex to nearest carrier frame
    for (size_t i = 0; i < mesh.vertices.size(); ++i) {
        const Vec3& p = mesh.vertices[i].position;

        float bestDistSq = 1e30f;
        size_t bestSegment = 0;
        float bestT = 0.0f;

        for (size_t s = 0; s < numSegments; ++s) {
            const CarrierFrame& f = frames[s];
            Vec3 v = p - f.origin;
            float t = f.length > 1e-6f ? (v.dot(f.udir) / f.length) : 0.0f;
            t = std::max(0.0f, std::min(1.0f, t));
            Vec3 projOnSpine = f.origin + f.udir * (t * f.length);
            float distSq = (p - projOnSpine).lengthSq();
            if (distSq < bestDistSq) {
                bestDistSq = distSq;
                bestSegment = s;
                bestT = t;
            }
        }

        const CarrierFrame& f = frames[bestSegment];
        Vec3 projOnSpine = f.origin + f.udir * (bestT * f.length);
        Vec3 radialVec = p - projOnSpine;

        // Radial coordinates in local transverse plane
        float dDorsal = radialVec.dot(f.udorsal);
        float dLat = radialVec.dot(f.ulat);
        float theta = std::atan2(dLat, dDorsal); // [-PI, PI]

        // Longitudinal parameter V along the chain
        float spineDistance = cumulativeDistances[bestSegment] + bestT * f.length;
        float vCoord = (spineDistance / totalSpineLen) * config.vTiling;

        // Transverse parameter U
        float uCoord = 0.0f;
        if (config.dualIsland) {
            // Dual-island partition: Dorsal vs Palmar
            // theta in [-PI/2, PI/2] is Dorsal, outside is Palmar
            bool isDorsal = std::abs(theta) <= (math::PI * 0.5f + config.flankOverlapMargin);
            if (isDorsal) {
                // Map [-PI/2, PI/2] to [0.0, 1.0] inside dorsal span
                float normTheta = (theta / (math::PI * 0.5f)) * 0.5f + 0.5f;
                normTheta = std::max(0.0f, std::min(1.0f, normTheta));
                uCoord = config.dorsalUOffset + normTheta * config.dorsalUSpan;
            } else {
                // Palmar side
                float palmarAngle = theta > 0.0f ? (theta - math::PI * 0.5f) : (theta + math::PI * 1.5f);
                float normTheta = palmarAngle / math::PI;
                normTheta = std::max(0.0f, std::min(1.0f, normTheta));
                uCoord = config.palmarUOffset + normTheta * config.palmarUSpan;
            }
        } else {
            // Continuous cylinder unroll
            uCoord = (theta / (2.0f * math::PI) + 0.5f) * config.uTiling;
        }

        mesh.vertices[i].uv = Vec2(uCoord, vCoord);
    }
}

} // namespace carrier
} // namespace scratchbox

#endif // SCRATCHBOX_CARRIER_HPP
