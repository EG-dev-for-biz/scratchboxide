/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * material_regions_native: pipeline K's material-regions texel kernels (scratchbox_material_regions.hpp) behind a small
 * CLI, for material-regions-native.ts. One binary request file in, one binary result file out; a whole image or a whole
 * batch of jobs per call, so the process start is paid once.
 *
 * usage: material_regions_native <request.bin> <result.bin>
 *
 * Layout: little-endian, packed, no padding. u8/u32/i32/f32/f64 as named; an `image` is u32 width, u32 height,
 * u8 rgba[width * height * 4]; a `rects` is u32 count, f64 values[count] (u0 v0 u1 v1 each, in the photo's UVs).
 *
 * Request header: u32 magic 0x524D4253 ("SBMR"), u32 version 1, u32 mode, u32 threads (0: every core).
 *  mode 0, the colour tables: nothing more.
 *  mode 1, appearance classes (readRegionClasses' k-means): u32 imageCount, image[imageCount]; u32 photoCount, then per
 *    photo u32 image, u8 hasExcluded, rects excluded; then u32 samplesPerPhoto, u32 seed, u32 K, u32 iterations, f64 wL.
 *  mode 2, the harvest's texels: u32 imageCount, image[imageCount]; u32 K, f64 meanLab[K * 3], f64 wL; u32 photoCount,
 *    then per photo u32 image, u8 hasExcluded, rects excluded.
 *  mode 3, planMaterialJob for a batch of jobs: u32 imageCount, image[imageCount]; u32 K, f64 meanLab[K * 3];
 *    per set (K): f64 realSizeX, f64 realSizeY, image normal, image orm; f64 setMeanG[K], f64 wallMeanG;
 *    f64 paneWallShare, glassFeatherM, paneGlassWeight, glassRoughness;
 *    u32 planeCount, per plane: u32 width, u32 height, f64 orthoSMin, orthoTMax, pixel, u8 storeyOk, f64 pitch, phase,
 *    u8 win[w * h], i32 bay[w * h], i32 pane[w * h], u32 panedCount, i32 panedBays[panedCount];
 *    u32 jobCount, per job: u32 kind (0 rebuilt facade, 1 scan piece), u32 image, f64 texelM, then
 *      kind 0: rects fitted, rects panes, rects runs, rects bays;
 *      kind 1: u32 triangleCount, per triangle u32 plane, f64 uv[6], f64 sv[3], f64 tv[3].
 *
 * Result header: u32 magic, u32 version, u32 mode.
 *  mode 0: f32 srgb8ToLinear[256], f64 lab[32768 * 3] (labOf's buckets, key (r >> 3) << 10 | (g >> 3) << 5 | b >> 3).
 *  mode 1: u32 n (samples), u8 ok; when ok f64 C[K * 3], f64 count[K], f64 sd[K * 3] (centres by k-means index).
 *  mode 2: u32 photoCount, per photo u32 N, u8 valid[N], f32 L[N], i8 cls[N].
 *  mode 3: u32 jobCount, per job: u32 kind, u32 width, u32 height, u32 frameClass, then
 *      kind 0: f64 windowN, stoneN, paneN, panesOnStone, baysOnStone, texels, glass; u8 orm, normal, params [w * h * 4];
 *      kind 1: f64 onPlane, inWindows, inPanes, texels, glass, panesOnStone, baysOnStone, anyGlass; u8 orm, params [w * h * 4].
 * Exit 0 on success; otherwise a message on stderr and a non-zero exit.
 */

#include "scratchbox_material_regions.hpp"

#include <algorithm>
#include <atomic>
#include <cstdio>
#include <cstring>
#include <fstream>
#include <iostream>
#include <mutex>
#include <stdexcept>
#include <string>
#include <thread>
#include <vector>

namespace mr = scratchbox::material_regions;

static constexpr uint32_t MAGIC = 0x524D4253u, VERSION = 1;

struct Reader {
    std::vector<uint8_t> buf;
    size_t at = 0;
    void need(size_t n) { if (at + n > buf.size()) throw std::runtime_error("request truncated at byte " + std::to_string(at)); }
    template <typename T> T get() { need(sizeof(T)); T v; std::memcpy(&v, buf.data() + at, sizeof(T)); at += sizeof(T); return v; }
    uint32_t u32() { return get<uint32_t>(); }
    double f64() { return get<double>(); }
    uint8_t u8() { return get<uint8_t>(); }
    template <typename T> void array(std::vector<T>& out, size_t n) { need(n * sizeof(T)); out.resize(n); if (n) std::memcpy(out.data(), buf.data() + at, n * sizeof(T)); at += n * sizeof(T); }
    mr::Image image() {
        mr::Image img;
        img.width = static_cast<int>(u32()); img.height = static_cast<int>(u32());
        array(img.rgba, static_cast<size_t>(img.width) * img.height * 4);
        return img;
    }
    std::vector<double> rects() { std::vector<double> r; array(r, u32()); return r; }
};

struct Writer {
    FILE* f;
    explicit Writer(const char* path) : f(std::fopen(path, "wb")) { if (!f) throw std::runtime_error(std::string("cannot write ") + path); std::setvbuf(f, nullptr, _IOFBF, 1 << 22); }
    ~Writer() { if (f) std::fclose(f); }
    void bytes(const void* p, size_t n) { if (n && std::fwrite(p, 1, n, f) != n) throw std::runtime_error("short write"); }
    template <typename T> void put(T v) { bytes(&v, sizeof(T)); }
    template <typename T> void array(const std::vector<T>& v) { bytes(v.data(), v.size() * sizeof(T)); }
    void close() { if (std::fclose(f) != 0) { f = nullptr; throw std::runtime_error("close failed"); } f = nullptr; }
};

static std::vector<mr::Image> readImages(Reader& in) {
    std::vector<mr::Image> images(in.u32());
    for (auto& img : images) img = in.image();
    return images;
}

static const mr::Image& imageAt(const std::vector<mr::Image>& images, uint32_t i) {
    if (i >= images.size()) throw std::runtime_error("image index out of range");
    return images[i];
}

/** Runs fn(i) for i in [0, n) on up to `threads` threads (0: every core). */
template <typename F>
static void parallelFor(size_t n, unsigned threads, F&& fn) {
    if (!threads) threads = std::max(1u, std::thread::hardware_concurrency());
    threads = static_cast<unsigned>(std::min<size_t>(threads, n));
    if (threads <= 1) { for (size_t i = 0; i < n; i++) fn(i); return; }
    std::atomic<size_t> next{0};
    std::vector<std::thread> pool;
    std::exception_ptr err;
    std::mutex m;
    for (unsigned t = 0; t < threads; t++) pool.emplace_back([&] {
        try { for (size_t i; (i = next++) < n;) fn(i); }
        catch (...) { std::lock_guard<std::mutex> g(m); if (!err) err = std::current_exception(); }
    });
    for (auto& th : pool) th.join();
    if (err) std::rethrow_exception(err);
}

int main(int argc, char** argv) {
    if (argc != 3) { std::cerr << "usage: material_regions_native <request.bin> <result.bin>\n"; return 2; }
    try {
        Reader in;
        {
            std::ifstream f(argv[1], std::ios::binary);
            if (!f) throw std::runtime_error(std::string("cannot read ") + argv[1]);
            in.buf.assign(std::istreambuf_iterator<char>(f), std::istreambuf_iterator<char>());
        }
        if (in.u32() != MAGIC) throw std::runtime_error("not a material regions request (bad magic)");
        if (in.u32() != VERSION) throw std::runtime_error("unsupported request version");
        const uint32_t mode = in.u32(), threads = in.u32();
        Writer out(argv[2]);
        out.put(MAGIC); out.put(VERSION); out.put(mode);

        if (mode == 0) {
            out.bytes(mr::srgb8ToLinear().t, sizeof(float) * 256);
            out.array(mr::labTable().v);
        } else if (mode == 1 || mode == 2) {
            const auto images = readImages(in);
            std::vector<double> meanLab;
            double wL = 1;
            uint32_t K = 0;
            if (mode == 2) { K = in.u32(); in.array(meanLab, static_cast<size_t>(K) * 3); wL = in.f64(); }
            std::vector<mr::SampledPhoto> photos(in.u32());
            for (auto& ph : photos) {
                const mr::Image& img = imageAt(images, in.u32());
                const bool has = in.u8() != 0;
                const auto rects = in.rects();
                ph.img = &img;
                if (has) ph.excluded = mr::excludedMask(rects, img.width, img.height);
            }
            if (mode == 1) {
                const uint32_t samples = in.u32(), seed = in.u32();
                K = in.u32();
                const uint32_t iterations = in.u32();
                wL = in.f64();
                if (K < 1 || K > 255) throw std::runtime_error("classes must be 1..255");
                const auto r = mr::appearanceKMeans(photos, static_cast<int>(samples), seed, static_cast<int>(K), static_cast<int>(iterations), wL);
                out.put(static_cast<uint32_t>(r.n)); out.put(static_cast<uint8_t>(r.ok ? 1 : 0));
                if (r.ok) { out.array(r.C); out.array(r.count); out.array(r.sd); }
            } else {
                if (K < 1 || K > 127) throw std::runtime_error("classes must be 1..127");
                std::vector<mr::HarvestTexels> h(photos.size());
                parallelFor(photos.size(), threads, [&](size_t i) { h[i] = mr::harvestClassify(*photos[i].img, photos[i].excluded, meanLab, wL); });
                out.put(static_cast<uint32_t>(photos.size()));
                for (const auto& t : h) { out.put(static_cast<uint32_t>(t.valid.size())); out.array(t.valid); out.array(t.L); out.array(t.cls); }
            }
        } else if (mode == 3) {
            const auto images = readImages(in);
            mr::PlanContext ctx;
            const uint32_t K = in.u32();
            if (K < 1 || K > 255) throw std::runtime_error("classes must be 1..255");
            in.array(ctx.meanLab, static_cast<size_t>(K) * 3);
            ctx.sets.resize(K);
            for (auto& s : ctx.sets) { s.realSizeX = in.f64(); s.realSizeY = in.f64(); s.normal = in.image(); s.orm = in.image(); }
            in.array(ctx.setMeanG, K);
            ctx.wallMeanG = in.f64();
            ctx.P.paneWallShare = in.f64(); ctx.P.glassFeatherM = in.f64(); ctx.P.paneGlassWeight = in.f64(); ctx.P.glassRoughness = in.f64();
            std::vector<mr::PlaneRaster> planes(in.u32());
            for (auto& p : planes) {
                p.width = static_cast<int>(in.u32()); p.height = static_cast<int>(in.u32());
                p.orthoSMin = in.f64(); p.orthoTMax = in.f64(); p.pixel = in.f64();
                p.storey.ok = in.u8() != 0; p.storey.pitch = in.f64(); p.storey.phase = in.f64();
                const size_t n = static_cast<size_t>(p.width) * p.height;
                in.array(p.win, n); in.array(p.bay, n); in.array(p.pane, n);
                std::vector<int32_t> paned;
                in.array(paned, in.u32());
                p.panedBays.insert(paned.begin(), paned.end());
            }
            const uint32_t jobCount = in.u32();
            std::vector<uint32_t> kinds(jobCount);
            std::vector<mr::RebuiltJob> rebuilt(jobCount);
            std::vector<mr::ScanJob> scans(jobCount);
            for (uint32_t i = 0; i < jobCount; i++) {
                kinds[i] = in.u32();
                const mr::Image& img = imageAt(images, in.u32());
                const double texelM = in.f64();
                if (kinds[i] == 0) {
                    auto& j = rebuilt[i];
                    j.img = &img; j.texelM = texelM;
                    j.fitted = in.rects(); j.panes = in.rects(); j.runs = in.rects(); j.bays = in.rects();
                } else if (kinds[i] == 1) {
                    auto& j = scans[i];
                    j.img = &img; j.texelM = texelM;
                    j.tris.resize(in.u32());
                    for (auto& t : j.tris) {
                        t.plane = in.u32();
                        if (t.plane >= planes.size()) throw std::runtime_error("triangle plane out of range");
                        for (double& v : t.uv) v = in.f64();
                        for (double& v : t.sv) v = in.f64();
                        for (double& v : t.tv) v = in.f64();
                    }
                } else throw std::runtime_error("unknown job kind");
            }
            std::vector<mr::RebuiltResult> rr(jobCount);
            std::vector<mr::ScanResult> sr(jobCount);
            parallelFor(jobCount, threads, [&](size_t i) {
                if (kinds[i] == 0) rr[i] = mr::planRebuilt(rebuilt[i], ctx);
                else sr[i] = mr::planScan(scans[i], planes, ctx);
            });
            out.put(jobCount);
            for (uint32_t i = 0; i < jobCount; i++) {
                out.put(kinds[i]);
                if (kinds[i] == 0) {
                    auto& r = rr[i];
                    out.put(static_cast<uint32_t>(r.width)); out.put(static_cast<uint32_t>(r.height)); out.put(static_cast<uint32_t>(r.frameClass));
                    for (double v : {r.windowN, r.stoneN, r.paneN, r.panesOnStone, r.baysOnStone, r.texels, r.glass}) out.put(v);
                    out.array(r.orm); out.array(r.normal); out.array(r.params);
                    r = mr::RebuiltResult{};
                } else {
                    auto& r = sr[i];
                    out.put(static_cast<uint32_t>(r.width)); out.put(static_cast<uint32_t>(r.height)); out.put(static_cast<uint32_t>(r.frameClass));
                    for (double v : {r.onPlane, r.inWindows, r.inPanes, r.texels, r.glass, r.panesOnStone, r.baysOnStone, r.anyGlass ? 1.0 : 0.0}) out.put(v);
                    out.array(r.orm); out.array(r.params);
                    r = mr::ScanResult{};
                }
            }
        } else {
            throw std::runtime_error("unknown mode " + std::to_string(mode));
        }
        if (in.at != in.buf.size()) throw std::runtime_error("request has " + std::to_string(in.buf.size() - in.at) + " trailing bytes");
        out.close();
        return 0;
    } catch (const std::exception& e) {
        std::cerr << "material_regions_native: " << e.what() << "\n";
        return 1;
    }
}
