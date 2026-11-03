/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

#ifndef SCRATCHBOX_WALL_SHEETS_HPP
#define SCRATCHBOX_WALL_SHEETS_HPP

/**
 * A multi-facade wall's sheet photo, natively (packages/core/src/node/3d-engine/staged-location/wall-sheets.ts
 * buildWallSheets, which says what and why; this is its arithmetic, step for step): the members' photos, uncovered and
 * occluded masks decoded, laid on the sheet (each texel from the first member that saw it clear, then one that saw it
 * through something), its coverage measured (facade-lattice.ts wallCoverage), its holes filled from its own repeats
 * (ortho-rectify.ts fillHoles, scratchbox_ortho_rectify.hpp) and then smoothly (smoothFillHoles), and its images' PNG
 * scanlines filtered as png-encode.ts encodePng filters them. The deflate is left to Node's zlib, so the files are
 * encodePng's byte for byte. The frame, the members' maps, the windows and bays stay in the TypeScript.
 * One sheet a task, its members decoded side by side.
 */

#include "scratchbox_js_math.hpp"
#include "scratchbox_ortho_rectify.hpp"
#include "scratchbox_png.hpp"
#include "scratchbox_thread_pool.hpp"

#include <algorithm>
#include <array>
#include <cmath>
#include <cstdint>
#include <cstdlib>
#include <fstream>
#include <iterator>
#include <limits>
#include <stdexcept>
#include <string>
#include <vector>

// V8 never fuses a multiply and an add
#pragma clang fp contract(off)

