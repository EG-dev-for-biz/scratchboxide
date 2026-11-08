/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Constrained Delaunay triangulation in the plane, with exact predicates (scratchbox_exact_predicates.hpp), so no input
 * however near-degenerate (collinear runs, repeated points, a point on a segment) can make it fail or fold.
 * Method: incremental insertion with Lawson flips (Delaunay), constraints recovered by flipping the edges they cross
 * (Sloan, "A fast algorithm for generating constrained Delaunay triangulations", 1993), quality refinement by
 * circumcentre insertion with encroached-segment splitting (Chew 1989; Ruppert 1995; Shewchuk 1997).
 *
 * Segments are directed: crossing a segment from its left to its right lowers the winding number by one, so a loop's
 * inside (counter-clockwise outer loop, clockwise holes) has winding 1 and holes 0. Which triangles are kept is a fill
 * rule on that winding (even-odd ignores the loops' directions; non-zero and positive make unions of overlapping
 * loops). Segments that cross are split where they meet (a Steiner point, counted); `triangulatePolygon` refuses those
 * so a caller indexing its own loop's vertices gets only triangles over them.
 *
 * Refinement inserts points only inside the kept region; with `splitSegments` off no segment is ever split (a cap whose
 * rim is shared with a neighbouring mesh keeps its rim vertices exactly), and triangles whose circumcentre would encroach
 * a segment are left as they are.
 */

#pragma once

#include "scratchbox_exact_predicates.hpp"

#include <algorithm>
#include <array>
#include <cmath>
#include <cstdint>
#include <cstring>
#include <deque>
#include <limits>
#include <optional>
#include <unordered_map>
#include <vector>

namespace scratchbox {
namespace cdt {

using P2 = std::array<double, 2>;
using Tri3 = std::array<int, 3>;

enum class Fill { EvenOdd, NonZero, Positive };

struct Options {
    Fill fill = Fill::EvenOdd;
    /** Insert circumcentres until every kept triangle's smallest angle reaches minAngleDeg (and its area maxArea, when > 0). */
    bool refine = false;
    double minAngleDeg = 20.0;
    double maxArea = 0;
    /** Refinement may split segments at their midpoints (off: segment vertices stay exactly the input's). */
    bool splitSegments = true;
    /** At most this many refinement points (negative: 20 per input point, plus 500). */
    int maxSteiner = -1;
    /** No refinement point is made nearer than this to a vertex, no segment shorter than twice it split (0: 1e-4 of the
     *  input's extent). Small input angles, where Ruppert's method would never stop, end here. */
    double minEdge = 0;
};

struct Output {
    /** Every vertex: the input's (duplicates merged), then the points refinement and crossing segments added. */
    std::vector<P2> points;
    /** Per input point, its vertex. */
    std::vector<int> inputVertex;
    /** Kept triangles, counter-clockwise, and each one's winding number. */
    std::vector<Tri3> tris;
    std::vector<int> winding;
    /** Points added where two segments cross, and by refinement (on segments, inside). */
    int crossingPoints = 0, segmentSplits = 0, interiorPoints = 0;
    /** Segments that could not be recovered (should stay 0; reported rather than hidden). */
    int lostSegments = 0;
};

namespace detail {

constexpr int kNone = -1;

struct Triangle {
    std::array<int, 3> v{kNone, kNone, kNone};
    std::array<int, 3> n{kNone, kNone, kNone};  // neighbour across edge k (opposite v[k])
    std::array<int, 3> wind{0, 0, 0};           // winding change from this triangle across edge k
    std::array<uint8_t, 3> con{0, 0, 0};        // edge k is (part of) a segment
    int w = 0;                                   // winding number (refinement keeps it current)
    bool alive = true;
};

class Mesh {
public:
    std::vector<P2> P;
    std::vector<Triangle> T;
    std::vector<int> vtri;  // a live triangle at each vertex
    int last = 0;
    int superBase = 0;
    int crossings = 0, splits = 0, interior = 0, lost = 0;
    std::unordered_map<uint64_t, int> byPoint;  // exact point -> vertex
    std::vector<int>* touched = nullptr;        // refinement's work list: triangles made or changed
    void touch(int t) { if (touched) touched->push_back(t); }

    static uint64_t bits(double x) { uint64_t u; std::memcpy(&u, &x, 8); return u; }
    static uint64_t pointKey(const P2& p) {
        const double x = p[0] == 0 ? 0.0 : p[0], y = p[1] == 0 ? 0.0 : p[1];  // -0 and 0 are one point
        return bits(x) * 0x9E3779B97F4A7C15ull ^ (bits(y) + 0x632BE59BD9B4E019ull + (bits(x) << 6) + (bits(x) >> 2));
    }

