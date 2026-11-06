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
 *                       [--tiles <tiles.txt>] [--adaptive-cap M] [--max-turn-deg D] [--no-adaptive] [--no-fill] [--no-caps] [--no-blend] [--no-zip] [--no-tone] [--audit-only]
 *
 * --tiles names each glTF node's source tile and its stated geometric error (a line "<nodes>", then one "<tile> <errorM>"
 * line per node, errorM <= 0 when unknown, optionally followed by the tile's box in the scan's frame: centre and three half-axes);
 * without it each node is its own tile and states no error.
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
#include <sstream>
#include <string>
#include <unordered_map>
#include <vector>

using scratchbox::tile_seam_weld::TileSeamWeld;
using scratchbox::tile_seam_weld::TileSeamWeldParams;
using scratchbox::tile_seam_weld::TileSeamCloseParams;
using scratchbox::tile_seam_weld::TileSeamAdaptiveParams;

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
        "  --contacts-csv F   write every welded position (x y z, tile frame) with its gap in metres, for inspection\n"
        "  --tiles F          each node's source tile and stated geometric error (see the header)\n"
        "  --adaptive-cap M   the adaptive close goes no further than M (default 0.30)\n"
        "  --max-turn-deg D   an adaptive close turning a triangle by more than D degrees is left to the strip fill (default 25)\n"
        "  --no-adaptive      no adaptive close (the fixed passes only)\n"
        "  --no-fill          no strip fill\n"
        "  --no-zip           leave the two tiles' rims at a cut where they are (needs boxes in the tiles file)\n"
        "  --no-blend         leave the step between two tiles' walls at their cut as it is (needs boxes in the tiles file)\n"
        "  --no-caps          keep the caps two tiles carry back to back in their shared cut plane (needs boxes in the tiles file)\n"
        "  --no-tone          do not level the tiles' photos' colour across their cuts (needs boxes in the tiles file)\n"
        "  --audit-only       measure the scan's seams and write the report; no pass runs\n";
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
    std::string input, out, outClay, statsPath, contactsCsv, tilesPath;
    TileSeamWeldParams p;
    TileSeamCloseParams cp;
    TileSeamAdaptiveParams ap;
    bool drop = true, trim = true, tjunctions = true, adaptive = true, fill = true, tone = true, caps = true, blend = true, zip = true, auditOnly = false;
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
        else if (a == "--tiles") tilesPath = next();
        else if (a == "--adaptive-cap") ap.capM = std::atof(next().c_str());
        else if (a == "--max-turn-deg") ap.maxTurnDeg = std::atof(next().c_str());
        else if (a == "--no-adaptive") adaptive = false;
        else if (a == "--no-fill") fill = false;
        else if (a == "--no-tone") tone = false;
        else if (a == "--no-caps") caps = false;
        else if (a == "--no-blend") blend = false;
        else if (a == "--no-zip") zip = false;
        else if (a == "--audit-only") auditOnly = true;
        else if (a == "--help" || a == "-h") { usage(); return 0; }
        else { std::cerr << "unknown argument " << a << "\n"; usage(); return 2; }
    }
    if (input.empty()) { usage(); return 2; }
    if (!(p.weldToleranceM > 0.0) || p.weldToleranceM > 1.0) { std::cerr << "--tolerance must be in (0, 1] metres\n"; return 2; }
    if (!drop) { p.sliverAspectMin = 1e300; p.dropStripPieces = false; }
    if (!(ap.capM > 0.0) || ap.capM > 1.0) { std::cerr << "--adaptive-cap must be in (0, 1] metres\n"; return 2; }
    if (!(ap.maxTurnDeg >= 0.0) || ap.maxTurnDeg > 180.0) { std::cerr << "--max-turn-deg must be in [0, 180]\n"; return 2; }

    const auto t0 = std::chrono::steady_clock::now();
    auto scene = scratchbox::gltf::GlbSceneReader::readFile(input);
    if (!scene.ok) { std::cerr << "tile_seam_weld: cannot read " << input << ": " << scene.error << "\n"; return 1; }
    const size_t inputTriangles = scene.mesh.indices.size() / 3;
    // each triangle's source tile: its node's, as the tiles file names it (else the node itself), and each tile's stated error
    std::vector<uint32_t> triTile(inputTriangles, 0);
    std::vector<double> tileError;
    std::vector<scratchbox::tile_seam_weld::TileBox> tileBox;   // by tile, when the tiles file gives boxes
    size_t nodesNamed = 0;
    {
        std::vector<uint32_t> nodeTile;
        std::vector<double> nodeError;
        if (!tilesPath.empty()) {
            std::ifstream tf(tilesPath);
            size_t n = 0;
            if (!(tf >> n)) { std::cerr << "tile_seam_weld: cannot read " << tilesPath << "\n"; return 1; }
            nodeTile.resize(n); nodeError.resize(n);
            std::string line;
            std::getline(tf, line);
            for (size_t i = 0; i < n; ++i) {
                if (!std::getline(tf, line)) { std::cerr << "tile_seam_weld: " << tilesPath << " is short\n"; return 1; }
                std::istringstream ls(line);
                if (!(ls >> nodeTile[i] >> nodeError[i])) { std::cerr << "tile_seam_weld: " << tilesPath << " line " << i + 2 << " is bad\n"; return 1; }
                double b[12];
                bool box = true;
                for (double& v : b) if (!(ls >> v)) { box = false; break; }
                if (!box) continue;
                if (tileBox.size() <= nodeTile[i]) tileBox.resize(static_cast<size_t>(nodeTile[i]) + 1);
                auto& tb = tileBox[nodeTile[i]];
                tb.c = {b[0], b[1], b[2]}; tb.h[0] = {b[3], b[4], b[5]}; tb.h[1] = {b[6], b[7], b[8]}; tb.h[2] = {b[9], b[10], b[11]}; tb.valid = true;
            }
            nodesNamed = n;
        }
        uint32_t maxTile = 0;
        for (size_t t = 0; t < inputTriangles; ++t) {
            const uint32_t node = t < scene.triangleNode.size() ? scene.triangleNode[t] : 0u;
            triTile[t] = node < nodeTile.size() ? nodeTile[node] : node;
            maxTile = std::max(maxTile, triTile[t]);
        }
        tileError.assign(static_cast<size_t>(maxTile) + 1, -1.0);
        for (size_t node = 0; node < nodeTile.size(); ++node) if (nodeTile[node] < tileError.size() && nodeError[node] > 0) tileError[nodeTile[node]] = nodeError[node];
    }
    size_t tilesWithError = 0;
    for (double e : tileError) if (e > 0) ++tilesWithError;
    const auto mask = TileSeamWeld::cutMask(scene.mesh);
    const auto auditBefore = TileSeamWeld::auditSeams(scene.mesh, triTile, mask, {});
    if (auditOnly) {
        std::string js = "{\"ok\": true, \"input\": \"" + input + "\", \"inputTriangles\": " + std::to_string(inputTriangles) + ", \"seamAudit\": {\"before\": {" + TileSeamWeld::auditJson(auditBefore) + "}}}\n";
        if (!statsPath.empty()) { std::ofstream st(statsPath); st << js; }
        std::cout << js;
        return 0;
    }
    const auto t1 = std::chrono::steady_clock::now();

    cp.toleranceM = p.weldToleranceM;
    cp.overlapToleranceM = overlapTol >= 0 ? overlapTol : p.weldToleranceM;
    cp.threads = p.threads;
    scratchbox::tile_seam_weld::TileSeamTrimStats trimStats;
    // the caps two tiles carry back to back in a shared cut plane, by the tiles' boxes
    scratchbox::tile_seam_weld::TileCapStats capStats;
    bool anyBox = false;
    for (const auto& b : tileBox) anyBox = anyBox || b.valid;
    // the per-cut scores as the scan came, after the caps go, after the step blend, and at the end
    scratchbox::tile_seam_weld::TileSeamBlendParams bp;
    bp.threads = p.threads;
    std::vector<scratchbox::tile_seam_weld::TileSeamCutScore> cutsRaw, cutsCapless, cutsBlended, cutsZipped, cutsFinal;
    if (anyBox) cutsRaw = TileSeamWeld::measureCuts(scene.mesh, triTile, tileBox, tileError, bp);
    if (caps && anyBox) { scratchbox::tile_seam_weld::TileCapParams kp; kp.threads = p.threads; capStats = TileSeamWeld::trimCapsByBox(scene.mesh, {&scene.triangleMaterial, &triTile}, triTile, tileBox, kp); }
    if (anyBox) cutsCapless = TileSeamWeld::measureCuts(scene.mesh, triTile, tileBox, tileError, bp);
    // each vertex's piece before any pass joins pieces or brings two onto the same points (the weld and the T-junction
    // closure tell pieces apart by it); the cap and overlap trims join nothing
    auto vertexPiece = TileSeamWeld::vertexPieces(scene.mesh);
    const bool movedOntoEachOther = (blend || zip) && anyBox;
    // the step between the two tiles' walls faded out either side of each cut
    scratchbox::tile_seam_weld::TileSeamBlendStats blendStats;
    if (blend && anyBox) { blendStats = TileSeamWeld::blendCutSteps(scene.mesh, triTile, tileBox, tileError, bp); cutsBlended = blendStats.after; }
    // the two rims at each cut brought onto one line, for the weld and the T-junction split below to join
    scratchbox::tile_seam_weld::TileSeamZipStats zipStats;
    if (zip && anyBox) { zipStats = TileSeamWeld::zipCutRims(scene.mesh, triTile, tileBox, tileError, bp); cutsZipped = zipStats.after; }
    if (trim) trimStats = TileSeamWeld::trimOverlaps(scene.mesh, {&scene.triangleMaterial, &triTile}, cp);
    // with neither pass, the pieces as the overlap trim leaves them (as before those passes existed)
    if (!movedOntoEachOther) vertexPiece = TileSeamWeld::vertexPieces(scene.mesh);
    std::vector<scratchbox::geometry::Vec3> before;
    if (!contactsCsv.empty()) { before.reserve(scene.mesh.vertices.size()); for (const auto& v : scene.mesh.vertices) before.push_back(v.position); }
    const auto r = TileSeamWeld::weldAndMarkSlivers(scene.mesh, p, movedOntoEachOther ? &vertexPiece : nullptr);
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
    TileSeamWeld::compactDropped(scene.mesh, r.keepTriangle, {&scene.triangleMaterial, &triTile});
    scratchbox::tile_seam_weld::TileSeamTJunctionStats tjStats;
    if (tjunctions) tjStats = TileSeamWeld::closeTJunctions(scene.mesh, {&scene.triangleMaterial, &triTile}, cp, &vertexPiece);
    // with the zip, the weld and the split again while they still join something: where four tiles meet, or a sliver lies
    // along a cut, the first pass pairs points two by two and leaves the pairs a few millimetres apart
    size_t reweldPasses = 0, reweldGroups = 0, reweldDropped = 0, reweldSplit = 0;
    if (zip && anyBox) for (int pass = 0; pass < 3; ++pass) {
        const auto r2 = TileSeamWeld::weldAndMarkSlivers(scene.mesh, p, &vertexPiece);
        if (!r2.ok || !r2.stats.groupsWelded) break;
        TileSeamWeld::compactDropped(scene.mesh, r2.keepTriangle, {&scene.triangleMaterial, &triTile});
        ++reweldPasses; reweldGroups += r2.stats.groupsWelded; reweldDropped += r2.stats.trianglesDropped;
        if (tjunctions) reweldSplit += TileSeamWeld::closeTJunctions(scene.mesh, {&scene.triangleMaterial, &triTile}, cp, &vertexPiece).closed;
    }
    const auto auditFixed = TileSeamWeld::auditSeams(scene.mesh, triTile, mask, {});
    const auto tFixed = std::chrono::steady_clock::now();
    // the adaptive close and the strip fill: tile by tile, up to the pair's stated error, where the surfaces agree
    ap.baseToleranceM = p.weldToleranceM;
    ap.threads = p.threads;
    scratchbox::tile_seam_weld::TileSeamAdaptiveStats adStats;
    if (adaptive) adStats = TileSeamWeld::closeAdaptive(scene.mesh, triTile, tileError, {&scene.triangleMaterial}, ap);
    const auto tAdaptive = std::chrono::steady_clock::now();
    scratchbox::tile_seam_weld::TileSeamFillStats fillStats;
    if (adaptive && fill) {
        size_t first = 0;
        fillStats = TileSeamWeld::fillStrips(scene.mesh, triTile, tileError, {&scene.triangleMaterial}, ap, &first);
        // the bridge is generated: each fill triangle drawn with a labelled copy of its tile's material
        std::unordered_map<uint32_t, uint32_t> fillMaterial;
        for (size_t t = first; t < scene.triangleMaterial.size(); ++t) {
            const uint32_t m = scene.triangleMaterial[t];
            auto it = fillMaterial.find(m);
            if (it == fillMaterial.end()) {
                auto copy = m < scene.materials.size() ? scene.materials[m] : scratchbox::gltf::SceneMaterial{};
                copy.photoInferredFill = true;
                copy.provenance = "generated";
                copy.method = "tile seam strip fill";
                scene.materials.push_back(copy);
                it = fillMaterial.emplace(m, static_cast<uint32_t>(scene.materials.size() - 1)).first;
            }
            scene.triangleMaterial[t] = it->second;
        }
    }
    const auto auditAfter = TileSeamWeld::auditSeams(scene.mesh, triTile, mask, {});
    if (anyBox) cutsFinal = TileSeamWeld::measureCuts(scene.mesh, triTile, tileBox, tileError, bp);
    const auto tFill = std::chrono::steady_clock::now();
    // the photos levelled toward each other across every cut two tiles' boxes share
    scratchbox::tile_seam_weld::TileSeamToneStats toneStats;
    size_t tilesBoxed = 0;
    for (const auto& b : tileBox) if (b.valid) ++tilesBoxed;
    if (tone && tilesBoxed) {
        scratchbox::tile_seam_weld::TileSeamToneParams tp;
        tp.threads = p.threads;
        toneStats = TileSeamWeld::featherSeamTone(scene, triTile, tileBox, tp);
        // the levelled photos carry what levelled them (the levels are fitted; the photo's detail stays the photo's)
        std::vector<uint8_t> levelled(scene.images.size(), 0);
        for (uint32_t i : toneStats.changedImages) levelled[i] = 1;
        for (auto& m : scene.materials)
            if (m.baseColorImage >= 0 && static_cast<size_t>(m.baseColorImage) < levelled.size() && levelled[static_cast<size_t>(m.baseColorImage)] && m.method.empty())
                m.method = "tile seam tone feather (fitted levels, generated)";
    }
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
        (caps && anyBox ? ", \"capTrim\": {\"sharedFaces\": " + std::to_string(capStats.sharedFaces) + ", \"candidates\": " + std::to_string(capStats.candidates) + ", \"trianglesDropped\": " + std::to_string(capStats.trianglesDropped) + ", \"areaM2\": " + std::to_string(capStats.areaM2) + "}" : std::string()) +
        (trim ? ", \"overlapTrim\": {" + TileSeamWeld::trimStatsJson(trimStats) + "}" : std::string()) +
        (tjunctions ? ", \"tJunctions\": {" + TileSeamWeld::tJunctionStatsJson(tjStats) + "}" : std::string()) +
        (adaptive ? ", \"adaptive\": {\"capM\": " + std::to_string(ap.capM) + ", " + TileSeamWeld::adaptiveStatsJson(adStats) + "}" : std::string()) +
        (adaptive && fill ? ", \"stripFill\": {" + TileSeamWeld::fillStatsJson(fillStats) + "}" : std::string()) +
        (tone && tilesBoxed ? ", \"tone\": {\"tilesBoxed\": " + std::to_string(tilesBoxed) + ", " + TileSeamWeld::toneStatsJson(toneStats) + "}" : std::string()) +
        (tilesBoxed ? ", \"cuts\": " + TileSeamWeld::cutsJson(tileBox) : std::string()) +
        (blend && anyBox ? ", \"stepBlend\": {\"cuts\": " + std::to_string(blendStats.cuts) + ", \"cutsMatched\": " + std::to_string(blendStats.cutsMatched) + ", \"positionsMoved\": " + std::to_string(blendStats.positionsMoved) +
            ", \"reverted\": " + std::to_string(blendStats.reverted) + ", \"maxMoveM\": " + std::to_string(blendStats.maxMoveM) + "}" : std::string()) +
        (zip && anyBox ? ", \"rimZip\": {" + TileSeamWeld::zipStatsJson(zipStats) + "}" : std::string()) +
        (zip && anyBox ? ", \"reweld\": {\"passes\": " + std::to_string(reweldPasses) + ", \"groupsWelded\": " + std::to_string(reweldGroups) + ", \"trianglesDropped\": " + std::to_string(reweldDropped) +
            ", \"tJunctionsClosed\": " + std::to_string(reweldSplit) + "}" : std::string()) +
        (anyBox ? ", \"cutScores\": {\"raw\": {" + TileSeamWeld::cutTotalsJson(cutsRaw) + "}, \"afterCaps\": {" + TileSeamWeld::cutTotalsJson(cutsCapless) + "}" +
            (blend ? ", \"afterBlend\": {" + TileSeamWeld::cutTotalsJson(cutsBlended) + "}" : std::string()) + (zip ? ", \"afterZip\": {" + TileSeamWeld::cutTotalsJson(cutsZipped) + "}" : std::string()) + ", \"final\": {" + TileSeamWeld::cutTotalsJson(cutsFinal) + "}" +
            ", \"perCutAfterCaps\": " + TileSeamWeld::cutScoresJson(cutsCapless) + ", \"perCutFinal\": " + TileSeamWeld::cutScoresJson(cutsFinal) + "}" : std::string()) +
        ", \"tiles\": {\"count\": " + std::to_string(auditBefore.tiles) + ", \"nodesNamed\": " + std::to_string(nodesNamed) + ", \"withStatedError\": " + std::to_string(tilesWithError) + "}" +
        ", \"seamAudit\": {\"before\": {" + TileSeamWeld::auditJson(auditBefore) + "}, \"afterFixed\": {" + TileSeamWeld::auditJson(auditFixed) + "}, \"after\": {" + TileSeamWeld::auditJson(auditAfter) + "}}" +
        ", \"ms\": {\"load\": " + std::to_string(ms(t0, t1)) + ", \"weld\": " + std::to_string(ms(t1, t2)) + ", \"fixed\": " + std::to_string(ms(t1, tFixed)) +
        ", \"adaptive\": " + std::to_string(ms(tFixed, tAdaptive)) + ", \"fill\": " + std::to_string(ms(tAdaptive, tFill)) + ", \"tone\": " + std::to_string(ms(tFill, t2)) + ", \"write\": " + std::to_string(ms(t2, t3)) + "}}\n";
    if (!statsPath.empty()) {
        std::ofstream s(statsPath);
        if (!s) { std::cerr << "tile_seam_weld: cannot write " << statsPath << "\n"; return 1; }
        s << js;
    }
    std::cout << js;
    return 0;
}
