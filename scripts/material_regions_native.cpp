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
 * u8 rgba[width * height * 4].
 *
 * Request header: u32 magic 0x524D4253 ("SBMR"), u32 version 5, u32 mode, u32 threads (0: every core).
 *  A `rects` is u32 count, f64 values[count] (u0 v0 u1 v1 each, in the photo's UVs): a photo's window openings.
 *  mode 0, the colour tables: nothing more.
 *  mode 1, appearance classes (readRegionClasses' k-means): u32 imageCount, image[imageCount]; u32 photoCount, per photo
 *    u32 image, rects openings; then u32 samplesPerPhoto, u32 seed, u32 K, u32 Kopen, u32 iterations, f64 wL.
 *  mode 2, the harvest's texels: u32 imageCount, image[imageCount]; u32 K, f64 meanLab[K * 3], u8 openings[K], f64 wL;
 *    u32 photoCount, per photo u32 image, rects openings.
 *  mode 3, planMaterialJob for a batch of jobs: u32 imageCount, image[imageCount]; u32 K, f64 meanLab[K * 3],
 *    u8 openings[K], u32 wall, u32 repeatGrid; per set (K): f64 realSizeX, f64 realSizeY, image normal, image orm; f64 setMeans[K * 3];
 *    u32 jobCount, per job: u32 kind (0 rebuilt facade, 1 scan piece), u32 image, f64 texelM, u32 radius, rects openings,
 *    rects repeat elements (their unit cells), u32 family[elements].
 *
 * Result header: u32 magic, u32 version, u32 mode.
 *  mode 0: f32 srgb8ToLinear[256], f64 lab[32768 * 3] (labOf's buckets, key (r >> 3) << 10 | (g >> 3) << 5 | b >> 3).
 *  mode 1: per region (outside, then inside the openings): u32 n (samples), u8 ok; when ok f64 C[Kr * 3], f64 count[Kr],
 *    f64 sd[Kr * 3] (centres by k-means index).
 *  mode 2: u32 photoCount, per photo u32 N, u8 valid[N], f32 L[N], i8 cls[N].
 *  mode 3: u32 jobCount, per job: u32 kind, u32 width, u32 height, f64 classTexels[K], f64 folded, u8 orm[w * h * 4], and for
 *    kind 0 u8 normal[w * h * 4].
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

static constexpr uint32_t MAGIC = 0x524D4253u, VERSION = 5;

struct Reader {
    std::vector<uint8_t> buf;
    size_t at = 0;
    void need(size_t n) { if (at + n > buf.size()) throw std::runtime_error("request truncated at byte " + std::to_string(at)); }
    template <typename T> T get() { need(sizeof(T)); T v; std::memcpy(&v, buf.data() + at, sizeof(T)); at += sizeof(T); return v; }
    uint32_t u32() { return get<uint32_t>(); }
    double f64() { return get<double>(); }
    uint8_t u8() { return get<uint8_t>(); }
    template <typename T> void array(std::vector<T>& out, size_t n) { need(n * sizeof(T)); out.resize(n); if (n) std::memcpy(out.data(), buf.data() + at, n * sizeof(T)); at += n * sizeof(T); }
    std::vector<double> rects() { std::vector<double> r; array(r, u32()); return r; }
    mr::Image image() {
        mr::Image img;
        img.width = static_cast<int>(u32()); img.height = static_cast<int>(u32());
        array(img.rgba, static_cast<size_t>(img.width) * img.height * 4);
        return img;
    }
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
            std::vector<uint8_t> openings;
            double wL = 1;
            uint32_t K = 0;
            if (mode == 2) { K = in.u32(); in.array(meanLab, static_cast<size_t>(K) * 3); in.array(openings, K); wL = in.f64(); }
            std::vector<mr::SampledPhoto> photos(in.u32());
            for (auto& ph : photos) { ph.img = &imageAt(images, in.u32()); ph.open = mr::openingMask(in.rects(), ph.img->width, ph.img->height); }
            if (mode == 1) {
                const uint32_t samples = in.u32(), seed = in.u32();
                K = in.u32();
                const uint32_t Kopen = in.u32(), iterations = in.u32();
                wL = in.f64();
                if (K < 1 || K + Kopen > 255) throw std::runtime_error("classes must be 1..255");
                for (const auto& r : mr::appearanceKMeans(photos, static_cast<int>(samples), seed, static_cast<int>(K), static_cast<int>(Kopen), static_cast<int>(iterations), wL)) {
                    out.put(static_cast<uint32_t>(r.n)); out.put(static_cast<uint8_t>(r.ok ? 1 : 0));
                    if (r.ok) { out.array(r.C); out.array(r.count); out.array(r.sd); }
                }
            } else {
                if (K < 1 || K > 127) throw std::runtime_error("classes must be 1..127");
                std::vector<mr::HarvestTexels> h(photos.size());
                parallelFor(photos.size(), threads, [&](size_t i) { h[i] = mr::harvestClassify(*photos[i].img, photos[i].open, meanLab, openings, wL); });
                out.put(static_cast<uint32_t>(photos.size()));
                for (const auto& t : h) { out.put(static_cast<uint32_t>(t.valid.size())); out.array(t.valid); out.array(t.L); out.array(t.cls); }
            }
        } else if (mode == 3) {
            const auto images = readImages(in);
            mr::PlanContext ctx;
            const uint32_t K = in.u32();
            if (K < 1 || K > 255) throw std::runtime_error("classes must be 1..255");
            in.array(ctx.meanLab, static_cast<size_t>(K) * 3);
            in.array(ctx.openings, K);
            ctx.wall = static_cast<int>(in.u32());
            if (ctx.wall >= static_cast<int>(K)) throw std::runtime_error("wall class out of range");
            ctx.grid = static_cast<int>(in.u32());
            if (ctx.grid < 1 || ctx.grid > 256) throw std::runtime_error("repeat grid must be 1..256");
            ctx.sets.resize(K);
            for (auto& s : ctx.sets) { s.realSizeX = in.f64(); s.realSizeY = in.f64(); s.normal = in.image(); s.orm = in.image(); }
            in.array(ctx.setMeans, static_cast<size_t>(K) * 3);
            const uint32_t jobCount = in.u32();
            std::vector<mr::PlanJob> jobs(jobCount);
            for (auto& j : jobs) {
                const uint32_t kind = in.u32();
                if (kind > 1) throw std::runtime_error("unknown job kind");
                j.rebuilt = kind == 0;
                j.img = &imageAt(images, in.u32());
                j.texelM = in.f64();
                j.radius = static_cast<int>(in.u32());
                if (j.radius < 1 || j.radius > 120) throw std::runtime_error("radius must be 1..120");
                j.open = mr::openingMask(in.rects(), j.img->width, j.img->height);
                j.elements = in.rects();
                in.array(j.family, j.elements.size() / 4);
                if (j.elements.size() % 4) throw std::runtime_error("repeat elements must be u0 v0 u1 v1 each");
                if (j.rebuilt && !(j.texelM > 0)) throw std::runtime_error("a rebuilt facade needs its texel size");
            }
            std::vector<mr::PlanResult> rs(jobCount);
            parallelFor(jobCount, threads, [&](size_t i) { rs[i] = mr::planJob(jobs[i], ctx); });
            out.put(jobCount);
            for (uint32_t i = 0; i < jobCount; i++) {
                auto& r = rs[i];
                out.put(static_cast<uint32_t>(jobs[i].rebuilt ? 0 : 1));
                out.put(static_cast<uint32_t>(r.width)); out.put(static_cast<uint32_t>(r.height));
                out.array(r.classTexels); out.put(r.folded); out.array(r.orm);
                if (jobs[i].rebuilt) out.array(r.normal);
                r = mr::PlanResult{};
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
