/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

#ifndef SCRATCHBOX_TWIN_TEXELS_HPP
#define SCRATCHBOX_TWIN_TEXELS_HPP

/**
 * Pipeline K's per-texel twin steps, on a fixed thread pool: the roof cast-shadow lift's kernels
 * (pipeline-k/roof-shadow.ts) and the harmonisation's apply (pipeline-k/texture-harmonize.ts). The fits that decide
 * what to lift and by how much stay in TypeScript; these are the loops over triangles, map pixels and texels.
 *
 *  1. Shadow maps: the topmost surface toward a sun over a plane across it, one float a pixel (the largest p . s of any
 *     triangle). A map is rasterised in row bands, one band a task: the max is the same whatever order the triangles
 *     arrive in, so the map is the same on any number of threads.
 *  2. Roof cells: every photo's roof texels on a grid every cellTexels texels that the map from straight above sees,
 *     with their point and log colour. Photos are independent (a cell is taken by the first triangle of its photo that
 *     reaches it), one photo a task; the cells are put back in triangle order, as the TypeScript lists them.
 *  3. Cell shadows: each cell in or out of each candidate sun's shadow, one sun a task.
 *  4. The lift: per sun (in the caller's order), its finer map, then each photo's roof texels in triangle order, one
 *     photo a task; a texel is multiplied by its ratio to the power of its shadowed share, capped at its terrace's lit
 *     level.
 *  5. Harmonise apply: each texel's photo gain (its roof's on a roof texel) and its photo's offset field, bilinear, in
 *     linear light; rows of every photo, a block of rows a task.
 *
 * Parity with the TypeScript, which stays the reference (SCRATCHBOX_K_NATIVE_TWIN=0): every value is computed with
 * the same operations in the same order, in doubles, on the same float32 inputs. It must be compiled with
 * -ffp-contract=off: a fused multiply-add rounds once where JavaScript rounds twice. What JavaScript computes with its
 * own transcendental functions and a threshold then reads comes from the caller, worked out there: the sun frames
 * (cos, sin, tan), the log colour table, and the 8-bit sRGB encoder's thresholds (the least linear value of each
 * code). Left here are exp and pow ahead of that encoder, within an ulp of V8's: a texel's code can differ only when
 * its linear value lies within an ulp of a code's threshold.
 *
 * Nothing here knows what a roof, a building or a photo shows: maps, cells and texels are measurements and indices.
 */

#include <algorithm>
#include <atomic>
#include <cmath>
#include <condition_variable>
#include <cstddef>
#include <cstdint>
#include <cstring>
#include <functional>
#include <limits>
#include <mutex>
#include <thread>
#include <unordered_map>
#include <vector>

namespace scratchbox {
namespace twin_texels {

/** A texel's surface (texture-harmonize.ts surfaceClassMasks): no triangle uses it, a wall, a roof. */
constexpr uint8_t TEXEL_NONE = 0, TEXEL_WALL = 1, TEXEL_ROOF = 2;

/** JavaScript's Math.round: the nearest integer, a half up. */
inline double jsRound(double x) {
    const double f = std::floor(x);
    return x - f >= 0.5 ? f + 1.0 : f;
}

/**
 * A fixed set of threads, made once and reused for every parallel loop. run(count, fn) calls fn(i, worker) for every
 * i in [0, count), each claimed by whichever thread is free (the caller's included); worker is in [0, size()), so a
 * loop can keep scratch per worker.
 */
class TexelPool {
public:
    explicit TexelPool(unsigned threads) : n_(std::max(1u, threads)) {
        for (unsigned w = 1; w < n_; ++w) workers_.emplace_back([this, w] { loop(w); });
    }
    TexelPool(const TexelPool&) = delete;
    TexelPool& operator=(const TexelPool&) = delete;
    ~TexelPool() {
        {
            std::lock_guard<std::mutex> lock(m_);
            stop_ = true;
        }
        wake_.notify_all();
        for (auto& t : workers_) t.join();
    }
    unsigned size() const { return n_; }

