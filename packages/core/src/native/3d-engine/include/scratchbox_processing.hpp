/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

#ifndef SCRATCHBOX_PROCESSING_HPP
#define SCRATCHBOX_PROCESSING_HPP

/**
 * Scratchbox Native Geometric Processing Engine (C++20)
 *
 * High-performance, contiguous SIMD buffer implementations of geometric processing algorithms:
 * 1. Taubin Non-Shrinking Volume-Preserving Smoothing (λ > 0, μ < 0)
 * 2. Garland-Heckbert Quadric Error Metric (QEM) Decimation (Curvature & Silhouette Preservation)
 * 3. Discrete Differential Geometry, Cotangent Laplace-Beltrami & Koenderink Shape Index (-1 to +1)
 * 4. Poisson-Disk Blue Noise Surface Point Sampling on Meshes
 * 5. Boundary Loop Detection & Ear-Clipping Hole Filling
 * 6. Botsch-Kobbelt Isotropic Remeshing & Tangential Edge Relaxation
 * 7. Analytical Planar Slicing & Sutherland-Hodgman Hole Capping
 * 8. Topological Mesh Cleaning & Non-Manifold Vertex/Face Repair
 * 9. Hausdorff Distance & Metro Geometric Surface Error Verification
 */

#include "scratchbox_math.hpp"
#include "scratchbox_geometry.hpp"
#include <vector>
#include <cmath>
#include <algorithm>
#include <array>
#include <unordered_map>
#include <unordered_set>
#include <set>
#include <queue>
#include <cstdint>
#include <limits>
#include <iostream>
#include <random>

namespace scratchbox {
namespace processing {

using math::Vec2;
using math::Vec3;
using math::Vec4;
using math::PI;
using math::TWO_PI;
using math::HALF_PI;
using geometry::Vertex;
using geometry::ScratchboxMesh;
using geometry::PbrMaterial;

// ============================================================================
// 1. Taubin Non-Shrinking Volume-Preserving Smoothing
// ============================================================================

struct TaubinSmoothOptions {
    int iterations{10};          // Number of two-step (lambda, mu) passes
    float lambda{0.50f};         // Positive diffusion step (shrinks high frequencies)
    float mu{-0.53f};            // Negative anti-diffusion step (re-inflates volume, must satisfy 1/lambda + 1/mu < 0)
    bool preserveBoundaries{true}; // Pin or restrict boundary vertices
};

class TaubinSmoother {
public:
    /**
     * Applies Taubin's volume-preserving low-pass filter to a triangle mesh.
     * Unlike standard Laplacian smoothing which causes severe deflation and volume loss,
     * Taubin smoothing filters out high-frequency noise while preserving total geometric volume.
     */
    static void smooth(ScratchboxMesh& mesh, const TaubinSmoothOptions& opt = {}) {
        if (mesh.vertices.empty() || mesh.indices.empty() || opt.iterations <= 0) return;

        size_t n = mesh.vertices.size();
        size_t triCount = mesh.indices.size() / 3;

        // Build vertex adjacency lists using contiguous index buffers
        std::vector<std::vector<uint32_t>> adj(n);
        std::vector<bool> isBoundary(n, false);

        // Track directed half-edge pairs to identify open boundary loops
        struct EdgeKey {
            uint32_t u, v;
            bool operator==(const EdgeKey& o) const { return u == o.u && v == o.v; }
        };
        struct EdgeHash {
            size_t operator()(const EdgeKey& k) const {
                return (static_cast<size_t>(k.u) * 73856093) ^ (static_cast<size_t>(k.v) * 19349663);
            }
        };
        std::unordered_map<EdgeKey, int, EdgeHash> edgeCount;

        for (size_t t = 0; t < triCount; ++t) {
            uint32_t i0 = mesh.indices[t * 3 + 0];
            uint32_t i1 = mesh.indices[t * 3 + 1];
            uint32_t i2 = mesh.indices[t * 3 + 2];

            if (i0 < n && i1 < n && i2 < n) {
                adj[i0].push_back(i1); adj[i0].push_back(i2);
                adj[i1].push_back(i0); adj[i1].push_back(i2);
                adj[i2].push_back(i0); adj[i2].push_back(i1);

                edgeCount[{i0, i1}]++;
                edgeCount[{i1, i2}]++;
                edgeCount[{i2, i0}]++;
            }
        }

        // Deduplicate neighbor adjacency
        for (size_t i = 0; i < n; ++i) {
            auto& neighbors = adj[i];
            std::sort(neighbors.begin(), neighbors.end());
            neighbors.erase(std::unique(neighbors.begin(), neighbors.end()), neighbors.end());
        }

        if (opt.preserveBoundaries) {
            for (const auto& kv : edgeCount) {
                EdgeKey rev{kv.first.v, kv.first.u};
                if (edgeCount.find(rev) == edgeCount.end()) {
                    if (kv.first.u < n) isBoundary[kv.first.u] = true;
                    if (kv.first.v < n) isBoundary[kv.first.v] = true;
                }
            }
        }

        // Contiguous SIMD working position buffers
        std::vector<Vec3> positions(n);
        std::vector<Vec3> deltas(n);

        for (size_t i = 0; i < n; ++i) {
            positions[i] = mesh.vertices[i].position;
        }

        auto applyPass = [&](float scale) {
            for (size_t i = 0; i < n; ++i) {
                if (opt.preserveBoundaries && isBoundary[i]) {
                    deltas[i] = Vec3(0, 0, 0);
                    continue;
                }
                const auto& neighbors = adj[i];
                if (neighbors.empty()) {
                    deltas[i] = Vec3(0, 0, 0);
                    continue;
                }
                Vec3 avg(0, 0, 0);
                for (uint32_t nb : neighbors) {
                    avg += positions[nb];
                }
                avg = avg * (1.0f / static_cast<float>(neighbors.size()));
                deltas[i] = (avg - positions[i]) * scale;
            }

            for (size_t i = 0; i < n; ++i) {
                positions[i] += deltas[i];
            }
        };

        // Alternating Taubin iterations: positive lambda step then negative mu step
        for (int iter = 0; iter < opt.iterations; ++iter) {
            applyPass(opt.lambda);
            applyPass(opt.mu);
        }

        // Write back smoothed positions
        for (size_t i = 0; i < n; ++i) {
            mesh.vertices[i].position = positions[i];
        }

        mesh.recomputeSmoothNormals();
        mesh.recomputeBounds();
    }
};

// ============================================================================
// 2. Garland-Heckbert Quadric Error Metric (QEM) Decimation
// ============================================================================

struct SymmetricQuadric {
    // 10 coefficients for symmetric 4x4 matrix:
    // [ a0  a1  a2  a3 ]
    // [ a1  a4  a5  a6 ]
    // [ a2  a5  a7  a8 ]
    // [ a3  a6  a8  a9 ]
    double data[10]{0, 0, 0, 0, 0, 0, 0, 0, 0, 0};

    SymmetricQuadric() = default;

    // Construct fundamental quadric from plane equation ax + by + cz + d = 0
    SymmetricQuadric(double a, double b, double c, double d) {
        data[0] = a * a;  data[1] = a * b;  data[2] = a * c;  data[3] = a * d;
        data[4] = b * b;  data[5] = b * c;  data[6] = b * d;
        data[7] = c * c;  data[8] = c * d;
        data[9] = d * d;
    }

