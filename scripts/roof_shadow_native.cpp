/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * roof_shadow_native: the roof cast-shadow kernels (scratchbox_roof_shadow.hpp) behind binary request and result files,
 * for packages/core/src/node/3d-engine/staged-location/pipeline-k/native/roof-shadow-native.ts.
 *
 * usage: roof_shadow_native <request.bin> <result.bin>
 *
 * Everything is little-endian: u32/i32 4 bytes, f32 4, f64 8, u8 1; arrays packed, no padding.
 *
 * Request header: u32 magic 0x51485352 ("RSHQ"), u32 version 1, u32 mode, u32 threads (0: every core).
 * Result header:  u32 magic 0x52485352 ("RSHR"), u32 version 1, u32 mode.
 * Occluders: u32 n, f32[9n] (flat triangle corners).
 * Sun: f64 s[3], f64 r[3], f64 u[3], f64 tanEl (max(0.1, tan(elevation))), as roof-shadow.ts builds them.
 *
 * mode 1, map:    Occluders, Sun, f64 mpp.
 *   result:       i32 W, i32 H, f64 X0, f64 Y1, f32[W*H] top.
 * mode 2, bits:   Occluders, f64 mpp, f64 biasM, u32 nSuns, Sun[nSuns], u32 nPoints, f32[3 nPoints].
 *   result:       u8[nSuns * nPoints] (sun-major).
 * mode 3, search: Occluders, u32 nCells, f32 p[3 nCells], f32 c[3 nCells], u32 nPlanes, per plane {u32 m, i32 idx[m]},
 *                 f64 coarseMpp, f64 biasM, f64 halfBlockM, f64 minShare, f64 maxShare, u32 nCoarse, Sun[nCoarse],
 *                 per coarse sun {u32 nRefine, Sun[nRefine]}, i32 forcedCentre[nPlanes] (-1: choose).
 *   result:       u32 candidates, i32 centre[nPlanes] (-1: none), per plane {u32 entries, per entry {i32 coarse,
 *                 i32 refine (-1: the coarse sun itself), f64 sums[18]}}, u8 bits[nCoarse * nCells] (coarse-major).
 *                 sums: n[2], sum[2][4], hs[2][2], hn[2][2] (lit then shadowed; checkerboard half, then lit/shadowed).
 * mode 4, lift:   Occluders, u32 soupN, f32 UV[6 soupN], i32 img[soupN], f32 ny[soupN], Sun above, f64 aboveMpp,
 *                 f64 fineMpp, f64 biasM, f64 flatNy, f64 terraceBinM, f64 componentGridM, f64 logLin[256],
 *                 u32 nPhotos, per photo {i32 id, u32 W, u32 H, u8 rgba[4WH], u8 mask[WH]}, u32 nSuns, Sun[nSuns],
 *                 u32 nPhotoSun, per {i32 im, i32 sun, f64 logFull}, u32 nTerraces, per {i32 im, i32 bin, f64 lit (NaN: none)},
 *                 u32 hasComp, u32 nComps, per {i32 sun, f64 logFull, f64 lit}, u32 nCompCells, per {i32 bin, i32 gx, i32 gz, i32 comp}.
 *   result:       u32 count, per lifted texel {i32 im, i32 texel, i32 src (-1: the photo's sun, else the comp), f64 f}.
 *
 * Any malformed request exits 2 with the reason on stderr; a write failure exits 3.
 */

#include "scratchbox_roof_shadow.hpp"

#include <bit>
#include <cstdio>
#include <cstring>
#include <fstream>
#include <iostream>
#include <iterator>
#include <stdexcept>
#include <string>
#include <vector>

namespace rs = scratchbox::roof_shadow;

static_assert(std::endian::native == std::endian::little, "roof_shadow_native reads and writes little-endian files in place");

static constexpr uint32_t REQUEST_MAGIC = 0x51485352u, RESULT_MAGIC = 0x52485352u, VERSION = 1;

class Reader {
public:
    explicit Reader(std::vector<uint8_t> b) : buf_(std::move(b)) {}
    template <class T> T get() { T v; need(sizeof(T)); std::memcpy(&v, buf_.data() + at_, sizeof(T)); at_ += sizeof(T); return v; }
    /** A view of `count` T in place (the buffer outlives the run). */
    template <class T> const T* view(uint64_t count) {
        need(count * sizeof(T));
        const T* p = reinterpret_cast<const T*>(buf_.data() + at_);
        at_ += count * sizeof(T);
        return p;
    }
    rs::SunDir sun() {
        rs::SunDir d;
        for (double& v : d.s) v = get<double>();
        for (double& v : d.r) v = get<double>();
        for (double& v : d.u) v = get<double>();
        d.tanEl = get<double>();
        return d;
    }
    bool done() const { return at_ == buf_.size(); }
private:
    void need(uint64_t n) const { if (at_ + n > buf_.size()) throw std::runtime_error("request is truncated"); }
    std::vector<uint8_t> buf_;
    uint64_t at_ = 0;
};

class Writer {
public:
    template <class T> void put(T v) { const auto* p = reinterpret_cast<const uint8_t*>(&v); buf_.insert(buf_.end(), p, p + sizeof(T)); }
    template <class T> void putArray(const T* v, uint64_t count) { const auto* p = reinterpret_cast<const uint8_t*>(v); buf_.insert(buf_.end(), p, p + count * sizeof(T)); }
    const std::vector<uint8_t>& bytes() const { return buf_; }
private:
    std::vector<uint8_t> buf_;
};

/** The request's buffer must stay alive while views into it are read (floats are 4-aligned: every field before them is). */
static std::vector<uint8_t> readFile(const char* path) {
    std::ifstream f(path, std::ios::binary);
    if (!f) throw std::runtime_error(std::string("cannot open ") + path);
    return std::vector<uint8_t>((std::istreambuf_iterator<char>(f)), std::istreambuf_iterator<char>());
}

int main(int argc, char** argv) {
    if (argc != 3) { std::cerr << "usage: roof_shadow_native <request.bin> <result.bin>\n"; return 2; }
    Writer w;
    try {
        Reader r(readFile(argv[1]));
        if (r.get<uint32_t>() != REQUEST_MAGIC) throw std::runtime_error("not a roof shadow request (bad magic)");
        if (r.get<uint32_t>() != VERSION) throw std::runtime_error("unsupported request version");
        const uint32_t mode = r.get<uint32_t>();
        const int threads = static_cast<int>(r.get<uint32_t>());
        w.put(RESULT_MAGIC); w.put(VERSION); w.put(mode);
        const uint32_t n = r.get<uint32_t>();
        const float* P = r.view<float>(uint64_t(n) * 9);
        if (mode == 1) {
            const rs::SunDir d = r.sun();
            const double mpp = r.get<double>();
            if (!(mpp > 0)) throw std::runtime_error("mpp must be positive");
            const rs::ShadowMap m = rs::shadowMap(P, n, d, mpp, threads);
            if (m.W > INT32_MAX || m.H > INT32_MAX) throw std::runtime_error("map too large");
            w.put(static_cast<int32_t>(m.W)); w.put(static_cast<int32_t>(m.H)); w.put(m.X0); w.put(m.Y1);
            w.putArray(m.top.data(), m.top.size());
        } else if (mode == 2) {
            const double mpp = r.get<double>(), bias = r.get<double>();
            const uint32_t ns = r.get<uint32_t>();
            std::vector<rs::SunDir> suns;
            for (uint32_t k = 0; k < ns; ++k) suns.push_back(r.sun());
            const uint32_t np = r.get<uint32_t>();
            const float* pts = r.view<float>(uint64_t(np) * 3);
            if (!(mpp > 0)) throw std::runtime_error("mpp must be positive");
            const auto bits = rs::shadowBits(P, n, suns, mpp, pts, np, bias, threads);
            for (const auto& b : bits) w.putArray(b.data(), b.size());
        } else if (mode == 3) {
            rs::SunSearchInput in;
            in.P = P; in.n = n; in.threads = threads;
            in.cells.n = r.get<uint32_t>();
            in.cells.p = r.view<float>(uint64_t(in.cells.n) * 3);
            in.cells.c = r.view<float>(uint64_t(in.cells.n) * 3);
            const uint32_t np = r.get<uint32_t>();
            for (uint32_t k = 0; k < np; ++k) {
                const uint32_t m = r.get<uint32_t>();
                const int32_t* idx = r.view<int32_t>(m);
                for (uint32_t j = 0; j < m; ++j) if (idx[j] < 0 || idx[j] >= in.cells.n) throw std::runtime_error("plane cell index out of range");
                in.planes.emplace_back(idx, idx + m);
            }
            in.coarseMpp = r.get<double>(); in.biasM = r.get<double>(); in.halfBlockM = r.get<double>(); in.minShare = r.get<double>(); in.maxShare = r.get<double>();
            if (!(in.coarseMpp > 0)) throw std::runtime_error("coarseMpp must be positive");
            const uint32_t nc = r.get<uint32_t>();
            for (uint32_t c = 0; c < nc; ++c) in.coarse.push_back(r.sun());
            in.refine.resize(nc);
            for (uint32_t c = 0; c < nc; ++c) { const uint32_t m = r.get<uint32_t>(); for (uint32_t j = 0; j < m; ++j) in.refine[c].push_back(r.sun()); }
            for (uint32_t k = 0; k < np; ++k) {
                const int32_t f = r.get<int32_t>();
                if (f >= static_cast<int32_t>(nc)) throw std::runtime_error("forced centre out of range");
                in.forcedCentre.push_back(f);
            }
            const rs::SunSearchResult res = rs::sunSearch(in);
            w.put(static_cast<uint32_t>(res.candidates));
            for (int32_t c : res.centre) w.put(c);
            for (const auto& list : res.scored) {
                w.put(static_cast<uint32_t>(list.size()));
                for (const auto& e : list) {
                    w.put(e.coarse); w.put(e.refine);
                    const rs::PlaneSums& q = e.sums;
                    w.putArray(q.n, 2); w.putArray(&q.sum[0][0], 8); w.putArray(&q.hs[0][0], 4); w.putArray(&q.hn[0][0], 4);
                }
            }
            for (const auto& b : res.bits) w.putArray(b.data(), b.size());
        } else if (mode == 4) {
            rs::LiftInput in;
            in.P = P; in.n = n; in.threads = threads;
            in.soupN = r.get<uint32_t>();
            if (in.soupN > n) throw std::runtime_error("soupN exceeds the occluders");
            in.UV = r.view<float>(uint64_t(in.soupN) * 6);
            in.img = r.view<int32_t>(in.soupN);
            in.ny = r.view<float>(in.soupN);
            in.above = r.sun();
            in.aboveMpp = r.get<double>(); in.fineMpp = r.get<double>(); in.biasM = r.get<double>(); in.flatNy = r.get<double>(); in.terraceBinM = r.get<double>(); in.componentGridM = r.get<double>();
            if (!(in.aboveMpp > 0) || !(in.fineMpp > 0)) throw std::runtime_error("map pixels must be positive");
            for (double& v : in.logLin) v = r.get<double>();
            const uint32_t nph = r.get<uint32_t>();
            for (uint32_t k = 0; k < nph; ++k) {
                const int32_t id = r.get<int32_t>();
                rs::Photo ph;
                ph.W = r.get<uint32_t>(); ph.H = r.get<uint32_t>();
                ph.rgba = r.view<uint8_t>(uint64_t(ph.W) * ph.H * 4);
                ph.mask = r.view<uint8_t>(uint64_t(ph.W) * ph.H);
                in.photos[id] = ph;
            }
            const uint32_t ns = r.get<uint32_t>();
            for (uint32_t k = 0; k < ns; ++k) in.suns.push_back(r.sun());
            const uint32_t nps = r.get<uint32_t>();
            for (uint32_t k = 0; k < nps; ++k) {
                const int32_t im = r.get<int32_t>();
                rs::PhotoSun s; s.sun = r.get<int32_t>(); s.logFull = r.get<double>();
                if (s.sun < 0 || s.sun >= static_cast<int32_t>(ns)) throw std::runtime_error("photo sun out of range");
                in.photoSun[im] = s;
            }
            const uint32_t nt = r.get<uint32_t>();
            for (uint32_t k = 0; k < nt; ++k) { const int32_t im = r.get<int32_t>(), bin = r.get<int32_t>(); in.liftTerrace[rs::terraceKey(im, bin)] = r.get<double>(); }
            in.hasComp = r.get<uint32_t>() != 0;
            const uint32_t ncomp = r.get<uint32_t>();
            for (uint32_t k = 0; k < ncomp; ++k) {
                rs::CompSun c; c.sun = r.get<int32_t>(); c.logFull = r.get<double>(); c.lit = r.get<double>();
                if (c.sun < 0 || c.sun >= static_cast<int32_t>(ns)) throw std::runtime_error("comp sun out of range");
                in.comps.push_back(c);
            }
            const uint32_t ncc = r.get<uint32_t>();
            for (uint32_t k = 0; k < ncc; ++k) {
                const int32_t bin = r.get<int32_t>(), gx = r.get<int32_t>(), gz = r.get<int32_t>(), comp = r.get<int32_t>();
                if (comp < 0 || comp >= static_cast<int32_t>(ncomp)) throw std::runtime_error("comp cell out of range");
                in.compCells[rs::gridCellKey(bin, gx, gz)] = comp;
            }
            const auto lifted = rs::liftTexels(in);
            w.put(static_cast<uint32_t>(lifted.size()));
            for (const auto& l : lifted) { w.put(l.im); w.put(l.texel); w.put(l.src); w.put(l.f); }
        } else {
            throw std::runtime_error("unknown mode " + std::to_string(mode));
        }
        if (!r.done()) throw std::runtime_error("request has trailing bytes");
    } catch (const std::exception& e) {
        std::cerr << "roof_shadow_native: " << e.what() << "\n";
        return 2;
    }
    std::ofstream out(argv[2], std::ios::binary);
    out.write(reinterpret_cast<const char*>(w.bytes().data()), static_cast<std::streamsize>(w.bytes().size()));
    if (!out) { std::cerr << "roof_shadow_native: cannot write " << argv[2] << "\n"; return 3; }
    return 0;
}
