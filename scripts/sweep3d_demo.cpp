/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * CLI driver for scratchbox::shaper::Sweep3D (scratchbox_shaper.hpp): sweeps a circular or
 * square profile along a carrier curve (helix, planar arc, or straight run) using
 * rotation-minimizing frames, with optional end-to-end twist and scale. Operator 1
 * (SE(3) curve sweeps) for plain object/prop builds (hoses, struts, coils, truss
 * members) that don't go through the photo-evidence architectural ornament pipeline
 * (scratchbox_ornament.hpp, which implements the same operator for building detail).
 *
 * Build:
 *   clang++ -std=c++20 -O3 -I packages/core/src/native/3d-engine/include scripts/sweep3d_demo.cpp \
 *       -o build/3d-native/sweep3d_demo -lz
 */

#include "scratchbox_engine.hpp"

#include <filesystem>
#include <fstream>
#include <iostream>
#include <string>

namespace fs = std::filesystem;
using namespace scratchbox;
using namespace scratchbox::math;
using namespace scratchbox::geometry;
using namespace scratchbox::shaper;

namespace {

std::vector<Vec3> buildCurve(const std::string& kind, int segments, float radius, float height, float turns) {
    std::vector<Vec3> curve;
    curve.reserve(segments + 1);
    if (kind == "helix") {
        for (int i = 0; i <= segments; ++i) {
            float t = static_cast<float>(i) / static_cast<float>(segments);
            float angle = t * TWO_PI * turns;
            curve.push_back(Vec3(std::cos(angle) * radius, t * height, std::sin(angle) * radius));
        }
    } else if (kind == "arc") {
        for (int i = 0; i <= segments; ++i) {
            float t = static_cast<float>(i) / static_cast<float>(segments);
            float angle = t * PI * turns;
            curve.push_back(Vec3(std::cos(angle) * radius, std::sin(angle) * radius, 0.0f));
        }
    } else { // "line"
        for (int i = 0; i <= segments; ++i) {
            float t = static_cast<float>(i) / static_cast<float>(segments);
            curve.push_back(Vec3(0.0f, t * height, 0.0f));
        }
    }
    return curve;
}

std::vector<Vec2> buildProfile(const std::string& kind, float profileRadius) {
    if (kind == "square") {
        return { {-profileRadius, -profileRadius}, {profileRadius, -profileRadius},
                 {profileRadius, profileRadius}, {-profileRadius, profileRadius} };
    }
    std::vector<Vec2> circle;
    const int sides = 16;
    for (int i = 0; i < sides; ++i) {
        float a = (static_cast<float>(i) / sides) * TWO_PI;
        circle.push_back(Vec2(std::cos(a) * profileRadius, std::sin(a) * profileRadius));
    }
    return circle;
}

} // namespace

int main(int argc, char** argv) {
    std::string curveKind = "helix";
    std::string profileKind = "circle";
    std::string outputGlbPath = "build/3d-native/sweep3d_demo.glb";
    int segments = 64;
    float curveRadius = 1.0f;
    float curveHeight = 4.0f;
    float curveTurns = 3.0f;
    float profileRadius = 0.12f;
    float twistDeg = 0.0f;
    float startScale = 1.0f;
    float endScale = 1.0f;

    for (int i = 1; i < argc; ++i) {
        std::string arg = argv[i];
        auto next = [&]() -> std::string { return (i + 1 < argc) ? argv[++i] : ""; };
        if (arg == "--curve") curveKind = next();
        else if (arg == "--profile") profileKind = next();
        else if (arg == "--output-glb") outputGlbPath = next();
        else if (arg == "--segments") segments = std::stoi(next());
        else if (arg == "--curve-radius") curveRadius = std::stof(next());
        else if (arg == "--curve-height") curveHeight = std::stof(next());
        else if (arg == "--curve-turns") curveTurns = std::stof(next());
        else if (arg == "--profile-radius") profileRadius = std::stof(next());
        else if (arg == "--twist-deg") twistDeg = std::stof(next());
        else if (arg == "--start-scale") startScale = std::stof(next());
        else if (arg == "--end-scale") endScale = std::stof(next());
        else if (arg == "--help") {
            std::cout << "usage: sweep3d_demo [--curve helix|arc|line] [--profile circle|square]\n"
                      << "  [--segments N] [--curve-radius M] [--curve-height M] [--curve-turns N]\n"
                      << "  [--profile-radius M] [--twist-deg D] [--start-scale S] [--end-scale S]\n"
                      << "  [--output-glb path]\n";
            return 0;
        }
    }

    std::vector<Vec3> curve = buildCurve(curveKind, segments, curveRadius, curveHeight, curveTurns);
    std::vector<Vec2> profile = buildProfile(profileKind, profileRadius);

    ScratchboxMesh mesh = Sweep3D::sweep(curve, profile, twistDeg * PI / 180.0f, startScale, endScale, /*closeEnds=*/true);

    // Sanity check: rotation-minimizing frames must not flip between adjacent stations.
    std::vector<Sweep3D::Frame> frames = Sweep3D::rotationMinimizingFrames(curve);
    for (size_t i = 1; i < frames.size(); ++i) {
        if (frames[i].normal.dot(frames[i - 1].normal) < 0.0f) {
            std::cerr << "{\"ok\":false,\"error\":\"frame flip detected at station " << i << "\"}\n";
            return 1;
        }
    }

    fs::create_directories(fs::path(outputGlbPath).parent_path());
    std::vector<uint8_t> glbData = io::GlbWriter::serializeToGlb(mesh);
    if (glbData.empty()) {
        std::cerr << "{\"ok\":false,\"error\":\"serializeToGlb produced no data\"}\n";
        return 1;
    }

    std::ofstream outFile(outputGlbPath, std::ios::binary);
    if (!outFile) {
        std::cerr << "{\"ok\":false,\"error\":\"cannot write " << outputGlbPath << "\"}\n";
        return 1;
    }
    outFile.write(reinterpret_cast<const char*>(glbData.data()), static_cast<std::streamsize>(glbData.size()));
    outFile.close();

    std::cout << "{\"ok\":true,\"vertices\":" << mesh.vertices.size()
              << ",\"triangles\":" << (mesh.indices.size() / 3)
              << ",\"outputGlb\":\"" << outputGlbPath << "\"}\n";
    return 0;
}
