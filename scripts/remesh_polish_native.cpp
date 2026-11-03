/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * CLI of pipeline K's remesh-polish steps run natively on a fixed thread pool (packages/core/src/node/3d-engine/
 * staged-location/remesh-polish-native.ts drives it; SCRATCHBOX_K_NATIVE_POLISH=0 keeps the TypeScript instead). Data
 * arrives on stdin as raw little-endian buffers, a header then arrays, never PNG:
 *
 *   remesh_polish_native window-fit <threads>
 *     in:  "SBWF" u32 version, u32 nParams, f64[nParams] (scratchbox_window_fit.hpp Params), then per facade
 *          u32 1, i32 slot, u32 W, u32 H, f64 pixel, f64 orthoSMin, f64 orthoTMax, f64 texel, u8 rgba[W*H*4],
 *          u8 unread[W*H]; u32 0 ends. Facades are fitted as they arrive, one a task.
 *     out: one JSON line per facade as it finishes (window_fit::fitJson), {"slot":n,"error":"..."} when one throws.
 *
 *   remesh_polish_native fill <threads>
 *     in:  "SBFL" u32 version, u32 nParams, f64[nParams] (scratchbox_open_loop_fill.hpp Params), u32 nLoops, per loop
 *          u32 n, f64[n*2] (the footprint, plan x z), u32 nPrims, per primitive i32 wall, u32 nVerts, f64[nVerts*3],
 *          u32 indexed, u32 nIdx, u32[nIdx].
 *     out: u32 jsonLen, the report's JSON, u32 nOut, f64[nOut*9] (the fill's triangles), u32 nPieces, per piece
 *          i32 parent, i32 of, f64[9] corners, f64[9] barycentric weights.
 *
 * Build: clang++ -std=c++20 -O3 -I packages/core/src/native/3d-engine/include scripts/remesh_polish_native.cpp -o build/3d-native/remesh_polish_native -lz
 */

#include "scratchbox_window_fit.hpp"
#include "scratchbox_open_loop_fill.hpp"
#include "scratchbox_thread_pool.hpp"

#include <chrono>
#include <cstdio>
#include <cstring>
#include <memory>
#include <mutex>
#include <stdexcept>
#include <string>
#include <vector>

using namespace scratchbox;

namespace {

void readExact(void* dst, size_t n) {
    auto* p = static_cast<uint8_t*>(dst);
    while (n) {
        const size_t got = std::fread(p, 1, n, stdin);
        if (!got) throw std::runtime_error("input ended early");
        p += got;
        n -= got;
    }
}
template <class T>
T readOne() { T v; readExact(&v, sizeof v); return v; }
std::vector<double> readDoubles(size_t n) { std::vector<double> v(n); if (n) readExact(v.data(), n * sizeof(double)); return v; }
void writeExact(const void* src, size_t n) { if (n && std::fwrite(src, 1, n, stdout) != n) throw std::runtime_error("output closed"); }
template <class T>
void writeOne(T v) { writeExact(&v, sizeof v); }

void expectMagic(const char* magic) {
    char m[4];
    readExact(m, 4);
    if (std::memcmp(m, magic, 4) != 0) throw std::runtime_error(std::string("expected the ") + magic + " header");
    if (readOne<uint32_t>() != 1) throw std::runtime_error("unknown input version");
}

std::string escapeJson(const std::string& s) {
    std::string o;
    for (char c : s) {
        if (c == '"' || c == '\\') { o += '\\'; o += c; }
        else if (static_cast<unsigned char>(c) < 0x20) o += ' ';
        else o += c;
    }
    return o;
}

int windowFit(unsigned threads) {
    expectMagic("SBWF");
    const auto params = window_fit::Params::from(readDoubles(readOne<uint32_t>()));
    FixedThreadPool pool(threads);
    std::mutex outM;
    const auto emit = [&](const std::string& line) {
        std::lock_guard<std::mutex> lock(outM);
        std::fwrite(line.data(), 1, line.size(), stdout);
        std::fputc('\n', stdout);
        std::fflush(stdout);
    };
    for (;;) {
        if (readOne<uint32_t>() == 0) break;
        auto ph = std::make_shared<window_fit::FacadePhoto>();
        const int slot = readOne<int32_t>();
        ph->W = static_cast<int>(readOne<uint32_t>());
        ph->H = static_cast<int>(readOne<uint32_t>());
        ph->pixel = readOne<double>(); ph->orthoSMin = readOne<double>(); ph->orthoTMax = readOne<double>(); ph->texel = readOne<double>();
        const size_t N = static_cast<size_t>(ph->W) * ph->H;
        ph->rgba.resize(N * 4);
        ph->unread.resize(N);
        readExact(ph->rgba.data(), N * 4);
        readExact(ph->unread.data(), N);
        pool.submit([ph, slot, &params, &pool, &emit] {
            const auto t0 = std::chrono::steady_clock::now();
            try {
                const auto fit = window_fit::fitFacadeWindows(*ph, params, &pool);
                emit(window_fit::fitJson(slot, fit, std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - t0).count()));
            } catch (const std::exception& e) {
                emit("{\"slot\":" + std::to_string(slot) + ",\"error\":\"" + escapeJson(e.what()) + "\"}");
            }
        });
    }
    pool.wait();
    return 0;
}

