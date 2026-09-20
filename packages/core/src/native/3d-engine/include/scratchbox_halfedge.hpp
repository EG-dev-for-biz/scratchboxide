/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

#ifndef SCRATCHBOX_HALFEDGE_HPP
#define SCRATCHBOX_HALFEDGE_HPP

#include "scratchbox_math.hpp"
#include "scratchbox_geometry.hpp"
#include <vector>
#include <queue>
#include <unordered_map>
#include <set>
#include <cmath>
#include <algorithm>
#include <limits>
#include <cstdint>

namespace scratchbox {
namespace halfedge {

using math::Vec2;
using math::Vec3;
using math::Vec4;
using math::PI;
using math::TWO_PI;
using geometry::Vertex;
using geometry::ScratchboxMesh;

// ============================================================================
// 1. Half-Edge (DCEL - Doubly Connected Edge List) Primitives
// ============================================================================

struct HalfEdge {
    int id{-1};
    int origin{-1};     // Origin vertex index
    int target{-1};     // Target vertex index
    int twin{-1};       // Opposing half-edge index (-1 if boundary)
    int next{-1};       // Next half-edge in face loop
    int prev{-1};       // Previous half-edge in face loop
    int face{-1};       // Incident face index
};

struct VertexNode {
    int id{-1};
    Vec3 position{0, 0, 0};
    Vec3 normal{0, 1, 0};
    Vec2 uv{0, 0};
    Vec4 color{1, 1, 1, 1};
    Vec4 tangent{1, 0, 0, 1};
    int halfEdge{-1};   // One outgoing half-edge
    bool deleted{false};
};

struct FaceNode {
    int id{-1};
    int halfEdge{-1};   // One incident half-edge
    Vec3 normal{0, 1, 0};
    float area{0.0f};
    bool deleted{false};
};

class HalfEdgeMesh {
public:
    std::vector<VertexNode> vertices;
    std::vector<HalfEdge> halfEdges;
    std::vector<FaceNode> faces;

    HalfEdgeMesh() = default;

    /**
     * Builds a Half-Edge DCEL representation from a triangle ScratchboxMesh.
     */
    static HalfEdgeMesh fromScratchboxMesh(const ScratchboxMesh& mesh) {
        return fromMesh(mesh);
    }

    static HalfEdgeMesh fromMesh(const ScratchboxMesh& mesh) {
        HalfEdgeMesh heMesh;
        heMesh.vertices.reserve(mesh.vertices.size());


        for (size_t i = 0; i < mesh.vertices.size(); ++i) {
            const auto& v = mesh.vertices[i];
            VertexNode vn;
            vn.id = static_cast<int>(i);
            vn.position = v.position;
            vn.normal = v.normal;
            vn.uv = v.uv;
            vn.color = v.color;
            vn.tangent = v.tangent;
            vn.halfEdge = -1;
            vn.deleted = false;
            heMesh.vertices.push_back(vn);
        }

        struct EdgeKey {
            int u, v;
            bool operator==(const EdgeKey& o) const { return u == o.u && v == o.v; }
        };
        struct EdgeHash {
            size_t operator()(const EdgeKey& k) const {
                return (static_cast<size_t>(k.u) * 73856093) ^ (static_cast<size_t>(k.v) * 19349663);
            }
        };

        std::unordered_map<EdgeKey, int, EdgeHash> edgeLookup;
        size_t triCount = mesh.indices.size() / 3;
        heMesh.faces.reserve(triCount);
        heMesh.halfEdges.reserve(triCount * 3);

        for (size_t f = 0; f < triCount; ++f) {
            int i0 = static_cast<int>(mesh.indices[f * 3 + 0]);
            int i1 = static_cast<int>(mesh.indices[f * 3 + 1]);
            int i2 = static_cast<int>(mesh.indices[f * 3 + 2]);

            FaceNode fn;
            fn.id = static_cast<int>(f);
            fn.deleted = false;

            Vec3 p0 = heMesh.vertices[i0].position;
            Vec3 p1 = heMesh.vertices[i1].position;
            Vec3 p2 = heMesh.vertices[i2].position;
            Vec3 fnVec = (p1 - p0).cross(p2 - p0);
            float len = fnVec.length();
            fn.area = 0.5f * len;
            fn.normal = len > 1e-6f ? fnVec / len : Vec3(0, 1, 0);

            int baseHe = static_cast<int>(heMesh.halfEdges.size());
            fn.halfEdge = baseHe;
            heMesh.faces.push_back(fn);

            int triVerts[3] = {i0, i1, i2};
            for (int k = 0; k < 3; ++k) {
                HalfEdge he;
                he.id = baseHe + k;
                he.origin = triVerts[k];
                he.target = triVerts[(k + 1) % 3];
                he.face = static_cast<int>(f);
                he.next = baseHe + ((k + 1) % 3);
                he.prev = baseHe + ((k + 2) % 3);
                he.twin = -1;

                if (heMesh.vertices[triVerts[k]].halfEdge == -1) {
                    heMesh.vertices[triVerts[k]].halfEdge = he.id;
                }

                EdgeKey key{he.origin, he.target};
                edgeLookup[key] = he.id;

                EdgeKey twinKey{he.target, he.origin};
                auto it = edgeLookup.find(twinKey);
                if (it != edgeLookup.end()) {
                    he.twin = it->second;
                    heMesh.halfEdges[it->second].twin = he.id;
                }

                heMesh.halfEdges.push_back(he);
            }
        }

        return heMesh;
    }