    void run(size_t count, const std::function<void(size_t, unsigned)>& fn) {
        if (count == 0) return;
        if (n_ == 1 || count == 1) {
            for (size_t i = 0; i < count; ++i) fn(i, 0);
            return;
        }
        {
            std::lock_guard<std::mutex> lock(m_);
            job_ = &fn;
            count_ = count;
            next_.store(0);
            busy_ = n_ - 1;
            ++generation_;
        }
        wake_.notify_all();
        work(0);
        std::unique_lock<std::mutex> lock(m_);
        idle_.wait(lock, [&] { return busy_ == 0; });
        job_ = nullptr;
    }

private:
    void work(unsigned w) {
        for (size_t i = next_.fetch_add(1); i < count_; i = next_.fetch_add(1)) (*job_)(i, w);
    }
    void loop(unsigned w) {
        uint64_t seen = 0;
        for (;;) {
            {
                std::unique_lock<std::mutex> lock(m_);
                wake_.wait(lock, [&] { return stop_ || generation_ != seen; });
                if (stop_) return;
                seen = generation_;
            }
            work(w);
            std::lock_guard<std::mutex> lock(m_);
            if (--busy_ == 0) idle_.notify_one();
        }
    }

    unsigned n_;
    std::vector<std::thread> workers_;
    std::mutex m_;
    std::condition_variable wake_, idle_;
    const std::function<void(size_t, unsigned)>* job_ = nullptr;
    size_t count_ = 0;
    std::atomic<size_t> next_{0};
    unsigned busy_ = 0;
    uint64_t generation_ = 0;
    bool stop_ = false;
};

/**
 * 8-bit sRGB from linear light: the code is how many of the 255 thresholds the value reaches, threshold k - 1 being the
 * least linear value whose code (Math.round of linearToSrgb255) is at least k, as the caller found it.
 */
struct Srgb8Encoder {
    double t[255];
    uint8_t encode(double x) const {
        int lo = 0, hi = 255;
        while (lo < hi) {
            const int mid = (lo + hi) >> 1;
            if (t[mid] <= x) lo = mid + 1; else hi = mid;
        }
        return static_cast<uint8_t>(lo);
    }
};

/** A sun's map frame as roof-shadow.ts sunFrame works it out: toward the sun, across it, the third axis; and the slope term. */
struct SunFrame {
    double s[3], r[3], u[3];
    double slope;
};

/** The topmost surface toward a sun (roof-shadow.ts ShadowMap); -inf where nothing stands. */
struct ShadowMap {
    SunFrame f{};
    double X0 = 0, Y1 = 0, mpp = 1;
    int W = 0, H = 0;
    std::vector<float> top;

    /** True when something stands between the point and the sun (the nearest pixel). */
    bool shadowedAt(double x, double y, double z, double biasM) const {
        const double fx = std::floor((x * f.r[0] + y * f.r[1] + z * f.r[2] - X0) / mpp);
        const double fy = std::floor((Y1 - (x * f.u[0] + y * f.u[1] + z * f.u[2])) / mpp);
        if (!(fx >= 0) || !(fy >= 0) || fx >= W || fy >= H) return false;
        return static_cast<double>(top[static_cast<size_t>(fy) * static_cast<size_t>(W) + static_cast<size_t>(fx)]) > x * f.s[0] + y * f.s[1] + z * f.s[2] + biasM + slope();
    }

    /** The shadowed share of a point, from the four pixels around it (a soft edge one pixel wide). */
    double fraction(double x, double y, double z, double biasM) const {
        const double fx = (x * f.r[0] + y * f.r[1] + z * f.r[2] - X0) / mpp - 0.5, fy = (Y1 - (x * f.u[0] + y * f.u[1] + z * f.u[2])) / mpp - 0.5;
        const double x0 = std::floor(fx), y0 = std::floor(fy), ax = fx - x0, ay = fy - y0, t = x * f.s[0] + y * f.s[1] + z * f.s[2] + biasM + slope();
        const double w[4] = {(1 - ax) * (1 - ay), ax * (1 - ay), (1 - ax) * ay, ax * ay};
        const int dx[4] = {0, 1, 0, 1}, dy[4] = {0, 0, 1, 1};
        double out = 0;
        for (int k = 0; k < 4; ++k) {
            const double px = x0 + dx[k], py = y0 + dy[k];
            if (px < 0 || py < 0 || px >= W || py >= H) continue;
            if (static_cast<double>(top[static_cast<size_t>(py) * static_cast<size_t>(W) + static_cast<size_t>(px)]) > t) out += w[k];
        }
        return out;
    }

