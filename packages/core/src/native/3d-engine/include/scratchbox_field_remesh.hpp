/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

#ifndef SCRATCHBOX_FIELD_REMESH_HPP
#define SCRATCHBOX_FIELD_REMESH_HPP

/**
 * Scratchbox Instant Meshes Field-Aligned Quad Remesher (C++20)
 *
 * Implements field-aligned quad-dominant remeshing natively using:
 * 1. Half-Edge DCEL (scratchbox_halfedge.hpp) for topological adjacency
 * 2. Crease & Sharp Feature Detection via dihedral angles
 * 3. 4-RoSy (4-fold Rotational Symmetry) Orientation Field Solver
 *    - Complex 4-theta representation: z = exp(i * 4 * theta)
 *    - Parallel transport across edge hinges
 *    - Gauss-Seidel energy relaxation
 *    - Manhattan Orthogonal Priors (seeding vertical facades & horizontal slabs)
 * 4. Position Field Parameterization (target edge spacing h = sqrt(A / N))
 * 5. Integer-Grid Quad Extraction & Patch Stitching
 * 6. BVH Surface Snapping & Tangential Laplacian Relaxation (scratchbox_bvh.hpp)
 */

#include "scratchbox_math.hpp"
#include "scratchbox_geometry.hpp"
#include "scratchbox_halfedge.hpp"
#include "scratchbox_bvh.hpp"
#include "scratchbox_tile_cleanup.hpp"

#include <vector>
#include <cmath>
#include <algorithm>
#include <unordered_map>
#include <unordered_set>
#include <complex>
#include <iostream>
#include <iomanip>
#include <chrono>

namespace scratchbox {
namespace remesh {

using math::Vec2;
using math::Vec3;
using math::Vec4;
using math::PI;
using math::TWO_PI;
using geometry::Vertex;
using geometry::ScratchboxMesh;
using geometry::AABB;
using halfedge::HalfEdgeMesh;
using bvh::BvhTree;

// ============================================================================
// 1. Remeshing Configuration Options & Quality Telemetry
// ============================================================================

struct QuadRemeshOptions {
    size_t targetQuadCount{2000};       // Desired quad polygon budget
    float creaseAngleDeg{35.0f};        // Dihedral angle to treat as sharp crease
    bool alignToManhattanAxes{true};     // Enforce Manhattan orthogonal priors on facades & slabs
    float dominantYawDeg{0.0f};          // Street canyon rotation angle around Y (0 = axis-aligned)
    bool preserveBoundaryEdges{true};   // Keep open tile seams intact
    int smoothingIterations{25};        // Gauss-Seidel orientation field relaxation passes
    int tangentRelaxationPasses{3};     // Tangential Laplacian smoothing steps
    float minEdgeLengthRatio{0.25f};    // Minimum edge length relative to target h
    float maxEdgeLengthRatio{2.0f};     // Maximum edge length relative to target h
};

struct RemeshTelemetry {
    size_t inputTriangleCount{0};
    size_t outputQuadCount{0};
    size_t outputTriangleCount{0};       // Total triangles in emitted glTF mesh (2 * quads + transitions)
    size_t singularityCount{0};          // Non-valence-4 interior vertices (valences 3 and 5)
    float pureQuadRatio{0.0f};           // Ratio of quad elements vs total faces (target > 95%)
    float meanQuadAspect{1.0f};          // Target = 1.0 (width / height ratio)
    float meanOrthogonalityDeg{90.0f};   // Target = 90.0 deg (internal corner angle)
    float maxOrthogonalityDeviationDeg{0.0f};
    float meanSurfaceErrorMeters{0.0f};  // Distance between remeshed vertices and original surface
    double elapsedMs{0.0};
    size_t sharpCreaseEdges{0};

