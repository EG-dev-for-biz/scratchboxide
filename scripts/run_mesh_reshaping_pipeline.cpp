/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * Standalone Headless Mesh Reshaping Pipeline CLI (C++20).
 * Reshapes a given binary glTF 2.0 mesh (--input, required) with an explicit list of operations whose positions
 * and magnitudes are fractions of the mesh's measured bounds: deformers, FFD lattices, sculpt strokes, Kelvinlet
 * loads, subdivision.
 ********************************************************************************/

#include "scratchbox_engine.hpp"
#include "scratchbox_shaper.hpp"
#include "scratchbox_io.hpp"

#include <iostream>
#include <fstream>
#include <sstream>
#include <string>
#include <vector>
#include <chrono>
#include <filesystem>
#include <cmath>
#include <algorithm>
#include <stdexcept>
#include <utility>

namespace fs = std::filesystem;
using namespace scratchbox;
using namespace scratchbox::math;
using namespace scratchbox::geometry;
using namespace scratchbox::shaper;
using namespace scratchbox::io;

// ============================================================================
// Operations (parameters relative to the mesh's measured bounding box)
// ============================================================================
//
// Every operation is explicit: a missing or out-of-range parameter, or an unknown type, fails the run with
// exit code 2. Positions, lengths and offsets are fractions of the mesh's axis-aligned bounding box as it stands
// before that operation, so the same operation means the same thing on a 4 cm prop and a 60 m tower:
//   range [start, end]   fractions of the extent along `axis` (0 = min, 1 = max)
//   center [u, v, w]     fractions of the box along X, Y, Z
//   radius, strength     fractions of the box diagonal (strength is a 0..1 blend for the smooth/flatten brushes)
//   latticeOffsets       offsets as fractions of the box size per axis
//   displacement         kelvinlet grab, as fractions of the box diagonal
// Taper and twist act about the box's centre line along `axis`; bend and shear keep the box's min end fixed.

struct UsageError : std::runtime_error {
    using std::runtime_error::runtime_error;
};

static float& comp(Vec3& v, Axis a) { return a == Axis::X ? v.x : (a == Axis::Y ? v.y : v.z); }
static float comp(const Vec3& v, Axis a) { return a == Axis::X ? v.x : (a == Axis::Y ? v.y : v.z); }

static Axis requireAxis(const GlbJsonValue& op, const std::string& key, const std::string& type) {
    const std::string s = op[key].asString("");
    if (s == "X" || s == "x") return Axis::X;
    if (s == "Y" || s == "y") return Axis::Y;
    if (s == "Z" || s == "z") return Axis::Z;
    throw UsageError(type + " needs " + key + " (\"X\", \"Y\" or \"Z\")");
}

static float requireNumber(const GlbJsonValue& op, const std::string& key, const std::string& type) {
    if (!op.has(key) || op[key].type != GlbJsonValue::Number || !std::isfinite(op[key].num)) {
        throw UsageError(type + " needs a number " + key);
    }
    return static_cast<float>(op[key].num);
}

static float optionalNumber(const GlbJsonValue& op, const std::string& key, float def, const std::string& type) {
    return op.has(key) ? requireNumber(op, key, type) : def;
}

static Vec3 requireVec3(const GlbJsonValue& op, const std::string& key, const std::string& type) {
    const GlbJsonValue& v = op[key];
    if (v.type != GlbJsonValue::Array || v.arr.size() != 3 ||
        v[0].type != GlbJsonValue::Number || v[1].type != GlbJsonValue::Number || v[2].type != GlbJsonValue::Number) {
        throw UsageError(type + " needs " + key + " as [x, y, z]");
    }
    return Vec3(v[0].asFloat(), v[1].asFloat(), v[2].asFloat());
}

static std::pair<float, float> requireRange(const GlbJsonValue& op, const std::string& type) {
    const GlbJsonValue& r = op["range"];
    if (r.type != GlbJsonValue::Array || r.arr.size() != 2 || r[0].type != GlbJsonValue::Number || r[1].type != GlbJsonValue::Number) {
        throw UsageError(type + " needs range as [start, end], fractions of the extent along axis");
    }
    const float s = r[0].asFloat(), e = r[1].asFloat();
    if (!(s >= 0.0f && e <= 1.0f && s < e)) throw UsageError(type + " range must satisfy 0 <= start < end <= 1");
    return {s, e};
}

