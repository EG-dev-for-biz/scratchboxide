/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

#ifndef SCRATCHBOX_NANITE_HPP
#define SCRATCHBOX_NANITE_HPP

#include "scratchbox_math.hpp"
#include "scratchbox_geometry.hpp"
#include "scratchbox_halfedge.hpp"
#include "scratchbox_lod.hpp"

#include <vector>
#include <string>
#include <cmath>
#include <algorithm>
#include <functional>
#include <unordered_map>
#include <unordered_set>

namespace scratchbox {
namespace nanite {

using math::Vec2;
using math::Vec3;
using math::Vec4;
using geometry::Vertex;
using geometry::ScratchboxMesh;

/**
 * NaniteCluster represents a discrete atomic partition of a mesh,
 * typically containing 64 to 128 triangles.
 */
struct NaniteCluster {
    uint32_t clusterId{0};
    uint32_t lodLevel{0};
    
    // Spatial Bounds & Normal Culling Cone
    Vec3 boundingSphereCenter{0.0f, 0.0f, 0.0f};
    float boundingSphereRadius{1.0f};
    Vec3 coneNormal{0.0f, 1.0f, 0.0f};
    float coneAngleCos{-1.0f}; // -1.0 means no backface cone culling
    
    // Simplification Error Metric (Metric World Space)
    float maxLODError{0.0f};      // Maximum surface deviation error from base geometry
    float parentLODError{1e9f};   // Error of parent cluster in the hierarchical DAG
    
    // Cluster Geometry
    std::vector<Vertex> vertices;
    std::vector<uint32_t> indices; // Local triangle index list
    
    // Hierarchical DAG Connectivity
    std::vector<uint32_t> parentClusterIds;
    std::vector<uint32_t> childClusterIds;
    
    size_t triangleCount() const { return indices.size() / 3; }
};

/**
 * CameraView encapsulates the viewpoint parameters needed for
 * screen-space projected error evaluation.
 */
struct CameraView {
    Vec3 position{0.0f, 0.0f, 10.0f};
    Vec3 forward{0.0f, 0.0f, -1.0f};
    float fovRad{60.0f * (3.1415926535f / 180.0f)};
    float viewportHeight{1080.0f};
    float nearPlane{0.1f};
    float farPlane{2000.0f};
    
    // Computes projected error in screen pixels for a world-space error at distance d
    float projectErrorToPixels(float worldError, float distance) const {
        if (distance <= nearPlane) return 1e6f;
        float halfFovTan = std::tan(fovRad * 0.5f);
        return (worldError * viewportHeight) / (2.0f * distance * halfFovTan);
    }
};

/**
 * NaniteClusterDAG maintains the multi-resolution hierarchical cluster tree.
 * Allows continuous sub-pixel level-of-detail selection without popping.
 */
class NaniteClusterDAG {
public:
    std::string name;
    std::vector<NaniteCluster> clusters;
    std::vector<uint32_t> rootClusterIds; // Topmost (coarsest) clusters
    std::vector<uint32_t> leafClusterIds; // Bottom-most (finest, LOD0) clusters
    uint32_t maxLodLevel{0};
    float totalMeshSurfaceArea{0.0f};

