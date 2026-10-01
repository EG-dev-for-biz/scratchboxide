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

#include <vector>
#include <string>
#include <algorithm>

namespace scratchbox {
namespace lod {

using geometry::ScratchboxMesh;

struct LodLevel {
    uint32_t levelIndex{0};
    float triangleRatio{1.0f};  // 1.0 (LOD0), 0.5 (LOD1), 0.25 (LOD2), 0.125 (LOD3)
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
            lvl.mesh = halfedge::decimateMeshQEM(baseMesh, targetTriangles);
            lvl.mesh.name = baseMesh.name + "_LOD" + std::to_string(i);
        }

        pyramid.levels.push_back(std::move(lvl));
    }

    return pyramid;
}

} // namespace lod
} // namespace scratchbox

#endif // SCRATCHBOX_LOD_HPP
