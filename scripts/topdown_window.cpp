/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * CLI of scratchbox_topdown_window.hpp: the top-down height and photo colour of the tiles in a square around a point,
 * and the walls' direction there, for the footprint model.
 *   topdown_window <textured.glb> <x> <z> <halfM> <pixel> <wallRadiusM> <outDir>
 * Prints the window JSON ({"ok":true,...}) or {"ok":false,"error":...} and exits non-zero on failure.
 *
 * Build:
 *   clang++ -std=c++20 -O3 -pthread -I packages/core/src/native/3d-engine/include scripts/topdown_window.cpp \
 *       -o build/3d-native/topdown_window -lz
 */

#include "scratchbox_topdown_window.hpp"

#include <filesystem>
#include <iostream>

int main(int argc, char** argv) {
    using namespace scratchbox;
    if (argc < 8) {
        std::cerr << "usage: topdown_window <textured.glb> <x> <z> <halfM> <pixel> <wallRadiusM> <outDir>\n";
        return 2;
    }
    try {
        staged_massing::TileSource tile;
        std::string err;
        if (!tile.load(argv[1], err)) throw std::runtime_error("tile: " + err);
        std::filesystem::create_directories(argv[7]);
        const auto w = topdown_window::rasterise(tile, std::stod(argv[2]), std::stod(argv[3]), std::stod(argv[4]), std::stod(argv[5]), std::stod(argv[6]));
        const std::string js = topdown_window::write(w, argv[7]);
        std::cout << "{\"ok\":true," << js.substr(1) << "\n";
        return 0;
    } catch (const std::exception& e) {
        std::cout << "{\"ok\":false,\"error\":" << staged_massing::detail::jstr(e.what()) << "}\n";
        return 1;
    }
}