    double slope() const { return f.slope; }
};

/**
 * The map's extent over the occluders' corners (`P`, nine floats a triangle, `n` triangles) and its pixels, all -inf.
 * With a pool, the corners are read in parallel blocks (a min and a max are the same in any order).
 */
inline void frameMap(ShadowMap& m, const float* P, size_t n, const SunFrame& f, double mpp, TexelPool* pool = nullptr) {
    m.f = f;
    m.mpp = mpp;
    const size_t verts = n * 3;
    const size_t block = 1u << 16, blocks = (verts + block - 1) / block;
    std::vector<double> ext(std::max<size_t>(1, blocks) * 4);
    auto scan = [&](size_t b, unsigned) {
        double x0 = std::numeric_limits<double>::infinity(), x1 = -x0, y0 = x0, y1 = -x0;
        const size_t e = std::min(verts, (b + 1) * block);
        for (size_t v = b * block; v < e; ++v) {
            const double px = P[v * 3], py = P[v * 3 + 1], pz = P[v * 3 + 2];
            const double x = px * f.r[0] + py * f.r[1] + pz * f.r[2], y = px * f.u[0] + py * f.u[1] + pz * f.u[2];
            if (x < x0) x0 = x;
            if (x > x1) x1 = x;
            if (y < y0) y0 = y;
            if (y > y1) y1 = y;
        }
        ext[b * 4] = x0; ext[b * 4 + 1] = x1; ext[b * 4 + 2] = y0; ext[b * 4 + 3] = y1;
    };
    if (pool && blocks > 1) pool->run(blocks, scan); else for (size_t b = 0; b < blocks; ++b) scan(b, 0);
    double x0 = std::numeric_limits<double>::infinity(), x1 = -x0, y0 = x0, y1 = -x0;
    for (size_t b = 0; b < blocks; ++b) {
        x0 = std::min(x0, ext[b * 4]); x1 = std::max(x1, ext[b * 4 + 1]);
        y0 = std::min(y0, ext[b * 4 + 2]); y1 = std::max(y1, ext[b * 4 + 3]);
    }
    m.W = static_cast<int>(std::ceil((x1 - x0) / mpp)) + 3;
    m.H = static_cast<int>(std::ceil((y1 - y0) / mpp)) + 3;
    m.X0 = x0 - mpp;
    m.Y1 = y1 + mpp;
    m.top.assign(static_cast<size_t>(m.W) * static_cast<size_t>(m.H), -std::numeric_limits<float>::infinity());
}

/** Rasterises triangles [t0, t1) of `P` into the map's rows [row0, row1) (roof-shadow.ts shadowMap, clipped to the band). */
inline void rasterRows(ShadowMap& m, const float* P, size_t t0, size_t t1, int row0, int row1) {
    const SunFrame& f = m.f;
    const double mpp = m.mpp, X0 = m.X0, Y1 = m.Y1;
    const int W = m.W;
    float* top = m.top.data();
    double sx[3], sy[3], st[3];
    for (size_t t = t0; t < t1; ++t) {
        const float* a = P + t * 9;
        for (int k = 0; k < 3; ++k) {
            const double px = a[k * 3], py = a[k * 3 + 1], pz = a[k * 3 + 2];
            sy[k] = (Y1 - (px * f.u[0] + py * f.u[1] + pz * f.u[2])) / mpp;
        }
        const double by0d = std::max(0.0, std::floor(std::min(std::min(sy[0], sy[1]), sy[2]))), by1d = std::min(static_cast<double>(m.H - 1), std::floor(std::max(std::max(sy[0], sy[1]), sy[2])));
        const int by0 = std::max(row0, static_cast<int>(std::min(by0d, static_cast<double>(m.H)))), by1 = std::min(row1 - 1, static_cast<int>(by1d));
        if (by0 > by1) continue;
        for (int k = 0; k < 3; ++k) {
            const double px = a[k * 3], py = a[k * 3 + 1], pz = a[k * 3 + 2];
            sx[k] = (px * f.r[0] + py * f.r[1] + pz * f.r[2] - X0) / mpp;
            st[k] = px * f.s[0] + py * f.s[1] + pz * f.s[2];
        }
        const double area = (sx[1] - sx[0]) * (sy[2] - sy[0]) - (sx[2] - sx[0]) * (sy[1] - sy[0]);
        const double bx0d = std::max(0.0, std::floor(std::min(std::min(sx[0], sx[1]), sx[2]))), bx1d = std::min(static_cast<double>(W - 1), std::floor(std::max(std::max(sx[0], sx[1]), sx[2])));
        if (bx0d > bx1d) continue;
        const int bx0 = static_cast<int>(bx0d), bx1 = static_cast<int>(bx1d);
        if (std::fabs(area) < 1e-9) {
            // edge-on to the sun (a wall along the light): its highest corner over the pixels it crosses
            const double tm = std::max(std::max(st[0], st[1]), st[2]);
            for (int y = by0; y <= by1; ++y) for (int x = bx0; x <= bx1; ++x) {
                float& cur = top[static_cast<size_t>(y) * static_cast<size_t>(W) + static_cast<size_t>(x)];
                if (tm > static_cast<double>(cur)) cur = static_cast<float>(tm);
            }
            continue;
        }
        const double inv = 1 / area;
        for (int y = by0; y <= by1; ++y) {
            const double cy = y + 0.5;
            float* row = top + static_cast<size_t>(y) * static_cast<size_t>(W);
            for (int x = bx0; x <= bx1; ++x) {
                const double cx = x + 0.5;
                const double w0 = ((sx[1] - cx) * (sy[2] - cy) - (sx[2] - cx) * (sy[1] - cy)) * inv;
                const double w1 = ((sx[2] - cx) * (sy[0] - cy) - (sx[0] - cx) * (sy[2] - cy)) * inv;
                const double w2 = 1 - w0 - w1;
                if (w0 < -1e-6 || w1 < -1e-6 || w2 < -1e-6) continue;
                const double tt = w0 * st[0] + w1 * st[1] + w2 * st[2];
                if (tt > static_cast<double>(row[x])) row[x] = static_cast<float>(tt);
            }
        }
    }
}

/** A whole map: framed, then rasterised on the calling thread (one sun a task) or in row bands on the pool. */
inline void buildShadowMap(ShadowMap& m, const float* P, size_t n, const SunFrame& f, double mpp, TexelPool* pool = nullptr) {
    frameMap(m, P, n, f, mpp, pool);
    if (!pool || pool->size() == 1) { rasterRows(m, P, 0, n, 0, m.H); return; }
    // a few bands a thread: tall structures put most triangles in a few rows
    const int bands = std::max(1, std::min(m.H, static_cast<int>(pool->size()) * 4));
    pool->run(static_cast<size_t>(bands), [&](size_t b, unsigned) {
        const int r0 = static_cast<int>((static_cast<int64_t>(m.H) * static_cast<int64_t>(b)) / bands), r1 = static_cast<int>((static_cast<int64_t>(m.H) * static_cast<int64_t>(b + 1)) / bands);
        if (r0 < r1) rasterRows(m, P, 0, n, r0, r1);
    });
}

/** One photo as the kernels read it: its pixels (RGBA) and its surface classes (TEXEL_*, one byte a texel). */
struct Photo {
    int32_t img = -1;
    int W = 0, H = 0;
    std::vector<uint8_t> rgba, mask;
};

struct RoofParams {
    double biasM = 0.5, flatNy = 0.7, terraceBinM = 1, componentGridM = 2;
    int cellTexels = 3;
};

/** Roof cells: photo, point (float, as the TypeScript keeps it), log linear colour. */
struct RoofCells {
    std::vector<int32_t> img;
    std::vector<float> p, c;
    size_t size() const { return img.size(); }
};

/** One sun's lift: each photo's sun and ratio, the lifted terraces' lit levels, and the terraces across photos (roof-shadow.ts LiftPlan). */
struct LiftPlan {
    struct PhotoSun { int sun; double ratio[3]; double logLum; };
    struct Comp { int sun; double ratio[3]; double lit; double logLum; };
    std::vector<SunFrame> suns;
    double mpp = 0.15;
    std::unordered_map<int32_t, PhotoSun> photoSun;
    /** (photo, height bin) of a lifted terrace -> its lit level (NaN: none, no cap). */
    std::unordered_map<uint64_t, double> terraceLit;
    std::vector<Comp> comps;
    /** (height bin, plan cell x, plan cell z) of a terrace across photos -> its index in comps. */
    std::unordered_map<uint64_t, int32_t> compOfKey;

