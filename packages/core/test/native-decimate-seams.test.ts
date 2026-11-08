/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * QEM decimation (processing::QuadricDecimator, the one path behind lod::buildLodPyramid, the Nanite DAG and
 * halfedge::decimateMeshQEM) on a real building:
 * - SCRATCHBOX_DECIMATE_REAL_GLB: a cached Pipeline K twin (a staged-location run's textures/<key>/twin.glb, e.g. one of
 *   the 2026-11-06 benchmark buildings; gitignored real data). Its LOD pyramid reaches every level's count, opens no
 *   seams (fewer open edges than the input at every level), keeps the input surface within 5 cm RMS at half and within
 *   1.5 m RMS at an eighth (measured from 100k samples on the input), and is ordered for the vertex cache (ACMR under
 *   1.8); the Nanite DAG's root (one cluster of ~128 triangles once every merge reaches its half) stays within 8% of
 *   the diagonal RMS; the LOD GLB has glTF magic.
 *   Measured before/after on real buildings in the PR (the old QEM: 44-201 cm RMS from half to an eighth on twins).
 * - SCRATCHBOX_DECIMATE_REAL_TILE: a raw 3D Tiles extraction (a staged-location run's tiles/<key>/textured.glb), the
 *   non-manifold, many-piece soup the decimator must reach low counts on, with a raw scan's settings (normalWeight
 *   0.12, normalSmoothing 1): a quarter and a tenth of its triangles are reached, the input surface stays within 4e-4
 *   and 1.2e-3 of the tile's diagonal RMS (the 2026-11-04 ESB tile, 567 m: 14 cm and 41 cm, where the decimator used
 *   to stall at 35% with 86 cm), pieces left as one or two triangles stay under 0.5% of the result, and the result
 *   stays on the input (99th percentile from the result back under 1.5 m).
 * - Rule check (synthetic on purpose, so it runs without real data): a soup of 121 unwelded pieces on a bumped torus,
 *   each with a flap (an edge with three faces) and every fifth drawn twice (four faces on every edge, faces drawn
 *   twice), reaches a tenth with all 121 pieces, no floaters and every input vertex within 0.75 m of the result (0.61 m;
 *   before: stalled at 26%, 26 pieces left, 3.2 m away).
 * - Formula unit test (synthetic on purpose): optimizeVertexCache takes a shuffled grid's ACMR from about 3 to under
 *   0.8 and optimizeVertexFetch keeps every used vertex.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { NativeCppCompilerService } from '../src/node/3d-engine/native-compiler-service';
import { withReason, type Requirement } from './helpers/requirements';

function realFile(env: string, what: string): { path?: string; req: Requirement } {
    const p = process.env[env];
    if (p && fs.existsSync(p)) return { path: p, req: { ok: true, reason: '' } };
    return { req: { ok: false, reason: `set ${env} to ${what} (gitignored real data from a staged-location run)` } };
}
const twin = realFile('SCRATCHBOX_DECIMATE_REAL_GLB', 'a cached Pipeline K twin.glb');
const tile = realFile('SCRATCHBOX_DECIMATE_REAL_TILE', 'a raw 3D Tiles extraction (tiles/<key>/textured.glb)');

let dir: string;
const savedCache = process.env.SCRATCHBOX_NATIVE_BUILD_CACHE;
beforeAll(() => {
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'native-decimate-seams-')));
    process.env.SCRATCHBOX_NATIVE_BUILD_CACHE = path.join(dir, 'cache');
});
afterAll(() => {
    if (savedCache === undefined) delete process.env.SCRATCHBOX_NATIVE_BUILD_CACHE;
    else process.env.SCRATCHBOX_NATIVE_BUILD_CACHE = savedCache;
    fs.rmSync(dir, { recursive: true, force: true });
});

const COMMON = String.raw`
#include "scratchbox_engine.hpp"
#include <cstdio>
#include <random>
#include <unordered_map>
namespace sb = scratchbox;
using sb::geometry::ScratchboxMesh; using sb::math::Vec3;
`;