    /**
     * Converts the HalfEdgeMesh back to an indexed ScratchboxMesh.
     */
    ScratchboxMesh toScratchboxMesh(const std::string& name = "halfedge_mesh") const {
        ScratchboxMesh out(name);
        std::vector<int> remap(vertices.size(), -1);

        for (size_t i = 0; i < vertices.size(); ++i) {
            if (!vertices[i].deleted) {
                remap[i] = static_cast<int>(out.vertices.size());
                out.addVertex(Vertex(
                    vertices[i].position,
                    vertices[i].normal,
                    vertices[i].uv,
                    vertices[i].color,
                    vertices[i].tangent
                ));
            }
        }

        for (const auto& f : faces) {
            if (f.deleted || f.halfEdge < 0) continue;
            const auto& h0 = halfEdges[f.halfEdge];
            const auto& h1 = halfEdges[h0.next];
            const auto& h2 = halfEdges[h1.next];

            int idx0 = remap[h0.origin];
            int idx1 = remap[h1.origin];
            int idx2 = remap[h2.origin];

            if (idx0 >= 0 && idx1 >= 0 && idx2 >= 0 && idx0 != idx1 && idx1 != idx2 && idx2 != idx0) {
                out.addTriangle(static_cast<uint32_t>(idx0), static_cast<uint32_t>(idx1), static_cast<uint32_t>(idx2));
            }
        }

        out.recomputeBounds();
        return out;
    }

    /**
     * Gathers all outgoing half-edge indices circulating around a vertex.
     */
    std::vector<int> getVertexOutgoingHalfEdges(int vId) const {
        std::vector<int> result;
        if (vId < 0 || vId >= static_cast<int>(vertices.size()) || vertices[vId].deleted) return result;

        int startHe = vertices[vId].halfEdge;
        if (startHe < 0) return result;

        int curr = startHe;
        int guard = 0;
        do {
            result.push_back(curr);
            int twin = halfEdges[curr].twin;
            if (twin < 0) break; // Reached boundary
            curr = halfEdges[twin].next;
            if (++guard > 128) break;
        } while (curr != startHe && curr >= 0);

        return result;
    }

    /**
     * Checks if a vertex lies on an open boundary.
     */
    bool isBoundaryVertex(int vId) const {
        auto outgoing = getVertexOutgoingHalfEdges(vId);
        for (int he : outgoing) {
            if (halfEdges[he].twin == -1) return true;
        }
        return false;
    }
};

// ============================================================================
// 2. Garland-Heckbert Quadric Error Metric (QEM) LOD Decimation
// ============================================================================

struct Quadric4x4 {
    // Stored as 10 independent symmetric coefficients:
    // [ a2, ab, ac, ad ]
    // [ ab, b2, bc, bd ]
    // [ ac, bc, c2, cd ]
    // [ ad, bd, cd, d2 ]
    float a2{0.0f}, ab{0.0f}, ac{0.0f}, ad{0.0f};
    float b2{0.0f}, bc{0.0f}, bd{0.0f};
    float c2{0.0f}, cd{0.0f};
    float d2{0.0f};

    Quadric4x4() = default;

    /**
     * Creates a fundamental quadric from a plane equation p = [a, b, c, d]^T
     * where ax + by + cz + d = 0 and a^2 + b^2 + c^2 = 1.
     */
    static Quadric4x4 fromPlane(float a, float b, float c, float d) {
        Quadric4x4 q;
        q.a2 = a * a; q.ab = a * b; q.ac = a * c; q.ad = a * d;
        q.b2 = b * b; q.bc = b * c; q.bd = b * d;
        q.c2 = c * c; q.cd = c * d;
        q.d2 = d * d;
        return q;
    }

