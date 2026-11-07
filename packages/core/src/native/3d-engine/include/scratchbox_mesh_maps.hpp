/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

// Maps measured from a mesh's geometry alone: curvature at a set radius, cavity, thickness and ambient occlusion. They
// drive where weathering lands (object_detail_pass, scratchbox_object_detail.hpp) and the finish under Pipeline K's
// photos (material-mesh-maps.ts through scripts/mesh_maps_bake.cpp). Nothing here moves a surface; every map is read.
//
// Written from the published methods, not from any other baker's code:
//   curvature - mean curvature at radius r by averaging normal curvature over the surface around the point. For a point
//               p with unit normal n and a surface point q, the circle through p tangent to the surface that also passes
//               through q has curvature 2 n.(p - q) / |p - q|^2 (exact on a sphere: 1/R for every q); by Euler's theorem
//               the mean over directions spread evenly around p is the mean curvature H = (k1 + k2) / 2. The surface
//               around p is an area-weighted point sampling of the mesh (so the directions are spread evenly on a flat
//               or gently curved surface), taken over the annulus 0.3 r .. r (the inner points sit within one facet of a
//               tessellated surface and would read its flatness, not its curvature). Points facing away from n (the far
//               side of a thin part) are left out. The map is H r, dimensionless: a sphere of radius R reads r / R,
//               a sharp convex edge saturates at +1 on it and falls off over r, a concave crease reads negative.
//   cavity    - the concave part of the same measure at a smaller radius, over every surface (so the crease where two
//               parts meet counts): clamp(-2 H r, 0, 1).
//   thickness - rays cast inward, in a cone around the inward normal: each ray's distance to the first surface it meets,
//               projected onto the normal (so a slab of thickness t reads t whatever the ray's angle), capped at
//               thicknessMaxM (a ray that meets nothing reads the cap); the mean over the rays.
//   ao        - cosine-weighted hemisphere rays: 1 minus the mean occlusion, a hit at distance t within aoRadiusM
//               occluding 1 - t / aoRadiusM (and optionally the ground plane y = groundY).
// Every input is a number; no class of thing is named anywhere.

#pragma once

#include "scratchbox_math.hpp"
#include "scratchbox_geometry.hpp"
#include "scratchbox_bvh.hpp"

#include <algorithm>
#include <atomic>
#include <cmath>
#include <cstdint>
#include <limits>
#include <thread>
#include <unordered_map>
#include <vector>

namespace scratchbox::mesh_maps {

using math::Vec3;

struct Params {
    float curvatureRadiusM = 0.02f;   // the scale curvature is read at
    float cavityRadiusM = 0.005f;     // the scale cavity is read at
    float aoRadiusM = 0.1f;           // occluders further than this do not darken
    int aoSamples = 16;               // 0: no ao
    float thicknessMaxM = 0.05f;      // thicker than this reads the cap
    int thicknessSamples = 8;         // 0: no thickness
    float thicknessConeDeg = 25.0f;   // half-angle of the inward cone
    int samplesPerDisk = 48;          // surface points the annulus of each radius should hold
    size_t maxSamples = 4000000;      // per point set; past it the spacing grows (and the radius with it, reported)
    float rayEpsM = 1e-4f;            // rays leave the surface this far along its normal
    bool ground = false;
    float groundY = 0.0f;
    uint32_t seed = 7;
};

/** One point's maps. */
struct Sample {
    float curvature = 0;              // H r at curvatureRadiusM, convex positive (about -1..1)
    float cavity = 0;                 // 0..1
    float thicknessM = 0;             // metres, capped at thicknessMaxM
    float ao = 1;                     // 1 open, 0 fully occluded
};

constexpr uint32_t kAnyGroup = 0xffffffffu;

namespace detail {

inline uint32_t hashU(uint32_t x) {
    x ^= x >> 16; x *= 0x7feb352du; x ^= x >> 15; x *= 0x846ca68bu; x ^= x >> 16;
    return x;
}
inline float hashF(uint32_t x) { return static_cast<float>(hashU(x) & 0xffffffu) / static_cast<float>(0x1000000); }

/** Area-weighted points on a triangle soup, each with its triangle's normal and a group, filed in a uniform grid. */
struct PointSet {
    float spacing = 1, cell = 1;
    std::vector<Vec3> pos, nrm;
    std::vector<uint32_t> group;
    std::vector<uint32_t> order;                             // point indices sorted by cell
    std::unordered_map<uint64_t, std::pair<uint32_t, uint32_t>> cells;  // cell -> (start in order, count)

