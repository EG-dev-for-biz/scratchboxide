/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

#ifndef SCRATCHBOX_LOD_HPP
#define SCRATCHBOX_LOD_HPP

#include "scratchbox_math.hpp"
#include "scratchbox_geometry.hpp"
#include "scratchbox_halfedge.hpp"
#include "scratchbox_processing.hpp"

#include <vector>
#include <string>
#include <algorithm>

namespace scratchbox {
namespace lod {

using geometry::ScratchboxMesh;

/**
 * One LOD step: QEM edge collapse on the welded surface (processing::QuadricDecimator) with its outline pinned, UV
 * seams crossed at the cost of the texture they drag (crossSeams), and the result ordered for the vertex cache.
 * Replaces halfedge::decimateMeshQEM here, which cracked seams open and lost the surface on scan meshes.
 */
inline ScratchboxMesh simplifyForLod(const ScratchboxMesh& mesh, size_t targetTriangles) {
    processing::DecimateOptions opt;
    opt.targetTriangles = std::max<size_t>(4, targetTriangles);
    opt.crossSeams = true;
    return processing::QuadricDecimator::decimate(mesh, opt);
}

struct LodLevel {
    uint32_t levelIndex{0};
    float triangleRatio{1.0f};  // the share of LOD0's triangles this level holds (asked: 1.0, 0.5, 0.25, 0.125)
    float switchDistance{0.0f}; // Camera distance in meters/units to trigger switch
    ScratchboxMesh mesh;
};

struct LodPyramid {
    std::string name;
    std::vector<LodLevel> levels;

    const LodLevel& getLOD(uint32_t level) const {
        if (level >= levels.size()) return levels.back();
        return levels[level];
    }

    size_t size() const { return levels.size(); }
};

inline LodPyramid buildLodPyramid(
    const ScratchboxMesh& baseMesh,
    const std::vector<float>& ratios = {1.0f, 0.5f, 0.25f, 0.125f},
    const std::vector<float>& distances = {0.0f, 15.0f, 35.0f, 75.0f}
) {
    LodPyramid pyramid;
    pyramid.name = baseMesh.name;

    size_t origTriangles = baseMesh.indices.size() / 3;
    size_t count = std::min(ratios.size(), distances.size());

    for (size_t i = 0; i < count; ++i) {
        float ratio = std::clamp(ratios[i], 0.05f, 1.0f);
        float dist = distances[i];

        LodLevel lvl;
        lvl.levelIndex = static_cast<uint32_t>(i);
        lvl.triangleRatio = ratio;
        lvl.switchDistance = dist;

        if (i == 0 || ratio >= 0.99f) {
            lvl.mesh = baseMesh;
            lvl.mesh.name = baseMesh.name + "_LOD0";
        } else {
            uint32_t targetTriangles = static_cast<uint32_t>(origTriangles * ratio);
            targetTriangles = std::max(4u, targetTriangles);
            lvl.mesh = simplifyForLod(baseMesh, targetTriangles);
            lvl.mesh.name = baseMesh.name + "_LOD" + std::to_string(i);
            // a scan the collapse cannot take that far (topology locks it) keeps the share it reached, said here
            lvl.triangleRatio = static_cast<float>(lvl.mesh.indices.size() / 3) / static_cast<float>(std::max<size_t>(1, origTriangles));
        }

        pyramid.levels.push_back(std::move(lvl));
    }

    return pyramid;
}

} // namespace lod
} // namespace scratchbox

#endif // SCRATCHBOX_LOD_HPP
