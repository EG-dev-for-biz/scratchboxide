/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

#pragma once

/**
 * kNN statistical floater pruning for baked splat sets. Same algorithm as
 * packages/core/src/common/spatial/splat-floater-pruning.ts:
 *   d_i  = mean distance to the k nearest neighbours (exact k-d tree query)
 *   r_i  = d_i / min{ d_j : j in kNN(i) }       (normalize = true; else r_i = d_i)
 *   tau  = max(mean(r) + lambda * std(r), minRatio), mean/std re-estimated over r <= tau until stable (sigma clipping)
 * Splats with r_i > tau are dropped; survivors that had a dropped neighbour are re-tested (up to `passes`) against the
 * same tau with the dropped splats removed. Deterministic: depends only on the point set and its order.
 */

#include "scratchbox_spz.hpp"
#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <limits>
#include <vector>

namespace scratchbox {
namespace splatprune {

struct FloaterPruneOptions {
    bool enabled{true};
    int k{16};
    double lambda{3.0};
    double minRatio{2.0};
    bool normalize{true};
    int passes{3};
};

struct FloaterPruneReport {
    size_t input{0};
    size_t kept{0};
    size_t pruned{0};
    int k{0};
    double statMean{0.0};
    double statStd{0.0};
    double threshold{std::numeric_limits<double>::infinity()};
    double ms{0.0};
};

class KdTree {
public:
    KdTree(const std::vector<double>& p, const std::vector<int32_t>& ids) : p_(p), perm_(ids), axis_(ids.size(), 0) {
        build(0, static_cast<int64_t>(perm_.size()));
    }

    // k nearest neighbours of point q (excluding q), squared distances ascending.
    void knn(int32_t q, int k, std::vector<double>& d2, std::vector<int32_t>& idx) const {
        std::fill(d2.begin(), d2.begin() + k, std::numeric_limits<double>::infinity());
        std::fill(idx.begin(), idx.begin() + k, -1);
        const double qx = p_[q * 3], qy = p_[q * 3 + 1], qz = p_[q * 3 + 2];
        double worst = std::numeric_limits<double>::infinity();
        auto consider = [&](int32_t j) {
            if (j == q) return;
            const double dx = p_[j * 3] - qx, dy = p_[j * 3 + 1] - qy, dz = p_[j * 3 + 2] - qz;
            const double dd = dx * dx + dy * dy + dz * dz;
            if (dd >= worst) return;
            int s = k - 1;
            while (s > 0 && d2[s - 1] > dd) { d2[s] = d2[s - 1]; idx[s] = idx[s - 1]; --s; }
            d2[s] = dd; idx[s] = j; worst = d2[k - 1];
        };
        struct Item { int64_t lo, hi; double bound; };
        Item stack[256];
        int sp = 0;
        stack[sp++] = {0, static_cast<int64_t>(perm_.size()), 0.0};
        while (sp > 0) {
            const Item it = stack[--sp];
            if (it.bound >= worst) continue;
            if (it.hi - it.lo <= kLeaf) {
                for (int64_t i = it.lo; i < it.hi; ++i) consider(perm_[i]);
                continue;
            }
            const int64_t mid = (it.lo + it.hi) >> 1;
            const int32_t j = perm_[mid];
            const int ax = axis_[mid];
            consider(j);
            const double qa = ax == 0 ? qx : ax == 1 ? qy : qz;
            const double diff = qa - p_[j * 3 + ax];
            const double far = diff * diff;
            if (diff < 0) {
                stack[sp++] = {mid + 1, it.hi, far};
                stack[sp++] = {it.lo, mid, it.bound};
            } else {
                stack[sp++] = {it.lo, mid, far};
                stack[sp++] = {mid + 1, it.hi, it.bound};
            }
        }
    }

private:
    static constexpr int64_t kLeaf = 8;
    const std::vector<double>& p_;
    std::vector<int32_t> perm_;
    std::vector<uint8_t> axis_;

    void build(int64_t lo, int64_t hi) {
        while (hi - lo > kLeaf) {
            double mn[3] = {INFINITY, INFINITY, INFINITY}, mx[3] = {-INFINITY, -INFINITY, -INFINITY};
            for (int64_t i = lo; i < hi; ++i) {
                for (int a = 0; a < 3; ++a) {
                    const double v = p_[perm_[i] * 3 + a];
                    mn[a] = std::min(mn[a], v); mx[a] = std::max(mx[a], v);
                }
            }
            const double ex = mx[0] - mn[0], ey = mx[1] - mn[1], ez = mx[2] - mn[2];
            const int ax = (ex >= ey && ex >= ez) ? 0 : (ey >= ez ? 1 : 2);
            const int64_t mid = (lo + hi) >> 1;
            select(lo, hi - 1, mid, ax);
            axis_[mid] = static_cast<uint8_t>(ax);
            build(lo, mid);
            lo = mid + 1;
        }
    }

