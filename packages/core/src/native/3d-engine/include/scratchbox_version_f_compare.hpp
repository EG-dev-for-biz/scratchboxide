/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Version F (staged-location procedural rebuild), round 3: the per-wall render-compare kernel in C++20.
 *
 * The adjustment of version F's read parameters (version-f/adjust.ts) scores every candidate parameter set on the seen
 * walls: the candidate's program is drawn as an offset map in each wall's own orthographic frame (the wall at 0, its openings
 * at minus their recess, its bands and piers at their projection) and compared with the tile's evidence of that wall (where
 * the photo is darker than the wall round it, its strong edges, its ortho depth). Rounds 1 and 2 did that in JavaScript, one
 * wall after the other, every knob re-rendering every wall: 8-97 s per building. Here the same arithmetic runs natively:
 *
 *   - a session holds the walls' evidence once (luma, darkness, edge distance, depth, the wall's own inside mask);
 *   - a request is a batch of jobs, each one wall with the rectangles a candidate program draws on it (pixel boxes, each set
 *     or raised to an offset); the jobs are spread over every core, a job never waits for another wall;
 *   - the answer is each job's numbers: window NCC, edge distance (m), depth MAE (m), the share within 0.15 m, the opening share.
 *
 * The numbers are the JavaScript reference's (render-compare.ts compareWall on programWallOffset), to float precision; the
 * test staged-version-f3.test.ts checks them on fixtures. Nothing here knows a building, a style or a parameter: it draws
 * rectangles and compares pictures.
 *
 * Session file (little-endian): "SBVF", u32 version (1), u32 walls; per wall: i32 face, i32 W, i32 H, f32 pixel, f32 area,
 * f32[W*H] luma (NaN uncovered), f32[W*H] dark, f32[W*H] edgeDist (pixels), f32[W*H] depth (NaN uncovered), u8[W*H] inside.
 * Request (stdin): u32 jobs; per job: u32 id, i32 face, u32 rects; per rect: i32 x0, y0, x1, y1, f32 v, u32 mode (0 set, 1 max).
 * Answer (stdout): u32 jobs; per job: u32 id, f32 ncc, f32 edgeDistM, f32 depthMae, f32 depthWithin015, f32 openingShare.
 */

#pragma once

#include <algorithm>
#include <atomic>
#include <cmath>
#include <cstdint>
#include <cstring>
#include <istream>
#include <limits>
#include <stdexcept>
#include <string>
#include <thread>
#include <unordered_map>
#include <vector>