    static uint64_t terraceKey(int32_t img, int32_t bin) { return (static_cast<uint64_t>(static_cast<uint32_t>(img)) << 32) | static_cast<uint32_t>(bin); }
    /** 16 bits of height bin and 24 of each plan cell: one key per cell within 32 km up or down and 16,000 km across at 1 m. */
    static uint64_t gridKey(int32_t bin, int32_t gx, int32_t gz) {
        return (static_cast<uint64_t>(static_cast<uint32_t>(bin) & 0xFFFFu) << 48) | (static_cast<uint64_t>(static_cast<uint32_t>(gx) & 0xFFFFFFu) << 24) | static_cast<uint64_t>(static_cast<uint32_t>(gz) & 0xFFFFFFu);
    }
};

/**
 * The roof-shadow lift's kernels over one twin (roof-shadow.ts). Holds the triangle soup (corners, UVs, the normals'
 * y, photo per triangle), the occluders (the soup's corners, then the context's), the photos with roof triangles,
 * and, once cells() ran, the map from straight above and the cells.
 */
class RoofShadowKernels {
public:
    RoofParams params;
    /** Occluder corners: the soup's first (soupTriangles of them), then the context's. */
    std::vector<float> occ;
    size_t soupTriangles = 0;
    std::vector<float> uv, ny;
    std::vector<int32_t> img;
    std::vector<Photo> photos;
    /** log(1e-4 + linear) of each 8-bit code, and the linear value, as the TypeScript has them. */
    double logLinear[256]{};
    float linear[256]{};
    Srgb8Encoder encoder{};