    int edgeIndex(int t, int a, int b) const {
        const auto& v = T[t].v;
        for (int k = 0; k < 3; ++k) if (v[(k + 1) % 3] == a && v[(k + 2) % 3] == b) return k;
        for (int k = 0; k < 3; ++k) if (v[(k + 1) % 3] == b && v[(k + 2) % 3] == a) return k;
        return kNone;
    }
    int across(int t, int k) const {
        const int nb = T[t].n[k];
        if (nb == kNone) return kNone;
        return edgeIndex(nb, T[t].v[(k + 1) % 3], T[t].v[(k + 2) % 3]);
    }
    void link(int t, int k, int u, int j) {
        T[t].n[k] = u;
        if (u != kNone) T[u].n[j] = t;
    }
    int newTri(int a, int b, int c, int w) {
        Triangle tr;
        tr.v = {a, b, c};
        tr.w = w;
        T.push_back(tr);
        const int t = static_cast<int>(T.size()) - 1;
        vtri[a] = vtri[b] = vtri[c] = t;
        touch(t);
        return t;
    }

    void init(const std::vector<P2>& pts) {
        double lo[2] = {std::numeric_limits<double>::infinity(), std::numeric_limits<double>::infinity()};
        double hi[2] = {-lo[0], -lo[1]};
        for (const auto& p : pts) for (int k = 0; k < 2; ++k) { lo[k] = std::min(lo[k], p[k]); hi[k] = std::max(hi[k], p[k]); }
        if (pts.empty()) { lo[0] = lo[1] = 0; hi[0] = hi[1] = 1; }
        const double cx = (lo[0] + hi[0]) / 2, cy = (lo[1] + hi[1]) / 2;
        const double r = std::max({hi[0] - lo[0], hi[1] - lo[1], 1e-9}) * 64;
        superBase = 0;
        P = {{cx - 3 * r, cy - 2 * r}, {cx + 3 * r, cy - 2 * r}, {cx, cy + 3 * r}};
        vtri.assign(3, 0);
        T.clear();
        newTri(0, 1, 2, 0);
        last = 0;
    }
    bool isSuper(int v) const { return v < 3; }

    /** Where p lies: the triangle containing it, and the vertex (k) or edge (3 + k) it stands on, else -1. */
    std::pair<int, int> locate(const P2& p, int start = kNone) const {
        int t = start != kNone && T[start].alive ? start : last;
        if (!T[t].alive) for (t = static_cast<int>(T.size()) - 1; t >= 0 && !T[t].alive; --t) {}
        unsigned rot = 0;
        for (size_t guard = 0; guard < 4 * T.size() + 64; ++guard) {
            const auto& v = T[t].v;
            bool moved = false;
            for (int i = 0; i < 3; ++i) {
                const int k = static_cast<int>((i + rot) % 3);
                const int a = v[(k + 1) % 3], b = v[(k + 2) % 3];
                if (exact::orient2d(P[a], P[b], p) < 0 && T[t].n[k] != kNone) { t = T[t].n[k]; moved = true; break; }
            }
            rot = rot * 1103515245u + 12345u;
            if (!moved) break;
        }
        const auto& v = T[t].v;
        for (int k = 0; k < 3; ++k) if (P[v[k]][0] == p[0] && P[v[k]][1] == p[1]) return {t, k};
        for (int k = 0; k < 3; ++k) if (exact::orient2d(P[v[(k + 1) % 3]], P[v[(k + 2) % 3]], p) == 0) return {t, 3 + k};
        return {t, -1};
    }

    bool delaunayBad(int t, int k) const {
        if (T[t].con[k]) return false;
        const int u = T[t].n[k];
        if (u == kNone) return false;
        const int j = across(t, k);
        const int d = T[u].v[j];
        const auto& v = T[t].v;
        // a super vertex sits "at infinity": an edge to it is never flipped toward it unless the quad allows
        return exact::incircle(P[v[0]], P[v[1]], P[v[2]], P[d]) > 0;
    }

    /** Flip edge k of t (with its neighbour) into the other diagonal; returns the two new triangles' ids (t, u reused). */
    void flip(int t, int k) {
        const int u = T[t].n[k], j = across(t, k);
        const int a = T[t].v[k], b = T[t].v[(k + 1) % 3], c = T[t].v[(k + 2) % 3], d = T[u].v[j];
        // t = (a, b, c) with edge (b, c) shared; u = (d, c, b)
        const int tb = T[t].n[(k + 1) % 3], tbk = across(t, (k + 1) % 3);  // edge (c, a)
        const int tc = T[t].n[(k + 2) % 3], tck = across(t, (k + 2) % 3);  // edge (a, b)
        const int jb = edgeIndex(u, b, d), jc = edgeIndex(u, d, c);
        const int ub = T[u].n[jb], ubk = across(u, jb);  // edge (b, d)
        const int uc = T[u].n[jc], uck = across(u, jc);  // edge (d, c)
        const int wca = T[t].wind[(k + 1) % 3], wab = T[t].wind[(k + 2) % 3], wbd = T[u].wind[jb], wdc = T[u].wind[jc];
        const uint8_t cca = T[t].con[(k + 1) % 3], cab = T[t].con[(k + 2) % 3], cbd = T[u].con[jb], cdc = T[u].con[jc];
        const int w = T[t].w;
        // new t = (a, b, d), new u = (a, d, c)
        T[t].v = {a, b, d};
        T[u].v = {a, d, c};
        T[t].w = w;
        T[u].w = w;
        // t: edge 0 (b, d), edge 1 (d, a) shared, edge 2 (a, b)
        T[t].wind = {wbd, 0, wab};
        T[t].con = {cbd, 0, cab};
        // u: edge 0 (d, c), edge 1 (c, a), edge 2 (a, d) shared
        T[u].wind = {wdc, wca, 0};
        T[u].con = {cdc, cca, 0};
        link(t, 0, ub, ubk);
        link(t, 2, tc, tck);
        link(t, 1, u, 2);
        link(u, 0, uc, uck);
        link(u, 1, tb, tbk);
        vtri[a] = t; vtri[b] = t; vtri[d] = t; vtri[c] = u;
        touch(t);
        touch(u);
    }

