/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * CLI of the revolution fit (scratchbox_revolution_fit.hpp): reads an SBRV triangle file, finds the parts of it that
 * are solids of revolution about a vertical axis, fits and rebuilds them, and writes report.json and mesh.bin into the
 * out dir. Prints {"ok":true,...} or {"ok":false,"error":...} and exits non-zero on failure.
 *
 *   revolution_fit <input.sbrv> <outDir> [key=value ...]
 *
 * Build:
 *   clang++ -std=c++20 -O3 -I packages/core/src/native/3d-engine/include scripts/revolution_fit.cpp -o build/3d-native/revolution_fit
 */

#include "scratchbox_revolution_fit.hpp"

#include <filesystem>
#include <iostream>

int main(int argc, char** argv) {
    using namespace scratchbox::revolution_fit;
    if (argc < 3) {
        std::cerr << "usage: revolution_fit <input.sbrv> <outDir> [key=value ...]\n";
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
        RevolutionFit fit(readInput(argv[1]), p);
        fit.run();
        {
            std::ofstream r(out + "/report.json");
            r << fit.reportJson();
        }
        fit.writeMesh(out + "/mesh.bin");
        int accepted = 0;
        for (const auto& r : fit.revolutions()) accepted += r.accepted ? 1 : 0;
        std::cout << "{\"ok\":true,\"candidates\":" << fit.revolutions().size() << ",\"accepted\":" << accepted << "}\n";
        return 0;
    } catch (const std::exception& e) {
        std::cout << "{\"ok\":false,\"error\":" << scratchbox::revolution_fit::detail::jstr(e.what()) << "}\n";
        return 1;
    }
}
