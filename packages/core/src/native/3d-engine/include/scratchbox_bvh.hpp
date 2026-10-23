/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

#ifndef SCRATCHBOX_BVH_HPP
#define SCRATCHBOX_BVH_HPP

#include "scratchbox_math.hpp"
#include "scratchbox_geometry.hpp"

#include <vector>
#include <algorithm>
#include <cmath>
#include <cstdint>
#include <limits>
#include <random>

namespace scratchbox {
namespace bvh {

using math::Vec2;
using math::Vec3;
using math::Vec4;
using math::Ray;
using math::AABB;
using geometry::ScratchboxMesh;
using geometry::Vertex;

// ============================================================================
// 1. RAY INTERSECTION STRUCTURES & MÖLLER-TRUMBORE INTERSECTION
// ============================================================================
struct RayHit {
    float t{std::numeric_limits<float>::infinity()};
    float u{0.0f};
    float v{0.0f};
    uint32_t triangleIndex{0};
    Vec3 position{0.0f, 0.0f, 0.0f};
    Vec3 normal{0.0f, 1.0f, 0.0f};
    bool hit{false};
};

inline bool intersectTriangleMollerTrumbore(
    const Ray& ray,
    const Vec3& v0, const Vec3& v1, const Vec3& v2,
    float& outT, float& outU, float& outV,
    float tMin = 1e-4f, float tMax = 1e9f
) {
    Vec3 edge1 = v1 - v0;
    Vec3 edge2 = v2 - v0;
    Vec3 pvec = ray.direction.cross(edge2);
    float det = edge1.dot(pvec);

    if (std::abs(det) < 1e-8f) return false;
    float invDet = 1.0f / det;

    Vec3 tvec = ray.origin - v0;
    float u = tvec.dot(pvec) * invDet;
    if (u < 0.0f || u > 1.0f) return false;

    Vec3 qvec = tvec.cross(edge1);
    float v = ray.direction.dot(qvec) * invDet;
    if (v < 0.0f || u + v > 1.0f) return false;

    float t = edge2.dot(qvec) * invDet;
    if (t >= tMin && t <= tMax) {
        outT = t;
        outU = u;
        outV = v;
        return true;
    }
    return false;
}

// Closest point on triangle (v0, v1, v2) to point p
inline Vec3 closestPointTriangle(const Vec3& p, const Vec3& a, const Vec3& b, const Vec3& c) {
    Vec3 ab = b - a;
    Vec3 ac = c - a;
    Vec3 ap = p - a;
    float d1 = ab.dot(ap);
    float d2 = ac.dot(ap);
    if (d1 <= 0.0f && d2 <= 0.0f) return a;

    Vec3 bp = p - b;
    float d3 = ab.dot(bp);
    float d4 = ac.dot(bp);
    if (d3 >= 0.0f && d4 <= d3) return b;

    float vc = d1 * d4 - d3 * d2;
    if (vc <= 0.0f && d1 >= 0.0f && d3 <= 0.0f) {
        float v = d1 / (d1 - d3);
        return a + ab * v;
    }

    Vec3 cp = p - c;
    float d5 = ab.dot(cp);
    float d6 = ac.dot(cp);
    if (d6 >= 0.0f && d5 <= d6) return c;

    float vb = d5 * d2 - d1 * d6;
    if (vb <= 0.0f && d2 >= 0.0f && d6 <= 0.0f) {
        float w = d2 / (d2 - d6);
        return a + ac * w;
    }

    float va = d3 * d6 - d5 * d4;
    if (va <= 0.0f && (d4 - d3) >= 0.0f && (d5 - d6) >= 0.0f) {
        float w = (d4 - d3) / ((d4 - d3) + (d5 - d6));
        return b + (c - b) * w;
    }

    float denom = 1.0f / (va + vb + vc);
    float v = vb * denom;
    float w = vc * denom;
    return a + ab * v + ac * w;
}

// ============================================================================
// 2. BVH PRIMITIVE & TREE STRUCTURE (SAH BINNING)
// ============================================================================
struct BVHPrimitiveInfo {
    uint32_t triangleIndex;
    AABB bounds;
    Vec3 centroid;
};

struct LinearBVHNode {
    AABB bounds;
    uint32_t offsetOrSecondChild{0}; // Primitives offset if leaf, second child index if interior
    uint16_t primitiveCount{0};       // 0 for interior node
    uint8_t axis{0};                  // 0 = x, 1 = y, 2 = z
    uint8_t padding{0};
};

struct BVHBuildNode {
    AABB bounds;
    BVHBuildNode* children[2]{nullptr, nullptr};
    uint32_t splitAxis{0};
    uint32_t firstPrimOffset{0};
    uint32_t nPrimitives{0};

