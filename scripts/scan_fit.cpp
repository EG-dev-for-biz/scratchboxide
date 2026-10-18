/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * CLI for the scan fitter (scratchbox_scan_fit.hpp), the facade orthos (scratchbox_scan_ortho.hpp) and the ornament
 * builder (scratchbox_ornament.hpp). Four subcommands:
 *
 *   fit       an isolated scan -> StructureFit JSON, fitted.glb (one node per fitted surface), outlines.glb (one LINES node
 *             per primitive), passthrough.glb (what the fit does not explain, as scanned) and orthos/*.png
 *   refit     the same fit with parameter overrides by (primitive id, fitParams index): ids stay, the corrected primitives
 *             are photo-corrected
 *   ornament  StructureFit + OrnamentSpec + the textured extraction -> detail.glb and build_report.json
 *   flatten   a scan, optionally isolated by a footprint -> the scan with every vertex that lies within a band of a fitted
 *             plane (all of whose triangles belong to that plane) moved onto it
 *
 * On stderr: "PROGRESS <0..1> <message>" lines. On stdout, at the end, one JSON line {"ok":true,...}. A failure exits
 * non-zero with {"ok":false,"code":"<code>","message":"..."} on stdout.
 *
 * Build:
 *   clang++ -std=c++20 -O3 -pthread -I packages/core/src/native/3d-engine/include \
 *       scripts/scan_fit.cpp -o build/3d-native/scan_fit -lz
 */

#include "scratchbox_ornament.hpp"
#include "scratchbox_scan_fit.hpp"

#include <cstdlib>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <map>
#include <string>

using namespace scratchbox;
namespace sj = staged_glb::json;

static void usage() {
    std::cerr <<
        "scan_fit <fit|refit|ornament|flatten> [flags]\n"
        "  fit      --scan raw_clay.glb [--textured raw.glb] [--remesh clay.glb] [--ownership votes.sbov] --anchor x,z [--source-limits-json f.json]\n"
        "           [--scan-sha256 H] [--textured-sha256 H] [--scan-source TEXT] [--stage-key K] --out-dir DIR\n"
        "  refit    --fit structure_fit.json --scan raw_clay.glb --set p07:2=0.50 [--set ...] [--textured raw.glb]\n"
        "           [--remesh clay.glb] [--scan-sha256 H] [--stage-key K] --out-dir DIR\n"
        "  ornament --fit structure_fit.json --spec ornament_spec.json --textured raw.glb [--stage-key K] --out-dir DIR\n"
        "  flatten  --input in.glb [--footprint-json fp.json] [--band 0.10] --out flattened.glb --stats stats.json\n";
}

struct CliError : std::runtime_error {
    CliError(std::string c, const std::string& m) : std::runtime_error(m), code(std::move(c)) {}
    std::string code;
};

struct Args {
    std::map<std::string, std::vector<std::string>> kv;
    bool has(const std::string& k) const { return kv.count(k) > 0; }
    std::string str(const std::string& k, const std::string& def = "") const { auto it = kv.find(k); return it == kv.end() ? def : it->second.back(); }
    const std::vector<std::string>& all(const std::string& k) const { static const std::vector<std::string> none; auto it = kv.find(k); return it == kv.end() ? none : it->second; }
    double num(const std::string& k, double def) const {
        auto it = kv.find(k);
        if (it == kv.end()) return def;
        char* end = nullptr;
        const double v = std::strtod(it->second.back().c_str(), &end);
        if (!end || *end != '\0' || !std::isfinite(v)) throw CliError("bad_request", "--" + k + " must be a number, got '" + it->second.back() + "'");
        return v;
    }
};

static Args parseArgs(int argc, char** argv, int from) {
    Args a;
    for (int i = from; i < argc; ++i) {
        std::string k = argv[i];
        if (k.rfind("--", 0) != 0) throw CliError("bad_request", "unexpected argument '" + k + "'");
        k = k.substr(2);
        if (i + 1 >= argc) throw CliError("bad_request", "--" + k + " needs a value");
        a.kv[k].push_back(argv[++i]);
    }
    return a;
}

