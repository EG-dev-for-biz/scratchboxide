/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

#ifndef SCRATCHBOX_LATTICE_CUT_HPP
#define SCRATCHBOX_LATTICE_CUT_HPP

/**
 * The scan cut exactly to the rebuilt cells, natively (packages/core/src/node/3d-engine/staged-location/pipeline-k/
 * lattice-stitch.ts cutScanToLattice, which says what and why; this is its arithmetic, step for step): every scan
 * triangle reaching into a rebuilt facade's slab split along the facade's lattice lines and the slab's depth planes, the
 * pieces inside rebuilt cells dropped (or kept, cutKeepInside), and each primitive's kept pieces welded into one new
 * primitive as appendPieces welds them. A cut point is made from its edge's ends in the order of their keys, the
 * JavaScript strings of their positions (String(n) joined by commas), so neighbours share it exactly. Each piece goes
 * through the planes depth first, past those it lies clear of, which leaves the TypeScript's pieces in its order; a
 * triangle's vertices live in one arena. Triangles are cut in chunks on the pool, then gathered in their order.
 */

#include "scratchbox_js_math.hpp"
#include "scratchbox_thread_pool.hpp"

#include <algorithm>
#include <array>
#include <cmath>
#include <cstdint>
#include <cstring>
#include <limits>
#include <stdexcept>
#include <string>
#include <vector>

// V8 never fuses a multiply and an add
#pragma clang fp contract(off)

