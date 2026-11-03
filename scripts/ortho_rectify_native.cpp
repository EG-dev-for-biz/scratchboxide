/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * ortho_rectify_native: pipeline K's facade ortho straightening (scratchbox_ortho_rectify.hpp, the native translation of
 * pipeline-k/ortho-rectify.ts rectifyOrtho) on one ortho, as a small CLI driver for
 * pipeline-k/native/ortho-rectify-native.ts.
 *
 * usage: ortho_rectify_native <request.bin> <result.bin> [--threads N]
 *
 * Request (little-endian):
 *   char[4]  "SBOR"          uint32 version (1)
 *   uint32   width            uint32 height
 *   float64  pixelM           uint32 hasOccluded (0 / 1)
 *   uint32   paramCount (43)  float64 params[paramCount], in paramNames() order (booleans as 0 / 1)
 *   uint8    rgba[width * height * 4]
 *   uint8    occluded[width * height]          only when hasOccluded
 *
 * Result (little-endian):
 *   char[4]  "SBOR"          uint32 version (1)
 *   uint32   width            uint32 height            uint32 hasOccluded
 *   uint8    rgba[width * height * 4]
 *   uint8    uncovered[width * height]         0 / 1
 *   uint8    featureless[width * height]       0 / 1
 *   uint8    occluded[width * height]          only when hasOccluded (carried through a kept warp)
 *
 * The report (OrthoRectifyReport) is printed to stdout as one JSON object; a non-finite number is written as null. Errors go
 * to stderr with exit code 1 (bad arguments or request) or 2 (I/O).
 */

#include "scratchbox_ortho_rectify.hpp"

#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <fstream>
#include <iostream>
#include <string>
#include <vector>

namespace orr = scratchbox::ortho_rectify;

namespace {

constexpr uint32_t kVersion = 1;

bool readAll(const std::string& path, std::vector<uint8_t>& out) {
    std::ifstream f(path, std::ios::binary);
    if (!f) return false;
    f.seekg(0, std::ios::end);
    const std::streamoff n = f.tellg();
    f.seekg(0, std::ios::beg);
    out.resize(static_cast<size_t>(n));
    return n == 0 || static_cast<bool>(f.read(reinterpret_cast<char*>(out.data()), n));
}

template <typename T> bool take(const std::vector<uint8_t>& b, size_t& at, T& v) {
    if (at + sizeof(T) > b.size()) return false;
    std::memcpy(&v, b.data() + at, sizeof(T));
    at += sizeof(T);
    return true;
}

std::string num(double v) {
    if (!std::isfinite(v)) return "null";
    if (v == std::floor(v) && std::fabs(v) < 9e15) { char b[32]; std::snprintf(b, sizeof b, "%.0f", v); return b; }
    char b[40];
    std::snprintf(b, sizeof b, "%.17g", v);
    return b;
}

std::string str(const std::string& s) {
    std::string o = "\"";
    for (char c : s) {
        if (c == '"' || c == '\\') { o += '\\'; o += c; }
        else if (static_cast<unsigned char>(c) < 0x20) { char b[8]; std::snprintf(b, sizeof b, "\\u%04x", c); o += b; }
        else o += c;
    }
    return o + "\"";
}

std::string reportJson(const orr::Report& r) {
    std::string j = "{";
    j += "\"width\":" + num(r.width) + ",\"height\":" + num(r.height) + ",\"pixelM\":" + num(r.pixelM);
    j += ",\"lines\":{\"vertical\":" + num(r.lines.vertical) + ",\"horizontal\":" + num(r.lines.horizontal) + ",\"segments\":" + num(r.lines.segments) + ",\"samples\":" + num(r.lines.samples) + "}";
    j += ",\"straightnessPx\":{\"before\":" + num(r.straightnessPx.before) + ",\"after\":" + num(r.straightnessPx.after) + ",\"gain\":" + num(r.straightnessPx.gain) + "}";
    if (r.hasPeriod) j += ",\"periodM\":" + num(r.periodM) + ",\"periodNcc\":" + num(r.periodNcc);
    if (r.hasHomogeneity) j += ",\"homogeneity\":{\"before\":" + num(r.homogeneity.before) + ",\"after\":" + num(r.homogeneity.after) + "}";
    j += ",\"warp\":{\"kept\":" + std::string(r.warp.kept ? "true" : "false") + ",\"why\":" + str(r.warp.why) + ",\"maxShiftPx\":" + num(r.warp.maxShiftPx) + ",\"meanShiftPx\":" + num(r.warp.meanShiftPx) +
         ",\"foldScale\":" + num(r.warp.foldScale) + ",\"cgIterations\":" + num(r.warp.cgIterations) + "}";
    j += ",\"smear\":{\"applied\":" + std::string(r.smear.applied ? "true" : "false") + ",\"why\":" + str(r.smear.why) + ",\"texels\":" + num(r.smear.texels) + ",\"share\":" + num(r.smear.share) + ",\"meanAbsLog\":" + num(r.smear.meanAbsLog) + "}";
    const orr::HoleFill& h = r.holes;
    j += ",\"holes\":{\"uncovered\":" + num(h.uncovered) + ",\"fromRepeats\":" + num(h.fromRepeats) + ",\"fromStoreys\":" + num(h.fromStoreys) + ",\"fromNearest\":" + num(h.fromNearest);
    if (h.hasPeriodPx) j += ",\"periodPx\":" + num(h.periodPx);
    if (h.hasStoreyPx) j += ",\"storeyPx\":" + num(h.storeyPx);
    if (h.hasFeatureless) j += ",\"featureless\":" + num(h.featureless);
    if (h.hasFeaturelessLeft) j += ",\"featurelessLeft\":" + num(h.featurelessLeft);
    j += "}";
    j += ",\"ms\":" + num(r.ms) + "}";
    return j;
}

} // namespace