static std::vector<uint8_t> readBytes(const std::string& path) {
    std::ifstream f(path, std::ios::binary | std::ios::ate);
    if (!f) throw CliError("input_unreadable", "cannot open " + path);
    const std::streamsize n = f.tellg();
    f.seekg(0);
    std::vector<uint8_t> b(static_cast<size_t>(std::max<std::streamsize>(0, n)));
    if (n > 0 && !f.read(reinterpret_cast<char*>(b.data()), n)) throw CliError("input_unreadable", "cannot read " + path);
    return b;
}

static void writeBytes(const std::string& path, const void* d, size_t n) {
    std::ofstream o(path, std::ios::binary);
    if (!o) throw CliError("io", "cannot write " + path);
    o.write(static_cast<const char*>(d), static_cast<std::streamsize>(n));
    if (!o) throw CliError("io", "cannot write " + path);
}

static void writeText(const std::string& path, const std::string& t) { writeBytes(path, t.data(), t.size()); }

static io::GlbJsonValue parseJsonFile(const std::string& path) {
    const auto b = readBytes(path);
    io::GlbJsonParser p(reinterpret_cast<const char*>(b.data()), b.size());
    return p.parse();
}

static void progress(double f, const std::string& msg) { std::cerr << "PROGRESS " << f << " " << msg << "\n"; }

static void makeDir(const std::string& d) {
    // no shell: a directory name with a quote or a space in it is a name, not a command
    std::error_code ec;
    std::filesystem::create_directories(d, ec);
    if (ec || !std::filesystem::is_directory(d)) throw CliError("io", "cannot create " + d);
}

static std::pair<double, double> readAnchor(const std::string& s) {
    const auto c = s.find(',');
    if (c == std::string::npos) throw CliError("bad_request", "--anchor must be x,z");
    char* e1 = nullptr;
    char* e2 = nullptr;
    const double x = std::strtod(s.c_str(), &e1);
    const double z = std::strtod(s.c_str() + c + 1, &e2);
    if (!e1 || e1 != s.c_str() + c || !e2 || *e2 != '\0' || !std::isfinite(x) || !std::isfinite(z)) throw CliError("bad_request", "--anchor must be x,z in metres");
    return {x, z};
}

static scan_fit::SourceLimits readLimits(const Args& a) {
    scan_fit::SourceLimits L;
    if (!a.has("source-limits-json")) return L;
    const auto d = parseJsonFile(a.str("source-limits-json"));
    if (d.type != io::GlbJsonValue::Object) throw CliError("bad_request", "--source-limits-json must hold an object");
    if (d.has("leafGeometricErrorM")) L.leafGeometricErrorM = d["leafGeometricErrorM"].num;
    if (d.has("texelM")) L.texelM = d["texelM"].num;
    if (!(L.leafGeometricErrorM > 0)) throw CliError("bad_request", "leafGeometricErrorM must be > 0");
    return L;
}

struct FitRun {
    scan_fit::FitResult result;
    scan_fit::FitRequest request;
    scan_fit::Params params;
    std::vector<uint8_t> remesh;
    std::vector<uint8_t> ownership;
    gltf::GltfScene textured;
};

static std::string num(double v) { return sj::num(v); }