    ShadowMap above;
    RoofCells cells;

    explicit RoofShadowKernels(TexelPool& pool) : pool_(pool) {}

    /** Called once the inputs are in: each photo's roof triangles, in order. */
    void index() {
        photoOf_.clear();
        for (size_t k = 0; k < photos.size(); ++k) photoOf_[photos[k].img] = static_cast<int>(k);
        roofTris_.assign(photos.size(), {});
        for (size_t t = 0; t < soupTriangles; ++t) {
            if (img[t] < 0 || std::fabs(static_cast<double>(ny[t])) < params.flatNy) continue;
            auto it = photoOf_.find(img[t]);
            if (it != photoOf_.end()) roofTris_[static_cast<size_t>(it->second)].push_back(static_cast<uint32_t>(t));
        }
    }

    /** roof-shadow.ts roofCells, with the map from straight above built first. */
    void computeCells(const SunFrame& aboveFrame, double aboveMpp) {
        buildShadowMap(above, occ.data(), soupTriangles, aboveFrame, aboveMpp, &pool_);
        struct Entry { uint32_t t; float p[3]; float c[3]; };
        std::vector<std::vector<Entry>> per(photos.size());
        pool_.run(photos.size(), [&](size_t k, unsigned) {
            const Photo& ph = photos[k];
            const int G = params.cellTexels, W = ph.W, H = ph.H;
            const int gw = static_cast<int>(std::ceil(static_cast<double>(W) / G)), gh = static_cast<int>(std::ceil(static_cast<double>(H) / G));
            std::vector<uint8_t> seen(static_cast<size_t>(gw) * static_cast<size_t>(std::max(1, gh)), 0);
            auto& out = per[k];
            for (uint32_t t : roofTris_[k]) {
                const float* a = occ.data() + static_cast<size_t>(t) * 9;
                const float* q = uv.data() + static_cast<size_t>(t) * 6;
                const double ax = (static_cast<double>(q[0]) * W) / G, ay = (static_cast<double>(q[1]) * H) / G, bx = (static_cast<double>(q[2]) * W) / G, by = (static_cast<double>(q[3]) * H) / G, cx = (static_cast<double>(q[4]) * W) / G, cy = (static_cast<double>(q[5]) * H) / G;
                const double det = (bx - ax) * (cy - ay) - (cx - ax) * (by - ay);
                if (std::fabs(det) < 1e-12) continue;
                const double x0 = std::max(0.0, std::floor(std::min(std::min(ax, bx), cx))), x1 = std::min(static_cast<double>(gw - 1), std::ceil(std::max(std::max(ax, bx), cx)));
                const double y0 = std::max(0.0, std::floor(std::min(std::min(ay, by), cy))), y1 = std::min(std::ceil(static_cast<double>(H) / G) - 1, std::ceil(std::max(std::max(ay, by), cy)));
                for (double gy = y0; gy <= y1; ++gy) for (double gx = x0; gx <= x1; ++gx) {
                    const double px = gx + 0.5, py = gy + 0.5;
                    const double b1 = ((px - ax) * (cy - ay) - (cx - ax) * (py - ay)) / det, b2 = ((bx - ax) * (py - ay) - (px - ax) * (by - ay)) / det, b0 = 1 - b1 - b2;
                    if (b0 < 0 || b1 < 0 || b2 < 0) continue;
                    const size_t key = static_cast<size_t>(gy) * static_cast<size_t>(gw) + static_cast<size_t>(gx);
                    if (seen[key]) continue;
                    const size_t tx = static_cast<size_t>(std::min(static_cast<double>(W - 1), std::floor(px * G))), ty = static_cast<size_t>(std::min(static_cast<double>(H - 1), std::floor(py * G))), i = ty * static_cast<size_t>(W) + tx;
                    if (ph.mask[i] == TEXEL_NONE) continue;
                    const double x = b0 * a[0] + b1 * a[3] + b2 * a[6], y = b0 * a[1] + b1 * a[4] + b2 * a[7], z = b0 * a[2] + b1 * a[5] + b2 * a[8];
                    if (above.shadowedAt(x, y, z, params.biasM)) continue;
                    seen[key] = 1;
                    Entry e{t, {static_cast<float>(x), static_cast<float>(y), static_cast<float>(z)}, {}};
                    for (int c = 0; c < 3; ++c) e.c[c] = static_cast<float>(logLinear[ph.rgba[i * 4 + static_cast<size_t>(c)]]);
                    out.push_back(e);
                }
            }
        });
        // back in triangle order: a triangle's cells are one run of its photo's list
        std::vector<uint32_t> start(soupTriangles + 1, 0);
        for (const auto& list : per) for (const Entry& e : list) ++start[e.t + 1];
        for (size_t t = 0; t < soupTriangles; ++t) start[t + 1] += start[t];
        const size_t n = start[soupTriangles];
        cells.img.assign(n, 0);
        cells.p.assign(n * 3, 0);
        cells.c.assign(n * 3, 0);
        pool_.run(photos.size(), [&](size_t k, unsigned) {
            size_t i = 0;
            uint32_t last = UINT32_MAX;
            for (const Entry& e : per[k]) {
                if (e.t != last) { i = start[e.t]; last = e.t; }
                cells.img[i] = photos[k].img;
                std::memcpy(&cells.p[i * 3], e.p, sizeof e.p);
                std::memcpy(&cells.c[i * 3], e.c, sizeof e.c);
                ++i;
            }
        });
    }

