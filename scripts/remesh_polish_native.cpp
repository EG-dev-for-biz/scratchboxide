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
 * staged-location/remesh-polish-native.ts drives it; SCRATCHBOX_K_NATIVE without window-fit, lattice or infill keeps that step in TypeScript). Data
 * arrives on stdin as raw little-endian buffers, a header then arrays, never PNG:
 *
 *   remesh_polish_native window-fit <threads>
 *     in:  "SBWF" u32 version (2), u32 nParams, f64[nParams] (scratchbox_window_fit.hpp Params), u32 256, f64[256] each
 *          sRGB code's linear value as JavaScript works it out (window-fit.ts srgb8LinearTable), then per facade
 *          u32 1, i32 slot, u32 W, u32 H, f64 pixel, f64 orthoSMin, f64 orthoTMax, f64 texel, u8 rgba[W*H*4],
 *          u8 unread[W*H]; u32 0 ends. Facades are fitted as they arrive, one a task.
 *     out: one JSON line per facade as it finishes (window_fit::fitJson), {"slot":n,"error":"..."} when one throws.
 *
 *   remesh_polish_native fill <threads>
 *     in:  "SBFL" u32 version (1), u32 nParams, f64[nParams] (scratchbox_open_loop_fill.hpp Params), u32 nLoops, per loop
 *          u32 n, f64[n*2] (the footprint, plan x z), u32 nPrims, per primitive i32 wall, u32 nVerts, f64[nVerts*3],
 *          u32 indexed, u32 nIdx, u32[nIdx].
 *     out: u32 jsonLen, the report's JSON, u32 nOut, f64[nOut*9] (the fill's triangles), u32 nPieces, per piece
 *          i32 parent, i32 of, f64[9] corners, f64[9] barycentric weights.
 *
 *   remesh_polish_native lattice <threads>
 *     in:  "SBLF" u32 version (1), u32 nParams, f64[nParams] (scratchbox_facade_lattice.hpp Params), u32 flags (1: the
 *          photo's recess, 2: whole walls), u32 n, f32[n] the scan's triangles, u32 hasRaw, u32 n, f32[n] the raw scan's,
 *          u32 nFacades, per facade i32 id, f64[19] frame (centroid, normal, axisS, axisT, sMin, sMax, tMin, tMax, pixel,
 *          orthoSMin, orthoTMax), str image, str mask (u32 length, bytes; empty: none), u32 n, f64[4n] fitted windows,
 *          u32 hasBays, u32 n, f64[4n] bays, u32 hasRecess, f64 recessM, u32 n, f64[4n] the windows in texels.
 *     out: per facade in order, u32 ok, u32 W, u32 H (the photo's size), then when ok its lattice: u32 n, f64[n] s, u32 n, f64[n] t, i32 cells, f64
 *          measuredShare, f64[cells] depth, u32 hasPhotoRecess, i32 photoRecessCells, u32 n, f64[4n] strips, i32
 *          stripCells, u32 hasStructure (then u8[cells], f64 reliefM, str reliefFrom, str reason), u8[cells] built,
 *          u8[cells] windows, f64[] cellU, f64[] cellV, u32 n, f32[n] positions, u32 n, f32[n] normals, u32 n, f32[n] uv,
 *          u32 n, u32[n] indices; then u32 hasRepeat and, when set, i32 groups, i32 windows, i32 spandrels, f64 texels,
 *          f64 filled, f64 edge, u32 n, u8[n] the PNG ([cells]: one per lattice cell, row by row).
 *
 *   remesh_polish_native lattice-audit <threads>
 *     in:  "SBLA" u32 version (1), u32 nParams, f64[nParams], u32 flags (1: same facing only), u32 n, f32[n] the scan's
 *          indexed triangles, u32 nFacades, per facade i32 id, f64[19] frame, u32 n, f64[n] s, u32 n, f64[n] t,
 *          u8[cells] built, u32 n, f32[n] positions, u32 n, u32[n] indices.
 *     out: u32 nTri, i32[nTri] the facade claiming each triangle (-1: kept), f64 found, f64 restored, f64 left,
 *          f64 obliqueLeft, u32 hasOblique, f64 oblique, u32 n, i32[n] the facades dropped, in the order dropped.
 *
 * Build: clang++ -std=c++20 -O3 -I packages/core/src/native/3d-engine/include scripts/remesh_polish_native.cpp -o build/3d-native/remesh_polish_native -lz
 */

#include "scratchbox_window_fit.hpp"
#include "scratchbox_open_loop_fill.hpp"
#include "scratchbox_facade_lattice.hpp"
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

void expectMagic(const char* magic, uint32_t version) {
    char m[4];
    readExact(m, 4);
    if (std::memcmp(m, magic, 4) != 0) throw std::runtime_error(std::string("expected the ") + magic + " header");
    if (readOne<uint32_t>() != version) throw std::runtime_error("unknown input version");
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
    expectMagic("SBWF", 2);
    const auto params = window_fit::Params::from(readDoubles(readOne<uint32_t>()));
    const auto linear = readDoubles(readOne<uint32_t>());
    if (linear.size() != 256) throw std::runtime_error("the sRGB table must hold 256 values");
    window_fit::detail::setSrgb8Linear(linear.data());
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
    expectMagic("SBFL", 1);
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

std::vector<float> readFloats() {
    std::vector<float> v(readOne<uint32_t>());
    if (!v.empty()) readExact(v.data(), v.size() * sizeof(float));
    return v;
}
std::string readString() {
    std::string v(readOne<uint32_t>(), '\0');
    if (!v.empty()) readExact(v.data(), v.size());
    return v;
}
std::vector<facade_lattice::Rect> readRects() {
    const auto v = readDoubles(static_cast<size_t>(readOne<uint32_t>()) * 4);
    std::vector<facade_lattice::Rect> out;
    for (size_t i = 0; i + 3 < v.size(); i += 4) out.push_back({v[i], v[i + 1], v[i + 2], v[i + 3]});
    return out;
}
facade_lattice::Frame readFrame() {
    facade_lattice::Frame f;
    f.facadeId = readOne<int32_t>();
    const auto v = readDoubles(19);
    for (int k = 0; k < 3; ++k) { f.centroid[k] = v[k]; f.normal[k] = v[3 + k]; f.axisS[k] = v[6 + k]; f.axisT[k] = v[9 + k]; }
    f.sMin = v[12]; f.sMax = v[13]; f.tMin = v[14]; f.tMax = v[15]; f.pixel = v[16]; f.orthoSMin = v[17]; f.orthoTMax = v[18];
    return f;
}
void writeDoubles(const std::vector<double>& v) { writeExact(v.data(), v.size() * sizeof(double)); }
template <class T>
void writeArray(const std::vector<T>& v) { writeOne<uint32_t>(static_cast<uint32_t>(v.size())); writeExact(v.data(), v.size() * sizeof(T)); }
void writeString(const std::string& v) { writeOne<uint32_t>(static_cast<uint32_t>(v.size())); writeExact(v.data(), v.size()); }

int lattice(unsigned threads) {
    expectMagic("SBLF", 1);
    const auto params = facade_lattice::Params::from(readDoubles(readOne<uint32_t>()));
    const uint32_t flags = readOne<uint32_t>();
    const auto soup = readFloats();
    const bool hasRaw = readOne<uint32_t>() != 0;
    const auto rawSoup = readFloats();
    std::vector<facade_lattice::FacadeJob> jobs(readOne<uint32_t>());
    for (auto& j : jobs) {
        j.f = readFrame();
        j.image = readString();
        j.mask = readString();
        j.fitted = readRects();
        j.hasBays = readOne<uint32_t>() != 0;
        j.bays = readRects();
        j.hasRecess = readOne<uint32_t>() != 0;
        j.recessM = readOne<double>();
        j.rectsPx = readRects();
    }
    // the largest walls first, so the last task is a small one
    std::vector<size_t> order(jobs.size());
    for (size_t i = 0; i < order.size(); ++i) order[i] = i;
    const auto area = [&](size_t i) { const auto& f = jobs[i].f; return (f.sMax - f.sMin) * (f.tMax - f.tMin); };
    std::stable_sort(order.begin(), order.end(), [&](size_t a, size_t b) { return area(a) > area(b); });
    std::vector<facade_lattice::FacadeOut> outs(jobs.size());
    FixedThreadPool pool(threads);
    pool.forEach(order.size(), [&](size_t i) {
        const size_t k = order[i];
        outs[k] = facade_lattice::rebuildFacade(jobs[k], soup, hasRaw ? &rawSoup : nullptr, params, (flags & 1) != 0, (flags & 2) != 0);
    });
    for (const auto& o : outs) {
        const auto& r = o.r;
        writeOne<uint32_t>(r.ok ? 1 : 0);
        writeOne<uint32_t>(static_cast<uint32_t>(o.W));
        writeOne<uint32_t>(static_cast<uint32_t>(o.H));
        if (!r.ok) continue;
        writeArray(r.s);
        writeArray(r.t);
        writeOne<int32_t>(r.cells);
        writeOne<double>(r.measuredShare);
        writeDoubles(r.depth);
        writeOne<uint32_t>(r.hasPhotoRecess ? 1 : 0);
        writeOne<int32_t>(r.photoRecessCells);
        writeOne<uint32_t>(static_cast<uint32_t>(r.strips.size()));
        for (const auto& st : r.strips) writeExact(st.data(), sizeof(double) * 4);
        writeOne<int32_t>(r.stripCells);
        writeOne<uint32_t>(r.hasStructure ? 1 : 0);
        if (r.hasStructure) {
            writeExact(r.structureCells.data(), r.structureCells.size());
            writeOne<double>(r.reliefM);
            writeString(r.reliefFrom);
            writeString(r.reason);
        }
        writeExact(r.built.data(), r.built.size());
        writeExact(r.windows.data(), r.windows.size());
        writeDoubles(r.cellU);
        writeDoubles(r.cellV);
        writeArray(r.positions);
        writeArray(r.normals);
        writeArray(r.uv);
        writeArray(r.indices);
        writeOne<uint32_t>(o.repeat.ok ? 1 : 0);
        if (o.repeat.ok) {
            writeOne<int32_t>(o.repeat.groups);
            writeOne<int32_t>(o.repeat.windows);
            writeOne<int32_t>(o.repeat.spandrels);
            writeOne<double>(o.repeat.texels);
            writeOne<double>(o.repeat.filled);
            writeOne<double>(o.repeat.edge);
            writeArray(o.repeat.png);
        }
    }
    std::fflush(stdout);
    return 0;
}

int latticeAudit(unsigned threads) {
    expectMagic("SBLA", 1);
    const auto params = facade_lattice::Params::from(readDoubles(readOne<uint32_t>()));
    const uint32_t flags = readOne<uint32_t>();
    const auto soup = readFloats();
    std::vector<facade_lattice::AuditFacade> facades(readOne<uint32_t>());
    for (auto& x : facades) {
        x.f = readFrame();
        x.s = readDoubles(readOne<uint32_t>());
        x.t = readDoubles(readOne<uint32_t>());
        if (x.s.size() < 2 || x.t.size() < 2) throw std::runtime_error("a rebuilt facade needs two lines each way");
        x.built.resize((x.s.size() - 1) * (x.t.size() - 1));
        readExact(x.built.data(), x.built.size());
        x.positions = readFloats();
        x.indices.resize(readOne<uint32_t>());
        if (!x.indices.empty()) readExact(x.indices.data(), x.indices.size() * sizeof(uint32_t));
    }
    FixedThreadPool pool(threads);
    const auto r = facade_lattice::audit(soup, facades, params, (flags & 1) != 0, pool);
    writeArray(r.claim);
    writeOne<double>(r.found);
    writeOne<double>(r.restored);
    writeOne<double>(r.left);
    writeOne<double>(r.obliqueLeft);
    writeOne<uint32_t>(r.hasOblique ? 1 : 0);
    writeOne<double>(r.oblique);
    std::vector<int32_t> dropped(r.dropped.begin(), r.dropped.end());
    writeArray(dropped);
    std::fflush(stdout);
    return 0;
}

}  // namespace

int main(int argc, char** argv) {
    if (argc < 3) {
        std::fprintf(stderr, "usage: remesh_polish_native window-fit|fill|lattice|lattice-audit <threads>  (binary input on stdin)\n");
        return 2;
    }
    const std::string cmd = argv[1];
    const unsigned threads = static_cast<unsigned>(std::max(1, std::atoi(argv[2])));
    try {
        if (cmd == "window-fit") return windowFit(threads);
        if (cmd == "fill") return fill(threads);
        if (cmd == "lattice") return lattice(threads);
        if (cmd == "lattice-audit") return latticeAudit(threads);
        std::fprintf(stderr, "unknown command %s\n", cmd.c_str());
        return 2;
    } catch (const std::exception& e) {
        std::fprintf(stderr, "remesh_polish_native %s: %s\n", cmd.c_str(), e.what());
        return 1;
    }
}
