/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * symmetry_native: pipeline K's symmetry reading (scratchbox_symmetry.hpp) as a small CLI driver for
 * pipeline-k/native/symmetry-native.ts. It reads the scan (a GLB) and the facade orthos (PNGs beside facades.json) itself;
 * the request names them and carries the frames. Raw little-endian request on stdin, a JSON report on stdout.
 *
 * usage: symmetry_native [--threads N] [--heightmap FILE] [--fill DIR]
 *   --heightmap: the plan's height map written to FILE: a text line "W H cell x0 z0" then W * H float32 (row j, column i)
 *   --fill: the mirror fill (step 2): each facade whose unread texels its own mirror (when detected) or an accepted twin
 *           fills is written into DIR under its image's name, with a mask beside it (<image>_mirror.png, 255 = filled);
 *           the report gains "fills". DIR holds a copy of the orthos' folder (the wrapper clones it).
 *
 * Request:
 *   char[4] "SBSY"   u32 version (1)
 *   f64 params[28] (Params, in the order the wrapper writes them)   f64 minBlocked   f64 groundY
 *   u32 n  char scan[n]                                             the scan GLB
 *   u32 loops, each: u32 n  f64 xz[2n]                              the footprint (tile frame x, z)
 *   u32 n  char dir[n]                                              the orthos' folder
 *   u32 facades, each: i32 id  f64 centroid[3] normal[3] axisS[3] axisT[3]  f64 orthoSMin orthoTMax pixel
 *                      then four names (u32 n char[n], n = 0: none): image, uncovered, occluded, featureless
 *
 * Errors go to stderr with exit code 1.
 */

#include "scratchbox_gltf_scene.hpp"
#include "scratchbox_png.hpp"
#include "scratchbox_symmetry.hpp"

#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <fstream>
#include <sstream>
#include <string>
#include <thread>
#include <vector>

namespace sym = scratchbox::symmetry;

namespace {

constexpr uint32_t kVersion = 1;

[[noreturn]] void fail(const std::string& why) {
    std::fprintf(stderr, "symmetry_native: %s\n", why.c_str());
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
    std::string str() {
        const uint32_t n = take<uint32_t>();
        if (n > b.size() - at) fail("truncated request");
        std::string s(reinterpret_cast<const char*>(b.data() + at), n);
        at += n;
        return s;
    }
};

std::vector<uint8_t> readFile(const std::string& p) {
    std::ifstream f(p, std::ios::binary);
    if (!f) fail("cannot read " + p);
    return std::vector<uint8_t>((std::istreambuf_iterator<char>(f)), std::istreambuf_iterator<char>());
}

scratchbox::texture::ImageBuffer readPng(const std::string& p, scratchbox::png::OutputFormat fmt) {
    const std::vector<uint8_t> bytes = readFile(p);
    auto r = scratchbox::png::decode(bytes.data(), bytes.size(), fmt);
    if (!r.ok) fail("cannot decode " + p + ": " + r.error);
    return std::move(r.image);
}

struct Json {
    std::ostringstream o;
    Json() { o.setf(std::ios::fixed); o.precision(4); }
};

void putMirror(std::ostream& o, const sym::Mirror& m) {
    o << "{\"angleDeg\":" << m.angleDeg << ",\"point\":[" << m.point.x << "," << m.point.z << "],\"dir\":[" << m.dir.x << "," << m.dir.z << "],\"score\":" << m.score << ",\"share\":" << m.share << "}";
}

void putField(std::ostream& o, const sym::FieldSymmetry& f, double gate) {
    o << "{\"mass\":" << f.massM << ",\"centroid\":[" << f.centroid.x << "," << f.centroid.z << "],\"best\":";
    putMirror(o, f.best);
    o << ",\"mirrors\":[";
    for (size_t k = 0; k < f.mirrors.size(); k++) { if (k) o << ","; putMirror(o, f.mirrors[k]); }
    o << "],\"detectedMirrors\":" << std::count_if(f.mirrors.begin(), f.mirrors.end(), [&](const sym::Mirror& m) { return m.score >= gate; });
    o << ",\"rotation\":{\"order\":" << f.rotation.order << ",\"score\":" << f.rotation.score << ",\"scores\":[";
    for (size_t k = 0; k < f.rotation.scores.size(); k++) { if (k) o << ","; o << f.rotation.scores[k]; }
    o << "]}}";
}

void putTransform(std::ostream& o, const sym::PlanTransform& t) {
    o << "{\"kind\":\"" << t.kind << "\",\"angleDeg\":" << t.angleDeg << ",\"centre\":[" << t.c.x << "," << t.c.z << "],\"from\":\"" << t.from << "\",\"score\":" << t.score;
    if (t.kind == "rotation") o << ",\"order\":" << t.order << ",\"k\":" << t.k;
    o << "}";
}

} // namespace

