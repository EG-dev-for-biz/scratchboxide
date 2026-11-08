/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * CLI of the measured procedural twin (scratchbox_measured_twin.hpp). Reads a line spec (file argument), writes the
 * GLB and the report, and prints the report ({"ok":true,...}; {"ok":false,"error":...} and a non-zero exit on failure).
 *
 * Directives (one per line; paths run to the end of the line):
 *   isolate <path>            the tree-free scan pipeline K rebuilt from (clay.glb)
 *   textured <path>           the scan with its photo texture (textured.glb), the elements' colour source
 *   out <path> / report <path>
 *   ground <y>                the street level (tile frame)
 *   footprint <n> x z ...     a footprint loop (tile x, z), repeated per loop
 *   scan <name> <value>       an analyseScan parameter (cell, modeMerge, minTierArea, minTierShare, maxTiers, simplifyTol, cleanRadius, squareDeg)
 *   param <name> <value>      a twin parameter (Params in the header)
 *   reveal <m> <label> <source...>  the openings' reveal depth, its provenance label and where it came from
 *   glass <roughness>
 *   class <name> <L> <a> <b> <roughness> <metallic> <tileM> <openings 0|1>   an appearance class, in order
 *   classnormal <i> <png> / classorm <i> <png>                               its library set's prepared maps
 *   plane <id> cx cy cz sx sy sz tx ty tz nx ny nz sMin tMax pixel w h        a plane photo's frame (tile frame)
 *   win <id> x0 y0 x1 y1 <generated 0|1> / pane <id> x0 y0 x1 y1 0           a kept window box / pane, the plane photo's pixels
 *
 * Build:
 *   clang++ -std=c++20 -O3 -I packages/core/src/native/3d-engine/include scripts/measured_twin.cpp -o build/3d-native/measured_twin -lz
 */

#include "scratchbox_measured_twin.hpp"

#include <fstream>
#include <iostream>

using namespace scratchbox::measured_twin;

int main(int argc, char** argv) {
    try {
        if (argc < 2) throw std::runtime_error("usage: measured_twin <spec>");
        std::ifstream in(argv[1]);
        if (!in) throw std::runtime_error(std::string("cannot read ") + argv[1]);
        const Spec S = parseSpec(in);
        Result R = build(S);
        const auto& F = R.frame;
        const std::string root = "{\"sb\":{\"schema\":\"scratchbox.measured-twin/1\",\"frame\":{\"ox\":" + detail::num(F.ox) + ",\"oz\":" + detail::num(F.oz) + ",\"theta\":" + detail::num(F.theta) + ",\"groundY\":" + detail::num(F.groundY) + "}}}";
        size_t triangles = 0;
        const auto glb = writeGlb(R.nodes, S.classes, S.glassRoughness, root, triangles);
        {
            std::ofstream o(S.out, std::ios::binary);
            if (!o) throw std::runtime_error("cannot write " + S.out);
            o.write(reinterpret_cast<const char*>(glb.data()), static_cast<std::streamsize>(glb.size()));
        }
        const std::string rep = reportJson(R.report, S, triangles, glb.size());
        if (!S.report.empty()) { std::ofstream o(S.report); o << rep; }
        std::cout << rep << std::endl;
        return 0;
    } catch (const std::exception& e) {
        std::string m = e.what();
        for (auto& c : m) if (c == '"' || c == '\\' || static_cast<unsigned char>(c) < 0x20) c = ' ';
        std::cout << "{\"ok\":false,\"error\":\"" << m << "\"}" << std::endl;
        return 1;
    }
}
