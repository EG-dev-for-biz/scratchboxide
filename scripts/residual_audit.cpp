/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * CLI of the residual audit (scratchbox_residual_audit.hpp): reads an input written by residual-audit.ts (the clean
 * solid's triangles, the candidate scan triangles and their photo colours), clusters and measures the candidates, and
 * writes the report JSON. Prints {"ok":true,...} or {"ok":false,"error":...} and exits non-zero on failure.
 *
 *   residual_audit <input.bin> <report.json> [param value]...
 *
 * Build:
 *   clang++ -std=c++20 -O3 -I packages/core/src/native/3d-engine/include scripts/residual_audit.cpp -o build/3d-native/residual_audit
 */

#include "scratchbox_residual_audit.hpp"

#include <fstream>
#include <iostream>

int main(int argc, char** argv) {
    using namespace scratchbox::residual_audit;
    if (argc < 3 || (argc - 3) % 2 != 0) {
        std::cerr << "usage: residual_audit <input.bin> <report.json> [param value]...\n";
        return 2;
    }
    try {
        Params p;
        for (int i = 3; i + 1 < argc; i += 2) {
            std::string k = argv[i];
            double v = std::stod(argv[i + 1]);
            if (k == "groundY") p.groundY = v;
            else if (k == "weldM") p.weldM = v;
            else if (k == "contactTol") p.contactTol = v;
            else if (k == "openBelowM") p.openBelowM = v;
            else if (k == "maxDropM") p.maxDropM = v;
            else if (k == "sliverQuality") p.sliverQuality = v;
            else if (k == "radialTol") p.radialTol = v;
            else if (k == "sliceStepM") p.sliceStepM = v;
            else if (k == "minClusterAreaM2") p.minClusterAreaM2 = v;
            else if (k == "copyReachM") p.copyReachM = v;
            else if (k == "copyParallel") p.copyParallel = v;
            else if (k == "copyMergeShare") p.copyMergeShare = v;
            else throw std::runtime_error("unknown param " + k);
        }
        ResidualAudit audit(readInput(argv[1]), p);
        audit.run();
        std::ofstream out(argv[2]);
        if (!out) throw std::runtime_error(std::string("cannot write ") + argv[2]);
        out << audit.reportJson();
        std::cout << "{\"ok\":true,\"clusters\":" << audit.clusters().size() << "}\n";
        return 0;
    } catch (const std::exception& e) {
        std::cout << "{\"ok\":false,\"error\":" << scratchbox::residual_audit::detail::jstr(e.what()) << "}\n";
        return 1;
    }
}
