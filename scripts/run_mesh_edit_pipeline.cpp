/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * Standalone Headless Mesh Edit Pipeline CLI (C++20).
 * Edits a given binary glTF 2.0 mesh (--input, required) with an explicit list of modelling operations
 * (scratchbox_mesh_edit.hpp): booleans with another mesh or a measured solid, plane cuts, extrude and inset of a
 * selected region. Lengths are metres in the mesh's own space; selection regions are fractions of its bounds.
 * Writes --output and one [RESULT] JSON line per run with each operation's counts.
 ********************************************************************************/

#include "scratchbox_engine.hpp"
#include "scratchbox_io.hpp"
#include "scratchbox_mesh_edit_ops.hpp"

#include <iostream>
#include <fstream>
#include <sstream>
#include <string>
#include <vector>
#include <chrono>
#include <filesystem>
#include <cmath>

namespace fs = std::filesystem;
using namespace scratchbox;
using namespace scratchbox::math;
using namespace scratchbox::geometry;
using namespace scratchbox::io;
using namespace scratchbox::mesh_edit;

struct UsageError : std::runtime_error {
    using std::runtime_error::runtime_error;
};

static double requireNumber(const GlbJsonValue& o, const std::string& key, const std::string& what) {
    if (!o.has(key) || o[key].type != GlbJsonValue::Number || !std::isfinite(o[key].num)) throw UsageError(what + " needs a number " + key);
    return o[key].num;
}

static double optionalNumber(const GlbJsonValue& o, const std::string& key, double def, const std::string& what) {
    return o.has(key) ? requireNumber(o, key, what) : def;
}

static D3 requireD3(const GlbJsonValue& o, const std::string& key, const std::string& what) {
    const GlbJsonValue& v = o[key];
    if (v.type != GlbJsonValue::Array || v.arr.size() != 3 || v[0].type != GlbJsonValue::Number || v[1].type != GlbJsonValue::Number || v[2].type != GlbJsonValue::Number) {
        throw UsageError(what + " needs " + key + " as [x, y, z]");
    }
    return {v[0].num, v[1].num, v[2].num};
}

static Vec3 toVec3(const D3& d) { return Vec3(float(d.x), float(d.y), float(d.z)); }

/** select {direction?, coneDeg?, regionMin?, regionMax?}; absent or empty = every face (when allowAll). */
static FaceSelection parseSelect(const GlbJsonValue& s, bool& all) {
    FaceSelection sel;
    all = true;
    if (s.type != GlbJsonValue::Object) return sel;
    if (s.has("direction")) { sel.hasDirection = true; sel.direction = toVec3(requireD3(s, "direction", "select")); sel.coneDeg = float(optionalNumber(s, "coneDeg", 30, "select")); all = false; }
    if (s.has("regionMin") || s.has("regionMax")) {
        sel.hasRegion = true; all = false;
        sel.regionMin = s.has("regionMin") ? toVec3(requireD3(s, "regionMin", "select")) : Vec3(0, 0, 0);
        sel.regionMax = s.has("regionMax") ? toVec3(requireD3(s, "regionMax", "select")) : Vec3(1, 1, 1);
    }
    return sel;
}

static std::vector<D3> requirePath(const GlbJsonValue& o, const std::string& key, const std::string& what) {
    const GlbJsonValue& v = o[key];
    if (v.type != GlbJsonValue::Array || v.arr.size() < 2) throw UsageError(what + " needs " + key + " as at least 2 [x, y, z] points");
    std::vector<D3> out;
    for (const auto& q : v.arr) {
        if (q.type != GlbJsonValue::Array || q.arr.size() != 3) throw UsageError(what + " " + key + " points must be [x, y, z]");
        out.push_back({q[0].num, q[1].num, q[2].num});
    }
    return out;
}