static void runFitCore(const Args& a, FitRun& run, double anchorX, double anchorZ, const scan_fit::SourceLimits& limits) {
    progress(0.01, "reading the scan");
    const auto scanBytes = readBytes(a.str("scan"));
    scan_fit::FitRequest& Q = run.request;
    Q.anchorX = anchorX;
    Q.anchorZ = anchorZ;
    Q.limits = limits;
    Q.scanSha256 = a.str("scan-sha256");
    Q.texturedSha256 = a.str("textured-sha256");
    Q.scanSource = a.str("scan-source", a.str("scan"));
    Q.refitOf = a.str("refit-of");
    if (a.has("textured")) {
        run.textured = gltf::GlbSceneReader::readFile(a.str("textured"));
        if (!run.textured.ok) throw CliError("input_unreadable", "cannot read the textured extraction: " + run.textured.error);
        Q.textured = &run.textured;
    }
    if (a.has("remesh")) {
        run.remesh = readBytes(a.str("remesh"));
        Q.remeshGlb = &run.remesh;
    }
    if (a.has("ownership")) {
        run.ownership = readBytes(a.str("ownership"));
        Q.ownership = &run.ownership;
    }
    Q.progress = [](double f, const std::string& m) { progress(0.05 + 0.75 * f, m); };
    scan_fit::Fitter fitter(run.params, Q);
    run.result = fitter.run(scanBytes);
    Q.inputTriangles = run.result.scan.triangles();
    if (std::getenv("SCAN_FIT_DEBUG_DIR")) std::cerr << "DEBUG scan triangles " << run.result.scan.triangles() << " primitives " << run.result.prims.size() << " surfaces " << run.result.surfaces.size() << " footprint loops " << run.result.footprint.size() << "\n";
}

static int emitFit(const Args& a, FitRun& run, const std::string& dir) {
    const std::string key = a.str("stage-key", "scan_fit");
    auto& R = run.result;
    scan_fit::Outputs out;
    // the orthos: the textured extraction's own photo laid out on each fitted surface, with the slots drawn on it
    if (run.request.textured) {
        progress(0.82, "rendering the facade orthos");
        makeDir(dir + "/orthos");
        scan_ortho::Renderer renderer(*run.request.textured);
        for (const auto& rq : scan_fit::orthoRequests(R)) {
            const auto im = renderer.render(rq);
            if (im.png.empty() || im.coveredShare < 0.05) continue;
            const std::string rel = "orthos/ortho_" + rq.surfaceId + ".png";
            writeBytes(dir + "/" + rel, im.png.data(), im.png.size());
            sj::Object o;
            std::vector<std::string> drawn;
            for (const auto& id : im.slotsDrawn) drawn.push_back(sj::str(id));
            o.s("id", im.id).s("surfaceId", im.surfaceId).s("path", rel).i("widthPx", im.widthPx).i("heightPx", im.heightPx).n("gsdM", im.gsdM)
                .n("texelM", im.texelM > 0 ? im.texelM : R.limits.texelM).raw("originUv", "[" + sj::num(im.originUv.x) + "," + sj::num(im.originUv.y) + "]")
                .raw("slotsDrawn", sj::array(drawn)).s("sha256", im.sha256);
            out.orthoJson.push_back(o.text());
        }
    }
    out.fittedGlb = "fitted.glb";
    out.outlinesGlb = "outlines.glb";
    if (!R.pass.empty()) out.passThroughGlb = "passthrough.glb";
    out.reportJson = "structure_fit.json";
    makeDir(dir);
    progress(0.85, "writing the fitted surfaces");
    const auto fitted = scan_fit::fittedGlb(R, key);
    writeBytes(dir + "/fitted.glb", fitted.data(), fitted.size());
    const auto outlines = scan_fit::outlinesGlb(R, key);
    writeBytes(dir + "/outlines.glb", outlines.data(), outlines.size());
    if (!R.pass.empty()) {
        const auto pass = scan_fit::passThroughGlb(R, key);
        writeBytes(dir + "/passthrough.glb", pass.data(), pass.size());
    }
    const std::string fit = scan_fit::structureFitJson(R, run.request, out);
    writeText(dir + "/structure_fit.json", fit);
    for (const auto& n : R.notes) std::cerr << "NOTE " << n << "\n";
    progress(1.0, "done");
    std::cout << "{\"ok\":true,\"accepted\":" << (R.accepted ? "true" : "false") << ",\"primitives\":" << R.prims.size() << ",\"surfaces\":" << R.surfaces.size()
              << ",\"triangles\":" << R.trianglesOut << ",\"vertices\":" << R.verticesOut << ",\"ms\":" << num([&] { double t = 0; for (const auto& kv : R.timings) t += kv.second; return t; }()) << "}\n";
    return 0;
}

