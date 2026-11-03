/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

#ifndef SCRATCHBOX_WALL_GRAMMAR_HPP
#define SCRATCHBOX_WALL_GRAMMAR_HPP

/**
 * A wall's bays read from its photos, natively (packages/core/src/node/3d-engine/staged-location/wall-grammar.ts, which
 * says what and why; this is its arithmetic, step for step): wallEvidence (each member facade's photo, uncovered and
 * occluded masks decoded, its texels laid on the wall's grid) and readWallBays (the columns' states, the bays across
 * mullions split at piers, each bay's row runs, punched stacks refused, unknown spans continuing the rhythm). One wall a
 * task; its members' photos decoded side by side, then laid on the grid in their order, as the sums are float32's.
 * The walls, the tiers' grammars and the per-facade bays stay in the TypeScript.
 */

#include "scratchbox_js_math.hpp"
#include "scratchbox_png.hpp"
#include "scratchbox_thread_pool.hpp"

#include <algorithm>
#include <array>
#include <cmath>
#include <cstdint>
#include <fstream>
#include <iterator>
#include <limits>
#include <stdexcept>
#include <string>
#include <vector>

// V8 never fuses a multiply and an add
#pragma clang fp contract(off)

namespace scratchbox {
namespace wall_grammar {

using Vec3 = std::array<double, 3>;
using Rect = std::array<double, 4>;

constexpr double kNaN = std::numeric_limits<double>::quiet_NaN();
constexpr double kInf = std::numeric_limits<double>::infinity();

/** WALL_GRAMMAR_PARAMS' reading fields in order, and the occlusion mask's threshold code (wall-grammar.ts wallGrammarParamVector). */
struct Params {
    double cellM, voteMin, minCoverage, mullionMaxM, minBayM, pierShare, maxGapM, minRunM, punchedBands, punchedShare, bandM;
    /** Math.round(OCCLUSION_PARAMS.minBlocked * 255): an occlusion mask's texel at least this is not read. */
    double occludedAt;