const MEASURE = String.raw`
static double ptTri2(Vec3 p, Vec3 a, Vec3 b, Vec3 c) {
    Vec3 ab = b - a, ac = c - a, ap = p - a;
    double d1 = ab.dot(ap), d2 = ac.dot(ap); if (d1 <= 0 && d2 <= 0) return ap.dot(ap);
    Vec3 bp = p - b; double d3 = ab.dot(bp), d4 = ac.dot(bp); if (d3 >= 0 && d4 <= d3) return bp.dot(bp);
    double vc = d1 * d4 - d3 * d2; if (vc <= 0 && d1 >= 0 && d3 <= 0) { Vec3 q = p - (a + ab * float(d1 / (d1 - d3))); return q.dot(q); }
    Vec3 cp = p - c; double d5 = ab.dot(cp), d6 = ac.dot(cp); if (d6 >= 0 && d5 <= d6) return cp.dot(cp);
    double vb = d5 * d2 - d1 * d6; if (vb <= 0 && d2 >= 0 && d6 <= 0) { Vec3 q = p - (a + ac * float(d2 / (d2 - d6))); return q.dot(q); }
    double va = d3 * d6 - d5 * d4; if (va <= 0 && (d4 - d3) >= 0 && (d5 - d6) >= 0) { Vec3 q = p - (b + (c - b) * float((d4 - d3) / ((d4 - d3) + (d5 - d6)))); return q.dot(q); }
    double den = 1.0 / (va + vb + vc); Vec3 q = p - (a + ab * float(vb * den) + ac * float(vc * den)); return q.dot(q);
}
struct Grid {
    const ScratchboxMesh* m{}; Vec3 lo; float cell{1}; int nx{1}, ny{1}, nz{1};
    std::vector<uint32_t> start, items;
    size_t id(int x, int y, int z) const { return (size_t(z) * ny + y) * nx + x; }
    static int cl(int v, int n) { return std::clamp(v, 0, n - 1); }
    void cellOf(const Vec3& p, int& x, int& y, int& z) const { x = cl(int((p.x - lo.x) / cell), nx); y = cl(int((p.y - lo.y) / cell), ny); z = cl(int((p.z - lo.z) / cell), nz); }
    void build(const ScratchboxMesh& mesh) {
        m = &mesh; Vec3 hi = mesh.vertices[0].position; lo = hi;
        for (auto& v : mesh.vertices) { lo = Vec3(std::min(lo.x, v.position.x), std::min(lo.y, v.position.y), std::min(lo.z, v.position.z)); hi = Vec3(std::max(hi.x, v.position.x), std::max(hi.y, v.position.y), std::max(hi.z, v.position.z)); }
        Vec3 e = hi - lo; const size_t nt = mesh.indices.size() / 3;
        cell = std::max(std::cbrt(std::max(1e-6f, e.x) * std::max(1e-6f, e.y) * std::max(1e-6f, e.z) / float(std::max<size_t>(1, nt / 2))), std::max({e.x, e.y, e.z}) / 400.f);
        nx = int(e.x / cell) + 1; ny = int(e.y / cell) + 1; nz = int(e.z / cell) + 1;
        std::vector<std::vector<uint32_t>> cells(size_t(nx) * ny * nz);
        for (size_t t = 0; t < nt; ++t) {
            int a[3], b[3]; Vec3 mn = mesh.vertices[mesh.indices[t * 3]].position, mx = mn;
            for (int k = 1; k < 3; ++k) { const Vec3& p = mesh.vertices[mesh.indices[t * 3 + k]].position; mn = Vec3(std::min(mn.x, p.x), std::min(mn.y, p.y), std::min(mn.z, p.z)); mx = Vec3(std::max(mx.x, p.x), std::max(mx.y, p.y), std::max(mx.z, p.z)); }
            cellOf(mn, a[0], a[1], a[2]); cellOf(mx, b[0], b[1], b[2]);
            for (int z = a[2]; z <= b[2]; ++z) for (int y = a[1]; y <= b[1]; ++y) for (int x = a[0]; x <= b[0]; ++x) cells[id(x, y, z)].push_back(uint32_t(t));
        }
        start.assign(cells.size() + 1, 0);
        for (size_t c = 0; c < cells.size(); ++c) { start[c + 1] = start[c] + uint32_t(cells[c].size()); items.insert(items.end(), cells[c].begin(), cells[c].end()); }
    }
    double nearest(const Vec3& p) const {
        int cx, cy, cz; cellOf(p, cx, cy, cz); double best = 1e30;
        for (int R = 0; R <= std::max({nx, ny, nz}); ++R) {
            for (int z = cz - R; z <= cz + R; ++z) for (int y = cy - R; y <= cy + R; ++y) for (int x = cx - R; x <= cx + R; ++x) {
                if (std::max({std::abs(x - cx), std::abs(y - cy), std::abs(z - cz)}) != R || x < 0 || y < 0 || z < 0 || x >= nx || y >= ny || z >= nz) continue;
                for (uint32_t k = start[id(x, y, z)]; k < start[id(x, y, z) + 1]; ++k) {
                    const uint32_t t = items[k];
                    best = std::min(best, ptTri2(p, m->vertices[m->indices[t * 3]].position, m->vertices[m->indices[t * 3 + 1]].position, m->vertices[m->indices[t * 3 + 2]].position));
                }
            }
            if (best < 1e29 && std::sqrt(best) <= R * cell) break;
        }
        return std::sqrt(best);
    }
};
static std::vector<Vec3> samples(const ScratchboxMesh& m, size_t n) {
    std::vector<double> cdf; double acc = 0;
    for (size_t t = 0; t + 2 < m.indices.size(); t += 3) { acc += 0.5 * (m.vertices[m.indices[t + 1]].position - m.vertices[m.indices[t]].position).cross(m.vertices[m.indices[t + 2]].position - m.vertices[m.indices[t]].position).length(); cdf.push_back(acc); }
    std::mt19937_64 rng(1); std::uniform_real_distribution<double> U(0, 1); std::vector<Vec3> out;
    for (size_t i = 0; i < n; ++i) {
        size_t t = std::min(size_t(std::lower_bound(cdf.begin(), cdf.end(), U(rng) * acc) - cdf.begin()), cdf.size() - 1);
        double r1 = std::sqrt(U(rng)), r2 = U(rng);
        out.push_back(m.vertices[m.indices[t * 3]].position * float(1 - r1) + m.vertices[m.indices[t * 3 + 1]].position * float(r1 * (1 - r2)) + m.vertices[m.indices[t * 3 + 2]].position * float(r1 * r2));
    }
    return out;
}
static double rms(const std::vector<Vec3>& s, const ScratchboxMesh& out) {
    Grid g; g.build(out); double s2 = 0; for (auto& p : s) { double d = g.nearest(p); s2 += d * d; } return std::sqrt(s2 / s.size());
}
static size_t openEdges(const ScratchboxMesh& m) {
    std::unordered_map<uint64_t, uint32_t> id; std::vector<uint32_t> w(m.vertices.size());
    auto q = [](float v) { return uint64_t(int64_t(std::llround(double(v) * 1e4)) & 0x1FFFFF); };
    for (size_t i = 0; i < m.vertices.size(); ++i) { auto& p = m.vertices[i].position; w[i] = id.emplace(q(p.x) | (q(p.y) << 21) | (q(p.z) << 42), uint32_t(id.size())).first->second; }
    std::unordered_map<uint64_t, int> e;
    for (size_t t = 0; t + 2 < m.indices.size(); t += 3) for (int k = 0; k < 3; ++k) { uint32_t a = w[m.indices[t + k]], b = w[m.indices[t + (k + 1) % 3]]; if (a != b) e[(uint64_t(std::min(a, b)) << 32) | std::max(a, b)]++; }
    size_t n = 0; for (auto& kv : e) if (kv.second == 1) ++n; return n;
}
// connected pieces of the position-welded (0.1 mm) surface, and those of at most two triangles (floaters)
static std::pair<size_t, size_t> pieces(const ScratchboxMesh& m) {
    std::unordered_map<uint64_t, uint32_t> id; std::vector<uint32_t> w(m.vertices.size());
    auto q = [](float v) { return uint64_t(int64_t(std::llround(double(v) * 1e4)) & 0x1FFFFF); };
    for (size_t i = 0; i < m.vertices.size(); ++i) { auto& p = m.vertices[i].position; w[i] = id.emplace(q(p.x) | (q(p.y) << 21) | (q(p.z) << 42), uint32_t(id.size())).first->second; }
    std::vector<uint32_t> parent(id.size()); for (uint32_t i = 0; i < parent.size(); ++i) parent[i] = i;
    auto find = [&](uint32_t x) { while (parent[x] != x) x = parent[x] = parent[parent[x]]; return x; };
    for (size_t t = 0; t + 2 < m.indices.size(); t += 3) for (int k = 1; k < 3; ++k) parent[find(w[m.indices[t + k]])] = find(w[m.indices[t]]);
    std::unordered_map<uint32_t, size_t> tris; for (size_t t = 0; t + 2 < m.indices.size(); t += 3) tris[find(w[m.indices[t]])]++;
    size_t floaters = 0; for (auto& kv : tris) if (kv.second <= 2) ++floaters;
    return { tris.size(), floaters };
}
static ScratchboxMesh cleanTriangles(ScratchboxMesh in) {
    std::vector<uint32_t> keep;
    for (size_t t = 0; t + 2 < in.indices.size(); t += 3) { uint32_t a = in.indices[t], b = in.indices[t + 1], c = in.indices[t + 2]; if (a != b && b != c && a != c) keep.insert(keep.end(), {a, b, c}); }
    in.indices = keep; sb::processing::optimizeVertexFetch(in); return in;
}
`;

