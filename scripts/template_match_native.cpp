/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * template_match_native: the facade reader's window search (scratchbox_template_match.hpp, the native translation of
 * pipeline-k/facade-reader-template.ts matchExemplar) for every exemplar of a family on one plane, as a small CLI driver
 * for pipeline-k/native/template-match-native.ts. The request comes on stdin and the result goes to stdout, raw
 * little-endian, no padding.
 *
 * usage: template_match_native [--threads N]       (N = 0 or absent: every core)
 *
 * Request:
 *   char[4] "SBTM"   u32 version (1)
 *   f64 coarseM, minNcc, gridNcc, minCovered, openingCovered
 *   u32 W   u32 H   f64 pixel   f32 L[W * H]                         the plane's luminance, NaN where not covered
 *   u32 exemplars, each: u32 pw   u32 ph   f64 pixel   f64 opening[4]   f32 patch[pw * ph]
 *
 * Result:
 *   char[4] "SBTM"   u32 version (1)   u32 exemplars
 *   per exemplar: u32 matches, each f64 rect[4], f64 ncc (unrounded), f64 grid (0 / 1), in the order matchExemplar
 *   pushes them
 *
 * Errors go to stderr with exit code 1.
 */

#include "scratchbox_template_match.hpp"

#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>
#include <thread>
#include <vector>

namespace stm = scratchbox::template_match;

namespace {

constexpr uint32_t kVersion = 1;

[[noreturn]] void fail(const std::string& why) {
    std::fprintf(stderr, "template_match_native: %s\n", why.c_str());
    std::exit(1);
}

struct Reader {
    std::vector<uint8_t> b;
    size_t at = 0;
    template <typename T> T take() {
        if (at + sizeof(T) > b.size()) fail("truncated request");
        T v;
        std::memcpy(&v, b.data() + at, sizeof(T));
        at += sizeof(T);
        return v;
    }
    void floats(std::vector<float>& out, size_t n) {
        if (n > (b.size() - at) / 4) fail("truncated request");
        out.resize(n);
        if (n) std::memcpy(out.data(), b.data() + at, n * 4);
        at += n * 4;
    }
};

template <typename T> void put(std::vector<uint8_t>& o, T v) {
    const size_t at = o.size();
    o.resize(at + sizeof(T));
    std::memcpy(o.data() + at, &v, sizeof(T));
}

} // namespace

int main(int argc, char** argv) {
    unsigned threads = 0;
    for (int a = 1; a < argc; a++) {
        if (!std::strcmp(argv[a], "--threads") && a + 1 < argc) threads = static_cast<unsigned>(std::max(0, std::atoi(argv[++a])));
        else fail(std::string("unknown argument ") + argv[a]);
    }
    Reader in;
    uint8_t chunk[1 << 16];
    for (size_t got; (got = std::fread(chunk, 1, sizeof chunk, stdin)) > 0;) in.b.insert(in.b.end(), chunk, chunk + got);
    if (in.b.size() < 4 || std::memcmp(in.b.data(), "SBTM", 4) != 0) fail("not a template match request");
    in.at = 4;
    if (in.take<uint32_t>() != kVersion) fail("unsupported request version");
    stm::Params P;
    P.coarseM = in.take<double>(); P.minNcc = in.take<double>(); P.gridNcc = in.take<double>(); P.minCovered = in.take<double>(); P.openingCovered = in.take<double>();
    stm::Grid g;
    g.W = in.take<uint32_t>(); g.H = in.take<uint32_t>(); g.pixel = in.take<double>();
    if (!g.W || !g.H || !(g.pixel > 0) || !(P.coarseM > 0)) fail("bad plane header");
    in.floats(g.L, static_cast<size_t>(g.W) * g.H);
    std::vector<stm::Exemplar> exemplars(in.take<uint32_t>());
    for (stm::Exemplar& ex : exemplars) {
        ex.pw = in.take<uint32_t>(); ex.ph = in.take<uint32_t>(); ex.pixel = in.take<double>();
        for (double& v : ex.opening) v = in.take<double>();
        if (!ex.pw || !ex.ph || !(ex.pixel > 0)) fail("bad exemplar header");
        in.floats(ex.patch, static_cast<size_t>(ex.pw) * ex.ph);
    }
    if (in.at != in.b.size()) fail("request longer than its header says");

    const unsigned n = threads ? threads : std::max(1u, std::thread::hardware_concurrency());
    scratchbox::FixedThreadPool pool(n);
    const auto found = stm::matchExemplars(g, exemplars, P, n > 1 ? &pool : nullptr);

    std::vector<uint8_t> out;
    out.insert(out.end(), {'S', 'B', 'T', 'M'});
    put<uint32_t>(out, kVersion);
    put<uint32_t>(out, static_cast<uint32_t>(found.size()));
    for (const auto& ms : found) {
        put<uint32_t>(out, static_cast<uint32_t>(ms.size()));
        for (const stm::Match& m : ms) {
            for (double v : m.rect) put<double>(out, v);
            put<double>(out, m.s);
            put<double>(out, m.grid ? 1.0 : 0.0);
        }
    }
    if (std::fwrite(out.data(), 1, out.size(), stdout) != out.size() || std::fflush(stdout) != 0) fail("cannot write the result");
    return 0;
}
