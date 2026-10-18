/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

#ifndef SCRATCHBOX_MASK_VOTE_HPP
#define SCRATCHBOX_MASK_VOTE_HPP

/**
 * Multi-view mask voting: which triangles of a mesh belong to one object, read from 2D masks of that object in several
 * registered views.
 *
 * Each view brings a triangle-ID buffer (the front-most triangle per pixel, rendered with the view's own pose) and a
 * mask in [0, 1] of the same size (1 = the object, 0 = everything else, < 0 = no information). The mask is smoothed
 * first (a box filter of `edgeBlurPx`), so a pixel on the mask's edge votes about nothing: segmentation edges bleed by a
 * few pixels and a sliver along the outline should not be decided by them. Per view and triangle:
 *   m   = mean over the triangle's pixels of (2 * smoothed mask - 1)                (-1 .. 1)
 *   w   = poseQuality * |cos incidence| * min(1, pixels / footprintRefPx)
 * where the incidence is between the triangle's normal and the direction to the view's eye (a grazing view sees a
 * stretched sliver whose pixels say little), and the pixel term lets a triangle covering a handful of pixels count less
 * than one the view resolves. Over the views:
 *   score  = sum(w * m) / sum(w)     weight = sum(w)
 * A triangle belongs to the object when score >= decisiveScore, to something else when score <= -decisiveScore, both
 * only with weight >= minWeight from at least minViews views; everything else is undecided, with the reason (unseen,
 * too little evidence, or the views disagree), and the caller falls back to its geometric rules there.
 *
 * Masks are open-ended: "the requested structure" against "everything else", never classes. Clean-room: the idea of
 * supervising per-object opacity with multi-view instance masks is from the object-compositional NeRF literature; this
 * is a direct per-triangle vote, no neural field.
 */

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <string>
#include <vector>