const REAL_PROGRAM = COMMON + MEASURE + String.raw`
int main(int, char** argv) {
    ScratchboxMesh in = sb::io::GlbReader::readGlb(argv[1]);
    in = cleanTriangles(in);
    const auto s = samples(in, 100000);
    auto pyr = sb::lod::buildLodPyramid(in);
    std::printf("{\"in\":%zu,\"inOpen\":%zu,\"lod\":[", in.indices.size() / 3, openEdges(in));
    for (size_t i = 1; i < pyr.size(); ++i) { const auto& m = pyr.levels[i].mesh;
        std::printf("%s{\"tris\":%zu,\"open\":%zu,\"rms\":%.5f,\"acmr\":%.4f,\"ratio\":%.5f}", i > 1 ? "," : "", m.indices.size() / 3, openEdges(m), rms(s, m), sb::processing::vertexCacheMissRatio(m.indices, m.vertices.size()), pyr.levels[i].triangleRatio); }
    sb::nanite::NaniteClusterDAG dag; dag.buildFromMesh(in, 128);
    ScratchboxMesh roots;
    for (uint32_t id : dag.rootClusterIds) {
        const uint32_t base = uint32_t(roots.vertices.size());
        for (const auto& v : dag.clusters[id].vertices) roots.addVertex(v);
        for (size_t k = 0; k + 2 < dag.clusters[id].indices.size(); k += 3) roots.addTriangle(base + dag.clusters[id].indices[k], base + dag.clusters[id].indices[k + 1], base + dag.clusters[id].indices[k + 2]);
    }
    Vec3 lo = in.vertices[0].position, hi = lo;
    for (auto& v : in.vertices) { lo = Vec3(std::min(lo.x, v.position.x), std::min(lo.y, v.position.y), std::min(lo.z, v.position.z)); hi = Vec3(std::max(hi.x, v.position.x), std::max(hi.y, v.position.y), std::max(hi.z, v.position.z)); }
    std::printf("],\"naniteRootTris\":%zu,\"naniteRootRms\":%.5f,\"diag\":%.3f}\n", roots.indices.size() / 3, rms(s, roots), (hi - lo).length());
    std::vector<ScratchboxMesh> lods = { pyr.levels[0].mesh, pyr.levels[1].mesh };
    auto glb = sb::io::GlbWriter::serializeLodGlb(lods);
    FILE* f = std::fopen(argv[2], "wb"); std::fwrite(glb.data(), 1, glb.size(), f); std::fclose(f);
    return 0;
}
`;

