/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

#ifndef SCRATCHBOX_FILL_TEXTURE_HPP
#define SCRATCHBOX_FILL_TEXTURE_HPP

/**
 * Generated triangles textured as the surface they close, natively (packages/core/src/node/3d-engine/staged-location/
 * pipeline-k/lattice-stitch.ts appendTexturedTriangles, which says what and why; this is its arithmetic, step for step):
 * the photo at every textured vertex of the twin (by position to the millimetre, each material's first UV, in the order
 * they came), each material's texel density limit, each triangle's corner mapping (plain copies of its shape only), each
 * piece's route (on a rebuilt facade, the photo at its corners, continued from the nearest facade facing the same way, or
 * clay) and the triangles all of whose pieces are clay put back whole. The facades' mappings (wallMaps), the repeating
 * materials, the grouping and the GLB stay in the TypeScript; the materials a continued piece asked to repeat come back
 * in the order it asked (a nearer facade found later replaces the piece's choice, not the material already made).
 * Triangles and pieces are judged in chunks on the pool.
 */

#include "scratchbox_js_math.hpp"
#include "scratchbox_thread_pool.hpp"

#include <algorithm>
#include <array>
#include <cmath>
#include <cstdint>
#include <limits>
#include <stdexcept>
#include <unordered_map>
#include <unordered_set>
#include <vector>

// V8 never fuses a multiply and an add
#pragma clang fp contract(off)