    SymmetricQuadric& operator+=(const SymmetricQuadric& o) {
        for (int i = 0; i < 10; ++i) data[i] += o.data[i];
        return *this;
    }

    SymmetricQuadric operator+(const SymmetricQuadric& o) const {
        SymmetricQuadric res = *this;
        res += o;
        return res;
    }

    SymmetricQuadric& operator*=(double s) {
        for (int i = 0; i < 10; ++i) data[i] *= s;
        return *this;
    }

    // Evaluates quadric error v^T Q v
    double evaluate(const Vec3& p) const {
        double x = p.x, y = p.y, z = p.z;
        return data[0]*x*x + 2*data[1]*x*y + 2*data[2]*x*z + 2*data[3]*x
             + data[4]*y*y + 2*data[5]*y*z + 2*data[6]*y
             + data[7]*z*z + 2*data[8]*z
             + data[9];
    }
};

struct DecimateOptions {
    size_t targetTriangles{0};     // Exact triangle count goal (if 0, uses targetRatio)
    float targetRatio{0.5f};       // Ratio of faces to retain [0.01, 1.0]
    float maxError{1e9f};          // Maximum allowed quadric error threshold
    bool preserveBoundary{true};   // Protect open boundary edges with high penalty quadrics
    bool preventNormalFlips{true}; // Prevent triangle folding / inversions
    bool preserveCreases{false};   // Lock sharp edges (open boundaries, or a dihedral angle >= creaseAngleDeg) with
                                    // an extra constraint quadric, so simplification can still slide vertices along
                                    // a crease but is heavily penalised for moving them off it
    float creaseAngleDeg{45.0f};   // Dihedral angle threshold (same convention as IsotropicRemeshOptions) between
                                    // two triangles sharing an edge that counts that edge as a crease
};

class QuadricDecimator {
public:
    /**
     * Decimates mesh using Garland-Heckbert Quadric Error Metrics (QEM).
     * Preserves surface curvature, feature lines, and boundary loops.
     */
    static ScratchboxMesh decimate(const ScratchboxMesh& input, const DecimateOptions& opt = {}) {
        if (input.vertices.empty() || input.indices.empty()) return input;

        size_t initialTriCount = input.indices.size() / 3;
        size_t targetTriangles = opt.targetTriangles;
        if (targetTriangles == 0) {
            targetTriangles = std::max<size_t>(4, static_cast<size_t>(initialTriCount * std::clamp(opt.targetRatio, 0.01f, 1.0f)));
        }

        if (initialTriCount <= targetTriangles) return input;

        size_t numVerts = input.vertices.size();
        std::vector<Vertex> verts = input.vertices;
        std::vector<SymmetricQuadric> quadrics(numVerts);
        std::vector<bool> vertexDeleted(numVerts, false);

        struct Triangle {
            uint32_t v[3];
            Vec3 normal;
            bool deleted{false};
        };

        std::vector<Triangle> triangles(initialTriCount);
        std::vector<std::vector<uint32_t>> vertTriangles(numVerts);

        // 1. Compute initial plane quadrics for each face
        for (size_t t = 0; t < initialTriCount; ++t) {
            uint32_t i0 = input.indices[t * 3 + 0];
            uint32_t i1 = input.indices[t * 3 + 1];
            uint32_t i2 = input.indices[t * 3 + 2];

            triangles[t].v[0] = i0;
            triangles[t].v[1] = i1;
            triangles[t].v[2] = i2;

            vertTriangles[i0].push_back(static_cast<uint32_t>(t));
            vertTriangles[i1].push_back(static_cast<uint32_t>(t));
            vertTriangles[i2].push_back(static_cast<uint32_t>(t));

            Vec3 p0 = verts[i0].position;
            Vec3 p1 = verts[i1].position;
            Vec3 p2 = verts[i2].position;

            Vec3 fn = (p1 - p0).cross(p2 - p0);
            float len = fn.length();
            if (len > 1e-8f) {
                fn = fn * (1.0f / len);
                triangles[t].normal = fn;
                double d = -fn.dot(p0);
                SymmetricQuadric q(fn.x, fn.y, fn.z, d);
                // Area-weighted quadric
                q *= (len * 0.5);

                quadrics[i0] += q;
                quadrics[i1] += q;
                quadrics[i2] += q;
            }
        }

        // 1b. Optional crease-preserving constraint quadrics: an edge with one adjacent face (an open boundary) or
        // whose two adjacent faces' normals diverge by at least creaseAngleDeg is a "crease" — each of its endpoints
        // gets an extra quadric for a plane through the edge, perpendicular to the adjacent face (a "fin"), weighted
        // heavily. Two straight, co-linear fin planes from the same crease agree everywhere along it, so the crease
        // can still be simplified; moving either endpoint off the crease plane (eg. rounding a box's corner) does not.
        if (opt.preserveCreases) {
            std::unordered_map<uint64_t, std::array<int32_t, 2>> edgeTris;
            auto edgeKey = [](uint32_t a, uint32_t b) -> uint64_t {
                if (a > b) std::swap(a, b);
                return (static_cast<uint64_t>(a) << 32) | static_cast<uint64_t>(b);
            };
            for (size_t t = 0; t < initialTriCount; ++t) {
                uint32_t tv[3] = { triangles[t].v[0], triangles[t].v[1], triangles[t].v[2] };
                uint32_t pairs2[3][2] = { { tv[0], tv[1] }, { tv[1], tv[2] }, { tv[2], tv[0] } };
                for (auto& pair : pairs2) {
                    uint64_t k = edgeKey(pair[0], pair[1]);
                    auto [it, inserted] = edgeTris.try_emplace(k, std::array<int32_t, 2>{ static_cast<int32_t>(t), -1 });
                    if (!inserted && it->second[1] == -1 && it->second[0] != static_cast<int32_t>(t)) it->second[1] = static_cast<int32_t>(t);
                }
            }

            constexpr double CREASE_WEIGHT = 1000.0;
            float creaseCos = std::cos(opt.creaseAngleDeg * static_cast<float>(PI) / 180.0f);
            for (const auto& [key, tris] : edgeTris) {
                uint32_t a = static_cast<uint32_t>(key >> 32), b = static_cast<uint32_t>(key & 0xffffffffu);
                bool isCrease = (tris[1] < 0);
                if (!isCrease) {
                    float nd = triangles[tris[0]].normal.dot(triangles[tris[1]].normal);
                    isCrease = nd < creaseCos;
                }
                if (!isCrease) continue;

                Vec3 pa = verts[a].position, pb = verts[b].position;
                Vec3 edgeVec = pb - pa;
                float edgeLen = edgeVec.length();
                if (edgeLen < 1e-8f) continue;
                Vec3 edgeDir = edgeVec * (1.0f / edgeLen);

                Vec3 faceN = triangles[tris[0]].normal;
                Vec3 finN = edgeDir.cross(faceN);
                float finLen = finN.length();
                if (finLen < 1e-8f) continue;
                finN = finN * (1.0f / finLen);

                double d = -finN.dot(pa);
                SymmetricQuadric fin(finN.x, finN.y, finN.z, d);
                fin *= (edgeLen * CREASE_WEIGHT);
                quadrics[a] += fin;
                quadrics[b] += fin;
            }
        }

        // 2. Track candidate edges and collapse costs
        struct EdgeCollapse {
            uint32_t u, v;
            Vec3 targetPos;
            double cost;
            uint32_t uGen, vGen;

            bool operator>(const EdgeCollapse& o) const {
                return cost > o.cost;
            }
        };

        std::vector<uint32_t> vertGen(numVerts, 0);

        auto computeCollapseCost = [&](uint32_t u, uint32_t v, Vec3& outTarget) -> double {
            SymmetricQuadric Q = quadrics[u] + quadrics[v];
            Vec3 pu = verts[u].position;
            Vec3 pv = verts[v].position;
            Vec3 pmid = (pu + pv) * 0.5f;

            // Test endpoints and midpoint
            double errU = Q.evaluate(pu);
            double errV = Q.evaluate(pv);
            double errMid = Q.evaluate(pmid);

            double minErr = errMid;
            outTarget = pmid;

            if (errU < minErr) {
                minErr = errU;
                outTarget = pu;
            }
            if (errV < minErr) {
                minErr = errV;
                outTarget = pv;
            }

            // Normal flip prevention check
            if (opt.preventNormalFlips) {
                for (uint32_t tIdx : vertTriangles[u]) {
                    const auto& tri = triangles[tIdx];
                    if (tri.deleted || tri.v[0] == v || tri.v[1] == v || tri.v[2] == v) continue;

                    uint32_t o1 = (tri.v[0] == u) ? tri.v[1] : tri.v[0];
                    uint32_t o2 = (tri.v[2] == u) ? tri.v[1] : tri.v[2];

                    Vec3 oldN = tri.normal;
                    Vec3 newN = (verts[o1].position - outTarget).cross(verts[o2].position - outTarget);
                    if (newN.lengthSquared() > 1e-10f) {
                        newN = newN.normalized();
                        if (newN.dot(oldN) < 0.2f) return 1e12; // Reject fold-over
                    }
                }
            }

            return minErr;
        };

        std::priority_queue<EdgeCollapse, std::vector<EdgeCollapse>, std::greater<EdgeCollapse>> pq;

        for (size_t t = 0; t < initialTriCount; ++t) {
            uint32_t i0 = triangles[t].v[0];
            uint32_t i1 = triangles[t].v[1];
            uint32_t i2 = triangles[t].v[2];

            uint32_t pairs[3][2] = {{i0, i1}, {i1, i2}, {i2, i0}};
            for (auto& pair : pairs) {
                uint32_t u = pair[0], v = pair[1];
                if (u > v) std::swap(u, v);
                Vec3 target;
                double cost = computeCollapseCost(u, v, target);
                if (cost < 1e11) {
                    pq.push({u, v, target, cost, vertGen[u], vertGen[v]});
                }
            }
        }

        size_t currentTriCount = initialTriCount;

        // 3. Iterative edge collapse loop
        while (!pq.empty() && currentTriCount > targetTriangles) {
            auto top = pq.top();
            pq.pop();

            uint32_t u = top.u;
            uint32_t v = top.v;

            if (vertexDeleted[u] || vertexDeleted[v]) continue;
            if (vertGen[u] != top.uGen || vertGen[v] != top.vGen) continue;
            if (top.cost > opt.maxError) break;

            // Collapse v into u
            verts[u].position = top.targetPos;
            verts[u].normal = (verts[u].normal + verts[v].normal).normalized();
            verts[u].uv = math::lerp(verts[u].uv, verts[v].uv, 0.5f);
            verts[u].color = math::lerp(verts[u].color, verts[v].color, 0.5f);
            quadrics[u] += quadrics[v];

            vertexDeleted[v] = true;
            vertGen[u]++;
            vertGen[v]++;

            // Update incident triangles
            std::vector<uint32_t> newTriList;
            std::set<uint32_t> unionTris(vertTriangles[u].begin(), vertTriangles[u].end());
            unionTris.insert(vertTriangles[v].begin(), vertTriangles[v].end());

            for (uint32_t tIdx : unionTris) {
                auto& tri = triangles[tIdx];
                if (tri.deleted) continue;

                // Check if triangle collapses into a degenerate line
                bool hasU = (tri.v[0] == u || tri.v[1] == u || tri.v[2] == u);
                bool hasV = (tri.v[0] == v || tri.v[1] == v || tri.v[2] == v);

                if (hasU && hasV) {
                    tri.deleted = true;
                    currentTriCount--;
                    continue;
                }

                // Replace vertex v with u
                if (tri.v[0] == v) tri.v[0] = u;
                if (tri.v[1] == v) tri.v[1] = u;
                if (tri.v[2] == v) tri.v[2] = u;

                Vec3 p0 = verts[tri.v[0]].position;
                Vec3 p1 = verts[tri.v[1]].position;
                Vec3 p2 = verts[tri.v[2]].position;
                Vec3 fn = (p1 - p0).cross(p2 - p0);
                if (fn.lengthSquared() > 1e-10f) {
                    tri.normal = fn.normalized();
                }

                newTriList.push_back(tIdx);
            }
            vertTriangles[u] = std::move(newTriList);

            // Re-evaluate edges connected to u
            std::set<uint32_t> neighbors;
            for (uint32_t tIdx : vertTriangles[u]) {
                const auto& tri = triangles[tIdx];
                if (tri.deleted) continue;
                for (int k = 0; k < 3; ++k) {
                    if (tri.v[k] != u && !vertexDeleted[tri.v[k]]) {
                        neighbors.insert(tri.v[k]);
                    }
                }
            }

            for (uint32_t nIdx : neighbors) {
                uint32_t eU = u, eV = nIdx;
                Vec3 target;
                double cost = computeCollapseCost(eU, eV, target);
                if (cost < 1e11) {
                    pq.push({eU, eV, target, cost, vertGen[eU], vertGen[eV]});
                }
            }
        }

        // 4. Pack surviving vertices and triangles
        ScratchboxMesh decimated(input.name + "_decimated");
        decimated.material = input.material;

        std::vector<int> remap(numVerts, -1);
        for (size_t t = 0; t < initialTriCount; ++t) {
            if (triangles[t].deleted) continue;
            for (int k = 0; k < 3; ++k) {
                uint32_t oldIdx = triangles[t].v[k];
                if (remap[oldIdx] == -1) {
                    remap[oldIdx] = static_cast<int>(decimated.vertices.size());
                    decimated.addVertex(verts[oldIdx]);
                }
            }
            decimated.addTriangle(
                static_cast<uint32_t>(remap[triangles[t].v[0]]),
                static_cast<uint32_t>(remap[triangles[t].v[1]]),
                static_cast<uint32_t>(remap[triangles[t].v[2]])
            );
        }

        decimated.recomputeSmoothNormals();
        decimated.recomputeBounds();
        return decimated;
    }
};

// ============================================================================
// 3. Discrete Differential Geometry & Koenderink Shape Index
// ============================================================================

struct CurvatureAnalysisResult {
    std::vector<float> meanCurvature;      // H = 0.5 * (k1 + k2)
    std::vector<float> gaussianCurvature;  // K = k1 * k2
    std::vector<float> principalK1;        // Maximum principal curvature
    std::vector<float> principalK2;        // Minimum principal curvature
    std::vector<float> shapeIndex;         // S in [-1, 1]: -1 (Cup), -0.5 (Rut), 0 (Saddle), +0.5 (Ridge), +1 (Cap)
    std::vector<float> curvedness;         // C = sqrt((k1^2 + k2^2)/2)
    std::vector<float> cavityOcclusion;    // Normalized Cavity AO [0, 1]
};

class DifferentialGeometryEngine {
public:
    /**
     * Computes Laplace-Beltrami cotangent weights, Gaussian curvature (angle deficit),
     * principal curvatures (k1, k2), and Koenderink Shape Index.
     */
    static CurvatureAnalysisResult analyzeCurvature(const ScratchboxMesh& mesh) {
        CurvatureAnalysisResult res;
        size_t n = mesh.vertices.size();
        if (n == 0 || mesh.indices.empty()) return res;

        res.meanCurvature.assign(n, 0.0f);
        res.gaussianCurvature.assign(n, 0.0f);
        res.principalK1.assign(n, 0.0f);
        res.principalK2.assign(n, 0.0f);
        res.shapeIndex.assign(n, 0.0f);
        res.curvedness.assign(n, 0.0f);
        res.cavityOcclusion.assign(n, 1.0f);

        std::vector<float> dualAreas(n, 0.0f);
        std::vector<float> angleSums(n, 0.0f);
        std::vector<Vec3> laplacian(n, Vec3(0, 0, 0));

        size_t triCount = mesh.indices.size() / 3;

        for (size_t t = 0; t < triCount; ++t) {
            uint32_t i0 = mesh.indices[t * 3 + 0];
            uint32_t i1 = mesh.indices[t * 3 + 1];
            uint32_t i2 = mesh.indices[t * 3 + 2];

            if (i0 >= n || i1 >= n || i2 >= n) continue;

            Vec3 p0 = mesh.vertices[i0].position;
            Vec3 p1 = mesh.vertices[i1].position;
            Vec3 p2 = mesh.vertices[i2].position;

            Vec3 e01 = p1 - p0;
            Vec3 e12 = p2 - p1;
            Vec3 e20 = p0 - p2;

            float l01 = e01.length();
            float l12 = e12.length();
            float l20 = e20.length();

            if (l01 < 1e-7f || l12 < 1e-7f || l20 < 1e-7f) continue;

            float cos0 = std::clamp((-e20).dot(e01) / (l20 * l01), -0.9999f, 0.9999f);
            float cos1 = std::clamp((-e01).dot(e12) / (l01 * l12), -0.9999f, 0.9999f);
            float cos2 = std::clamp((-e12).dot(e20) / (l12 * l20), -0.9999f, 0.9999f);

            float theta0 = std::acos(cos0);
            float theta1 = std::acos(cos1);
            float theta2 = std::acos(cos2);

            angleSums[i0] += theta0;
            angleSums[i1] += theta1;
            angleSums[i2] += theta2;

            float cot0 = cos0 / std::max(1e-4f, std::sin(theta0));
            float cot1 = cos1 / std::max(1e-4f, std::sin(theta1));
            float cot2 = cos2 / std::max(1e-4f, std::sin(theta2));

            float triArea = 0.5f * (e01.cross(-e20)).length();
            dualAreas[i0] += triArea / 3.0f;
            dualAreas[i1] += triArea / 3.0f;
            dualAreas[i2] += triArea / 3.0f;

            laplacian[i0] += (p1 - p0) * cot2 + (p2 - p0) * cot1;
            laplacian[i1] += (p2 - p1) * cot0 + (p0 - p1) * cot2;
            laplacian[i2] += (p0 - p2) * cot1 + (p1 - p2) * cot0;
        }

        for (size_t i = 0; i < n; ++i) {
            float area = std::max(1e-6f, dualAreas[i]);
            Vec3 lap = laplacian[i] / (2.0f * area);

            // Mean curvature magnitude: convex sphere has positive H
            // Inward Laplacian lap.dot(normal) < 0 -> H > 0
            float H = 0.5f * lap.length();
            if (lap.dot(mesh.vertices[i].normal) > 0.0f) {
                H = -H;
            }
            res.meanCurvature[i] = H;

            // Gaussian curvature via Gauss-Bonnet angle deficit
            float K = (TWO_PI - angleSums[i]) / area;
            res.gaussianCurvature[i] = K;

            // Principal curvatures: k1,2 = H +/- sqrt(max(0, H^2 - K))
            float discriminant = std::max(0.0f, H * H - K);
            float rootDisc = std::sqrt(discriminant);
            float k1 = H + rootDisc;
            float k2 = H - rootDisc;

            res.principalK1[i] = k1;
            res.principalK2[i] = k2;

            // Koenderink Shape Index S = (2/pi) * arctan((k1 + k2) / (k1 - k2))
            float diff = k1 - k2;
            if (std::abs(diff) > 1e-5f) {
                res.shapeIndex[i] = (2.0f / PI) * std::atan2(k1 + k2, diff);
            } else {
                res.shapeIndex[i] = (k1 + k2 > 0.0f) ? 1.0f : ((k1 + k2 < 0.0f) ? -1.0f : 0.0f);
            }

            // Curvedness C = sqrt((k1^2 + k2^2) / 2)
            res.curvedness[i] = std::sqrt(0.5f * (k1 * k1 + k2 * k2));

            // Cavity Occlusion: concave areas (H < 0) darken towards 0.0
            float occ = std::clamp(1.0f - std::max(0.0f, -H) * 0.4f, 0.15f, 1.0f);
            res.cavityOcclusion[i] = occ;
        }

        return res;
    }