// a raw 3D Tiles soup to a quarter and a tenth: how close each stays to the input, both ways, and what pieces it keeps
const TILE_PROGRAM = COMMON + MEASURE + String.raw`
static double p99Back(const ScratchboxMesh& out, const ScratchboxMesh& in) {
    Grid g; g.build(in); auto s = samples(out, 50000); std::vector<double> d; for (auto& p : s) d.push_back(g.nearest(p));
    std::nth_element(d.begin(), d.begin() + d.size() * 99 / 100, d.end()); return d[d.size() * 99 / 100];
}
int main(int, char** argv) {
    ScratchboxMesh in = cleanTriangles(sb::io::GlbReader::readGlb(argv[1]));
    Vec3 lo = in.vertices[0].position, hi = lo;
    for (auto& v : in.vertices) { lo = Vec3(std::min(lo.x, v.position.x), std::min(lo.y, v.position.y), std::min(lo.z, v.position.z)); hi = Vec3(std::max(hi.x, v.position.x), std::max(hi.y, v.position.y), std::max(hi.z, v.position.z)); }
    const auto s = samples(in, 100000);
    const auto [inPieces, inFloaters] = pieces(in);
    std::printf("{\"in\":%zu,\"diag\":%.3f,\"inPieces\":%zu,\"inFloaters\":%zu,\"runs\":[", in.indices.size() / 3, (hi - lo).length(), inPieces, inFloaters);
    const double shares[2] = { 0.25, 0.1 };
    for (int i = 0; i < 2; ++i) {
        // a raw soup's own normals are noise: the normal field on smoothed normals, at a raw scan's strength
        sb::processing::DecimateOptions o; o.targetTriangles = size_t(in.indices.size() / 3 * shares[i]);
        o.normalWeight = 0.12f; o.normalSmoothing = 1.0f;
        ScratchboxMesh out = sb::processing::QuadricDecimator::decimate(in, o);
        const auto [p, fl] = pieces(out);
        std::printf("%s{\"target\":%zu,\"tris\":%zu,\"rms\":%.5f,\"p99Back\":%.5f,\"pieces\":%zu,\"floaters\":%zu}", i ? "," : "",
            o.targetTriangles, out.indices.size() / 3, rms(s, out), p99Back(out, in), p, fl);
    }
    std::printf("]}\n");
    return 0;
}
`;

