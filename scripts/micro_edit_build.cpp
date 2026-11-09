/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * CLI of the micro-edit geometry (scratchbox_micro_edit.hpp): reads the primitive lines, writes mesh.bin and report.json
 * into the out dir. Prints {"ok":true,"parts":N} or {"ok":false,"error":...} and exits non-zero on failure.
 *
 *   micro_edit_build <input.txt> <outDir>
 *
 * Build:
 *   clang++ -std=c++20 -O3 -I packages/core/src/native/3d-engine/include scripts/micro_edit_build.cpp -o build/3d-native/micro_edit_build
 */

#include "scratchbox_micro_edit.hpp"

#include <filesystem>
#include <iostream>

int main(int argc, char** argv) {
    using namespace scratchbox::micro_edit;
    if (argc < 3) {
        std::cerr << "usage: micro_edit_build <input.txt> <outDir>\n";
        return 2;
    }
    try {
        std::ifstream in(argv[1]);
        if (!in) throw std::runtime_error(std::string("cannot read ") + argv[1]);
        const auto parts = build(in);
        std::filesystem::create_directories(argv[2]);
        write(parts, argv[2]);
        std::cout << "{\"ok\":true,\"parts\":" << parts.size() << "}\n";
        return 0;
    } catch (const std::exception& e) {
        std::cout << "{\"ok\":false,\"error\":" << jstr(e.what()) << "}\n";
        return 1;
    }
}