    void legalize(std::vector<std::pair<int, int>>& stack) {
        while (!stack.empty()) {
            auto [t, k] = stack.back();
            stack.pop_back();
            if (!T[t].alive || !delaunayBad(t, k)) continue;
            const int u = T[t].n[k];
            flip(t, k);
            // the new outer edges opposite the inserted point: t's (b, d) and u's (d, c) -- both opposite a
            stack.push_back({t, 0});
            stack.push_back({u, 0});
        }
    }

    /** Splits triangle t at a new vertex q (1 -> 3) and restores Delaunay. */
    void splitTriangle(int t, int q) {
        const auto v = T[t].v;
        const auto n = T[t].n;
        const auto wind = T[t].wind;
        const auto con = T[t].con;
        const int w = T[t].w;
        int nk[3];
        for (int k = 0; k < 3; ++k) nk[k] = n[k] != kNone ? across(t, k) : kNone;
        // t becomes (q, v1, v2); two new: (q, v2, v0), (q, v0, v1)
        T[t].v = {q, v[1], v[2]};
        touch(t);
        const int t1 = newTri(q, v[2], v[0], w);
        const int t2 = newTri(q, v[0], v[1], w);
        vtri[v[1]] = t; vtri[v[2]] = t;
        const int ts[3] = {t, t1, t2};
        for (int k = 0; k < 3; ++k) {
            T[ts[k]].wind = {wind[k], 0, 0};
            T[ts[k]].con = {con[k], 0, 0};
            link(ts[k], 0, n[k], nk[k]);
        }
        // shared edges: t edge 1 (v2, q) with t1 edge 2 (q, v2); t1 edge 1 (v0, q) with t2 edge 2; t2 edge 1 (v1, q) with t edge 2
        link(t, 1, t1, 2);
        link(t1, 1, t2, 2);
        link(t2, 1, t, 2);
        vtri[q] = t;
        last = t;
        std::vector<std::pair<int, int>> st{{t, 0}, {t1, 0}, {t2, 0}};
        legalize(st);
    }

    /** Splits edge k of t at a new vertex q (2 -> 4, or 1 -> 2 on the hull) and restores Delaunay. */
    void splitEdge(int t, int k, int q) {
        const int u = T[t].n[k];
        const int j = u != kNone ? across(t, k) : kNone;
        const int a = T[t].v[k], b = T[t].v[(k + 1) % 3], c = T[t].v[(k + 2) % 3];
        const int ewind = T[t].wind[k];
        const uint8_t econ = T[t].con[k];
        // t: (a, b, c) edge (b, c) split at q -> t = (a, b, q), t1 = (a, q, c)
        const int tAB = T[t].n[(k + 2) % 3], tABk = across(t, (k + 2) % 3);
        const int tCA = T[t].n[(k + 1) % 3], tCAk = across(t, (k + 1) % 3);
        const int wAB = T[t].wind[(k + 2) % 3], wCA = T[t].wind[(k + 1) % 3];
        const uint8_t cAB = T[t].con[(k + 2) % 3], cCA = T[t].con[(k + 1) % 3];
        const int tw = T[t].w;
        T[t].v = {a, b, q};
        touch(t);
        const int t1 = newTri(a, q, c, tw);
        vtri[a] = t; vtri[b] = t;
        // t: edge 0 (b, q) part of split edge, edge 1 (q, a) shared with t1, edge 2 (a, b)
        T[t].wind = {ewind, 0, wAB};
        T[t].con = {econ, 0, cAB};
        link(t, 2, tAB, tABk);
        // t1: edge 0 (q, c) part of split edge, edge 1 (c, a), edge 2 (a, q) shared
        T[t1].wind = {ewind, wCA, 0};
        T[t1].con = {econ, cCA, 0};
        link(t1, 1, tCA, tCAk);
        link(t, 1, t1, 2);
        std::vector<std::pair<int, int>> st{{t, 2}, {t1, 1}};
        if (u != kNone) {
            // u: (d, c, b) edge (c, b) split -> u = (d, c, q), u1 = (d, q, b)
            const int d = T[u].v[j];
            const int uDC = T[u].n[(j + 2) % 3], uDCk = across(u, (j + 2) % 3);
            const int uBD = T[u].n[(j + 1) % 3], uBDk = across(u, (j + 1) % 3);
            const int wDC = T[u].wind[(j + 2) % 3], wBD = T[u].wind[(j + 1) % 3], uwind = T[u].wind[j];
            const uint8_t cDC = T[u].con[(j + 2) % 3], cBD = T[u].con[(j + 1) % 3];
            const int uw = T[u].w;
            T[u].v = {d, c, q};
            touch(u);
            const int u1 = newTri(d, q, b, uw);
            vtri[d] = u; vtri[c] = u;
            T[u].wind = {uwind, 0, wDC};
            T[u].con = {econ, 0, cDC};
            link(u, 2, uDC, uDCk);
            T[u1].wind = {uwind, wBD, 0};
            T[u1].con = {econ, cBD, 0};
            link(u1, 1, uBD, uBDk);
            link(u, 1, u1, 2);
            // across the split edge: t (b, q) with u1 (q, b); t1 (q, c) with u (c, q)
            link(t, 0, u1, 0);
            link(t1, 0, u, 0);
            st.push_back({u, 2});
            st.push_back({u1, 1});
        } else {
            T[t].n[0] = kNone;
            T[t1].n[0] = kNone;
        }
        vtri[q] = t;
        last = t;
        legalize(st);
    }