// The rule check: a soup on a bumped torus (R=10 m, r=3 m, 0.25 m bump) in 8 x 8-quad pieces, each its own UV chart and
// its own vertices, lifted 0 to 5 mm off the surface by its index so neighbours meet without welding; a flap (a third
// face standing 0.1 m off an edge) in every piece; every fifth piece drawn twice.
const SOUP_PROGRAM = COMMON + MEASURE + String.raw`
static ScratchboxMesh scanSoup(int nu, int nv) {
    using sb::geometry::Vertex; using sb::math::Vec2;
    ScratchboxMesh m("soup");
    auto pos = [&](int i, int j, float lift) {
        double u = 2 * M_PI * (i % nu) / nu, v = 2 * M_PI * (j % nv) / nv;
        double rr = 3.0 + 0.25 * std::sin(5 * u) * std::sin(7 * v) + lift;
        Vec3 n(float(std::cos(u) * std::cos(v)), float(std::sin(v)), float(std::sin(u) * std::cos(v)));
        return std::make_pair(Vec3(float(10 * std::cos(u)), 0.f, float(10 * std::sin(u))) + n * float(rr), n);
    };
    const int C = 8;
    int piece = 0;
    for (int ci = 0; ci < nu; ci += C) for (int cj = 0; cj < nv; cj += C, ++piece) {
        const float lift = 0.0005f * float(piece % 11);
        const Vec2 origin(float((ci / C) % 16) / 16.f, float((cj / C) % 8) / 8.f);
        for (int copy = 0; copy < (piece % 5 == 0 ? 2 : 1); ++copy) {
            const uint32_t base = uint32_t(m.vertices.size());
            for (int a = 0; a <= C; ++a) for (int b = 0; b <= C; ++b) {
                auto [p, n] = pos(ci + a, cj + b, lift);
                m.addVertex(Vertex(p, n, Vec2(origin.x + a / 160.f, origin.y + b / 80.f)));
            }
            for (int a = 0; a < C; ++a) for (int b = 0; b < C; ++b) {
                uint32_t p00 = base + a * (C + 1) + b, p10 = p00 + (C + 1);
                m.addTriangle(p00, p00 + 1, p10); m.addTriangle(p10, p00 + 1, p10 + 1);
            }
            if (copy == 0) {
                const uint32_t p00 = base + 3 * (C + 1) + 4, p01 = p00 + 1;
                const Vertex& A = m.vertices[p00];
                const Vertex& B = m.vertices[p01];
                Vertex tip((A.position + B.position) * 0.5f + A.normal * 0.1f, A.normal, A.uv);
                m.addVertex(tip);
                m.addTriangle(p00, p01, uint32_t(m.vertices.size() - 1));
            }
        }
    }
    return m;
}
// edges of the position-welded (0.1 mm) surface with more than two faces
static size_t nonManifoldEdges(const ScratchboxMesh& m) {
    std::unordered_map<uint64_t, uint32_t> id; std::vector<uint32_t> w(m.vertices.size());
    auto q = [](float v) { return uint64_t(int64_t(std::llround(double(v) * 1e4)) & 0x1FFFFF); };
    for (size_t i = 0; i < m.vertices.size(); ++i) { auto& p = m.vertices[i].position; w[i] = id.emplace(q(p.x) | (q(p.y) << 21) | (q(p.z) << 42), uint32_t(id.size())).first->second; }
    std::unordered_map<uint64_t, int> e;
    for (size_t t = 0; t + 2 < m.indices.size(); t += 3) for (int k = 0; k < 3; ++k) { uint32_t a = w[m.indices[t + k]], b = w[m.indices[t + (k + 1) % 3]]; if (a != b) e[(uint64_t(std::min(a, b)) << 32) | std::max(a, b)]++; }
    size_t n = 0; for (auto& kv : e) if (kv.second > 2) ++n; return n;
}
static double worstTo(const ScratchboxMesh& from, const ScratchboxMesh& to) {
    Grid g; g.build(to); double worst = 0; for (auto& v : from.vertices) worst = std::max(worst, g.nearest(v.position)); return worst;
}
int main() {
    ScratchboxMesh in = scanSoup(128, 64);
    const auto [inPieces, inFloaters] = pieces(in);
    sb::processing::DecimateOptions o; o.targetTriangles = in.indices.size() / 3 / 10;
    ScratchboxMesh out = sb::processing::QuadricDecimator::decimate(in, o);
    const auto [p, fl] = pieces(out);
    std::printf("{\"in\":%zu,\"inOpen\":%zu,\"inNonManifold\":%zu,\"inPieces\":%zu,\"inFloaters\":%zu,\"target\":%zu,\"tris\":%zu,\"pieces\":%zu,\"floaters\":%zu,\"inToOut\":%.5f,\"outToIn\":%.5f}\n",
        in.indices.size() / 3, openEdges(in), nonManifoldEdges(in), inPieces, inFloaters, o.targetTriangles, out.indices.size() / 3, p, fl, worstTo(in, out), worstTo(out, in));
    return 0;
}
`;