    static constexpr size_t kCount = 12;
    static Params from(const std::vector<double>& v) {
        if (v.size() != kCount) throw std::runtime_error("the wall grammar takes " + std::to_string(kCount) + " parameters, got " + std::to_string(v.size()));
        Params p;
        double* const fields[] = {&p.cellM, &p.voteMin, &p.minCoverage, &p.mullionMaxM, &p.minBayM, &p.pierShare, &p.maxGapM, &p.minRunM, &p.punchedBands, &p.punchedShare, &p.bandM, &p.occludedAt};
        static_assert(sizeof fields / sizeof fields[0] == kCount);
        for (size_t i = 0; i < kCount; ++i) *fields[i] = v[i];
        return p;
    }
};

/** A member facade: its frame and ortho, its photo and masks by file (empty: none), and the window fit's windows in texels. */
struct Member {
    int facadeId = 0;
    Vec3 centroid{}, axisS{}, axisT{};
    double pixel = 0, orthoSMin = 0, orthoTMax = 0, width = 0, height = 0;
    std::string image, uncovered, occluded;
    std::vector<Rect> windows;
};

/** One wall: its members in order and its frame (u along U from u0, height from y0). */
struct WallJob {
    double u0 = 0, y0 = 0, u1 = 0, y1 = 0;
    Vec3 U{};
    std::vector<Member> members;
};

struct Bay { double u0, u1, y0, y1; bool generated; };

struct WallOut {
    int nu = 0, ny = 0;
    double covered = 0;
    std::vector<Bay> bays;
    std::vector<int8_t> state;
};

namespace detail {

inline double dot(const Vec3& a, const Vec3& b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
inline bool finite(double v) { return std::isfinite(v); }

/** median() of numbers: the element a stable ascending sort puts at length >> 1 (the values here are counts, never -0). */
inline double median(std::vector<double> a) {
    if (a.empty()) return kNaN;
    const size_t m = a.size() >> 1;
    std::nth_element(a.begin(), a.begin() + static_cast<long>(m), a.end());
    return a[m];
}

struct Image {
    int W = 0, H = 0;
    std::vector<uint8_t> rgba;
};

inline Image readPng(const std::string& file) {
    std::ifstream in(file, std::ios::binary);
    if (!in) throw std::runtime_error("cannot read " + file);
    const std::vector<uint8_t> bytes((std::istreambuf_iterator<char>(in)), std::istreambuf_iterator<char>());
    auto d = png::decode(bytes.data(), bytes.size(), png::OutputFormat::Rgba);
    if (!d.ok) throw std::runtime_error(file + ": " + d.error);
    return {d.image.width, d.image.height, std::move(d.image.data)};
}

/** A member decoded: its photo, its unread texels (uncoveredOf) and its window texels. */
struct Decoded {
    Image img;
    std::vector<uint8_t> unread, inWin;
};

/** TypedArray.prototype.fill's index: ToIntegerOrInfinity, then clamped to [0, len]. */
inline size_t fillIndex(double v, size_t len) {
    const double r = std::trunc(v);
    if (r < 0) return static_cast<size_t>(std::max(0.0, static_cast<double>(len) + r));
    return static_cast<size_t>(std::min(r, static_cast<double>(len)));
}

inline Decoded decodeMember(const Member& f, const Params& P) {
    Decoded d;
    d.img = readPng(f.image);
    const size_t N = static_cast<size_t>(d.img.W) * d.img.H;
    std::vector<uint8_t> unc;
    if (!f.uncovered.empty()) {
        const Image m = readPng(f.uncovered);
        unc.resize(static_cast<size_t>(m.W) * m.H);
        for (size_t k = 0; k < unc.size(); ++k) unc[k] = m.rgba[k * 4] >= 128 ? 1 : 0;
    } else {
        unc.resize(N);
        for (size_t k = 0; k < N; ++k) { const uint8_t* q = &d.img.rgba[k * 4]; unc[k] = q[3] == 0 || (q[0] == 128 && q[1] == 128 && q[2] == 128) ? 1 : 0; }
    }
    // readOccluded: a mask of the facade's own size, else none
    if (!f.occluded.empty()) {
        const Image m = readPng(f.occluded);
        if (m.W == f.width && m.H == f.height && static_cast<size_t>(m.W) * m.H == unc.size()) {
            for (size_t k = 0; k < unc.size(); ++k) unc[k] = unc[k] || m.rgba[k * 4] >= P.occludedAt ? 1 : 0;
        }
    }
    d.unread = std::move(unc);
    d.inWin.assign(N, 0);
    const double W = d.img.W, H = d.img.H;
    for (const Rect& w : f.windows) {
        for (double y = js::max(0, w[1]); y < js::min(H, w[3]); ++y) {
            const size_t a = fillIndex(y * W + js::max(0, w[0]), N), b = fillIndex(y * W + js::min(W, w[2]), N);
            for (size_t k = a; k < b; ++k) d.inWin[k] = 1;
        }
    }
    return d;
}

/** wallEvidence and readWallBays for one wall. */
inline WallOut readWall(const WallJob& job, const Params& P, FixedThreadPool& pool) {
    std::vector<Decoded> dec(job.members.size());
    pool.forEach(job.members.size(), [&](size_t i) { dec[i] = decodeMember(job.members[i], P); });
    const double cellM = P.cellM;
    const int nu = static_cast<int>(js::max(1, std::ceil((job.u1 - job.u0) / cellM))), ny = static_cast<int>(js::max(1, std::ceil((job.y1 - job.y0) / cellM)));
    const size_t NC = static_cast<size_t>(nu) * ny;
    std::vector<uint8_t> covered(NC), window(NC);
    std::vector<float> lumSum(NC, 0.0f);
    std::vector<uint16_t> lumN(NC, 0);
    for (size_t i = 0; i < job.members.size(); ++i) {
        const Member& f = job.members[i];
        const Decoded& d = dec[i];
        const int W = d.img.W, H = d.img.H;
        const int step = static_cast<int>(js::max(1, js::round(cellM / f.pixel / 2)));
        const double us = dot(f.axisS, job.U), ut = dot(f.axisT, job.U), uc = dot(f.centroid, job.U);
        for (int y = 0; y < H; y += step) for (int x = 0; x < W; x += step) {
            const size_t k = static_cast<size_t>(y) * W + x;
            if ((k < d.unread.size() && d.unread[k]) || !d.img.rgba[k * 4 + 3]) continue;
            const double s = f.orthoSMin + (x + 0.5) * f.pixel, t = f.orthoTMax - (y + 0.5) * f.pixel;
            const double cu = std::floor((uc + s * us + t * ut - job.u0) / cellM), cy = std::floor((f.centroid[1] + s * f.axisS[1] + t * f.axisT[1] - job.y0) / cellM);
            if (cu < 0 || cy < 0 || cu >= nu || cy >= ny) continue;
            const size_t c = static_cast<size_t>(cy) * nu + static_cast<size_t>(cu);
            covered[c] = 1;
            if (d.inWin[k]) window[c] = 1;
            const uint8_t* q = &d.img.rgba[k * 4];
            lumSum[c] = static_cast<float>(static_cast<double>(lumSum[c]) + (0.2126 * q[0] + 0.7152 * q[1] + 0.0722 * q[2]));
            lumN[c] = static_cast<uint16_t>(lumN[c] + 1);
        }
    }
    dec.clear();
    std::vector<float> lum(NC);
    for (size_t k = 0; k < NC; ++k) lum[k] = lumN[k] ? static_cast<float>(static_cast<double>(lumSum[k]) / lumN[k]) : std::numeric_limits<float>::quiet_NaN();

    WallOut out;
    out.nu = nu;
    out.ny = ny;
    for (uint8_t v : covered) out.covered += v;
    // readWallBays
    std::vector<int8_t> state(static_cast<size_t>(nu));
    for (int x = 0; x < nu; ++x) {
        long cov = 0, win = 0;
        for (int y = 0; y < ny; ++y) { const size_t k = static_cast<size_t>(y) * nu + x; if (covered[k]) { cov++; if (window[k]) win++; } }
        state[static_cast<size_t>(x)] = cov < P.minCoverage * ny ? -1 : win >= P.voteMin * cov ? 1 : 0;
    }
    const auto colLum = [&](int want) {
        std::array<double, 256> h{};
        double n = 0;
        for (int x = 0; x < nu; ++x) if (state[static_cast<size_t>(x)] == want) for (int y = 0; y < ny; ++y) {
            const double l = lum[static_cast<size_t>(y) * nu + x];
            if (finite(l)) { h[static_cast<size_t>(js::min(255, js::max(0, js::round(l))))]++; n++; }
        }
        if (!n) return kNaN;
        double c = 0;
        for (int i = 0; i < 256; ++i) { c += h[static_cast<size_t>(i)]; if (c >= n / 2) return static_cast<double>(i); }
        return 255.0;
    };
    const double pierLum = colLum(0), bayLum = colLum(1), mid = (pierLum + bayLum) / 2;
    const auto all = [&](int a, int b, auto ok) { for (int x = a; x < b; ++x) if (!ok(state[static_cast<size_t>(x)])) return false; return true; };
    std::vector<std::array<int, 2>> runs;
    for (int x = 0; x < nu;) {
        if (state[static_cast<size_t>(x)] != 1) { x++; continue; }
        int end = x;
        while (end < nu && state[static_cast<size_t>(end)] == 1) end++;
        if (!runs.empty() && (x - runs.back()[1]) * cellM < P.mullionMaxM && all(runs.back()[1], x, [](int8_t v) { return v == 0 || v == 1; })) runs.back()[1] = end;
        else runs.push_back({x, end});
        x = end;
    }
    std::vector<double> colL(static_cast<size_t>(nu));
    for (int x = 0; x < nu; ++x) {
        double sum = 0;
        long n = 0;
        for (int y = 0; y < ny; ++y) { const double l = lum[static_cast<size_t>(y) * nu + x]; if (finite(l)) { sum += l; n++; } }
        colL[static_cast<size_t>(x)] = n ? sum / static_cast<double>(n) : kNaN;
    }
    std::vector<double> piers;
    for (size_t i = 1; i < runs.size(); ++i) if (all(runs[i - 1][1], runs[i][0], [](int8_t v) { return v == 0; })) piers.push_back(runs[i][0] - runs[i - 1][1]);
    const double pierCells = !piers.empty() ? js::max(2, js::round(P.pierShare * median(piers))) : kInf;
    std::vector<double> widths;
    for (const auto& r : runs) widths.push_back(r[1] - r[0]);
    const double bayCells = median(widths) * P.pierShare;
    std::vector<std::array<int, 2>> split;
    for (const auto& r : runs) {
        const int a = r[0], b = r[1];
        int start = a;
        for (int x = a; x < b;) {
            if (!(colL[static_cast<size_t>(x)] > mid)) { x++; continue; }
            int end = x;
            while (end < b && colL[static_cast<size_t>(end)] > mid) end++;
            if (end - x >= pierCells && x - start >= bayCells && b - end >= bayCells) { split.push_back({start, x}); start = end; }
            x = end;
        }
        if (b > start) split.push_back({start, b});
    }
    std::vector<std::array<int, 2>> cols;
    for (const auto& c : split) if ((c[1] - c[0]) * cellM >= P.minBayM) cols.push_back(c);
    const auto fitBands = [&](int a, int b, int r0, int r1, double& bands, double& rows) {
        double gap = 0;
        bool seen = false;
        bands = 0;
        rows = 0;
        const double minRows = js::max(1, js::round(P.bandM / cellM));
        for (int y = r0; y < r1; ++y) {
            long cov = 0, win = 0;
            for (int x = a; x < b; ++x) { const size_t k = static_cast<size_t>(y) * nu + x; if (covered[k]) { cov++; if (window[k]) win++; } }
            if (!cov) continue;
            if (win >= P.voteMin * cov) { if (seen && gap >= minRows) { bands++; rows += gap; } seen = true; gap = 0; }
            else gap++;
        }
    };
    const auto rowRuns = [&](int a, int b) {
        std::vector<int8_t> row(static_cast<size_t>(ny));
        for (int y = 0; y < ny; ++y) {
            double sum = 0;
            long n = 0;
            for (int x = a; x < b; ++x) { const double l = lum[static_cast<size_t>(y) * nu + x]; if (finite(l)) { sum += l; n++; } }
            row[static_cast<size_t>(y)] = n < 0.3 * (b - a) || !finite(mid) || !(pierLum > bayLum) ? -1 : sum / static_cast<double>(n) < mid ? 1 : 0;
        }
        std::vector<std::array<int, 2>> res;
        int start = -1, lastBay = -1;
        double gapWall = 0, wallIn = 0, bands = 0;
        for (int y = 0; y <= ny; ++y) {
            const int v = y < ny ? row[static_cast<size_t>(y)] : 0;
            if (v == 1) {
                if (start < 0) { start = y; wallIn = 0; bands = 0; }
                if (gapWall) { wallIn += gapWall; bands++; }
                lastBay = y;
                gapWall = 0;
                continue;
            }
            if (start < 0) continue;
            if (v == 0) gapWall++;
            if (y == ny || gapWall * cellM > P.maxGapM) {
                const int len = lastBay + 1 - start;
                double fb = 0, fr = 0;
                fitBands(a, b, start, lastBay + 1, fb, fr);
                const bool punched = js::max(bands, fb) >= P.punchedBands && js::max(wallIn, fr) >= P.punchedShare * len;
                if (len * cellM >= P.minRunM && !punched) res.push_back({start, lastBay + 1});
                start = -1;
                gapWall = 0;
            }
        }
        return res;
    };
    struct Read { int a, b; std::vector<std::array<int, 2>> rows; };
    std::vector<Read> read;
    for (const auto& c : cols) read.push_back({c[0], c[1], rowRuns(c[0], c[1])});
    for (const auto& c : read) for (const auto& r : c.rows) out.bays.push_back({job.u0 + c.a * cellM, job.u0 + c.b * cellM, job.y0 + r[0] * cellM, job.y0 + r[1] * cellM, false});
    // unknown spans continue the wall's rhythm
    std::vector<const Read*> withRows;
    for (const auto& c : read) if (!c.rows.empty()) withRows.push_back(&c);
    if (withRows.size() >= 2) {
        std::vector<double> gaps, ws;
        for (size_t i = 1; i < withRows.size(); ++i) gaps.push_back(withRows[i]->a - withRows[i - 1]->a);
        for (const Read* c : withRows) ws.push_back(c->b - c->a);
        const double pitch = median(gaps), width = median(ws);
        for (int x = 0; x < nu;) {
            if (state[static_cast<size_t>(x)] != -1) { x++; continue; }
            int end = x;
            while (end < nu && state[static_cast<size_t>(end)] == -1) end++;
            const Read* near = withRows[0];
            for (size_t i = 1; i < withRows.size(); ++i) if (std::abs(withRows[i]->a - x) < std::abs(near->a - x)) near = withRows[i];
            double a0 = near->a + std::ceil((x - near->a) / pitch) * pitch;
            for (; a0 + width <= end; a0 += pitch) {
                if (a0 < x) continue;
                for (const auto& r : near->rows) out.bays.push_back({job.u0 + a0 * cellM, job.u0 + (a0 + width) * cellM, job.y0 + r[0] * cellM, job.y0 + r[1] * cellM, true});
            }
            x = end;
        }
    }
    out.state = std::move(state);
    return out;
}

}  // namespace detail

/** Every wall's evidence and bays, one wall a task (the largest first), in the walls' order. */
inline std::vector<WallOut> readWalls(const std::vector<WallJob>& jobs, const Params& P, FixedThreadPool& pool) {
    std::vector<size_t> order(jobs.size());
    for (size_t i = 0; i < order.size(); ++i) order[i] = i;
    const auto area = [&](size_t i) { return (jobs[i].u1 - jobs[i].u0) * (jobs[i].y1 - jobs[i].y0); };
    std::stable_sort(order.begin(), order.end(), [&](size_t a, size_t b) { return area(a) > area(b); });
    std::vector<WallOut> out(jobs.size());
    pool.forEach(order.size(), [&](size_t i) { out[order[i]] = detail::readWall(jobs[order[i]], P, pool); });
    return out;
}

}  // namespace wall_grammar
}  // namespace scratchbox

#endif  // SCRATCHBOX_WALL_GRAMMAR_HPP