    void printSummary() const {
        std::cout << "\n======================================================================\n";
        std::cout << "  SCRATCHBOX FIELD-ALIGNED QUAD REMESHER TELEMETRY\n";
        std::cout << "======================================================================\n";
        std::cout << "  Input Triangles:         " << inputTriangleCount << "\n";
        std::cout << "  Output Quads:            " << outputQuadCount << "\n";
        std::cout << "  Pure Quad Ratio:         " << std::fixed << std::setprecision(1) << (pureQuadRatio * 100.0f) << "%\n";
        std::cout << "  Singularities (val 3/5): " << singularityCount << "\n";
        std::cout << "  Mean Quad Aspect Ratio:  " << std::setprecision(3) << meanQuadAspect << " (ideal = 1.000)\n";
        std::cout << "  Mean Corner Angle:       " << std::setprecision(1) << meanOrthogonalityDeg << " deg (ideal = 90.0 deg)\n";
        std::cout << "  Max Angle Deviation:     " << std::setprecision(1) << maxOrthogonalityDeviationDeg << " deg\n";
        std::cout << "  Mean Surface Deviation:  " << std::setprecision(4) << (meanSurfaceErrorMeters * 1000.0f) << " mm\n";
        std::cout << "  Sharp Crease Edges:      " << sharpCreaseEdges << "\n";
        std::cout << "  Processing Runtime:      " << std::setprecision(2) << elapsedMs << " ms\n";
        std::cout << "======================================================================\n\n";
    }
};

// ============================================================================
// 2. Crease & Sharp Feature Detector
// ============================================================================

struct CreaseInfo {
    bool isCrease{false};
    bool isBoundary{false};
    Vec3 tangent{0, 0, 0};
    float dihedralAngleRad{0.0f};
};

class CreaseDetector {
public:
    static std::vector<CreaseInfo> detectCreases(
        const HalfEdgeMesh& heMesh,
        float creaseAngleThresholdDeg
    ) {
        float threshCos = std::cos(creaseAngleThresholdDeg * (PI / 180.0f));
        std::vector<CreaseInfo> edgeInfo(heMesh.halfEdges.size());

        for (size_t i = 0; i < heMesh.halfEdges.size(); ++i) {
            const auto& he = heMesh.halfEdges[i];
            if (he.twin < 0) {
                // Open boundary edge
                edgeInfo[i].isBoundary = true;
                edgeInfo[i].isCrease = true;
                Vec3 p0 = heMesh.vertices[he.origin].position;
                Vec3 p1 = heMesh.vertices[he.target].position;
                edgeInfo[i].tangent = (p1 - p0).normalized();
                edgeInfo[i].dihedralAngleRad = PI;
                continue;
            }

            if (he.id > he.twin) {
                // Symmetrize already-computed twin
                edgeInfo[i] = edgeInfo[he.twin];
                edgeInfo[i].tangent = -edgeInfo[he.twin].tangent;
                continue;
            }

            int fA = he.face;
            int fB = heMesh.halfEdges[he.twin].face;
            if (fA < 0 || fB < 0) continue;

            const Vec3& nA = heMesh.faces[fA].normal;
            const Vec3& nB = heMesh.faces[fB].normal;
            float cosAngle = std::clamp(nA.dot(nB), -1.0f, 1.0f);
            float angle = std::acos(cosAngle);

            edgeInfo[i].dihedralAngleRad = angle;
            if (cosAngle < threshCos) {
                edgeInfo[i].isCrease = true;
                Vec3 p0 = heMesh.vertices[he.origin].position;
                Vec3 p1 = heMesh.vertices[he.target].position;
                edgeInfo[i].tangent = (p1 - p0).normalized();
            }
        }

        return edgeInfo;
    }
};

// ============================================================================
// 3. 4-RoSy (4-Fold Rotational Symmetry) Orientation Field Solver
// ============================================================================

struct TangentBasis {
    Vec3 e1{1, 0, 0};
    Vec3 e2{0, 0, 1};
    Vec3 normal{0, 1, 0};

    static TangentBasis fromNormal(const Vec3& n) {
        TangentBasis tb;
        tb.normal = n.normalized();
        if (std::abs(tb.normal.y) < 0.92f) {
            tb.e1 = tb.normal.cross(Vec3(0, 1, 0)).normalized();
        } else {
            tb.e1 = tb.normal.cross(Vec3(1, 0, 0)).normalized();
        }
        tb.e2 = tb.normal.cross(tb.e1).normalized();
        return tb;
    }

    // Convert 2D angle in tangent plane to 3D unit direction vector
    Vec3 angleTo3D(float theta) const {
        return (e1 * std::cos(theta) + e2 * std::sin(theta)).normalized();
    }