    static uint64_t key(int64_t x, int64_t y, int64_t z) {
        return (uint64_t(x & 0x1fffff) << 42) | (uint64_t(y & 0x1fffff) << 21) | uint64_t(z & 0x1fffff);
    }

    /**
     * Points at about `wantSpacing` apart (a triangle gets area / spacing^2 of them, the fraction carried by a hash so
     * small triangles still get their share on average), placed by the R2 low-discrepancy sequence over the triangle.
     * The spacing grows when the set would pass `maxPoints`. The grid's cell is `cellM` (the radius it is queried at).
     */
    void build(const std::vector<float>& soup, const std::vector<uint32_t>* groups, float wantSpacing, size_t maxPoints, float cellM, uint32_t seed) {
        const size_t T = soup.size() / 9;
        double area = 0;
        std::vector<float> triArea(T);
        std::vector<Vec3> triN(T);
        for (size_t t = 0; t < T; ++t) {
            const Vec3 a(soup[t * 9], soup[t * 9 + 1], soup[t * 9 + 2]), b(soup[t * 9 + 3], soup[t * 9 + 4], soup[t * 9 + 5]), c(soup[t * 9 + 6], soup[t * 9 + 7], soup[t * 9 + 8]);
            const Vec3 n = (b - a).cross(c - a);
            const float l = n.length();
            triArea[t] = 0.5f * l;
            triN[t] = l > 1e-20f ? n * (1.0f / l) : Vec3(0, 1, 0);
            area += triArea[t];
        }
        spacing = std::max(1e-6f, wantSpacing);
        if (maxPoints > 0 && area / (double(spacing) * spacing) > double(maxPoints)) spacing = static_cast<float>(std::sqrt(area / double(maxPoints)));
        const double perArea = 1.0 / (double(spacing) * spacing);
        pos.clear(); nrm.clear(); group.clear();
        pos.reserve(size_t(area * perArea) + T / 4);
        const double g1 = 0.7548776662466927, g2 = 0.5698402909980532;   // R2 sequence
        for (size_t t = 0; t < T; ++t) {
            const double want = triArea[t] * perArea;
            size_t n = static_cast<size_t>(want);
            if (hashF(static_cast<uint32_t>(t) * 2654435761u ^ seed) < want - double(n)) ++n;
            if (!n) continue;
            const Vec3 a(soup[t * 9], soup[t * 9 + 1], soup[t * 9 + 2]), b(soup[t * 9 + 3], soup[t * 9 + 4], soup[t * 9 + 5]), c(soup[t * 9 + 6], soup[t * 9 + 7], soup[t * 9 + 8]);
            const double o1 = hashF(static_cast<uint32_t>(t) ^ (seed * 7919u)), o2 = hashF(static_cast<uint32_t>(t) * 31u ^ (seed * 104729u));
            for (size_t k = 0; k < n; ++k) {
                double u = std::fmod(o1 + g1 * double(k + 1), 1.0), v = std::fmod(o2 + g2 * double(k + 1), 1.0);
                if (u + v > 1) { u = 1 - u; v = 1 - v; }
                pos.push_back(a + (b - a) * float(u) + (c - a) * float(v));
                nrm.push_back(triN[t]);
                group.push_back(groups && t < groups->size() ? (*groups)[t] : kAnyGroup);
            }
        }
        cell = std::max(1e-6f, cellM);
        std::vector<std::pair<uint64_t, uint32_t>> keyed(pos.size());
        for (uint32_t i = 0; i < pos.size(); ++i) {
            const Vec3& p = pos[i];
            keyed[i] = {key(int64_t(std::floor(p.x / cell)), int64_t(std::floor(p.y / cell)), int64_t(std::floor(p.z / cell))), i};
        }
        std::sort(keyed.begin(), keyed.end());
        order.resize(keyed.size());
        cells.clear();
        cells.reserve(keyed.size() / 8 + 1);
        for (uint32_t i = 0; i < keyed.size();) {
            uint32_t j = i;
            while (j < keyed.size() && keyed[j].first == keyed[i].first) { order[j] = keyed[j].second; ++j; }
            cells.emplace(keyed[i].first, std::make_pair(i, j - i));
            i = j;
        }
    }

