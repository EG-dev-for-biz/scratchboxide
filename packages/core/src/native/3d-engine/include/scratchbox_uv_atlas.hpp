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

}  // namespace scratchbox::uv_atlas
