/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

// Normal-clustered island unwrapper for scanned / remeshed triangle meshes with no UVs
// (staged-location texture pass, docs/processes/staged_location_texture_pass_design.md section 3).
//
// - Triangles are grown into islands by connectivity (edges welded on bit-identical positions) and an angular
//   tolerance on the face normal against the island's running area-weighted mean and its seed (a continuous parameter).
// - Islands smaller than a continuous area floor merge into the neighbour whose mean normal is closest, when every one of
//   their triangles stays within twice the tolerance of that neighbour's normal.
// - Each island is projected orthographically onto the plane of its mean normal, rotated to its principal axes, and
//   checked for overlap in 2D (uniform grid + separating axes). A triangle that overlaps an earlier one of its island is
//   evicted and regrown into a new island; a triangle that still overlaps after the iteration budget becomes its own
//   island, so the output never overlaps.
// - Output vertices are (source vertex, island) pairs: positions are never written, only referenced by source index,
//   so a caller copies them bit-for-bit. Local UVs are metres in the island plane, origin at the island's min corner.
//
// Packing into an atlas is the caller's (it packs these islands together with analytic chart rects).
//
// Also here, for scratchbox_uv_rewrap.hpp's unwrap: growCharts (charts grown by a cost, flattened later, so they may
// curve) and packChartsBitmap (charts packed as rasterised masks).

#pragma once

#include <algorithm>
#include <array>
#include <cmath>
#include <cstdint>
#include <cstring>
#include <numeric>
#include <queue>
#include <unordered_map>
#include <vector>