    static Quadric4x4 fromTriangle(const Vec3& p0, const Vec3& p1, const Vec3& p2) {
        Vec3 n = (p1 - p0).cross(p2 - p0);
        float len = n.length();
        if (len < 1e-8f) return Quadric4x4();
        n = n / len;
        float d = -n.dot(p0);
        return fromPlane(n.x, n.y, n.z, d);
    }

    Quadric4x4 operator+(const Quadric4x4& o) const {
        Quadric4x4 r;
        r.a2 = a2 + o.a2; r.ab = ab + o.ab; r.ac = ac + o.ac; r.ad = ad + o.ad;
        r.b2 = b2 + o.b2; r.bc = bc + o.bc; r.bd = bd + o.bd;
        r.c2 = c2 + o.c2; r.cd = cd + o.cd;
        r.d2 = d2 + o.d2;
        return r;
    }

    Quadric4x4& operator+=(const Quadric4x4& o) {
        *this = *this + o;
        return *this;
    }

    /**
     * Evaluates error E(v) = v^T Q v where v = [x, y, z, 1]^T.
     */
    float evaluate(const Vec3& p) const {
        return a2 * p.x * p.x + 2.0f * ab * p.x * p.y + 2.0f * ac * p.x * p.z + 2.0f * ad * p.x +
               b2 * p.y * p.y + 2.0f * bc * p.y * p.z + 2.0f * bd * p.y +
               c2 * p.z * p.z + 2.0f * cd * p.z +
               d2;
    }

    /**
     * Solves for the optimal vertex placement that minimizes quadric error:
     * [ a2 ab ac ] [ x ]   [ -ad ]
     * [ ab b2 bc ] [ y ] = [ -bd ]
     * [ ac bc c2 ] [ z ]   [ -cd ]
     * If the determinant is near zero, evaluates endpoints p0, p1, and midpoint (p0+p1)/2.
     */
    Vec3 solveOptimalPosition(const Vec3& p0, const Vec3& p1) const {
        float det = a2 * (b2 * c2 - bc * bc) -
                    ab * (ab * c2 - bc * ac) +
                    ac * (ab * bc - b2 * ac);

        if (std::abs(det) > 1e-5f) {
            float invDet = 1.0f / det;
            // Solve via Cramer's rule
            float m00 = b2 * c2 - bc * bc, m01 = ac * bc - ab * c2, m02 = ab * bc - ac * b2;
            float m10 = bc * ac - ab * c2, m11 = a2 * c2 - ac * ac, m12 = ab * ac - a2 * bc;
            float m20 = ab * bc - ac * b2, m21 = ac * ab - a2 * bc, m22 = a2 * b2 - ab * ab;

            Vec3 opt(
                (-ad * m00 - bd * m01 - cd * m02) * invDet,
                (-ad * m10 - bd * m11 - cd * m12) * invDet,
                (-ad * m20 - bd * m21 - cd * m22) * invDet
            );

            // Sanity check: optimal position should be within proximity of edge bounds
            float dist0 = (opt - p0).length();
            float dist1 = (opt - p1).length();
            float edgeLen = (p1 - p0).length();
            if (dist0 < edgeLen * 2.5f && dist1 < edgeLen * 2.5f) {
                return opt;
            }
        }

        // Fallback: test endpoints and midpoint
        Vec3 mid = (p0 + p1) * 0.5f;
        float e0 = evaluate(p0);
        float e1 = evaluate(p1);
        float eMid = evaluate(mid);

        if (eMid <= e0 && eMid <= e1) return mid;
        if (e0 <= e1) return p0;
        return p1;
    }
};

struct EdgeCollapseCandidate {
    int v0;
    int v1;
    Vec3 targetPos;
    float cost;