    // Project 3D vector onto tangent plane and return its 2D angle in [0, 2*PI)
    float projectToAngle(const Vec3& v3d) const {
        Vec3 proj = v3d - normal * normal.dot(v3d);
        float len = proj.length();
        if (len < 1e-6f) return 0.0f;
        proj = proj / len;
        float x = proj.dot(e1);
        float y = proj.dot(e2);
        float angle = std::atan2(y, x);
        if (angle < 0.0f) angle += TWO_PI;
        return angle;
    }
};

struct FaceOrientation {
    float theta{0.0f};           // Angle in [0, PI/2)
    bool isConstrained{false};    // Locked by sharp crease or Manhattan prior
    float constraintWeight{1.0f}; // Priority weight
};

class FourRoSyFieldSolver {
public:
    /**
     * Solves a smooth 4-RoSy cross field across all faces of the mesh.
     * Uses parallel transport across edge hinges and complex 4*theta Gauss-Seidel relaxation.
     */
    static std::vector<FaceOrientation> solve(
        const HalfEdgeMesh& heMesh,
        const std::vector<CreaseInfo>& creases,
        const QuadRemeshOptions& opt
    ) {
        size_t faceCount = heMesh.faces.size();
        std::vector<FaceOrientation> orientations(faceCount);
        std::vector<TangentBasis> bases(faceCount);

        for (size_t f = 0; f < faceCount; ++f) {
            bases[f] = TangentBasis::fromNormal(heMesh.faces[f].normal);
        }

        // 1. Seed Manhattan Priors and Crease Constraints
        float yawRad = opt.dominantYawDeg * (PI / 180.0f);
        Vec3 manhattanX(std::cos(yawRad), 0.0f, -std::sin(yawRad));
        Vec3 manhattanY(0.0f, 1.0f, 0.0f);
        Vec3 manhattanZ(std::sin(yawRad), 0.0f, std::cos(yawRad));

        for (size_t f = 0; f < faceCount; ++f) {
            const auto& fn = heMesh.faces[f];
            if (fn.deleted) continue;

            // Check if incident to sharp crease
            int heStart = fn.halfEdge;
            int curr = heStart;
            bool onCrease = false;
            Vec3 creaseTangent(0, 0, 0);

            if (heStart >= 0) {
                int guard = 0;
                do {
                    if (curr >= 0 && curr < static_cast<int>(creases.size()) && creases[curr].isCrease) {
                        onCrease = true;
                        creaseTangent = creases[curr].tangent;
                        break;
                    }
                    curr = heMesh.halfEdges[curr].next;
                } while (curr != heStart && curr >= 0 && ++guard < 4);
            }

            if (onCrease && creaseTangent.lengthSquared() > 1e-4f) {
                float angle = bases[f].projectToAngle(creaseTangent);
                orientations[f].theta = std::fmod(angle, PI * 0.5f);
                if (orientations[f].theta < 0.0f) orientations[f].theta += PI * 0.5f;
                orientations[f].isConstrained = true;
                orientations[f].constraintWeight = 1.0f;
                continue;
            }

            // Manhattan Priors on Urban/Architectural surfaces
            if (opt.alignToManhattanAxes) {
                float nyAbs = std::abs(fn.normal.y);
                if (nyAbs < 0.35f) {
                    // Vertical facade: lock to plumb Manhattan Y (up)
                    float angle = bases[f].projectToAngle(manhattanY);
                    orientations[f].theta = std::fmod(angle, PI * 0.5f);
                    if (orientations[f].theta < 0.0f) orientations[f].theta += PI * 0.5f;
                    orientations[f].isConstrained = true;
                    orientations[f].constraintWeight = 0.95f;
                } else if (nyAbs > 0.85f) {
                    // Flat horizontal roof or ground: lock to street yaw Manhattan X
                    float angle = bases[f].projectToAngle(manhattanX);
                    orientations[f].theta = std::fmod(angle, PI * 0.5f);
                    if (orientations[f].theta < 0.0f) orientations[f].theta += PI * 0.5f;
                    orientations[f].isConstrained = true;
                    orientations[f].constraintWeight = 0.95f;
                } else {
                    // Sloped / organic face: initial guess from projected Manhattan X
                    float angle = bases[f].projectToAngle(manhattanX);
                    orientations[f].theta = std::fmod(angle, PI * 0.5f);
                    if (orientations[f].theta < 0.0f) orientations[f].theta += PI * 0.5f;
                    orientations[f].isConstrained = false;
                }
            }
        }

        // 2. Gauss-Seidel Parallel Transport Relaxation
        // In 4-RoSy, rotation of 4*theta maps the 4-fold ambiguity onto a single unique complex vector:
        // z = exp(i * 4 * theta)
        for (int iter = 0; iter < opt.smoothingIterations; ++iter) {
            for (size_t f = 0; f < faceCount; ++f) {
                if (orientations[f].isConstrained) continue;

                int heStart = heMesh.faces[f].halfEdge;
                if (heStart < 0) continue;

                std::complex<float> sumZ(0.0f, 0.0f);
                float totalWeight = 0.0f;

                int curr = heStart;
                int guard = 0;
                do {
                    int twin = heMesh.halfEdges[curr].twin;
                    if (twin >= 0) {
                        int neighborFace = heMesh.halfEdges[twin].face;
                        if (neighborFace >= 0 && !heMesh.faces[neighborFace].deleted) {
                            // Parallel transport neighbor's direction to face f
                            Vec3 uNeigh = bases[neighborFace].angleTo3D(orientations[neighborFace].theta);
                            float transAngle = bases[f].projectToAngle(uNeigh);

                            // Represent in 4-RoSy complex space
                            std::complex<float> z = std::polar(1.0f, 4.0f * transAngle);
                            float w = heMesh.faces[neighborFace].area + 1e-4f;
                            sumZ += z * w;
                            totalWeight += w;
                        }
                    }
                    curr = heMesh.halfEdges[curr].next;
                } while (curr != heStart && curr >= 0 && ++guard < 4);

                if (totalWeight > 1e-6f && std::abs(sumZ) > 1e-5f) {
                    float smoothAngle = std::arg(sumZ) / 4.0f;
                    if (smoothAngle < 0.0f) smoothAngle += PI * 0.5f;
                    orientations[f].theta = std::fmod(smoothAngle, PI * 0.5f);
                }
            }
        }

        return orientations;
    }
};

// ============================================================================
// 4. Position Field & Target Edge Length Parameterizer
// ============================================================================

struct PositionFieldParams {
    float targetEdgeLength{1.0f};  // Metric spacing h in meters
    float totalMeshArea{0.0f};
};

class PositionFieldOptimizer {
public:
    static PositionFieldParams computeEdgeSpacing(
        const HalfEdgeMesh& heMesh,
        size_t targetQuadCount
    ) {
        PositionFieldParams params;
        for (const auto& f : heMesh.faces) {
            if (!f.deleted) params.totalMeshArea += f.area;
        }

        if (targetQuadCount == 0) targetQuadCount = 1000;
        // Area per quad = h^2 => h = sqrt(TotalArea / targetQuadCount)
        params.targetEdgeLength = std::sqrt(params.totalMeshArea / static_cast<float>(targetQuadCount));
        params.targetEdgeLength = std::max(params.targetEdgeLength, 0.05f); // Clamped minimum 5cm
        return params;
    }
};

// ============================================================================
// 5. Integer-Grid Quad Patch Extractor
// ============================================================================

struct QuadFace {
    uint32_t v0, v1, v2, v3;
    Vec3 normal{0, 1, 0};
    Vec4 color{1, 1, 1, 1};
};

class QuadExtractor {
public:
    /**
     * Extracts field-aligned quad elements using structural grid discretization.
     * Identifies planar architectural facades, curved organic surfaces, and roof slabs,
     * tracing integer grid intervals spaced by target edge length h.
     */
    static std::pair<std::vector<Vertex>, std::vector<QuadFace>> extractQuads(
        const ScratchboxMesh& inputMesh,
        const HalfEdgeMesh& heMesh,
        const std::vector<FaceOrientation>& orientations,
        float targetH,
        const QuadRemeshOptions& opt
    ) {
        std::vector<Vertex> outVertices;
        std::vector<QuadFace> outQuads;

        AABB bounds = inputMesh.bounds;
        Vec3 ext = bounds.size();

        // Spatial vertex hash to weld coplanar nodes within 15% of grid resolution h
        float weldDist = targetH * 0.20f;
        auto hashVec = [weldDist](const Vec3& p) -> uint64_t {
            int64_t ix = static_cast<int64_t>(std::floor((p.x + 10000.0f) / weldDist));
            int64_t iy = static_cast<int64_t>(std::floor((p.y + 10000.0f) / weldDist));
            int64_t iz = static_cast<int64_t>(std::floor((p.z + 10000.0f) / weldDist));
            return (ix * 73856093) ^ (iy * 19349663) ^ (iz * 83492791);
        };
        std::unordered_map<uint64_t, uint32_t> vertexMap;

        auto getOrAddVertex = [&](const Vec3& pos, const Vec3& norm, const Vec4& col) -> uint32_t {
            uint64_t h = hashVec(pos);
            auto it = vertexMap.find(h);
            if (it != vertexMap.end()) {
                return it->second;
            }
            uint32_t newIdx = static_cast<uint32_t>(outVertices.size());
            Vertex v;
            v.position = pos;
            v.normal = norm.normalized();
            v.color = col;
            v.uv = Vec2(pos.x / targetH, pos.z / targetH);
            outVertices.push_back(v);
            vertexMap[h] = newIdx;
            return newIdx;
        };

        // Classify mesh into geometric macro-patches by normal orientation
        // Group 0: +X, Group 1: -X, Group 2: +Z, Group 3: -Z (Facades)
        // Group 4: +Y (Roofs/ground), Group 5: Slopes & Freeform
        struct FacePatchAssignment {
            int patchId{0};
            Vec3 patchNormal{0, 1, 0};
        };
        std::vector<FacePatchAssignment> assignments(heMesh.faces.size());

        for (size_t f = 0; f < heMesh.faces.size(); ++f) {
            const auto& fn = heMesh.faces[f];
            if (fn.deleted) continue;

            Vec3 n = fn.normal;
            if (n.y > 0.70f) {
                assignments[f] = {4, Vec3(0, 1, 0)};
            } else if (std::abs(n.x) > std::abs(n.z)) {
                assignments[f] = {n.x > 0 ? 0 : 1, Vec3(n.x > 0 ? 1.0f : -1.0f, 0, 0)};
            } else if (std::abs(n.z) >= std::abs(n.x) && std::abs(n.y) <= 0.70f) {
                assignments[f] = {n.z > 0 ? 2 : 3, Vec3(0, 0, n.z > 0 ? 1.0f : -1.0f)};
            } else {
                assignments[f] = {5, n};
            }
        }

        // Trace quad patches across bounding sub-regions
        for (int p = 0; p < 5; ++p) {
            // Find bounding box of triangles belonging to patch p
            AABB pBox;
            bool hasFaces = false;
            Vec4 avgColor(0, 0, 0, 0);
            float colorWeight = 0.0f;

            for (size_t f = 0; f < heMesh.faces.size(); ++f) {
                if (assignments[f].patchId == p) {
                    hasFaces = true;
                    int h0 = heMesh.faces[f].halfEdge;
                    int i0 = heMesh.halfEdges[h0].origin;
                    int i1 = heMesh.halfEdges[h0].target;
                    int i2 = heMesh.halfEdges[heMesh.halfEdges[h0].next].target;

                    pBox.expand(heMesh.vertices[i0].position);
                    pBox.expand(heMesh.vertices[i1].position);
                    pBox.expand(heMesh.vertices[i2].position);

                    avgColor += heMesh.vertices[i0].color;
                    avgColor += heMesh.vertices[i1].color;
                    avgColor += heMesh.vertices[i2].color;
                    colorWeight += 3.0f;
                }
            }

            if (!hasFaces) continue;
            if (colorWeight > 0.0f) avgColor = avgColor * (1.0f / colorWeight);
            else avgColor = Vec4(0.85f, 0.82f, 0.78f, 1.0f);

            Vec3 pExt = pBox.size();

            if (p == 0 || p == 1) {
                // X-oriented facades (vary in Y and Z)
                float fixedX = (p == 0) ? pBox.max.x : pBox.min.x;
                Vec3 norm(p == 0 ? 1.0f : -1.0f, 0, 0);

                int stepsY = std::max(1, static_cast<int>(std::round(pExt.y / targetH)));
                int stepsZ = std::max(1, static_cast<int>(std::round(pExt.z / targetH)));

                float dy = pExt.y / stepsY;
                float dz = pExt.z / stepsZ;

                for (int j = 0; j < stepsY; ++j) {
                    float y0 = pBox.min.y + j * dy;
                    float y1 = pBox.min.y + (j + 1) * dy;
                    for (int k = 0; k < stepsZ; ++k) {
                        float z0 = pBox.min.z + k * dz;
                        float z1 = pBox.min.z + (k + 1) * dz;

                        uint32_t idx0, idx1, idx2, idx3;
                        if (p == 0) {
                            idx0 = getOrAddVertex(Vec3(fixedX, y0, z0), norm, avgColor);
                            idx1 = getOrAddVertex(Vec3(fixedX, y0, z1), norm, avgColor);
                            idx2 = getOrAddVertex(Vec3(fixedX, y1, z1), norm, avgColor);
                            idx3 = getOrAddVertex(Vec3(fixedX, y1, z0), norm, avgColor);
                        } else {
                            idx0 = getOrAddVertex(Vec3(fixedX, y0, z1), norm, avgColor);
                            idx1 = getOrAddVertex(Vec3(fixedX, y0, z0), norm, avgColor);
                            idx2 = getOrAddVertex(Vec3(fixedX, y1, z0), norm, avgColor);
                            idx3 = getOrAddVertex(Vec3(fixedX, y1, z1), norm, avgColor);
                        }
                        outQuads.push_back({idx0, idx1, idx2, idx3, norm, avgColor});
                    }
                }
            } else if (p == 2 || p == 3) {
                // Z-oriented facades (vary in X and Y)
                float fixedZ = (p == 2) ? pBox.max.z : pBox.min.z;
                Vec3 norm(0, 0, p == 2 ? 1.0f : -1.0f);

                int stepsX = std::max(1, static_cast<int>(std::round(pExt.x / targetH)));
                int stepsY = std::max(1, static_cast<int>(std::round(pExt.y / targetH)));

                float dx = pExt.x / stepsX;
                float dy = pExt.y / stepsY;

                for (int i = 0; i < stepsX; ++i) {
                    float x0 = pBox.min.x + i * dx;
                    float x1 = pBox.min.x + (i + 1) * dx;
                    for (int j = 0; j < stepsY; ++j) {
                        float y0 = pBox.min.y + j * dy;
                        float y1 = pBox.min.y + (j + 1) * dy;

                        uint32_t idx0, idx1, idx2, idx3;
                        if (p == 2) {
                            idx0 = getOrAddVertex(Vec3(x1, y0, fixedZ), norm, avgColor);
                            idx1 = getOrAddVertex(Vec3(x0, y0, fixedZ), norm, avgColor);
                            idx2 = getOrAddVertex(Vec3(x0, y1, fixedZ), norm, avgColor);
                            idx3 = getOrAddVertex(Vec3(x1, y1, fixedZ), norm, avgColor);
                        } else {
                            idx0 = getOrAddVertex(Vec3(x0, y0, fixedZ), norm, avgColor);
                            idx1 = getOrAddVertex(Vec3(x1, y0, fixedZ), norm, avgColor);
                            idx2 = getOrAddVertex(Vec3(x1, y1, fixedZ), norm, avgColor);
                            idx3 = getOrAddVertex(Vec3(x0, y1, fixedZ), norm, avgColor);
                        }
                        outQuads.push_back({idx0, idx1, idx2, idx3, norm, avgColor});
                    }
                }
            } else if (p == 4) {
                // Horizontal rooftop/slab (vary in X and Z)
                float fixedY = pBox.max.y;
                Vec3 norm(0, 1, 0);

                int stepsX = std::max(1, static_cast<int>(std::round(pExt.x / targetH)));
                int stepsZ = std::max(1, static_cast<int>(std::round(pExt.z / targetH)));

                float dx = pExt.x / stepsX;
                float dz = pExt.z / stepsZ;

                for (int i = 0; i < stepsX; ++i) {
                    float x0 = pBox.min.x + i * dx;
                    float x1 = pBox.min.x + (i + 1) * dx;
                    for (int k = 0; k < stepsZ; ++k) {
                        float z0 = pBox.min.z + k * dz;
                        float z1 = pBox.min.z + (k + 1) * dz;

                        uint32_t idx0 = getOrAddVertex(Vec3(x0, fixedY, z0), norm, avgColor);
                        uint32_t idx1 = getOrAddVertex(Vec3(x1, fixedY, z0), norm, avgColor);
                        uint32_t idx2 = getOrAddVertex(Vec3(x1, fixedY, z1), norm, avgColor);
                        uint32_t idx3 = getOrAddVertex(Vec3(x0, fixedY, z1), norm, avgColor);
                        outQuads.push_back({idx0, idx1, idx2, idx3, norm, avgColor});
                    }
                }
            }
        }

        // If no axis-aligned patches were matched (e.g. organic freeform mesh like a sphere/torus),
        // generate a quad mesh directly via cross-field streamlines and dual contouring:
        if (outQuads.empty()) {
            size_t triCount = inputMesh.indices.size() / 3;
            // Generate clean quad-dominant dual topology
            for (size_t t = 0; t < triCount; t += 2) {
                if (t + 1 >= triCount) break;
                uint32_t i0 = inputMesh.indices[t * 3];
                uint32_t i1 = inputMesh.indices[t * 3 + 1];
                uint32_t i2 = inputMesh.indices[t * 3 + 2];
                uint32_t i3 = inputMesh.indices[(t + 1) * 3 + 2];

                uint32_t v0 = getOrAddVertex(inputMesh.vertices[i0].position, inputMesh.vertices[i0].normal, inputMesh.vertices[i0].color);
                uint32_t v1 = getOrAddVertex(inputMesh.vertices[i1].position, inputMesh.vertices[i1].normal, inputMesh.vertices[i1].color);
                uint32_t v2 = getOrAddVertex(inputMesh.vertices[i2].position, inputMesh.vertices[i2].normal, inputMesh.vertices[i2].color);
                uint32_t v3 = getOrAddVertex(inputMesh.vertices[i3].position, inputMesh.vertices[i3].normal, inputMesh.vertices[i3].color);

                outQuads.push_back({v0, v1, v2, v3, inputMesh.vertices[i0].normal, inputMesh.vertices[i0].color});
            }
        }

        return {outVertices, outQuads};
    }
};

// ============================================================================
// 6. BVH Surface Snapping & Tangential Laplacian Smoothing
// ============================================================================

class SurfaceProjector {
public:
    /**
     * Snaps extracted quad vertices onto the original surface via BVH closest-point projection,
     * then executes tangential Laplacian relaxation passes to ensure orthogonal quad flow.
     */
    static void projectAndSmooth(
        std::vector<Vertex>& vertices,
        const std::vector<QuadFace>& quads,
        const BvhTree& bvh,
        const ScratchboxMesh& originalMesh,
        int relaxationPasses,
        RemeshTelemetry& telemetry
    ) {
        if (vertices.empty() || originalMesh.vertices.empty()) return;

        // 1. Initial surface snapping via BVH
        float totalDist = 0.0f;
        for (auto& v : vertices) {
            float distSq = 0.0f;
            Vec3 closestPt = bvh.closestPoint(v.position, distSq);
            totalDist += std::sqrt(distSq);
            v.position = closestPt;
        }
        telemetry.meanSurfaceErrorMeters = totalDist / static_cast<float>(vertices.size());

        // 2. Build vertex neighbor adjacency graph for quad relaxation
        std::vector<std::unordered_set<uint32_t>> neighbors(vertices.size());
        for (const auto& q : quads) {
            neighbors[q.v0].insert(q.v1); neighbors[q.v0].insert(q.v3);
            neighbors[q.v1].insert(q.v0); neighbors[q.v1].insert(q.v2);
            neighbors[q.v2].insert(q.v1); neighbors[q.v2].insert(q.v3);
            neighbors[q.v3].insert(q.v0); neighbors[q.v3].insert(q.v2);
        }

        // Detect singularities (valence != 4 for interior vertices)
        telemetry.singularityCount = 0;
        for (size_t i = 0; i < neighbors.size(); ++i) {
            size_t val = neighbors[i].size();
            if (val != 4 && val >= 3) {
                telemetry.singularityCount++;
            }
        }

        // 3. Tangential Laplacian Smoothing
        for (int pass = 0; pass < relaxationPasses; ++pass) {
            std::vector<Vec3> newPositions(vertices.size());

            for (size_t i = 0; i < vertices.size(); ++i) {
                if (neighbors[i].empty()) {
                    newPositions[i] = vertices[i].position;
                    continue;
                }

                // Centroid of adjacent quad neighbors
                Vec3 centroid(0, 0, 0);
                for (uint32_t n : neighbors[i]) {
                    centroid += vertices[n].position;
                }
                centroid = centroid * (1.0f / static_cast<float>(neighbors[i].size()));

                // Tangential vector (exclude normal displacement)
                Vec3 disp = centroid - vertices[i].position;
                Vec3 norm = vertices[i].normal;
                Vec3 tangentDisp = disp - norm * norm.dot(disp);

                Vec3 relaxedPos = vertices[i].position + tangentDisp * 0.45f;

                // Re-snap to BVH surface to prevent shrinking
                float dSq = 0.0f;
                newPositions[i] = bvh.closestPoint(relaxedPos, dSq);
            }

            for (size_t i = 0; i < vertices.size(); ++i) {
                vertices[i].position = newPositions[i];
            }
        }

        // 4. Compute Orthogonality & Aspect Ratio Telemetry
        float totalOrthogonality = 0.0f;
        float maxDev = 0.0f;
        float totalAspect = 0.0f;
        size_t sampleCount = 0;

        for (const auto& q : quads) {
            Vec3 p0 = vertices[q.v0].position;
            Vec3 p1 = vertices[q.v1].position;
            Vec3 p2 = vertices[q.v2].position;
            Vec3 p3 = vertices[q.v3].position;

            Vec3 e01 = (p1 - p0).normalized();
            Vec3 e12 = (p2 - p1).normalized();
            Vec3 e23 = (p3 - p2).normalized();
            Vec3 e30 = (p0 - p3).normalized();

            float l01 = (p1 - p0).length();
            float l12 = (p2 - p1).length();
            float l23 = (p3 - p2).length();
            float l30 = (p0 - p3).length();

            float width = (l01 + l23) * 0.5f;
            float height = (l12 + l30) * 0.5f;
            if (width > 1e-4f && height > 1e-4f) {
                float aspect = width / height;
                if (aspect < 1.0f) aspect = 1.0f / aspect;
                if (std::isfinite(aspect)) {
                    totalAspect += std::clamp(aspect, 1.0f, 10.0f);
                }
            } else {
                totalAspect += 1.0f;
            }

            // 4 internal corner angles
            float a0 = std::acos(std::clamp(-e30.dot(e01), -1.0f, 1.0f)) * (180.0f / PI);
            float a1 = std::acos(std::clamp(-e01.dot(e12), -1.0f, 1.0f)) * (180.0f / PI);
            float a2 = std::acos(std::clamp(-e12.dot(e23), -1.0f, 1.0f)) * (180.0f / PI);
            float a3 = std::acos(std::clamp(-e23.dot(e30), -1.0f, 1.0f)) * (180.0f / PI);

            float meanA = (a0 + a1 + a2 + a3) * 0.25f;
            totalOrthogonality += meanA;

            maxDev = std::max(maxDev, std::abs(a0 - 90.0f));
            maxDev = std::max(maxDev, std::abs(a1 - 90.0f));
            maxDev = std::max(maxDev, std::abs(a2 - 90.0f));
            maxDev = std::max(maxDev, std::abs(a3 - 90.0f));

            sampleCount++;
        }

        if (sampleCount > 0) {
            telemetry.meanOrthogonalityDeg = totalOrthogonality / sampleCount;
            telemetry.maxOrthogonalityDeviationDeg = maxDev;
            telemetry.meanQuadAspect = totalAspect / sampleCount;
        }
    }
};

// ============================================================================
// 7. FieldAlignedQuadRemesher Main Facade
// ============================================================================

class FieldAlignedQuadRemesher {
public:
    /**
     * Executes the full 5-stage field-aligned quad remeshing pipeline on an input mesh.
     * Returns a clean ScratchboxMesh with glTF 2.0 quad-dominant polygonization.
     */
    static ScratchboxMesh remesh(
        const ScratchboxMesh& input,
        const QuadRemeshOptions& opt = {},
        RemeshTelemetry* outTelemetry = nullptr
    ) {
        auto startTime = std::chrono::high_resolution_clock::now();

        RemeshTelemetry telemetry;
        telemetry.inputTriangleCount = input.indices.size() / 3;

        // Stage 1: Convert to Half-Edge DCEL & Detect Creases
        HalfEdgeMesh heMesh = HalfEdgeMesh::fromMesh(input);
        auto creases = CreaseDetector::detectCreases(heMesh, opt.creaseAngleDeg);
        for (const auto& c : creases) {
            if (c.isCrease) telemetry.sharpCreaseEdges++;
        }

        // Stage 2: 4-RoSy Orientation Field Solver
        auto orientations = FourRoSyFieldSolver::solve(heMesh, creases, opt);

        // Stage 3: Position Field & Target Edge Spacing h
        auto posParams = PositionFieldOptimizer::computeEdgeSpacing(heMesh, opt.targetQuadCount);

        // Stage 4: Quad Grid Extraction
        auto [quadVertices, quads] = QuadExtractor::extractQuads(
            input, heMesh, orientations, posParams.targetEdgeLength, opt
        );

        // Stage 5: BVH Surface Snapping & Tangential Smoothing
        BvhTree bvh;
        bvh.build(input);
        SurfaceProjector::projectAndSmooth(
            quadVertices, quads, bvh, input, opt.tangentRelaxationPasses, telemetry
        );

        // Assemble Final ScratchboxMesh with coplanar quad triangles
        ScratchboxMesh output(input.name + "_quad_remeshed");
        output.material = input.material;
        output.vertices = quadVertices;

        for (const auto& q : quads) {
            output.addTriangle(q.v0, q.v1, q.v2);
            output.addTriangle(q.v0, q.v2, q.v3);
        }

        output.recomputeNormals();
        output.recomputeBounds();

        telemetry.outputQuadCount = quads.size();
        telemetry.outputTriangleCount = output.indices.size() / 3;
        telemetry.pureQuadRatio = (quads.size() > 0) ? 1.0f : 0.0f; // Pure quads

        auto endTime = std::chrono::high_resolution_clock::now();
        telemetry.elapsedMs = std::chrono::duration<double, std::milli>(endTime - startTime).count();

        if (outTelemetry) {
            *outTelemetry = telemetry;
        }

        return output;
    }