namespace scratchbox::version_f_compare {

constexpr uint32_t SESSION_VERSION = 1;
/** An offset below this (m) is an opening (render-compare.ts compareWall). */
constexpr float OPENING_OFFSET_M = -0.05f;
/** The slab the offsets and the tile depth are clamped to for the depth comparison (m). */
constexpr float SLAB_BACK_M = -1.5f;
constexpr float SLAB_FRONT_M = 0.8f;
/** The edge distance of a border pixel is capped at this many pixels. */
constexpr float EDGE_DIST_CAP_PX = 40.0f;
constexpr float DEPTH_WITHIN_M = 0.15f;

struct WallEvidence {
    int32_t face = 0;
    int32_t width = 0, height = 0;
    float pixel = 0, area = 0;
    std::vector<float> luma, dark, edgeDist, depth;
    std::vector<uint8_t> inside;
};

struct Rect {
    int32_t x0 = 0, y0 = 0, x1 = 0, y1 = 0;
    float v = 0;
    /** 0: the offset is set to v; 1: raised to at least v (a band or pier over an opening). */
    uint32_t mode = 0;
};

struct Job {
    uint32_t id = 0;
    int32_t face = 0;
    std::vector<Rect> rects;
};

struct WallScore {
    float ncc = 0, edgeDistM = std::numeric_limits<float>::quiet_NaN(), depthMae = std::numeric_limits<float>::quiet_NaN(), depthWithin015 = 0, openingShare = 0;
};

namespace detail {
template <typename T> T readPod(std::istream& in) {
    T v{};
    in.read(reinterpret_cast<char*>(&v), sizeof(T));
    if (!in) throw std::runtime_error("unexpected end of input");
    return v;
}
template <typename T> void readVec(std::istream& in, std::vector<T>& v, size_t n) {
    v.resize(n);
    if (n) in.read(reinterpret_cast<char*>(v.data()), static_cast<std::streamsize>(n * sizeof(T)));
    if (!in) throw std::runtime_error("unexpected end of input");
}
}  // namespace detail

/** Reads a session (the walls' evidence) from a stream; throws on a bad magic, version or truncation. */
inline std::vector<WallEvidence> readSession(std::istream& in) {
    char magic[4];
    in.read(magic, 4);
    if (!in || std::memcmp(magic, "SBVF", 4) != 0) throw std::runtime_error("not a version F compare session (magic)");
    const auto version = detail::readPod<uint32_t>(in);
    if (version != SESSION_VERSION) throw std::runtime_error("session version " + std::to_string(version) + " is not " + std::to_string(SESSION_VERSION));
    const auto walls = detail::readPod<uint32_t>(in);
    if (walls > 100000) throw std::runtime_error("implausible wall count");
    std::vector<WallEvidence> out(walls);
    for (auto& w : out) {
        w.face = detail::readPod<int32_t>(in);
        w.width = detail::readPod<int32_t>(in);
        w.height = detail::readPod<int32_t>(in);
        w.pixel = detail::readPod<float>(in);
        w.area = detail::readPod<float>(in);
        if (w.width < 0 || w.height < 0 || static_cast<int64_t>(w.width) * w.height > (1 << 28)) throw std::runtime_error("implausible wall size");
        const size_t n = static_cast<size_t>(w.width) * static_cast<size_t>(w.height);
        detail::readVec(in, w.luma, n);
        detail::readVec(in, w.dark, n);
        detail::readVec(in, w.edgeDist, n);
        detail::readVec(in, w.depth, n);
        detail::readVec(in, w.inside, n);
    }
    return out;
}

/** Reads one request (a batch of jobs); false at a clean end of input. */
inline bool readRequest(std::istream& in, std::vector<Job>& jobs) {
    uint32_t n = 0;
    in.read(reinterpret_cast<char*>(&n), sizeof(n));
    if (!in) return false;
    if (n > 10000000) throw std::runtime_error("implausible job count");
    jobs.resize(n);
    for (auto& j : jobs) {
        j.id = detail::readPod<uint32_t>(in);
        j.face = detail::readPod<int32_t>(in);
        const auto rects = detail::readPod<uint32_t>(in);
        if (rects > 10000000) throw std::runtime_error("implausible rect count");
        j.rects.resize(rects);
        if (rects) in.read(reinterpret_cast<char*>(j.rects.data()), static_cast<std::streamsize>(rects * sizeof(Rect)));
        if (!in) throw std::runtime_error("unexpected end of input in a request");
    }
    return true;
}
static_assert(sizeof(Rect) == 24, "Rect is written as 6 x 4 bytes");

/** The offset map of a job on its wall: the wall at 0 inside its mask, NaN elsewhere, the rectangles applied in order. */
inline void drawOffset(const WallEvidence& w, const std::vector<Rect>& rects, std::vector<float>& d) {
    const int W = w.width, H = w.height;
    const float nan = std::numeric_limits<float>::quiet_NaN();
    d.assign(static_cast<size_t>(W) * H, nan);
    for (size_t i = 0; i < d.size(); i++) if (w.inside[i]) d[i] = 0.0f;
    for (const auto& r : rects) {
        const int x0 = std::max(0, r.x0), x1 = std::min(W, r.x1), y0 = std::max(0, r.y0), y1 = std::min(H, r.y1);
        for (int y = y0; y < y1; y++) for (int x = x0; x < x1; x++) {
            float& v = d[static_cast<size_t>(y) * W + x];
            if (!std::isfinite(v)) continue;
            v = r.mode ? std::max(v, r.v) : r.v;
        }
    }
}

/** render-compare.ts compareWall on an offset map (double sums, as JavaScript). */
inline WallScore compareWall(const WallEvidence& w, const std::vector<float>& off) {
    const int W = w.width, H = w.height;
    const size_t N = static_cast<size_t>(W) * H;
    double sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0;
    long n = 0, open = 0, cover = 0;
    double errSum = 0;
    long errN = 0, errWithin = 0;
    const auto clampSlab = [](float v) { return std::max(SLAB_BACK_M, std::min(SLAB_FRONT_M, v)); };
    for (size_t i = 0; i < N; i++) {
        const float o = off[i];
        if (!std::isfinite(o)) continue;
        cover++;
        const double m = o < OPENING_OFFSET_M ? 1.0 : 0.0;
        open += o < OPENING_OFFSET_M ? 1 : 0;
        const float dk = w.dark[i];
        if (std::isfinite(dk)) { sx += m; sy += dk; sxx += m * m; syy += static_cast<double>(dk) * dk; sxy += m * dk; n++; }
        const float td = w.depth[i];
        if (std::isfinite(td)) {
            const double e = std::fabs(static_cast<double>(clampSlab(o)) - static_cast<double>(clampSlab(td)));
            errSum += e; errN++;
            if (e <= DEPTH_WITHIN_M) errWithin++;
        }
    }
    const double nn = std::max(1L, n);
    const double vx = sxx / nn - (sx / nn) * (sx / nn), vy = syy / nn - (sy / nn) * (sy / nn);
    WallScore s;
    s.ncc = (n > 10 && vx > 1e-9 && vy > 1e-9) ? static_cast<float>((sxy / n - (sx / n) * (sy / n)) / std::sqrt(vx * vy)) : 0.0f;
    // border pixels of the openings (an opening pixel with a non-opening 4-neighbour), where the photo covers the wall
    double dsum = 0;
    long dn = 0;
    const auto isOpen = [&](size_t i) { return std::isfinite(off[i]) && off[i] < OPENING_OFFSET_M; };
    for (int y = 1; y < H - 1; y++) for (int x = 1; x < W - 1; x++) {
        const size_t i = static_cast<size_t>(y) * W + x;
        if (!isOpen(i)) continue;
        if (isOpen(i - 1) && isOpen(i + 1) && isOpen(i - W) && isOpen(i + W)) continue;
        if (!std::isfinite(w.luma[i])) continue;
        dsum += std::min(w.edgeDist[i], EDGE_DIST_CAP_PX); dn++;
    }
    s.edgeDistM = dn ? static_cast<float>((dsum / dn) * w.pixel) : std::numeric_limits<float>::quiet_NaN();
    s.depthMae = errN ? static_cast<float>(errSum / errN) : std::numeric_limits<float>::quiet_NaN();
    s.depthWithin015 = errN ? static_cast<float>(static_cast<double>(errWithin) / errN) : 0.0f;
    s.openingShare = cover ? static_cast<float>(static_cast<double>(open) / cover) : 0.0f;
    return s;
}

/** A session: the walls by face index, and a batch evaluator over every core. */
class Session {
public:
    explicit Session(std::vector<WallEvidence> walls, unsigned threads = 0) : walls_(std::move(walls)), threads_(threads ? threads : std::max(1u, std::thread::hardware_concurrency())) {
        for (size_t i = 0; i < walls_.size(); i++) byFace_[walls_[i].face] = i;
    }
    const std::vector<WallEvidence>& walls() const { return walls_; }
    unsigned threads() const { return threads_; }