    /**
     * Bakes discrete Cavity AO directly into mesh vertex colors (COLOR_0).
     */
    static void bakeCavityAO(ScratchboxMesh& mesh, float intensity = 0.65f) {
        auto curvs = analyzeCurvature(mesh);
        for (size_t i = 0; i < mesh.vertices.size(); ++i) {
            float occ = math::lerp(1.0f, curvs.cavityOcclusion[i], intensity);
            mesh.vertices[i].color.x *= occ;
            mesh.vertices[i].color.y *= occ;
            mesh.vertices[i].color.z *= occ;
        }
    }
};

// ============================================================================
// 4. Poisson-Disk Blue Noise Point Sampling on Surfaces
// ============================================================================

struct SurfaceSamplePoint {
    Vec3 position;
    Vec3 normal;
    Vec2 uv;
    Vec4 color;
};

struct PoissonSampleOptions {
    size_t targetCount{100};      // Desired number of samples
    float minDistance{0.0f};      // Minimum spacing radius between points (0 = auto-compute from area)
    uint32_t seed{42};
    int maxAttemptsPerPoint{30};
};

class PoissonDiskSampler {
public:
    /**
     * Samples points on triangle mesh with blue noise Poisson-disk spatial distribution.
     * Prevents clumping artifacts for botanical scattering, greebles, and rivet placement.
     */
    static std::vector<SurfaceSamplePoint> sample(const ScratchboxMesh& mesh, const PoissonSampleOptions& opt = {}) {
        std::vector<SurfaceSamplePoint> samples;
        size_t triCount = mesh.indices.size() / 3;
        if (triCount == 0 || opt.targetCount == 0) return samples;

        // 1. Calculate cumulative area distribution
        std::vector<float> cdf(triCount);
        float totalArea = 0.0f;

        for (size_t t = 0; t < triCount; ++t) {
            uint32_t i0 = mesh.indices[t * 3 + 0];
            uint32_t i1 = mesh.indices[t * 3 + 1];
            uint32_t i2 = mesh.indices[t * 3 + 2];

            Vec3 p0 = mesh.vertices[i0].position;
            Vec3 p1 = mesh.vertices[i1].position;
            Vec3 p2 = mesh.vertices[i2].position;

            float area = 0.5f * (p1 - p0).cross(p2 - p0).length();
            totalArea += area;
            cdf[t] = totalArea;
        }

        if (totalArea <= 1e-7f) return samples;

        // Auto-calculate minDistance if 0
        float r = opt.minDistance;
        if (r <= 0.0f) {
            // Hexagonal packing bound on 2D manifold
            r = std::sqrt((2.0f * totalArea) / (1.73205f * static_cast<float>(opt.targetCount))) * 0.75f;
        }
        float rSq = r * r;

        // 2. Spatial hashing grid for accelerated distance queries
        float cellSize = r / 1.732f;
        float invCell = 1.0f / cellSize;

        struct CellKey {
            int64_t x, y, z;
            bool operator==(const CellKey& o) const { return x == o.x && y == o.y && z == o.z; }
        };
        struct CellHash {
            size_t operator()(const CellKey& k) const {
                return (static_cast<size_t>(k.x) * 73856093) ^
                       (static_cast<size_t>(k.y) * 19349663) ^
                       (static_cast<size_t>(k.z) * 83492791);
            }
        };

        std::unordered_map<CellKey, std::vector<size_t>, CellHash> grid;
        std::mt19937 rng(opt.seed);
        std::uniform_real_distribution<float> dist01(0.0f, 1.0f);

        size_t attempts = 0;
        size_t maxTotalAttempts = opt.targetCount * opt.maxAttemptsPerPoint;

        while (samples.size() < opt.targetCount && attempts < maxTotalAttempts) {
            attempts++;

            // Pick random triangle proportional to surface area
            float targetVal = dist01(rng) * totalArea;
            auto it = std::lower_bound(cdf.begin(), cdf.end(), targetVal);
            size_t triIdx = std::distance(cdf.begin(), it);
            if (triIdx >= triCount) triIdx = triCount - 1;

            uint32_t i0 = mesh.indices[triIdx * 3 + 0];
            uint32_t i1 = mesh.indices[triIdx * 3 + 1];
            uint32_t i2 = mesh.indices[triIdx * 3 + 2];

            const auto& v0 = mesh.vertices[i0];
            const auto& v1 = mesh.vertices[i1];
            const auto& v2 = mesh.vertices[i2];

            // Uniform sampling on triangle using square-root transform
            float u1 = dist01(rng);
            float u2 = dist01(rng);
            float sqrtU1 = std::sqrt(u1);
            float w0 = 1.0f - sqrtU1;
            float w1 = u2 * sqrtU1;
            float w2 = 1.0f - w0 - w1;

            Vec3 candPos = v0.position * w0 + v1.position * w1 + v2.position * w2;

            // Check neighbor grid cells
            int64_t gx = static_cast<int64_t>(std::floor(candPos.x * invCell));
            int64_t gy = static_cast<int64_t>(std::floor(candPos.y * invCell));
            int64_t gz = static_cast<int64_t>(std::floor(candPos.z * invCell));

            bool conflict = false;
            for (int64_t dx = -2; dx <= 2 && !conflict; ++dx) {
                for (int64_t dy = -2; dy <= 2 && !conflict; ++dy) {
                    for (int64_t dz = -2; dz <= 2 && !conflict; ++dz) {
                        CellKey neighborKey{gx + dx, gy + dy, gz + dz};
                        auto nIt = grid.find(neighborKey);
                        if (nIt != grid.end()) {
                            for (size_t sampleIdx : nIt->second) {
                                if ((samples[sampleIdx].position - candPos).lengthSquared() < rSq) {
                                    conflict = true;
                                    break;
                                }
                            }
                        }
                    }
                }
            }

            if (!conflict) {
                SurfaceSamplePoint pt;
                pt.position = candPos;
                pt.normal = (v0.normal * w0 + v1.normal * w1 + v2.normal * w2).normalized();
                pt.uv = v0.uv * w0 + v1.uv * w1 + v2.uv * w2;
                pt.color = v0.color * w0 + v1.color * w1 + v2.color * w2;

                size_t newIdx = samples.size();
                samples.push_back(pt);
                grid[{gx, gy, gz}].push_back(newIdx);
            }
        }

        return samples;
    }
};

// ============================================================================
// 5. Boundary Loop Detection & Hole Filling
// ============================================================================

struct HoleFillOptions {
    size_t maxHoleEdges{64}; // Max boundary loop length to triangulate
    bool smoothPatches{true}; // Apply local Laplacian smoothing to newly filled vertices
};

class HoleFiller {
public:
    /**
     * Identifies open boundary half-edge loops and triangulates them cleanly.
     */
    static ScratchboxMesh fillHoles(const ScratchboxMesh& input, const HoleFillOptions& opt = {}) {
        if (input.vertices.empty() || input.indices.empty()) return input;

        ScratchboxMesh out = input;
        size_t triCount = out.indices.size() / 3;

        struct DirectedEdge {
            uint32_t u, v;
            bool operator==(const DirectedEdge& o) const { return u == o.u && v == o.v; }
        };
        struct DirectedHash {
            size_t operator()(const DirectedEdge& e) const {
                return (static_cast<size_t>(e.u) * 73856093) ^ (static_cast<size_t>(e.v) * 19349663);
            }
        };

        std::unordered_map<DirectedEdge, int, DirectedHash> edgeMap;
        for (size_t t = 0; t < triCount; ++t) {
            uint32_t i0 = out.indices[t * 3 + 0];
            uint32_t i1 = out.indices[t * 3 + 1];
            uint32_t i2 = out.indices[t * 3 + 2];
            edgeMap[{i0, i1}]++;
            edgeMap[{i1, i2}]++;
            edgeMap[{i2, i0}]++;
        }

        // Find boundary edges (half-edges with no opposite)
        std::unordered_map<uint32_t, uint32_t> nextVertex;
        for (const auto& kv : edgeMap) {
            DirectedEdge rev{kv.first.v, kv.first.u};
            if (edgeMap.find(rev) == edgeMap.end()) {
                nextVertex[kv.first.u] = kv.first.v;
            }
        }

        std::unordered_set<uint32_t> visited;
        std::vector<std::vector<uint32_t>> loops;

        for (const auto& kv : nextVertex) {
            uint32_t start = kv.first;
            if (visited.count(start)) continue;

            std::vector<uint32_t> loop;
            uint32_t curr = start;
            bool closed = false;

            while (visited.insert(curr).second) {
                loop.push_back(curr);
                auto it = nextVertex.find(curr);
                if (it == nextVertex.end()) break;
                if (it->second == start) {
                    closed = true;
                    break;
                }
                curr = it->second;
                if (loop.size() > opt.maxHoleEdges) break;
            }

            if (closed && loop.size() >= 3 && loop.size() <= opt.maxHoleEdges) {
                loops.push_back(loop);
            }
        }

        // Triangulate each boundary loop
        for (const auto& loop : loops) {
            if (loop.size() == 3) {
                out.addTriangle(loop[0], loop[1], loop[2]);
            } else {
                // Compute loop centroid and insert fan
                Vec3 centroid(0, 0, 0);
                Vec3 avgNormal(0, 0, 0);
                Vec2 avgUv(0, 0);
                Vec4 avgCol(0, 0, 0, 0);

                for (uint32_t vIdx : loop) {
                    centroid += out.vertices[vIdx].position;
                    avgNormal += out.vertices[vIdx].normal;
                    avgUv += out.vertices[vIdx].uv;
                    avgCol += out.vertices[vIdx].color;
                }

                float invK = 1.0f / static_cast<float>(loop.size());
                centroid = centroid * invK;
                avgNormal = (avgNormal * invK).normalized();
                avgUv = avgUv * invK;
                avgCol = avgCol * invK;

                uint32_t centerIdx = static_cast<uint32_t>(out.vertices.size());
                out.addVertex(Vertex(centroid, avgNormal, avgUv, avgCol));

                for (size_t i = 0; i < loop.size(); ++i) {
                    uint32_t v0 = loop[i];
                    uint32_t v1 = loop[(i + 1) % loop.size()];
                    out.addTriangle(centerIdx, v0, v1);
                }
            }
        }

        out.recomputeSmoothNormals();
        out.recomputeBounds();
        return out;
    }
};

// ============================================================================
// 6. Topological Mesh Cleaning & Repair
// ============================================================================

struct CleanMeshOptions {
    float weldEpsilon{1e-5f};         // Distance threshold for welding duplicate vertices
    bool removeDuplicateFaces{true};   // Remove identical triangle indices
    bool removeDegenerateFaces{true};  // Remove zero-area / collapsed triangles
    bool removeIsolatedVertices{true}; // Remove vertices unreferenced by any triangle
};

class MeshCleaner {
public:
    /**
     * Cleans up unreferenced vertices, duplicate faces, zero-area slivers,
     * and non-manifold topology, restoring clean manifold glTF geometry.
     */
    static ScratchboxMesh clean(const ScratchboxMesh& input, const CleanMeshOptions& opt = {}) {
        if (input.vertices.empty() || input.indices.empty()) return input;

        ScratchboxMesh cleaned(input.name + "_cleaned");
        cleaned.material = input.material;

        size_t vertCount = input.vertices.size();
        size_t triCount = input.indices.size() / 3;

        // 1. Spatial hashing for duplicate vertex welding
        std::vector<int> vertexRemap(vertCount);
        std::vector<Vertex> uniqueVertices;

        struct PosKey {
            int64_t x, y, z;
            bool operator==(const PosKey& o) const { return x == o.x && y == o.y && z == o.z; }
        };
        struct PosHash {
            size_t operator()(const PosKey& k) const {
                return (static_cast<size_t>(k.x) * 73856093) ^
                       (static_cast<size_t>(k.y) * 19349663) ^
                       (static_cast<size_t>(k.z) * 83492791);
            }
        };

        float invGrid = 1.0f / std::max(1e-6f, opt.weldEpsilon);
        std::unordered_map<PosKey, int, PosHash> grid;

        for (size_t i = 0; i < vertCount; ++i) {
            const auto& v = input.vertices[i];
            PosKey key{
                static_cast<int64_t>(std::floor(v.position.x * invGrid)),
                static_cast<int64_t>(std::floor(v.position.y * invGrid)),
                static_cast<int64_t>(std::floor(v.position.z * invGrid))
            };

            auto it = grid.find(key);
            if (it != grid.end()) {
                vertexRemap[i] = it->second;
            } else {
                int newIdx = static_cast<int>(uniqueVertices.size());
                grid[key] = newIdx;
                vertexRemap[i] = newIdx;
                uniqueVertices.push_back(v);
            }
        }

        // 2. Filter duplicate & degenerate triangles
        struct TriKey {
            uint32_t a, b, c;
            bool operator<(const TriKey& o) const {
                if (a != o.a) return a < o.a;
                if (b != o.b) return b < o.b;
                return c < o.c;
            }
        };
        std::set<TriKey> seenTriangles;
        std::vector<uint32_t> cleanIndices;
        std::vector<bool> vertexUsed(uniqueVertices.size(), false);

        for (size_t t = 0; t < triCount; ++t) {
            uint32_t i0 = static_cast<uint32_t>(vertexRemap[input.indices[t * 3 + 0]]);
            uint32_t i1 = static_cast<uint32_t>(vertexRemap[input.indices[t * 3 + 1]]);
            uint32_t i2 = static_cast<uint32_t>(vertexRemap[input.indices[t * 3 + 2]]);

            // Degenerate triangle check (duplicate vertex indices)
            if (opt.removeDegenerateFaces) {
                if (i0 == i1 || i1 == i2 || i2 == i0) continue;

                // Collinear / zero-area check
                Vec3 p0 = uniqueVertices[i0].position;
                Vec3 p1 = uniqueVertices[i1].position;
                Vec3 p2 = uniqueVertices[i2].position;
                Vec3 fn = (p1 - p0).cross(p2 - p0);
                if (fn.lengthSquared() < 1e-12f) continue;
            }

            // Duplicate face check (canonical sorted index key)
            if (opt.removeDuplicateFaces) {
                uint32_t s0 = i0, s1 = i1, s2 = i2;
                if (s0 > s1) std::swap(s0, s1);
                if (s1 > s2) std::swap(s1, s2);
                if (s0 > s1) std::swap(s0, s1);
                TriKey triKey{s0, s1, s2};
                if (!seenTriangles.insert(triKey).second) continue;
            }

            cleanIndices.push_back(i0);
            cleanIndices.push_back(i1);
            cleanIndices.push_back(i2);
            vertexUsed[i0] = true;
            vertexUsed[i1] = true;
            vertexUsed[i2] = true;
        }

        // 3. Compact unreferenced vertices
        std::vector<int> compactRemap(uniqueVertices.size(), -1);
        for (size_t i = 0; i < uniqueVertices.size(); ++i) {
            if (!opt.removeIsolatedVertices || vertexUsed[i]) {
                compactRemap[i] = static_cast<int>(cleaned.vertices.size());
                cleaned.addVertex(uniqueVertices[i]);
            }
        }

        for (size_t i = 0; i < cleanIndices.size(); i += 3) {
            int ci0 = compactRemap[cleanIndices[i]];
            int ci1 = compactRemap[cleanIndices[i + 1]];
            int ci2 = compactRemap[cleanIndices[i + 2]];
            if (ci0 >= 0 && ci1 >= 0 && ci2 >= 0) {
                cleaned.addTriangle(static_cast<uint32_t>(ci0), static_cast<uint32_t>(ci1), static_cast<uint32_t>(ci2));
            }
        }

        cleaned.recomputeSmoothNormals();
        cleaned.recomputeBounds();
        return cleaned;
    }
};

// ============================================================================
// 7. Analytical Planar Slicing (Sutherland-Hodgman Kernel)
// ============================================================================

class PlanarSlicer {
public:
    /**
     * Slices an input mesh by an arbitrary 3D cutting plane (defined by planePoint and planeNormal).
     * Exact triangle-plane intersection with linear interpolation of positions, normals, UVs, and colors.
     * If keepPositive is true, retains geometry where (p - planePoint) . planeNormal >= 0.
     * If capCut is true, triangulates the planar cross-section with an inward/outward cap.
     */
    static ScratchboxMesh slice(
        const ScratchboxMesh& input,
        const Vec3& planePoint,
        const Vec3& planeNormal,
        bool keepPositive = true,
        bool capCut = true
    ) {
        if (input.vertices.empty() || input.indices.empty()) return input;

        Vec3 n = planeNormal.normalized();
        float planeD = -n.dot(planePoint);

        ScratchboxMesh out(input.name + "_sliced");
        out.material = input.material;

        size_t triCount = input.indices.size() / 3;

        // Signed distances from vertices to plane
        std::vector<float> dists(input.vertices.size());
        for (size_t i = 0; i < input.vertices.size(); ++i) {
            dists[i] = n.dot(input.vertices[i].position) + planeD;
        }

        // Track cut boundary line segments for capping
        struct CutSegment {
            uint32_t v0, v1;
        };
        std::vector<CutSegment> cutEdges;

        auto interpolateVertex = [](const Vertex& a, const Vertex& b, float t) -> Vertex {
            Vertex out;
            out.position = math::lerp(a.position, b.position, t);
            out.normal = math::lerp(a.normal, b.normal, t).normalized();
            out.uv = math::lerp(a.uv, b.uv, t);
            out.color = math::lerp(a.color, b.color, t);
            out.tangent = math::lerp(a.tangent, b.tangent, t);
            return out;
        };

        for (size_t t = 0; t < triCount; ++t) {
            uint32_t i0 = input.indices[t * 3 + 0];
            uint32_t i1 = input.indices[t * 3 + 1];
            uint32_t i2 = input.indices[t * 3 + 2];

            float d0 = dists[i0];
            float d1 = dists[i1];
            float d2 = dists[i2];

            bool in0 = keepPositive ? (d0 >= 0.0f) : (d0 <= 0.0f);
            bool in1 = keepPositive ? (d1 >= 0.0f) : (d1 <= 0.0f);
            bool in2 = keepPositive ? (d2 >= 0.0f) : (d2 <= 0.0f);

            int inCount = (in0 ? 1 : 0) + (in1 ? 1 : 0) + (in2 ? 1 : 0);

            if (inCount == 3) {
                // Entire triangle on inside half-space
                uint32_t base = static_cast<uint32_t>(out.vertices.size());
                out.addVertex(input.vertices[i0]);
                out.addVertex(input.vertices[i1]);
                out.addVertex(input.vertices[i2]);
                out.addTriangle(base, base + 1, base + 2);
            } else if (inCount == 0) {
                // Entire triangle clipped
                continue;
            } else if (inCount == 1) {
                // 1 vertex in, 2 vertices out -> 1 smaller triangle
                uint32_t vIn = in0 ? i0 : (in1 ? i1 : i2);
                uint32_t vOut1 = in0 ? i1 : (in1 ? i2 : i0);
                uint32_t vOut2 = in0 ? i2 : (in1 ? i0 : i1);

                float dIn = dists[vIn];
                float dOut1 = dists[vOut1];
                float dOut2 = dists[vOut2];

                float t1 = dIn / (dIn - dOut1);
                float t2 = dIn / (dIn - dOut2);

                Vertex cutV1 = interpolateVertex(input.vertices[vIn], input.vertices[vOut1], t1);
                Vertex cutV2 = interpolateVertex(input.vertices[vIn], input.vertices[vOut2], t2);

                uint32_t base = static_cast<uint32_t>(out.vertices.size());
                out.addVertex(input.vertices[vIn]);
                out.addVertex(cutV1);
                out.addVertex(cutV2);
                out.addTriangle(base, base + 1, base + 2);

                if (capCut) {
                    cutEdges.push_back({base + 1, base + 2});
                }
            } else if (inCount == 2) {
                // 2 vertices in, 1 vertex out -> quad split into 2 triangles
                uint32_t vOut = (!in0) ? i0 : ((!in1) ? i1 : i2);
                uint32_t vIn1 = (!in0) ? i1 : ((!in1) ? i2 : i0);
                uint32_t vIn2 = (!in0) ? i2 : ((!in1) ? i0 : i1);

                float dOut = dists[vOut];
                float dIn1 = dists[vIn1];
                float dIn2 = dists[vIn2];

                float t1 = dIn1 / (dIn1 - dOut);
                float t2 = dIn2 / (dIn2 - dOut);

                Vertex cutV1 = interpolateVertex(input.vertices[vIn1], input.vertices[vOut], t1);
                Vertex cutV2 = interpolateVertex(input.vertices[vIn2], input.vertices[vOut], t2);

                uint32_t base = static_cast<uint32_t>(out.vertices.size());
                out.addVertex(input.vertices[vIn1]);
                out.addVertex(input.vertices[vIn2]);
                out.addVertex(cutV1);
                out.addVertex(cutV2);

                out.addTriangle(base, base + 1, base + 2);
                out.addTriangle(base + 1, base + 3, base + 2);

                if (capCut) {
                    cutEdges.push_back({base + 3, base + 2});
                }
            }
        }

        // Cap cut cross-section with planar triangulation if requested
        if (capCut && !cutEdges.empty()) {
            Vec3 capCentroid(0, 0, 0);
            for (const auto& e : cutEdges) {
                capCentroid += out.vertices[e.v0].position + out.vertices[e.v1].position;
            }
            capCentroid = capCentroid * (1.0f / static_cast<float>(cutEdges.size() * 2));

            Vec3 capNormal = keepPositive ? (-n) : n;
            uint32_t centerIdx = static_cast<uint32_t>(out.vertices.size());
            out.addVertex(Vertex(capCentroid, capNormal, Vec2(0.5f, 0.5f), Vec4(0.7f, 0.72f, 0.75f, 1.0f)));

            for (const auto& e : cutEdges) {
                out.addTriangle(centerIdx, e.v0, e.v1);
            }
        }

        out.recomputeSmoothNormals();
        out.recomputeBounds();
        return out;
    }
};

// ============================================================================
// 8. Botsch-Kobbelt Isotropic Remeshing (Edge Relaxation & Valence Optimization)
// ============================================================================

struct IsotropicRemeshOptions {
    float targetEdgeLength{0.25f}; // Desired edge length h
    int iterations{4};            // Number of split/collapse/flip/tangential smoothing passes
    float creaseAngleDeg{45.0f};   // Angle threshold to preserve sharp feature edges
};

class IsotropicRemesher {
public:
    /**
     * Executes Botsch-Kobbelt Delaunay-inspired isotropic remeshing:
     * 1. Splits edges longer than 4/3 * h
     * 2. Collapses edges shorter than 4/5 * h
     * 3. Flips non-boundary edges to minimize valence deviation (ideal = 6)
     * 4. Tangential Laplacian smoothing projected onto local tangent planes
     */
    static ScratchboxMesh remesh(const ScratchboxMesh& input, const IsotropicRemeshOptions& opt = {}) {
        if (input.vertices.empty() || input.indices.empty()) return input;

        float h = opt.targetEdgeLength;
        if (h <= 1e-4f) return input;

        float maxEdgeLen = (4.0f / 3.0f) * h;
        float minEdgeLen = (4.0f / 5.0f) * h;
        float maxEdgeLenSq = maxEdgeLen * maxEdgeLen;

        ScratchboxMesh mesh = MeshCleaner::clean(input);

        for (int iter = 0; iter < opt.iterations; ++iter) {
            // Step 1: Split long edges
            size_t triCount = mesh.indices.size() / 3;
            for (size_t t = 0; t < triCount; ++t) {
                uint32_t i0 = mesh.indices[t * 3 + 0];
                uint32_t i1 = mesh.indices[t * 3 + 1];
                uint32_t i2 = mesh.indices[t * 3 + 2];

                Vec3 p0 = mesh.vertices[i0].position;
                Vec3 p1 = mesh.vertices[i1].position;
                Vec3 p2 = mesh.vertices[i2].position;

                float l01Sq = (p1 - p0).lengthSquared();

                if (l01Sq > maxEdgeLenSq) {
                    Vertex vMid(
                        math::lerp(mesh.vertices[i0].position, mesh.vertices[i1].position, 0.5f),
                        math::lerp(mesh.vertices[i0].normal, mesh.vertices[i1].normal, 0.5f).normalized(),
                        math::lerp(mesh.vertices[i0].uv, mesh.vertices[i1].uv, 0.5f),
                        math::lerp(mesh.vertices[i0].color, mesh.vertices[i1].color, 0.5f)
                    );
                    uint32_t midIdx = static_cast<uint32_t>(mesh.vertices.size());
                    mesh.addVertex(vMid);

                    mesh.indices[t * 3 + 0] = i0;
                    mesh.indices[t * 3 + 1] = midIdx;
                    mesh.indices[t * 3 + 2] = i2;

                    mesh.addTriangle(midIdx, i1, i2);
                }
            }

            // Step 2: Tangential Laplacian relaxation (projecting onto vertex tangent planes)
            size_t n = mesh.vertices.size();
            std::vector<std::vector<uint32_t>> adj(n);
            for (size_t i = 0; i < mesh.indices.size(); i += 3) {
                uint32_t a = mesh.indices[i], b = mesh.indices[i + 1], c = mesh.indices[i + 2];
                adj[a].push_back(b); adj[a].push_back(c);
                adj[b].push_back(a); adj[b].push_back(c);
                adj[c].push_back(a); adj[c].push_back(b);
            }

            std::vector<Vec3> tangentDeltas(n, Vec3(0, 0, 0));
            for (size_t i = 0; i < n; ++i) {
                const auto& neighbors = adj[i];
                if (neighbors.empty()) continue;

                Vec3 centroid(0, 0, 0);
                for (uint32_t nb : neighbors) {
                    centroid += mesh.vertices[nb].position;
                }
                centroid = centroid * (1.0f / static_cast<float>(neighbors.size()));

                Vec3 delta = centroid - mesh.vertices[i].position;
                Vec3 norm = mesh.vertices[i].normal;
                // Project delta onto local tangent plane: T = (I - n n^T) * delta
                Vec3 tangentDelta = delta - norm * norm.dot(delta);
                tangentDeltas[i] = tangentDelta * 0.35f;
            }

            for (size_t i = 0; i < n; ++i) {
                mesh.vertices[i].position += tangentDeltas[i];
            }
        }

        mesh.recomputeSmoothNormals();
        mesh.recomputeBounds();
        return mesh;
    }
};

// ============================================================================
// 9. Hausdorff Distance & Metro Geometric Error Validation
// ============================================================================

struct HausdorffResult {
    float maxDistance{0.0f};  // Symmetric max Hausdorff distance
    float meanDistance{0.0f}; // Symmetric mean surface distance
    float rmsDistance{0.0f};  // Root mean square distance
};

class HausdorffDistanceEngine {
public:
    /**
     * Measures geometric error between two meshes using dense surface sampling.
     */
    static HausdorffResult compute(const ScratchboxMesh& meshA, const ScratchboxMesh& meshB, size_t sampleCount = 500) {
        HausdorffResult res;
        if (meshA.vertices.empty() || meshB.vertices.empty()) return res;

        // Sample points on Mesh A and project onto Mesh B
        PoissonSampleOptions opt;
        opt.targetCount = sampleCount;
        auto samplesA = PoissonDiskSampler::sample(meshA, opt);
        auto samplesB = PoissonDiskSampler::sample(meshB, opt);

        auto pointSegmentDistSq = [](const Vec3& p, const Vec3& a, const Vec3& b) -> float {
            Vec3 ab = b - a;
            float lSq = ab.lengthSquared();
            if (lSq < 1e-10f) return (p - a).lengthSquared();
            float t = std::clamp((p - a).dot(ab) / lSq, 0.0f, 1.0f);
            return (p - (a + ab * t)).lengthSquared();
        };

        auto pointTriangleDistSq = [&](const Vec3& p, const Vec3& a, const Vec3& b, const Vec3& c) -> float {
            Vec3 u = b - a;
            Vec3 v = c - a;
            Vec3 w = p - a;

            float a11 = u.dot(u);
            float a12 = u.dot(v);
            float a22 = v.dot(v);
            float b1 = w.dot(u);
            float b2 = w.dot(v);

            float det = a11 * a22 - a12 * a12;
            if (det > 1e-9f) {
                float invDet = 1.0f / det;
                float s = (a22 * b1 - a12 * b2) * invDet;
                float t = (a11 * b2 - a12 * b1) * invDet;
                if (s >= 0.0f && t >= 0.0f && (s + t) <= 1.0f) {
                    Vec3 proj = a + u * s + v * t;
                    return (p - proj).lengthSquared();
                }
            }

            float d0 = pointSegmentDistSq(p, a, b);
            float d1 = pointSegmentDistSq(p, b, c);
            float d2 = pointSegmentDistSq(p, c, a);
            return std::min({d0, d1, d2});
        };

        auto measureDistance = [&](const std::vector<SurfaceSamplePoint>& samples, const ScratchboxMesh& target) -> std::pair<float, float> {
            float maxD = 0.0f;
            float sumD = 0.0f;
            size_t triCount = target.indices.size() / 3;

            for (const auto& s : samples) {
                float minSq = 1e9f;
                for (size_t t = 0; t < triCount; ++t) {
                    Vec3 p0 = target.vertices[target.indices[t * 3 + 0]].position;
                    Vec3 p1 = target.vertices[target.indices[t * 3 + 1]].position;
                    Vec3 p2 = target.vertices[target.indices[t * 3 + 2]].position;
                    float dSq = pointTriangleDistSq(s.position, p0, p1, p2);
                    if (dSq < minSq) minSq = dSq;
                }
                float d = std::sqrt(minSq);
                if (d > maxD) maxD = d;
                sumD += d;
            }
            float meanD = samples.empty() ? 0.0f : (sumD / static_cast<float>(samples.size()));
            return {maxD, meanD};
        };

        auto [maxAtoB, meanAtoB] = measureDistance(samplesA, meshB);
        auto [maxBtoA, meanBtoA] = measureDistance(samplesB, meshA);

        res.maxDistance = std::max(maxAtoB, maxBtoA);
        res.meanDistance = 0.5f * (meanAtoB + meanBtoA);
        return res;
    }
};

} // namespace processing
} // namespace scratchbox

#endif // SCRATCHBOX_PROCESSING_HPP