int main(int argc, char** argv) {
    if (argc < 3) { std::cerr << "usage: ortho_rectify_native <request.bin> <result.bin> [--threads N]\n"; return 1; }
    for (int a = 3; a < argc; a++) {
        if (!std::strcmp(argv[a], "--threads") && a + 1 < argc) orr::threadCount() = static_cast<unsigned>(std::max(0, std::atoi(argv[++a])));
        else { std::cerr << "unknown argument " << argv[a] << "\n"; return 1; }
    }
    std::vector<uint8_t> req;
    if (!readAll(argv[1], req)) { std::cerr << "cannot read " << argv[1] << "\n"; return 2; }
    size_t at = 0;
    uint32_t version = 0, width = 0, height = 0, hasOcc = 0, paramCount = 0;
    double pixelM = 0;
    if (req.size() < 4 || std::memcmp(req.data(), "SBOR", 4) != 0) { std::cerr << "not an ortho rectify request\n"; return 1; }
    at = 4;
    if (!take(req, at, version) || version != kVersion) { std::cerr << "unsupported request version " << version << "\n"; return 1; }
    if (!take(req, at, width) || !take(req, at, height) || !take(req, at, pixelM) || !take(req, at, hasOcc) || !take(req, at, paramCount)) { std::cerr << "truncated request header\n"; return 1; }
    if (!width || !height || !(pixelM > 0) || hasOcc > 1) { std::cerr << "bad request header\n"; return 1; }
    if (paramCount != orr::paramNames().size()) { std::cerr << "expected " << orr::paramNames().size() << " params, got " << paramCount << "\n"; return 1; }
    std::vector<double> pv(paramCount);
    for (auto& v : pv) if (!take(req, at, v)) { std::cerr << "truncated params\n"; return 1; }
    const size_t N = static_cast<size_t>(width) * height;
    if (req.size() != at + N * 4 + (hasOcc ? N : 0)) { std::cerr << "request size does not match " << width << " x " << height << "\n"; return 1; }
    orr::Rgba img;
    img.width = static_cast<int>(width); img.height = static_cast<int>(height);
    img.rgba.assign(req.begin() + static_cast<long>(at), req.begin() + static_cast<long>(at + N * 4));
    std::vector<uint8_t> occ;
    if (hasOcc) occ.assign(req.begin() + static_cast<long>(at + N * 4), req.end());
    const orr::Params P = orr::paramsFromDoubles(pv.data());
    const orr::Result r = orr::rectifyOrtho(img, pixelM, P, hasOcc ? &occ : nullptr);

    std::ofstream f(argv[2], std::ios::binary);
    if (!f) { std::cerr << "cannot write " << argv[2] << "\n"; return 2; }
    const uint32_t head[4] = {kVersion, static_cast<uint32_t>(r.image.width), static_cast<uint32_t>(r.image.height), r.hasOccluded ? 1u : 0u};
    f.write("SBOR", 4);
    f.write(reinterpret_cast<const char*>(head), sizeof head);
    f.write(reinterpret_cast<const char*>(r.image.rgba.data()), static_cast<std::streamsize>(r.image.rgba.size()));
    f.write(reinterpret_cast<const char*>(r.uncovered.data()), static_cast<std::streamsize>(r.uncovered.size()));
    f.write(reinterpret_cast<const char*>(r.featureless.data()), static_cast<std::streamsize>(r.featureless.size()));
    if (r.hasOccluded) f.write(reinterpret_cast<const char*>(r.occluded.data()), static_cast<std::streamsize>(r.occluded.size()));
    if (!f) { std::cerr << "cannot write " << argv[2] << "\n"; return 2; }
    f.close();
    std::cout << reportJson(r.report) << "\n";
    return 0;
}