    /** Each cell in each sun's shadow (1) or not (0), suns.size() x cells bytes; one sun a task, its map dropped after. */
    std::vector<uint8_t> cellShadows(const std::vector<SunFrame>& suns, double mpp) {
        const size_t n = cells.size();
        std::vector<uint8_t> bits(suns.size() * n, 0);
        std::vector<ShadowMap> maps(pool_.size());
        pool_.run(suns.size(), [&](size_t s, unsigned w) {
            ShadowMap& m = maps[w];
            buildShadowMap(m, occ.data(), occ.size() / 9, suns[s], mpp);
            uint8_t* out = bits.data() + s * n;
            for (size_t i = 0; i < n; ++i) out[i] = m.shadowedAt(cells.p[i * 3], cells.p[i * 3 + 1], cells.p[i * 3 + 2], params.biasM) ? 1 : 0;
        });
        return bits;
    }

    struct LiftOut {
        /** Per photo (in `photos` order): texels lifted (a texel once per triangle and sun that lifts it), and its new pixels if any. */
        std::vector<double> lifted;
        std::vector<std::vector<uint8_t>> changed;
    };

    /** roof-shadow.ts's lift (step 7), sun by sun in the plan's order, each sun's photos in parallel. */
    LiftOut lift(const LiftPlan& plan) {
        LiftOut out;
        out.lifted.assign(photos.size(), 0);
        out.changed.assign(photos.size(), {});
        ShadowMap m;
        for (size_t s = 0; s < plan.suns.size(); ++s) {
            buildShadowMap(m, occ.data(), occ.size() / 9, plan.suns[s], plan.mpp, &pool_);
            pool_.run(photos.size(), [&](size_t k, unsigned) { liftPhoto(plan, m, static_cast<int>(s), k, out); });
        }
        return out;
    }

private:
    void liftPhoto(const LiftPlan& plan, const ShadowMap& m, int sunIndex, size_t k, LiftOut& out) const {
        const Photo& ph = photos[k];
        auto ps = plan.photoSun.find(ph.img);
        const LiftPlan::PhotoSun* sun = ps == plan.photoSun.end() ? nullptr : &ps->second;
        if (sun ? sun->sun != sunIndex : plan.comps.empty()) return;
        const int W = ph.W, H = ph.H;
        const RoofParams& P = params;
        std::vector<uint8_t>& dst = out.changed[k];
        double lifted = 0;
        for (uint32_t t : roofTris_[k]) {
            const float* a = occ.data() + static_cast<size_t>(t) * 9;
            const float* q = uv.data() + static_cast<size_t>(t) * 6;
            const double ax = static_cast<double>(q[0]) * W, ay = static_cast<double>(q[1]) * H, bx = static_cast<double>(q[2]) * W, by = static_cast<double>(q[3]) * H, cx = static_cast<double>(q[4]) * W, cy = static_cast<double>(q[5]) * H;
            const double det = (bx - ax) * (cy - ay) - (cx - ax) * (by - ay);
            if (std::fabs(det) < 1e-12) continue;
            const double x0 = std::max(0.0, std::floor(std::min(std::min(ax, bx), cx))), x1 = std::min(static_cast<double>(W - 1), std::ceil(std::max(std::max(ax, bx), cx)));
            const double y0 = std::max(0.0, std::floor(std::min(std::min(ay, by), cy))), y1 = std::min(static_cast<double>(H - 1), std::ceil(std::max(std::max(ay, by), cy)));
            for (double y = y0; y <= y1; ++y) for (double x = x0; x <= x1; ++x) {
                const size_t i = static_cast<size_t>(y) * static_cast<size_t>(W) + static_cast<size_t>(x);
                if (ph.mask[i] == TEXEL_NONE) continue;
                const double px = x + 0.5, py = y + 0.5;
                const double b1 = ((px - ax) * (cy - ay) - (cx - ax) * (py - ay)) / det, b2 = ((bx - ax) * (py - ay) - (px - ax) * (by - ay)) / det, b0 = 1 - b1 - b2;
                if (b0 < 0 || b1 < 0 || b2 < 0) continue;
                const double wx = b0 * a[0] + b1 * a[3] + b2 * a[6], wy = b0 * a[1] + b1 * a[4] + b2 * a[7], wz = b0 * a[2] + b1 * a[5] + b2 * a[8];
                const double* ratio;
                double lit, logLum;
                if (sun) {
                    auto it = plan.terraceLit.find(LiftPlan::terraceKey(ph.img, static_cast<int32_t>(jsRound(wy / P.terraceBinM))));
                    if (it == plan.terraceLit.end()) continue;
                    ratio = sun->ratio; lit = it->second; logLum = sun->logLum;
                } else {
                    auto it = plan.compOfKey.find(LiftPlan::gridKey(static_cast<int32_t>(jsRound(wy / P.terraceBinM)), static_cast<int32_t>(std::floor(wx / P.componentGridM)), static_cast<int32_t>(std::floor(wz / P.componentGridM))));
                    if (it == plan.compOfKey.end()) continue;
                    const LiftPlan::Comp& c = plan.comps[static_cast<size_t>(it->second)];
                    if (c.sun != sunIndex) continue;
                    ratio = c.ratio; lit = c.lit; logLum = c.logLum;
                }
                if (above.shadowedAt(wx, wy, wz, P.biasM)) continue;
                double f = m.fraction(wx, wy, wz, P.biasM);
                if (f <= 0) continue;
                // never above the terrace's lit level: the share of the lift this texel's own darkness asks for
                if (!std::isnan(lit)) {
                    const uint8_t* rgb = &ph.rgba[i * 4];
                    const double L = 0.2126 * logLinear[rgb[0]] + 0.7152 * logLinear[rgb[1]] + 0.0722 * logLinear[rgb[2]];
                    const double full = f * logLum;
                    if (full > 0) f *= std::max(0.0, std::min(1.0, (lit - L) / full));
                    if (f <= 0.01) continue;
                }
                if (dst.empty()) dst = ph.rgba;
                lifted += 1;
                for (int c = 0; c < 3; ++c) dst[i * 4 + static_cast<size_t>(c)] = encoder.encode(static_cast<double>(linear[ph.rgba[i * 4 + static_cast<size_t>(c)]]) * std::pow(ratio[c], f));
            }
        }
        out.lifted[k] += lifted;
    }