    /** Every point within r of p (the grid's cell must be at least r). */
    template <typename F> void within(const Vec3& p, float r, F&& fn) const {
        const int64_t cx = int64_t(std::floor(p.x / cell)), cy = int64_t(std::floor(p.y / cell)), cz = int64_t(std::floor(p.z / cell));
        const float r2 = r * r;
        for (int dz = -1; dz <= 1; ++dz) for (int dy = -1; dy <= 1; ++dy) for (int dx = -1; dx <= 1; ++dx) {
            auto it = cells.find(key(cx + dx, cy + dy, cz + dz));
            if (it == cells.end()) continue;
            for (uint32_t k = it->second.first, e = it->second.first + it->second.second; k < e; ++k) {
                const uint32_t i = order[k];
                const float d2 = (pos[i] - p).lengthSq();
                if (d2 <= r2) fn(i, d2);
            }
        }
    }
};

}  // namespace detail

/**
 * The maps of one mesh. `soup` (9 floats per triangle) is every surface: rays hit it and cavity reads it. `grouped`
 * (optional, with one group id per triangle) is the surface curvature is read on, each point only against its own
 * group (an object's parts); empty: curvature reads `soup` as one group.
 */
class MeshMaps {
public:
    MeshMaps() = default;
    MeshMaps(const MeshMaps&) = delete;             // the BVH points into mesh_
    MeshMaps& operator=(const MeshMaps&) = delete;
    bool build(const std::vector<float>& soup, const std::vector<float>& grouped, const std::vector<uint32_t>& groups, const Params& p) {
        P = p;
        mesh_ = soupMesh(soup);
        haveBvh_ = mesh_.indices.size() >= 3 && bvh_.build(mesh_);
        // an annulus 0.3 r .. r holds pi r^2 0.91 / spacing^2 points
        const auto spacingFor = [&](float r) { return r * std::sqrt(math::PI * 0.91f / float(std::max(4, P.samplesPerDisk))); };
        cavityPts_.build(soup, nullptr, spacingFor(P.cavityRadiusM), P.maxSamples, P.cavityRadiusM, P.seed);
        cavityR_ = std::max(P.cavityRadiusM, cavityPts_.spacing / std::max(1e-6f, spacingFor(1.0f)));
        if (cavityR_ > cavityPts_.cell) cavityPts_.build(soup, nullptr, cavityPts_.spacing, 0, cavityR_, P.seed);
        if (!grouped.empty()) {
            curvPts_.build(grouped, &groups, spacingFor(P.curvatureRadiusM), P.maxSamples, P.curvatureRadiusM, P.seed + 1);
            curvR_ = std::max(P.curvatureRadiusM, curvPts_.spacing / std::max(1e-6f, spacingFor(1.0f)));
            if (curvR_ > curvPts_.cell) curvPts_.build(grouped, &groups, curvPts_.spacing, 0, curvR_, P.seed + 1);
        } else {
            curvPts_.build(soup, nullptr, spacingFor(P.curvatureRadiusM), P.maxSamples, P.curvatureRadiusM, P.seed + 1);
            curvR_ = std::max(P.curvatureRadiusM, curvPts_.spacing / std::max(1e-6f, spacingFor(1.0f)));
            if (curvR_ > curvPts_.cell) curvPts_.build(soup, nullptr, curvPts_.spacing, 0, curvR_, P.seed + 1);
        }
        return haveBvh_;
    }