static void requirePositive(float v, const std::string& what) {
    if (!(v > 0.0f)) throw UsageError(what + " must be greater than 0");
}

static void translateMesh(ScratchboxMesh& mesh, const Vec3& d) {
    for (auto& v : mesh.vertices) v.position = v.position + d;
}

/** Arc-length preserving bend: the extent along `axis` becomes an arc of `angleRad`, curving toward +secondary. */
static void bendAlongExtent(ScratchboxMesh& mesh, Axis axis, Axis secondary, float angleRad, const AABB& b) {
    const float length = comp(b.max, axis) - comp(b.min, axis);
    if (std::abs(angleRad) < 1e-6f || length < 1e-9f) return;
    const float radius = length / angleRad;  // signed: a negative angle curves toward -secondary
    const float base = comp(b.min, axis);
    const float centre = 0.5f * (comp(b.min, secondary) + comp(b.max, secondary));
    for (auto& v : mesh.vertices) {
        const float m = comp(v.position, axis) - base;
        const float off = comp(v.position, secondary) - centre;
        const float theta = m / radius;
        comp(v.position, axis) = base + (radius - off) * std::sin(theta);
        comp(v.position, secondary) = centre + radius - (radius - off) * std::cos(theta);
    }
}

static SculptBrush requireBrush(const GlbJsonValue& op) {
    const std::string s = op["sculptBrush"].asString("");
    if (s == "clay") return SculptBrush::Clay;
    if (s == "inflate") return SculptBrush::Inflate;
    if (s == "flatten") return SculptBrush::Flatten;
    if (s == "crease") return SculptBrush::Crease;
    if (s == "smooth") return SculptBrush::Smooth;
    if (s == "grab" || s == "pinch") {
        throw UsageError("sculpt " + s + " is now the kelvinlet operation: {type: \"kelvinlet\", center, radius, " +
                         (s == "grab" ? std::string("displacement [dx, dy, dz]}") : std::string("pinchStrength, pinchDirection}")));
    }
    throw UsageError("sculpt needs sculptBrush (clay, inflate, flatten, crease or smooth; grab and pinch are the kelvinlet operation)");
}