    void initLeaf(uint32_t first, uint32_t n, const AABB& b) {
        firstPrimOffset = first;
        nPrimitives = n;
        bounds = b;
        children[0] = children[1] = nullptr;
    }

    void initInterior(uint32_t axis, BVHBuildNode* c0, BVHBuildNode* c1) {
        splitAxis = axis;
        children[0] = c0;
        children[1] = c1;
        bounds = c0->bounds;
        bounds.expand(c1->bounds);
        nPrimitives = 0;
    }
};

class BvhTree {
private:
    const ScratchboxMesh* meshRef{nullptr};
    std::vector<LinearBVHNode> nodes;
    std::vector<uint32_t> orderedTriangleIndices;

    struct BVHBucket {
        uint32_t count{0};
        AABB bounds;
    };

    BVHBuildNode* recursiveBuild(
        std::vector<BVHPrimitiveInfo>& primitiveInfo,
        uint32_t start, uint32_t end,
        uint32_t& totalNodes,
        std::vector<uint32_t>& orderedPrims
    ) {
        totalNodes++;
        BVHBuildNode* node = new BVHBuildNode();
        AABB bounds;
        for (uint32_t i = start; i < end; ++i) {
            bounds.expand(primitiveInfo[i].bounds);
        }

        uint32_t nPrimitives = end - start;
        if (nPrimitives <= 4) {
            uint32_t firstPrimOffset = static_cast<uint32_t>(orderedPrims.size());
            for (uint32_t i = start; i < end; ++i) {
                orderedPrims.push_back(primitiveInfo[i].triangleIndex);
            }
            node->initLeaf(firstPrimOffset, nPrimitives, bounds);
            return node;
        }

        AABB centroidBounds;
        for (uint32_t i = start; i < end; ++i) {
            centroidBounds.expand(primitiveInfo[i].centroid);
        }
        Vec3 centroidExtent = centroidBounds.size();
        uint32_t dim = 0;
        if (centroidExtent.y > centroidExtent.x && centroidExtent.y > centroidExtent.z) dim = 1;
        else if (centroidExtent.z > centroidExtent.x && centroidExtent.z > centroidExtent.y) dim = 2;

        if (centroidExtent[dim] <= 1e-6f) {
            uint32_t firstPrimOffset = static_cast<uint32_t>(orderedPrims.size());
            for (uint32_t i = start; i < end; ++i) {
                orderedPrims.push_back(primitiveInfo[i].triangleIndex);
            }
            node->initLeaf(firstPrimOffset, nPrimitives, bounds);
            return node;
        }

        // SAH Partitioning with 16 Bins
        constexpr int nBuckets = 16;
        BVHBucket buckets[nBuckets];

        for (uint32_t i = start; i < end; ++i) {
            float val = primitiveInfo[i].centroid[dim];
            int b = static_cast<int>(nBuckets * ((val - centroidBounds.min[dim]) / (centroidBounds.max[dim] - centroidBounds.min[dim])));
            if (b >= nBuckets) b = nBuckets - 1;
            if (b < 0) b = 0;
            buckets[b].count++;
            buckets[b].bounds.expand(primitiveInfo[i].bounds);
        }

        float cost[nBuckets - 1];
        for (int i = 0; i < nBuckets - 1; ++i) {
            AABB b0, b1;
            uint32_t count0 = 0, count1 = 0;
            for (int j = 0; j <= i; ++j) {
                b0.expand(buckets[j].bounds);
                count0 += buckets[j].count;
            }
            for (int j = i + 1; j < nBuckets; ++j) {
                b1.expand(buckets[j].bounds);
                count1 += buckets[j].count;
            }
            cost[i] = 1.0f + (count0 * b0.surfaceArea() + count1 * b1.surfaceArea()) / bounds.surfaceArea();
        }

        float minCost = cost[0];
        int minCostSplitBucket = 0;
        for (int i = 1; i < nBuckets - 1; ++i) {
            if (cost[i] < minCost) {
                minCost = cost[i];
                minCostSplitBucket = i;
            }
        }

        float leafCost = static_cast<float>(nPrimitives);
        if (nPrimitives > 4 || minCost < leafCost) {
            auto pMid = std::partition(
                primitiveInfo.begin() + start,
                primitiveInfo.begin() + end,
                [=](const BVHPrimitiveInfo& pi) {
                    float val = pi.centroid[dim];
                    int b = static_cast<int>(nBuckets * ((val - centroidBounds.min[dim]) / (centroidBounds.max[dim] - centroidBounds.min[dim])));
                    if (b >= nBuckets) b = nBuckets - 1;
                    if (b < 0) b = 0;
                    return b <= minCostSplitBucket;
                }
            );

            uint32_t mid = static_cast<uint32_t>(pMid - primitiveInfo.begin());
            if (mid != start && mid != end) {
                node->initInterior(
                    dim,
                    recursiveBuild(primitiveInfo, start, mid, totalNodes, orderedPrims),
                    recursiveBuild(primitiveInfo, mid, end, totalNodes, orderedPrims)
                );
                return node;
            }
        }

        // Fallback to leaf
        uint32_t firstPrimOffset = static_cast<uint32_t>(orderedPrims.size());
        for (uint32_t i = start; i < end; ++i) {
            orderedPrims.push_back(primitiveInfo[i].triangleIndex);
        }
        node->initLeaf(firstPrimOffset, nPrimitives, bounds);
        return node;
    }

