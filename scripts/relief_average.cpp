/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * CLI of the measured relief (scratchbox_relief_average.hpp): reads a job (file argument), and per face its relief map
 * (float32, metres along the normal, NaN invalid) and the openings of its lattice; writes report.json (the baseline, the
 * line features along s and t, the averaged lattice units with their gates) and the averaged unit patches and row profiles
 * as float32 files into the job's out dir. Prints {"ok":true} or {"ok":false,"error":...}.
 *
 * Job:
 *   out <dir>
 *   param <name> <value>
 *   face <index> <W> <H> <pixel> <relief.f32>
 *   opening <face index> <group> <x0> <y0> <x1> <y1>      (ortho pixels, x right, y down)
 *
 * Build:
 *   clang++ -std=c++20 -O3 -I packages/core/src/native/3d-engine/include scripts/relief_average.cpp -o build/3d-native/relief_average
 */

#include "scratchbox_relief_average.hpp"

#include <chrono>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <map>

namespace ra = scratchbox::relief_average;

namespace {

std::string jstr(const std::string& s) {
    std::string o = "\"";
    for (char c : s) {
        if (c == '"' || c == '\\') { o += '\\'; o += c; }
        else if (c == '\n') o += "\\n";
        else if (static_cast<unsigned char>(c) < 0x20) o += ' ';
        else o += c;
    }
    return o + "\"";
}
std::string num(double v) {
    if (!std::isfinite(v)) return "null";
    char b[40];
    std::snprintf(b, sizeof b, "%.5g", v);
    return b;
}
std::string arr(const std::vector<double>& v) {
    std::string o = "[";
    for (size_t i = 0; i < v.size(); ++i) o += (i ? "," : "") + num(v[i]);
    return o + "]";
}
std::string arrI(const std::vector<int>& v) {
    std::string o = "[";
    for (size_t i = 0; i < v.size(); ++i) o += (i ? "," : "") + std::to_string(v[i]);
    return o + "]";
}
std::string lineJson(const ra::LineFeature& f) {
    std::ostringstream o;
    o << "{\"along\":" << f.along << ",\"l0\":" << f.l0 << ",\"l1\":" << f.l1 << ",\"i0\":" << f.i0 << ",\"i1\":" << f.i1
      << ",\"fullLength\":" << (f.fullLength ? "true" : "false") << ",\"depth\":" << num(f.depth) << ",\"se\":" << num(f.se) << ",\"maxSe\":" << num(f.maxSe)
      << ",\"blocks\":" << f.blocks << ",\"agree\":" << num(f.agree) << ",\"accepted\":" << (f.accepted ? "true" : "false") << ",\"why\":" << jstr(f.why)
      << ",\"lines\":" << arrI(f.lines) << ",\"profile\":" << arr(f.profile) << ",\"profileSe\":" << arr(f.profileSe) << "}";
    return o.str();
}
std::string sideJson(const ra::UnitProfile& u) {
    std::ostringstream o;
    o << "{\"proposed\":" << (u.proposed ? "true" : "false") << ",\"accepted\":" << (u.accepted ? "true" : "false") << ",\"why\":" << jstr(u.why)
      << ",\"depth\":" << num(u.depth) << ",\"se\":" << num(u.se) << ",\"n\":" << u.n << ",\"cross\":" << arr(u.cross) << ",\"offset\":" << arr(u.offset)
      << ",\"offsetSe\":" << arr(u.offsetSe) << ",\"a0\":" << num(u.a0) << ",\"a1\":" << num(u.a1) << "}";
    return o.str();
}
void writeF32(const std::string& path, const std::vector<float>& v) {
    std::ofstream o(path, std::ios::binary);
    o.write(reinterpret_cast<const char*>(v.data()), static_cast<std::streamsize>(v.size() * sizeof(float)));
}

struct FaceJob { int index{0}, W{0}, H{0}; double pixel{0.05}; std::string file; };

}  // namespace

