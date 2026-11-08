/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * scratchbox_symmetry.hpp: the mirror and rotational symmetry a building's measured data implies, scored on continuous
 * measures only (no building type, no shape class). Three readings, each a score, the share of area it covers and its axis:
 *
 *  1. Plan symmetry. The scan's top-down height map (the highest surface over each plan cell) is split into tiers at the
 *     levels where flat roof area gathers; each tier's outline (every cell at or above its level), the whole massing (the
 *     height field itself) and the footprint polygon are each compared with their own image under every vertical mirror
 *     plane through their centroid and every rotation by 2 pi k / n about it. The score is a planar reflective symmetry
 *     measure in the sense of Podolak et al. 2006 (the PRST, restricted here to vertical planes, which is all a plan can
 *     carry): sum min(f, f') / sum max(f, f') over the plan, f the field and f' its image (an IoU for an outline, a
 *     volume IoU for the height field). A symmetry axis of a shape passes through its centroid, so the centroid is the only
 *     pivot tried. Peaks of the score over the angle are the candidate axes; like Mitra et al. 2006's transformation space,
 *     each local maximum is a hypothesis, refined and kept with its score.
 *  2. Facade mirror symmetry. A straightened facade ortho (luminance, NaN where the photo is unread: never reached,
 *     occluded or transparent) is band-passed (its mean over a few metres taken off, so a light gradient across the wall
 *     does not read as a difference) and compared with its own mirror about every vertical axis: NCC over the texels
 *     covered on both sides. A wall of identical windows is mirror-symmetric about every half pitch, so the report keeps
 *     the median over all axes beside the peak (the peak's contrast above that is what the wall's own layout adds).
 *  3. Twin facades. Each facade is carried through each plan symmetry found (a mirror or a rotation, in plan, heights
 *     unchanged); a facade standing where its image lands (same facing, plane within a tolerance, extents overlapping) is
 *     its candidate twin, and the two photos are compared point for point through the transform (a small shift search
 *     absorbs the planes' fitting error): band-passed NCC over texels both photos read, gated as texture-repeat.ts gates a
 *     repeat (NCC_GATE).
 *  4. The mirror fill (step 2). A facade's unread texels (never reached, occluded, a smear) take the colour of the read
 *     texel its mirror pairs them with: its own mirror first, then an accepted twin's. Region by region, and only where the
 *     read ring around the region agrees with its image at the gate, so a part that breaks the symmetry (a door, a sign)
 *     is left to the repeat fill. A read texel is never written: the mirror never overrides what the photo measured.
 *
 * Plan coordinates are the tile frame's (x east, z south, metres); a plan angle is measured from +x toward +z. A mirror
 * axis is the vertical plane through `point` along `dir`.
 */

#pragma once

#include "scratchbox_thread_pool.hpp"

#include <algorithm>
#include <array>
#include <cmath>
#include <cstdint>
#include <limits>
#include <numeric>
#include <string>
#include <vector>

namespace scratchbox {
namespace symmetry {

struct Params {
    /** Plan raster cell (m). */
    double cellM = 0.5;
    /** Heights at least this far above the ground count as the structure (m). */
    double minStructureM = 3.0;
    /** A cell is flat (roof) when its 4-neighbours differ from it by at most this (m). */
    double flatM = 0.6;
    /** Tier levels: histogram bin (m), peaks closer than this merged (m), a tier's least roof area (share of the structure, and m2). */
    double tierBinM = 0.5, tierMergeM = 2.5, tierMinShare = 0.015, tierMinAreaM2 = 25.0;
    /** A tier whose outline differs from the one below by less than this share of its area is the same tier. */
    double tierSameShare = 0.03;
    int maxTiers = 12;
    /** Mirror sweep step and refinement step (degrees); peaks below peakFloor are not reported; peaks within peakSepDeg merged. */
    double sweepDeg = 0.5, refineDeg = 0.05, peakFloor = 0.6, peakSepDeg = 4.0;
    int maxPeaks = 4;
    /** Rotation orders tried: 2..maxFold. */
    int maxFold = 8;
    /** A plan symmetry is detected at or above this score (and is carried into the twin search). */
    double planGate = 0.9;
    /** Facades: the working texel (m), the band-pass radius (m), the coarse sweep's texel (m), the least share of the read texels paired. */
    double facadeCellM = 0.2, highPassM = 2.0, facadeCoarseM = 0.4, minPairShare = 0.3;
    /**
     * A facade mirror is detected at or above nccGate over at least facadeShare of its read texels, its peak at least
     * minContrast above the median over every axis (a wall that repeats uniformly matches its mirror about every half
     * pitch: that is its repetition, which texture-repeat.ts already reads, not a mirror).
     */
    double facadeShare = 0.5, minContrast = 0.2;
    /** Twins: normals within this cos, planes within maxOffsetM, extents overlapping by overlapShare; shifts searched +-shiftM in steps. */
    double twinNormalCos = 0.97, twinMaxOffsetM = 2.0, twinOverlapShare = 0.5, twinShiftM = 1.0, twinShiftStepM = 0.2;
    /** The NCC gate (texture-repeat.ts NCC_GATE). */
    double nccGate = 0.55;
    /** Texels a twin comparison samples at most. */
    int twinSamples = 20000;
};

struct Vec2d { double x = 0, z = 0; };

/** A plan raster: origin at the lower corner of cell (0, 0); cell (i, j) centred at origin + ((i + .5) c, (j + .5) c). */
struct PlanGrid {
    int W = 0, H = 0;
    double cell = 0.5, x0 = 0, z0 = 0;
    std::vector<float> v;
    float at(int i, int j) const { return v[static_cast<size_t>(j) * W + i]; }
    Vec2d centre(int i, int j) const { return {x0 + (i + 0.5) * cell, z0 + (j + 0.5) * cell}; }
    /** Bilinear sample at a plan point, 0 outside. */
    double sample(double x, double z) const {
        const double fx = (x - x0) / cell - 0.5, fz = (z - z0) / cell - 0.5;
        const int i = static_cast<int>(std::floor(fx)), j = static_cast<int>(std::floor(fz));
        const double ax = fx - i, az = fz - j;
        auto g = [&](int a, int b) -> double { return a < 0 || b < 0 || a >= W || b >= H ? 0.0 : static_cast<double>(at(a, b)); };
        return (g(i, j) * (1 - ax) + g(i + 1, j) * ax) * (1 - az) + (g(i, j + 1) * (1 - ax) + g(i + 1, j + 1) * ax) * az;
    }
};

struct Mirror {
    double angleDeg = 0;   // the axis direction's plan angle, [0, 180)
    Vec2d point, dir;
    double score = 0;      // sum min / sum max of the field and its mirror image
    double share = 0;      // the share of the field's mass matched by its image
};

struct Rotation {
    int order = 1;                      // the largest n whose every rotation 2 pi k / n scores at least planGate (1: none)
    std::vector<double> scores;         // scores[n - 2] = min over k of the score of rotation 2 pi k / n, n = 2..maxFold
    double score = 0;                   // scores at `order` (0 when order is 1)
};

struct FieldSymmetry {
    double massM = 0;                   // area (m2) for an outline, volume (m3) for a height field
    Vec2d centroid;
    std::vector<Mirror> mirrors;        // the peaks over the angle, best first
    Mirror best;                        // the best angle, whether or not it is a peak above the floor
    Rotation rotation;
};

struct Tier {
    double levelM = 0;                  // above the ground
    double roofAreaM2 = 0;              // flat area gathered at this level
    FieldSymmetry outline;
};

struct PlanReport {
    PlanGrid heights;                   // height above the ground, 0 off the structure
    FieldSymmetry massing;
    std::vector<Tier> tiers;
    bool hasFootprint = false;
    FieldSymmetry footprint;
};

// ---------------------------------------------------------------------------------------------------------------------
// the plan raster

/** The highest surface over each plan cell: every triangle not edge-on to the sky rasterised at cell centres. */
inline PlanGrid heightMap(const std::vector<float>& pos, const std::vector<uint32_t>& idx, double groundY, double cell) {
    PlanGrid g;
    g.cell = cell;
    double xmin = 1e300, xmax = -1e300, zmin = 1e300, zmax = -1e300;
    for (size_t k = 0; k + 2 < pos.size(); k += 3) {
        xmin = std::min(xmin, static_cast<double>(pos[k])); xmax = std::max(xmax, static_cast<double>(pos[k]));
        zmin = std::min(zmin, static_cast<double>(pos[k + 2])); zmax = std::max(zmax, static_cast<double>(pos[k + 2]));
    }
    if (xmin > xmax) return g;
    g.x0 = std::floor(xmin / cell) * cell - 2 * cell;
    g.z0 = std::floor(zmin / cell) * cell - 2 * cell;
    g.W = static_cast<int>(std::ceil((xmax - g.x0) / cell)) + 2;
    g.H = static_cast<int>(std::ceil((zmax - g.z0) / cell)) + 2;
    g.v.assign(static_cast<size_t>(g.W) * g.H, 0.f);
    for (size_t t = 0; t + 2 < idx.size(); t += 3) {
        const float* a = &pos[3 * idx[t]];
        const float* b = &pos[3 * idx[t + 1]];
        const float* c = &pos[3 * idx[t + 2]];
        const double ax = a[0], az = a[2], bx = b[0], bz = b[2], cx = c[0], cz = c[2];
        const double den = (bz - cz) * (ax - cx) + (cx - bx) * (az - cz);
        if (std::fabs(den) < 1e-9) continue;
        const int i0 = std::max(0, static_cast<int>(std::floor((std::min({ax, bx, cx}) - g.x0) / cell - 0.5)));
        const int i1 = std::min(g.W - 1, static_cast<int>(std::ceil((std::max({ax, bx, cx}) - g.x0) / cell - 0.5)));
        const int j0 = std::max(0, static_cast<int>(std::floor((std::min({az, bz, cz}) - g.z0) / cell - 0.5)));
        const int j1 = std::min(g.H - 1, static_cast<int>(std::ceil((std::max({az, bz, cz}) - g.z0) / cell - 0.5)));
        for (int j = j0; j <= j1; j++) for (int i = i0; i <= i1; i++) {
            const Vec2d p = g.centre(i, j);
            const double l1 = ((bz - cz) * (p.x - cx) + (cx - bx) * (p.z - cz)) / den;
            const double l2 = ((cz - az) * (p.x - cx) + (ax - cx) * (p.z - cz)) / den;
            const double l3 = 1 - l1 - l2;
            if (l1 < -1e-9 || l2 < -1e-9 || l3 < -1e-9) continue;
            const double y = l1 * a[1] + l2 * b[1] + l3 * c[1] - groundY;
            float& h = g.v[static_cast<size_t>(j) * g.W + i];
            if (y > h) h = static_cast<float>(y);
        }
    }
    return g;
}

/** 1 inside any loop (even-odd over all loops), at cell centres. */
inline std::vector<uint8_t> polygonMask(const PlanGrid& g, const std::vector<std::vector<Vec2d>>& loops) {
    std::vector<uint8_t> m(static_cast<size_t>(g.W) * g.H, 0);
    for (int j = 0; j < g.H; j++) {
        const double z = g.z0 + (j + 0.5) * g.cell;
        std::vector<double> xs;
        for (const auto& L : loops) for (size_t k = 0; k < L.size(); k++) {
            const Vec2d a = L[k], b = L[(k + 1) % L.size()];
            if ((a.z <= z) != (b.z <= z)) xs.push_back(a.x + (z - a.z) / (b.z - a.z) * (b.x - a.x));
        }
        std::sort(xs.begin(), xs.end());
        for (size_t k = 0; k + 1 < xs.size(); k += 2) {
            const int i0 = std::max(0, static_cast<int>(std::ceil((xs[k] - g.x0) / g.cell - 0.5)));
            const int i1 = std::min(g.W - 1, static_cast<int>(std::floor((xs[k + 1] - g.x0) / g.cell - 0.5)));
            for (int i = i0; i <= i1; i++) m[static_cast<size_t>(j) * g.W + i] = 1;
        }
    }
    return m;
}

/** A mask grown by r cells (square neighbourhood). */
inline std::vector<uint8_t> dilate(const std::vector<uint8_t>& m, int W, int H, int r) {
    std::vector<uint8_t> o(m.size(), 0);
    for (int j = 0; j < H; j++) for (int i = 0; i < W; i++) {
        if (!m[static_cast<size_t>(j) * W + i]) continue;
        for (int b = std::max(0, j - r); b <= std::min(H - 1, j + r); b++) for (int a = std::max(0, i - r); a <= std::min(W - 1, i + r); a++) o[static_cast<size_t>(b) * W + a] = 1;
    }
    return o;
}

// ---------------------------------------------------------------------------------------------------------------------
// the plan symmetry score

namespace detail {

/** The cells carrying mass, their bounding box grown by the field's reach (so the image of every cell is inside). */
struct Support { std::vector<int> cells; int i0 = 0, i1 = -1, j0 = 0, j1 = -1; };

inline Support supportOf(const PlanGrid& f, Vec2d c) {
    Support s;
    double reach = 0;
    for (int j = 0; j < f.H; j++) for (int i = 0; i < f.W; i++) if (f.at(i, j) > 0) {
        s.cells.push_back(j * f.W + i);
        const Vec2d p = f.centre(i, j);
        reach = std::max(reach, std::hypot(p.x - c.x, p.z - c.z));
    }
    const double r = reach + 2 * f.cell;
    s.i0 = std::max(0, static_cast<int>(std::floor((c.x - r - f.x0) / f.cell)));
    s.i1 = std::min(f.W - 1, static_cast<int>(std::ceil((c.x + r - f.x0) / f.cell)));
    s.j0 = std::max(0, static_cast<int>(std::floor((c.z - r - f.z0) / f.cell)));
    s.j1 = std::min(f.H - 1, static_cast<int>(std::ceil((c.z + r - f.z0) / f.cell)));
    return s;
}

/**
 * sum min(f, f o T) / sum max(f, f o T) over the window, T a plan isometry fixing c given by its linear part
 * [[a, b], [cc, d]] (an involution for a mirror, so f o T is the mirror image), and the share of f's mass matched.
 */
inline std::pair<double, double> transformScore(const PlanGrid& f, const Support& s, Vec2d c, double a, double b, double cc, double d) {
    double mn = 0, mx = 0, mass = 0;
    for (int j = s.j0; j <= s.j1; j++) for (int i = s.i0; i <= s.i1; i++) {
        const double v = f.at(i, j);
        const Vec2d p = f.centre(i, j);
        const double qx = p.x - c.x, qz = p.z - c.z;
        const double w = f.sample(c.x + a * qx + b * qz, c.z + cc * qx + d * qz);
        if (v <= 0 && w <= 0) continue;
        mn += std::min(v, w);
        mx += std::max(v, w);
        mass += v;
    }
    return {mx > 0 ? mn / mx : 0.0, mass > 0 ? mn / mass : 0.0};
}

inline std::pair<double, double> mirrorScore(const PlanGrid& f, const Support& s, Vec2d c, double deg) {
    const double t = 2 * deg * M_PI / 180;
    // reflection across the line at angle deg: [[cos 2t, sin 2t], [sin 2t, -cos 2t]]
    return transformScore(f, s, c, std::cos(t), std::sin(t), std::sin(t), -std::cos(t));
}

inline std::pair<double, double> rotationScore(const PlanGrid& f, const Support& s, Vec2d c, double rad) {
    return transformScore(f, s, c, std::cos(rad), -std::sin(rad), std::sin(rad), std::cos(rad));
}

} // namespace detail

/** The mirror axes and rotation order of a plan field (an outline as 0 / 1, or heights), about its centroid. */
inline FieldSymmetry fieldSymmetry(const PlanGrid& f, const Params& P, FixedThreadPool* pool = nullptr) {
    FieldSymmetry out;
    double m = 0, sx = 0, sz = 0;
    for (int j = 0; j < f.H; j++) for (int i = 0; i < f.W; i++) {
        const double v = f.at(i, j);
        if (v <= 0) continue;
        const Vec2d p = f.centre(i, j);
        m += v; sx += v * p.x; sz += v * p.z;
    }
    if (m <= 0) return out;
    out.massM = m * f.cell * f.cell;
    out.centroid = {sx / m, sz / m};
    const Vec2d c = out.centroid;
    const detail::Support sup = detail::supportOf(f, c);
    const int n = static_cast<int>(std::round(180.0 / P.sweepDeg));
    std::vector<std::pair<double, double>> sweep(static_cast<size_t>(n));
    auto one = [&](size_t k) { sweep[k] = detail::mirrorScore(f, sup, c, static_cast<double>(k) * P.sweepDeg); };
    if (pool) pool->forEach(sweep.size(), one); else for (size_t k = 0; k < sweep.size(); k++) one(k);
    auto refine = [&](double deg) {
        double bestDeg = deg, best = detail::mirrorScore(f, sup, c, deg).first;
        for (double step = P.sweepDeg / 2; step >= P.refineDeg * 0.999; step /= 2) {
            for (double cand : {bestDeg - step, bestDeg + step}) {
                const double s = detail::mirrorScore(f, sup, c, cand).first;
                if (s > best) { best = s; bestDeg = cand; }
            }
        }
        bestDeg = std::fmod(std::fmod(bestDeg, 180.0) + 180.0, 180.0);
        const auto [score, share] = detail::mirrorScore(f, sup, c, bestDeg);
        Mirror mr;
        mr.angleDeg = bestDeg; mr.point = c; mr.dir = {std::cos(bestDeg * M_PI / 180), std::sin(bestDeg * M_PI / 180)};
        mr.score = score; mr.share = share;
        return mr;
    };
    // peaks over the angle (circular), refined, merged
    size_t argmax = 0;
    for (size_t k = 0; k < sweep.size(); k++) if (sweep[k].first > sweep[argmax].first) argmax = k;
    out.best = refine(static_cast<double>(argmax) * P.sweepDeg);
    std::vector<Mirror> peaks;
    for (int k = 0; k < n; k++) {
        const double v = sweep[static_cast<size_t>(k)].first;
        if (v < P.peakFloor) continue;
        if (v < sweep[static_cast<size_t>((k + n - 1) % n)].first || v < sweep[static_cast<size_t>((k + 1) % n)].first) continue;
        peaks.push_back(refine(static_cast<double>(k) * P.sweepDeg));
    }
    std::sort(peaks.begin(), peaks.end(), [](const Mirror& a, const Mirror& b) { return a.score > b.score || (a.score == b.score && a.angleDeg < b.angleDeg); });
    for (const Mirror& p : peaks) {
        bool near = false;
        for (const Mirror& q : out.mirrors) { const double d = std::fabs(p.angleDeg - q.angleDeg); if (std::min(d, 180 - d) < P.peakSepDeg) near = true; }
        if (!near && static_cast<int>(out.mirrors.size()) < P.maxPeaks) out.mirrors.push_back(p);
    }
    // rotations: each order scored by its worst rotation
    for (int order = 2; order <= P.maxFold; order++) {
        double worst = 1;
        for (int k = 1; k < order; k++) worst = std::min(worst, detail::rotationScore(f, sup, c, 2 * M_PI * k / order).first);
        out.rotation.scores.push_back(worst);
        if (worst >= P.planGate) { out.rotation.order = order; out.rotation.score = worst; }
    }
    return out;
}

/**
 * The tier levels: where flat roof area gathers over the height map (a histogram of the flat cells' heights, its peaks
 * merged within tierMergeM), each holding at least tierMinShare of the structure's area. The ground storey (minStructureM)
 * is always the first.
 */
inline std::vector<std::pair<double, double>> tierLevels(const PlanGrid& h, const Params& P) {
    double total = 0, top = 0;
    std::vector<double> flat;
    for (int j = 0; j < h.H; j++) for (int i = 0; i < h.W; i++) {
        const double v = h.at(i, j);
        if (v < P.minStructureM) continue;
        total += 1; top = std::max(top, v);
        bool isFlat = true;
        for (auto [di, dj] : std::array<std::pair<int, int>, 4>{{{1, 0}, {-1, 0}, {0, 1}, {0, -1}}}) {
            const int a = i + di, b = j + dj;
            if (a < 0 || b < 0 || a >= h.W || b >= h.H || std::fabs(h.at(a, b) - v) > P.flatM) { isFlat = false; break; }
        }
        if (isFlat) flat.push_back(v);
    }
    std::vector<std::pair<double, double>> levels{{P.minStructureM, 0.0}};
    if (total <= 0) return levels;
    const int bins = static_cast<int>(std::ceil(top / P.tierBinM)) + 1;
    std::vector<double> hist(static_cast<size_t>(bins), 0.0);
    for (double v : flat) hist[static_cast<size_t>(std::min(bins - 1, static_cast<int>(v / P.tierBinM)))] += 1;
    const double cellA = h.cell * h.cell, minCells = std::max(P.tierMinShare * total, P.tierMinAreaM2 / cellA);
    // a peak: the mass within tierMergeM / 2 of a local maximum bin
    const int halfWin = std::max(1, static_cast<int>(std::round(P.tierMergeM / 2 / P.tierBinM)));
    std::vector<std::pair<double, double>> cands;
    for (int b = 0; b < bins; b++) {
        bool isMax = hist[static_cast<size_t>(b)] > 0;
        for (int d = -halfWin; d <= halfWin && isMax; d++) {
            const int q = b + d;
            if (d == 0 || q < 0 || q >= bins) continue;
            if (hist[static_cast<size_t>(q)] > hist[static_cast<size_t>(b)] || (hist[static_cast<size_t>(q)] == hist[static_cast<size_t>(b)] && q < b)) isMax = false;
        }
        if (!isMax) continue;
        double mass = 0;
        for (int d = -halfWin; d <= halfWin; d++) { const int q = b + d; if (q >= 0 && q < bins) mass += hist[static_cast<size_t>(q)]; }
        if (mass >= minCells) cands.push_back({b * P.tierBinM, mass * cellA});
    }
    for (const auto& c : cands) if (c.first - P.tierMergeM > P.minStructureM) levels.push_back({c.first - P.tierMergeM / 2, c.second});
    std::sort(levels.begin(), levels.end());
    return levels;
}

inline PlanGrid outlineAt(const PlanGrid& h, double level) {
    PlanGrid o = h;
    for (float& v : o.v) v = v >= level ? 1.f : 0.f;
    return o;
}

/**
 * The plan's symmetry: the massing (the height field), each tier's outline, and the footprint polygon when one is given.
 * `pos` / `idx` are the scan's triangles in the tile frame (y up), heights measured from groundY. Cells off the footprint
 * (grown by two cells) are dropped when a footprint is given, so a neighbour the isolate kept does not weigh in.
 */
inline PlanReport planSymmetry(const std::vector<float>& pos, const std::vector<uint32_t>& idx, double groundY, const std::vector<std::vector<Vec2d>>& footprint, const Params& P, FixedThreadPool* pool = nullptr) {
    PlanReport r;
    r.heights = heightMap(pos, idx, groundY, P.cellM);
    PlanGrid& h = r.heights;
    if (!h.W) return r;
    std::vector<uint8_t> foot;
    if (!footprint.empty()) {
        foot = polygonMask(h, footprint);
        r.hasFootprint = std::any_of(foot.begin(), foot.end(), [](uint8_t v) { return v != 0; });
    }
    if (r.hasFootprint) {
        const std::vector<uint8_t> grown = dilate(foot, h.W, h.H, 2);
        for (size_t k = 0; k < h.v.size(); k++) if (!grown[k]) h.v[k] = 0;
        PlanGrid fp = h;
        for (size_t k = 0; k < fp.v.size(); k++) fp.v[k] = foot[k] ? 1.f : 0.f;
        r.footprint = fieldSymmetry(fp, P, pool);
    }
    for (float& v : h.v) if (v < P.minStructureM) v = 0;
    r.massing = fieldSymmetry(h, P, pool);
    double prevArea = -1;
    for (const auto& [level, roof] : tierLevels(h, P)) {
        if (static_cast<int>(r.tiers.size()) >= P.maxTiers) break;
        const PlanGrid o = outlineAt(h, level);
        double area = 0;
        for (float v : o.v) area += v;
        area *= h.cell * h.cell;
        if (area < P.tierMinAreaM2) continue;
        if (prevArea > 0 && prevArea - area < P.tierSameShare * area) continue;
        prevArea = area;
        Tier t;
        t.levelM = level;
        t.roofAreaM2 = roof;
        t.outline = fieldSymmetry(o, P, pool);
        r.tiers.push_back(std::move(t));
    }
    return r;
}

// ---------------------------------------------------------------------------------------------------------------------
// facades

/** A facade's frame (ReliefFacade) and its photo resampled to a working grid: luminance, NaN where unread; the outline (the facade's own triangles). */
struct FacadeImage {
    int id = 0;
    double centroid[3]{}, normal[3]{}, axisS[3]{}, axisT[3]{};
    double orthoSMin = 0, orthoTMax = 0, pixel = 0.2;
    int W = 0, H = 0;
    std::vector<float> L;           // NaN: not read
    std::vector<uint8_t> outline;   // 1: the facade's triangles reached this texel
    /** Plan of a working texel's centre: s along, t up. */
    double s(double x) const { return orthoSMin + (x + 0.5) * pixel; }
    double t(double y) const { return orthoTMax - (y + 0.5) * pixel; }
};

/** Box-average a W x H luminance image (NaN unread) and outline onto a grid of `cellM` texels; a working texel is read when half its source texels are. */
inline FacadeImage resampleFacade(FacadeImage src, double cellM) {
    const int f = std::max(1, static_cast<int>(std::round(cellM / src.pixel)));
    if (f == 1) return src;
    FacadeImage o = src;
    o.pixel = src.pixel * f;
    o.W = (src.W + f - 1) / f; o.H = (src.H + f - 1) / f;
    o.L.assign(static_cast<size_t>(o.W) * o.H, std::numeric_limits<float>::quiet_NaN());
    o.outline.assign(o.L.size(), 0);
    for (int y = 0; y < o.H; y++) for (int x = 0; x < o.W; x++) {
        double sum = 0; int n = 0, all = 0, out = 0;
        for (int b = y * f; b < std::min(src.H, (y + 1) * f); b++) for (int a = x * f; a < std::min(src.W, (x + 1) * f); a++) {
            const size_t k = static_cast<size_t>(b) * src.W + a;
            all++;
            if (src.outline[k]) out++;
            if (!std::isnan(src.L[k])) { sum += src.L[k]; n++; }
        }
        const size_t k = static_cast<size_t>(y) * o.W + x;
        if (n * 2 >= all && n) o.L[k] = static_cast<float>(sum / n);
        o.outline[k] = out * 2 >= all ? 1 : 0;
    }
    return o;
}

/** The luminance less its mean over a (2r + 1)^2 box of read texels (summed-area tables); NaN stays NaN. */
inline std::vector<float> bandPass(const std::vector<float>& L, int W, int H, int r) {
    std::vector<double> S(static_cast<size_t>(W + 1) * (H + 1), 0.0), N(S.size(), 0.0);
    for (int y = 0; y < H; y++) for (int x = 0; x < W; x++) {
        const float v = L[static_cast<size_t>(y) * W + x];
        const size_t k = static_cast<size_t>(y + 1) * (W + 1) + (x + 1);
        S[k] = S[k - 1] + S[k - (W + 1)] - S[k - (W + 1) - 1] + (std::isnan(v) ? 0.0 : v);
        N[k] = N[k - 1] + N[k - (W + 1)] - N[k - (W + 1) - 1] + (std::isnan(v) ? 0.0 : 1.0);
    }
    std::vector<float> o(L.size(), std::numeric_limits<float>::quiet_NaN());
    for (int y = 0; y < H; y++) for (int x = 0; x < W; x++) {
        const float v = L[static_cast<size_t>(y) * W + x];
        if (std::isnan(v)) continue;
        const int x0 = std::max(0, x - r), x1 = std::min(W, x + r + 1), y0 = std::max(0, y - r), y1 = std::min(H, y + r + 1);
        auto box = [&](const std::vector<double>& T) { return T[static_cast<size_t>(y1) * (W + 1) + x1] - T[static_cast<size_t>(y0) * (W + 1) + x1] - T[static_cast<size_t>(y1) * (W + 1) + x0] + T[static_cast<size_t>(y0) * (W + 1) + x0]; };
        const double n = box(N);
        o[static_cast<size_t>(y) * W + x] = static_cast<float>(v - box(S) / n);
    }
    return o;
}

struct NccAcc {
    double n = 0, sa = 0, sb = 0, saa = 0, sbb = 0, sab = 0;
    void add(double a, double b) { n++; sa += a; sb += b; saa += a * a; sbb += b * b; sab += a * b; }
    double ncc() const {
        if (n < 8) return 0;
        const double va = saa - sa * sa / n, vb = sbb - sb * sb / n;
        return va > 1e-9 && vb > 1e-9 ? (sab - sa * sb / n) / std::sqrt(va * vb) : 0;
    }
};

struct FacadeMirror {
    int facadeId = 0;
    bool read = false;              // enough texels read to say anything
    double axisS = 0;               // the axis, metres along the facade's s
    double axisPoint[3]{};          // a point on the axis (at the facade's centroid height)
    double ncc = 0, share = 0;      // at the best axis
    double medianNcc = 0, contrast = 0;
    double outlineIoU = 0;          // the facade's outline against its own mirror at the axis
    bool periodic = false;          // the median over every axis clears the gate: the wall repeats uniformly
    double centreOffsetM = 0;       // the axis from the middle of the facade's outline (m)
    bool detected = false;
    std::vector<std::pair<double, double>> profile;  // (axisS, ncc) over the coarse sweep, for the sheet
};

namespace detail {

/** NCC of a band-passed image against its mirror about x = c (texel units, half steps), over pairs read on both sides; the paired share; the outline IoU. */
inline void mirrorAt(const std::vector<float>& B, const std::vector<uint8_t>& outline, int W, int H, double c, double& ncc, double& share, double& iou, size_t readCount) {
    NccAcc acc;
    double inter = 0, uni = 0;
    for (int y = 0; y < H; y++) {
        const size_t row = static_cast<size_t>(y) * W;
        for (int x = 0; x < W; x++) {
            const double xm = 2 * c - x;   // the mirror texel (an integer or a half: two texels averaged)
            const int a = static_cast<int>(std::floor(xm)), b = static_cast<int>(std::ceil(xm));
            const bool inside = a >= 0 && b < W;
            const bool o1 = outline[row + x] != 0, o2 = inside && (outline[row + a] || outline[row + b]);
            if (o1 || o2) { uni += 1; if (o1 && o2) inter += 1; }
            if (x >= c || !inside) continue;
            const float v = B[row + x], w1 = B[row + a], w2 = B[row + b];
            if (std::isnan(v) || std::isnan(w1) || std::isnan(w2)) continue;
            acc.add(v, 0.5 * (w1 + w2));
        }
    }
    ncc = acc.ncc();
    share = readCount ? 2 * acc.n / static_cast<double>(readCount) : 0;
    iou = uni > 0 ? inter / uni : 0;
}

} // namespace detail

/**
 * A facade's mirror symmetry about vertical axes: a coarse sweep over every axis, the three best peaks (by NCC x paired
 * share) refined on the working grid.
 */
inline FacadeMirror facadeMirror(const FacadeImage& fine, const Params& P) {
    FacadeMirror out;
    out.facadeId = fine.id;
    const FacadeImage coarse = resampleFacade(fine, P.facadeCoarseM);
    auto prepare = [&](const FacadeImage& g, std::vector<float>& B, size_t& read) {
        B = bandPass(g.L, g.W, g.H, std::max(1, static_cast<int>(std::round(P.highPassM / g.pixel))));
        read = 0;
        for (float v : B) if (!std::isnan(v)) read++;
    };
    std::vector<float> Bc, Bf;
    size_t readC = 0, readF = 0;
    prepare(coarse, Bc, readC);
    if (readC < 64) return out;
    out.read = true;
    // the outline's middle (its covered columns' mean extent)
    int xa = fine.W, xb = -1;
    for (int y = 0; y < fine.H; y++) for (int x = 0; x < fine.W; x++) if (fine.outline[static_cast<size_t>(y) * fine.W + x]) { xa = std::min(xa, x); xb = std::max(xb, x); }
    const double middleS = xb >= xa ? fine.orthoSMin + 0.5 * (xa + xb + 1) * fine.pixel : fine.orthoSMin + 0.5 * fine.W * fine.pixel;
    // the axis is chosen by its matched evidence, NCC x the paired share: a few texels paired near an edge can correlate
    // highly by chance, so the NCC alone would pick an axis that explains little of the wall
    std::vector<std::pair<double, double>> sweep;   // (c in coarse texels, ncc x share)
    std::vector<double> valid;
    for (int k = 1; k < 2 * coarse.W - 1; k++) {
        const double c = 0.5 * k - 0.5;
        double ncc, share, iou;
        detail::mirrorAt(Bc, coarse.outline, coarse.W, coarse.H, c, ncc, share, iou, readC);
        if (share < P.minPairShare) continue;
        sweep.push_back({c, ncc * std::min(1.0, share)});
        valid.push_back(ncc);
        out.profile.push_back({coarse.orthoSMin + (c + 0.5) * coarse.pixel, ncc});
    }
    if (sweep.empty()) return out;
    std::vector<double> sorted = valid;
    std::nth_element(sorted.begin(), sorted.begin() + sorted.size() / 2, sorted.end());
    out.medianNcc = sorted[sorted.size() / 2];
    // the three best local maxima refined on the working grid
    std::vector<size_t> peaks;
    for (size_t k = 0; k < sweep.size(); k++) {
        const bool l = k == 0 || sweep[k - 1].second <= sweep[k].second, r = k + 1 == sweep.size() || sweep[k + 1].second <= sweep[k].second;
        if (l && r) peaks.push_back(k);
    }
    std::sort(peaks.begin(), peaks.end(), [&](size_t a, size_t b) { return sweep[a].second > sweep[b].second; });
    if (peaks.size() > 3) peaks.resize(3);
    prepare(fine, Bf, readF);
    double best = -2;
    for (size_t pk : peaks) {
        const double sAxis = coarse.orthoSMin + (sweep[pk].first + 0.5) * coarse.pixel;
        const double cf = (sAxis - fine.orthoSMin) / fine.pixel - 0.5;
        const int span = static_cast<int>(std::ceil(2 * coarse.pixel / fine.pixel));
        for (int d = -2 * span; d <= 2 * span; d++) {
            const double c = std::round(2 * cf) / 2 + 0.5 * d;
            if (c <= 0 || c >= fine.W - 1) continue;
            double ncc, share, iou;
            detail::mirrorAt(Bf, fine.outline, fine.W, fine.H, c, ncc, share, iou, readF);
            if (share < P.minPairShare || ncc * std::min(1.0, share) <= best) continue;
            best = ncc * std::min(1.0, share);
            out.ncc = ncc; out.share = std::min(1.0, share); out.outlineIoU = iou;
            out.axisS = fine.orthoSMin + (c + 0.5) * fine.pixel;
        }
    }
    if (best < -1) return out;
    out.contrast = out.ncc - out.medianNcc;
    out.centreOffsetM = out.axisS - middleS;
    for (int k = 0; k < 3; k++) out.axisPoint[k] = fine.centroid[k] + out.axisS * fine.axisS[k];
    out.periodic = out.medianNcc >= P.nccGate;
    out.detected = out.ncc >= P.nccGate && out.share >= P.facadeShare && out.contrast >= P.minContrast;
    return out;
}

// ---------------------------------------------------------------------------------------------------------------------
// twins

/** A plan isometry: x' = c + A (x - c), heights unchanged. */
struct PlanTransform {
    std::string kind;     // "mirror" or "rotation"
    double angleDeg = 0;  // the mirror axis's angle, or the rotation's angle
    int order = 0, k = 0; // a rotation's order and step
    Vec2d c;
    double a = 1, b = 0, cc = 0, d = 1;
    std::string from;     // which plan reading it came from (massing, tier N, footprint)
    double score = 0;
    Vec2d apply(Vec2d p) const { const double qx = p.x - c.x, qz = p.z - c.z; return {c.x + a * qx + b * qz, c.z + cc * qx + d * qz}; }
    Vec2d linear(Vec2d v) const { return {a * v.x + b * v.z, cc * v.x + d * v.z}; }
    static PlanTransform mirror(const Mirror& m, const std::string& from) {
        PlanTransform t; t.kind = "mirror"; t.angleDeg = m.angleDeg; t.c = m.point; t.from = from; t.score = m.score;
        const double r = 2 * m.angleDeg * M_PI / 180;
        t.a = std::cos(r); t.b = std::sin(r); t.cc = std::sin(r); t.d = -std::cos(r);
        return t;
    }
    static PlanTransform rotation(Vec2d c, int order, int k, double score, const std::string& from) {
        PlanTransform t; t.kind = "rotation"; t.order = order; t.k = k; t.c = c; t.from = from; t.score = score;
        const double r = 2 * M_PI * k / order;
        t.angleDeg = r * 180 / M_PI;
        t.a = std::cos(r); t.b = -std::sin(r); t.cc = std::sin(r); t.d = std::cos(r);
        return t;
    }
};

struct Twin {
    int a = 0, b = 0;                 // facade ids
    PlanTransform transform;
    double ncc = 0, share = 0;        // share: of a's read texels compared
    double shiftS = 0, shiftT = 0;    // the shift (m, in b's frame) the comparison settled on
    double overlapShare = 0;
    bool accepted = false;
};

namespace detail {

inline double dot3(const double* u, const double* v) { return u[0] * v[0] + u[1] * v[1] + u[2] * v[2]; }

/** Bilinear in a band-passed image (texel units, centres at integer + 0.5); NaN when any of the four is unread or outside. */
inline double sampleImage(const std::vector<float>& B, int W, int H, double fx, double fy) {
    fx -= 0.5; fy -= 0.5;
    const int x = static_cast<int>(std::floor(fx)), y = static_cast<int>(std::floor(fy));
    if (x < 0 || y < 0 || x + 1 >= W || y + 1 >= H) return std::numeric_limits<double>::quiet_NaN();
    const double ax = fx - x, ay = fy - y;
    const double v00 = B[static_cast<size_t>(y) * W + x], v10 = B[static_cast<size_t>(y) * W + x + 1], v01 = B[static_cast<size_t>(y + 1) * W + x], v11 = B[static_cast<size_t>(y + 1) * W + x + 1];
    return (v00 * (1 - ax) + v10 * ax) * (1 - ay) + (v01 * (1 - ax) + v11 * ax) * ay;
}

} // namespace detail

/**
 * Pairs of facades that are copies of each other under one of the plan's symmetries, and how alike their photos are
 * through it. `images` on the working grid; each candidate pair compared once per transform, the best transform kept.
 */
inline std::vector<Twin> twinFacades(const std::vector<FacadeImage>& images, const std::vector<PlanTransform>& transforms, const Params& P, FixedThreadPool* pool = nullptr) {
    struct Prepared { std::vector<float> B; std::vector<int> samples; double sLo, sHi, tLo, tHi; };
    std::vector<Prepared> prep(images.size());
    auto prepOne = [&](size_t i) {
        const FacadeImage& g = images[i];
        Prepared& p = prep[i];
        p.B = bandPass(g.L, g.W, g.H, std::max(1, static_cast<int>(std::round(P.highPassM / g.pixel))));
        std::vector<int> read;
        p.sLo = 1e300; p.sHi = -1e300; p.tLo = 1e300; p.tHi = -1e300;
        for (int y = 0; y < g.H; y++) for (int x = 0; x < g.W; x++) {
            const size_t k = static_cast<size_t>(y) * g.W + x;
            if (g.outline[k]) { p.sLo = std::min(p.sLo, g.s(x)); p.sHi = std::max(p.sHi, g.s(x)); p.tLo = std::min(p.tLo, g.t(y)); p.tHi = std::max(p.tHi, g.t(y)); }
            if (!std::isnan(p.B[k])) read.push_back(static_cast<int>(k));
        }
        const size_t stride = std::max<size_t>(1, (read.size() + P.twinSamples - 1) / P.twinSamples);
        for (size_t k = 0; k < read.size(); k += stride) p.samples.push_back(read[k]);
    };
    if (pool) pool->forEach(images.size(), prepOne); else for (size_t i = 0; i < images.size(); i++) prepOne(i);

    struct Job { size_t i, j; size_t t; double overlap; };
    std::vector<Job> jobs;
    for (size_t t = 0; t < transforms.size(); t++) {
        const PlanTransform& T = transforms[t];
        for (size_t i = 0; i < images.size(); i++) {
            const FacadeImage& A = images[i];
            if (prep[i].samples.size() < 64 || prep[i].sLo > prep[i].sHi) continue;
            const Vec2d cA = T.apply({A.centroid[0], A.centroid[2]});
            const Vec2d nA = T.linear({A.normal[0], A.normal[2]});
            for (size_t j = 0; j < images.size(); j++) {
                if (j == i) continue;
                if (T.kind == "mirror" && j < i) continue;   // a mirror is its own inverse: each pair once
                const FacadeImage& Bf = images[j];
                if (prep[j].samples.size() < 64 || prep[j].sLo > prep[j].sHi) continue;
                const double nn = nA.x * Bf.normal[0] + nA.z * Bf.normal[2];
                if (nn < P.twinNormalCos) continue;
                const double off = (cA.x - Bf.centroid[0]) * Bf.normal[0] + (A.centroid[1] - Bf.centroid[1]) * Bf.normal[1] + (cA.z - Bf.centroid[2]) * Bf.normal[2];
                if (std::fabs(off) > P.twinMaxOffsetM) continue;
                // A's outline extent carried into B's frame (s along, t up)
                auto toB = [&](double s, double tt) {
                    const double px = A.centroid[0] + s * A.axisS[0] + tt * A.axisT[0], py = A.centroid[1] + s * A.axisS[1] + tt * A.axisT[1], pz = A.centroid[2] + s * A.axisS[2] + tt * A.axisT[2];
                    const Vec2d q = T.apply({px, pz});
                    const double v[3] = {q.x - Bf.centroid[0], py - Bf.centroid[1], q.z - Bf.centroid[2]};
                    return std::pair<double, double>{detail::dot3(v, Bf.axisS), detail::dot3(v, Bf.axisT)};
                };
                const auto p0 = toB(prep[i].sLo, prep[i].tLo), p1 = toB(prep[i].sHi, prep[i].tHi);
                const double sLo = std::min(p0.first, p1.first), sHi = std::max(p0.first, p1.first), tLo = std::min(p0.second, p1.second), tHi = std::max(p0.second, p1.second);
                const double os = std::min(sHi, prep[j].sHi) - std::max(sLo, prep[j].sLo), ot = std::min(tHi, prep[j].tHi) - std::max(tLo, prep[j].tLo);
                if (os <= 0 || ot <= 0) continue;
                const double areaA = (sHi - sLo) * (tHi - tLo), areaB = (prep[j].sHi - prep[j].sLo) * (prep[j].tHi - prep[j].tLo);
                const double overlap = os * ot / std::max(1e-9, std::min(areaA, areaB));
                if (overlap < P.twinOverlapShare) continue;
                jobs.push_back({i, j, t, overlap});
            }
        }
    }
    std::vector<Twin> found(jobs.size());
    auto run = [&](size_t q) {
        const Job& jb = jobs[q];
        const FacadeImage& A = images[jb.i];
        const FacadeImage& Bf = images[jb.j];
        const PlanTransform& T = transforms[jb.t];
        // each sample's position in B's texel grid, once
        std::vector<std::array<double, 3>> pts;
        pts.reserve(prep[jb.i].samples.size());
        for (int k : prep[jb.i].samples) {
            const int x = k % A.W, y = k / A.W;
            const double s = A.s(x), tt = A.t(y);
            const double px = A.centroid[0] + s * A.axisS[0] + tt * A.axisT[0], py = A.centroid[1] + s * A.axisS[1] + tt * A.axisT[1], pz = A.centroid[2] + s * A.axisS[2] + tt * A.axisT[2];
            const Vec2d qp = T.apply({px, pz});
            const double v[3] = {qp.x - Bf.centroid[0], py - Bf.centroid[1], qp.z - Bf.centroid[2]};
            const double sb = detail::dot3(v, Bf.axisS), tb = detail::dot3(v, Bf.axisT);
            pts.push_back({(sb - Bf.orthoSMin) / Bf.pixel, (Bf.orthoTMax - tb) / Bf.pixel, prep[jb.i].B[static_cast<size_t>(k)]});
        }
        Twin tw;
        tw.a = A.id; tw.b = Bf.id; tw.transform = T; tw.overlapShare = jb.overlap; tw.ncc = -2;
        const int steps = static_cast<int>(std::round(P.twinShiftM / P.twinShiftStepM));
        for (int dy = -steps; dy <= steps; dy++) for (int dx = -steps; dx <= steps; dx++) {
            NccAcc acc;
            const double ox = dx * P.twinShiftStepM / Bf.pixel, oy = -dy * P.twinShiftStepM / Bf.pixel;
            for (const auto& p : pts) {
                const double w = detail::sampleImage(prep[jb.j].B, Bf.W, Bf.H, p[0] + ox, p[1] + oy);
                if (!std::isnan(w)) acc.add(p[2], w);
            }
            const double share = pts.empty() ? 0 : acc.n / static_cast<double>(pts.size());
            if (share < P.minPairShare) continue;
            const double ncc = acc.ncc();
            if (ncc > tw.ncc) { tw.ncc = ncc; tw.share = share; tw.shiftS = dx * P.twinShiftStepM; tw.shiftT = dy * P.twinShiftStepM; }
        }
        if (tw.ncc < -1) tw.ncc = 0;
        tw.accepted = tw.ncc >= P.nccGate;
        found[q] = tw;
    };
    if (pool) pool->forEach(jobs.size(), run); else for (size_t q = 0; q < jobs.size(); q++) run(q);
    // the best transform for each unordered pair
    std::vector<Twin> best;
    for (const Twin& t : found) {
        auto it = std::find_if(best.begin(), best.end(), [&](const Twin& o) { return (o.a == t.a && o.b == t.b) || (o.a == t.b && o.b == t.a); });
        if (it == best.end()) best.push_back(t);
        else if (t.ncc > it->ncc) *it = t;
    }
    std::sort(best.begin(), best.end(), [](const Twin& x, const Twin& y) { return x.ncc > y.ncc || (x.ncc == y.ncc && (x.a < y.a || (x.a == y.a && x.b < y.b))); });
    return best;
}

/** The plan symmetries carried into the twin search: every mirror peak and rotation at or above planGate, from the massing, the tiers and the footprint, de-duplicated. */
inline std::vector<PlanTransform> planTransforms(const PlanReport& r, const Params& P) {
    std::vector<PlanTransform> out;
    auto add = [&](const FieldSymmetry& f, const std::string& from) {
        for (const Mirror& m : f.mirrors) {
            if (m.score < P.planGate) continue;
            bool dup = false;
            for (const PlanTransform& t : out) if (t.kind == "mirror") {
                const double d = std::fabs(t.angleDeg - m.angleDeg);
                const double off = std::fabs((m.point.x - t.c.x) * -std::sin(t.angleDeg * M_PI / 180) + (m.point.z - t.c.z) * std::cos(t.angleDeg * M_PI / 180));
                if (std::min(d, 180 - d) < P.peakSepDeg && off < 2.0) dup = true;
            }
            if (!dup) out.push_back(PlanTransform::mirror(m, from));
        }
        if (f.rotation.order >= 2) for (int k = 1; k < f.rotation.order; k++) {
            bool dup = false;
            for (const PlanTransform& t : out) if (t.kind == "rotation" && std::fabs(std::fmod(t.angleDeg - 360.0 * k / f.rotation.order + 540.0, 360.0) - 180.0) < 1 && std::hypot(t.c.x - f.centroid.x, t.c.z - f.centroid.z) < 2.0) dup = true;
            if (!dup) out.push_back(PlanTransform::rotation(f.centroid, f.rotation.order, k, f.rotation.score, from));
        }
    };
    add(r.massing, "massing");
    for (size_t k = 0; k < r.tiers.size(); k++) add(r.tiers[k].outline, "tier " + std::to_string(k));
    if (r.hasFootprint) add(r.footprint, "footprint");
    return out;
}


// ---------------------------------------------------------------------------------------------------------------------
// the mirror fill (step 2): unread texels taken from the read texel the symmetry pairs them with

/** A facade photo at full resolution for the fill: RGBA, which texels are read, its frame. */
struct FillImage {
    int id = 0, W = 0, H = 0;
    double centroid[3]{}, normal[3]{}, axisS[3]{}, axisT[3]{};
    double orthoSMin = 0, orthoTMax = 0, pixel = 0.1;
    std::vector<uint8_t> rgba;
    std::vector<uint8_t> read;      // 1: the photo saw the wall here (covered, not occluded, not a smear)
    std::vector<uint8_t> unread;    // 1: the facade's own texel the photo did not read (filled or occluded)
};

struct FillParams {
    /** The ring of read texels around a region its symmetry must hold on (m), and the least ring texels paired. */
    double ringM = 1.0;
    int minRingPairs = 40;
    /** The ring's NCC against its mirror must reach this (the gate). */
    double nccGate = 0.55;
    /** Of the ring, at least this share must pair with read texels. */
    double minRingShare = 0.3;
};

struct FillRegionLog { int texels = 0; int filled = 0; double ringNcc = 0; int ringPairs = 0; std::string source; };

struct FillReport {
    int facadeId = 0;
    int unread = 0, fromSelf = 0;
    std::vector<std::pair<int, int>> fromTwins;   // (twin facade id, texels)
    int regions = 0, regionsFilled = 0, regionsRefused = 0;
    double axisS = 0, axisNcc = 0;
    std::vector<FillRegionLog> log;                // the largest regions, for the record
};

namespace detail {

inline double lumaAt(const std::vector<uint8_t>& rgba, size_t k) { return 0.299 * rgba[4 * k] + 0.587 * rgba[4 * k + 1] + 0.114 * rgba[4 * k + 2]; }

/** The unread regions (4-connected) of a fill image, each as its texel list and bounding box. */
inline std::vector<std::pair<std::vector<int>, std::array<int, 4>>> unreadRegions(const FillImage& g) {
    std::vector<std::pair<std::vector<int>, std::array<int, 4>>> out;
    std::vector<uint8_t> seen(g.unread.size(), 0);
    for (int start = 0; start < g.W * g.H; start++) {
        if (!g.unread[static_cast<size_t>(start)] || seen[static_cast<size_t>(start)]) continue;
        std::vector<int> region, stack{start};
        seen[static_cast<size_t>(start)] = 1;
        std::array<int, 4> box{g.W, g.H, -1, -1};
        while (!stack.empty()) {
            const int i = stack.back(); stack.pop_back();
            region.push_back(i);
            const int x = i % g.W, y = i / g.W;
            box[0] = std::min(box[0], x); box[1] = std::min(box[1], y); box[2] = std::max(box[2], x); box[3] = std::max(box[3], y);
            const int nb[4] = {x > 0 ? i - 1 : -1, x < g.W - 1 ? i + 1 : -1, y > 0 ? i - g.W : -1, y < g.H - 1 ? i + g.W : -1};
            for (int k : nb) if (k >= 0 && g.unread[static_cast<size_t>(k)] && !seen[static_cast<size_t>(k)]) { seen[static_cast<size_t>(k)] = 1; stack.push_back(k); }
        }
        out.push_back({std::move(region), box});
    }
    return out;
}

/** The read texels of g within r texels of a region's box that touch the region (a sampled ring). */
inline std::vector<int> ringOf(const FillImage& g, const std::vector<int>& region, const std::array<int, 4>& box, int r, size_t maxRing = 4000) {
    std::vector<uint8_t> inRegion;
    const int bx0 = std::max(0, box[0] - r), by0 = std::max(0, box[1] - r), bx1 = std::min(g.W - 1, box[2] + r), by1 = std::min(g.H - 1, box[3] + r);
    const int bw = bx1 - bx0 + 1, bh = by1 - by0 + 1;
    inRegion.assign(static_cast<size_t>(bw) * bh, 0);
    for (int i : region) inRegion[static_cast<size_t>(i / g.W - by0) * bw + (i % g.W - bx0)] = 1;
    // distance to the region, by a two-pass chamfer over the box
    std::vector<int> d(inRegion.size(), 1 << 20);
    for (size_t k = 0; k < d.size(); k++) if (inRegion[k]) d[k] = 0;
    for (int y = 0; y < bh; y++) for (int x = 0; x < bw; x++) {
        int& v = d[static_cast<size_t>(y) * bw + x];
        if (x) v = std::min(v, d[static_cast<size_t>(y) * bw + x - 1] + 1);
        if (y) v = std::min(v, d[static_cast<size_t>(y - 1) * bw + x] + 1);
    }
    for (int y = bh - 1; y >= 0; y--) for (int x = bw - 1; x >= 0; x--) {
        int& v = d[static_cast<size_t>(y) * bw + x];
        if (x + 1 < bw) v = std::min(v, d[static_cast<size_t>(y) * bw + x + 1] + 1);
        if (y + 1 < bh) v = std::min(v, d[static_cast<size_t>(y + 1) * bw + x] + 1);
    }
    std::vector<int> ring;
    for (int y = 0; y < bh; y++) for (int x = 0; x < bw; x++) {
        const int dv = d[static_cast<size_t>(y) * bw + x];
        if (dv < 1 || dv > r) continue;
        const int i = (y + by0) * g.W + (x + bx0);
        if (g.read[static_cast<size_t>(i)]) ring.push_back(i);
    }
    if (ring.size() > maxRing) {
        std::vector<int> s;
        const size_t stride = (ring.size() + maxRing - 1) / maxRing;
        for (size_t k = 0; k < ring.size(); k += stride) s.push_back(ring[k]);
        ring.swap(s);
    }
    return ring;
}

} // namespace detail

/**
 * A mapping of one facade's texels onto another's (or its own): `map(i)` gives the source texel index, or -1 when the
 * image falls outside the source. The fill copies a region only where the read ring around it agrees with its image
 * (NCC of luminance over ring texels whose image is read), so a symmetry that holds over the facade as a whole is not
 * pushed onto a part that breaks it (an entrance, a sign).
 */
template <class Map>
inline void fillRegionsFrom(FillImage& dst, const FillImage& src, Map map, const std::string& source, std::vector<uint8_t>& mask, FillReport& rep, int& counter, const FillParams& P) {
    const int r = std::max(1, static_cast<int>(std::round(P.ringM / dst.pixel)));
    for (auto& [region, box] : detail::unreadRegions(dst)) {
        rep.regions++;
        FillRegionLog lg;
        lg.texels = static_cast<int>(region.size());
        lg.source = source;
        const std::vector<int> ring = detail::ringOf(dst, region, box, r);
        NccAcc acc;
        for (int i : ring) {
            const int j = map(i);
            if (j >= 0 && src.read[static_cast<size_t>(j)]) acc.add(detail::lumaAt(dst.rgba, static_cast<size_t>(i)), detail::lumaAt(src.rgba, static_cast<size_t>(j)));
        }
        lg.ringPairs = static_cast<int>(acc.n);
        lg.ringNcc = acc.ncc();
        const bool holds = acc.n >= P.minRingPairs && acc.n >= P.minRingShare * ring.size() && lg.ringNcc >= P.nccGate;
        if (holds) {
            for (int i : region) {
                const int j = map(i);
                if (j < 0 || !src.read[static_cast<size_t>(j)]) continue;
                for (int c = 0; c < 3; c++) dst.rgba[4 * static_cast<size_t>(i) + c] = src.rgba[4 * static_cast<size_t>(j) + c];
                // never the exact grey the rectifier marks as uncovered
                if (dst.rgba[4 * static_cast<size_t>(i)] == 128 && dst.rgba[4 * static_cast<size_t>(i) + 1] == 128 && dst.rgba[4 * static_cast<size_t>(i) + 2] == 128) dst.rgba[4 * static_cast<size_t>(i) + 2] = 129;
                dst.unread[static_cast<size_t>(i)] = 0;
                mask[static_cast<size_t>(i)] = 255;
                lg.filled++;
            }
            counter += lg.filled;
            if (lg.filled) rep.regionsFilled++;
        } else if (acc.n > 0) rep.regionsRefused++;
        if (lg.texels >= 200) rep.log.push_back(lg);
    }
    std::sort(rep.log.begin(), rep.log.end(), [](const FillRegionLog& a, const FillRegionLog& b) { return a.texels > b.texels; });
    if (rep.log.size() > 12) rep.log.resize(12);
}

/** The facade's unread texels filled from its own mirror about the vertical axis at `axisS` (m along s). */
inline void fillFromOwnMirror(FillImage& g, double axisS, std::vector<uint8_t>& mask, FillReport& rep, const FillParams& P) {
    const double c = (axisS - g.orthoSMin) / g.pixel - 0.5;
    const FillImage src = g;   // reads come from the photo as it was (a fill never copies a fill)
    fillRegionsFrom(g, src, [&](int i) {
        const int x = i % g.W, y = i / g.W;
        const int xm = static_cast<int>(std::lround(2 * c - x));
        return xm < 0 || xm >= g.W ? -1 : y * g.W + xm;
    }, "mirror", mask, rep, rep.fromSelf, P);
}

/** The facade's unread texels filled from a twin facade through the plan transform, at the shift its comparison settled on. */
inline void fillFromTwin(FillImage& g, const FillImage& twin, const PlanTransform& T, double shiftS, double shiftT, std::vector<uint8_t>& mask, FillReport& rep, const FillParams& P) {
    int n = 0;
    fillRegionsFrom(g, twin, [&](int i) {
        const int x = i % g.W, y = i / g.W;
        const double s = g.orthoSMin + (x + 0.5) * g.pixel, t = g.orthoTMax - (y + 0.5) * g.pixel;
        const double px = g.centroid[0] + s * g.axisS[0] + t * g.axisT[0], py = g.centroid[1] + s * g.axisS[1] + t * g.axisT[1], pz = g.centroid[2] + s * g.axisS[2] + t * g.axisT[2];
        const Vec2d q = T.apply({px, pz});
        const double v[3] = {q.x - twin.centroid[0], py - twin.centroid[1], q.z - twin.centroid[2]};
        const double sb = detail::dot3(v, twin.axisS) + shiftS, tb = detail::dot3(v, twin.axisT) + shiftT;
        const int xb = static_cast<int>(std::floor((sb - twin.orthoSMin) / twin.pixel)), yb = static_cast<int>(std::floor((twin.orthoTMax - tb) / twin.pixel));
        return xb < 0 || yb < 0 || xb >= twin.W || yb >= twin.H ? -1 : yb * twin.W + xb;
    }, "twin " + std::to_string(twin.id), mask, rep, n, P);
    if (n) rep.fromTwins.push_back({twin.id, n});
}

} // namespace symmetry
} // namespace scratchbox