    uint32_t flattenTree(BVHBuildNode* node, uint32_t& offset) {
        LinearBVHNode* linearNode = &nodes[offset];
        linearNode->bounds = node->bounds;
        uint32_t myOffset = offset++;
        if (node->nPrimitives > 0) {
            linearNode->offsetOrSecondChild = node->firstPrimOffset;
            linearNode->primitiveCount = static_cast<uint16_t>(node->nPrimitives);
        } else {
            linearNode->axis = static_cast<uint8_t>(node->splitAxis);
            linearNode->primitiveCount = 0;
            flattenTree(node->children[0], offset);
            linearNode->offsetOrSecondChild = flattenTree(node->children[1], offset);
        }
        delete node;
        return myOffset;
    }

public:
    BvhTree() = default;

    bool build(const ScratchboxMesh& mesh) {
        meshRef = &mesh;
        nodes.clear();
        orderedTriangleIndices.clear();

        size_t triCount = mesh.indices.size() / 3;
        if (triCount == 0 || mesh.vertices.empty()) return false;

        std::vector<BVHPrimitiveInfo> primitiveInfo(triCount);
        for (size_t i = 0; i < triCount; ++i) {
            const auto& v0 = mesh.vertices[mesh.indices[i * 3]].position;
            const auto& v1 = mesh.vertices[mesh.indices[i * 3 + 1]].position;
            const auto& v2 = mesh.vertices[mesh.indices[i * 3 + 2]].position;

            AABB b(v0, v0);
            b.expand(v1);
            b.expand(v2);

            primitiveInfo[i].triangleIndex = static_cast<uint32_t>(i);
            primitiveInfo[i].bounds = b;
            primitiveInfo[i].centroid = (v0 + v1 + v2) * (1.0f / 3.0f);
        }

        uint32_t totalNodes = 0;
        orderedTriangleIndices.reserve(triCount);
        BVHBuildNode* root = recursiveBuild(primitiveInfo, 0, static_cast<uint32_t>(triCount), totalNodes, orderedTriangleIndices);

        nodes.resize(totalNodes);
        uint32_t offset = 0;
        flattenTree(root, offset);
        return true;
    }

