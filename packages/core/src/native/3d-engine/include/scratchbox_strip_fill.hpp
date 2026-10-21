/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

#ifndef SCRATCHBOX_STRIP_FILL_HPP
#define SCRATCHBOX_STRIP_FILL_HPP

/**
 * Photo-inferred fill for the surfaces the tree strip builds where no photo exists (caps and skirts).
 *
 * A piece (a cap: ground or roof where a tree stood, seen from above; a skirt: a vertical panel continuing a hole edge
 * down, seen from the front) is laid out on a plane as a raster of texels. A texel is REAL when the real scan has a
 * surface at that place: the closest kept, not-vegetation triangle within a surface tolerance, facing the way the piece
 * faces, whose photo colour is not the colour of the crown the tree removal took. Every other texel of the piece is
 * carried from the nearest real texel: the colour at the nearest real texel's mirror image across it when that one is real
 * (the real texture's own grain continues across the boundary), else the nearest real texel itself. The carried distance
 * is kept per texel: the fill's confidence falls with it. A piece with no real texel at all is not guessed at: the caller
 * decides what it is (and labels it generated).
 *
 * Nothing here knows what a tree, a wall or a roof is: a plane, a normal, a tolerance and the kept triangles.
 */

#include "scratchbox_math.hpp"
#include "scratchbox_texture.hpp"

#include <algorithm>
#include <array>
#include <cmath>
#include <cstdint>
#include <functional>
#include <limits>
#include <vector>

namespace scratchbox {
namespace strip_fill {

using math::Vec3;

struct Rgb8 { uint8_t r{0}, g{0}, b{0}; };

/** The closest point of triangle abc to p, with its barycentric weights (w[0] at a, w[1] at b, w[2] at c). */
inline double closestPointOnTriangle(const Vec3& pf, const Vec3& af, const Vec3& bf, const Vec3& cf, double w[3]) {
    auto sub = [](const Vec3& x, const Vec3& y) { return std::array<double, 3>{double(x.x) - y.x, double(x.y) - y.y, double(x.z) - y.z}; };
    auto dot = [](const std::array<double, 3>& x, const std::array<double, 3>& y) { return x[0] * y[0] + x[1] * y[1] + x[2] * y[2]; };
    auto dist = [&](double wa, double wb, double wc) {
        w[0] = wa; w[1] = wb; w[2] = wc;
        const double qx = wa * af.x + wb * bf.x + wc * cf.x - pf.x, qy = wa * af.y + wb * bf.y + wc * cf.y - pf.y, qz = wa * af.z + wb * bf.z + wc * cf.z - pf.z;
        return std::sqrt(qx * qx + qy * qy + qz * qz);
    };
    const auto ab = sub(bf, af), ac = sub(cf, af), ap = sub(pf, af);
    const double d1 = dot(ab, ap), d2 = dot(ac, ap);
    if (d1 <= 0 && d2 <= 0) return dist(1, 0, 0);
    const auto bp = sub(pf, bf);
    const double d3 = dot(ab, bp), d4 = dot(ac, bp);
    if (d3 >= 0 && d4 <= d3) return dist(0, 1, 0);
    const double vc = d1 * d4 - d3 * d2;
    if (vc <= 0 && d1 >= 0 && d3 <= 0) { const double v = d1 / (d1 - d3); return dist(1 - v, v, 0); }
    const auto cp = sub(pf, cf);
    const double d5 = dot(ab, cp), d6 = dot(ac, cp);
    if (d6 >= 0 && d5 <= d6) return dist(0, 0, 1);
    const double vb = d5 * d2 - d1 * d6;
    if (vb <= 0 && d2 >= 0 && d6 <= 0) { const double v = d2 / (d2 - d6); return dist(1 - v, 0, v); }
    const double va = d3 * d6 - d5 * d4;
    if (va <= 0 && (d4 - d3) >= 0 && (d5 - d6) >= 0) { const double v = (d4 - d3) / ((d4 - d3) + (d5 - d6)); return dist(0, 1 - v, v); }
    const double den = 1.0 / (va + vb + vc);
    const double v = vb * den, ww = vc * den;
    return dist(1 - v - ww, v, ww);
}

/** Triangles bucketed on the xz plane (any orientation, walls included), for closest-surface queries. */
struct TriangleIndex {
    double x0{0}, z0{0}, cell{1.0};
    int nx{0}, nz{0};
    std::vector<std::vector<uint32_t>> buckets;
    const std::vector<Vec3>* p{nullptr};
    const std::vector<uint32_t>* idx{nullptr};

