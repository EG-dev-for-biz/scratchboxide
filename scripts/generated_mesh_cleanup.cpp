/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

// CLI for scratchbox_generated_cleanup.hpp, built and run by packages/core/src/node/3d-engine/generated-mesh-cleanup-service.ts.
//
// Input (--in): u32 V, u32 T, f32[3V] world-space positions, u32[3T] indices (the caller flattens the scene).
// Output: --out GLB (geometry only, material extras provenance "generated"), --quads-out an optional polygon dump
// ('SBQP' u32 V, u32 F, f32[3V], u32[F] degrees, u32[...] vertices) and one JSON line on stdout: the cleanup report
// with the topology (welded by position, and the result's own connectivity) and two-sided Hausdorff audits.
//
// Build: clang++ -std=c++20 -O3 -I packages/core/src/native/3d-engine/include scripts/generated_mesh_cleanup.cpp -o build/3d-native/generated_mesh_cleanup

#include "scratchbox_generated_cleanup.hpp"
#include "scratchbox_io.hpp"

#include <cstdio>
#include <fstream>
#include <iostream>
#include <stdexcept>
#include <string>

using namespace scratchbox;

namespace {

geometry::ScratchboxMesh readBin(const std::string& path) {
    std::ifstream f(path, std::ios::binary);
    if (!f) throw std::runtime_error("cannot open " + path);
    uint32_t V = 0, T = 0;
    f.read(reinterpret_cast<char*>(&V), 4);
    f.read(reinterpret_cast<char*>(&T), 4);
    if (!f || V == 0 || T == 0) throw std::runtime_error("empty or truncated mesh input");
    std::vector<float> pos(size_t(V) * 3);
    std::vector<uint32_t> idx(size_t(T) * 3);
    f.read(reinterpret_cast<char*>(pos.data()), std::streamsize(pos.size() * 4));
    f.read(reinterpret_cast<char*>(idx.data()), std::streamsize(idx.size() * 4));
    if (!f) throw std::runtime_error("truncated mesh input");
    geometry::ScratchboxMesh m("generated_source");
    m.vertices.resize(V);
    for (uint32_t i = 0; i < V; ++i) {
        if (!std::isfinite(pos[i * 3] + pos[i * 3 + 1] + pos[i * 3 + 2])) throw std::runtime_error("non-finite position");
        m.vertices[i].position = math::Vec3(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]);
    }
    for (uint32_t i : idx) if (i >= V) throw std::runtime_error("index out of range");
    m.indices = std::move(idx);
    m.recomputeNormals();
    m.recomputeBounds();
    return m;
}

std::string topoJson(const mesh_audit::TopologyReport& t) {
    std::ostringstream o;
    o << "{\"vertices\":" << t.vertices << ",\"triangles\":" << t.triangles << ",\"openEdges\":" << t.openEdges
      << ",\"nonManifoldEdges\":" << t.nonManifoldEdges << ",\"nonManifoldVertices\":" << t.nonManifoldVertices
      << ",\"misorientedEdges\":" << t.misorientedEdges << ",\"degenerateTriangles\":" << t.degenerateTriangles
      << ",\"components\":" << t.components << ",\"euler\":" << t.eulerCharacteristic << ",\"genus\":" << t.genus
      << ",\"watertight\":" << (t.watertight ? "true" : "false") << "}";
    return o.str();
}

std::string distJson(const mesh_audit::OneSidedDistance& d) {
    std::ostringstream o;
    o.precision(6);
    o << "{\"max\":" << d.max << ",\"mean\":" << d.mean << ",\"rms\":" << d.rms << ",\"p95\":" << d.p95 << ",\"samples\":" << d.samples << "}";
    return o.str();
}

}  // namespace

int main(int argc, char** argv) {
    std::string in, out, quadsOut;
    generated_cleanup::CleanupOptions opt;
    for (int i = 1; i < argc; ++i) {
        std::string a = argv[i];
        auto next = [&]() -> std::string { if (i + 1 >= argc) throw std::runtime_error("missing value for " + a); return argv[++i]; };
        if (a == "--in") in = next();
        else if (a == "--out") out = next();
        else if (a == "--quads-out") quadsOut = next();
        else if (a == "--quads") opt.targetQuads = std::stoul(next());
        else if (a == "--subdivisions") opt.subdivisions = std::stoi(next());
        else if (a == "--voxels-per-edge") opt.voxelsPerQuadEdge = std::stoi(next());
        else if (a == "--max-voxel-resolution") opt.maxVoxelResolution = std::stoi(next());
        else if (a == "--close-radius") opt.closeRadius = std::stoi(next());
        else if (a == "--project-factor") opt.projectDistanceFactor = std::stod(next());
        else if (a == "--crease") opt.creaseAngleDeg = std::stof(next());
        else if (a == "--threads") opt.threads = static_cast<unsigned>(std::stoul(next()));
        else throw std::runtime_error("unknown argument " + a);
    }
    try {
        if (in.empty() || out.empty()) throw std::runtime_error("usage: generated_mesh_cleanup --in mesh.bin --out result.glb [options]");
        auto source = readBin(in);
        double diag = mesh_audit::diagonalOf(source);
        auto before = mesh_audit::auditTopology(source, float(diag * 1e-7));
        auto res = generated_cleanup::cleanupGenerated(source, opt);
        if (!res.report.failure.empty()) {
            std::cout << "{\"ok\":false,\"report\":" << generated_cleanup::reportJson(res.report) << ",\"before\":" << topoJson(before) << "}" << std::endl;
            return 2;
        }
        auto after = mesh_audit::auditTopology(res.mesh, float(diag * 1e-7));
        auto afterIndexed = mesh_audit::auditTopology(res.mesh, -1.0f);  // the mesh's own connectivity, no weld
        auto h = mesh_audit::hausdorff(source, res.mesh, 200000);
        if (!io::GlbWriter::writeToFile(res.mesh, out)) throw std::runtime_error("cannot write " + out);
        if (!quadsOut.empty()) {
            std::ofstream q(quadsOut, std::ios::binary);
            const auto& p = res.quads;
            uint32_t V = uint32_t(p.positions.size()), F = uint32_t(p.faceCount());
            q.write("SBQP", 4);
            q.write(reinterpret_cast<const char*>(&V), 4);
            q.write(reinterpret_cast<const char*>(&F), 4);
            for (const auto& v : p.positions) { float xyz[3] = {v.x, v.y, v.z}; q.write(reinterpret_cast<const char*>(xyz), 12); }
            for (size_t f = 0; f < F; ++f) { uint32_t d = p.degree(f); q.write(reinterpret_cast<const char*>(&d), 4); }
            q.write(reinterpret_cast<const char*>(p.faceVerts.data()), std::streamsize(p.faceVerts.size() * 4));
        }
        std::ostringstream o;
        o.precision(6);
        o << "{\"ok\":true,\"report\":" << generated_cleanup::reportJson(res.report) << ",\"before\":" << topoJson(before)
          << ",\"after\":" << topoJson(after) << ",\"afterIndexed\":" << topoJson(afterIndexed) << ",\"hausdorff\":{\"max\":" << h.hausdorff << ",\"diagonal\":" << h.diagonal
          << ",\"resultToSource\":" << distJson(h.resultToSource) << ",\"sourceToResult\":" << distJson(h.sourceToResult) << "}}";
        std::cout << o.str() << std::endl;
        return 0;
    } catch (const std::exception& e) {
        std::cerr << "generated_mesh_cleanup: " << e.what() << std::endl;
        return 1;
    }
}