    // Closest Hit Raycast
    bool raycast(const Ray& ray, RayHit& hit) const {
        if (nodes.empty() || !meshRef) return false;

        float tMinBox, tMaxBox;
        if (!nodes[0].bounds.intersect(ray, tMinBox, tMaxBox)) return false;

        uint32_t stack[64];
        int stackPtr = 0;
        stack[stackPtr++] = 0;

        bool foundHit = false;

        while (stackPtr > 0) {
            uint32_t nodeIdx = stack[--stackPtr];
            const LinearBVHNode& node = nodes[nodeIdx];

            if (node.bounds.intersect(ray, tMinBox, tMaxBox)) {
                if (tMinBox > hit.t) continue;

                if (node.primitiveCount > 0) {
                    // Leaf node
                    for (uint16_t i = 0; i < node.primitiveCount; ++i) {
                        uint32_t triIdx = orderedTriangleIndices[node.offsetOrSecondChild + i];
                        const auto& v0 = meshRef->vertices[meshRef->indices[triIdx * 3]];
                        const auto& v1 = meshRef->vertices[meshRef->indices[triIdx * 3 + 1]];
                        const auto& v2 = meshRef->vertices[meshRef->indices[triIdx * 3 + 2]];

                        float t, u, v;
                        if (intersectTriangleMollerTrumbore(ray, v0.position, v1.position, v2.position, t, u, v, 1e-4f, hit.t)) {
                            hit.t = t;
                            hit.u = u;
                            hit.v = v;
                            hit.triangleIndex = triIdx;
                            hit.position = ray.at(t);
                            hit.normal = (v0.normal * (1.0f - u - v) + v1.normal * u + v2.normal * v).normalized();
                            hit.hit = true;
                            foundHit = true;
                        }
                    }
                } else {
                    // Interior node: push near child last so it pops first
                    uint8_t axis = node.axis;
                    if (ray.sign[axis]) {
                        stack[stackPtr++] = nodeIdx + 1;
                        stack[stackPtr++] = node.offsetOrSecondChild;
                    } else {
                        stack[stackPtr++] = node.offsetOrSecondChild;
                        stack[stackPtr++] = nodeIdx + 1;
                    }
                }
            }
        }

        return foundHit;
    }

    // Shadow / Occlusion Ray (Any Hit within maxDistance)
    bool raycastAny(const Ray& ray, float maxDistance = 1e9f) const {
        if (nodes.empty() || !meshRef) return false;

        float tMinBox, tMaxBox;
        if (!nodes[0].bounds.intersect(ray, tMinBox, tMaxBox)) return false;

        uint32_t stack[64];
        int stackPtr = 0;
        stack[stackPtr++] = 0;

        while (stackPtr > 0) {
            uint32_t nodeIdx = stack[--stackPtr];
            const LinearBVHNode& node = nodes[nodeIdx];

            if (node.bounds.intersect(ray, tMinBox, tMaxBox)) {
                if (tMinBox > maxDistance) continue;

                if (node.primitiveCount > 0) {
                    for (uint16_t i = 0; i < node.primitiveCount; ++i) {
                        uint32_t triIdx = orderedTriangleIndices[node.offsetOrSecondChild + i];
                        const auto& v0 = meshRef->vertices[meshRef->indices[triIdx * 3]].position;
                        const auto& v1 = meshRef->vertices[meshRef->indices[triIdx * 3 + 1]].position;
                        const auto& v2 = meshRef->vertices[meshRef->indices[triIdx * 3 + 2]].position;

                        float t, u, v;
                        if (intersectTriangleMollerTrumbore(ray, v0, v1, v2, t, u, v, 1e-4f, maxDistance)) {
                            return true;
                        }
                    }
                } else {
                    stack[stackPtr++] = node.offsetOrSecondChild;
                    stack[stackPtr++] = nodeIdx + 1;
                }
            }
        }
        return false;
    }

    // Closest Point on Surface
    Vec3 closestPoint(const Vec3& p, float& outDistSq) const {
        outDistSq = std::numeric_limits<float>::infinity();
        Vec3 closestPt = p;
        if (nodes.empty() || !meshRef) return closestPt;

        uint32_t stack[64];
        int stackPtr = 0;
        stack[stackPtr++] = 0;

        while (stackPtr > 0) {
            uint32_t nodeIdx = stack[--stackPtr];
            const LinearBVHNode& node = nodes[nodeIdx];

            // Point to box distance lower bound
            Vec3 clamped(
                std::clamp(p.x, node.bounds.min.x, node.bounds.max.x),
                std::clamp(p.y, node.bounds.min.y, node.bounds.max.y),
                std::clamp(p.z, node.bounds.min.z, node.bounds.max.z)
            );
            float boxDistSq = (p - clamped).lengthSquared();
            if (boxDistSq > outDistSq) continue;

            if (node.primitiveCount > 0) {
                for (uint16_t i = 0; i < node.primitiveCount; ++i) {
                    uint32_t triIdx = orderedTriangleIndices[node.offsetOrSecondChild + i];
                    const auto& v0 = meshRef->vertices[meshRef->indices[triIdx * 3]].position;
                    const auto& v1 = meshRef->vertices[meshRef->indices[triIdx * 3 + 1]].position;
                    const auto& v2 = meshRef->vertices[meshRef->indices[triIdx * 3 + 2]].position;

                    Vec3 triPt = closestPointTriangle(p, v0, v1, v2);
                    float dSq = (p - triPt).lengthSquared();
                    if (dSq < outDistSq) {
                        outDistSq = dSq;
                        closestPt = triPt;
                    }
                }
            } else {
                // nearer box last (popped first): the best distance shrinks sooner, so more of the far subtree is pruned
                auto boxSq = [&](uint32_t i) {
                    const auto& b = nodes[i].bounds;
                    Vec3 c(std::clamp(p.x, b.min.x, b.max.x), std::clamp(p.y, b.min.y, b.max.y), std::clamp(p.z, b.min.z, b.max.z));
                    return (p - c).lengthSquared();
                };
                uint32_t a = nodeIdx + 1, b = node.offsetOrSecondChild;
                if (boxSq(a) > boxSq(b)) std::swap(a, b);
                stack[stackPtr++] = b;
                stack[stackPtr++] = a;
            }
        }

        return closestPt;
    }