const FORMULA_PROGRAM = COMMON + String.raw`
int main() {
    // a regular grid, triangles shuffled: the cache ordering's formula check (synthetic on purpose)
    ScratchboxMesh m; const int N = 96;
    for (int i = 0; i <= N; ++i) for (int j = 0; j <= N; ++j) m.addVertex(sb::geometry::Vertex(Vec3(float(i), 0.f, float(j))));
    std::vector<std::array<uint32_t, 3>> tris;
    for (int i = 0; i < N; ++i) for (int j = 0; j < N; ++j) { uint32_t a = i * (N + 1) + j, b = a + N + 1; tris.push_back({a, a + 1, b}); tris.push_back({b, a + 1, b + 1}); }
    std::mt19937 rng(7); std::shuffle(tris.begin(), tris.end(), rng);
    for (auto& t : tris) m.addTriangle(t[0], t[1], t[2]);
    const double before = sb::processing::vertexCacheMissRatio(m.indices, m.vertices.size());
    sb::processing::optimizeVertexCache(m.indices, m.vertices.size());
    const double after = sb::processing::vertexCacheMissRatio(m.indices, m.vertices.size());
    const size_t verts = m.vertices.size();
    sb::processing::optimizeVertexFetch(m);
    std::printf("{\"before\":%.4f,\"after\":%.4f,\"verts\":%zu,\"vertsAfter\":%zu,\"tris\":%zu}\n", before, after, verts, m.vertices.size(), m.indices.size() / 3);
    return 0;
}
`;