/** Applies one operation, reading its parameters against the mesh's current bounds. */
static void applyOperation(ScratchboxMesh& mesh, const GlbJsonValue& op) {
    if (op.type != GlbJsonValue::Object) throw UsageError("each operation must be an object");
    const std::string type = op["type"].asString("");
    mesh.recomputeBounds();
    const AABB b = mesh.bounds;
    const Vec3 size = b.max - b.min;
    const float diag = size.length();
    const Vec3 centre = (b.min + b.max) * 0.5f;
    if (!(diag > 0.0f)) throw UsageError("the mesh has no extent to measure operations against");

    if (type == "taper" || type == "twist") {
        const Axis axis = requireAxis(op, "axis", type);
        const auto [s, e] = requireRange(op, type);
        const float lo = comp(b.min, axis) + s * comp(size, axis);
        const float hi = comp(b.min, axis) + e * comp(size, axis);
        Vec3 pivot = centre;
        comp(pivot, axis) = 0.0f;  // only the cross-section is centred; positions along the axis stay put
        translateMesh(mesh, pivot * -1.0f);
        if (type == "taper") {
            const float factor = requireNumber(op, "factor", type);
            requirePositive(factor, "taper factor");
            const float power = optionalNumber(op, "power", 1.0f, type);
            requirePositive(power, "taper power");
            Deformer::taper(mesh, axis, factor, lo, hi, power);
        } else {
            Deformer::twist(mesh, axis, requireNumber(op, "angleDeg", type) * (PI / 180.0f), lo, hi);
        }
        translateMesh(mesh, pivot);
    } else if (type == "bend") {
        const Axis axis = requireAxis(op, "axis", type);
        const Axis secondary = requireAxis(op, "secondaryAxis", type);
        if (axis == secondary) throw UsageError("bend needs secondaryAxis different from axis");
        bendAlongExtent(mesh, axis, secondary, requireNumber(op, "angleDeg", type) * (PI / 180.0f), b);
    } else if (type == "shear") {
        const Axis axis = requireAxis(op, "axis", type);
        const Axis secondary = requireAxis(op, "secondaryAxis", type);
        if (axis == secondary) throw UsageError("shear needs secondaryAxis different from axis");
        Vec3 base(0, 0, 0);
        comp(base, axis) = comp(b.min, axis);
        translateMesh(mesh, base * -1.0f);
        Deformer::shear(mesh, axis, secondary, requireNumber(op, "factor", type));
        translateMesh(mesh, base);
    } else if (type == "bulge") {
        const Vec3 c = requireVec3(op, "center", type);
        const float radius = requireNumber(op, "radius", type);
        requirePositive(radius, "bulge radius");
        const float power = optionalNumber(op, "power", 2.0f, type);
        requirePositive(power, "bulge power");
        Deformer::bulge(mesh, Vec3(b.min.x + c.x * size.x, b.min.y + c.y * size.y, b.min.z + c.z * size.z),
                        radius * diag, requireNumber(op, "strength", type) * diag, power);
    } else if (type == "sculpt") {
        const SculptBrush brush = requireBrush(op);
        const Vec3 c = requireVec3(op, "center", type);
        const float radius = requireNumber(op, "radius", type);
        requirePositive(radius, "sculpt radius");
        const float strength = requireNumber(op, "strength", type);
        const bool blend = brush == SculptBrush::Smooth || brush == SculptBrush::Flatten;
        const bool directed = brush == SculptBrush::Clay || brush == SculptBrush::Flatten;
        const Vec3 direction = directed ? requireVec3(op, "direction", type) : Vec3(0, 1, 0);
        if (directed && direction.lengthSq() < 1e-12f) throw UsageError("sculpt direction must not be zero");
        SculptEngine::applyStroke(mesh, brush, Vec3(b.min.x + c.x * size.x, b.min.y + c.y * size.y, b.min.z + c.z * size.z),
                                  radius * diag, blend ? strength : strength * diag, direction);
    } else if (type == "lattice") {
        const GlbJsonValue& dims = op["latticeDimensions"];
        if (dims.type != GlbJsonValue::Array || dims.arr.size() != 3) throw UsageError("lattice needs latticeDimensions [nx, ny, nz]");
        const int nx = dims[0].asInt(0), ny = dims[1].asInt(0), nz = dims[2].asInt(0);
        if (nx < 2 || ny < 2 || nz < 2 || nx > 8 || ny > 8 || nz > 8) throw UsageError("lattice dimensions must each be 2..8");
        const GlbJsonValue& offsets = op["latticeOffsets"];
        if (offsets.type != GlbJsonValue::Array || offsets.arr.empty()) throw UsageError("lattice needs at least one latticeOffsets entry");
        Lattice3D lattice(nx, ny, nz, b);
        for (const auto& item : offsets.arr) {
            const int i = item["i"].asInt(-1), j = item["j"].asInt(-1), k = item["k"].asInt(-1);
            if (i < 0 || i >= nx || j < 0 || j >= ny || k < 0 || k >= nz) throw UsageError("lattice offset index outside the lattice");
            const Vec3 o = requireVec3(item, "offset", "lattice offset");
            lattice.offsetControlPoint(i, j, k, Vec3(o.x * size.x, o.y * size.y, o.z * size.z));
        }
        lattice.deform(mesh);
    } else if (type == "kelvinlet") {
        // A regularised point load (scratchbox_kelvinlet.hpp): any of a grab, a twist, a uniform scale and a pinch,
        // superposed at one load point.
        const Vec3 c = requireVec3(op, "center", type);
        const float radius = requireNumber(op, "radius", type);
        requirePositive(radius, "kelvinlet radius");
        kelvinlet::Load load;
        load.center = Vec3(b.min.x + c.x * size.x, b.min.y + c.y * size.y, b.min.z + c.z * size.z);
        bool any = false;
        if (op.has("displacement")) {
            load.displacement = requireVec3(op, "displacement", type) * diag;
            any = true;
        }
        try {
            if (op.has("twistDeg")) {
                const Vec3 axis = requireVec3(op, "twistAxis", type);
                load.gradient = load.gradient + kelvinlet::Load::twist(load.center, axis, requireNumber(op, "twistDeg", type) * (PI / 180.0f)).gradient;
                any = true;
            }
            if (op.has("scaleFactor")) {
                const float factor = requireNumber(op, "scaleFactor", type);
                requirePositive(factor, "kelvinlet scaleFactor");
                load.gradient = load.gradient + kelvinlet::Load::scale(load.center, factor).gradient;
                any = true;
            }
            if (op.has("pinchStrength")) {
                const Vec3 dir = requireVec3(op, "pinchDirection", type);
                Vec3 secondary;
                const bool planar = op.has("pinchSecondaryDirection");
                if (planar) secondary = requireVec3(op, "pinchSecondaryDirection", type);
                load.gradient = load.gradient + kelvinlet::Load::pinch(load.center, dir, requireNumber(op, "pinchStrength", type), planar ? &secondary : nullptr).gradient;
                any = true;
            }
            if (!any) throw UsageError("kelvinlet needs at least one load: displacement, twistDeg (with twistAxis), scaleFactor or pinchStrength (with pinchDirection)");
            kelvinlet::Options options;
            options.epsilon = radius * diag;
            options.poissonRatio = optionalNumber(op, "poissonRatio", 0.5f, type);
            const float scales = optionalNumber(op, "falloffScales", 1.0f, type);
            if (scales != std::floor(scales)) throw UsageError("kelvinlet falloffScales must be 1, 2 or 3");
            options.falloffScales = static_cast<int>(scales);
            options.falloffRatio = optionalNumber(op, "falloffRatio", 1.5f, type);
            const float steps = optionalNumber(op, "steps", 0.0f, type);
            if (steps < 0 || steps > 4096 || steps != std::floor(steps)) throw UsageError("kelvinlet steps must be a whole number 1..4096 (0 or absent chooses)");
            options.steps = static_cast<int>(steps);
            Deformer::kelvinlet(mesh, load, options);
        } catch (const std::invalid_argument& e) {
            throw UsageError(e.what());
        }
    } else if (type == "subdivide") {
        const float iterations = requireNumber(op, "subdivideIterations", type);
        if (iterations < 1 || iterations > 3 || iterations != std::floor(iterations)) throw UsageError("subdivideIterations must be 1, 2 or 3");
        mesh = LoopSubdivision::subdivide(mesh, static_cast<int>(iterations));
    } else if (type == "repair") {
        MeshTopologyCleaner::removeDegenerateFaces(mesh);
    } else if (type == "weathering") {
        const float amplitude = requireNumber(op, "weatheringIntensity", type);
        const float cycles = requireNumber(op, "weatheringScale", type);
        requirePositive(cycles, "weatheringScale (noise cycles across the mesh)");
        mesh.applyProceduralWeathering(cycles / diag, amplitude);
    } else {
        throw UsageError("unknown operation type \"" + type + "\" (taper, twist, bend, shear, bulge, sculpt, lattice, kelvinlet, subdivide, repair, weathering)");
    }
    mesh.recomputeBounds();
}