    int addVertex(const P2& p) {
        P.push_back(p);
        vtri.push_back(kNone);
        return static_cast<int>(P.size()) - 1;
    }

    /** Inserts p (or finds the vertex already there). */
    int insert(const P2& p, int start = kNone) {
        const uint64_t key = pointKey(p);
        auto it = byPoint.find(key);
        if (it != byPoint.end() && P[it->second][0] == p[0] && P[it->second][1] == p[1]) return it->second;
        auto [t, where] = locate(p, start);
        if (where >= 0 && where < 3) return T[t].v[where];
        const int q = addVertex(p);
        byPoint[key] = q;
        if (where >= 3) splitEdge(t, where - 3, q);
        else splitTriangle(t, q);
        return q;
    }

    /** A triangle with edge (a, b) running a -> b counter-clockwise in it, and that edge's index; kNone when absent. */
    std::pair<int, int> findEdge(int a, int b) const {
        const int t0 = vtri[a];
        if (t0 == kNone) return {kNone, kNone};
        // walk round a both ways
        int t = t0;
        for (int dir = 0; dir < 2; ++dir) {
            t = t0;
            for (size_t guard = 0; guard < T.size() + 4 && t != kNone; ++guard) {
                const auto& v = T[t].v;
                int ia = 0;
                while (v[ia] != a) ++ia;
                if (v[(ia + 1) % 3] == b) return {t, (ia + 2) % 3};
                // next triangle round a: across the edge (a, v[ia+1]) (dir 0) or (v[ia+2], a) (dir 1)
                const int k = dir == 0 ? (ia + 2) % 3 : (ia + 1) % 3;
                t = T[t].n[k];
                if (t == t0) break;
            }
        }
        return {kNone, kNone};
    }

    /** Marks the edge a -> b a segment, adding its winding step: from its left triangle to its right, -1. */
    void markSegment(int a, int b) {
        auto [t, k] = findEdge(a, b);
        if (t == kNone) {
            auto [t2, k2] = findEdge(b, a);
            if (t2 == kNone) { lost++; return; }
            T[t2].con[k2] = 1;
            T[t2].wind[k2] += 1;  // t2 lies right of a -> b
            const int u = T[t2].n[k2];
            if (u != kNone) { const int j = across(t2, k2); T[u].con[j] = 1; T[u].wind[j] -= 1; }
            return;
        }
        T[t].con[k] = 1;
        T[t].wind[k] -= 1;  // t lies left of a -> b
        const int u = T[t].n[k];
        if (u != kNone) { const int j = across(t, k); T[u].con[j] = 1; T[u].wind[j] += 1; }
    }

    /** Where segments (a, b) and (c, d) cross, in floating point (the caller keeps the topology). */
    P2 crossingPoint(int a, int b, int c, int d) const {
        const double d1 = exact::orient2dValue(P[c], P[d], P[a]), d2 = exact::orient2dValue(P[c], P[d], P[b]);
        double s = d1 / (d1 - d2);
        if (!(s > 0)) s = 0; else if (s > 1) s = 1;
        return {P[a][0] + (P[b][0] - P[a][0]) * s, P[a][1] + (P[b][1] - P[a][1]) * s};
    }

