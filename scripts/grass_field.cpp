/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * CLI of the grass field (scratchbox_grass_field.hpp): reads an SBGF grid (grass mask, exclusions, confidence, surface
 * height, photo colour), builds the clump variants and places their instances, and writes report.json, mesh.bin,
 * instances.bin, underlayer.bin, detail.rgba, shells.bin and shell.rgba into the out dir. Prints {"ok":true,...} or {"ok":false,"error":...} and exits non-zero on failure.
 *
 *   grass_field <input.sbgf> <outDir> [key=value ...]
 *
 * Build:
 *   clang++ -std=c++20 -O3 -I packages/core/src/native/3d-engine/include scripts/grass_field.cpp -o build/3d-native/grass_field
 */

#include "scratchbox_grass_field.hpp"

#include <filesystem>
#include <fstream>
#include <iostream>

int main(int argc, char** argv) {
    using namespace scratchbox::grass_field;
    if (argc < 3) {
        std::cerr << "usage: grass_field <input.sbgf> <outDir> [key=value ...]\n";
        return 2;
    }
    try {
        Params p;
        for (int i = 3; i < argc; ++i) {
            const std::string a = argv[i];
            const auto eq = a.find('=');
            if (eq == std::string::npos) throw std::runtime_error("expected key=value, got " + a);
            p.set(a.substr(0, eq), std::stod(a.substr(eq + 1)));
        }
        const std::string out = argv[2];
        std::filesystem::create_directories(out);
        GrassField field(readInput(argv[1]), p);
        field.run();
        {
            std::ofstream r(out + "/report.json");
            r << field.reportJson();
        }
        field.writeMesh(out + "/mesh.bin", out + "/instances.bin");
        field.writeUnderlayer(out + "/underlayer.bin", out + "/detail.rgba");
        field.writeShells(out + "/shells.bin", out + "/shell.rgba");
        size_t n = 0;
        for (const auto& v : field.variants()) n += v.instances.size();
        std::cout << "{\"ok\":true,\"instances\":" << n << "}" << std::endl;
        return 0;
    } catch (const std::exception& e) {
        std::cout << "{\"ok\":false,\"error\":\"" << e.what() << "\"}" << std::endl;
        return 1;
    }
}
