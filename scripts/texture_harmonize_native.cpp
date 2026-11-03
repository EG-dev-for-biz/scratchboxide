/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * texture_harmonize_native: pipeline K's texture harmonisation (scratchbox_texture_harmonize.hpp) as a small CLI driver,
 * one request file in, one result file out. The caller is texture-harmonize-native.ts
 * (packages/core/src/node/3d-engine/staged-location/pipeline-k/native/), which reads the GLB and builds the request.
 *
 * usage: texture_harmonize_native <request.bin> <result.bin>
 *
 * Every number is little-endian; u32 / i32 are 4 bytes, f32 4, f64 8, u8 1; no padding anywhere.
 *
 * Request:
 *   u32 magic 'SBTH' (0x48544253), u32 version (1), u32 mode (1 = class masks only, 2 = harmonise), u32 threads (0 = all)
 *   f64 params[16]: sampleM maxSamplesPerTriangle sideBins bandM flatNy maxGainLog gainScale seamM seamFacingBins
 *                   fieldPx maxField wSmooth wAnchor maxOffsetLog heightCellM roofToleranceM
 *   f64 groundY
 *   f32 srgbToLinear[256] (SRGB8_TO_LINEAR)
 *   f64 srgbEncode[255]: per byte v = 1..255, the least linear value in [0, 1] that Math.round(linearToSrgb255(x))
 *                        takes to v or more (+Infinity when none)
 *   u32 primitiveCount, then per primitive (mode 4 with POSITION, in the GLB's JSON order):
 *     i32 image (-1: no base-colour texture), u32 positionCount, f64 positions[positionCount],
 *     u32 indexed (0/1), u32 indexCount, u32 indices[indexCount], u32 uvCount, f64 uvs[uvCount]
 *   u32 masksGiven (0/1)
 *   u32 imageCount, then per image (in the caller's Map order):
 *     i32 index, u32 width, u32 height, u32 hasRgba, u8 rgba[width * height * 4] when hasRgba,
 *     u32 hasMask, u32 maskLength, u8 mask[maskLength] when hasMask
 *
 * Result:
 *   u32 magic 'SBTR' (0x52544253), u32 version (1), u32 mode
 *   mode 1: u32 count, then per image: i32 index, u32 width, u32 height, u8 mask[width * height]
 *   mode 2: u32 status (0 too few samples or photos, 1 seams not closer, 2 kept), u32 samples, u32 groups,
 *           u32 roofGains, u32 gainCount, u32 pairs, f64 roofM2, f64 hiddenM2, f64 sumAbsGain, f64 maxAbsGain,
 *           f64 seamsBefore, f64 seamsAfterMatch, f64 seamsAfter, i32 cgIterations[3], f64 ms[6]
 *           (height map, samples, gains and patches, field solve, masks, apply),
 *           u32 count (images when kept, else 0), then per image: i32 index, u32 width, u32 height, u8 rgba[w * h * 4]
 * A failure exits non-zero with the reason on stderr.
 */

#include "scratchbox_texture_harmonize.hpp"

#include <cstdio>
#include <cstring>
#include <fstream>
#include <iostream>
#include <stdexcept>
#include <string>
#include <vector>

namespace th = scratchbox::texture_harmonize;

namespace {

constexpr uint32_t REQUEST_MAGIC = 0x48544253, RESULT_MAGIC = 0x52544253, VERSION = 1;

class Reader {
public:
    explicit Reader(std::vector<uint8_t> b) : buf_(std::move(b)) {}
    template <class T> T get() { T v; need(sizeof(T)); std::memcpy(&v, buf_.data() + at_, sizeof(T)); at_ += sizeof(T); return v; }
    template <class T> void array(std::vector<T>& out, size_t n) { need(n * sizeof(T)); out.resize(n); if (n) std::memcpy(out.data(), buf_.data() + at_, n * sizeof(T)); at_ += n * sizeof(T); }
    bool done() const { return at_ == buf_.size(); }
private:
    void need(size_t n) const { if (buf_.size() - at_ < n) throw std::runtime_error("the request ends early"); }
    std::vector<uint8_t> buf_;
    size_t at_ = 0;
};

class Writer {
public:
    template <class T> void put(T v) { const auto* p = reinterpret_cast<const uint8_t*>(&v); buf_.insert(buf_.end(), p, p + sizeof(T)); }
    void bytes(const std::vector<uint8_t>& b) { buf_.insert(buf_.end(), b.begin(), b.end()); }
    const std::vector<uint8_t>& data() const { return buf_; }
private:
    std::vector<uint8_t> buf_;
};

std::vector<uint8_t> readFile(const char* path) {
    std::ifstream f(path, std::ios::binary | std::ios::ate);
    if (!f) throw std::runtime_error(std::string("cannot read ") + path);
    const std::streamsize n = f.tellg();
    f.seekg(0);
    std::vector<uint8_t> b((size_t)n);
    if (n && !f.read(reinterpret_cast<char*>(b.data()), n)) throw std::runtime_error(std::string("cannot read ") + path);
    return b;
}

int run(const char* requestPath, const char* resultPath) {
    static_assert(sizeof(double) == 8 && sizeof(float) == 4, "f64 and f32 must be IEEE doubles and floats");
    {
        const uint32_t probe = 1;
        uint8_t first;
        std::memcpy(&first, &probe, 1);
        if (first != 1) throw std::runtime_error("this driver reads little-endian files on little-endian hosts only");
    }
    Reader r(readFile(requestPath));
    if (r.get<uint32_t>() != REQUEST_MAGIC) throw std::runtime_error("not a texture harmonise request (bad magic)");
    if (r.get<uint32_t>() != VERSION) throw std::runtime_error("unsupported request version");
    const uint32_t mode = r.get<uint32_t>(), threads = r.get<uint32_t>();
    if (mode != 1 && mode != 2) throw std::runtime_error("mode must be 1 (masks) or 2 (harmonise)");
    th::Params P;
    double* fields[16] = {&P.sampleM, &P.maxSamplesPerTriangle, &P.sideBins, &P.bandM, &P.flatNy, &P.maxGainLog, &P.gainScale, &P.seamM, &P.seamFacingBins, &P.fieldPx, &P.maxField, &P.wSmooth, &P.wAnchor, &P.maxOffsetLog, &P.heightCellM, &P.roofToleranceM};
    for (double* f : fields) *f = r.get<double>();
    const double groundY = r.get<double>();
    std::vector<float> srgb;
    r.array(srgb, 256);
    std::vector<double> srgbEncode;
    r.array(srgbEncode, 255);
    for (size_t v = 1; v < srgbEncode.size(); v++) if (!(srgbEncode[v] >= srgbEncode[v - 1])) throw std::runtime_error("the sRGB encode thresholds must not decrease");
    std::vector<th::Primitive> prims(r.get<uint32_t>());
    for (auto& pr : prims) {
        pr.image = r.get<int32_t>();
        r.array(pr.positions, r.get<uint32_t>());
        pr.indexed = r.get<uint32_t>() != 0;
        r.array(pr.indices, r.get<uint32_t>());
        r.array(pr.uvs, r.get<uint32_t>());
    }
    const bool masksGiven = r.get<uint32_t>() != 0;
    std::vector<th::Image> images(r.get<uint32_t>());
    for (auto& im : images) {
        im.index = r.get<int32_t>(); im.width = r.get<uint32_t>(); im.height = r.get<uint32_t>();
        if (r.get<uint32_t>()) r.array(im.rgba, (size_t)im.width * im.height * 4);
        im.hasMask = r.get<uint32_t>() != 0;
        const uint32_t maskLen = r.get<uint32_t>();
        if (im.hasMask) r.array(im.mask, maskLen);
        if (mode == 2 && im.rgba.empty() && im.width && im.height) throw std::runtime_error("harmonise needs every image's RGBA");
    }
    if (!r.done()) throw std::runtime_error("the request has trailing bytes");

    Writer w;
    w.put(RESULT_MAGIC); w.put(VERSION); w.put(mode);
    if (mode == 1) {
        const th::TopHeightMap top(prims, P);
        const auto masks = th::surfaceClassMasks(prims, images, top, P, threads);
        w.put((uint32_t)images.size());
        for (size_t k = 0; k < images.size(); k++) { w.put(images[k].index); w.put(images[k].width); w.put(images[k].height); w.bytes(masks[k]); }
    } else {
        const th::HarmonizeResult res = th::harmonizeTextures(prims, images, groundY, srgb.data(), srgbEncode.data(), P, threads, masksGiven);
        w.put((uint32_t)res.status); w.put(res.samples); w.put(res.groups); w.put(res.roofGains); w.put(res.gainCount); w.put(res.pairs);
        for (double v : {res.roofM2, res.hiddenM2, res.sumAbs, res.maxAbs, res.before, res.afterMatch, res.after}) w.put(v);
        for (int v : res.cgIterations) w.put((int32_t)v);
        for (double v : res.ms) w.put(v);
        const bool kept = res.status == th::KEPT;
        w.put((uint32_t)(kept ? images.size() : 0));
        if (kept) for (const auto& im : images) { w.put(im.index); w.put(im.width); w.put(im.height); w.bytes(im.rgba); }
    }
    std::ofstream out(resultPath, std::ios::binary | std::ios::trunc);
    if (!out) throw std::runtime_error(std::string("cannot write ") + resultPath);
    out.write(reinterpret_cast<const char*>(w.data().data()), (std::streamsize)w.data().size());
    if (!out) throw std::runtime_error(std::string("cannot write ") + resultPath);
    return 0;
}

} // namespace

int main(int argc, char** argv) {
    if (argc != 3) { std::cerr << "usage: texture_harmonize_native <request.bin> <result.bin>\n"; return 2; }
    try {
        return run(argv[1], argv[2]);
    } catch (const std::exception& e) {
        std::cerr << "texture_harmonize_native: " << e.what() << "\n";
        return 1;
    }
}