// ============================================================================
// Main CLI Execution
// ============================================================================

int main(int argc, char** argv) {
    std::string inputPath = "";
    std::string outputPath = "";
    std::string operationsJson = "";
    std::string operationsFile = "";
    bool streamStdout = false;

    for (int i = 1; i < argc; ++i) {
        std::string arg = argv[i];
        if (arg == "--input" && i + 1 < argc) {
            inputPath = argv[++i];
        } else if (arg == "--output" && i + 1 < argc) {
            outputPath = argv[++i];
        } else if (arg == "--operationsJson" && i + 1 < argc) {
            operationsJson = argv[++i];
        } else if (arg == "--operationsFile" && i + 1 < argc) {
            operationsFile = argv[++i];
        } else if (arg == "--stream") {
            streamStdout = true;
        } else {
            std::cerr << "Error: unknown argument " << arg << "\n";
            return 2;
        }
    }

    try {
        // The mesh to reshape is required: no stand-in mesh is ever built in its place.
        if (inputPath.empty()) throw UsageError("--input <mesh.glb> is required; the pipeline reshapes a given mesh and builds none of its own");
        if (!fs::exists(inputPath)) throw UsageError("--input " + inputPath + " does not exist");
        if (outputPath.empty() && !streamStdout) throw UsageError("--output <path.glb> (or --stream) is required");
        if (!operationsFile.empty()) {
            if (!fs::exists(operationsFile)) throw UsageError("--operationsFile " + operationsFile + " does not exist");
            std::ifstream f(operationsFile);
            std::stringstream ss;
            ss << f.rdbuf();
            operationsJson = ss.str();
        }
        if (operationsJson.empty()) throw UsageError("operations are required (--operationsJson or --operationsFile); none are chosen for you");

        GlbJsonParser parser(operationsJson.data(), operationsJson.size());
        const GlbJsonValue root = parser.parse();
        const GlbJsonValue& list = root.type == GlbJsonValue::Object ? root["operations"] : root;
        if (list.type != GlbJsonValue::Array || list.arr.empty()) throw UsageError("operations must be a non-empty array");

        auto startTime = std::chrono::high_resolution_clock::now();
        if (!streamStdout) std::cout << "  [Input] Ingesting GLB: " << inputPath << "\n";
        ScratchboxMesh mesh = GlbReader::readGlb(inputPath);
        if (mesh.vertices.empty() || mesh.indices.size() < 3) throw UsageError("--input " + inputPath + " has no triangles");

        mesh.recomputeBounds();
        const AABB inputBounds = mesh.bounds;
        const uint32_t inputVertices = static_cast<uint32_t>(mesh.vertices.size());
        const uint32_t inputTriangles = static_cast<uint32_t>(mesh.indices.size() / 3);

        size_t index = 0;
        for (const auto& op : list.arr) {
            try {
                applyOperation(mesh, op);
            } catch (const UsageError& e) {
                throw UsageError("operation " + std::to_string(index) + ": " + e.what());
            }
            ++index;
        }

        mesh.recomputeSmoothNormals();
        mesh.recomputeBounds();

        auto endTime = std::chrono::high_resolution_clock::now();
        double processingTimeMs = std::chrono::duration<double, std::milli>(endTime - startTime).count();

        const uint32_t outputVertices = static_cast<uint32_t>(mesh.vertices.size());
        const uint32_t outputTriangles = static_cast<uint32_t>(mesh.indices.size() / 3);
        const float reliefDeltaY = mesh.bounds.max.y - mesh.bounds.min.y;

        if (!outputPath.empty()) {
            if (fs::path(outputPath).has_parent_path()) fs::create_directories(fs::path(outputPath).parent_path());
            std::vector<uint8_t> glbData = GlbWriter::writeGlb(mesh);
            std::ofstream outFile(outputPath, std::ios::binary);
            if (!outFile.is_open()) {
                std::cerr << "Error: failed to open output file " << outputPath << "\n";
                return 1;
            }
            outFile.write(reinterpret_cast<const char*>(glbData.data()), glbData.size());
            outFile.close();
            if (!streamStdout) std::cout << "  [Output] Wrote GLB (" << glbData.size() << " bytes) to: " << outputPath << "\n";
        }

        if (streamStdout) {
            GlbWriter::streamChunk(mesh, mesh.name.empty() ? "reshaped_mesh" : mesh.name);
        }

        std::cout << "[TELEMETRY] status=success"
                  << " inputVertices=" << inputVertices
                  << " outputVertices=" << outputVertices
                  << " inputTriangles=" << inputTriangles
                  << " outputTriangles=" << outputTriangles
                  << " reliefDeltaY=" << reliefDeltaY
                  << " inputBoundsMin=[" << inputBounds.min.x << "," << inputBounds.min.y << "," << inputBounds.min.z << "]"
                  << " inputBoundsMax=[" << inputBounds.max.x << "," << inputBounds.max.y << "," << inputBounds.max.z << "]"
                  << " boundsMin=[" << mesh.bounds.min.x << "," << mesh.bounds.min.y << "," << mesh.bounds.min.z << "]"
                  << " boundsMax=[" << mesh.bounds.max.x << "," << mesh.bounds.max.y << "," << mesh.bounds.max.z << "]"
                  << " processingTimeMs=" << processingTimeMs
                  << " operationsCount=" << list.arr.size()
                  << "\n" << std::flush;
        return 0;
    } catch (const UsageError& e) {
        std::cerr << "Error: " << e.what() << "\n";
        return 2;
    }
}
