/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

#ifndef SCRATCHBOX_GENERATED_CLEANUP_HPP
#define SCRATCHBOX_GENERATED_CLEANUP_HPP

// Cleanup for generated meshes (image-to-3D models, generated objects): a watertight voxel remesh, a field-aligned
// quad remesh of that, Catmull-Clark subdivision (Catmull & Clark 1978), then the source's detail put back by casting
// both ways along each vertex normal and taking the nearest hit within a distance. The result is labelled generated.
// Never for measured scan geometry: a scan is judged by its fit and is never remeshed or padded (AGENTS.md 3.3); the
// caller (generated-mesh-cleanup-service.ts) refuses anything not labelled generated.

#include "scratchbox_geometry.hpp"
#include "scratchbox_bvh.hpp"
#include "scratchbox_mesh_audit.hpp"
#include "scratchbox_voxel_remesh.hpp"
#include "scratchbox_field_remesh.hpp"

#include <algorithm>
#include <chrono>
#include <cmath>
#include <sstream>
#include <string>
#include <unordered_map>
#include <vector>

namespace scratchbox {
namespace generated_cleanup {

using math::Vec3;
using geometry::ScratchboxMesh;
using geometry::Vertex;
using remesh::PolyMesh;

/** One Catmull-Clark step on a polygon mesh: every face becomes quads; open edges follow the boundary rules. */
inline PolyMesh catmullClark(const PolyMesh& in) {
    PolyMesh out;
    const size_t V = in.positions.size(), F = in.faceCount();
    // undirected edges
    std::unordered_map<uint64_t, uint32_t> edgeId;
    std::vector<std::array<uint32_t, 2>> ev;
    std::vector<std::array<int64_t, 2>> ef;  // the faces on each edge
    std::vector<uint32_t> faceEdgeIdx(in.faceVerts.size());
    for (size_t f = 0; f < F; ++f) {
        uint32_t s = in.faceStart[f], d = in.degree(f);
        for (uint32_t k = 0; k < d; ++k) {
            uint32_t a = in.faceVerts[s + k], b = in.faceVerts[s + (k + 1) % d];
            uint64_t key = a < b ? (uint64_t(a) << 32 | b) : (uint64_t(b) << 32 | a);
            auto it = edgeId.find(key);
            if (it == edgeId.end()) { it = edgeId.emplace(key, uint32_t(ev.size())).first; ev.push_back({a, b}); ef.push_back({int64_t(f), -1}); }
            else if (ef[it->second][1] < 0 && ef[it->second][0] != int64_t(f)) ef[it->second][1] = int64_t(f);
            faceEdgeIdx[s + k] = it->second;
        }
    }
    const size_t E = ev.size();
    std::vector<Vec3> fp(F);
    for (size_t f = 0; f < F; ++f) {
        Vec3 c(0, 0, 0);
        uint32_t s = in.faceStart[f], d = in.degree(f);
        for (uint32_t k = 0; k < d; ++k) c += in.positions[in.faceVerts[s + k]];
        fp[f] = c * (1.0f / float(d));
    }
    std::vector<Vec3> ep(E);
    std::vector<uint8_t> boundaryEdge(E, 0);
    for (size_t e = 0; e < E; ++e) {
        const Vec3 &a = in.positions[ev[e][0]], &b = in.positions[ev[e][1]];
        if (ef[e][1] < 0) { boundaryEdge[e] = 1; ep[e] = (a + b) * 0.5f; }
        else ep[e] = (a + b + fp[ef[e][0]] + fp[ef[e][1]]) * 0.25f;
    }
    // vertex points
    std::vector<Vec3> faceSum(V, Vec3(0, 0, 0)), midSum(V, Vec3(0, 0, 0)), bndSum(V, Vec3(0, 0, 0));
    std::vector<uint32_t> nFaces(V, 0), nEdges(V, 0), nBnd(V, 0);
    for (size_t f = 0; f < F; ++f) {
        uint32_t s = in.faceStart[f], d = in.degree(f);
        for (uint32_t k = 0; k < d; ++k) { faceSum[in.faceVerts[s + k]] += fp[f]; nFaces[in.faceVerts[s + k]]++; }
    }
    for (size_t e = 0; e < E; ++e) {
        const Vec3 &a = in.positions[ev[e][0]], &b = in.positions[ev[e][1]];
        Vec3 mid = (a + b) * 0.5f;
        for (int k = 0; k < 2; ++k) { midSum[ev[e][k]] += mid; nEdges[ev[e][k]]++; }
        if (boundaryEdge[e]) { bndSum[ev[e][0]] += b; bndSum[ev[e][1]] += a; nBnd[ev[e][0]]++; nBnd[ev[e][1]]++; }
    }
    out.positions.resize(V + E + F);
    for (size_t v = 0; v < V; ++v) {
        const Vec3& S = in.positions[v];
        if (nBnd[v] == 2) out.positions[v] = (bndSum[v] + S * 6.0f) * 0.125f;
        else if (nBnd[v] > 0 || nFaces[v] == 0 || nEdges[v] < 3) out.positions[v] = S;  // corner / non-manifold: kept
        else {
            float n = float(nEdges[v]);
            Vec3 Q = faceSum[v] * (1.0f / float(nFaces[v])), R = midSum[v] * (1.0f / n);
            out.positions[v] = (Q + R * 2.0f + S * (n - 3.0f)) * (1.0f / n);
        }
    }
    for (size_t e = 0; e < E; ++e) out.positions[V + e] = ep[e];
    for (size_t f = 0; f < F; ++f) out.positions[V + E + f] = fp[f];
    for (size_t f = 0; f < F; ++f) {
        uint32_t s = in.faceStart[f], d = in.degree(f);
        for (uint32_t k = 0; k < d; ++k) {
            uint32_t v = in.faceVerts[s + k];
            uint32_t eNext = uint32_t(V) + faceEdgeIdx[s + k];
            uint32_t ePrev = uint32_t(V) + faceEdgeIdx[s + (k + d - 1) % d];
            out.addFace({v, eNext, uint32_t(V + E + f), ePrev});
        }
    }
    return out;
}

struct ProjectionReport { size_t vertices{0}, hits{0}, nearest{0}, misses{0}; double meanMove{0}, maxMove{0}; };

/**
 * Moves each vertex to the nearest source surface hit along +-its normal within maxDistance (a surface facing the
 * vertex's way: the source's normals must be outward, as recomputed from its winding); with no hit, to the
 * nearest source point when that is within half of maxDistance (counted apart); else it stays. Normals are the polygon
 * mesh's own, area weighted.
 */
inline ProjectionReport projectDetail(PolyMesh& poly, const bvh::BvhTree& source, double maxDistance, unsigned threads = 0) {
    ProjectionReport r;
    const size_t V = poly.positions.size();
    r.vertices = V;
    std::vector<Vec3> n(V, Vec3(0, 0, 0));
    for (size_t f = 0; f < poly.faceCount(); ++f) {
        uint32_t s = poly.faceStart[f], d = poly.degree(f);
        for (uint32_t k = 0; k < d; ++k) {
            const Vec3& a = poly.positions[poly.faceVerts[s + k]];
            const Vec3& b = poly.positions[poly.faceVerts[s + (k + 1) % d]];
            const Vec3& c = poly.positions[poly.faceVerts[s + (k + d - 1) % d]];
            n[poly.faceVerts[s + k]] += (b - a).cross(c - a);
        }
    }
    std::vector<Vec3> next = poly.positions;
    std::vector<float> moved(V, -1.0f);
    std::vector<uint8_t> nearestFlag(V, 0);
    mesh_audit::parallelFor(V, [&](size_t a0, size_t a1) {
        for (size_t i = a0; i < a1; ++i) {
            Vec3 nn = n[i].normalized();
            if (nn.lengthSquared() == 0) continue;
            const Vec3& p = poly.positions[i];
            float best = std::numeric_limits<float>::infinity();
            Vec3 hitP = p;
            for (float sgn : {1.0f, -1.0f}) {
                // start a hair behind the vertex so a surface through the vertex itself is found
                Vec3 dir = nn * sgn;
                Vec3 o = p - dir * float(1e-4 * maxDistance);
                math::Ray ray(o, dir);
                bvh::RayHit hit;
                hit.t = float(maxDistance * (1.0 + 1e-4));
                // only a surface facing the same way: on a part thinner than the reach, the far side's surface must
                // not pull this side onto it (both sides on one sheet is a zero-thickness fold)
                if (source.raycast(ray, hit) && hit.normal.dot(nn) > 0.0f) {
                    float t = std::max(0.0f, hit.t - float(1e-4 * maxDistance));
                    if (t < best) { best = t; hitP = hit.position; }
                }
            }
            if (std::isfinite(best)) { next[i] = hitP; moved[i] = best; continue; }
            // no hit along the normal (the normal grazes the source, or a sealed gap): the nearest source point,
            // only when it is within the same reach
            float d2 = 0.0f;
            Vec3 c = source.closestPoint(p, d2);
            // (and only roughly along the normal: around a convex corner the nearest point of many vertices is the
            // corner itself, and snapping them all onto it would stack vertices on one point)
            Vec3 dc = c - p;
            float dl = dc.length();
            bool alongNormal = dl < 1e-12f || std::abs(dc.dot(nn)) >= 0.7f * dl;
            if (std::isfinite(d2) && dl <= 0.5 * maxDistance && alongNormal) { next[i] = c; moved[i] = dl; nearestFlag[i] = 1; }
        }
    }, threads);
    double sum = 0;
    for (size_t i = 0; i < V; ++i) {
        if (moved[i] < 0) { r.misses++; continue; }
        (nearestFlag[i] ? r.nearest : r.hits)++;
        sum += moved[i];
        r.maxMove = std::max<double>(r.maxMove, moved[i]);
    }
    r.meanMove = (r.hits + r.nearest) ? sum / double(r.hits + r.nearest) : 0.0;
    poly.positions.swap(next);
    return r;
}

struct CleanupOptions {
    size_t targetQuads{6000};       // quads of the remesh before subdivision
    int subdivisions{1};            // Catmull-Clark steps (each multiplies the faces by about 4)
    int voxelsPerQuadEdge{3};       // voxel size = quad spacing / this
    int maxVoxelResolution{768};    // voxels along the diagonal at most (bounds memory and time)
    int closeRadius{2};             // gap closing in voxels
    double projectDistanceFactor{1.5};  // detail projection reach, in quad spacings of the remesh / 2^subdivisions... see below
    float creaseAngleDeg{60.0f};      // the voxel surface's staircase reads as creases below this
    unsigned threads{0};
};

struct CleanupReport {
    voxel_remesh::VoxelRemeshReport voxel;
    remesh::RemeshTelemetry quad;
    size_t subdividedFaces{0};
    ProjectionReport projection;
    double quadSpacing{0};
    double projectDistance{0};
    double msVoxel{0}, msQuad{0}, msSubdivide{0}, msProject{0};
    std::string failure;  // set when a stage could not produce a closed result
};

struct CleanupResult {
    ScratchboxMesh mesh;   // triangulated, labelled generated
    PolyMesh quads;        // the subdivided, projected quad mesh
    CleanupReport report;
};

/** Surface area of a triangle mesh. */
inline double surfaceArea(const ScratchboxMesh& m) {
    double a = 0;
    for (size_t t = 0; t + 2 < m.indices.size(); t += 3) {
        const Vec3& p0 = m.vertices[m.indices[t]].position;
        const Vec3& p1 = m.vertices[m.indices[t + 1]].position;
        const Vec3& p2 = m.vertices[m.indices[t + 2]].position;
        a += 0.5 * (p1 - p0).cross(p2 - p0).length();
    }
    return a;
}

/** The full cleanup: voxel (watertight) -> quad remesh -> subdivision -> detail projection from the source. */
inline CleanupResult cleanupGenerated(const ScratchboxMesh& source, const CleanupOptions& opt = {}) {
    using clock = std::chrono::steady_clock;
    auto ms = [](clock::time_point a) { return std::chrono::duration<double, std::milli>(clock::now() - a).count(); };
    CleanupResult res;
    CleanupReport& rep = res.report;
    const double diag = mesh_audit::diagonalOf(source);
    if (source.indices.size() < 3 || !(diag > 0)) { rep.failure = "the source has no surface"; return res; }

    // 1. watertight voxel remesh. Its area (outer surface only) sets the quad spacing.
    auto t0 = clock::now();
    double area0 = surfaceArea(source);
    double hGuess = std::sqrt(area0 / double(std::max<size_t>(64, opt.targetQuads)));
    double voxel = std::max(hGuess / std::max(1, opt.voxelsPerQuadEdge), diag / std::max(64, opt.maxVoxelResolution));
    voxel_remesh::VoxelRemeshOptions vo;
    vo.voxelSize = voxel;
    vo.closeRadius = opt.closeRadius;
    vo.threads = opt.threads;
    auto vox = voxel_remesh::voxelRemesh(source, vo);
    rep.voxel = vox.report;
    rep.msVoxel = ms(t0);
    if (vox.mesh.indices.empty()) { rep.failure = "voxel remesh: " + vox.report.note; return res; }

    // 2. quad remesh of the closed voxel surface, at the spacing its own area gives the quad budget
    t0 = clock::now();
    double area1 = surfaceArea(vox.mesh);
    double h = std::sqrt(area1 / double(std::max<size_t>(64, opt.targetQuads)));
    h = std::max(h, 2.0 * voxel);
    rep.quadSpacing = h;
    remesh::QuadRemeshOptions qo;
    qo.targetEdgeLength = h;
    qo.alignToManhattanAxes = false;
    qo.creaseAngleDeg = opt.creaseAngleDeg;
    qo.weldInput = false;  // the voxel surface is indexed and manifold; a weld would merge sheets that touch
    PolyMesh quads = remesh::FieldAlignedQuadRemesher::remeshToPolygons(vox.mesh, qo, &rep.quad);
    rep.msQuad = ms(t0);
    if (quads.faceCount() == 0) { rep.failure = "quad remesh produced no faces"; return res; }

    // 3. subdivision
    t0 = clock::now();
    for (int i = 0; i < opt.subdivisions; ++i) quads = catmullClark(quads);
    rep.subdividedFaces = quads.faceCount();
    rep.msSubdivide = ms(t0);

    // 4. detail back from the source: reach of the voxel error (about a voxel, more where a gap was sealed) plus the
    //    subdivided surface's own sag from the remesh (a fraction of the spacing)
    t0 = clock::now();
    bvh::BvhTree srcBvh;
    srcBvh.build(source);
    rep.projectDistance = std::max(opt.projectDistanceFactor * 0.5 * h, 2.0 * voxel);
    rep.projection = projectDetail(quads, srcBvh, rep.projectDistance, opt.threads);
    rep.msProject = ms(t0);

    res.mesh = remesh::FieldAlignedQuadRemesher::triangulate(quads, source.name + "_generated_cleanup");
    res.mesh.material = source.material;
    res.mesh.material.extrasJson = "{\"provenance\":\"generated\",\"sbCleanup\":\"voxel+quad+subdivision+projection\"}";
    res.quads = std::move(quads);
    return res;
}

/** The report as JSON (one object), for the TypeScript service and the proof sheets. */
inline std::string reportJson(const CleanupReport& r) {
    std::ostringstream o;
    o.precision(6);
    o << "{\"voxel\":{\"voxelSize\":" << r.voxel.voxelSize << ",\"dims\":[" << r.voxel.dims[0] << "," << r.voxel.dims[1] << "," << r.voxel.dims[2]
      << "],\"blocks\":" << r.voxel.allocatedBlocks << ",\"surfaceVoxels\":" << r.voxel.surfaceVoxels << ",\"signEdges\":" << r.voxel.signEdges
      << ",\"hermiteRay\":" << r.voxel.hermiteRay << ",\"hermiteFallback\":" << r.voxel.hermiteFallback << ",\"multiSheetCells\":" << r.voxel.multiSheetCells
      << ",\"quads\":" << r.voxel.outputQuads << "},";
    o << "\"quad\":{\"spacing\":" << r.quadSpacing << ",\"quads\":" << r.quad.outputQuadCount << ",\"polygons\":" << r.quad.outputPolygonCount
      << ",\"singularities\":" << r.quad.singularityCount << ",\"fieldSingularities\":" << r.quad.orientationSingularities
      << ",\"flowSupply\":" << r.quad.flowSupply << ",\"flowUnmet\":" << r.quad.flowUnmet << ",\"flipped\":" << r.quad.flippedTriangles
      << ",\"holesClosed\":" << r.quad.holesClosed << ",\"meanAngleDeviationDeg\":" << r.quad.meanAngleDeviationDeg
      << ",\"meanScaledJacobian\":" << r.quad.meanScaledJacobian << ",\"minScaledJacobian\":" << r.quad.minScaledJacobian << "},";
    o << "\"subdividedFaces\":" << r.subdividedFaces << ",";
    o << "\"projection\":{\"distance\":" << r.projectDistance << ",\"vertices\":" << r.projection.vertices << ",\"hits\":" << r.projection.hits << ",\"nearest\":" << r.projection.nearest
      << ",\"misses\":" << r.projection.misses << ",\"meanMove\":" << r.projection.meanMove << ",\"maxMove\":" << r.projection.maxMove << "},";
    o << "\"ms\":{\"voxel\":" << r.msVoxel << ",\"quad\":" << r.msQuad << ",\"subdivide\":" << r.msSubdivide << ",\"project\":" << r.msProject << "},";
    o << "\"failure\":\"";
    for (char c : r.failure) { if (c == '"' || c == '\\') o << '\\'; o << c; }
    o << "\"}";
    return o.str();
}

}  // namespace generated_cleanup
}  // namespace scratchbox

#endif  // SCRATCHBOX_GENERATED_CLEANUP_HPP