    const bvh::BvhTree& bvh() const { return bvh_; }
    bool haveBvh() const { return haveBvh_; }
    /** The radii actually used (larger than asked when the point budget forced a coarser spacing). */
    float curvatureRadius() const { return curvR_; }
    float cavityRadius() const { return cavityR_; }
    size_t curvaturePoints() const { return curvPts_.pos.size(); }
    size_t cavityPoints() const { return cavityPts_.pos.size(); }

    /** Mean curvature H (1/m) at radius r around p with normal n, over `pts` (group `g` only, unless kAnyGroup). */
    static float meanCurvature(const detail::PointSet& pts, const Vec3& p, const Vec3& n, float r, uint32_t g) {
        double sum = 0;
        uint32_t count = 0;
        const float inner2 = 0.09f * r * r;
        pts.within(p, r, [&](uint32_t i, float d2) {
            if (d2 < inner2) return;
            if (g != kAnyGroup && pts.group[i] != g) return;
            if (pts.nrm[i].dot(n) < -0.3f) return;         // the far side of a thin part
            sum += 2.0 * double(n.dot(p - pts.pos[i])) / double(d2);
            ++count;
        });
        return count >= 6 ? static_cast<float>(sum / count) : 0.0f;
    }

    float curvatureAt(const Vec3& p, const Vec3& n, uint32_t group) const { return meanCurvature(curvPts_, p, n, curvR_, group) * curvR_; }
    float cavityAt(const Vec3& p, const Vec3& n) const { return std::min(1.0f, std::max(0.0f, -2.0f * meanCurvature(cavityPts_, p, n, cavityR_, kAnyGroup) * cavityR_)); }  // +0, never -0

    /** Inward thickness (metres, capped) at p with geometric normal ng. */
    float thicknessAt(const Vec3& p, const Vec3& ng, uint32_t salt) const {
        const int S = P.thicknessSamples;
        if (S <= 0 || !haveBvh_) return P.thicknessMaxM;
        const Vec3 in = ng * -1.0f;
        Vec3 tan = std::abs(in.y) < 0.9f ? Vec3(0, 1, 0).cross(in) : Vec3(1, 0, 0).cross(in);
        tan = tan.normalized();
        const Vec3 bit = in.cross(tan);
        const float cosMax = std::cos(std::clamp(P.thicknessConeDeg, 0.0f, 80.0f) * math::PI / 180.0f);
        const float rot = detail::hashF(salt ^ (P.seed * 0x9E3779B9u)) * math::TWO_PI;
        const Vec3 origin = p - ng * P.rayEpsM;
        double sum = 0;
        for (int k = 0; k < S; ++k) {
            // even over the cone's solid angle: cos theta uniform in [cosMax, 1]
            const float ct = S == 1 ? 1.0f : 1.0f - (1.0f - cosMax) * (k + 0.5f) / S;
            const float st = std::sqrt(std::max(0.0f, 1.0f - ct * ct)), phi = rot + k * 2.39996323f;
            const Vec3 dir = (in * ct + tan * (st * std::cos(phi)) + bit * (st * std::sin(phi))).normalized();
            bvh::RayHit hit;
            float d = P.thicknessMaxM;
            if (bvh_.raycast(math::Ray(origin, dir), hit)) d = std::min(P.thicknessMaxM, (hit.t + P.rayEpsM) * ct);
            sum += d;
        }
        return static_cast<float>(sum / S);
    }