static int runFit(const Args& a) {
    for (const char* req : {"scan", "anchor", "out-dir"}) if (!a.has(req)) throw CliError("bad_request", std::string("fit needs --") + req);
    const auto anc = readAnchor(a.str("anchor"));
    FitRun run;
    runFitCore(a, run, anc.first, anc.second, readLimits(a));
    return emitFit(a, run, a.str("out-dir"));
}

static int runRefit(const Args& a) {
    for (const char* req : {"fit", "scan", "out-dir"}) if (!a.has(req)) throw CliError("bad_request", std::string("refit needs --") + req);
    if (!a.has("set")) throw CliError("bad_request", "refit needs at least one --set <primitive id>:<parameter index>=<value>");
    const auto prior = parseJsonFile(a.str("fit"));
    if (prior["schema"].str != "scratchbox.structure-fit/2") throw CliError("bad_request", "--fit must hold a scratchbox.structure-fit/2 object");
    const auto& anc = prior["input"]["anchor"];
    if (anc.type != io::GlbJsonValue::Array || anc.arr.size() != 2) throw CliError("bad_request", "the fit has no anchor");
    scan_fit::SourceLimits limits;
    limits.leafGeometricErrorM = prior["sourceLimits"]["leafGeometricErrorM"].num;
    if (!(limits.leafGeometricErrorM > 0)) throw CliError("bad_request", "the fit has no leaf geometric error");
    FitRun run;
    for (const auto& kv : a.all("set")) {
        const auto colon = kv.find(':'), eq = kv.find('=');
        if (colon == std::string::npos || eq == std::string::npos || eq < colon) throw CliError("bad_request", "--set must be <primitive id>:<parameter index>=<value>, got '" + kv + "'");
        char* e1 = nullptr;
        char* e2 = nullptr;
        const long idx = std::strtol(kv.c_str() + colon + 1, &e1, 10);
        const double val = std::strtod(kv.c_str() + eq + 1, &e2);
        if (e1 != kv.c_str() + eq || !e2 || *e2 != '\0' || idx < 0 || !std::isfinite(val)) throw CliError("bad_request", "--set has a bad parameter index or value: '" + kv + "'");
        run.params.overrides[kv.substr(0, colon)][static_cast<int>(idx)] = val;
    }
    runFitCore(a, run, anc.arr[0].num, anc.arr[1].num, limits);
    // an override that named a primitive or a parameter the fit does not have is an error, not a silent no-op
    for (const auto& [pid, ps] : run.params.overrides) {
        const scan_fit::Primitive* found = nullptr;
        for (const auto& pr : run.result.prims) if (pr.id == pid) found = &pr;
        if (!found) throw CliError("bad_request", "the fit has no primitive " + pid);
        for (const auto& [pi, v] : ps) {
            bool ok = false;
            for (const auto& c : found->correctable) ok = ok || c.param == pi;
            if (!ok) throw CliError("bad_request", "primitive " + pid + " has no correctable parameter " + std::to_string(pi));
            (void)v;
        }
    }
    return emitFit(a, run, a.str("out-dir"));
}

static std::string readText(const std::string& path) {
    const auto b = readBytes(path);
    return std::string(b.begin(), b.end());
}

