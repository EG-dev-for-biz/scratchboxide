/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

#ifndef SCRATCHBOX_MESH_AUDIT_HPP
#define SCRATCHBOX_MESH_AUDIT_HPP

// Topology and distance audit for remeshing: weld by position, count open and non-manifold edges, components, Euler
// characteristic and genus, and the two-sided Hausdorff distance between two surfaces by area-weighted sampling.
// Shared by the voxel remesh, the field quad remesh and the generated-mesh cleanup, so every stage is judged the same way.

#include "scratchbox_geometry.hpp"
#include "scratchbox_bvh.hpp"

#include <algorithm>
#include <array>
#include <atomic>
#include <cmath>
#include <cstdint>
#include <cstring>
#include <functional>
#include <numeric>
#include <random>
#include <thread>
#include <unordered_map>
#include <vector>

namespace scratchbox {
namespace mesh_audit {

using math::Vec3;
using geometry::ScratchboxMesh;

/** Runs fn(i) for i in [0, n) on up to `threads` threads (0 = hardware concurrency), in contiguous chunks. */
inline void parallelFor(size_t n, const std::function<void(size_t, size_t)>& chunk, unsigned threads = 0) {
    if (n == 0) return;
    unsigned hw = threads ? threads : std::max(1u, std::thread::hardware_concurrency());
    unsigned t = static_cast<unsigned>(std::min<size_t>(hw, (n + 1023) / 1024));
    if (t <= 1) { chunk(0, n); return; }
    std::vector<std::thread> pool;
    size_t step = (n + t - 1) / t;
    for (unsigned k = 0; k < t; ++k) {
        size_t a = k * step, b = std::min(n, a + step);
        if (a >= b) break;
        pool.emplace_back([&, a, b] { chunk(a, b); });
    }
    for (auto& th : pool) th.join();
}

/** An indexed triangle soup welded by position: seam-split vertices (UV or normal seams) become one vertex. */
struct WeldedTriangles {
    std::vector<Vec3> positions;
    std::vector<std::array<uint32_t, 3>> triangles;
    std::vector<uint32_t> remap;  // source vertex -> welded vertex
};

/** Welds vertices closer than `tolerance` (by a hashed grid of that cell size; 0 = exact position match; < 0 = no weld). */
inline WeldedTriangles weldByPosition(const ScratchboxMesh& mesh, float tolerance = 0.0f) {
    WeldedTriangles w;
    w.remap.resize(mesh.vertices.size());
    if (tolerance < 0.0f) {  // no weld: the mesh's own indices
        for (size_t i = 0; i < mesh.vertices.size(); ++i) { w.remap[i] = uint32_t(i); w.positions.push_back(mesh.vertices[i].position); }
        for (size_t t = 0; t + 2 < mesh.indices.size(); t += 3) w.triangles.push_back({mesh.indices[t], mesh.indices[t + 1], mesh.indices[t + 2]});
        return w;
    }
    const double cell = tolerance > 0.0f ? tolerance : 0.0;
    auto keyOf = [&](const Vec3& p) -> std::array<int64_t, 3> {
        if (cell <= 0.0) {
            int32_t ix, iy, iz;
            std::memcpy(&ix, &p.x, 4); std::memcpy(&iy, &p.y, 4); std::memcpy(&iz, &p.z, 4);
            return {ix, iy, iz};
        }
        return {static_cast<int64_t>(std::floor(p.x / cell)), static_cast<int64_t>(std::floor(p.y / cell)), static_cast<int64_t>(std::floor(p.z / cell))};
    };
    struct KeyHash {
        size_t operator()(const std::array<int64_t, 3>& k) const {
            uint64_t h = static_cast<uint64_t>(k[0]) * 0x9E3779B97F4A7C15ull;
            h ^= static_cast<uint64_t>(k[1]) * 0xC2B2AE3D27D4EB4Full + (h << 6) + (h >> 2);
            h ^= static_cast<uint64_t>(k[2]) * 0x165667B19E3779F9ull + (h << 6) + (h >> 2);
            return static_cast<size_t>(h);
        }
    };
    std::unordered_map<std::array<int64_t, 3>, uint32_t, KeyHash> map;
    map.reserve(mesh.vertices.size());
    for (size_t i = 0; i < mesh.vertices.size(); ++i) {
        const Vec3& p = mesh.vertices[i].position;
        auto k = keyOf(p);
        uint32_t found = UINT32_MAX;
        if (cell > 0.0) {
            // the 27 neighbouring cells, so two points either side of a cell wall still weld
            for (int dx = -1; dx <= 1 && found == UINT32_MAX; ++dx)
                for (int dy = -1; dy <= 1 && found == UINT32_MAX; ++dy)
                    for (int dz = -1; dz <= 1 && found == UINT32_MAX; ++dz) {
                        auto it = map.find({k[0] + dx, k[1] + dy, k[2] + dz});
                        if (it != map.end() && (w.positions[it->second] - p).length() <= tolerance) found = it->second;
                    }
        } else {
            auto it = map.find(k);
            if (it != map.end()) found = it->second;
        }
        if (found == UINT32_MAX) {
            found = static_cast<uint32_t>(w.positions.size());
            w.positions.push_back(p);
            map.emplace(k, found);
        }
        w.remap[i] = found;
    }
    for (size_t t = 0; t + 2 < mesh.indices.size(); t += 3) {
        std::array<uint32_t, 3> tri{w.remap[mesh.indices[t]], w.remap[mesh.indices[t + 1]], w.remap[mesh.indices[t + 2]]};
        w.triangles.push_back(tri);
    }
    return w;
}

struct TopologyReport {
    size_t vertices{0};            // after the weld
    size_t triangles{0};
    size_t degenerateTriangles{0}; // two corners on one welded vertex
    size_t edges{0};
    size_t openEdges{0};           // used by one triangle
    size_t nonManifoldEdges{0};    // used by three or more triangles
    size_t nonManifoldVertices{0}; // a vertex whose triangle fan splits into several sheets
    size_t misorientedEdges{0};    // an edge two triangles traverse in the same direction
    size_t components{0};
    long long eulerCharacteristic{0};
    /** Sum over closed components of (2 - chi_c) / 2; -1 when any component is open or non-manifold. */
    long long genus{-1};
    bool watertight{false};        // no open edge, no non-manifold edge or vertex, consistent orientation
};

/** Topology of a triangle mesh after welding by `weldTolerance` (0 = exact positions). */
inline TopologyReport auditTopology(const ScratchboxMesh& mesh, float weldTolerance = 0.0f) {
    TopologyReport r;
    WeldedTriangles w = weldByPosition(mesh, weldTolerance);
    r.vertices = w.positions.size();
    std::vector<std::array<uint32_t, 3>> tris;
    tris.reserve(w.triangles.size());
    for (const auto& t : w.triangles) {
        if (t[0] == t[1] || t[1] == t[2] || t[2] == t[0]) { r.degenerateTriangles++; continue; }
        tris.push_back(t);
    }
    r.triangles = tris.size();

    // undirected edge -> (uses, net direction)
    struct EdgeUse { uint32_t count{0}; int32_t dir{0}; uint32_t firstTri{0}; };
    std::unordered_map<uint64_t, EdgeUse> edges;
    edges.reserve(tris.size() * 2);
    for (size_t f = 0; f < tris.size(); ++f) {
        for (int k = 0; k < 3; ++k) {
            uint32_t a = tris[f][k], b = tris[f][(k + 1) % 3];
            uint64_t key = a < b ? (static_cast<uint64_t>(a) << 32 | b) : (static_cast<uint64_t>(b) << 32 | a);
            auto& e = edges[key];
            if (e.count == 0) e.firstTri = static_cast<uint32_t>(f);
            e.count++;
            e.dir += a < b ? 1 : -1;
        }
    }
    r.edges = edges.size();
    for (const auto& [key, e] : edges) {
        if (e.count == 1) r.openEdges++;
        else if (e.count > 2) r.nonManifoldEdges++;
        else if (e.dir != 0) r.misorientedEdges++;
    }

    // components by union-find over shared vertices
    std::vector<uint32_t> parent(r.vertices);
    std::iota(parent.begin(), parent.end(), 0u);
    std::function<uint32_t(uint32_t)> find = [&](uint32_t x) {
        while (parent[x] != x) { parent[x] = parent[parent[x]]; x = parent[x]; }
        return x;
    };
    std::vector<uint8_t> used(r.vertices, 0);
    for (const auto& t : tris) {
        used[t[0]] = used[t[1]] = used[t[2]] = 1;
        uint32_t a = find(t[0]), b = find(t[1]), c = find(t[2]);
        parent[b] = a; parent[find(c)] = find(a);
    }
    std::unordered_map<uint32_t, uint32_t> compIndex;
    size_t usedVerts = 0;
    for (uint32_t v = 0; v < r.vertices; ++v) if (used[v]) { usedVerts++; compIndex.emplace(find(v), static_cast<uint32_t>(compIndex.size())); }
    r.components = compIndex.size();
    r.eulerCharacteristic = static_cast<long long>(usedVerts) - static_cast<long long>(r.edges) + static_cast<long long>(r.triangles);

    // non-manifold vertices: the triangle fan around a vertex, linked across its manifold edges, must be one sheet
    {
        std::vector<std::vector<uint32_t>> vt(r.vertices);
        for (uint32_t f = 0; f < tris.size(); ++f) for (int k = 0; k < 3; ++k) vt[tris[f][k]].push_back(f);
        for (uint32_t v = 0; v < r.vertices; ++v) {
            const auto& fan = vt[v];
            if (fan.size() <= 1) continue;
            // local union-find over the fan: two triangles join when they share an edge through v
            std::vector<uint32_t> lp(fan.size());
            std::iota(lp.begin(), lp.end(), 0u);
            auto lf = [&](uint32_t x) { while (lp[x] != x) { lp[x] = lp[lp[x]]; x = lp[x]; } return x; };
            std::unordered_map<uint32_t, uint32_t> otherToTri;
            for (uint32_t i = 0; i < fan.size(); ++i) {
                const auto& t = tris[fan[i]];
                for (int k = 0; k < 3; ++k) {
                    uint32_t o = t[k];
                    if (o == v) continue;
                    auto it = otherToTri.find(o);
                    if (it == otherToTri.end()) otherToTri.emplace(o, i);
                    else lp[lf(i)] = lf(it->second);
                }
            }
            uint32_t root = lf(0);
            for (uint32_t i = 1; i < fan.size(); ++i) if (lf(i) != root) { r.nonManifoldVertices++; break; }
        }
    }

    // genus per closed component: chi_c = V_c - E_c + F_c, g_c = (2 - chi_c) / 2
    bool allClosed = r.openEdges == 0 && r.nonManifoldEdges == 0 && r.nonManifoldVertices == 0;
    r.watertight = allClosed && r.misorientedEdges == 0 && r.triangles > 0;
    if (allClosed) {
        std::vector<long long> cv(r.components, 0), ce(r.components, 0), cf(r.components, 0);
        for (uint32_t v = 0; v < r.vertices; ++v) if (used[v]) cv[compIndex[find(v)]]++;
        for (const auto& t : tris) cf[compIndex[find(t[0])]]++;
        for (const auto& [key, e] : edges) ce[compIndex[find(static_cast<uint32_t>(key >> 32))]]++;
        long long g = 0;
        for (size_t c = 0; c < r.components; ++c) g += (2 - (cv[c] - ce[c] + cf[c])) / 2;
        r.genus = g;
    }
    return r;
}

/** Area-weighted random points on a triangle mesh (deterministic for a seed), plus every vertex. */
inline std::vector<Vec3> sampleSurface(const ScratchboxMesh& mesh, size_t count, uint32_t seed = 7) {
    std::vector<Vec3> pts;
    size_t T = mesh.indices.size() / 3;
    if (T == 0) return pts;
    std::vector<double> cdf(T);
    double acc = 0.0;
    for (size_t t = 0; t < T; ++t) {
        const Vec3& a = mesh.vertices[mesh.indices[t * 3]].position;
        const Vec3& b = mesh.vertices[mesh.indices[t * 3 + 1]].position;
        const Vec3& c = mesh.vertices[mesh.indices[t * 3 + 2]].position;
        acc += 0.5 * (b - a).cross(c - a).length();
        cdf[t] = acc;
    }
    std::mt19937 rng(seed);
    std::uniform_real_distribution<double> U(0.0, 1.0);
    pts.reserve(count + mesh.vertices.size());
    for (size_t i = 0; i < count && acc > 0.0; ++i) {
        size_t t = static_cast<size_t>(std::lower_bound(cdf.begin(), cdf.end(), U(rng) * acc) - cdf.begin());
        t = std::min(t, T - 1);
        double r1 = std::sqrt(U(rng)), r2 = U(rng);
        const Vec3& a = mesh.vertices[mesh.indices[t * 3]].position;
        const Vec3& b = mesh.vertices[mesh.indices[t * 3 + 1]].position;
        const Vec3& c = mesh.vertices[mesh.indices[t * 3 + 2]].position;
        pts.push_back(a * static_cast<float>(1.0 - r1) + b * static_cast<float>(r1 * (1.0 - r2)) + c * static_cast<float>(r1 * r2));
    }
    for (const auto& v : mesh.vertices) pts.push_back(v.position);
    return pts;
}

struct OneSidedDistance { double max{0}, mean{0}, rms{0}, p95{0}; size_t samples{0}; };

/** Distances from points to the surface a BVH was built on. */
inline OneSidedDistance distancesToSurface(const std::vector<Vec3>& pts, const bvh::BvhTree& target) {
    OneSidedDistance d;
    std::vector<float> dist(pts.size(), 0.0f);
    parallelFor(pts.size(), [&](size_t a, size_t b) {
        for (size_t i = a; i < b; ++i) {
            float sq = 0.0f;
            target.closestPoint(pts[i], sq);
            dist[i] = std::isfinite(sq) ? std::sqrt(sq) : 0.0f;
        }
    });
    d.samples = dist.size();
    if (dist.empty()) return d;
    double s = 0.0, s2 = 0.0;
    for (float x : dist) { s += x; s2 += double(x) * x; d.max = std::max<double>(d.max, x); }
    d.mean = s / dist.size();
    d.rms = std::sqrt(s2 / dist.size());
    std::vector<float> sorted = dist;
    size_t k = static_cast<size_t>(0.95 * (sorted.size() - 1));
    std::nth_element(sorted.begin(), sorted.begin() + k, sorted.end());
    d.p95 = sorted[k];
    return d;
}

struct HausdorffReport {
    OneSidedDistance resultToSource;  // how far the result strays from the source
    OneSidedDistance sourceToResult;  // how much of the source the result misses
    double hausdorff{0};              // max of the two maxima
    double diagonal{0};               // the source's bounding-box diagonal, for relative figures
};

/** Two-sided Hausdorff distance by `samples` area-weighted points on each surface (plus their vertices). */
inline HausdorffReport hausdorff(const ScratchboxMesh& source, const ScratchboxMesh& result, size_t samples = 200000) {
    HausdorffReport h;
    bvh::BvhTree srcBvh, resBvh;
    srcBvh.build(source);
    resBvh.build(result);
    h.resultToSource = distancesToSurface(sampleSurface(result, samples, 11), srcBvh);
    h.sourceToResult = distancesToSurface(sampleSurface(source, samples, 13), resBvh);
    h.hausdorff = std::max(h.resultToSource.max, h.sourceToResult.max);
    geometry::AABB b;
    for (const auto& v : source.vertices) b.expand(v.position);
    h.diagonal = source.vertices.empty() ? 0.0 : b.size().length();
    return h;
}

/** The bounding-box diagonal of a mesh. */
inline double diagonalOf(const ScratchboxMesh& mesh) {
    geometry::AABB b;
    for (const auto& v : mesh.vertices) b.expand(v.position);
    return mesh.vertices.empty() ? 0.0 : b.size().length();
}

} // namespace mesh_audit
} // namespace scratchbox

#endif // SCRATCHBOX_MESH_AUDIT_HPP