    /** Scores every job (unknown faces score NaN everywhere); jobs are spread over the threads, each with its own scratch map. */
    std::vector<WallScore> evaluate(const std::vector<Job>& jobs) const {
        std::vector<WallScore> out(jobs.size());
        std::atomic<size_t> next{0};
        const unsigned T = static_cast<unsigned>(std::min<size_t>(threads_, std::max<size_t>(1, jobs.size())));
        auto worker = [&]() {
            std::vector<float> scratch;
            for (;;) {
                const size_t k = next.fetch_add(1);
                if (k >= jobs.size()) break;
                const auto it = byFace_.find(jobs[k].face);
                if (it == byFace_.end()) { out[k] = WallScore{std::numeric_limits<float>::quiet_NaN(), std::numeric_limits<float>::quiet_NaN(), std::numeric_limits<float>::quiet_NaN(), std::numeric_limits<float>::quiet_NaN(), std::numeric_limits<float>::quiet_NaN()}; continue; }
                const auto& w = walls_[it->second];
                drawOffset(w, jobs[k].rects, scratch);
                out[k] = compareWall(w, scratch);
            }
        };
        std::vector<std::thread> pool;
        for (unsigned t = 1; t < T; t++) pool.emplace_back(worker);
        worker();
        for (auto& t : pool) t.join();
        return out;
    }

private:
    std::vector<WallEvidence> walls_;
    unsigned threads_;
    std::unordered_map<int32_t, size_t> byFace_;
};

/** Serialises an answer: u32 jobs, then per job u32 id and the five floats. */
inline std::vector<char> encodeAnswer(const std::vector<Job>& jobs, const std::vector<WallScore>& scores) {
    std::vector<char> out(4 + jobs.size() * 24);
    const uint32_t n = static_cast<uint32_t>(jobs.size());
    std::memcpy(out.data(), &n, 4);
    for (size_t k = 0; k < jobs.size(); k++) {
        char* p = out.data() + 4 + k * 24;
        std::memcpy(p, &jobs[k].id, 4);
        const float v[5] = {scores[k].ncc, scores[k].edgeDistM, scores[k].depthMae, scores[k].depthWithin015, scores[k].openingShare};
        std::memcpy(p + 4, v, 20);
    }
    return out;
}

}  // namespace scratchbox::version_f_compare
