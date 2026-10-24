/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * CLI: lofts runs of cross-section rings into closed solids with Loft3D (scratchbox_shaper.hpp). Input (text file
 * argument): "runs R", then per run "run S K" and S rings of K "x y z" points (bottom to top, the same point count and
 * winding on every ring). Output (second argument): binary, per run uint32 vertexCount, uint32 indexCount, then
 * float32 x y z per vertex and uint32 indices. Prints {"ok":true,...} or {"ok":false,"error":...} on stdout.
 *
 *   clang++ -std=c++20 -O3 -I packages/core/src/native/3d-engine/include scripts/sb_loft_sections.cpp -o sb_loft_sections
 */

#include "scratchbox_shaper.hpp"

#include <cstdint>
#include <fstream>
#include <iostream>
#include <string>
#include <vector>

using namespace scratchbox::geometry;
using scratchbox::shaper::Loft3D;

int main(int argc, char** argv) {
    try {
        if (argc < 3) throw std::runtime_error("usage: sb_loft_sections <rings.txt> <out.bin>");
        std::ifstream in(argv[1]);
        if (!in) throw std::runtime_error(std::string("cannot read ") + argv[1]);
        std::string word;
        size_t runs = 0;
        in >> word >> runs;
        if (word != "runs") throw std::runtime_error("expected 'runs R'");
        std::ofstream out(argv[2], std::ios::binary);
        if (!out) throw std::runtime_error(std::string("cannot write ") + argv[2]);
        size_t triangles = 0;
        for (size_t r = 0; r < runs; ++r) {
            size_t S = 0, K = 0;
            in >> word >> S >> K;
            if (word != "run" || S < 2 || K < 3) throw std::runtime_error("run " + std::to_string(r) + ": expected 'run S K' with S >= 2, K >= 3");
            std::vector<std::vector<Vec3>> rings(S, std::vector<Vec3>(K));
            for (auto& ring : rings) for (auto& p : ring) in >> p.x >> p.y >> p.z;
            if (!in) throw std::runtime_error("run " + std::to_string(r) + ": truncated ring data");
            const ScratchboxMesh m = Loft3D::skin(rings, true);
            const uint32_t nv = static_cast<uint32_t>(m.vertices.size()), ni = static_cast<uint32_t>(m.indices.size());
            out.write(reinterpret_cast<const char*>(&nv), 4);
            out.write(reinterpret_cast<const char*>(&ni), 4);
            for (const auto& v : m.vertices) { const float xyz[3] = {v.position.x, v.position.y, v.position.z}; out.write(reinterpret_cast<const char*>(xyz), 12); }
            out.write(reinterpret_cast<const char*>(m.indices.data()), static_cast<std::streamsize>(ni) * 4);
            triangles += ni / 3;
        }
        std::cout << "{\"ok\":true,\"runs\":" << runs << ",\"triangles\":" << triangles << "}" << std::endl;
        return 0;
    } catch (const std::exception& e) {
        std::cout << "{\"ok\":false,\"error\":\"" << e.what() << "\"}" << std::endl;
        return 1;
    }
}
