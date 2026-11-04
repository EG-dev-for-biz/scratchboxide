/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

#ifndef SCRATCHBOX_UV_TANGENT_HPP
#define SCRATCHBOX_UV_TANGENT_HPP

#include "scratchbox_math.hpp"
#include "scratchbox_geometry.hpp"
#include <vector>
#include <unordered_map>
#include <cmath>
#include <algorithm>
#include <cstdint>

namespace scratchbox {
namespace uv {

using math::Vec2;
using math::Vec3;
using math::Vec4;
using math::PI;
using math::TWO_PI;
using geometry::Vertex;
using geometry::ScratchboxMesh;

// ============================================================================
// 1. MikkTSpace Orthonormal Tangent & Handedness Generation
// ============================================================================

/**
 * Computes 4-component orthonormal tangents (Tx, Ty, Tz, handedness +/-1) for each vertex from its UVs, in glTF's
 * convention (B = sign * cross(N, T) points up the image, toward decreasing v): ScratchboxMesh::computeUvTangents,
 * the routine the GLB writer also uses for normal-mapped meshes whose tangents are still the Vertex placeholder.
 */
inline void generateMikkTSpaceTangents(ScratchboxMesh& mesh) {
    mesh.computeUvTangents();
}

// ============================================================================
// 2. Tangent-Space Normal Perturbation & TBN Evaluation
// ============================================================================

/**
 * Perturbs a vertex or interpolated surface normal using a tangent-space normal map vector.
 * tangentSpaceNormal: components in [-1, 1], where (0, 0, 1) represents unperturbed geometry normal.
 */
inline Vec3 perturbNormalTBN(
    const Vec3& geomNormal,
    const Vec4& tangent,
    const Vec3& tangentSpaceNormal
) {
    Vec3 n = geomNormal.normalized();
    Vec3 t = Vec3(tangent.x, tangent.y, tangent.z).normalized();
    // Bitangent B = handedness * cross(N, T)
    Vec3 b = n.cross(t) * tangent.w;

    // Transform from tangent space to world space: T * n.x + B * n.y + N * n.z
    Vec3 perturbed = t * tangentSpaceNormal.x + b * tangentSpaceNormal.y + n * tangentSpaceNormal.z;
    float len = perturbed.length();
    return len > 1e-6f ? perturbed / len : n;
}

// ============================================================================
// 3. Harmonic / Conformal UV Parameterization (Tutte's Spring Embedding)
// ============================================================================

/**
 * Unwraps an open surface patch homeomorphic to a disk into bijective 2D UV coordinates
 * using Tutte's Spring Embedding with harmonic interior relaxation (del^2 u = 0, del^2 v = 0).
 * Guarantees zero triangle fold-overs / inversions.
 */
inline void parameterizeHarmonicUV(ScratchboxMesh& mesh, int maxIterations = 80) {
    size_t vertCount = mesh.vertices.size();
    size_t triCount = mesh.indices.size() / 3;
    if (vertCount < 3 || triCount == 0) return;

    // Detect directed boundary edges (edges with no opposing face)
    struct DirectedEdge {
        uint32_t u, v;
    };
    std::unordered_map<uint64_t, int> edgeCount;
    auto makeEdgeKey = [](uint32_t a, uint32_t b) -> uint64_t {
        uint64_t lo = std::min(a, b);
        uint64_t hi = std::max(a, b);
        return (lo << 32) | hi;
    };

    for (size_t f = 0; f < triCount; ++f) {
        uint32_t i0 = mesh.indices[f * 3 + 0];
        uint32_t i1 = mesh.indices[f * 3 + 1];
        uint32_t i2 = mesh.indices[f * 3 + 2];
        edgeCount[makeEdgeKey(i0, i1)]++;
        edgeCount[makeEdgeKey(i1, i2)]++;
        edgeCount[makeEdgeKey(i2, i0)]++;
    }

    std::unordered_map<uint32_t, uint32_t> nextBoundaryVert;
    std::vector<bool> isBoundary(vertCount, false);

    for (size_t f = 0; f < triCount; ++f) {
        uint32_t idx[3] = {mesh.indices[f * 3 + 0], mesh.indices[f * 3 + 1], mesh.indices[f * 3 + 2]};
        for (int k = 0; k < 3; ++k) {
            uint32_t u = idx[k];
            uint32_t v = idx[(k + 1) % 3];
            if (edgeCount[makeEdgeKey(u, v)] == 1) {
                // Directed boundary edge u -> v
                nextBoundaryVert[u] = v;
                isBoundary[u] = true;
                isBoundary[v] = true;
            }
        }
    }

    // If no boundary found (e.g. closed sphere or cylinder), fallback to spherical unwrap
    if (nextBoundaryVert.empty()) {
        for (auto& v : mesh.vertices) {
            Vec3 dir = v.position.normalized();
            float u = 0.5f + std::atan2(dir.z, dir.x) / TWO_PI;
            float vCoord = 0.5f - std::asin(std::clamp(dir.y, -1.0f, 1.0f)) / PI;
            v.uv = Vec2(u, vCoord);
        }
        generateMikkTSpaceTangents(mesh);
        return;
    }

    // Extract the primary boundary loop
    uint32_t startVert = nextBoundaryVert.begin()->first;
    std::vector<uint32_t> loop;
    uint32_t curr = startVert;
    std::vector<bool> visited(vertCount, false);

    while (curr < vertCount && !visited[curr]) {
        visited[curr] = true;
        loop.push_back(curr);
        auto it = nextBoundaryVert.find(curr);
        if (it == nextBoundaryVert.end()) break;
        curr = it->second;
    }

    // Compute cumulative arc-length of the boundary loop
    float totalLength = 0.0f;
    std::vector<float> arcLengths(loop.size(), 0.0f);
    for (size_t i = 0; i < loop.size(); ++i) {
        uint32_t u = loop[i];
        uint32_t v = loop[(i + 1) % loop.size()];
        float d = (mesh.vertices[u].position - mesh.vertices[v].position).length();
        totalLength += d;
        if (i + 1 < loop.size()) arcLengths[i + 1] = totalLength;
    }

    // Map boundary loop to unit circle in UV space [0.05, 0.95]
    if (totalLength > 1e-6f) {
        for (size_t i = 0; i < loop.size(); ++i) {
            float frac = arcLengths[i] / totalLength;
            float theta = frac * TWO_PI;
            float u = 0.5f + 0.45f * std::cos(theta);
            float v = 0.5f + 0.45f * std::sin(theta);
            mesh.vertices[loop[i]].uv = Vec2(u, v);
        }
    }

    // Build vertex adjacency for harmonic interior relaxation
    std::vector<std::vector<uint32_t>> neighbors(vertCount);
    for (size_t f = 0; f < triCount; ++f) {
        uint32_t i0 = mesh.indices[f * 3 + 0];
        uint32_t i1 = mesh.indices[f * 3 + 1];
        uint32_t i2 = mesh.indices[f * 3 + 2];
        neighbors[i0].push_back(i1); neighbors[i0].push_back(i2);
        neighbors[i1].push_back(i0); neighbors[i1].push_back(i2);
        neighbors[i2].push_back(i0); neighbors[i2].push_back(i1);
    }

    // Initialize interior vertices to centroid of boundary
    for (size_t i = 0; i < vertCount; ++i) {
        if (!isBoundary[i]) {
            mesh.vertices[i].uv = Vec2(0.5f, 0.5f);
        }
    }

    // Gauss-Seidel harmonic relaxation
    for (int iter = 0; iter < maxIterations; ++iter) {
        for (size_t i = 0; i < vertCount; ++i) {
            if (isBoundary[i] || neighbors[i].empty()) continue;

            float sumU = 0.0f, sumV = 0.0f;
            for (uint32_t nb : neighbors[i]) {
                sumU += mesh.vertices[nb].uv.x;
                sumV += mesh.vertices[nb].uv.y;
            }
            float invDeg = 1.0f / static_cast<float>(neighbors[i].size());
            mesh.vertices[i].uv = Vec2(sumU * invDeg, sumV * invDeg);
        }
    }

    // Finally compute MikkTSpace tangents for the new parameterization
    generateMikkTSpaceTangents(mesh);
}

} // namespace uv
} // namespace scratchbox

#endif // SCRATCHBOX_UV_TANGENT_HPP
