/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * twin_texels: pipeline K's per-texel twin kernels (scratchbox_twin_texels.hpp) behind a small binary protocol on
 * stdin and stdout, so the photos go over as raw pixels, never PNG (pipeline-k/native/twin-texels-native.ts is the other end).
 *
 * Requests follow one another until stdin closes; each is a 16-byte header (u32 magic "SBTT", u32 command, u64
 * payload bytes) and its payload, all little-endian, with no padding. Each gets one reply, the same header (the
 * command echoed) and its payload. The roof-shadow commands share state (the twin loaded once, then its cells, cell
 * shadows and lift); the harmonise apply needs nothing before it. On any error the reason goes to stderr and the
 * process exits non-zero.
 *
 *   1 roof load:     f64 biasM flatNy terraceBinM componentGridM, i32 cellTexels, f64[256] log linear, f32[256] linear,
 *                    f64[255] sRGB thresholds, u32 soup triangles, u32 context triangles, f32[9 soup] corners,
 *                    f32[6 soup] UVs, f32[soup] normal y, i32[soup] photo, f32[9 context] corners, u32 photos, and per
 *                    photo i32 image, i32 width, i32 height, u8[4 w h] RGBA, u8[w h] surface classes.   -> (nothing)
 *   2 roof cells:    f64 mpp, frame (the map from above).        -> u32 n, i32[n] photo, f32[3n] point, f32[3n] colour
 *   3 cell shadows:  f64 mpp, u32 suns, frames, f64 halfBlockM, u32 decks, each u32 n and i32[n] cells, then per sun
 *                    u32 m and u32[m] decks to score it on.
 *                                 -> u8[suns n], one sun after another; then per sun, per deck asked, f64[18] sums
 *   4 roof lift:     f64 mpp, u32 suns, frames; u32 photo suns, each i32 image, i32 sun, f64[3] ratio, f64 log lum
 *                    ratio; u32 terraces, each i32 image, i32 height bin, f64 lit level (NaN: none); u32 terraces
 *                    across photos, each i32 sun, f64[3] ratio, f64 lit level, f64 log lum ratio; u32 keys, each
 *                    i32 height bin, i32 cell x, i32 cell z, i32 terrace.
 *                                 -> u32 photos, each i32 image, f64 texels lifted, u8 changed, [u8[4 w h] RGBA]
 *   5 harmonise:     f32[256] linear, f64[255] sRGB thresholds, u32 nodes, f64[3 nodes] offsets (channel by channel),
 *                    u32 photos, each i32 image, i32 width, i32 height, i32 field nx, i32 field ny, i32 field base,
 *                    f64[3] wall gain, f64[3] roof gain, u8 has classes, u8[4 w h] RGBA, [u8[w h] classes].
 *                                 -> per photo u8[4 w h] RGBA
 * A frame is ten f64: toward the sun (3), across it (3), the third axis (3), the slope term.
 *
 * usage: twin_texels [--threads N]   (N = 0 or absent: every core)
 */

#include "scratchbox_twin_texels.hpp"

#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>
#include <thread>
#include <vector>

using namespace scratchbox::twin_texels;

namespace {

constexpr uint32_t MAGIC = 0x54544253u; // "SBTT"

[[noreturn]] void fail(const std::string& why) {
    std::fprintf(stderr, "twin_texels: %s\n", why.c_str());
    std::exit(2);
}

/** Reads one request's payload from stdin, counting what it takes against the header's length. */
struct Reader {
    uint64_t left = 0;
    void raw(void* dst, size_t bytes) {
        if (bytes > left) fail("a request is shorter than its fields");
        if (bytes && std::fread(dst, 1, bytes, stdin) != bytes) fail("stdin ended inside a request");
        left -= bytes;
    }
    template <class T> T get() { T v; raw(&v, sizeof v); return v; }
    template <class T> void into(std::vector<T>& v, size_t count) { v.resize(count); raw(v.data(), count * sizeof(T)); }
    SunFrame frame() {
        SunFrame f;
        double d[10];
        raw(d, sizeof d);
        for (int k = 0; k < 3; ++k) { f.s[k] = d[k]; f.r[k] = d[3 + k]; f.u[k] = d[6 + k]; }
        f.slope = d[9];
        return f;
    }
    std::vector<SunFrame> frames() {
        const uint32_t n = get<uint32_t>();
        std::vector<SunFrame> out;
        out.reserve(n);
        for (uint32_t i = 0; i < n; ++i) out.push_back(frame());
        return out;
    }
    Photo photo(bool withMask) {
        Photo p;
        p.img = get<int32_t>();
        p.W = get<int32_t>();
        p.H = get<int32_t>();
        if (p.W <= 0 || p.H <= 0) fail("a photo with no pixels");
        into(p.rgba, static_cast<size_t>(p.W) * static_cast<size_t>(p.H) * 4);
        if (withMask) into(p.mask, static_cast<size_t>(p.W) * static_cast<size_t>(p.H));
        return p;
    }
};

/** One reply: its header (with the payload's length, worked out first) and its parts. */
struct Reply {
    std::vector<std::pair<const void*, size_t>> parts;
    std::vector<std::vector<uint8_t>> owned;
    void add(const void* p, size_t bytes) { parts.emplace_back(p, bytes); }
    template <class T> void value(T v) {
        owned.emplace_back(sizeof v);
        std::memcpy(owned.back().data(), &v, sizeof v);
        add(owned.back().data(), sizeof v);
    }
    void send(uint32_t cmd) {
        uint64_t bytes = 0;
        for (const auto& p : parts) bytes += p.second;
        std::fwrite(&MAGIC, 4, 1, stdout);
        std::fwrite(&cmd, 4, 1, stdout);
        std::fwrite(&bytes, 8, 1, stdout);
        for (const auto& p : parts) if (p.second && std::fwrite(p.first, 1, p.second, stdout) != p.second) fail("stdout closed");
        std::fflush(stdout);
    }
};

void readEncoder(Reader& in, Srgb8Encoder& enc) {
    in.raw(enc.t, sizeof enc.t);
    for (int k = 1; k < 255; ++k) if (!(enc.t[k] >= enc.t[k - 1])) fail("the sRGB thresholds do not rise");
}

} // namespace