static void replaceWithPolygons(ScratchboxMesh& mesh, std::vector<CsgPolygon> polys, double eps) {
    closeTJunctions(polys, eps * 10);
    PbrMaterial material = mesh.material;
    std::string name = mesh.name;
    mesh = polygonsToMesh(polys, name);
    mesh.material = material;
}

static std::vector<CsgPolygon> operandPolygons(const GlbJsonValue& operand, double& extent) {
    if (operand.type != GlbJsonValue::Object) throw UsageError("boolean needs an operand object: {glbPath}, {box}, {cylinder} or {sphere}");
    if (operand.has("glbPath")) {
        const std::string p = operand["glbPath"].asString("");
        if (p.empty() || !fs::exists(p)) throw UsageError("operand glbPath " + p + " does not exist");
        ScratchboxMesh m = GlbReader::readGlb(p);
        if (m.indices.size() < 12) throw UsageError("operand " + p + " has fewer than 4 triangles; a boolean needs a closed solid");
        m.recomputeBounds();
        extent = std::max(extent, double((m.bounds.max - m.bounds.min).length()));
        return meshToPolygons(m);
    }
    if (operand.has("box")) {
        const GlbJsonValue& b = operand["box"];
        const D3 c = requireD3(b, "center", "box"), size = requireD3(b, "size", "box");
        if (!(size.x > 0 && size.y > 0 && size.z > 0)) throw UsageError("box size must be > 0 on every axis");
        D3 ax{1, 0, 0}, ay{0, 1, 0}, az{0, 0, 1};
        if (b.has("rotationDeg")) eulerAxes(requireD3(b, "rotationDeg", "box"), ax, ay, az);
        return boxPolygons(c, size, ax, ay, az);
    }
    if (operand.has("cylinder")) {
        const GlbJsonValue& c = operand["cylinder"];
        return cylinderPolygons(requireD3(c, "start", "cylinder"), requireD3(c, "end", "cylinder"), requireNumber(c, "radius", "cylinder"),
                                int(optionalNumber(c, "segments", 48, "cylinder")));
    }
    if (operand.has("sphere")) {
        const GlbJsonValue& s = operand["sphere"];
        return spherePolygons(requireD3(s, "center", "sphere"), requireNumber(s, "radius", "sphere"), int(optionalNumber(s, "segments", 32, "sphere")));
    }
    throw UsageError("boolean operand needs glbPath, box, cylinder or sphere");
}

