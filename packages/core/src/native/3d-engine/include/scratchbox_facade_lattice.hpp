/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

#ifndef SCRATCHBOX_FACADE_LATTICE_HPP
#define SCRATCHBOX_FACADE_LATTICE_HPP

/**
 * Facades rebuilt on the lines their photo shows, natively (packages/core/src/node/3d-engine/staged-location/
 * facade-lattice.ts, which says what and why; this is its arithmetic, step for step, so the rebuilt vertices are the
 * TypeScript's bit for bit):
 *  - latticeFacade: one facade's lattice (photoLattice, fittedLattice on the window fit's windows and the bays), its cell
 *    depths from the scan (facadeSamples), windows (windowGrid or the fit's), strips (windowStrips, windowBays), structure,
 *    and the rebuilt surface; with the facade's photo redrawn from its repeats (facade-repeat-texture.ts repeatTexture)
 *    and encoded, when its strips and windows are given;
 *  - audit: applyFacadeLattices' removals and tear audit (decide, the straight and angled views, restore unless in front
 *    of the rebuild, the facades dropped), returning which scan triangle each rebuilt facade claims.
 * Facades are one task each on the caller's pool; the audit's views one task each, its triangles in chunks.
 *
 * Sorts that a comparator decides run as V8 runs them (js::sort); medians of finite values are selected directly and
 * give the same element. The angles the audit turns by come with their sines and cosines worked out in JavaScript.
 */

#include "scratchbox_js_math.hpp"
#include "scratchbox_png.hpp"
#include "scratchbox_thread_pool.hpp"

#include <algorithm>
#include <array>
#include <atomic>
#include <cmath>
#include <cstdint>
#include <cstring>
#include <fstream>
#include <iterator>
#include <limits>
#include <map>
#include <stdexcept>
#include <string>
#include <unordered_map>
#include <vector>

// V8 never fuses a multiply and an add
#pragma clang fp contract(off)

namespace scratchbox {
namespace facade_lattice {

using Vec3 = std::array<double, 3>;
using Rect = std::array<double, 4>;

constexpr double kNaN = std::numeric_limits<double>::quiet_NaN();
constexpr double kInf = std::numeric_limits<double>::infinity();

/** FACADE_LATTICE_PARAMS, PHOTO_RECESS, WINDOW_GRID, WINDOW_STRIPS, STRUCTURE and REPEAT_TEXTURE in order (facade-lattice.ts latticeParamVector). */
struct Params {
    double minCoverage, minWallM2, peakK, minLineGapM, depthBandM, facingCos, sampleM, minSamples, minDepthM, maxDepthM, stepM,
        minMeasuredShare, minCellPhotoShare, auditPixelM, tearDepthM, auditYawDeg, auditPitchDeg, auditBeyondM, restoreFrontM;
    double recessContrastLo, recessContrastHi, recessMin, recessMax, recessMinRepeats;
    double gridLineContrast, gridCellContrast, gridMinRepeats;
    double stripOverlap, stripMaxGapM, stripMinWindows, stripMinStripM, stripMullionRatio, stripWindowInsetM;
    double chamferM, minReliefM, defaultReliefM;
    double rtSizeTol, rtMinRepeats, rtEdgeM, rtKeepShade, rtMaxShade, rtMaxSpandrelM, rtMinSidePx;
    /** The audit's world box reach (the module's depthBandM + 1, whatever P says), and its four angled views' turns. */
    double reachM;
    double viewDeg[4], viewCos[4], viewSin[4];
    /** The surface's merged faces and steps at most this on a side (m). */
    double mergeMaxM;