namespace scratchbox {
namespace wall_sheets {

/** A member in the sheet's order (most of its own wall covered first): its photo and masks by file, its map from the sheet's pixels. */
struct Member {
    std::string image, uncovered, occluded;
    double o[2] = {0, 0}, dx[2] = {0, 0}, dy[2] = {0, 0};
};

struct SheetJob {
    int W = 0, H = 0;
    double px = 0;
    std::vector<Member> members;
};

struct SheetOut {
    /** The images' PNG scanlines (each row's filter type, then its bytes): the filled photo (RGBA), the uncovered and occluded masks (grey). */
    std::vector<uint8_t> image, mask, occluded;
    bool anyOccluded = false;
    double holes = 0, wallCoverage = 0, wallAreaM2 = 0, fromRepeats = 0, fromStoreys = 0, smooth = 0;
};

namespace detail {

struct Image { int W = 0, H = 0; std::vector<uint8_t> rgba; };

inline Image readPng(const std::string& file) {
    std::ifstream in(file, std::ios::binary);
    if (!in) throw std::runtime_error("cannot read " + file);
    const std::vector<uint8_t> bytes((std::istreambuf_iterator<char>(in)), std::istreambuf_iterator<char>());
    auto d = png::decode(bytes.data(), bytes.size(), png::OutputFormat::Rgba);
    if (!d.ok) throw std::runtime_error(file + ": " + d.error);
    return {d.image.width, d.image.height, std::move(d.image.data)};
}

struct Decoded {
    Image img;
    std::vector<uint8_t> unc, occ;
    bool hasOcc = false;
};

inline Decoded decodeMember(const Member& m, double occludedAt) {
    Decoded d;
    d.img = readPng(m.image);
    const size_t N = static_cast<size_t>(d.img.W) * d.img.H;
    if (!m.uncovered.empty()) {
        const Image u = readPng(m.uncovered);
        d.unc.resize(static_cast<size_t>(u.W) * u.H);
        for (size_t k = 0; k < d.unc.size(); ++k) d.unc[k] = u.rgba[k * 4] >= 128 ? 1 : 0;
    } else {
        d.unc.resize(N);
        for (size_t k = 0; k < N; ++k) { const uint8_t* q = &d.img.rgba[k * 4]; d.unc[k] = q[3] == 0 || (q[0] == 128 && q[1] == 128 && q[2] == 128) ? 1 : 0; }
    }
    // readOccluded: a mask of the photo's own size, else none
    if (!m.occluded.empty()) {
        const Image o = readPng(m.occluded);
        if (o.W == d.img.W && o.H == d.img.H) {
            d.hasOcc = true;
            d.occ.resize(N);
            for (size_t k = 0; k < N; ++k) d.occ[k] = o.rgba[k * 4] >= occludedAt ? 1 : 0;
        }
    }
    return d;
}

/** png-encode.ts encodePng's scanlines: each row the filter (None, Sub, Up, Average, Paeth) with the least sum of |residual|. */
inline std::vector<uint8_t> filterRows(const uint8_t* px, int W, int H, int ch) {
    const size_t stride = static_cast<size_t>(W) * ch;
    std::vector<uint8_t> raw((stride + 1) * static_cast<size_t>(H));
    std::array<std::vector<uint8_t>, 5> cand;
    for (auto& c : cand) c.resize(stride);
    for (int y = 0; y < H; ++y) {
        const uint8_t* row = px + static_cast<size_t>(y) * stride;
        const uint8_t* up = y > 0 ? row - stride : nullptr;
        int best = 0;
        double bestCost = js::kInf;
        for (int f = 0; f < 5; ++f) {
            uint8_t* out = cand[static_cast<size_t>(f)].data();
            double cost = 0;
            for (size_t i = 0; i < stride; ++i) {
                const int a = i >= static_cast<size_t>(ch) ? row[i - static_cast<size_t>(ch)] : 0, b = up ? up[i] : 0, c = up && i >= static_cast<size_t>(ch) ? up[i - static_cast<size_t>(ch)] : 0;
                int pred = 0;
                if (f == 1) pred = a;
                else if (f == 2) pred = b;
                else if (f == 3) pred = (a + b) >> 1;
                else if (f == 4) { const int p = a + b - c, pa = std::abs(p - a), pb = std::abs(p - b), pc = std::abs(p - c); pred = pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
                const int v = (row[i] - pred) & 0xff;
                out[i] = static_cast<uint8_t>(v);
                cost += v < 128 ? v : 256 - v;
                if (cost >= bestCost) break;
            }
            if (cost < bestCost) { bestCost = cost; best = f; }
        }
        uint8_t* dst = &raw[static_cast<size_t>(y) * (stride + 1)];
        dst[0] = static_cast<uint8_t>(best);
        std::copy(cand[static_cast<size_t>(best)].begin(), cand[static_cast<size_t>(best)].end(), dst + 1);
    }
    return raw;
}

/** ortho-rectify.ts smoothFillHoles: push-pull, its sums float32's as JavaScript's Float32Array keeps them. Edits rgba; the texels filled. */
inline double smoothFillHoles(int W, int H, std::vector<uint8_t>& rgba, const std::vector<uint8_t>& hole) {
    struct Level { int w, h; std::vector<float> c, n; };
    const auto f32add = [](float x, double y) { return static_cast<float>(static_cast<double>(x) + y); };
    std::vector<Level> levels;
    levels.push_back({W, H, std::vector<float>(static_cast<size_t>(W) * H * 3, 0.0f), std::vector<float>(static_cast<size_t>(W) * H, 0.0f)});
    double holes = 0;
    for (size_t i = 0; i < static_cast<size_t>(W) * H; ++i) {
        if (!rgba[i * 4 + 3]) continue;
        if (hole[i]) { holes++; continue; }
        levels[0].n[i] = 1;
        for (int q = 0; q < 3; ++q) levels[0].c[i * 3 + static_cast<size_t>(q)] = rgba[i * 4 + static_cast<size_t>(q)];
    }
    if (!holes) return 0;
    while (levels.back().w > 1 || levels.back().h > 1) {
        const int w = (levels.back().w + 1) / 2, h = (levels.back().h + 1) / 2;
        Level b{w, h, std::vector<float>(static_cast<size_t>(w) * h * 3, 0.0f), std::vector<float>(static_cast<size_t>(w) * h, 0.0f)};
        const Level& a = levels.back();
        for (int y = 0; y < a.h; ++y) for (int x = 0; x < a.w; ++x) {
            const size_t i = static_cast<size_t>(y) * a.w + x, j = static_cast<size_t>(y >> 1) * w + static_cast<size_t>(x >> 1);
            b.n[j] = f32add(b.n[j], a.n[i]);
            for (int q = 0; q < 3; ++q) b.c[j * 3 + static_cast<size_t>(q)] = f32add(b.c[j * 3 + static_cast<size_t>(q)], a.c[i * 3 + static_cast<size_t>(q)]);
        }
        levels.push_back(std::move(b));
    }
    for (int l = static_cast<int>(levels.size()) - 2; l >= 0; --l) {
        Level& a = levels[static_cast<size_t>(l)];
        const Level& b = levels[static_cast<size_t>(l) + 1];
        for (int y = 0; y < a.h; ++y) for (int x = 0; x < a.w; ++x) {
            const size_t i = static_cast<size_t>(y) * a.w + x;
            if (a.n[i] > 0) continue;
            const double fx = js::min(b.w - 1, js::max(0, (x + 0.5) / 2 - 0.5)), fy = js::min(b.h - 1, js::max(0, (y + 0.5) / 2 - 0.5));
            const double x0 = std::floor(fx), y0 = std::floor(fy), x1 = js::min(b.w - 1, x0 + 1), y1 = js::min(b.h - 1, y0 + 1), tx = fx - x0, ty = fy - y0;
            double wsum = 0;
            double acc[3] = {0, 0, 0};
            const double taps[4][3] = {{x0, y0, (1 - tx) * (1 - ty)}, {x1, y0, tx * (1 - ty)}, {x0, y1, (1 - tx) * ty}, {x1, y1, tx * ty}};
            for (const auto& tp : taps) {
                const size_t j = static_cast<size_t>(tp[1]) * b.w + static_cast<size_t>(tp[0]);
                const double ww = tp[2];
                if (!(b.n[j] > 0) || !(ww > 0)) continue;
                for (int q = 0; q < 3; ++q) acc[q] += (ww * b.c[j * 3 + static_cast<size_t>(q)]) / b.n[j];
                wsum += ww;
            }
            if (wsum > 0) { a.n[i] = 1; for (int q = 0; q < 3; ++q) a.c[i * 3 + static_cast<size_t>(q)] = static_cast<float>(acc[q] / wsum); }
        }
    }
    const Level& base = levels[0];
    double n = 0;
    for (size_t i = 0; i < static_cast<size_t>(W) * H; ++i) {
        if (!hole[i] || !rgba[i * 4 + 3] || !(base.n[i] > 0)) continue;
        for (int q = 0; q < 3; ++q) rgba[i * 4 + static_cast<size_t>(q)] = js::toUint8(js::max(0, js::min(255, js::round(static_cast<double>(base.c[i * 3 + static_cast<size_t>(q)]) / base.n[i]))));
        if (rgba[i * 4] == 128 && rgba[i * 4 + 1] == 128 && rgba[i * 4 + 2] == 128) rgba[i * 4 + 2] = 129;
        n++;
    }
    return n;
}

/** facade-lattice.ts wallCoverage. */
inline void wallCoverage(const std::vector<uint8_t>& rgba, int W, int H, double pixel, double& coverage, double& areaM2) {
    double inside = 0, hit = 0;
    for (int y = 0; y < H; ++y) {
        int a = -1, b = -1;
        double n = 0;
        for (int x = 0; x < W; ++x) {
            const uint8_t* q = &rgba[(static_cast<size_t>(y) * W + x) * 4];
            if (q[3] > 0 && !(q[0] == 128 && q[1] == 128 && q[2] == 128)) { if (a < 0) a = x; b = x; n++; }
        }
        if (a >= 0) { inside += b - a + 1; hit += n; }
    }
    coverage = inside ? hit / inside : 0;
    areaM2 = inside * pixel * pixel;
}

inline SheetOut buildSheet(const SheetJob& job, const ortho_rectify::Params& P, double occludedAt, FixedThreadPool& pool) {
    std::vector<Decoded> ms(job.members.size());
    pool.forEach(job.members.size(), [&](size_t i) { ms[i] = decodeMember(job.members[i], occludedAt); });
    const int W = job.W, H = job.H;
    const size_t N = static_cast<size_t>(W) * H;
    ortho_rectify::Rgba sheet;
    sheet.width = W;
    sheet.height = H;
    sheet.rgba.assign(N * 4, 0);
    std::vector<uint8_t> uncovered(N, 1), occluded(N, 0);
    bool anyOcc = false;
    for (const Decoded& d : ms) anyOcc = anyOcc || d.hasOcc;
    std::vector<uint8_t>& rgba = sheet.rgba;
    for (int y = 0; y < H; ++y) for (int x = 0; x < W; ++x) {
        const size_t k = static_cast<size_t>(y) * W + x;
        // a member that saw the texel clear first; one with something in front of it only when no other saw it
        for (int pass = 0; pass < (anyOcc ? 2 : 1) && uncovered[k]; ++pass) for (size_t mi = 0; mi < ms.size(); ++mi) {
            const Member& m = job.members[mi];
            const Decoded& d = ms[mi];
            const double mx = std::floor(m.o[0] + x * m.dx[0] + y * m.dy[0]), my = std::floor(m.o[1] + x * m.dx[1] + y * m.dy[1]);
            if (mx < 0 || my < 0 || mx >= d.img.W || my >= d.img.H) continue;
            const size_t j = static_cast<size_t>(my) * d.img.W + static_cast<size_t>(mx);
            if ((j < d.unc.size() && d.unc[j]) || !d.img.rgba[j * 4 + 3]) continue;
            const bool blocked = d.hasOcc && d.occ[j];
            if (pass == 0 && blocked) continue;
            for (int c = 0; c < 3; ++c) rgba[k * 4 + static_cast<size_t>(c)] = d.img.rgba[j * 4 + static_cast<size_t>(c)];
            if (rgba[k * 4] == 128 && rgba[k * 4 + 1] == 128 && rgba[k * 4 + 2] == 128) rgba[k * 4 + 2] = 129;
            rgba[k * 4 + 3] = 255;
            uncovered[k] = 0;
            occluded[k] = blocked ? 1 : 0;
            break;
        }
        if (uncovered[k]) { rgba[k * 4] = 128; rgba[k * 4 + 1] = 128; rgba[k * 4 + 2] = 128; rgba[k * 4 + 3] = 255; }
    }
    ms.clear();
    SheetOut out;
    wallCoverage(rgba, W, H, job.px, out.wallCoverage, out.wallAreaM2);
    ortho_rectify::HoleFill fill;
    ortho_rectify::Rgba filled = ortho_rectify::fillHoles(sheet, job.px, P, fill, nullptr, false);
    out.fromRepeats = fill.fromRepeats;
    out.fromStoreys = fill.fromStoreys;
    std::vector<uint8_t> left(N);
    for (size_t k = 0; k < N; ++k) { const uint8_t* q = &filled.rgba[k * 4]; left[k] = uncovered[k] && q[0] == 128 && q[1] == 128 && q[2] == 128 ? 1 : 0; }
    out.smooth = smoothFillHoles(W, H, filled.rgba, left);
    for (uint8_t v : uncovered) out.holes += v;
    out.image = filterRows(filled.rgba.data(), W, H, 4);
    std::vector<uint8_t> grey(N);
    for (size_t k = 0; k < N; ++k) grey[k] = uncovered[k] ? 255 : 0;
    out.mask = filterRows(grey.data(), W, H, 1);
    for (uint8_t v : occluded) if (v) { out.anyOccluded = true; break; }
    if (out.anyOccluded) {
        for (size_t k = 0; k < N; ++k) grey[k] = occluded[k] ? 255 : 0;
        out.occluded = filterRows(grey.data(), W, H, 1);
    }
    return out;
}

}  // namespace detail

/** Every sheet's photo and masks, one sheet a task (the largest first), in the sheets' order. */
inline std::vector<SheetOut> buildSheets(const std::vector<SheetJob>& jobs, const ortho_rectify::Params& P, double occludedAt, FixedThreadPool& pool) {
    std::vector<size_t> order(jobs.size());
    for (size_t i = 0; i < order.size(); ++i) order[i] = i;
    std::stable_sort(order.begin(), order.end(), [&](size_t a, size_t b) { return static_cast<double>(jobs[a].W) * jobs[a].H > static_cast<double>(jobs[b].W) * jobs[b].H; });
    std::vector<SheetOut> out(jobs.size());
    pool.forEach(order.size(), [&](size_t i) { out[order[i]] = detail::buildSheet(jobs[order[i]], P, occludedAt, pool); });
    return out;
}

}  // namespace wall_sheets
}  // namespace scratchbox

#endif  // SCRATCHBOX_WALL_SHEETS_HPP
