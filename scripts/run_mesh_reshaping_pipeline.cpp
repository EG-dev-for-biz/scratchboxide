/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * Standalone Headless Mesh Reshaping Pipeline CLI (C++20).
 * Implements high-performance native mesh deformation, FFD lattices,
 * digital sculpting, topology refinement, and binary glTF 2.0 streaming.
 *
 * SPDX-License-Identifier: MIT
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

namespace fs = std::filesystem;
using namespace scratchbox;
using namespace scratchbox::math;
using namespace scratchbox::geometry;
using namespace scratchbox::shaper;
using namespace scratchbox::io;

// ============================================================================
// Synthetic Benchmark Mesh Builders
// ============================================================================

static ScratchboxMesh createCylinderBenchmark(float radius = 1.0f, float height = 4.0f, int radialSegments = 24, int heightSegments = 16) {
    ScratchboxMesh mesh("CylinderBenchmark");
    float halfH = height * 0.5f;

    for (int y = 0; y <= heightSegments; ++y) {
        float v = static_cast<float>(y) / heightSegments;
        float posY = -halfH + v * height;
        for (int x = 0; x <= radialSegments; ++x) {
            float u = static_cast<float>(x) / radialSegments;
            float angle = u * TWO_PI;
            float cosA = std::cos(angle);
            float sinA = std::sin(angle);
            Vec3 pos(cosA * radius, posY, sinA * radius);
            Vec3 norm(cosA, 0.0f, sinA);
            mesh.addVertex(Vertex(pos, norm, Vec2(u, v), Vec4(0.85f, 0.85f, 0.88f, 1.0f)));
        }
    }

    int rowStride = radialSegments + 1;
    for (int y = 0; y < heightSegments; ++y) {
        for (int x = 0; x < radialSegments; ++x) {
            uint32_t i0 = y * rowStride + x;
            uint32_t i1 = (y + 1) * rowStride + x;
            uint32_t i2 = (y + 1) * rowStride + (x + 1);
            uint32_t i3 = y * rowStride + (x + 1);

            mesh.indices.push_back(i0);
            mesh.indices.push_back(i1);
            mesh.indices.push_back(i2);
            mesh.indices.push_back(i0);
            mesh.indices.push_back(i2);
            mesh.indices.push_back(i3);
        }
    }

    mesh.recomputeBounds();
    return mesh;
}

static ScratchboxMesh createCubeBenchmark(float size = 2.0f, int subdivisions = 8) {
    ScratchboxMesh mesh("CubeBenchmark");
    float half = size * 0.5f;

    auto buildFace = [&](const Vec3& origin, const Vec3& uDir, const Vec3& vDir, const Vec3& normal) {
        int baseIdx = static_cast<int>(mesh.vertices.size());
        for (int j = 0; j <= subdivisions; ++j) {
            float vj = static_cast<float>(j) / subdivisions;
            for (int i = 0; i <= subdivisions; ++i) {
                float ui = static_cast<float>(i) / subdivisions;
                Vec3 p = origin + uDir * (ui * size) + vDir * (vj * size);
                mesh.addVertex(Vertex(p, normal, Vec2(ui, vj), Vec4(0.8f, 0.82f, 0.85f, 1.0f)));
            }
        }
        int stride = subdivisions + 1;
        for (int j = 0; j < subdivisions; ++j) {
            for (int i = 0; i < subdivisions; ++i) {
                uint32_t i0 = baseIdx + j * stride + i;
                uint32_t i1 = baseIdx + (j + 1) * stride + i;
                uint32_t i2 = baseIdx + (j + 1) * stride + (i + 1);
                uint32_t i3 = baseIdx + j * stride + (i + 1);
                mesh.indices.push_back(i0);
                mesh.indices.push_back(i1);
                mesh.indices.push_back(i2);
                mesh.indices.push_back(i0);
                mesh.indices.push_back(i2);
                mesh.indices.push_back(i3);
            }
        }
    };

    buildFace(Vec3(-half, -half, half), Vec3(1, 0, 0), Vec3(0, 1, 0), Vec3(0, 0, 1));
    buildFace(Vec3(half, -half, -half), Vec3(-1, 0, 0), Vec3(0, 1, 0), Vec3(0, 0, -1));
    buildFace(Vec3(-half, half, -half), Vec3(1, 0, 0), Vec3(0, 0, 1), Vec3(0, 1, 0));
    buildFace(Vec3(-half, -half, half), Vec3(1, 0, 0), Vec3(0, 0, -1), Vec3(0, -1, 0));
    buildFace(Vec3(half, -half, half), Vec3(0, 0, -1), Vec3(0, 1, 0), Vec3(1, 0, 0));
    buildFace(Vec3(-half, -half, -half), Vec3(0, 0, 1), Vec3(0, 1, 0), Vec3(-1, 0, 0));

    mesh.recomputeBounds();
    return mesh;
}

