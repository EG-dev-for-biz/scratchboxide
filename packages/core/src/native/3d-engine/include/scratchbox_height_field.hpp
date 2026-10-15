/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

#ifndef SCRATCHBOX_HEIGHT_FIELD_HPP
#define SCRATCHBOX_HEIGHT_FIELD_HPP

/**
 * Height fields over the x/z plane of a tile frame (x = east, y = up, z = south, metres):
 *  - a surface model (DSM) that keeps the highest surface per cell and the triangle that made it,
 *  - the lowest surface per cell,
 *  - a terrain model (DTM): the lowest surface per coarse cell, opened morphologically so objects narrower than
 *    twice the opening radius (buildings, trees, vehicles) are removed, with empty cells filled from their neighbours.
 *
 * Empty cells hold NaN. Everything is metric and continuous; nothing here knows what a surface is.
 */

#include "scratchbox_math.hpp"
#include <algorithm>
#include <cmath>
#include <cstdint>
#include <limits>
#include <queue>
#include <vector>

namespace scratchbox {
namespace height_field {

using math::Vec3;

inline constexpr float kEmpty = std::numeric_limits<float>::quiet_NaN();

struct Grid {
    double x0{0}, z0{0}, cell{1};
    int nx{0}, nz{0};
    std::vector<float> h;

    void init(double minX, double minZ, double maxX, double maxZ, double cellSize) {
        cell = cellSize;
        x0 = minX;
        z0 = minZ;
        nx = std::max(1, static_cast<int>(std::ceil((maxX - minX) / cell)) + 1);
        nz = std::max(1, static_cast<int>(std::ceil((maxZ - minZ) / cell)) + 1);
        h.assign(static_cast<size_t>(nx) * static_cast<size_t>(nz), kEmpty);
    }
    int ix(double x) const { return static_cast<int>(std::floor((x - x0) / cell)); }
    int iz(double z) const { return static_cast<int>(std::floor((z - z0) / cell)); }
    double cx(int i) const { return x0 + (i + 0.5) * cell; }
    double cz(int k) const { return z0 + (k + 0.5) * cell; }
    bool in(int i, int k) const { return i >= 0 && k >= 0 && i < nx && k < nz; }
    size_t id(int i, int k) const { return static_cast<size_t>(k) * static_cast<size_t>(nx) + static_cast<size_t>(i); }
    float at(int i, int k) const { return h[id(i, k)]; }
    float& at(int i, int k) { return h[id(i, k)]; }
    size_t size() const { return h.size(); }

