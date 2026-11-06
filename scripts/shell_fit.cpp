/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * CLI of the shell fit (scratchbox_shell_fit.hpp, a prototype): reads one isolated structure's welded scan, solves the
 * closed shell and writes it with its provenance, the scan the shell does not explain, and the measurements.
 *
 *   shell_fit --input <scan.glb> [--out-shell <shell.glb>] [--out-combined <shell_and_residual.glb>]
 *             [--out-residual <residual.glb>] [--report <report.json>] [--ground-y <metres>] [--threads <n>]
 *             [--no-skin] [--set <param> <value>]... [--compare <other.glb>] [--cells <cells.csv>]
 *
 * `--compare` measures another model of the same structure in the same frame (e.g. the pipeline's finished clay) by the
 * same yardstick: the skin's distance to it and its open edges, in the report's `compare`.
 *
 * The GLBs are staged-layer GLBs: the nodes `shell_measured` and `shell_generated` (the shell's triangles by label; their
 * positions are equal where they meet, so welding by position gives the closed mesh back) and `residual_scan`. The root
 * extras hold `shellFit`: the measurements and one row per shell face (plane, area, support share, label, node and
 * triangle range). Prints {"ok":true,...} with the report's path, or {"ok":false,"error":...} and exits non-zero.
 *
 * Build:
 *   clang++ -std=c++20 -O3 -I packages/core/src/native/3d-engine/include scripts/shell_fit.cpp -o build/3d-native/shell_fit
 */

#include "scratchbox_gltf_scene.hpp"
#include "scratchbox_shell_fit.hpp"
#include "scratchbox_staged_glb.hpp"

#include <fstream>
#include <iostream>
#include <string>
#include <vector>

namespace sf = scratchbox::shell_fit;
namespace sg = scratchbox::staged_glb;
using scratchbox::math::Vec3;

static bool writeBytes(const std::string& path, const std::vector<uint8_t>& bytes) {
    std::ofstream out(path, std::ios::binary);
    if (!out) return false;
    out.write(reinterpret_cast<const char*>(bytes.data()), static_cast<std::streamsize>(bytes.size()));
    return static_cast<bool>(out);
}

static std::string metricsJson(const sf::Metrics& m, const sf::Params& p) {
    sg::json::Object o;
    o.i("inputTriangles", static_cast<long long>(m.inputTriangles)).i("skinTriangles", static_cast<long long>(m.skinTriangles))
        .i("hiddenTriangles", static_cast<long long>(m.hiddenTriangles)).i("apronTriangles", static_cast<long long>(m.apronTriangles))
        .n("skinAreaM2", m.skinAreaM2).n("hiddenAreaM2", m.hiddenAreaM2).n("apronAreaM2", m.apronAreaM2).n("groundY", m.groundY)
        .i("planesFitted", static_cast<long long>(m.planesFitted)).i("planesKept", static_cast<long long>(m.planesKept))
        .i("planesRejected", static_cast<long long>(m.planesRejected)).n("rejectedAreaM2", m.rejectedAreaM2)
        .n("planeAssignedAreaShare", m.planeAssignedAreaShare)
        .i("supportCells", static_cast<long long>(m.supportCells)).i("refineSplits", static_cast<long long>(m.refineSplits)).i("separatorPlanes", static_cast<long long>(m.separatorPlanes))
        .i("cells", static_cast<long long>(m.cells)).i("insideCells", static_cast<long long>(m.insideCells)).i("interfaces", static_cast<long long>(m.interfaces))
        .i("pocketsFilled", static_cast<long long>(m.pocketsFilled)).i("componentsDropped", static_cast<long long>(m.componentsDropped))
        .i("shellTriangles", static_cast<long long>(m.shellTriangles)).i("shellVertices", static_cast<long long>(m.shellVertices)).i("shellFaces", static_cast<long long>(m.shellFaces))
        .i("boundaryEdges", static_cast<long long>(m.boundaryEdges)).i("nonManifoldEdges", static_cast<long long>(m.nonManifoldEdges))
        .i("degenerateTriangles", static_cast<long long>(m.degenerateTriangles)).i("tJunctionsClosed", static_cast<long long>(m.tJunctionsClosed))
        .n("shellAreaM2", m.shellAreaM2).n("shellVolumeM3", m.shellVolumeM3)
        .n("generatedAreaM2", m.generatedAreaM2).n("generatedAreaShare", m.generatedAreaShare)
        .n("unsupportedAreaM2", m.unsupportedAreaM2).n("unsupportedAreaShare", m.unsupportedAreaShare)
        .n("groundClosureAreaM2", m.groundClosureAreaM2)
        .n("scanWithin05Share", m.scanWithin05Share).n("scanWithin15Share", m.scanWithin15Share)
        .n("scanRmsM", m.scanRmsM).n("scanP95M", m.scanP95M).n("scanMaxM", m.scanMaxM)
        .n("explainedRmsM", m.explainedRmsM).n("explainedAreaShare", m.explainedAreaShare)
        .n("residualAreaM2", m.residualAreaM2).n("residualAreaShare", m.residualAreaShare).i("residualTriangles", static_cast<long long>(m.residualTriangles))
        .n("buriedAreaM2", m.buriedAreaM2).n("buriedAreaShare", m.buriedAreaShare);
    sg::json::Object ms;
    ms.n("skin", m.msSkin).n("planes", m.msPlanes).n("cells", m.msCells).n("labels", m.msLabels).n("shell", m.msShell).n("residual", m.msResidual).n("total", m.msTotal);
    o.raw("ms", ms.text());
    sg::json::Object tol;
    tol.n("supportTolM", p.supportTolM).n("measuredShare", p.measuredShare).n("residualTolM", p.residualTolM).n("growDistM", p.growDistM)
        .n("minNormalResultant", p.minNormalResultant).n("maxPlaneRmsM", p.maxPlaneRmsM)
        .n("minPlaneAreaM2", p.minPlaneAreaM2).i("maxPlanes", p.maxPlanes).n("minSplitAreaM2", p.minSplitAreaM2)
        .n("unaryWeight", p.unaryWeight).n("unsupportedCutCost", p.unsupportedCutCost).n("supportedCutCost", p.supportedCutCost);
    o.raw("params", tol.text());
    return o.text();
}

int main(int argc, char** argv) {
    std::string input, outShell, outCombined, outResidual, reportPath, comparePath, cellsPath;
    sf::Params p;
    try {
        for (int i = 1; i < argc; ++i) {
            const std::string a = argv[i];
            auto next = [&]() -> std::string { if (i + 1 >= argc) throw std::runtime_error("missing value after " + a); return argv[++i]; };
            if (a == "--input") input = next();
            else if (a == "--out-shell") outShell = next();
            else if (a == "--out-combined") outCombined = next();
            else if (a == "--out-residual") outResidual = next();
            else if (a == "--report") reportPath = next();
            else if (a == "--compare") comparePath = next();
            else if (a == "--cells") cellsPath = next();
            else if (a == "--ground-y") p.groundY = std::stod(next());
            else if (a == "--threads") p.threads = std::stoi(next());
            else if (a == "--no-skin") p.skinOnly = false;
            else if (a == "--set") {
                const std::string k = next();
                const double v = std::stod(next());
                if (k == "groundBandM") p.groundBandM = v;
                else if (k == "growAngleDeg") p.growAngleDeg = v;
                else if (k == "growDistM") p.growDistM = v;
                else if (k == "mergeAngleDeg") p.mergeAngleDeg = v;
                else if (k == "mergeDistM") p.mergeDistM = v;
                else if (k == "snapDeg") p.snapDeg = v;
                else if (k == "alignDeg") p.alignDeg = v;
                else if (k == "minPlaneAreaM2") p.minPlaneAreaM2 = v;
                else if (k == "minNormalResultant") p.minNormalResultant = v;
                else if (k == "maxPlaneRmsM") p.maxPlaneRmsM = v;
                else if (k == "maxPlanes") p.maxPlanes = static_cast<int>(v);
                else if (k == "minSplitAreaM2") p.minSplitAreaM2 = v;
                else if (k == "marginM") p.marginM = v;
                else if (k == "supportTolM") p.supportTolM = v;
                else if (k == "measuredShare") p.measuredShare = v;
                else if (k == "residualTolM") p.residualTolM = v;
                else if (k == "voteDirs") p.voteDirs = static_cast<int>(v);
                else if (k == "unaryWeight") p.unaryWeight = v;
                else if (k == "unsupportedCutCost") p.unsupportedCutCost = v;
                else if (k == "supportedCutCost") p.supportedCutCost = v;
                else if (k == "minComponentM3") p.minComponentM3 = v;
                else if (k == "refineRounds") p.refineRounds = static_cast<int>(v);
                else if (k == "refineMinorityShare") p.refineMinorityShare = v;
                else if (k == "refineMinVolumeM3") p.refineMinVolumeM3 = v;
                else throw std::runtime_error("unknown parameter " + k);
            } else throw std::runtime_error("unknown argument " + a);
        }
        if (input.empty()) throw std::runtime_error("usage: shell_fit --input <scan.glb> [--out-shell <glb>] [--out-combined <glb>] [--out-residual <glb>] [--report <json>] [--ground-y <m>] [--set <param> <value>]...");

        auto scene = scratchbox::gltf::GlbSceneReader::readFile(input);
        if (!scene.ok) throw std::runtime_error("cannot read " + input + ": " + scene.error);
        sf::Input in;
        in.positions.reserve(scene.mesh.vertices.size());
        for (const auto& v : scene.mesh.vertices) in.positions.emplace_back(v.position.x, v.position.y, v.position.z);
        in.indices = scene.mesh.indices;

        const sf::Result r = sf::ShellFit::solve(in, p);
        const sf::Metrics& m = r.metrics;
        if (!cellsPath.empty()) {
            // every cell of the partition, for inspection: where it is, how large, how its rays voted, its label
            std::ofstream cs(cellsPath);
            cs << "inside,pIn,volumeM3,surfaceM2,cx,cy,cz,x0,y0,z0,x1,y1,z1\n";
            for (const auto& c : r.cells) cs << (c.inside ? 1 : 0) << ',' << c.pIn << ',' << c.volume << ',' << c.surface << ',' << c.centroid.x << ',' << c.centroid.y << ',' << c.centroid.z << ','
                                             << c.lo.x << ',' << c.lo.y << ',' << c.lo.z << ',' << c.hi.x << ',' << c.hi.y << ',' << c.hi.z << "\n";
        }

        // the shell's triangles by label, flat-shaded (each triangle its own corners, at the welded positions)
        struct Part { sg::StagedPrimitive prim; double area{0}, supportArea{0}; };
        Part parts[2];   // 0 measured, 1 generated
        std::vector<std::string> faceRows;
        for (const auto& f : r.faces) {
            Part& part = parts[f.measured ? 0 : 1];
            const uint32_t first = static_cast<uint32_t>(part.prim.indices.size() / 3);
            const Vec3 n(static_cast<float>(f.normal.x), static_cast<float>(f.normal.y), static_cast<float>(f.normal.z));
            for (uint32_t t = f.firstTriangle; t < f.firstTriangle + f.triangleCount; ++t) {
                for (int k = 0; k < 3; ++k) {
                    const sf::V3& q = r.shellPositions[r.shellIndices[t * 3 + static_cast<uint32_t>(k)]];
                    part.prim.indices.push_back(static_cast<uint32_t>(part.prim.positions.size()));
                    part.prim.positions.emplace_back(static_cast<float>(q.x), static_cast<float>(q.y), static_cast<float>(q.z));
                    part.prim.normals.push_back(n);
                }
            }
            part.area += f.areaM2; part.supportArea += f.areaM2 * f.supportShare;
            sg::json::Object row;
            row.raw("plane", "[" + sg::json::num(f.normal.x) + "," + sg::json::num(f.normal.y) + "," + sg::json::num(f.normal.z) + "," + sg::json::num(f.d) + "]")
                .n("areaM2", f.areaM2).n("supportShare", f.supportShare).s("label", f.measured ? "measured" : "generated")
                .s("node", f.measured ? "shell_measured" : "shell_generated").i("firstTriangle", first).i("triangleCount", f.triangleCount);
            if (!f.measured) row.s("reason", f.groundClosure ? "the floor at the ground datum: the scan is open at the bottom" : "no scan within the support tolerance of most of this face: the solver closed a gap");
            faceRows.push_back(row.text());
        }
        sg::StagedPrimitive residual;
        for (size_t i = 0; i < r.residualTriangles.size(); ++i) {
            const uint32_t t = r.residualTriangles[i];
            const int order[3] = {0, r.residualFlipped[i] ? 2 : 1, r.residualFlipped[i] ? 1 : 2};
            for (int k : order) {
                const sf::V3& q = in.positions[in.indices[t * 3 + static_cast<uint32_t>(k)]];
                residual.indices.push_back(static_cast<uint32_t>(residual.positions.size()));
                residual.positions.emplace_back(static_cast<float>(q.x), static_cast<float>(q.y), static_cast<float>(q.z));
            }
        }

        const std::string mjson = metricsJson(m, p);
        auto build = [&](bool shell, bool resid) {
            std::vector<sg::StagedNode> nodes;
            const long long count = (shell ? (parts[0].prim.indices.empty() ? 0 : 1) + (parts[1].prim.indices.empty() ? 0 : 1) : 0) + (resid && !residual.indices.empty() ? 1 : 0);
            long long order = 0;
            auto add = [&](const std::string& name, const sg::StagedPrimitive& prim, const std::string& label, bool measured, const std::string& method, double confidence, const std::string& note) {
                if (prim.indices.empty()) return;
                sg::NodeExtras ne;
                ne.stage = "shell-fit";
                ne.provenance.label = label; ne.provenance.measuredGeometry = measured; ne.provenance.method = method;
                ne.provenance.sources.push_back({"scan", input, "the isolated structure's welded scan"});
                ne.provenance.confidence = confidence; ne.provenance.note = note;
                ne.buildOrder = order++; ne.buildCount = count;
                ne.vertices = static_cast<long long>(prim.positions.size()); ne.triangles = static_cast<long long>(prim.indices.size() / 3);
                sg::StagedNode node; node.name = name; node.primitives.push_back(prim); node.extrasJson = ne.toJson();
                nodes.push_back(std::move(node));
            };
            if (shell) {
                add("shell_measured", parts[0].prim, "measured", true, "shell-fit: plane fitted to the scan, face supported by scan within the tolerance",
                    parts[0].area > 0 ? parts[0].supportArea / parts[0].area : 0.0, "each face's support share is in the root extras (shellFit.faces)");
                add("shell_generated", parts[1].prim, "generated", false, "shell-fit: face closing the solid where no scan lies within the tolerance",
                    0.5, "the solver closed a gap by the smallest unsupported area between its cells (and the floor at the ground datum); not a measurement");
            }
            if (resid) add("residual_scan", residual, "measured", true, "shell-fit: scan triangles farther than the residual tolerance from the shell, kept as scanned", 1.0, "what the planes do not explain");
            sg::WriteOptions opt;
            opt.generator = "Scratchbox shell fit (prototype)";
            opt.rootName = "shell_fit";
            opt.rootExtrasJson = sg::rootExtrasJson("shell-fit", "shell-fit/1", "tile", std::string(), "\"shellFit\":{\"metrics\":" + mjson + ",\"faces\":" + sg::json::array(faceRows) + "}");
            return sg::write(nodes, opt);
        };
        if (!outShell.empty() && !writeBytes(outShell, build(true, false))) throw std::runtime_error("cannot write " + outShell);
        if (!outCombined.empty() && !writeBytes(outCombined, build(true, true))) throw std::runtime_error("cannot write " + outCombined);
        if (!outResidual.empty() && !residual.indices.empty() && !writeBytes(outResidual, build(false, true))) throw std::runtime_error("cannot write " + outResidual);
        std::string compare;
        if (!comparePath.empty()) {
            auto other = scratchbox::gltf::GlbSceneReader::readFile(comparePath);
            if (!other.ok) throw std::runtime_error("cannot read " + comparePath + ": " + other.error);
            sf::Input oin;
            for (const auto& v : other.mesh.vertices) oin.positions.emplace_back(v.position.x, v.position.y, v.position.z);
            oin.indices = other.mesh.indices;
            const sf::CompareStats c = sf::compareMesh(in, r.skinTriangles, oin, p.threads);
            sg::json::Object o;
            o.s("path", comparePath).i("triangles", static_cast<long long>(c.triangles)).n("areaM2", c.areaM2)
                .i("boundaryEdges", static_cast<long long>(c.boundaryEdges)).i("nonManifoldEdges", static_cast<long long>(c.nonManifoldEdges))
                .n("scanWithin05Share", c.scanWithin05Share).n("scanWithin15Share", c.scanWithin15Share).n("scanRmsM", c.scanRmsM).n("scanP95M", c.scanP95M);
            compare = ",\"compare\":" + o.text();
        }
        std::vector<std::string> candidateRows;
        for (const auto& c : r.planeCandidates) {
            sg::json::Object row;
            row.raw("normal", "[" + sg::json::num(c.n.x) + "," + sg::json::num(c.n.y) + "," + sg::json::num(c.n.z) + "]")
                .raw("centroid", "[" + sg::json::num(c.o.x) + "," + sg::json::num(c.o.y) + "," + sg::json::num(c.o.z) + "]")
                .n("areaM2", c.areaM2).n("normalResultant", c.normalResultant).n("rmsM", c.rmsM).b("rejected", c.rejected);
            candidateRows.push_back(row.text());
        }
        const std::string report = "{\"ok\":true,\"version\":\"shell-fit/1\",\"input\":" + sg::json::str(input) + ",\"metrics\":" + mjson + compare + ",\"faces\":" + sg::json::array(faceRows) + ",\"planeCandidates\":" + sg::json::array(candidateRows) + "}\n";
        if (!reportPath.empty()) {
            std::ofstream out(reportPath);
            if (!out) throw std::runtime_error("cannot write " + reportPath);
            out << report;
        }
        std::cout << "{\"ok\":true,\"metrics\":" << mjson << "}\n";
        return 0;
    } catch (const std::exception& e) {
        std::cout << "{\"ok\":false,\"error\":" << sg::json::str(e.what()) << "}\n";
        return 1;
    }
}