    void insertSegment(int a, int b, int depth = 0) {
        if (a == b) return;
        if (depth > 64) { lost++; return; }
        if (findEdge(a, b).first != kNone || findEdge(b, a).first != kNone) { markSegment(a, b); return; }
        // the triangle at a whose wedge holds the direction to b
        int t = vtri[a];
        int startT = kNone;
        for (size_t guard = 0; guard < T.size() + 4; ++guard) {
            const auto& v = T[t].v;
            int ia = 0;
            while (v[ia] != a) ++ia;
            const int l = v[(ia + 1) % 3], r = v[(ia + 2) % 3];
            const int ol = exact::orient2d(P[a], P[b], P[l]), orr = exact::orient2d(P[a], P[b], P[r]);
            // a vertex on the segment's ray, between a and b: split the segment there
            const auto between = [&](int x) {
                const double dx = P[b][0] - P[a][0], dy = P[b][1] - P[a][1];
                const double s = (P[x][0] - P[a][0]) * dx + (P[x][1] - P[a][1]) * dy;
                return s > 0 && s < dx * dx + dy * dy;
            };
            if (ol == 0 && between(l)) { insertSegment(a, l, depth + 1); insertSegment(l, b, depth + 1); return; }
            if (orr == 0 && between(r)) { insertSegment(a, r, depth + 1); insertSegment(r, b, depth + 1); return; }
            if (ol < 0 && orr > 0) { startT = t; break; }
            // rotate round a (counter-clockwise: across the edge (a, l)... the edge opposite r)
            const int k = (ia + 2) % 3;
            int nt = T[t].n[k];
            if (nt == kNone) nt = T[t].n[(ia + 1) % 3];
            if (nt == kNone) { lost++; return; }
            t = nt;
        }
        if (startT == kNone) { lost++; return; }
        // march across the triangles the segment crosses, gathering crossed edges
        std::vector<std::pair<int, int>> crossed;  // as vertex pairs
        t = startT;
        {
            const auto& v = T[t].v;
            int ia = 0;
            while (v[ia] != a) ++ia;
            crossed.push_back({v[(ia + 1) % 3], v[(ia + 2) % 3]});
        }
        int cur = t;
        for (size_t guard = 0; guard < T.size() + 4; ++guard) {
            auto [l, r] = crossed.back();
            // the edge (l, r) of cur, crossed; step across it
            const int k = edgeIndex(cur, l, r);
            if (T[cur].con[k]) {
                // two segments cross: split both at their meeting point and go on in two halves
                const P2 x = crossingPoint(a, b, l, r);
                const int q = addVertex(x);
                byPoint[pointKey(x)] = q;
                crossings++;
                splitEdge(cur, k, q);
                insertSegment(a, q, depth + 1);
                insertSegment(q, b, depth + 1);
                return;
            }
            const int nt = T[cur].n[k];
            if (nt == kNone) { lost++; return; }
            const int j = across(cur, k);
            const int x = T[nt].v[j];
            if (x == b) break;
            const int ox = exact::orient2d(P[a], P[b], P[x]);
            if (ox == 0) {
                // a vertex lies on the segment: recover up to it, then on from it
                recoverByFlips(a, x, crossed);
                insertSegment(x, b, depth + 1);
                return;
            }
            // crossed edges are kept as (right of a->b, left of it): x replaces the endpoint on its own side
            if (ox > 0) crossed.push_back({l, x});
            else crossed.push_back({x, r});
            cur = nt;
        }
        recoverByFlips(a, b, crossed);
    }

    /** Sloan: flip the edges crossing segment (a, b) until none does, then restore Delaunay round the new edges. */
    void recoverByFlips(int a, int b, std::vector<std::pair<int, int>> crossed) {
        std::deque<std::pair<int, int>> q(crossed.begin(), crossed.end());
        std::vector<std::pair<int, int>> fresh;
        size_t guard = 0, stall = 0;
        while (!q.empty() && guard++ < 1000000) {
            auto [u, w] = q.front();
            q.pop_front();
            auto [t, k] = findEdge(u, w);
            if (t == kNone) { auto f = findEdge(w, u); t = f.first; k = f.second; }
            if (t == kNone) continue;
            const int nb = T[t].n[k];
            if (nb == kNone) continue;
            const int x = T[t].v[k], y = T[nb].v[across(t, k)];
            const int p1 = T[t].v[(k + 1) % 3], p2 = T[t].v[(k + 2) % 3];
            // strictly convex quad (x, p1, y, p2): the flip is valid
            const bool convex = exact::orient2d(P[x], P[p1], P[y]) > 0 && exact::orient2d(P[y], P[p2], P[x]) > 0 && exact::orient2d(P[p1], P[y], P[p2]) > 0 && exact::orient2d(P[p2], P[x], P[p1]) > 0;
            if (!convex) {
                q.push_back({u, w});
                if (++stall > q.size() * 4 + 16) { lost++; return; }
                continue;
            }
            stall = 0;
            flip(t, k);
            // the new edge is (x, y): does it still cross (a, b)?
            const bool shares = x == a || x == b || y == a || y == b;
            const int s1 = exact::orient2d(P[a], P[b], P[x]), s2 = exact::orient2d(P[a], P[b], P[y]);
            const int s3 = exact::orient2d(P[x], P[y], P[a]), s4 = exact::orient2d(P[x], P[y], P[b]);
            if (!shares && s1 * s2 < 0 && s3 * s4 < 0) q.push_back({x, y});
            else fresh.push_back({x, y});
        }
        markSegment(a, b);
        // Delaunay restored over the new edges (never the segment)
        for (bool changed = true; changed;) {
            changed = false;
            for (auto& e : fresh) {
                if ((e.first == a && e.second == b) || (e.first == b && e.second == a)) continue;
                auto [t, k] = findEdge(e.first, e.second);
                if (t == kNone) { auto f = findEdge(e.second, e.first); t = f.first; k = f.second; }
                if (t == kNone || !delaunayBad(t, k)) continue;
                const int y = T[T[t].n[k]].v[across(t, k)], x = T[t].v[k];
                flip(t, k);
                e = {x, y};
                changed = true;
            }
        }
    }