    /**
     * Builds a Nanite cluster hierarchy from an input mesh.
     * Partitions the base mesh into clusters of ~128 triangles,
     * then hierarchically simplifies pairs into parents.
     */
    void buildFromMesh(const ScratchboxMesh& baseMesh, uint32_t targetClusterTriangles = 128) {
        name = baseMesh.name;
        clusters.clear();
        rootClusterIds.clear();
        leafClusterIds.clear();
        maxLodLevel = 0;
        
        if (baseMesh.indices.empty() || baseMesh.vertices.empty()) return;
        
        size_t totalTris = baseMesh.indices.size() / 3;
        
        // 1. Partition LOD0 into clusters of targetClusterTriangles
        std::vector<NaniteCluster> currentLevelClusters;
        size_t currentClusterTris = targetClusterTriangles;
        
        // Spatial sorting along principal bounding box axis to keep cluster triangles localized
        Vec3 bMin = baseMesh.vertices[0].position;
        Vec3 bMax = baseMesh.vertices[0].position;
        for (const auto& v : baseMesh.vertices) {
            bMin.x = std::min(bMin.x, v.position.x);
            bMin.y = std::min(bMin.y, v.position.y);
            bMin.z = std::min(bMin.z, v.position.z);
            bMax.x = std::max(bMax.x, v.position.x);
            bMax.y = std::max(bMax.y, v.position.y);
            bMax.z = std::max(bMax.z, v.position.z);
        }
        
        Vec3 bSize = bMax - bMin;
        int sortAxis = 0;
        if (bSize.y > bSize.x && bSize.y > bSize.z) sortAxis = 1;
        else if (bSize.z > bSize.x && bSize.z > bSize.y) sortAxis = 2;
        
        struct TriCentroid {
            uint32_t triIndex;
            float axisCoord;
        };
        std::vector<TriCentroid> triCentroids(totalTris);
        for (size_t t = 0; t < totalTris; ++t) {
            uint32_t i0 = baseMesh.indices[t * 3 + 0];
            uint32_t i1 = baseMesh.indices[t * 3 + 1];
            uint32_t i2 = baseMesh.indices[t * 3 + 2];
            Vec3 c = (baseMesh.vertices[i0].position + baseMesh.vertices[i1].position + baseMesh.vertices[i2].position) / 3.0f;
            triCentroids[t].triIndex = static_cast<uint32_t>(t);
            triCentroids[t].axisCoord = (sortAxis == 0) ? c.x : ((sortAxis == 1) ? c.y : c.z);
        }
        std::sort(triCentroids.begin(), triCentroids.end(), [](const TriCentroid& a, const TriCentroid& b) {
            return a.axisCoord < b.axisCoord;
        });
        
        // Build base LOD0 clusters
        size_t triCursor = 0;
        while (triCursor < totalTris) {
            size_t batchSize = std::min(currentClusterTris, totalTris - triCursor);
            NaniteCluster cluster;
            cluster.clusterId = static_cast<uint32_t>(clusters.size());
            cluster.lodLevel = 0;
            cluster.maxLODError = 0.0f; // LOD0 has 0 simplification error
            
            std::unordered_map<uint32_t, uint32_t> vertexRemap;
            Vec3 centroidSum{0.0f, 0.0f, 0.0f};
            Vec3 normalSum{0.0f, 0.0f, 0.0f};
            
            for (size_t b = 0; b < batchSize; ++b) {
                uint32_t origTri = triCentroids[triCursor + b].triIndex;
                for (int vi = 0; vi < 3; ++vi) {
                    uint32_t origVIdx = baseMesh.indices[origTri * 3 + vi];
                    auto it = vertexRemap.find(origVIdx);
                    if (it == vertexRemap.end()) {
                        uint32_t localVIdx = static_cast<uint32_t>(cluster.vertices.size());
                        vertexRemap[origVIdx] = localVIdx;
                        cluster.vertices.push_back(baseMesh.vertices[origVIdx]);
                        cluster.indices.push_back(localVIdx);
                        centroidSum += baseMesh.vertices[origVIdx].position;
                        normalSum += baseMesh.vertices[origVIdx].normal;
                    } else {
                        cluster.indices.push_back(it->second);
                    }
                }
            }
            
            // Calculate Bounding Sphere
            if (!cluster.vertices.empty()) {
                Vec3 center = centroidSum / static_cast<float>(cluster.vertices.size());
                float maxDistSq = 0.0f;
                for (const auto& v : cluster.vertices) {
                    float dSq = (v.position - center).lengthSquared();
                    if (dSq > maxDistSq) maxDistSq = dSq;
                }
                cluster.boundingSphereCenter = center;
                cluster.boundingSphereRadius = std::sqrt(maxDistSq);
                cluster.coneNormal = normalSum.normalized();
            }
            
            leafClusterIds.push_back(cluster.clusterId);
            clusters.push_back(cluster);
            currentLevelClusters.push_back(cluster);
            triCursor += batchSize;
        }
        
        // 2. Bottom-up simplification to construct Parent Clusters in the DAG
        uint32_t curLod = 0;
        float baseError = 0.01f; // 1 cm baseline error per reduction
        
        while (currentLevelClusters.size() > 1) {
            curLod++;
            std::vector<NaniteCluster> nextLevelClusters;
            float curLodError = baseError * std::pow(2.0f, static_cast<float>(curLod));
            
            for (size_t i = 0; i < currentLevelClusters.size(); i += 2) {
                if (i + 1 < currentLevelClusters.size()) {
                    // Merge cluster i and cluster i+1
                    const auto& cA = currentLevelClusters[i];
                    const auto& cB = currentLevelClusters[i + 1];
                    
                    NaniteCluster parent;
                    parent.clusterId = static_cast<uint32_t>(clusters.size());
                    parent.lodLevel = curLod;
                    parent.maxLODError = curLodError;
                    parent.childClusterIds = { cA.clusterId, cB.clusterId };
                    
                    // Combine geometry
                    std::vector<Vertex> mergedVerts = cA.vertices;
                    std::vector<uint32_t> mergedIndices = cA.indices;
                    uint32_t offset = static_cast<uint32_t>(mergedVerts.size());
                    for (const auto& v : cB.vertices) mergedVerts.push_back(v);
                    for (uint32_t idx : cB.indices) mergedIndices.push_back(idx + offset);
                    
                    // Decimate combined mesh by 50% using QEM
                    ScratchboxMesh tempMerged;
                    tempMerged.vertices = mergedVerts;
                    tempMerged.indices = mergedIndices;
                    
                    uint32_t targetTris = std::max(16u, static_cast<uint32_t>(mergedIndices.size() / 6));
                    ScratchboxMesh decimated = halfedge::decimateMeshQEM(tempMerged, targetTris);
                    
                    parent.vertices = decimated.vertices;
                    parent.indices = decimated.indices;
                    
                    // Bounds
                    Vec3 center = (cA.boundingSphereCenter + cB.boundingSphereCenter) * 0.5f;
                    float radius = std::max(
                        (cA.boundingSphereCenter - center).length() + cA.boundingSphereRadius,
                        (cB.boundingSphereCenter - center).length() + cB.boundingSphereRadius
                    );
                    parent.boundingSphereCenter = center;
                    parent.boundingSphereRadius = radius;
                    parent.coneNormal = ((cA.coneNormal + cB.coneNormal) * 0.5f).normalized();
                    
                    // Assign parent error to children
                    clusters[cA.clusterId].parentLODError = curLodError;
                    clusters[cB.clusterId].parentLODError = curLodError;
                    clusters[cA.clusterId].parentClusterIds.push_back(parent.clusterId);
                    clusters[cB.clusterId].parentClusterIds.push_back(parent.clusterId);
                    
                    clusters.push_back(parent);
                    nextLevelClusters.push_back(parent);
                } else {
                    // Odd cluster carried forward
                    nextLevelClusters.push_back(currentLevelClusters[i]);
                }
            }
            currentLevelClusters = nextLevelClusters;
        }
        
        maxLodLevel = curLod;
        for (const auto& c : currentLevelClusters) {
            rootClusterIds.push_back(c.clusterId);
        }
    }

