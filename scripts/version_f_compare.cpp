/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * CLI of version F's render-compare kernel (scratchbox_version_f_compare.hpp): loads a session file (the seen walls'
 * evidence) and then answers batches of jobs from stdin on stdout, binary both ways, until stdin ends. One process serves a
 * whole adjustment (version-f/native-compare.ts); every batch is spread over the cores. On a bad session or request it
 * prints {"ok":false,"error":...} on stderr and exits non-zero.
 *
 * Build:
 *   clang++ -std=c++20 -O3 -pthread -I packages/core/src/native/3d-engine/include scripts/version_f_compare.cpp \
 *       -o build/3d-native/version_f_compare
 */

#include "scratchbox_version_f_compare.hpp"

#include <cstdio>
#include <fstream>
#include <iostream>

int main(int argc, char** argv) {
    using namespace scratchbox::version_f_compare;
    if (argc < 2) {
        std::cerr << "usage: version_f_compare <session.bin> [threads]\n";
        return 2;
    }
    try {
        std::ifstream in(argv[1], std::ios::binary);
        if (!in) throw std::runtime_error(std::string("cannot read ") + argv[1]);
        Session session(readSession(in), argc > 2 ? static_cast<unsigned>(std::max(1, std::atoi(argv[2]))) : 0u);
        std::fprintf(stderr, "{\"ok\":true,\"walls\":%zu,\"threads\":%u}\n", session.walls().size(), session.threads());
        std::fflush(stderr);
        std::vector<Job> jobs;
        while (readRequest(std::cin, jobs)) {
            const auto scores = session.evaluate(jobs);
            const auto bytes = encodeAnswer(jobs, scores);
            std::fwrite(bytes.data(), 1, bytes.size(), stdout);
            std::fflush(stdout);
        }
        return 0;
    } catch (const std::exception& e) {
        std::string msg = e.what();
        for (auto& c : msg) if (c == '"') c = '\'';
        std::fprintf(stderr, "{\"ok\":false,\"error\":\"%s\"}\n", msg.c_str());
        return 1;
    }
}