static ScratchboxMesh createSculptureBenchmark() {
    std::vector<std::vector<Vec3>> slices;
    const int numSlices = 12;
    const int ptsPerSlice = 16;
    const float height = 6.0f;

    for (int s = 0; s < numSlices; ++s) {
        float t = static_cast<float>(s) / (numSlices - 1);
        float y = (t - 0.5f) * height;
        float r = 1.0f + 0.35f * std::sin(t * PI);
        std::vector<Vec3> slice;
        for (int p = 0; p < ptsPerSlice; ++p) {
            float angle = (static_cast<float>(p) / ptsPerSlice) * TWO_PI;
            slice.push_back(Vec3(std::cos(angle) * r, y, std::sin(angle) * r * 0.9f));
        }
        slices.push_back(slice);
    }

    ScratchboxMesh mesh = Loft3D::skin(slices, true, Vec4(0.8f, 0.85f, 0.95f, 1.0f));
    mesh.name = "SculptureBenchmark";
    mesh.recomputeBounds();
    return mesh;
}

// ============================================================================
// Operation Definitions & Helpers
// ============================================================================

static Axis parseAxis(const std::string& str, Axis def = Axis::Y) {
    if (str == "X" || str == "x") return Axis::X;
    if (str == "Y" || str == "y") return Axis::Y;
    if (str == "Z" || str == "z") return Axis::Z;
    return def;
}

static SculptBrush parseBrush(const std::string& str, SculptBrush def = SculptBrush::Clay) {
    if (str == "grab" || str == "Grab") return SculptBrush::Grab;
    if (str == "clay" || str == "Clay") return SculptBrush::Clay;
    if (str == "inflate" || str == "Inflate") return SculptBrush::Inflate;
    if (str == "flatten" || str == "Flatten") return SculptBrush::Flatten;
    if (str == "pinch" || str == "Pinch") return SculptBrush::Pinch;
    if (str == "crease" || str == "Crease") return SculptBrush::Crease;
    if (str == "smooth" || str == "Smooth") return SculptBrush::Smooth;
    return def;
}

struct LatticeOffset {
    int i{0};
    int j{0};
    int k{0};
    Vec3 offset{0, 0, 0};
};

struct ReshapingOp {
    std::string type;
    Axis axis{Axis::Y};
    Axis secondaryAxis{Axis::X};
    float factor{1.0f};
    float angleRad{0.0f};
    float minBound{-1.0f};
    float maxBound{1.0f};
    float power{1.0f};
    float radius{1.0f};
    float strength{0.2f};
    Vec3 center{0, 0, 0};
    Vec3 direction{0, 1, 0};
    SculptBrush brush{SculptBrush::Clay};
    int dimX{3};
    int dimY{3};
    int dimZ{3};
    std::vector<LatticeOffset> latticeOffsets;
    int subdivideIterations{1};
    float weldEpsilon{0.001f};
    float weatheringIntensity{1.0f};
    float weatheringScale{0.05f};
};