    bool operator>(const EdgeCollapseCandidate& o) const {
        return cost > o.cost;
    }
};

/**
 * Decimates a ScratchboxMesh down to targetTriangleCount using Garland-Heckbert QEM.
 */
inline ScratchboxMesh decimateMeshQEM(
    const ScratchboxMesh& input,
    uint32_t targetTriangles,
    float maxError = 1e8f
) {
    if (input.indices.size() <= targetTriangles * 3 || input.indices.empty()) {
        return input;
    }

    size_t vertCount = input.vertices.size();
    size_t triCount = input.indices.size() / 3;

    std::vector<Quadric4x4> quadrics(vertCount);
    std::vector<Vec3> positions(vertCount);
    std::vector<Vec3> normals(vertCount);
    std::vector<Vec2> uvs(vertCount);
    std::vector<Vec4> colors(vertCount);
    std::vector<Vec4> tangents(vertCount);
    std::vector<bool> deleted(vertCount, false);

    for (size_t i = 0; i < vertCount; ++i) {
        positions[i] = input.vertices[i].position;
        normals[i] = input.vertices[i].normal;
        uvs[i] = input.vertices[i].uv;
        colors[i] = input.vertices[i].color;
        tangents[i] = input.vertices[i].tangent;
    }

    struct Triangle {
        int v[3];
        bool deleted{false};
    };
    std::vector<Triangle> triangles(triCount);

    for (size_t f = 0; f < triCount; ++f) {
        int i0 = static_cast<int>(input.indices[f * 3 + 0]);
        int i1 = static_cast<int>(input.indices[f * 3 + 1]);
        int i2 = static_cast<int>(input.indices[f * 3 + 2]);
        triangles[f] = {{i0, i1, i2}, false};

        Quadric4x4 qf = Quadric4x4::fromTriangle(positions[i0], positions[i1], positions[i2]);
        quadrics[i0] += qf;
        quadrics[i1] += qf;
        quadrics[i2] += qf;
    }

    // Vertex to incident triangles mapping
    std::vector<std::vector<int>> vertTris(vertCount);
    for (size_t f = 0; f < triCount; ++f) {
        vertTris[triangles[f].v[0]].push_back(static_cast<int>(f));
        vertTris[triangles[f].v[1]].push_back(static_cast<int>(f));
        vertTris[triangles[f].v[2]].push_back(static_cast<int>(f));
    }

    // Build unique undirected edge candidates
    std::set<std::pair<int, int>> uniqueEdges;
    std::priority_queue<EdgeCollapseCandidate, std::vector<EdgeCollapseCandidate>, std::greater<EdgeCollapseCandidate>> pq;

    for (const auto& tri : triangles) {
        for (int k = 0; k < 3; ++k) {
            int u = tri.v[k];
            int v = tri.v[(k + 1) % 3];
            if (u > v) std::swap(u, v);
            if (uniqueEdges.insert({u, v}).second) {
                Quadric4x4 qSum = quadrics[u] + quadrics[v];
                Vec3 opt = qSum.solveOptimalPosition(positions[u], positions[v]);
                float cost = qSum.evaluate(opt);
                pq.push({u, v, opt, cost});
            }
        }
    }

    size_t currentTriCount = triCount;

    while (!pq.empty() && currentTriCount > targetTriangles) {
        auto cand = pq.top();
        pq.pop();

        int u = cand.v0;
        int v = cand.v1;

        if (deleted[u] || deleted[v]) continue;
        if (cand.cost > maxError) break;

        // Check for triangle flipping before collapsing v into u
        bool flipDetected = false;
        for (int triIdx : vertTris[v]) {
            if (triangles[triIdx].deleted) continue;
            int a = triangles[triIdx].v[0];
            int b = triangles[triIdx].v[1];
            int c = triangles[triIdx].v[2];
            if (a == u || b == u || c == u) continue; // Will become degenerate and deleted

            Vec3 pa = (a == v) ? cand.targetPos : positions[a];
            Vec3 pb = (b == v) ? cand.targetPos : positions[b];
            Vec3 pc = (c == v) ? cand.targetPos : positions[c];

            Vec3 origNorm = (positions[b] - positions[a]).cross(positions[c] - positions[a]);
            Vec3 newNorm = (pb - pa).cross(pc - pa);

            if (origNorm.dot(newNorm) < 0.0f) {
                flipDetected = true;
                break;
            }
        }
        if (flipDetected) continue;

        // Collapse: move u to targetPos, redirect v to u
        positions[u] = cand.targetPos;
        normals[u] = (normals[u] + normals[v]).normalized();
        uvs[u] = (uvs[u] + uvs[v]) * 0.5f;
        colors[u] = (colors[u] + colors[v]) * 0.5f;
        tangents[u] = (tangents[u] + tangents[v]) * 0.5f;
        quadrics[u] += quadrics[v];
        deleted[v] = true;

        // Update triangles
        for (int triIdx : vertTris[v]) {
            if (triangles[triIdx].deleted) continue;
            auto& t = triangles[triIdx];
            if (t.v[0] == u || t.v[1] == u || t.v[2] == u) {
                // Degenerate triangle
                t.deleted = true;
                currentTriCount--;
            } else {
                if (t.v[0] == v) t.v[0] = u;
                if (t.v[1] == v) t.v[1] = u;
                if (t.v[2] == v) t.v[2] = u;
                vertTris[u].push_back(triIdx);
            }
        }
        vertTris[v].clear();
    }

    // Assemble output mesh
    ScratchboxMesh out(input.name + "_lod");
    out.material = input.material;
    std::vector<int> remap(vertCount, -1);

    for (size_t f = 0; f < triCount; ++f) {
        if (triangles[f].deleted) continue;
        int i0 = triangles[f].v[0];
        int i1 = triangles[f].v[1];
        int i2 = triangles[f].v[2];
        if (i0 == i1 || i1 == i2 || i2 == i0) continue;

        if (remap[i0] == -1) {
            remap[i0] = static_cast<int>(out.vertices.size());
            out.addVertex(Vertex(positions[i0], normals[i0], uvs[i0], colors[i0], tangents[i0]));
        }
        if (remap[i1] == -1) {
            remap[i1] = static_cast<int>(out.vertices.size());
            out.addVertex(Vertex(positions[i1], normals[i1], uvs[i1], colors[i1], tangents[i1]));
        }
        if (remap[i2] == -1) {
            remap[i2] = static_cast<int>(out.vertices.size());
            out.addVertex(Vertex(positions[i2], normals[i2], uvs[i2], colors[i2], tangents[i2]));
        }

        out.addTriangle(
            static_cast<uint32_t>(remap[i0]),
            static_cast<uint32_t>(remap[i1]),
            static_cast<uint32_t>(remap[i2])
        );
    }

    out.recomputeBounds();
    out.recomputeSmoothNormals();
    return out;
}

// ============================================================================
// 3. Discrete Differential Geometry (Laplace-Beltrami Cotangent Curvature)
// ============================================================================

struct DiscreteCurvatureResult {
    std::vector<float> meanCurvature;
    std::vector<float> gaussianCurvature;
    std::vector<Vec3> laplacianVectors;
};

inline DiscreteCurvatureResult computeLaplaceBeltramiCurvature(const ScratchboxMesh& mesh) {
    DiscreteCurvatureResult result;
    size_t vertCount = mesh.vertices.size();
    if (vertCount == 0 || mesh.indices.empty()) return result;

    result.meanCurvature.assign(vertCount, 0.0f);
    result.gaussianCurvature.assign(vertCount, 0.0f);
    result.laplacianVectors.assign(vertCount, Vec3(0, 0, 0));

    std::vector<float> dualAreas(vertCount, 0.0f);
    std::vector<float> angleSums(vertCount, 0.0f);

    size_t triCount = mesh.indices.size() / 3;

    for (size_t f = 0; f < triCount; ++f) {
        uint32_t i0 = mesh.indices[f * 3 + 0];
        uint32_t i1 = mesh.indices[f * 3 + 1];
        uint32_t i2 = mesh.indices[f * 3 + 2];

        Vec3 p0 = mesh.vertices[i0].position;
        Vec3 p1 = mesh.vertices[i1].position;
        Vec3 p2 = mesh.vertices[i2].position;

        Vec3 e01 = p1 - p0;
        Vec3 e12 = p2 - p1;
        Vec3 e20 = p0 - p2;

        float a01 = e01.length();
        float a12 = e12.length();
        float a20 = e20.length();

        if (a01 < 1e-6f || a12 < 1e-6f || a20 < 1e-6f) continue;

        // Angles via dot products
        float cos0 = std::clamp((-e20).dot(e01) / (a20 * a01), -1.0f, 1.0f);
        float cos1 = std::clamp((-e01).dot(e12) / (a01 * a12), -1.0f, 1.0f);
        float cos2 = std::clamp((-e12).dot(e20) / (a12 * a20), -1.0f, 1.0f);

        float theta0 = std::acos(cos0);
        float theta1 = std::acos(cos1);
        float theta2 = std::acos(cos2);

        angleSums[i0] += theta0;
        angleSums[i1] += theta1;
        angleSums[i2] += theta2;

        float sin0 = std::max(1e-4f, std::sin(theta0));
        float sin1 = std::max(1e-4f, std::sin(theta1));
        float sin2 = std::max(1e-4f, std::sin(theta2));

        float cot0 = cos0 / sin0;
        float cot1 = cos1 / sin1;
        float cot2 = cos2 / sin2;

        float triArea = 0.5f * (e01.cross(-e20)).length();
        dualAreas[i0] += triArea / 3.0f;
        dualAreas[i1] += triArea / 3.0f;
        dualAreas[i2] += triArea / 3.0f;

        // Cotangent Laplace-Beltrami contributions
        result.laplacianVectors[i0] += (p1 - p0) * cot2 + (p2 - p0) * cot1;
        result.laplacianVectors[i1] += (p2 - p1) * cot0 + (p0 - p1) * cot2;
        result.laplacianVectors[i2] += (p0 - p2) * cot1 + (p1 - p2) * cot0;
    }

    for (size_t i = 0; i < vertCount; ++i) {
        float area = std::max(1e-6f, dualAreas[i]);
        result.laplacianVectors[i] = result.laplacianVectors[i] / (2.0f * area);
        result.meanCurvature[i] = 0.5f * result.laplacianVectors[i].length();
        result.gaussianCurvature[i] = (TWO_PI - angleSums[i]) / area;
    }

    return result;
}

// ============================================================================
// 6. Gray-Scott Reaction-Diffusion PDE Solver (Alan Turing 1952 / Tissue)
// ============================================================================

struct ReactionDiffusionConfig {
    float feedRate{0.0545f};         // F: feed rate of chemical U (Turing spot pattern: 0.035 - 0.055)
    float killRate{0.0620f};         // k: conversion/decay rate of chemical V (0.060 - 0.065)
    float diffusionU{0.16f};         // Du: diffusion rate of morphogen U
    float diffusionV{0.08f};         // Dv: diffusion rate of morphogen V
    float dt{1.0f};                  // Numerical time-step
    int iterations{120};             // Simulation update steps
    int seedPerturbations{10};       // Number of initial morphogen seed injection points
    float displacementScale{0.08f};  // Surface extrusion along vertex normals
    Vec4 lowColor{0.10f, 0.12f, 0.22f, 1.0f};  // Deep indigo/navy for base concentration
    Vec4 highColor{0.95f, 0.82f, 0.25f, 1.0f}; // Warm gold/amber for Turing spots
    uint32_t seed{98765};
};

class GrayScottReactionDiffusion {
public:
    /**
     * Solves the coupled non-linear reaction-diffusion PDE on an arbitrary 3D mesh:
     *   dU/dt = Du * \Delta U - U * V^2 + F * (1 - U)
     *   dV/dt = Dv * \Delta V + U * V^2 - (F + k) * V
     * Updates vertex colors and applies normal displacement.
     */
    static void simulate(ScratchboxMesh& mesh, const ReactionDiffusionConfig& cfg) {
        if (mesh.vertices.empty() || mesh.indices.empty()) return;

        HalfEdgeMesh heMesh = HalfEdgeMesh::fromScratchboxMesh(mesh);
        size_t n = mesh.vertices.size();

        // 1. Build adjacency list and discrete cotangent Laplace-Beltrami weights
        std::vector<std::vector<std::pair<int, float>>> neighbors(n);
        std::vector<float> dualAreas(n, 0.0f);

        size_t triCount = mesh.indices.size() / 3;
        for (size_t t = 0; t < triCount; ++t) {
            uint32_t i0 = mesh.indices[t * 3 + 0];
            uint32_t i1 = mesh.indices[t * 3 + 1];
            uint32_t i2 = mesh.indices[t * 3 + 2];

            Vec3 p0 = mesh.vertices[i0].position;
            Vec3 p1 = mesh.vertices[i1].position;
            Vec3 p2 = mesh.vertices[i2].position;

            Vec3 e01 = p1 - p0;
            Vec3 e12 = p2 - p1;
            Vec3 e20 = p0 - p2;

            float l01 = e01.length();
            float l12 = e12.length();
            float l20 = e20.length();
            if (l01 < 1e-6f || l12 < 1e-6f || l20 < 1e-6f) continue;

            float cos0 = std::clamp((-e20).dot(e01) / (l20 * l01), -0.999f, 0.999f);
            float cos1 = std::clamp((-e01).dot(e12) / (l01 * l12), -0.999f, 0.999f);
            float cos2 = std::clamp((-e12).dot(e20) / (l12 * l20), -0.999f, 0.999f);

            float cot0 = cos0 / std::max(1e-4f, std::sqrt(1.0f - cos0 * cos0));
            float cot1 = cos1 / std::max(1e-4f, std::sqrt(1.0f - cos1 * cos1));
            float cot2 = cos2 / std::max(1e-4f, std::sqrt(1.0f - cos2 * cos2));

            float triArea = 0.5f * e01.cross(-e20).length();
            dualAreas[i0] += triArea / 3.0f;
            dualAreas[i1] += triArea / 3.0f;
            dualAreas[i2] += triArea / 3.0f;

            // Half-cotangent edge weights
            neighbors[i0].push_back({static_cast<int>(i1), 0.5f * cot2});
            neighbors[i0].push_back({static_cast<int>(i2), 0.5f * cot1});
            neighbors[i1].push_back({static_cast<int>(i2), 0.5f * cot0});
            neighbors[i1].push_back({static_cast<int>(i0), 0.5f * cot2});
            neighbors[i2].push_back({static_cast<int>(i0), 0.5f * cot1});
            neighbors[i2].push_back({static_cast<int>(i1), 0.5f * cot0});
        }

        // 2. Initialize morphogen concentrations: U = 1.0, V = 0.0 everywhere
        std::vector<float> U(n, 1.0f);
        std::vector<float> V(n, 0.0f);

        // Inject initial seed perturbations of morphogen V
        std::mt19937 rng(cfg.seed);
        std::uniform_int_distribution<size_t> vertDist(0, n - 1);
        for (int s = 0; s < cfg.seedPerturbations; ++s) {
            size_t centerVert = vertDist(rng);
            Vec3 centerPos = mesh.vertices[centerVert].position;
            float seedRadius = 0.45f;

            for (size_t i = 0; i < n; ++i) {
                float dist = (mesh.vertices[i].position - centerPos).length();
                if (dist < seedRadius) {
                    float factor = 1.0f - (dist / seedRadius);
                    U[i] = 0.5f;
                    V[i] = 0.25f * factor;
                }
            }
        }

        // 3. Forward Euler time-stepping PDE simulation
        std::vector<float> lapU(n, 0.0f);
        std::vector<float> lapV(n, 0.0f);

        for (int iter = 0; iter < cfg.iterations; ++iter) {
            // Compute discrete cotangent Laplacian for U and V
            for (size_t i = 0; i < n; ++i) {
                float area = std::max(1e-5f, dualAreas[i]);
                float sumWeightU = 0.0f;
                float sumWeightV = 0.0f;
                float totalW = 0.0f;

                for (const auto& nb : neighbors[i]) {
                    int j = nb.first;
                    float w = nb.second;
                    sumWeightU += w * (U[j] - U[i]);
                    sumWeightV += w * (V[j] - V[i]);
                    totalW += w;
                }

                lapU[i] = totalW > 1e-6f ? (sumWeightU / area) : 0.0f;
                lapV[i] = totalW > 1e-6f ? (sumWeightV / area) : 0.0f;
            }

            // Update concentrations via Gray-Scott reaction kinetics
            for (size_t i = 0; i < n; ++i) {
                float u = U[i];
                float v = V[i];
                float uvv = u * v * v;

                float du = cfg.diffusionU * lapU[i] - uvv + cfg.feedRate * (1.0f - u);
                float dv = cfg.diffusionV * lapV[i] + uvv - (cfg.feedRate + cfg.killRate) * v;

                U[i] = std::clamp(u + du * cfg.dt, 0.0f, 1.0f);
                V[i] = std::clamp(v + dv * cfg.dt, 0.0f, 1.0f);
            }
        }

        // 4. Map morphogen concentration V to vertex colors and normal displacement
        for (size_t i = 0; i < n; ++i) {
            float t = std::clamp(V[i] * 3.5f, 0.0f, 1.0f); // Normalize dynamic range
            mesh.vertices[i].color = math::lerp(cfg.lowColor, cfg.highColor, t);

            if (cfg.displacementScale > 1e-4f) {
                mesh.vertices[i].position += mesh.vertices[i].normal * (t * cfg.displacementScale);
            }
        }

        mesh.recomputeNormals();
        mesh.recomputeBounds();
    }
};

// ============================================================================
// 7. Topological Dual Mesh Operator (Tissue / Conway Dual)
// ============================================================================

class DualMeshOperator {
public:
    /**
     * Constructs the topological dual of an input triangle mesh:
     * - Every triangular face becomes a dual vertex at the face centroid.
     * - Every internal primal vertex becomes a dual polygon formed by its circulating face centroids.
     * Returns a watertight dual mesh ready for wireframing or parametric skins.
     */
    static ScratchboxMesh computeDualMesh(const ScratchboxMesh& input, const std::string& name = "DualMesh") {
        HalfEdgeMesh heMesh = HalfEdgeMesh::fromScratchboxMesh(input);
        ScratchboxMesh dual(name);
        dual.material = input.material;

        // 1. Dual Vertices: Face centroids of the primal mesh
        std::vector<Vec3> faceCentroids(heMesh.faces.size());
        for (size_t f = 0; f < heMesh.faces.size(); ++f) {
            const auto& fn = heMesh.faces[f];
            if (fn.deleted || fn.halfEdge < 0) continue;

            const auto& h0 = heMesh.halfEdges[fn.halfEdge];
            const auto& h1 = heMesh.halfEdges[h0.next];
            const auto& h2 = heMesh.halfEdges[h1.next];

            Vec3 p0 = heMesh.vertices[h0.origin].position;
            Vec3 p1 = heMesh.vertices[h1.origin].position;
            Vec3 p2 = heMesh.vertices[h2.origin].position;

            Vec3 centroid = (p0 + p1 + p2) * (1.0f / 3.0f);
            faceCentroids[f] = centroid;

            Vec3 normal = (p1 - p0).cross(p2 - p0).normalized();
            dual.addVertex(Vertex(centroid, normal, Vec2(0, 0), Vec4(0.8f, 0.82f, 0.85f, 1.0f)));
        }

        // 2. Dual Faces: Circulate around each non-boundary primal vertex to form an n-gon
        for (size_t v = 0; v < heMesh.vertices.size(); ++v) {
            if (heMesh.vertices[v].deleted) continue;
            if (heMesh.isBoundaryVertex(static_cast<int>(v))) continue;

            auto outgoing = heMesh.getVertexOutgoingHalfEdges(static_cast<int>(v));
            if (outgoing.size() < 3) continue;

            // Collect ordered sequence of dual vertex indices (face IDs)
            std::vector<uint32_t> ringDualIndices;
            ringDualIndices.reserve(outgoing.size());

            for (int he : outgoing) {
                int faceId = heMesh.halfEdges[he].face;
                if (faceId >= 0 && faceId < static_cast<int>(faceCentroids.size())) {
                    ringDualIndices.push_back(static_cast<uint32_t>(faceId));
                }
            }

            // Triangulate the convex dual n-gon fan-style
            if (ringDualIndices.size() >= 3) {
                for (size_t i = 1; i + 1 < ringDualIndices.size(); ++i) {
                    dual.addTriangle(ringDualIndices[0], ringDualIndices[i], ringDualIndices[i + 1]);
                }
            }
        }

        dual.recomputeNormals();
        dual.recomputeBounds();
        return dual;
    }