namespace scratchbox {
namespace fill_texture {

using Vec3 = std::array<double, 3>;
using UV = std::array<double, 2>;

/** LATTICE_STITCH_PARAMS' texturing fields (lattice-stitch.ts fillTextureParamVector). */
struct Params {
    double wallFacingMin, wallBandM, wallUvMargin, maxShear, continueFacingMin, continueMaxM, confidenceRepeat, confidenceNoRepeat, confidenceFloor;
    static constexpr size_t kCount = 9;
    static Params from(const std::vector<double>& v) {
        if (v.size() != kCount) throw std::runtime_error("the fill's texturing takes " + std::to_string(kCount) + " parameters, got " + std::to_string(v.size()));
        return {v[0], v[1], v[2], v[3], v[4], v[5], v[6], v[7], v[8]};
    }
};

/** A rebuilt facade's photo mapping (wallMaps). */
struct WallMap {
    int material = 0;
    Vec3 U{}, V{}, n{};
    double u0 = 0, v0 = 0, dLo = 0, dHi = 0;
    bool hasPu = false, hasPv = false;
    double pu = 0, pv = 0;
};

/** A textured primitive of the twin: its material, positions, UVs and indices. */
struct TexPrim { int material = 0; std::vector<double> X, UVs; std::vector<uint32_t> I; };

struct Piece { int parent = 0, of = 1; std::array<Vec3, 3> p{}, w{}; };

/** A piece's route: 0 clay, 1 the facade's own photo, 2 the photo at its triangle's corners, 3 continued from a facade. */
struct Route { int kind = 0, material = -1; std::array<UV, 3> uv{}; double confidence = 0; };

struct Result {
    bool textured = false;
    std::vector<Piece> parts;
    std::vector<Route> routes;
    /** The facade materials a continued piece asked to repeat, each once, in the order first asked. */
    std::vector<int> repeatOrder;
};

namespace detail {

inline double dot(const Vec3& a, const Vec3& b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
inline Vec3 sub3(const Vec3& a, const Vec3& b) { return {a[0] - b[0], a[1] - b[1], a[2] - b[2]}; }
inline Vec3 cross3(const Vec3& a, const Vec3& b) { return {a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]}; }
inline double uvArea(const std::array<UV, 3>& t) { return std::abs((t[1][0] - t[0][0]) * (t[2][1] - t[0][1]) - (t[2][0] - t[0][0]) * (t[1][1] - t[0][1])); }

/** wk: a position to the millimetre (Math.round of each coordinate times 1000; -0 the same as 0). */
struct MmKey { int64_t x, y, z; bool operator==(const MmKey& o) const { return x == o.x && y == o.y && z == o.z; } };
struct MmHash { size_t operator()(const MmKey& k) const { uint64_t h = static_cast<uint64_t>(k.x) * 0x9E3779B97F4A7C15ull; h ^= static_cast<uint64_t>(k.y) + 0x7F4A7C15ull + (h << 6) + (h >> 2); h ^= static_cast<uint64_t>(k.z) + 0x165667B1ull + (h << 6) + (h >> 2); return static_cast<size_t>(h); } };
inline MmKey wk(const Vec3& p) { return {static_cast<int64_t>(js::round(p[0] * 1000)), static_cast<int64_t>(js::round(p[1] * 1000)), static_cast<int64_t>(js::round(p[2] * 1000))}; }

/** A position's UV per material, materials in the order they first came there. */
using UvAt = std::vector<std::pair<int, UV>>;
inline const UV* uvFor(const UvAt& at, int mat) { for (const auto& [m, uv] : at) if (m == mat) return &uv; return nullptr; }

/** uvShear: the larger over the smaller stretch of a triangle's 3D-to-UV map. */
inline double uvShear(const std::array<Vec3, 3>& p, const std::array<UV, 3>& uv) {
    const Vec3 e1 = sub3(p[1], p[0]), e2 = sub3(p[2], p[0]);
    const double l1 = js::hypot({e1[0], e1[1], e1[2]});
    if (!(l1 > 0)) return js::kInf;
    const Vec3 x{e1[0] / l1, e1[1] / l1, e1[2] / l1}, m = cross3(e1, e2);
    const double ml = js::hypot({m[0], m[1], m[2]});
    if (!(ml > 0)) return js::kInf;
    const Vec3 y = cross3({m[0] / ml, m[1] / ml, m[2] / ml}, x);
    const double a[2] = {l1, 0}, b[2] = {dot(e2, x), dot(e2, y)};
    const double du[2] = {uv[1][0] - uv[0][0], uv[2][0] - uv[0][0]}, dv[2] = {uv[1][1] - uv[0][1], uv[2][1] - uv[0][1]};
    const double det = a[0] * b[1] - b[0] * a[1];
    if (std::abs(det) < 1e-12) return js::kInf;
    const double j[4] = {(du[0] * b[1] - du[1] * a[1]) / det, (du[1] * a[0] - du[0] * b[0]) / det, (dv[0] * b[1] - dv[1] * a[1]) / det, (dv[1] * a[0] - dv[0] * b[0]) / det};
    const double s = j[0] * j[0] + j[1] * j[1] + j[2] * j[2] + j[3] * j[3], d = std::abs(j[0] * j[3] - j[1] * j[2]);
    const double r = std::sqrt(js::max(0, s * s / 4 - d * d)), hi = std::sqrt(s / 2 + r), lo = std::sqrt(js::max(0, s / 2 - r));
    return lo > 0 ? hi / lo : js::kInf;
}

/** foldIntoRepeats: a continued piece's UVs moved into the photo by whole repeat cells (whole photos without a pitch). */
inline std::array<UV, 3> foldIntoRepeats(const std::array<UV, 3>& uv, const WallMap& wm) {
    const auto shift = [](double v0, double v1, double v2, double pitch) {
        const double lo = js::min(js::min(v0, v1), v2), hi = js::max(js::max(v0, v1), v2);
        if (hi > 1) return -std::ceil((hi - 1) / pitch - 1e-9) * pitch;
        if (lo < 0) return std::ceil(-lo / pitch - 1e-9) * pitch;
        return 0.0;
    };
    const double su = shift(uv[0][0], uv[1][0], uv[2][0], wm.hasPu ? wm.pu : 1), sv = shift(uv[0][1], uv[1][1], uv[2][1], wm.hasPv ? wm.pv : 1);
    std::array<UV, 3> out;
    for (int k = 0; k < 3; ++k) out[static_cast<size_t>(k)] = {uv[static_cast<size_t>(k)][0] + su, uv[static_cast<size_t>(k)][1] + sv};
    return out;
}

inline double minOf3(double a, double b, double c) { return js::min(js::min(a, b), c); }
inline double maxOf3(double a, double b, double c) { return js::max(js::max(a, b), c); }

}  // namespace detail

/** appendTexturedTriangles' routes for `tris` (their pieces, else each whole), and the repeats they asked for. */
inline Result texture(const std::vector<WallMap>& walls, const std::vector<TexPrim>& prims, const std::vector<std::array<Vec3, 3>>& tris, const std::vector<Piece>* pieces, const Params& P, FixedThreadPool& pool) {
    using namespace detail;
    Result R;
    // the photo at every textured vertex, and each material's texel density
    std::unordered_map<MmKey, UvAt, MmHash> uvOf;
    std::vector<int> densityOrder;
    std::unordered_map<int, std::vector<double>> density;
    for (const TexPrim& pr : prims) {
        const int mat = pr.material;
        if (!density.count(mat)) { densityOrder.push_back(mat); density.emplace(mat, std::vector<double>{}); }
        auto& dens = density[mat];
        const auto X = [&](uint32_t i) { return Vec3{pr.X[i * 3], pr.X[i * 3 + 1], pr.X[i * 3 + 2]}; };
        const auto U = [&](uint32_t i) { return UV{pr.UVs[i * 2], pr.UVs[i * 2 + 1]}; };
        for (size_t t = 0; t + 2 < pr.I.size(); t += 3) {
            const uint32_t ids[3] = {pr.I[t], pr.I[t + 1], pr.I[t + 2]};
            for (uint32_t i : ids) {
                UvAt& at = uvOf[wk(X(i))];
                if (!uvFor(at, mat)) at.push_back({mat, U(i)});
            }
            if (t % 30 == 0) {
                const Vec3 a = X(ids[0]), b = X(ids[1]), c = X(ids[2]), cr = cross3(sub3(b, a), sub3(c, a));
                const double A = js::hypot({cr[0], cr[1], cr[2]});
                if (A > 1e-6) dens.push_back(uvArea({U(ids[0]), U(ids[1]), U(ids[2])}) / A);
            }
        }
    }
    if (uvOf.empty()) return R;
    R.textured = true;
    std::unordered_map<int, double> limit;
    for (int mat : densityOrder) {
        std::vector<double> l = density[mat];
        js::sort(l, [](double x, double y) { return x - y; });
        limit[mat] = (l.empty() ? 0.0 : l[l.size() / 2]) * 4;
    }
    const auto limitOf = [&](int mat) { const auto it = limit.find(mat); return it == limit.end() ? 0.0 : it->second; };
    // the photo at a whole triangle's corners, when that mapping is a plain copy of its shape
    struct Corner { bool ok = false; int material = -1; std::array<UV, 3> uv{}; };
    std::vector<Corner> cornerMap(tris.size());
    pool.forEach((tris.size() + 1023) / 1024, [&](size_t c) {
        for (size_t ti = c * 1024; ti < std::min(tris.size(), (c + 1) * 1024); ++ti) {
            const auto& f = tris[ti];
            const Vec3 cr = cross3(sub3(f[1], f[0]), sub3(f[2], f[0]));
            const double A = js::hypot({cr[0], cr[1], cr[2]});
            if (!(A > 1e-9)) continue;
            const UvAt* at[3];
            bool all = true;
            for (int k = 0; k < 3 && all; ++k) { const auto it = uvOf.find(wk(f[static_cast<size_t>(k)])); if (it == uvOf.end()) all = false; else at[k] = &it->second; }
            if (!all) continue;
            for (const auto& [mat, uv0] : *at[0]) {
                const UV* uv1 = uvFor(*at[1], mat);
                const UV* uv2 = uvFor(*at[2], mat);
                if (!uv1 || !uv2) continue;
                const std::array<UV, 3> uv{uv0, *uv1, *uv2};
                if (uvArea(uv) / A <= limitOf(mat) && uvShear(f, uv) <= P.maxShear) { cornerMap[ti] = {true, mat, uv}; break; }
            }
        }
    });
    // each piece's route; a continued piece remembers each facade material it asked to repeat, in order
    std::vector<Piece> parts;
    if (pieces) parts = *pieces;
    else {
        parts.resize(tris.size());
        for (size_t i = 0; i < tris.size(); ++i) parts[i] = {static_cast<int>(i), 1, tris[i], {Vec3{1, 0, 0}, Vec3{0, 1, 0}, Vec3{0, 0, 1}}};
    }
    std::vector<Route> routes(parts.size());
    std::vector<std::vector<int>> asked(parts.size());
    pool.forEach((parts.size() + 1023) / 1024, [&](size_t c) {
        for (size_t pi = c * 1024; pi < std::min(parts.size(), (c + 1) * 1024); ++pi) {
            const Piece& q = parts[pi];
            const auto& f = q.p;
            const Vec3 m = cross3(sub3(f[1], f[0]), sub3(f[2], f[0]));
            const double A = js::hypot({m[0], m[1], m[2]});
            if (!(A > 1e-12)) continue;
            Route& out = routes[pi];
            // infill on a rebuilt facade: the nearest wall it lies on
            double bestD = js::kInf;
            for (const WallMap& wm : walls) {
                if (std::abs(dot(m, wm.n)) < P.wallFacingMin * A) continue;
                const double d0 = dot(f[0], wm.n), d1 = dot(f[1], wm.n), d2 = dot(f[2], wm.n);
                const double off = js::max(js::max(0, wm.dLo - minOf3(d0, d1, d2)), maxOf3(d0, d1, d2) - wm.dHi);
                if (off > P.wallBandM || off >= bestD) continue;
                std::array<UV, 3> uv;
                bool inside = true;
                for (int k = 0; k < 3; ++k) {
                    const UV u{dot(wm.U, f[static_cast<size_t>(k)]) + wm.u0, dot(wm.V, f[static_cast<size_t>(k)]) + wm.v0};
                    uv[static_cast<size_t>(k)] = u;
                    if (u[0] < -P.wallUvMargin || u[0] > 1 + P.wallUvMargin || u[1] < -P.wallUvMargin || u[1] > 1 + P.wallUvMargin) inside = false;
                }
                if (!inside) continue;
                out = {1, wm.material, uv, 0};
                bestD = off;
            }
            if (out.kind == 1) continue;
            const Corner& cm = cornerMap[static_cast<size_t>(q.parent)];
            if (cm.ok) {
                std::array<UV, 3> uv;
                for (int k = 0; k < 3; ++k) {
                    const Vec3& b = q.w[static_cast<size_t>(k)];
                    for (int j = 0; j < 2; ++j) uv[static_cast<size_t>(k)][static_cast<size_t>(j)] = b[0] * cm.uv[0][static_cast<size_t>(j)] + b[1] * cm.uv[1][static_cast<size_t>(j)] + b[2] * cm.uv[2][static_cast<size_t>(j)];
                }
                out = {2, cm.material, uv, 0};
                continue;
            }
            // where no photo reached: the nearest rebuilt facade facing the same way, its mapping continued
            double best = P.continueMaxM;
            for (const WallMap& wm : walls) {
                if (std::abs(dot(m, wm.n)) < P.continueFacingMin * A) continue;
                std::array<UV, 3> uv;
                for (int k = 0; k < 3; ++k) uv[static_cast<size_t>(k)] = {dot(wm.U, f[static_cast<size_t>(k)]) + wm.u0, dot(wm.V, f[static_cast<size_t>(k)]) + wm.v0};
                const double uLen = js::hypot({wm.U[0], wm.U[1], wm.U[2]}), vLen = js::hypot({wm.V[0], wm.V[1], wm.V[2]});
                const double du = js::max(js::max(0, -minOf3(uv[0][0], uv[1][0], uv[2][0])), maxOf3(uv[0][0], uv[1][0], uv[2][0]) - 1) / (uLen != 0 && !std::isnan(uLen) ? uLen : 1);
                const double dvv = js::max(js::max(0, -minOf3(uv[0][1], uv[1][1], uv[2][1])), maxOf3(uv[0][1], uv[1][1], uv[2][1]) - 1) / (vLen != 0 && !std::isnan(vLen) ? vLen : 1);
                const double d0 = dot(f[0], wm.n), d1 = dot(f[1], wm.n), d2 = dot(f[2], wm.n);
                const double off = js::max(js::max(0, wm.dLo - minOf3(d0, d1, d2)), maxOf3(d0, d1, d2) - wm.dHi);
                const double d = js::hypot({du, dvv}) + off;
                if (d < best) {
                    best = d;
                    const double base = wm.hasPu && wm.hasPv ? P.confidenceRepeat : P.confidenceNoRepeat;
                    asked[pi].push_back(wm.material);
                    out = {3, wm.material, foldIntoRepeats(uv, wm), base * (1 - (1 - P.confidenceFloor) * (d / P.continueMaxM))};
                }
            }
        }
    });
    std::unordered_set<int> made;
    for (const auto& a : asked) for (int mat : a) if (made.insert(mat).second) R.repeatOrder.push_back(mat);
    // a triangle all of whose pieces are kept and clay goes back whole
    std::unordered_map<int, std::pair<int, int>> kept;  // parent -> pieces, clay pieces
    for (size_t i = 0; i < parts.size(); ++i) { auto& k = kept[parts[i].parent]; k.first++; if (routes[i].kind == 0) k.second++; }
    const auto whole = [&](const Piece& q) { const auto& k = kept[q.parent]; return q.of > 1 && k.first == q.of && k.second == q.of; };
    std::unordered_set<int> merged;
    for (size_t i = 0; i < parts.size(); ++i) {
        const Piece& q = parts[i];
        if (!whole(q)) { R.parts.push_back(q); R.routes.push_back(routes[i]); continue; }
        if (!merged.insert(q.parent).second) continue;
        R.parts.push_back({q.parent, 1, tris[static_cast<size_t>(q.parent)], {Vec3{1, 0, 0}, Vec3{0, 1, 0}, Vec3{0, 0, 1}}});
        R.routes.push_back(routes[i]);
    }
    return R;
}

}  // namespace fill_texture
}  // namespace scratchbox

#endif  // SCRATCHBOX_FILL_TEXTURE_HPP
