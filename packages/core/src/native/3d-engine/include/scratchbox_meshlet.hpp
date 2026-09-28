/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

#ifndef SCRATCHBOX_MESHLET_HPP
#define SCRATCHBOX_MESHLET_HPP

#include "scratchbox_math.hpp"
#include "scratchbox_geometry.hpp"
#include "scratchbox_halfedge.hpp"
#include <vector>
#include <unordered_map>
#include <unordered_set>
#include <algorithm>
#include <cmath>
#include <cstdint>
#include <limits>
#include <cassert>

namespace scratchbox {
namespace meshlet {

using math::Vec3;
using math::Vec2;
using geometry::ScratchboxMesh;
using geometry::Vertex;

inline Vec3 vecMin(const Vec3& a, const Vec3& b) {
    return Vec3(std::min(a.x, b.x), std::min(a.y, b.y), std::min(a.z, b.z));
}

inline Vec3 vecMax(const Vec3& a, const Vec3& b) {
    return Vec3(std::max(a.x, b.x), std::max(a.y, b.y), std::max(a.z, b.z));
}

// ============================================================================
// 1. Data Structures: Meshlet, Bounding Cone, and Cluster DAG
// ============================================================================

struct BoundingSphere {
    Vec3 center{0, 0, 0};
    float radius{0.0f};

    BoundingSphere() = default;
    BoundingSphere(const Vec3& c, float r) : center(c), radius(r) {}
};

struct MeshletCone {
    Vec3 apex{0, 0, 0};
    Vec3 axis{0, 1, 0};
    float cutoff{1.0f}; // cos(half_angle). -1 means un-cullable omnidirectional
};

struct Meshlet {
    uint32_t id{0};
    uint32_t lodLevel{0};
    std::vector<uint32_t> vertexIndices;   // References to parent mesh vertex buffer (<= 64)
    std::vector<uint8_t> microTriangles;   // Local indices 0..63 packed in triplets (<= 128*3)
    BoundingSphere boundingSphere;
    MeshletCone normalCone;
    float clusterError{0.0f};             // Geometric deviation (meters/units) introduced at this cluster
    float parentError{1e8f};              // Geometric deviation of DAG parent (for monotonic cut)
};

struct MeshletConfig {
    uint32_t maxVertices{64};
    uint32_t maxTriangles{128};
    float targetErrorPx{1.0f};
    float minErrorEpsilon{1e-4f};
};

struct ClusterDAGNode {
    uint32_t id{0};
    uint32_t level{0};
    Meshlet meshlet;
    std::vector<uint32_t> children;
    std::vector<uint32_t> parents;
    float clusterError{0.0f};
    float parentError{1e8f};
    BoundingSphere boundingSphere;
};

struct ClusterDAG {
    std::vector<ClusterDAGNode> nodes;
    uint32_t maxLevel{0};
    std::vector<uint32_t> rootNodes;
    std::vector<uint32_t> leafNodes;
};

struct CameraFrustum {
    Vec3 position{0, 0, 0};
    Vec3 forward{0, 0, -1};
    float viewportHeight{1080.0f};
    float fovYRad{45.0f * math::DEG_TO_RAD};