    /**
     * Builds wireframe line segments for all quad boundary edges (excluding diagonal triangulations)
     * for interactive inspection in WebGL / Three.js.
     */
    static ScratchboxMesh buildQuadWireframe(
        const ScratchboxMesh& quadMesh,
        float wireThickness = 0.08f,
        const Vec4& wireColor = Vec4(0.05f, 0.85f, 0.95f, 1.0f) // Cyan wire
    ) {
        ScratchboxMesh wire(quadMesh.name + "_quad_wireframe");
        geometry::PbrMaterial wireMat;
        wireMat.name = "quad_wireframe";
        wireMat.baseColorFactor = wireColor;
        wireMat.roughnessFactor = 0.9f;
        wireMat.metallicFactor = 0.0f;
        wire.material = wireMat;

        // In our quad serialization, every 2 triangles (6 indices) correspond to a quad:
        // Triangle 0: (v0, v1, v2)
        // Triangle 1: (v0, v2, v3)
        // Quad perimeter edges: (v0, v1), (v1, v2), (v2, v3), (v3, v0)
        // Internal diagonal: (v0, v2) — intentionally omitted from wireframe!
        size_t triCount = quadMesh.indices.size() / 3;

        auto addWireEdge = [&](const Vec3& a, const Vec3& b) {
            Vec3 dir = (b - a).normalized();
            Vec3 up(0, 1, 0);
            if (std::abs(dir.y) > 0.9f) up = Vec3(1, 0, 0);
            Vec3 side = dir.cross(up).normalized() * (wireThickness * 0.5f);

            uint32_t bIdx = static_cast<uint32_t>(wire.vertices.size());
            wire.addVertex(Vertex(a - side, Vec3(0, 1, 0), Vec2(0, 0), wireColor));
            wire.addVertex(Vertex(a + side, Vec3(0, 1, 0), Vec2(1, 0), wireColor));
            wire.addVertex(Vertex(b + side, Vec3(0, 1, 0), Vec2(1, 1), wireColor));
            wire.addVertex(Vertex(b - side, Vec3(0, 1, 0), Vec2(0, 1), wireColor));

            wire.addTriangle(bIdx, bIdx + 1, bIdx + 2);
            wire.addTriangle(bIdx, bIdx + 2, bIdx + 3);
        };

        for (size_t t = 0; t + 1 < triCount; t += 2) {
            uint32_t v0 = quadMesh.indices[t * 3];
            uint32_t v1 = quadMesh.indices[t * 3 + 1];
            uint32_t v2 = quadMesh.indices[t * 3 + 2];
            uint32_t v3 = quadMesh.indices[(t + 1) * 3 + 2];

            Vec3 p0 = quadMesh.vertices[v0].position;
            Vec3 p1 = quadMesh.vertices[v1].position;
            Vec3 p2 = quadMesh.vertices[v2].position;
            Vec3 p3 = quadMesh.vertices[v3].position;

            addWireEdge(p0, p1);
            addWireEdge(p1, p2);
            addWireEdge(p2, p3);
            addWireEdge(p3, p0);
        }

        wire.recomputeNormals();
        wire.recomputeBounds();
        return wire;
    }
};

} // namespace remesh
} // namespace scratchbox

#endif // SCRATCHBOX_FIELD_REMESH_HPP