    size_t getNodeCount() const { return nodes.size(); }
    AABB getRootBounds() const { return nodes.empty() ? AABB() : nodes[0].bounds; }
};

// ============================================================================
// 3. NATIVE RAY-TRACED AMBIENT OCCLUSION (RTAO) BAKER
// ============================================================================
inline std::vector<float> computeMeshRTAO(
    const ScratchboxMesh& mesh,
    int samplesPerVertex = 16,
    float maxDistance = 1.5f,
    uint32_t seed = 42
) {
    std::vector<float> ao(mesh.vertices.size(), 1.0f);
    if (mesh.vertices.empty() || mesh.indices.empty()) return ao;

    BvhTree bvh;
    if (!bvh.build(mesh)) return ao;

    std::mt19937 rng(seed);
    std::uniform_real_distribution<float> dist01(0.0f, 1.0f);

    for (size_t i = 0; i < mesh.vertices.size(); ++i) {
        const auto& vert = mesh.vertices[i];
        Vec3 normal = vert.normal.normalized();
        Vec3 origin = vert.position + normal * 1e-3f; // Bias above surface

        // Construct orthonormal basis (Tangent, Bitangent, Normal)
        Vec3 up = std::abs(normal.y) < 0.999f ? Vec3(0, 1, 0) : Vec3(1, 0, 0);
        Vec3 tangent = normal.cross(up).normalized();
        Vec3 bitangent = normal.cross(tangent);

        int unoccludedCount = 0;

        for (int s = 0; s < samplesPerVertex; ++s) {
            // Cosine-weighted hemisphere sampling
            float r1 = dist01(rng);
            float r2 = dist01(rng);
            float phi = 2.0f * math::PI * r1;
            float cosTheta = std::sqrt(r2);
            float sinTheta = std::sqrt(1.0f - r2);

            Vec3 rayDirLocal(
                sinTheta * std::cos(phi),
                sinTheta * std::sin(phi),
                cosTheta
            );

            Vec3 rayDirWorld = tangent * rayDirLocal.x + bitangent * rayDirLocal.y + normal * rayDirLocal.z;
            Ray ray(origin, rayDirWorld);

            if (!bvh.raycastAny(ray, maxDistance)) {
                unoccludedCount++;
            }
        }

        ao[i] = static_cast<float>(unoccludedCount) / static_cast<float>(samplesPerVertex);
    }

    return ao;
}

/**
 * Bakes computeMeshRTAO's per-vertex occlusion into vertex colour, at `intensity` strength — the same
 * lerp(1, ao, intensity) * colour.rgb convention processing::DifferentialGeometryEngine::bakeCavityAO uses for
 * its (curvature-based, not ray-traced) cavity AO, so a script can swap one bake for the other freely.
 */
inline void bakeMeshRTAO(
    ScratchboxMesh& mesh,
    int samplesPerVertex = 16,
    float maxDistance = 1.5f,
    float intensity = 1.0f,
    uint32_t seed = 42
) {
    std::vector<float> ao = computeMeshRTAO(mesh, samplesPerVertex, maxDistance, seed);
    for (size_t i = 0; i < mesh.vertices.size(); ++i) {
        float occ = 1.0f + (ao[i] - 1.0f) * intensity; // lerp(1, ao[i], intensity)
        mesh.vertices[i].color.x *= occ;
        mesh.vertices[i].color.y *= occ;
        mesh.vertices[i].color.z *= occ;
    }
}

} // namespace bvh
} // namespace scratchbox

#endif // SCRATCHBOX_BVH_HPP
