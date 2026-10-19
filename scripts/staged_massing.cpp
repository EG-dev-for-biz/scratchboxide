/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * CLI of the staged-location pipeline E massing (scratchbox_staged_massing.hpp): reads a spec (file argument, or stdin
 * with "-"), builds the clean solid, bakes its faces' orthophotos from the photo tile, classifies the isolated scan's
 * residual, and writes mesh.bin, report.json and the images into the spec's out dir. Prints {"ok":true} or
 * {"ok":false,"error":...} and exits non-zero on failure.
 *
 * Build:
 *   clang++ -std=c++20 -O3 -pthread -I packages/core/src/native/3d-engine/include scripts/staged_massing.cpp \
 *       -o build/3d-native/staged_massing -lz
 */

#include "scratchbox_staged_massing.hpp"

#include <filesystem>
#include <fstream>
#include <iostream>

int main(int argc, char** argv) {
    using namespace scratchbox::staged_massing;
    if (argc < 2) {
        std::cerr << "usage: staged_massing <spec.txt | ->\n";
        return 2;
    }
    try {
        Spec spec;
        if (std::string(argv[1]) == "-") spec = readSpec(std::cin);
        else {
            std::ifstream in(argv[1]);
            if (!in) throw std::runtime_error(std::string("cannot read ") + argv[1]);
            spec = readSpec(in);
        }
        std::filesystem::create_directories(spec.outDir);
        StagedMassing m(spec);
        m.run();
        std::cout << "{\"ok\":true,\"faces\":" << m.faces().size() << ",\"nodes\":" << m.nodes().size() << ",\"signedVolumeM3\":" << m.signedVolume() << "}\n";
        return 0;
    } catch (const std::exception& e) {
        std::cout << "{\"ok\":false,\"error\":" << scratchbox::staged_massing::detail::jstr(e.what()) << "}\n";
        return 1;
    }
}