int main(int argc, char** argv) {
    unsigned threads = 0;
    for (int i = 1; i < argc; ++i) {
        const std::string a = argv[i];
        if (a == "--threads" && i + 1 < argc) threads = static_cast<unsigned>(std::max(0, std::atoi(argv[++i])));
        else { std::fprintf(stderr, "usage: twin_texels [--threads N]\n"); return 1; }
    }
    if (threads == 0) threads = std::max(1u, std::thread::hardware_concurrency());
    static char outBuf[1 << 22];
    std::setvbuf(stdout, outBuf, _IOFBF, sizeof outBuf);
    TexelPool pool(threads);
    RoofShadowKernels roof(pool);
    bool loaded = false, celled = false;

    for (;;) {
        uint32_t head[2];
        const size_t got = std::fread(head, 4, 2, stdin);
        if (got == 0 && std::feof(stdin)) return 0;
        if (got != 2 || head[0] != MAGIC) fail("a request without the SBTT header");
        Reader in;
        if (std::fread(&in.left, 8, 1, stdin) != 1) fail("a request without its length");
        const uint32_t cmd = head[1];
        Reply out;
        if (cmd == 1) {
            RoofParams& P = roof.params;
            P.biasM = in.get<double>(); P.flatNy = in.get<double>(); P.terraceBinM = in.get<double>(); P.componentGridM = in.get<double>();
            P.cellTexels = in.get<int32_t>();
            if (P.cellTexels < 1) fail("cellTexels must be at least 1");
            in.raw(roof.logLinear, sizeof roof.logLinear);
            in.raw(roof.linear, sizeof roof.linear);
            readEncoder(in, roof.encoder);
            const uint32_t nSoup = in.get<uint32_t>(), nContext = in.get<uint32_t>();
            roof.soupTriangles = nSoup;
            roof.occ.resize((static_cast<size_t>(nSoup) + nContext) * 9);
            in.raw(roof.occ.data(), static_cast<size_t>(nSoup) * 9 * sizeof(float));
            in.into(roof.uv, static_cast<size_t>(nSoup) * 6);
            in.into(roof.ny, nSoup);
            in.into(roof.img, nSoup);
            in.raw(roof.occ.data() + static_cast<size_t>(nSoup) * 9, static_cast<size_t>(nContext) * 9 * sizeof(float));
            const uint32_t nPhotos = in.get<uint32_t>();
            roof.photos.clear();
            roof.photos.reserve(nPhotos);
            for (uint32_t k = 0; k < nPhotos; ++k) roof.photos.push_back(in.photo(true));
            roof.index();
            loaded = true;
            celled = false;
        } else if (cmd == 2) {
            if (!loaded) fail("roof cells before the twin was loaded");
            const double mpp = in.get<double>();
            const SunFrame f = in.frame();
            roof.computeCells(f, mpp);
            celled = true;
            const uint32_t n = static_cast<uint32_t>(roof.cells.size());
            out.value(n);
            out.add(roof.cells.img.data(), roof.cells.img.size() * sizeof(int32_t));
            out.add(roof.cells.p.data(), roof.cells.p.size() * sizeof(float));
            out.add(roof.cells.c.data(), roof.cells.c.size() * sizeof(float));
        } else if (cmd == 3) {
            if (!celled) fail("cell shadows before the roof cells");
            const double mpp = in.get<double>();
            const std::vector<SunFrame> suns = in.frames();
            const double halfBlockM = in.get<double>();
            std::vector<std::vector<int32_t>> planes(in.get<uint32_t>());
            for (auto& pl : planes) {
                in.into(pl, in.get<uint32_t>());
                for (int32_t i : pl) if (i < 0 || static_cast<size_t>(i) >= roof.cells.size()) fail("a deck names a cell that is not there");
            }
            std::vector<std::vector<uint32_t>> score(suns.size());
            for (auto& sc : score) {
                in.into(sc, in.get<uint32_t>());
                for (uint32_t k : sc) if (k >= planes.size()) fail("a sun is scored on a deck that is not there");
            }
            std::vector<std::vector<double>> sums;
            out.owned.push_back(roof.cellShadows(suns, mpp, planes, score, halfBlockM, sums));
            out.add(out.owned.back().data(), out.owned.back().size());
            for (auto& sm : sums) {
                out.owned.emplace_back(sm.size() * sizeof(double));
                std::memcpy(out.owned.back().data(), sm.data(), out.owned.back().size());
                out.add(out.owned.back().data(), out.owned.back().size());
            }
        } else if (cmd == 4) {
            if (!celled) fail("the lift before the roof cells");
            LiftPlan plan;
            plan.mpp = in.get<double>();
            plan.suns = in.frames();
            const uint32_t nPhotoSuns = in.get<uint32_t>();
            for (uint32_t i = 0; i < nPhotoSuns; ++i) {
                const int32_t im = in.get<int32_t>();
                LiftPlan::PhotoSun ps{};
                ps.sun = in.get<int32_t>();
                in.raw(ps.ratio, sizeof ps.ratio);
                ps.logLum = in.get<double>();
                if (ps.sun < 0 || static_cast<size_t>(ps.sun) >= plan.suns.size()) fail("a photo's sun is not in the list");
                plan.photoSun[im] = ps;
            }
            const uint32_t nTerraces = in.get<uint32_t>();
            for (uint32_t i = 0; i < nTerraces; ++i) {
                const int32_t im = in.get<int32_t>(), bin = in.get<int32_t>();
                plan.terraceLit[LiftPlan::terraceKey(im, bin)] = in.get<double>();
            }
            const uint32_t nComps = in.get<uint32_t>();
            plan.comps.resize(nComps);
            for (auto& c : plan.comps) {
                c.sun = in.get<int32_t>();
                in.raw(c.ratio, sizeof c.ratio);
                c.lit = in.get<double>();
                c.logLum = in.get<double>();
                if (c.sun < 0 || static_cast<size_t>(c.sun) >= plan.suns.size()) fail("a terrace's sun is not in the list");
            }
            const uint32_t nKeys = in.get<uint32_t>();
            for (uint32_t i = 0; i < nKeys; ++i) {
                const int32_t bin = in.get<int32_t>(), gx = in.get<int32_t>(), gz = in.get<int32_t>(), comp = in.get<int32_t>();
                if (comp < 0 || static_cast<uint32_t>(comp) >= nComps) fail("a terrace key names no terrace");
                plan.compOfKey[LiftPlan::gridKey(bin, gx, gz)] = comp;
            }
            RoofShadowKernels::LiftOut r = roof.lift(plan);
            out.value(static_cast<uint32_t>(roof.photos.size()));
            for (size_t k = 0; k < roof.photos.size(); ++k) {
                out.value(roof.photos[k].img);
                out.value(r.lifted[k]);
                out.value(static_cast<uint8_t>(r.changed[k].empty() ? 0 : 1));
                if (!r.changed[k].empty()) {
                    out.owned.push_back(std::move(r.changed[k]));
                    out.add(out.owned.back().data(), out.owned.back().size());
                }
            }
        } else if (cmd == 5) {
            float linear[256];
            Srgb8Encoder enc{};
            in.raw(linear, sizeof linear);
            readEncoder(in, enc);
            const uint32_t nodes = in.get<uint32_t>();
            std::vector<double> off[3];
            for (auto& o : off) in.into(o, nodes);
            const uint32_t nPhotos = in.get<uint32_t>();
            std::vector<HarmonizePhoto> photos(nPhotos);
            for (auto& h : photos) {
                h.photo.img = in.get<int32_t>();
                h.photo.W = in.get<int32_t>();
                h.photo.H = in.get<int32_t>();
                h.nx = in.get<int32_t>(); h.ny = in.get<int32_t>(); h.base = in.get<int32_t>();
                in.raw(h.wallGain, sizeof h.wallGain);
                in.raw(h.roofGain, sizeof h.roofGain);
                h.hasMask = in.get<uint8_t>() != 0;
                if (h.photo.W <= 0 || h.photo.H <= 0 || h.nx < 2 || h.ny < 2 || h.base < 0 || static_cast<uint64_t>(h.base) + static_cast<uint64_t>(h.nx) * static_cast<uint64_t>(h.ny) > nodes) fail("a photo's field lies outside the offsets");
                in.into(h.photo.rgba, static_cast<size_t>(h.photo.W) * static_cast<size_t>(h.photo.H) * 4);
                if (h.hasMask) in.into(h.photo.mask, static_cast<size_t>(h.photo.W) * static_cast<size_t>(h.photo.H));
            }
            std::vector<std::vector<uint8_t>> result;
            harmonizeApply(pool, photos, off, linear, enc, result);
            for (auto& r : result) { out.owned.push_back(std::move(r)); out.add(out.owned.back().data(), out.owned.back().size()); }
        } else {
            fail("unknown command " + std::to_string(cmd));
        }
        if (in.left) fail("a request is longer than its fields (" + std::to_string(in.left) + " bytes left)");
        out.send(cmd);
    }
}