namespace scratchbox::uv_atlas {

struct Params {
    /** Max angle (degrees) between a triangle normal and its island's mean (and seed) normal. */
    double normalToleranceDeg = 30.0;
    /** Islands below this 3D area (m^2) try to merge into a neighbour. 0 disables. */
    double minIslandAreaM2 = 0.05;
    /** Overlap-eviction rounds before an overlapping triangle is made its own island. */
    int maxEvictionRounds = 8;
    /**
     * False skips the orthographic overlap check: islands are pure normal clusters and may overlap in their projection
     * (for a caller that re-parameterizes them, e.g. scratchbox_uv_rewrap.hpp, and checks overlaps itself).
     */
    bool evictOverlaps = true;
};

struct Island {
    double widthM = 0, heightM = 0;   // extent of the local UV rectangle
    double area3DM2 = 0, area2DM2 = 0;
    std::array<double, 3> normal{0, 1, 0};
    uint32_t group = 0;
};

struct Result {
    std::vector<uint32_t> sourceVertex;  // per output vertex
    std::vector<float> uv;               // 2 per output vertex, metres in the island plane
    std::vector<uint32_t> indices;       // 3 per triangle, same triangle order as the input, into output vertices
    std::vector<uint32_t> triangleIsland;
    std::vector<Island> islands;
    uint32_t evictionRounds = 0;
    uint32_t evictedTriangles = 0;
    uint32_t forcedSingletons = 0;
    uint32_t mergedIslands = 0;
};

namespace detail {

using V3 = std::array<double, 3>;
inline V3 sub(const V3& a, const V3& b) { return {a[0] - b[0], a[1] - b[1], a[2] - b[2]}; }
inline V3 cross(const V3& a, const V3& b) { return {a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]}; }
inline double dot(const V3& a, const V3& b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
inline double len(const V3& a) { return std::sqrt(dot(a, a)); }
inline V3 unit(const V3& a) { double l = len(a); return l > 1e-300 ? V3{a[0] / l, a[1] / l, a[2] / l} : V3{0, 0, 0}; }

struct KeyHash {
    size_t operator()(const std::array<uint32_t, 3>& k) const noexcept {
        uint64_t h = 1469598103934665603ull;
        for (uint32_t v : k) { h ^= v; h *= 1099511628211ull; }
        return static_cast<size_t>(h);
    }
};

inline double orient(const double* a, const double* b, const double* c) {
    return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
}

/** True when the two (shrunk) triangles share interior area: no separating axis among their six edge normals. */
inline bool trianglesOverlap2D(const double* A, const double* B) {
    // A, B: 6 doubles each (x0 y0 x1 y1 x2 y2), already shrunk toward their centroids.
    const double* tris[2] = {A, B};
    for (int t = 0; t < 2; ++t) {
        const double* T = tris[t];
        for (int e = 0; e < 3; ++e) {
            double ex = T[((e + 1) % 3) * 2] - T[e * 2], ey = T[((e + 1) % 3) * 2 + 1] - T[e * 2 + 1];
            double nx = -ey, ny = ex;
            double minA = 1e300, maxA = -1e300, minB = 1e300, maxB = -1e300;
            for (int k = 0; k < 3; ++k) {
                double pa = A[k * 2] * nx + A[k * 2 + 1] * ny, pb = B[k * 2] * nx + B[k * 2 + 1] * ny;
                minA = std::min(minA, pa); maxA = std::max(maxA, pa); minB = std::min(minB, pb); maxB = std::max(maxB, pb);
            }
            if (maxA <= minB || maxB <= minA) return false;
        }
    }
    return true;
}

}  // namespace detail

/**
 * Unwraps `triangleCount` triangles. `groups` (optional, one per triangle) keeps islands inside a group (a glTF node).
 */
inline Result buildIslands(const float* positions, uint32_t vertexCount, const uint32_t* indices, uint32_t triangleCount,
                           const uint32_t* groups, const Params& params) {
    using namespace detail;
    Result out;
    const uint32_t T = triangleCount;
    const double cosTol = std::cos(std::clamp(params.normalToleranceDeg, 0.0, 85.0) * M_PI / 180.0);
    const double cosMerge = std::cos(std::clamp(params.normalToleranceDeg * 2.0, 0.0, 85.0) * M_PI / 180.0);
    auto P = [&](uint32_t v) -> V3 { return {positions[v * 3], positions[v * 3 + 1], positions[v * 3 + 2]}; };
    auto groupOf = [&](uint32_t t) -> uint32_t { return groups ? groups[t] : 0u; };

    // welded vertex ids (bit-identical positions)
    std::vector<uint32_t> weld(vertexCount);
    {
        std::unordered_map<std::array<uint32_t, 3>, uint32_t, KeyHash> ids;
        ids.reserve(vertexCount * 2);
        for (uint32_t v = 0; v < vertexCount; ++v) {
            std::array<uint32_t, 3> k;
            for (int c = 0; c < 3; ++c) {
                float f = positions[v * 3 + c];
                if (f == 0.0f) f = 0.0f;  // -0 and +0 weld
                std::memcpy(&k[c], &f, 4);
            }
            auto it = ids.emplace(k, static_cast<uint32_t>(ids.size())).first;
            weld[v] = it->second;
        }
    }

    std::vector<V3> nrm(T);
    std::vector<double> area(T);
    for (uint32_t t = 0; t < T; ++t) {
        V3 c = cross(sub(P(indices[t * 3 + 1]), P(indices[t * 3])), sub(P(indices[t * 3 + 2]), P(indices[t * 3])));
        area[t] = 0.5 * len(c);
        nrm[t] = unit(c);
    }

    // triangle adjacency over welded edges, same group only
    std::vector<std::vector<uint32_t>> adj(T);
    {
        std::unordered_map<uint64_t, std::vector<uint32_t>> edges;
        edges.reserve(T * 3);
        for (uint32_t t = 0; t < T; ++t) {
            for (int e = 0; e < 3; ++e) {
                uint32_t a = weld[indices[t * 3 + e]], b = weld[indices[t * 3 + (e + 1) % 3]];
                if (a == b) continue;
                if (a > b) std::swap(a, b);
                edges[(uint64_t(a) << 32) | b].push_back(t);
            }
        }
        for (auto& [k, ts] : edges) {
            for (size_t i = 0; i < ts.size(); ++i)
                for (size_t j = i + 1; j < ts.size(); ++j)
                    if (ts[i] != ts[j] && groupOf(ts[i]) == groupOf(ts[j])) { adj[ts[i]].push_back(ts[j]); adj[ts[j]].push_back(ts[i]); }
        }
    }

    const double degenerateArea = 1e-12;
    std::vector<int64_t> island(T, -1);
    std::vector<uint32_t> order(T);
    std::iota(order.begin(), order.end(), 0u);
    std::stable_sort(order.begin(), order.end(), [&](uint32_t a, uint32_t b) { return area[a] > area[b]; });
    std::vector<V3> islandSum;          // area-weighted normal sum
    std::vector<std::vector<uint32_t>> members;  // in growth order

    auto grow = [&](const std::vector<uint32_t>& candidates) {
        for (uint32_t seed : candidates) {
            if (island[seed] >= 0) continue;
            const int64_t id = static_cast<int64_t>(members.size());
            members.emplace_back();
            islandSum.push_back({nrm[seed][0] * area[seed], nrm[seed][1] * area[seed], nrm[seed][2] * area[seed]});
            const V3 seedN = nrm[seed];
            std::queue<uint32_t> q;
            island[seed] = id; members[id].push_back(seed); q.push(seed);
            while (!q.empty()) {
                uint32_t t = q.front(); q.pop();
                for (uint32_t nb : adj[t]) {
                    if (island[nb] >= 0) continue;
                    bool ok = area[nb] < degenerateArea;
                    if (!ok) {
                        V3 mean = unit(islandSum[id]);
                        ok = dot(nrm[nb], mean) >= cosTol && dot(nrm[nb], seedN) >= cosTol;
                    }
                    if (!ok) continue;
                    island[nb] = id; members[id].push_back(nb); q.push(nb);
                    for (int c = 0; c < 3; ++c) islandSum[id][c] += nrm[nb][c] * area[nb];
                }
            }
        }
    };
    grow(order);

    // merge small islands into the closest-normal neighbour
    if (params.minIslandAreaM2 > 0) {
        std::vector<double> isArea(members.size(), 0.0);
        for (size_t i = 0; i < members.size(); ++i) for (uint32_t t : members[i]) isArea[i] += area[t];
        std::vector<uint32_t> small;
        for (size_t i = 0; i < members.size(); ++i) if (isArea[i] < params.minIslandAreaM2) small.push_back(static_cast<uint32_t>(i));
        std::sort(small.begin(), small.end(), [&](uint32_t a, uint32_t b) { return isArea[a] < isArea[b]; });
        for (uint32_t s : small) {
            if (members[s].empty() || isArea[s] >= params.minIslandAreaM2) continue;
            int64_t best = -1; double bestDot = -2;
            for (uint32_t t : members[s]) for (uint32_t nb : adj[t]) {
                int64_t o = island[nb];
                if (o == s || o < 0 || members[o].empty()) continue;
                double d = dot(unit(islandSum[o]), unit(islandSum[s]));
                if (d > bestDot) { bestDot = d; best = o; }
            }
            if (best < 0) continue;
            V3 target = unit(islandSum[best]);
            bool fits = true;
            for (uint32_t t : members[s]) if (area[t] >= degenerateArea && dot(nrm[t], target) < cosMerge) { fits = false; break; }
            if (!fits) continue;
            for (uint32_t t : members[s]) { island[t] = best; members[best].push_back(t); }
            for (int c = 0; c < 3; ++c) islandSum[best][c] += islandSum[s][c];
            isArea[best] += isArea[s];
            members[s].clear();
            islandSum[s] = {0, 0, 0};
            ++out.mergedIslands;
        }
    }

    // projection frame per island and overlap eviction
    struct Frame { V3 n, a, b; };
    std::vector<Frame> frames;
    auto frameOf = [&](size_t i) -> Frame {
        V3 n = unit(islandSum[i]);
        if (len(n) < 0.5) {  // all-degenerate island: any frame
            n = {0, 1, 0};
            for (uint32_t t : members[i]) if (len(nrm[t]) > 0.5) { n = nrm[t]; break; }
        }
        V3 helper = std::fabs(n[1]) < 0.9 ? V3{0, 1, 0} : V3{1, 0, 0};
        V3 a = unit(cross(helper, n)), b = cross(n, a);
        // principal axes of the projected vertices (area weighted) so the rect is tight
        double sxx = 0, syy = 0, sxy = 0, sx = 0, sy = 0, w = 0;
        for (uint32_t t : members[i]) {
            double wt = std::max(area[t], 1e-9);
            for (int k = 0; k < 3; ++k) {
                V3 p = P(indices[t * 3 + k]);
                double x = dot(p, a), y = dot(p, b);
                sx += wt * x; sy += wt * y; sxx += wt * x * x; syy += wt * y * y; sxy += wt * x * y; w += wt;
            }
        }
        if (w > 0) {
            double mx = sx / w, my = sy / w;
            double cxx = sxx / w - mx * mx, cyy = syy / w - my * my, cxy = sxy / w - mx * my;
            double ang = 0.5 * std::atan2(2 * cxy, cxx - cyy);
            double c = std::cos(ang), s = std::sin(ang);
            V3 a2 = {a[0] * c + b[0] * s, a[1] * c + b[1] * s, a[2] * c + b[2] * s};
            V3 b2 = cross(n, a2);
            a = a2; b = b2;
        }
        return {n, a, b};
    };

    std::vector<uint32_t> evicted;
    auto checkIsland = [&](size_t i, const Frame& f, bool forceSingletons) {
        if (members[i].size() < 2) return;
        const std::vector<uint32_t> mem = members[i];  // members may grow below (singletons)
        std::vector<std::array<double, 6>> tri(mem.size());
        double minX = 1e300, minY = 1e300, maxX = -1e300, maxY = -1e300, sumArea = 0;
        for (size_t m = 0; m < mem.size(); ++m) {
            uint32_t t = mem[m];
            double cxp = 0, cyp = 0;
            for (int k = 0; k < 3; ++k) {
                V3 p = P(indices[t * 3 + k]);
                tri[m][k * 2] = dot(p, f.a); tri[m][k * 2 + 1] = dot(p, f.b);
                cxp += tri[m][k * 2] / 3; cyp += tri[m][k * 2 + 1] / 3;
            }
            // shrink toward the centroid so shared edges and vertices do not count as overlap
            for (int k = 0; k < 3; ++k) {
                tri[m][k * 2] = cxp + (tri[m][k * 2] - cxp) * (1 - 1e-6);
                tri[m][k * 2 + 1] = cyp + (tri[m][k * 2 + 1] - cyp) * (1 - 1e-6);
                minX = std::min(minX, tri[m][k * 2]); maxX = std::max(maxX, tri[m][k * 2]);
                minY = std::min(minY, tri[m][k * 2 + 1]); maxY = std::max(maxY, tri[m][k * 2 + 1]);
            }
            sumArea += std::fabs(orient(&tri[m][0], &tri[m][2], &tri[m][4])) * 0.5;
        }
        double cell = std::max(std::sqrt(std::max(sumArea, 1e-12) / mem.size()) * 2.0, 1e-6);
        int gx = std::clamp(int((maxX - minX) / cell) + 1, 1, 2048), gy = std::clamp(int((maxY - minY) / cell) + 1, 1, 2048);
        double cw = (maxX - minX) / gx + 1e-12, ch = (maxY - minY) / gy + 1e-12;
        std::vector<std::vector<uint32_t>> grid(size_t(gx) * gy);
        std::vector<char> drop(mem.size(), 0);
        std::vector<uint32_t> stamp(mem.size(), UINT32_MAX);
        for (size_t m = 0; m < mem.size(); ++m) {
            const auto& tm = tri[m];
            bool flipped = orient(&tm[0], &tm[2], &tm[4]) < 0;  // projected backwards (cannot happen below 90 deg; kept as a guard)
            double bx0 = std::min({tm[0], tm[2], tm[4]}), bx1 = std::max({tm[0], tm[2], tm[4]});
            double by0 = std::min({tm[1], tm[3], tm[5]}), by1 = std::max({tm[1], tm[3], tm[5]});
            int x0 = std::clamp(int((bx0 - minX) / cw), 0, gx - 1), x1 = std::clamp(int((bx1 - minX) / cw), 0, gx - 1);
            int y0 = std::clamp(int((by0 - minY) / ch), 0, gy - 1), y1 = std::clamp(int((by1 - minY) / ch), 0, gy - 1);
            bool hit = flipped && m > 0;
            if (!hit) {
                std::array<double, 6> a = tm;
                if (orient(&a[0], &a[2], &a[4]) < 0) { std::swap(a[2], a[4]); std::swap(a[3], a[5]); }
                for (int y = y0; y <= y1 && !hit; ++y) for (int x = x0; x <= x1 && !hit; ++x) {
                    for (uint32_t o : grid[size_t(y) * gx + x]) {
                        if (stamp[o] == m) continue;
                        stamp[o] = static_cast<uint32_t>(m);
                        std::array<double, 6> b = tri[o];
                        if (orient(&b[0], &b[2], &b[4]) < 0) { std::swap(b[2], b[4]); std::swap(b[3], b[5]); }
                        if (trianglesOverlap2D(a.data(), b.data())) { hit = true; break; }
                    }
                }
            }
            if (hit) { drop[m] = 1; continue; }
            for (int y = y0; y <= y1; ++y) for (int x = x0; x <= x1; ++x) grid[size_t(y) * gx + x].push_back(static_cast<uint32_t>(m));
        }
        std::vector<uint32_t> keep;
        for (size_t m = 0; m < mem.size(); ++m) {
            if (!drop[m]) { keep.push_back(mem[m]); continue; }
            uint32_t t = mem[m];
            ++out.evictedTriangles;
            for (int c = 0; c < 3; ++c) islandSum[i][c] -= nrm[t][c] * area[t];
            if (forceSingletons) {
                int64_t id = static_cast<int64_t>(members.size());
                members.push_back({t});
                islandSum.push_back({nrm[t][0] * area[t], nrm[t][1] * area[t], nrm[t][2] * area[t]});
                island[t] = id;
                ++out.forcedSingletons;
            } else {
                island[t] = -1;
                evicted.push_back(t);
            }
        }
        members[i].swap(keep);
    };

    for (int round = 0; ; ++round) {
        const bool last = round >= params.maxEvictionRounds;
        evicted.clear();
        frames.assign(members.size(), {});
        const size_t count = members.size();
        for (size_t i = 0; i < count; ++i) {
            if (members[i].empty()) continue;
            frames[i] = frameOf(i);
            if (params.evictOverlaps) checkIsland(i, frames[i], last);
        }
        out.evictionRounds = static_cast<uint32_t>(round + 1);
        if (evicted.empty()) break;
        std::stable_sort(evicted.begin(), evicted.end(), [&](uint32_t a, uint32_t b) { return area[a] > area[b]; });
        grow(evicted);  // evicted triangles only join each other (their old islands are assigned)
    }

    // compact islands and emit
    std::vector<int64_t> remap(members.size(), -1);
    frames.resize(members.size());
    for (size_t i = 0; i < members.size(); ++i) {
        if (members[i].empty()) continue;
        remap[i] = static_cast<int64_t>(out.islands.size());
        frames[i] = frameOf(i);  // final frame of the final membership
        Island is;
        is.normal = frames[i].n;
        is.group = groupOf(members[i][0]);
        out.islands.push_back(is);
    }
    out.triangleIsland.resize(T);
    out.indices.resize(size_t(T) * 3);
    std::unordered_map<uint64_t, uint32_t> outVertex;
    outVertex.reserve(size_t(T) * 3);
    std::vector<double> ux, uy;
    std::vector<uint32_t> vIsland;
    for (uint32_t t = 0; t < T; ++t) {
        const int64_t oi = island[t];
        const uint32_t is = static_cast<uint32_t>(remap[oi]);
        out.triangleIsland[t] = is;
        const Frame& f = frames[oi];
        for (int k = 0; k < 3; ++k) {
            uint32_t v = indices[t * 3 + k];
            uint64_t key = (uint64_t(v) << 32) | is;
            auto it = outVertex.find(key);
            if (it == outVertex.end()) {
                it = outVertex.emplace(key, static_cast<uint32_t>(out.sourceVertex.size())).first;
                out.sourceVertex.push_back(v);
                V3 p = P(v);
                ux.push_back(dot(p, f.a)); uy.push_back(dot(p, f.b));
                vIsland.push_back(is);
            }
            out.indices[size_t(t) * 3 + k] = it->second;
        }
        out.islands[is].area3DM2 += area[t];
    }
    std::vector<double> mnX(out.islands.size(), 1e300), mnY(out.islands.size(), 1e300), mxX(out.islands.size(), -1e300), mxY(out.islands.size(), -1e300);
    for (size_t v = 0; v < ux.size(); ++v) {
        uint32_t is = vIsland[v];
        mnX[is] = std::min(mnX[is], ux[v]); mxX[is] = std::max(mxX[is], ux[v]);
        mnY[is] = std::min(mnY[is], uy[v]); mxY[is] = std::max(mxY[is], uy[v]);
    }
    out.uv.resize(ux.size() * 2);
    for (size_t v = 0; v < ux.size(); ++v) {
        uint32_t is = vIsland[v];
        out.uv[v * 2] = static_cast<float>(ux[v] - mnX[is]);
        out.uv[v * 2 + 1] = static_cast<float>(uy[v] - mnY[is]);
    }
    for (size_t i = 0; i < out.islands.size(); ++i) {
        out.islands[i].widthM = mxX[i] - mnX[i];
        out.islands[i].heightM = mxY[i] - mnY[i];
    }
    for (uint32_t t = 0; t < T; ++t) {
        const uint32_t* id = &out.indices[size_t(t) * 3];
        double a[2] = {out.uv[id[0] * 2], out.uv[id[0] * 2 + 1]}, b[2] = {out.uv[id[1] * 2], out.uv[id[1] * 2 + 1]}, c[2] = {out.uv[id[2] * 2], out.uv[id[2] * 2 + 1]};
        out.islands[out.triangleIsland[t]].area2DM2 += 0.5 * std::fabs(orient(a, b, c));
    }
    return out;
}


// =====================================================================================================================
// Chart growing (the logic of xatlas's chart segmentation, written for this engine): charts are grown face by face from
// seeds by a priority queue over a cost that mixes the face's normal deviation from the chart's proxy plane, the change
// in the chart's roundness (boundary^2 / area), the straightness of the boundary the face leaves, and the creases it
// crosses. Charts may curve (they are flattened by LSCM / ABF++ / SLIM afterwards), so they are far larger than the
// orthographic islands above. Seeds are relocated to their chart's centroid and the charts regrown, then small charts
// mostly enclosed by a neighbour of similar normal are merged into it.
// =====================================================================================================================

struct GrowParams {
    double normalDeviationWeight = 2.0;
    double roundnessWeight = 0.01;
    double straightnessWeight = 6.0;
    double creaseWeight = 1.0;
    /** A face joins a chart only while its cost stays under this. */
    double maxCost = 2.0;
    /** Hard bound on the angle between a face and its chart's proxy normal (keeps every chart a height field). */
    double maxNormalDeviationDeg = 75.0;
    /** Dihedral angle above which a shared edge counts as a crease (scans are noisy: only sharp folds count). */
    double creaseAngleDeg = 70.0;
    /** 0 = unbounded. */
    double maxChartAreaM2 = 0.0;
    double maxBoundaryLengthM = 0.0;
    int seedRelocations = 1;
    bool mergeCharts = true;
};

struct GrowResult {
    std::vector<uint32_t> triangleChart;
    std::vector<std::array<double, 3>> chartNormal;
    uint32_t seeds = 0, merged = 0;
};

inline GrowResult growCharts(const float* positions, uint32_t vertexCount, const uint32_t* indices, uint32_t triangleCount,
                             const uint32_t* groups, const GrowParams& prm) {
    using namespace detail;
    GrowResult out;
    const uint32_t T = triangleCount;
    out.triangleChart.assign(T, UINT32_MAX);
    if (T == 0) return out;
    auto groupOf = [&](uint32_t t) -> uint32_t { return groups ? groups[t] : 0u; };
    std::vector<uint32_t> weld(vertexCount);
    {
        std::unordered_map<std::array<uint32_t, 3>, uint32_t, KeyHash> ids;
        ids.reserve(size_t(vertexCount) * 2);
        for (uint32_t v = 0; v < vertexCount; ++v) {
            std::array<uint32_t, 3> k;
            for (int c = 0; c < 3; ++c) { float f = positions[v * 3 + c]; if (f == 0.0f) f = 0.0f; std::memcpy(&k[c], &f, 4); }
            weld[v] = ids.emplace(k, static_cast<uint32_t>(ids.size())).first->second;
        }
    }
    auto P = [&](uint32_t v) -> V3 { return {positions[v * 3], positions[v * 3 + 1], positions[v * 3 + 2]}; };
    std::vector<V3> nrm(T), centroid(T);
    std::vector<double> area(T), perim(T);
    std::vector<std::array<double, 3>> edgeLen(T);
    std::vector<std::array<uint32_t, 3>> nb(T);  // neighbour across edge k (k -> k+1), UINT32_MAX when none
    {
        std::unordered_map<uint64_t, std::vector<uint32_t>> edges;
        edges.reserve(size_t(T) * 3);
        for (uint32_t t = 0; t < T; ++t) {
            V3 a = P(indices[t * 3]), b = P(indices[t * 3 + 1]), c = P(indices[t * 3 + 2]);
            V3 n = cross(sub(b, a), sub(c, a));
            area[t] = 0.5 * len(n);
            nrm[t] = unit(n);
            centroid[t] = {(a[0] + b[0] + c[0]) / 3, (a[1] + b[1] + c[1]) / 3, (a[2] + b[2] + c[2]) / 3};
            const V3 pts[3] = {a, b, c};
            perim[t] = 0;
            for (int k = 0; k < 3; ++k) {
                edgeLen[t][k] = len(sub(pts[(k + 1) % 3], pts[k]));
                perim[t] += edgeLen[t][k];
                uint32_t va = weld[indices[t * 3 + k]], vb = weld[indices[t * 3 + (k + 1) % 3]];
                if (va == vb) continue;
                edges[va < vb ? (uint64_t(va) << 32 | vb) : (uint64_t(vb) << 32 | va)].push_back(t * 3 + k);
            }
            nb[t] = {UINT32_MAX, UINT32_MAX, UINT32_MAX};
        }
        for (auto& [key, list] : edges) {
            if (list.size() < 2) continue;
            // a manifold edge joins its two faces; a non-manifold one joins its faces in a ring, one neighbour each (the
            // flattening checks the chart's topology and splits what it cannot flatten)
            const size_t n = list.size();
            for (size_t i = 0; i < n; ++i) {
                const uint32_t ca = list[i], cb = list[(i + 1) % n];
                const uint32_t ta = ca / 3, tb = cb / 3;
                if (ta == tb || groupOf(ta) != groupOf(tb)) continue;
                if (nb[ta][ca % 3] == UINT32_MAX) nb[ta][ca % 3] = tb;
                if (n == 2) { if (nb[tb][cb % 3] == UINT32_MAX) nb[tb][cb % 3] = ta; break; }
            }
        }
    }
    const double cosHard = std::cos(std::clamp(prm.maxNormalDeviationDeg, 1.0, 89.0) * M_PI / 180.0);
    const double cosCrease = std::cos(std::clamp(prm.creaseAngleDeg, 1.0, 179.0) * M_PI / 180.0);

    struct ChartState { V3 nsum{0, 0, 0}; V3 n{0, 0, 1}; double area = 0, boundary = 0; uint32_t version = 0, group = 0; };
    std::vector<ChartState> charts;
    std::vector<uint32_t>& chartOf = out.triangleChart;

    auto evaluate = [&](uint32_t f, uint32_t c) -> double {
        const ChartState& ch = charts[c];
        if (!(area[f] > 1e-20)) return 0.0;  // a degenerate face covers nothing: it joins the first chart it touches
        const double d = dot(nrm[f], ch.n);
        if (d < cosHard) return HUGE_VAL;
        double lIn = 0, lOut = 0, seamLen = 0;
        for (int k = 0; k < 3; ++k) {
            uint32_t o = nb[f][k];
            if (o != UINT32_MAX && chartOf[o] == c) {
                lIn += edgeLen[f][k];
                const double dd = dot(nrm[f], nrm[o]);
                if (dd < cosCrease) seamLen += edgeLen[f][k] * (1.0 - dd);
            } else lOut += edgeLen[f][k];
        }
        const double newArea = ch.area + area[f], newBoundary = ch.boundary + lOut - lIn;
        if (prm.maxChartAreaM2 > 0 && newArea > prm.maxChartAreaM2) return HUGE_VAL;
        if (prm.maxBoundaryLengthM > 0 && newBoundary > prm.maxBoundaryLengthM) return HUGE_VAL;
        double roundness = 0;
        if (ch.area > 0 && newArea > 0) {
            const double r0 = ch.boundary * ch.boundary / ch.area, r1 = newBoundary * newBoundary / newArea;
            if (r1 > r0) roundness = 1.0 - r0 / r1;
        }
        const double straight = lIn + lOut > 0 ? std::min((lOut - lIn) / (lOut + lIn), 0.0) : 0.0;
        const double seam = lIn > 0 ? seamLen / lIn : 0.0;
        const double cost = prm.normalDeviationWeight * (1.0 - d) + prm.roundnessWeight * roundness + prm.straightnessWeight * straight + prm.creaseWeight * seam;
        return cost <= prm.maxCost ? cost : HUGE_VAL;
    };
    auto addFace = [&](uint32_t f, uint32_t c) {
        ChartState& ch = charts[c];
        double lIn = 0, lOut = 0;
        for (int k = 0; k < 3; ++k) {
            uint32_t o = nb[f][k];
            if (o != UINT32_MAX && chartOf[o] == c) lIn += edgeLen[f][k]; else lOut += edgeLen[f][k];
        }
        chartOf[f] = c;
        ch.area += area[f];
        ch.boundary += lOut - lIn;
        for (int a = 0; a < 3; ++a) ch.nsum[a] += nrm[f][a] * area[f];
        V3 n = unit(ch.nsum);
        if (len(n) > 0) ch.n = n;
        ++ch.version;
    };
    struct Entry { double cost; uint32_t face, chart, version; bool operator>(const Entry& o) const { return cost > o.cost || (cost == o.cost && face > o.face); } };
    std::priority_queue<Entry, std::vector<Entry>, std::greater<Entry>> heap;
    auto pushNeighbours = [&](uint32_t f, uint32_t c) {
        for (int k = 0; k < 3; ++k) {
            uint32_t o = nb[f][k];
            if (o == UINT32_MAX || chartOf[o] != UINT32_MAX) continue;
            double cost = evaluate(o, c);
            if (cost < HUGE_VAL) heap.push({cost, o, c, charts[c].version});
        }
    };
    auto newChart = [&](uint32_t seed) {
        ChartState ch;
        ch.group = groupOf(seed);
        ch.n = len(nrm[seed]) > 0 ? nrm[seed] : V3{0, 0, 1};
        charts.push_back(ch);
        const uint32_t c = static_cast<uint32_t>(charts.size() - 1);
        addFace(seed, c);
        ++out.seeds;
        pushNeighbours(seed, c);
        return c;
    };
    auto grow = [&]() {
        while (!heap.empty()) {
            Entry e = heap.top();
            heap.pop();
            if (chartOf[e.face] != UINT32_MAX) continue;
            if (e.version != charts[e.chart].version) {
                double cost = evaluate(e.face, e.chart);
                if (!(cost < HUGE_VAL)) continue;
                // lazy greedy: accept the re-evaluated entry while it still beats the next one in the queue
                if (!heap.empty() && cost > heap.top().cost) { heap.push({cost, e.face, e.chart, charts[e.chart].version}); continue; }
            }
            addFace(e.face, e.chart);
            pushNeighbours(e.face, e.chart);
        }
    };
    // seeds in descending face area: a large face is a stable proxy plane
    std::vector<uint32_t> seedOrder(T);
    std::iota(seedOrder.begin(), seedOrder.end(), 0u);
    std::stable_sort(seedOrder.begin(), seedOrder.end(), [&](uint32_t a, uint32_t b) { return area[a] > area[b]; });
    size_t seedCursor = 0;
    auto fillUnassigned = [&]() {
        for (; seedCursor < seedOrder.size(); ++seedCursor) {
            const uint32_t f = seedOrder[seedCursor];
            if (chartOf[f] != UINT32_MAX) continue;
            newChart(f);
            grow();
        }
    };
    fillUnassigned();
    for (int it = 0; it < prm.seedRelocations; ++it) {
        // relocate every seed to the face nearest its chart's area-weighted centroid, then regrow all charts together
        std::vector<V3> csum(charts.size(), V3{0, 0, 0});
        std::vector<double> carea(charts.size(), 0);
        for (uint32_t t = 0; t < T; ++t) { uint32_t c = chartOf[t]; for (int a = 0; a < 3; ++a) csum[c][a] += centroid[t][a] * area[t]; carea[c] += area[t]; }
        std::vector<uint32_t> seed(charts.size(), UINT32_MAX);
        std::vector<double> best(charts.size(), HUGE_VAL);
        for (uint32_t t = 0; t < T; ++t) {
            uint32_t c = chartOf[t];
            V3 m = carea[c] > 0 ? V3{csum[c][0] / carea[c], csum[c][1] / carea[c], csum[c][2] / carea[c]} : centroid[t];
            V3 dv = sub(centroid[t], m);
            double d2 = dot(dv, dv);
            if (d2 < best[c]) { best[c] = d2; seed[c] = t; }
        }
        std::fill(chartOf.begin(), chartOf.end(), UINT32_MAX);
        charts.clear();
        heap = {};
        out.seeds = 0;
        for (uint32_t s : seed) if (s != UINT32_MAX && chartOf[s] == UINT32_MAX) {
            ChartState ch;
            ch.group = groupOf(s);
            ch.n = len(nrm[s]) > 0 ? nrm[s] : V3{0, 0, 1};
            charts.push_back(ch);
            addFace(s, static_cast<uint32_t>(charts.size() - 1));
            ++out.seeds;
        }
        for (uint32_t c = 0; c < charts.size(); ++c) for (uint32_t t = 0; t < T; ++t) if (chartOf[t] == c) { pushNeighbours(t, c); break; }
        grow();
        seedCursor = 0;
        fillUnassigned();
    }
    if (prm.mergeCharts && charts.size() > 1) {
        // merge a chart into the neighbour that encloses most of its boundary, when their normals agree
        std::vector<uint32_t> parent(charts.size());
        std::iota(parent.begin(), parent.end(), 0u);
        auto root = [&](uint32_t c) { while (parent[c] != c) { parent[c] = parent[parent[c]]; c = parent[c]; } return c; };
        bool changed = true;
        for (int pass = 0; changed && pass < 8; ++pass) {
            changed = false;
            std::vector<std::unordered_map<uint32_t, double>> shared(charts.size());
            std::vector<double> boundary(charts.size(), 0), carea(charts.size(), 0);
            std::vector<V3> nsum(charts.size(), V3{0, 0, 0});
            for (uint32_t t = 0; t < T; ++t) {
                const uint32_t c = root(chartOf[t]);
                carea[c] += area[t];
                for (int a = 0; a < 3; ++a) nsum[c][a] += nrm[t][a] * area[t];
                for (int k = 0; k < 3; ++k) {
                    uint32_t o = nb[t][k];
                    uint32_t oc = o == UINT32_MAX ? UINT32_MAX : root(chartOf[o]);
                    if (oc == c) continue;
                    boundary[c] += edgeLen[t][k];
                    if (oc != UINT32_MAX) shared[c][oc] += edgeLen[t][k];
                }
            }
            std::vector<uint32_t> order;
            for (uint32_t c = 0; c < charts.size(); ++c) if (root(c) == c) order.push_back(c);
            std::sort(order.begin(), order.end(), [&](uint32_t a, uint32_t b) { return carea[a] < carea[b]; });
            for (uint32_t c : order) {
                if (root(c) != c || boundary[c] <= 0) continue;
                uint32_t bestN = UINT32_MAX; double bestShare = 0;
                for (auto& [o, l] : shared[c]) { uint32_t ro = root(o); if (ro != c && l > bestShare) { bestShare = l; bestN = ro; } }
                if (bestN == UINT32_MAX || bestShare < 0.5 * boundary[c]) continue;
                V3 nc = unit(nsum[c]), nn = unit(nsum[bestN]);
                if (prm.normalDeviationWeight * (1.0 - dot(nc, nn)) > 0.5 * prm.maxCost) continue;
                V3 merged = unit({nsum[c][0] + nsum[bestN][0], nsum[c][1] + nsum[bestN][1], nsum[c][2] + nsum[bestN][2]});
                bool ok = true;
                for (uint32_t t = 0; t < T && ok; ++t) { uint32_t r = root(chartOf[t]); if ((r == c || r == bestN) && dot(nrm[t], merged) < cosHard) ok = false; }
                if (!ok) continue;
                parent[c] = bestN;
                for (int a = 0; a < 3; ++a) nsum[bestN][a] += nsum[c][a];
                carea[bestN] += carea[c];
                ++out.merged;
                changed = true;
            }
        }
        for (uint32_t t = 0; t < T; ++t) chartOf[t] = root(chartOf[t]);
    }
    // compact labels, chart normals
    std::unordered_map<uint32_t, uint32_t> label;
    for (uint32_t t = 0; t < T; ++t) chartOf[t] = label.emplace(chartOf[t], static_cast<uint32_t>(label.size())).first->second;
    std::vector<V3> nsum(label.size(), V3{0, 0, 0});
    for (uint32_t t = 0; t < T; ++t) for (int a = 0; a < 3; ++a) nsum[chartOf[t]][a] += nrm[t][a] * area[t];
    out.chartNormal.resize(label.size());
    for (size_t c = 0; c < label.size(); ++c) { V3 n = unit(nsum[c]); out.chartNormal[c] = len(n) > 0 ? n : V3{0, 0, 1}; }
    return out;
}

// =====================================================================================================================
// Bitmap chart packing (the logic of xatlas's packer, written for this engine): every chart is rasterised at the atlas
// density into a bit mask (conservative triangle coverage dilated by the gutter) in each allowed 90 degree rotation, and
// placed where its mask meets no placed mask, choosing the position that keeps the atlas extent smallest (then the
// smaller area, then top-left). Charts nest into each other's concavities, which a rectangle packer cannot do.
// =====================================================================================================================

struct BitmapChart {
    /** 6 doubles per triangle, metres, origin at the chart's min corner (v up). */
    const std::vector<double>* cornerUv = nullptr;
    double widthM = 0, heightM = 0;
};

struct BitmapPlacement { uint32_t x = 0, y = 0, w = 0, h = 0; uint8_t rotation = 0; };

struct BitmapPackParams {
    double texelsPerMeter = 1;
    uint32_t gutter = 2;
    /** 1 = no rotation, 2 = 0 / 90 degrees, 4 = all quarter turns. */
    int rotations = 4;
    /** Largest extent in either direction (the pack fails when a chart cannot be placed inside it). */
    uint32_t maxSide = 8192;
    /** Target width / height: the extent kept smallest is max(width, height * aspect). */
    double aspect = 1.0;
    /** Collision tests per chart before only the positions that grow the extent are tried (0 = unbounded). */
    uint64_t searchBudget = 20000;
};

struct BitmapPackResult {
    bool ok = false;
    uint32_t width = 0, height = 0;   // used extent
    std::vector<BitmapPlacement> placements;
};

/** Image-space texel position (x right, y down) of local chart point (u, v) in metres for a placement. */
inline void bitmapTexel(const BitmapPlacement& p, double d, uint32_t gutter, double widthM, double heightM, double u, double v, double& X, double& Y) {
    const double bw = widthM * d, bh = heightM * d;
    const double bx = u * d, by = (heightM - v) * d;  // v up -> image down
    double rx = bx, ry = by;
    switch (p.rotation) {
        case 1: rx = bh - by; ry = bx; break;
        case 2: rx = bw - bx; ry = bh - by; break;
        case 3: rx = by; ry = bw - bx; break;
        default: break;
    }
    X = p.x + gutter + rx;
    Y = p.y + gutter + ry;
}

namespace detail {

struct BitMask {
    uint32_t w = 0, h = 0, words = 0;
    std::vector<uint64_t> bits;
    std::vector<int32_t> rowFirst;  // first set bit per row, -1 when empty
    std::vector<int32_t> rowLast;   // last set bit per row
    void init(uint32_t W, uint32_t H) { w = W; h = H; words = (W + 63) / 64; bits.assign(size_t(words) * H, 0); }
    bool get(uint32_t x, uint32_t y) const { return (bits[size_t(y) * words + x / 64] >> (x % 64)) & 1u; }
    void set(uint32_t x, uint32_t y) { bits[size_t(y) * words + x / 64] |= uint64_t(1) << (x % 64); }
};

/** Bits [x, x + 64) of row y as one word (bits past the width read as 0). */
inline uint64_t extractWord(const BitMask& m, uint32_t y, uint32_t x) {
    const size_t base = size_t(y) * m.words;
    const uint32_t wi = x / 64, sh = x % 64;
    uint64_t lo = wi < m.words ? m.bits[base + wi] : 0;
    if (sh == 0) return lo;
    uint64_t hi = wi + 1 < m.words ? m.bits[base + wi + 1] : 0;
    return (lo >> sh) | (hi << (64 - sh));
}

/**
 * Every texel the triangle touches: a texel meets the triangle iff an edge crosses it, a vertex lies in it, or it lies
 * wholly inside (then its centre is inside). Edges by grid traversal, vertices directly, interiors by centre spans.
 */
inline void rasterTriangleConservative(BitMask& m, const double* r) {
    auto mark = [&](int x, int y) { if (x >= 0 && y >= 0 && x < int(m.w) && y < int(m.h)) m.set(uint32_t(x), uint32_t(y)); };
    for (int e = 0; e < 3; ++e) {
        double ax = r[e * 2], ay = r[e * 2 + 1], bx = r[((e + 1) % 3) * 2], by = r[((e + 1) % 3) * 2 + 1];
        int x = int(std::floor(ax)), y = int(std::floor(ay));
        const int xe = int(std::floor(bx)), ye = int(std::floor(by));
        mark(x, y);
        const double dx = bx - ax, dy = by - ay;
        const int sx = dx > 0 ? 1 : -1, sy = dy > 0 ? 1 : -1;
        const double tdx = dx != 0 ? std::fabs(1.0 / dx) : HUGE_VAL, tdy = dy != 0 ? std::fabs(1.0 / dy) : HUGE_VAL;
        double tx = dx != 0 ? ((sx > 0 ? (x + 1 - ax) : (ax - x)) * tdx) : HUGE_VAL;
        double ty = dy != 0 ? ((sy > 0 ? (y + 1 - ay) : (ay - y)) * tdy) : HUGE_VAL;
        for (int guard = 0; (x != xe || y != ye) && guard < 1 << 20; ++guard) {
            if (tx < ty) { x += sx; tx += tdx; } else if (ty < tx) { y += sy; ty += tdy; }
            else { mark(x + sx, y); mark(x, y + sy); x += sx; y += sy; tx += tdx; ty += tdy; }  // through a corner
            mark(x, y);
        }
    }
    const double minY = std::min({r[1], r[3], r[5]}), maxY = std::max({r[1], r[3], r[5]});
    for (int y = std::max(0, int(std::floor(minY))); y <= std::min(int(m.h) - 1, int(std::floor(maxY))); ++y) {
        const double cy = y + 0.5;
        double lo = HUGE_VAL, hi = -HUGE_VAL;
        for (int e = 0; e < 3; ++e) {
            const double ax = r[e * 2], ay = r[e * 2 + 1], bx = r[((e + 1) % 3) * 2], by = r[((e + 1) % 3) * 2 + 1];
            if ((ay <= cy && by >= cy) || (by <= cy && ay >= cy)) {
                const double x = ay == by ? std::min(ax, bx) : ax + (cy - ay) * (bx - ax) / (by - ay);
                const double x2 = ay == by ? std::max(ax, bx) : x;
                lo = std::min(lo, x); hi = std::max(hi, x2);
            }
        }
        if (lo > hi) continue;
        for (int x = std::max(0, int(std::ceil(lo - 0.5))); x <= std::min(int(m.w) - 1, int(std::floor(hi - 0.5))); ++x) m.set(uint32_t(x), uint32_t(y));
    }
}

/** Conservative coverage of the chart in rotation `rot`, dilated by the gutter (Chebyshev). */
inline BitMask chartMask(const BitmapChart& c, double d, uint32_t gutter, uint8_t rot) {
    BitmapPlacement p; p.rotation = rot;
    const double bw = c.widthM * d, bh = c.heightM * d;
    const double rw = (rot & 1) ? bh : bw, rh = (rot & 1) ? bw : bh;
    BitMask m;
    m.init(static_cast<uint32_t>(std::ceil(rw - 1e-9)) + 2 * gutter + 1, static_cast<uint32_t>(std::ceil(rh - 1e-9)) + 2 * gutter + 1);
    const auto& q = *c.cornerUv;
    const size_t n = q.size() / 6;
    for (size_t t = 0; t < n; ++t) {
        double r[6];
        for (int k = 0; k < 3; ++k) bitmapTexel(p, d, gutter, c.widthM, c.heightM, q[t * 6 + k * 2], q[t * 6 + k * 2 + 1], r[k * 2], r[k * 2 + 1]);
        rasterTriangleConservative(m, r);
    }
    if (gutter > 0) {
        // Chebyshev dilation: horizontal by shifted words, then vertical by OR of rows
        BitMask h; h.init(m.w, m.h);
        for (uint32_t y = 0; y < m.h; ++y) {
            const uint64_t* src = &m.bits[size_t(y) * m.words];
            uint64_t* dst = &h.bits[size_t(y) * m.words];
            for (uint32_t wi = 0; wi < m.words; ++wi) {
                uint64_t acc = src[wi];
                for (uint32_t s = 1; s <= gutter; ++s) {
                    const uint32_t ws = s / 64, bs = s % 64;
                    // left neighbour bits (x + s -> x): from words wi + ws, wi + ws + 1
                    uint64_t lo = wi + ws < m.words ? src[wi + ws] : 0, hi = wi + ws + 1 < m.words ? src[wi + ws + 1] : 0;
                    acc |= bs ? (lo >> bs) | (hi << (64 - bs)) : lo;
                    // right neighbour bits (x - s -> x)
                    uint64_t a = wi >= ws ? src[wi - ws] : 0, b = wi >= ws + 1 ? src[wi - ws - 1] : 0;
                    acc |= bs ? (a << bs) | (b >> (64 - bs)) : a;
                }
                dst[wi] = acc;
            }
            if (m.w % 64) dst[m.words - 1] &= (uint64_t(1) << (m.w % 64)) - 1;
        }
        BitMask v; v.init(m.w, m.h);
        for (uint32_t y = 0; y < m.h; ++y) {
            const uint32_t y0 = y > gutter ? y - gutter : 0, y1 = std::min(m.h - 1, y + gutter);
            uint64_t* dst = &v.bits[size_t(y) * m.words];
            for (uint32_t yy = y0; yy <= y1; ++yy) {
                const uint64_t* src = &h.bits[size_t(yy) * m.words];
                for (uint32_t wi = 0; wi < m.words; ++wi) dst[wi] |= src[wi];
            }
        }
        m = std::move(v);
    }
    m.rowFirst.assign(m.h, -1);
    m.rowLast.assign(m.h, -1);
    for (uint32_t y = 0; y < m.h; ++y) {
        for (uint32_t wi = 0; wi < m.words; ++wi) {
            uint64_t b = m.bits[size_t(y) * m.words + wi];
            if (b) { m.rowFirst[y] = int32_t(wi * 64 + __builtin_ctzll(b)); break; }
        }
        for (uint32_t wi = m.words; wi-- > 0;) {
            uint64_t b = m.bits[size_t(y) * m.words + wi];
            if (b) { m.rowLast[y] = int32_t(wi * 64 + 63 - __builtin_clzll(b)); break; }
        }
    }
    return m;
}

/** Last set bit of row y in [a, b] (inclusive), or -1. */
inline int64_t lastSetInRange(const BitMask& m, uint32_t y, uint32_t a, uint32_t b) {
    if (b >= m.w) b = m.w - 1;
    if (a > b) return -1;
    const size_t base = size_t(y) * m.words;
    uint32_t wa = a / 64, wb = b / 64;
    for (uint32_t wi = wb + 1; wi-- > wa;) {
        uint64_t word = m.bits[base + wi];
        if (wi == wb && (b % 64) != 63) word &= (uint64_t(2) << (b % 64)) - 1;
        if (wi == wa) word &= ~uint64_t(0) << (a % 64);
        if (word) return int64_t(wi) * 64 + 63 - __builtin_clzll(word);
    }
    return -1;
}

}  // namespace detail

namespace detail {

/** Next set bit of row y at or after x (m.w when none). */
inline uint32_t nextSetBit(const BitMask& m, uint32_t y, uint32_t x) {
    if (x >= m.w) return m.w;
    const size_t base = size_t(y) * m.words;
    uint32_t wi = x / 64;
    uint64_t word = m.bits[base + wi] & (~uint64_t(0) << (x % 64));
    while (true) {
        if (word) return std::min(m.w, wi * 64 + uint32_t(__builtin_ctzll(word)));
        if (++wi >= m.words) return m.w;
        word = m.bits[base + wi];
    }
}

/** Next clear bit of row y at or after x (m.w when none). */
inline uint32_t nextClearBit(const BitMask& m, uint32_t y, uint32_t x) {
    if (x >= m.w) return m.w;
    const size_t base = size_t(y) * m.words;
    uint32_t wi = x / 64;
    uint64_t word = ~m.bits[base + wi] & (~uint64_t(0) << (x % 64));
    while (true) {
        if (word) return std::min(m.w, wi * 64 + uint32_t(__builtin_ctzll(word)));
        if (++wi >= m.words) return m.w;
        word = ~m.bits[base + wi];
    }
}

}  // namespace detail

inline BitmapPackResult packChartsBitmap(const std::vector<BitmapChart>& charts, const BitmapPackParams& prm) {
    using namespace detail;
    BitmapPackResult out;
    const double d = prm.texelsPerMeter;
    const uint32_t capW = prm.maxSide, capH = prm.maxSide;
    const double aspect = prm.aspect > 0 ? prm.aspect : 1.0;
    const int nRot = prm.rotations >= 4 ? 4 : prm.rotations >= 2 ? 2 : 1;
    std::vector<uint32_t> order(charts.size());
    std::iota(order.begin(), order.end(), 0u);
    std::vector<double> footprint(charts.size());
    for (size_t i = 0; i < charts.size(); ++i) footprint[i] = (charts[i].widthM * d + 2.0 * prm.gutter) * (charts[i].heightM * d + 2.0 * prm.gutter);
    std::stable_sort(order.begin(), order.end(), [&](uint32_t a, uint32_t b) { return footprint[a] > footprint[b]; });
    BitMask atlas;
    atlas.init(capW, capH);
    // per row: the first clear bit, the last set bit (-1 when empty) and the longest clear run before it
    std::vector<uint32_t> firstFree(capH, 0), innerRun(capH, 0);
    std::vector<int64_t> lastSet(capH, -1);
    auto refreshRow = [&](uint32_t y) {
        firstFree[y] = nextClearBit(atlas, y, 0);
        int64_t last = -1;
        for (uint32_t wi = atlas.words; wi-- > 0;) {
            uint64_t w = atlas.bits[size_t(y) * atlas.words + wi];
            if (w) { last = int64_t(wi) * 64 + 63 - __builtin_clzll(w); break; }
        }
        lastSet[y] = last;
        uint32_t best = 0;
        for (uint32_t x = 0; int64_t(x) <= last;) {
            const uint32_t s = nextSetBit(atlas, y, x);
            best = std::max(best, s - x);
            x = nextClearBit(atlas, y, s);
        }
        innerRun[y] = best;
    };
    uint32_t extW = 0, extH = 0;
    out.placements.resize(charts.size());
    struct Mask { BitMask m; std::vector<uint32_t> span; uint32_t minSpan = 0; };
    for (uint32_t id : order) {
        // rotation masks are made on first use: most charts fit inside the extent in the first rotation tried
        Mask masks[4];
        bool made[4] = {false, false, false, false};
        auto mask = [&](int r) -> const Mask& {
            if (made[r]) return masks[r];
            made[r] = true;
            masks[r].m = chartMask(charts[id], d, prm.gutter, static_cast<uint8_t>(r));
            const BitMask& m = masks[r].m;
            masks[r].span.assign(m.h, 0);
            masks[r].minSpan = UINT32_MAX;
            for (uint32_t j = 0; j < m.h; ++j) if (m.rowFirst[j] >= 0) {
                masks[r].span[j] = uint32_t(m.rowLast[j] - m.rowFirst[j] + 1);
                masks[r].minSpan = std::min(masks[r].minSpan, masks[r].span[j]);
            }
            if (masks[r].minSpan == UINT32_MAX) masks[r].minSpan = 0;
            return masks[r];
        };
        // the rotations' extents are known without rasterising: odd quarter turns swap width and height
        auto maskW = [&](int r) { const double bw = charts[id].widthM * d, bh = charts[id].heightM * d; return static_cast<uint32_t>(std::ceil(((r & 1) ? bh : bw) - 1e-9)) + 2 * prm.gutter + 1; };
        auto maskH = [&](int r) { const double bw = charts[id].widthM * d, bh = charts[id].heightM * d; return static_cast<uint32_t>(std::ceil(((r & 1) ? bw : bh) - 1e-9)) + 2 * prm.gutter + 1; };
        // the chart's row spans at (x, y) against the placed bits: -1 when free, else the first x worth trying next (the
        // largest skip any colliding row allows: every x before it still collides in that row). The search for a hole
        // inside the extent is budgeted per chart; the positions that grow the extent are always searched.
        uint32_t hotRow = 0;
        uint64_t budget = prm.searchBudget ? prm.searchBudget : UINT64_MAX;
        auto collide = [&](const BitMask& m, uint32_t x, uint32_t y) -> int64_t {
            if (budget) --budget;
            int64_t skip = -1;
            for (uint32_t k = 0; k < m.h; ++k) {
                const uint32_t j = (k + hotRow) % m.h;
                if (m.rowFirst[j] < 0) continue;
                const int64_t hitBit = lastSetInRange(atlas, y + j, x + uint32_t(m.rowFirst[j]), x + uint32_t(m.rowLast[j]));
                if (hitBit >= 0) {
                    if (skip < 0) hotRow = j;
                    skip = std::max(skip, hitBit - m.rowFirst[j] + 1);
                    if (skip >= int64_t(x) + 64) break;  // far enough: no need to read every row
                }
            }
            return skip;
        };
        auto leftBound = [&](const BitMask& m, uint32_t y) {
            int64_t x0 = 0;
            const uint32_t stride = std::max<uint32_t>(1, m.h / 16);
            for (uint32_t j = 0; j < m.h; j += stride) if (m.rowFirst[j] >= 0) x0 = std::max<int64_t>(x0, int64_t(firstFree[y + j]) - m.rowFirst[j]);
            return x0;
        };
        struct Best { double cost = HUGE_VAL, area = HUGE_VAL; uint32_t x = 0, y = 0; int rot = -1; } best;
        // phase 1: wholly inside the current extent (the extent does not grow, so the first fit in scan order is optimal)
        for (int r = 0; r < nRot && best.rot < 0; ++r) {
            if (maskW(r) > extW || maskH(r) > extH) continue;
            const BitMask& m = mask(r).m;
            const uint32_t xMax = extW - m.w;
            for (uint32_t y = 0; y + m.h <= extH && best.rot < 0 && budget;) {
                // rows whose clear runs inside the extent are all shorter than the chart's narrowest span block every y
                // that covers them
                bool blocked = false;
                for (uint32_t j = m.h; j-- > 0;) {
                    const uint32_t row = y + j;
                    const uint32_t avail = std::max<uint32_t>(innerRun[row], extW > uint32_t(lastSet[row] + 1) ? extW - uint32_t(lastSet[row] + 1) : 0);
                    if (avail < masks[r].minSpan) { y = row + 1; blocked = true; break; }
                    if (masks[r].span[j] > avail) { y += 1; blocked = true; break; }
                }
                if (blocked) continue;
                for (int64_t x = leftBound(m, y); x <= int64_t(xMax) && budget;) {
                    const int64_t next = collide(m, uint32_t(x), y);
                    if (next < 0) { best = {std::max(double(extW), extH * aspect), double(extW) * extH, uint32_t(x), y, r}; break; }
                    x = std::max(x + 1, next);
                }
                ++y;
            }
        }
        // phase 2: positions that grow the extent: the band right of the inside columns, and the rows below
        if (best.rot < 0) {
            for (int r = 0; r < nRot; ++r) {
                if (maskW(r) > capW || maskH(r) > capH) continue;
                const BitMask& m = mask(r).m;
                const uint32_t yMax = std::min(capH - m.h, extH);
                for (uint32_t y = 0; y <= yMax; ++y) {
                    const double newH = std::max<double>(extH, y + m.h);
                    if (newH * aspect > best.cost) break;
                    const bool insideRows = y + m.h <= extH;
                    int64_t x = leftBound(m, y);
                    if (insideRows && extW >= m.w) x = std::max<int64_t>(x, int64_t(extW - m.w) + 1);  // phase 1 tried the rest
                    for (; x + m.w <= capW;) {
                        const double newW = std::max<double>(extW, double(x) + m.w);
                        const double cost = std::max(newW, newH * aspect), ar = newW * newH;
                        if (cost > best.cost || (cost == best.cost && ar >= best.area)) break;  // non-decreasing in x
                        const int64_t next = collide(m, uint32_t(x), y);
                        if (next < 0) { best = {cost, ar, uint32_t(x), y, r}; break; }
                        x = std::max(x + 1, next);
                    }
                }
            }
        }
        if (best.rot < 0) return out;  // does not fit
        const BitMask& m = masks[best.rot].m;
        for (uint32_t j = 0; j < m.h; ++j) {
            for (uint32_t wi = 0; wi < m.words; ++wi) {
                uint64_t mb = m.bits[size_t(j) * m.words + wi];
                while (mb) {
                    uint32_t b = __builtin_ctzll(mb);
                    mb &= mb - 1;
                    uint32_t xx = best.x + wi * 64 + b;
                    if (xx < capW) atlas.set(xx, best.y + j);
                }
            }
            refreshRow(best.y + j);
        }
        BitmapPlacement& p = out.placements[id];
        p.x = best.x; p.y = best.y; p.w = m.w; p.h = m.h; p.rotation = static_cast<uint8_t>(best.rot);
        extW = std::max(extW, best.x + m.w);
        extH = std::max(extH, best.y + m.h);
    }
    out.ok = true;
    out.width = extW;
    out.height = extH;
    return out;
}

}  // namespace scratchbox::uv_atlas