namespace scratchbox {
namespace lattice_cut {

using Vec3 = std::array<double, 3>;

/** LATTICE_STITCH_PARAMS' cut fields (lattice-stitch.ts cutParamVector). */
struct Params {
    double depthBandM, cutFacingMin, cutKeepInside, cutSameFacing;
    static constexpr size_t kCount = 4;
    static Params from(const std::vector<double>& v) {
        if (v.size() != kCount) throw std::runtime_error("the cut takes " + std::to_string(kCount) + " parameters, got " + std::to_string(v.size()));
        return {v[0], v[1], v[2], v[3]};
    }
};

/** A rebuilt facade as the cut reads it: its frame, lattice lines and rebuilt cells. */
struct Facade {
    int facadeId = 0;
    Vec3 centroid{}, normal{}, axisS{}, axisT{};
    std::vector<double> s, t;
    std::vector<uint8_t> built;
};

/** A scan primitive (readPrims): its positions and other attributes as doubles, which of those are flags or normals, its indices. */
struct Prim {
    std::vector<int> comps;            // per attribute after POSITION
    std::vector<uint8_t> flag, normal; // per attribute: named with a leading underscore; named NORMAL
    std::vector<double> pos;           // 3 a vertex
    std::vector<std::vector<double>> attr;
    std::vector<uint32_t> I;
};

/** What the cut leaves of a primitive: the triangles it cut (made degenerate by the caller) and the kept pieces welded. */
struct PrimOut {
    std::vector<uint32_t> cut;                  // each cut triangle's first index position (t)
    size_t verts = 0;
    std::vector<float> pos;                      // 3 a vertex
    std::vector<std::vector<float>> attr;        // per attribute, comps a vertex
    std::array<double, 3> mn{}, mx{};
    std::vector<uint32_t> tris;
};

struct Report { double cutTriangles = 0, removedPieces = 0, keptPieces = 0; };

namespace detail {

inline double dot(const Vec3& a, const Vec3& b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }

inline int cellIndex(double v, const std::vector<double>& edges) {
    int lo = 0, hi = static_cast<int>(edges.size()) - 1;
    while (hi - lo > 1) { const int k = (lo + hi) >> 1; if (edges[static_cast<size_t>(k)] <= v) lo = k; else hi = k; }
    return lo;
}

/**
 * One triangle's vertices: its corners and every cut point made on them, each its position, its other attributes and,
 * once asked, its key (String of each coordinate, joined by commas) and its coordinates in the current facade's frame.
 */
struct Arena {
    size_t width = 0;
    std::vector<double> P, A;
    std::vector<std::string> key;
    std::vector<Vec3> st;
    std::vector<uint32_t> stOf;  // the facade epoch st was worked out for
    uint32_t epoch = 0;
    void clear() { P.clear(); A.clear(); key.clear(); st.clear(); stOf.clear(); }
    size_t size() const { return P.size() / 3; }
    uint32_t add() { key.emplace_back(); st.push_back({}); stOf.push_back(0); P.resize(P.size() + 3); A.resize(A.size() + width); return static_cast<uint32_t>(size() - 1); }
    const std::string& k(uint32_t i) {
        std::string& s = key[i];
        if (s.empty()) s = js::toString(P[i * 3]) + "," + js::toString(P[i * 3 + 1]) + "," + js::toString(P[i * 3 + 2]);
        return s;
    }
};
using Poly = std::vector<uint32_t>;

/** cutPoint: the point on edge (u, v) where g changes sign, from the ends in key order. */
inline uint32_t cutPoint(Arena& ar, uint32_t u, uint32_t v, double gu, double gv, const Prim& pr) {
    const bool uFirst = ar.k(u) < ar.k(v);
    const uint32_t a = uFirst ? u : v, b = uFirst ? v : u;
    const double ga = uFirst ? gu : gv, gb = uFirst ? gv : gu;
    const double l = ga / (ga - gb);
    const uint32_t c = ar.add();
    for (int q = 0; q < 3; ++q) ar.P[c * 3 + static_cast<size_t>(q)] = ar.P[a * 3 + static_cast<size_t>(q)] + (ar.P[b * 3 + static_cast<size_t>(q)] - ar.P[a * 3 + static_cast<size_t>(q)]) * l;
    const size_t W = ar.width;
    double* at = &ar.A[c * W];
    const double* aa = &ar.A[a * W];
    const double* ba = &ar.A[b * W];
    size_t o = 0;
    for (size_t k = 0; k < pr.comps.size(); ++k) {
        const int n = pr.comps[k];
        for (int j = 0; j < n; ++j, ++o) at[o] = pr.flag[k] ? (l < 0.5 ? aa[o] : ba[o]) : aa[o] + (ba[o] - aa[o]) * l;
        if (pr.normal[k]) {
            double h = js::hypot({at[o - 3], at[o - 2], at[o - 1]});
            if (!(h != 0) || std::isnan(h)) h = 1;
            at[o - 3] /= h; at[o - 2] /= h; at[o - 1] /= h;
        }
    }
    return c;
}

/** split: a convex polygon's parts with g <= 0 and g >= 0 (a vertex on the plane in both); fewer than 3 vertices: none. */
template <class G>
inline void split(Arena& ar, const Poly& poly, G g, const Prim& pr, Poly& neg, Poly& pos) {
    const size_t n = poly.size();
    double gs[64];
    std::vector<double> big;
    double* G_ = gs;
    if (n > 64) { big.resize(n); G_ = big.data(); }
    for (size_t i = 0; i < n; ++i) { const double x = g(poly[i]); G_[i] = std::abs(x) < 1e-9 ? 0 : x; }
    neg.clear();
    pos.clear();
    for (size_t i = 0; i < n; ++i) {
        const uint32_t u = poly[i], v = poly[(i + 1) % n];
        const double gu = G_[i], gv = G_[(i + 1) % n];
        if (gu <= 0) neg.push_back(u);
        if (gu >= 0) pos.push_back(u);
        if ((gu < 0 && gv > 0) || (gu > 0 && gv < 0)) { const uint32_t c = cutPoint(ar, u, v, gu, gv, pr); neg.push_back(c); pos.push_back(c); }
    }
    if (neg.size() < 3) neg.clear();
    if (pos.size() < 3) pos.clear();
}

/** One triangle cut by every facade: whether it was touched, and its kept pieces (index lists into the arena). */
inline bool cutTriangle(const Prim& pr, size_t t, const std::vector<Facade>& facades, const Params& P, Arena& ar, std::vector<Poly>& polys, Report& rep) {
    const uint32_t i0 = pr.I[t], i1 = pr.I[t + 1], i2 = pr.I[t + 2];
    if (i0 == i1 || i1 == i2 || i0 == i2) return false;
    ar.clear();
    for (uint32_t src : {i0, i1, i2}) {
        const uint32_t v = ar.add();
        for (int q = 0; q < 3; ++q) ar.P[v * 3 + static_cast<size_t>(q)] = pr.pos[static_cast<size_t>(src) * 3 + static_cast<size_t>(q)];
        size_t o = 0;
        for (size_t k = 0; k < pr.attr.size(); ++k) for (int c = 0; c < pr.comps[k]; ++c) ar.A[v * ar.width + o++] = pr.attr[k][static_cast<size_t>(src) * static_cast<size_t>(pr.comps[k]) + static_cast<size_t>(c)];
    }
    polys.assign(1, Poly{0, 1, 2});
    const auto p3 = [&](uint32_t i) { return Vec3{ar.P[i * 3], ar.P[i * 3 + 1], ar.P[i * 3 + 2]}; };
    const Vec3 c0 = p3(0), c1 = p3(1), c2 = p3(2);
    const Vec3 e1{c1[0] - c0[0], c1[1] - c0[1], c1[2] - c0[2]}, e2{c2[0] - c0[0], c2[1] - c0[1], c2[2] - c0[2]};
    const Vec3 tn{e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]};
    const double tl = js::hypot({tn[0], tn[1], tn[2]});
    bool touched = false;
    std::vector<Poly> out, stack;
    Poly neg, pos;
    for (const Facade& fr : facades) {
        const double s0 = fr.s.front(), s1 = fr.s.back(), t0 = fr.t.front(), t1 = fr.t.back();
        const size_t ns = fr.s.size() - 1;
        if (!(tl > 0) || (P.cutSameFacing != 0 ? dot(tn, fr.normal) : std::abs(dot(tn, fr.normal))) < P.cutFacingMin * tl) continue;
        ar.epoch++;
        const auto st = [&](uint32_t i) -> const Vec3& {
            if (ar.stOf[i] != ar.epoch) {
                const Vec3 m{ar.P[i * 3] - fr.centroid[0], ar.P[i * 3 + 1] - fr.centroid[1], ar.P[i * 3 + 2] - fr.centroid[2]};
                ar.st[i] = {dot(m, fr.axisS), dot(m, fr.axisT), dot(m, fr.normal)};
                ar.stOf[i] = ar.epoch;
            }
            return ar.st[i];
        };
        double smin = js::kInf, smax = -js::kInf, tmin = js::kInf, tmax = -js::kInf, dmin = js::kInf, dmax = -js::kInf;
        for (const Poly& q : polys) for (uint32_t v : q) {
            const Vec3& c = st(v);
            smin = js::min(smin, c[0]); smax = js::max(smax, c[0]); tmin = js::min(tmin, c[1]); tmax = js::max(tmax, c[1]); dmin = js::min(dmin, c[2]); dmax = js::max(dmax, c[2]);
        }
        if (smax <= s0 || smin >= s1 || tmax <= t0 || tmin >= t1 || dmax <= -P.depthBandM || dmin >= P.depthBandM) continue;
        const int a0 = cellIndex(js::max(smin, s0), fr.s), a1 = cellIndex(js::min(smax, s1), fr.s), b0 = cellIndex(js::max(tmin, t0), fr.t), b1 = cellIndex(js::min(tmax, t1), fr.t);
        bool any = false;
        for (int b = b0; b <= b1 && !any; ++b) for (int a = a0; a <= a1 && !any; ++a) if (fr.built[static_cast<size_t>(b) * ns + static_cast<size_t>(a)]) any = true;
        if (!any) continue;
        touched = true;
        // the planes in order: the s lines, the t lines, the slab's two depth planes
        struct Plane { int axis; double value; };
        std::vector<Plane> planes;
        for (double sv : fr.s) if (sv > smin && sv < smax) planes.push_back({0, sv});
        for (double tv : fr.t) if (tv > tmin && tv < tmax) planes.push_back({1, tv});
        for (double dv : {-P.depthBandM, P.depthBandM}) if (dv > dmin && dv < dmax) planes.push_back({2, dv});
        // each piece through the planes depth first (the TypeScript's flatMap per plane keeps every piece's offspring together,
        // in the same order); a plane the piece lies clear of (every g past the 1e-9 snap on one side) leaves it as it is
        out.clear();
        stack.clear();
        for (auto it = polys.rbegin(); it != polys.rend(); ++it) stack.push_back(std::move(*it));
        std::vector<size_t> next;  // each stacked piece's next plane
        next.assign(stack.size(), 0);
        while (!stack.empty()) {
            Poly q = std::move(stack.back());
            size_t j = next.back();
            stack.pop_back();
            next.pop_back();
            double lo[3] = {js::kInf, js::kInf, js::kInf}, hi[3] = {-js::kInf, -js::kInf, -js::kInf};
            for (uint32_t v : q) { const Vec3& c = st(v); for (int k = 0; k < 3; ++k) { lo[k] = std::min(lo[k], c[static_cast<size_t>(k)]); hi[k] = std::max(hi[k], c[static_cast<size_t>(k)]); } }
            for (; j < planes.size(); ++j) {
                const Plane& pl = planes[j];
                if (hi[pl.axis] - pl.value < -1e-9 || lo[pl.axis] - pl.value > 1e-9) continue;
                break;
            }
            if (j == planes.size()) { out.push_back(std::move(q)); continue; }
            const Plane pl = planes[j];
            split(ar, q, [&](uint32_t v) { return st(v)[static_cast<size_t>(pl.axis)] - pl.value; }, pr, neg, pos);
            if (!pos.empty()) { stack.push_back(pos); next.push_back(j + 1); }
            if (!neg.empty()) { stack.push_back(neg); next.push_back(j + 1); }
        }
        polys.clear();
        for (Poly& q : out) {
            double cs = 0, ct = 0, cd = 0;
            for (uint32_t v : q) { const Vec3& c = st(v); cs += c[0]; ct += c[1]; cd += c[2]; }
            const double n = static_cast<double>(q.size());
            cs /= n; ct /= n; cd /= n;
            const bool inside = cs > s0 && cs < s1 && ct > t0 && ct < t1 && std::abs(cd) < P.depthBandM && fr.built[static_cast<size_t>(cellIndex(ct, fr.t)) * ns + static_cast<size_t>(cellIndex(cs, fr.s))];
            if (inside) rep.removedPieces++;
            if (!inside || P.cutKeepInside != 0) polys.push_back(std::move(q));
        }
    }
    return touched;
}

inline uint64_t bitsOf(double v) {
    if (v == 0) v = 0;
    if (std::isnan(v)) return 0x7ff8000000000000ull;
    uint64_t b;
    std::memcpy(&b, &v, 8);
    return b;
}

/** appendPieces' weld: one vertex per position and attributes, -0 read as 0 and every NaN as one (as their strings are). */
class Weld {
public:
    explicit Weld(size_t keyLen) : len_(keyLen) { table_.assign(1024, -1); }
    /** The vertex's id, and whether it is new. */
    std::pair<uint32_t, bool> id(const uint64_t* key) {
        if (keys_.size() / len_ * 2 >= table_.size()) grow();
        const size_t mask = table_.size() - 1;
        for (size_t h = hash(key) & mask;; h = (h + 1) & mask) {
            const int32_t e = table_[h];
            if (e < 0) { const uint32_t n = static_cast<uint32_t>(keys_.size() / len_); keys_.insert(keys_.end(), key, key + len_); table_[h] = static_cast<int32_t>(n); return {n, true}; }
            if (std::memcmp(&keys_[static_cast<size_t>(e) * len_], key, len_ * 8) == 0) return {static_cast<uint32_t>(e), false};
        }
    }
private:
    size_t len_;
    std::vector<uint64_t> keys_;
    std::vector<int32_t> table_;
    uint64_t hash(const uint64_t* k) const { uint64_t h = 1469598103934665603ull; for (size_t i = 0; i < len_; ++i) { h ^= k[i]; h *= 1099511628211ull; h ^= h >> 29; } return h; }
    void grow() {
        std::vector<int32_t> t(table_.size() * 2, -1);
        const size_t mask = t.size() - 1;
        for (size_t n = 0; n < keys_.size() / len_; ++n) { size_t h = hash(&keys_[n * len_]) & mask; while (t[h] >= 0) h = (h + 1) & mask; t[h] = static_cast<int32_t>(n); }
        table_.swap(t);
    }
};

/** Each chunk's cut triangles and kept pieces: per piece its vertex count, then each vertex's position and attributes. */
struct Chunk {
    std::vector<uint32_t> cut, sizes;
    std::vector<double> verts, removedArea;
    Report rep;
    double removedTriangles = 0;
    void keep(const Arena& ar, const std::vector<Poly>& polys) {
        for (const Poly& q : polys) {
            sizes.push_back(static_cast<uint32_t>(q.size()));
            for (uint32_t v : q) {
                verts.insert(verts.end(), &ar.P[v * 3], &ar.P[v * 3] + 3);
                verts.insert(verts.end(), ar.A.begin() + static_cast<long>(v * ar.width), ar.A.begin() + static_cast<long>((v + 1) * ar.width));
            }
        }
    }
};

/** A primitive's kept pieces welded as appendPieces welds them, in the chunks' order. */
inline void weldPieces(const Prim& pr, size_t width, const std::vector<Chunk>& parts, PrimOut& o) {
    o.attr.resize(pr.comps.size());
    o.mn = {js::kInf, js::kInf, js::kInf};
    o.mx = {-js::kInf, -js::kInf, -js::kInf};
    const size_t stride = 3 + width;
    Weld weld(stride);
    std::vector<uint64_t> key(stride);
    const auto idOf = [&](const double* v) {
        for (size_t q = 0; q < stride; ++q) key[q] = bitsOf(v[q]);
        const auto [id, fresh] = weld.id(key.data());
        if (fresh) {
            o.verts++;
            for (size_t q = 0; q < 3; ++q) { o.pos.push_back(static_cast<float>(v[q])); o.mn[q] = js::min(o.mn[q], v[q]); o.mx[q] = js::max(o.mx[q], v[q]); }
            size_t off = 3;
            for (size_t k = 0; k < pr.comps.size(); ++k) for (int q = 0; q < pr.comps[k]; ++q) o.attr[k].push_back(static_cast<float>(v[off++]));
        }
        return id;
    };
    for (const Chunk& ch : parts) {
        o.cut.insert(o.cut.end(), ch.cut.begin(), ch.cut.end());
        size_t at = 0;
        for (uint32_t n : ch.sizes) {
            const double* q = &ch.verts[at];
            for (uint32_t k = 1; k + 1 < n; ++k) {
                const uint32_t a = idOf(q), b = idOf(q + k * stride), c = idOf(q + (k + 1) * stride);
                o.tris.push_back(a); o.tris.push_back(b); o.tris.push_back(c);
            }
            at += static_cast<size_t>(n) * stride;
        }
    }
}

inline void loadTriangle(const Prim& pr, size_t t, Arena& ar) {
    ar.clear();
    for (size_t j = 0; j < 3; ++j) {
        const uint32_t src = pr.I[t + j], v = ar.add();
        for (int q = 0; q < 3; ++q) ar.P[v * 3 + static_cast<size_t>(q)] = pr.pos[static_cast<size_t>(src) * 3 + static_cast<size_t>(q)];
        size_t o = 0;
        for (size_t k = 0; k < pr.attr.size(); ++k) for (int c = 0; c < pr.comps[k]; ++c) ar.A[v * ar.width + o++] = pr.attr[k][static_cast<size_t>(src) * static_cast<size_t>(pr.comps[k]) + static_cast<size_t>(c)];
    }
}

}  // namespace detail

/** cutScanToLattice's geometry for every primitive (appendPieces' welded vertices), and its report. */
inline std::vector<PrimOut> cut(const std::vector<Prim>& prims, const std::vector<Facade>& facades, const Params& P, FixedThreadPool& pool, Report& report) {
    using namespace detail;
    std::vector<PrimOut> outs(prims.size());
    for (size_t pi = 0; pi < prims.size(); ++pi) {
        const Prim& pr = prims[pi];
        size_t width = 0;
        for (int c : pr.comps) width += static_cast<size_t>(c);
        const size_t nTri = pr.I.size() / 3, chunk = 256, chunks = (nTri + chunk - 1) / chunk;
        std::vector<Chunk> parts(chunks);
        pool.forEach(chunks, [&](size_t c) {
            Chunk& ch = parts[c];
            Arena ar;
            ar.width = width;
            std::vector<Poly> polys;
            for (size_t tt = c * chunk; tt < std::min(nTri, (c + 1) * chunk); ++tt) {
                const size_t t = tt * 3;
                if (!cutTriangle(pr, t, facades, P, ar, polys, ch.rep)) continue;
                ch.rep.cutTriangles++;
                ch.rep.keptPieces += static_cast<double>(polys.size());
                ch.cut.push_back(static_cast<uint32_t>(t));
                ch.keep(ar, polys);
            }
        });
        for (const Chunk& ch : parts) { report.cutTriangles += ch.rep.cutTriangles; report.removedPieces += ch.rep.removedPieces; report.keptPieces += ch.rep.keptPieces; }
        weldPieces(pr, width, parts, outs[pi]);
    }
    return outs;
}

/** A footprint outline edge's line pushed out by the margin: a point, and the outward normal in plan (x, z). */
struct ClipLine { double ax, az, nx, nz; };
using Loop = std::vector<std::array<double, 2>>;

struct ClipReport { double cutTriangles = 0, removedTriangles = 0, removedAreaM2 = 0; };

namespace detail {

/** base-cleanup.ts signedFootprintDistance: a plan point's distance to the footprint's outline, negative inside a loop. */
inline double signedFootprintDistance(double x, double z, const std::vector<Loop>& loops) {
    bool inside = false;
    double best = js::kInf;
    for (const Loop& loop : loops) {
        bool inLoop = false;
        const size_t n = loop.size();
        for (size_t i = 0, j = n - 1; i < n; j = i++) {
            const auto& a = loop[i];
            const auto& b = loop[j];
            if ((a[1] > z) != (b[1] > z) && x < ((b[0] - a[0]) * (z - a[1])) / (b[1] - a[1]) + a[0]) inLoop = !inLoop;
            const double dx = b[0] - a[0], dz = b[1] - a[1], l2 = dx * dx + dz * dz;
            const double t = l2 > 0 ? js::max(0, js::min(1, ((x - a[0]) * dx + (z - a[1]) * dz) / l2)) : 0;
            best = js::min(best, js::hypot({x - a[0] - t * dx, z - a[1] - t * dz}));
        }
        if (inLoop) inside = true;
    }
    return inside ? -best : best;
}

}  // namespace detail

/**
 * clipToFootprint's geometry for every primitive: each triangle with a corner outside the footprint (pushed out by the
 * margin) split along every outline line any of its pieces straddles (all its pieces, as the TypeScript splits them),
 * the pieces whose centre stands outside dropped and their area summed in order.
 */
inline std::vector<PrimOut> clip(const std::vector<Prim>& prims, const std::vector<Loop>& loops, const std::vector<ClipLine>& lines, double marginM, FixedThreadPool& pool, ClipReport& report) {
    using namespace detail;
    const auto outside = [&](double x, double z) { return signedFootprintDistance(x, z, loops) - marginM; };
    std::vector<PrimOut> outs(prims.size());
    std::vector<double> areas;
    for (size_t pi = 0; pi < prims.size(); ++pi) {
        const Prim& pr = prims[pi];
        size_t width = 0;
        for (int c : pr.comps) width += static_cast<size_t>(c);
        const size_t nTri = pr.I.size() / 3, chunk = 1024, chunks = (nTri + chunk - 1) / chunk;
        std::vector<Chunk> parts(chunks);
        pool.forEach(chunks, [&](size_t c) {
            Chunk& ch = parts[c];
            Arena ar;
            ar.width = width;
            std::vector<Poly> polys, next, inside;
            Poly neg, pos;
            for (size_t tt = c * chunk; tt < std::min(nTri, (c + 1) * chunk); ++tt) {
                const size_t t = tt * 3;
                const uint32_t i0 = pr.I[t], i1 = pr.I[t + 1], i2 = pr.I[t + 2];
                if (i0 == i1 || i1 == i2 || i0 == i2) continue;
                const auto px = [&](uint32_t src) { return pr.pos[static_cast<size_t>(src) * 3]; };
                const auto pz = [&](uint32_t src) { return pr.pos[static_cast<size_t>(src) * 3 + 2]; };
                if (outside(px(i0), pz(i0)) < 0 && outside(px(i1), pz(i1)) < 0 && outside(px(i2), pz(i2)) < 0) continue;
                loadTriangle(pr, t, ar);
                polys.assign(1, Poly{0, 1, 2});
                for (const ClipLine& L : lines) {
                    const auto g = [&](uint32_t v) { return (ar.P[v * 3] - L.ax) * L.nx + (ar.P[v * 3 + 2] - L.az) * L.nz - marginM; };
                    bool straddles = false;
                    for (const Poly& q : polys) {
                        double lo = js::kInf, hi = -js::kInf;
                        for (uint32_t v : q) { const double x = g(v); lo = js::min(lo, x); hi = js::max(hi, x); }
                        if (lo < -1e-9 && hi > 1e-9) { straddles = true; break; }
                    }
                    if (!straddles) continue;
                    next.clear();
                    for (const Poly& q : polys) {
                        split(ar, q, g, pr, neg, pos);
                        if (!neg.empty()) next.push_back(neg);
                        if (!pos.empty()) next.push_back(pos);
                    }
                    polys.swap(next);
                }
                const auto centreOutside = [&](const Poly& q) {
                    double x = 0, z = 0;
                    for (uint32_t v : q) x += ar.P[v * 3];
                    for (uint32_t v : q) z += ar.P[v * 3 + 2];
                    const double n = static_cast<double>(q.size());
                    return outside(x / n, z / n) > 0;
                };
                inside.clear();
                for (const Poly& q : polys) if (!centreOutside(q)) inside.push_back(q);
                if (inside.size() == 1 && polys.size() == 1) continue;
                // the original goes; what lies inside is appended
                ch.cut.push_back(static_cast<uint32_t>(t));
                for (const Poly& q : polys) if (centreOutside(q)) {
                    double s = 0;
                    for (size_t k = 1; k + 1 < q.size(); ++k) {
                        const double* p0 = &ar.P[q[0] * 3];
                        const double* p1 = &ar.P[q[k] * 3];
                        const double* p2 = &ar.P[q[k + 1] * 3];
                        const Vec3 u{p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]}, w{p2[0] - p0[0], p2[1] - p0[1], p2[2] - p0[2]};
                        s += js::hypot({u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]}) / 2;
                    }
                    ch.removedArea.push_back(s);
                }
                if (!inside.empty()) { ch.rep.cutTriangles++; ch.keep(ar, inside); }
                else ch.removedTriangles++;
            }
        });
        for (const Chunk& ch : parts) {
            report.cutTriangles += ch.rep.cutTriangles;
            report.removedTriangles += ch.removedTriangles;
            areas.insert(areas.end(), ch.removedArea.begin(), ch.removedArea.end());
        }
        weldPieces(pr, width, parts, outs[pi]);
    }
    // summed in the TypeScript's order: primitive by primitive, triangle by triangle, piece by piece
    for (double a : areas) report.removedAreaM2 += a;
    return outs;
}

}  // namespace lattice_cut
}  // namespace scratchbox

#endif  // SCRATCHBOX_LATTICE_CUT_HPP