    TexelPool& pool_;
    std::unordered_map<int32_t, int> photoOf_;
    std::vector<std::vector<uint32_t>> roofTris_;
};

/** One photo's harmonisation: its offset field's nodes (nx by ny from base in the offsets), its wall and roof gains (natural log). */
struct HarmonizePhoto {
    Photo photo;
    bool hasMask = false;
    int nx = 2, ny = 2, base = 0;
    double wallGain[3]{}, roofGain[3]{};
};

/**
 * texture-harmonize.ts's apply: per texel, the photo's gain (its roof's on a roof texel) and its field's offset
 * (bilinear in the node grid), in linear light, into `out[k]` (RGBA, alpha kept). Blocks of rows of every photo are
 * the tasks.
 */
inline void harmonizeApply(TexelPool& pool, const std::vector<HarmonizePhoto>& photos, const std::vector<double> off[3], const float linear[256], const Srgb8Encoder& encoder, std::vector<std::vector<uint8_t>>& out) {
    constexpr int ROWS = 16;
    struct Task { size_t k; int y0, y1; };
    std::vector<Task> tasks;
    // the field's bilinear cell and weight per column and per row, once a photo
    std::vector<std::vector<int>> ci(photos.size()), rj(photos.size());
    std::vector<std::vector<double>> ca(photos.size()), rb(photos.size());
    out.assign(photos.size(), {});
    for (size_t k = 0; k < photos.size(); ++k) {
        const HarmonizePhoto& h = photos[k];
        const int W = h.photo.W, H = h.photo.H;
        ci[k].resize(static_cast<size_t>(W)); ca[k].resize(static_cast<size_t>(W)); rj[k].resize(static_cast<size_t>(H)); rb[k].resize(static_cast<size_t>(H));
        for (int x = 0; x < W; ++x) { const double fx = ((x + 0.5) / W) * (h.nx - 1); ci[k][static_cast<size_t>(x)] = static_cast<int>(std::min(static_cast<double>(h.nx - 2), std::floor(fx))); ca[k][static_cast<size_t>(x)] = fx - ci[k][static_cast<size_t>(x)]; }
        for (int y = 0; y < H; ++y) { const double fy = ((y + 0.5) / H) * (h.ny - 1); rj[k][static_cast<size_t>(y)] = static_cast<int>(std::min(static_cast<double>(h.ny - 2), std::floor(fy))); rb[k][static_cast<size_t>(y)] = fy - rj[k][static_cast<size_t>(y)]; }
        out[k].resize(h.photo.rgba.size());
        for (int y = 0; y < H; y += ROWS) tasks.push_back({k, y, std::min(H, y + ROWS)});
    }
    pool.run(tasks.size(), [&](size_t ti, unsigned) {
        const Task& task = tasks[ti];
        const HarmonizePhoto& h = photos[task.k];
        const int W = h.photo.W;
        const uint8_t* src = h.photo.rgba.data();
        uint8_t* dst = out[task.k].data();
        const int* cix = ci[task.k].data();
        const double* cax = ca[task.k].data();
        for (int y = task.y0; y < task.y1; ++y) {
            const double b = rb[task.k][static_cast<size_t>(y)];
            const int row = h.base + rj[task.k][static_cast<size_t>(y)] * h.nx;
            for (int x = 0; x < W; ++x) {
                const double a = cax[x];
                const size_t k00 = static_cast<size_t>(row + cix[x]), k10 = k00 + 1, k01 = k00 + static_cast<size_t>(h.nx), k11 = k01 + 1;
                const double w00 = (1 - a) * (1 - b), w10 = a * (1 - b), w01 = (1 - a) * b, w11 = a * b;
                const size_t i = static_cast<size_t>(y) * static_cast<size_t>(W) + static_cast<size_t>(x), p = i * 4;
                const double* gg = h.hasMask && h.photo.mask[i] == TEXEL_ROOF ? h.roofGain : h.wallGain;
                for (int c = 0; c < 3; ++c) {
                    const double* oc = off[c].data();
                    const double o = gg[c] + w00 * oc[k00] + w10 * oc[k10] + w01 * oc[k01] + w11 * oc[k11];
                    dst[p + static_cast<size_t>(c)] = encoder.encode(static_cast<double>(linear[src[p + static_cast<size_t>(c)]]) * std::exp(o));
                }
                dst[p + 3] = src[p + 3];
            }
        }
    });
}

} // namespace twin_texels
} // namespace scratchbox

#endif // SCRATCHBOX_TWIN_TEXELS_HPP
