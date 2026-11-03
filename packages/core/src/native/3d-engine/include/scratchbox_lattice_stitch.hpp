/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

#ifndef SCRATCHBOX_LATTICE_STITCH_HPP
#define SCRATCHBOX_LATTICE_STITCH_HPP

/**
 * The rebuilt walls stitched to the scan cut to them, natively (packages/core/src/node/3d-engine/staged-location/
 * pipeline-k/lattice-stitch.ts stitchLattice, which says what and why; this is its arithmetic, step for step): the clay
 * welded, its open edges (of exactly one triangle), each rebuilt facade's outline segments joined to the scan's cut along
 * them by a strip in the segment's vertical plane, the walls meeting at a corner zipped, and the outline edges joined to
 * nothing reported with their cells. The strips' triangles come back for the caller to append (appendTriangles).
 *
 * The TypeScript filters every open scan vertex and walks every open edge for each segment; here they are found by range
 * queries on the facade's open vertices sorted along s and t and by each vertex's own open edges, then put back in the
 * TypeScript's order (the open vertices' order, the open edges' order), so every path, chain and triangle is its own.
 * Facades are one task each, gathered in their order.
 */

#include "scratchbox_js_math.hpp"
#include "scratchbox_open_loop_fill.hpp"
#include "scratchbox_thread_pool.hpp"

#include <algorithm>
#include <array>
#include <cmath>
#include <cstdint>
#include <map>
#include <optional>
#include <stdexcept>
#include <string>
#include <unordered_map>
#include <unordered_set>
#include <vector>

// V8 never fuses a multiply and an add
#pragma clang fp contract(off)

