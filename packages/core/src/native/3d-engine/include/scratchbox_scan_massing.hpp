/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Massing read from a scan, and the choice between candidate massings by how well each explains the scan.
 *
 *  - sampleSurface: evenly spaced points on a triangle soup (both the scan and any candidate are compared as samples).
 *  - agreement: coverage (share of the scan within tau of the candidate) and precision (share of the candidate within
 *    tau of the scan), overall and height-balanced over bands; candidate surface the scan could not have seen (street
 *    level, a wall pressed against a taller neighbour per `TopGrid`) is left out of precision.
 *  - slices: the scan cut into horizontal slices, each slice's plan cells closed over small gaps and filled (a shell of
 *    walls reads as the solid it bounds).
 *  - loftRuns + loftSolids: each slice's pieces followed upward by mutual best overlap or nearness (a leaning leg stays
 *    one run), each run's outlines resampled to the same point count and bearing, rings a straight blend of their kept
 *    neighbours explains dropped, the rest skinned into closed solids by Loft3D.
 *  - extrudeBlock: a footprint extruded between two heights (the plainest candidate).
 *  - choose: candidates simplest first; the first explaining the scan (coverage and precision both at least their
 *    thresholds) wins, else the best height-balanced F, said so.
 *
 * Everything is measured off the scan and the candidates' own surfaces: nothing here names a structure type. The Node
 * pipeline's TypeScript twins (pipeline-e/surface-agreement.ts, scan-sections.ts, scan-lofts.ts, massing-choice.ts)
 * implement the same rules for pipeline H; this header is what the in-app Python API (scratchbox.massing) calls.
 */

#pragma once

#include "scratchbox_geometry.hpp"
#include "scratchbox_shaper.hpp"

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <functional>
#include <limits>
#include <map>
#include <optional>
#include <set>
#include <string>
#include <unordered_map>
#include <unordered_set>
#include <vector>

