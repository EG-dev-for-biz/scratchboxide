/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * height_displace_native: the tessellate-and-displace kernel (scratchbox_height_displace.hpp) behind a small CLI, for
 * height-displace-native.ts. One binary request file in, one binary result file out; every patch of a model in one call.
 *
 * usage: height_displace_native <request.bin> <result.bin>
 *
 * Layout: little-endian, packed, no padding.
 *
 * Request: u32 magic 0x44484253 ("SBHD"), u32 version 1, u32 threads (0: every core);
 *   f64 depthM, f64 edgeMinM, f64 edgeMaxM, f64 toleranceM, u32 maxTriangles (all patches together);
 *   u32 tileCount, per tile: u32 w, u32 h (0 0: the class has no relief), u8 v[w * h], f64 sizeX, f64 sizeY;
 *   u32 mapCount, per class map: u32 w, u32 h, u8 class[w * h];
 *   u32 patchCount, per patch: u32 map (0xFFFFFFFF: none, the next field the class of the whole patch), u32 constClass,
 *     f64 uvMetresX, f64 uvMetresY, u32 V, f32 pos[V * 3], f32 nrm[V * 3], f32 uv[V * 2], u32 I, u32 idx[I].
 *
 * Result: u32 magic, u32 version, f64 edgeMinM (as used: raised until the patches fit maxTriangles), u32 patchCount,
 *   per patch: u32 surfaceTriangles, u32 riserTriangles, u8 limited, f64 maxRecessM, f64 meanRecessM,
 *     u32 V, f32 pos[V * 3], f32 nrm[V * 3], f32 uv[V * 2], u32 I, u32 idx[I].
 * Exit 0 on success; otherwise a message on stderr and a non-zero exit.
 */

#include "scratchbox_height_displace.hpp"

#include <atomic>
#include <cstdio>
#include <cstring>
#include <fstream>
#include <iostream>
#include <mutex>
#include <stdexcept>
#include <string>
#include <thread>

namespace hd = scratchbox::height_displace;

static constexpr uint32_t MAGIC = 0x44484253u, VERSION = 1;