    static constexpr size_t kCount = 19 + 5 + 3 + 6 + 3 + 7 + 1 + 12 + 1;
    static Params from(const std::vector<double>& v) {
        if (v.size() != kCount) throw std::runtime_error("the lattice takes " + std::to_string(kCount) + " parameters, got " + std::to_string(v.size()));
        Params p;
        double* const fields[] = {&p.minCoverage, &p.minWallM2, &p.peakK, &p.minLineGapM, &p.depthBandM, &p.facingCos, &p.sampleM, &p.minSamples, &p.minDepthM, &p.maxDepthM, &p.stepM,
            &p.minMeasuredShare, &p.minCellPhotoShare, &p.auditPixelM, &p.tearDepthM, &p.auditYawDeg, &p.auditPitchDeg, &p.auditBeyondM, &p.restoreFrontM,
            &p.recessContrastLo, &p.recessContrastHi, &p.recessMin, &p.recessMax, &p.recessMinRepeats,
            &p.gridLineContrast, &p.gridCellContrast, &p.gridMinRepeats,
            &p.stripOverlap, &p.stripMaxGapM, &p.stripMinWindows, &p.stripMinStripM, &p.stripMullionRatio, &p.stripWindowInsetM,
            &p.chamferM, &p.minReliefM, &p.defaultReliefM,
            &p.rtSizeTol, &p.rtMinRepeats, &p.rtEdgeM, &p.rtKeepShade, &p.rtMaxShade, &p.rtMaxSpandrelM, &p.rtMinSidePx,
            &p.reachM,
            &p.viewDeg[0], &p.viewCos[0], &p.viewSin[0], &p.viewDeg[1], &p.viewCos[1], &p.viewSin[1],
            &p.viewDeg[2], &p.viewCos[2], &p.viewSin[2], &p.viewDeg[3], &p.viewCos[3], &p.viewSin[3],
            &p.mergeMaxM};
        static_assert(sizeof fields / sizeof fields[0] == kCount);
        for (size_t i = 0; i < kCount; ++i) *fields[i] = v[i];
        return p;
    }
};

/** A facade's plane frame and its ortho (ReliefFacade). */
struct Frame {
    int facadeId = 0;
    Vec3 centroid{}, normal{}, axisS{}, axisT{};
    double sMin = 0, sMax = 0, tMin = 0, tMax = 0, pixel = 0, orthoSMin = 0, orthoTMax = 0;
};

struct Image {
    int W = 0, H = 0;
    std::vector<uint8_t> rgba;
};

/** One facade to rebuild: rebuildFacadesOnLattice's arguments to latticeFacade, and its repeat texture's windows. */
struct FacadeJob {
    Frame f;
    std::string image, mask;
    std::vector<Rect> fitted;
    bool hasBays = false;
    std::vector<Rect> bays;
    bool hasRecess = false;
    double recessM = 0;
    /** The windows in texels ([x0, y0, x1, y1], y down) for the repeat texture; none: no repeat texture. */
    std::vector<Rect> rectsPx;
};

/** latticeFacade's FacadeLatticeResult (ok false: undefined). */
struct LatticeResult {
    bool ok = false;
    std::vector<double> s, t;
    int cells = 0;
    double measuredShare = 0;
    std::vector<double> depth;
    bool hasPhotoRecess = false;
    int photoRecessCells = 0;
    std::vector<Rect> strips;
    int stripCells = 0;
    bool hasStructure = false;
    std::vector<uint8_t> structureCells;
    double reliefM = 0;
    std::string reliefFrom, reason;
    std::vector<uint8_t> built, windows;
    std::vector<double> cellU, cellV;
    std::vector<float> positions, normals, uv;
    std::vector<uint32_t> indices;
    /** latticeSurface's report: cells, faces, steps, chamfered steps, cut faces, mitres, caps, triangles, vertices. */
    int surface[9] = {0, 0, 0, 0, 0, 0, 0, 0, 0};
};

/** repeatTexture's report (its method sentence is written by the caller) and the redrawn photo, encoded. */
struct RepeatResult {
    bool ok = false;
    int groups = 0, windows = 0, spandrels = 0;
    double texels = 0, filled = 0, edge = 0;
    std::vector<uint8_t> png;
};

struct FacadeOut {
    /** The photo's size. */
    int W = 0, H = 0;
    LatticeResult r;
    RepeatResult repeat;
};

namespace detail {

inline double dot(const Vec3& a, const Vec3& b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
inline bool finite(double v) { return std::isfinite(v); }

/** median() of values that are all numbers (no NaN): the element a stable ascending sort puts at length >> 1. */
inline double median(std::vector<double> a) {
    if (a.empty()) return kNaN;
    const size_t m = a.size() >> 1;
    std::vector<double> keep;
    keep.reserve(a.size());
    keep = a;
    std::nth_element(a.begin(), a.begin() + static_cast<long>(m), a.end());
    const double v = a[m];
    if (v != 0) return v;
    // among equal zeros the stable sort keeps their order: the one at m is the (m - below)th zero as given
    size_t below = 0;
    for (double x : keep) if (x < 0) ++below;
    size_t z = m - below;
    for (double x : keep) if (x == 0 && z-- == 0) return x;
    return v;
}

/** median() of values that may hold NaN: Array.prototype.sort((x, y) => x - y) as V8 runs it. */
inline double medianJs(std::vector<double> a) {
    if (a.empty()) return kNaN;
    js::sort(a, [](double x, double y) { return x - y; });
    return a[a.size() >> 1];
}

inline double minOf(const std::vector<double>& v) { double m = kInf; for (double x : v) m = js::min(m, x); return m; }
inline double maxOf(const std::vector<double>& v) { double m = -kInf; for (double x : v) m = js::max(m, x); return m; }

inline Image readPng(const std::string& file) {
    std::ifstream in(file, std::ios::binary);
    if (!in) throw std::runtime_error("cannot read " + file);
    const std::vector<uint8_t> bytes((std::istreambuf_iterator<char>(in)), std::istreambuf_iterator<char>());
    auto d = png::decode(bytes.data(), bytes.size(), png::OutputFormat::Rgba);
    if (!d.ok) throw std::runtime_error(file + ": " + d.error);
    Image img;
    img.W = d.image.width;
    img.H = d.image.height;
    img.rgba = std::move(d.image.data);
    return img;
}

// --------------------------------------------------------------------------------------------- the lattice

inline std::vector<int> peaks(const std::vector<double>& p, double k, double sep) {
    const size_t n = p.size();
    double sum = 0;
    for (double v : p) sum += v;
    const double m = sum / static_cast<double>(n);
    double ss = 0;
    for (double v : p) ss += (v - m) * (v - m);
    const double sd = std::sqrt(ss / static_cast<double>(n));
    std::vector<int> c;
    for (size_t i = 1; i + 1 < n; ++i) if (p[i] > m + k * sd && p[i] >= p[i - 1] && p[i] >= p[i + 1]) c.push_back(static_cast<int>(i));
    js::sort(c, [&](int a, int b) { return p[b] - p[a]; });
    std::vector<int> keep;
    for (int i : c) {
        bool ok = true;
        for (int j : keep) if (!(std::abs(j - i) >= sep)) { ok = false; break; }
        if (ok) keep.push_back(i);
    }
    js::sort(keep, [](int a, int b) { return static_cast<double>(a - b); });
    return keep;
}

inline std::vector<double> luminance(const Image& img) {
    std::vector<double> L(static_cast<size_t>(img.W) * img.H);
    for (size_t k = 0; k < L.size(); ++k) {
        const uint8_t* q = &img.rgba[k * 4];
        L[k] = q[3] ? 0.3 * q[0] + 0.59 * q[1] + 0.11 * q[2] : kNaN;
    }
    return L;
}

/** photoLattice: the facade's lines in its plane's frame, bounds included. */
inline void photoLattice(const Image& img, const std::vector<double>& L, const Frame& f, const Params& P, std::vector<double>& s, std::vector<double>& t) {
    const int w = img.W, h = img.H;
    const double px = f.pixel;
    std::vector<double> rowE(static_cast<size_t>(h), 0.0), colE(static_cast<size_t>(w), 0.0);
    for (int y = 1; y < h - 1; ++y) for (int x = 1; x < w - 1; ++x) {
        const double gy = std::abs(L[static_cast<size_t>(y + 1) * w + x] - L[static_cast<size_t>(y - 1) * w + x]);
        const double gx = std::abs(L[static_cast<size_t>(y) * w + x + 1] - L[static_cast<size_t>(y) * w + x - 1]);
        if (finite(gy)) rowE[static_cast<size_t>(y)] += gy;
        if (finite(gx)) colE[static_cast<size_t>(x)] += gx;
    }
    const double sep = js::max(2, js::round(P.minLineGapM / px));
    s.assign(1, f.sMin);
    for (int x : peaks(colE, P.peakK, sep)) { const double v = f.orthoSMin + x * px; if (v > f.sMin + P.minLineGapM && v < f.sMax - P.minLineGapM) s.push_back(v); }
    s.push_back(f.sMax);
    std::vector<double> tv;
    for (int y : peaks(rowE, P.peakK, sep)) { const double v = f.orthoTMax - y * px; if (v > f.tMin + P.minLineGapM && v < f.tMax - P.minLineGapM) tv.push_back(v); }
    js::sort(tv, [](double a, double b) { return a - b; });
    t.assign(1, f.tMin);
    t.insert(t.end(), tv.begin(), tv.end());
    t.push_back(f.tMax);
}

/** fittedLattice's merge: the fit's lines (clamped, unique, inside) and the photo's lines away from them. */
inline std::vector<double> mergeLines(const std::vector<double>& fromPhoto, const std::vector<double>& fromFit, double lo, double hi, double gap) {
    std::vector<double> fit;
    for (double v0 : fromFit) {
        const double v = js::min(hi, js::max(lo, v0));
        bool seen = false;
        for (double u : fit) if (u == v || (std::isnan(u) && std::isnan(v))) { seen = true; break; }
        if (!seen) fit.push_back(v);
    }
    std::vector<double> lines;
    for (double v : fit) if (v > lo + 1e-6 && v < hi - 1e-6) lines.push_back(v);
    const std::vector<double> fitIn = lines;
    for (double v : fromPhoto) {
        if (!(v > lo && v < hi)) continue;
        bool away = true;
        for (double e : fitIn) if (!(std::abs(e - v) >= gap)) { away = false; break; }
        if (away) lines.push_back(v);
    }
    js::sort(lines, [](double a, double b) { return a - b; });
    std::vector<double> out{lo};
    out.insert(out.end(), lines.begin(), lines.end());
    out.push_back(hi);
    return out;
}

/** facadeSamples: [s, t, d] triples of the scan (nine floats a triangle) in the facade's frame. */
inline std::vector<double> facadeSamples(const std::vector<float>& soup, const Frame& f, const Params& P) {
    std::vector<double> out;
    for (size_t i = 0; i + 8 < soup.size(); i += 9) {
        const double ux = static_cast<double>(soup[i + 3]) - soup[i], uy = static_cast<double>(soup[i + 4]) - soup[i + 1], uz = static_cast<double>(soup[i + 5]) - soup[i + 2];
        const double vx = static_cast<double>(soup[i + 6]) - soup[i], vy = static_cast<double>(soup[i + 7]) - soup[i + 1], vz = static_cast<double>(soup[i + 8]) - soup[i + 2];
        const double nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx, nl = js::hypot({nx, ny, nz});
        if (!(nl > 0) || std::abs(dot({nx / nl, ny / nl, nz / nl}, f.normal)) < P.facingCos) continue;
        const auto rel = [&](size_t k) -> Vec3 { return {soup[i + k] - f.centroid[0], soup[i + k + 1] - f.centroid[1], soup[i + k + 2] - f.centroid[2]}; };
        const Vec3 a = rel(0), b = rel(3), c = rel(6);
        const double da = dot(a, f.normal), db = dot(b, f.normal), dc = dot(c, f.normal);
        if (js::min(js::min(da, db), dc) > P.depthBandM || js::max(js::max(da, db), dc) < -P.depthBandM) continue;
        const double sa = dot(a, f.axisS), sb = dot(b, f.axisS), sc = dot(c, f.axisS), ta = dot(a, f.axisT), tb = dot(b, f.axisT), tc = dot(c, f.axisT);
        if (js::max(js::max(sa, sb), sc) < f.sMin || js::min(js::min(sa, sb), sc) > f.sMax || js::max(js::max(ta, tb), tc) < f.tMin || js::min(js::min(ta, tb), tc) > f.tMax) continue;
        const double steps = js::min(30, js::max(1, std::ceil(js::max(js::hypot({sb - sa, tb - ta}), js::hypot({sc - sa, tc - ta})) / P.sampleM)));
        const int n = static_cast<int>(steps);
        for (int p = 0; p <= n; ++p) for (int q = 0; p + q <= n; ++q) {
            const double u = p / steps, v = q / steps, d = da + (db - da) * u + (dc - da) * v;
            if (std::abs(d) <= P.depthBandM) { out.push_back(sa + (sb - sa) * u + (sc - sa) * v); out.push_back(ta + (tb - ta) * u + (tc - ta) * v); out.push_back(d); }
        }
    }
    return out;
}

inline int cellOf(double v, const std::vector<double>& edges) {
    int lo = 0, hi = static_cast<int>(edges.size()) - 1;
    if (v < edges[0] || v > edges[static_cast<size_t>(hi)]) return -1;
    while (hi - lo > 1) { const int m = (lo + hi) >> 1; if (edges[static_cast<size_t>(m)] <= v) lo = m; else hi = m; }
    return lo;
}

inline std::vector<double> cellMedians(const std::vector<double>& samples, const std::vector<double>& s, const std::vector<double>& t, double minSamples) {
    const size_t ns = s.size() - 1, nt = t.size() - 1;
    std::vector<std::vector<double>> bucket(ns * nt);
    for (size_t i = 0; i + 2 < samples.size(); i += 3) {
        const int a = cellOf(samples[i], s), b = cellOf(samples[i + 1], t);
        if (a >= 0 && b >= 0) bucket[static_cast<size_t>(b) * ns + static_cast<size_t>(a)].push_back(samples[i + 2]);
    }
    std::vector<double> out(ns * nt);
    for (size_t k = 0; k < out.size(); ++k) out[k] = static_cast<double>(bucket[k].size()) >= minSamples ? median(std::move(bucket[k])) : kNaN;
    return out;
}

/** windowGrid: a darker column crossing a darker row, the cell darker than the wall, repeated along its row. */
inline std::vector<uint8_t> windowGrid(const std::vector<double>& lum, size_t ns, size_t nt, const Params& P) {
    std::vector<double> col(ns, kNaN), row(nt, kNaN);
    for (size_t a = 0; a < ns; ++a) { double s = 0; int n = 0; for (size_t b = 0; b < nt; ++b) { const double v = lum[b * ns + a]; if (finite(v)) { s += v; n++; } } if (n) col[a] = s / n; }
    for (size_t b = 0; b < nt; ++b) { double s = 0; int n = 0; for (size_t a = 0; a < ns; ++a) { const double v = lum[b * ns + a]; if (finite(v)) { s += v; n++; } } if (n) row[b] = s / n; }
    const auto upper = [](const std::vector<double>& v) {
        std::vector<double> f;
        for (double x : v) if (finite(x)) f.push_back(x);
        js::sort(f, [](double x, double y) { return x - y; });
        return f.empty() ? kNaN : f[static_cast<size_t>(std::floor(0.75 * static_cast<double>(f.size() - 1)))];
    };
    const double mc = upper(col), mr = upper(row);
    std::vector<uint8_t> darkCol(ns), darkRow(nt);
    for (size_t a = 0; a < ns; ++a) darkCol[a] = col[a] < mc * (1 - P.gridLineContrast);
    for (size_t b = 0; b < nt; ++b) darkRow[b] = row[b] < mr * (1 - P.gridLineContrast);
    std::vector<double> wall;
    for (size_t k = 0; k < ns * nt; ++k) if (!(darkCol[k % ns] && darkRow[k / ns]) && finite(lum[k])) wall.push_back(lum[k]);
    const double wallLum = median(std::move(wall));
    std::vector<uint8_t> out(ns * nt);
    if (!(wallLum > 0)) return out;
    for (size_t b = 0; b < nt; ++b) {
        if (!darkRow[b]) continue;
        std::vector<size_t> cells;
        for (size_t a = 0; a < ns; ++a) { const size_t k = b * ns + a; const double v = lum[k]; if (darkCol[a] && finite(v) && v <= wallLum * (1 - P.gridCellContrast)) cells.push_back(k); }
        if (static_cast<double>(cells.size()) >= P.gridMinRepeats) for (size_t k : cells) out[k] = 1;
    }
    return out;
}

/** The comparator (a, b) => a[0] - b[0] || a[1] - b[1]. */
inline double byS0T0(const Rect& a, const Rect& b) { const double d = a[0] - b[0]; return d != 0 && !std::isnan(d) ? d : a[1] - b[1]; }

/** windowBays: strips side by side joined into bays across their mullions. */
inline std::vector<Rect> windowBays(const std::vector<Rect>& strips, const Params& P) {
    const auto tOverlap = [&](const Rect& a, const Rect& b) { return js::min(a[3], b[3]) - js::max(a[1], b[1]) >= P.stripOverlap * js::min(a[3] - a[1], b[3] - b[1]); };
    std::vector<Rect> out;
    std::vector<uint8_t> used(strips.size());
    for (size_t i = 0; i < strips.size(); ++i) {
        if (used[i]) continue;
        std::vector<size_t> row;
        for (size_t k = 0; k < strips.size(); ++k) if (!used[k] && tOverlap(strips[k], strips[i])) row.push_back(k);
        js::sort(row, [&](size_t a, size_t b) { return strips[a][0] - strips[b][0]; });
        for (size_t k : row) used[k] = 1;
        std::vector<double> gaps;
        for (size_t j = 0; j + 1 < row.size(); ++j) gaps.push_back(strips[row[j + 1]][0] - strips[row[j]][2]);
        const auto beside = [&](size_t j) { return js::min(j > 0 ? gaps[j - 1] : kInf, j + 1 < gaps.size() ? gaps[j + 1] : kInf); };
        Rect bay = strips[row[0]];
        for (size_t j = 0; j + 1 < row.size(); ++j) {
            const Rect& x = strips[row[j + 1]];
            if (finite(beside(j)) && gaps[j] < P.stripMullionRatio * beside(j)) bay = {bay[0], js::min(bay[1], x[1]), x[2], js::max(bay[3], x[3])};
            else { out.push_back(bay); bay = x; }
        }
        out.push_back(bay);
    }
    js::sort(out, byS0T0);
    return out;
}

/** windowStrips: the fitted windows' columns, split at gaps, each run drawn as one strip; then the bays. */
inline std::vector<Rect> windowStrips(const std::vector<Rect>& windows, const Params& P) {
    const size_t n = windows.size();
    std::vector<size_t> parent(n);
    for (size_t i = 0; i < n; ++i) parent[i] = i;
    const auto find = [&](size_t i) { while (parent[i] != i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
    for (size_t i = 0; i < n; ++i) for (size_t j = i + 1; j < n; ++j) {
        const Rect &a = windows[i], &b = windows[j];
        const double ov = js::min(a[2], b[2]) - js::max(a[0], b[0]);
        if (ov >= P.stripOverlap * js::min(a[2] - a[0], b[2] - b[0])) parent[find(i)] = find(j);
    }
    // the columns in the order their first window comes (a Map keyed by each window's root)
    std::vector<size_t> roots;
    std::vector<std::vector<Rect>> cols;
    for (size_t i = 0; i < n; ++i) {
        const size_t r = find(i);
        size_t c = 0;
        while (c < roots.size() && roots[c] != r) ++c;
        if (c == roots.size()) { roots.push_back(r); cols.emplace_back(); }
        cols[c].push_back(windows[i]);
    }
    std::vector<Rect> out;
    for (auto& col : cols) {
        js::sort(col, [](const Rect& a, const Rect& b) { return a[1] - b[1]; });
        std::vector<Rect> run;
        const auto close = [&] {
            if (!run.empty()) {
                std::vector<double> w0, w1, w2, w3;
                for (const Rect& w : run) { w0.push_back(w[0]); w1.push_back(w[1]); w2.push_back(w[2]); w3.push_back(w[3]); }
                if (static_cast<double>(run.size()) >= P.stripMinWindows || maxOf(w3) - minOf(w1) >= P.stripMinStripM) out.push_back({median(w0), minOf(w1), median(w2), maxOf(w3)});
            }
            run.clear();
        };
        for (const Rect& w : col) {
            if (!run.empty()) { double top = -kInf; for (const Rect& x : run) top = js::max(top, x[3]); if (w[1] - top > P.stripMaxGapM) close(); }
            run.push_back(w);
        }
        close();
    }
    js::sort(out, byS0T0);
    return windowBays(out, P);
}

inline std::vector<uint8_t> fittedCells(const std::vector<double>& s, const std::vector<double>& t, const std::vector<Rect>& windows) {
    const size_t ns = s.size() - 1, nt = t.size() - 1;
    std::vector<uint8_t> out(ns * nt);
    for (size_t b = 0; b < nt; ++b) for (size_t a = 0; a < ns; ++a) {
        const double cs = (s[a] + s[a + 1]) / 2, ct = (t[b] + t[b + 1]) / 2;
        for (const Rect& w : windows) if (cs > w[0] && cs < w[2] && ct > w[1] && ct < w[3]) { out[b * ns + a] = 1; break; }
    }
    return out;
}

/** photoRecessDepth; NaN for undefined. */
inline double photoRecessDepth(double contrast, const Params& P) {
    if (!(contrast >= P.recessContrastLo)) return kNaN;
    const double x = js::min(1, js::max(0, (contrast - P.recessContrastLo) / (P.recessContrastHi - P.recessContrastLo)));
    return P.recessMin + (P.recessMax - P.recessMin) * x * x * (3 - 2 * x);
}

inline std::string cm(double v) { return js::toString(js::round(v * 100)); }

/**
 * latticeSurface: a rebuilt facade's surface welded, lean and closed (facade-lattice.ts latticeSurface, which says what and
 * why): flat regions of cells at their median depth cut into faces, steps on the lines between them, the chamfered arrises
 * mitred, run on or capped with the recessed faces cut back to their feet, a vertex at every corner another face or step has
 * on an edge, and the vertices welded. Writes positions, normals, UVs, indices and the report into res.
 */
inline void latticeSurface(const Frame& f, double Wm, double Hm, const std::vector<double>& s, const std::vector<double>& t, const std::vector<uint8_t>& built,
                           const std::vector<double>& depth, const std::vector<double>& scan, bool structure, const Params& P, LatticeResult& res) {
    const long ns = static_cast<long>(s.size()) - 1, nt = static_cast<long>(t.size()) - 1, G = ns + 1;
    const auto at = [&](long a, long b) { return static_cast<size_t>(b * ns + a); };
    const auto gk = [&](long x, long y) { return static_cast<size_t>(y * G + x); };
    const auto isBuilt = [&](long a, long b) { return a >= 0 && b >= 0 && a < ns && b < nt && built[at(a, b)]; };
    // 1. the flat regions, then the faces
    std::vector<int32_t> region(static_cast<size_t>(ns * nt), -1);
    std::vector<double> D(static_cast<size_t>(ns * nt), 0.0);
    int32_t regions = 0;
    for (long k0 = 0; k0 < ns * nt; ++k0) {
        if (!built[static_cast<size_t>(k0)] || region[static_cast<size_t>(k0)] >= 0) continue;
        double lo = depth[static_cast<size_t>(k0)], hi = lo;
        std::vector<long> queue{k0};
        region[static_cast<size_t>(k0)] = regions;
        for (size_t qi = 0; qi < queue.size(); ++qi) {
            const long k = queue[qi], a = k % ns, b = k / ns;
            const long nb[4][2] = {{a + 1, b}, {a, b + 1}, {a - 1, b}, {a, b - 1}};
            for (const auto& c : nb) {
                if (!isBuilt(c[0], c[1])) continue;
                const size_t n = at(c[0], c[1]);
                const double v = depth[n];
                if (region[n] >= 0 || !(js::max(hi, v) - js::min(lo, v) <= P.stepM)) continue;
                lo = js::min(lo, v); hi = js::max(hi, v); region[n] = regions; queue.push_back(static_cast<long>(n));
            }
        }
        std::vector<double> member;
        for (long k : queue) member.push_back(depth[static_cast<size_t>(k)]);
        const double rep = median(member);
        for (long k : queue) D[static_cast<size_t>(k)] = rep;
        regions++;
    }
    std::vector<int32_t> faceOf(static_cast<size_t>(ns * nt), -1);
    std::vector<std::array<long, 4>> faces;
    for (long b = 0; b < nt; ++b) for (long a = 0; a < ns; ++a) {
        const size_t k = at(a, b);
        if (!built[k] || faceOf[k] >= 0) continue;
        const auto freeCell = [&](long x, long y) { return isBuilt(x, y) && faceOf[at(x, y)] < 0 && region[at(x, y)] == region[k]; };
        long a1 = a, b1 = b;
        while (freeCell(a1 + 1, b) && s[static_cast<size_t>(a1 + 2)] - s[static_cast<size_t>(a)] <= P.mergeMaxM) a1++;
        for (;;) {
            if (!(b1 + 1 < nt) || !(t[static_cast<size_t>(b1 + 2)] - t[static_cast<size_t>(b)] <= P.mergeMaxM)) break;
            bool row = true;
            for (long x = a; x <= a1 && row; ++x) row = freeCell(x, b1 + 1);
            if (!row) break;
            b1++;
        }
        for (long y = b; y <= b1; ++y) for (long x = a; x <= a1; ++x) faceOf[at(x, y)] = static_cast<int32_t>(faces.size());
        faces.push_back({a, b, a1, b1});
    }
    // 2. the steps, line by line
    const auto bevelOf = [&](double l, double r) { return structure && std::abs(l - r) >= 2 * P.chamferM ? P.chamferM : 0.0; };
    // 0: none; 1: between two rebuilt cells; 2: toward the scan
    const auto stepDepths = [&](long na, long nb, long xa, long xb, double& L, double& R) {
        const bool n = isBuilt(na, nb), x = isBuilt(xa, xb);
        if (!n && !x) return 0;
        const auto depthAt = [&](long a, long b, bool own) { return own ? D[at(a, b)] : a >= 0 && b >= 0 && a < ns && b < nt ? scan[at(a, b)] : kNaN; };
        L = depthAt(na, nb, n); R = depthAt(xa, xb, x);
        if (n && x) return L != R ? 1 : 0;
        return std::abs(L - R) > P.stepM ? 2 : 0;
    };
    struct Step { int dir; long line, from, to; double L, R, c; };
    std::vector<Step> steps;
    const auto runs = [&](int dir, long lines, long along, const std::vector<double>& edges) {
        for (long line = 0; line < lines; ++line) {
            bool open = false;
            Step cur{};
            for (long i = 0; i < along; ++i) {
                double L = 0, R = 0;
                const int p = dir == 0 ? stepDepths(line - 1, i, line, i, L, R) : stepDepths(i, line - 1, i, line, L, R);
                const double c = p == 1 ? bevelOf(L, R) : 0.0;
                if (open && p && L == cur.L && R == cur.R && c == cur.c && edges[static_cast<size_t>(i + 1)] - edges[static_cast<size_t>(cur.from)] <= P.mergeMaxM) { cur.to = i; continue; }
                if (open) steps.push_back(cur);
                open = p != 0;
                if (open) cur = Step{dir, line, i, i, L, R, c};
            }
            if (open) steps.push_back(cur);
        }
    };
    runs(0, G, nt, t);
    runs(1, nt + 1, ns, s);
    // 3. the corners everything meets at, and the depths met at each
    std::vector<uint8_t> junction(static_cast<size_t>(G * (nt + 1)));
    for (const auto& q : faces) {
        const long cs[4][2] = {{q[0], q[1]}, {q[2] + 1, q[1]}, {q[0], q[3] + 1}, {q[2] + 1, q[3] + 1}};
        for (const auto& c : cs) junction[gk(c[0], c[1])] = 1;
    }
    const auto corner = [&](const Step& st, int end, long& x, long& y) { const long i = end ? st.to + 1 : st.from; x = st.dir == 0 ? st.line : i; y = st.dir == 0 ? i : st.line; };
    std::vector<std::vector<double>> met(static_cast<size_t>(G * (nt + 1)));
    const auto meet = [&](long x, long y, double d) { auto& l = met[gk(x, y)]; if (std::find(l.begin(), l.end(), d) == l.end()) l.push_back(d); };
    for (const Step& st : steps) for (int end = 0; end < 2; ++end) {
        long x, y;
        corner(st, end, x, y);
        junction[gk(x, y)] = 1;
        meet(x, y, st.L); meet(x, y, st.R);
    }
    for (long y = 0; y <= nt; ++y) for (long x = 0; x <= ns; ++x) {
        if (!junction[gk(x, y)]) continue;
        const long around[4][2] = {{x - 1, y - 1}, {x, y - 1}, {x - 1, y}, {x, y}};
        for (const auto& c : around) if (isBuilt(c[0], c[1])) meet(x, y, D[at(c[0], c[1])]);
    }
    // 4. the chamfered arrises, closed
    const auto alongOf = [&](int dir) -> const std::vector<double>& { return dir == 0 ? t : s; };
    const auto acrossOf = [&](int dir) -> const std::vector<double>& { return dir == 0 ? s : t; };
    struct Arris { size_t st; double front, back, into, l, inset; int kind[2]; double backEnd[2], cutEnd[2]; int partner[2], partnerEnd[2]; std::array<double, 4> z; };
    std::vector<Arris> arrises;
    std::vector<int> arrisOf(steps.size(), -1);
    for (size_t i = 0; i < steps.size(); ++i) {
        const Step& st = steps[i];
        if (!st.c) continue;
        const double into = st.L < st.R ? -1 : 1, l = acrossOf(st.dir)[static_cast<size_t>(st.line)];
        const auto& A = alongOf(st.dir);
        Arris x{i, js::max(st.L, st.R), js::min(st.L, st.R), into, l, l + into * st.c, {1, 1}, {A[static_cast<size_t>(st.from)], A[static_cast<size_t>(st.to + 1)]}, {A[static_cast<size_t>(st.from)], A[static_cast<size_t>(st.to + 1)]}, {-1, -1}, {0, 0}, {}};
        arrisOf[i] = static_cast<int>(arrises.size());
        arrises.push_back(x);
    }
    std::unordered_map<size_t, std::vector<std::pair<int, int>>> endsAt;
    for (size_t xi = 0; xi < arrises.size(); ++xi) for (int e = 0; e < 2; ++e) { long cx, cy; corner(steps[arrises[xi].st], e, cx, cy); endsAt[gk(cx, cy)].push_back({static_cast<int>(xi), e}); }
    for (size_t xi = 0; xi < arrises.size(); ++xi) for (int e = 0; e < 2; ++e) {
        Arris& x = arrises[xi];
        const Step& xs = steps[x.st];
        long cx, cy;
        corner(xs, e, cx, cy);
        std::vector<std::pair<int, int>> others;
        for (const auto& p : endsAt[gk(cx, cy)]) if (p.first != static_cast<int>(xi)) others.push_back(p);
        const double sigma = e ? -1 : 1;
        bool flush = false;
        for (const auto& p : others) { const Step& os = steps[arrises[static_cast<size_t>(p.first)].st]; if (os.dir == xs.dir && os.L == xs.L && os.R == xs.R) flush = true; }
        if (flush) { x.kind[e] = 0; continue; }
        if (others.size() != 1) continue;
        const Arris& o = arrises[static_cast<size_t>(others[0].first)];
        const int oe = others[0].second;
        const double so = oe ? -1 : 1;
        if (steps[o.st].dir == xs.dir || o.front != x.front || o.back != x.back) continue;
        if (o.into == sigma && x.into == so) { x.kind[e] = 2; x.backEnd[e] = o.inset; x.partner[e] = others[0].first; x.partnerEnd[e] = oe; continue; }
        if (o.into != -sigma || x.into != -so) continue;
        const long da = xs.dir == 0 ? (x.into > 0 ? cx : cx - 1) : (-sigma > 0 ? cx : cx - 1), db = xs.dir == 0 ? (-sigma > 0 ? cy : cy - 1) : (x.into > 0 ? cy : cy - 1);
        if (!isBuilt(da, db) || D[at(da, db)] != x.back) continue;
        x.kind[e] = 3; x.backEnd[e] = o.inset; x.cutEnd[e] = o.inset; x.partner[e] = others[0].first; x.partnerEnd[e] = oe;
    }
    const auto capEnd = [&](Arris& x, int e) { const Step& st = steps[x.st]; const auto& A = alongOf(st.dir); x.kind[e] = 1; x.backEnd[e] = x.cutEnd[e] = e ? A[static_cast<size_t>(st.to + 1)] : A[static_cast<size_t>(st.from)]; x.partner[e] = -1; };
    for (size_t xi = 0; xi < arrises.size(); ++xi) {
        if (arrises[xi].backEnd[0] < arrises[xi].backEnd[1]) continue;
        for (int e = 0; e < 2; ++e) { const int p = arrises[xi].partner[e], pe = arrises[xi].partnerEnd[e]; if (p >= 0) capEnd(arrises[static_cast<size_t>(p)], pe); capEnd(arrises[xi], e); }
    }
    // the feet: points on lines (dir 0: s = v, 1: t = v) at a depth (-0 is 0, as JavaScript's keys have it)
    struct FootKey { int dir; uint64_t v, d; bool operator==(const FootKey& o) const { return dir == o.dir && v == o.v && d == o.d; } };
    struct FootHash { size_t operator()(const FootKey& k) const { return static_cast<size_t>((k.v * 1099511628211ull) ^ (k.d * 14695981039346656037ull) ^ static_cast<uint64_t>(k.dir)); } };
    const auto bits = [](double v) { if (v == 0) v = 0; uint64_t b; std::memcpy(&b, &v, 8); return b; };
    std::unordered_map<FootKey, std::vector<double>, FootHash> feet;
    const auto footKey = [&](int dir, double v, double d) { return FootKey{dir, bits(v), bits(d)}; };
    for (const Arris& x : arrises) {
        const Step& st = steps[x.st];
        const double lo = js::min(x.backEnd[0], x.backEnd[1]), hi = js::max(x.backEnd[0], x.backEnd[1]);
        const auto& A = alongOf(st.dir);
        auto& pts = feet[footKey(st.dir, x.inset, x.back)];
        pts.push_back(lo); pts.push_back(hi);
        for (size_t i = 0; i < A.size(); ++i) if (A[i] > lo && A[i] < hi && junction[st.dir == 0 ? i * static_cast<size_t>(G) + static_cast<size_t>(st.line) : static_cast<size_t>(st.line * G) + i]) pts.push_back(A[i]);
    }
    std::vector<std::vector<int>> zones(faces.size());
    for (size_t xi = 0; xi < arrises.size(); ++xi) {
        Arris& x = arrises[xi];
        const Step& st = steps[x.st];
        const double lo = js::min(x.l, x.inset), hi = js::max(x.l, x.inset);
        x.z = st.dir == 0 ? std::array<double, 4>{lo, x.cutEnd[0], hi, x.cutEnd[1]} : std::array<double, 4>{x.cutEnd[0], lo, x.cutEnd[1], hi};
        for (long i = st.from - (x.kind[0] == 3 ? 1 : 0); i <= st.to + (x.kind[1] == 3 ? 1 : 0); ++i) {
            const long a = st.dir == 0 ? (x.into > 0 ? st.line : st.line - 1) : i, b = st.dir == 0 ? i : (x.into > 0 ? st.line : st.line - 1);
            if (!isBuilt(a, b) || D[at(a, b)] != x.back) continue;
            auto& l = zones[static_cast<size_t>(faceOf[at(a, b)])];
            if (std::find(l.begin(), l.end(), static_cast<int>(xi)) == l.end()) l.push_back(static_cast<int>(xi));
        }
        for (double sv : {x.z[0], x.z[2]}) for (double tv : {x.z[1], x.z[3]}) { feet[footKey(0, sv, x.back)].push_back(tv); feet[footKey(1, tv, x.back)].push_back(sv); }
    }
    for (auto& kv : feet) { auto& v = kv.second; std::sort(v.begin(), v.end()); v.erase(std::unique(v.begin(), v.end()), v.end()); }
    const auto feetOf = [&](int dir, double v, double d) -> const std::vector<double>* { const auto it = feet.find(footKey(dir, v, d)); return it == feet.end() ? nullptr : &it->second; };
    // 5. the triangles, as corner records, welded after
    using Pt = std::array<double, 3>;
    std::vector<std::array<double, 8>> tri;
    const Vec3 &C = f.centroid, &Nv = f.normal, &S = f.axisS, &T = f.axisT;
    const Vec3 negS{-S[0], -S[1], -S[2]}, negT{-T[0], -T[1], -T[2]};
    const auto world = [&](const Pt& p) { return Vec3{C[0] + p[0] * S[0] + p[1] * T[0] + p[2] * Nv[0], C[1] + p[0] * S[1] + p[1] * T[1] + p[2] * Nv[1], C[2] + p[0] * S[2] + p[1] * T[2] + p[2] * Nv[2]}; };
    const auto unit = [](const Vec3& v) { const double l = js::hypot({v[0], v[1], v[2]}); return Vec3{v[0] / l, v[1] / l, v[2] / l}; };
    // mode 0: the plane's frame; 1: unfolded along s (a step on an s line); 2: along t
    const auto emit = [&](const std::vector<std::array<Pt, 3>>& out, const Vec3& n, int mode, double into, double front) {
        for (const auto& q : out) {
            const Vec3 w[3] = {world(q[0]), world(q[1]), world(q[2])};
            const Vec3 e1{w[1][0] - w[0][0], w[1][1] - w[0][1], w[1][2] - w[0][2]}, e2{w[2][0] - w[0][0], w[2][1] - w[0][1], w[2][2] - w[0][2]};
            const Vec3 g{e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]};
            const int order[3] = {0, dot(g, n) < 0 ? 2 : 1, dot(g, n) < 0 ? 1 : 2};
            for (int o : order) {
                const Pt& p = q[static_cast<size_t>(o)];
                const double us = mode == 1 ? p[0] + into * (front - p[2]) : p[0], ut = mode == 2 ? p[1] + into * (front - p[2]) : p[1];
                tri.push_back({w[o][0], w[o][1], w[o][2], n[0], n[1], n[2], (us - f.orthoSMin) / Wm, (f.orthoTMax - ut) / Hm});
            }
        }
    };
    const auto poly = [&](const std::vector<Pt>& bottom, const std::vector<Pt>& right, const std::vector<Pt>& top, const std::vector<Pt>& left, const Vec3& n, int mode, double into, double front) {
        std::vector<std::array<Pt, 3>> out;
        const auto zip = [&](const std::vector<Pt>& A, const std::vector<Pt>& B, int axis) {
            size_t i = 0, j = 0;
            while (i < A.size() - 1 || j < B.size() - 1) {
                if (j >= B.size() - 1 || (i < A.size() - 1 && A[i + 1][static_cast<size_t>(axis)] <= B[j + 1][static_cast<size_t>(axis)])) { out.push_back({A[i], B[j], A[i + 1]}); i++; }
                else { out.push_back({A[i], B[j], B[j + 1]}); j++; }
            }
        };
        if (left.size() == 2 && right.size() == 2) zip(bottom, top, bottom.front()[0] != bottom.back()[0] ? 0 : bottom.front()[1] != bottom.back()[1] ? 1 : 2);
        else if (bottom.size() == 2 && top.size() == 2) zip(left, right, left.front()[1] != left.back()[1] ? 1 : left.front()[0] != left.back()[0] ? 0 : 2);
        else {
            std::vector<Pt> ring;
            for (size_t i = 0; i + 1 < bottom.size(); ++i) ring.push_back(bottom[i]);
            for (size_t i = 0; i + 1 < right.size(); ++i) ring.push_back(right[i]);
            for (size_t i = top.size() - 1; i > 0; --i) ring.push_back(top[i]);
            for (size_t i = left.size() - 1; i > 0; --i) ring.push_back(left[i]);
            const Pt &a = bottom.front(), &c = top.back();
            const Pt mid{(a[0] + c[0]) / 2, (a[1] + c[1]) / 2, (a[2] + c[2]) / 2};
            for (size_t i = 0; i < ring.size(); ++i) out.push_back({mid, ring[i], ring[(i + 1) % ring.size()]});
        }
        emit(out, n, mode, into, front);
    };
    const auto withFeet = [&](std::vector<double> vals, int dir, double v, double d) {
        const auto* ft = feetOf(dir, v, d);
        if (!ft) return vals;
        const double lo = vals.front(), hi = vals.back();
        bool any = false;
        for (double w : *ft) if (w > lo && w < hi) { vals.push_back(w); any = true; }
        if (any) { std::sort(vals.begin(), vals.end()); vals.erase(std::unique(vals.begin(), vals.end()), vals.end()); }
        return vals;
    };
    const auto alongS = [&](long b, long a0, long a1, double d) {
        std::vector<double> o;
        for (long x = a0; x <= a1; ++x) if (x == a0 || x == a1 || junction[gk(x, b)]) o.push_back(s[static_cast<size_t>(x)]);
        std::vector<Pt> p;
        for (double v : withFeet(o, 1, t[static_cast<size_t>(b)], d)) p.push_back({v, t[static_cast<size_t>(b)], d});
        return p;
    };
    const auto alongT = [&](long a, long b0, long b1, double d) {
        std::vector<double> o;
        for (long y = b0; y <= b1; ++y) if (y == b0 || y == b1 || junction[gk(a, y)]) o.push_back(t[static_cast<size_t>(y)]);
        std::vector<Pt> p;
        for (double v : withFeet(o, 0, s[static_cast<size_t>(a)], d)) p.push_back({s[static_cast<size_t>(a)], v, d});
        return p;
    };
    std::map<double, long> sIndex, tIndex;
    for (size_t i = 0; i < s.size(); ++i) sIndex.emplace(s[i], static_cast<long>(i));
    for (size_t i = 0; i < t.size(); ++i) tIndex.emplace(t[i], static_cast<long>(i));
    int cutFaces = 0;
    const auto cutFace = [&](const std::array<long, 4>& q, double d, const std::vector<int>& zl) {
        const double S0 = s[static_cast<size_t>(q[0])], S1 = s[static_cast<size_t>(q[2] + 1)], T0 = t[static_cast<size_t>(q[1])], T1 = t[static_cast<size_t>(q[3] + 1)];
        std::vector<double> xs{S0, S1}, ys{T0, T1};
        for (int zi : zl) {
            const auto& z = arrises[static_cast<size_t>(zi)].z;
            for (double v : {z[0], z[2]}) if (v > S0 && v < S1) xs.push_back(v);
            for (double v : {z[1], z[3]}) if (v > T0 && v < T1) ys.push_back(v);
        }
        std::sort(xs.begin(), xs.end()); xs.erase(std::unique(xs.begin(), xs.end()), xs.end());
        std::sort(ys.begin(), ys.end()); ys.erase(std::unique(ys.begin(), ys.end()), ys.end());
        const size_t nx = xs.size() - 1, ny = ys.size() - 1, X = nx + 1;
        std::vector<uint8_t> open(nx * ny);
        bool any = false;
        for (size_t j = 0; j < ny; ++j) for (size_t i = 0; i < nx; ++i) {
            const double cx = (xs[i] + xs[i + 1]) / 2, cy = (ys[j] + ys[j + 1]) / 2;
            bool in = false;
            for (int zi : zl) { const auto& z = arrises[static_cast<size_t>(zi)].z; if (cx > z[0] && cx < z[2] && cy > z[1] && cy < z[3]) { in = true; break; } }
            open[j * nx + i] = in ? 0 : 1;
            any = any || !in;
        }
        if (!any) return false;
        std::vector<uint8_t> used(nx * ny), cornerOf(X * (ny + 1));
        std::vector<std::array<size_t, 4>> rects;
        for (size_t j = 0; j < ny; ++j) for (size_t i = 0; i < nx; ++i) {
            if (!open[j * nx + i] || used[j * nx + i]) continue;
            size_t i1 = i, j1 = j;
            while (i1 + 1 < nx && open[j * nx + i1 + 1] && !used[j * nx + i1 + 1]) i1++;
            for (;;) { if (j1 + 1 >= ny) break; bool row = true; for (size_t x = i; x <= i1 && row; ++x) row = open[(j1 + 1) * nx + x] && !used[(j1 + 1) * nx + x]; if (!row) break; j1++; }
            for (size_t y = j; y <= j1; ++y) for (size_t x = i; x <= i1; ++x) used[y * nx + x] = 1;
            rects.push_back({i, j, i1, j1});
            cornerOf[j * X + i] = 1; cornerOf[j * X + i1 + 1] = 1; cornerOf[(j1 + 1) * X + i] = 1; cornerOf[(j1 + 1) * X + i1 + 1] = 1;
        }
        const auto side = [&](bool horizontal, size_t atk, size_t k0, size_t k1) {
            const auto& A = horizontal ? xs : ys;
            const double lo = A[k0], hi = A[k1];
            std::vector<double> v;
            for (size_t k = k0; k <= k1; ++k) if (k == k0 || k == k1 || cornerOf[horizontal ? atk * X + k : k * X + atk]) v.push_back(A[k]);
            const double c = horizontal ? ys[atk] : xs[atk];
            const auto& idx = horizontal ? tIndex : sIndex;
            const auto li = idx.find(c);
            const auto& L = horizontal ? s : t;
            if (li != idx.end()) for (size_t k = 0; k < L.size(); ++k) if (L[k] > lo && L[k] < hi && junction[horizontal ? static_cast<size_t>(li->second * G) + k : k * static_cast<size_t>(G) + static_cast<size_t>(li->second)]) v.push_back(L[k]);
            if (const auto* ft = feetOf(horizontal ? 1 : 0, c, d)) for (double w : *ft) if (w > lo && w < hi) v.push_back(w);
            std::sort(v.begin(), v.end()); v.erase(std::unique(v.begin(), v.end()), v.end());
            std::vector<Pt> p;
            for (double w : v) p.push_back(horizontal ? Pt{w, c, d} : Pt{c, w, d});
            return p;
        };
        for (const auto& r : rects) poly(side(true, r[1], r[0], r[2] + 1), side(false, r[2] + 1, r[1], r[3] + 1), side(true, r[3] + 1, r[0], r[2] + 1), side(false, r[0], r[1], r[3] + 1), Nv, 0, 0, 0);
        cutFaces++;
        return true;
    };
    for (size_t fi = 0; fi < faces.size(); ++fi) {
        const auto& q = faces[fi];
        const double d = D[at(q[0], q[1])];
        if (!zones[fi].empty() && cutFace(q, d, zones[fi])) continue;
        poly(alongS(q[1], q[0], q[2] + 1, d), alongT(q[2] + 1, q[1], q[3] + 1, d), alongS(q[3] + 1, q[0], q[2] + 1, d), alongT(q[0], q[1], q[3] + 1, d), Nv, 0, 0, 0);
    }
    const auto chain = [&](long x, long y, double lo, double hi) {
        std::vector<double> mid;
        for (double v : met[gk(x, y)]) if (v > lo && v < hi) mid.push_back(v);
        std::sort(mid.begin(), mid.end());
        std::vector<double> o{lo};
        o.insert(o.end(), mid.begin(), mid.end());
        o.push_back(hi);
        return o;
    };
    const auto footOn = [&](int dir, double v, double d, double b0, double b1) { std::vector<double> o; if (const auto* ft = feetOf(dir, v, d)) for (double w : *ft) if (w >= b0 && w <= b1) o.push_back(w); return o; };
    int chamfered = 0;
    for (size_t si = 0; si < steps.size(); ++si) {
        const Step& st = steps[si];
        const double L = st.L, R = st.R, c = st.c, front = js::max(L, R), back = js::min(L, R), into = L < R ? -1 : 1;
        if (st.dir == 0) {
            const double sv = s[static_cast<size_t>(st.line)], t0 = t[static_cast<size_t>(st.from)], t1 = t[static_cast<size_t>(st.to + 1)], sb = sv + into * c;
            const Vec3& n = L > R ? S : negS;
            if (!c) {
                std::vector<Pt> e0, e1;
                for (double d : chain(st.line, st.from, back, front)) e0.push_back({sv, t0, d});
                for (double d : chain(st.line, st.to + 1, back, front)) e1.push_back({sv, t1, d});
                poly(alongT(st.line, st.from, st.to + 1, back), e1, alongT(st.line, st.from, st.to + 1, front), e0, n, 1, into, front);
                continue;
            }
            chamfered++;
            const Arris& x = arrises[static_cast<size_t>(arrisOf[si])];
            const double b0 = x.backEnd[0], b1 = x.backEnd[1];
            std::vector<Pt> foot;
            for (double v : footOn(0, sb, back, b0, b1)) foot.push_back({sv + into * c, v, back});
            poly(alongT(st.line, st.from, st.to + 1, front), {{sv, t1, front}, {sb, b1, front - c}}, {{sb, b0, front - c}, {sb, b1, front - c}}, {{sv, t0, front}, {sb, b0, front - c}}, unit({Nv[0] + into * S[0], Nv[1] + into * S[1], Nv[2] + into * S[2]}), 1, into, front);
            poly(foot, {{sb, b1, back}, {sb, b1, front - c}}, {{sb, b0, front - c}, {sb, b1, front - c}}, {{sb, b0, back}, {sb, b0, front - c}}, n, 1, into, front);
            for (int e = 0; e < 2; ++e) {
                if (x.kind[e] != 1) continue;
                const double tv = e ? t1 : t0;
                std::vector<Pt> ch;
                for (double d : chain(st.line, e ? st.to + 1 : st.from, back, front)) ch.push_back({sv, tv, d});
                poly({{sv, tv, back}, {sb, tv, back}}, {{sb, tv, back}, {sb, tv, front - c}}, {{sv, tv, front}, {sb, tv, front - c}}, ch, e ? T : negT, 1, into, front);
            }
        } else {
            const double tv = t[static_cast<size_t>(st.line)], s0 = s[static_cast<size_t>(st.from)], s1 = s[static_cast<size_t>(st.to + 1)], tb = tv + into * c;
            const Vec3& n = L > R ? T : negT;
            if (!c) {
                std::vector<Pt> e0, e1;
                for (double d : chain(st.from, st.line, back, front)) e0.push_back({s0, tv, d});
                for (double d : chain(st.to + 1, st.line, back, front)) e1.push_back({s1, tv, d});
                poly(alongS(st.line, st.from, st.to + 1, back), e1, alongS(st.line, st.from, st.to + 1, front), e0, n, 2, into, front);
                continue;
            }
            chamfered++;
            const Arris& x = arrises[static_cast<size_t>(arrisOf[si])];
            const double b0 = x.backEnd[0], b1 = x.backEnd[1];
            std::vector<Pt> foot;
            for (double v : footOn(1, tb, back, b0, b1)) foot.push_back({v, tb, back});
            poly(alongS(st.line, st.from, st.to + 1, front), {{s1, tv, front}, {b1, tb, front - c}}, {{b0, tb, front - c}, {b1, tb, front - c}}, {{s0, tv, front}, {b0, tb, front - c}}, unit({Nv[0] + into * T[0], Nv[1] + into * T[1], Nv[2] + into * T[2]}), 2, into, front);
            poly(foot, {{b1, tb, back}, {b1, tb, front - c}}, {{b0, tb, front - c}, {b1, tb, front - c}}, {{b0, tb, back}, {b0, tb, front - c}}, n, 2, into, front);
            for (int e = 0; e < 2; ++e) {
                if (x.kind[e] != 1) continue;
                const double sv = e ? s1 : s0;
                std::vector<Pt> ch;
                for (double d : chain(e ? st.to + 1 : st.from, st.line, back, front)) ch.push_back({sv, tv, d});
                poly({{sv, tv, back}, {sv, tb, back}}, {{sv, tb, back}, {sv, tb, front - c}}, {{sv, tv, front}, {sv, tb, front - c}}, ch, e ? S : negS, 2, into, front);
            }
        }
    }
    // 6. welded: one vertex per position, normal and UV as stored (32 bits; -0 is 0, as JavaScript's keys have it)
    struct KeyHash { size_t operator()(const std::array<uint32_t, 8>& k) const { uint64_t h = 1469598103934665603ull; for (uint32_t v : k) { h ^= v; h *= 1099511628211ull; } return static_cast<size_t>(h); } };
    std::unordered_map<std::array<uint32_t, 8>, uint32_t, KeyHash> ids;
    ids.reserve(tri.size());
    res.positions.clear(); res.normals.clear(); res.uv.clear(); res.indices.clear();
    res.indices.reserve(tri.size());
    for (const auto& v : tri) {
        std::array<float, 8> q;
        std::array<uint32_t, 8> key;
        for (size_t k = 0; k < 8; ++k) { q[k] = static_cast<float>(v[k]); const float z = q[k] == 0.0f ? 0.0f : q[k]; std::memcpy(&key[k], &z, 4); }
        const auto [it, fresh] = ids.emplace(key, static_cast<uint32_t>(res.positions.size() / 3));
        if (fresh) { res.positions.insert(res.positions.end(), {q[0], q[1], q[2]}); res.normals.insert(res.normals.end(), {q[3], q[4], q[5]}); res.uv.insert(res.uv.end(), {q[6], q[7]}); }
        res.indices.push_back(it->second);
    }
    int cells = 0, mitres = 0, caps = 0;
    for (uint8_t v : built) cells += v;
    for (const Arris& x : arrises) for (int e = 0; e < 2; ++e) { if (x.kind[e] >= 2) mitres++; if (x.kind[e] == 1) caps++; }
    const int report[9] = {cells, static_cast<int>(faces.size()), static_cast<int>(steps.size()), chamfered, cutFaces, mitres, caps, static_cast<int>(res.indices.size() / 3), static_cast<int>(res.positions.size() / 3)};
    std::copy(std::begin(report), std::end(report), res.surface);
}

/** latticeFacade, with the scan's (and the raw scan's) samples drawn first. */
inline LatticeResult latticeFacade(const Frame& f, const Image& img, const std::vector<double>& samples, const Params& P, const std::vector<uint8_t>* uncovered, bool photoRecess,
                                   const std::vector<Rect>& fitted, bool hasRecess, double recessM, const std::vector<Rect>* bays, const std::vector<double>* reliefSamples, bool buildWhereMeasured) {
    LatticeResult res;
    const std::vector<Rect> strips = photoRecess ? (bays ? *bays : (!fitted.empty() ? windowStrips(fitted, P) : std::vector<Rect>{})) : std::vector<Rect>{};
    std::vector<Rect> lines = fitted;
    lines.insert(lines.end(), strips.begin(), strips.end());
    const std::vector<double> L = luminance(img);
    std::vector<double> s, t;
    photoLattice(img, L, f, P, s, t);
    if (!lines.empty()) {
        std::vector<double> fs, ft;
        for (const Rect& w : lines) { fs.push_back(w[0]); fs.push_back(w[2]); ft.push_back(w[1]); ft.push_back(w[3]); }
        s = mergeLines(s, fs, f.sMin, f.sMax, P.minLineGapM);
        t = mergeLines(t, ft, f.tMin, f.tMax, P.minLineGapM);
    }
    if (s.size() < 2 || t.size() < 2) return res;
    const size_t ns = s.size() - 1, nt = t.size() - 1, N = ns * nt;
    const int W = img.W, H = img.H;
    // the photo's mean luminance per cell, and whether the photo covers it
    std::vector<double> lum(N, kNaN);
    std::vector<uint8_t> built(N);
    for (size_t b = 0; b < nt; ++b) for (size_t a = 0; a < ns; ++a) {
        double sum = 0;
        long n = 0, all = 0;
        const double x0 = js::max(0, std::floor((s[a] - f.orthoSMin) / f.pixel)), x1 = js::min(W, std::ceil((s[a + 1] - f.orthoSMin) / f.pixel));
        const double y0 = js::max(0, std::floor((f.orthoTMax - t[b + 1]) / f.pixel)), y1 = js::min(H, std::ceil((f.orthoTMax - t[b]) / f.pixel));
        for (double y = y0; y < y1; ++y) for (double x = x0; x < x1; ++x) {
            const size_t k = static_cast<size_t>(y) * W + static_cast<size_t>(x);
            const uint8_t* q = &img.rgba[k * 4];
            all++;
            if (q[3] && !(uncovered ? (*uncovered)[k] != 0 : (q[0] == 128 && q[1] == 128 && q[2] == 128))) { sum += 0.3 * q[0] + 0.59 * q[1] + 0.11 * q[2]; n++; }
        }
        if (n) lum[b * ns + a] = sum / static_cast<double>(n);
        if (all && static_cast<double>(n) >= P.minCellPhotoShare * static_cast<double>(all)) built[b * ns + a] = 1;
    }
    const std::vector<double> raw = cellMedians(samples, s, t, P.minSamples);
    // the wall's outline: each row from its first to its last texel the photo reached
    std::vector<std::array<int, 2>> rowSpan(static_cast<size_t>(H));
    for (int y = 0; y < H; ++y) {
        if (!uncovered) { rowSpan[static_cast<size_t>(y)] = {0, W - 1}; continue; }
        int a = -1, b = -1;
        for (int x = 0; x < W; ++x) { const size_t k = static_cast<size_t>(y) * W + x; if (!(*uncovered)[k] && img.rgba[k * 4 + 3]) { if (a < 0) a = x; b = x; } }
        rowSpan[static_cast<size_t>(y)] = {a, b};
    }
    const auto inOutline = [&](size_t a, size_t b) {
        const double cx = std::floor(((s[a] + s[a + 1]) / 2 - f.orthoSMin) / f.pixel), cy = std::floor((f.orthoTMax - (t[b] + t[b + 1]) / 2) / f.pixel);
        const auto& span = rowSpan[static_cast<size_t>(js::min(H - 1, js::max(0, cy)))];
        return span[0] >= 0 && cx >= span[0] && cx <= span[1];
    };
    double measuredArea = 0, outlineArea = 0;
    for (size_t b = 0; b < nt; ++b) for (size_t a = 0; a < ns; ++a) {
        if (!inOutline(a, b)) continue;
        const double A = (s[a + 1] - s[a]) * (t[b + 1] - t[b]);
        outlineArea += A;
        if (finite(raw[b * ns + a])) measuredArea += A;
    }
    const double measured = outlineArea > 0 ? measuredArea / outlineArea : 0;
    if (!(measured >= P.minMeasuredShare)) return res;
    if (buildWhereMeasured && uncovered) for (size_t b = 0; b < nt; ++b) for (size_t a = 0; a < ns; ++a) {
        const size_t k = b * ns + a;
        if (!built[k] && finite(raw[k]) && inOutline(a, b)) built[k] = 1;
    }
    for (size_t k = 0; k < N; ++k) if (built[k] && finite(raw[k]) && raw[k] < P.minDepthM) built[k] = 0;
    const std::vector<uint8_t> win = !fitted.empty() ? fittedCells(s, t, fitted) : windowGrid(lum, ns, nt, P);
    const bool hasStrip = !strips.empty();
    const std::vector<uint8_t> strip = hasStrip ? fittedCells(s, t, strips) : std::vector<uint8_t>{};
    std::vector<double> depth;
    depth.reserve(N);
    std::vector<double> rowMeds;
    int photoRecessCells = 0, stripCells = 0;
    std::vector<uint8_t> windows(N);
    const auto clamp = [&](double v) { return js::min(P.maxDepthM, js::max(P.minDepthM, v)); };
    double stripR = kNaN;
    if (hasStrip) {
        std::vector<double> wl, ol;
        for (size_t k = 0; k < N; ++k) if (!strip[k] && !win[k] && finite(lum[k])) wl.push_back(lum[k]);
        for (size_t k = 0; k < N; ++k) if (win[k] && finite(lum[k])) ol.push_back(lum[k]);
        const double wallLum = median(std::move(wl)), openLum = median(std::move(ol));
        stripR = wallLum > 0 && finite(openLum) ? (hasRecess ? recessM : photoRecessDepth(1 - openLum / wallLum, P)) : kNaN;
    }
    if (hasStrip) {
        res.hasStructure = true;
        res.structureCells.assign(N, 0);
        for (size_t k = 0; k < N; ++k) res.structureCells[k] = built[k] && !strip[k] && !win[k] ? 1 : 0;
        const std::vector<double> rawR = reliefSamples ? cellMedians(*reliefSamples, s, t, P.minSamples) : raw;
        struct Stat { bool ok; double m, se; };
        const auto stat = [&](auto keep) -> Stat {
            std::vector<double> v;
            for (size_t k = 0; k < N; ++k) if (keep(k) && finite(rawR[k])) v.push_back(rawR[k]);
            if (static_cast<double>(v.size()) < P.minSamples) return {false, 0, 0};
            const double m = median(v);
            std::vector<double> dev;
            for (double x : v) dev.push_back(std::abs(x - m));
            const double mad = median(std::move(dev));
            return {true, m, (1.4826 * mad) / std::sqrt(static_cast<double>(v.size()))};
        };
        const Stat pier = stat([&](size_t k) { return !strip[k] && !win[k]; }), bay = stat([&](size_t k) { return strip[k] && !win[k]; });
        const double diff = pier.ok && bay.ok ? pier.m - bay.m : kNaN, se = pier.ok && bay.ok ? js::hypot({pier.se, bay.se}) : kNaN;
        const std::string scan = finite(diff) ? cm(diff) + " +- " + cm(se) + " cm" : "too few samples";
        if (diff >= P.minReliefM && diff >= 2 * se) {
            res.reliefM = diff; res.reliefFrom = "measured";
            res.reason = "the scan's piers " + cm(diff) + " cm proud of its bays (median of each, +-" + cm(se) + " cm)";
        } else if (!std::isnan(stripR)) {
            res.reliefM = stripR; res.reliefFrom = "photo-inferred";
            res.reason = "the scan resolves no pier-to-bay depth (" + scan + "); " + (hasRecess ? "Street View's window reveals" : "the photometric relief's contrast rule") + " gives " + cm(stripR) + " cm";
        } else {
            res.reliefM = P.defaultReliefM; res.reliefFrom = "generated";
            res.reason = "neither the scan (" + scan + ") nor the photo's contrast gives a pier-to-bay depth; a plausible " + js::toString(P.defaultReliefM * 100) + " cm";
        }
        stripR = res.reliefM;
    }
    for (size_t b = 0; b < nt; ++b) {
        std::vector<double> rowRaw;
        for (size_t a = 0; a < ns; ++a) if (finite(raw[b * ns + a])) rowRaw.push_back(raw[b * ns + a]);
        const double rowMed = median(std::move(rowRaw));
        rowMeds.push_back(rowMed);
        if (hasStrip) {
            std::vector<double> w0;
            for (size_t a = 0; a < ns; ++a) { const size_t k = b * ns + a; if (!strip[k] && !win[k] && finite(raw[k])) w0.push_back(raw[k]); }
            const double wall0 = median(std::move(w0)), wall = finite(wall0) ? wall0 : finite(rowMed) ? rowMed : 0;
            for (size_t a = 0; a < ns; ++a) { const size_t k = b * ns + a; if (win[k] && built[k]) windows[k] = 1; }
            for (size_t a = 0; a < ns; ++a) {
                const size_t k = b * ns + a;
                if (std::isnan(stripR) || !(strip[k] || win[k])) { depth.push_back(clamp(wall)); continue; }
                if (built[k]) { stripCells++; if (win[k]) photoRecessCells++; }
                depth.push_back(clamp(win[k] ? js::min(wall - stripR - P.stripWindowInsetM, finite(raw[k]) ? raw[k] : kInf) : wall - stripR));
            }
            continue;
        }
        std::vector<size_t> dark, light;
        for (size_t a = 0; a < ns; ++a) (win[b * ns + a] ? dark : light).push_back(b * ns + a);
        const auto finiteOf = [&](const std::vector<size_t>& ks, const std::vector<double>& v) { std::vector<double> o; for (size_t k : ks) if (finite(v[k])) o.push_back(v[k]); return o; };
        double dm = median(finiteOf(dark, raw));
        const double lm = median(finiteOf(light, raw));
        bool recessed = false;
        if (static_cast<double>(dark.size()) >= P.recessMinRepeats) {
            const double wall = finite(lm) ? lm : rowMed, wallLum = median(finiteOf(light, lum));
            std::vector<double> darkLum;
            for (size_t k : dark) darkLum.push_back(lum[k]);
            const double contrast = wallLum > 0 ? 1 - medianJs(std::move(darkLum)) / wallLum : 0;
            for (size_t k : dark) if (built[k]) windows[k] = 1;
            const double r = photoRecess && wallLum > 0 && finite(wall) ? (hasRecess ? recessM : photoRecessDepth(contrast, P)) : kNaN;
            if (!std::isnan(r) && !(dm <= wall - r)) { dm = wall - r; recessed = true; }
        }
        for (size_t a = 0; a < ns; ++a) {
            const size_t k = b * ns + a;
            const double v = win[k] ? dm : lm;
            depth.push_back(clamp(finite(v) ? v : finite(rowMed) ? rowMed : 0));
        }
        if (recessed) for (size_t k : dark) if (built[k]) photoRecessCells++;
    }
    // where the scan stands beside a rebuilt cell (a neighbour left as scan): its measured depth, else its row's; NaN when the
    // scan measures nothing there, or another surface further behind than any recess
    std::vector<double> scan(ns * nt);
    for (size_t k = 0; k < ns * nt; ++k) { const double v = raw[k], m = rowMeds[k / ns]; scan[k] = finite(v) ? (v < P.minDepthM ? kNaN : clamp(v)) : finite(m) ? clamp(m) : kNaN; }
    int cells = 0;
    for (uint8_t v : built) cells += v;
    if (!cells) return res;
    latticeSurface(f, W * f.pixel, H * f.pixel, s, t, built, depth, scan, res.hasStructure, P, res);
    res.ok = true;
    res.cells = cells;
    res.measuredShare = js::round(measured * 1000) / 1000;
    res.hasPhotoRecess = photoRecess;
    res.photoRecessCells = photoRecessCells;
    res.strips = strips;
    res.stripCells = stripCells;
    res.depth = std::move(depth);
    res.built = std::move(built);
    res.windows = std::move(windows);
    for (double v : s) res.cellU.push_back((v - f.orthoSMin) / (W * f.pixel));
    for (double v : t) res.cellV.push_back((f.orthoTMax - v) / (H * f.pixel));
    res.s = std::move(s);
    res.t = std::move(t);
    return res;
}

// --------------------------------------------------------------------------------------------- the repeat texture

/** sizeGroups: each rect joins the first group whose median size it matches within tol. */
inline std::vector<std::vector<size_t>> sizeGroups(const std::vector<Rect>& rects, double tol) {
    struct G { double w, h; std::vector<size_t> members; };
    std::vector<G> groups;
    for (size_t i = 0; i < rects.size(); ++i) {
        const Rect& r = rects[i];
        const double w = r[2] - r[0], h = r[3] - r[1];
        G* g = nullptr;
        for (G& x : groups) if (std::abs(x.w - w) <= tol * js::max(x.w, w) && std::abs(x.h - h) <= tol * js::max(x.h, h)) { g = &x; break; }
        if (g) {
            g->members.push_back(i);
            std::vector<double> ws, hs;
            for (size_t k : g->members) { ws.push_back(rects[k][2] - rects[k][0]); hs.push_back(rects[k][3] - rects[k][1]); }
            g->w = median(std::move(ws));
            g->h = median(std::move(hs));
        } else {
            groups.push_back({w, h, {i}});
        }
    }
    std::vector<std::vector<size_t>> out;
    for (auto& g : groups) out.push_back(std::move(g.members));
    return out;
}

/** repeatTexture: the facade photo redrawn from its repeats; `out` starts as the photo. */
inline RepeatResult repeatTexture(const Image& img, double pixelM, const std::vector<Rect>& windows, const std::vector<Rect>& strips, const std::vector<uint8_t>* uncovered, const Params& P, std::vector<uint8_t>& out) {
    const int W = img.W, H = img.H;
    const std::vector<uint8_t>& src = img.rgba;
    out = src;
    RepeatResult rep;
    const auto covered = [&](double x, double y) {
        if (!(x >= 0 && y >= 0 && x < W && y < H)) return false;
        const size_t k = static_cast<size_t>(y) * W + static_cast<size_t>(x);
        return src[k * 4 + 3] > 0 && !(uncovered && (*uncovered)[k]);
    };
    std::vector<Rect> spandrels;
    for (const Rect& st : strips) {
        std::vector<Rect> inside;
        for (const Rect& w : windows) if ((w[0] + w[2]) / 2 > st[0] && (w[0] + w[2]) / 2 < st[2] && w[1] >= st[1] - 1 && w[3] <= st[3] + 1) inside.push_back(w);
        js::sort(inside, [](const Rect& a, const Rect& b) { return a[1] - b[1]; });
        for (size_t i = 0; i + 1 < inside.size(); ++i) {
            const double top = inside[i][3], bottom = inside[i + 1][1];
            if (bottom - top >= P.rtMinSidePx && (bottom - top) * pixelM <= P.rtMaxSpandrelM) spandrels.push_back({st[0], top, st[2], bottom});
        }
    }
    const double edgeD = js::max(1, js::round(P.rtEdgeM / pixelM));
    const long edge = static_cast<long>(edgeD);
    rep.edge = edgeD;
    const auto draw = [&](const std::vector<Rect>& rects, bool snap, int& kind) {
        std::vector<Rect> usable;
        for (const Rect& r : rects) if (r[2] - r[0] >= P.rtMinSidePx && r[3] - r[1] >= P.rtMinSidePx) usable.push_back(r);
        for (const auto& members : sizeGroups(usable, P.rtSizeTol)) {
            if (static_cast<double>(members.size()) < P.rtMinRepeats) continue;
            std::vector<Rect> rs;
            for (size_t i : members) rs.push_back(usable[i]);
            std::vector<double> ws, hs;
            for (const Rect& r : rs) { ws.push_back(r[2] - r[0]); hs.push_back(r[3] - r[1]); }
            const long tw = static_cast<long>(js::max(P.rtMinSidePx, js::round(median(ws)))), th = static_cast<long>(js::max(P.rtMinSidePx, js::round(median(hs))));
            const auto at = [&](const Rect& r, long u, long v) {
                return std::array<double, 2>{std::floor(r[0] + ((u + 0.5) / static_cast<double>(tw)) * (r[2] - r[0])), std::floor(r[1] + ((v + 0.5) / static_cast<double>(th)) * (r[3] - r[1]))};
            };
            std::vector<float> tpl(static_cast<size_t>(tw * th * 3), std::numeric_limits<float>::quiet_NaN());
            std::vector<double> vals[3];
            for (long v = 0; v < th; ++v) for (long u = 0; u < tw; ++u) {
                for (auto& c : vals) c.clear();
                for (const Rect& r : rs) {
                    const auto p = at(r, u, v);
                    if (covered(p[0], p[1])) { const size_t i = (static_cast<size_t>(p[1]) * W + static_cast<size_t>(p[0])) * 4; for (int c = 0; c < 3; ++c) vals[c].push_back(src[i + c]); }
                }
                if (!vals[0].empty()) for (int c = 0; c < 3; ++c) tpl[static_cast<size_t>((v * tw + u) * 3 + c)] = static_cast<float>(median(vals[c]));
            }
            if (snap && tw > 4 * edge && th > 4 * edge) {
                const auto bandMedian = [&](long u0, long u1, long v0, long v1) {
                    std::array<double, 3> col{};
                    for (int c = 0; c < 3; ++c) {
                        std::vector<double> a;
                        for (long v = v0; v < v1; ++v) for (long u = u0; u < u1; ++u) { const double x = tpl[static_cast<size_t>((v * tw + u) * 3 + c)]; if (finite(x)) a.push_back(x); }
                        col[static_cast<size_t>(c)] = median(std::move(a));
                    }
                    return col;
                };
                const auto fill = [&](long u0, long u1, long v0, long v1, const std::array<double, 3>& col) {
                    if (!(finite(col[0]) && finite(col[1]) && finite(col[2]))) return;
                    for (long v = v0; v < v1; ++v) for (long u = u0; u < u1; ++u) for (int c = 0; c < 3; ++c) tpl[static_cast<size_t>((v * tw + u) * 3 + c)] = static_cast<float>(col[static_cast<size_t>(c)]);
                };
                fill(0, edge, 0, th, bandMedian(edge, 2 * edge, 0, th));
                fill(tw - edge, tw, 0, th, bandMedian(tw - 2 * edge, tw - edge, 0, th));
                fill(0, tw, 0, edge, bandMedian(0, tw, edge, 2 * edge));
                fill(0, tw, th - edge, th, bandMedian(0, tw, th - 2 * edge, th - edge));
            }
            for (const Rect& r : rs) {
                std::array<double, 3> own{}, cons{};
                bool hasOwn = false, hasCons = false;
                {
                    double sm[3] = {0, 0, 0};
                    long n = 0;
                    for (long v = 0; v < th; ++v) for (long u = 0; u < tw; ++u) {
                        const auto p = at(r, u, v);
                        if (!covered(p[0], p[1])) continue;
                        const size_t i = (static_cast<size_t>(p[1]) * W + static_cast<size_t>(p[0])) * 4;
                        sm[0] += src[i]; sm[1] += src[i + 1]; sm[2] += src[i + 2]; n++;
                    }
                    if (n) { hasOwn = true; for (int c = 0; c < 3; ++c) own[static_cast<size_t>(c)] = sm[c] / static_cast<double>(n); }
                }
                {
                    double sm[3] = {0, 0, 0};
                    long n = 0;
                    for (long v = 0; v < th; ++v) for (long u = 0; u < tw; ++u) {
                        const size_t k = static_cast<size_t>((v * tw + u) * 3);
                        if (!finite(tpl[k])) continue;
                        sm[0] += tpl[k]; sm[1] += tpl[k + 1]; sm[2] += tpl[k + 2]; n++;
                    }
                    if (n) { hasCons = true; for (int c = 0; c < 3; ++c) cons[static_cast<size_t>(c)] = sm[c] / static_cast<double>(n); }
                }
                std::array<double, 3> shade{0, 0, 0};
                if (hasOwn && hasCons) for (int c = 0; c < 3; ++c) shade[static_cast<size_t>(c)] = js::max(-P.rtMaxShade, js::min(P.rtMaxShade, P.rtKeepShade * (own[static_cast<size_t>(c)] - cons[static_cast<size_t>(c)])));
                const double ys = js::max(0, std::floor(r[1])), ye = js::min(H, std::ceil(r[3])), xs = js::max(0, std::floor(r[0])), xe = js::min(W, std::ceil(r[2]));
                for (double y = ys; y < ye; ++y) for (double x = xs; x < xe; ++x) {
                    const double u = js::min(static_cast<double>(tw - 1), js::max(0, std::floor(((x + 0.5 - r[0]) / (r[2] - r[0])) * static_cast<double>(tw))));
                    const double v = js::min(static_cast<double>(th - 1), js::max(0, std::floor(((y + 0.5 - r[1]) / (r[3] - r[1])) * static_cast<double>(th))));
                    const size_t k = static_cast<size_t>((static_cast<long>(v) * tw + static_cast<long>(u)) * 3);
                    if (!finite(tpl[k])) continue;
                    const size_t i = (static_cast<size_t>(y) * W + static_cast<size_t>(x)) * 4;
                    for (int c = 0; c < 3; ++c) out[i + static_cast<size_t>(c)] = js::toUint8(js::max(0, js::min(255, js::round(static_cast<double>(tpl[k + static_cast<size_t>(c)]) + shade[static_cast<size_t>(c)]))));
                    out[i + 3] = 255;
                    rep.texels++;
                    if (!covered(x, y)) rep.filled++;
                }
            }
            rep.groups++;
            kind += static_cast<int>(rs.size());
        }
    };
    draw(spandrels, false, rep.spandrels);
    draw(windows, true, rep.windows);
    return rep;
}

/** One facade of rebuildFacadesOnLattice: decoded, sampled, latticed and, with strips and windows, retextured. */
inline FacadeOut rebuildFacade(const FacadeJob& job, const std::vector<float>& soup, const std::vector<float>* rawSoup, const Params& P, bool photoRecess, bool whole) {
    FacadeOut o;
    const Image img = readPng(job.image);
    o.W = img.W;
    o.H = img.H;
    std::vector<uint8_t> maskStore;
    const std::vector<uint8_t>* mask = nullptr;
    if (!job.mask.empty()) {
        const Image m = readPng(job.mask);
        // a mask smaller than the photo reads as covered past its end, as an undefined element does in JavaScript
        maskStore.assign(std::max(static_cast<size_t>(m.W) * m.H, static_cast<size_t>(img.W) * img.H), 0);
        for (size_t k = 0; k < static_cast<size_t>(m.W) * m.H; ++k) maskStore[k] = m.rgba[k * 4] > 127 ? 1 : 0;
        mask = &maskStore;
    }
    const std::vector<double> samples = facadeSamples(soup, job.f, P);
    std::vector<double> relief;
    if (rawSoup) relief = facadeSamples(*rawSoup, job.f, P);
    o.r = latticeFacade(job.f, img, samples, P, mask, photoRecess, job.fitted, job.hasRecess, job.recessM, job.hasBays ? &job.bays : nullptr, rawSoup ? &relief : nullptr, whole);
    if (o.r.ok && !o.r.strips.empty() && !job.rectsPx.empty()) {
        const Frame& f = job.f;
        std::vector<Rect> stripsPx;
        for (const Rect& st : o.r.strips) stripsPx.push_back({(st[0] - f.orthoSMin) / f.pixel, (f.orthoTMax - st[3]) / f.pixel, (st[2] - f.orthoSMin) / f.pixel, (f.orthoTMax - st[1]) / f.pixel});
        std::vector<uint8_t> rgba;
        RepeatResult rep = repeatTexture(img, f.pixel, job.rectsPx, stripsPx, mask, P, rgba);
        if (rep.texels) {
            texture::ImageBuffer buf;
            buf.width = img.W;
            buf.height = img.H;
            buf.channels = 4;
            buf.data = std::move(rgba);
            rep.png = png::encode(buf, 6);
            if (rep.png.empty()) throw std::runtime_error("could not encode facade " + std::to_string(f.facadeId) + "'s repeat texture");
            rep.ok = true;
            o.repeat = std::move(rep);
        }
    }
    return o;
}

// --------------------------------------------------------------------------------------------- the tear audit

/** A rebuilt facade as the audit sees it. */
struct AuditFacade {
    Frame f;
    std::vector<double> s, t;
    std::vector<uint8_t> built;
    std::vector<float> positions;
    std::vector<uint32_t> indices;
};

struct AuditResult {
    std::vector<int32_t> claim;
    double found = 0, restored = 0, left = 0, oblique = 0, obliqueLeft = 0, keptInFront = 0, restoredInFront = 0;
    bool hasOblique = false;
    std::vector<int> dropped;
};

/** A triangle soup with each triangle's box, for the views' cull. */
struct Soup {
    const float* p = nullptr;
    size_t n = 0;
    std::vector<float> box;  // per triangle min xyz, max xyz
    void index(const float* pts, size_t tris) {
        p = pts;
        n = tris;
        box.resize(n * 6);
        for (size_t k = 0; k < n; ++k) {
            const float* q = p + k * 9;
            for (int a = 0; a < 3; ++a) {
                box[k * 6 + a] = std::min(std::min(q[a], q[3 + a]), q[6 + a]);
                box[k * 6 + 3 + a] = std::max(std::max(q[a], q[3 + a]), q[6 + a]);
            }
        }
    }
};

struct View {
    Vec3 c, S, T, N;
    double s0, s1, t0, t1;
    bool oblique = false;
};

struct Grid {
    int W = 0, H = 0;
    double s0 = 0, t0 = 0;
    std::vector<float> depth, onPlane;
};

inline void worldBox(const Vec3& c, const Vec3& S, const Vec3& T, const Vec3& N, double s0, double s1, double t0, double t1, double reach, double lo[3], double hi[3]) {
    for (int k = 0; k < 3; ++k) { lo[k] = kInf; hi[k] = -kInf; }
    for (double sv : {s0, s1}) for (double tv : {t0, t1}) for (double dv : {-reach, reach}) for (int k = 0; k < 3; ++k) {
        const double w = c[k] + sv * S[k] + tv * T[k] + dv * N[k];
        lo[k] = js::min(lo[k], w - 0.01);
        hi[k] = js::max(hi[k], w + 0.01);
    }
}

/**
 * outermostDepth (view straight on: depth along the facade's normal, at most maxDepth) and obliqueDepth (an angled
 * view, with where each pixel's surface lies along the facade's normal): the soup's triangles in order, those `live`,
 * culled to the facade's world box (its lattice rectangle and `reach` along its normal either side) from every view.
 */
inline Grid renderView(const Soup& soup, const std::vector<uint8_t>* live, const AuditFacade& x, const View& v, double px, double reach, double maxDepth) {
    const Frame& f = x.f;
    Grid g;
    g.s0 = v.s0;
    g.t0 = v.t0;
    g.W = static_cast<int>(js::max(1, std::ceil((v.s1 - v.s0) / px)));
    g.H = static_cast<int>(js::max(1, std::ceil((v.t1 - v.t0) / px)));
    const size_t WH = static_cast<size_t>(g.W) * g.H;
    g.depth.assign(WH, -std::numeric_limits<float>::infinity());
    if (v.oblique) g.onPlane.assign(WH, std::numeric_limits<float>::quiet_NaN());
    double lo[3], hi[3];
    worldBox(f.centroid, f.axisS, f.axisT, f.normal, x.s.front(), x.s.back(), x.t.front(), x.t.back(), reach, lo, hi);
    for (size_t k = 0; k < soup.n; ++k) {
        if (live && !(*live)[k]) continue;
        const float* b = &soup.box[k * 6];
        if (b[3] < lo[0] || b[0] > hi[0] || b[4] < lo[1] || b[1] > hi[1] || b[5] < lo[2] || b[2] > hi[2]) continue;
        double Sx[3], Ty[3], D[3], F[3];
        for (int j = 0; j < 3; ++j) {
            const float* q = soup.p + k * 9 + j * 3;
            const Vec3 m{q[0] - v.c[0], q[1] - v.c[1], q[2] - v.c[2]};
            Sx[j] = (dot(m, v.S) - v.s0) / px - 0.5;
            Ty[j] = (dot(m, v.T) - v.t0) / px - 0.5;
            D[j] = dot(m, v.N);
            if (v.oblique) F[j] = dot(m, f.normal);
        }
        const double area = (Sx[1] - Sx[0]) * (Ty[2] - Ty[0]) - (Sx[2] - Sx[0]) * (Ty[1] - Ty[0]);
        if (std::abs(area) < 1e-9) continue;
        const double x0 = js::max(0, std::ceil(js::min(js::min(Sx[0], Sx[1]), Sx[2]))), x1 = js::min(g.W - 1, std::floor(js::max(js::max(Sx[0], Sx[1]), Sx[2])));
        const double y0 = js::max(0, std::ceil(js::min(js::min(Ty[0], Ty[1]), Ty[2]))), y1 = js::min(g.H - 1, std::floor(js::max(js::max(Ty[0], Ty[1]), Ty[2])));
        for (double y = y0; y <= y1; ++y) for (double x = x0; x <= x1; ++x) {
            const double w1 = ((x - Sx[0]) * (Ty[2] - Ty[0]) - (Sx[2] - Sx[0]) * (y - Ty[0])) / area, w2 = ((Sx[1] - Sx[0]) * (y - Ty[0]) - (x - Sx[0]) * (Ty[1] - Ty[0])) / area, w0 = 1 - w1 - w2;
            if (w0 < -1e-6 || w1 < -1e-6 || w2 < -1e-6) continue;
            const double d = w0 * D[0] + w1 * D[1] + w2 * D[2];
            const size_t o = static_cast<size_t>(y) * g.W + static_cast<size_t>(x);
            if (v.oblique) {
                if (d > g.depth[o]) { g.depth[o] = static_cast<float>(d); g.onPlane[o] = static_cast<float>(w0 * F[0] + w1 * F[1] + w2 * F[2]); }
            } else if (d > g.depth[o] && d <= maxDepth) {
                g.depth[o] = static_cast<float>(d);
            }
        }
    }
    return g;
}

/** The facade straight on over its lattice, then obliqueViews' four angles. */
inline std::vector<View> viewsOf(const AuditFacade& x, const Params& P) {
    const Frame& f = x.f;
    std::vector<View> out;
    out.push_back({f.centroid, f.axisS, f.axisT, f.normal, x.s.front(), x.s.back(), x.t.front(), x.t.back(), false});
    std::vector<Vec3> box;
    for (double sv : {x.s.front(), x.s.back()}) for (double tv : {x.t.front(), x.t.back()}) for (double dv : {-P.depthBandM, P.depthBandM})
        box.push_back({sv * f.axisS[0] + tv * f.axisT[0] + dv * f.normal[0], sv * f.axisS[1] + tv * f.axisT[1] + dv * f.normal[1], sv * f.axisS[2] + tv * f.axisT[2] + dv * f.normal[2]});
    const auto turn = [&](Vec3& a, Vec3& b, int i) {
        const double c = P.viewCos[i], si = P.viewSin[i];
        const Vec3 na{c * a[0] + si * b[0], c * a[1] + si * b[1], c * a[2] + si * b[2]}, nb{c * b[0] - si * a[0], c * b[1] - si * a[1], c * b[2] - si * a[2]};
        a = na;
        b = nb;
    };
    for (int i = 0; i < 4; ++i) {
        // views 0 and 1 turn by yaw (the normal toward +S), 2 and 3 by pitch (toward +T); a zero angle does not turn
        Vec3 N = f.normal, S = f.axisS, T = f.axisT;
        if (P.viewDeg[i] != 0 && !std::isnan(P.viewDeg[i])) { if (i < 2) turn(N, S, i); else turn(N, T, i); }
        double s0 = kInf, s1 = -kInf, t0 = kInf, t1 = -kInf;
        for (const Vec3& q : box) { const double sv = dot(q, S), tv = dot(q, T); s0 = js::min(s0, sv); s1 = js::max(s1, sv); t0 = js::min(t0, tv); t1 = js::max(t1, tv); }
        out.push_back({f.centroid, S, T, N, s0, s1, t0, t1, true});
    }
    return out;
}

inline int cellIndex(double v, const std::vector<double>& edges) {
    int lo = 0, hi = static_cast<int>(edges.size()) - 1;
    while (hi - lo > 1) { const int k = (lo + hi) >> 1; if (edges[static_cast<size_t>(k)] <= v) lo = k; else hi = k; }
    return lo;
}

inline bool facesFacade(const Vec3& a, const Vec3& b, const Vec3& c, const Frame& f, const Params& P, bool sameFacing) {
    const double ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2], vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
    const double nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx, nl = js::hypot({nx, ny, nz});
    const Vec3 m{(a[0] + b[0] + c[0]) / 3 - f.centroid[0], (a[1] + b[1] + c[1]) / 3 - f.centroid[1], (a[2] + b[2] + c[2]) / 3 - f.centroid[2]};
    if (std::abs(dot(m, f.normal)) > P.depthBandM) return false;
    if (!(nl > 0)) return true;
    const double c0 = dot({nx / nl, ny / nl, nz / nl}, f.normal);
    return (sameFacing ? c0 : std::abs(c0)) >= 0.3;
}

inline bool centreInRect(const Vec3& a, const Vec3& b, const Vec3& c, const AuditFacade& x) {
    const Vec3 m{(a[0] + b[0] + c[0]) / 3 - x.f.centroid[0], (a[1] + b[1] + c[1]) / 3 - x.f.centroid[1], (a[2] + b[2] + c[2]) / 3 - x.f.centroid[2]};
    const double sv = dot(m, x.f.axisS), tv = dot(m, x.f.axisT);
    return sv >= x.s.front() && sv <= x.s.back() && tv >= x.t.front() && tv <= x.t.back();
}

inline bool overBuilt(double px, double py, double pz, const AuditFacade& x, const Params& P) {
    const Vec3 m{px - x.f.centroid[0], py - x.f.centroid[1], pz - x.f.centroid[2]};
    const double d = dot(m, x.f.normal), sv = dot(m, x.f.axisS), tv = dot(m, x.f.axisT), eps = 1e-4;
    if (std::abs(d) > P.depthBandM || sv < x.s.front() - eps || sv > x.s.back() + eps || tv < x.t.front() - eps || tv > x.t.back() + eps) return false;
    return x.built[static_cast<size_t>(cellIndex(tv, x.t)) * (x.s.size() - 1) + static_cast<size_t>(cellIndex(sv, x.s))] != 0;
}

inline bool coveredByRebuild(const Vec3& a, const Vec3& b, const Vec3& c, const AuditFacade& x, const Params& P) {
    const double longest = js::max(js::max(js::hypot({b[0] - a[0], b[1] - a[1], b[2] - a[2]}), js::hypot({c[0] - a[0], c[1] - a[1], c[2] - a[2]})), js::hypot({c[0] - b[0], c[1] - b[1], c[2] - b[2]}));
    const double steps = js::min(40, js::max(1, std::ceil(longest / P.sampleM)));
    const int n = static_cast<int>(steps);
    for (int p = 0; p <= n; ++p) for (int q = 0; p + q <= n; ++q) {
        const double u = p / steps, v = q / steps;
        const double X = a[0] + (b[0] - a[0]) * u + (c[0] - a[0]) * v, Y = a[1] + (b[1] - a[1]) * u + (c[1] - a[1]) * v, Z = a[2] + (b[2] - a[2]) * u + (c[2] - a[2]) * v;
        if (!overBuilt(X, Y, Z, x, P)) return false;
    }
    return true;
}

/** rebuildFloor: the depth (along the facade's normal) below which nothing of its rebuilt surface lies, less auditBeyondM. */
inline double rebuildFloor(const AuditFacade& x, const Params& P) {
    double lo = kInf;
    for (size_t v = 0; v + 2 < x.positions.size(); v += 3)
        lo = js::min(lo, (static_cast<double>(x.positions[v]) - x.f.centroid[0]) * x.f.normal[0] + (static_cast<double>(x.positions[v + 1]) - x.f.centroid[1]) * x.f.normal[1] + (static_cast<double>(x.positions[v + 2]) - x.f.centroid[2]) * x.f.normal[2]);
    return lo - P.auditBeyondM;
}

/** inFrontOfRebuild: any sample of the triangle (as coveredByRebuild samples it) more than restoreFrontM in front of the surface the rebuild draws at its pixel (`drawn`, its straight view of itself). */
inline bool inFrontOfRebuild(const Vec3& a, const Vec3& b, const Vec3& c, const AuditFacade& x, const Grid& drawn, const Params& P) {
    const double longest = js::max(js::max(js::hypot({b[0] - a[0], b[1] - a[1], b[2] - a[2]}), js::hypot({c[0] - a[0], c[1] - a[1], c[2] - a[2]})), js::hypot({c[0] - b[0], c[1] - b[1], c[2] - b[2]}));
    const double steps = js::min(40, js::max(1, std::ceil(longest / P.sampleM)));
    const int n = static_cast<int>(steps);
    for (int p = 0; p <= n; ++p) for (int q = 0; p + q <= n; ++q) {
        const double u = p / steps, v = q / steps;
        const Vec3 m{a[0] + (b[0] - a[0]) * u + (c[0] - a[0]) * v - x.f.centroid[0], a[1] + (b[1] - a[1]) * u + (c[1] - a[1]) * v - x.f.centroid[1], a[2] + (b[2] - a[2]) * u + (c[2] - a[2]) * v - x.f.centroid[2]};
        const double X = std::floor((dot(m, x.f.axisS) - drawn.s0) / P.auditPixelM), Y = std::floor((dot(m, x.f.axisT) - drawn.t0) / P.auditPixelM);
        if (X < 0 || Y < 0 || X >= drawn.W || Y >= drawn.H) continue;
        const double d = drawn.depth[static_cast<size_t>(Y) * drawn.W + static_cast<size_t>(X)];
        if (finite(d) && dot(m, x.f.normal) > d + P.restoreFrontM) return true;
    }
    return false;
}

/** A torn view: its facade, its tear pixels and the grid they index. */
struct Torn {
    size_t fi;
    bool oblique;
    View view;
    int W, H;
    std::vector<uint32_t> pix;
};

/** applyFacadeLattices' removals under its tear audit. `soupPts` holds the scan's indexed triangles, nine floats each. */
inline AuditResult audit(const std::vector<float>& soupPts, const std::vector<AuditFacade>& facades, const Params& P, bool sameFacing, FixedThreadPool& pool) {
    const size_t nTri = soupPts.size() / 9, F = facades.size();
    AuditResult R;
    R.claim.assign(nTri, -1);
    std::vector<uint8_t> dropped(F);
    Soup scan;
    scan.index(soupPts.data(), nTri);
    const auto corner = [&](size_t k, int j) { const float* q = &soupPts[k * 9 + j * 3]; return Vec3{q[0], q[1], q[2]}; };
    const size_t chunk = 4096, chunks = (nTri + chunk - 1) / chunk;
    // 1. removed: a triangle every rebuilt facade it faces covers, claimed by the first
    const auto decide = [&] {
        pool.forEach(chunks, [&](size_t c) {
            for (size_t k = c * chunk; k < std::min(nTri, (c + 1) * chunk); ++k) {
                const Vec3 a = corner(k, 0), b = corner(k, 1), cc = corner(k, 2);
                int first = -1;
                bool ok = true;
                for (size_t fi = 0; fi < F && ok; ++fi) {
                    if (dropped[fi] || !facesFacade(a, b, cc, facades[fi].f, P, sameFacing) || !centreInRect(a, b, cc, facades[fi])) continue;
                    if (coveredByRebuild(a, b, cc, facades[fi], P)) { if (first < 0) first = static_cast<int>(fi); }
                    else ok = false;
                }
                R.claim[k] = ok && first >= 0 ? first : -1;
            }
        });
    };
    decide();
    std::vector<std::vector<View>> views(F);
    std::vector<double> floors(F);
    std::vector<Grid> drawn(F);
    for (size_t fi = 0; fi < F; ++fi) { views[fi] = viewsOf(facades[fi], P); floors[fi] = rebuildFloor(facades[fi], P); }
    // each rebuild seen straight on by itself, for the restore's guard
    pool.forEach(F, [&](size_t fi) {
        const auto& x = facades[fi];
        std::vector<float> tri;
        tri.reserve(x.indices.size() * 3);
        for (uint32_t v : x.indices) tri.insert(tri.end(), {x.positions[v * 3], x.positions[v * 3 + 1], x.positions[v * 3 + 2]});
        Soup own;
        own.index(tri.data(), tri.size() / 9);
        drawn[fi] = renderView(own, nullptr, x, views[fi][0], P.auditPixelM, P.reachM, kInf);
    });
    // 2. the audit: every facade straight on, the facades still rebuilt from four angles too
    const auto runAudit = [&](bool count) {
        // the result: the scan less its claimed triangles, and every facade still rebuilt
        std::vector<float> all(soupPts);
        for (size_t fi = 0; fi < F; ++fi) {
            if (dropped[fi]) continue;
            const auto& x = facades[fi];
            for (uint32_t v : x.indices) all.insert(all.end(), {x.positions[v * 3], x.positions[v * 3 + 1], x.positions[v * 3 + 2]});
        }
        Soup result;
        result.index(all.data(), all.size() / 9);
        std::vector<uint8_t> live(result.n, 1);
        for (size_t k = 0; k < nTri; ++k) if (R.claim[k] >= 0) live[k] = 0;
        std::vector<std::pair<size_t, size_t>> tasks;
        for (size_t fi = 0; fi < F; ++fi) for (size_t vi = 0; vi < (dropped[fi] ? 1 : views[fi].size()); ++vi) tasks.push_back({fi, vi});
        std::vector<Torn> found(tasks.size());
        pool.forEach(tasks.size(), [&](size_t ti) {
            const auto [fi, vi] = tasks[ti];
            const View& v = views[fi][vi];
            const Grid before = renderView(scan, nullptr, facades[fi], v, P.auditPixelM, P.reachM, v.oblique ? kInf : P.depthBandM);
            const Grid after = renderView(result, &live, facades[fi], v, P.auditPixelM, P.reachM, kInf);
            Torn t{fi, v.oblique, v, before.W, before.H, {}};
            // from an angle: the scan on the facade there and beside it, and the result shows nothing there, or a surface beyond
            // the rebuilt facade's own depth range and behind the scan's own surface
            const auto onFacade = [&](long x, long y) {
                if (x < 0 || y < 0 || x >= before.W || y >= before.H) return false;
                const size_t o = static_cast<size_t>(y) * before.W + static_cast<size_t>(x);
                return finite(before.depth[o]) && std::abs(static_cast<double>(before.onPlane[o])) <= P.depthBandM;
            };
            for (size_t o = 0; o < before.depth.size(); ++o) {
                const double bd = before.depth[o], ad = after.depth[o];
                const long x = static_cast<long>(o % static_cast<size_t>(before.W)), y = static_cast<long>(o / static_cast<size_t>(before.W));
                if (v.oblique ? (onFacade(x, y) && onFacade(x - 1, y) && onFacade(x + 1, y) && onFacade(x, y - 1) && onFacade(x, y + 1) && !(static_cast<double>(after.onPlane[o]) >= floors[fi]) && !(ad >= bd - P.tearDepthM))
                              : (bd >= -P.depthBandM && !(ad >= -P.depthBandM - P.tearDepthM)))
                    t.pix.push_back(static_cast<uint32_t>(o));
            }
            found[ti] = std::move(t);
        });
        std::vector<Torn> torn;
        for (auto& t : found) {
            if (count) { R.found += static_cast<double>(t.pix.size()); if (t.oblique) { R.oblique += static_cast<double>(t.pix.size()); R.hasOblique = true; } }
            if (!t.pix.empty()) torn.push_back(std::move(t));
        }
        return torn;
    };
    std::vector<Torn> torn = runAudit(true);
    std::vector<uint8_t> keptBack(nTri);
    // restore: every removed triangle whose footprint in a torn view touches a torn pixel or its neighbours, unless only views
    // from an angle touch it and it would stand in front of the rebuild that claimed it
    const auto restore = [&](const std::vector<Torn>& list) {
        std::vector<std::vector<uint8_t>> marks(list.size());
        pool.forEach(list.size(), [&](size_t e) {
            const Torn& t = list[e];
            auto& mark = marks[e];
            mark.assign(static_cast<size_t>(t.W) * t.H, 0);
            for (uint32_t o : t.pix) {
                const long x = static_cast<long>(o % static_cast<uint32_t>(t.W)), y = static_cast<long>(o / static_cast<uint32_t>(t.W));
                for (long dy = -1; dy <= 1; ++dy) for (long dx = -1; dx <= 1; ++dx) { const long xx = x + dx, yy = y + dy; if (xx >= 0 && yy >= 0 && xx < t.W && yy < t.H) mark[static_cast<size_t>(yy * t.W + xx)] = 1; }
            }
        });
        std::atomic<long> n{0}, nInFront{0};
        pool.forEach(chunks, [&](size_t c) {
            long mine = 0, mineInFront = 0;
            for (size_t k = c * chunk; k < std::min(nTri, (c + 1) * chunk); ++k) {
                if (R.claim[k] < 0) continue;
                int inFront = -1;
                for (size_t e = 0; e < list.size(); ++e) {
                    const Torn& t = list[e];
                    const Frame& f = facades[t.fi].f;
                    double x0 = kInf, x1 = -kInf, y0 = kInf, y1 = -kInf;
                    bool near = false;
                    for (int j = 0; j < 3; ++j) {
                        const Vec3 p = corner(k, j), m{p[0] - t.view.c[0], p[1] - t.view.c[1], p[2] - t.view.c[2]};
                        if (std::abs(dot(m, f.normal)) <= P.depthBandM + P.tearDepthM) near = true;
                        const double x = (dot(m, t.view.S) - t.view.s0) / P.auditPixelM, y = (dot(m, t.view.T) - t.view.t0) / P.auditPixelM;
                        x0 = js::min(x0, x); x1 = js::max(x1, x); y0 = js::min(y0, y); y1 = js::max(y1, y);
                    }
                    if (!near || x1 < 0 || y1 < 0 || x0 >= t.W || y0 >= t.H) continue;
                    bool hit = false;
                    for (double y = js::max(0, std::floor(y0)); y <= js::min(t.H - 1, std::floor(y1)) && !hit; ++y)
                        for (double x = js::max(0, std::floor(x0)); x <= js::min(t.W - 1, std::floor(x1)) && !hit; ++x)
                            if (marks[e][static_cast<size_t>(y) * t.W + static_cast<size_t>(x)]) hit = true;
                    // from an angle never put back in front of the rebuild that claimed it (the same answer from every view: a later
                    // view straight on still puts it back)
                    if (!hit) continue;
                    if (inFront < 0) inFront = inFrontOfRebuild(corner(k, 0), corner(k, 1), corner(k, 2), facades[static_cast<size_t>(R.claim[k])], drawn[static_cast<size_t>(R.claim[k])], P) ? 1 : 0;
                    if (t.oblique && inFront) { keptBack[k] = 1; continue; }
                    R.claim[k] = -1;
                    mine++;
                    if (inFront) mineInFront++;
                    break;
                }
            }
            n += mine;
            nInFront += mineInFront;
        });
        R.restoredInFront += static_cast<double>(nInFront.load());
        return static_cast<double>(n.load());
    };
    for (int round = 0; !torn.empty() && round < 3; ++round) {
        R.restored += restore(torn);
        torn = runAudit(false);
    }
    const auto anyStraight = [](const std::vector<Torn>& list) { for (const auto& t : list) if (!t.oblique) return true; return false; };
    for (int round = 0; anyStraight(torn) && round < 4; ++round) {
        for (const auto& t : torn) if (!t.oblique && !dropped[t.fi]) { dropped[t.fi] = 1; R.dropped.push_back(static_cast<int>(t.fi)); }
        decide();
        torn = runAudit(false);
        if (!torn.empty()) { R.restored += restore(torn); torn = runAudit(false); }
    }
    for (const auto& t : torn) (t.oblique ? R.obliqueLeft : R.left) += static_cast<double>(t.pix.size());
    if (R.left) {
        for (size_t fi = 0; fi < F; ++fi) if (!dropped[fi]) { dropped[fi] = 1; R.dropped.push_back(static_cast<int>(fi)); }
        decide();
        R.left = 0;
        for (const auto& t : runAudit(false)) if (!t.oblique) R.left += static_cast<double>(t.pix.size());
    }
    for (size_t k = 0; k < nTri; ++k) if (keptBack[k] && R.claim[k] >= 0) R.keptInFront += 1;
    return R;
}

}  // namespace detail

using detail::audit;
using detail::rebuildFacade;
using detail::AuditFacade;
using detail::AuditResult;

}  // namespace facade_lattice
}  // namespace scratchbox

#endif  // SCRATCHBOX_FACADE_LATTICE_HPP
