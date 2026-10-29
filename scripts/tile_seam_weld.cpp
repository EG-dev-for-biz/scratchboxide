/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * tile_seam_weld: the tile-chunk seam weld pre-pass (scratchbox_tile_seam_weld.hpp) on its own, as a
 * small CLI driver. Reads a binary glTF scan, welds the boundary groups of adjacent pieces within a
 * metric tolerance, drops the slivers the weld collapses, and writes the result back as a textured
 * GLB (materials, UVs and images pass through) and/or a studio clay GLB, with a JSON stats report.
 *
 * tile_refine runs the same kernel in place as its first stage; this driver exists for measuring a
 * scan on its own (docs/processes/tile_seam_weld.md), for tests and for any caller that only wants
 * the weld (TileSeamWeldService, packages/core/src/node/3d-engine/tile-seam-weld-service.ts).
 *
 * Before the weld, the overlap trim (one surface kept where two pieces cover it); after it, the T-junction closure (a
 * border position on another piece's edge interior moved onto it and the edge split there). Both on unless switched off.
 *
 * usage: tile_seam_weld --input <scan.glb> [--out <welded.glb>] [--out-clay <welded_clay.glb>] [--stats <stats.json>]
 *                       [--tolerance M] [--no-drop] [--no-overlap-trim] [--no-tjunctions] [--threads N]
 */

#include "scratchbox_gltf_scene.hpp"
#include "scratchbox_photometric_relief.hpp"
#include "scratchbox_tile_seam_weld.hpp"

#include <chrono>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <fstream>
#include <iostream>
#include <string>
#include <unordered_map>
#include <vector>

using scratchbox::tile_seam_weld::TileSeamWeld;
using scratchbox::tile_seam_weld::TileSeamWeldParams;
using scratchbox::tile_seam_weld::TileSeamCloseParams;

static void usage() {
    std::cerr <<
        "usage: tile_seam_weld --input <scan.glb> [--out <welded.glb>] [--out-clay <clay.glb>] [--stats <stats.json>] [options]\n"
        "  --tolerance M      boundary groups of different pieces within M of each other are welded (default 0.03)\n"
        "  --no-drop          keep the triangles the weld collapses into slivers\n"
        "  --sliver-altitude-fraction F  a touched triangle is a sliver when its altitude is at most F x tolerance (default 0.5)\n"
        "  --no-overlap-trim  keep both surfaces where two pieces cover the same one\n"
        "  --overlap-tolerance M  a border triangle within M of a lower piece's surface everywhere is an overlap (default: the tolerance)\n"
        "  --no-tjunctions    leave border positions lying on another piece's edge interior as they are\n"
        "  --threads N        worker threads (default: all cores)\n"
        "  --contacts-csv F   write every welded position (x y z, tile frame) with its gap in metres, for inspection\n";
}

/** The scene's mesh as the GLB writers take it: positions welded on bit-identical float3 (as tile_refine's own pass-through). */
static scratchbox::photometric_relief::ReliefMesh toReliefMesh(const scratchbox::gltf::GltfScene& scene) {
    scratchbox::photometric_relief::ReliefMesh m;
    const auto& verts = scene.mesh.vertices;
    std::unordered_map<uint64_t, uint32_t> weld;
    std::vector<uint32_t> map(verts.size(), UINT32_MAX);
    auto id = [&](uint32_t v) {
        if (map[v] != UINT32_MAX) return map[v];
        const auto& p = verts[v].position;
        uint32_t bx, by, bz;
        std::memcpy(&bx, &p.x, 4); std::memcpy(&by, &p.y, 4); std::memcpy(&bz, &p.z, 4);
        const uint64_t k = (static_cast<uint64_t>(bx) * 0x9E3779B97F4A7C15ull) ^ (static_cast<uint64_t>(by) * 0xC2B2AE3D27D4EB4Full) ^ (static_cast<uint64_t>(bz) << 1);
        auto it = weld.find(k);
        if (it == weld.end()) {
            it = weld.emplace(k, static_cast<uint32_t>(m.positions.size())).first;
            m.positions.push_back(scratchbox::photometric_relief::P3(p.x, p.y, p.z));
            m.heights.push_back(0.0f);
            m.positionRegion.push_back(-1);
        }
        return map[v] = it->second;
    };
    const auto& idx = scene.mesh.indices;
    for (size_t t = 0; t < idx.size() / 3; ++t) {
        scratchbox::photometric_relief::OutputTriangle o;
        for (int k = 0; k < 3; ++k) {
            const uint32_t v = idx[3 * t + k];
            o.p[k] = id(v);
            o.uv[k][0] = verts[v].uv.x;
            o.uv[k][1] = verts[v].uv.y;
        }
        o.material = t < scene.triangleMaterial.size() ? scene.triangleMaterial[t] : 0u;
        o.region = -1;
        o.parent = static_cast<uint32_t>(t);
        m.triangles.push_back(o);
    }
    return m;
}

static bool writeBytes(const std::string& file, const std::vector<uint8_t>& bytes) {
    std::ofstream out(file, std::ios::binary);
    if (!out) return false;
    out.write(reinterpret_cast<const char*>(bytes.data()), static_cast<std::streamsize>(bytes.size()));
    return static_cast<bool>(out);
}

int main(int argc, char** argv) {
    std::string input, out, outClay, statsPath, contactsCsv;
    TileSeamWeldParams p;
    TileSeamCloseParams cp;
    bool drop = true, trim = true, tjunctions = true;
    double overlapTol = -1;
    for (int i = 1; i < argc; ++i) {
        const std::string a = argv[i];
        auto next = [&]() -> std::string { if (i + 1 >= argc) { usage(); std::exit(2); } return argv[++i]; };
        if (a == "--input") input = next();
        else if (a == "--out") out = next();
        else if (a == "--out-clay") outClay = next();
        else if (a == "--stats") statsPath = next();
        else if (a == "--tolerance") p.weldToleranceM = std::atof(next().c_str());
        else if (a == "--no-drop") drop = false;
        else if (a == "--sliver-altitude-fraction") p.sliverAltitudeFraction = std::atof(next().c_str());
        else if (a == "--threads") p.threads = std::atoi(next().c_str());
        else if (a == "--no-overlap-trim") trim = false;
        else if (a == "--overlap-tolerance") overlapTol = std::atof(next().c_str());
        else if (a == "--no-tjunctions") tjunctions = false;
        else if (a == "--contacts-csv") contactsCsv = next();
        else if (a == "--help" || a == "-h") { usage(); return 0; }
        else { std::cerr << "unknown argument " << a << "\n"; usage(); return 2; }
    }
    if (input.empty()) { usage(); return 2; }
    if (!(p.weldToleranceM > 0.0) || p.weldToleranceM > 1.0) { std::cerr << "--tolerance must be in (0, 1] metres\n"; return 2; }
    if (!drop) { p.sliverAspectMin = 1e300; p.dropStripPieces = false; }

    const auto t0 = std::chrono::steady_clock::now();
    auto scene = scratchbox::gltf::GlbSceneReader::readFile(input);
    if (!scene.ok) { std::cerr << "tile_seam_weld: cannot read " << input << ": " << scene.error << "\n"; return 1; }
    const size_t inputTriangles = scene.mesh.indices.size() / 3;
    const auto t1 = std::chrono::steady_clock::now();

    cp.toleranceM = p.weldToleranceM;
    cp.overlapToleranceM = overlapTol >= 0 ? overlapTol : p.weldToleranceM;
    cp.threads = p.threads;
    scratchbox::tile_seam_weld::TileSeamTrimStats trimStats;
    if (trim) trimStats = TileSeamWeld::trimOverlaps(scene.mesh, {&scene.triangleMaterial}, cp);
    // each vertex's piece before the weld joins pieces (the T-junction closure tells pieces apart by it); the trim joins nothing
    auto vertexPiece = TileSeamWeld::vertexPieces(scene.mesh);
    std::vector<scratchbox::geometry::Vec3> before;
    if (!contactsCsv.empty()) { before.reserve(scene.mesh.vertices.size()); for (const auto& v : scene.mesh.vertices) before.push_back(v.position); }
    const auto r = TileSeamWeld::weldAndMarkSlivers(scene.mesh, p);
    if (!r.ok) { std::cerr << "tile_seam_weld: " << r.error << "\n"; return 1; }
    if (!contactsCsv.empty()) {
        std::ofstream c(contactsCsv);
        if (!c) { std::cerr << "tile_seam_weld: cannot write " << contactsCsv << "\n"; return 1; }
        c << "x,y,z,gap_m\n";
        for (size_t v = 0; v < before.size(); ++v) {
            const auto& a = before[v]; const auto& b = scene.mesh.vertices[v].position;
            const double d = std::sqrt(double(a.x - b.x) * (a.x - b.x) + double(a.y - b.y) * (a.y - b.y) + double(a.z - b.z) * (a.z - b.z));
            if (d > 1e-9) c << a.x << ',' << a.y << ',' << a.z << ',' << d << '\n';
        }
    }
    TileSeamWeld::compactDropped(scene.mesh, r.keepTriangle, {&scene.triangleMaterial});
    scratchbox::tile_seam_weld::TileSeamTJunctionStats tjStats;
    if (tjunctions) tjStats = TileSeamWeld::closeTJunctions(scene.mesh, {&scene.triangleMaterial}, cp, &vertexPiece);
    const auto t2 = std::chrono::steady_clock::now();

    const double creaseDeg = 30.0;
    size_t outputTriangles = scene.mesh.indices.size() / 3;
    if (!out.empty() || !outClay.empty()) {
        const auto mesh = toReliefMesh(scene);
        outputTriangles = mesh.triangles.size();
        if (!out.empty() && !writeBytes(out, scratchbox::photometric_relief::PhotometricRelief::writeTexturedGlb(scene, mesh, creaseDeg))) {
            std::cerr << "tile_seam_weld: cannot write " << out << "\n"; return 1;
        }
        if (!outClay.empty() && !writeBytes(outClay, scratchbox::photometric_relief::PhotometricRelief::writeClayGlb(mesh, creaseDeg, "TileSeamWeld_StudioGreyClay"))) {
            std::cerr << "tile_seam_weld: cannot write " << outClay << "\n"; return 1;
        }
    }
    const auto t3 = std::chrono::steady_clock::now();
    auto ms = [](auto a, auto b) { return std::chrono::duration<double, std::milli>(b - a).count(); };

    std::string js = "{\"ok\": true, \"input\": \"" + input + "\", \"inputTriangles\": " + std::to_string(inputTriangles) +
        ", \"outputTriangles\": " + std::to_string(outputTriangles) + ", \"toleranceM\": " + std::to_string(p.weldToleranceM) +
        ", \"dropSlivers\": " + (drop ? "true" : "false") + ", \"seamWeld\": {" + TileSeamWeld::statsJson(r.stats) + "}" +
        (trim ? ", \"overlapTrim\": {" + TileSeamWeld::trimStatsJson(trimStats) + "}" : std::string()) +
        (tjunctions ? ", \"tJunctions\": {" + TileSeamWeld::tJunctionStatsJson(tjStats) + "}" : std::string()) +
        ", \"ms\": {\"load\": " + std::to_string(ms(t0, t1)) + ", \"weld\": " + std::to_string(ms(t1, t2)) + ", \"write\": " + std::to_string(ms(t2, t3)) + "}}\n";
    if (!statsPath.empty()) {
        std::ofstream s(statsPath);
        if (!s) { std::cerr << "tile_seam_weld: cannot write " << statsPath << "\n"; return 1; }
        s << js;
    }
    std::cout << js;
    return 0;
}