    /** Bilinear interpolation between cell centres, clamped at the border; NaN neighbours are skipped. */
    double sample(double x, double z) const {
        const double fx = (x - x0) / cell - 0.5, fz = (z - z0) / cell - 0.5;
        const int i = static_cast<int>(std::floor(fx)), k = static_cast<int>(std::floor(fz));
        const double tx = fx - i, tz = fz - k;
        double sum = 0, wsum = 0;
        const int di[4] = {0, 1, 0, 1}, dk[4] = {0, 0, 1, 1};
        const double w[4] = {(1 - tx) * (1 - tz), tx * (1 - tz), (1 - tx) * tz, tx * tz};
        for (int c = 0; c < 4; ++c) {
            const int a = std::clamp(i + di[c], 0, nx - 1), b = std::clamp(k + dk[c], 0, nz - 1);
            const float v = h[id(a, b)];
            if (std::isnan(v)) continue;
            sum += w[c] * v;
            wsum += w[c];
        }
        return wsum > 0 ? sum / wsum : std::numeric_limits<double>::quiet_NaN();
    }
};

/**
 * Rasterises triangles into a grid, calling `put(cellIndex, y, triangle)` for every cell centre a triangle covers and
 * for the cells holding its vertices (so thin and vertical triangles still register).
 */
template <typename Put>
inline void rasterizeTriangles(const Grid& g, const std::vector<Vec3>& positions, const std::vector<uint32_t>& indices, Put&& put) {
    const size_t T = indices.size() / 3;
    for (size_t t = 0; t < T; ++t) {
        const Vec3& A = positions[indices[3 * t]];
        const Vec3& B = positions[indices[3 * t + 1]];
        const Vec3& C = positions[indices[3 * t + 2]];
        for (const Vec3* p : {&A, &B, &C}) {
            const int i = g.ix(p->x), k = g.iz(p->z);
            if (g.in(i, k)) put(g.id(i, k), static_cast<float>(p->y), t);
        }
        const double d = (static_cast<double>(B.x) - A.x) * (static_cast<double>(C.z) - A.z) - (static_cast<double>(C.x) - A.x) * (static_cast<double>(B.z) - A.z);
        if (std::abs(d) < 1e-12) continue;
        const int i0 = std::max(0, g.ix(std::min({A.x, B.x, C.x}))), i1 = std::min(g.nx - 1, g.ix(std::max({A.x, B.x, C.x})));
        const int k0 = std::max(0, g.iz(std::min({A.z, B.z, C.z}))), k1 = std::min(g.nz - 1, g.iz(std::max({A.z, B.z, C.z})));
        for (int k = k0; k <= k1; ++k) {
            for (int i = i0; i <= i1; ++i) {
                const double x = g.cx(i), z = g.cz(k);
                const double w1 = ((x - A.x) * (C.z - A.z) - (C.x - A.x) * (z - A.z)) / d;
                const double w2 = ((B.x - A.x) * (z - A.z) - (x - A.x) * (B.z - A.z)) / d;
                const double w0 = 1 - w1 - w2;
                if (w0 < -1e-9 || w1 < -1e-9 || w2 < -1e-9) continue;
                put(g.id(i, k), static_cast<float>(w0 * A.y + w1 * B.y + w2 * C.y), t);
            }
        }
    }
}

/** Highest surface per cell and the triangle that made it (-1 where no triangle covers the cell). */
struct SurfaceModel {
    Grid top;
    std::vector<int32_t> topTriangle;
    Grid bottom;
};

inline SurfaceModel buildSurfaceModel(const std::vector<Vec3>& positions, const std::vector<uint32_t>& indices,
                                      double minX, double minZ, double maxX, double maxZ, double cell) {
    SurfaceModel s;
    s.top.init(minX, minZ, maxX, maxZ, cell);
    s.bottom.init(minX, minZ, maxX, maxZ, cell);
    s.topTriangle.assign(s.top.size(), -1);
    rasterizeTriangles(s.top, positions, indices, [&](size_t c, float y, size_t t) {
        float& hi = s.top.h[c];
        if (std::isnan(hi) || y > hi) {
            hi = y;
            s.topTriangle[c] = static_cast<int32_t>(t);
        }
        float& lo = s.bottom.h[c];
        if (std::isnan(lo) || y < lo) lo = y;
    });
    return s;
}

/** Minimum (erode) or maximum (dilate) over a disk of `radiusCells`; NaN cells are ignored, an all-NaN disk stays NaN. */
inline Grid diskFilter(const Grid& g, int radiusCells, bool takeMin) {
    Grid o = g;
    std::vector<std::pair<int, int>> offsets;
    for (int dk = -radiusCells; dk <= radiusCells; ++dk) {
        for (int di = -radiusCells; di <= radiusCells; ++di) {
            if (di * di + dk * dk <= radiusCells * radiusCells) offsets.emplace_back(di, dk);
        }
    }
    for (int k = 0; k < g.nz; ++k) {
        for (int i = 0; i < g.nx; ++i) {
            float best = kEmpty;
            for (const auto& [di, dk] : offsets) {
                const int a = i + di, b = k + dk;
                if (!g.in(a, b)) continue;
                const float v = g.h[g.id(a, b)];
                if (std::isnan(v)) continue;
                if (std::isnan(best) || (takeMin ? v < best : v > best)) best = v;
            }
            o.h[o.id(i, k)] = best;
        }
    }
    return o;
}

/**
 * Fills NaN cells from the nearest filled cells (breadth-first rings, averaging the filled 8-neighbours).
 *
 * With `fromX`/`fromZ` (grids of the same layout), every cell also gets where its value came from: a scanned cell its
 * own centre, a filled cell the same average of its neighbours' origins. The averaging is linear, so a filled value is
 * the scanned surface at that origin exactly when the surface is a plane; adding the plane's gradient times the offset
 * from the origin continues a slope instead of flattening it.
 */
inline void fillEmpty(Grid& g, Grid* fromX = nullptr, Grid* fromZ = nullptr) {
    const bool carry = fromX && fromZ;
    if (carry) {
        *fromX = g;
        *fromZ = g;
        for (int k = 0; k < g.nz; ++k) {
            for (int i = 0; i < g.nx; ++i) {
                const size_t c = g.id(i, k);
                if (std::isnan(g.h[c])) continue;
                fromX->h[c] = static_cast<float>(g.cx(i));
                fromZ->h[c] = static_cast<float>(g.cz(k));
            }
        }
    }
    std::vector<uint8_t> known(g.size(), 0);
    std::queue<size_t> frontier;
    for (size_t c = 0; c < g.size(); ++c) {
        if (!std::isnan(g.h[c])) known[c] = 1;
    }
    for (int k = 0; k < g.nz; ++k) {
        for (int i = 0; i < g.nx; ++i) {
            if (known[g.id(i, k)]) continue;
            bool touches = false;
            for (int dk = -1; dk <= 1 && !touches; ++dk) {
                for (int di = -1; di <= 1; ++di) {
                    if (g.in(i + di, k + dk) && known[g.id(i + di, k + dk)]) { touches = true; break; }
                }
            }
            if (touches) frontier.push(g.id(i, k));
        }
    }
    std::vector<uint8_t> queued(g.size(), 0);
    std::queue<size_t> q = frontier;
    while (!frontier.empty()) { queued[frontier.front()] = 1; frontier.pop(); }
    while (!q.empty()) {
        const size_t c = q.front();
        q.pop();
        const int i = static_cast<int>(c % static_cast<size_t>(g.nx)), k = static_cast<int>(c / static_cast<size_t>(g.nx));
        double sum = 0, sx = 0, sz = 0;
        int n = 0;
        for (int dk = -1; dk <= 1; ++dk) {
            for (int di = -1; di <= 1; ++di) {
                if (!g.in(i + di, k + dk)) continue;
                const size_t j = g.id(i + di, k + dk);
                if (!known[j]) continue;
                sum += g.h[j];
                if (carry) { sx += fromX->h[j]; sz += fromZ->h[j]; }
                ++n;
            }
        }
        if (n == 0) continue;
        g.h[c] = static_cast<float>(sum / n);
        if (carry) { fromX->h[c] = static_cast<float>(sx / n); fromZ->h[c] = static_cast<float>(sz / n); }
        known[c] = 1;
        for (int dk = -1; dk <= 1; ++dk) {
            for (int di = -1; di <= 1; ++di) {
                if (!g.in(i + di, k + dk)) continue;
                const size_t j = g.id(i + di, k + dk);
                if (!known[j] && !queued[j]) { queued[j] = 1; q.push(j); }
            }
        }
    }
}

/** 3x3 mean over filled cells, `passes` times (keeps NaN cells NaN). */
inline void smooth(Grid& g, int passes) {
    for (int p = 0; p < passes; ++p) {
        Grid o = g;
        for (int k = 0; k < g.nz; ++k) {
            for (int i = 0; i < g.nx; ++i) {
                if (std::isnan(g.at(i, k))) continue;
                double s = 0;
                int n = 0;
                for (int dk = -1; dk <= 1; ++dk) {
                    for (int di = -1; di <= 1; ++di) {
                        if (!g.in(i + di, k + dk)) continue;
                        const float v = g.at(i + di, k + dk);
                        if (!std::isnan(v)) { s += v; ++n; }
                    }
                }
                o.at(i, k) = static_cast<float>(s / n);
            }
        }
        g = std::move(o);
    }
}

/**
 * Terrain model: lowest surface per `cell`, morphological opening with a disk of `openingRadius` metres (removes
 * anything standing on the ground that is narrower than twice the radius), empty cells filled, then lightly smoothed.
 */
inline Grid buildTerrainModel(const std::vector<Vec3>& positions, const std::vector<uint32_t>& indices,
                              double minX, double minZ, double maxX, double maxZ, double cell, double openingRadius) {
    Grid low;
    low.init(minX, minZ, maxX, maxZ, cell);
    rasterizeTriangles(low, positions, indices, [&](size_t c, float y, size_t) {
        float& l = low.h[c];
        if (std::isnan(l) || y < l) l = y;
    });
    const int r = std::max(1, static_cast<int>(std::lround(openingRadius / cell)));
    Grid dtm = diskFilter(diskFilter(low, r, true), r, false);
    fillEmpty(dtm);
    smooth(dtm, 1);
    return dtm;
}

} // namespace height_field
} // namespace scratchbox

#endif // SCRATCHBOX_HEIGHT_FIELD_HPP