    void build(const std::vector<Vec3>& positions, const std::vector<uint32_t>& indices, double cellSize) {
        p = &positions;
        idx = &indices;
        cell = cellSize;
        double minX = 1e30, minZ = 1e30, maxX = -1e30, maxZ = -1e30;
        for (const auto& v : positions) { minX = std::min(minX, double(v.x)); maxX = std::max(maxX, double(v.x)); minZ = std::min(minZ, double(v.z)); maxZ = std::max(maxZ, double(v.z)); }
        if (positions.empty()) { nx = nz = 0; return; }
        x0 = minX; z0 = minZ;
        nx = std::max(1, int(std::ceil((maxX - minX) / cell)) + 1);
        nz = std::max(1, int(std::ceil((maxZ - minZ) / cell)) + 1);
        buckets.assign(size_t(nx) * size_t(nz), {});
        for (size_t t = 0; t + 2 < indices.size(); t += 3) {
            const Vec3 &a = positions[indices[t]], &b = positions[indices[t + 1]], &c = positions[indices[t + 2]];
            const int i0 = std::clamp(int(std::floor((std::min({a.x, b.x, c.x}) - x0) / cell)), 0, nx - 1);
            const int i1 = std::clamp(int(std::floor((std::max({a.x, b.x, c.x}) - x0) / cell)), 0, nx - 1);
            const int k0 = std::clamp(int(std::floor((std::min({a.z, b.z, c.z}) - z0) / cell)), 0, nz - 1);
            const int k1 = std::clamp(int(std::floor((std::max({a.z, b.z, c.z}) - z0) / cell)), 0, nz - 1);
            for (int k = k0; k <= k1; ++k) for (int i = i0; i <= i1; ++i) buckets[size_t(k) * size_t(nx) + size_t(i)].push_back(uint32_t(t / 3));
        }
    }

    struct Hit { uint32_t tri{0}; double dist{std::numeric_limits<double>::infinity()}; double w[3]{0, 0, 0}; };