int main(int argc, char** argv) {
    unsigned threads = 0;
    std::string heightmapFile, fillDir;
    for (int a = 1; a < argc; a++) {
        if (!std::strcmp(argv[a], "--threads") && a + 1 < argc) threads = static_cast<unsigned>(std::max(0, std::atoi(argv[++a])));
        else if (!std::strcmp(argv[a], "--fill") && a + 1 < argc) fillDir = argv[++a];
        else if (!std::strcmp(argv[a], "--heightmap") && a + 1 < argc) heightmapFile = argv[++a];
        else fail(std::string("unknown argument ") + argv[a]);
    }
    const auto t0 = std::chrono::steady_clock::now();
    Reader in;
    uint8_t chunk[1 << 16];
    for (size_t got; (got = std::fread(chunk, 1, sizeof chunk, stdin)) > 0;) in.b.insert(in.b.end(), chunk, chunk + got);
    if (in.b.size() < 4 || std::memcmp(in.b.data(), "SBSY", 4) != 0) fail("not a symmetry request");
    in.at = 4;
    if (in.take<uint32_t>() != kVersion) fail("unsupported request version");
    sym::Params P;
    double* fields[] = {&P.cellM, &P.minStructureM, &P.flatM, &P.tierBinM, &P.tierMergeM, &P.tierMinShare, &P.tierMinAreaM2, &P.tierSameShare,
                        &P.sweepDeg, &P.refineDeg, &P.peakFloor, &P.peakSepDeg, &P.planGate, &P.facadeCellM, &P.highPassM, &P.facadeCoarseM,
                        &P.minPairShare, &P.facadeShare, &P.minContrast, &P.twinNormalCos, &P.twinMaxOffsetM, &P.twinOverlapShare, &P.twinShiftM, &P.twinShiftStepM, &P.nccGate};
    for (double* f : fields) *f = in.take<double>();
    P.maxTiers = static_cast<int>(in.take<double>());
    P.maxPeaks = static_cast<int>(in.take<double>());
    P.maxFold = static_cast<int>(in.take<double>());
    const double minBlocked = in.take<double>();
    const double groundY = in.take<double>();
    if (!(P.cellM > 0) || !(P.facadeCellM > 0) || !(P.sweepDeg > 0) || !(P.refineDeg > 0)) fail("bad parameters");
    const std::string scan = in.str();
    std::vector<std::vector<sym::Vec2d>> loops(in.take<uint32_t>());
    for (auto& L : loops) {
        L.resize(in.take<uint32_t>());
        for (auto& p : L) { p.x = in.take<double>(); p.z = in.take<double>(); }
    }
    const std::string dir = in.str();
    struct Spec { sym::FacadeImage f; std::string image, uncovered, occluded, featureless; };
    std::vector<Spec> specs(in.take<uint32_t>());
    for (Spec& s : specs) {
        s.f.id = in.take<int32_t>();
        for (double* v : {s.f.centroid, s.f.normal, s.f.axisS, s.f.axisT}) for (int k = 0; k < 3; k++) v[k] = in.take<double>();
        s.f.orthoSMin = in.take<double>(); s.f.orthoTMax = in.take<double>(); s.f.pixel = in.take<double>();
        s.image = in.str(); s.uncovered = in.str(); s.occluded = in.str(); s.featureless = in.str();
        if (!(s.f.pixel > 0) || s.image.empty()) fail("bad facade header");
    }
    if (in.at != in.b.size()) fail("request longer than its header says");

    const unsigned n = threads ? threads : std::max(1u, std::thread::hardware_concurrency());
    scratchbox::FixedThreadPool pool(n);

    // the plan
    auto scene = scratchbox::gltf::GlbSceneReader::readFile(scan);
    if (!scene.ok) fail("cannot read the scan: " + scene.error);
    std::vector<float> pos;
    pos.reserve(scene.mesh.vertices.size() * 3);
    for (const auto& v : scene.mesh.vertices) { pos.push_back(v.position.x); pos.push_back(v.position.y); pos.push_back(v.position.z); }
    const sym::PlanReport plan = sym::planSymmetry(pos, scene.mesh.indices, groundY, loops, P, n > 1 ? &pool : nullptr);
    const auto tPlan = std::chrono::steady_clock::now();

    // the facades: luminance, NaN where unread (transparent, uncovered, occluded, a smear), on the working grid
    std::vector<sym::FacadeImage> images(specs.size());
    std::vector<sym::FacadeMirror> mirrors(specs.size());
    pool.forEach(specs.size(), [&](size_t i) {
        Spec& s = specs[i];
        using F = scratchbox::png::OutputFormat;
        const auto rgba = readPng(dir + "/" + s.image, F::Rgba);
        const int W = rgba.width, H = rgba.height;
        auto mask = [&](const std::string& name) -> std::vector<uint8_t> {
            if (name.empty()) return {};
            std::ifstream probe(dir + "/" + name);
            if (!probe) return {};
            auto m = readPng(dir + "/" + name, F::Luma);
            if (m.width != W || m.height != H) return {};
            return m.data;
        };
        const auto unc = mask(s.uncovered), occ = mask(s.occluded), fl = mask(s.featureless);
        const uint8_t occAt = static_cast<uint8_t>(std::lround(minBlocked * 255));
        sym::FacadeImage f = s.f;
        f.W = W; f.H = H;
        f.L.assign(static_cast<size_t>(W) * H, std::numeric_limits<float>::quiet_NaN());
        f.outline.assign(f.L.size(), 0);
        for (size_t k = 0; k < f.L.size(); k++) {
            const uint8_t* p = &rgba.data[k * 4];
            if (p[3] == 0) continue;
            f.outline[k] = 1;
            if ((!unc.empty() && unc[k] >= 128) || (!occ.empty() && occ[k] >= occAt) || (!fl.empty() && fl[k] >= 128)) continue;
            f.L[k] = static_cast<float>(0.299 * p[0] + 0.587 * p[1] + 0.114 * p[2]);
        }
        images[i] = sym::resampleFacade(std::move(f), P.facadeCellM);
        mirrors[i] = sym::facadeMirror(images[i], P);
    });
    const auto tFacades = std::chrono::steady_clock::now();

    const std::vector<sym::PlanTransform> transforms = sym::planTransforms(plan, P);
    const std::vector<sym::Twin> twins = sym::twinFacades(images, transforms, P, &pool);
    const auto tTwins = std::chrono::steady_clock::now();

    // the mirror fill: every facade at full resolution, as photographed (a fill never copies a fill)
    std::vector<sym::FillReport> fills;
    if (!fillDir.empty()) {
        using F = scratchbox::png::OutputFormat;
        const uint8_t occAt = static_cast<uint8_t>(std::lround(minBlocked * 255));
        std::vector<sym::FillImage> orig(specs.size());
        pool.forEach(specs.size(), [&](size_t i) {
            const Spec& s = specs[i];
            sym::FillImage& g = orig[i];
            const auto rgba = readPng(dir + "/" + s.image, F::Rgba);
            g.id = s.f.id; g.W = rgba.width; g.H = rgba.height;
            for (int k = 0; k < 3; k++) { g.centroid[k] = s.f.centroid[k]; g.normal[k] = s.f.normal[k]; g.axisS[k] = s.f.axisS[k]; g.axisT[k] = s.f.axisT[k]; }
            g.orthoSMin = s.f.orthoSMin; g.orthoTMax = s.f.orthoTMax; g.pixel = s.f.pixel;
            g.rgba = rgba.data;
            auto mask = [&](const std::string& name) -> std::vector<uint8_t> {
                if (name.empty()) return {};
                std::ifstream probe(dir + "/" + name);
                if (!probe) return {};
                auto m = readPng(dir + "/" + name, F::Luma);
                return m.width == g.W && m.height == g.H ? m.data : std::vector<uint8_t>{};
            };
            const auto unc = mask(s.uncovered), occ = mask(s.occluded), fl = mask(s.featureless);
            const size_t N = static_cast<size_t>(g.W) * g.H;
            g.read.assign(N, 0); g.unread.assign(N, 0);
            for (size_t k = 0; k < N; k++) {
                if (!g.rgba[4 * k + 3]) continue;
                const bool un = (!unc.empty() && unc[k] >= 128) || (!occ.empty() && occ[k] >= occAt) || (!fl.empty() && fl[k] >= 128);
                (un ? g.unread : g.read)[k] = 1;
            }
        });
        sym::FillParams FP;
        FP.nccGate = P.nccGate;
        fills.resize(specs.size());
        pool.forEach(specs.size(), [&](size_t i) {
            sym::FillImage g = orig[i];
            sym::FillReport& rep = fills[i];
            rep.facadeId = g.id;
            for (uint8_t u : g.unread) rep.unread += u;
            if (!rep.unread) return;
            std::vector<uint8_t> mask(g.unread.size(), 0);
            if (mirrors[i].detected) {
                rep.axisS = mirrors[i].axisS; rep.axisNcc = mirrors[i].ncc;
                sym::fillFromOwnMirror(g, mirrors[i].axisS, mask, rep, FP);
            }
            for (const sym::Twin& t : twins) {
                if (!t.accepted || (t.a != g.id && t.b != g.id)) continue;
                const int other = t.a == g.id ? t.b : t.a;
                const auto it = std::find_if(orig.begin(), orig.end(), [&](const sym::FillImage& o) { return o.id == other; });
                if (it == orig.end()) continue;
                // a's points go to b through the transform; b's go back through its inverse (a mirror is its own)
                sym::PlanTransform T = t.transform;
                double ds = t.shiftS, dt = t.shiftT;
                if (t.b == g.id) {
                    ds = 0; dt = 0;
                    if (T.kind == "rotation") T = sym::PlanTransform::rotation(T.c, T.order, T.order - T.k, T.score, T.from);
                }
                sym::fillFromTwin(g, *it, T, ds, dt, mask, rep, FP);
            }
            const int filled = rep.fromSelf + std::accumulate(rep.fromTwins.begin(), rep.fromTwins.end(), 0, [](int a, const std::pair<int, int>& b) { return a + b.second; });
            if (!filled) return;
            scratchbox::texture::ImageBuffer out(g.W, g.H, 4);
            out.data = g.rgba;
            const auto png = scratchbox::png::encode(out);
            scratchbox::texture::ImageBuffer m(g.W, g.H, 1);
            m.data = mask;
            const auto mpng = scratchbox::png::encode(m);
            std::string base = specs[i].image;
            if (base.size() > 4 && base.substr(base.size() - 4) == ".png") base.resize(base.size() - 4);
            std::ofstream(fillDir + "/" + specs[i].image, std::ios::binary).write(reinterpret_cast<const char*>(png.data()), static_cast<std::streamsize>(png.size()));
            std::ofstream(fillDir + "/" + base + "_mirror.png", std::ios::binary).write(reinterpret_cast<const char*>(mpng.data()), static_cast<std::streamsize>(mpng.size()));
        });
    }
    const auto tEnd = std::chrono::steady_clock::now();
    auto ms = [](auto a, auto b) { return std::chrono::duration<double, std::milli>(b - a).count(); };

    if (!heightmapFile.empty()) {
        std::ofstream hf(heightmapFile, std::ios::binary);
        if (!hf) fail("cannot write " + heightmapFile);
        hf << plan.heights.W << " " << plan.heights.H << " " << plan.heights.cell << " " << plan.heights.x0 << " " << plan.heights.z0 << "\n";
        hf.write(reinterpret_cast<const char*>(plan.heights.v.data()), static_cast<std::streamsize>(plan.heights.v.size() * sizeof(float)));
    }

    Json j;
    std::ostream& o = j.o;
    o << "{\"schema\":\"scratchbox.symmetry/1\",\"frame\":\"tile frame: plan x east, z south (m); plan angles from +x toward +z\",";
    o << "\"plan\":{\"cellM\":" << P.cellM << ",\"grid\":[" << plan.heights.W << "," << plan.heights.H << "],\"origin\":[" << plan.heights.x0 << "," << plan.heights.z0 << "],\"massing\":";
    putField(o, plan.massing, P.planGate);
    o << ",\"tiers\":[";
    for (size_t k = 0; k < plan.tiers.size(); k++) {
        if (k) o << ",";
        o << "{\"levelM\":" << plan.tiers[k].levelM << ",\"roofAreaM2\":" << plan.tiers[k].roofAreaM2 << ",\"outline\":";
        putField(o, plan.tiers[k].outline, P.planGate);
        o << "}";
    }
    o << "]";
    if (plan.hasFootprint) { o << ",\"footprint\":"; putField(o, plan.footprint, P.planGate); }
    o << "},\"facades\":[";
    for (size_t i = 0; i < mirrors.size(); i++) {
        const sym::FacadeMirror& m = mirrors[i];
        if (i) o << ",";
        o << "{\"facadeId\":" << m.facadeId << ",\"read\":" << (m.read ? "true" : "false");
        if (m.read) {
            o << ",\"axisS\":" << m.axisS << ",\"axisPoint\":[" << m.axisPoint[0] << "," << m.axisPoint[1] << "," << m.axisPoint[2] << "],\"ncc\":" << m.ncc << ",\"share\":" << m.share
              << ",\"medianNcc\":" << m.medianNcc << ",\"contrast\":" << m.contrast << ",\"outlineIoU\":" << m.outlineIoU << ",\"centreOffsetM\":" << m.centreOffsetM
              << ",\"periodic\":" << (m.periodic ? "true" : "false") << ",\"detected\":" << (m.detected ? "true" : "false") << ",\"profile\":[";
            for (size_t k = 0; k < m.profile.size(); k++) { if (k) o << ","; o << "[" << m.profile[k].first << "," << m.profile[k].second << "]"; }
            o << "]";
        }
        o << "}";
    }
    o << "],\"transforms\":[";
    for (size_t k = 0; k < transforms.size(); k++) { if (k) o << ","; putTransform(o, transforms[k]); }
    o << "],\"twins\":[";
    for (size_t k = 0; k < twins.size(); k++) {
        const sym::Twin& t = twins[k];
        if (k) o << ",";
        o << "{\"a\":" << t.a << ",\"b\":" << t.b << ",\"transform\":";
        putTransform(o, t.transform);
        o << ",\"ncc\":" << t.ncc << ",\"share\":" << t.share << ",\"shiftM\":[" << t.shiftS << "," << t.shiftT << "],\"overlapShare\":" << t.overlapShare << ",\"accepted\":" << (t.accepted ? "true" : "false") << "}";
    }
    o << "]";
    if (!fillDir.empty()) {
        o << ",\"fills\":[";
        bool first = true;
        for (const sym::FillReport& f : fills) {
            if (!f.unread) continue;
            if (!first) o << ",";
            first = false;
            o << "{\"facadeId\":" << f.facadeId << ",\"unread\":" << f.unread << ",\"fromMirror\":" << f.fromSelf << ",\"axisS\":" << f.axisS << ",\"axisNcc\":" << f.axisNcc << ",\"fromTwins\":[";
            for (size_t k = 0; k < f.fromTwins.size(); k++) { if (k) o << ","; o << "[" << f.fromTwins[k].first << "," << f.fromTwins[k].second << "]"; }
            o << "],\"regions\":" << f.regions << ",\"regionsFilled\":" << f.regionsFilled << ",\"regionsRefused\":" << f.regionsRefused << ",\"largest\":[";
            for (size_t k = 0; k < f.log.size(); k++) { if (k) o << ","; o << "{\"texels\":" << f.log[k].texels << ",\"filled\":" << f.log[k].filled << ",\"ringNcc\":" << f.log[k].ringNcc << ",\"ringPairs\":" << f.log[k].ringPairs << ",\"source\":\"" << f.log[k].source << "\"}"; }
            o << "]}";
        }
        o << "]";
    }
    o << ",\"ms\":{\"plan\":" << ms(t0, tPlan) << ",\"facades\":" << ms(tPlan, tFacades) << ",\"twins\":" << ms(tFacades, tTwins) << ",\"fill\":" << ms(tTwins, tEnd) << "}}\n";
    const std::string s = j.o.str();
    if (std::fwrite(s.data(), 1, s.size(), stdout) != s.size() || std::fflush(stdout) != 0) fail("cannot write the result");
    return 0;
}