    /** Ambient occlusion at p with geometric normal ng: 1 open, 0 closed. */
    float aoAt(const Vec3& p, const Vec3& ng, uint32_t salt) const {
        const int S = P.aoSamples;
        if (S <= 0) return 1.0f;
        Vec3 tan = std::abs(ng.y) < 0.9f ? Vec3(0, 1, 0).cross(ng) : Vec3(1, 0, 0).cross(ng);
        tan = tan.normalized();
        const Vec3 bit = ng.cross(tan);
        const Vec3 origin = p + ng * P.rayEpsM;
        const float rot = detail::hashF(salt ^ (P.seed * 0x85EBCA6Bu)) * math::TWO_PI;
        double occl = 0;
        for (int k = 0; k < S; ++k) {
            const float u1 = (k + 0.5f) / S, r = std::sqrt(u1), phi = rot + k * 2.39996323f;
            const Vec3 dir = (tan * (r * std::cos(phi)) + bit * (r * std::sin(phi)) + ng * std::sqrt(1.0f - u1)).normalized();
            float t = std::numeric_limits<float>::infinity();
            if (haveBvh_) { bvh::RayHit hit; if (bvh_.raycast(math::Ray(origin, dir), hit)) t = hit.t; }
            if (P.ground && dir.y < -1e-4f) { const float tg = (origin.y - P.groundY) / -dir.y; if (tg > 0) t = std::min(t, tg); }
            if (t < P.aoRadiusM) occl += 1.0 - t / P.aoRadiusM;
        }
        return static_cast<float>(1.0 - occl / S);
    }

    /** Every map at one point. `ns` is the shading normal curvature reads; `ng` the geometric normal rays leave along. */
    Sample at(const Vec3& p, const Vec3& ng, const Vec3& ns, uint32_t group, uint32_t salt) const {
        Sample s;
        s.curvature = curvatureAt(p, ns, group);
        s.cavity = cavityAt(p, ns);
        s.thicknessM = thicknessAt(p, ng, salt);
        s.ao = aoAt(p, ng, salt);
        return s;
    }

    /** Maps at many points (6 floats each: position, normal; groups optional), on `threads` threads. */
    std::vector<Sample> bakePoints(const std::vector<float>& points, const std::vector<uint32_t>& groups, uint32_t threads) const {
        const size_t Q = points.size() / 6;
        std::vector<Sample> out(Q);
        const uint32_t T = std::max(1u, threads ? threads : std::min(16u, std::max(1u, std::thread::hardware_concurrency())));
        std::atomic<size_t> next{0};
        auto work = [&]() {
            for (size_t b; (b = next.fetch_add(256)) < Q;) {
                for (size_t i = b; i < std::min(Q, b + 256); ++i) {
                    const Vec3 p(points[i * 6], points[i * 6 + 1], points[i * 6 + 2]);
                    Vec3 n(points[i * 6 + 3], points[i * 6 + 4], points[i * 6 + 5]);
                    n = n.length() > 1e-12f ? n.normalized() : Vec3(0, 1, 0);
                    out[i] = at(p, n, n, i < groups.size() ? groups[i] : kAnyGroup, static_cast<uint32_t>(i));
                }
            }
        };
        std::vector<std::thread> pool;
        for (uint32_t k = 0; k < T; ++k) pool.emplace_back(work);
        for (auto& th : pool) th.join();
        return out;
    }

    static geometry::ScratchboxMesh soupMesh(const std::vector<float>& soup) {
        geometry::ScratchboxMesh m("mesh_maps");
        const size_t T = soup.size() / 9;
        m.vertices.reserve(T * 3);
        m.indices.reserve(T * 3);
        for (size_t t = 0; t < T; ++t) {
            const Vec3 a(soup[t * 9], soup[t * 9 + 1], soup[t * 9 + 2]), b(soup[t * 9 + 3], soup[t * 9 + 4], soup[t * 9 + 5]), c(soup[t * 9 + 6], soup[t * 9 + 7], soup[t * 9 + 8]);
            Vec3 n = (b - a).cross(c - a);
            n = n.length() > 1e-20f ? n.normalized() : Vec3(0, 1, 0);
            const uint32_t base = static_cast<uint32_t>(m.vertices.size());
            m.addVertex(geometry::Vertex(a, n));
            m.addVertex(geometry::Vertex(b, n));
            m.addVertex(geometry::Vertex(c, n));
            m.addTriangle(base, base + 1, base + 2);
        }
        return m;
    }

private:
    Params P;
    geometry::ScratchboxMesh mesh_{"mesh_maps"};
    bvh::BvhTree bvh_;
    bool haveBvh_ = false;
    detail::PointSet curvPts_, cavityPts_;
    float curvR_ = 0, cavityR_ = 0;
};

}  // namespace scratchbox::mesh_maps