    /**
     * Screen-Space Projected Error LOD Traversal
     * Selects clusters where error <= targetPixelSize (e.g. 1.0 px = 1 triangle per pixel).
     */
    void cullAndSelectLOD(
        const CameraView& camera,
        float targetPixelSize,
        std::vector<uint32_t>& outVisibleClusterIds
    ) const {
        outVisibleClusterIds.clear();
        std::unordered_set<uint32_t> selectedSet;
        
        // Depth-first traversal from root clusters
        std::function<void(uint32_t)> evaluateCluster = [&](uint32_t cId) {
            if (cId >= clusters.size()) return;
            const auto& cluster = clusters[cId];
            
            // 1. Frustum & distance test
            Vec3 toCluster = cluster.boundingSphereCenter - camera.position;
            float dist = toCluster.length();
            
            // Backface cone culling
            if (cluster.coneAngleCos > -0.99f) {
                float viewDotCone = toCluster.normalized().dot(cluster.coneNormal);
                if (viewDotCone > cluster.coneAngleCos) {
                    // Fully back-facing cluster
                    return;
                }
            }
            
            // 2. Projected Screen Error
            float currentErrorPx = camera.projectErrorToPixels(cluster.maxLODError, dist);
            float parentErrorPx = camera.projectErrorToPixels(cluster.parentLODError, dist);
            
            // If this cluster's error is within target pixel threshold (1 pixel),
            // OR if it is a leaf cluster (no children), select it!
            if (cluster.childClusterIds.empty() || currentErrorPx <= targetPixelSize) {
                if (selectedSet.find(cId) == selectedSet.end()) {
                    selectedSet.insert(cId);
                    outVisibleClusterIds.push_back(cId);
                }
            } else {
                // Otherwise recurse into child clusters
                for (uint32_t childId : cluster.childClusterIds) {
                    evaluateCluster(childId);
                }
            }
        };
        
        for (uint32_t rootId : rootClusterIds) {
            evaluateCluster(rootId);
        }
    }