    // Quickselect, Hoare partition with middle pivot (identical to the TypeScript version, so both pick the same tree).
    void select(int64_t l, int64_t r, int64_t k, int ax) {
        while (r > l) {
            const double pivot = p_[perm_[(l + r) >> 1] * 3 + ax];
            int64_t i = l, j = r;
            while (i <= j) {
                while (p_[perm_[i] * 3 + ax] < pivot) ++i;
                while (p_[perm_[j] * 3 + ax] > pivot) --j;
                if (i <= j) { std::swap(perm_[i], perm_[j]); ++i; --j; }
            }
            if (k <= j) r = j; else if (k >= i) l = i; else return;
        }
    }
};

/** Keep mask (1 = keep) for `count` xyz triples. */
inline std::vector<uint8_t> computeFloaterKeepMask(const std::vector<double>& pos, const FloaterPruneOptions& opt, FloaterPruneReport* report = nullptr) {
    const auto t0 = std::chrono::steady_clock::now();
    const size_t count = pos.size() / 3;
    std::vector<uint8_t> keep(count, 1);
    FloaterPruneReport rep;
    rep.input = count;
    rep.kept = count;
    const int k = static_cast<int>(std::max<int64_t>(1, std::min<int64_t>(opt.k, static_cast<int64_t>(count) - 1)));
    rep.k = k;
    if (!opt.enabled || count < static_cast<size_t>(k) + 2 || count < 4) {
        if (report) *report = rep;
        return keep;
    }

    std::vector<double> d2(k), meanDist(count), stat(count);
    std::vector<int32_t> idx(k), nbrs(count * static_cast<size_t>(k));
    auto queryMeanDist = [&](const KdTree& tree, const std::vector<int32_t>& ids) {
        for (int32_t i : ids) {
            tree.knn(i, k, d2, idx);
            double s = 0.0;
            for (int j = 0; j < k; ++j) s += std::sqrt(d2[j]);
            meanDist[i] = s / k;
            std::copy(idx.begin(), idx.end(), nbrs.begin() + static_cast<size_t>(i) * k);
        }
    };
    auto computeStat = [&](const std::vector<int32_t>& ids) {
        for (int32_t i : ids) {
            if (!opt.normalize) { stat[i] = meanDist[i]; continue; }
            double ref = std::numeric_limits<double>::infinity();
            for (int j = 0; j < k; ++j) ref = std::min(ref, meanDist[nbrs[static_cast<size_t>(i) * k + j]]);
            stat[i] = ref > 0 ? meanDist[i] / ref : (meanDist[i] > 0 ? std::numeric_limits<double>::infinity() : 1.0);
        }
    };

    std::vector<int32_t> all(count);
    for (size_t i = 0; i < count; ++i) all[i] = static_cast<int32_t>(i);
    {
        KdTree tree(pos, all);
        queryMeanDist(tree, all);
    }
    computeStat(all);

    double mean = 0, stdv = 0, threshold = std::numeric_limits<double>::infinity();
    for (int iter = 0; iter < 20; ++iter) {
        double sum = 0; size_t n = 0;
        for (size_t i = 0; i < count; ++i) if (stat[i] <= threshold) { sum += stat[i]; ++n; }
        if (n == 0) break;
        mean = sum / static_cast<double>(n);
        double v2 = 0;
        for (size_t i = 0; i < count; ++i) if (stat[i] <= threshold) { const double d = stat[i] - mean; v2 += d * d; }
        stdv = std::sqrt(v2 / static_cast<double>(n));
        const double next = opt.normalize ? std::max(mean + opt.lambda * stdv, opt.minRatio) : mean + opt.lambda * stdv;
        if (next == threshold) break;
        threshold = next;
    }
    size_t prunedNow = 0;
    for (size_t i = 0; i < count; ++i) if (stat[i] > threshold) { keep[i] = 0; ++prunedNow; }

    for (int pass = 1; pass < std::max(1, opt.passes) && prunedNow > 0; ++pass) {
        std::vector<int32_t> affected, alive;
        for (size_t i = 0; i < count; ++i) {
            if (!keep[i]) continue;
            alive.push_back(static_cast<int32_t>(i));
            for (int j = 0; j < k; ++j) if (!keep[nbrs[i * k + j]]) { affected.push_back(static_cast<int32_t>(i)); break; }
        }
        if (affected.empty()) break;
        KdTree tree(pos, alive);
        queryMeanDist(tree, affected);
        computeStat(affected);
        prunedNow = 0;
        for (int32_t i : affected) if (stat[i] > threshold) { keep[i] = 0; ++prunedNow; }
    }

    size_t kept = 0;
    for (uint8_t v : keep) kept += v;
    rep.kept = kept;
    rep.pruned = count - kept;
    rep.statMean = mean;
    rep.statStd = stdv;
    rep.threshold = threshold;
    rep.ms = std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - t0).count();
    if (report) *report = rep;
    return keep;
}

/** Drops floaters from a splat list, preserving the order of the kept splats. */
inline std::vector<spz::GaussianSplat> pruneFloaters(const std::vector<spz::GaussianSplat>& splats, const FloaterPruneOptions& opt = {}, FloaterPruneReport* report = nullptr) {
    std::vector<double> pos(splats.size() * 3);
    for (size_t i = 0; i < splats.size(); ++i) {
        pos[i * 3] = splats[i].position.x; pos[i * 3 + 1] = splats[i].position.y; pos[i * 3 + 2] = splats[i].position.z;
    }
    const auto keep = computeFloaterKeepMask(pos, opt, report);
    std::vector<spz::GaussianSplat> out;
    out.reserve(splats.size());
    for (size_t i = 0; i < splats.size(); ++i) if (keep[i]) out.push_back(splats[i]);
    return out;
}

} // namespace splatprune
} // namespace scratchbox