namespace scratchbox {
namespace scan_massing {

using geometry::Vec3;
using geometry::ScratchboxMesh;

struct P2 { double x, z; };

// ---------------------------------------------------------------------------------------------------------------------
// Surface samples
// ---------------------------------------------------------------------------------------------------------------------

/** About one point per spacing^2 of surface (spacing grows to stay under maxSamples), deterministic (R2 sequence). */
inline std::vector<Vec3> sampleSurface(const std::vector<Vec3>& pos, const std::vector<uint32_t>& idx, double spacing, size_t maxSamples = 400000) {
    const size_t nt = idx.size() / 3;
    std::vector<double> areas(nt);
    double total = 0;
    for (size_t t = 0; t < nt; ++t) {
        const Vec3 &a = pos[idx[t * 3]], &b = pos[idx[t * 3 + 1]], &c = pos[idx[t * 3 + 2]];
        const double ux = b.x - a.x, uy = b.y - a.y, uz = b.z - a.z, vx = c.x - a.x, vy = c.y - a.y, vz = c.z - a.z;
        areas[t] = 0.5 * std::sqrt(std::pow(uy * vz - uz * vy, 2) + std::pow(uz * vx - ux * vz, 2) + std::pow(ux * vy - uy * vx, 2));
        total += areas[t];
    }
    const double s = std::max(spacing, std::sqrt(total / std::max<size_t>(1, maxSamples)));
    const double per = 1.0 / (s * s);
    std::vector<Vec3> out;
    double carry = 0;
    uint64_t k = 0;
    for (size_t t = 0; t < nt; ++t) {
        carry += areas[t] * per;
        const int n = static_cast<int>(std::floor(carry));
        carry -= n;
        const Vec3 &a = pos[idx[t * 3]], &b = pos[idx[t * 3 + 1]], &c = pos[idx[t * 3 + 2]];
        for (int j = 0; j < n; ++j, ++k) {
            double r1 = std::fmod(0.7548776662 * (k + 1), 1.0), r2 = std::fmod(0.5698402910 * (k + 1), 1.0);
            if (r1 + r2 > 1) { r1 = 1 - r1; r2 = 1 - r2; }
            out.push_back(Vec3(static_cast<float>(a.x + r1 * (b.x - a.x) + r2 * (c.x - a.x)), static_cast<float>(a.y + r1 * (b.y - a.y) + r2 * (c.y - a.y)),
                               static_cast<float>(a.z + r1 * (b.z - a.z) + r2 * (c.z - a.z))));
        }
    }
    return out;
}

inline std::vector<Vec3> sampleMesh(const ScratchboxMesh& m, double spacing, size_t maxSamples = 400000) {
    std::vector<Vec3> pos;
    pos.reserve(m.vertices.size());
    for (const auto& v : m.vertices) pos.push_back(v.position);
    return sampleSurface(pos, m.indices, spacing, maxSamples);
}

/** Whether (x, z) lies inside any of the rings (even-odd per ring). */
inline bool inRings(const std::vector<std::vector<P2>>& rings, double x, double z) {
    for (const auto& ring : rings) {
        bool c = false;
        for (size_t i = 0, j = ring.size() - 1; i < ring.size(); j = i++)
            if ((ring[i].z > z) != (ring[j].z > z) && x < (ring[j].x - ring[i].x) * (z - ring[i].z) / (ring[j].z - ring[i].z) + ring[i].x) c = !c;
        if (c) return true;
    }
    return false;
}

/**
 * The triangles of `mesh` whose centroid stands above minY and within marginM (in plan) of the rings: the structure's
 * part of a district scan. The margin is tested on a square of probes, so it is approximate to a probe step.
 */
inline ScratchboxMesh cropToPlan(const ScratchboxMesh& mesh, const std::vector<std::vector<P2>>& rings, double marginM, double minY) {
    ScratchboxMesh out("scan_crop");
    const double step = std::max(0.5, marginM / 2);
    for (size_t t = 0; t + 2 < mesh.indices.size(); t += 3) {
        const Vec3 &a = mesh.vertices[mesh.indices[t]].position, &b = mesh.vertices[mesh.indices[t + 1]].position, &c = mesh.vertices[mesh.indices[t + 2]].position;
        const double cx = (a.x + b.x + c.x) / 3, cy = (a.y + b.y + c.y) / 3, cz = (a.z + b.z + c.z) / 3;
        if (cy < minY) continue;
        bool near = false;
        for (double dx = -marginM; dx <= marginM + 1e-9 && !near; dx += step) for (double dz = -marginM; dz <= marginM + 1e-9; dz += step) if (inRings(rings, cx + dx, cz + dz)) { near = true; break; }
        if (!near) continue;
        const uint32_t v = static_cast<uint32_t>(out.vertices.size());
        for (const Vec3* p : {&a, &b, &c}) out.vertices.push_back(geometry::Vertex{*p});
        out.indices.insert(out.indices.end(), {v, v + 1, v + 2});
    }
    out.recomputeBounds();
    return out;
}

// ---------------------------------------------------------------------------------------------------------------------
// Agreement
// ---------------------------------------------------------------------------------------------------------------------

/** The scan's highest point per plan cell, for the hidden-wall test. */
struct TopGrid {
    double cellM = 1.0;
    std::unordered_map<int64_t, float> top;
    static int64_t key(int64_t i, int64_t k) { return (i << 32) ^ (k & 0xffffffffLL); }
    void add(const Vec3& p) {
        const int64_t kk = key(static_cast<int64_t>(std::floor(p.x / cellM)), static_cast<int64_t>(std::floor(p.z / cellM)));
        auto it = top.find(kk);
        if (it == top.end() || it->second < p.y) top[kk] = p.y;
    }
    float at(double x, double z) const {
        auto it = top.find(key(static_cast<int64_t>(std::floor(x / cellM)), static_cast<int64_t>(std::floor(z / cellM))));
        return it == top.end() ? -std::numeric_limits<float>::infinity() : it->second;
    }
};

struct AgreementOptions {
    double tauM = 1.0;
    /** Coverage's own tolerance, when wider than tauM (NaN: tauM): scan surface within this of the candidate counts as
     *  explained. A relief allowance - a cornice, a column, a recessed window within it is the facade's detail, not
     *  missed shape - while precision keeps tauM, so a shape standing in empty air still fails. */
    double coverageTauM = std::numeric_limits<double>::quiet_NaN();
    double bandM = 2.0;
    size_t minBandSamples = 30;
    /** Candidate surface below groundY + 0.5 is left out of precision (NaN: not used). */
    double groundY = std::numeric_limits<double>::quiet_NaN();
    /** With `ownPlan`: a candidate point beside a taller neighbour (the scan's top within reachM, off its own plan) is unseen. */
    const TopGrid* neighbours = nullptr;
    std::function<bool(double, double)> ownPlan;
    double reachM = 1.5;
};

struct Agreement {
    double coverage = 0, precision = 0, f = 0;
    double bandedCoverage = 0, bandedPrecision = 0, bandedF = 0, worstBandCoverage = 0;
    size_t bands = 0, scanSamples = 0, candidateSamples = 0, unseenSamples = 0;
};

namespace detail {
inline int64_t key3(int64_t i, int64_t j, int64_t k) { return (i * 73856093LL) ^ (j * 19349663LL) ^ (k * 83492791LL); }

/** Nearest distance from each of `from` to `to`, capped at cap (a uniform grid of cell cap). */
inline std::vector<float> nearest(const std::vector<Vec3>& from, const std::vector<Vec3>& to, double cap) {
    std::unordered_map<int64_t, std::vector<uint32_t>> grid;
    auto cellOf = [&](double v) { return static_cast<int64_t>(std::floor(v / cap)); };
    for (uint32_t i = 0; i < to.size(); ++i) grid[key3(cellOf(to[i].x), cellOf(to[i].y), cellOf(to[i].z))].push_back(i);
    std::vector<float> out(from.size());
    for (size_t o = 0; o < from.size(); ++o) {
        const Vec3& p = from[o];
        const int64_t i0 = cellOf(p.x), j0 = cellOf(p.y), k0 = cellOf(p.z);
        double best = cap * cap;
        for (int di = -1; di <= 1; ++di) for (int dj = -1; dj <= 1; ++dj) for (int dk = -1; dk <= 1; ++dk) {
            auto it = grid.find(key3(i0 + di, j0 + dj, k0 + dk));
            if (it == grid.end()) continue;
            for (uint32_t q : it->second) {
                const double dx = to[q].x - p.x, dy = to[q].y - p.y, dz = to[q].z - p.z, d = dx * dx + dy * dy + dz * dz;
                if (d < best) best = d;
            }
        }
        out[o] = static_cast<float>(std::sqrt(best));
    }
    return out;
}
}  // namespace detail

inline Agreement agreement(const std::vector<Vec3>& scan, const std::vector<Vec3>& candidate, const AgreementOptions& o = {}) {
    Agreement a;
    // the candidate surface the scan could have seen (precision is measured on it; coverage uses all of the candidate)
    std::vector<Vec3> seen;
    seen.reserve(candidate.size());
    static const double dirs[8][2] = {{1, 0}, {-1, 0}, {0, 1}, {0, -1}, {0.7, 0.7}, {-0.7, 0.7}, {0.7, -0.7}, {-0.7, -0.7}};
    for (const auto& p : candidate) {
        if (!std::isnan(o.groundY) && p.y < o.groundY + 0.5) { a.unseenSamples++; continue; }
        bool hidden = false;
        if (o.neighbours && o.ownPlan) for (const auto& d : dirs) {
            const double nx = p.x + d[0] * o.reachM, nz = p.z + d[1] * o.reachM;
            if (o.ownPlan(nx, nz)) continue;
            if (o.neighbours->at(nx, nz) >= p.y) { hidden = true; break; }
        }
        if (hidden) { a.unseenSamples++; continue; }
        seen.push_back(p);
    }
    const double covTau = std::isnan(o.coverageTauM) ? o.tauM : std::max(o.tauM, o.coverageTauM);
    const auto s2c = detail::nearest(scan, candidate, 4 * covTau), c2s = detail::nearest(seen, scan, 4 * o.tauM);
    a.scanSamples = scan.size();
    a.candidateSamples = candidate.size();
    size_t hit = 0;
    for (float d : s2c) if (d <= covTau) hit++;
    a.coverage = scan.empty() ? 0 : static_cast<double>(hit) / scan.size();
    hit = 0;
    for (float d : c2s) if (d <= o.tauM) hit++;
    a.precision = seen.empty() ? 0 : static_cast<double>(hit) / seen.size();
    a.f = a.coverage + a.precision > 0 ? 2 * a.coverage * a.precision / (a.coverage + a.precision) : 0;
    double yMin = std::numeric_limits<double>::infinity();
    for (const auto& p : scan) yMin = std::min<double>(yMin, p.y);
    auto band = [&](double y) { return static_cast<int>(std::floor((y - yMin) / o.bandM)); };
    std::map<int, std::pair<size_t, size_t>> sb, cb;
    for (size_t i = 0; i < scan.size(); ++i) { auto& e = sb[band(scan[i].y)]; e.first++; if (s2c[i] <= covTau) e.second++; }
    for (size_t i = 0; i < seen.size(); ++i) { auto& e = cb[band(seen[i].y)]; e.first++; if (c2s[i] <= o.tauM) e.second++; }
    std::vector<double> covs, precs;
    for (const auto& [b, e] : sb) {
        if (e.first < o.minBandSamples) continue;
        covs.push_back(static_cast<double>(e.second) / e.first);
        auto it = cb.find(b);
        precs.push_back(it != cb.end() && it->second.first ? static_cast<double>(it->second.second) / it->second.first : 0.0);
    }
    for (const auto& [b, e] : cb) if (!sb.count(b) && e.first >= o.minBandSamples) precs.push_back(0.0);
    auto mean = [](const std::vector<double>& v) { double s = 0; for (double x : v) s += x; return v.empty() ? 0.0 : s / v.size(); };
    a.bandedCoverage = mean(covs);
    a.bandedPrecision = mean(precs);
    a.bandedF = a.bandedCoverage + a.bandedPrecision > 0 ? 2 * a.bandedCoverage * a.bandedPrecision / (a.bandedCoverage + a.bandedPrecision) : 0;
    a.worstBandCoverage = covs.empty() ? 0 : *std::min_element(covs.begin(), covs.end());
    a.bands = covs.size();
    return a;
}

// ---------------------------------------------------------------------------------------------------------------------
// Slices
// ---------------------------------------------------------------------------------------------------------------------

using CellSet = std::unordered_set<int64_t>;
inline int64_t ckey(int32_t i, int32_t k) { return (static_cast<int64_t>(i) << 32) | static_cast<uint32_t>(k); }
inline int32_t ci(int64_t c) { return static_cast<int32_t>(c >> 32); }
inline int32_t ck(int64_t c) { return static_cast<int32_t>(static_cast<uint32_t>(c & 0xffffffffLL)); }

/** sliceM: slice height; cellM: plan cell; closeM: gaps in a slice's sampled shell bridged before filling (a corner can miss its samples). */
struct SliceParams { double sliceM = 1.0, cellM = 0.5, closeM = 1.0; };
struct Slice { double y0, y1; CellSet cells; };

namespace detail {
inline CellSet dilate(const CellSet& cells, int r) {
    CellSet grown;
    for (int64_t c : cells) for (int di = -r; di <= r; ++di) for (int dk = -r; dk <= r; ++dk) grown.insert(ckey(ci(c) + di, ck(c) + dk));
    return grown;
}
inline CellSet erode(const CellSet& cells, int r) {
    CellSet out;
    for (int64_t c : cells) {
        bool all = true;
        for (int di = -r; di <= r && all; ++di) for (int dk = -r; dk <= r; ++dk) if (!cells.count(ckey(ci(c) + di, ck(c) + dk))) { all = false; break; }
        if (all) out.insert(c);
    }
    return out;
}
inline CellSet fill(const CellSet& cells) {
    if (cells.empty()) return cells;
    int32_t i0 = INT32_MAX, i1 = INT32_MIN, k0 = INT32_MAX, k1 = INT32_MIN;
    for (int64_t c : cells) { i0 = std::min(i0, ci(c)); i1 = std::max(i1, ci(c)); k0 = std::min(k0, ck(c)); k1 = std::max(k1, ck(c)); }
    --i0; --k0; ++i1; ++k1;
    const int W = i1 - i0 + 1, H = k1 - k0 + 1;
    std::vector<uint8_t> outside(static_cast<size_t>(W) * H, 0);
    std::vector<int> stack{0};
    outside[0] = 1;
    while (!stack.empty()) {
        const int p = stack.back(); stack.pop_back();
        const int i = p % W, k = p / W;
        const int nb[4][2] = {{1, 0}, {-1, 0}, {0, 1}, {0, -1}};
        for (const auto& d : nb) {
            const int ii = i + d[0], kk = k + d[1];
            if (ii < 0 || kk < 0 || ii >= W || kk >= H) continue;
            const int q = kk * W + ii;
            if (outside[q] || cells.count(ckey(ii + i0, kk + k0))) continue;
            outside[q] = 1;
            stack.push_back(q);
        }
    }
    CellSet out;
    for (int k = 0; k < H; ++k) for (int i = 0; i < W; ++i) if (!outside[k * W + i]) out.insert(ckey(i + i0, k + k0));
    return out;
}
}  // namespace detail

inline std::vector<Slice> slices(const std::vector<Vec3>& samples, double baseY, const SliceParams& p = {}) {
    double top = -std::numeric_limits<double>::infinity();
    for (const auto& s : samples) top = std::max<double>(top, s.y);
    const int n = std::max(0, static_cast<int>(std::ceil((top - baseY) / p.sliceM)));
    std::vector<CellSet> raw(n);
    for (const auto& s : samples) {
        const int sl = static_cast<int>(std::floor((s.y - baseY) / p.sliceM));
        if (sl < 0 || sl >= n) continue;
        raw[sl].insert(ckey(static_cast<int32_t>(std::floor(s.x / p.cellM)), static_cast<int32_t>(std::floor(s.z / p.cellM))));
    }
    std::vector<Slice> out(n);
    // the shell grown by the gap it may have, filled, and the solid shrunk back by as much: a missing corner of a sampled
    // shell no longer lets the fill leak in, and a square corner comes back exact
    const int r = std::max(1, static_cast<int>(std::lround(p.closeM / p.cellM)));
    for (int s = 0; s < n; ++s) out[s] = {baseY + s * p.sliceM, baseY + (s + 1) * p.sliceM, raw[s].empty() ? CellSet{} : detail::erode(detail::fill(detail::dilate(raw[s], r)), r)};
    return out;
}

// ---------------------------------------------------------------------------------------------------------------------
// Pieces, outlines and runs
// ---------------------------------------------------------------------------------------------------------------------

struct Piece { int slice; CellSet cells; std::vector<P2> ring; P2 centre; };

/** The outer boundary of a 4-connected cell set, in cell units (corners), counter-clockwise; empty when degenerate. */
inline std::vector<P2> outline(const CellSet& cells) {
    std::unordered_map<int64_t, std::vector<int64_t>> out;
    auto edge = [&](int32_t ax, int32_t az, int32_t bx, int32_t bz) { out[ckey(ax, az)].push_back(ckey(bx, bz)); };
    for (int64_t c : cells) {
        const int32_t x = ci(c), z = ck(c);
        if (!cells.count(ckey(x, z - 1))) edge(x, z, x + 1, z);
        if (!cells.count(ckey(x + 1, z))) edge(x + 1, z, x + 1, z + 1);
        if (!cells.count(ckey(x, z + 1))) edge(x + 1, z + 1, x, z + 1);
        if (!cells.count(ckey(x - 1, z))) edge(x, z + 1, x, z);
    }
    // used edges by their exact ends (a hash of the two corners can collide and end a loop early)
    std::set<std::pair<int64_t, int64_t>> used;
    auto ekey = [](int64_t a, int64_t b) { return std::make_pair(a, b); };
    std::vector<P2> best;
    double bestArea = 0;
    for (const auto& [start, outs] : out) for (int64_t first : outs) {
        if (used.count(ekey(start, first))) continue;
        std::vector<P2> loop{{static_cast<double>(ci(start)), static_cast<double>(ck(start))}};
        int64_t prev = start, cur = first;
        used.insert(ekey(start, first));
        size_t guard = 0;
        while (cur != start && guard++ < cells.size() * 4 + 8) {
            loop.push_back({static_cast<double>(ci(cur)), static_cast<double>(ck(cur))});
            const auto it = out.find(cur);
            if (it == out.end()) break;
            // the left-most turn where two cells touch only at a corner
            const double dx = ci(cur) - ci(prev), dz = ck(cur) - ck(prev);
            // (a corner key is negative wherever x is, so "none found" is a flag, not a sentinel key)
            int64_t pick = 0;
            bool found = false;
            double bestTurn = -10;
            for (int64_t nx : it->second) {
                if (used.count(ekey(cur, nx))) continue;
                const double ex = ci(nx) - ci(cur), ez = ck(nx) - ck(cur);
                const double turn = std::atan2(dx * ez - dz * ex, dx * ex + dz * ez);
                if (turn > bestTurn) { bestTurn = turn; pick = nx; found = true; }
            }
            if (!found) break;
            used.insert(ekey(cur, pick));
            prev = cur;
            cur = pick;
        }
        double a2 = 0;
        for (size_t i = 0, j = loop.size() - 1; i < loop.size(); j = i++) a2 += loop[j].x * loop[i].z - loop[i].x * loop[j].z;
        if (std::abs(a2) > bestArea) { bestArea = std::abs(a2); best = loop; }
    }
    return best;
}

/** The outline (metres) of the largest piece of every slice's cells together: a scan's plan, for its block. */
inline std::vector<P2> planOutline(const std::vector<Slice>& sl, double cellM) {
    CellSet all;
    for (const auto& s : sl) all.insert(s.cells.begin(), s.cells.end());
    Slice u{0, 0, std::move(all)};
    std::vector<P2> best;
    size_t bestCells = 0;
    CellSet seen;
    for (int64_t c : u.cells) {
        if (seen.count(c)) continue;
        CellSet comp{c};
        std::vector<int64_t> stack{c};
        seen.insert(c);
        while (!stack.empty()) {
            const int64_t q = stack.back(); stack.pop_back();
            const int64_t nb[4] = {ckey(ci(q) + 1, ck(q)), ckey(ci(q) - 1, ck(q)), ckey(ci(q), ck(q) + 1), ckey(ci(q), ck(q) - 1)};
            for (int64_t n : nb) if (u.cells.count(n) && !seen.count(n)) { seen.insert(n); comp.insert(n); stack.push_back(n); }
        }
        if (comp.size() <= bestCells) continue;
        bestCells = comp.size();
        best = outline(comp);
    }
    for (auto& p : best) { p.x *= cellM; p.z *= cellM; }
    return best;
}

/**
 * One outline for a footprint given in many rings (a building's extruded parts, or the triangles of a modelled volume
 * seen from above): every ring filled (even-odd each) onto cellM cells, and the outline of the largest connected piece.
 */
inline std::vector<P2> planUnion(const std::vector<std::vector<P2>>& rings, double cellM = 0.5) {
    CellSet cells;
    for (const auto& r : rings) {
        if (r.size() < 3) continue;
        double xa = 1e18, xb = -1e18, za = 1e18, zb = -1e18;
        for (const auto& p : r) { xa = std::min(xa, p.x); xb = std::max(xb, p.x); za = std::min(za, p.z); zb = std::max(zb, p.z); }
        const std::vector<std::vector<P2>> one{r};
        for (int32_t k = static_cast<int32_t>(std::floor(za / cellM)); k <= static_cast<int32_t>(std::floor(zb / cellM)); ++k)
            for (int32_t i = static_cast<int32_t>(std::floor(xa / cellM)); i <= static_cast<int32_t>(std::floor(xb / cellM)); ++i)
                if (inRings(one, (i + 0.5) * cellM, (k + 0.5) * cellM)) cells.insert(ckey(i, k));
    }
    Slice all{0, 0, std::move(cells)};
    return planOutline({all}, cellM);
}

inline std::vector<Piece> pieces(const Slice& s, int sliceIndex, double cellM, double minPieceM2) {
    std::vector<Piece> out;
    CellSet seen;
    const size_t minCells = static_cast<size_t>(std::ceil(minPieceM2 / (cellM * cellM)));
    for (int64_t c : s.cells) {
        if (seen.count(c)) continue;
        CellSet comp{c};
        std::vector<int64_t> stack{c};
        seen.insert(c);
        while (!stack.empty()) {
            const int64_t q = stack.back(); stack.pop_back();
            const int64_t nb[4] = {ckey(ci(q) + 1, ck(q)), ckey(ci(q) - 1, ck(q)), ckey(ci(q), ck(q) + 1), ckey(ci(q), ck(q) - 1)};
            for (int64_t n : nb) if (s.cells.count(n) && !seen.count(n)) { seen.insert(n); comp.insert(n); stack.push_back(n); }
        }
        if (comp.size() < minCells) continue;
        auto loop = outline(comp);
        if (loop.size() < 3) continue;
        for (auto& p : loop) { p.x *= cellM; p.z *= cellM; }
        double cx = 0, cz = 0;
        for (int64_t q : comp) { cx += (ci(q) + 0.5) * cellM; cz += (ck(q) + 0.5) * cellM; }
        const double n = static_cast<double>(comp.size());
        out.push_back({sliceIndex, std::move(comp), std::move(loop), {cx / n, cz / n}});
    }
    return out;
}

/** The ring resampled to n points by arc length, counter-clockwise, from the bearing +x of `centre`. */
inline std::vector<P2> resampleRing(const std::vector<P2>& ringIn, P2 centre, int n) {
    std::vector<P2> r = ringIn;
    double a2 = 0;
    for (size_t i = 0, j = r.size() - 1; i < r.size(); j = i++) a2 += r[j].x * r[i].z - r[i].x * r[j].z;
    if (a2 < 0) std::reverse(r.begin(), r.end());
    const size_t m = r.size();
    double start = 0, best = -std::numeric_limits<double>::infinity();
    for (size_t i = 0; i < m; ++i) {
        const P2 a = r[i], b = r[(i + 1) % m];
        if ((a.z - centre.z) * (b.z - centre.z) > 0 || a.z == b.z) continue;
        const double t = (centre.z - a.z) / (b.z - a.z), x = a.x + t * (b.x - a.x);
        if (x > centre.x && x > best) { best = x; start = i + t; }
    }
    std::vector<double> seg(m + 1, 0);
    for (size_t i = 0; i < m; ++i) seg[i + 1] = seg[i] + std::hypot(r[(i + 1) % m].x - r[i].x, r[(i + 1) % m].z - r[i].z);
    const double L = seg[m];
    auto at = [&](double d) {
        d = std::fmod(std::fmod(d, L) + L, L);
        size_t i = 0;
        while (i < m - 1 && seg[i + 1] < d) ++i;
        const double t = (d - seg[i]) / std::max(1e-12, seg[i + 1] - seg[i]);
        const P2 a = r[i], b = r[(i + 1) % m];
        return P2{a.x + t * (b.x - a.x), a.z + t * (b.z - a.z)};
    };
    const size_t i0 = static_cast<size_t>(std::floor(start));
    const double d0 = seg[i0] + (start - i0) * (seg[std::min(i0 + 1, m)] - seg[i0]);
    std::vector<P2> out(n);
    for (int k = 0; k < n; ++k) out[k] = at(d0 + k * L / n);
    return out;
}

struct LoftParams { double linkIoU = 0.35, linkStepShare = 0.6, linkMinStepM = 0.6; int ringPoints = 48; double keepTolM = 0.4, minPieceM2 = 0.5; };
struct Ring { double y; std::vector<P2> pts; };
struct LoftRun { double y0, y1; std::vector<Ring> rings; };

namespace detail {
inline double iou(const CellSet& a, const CellSet& b) {
    size_t inter = 0;
    for (int64_t c : a) if (b.count(c)) inter++;
    const size_t uni = a.size() + b.size() - inter;
    return uni ? static_cast<double>(inter) / uni : 0;
}
/** Douglas-Peucker on a closed ring (split at its two farthest points). */
inline std::vector<P2> simplify(const std::vector<P2>& ring, double tol) {
    if (ring.size() <= 4) return ring;
    std::function<void(const std::vector<P2>&, size_t, size_t, std::vector<uint8_t>&)> dp = [&](const std::vector<P2>& r, size_t a, size_t b, std::vector<uint8_t>& keep) {
        if (b <= a + 1) return;
        const double L = std::max(1e-9, std::hypot(r[b].x - r[a].x, r[b].z - r[a].z));
        double best = -1; size_t bi = a;
        for (size_t i = a + 1; i < b; ++i) {
            const double d = std::abs((r[b].x - r[a].x) * (r[a].z - r[i].z) - (r[a].x - r[i].x) * (r[b].z - r[a].z)) / L;
            if (d > best) { best = d; bi = i; }
        }
        if (best > tol) { keep[bi] = 1; dp(r, a, bi, keep); dp(r, bi, b, keep); }
    };
    size_t far = 0; double fd = -1;
    for (size_t i = 1; i < ring.size(); ++i) { const double d = std::hypot(ring[i].x - ring[0].x, ring[i].z - ring[0].z); if (d > fd) { fd = d; far = i; } }
    std::vector<P2> closed(ring); closed.push_back(ring[0]);
    std::vector<uint8_t> keep(closed.size(), 0);
    keep[0] = keep[far] = keep[closed.size() - 1] = 1;
    dp(closed, 0, far, keep);
    dp(closed, far, closed.size() - 1, keep);
    std::vector<P2> out;
    for (size_t i = 0; i + 1 < closed.size(); ++i) if (keep[i]) out.push_back(closed[i]);
    return out.size() >= 3 ? out : ring;
}
inline std::vector<Ring> thin(const std::vector<Ring>& rings, double tol) {
    if (rings.size() <= 2) return rings;
    std::vector<Ring> kept{rings.front()};
    size_t anchor = 0;
    for (size_t i = 2; i < rings.size(); ++i) {
        const Ring &a = rings[anchor], &b = rings[i];
        bool ok = true;
        for (size_t j = anchor + 1; j < i && ok; ++j) {
            const double t = (rings[j].y - a.y) / std::max(1e-9, b.y - a.y);
            for (size_t k = 0; k < a.pts.size(); ++k) {
                const double x = a.pts[k].x + t * (b.pts[k].x - a.pts[k].x), z = a.pts[k].z + t * (b.pts[k].z - a.pts[k].z);
                if (std::hypot(x - rings[j].pts[k].x, z - rings[j].pts[k].z) > tol) { ok = false; break; }
            }
        }
        if (!ok) { kept.push_back(rings[i - 1]); anchor = i - 1; }
    }
    kept.push_back(rings.back());
    return kept;
}
}  // namespace detail

inline std::vector<LoftRun> loftRuns(const std::vector<Slice>& sl, double cellM, const LoftParams& P = {}) {
    std::vector<std::vector<Piece>> per(sl.size());
    for (size_t s = 0; s < sl.size(); ++s) per[s] = pieces(sl[s], static_cast<int>(s), cellM, P.minPieceM2);
    auto affinity = [&](const Piece& a, const Piece& b) {
        const double o = detail::iou(a.cells, b.cells);
        if (o >= P.linkIoU) return 1 + o;
        const double step = std::max(P.linkMinStepM, P.linkStepShare * std::sqrt(std::min(a.cells.size(), b.cells.size()) * cellM * cellM));
        const double d = std::hypot(a.centre.x - b.centre.x, a.centre.z - b.centre.z);
        const double ratio = static_cast<double>(std::min(a.cells.size(), b.cells.size())) / std::max(a.cells.size(), b.cells.size());
        return d <= step && ratio >= 0.35 ? 1 - d / step : 0.0;
    };
    // next[s][i]: index in slice s+1 of piece i's continuation, or -1; mutual best only
    std::vector<std::vector<int>> next(sl.size()), prev(sl.size());
    for (size_t s = 0; s < sl.size(); ++s) { next[s].assign(per[s].size(), -1); prev[s].assign(per[s].size(), -1); }
    for (size_t s = 0; s + 1 < sl.size(); ++s) {
        for (size_t a = 0; a < per[s].size(); ++a) {
            int bBest = -1; double v = 0;
            for (size_t b = 0; b < per[s + 1].size(); ++b) { const double w = affinity(per[s][a], per[s + 1][b]); if (w > v) { v = w; bBest = static_cast<int>(b); } }
            if (bBest < 0) continue;
            int aBest = -1; v = 0;
            for (size_t q = 0; q < per[s].size(); ++q) { const double w = affinity(per[s][q], per[s + 1][bBest]); if (w > v) { v = w; aBest = static_cast<int>(q); } }
            if (aBest == static_cast<int>(a)) { next[s][a] = bBest; prev[s + 1][bBest] = static_cast<int>(a); }
        }
    }
    std::vector<LoftRun> runs;
    for (size_t s = 0; s < sl.size(); ++s) for (size_t h = 0; h < per[s].size(); ++h) {
        if (prev[s][h] >= 0) continue;
        std::vector<std::pair<size_t, size_t>> chain{{s, h}};
        while (chain.back().first + 1 < sl.size() && next[chain.back().first][chain.back().second] >= 0)
            chain.push_back({chain.back().first + 1, static_cast<size_t>(next[chain.back().first][chain.back().second])});
        std::vector<Ring> rings;
        for (size_t i = 0; i < chain.size(); ++i) {
            const Piece& p = per[chain[i].first][chain[i].second];
            const Slice& S = sl[chain[i].first];
            const double y = i == 0 ? S.y0 : i == chain.size() - 1 ? S.y1 : 0.5 * (S.y0 + S.y1);
            rings.push_back({y, resampleRing(p.ring, p.centre, P.ringPoints)});
        }
        if (chain.size() == 1) rings = {{sl[s].y0, rings[0].pts}, {sl[s].y1, rings[0].pts}};
        runs.push_back({rings.front().y, rings.back().y, detail::thin(rings, P.keepTolM)});
    }
    return runs;
}

/** Each run skinned by Loft3D into a closed solid, all in one mesh. */
inline ScratchboxMesh loftSolids(const std::vector<LoftRun>& runs) {
    ScratchboxMesh all("scan_loft");
    for (const auto& r : runs) {
        if (r.rings.size() < 2) continue;
        std::vector<std::vector<Vec3>> rings;
        for (const auto& ring : r.rings) {
            std::vector<Vec3> pts;
            for (const auto& p : ring.pts) pts.push_back(Vec3(static_cast<float>(p.x), static_cast<float>(ring.y), static_cast<float>(p.z)));
            rings.push_back(std::move(pts));
        }
        const ScratchboxMesh m = shaper::Loft3D::skin(rings, true);
        const uint32_t base = static_cast<uint32_t>(all.vertices.size());
        for (const auto& v : m.vertices) all.vertices.push_back(v);
        for (uint32_t i : m.indices) all.indices.push_back(base + i);
    }
    all.recomputeBounds();
    return all;
}

struct SnapEdge { double shiftM; size_t support; bool moved; };

/**
 * The footprint with each edge moved along its own normal onto the scan's wall: for every edge, the samples standing
 * beside it (projecting inside its length, above street level, within searchM of its line) vote for their offset in
 * binM bins; the edge moves to the densest bin when it holds at least minShare of the edge's expected samples
 * (length x height / spacing^2). Consecutive moved edges are re-intersected (parallel ones keep the moved midpoint).
 * The footprint's shape stays what the map says; where its walls stand is what the scan says.
 */
inline std::vector<P2> snapPlanToScan(const std::vector<P2>& ring, const std::vector<Vec3>& samples, double groundY, double topY, double searchM = 3.0,
                                      double binM = 0.25, double minShare = 0.15, double spacing = 0.5, std::vector<SnapEdge>* report = nullptr) {
    const size_t n = ring.size();
    if (n < 3) return ring;
    double a2 = 0;
    for (size_t i = 0, j = n - 1; i < n; j = i++) a2 += ring[j].x * ring[i].z - ring[i].x * ring[j].z;
    const double outwardSign = a2 > 0 ? 1.0 : -1.0;  // the normal (dz, -dx) points out of a ring of this winding
    struct Line { P2 p, d, nrm; };
    std::vector<Line> lines(n);
    for (size_t i = 0; i < n; ++i) {
        const P2 a = ring[i], b = ring[(i + 1) % n];
        const double L = std::max(1e-9, std::hypot(b.x - a.x, b.z - a.z));
        const P2 d{(b.x - a.x) / L, (b.z - a.z) / L};
        const P2 nrm{outwardSign * d.z, -outwardSign * d.x};
        const int bins = static_cast<int>(std::ceil(2 * searchM / binM));
        std::vector<size_t> votes(bins, 0);
        for (const auto& s : samples) {
            if (s.y < groundY + 1.0 || s.y > topY) continue;
            const double rx = s.x - a.x, rz = s.z - a.z, along = rx * d.x + rz * d.z, off = rx * nrm.x + rz * nrm.z;
            if (along < 0.1 * L || along > 0.9 * L || std::abs(off) >= searchM) continue;
            votes[std::min(bins - 1, static_cast<int>((off + searchM) / binM))]++;
        }
        size_t best = 0; int bi = -1;
        for (int k = 0; k < bins; ++k) if (votes[k] > best) { best = votes[k]; bi = k; }
        const double expected = 0.8 * L * std::max(1.0, topY - groundY - 1.0) / (spacing * spacing);
        const bool moved = bi >= 0 && best >= minShare * expected;
        const double shift = moved ? -searchM + (bi + 0.5) * binM : 0.0;
        if (report) report->push_back({shift, best, moved});
        lines[i] = {{a.x + nrm.x * shift, a.z + nrm.z * shift}, d, nrm};
    }
    std::vector<P2> out(n);
    for (size_t i = 0; i < n; ++i) {
        const Line& l0 = lines[(i + n - 1) % n];
        const Line& l1 = lines[i];
        const double den = l0.d.x * l1.d.z - l0.d.z * l1.d.x;
        if (std::abs(den) < 1e-6) { out[i] = l1.p; continue; }
        const double t = ((l1.p.x - l0.p.x) * l1.d.z - (l1.p.z - l0.p.z) * l1.d.x) / den;
        out[i] = {l0.p.x + t * l0.d.x, l0.p.z + t * l0.d.z};
    }
    return out;
}

/**
 * The ring straightened toward two directions at right angles (axisRad and axisRad + 90 degrees): after a light
 * simplification, every edge within tolDeg of one of them is turned onto it about its midpoint, and consecutive edges
 * are re-intersected (an edge left off-axis keeps its own direction). Short edges that end up parallel to both
 * neighbours are dropped. A footprint traced from pixels or cells comes back with the building's own right angles.
 */
inline std::vector<P2> squareToAxes(const std::vector<P2>& ringIn, double axisRad, double tolDeg, double simplifyTol) {
    std::vector<P2> r = detail::simplify(ringIn, simplifyTol);
    const size_t n = r.size();
    if (n < 4) return r;
    struct L { P2 p, d; };
    std::vector<L> lines(n);
    const double tol = tolDeg * M_PI / 180;
    for (size_t i = 0; i < n; ++i) {
        const P2 a = r[i], b = r[(i + 1) % n];
        const P2 m{(a.x + b.x) / 2, (a.z + b.z) / 2};
        double ang = std::atan2(b.z - a.z, b.x - a.x);
        // nearest of the four axis directions
        double best = ang, bd = 1e9;
        for (int q = 0; q < 4; ++q) {
            const double t = axisRad + q * M_PI / 2;
            const double dd = std::abs(std::remainder(ang - t, 2 * M_PI));
            if (dd < bd) { bd = dd; best = t; }
        }
        if (bd <= tol) ang = best;
        lines[i] = {m, {std::cos(ang), std::sin(ang)}};
    }
    std::vector<P2> out;
    for (size_t i = 0; i < n; ++i) {
        const L& l0 = lines[(i + n - 1) % n];
        const L& l1 = lines[i];
        const double den = l0.d.x * l1.d.z - l0.d.z * l1.d.x;
        if (std::abs(den) < 1e-6) continue;  // parallel neighbours: the corner between them is not a corner
        const double t = ((l1.p.x - l0.p.x) * l1.d.z - (l1.p.z - l0.p.z) * l1.d.x) / den;
        const P2 c{l0.p.x + t * l0.d.x, l0.p.z + t * l0.d.z};
        // a re-intersection far from the original corner means the edges were nearly parallel: keep the original corner
        out.push_back(std::hypot(c.x - r[i].x, c.z - r[i].z) > 4 * simplifyTol + 0.5 ? r[i] : c);
    }
    return out.size() >= 3 ? out : r;
}

/** A footprint ring (x, z) extruded from y0 to y1: walls and caps (the plainest candidate). */
inline ScratchboxMesh extrudeBlock(const std::vector<P2>& ring, double y0, double y1) {
    std::vector<std::vector<Vec3>> rings(2);
    for (const auto& p : ring) { rings[0].push_back(Vec3(static_cast<float>(p.x), static_cast<float>(y0), static_cast<float>(p.z))); rings[1].push_back(Vec3(static_cast<float>(p.x), static_cast<float>(y1), static_cast<float>(p.z))); }
    ScratchboxMesh m = shaper::Loft3D::skin(rings, true);
    m.name = "block";
    return m;
}

// ---------------------------------------------------------------------------------------------------------------------
// Tiers: a stack of clean blocks, one per setback
// ---------------------------------------------------------------------------------------------------------------------

struct TierParams {
    /** A slice whose plan area differs from its tier's by more than this share starts a new tier. */
    double changeShare = 0.15;
    /** Tiers shorter than this are merged into the tier below (m). */
    double minTierM = 3.0;
    /** A cell belongs to a tier's outline when this share of the tier's slices holds it. */
    double presence = 0.3;
    double squareTolDeg = 15;
};
struct Tier { double y0, y1, areaM2; std::vector<P2> outline; };

/**
 * The structure as a stack of tiers: the scan's slices grouped where the plan area holds steady, each tier's outline
 * the cells most of its slices share (presence), squared to the building's wall directions (the axis of the longest
 * edge of the lowest tier) and its edges snapped onto that tier's own scanned walls, raised between its own heights.
 */
inline std::vector<Tier> tiers(const std::vector<Vec3>& samples, double baseY, const TierParams& T = {}, const SliceParams& S = {}) {
    const auto sl = slices(samples, baseY, S);
    std::vector<double> area(sl.size());
    for (size_t i = 0; i < sl.size(); ++i) area[i] = sl[i].cells.size() * S.cellM * S.cellM;
    // the area smoothed over three slices (one noisy slice does not start a tier)
    std::vector<double> sm(area);
    for (size_t i = 1; i + 1 < area.size(); ++i) { double a[3] = {area[i - 1], area[i], area[i + 1]}; std::sort(a, a + 3); sm[i] = a[1]; }
    std::vector<std::pair<size_t, size_t>> runs;
    size_t start = 0;
    double ref = 0;
    for (size_t i = 0; i < sm.size(); ++i) {
        if (sm[i] < 1.0) { if (i > start) runs.push_back({start, i}); start = i + 1; ref = 0; continue; }
        if (ref <= 0) { ref = sm[i]; continue; }
        if (std::abs(sm[i] - ref) > T.changeShare * ref) { runs.push_back({start, i}); start = i; ref = sm[i]; }
    }
    if (start < sm.size()) runs.push_back({start, sm.size()});
    // short tiers merged into the one below
    std::vector<std::pair<size_t, size_t>> merged;
    for (const auto& r : runs) {
        if (!merged.empty() && (r.second - r.first) * S.sliceM < T.minTierM && merged.back().second == r.first) merged.back().second = r.second;
        else merged.push_back(r);
    }
    std::vector<Tier> out;
    double axis = 0;
    bool haveAxis = false;
    for (const auto& [a, b] : merged) {
        if (b <= a) continue;
        std::unordered_map<int64_t, int> votes;
        for (size_t i = a; i < b; ++i) for (int64_t c : sl[i].cells) votes[c]++;
        CellSet cells;
        const int need = std::max(1, static_cast<int>(std::ceil(T.presence * (b - a))));
        for (const auto& [c, v] : votes) if (v >= need) cells.insert(c);
        if (cells.size() * S.cellM * S.cellM < 2.0) continue;
        auto ring = planOutline({Slice{0, 0, std::move(cells)}}, S.cellM);
        if (ring.size() < 3) continue;
        if (!haveAxis) {
            const auto simp = detail::simplify(ring, 0.5);
            double longest = -1;
            for (size_t i = 0; i < simp.size(); ++i) { const P2 p = simp[i], q = simp[(i + 1) % simp.size()]; const double L = std::hypot(q.x - p.x, q.z - p.z); if (L > longest) { longest = L; axis = std::atan2(q.z - p.z, q.x - p.x); } }
            haveAxis = true;
        }
        ring = squareToAxes(ring, axis, T.squareTolDeg, 0.35);
        const double y0 = sl[a].y0, y1 = sl[b - 1].y1;
        std::vector<Vec3> own;
        for (const auto& p : samples) if (p.y >= y0 && p.y <= y1) own.push_back(p);
        ring = snapPlanToScan(ring, own, y0 - 1.0, y1, 2.0, 0.25, 0.15, S.cellM);
        double a2 = 0;
        for (size_t i = 0, j = ring.size() - 1; i < ring.size(); j = i++) a2 += ring[j].x * ring[i].z - ring[i].x * ring[j].z;
        out.push_back({y0, y1, std::abs(a2) / 2, ring});
    }
    return out;
}

/** The tiers raised into one mesh. */
inline ScratchboxMesh tierSolids(const std::vector<Tier>& ts) {
    ScratchboxMesh all("tiers");
    for (const auto& t : ts) {
        const ScratchboxMesh m = extrudeBlock(t.outline, t.y0, t.y1);
        const uint32_t base = static_cast<uint32_t>(all.vertices.size());
        for (const auto& v : m.vertices) all.vertices.push_back(v);
        for (uint32_t i : m.indices) all.indices.push_back(base + i);
    }
    all.recomputeBounds();
    return all;
}

// ---------------------------------------------------------------------------------------------------------------------
// Choice
// ---------------------------------------------------------------------------------------------------------------------

struct ChoiceParams { double minCoverage = 0.9, minPrecision = 0.85; };
struct CandidateRow { std::string label; size_t triangles; Agreement agreement; bool accepted; std::string reason; };
struct Choice { int chosen = -1; bool explains = false; std::string why; std::vector<CandidateRow> rows; };

inline std::string fmt3(double v) { char b[32]; std::snprintf(b, sizeof b, "%.3f", v); return b; }

/** `ordered` simplest first: the first explaining the scan wins, else the best height-balanced F (explains false). */
inline Choice choose(const std::vector<std::pair<std::string, std::pair<size_t, Agreement>>>& ordered, const ChoiceParams& P = {}) {
    Choice c;
    for (const auto& [label, ta] : ordered) {
        const Agreement& a = ta.second;
        std::string reason;
        if (a.bandedCoverage < P.minCoverage) reason += "covers " + fmt3(a.bandedCoverage) + " of the scan (< " + fmt3(P.minCoverage) + ")";
        if (a.bandedPrecision < P.minPrecision) reason += std::string(reason.empty() ? "" : "; ") + fmt3(a.bandedPrecision) + " of its surface is supported (< " + fmt3(P.minPrecision) + ")";
        const bool ok = reason.empty();
        if (ok) reason = "explains the scan (coverage " + fmt3(a.bandedCoverage) + ", precision " + fmt3(a.bandedPrecision) + ")";
        c.rows.push_back({label, ta.first, a, ok, reason});
    }
    for (size_t i = 0; i < c.rows.size(); ++i) if (c.rows[i].accepted) {
        c.chosen = static_cast<int>(i);
        c.explains = true;
        c.why = c.rows[i].label + ": the simplest candidate that " + c.rows[i].reason;
        return c;
    }
    double best = -1;
    for (size_t i = 0; i < c.rows.size(); ++i) if (c.rows[i].agreement.bandedF > best) { best = c.rows[i].agreement.bandedF; c.chosen = static_cast<int>(i); }
    if (c.chosen >= 0) c.why = "no candidate explains the scan within tolerance; " + c.rows[c.chosen].label + " fits best (height-balanced F " + fmt3(best) + ")";
    return c;
}

}  // namespace scan_massing
}  // namespace scratchbox