    /**
     * Generates an architectural strut/wireframe lattice from mesh edges.
     */
    static ScratchboxMesh generateWireframeLattice(
        const ScratchboxMesh& input,
        float strutRadius = 0.04f,
        const Vec4& strutColor = Vec4(0.25f, 0.28f, 0.32f, 1.0f)
    ) {
        ScratchboxMesh lattice("WireframeLattice");
        lattice.material = input.material;

        struct EdgePair {
            uint32_t u, v;
            bool operator<(const EdgePair& o) const {
                return u < o.u || (u == o.u && v < o.v);
            }
        };
        std::set<EdgePair> uniqueEdges;

        size_t triCount = input.indices.size() / 3;
        for (size_t t = 0; t < triCount; ++t) {
            uint32_t i0 = input.indices[t * 3 + 0];
            uint32_t i1 = input.indices[t * 3 + 1];
            uint32_t i2 = input.indices[t * 3 + 2];

            uniqueEdges.insert({std::min(i0, i1), std::max(i0, i1)});
            uniqueEdges.insert({std::min(i1, i2), std::max(i1, i2)});
            uniqueEdges.insert({std::min(i2, i0), std::max(i2, i0)});
        }

        for (const auto& edge : uniqueEdges) {
            Vec3 p0 = input.vertices[edge.u].position;
            Vec3 p1 = input.vertices[edge.v].position;
            Vec3 dir = p1 - p0;
            float len = dir.length();
            if (len < 1e-4f) continue;
            dir = dir / len;

            Vec3 up = std::abs(dir.y) < 0.99f ? Vec3(0, 1, 0) : Vec3(1, 0, 0);
            Vec3 side = dir.cross(up).normalized();
            up = side.cross(dir).normalized();

            int segments = 4; // Square/box strut cross-section for clean architectural look
            uint32_t baseIdx = static_cast<uint32_t>(lattice.vertices.size());

            for (int k = 0; k < segments; ++k) {
                float angle = (static_cast<float>(k) / static_cast<float>(segments)) * math::TWO_PI;
                Vec3 radial = side * std::cos(angle) + up * std::sin(angle);

                lattice.addVertex(Vertex(p0 + radial * strutRadius, radial, Vec2(0, 0), strutColor));
                lattice.addVertex(Vertex(p1 + radial * strutRadius, radial, Vec2(1, 1), strutColor));
            }

            for (int k = 0; k < segments; ++k) {
                int next = (k + 1) % segments;
                uint32_t b0 = baseIdx + k * 2;
                uint32_t t0 = baseIdx + k * 2 + 1;
                uint32_t b1 = baseIdx + next * 2;
                uint32_t t1 = baseIdx + next * 2 + 1;

                lattice.addTriangle(b0, t0, b1);
                lattice.addTriangle(b1, t0, t1);
            }
        }

        lattice.recomputeBounds();
        return lattice;
    }
};

} // namespace halfedge
} // namespace scratchbox

#endif // SCRATCHBOX_HALFEDGE_HPP