namespace scratchbox {
namespace mask_vote {

struct VoteParams {
    double decisiveScore{0.5};   // |score| at least this decides
    double minWeight{0.75};      // and at least this much weight (about one well-resolved, frontal view)
    int minViews{2};             // seen in at least this many views
    int edgeBlurPx{2};           // box-filter radius applied to each mask before voting
    double footprintRefPx{8};    // a triangle covering this many pixels in a view gets that view's full weight
};

/** One registered view: the triangle IDs (-1 = none) and the mask (same size), the eye and the pose quality (0..1). */
struct ViewInput {
    const int32_t* ids{nullptr};
    const float* mask{nullptr};
    int W{0}, H{0};
    double eye[3]{0, 0, 0};
    double poseQuality{1.0};
};

struct TriangleVote {
    float score{0};
    float weight{0};
    uint16_t views{0};
    uint32_t pixels{0};
};

enum class Owner : int8_t { Other = -1, Undecided = 0, Target = 1 };

/** Why a triangle is undecided (or how it was decided). */
inline const char* reasonName(int r) {
    static const char* names[] = {"target", "other", "unseen", "too_little_evidence", "views_disagree"};
    return (r >= 0 && r < 5) ? names[r] : "unknown";
}

inline Owner decide(const TriangleVote& v, const VoteParams& P, int* reason = nullptr) {
    int r;
    Owner o = Owner::Undecided;
    if (v.views == 0 || !(v.weight > 0)) r = 2;
    else if (v.views < P.minViews || v.weight < P.minWeight) r = 3;
    else if (v.score >= P.decisiveScore) { r = 0; o = Owner::Target; }
    else if (v.score <= -P.decisiveScore) { r = 1; o = Owner::Other; }
    else r = 4;
    if (reason) *reason = r;
    return o;
}

/** Box filter of radius r over a mask, ignoring pixels without information (< 0); they stay < 0. */
inline std::vector<float> smoothMask(const float* mask, int W, int H, int r) {
    std::vector<float> out(mask, mask + static_cast<size_t>(W) * H);
    if (r <= 0) return out;
    // separable: rows then columns, each a running sum over the valid pixels
    std::vector<float> tmp(out.size(), -1.0f);
    for (int y = 0; y < H; ++y) {
        const float* row = mask + static_cast<size_t>(y) * W;
        for (int x = 0; x < W; ++x) {
            if (row[x] < 0) continue;
            double s = 0; int n = 0;
            for (int k = std::max(0, x - r); k <= std::min(W - 1, x + r); ++k) if (row[k] >= 0) { s += row[k]; ++n; }
            tmp[static_cast<size_t>(y) * W + x] = static_cast<float>(s / n);
        }
    }
    for (int x = 0; x < W; ++x)
        for (int y = 0; y < H; ++y) {
            const size_t i = static_cast<size_t>(y) * W + x;
            if (tmp[i] < 0) { out[i] = -1.0f; continue; }
            double s = 0; int n = 0;
            for (int k = std::max(0, y - r); k <= std::min(H - 1, y + r); ++k) {
                const float v = tmp[static_cast<size_t>(k) * W + x];
                if (v >= 0) { s += v; ++n; }
            }
            out[i] = static_cast<float>(s / n);
        }
    return out;
}

/**
 * Accumulates the votes of every view for every triangle. `pos` holds 3 floats per vertex, `idx` 3 indices per triangle
 * (the mesh the ID buffers were rendered from).
 */
inline std::vector<TriangleVote> accumulate(const std::vector<ViewInput>& views, const float* pos, const uint32_t* idx, size_t F, const VoteParams& P) {
    std::vector<double> sw(F, 0.0), swm(F, 0.0);
    std::vector<uint16_t> nv(F, 0);
    std::vector<uint32_t> np(F, 0);
    std::vector<uint32_t> cnt(F, 0);
    std::vector<double> sum(F, 0.0);
    std::vector<uint32_t> touched;
    for (const ViewInput& v : views) {
        if (!v.ids || !v.mask || v.W <= 0 || v.H <= 0 || !(v.poseQuality > 0)) continue;
        const std::vector<float> m = smoothMask(v.mask, v.W, v.H, P.edgeBlurPx);
        touched.clear();
        const size_t N = static_cast<size_t>(v.W) * v.H;
        for (size_t i = 0; i < N; ++i) {
            const int32_t t = v.ids[i];
            if (t < 0 || static_cast<size_t>(t) >= F || m[i] < 0) continue;
            if (cnt[t] == 0) touched.push_back(static_cast<uint32_t>(t));
            ++cnt[t];
            sum[t] += 2.0 * m[i] - 1.0;
        }
        for (uint32_t t : touched) {
            const float* a = pos + 3 * idx[3 * t];
            const float* b = pos + 3 * idx[3 * t + 1];
            const float* c = pos + 3 * idx[3 * t + 2];
            const double e1[3] = {b[0] - a[0], b[1] - a[1], b[2] - a[2]}, e2[3] = {c[0] - a[0], c[1] - a[1], c[2] - a[2]};
            const double n[3] = {e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]};
            const double d[3] = {v.eye[0] - (a[0] + b[0] + c[0]) / 3.0, v.eye[1] - (a[1] + b[1] + c[1]) / 3.0, v.eye[2] - (a[2] + b[2] + c[2]) / 3.0};
            const double nn = std::sqrt(n[0] * n[0] + n[1] * n[1] + n[2] * n[2]), dn = std::sqrt(d[0] * d[0] + d[1] * d[1] + d[2] * d[2]);
            const double inc = (nn > 0 && dn > 0) ? std::abs(n[0] * d[0] + n[1] * d[1] + n[2] * d[2]) / (nn * dn) : 0.0;
            const double w = v.poseQuality * inc * std::min(1.0, cnt[t] / std::max(1e-9, P.footprintRefPx));
            const double mean = sum[t] / cnt[t];
            sw[t] += w;
            swm[t] += w * mean;
            np[t] += cnt[t];
            if (nv[t] < 65535) ++nv[t];
            cnt[t] = 0;
            sum[t] = 0;
        }
    }
    std::vector<TriangleVote> out(F);
    for (size_t t = 0; t < F; ++t) {
        out[t].weight = static_cast<float>(sw[t]);
        out[t].score = sw[t] > 0 ? static_cast<float>(swm[t] / sw[t]) : 0.0f;
        out[t].views = nv[t];
        out[t].pixels = np[t];
    }
    return out;
}

}  // namespace mask_vote
}  // namespace scratchbox

#endif  // SCRATCHBOX_MASK_VOTE_HPP