namespace scratchbox {
namespace lattice_stitch {

using V3 = std::array<double, 3>;

/** LATTICE_STITCH_PARAMS' stitch fields (lattice-stitch.ts stitchParamVector). */
struct Params {
    double weldM, onLineM, cornerGapM, depthBandM;
    static constexpr size_t kCount = 4;
    static Params from(const std::vector<double>& v) {
        if (v.size() != kCount) throw std::runtime_error("the stitch takes " + std::to_string(kCount) + " parameters, got " + std::to_string(v.size()));
        return {v[0], v[1], v[2], v[3]};
    }
};

/** A rebuilt facade as the stitch reads it: its frame, lattice lines, rebuilt cells and their depths (row by row). */
struct Facade {
    int facadeId = 0;
    V3 centroid{}, normal{}, axisS{}, axisT{};
    std::vector<double> s, t, depth;
    std::vector<uint8_t> built;
};

/** A triangle primitive of the clay: its rebuilt wall (-1: scan), positions and indices (none: a soup). */
struct Prim { int wall = -1; std::vector<double> X; std::vector<uint32_t> I; bool indexed = false; };

struct Result {
    double segments = 0, stitched = 0, stripTriangles = 0, cornersZipped = 0, unjoined = 0;
    /** Why segments found no strip, in the order each reason first came. */
    std::vector<std::pair<std::string, double>> why;
    /** The cells left unjoined per facade id, in the order each facade first came. */
    std::vector<std::pair<int, std::vector<std::array<int, 2>>>> unjoinedCells;
    std::vector<std::array<V3, 3>> out;
};

namespace detail {

inline double dot(const V3& a, const V3& b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
constexpr uint64_t kEdgeBase = uint64_t(1) << 26;
inline uint64_t ekey(int a, int b) { return a < b ? uint64_t(a) * kEdgeBase + uint64_t(b) : uint64_t(b) * kEdgeBase + uint64_t(a); }

/** welded's key: Math.round of each coordinate over weldM (-0 the same as 0). */
struct WeldKey { int64_t x, y, z; bool operator==(const WeldKey& o) const { return x == o.x && y == o.y && z == o.z; } };
struct WeldHash { size_t operator()(const WeldKey& k) const { uint64_t h = static_cast<uint64_t>(k.x) * 0x9E3779B97F4A7C15ull; h ^= static_cast<uint64_t>(k.y) + 0x7F4A7C15ull + (h << 6) + (h >> 2); h ^= static_cast<uint64_t>(k.z) + 0x165667B1ull + (h << 6) + (h >> 2); return static_cast<size_t>(h); } };

struct Welded {
    std::vector<V3> pos;
    std::vector<std::array<int, 3>> tris;
    std::vector<int> wall;
    std::unordered_map<WeldKey, int, WeldHash> id;
    double weldM = 0;
    WeldKey key(double x, double y, double z) const {
        return {static_cast<int64_t>(js::round(x / weldM)), static_cast<int64_t>(js::round(y / weldM)), static_cast<int64_t>(js::round(z / weldM))};
    }
    /** idOf(Float32Array.from(p)): the point rounded to float32 first. */
    int idOfF32(const V3& p) const {
        const auto it = id.find(key(static_cast<float>(p[0]), static_cast<float>(p[1]), static_cast<float>(p[2])));
        return it == id.end() ? -1 : it->second;
    }
};

inline Welded weld(const std::vector<Prim>& prims, double weldM) {
    Welded w;
    w.weldM = weldM;
    const auto q = [&](double x, double y, double z) {
        const WeldKey k = w.key(x, y, z);
        const auto it = w.id.find(k);
        if (it != w.id.end()) return it->second;
        const int v = static_cast<int>(w.pos.size());
        w.id.emplace(k, v);
        w.pos.push_back({x, y, z});
        return v;
    };
    for (const Prim& p : prims) {
        const size_t n = p.indexed ? p.I.size() : p.X.size() / 3;
        for (size_t t = 0; t + 2 < n; t += 3) {
            std::array<int, 3> f{};
            for (int j = 0; j < 3; ++j) { const size_t i = p.indexed ? p.I[t + static_cast<size_t>(j)] : t + static_cast<size_t>(j); f[static_cast<size_t>(j)] = q(p.X[i * 3], p.X[i * 3 + 1], p.X[i * 3 + 2]); }
            if (f[0] == f[1] || f[1] == f[2] || f[0] == f[2]) continue;
            w.tris.push_back(f);
            w.wall.push_back(p.wall);
        }
    }
    return w;
}

/** openEdges(tris, undefined, true): edges of exactly one triangle, in the order each edge first came. */
inline std::vector<std::array<int, 2>> openEdgesOnce(const std::vector<std::array<int, 3>>& tris) {
    std::unordered_map<uint64_t, std::pair<uint32_t, uint32_t>> c;  // key -> (first seen, count)
    std::vector<uint64_t> order;
    c.reserve(tris.size() * 2);
    for (const auto& f : tris) for (int k = 0; k < 3; ++k) {
        const uint64_t e = ekey(f[static_cast<size_t>(k)], f[static_cast<size_t>((k + 1) % 3)]);
        auto it = c.find(e);
        if (it == c.end()) { c.emplace(e, std::make_pair(static_cast<uint32_t>(order.size()), 1u)); order.push_back(e); }
        else it->second.second++;
    }
    std::vector<std::array<int, 2>> out;
    for (uint64_t e : order) if (c[e].second == 1) out.push_back({static_cast<int>(e / kEdgeBase), static_cast<int>(e % kEdgeBase)});
    return out;
}

/** Walks a vertex adjacency (lists in insertion order) into paths from its ends, as the TypeScript walks them: keys in insertion order. */
struct Adjacency {
    std::vector<int> keys;
    std::unordered_map<int, std::vector<int>> lists;
    void add(int a, int b) {
        auto it = lists.find(a);
        if (it == lists.end()) { keys.push_back(a); lists.emplace(a, std::vector<int>{b}); }
        else it->second.push_back(b);
    }
    template <class OnPath>
    void paths(OnPath onPath) const {
        std::unordered_set<int> seen;
        for (int start : keys) {
            if (seen.count(start) || lists.at(start).size() != 1) continue;
            std::vector<int> path{start};
            seen.insert(start);
            int prev = -1, cur = start;
            for (;;) {
                int nx = -1;
                for (int x : lists.at(cur)) if (x != prev && !seen.count(x)) { nx = x; break; }
                if (nx < 0) break;
                path.push_back(nx);
                seen.insert(nx);
                prev = cur;
                cur = nx;
            }
            onPath(path);
        }
    }
};

struct Local { int v; double s, t, d; size_t order; };

/** One facade's segments: its strips, its misses in order, the failed segments with their cells and wall edges. */
struct FacadeOut {
    double segments = 0, stitched = 0;
    std::vector<std::string> misses;
    struct Failed { std::array<int, 2> cell; bool hasEdge; std::array<int, 2> edge; };
    std::vector<Failed> failed;
    std::vector<std::array<V3, 3>> out;
};

}  // namespace detail

/** stitchLattice's geometry: the strips and corner zips, the report and the cells left unjoined. */
inline Result stitch(const std::vector<Prim>& prims, const std::vector<Facade>& facades, const Params& P, FixedThreadPool& pool) {
    using namespace detail;
    const Welded w = weld(prims, P.weldM);
    const auto open = openEdgesOnce(w.tris);
    // openVerts in its Set's order; each vertex's open edges by their index in `open`
    std::vector<int> openOrder;
    std::unordered_map<int, size_t> openRank;
    std::unordered_map<int, std::vector<uint32_t>> edgesOf;
    for (size_t i = 0; i < open.size(); ++i) for (int v : open[i]) {
        if (!openRank.count(v)) { openRank.emplace(v, openOrder.size()); openOrder.push_back(v); }
        edgesOf[v].push_back(static_cast<uint32_t>(i));
    }
    const auto isOpen = [&](int v) { return v >= 0 && openRank.count(v) > 0; };
    std::vector<FacadeOut> per(facades.size());
    pool.forEach(facades.size(), [&](size_t fi) {
        const Facade& F = facades[fi];
        FacadeOut& o = per[fi];
        const size_t ns = F.s.size() - 1, nt = F.t.size() - 1;
        const auto world = [&](double sv, double tv, double d) { V3 p; for (int k = 0; k < 3; ++k) p[static_cast<size_t>(k)] = F.centroid[static_cast<size_t>(k)] + sv * F.axisS[static_cast<size_t>(k)] + tv * F.axisT[static_cast<size_t>(k)] + d * F.normal[static_cast<size_t>(k)]; return p; };
        // the open scan vertices near this facade, in openVerts' order, and sorted along s and along t for the lookups
        std::vector<Local> local;
        for (size_t i = 0; i < openOrder.size(); ++i) {
            const int v = openOrder[i];
            const V3 m{w.pos[static_cast<size_t>(v)][0] - F.centroid[0], w.pos[static_cast<size_t>(v)][1] - F.centroid[1], w.pos[static_cast<size_t>(v)][2] - F.centroid[2]};
            const Local x{v, dot(m, F.axisS), dot(m, F.axisT), dot(m, F.normal), local.size()};
            if (std::abs(x.d) <= P.depthBandM + 0.01 && x.s >= F.s[0] - 0.01 && x.s <= F.s[ns] + 0.01 && x.t >= F.t[0] - 0.01 && x.t <= F.t[nt] + 0.01) local.push_back(x);
        }
        std::vector<size_t> byS(local.size()), byT(local.size());
        for (size_t i = 0; i < local.size(); ++i) byS[i] = byT[i] = i;
        std::sort(byS.begin(), byS.end(), [&](size_t a, size_t b) { return local[a].s < local[b].s || (local[a].s == local[b].s && a < b); });
        std::sort(byT.begin(), byT.end(), [&](size_t a, size_t b) { return local[a].t < local[b].t || (local[a].t == local[b].t && a < b); });
        std::array<int, 2> cell{0, 0};
        const auto segment = [&](double s0, double t0, double s1, double t1, double d) {
            o.segments++;
            const int A = w.idOfF32(world(s0, t0, d)), B = w.idOfF32(world(s1, t1, d));
            const bool hasEdge = A >= 0 && B >= 0;
            const auto miss = [&](const char* k) { o.misses.push_back(k); o.failed.push_back({cell, hasEdge, {A, B}}); };
            if (A < 0 || B < 0) return miss("wall edge not found");
            if (!isOpen(A) || !isOpen(B)) return miss("wall edge not open");
            const bool vertical = s0 == s1;
            const double len = vertical ? t1 - t0 : s1 - s0;
            // on the line: |s - s0| <= onLineM (vertical) or |t - t0| <= onLineM, within the segment's span; in local's order
            const double lo = vertical ? js::min(t0, t1) - P.onLineM : js::min(s0, s1) - P.onLineM, hi = vertical ? js::max(t0, t1) + P.onLineM : js::max(s0, s1) + P.onLineM;
            const double at = vertical ? s0 : t0;
            const std::vector<size_t>& idx = vertical ? byS : byT;
            const auto key = [&](size_t i) { return vertical ? local[i].s : local[i].t; };
            // the candidates lie within onLineM (and a margin for rounding) of the line along the sorted axis; the test is the TypeScript's
            auto first = std::lower_bound(idx.begin(), idx.end(), at - P.onLineM - 1e-9 * (1 + std::abs(at)), [&](size_t i, double v) { return key(i) < v; });
            std::vector<size_t> on;
            for (auto it = first; it != idx.end() && key(*it) <= at + P.onLineM + 1e-9 * (1 + std::abs(at)); ++it) {
                const Local& x = local[*it];
                if (x.v == A || x.v == B) continue;
                const bool hit = vertical ? std::abs(x.s - s0) <= P.onLineM && x.t >= lo && x.t <= hi : std::abs(x.t - t0) <= P.onLineM && x.s >= lo && x.s <= hi;
                if (hit) on.push_back(*it);
            }
            if (on.empty()) return miss("no scan cut on the line");
            std::sort(on.begin(), on.end());
            const auto u = [&](const Local& x) { return (vertical ? x.t - t0 : x.s - s0) / len; };
            std::unordered_map<int, double> uOf;
            std::unordered_map<int, size_t> onAt;
            for (size_t i : on) { uOf[local[i].v] = u(local[i]); onAt[local[i].v] = i; }
            // the open edges with both ends on the line, in `open`'s order
            std::vector<uint32_t> es;
            for (size_t i : on) for (uint32_t e : edgesOf.at(local[i].v)) { const auto& ab = open[e]; if (uOf.count(ab[0]) && uOf.count(ab[1])) es.push_back(e); }
            std::sort(es.begin(), es.end());
            es.erase(std::unique(es.begin(), es.end()), es.end());
            Adjacency ladj;
            for (uint32_t e : es) { ladj.add(open[e][0], open[e][1]); ladj.add(open[e][1], open[e][0]); }
            std::vector<int> best;
            double bestSpan = -1;
            ladj.paths([&](const std::vector<int>& path) {
                const double span = std::abs(uOf.at(path.back()) - uOf.at(path.front()));
                if (span > bestSpan) { bestSpan = span; best = path; }
            });
            if (best.empty() || bestSpan < 0.05) return miss("no cut path along the line");
            if (uOf.at(best.front()) < uOf.at(best.back())) std::reverse(best.begin(), best.end());
            std::vector<int> loop{A, B};
            loop.insert(loop.end(), best.begin(), best.end());
            std::vector<std::array<double, 2>> xy;
            for (int v : loop) {
                if (v == A) xy.push_back({0, d});
                else if (v == B) xy.push_back({1, d});
                else { const Local& x = local[onAt.at(v)]; xy.push_back({u(x), x.d}); }
            }
            open_loop_fill::detail::Earcut ec;
            const auto tri = open_loop_fill::detail::triangulate(loop, xy, ec);
            if (!tri) return miss("strip did not triangulate");
            o.stitched++;
            for (const auto& t : *tri) o.out.push_back({w.pos[static_cast<size_t>(t[0])], w.pos[static_cast<size_t>(t[1])], w.pos[static_cast<size_t>(t[2])]});
        };
        for (size_t b = 0; b < nt; ++b) for (size_t a = 0; a < ns; ++a) {
            if (!F.built[b * ns + a]) continue;
            const double d = F.depth[b * ns + a];
            cell = {static_cast<int>(a), static_cast<int>(b)};
            if (a == 0 || !F.built[b * ns + a - 1]) segment(F.s[a], F.t[b], F.s[a], F.t[b + 1], d);
            if (a == ns - 1 || !F.built[b * ns + a + 1]) segment(F.s[a + 1], F.t[b], F.s[a + 1], F.t[b + 1], d);
            if (b == 0 || !F.built[(b - 1) * ns + a]) segment(F.s[a], F.t[b], F.s[a + 1], F.t[b], d);
            if (b == nt - 1 || !F.built[(b + 1) * ns + a]) segment(F.s[a], F.t[b + 1], F.s[a + 1], F.t[b + 1], d);
        }
    });
    Result R;
    struct Failed { int facadeId; std::array<int, 2> cell; bool hasEdge; std::array<int, 2> edge; };
    std::vector<Failed> failed;
    std::map<std::string, size_t> whyAt;
    for (size_t fi = 0; fi < facades.size(); ++fi) {
        FacadeOut& o = per[fi];
        R.segments += o.segments;
        R.stitched += o.stitched;
        for (const std::string& k : o.misses) {
            const auto it = whyAt.find(k);
            if (it == whyAt.end()) { whyAt.emplace(k, R.why.size()); R.why.push_back({k, 1}); }
            else R.why[it->second].second++;
        }
        for (const auto& f : o.failed) failed.push_back({facades[fi].facadeId, f.cell, f.hasEdge, f.edge});
        for (auto& t : o.out) R.out.push_back(t);
    }
    // walls meeting at a building corner: the open wall edges no strip used, chained per facade and zipped by height
    const auto idsOf = [&](const std::array<V3, 3>& t) { return std::array<int, 3>{w.idOfF32(t[0]), w.idOfF32(t[1]), w.idOfF32(t[2])}; };
    std::unordered_set<uint64_t> usedEdge;
    for (const auto& t : R.out) { const auto ids = idsOf(t); for (int k = 0; k < 3; ++k) usedEdge.insert(ekey(ids[static_cast<size_t>(k)], ids[static_cast<size_t>((k + 1) % 3)])); }
    std::unordered_map<int, int> wallOf;
    for (size_t i = 0; i < w.tris.size(); ++i) if (w.wall[i] >= 0) for (int v : w.tris[i]) wallOf[v] = w.wall[i];
    std::vector<int> facadeKeys;
    std::unordered_map<int, std::vector<std::array<int, 2>>> byFacade;
    for (const auto& e : open) {
        if (usedEdge.count(ekey(e[0], e[1]))) continue;
        const auto wa = wallOf.find(e[0]), wb = wallOf.find(e[1]);
        if (wa == wallOf.end() || wb == wallOf.end() || wa->second != wb->second) continue;
        if (!(std::abs(w.pos[static_cast<size_t>(e[0])][1] - w.pos[static_cast<size_t>(e[1])][1]) > 1e-6)) continue;
        if (!byFacade.count(wa->second)) facadeKeys.push_back(wa->second);
        byFacade[wa->second].push_back(e);
    }
    struct Chain { int facade; std::vector<int> vs; };
    std::vector<Chain> chains;
    const auto y = [&](int v) { return w.pos[static_cast<size_t>(v)][1]; };
    for (int facade : facadeKeys) {
        Adjacency adj;
        for (const auto& e : byFacade[facade]) { adj.add(e[0], e[1]); adj.add(e[1], e[0]); }
        adj.paths([&](const std::vector<int>& vs) {
            if (vs.size() < 2) return;
            std::vector<int> c = vs;
            if (!(y(c.front()) <= y(c.back()))) std::reverse(c.begin(), c.end());
            chains.push_back({facade, std::move(c)});
        });
    }
    const auto horiz = [&](int a, int b) { return js::hypot({w.pos[static_cast<size_t>(a)][0] - w.pos[static_cast<size_t>(b)][0], w.pos[static_cast<size_t>(a)][2] - w.pos[static_cast<size_t>(b)][2]}); };
    std::vector<uint8_t> taken(chains.size());
    for (size_t i = 0; i < chains.size(); ++i) {
        if (taken[i]) continue;
        const Chain& c1 = chains[i];
        long best = -1;
        double bestGap = js::kInf;
        for (size_t j = 0; j < chains.size(); ++j) {
            const Chain& c2 = chains[j];
            if (j == i || taken[j] || c2.facade == c1.facade) continue;
            const double lo = js::max(y(c1.vs.front()), y(c2.vs.front())), hi = js::min(y(c1.vs.back()), y(c2.vs.back()));
            if (!(hi - lo > 0.5)) continue;
            const double gap = horiz(c1.vs.front(), c2.vs.front()) + horiz(c1.vs.back(), c2.vs.back());
            if (gap / 2 <= P.cornerGapM && gap < bestGap) { bestGap = gap; best = static_cast<long>(j); }
        }
        if (best < 0) continue;
        taken[i] = 1;
        taken[static_cast<size_t>(best)] = 1;
        const std::vector<int>& a = c1.vs;
        const std::vector<int>& b = chains[static_cast<size_t>(best)].vs;
        size_t x = 0, z = 0;
        while (x + 1 < a.size() || z + 1 < b.size()) {
            if (z + 1 >= b.size() || (x + 1 < a.size() && y(a[x + 1]) <= y(b[z + 1]))) { R.out.push_back({w.pos[static_cast<size_t>(a[x])], w.pos[static_cast<size_t>(b[z])], w.pos[static_cast<size_t>(a[x + 1])]}); x++; }
            else { R.out.push_back({w.pos[static_cast<size_t>(a[x])], w.pos[static_cast<size_t>(b[z])], w.pos[static_cast<size_t>(b[z + 1])]}); z++; }
        }
        R.cornersZipped++;
    }
    R.stripTriangles = static_cast<double>(R.out.size());
    // a failed segment is joined after all when the corner zip (or another strip) used its wall edge; the rest are holes
    std::unordered_set<uint64_t> joined;
    for (const auto& t : R.out) { const auto ids = idsOf(t); for (int k = 0; k < 3; ++k) { const int p = ids[static_cast<size_t>(k)], q = ids[static_cast<size_t>((k + 1) % 3)]; if (p >= 0 && q >= 0) joined.insert(ekey(p, q)); } }
    std::unordered_map<int, size_t> cellsAt;
    for (const Failed& x : failed) {
        if (x.hasEdge && (joined.count(ekey(x.edge[0], x.edge[1])) || !isOpen(x.edge[0]))) continue;
        R.unjoined++;
        auto it = cellsAt.find(x.facadeId);
        if (it == cellsAt.end()) { it = cellsAt.emplace(x.facadeId, R.unjoinedCells.size()).first; R.unjoinedCells.push_back({x.facadeId, {}}); }
        auto& l = R.unjoinedCells[it->second].second;
        if (std::none_of(l.begin(), l.end(), [&](const std::array<int, 2>& c) { return c == x.cell; })) l.push_back(x.cell);
    }
    return R;
}

}  // namespace lattice_stitch
}  // namespace scratchbox

#endif  // SCRATCHBOX_LATTICE_STITCH_HPP