    /**
     * Assembles the currently selected LOD clusters into a single renderable ScratchboxMesh.
     */
    ScratchboxMesh assembleLODMesh(const std::vector<uint32_t>& clusterIds) const {
        ScratchboxMesh outMesh;
        outMesh.name = name + "_nanite_lod";
        
        for (uint32_t cId : clusterIds) {
            if (cId >= clusters.size()) continue;
            const auto& cluster = clusters[cId];
            uint32_t vOffset = static_cast<uint32_t>(outMesh.vertices.size());
            
            for (const auto& v : cluster.vertices) {
                outMesh.vertices.push_back(v);
            }
            for (uint32_t idx : cluster.indices) {
                outMesh.indices.push_back(idx + vOffset);
            }
        }
        return outMesh;
    }
};

/**
 * MicroPolyDisplacer evaluates continuous displacement maps or procedural heightfields
 * dynamically on clusters to generate micro-polygons approaching 1 triangle per pixel.
 */
class MicroPolyDisplacer {
public:
    /**
     * Tessellates each triangle of a cluster into micro-quads/triangles displaced along the normal.
     */
    static NaniteCluster displaceCluster(
        const NaniteCluster& inCluster,
        const std::function<float(const Vec2& uv)>& heightmap,
        float displacementScale,
        uint32_t tessellationFactor = 2 // 2 means 1 tri -> 4 micro-tris; 4 means 1 tri -> 16 micro-tris
    ) {
        NaniteCluster outCluster = inCluster;
        outCluster.vertices.clear();
        outCluster.indices.clear();
        
        size_t triCount = inCluster.indices.size() / 3;
        
        for (size_t t = 0; t < triCount; ++t) {
            const auto& v0 = inCluster.vertices[inCluster.indices[t * 3 + 0]];
            const auto& v1 = inCluster.vertices[inCluster.indices[t * 3 + 1]];
            const auto& v2 = inCluster.vertices[inCluster.indices[t * 3 + 2]];
            
            int N = std::max(1, static_cast<int>(tessellationFactor));
            uint32_t baseV = static_cast<uint32_t>(outCluster.vertices.size());
            
            // Regular barycentric grid displacement
            for (int i = 0; i <= N; ++i) {
                for (int j = 0; j <= N - i; ++j) {
                    float u = static_cast<float>(i) / static_cast<float>(N);
                    float v = static_cast<float>(j) / static_cast<float>(N);
                    float w = 1.0f - u - v;
                    
                    Vertex mv;
                    mv.position = v0.position * w + v1.position * u + v2.position * v;
                    mv.normal = (v0.normal * w + v1.normal * u + v2.normal * v).normalized();
                    mv.uv = v0.uv * w + v1.uv * u + v2.uv * v;
                    mv.color = v0.color * w + v1.color * u + v2.color * v;
                    
                    // Evaluate heightfield and displace vertex
                    float h = heightmap(mv.uv);
                    mv.position = mv.position + mv.normal * (h * displacementScale);
                    
                    outCluster.vertices.push_back(mv);
                }
            }
            
            // Build micro-triangle indices
            auto getIdx = [&](int i, int j) -> uint32_t {
                uint32_t rowStart = 0;
                for (int r = 0; r < i; ++r) {
                    rowStart += (N - r + 1);
                }
                return baseV + rowStart + j;
            };
            
            for (int i = 0; i < N; ++i) {
                for (int j = 0; j < N - i; ++j) {
                    uint32_t p00 = getIdx(i, j);
                    uint32_t p10 = getIdx(i + 1, j);
                    uint32_t p01 = getIdx(i, j + 1);
                    
                    outCluster.indices.push_back(p00);
                    outCluster.indices.push_back(p10);
                    outCluster.indices.push_back(p01);
                    
                    if (j + 1 < N - i) {
                        uint32_t p11 = getIdx(i + 1, j + 1);
                        outCluster.indices.push_back(p10);
                        outCluster.indices.push_back(p11);
                        outCluster.indices.push_back(p01);
                    }
                }
            }
        }
        
        return outCluster;
    }
};

} // namespace nanite
} // namespace scratchbox

#endif // SCRATCHBOX_NANITE_HPP
