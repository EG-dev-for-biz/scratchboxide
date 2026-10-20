/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * CLI of the staged-location shape program trial (scratchbox_shape_program.hpp). Reads a line spec (file argument):
 *
 *   mode scan       the tree-free scan analysed: classes, frame, height grid, tier levels and squared tier outlines,
 *                   four oblique depth and clay views (scan.json, height.f32, mask.u8, v<k>.depth.f32, v<k>.shade.u8)
 *   mode program    a shape program built in the scan's frame, optionally fitted to the scan's height grid and views
 *                   (fit.json, geometry.json in the tile frame, prog_<before|after>_h.f32, prog_<..>_v<k>.{depth.f32,shade.u8})
 *
 * Prints {"ok":true,...} or {"ok":false,"error":...} and exits non-zero on failure.
 *
 * Build:
 *   clang++ -std=c++20 -O3 -I packages/core/src/native/3d-engine/include scripts/shape_program.cpp -o build/3d-native/shape_program -lz
 */

#include "scratchbox_shape_program.hpp"

#include <filesystem>
#include <fstream>
#include <iostream>

using namespace scratchbox::shape_program;
namespace sd = scratchbox::shape_program::detail;

namespace {

std::string camJson(const Camera& c) {
    auto v = [](P3 p) { return "[" + sd::fmt(p.x) + "," + sd::fmt(p.y) + "," + sd::fmt(p.z) + "]"; };
    return "{\"eye\":" + v(c.eye) + ",\"fwd\":" + v(c.fwd) + ",\"right\":" + v(c.right) + ",\"up\":" + v(c.up) + ",\"focal\":" + sd::fmt(c.focal) + ",\"W\":" + std::to_string(c.W) + ",\"H\":" + std::to_string(c.H) + "}";
}
std::string loopsJson(const std::vector<std::vector<P2>>& loops, const Frame* toTile) {
    std::string s = "[";
    for (size_t i = 0; i < loops.size(); ++i) {
        s += i ? ",[" : "[";
        for (size_t k = 0; k < loops[i].size(); ++k) {
            double a = loops[i][k].u, b = loops[i][k].v;
            if (toTile) toTile->toXZ(loops[i][k].u, loops[i][k].v, a, b);
            s += (k ? "," : "") + std::string("[") + sd::fmt(a) + "," + sd::fmt(b) + "]";
        }
        s += "]";
    }
    return s + "]";
}

void runScan(std::istream& in, std::ostream& out) {
    std::string line, dir, isolate;
    double ground = 0;
    std::vector<std::vector<P2>> footprint;
    std::vector<Crown> crowns;
    ScanParams P;
    while (std::getline(in, line)) {
        std::istringstream ls(line);
        std::string k; ls >> k;
        if (k == "out") ls >> dir;
        else if (k == "isolate") ls >> isolate;
        else if (k == "ground") ls >> ground;
        else if (k == "footprint") { size_t n; ls >> n; std::vector<P2> l(n); for (auto& p : l) ls >> p.u >> p.v; footprint.push_back(l); }
        else if (k == "crown") { Crown c; size_t n; ls >> c.id >> c.baseY >> c.topY >> n; c.footprintXZ.resize(n); for (auto& p : c.footprintXZ) ls >> p.u >> p.v; if (n >= 3) crowns.push_back(c); }
        else if (k == "param") {
            std::string name; double v; ls >> name >> v;
            if (name == "cell") P.cell = v; else if (name == "groundBand") P.groundBand = v; else if (name == "minBuildingH") P.minBuildingH = v;
            else if (name == "footprintDilate") P.footprintDilate = v; else if (name == "agreeShare") P.agreeShare = v; else if (name == "modeBandwidth") P.modeBandwidth = v;
            else if (name == "modeMerge") P.modeMerge = v; else if (name == "minTierArea") P.minTierArea = v; else if (name == "minTierShare") P.minTierShare = v;
            else if (name == "maxTiers") P.maxTiers = static_cast<int>(v); else if (name == "cleanRadius") P.cleanRadius = v; else if (name == "simplifyTol") P.simplifyTol = v;
            else if (name == "squareDeg") P.squareDeg = v; else if (name == "viewW") P.viewW = static_cast<int>(v); else if (name == "viewH") P.viewH = static_cast<int>(v);
            else throw std::runtime_error("unknown param " + name);
        }
    }
    if (dir.empty() || isolate.empty()) throw std::runtime_error("scan: out and isolate are required");
    std::filesystem::create_directories(dir);
    ScanResult R = analyseScan(isolate, ground, footprint, crowns, P);
    sd::writeRaw(dir + "/height.f32", R.height);
    sd::writeRaw(dir + "/mask.u8", R.mask);
    for (size_t v = 0; v < R.cams.size(); ++v) { sd::writeRaw(dir + "/v" + std::to_string(v) + ".depth.f32", R.depth[v]); sd::writeRaw(dir + "/v" + std::to_string(v) + ".shade.u8", R.shade[v]); }
    std::ofstream js(dir + "/scan.json");
    const Grid& g = R.grid;
    js << "{\"frame\":{\"ox\":" << sd::fmt(R.frame.ox) << ",\"oz\":" << sd::fmt(R.frame.oz) << ",\"theta\":" << sd::fmt(R.frame.theta) << ",\"groundY\":" << sd::fmt(R.frame.groundY) << ",\"directionSupport\":" << sd::fmt(R.thetaSupport) << "}";
    js << ",\"grid\":{\"u0\":" << sd::fmt(g.u0) << ",\"v0\":" << sd::fmt(g.v0) << ",\"cell\":" << sd::fmt(g.cell) << ",\"nu\":" << g.nu << ",\"nv\":" << g.nv << "}";
    js << ",\"classes\":{\"total\":" << R.triTotal << ",\"building\":{\"triangles\":" << R.triBuilding << ",\"areaM2\":" << sd::fmt(R.areaBuilding) << "},\"ground\":{\"triangles\":" << R.triGround << ",\"areaM2\":" << sd::fmt(R.areaGround)
       << "},\"tree\":{\"triangles\":" << R.triTree << ",\"areaM2\":" << sd::fmt(R.areaTree) << ",\"byCrown\":[";
    {
        bool first = true;
        for (const auto& kv : R.treeByCrown) { js << (first ? "" : ",") << "{\"crown\":" << kv.first << ",\"triangles\":" << kv.second.first << ",\"areaM2\":" << sd::fmt(kv.second.second) << "}"; first = false; }
    }
    js << "]},\"treeInsideFootprintKept\":{\"triangles\":" << R.triTreeKept << ",\"areaM2\":" << sd::fmt(R.areaTreeKept) << "},\"buildingOutsideOutline\":{\"triangles\":" << R.triOutsideOutline << "}}";
    js << ",\"footprintAgreement\":" << sd::fmt(R.footprintAgreement) << ",\"outlineSource\":" << sd::jstr(R.outlineSource);
    js << ",\"levels\":[";
    for (size_t i = 0; i < R.modes.size(); ++i) js << (i ? "," : "") << "{\"h\":" << sd::fmt(R.modes[i].first) << ",\"areaM2\":" << sd::fmt(R.modes[i].second) << "}";
    js << "],\"tiers\":[";
    for (size_t i = 0; i < R.tiers.size(); ++i) {
        const auto& t = R.tiers[i];
        js << (i ? "," : "") << "{\"baseY\":" << sd::fmt(t.baseY) << ",\"topY\":" << sd::fmt(t.topY) << ",\"areaM2\":" << sd::fmt(t.areaM2) << ",\"loops\":" << loopsJson(t.loopsUV, &R.frame) << ",\"loopsUV\":" << loopsJson(t.loopsUV, nullptr) << "}";
    }
    js << "],\"outlineUV\":" << loopsJson(R.outlineUV, nullptr);
    js << ",\"box\":{\"lo\":[" << sd::fmt(R.boxLo.x) << "," << sd::fmt(R.boxLo.y) << "," << sd::fmt(R.boxLo.z) << "],\"hi\":[" << sd::fmt(R.boxHi.x) << "," << sd::fmt(R.boxHi.y) << "," << sd::fmt(R.boxHi.z) << "]}";
    js << ",\"cameras\":[";
    for (size_t i = 0; i < R.cams.size(); ++i) js << (i ? "," : "") << camJson(R.cams[i]);
    js << "],\"notes\":[";
    for (size_t i = 0; i < R.notes.size(); ++i) js << (i ? "," : "") << sd::jstr(R.notes[i]);
    js << "],\"timingsMs\":{";
    for (size_t i = 0; i < R.timings.size(); ++i) js << (i ? "," : "") << sd::jstr(R.timings[i].first) << ":" << sd::fmt(R.timings[i].second);
    js << "}}\n";
    out << "{\"ok\":true,\"tiers\":" << R.tiers.size() << ",\"building\":" << R.triBuilding << ",\"tree\":" << R.triTree << "}\n";
}

void readHandles(std::istream& in, Element& e, size_t n) {
    std::string line;
    while (e.h.size() < n && std::getline(in, line)) {
        std::istringstream ls(line);
        std::string k; ls >> k;
        if (k != "h") throw std::runtime_error("element " + e.id + ": expected " + std::to_string(n) + " handle lines, got '" + line + "'");
        Handle h; ls >> h.value >> h.lo >> h.hi >> h.step;
        e.h.push_back(h);
    }
    if (e.h.size() != n) throw std::runtime_error("element " + e.id + ": " + std::to_string(e.h.size()) + " of " + std::to_string(n) + " handles");
}

void writeSoupMesh(std::ostream& js, const Soup& s, int elem, const Frame& f) {
    std::map<std::array<long long, 3>, int> idx;
    std::vector<P3> verts; std::vector<int> ind;
    for (size_t t = 0; t < s.size(); ++t) {
        if (s.elem[t] != elem) continue;
        for (int k = 0; k < 3; ++k) {
            P3 q = f.toTile(s.p[3 * t + k]);
            std::array<long long, 3> key{std::llround(q.x * 1e4), std::llround(q.y * 1e4), std::llround(q.z * 1e4)};
            auto it = idx.find(key);
            if (it == idx.end()) { it = idx.emplace(key, static_cast<int>(verts.size())).first; verts.push_back(q); }
            ind.push_back(it->second);
        }
    }
    js << "\"vertices\":[";
    for (size_t i = 0; i < verts.size(); ++i) js << (i ? "," : "") << "[" << sd::fmt(verts[i].x) << "," << sd::fmt(verts[i].y) << "," << sd::fmt(verts[i].z) << "]";
    js << "],\"indices\":[";
    for (size_t i = 0; i < ind.size(); ++i) js << (i ? "," : "") << ind[i];
    js << "]";
}

std::string lossJson(const Loss& L) {
    std::string s = "{\"total\":" + sd::fmt(L.total) + ",\"height\":" + sd::fmt(L.height) + ",\"silhouette\":" + sd::fmt(L.sil) + ",\"depth\":" + sd::fmt(L.depth) + ",\"silhouettePerView\":[";
    for (size_t i = 0; i < L.silPerView.size(); ++i) s += (i ? "," : "") + sd::fmt(L.silPerView[i]);
    return s + "]}";
}

void runProgram(std::istream& in, std::ostream& out) {
    std::string line, dir, heightFile;
    Frame frame; Grid grid;
    std::vector<Camera> cams; std::vector<std::string> depthFiles;
    Program prog;
    double buildingH = 10;
    int passes = 0, maxEvals = 4000;
    double wH = 1, wS = 0.5, wD = 0.25;
    while (std::getline(in, line)) {
        std::istringstream ls(line);
        std::string k; ls >> k;
        if (k.empty() || k[0] == '#' || k == "mode") continue;
        if (k == "out") ls >> dir;
        else if (k == "ground") ls >> frame.groundY;
        else if (k == "frame") ls >> frame.ox >> frame.oz >> frame.theta;
        else if (k == "grid") ls >> grid.u0 >> grid.v0 >> grid.cell >> grid.nu >> grid.nv;
        else if (k == "target_height") ls >> heightFile;
        else if (k == "buildingH") ls >> buildingH;
        else if (k == "fit") ls >> passes >> maxEvals;
        else if (k == "weights") ls >> wH >> wS >> wD;
        else if (k == "camera") {
            Camera c; std::string df;
            ls >> c.eye.x >> c.eye.y >> c.eye.z >> c.fwd.x >> c.fwd.y >> c.fwd.z >> c.right.x >> c.right.y >> c.right.z >> c.up.x >> c.up.y >> c.up.z >> c.focal >> c.W >> c.H >> df;
            cams.push_back(c); depthFiles.push_back(df);
        } else if (k == "prism") {
            Element e; e.op = 0; size_t n;
            ls >> e.id >> e.ridgeDeg >> e.hipShare >> e.count >> e.stepU >> e.stepV >> e.stepH >> n;
            e.outline.resize(n); for (auto& p : e.outline) ls >> p.u >> p.v;
            readHandles(in, e, PR_N + 1);
            prog.elems.push_back(e);
        } else if (k == "revolve") {
            Element e; e.op = 1; size_t n;
            ls >> e.id >> e.cu >> e.cv >> e.sides >> e.lobes >> e.lobeAmp >> e.twistDeg >> e.count >> e.stepU >> e.stepV >> e.stepH >> n;
            e.profileZR.resize(n); for (auto& p : e.profileZR) ls >> p.u >> p.v;
            readHandles(in, e, RV_N + 1);
            prog.elems.push_back(e);
        } else if (k == "sweep") {
            Element e; e.op = 2; size_t np, nf; int closed;
            ls >> e.id >> e.scaleEnd >> e.twistDeg >> closed >> e.count >> e.stepU >> e.stepV >> e.stepH >> np;
            e.closedPath = closed != 0;
            e.path.resize(np); for (auto& p : e.path) { double u, h, v; ls >> u >> h >> v; p = {u, h, v}; }
            ls >> nf; e.profile.resize(nf); for (auto& p : e.profile) ls >> p.x >> p.y >> p.z;
            readHandles(in, e, SW_N + 1);
            prog.elems.push_back(e);
        } else if (k == "relief") {
            Element e; e.op = 3;
            ls >> e.id >> e.target >> e.count >> e.stepU >> e.stepV >> e.stepH;
            readHandles(in, e, RL_N + 1);
            prog.elems.push_back(e);
        } else throw std::runtime_error("unknown spec line '" + k + "'");
        if (!ls && k != "fit") { /* tolerate trailing fields */ }
    }
    if (dir.empty()) throw std::runtime_error("program: out is required");
    std::filesystem::create_directories(dir);
    const bool haveTargets = !heightFile.empty() && grid.nu > 0 && !cams.empty();
    std::vector<float> th; std::vector<std::vector<float>> td;
    FitTargets T;
    if (haveTargets) {
        th = sd::readRaw<float>(heightFile, grid.size());
        for (size_t v = 0; v < cams.size(); ++v) td.push_back(sd::readRaw<float>(depthFiles[v], static_cast<size_t>(cams[v].W) * cams[v].H));
        T.grid = &grid; T.height = &th; T.cams = &cams; T.depth = &td; T.buildingH = buildingH; T.wHeight = wH; T.wSil = wS; T.wDepth = wD;
    }
    auto dump = [&](const std::string& tag) {
        if (!haveTargets) return;
        Soup s = buildProgram(prog);
        std::vector<float> h; std::vector<std::vector<float>> d;
        evaluate(s, T, &h, &d);
        sd::writeRaw(dir + "/prog_" + tag + "_h.f32", h);
        for (size_t v = 0; v < cams.size(); ++v) {
            std::vector<float> dd; std::vector<uint8_t> sh;
            rasterView(s, cams[v], dd, &sh);
            sd::writeRaw(dir + "/prog_" + tag + "_v" + std::to_string(v) + ".depth.f32", dd);
            sd::writeRaw(dir + "/prog_" + tag + "_v" + std::to_string(v) + ".shade.u8", sh);
        }
    };
    std::vector<std::vector<double>> before;
    for (const auto& e : prog.elems) { std::vector<double> v; for (const auto& h : e.h) v.push_back(h.value); before.push_back(v); }
    dump("before");
    FitResult F;
    if (haveTargets) {
        if (passes > 0) F = fitProgram(prog, T, passes, maxEvals);
        else { F.before = evaluate(buildProgram(prog), T); F.after = F.before; }
    }
    dump("after");
    // geometry: prisms as parts, the rest as closed solids, in the tile frame
    std::vector<PrismOut> prisms;
    auto t0 = std::chrono::steady_clock::now();
    Soup s = buildProgram(prog, &prisms);
    double buildMs = std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - t0).count();
    {
        // every triangle of the program in the tile frame (9 floats each), and the element it came from
        std::vector<float> soup; std::vector<int32_t> soupElem;
        for (size_t t = 0; t < s.size(); ++t) { for (int k = 0; k < 3; ++k) { P3 q = frame.toTile(s.p[3 * t + k]); soup.push_back(static_cast<float>(q.x)); soup.push_back(static_cast<float>(q.y)); soup.push_back(static_cast<float>(q.z)); } soupElem.push_back(s.elem[t]); }
        sd::writeRaw(dir + "/soup.f32", soup);
        sd::writeRaw(dir + "/soup_elem.i32", soupElem);
    }
    std::ofstream gj(dir + "/geometry.json");
    gj << "{\"parts\":[";
    for (size_t i = 0; i < prisms.size(); ++i) {
        const auto& p = prisms[i];
        double cap = 1e300;
        for (const auto& pl : p.planes) if (pl[1] == 0 && pl[2] == 0) cap = std::min(cap, pl[0]);
        gj << (i ? "," : "") << "{\"elem\":" << p.elem << ",\"id\":" << sd::jstr(prog.elems[static_cast<size_t>(p.elem)].id + "/" + std::to_string(i)) << ",\"baseY\":" << sd::fmt(frame.groundY + p.base) << ",\"topY\":" << sd::fmt(frame.groundY + cap)
           << ",\"loops\":" << loopsJson({p.outline}, &frame) << ",\"planes\":[";
        bool first = true;
        const double c = std::cos(frame.theta), sn = std::sin(frame.theta);
        for (const auto& pl : p.planes) {
            if (pl[1] == 0 && pl[2] == 0) continue;
            // h = a' + b' u + c' v with u = c (x - ox) + s (z - oz), v = -s (x - ox) + c (z - oz)
            double b = pl[1] * c - pl[2] * sn, cc = pl[1] * sn + pl[2] * c;
            double a = frame.groundY + pl[0] - b * frame.ox - cc * frame.oz;
            gj << (first ? "" : ",") << "{\"a\":" << sd::fmt(a) << ",\"b\":" << sd::fmt(b) << ",\"c\":" << sd::fmt(cc) << "}";
            first = false;
        }
        gj << "]}";
    }
    gj << "],\"meshes\":[";
    bool firstMesh = true;
    for (size_t e = 0; e < prog.elems.size(); ++e) {
        if (prog.elems[e].op == 0 || prog.elems[e].op == 3) continue;
        bool any = false;
        for (int el : s.elem) if (el == static_cast<int>(e)) { any = true; break; }
        if (!any) continue;
        gj << (firstMesh ? "" : ",") << "{\"elem\":" << e << ",\"id\":" << sd::jstr(prog.elems[e].id) << ",";
        writeSoupMesh(gj, s, static_cast<int>(e), frame);
        gj << "}";
        firstMesh = false;
    }
    gj << "],\"triangles\":" << s.size() << ",\"buildMs\":" << sd::fmt(buildMs) << "}\n";
    std::ofstream fj(dir + "/fit.json");
    fj << "{\"fitted\":" << (haveTargets && passes > 0 ? "true" : "false");
    if (haveTargets) fj << ",\"before\":" << lossJson(F.before) << ",\"after\":" << lossJson(F.after) << ",\"evals\":" << F.evals << ",\"passes\":" << F.passes << ",\"ms\":" << sd::fmt(F.ms);
    fj << ",\"handles\":[";
    for (size_t e = 0; e < prog.elems.size(); ++e) {
        fj << (e ? "," : "") << "[";
        for (size_t k = 0; k < prog.elems[e].h.size(); ++k) fj << (k ? "," : "") << "[" << sd::fmt(before[e][k]) << "," << sd::fmt(prog.elems[e].h[k].value) << "]";
        fj << "]";
    }
    fj << "]}\n";
    out << "{\"ok\":true,\"triangles\":" << s.size() << ",\"parts\":" << prisms.size() << ",\"lossBefore\":" << sd::fmt(F.before.total) << ",\"lossAfter\":" << sd::fmt(F.after.total) << "}\n";
}

}  // namespace

int main(int argc, char** argv) {
    if (argc < 2) { std::cerr << "usage: shape_program <spec.txt>\n"; return 2; }
    try {
        std::ifstream in(argv[1]);
        if (!in) throw std::runtime_error(std::string("cannot read ") + argv[1]);
        std::string first, mode;
        std::getline(in, first);
        std::istringstream fs(first);
        std::string k; fs >> k >> mode;
        if (k != "mode") throw std::runtime_error("the spec's first line must be 'mode scan' or 'mode program'");
        if (mode == "scan") runScan(in, std::cout);
        else if (mode == "program") runProgram(in, std::cout);
        else throw std::runtime_error("unknown mode " + mode);
        return 0;
    } catch (const std::exception& e) {
        std::cout << "{\"ok\":false,\"error\":" << sd::jstr(e.what()) << "}\n";
        return 1;
    }
}
