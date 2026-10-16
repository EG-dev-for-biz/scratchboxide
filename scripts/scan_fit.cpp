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

#include "scratchbox_scan_fit.hpp"

#include <cstdlib>
#include <cstring>
#include <fstream>
#include <iostream>
#include <map>
#include <string>

using namespace scratchbox;
namespace sj = staged_glb::json;

static void usage() {
    std::cerr <<
        "scan_fit <fit|refit|ornament|flatten> [flags]\n"
        "  fit      --scan raw_clay.glb [--textured raw.glb] [--remesh clay.glb] --anchor x,z [--source-limits-json f.json]\n"
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
    std::string cmd = "mkdir -p '" + d + "'";
    if (std::system(cmd.c_str()) != 0) throw CliError("io", "cannot create " + d);
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
    Q.progress = [](double f, const std::string& m) { progress(0.05 + 0.75 * f, m); };
    scan_fit::Fitter fitter(run.params, Q);
    run.result = fitter.run(scanBytes);
    Q.inputTriangles = run.result.scan.triangles();
}

static int emitFit(const Args& a, FitRun& run, const std::string& dir) {
    const std::string key = a.str("stage-key", "scan_fit");
    auto& R = run.result;
    scan_fit::Outputs out;
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

int main(int argc, char** argv) {
    if (argc < 2 || std::strcmp(argv[1], "--help") == 0 || std::strcmp(argv[1], "-h") == 0) {
        usage();
        return argc < 2 ? 2 : 0;
    }
    const std::string cmd = argv[1];
    try {
        const Args a = parseArgs(argc, argv, 2);
        if (cmd == "fit") return runFit(a);
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