    /** Every triangle's winding number, by a flood from the super triangle's corners (winding 0 out there). */
    void computeWinding() {
        std::vector<uint8_t> seen(T.size(), 0);
        std::vector<int> stack;
        for (size_t t = 0; t < T.size(); ++t) {
            if (!T[t].alive || seen[t]) continue;
            const auto& v = T[t].v;
            if (!(isSuper(v[0]) || isSuper(v[1]) || isSuper(v[2]))) continue;
            T[t].w = 0;
            seen[t] = 1;
            stack.push_back(static_cast<int>(t));
            while (!stack.empty()) {
                const int c = stack.back();
                stack.pop_back();
                for (int k = 0; k < 3; ++k) {
                    const int u = T[c].n[k];
                    if (u == kNone || seen[u]) continue;
                    seen[u] = 1;
                    T[u].w = T[c].w + T[c].wind[k];
                    stack.push_back(u);
                }
            }
        }
    }

    bool kept(int t, Fill fill) const {
        const auto& v = T[t].v;
        if (isSuper(v[0]) || isSuper(v[1]) || isSuper(v[2])) return false;
        const int w = T[t].w;
        switch (fill) {
            case Fill::EvenOdd: return (w & 1) != 0;
            case Fill::NonZero: return w != 0;
            case Fill::Positive: return w > 0;
        }
        return false;
    }

    // ------------------------------------------------------------------------------------ refinement

    static P2 circumcentre(const P2& a, const P2& b, const P2& c) {
        const double bx = b[0] - a[0], by = b[1] - a[1], cx = c[0] - a[0], cy = c[1] - a[1];
        const double d = 2 * (bx * cy - by * cx);
        const double b2 = bx * bx + by * by, c2 = cx * cx + cy * cy;
        return {a[0] + (cy * b2 - by * c2) / d, a[1] + (bx * c2 - cx * b2) / d};
    }
    double quality(int t, double& area) const {
        const auto& v = T[t].v;
        const P2 &a = P[v[0]], &b = P[v[1]], &c = P[v[2]];
        const double ab = std::hypot(b[0] - a[0], b[1] - a[1]), bc = std::hypot(c[0] - b[0], c[1] - b[1]), ca = std::hypot(a[0] - c[0], a[1] - c[1]);
        area = std::fabs(exact::orient2dValue(a, b, c)) / 2;
        if (!(area > 0)) return std::numeric_limits<double>::infinity();
        const double R = ab * bc * ca / (4 * area);
        return R / std::min({ab, bc, ca});  // circumradius over shortest edge: 1 / (2 sin(min angle))
    }
    /** The segment (t, k) is encroached by p: p sees it at more than 90 degrees. */
    bool encroaches(int t, int k, const P2& p) const {
        const P2& a = P[T[t].v[(k + 1) % 3]];
        const P2& b = P[T[t].v[(k + 2) % 3]];
        return (a[0] - p[0]) * (b[0] - p[0]) + (a[1] - p[1]) * (b[1] - p[1]) < 0;
    }
    void splitSegmentAt(int t, int k) {
        const P2& a = P[T[t].v[(k + 1) % 3]];
        const P2& b = P[T[t].v[(k + 2) % 3]];
        const P2 m{(a[0] + b[0]) / 2, (a[1] + b[1]) / 2};
        const int q = addVertex(m);
        byPoint[pointKey(m)] = q;
        splitEdge(t, k, q);
        splits++;
    }