// Parse operations from JSON string using internal GlbJsonParser
static std::vector<ReshapingOp> parseOperationsFromJson(const std::string& jsonStr) {
    std::vector<ReshapingOp> ops;
    if (jsonStr.empty()) return ops;

    GlbJsonParser parser(jsonStr.data(), jsonStr.size());
    GlbJsonValue root = parser.parse();

    auto parseSingleOp = [](const GlbJsonValue& val) -> ReshapingOp {
        ReshapingOp op;
        op.type = val["type"].asString("taper");
        op.axis = parseAxis(val["axis"].asString("Y"), Axis::Y);
        op.secondaryAxis = parseAxis(val["secondaryAxis"].asString("X"), Axis::X);
        op.factor = val["factor"].asFloat(1.0f);

        if (val.has("angleDeg")) {
            op.angleRad = val["angleDeg"].asFloat(0.0f) * (PI / 180.0f);
        } else {
            op.angleRad = val["angleRad"].asFloat(0.0f);
        }

        op.minBound = val["minBound"].asFloat(-1.0f);
        op.maxBound = val["maxBound"].asFloat(1.0f);
        op.power = val["power"].asFloat(1.0f);
        op.radius = val["radius"].asFloat(1.0f);
        op.strength = val["strength"].asFloat(0.2f);

        if (val.has("center") && val["center"].type == GlbJsonValue::Array) {
            op.center = Vec3(
                val["center"][0].asFloat(0.0f),
                val["center"][1].asFloat(0.0f),
                val["center"][2].asFloat(0.0f)
            );
        }

        if (val.has("direction") && val["direction"].type == GlbJsonValue::Array) {
            op.direction = Vec3(
                val["direction"][0].asFloat(0.0f),
                val["direction"][1].asFloat(1.0f),
                val["direction"][2].asFloat(0.0f)
            );
        }

        op.brush = parseBrush(val["sculptBrush"].asString("clay"), SculptBrush::Clay);

        if (val.has("latticeDimensions") && val["latticeDimensions"].type == GlbJsonValue::Array) {
            op.dimX = val["latticeDimensions"][0].asInt(3);
            op.dimY = val["latticeDimensions"][1].asInt(3);
            op.dimZ = val["latticeDimensions"][2].asInt(3);
        }

        if (val.has("latticeOffsets") && val["latticeOffsets"].type == GlbJsonValue::Array) {
            for (const auto& item : val["latticeOffsets"].arr) {
                LatticeOffset lo;
                lo.i = item["i"].asInt(0);
                lo.j = item["j"].asInt(0);
                lo.k = item["k"].asInt(0);
                if (item.has("offset") && item["offset"].type == GlbJsonValue::Array) {
                    lo.offset = Vec3(
                        item["offset"][0].asFloat(0.0f),
                        item["offset"][1].asFloat(0.0f),
                        item["offset"][2].asFloat(0.0f)
                    );
                }
                op.latticeOffsets.push_back(lo);
            }
        }

        op.subdivideIterations = val["subdivideIterations"].asInt(1);
        op.weldEpsilon = val["weldEpsilon"].asFloat(0.001f);
        op.weatheringIntensity = val["weatheringIntensity"].asFloat(1.0f);
        op.weatheringScale = val["weatheringScale"].asFloat(0.05f);

        return op;
    };

    if (root.type == GlbJsonValue::Array) {
        for (const auto& item : root.arr) {
            ops.push_back(parseSingleOp(item));
        }
    } else if (root.type == GlbJsonValue::Object) {
        if (root.has("operations") && root["operations"].type == GlbJsonValue::Array) {
            for (const auto& item : root["operations"].arr) {
                ops.push_back(parseSingleOp(item));
            }
        } else {
            ops.push_back(parseSingleOp(root));
        }
    }

    return ops;
}

// ============================================================================
// Main CLI Execution
// ============================================================================

