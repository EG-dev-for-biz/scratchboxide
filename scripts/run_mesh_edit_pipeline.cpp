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
#include "scratchbox_mesh_edit.hpp"

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
    throw UsageError("unknown operation type \"" + type + "\" (boolean, cut or extrude)");
}

int main(int argc, char** argv) {
    std::string inputPath, outputPath, operationsFile;
    double creaseDeg = 30;
    for (int i = 1; i < argc; ++i) {
        const std::string arg = argv[i];
        if (arg == "--input" && i + 1 < argc) inputPath = argv[++i];
        else if (arg == "--output" && i + 1 < argc) outputPath = argv[++i];
        else if (arg == "--operationsFile" && i + 1 < argc) operationsFile = argv[++i];
        else if (arg == "--creaseDeg" && i + 1 < argc) creaseDeg = std::stod(argv[++i]);
        else { std::cerr << "Error: unknown argument " << arg << "\n"; return 2; }
    }
    try {
        if (inputPath.empty() || !fs::exists(inputPath)) throw UsageError("--input <mesh.glb> is required and must exist; no stand-in mesh is built");
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
