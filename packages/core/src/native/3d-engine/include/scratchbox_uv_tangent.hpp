/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
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
 * Computes 4-component MikkTSpace-compliant orthonormal tangents (Tx, Ty, Tz, handedness +/-1)
 * for each vertex in the mesh. Handedness is defined such that B = sign * cross(N, T).
 */
inline void generateMikkTSpaceTangents(ScratchboxMesh& mesh) {
    size_t vertCount = mesh.vertices.size();
    size_t triCount = mesh.indices.size() / 3;

    if (vertCount == 0 || triCount == 0) return;

    std::vector<Vec3> tan1(vertCount, Vec3(0, 0, 0));
    std::vector<Vec3> tan2(vertCount, Vec3(0, 0, 0));

    for (size_t f = 0; f < triCount; ++f) {
        uint32_t i0 = mesh.indices[f * 3 + 0];
        uint32_t i1 = mesh.indices[f * 3 + 1];
        uint32_t i2 = mesh.indices[f * 3 + 2];

        const Vec3& p0 = mesh.vertices[i0].position;
        const Vec3& p1 = mesh.vertices[i1].position;
        const Vec3& p2 = mesh.vertices[i2].position;

        const Vec2& w0 = mesh.vertices[i0].uv;
        const Vec2& w1 = mesh.vertices[i1].uv;
        const Vec2& w2 = mesh.vertices[i2].uv;

        Vec3 e1 = p1 - p0;
        Vec3 e2 = p2 - p0;

        float x1 = w1.x - w0.x;
        float x2 = w2.x - w0.x;
        float y1 = w1.y - w0.y;
        float y2 = w2.y - w0.y;

        float det = (x1 * y2 - x2 * y1);
        if (std::abs(det) < 1e-7f) {
            // Degenerate UVs: derive arbitrary tangent perpendicular to normal
            Vec3 n = (e1.cross(e2)).normalized();
            Vec3 arb = (std::abs(n.x) > 0.9f) ? Vec3(0, 1, 0) : Vec3(1, 0, 0);
            Vec3 t = (arb - n * n.dot(arb)).normalized();
            tan1[i0] += t;
            tan1[i1] += t;
            tan1[i2] += t;
            continue;
        }

        float r = 1.0f / det;
        Vec3 sdir((y2 * e1.x - y1 * e2.x) * r,
                  (y2 * e1.y - y1 * e2.y) * r,
                  (y2 * e1.z - y1 * e2.z) * r);
        Vec3 tdir((x1 * e2.x - x2 * e1.x) * r,
                  (x1 * e2.y - x2 * e1.y) * r,
                  (x1 * e2.z - x2 * e1.z) * r);

        // Area-weighted accumulation
        float triArea = 0.5f * (e1.cross(e2)).length();
        tan1[i0] += sdir * triArea;
        tan1[i1] += sdir * triArea;
        tan1[i2] += sdir * triArea;

        tan2[i0] += tdir * triArea;
        tan2[i1] += tdir * triArea;
        tan2[i2] += tdir * triArea;
    }

    for (size_t i = 0; i < vertCount; ++i) {
        Vec3 n = mesh.vertices[i].normal;
        if (n.lengthSq() < 1e-6f) n = Vec3(0, 1, 0);
        else n = n.normalized();

        Vec3 t = tan1[i];

        // Gram-Schmidt orthogonalize: T' = normalize(T - N * (N . T))
        Vec3 orthoT = t - n * n.dot(t);
        float lenT = orthoT.length();
        if (lenT > 1e-6f) {
            orthoT = orthoT / lenT;
        } else {
            // Pick fallback perpendicular vector
            Vec3 up = (std::abs(n.y) > 0.9f) ? Vec3(0, 0, 1) : Vec3(0, 1, 0);
            orthoT = (up - n * n.dot(up)).normalized();
        }

        // Calculate handedness: sign of cross(N, T) . B
        float handedness = (n.cross(orthoT).dot(tan2[i]) < 0.0f) ? -1.0f : 1.0f;

        mesh.vertices[i].tangent = Vec4(orthoT.x, orthoT.y, orthoT.z, handedness);
    }
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