static int runOrnament(const Args& a) {
    for (const char* req : {"fit", "spec", "out-dir"}) if (!a.has(req)) throw CliError("bad_request", std::string("ornament needs --") + req);
    const std::string fitPath = a.str("fit");
    const std::string fittedPath = a.has("fitted") ? a.str("fitted") : fitPath.substr(0, fitPath.find_last_of('/') + 1) + "fitted.glb";
    progress(0.05, "reading the fit and the spec");
    const std::string fitText = readText(fitPath), specText = readText(a.str("spec"));
    const auto fitted = readBytes(fittedPath);
    gltf::GltfScene textured;
    if (a.has("textured")) {
        progress(0.1, "reading the textured extraction");
        textured = gltf::GlbSceneReader::readFile(a.str("textured"));
        if (!textured.ok) throw CliError("input_unreadable", "cannot read the textured extraction: " + textured.error);
    }
    progress(0.2, "building the detail");
    ornament::Output out;
    try {
        out = ornament::buildOrnament(fitText, fitted, specText, a.has("textured") ? &textured : nullptr, a.str("stage-key", "ornament"));
    } catch (const ornament::OrnamentError& e) {
        throw CliError(e.code(), e.what());
    }
    const std::string dir = a.str("out-dir");
    makeDir(dir);
    writeBytes(dir + "/detail.glb", out.glb.data(), out.glb.size());
    writeText(dir + "/build_report.json", out.reportJson);
    progress(1.0, "done");
    std::cout << "{\"ok\":true,\"built\":" << out.built << ",\"dropped\":" << out.dropped << ",\"vertices\":" << out.vertices << ",\"triangles\":" << out.triangles << "}\n";
    return 0;
}

static int runFlatten(const Args& a) {
    for (const char* req : {"input", "out", "stats"}) if (!a.has(req)) throw CliError("bad_request", std::string("flatten needs --") + req);
    const double band = a.num("band", 0.10);
    if (!(band > 0 && band <= 1)) throw CliError("bad_request", "--band must be in (0, 1] metres");
    std::vector<scan_geom::P2> fp;
    if (a.has("footprint-json")) {
        const auto d = parseJsonFile(a.str("footprint-json"));
        const auto& poly = d["polygon"];
        if (poly.type != io::GlbJsonValue::Array || poly.arr.size() < 3) throw CliError("bad_request", "--footprint-json needs a polygon of at least three points");
        for (const auto& p : poly.arr) {
            if (p.type != io::GlbJsonValue::Array || p.arr.size() != 2 || !std::isfinite(p[0].num) || !std::isfinite(p[1].num)) throw CliError("bad_request", "every footprint point is [x, z] in metres");
            fp.push_back(scan_geom::P2(p[0].num, p[1].num));
        }
    }
    progress(0.05, "reading the scan");
    const auto bytes = readBytes(a.str("input"));
    progress(0.2, "isolating and flattening");
    const auto r = scan_fit::flattenScan(bytes, fp, band);
    writeBytes(a.str("out"), r.glb.data(), r.glb.size());
    writeText(a.str("stats"), r.statsJson);
    progress(1.0, "done");
    std::cout << "{\"ok\":true,\"movedVertices\":" << r.moved << ",\"maxMoveM\":" << num(r.maxMoveM) << "}\n";
    return 0;
}

int main(int argc, char** argv) {
    if (argc < 2 || std::strcmp(argv[1], "--help") == 0 || std::strcmp(argv[1], "-h") == 0) {
        usage();
        return argc < 2 ? 2 : 0;
    }
    const std::string cmd = argv[1];
    try {
        const Args a = parseArgs(argc, argv, 2);
        if (cmd == "fit") return runFit(a);
        if (cmd == "refit") return runRefit(a);
        if (cmd == "flatten") return runFlatten(a);
        if (cmd == "ornament") return runOrnament(a);
        usage();
        throw CliError("bad_request", "unknown subcommand '" + cmd + "'");
    } catch (const CliError& e) {
        std::cout << "{\"ok\":false,\"code\":" << sj::str(e.code) << ",\"message\":" << sj::str(e.what()) << "}\n";
        return e.code == "bad_request" ? 2 : 1;
    } catch (const scan_fit::ScanFitError& e) {
        std::cout << "{\"ok\":false,\"code\":" << sj::str(e.code()) << ",\"message\":" << sj::str(e.what()) << "}\n";
        return 1;
    } catch (const std::exception& e) {
        std::cout << "{\"ok\":false,\"code\":\"crashed\",\"message\":" << sj::str(e.what()) << "}\n";
        return 1;
    }
}