    void refine(const Options& o) {
        const double limit = 1 / (2 * std::sin(std::min(o.minAngleDeg, 33.0) * M_PI / 180));
        const int maxAdd = o.maxSteiner >= 0 ? o.maxSteiner : static_cast<int>(20 * (P.size() - 3) + 500);
        double extent = 0;
        for (size_t i = 3; i < P.size(); ++i) for (int k = 0; k < 2; ++k) extent = std::max(extent, std::fabs(P[i][k] - P[3][k]));
        const double minEdge = o.minEdge > 0 ? o.minEdge : 1e-4 * std::max(extent, 1e-12);
        const auto segLen = [&](int t, int k) { const P2 &a = P[T[t].v[(k + 1) % 3]], &b = P[T[t].v[(k + 2) % 3]]; return std::hypot(a[0] - b[0], a[1] - b[1]); };
        int added = 0;
        // encroached segments first (Ruppert)
        if (o.splitSegments) {
            for (bool again = true; again && added < maxAdd;) {
                again = false;
                for (size_t t = 0; t < T.size() && added < maxAdd; ++t) {
                    if (!T[t].alive) continue;
                    for (int k = 0; k < 3; ++k) {
                        if (!T[t].con[k]) continue;
                        if (!(kept(static_cast<int>(t), o.fill) || (T[t].n[k] != kNone && kept(T[t].n[k], o.fill)))) continue;
                        if (segLen(static_cast<int>(t), k) > 2 * minEdge && encroaches(static_cast<int>(t), k, P[T[t].v[k]]) && !isSuper(T[t].v[k])) { splitSegmentAt(static_cast<int>(t), k); added++; again = true; break; }
                    }
                }
            }
        }
        // bad triangles from a work list: every kept triangle first, then whatever each insertion makes or changes
        std::vector<int> work, made;
        touched = &made;
        for (size_t t = 0; t < T.size(); ++t) work.push_back(static_cast<int>(t));
        std::vector<uint8_t> refused(T.size(), 0);
        while (!work.empty() && added < maxAdd) {
            const int worst = work.back();
            work.pop_back();
            if (refused.size() < T.size()) refused.resize(T.size(), 0);
            if (!T[worst].alive || refused[worst] || !kept(worst, o.fill)) continue;
            double area;
            double qv = quality(worst, area);
            if (o.maxArea > 0 && area > o.maxArea) qv = std::max(qv, limit * (1 + area / o.maxArea));
            if (!(qv > limit)) continue;
            const auto v = T[worst].v;
            if (std::min({segLen(worst, 0), segLen(worst, 1), segLen(worst, 2)}) < 2 * minEdge) { refused[worst] = 1; continue; }
            const P2 c = circumcentre(P[v[0]], P[v[1]], P[v[2]]);
            if (!std::isfinite(c[0]) || !std::isfinite(c[1])) { refused[worst] = 1; continue; }
            // walk toward c; a segment in the way, or one c would encroach, is split instead (or the triangle let be)
            auto [ct, where] = locate(c, worst);
            int blockT = kNone, blockK = kNone;
            {
                const P2 g{(P[v[0]][0] + P[v[1]][0] + P[v[2]][0]) / 3, (P[v[0]][1] + P[v[1]][1] + P[v[2]][1]) / 3};
                int t = worst;
                for (size_t guard = 0; guard < T.size() + 4 && t != ct; ++guard) {
                    const auto& tv = T[t].v;
                    int next = kNone;
                    for (int k = 0; k < 3; ++k) {
                        const P2 &a = P[tv[(k + 1) % 3]], &b = P[tv[(k + 2) % 3]];
                        if (exact::orient2d(a, b, c) < 0 && exact::orient2d(g, c, a) * exact::orient2d(g, c, b) <= 0) {
                            if (T[t].con[k]) { blockT = t; blockK = k; }
                            next = T[t].n[k];
                            break;
                        }
                    }
                    if (blockT != kNone || next == kNone) break;
                    t = next;
                }
            }
            if (blockT == kNone) for (int k = 0; k < 3; ++k) if (T[ct].con[k] && encroaches(ct, k, c)) { blockT = ct; blockK = k; break; }
            made.clear();
            if (blockT != kNone) {
                if (!o.splitSegments || segLen(blockT, blockK) < 2 * minEdge) { refused[worst] = 1; continue; }
                splitSegmentAt(blockT, blockK);
                added++;
            } else {
                bool nearVertex = where >= 0 && where < 3;
                for (int k = 0; k < 3 && !nearVertex; ++k) nearVertex = std::hypot(P[T[ct].v[k]][0] - c[0], P[T[ct].v[k]][1] - c[1]) < minEdge;
                if (!kept(ct, o.fill) || nearVertex) { refused[worst] = 1; continue; }
                const int q = addVertex(c);
                byPoint[pointKey(c)] = q;
                if (where >= 3) splitEdge(ct, where - 3, q); else splitTriangle(ct, q);
                interior++;
                added++;
            }
            work.push_back(worst);
            work.insert(work.end(), made.begin(), made.end());
        }
        touched = nullptr;
    }
};

}  // namespace detail

/**
 * The constrained Delaunay triangulation of `points` with `segments` (directed, indices into points), the triangles the
 * fill rule keeps.
 */
inline Output triangulate(const std::vector<P2>& points, const std::vector<std::array<int, 2>>& segments, const Options& opt = {}) {
    detail::Mesh m;
    m.init(points);
    Output out;
    out.inputVertex.resize(points.size());
    // inserted in a scattered order so the walk stays short
    std::vector<size_t> order(points.size());
    for (size_t i = 0; i < order.size(); ++i) order[i] = i;
    uint64_t s = 0x2545F4914F6CDD1Dull;
    for (size_t i = order.size(); i > 1; --i) { s ^= s << 13; s ^= s >> 7; s ^= s << 17; std::swap(order[i - 1], order[s % i]); }
    for (size_t i : order) out.inputVertex[i] = m.insert(points[i]);
    for (const auto& sg : segments) {
        if (sg[0] < 0 || sg[1] < 0 || static_cast<size_t>(sg[0]) >= points.size() || static_cast<size_t>(sg[1]) >= points.size()) continue;
        m.insertSegment(out.inputVertex[sg[0]], out.inputVertex[sg[1]]);
    }
    m.computeWinding();
    if (opt.refine) m.refine(opt);
    // the output's vertices: the input's first, in input order (merged duplicates share), then added points
    std::vector<int> remap(m.P.size(), -1);
    for (size_t i = 0; i < points.size(); ++i) {
        const int v = out.inputVertex[i];
        if (remap[v] < 0) { remap[v] = static_cast<int>(out.points.size()); out.points.push_back(m.P[v]); }
        out.inputVertex[i] = remap[v];
    }
    for (size_t t = 0; t < m.T.size(); ++t) {
        if (!m.T[t].alive || !m.kept(static_cast<int>(t), opt.fill)) continue;
        Tri3 tri;
        for (int k = 0; k < 3; ++k) {
            const int v = m.T[t].v[k];
            if (remap[v] < 0) { remap[v] = static_cast<int>(out.points.size()); out.points.push_back(m.P[v]); }
            tri[k] = remap[v];
        }
        out.tris.push_back(tri);
        out.winding.push_back(m.T[t].w);
    }
    out.crossingPoints = m.crossings;
    out.segmentSplits = m.splits;
    out.interiorPoints = m.interior;
    out.lostSegments = m.lost;
    return out;
}

/**
 * Triangles over a polygon's own vertices (its loops: an outer boundary and holes, any direction; even-odd), or nothing
 * when the loops cross one another or themselves (a triangulation would need points the caller does not have).
 */
inline std::optional<std::vector<Tri3>> triangulatePolygon(const std::vector<P2>& points, const std::vector<std::vector<int>>& loops) {
    std::vector<std::array<int, 2>> segs;
    for (const auto& l : loops) for (size_t i = 0; i < l.size(); ++i) segs.push_back({l[i], l[(i + 1) % l.size()]});
    const Output o = triangulate(points, segs, {});
    if (o.crossingPoints || o.lostSegments || o.points.size() != [&] { size_t n = 0; std::vector<uint8_t> seen(o.points.size(), 0); for (int v : o.inputVertex) if (!seen[v]) { seen[v] = 1; ++n; } return n; }()) return std::nullopt;
    // back to the caller's indices (merged duplicates map to the first)
    std::vector<int> back(o.points.size(), -1);
    for (size_t i = 0; i < points.size(); ++i) if (back[o.inputVertex[i]] < 0) back[o.inputVertex[i]] = static_cast<int>(i);
    std::vector<Tri3> tris;
    tris.reserve(o.tris.size());
    for (const auto& t : o.tris) tris.push_back({back[t[0]], back[t[1]], back[t[2]]});
    return tris;
}

/** The kept region's boundary as loops (counter-clockwise outer boundaries, clockwise holes), vertex indices into out.points. */
inline std::vector<std::vector<int>> boundaryLoops(const Output& out) {
    std::unordered_map<uint64_t, int> count;
    const auto key = [](int a, int b) { return (uint64_t(uint32_t(a)) << 32) | uint32_t(b); };
    for (const auto& t : out.tris) for (int k = 0; k < 3; ++k) count[key(t[k], t[(k + 1) % 3])]++;
    std::unordered_map<int, std::vector<int>> next;
    for (const auto& t : out.tris) for (int k = 0; k < 3; ++k) {
        const int a = t[k], b = t[(k + 1) % 3];
        if (!count.count(key(b, a))) next[a].push_back(b);
    }
    std::vector<std::vector<int>> loops;
    std::unordered_map<int, size_t> used;
    for (auto& [start, outs] : next) {
        while (used[start] < outs.size()) {
            std::vector<int> loop{start};
            int cur = outs[used[start]++];
            for (size_t guard = 0; guard < out.points.size() + 4 && cur != start; ++guard) {
                loop.push_back(cur);
                auto it = next.find(cur);
                if (it == next.end() || used[cur] >= it->second.size()) break;
                cur = it->second[used[cur]++];
            }
            if (loop.size() >= 3) loops.push_back(loop);
        }
    }
    return loops;
}

/** The smallest angle (degrees) of a triangle. */
inline double minAngleDeg(const P2& a, const P2& b, const P2& c) {
    const auto ang = [](const P2& p, const P2& q, const P2& r) {
        const double ux = q[0] - p[0], uy = q[1] - p[1], vx = r[0] - p[0], vy = r[1] - p[1];
        return std::atan2(std::fabs(ux * vy - uy * vx), ux * vx + uy * vy) * 180 / M_PI;
    };
    return std::min({ang(a, b, c), ang(b, c, a), ang(c, a, b)});
}

}  // namespace cdt
}  // namespace scratchbox