static std::string applyOperation(ScratchboxMesh& mesh, const GlbJsonValue& op) {
    if (op.type != GlbJsonValue::Object) throw UsageError("each operation must be an object");
    const std::string type = op["type"].asString("");
    mesh.recomputeBounds();
    const double diag = (mesh.bounds.max - mesh.bounds.min).length();
    const uint32_t before = uint32_t(mesh.indices.size() / 3);
    if (type == "boolean" || type == "cut") {
        double extent = diag;
        std::vector<CsgPolygon> b;
        BooleanOp bop = BooleanOp::Subtract;
        if (type == "cut") {
            // no operand solid: the half-space is built inside cutPolygons
        } else {
            const std::string s = op["op"].asString("");
            if (s == "union") bop = BooleanOp::Union;
            else if (s == "subtract") bop = BooleanOp::Subtract;
            else if (s == "intersect") bop = BooleanOp::Intersect;
            else throw UsageError("boolean needs op: union, subtract or intersect");
            b = operandPolygons(op["operand"], extent);
        }
        std::vector<CsgPolygon> a = meshToPolygons(mesh);
        if (a.size() + b.size() > 400000) throw UsageError("a boolean on more than 400,000 triangles is refused (" + std::to_string(a.size() + b.size()) + "); decimate first");
        const double eps = std::max(1e-9, 1e-7 * std::max(extent, 1e-3));
        PbrMaterial material = mesh.material;
        std::string name = mesh.name;
        std::vector<CsgPolygon> result = type == "cut"
            ? cutPolygons(std::move(a), requireD3(op, "point", "cut"), requireD3(op, "normal", "cut"), eps)
            : booleanPolygons(std::move(a), std::move(b), bop, eps);
        closeTJunctions(result, eps * 10);
        mesh = polygonsToMesh(result, name);
        mesh.material = material;
        if (mesh.indices.empty()) throw UsageError(type + " left nothing: the solids do not overlap that way (" + (type == "cut" ? "the plane is past the whole mesh" : op["op"].asString("")) + ")");
        return "{\"type\":\"" + type + "\",\"trianglesBefore\":" + std::to_string(before) + ",\"trianglesAfter\":" + std::to_string(mesh.indices.size() / 3) + "}";
    }
    if (type == "extrude") {
        const GlbJsonValue& s = op["select"];
        if (s.type != GlbJsonValue::Object) throw UsageError("extrude needs select {direction?, coneDeg?, regionMin?, regionMax?}");
        FaceSelection sel;
        if (s.has("direction")) { sel.hasDirection = true; sel.direction = toVec3(requireD3(s, "direction", "select")); sel.coneDeg = float(optionalNumber(s, "coneDeg", 30, "select")); }
        if (s.has("regionMin") || s.has("regionMax")) {
            sel.hasRegion = true;
            sel.regionMin = s.has("regionMin") ? toVec3(requireD3(s, "regionMin", "select")) : Vec3(0, 0, 0);
            sel.regionMax = s.has("regionMax") ? toVec3(requireD3(s, "regionMax", "select")) : Vec3(1, 1, 1);
        }
        auto faces = selectFaces(mesh, sel);
        const float distance = float(optionalNumber(op, "distance", 0, "extrude")), inset = float(optionalNumber(op, "inset", 0, "extrude"));
        const float tol = float(std::max(1e-6, 1e-5 * diag));
        // inset first (a ring in the faces' own plane), then the inner faces raised straight
        ExtrudeStats st = extrudeFaces(mesh, faces, inset > 0 ? 0.0f : distance, inset, tol);
        if (inset > 0 && distance != 0) {
            faces.resize(mesh.indices.size() / 3, 0);
            const ExtrudeStats raised = extrudeFaces(mesh, faces, distance, 0, tol);
            st.sideTriangles += raised.sideTriangles;
        }
        return "{\"type\":\"extrude\",\"selectedFaces\":" + std::to_string(st.selectedFaces) + ",\"boundaryEdges\":" + std::to_string(st.boundaryEdges)
            + ",\"sideTriangles\":" + std::to_string(st.sideTriangles) + ",\"trianglesAfter\":" + std::to_string(mesh.indices.size() / 3) + "}";
    }
    if (type == "bevel") {
        BevelOptions o;
        o.width = requireNumber(op, "width", "bevel");
        if (!(o.width > 0)) throw UsageError("bevel needs width > 0 (metres)");
        o.segments = int(optionalNumber(op, "segments", 1, "bevel"));
        if (o.segments < 1 || o.segments > 32) throw UsageError("bevel segments must be 1..32");
        o.minAngleDeg = optionalNumber(op, "minAngleDeg", 30, "bevel");
        const GlbJsonValue& s = op["select"];
        if (s.type == GlbJsonValue::Object && (s.has("regionMin") || s.has("regionMax"))) {
            o.hasRegion = true;
            o.regionMin = s.has("regionMin") ? toVec3(requireD3(s, "regionMin", "select")) : Vec3(0, 0, 0);
            o.regionMax = s.has("regionMax") ? toVec3(requireD3(s, "regionMax", "select")) : Vec3(1, 1, 1);
        }
        std::vector<BevelEdge> edges;
        size_t shortEdges = 0;
        // an edge shorter than twice the width (a facet of a curved rim) is left sharp and counted
        for (const auto& e : convexEdges(mesh, o, float(std::max(1e-6, 1e-5 * diag)))) {
            if ((e.b - e.a).length() < o.width * 2) ++shortEdges; else edges.push_back(e);
        }
        if (edges.empty()) throw UsageError("bevel found no convex edge turning by at least " + std::to_string(int(o.minAngleDeg)) + " degrees and longer than twice the width in the selection" + (shortEdges ? " (" + std::to_string(shortEdges) + " shorter ones)" : ""));
        if (edges.size() > 400) throw UsageError("bevel found " + std::to_string(edges.size()) + " edges; narrow it with select or minAngleDeg (at most 400)");
        const double eps = std::max(1e-9, 1e-7 * diag);
        std::vector<CsgPolygon> polys = meshToPolygons(mesh);
        for (const auto& e : edges) {
            std::vector<CsgPolygon> cutter = bevelCutter(e, o.width, o.segments, eps);
            if (!cutter.empty()) polys = booleanPolygons(std::move(polys), std::move(cutter), BooleanOp::Subtract, eps);
        }
        closeTJunctions(polys, eps * 10);
        PbrMaterial material = mesh.material;
        mesh = polygonsToMesh(polys, mesh.name);
        mesh.material = material;
        return "{\"type\":\"bevel\",\"edges\":" + std::to_string(edges.size()) + ",\"shortEdgesLeftSharp\":" + std::to_string(shortEdges) + ",\"trianglesBefore\":" + std::to_string(before) + ",\"trianglesAfter\":" + std::to_string(mesh.indices.size() / 3) + "}";
    }
    const float tol = float(std::max(1e-6, 1e-5 * diag));
    const double eps = std::max(1e-9, 1e-7 * diag);
    auto counts = [&](const std::string& extra) {
        return "{\"type\":\"" + type + "\"" + extra + ",\"trianglesBefore\":" + std::to_string(before) + ",\"trianglesAfter\":" + std::to_string(mesh.indices.size() / 3) + "}";
    };
    if (type == "shell") {
        const double t = requireNumber(op, "thickness", "shell");
        WMesh w = toWelded(mesh, tol);
        mesh = fromWelded(shellMesh(w, t), mesh);
        return counts(",\"thicknessM\":" + std::to_string(t));
    }
    if (type == "mirror" || type == "array") {
        WMesh w = toWelded(mesh, tol);
        std::vector<WMesh> copies;
        if (type == "mirror") { copies.push_back(w); copies.push_back(mirrorMesh(w, requireD3(op, "point", "mirror"), requireD3(op, "normal", "mirror"))); }
        else {
            const D3 offset = op.has("offset") ? requireD3(op, "offset", "array") : D3{0, 0, 0};
            const double step = optionalNumber(op, "stepDeg", 0, "array");
            if (offset.length() == 0 && step == 0) throw UsageError("array needs an offset and/or stepDeg (with axisPoint and axisDir)");
            copies = arrayCopies(w, int(requireNumber(op, "count", "array")), offset,
                                 op.has("axisPoint") ? requireD3(op, "axisPoint", "array") : D3{0, 0, 0}, op.has("axisDir") ? requireD3(op, "axisDir", "array") : D3{0, 0, 0}, step);
        }
        const bool fuse = !op.has("fuse") || op["fuse"].type != GlbJsonValue::Bool || op["fuse"].b;
        if (fuse) {
            std::vector<CsgPolygon> acc = weldedToPolygons(copies[0]);
            for (size_t i = 1; i < copies.size(); ++i) acc = booleanPolygons(std::move(acc), weldedToPolygons(copies[i]), BooleanOp::Union, eps);
            replaceWithPolygons(mesh, std::move(acc), eps);
        } else {
            WMesh all;
            for (const auto& c : copies) {
                const uint32_t base = uint32_t(all.p.size());
                all.p.insert(all.p.end(), c.p.begin(), c.p.end());
                for (const auto& f : c.t) all.t.push_back({f[0] + base, f[1] + base, f[2] + base});
            }
            mesh = fromWelded(all, mesh);
        }
        return counts(",\"copies\":" + std::to_string(copies.size()) + ",\"fused\":" + (fuse ? "true" : "false"));
    }
    if (type == "sweep") {
        std::vector<D3> path = requirePath(op, "path", "sweep");
        std::vector<std::array<double, 2>> profile;
        if (op.has("profile")) {
            const GlbJsonValue& pr = op["profile"];
            if (pr.type != GlbJsonValue::Array) throw UsageError("sweep profile must be [[u, v], ...]");
            for (const auto& q : pr.arr) {
                if (q.type != GlbJsonValue::Array || q.arr.size() != 2) throw UsageError("sweep profile points must be [u, v]");
                profile.push_back({q[0].num, q[1].num});
            }
        } else {
            const double r = requireNumber(op, "radius", "sweep (radius or profile)");
            if (!(r > 0)) throw UsageError("sweep radius must be > 0");
            const int segs = int(optionalNumber(op, "segments", 16, "sweep"));
            if (segs < 3 || segs > 256) throw UsageError("sweep segments must be 3..256");
            for (int i = 0; i < segs; ++i) profile.push_back({r * std::cos(2 * M_PI * i / segs), r * std::sin(2 * M_PI * i / segs)});
        }
        std::vector<CsgPolygon> solid = sweepPolygons(path, profile, optionalNumber(op, "scaleStart", 1, "sweep"), optionalNumber(op, "scaleEnd", 1, "sweep"), optionalNumber(op, "twistDeg", 0, "sweep"));
        const std::string how = op.has("op") ? op["op"].asString("union") : "union";
        BooleanOp bop = how == "subtract" ? BooleanOp::Subtract : (how == "union" ? BooleanOp::Union : (throw UsageError("sweep op must be union or subtract"), BooleanOp::Union));
        replaceWithPolygons(mesh, booleanPolygons(meshToPolygons(mesh), std::move(solid), bop, eps), eps);
        if (mesh.indices.empty()) throw UsageError("sweep left nothing");
        return counts(",\"op\":\"" + how + "\"");
    }
    if (type == "clean" || type == "decimate") {
        WMesh w = toWelded(mesh, tol);
        double maxErr = 1e-6 * diag;
        size_t target = 0;
        if (type == "decimate") {
            maxErr = optionalNumber(op, "maxErrorM", 1e30, "decimate");
            if (op.has("targetTriangles")) target = size_t(requireNumber(op, "targetTriangles", "decimate"));
            else if (op.has("ratio")) target = size_t(w.t.size() * std::clamp(requireNumber(op, "ratio", "decimate"), 0.0, 1.0));
            else if (!op.has("maxErrorM")) throw UsageError("decimate needs targetTriangles, ratio or maxErrorM");
        }
        const CollapseStats st = collapseEdges(w, maxErr, target);
        mesh = fromWelded(w, mesh);
        std::ostringstream e; e << st.maxError;
        return counts(",\"collapsed\":" + std::to_string(st.collapsed) + ",\"maxErrorM\":" + e.str());
    }
    if (type == "fracture") {
        const bool hasImpact = op.has("impact");
        auto pieces = fractureMesh(meshToPolygons(mesh), int(requireNumber(op, "pieces", "fracture")), uint32_t(optionalNumber(op, "seed", 1, "fracture")),
                                   hasImpact, hasImpact ? requireD3(op, "impact", "fracture") : D3{0, 0, 0}, optionalNumber(op, "spread", diag * 0.25, "fracture"), eps);
        const double gap = optionalNumber(op, "gap", 0, "fracture");
        std::vector<CsgPolygon> all;
        const DBox whole = boxOf(meshToPolygons(mesh));
        const D3 middle = (whole.lo + whole.hi) * 0.5;
        for (auto& pc : pieces) {
            closeTJunctions(pc.polys, eps * 10);
            if (gap > 0) {
                // each piece moved gap metres straight out from the middle of the mesh, so the cracks open
                DBox bb = boxOf(pc.polys);
                D3 away = (bb.lo + bb.hi) * 0.5 - middle;
                const double l = away.length();
                if (l > 0) for (auto& p : pc.polys) for (auto& v : p.verts) v.p = v.p + away * (gap / l);
            }
            all.insert(all.end(), pc.polys.begin(), pc.polys.end());
        }
        PbrMaterial material = mesh.material;
        mesh = polygonsToMesh(all, mesh.name);
        mesh.material = material;
        return counts(",\"pieces\":" + std::to_string(pieces.size()));
    }
    if (type == "subdivide" || type == "smooth" || type == "relief") {
        bool all = true;
        FaceSelection fs = parseSelect(op["select"], all);
        WMesh w = toWelded(mesh, tol);
        std::vector<uint8_t> sel = all ? std::vector<uint8_t>(w.t.size(), 1) : selectWelded(w, fs);
        size_t chosen = 0;
        for (auto x : sel) chosen += x;
        if (!chosen) throw UsageError(type + ": the selection matched no faces");
        const double edge = op.has("edgeLength") ? requireNumber(op, "edgeLength", type) : (type == "subdivide" ? (throw UsageError("subdivide needs edgeLength (metres)"), 0.0) : 0.0);
        uint32_t splits = edge > 0 ? splitLongEdges(w, sel, edge, 2000000) : 0;
        std::string extra = ",\"selectedFaces\":" + std::to_string(chosen) + ",\"edgeSplits\":" + std::to_string(splits);
        if (type == "smooth") {
            const uint32_t moved = smoothSelection(w, sel, int(optionalNumber(op, "iterations", 10, "smooth")), optionalNumber(op, "strength", 0.5, "smooth"));
            extra += ",\"pointsMoved\":" + std::to_string(moved);
        } else if (type == "relief") {
            ReliefOptions ro;
            ro.amplitude = requireNumber(op, "amplitude", "relief");
            if (op.has("direction")) ro.direction = requireD3(op, "direction", "relief");
            ro.period = optionalNumber(op, "period", 1, "relief");
            ro.duty = optionalNumber(op, "duty", 0.5, "relief");
            ro.softness = optionalNumber(op, "softness", 0.1, "relief");
            ro.roughness = optionalNumber(op, "roughness", 0, "relief");
            ro.noiseScale = optionalNumber(op, "noiseScale", 1, "relief");
            ro.seed = uint32_t(optionalNumber(op, "seed", 1, "relief"));
            const uint32_t moved = reliefSelection(w, sel, ro);
            if (!moved) throw UsageError("relief moved nothing: the selection has no points away from its border; give edgeLength to subdivide it first");
            extra += ",\"pointsMoved\":" + std::to_string(moved);
        }
        mesh = fromWelded(w, mesh);
        return counts(extra);
    }
    throw UsageError("unknown operation type \"" + type + "\" (boolean, cut, extrude, bevel, shell, mirror, array, sweep, clean, decimate, fracture, subdivide, smooth or relief)");
}