int fill(unsigned threads) {
    expectMagic("SBFL");
    const auto params = open_loop_fill::Params::from(readDoubles(readOne<uint32_t>()));
    std::vector<std::vector<std::array<double, 2>>> footprint(readOne<uint32_t>());
    for (auto& loop : footprint) {
        const auto v = readDoubles(static_cast<size_t>(readOne<uint32_t>()) * 2);
        for (size_t i = 0; i + 1 < v.size(); i += 2) loop.push_back({v[i], v[i + 1]});
    }
    std::vector<open_loop_fill::Prim> prims(readOne<uint32_t>());
    for (auto& p : prims) {
        p.wall = readOne<int32_t>();
        p.X = readDoubles(static_cast<size_t>(readOne<uint32_t>()) * 3);
        p.indexed = readOne<uint32_t>() != 0;
        p.I.resize(readOne<uint32_t>());
        if (!p.I.empty()) readExact(p.I.data(), p.I.size() * sizeof(uint32_t));
    }
    FixedThreadPool pool(threads);
    const auto r = open_loop_fill::fillOpenLoops(prims, footprint, params, pool);
    const std::string json = open_loop_fill::reportJson(r.report);
    writeOne<uint32_t>(static_cast<uint32_t>(json.size()));
    writeExact(json.data(), json.size());
    writeOne<uint32_t>(static_cast<uint32_t>(r.out.size()));
    for (const auto& t : r.out) for (const auto& p : t) writeExact(p.data(), sizeof(double) * 3);
    writeOne<uint32_t>(static_cast<uint32_t>(r.pieces.size()));
    for (const auto& pc : r.pieces) {
        writeOne<int32_t>(pc.parent);
        writeOne<int32_t>(pc.of);
        for (const auto& p : pc.p) writeExact(p.data(), sizeof(double) * 3);
        for (const auto& w : pc.w) writeExact(w.data(), sizeof(double) * 3);
    }
    std::fflush(stdout);
    return 0;
}

}  // namespace

int main(int argc, char** argv) {
    if (argc < 3) {
        std::fprintf(stderr, "usage: remesh_polish_native window-fit|fill <threads>  (binary input on stdin)\n");
        return 2;
    }
    const std::string cmd = argv[1];
    const unsigned threads = static_cast<unsigned>(std::max(1, std::atoi(argv[2])));
    try {
        if (cmd == "window-fit") return windowFit(threads);
        if (cmd == "fill") return fill(threads);
        std::fprintf(stderr, "unknown command %s\n", cmd.c_str());
        return 2;
    } catch (const std::exception& e) {
        std::fprintf(stderr, "remesh_polish_native %s: %s\n", cmd.c_str(), e.what());
        return 1;
    }
}