int main(int argc, char** argv) {
    if (argc < 2) { std::cerr << "usage: relief_average <job.txt>\n"; return 2; }
    try {
        const auto t0 = std::chrono::steady_clock::now();
        std::ifstream in(argv[1]);
        if (!in) throw std::runtime_error(std::string("cannot read ") + argv[1]);
        ra::Params p;
        std::string outDir;
        std::vector<FaceJob> faces;
        std::map<int, std::vector<ra::Opening>> openings;
        std::string line;
        while (std::getline(in, line)) {
            std::istringstream ls(line);
            std::string kw;
            if (!(ls >> kw) || kw[0] == '#') continue;
            if (kw == "out") ls >> outDir;
            else if (kw == "param") {
                std::string name; double v;
                ls >> name >> v;
                if (!ls) throw std::runtime_error("param needs a name and a value");
                if (name == "k") p.k = v; else if (name == "block") p.block = v; else if (name == "trim") p.trim = v;
                else if (name == "minDepth") p.minDepth = v; else if (name == "consistency") p.consistency = v;
                else if (name == "minBlocks") p.minBlocks = static_cast<int>(v); else if (name == "minOpenings") p.minOpenings = static_cast<int>(v);
                else if (name == "margin") p.margin = v; else if (name == "shift") p.shift = v;
                else if (name == "slabLo") p.slabLo = v; else if (name == "slabHi") p.slabHi = v; else if (name == "clampGuard") p.clampGuard = v;
                else if (name == "maxVerticalShare") p.maxVerticalShare = v; else if (name == "fullLength") p.fullLength = v;
                else if (name == "detrendWindow") p.detrendWindow = v; else if (name == "maxDepth") p.maxDepth = v;
                else throw std::runtime_error("unknown param " + name);
            } else if (kw == "face") {
                FaceJob f;
                ls >> f.index >> f.W >> f.H >> f.pixel >> f.file;
                if (!ls || f.W <= 0 || f.H <= 0) throw std::runtime_error("face needs index W H pixel file");
                faces.push_back(f);
            } else if (kw == "opening") {
                int face; ra::Opening o;
                ls >> face >> o.group >> o.x0 >> o.y0 >> o.x1 >> o.y1;
                if (!ls) throw std::runtime_error("opening needs face group x0 y0 x1 y1");
                openings[face].push_back(o);
            } else throw std::runtime_error("unknown line " + kw);
        }
        if (outDir.empty()) throw std::runtime_error("the job names no out dir");
        std::filesystem::create_directories(outDir);
        std::ostringstream js;
        js << "{\"schema\":\"scratchbox.relief-average/1\",\"params\":{\"k\":" << num(p.k) << ",\"block\":" << num(p.block) << ",\"trim\":" << num(p.trim)
           << ",\"minDepth\":" << num(p.minDepth) << ",\"consistency\":" << num(p.consistency) << ",\"minBlocks\":" << p.minBlocks << ",\"minOpenings\":" << p.minOpenings
           << ",\"margin\":" << num(p.margin) << ",\"shift\":" << num(p.shift) << ",\"detrendWindow\":" << num(p.detrendWindow) << ",\"maxDepth\":" << num(p.maxDepth) << "},\"faces\":[";
        bool firstFace = true;
        for (const auto& fj : faces) {
            ra::Field f;
            f.W = fj.W; f.H = fj.H; f.pixel = fj.pixel;
            f.h.assign(static_cast<size_t>(f.W) * f.H, std::numeric_limits<float>::quiet_NaN());
            {
                std::ifstream rf(fj.file, std::ios::binary);
                if (!rf) throw std::runtime_error("cannot read " + fj.file);
                rf.read(reinterpret_cast<char*>(f.h.data()), static_cast<std::streamsize>(f.h.size() * sizeof(float)));
                if (rf.gcount() != static_cast<std::streamsize>(f.h.size() * sizeof(float))) throw std::runtime_error(fj.file + " is shorter than W x H floats");
            }
            // clamp hits at the slab's limits are not surface
            size_t valid = 0;
            for (float& v : f.h) {
                if (std::isfinite(v) && (v >= p.slabHi - p.clampGuard || v <= p.slabLo + p.clampGuard)) v = std::numeric_limits<float>::quiet_NaN();
                if (std::isfinite(v)) ++valid;
            }
            const double mode = ra::baselineMode(f, p);
            const auto& ops = openings[fj.index];
            // openings (dilated by 2 texels) are not wall: excluded from the line statistics
            std::vector<uint8_t> excl(f.h.size(), 0);
            for (const auto& o : ops)
                for (int y = std::max(0, static_cast<int>(std::floor(o.y0)) - 2); y < std::min(f.H, static_cast<int>(std::ceil(o.y1)) + 2); ++y)
                    for (int x = std::max(0, static_cast<int>(std::floor(o.x0)) - 2); x < std::min(f.W, static_cast<int>(std::ceil(o.x1)) + 2); ++x) excl[static_cast<size_t>(y) * f.W + x] = 1;
            // the line features leave out a band of 0.3 m round each opening too: what stands beside an opening (a sill,
            // a hood, a surround) is the lattice unit's to measure, and a run of sills is not a band; a course continuing
            // across the piers between the openings still is
            std::vector<uint8_t> exclLines(f.h.size(), 0);
            {
                const int d = static_cast<int>(std::lround(0.3 / f.pixel));
                for (const auto& o : ops)
                    for (int y = std::max(0, static_cast<int>(std::floor(o.y0)) - d); y < std::min(f.H, static_cast<int>(std::ceil(o.y1)) + d); ++y)
                        for (int x = std::max(0, static_cast<int>(std::floor(o.x0)) - d); x < std::min(f.W, static_cast<int>(std::ceil(o.x1)) + d); ++x) exclLines[static_cast<size_t>(y) * f.W + x] = 1;
            }
            // relative to the local wall line (the face's slow bow and tilt taken out); the statistics below are about 0.
            // Two passes: the features the first finds are left out of the second's wall line, so it does not lean towards them
            const ra::Field raw = f;
            const double base = 0;
            double trend = 0;
            std::vector<ra::LineFeature> bands, verticals;
            std::vector<uint8_t> excl2;
            for (int pass = 0; pass < 2; ++pass) {
                std::vector<uint8_t> trendExcl = excl;
                if (pass) {
                    for (const auto& b : bands) if (b.accepted) for (int y = std::max(0, b.l0 - 1); y <= std::min(f.H - 1, b.l1 + 1); ++y) for (int x = b.i0; x < b.i1; ++x) trendExcl[static_cast<size_t>(y) * f.W + x] = 1;
                    for (const auto& v : verticals) if (v.accepted) for (int x = std::max(0, v.l0 - 1); x <= std::min(f.W - 1, v.l1 + 1); ++x) for (int y = v.i0; y < v.i1; ++y) trendExcl[static_cast<size_t>(y) * f.W + x] = 1;
                    f = raw;
                }
                trend = ra::detrend(f, p, &trendExcl);
                bands = ra::lineFeatures(f, 0, base, p, &exclLines);
                // vertical elements: the accepted bands' rows are excluded too
                excl2 = exclLines;
                for (const auto& b : bands) if (b.accepted) for (int y = b.l0; y <= b.l1; ++y) for (int x = 0; x < f.W; ++x) excl2[static_cast<size_t>(y) * f.W + x] = 1;
                verticals = ra::lineFeatures(f, 1, base, p, &excl2);
            }
            // the row profile (diagnostics): mean, SE, blocks per row
            {
                ra::Lines L{f, 0};
                std::vector<float> rows(static_cast<size_t>(f.H) * 3);
                for (int y = 0; y < f.H; ++y) {
                    auto s = ra::lineStat(L, y, base, p, &excl);
                    rows[static_cast<size_t>(y) * 3] = static_cast<float>(s.st.mean);
                    rows[static_cast<size_t>(y) * 3 + 1] = static_cast<float>(s.st.se);
                    rows[static_cast<size_t>(y) * 3 + 2] = static_cast<float>(s.st.n);
                }
                writeF32(outDir + "/rows_" + std::to_string(fj.index) + ".f32", rows);
            }
            js << (firstFace ? "" : ",") << "{\"index\":" << fj.index << ",\"baseline\":" << num(mode) << ",\"trendRms\":" << num(trend) << ",\"valid\":" << valid << ",\"texels\":" << f.h.size() << ",\"bands\":[";
            firstFace = false;
            for (size_t i = 0; i < bands.size(); ++i) js << (i ? "," : "") << lineJson(bands[i]);
            js << "],\"verticals\":[";
            for (size_t i = 0; i < verticals.size(); ++i) js << (i ? "," : "") << lineJson(verticals[i]);
            js << "],\"units\":[";
            auto groups = ra::sizeGroups(ops);
            bool firstUnit = true;
            for (size_t g = 0; g < groups.size(); ++g) {
                if (groups[g].size() < 2) continue;
                auto u = ra::averageUnit(f, base, ops, groups[g], p);
                const std::string stem = outDir + "/unit_" + std::to_string(fj.index) + "_" + std::to_string(g);
                writeF32(stem + ".f32", u.mean);
                writeF32(stem + ".se.f32", u.se);
                js << (firstUnit ? "" : ",") << "{\"group\":" << g << ",\"members\":" << arrI(u.members) << ",\"shifts\":[";
                firstUnit = false;
                for (size_t i = 0; i < u.shifts.size(); ++i) js << (i ? "," : "") << "[" << u.shifts[i].first << "," << u.shifts[i].second << "]";
                js << "],\"nccGain\":" << num(u.nccGain) << ",\"widthM\":" << num(u.widthM) << ",\"heightM\":" << num(u.heightM) << ",\"pw\":" << u.pw << ",\"ph\":" << u.ph
                   << ",\"mx\":" << u.mx << ",\"my\":" << u.my << ",\"patch\":" << jstr("unit_" + std::to_string(fj.index) + "_" + std::to_string(g) + ".f32")
                   << ",\"reveal\":" << sideJson(u.reveal) << ",\"below\":" << sideJson(u.below) << ",\"above\":" << sideJson(u.above)
                   << ",\"left\":" << sideJson(u.left) << ",\"right\":" << sideJson(u.right) << "}";
            }
            js << "]}";
        }
        const double ms = std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - t0).count();
        js << "],\"ms\":" << num(ms) << "}";
        std::ofstream(outDir + "/report.json") << js.str();
        std::cout << "{\"ok\":true,\"faces\":" << faces.size() << ",\"ms\":" << num(ms) << "}\n";
        return 0;
    } catch (const std::exception& e) {
        std::cout << "{\"ok\":false,\"error\":" << jstr(e.what()) << "}\n";
        return 1;
    }
}