int main(int argc, char** argv) {
    std::string inputPath, outputPath, operationsFile;
    double creaseDeg = 30;
    bool inspect = false;
    for (int i = 1; i < argc; ++i) {
        const std::string arg = argv[i];
        if (arg == "--input" && i + 1 < argc) inputPath = argv[++i];
        else if (arg == "--output" && i + 1 < argc) outputPath = argv[++i];
        else if (arg == "--operationsFile" && i + 1 < argc) operationsFile = argv[++i];
        else if (arg == "--creaseDeg" && i + 1 < argc) creaseDeg = std::stod(argv[++i]);
        else if (arg == "--inspect") inspect = true;
        else { std::cerr << "Error: unknown argument " << arg << "\n"; return 2; }
    }
    try {
        if (inputPath.empty() || !fs::exists(inputPath)) throw UsageError("--input <mesh.glb> is required and must exist; no stand-in mesh is built");
        if (inspect) {
            ScratchboxMesh m = GlbReader::readGlb(inputPath);
            if (m.indices.size() < 3) throw UsageError("--input " + inputPath + " has no triangles");
            m.recomputeBounds();
            const double d = (m.bounds.max - m.bounds.min).length();
            std::cout << "[RESULT] {\"status\":\"success\",\"inspect\":" << inspectJson(m, float(std::max(1e-6, 1e-5 * d)), creaseDeg, 12) << "}\n" << std::flush;
            return 0;
        }
        if (outputPath.empty()) throw UsageError("--output <path.glb> is required");
        if (operationsFile.empty() || !fs::exists(operationsFile)) throw UsageError("--operationsFile is required; no operation is chosen for you");
        std::ifstream f(operationsFile);
        std::stringstream ss;
        ss << f.rdbuf();
        const std::string json = ss.str();
        GlbJsonParser parser(json.data(), json.size());
        const GlbJsonValue root = parser.parse();
        if (root.type != GlbJsonValue::Array || root.arr.empty()) throw UsageError("operations must be a non-empty array");

        const auto t0 = std::chrono::high_resolution_clock::now();
        ScratchboxMesh mesh = GlbReader::readGlb(inputPath);
        if (mesh.indices.size() < 3) throw UsageError("--input " + inputPath + " has no triangles");
        const uint32_t inputTriangles = uint32_t(mesh.indices.size() / 3);
        std::string results = "[";
        for (size_t i = 0; i < root.arr.size(); ++i) {
            try {
                results += (i ? "," : "") + applyOperation(mesh, root.arr[i]);
            } catch (const std::exception& e) {
                throw UsageError("operation " + std::to_string(i) + ": " + e.what());
            }
        }
        results += "]";
        mesh.recomputeBounds();
        const double diag = (mesh.bounds.max - mesh.bounds.min).length();
        const uint32_t slivers = dropDegenerate(mesh, float(1e-12 * diag * diag));
        creaseNormals(mesh, float(creaseDeg), float(std::max(1e-6, 1e-5 * diag)));
        if (mesh.indices.empty()) throw UsageError("the edits left no triangles");

        if (fs::path(outputPath).has_parent_path()) fs::create_directories(fs::path(outputPath).parent_path());
        const std::vector<uint8_t> glb = GlbWriter::writeGlb(mesh);
        std::ofstream out(outputPath, std::ios::binary);
        if (!out) { std::cerr << "Error: failed to open output file " << outputPath << "\n"; return 1; }
        out.write(reinterpret_cast<const char*>(glb.data()), glb.size());
        out.close();
        const double ms = std::chrono::duration<double, std::milli>(std::chrono::high_resolution_clock::now() - t0).count();
        std::cout << "[RESULT] {\"status\":\"success\",\"inputTriangles\":" << inputTriangles << ",\"outputTriangles\":" << mesh.indices.size() / 3
                  << ",\"outputVertices\":" << mesh.vertices.size() << ",\"openEdges\":" << openEdges(mesh, float(std::max(1e-6, 1e-5 * diag))) << ",\"slivers\":" << slivers
                  << ",\"boundsMin\":[" << mesh.bounds.min.x << "," << mesh.bounds.min.y << "," << mesh.bounds.min.z << "]"
                  << ",\"boundsMax\":[" << mesh.bounds.max.x << "," << mesh.bounds.max.y << "," << mesh.bounds.max.z << "]"
                  << ",\"processingTimeMs\":" << ms << ",\"operations\":" << results << "}\n" << std::flush;
        return 0;
    } catch (const UsageError& e) {
        std::cerr << "Error: " << e.what() << "\n";
        return 2;
    } catch (const std::exception& e) {
        std::cerr << "Error: " << e.what() << "\n";
        return 1;
    }
}