    /**
     * The closest triangle to q within `tol` that `accept(tri, hit)` takes (called with the closest point's weights and
     * distance; false: not this one, keep looking).
     */
    template <class Accept>
    bool closest(const Vec3& q, double tol, Accept&& accept, Hit& out) const {
        if (nx == 0) return false;
        const int i0 = int(std::floor((q.x - tol - x0) / cell)), i1 = int(std::floor((q.x + tol - x0) / cell));
        const int k0 = int(std::floor((q.z - tol - z0) / cell)), k1 = int(std::floor((q.z + tol - z0) / cell));
        bool found = false;
        out.dist = tol;
        for (int k = std::max(0, k0); k <= std::min(nz - 1, k1); ++k) {
            for (int i = std::max(0, i0); i <= std::min(nx - 1, i1); ++i) {
                for (uint32_t t : buckets[size_t(k) * size_t(nx) + size_t(i)]) {
                    // a triangle in several cells is tested once per cell: harmless (same answer)
                    Hit h;
                    h.tri = t;
                    h.dist = closestPointOnTriangle(q, (*p)[(*idx)[3 * t]], (*p)[(*idx)[3 * t + 1]], (*p)[(*idx)[3 * t + 2]], h.w);
                    if (h.dist > out.dist || (found && h.dist >= out.dist)) continue;
                    if (!accept(t, h)) continue;
                    out = h;
                    found = true;
                }
            }
        }
        return found;
    }
};

/** One piece's raster. Texel (col, row) is addressed col + row * W. */
struct Patch {
    int W{0}, H{0};
    double texel{0.1};
    std::vector<uint8_t> target;   // 1: inside the piece (what the caller will map to)
    std::vector<uint8_t> real;     // 1: a real scan colour (rgb)
    std::vector<Rgb8> rgb;         // the real colours; after fillFromNearest, every texel's colour
    std::vector<float> carried;    // metres from the nearest real texel (0 where real; +inf where the patch has none)
    size_t texels() const { return size_t(W) * size_t(H); }
    void init(int w, int h, double texelM) {
        W = w; H = h; texel = texelM;
        target.assign(texels(), 0);
        real.assign(texels(), 0);
        rgb.assign(texels(), Rgb8{});
        carried.assign(texels(), std::numeric_limits<float>::infinity());
    }
};

struct FillCounts {
    size_t targetTexels{0};
    size_t realTexels{0};        // target texels with a real colour of their own
    size_t carriedTexels{0};     // target texels carried from a real one
    size_t unsourcedTexels{0};   // target texels of a patch with no real texel at all
    double carriedSumM{0}, carriedMaxM{0};
    double confidenceSum{0};     // sum over real and carried target texels
    bool sourced() const { return realTexels > 0 || carriedTexels > 0; }
    double meanCarriedM() const { return carriedTexels ? carriedSumM / double(carriedTexels) : 0.0; }
    double meanConfidence() const { const size_t n = realTexels + carriedTexels; return n ? confidenceSum / double(n) : 0.0; }
};

/**
 * Colours every texel of the patch that is not real from the nearest real one: the real texel's mirror image across it
 * when that is real too, else the real texel itself. Texels outside the piece are carried the same way (they are what a
 * filtered lookup at the piece's edge reads). Returns the counts over the piece's own texels. A patch with no real
 * texel is left as it is (carried = +inf) and counted unsourced.
 */
inline FillCounts fillFromNearest(Patch& pt, double confidenceScaleM) {
    FillCounts fc;
    const int W = pt.W, H = pt.H;
    const size_t N = pt.texels();
    for (size_t i = 0; i < N; ++i) fc.targetTexels += pt.target[i] ? 1 : 0;
    // nearest real texel by two-pass vector propagation (8SSEDT)
    std::vector<int32_t> src(N, -1);
    bool any = false;
    for (size_t i = 0; i < N; ++i) if (pt.real[i]) { src[i] = int32_t(i); any = true; }
    if (!any) { fc.unsourcedTexels = fc.targetTexels; return fc; }
    auto d2 = [&](int x, int y, int32_t s) { const int sx = s % W, sy = s / W; return double(x - sx) * (x - sx) + double(y - sy) * (y - sy); };
    auto relax = [&](int x, int y, int nx, int ny) {
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) return;
        const int32_t s = src[size_t(ny) * W + nx];
        if (s < 0) return;
        const size_t o = size_t(y) * W + x;
        if (src[o] < 0 || d2(x, y, s) < d2(x, y, src[o])) src[o] = s;
    };
    for (int y = 0; y < H; ++y) {
        for (int x = 0; x < W; ++x) { relax(x, y, x - 1, y); relax(x, y, x - 1, y - 1); relax(x, y, x, y - 1); relax(x, y, x + 1, y - 1); }
        for (int x = W - 1; x >= 0; --x) relax(x, y, x + 1, y);
    }
    for (int y = H - 1; y >= 0; --y) {
        for (int x = W - 1; x >= 0; --x) { relax(x, y, x + 1, y); relax(x, y, x + 1, y + 1); relax(x, y, x, y + 1); relax(x, y, x - 1, y + 1); }
        for (int x = 0; x < W; ++x) relax(x, y, x - 1, y);
    }
    const std::vector<Rgb8> realRgb = pt.rgb;
    for (int y = 0; y < H; ++y) {
        for (int x = 0; x < W; ++x) {
            const size_t o = size_t(y) * W + x;
            if (pt.real[o]) { pt.carried[o] = 0.0f; continue; }
            const int32_t s = src[o];
            if (s < 0) continue;
            const int sx = s % W, sy = s / W;
            const double d = std::sqrt(d2(x, y, s)) * pt.texel;
            const int mx = 2 * sx - x, my = 2 * sy - y;
            Rgb8 c = realRgb[size_t(s)];
            if (mx >= 0 && my >= 0 && mx < W && my < H && pt.real[size_t(my) * W + mx]) c = realRgb[size_t(my) * W + mx];
            pt.rgb[o] = c;
            pt.carried[o] = float(d);
        }
    }
    for (size_t i = 0; i < N; ++i) {
        if (!pt.target[i]) continue;
        if (pt.real[i]) {
            ++fc.realTexels;
            fc.confidenceSum += 1.0;
        } else if (std::isfinite(pt.carried[i])) {
            ++fc.carriedTexels;
            fc.carriedSumM += pt.carried[i];
            fc.carriedMaxM = std::max(fc.carriedMaxM, double(pt.carried[i]));
            fc.confidenceSum += std::exp(-double(pt.carried[i]) / std::max(1e-6, confidenceScaleM));
        }
    }
    return fc;
}

/** A rectangle packed into the atlas (x, y: its top-left texel, gutter texels not included). */
struct PackRect { int w{0}, h{0}, x{0}, y{0}; };

/**
 * Shelf-packs rectangles (each surrounded by `gutter` texels) into an atlas `atlasW` wide, tallest first; returns the
 * height used. Positions are written to the rects, in their given order.
 */
inline int shelfPack(std::vector<PackRect>& rects, int atlasW, int gutter) {
    std::vector<size_t> order(rects.size());
    for (size_t i = 0; i < order.size(); ++i) order[i] = i;
    std::sort(order.begin(), order.end(), [&](size_t a, size_t b) { return rects[a].h > rects[b].h || (rects[a].h == rects[b].h && rects[a].w > rects[b].w); });
    int x = gutter, y = gutter, shelf = 0;
    for (size_t i : order) {
        PackRect& r = rects[i];
        if (x + r.w + gutter > atlasW) { x = gutter; y += shelf + 2 * gutter; shelf = 0; }
        r.x = x; r.y = y;
        x += r.w + 2 * gutter;
        shelf = std::max(shelf, r.h);
    }
    return y + shelf + gutter;
}

} // namespace strip_fill
} // namespace scratchbox

#endif // SCRATCHBOX_STRIP_FILL_HPP