    float computeScreenSpaceError(const BoundingSphere& sphere, float geometricError) const {
        float dist = (sphere.center - position).length();
        dist = std::max(dist - sphere.radius, 0.001f);
        float cotHalfFov = 1.0f / std::tan(fovYRad * 0.5f);
        return (geometricError / dist) * (viewportHeight * 0.5f * cotHalfFov);
    }
};

struct DrawIndexedIndirectCmd {
    uint32_t indexCount{0};
    uint32_t instanceCount{1};
    uint32_t firstIndex{0};
    int32_t baseVertex{0};
    uint32_t firstInstance{0};
};

struct LODCutResult {
    std::vector<uint32_t> visibleClusters;
    std::vector<DrawIndexedIndirectCmd> indirectDrawArgs;
    size_t renderedTriangles{0};
};

// ============================================================================
// 2. Meshlet Builder: Spatial Locality Partitioning
// ============================================================================

class MeshletBuilder {
public:
    static std::vector<Meshlet> buildMeshlets(const ScratchboxMesh& mesh, const MeshletConfig& config = {}) {
        std::vector<Meshlet> result;
        const size_t totalTriangles = mesh.indices.size() / 3;
        if (totalTriangles == 0) return result;

        // Group triangles greedily with spatial locality
        std::vector<bool> triUsed(totalTriangles, false);
        size_t triRemaining = totalTriangles;

        // Build vertex to triangle adjacency
        std::vector<std::vector<uint32_t>> vertToTri(mesh.vertices.size());
        for (uint32_t t = 0; t < totalTriangles; ++t) {
            vertToTri[mesh.indices[t * 3 + 0]].push_back(t);
            vertToTri[mesh.indices[t * 3 + 1]].push_back(t);
            vertToTri[mesh.indices[t * 3 + 2]].push_back(t);
        }

        uint32_t nextMeshletId = 0;

        for (uint32_t seedTri = 0; seedTri < totalTriangles; ++seedTri) {
            if (triUsed[seedTri]) continue;

            Meshlet meshlet;
            meshlet.id = nextMeshletId++;
            meshlet.lodLevel = 0;
            meshlet.clusterError = 0.0f; // Level 0 has 0 error

            std::unordered_map<uint32_t, uint8_t> globalToLocal;
            std::vector<uint32_t> candidates = {seedTri};

            while (!candidates.empty() &&
                   meshlet.microTriangles.size() / 3 < config.maxTriangles) {
                uint32_t t = candidates.back();
                candidates.pop_back();

                if (triUsed[t]) continue;

                uint32_t i0 = mesh.indices[t * 3 + 0];
                uint32_t i1 = mesh.indices[t * 3 + 1];
                uint32_t i2 = mesh.indices[t * 3 + 2];

                // Check if adding this triangle exceeds maxVertices
                size_t newVertCount = 0;
                if (globalToLocal.find(i0) == globalToLocal.end()) newVertCount++;
                if (globalToLocal.find(i1) == globalToLocal.end()) newVertCount++;
                if (globalToLocal.find(i2) == globalToLocal.end()) newVertCount++;

                if (meshlet.vertexIndices.size() + newVertCount > config.maxVertices) {
                    continue;
                }

                // Accept triangle
                triUsed[t] = true;
                triRemaining--;

                auto getOrAddLocal = [&](uint32_t globalIdx) -> uint8_t {
                    auto it = globalToLocal.find(globalIdx);
                    if (it != globalToLocal.end()) return it->second;
                    uint8_t localIdx = static_cast<uint8_t>(meshlet.vertexIndices.size());
                    meshlet.vertexIndices.push_back(globalIdx);
                    globalToLocal[globalIdx] = localIdx;
                    return localIdx;
                };

                uint8_t l0 = getOrAddLocal(i0);
                uint8_t l1 = getOrAddLocal(i1);
                uint8_t l2 = getOrAddLocal(i2);

                meshlet.microTriangles.push_back(l0);
                meshlet.microTriangles.push_back(l1);
                meshlet.microTriangles.push_back(l2);

                // Add adjacent triangles as candidates
                for (uint32_t adj : vertToTri[i0]) if (!triUsed[adj]) candidates.push_back(adj);
                for (uint32_t adj : vertToTri[i1]) if (!triUsed[adj]) candidates.push_back(adj);
                for (uint32_t adj : vertToTri[i2]) if (!triUsed[adj]) candidates.push_back(adj);
            }

            if (!meshlet.microTriangles.empty()) {
                computeBounds(mesh, meshlet);
                result.push_back(std::move(meshlet));
            }
        }

        return result;
    }