// Real buildings take longer than executeBinary's 60 s limit for generated programs (the 768k-triangle ESB twin: about
// 100 s), so the program runs here, with no environment but PATH and a 15 minute limit.
async function runProgram(source: string, name: string, args: string[] = []): Promise<any> {
    const compiler = new NativeCppCompilerService();
    const outDir = path.join(dir, name);
    const res = await compiler.compileSource(source, { outputDir: outDir, outputBinaryName: name });
    expect(res.compilerOutput).not.toMatch(/error:/);
    expect(res.success).toBe(true);
    const { stdout } = await promisify(execFile)(res.binaryPath!, args, {
        cwd: outDir, env: { PATH: process.env.PATH ?? '' }, timeout: 15 * 60 * 1000, maxBuffer: 16 * 1024 * 1024,
    });
    return JSON.parse(stdout.trim().split('\n').pop()!);
}

describe('QEM decimation', () => {
    it.skipIf(!twin.req.ok)(withReason('LOD pyramid and Nanite DAG of a real Pipeline K building', twin.req), async () => {
        const glbPath = path.join(dir, 'lod.glb');
        const m = await runProgram(REAL_PROGRAM, 'decimate_real', [twin.path!, glbPath]);
        const asked = [0.5, 0.25, 0.125];
        m.lod.forEach((l: { tris: number; open: number; rms: number; acmr: number; ratio: number }, i: number) => {
            expect(l.tris).toBeLessThanOrEqual(Math.floor(m.in * asked[i]) + 1);
            expect(l.tris).toBeGreaterThan(m.in * asked[i] * 0.9);
            expect(l.ratio).toBeCloseTo(l.tris / m.in, 4);
            expect(l.open).toBeLessThan(m.inOpen);
            expect(l.acmr).toBeLessThan(1.8);
        });
        expect(m.lod[0].rms).toBeLessThan(0.05);
        expect(m.lod[2].rms).toBeLessThan(1.5);
        // the root is one cluster of about 128 triangles whenever every merge reaches its half; it must still be the
        // building: within 8% of the diagonal RMS (Faneuil 3.9%, NYPL 5.8%; the old halfedge QEM's ~125-triangle roots
        // sat at 10%)
        expect(m.naniteRootTris).toBeGreaterThan(64);
        expect(m.naniteRootRms).toBeLessThan(0.08 * m.diag);
        const glb = fs.readFileSync(glbPath);
        expect(glb.subarray(0, 4).toString('latin1')).toBe('glTF');
        expect(glb.readUInt32LE(8)).toBe(glb.length);
    });

    it.skipIf(!tile.req.ok)(withReason('a raw 3D Tiles soup to a quarter and a tenth', tile.req), async () => {
        const m = await runProgram(TILE_PROGRAM, 'decimate_tile', [tile.path!]);
        const bound = [4e-4, 1.2e-3];
        m.runs.forEach((r: { target: number; tris: number; rms: number; p99Back: number; pieces: number; floaters: number }, i: number) => {
            expect(r.tris).toBeLessThanOrEqual(r.target);
            expect(r.tris).toBeGreaterThan(r.target * 0.95);
            expect(r.rms).toBeLessThan(bound[i] * m.diag);
            expect(r.p99Back).toBeLessThan(1.5);
            expect(r.floaters).toBeLessThan(r.tris * 0.005);
        });
    });

    it('reaches a tenth on a non-manifold soup of many pieces (rule check)', async () => {
        const m = await runProgram(SOUP_PROGRAM, 'decimate_soup');
        expect(m.inPieces).toBe(121);
        expect(m.inOpen).toBeGreaterThan(1000);
        expect(m.inNonManifold).toBeGreaterThan(1000);
        expect(m.tris).toBeLessThanOrEqual(m.target);
        expect(m.tris).toBeGreaterThan(m.target * 0.95);
        expect(m.pieces).toBe(m.inPieces);
        expect(m.floaters).toBe(0);
        expect(m.inToOut).toBeLessThan(0.75);
        expect(m.outToIn).toBeLessThan(0.25);
    });

    it('orders triangles for the vertex cache and vertices for fetch (formula check)', async () => {
        const m = await runProgram(FORMULA_PROGRAM, 'vertex_cache');
        expect(m.tris).toBe(96 * 96 * 2);
        expect(m.before).toBeGreaterThan(2);
        expect(m.after).toBeLessThan(0.8);
        expect(m.vertsAfter).toBe(m.verts);
    });
});
