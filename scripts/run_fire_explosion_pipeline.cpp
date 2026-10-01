/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * Standalone Native C++20 Fire Explosion Simulation Pipeline CLI.
 * Implements Stokes aerodynamic drag, convective toroidal swirl,
 * multipole harmonic lobe asymmetry, Planckian thermal blackbody radiation,
 * Beer-Lambert optical extinction, and binary glTF 2.0 streaming.
 ********************************************************************************/

#include "scratchbox_engine.hpp"
#include "scratchbox_fire_simulation.hpp"
#include "scratchbox_io.hpp"

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
using namespace scratchbox::fire;
using namespace scratchbox::io;

int main(int argc, char* argv[]) {
    std::string outputPath = "";
    bool streamStdout = true;
    int particleCount = 20000;
    int warmupSteps = 45;
    float dt = 0.01667f;

    for (int i = 1; i < argc; ++i) {
        std::string arg = argv[i];
        if (arg == "--output" && i + 1 < argc) {
            outputPath = argv[++i];
        } else if (arg == "--particles" && i + 1 < argc) {
            particleCount = std::stoi(argv[++i]);
        } else if (arg == "--steps" && i + 1 < argc) {
            warmupSteps = std::stoi(argv[++i]);
        } else if (arg == "--no-stream") {
            streamStdout = false;
        } else if (arg == "--benchmark") {
            particleCount = 10000;
            warmupSteps = 30;
        }
    }

    auto startTime = std::chrono::high_resolution_clock::now();

    // 1. Initialize High-Performance C++20 Fire Explosion Simulation
    FireExplosionSimulation sim("fire_explosion_sim", particleCount);
    sim.center = Vec3(0.0f, 2.0f, 0.0f);
    sim.scale = 1.0f;

    // 2. Step Physics with Stokes Aerodynamic Drag and Toroidal Convection
    for (int s = 0; s < warmupSteps; ++s) {
        sim.step(dt);
    }

    // 3. Convert Active Flame Parcels to 3D Camera-Facing Billboard Mesh with PBR Emission
    ScratchboxMesh mesh = sim.toMesh(Vec3(0.0f, 4.0f, 10.0f), 3000);
    mesh.name = "fire_explosion_mesh";
    mesh.material = PbrMaterial::emissiveGlow(Vec3(1.0f, 0.55f, 0.1f), 3.5f);
    mesh.recomputeBounds();

    auto endTime = std::chrono::high_resolution_clock::now();
    double processingTimeMs = std::chrono::duration<double, std::milli>(endTime - startTime).count();

    uint32_t outputVertices = static_cast<uint32_t>(mesh.vertices.size());
    uint32_t outputTriangles = static_cast<uint32_t>(mesh.indices.size() / 3);

    // Compute plume asymmetry ratio (height / mean radial spread)
    float height = mesh.bounds.max.y - mesh.bounds.min.y;
    float spreadX = mesh.bounds.max.x - mesh.bounds.min.x;
    float spreadZ = mesh.bounds.max.z - mesh.bounds.min.z;
    float meanSpread = std::max(0.01f, (spreadX + spreadZ) * 0.5f);
    float asymmetryRatio = height / meanSpread;

    // 4. Output: Write to Disk or Stream Binary glTF Chunks
    if (!outputPath.empty()) {
        if (fs::path(outputPath).has_parent_path()) {
            fs::create_directories(fs::path(outputPath).parent_path());
        }
        std::vector<uint8_t> glbData = GlbWriter::writeGlb(mesh);
        std::ofstream outFile(outputPath, std::ios::binary);
        if (outFile.is_open()) {
            outFile.write(reinterpret_cast<const char*>(glbData.data()), glbData.size());
            outFile.close();
            if (!streamStdout) {
                std::cout << "  [Output] Wrote Fire GLB (" << glbData.size() << " bytes) to: " << outputPath << "\n";
            }
        } else {
            std::cerr << "Error: failed to open output file " << outputPath << "\n";
            return 1;
        }
    }

    if (streamStdout) {
        GlbWriter::streamChunk(mesh, "fire_explosion_mesh");
    }

    // 5. Emit Structured Telemetry Tag
    std::cout << "[TELEMETRY] status=success"
              << " particleCount=" << particleCount
              << " outputVertices=" << outputVertices
              << " outputTriangles=" << outputTriangles
              << " plumeHeight=" << height
              << " asymmetryRatio=" << asymmetryRatio
              << " processingTimeMs=" << processingTimeMs
              << " boundsMin=[" << mesh.bounds.min.x << "," << mesh.bounds.min.y << "," << mesh.bounds.min.z << "]"
              << " boundsMax=[" << mesh.bounds.max.x << "," << mesh.bounds.max.y << "," << mesh.bounds.max.z << "]"
              << "\n" << std::flush;

    return 0;
}