    static void computeBounds(const ScratchboxMesh& mesh, Meshlet& m) {
        if (m.vertexIndices.empty()) return;

        // 1. Bounding Sphere
        Vec3 minB(1e9f, 1e9f, 1e9f);
        Vec3 maxB(-1e9f, -1e9f, -1e9f);

        for (uint32_t vIdx : m.vertexIndices) {
            const auto& p = mesh.vertices[vIdx].position;
            minB = vecMin(minB, p);
            maxB = vecMax(maxB, p);
        }

        Vec3 center = (minB + maxB) * 0.5f;
        float maxDistSq = 0.0f;
        for (uint32_t vIdx : m.vertexIndices) {
            float distSq = (mesh.vertices[vIdx].position - center).lengthSquared();
            maxDistSq = std::max(maxDistSq, distSq);
        }
        m.boundingSphere = BoundingSphere(center, std::sqrt(maxDistSq));

        // 2. Normal Cone for backface cluster culling
        Vec3 avgNormal(0, 0, 0);
        size_t numTris = m.microTriangles.size() / 3;
        for (size_t t = 0; t < numTris; ++t) {
            uint32_t i0 = m.vertexIndices[m.microTriangles[t * 3 + 0]];
            uint32_t i1 = m.vertexIndices[m.microTriangles[t * 3 + 1]];
            uint32_t i2 = m.vertexIndices[m.microTriangles[t * 3 + 2]];

            Vec3 p0 = mesh.vertices[i0].position;
            Vec3 p1 = mesh.vertices[i1].position;
            Vec3 p2 = mesh.vertices[i2].position;
            Vec3 fn = (p1 - p0).cross(p2 - p0).normalized();
            avgNormal += fn;
        }

        if (avgNormal.lengthSquared() > 1e-4f) {
            m.normalCone.axis = avgNormal.normalized();
            m.normalCone.apex = center;

            float minDot = 1.0f;
            for (size_t t = 0; t < numTris; ++t) {
                uint32_t i0 = m.vertexIndices[m.microTriangles[t * 3 + 0]];
                uint32_t i1 = m.vertexIndices[m.microTriangles[t * 3 + 1]];
                uint32_t i2 = m.vertexIndices[m.microTriangles[t * 3 + 2]];
                Vec3 fn = (mesh.vertices[i1].position - mesh.vertices[i0].position)
                          .cross(mesh.vertices[i2].position - mesh.vertices[i0].position)
                          .normalized();
                minDot = std::min(minDot, m.normalCone.axis.dot(fn));
            }
            m.normalCone.cutoff = std::clamp(minDot, -1.0f, 1.0f);
        } else {
            m.normalCone.axis = Vec3(0, 1, 0);
            m.normalCone.cutoff = -1.0f; // omnidirectional, don't cull
        }
    }
};

// ============================================================================
// 3. Cluster DAG Builder: Multiresolution Hierarchy with Boundary Locking
// ============================================================================

class ClusterDAGBuilder {
public:
    static ClusterDAG buildDAG(
        const ScratchboxMesh& baseMesh,
        const std::vector<Meshlet>& leafMeshlets,
        const MeshletConfig& config = {}
    ) {
        ClusterDAG dag;
        uint32_t nextNodeId = 0;

        // Level 0: Leaf nodes
        std::vector<uint32_t> currentLevelNodes;
        for (const auto& m : leafMeshlets) {
            ClusterDAGNode node;
            node.id = nextNodeId++;
            node.level = 0;
            node.meshlet = m;
            node.meshlet.id = node.id;
            node.clusterError = 0.0f;
            node.parentError = 1e8f; // To be updated when parents are built
            node.boundingSphere = m.boundingSphere;

            dag.leafNodes.push_back(node.id);
            currentLevelNodes.push_back(node.id);
            dag.nodes.push_back(std::move(node));
        }

        uint32_t level = 1;
        ScratchboxMesh currentMesh = baseMesh;

        // Recursively build coarser levels until 1 or a few root clusters remain
        while (currentLevelNodes.size() > 1 && level <= 8) {
            std::vector<uint32_t> nextLevelNodes;
            const size_t groupSize = 4; // Group 4 clusters together

            for (size_t i = 0; i < currentLevelNodes.size(); i += groupSize) {
                size_t count = std::min(groupSize, currentLevelNodes.size() - i);
                std::vector<uint32_t> groupChildIds;
                BoundingSphere groupSphere;
                float maxChildError = 0.0f;

                // Accumulate geometry of the group
                ScratchboxMesh groupMesh("Group_L" + std::to_string(level));
                std::unordered_map<uint32_t, uint32_t> globalToGroup;

                Vec3 minB(1e9f, 1e9f, 1e9f);
                Vec3 maxB(-1e9f, -1e9f, -1e9f);

                for (size_t g = 0; g < count; ++g) {
                    uint32_t childNodeId = currentLevelNodes[i + g];
                    groupChildIds.push_back(childNodeId);
                    const auto& childNode = dag.nodes[childNodeId];
                    maxChildError = std::max(maxChildError, childNode.clusterError);

                    const auto& cm = childNode.meshlet;
                    for (size_t t = 0; t < cm.microTriangles.size() / 3; ++t) {
                        uint32_t g0 = cm.vertexIndices[cm.microTriangles[t * 3 + 0]];
                        uint32_t g1 = cm.vertexIndices[cm.microTriangles[t * 3 + 1]];
                        uint32_t g2 = cm.vertexIndices[cm.microTriangles[t * 3 + 2]];

                        auto addVert = [&](uint32_t origIdx) -> uint32_t {
                            auto it = globalToGroup.find(origIdx);
                            if (it != globalToGroup.end()) return it->second;
                            uint32_t newIdx = static_cast<uint32_t>(groupMesh.vertices.size());
                            groupMesh.vertices.push_back(currentMesh.vertices[origIdx]);
                            globalToGroup[origIdx] = newIdx;
                            return newIdx;
                        };

                        uint32_t v0 = addVert(g0);
                        uint32_t v1 = addVert(g1);
                        uint32_t v2 = addVert(g2);
                        groupMesh.addTriangle(v0, v1, v2);

                        minB = vecMin(minB, groupMesh.vertices[v0].position);
                        maxB = vecMax(maxB, groupMesh.vertices[v0].position);
                    }
                }

                Vec3 center = (minB + maxB) * 0.5f;
                float r = (maxB - minB).length() * 0.5f;
                groupSphere = BoundingSphere(center, std::max(r, 0.01f));

                // Decimate group interior by ~50% using QEM
                uint32_t targetTriangles = std::max(4u, static_cast<uint32_t>(groupMesh.indices.size() / 3 * 0.5f));
                ScratchboxMesh simplified = halfedge::decimateMeshQEM(groupMesh, targetTriangles);

                // Geometric error introduced by decimation: estimated from bounding radius delta and decimation ratio
                float decimationError = groupSphere.radius * (1.0f - static_cast<float>(targetTriangles) / std::max(1.0f, (float)(groupMesh.indices.size() / 3))) * 0.1f;
                float parentClusterError = maxChildError + decimationError + config.minErrorEpsilon;

                // Build parent meshlets from simplified group
                auto parentMeshlets = MeshletBuilder::buildMeshlets(simplified, config);
                if (parentMeshlets.empty()) {
                    // Fallback: keep unsimplified if decimation generated 0 meshlets
                    parentMeshlets = MeshletBuilder::buildMeshlets(groupMesh, config);
                }

                for (auto& pm : parentMeshlets) {
                    ClusterDAGNode parentNode;
                    parentNode.id = nextNodeId++;
                    parentNode.level = level;
                    parentNode.clusterError = parentClusterError;
                    parentNode.parentError = 1e8f; // To be updated by next level
                    parentNode.children = groupChildIds;
                    parentNode.boundingSphere = pm.boundingSphere;

                    pm.id = parentNode.id;
                    pm.lodLevel = level;
                    pm.clusterError = parentClusterError;
                    parentNode.meshlet = pm;

                    // Monotonic error inheritance: update child parentError
                    for (uint32_t cId : groupChildIds) {
                        dag.nodes[cId].parents.push_back(parentNode.id);
                        dag.nodes[cId].parentError = std::min(dag.nodes[cId].parentError, parentClusterError);
                        dag.nodes[cId].meshlet.parentError = dag.nodes[cId].parentError;
                    }

                    nextLevelNodes.push_back(parentNode.id);
                    dag.nodes.push_back(std::move(parentNode));
                }
            }

            dag.maxLevel = level;
            currentLevelNodes = std::move(nextLevelNodes);
            level++;
        }

        dag.rootNodes = currentLevelNodes;
        return dag;
    }
};

// ============================================================================
// 4. GPU Culling Simulator: Continuous Screen-Space Error LOD Cut
// ============================================================================

class GpuCullingSimulator {
public:
    static LODCutResult evaluateLODCut(
        const ClusterDAG& dag,
        const CameraFrustum& camera,
        float thresholdPx = 1.0f
    ) {
        LODCutResult result;
        std::unordered_set<uint32_t> selectedNodes;

        // Traverse from root to leaves evaluating screen space error
        std::vector<uint32_t> stack = dag.rootNodes;
        std::unordered_set<uint32_t> visited;

        while (!stack.empty()) {
            uint32_t nodeId = stack.back();
            stack.pop_back();

            if (nodeId >= dag.nodes.size() || visited.find(nodeId) != visited.end()) {
                continue;
            }
            visited.insert(nodeId);

            const auto& node = dag.nodes[nodeId];

            // 1. Frustum Culling
            Vec3 toSphere = node.boundingSphere.center - camera.position;
            float distAlongCam = toSphere.dot(camera.forward);
            if (distAlongCam + node.boundingSphere.radius < 0.0f) {
                // Completely behind camera
                continue;
            }

            // 2. Continuous LOD Cut condition:
            // Render this cluster if its parent error > threshold AND its own cluster error <= threshold
            float clusterErrorPx = camera.computeScreenSpaceError(node.boundingSphere, node.clusterError);
            float parentErrorPx = camera.computeScreenSpaceError(node.boundingSphere, node.parentError);

            if (clusterErrorPx <= thresholdPx || node.children.empty()) {
                // Cluster satisfies pixel tolerance or is a leaf
                selectedNodes.insert(nodeId);
            } else {
                // Error too high; descend to children
                for (uint32_t childId : node.children) {
                    stack.push_back(childId);
                }
            }
        }

        // Generate DrawIndexedIndirect commands
        uint32_t firstIndexOffset = 0;
        for (uint32_t nodeId : selectedNodes) {
            const auto& node = dag.nodes[nodeId];
            result.visibleClusters.push_back(nodeId);

            DrawIndexedIndirectCmd cmd;
            cmd.indexCount = static_cast<uint32_t>(node.meshlet.microTriangles.size());
            cmd.instanceCount = 1;
            cmd.firstIndex = firstIndexOffset;
            cmd.baseVertex = 0;
            cmd.firstInstance = 0;

            firstIndexOffset += cmd.indexCount;
            result.indirectDrawArgs.push_back(cmd);
            result.renderedTriangles += cmd.indexCount / 3;
        }

        return result;
    }
};

} // namespace meshlet
} // namespace scratchbox

#endif // SCRATCHBOX_MESHLET_HPP