int main(int argc, char** argv) {
    std::string inputPath = "";
    std::string outputPath = "";
    std::string benchmark = "cylinder";
    std::string operationsJson = "";
    std::string operationsFile = "";
    bool streamStdout = false;

    // CLI args parsing
    for (int i = 1; i < argc; ++i) {
        std::string arg = argv[i];
        if (arg == "--input" && i + 1 < argc) {
            inputPath = argv[++i];
        } else if (arg == "--output" && i + 1 < argc) {
            outputPath = argv[++i];
        } else if (arg == "--benchmark" && i + 1 < argc) {
            benchmark = argv[++i];
        } else if (arg == "--operationsJson" && i + 1 < argc) {
            operationsJson = argv[++i];
        } else if (arg == "--operationsFile" && i + 1 < argc) {
            operationsFile = argv[++i];
        } else if (arg == "--stream") {
            streamStdout = true;
        }
    }

    // Load JSON from file if requested
    if (!operationsFile.empty() && fs::exists(operationsFile)) {
        std::ifstream f(operationsFile);
        std::stringstream ss;
        ss << f.rdbuf();
        operationsJson = ss.str();
    }

    auto startTime = std::chrono::high_resolution_clock::now();

    // 1. Ingest or Generate Input Mesh
    ScratchboxMesh mesh;
    if (!inputPath.empty() && fs::exists(inputPath)) {
        if (!streamStdout) std::cout << "  [Input] Ingesting GLB: " << inputPath << "\n";
        mesh = GlbReader::readGlb(inputPath);
    } else if (benchmark == "cube") {
        mesh = createCubeBenchmark();
    } else if (benchmark == "sculpture") {
        mesh = createSculptureBenchmark();
    } else {
        mesh = createCylinderBenchmark();
    }

    if (mesh.vertices.empty()) {
        std::cerr << "Error: mesh has zero vertices after ingestion/benchmark creation\n";
        return 1;
    }

    uint32_t inputVertices = static_cast<uint32_t>(mesh.vertices.size());
    uint32_t inputTriangles = static_cast<uint32_t>(mesh.indices.size() / 3);

    // 2. Parse Reshaping Operations
    std::vector<ReshapingOp> operations = parseOperationsFromJson(operationsJson);

    // Ensure mesh bounds are up to date
    mesh.recomputeBounds();
    AABB bounds = mesh.bounds;

    // 3. Apply Reshaping Operations in Sequence
    for (const auto& op : operations) {
        float minB = op.minBound;
        float maxB = op.maxBound;

        // Auto-adapt min/max bounds to mesh bounding box if default [-1, 1] was given and bounds differ
        if (op.minBound == -1.0f && op.maxBound == 1.0f) {
            if (op.axis == Axis::X) { minB = bounds.min.x; maxB = bounds.max.x; }
            else if (op.axis == Axis::Y) { minB = bounds.min.y; maxB = bounds.max.y; }
            else if (op.axis == Axis::Z) { minB = bounds.min.z; maxB = bounds.max.z; }
        }

        if (op.type == "taper") {
            Deformer::taper(mesh, op.axis, op.factor, minB, maxB, op.power);
        } else if (op.type == "twist") {
            Deformer::twist(mesh, op.axis, op.angleRad, minB, maxB);
        } else if (op.type == "bend") {
            Deformer::bend(mesh, op.axis, op.secondaryAxis, op.angleRad, op.radius);
        } else if (op.type == "bulge") {
            Deformer::bulge(mesh, op.center, op.radius, op.strength, op.power);
        } else if (op.type == "shear") {
            Deformer::shear(mesh, op.axis, op.secondaryAxis, op.factor);
        } else if (op.type == "lattice") {
            Lattice3D lattice(op.dimX, op.dimY, op.dimZ, mesh.bounds);
            for (const auto& lo : op.latticeOffsets) {
                lattice.offsetControlPoint(lo.i, lo.j, lo.k, lo.offset);
            }
            lattice.deform(mesh);
        } else if (op.type == "sculpt") {
            SculptEngine::applyStroke(mesh, op.brush, op.center, op.radius, op.strength, op.direction);
        } else if (op.type == "subdivide") {
            mesh = LoopSubdivision::subdivide(mesh, op.subdivideIterations);
        } else if (op.type == "repair") {
            MeshTopologyCleaner::removeDegenerateFaces(mesh);
        } else if (op.type == "weathering") {
            mesh.applyProceduralWeathering(op.weatheringIntensity, op.weatheringScale);
        }

        // Keep bounds updated across chained operations
        mesh.recomputeBounds();
        bounds = mesh.bounds;
    }

    mesh.recomputeSmoothNormals();
    mesh.recomputeBounds();

    auto endTime = std::chrono::high_resolution_clock::now();
    double processingTimeMs = std::chrono::duration<double, std::milli>(endTime - startTime).count();

    uint32_t outputVertices = static_cast<uint32_t>(mesh.vertices.size());
    uint32_t outputTriangles = static_cast<uint32_t>(mesh.indices.size() / 3);
    float reliefDeltaY = mesh.bounds.max.y - mesh.bounds.min.y;

    // 4. Output: Write to Disk or Stream to Stdout
    if (!outputPath.empty()) {
        fs::create_directories(fs::path(outputPath).parent_path());
        std::vector<uint8_t> glbData = GlbWriter::writeGlb(mesh);
        std::ofstream outFile(outputPath, std::ios::binary);
        if (outFile.is_open()) {
            outFile.write(reinterpret_cast<const char*>(glbData.data()), glbData.size());
            outFile.close();
            if (!streamStdout) std::cout << "  [Output] Wrote GLB (" << glbData.size() << " bytes) to: " << outputPath << "\n";
        } else {
            std::cerr << "Error: failed to open output file " << outputPath << "\n";
            return 1;
        }
    }

    if (streamStdout) {
        GlbWriter::streamChunk(mesh, mesh.name.empty() ? "reshaped_mesh" : mesh.name);
    }

    // 5. Emit Structured Telemetry Tag
    std::cout << "[TELEMETRY] status=success"
              << " inputVertices=" << inputVertices
              << " outputVertices=" << outputVertices
              << " inputTriangles=" << inputTriangles
              << " outputTriangles=" << outputTriangles
              << " reliefDeltaY=" << reliefDeltaY
              << " boundsMin=[" << mesh.bounds.min.x << "," << mesh.bounds.min.y << "," << mesh.bounds.min.z << "]"
              << " boundsMax=[" << mesh.bounds.max.x << "," << mesh.bounds.max.y << "," << mesh.bounds.max.z << "]"
              << " processingTimeMs=" << processingTimeMs
              << " operationsCount=" << operations.size()
              << "\n" << std::flush;

    return 0;
}