struct Reader {
    std::vector<uint8_t> buf;
    size_t at = 0;
    void need(size_t n) { if (at + n > buf.size()) throw std::runtime_error("request truncated at byte " + std::to_string(at)); }
    template <typename T> T get() { need(sizeof(T)); T v; std::memcpy(&v, buf.data() + at, sizeof(T)); at += sizeof(T); return v; }
    template <typename T> void array(std::vector<T>& out, size_t n) { need(n * sizeof(T)); out.resize(n); if (n) std::memcpy(out.data(), buf.data() + at, n * sizeof(T)); at += n * sizeof(T); }
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

struct Patch { hd::Mesh mesh; hd::Field field; };

int main(int argc, char** argv) {
    if (argc != 3) { std::cerr << "usage: height_displace_native <request.bin> <result.bin>\n"; return 2; }
    try {
        Reader in;
        {
            std::ifstream f(argv[1], std::ios::binary);
            if (!f) throw std::runtime_error(std::string("cannot read ") + argv[1]);
            in.buf.assign(std::istreambuf_iterator<char>(f), std::istreambuf_iterator<char>());
        }
        if (in.get<uint32_t>() != MAGIC) throw std::runtime_error("not a height displace request (bad magic)");
        if (in.get<uint32_t>() != VERSION) throw std::runtime_error("unsupported request version");
        const uint32_t threads = in.get<uint32_t>();
        hd::Params P;
        const double depthM = in.get<double>();
        P.edgeMinM = in.get<double>(); P.edgeMaxM = in.get<double>(); P.toleranceM = in.get<double>();
        const uint32_t maxTriangles = in.get<uint32_t>();
        if (!(depthM > 0) || !(P.edgeMinM > 0) || !(P.edgeMaxM >= P.edgeMinM) || !(P.toleranceM > 0) || !maxTriangles) throw std::runtime_error("depth, edge lengths, tolerance and the triangle limit must be positive");

        std::vector<hd::Tile> tiles(in.get<uint32_t>());
        for (auto& t : tiles) {
            t.w = static_cast<int>(in.get<uint32_t>()); t.h = static_cast<int>(in.get<uint32_t>());
            in.array(t.v, static_cast<size_t>(t.w) * t.h);
            t.sizeX = in.get<double>(); t.sizeY = in.get<double>();
            if (t.has() && !(t.sizeX > 0 && t.sizeY > 0)) throw std::runtime_error("a tile needs its real size");
        }
        std::vector<hd::ClassMap> maps(in.get<uint32_t>());
        for (auto& c : maps) {
            c.w = static_cast<int>(in.get<uint32_t>()); c.h = static_cast<int>(in.get<uint32_t>());
            if (c.w < 1 || c.h < 1) throw std::runtime_error("an empty class map");
            in.array(c.c, static_cast<size_t>(c.w) * c.h);
        }
        std::vector<Patch> patches(in.get<uint32_t>());
        for (auto& p : patches) {
            const uint32_t map = in.get<uint32_t>();
            p.field.constClass = static_cast<int>(in.get<uint32_t>());
            if (map != 0xFFFFFFFFu) { if (map >= maps.size()) throw std::runtime_error("class map index out of range"); p.field.map = &maps[map]; }
            p.field.tiles = &tiles; p.field.depthM = depthM;
            p.field.uvMetresX = in.get<double>(); p.field.uvMetresY = in.get<double>();
            const uint32_t V = in.get<uint32_t>();
            in.array(p.mesh.pos, static_cast<size_t>(V) * 3); in.array(p.mesh.nrm, static_cast<size_t>(V) * 3); in.array(p.mesh.uv, static_cast<size_t>(V) * 2);
            const uint32_t I = in.get<uint32_t>();
            if (I % 3) throw std::runtime_error("a patch's indices must be triangles");
            in.array(p.mesh.idx, I);
            for (const uint32_t i : p.mesh.idx) if (i >= V) throw std::runtime_error("a patch's index is out of range");
        }
        if (in.at != in.buf.size()) throw std::runtime_error("request has " + std::to_string(in.buf.size() - in.at) + " trailing bytes");

        // every patch at the detail asked; while they hold more triangles than allowed, the least edge is raised for all
        std::vector<hd::Result> rs(patches.size());
        double edgeMin = P.edgeMinM;
        for (int attempt = 0; attempt < 12; attempt++) {
            hd::Params q = P;
            q.edgeMinM = edgeMin; q.edgeMaxM = std::max(P.edgeMaxM, edgeMin);
            // a patch alone may hold the whole allowance; the sum decides
            q.maxTriangles = maxTriangles;
            parallelFor(patches.size(), threads, [&](size_t i) { rs[i] = hd::displace(patches[i].mesh, patches[i].field, q); });
            uint64_t total = 0;
            for (const auto& r : rs) total += r.surfaceTriangles + r.riserTriangles;
            if (total <= maxTriangles) break;
            edgeMin *= 1.4;
        }

        Writer out(argv[2]);
        out.put(MAGIC); out.put(VERSION); out.put(edgeMin); out.put(static_cast<uint32_t>(rs.size()));
        for (auto& r : rs) {
            out.put(r.surfaceTriangles); out.put(r.riserTriangles); out.put(static_cast<uint8_t>(r.limited ? 1 : 0)); out.put(r.maxRecessM); out.put(r.meanRecessM);
            out.put(static_cast<uint32_t>(r.mesh.pos.size() / 3)); out.array(r.mesh.pos); out.array(r.mesh.nrm); out.array(r.mesh.uv);
            out.put(static_cast<uint32_t>(r.mesh.idx.size())); out.array(r.mesh.idx);
            r = hd::Result{};
        }
        out.close();
        return 0;
    } catch (const std::exception& e) {
        std::cerr << "height_displace_native: " << e.what() << "\n";
        return 1;
    }
}
